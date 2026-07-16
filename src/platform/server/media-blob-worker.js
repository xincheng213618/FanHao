import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

const db = new DatabaseSync(workerData.dbPath);
db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");

const coreImageQuery = db.prepare("SELECT image_blob, mime FROM images WHERE id = ?");
const actorAvatarQuery = db.prepare(`
  SELECT image_blob, mime
  FROM images
  WHERE owner_type = 'person'
    AND owner_id = ?
    AND kind = 'avatar'
  ORDER BY
    CASE
      WHEN source IN ('manual_upload', 'manual_person_cover', 'manual') THEN 0
      WHEN source = 'actor_profiles' THEN 1
      ELSE 2
    END,
    CASE WHEN image_blob IS NOT NULL THEN 0 ELSE 1 END,
    updated_at DESC,
    id ASC
  LIMIT 1
`);
const workCoverQuery = db.prepare(`
  SELECT image_blob AS cover_blob, mime AS cover_mime
  FROM images
  WHERE owner_type = 'work'
    AND owner_id = ?
    AND kind = 'cover'
  ORDER BY CASE WHEN image_blob IS NOT NULL THEN 0 ELSE 1 END, sort_order ASC, id ASC
  LIMIT 1
`);
const remoteImageQuery = db.prepare("SELECT content_type, image_blob, byte_length, updated_at FROM remote_image_cache WHERE url = ?");
const upsertRemoteImage = db.prepare(`
  INSERT INTO remote_image_cache (
    url, url_hash, content_type, image_blob, byte_length, status, error, fetched_at, updated_at
  )
  VALUES (?, ?, ?, ?, ?, 'ok', '', ?, ?)
  ON CONFLICT(url) DO UPDATE SET
    url_hash = excluded.url_hash,
    content_type = excluded.content_type,
    image_blob = excluded.image_blob,
    byte_length = excluded.byte_length,
    status = 'ok',
    error = '',
    fetched_at = excluded.fetched_at,
    updated_at = excluded.updated_at
`);

parentPort?.on("message", (message) => {
  const id = Number(message?.id || 0);
  const action = String(message?.action || "");
  if (!id || !action) return;

  try {
    parentPort.postMessage({ id, ok: true, value: runAction(action, message) });
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: String(error?.message || error),
      stack: String(error?.stack || "")
    });
  }
});

function runAction(action, message) {
  if (action === "coreImage") return coreImageQuery.get(Number(message.imageId)) || null;
  if (action === "actorAvatar") return actorAvatarQuery.get(Number(message.personId)) || null;
  if (action === "workCover") return workCoverQuery.get(Number(message.workId)) || null;
  if (action === "remoteImage") return remoteImageQuery.get(String(message.url || "")) || null;
  if (action === "cachedRemoteUrls") return cachedRemoteUrls(message.urls);
  if (action === "upsertRemote") return writeRemoteImage(message.record);
  throw new Error(`unknown media blob action: ${action}`);
}

function cachedRemoteUrls(values) {
  const urls = [...new Set((values || []).map((value) => String(value || "")).filter(Boolean))];
  if (!urls.length) return [];
  const cached = [];
  const batchSize = 200;
  for (let offset = 0; offset < urls.length; offset += batchSize) {
    const batch = urls.slice(offset, offset + batchSize);
    const placeholders = batch.map(() => "?").join(", ");
    const rows = db.prepare(`SELECT url FROM remote_image_cache WHERE url IN (${placeholders})`).all(...batch);
    for (const row of rows) cached.push(row.url);
  }
  return cached;
}

function writeRemoteImage(record = {}) {
  const buffer = record.buffer instanceof Uint8Array ? record.buffer : new Uint8Array(record.buffer || []);
  upsertRemoteImage.run(
    String(record.url || ""),
    String(record.urlHash || ""),
    String(record.contentType || "image/jpeg"),
    buffer,
    Number(record.byteLength ?? buffer.byteLength) || 0,
    String(record.updatedAt || ""),
    String(record.updatedAt || "")
  );
  return true;
}
