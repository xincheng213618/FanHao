export function createRequestHandler({
  applyAppCookie,
  attachAccessLogger,
  requestAuthState,
  routeAuth,
  sendLoginRequired,
  routeApi,
  routeMedia,
  renderAndroidUpdatePage,
  serveStatic,
  sendHtml,
  sendJson,
  sendText
}) {
  return async function requestHandler(req, res) {
    const startedAt = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Accept,Range,X-FanHao-Client,X-FanHao-Media-Cache");
    res.setHeader("Access-Control-Expose-Headers", "Content-Length,Content-Range,Accept-Ranges");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const authState = requestAuthState(req, url);
    applyAppCookie(res, authState);
    attachAccessLogger(req, res, url, authState, startedAt);

    try {
      if (await routeAuth(req, res, url, authState)) return;
      if (!authState.allowed) {
        sendLoginRequired(req, res, url, authState);
        return;
      }

      if (await routeApi(req, res, url)) return;
      if (await routeMedia(req, res, url)) return;
      if (url.pathname === "/android-update" && req.method === "GET") {
        sendHtml(res, 200, renderAndroidUpdatePage(req, url));
        return;
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        sendText(res, 405, "Method not allowed");
        return;
      }

      serveStatic(req, res, url.pathname);
    } catch (error) {
      console.error("[request]", error);
      sendJson(res, 500, { error: error.message || "Internal server error" });
    }
  };
}
