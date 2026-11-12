const subtitleRoutes = new Set(["subtitle-source", "subtitle-search", "subtitle-files", "subtitle-download", "subtitle-download-direct", "subtitle-import", "subtitle-remove"]);

export async function routeFileWorkflows(req, res, url, { service, intake, requireLocalAdmin, requestAccess, readJsonBody, sendJson }) {
  const prefix = "/api/fanhao/file-workflows";
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return false;
  if (!requireLocalAdmin(req, res)) return true;
  try {
    let result, status = 200;
    if (url.pathname.startsWith(`${prefix}/intake/`) && intake) {
      if (requestAccess(req).mode !== "local") { sendJson(res, 403, { error: "洗版工作台请从服务电脑的 localhost 打开" }); return true; }
      const route = url.pathname.slice(`${prefix}/intake/`.length);
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
    } else if (url.pathname === `${prefix}/config` && req.method === "GET") result = service.config();
    else if (url.pathname === prefix && req.method === "GET") result = { jobs: service.list() };
    else if (url.pathname === `${prefix}/preview` && req.method === "POST") result = { job: await service.preview(await readJsonBody(req)) };
    else {
      const match = /^\/api\/fanhao\/file-workflows\/([a-f0-9-]{36})(?:\/(run|stop))?$/.exec(url.pathname);
      if (!match) { sendJson(res, 404, { error: "任务接口不存在" }); return true; }
      if (req.method === "GET" && !match[2]) result = { job: service.detail(match[1]) };
      else if (req.method === "POST" && match[2] === "run") { result = { job: service.run(match[1]) }; status = 202; }
      else if (req.method === "POST" && match[2] === "stop") result = { job: service.stop(match[1]) };
      else { sendJson(res, 405, { error: "请求方法不支持" }); return true; }
    }
    sendJson(res, status, result);
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : "文件任务失败，请检查目录权限或服务日志" });
  }
  return true;
}
