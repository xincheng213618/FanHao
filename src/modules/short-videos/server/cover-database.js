import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SQLITE_SHORT_VIDEO_COVER_SOURCE = "ffmpeg_sqlite";
export const SHORT_VIDEO_COVER_GENERATION_VERSION = 1;

export function defaultShortVideoCoverDbPath(shortVideoDbPath) {
  return path.join(path.dirname(path.resolve(shortVideoDbPath || ".")), "short-video-covers.sqlite");
}

export function createShortVideoCoverDatabase(options = {}) {
  const dbPath = path.resolve(options.dbPath || defaultShortVideoCoverDbPath(options.shortVideoDbPath));
  let db = null;

  function database() {
    if (db) return db;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const opened = new DatabaseSync(dbPath);
    opened.exec(`
      PRAGMA busy_timeout = 10000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
      PRAGMA wal_autocheckpoint = 2000;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS short_video_cover_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS short_video_covers (
        video_id TEXT PRIMARY KEY,
        source_fingerprint TEXT NOT NULL DEFAULT '',
        source_mtime_ms INTEGER NOT NULL DEFAULT 0,
        mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
        byte_length INTEGER NOT NULL CHECK(byte_length > 0),
        image_blob BLOB NOT NULL,
        generation_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(byte_length = length(image_blob))
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_short_video_covers_updated
        ON short_video_covers(updated_at);
      CREATE TABLE IF NOT EXISTS short_video_cover_delete_receipts (
        operation_id TEXT PRIMARY KEY,
        request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64),
        video_ids_json TEXT NOT NULL,
        deleted_count INTEGER NOT NULL CHECK(deleted_count >= 0),
        created_at TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TRIGGER IF NOT EXISTS trg_short_video_cover_delete_receipt_no_update_v1
      BEFORE UPDATE ON short_video_cover_delete_receipts
      BEGIN
        SELECT RAISE(ABORT, 'short video cover delete receipt is immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_short_video_cover_delete_receipt_no_delete_v1
      BEFORE DELETE ON short_video_cover_delete_receipts
      BEGIN
        SELECT RAISE(ABORT, 'short video cover delete receipt is permanent');
      END;
      INSERT INTO short_video_cover_meta (key, value)
      VALUES ('schema_version', '2')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
      WHERE short_video_cover_meta.value <> excluded.value;
      COMMIT;
    `);
    db = opened;
    return db;
  }

  function put(videoId, imageBuffer, metadata = {}) {
    const record = normalizeCoverRecord(videoId, imageBuffer, metadata);
    writeRecords(database(), [record]);
    return publicCoverRecord(record);
  }

  function putMany(records = []) {
    const normalized = records.map((record) => normalizeCoverRecord(
      record?.videoId,
      record?.imageBuffer,
      record || {}
    ));
    if (!normalized.length) return { written: 0, bytes: 0 };
    const database = databaseOrOpen();
    database.exec("BEGIN IMMEDIATE");
    try {
      writeRecords(database, normalized);
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
    return {
      written: normalized.length,
      bytes: normalized.reduce((total, record) => total + record.byteLength, 0)
    };
  }

  function get(videoId) {
    const id = normalizeVideoId(videoId);
    if (!id) return null;
    const row = databaseOrOpen().prepare(`
      SELECT
        video_id,
        source_fingerprint,
        source_mtime_ms,
        mime_type,
        byte_length,
        image_blob,
        generation_version,
        created_at,
        updated_at
      FROM short_video_covers
      WHERE video_id = ?
    `).get(id);
    if (!row?.image_blob) return null;
    const buffer = Buffer.from(row.image_blob);
    if (!isJpegBuffer(buffer) || buffer.length !== Number(row.byte_length || 0)) return null;
    return {
      videoId: row.video_id,
      sourceFingerprint: row.source_fingerprint || "",
      sourceMtimeMs: Number(row.source_mtime_ms || 0),
      mimeType: row.mime_type || "image/jpeg",
      byteLength: buffer.length,
      imageBuffer: buffer,
      generationVersion: Number(row.generation_version || 1),
      createdAt: row.created_at || "",
      updatedAt: row.updated_at || ""
    };
  }

  function has(videoId, sourceFingerprint = "") {
    const id = normalizeVideoId(videoId);
    if (!id) return false;
    const fingerprint = String(sourceFingerprint || "").trim();
    const row = fingerprint
      ? databaseOrOpen().prepare(`
          SELECT 1
          FROM short_video_covers
          WHERE video_id = ?
            AND source_fingerprint = ?
            AND byte_length = length(image_blob)
          LIMIT 1
        `).get(id, fingerprint)
      : databaseOrOpen().prepare(`
          SELECT 1
          FROM short_video_covers
          WHERE video_id = ?
            AND byte_length = length(image_blob)
          LIMIT 1
        `).get(id);
    return Boolean(row);
  }

  function remove(videoId) {
    const id = normalizeVideoId(videoId);
    if (!id) return false;
    return Number(databaseOrOpen().prepare("DELETE FROM short_video_covers WHERE video_id = ?").run(id)?.changes || 0) > 0;
  }

  function removeMany(videoIds = [], receipt = {}) {
    const ids = [...new Set(videoIds.map(normalizeVideoId).filter(Boolean))].sort();
    const operationId = String(receipt?.operationId || "").trim();
    const requestSha256 = String(receipt?.requestSha256 || "").trim();
    if (Boolean(operationId) !== Boolean(requestSha256)) {
      throw new Error("short video cover delete receipt identity is incomplete");
    }
    if (!operationId && !ids.length) return 0;
    const videoIdsJson = JSON.stringify(ids);
    let removed = 0;
    const database = databaseOrOpen();
    database.exec("BEGIN IMMEDIATE");
    try {
      if (operationId) {
        const existing = database.prepare(`
          SELECT request_sha256, video_ids_json, deleted_count
          FROM short_video_cover_delete_receipts
          WHERE operation_id = ?
        `).get(operationId);
        if (existing) {
          if (existing.request_sha256 !== requestSha256 || existing.video_ids_json !== videoIdsJson) {
            throw new Error("short video cover delete receipt conflict");
          }
          database.exec("COMMIT");
          return Number(existing.deleted_count || 0);
        }
      }
      for (let offset = 0; offset < ids.length; offset += 500) {
        const batch = ids.slice(offset, offset + 500);
        const placeholders = batch.map(() => "?").join(", ");
        removed += Number(database.prepare(`DELETE FROM short_video_covers WHERE video_id IN (${placeholders})`).run(...batch)?.changes || 0);
      }
      if (operationId) {
        database.prepare(`
          INSERT INTO short_video_cover_delete_receipts (
            operation_id, request_sha256, video_ids_json, deleted_count, created_at
          ) VALUES (?, ?, ?, ?, ?)
        `).run(operationId, requestSha256, videoIdsJson, removed, new Date().toISOString());
      }
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
    return removed;
  }

  function ids() {
    return databaseOrOpen().prepare("SELECT video_id FROM short_video_covers ORDER BY video_id").all()
      .map((row) => String(row.video_id || ""))
      .filter(Boolean);
  }

  function fingerprints() {
    return new Map(databaseOrOpen().prepare(`
      SELECT video_id, source_fingerprint
      FROM short_video_covers
    `).all().map((row) => [
      String(row.video_id || ""),
      String(row.source_fingerprint || "")
    ]).filter(([videoId]) => Boolean(videoId)));
  }

  function status(options = {}) {
    const database = databaseOrOpen();
    const totals = database.prepare(`
      SELECT
        COUNT(*) AS count,
        COALESCE(SUM(byte_length), 0) AS bytes,
        COALESCE(SUM(CASE WHEN byte_length <> length(image_blob) THEN 1 ELSE 0 END), 0) AS invalid
      FROM short_video_covers
    `).get();
    const quickCheck = options.quickCheck === false
      ? "not_run"
      : String(database.prepare("PRAGMA quick_check").get()?.quick_check || "");
    return {
      dbPath,
      count: Number(totals?.count || 0),
      bytes: Number(totals?.bytes || 0),
      invalid: Number(totals?.invalid || 0),
      quickCheck,
      databaseBytes: safeFileSize(dbPath),
      walBytes: safeFileSize(`${dbPath}-wal`)
    };
  }

  function checkpoint() {
    return databaseOrOpen().prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() || null;
  }

  function close() {
    if (!db) return;
    try {
      db.close();
    } catch {}
    db = null;
  }

  function databaseOrOpen() {
    return database();
  }

  return Object.freeze({
    checkpoint,
    close,
    dbPath,
    fingerprints,
    get,
    has,
    ids,
    put,
    putMany,
    remove,
    removeMany,
    status
  });
}

function writeRecords(db, records) {
  const statement = db.prepare(`
    INSERT INTO short_video_covers (
      video_id,
      source_fingerprint,
      source_mtime_ms,
      mime_type,
      byte_length,
      image_blob,
      generation_version,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET
      source_fingerprint = excluded.source_fingerprint,
      source_mtime_ms = excluded.source_mtime_ms,
      mime_type = excluded.mime_type,
      byte_length = excluded.byte_length,
      image_blob = excluded.image_blob,
      generation_version = excluded.generation_version,
      updated_at = excluded.updated_at
  `);
  for (const record of records) {
    statement.run(
      record.videoId,
      record.sourceFingerprint,
      record.sourceMtimeMs,
      record.mimeType,
      record.byteLength,
      record.imageBuffer,
      record.generationVersion,
      record.createdAt,
      record.updatedAt
    );
  }
}

function normalizeCoverRecord(videoId, imageBuffer, metadata = {}) {
  const id = normalizeVideoId(videoId);
  if (!id) throw new Error("short-video cover videoId is required");
  const buffer = Buffer.from(imageBuffer || []);
  if (!isJpegBuffer(buffer)) throw new Error(`short-video cover is not a valid JPEG: ${id}`);
  const now = String(metadata.updatedAt || new Date().toISOString());
  return {
    videoId: id,
    sourceFingerprint: String(metadata.sourceFingerprint || ""),
    sourceMtimeMs: Math.max(0, Math.floor(Number(metadata.sourceMtimeMs || 0))),
    mimeType: "image/jpeg",
    byteLength: buffer.length,
    imageBuffer: buffer,
    generationVersion: Math.max(1, Math.floor(Number(metadata.generationVersion || SHORT_VIDEO_COVER_GENERATION_VERSION))),
    createdAt: String(metadata.createdAt || now),
    updatedAt: now
  };
}

function publicCoverRecord(record) {
  return {
    videoId: record.videoId,
    sourceFingerprint: record.sourceFingerprint,
    sourceMtimeMs: record.sourceMtimeMs,
    mimeType: record.mimeType,
    byteLength: record.byteLength,
    generationVersion: record.generationVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function normalizeVideoId(value) {
  return String(value || "").trim().slice(0, 200);
}

function isJpegBuffer(buffer) {
  return buffer.length >= 4
    && buffer[0] === 0xff
    && buffer[1] === 0xd8
    && buffer[buffer.length - 2] === 0xff
    && buffer[buffer.length - 1] === 0xd9;
}

function safeFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}
