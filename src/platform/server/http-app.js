export function createRequestHandler({
  attachAccessAnalytics,
  attachAccessLogger,
  requestCorsOrigin,
  requestAuthState,
  runForUser = (_user, action) => action(),
  routeAuth,
  sendLoginRequired,
  routeApi,
  routeMedia,
  renderAndroidUpdatePage,
  serveStatic,
  sendHtml,
  sendJson,
  sendText,
  logError = console.error
}) {
  return async function requestHandler(req, res) {
    const startedAt = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const origin = String(req.headers.origin || "").trim();
    const allowedCorsOrigin = requestCorsOrigin(req) || publicAndroidUpdateCorsOrigin(req, url);
    if (origin) appendVaryHeader(res, "Origin");
    if (allowedCorsOrigin) {
      res.setHeader("Access-Control-Allow-Origin", allowedCorsOrigin);
      res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Accept,Authorization,Range,If-Range,X-FanHao-Client,X-FanHao-Media-Cache,X-FanHao-Account-Owner");
      res.setHeader("Access-Control-Expose-Headers", "Content-Length,Content-Range,Accept-Ranges,ETag,Last-Modified,X-FanHao-Media-Cache,X-FanHao-Playback-Rendition,X-FanHao-Playback-Prepare,X-FanHao-Playback-Wait-Ms,X-FanHao-Account-Owner");
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

    try {
      const authState = requestAuthState(req, url);
      attachAccessAnalytics(req, res, url, authState, startedAt);
      attachAccessLogger(req, res, url, authState, startedAt);
      if (await routeAuth(req, res, url, authState)) return;
      if (url.pathname === "/android-update" && (req.method === "GET" || req.method === "HEAD")) {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
        if (req.method === "HEAD") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end();
        } else {
          sendHtml(res, 200, renderAndroidUpdatePage(req, url));
        }
        return;
      }
      if (!authState.allowed) {
        if (isPublicAndroidUpdateRequest(req, url)) {
          if (await routeApi(req, res, url)) return;
          sendText(res, 404, "Not found");
          return;
        }
        sendLoginRequired(req, res, url, authState);
        return;
      }

      // This is a stale-client assertion, never a source of authentication identity.
      const expectedOwner = req.headers["x-fanhao-account-owner"];
      const actualOwner = authState.user?.id ? `account:${authState.user.id}` : "guest";
      if (url.pathname.startsWith("/api/")) res.setHeader("X-FanHao-Account-Owner", actualOwner);
      if (url.pathname.startsWith("/api/") && expectedOwner !== undefined && expectedOwner !== actualOwner) {
        sendJson(res, 409, { code: "ACCOUNT_CHANGED", error: "账号已切换，请刷新后重试" });
        return;
      }

      await runForUser(authState.user || null, async () => {
        if (await routeApi(req, res, url)) return;
        if (await routeMedia(req, res, url)) return;

        if (req.method !== "GET" && req.method !== "HEAD") {
          sendText(res, 405, "Method not allowed");
          return;
        }

        await serveStatic(req, res, url.pathname);
      });
    } catch (error) {
      logError("[request]", error);
      if (res.headersSent || res.writableEnded || res.destroyed) return;
      const statusCode = publicErrorStatus(error);
      sendJson(res, statusCode, {
        error: statusCode < 500 && error?.message
          ? error.message
          : "Internal server error"
      });
    }
  };
}

function isPublicAndroidUpdateRequest(req, url) {
  if (url.pathname === "/api/android/update") return req.method === "GET";
  return (req.method === "GET" || req.method === "HEAD")
    && /^\/api\/android\/update\/apk\/[^/]+\/[^/]+$/.test(url.pathname);
}

function publicAndroidUpdateCorsOrigin(req, url) {
  if (!isAndroidUpdateApiPath(url.pathname)) return "";
  if (req.method !== "OPTIONS" && !isPublicAndroidUpdateRequest(req, url)) return "";
  const rawOrigin = String(req.headers.origin || "").trim();
  if (!rawOrigin) return "";
  try {
    const origin = new URL(rawOrigin);
    const localAppOrigin = ["http:", "https:", "capacitor:"].includes(origin.protocol)
      && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(origin.hostname.toLowerCase())
      && !origin.port
      && !origin.username
      && !origin.password
      && (origin.pathname === "" || origin.pathname === "/")
      && !origin.search
      && !origin.hash;
    return localAppOrigin ? rawOrigin : "";
  } catch {
    return "";
  }
}

function isAndroidUpdateApiPath(pathname) {
  return pathname === "/api/android/update"
    || /^\/api\/android\/update\/apk\/[^/]+\/[^/]+$/.test(pathname);
}

function publicErrorStatus(error) {
  const statusCode = Number(error?.statusCode);
  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500
    ? statusCode
    : 500;
}

function appendVaryHeader(res, value) {
  const existing = String(res.getHeader?.("Vary") || "").trim();
  const values = existing ? existing.split(",").map((item) => item.trim()).filter(Boolean) : [];
  if (!values.some((item) => item.toLowerCase() === value.toLowerCase())) values.push(value);
  res.setHeader("Vary", values.join(", "));
}
