import { randomUUID } from "node:crypto";
import { hasSqliteTables } from "../../../../platform/server/sqlite-schema.js";

export const ACTOR_PROFILE_PUBLICATION_TABLE = "actor_profile_publications";
export const ACTOR_PROFILE_IMAGE_STAGING_TABLE = "actor_profile_image_staging";
export const ACTOR_PROFILE_IMAGE_REVOCATION_TABLE = "actor_profile_image_revocations";
export const ACTOR_PROFILE_IMAGE_GC_RECEIPT_TABLE = "actor_profile_image_gc_receipts";
export const ACTOR_PROFILE_REVOCATION_CALLER = "local-admin";
export const ACTOR_PROFILE_REVOCATION_AUDIT_VERSION = 2;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function mainTableColumns(db, tableName) {
  return new Set(db.prepare(`PRAGMA main.table_info(${tableName})`).all().map((row) => String(row.name)));
}

function migrateRevocationAuditColumns(db, {
  boundaryHook = () => {},
  generateRequestId = randomUUID
} = {}) {
  const columns = mainTableColumns(db, ACTOR_PROFILE_IMAGE_REVOCATION_TABLE);
  const missingRequestId = !columns.has("request_id");
  const missingCaller = !columns.has("caller");
  const missingAuditVersion = !columns.has("audit_version");
  const migrationRequired = missingRequestId || missingCaller || missingAuditVersion;
  if (!migrationRequired) return false;

  db.exec("DROP TRIGGER IF EXISTS main.actor_profile_image_revocations_immutable_update");
  if (missingRequestId) {
    db.exec(`ALTER TABLE main.${ACTOR_PROFILE_IMAGE_REVOCATION_TABLE} ADD COLUMN request_id TEXT NOT NULL DEFAULT ''`);
  }
  if (missingCaller) {
    db.exec(`ALTER TABLE main.${ACTOR_PROFILE_IMAGE_REVOCATION_TABLE} ADD COLUMN caller TEXT NOT NULL DEFAULT ''`);
  }
  if (missingAuditVersion) {
    db.exec(`ALTER TABLE main.${ACTOR_PROFILE_IMAGE_REVOCATION_TABLE} ADD COLUMN audit_version INTEGER NOT NULL DEFAULT 1`);
  }
  boundaryHook("revocation_audit_schema_columns_added");

  const legacyRows = db.prepare(`
    SELECT operation_id
    FROM main.${ACTOR_PROFILE_IMAGE_REVOCATION_TABLE}
    ORDER BY operation_id
  `).all();
  const backfill = db.prepare(`
    UPDATE main.${ACTOR_PROFILE_IMAGE_REVOCATION_TABLE}
    SET request_id = ?, caller = ?, audit_version = 1
    WHERE operation_id = ?
  `);
  for (const row of legacyRows) {
    backfill.run(String(generateRequestId()), ACTOR_PROFILE_REVOCATION_CALLER, String(row.operation_id));
  }
  boundaryHook("revocation_audit_schema_backfilled");
  return true;
}

export function ensureActorProfilePublicationTable(db, options = {}) {
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
    CREATE TABLE IF NOT EXISTS main.${ACTOR_PROFILE_IMAGE_REVOCATION_TABLE} (
      operation_id TEXT PRIMARY KEY,
      person_id INTEGER NOT NULL,
      intent_sha256 TEXT NOT NULL,
      reason TEXT NOT NULL,
      revoked_at TEXT NOT NULL,
      tombstone_sha256 TEXT NOT NULL,
      request_id TEXT NOT NULL DEFAULT '',
      caller TEXT NOT NULL DEFAULT '',
      audit_version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
  `);
  const migratedRevocationAudit = migrateRevocationAuditColumns(db, options);
  db.exec(`
    CREATE INDEX IF NOT EXISTS main.idx_actor_profile_image_revocations_person
      ON ${ACTOR_PROFILE_IMAGE_REVOCATION_TABLE}(person_id, revoked_at, operation_id);
    CREATE UNIQUE INDEX IF NOT EXISTS main.idx_actor_profile_image_revocations_request_id
      ON ${ACTOR_PROFILE_IMAGE_REVOCATION_TABLE}(request_id);
    CREATE TRIGGER IF NOT EXISTS main.actor_profile_image_revocations_authorized_insert
      BEFORE INSERT ON ${ACTOR_PROFILE_IMAGE_REVOCATION_TABLE}
      WHEN NEW.audit_version <> ${ACTOR_PROFILE_REVOCATION_AUDIT_VERSION}
        OR NEW.caller <> '${ACTOR_PROFILE_REVOCATION_CALLER}'
        OR length(NEW.request_id) <> 36
        OR substr(NEW.request_id, 9, 1) <> '-'
        OR substr(NEW.request_id, 14, 1) <> '-'
        OR substr(NEW.request_id, 19, 1) <> '-'
        OR substr(NEW.request_id, 24, 1) <> '-'
        OR COALESCE(fanhao_actor_profile_revoke_authorized(
          NEW.operation_id,
          NEW.person_id,
          NEW.intent_sha256,
          NEW.reason,
          NEW.revoked_at,
          NEW.tombstone_sha256,
          NEW.request_id,
          NEW.caller,
          NEW.audit_version
        ), 0) <> 1 BEGIN
        SELECT RAISE(ABORT, 'actor profile image revocations require local authorization');
      END;
    CREATE TRIGGER IF NOT EXISTS main.actor_profile_image_revocations_immutable_update
      BEFORE UPDATE ON ${ACTOR_PROFILE_IMAGE_REVOCATION_TABLE} BEGIN
        SELECT RAISE(ABORT, 'actor profile image revocations are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS main.actor_profile_image_revocations_immutable_delete
      BEFORE DELETE ON ${ACTOR_PROFILE_IMAGE_REVOCATION_TABLE} BEGIN
        SELECT RAISE(ABORT, 'actor profile image revocations are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS main.actor_profile_publications_reject_revoked_insert
      BEFORE INSERT ON ${ACTOR_PROFILE_PUBLICATION_TABLE}
      WHEN EXISTS (
        SELECT 1 FROM ${ACTOR_PROFILE_IMAGE_REVOCATION_TABLE} revocation
        WHERE revocation.operation_id = NEW.operation_id
      ) BEGIN
        SELECT RAISE(ABORT, 'revoked actor profile image versions cannot be published');
      END;
    CREATE TRIGGER IF NOT EXISTS main.actor_profile_publications_reject_revoked_update
      BEFORE UPDATE ON ${ACTOR_PROFILE_PUBLICATION_TABLE}
      WHEN EXISTS (
        SELECT 1 FROM ${ACTOR_PROFILE_IMAGE_REVOCATION_TABLE} revocation
        WHERE revocation.operation_id = NEW.operation_id
      ) BEGIN
        SELECT RAISE(ABORT, 'revoked actor profile image versions cannot be published');
      END;
  `);
  const invalidAuditRow = db.prepare(`
    SELECT request_id, caller, audit_version
    FROM main.${ACTOR_PROFILE_IMAGE_REVOCATION_TABLE}
  `).all().some((row) => (
    !UUID_PATTERN.test(String(row.request_id || ""))
    || String(row.caller || "") !== ACTOR_PROFILE_REVOCATION_CALLER
    || ![1, ACTOR_PROFILE_REVOCATION_AUDIT_VERSION].includes(Number(row.audit_version))
  ));
  if (invalidAuditRow) throw new Error("actor profile image revocation audit identity is invalid");
  return { migratedRevocationAudit };
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
    CREATE TABLE IF NOT EXISTS ${schema}.${ACTOR_PROFILE_IMAGE_GC_RECEIPT_TABLE} (
      operation_id TEXT PRIMARY KEY,
      person_id INTEGER NOT NULL,
      intent_sha256 TEXT NOT NULL,
      tombstone_sha256 TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      deleted_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ${schema}.idx_actor_profile_image_gc_receipts_deleted_at
      ON ${ACTOR_PROFILE_IMAGE_GC_RECEIPT_TABLE}(deleted_at, operation_id);
    CREATE TRIGGER IF NOT EXISTS ${schema}.actor_profile_image_gc_receipts_authorized_insert
      BEFORE INSERT ON ${ACTOR_PROFILE_IMAGE_GC_RECEIPT_TABLE}
      WHEN COALESCE(fanhao_actor_profile_gc_authorized(
        NEW.operation_id,
        NEW.person_id,
        NEW.intent_sha256,
        NEW.tombstone_sha256,
        NEW.content_sha256,
        NEW.byte_size
      ), 0) <> 1 BEGIN
        SELECT RAISE(ABORT, 'actor profile image gc receipts require local authorization');
      END;
    CREATE TRIGGER IF NOT EXISTS ${schema}.actor_profile_image_gc_receipts_immutable_update
      BEFORE UPDATE ON ${ACTOR_PROFILE_IMAGE_GC_RECEIPT_TABLE} BEGIN
        SELECT RAISE(ABORT, 'actor profile image gc receipts are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS ${schema}.actor_profile_image_gc_receipts_immutable_delete
      BEFORE DELETE ON ${ACTOR_PROFILE_IMAGE_GC_RECEIPT_TABLE} BEGIN
        SELECT RAISE(ABORT, 'actor profile image gc receipts are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS ${schema}.actor_profile_image_staging_reject_collected_insert
      BEFORE INSERT ON ${ACTOR_PROFILE_IMAGE_STAGING_TABLE}
      WHEN EXISTS (
        SELECT 1 FROM ${ACTOR_PROFILE_IMAGE_GC_RECEIPT_TABLE} receipt
        WHERE receipt.operation_id = NEW.operation_id
      ) BEGIN
        SELECT RAISE(ABORT, 'collected actor profile image stages cannot be recreated');
      END;
    CREATE TRIGGER IF NOT EXISTS ${schema}.actor_profile_image_staging_immutable_update
      BEFORE UPDATE ON ${ACTOR_PROFILE_IMAGE_STAGING_TABLE} BEGIN
        SELECT RAISE(ABORT, 'actor profile image staging rows are immutable');
      END;
    DROP TRIGGER IF EXISTS ${schema}.actor_profile_image_staging_immutable_delete;
    CREATE TRIGGER ${schema}.actor_profile_image_staging_immutable_delete
      BEFORE DELETE ON ${ACTOR_PROFILE_IMAGE_STAGING_TABLE}
      WHEN NOT EXISTS (
        SELECT 1 FROM ${ACTOR_PROFILE_IMAGE_GC_RECEIPT_TABLE} receipt
        WHERE receipt.operation_id = OLD.operation_id
          AND receipt.person_id = OLD.person_id
          AND receipt.intent_sha256 = OLD.intent_sha256
          AND receipt.tombstone_sha256 <> ''
          AND receipt.content_sha256 <> ''
          AND receipt.byte_size = COALESCE(OLD.byte_size, length(OLD.image_blob), 0)
      ) OR COALESCE(fanhao_actor_profile_gc_authorized(
        OLD.operation_id,
        OLD.person_id,
        OLD.intent_sha256,
        (SELECT receipt.tombstone_sha256
         FROM ${ACTOR_PROFILE_IMAGE_GC_RECEIPT_TABLE} receipt
         WHERE receipt.operation_id = OLD.operation_id),
        (SELECT receipt.content_sha256
         FROM ${ACTOR_PROFILE_IMAGE_GC_RECEIPT_TABLE} receipt
         WHERE receipt.operation_id = OLD.operation_id),
        COALESCE(OLD.byte_size, length(OLD.image_blob), 0)
      ), 0) <> 1 BEGIN
        SELECT RAISE(ABORT, 'actor profile image staging rows are immutable');
      END;
  `);
}

export function hasActorProfilePublicationReadModel(db) {
  try {
    return hasSqliteTables(db, "main", [
      ACTOR_PROFILE_PUBLICATION_TABLE,
      ACTOR_PROFILE_IMAGE_REVOCATION_TABLE,
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
