import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { ACCOUNT_AUDIT_SCHEMA, createAccountAudit } from "./audit.js";

const scrypt = promisify(crypto.scrypt);
const PASSWORD_OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
export const SESSION_SECONDS = 30 * 24 * 60 * 60;
const ACTIVITY_INTERVAL_MS = 5 * 60 * 1000;
const PASSWORD_RESET_MS = 30 * 60 * 1000;
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const publicUser = (row) => row ? ({ id: row.id, username: row.username, displayName: row.display_name,
  role: row.role, disabled: Boolean(row.disabled), createdAt: row.created_at, lastLoginAt: row.last_login_at }) : null;

export function accountError(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
function requireValue(condition, message) { if (!condition) throw accountError(400, message); }
function credentials(body) {
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  requireValue(/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username), "用户名须为 3–32 位字母、数字、下划线、点或短横线");
  requireValue(typeof body.password === "string" && body.password.length >= 10 && body.password.length <= 128,
    "密码长度须为 10–128 位");
  return { username, password: body.password };
}
function displayName(value, fallback = "") {
  const name = typeof value === "string" ? value.trim() : fallback;
  requireValue(name.length >= 1 && name.length <= 40 && !/[\u0000-\u001f\u007f]/.test(name), "昵称须为 1–40 个字符");
  return name;
}
function integer(value, fallback, min, max, label) {
  const result = value === undefined ? fallback : Number(value);
  requireValue(Number.isInteger(result) && result >= min && result <= max, `${label}须在 ${min}–${max} 之间`);
  return result;
}

export function createAccountStore({ dbPath, now = Date.now }) {
  let db;
  let hashing = 0;
  const audit = createAccountAudit({ database, now, accountError });
  function database() {
    if (db) return db;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const next = new DatabaseSync(dbPath);
    try {
      next.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;`);
      next.exec("BEGIN IMMEDIATE");
      const version = next.prepare("PRAGMA user_version").get().user_version;
      if (version > 4) throw new Error("Account database schema is newer than this server");
      if (version < 1) next.exec(`
        CREATE TABLE account_users (
          id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
          password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','user')),
          disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)),
          created_at TEXT NOT NULL, last_login_at TEXT
        );
        CREATE TABLE account_sessions (
          token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES account_users(id),
          created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
        );
        CREATE INDEX account_sessions_user ON account_sessions(user_id);
        CREATE INDEX account_sessions_expiry ON account_sessions(expires_at);
        CREATE TABLE account_invites (
          id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, suffix TEXT NOT NULL,
          created_by TEXT NOT NULL REFERENCES account_users(id), created_at TEXT NOT NULL,
          expires_at INTEGER NOT NULL, max_uses INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0,
          disabled INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL
        );
        CREATE TABLE account_redemptions (
          user_id TEXT PRIMARY KEY REFERENCES account_users(id), invite_id TEXT NOT NULL REFERENCES account_invites(id),
          created_at TEXT NOT NULL
        );
        CREATE TABLE account_settings (id INTEGER PRIMARY KEY CHECK(id=1), registration_enabled INTEGER NOT NULL,
          invitation_required INTEGER NOT NULL);
        INSERT INTO account_settings VALUES(1, 1, 0);
        PRAGMA user_version = 1;`);
      if (version < 2) {
        next.exec(`ALTER TABLE account_sessions ADD COLUMN id TEXT;
          ALTER TABLE account_sessions ADD COLUMN client_type TEXT NOT NULL DEFAULT 'unknown';
          ALTER TABLE account_sessions ADD COLUMN device_label TEXT NOT NULL DEFAULT '先前登录的设备';
          ALTER TABLE account_sessions ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0;`);
        const update = next.prepare("UPDATE account_sessions SET id=?,last_seen_at=created_at WHERE token_hash=?");
        for (const row of next.prepare("SELECT token_hash FROM account_sessions").all()) update.run(crypto.randomUUID(), row.token_hash);
        next.exec("CREATE UNIQUE INDEX account_sessions_id ON account_sessions(id); PRAGMA user_version = 2;");
      }
      if (version < 3) next.exec(`CREATE TABLE account_password_resets (
        user_id TEXT PRIMARY KEY REFERENCES account_users(id), code_hash TEXT NOT NULL UNIQUE,
        created_by TEXT NOT NULL REFERENCES account_users(id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      ); ${ACCOUNT_AUDIT_SCHEMA} PRAGMA user_version = 3;`);
      if (version < 4) next.exec(`ALTER TABLE account_settings ADD COLUMN account_login_required INTEGER NOT NULL DEFAULT 0
        CHECK(account_login_required IN (0,1)); PRAGMA user_version = 4;`);
      next.exec("COMMIT");
      db = next;
      return db;
    } catch (error) { next.close(); throw error; }
  }
  function transaction(action) {
    const connection = database();
    connection.exec("BEGIN IMMEDIATE");
    try { const result = action(connection); connection.exec("COMMIT"); return result; }
    catch (error) { connection.exec("ROLLBACK"); throw error; }
  }
  async function derive(password, salt) {
    if (hashing >= 4) throw accountError(429, "登录服务繁忙，请稍后重试");
    hashing += 1;
    try { return await scrypt(password, salt, 64, PASSWORD_OPTIONS); }
    finally { hashing -= 1; }
  }
  async function passwordHash(password) {
    const salt = crypto.randomBytes(16).toString("hex");
    return `scrypt-v1$${salt}$${(await derive(password, salt)).toString("hex")}`;
  }
  async function matches(password, saved) {
    const [, salt, expected] = String(saved || "").split("$");
    // Missing users still pay the same password derivation cost.
    const actual = await derive(String(password || "").slice(0, 128), salt || "00000000000000000000000000000000");
    const expectedBytes = Buffer.from(expected || "", "hex");
    return actual.length === expectedBytes.length && crypto.timingSafeEqual(actual, expectedBytes);
  }
  function settings() {
    const row = database().prepare("SELECT * FROM account_settings WHERE id=1").get();
    return { registrationEnabled: Boolean(row.registration_enabled), invitationRequired: Boolean(row.invitation_required),
      accountLoginRequired: Boolean(row.account_login_required) };
  }
  function hasAdmin() { return Boolean(database().prepare("SELECT 1 FROM account_users WHERE role='admin' LIMIT 1").get()); }
  function userById(id) { return database().prepare("SELECT * FROM account_users WHERE id=?").get(id); }
  function session(token) {
    if (!/^usr\.[0-9]{1,12}\.[A-Za-z0-9_-]{43}$/.test(String(token || ""))) return null;
    const timestamp = Number(now());
    const tokenHash = hash(token);
    const connection = database();
    const row = connection.prepare(`SELECT u.*,s.last_seen_at FROM account_sessions s JOIN account_users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0`).get(tokenHash, timestamp);
    if (row && timestamp - row.last_seen_at >= ACTIVITY_INTERVAL_MS) {
      // Recording approximate activity must never wait on a writer and stall media authentication.
      connection.exec("PRAGMA busy_timeout = 0");
      try { connection.prepare("UPDATE account_sessions SET last_seen_at=? WHERE token_hash=?").run(timestamp, tokenHash); }
      catch (error) { if (![5, 6].includes(Number(error.errcode) & 255)) throw error; }
      finally { connection.exec("PRAGMA busy_timeout = 3000"); }
    }
    return publicUser(row);
  }
  function revoke(token) { if (token) database().prepare("DELETE FROM account_sessions WHERE token_hash=?").run(hash(token)); }
  function requireSession(id, token) {
    const connection = database();
    const row = connection.prepare(`SELECT s.* FROM account_sessions s JOIN account_users u ON u.id=s.user_id
      WHERE s.user_id=? AND s.token_hash=? AND s.expires_at>? AND u.disabled=0`).get(id, hash(String(token || "")), Number(now()));
    if (!row) throw accountError(401, "请重新登录用户账号");
    return row;
  }
  function listSessions(id, token) {
    const current = requireSession(id, token);
    const rows = database().prepare(`SELECT id,client_type AS clientType,device_label AS deviceLabel,
      created_at AS createdAt,last_seen_at AS lastSeenAt,expires_at AS expiresAt FROM account_sessions
      WHERE user_id=? AND expires_at>? ORDER BY id=? DESC,last_seen_at DESC,created_at DESC,id LIMIT 20`).all(id, Number(now()), current.id);
    return { sessions: rows.map((row) => ({ ...row, current: row.id === current.id })) };
  }
  function revokeSession(id, sessionId, token) {
    return transaction((connection) => {
      const current = requireSession(id, token);
      const removed = connection.prepare("DELETE FROM account_sessions WHERE user_id=? AND id=? AND expires_at>?").run(id, sessionId, Number(now()));
      if (!removed.changes) throw accountError(404, "登录设备不存在或已退出");
      audit.record("sessions.revoked", id, id, current.id === sessionId ? "退出当前登录设备" : "退出一个其他登录设备");
      return { current: current.id === sessionId };
    });
  }
  function revokeOtherSessions(id, token) {
    return transaction((connection) => {
      const current = requireSession(id, token);
      connection.prepare("DELETE FROM account_sessions WHERE user_id=? AND expires_at<=?").run(id, Number(now()));
      const result = connection.prepare("DELETE FROM account_sessions WHERE user_id=? AND id<>?").run(id, current.id);
      if (result.changes) audit.record("sessions.revoked", id, id, `退出 ${result.changes} 个其他登录设备`);
      return { revoked: Number(result.changes) };
    });
  }
  function issueSession(id, { clientType = "unknown", deviceLabel = "其他设备" } = {}) {
    const timestamp = Number(now());
    const token = `usr.${Math.floor(timestamp / 1000)}.${crypto.randomBytes(32).toString("base64url")}`;
    const connection = database();
    connection.prepare("DELETE FROM account_sessions WHERE expires_at<=?").run(timestamp);
    connection.prepare(`DELETE FROM account_sessions WHERE user_id=? AND token_hash NOT IN
      (SELECT token_hash FROM account_sessions WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 19)`).run(id, id);
    connection.prepare(`INSERT INTO account_sessions(token_hash,user_id,created_at,expires_at,id,client_type,device_label,last_seen_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(hash(token), id, timestamp, timestamp + SESSION_SECONDS * 1000,
      crypto.randomUUID(), clientType, deviceLabel, timestamp);
    connection.prepare("UPDATE account_users SET last_login_at=? WHERE id=?").run(new Date(timestamp).toISOString(), id);
    return { token, user: publicUser(userById(id)), expiresIn: SESSION_SECONDS };
  }
  async function register(body, { setup = false, sessionMetadata } = {}) {
    const { username, password } = credentials(body);
    const name = displayName(body.displayName, username);
    const code = typeof body.inviteCode === "string" ? body.inviteCode.trim().toUpperCase() : "";
    requireValue(code.length <= 100, "邀请码格式无效");
    const encoded = await passwordHash(password);
    return transaction((connection) => {
      if (setup && hasAdmin()) throw accountError(409, "管理员已经初始化");
      const policy = settings();
      if (!setup && !policy.registrationEnabled) throw accountError(403, "当前已关闭新用户注册");
      if (!setup && policy.invitationRequired && !code) throw accountError(400, "注册需要邀请码");
      let invitation;
      if (!setup && code) {
        invitation = connection.prepare("SELECT * FROM account_invites WHERE code_hash=?").get(hash(code));
        if (!invitation || invitation.disabled || invitation.expires_at <= Number(now()) || invitation.uses >= invitation.max_uses)
          throw accountError(400, "邀请码无效、已过期或已用完");
      }
      if (connection.prepare("SELECT 1 FROM account_users WHERE username=?").get(username)) throw accountError(409, "该用户名已被使用");
      const id = crypto.randomUUID();
      const created = new Date(Number(now())).toISOString();
      connection.prepare("INSERT INTO account_users(id,username,display_name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)")
        .run(id, username, name, encoded, setup ? "admin" : "user", created);
      if (invitation) {
        connection.prepare("UPDATE account_invites SET uses=uses+1 WHERE id=?").run(invitation.id);
        connection.prepare("INSERT INTO account_redemptions VALUES(?,?,?)").run(id, invitation.id, created);
      }
      audit.record("account.created", id, id, setup ? "本机初始化管理员" : invitation ? "通过邀请码注册普通用户" : "开放注册普通用户");
      return issueSession(id, sessionMetadata);
    });
  }
  async function login(body, sessionMetadata) {
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    requireValue(typeof body.password === "string" && body.password.length <= 128, "用户名或密码不正确");
    const row = database().prepare("SELECT * FROM account_users WHERE username=?").get(username);
    if (!(await matches(body.password, row?.password_hash)) || !row || row.disabled) throw accountError(401, "用户名或密码不正确");
    // Recheck after async hashing: another request can disable/change this account meanwhile.
    return transaction(() => {
      const fresh = userById(row.id);
      if (fresh.disabled || fresh.password_hash !== row.password_hash) throw accountError(401, "账号状态已改变，请重新登录");
      return issueSession(row.id, sessionMetadata);
    });
  }
  function updateProfile(id, body) {
    database().prepare("UPDATE account_users SET display_name=? WHERE id=?").run(displayName(body.displayName), id);
    return publicUser(userById(id));
  }
  async function changePassword(id, body) {
    credentials({ username: "validation", password: body.newPassword });
    requireValue(typeof body.currentPassword === "string" && body.currentPassword.length <= 128, "当前密码不正确");
    const row = userById(id);
    if (!row || !(await matches(body.currentPassword, row.password_hash))) throw accountError(400, "当前密码不正确");
    const encoded = await passwordHash(body.newPassword);
    transaction((connection) => {
      const fresh = userById(id);
      if (fresh.disabled || fresh.password_hash !== row.password_hash) throw accountError(409, "账号状态已改变，请重新登录");
      connection.prepare("UPDATE account_users SET password_hash=? WHERE id=?").run(encoded, id);
      connection.prepare("DELETE FROM account_sessions WHERE user_id=?").run(id);
      connection.prepare("DELETE FROM account_password_resets WHERE user_id=?").run(id);
      audit.record("password.changed", id, id, "修改密码并退出全部登录设备");
    });
  }
  async function createPasswordReset(actorId, id, currentPassword, actorToken) {
    requireSession(actorId, actorToken);
    const actor = userById(actorId);
    if (actor.role !== "admin") throw accountError(403, "需要管理员权限");
    requireValue(typeof currentPassword === "string" && currentPassword.length <= 128, "管理员密码不正确");
    if (!(await matches(currentPassword, actor.password_hash))) throw accountError(400, "管理员密码不正确");
    return transaction((connection) => {
      // Reauthentication is only valid while this same administrator session and password remain current.
      requireSession(actorId, actorToken);
      const freshActor = userById(actorId);
      if (freshActor.role !== "admin" || freshActor.password_hash !== actor.password_hash) throw accountError(401, "账号状态已改变，请重新登录");
      const target = userById(id);
      if (!target) throw accountError(404, "用户不存在");
      if (target.disabled) throw accountError(409, "请先启用该用户，再生成密码重置码");
      const code = `FHR-${crypto.randomBytes(24).toString("base64url")}`;
      const timestamp = Number(now());
      const expiresAt = timestamp + PASSWORD_RESET_MS;
      connection.prepare("DELETE FROM account_password_resets WHERE expires_at<=?").run(timestamp);
      connection.prepare(`INSERT INTO account_password_resets VALUES(?,?,?,?,?) ON CONFLICT(user_id)
        DO UPDATE SET code_hash=excluded.code_hash,created_by=excluded.created_by,created_at=excluded.created_at,expires_at=excluded.expires_at`)
        .run(id, hash(code), actorId, timestamp, expiresAt);
      audit.record("password.reset-issued", actorId, id, "生成一次性密码重置码，有效期 30 分钟；该用户的旧重置码失效");
      return { username: target.username, code, expiresAt };
    });
  }
  async function resetPassword(body) {
    credentials({ username: "validation", password: body.newPassword });
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const code = typeof body.resetCode === "string" ? body.resetCode.trim() : "";
    const invalid = () => accountError(400, "重置码无效或已过期，请向管理员重新获取");
    if (username.length > 32 || !/^FHR-[A-Za-z0-9_-]{32}$/.test(code)) throw invalid();
    const codeHash = hash(code);
    const lookup = () => database().prepare(`SELECT u.id FROM account_password_resets r JOIN account_users u ON u.id=r.user_id
      WHERE u.username=? AND r.code_hash=? AND r.expires_at>? AND u.disabled=0`).get(username, codeHash, Number(now()));
    if (!lookup()) throw invalid();
    const encoded = await passwordHash(body.newPassword);
    return transaction((connection) => {
      const target = lookup();
      if (!target) throw invalid();
      connection.prepare("UPDATE account_users SET password_hash=? WHERE id=?").run(encoded, target.id);
      connection.prepare("DELETE FROM account_password_resets WHERE user_id=?").run(target.id);
      connection.prepare("DELETE FROM account_sessions WHERE user_id=?").run(target.id);
      audit.record("password.reset", null, target.id, "使用一次性重置码设置新密码并退出全部登录设备");
      return { userId: target.id };
    });
  }
  function updateUser(id, body, actorId) {
    requireValue(Object.keys(body).some((key) => key === "role" || key === "disabled"), "请选择角色或账号状态");
    requireValue(body.role === undefined || ["admin", "user"].includes(body.role), "角色无效");
    requireValue(body.disabled === undefined || typeof body.disabled === "boolean", "账号状态无效");
    return transaction((connection) => {
      const row = userById(id);
      if (!row) throw accountError(404, "用户不存在");
      const role = body.role ?? row.role;
      const disabled = body.disabled === undefined ? row.disabled : Number(body.disabled);
      if (row.role === "admin" && !row.disabled && (role !== "admin" || disabled)
        && connection.prepare("SELECT count(*) AS n FROM account_users WHERE role='admin' AND disabled=0").get().n <= 1)
        throw accountError(409, "不能停用或降级最后一个管理员");
      connection.prepare("UPDATE account_users SET role=?,disabled=? WHERE id=?").run(role, disabled, id);
      if (role !== row.role || disabled !== row.disabled) {
        connection.prepare("DELETE FROM account_sessions WHERE user_id=?").run(id);
        connection.prepare("DELETE FROM account_password_resets WHERE user_id=?").run(id);
        audit.record("user.updated", actorId, id, `角色：${row.role} → ${role}；状态：${row.disabled ? "停用" : "启用"} → ${disabled ? "停用" : "启用"}`);
      }
      return publicUser(userById(id));
    });
  }
  function listUsers(query) {
    const offset = integer(query.offset ?? undefined, 0, 0, 10000000, "分页位置");
    const search = String(query.search || "").trim().slice(0, 100);
    const filter = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
    const where = "WHERE u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\'";
    const connection = database();
    const rows = connection.prepare(`SELECT u.*,i.id AS inviteId,i.suffix AS inviteSuffix,c.username AS inviterUsername
      FROM account_users u LEFT JOIN account_redemptions r ON r.user_id=u.id
      LEFT JOIN account_invites i ON i.id=r.invite_id LEFT JOIN account_users c ON c.id=i.created_by
      ${where} ORDER BY u.created_at DESC,u.id LIMIT 50 OFFSET ?`).all(filter, filter, offset);
    return { users: rows.map((row) => ({ ...publicUser(row), registration: row.inviteId
      ? { kind: "invitation", inviteId: row.inviteId, suffix: row.inviteSuffix, createdByUsername: row.inviterUsername }
      : { kind: "direct" } })),
      total: connection.prepare(`SELECT count(*) AS n FROM account_users u ${where}`).get(filter, filter).n, offset, limit: 50 };
  }
  function updateSettings(body, actorId) {
    const fields = ["registrationEnabled", "invitationRequired", "accountLoginRequired"];
    requireValue(fields.some((key) => Object.hasOwn(body, key)), "请提供要修改的账号设置");
    requireValue(fields.every((key) => !Object.hasOwn(body, key) || typeof body[key] === "boolean"), "账号设置必须是开关值");
    return transaction((connection) => {
      const before = settings();
      const policy = Object.fromEntries(fields.map((key) => [key, Object.hasOwn(body, key) ? body[key] : before[key]]));
      connection.prepare("UPDATE account_settings SET registration_enabled=?,invitation_required=?,account_login_required=? WHERE id=1")
        .run(Number(policy.registrationEnabled), Number(policy.invitationRequired), Number(policy.accountLoginRequired));
      if (before.registrationEnabled !== policy.registrationEnabled || before.invitationRequired !== policy.invitationRequired)
        audit.record("registration.changed", actorId, null, `开放注册：${policy.registrationEnabled ? "是" : "否"}；邀请码必填：${policy.invitationRequired ? "是" : "否"}`);
      if (before.accountLoginRequired !== policy.accountLoginRequired)
        audit.record("access.changed", actorId, null, `访问资料库必须登录用户账号：${policy.accountLoginRequired ? "是" : "否"}`);
      return settings();
    });
  }
  function createInvites(actor, body) {
    const count = integer(body.count, 1, 1, 100, "生成数量");
    const maxUses = integer(body.maxUses, 1, 1, 1000, "可用次数");
    const days = integer(body.expiresInDays, 7, 1, 365, "有效天数");
    requireValue(body.note === undefined || (typeof body.note === "string" && body.note.length <= 120), "备注不能超过 120 字");
    return transaction((connection) => {
      const invites = Array.from({ length: count }, () => {
      const code = `FH-${crypto.randomBytes(12).toString("hex").toUpperCase().match(/.{1,6}/g).join("-")}`;
      const id = crypto.randomUUID();
      const expiresAt = Number(now()) + days * 86400000;
      connection.prepare("INSERT INTO account_invites(id,code_hash,suffix,created_by,created_at,expires_at,max_uses,note) VALUES(?,?,?,?,?,?,?,?)")
        .run(id, hash(code), code.slice(-6), actor, new Date(Number(now())).toISOString(), expiresAt, maxUses, body.note || "");
      return { id, code, maxUses, expiresAt };
      });
      audit.record("invites.created", actor, null, `生成 ${count} 个邀请码，每码可用 ${maxUses} 次，有效期 ${days} 天`);
      return invites;
    });
  }
  function listInvites(query) {
    const offset = integer(query.offset ?? undefined, 0, 0, 10000000, "分页位置");
    const status = query.status || "all";
    requireValue(["all", "available", "exhausted", "expired", "disabled"].includes(status), "邀请码状态无效");
    const search = `%${String(query.search || "").trim().slice(0, 100).replace(/[\\%_]/g, "\\$&")}%`;
    const where = `WHERE (note LIKE ? ESCAPE '\\' OR suffix LIKE ? ESCAPE '\\' OR createdByUsername LIKE ? ESCAPE '\\')${status === "all" ? "" : " AND status=?"}`;
    const parameters = [Number(now()), search, search, search, ...(status === "all" ? [] : [status])];
    const connection = database();
    return { invites: connection.prepare(`SELECT * FROM (${inviteQuery()}) ${where} ORDER BY createdAt DESC,id LIMIT 50 OFFSET ?`).all(...parameters, offset),
      total: connection.prepare(`SELECT count(*) AS n FROM (${inviteQuery()}) ${where}`).get(...parameters).n, offset, limit: 50 };
  }
  function inviteQuery() {
    return `SELECT i.id,i.suffix,i.created_at AS createdAt,i.expires_at AS expiresAt,i.max_uses AS maxUses,
      i.uses,i.disabled,i.note,c.username AS createdByUsername,
      CASE WHEN i.disabled=1 THEN 'disabled' WHEN i.expires_at<=? THEN 'expired'
        WHEN i.uses>=i.max_uses THEN 'exhausted' ELSE 'available' END AS status
      FROM account_invites i JOIN account_users c ON c.id=i.created_by`;
  }
  function inviteDetails(id, query) {
    const offset = integer(query.offset ?? undefined, 0, 0, 10000000, "分页位置");
    const search = `%${String(query.search || "").trim().slice(0, 100).replace(/[\\%_]/g, "\\$&")}%`;
    const connection = database();
    const invite = connection.prepare(`${inviteQuery()} WHERE i.id=?`).get(Number(now()), id);
    if (!invite) throw accountError(404, "邀请码不存在");
    const from = `FROM account_redemptions r JOIN account_users u ON u.id=r.user_id
      WHERE r.invite_id=? AND (u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')`;
    return { invite, redemptions: connection.prepare(`SELECT u.id,u.username,u.display_name AS displayName,u.role,u.disabled,
      r.created_at AS redeemedAt ${from} ORDER BY r.created_at DESC,u.id LIMIT 50 OFFSET ?`).all(id, search, search, offset)
      .map((row) => ({ ...row, disabled: Boolean(row.disabled) })),
      total: connection.prepare(`SELECT count(*) AS n ${from}`).get(id, search, search).n, offset, limit: 50 };
  }
  function disableInvite(id, actorId) {
    transaction((connection) => {
      const row = connection.prepare("SELECT suffix,disabled FROM account_invites WHERE id=?").get(id);
      if (!row) throw accountError(404, "邀请码不存在");
      if (!row.disabled) {
        connection.prepare("UPDATE account_invites SET disabled=1 WHERE id=?").run(id);
        audit.record("invite.revoked", actorId, null, `停用末尾为 ${row.suffix} 的邀请码`);
      }
    });
  }
  return { settings, hasAdmin, session, revoke, register, login, updateProfile, changePassword, updateUser,
    createPasswordReset, resetPassword, listAudit: audit.list,
    listSessions, revokeSession, revokeOtherSessions,
    listUsers, updateSettings, createInvites, listInvites, inviteDetails, disableInvite, close() { db?.close(); db = undefined; } };
}
