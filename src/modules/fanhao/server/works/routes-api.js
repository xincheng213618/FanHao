import { safeWorkMoveRetryError, sanitizeWorkMoveJob } from "./work-move-job-query-service.js";

function safeWorkMoveRouteError(error, fallback, { retry = false } = {}) {
  return {
    error: retry ? safeWorkMoveRetryError(error) : fallback,
    ...(error?.code ? { code: error.code } : {}),
    ...(error?.retryable ? { retryable: true } : {}),
    ...(error?.job ? { job: sanitizeWorkMoveJob(error.job) } : {})
  };
}

function publicWorkMoveJobPayload(payload) {
  return {
    ok: payload?.ok === true,
    job: sanitizeWorkMoveJob(payload?.job)
  };
}

function androidWorkMoveBody(req, body) {
  const client = String(req?.headers?.["x-fanhao-client"] || "").trim().toLowerCase();
  if (client !== "android") return body;
  const forbidden = ["targetDirectory", "targetPath", "rootPath", "root", "createPerson"].find((key) => Object.hasOwn(body || {}, key));
  if (forbidden) {
    const error = new Error("Android 迁移只允许选择服务器确认的人物");
    error.statusCode = 400;
    error.code = "WORK_MOVE_ANDROID_TARGET_FORBIDDEN";
    throw error;
  }
  return {
    personId: String(body?.personId || "").trim(),
    idempotencyKey: String(body?.idempotencyKey || "").trim().slice(0, 180)
  };
}

function isAndroidWorkMoveRequest(req) {
  return String(req?.headers?.["x-fanhao-client"] || "").trim().toLowerCase() === "android";
}

const ACTOR_PROFILE_PUBLIC_ERROR_MESSAGES = Object.freeze({
  ACTOR_PROFILE_BLOCKED: "人物资料任务已被阻断，请修复原因后手动重试",
  ACTOR_PROFILE_CANCELLED: "人物资料任务已取消",
  ACTOR_PROFILE_PENDING: "人物资料任务仍在恢复中，请使用同一请求键重试",
  ACTOR_PROFILE_RESERVED: "人物头像或 JavDB 身份正在更新，请稍后重试",
  ACTOR_PROFILE_RESERVATION_LOST: "人物资料任务状态需要人工检查，暂时无法重试",
  ACTOR_PROFILE_RETRY_NOT_BLOCKED: "只有已阻断的人物资料任务可以重试",
  CROSS_STORE_FAILURE_RECORD_BUSY: "人物资料任务已经持久化，请使用同一请求键重试",
  CROSS_STORE_NOT_READY: "人物资料恢复队列尚未就绪",
  IDEMPOTENCY_CONFLICT: "幂等键已经用于不同的人物资料请求",
  INVALID_JAVDB_ACTOR_URL: "请输入有效的 JavDB actor 页面链接"
});

export function sanitizeActorProfileOperation(operation) {
  if (!operation?.id) return null;
  const status = ["prepared", "applying", "retry_wait", "completed", "blocked", "cancelled"].includes(String(operation.status || ""))
    ? String(operation.status)
    : "retry_wait";
  const sequence = Number(operation.sequence || 0);
  const attempts = Number(operation.attempts || 0);
  return {
    id: String(operation.id),
    kind: operation.kind === "actor_profile_upsert" ? operation.kind : "actor_profile_upsert",
    sequence: Number.isFinite(sequence) ? sequence : 0,
    status,
    attempts: Number.isFinite(attempts) ? attempts : 0,
    createdAt: String(operation.createdAt || ""),
    updatedAt: String(operation.updatedAt || ""),
    completedAt: operation.completedAt ? String(operation.completedAt) : null,
    recoverable: !["completed", "cancelled"].includes(status),
    requiresManualRetry: status === "blocked"
  };
}

export function actorProfileRouteErrorStatus(error) {
  const status = Number(error?.statusCode || error?.status || 0);
  return [400, 409, 413, 429, 503].includes(status) ? status : 500;
}

export function safeActorProfileRouteError(error, fallback = "人物资料操作失败") {
  const code = String(error?.code || "");
  const status = actorProfileRouteErrorStatus(error);
  const publicMessage = ACTOR_PROFILE_PUBLIC_ERROR_MESSAGES[code]
    || (status === 413 ? "人物资料请求过大"
      : status === 503 ? "人物资料服务暂时不可用，请使用同一请求键重试"
        : status === 400 ? "人物资料请求无效"
          : fallback);
  const operation = sanitizeActorProfileOperation(error?.operation);
  return {
    error: publicMessage,
    ...(Object.hasOwn(ACTOR_PROFILE_PUBLIC_ERROR_MESSAGES, code) ? { code } : {}),
    ...(error?.retryable || status === 503 ? { retryable: true } : {}),
    ...(operation ? { operation } : {})
  };
}

export async function routeWorksApi(req, res, url, deps) {
  const {
    notFound,
    personDetailService,
    readJsonBody,
    requireLocalAdmin,
    requireTrustedFileMutation,
    sendJson,
    workDetailService,
    workMutationService,
    workQueryService
  } = deps;

  if (url.pathname === "/api/fanhao/categories" && req.method === "GET") {
    sendJson(res, 200, workQueryService.categorySummaryPayload());
    return true;
  }

  if (url.pathname === "/api/works" && req.method === "GET") {
    sendJson(res, 200, workQueryService.listPayload(url));
    return true;
  }

  if (["/api/fanhao/search", "/api/search"].includes(url.pathname) && req.method === "GET") {
    sendJson(res, 200, workQueryService.searchPayload(url));
    return true;
  }

  const actorProfileMatch = /^\/api\/actor-profiles\/([^/]+)$/.exec(url.pathname);
  if (actorProfileMatch && req.method === "GET") {
    try {
      const payload = personDetailService.actorProfilePayload(decodeURIComponent(actorProfileMatch[1]));
      if (!payload) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, payload);
    } catch (error) {
      sendJson(res, actorProfileRouteErrorStatus(error), safeActorProfileRouteError(error, "读取人物资料失败"));
    }
    return true;
  }

  if (actorProfileMatch && req.method === "PUT") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const personId = decodeURIComponent(actorProfileMatch[1]);
      const body = await readJsonBody(req, personDetailService.coverBodyLimit);
      const result = personDetailService.updateActorProfile(personId, body);
      if (!result) {
        notFound(res);
        return true;
      }
      sendJson(res, result.statusCode, result.payload);
    } catch (error) {
      sendJson(res, actorProfileRouteErrorStatus(error), safeActorProfileRouteError(error, "资料页配置失败"));
    }
    return true;
  }

  const actorProfileOperationMatch = /^\/api\/actor-profile-operations\/([^/]+)$/.exec(url.pathname);
  if (actorProfileOperationMatch && req.method === "GET") {
    try {
      const operation = personDetailService.actorProfileOperation(decodeURIComponent(actorProfileOperationMatch[1]));
      if (!operation) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, { ok: true, operation: sanitizeActorProfileOperation(operation) });
    } catch (error) {
      sendJson(res, actorProfileRouteErrorStatus(error), safeActorProfileRouteError(error, "读取人物资料任务失败"));
    }
    return true;
  }

  const actorProfileOperationRetryMatch = /^\/api\/actor-profile-operations\/([^/]+)\/retry$/.exec(url.pathname);
  if (actorProfileOperationRetryMatch && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const operation = personDetailService.retryActorProfileOperation(decodeURIComponent(actorProfileOperationRetryMatch[1]));
      if (!operation) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, { ok: true, operation: sanitizeActorProfileOperation(operation) });
    } catch (error) {
      sendJson(res, actorProfileRouteErrorStatus(error), safeActorProfileRouteError(error, "重试人物资料任务失败"));
    }
    return true;
  }

  const personCoverMatch = /^\/api\/people\/([^/]+)\/cover$/.exec(url.pathname);
  if (personCoverMatch && req.method === "PUT") {
    if (!requireLocalAdmin(req, res)) return true;
    const personId = decodeURIComponent(personCoverMatch[1]);
    const body = await readJsonBody(req, personDetailService.coverBodyLimit);
    try {
      sendJson(res, 200, personDetailService.setCover(personId, body));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "设置人物封面失败" });
    }
    return true;
  }

  const personMergeMatch = /^\/api\/people\/([^/]+)\/merge$/.exec(url.pathname);
  if (personMergeMatch && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      sendJson(res, 200, personDetailService.mergeIntoTarget(decodeURIComponent(personMergeMatch[1]), body));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "合并人物失败" });
    }
    return true;
  }

  const personMatch = /^\/api\/people\/([^/]+)$/.exec(url.pathname);
  if (personMatch && req.method === "GET") {
    const payload = personDetailService.detailPayload(decodeURIComponent(personMatch[1]), url);
    if (!payload) {
      notFound(res);
      return true;
    }

    sendJson(res, 200, payload);
    return true;
  }

  const personLocalDeleteMatch = /^\/api\/people\/([^/]+)\/local-files\/delete$/.exec(url.pathname);
  if (personLocalDeleteMatch && req.method === "POST") {
    if (!requireTrustedFileMutation(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      sendJson(res, 200, personDetailService.deleteLocalFiles(decodeURIComponent(personLocalDeleteMatch[1]), body));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "批量删除本地作品失败" });
    }
    return true;
  }

  const coverGenerateMatch = /^\/api\/works\/([^/]+)\/cover\/generate$/.exec(url.pathname);
  if (coverGenerateMatch && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    const workId = decodeURIComponent(coverGenerateMatch[1]);
    try {
      const payload = workMutationService.generateCover(workId);
      if (!payload) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, payload);
    } catch (error) {
      sendJson(res, error.statusCode || 500, workMutationService.coverGenerationErrorPayload(workId, error));
    }
    return true;
  }

  const workCoverMatch = /^\/api\/works\/([^/]+)\/cover$/.exec(url.pathname);
  if (workCoverMatch && req.method === "PUT") {
    if (!requireLocalAdmin(req, res)) return true;
    const body = await readJsonBody(req);
    try {
      sendJson(res, 200, workMutationService.setManualCover(decodeURIComponent(workCoverMatch[1]), body));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "设置封面失败" });
    }
    return true;
  }

  const workMarkerMatch = /^\/api\/works\/([^/]+)\/local-marker$/.exec(url.pathname);
  if (workMarkerMatch && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    const body = await readJsonBody(req);
    try {
      sendJson(res, 200, workMutationService.setLocalMarker(decodeURIComponent(workMarkerMatch[1]), body));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "更新作品标记失败" });
    }
    return true;
  }

  const workCorrectActorMatch = /^\/api\/works\/([^/]+)\/correct-actor-from-folder$/.exec(url.pathname);
  if (workCorrectActorMatch && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      sendJson(res, 200, workMutationService.correctActorFromFolder(decodeURIComponent(workCorrectActorMatch[1])));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "订正演员失败" });
    }
    return true;
  }

  const workMoveToPersonMatch = /^\/api\/works\/([^/]+)\/move-to-person$/.exec(url.pathname);
  if (workMoveToPersonMatch && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = androidWorkMoveBody(req, await readJsonBody(req));
      sendJson(res, 202, publicWorkMoveJobPayload(workMutationService.moveToPerson(
        decodeURIComponent(workMoveToPersonMatch[1]),
        body,
        { android: isAndroidWorkMoveRequest(req) }
      )));
    } catch (error) {
      sendJson(res, error.statusCode || 500, safeWorkMoveRouteError(error, "迁移作品失败"));
    }
    return true;
  }

  const workMoveTargetsMatch = /^\/api\/works\/([^/]+)\/move-targets$/.exec(url.pathname);
  if (workMoveTargetsMatch && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      sendJson(res, 200, {
        ok: true,
        ...workMutationService.moveTargets(decodeURIComponent(workMoveTargetsMatch[1]), {
          query: url.searchParams.get("query") || "",
          limit: url.searchParams.get("limit") || ""
        })
      });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.statusCode === 404 ? "作品本地文件不存在" : "读取可迁移目标失败" });
    }
    return true;
  }

  const workMoveStatusMatch = /^\/api\/works\/([^/]+)\/move-job$/.exec(url.pathname);
  if (workMoveStatusMatch && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      sendJson(res, 200, publicWorkMoveJobPayload(workMutationService.moveJobForWork(decodeURIComponent(workMoveStatusMatch[1]), {
        idempotencyKey: url.searchParams.get("idempotencyKey") || ""
      })));
    } catch (error) {
      sendJson(res, error.statusCode || 500, safeWorkMoveRouteError(error, "读取作品迁移任务失败"));
    }
    return true;
  }

  if (url.pathname === "/api/work-move-jobs" && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      sendJson(res, 200, workMutationService.listMoveJobs({
        status: url.searchParams.get("status") || "",
        workId: url.searchParams.get("workId") || "",
        limit: url.searchParams.get("limit") || ""
      }));
    } catch (error) {
      const code = error.code || "WORK_MOVE_LIST_FAILED";
      const safeMessage = code === "WORK_MOVE_STATUS_INVALID"
        ? "迁移任务状态筛选无效"
        : code === "WORK_MOVE_LIMIT_INVALID"
          ? "迁移任务数量筛选无效"
          : "读取作品迁移任务列表失败";
      sendJson(res, error.statusCode || 500, {
        error: safeMessage,
        code
      });
    }
    return true;
  }

  const workMoveJobRetryMatch = /^\/api\/work-move-jobs\/([^/]+)\/retry$/.exec(url.pathname);
  if (workMoveJobRetryMatch && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      sendJson(res, 202, publicWorkMoveJobPayload(workMutationService.retryMoveJob(decodeURIComponent(workMoveJobRetryMatch[1]))));
    } catch (error) {
      sendJson(res, error.statusCode || 500, safeWorkMoveRouteError(error, "恢复迁移任务失败", { retry: true }));
    }
    return true;
  }

  const workMoveJobMatch = /^\/api\/work-move-jobs\/([^/]+)$/.exec(url.pathname);
  if (workMoveJobMatch && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      sendJson(res, 200, publicWorkMoveJobPayload(workMutationService.moveJob(decodeURIComponent(workMoveJobMatch[1]))));
    } catch (error) {
      sendJson(res, error.statusCode || 500, safeWorkMoveRouteError(error, "读取迁移任务失败"));
    }
    return true;
  }

  const workLocalDeleteMatch = /^\/api\/works\/([^/]+)\/local-files\/delete$/.exec(url.pathname);
  if (workLocalDeleteMatch && req.method === "POST") {
    if (!requireTrustedFileMutation(req, res)) return true;
    try {
      sendJson(res, 200, workMutationService.deleteLocalFiles(decodeURIComponent(workLocalDeleteMatch[1])));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "删除本地文件失败" });
    }
    return true;
  }

  const playbackPrewarmMatch = /^\/api\/works\/([^/]+)\/playback-prewarm$/.exec(url.pathname);
  if (playbackPrewarmMatch && req.method === "GET") {
    const payload = workDetailService.playbackPrewarmPayload(decodeURIComponent(playbackPrewarmMatch[1]));
    if (!payload) {
      notFound(res);
      return true;
    }

    sendJson(res, 200, payload);
    return true;
  }

  const workMatch = /^\/api\/works\/([^/]+)$/.exec(url.pathname);
  if (workMatch && req.method === "GET") {
    const payload = workDetailService.detailPayload(decodeURIComponent(workMatch[1]));
    if (!payload) {
      notFound(res);
      return true;
    }

    sendJson(res, 200, payload);
    return true;
  }

  const playInfoMatch = /^\/api\/playinfo\/([^/]+)$/.exec(url.pathname);
  if (playInfoMatch && req.method === "GET") {
    const payload = await workDetailService.playInfoPayload(decodeURIComponent(playInfoMatch[1]), {
      source: url.searchParams.get("source") || "fanhao"
    });
    if (!payload) {
      sendJson(res, 404, { error: "视频文件不存在或已移动，请刷新作品资料" });
      return true;
    }

    sendJson(res, 200, payload);
    return true;
  }

  const infoMatch = /^\/api\/info\/([^/]+)$/.exec(url.pathname);
  if (infoMatch && req.method === "GET") {
    if (!workDetailService.serveInfoFile(res, infoMatch[1])) {
      notFound(res);
    }
    return true;
  }

  return false;
}
