export function createRequestHandler({
  attachAccessAnalytics,
  attachAccessLogger,
  requestCorsOrigin,
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
    const origin = String(req.headers.origin || "").trim();
    const allowedCorsOrigin = requestCorsOrigin(req);
    if (origin) appendVaryHeader(res, "Origin");
    if (allowedCorsOrigin) {
      res.setHeader("Access-Control-Allow-Origin", allowedCorsOrigin);
      res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Accept,Range,X-FanHao-Client,X-FanHao-Media-Cache");
      res.setHeader("Access-Control-Expose-Headers", "Content-Length,Content-Range,Accept-Ranges,X-FanHao-Media-Cache,X-FanHao-Playback-Rendition,X-FanHao-Playback-Prepare,X-FanHao-Playback-Wait-Ms");
    }

    if (req.method === "OPTIONS") {
      if (origin && !allowedCorsOrigin) {
        sendJson(res, 403, { error: "不允许该跨源访问" });
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }
    if (origin && !allowedCorsOrigin) {
      sendJson(res, 403, { error: "不允许该跨源访问" });
      return;
    }

    const authState = requestAuthState(req, url);
    attachAccessAnalytics(req, res, url, authState, startedAt);
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

function appendVaryHeader(res, value) {
  const existing = String(res.getHeader?.("Vary") || "").trim();
  const values = existing ? existing.split(",").map((item) => item.trim()).filter(Boolean) : [];
  if (!values.some((item) => item.toLowerCase() === value.toLowerCase())) values.push(value);
  res.setHeader("Vary", values.join(", "));
}
