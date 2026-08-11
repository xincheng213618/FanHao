import { hasSqliteTables } from "../../../../platform/server/sqlite-schema.js";

export const ACTOR_PROFILE_PUBLICATION_TABLE = "actor_profile_publications";
export const ACTOR_PROFILE_IMAGE_STAGING_TABLE = "actor_profile_image_staging";

export function ensureActorProfilePublicationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS main.${ACTOR_PROFILE_PUBLICATION_TABLE} (
      person_id INTEGER PRIMARY KEY,
      operation_id TEXT NOT NULL UNIQUE,
      intent_sha256 TEXT NOT NULL,
      published_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS main.idx_actor_profile_publications_updated_at
      ON ${ACTOR_PROFILE_PUBLICATION_TABLE}(updated_at);
  `);
}

export function ensureActorProfileImageStagingTable(db, schema = "fanhao_images") {
  if (!/^[A-Za-z0-9_]+$/.test(schema)) throw new Error(`Invalid image schema: ${schema}`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${schema}.${ACTOR_PROFILE_IMAGE_STAGING_TABLE} (
      operation_id TEXT PRIMARY KEY,
      person_id INTEGER NOT NULL,
      intent_sha256 TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK(source_type IN ('local', 'remote', 'generated', 'unknown')),
      local_path TEXT,
      remote_url TEXT,
      mime TEXT,
      image_blob BLOB,
      byte_size INTEGER,
      status TEXT NOT NULL DEFAULT 'ok',
      source TEXT NOT NULL,
      legacy_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ${schema}.idx_actor_profile_image_staging_person
      ON ${ACTOR_PROFILE_IMAGE_STAGING_TABLE}(person_id, updated_at);
    CREATE TRIGGER IF NOT EXISTS ${schema}.actor_profile_image_staging_immutable_update
      BEFORE UPDATE ON ${ACTOR_PROFILE_IMAGE_STAGING_TABLE} BEGIN
        SELECT RAISE(ABORT, 'actor profile image staging rows are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS ${schema}.actor_profile_image_staging_immutable_delete
      BEFORE DELETE ON ${ACTOR_PROFILE_IMAGE_STAGING_TABLE} BEGIN
        SELECT RAISE(ABORT, 'actor profile image staging rows are immutable');
      END;
  `);
}

export function hasActorProfilePublicationReadModel(db) {
  try {
    return hasSqliteTables(db, "main", [
      ACTOR_PROFILE_PUBLICATION_TABLE,
      "cross_store_operation_state",
      "cross_store_main_receipts"
    ]) && hasSqliteTables(db, "fanhao_images", [
      ACTOR_PROFILE_IMAGE_STAGING_TABLE,
      "cross_store_receipts"
    ]);
  } catch {
    return false;
  }
}
