import fs from "node:fs";
import { createAccountStore, accountError, SESSION_SECONDS } from "./store.js";

const ASSETS = new Map(["account-ui.js", "account.css", "web.js", "session-context.js"].map((name) => [
  `/account-assets/${name}`, new URL(`../../../../public/platform/accounts/${name}`, import.meta.url)
]));
function sessionMetadata(req, payload) {
  // Device descriptions are display hints only. Never use client markers for authorization.
  if (payload.client === "android") return { clientType: "android", deviceLabel: "Android App" };
  const agent = String(req.headers["user-agent"] || "").slice(0, 512);
  const browser = /Edg(?:e|A|iOS)?\//i.test(agent) ? "Edge" : /(?:Chrome|CriOS)\//i.test(agent) ? "Chrome"
    : /(?:Firefox|FxiOS)\//i.test(agent) ? "Firefox" : /Safari\//i.test(agent) ? "Safari" : "网页浏览器";
  const platform = /Android/i.test(agent) ? "Android" : /iPhone|iPad|iPod/i.test(agent) ? "iOS"
    : /Windows/i.test(agent) ? "Windows" : /Macintosh|Mac OS/i.test(agent) ? "macOS" : /Linux/i.test(agent) ? "Linux" : "";
  return { clientType: "web", deviceLabel: [browser, platform].filter(Boolean).join(" · ") };
}
export function accountPageHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <meta name="theme-color" content="#1f7a62"><title>用户中心 · FanHao</title>
    <link rel="stylesheet" href="/account-assets/account.css"></head>
    <body class="account-page"><header class="account-topbar"><a href="/" class="account-brand">FH <span>FanHao</span></a>
    <a href="/">返回资料库 ↗</a></header><main class="account-layout">
    <aside class="account-intro"><span class="account-eyebrow">YOUR LIBRARY, CONNECTED</span><h1>一个账号，<br>连接你的资料库。</h1>
    <p>在网页与安卓端使用同一账号。管理个人资料，也让每一次邀请都有迹可循。</p>
    <div class="account-intro-foot">FanHao · 用户中心</div></aside>
    <div id="accountRoot" class="account-ui"><p role="status">正在读取账号状态…</p></div>
    </main><noscript>请启用 JavaScript 使用用户中心。</noscript><script type="module" src="/account-assets/web.js"></script></body></html>`;
}

export function createAccountServices({ dbPath, now = Date.now, readBodyText, sendJson, sendHtml, requestAccess, requestCorsOrigin }) {
  const store = createAccountStore({ dbPath, now });
  const attempts = new Map();
  function token(req) {
    const authorization = String(req.headers.authorization || "");
    if (authorization) return /^Bearer ([A-Za-z0-9._-]+)$/.exec(authorization)?.[1] || "invalid";
    const cookie = /(?:^|;\s*)fanhao_web_auth=([^;]*)/.exec(String(req.headers.cookie || ""))?.[1] || "";
    try { return decodeURIComponent(cookie); } catch { return "invalid"; }
  }
  function user(req) { return store.session(token(req)); }
  function canSetup(req) {
    const access = requestAccess(req);
    return access.clientIsLocal && access.hostIsLocal && !req.headers["x-forwarded-for"] && !req.headers.forwarded
      && (!req.headers.origin || (requestCorsOrigin(req) && new URL(req.headers.origin).host.toLowerCase() === String(req.headers.host).toLowerCase()));
  }
  function checkOrigin(req) {
    if (req.headers["sec-fetch-site"] === "cross-site" && !req.headers.origin) throw accountError(403, "不允许该跨源访问");
    if (req.headers.origin && !requestCorsOrigin(req)) throw accountError(403, "不允许该跨源访问");
  }
  function limit(req, purpose) {
    const timestamp = Number(now());
    for (const [key, value] of attempts) if (value.until <= timestamp) attempts.delete(key);
    const key = `${purpose}:${requestAccess(req).clientAddress}`;
    const max = purpose === "register" ? 10 : 20;
    const windowMs = purpose === "register" ? 3600000 : 900000;
    let entry = attempts.get(key);
    if (!entry) {
      if (attempts.size >= 4096) throw accountError(429, "请求过多，请稍后重试");
      entry = { count: 0, until: timestamp + windowMs }; attempts.set(key, entry);
    }
    if (++entry.count > max) throw Object.assign(accountError(429, "尝试次数过多，请稍后再试"), { retryAfter: Math.ceil((entry.until - timestamp) / 1000) });
  }
  function requireUser(req, admin = false) {
    const actor = user(req);
    if (!actor) throw accountError(401, "请先登录用户账号");
    if (admin && actor.role !== "admin") throw accountError(403, "需要管理员权限");
    return actor;
  }
  async function body(req) {
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) throw accountError(415, "请使用 JSON 提交");
    let value;
    try { value = JSON.parse(await readBodyText(req, 16 * 1024)); }
    catch (error) { if (error.statusCode) throw error; throw accountError(400, "JSON 格式无效"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw accountError(400, "请求内容必须是对象");
    return value;
  }
  function cookie(req, value, expires = SESSION_SECONDS) {
    return `fanhao_web_auth=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${expires}${req.socket.encrypted ? "; Secure" : ""}`;
  }
  function signedIn(req, res, result, payload, status = 200) {
    store.revoke(token(req));
    res.setHeader("Set-Cookie", cookie(req, result.token));
    sendJson(res, status, { ok: true, user: result.user, ...(payload.client === "android" ? { token: result.token, expiresIn: result.expiresIn } : {}) });
  }
  async function route(req, res, url) {
    const pathname = url.pathname;
    if (["/account", "/register", "/login"].includes(pathname) && ["GET", "HEAD"].includes(req.method)) {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      res.setHeader("Referrer-Policy", "no-referrer");
      sendHtml(res, 200, req.method === "HEAD" ? "" : accountPageHtml()); return true;
    }
    if (ASSETS.has(pathname) && ["GET", "HEAD"].includes(req.method)) {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.writeHead(200, { "Content-Type": pathname.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" });
      res.end(req.method === "HEAD" ? undefined : fs.readFileSync(ASSETS.get(pathname))); return true;
    }
    if (!pathname.startsWith("/api/accounts/")) return false;
    res.setHeader("Cache-Control", "no-store");
    try {
      checkOrigin(req);
      const expectedOwner = req.headers["x-fanhao-account-owner"];
      const publicIdentityRoute = ["/api/accounts/status", "/api/accounts/login", "/api/accounts/register", "/api/accounts/setup", "/api/accounts/password/reset"].includes(pathname);
      if (expectedOwner !== undefined && !publicIdentityRoute) {
        const actor = user(req);
        const actualOwner = actor ? `account:${actor.id}` : "guest";
        if (!actor && String(expectedOwner).startsWith("account:")) throw accountError(401, "请重新登录用户账号");
        if (expectedOwner !== actualOwner) throw Object.assign(accountError(409, "账号已切换，请刷新后重试"), { code: "ACCOUNT_CHANGED" });
      }
      if (pathname === "/api/accounts/status" && req.method === "GET") {
        sendJson(res, 200, { user: user(req), ...store.settings(), setupAvailable: canSetup(req) && !store.hasAdmin() }); return true;
      }
      if (pathname === "/api/accounts/password/reset" && req.method === "POST") {
        limit(req, "password-reset");
        const payload = await body(req);
        const current = user(req);
        const result = await store.resetPassword(payload);
        if (current?.id === result.userId) res.setHeader("Set-Cookie", cookie(req, "", 0));
        sendJson(res, 200, { ok: true }); return true;
      }
      if (["/api/accounts/register", "/api/accounts/login", "/api/accounts/setup"].includes(pathname) && req.method === "POST") {
        const setup = pathname.endsWith("/setup");
        if (setup && !canSetup(req)) throw accountError(403, "请在服务所在电脑通过 localhost 初始化管理员");
        const isLogin = pathname.endsWith("/login");
        limit(req, isLogin ? "login" : "register");
        const payload = await body(req);
        const metadata = sessionMetadata(req, payload);
        const result = isLogin ? await store.login(payload, metadata) : await store.register(payload, { setup, sessionMetadata: metadata });
        signedIn(req, res, result, payload, isLogin ? 200 : 201); return true;
      }
      if (pathname === "/api/accounts/logout" && req.method === "POST") {
        await body(req); store.revoke(token(req));
        res.setHeader("Set-Cookie", cookie(req, "", 0)); sendJson(res, 200, { ok: true }); return true;
      }
      const isAdmin = pathname.startsWith("/api/accounts/admin/");
      requireUser(req, isAdmin);
      const payload = ["POST", "PATCH"].includes(req.method) ? await body(req) : {};
      const actor = requireUser(req, isAdmin);
      const query = Object.fromEntries(url.searchParams);
      if (pathname === "/api/accounts/me" && req.method === "PATCH") {
        sendJson(res, 200, { user: store.updateProfile(actor.id, payload) });
      } else if (pathname === "/api/accounts/sessions" && req.method === "GET") {
        sendJson(res, 200, store.listSessions(actor.id, token(req)));
      } else if (pathname === "/api/accounts/sessions/revoke-others" && req.method === "POST") {
        sendJson(res, 200, { ok: true, ...store.revokeOtherSessions(actor.id, token(req)) });
      } else if (/^\/api\/accounts\/sessions\/[^/]+\/revoke$/.test(pathname) && req.method === "POST") {
        const result = store.revokeSession(actor.id, pathname.split("/").at(-2), token(req));
        if (result.current) res.setHeader("Set-Cookie", cookie(req, "", 0));
        sendJson(res, 200, { ok: true, ...result });
      } else if (pathname === "/api/accounts/password" && req.method === "POST") {
        limit(req, "password"); await store.changePassword(actor.id, payload);
        res.setHeader("Set-Cookie", cookie(req, "", 0)); sendJson(res, 200, { ok: true });
      } else if (pathname === "/api/accounts/admin/settings" && req.method === "GET") {
        sendJson(res, 200, store.settings());
      } else if (pathname === "/api/accounts/admin/settings" && req.method === "PATCH") {
        sendJson(res, 200, store.updateSettings(payload, actor.id));
      } else if (pathname === "/api/accounts/admin/audit" && req.method === "GET") {
        sendJson(res, 200, store.listAudit(query));
      } else if (/^\/api\/accounts\/admin\/users\/[^/]+\/password-reset$/.test(pathname) && req.method === "POST") {
        limit(req, "password-reset-issue");
        sendJson(res, 201, { reset: await store.createPasswordReset(actor.id, pathname.split("/").at(-2), payload.currentPassword, token(req)) });
      } else if (pathname === "/api/accounts/admin/users" && req.method === "GET") {
        sendJson(res, 200, store.listUsers(query));
      } else if (/^\/api\/accounts\/admin\/users\/[^/]+$/.test(pathname) && req.method === "PATCH") {
        sendJson(res, 200, { user: store.updateUser(pathname.split("/").at(-1), payload, actor.id) });
      } else if (pathname === "/api/accounts/admin/invites" && req.method === "GET") {
        sendJson(res, 200, store.listInvites(query));
      } else if (pathname === "/api/accounts/admin/invites" && req.method === "POST") {
        sendJson(res, 201, { invites: store.createInvites(actor.id, payload) });
      } else if (/^\/api\/accounts\/admin\/invites\/[^/]+$/.test(pathname) && req.method === "GET") {
        sendJson(res, 200, store.inviteDetails(pathname.split("/").at(-1), query));
      } else if (/^\/api\/accounts\/admin\/invites\/[^/]+\/revoke$/.test(pathname) && req.method === "POST") {
        store.disableInvite(pathname.split("/").at(-2), actor.id); sendJson(res, 200, { ok: true });
      } else throw accountError(404, "接口不存在");
    } catch (error) {
      if (!error.statusCode || error.statusCode >= 500) throw error;
      if (error.retryAfter) res.setHeader("Retry-After", String(error.retryAfter));
      sendJson(res, error.statusCode, { error: error.message, ...(error.code === "ACCOUNT_CHANGED" ? { code: error.code } : {}) });
    }
    return true;
  }
  return { route, user, token, settings: store.settings, revoke: store.revoke, close: store.close };
}
