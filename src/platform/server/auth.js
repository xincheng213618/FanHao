import crypto from "node:crypto";
import fs from "node:fs";

const WEB_AUTH_COOKIE = "fanhao_web_auth";
const APP_AUTH_COOKIE = "fanhao_app_auth";
const WEB_AUTH_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const LOGIN_BUCKET_LIMIT = 2048;

export function createAuthServices({
  authSecretPath,
  remoteWebPassword,
  ensureDataDir,
  readBodyText,
  sendJson,
  sendHtml,
  redirect,
  now = Date.now
}) {
  const loginFailures = new Map();
  let authSecretCache = "";

  function getAuthSecret() {
    if (authSecretCache) return authSecretCache;
    ensureDataDir();
    try {
      const existing = JSON.parse(fs.readFileSync(authSecretPath, "utf8"));
      const secret = String(existing?.secret || "").trim();
      const passwordBinding = String(existing?.webPasswordBinding || "").trim();
      if (
        existing?.version === 2
        && secret.length >= 32
        && safeEqualText(passwordBinding, webPasswordBinding(secret))
      ) {
        authSecretCache = secret;
        return authSecretCache;
      }
    } catch {}

    const secret = crypto.randomBytes(32).toString("base64url");
    fs.writeFileSync(authSecretPath, JSON.stringify({
      version: 2,
      secret,
      webPasswordBinding: webPasswordBinding(secret)
    }), "utf8");
    authSecretCache = secret;
    return authSecretCache;
  }

  function webPasswordBinding(secret) {
    return crypto.createHmac("sha256", secret)
      .update(`web-password-binding-v1\0${remoteWebPassword}`)
      .digest("base64url");
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

  function createWebAuthToken() {
    const issuedAt = Math.floor(Number(now()) / 1000);
    const nonce = crypto.randomBytes(12).toString("base64url");
    const payload = `web.${issuedAt}.${nonce}`;
    return `${payload}.${hmacText(`web-auth-v2\0${remoteWebPassword}\0${payload}`)}`;
  }

  function validateWebAuthToken(token) {
    if (!remoteWebPassword) return false;
    const parts = String(token || "").split(".");
    if (parts.length !== 4 || parts[0] !== "web") return false;
    const issuedAt = Number(parts[1]);
    if (!Number.isFinite(issuedAt)) return false;
    const age = Math.floor(Number(now()) / 1000) - issuedAt;
    if (age < 0 || age > WEB_AUTH_MAX_AGE_SECONDS) return false;

    const payload = parts.slice(0, 3).join(".");
    const expected = hmacText(`web-auth-v2\0${remoteWebPassword}\0${payload}`);
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
    const value = normalizeRemoteAddress(host);
    if (value.endsWith(".local")) return true;
    if (/^fe[89ab][0-9a-f]:/.test(value) || (value.includes(":") && (value.startsWith("fc") || value.startsWith("fd")))) return true;

    const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(value);
    if (!match) return false;
    const first = Number(match[1]);
    const second = Number(match[2]);
    return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 169 && second === 254);
  }

  function requestAccess(req) {
    const host = requestHostName(req.headers.host);
    const remote = normalizeRemoteAddress(req.socket.remoteAddress || "");
    const hostIsLocal = isLocalHostName(host);
    const hostIsLan = isLanHost(host);
    const clientIsLocal = isLocalHostName(remote);
    const clientIsLan = isLanHost(remote);
    const mode = clientIsLocal ? "local" : clientIsLan ? "lan" : "remote";
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
        workPageSize: mode === "local" ? 96 : mode === "lan" ? 64 : 48,
        videoPreload: mode === "local" ? "metadata" : "none",
        transcode: mode === "local" ? "manual" : "prefer"
      }
    };
  }

  function loginClientKey(req) {
    return normalizeRemoteAddress(req.socket.remoteAddress || "") || "unknown";
  }

  function pruneLoginFailures(currentTime) {
    for (const [key, entry] of loginFailures) {
      const hasRecentFailure = entry.failures.some((failedAt) => currentTime - failedAt < LOGIN_FAILURE_WINDOW_MS);
      if (entry.blockedUntil <= currentTime && !hasRecentFailure) loginFailures.delete(key);
    }
    while (loginFailures.size >= LOGIN_BUCKET_LIMIT) {
      const oldestKey = loginFailures.keys().next().value;
      if (oldestKey === undefined) break;
      loginFailures.delete(oldestKey);
    }
  }

  function activeLoginBlock(req) {
    const currentTime = Number(now());
    pruneLoginFailures(currentTime);
    const entry = loginFailures.get(loginClientKey(req));
    if (!entry || entry.blockedUntil <= currentTime) return null;
    return Math.max(1, Math.ceil((entry.blockedUntil - currentTime) / 1000));
  }

  function recordLoginFailure(req) {
    const currentTime = Number(now());
    pruneLoginFailures(currentTime);
    const key = loginClientKey(req);
    const previous = loginFailures.get(key);
    const failures = (previous?.failures || []).filter((failedAt) => currentTime - failedAt < LOGIN_FAILURE_WINDOW_MS);
    failures.push(currentTime);
    const blockedUntil = failures.length >= LOGIN_FAILURE_LIMIT ? currentTime + LOGIN_BLOCK_MS : 0;
    loginFailures.set(key, { failures, blockedUntil });
    return blockedUntil > currentTime ? Math.ceil((blockedUntil - currentTime) / 1000) : null;
  }

  function clearLoginFailures(req) {
    loginFailures.delete(loginClientKey(req));
  }

  function sendLoginFailure(req, res, next, retryAfterSeconds = null) {
    const blocked = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0;
    const status = blocked ? 429 : 401;
    const message = blocked ? "尝试次数过多，请稍后再试" : "密码不正确";
    if (blocked) res.setHeader("Retry-After", String(retryAfterSeconds));
    if (String(req.headers.accept || "").includes("application/json")) {
      sendJson(res, status, { error: message });
    } else {
      sendHtml(res, status, loginPageHtml({ next, error: message }));
    }
  }

  function isTrustedNetworkAccess(access) {
    return Boolean(access?.clientIsLocal || access?.clientIsLan);
  }

  function isTrustedRequestHost(access) {
    return Boolean(access?.hostIsLocal || access?.hostIsLan);
  }

  function requestCorsOrigin(req) {
    const rawOrigin = String(req.headers.origin || "").trim();
    if (!rawOrigin) return "";
    try {
      const originUrl = new URL(rawOrigin);
      const requestHost = String(req.headers.host || "").trim().toLowerCase();
      if (originUrl.host.toLowerCase() === requestHost) return rawOrigin;

      const access = requestAccess(req);
      if (!isTrustedNetworkAccess(access) || !isTrustedRequestHost(access)) return "";
      const localOriginPath = originUrl.protocol === "capacitor:"
        ? originUrl.pathname === "" || originUrl.pathname === "/"
        : originUrl.pathname === "/";
      const localAppOrigin = isLocalHostName(originUrl.hostname)
        && ["http:", "https:", "capacitor:"].includes(originUrl.protocol)
        && !originUrl.port
        && !originUrl.username
        && !originUrl.password
        && localOriginPath
        && !originUrl.search
        && !originUrl.hash;
      return localAppOrigin ? rawOrigin : "";
    } catch {
      return "";
    }
  }

  function isSameTrustedNetworkOrigin(req, access = requestAccess(req)) {
    if (!isTrustedNetworkAccess(access)) return false;
    const origin = String(req.headers.origin || "").trim();
    const trustedRequestHost = isTrustedRequestHost(access);
    if (!origin) return trustedRequestHost;

    try {
      const originUrl = new URL(origin);
      const requestHost = String(req.headers.host || "").toLowerCase();
      if (originUrl.host.toLowerCase() === requestHost) return trustedRequestHost;
      return isAppClientOrigin(req) && String(req.headers["x-fanhao-client"] || "").toLowerCase() === "android";
    } catch {
      return false;
    }
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
    const trustedNetwork = isTrustedNetworkAccess(access) && isTrustedRequestHost(access);
    const cookies = parseCookies(req);
    const webTokenValid = validateWebAuthToken(cookies[WEB_AUTH_COOKIE]);

    if (trustedNetwork && appClient) {
      return {
        access,
        allowed: true,
        required: false,
        reason: "app"
      };
    }

    if (trustedNetwork) return { access, allowed: true, required: false, reason: "trusted-network" };
    if (webTokenValid) return { access, allowed: true, required: true, reason: "password" };
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
      const fallbackNext = safeNextPath(url.searchParams.get("next") || "/");
      const activeBlockSeconds = activeLoginBlock(req);
      if (activeBlockSeconds) {
        sendLoginFailure(req, res, fallbackNext, activeBlockSeconds);
        return true;
      }

      const body = await readAuthBody(req);
      const next = safeNextPath(body.next || fallbackNext);
      if (!remoteWebPassword || !safeEqualText(body.password, remoteWebPassword)) {
        const retryAfterSeconds = remoteWebPassword ? recordLoginFailure(req) : null;
        sendLoginFailure(req, res, next, retryAfterSeconds);
        return true;
      }

      clearLoginFailures(req);

      const headers = {
        "Set-Cookie": serializeCookie(WEB_AUTH_COOKIE, createWebAuthToken(), { maxAge: WEB_AUTH_MAX_AGE_SECONDS })
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

  getAuthSecret();

  return {
    isSameLocalOrigin,
    isSameTrustedNetworkOrigin,
    isTrustedNetworkAccess,
    requestCorsOrigin,
    requestAccess,
    requestAuthState,
    routeAuth,
    sendLoginRequired
  };
}
