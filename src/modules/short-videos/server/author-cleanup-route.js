import { sendShortVideoPublicError } from "./public-errors.js";

const CLEANUP_ROUTE = /^\/api\/short-videos\/authors\/([^/]+)\/cleanup$/;

export async function routeShortVideoAuthorCleanup(options) {
  const { req, res, url, store, readJsonBody, requireLocalAdmin, sendJson, downloadManagerRequest, onMutation } = options;
  const match = CLEANUP_ROUTE.exec(url.pathname);
  if (!match || !["GET", "POST"].includes(req.method)) return false;
  if (req.method === "POST" && !requireLocalAdmin(req, res)) return true;
  try {
    const secUid = decodeURIComponent(match[1]);
    const preview = store.authorCleanupPreview(secUid);
    const manager = await managerProfiles(downloadManagerRequest, secUid);
    if (req.method === "GET") {
      sendJson(res, 200, { ok: true, preview, manager: publicManagerState(manager) });
      return true;
    }
    if (!manager.available) throw publicError("8765 采集服务不可用，已取消清理", 503, "SHORT_VIDEO_AUTHOR_CLEANUP_MANAGER_UNAVAILABLE");
    const body = await readJsonBody(req);
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
    sendShortVideoPublicError(res, sendJson, error, "作者清理失败", { includeDetails: true });
  }
  return true;
}

function cancelAuthorFollow(store, secUid) {
  try {
    return { ok: true, data: store.setAuthorFollowByUser(secUid, { active: false }), error: "" };
  } catch (error) {
    return { ok: false, data: null, error: String(error?.message || "取消关注失败") };
  }
}

async function managerProfiles(request, secUid) {
  try {
    const params = new URLSearchParams({ scope: "all", q: secUid, limit: "100" });
    const payload = await request(`/api/profiles?${params}`);
    const profiles = (Array.isArray(payload?.profiles) ? payload.profiles : [])
      .filter((profile) => String(profile?.sec_uid || "").trim() === secUid && String(profile?.tab || "post") === "post");
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
