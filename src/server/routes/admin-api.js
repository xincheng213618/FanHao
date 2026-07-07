export async function routeAdminApi(req, res, url, deps) {
  const {
    adminActorAvatarService,
    adminMaintenanceTaskService,
    adminPersonService,
    adminSettingsService,
    adminTaskOrchestrationService,
    readJsonBody,
    requireLocalAdmin,
    sendJson
  } = deps;

  if (!url.pathname.startsWith("/api/admin/")) return false;

  if (url.pathname === "/api/admin/tasks" && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    sendJson(res, 200, adminTaskOrchestrationService.tasksPayload());
    return true;
  }

  if (url.pathname === "/api/admin/tasks/stop" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      sendJson(res, 200, adminTaskOrchestrationService.stopTaskPayload(body.taskId || body.id));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "停止任务失败" });
    }
    return true;
  }

  if (url.pathname === "/api/admin/scripts" && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    sendJson(res, 200, adminTaskOrchestrationService.scriptsPayload());
    return true;
  }

  if (url.pathname === "/api/admin/scripts/run" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      sendJson(res, 202, adminTaskOrchestrationService.runScriptPayload(body));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "启动脚本失败" });
    }
    return true;
  }

  if (url.pathname === "/api/admin/config" && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    sendJson(res, 200, adminSettingsService.configPayload());
    return true;
  }

  if (url.pathname === "/api/admin/config" && req.method === "PUT") {
    if (!requireLocalAdmin(req, res)) return true;
    const body = await readJsonBody(req);
    sendJson(res, 200, adminSettingsService.updateConfigPayload(body));
    return true;
  }

  if (url.pathname === "/api/admin/douban-cookie" && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    sendJson(res, 200, adminSettingsService.doubanCookiePayload());
    return true;
  }

  if (url.pathname === "/api/admin/douban-cookie" && req.method === "PUT") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      sendJson(res, 200, adminSettingsService.saveDoubanCookiePayload(body));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "保存豆瓣 Cookie 失败" });
    }
    return true;
  }

  if (url.pathname === "/api/admin/douban-cookie/test" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const response = await adminSettingsService.testDoubanCookieResponse();
      sendJson(res, response.statusCode, response.payload);
    } catch (error) {
      const response = adminSettingsService.doubanCookieTestErrorResponse(error);
      sendJson(res, response.statusCode, response.payload);
    }
    return true;
  }

  if (url.pathname === "/api/admin/import-actor-avatars" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      sendJson(res, 200, adminActorAvatarService.importFromFiletreePayload(body));
    } catch (error) {
      const response = adminActorAvatarService.errorPayload(error, "扫描演员头像失败");
      sendJson(res, response.statusCode, response.payload);
    }
    return true;
  }

  if (url.pathname === "/api/admin/actor-avatar-candidates" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      sendJson(res, 200, adminActorAvatarService.candidatesPayload(body));
    } catch (error) {
      const response = adminActorAvatarService.errorPayload(error, "读取演员头像候选失败");
      sendJson(res, response.statusCode, response.payload);
    }
    return true;
  }

  if (url.pathname === "/api/admin/apply-actor-avatar-candidate" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      sendJson(res, 200, adminActorAvatarService.applyCandidatePayload(body));
    } catch (error) {
      const response = adminActorAvatarService.errorPayload(error, "应用演员头像候选失败");
      sendJson(res, response.statusCode, response.payload);
    }
    return true;
  }

  const personMappingMatch = /^\/api\/admin\/person-mapping\/([^/]+)$/.exec(url.pathname);
  if (personMappingMatch && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    const payload = adminPersonService.mappingPayload(decodeURIComponent(personMappingMatch[1]), url);
    if (!payload) {
      sendJson(res, 404, { error: "人物不存在" });
      return true;
    }
    sendJson(res, 200, payload);
    return true;
  }

  if (url.pathname === "/api/admin/rescan-person" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    const body = await readJsonBody(req);

    try {
      const payload = adminPersonService.rescanPersonPayload(body, url);
      if (!payload) {
        sendJson(res, 404, { error: "人物不存在" });
        return true;
      }
      sendJson(res, 200, payload);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "刷新人物失败" });
    }
    return true;
  }

  if (url.pathname === "/api/admin/refresh-actor-movies" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      sendJson(res, 202, adminMaintenanceTaskService.refreshActorMoviesPayload(body));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "刷新 JavDB 片单失败" });
    }
    return true;
  }

  if (url.pathname === "/api/admin/refresh-rankings" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    sendJson(res, 410, { error: "旧缓存库已移除；排行榜刷新需要 core DB 原生脚本。" });
    return true;
  }

  if (url.pathname === "/api/admin/cover-cache-status" && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    sendJson(res, 200, adminMaintenanceTaskService.coverCacheStatusPayload(url.searchParams.get("limit")));
    return true;
  }

  if (url.pathname === "/api/admin/generate-missing-covers" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      sendJson(res, 202, adminMaintenanceTaskService.generateMissingCoversPayload(body));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "批量补封面失败" });
    }
    return true;
  }

  return false;
}
