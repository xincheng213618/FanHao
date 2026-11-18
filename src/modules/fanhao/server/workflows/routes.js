const subtitleRoutes = new Set(["subtitle-source", "subtitle-search", "subtitle-files", "subtitle-download", "subtitle-download-direct", "subtitle-import", "subtitle-copy", "subtitle-remove"]);

export async function routeVideoMarkers(req, res, url, { intake, requireLocalAdmin, readJsonBody, sendJson }) {
  const match = /^\/api\/works\/([^/]+)\/video-markers$/.exec(url.pathname);
  if (!intake || !match || !["GET", "POST"].includes(req.method)) return false;
  if (!requireLocalAdmin(req, res)) return true;
  try {
    const workId = decodeURIComponent(match[1]);
    const jobId = url.searchParams.get("jobId");
    if (req.method === "GET") {
      const result = jobId ? intake.readVideoMarkerJob(workId, jobId)
        : intake.readVideoMarkers(workId, url.searchParams.get("videoId"));
      sendJson(res, 200, result);
    } else {
      const input = await readJsonBody(req);
      if (res.destroyed) return true;
      const result = intake.correctVideoMarkers(workId, input);
      sendJson(res, result.job?.active ? 202 : 200, result);
    }
  } catch (error) {
    const status = error.statusCode || (error instanceof URIError ? 400 : 500);
    sendJson(res, status, { error: error.statusCode ? error.message : "订正视频标签失败，请检查路径或服务日志" });
  }
  return true;
}

export async function routeFileWorkflows(req, res, url, { intake, requireLocalAdmin, requestAccess, readJsonBody, sendJson }) {
  const prefix = "/api/fanhao/file-workflows/intake/";
  if (!intake || !url.pathname.startsWith(prefix)) return false;
  if (!requireLocalAdmin(req, res)) return true;
  if (requestAccess(req).mode !== "local") { sendJson(res, 403, { error: "洗版工作台请从服务电脑的 localhost 打开" }); return true; }
  try {
    const route = url.pathname.slice(prefix.length);
    let result, status = 200;
    if (route === "config" && req.method === "GET") result = intake.config();
    else if (route === "jobs" && req.method === "GET") result = { jobs: intake.list() };
    else if (route === "discard-stats" && req.method === "GET") result = intake.discardStats({
      reason: url.searchParams.get("reason") || "", ltxOnly: url.searchParams.get("ltx") === "1", page: url.searchParams.get("page")
    });
    else if ((route === "compare" || subtitleRoutes.has(route)) && req.method === "POST") {
      const input = await readJsonBody(req, route === "subtitle-import" ? 3 * 1024 * 1024 : undefined);
      if (res.destroyed) return true;
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.once("close", abort);
      try { result = await intake[route](input, { signal: controller.signal }); }
      finally { res.off("close", abort); }
    } else if (["scan", "metadata", "prepare", "open"].includes(route) && req.method === "POST") result = await intake[route](await readJsonBody(req));
    else {
      const match = /^jobs\/([0-9a-f-]{36})(?:\/(run|cancel))?$/.exec(route);
      if (match && !match[2] && req.method === "GET") result = intake.detail(match[1]);
      else if (match?.[2] === "run" && req.method === "POST") { result = intake.run(match[1], await readJsonBody(req)); status = 202; }
      else if (match?.[2] === "cancel" && req.method === "POST") result = intake.cancel(match[1]);
      else { sendJson(res, 404, { error: "洗版接口不存在" }); return true; }
    }
    sendJson(res, status, result);
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : "文件任务失败，请检查目录权限或服务日志" });
  }
  return true;
}
