import crypto from "node:crypto";

import { LOCAL_SHORT_VIDEO_USER_ID } from "./constants.js";

const COLLECTION_NAME_MAX_LENGTH = 40;
const COLLECTION_PAGE_DEFAULT_LIMIT = 48;
const COLLECTION_PAGE_MAX_LIMIT = 120;
const COLLECTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/;

export function createShortVideoCollectionsRepository({ database, publicVideo, resolveVideo }) {
  function listCollections() {
    const rows = database().prepare(`
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
  }

  function createCollection(input = {}) {
    const db = database();
    const name = normalizeCollectionName(input.name);
    assertUniqueCollectionName(db, name);
    const id = `svc_${crypto.randomUUID().replaceAll("-", "")}`;
    const now = new Date().toISOString();
    const sortOrder = Number(db.prepare(`
      SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
      FROM short_video_collections
      WHERE local_user_id = ?
    `).get(LOCAL_SHORT_VIDEO_USER_ID)?.next_sort_order || 0);
    db.prepare(`
      INSERT INTO short_video_collections (
        id, local_user_id, name, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, LOCAL_SHORT_VIDEO_USER_ID, name, sortOrder, now, now);
    return { collection: collectionById(db, id) };
  }

  function renameCollection(collectionId, input = {}) {
    const db = database();
    const id = normalizeCollectionId(collectionId);
    requireCollection(db, id);
    const name = normalizeCollectionName(input.name);
    assertUniqueCollectionName(db, name, id);
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE short_video_collections
      SET name = ?, updated_at = ?
      WHERE id = ? AND local_user_id = ?
    `).run(name, now, id, LOCAL_SHORT_VIDEO_USER_ID);
    return { collection: collectionById(db, id) };
  }

  function deleteCollection(collectionId) {
    const db = database();
    const id = normalizeCollectionId(collectionId);
    const collection = requireCollection(db, id);
    db.exec("BEGIN");
    try {
      const removedItems = db.prepare("DELETE FROM short_video_collection_items WHERE collection_id = ?").run(id);
      db.prepare("DELETE FROM short_video_collections WHERE id = ? AND local_user_id = ?")
        .run(id, LOCAL_SHORT_VIDEO_USER_ID);
      db.exec("COMMIT");
      return {
        ok: true,
        id,
        name: collection.name,
        removedItems: Number(removedItems.changes || 0)
      };
    } catch (error) {
      rollback(db);
      throw error;
    }
  }

  function listCollectionVideos(collectionId, urlOrOptions = {}) {
    const db = database();
    const id = normalizeCollectionId(collectionId);
    const collection = requireCollection(db, id);
    const params = urlOrOptions?.searchParams || new URLSearchParams();
    const limit = clampInteger(params.get("limit"), COLLECTION_PAGE_DEFAULT_LIMIT, 1, COLLECTION_PAGE_MAX_LIMIT);
    const offset = clampInteger(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const total = Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM short_video_collection_items item
      JOIN short_video_catalog video ON video.id = item.video_id
      WHERE item.collection_id = ?
    `).get(id)?.count || 0);
    const rows = db.prepare(`
      SELECT video.*, item.added_at AS collection_added_at
      FROM short_video_collection_items item
      JOIN short_video_catalog video ON video.id = item.video_id
      WHERE item.collection_id = ?
      ORDER BY item.added_at DESC, item.video_id DESC
      LIMIT ? OFFSET ?
    `).all(id, limit, offset);
    const videos = rows.map((row) => ({
      ...publicVideo(row),
      collectionAddedAt: row.collection_added_at || ""
    }));
    return {
      collection: publicCollection(collection),
      videos,
      count: videos.length,
      total,
      limit,
      offset,
      hasMore: offset + videos.length < total,
      nextOffset: offset + videos.length < total ? offset + videos.length : null
    };
  }

  function addCollectionVideo(collectionId, videoId) {
    const db = database();
    const id = normalizeCollectionId(collectionId);
    requireCollection(db, id);
    const video = requireVideo(db, videoId);
    const existing = db.prepare(`
      SELECT added_at
      FROM short_video_collection_items
      WHERE collection_id = ? AND video_id = ?
    `).get(id, video.id);
    if (existing) {
      return { added: false, collectionId: id, videoId: video.id, addedAt: existing.added_at || "" };
    }
    const now = new Date().toISOString();
    db.exec("BEGIN");
    try {
      db.prepare(`
        INSERT OR IGNORE INTO short_video_collection_items (collection_id, video_id, added_at)
        VALUES (?, ?, ?)
      `).run(id, video.id, now);
      db.prepare(`
        UPDATE short_video_collections
        SET updated_at = ?
        WHERE id = ? AND local_user_id = ?
      `).run(now, id, LOCAL_SHORT_VIDEO_USER_ID);
      db.exec("COMMIT");
    } catch (error) {
      rollback(db);
      throw error;
    }
    return { added: true, collectionId: id, videoId: video.id, addedAt: now };
  }

  function removeCollectionVideo(collectionId, videoId) {
    const db = database();
    const id = normalizeCollectionId(collectionId);
    requireCollection(db, id);
    const video = requireVideo(db, videoId);
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
  }

  function requireVideo(db, videoId) {
    const id = normalizeVideoId(videoId);
    const row = resolveVideo(db, id, "id");
    if (row) return row;
    throw httpError(404, "没有找到这个短视频");
  }

  return Object.freeze({
    addCollectionVideo,
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

function normalizeCollectionId(value) {
  const id = String(value ?? "").trim();
  if (!COLLECTION_ID_PATTERN.test(id)) throw httpError(400, "清单 ID 无效");
  return id;
}

function normalizeVideoId(value) {
  const id = String(value ?? "").trim();
  if (!id || id.length > 200 || /[\u0000-\u001f\u007f-\u009f/\\]/u.test(id)) {
    throw httpError(400, "短视频 ID 无效");
  }
  return id;
}

function assertUniqueCollectionName(db, name, excludedId = "") {
  const normalized = name.toLocaleLowerCase();
  const conflict = db.prepare(`
    SELECT id, name
    FROM short_video_collections
    WHERE local_user_id = ? AND id <> ?
  `).all(LOCAL_SHORT_VIDEO_USER_ID, excludedId).find((row) => (
    normalizeStoredCollectionName(row.name).toLocaleLowerCase() === normalized
  ));
  if (conflict) throw httpError(409, "已经有同名清单");
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

function normalizeStoredCollectionName(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function clampInteger(value, fallback, min, max) {
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
