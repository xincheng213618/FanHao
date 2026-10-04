import { randomUUID } from "node:crypto";

const TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_LIMIT = 8192;
const TRACK_SESSION_LIMIT = 128;
const REPORT_LIMIT = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function musicProgressIdentity(body) {
  const cursor = readTuple(body, ["progressSessionId", "progressSessionStartedAt", "progressSequence"]);
  const report = readTuple(body, ["playedReportId", "playedReportStartedAt"]);
  if (report && body.played !== true) throw publicError(400, "播放回执只能用于播放报告");
  return { cursor, report };
}

export function musicProgressClock(database) {
  const floor = Number(database.prepare("SELECT value FROM music_meta WHERE key='progress_clock_ms'").get()?.value || 0);
  const now = Date.now();
  if (!Number.isSafeInteger(floor) || floor < 0 || !Number.isSafeInteger(now) || now < 0) throw new Error("音乐进度时钟无效");
  return Math.max(now, floor);
}

export function musicProgressPreviousSession(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some(key => key !== "previousSessionId")) throw publicError(400, "播放会话请求无效");
  if (!Object.hasOwn(body, "previousSessionId")) return null;
  if (typeof body.previousSessionId !== "string" || !UUID.test(body.previousSessionId)) throw publicError(400, "播放会话标识无效");
  return body.previousSessionId.toLowerCase();
}

export function reserveMusicProgressSession(database, trackId, previousSessionId) {
  const now = musicProgressClock(database);
  ensureLedger(database);
  pruneExpired(database, now);
  const previous = previousSessionId ? database.prepare(`SELECT s.session_id,s.started_at FROM music_progress_heads h
    JOIN music_progress_sessions s ON s.track_id=h.track_id AND s.session_id=h.session_id AND s.started_at=h.started_at
    WHERE h.track_id=? AND h.session_id=? AND s.retired=0 AND h.expires_at>? AND s.expires_at>?`)
    .get(trackId, previousSessionId, now, now) : null;
  if (previous) {
    // A server-confirmed reuse also protects an earlier custom owner from an
    // unknown equal-born provisional cursor, without changing its sequence.
    database.prepare("UPDATE music_progress_sessions SET reserved=1 WHERE track_id=? AND session_id=?").run(trackId, previous.session_id);
    saveClockFloor(database, now);
    return { trackId, progressSessionId: previous.session_id, progressSessionStartedAt: previous.started_at, serverClockMs: now };
  }
  assertSessionCapacity(database, trackId);
  const startedAt = now + 1;
  if (!Number.isSafeInteger(startedAt + TTL_MS)) throw new Error("音乐进度时钟已耗尽");
  const id = randomUUID();
  saveClockFloor(database, startedAt);
  database.prepare("INSERT INTO music_progress_sessions(track_id,session_id,started_at,max_sequence,expires_at,retired,reserved) VALUES (?,?,?,0,?,0,1)")
    .run(trackId, id, startedAt, startedAt + TTL_MS);
  // Reserving an owner does not retire the previous head or change a cursor.
  // An abandoned or lost claim therefore cannot block its final keepalive.
  return { trackId, progressSessionId: id, progressSessionStartedAt: startedAt, serverClockMs: startedAt };
}

// The caller owns BEGIN IMMEDIATE. Clock, owner, sequence, played receipt and
// track state share that transaction. Expiry returns an error for the caller
// to throw after committing only the clock floor; rolling it back could revive
// an already rejected token after a wall-clock rollback.
export function acceptMusicProgress(database, trackId, identity) {
  const { cursor, report } = identity;
  if (!cursor && !report) return { progressApplied: true, playedAccepted: true };
  const now = musicProgressClock(database);
  saveClockFloor(database, now);
  for (const [token, code] of [[cursor, "MUSIC_PROGRESS_SESSION_EXPIRED"], [report, "MUSIC_PLAYED_REPORT_EXPIRED"]]) {
    if (!token) continue;
    if (token.startedAt > now) throw publicError(400, "音乐进度会话时间无效");
    if (token.startedAt <= now - TTL_MS) return { error: publicError(409, "音乐进度标识已过期，请重新获取播放会话", code) };
  }

  ensureLedger(database);
  pruneExpired(database, now);
  const progressApplied = cursor ? acceptCursor(database, trackId, cursor) : true;
  const playedAccepted = report ? acceptReport(database, trackId, report) : true;
  return { progressApplied, playedAccepted };
}

function ensureLedger(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS music_progress_sessions (
      track_id TEXT NOT NULL, session_id TEXT NOT NULL, started_at INTEGER NOT NULL,
      max_sequence INTEGER NOT NULL, expires_at INTEGER NOT NULL, retired INTEGER NOT NULL DEFAULT 0,
      reserved INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(track_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_music_progress_sessions_expiry ON music_progress_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS music_progress_heads (
      track_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, started_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_music_progress_heads_expiry ON music_progress_heads(expires_at);
    CREATE TABLE IF NOT EXISTS music_played_receipts (
      report_id TEXT PRIMARY KEY, track_id TEXT NOT NULL, started_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_music_played_receipts_expiry ON music_played_receipts(expires_at);
  `);
  if (!database.prepare("PRAGMA table_info(music_progress_sessions)").all().some(column => column.name === "reserved")) {
    database.exec("ALTER TABLE music_progress_sessions ADD COLUMN reserved INTEGER NOT NULL DEFAULT 0");
  }
}

function pruneExpired(database, now) {
  // An absent track can return after a scan with the same stable ID. Retain
  // every unexpired marker, including retired owners, until its fixed TTL.
  database.prepare("DELETE FROM music_progress_heads WHERE expires_at<=?").run(now);
  database.prepare("DELETE FROM music_progress_sessions WHERE expires_at<=?").run(now);
  database.prepare("DELETE FROM music_played_receipts WHERE expires_at<=?").run(now);
}

function acceptCursor(database, trackId, cursor) {
  const previous = database.prepare("SELECT * FROM music_progress_sessions WHERE track_id=? AND session_id=?").get(trackId, cursor.id);
  if (previous && previous.started_at !== cursor.startedAt) throw publicError(409, "音乐进度会话标识已用于其他时间");
  if (!previous) assertSessionCapacity(database, trackId);
  const head = database.prepare(`SELECT h.*,s.reserved FROM music_progress_heads h
    LEFT JOIN music_progress_sessions s ON s.track_id=h.track_id AND s.session_id=h.session_id
    WHERE h.track_id=?`).get(trackId);
  const owns = head?.session_id === cursor.id;
  const canTakeOwnership = !previous?.retired && (!head || cursor.startedAt > head.started_at
    || (cursor.startedAt === head.started_at && !previous && !head.reserved));
  if (!owns && canTakeOwnership) {
    if (head) database.prepare("UPDATE music_progress_sessions SET retired=1 WHERE track_id=? AND session_id=?").run(trackId, head.session_id);
    database.prepare(`INSERT INTO music_progress_heads(track_id,session_id,started_at,expires_at) VALUES (?,?,?,?)
      ON CONFLICT(track_id) DO UPDATE SET session_id=excluded.session_id,started_at=excluded.started_at,expires_at=excluded.expires_at`)
      .run(trackId, cursor.id, cursor.startedAt, cursor.startedAt + TTL_MS);
  }
  const retired = previous?.retired || (!owns && !canTakeOwnership) ? 1 : 0;
  database.prepare(`INSERT INTO music_progress_sessions(track_id,session_id,started_at,max_sequence,expires_at,retired) VALUES (?,?,?,?,?,?)
    ON CONFLICT(track_id,session_id) DO UPDATE SET max_sequence=MAX(max_sequence,excluded.max_sequence),retired=excluded.retired`)
    .run(trackId, cursor.id, cursor.startedAt, cursor.sequence, cursor.startedAt + TTL_MS, retired);
  return !retired && (owns || canTakeOwnership) && (!previous || cursor.sequence > previous.max_sequence);
}

function acceptReport(database, trackId, report) {
  const previous = database.prepare("SELECT track_id,started_at FROM music_played_receipts WHERE report_id=?").get(report.id);
  if (previous) {
    if (previous.track_id !== trackId || previous.started_at !== report.startedAt) throw publicError(409, "播放回执标识已用于其他播放事件");
    return false;
  }
  if (database.prepare("SELECT COUNT(*) AS count FROM music_played_receipts").get().count >= REPORT_LIMIT) throw capacityError();
  database.prepare("INSERT INTO music_played_receipts(report_id,track_id,started_at,expires_at) VALUES (?,?,?,?)").run(report.id, trackId, report.startedAt, report.startedAt + TTL_MS);
  return true;
}

function readTuple(body, fields) {
  if (!fields.some(field => Object.hasOwn(body, field))) return null;
  if (!fields.every(field => Object.hasOwn(body, field))) throw publicError(400, "音乐进度顺序标识不完整");
  const [id, startedAt, sequence] = fields.map(field => body[field]);
  if (typeof id !== "string" || !UUID.test(id) || !Number.isSafeInteger(startedAt) || startedAt < 0
    || (fields.length === 3 && (!Number.isSafeInteger(sequence) || sequence < 1))) throw publicError(400, "音乐进度顺序标识无效");
  return { id: id.toLowerCase(), startedAt, ...(fields.length === 3 ? { sequence } : {}) };
}

function capacityError() {
  return Object.assign(publicError(503, "音乐进度保存队列已满，请稍后重试", "MUSIC_PROGRESS_CAPACITY"), { retryable: true });
}

function assertSessionCapacity(database, trackId) {
  const total = database.prepare("SELECT COUNT(*) AS count FROM music_progress_sessions").get().count;
  const trackTotal = database.prepare("SELECT COUNT(*) AS count FROM music_progress_sessions WHERE track_id=?").get(trackId).count;
  if (total >= SESSION_LIMIT || trackTotal >= TRACK_SESSION_LIMIT) throw capacityError();
}

function saveClockFloor(database, now) {
  database.prepare("INSERT INTO music_meta(key,value) VALUES ('progress_clock_ms',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(now));
}

function publicError(statusCode, message, code) {
  return Object.assign(new Error(message), { statusCode, expose: true, ...(code ? { code } : {}) });
}

