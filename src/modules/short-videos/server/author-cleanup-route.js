import { sendShortVideoPublicError } from "./public-errors.js";

const CLEANUP_ROUTE = /^\/api\/short-videos\/authors\/([^/]+)\/(cleanup|delete)$/;

export async function routeShortVideoAuthorCleanup(options) {
  const { req, res, url, store, readJsonBody, requireLocalAdmin, sendJson, downloadManagerRequest, onMutation } = options;
  const match = CLEANUP_ROUTE.exec(url.pathname);
  if (!match || !["GET", "POST"].includes(req.method)) return false;
  const deleteAll = match[2] === "delete";
  if (req.method === "POST" && !requireLocalAdmin(req, res)) return true;
  try {
    const secUid = decodeURIComponent(match[1]);
    const preview = deleteAll ? store.authorDeletePreview(secUid) : store.authorCleanupPreview(secUid);
    const manager = await managerProfiles(downloadManagerRequest, secUid, { allTabs: deleteAll });
    if (req.method === "GET") {
      sendJson(res, 200, { ok: true, mode: deleteAll ? "delete" : "cleanup", preview, manager: publicManagerState(manager) });
      return true;
    }
    if (!manager.available) throw publicError(
      deleteAll ? "8765 采集服务不可用，已取消删除" : "8765 采集服务不可用，已取消清理",
      503,
      deleteAll ? "SHORT_VIDEO_AUTHOR_DELETE_MANAGER_UNAVAILABLE" : "SHORT_VIDEO_AUTHOR_CLEANUP_MANAGER_UNAVAILABLE"
    );
    const body = await readJsonBody(req);
    if (deleteAll) {
      await deleteAuthor({ body, downloadManagerRequest, manager, onMutation, res, secUid, sendJson, store });
      return true;
    }
    const cleanup = await store.cleanupAuthorUnliked(secUid, {
      deleteCount: body?.deleteCount,
      likedCount: body?.likedCount,
      operationId: String(body?.operationId || "").trim()
    });
    const deletion = cleanup.deletion;
    if (deletion && deletion.logicalDeleteCommitted !== true) {
      sendJson(res, deletionHttpStatus(deletion), { ...deletion, authorCleanup: cleanupSummary(cleanup, manager, false) });
      return true;
    }
    onMutation?.();
    const follow = cancelAuthorFollow(store, secUid);
    const removal = await removeManagerProfiles(downloadManagerRequest, manager.profiles);
    const authorCleanup = {
      ...cleanupSummary(cleanup, manager, removal.failed.length === 0),
      followRemoved: follow.ok,
      follow: follow.data,
      followError: follow.error,
      removal
    };
    if (!deletion) {
      sendJson(res, 200, { ok: true, accepted: true, pending: false, status: "monitoring_removed", authorCleanup });
      return true;
    }
    sendJson(res, deletionHttpStatus(deletion), { ...deletion, authorCleanup });
  } catch (error) {
    sendShortVideoPublicError(res, sendJson, error, deleteAll ? "作者删除失败" : "作者清理失败", { includeDetails: true });
  }
  return true;
}

async function deleteAuthor(options) {
  const { body, downloadManagerRequest, manager, onMutation, res, secUid, sendJson, store } = options;
  const authorDelete = await store.deleteAuthorAllWorks(secUid, {
    totalCount: body?.totalCount,
    operationId: String(body?.operationId || "").trim()
  });
  const deletion = authorDelete.deletion;
  if (deletion && (deletion.logicalDeleteCommitted !== true || deletion.physicalCleanupComplete !== true)) {
    sendJson(res, deletionHttpStatus(deletion), {
      ...deletion,
      authorDelete: deleteSummary(authorDelete, manager, false)
    });
    return;
  }
  const removal = await removeManagerProfiles(downloadManagerRequest, manager.profiles);
  if (removal.failed.length) {
    sendJson(res, 502, {
      ok: false,
      accepted: false,
      pending: false,
      status: "manager_cleanup_failed",
      message: removal.failed[0].message || "8765 作者记录删除失败，请重试",
      authorDelete: { ...deleteSummary(authorDelete, manager, false), removal }
    });
    return;
  }
  const record = store.deleteAuthorRecord(secUid);
  onMutation?.();
  const summary = { ...deleteSummary(authorDelete, manager, true), removal, record };
  if (!deletion) {
    sendJson(res, 200, {
      ok: true,
      accepted: true,
      pending: false,
      status: "author_deleted",
      authorDelete: summary
    });
    return;
  }
  sendJson(res, 200, { ...deletion, authorDelete: summary });
}

function cancelAuthorFollow(store, secUid) {
  try {
    return { ok: true, data: store.setAuthorFollowByUser(secUid, { active: false }), error: "" };
  } catch (error) {
    return { ok: false, data: null, error: String(error?.message || "取消关注失败") };
  }
}

async function managerProfiles(request, secUid, options = {}) {
  try {
    const params = new URLSearchParams({ scope: "all", q: secUid, limit: "100" });
    const payload = await request(`/api/profiles?${params}`);
    const profiles = (Array.isArray(payload?.profiles) ? payload.profiles : [])
      .filter((profile) => String(profile?.sec_uid || "").trim() === secUid
        && (options.allTabs || String(profile?.tab || "post") === "post"));
    return { available: true, profiles };
  } catch (error) {
    return { available: false, profiles: [], error: String(error?.message || "8765 采集服务不可用") };
  }
}

function publicManagerState(manager) {
  return {
    available: manager.available,
    monitored: manager.profiles.length > 0,
    profileCount: manager.profiles.length,
    error: manager.error || ""
  };
}

async function removeManagerProfiles(request, profiles) {
  const removed = [];
  const failed = [];
  for (const profile of profiles) {
    try {
      const result = await request("/api/profiles/delete", { method: "POST", body: { profile_id: Number(profile.id || 0) } });
      if (result?.ok === false) throw new Error(result.message || "采集记录删除失败");
      removed.push(Number(profile.id || 0));
    } catch (error) {
      failed.push({ profileId: Number(profile.id || 0), message: String(error?.message || error) });
    }
  }
  return { removed, failed };
}

function cleanupSummary(cleanup, manager, monitoringRemoved) {
  return {
    preview: cleanup.preview,
    monitoringRemoved,
    managerProfiles: manager.profiles.map((profile) => Number(profile.id || 0))
  };
}

function deleteSummary(authorDelete, manager, recordsRemoved) {
  return {
    preview: authorDelete.preview,
    folderCleanup: authorDelete.folderCleanup,
    recordsRemoved,
    managerProfiles: manager.profiles.map((profile) => Number(profile.id || 0))
  };
}

function deletionHttpStatus(result) {
  if (result?.status === "cleanup_pending") return 202;
  if (result?.status === "rollback_pending") return 500;
  return 200;
}

function publicError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.expose = true;
  return error;
}
