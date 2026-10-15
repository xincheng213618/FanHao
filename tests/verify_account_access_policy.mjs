import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAccountStore } from "../src/platform/server/accounts/store.js";
import { createAuthServices } from "../src/platform/server/auth.js";
import { createRequestHandler } from "../src/platform/server/http-app.js";
import { readBodyText } from "../src/platform/server/request-io.js";
import { sendJson, sendHtml, sendText, redirect } from "../src/platform/server/responses.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-account-access-"));
const dbPath = path.join(root, "accounts.sqlite");
const password = "Account-policy-fixture-123";
const legacyPassword = "Legacy-policy-fixture-123";
let time = Date.now();
const auth = createAuthServices({ authSecretPath: path.join(root, "auth-secret.txt"), accountsDbPath: dbPath,
  remoteWebPassword: legacyPassword, ensureDataDir() {}, readBodyText, sendJson, sendHtml, redirect, now: () => time });

// Exercise the actual server helpers without importing server.js and starting real services.
const serverSource = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const helperStart = serverSource.indexOf("function requireTrustedNetworkPage(");
const helperEnd = serverSource.indexOf("async function routeApi(", helperStart);
assert(helperStart >= 0 && helperEnd > helperStart, "locate the production admin and file mutation helpers");
const gates = new Function("requestAuthState", "requestAccess", "isTrustedNetworkAccess", "isSameTrustedNetworkOrigin", "sendJson",
  `${serverSource.slice(helperStart, helperEnd)}; return {requireLocalAdmin, requireTrustedFileMutation};`)(
  auth.requestAuthState, auth.requestAccess, auth.isTrustedNetworkAccess, auth.isSameTrustedNetworkOrigin, sendJson);
let mediaReads = 0;
const app = createRequestHandler({ ...auth, attachAccessAnalytics() {}, attachAccessLogger() {},
  routeApi(req, res, url) {
    if (url.pathname === "/api/protected") { sendJson(res, 200, { ok: true }); return true; }
    if (url.pathname === "/api/admin/fixture" || url.pathname === "/api/delete/fixture") {
      const gate = url.pathname.includes("/admin/") ? gates.requireLocalAdmin : gates.requireTrustedFileMutation;
      if (gate(req, res)) sendJson(res, 200, { ok: true });
      return true;
    }
    if (url.pathname === "/api/android/update" && req.method === "GET") { sendJson(res, 200, { version: "fixture" }); return true; }
    if (url.pathname === "/api/android/update/apk/debug/fixture.apk" && ["GET", "HEAD"].includes(req.method)) {
      sendText(res, 200, "public fixture apk"); return true;
    }
    return false;
  },
  routeMedia(req, res, url) {
    if (url.pathname !== "/media/private-fixture.mp4") return false;
    mediaReads += 1;
    if (req.headers.range) { res.setHeader("Content-Range", "bytes 0-3/13"); sendText(res, 206, "priv"); }
    else sendText(res, 200, "private media");
    return true;
  },
  renderAndroidUpdatePage() { return "<!doctype html><title>Public Android update fixture</title>"; },
  serveStatic(_req, res, pathname) { sendText(res, 200, `protected static ${pathname}`); },
  sendJson, sendHtml, sendText });
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function api(route, { token, cookie, body, method = body ? "POST" : "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(base + route, { method, headers: { Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}), ...headers } }, (response) => {
      let text = ""; response.setEncoding("utf8"); response.on("data", (part) => { text += part; });
      response.on("end", () => {
        let payload; try { payload = JSON.parse(text); } catch { payload = null; }
        resolve({ status: response.statusCode, body: payload, text, headers: new Headers(response.headers) });
      });
    });
    request.on("error", reject); request.end(body ? JSON.stringify(body) : undefined);
  });
}
const account = (username) => ({ username, password, client: "android" });
const fake = ({ token, cookie, remote = "192.168.1.50", host = "192.168.1.20:29998", headers = {} } = {}) => ({
  method: "POST", url: "/api/protected", headers: { host, ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(cookie ? { cookie } : {}), ...headers }, socket: { remoteAddress: remote } });
const state = (options) => auth.requestAuthState(fake(options), new URL("http://fixture/api/protected"));
const gateResult = (gate, options) => {
  let status = 0;
  const allowed = gate(fake(options), { writeHead(value) { status = value; }, end() {} });
  return { allowed, status };
};
const knownFiles = ["accounts.sqlite", "accounts.sqlite-wal", "accounts.sqlite-shm", "auth-secret.txt",
  "migration.sqlite", "migration.sqlite-wal", "migration.sqlite-shm"];
let sideStore;
try {
  const defaults = (await api("/api/accounts/status")).body;
  assert.equal(defaults.accountLoginRequired, false);
  assert.equal(defaults.registrationEnabled, true); assert.equal(defaults.invitationRequired, false);
  assert.equal((await api("/api/protected")).status, 200, "default LAN compatibility remains enabled");
  assert.equal((await api("/media/private-fixture.mp4")).status, 200);
  const originalLegacy = await api("/auth/login", { body: { password: legacyPassword, client: "android" }, headers: { Host: "public.example" } });
  assert.equal(originalLegacy.status, 200); assert.match(originalLegacy.body.token, /^web\./);
  const legacyToken = originalLegacy.body.token;
  const legacyCookie = originalLegacy.headers.get("set-cookie").split(";", 1)[0];
  assert.equal((await api("/api/protected", { cookie: legacyCookie, headers: { Host: "public.example" } })).status, 200);
  const beforeLegacy = await api("/api/auth/status", { cookie: legacyCookie, headers: { Host: "public.example" } });
  assert.equal(beforeLegacy.body.reason, "password"); assert.equal(beforeLegacy.body.accountLoginRequired, false);
  const createdAdmin = await api("/api/accounts/setup", { body: account("policy-admin") });
  assert.equal(createdAdmin.status, 201); const admin = createdAdmin.body.token;
  const createdUser = await api("/api/accounts/register", { body: account("policy-reader") });
  assert.equal(createdUser.status, 201); let reader = createdUser.body.token;
  const userId = createdUser.body.user.id;
  const patch = (body, token = admin) => api("/api/accounts/admin/settings", { method: "PATCH", body, token });
  assert.equal((await api("/api/accounts/admin/settings")).status, 401);
  assert.equal((await api("/api/accounts/admin/settings", { token: reader })).status, 403);
  assert.equal((await patch({ accountLoginRequired: true }, reader)).status, 403);
  assert.equal((await patch({ accountLoginRequired: "true" })).status, 400);
  assert.equal((await patch({})).status, 400);
  assert.equal((await patch({ accountLoginRequired: true, invitationRequired: null })).status, 400);
  assert.equal((await patch({ accountLoginRequired: true }, legacyToken)).status, 401);
  const enabled = await patch({ accountLoginRequired: true });
  assert.equal(enabled.status, 200);
  assert.deepEqual(enabled.body, { registrationEnabled: true, invitationRequired: false, accountLoginRequired: true });
  assert.equal((await api("/api/accounts/admin/settings", { token: admin })).body.accountLoginRequired, true);
  // Clients from before this setting existed must not silently disable it when saving registration settings.
  const oldClientSave = await patch({ registrationEnabled: true, invitationRequired: false });
  assert.equal(oldClientSave.body.accountLoginRequired, true);
  assert.equal((await api("/api/accounts/status")).body.accountLoginRequired, true);
  for (const options of [{}, { cookie: legacyCookie }, { token: legacyToken }]) {
    for (const route of ["/api/protected", "/media/private-fixture.mp4", "/private/static.js"]) {
      const denied = await api(route, options);
      assert.equal(denied.status, 401, `${route}: strict mode rejects anonymous/legacy access`);
      assert.equal(denied.body.reason, "account-required"); assert.equal(denied.body.accountLoginRequired, true);
      assert.match(denied.body.loginUrl, /^\/login\?next=/);
    }
    const status = (await api("/api/auth/status", options)).body;
    assert.equal(status.authenticated, false); assert.equal(status.accountLoginRequired, true);
  }
  assert.equal(mediaReads, 1, "denied raw media is never dispatched to media handlers");
  const beforeRange = mediaReads;
  assert.equal((await api("/media/private-fixture.mp4", { headers: { Range: "bytes=0-3" } })).status, 401);
  assert.equal((await api("/media/private-fixture.mp4", { method: "HEAD" })).status, 401);
  assert.equal(mediaReads, beforeRange);
  const html = await api("/library?sort=recent", { headers: { Accept: "text/html" } });
  assert.equal(html.status, 303); assert.equal(html.headers.get("location"), "/login?next=%2Flibrary%3Fsort%3Drecent");
  for (const route of ["/account", "/register", "/login", "/account-assets/account-ui.js", "/account-assets/account.css", "/account-assets/web.js",
    "/android-update", "/api/android/update", "/api/android/update/apk/debug/fixture.apk"]) {
    assert.equal((await api(route)).status, 200, `${route}: public entry point survives strict mode`);
  }
  assert.equal((await api("/android-update", { method: "HEAD" })).status, 200);
  assert.equal((await api("/api/android/update/apk/debug/fixture.apk", { method: "HEAD" })).status, 200);
  assert.equal((await api("/api/android/update/apk/debug/unlisted.apk")).status, 404);
  for (const route of ["/api/android/update", "/android-update", "/api/android/update/apk/debug/fixture.apk"]) {
    assert.equal((await api(route, { method: "POST", body: {} })).status, 401, "update write routes stay protected");
  }
  const legacyDenied = await api("/auth/login", { body: { password: legacyPassword, client: "android" } });
  assert.equal(legacyDenied.status, 403); assert.equal(legacyDenied.body.reason, "account-required");
  assert.equal(legacyDenied.body.accountLoginRequired, true); assert.equal(legacyDenied.headers.get("set-cookie"), null);
  assert.equal(legacyDenied.headers.get("cache-control"), "no-store");
  const legacyHtml = await api("/auth/login?next=%2Fmedia", { body: { password: legacyPassword }, headers: { Accept: "text/html" } });
  assert.equal(legacyHtml.status, 303); assert.equal(legacyHtml.headers.get("location"), "/login?next=%2Fmedia");
  assert.equal(legacyHtml.headers.get("set-cookie"), null);
  const newUser = await api("/api/accounts/register", { body: account("strict-new-user"), headers: { Host: "public.example", Origin: "https://localhost", "X-FanHao-Client": "android" } });
  assert.equal(newUser.status, 201, "strict mode keeps optional invitation registration and packaged client CORS available");
  for (const options of [{ token: reader }, { cookie: `fanhao_web_auth=${reader}` }, { token: admin }]) {
    assert.equal((await api("/api/protected", options)).status, 200);
    assert.equal((await api("/media/private-fixture.mp4", options)).status, 200);
    const status = (await api("/api/auth/status", options)).body;
    assert.equal(status.accountLoginRequired, true); assert.equal(status.reason, "account"); assert.equal(status.authenticated, true);
  }
  assert.equal((await api("/media/private-fixture.mp4", { token: reader, headers: { Range: "bytes=0-3" } })).status, 206);
  await verifyAppProxyBoundary(admin, reader, "strict mode");
  for (const route of ["/api/admin/fixture", "/api/delete/fixture"]) {
    assert.equal((await api(route, { token: reader, method: "POST", body: {} })).status, 403);
    assert.equal((await api(route, { token: admin, method: "POST", body: {} })).status, 200);
  }
  for (const remote of ["127.0.0.1", "192.168.1.50", "203.0.113.1"]) {
    const host = remote === "127.0.0.1" ? "localhost" : remote.startsWith("192") ? "192.168.1.20" : "public.example";
    for (const headers of [{}, { "x-fanhao-client": "android", "user-agent": "FanHaoAndroidApp/1.0", "x-forwarded-for": "127.0.0.1" }]) {
      assert.equal(state({ remote, host, headers }).allowed, false, "socket trust and Android markers never bypass strict mode");
    }
    assert.equal(state({ remote, host, token: reader }).allowed, true);
    assert.equal(state({ remote, host, cookie: legacyCookie }).allowed, false);
  }
  for (const gate of [gates.requireLocalAdmin, gates.requireTrustedFileMutation]) {
    assert.deepEqual(gateResult(gate), { allowed: false, status: 403 }, "helper itself must reject strict anonymous LAN calls");
    assert.equal(gateResult(gate, { token: legacyToken }).allowed, false);
    assert.equal(gateResult(gate, { token: reader }).allowed, false);
    assert.equal(gateResult(gate, { token: admin }).allowed, true);
    assert.equal(gateResult(gate, { token: admin, remote: "203.0.113.1", host: "public.example" }).allowed, false,
      "an account admin still cannot remotely perform LAN-only administration");
    assert.equal(gateResult(gate, { token: admin, headers: { origin: "https://evil.example" } }).allowed, false);
  }
  // Disabled and expired credentials must not become anonymous LAN visitors.
  assert.equal((await api(`/api/accounts/admin/users/${userId}`, { token: admin, method: "PATCH", body: { disabled: true } })).status, 200);
  assert.equal((await api("/api/protected", { token: reader })).status, 401);
  assert.equal((await api("/api/auth/status", { token: reader })).body.reason, "expired-account");
  assert.equal((await api(`/api/accounts/admin/users/${userId}`, { token: admin, method: "PATCH", body: { disabled: false } })).status, 200);
  const renewed = await api("/api/accounts/login", { body: account("policy-reader") });
  assert.equal(renewed.status, 200); const revoked = reader; reader = renewed.body.token;
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("UPDATE account_sessions SET expires_at=? WHERE user_id=?").run(time - 1, userId);
    assert.equal((await api("/api/protected", { token: reader })).status, 401);
    assert.equal((await api("/api/auth/status", { token: reader })).body.accountLoginRequired, true);
    const accessAudit = db.prepare("SELECT * FROM account_audit WHERE action='access.changed'").all();
    assert.equal(accessAudit.length, 1); assert.equal(accessAudit[0].actor_username, "policy-admin");
    assert.match(accessAudit[0].summary, /必须登录用户账号：是/);
    // A failed audit insert must roll the policy back with no permissive cache residue.
    db.exec("CREATE TRIGGER reject_access_audit BEFORE INSERT ON account_audit WHEN NEW.action='access.changed' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END;");
    sideStore = createAccountStore({ dbPath, now: () => time });
    assert.throws(() => sideStore.updateSettings({ accountLoginRequired: false }, createdAdmin.body.user.id), /fixture audit failure/);
    assert.equal((await api("/api/protected")).status, 401);
    assert.equal((await api("/api/accounts/status")).body.accountLoginRequired, true);
    db.exec("DROP TRIGGER reject_access_audit");
    sideStore.close(); sideStore = null;
  } finally { db.close(); }
  const disabled = await patch({ accountLoginRequired: false });
  assert.equal(disabled.status, 200); assert.equal(disabled.body.accountLoginRequired, false);
  assert.equal((await api("/api/protected")).status, 200);
  assert.equal((await api("/api/protected", { cookie: legacyCookie, headers: { Host: "public.example" } })).status, 200);
  assert.equal((await api("/auth/login", { body: { password: legacyPassword } })).status, 200);
  assert.equal((await api("/api/protected", { token: revoked })).status, 401, "turning compatibility back on does not revive revoked accounts");
  assert.equal(state({}).allowed, true); assert.equal(state({}).accountLoginRequired, false);
  for (const gate of [gates.requireLocalAdmin, gates.requireTrustedFileMutation]) assert.equal(gateResult(gate).allowed, true);
  await verifyAppProxyBoundary(admin, newUser.body.token, "compatibility mode");

  // Cross-process store reads observe the committed switch, and a reopen preserves it.
  await patch({ accountLoginRequired: true });
  auth.closeAccounts();
  assert.equal((await api("/api/protected")).status, 401);
  assert.equal((await api("/api/accounts/status")).body.accountLoginRequired, true);
  await patch({ accountLoginRequired: false });

  // Finish a legacy login body only after strict mode is enabled: no old session may be issued.
  const delayedLogin = await startDelayedLegacyLogin();
  await patch({ accountLoginRequired: true });
  delayedLogin.finish();
  const raced = await delayedLogin.result;
  assert.equal(raced.status, 403); assert.equal(JSON.parse(raced.text).reason, "account-required");
  assert.equal(raced.headers["set-cookie"], undefined);
  verifyMigration();
  console.log("account-access-policy: ok (HTTP access/media/public routes, LAN/admin helpers, legacy login race, partial settings, audit rollback and v3 migration)");
} finally {
  sideStore?.close();
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  auth.closeAccounts();
  for (const name of knownFiles) { const file = path.join(root, name); if (fs.existsSync(file)) fs.unlinkSync(file); }
  fs.rmdirSync(root);
}

async function startDelayedLegacyLogin() {
  const body = JSON.stringify({ password: legacyPassword, client: "android" });
  let request;
  const result = new Promise((resolve, reject) => {
    request = http.request(base + "/auth/login", { method: "POST", headers: { Accept: "application/json",
      "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (response) => {
      let text = ""; response.setEncoding("utf8"); response.on("data", (part) => { text += part; });
      response.on("end", () => resolve({ status: response.statusCode, text, headers: response.headers }));
    });
    request.on("error", reject);
  });
  // Receiving this header in the server confirms routeAuth can begin awaiting the incomplete body.
  await new Promise((resolve) => {
    server.once("request", () => setImmediate(resolve));
    request.write(body.slice(0, -1));
  });
  return { result, finish() { request.end(body.slice(-1)); } };
}

async function verifyAppProxyBoundary(admin, reader, mode) {
  const appHeaders = { origin: "https://localhost", "x-fanhao-client": "android" };
  for (const remote of ["127.0.0.1", "192.168.1.50"]) {
    for (const gate of [gates.requireLocalAdmin, gates.requireTrustedFileMutation]) {
      assert.equal(gateResult(gate, { token: admin, remote, host: "public.example", headers: appHeaders }).allowed, false,
        `${mode}: a public reverse proxy Host must not grant LAN administration through Android origin`);
      assert.equal(gateResult(gate, { token: admin, remote, host: "192.168.1.20:29998", headers: appHeaders }).allowed, true,
        `${mode}: an authenticated admin keeps direct LAN app administration`);
    }
  }
  const headers = { Host: "public.example", Origin: appHeaders.origin, "X-FanHao-Client": "android" };
  for (const route of ["/api/admin/fixture", "/api/delete/fixture"]) {
    assert.equal((await api(route, { token: admin, method: "POST", body: {}, headers })).status, 403,
      `${mode}: real HTTP rejects public-host Android administration`);
  }
  const login = await api("/api/accounts/login", { body: account("strict-new-user"), headers });
  assert.equal(login.status, 200, `${mode}: public-host Android account login stays available`);
  assert.match(login.body.token, /^usr\./);
  assert.equal(login.headers.get("access-control-allow-origin"), "https://localhost");
  for (const route of ["/api/protected", "/media/private-fixture.mp4"]) {
    const response = await api(route, { token: reader, headers });
    assert.equal(response.status, 200, `${mode}: public-host Android content access stays available`);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://localhost");
  }
}

function verifyMigration() {
  const migrationPath = path.join(root, "migration.sqlite");
  const old = new DatabaseSync(migrationPath);
  const oldToken = `usr.${Math.floor(time / 1000)}.${crypto.randomBytes(32).toString("base64url")}`;
  const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
  const createdAt = new Date(time).toISOString();
  try {
    old.exec(`CREATE TABLE account_users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,role TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,last_login_at TEXT);
      CREATE TABLE account_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES account_users(id),
      created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,id TEXT,client_type TEXT NOT NULL DEFAULT 'unknown',
      device_label TEXT NOT NULL DEFAULT '先前登录的设备',last_seen_at INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX account_sessions_id ON account_sessions(id);
      CREATE TABLE account_invites(id TEXT PRIMARY KEY,code_hash TEXT NOT NULL UNIQUE,suffix TEXT NOT NULL,created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,expires_at INTEGER NOT NULL,max_uses INTEGER NOT NULL,uses INTEGER NOT NULL,disabled INTEGER NOT NULL,note TEXT NOT NULL);
      CREATE TABLE account_redemptions(user_id TEXT PRIMARY KEY,invite_id TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE account_password_resets(user_id TEXT PRIMARY KEY,code_hash TEXT NOT NULL UNIQUE,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE account_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,action TEXT NOT NULL,actor_username TEXT NOT NULL,target_username TEXT NOT NULL,summary TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE account_settings(id INTEGER PRIMARY KEY CHECK(id=1),registration_enabled INTEGER NOT NULL,invitation_required INTEGER NOT NULL);
      INSERT INTO account_settings VALUES(1,0,1); PRAGMA user_version=3;`);
    old.prepare("INSERT INTO account_users VALUES(?,?,?,?,?,?,?,?)").run("admin-before", "existing-admin", "原有用户", "existing-scrypt-password-hash", "admin", 0, createdAt, createdAt);
    old.prepare("INSERT INTO account_sessions VALUES(?,?,?,?,?,?,?,?)").run(hash(oldToken), "admin-before", time, time + 60000, "session-before", "android", "Android App", time);
    old.prepare("INSERT INTO account_invites VALUES(?,?,?,?,?,?,?,?,?,?)").run("invite-before", hash("invite"), "ABC123", "admin-before", createdAt, time + 60000, 5, 1, 0, "existing note");
    old.prepare("INSERT INTO account_redemptions VALUES(?,?,?)").run("admin-before", "invite-before", createdAt);
    old.prepare("INSERT INTO account_password_resets VALUES(?,?,?,?,?)").run("admin-before", hash("reset"), "admin-before", time, time + 60000);
    old.prepare("INSERT INTO account_audit(action,actor_username,target_username,summary,created_at) VALUES(?,?,?,?,?)").run("account.created", "existing-admin", "existing-admin", "existing audit", time);
  } finally { old.close(); }
  const tables = ["account_users", "account_sessions", "account_invites", "account_redemptions", "account_password_resets", "account_audit"];
  const snapshot = () => {
    const db = new DatabaseSync(migrationPath);
    try { return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()])); }
    finally { db.close(); }
  };
  const before = snapshot();
  const migrated = createAccountStore({ dbPath: migrationPath, now: () => time });
  try {
    assert.deepEqual(migrated.settings(), { registrationEnabled: false, invitationRequired: true, accountLoginRequired: false });
    assert.equal(migrated.session(oldToken).username, "existing-admin");
    assert.deepEqual(snapshot(), before, "v3 migration preserves users, hashes, sessions, invitations, recovery codes and audit records");
    const check = new DatabaseSync(migrationPath);
    try { assert.equal(check.prepare("PRAGMA user_version").get().user_version, 4); }
    finally { check.close(); }
  } finally { migrated.close(); }
}
