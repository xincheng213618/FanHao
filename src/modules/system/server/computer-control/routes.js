export async function routeComputerControlApi(req, res, url, deps) {
  if (url.pathname !== "/api/system/control") return false;

  const {
    computerControlService,
    readJsonBody,
    requireLocalAdmin,
    sendJson
  } = deps;

  if (req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    sendJson(res, 200, computerControlService.status());
    return true;
  }

  if (req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      sendJson(res, 202, computerControlService.dispatch(body.action));
    } catch (error) {
      sendJson(res, error.statusCode || 500, {
        ok: false,
        error: error.statusCode && error.statusCode < 500
          ? error.message
          : "系统控制指令发送失败"
      });
    }
    return true;
  }

  return false;
}
