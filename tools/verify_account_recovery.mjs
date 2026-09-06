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
const store = createAccountStore({ dbPath: fixture.dbPath, now: () => time });
const password = "Recovery-fixture-123", newPassword = "Recovered-password-456";
const secrets = [password, newPassword];
async function api(route, { token, body, method = body ? "POST" : "GET", headers = {} } = {}) {
  const response = await fetch(base + "/api/accounts" + route, { method, headers: { Accept: "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie"), retry: response.headers.get("retry-after") };
}
async function create(username, setup = false) {
  const response = await api(setup ? "/setup" : "/register", { body: { username, password, client: "android" } });
  assert.equal(response.status, 201); secrets.push(response.body.token); return response.body;
}
async function issue(admin, target) {
  const response = await api(`/admin/users/${target.user.id}/password-reset`, { token: admin.token, body: { currentPassword: password } });
  assert.equal(response.status, 201); assert.equal(response.body.reset.username, target.user.username);
  assert.equal(response.body.reset.expiresAt, time + 30 * 60000); assert.match(response.body.reset.code, /^FHR-[A-Za-z0-9_-]{32}$/);
  secrets.push(response.body.reset.code); return response.body.reset.code;
}
const reset = (username, resetCode, extra = {}) => api("/password/reset", { body: { username, resetCode, newPassword }, ...extra });
const valid = async (token) => (await api("/sessions", { token })).status;
let db;
try {
  const admin = await create("recovery-admin", true), alice = await create("recover-alice"), bob = await create("recover-bob");
  db = new DatabaseSync(fixture.dbPath);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 4);
  const issueRoute = `/admin/users/${alice.user.id}/password-reset`;
  assert.equal((await api(issueRoute, { body: { currentPassword: password } })).status, 401);
  assert.equal((await api(issueRoute, { token: bob.token, body: { currentPassword: password } })).status, 403);
  assert.equal((await api(issueRoute, { token: admin.token, body: { currentPassword: "Incorrect-password" } })).status, 400);
  assert.equal(db.prepare("SELECT count(*) AS n FROM account_password_resets").get().n, 0);
  const second = (await api("/login", { body: { username: alice.user.username, password, client: "android" } })).body.token;
  const code = await issue(admin, alice);
  const saved = db.prepare("SELECT * FROM account_password_resets WHERE user_id=?").get(alice.user.id);
  assert.equal(saved.code_hash, crypto.createHash("sha256").update(code).digest("hex"));
  assert.equal(await valid(alice.token), 200, "issuing a code must not log the user out");
  const wrongUser = await reset(bob.user.username, code);
  const unknownUser = await reset("nonexistent", code);
  assert.equal(wrongUser.status, 400); assert.deepEqual(wrongUser.body, unknownUser.body);
  assert.equal((await reset(alice.user.username, "FH-invitation-is-not-a-reset-code")).status, 400);
  assert.equal((await reset(alice.user.username, code, { body: { username: alice.user.username, resetCode: code, newPassword: "short" } })).status, 400);
  const success = await reset(" RECOVER-ALICE ", code, { token: alice.token });
  assert.deepEqual(success.body, { ok: true }); assert.equal(success.status, 200); assert.match(success.cookie, /Max-Age=0/);
  assert.equal(await valid(alice.token), 401); assert.equal(await valid(second), 401); assert.equal(await valid(bob.token), 200);
  assert.equal((await reset(alice.user.username, code)).status, 400);
  assert.equal((await api("/login", { body: { username: alice.user.username, password } })).status, 401);
  assert.equal((await api("/login", { body: { username: alice.user.username, password: newPassword } })).status, 200);

  const replaced = await issue(admin, alice), current = await issue(admin, alice);
  assert.equal((await reset(alice.user.username, replaced)).status, 400);
  const race = await Promise.all([reset(alice.user.username, current), reset(alice.user.username, current)]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 400], "concurrent redemption has exactly one winner");
  const expired = await issue(admin, alice); time += 30 * 60000;
  assert.equal((await reset(alice.user.username, expired)).status, 400);
  const disabled = await issue(admin, alice);
  store.updateUser(alice.user.id, { disabled: true }, admin.user.id);
  assert.equal((await api(issueRoute, { token: admin.token, body: { currentPassword: password } })).status, 409);
  store.updateUser(alice.user.id, { disabled: false }, admin.user.id);
  assert.equal((await reset(alice.user.username, disabled)).status, 400, "reenabling must not restore an old recovery code");
  const roleCode = await issue(admin, alice);
  store.updateUser(alice.user.id, { role: "admin" }, admin.user.id);
  assert.equal((await reset(alice.user.username, roleCode)).status, 400);
  store.updateUser(alice.user.id, { role: "user" }, admin.user.id);
  const changed = await issue(admin, bob);
  await store.changePassword(bob.user.id, { currentPassword: password, newPassword });
  assert.equal((await reset(bob.user.username, changed)).status, 400);

  // Inserting the audit record is part of the same transaction as consuming the code.
  const rollbackCode = await issue(admin, alice);
  const active = await store.login({ username: alice.user.username, password: newPassword });
  const before = db.prepare("SELECT password_hash FROM account_users WHERE id=?").get(alice.user.id).password_hash;
  db.exec("CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON account_audit WHEN NEW.action='password.reset' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END");
  await assert.rejects(store.resetPassword({ username: alice.user.username, resetCode: rollbackCode, newPassword: password }), /fixture audit failure/);
  assert.equal(db.prepare("SELECT password_hash FROM account_users WHERE id=?").get(alice.user.id).password_hash, before);
  assert.equal(await valid(active.token), 200); assert(db.prepare("SELECT user_id FROM account_password_resets WHERE user_id=?").get(alice.user.id));
  db.exec("DROP TRIGGER fixture_audit_failure");
  await store.resetPassword({ username: alice.user.username, resetCode: rollbackCode, newPassword });
  assert.equal(await valid(active.token), 401);

  const pending = store.createPasswordReset(admin.user.id, alice.user.id, password, admin.token);
  store.revoke(admin.token);
  await assert.rejects(pending, { statusCode: 401 }, "revoking the administrator during scrypt prevents issuance");
  assert.equal(db.prepare("SELECT count(*) AS n FROM account_password_resets WHERE user_id=?").get(alice.user.id).n, 0);
  admin.token = (await store.login({ username: admin.user.username, password })).token;
  assert.equal((await api("/admin/audit")).status, 401);
  bob.token = (await store.login({ username: bob.user.username, password: newPassword })).token;
  assert.equal((await api("/admin/audit", { token: bob.token })).status, 403);
  store.updateSettings({ registrationEnabled: false, invitationRequired: true }, admin.user.id);
  const invitation = store.createInvites(admin.user.id, { count: 1 })[0]; secrets.push(invitation.code);
  store.disableInvite(invitation.id, admin.user.id);
  const audit = await api("/admin/audit?search=recover-alice", { token: admin.token });
  assert.equal(audit.status, 200); assert(audit.body.total >= 10);
  assert(audit.body.events.every((e) => e.actorUsername === alice.user.username || e.targetUsername === alice.user.username));
  assert(audit.body.events.some((e) => e.action === "password.reset" && e.actorUsername === ""));
  assert.equal((await api("/admin/audit?offset=-1", { token: admin.token })).status, 400);
  assert.equal((await api("/admin/audit?search=%25", { token: admin.token })).body.total, 0, "search treats wildcards literally");
  const events = db.prepare("SELECT * FROM account_audit").all();
  for (const action of ["account.created", "password.reset-issued", "password.reset", "password.changed", "user.updated", "registration.changed", "invites.created", "invite.revoked"]) assert(events.some((e) => e.action === action), action);
  for (const secret of secrets) assert(!JSON.stringify(events).includes(secret), "audit must not store credentials or full codes");
  assert(!JSON.stringify(audit.body).includes("code_hash"));
  const insert = db.prepare("INSERT INTO account_audit(action,actor_username,target_username,summary,created_at) VALUES('fixture','fixture','','fixture',?)");
  db.exec("BEGIN"); for (let i = 0; i < 10000; i++) insert.run(time); db.exec("COMMIT");
  store.updateSettings({ registrationEnabled: true, invitationRequired: false }, admin.user.id);
  assert.equal(store.listAudit().total, 10000); assert.equal(store.listAudit().events[0].action, "registration.changed");
  assert.equal(store.listAudit({ offset: 9950 }).events.length, 50);

  time += 900001;
  for (let i = 0; i < 20; i++) assert.equal((await reset("unknown", "FHR-" + "x".repeat(32), { headers: { "X-Forwarded-For": `203.0.113.${i + 1}` } })).status, 400);
  const limited = await reset("unknown", "FHR-" + "x".repeat(32));
  assert.equal(limited.status, 429); assert(Number(limited.retry) > 0);
  await verifyV2Migration(fixture.root, db.prepare("SELECT password_hash FROM account_users WHERE id=?").get(admin.user.id).password_hash);
  console.log("account-recovery: ok (reauthentication, single-use/expiry/binding, concurrent redemption, session revocation, rollback, audit privacy/retention, throttling, v2 migration)");
} finally { db?.close(); store.close(); await fixture.close(); }

async function verifyV2Migration(root, encodedPassword) {
  const dbPath = path.join(root, "legacy-v2.sqlite"), token = `usr.${Math.floor(time / 1000)}.${"x".repeat(43)}`;
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`CREATE TABLE account_users(id TEXT PRIMARY KEY,username TEXT,display_name TEXT,password_hash TEXT,role TEXT,disabled INTEGER,created_at TEXT,last_login_at TEXT);
    CREATE TABLE account_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT,created_at INTEGER,expires_at INTEGER,id TEXT,client_type TEXT,device_label TEXT,last_seen_at INTEGER);
    CREATE TABLE account_settings(id INTEGER PRIMARY KEY,registration_enabled INTEGER,invitation_required INTEGER);
    INSERT INTO account_settings VALUES(1,1,0); PRAGMA user_version=2;`);
  legacy.prepare("INSERT INTO account_users VALUES(?,?,?,?,?,?,?,?)").run("existing", "existing", "Existing", encodedPassword, "user", 0, new Date(time).toISOString(), null);
  legacy.prepare("INSERT INTO account_sessions VALUES(?,?,?,?,?,?,?,?)").run(crypto.createHash("sha256").update(token).digest("hex"), "existing", time, time + 86400000, "device-kept", "web", "Existing device", time);
  legacy.close();
  const migrated = createAccountStore({ dbPath, now: () => time });
  try {
    assert.equal(migrated.session(token).username, "existing");
    assert.equal(migrated.listSessions("existing", token).sessions[0].id, "device-kept");
    assert.equal(migrated.listAudit().total, 0); assert.equal(migrated.settings().invitationRequired, false);
    const check = new DatabaseSync(dbPath);
    try { assert.equal(check.prepare("PRAGMA user_version").get().user_version, 4); assert.equal(check.prepare("SELECT password_hash FROM account_users").get().password_hash, encodedPassword); }
    finally { check.close(); }
  } finally {
    migrated.close();
    for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
}
