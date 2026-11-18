export async function routeComputerControlApi(req, res, url, deps) {
  if (url.pathname !== "/api/system/control") return false;
  if (req.method !== "GET" && req.method !== "POST") return false;

  const {
    canUseLanGuestSleep,
    computerControlService,
    readJsonBody,
    requireLocalAdmin,
    sendJson
  } = deps;
  const sleepOnly = canUseLanGuestSleep(req, url);
  if (!sleepOnly && !requireLocalAdmin(req, res)) return true;

  if (req.method === "GET") {
    const status = computerControlService.status();
    if (sleepOnly) {
      sendJson(res, 200, {
        ok: status.ok,
        platform: status.platform,
        platformLabel: status.platformLabel,
        actions: status.actions.filter(action => action.id === "sleep")
      });
    } else {
      sendJson(res, 200, status);
    }
    return true;
  }

  try {
    const body = await readJsonBody(req);
    if (sleepOnly && body?.action !== "sleep") {
      sendJson(res, 403, { ok: false, error: "局域网访客只能使用休眠电脑" });
      return true;
    }
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
