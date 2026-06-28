import crypto from "node:crypto";
import fs from "node:fs";

const WEB_AUTH_COOKIE = "fanhao_web_auth";
const APP_AUTH_COOKIE = "fanhao_app_auth";
const WEB_AUTH_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const APP_AUTH_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

export function createAuthServices({
  authSecretPath,
  accessLogPath,
  remoteWebPassword,
  ensureDataDir,
  ensureLogDir,
  readBodyText,
  sendJson,
  sendHtml,
  redirect
}) {
  function getAuthSecret() {
    ensureDataDir();
    try {
      const existing = fs.readFileSync(authSecretPath, "utf8").trim();
      if (existing.length >= 32) return existing;
    } catch {}

    const secret = crypto.randomBytes(32).toString("base64url");
    fs.writeFileSync(authSecretPath, secret, "utf8");
    return secret;
  }

  function hmacText(value) {
    return crypto.createHmac("sha256", getAuthSecret()).update(value).digest("base64url");
  }

  function safeEqualText(a, b) {
    const left = Buffer.from(String(a || ""));
    const right = Buffer.from(String(b || ""));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  }

  function parseCookies(req) {
    const cookies = {};
    for (const part of String(req.headers.cookie || "").split(";")) {
      const index = part.indexOf("=");
      if (index <= 0) continue;
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (!key) continue;
      try {
        cookies[key] = decodeURIComponent(value);
      } catch {
        cookies[key] = value;
      }
    }
    return cookies;
  }

  function serializeCookie(name, value, options = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax"];
    if (options.httpOnly !== false) parts.push("HttpOnly");
    if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
    if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
    return parts.join("; ");
  }

  function clearCookie(name) {
    return serializeCookie(name, "", { maxAge: 0, expires: new Date(0) });
  }

  function createAuthToken(kind) {
    const issuedAt = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(12).toString("base64url");
    const payload = `${kind}.${issuedAt}.${nonce}`;
    return `${payload}.${hmacText(payload)}`;
  }

  function validateAuthToken(token, kind, maxAgeSeconds) {
    const parts = String(token || "").split(".");
    if (parts.length !== 4 || parts[0] !== kind) return false;
    const issuedAt = Number(parts[1]);
    if (!Number.isFinite(issuedAt)) return false;
    const age = Math.floor(Date.now() / 1000) - issuedAt;
    if (age < 0 || age > maxAgeSeconds) return false;

    const payload = parts.slice(0, 3).join(".");
    const expected = hmacText(payload);
    return safeEqualText(parts[3], expected);
  }

  function htmlEscape(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function safeNextPath(value) {
    const raw = String(value || "").trim();
    if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
    if (raw.startsWith("/auth/")) return "/";
    try {
      const parsed = new URL(raw, "http://fanhao.local");
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return "/";
    }
  }

  function loginPageHtml(options = {}) {
    const next = safeNextPath(options.next || "/");
    const error = options.error ? `<p class="login-error">${htmlEscape(options.error)}</p>` : "";
    return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#1f7a62" />
    <title>访问验证</title>
    <style>
      :root { color-scheme: light dark; font-family: "Microsoft YaHei", system-ui, sans-serif; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #eef5f1; color: #17231f; }
      main { width: min(420px, calc(100vw - 32px)); padding: 28px; border: 1px solid rgba(23, 35, 31, 0.12); border-radius: 8px; background: rgba(255, 255, 255, 0.92); box-shadow: 0 18px 48px rgba(23, 35, 31, 0.14); }
      h1 { margin: 0 0 8px; font-size: 24px; line-height: 1.2; }
      p { margin: 0 0 20px; color: #50625c; line-height: 1.6; }
      label { display: grid; gap: 8px; font-weight: 700; }
      input { box-sizing: border-box; width: 100%; min-height: 46px; border: 1px solid #bdcbc4; border-radius: 6px; padding: 0 12px; font: inherit; background: #fff; color: #17231f; }
      button { width: 100%; min-height: 46px; margin-top: 16px; border: 0; border-radius: 6px; background: #1f7a62; color: #fff; font: inherit; font-weight: 800; cursor: pointer; }
      .login-error { margin: 0 0 14px; color: #b42318; font-weight: 700; }
      @media (prefers-color-scheme: dark) {
        body { background: #101816; color: #edf7f2; }
        main { background: #16231f; border-color: rgba(237, 247, 242, 0.12); box-shadow: none; }
        p { color: #a7bbb3; }
        input { background: #0f1715; border-color: #345046; color: #edf7f2; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>访问验证</h1>
      <p>远程网页访问需要输入访问密码。</p>
      ${error}
      <form method="post" action="/auth/login">
        <input type="hidden" name="next" value="${htmlEscape(next)}" />
        <label>
          密码
          <input name="password" type="password" autocomplete="current-password" autofocus required />
        </label>
        <button type="submit">进入资料库</button>
      </form>
    </main>
  </body>
</html>`;
  }

  async function readAuthBody(req) {
    const body = await readBodyText(req, 16 * 1024);
    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    if (contentType.includes("application/json")) {
      try {
        return JSON.parse(body || "{}");
      } catch {
        throw new Error("JSON 格式无效");
      }
    }
    return Object.fromEntries(new URLSearchParams(body));
  }

  function requestHostName(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      return new URL(`http://${raw}`).hostname.toLowerCase();
    } catch {
      return raw.split(":")[0].toLowerCase();
    }
  }

  function normalizeRemoteAddress(value) {
    let address = String(value || "").trim().toLowerCase();
    if (!address) return "";
    if (address.startsWith("::ffff:")) address = address.slice("::ffff:".length);
    if (address.startsWith("[") && address.endsWith("]")) address = address.slice(1, -1);
    const zoneIndex = address.indexOf("%");
    if (zoneIndex > -1) address = address.slice(0, zoneIndex);
    return address;
  }

  function isLocalHostName(host) {
    const value = normalizeRemoteAddress(host);
    return ["localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1"].includes(value);
  }

  function isSameLocalOrigin(req) {
    const origin = String(req.headers.origin || "").trim();
    if (!origin) return true;

    try {
      const originUrl = new URL(origin);
      const requestHost = String(req.headers.host || "").toLowerCase();
      return originUrl.host.toLowerCase() === requestHost && isLocalHostName(originUrl.hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  function isLanHost(host) {
    const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(normalizeRemoteAddress(host));
    if (!match) return false;
    const first = Number(match[1]);
    const second = Number(match[2]);
    return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 169 && second === 254);
  }

  function requestAccess(req) {
    const host = requestHostName(req.headers.host);
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const remote = normalizeRemoteAddress(forwarded || req.socket.remoteAddress || "");
    const hostIsLocal = isLocalHostName(host);
    const hostIsLan = isLanHost(host);
    const clientIsLocal = isLocalHostName(remote);
    const clientIsLan = isLanHost(remote);
    const mode = hostIsLocal ? "local" : hostIsLan ? "lan" : "remote";
    return {
      mode,
      isLocal: mode === "local",
      isLan: mode === "lan",
      host,
      clientAddress: remote,
      hostIsLocal,
      hostIsLan,
      clientIsLocal,
      clientIsLan,
      hints: {
        workPageSize: mode === "local" ? 1000 : 80,
        videoPreload: mode === "local" ? "metadata" : "none",
        transcode: mode === "local" ? "manual" : "prefer"
      }
    };
  }

  function isTrustedNetworkAccess(access) {
    return Boolean(access?.hostIsLocal || access?.hostIsLan);
  }

  function isAppClientOrigin(req) {
    const origin = String(req.headers.origin || req.headers.referer || "").trim();
    if (!origin) return false;
    try {
      const url = new URL(origin);
      return (
        url.protocol === "capacitor:" ||
        ((url.protocol === "http:" || url.protocol === "https:") && isLocalHostName(url.hostname))
      );
    } catch {
      return false;
    }
  }

  function isAndroidAppClient(req, url) {
    const ua = String(req.headers["user-agent"] || "");
    const clientHeader = String(req.headers["x-fanhao-client"] || "").toLowerCase() === "android";
    const clientQuery = url.searchParams.get("client") === "android";
    const hasAppMarker = /\bFanHaoAndroidApp\//i.test(ua);
    const looksLikeAndroidWebView = /\bAndroid\b/i.test(ua) && (/\bwv\b/i.test(ua) || /\bVersion\/4\.0\b/i.test(ua));
    return hasAppMarker || ((clientHeader || clientQuery) && (looksLikeAndroidWebView || isAppClientOrigin(req)));
  }

  function requestAuthState(req, url) {
    const access = requestAccess(req);
    const appClient = isAndroidAppClient(req, url);
    const required = !isTrustedNetworkAccess(access) && !appClient;
    const cookies = parseCookies(req);
    const webTokenValid = validateAuthToken(cookies[WEB_AUTH_COOKIE], "web", WEB_AUTH_MAX_AGE_SECONDS);
    const appTokenValid = validateAuthToken(cookies[APP_AUTH_COOKIE], "app", APP_AUTH_MAX_AGE_SECONDS);

    if (appClient) {
      return {
        access,
        allowed: true,
        required: false,
        reason: "app",
        setAppCookie: !appTokenValid
      };
    }

    if (!required) return { access, allowed: true, required: false, reason: "trusted-network" };
    if (webTokenValid) return { access, allowed: true, required: true, reason: "password" };
    if (appTokenValid) return { access, allowed: true, required: true, reason: "app-cookie" };
    return { access, allowed: false, required: true, reason: "missing-password" };
  }

  function isHtmlRequest(req, url) {
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/media/")) return false;
    const accept = String(req.headers.accept || "");
    const fetchDest = String(req.headers["sec-fetch-dest"] || "");
    return req.method === "GET" && (accept.includes("text/html") || fetchDest === "document");
  }

  function sendLoginRequired(req, res, url, authState) {
    const next = safeNextPath(`${url.pathname}${url.search || ""}`);
    if (isHtmlRequest(req, url)) {
      sendHtml(res, 200, loginPageHtml({ next }));
      return;
    }

    sendJson(res, 401, {
      error: "远程网页访问需要登录",
      loginUrl: `/login?next=${encodeURIComponent(next)}`,
      access: authState.access
    });
  }

  async function routeAuth(req, res, url, authState) {
    if (url.pathname === "/api/auth/status" && req.method === "GET") {
      sendJson(res, 200, {
        required: authState.required,
        authenticated: authState.allowed,
        reason: authState.reason,
        access: authState.access
      });
      return true;
    }

    if (url.pathname === "/login" && req.method === "GET") {
      if (authState.allowed && authState.required) {
        redirect(res, safeNextPath(url.searchParams.get("next") || "/"));
        return true;
      }
      sendHtml(res, 200, loginPageHtml({ next: url.searchParams.get("next") || "/" }));
      return true;
    }

    if (url.pathname === "/auth/login" && req.method === "POST") {
      const body = await readAuthBody(req);
      const next = safeNextPath(body.next || url.searchParams.get("next") || "/");
      if (!safeEqualText(body.password, remoteWebPassword)) {
        if (String(req.headers.accept || "").includes("application/json")) {
          sendJson(res, 401, { error: "密码不正确" });
        } else {
          sendHtml(res, 401, loginPageHtml({ next, error: "密码不正确" }));
        }
        return true;
      }

      const headers = {
        "Set-Cookie": serializeCookie(WEB_AUTH_COOKIE, createAuthToken("web"), { maxAge: WEB_AUTH_MAX_AGE_SECONDS })
      };
      if (String(req.headers.accept || "").includes("application/json")) {
        res.setHeader("Set-Cookie", headers["Set-Cookie"]);
        sendJson(res, 200, { ok: true, next });
      } else {
        redirect(res, next, 303, headers);
      }
      return true;
    }

    if (url.pathname === "/auth/logout" && req.method === "POST") {
      redirect(res, "/login", 303, {
        "Set-Cookie": [clearCookie(WEB_AUTH_COOKIE), clearCookie(APP_AUTH_COOKIE)]
      });
      return true;
    }

    return false;
  }

  function accessLogEntry(req, res, url, authState, startedAt) {
    return {
      time: new Date().toISOString(),
      method: req.method,
      path: `${url.pathname}${url.search || ""}`,
      status: res.statusCode,
      ms: Date.now() - startedAt,
      host: authState.access.host,
      remote: authState.access.clientAddress,
      access: authState.access.mode,
      auth: authState.reason,
      userAgent: String(req.headers["user-agent"] || "").slice(0, 180)
    };
  }

  function attachAccessLogger(req, res, url, authState, startedAt) {
    res.on("finish", () => {
      try {
        ensureLogDir();
        fs.appendFileSync(accessLogPath, `${JSON.stringify(accessLogEntry(req, res, url, authState, startedAt))}\n`, "utf8");
      } catch (error) {
        console.warn("[access-log]", error.message || error);
      }
    });
  }

  function applyAppCookie(res, authState) {
    if (!authState.setAppCookie) return;
    res.setHeader("Set-Cookie", serializeCookie(APP_AUTH_COOKIE, createAuthToken("app"), { maxAge: APP_AUTH_MAX_AGE_SECONDS }));
  }

  return {
    applyAppCookie,
    attachAccessLogger,
    isSameLocalOrigin,
    requestAccess,
    requestAuthState,
    routeAuth,
    sendLoginRequired
  };
}
