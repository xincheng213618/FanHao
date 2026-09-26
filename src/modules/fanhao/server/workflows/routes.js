export async function routeFileWorkflows(req, res, url, { service, requireLocalAdmin, readJsonBody, sendJson }) {
  const prefix = "/api/fanhao/file-workflows";
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return false;
  if (!requireLocalAdmin(req, res)) return true;
  try {
    let result, status = 200;
    if (url.pathname === `${prefix}/config` && req.method === "GET") result = service.config();
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
