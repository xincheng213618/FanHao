import crypto from "node:crypto";

import { LOCAL_SHORT_VIDEO_USER_ID } from "./constants.js";

const COLLECTION_NAME_MAX_LENGTH = 40;
const COLLECTION_PAGE_DEFAULT_LIMIT = 48;
const COLLECTION_PAGE_MAX_LIMIT = 120;
const COLLECTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/;
const COLLECTION_RESERVED_IDS = new Set(["collections"]);
const COLLECTION_BUSY_TIMEOUT_MS = 40;
const COLLECTION_BUSY_RETRY_ATTEMPTS = 3;

export function createShortVideoCollectionsRepository({
  database,
  publicVideo,
  resolveVideo,
  runBusyRetry = (work) => work(),
  testHooks = {}
}) {
  function listCollections() {
    return withDatabaseAccess((db) => {
      const rows = db.prepare(`
        SELECT
          collection.id,
          collection.name,
          collection.sort_order,
          collection.created_at,
          collection.updated_at,
          COUNT(video.id) AS item_count,
          COALESCE(MAX(CASE WHEN video.id IS NOT NULL THEN item.added_at ELSE '' END), '') AS latest_added_at
        FROM short_video_collections collection
        LEFT JOIN short_video_collection_items item ON item.collection_id = collection.id
        LEFT JOIN short_video_catalog video ON video.id = item.video_id
        WHERE collection.local_user_id = ?
        GROUP BY collection.id
        ORDER BY collection.sort_order ASC, collection.created_at ASC, collection.id ASC
      `).all(LOCAL_SHORT_VIDEO_USER_ID);
      const collections = rows.map(publicCollection);
      return { collections, total: collections.length };
    });
  }

  function createCollection(input = {}) {
    const name = normalizeCollectionName(input.name);
    const normalizedName = normalizedCollectionNameKey(name);
    return withDatabaseAccess((db) => writeTransaction(db, () => {
      const id = `svc_${crypto.randomUUID().replaceAll("-", "")}`;
      const now = new Date().toISOString();
      const sortOrder = Number(db.prepare(`
        SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
        FROM short_video_collections
        WHERE local_user_id = ?
      `).get(LOCAL_SHORT_VIDEO_USER_ID)?.next_sort_order || 0);
      db.prepare(`
        INSERT INTO short_video_collections (
          id, local_user_id, name, normalized_name, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, LOCAL_SHORT_VIDEO_USER_ID, name, normalizedName, sortOrder, now, now);
      return { collection: collectionById(db, id) };
    }, testHooks));
  }

  function renameCollection(collectionId, input = {}) {
    const id = normalizeCollectionId(collectionId);
    const name = normalizeCollectionName(input.name);
    const normalizedName = normalizedCollectionNameKey(name);
    return withDatabaseAccess((db) => writeTransaction(db, () => {
      requireCollection(db, id);
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE short_video_collections
        SET name = ?, normalized_name = ?, updated_at = ?
        WHERE id = ? AND local_user_id = ?
      `).run(name, normalizedName, now, id, LOCAL_SHORT_VIDEO_USER_ID);
      return { collection: collectionById(db, id) };
    }, testHooks));
  }

  function deleteCollection(collectionId) {
    const id = normalizeCollectionId(collectionId);
    return withDatabaseAccess((db) => writeTransaction(db, () => {
      const collection = requireCollection(db, id);
      const removedItems = Number(db.prepare(`
        SELECT COUNT(*) AS count
        FROM short_video_collection_items
        WHERE collection_id = ?
      `).get(id)?.count || 0);
      db.prepare("DELETE FROM short_video_collections WHERE id = ? AND local_user_id = ?")
        .run(id, LOCAL_SHORT_VIDEO_USER_ID);
      return { ok: true, id, name: collection.name, removedItems };
    }, testHooks));
  }

  function listCollectionVideos(collectionId, urlOrOptions = {}) {
    const id = normalizeCollectionId(collectionId);
    const params = urlOrOptions?.searchParams || new URLSearchParams();
    const limit = clampInteger(params.get("limit"), COLLECTION_PAGE_DEFAULT_LIMIT, 1, COLLECTION_PAGE_MAX_LIMIT);
    const cursor = decodeCollectionCursor(params.get("cursor"));
    return withDatabaseAccess((db) => readTransaction(db, () => {
      const collection = requireCollection(db, id);
      const total = Number(db.prepare(`
        SELECT COUNT(*) AS count
        FROM short_video_collection_items item
        JOIN short_video_catalog video ON video.id = item.video_id
        WHERE item.collection_id = ?
      `).get(id)?.count || 0);
      testHooks.afterCollectionPageCount?.({ collectionId: id, cursor, total });
      const cursorSql = cursor
        ? "AND (item.added_at < ? OR (item.added_at = ? AND item.video_id < ?))"
        : "";
      const cursorParams = cursor ? [cursor.addedAt, cursor.addedAt, cursor.videoId] : [];
      const rows = db.prepare(`
        SELECT video.*, item.added_at AS collection_added_at
        FROM short_video_collection_items item
        JOIN short_video_catalog video ON video.id = item.video_id
        WHERE item.collection_id = ?
          ${cursorSql}
        ORDER BY item.added_at DESC, item.video_id DESC
        LIMIT ?
      `).all(id, ...cursorParams, limit + 1);
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const videos = pageRows.map(publicCollectionVideo);
      const lastRow = pageRows.at(-1);
      return {
        collection: publicCollection(collection),
        videos,
        count: videos.length,
        total,
        limit,
        cursor: cursor ? encodeCollectionCursor(cursor) : null,
        hasMore,
        nextCursor: hasMore && lastRow
          ? encodeCollectionCursor({ addedAt: lastRow.collection_added_at || "", videoId: lastRow.id })
          : null
      };
    }, testHooks));
  }

  function collectionVideoDetail(collectionId, videoId) {
    const id = normalizeCollectionId(collectionId);
    const lookup = normalizeVideoId(videoId);
    return withDatabaseAccess((db) => readTransaction(db, () => {
      const collection = requireCollection(db, id);
      const video = resolveVideo(db, lookup);
      if (!video?.id) throw httpError(404, "没有找到这个短视频");
      const current = collectionVideoRow(db, id, video.id);
      if (!current) throw httpError(404, "这个短视频不在该清单中");
      const previous = db.prepare(`
        SELECT candidate.*, item.added_at AS collection_added_at
        FROM short_video_collection_items item
        JOIN short_video_catalog candidate ON candidate.id = item.video_id
        WHERE item.collection_id = ?
          AND (item.added_at > ? OR (item.added_at = ? AND item.video_id > ?))
        ORDER BY item.added_at ASC, item.video_id ASC
        LIMIT 1
      `).get(id, current.collection_added_at, current.collection_added_at, current.id);
      const next = db.prepare(`
        SELECT candidate.*, item.added_at AS collection_added_at
        FROM short_video_collection_items item
        JOIN short_video_catalog candidate ON candidate.id = item.video_id
        WHERE item.collection_id = ?
          AND (item.added_at < ? OR (item.added_at = ? AND item.video_id < ?))
        ORDER BY item.added_at DESC, item.video_id DESC
        LIMIT 1
      `).get(id, current.collection_added_at, current.collection_added_at, current.id);
      return {
        collection: publicCollection(collection),
        video: publicCollectionVideo(current),
        prevId: String(previous?.id || ""),
        nextId: String(next?.id || ""),
        prevVideo: previous ? publicCollectionVideo(previous) : null,
        nextVideo: next ? publicCollectionVideo(next) : null
      };
    }, testHooks));
  }

  function addCollectionVideo(collectionId, videoId) {
    const id = normalizeCollectionId(collectionId);
    const lookup = normalizeVideoId(videoId);
    return withDatabaseAccess((db) => writeTransaction(db, () => {
      requireCollection(db, id);
      const video = requireVideo(db, lookup);
      const now = new Date().toISOString();
      const inserted = db.prepare(`
        INSERT OR IGNORE INTO short_video_collection_items (collection_id, video_id, added_at)
        VALUES (?, ?, ?)
      `).run(id, video.id, now);
      const added = Number(inserted.changes || 0) > 0;
      const addedAt = added
        ? now
        : String(db.prepare(`
          SELECT added_at FROM short_video_collection_items
          WHERE collection_id = ? AND video_id = ?
        `).get(id, video.id)?.added_at || "");
      if (added) {
        db.prepare(`
          UPDATE short_video_collections
          SET updated_at = ?
          WHERE id = ? AND local_user_id = ?
        `).run(now, id, LOCAL_SHORT_VIDEO_USER_ID);
      }
      return { added, collectionId: id, videoId: video.id, addedAt };
    }, testHooks));
  }

  function removeCollectionVideo(collectionId, videoId) {
    const id = normalizeCollectionId(collectionId);
    const lookup = normalizeVideoId(videoId);
    return withDatabaseAccess((db) => writeTransaction(db, () => {
      requireCollection(db, id);
      const video = requireVideo(db, lookup);
      const result = db.prepare(`
        DELETE FROM short_video_collection_items
        WHERE collection_id = ? AND video_id = ?
      `).run(id, video.id);
      const removed = Number(result.changes || 0) > 0;
      if (removed) {
        db.prepare(`
          UPDATE short_video_collections
          SET updated_at = ?
          WHERE id = ? AND local_user_id = ?
        `).run(new Date().toISOString(), id, LOCAL_SHORT_VIDEO_USER_ID);
      }
      return { removed, collectionId: id, videoId: video.id };
    }, testHooks));
  }

  function withDatabaseAccess(work) {
    const db = database();
    const previousTimeout = Math.max(0, Number(db.prepare("PRAGMA busy_timeout").get()?.timeout || 0));
    db.exec(`PRAGMA busy_timeout = ${COLLECTION_BUSY_TIMEOUT_MS}`);
    try {
      return runBusyRetry(() => work(db), COLLECTION_BUSY_RETRY_ATTEMPTS);
    } catch (error) {
      throw publicCollectionError(error);
    } finally {
      db.exec(`PRAGMA busy_timeout = ${previousTimeout}`);
    }
  }

  function requireVideo(db, videoId) {
    const row = resolveVideo(db, videoId, "id");
    if (row) return row;
    throw httpError(404, "没有找到这个短视频");
  }

  function publicCollectionVideo(row = {}) {
    return {
      ...publicVideo(row),
      collectionAddedAt: String(row.collection_added_at || "")
    };
  }

  return Object.freeze({
    addCollectionVideo,
    collectionVideoDetail,
    createCollection,
    deleteCollection,
    listCollections,
    listCollectionVideos,
    removeCollectionVideo,
    renameCollection
  });
}

export function normalizeCollectionName(value) {
  const name = String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  if (!name) throw httpError(400, "清单名称不能为空");
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(name)) throw httpError(400, "清单名称包含无效字符");
  if (Array.from(name).length > COLLECTION_NAME_MAX_LENGTH) {
    throw httpError(400, `清单名称不能超过 ${COLLECTION_NAME_MAX_LENGTH} 个字符`);
  }
  return name;
}

export function normalizedCollectionNameKey(value) {
  return normalizeCollectionName(value).toLowerCase();
}

export function encodeCollectionCursor({ addedAt = "", videoId = "" } = {}) {
  return Buffer.from(JSON.stringify([String(addedAt || ""), normalizeVideoId(videoId)]), "utf8").toString("base64url");
}

function decodeCollectionCursor(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw httpError(400, "清单分页游标无效");
  try {
    const decoded = Buffer.from(raw, "base64url");
    if (decoded.toString("base64url") !== raw) throw new Error("non-canonical cursor");
    const parsed = JSON.parse(decoded.toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error("invalid cursor shape");
    const addedAt = String(parsed[0] ?? "");
    if (addedAt.length > 64 || /[\u0000-\u001f\u007f-\u009f]/u.test(addedAt)) throw new Error("invalid cursor timestamp");
    return { addedAt, videoId: normalizeVideoId(parsed[1]) };
  } catch (error) {
    if (error?.statusCode) throw error;
    throw httpError(400, "清单分页游标无效");
  }
}

function normalizeCollectionId(value) {
  const id = String(value ?? "").trim();
  if (!COLLECTION_ID_PATTERN.test(id) || COLLECTION_RESERVED_IDS.has(id.toLowerCase())) {
    throw httpError(400, "清单 ID 无效");
  }
  return id;
}

function normalizeVideoId(value) {
  const id = String(value ?? "").trim();
  if (!id || id.length > 200 || /[\u0000-\u001f\u007f-\u009f/\\]/u.test(id)) {
    throw httpError(400, "短视频 ID 无效");
  }
  return id;
}

function collectionById(db, id) {
  return publicCollection(requireCollection(db, id));
}

function requireCollection(db, id) {
  const row = db.prepare(`
    SELECT
      collection.id,
      collection.name,
      collection.sort_order,
      collection.created_at,
      collection.updated_at,
      COUNT(video.id) AS item_count,
      COALESCE(MAX(CASE WHEN video.id IS NOT NULL THEN item.added_at ELSE '' END), '') AS latest_added_at
    FROM short_video_collections collection
    LEFT JOIN short_video_collection_items item ON item.collection_id = collection.id
    LEFT JOIN short_video_catalog video ON video.id = item.video_id
    WHERE collection.id = ? AND collection.local_user_id = ?
    GROUP BY collection.id
  `).get(id, LOCAL_SHORT_VIDEO_USER_ID);
  if (row) return row;
  throw httpError(404, "没有找到这个清单");
}

function collectionVideoRow(db, collectionId, videoId) {
  return db.prepare(`
    SELECT video.*, item.added_at AS collection_added_at
    FROM short_video_collection_items item
    JOIN short_video_catalog video ON video.id = item.video_id
    WHERE item.collection_id = ? AND item.video_id = ?
  `).get(collectionId, videoId);
}

function publicCollection(row = {}) {
  return {
    id: String(row.id || ""),
    name: String(row.name || ""),
    itemCount: Math.max(0, Number(row.item_count || 0)),
    latestAddedAt: String(row.latest_added_at || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || "")
  };
}

function readTransaction(db, work, testHooks = {}) {
  beginTransaction(db, "BEGIN", testHooks);
  try {
    testHooks.afterCollectionTransactionBegin?.({ db, statement: "BEGIN" });
    const result = work();
    testHooks.afterCollectionTransactionWork?.({ db, statement: "BEGIN" });
    testHooks.beforeCollectionTransactionStatement?.({ db, statement: "COMMIT" });
    db.exec("COMMIT");
    return result;
  } catch (error) {
    rollback(db);
    throw error;
  }
}

function writeTransaction(db, work, testHooks = {}) {
  beginTransaction(db, "BEGIN IMMEDIATE", testHooks);
  try {
    testHooks.afterCollectionTransactionBegin?.({ db, statement: "BEGIN IMMEDIATE" });
    const result = work();
    testHooks.afterCollectionTransactionWork?.({ db, statement: "BEGIN IMMEDIATE" });
    testHooks.beforeCollectionTransactionStatement?.({ db, statement: "COMMIT" });
    db.exec("COMMIT");
    return result;
  } catch (error) {
    rollback(db);
    throw error;
  }
}

function beginTransaction(db, statement, testHooks = {}) {
  try {
    testHooks.beforeCollectionTransactionStatement?.({ db, statement });
    db.exec(statement);
  } catch (error) {
    if (db.isTransaction) rollback(db);
    throw error;
  }
}

function publicCollectionError(error) {
  if (isSqliteBusy(error)) {
    const busy = httpError(503, "短视频数据库正忙，请稍后重试");
    busy.retryable = true;
    return busy;
  }
  const message = String(error?.message || error || "");
  if (/UNIQUE constraint failed: short_video_collections\.local_user_id, short_video_collections\.normalized_name/i.test(message)) {
    return httpError(409, "已经有同名清单");
  }
  return error;
}

function isSqliteBusy(error) {
  return Number(error?.errcode) === 5
    || Number(error?.errno) === 5
    || String(error?.code || "").toUpperCase() === "SQLITE_BUSY"
    || /database is locked|database table is locked|SQLITE_BUSY/i.test(String(error?.message || error || ""));
}

function clampInteger(value, fallback, min, max) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function rollback(db) {
  try {
    db.exec("ROLLBACK");
  } catch {}
}
