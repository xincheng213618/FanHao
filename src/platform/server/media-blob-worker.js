import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { attachCoreImageStore } from "./core-image-store.js";
import { hasSqliteTables } from "./sqlite-schema.js";

function hasActorProfilePublicationReadModel(db) {
  return hasSqliteTables(db, "main", [
    "actor_profile_publications", "cross_store_intents", "cross_store_operation_state", "cross_store_main_receipts"
  ]) && hasSqliteTables(db, "fanhao_images", ["actor_profile_image_staging", "cross_store_receipts"]);
}

const db = new DatabaseSync(workerData.dbPath);
db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
attachCoreImageStore(db, { dbPath: workerData.imageDbPath });

const coreImageQuery = db.prepare("SELECT image_blob, mime FROM fanhao_images.images WHERE id = ?");
const hasPublishedActorAvatars = hasActorProfilePublicationReadModel(db);
const completedActorAvatarVersionQuery = hasPublishedActorAvatars ? db.prepare(`
  SELECT stage.image_blob, stage.mime
  FROM cross_store_intents intent
  JOIN cross_store_operation_state state
    ON state.op_id = intent.op_id AND state.status = 'completed'
  JOIN cross_store_main_receipts receipt
    ON receipt.op_id = intent.op_id
   AND receipt.step = 'visibility_switch'
   AND receipt.intent_sha256 = intent.intent_sha256
  JOIN fanhao_images.cross_store_receipts image_receipt
    ON image_receipt.op_id = intent.op_id
   AND image_receipt.step = 'image_stage'
   AND image_receipt.kind = intent.kind
   AND image_receipt.aggregate_key = intent.aggregate_key
   AND image_receipt.intent_sha256 = intent.intent_sha256
  JOIN fanhao_images.actor_profile_image_staging stage
    ON stage.operation_id = intent.op_id
   AND stage.intent_sha256 = receipt.intent_sha256
  WHERE intent.kind = 'actor_profile_upsert'
    AND stage.person_id = ?
    AND stage.operation_id = ?
`) : null;
const currentActorAvatarQuery = hasPublishedActorAvatars ? db.prepare(`
  WITH avatar_candidates AS (
    SELECT image.image_blob, image.mime, image.source, image.updated_at,
           image.id AS live_image_id, CAST(image.id AS TEXT) AS stable_id, 1 AS publication_rank
    FROM fanhao_images.images image
    WHERE image.owner_type = 'person' AND image.owner_id = ? AND image.kind = 'avatar'
    UNION ALL
    SELECT stage.image_blob, stage.mime, stage.source, stage.updated_at,
           NULL AS live_image_id, stage.operation_id AS stable_id, 0 AS publication_rank
    FROM actor_profile_publications publication
    JOIN cross_store_operation_state state
      ON state.op_id = publication.operation_id AND state.status = 'completed'
    JOIN cross_store_main_receipts receipt
      ON receipt.op_id = publication.operation_id
     AND receipt.step = 'visibility_switch'
     AND receipt.intent_sha256 = publication.intent_sha256
    JOIN fanhao_images.actor_profile_image_staging stage
      ON stage.operation_id = publication.operation_id
     AND stage.person_id = publication.person_id
     AND stage.intent_sha256 = publication.intent_sha256
    WHERE publication.person_id = ?
  )
  SELECT image_blob, mime
  FROM avatar_candidates
  ORDER BY
    CASE
      WHEN source IN ('manual_upload', 'manual_person_cover', 'manual') THEN 0
      WHEN source = 'actor_profiles' THEN 1
      ELSE 2
    END,
    publication_rank ASC,
    CASE WHEN image_blob IS NOT NULL THEN 0 ELSE 1 END,
    updated_at DESC,
    live_image_id ASC,
    stable_id ASC
  LIMIT 1
`) : db.prepare(`
  SELECT image_blob, mime
  FROM fanhao_images.images
  WHERE owner_type = 'person' AND owner_id = ? AND kind = 'avatar'
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
  FROM fanhao_images.images
  WHERE owner_type = 'work'
    AND owner_id = ?
    AND kind = 'cover'
  ORDER BY CASE WHEN image_blob IS NOT NULL THEN 0 ELSE 1 END, sort_order ASC, id ASC
  LIMIT 1
`);
const remoteImageQuery = db.prepare("SELECT content_type, image_blob, byte_length, updated_at FROM fanhao_images.remote_image_cache WHERE url = ?");
const upsertRemoteImage = db.prepare(`
  INSERT INTO fanhao_images.remote_image_cache (
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
  if (action === "actorAvatar") {
    const personId = Number(message.personId);
    const version = String(message.version || "");
    if (version) return completedActorAvatarVersionQuery?.get(personId, version) || null;
    return hasPublishedActorAvatars
      ? currentActorAvatarQuery.get(personId, personId) || null
      : currentActorAvatarQuery.get(personId) || null;
  }
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
    const rows = db.prepare(`SELECT url FROM fanhao_images.remote_image_cache WHERE url IN (${placeholders})`).all(...batch);
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
