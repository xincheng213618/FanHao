import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAccountFixture } from "./fixtures/account-service.mjs";
import { createAccountStore } from "../src/platform/server/accounts/store.js";

let time = Date.now();
const fixture = createAccountFixture({ now: () => time });
const base = await fixture.listen();
const password = "Session-fixture-123";
async function api(route, { token, body, method = body ? "POST" : "GET", headers = {} } = {}) {
  const response = await fetch(base + route, { method, headers: { Accept: "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json();
  return { status: response.status, body: payload, cookie: response.headers.get("set-cookie"), cache: response.headers.get("cache-control") };
}
async function login(username, client = "android", headers = {}) {
  const response = await api("/api/accounts/login", { body: { username, password, client }, headers });
  assert.equal(response.status, 200);
  return response.body.token || decodeURIComponent(/fanhao_web_auth=([^;]+)/.exec(response.cookie)[1]);
}
try {
  const alice = await api("/api/accounts/register", { body: { username: "device-alice", password, client: "android" } });
  assert.equal(alice.status, 201); const current = alice.body.token;
  const initial = await api("/api/accounts/sessions", { token: current });
  assert.equal(initial.status, 200, "signed-in users need an active-device list");
  assert.equal(initial.cache, "no-store");
  assert.equal(initial.body.sessions.length, 1); assert.equal(initial.body.sessions[0].current, true);
  assert.equal(initial.body.sessions[0].clientType, "android");
  const currentId = initial.body.sessions[0].id;
  assert.match(currentId, /^[a-f0-9-]{36}$/); assert(!JSON.stringify(initial.body).includes(current));
  assert(!JSON.stringify(initial.body).includes("token_hash"));
  time += 60000;
  const web = await login("device-alice", "web", { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0" });
  time += 60000;
  const other = await login("device-alice");
  const listing = (await api("/api/accounts/sessions", { token: current })).body.sessions;
  assert.equal(listing.length, 3); assert.equal(listing[0].id, currentId, "current device stays first");
  assert.equal(listing.filter((session) => session.current).length, 1);
  const webSession = listing.find((session) => session.clientType === "web");
  assert.match(webSession.deviceLabel, /Chrome.*Windows/);
  const intruder = await api("/api/accounts/register", { body: { username: "device-bob", password, client: "android" } });
  assert.equal((await api("/api/accounts/sessions")).status, 401);
  const foreign = await api(`/api/accounts/sessions/${webSession.id}/revoke`, { token: intruder.body.token, body: {} });
  assert.equal(foreign.status, 404, "another user cannot revoke or inspect a device");
  assert.equal((await api("/api/accounts/status", { token: web })).body.user.username, "device-alice");
  assert.equal((await api(`/api/accounts/sessions/${webSession.id}/revoke`, { token: current, body: {}, headers: { Origin: "https://evil.example" } })).status, 403);
  const removed = await api(`/api/accounts/sessions/${webSession.id}/revoke`, { token: current, body: {} });
  assert.equal(removed.status, 200); assert.equal(removed.body.current, false); assert.equal(removed.cookie, null);
  assert.equal((await api("/api/protected", { token: web })).status, 401);
  assert.equal((await api(`/api/accounts/sessions/${webSession.id}/revoke`, { token: current, body: {} })).status, 404);
  const others = await api("/api/accounts/sessions/revoke-others", { token: current, body: {} });
  assert.equal(others.body.revoked, 1);
  assert.equal((await api("/api/protected", { token: other })).status, 401);
  assert.equal((await api("/api/accounts/sessions", { token: current })).body.sessions.length, 1);
  assert.equal((await api("/api/accounts/sessions/revoke-others", { token: current, body: {} })).body.revoked, 0);

  const db = new DatabaseSync(fixture.dbPath);
  try {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 4);
    const seen = () => db.prepare("SELECT last_seen_at FROM account_sessions WHERE id=?").get(currentId).last_seen_at;
    const before = seen();
    await api("/api/accounts/status", { token: current }); assert.equal(seen(), before, "activity writes are coalesced");
    time += 300001;
    db.exec("BEGIN IMMEDIATE");
    const started = performance.now();
    const locked = await api("/api/accounts/status", { token: current });
    assert.equal(locked.body.user.username, "device-alice", "telemetry contention must not block authentication");
    assert(performance.now() - started < 1500, "a busy activity write must not stall a media request for SQLite's 3-second busy timeout");
    db.exec("ROLLBACK");
    await api("/api/accounts/status", { token: current }); assert.equal(seen(), time);
  } finally { if (db.isTransaction) db.exec("ROLLBACK"); db.close(); }
  verifyPreparedAccountReads(await login("device-alice"), current);
  const self = await api(`/api/accounts/sessions/${currentId}/revoke`, { token: current, body: {} });
  assert.equal(self.body.current, true); assert.match(self.cookie, /Max-Age=0/);
  assert.equal((await api("/api/accounts/sessions", { token: current })).status, 401);

  const store = createAccountStore({ dbPath: fixture.dbPath, now: () => time });
  try {
    const sessions = [];
    for (let index = 0; index < 22; index++) { time += 1000; sessions.push(await store.login({ username: "device-alice", password })); }
    const newest = sessions.at(-1);
    assert.equal(store.listSessions(newest.user.id, newest.token).sessions.length, 20);
    assert.equal(store.session(sessions[0].token), null); assert.equal(store.session(sessions[1].token), null);
    time += 31 * 86400000;
    assert.equal(store.session(newest.token), null);
  } finally { store.close(); }
  await verifyMigration();
  console.log("account-sessions: ok (own-device scope, revocation, current-session clearing, activity contention/coalescing, live prepared reads, reopen, cap, expiry, v1 migration)");
} finally { await fixture.close(); }

function verifyPreparedAccountReads(token, stillActiveToken) {
  let observedTime = time;
  const store = createAccountStore({ dbPath: fixture.dbPath, now: () => observedTime });
  const side = new DatabaseSync(fixture.dbPath);
  const nativePrepare = DatabaseSync.prototype.prepare;
  const reads = new Map();
  DatabaseSync.prototype.prepare = function prepare(sql) {
    const statement = nativePrepare.call(this, sql);
    const key = sql.includes("SELECT * FROM account_settings WHERE id=1") ? "settings"
      : sql.includes("s.last_seen_at FROM account_sessions") ? "session" : null;
    if (!key) return statement;
    if (!reads.has(this)) reads.set(this, {
      settings: { prepared: 0, executed: 0 }, session: { prepared: 0, executed: 0 }
    });
    const counts = reads.get(this)[key];
    counts.prepared += 1;
    return { get(...args) { counts.executed += 1; return statement.get(...args); } };
  };
  try {
    const initial = store.session(token);
    assert.equal(initial.username, "device-alice");
    for (let index = 0; index < 3; index += 1) {
      assert.equal(store.settings().accountLoginRequired, false);
      assert.deepEqual(store.session(token), initial);
    }
    assert.equal(store.session("invalid"), null);
    assert.equal(reads.size, 1);
    const [connection] = reads.keys();
    assert.deepEqual(reads.get(connection), {
      settings: { prepared: 1, executed: 3 }, session: { prepared: 1, executed: 4 }
    }, "warm calls reuse only SQLite statements and still execute every valid read");

    side.exec("UPDATE account_settings SET account_login_required=1 WHERE id=1");
    assert.equal(store.settings().accountLoginRequired, true, "a warm policy read sees a committed write on another connection");
    side.prepare("UPDATE account_users SET disabled=1 WHERE id=?").run(initial.id);
    assert.equal(store.session(token), null, "a warm session read sees an externally disabled user");
    side.prepare("UPDATE account_users SET disabled=0 WHERE id=?").run(initial.id);
    assert.deepEqual(store.session(token), initial);

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const seen = () => side.prepare("SELECT last_seen_at FROM account_sessions WHERE token_hash=?").get(tokenHash).last_seen_at;
    const before = seen();
    observedTime += 300001;
    side.exec("BEGIN IMMEDIATE");
    assert.deepEqual(store.session(token), initial, "writer contention still permits a prepared authentication read");
    assert.equal(seen(), before, "busy telemetry is skipped");
    assert.equal(connection.prepare("PRAGMA busy_timeout").get().timeout, 3000, "restore the connection's write timeout after contention");
    side.exec("ROLLBACK");
    assert.deepEqual(store.session(token), initial);
    assert.equal(seen(), observedTime, "next authentication retries telemetry after writer release");
    side.prepare("DELETE FROM account_sessions WHERE token_hash=?").run(tokenHash);
    assert.equal(store.session(token), null, "a warm session read sees a committed revocation on another connection");
    assert.deepEqual(reads.get(connection), {
      settings: { prepared: 1, executed: 4 }, session: { prepared: 1, executed: 9 }
    });

    store.close();
    assert.equal(connection.isOpen, false);
    assert.equal(store.settings().accountLoginRequired, true);
    assert.equal(store.session(token), null);
    assert.equal(store.session(stillActiveToken).id, initial.id);
    assert.equal(reads.size, 2);
    const reopened = [...reads.keys()][1];
    assert.deepEqual(reads.get(reopened), {
      settings: { prepared: 1, executed: 1 }, session: { prepared: 1, executed: 2 }
    }, "reopening the same store prepares new statements on the new connection");
    side.exec("UPDATE account_settings SET account_login_required=0 WHERE id=1");
  } finally {
    DatabaseSync.prototype.prepare = nativePrepare;
    store.close();
    if (side.isTransaction) side.exec("ROLLBACK");
    side.close();
  }
}

async function verifyMigration() {
  const legacyPath = path.join(fixture.root, "legacy-accounts.sqlite");
  const legacyToken = `usr.${Math.floor(time / 1000)}.${crypto.randomBytes(32).toString("base64url")}`;
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`CREATE TABLE account_users (id TEXT PRIMARY KEY,username TEXT UNIQUE,display_name TEXT,password_hash TEXT,role TEXT,disabled INTEGER,created_at TEXT,last_login_at TEXT);
    CREATE TABLE account_sessions (token_hash TEXT PRIMARY KEY,user_id TEXT,created_at INTEGER,expires_at INTEGER);
    CREATE TABLE account_settings (id INTEGER PRIMARY KEY,registration_enabled INTEGER,invitation_required INTEGER);
    INSERT INTO account_settings VALUES(1,1,0); PRAGMA user_version=1;`);
  legacy.prepare("INSERT INTO account_users VALUES(?,?,?,?,?,?,?,?)").run("legacy-user", "legacy", "Existing user", "unchanged-fixture-hash", "user", 0, new Date(time).toISOString(), null);
  legacy.prepare("INSERT INTO account_sessions VALUES(?,?,?,?)").run(crypto.createHash("sha256").update(legacyToken).digest("hex"), "legacy-user", time, time + 86400000);
  legacy.close();
  let store = createAccountStore({ dbPath: legacyPath, now: () => time });
  try {
    assert.equal(store.session(legacyToken).id, "legacy-user");
    const row = store.listSessions("legacy-user", legacyToken).sessions[0];
    assert.equal(row.deviceLabel, "先前登录的设备"); assert.equal(row.lastSeenAt, time); assert.equal(row.current, true);
    assert.equal(store.settings().invitationRequired, false);
    store.close(); store = createAccountStore({ dbPath: legacyPath, now: () => time });
    assert.equal(store.listSessions("legacy-user", legacyToken).sessions[0].id, row.id, "migration must not change device ids on reopen");
    const reader = new DatabaseSync(legacyPath, { readOnly: true });
    try { assert.equal(reader.prepare("SELECT password_hash FROM account_users").get().password_hash, "unchanged-fixture-hash"); } finally { reader.close(); }
  } finally {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(legacyPath + suffix)) fs.unlinkSync(legacyPath + suffix);
  }
}
