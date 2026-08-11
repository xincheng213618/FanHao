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
    const payload = personDetailService.actorProfilePayload(decodeURIComponent(actorProfileMatch[1]));
    if (!payload) {
      notFound(res);
      return true;
    }

    sendJson(res, 200, payload);
    return true;
  }

  if (actorProfileMatch && req.method === "PUT") {
    const personId = decodeURIComponent(actorProfileMatch[1]);
    const body = await readJsonBody(req);
    try {
      const payload = personDetailService.updateActorProfile(personId, body);
      if (!payload) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, payload);
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message || "资料页配置失败" });
    }
    return true;
  }

  const personCoverMatch = /^\/api\/people\/([^/]+)\/cover$/.exec(url.pathname);
  if (personCoverMatch && req.method === "PUT") {
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
      const body = await readJsonBody(req);
      sendJson(res, 202, workMutationService.moveToPerson(decodeURIComponent(workMoveToPersonMatch[1]), body));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "迁移作品失败", ...(error.job ? { job: error.job } : {}) });
    }
    return true;
  }

  const workMoveStatusMatch = /^\/api\/works\/([^/]+)\/move-job$/.exec(url.pathname);
  if (workMoveStatusMatch && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      sendJson(res, 200, workMutationService.moveJobForWork(decodeURIComponent(workMoveStatusMatch[1]), {
        idempotencyKey: url.searchParams.get("idempotencyKey") || ""
      }));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "读取作品迁移任务失败" });
    }
    return true;
  }

  const workMoveJobRetryMatch = /^\/api\/work-move-jobs\/([^/]+)\/retry$/.exec(url.pathname);
  if (workMoveJobRetryMatch && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      sendJson(res, 202, workMutationService.retryMoveJob(decodeURIComponent(workMoveJobRetryMatch[1])));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "恢复迁移任务失败" });
    }
    return true;
  }

  const workMoveJobMatch = /^\/api\/work-move-jobs\/([^/]+)$/.exec(url.pathname);
  if (workMoveJobMatch && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      sendJson(res, 200, workMutationService.moveJob(decodeURIComponent(workMoveJobMatch[1])));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "读取迁移任务失败" });
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
