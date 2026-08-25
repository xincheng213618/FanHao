import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SHORT_VIDEO_DELETE_QUARANTINE_DIR = ".fanhao-short-video-delete-quarantine";

const ACTIVE_STATUSES = ["running", "rollback_pending", "cleanup_pending"];
const TERMINAL_STATUSES = ["completed", "rolled_back"];
const OWNER_MARKER = ".owner";
const GUARD_PREFIX = "FANHAO_SHORT_VIDEO_DELETE_GUARD";
const PATH_REFERENCE_TABLE = "short_video_path_references";
const PATH_TOMBSTONE_TABLE = "short_video_path_tombstones";
const VIDEO_TOMBSTONE_TABLE = "short_video_delete_video_tombstones";
const FS_ACTION_TABLE = "short_video_delete_fs_actions";
const OPERATION_TABLE = "short_video_delete_operations";
const PATH_COLUMNS = ["source_path", "cover_path", "music_path", "data_path"];
const DELETE_PROTOCOL_VERSION_META = "short_video_delete_protocol_version";
const DELETE_PROTOCOL_VERSION = "5";
const DELETE_REQUEST_PROTOCOL = "fanhao.short-video-delete.v1";
const DELETE_OPERATION_ID_PATTERN = /^sv-delete-op-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DEFAULT_KEYED_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const GUARD_PUBLISH_HARDLINK = "hardlink";
const GUARD_PUBLISH_EXCLUSIVE_CREATE = "exclusive_create";
const GUARD_PUBLISH_MODES = new Set([GUARD_PUBLISH_HARDLINK, GUARD_PUBLISH_EXCLUSIVE_CREATE]);
const AUTOMATIC_RECOVERY_CODES = new Set([
  "EBUSY",
  "SHORT_VIDEO_DELETE_BUSY",
  "SHORT_VIDEO_DELETE_COVER_CLEANUP_PENDING",
  "SHORT_VIDEO_DELETE_GUARD_TEMP_CLEANUP",
  "SHORT_VIDEO_DELETE_IDENTITY_UNAVAILABLE",
  "SHORT_VIDEO_DELETE_ISOLATE_NO_REPLACE_UNAVAILABLE",
  "SHORT_VIDEO_DELETE_LEASE_LOST",
  "SHORT_VIDEO_DELETE_PENDING"
]);
const DELETE_PROTOCOL_TABLES = [
  "short_video_delete_jobs",
  OPERATION_TABLE,
  "short_video_delete_items",
  "short_video_delete_reservations",
  FS_ACTION_TABLE,
  PATH_REFERENCE_TABLE,
  PATH_TOMBSTONE_TABLE,
  VIDEO_TOMBSTONE_TABLE
];

export function createShortVideoDeleteJobService({
  database,
  roots = [],
  coverCacheDir = "",
  deferCleanup = false,
  deleteRows,
  deleteStoredCovers,
  displayPath = (value) => value,
  fsOps = fs,
  hooks = {},
  leaseDurationMs = 30_000,
  now = () => new Date().toISOString(),
  ownerId: configuredOwnerId = "",
  removeEmptyParents = () => [],
  resolveGroupRows = null,
  terminalJobLimit = 200,
  keyedTerminalRetentionMs = DEFAULT_KEYED_TERMINAL_RETENTION_MS,
  warn = console.warn
} = {}) {
  if (typeof database !== "function") throw new Error("short video delete database is required");
  if (typeof deleteRows !== "function") throw new Error("short video delete row callback is required");
  const managedRoots = normalizeRoots([...roots, coverCacheDir].filter(Boolean));
  const configuredOwner = String(configuredOwnerId || "");
  let ownerId = configuredOwner || newOwnerId();
  const rootGroupCache = new Map();
  const activeExecutions = new Map();
  const relinquishableExecutions = new Map();
  let recovering = false;
  let closing = false;
  let closed = false;
  let closeDrainPromise = null;
  let resolveCloseDrain = null;

  function newOwnerId() {
    return `short-video-delete-owner-${process.pid}-${crypto.randomUUID()}`;
  }

  function reopen() {
    if (!closed) return;
    if (closing || activeExecutions.size) {
      throw codedError("短视频删除服务正在关闭活动作业", "SHORT_VIDEO_DELETE_SERVICE_CLOSING");
    }
    ownerId = configuredOwner || newOwnerId();
    closed = false;
  }

  function assertOpen() {
    if (closed) {
      throw codedError("短视频删除服务已关闭，必须创建新实例", "SHORT_VIDEO_DELETE_SERVICE_CLOSED");
    }
  }

  function assertAcceptingWork() {
    assertOpen();
    if (closing) {
      throw codedError("短视频删除服务正在关闭活动作业", "SHORT_VIDEO_DELETE_SERVICE_CLOSING");
    }
  }

  function initialize(db = database()) {
    if (closing) assertAcceptingWork();
    reopen();
    ensureSchema(db);
    pruneTerminalJobs(db);
    return status(db);
  }

  function protocolTriggerNames() {
    return [
      "trg_short_video_delete_reserve_video_insert_v1",
      "trg_short_video_delete_reserve_video_update_v1",
      "trg_short_video_delete_reserve_video_delete_v1",
      "trg_short_video_delete_reserve_asset_insert_v1",
      "trg_short_video_delete_reserve_asset_update_v1",
      "trg_short_video_delete_reserve_asset_delete_v1",
      "trg_short_video_delete_request_sha256_immutable_v1",
      "trg_short_video_delete_job_target_immutable_v1",
      "trg_short_video_delete_item_target_immutable_v1",
      "trg_short_video_delete_operation_request_immutable_v1",
      "trg_short_video_delete_operation_receipt_immutable_v2",
      "trg_short_video_delete_operation_no_delete_v1",
      "trg_short_video_path_tombstone_no_update_v1",
      "trg_short_video_video_tombstone_no_update_v1",
      "trg_short_video_video_tombstone_insert_v1",
      "trg_short_video_video_tombstone_update_v1",
      ...PATH_COLUMNS.flatMap((column) => {
        const suffix = column.replace(/_path$/u, "");
        return [
          `trg_short_video_path_tombstone_video_${suffix}_insert_v1`,
          `trg_short_video_path_tombstone_video_${suffix}_update_v1`,
          `trg_short_video_path_ref_video_${suffix}_insert_v2`,
          `trg_short_video_path_ref_video_${suffix}_update_v2`
        ];
      }),
      "trg_short_video_path_tombstone_asset_insert_v1",
      "trg_short_video_path_tombstone_asset_update_v1",
      "trg_short_video_path_ref_video_delete_v2",
      "trg_short_video_path_ref_asset_insert_v2",
      "trg_short_video_path_ref_asset_update_v2",
      "trg_short_video_path_ref_asset_delete_v2"
    ];
  }

  function protocolSchemaCurrent(db) {
    const version = String(db.prepare("SELECT value FROM short_video_meta WHERE key = ?").get(DELETE_PROTOCOL_VERSION_META)?.value || "");
    if (version !== DELETE_PROTOCOL_VERSION) return false;
    const required = [
      ...DELETE_PROTOCOL_TABLES.map((name) => ["table", name]),
      ...protocolTriggerNames().map((name) => ["trigger", name])
    ];
    const names = required.map(([, name]) => name);
    const placeholders = names.map(() => "?").join(", ");
    const existing = new Set(db.prepare(`
      SELECT type, name
      FROM sqlite_schema
      WHERE name IN (${placeholders})
    `).all(...names).map((row) => `${row.type}\0${row.name}`));
    if (!required.every(([type, name]) => existing.has(`${type}\0${name}`))) return false;
    const requiredColumns = [
      ["short_video_delete_jobs", "execution_token"],
      ["short_video_delete_jobs", "request_sha256"],
      ["short_video_delete_items", "guard_publish_mode"],
      ["short_video_delete_items", "guard_publish_provenance"],
      ["short_video_delete_items", "guard_publish_identity_json"]
    ];
    return requiredColumns.every(([table, column]) => schemaHasColumn(db, table, column));
  }

  function ensureSchema(db = database()) {
    const observedProtocolVersion = String(
      db.prepare("SELECT value FROM short_video_meta WHERE key = ?").get(DELETE_PROTOCOL_VERSION_META)?.value || ""
    );
    if (/^\d+$/u.test(observedProtocolVersion) && Number(observedProtocolVersion) > Number(DELETE_PROTOCOL_VERSION)) {
      throw codedError(
        "短视频删除协议版本高于当前服务，已拒绝降级",
        "SHORT_VIDEO_DELETE_PROTOCOL_NEWER"
      );
    }
    ensureReferenceLookupIndexes(db);
    if (protocolSchemaCurrent(db)) return false;
    beginImmediate(db);
    try {
      if (protocolSchemaCurrent(db)) {
        db.exec("COMMIT");
        return false;
      }
      const previousProtocolVersion = String(
        db.prepare("SELECT value FROM short_video_meta WHERE key = ?").get(DELETE_PROTOCOL_VERSION_META)?.value || ""
      );
      if (/^\d+$/u.test(previousProtocolVersion) && Number(previousProtocolVersion) > Number(DELETE_PROTOCOL_VERSION)) {
        throw codedError(
          "短视频删除协议版本高于当前服务，已拒绝降级",
          "SHORT_VIDEO_DELETE_PROTOCOL_NEWER"
        );
      }
      installProtocolSchemaInTransaction(db);
      migrateV3GuardPublishModesInTransaction(db, previousProtocolVersion);
      backfillLexicalReferenceIndexInTransaction(db);
      assertReferenceProjectionComplete(db);
      db.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES (?, ?)")
        .run(DELETE_PROTOCOL_VERSION_META, DELETE_PROTOCOL_VERSION);
      db.exec("COMMIT");
      return true;
    } catch (error) {
      rollback(db);
      throw error;
    }
  }

  function ensureReferenceLookupIndexes(db) {
    const pathReferenceTableExists = Boolean(db.prepare(`
      SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?
    `).get(PATH_REFERENCE_TABLE));
    if (!pathReferenceTableExists) return;
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_short_video_path_refs_owner_video
        ON ${PATH_REFERENCE_TABLE}(owner_video_id, owner_table, owner_key, path_column);
    `);
  }

  function installProtocolSchemaInTransaction(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS short_video_delete_jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'single',
        anchor_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        group_dir TEXT NOT NULL DEFAULT '',
        video_ids_json TEXT NOT NULL,
        result_json TEXT NOT NULL DEFAULT '',
        request_sha256 TEXT NOT NULL DEFAULT '',
        quarantine_token TEXT NOT NULL,
        owner_id TEXT NOT NULL DEFAULT '',
        lease_until TEXT NOT NULL DEFAULT '',
        execution_token TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '',
        error_code TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_short_video_delete_jobs_status_updated
        ON short_video_delete_jobs(status, updated_at);
      CREATE TABLE IF NOT EXISTS ${OPERATION_TABLE} (
        operation_id TEXT PRIMARY KEY,
        request_sha256 TEXT NOT NULL,
        terminal_status TEXT NOT NULL DEFAULT '',
        result_json TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        finished_at TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_short_video_delete_operations_finished
        ON ${OPERATION_TABLE}(finished_at, operation_id);
      CREATE TABLE IF NOT EXISTS short_video_delete_items (
        job_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        original_path TEXT NOT NULL,
        path_key TEXT NOT NULL,
        real_path_key TEXT NOT NULL DEFAULT '',
        identity_key TEXT NOT NULL DEFAULT '',
        relative_path TEXT NOT NULL,
        managed_root TEXT NOT NULL DEFAULT '',
        quarantine_path TEXT NOT NULL DEFAULT '',
        disposition TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL,
        source_identity_json TEXT NOT NULL DEFAULT '',
        quarantine_identity_json TEXT NOT NULL DEFAULT '',
        guard_identity_json TEXT NOT NULL DEFAULT '',
        guard_publish_mode TEXT NOT NULL DEFAULT '',
        guard_publish_provenance TEXT NOT NULL DEFAULT '',
        guard_publish_identity_json TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        PRIMARY KEY(job_id, ordinal),
        FOREIGN KEY(job_id) REFERENCES short_video_delete_jobs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_short_video_delete_items_job_state
        ON short_video_delete_items(job_id, state, ordinal);
      CREATE TABLE IF NOT EXISTS short_video_delete_reservations (
        job_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        reservation_key TEXT NOT NULL,
        original_value TEXT NOT NULL DEFAULT '',
        mutation_mode TEXT NOT NULL DEFAULT '',
        released_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(job_id, kind, reservation_key),
        FOREIGN KEY(job_id) REFERENCES short_video_delete_jobs(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_short_video_delete_reservation_active
        ON short_video_delete_reservations(kind, reservation_key)
        WHERE released_at = '';

      CREATE TABLE IF NOT EXISTS ${FS_ACTION_TABLE} (
        job_id TEXT NOT NULL,
        action_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL DEFAULT -1,
        kind TEXT NOT NULL,
        source_path TEXT NOT NULL,
        target_path TEXT NOT NULL DEFAULT '',
        evidence_dir TEXT NOT NULL,
        evidence_path TEXT NOT NULL,
        expected_identity_json TEXT NOT NULL,
        observed_identity_json TEXT NOT NULL DEFAULT '',
        stage TEXT NOT NULL DEFAULT 'intent',
        error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(job_id, action_key),
        FOREIGN KEY(job_id) REFERENCES short_video_delete_jobs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_short_video_delete_fs_actions_stage
        ON ${FS_ACTION_TABLE}(job_id, stage, ordinal);

      CREATE TABLE IF NOT EXISTS ${PATH_REFERENCE_TABLE} (
        owner_table TEXT NOT NULL,
        owner_key TEXT NOT NULL,
        owner_video_id TEXT NOT NULL,
        path_column TEXT NOT NULL,
        raw_path TEXT NOT NULL DEFAULT '',
        path_key TEXT NOT NULL DEFAULT '',
        real_path_key TEXT NOT NULL DEFAULT '',
        identity_key TEXT NOT NULL DEFAULT '',
        root_group_key TEXT NOT NULL DEFAULT '',
        probe_state TEXT NOT NULL DEFAULT 'unverified',
        updated_at TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(owner_table, owner_key, path_column)
      );
      CREATE INDEX IF NOT EXISTS idx_short_video_path_refs_path
        ON ${PATH_REFERENCE_TABLE}(path_key, owner_video_id);
      CREATE INDEX IF NOT EXISTS idx_short_video_path_refs_real
        ON ${PATH_REFERENCE_TABLE}(real_path_key, owner_video_id);
      CREATE INDEX IF NOT EXISTS idx_short_video_path_refs_identity
        ON ${PATH_REFERENCE_TABLE}(identity_key, owner_video_id);
      CREATE INDEX IF NOT EXISTS idx_short_video_path_refs_probe
        ON ${PATH_REFERENCE_TABLE}(probe_state, owner_video_id);
      CREATE INDEX IF NOT EXISTS idx_short_video_path_refs_owner_video
        ON ${PATH_REFERENCE_TABLE}(owner_video_id, owner_table, owner_key, path_column);

      CREATE TABLE IF NOT EXISTS ${PATH_TOMBSTONE_TABLE} (
        path_key TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        original_path TEXT NOT NULL DEFAULT '',
        real_path_key TEXT NOT NULL DEFAULT '',
        identity_key TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_short_video_path_tombstones_job
        ON ${PATH_TOMBSTONE_TABLE}(job_id, state);
      CREATE INDEX IF NOT EXISTS idx_short_video_path_tombstones_real
        ON ${PATH_TOMBSTONE_TABLE}(real_path_key, state);
      CREATE INDEX IF NOT EXISTS idx_short_video_path_tombstones_identity
        ON ${PATH_TOMBSTONE_TABLE}(identity_key, state);

      CREATE TABLE IF NOT EXISTS ${VIDEO_TOMBSTONE_TABLE} (
        video_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        identity_keys_json TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_short_video_video_tombstones_job
        ON ${VIDEO_TOMBSTONE_TABLE}(job_id, state);

      DROP TRIGGER IF EXISTS trg_short_video_path_tombstone_no_update_v1;
      CREATE TRIGGER trg_short_video_path_tombstone_no_update_v1
      BEFORE UPDATE ON ${PATH_TOMBSTONE_TABLE}
      BEGIN
        SELECT RAISE(ABORT, 'short video path tombstones are immutable');
      END;

      DROP TRIGGER IF EXISTS trg_short_video_video_tombstone_no_update_v1;
      CREATE TRIGGER trg_short_video_video_tombstone_no_update_v1
      BEFORE UPDATE ON ${VIDEO_TOMBSTONE_TABLE}
      BEGIN
        SELECT RAISE(ABORT, 'short video video tombstones are immutable');
      END;

      DROP TRIGGER IF EXISTS trg_short_video_delete_reserve_video_insert_v1;
      CREATE TRIGGER trg_short_video_delete_reserve_video_insert_v1
      BEFORE INSERT ON short_videos
      WHEN EXISTS (
        SELECT 1 FROM short_video_delete_reservations reservation
        WHERE reservation.released_at = ''
          AND reservation.mutation_mode <> 'commit'
          AND (
            (reservation.kind = 'video' AND reservation.reservation_key = NEW.id)
            OR (reservation.kind = 'path' AND reservation.reservation_key IN (
              lower(replace(trim(NEW.source_path), char(92), '/')),
              lower(replace(trim(NEW.cover_path), char(92), '/')),
              lower(replace(trim(NEW.music_path), char(92), '/')),
              lower(replace(trim(NEW.data_path), char(92), '/'))
            ))
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'short video delete reservation conflict');
      END;

      DROP TRIGGER IF EXISTS trg_short_video_delete_reserve_video_update_v1;
      CREATE TRIGGER trg_short_video_delete_reserve_video_update_v1
      BEFORE UPDATE ON short_videos
      WHEN EXISTS (
        SELECT 1 FROM short_video_delete_reservations reservation
        WHERE reservation.released_at = ''
          AND reservation.mutation_mode <> 'commit'
          AND (
            (reservation.kind = 'video' AND reservation.reservation_key IN (OLD.id, NEW.id))
            OR (reservation.kind = 'path' AND reservation.reservation_key IN (
              lower(replace(trim(OLD.source_path), char(92), '/')),
              lower(replace(trim(OLD.cover_path), char(92), '/')),
              lower(replace(trim(OLD.music_path), char(92), '/')),
              lower(replace(trim(OLD.data_path), char(92), '/')),
              lower(replace(trim(NEW.source_path), char(92), '/')),
              lower(replace(trim(NEW.cover_path), char(92), '/')),
              lower(replace(trim(NEW.music_path), char(92), '/')),
              lower(replace(trim(NEW.data_path), char(92), '/'))
            ))
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'short video delete reservation conflict');
      END;

      DROP TRIGGER IF EXISTS trg_short_video_delete_reserve_video_delete_v1;
      CREATE TRIGGER trg_short_video_delete_reserve_video_delete_v1
      BEFORE DELETE ON short_videos
      WHEN EXISTS (
        SELECT 1 FROM short_video_delete_reservations reservation
        WHERE reservation.released_at = ''
          AND reservation.mutation_mode <> 'commit'
          AND reservation.kind = 'video'
          AND reservation.reservation_key = OLD.id
      )
      BEGIN
        SELECT RAISE(ABORT, 'short video delete reservation conflict');
      END;

      DROP TRIGGER IF EXISTS trg_short_video_delete_reserve_asset_insert_v1;
      CREATE TRIGGER trg_short_video_delete_reserve_asset_insert_v1
      BEFORE INSERT ON short_video_assets
      WHEN EXISTS (
        SELECT 1 FROM short_video_delete_reservations reservation
        WHERE reservation.released_at = ''
          AND reservation.mutation_mode <> 'commit'
          AND (
            (reservation.kind = 'video' AND reservation.reservation_key = NEW.video_id)
            OR (reservation.kind = 'path'
              AND reservation.reservation_key = lower(replace(trim(NEW.local_path), char(92), '/')))
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'short video delete reservation conflict');
      END;

      DROP TRIGGER IF EXISTS trg_short_video_delete_reserve_asset_update_v1;
      CREATE TRIGGER trg_short_video_delete_reserve_asset_update_v1
      BEFORE UPDATE ON short_video_assets
      WHEN EXISTS (
        SELECT 1 FROM short_video_delete_reservations reservation
        WHERE reservation.released_at = ''
          AND reservation.mutation_mode <> 'commit'
          AND (
            (reservation.kind = 'video' AND reservation.reservation_key IN (OLD.video_id, NEW.video_id))
            OR (reservation.kind = 'path' AND reservation.reservation_key IN (
              lower(replace(trim(OLD.local_path), char(92), '/')),
              lower(replace(trim(NEW.local_path), char(92), '/'))
            ))
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'short video delete reservation conflict');
      END;

      DROP TRIGGER IF EXISTS trg_short_video_delete_reserve_asset_delete_v1;
      CREATE TRIGGER trg_short_video_delete_reserve_asset_delete_v1
      BEFORE DELETE ON short_video_assets
      WHEN EXISTS (
        SELECT 1 FROM short_video_delete_reservations reservation
        WHERE reservation.released_at = ''
          AND reservation.mutation_mode <> 'commit'
          AND (
            (reservation.kind = 'video' AND reservation.reservation_key = OLD.video_id)
            OR (reservation.kind = 'path'
              AND reservation.reservation_key = lower(replace(trim(OLD.local_path), char(92), '/')))
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'short video delete reservation conflict');
      END;

    `);
    ensureColumn(db, "short_video_delete_jobs", "cover_cleanup_done", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "short_video_delete_jobs", "deleted_stored_covers", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "short_video_delete_jobs", "execution_token", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "short_video_delete_jobs", "request_sha256", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "short_video_delete_items", "real_path_key", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "short_video_delete_items", "identity_key", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "short_video_delete_items", "guard_publish_mode", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "short_video_delete_items", "guard_publish_provenance", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "short_video_delete_items", "guard_publish_identity_json", "TEXT NOT NULL DEFAULT ''");
    db.exec(`
      DROP TRIGGER IF EXISTS trg_short_video_delete_request_sha256_immutable_v1;
      CREATE TRIGGER trg_short_video_delete_request_sha256_immutable_v1
      BEFORE UPDATE OF request_sha256 ON short_video_delete_jobs
      WHEN NEW.request_sha256 <> OLD.request_sha256
      BEGIN
        SELECT RAISE(ABORT, 'short video delete request digest is immutable');
      END;
      DROP TRIGGER IF EXISTS trg_short_video_delete_job_target_immutable_v1;
      CREATE TRIGGER trg_short_video_delete_job_target_immutable_v1
      BEFORE UPDATE OF scope, anchor_id, group_dir, video_ids_json, quarantine_token ON short_video_delete_jobs
      WHEN NEW.scope <> OLD.scope
        OR NEW.anchor_id <> OLD.anchor_id
        OR NEW.group_dir <> OLD.group_dir
        OR NEW.video_ids_json <> OLD.video_ids_json
        OR NEW.quarantine_token <> OLD.quarantine_token
      BEGIN
        SELECT RAISE(ABORT, 'short video delete execution target is immutable');
      END;
      DROP TRIGGER IF EXISTS trg_short_video_delete_item_target_immutable_v1;
      CREATE TRIGGER trg_short_video_delete_item_target_immutable_v1
      BEFORE UPDATE OF original_path, path_key, real_path_key, identity_key, relative_path,
                       managed_root, quarantine_path, disposition ON short_video_delete_items
      WHEN NEW.original_path <> OLD.original_path
        OR NEW.path_key <> OLD.path_key
        OR NEW.real_path_key <> OLD.real_path_key
        OR NEW.identity_key <> OLD.identity_key
        OR NEW.relative_path <> OLD.relative_path
        OR NEW.managed_root <> OLD.managed_root
        OR NEW.quarantine_path <> OLD.quarantine_path
        OR NEW.disposition <> OLD.disposition
      BEGIN
        SELECT RAISE(ABORT, 'short video delete item target is immutable');
      END;
      DROP TRIGGER IF EXISTS trg_short_video_delete_operation_request_immutable_v1;
      CREATE TRIGGER trg_short_video_delete_operation_request_immutable_v1
      BEFORE UPDATE OF request_sha256 ON ${OPERATION_TABLE}
      WHEN NEW.request_sha256 <> OLD.request_sha256
      BEGIN
        SELECT RAISE(ABORT, 'short video delete operation request is immutable');
      END;
      DROP TRIGGER IF EXISTS trg_short_video_delete_operation_receipt_immutable_v1;
      DROP TRIGGER IF EXISTS trg_short_video_delete_operation_receipt_immutable_v2;
      CREATE TRIGGER trg_short_video_delete_operation_receipt_immutable_v2
      BEFORE UPDATE OF terminal_status, result_json, finished_at ON ${OPERATION_TABLE}
      WHEN OLD.terminal_status <> '' AND NOT (
        NEW.terminal_status = OLD.terminal_status
        AND NEW.finished_at = OLD.finished_at
        AND OLD.result_json <> ''
        AND NEW.result_json = ''
      )
      BEGIN
        SELECT RAISE(ABORT, 'short video delete operation receipt is immutable');
      END;
      DROP TRIGGER IF EXISTS trg_short_video_delete_operation_no_delete_v1;
      CREATE TRIGGER trg_short_video_delete_operation_no_delete_v1
      BEFORE DELETE ON ${OPERATION_TABLE}
      BEGIN
        SELECT RAISE(ABORT, 'short video delete operation tombstones are permanent');
      END;
    `);
    installReferenceTriggers(db);
    installTombstoneTriggers(db);
  }

  function installTombstoneTriggers(db) {
    db.exec(`
      DROP TRIGGER IF EXISTS trg_short_video_video_tombstone_insert_v1;
      CREATE TRIGGER trg_short_video_video_tombstone_insert_v1
      BEFORE INSERT ON short_videos
      WHEN EXISTS (
        SELECT 1 FROM ${VIDEO_TOMBSTONE_TABLE}
        WHERE state = 'active' AND video_id = NEW.id
      )
      BEGIN
        SELECT RAISE(ABORT, 'short video video tombstone conflict');
      END;

      DROP TRIGGER IF EXISTS trg_short_video_video_tombstone_update_v1;
      CREATE TRIGGER trg_short_video_video_tombstone_update_v1
      BEFORE UPDATE OF id ON short_videos
      WHEN EXISTS (
        SELECT 1 FROM ${VIDEO_TOMBSTONE_TABLE}
        WHERE state = 'active' AND video_id = NEW.id
      )
      BEGIN
        SELECT RAISE(ABORT, 'short video video tombstone conflict');
      END;
    `);
    for (const column of PATH_COLUMNS) {
      const suffix = column.replace(/_path$/u, "");
      const insertName = `trg_short_video_path_tombstone_video_${suffix}_insert_v1`;
      const updateName = `trg_short_video_path_tombstone_video_${suffix}_update_v1`;
      db.exec(`
        DROP TRIGGER IF EXISTS ${insertName};
        CREATE TRIGGER ${insertName}
        BEFORE INSERT ON short_videos
        WHEN trim(NEW.${column}) <> '' AND EXISTS (
          SELECT 1 FROM ${PATH_TOMBSTONE_TABLE}
          WHERE state = 'active'
            AND path_key = lower(replace(trim(NEW.${column}), char(92), '/'))
        )
        BEGIN
          SELECT RAISE(ABORT, 'short video path tombstone conflict');
        END;

        DROP TRIGGER IF EXISTS ${updateName};
        CREATE TRIGGER ${updateName}
        BEFORE UPDATE OF ${column} ON short_videos
        WHEN trim(NEW.${column}) <> '' AND EXISTS (
          SELECT 1 FROM ${PATH_TOMBSTONE_TABLE}
          WHERE state = 'active'
            AND path_key = lower(replace(trim(NEW.${column}), char(92), '/'))
        )
        BEGIN
          SELECT RAISE(ABORT, 'short video path tombstone conflict');
        END;
      `);
    }
    db.exec(`
      DROP TRIGGER IF EXISTS trg_short_video_path_tombstone_asset_insert_v1;
      CREATE TRIGGER trg_short_video_path_tombstone_asset_insert_v1
      BEFORE INSERT ON short_video_assets
      WHEN trim(NEW.local_path) <> '' AND EXISTS (
        SELECT 1 FROM ${PATH_TOMBSTONE_TABLE}
        WHERE state = 'active'
          AND path_key = lower(replace(trim(NEW.local_path), char(92), '/'))
      )
      BEGIN
        SELECT RAISE(ABORT, 'short video path tombstone conflict');
      END;

      DROP TRIGGER IF EXISTS trg_short_video_path_tombstone_asset_update_v1;
      CREATE TRIGGER trg_short_video_path_tombstone_asset_update_v1
      BEFORE UPDATE OF local_path ON short_video_assets
      WHEN trim(NEW.local_path) <> '' AND EXISTS (
        SELECT 1 FROM ${PATH_TOMBSTONE_TABLE}
        WHERE state = 'active'
          AND path_key = lower(replace(trim(NEW.local_path), char(92), '/'))
      )
      BEGIN
        SELECT RAISE(ABORT, 'short video path tombstone conflict');
      END;
    `);
  }

  function installReferenceTriggers(db) {
    const triggers = [];
    for (const column of PATH_COLUMNS) {
      const suffix = column.replace(/_path$/u, "");
      const insertName = `trg_short_video_path_ref_video_${suffix}_insert_v2`;
      const updateName = `trg_short_video_path_ref_video_${suffix}_update_v2`;
      triggers.push(insertName, updateName);
      db.exec(`
        DROP TRIGGER IF EXISTS ${insertName};
        CREATE TRIGGER ${insertName}
        AFTER INSERT ON short_videos
        WHEN trim(NEW.${column}) <> ''
        BEGIN
          INSERT OR REPLACE INTO ${PATH_REFERENCE_TABLE} (
            owner_table, owner_key, owner_video_id, path_column, raw_path, path_key,
            real_path_key, identity_key, root_group_key, probe_state, updated_at
          ) VALUES (
            'short_videos', NEW.id, NEW.id, '${column}', trim(NEW.${column}),
            lower(replace(trim(NEW.${column}), char(92), '/')), '', '', '', 'unverified', ''
          );
        END;

        DROP TRIGGER IF EXISTS ${updateName};
        CREATE TRIGGER ${updateName}
        AFTER UPDATE OF id, ${column} ON short_videos
        BEGIN
          DELETE FROM ${PATH_REFERENCE_TABLE}
          WHERE owner_table = 'short_videos'
            AND owner_key = OLD.id
            AND path_column = '${column}';
          INSERT INTO ${PATH_REFERENCE_TABLE} (
            owner_table, owner_key, owner_video_id, path_column, raw_path, path_key,
            real_path_key, identity_key, root_group_key, probe_state, updated_at
          )
          SELECT 'short_videos', NEW.id, NEW.id, '${column}', trim(NEW.${column}),
                 lower(replace(trim(NEW.${column}), char(92), '/')), '', '', '', 'unverified', ''
          WHERE trim(NEW.${column}) <> '';
        END;
      `);
    }
    db.exec(`
      DROP TRIGGER IF EXISTS trg_short_video_path_ref_video_delete_v2;
      CREATE TRIGGER trg_short_video_path_ref_video_delete_v2
      AFTER DELETE ON short_videos
      BEGIN
        DELETE FROM ${PATH_REFERENCE_TABLE}
        WHERE owner_table = 'short_videos' AND owner_key = OLD.id;
      END;

      DROP TRIGGER IF EXISTS trg_short_video_path_ref_asset_insert_v2;
      CREATE TRIGGER trg_short_video_path_ref_asset_insert_v2
      AFTER INSERT ON short_video_assets
      WHEN trim(NEW.local_path) <> ''
      BEGIN
        INSERT OR REPLACE INTO ${PATH_REFERENCE_TABLE} (
          owner_table, owner_key, owner_video_id, path_column, raw_path, path_key,
          real_path_key, identity_key, root_group_key, probe_state, updated_at
        ) VALUES (
          'short_video_assets', NEW.id, NEW.video_id, 'local_path', trim(NEW.local_path),
          lower(replace(trim(NEW.local_path), char(92), '/')), '', '', '', 'unverified', ''
        );
      END;

      DROP TRIGGER IF EXISTS trg_short_video_path_ref_asset_update_v2;
      CREATE TRIGGER trg_short_video_path_ref_asset_update_v2
      AFTER UPDATE OF id, video_id, asset_type, local_path ON short_video_assets
      BEGIN
        DELETE FROM ${PATH_REFERENCE_TABLE}
        WHERE owner_table = 'short_video_assets' AND owner_key = OLD.id;
        INSERT INTO ${PATH_REFERENCE_TABLE} (
          owner_table, owner_key, owner_video_id, path_column, raw_path, path_key,
          real_path_key, identity_key, root_group_key, probe_state, updated_at
        )
        SELECT 'short_video_assets', NEW.id, NEW.video_id, 'local_path', trim(NEW.local_path),
               lower(replace(trim(NEW.local_path), char(92), '/')), '', '', '', 'unverified', ''
        WHERE trim(NEW.local_path) <> '';
      END;

      DROP TRIGGER IF EXISTS trg_short_video_path_ref_asset_delete_v2;
      CREATE TRIGGER trg_short_video_path_ref_asset_delete_v2
      AFTER DELETE ON short_video_assets
      BEGIN
        DELETE FROM ${PATH_REFERENCE_TABLE}
        WHERE owner_table = 'short_video_assets' AND owner_key = OLD.id;
      END;
    `);
  }

  function expectedReferenceProjectionSql() {
    return [
      ...PATH_COLUMNS.map((column) => `
        SELECT 'short_videos' AS owner_table,
               CAST(id AS TEXT) AS owner_key,
               CAST(id AS TEXT) AS owner_video_id,
               '${column}' AS path_column,
               trim(${column}) AS raw_path,
               lower(replace(trim(${column}), char(92), '/')) AS path_key
        FROM short_videos
        WHERE trim(${column}) <> ''
      `),
      `
        SELECT 'short_video_assets' AS owner_table,
               CAST(id AS TEXT) AS owner_key,
               CAST(video_id AS TEXT) AS owner_video_id,
               'local_path' AS path_column,
               trim(local_path) AS raw_path,
               lower(replace(trim(local_path), char(92), '/')) AS path_key
        FROM short_video_assets
        WHERE trim(local_path) <> ''
      `
    ].join(" UNION ALL ");
  }

  function backfillLexicalReferenceIndexInTransaction(db) {
    if (!db?.isTransaction) {
      throw codedError("路径引用迁移必须持有数据库写事务", "SHORT_VIDEO_DELETE_REFERENCE_NOT_FENCED");
    }
    db.prepare(`DELETE FROM ${PATH_REFERENCE_TABLE}`).run();
    db.prepare(`
      INSERT INTO ${PATH_REFERENCE_TABLE} (
        owner_table, owner_key, owner_video_id, path_column, raw_path, path_key,
        real_path_key, identity_key, root_group_key, probe_state, updated_at
      )
      WITH expected AS (${expectedReferenceProjectionSql()})
      SELECT owner_table, owner_key, owner_video_id, path_column, raw_path, path_key,
             '', '', '', 'unverified', ?
      FROM expected
    `).run(now());
  }

  function assertReferenceProjectionComplete(db) {
    const mismatchCount = Number(db.prepare(`
      WITH expected AS (${expectedReferenceProjectionSql()})
      SELECT COUNT(*) AS count
      FROM (
        SELECT * FROM (
          SELECT owner_table, owner_key, owner_video_id, path_column, raw_path, path_key FROM expected
          EXCEPT
          SELECT owner_table, owner_key, owner_video_id, path_column, raw_path, path_key FROM ${PATH_REFERENCE_TABLE}
        )
        UNION ALL
        SELECT * FROM (
          SELECT owner_table, owner_key, owner_video_id, path_column, raw_path, path_key FROM ${PATH_REFERENCE_TABLE}
          EXCEPT
          SELECT owner_table, owner_key, owner_video_id, path_column, raw_path, path_key FROM expected
        )
      )
    `).get()?.count || 0);
    if (mismatchCount !== 0) {
      throw codedError("路径引用迁移对账失败", "SHORT_VIDEO_DELETE_REFERENCE_MIGRATION_MISMATCH");
    }
  }

  async function buildTargetedReferenceSnapshot(db, hookContext = {}) {
    assertOpen();
    const selectedIds = uniqueStrings(hookContext.targetVideoIds || [], 10_000);
    const rows = new Map();
    const remember = (row) => {
      if (!row) return;
      rows.set(referenceOwnerKey(row), row);
    };
    for (const row of referenceRowsForVideoIds(db, selectedIds)) remember(row);
    if (hookContext.jobId) {
      for (const row of referenceRowsForItems(db, readItems(db, hookContext.jobId))) remember(row);
    }
    for (const row of unresolvedReferenceRows(db)) remember(row);

    await invokeHook(hooks.afterReferenceSnapshot, hookContext);

    const probeCache = createReferenceProbeCache();
    const refreshed = [];
    for (const row of rows.values()) {
      const item = referenceRow(row);
      refreshed.push({ ...item, ...probeReferencePath(item.rawPath, probeCache) });
    }
    if (refreshed.length) commitTargetedReferenceSnapshot(db, refreshed);

    const candidates = new Map(refreshed.map((row) => [referenceOwnerKey(row), row]));
    for (const row of referenceRowsForKeys(db, referenceKeysFromRows(refreshed))) {
      if (!candidates.has(referenceOwnerKey(row))) candidates.set(referenceOwnerKey(row), referenceRow(row));
    }
    for (const row of unresolvedReferenceRows(db)) {
      if (!candidates.has(referenceOwnerKey(row))) candidates.set(referenceOwnerKey(row), referenceRow(row));
    }
    return [...candidates.values()];
  }

  function referenceRow(row) {
    return {
      ownerTable: String(row?.ownerTable ?? row?.owner_table ?? ""),
      ownerKey: String(row?.ownerKey ?? row?.owner_key ?? ""),
      ownerVideoId: String(row?.ownerVideoId ?? row?.owner_video_id ?? ""),
      pathColumn: String(row?.pathColumn ?? row?.path_column ?? ""),
      rawPath: String(row?.rawPath ?? row?.raw_path ?? ""),
      pathKey: String(row?.pathKey ?? row?.path_key ?? ""),
      realPathKey: String(row?.realPathKey ?? row?.real_path_key ?? ""),
      identityKey: String(row?.identityKey ?? row?.identity_key ?? ""),
      rootGroupKey: String(row?.rootGroupKey ?? row?.root_group_key ?? ""),
      probeState: String(row?.probeState ?? row?.probe_state ?? "unverified")
    };
  }

  function referenceRowsForVideoIds(db, videoIdsValue) {
    const ids = uniqueStrings(videoIdsValue || [], 10_000);
    if (!ids.length) return [];
    const rows = [];
    for (let offset = 0; offset < ids.length; offset += 500) {
      const page = ids.slice(offset, offset + 500);
      const placeholders = page.map(() => "?").join(", ");
      rows.push(...db.prepare(`
        SELECT * FROM ${PATH_REFERENCE_TABLE}
        WHERE owner_video_id IN (${placeholders})
      `).all(...page));
    }
    return rows;
  }

  function unresolvedReferenceRows(db) {
    return db.prepare(`
      SELECT * FROM ${PATH_REFERENCE_TABLE}
      WHERE probe_state IN ('unverified', 'failed', 'outside')
    `).all();
  }

  function referenceKeysFromRows(rows) {
    const keys = new Map();
    const remember = (kind, value) => {
      const key = String(value || "");
      if (key) keys.set(referenceLookupKey(kind, key), [kind, key]);
    };
    for (const row of rows || []) {
      remember("path", row.pathKey ?? row.path_key);
      remember("real", row.realPathKey ?? row.real_path_key);
      remember("identity", row.identityKey ?? row.identity_key);
    }
    return [...keys.values()];
  }

  function referenceRowsForItems(db, items) {
    return referenceRowsForKeys(db, (items || []).flatMap((item) => [
      ["path", String(item.path_key ?? item.pathKey ?? "")],
      ["real", String(item.real_path_key ?? item.realPathKey ?? "")],
      ["identity", String(item.identity_key ?? item.identityKey ?? "")]
    ]));
  }

  function referenceRowsForKeys(db, keys) {
    const rows = new Map();
    const queries = {
      path: db.prepare(`SELECT * FROM ${PATH_REFERENCE_TABLE} WHERE path_key = ?`),
      real: db.prepare(`SELECT * FROM ${PATH_REFERENCE_TABLE} WHERE real_path_key = ?`),
      identity: db.prepare(`SELECT * FROM ${PATH_REFERENCE_TABLE} WHERE identity_key = ?`)
    };
    for (const [kind, value] of keys || []) {
      const key = String(value || "");
      if (!key || !queries[kind]) continue;
      for (const row of queries[kind].all(key)) rows.set(referenceOwnerKey(row), row);
    }
    return [...rows.values()];
  }

  function currentReferencesForItems(db, items) {
    const rows = new Map();
    for (const row of referenceRowsForItems(db, items)) rows.set(referenceOwnerKey(row), row);
    for (const row of unresolvedReferenceRows(db)) rows.set(referenceOwnerKey(row), row);
    return referencesFromRows([...rows.values()]);
  }

  function referenceOwnerKey(row) {
    return `${row.ownerTable ?? row.owner_table}\0${row.ownerKey ?? row.owner_key}\0${row.pathColumn ?? row.path_column}`;
  }

  function commitTargetedReferenceSnapshot(db, snapshots) {
    beginImmediate(db);
    try {
      const references = commitTargetedReferenceSnapshotInTransaction(db, snapshots);
      db.exec("COMMIT");
      return references;
    } catch (error) {
      rollback(db);
      throw error;
    }
  }

  function commitTargetedReferenceSnapshotInTransaction(db, snapshots) {
    if (!db?.isTransaction) {
      throw codedError("目标路径引用刷新必须持有数据库写事务", "SHORT_VIDEO_DELETE_REFERENCE_NOT_FENCED");
    }
    const select = db.prepare(`
      SELECT owner_video_id, raw_path, path_key
      FROM ${PATH_REFERENCE_TABLE}
      WHERE owner_table = ? AND owner_key = ? AND path_column = ?
    `);
    const update = db.prepare(`
      UPDATE ${PATH_REFERENCE_TABLE}
      SET real_path_key = ?, identity_key = ?, root_group_key = ?, probe_state = ?, updated_at = ?
      WHERE owner_table = ? AND owner_key = ? AND path_column = ?
    `);
    for (const row of snapshots || []) {
      const snapshot = referenceRow(row);
      const current = select.get(snapshot.ownerTable, snapshot.ownerKey, snapshot.pathColumn);
      if (!current
        || String(current.owner_video_id || "") !== snapshot.ownerVideoId
        || String(current.raw_path || "") !== snapshot.rawPath
        || String(current.path_key || "") !== snapshot.pathKey) {
        throw codedError(
          `短视频路径引用在目标探测期间发生变化 (${snapshot.ownerTable}:${snapshot.ownerKey}:${snapshot.pathColumn})`,
          "SHORT_VIDEO_DELETE_REFERENCE_CHANGED"
        );
      }
      const result = update.run(
        snapshot.realPathKey,
        snapshot.identityKey,
        snapshot.rootGroupKey,
        snapshot.probeState || "missing",
        now(),
        snapshot.ownerTable,
        snapshot.ownerKey,
        snapshot.pathColumn
      );
      if (Number(result.changes || 0) !== 1) {
        throw codedError(
          `短视频路径引用在目标探测期间发生变化 (${snapshot.ownerTable}:${snapshot.ownerKey}:${snapshot.pathColumn})`,
          "SHORT_VIDEO_DELETE_REFERENCE_CHANGED"
        );
      }
    }
    return referencesFromRows(snapshots || []);
  }

  function deleteRequestIdentity(options = {}) {
    const operationId = validateDeleteOperationId(options.operationId);
    if (!operationId) return { operationId: "", requestSha256: "" };
    const kind = String(options.requestKind || "").toLowerCase();
    if (!["single", "group", "batch"].includes(kind)) {
      throw statusError("短视频删除请求类型无效", 400, "SHORT_VIDEO_DELETE_REQUEST_INVALID");
    }
    const scope = String(options.scope || kind).toLowerCase();
    if (scope !== kind) {
      throw statusError("短视频删除请求范围无效", 400, "SHORT_VIDEO_DELETE_REQUEST_INVALID");
    }
    const selector = kind === "batch"
      ? uniqueStrings(options.requestSelector || [], 10_000).sort()
      : String(options.requestSelector || "").trim();
    const canonical = JSON.stringify({
      protocol: DELETE_REQUEST_PROTOCOL,
      kind,
      selector,
      scope,
      deleteFiles: options.deleteFiles !== false
    });
    return {
      operationId,
      requestSha256: crypto.createHash("sha256").update(canonical).digest("hex")
    };
  }

  function validateDeleteOperationId(value) {
    if (value === undefined) return "";
    if (typeof value !== "string" || !DELETE_OPERATION_ID_PATTERN.test(value)) {
      throw statusError(
        "operationId 必须是 sv-delete-op- 加小写 UUID v4",
        400,
        "SHORT_VIDEO_DELETE_OPERATION_ID_INVALID"
      );
    }
    return value;
  }

  function assertRequestReplay(row, requestSha256) {
    if (!row) return;
    if (!requestSha256 || String(row.request_sha256 || "") !== requestSha256) {
      throw statusError(
        "operationId 已用于不同的短视频删除请求",
        409,
        "SHORT_VIDEO_DELETE_OPERATION_CONFLICT"
      );
    }
  }

  function operationReplay(db, identity) {
    const { operation, job } = readOperationReplayState(db, identity.operationId);
    if (!operation) {
      if (job) {
        throw statusError(
          "operationId 已存在但缺少可信幂等标记",
          409,
          "SHORT_VIDEO_DELETE_OPERATION_CONFLICT"
        );
      }
      return null;
    }
    assertRequestReplay(operation, identity.requestSha256);
    if (job) {
      assertRequestReplay(job, identity.requestSha256);
      return executionResult(db, job.id, { replayed: true });
    }
    if (TERMINAL_STATUSES.includes(String(operation.terminal_status || ""))) {
      return receiptExecutionResult(operation);
    }
    throw statusError(
      "短视频删除幂等记录不完整，已拒绝重试",
      409,
      "SHORT_VIDEO_DELETE_OPERATION_INCOMPLETE"
    );
  }

  function lookupOperation(db = database(), options = {}) {
    assertAcceptingWork();
    ensureSchema(db);
    const identity = deleteRequestIdentity(options);
    if (!identity.operationId) return null;
    return operationReplay(db, identity);
  }

  async function execute(rows, options = {}) {
    assertAcceptingWork();
    const identity = deleteRequestIdentity(options);
    const executionToken = newExecutionToken();
    const preflightKey = `preflight:${executionToken}`;
    beginExecution(preflightKey, executionToken);
    let db = null;
    let executionKey = preflightKey;
    let cleanupDetached = false;
    try {
      db = database();
      ensureSchema(db);
      if (identity.operationId) {
        const replay = operationReplay(db, identity);
        if (replay) return replay;
      }
      const referenceSnapshot = await buildTargetedReferenceSnapshot(db, {
        phase: "plan",
        targetVideoIds: (rows || []).map((row) => row?.id)
      });
      const persisted = await persistPlan(db, rows, options, referenceSnapshot, executionToken, identity);
      if (persisted.replayed) return persisted.replayed;
      const job = persisted.job;
      transferExecution(preflightKey, job.id, executionToken);
      executionKey = job.id;
      try {
        await invokeHook(hooks.afterPlanPersisted, publicHookJob(job));
        await isolatePlannedFiles(db, job.id);
        await invokeHook(hooks.afterAllIsolated, publicHookJob(readJob(db, job.id)));
        await commitRows(db, job.id);
        await invokeHook(hooks.afterDatabaseCommit, publicHookJob(readJob(db, job.id)));
      } catch (error) {
        const current = readJob(db, job.id);
        if (!current) throw error;
        if (databaseDisposition(db, current) === "committed") {
          rememberPending(db, current.id, "cleanup_pending", "cleanup", error);
          warn?.("[short-video-delete-cleanup-pending]", error);
          return executionResult(db, current.id);
        }
        rememberPending(db, current.id, "rollback_pending", "rollback", error);
        await invokeHook(hooks.afterDeletePendingRemembered, {
          jobId: current.id,
          errorCode: String(error?.code || "SHORT_VIDEO_DELETE_FAILED")
        });
        try {
          const recovered = await recoverOne(db, current.id, executionToken);
          if (identity.operationId) {
            const keyedResult = operationReplay(db, identity);
            if (keyedResult) return { ...keyedResult, replayed: false };
          }
          if (recovered?.status === "rolled_back") {
            if (isKeyedJob(recovered)) return executionResult(db, current.id);
            throw pendingOperationError(db, current.id, error, "删除本地文件失败");
          }
        } catch (recoveryError) {
          if (recoveryError?.cause === error) throw recoveryError;
          rememberPending(db, current.id, "rollback_pending", "rollback", recoveryError);
          if (identity.operationId) {
            const keyedResult = operationReplay(db, identity);
            if (keyedResult) return { ...keyedResult, replayed: false };
          }
          if (isKeyedJob(readJob(db, current.id))) return executionResult(db, current.id);
          throw pendingOperationError(db, current.id, recoveryError, "短视频删除已安全隔离，等待恢复后重试");
        }
        if (isKeyedJob(readJob(db, current.id))) return executionResult(db, current.id);
        throw pendingOperationError(db, current.id, error, "短视频删除已安全隔离，等待恢复后重试");
      }

      if (deferCleanup) {
        cleanupDetached = true;
        void cleanupCommitted(db, job.id, { executionToken })
          .catch((error) => {
            try {
              rememberPending(db, job.id, "cleanup_pending", "cleanup", error);
            } catch (rememberError) {
              warn?.("[short-video-delete-cleanup-pending]", rememberError);
            }
            warn?.("[short-video-delete-cleanup-pending]", error);
          })
          .finally(() => endExecution(db, executionKey, executionToken));
      } else {
        try {
          await cleanupCommitted(db, job.id, { executionToken });
        } catch (error) {
          rememberPending(db, job.id, "cleanup_pending", "cleanup", error);
          warn?.("[short-video-delete-cleanup-pending]", error);
        }
      }
      if (identity.operationId) {
        const keyedResult = operationReplay(db, identity);
        if (keyedResult) return { ...keyedResult, replayed: false };
      }
      return executionResult(db, job.id);
    } finally {
      if (!cleanupDetached) endExecution(db, executionKey, executionToken);
    }
  }

  async function executeLogical(rows, options = {}) {
    assertAcceptingWork();
    const db = database();
    ensureSchema(db);
    const identity = deleteRequestIdentity({ ...options, deleteFiles: false });
    if (!identity.operationId) {
      throw codedError("带幂等键的逻辑删除缺少 operationId", "SHORT_VIDEO_DELETE_OPERATION_ID_REQUIRED");
    }
    const earlyReplay = operationReplay(db, identity);
    if (earlyReplay) return earlyReplay;
    const executionToken = newExecutionToken();
    const preflightKey = `preflight:${executionToken}`;
    beginExecution(preflightKey, executionToken);
    let executionKey = preflightKey;

    try {
      const requestedIds = uniqueStrings((rows || []).map((row) => row?.id), 10_000);
      if (!requestedIds.length) throw statusError("没有可删除的短视频记录", 404, "SHORT_VIDEO_DELETE_EMPTY");
      const beforeById = rowsForIds(db, requestedIds);
      if (beforeById.size !== requestedIds.length) {
        throw statusError("短视频记录在删除计划创建前已发生变化", 409, "SHORT_VIDEO_DELETE_CHANGED");
      }
      const beforeRows = requestedIds.map((id) => beforeById.get(id));
      const timestamp = now();
      const token = crypto.randomBytes(24).toString("hex");
      let created = false;

      beginImmediate(db);
      try {
        const existingReplay = operationReplay(db, identity);
        if (existingReplay) {
          db.exec("COMMIT");
          return existingReplay;
        }
        const currentById = rowsForIds(db, requestedIds);
        const currentRows = requestedIds.map((id) => currentById.get(id));
        if (currentById.size !== requestedIds.length || !rowsSnapshotMatches(beforeRows, currentRows)) {
          throw statusError("短视频记录在删除计划创建前已发生变化", 409, "SHORT_VIDEO_DELETE_CHANGED");
        }
        if (String(options.scope || "") === "group") {
          if (typeof resolveGroupRows !== "function") {
            throw codedError("短视频同组删除缺少事务内成员解析器", "SHORT_VIDEO_DELETE_GROUP_RESOLVER_MISSING");
          }
          const transactionGroupIds = uniqueStrings(
            (resolveGroupRows(db, String(options.groupDir || "")) || []).map((row) => row?.id),
            10_000
          ).sort();
          const plannedGroupIds = requestedIds.slice().sort();
          if (
            transactionGroupIds.length !== plannedGroupIds.length
            || transactionGroupIds.some((id, index) => id !== plannedGroupIds[index])
          ) {
            throw statusError(
              "短视频同组成员在删除计划创建前已发生变化",
              409,
              "SHORT_VIDEO_DELETE_GROUP_CHANGED"
            );
          }
        }
        const firstRow = currentRows[0];
        db.prepare(`
          INSERT INTO ${OPERATION_TABLE} (
            operation_id, request_sha256, terminal_status, result_json, created_at, finished_at
          ) VALUES (?, ?, '', '', ?, '')
        `).run(identity.operationId, identity.requestSha256, timestamp);
        const result = logicalDeleteResult(currentRows, options);
        db.prepare(`
          INSERT INTO short_video_delete_jobs (
            id, status, phase, scope, anchor_id, title, group_dir, video_ids_json,
            result_json, request_sha256, quarantine_token, owner_id, lease_until, execution_token,
            version, attempts, cover_cleanup_done, deleted_stored_covers,
            error, error_code, created_at, updated_at, finished_at
          ) VALUES (?, 'cleanup_pending', 'logical_cleanup', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    1, 1, 0, 0, '', '', ?, ?, '')
        `).run(
          identity.operationId,
          String(options.scope || "single"),
          String(firstRow.id || ""),
          String(firstRow.title || firstRow.description || firstRow.file_name || ""),
          String(options.groupDir || ""),
          JSON.stringify(requestedIds),
          JSON.stringify(result),
          identity.requestSha256,
          token,
          ownerId,
          leaseUntil(),
          executionToken,
          timestamp,
          timestamp
        );
        const deletedCount = Number(deleteRows(db, requestedIds) || 0);
        if (deletedCount !== requestedIds.length) {
          throw codedError("短视频记录删除数量与持久计划不一致", "SHORT_VIDEO_DELETE_COMMIT_MISMATCH");
        }
        db.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('deleted_at', ?)").run(timestamp);
        db.exec("COMMIT");
        transferExecution(preflightKey, identity.operationId, executionToken);
        executionKey = identity.operationId;
        created = true;
      } catch (error) {
        rollback(db);
        if (isReservationConflict(error)) {
          throw statusError("另一个短视频删除作业正在处理这些记录或文件", 409, "SHORT_VIDEO_DELETE_CONFLICT");
        }
        throw error;
      }

      if (created) {
        try {
          await cleanupLogicalCommitted(db, readJob(db, identity.operationId));
        } catch (error) {
          rememberPending(db, identity.operationId, "cleanup_pending", "logical_cleanup", error);
          if (isCoverReceiptConflict(error)) {
            return { ...executionResult(db, identity.operationId), replayed: false };
          }
          throw error;
        }
        pruneTerminalJobs(db);
      }
      const result = operationReplay(db, identity);
      if (!result) throw codedError("短视频删除幂等结果缺失", "SHORT_VIDEO_DELETE_OPERATION_INCOMPLETE");
      return { ...result, replayed: false };
    } finally {
      endExecution(db, executionKey, executionToken);
    }
  }

  async function cleanupLogicalCommitted(db, job) {
    if (!job || job.phase !== "logical_cleanup" || !isKeyedJob(job)) {
      throw codedError("逻辑删除封面清理作业不完整", "SHORT_VIDEO_DELETE_OPERATION_INCOMPLETE");
    }
    const result = sanitizedJobResult(job);
    let coverCleanupCompleted = false;
    try {
      await invokeHook(hooks.beforeLogicalCoverCleanup, { jobId: String(job.id || "") });
      result.deletedStoredCovers = Number(deleteStoredCovers?.(videoIds(job), coverDeleteReceipt(job)) || 0);
      coverCleanupCompleted = true;
    } catch (error) {
      if (isCoverReceiptConflict(error)) throw error;
      result.coverCleanupError = String(error?.message || error);
      warn?.("[short-video-cover-delete]", result.coverCleanupError);
    }
    if (coverCleanupCompleted) {
      await invokeHook(hooks.afterLogicalCoverCleanup, {
        jobId: String(job.id || ""),
        deletedStoredCovers: Number(result.deletedStoredCovers || 0)
      });
    }
    const finalResult = sanitizedJobResult({ ...job, result_json: JSON.stringify(result) }, result);
    return finalizeLogicalCleanup(db, job, finalResult);
  }

  function finalizeLogicalCleanup(db, expectedJob, result) {
    const jobId = String(expectedJob?.id || "");
    const requestSha256 = String(expectedJob?.request_sha256 || "");
    const expectedOwner = String(expectedJob?.owner_id || "");
    const expectedExecutionToken = String(expectedJob?.execution_token || "");
    const timestamp = now();
    beginImmediate(db);
    try {
      const operation = readOperation(db, jobId);
      const current = readJob(db, jobId);
      assertRequestReplay(operation, requestSha256);
      assertRequestReplay(current, requestSha256);
      if (operation && TERMINAL_STATUSES.includes(String(operation.terminal_status || ""))) {
        db.exec("COMMIT");
        return operationReplay(db, { operationId: jobId, requestSha256 });
      }
      if (!operation || !current || current.status !== "cleanup_pending" || current.phase !== "logical_cleanup") {
        throw statusError(
          "逻辑删除幂等记录不完整，已拒绝终结",
          409,
          "SHORT_VIDEO_DELETE_OPERATION_INCOMPLETE"
        );
      }
      const resultJson = JSON.stringify(result);
      const completed = db.prepare(`
        UPDATE short_video_delete_jobs
        SET status = 'completed', phase = 'completed', result_json = ?,
            owner_id = '', lease_until = '', execution_token = '',
            cover_cleanup_done = 1, deleted_stored_covers = ?,
            error = '', error_code = '', updated_at = ?, finished_at = ?, version = version + 1
        WHERE id = ? AND request_sha256 = ?
          AND status = 'cleanup_pending' AND phase = 'logical_cleanup'
          AND owner_id = ? AND execution_token = ?
      `).run(
        resultJson,
        Number(result.deletedStoredCovers || 0),
        timestamp,
        timestamp,
        jobId,
        requestSha256,
        expectedOwner,
        expectedExecutionToken
      );
      if (Number(completed.changes || 0) !== 1) {
        throw codedError("逻辑删除作业终态 CAS 失败", "SHORT_VIDEO_DELETE_LEASE_LOST");
      }
      const receipt = db.prepare(`
        UPDATE ${OPERATION_TABLE}
        SET terminal_status = 'completed', result_json = ?, finished_at = ?
        WHERE operation_id = ? AND request_sha256 = ? AND terminal_status = ''
      `).run(resultJson, timestamp, jobId, requestSha256);
      if (Number(receipt.changes || 0) !== 1) {
        throw codedError("逻辑删除终态 receipt 不完整", "SHORT_VIDEO_DELETE_OPERATION_INCOMPLETE");
      }
      db.exec("COMMIT");
      return executionResult(db, jobId);
    } catch (error) {
      rollback(db);
      throw error;
    }
  }

  function logicalDeleteResult(rows, options) {
    const firstRow = rows[0] || {};
    const ids = rows.map((row) => String(row.id));
    return {
      ok: true,
      id: String(firstRow.id || ids[0] || ""),
      ids,
      count: ids.length,
      scope: String(options.scope || "single"),
      groupDir: options.groupDir ? String(displayPath(options.groupDir)) : "",
      title: String(firstRow.title || firstRow.description || firstRow.file_name || ""),
      deletedFiles: [],
      deletedStoredCovers: 0,
      coverCleanupError: "",
      missingFiles: [],
      skippedFiles: [],
      emptyRemovedPaths: []
    };
  }

  function migrateV3GuardPublishModesInTransaction(db, previousProtocolVersion) {
    if (previousProtocolVersion !== "3") return;
    db.prepare(`
      UPDATE short_video_delete_items
      SET guard_publish_provenance = 'legacy_v3', updated_at = ?
      WHERE guard_publish_mode = ''
        AND guard_publish_provenance = ''
        AND EXISTS (
          SELECT 1
          FROM short_video_delete_jobs job
          WHERE job.id = short_video_delete_items.job_id
            AND job.status IN ('running', 'rollback_pending', 'cleanup_pending')
        )
    `).run(now());
  }

  async function persistPlan(db, inputRows, options, referenceSnapshot = null, executionToken = "", identity = {}) {
    const requestedIds = uniqueStrings((inputRows || []).map((row) => row?.id), 10_000);
    if (!requestedIds.length) throw statusError("没有可删除的短视频记录", 404, "SHORT_VIDEO_DELETE_EMPTY");
    const jobId = identity.operationId || `sv-delete-${crypto.randomUUID()}`;
    const token = crypto.randomBytes(24).toString("hex");
    const timestamp = now();
    const preRowsById = rowsForIds(db, requestedIds);
    if (preRowsById.size !== requestedIds.length) {
      throw statusError("短视频记录在删除计划创建前已发生变化", 409, "SHORT_VIDEO_DELETE_CHANGED");
    }
    const preRows = requestedIds.map((id) => preRowsById.get(id));
    const preReferences = referencesFromRows(referenceSnapshot || []);
    const items = await planItems(db, jobId, token, preRows, preReferences);
    await invokeHook(hooks.beforePlanTransaction, {
      jobId,
      scope: String(options.scope || "single"),
      videoIds: requestedIds.slice()
    });
    beginImmediate(db);
    try {
      if (identity.operationId) {
        const existingReplay = operationReplay(db, identity);
        if (existingReplay) {
          db.exec("COMMIT");
          return { job: null, replayed: existingReplay };
        }
      }
      const rowsById = rowsForIds(db, requestedIds);
      if (rowsById.size !== requestedIds.length || !rowsSnapshotMatches(preRows, requestedIds.map((id) => rowsById.get(id)))) {
        throw statusError("短视频记录在删除计划创建前已发生变化", 409, "SHORT_VIDEO_DELETE_CHANGED");
      }
      if (String(options.scope || "") === "group") {
        if (typeof resolveGroupRows !== "function") {
          throw codedError("短视频同组删除缺少事务内成员解析器", "SHORT_VIDEO_DELETE_GROUP_RESOLVER_MISSING");
        }
        const transactionGroupRows = resolveGroupRows(db, String(options.groupDir || ""));
        const transactionGroupIds = uniqueStrings((transactionGroupRows || []).map((row) => row?.id), 10_000).sort();
        const plannedGroupIds = requestedIds.slice().sort();
        if (
          transactionGroupIds.length !== plannedGroupIds.length
          || transactionGroupIds.some((id, index) => id !== plannedGroupIds[index])
        ) {
          throw statusError(
            "短视频同组成员在删除计划创建前已发生变化",
            409,
            "SHORT_VIDEO_DELETE_GROUP_CHANGED"
          );
        }
      }
      const rows = requestedIds.map((id) => rowsById.get(id));
      const references = currentReferencesForItems(db, items);
      assertPlannedReferences(items, rows, references);
      assertNoReservationConflicts(db, requestedIds, items);
      const firstRow = rows[0];
      if (identity.operationId) {
        db.prepare(`
          INSERT INTO ${OPERATION_TABLE} (
            operation_id, request_sha256, terminal_status, result_json, created_at, finished_at
          ) VALUES (?, ?, '', '', ?, '')
        `).run(identity.operationId, identity.requestSha256, timestamp);
      }
      db.prepare(`
        INSERT INTO short_video_delete_jobs (
          id, status, phase, scope, anchor_id, title, group_dir, video_ids_json,
          result_json, request_sha256, quarantine_token, owner_id, lease_until, execution_token, version, attempts,
          error, error_code, created_at, updated_at, finished_at
        ) VALUES (?, 'running', 'planned', ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, 1, 1, '', '', ?, ?, '')
      `).run(
        jobId,
        String(options.scope || "single"),
        String(firstRow.id || ""),
        String(firstRow.title || firstRow.description || firstRow.file_name || ""),
        String(options.groupDir || ""),
        JSON.stringify(requestedIds),
        identity.requestSha256 || "",
        token,
        ownerId,
        leaseUntil(),
        executionToken,
        timestamp,
        timestamp
      );
      const insertItem = db.prepare(`
        INSERT INTO short_video_delete_items (
          job_id, ordinal, original_path, path_key, real_path_key, identity_key, relative_path, managed_root,
          quarantine_path, disposition, reason, state, source_identity_json,
          quarantine_identity_json, guard_identity_json, error, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', ?)
      `);
      for (const item of items) {
        insertItem.run(
          jobId,
          item.ordinal,
          item.originalPath,
          item.pathKey,
          item.realPathKey,
          item.identityKey,
          item.relativePath,
          item.managedRoot,
          item.quarantinePath,
          item.disposition,
          item.reason,
          item.disposition === "delete" ? "planned" : item.disposition,
          item.sourceIdentity ? JSON.stringify(item.sourceIdentity) : "",
          timestamp
        );
      }
      const reserve = db.prepare(`
        INSERT INTO short_video_delete_reservations (
          job_id, kind, reservation_key, original_value, mutation_mode,
          released_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, '', '', ?, ?)
      `);
      for (const id of requestedIds) reserve.run(jobId, "video", id, id, timestamp, timestamp);
      const reservedFileKeys = new Set();
      const reserveFileKey = (kind, reservationKey, originalPath) => {
        if (!reservationKey) return;
        const uniqueKey = referenceLookupKey(kind, reservationKey);
        if (reservedFileKeys.has(uniqueKey)) return;
        reservedFileKeys.add(uniqueKey);
        reserve.run(jobId, kind, reservationKey, originalPath, timestamp, timestamp);
      };
      for (const item of items.filter((entry) => ["delete", "missing", "alias", "retained"].includes(entry.disposition))) {
        reserveFileKey("path", item.pathKey, item.originalPath);
        reserveFileKey("real", item.realPathKey, item.originalPath);
        reserveFileKey("identity", item.identityKey, item.originalPath);
      }
      db.exec("COMMIT");
      return { job: readJob(db, jobId), replayed: false };
    } catch (error) {
      rollback(db);
      if (isReservationConflict(error)) {
        throw statusError(
          "另一个短视频删除作业正在处理这些记录或文件",
          409,
          "SHORT_VIDEO_DELETE_CONFLICT"
        );
      }
      throw error;
    }
  }

  function rowsSnapshotMatches(beforeRows, afterRows) {
    return beforeRows.length === afterRows.length && beforeRows.every((before, index) => {
      const after = afterRows[index];
      if (!after || String(before.id) !== String(after.id)) return false;
      return PATH_COLUMNS.every((column) => String(before[column] || "") === String(after[column] || ""));
    });
  }

  function assertPlannedReferences(items, rows, references) {
    const selectedIds = new Set(rows.map((row) => String(row.id)));
    for (const item of items) {
      if (!["delete", "missing", "alias"].includes(item.disposition)) continue;
      const keys = [
        ["path", item.pathKey],
        ["real", item.realPathKey],
        ["identity", item.identityKey]
      ].filter(([, value]) => value);
      if (hasOutsideReferences(references, keys, selectedIds, managedRootGroupKey(item.managedRoot))) {
        throw statusError("短视频文件在计划创建期间新增了引用", 409, "SHORT_VIDEO_DELETE_LATE_REFERENCE");
      }
    }
  }

  async function planItems(db, jobId, token, rows, references) {
    const ids = new Set(rows.map((row) => String(row.id)));
    const rawPaths = [];
    for (const row of rows) {
      rawPaths.push(row.source_path || "", row.cover_path || "", row.music_path || "", row.data_path || "");
    }
    const placeholders = rows.map(() => "?").join(", ");
    const assets = db.prepare(`
      SELECT local_path FROM short_video_assets
      WHERE video_id IN (${placeholders}) AND trim(local_path) <> ''
      ORDER BY video_id, id
    `).all(...rows.map((row) => row.id));
    rawPaths.push(...assets.map((row) => row.local_path || ""));

    const seen = new Set();
    const seenPhysical = new Set();
    const items = [];
    for (const rawPath of rawPaths) {
      const value = String(rawPath || "").trim();
      if (!value) continue;
      if (value.length > 32_767) throw statusError("短视频文件路径过长，已拒绝删除", 409, "SHORT_VIDEO_DELETE_PATH_INVALID");
      const originalPath = path.resolve(value);
      const key = pathKey(originalPath);
      if (seen.has(key)) continue;
      seen.add(key);
      const relativePath = String(displayPath(originalPath));
      const managedRoot = managedRootFor(originalPath, managedRoots);
      if (!managedRoot) {
        items.push(plannedItem(items.length, originalPath, key, relativePath, "skipped", "不在短视频目录内"));
        continue;
      }
      const entry = lstatIfPresent(originalPath);
      if (!entry) {
        const realPathKey = canonicalPathKey(originalPath);
        const referenceKeys = [["path", key], ["real", realPathKey]].filter(([, candidate]) => candidate);
        const rootGroupKey = managedRootGroupKey(managedRoot);
        if (hasOutsideReferences(references, referenceKeys, ids, rootGroupKey)) {
          items.push(plannedItem(
            items.length,
            originalPath,
            key,
            relativePath,
            "retained",
            "仍被其他短视频引用",
            managedRoot,
            "",
            null,
            realPathKey
          ));
          continue;
        }
        items.push(plannedItem(items.length, originalPath, key, relativePath, "missing", "", managedRoot, "", null, realPathKey));
        continue;
      }
      if (entry.isSymbolicLink()) {
        const probe = probeReferencePath(originalPath);
        items.push(plannedItem(
          items.length,
          originalPath,
          key,
          relativePath,
          "retained",
          "检测到符号链接或重解析路径，已保留文件",
          managedRoot,
          "",
          null,
          probe.realPathKey || "",
          probe.identityKey || ""
        ));
        continue;
      }
      if (!entry.isFile()) {
        items.push(plannedItem(items.length, originalPath, key, relativePath, "skipped", "不是文件"));
        continue;
      }
      const sourceIdentity = captureManagedFileIdentity(originalPath, managedRoot, entry);
      const realPathKey = String(sourceIdentity.realPathKey || "");
      const identityKey = physicalIdentityKey(sourceIdentity);
      const referenceKeys = [["path", key], ["real", realPathKey], ["identity", identityKey]].filter(([, value]) => value);
      const rootGroupKey = managedRootGroupKey(managedRoot);
      if (hasOutsideReferences(references, referenceKeys, ids, rootGroupKey)) {
        items.push(plannedItem(
          items.length,
          originalPath,
          key,
          relativePath,
          "retained",
          "仍被其他短视频引用",
          managedRoot,
          "",
          sourceIdentity,
          realPathKey,
          identityKey
        ));
        continue;
      }
      if (Number(sourceIdentity.nlink || 0) > 1) {
        items.push(plannedItem(
          items.length,
          originalPath,
          key,
          relativePath,
          "retained",
          "检测到硬链接，已保留文件",
          managedRoot,
          "",
          sourceIdentity,
          realPathKey,
          identityKey
        ));
        continue;
      }
      if (sourceIdentity.aliasRisk) {
        items.push(plannedItem(
          items.length,
          originalPath,
          key,
          relativePath,
          "retained",
          "检测到符号链接或重解析路径，已保留文件",
          managedRoot,
          "",
          sourceIdentity,
          realPathKey,
          identityKey
        ));
        continue;
      }
      const physicalKey = referenceLookupKey("real", realPathKey);
      if (seenPhysical.has(physicalKey)) {
        items.push(plannedItem(
          items.length,
          originalPath,
          key,
          relativePath,
          "alias",
          "",
          managedRoot,
          "",
          sourceIdentity,
          realPathKey,
          identityKey
        ));
        continue;
      }
      seenPhysical.add(physicalKey);
      const quarantinePath = quarantineFilePath(managedRoot, jobId, token, items.length, originalPath);
      items.push(plannedItem(
        items.length,
        originalPath,
        key,
        relativePath,
        "delete",
        "",
        managedRoot,
        quarantinePath,
        sourceIdentity,
        realPathKey,
        identityKey
      ));
    }
    const retainedPhysical = new Map();
    for (const item of items.filter((entry) => entry.disposition === "retained")) {
      for (const keyValue of [item.realPathKey, item.identityKey].filter(Boolean)) {
        retainedPhysical.set(keyValue, item.reason || "检测到链接或共享引用，已保留文件");
      }
    }
    for (const item of items) {
      if (!["delete", "alias"].includes(item.disposition)) continue;
      const reason = [item.realPathKey, item.identityKey]
        .filter(Boolean)
        .map((keyValue) => retainedPhysical.get(keyValue))
        .find(Boolean);
      if (!reason) continue;
      item.disposition = "retained";
      item.reason = reason;
      item.quarantinePath = "";
    }
    return items;
  }

  async function isolatePlannedFiles(db, jobId) {
    updateJob(db, jobId, { status: "running", phase: "isolating", error: "", errorCode: "" });
    const executionToken = requireActiveExecutionToken(jobId);
    for (const planned of readItems(db, jobId)) {
      if (planned.disposition !== "delete" || planned.state === "isolated") continue;
      const item = readItem(db, jobId, planned.ordinal);
      if (!item || !["planned", "isolating"].includes(item.state)) {
        throw codedError("隔离文件计划状态已变化", "SHORT_VIDEO_DELETE_ITEM_CHANGED");
      }
      const expected = parseJson(item.source_identity_json, null);
      const current = requireManagedFileIdentity(
        item.original_path,
        item.managed_root,
        expected,
        "源文件身份已变化"
      );
      const job = requireOwnedJob(db, jobId);
      const jobDir = ensureOwnedJobDirectory(job, item.managed_root, current.dev);
      if (path.dirname(item.quarantine_path) !== jobDir) {
        throw codedError("隔离目录与持久计划不一致", "SHORT_VIDEO_DELETE_QUARANTINE_MISMATCH");
      }
      assertPathMissing(item.quarantine_path, "隔离目标已被占用");
      await invokeHook(hooks.beforeItemIsolated, { jobId, ordinal: item.ordinal });

      beginImmediate(db);
      try {
        heartbeat(db, jobId);
        requireOwnedJob(db, jobId);
        const lockedItem = readItem(db, jobId, planned.ordinal);
        if (!lockedItem || !["planned", "isolating"].includes(lockedItem.state)) {
          throw codedError("隔离文件计划状态已变化", "SHORT_VIDEO_DELETE_ITEM_CHANGED");
        }
        assertCheapManagedFileIdentity(lockedItem.original_path, lockedItem.managed_root, current, "源文件身份已变化");
        const intent = db.prepare(`
          UPDATE short_video_delete_items
          SET state = 'isolating', error = '', updated_at = ?
          WHERE job_id = ? AND ordinal = ? AND state IN ('planned', 'isolating')
            AND EXISTS (
              SELECT 1 FROM short_video_delete_jobs job
              WHERE job.id = short_video_delete_items.job_id
                AND job.owner_id = ? AND job.execution_token = ?
            )
        `).run(now(), jobId, item.ordinal, ownerId, executionToken);
        if (Number(intent.changes || 0) !== 1) {
          throw codedError("隔离文件 intent CAS 失败", "SHORT_VIDEO_DELETE_LEASE_LOST");
        }
        db.exec("COMMIT");
      } catch (error) {
        rollback(db);
        throw error;
      }

      await invokeHook(hooks.afterItemIsolationIntent, { jobId, ordinal: item.ordinal });
      const isolated = await publishManagedFileNoReplaceAndCaptureSource(
        db,
        requireOwnedJob(db, jobId),
        item,
        "isolate-media",
        item.original_path,
        item.quarantine_path,
        current
      );
      const guardIdentity = await createGuard(
        db,
        item.original_path,
        item.managed_root,
        expected,
        job,
        item.ordinal,
        jobDir
      );

      beginImmediate(db);
      try {
        heartbeat(db, jobId);
        requireOwnedJob(db, jobId);
        assertCheapManagedFileIdentity(
          item.quarantine_path,
          item.managed_root,
          isolated,
          "隔离文件身份已变化"
        );
        if (!isOwnedGuard(item.original_path, job, item.ordinal, JSON.stringify(guardIdentity))) {
          throw codedError("源文件 guard 已被替换", "SHORT_VIDEO_DELETE_GUARD_REPLACED");
        }
        const checkpoint = db.prepare(`
          UPDATE short_video_delete_items
          SET state = 'isolated', quarantine_identity_json = ?, guard_identity_json = ?, error = '', updated_at = ?
          WHERE job_id = ? AND ordinal = ? AND state = 'isolating'
            AND EXISTS (
              SELECT 1 FROM short_video_delete_jobs job
              WHERE job.id = short_video_delete_items.job_id
                AND job.owner_id = ? AND job.execution_token = ?
            )
        `).run(JSON.stringify(isolated), JSON.stringify(guardIdentity), now(), jobId, item.ordinal, ownerId, executionToken);
        if (Number(checkpoint.changes || 0) !== 1) {
          throw codedError("隔离文件检查点 CAS 失败", "SHORT_VIDEO_DELETE_LEASE_LOST");
        }
        db.exec("COMMIT");
      } catch (error) {
        rollback(db);
        throw error;
      }
      await invokeHook(hooks.afterItemIsolated, { jobId, ordinal: planned.ordinal });
    }
    updateJob(db, jobId, { status: "running", phase: "isolated", error: "", errorCode: "" });
  }

  async function commitRows(db, jobId) {
    const job = requireOwnedJob(db, jobId);
    const executionToken = requireActiveExecutionToken(jobId);
    const ids = videoIds(job);
    await invokeHook(hooks.beforeDatabaseCommit, publicHookJob(job));
    const preparedItems = new Map();
    for (const item of readItems(db, jobId)) {
      preparedItems.set(item.ordinal, await assertItemReadyForCommit(item, job));
    }
    await buildTargetedReferenceSnapshot(db, { phase: "commit", jobId });
    beginImmediate(db);
    try {
      const current = readJob(db, jobId);
      if (!current
        || current.owner_id !== ownerId
        || String(current.execution_token || "") !== executionToken) {
        throw codedError("删除作业 lease 已丢失", "SHORT_VIDEO_DELETE_LEASE_LOST");
      }
      const rows = rowsForIds(db, ids);
      if (rows.size !== ids.length) throw codedError("短视频记录在提交前已发生变化", "SHORT_VIDEO_DELETE_CHANGED");
      const currentItems = readItems(db, jobId);
      const references = currentReferencesForItems(db, currentItems);
      assertNoLateReferences(db, current, references);
      for (const item of currentItems) {
        if (["skipped", "alias", "retained"].includes(item.disposition)) continue;
        if (item.disposition === "missing") {
          assertPathMissing(item.original_path, "删除计划中的缺失路径已被占用");
          continue;
        }
        if (item.state !== "isolated") throw codedError("仍有文件未完成隔离", "SHORT_VIDEO_DELETE_NOT_ISOLATED");
        const prepared = preparedItems.get(item.ordinal);
        if (!prepared) throw codedError("隔离文件提交候选缺失", "SHORT_VIDEO_DELETE_FILE_REPLACED");
        assertCheapManagedFileIdentity(item.quarantine_path, item.managed_root, prepared, "隔离文件已被替换");
        if (!isOwnedGuard(item.original_path, current, item.ordinal, item.guard_identity_json)) {
          throw codedError("源文件 guard 已被替换", "SHORT_VIDEO_DELETE_GUARD_REPLACED");
        }
      }
      db.prepare(`
        UPDATE short_video_delete_reservations
        SET mutation_mode = 'commit', updated_at = ?
        WHERE job_id = ? AND released_at = ''
      `).run(now(), jobId);
      const timestamp = now();
      const tombstone = db.prepare(`
        INSERT INTO ${PATH_TOMBSTONE_TABLE} (
          path_key, job_id, original_path, real_path_key, identity_key, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
      `);
      const videoIdentityKeys = uniqueStrings(
        currentItems.map((item) => item.identity_key).filter(Boolean),
        10_000
      );
      const videoTombstone = db.prepare(`
        INSERT INTO ${VIDEO_TOMBSTONE_TABLE} (
          video_id, job_id, identity_keys_json, state, created_at, updated_at
        ) VALUES (?, ?, ?, 'active', ?, ?)
      `);
      for (const id of ids) {
        videoTombstone.run(id, jobId, JSON.stringify(videoIdentityKeys), timestamp, timestamp);
      }
      for (const item of currentItems.filter((entry) => ["delete", "missing", "alias", "retained"].includes(entry.disposition))) {
        if (hasOutsideReferences(references, [["path", item.path_key]], new Set(ids))) continue;
        tombstone.run(
          item.path_key,
          jobId,
          item.original_path,
          item.real_path_key,
          item.identity_key,
          timestamp,
          timestamp
        );
      }
      const deletedCount = Number(deleteRows(db, ids) || 0);
      if (deletedCount !== ids.length) {
        throw codedError("短视频记录删除数量与持久计划不一致", "SHORT_VIDEO_DELETE_COMMIT_MISMATCH");
      }
      db.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('deleted_at', ?)").run(now());
      const result = buildResultFromRows(current, readItems(db, jobId));
      const committed = db.prepare(`
        UPDATE short_video_delete_jobs
        SET status = 'cleanup_pending', phase = 'db_committed', result_json = ?,
            error = '', error_code = '', updated_at = ?, version = version + 1
        WHERE id = ? AND owner_id = ? AND execution_token = ?
      `).run(JSON.stringify(result), now(), jobId, ownerId, executionToken);
      if (Number(committed.changes || 0) !== 1) {
        throw codedError("删除作业提交 CAS 失败", "SHORT_VIDEO_DELETE_LEASE_LOST");
      }
      db.prepare(`
        UPDATE short_video_delete_reservations
        SET mutation_mode = 'cleanup', updated_at = ?
        WHERE job_id = ? AND released_at = ''
      `).run(now(), jobId);
      db.exec("COMMIT");
    } catch (error) {
      rollback(db);
      throw error;
    }
  }

  async function cleanupCommitted(db, jobId, options = {}) {
    const job = options.claimedJob || claim(db, jobId, options.executionToken);
    if (!job) return readJob(db, jobId);
    const executionToken = requireActiveExecutionToken(jobId);
    if (databaseDisposition(db, job) !== "committed") {
      throw codedError("数据库删除尚未提交，拒绝清理隔离文件", "SHORT_VIDEO_DELETE_DIRECTION_MISMATCH");
    }
    updateJob(db, jobId, { status: "cleanup_pending", phase: "cleanup", error: "", errorCode: "" });
    let result = buildResult(db, jobId);
    let coverCleanupError = "";
    const currentJob = readJob(db, jobId);
    if (!Number(currentJob.cover_cleanup_done || 0)) {
      try {
        result.deletedStoredCovers = Number(deleteStoredCovers?.(videoIds(job), coverDeleteReceipt(job)) || 0);
      } catch (error) {
        if (isCoverReceiptConflict(error)) throw error;
        coverCleanupError = String(error?.message || error);
        result.coverCleanupError = coverCleanupError;
      }
      if (coverCleanupError) {
        const pendingResult = db.prepare(`
          UPDATE short_video_delete_jobs
          SET result_json = ?, updated_at = ?
          WHERE id = ? AND owner_id = ? AND execution_token = ?
        `).run(JSON.stringify(result), now(), jobId, ownerId, executionToken);
        if (Number(pendingResult.changes || 0) !== 1) {
          throw codedError("删除作业封面清理 CAS 失败", "SHORT_VIDEO_DELETE_LEASE_LOST");
        }
        throw codedError("短视频封面清理等待重试", "SHORT_VIDEO_DELETE_COVER_CLEANUP_PENDING", coverCleanupError);
      }
      const coverCleaned = db.prepare(`
        UPDATE short_video_delete_jobs
        SET cover_cleanup_done = 1, deleted_stored_covers = ?, result_json = ?, updated_at = ?
        WHERE id = ? AND owner_id = ? AND execution_token = ?
      `).run(result.deletedStoredCovers, JSON.stringify(result), now(), jobId, ownerId, executionToken);
      if (Number(coverCleaned.changes || 0) !== 1) {
        throw codedError("删除作业封面清理 CAS 失败", "SHORT_VIDEO_DELETE_LEASE_LOST");
      }
    } else {
      result.deletedStoredCovers = Number(currentJob.deleted_stored_covers || 0);
    }

    await buildTargetedReferenceSnapshot(db, { phase: "cleanup", jobId });
    beginImmediate(db);
    try {
      const current = requireOwnedJob(db, jobId);
      if (databaseDisposition(db, current) !== "committed") {
        throw codedError("数据库删除尚未提交，拒绝清理隔离文件", "SHORT_VIDEO_DELETE_DIRECTION_MISMATCH");
      }
      const references = currentReferencesForItems(db, readItems(db, jobId));
      assertNoLateReferences(db, current, references);
      db.exec("COMMIT");
    } catch (error) {
      rollback(db);
      throw error;
    }

    for (const planned of readItems(db, jobId)) {
      if (planned.disposition === "missing") {
        assertPathMissing(planned.original_path, "删除计划中的缺失路径已被占用");
        continue;
      }
      if (planned.disposition !== "delete" || planned.state === "cleaned") continue;
      const actionable = releaseIsolateMediaEvidence(db, requireOwnedJob(db, jobId), planned);
      const candidate = await inspectCleanupCandidate(requireOwnedJob(db, jobId), actionable);
      beginImmediate(db);
      try {
        heartbeat(db, jobId);
        requireOwnedJob(db, jobId);
        assertCleanupCandidateCheap(requireOwnedJob(db, jobId), actionable, candidate);
        const intent = db.prepare(`
          UPDATE short_video_delete_items
          SET state = 'cleaning', error = '', updated_at = ?
          WHERE job_id = ? AND ordinal = ? AND state IN ('isolated', 'cleaning')
            AND EXISTS (
              SELECT 1 FROM short_video_delete_jobs job
              WHERE job.id = short_video_delete_items.job_id
                AND job.owner_id = ? AND job.execution_token = ?
            )
        `).run(now(), jobId, planned.ordinal, ownerId, executionToken);
        if (Number(intent.changes || 0) !== 1) throw codedError("隔离文件清理 intent CAS 失败", "SHORT_VIDEO_DELETE_LEASE_LOST");
        db.exec("COMMIT");
      } catch (error) {
        rollback(db);
        throw error;
      }

      await cleanupIsolatedItem(db, requireOwnedJob(db, jobId), { ...actionable, state: "cleaning" }, candidate);

      beginImmediate(db);
      try {
        heartbeat(db, jobId);
        requireOwnedJob(db, jobId);
        const checkpoint = db.prepare(`
          UPDATE short_video_delete_items
          SET state = 'cleaned', error = '', updated_at = ?
          WHERE job_id = ? AND ordinal = ? AND state = 'cleaning'
            AND EXISTS (
              SELECT 1 FROM short_video_delete_jobs job
              WHERE job.id = short_video_delete_items.job_id
                AND job.owner_id = ? AND job.execution_token = ?
            )
        `).run(now(), jobId, planned.ordinal, ownerId, executionToken);
        if (Number(checkpoint.changes || 0) !== 1) throw codedError("隔离文件清理检查点 CAS 失败", "SHORT_VIDEO_DELETE_LEASE_LOST");
        db.exec("COMMIT");
      } catch (error) {
        rollback(db);
        throw error;
      }
      await invokeHook(hooks.afterItemCleaned, { jobId, ordinal: planned.ordinal });
    }

    const finalItems = readItems(db, jobId);
    result.emptyRemovedPaths = removeEmptyParents(
      finalItems.filter((item) => item.disposition === "delete").map((item) => item.original_path)
    );
    result.coverCleanupError = "";
    finalizeOwnedDirectories(db, requireOwnedJob(db, jobId), finalItems);
    finishJob(db, jobId, "completed", result);
    pruneTerminalJobs(db);
    return readJob(db, jobId);
  }

  async function rollbackUncommitted(db, jobId, options = {}) {
    const job = options.claimedJob || claim(db, jobId, options.executionToken);
    if (!job) return readJob(db, jobId);
    const executionToken = requireActiveExecutionToken(jobId);
    if (databaseDisposition(db, job) !== "uncommitted") {
      throw codedError("数据库删除已经提交，拒绝恢复原文件", "SHORT_VIDEO_DELETE_DIRECTION_MISMATCH");
    }
    updateJob(db, jobId, { status: "rollback_pending", phase: "rollback", error: "", errorCode: "" });
    const items = readItems(db, jobId).slice().reverse();
    for (const planned of items) {
      if (planned.disposition !== "delete" || planned.state === "restored") continue;
      if (planned.state === "planned") {
        // No filesystem intent was ever journaled for this item. External
        // disappearance/replacement is therefore not ours to undo and must not
        // strand the video row behind a permanent rollback reservation.
        beginImmediate(db);
        try {
          heartbeat(db, jobId);
          requireOwnedJob(db, jobId);
          const untouched = db.prepare(`
            UPDATE short_video_delete_items
            SET state = 'restored', error = '', updated_at = ?
            WHERE job_id = ? AND ordinal = ? AND state = 'planned'
              AND EXISTS (
                SELECT 1 FROM short_video_delete_jobs job
                WHERE job.id = short_video_delete_items.job_id
                  AND job.owner_id = ? AND job.execution_token = ?
              )
          `).run(now(), jobId, planned.ordinal, ownerId, executionToken);
          if (Number(untouched.changes || 0) !== 1) {
            throw codedError("未隔离文件回滚检查点 CAS 失败", "SHORT_VIDEO_DELETE_LEASE_LOST");
          }
          db.exec("COMMIT");
        } catch (error) {
          rollback(db);
          throw error;
        }
        continue;
      }
      const actionable = releaseIsolateMediaEvidence(db, requireOwnedJob(db, jobId), planned);
      const candidate = await inspectRestoreCandidate(requireOwnedJob(db, jobId), actionable);
      beginImmediate(db);
      try {
        heartbeat(db, jobId);
        requireOwnedJob(db, jobId);
        const current = readItem(db, jobId, planned.ordinal);
        if (!current) throw codedError("删除作业文件检查点缺失", "SHORT_VIDEO_DELETE_ITEM_MISSING");
        if (current.state === "restored") {
          db.exec("COMMIT");
          continue;
        }
        assertRestoreCandidateCheap(requireOwnedJob(db, jobId), current, candidate);
        const intent = db.prepare(`
          UPDATE short_video_delete_items
          SET state = 'restoring', error = '', updated_at = ?
          WHERE job_id = ? AND ordinal = ? AND state IN ('planned', 'isolating', 'isolated', 'restoring')
            AND EXISTS (
              SELECT 1 FROM short_video_delete_jobs job
              WHERE job.id = short_video_delete_items.job_id
                AND job.owner_id = ? AND job.execution_token = ?
            )
        `).run(now(), jobId, current.ordinal, ownerId, executionToken);
        if (Number(intent.changes || 0) !== 1) throw codedError("源文件恢复 intent CAS 失败", "SHORT_VIDEO_DELETE_LEASE_LOST");
        db.exec("COMMIT");
      } catch (error) {
        rollback(db);
        throw error;
      }

      const restoredIdentity = await restoreIsolatedItem(
        db,
        requireOwnedJob(db, jobId),
        { ...actionable, state: "restoring" },
        candidate
      );

      beginImmediate(db);
      try {
        heartbeat(db, jobId);
        requireOwnedJob(db, jobId);
        assertCheapManagedFileIdentity(
          planned.original_path,
          planned.managed_root,
          restoredIdentity,
          "恢复后的源文件身份不一致"
        );
        const checkpoint = db.prepare(`
          UPDATE short_video_delete_items
          SET state = 'restored', source_identity_json = ?, error = '', updated_at = ?
          WHERE job_id = ? AND ordinal = ? AND state = 'restoring'
            AND EXISTS (
              SELECT 1 FROM short_video_delete_jobs job
              WHERE job.id = short_video_delete_items.job_id
                AND job.owner_id = ? AND job.execution_token = ?
            )
        `).run(JSON.stringify(restoredIdentity), now(), jobId, planned.ordinal, ownerId, executionToken);
        if (Number(checkpoint.changes || 0) !== 1) throw codedError("源文件恢复检查点 CAS 失败", "SHORT_VIDEO_DELETE_LEASE_LOST");
        db.exec("COMMIT");
      } catch (error) {
        rollback(db);
        throw error;
      }
      await invokeHook(hooks.afterItemRestored, { jobId, ordinal: planned.ordinal });
    }
    finalizeOwnedDirectories(db, job, readItems(db, jobId));
    finishJob(db, jobId, "rolled_back", buildResult(db, jobId));
    pruneTerminalJobs(db);
    return readJob(db, jobId);
  }

  async function recoverPending({ db = database(), jobId = "" } = {}) {
    assertAcceptingWork();
    ensureSchema(db);
    if (recovering) return status(db, { jobId });
    recovering = true;
    try {
      const selected = jobId ? readJob(db, jobId) : null;
      if (jobId && !selected) {
        throw statusError("短视频删除作业不存在", 404, "SHORT_VIDEO_DELETE_JOB_NOT_FOUND");
      }
      const rows = jobId
        ? [selected]
        : db.prepare(`
            SELECT * FROM short_video_delete_jobs
            WHERE status IN ('running', 'rollback_pending', 'cleanup_pending')
            ORDER BY created_at, id
          `).all();
      for (const row of rows) {
        if (!jobId && requiresManualIntervention(row.error_code)) continue;
        try {
          await recoverOne(db, row.id);
        } catch (error) {
          warn?.("[short-video-delete-recovery]", error);
        }
      }
      return status(db, { jobId });
    } finally {
      recovering = false;
    }
  }

  async function recoverOne(db, jobId, executionToken = "") {
    let token = executionToken;
    let ownsExecution = false;
    if (!token) {
      if (activeExecutionTokenFor(jobId)) return readJob(db, jobId);
      token = beginExecution(jobId);
      ownsExecution = true;
    }
    try {
      const job = claim(db, jobId, token);
      if (!job) return readJob(db, jobId);
      if (ownsExecution) await invokeHook(hooks.afterRecoveryClaim, { jobId });
      if (job.phase === "logical_cleanup" && isKeyedJob(job)) {
        return await cleanupLogicalCommitted(db, job);
      }
      reconcileFsActions(db, job);
      const disposition = databaseDisposition(db, job);
      if (disposition === "committed") return await cleanupCommitted(db, jobId, { claimedJob: job, executionToken: token });
      if (disposition === "uncommitted") return await rollbackUncommitted(db, jobId, { claimedJob: job, executionToken: token });
      throw codedError("短视频记录处于部分删除状态，已停止自动文件操作", "SHORT_VIDEO_DELETE_PARTIAL_COMMIT");
    } catch (error) {
      const current = readJob(db, jobId);
      if (current
        && current.owner_id === ownerId
        && String(current.execution_token || "") === token) {
        const logicalCleanup = current.phase === "logical_cleanup" && isKeyedJob(current);
        const disposition = logicalCleanup ? "committed" : databaseDisposition(db, current);
        rememberPending(
          db,
          current.id,
          disposition === "committed" ? "cleanup_pending" : "rollback_pending",
          logicalCleanup ? "logical_cleanup" : disposition === "committed" ? "cleanup" : "rollback",
          error
        );
      }
      throw error;
    } finally {
      if (ownsExecution) endExecution(db, jobId, token);
    }
  }

  function status(db = database(), options = {}) {
    assertAcceptingWork();
    ensureSchema(db);
    const jobId = String(options.jobId || "").trim();
    if (jobId) {
      const row = readJob(db, jobId);
      if (!row) {
        const operation = readOperation(db, jobId);
        if (operation && TERMINAL_STATUSES.includes(String(operation.terminal_status || ""))) {
          return { ok: true, job: publicReceipt(operation) };
        }
        if (operation) {
          throw statusError(
            "短视频删除幂等记录不完整，已拒绝读取",
            409,
            "SHORT_VIDEO_DELETE_OPERATION_INCOMPLETE"
          );
        }
        throw statusError("短视频删除作业不存在", 404, "SHORT_VIDEO_DELETE_JOB_NOT_FOUND");
      }
      return { ok: true, job: publicJob(row) };
    }
    const counts = Object.fromEntries(db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM short_video_delete_jobs
      GROUP BY status
    `).all().map((row) => [row.status, Number(row.count || 0)]));
    const pending = db.prepare(`
      SELECT id, status, phase, scope, anchor_id, video_ids_json, attempts,
             owner_id, lease_until, execution_token, error_code, created_at, updated_at
      FROM short_video_delete_jobs
      WHERE status IN ('running', 'rollback_pending', 'cleanup_pending')
      ORDER BY created_at, id
      LIMIT 100
    `).all().map(publicJob);
    const jobs = pending;
    return {
      ok: true,
      pending: ACTIVE_STATUSES.reduce((total, key) => total + Number(counts[key] || 0), 0),
      active: ACTIVE_STATUSES.reduce((total, key) => total + Number(counts[key] || 0), 0),
      cleanupPending: Number(counts.cleanup_pending || 0),
      rollbackPending: Number(counts.rollback_pending || 0),
      completed: Number(counts.completed || 0),
      rolledBack: Number(counts.rolled_back || 0),
      requiresAttention: jobs.filter((job) => job.requiresAttention).length,
      stalled: jobs.filter((job) => job.stalled).length,
      oldestPendingAt: pending[0]?.createdAt || "",
      jobs
    };
  }

  function assertPathWritesAllowed(db, values = [], options = {}) {
    assertOpen();
    if (!db?.isTransaction) {
      throw codedError("短视频路径写入必须持有数据库写事务", "SHORT_VIDEO_PATH_WRITE_NOT_FENCED");
    }
    const reserved = db.prepare(`
      SELECT 1
      FROM short_video_delete_reservations
      WHERE kind = ? AND reservation_key = ? AND released_at = ''
      LIMIT 1
    `);
    const seen = new Set();
    const identities = new Set();
    const candidatePaths = [];
    for (const value of values || []) {
      const text = String(value || "").trim();
      if (!text) continue;
      const lexical = pathKey(text);
      if (seen.has(lexical)) continue;
      seen.add(lexical);
      const lexicalRoot = managedRootFor(text, managedRoots);
      if (lexicalRoot && isQuarantinePath(text, lexicalRoot)) {
        throw statusError("短视频路径属于删除隔离目录", 409, "SHORT_VIDEO_PATH_WRITE_UNAVAILABLE");
      }
      let entry;
      let realPathKey;
      try {
        entry = fsOps.lstatSync(text, { bigint: true });
        if (!entry.isFile() || entry.isSymbolicLink()) {
          throw codedError("短视频路径不是普通文件", "SHORT_VIDEO_PATH_WRITE_UNAVAILABLE");
        }
        const realFilePath = realpath(text);
        realPathKey = pathKey(realFilePath);
        const physicalRoot = managedRootGroupForRealPath(realPathKey);
        if (!physicalRoot) {
          throw codedError("短视频路径通过链接逃逸受管目录", "SHORT_VIDEO_PATH_WRITE_UNAVAILABLE");
        }
        const lexicalManagedRoot = managedRootFor(text, managedRoots);
        if (!lexicalManagedRoot || pathHasAliasRisk(text, lexicalManagedRoot, realFilePath, realpath(lexicalManagedRoot))) {
          throw codedError("短视频路径包含链接或重解析目录", "SHORT_VIDEO_PATH_WRITE_UNAVAILABLE");
        }
        if (Number(entry.size) <= 1024) {
          const content = fsOps.readFileSync(text, "utf8");
          if (content.startsWith(`${GUARD_PREFIX}:`)) {
            throw codedError("短视频路径正被删除作业隔离", "SHORT_VIDEO_PATH_WRITE_UNAVAILABLE");
          }
        }
      } catch (error) {
        if (error?.statusCode === 409) throw error;
        throw statusError("短视频本地文件不可用，已拒绝写入索引", 409, "SHORT_VIDEO_PATH_WRITE_UNAVAILABLE");
      }
      const keys = [
        ["path", lexical],
        ["real", realPathKey],
        ["identity", physicalIdentityKey(captureIdentity(entry))]
      ];
      if (keys.some(([kind, key]) => key && reserved.get(kind, key))) {
        throw statusError("短视频文件正由删除作业处理", 409, "SHORT_VIDEO_DELETE_CONFLICT");
      }
      const identityKey = physicalIdentityKey(captureIdentity(entry));
      identities.add(identityKey);
      candidatePaths.push({ lexical, realPathKey, identityKey });
      const tombstones = db.prepare(`
        SELECT path_key, real_path_key, identity_key
        FROM ${PATH_TOMBSTONE_TABLE}
        WHERE state = 'active'
          AND (path_key = ? OR (real_path_key <> '' AND real_path_key = ?) OR (identity_key <> '' AND identity_key = ?))
      `).all(lexical, realPathKey, identityKey);
      if (tombstones.length) {
        const exact = tombstones.filter((item) => item.path_key === lexical);
        if (!exact.length || exact.some((item) => item.identity_key && item.identity_key === identityKey)) {
          throw statusError("短视频删除墓碑仍指向旧文件身份", 409, "SHORT_VIDEO_PATH_WRITE_UNAVAILABLE");
        }
        const consumed = db.prepare(`
          DELETE FROM ${PATH_TOMBSTONE_TABLE}
          WHERE state = 'active' AND path_key = ?
        `);
        for (const item of exact) {
          if (Number(consumed.run(item.path_key).changes || 0) !== 1) {
            throw statusError("短视频删除墓碑状态已变化", 409, "SHORT_VIDEO_PATH_WRITE_UNAVAILABLE");
          }
        }
      }
    }
    const videoId = String(options.videoId || "").trim();
    if (videoId) {
      const videoTombstone = db.prepare(`
        SELECT video_id, identity_keys_json
        FROM ${VIDEO_TOMBSTONE_TABLE}
        WHERE state = 'active' AND video_id = ?
      `).get(videoId);
      if (videoTombstone) {
        if (!candidatePaths.length) {
          throw statusError("短视频删除墓碑缺少可验证的新文件", 409, "SHORT_VIDEO_PATH_WRITE_UNAVAILABLE");
        }
        const deletedIdentities = new Set(parseJson(videoTombstone.identity_keys_json, []));
        if ([...identities].some((identity) => deletedIdentities.has(identity))) {
          throw statusError("短视频删除墓碑仍指向旧文件身份", 409, "SHORT_VIDEO_PATH_WRITE_UNAVAILABLE");
        }
        const removed = db.prepare(`
          DELETE FROM ${VIDEO_TOMBSTONE_TABLE}
          WHERE state = 'active' AND video_id = ? AND identity_keys_json = ?
        `).run(videoId, videoTombstone.identity_keys_json);
        if (Number(removed.changes || 0) !== 1) {
          throw statusError("短视频删除墓碑状态已变化", 409, "SHORT_VIDEO_PATH_WRITE_UNAVAILABLE");
        }
      }
    }
    return true;
  }

  function claim(db, jobId, executionToken = "") {
    beginImmediate(db);
    try {
      const job = readJob(db, jobId);
      if (!job || TERMINAL_STATUSES.includes(job.status)) {
        db.exec("COMMIT");
        return job;
      }
      const previousOwner = String(job.owner_id || "");
      const previousLease = String(job.lease_until || "");
      const previousExecutionToken = String(job.execution_token || "");
      const continuingExecution = Boolean(
        executionToken
        && previousExecutionToken === executionToken
        && previousOwner === ownerId
      );
      const reclaimingReleasedExecution = Boolean(
        executionToken
        && previousOwner === ownerId
        && previousExecutionToken
        && relinquishableExecutions.get(String(jobId || "")) === previousExecutionToken
      );
      if (
        !continuingExecution
        && !reclaimingReleasedExecution
        && durableExecutionStillExclusive(previousOwner, previousLease, previousExecutionToken)
      ) {
        db.exec("COMMIT");
        return null;
      }
      const result = db.prepare(`
        UPDATE short_video_delete_jobs
        SET owner_id = ?, lease_until = ?, execution_token = ?, attempts = attempts + 1,
            updated_at = ?, version = version + 1
        WHERE id = ? AND version = ? AND owner_id = ? AND lease_until = ? AND execution_token = ?
          AND status IN ('running', 'rollback_pending', 'cleanup_pending')
      `).run(
        ownerId,
        leaseUntil(),
        executionToken,
        now(),
        jobId,
        Number(job.version || 0),
        previousOwner,
        previousLease,
        previousExecutionToken
      );
      if (Number(result.changes || 0) !== 1) {
        db.exec("COMMIT");
        return null;
      }
      relinquishableExecutions.delete(String(jobId || ""));
      db.exec("COMMIT");
      return readJob(db, jobId);
    } catch (error) {
      rollback(db);
      throw error;
    }
  }

  function beginClose() {
    if (closed) return Promise.resolve();
    closing = true;
    if (!activeExecutions.size) return Promise.resolve();
    if (!closeDrainPromise) {
      closeDrainPromise = new Promise((resolve) => {
        resolveCloseDrain = resolve;
      });
    }
    return closeDrainPromise;
  }

  function close(db = null) {
    beginClose();
    if (activeExecutions.size) return false;
    closed = true;
    closing = false;
    if (!db) return activeExecutions.size === 0;
    try {
      const release = db.prepare(`
        UPDATE short_video_delete_jobs
        SET owner_id = '', lease_until = '', execution_token = '', updated_at = ?, version = version + 1
        WHERE id = ? AND owner_id = ? AND execution_token = ?
          AND status IN ('running', 'rollback_pending', 'cleanup_pending')
      `);
      for (const [jobId, executionToken] of relinquishableExecutions) {
        release.run(now(), jobId, ownerId, executionToken);
      }
      relinquishableExecutions.clear();
      return true;
    } catch (error) {
      warn?.("[short-video-delete-owner-close]", error);
      return false;
    }
  }

  function heartbeat(db, jobId) {
    const executionToken = requireActiveExecutionToken(jobId);
    const result = db.prepare(`
      UPDATE short_video_delete_jobs
      SET lease_until = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND owner_id = ? AND execution_token = ?
        AND status IN ('running', 'rollback_pending', 'cleanup_pending')
    `).run(leaseUntil(), now(), jobId, ownerId, executionToken);
    if (Number(result.changes || 0) !== 1) {
      throw codedError("删除作业 lease 已丢失", "SHORT_VIDEO_DELETE_LEASE_LOST");
    }
  }

  function finishJob(db, jobId, terminalStatus, result) {
    const job = requireOwnedJob(db, jobId);
    reconcileFsActions(db, job);
    const remainingAction = db.prepare(`
      SELECT stage, evidence_path FROM ${FS_ACTION_TABLE}
      WHERE job_id = ? ORDER BY action_key LIMIT 1
    `).get(jobId);
    if (remainingAction) {
      throw codedError(
        `文件动作尚未收敛 (${remainingAction.stage}): ${remainingAction.evidence_path}`,
        "SHORT_VIDEO_DELETE_FS_ACTION_UNBOUND"
      );
    }
    beginImmediate(db);
    try {
      finishJobInTransaction(db, jobId, terminalStatus, result);
      db.exec("COMMIT");
    } catch (error) {
      rollback(db);
      throw error;
    }
  }

  function finishJobInTransaction(db, jobId, terminalStatus, result) {
    const timestamp = now();
    const job = requireOwnedJob(db, jobId);
    const executionToken = requireActiveExecutionToken(jobId);
    const expectedFileReservationKeys = new Set(readItems(db, jobId)
      .filter((item) => ["delete", "missing", "alias", "retained"].includes(item.disposition))
      .flatMap((item) => [
        ["path", item.path_key],
        ["real", item.real_path_key],
        ["identity", item.identity_key]
      ].filter(([, value]) => value).map(([kind, value]) => referenceLookupKey(kind, value))));
    const expectedReservations = videoIds(job).length + expectedFileReservationKeys.size;
    const release = db.prepare(`
      UPDATE short_video_delete_reservations
      SET released_at = ?, mutation_mode = '', updated_at = ?
      WHERE job_id = ? AND released_at = ''
    `).run(timestamp, timestamp, jobId);
    if (Number(release.changes || 0) !== expectedReservations) {
      throw codedError("删除作业 reservation 不完整，拒绝结束", "SHORT_VIDEO_DELETE_RESERVATION_MISMATCH");
    }
    if (terminalStatus === "rolled_back") {
      db.prepare(`DELETE FROM ${PATH_TOMBSTONE_TABLE} WHERE job_id = ?`).run(jobId);
      db.prepare(`DELETE FROM ${VIDEO_TOMBSTONE_TABLE} WHERE job_id = ?`).run(jobId);
    }
    const update = db.prepare(`
      UPDATE short_video_delete_jobs
      SET status = ?, phase = ?, result_json = ?, error = '', error_code = '',
          owner_id = '', lease_until = '', execution_token = '', updated_at = ?, finished_at = ?, version = version + 1
      WHERE id = ? AND owner_id = ? AND execution_token = ?
    `).run(
      terminalStatus,
      terminalStatus === "completed" ? "completed" : "rolled_back",
      JSON.stringify(result),
      timestamp,
      timestamp,
      jobId,
      ownerId,
      executionToken
    );
    if (Number(update.changes || 0) !== 1) {
      throw codedError("删除作业终态 CAS 失败", "SHORT_VIDEO_DELETE_LEASE_LOST");
    }
    if (isKeyedJob(job)) {
      const receiptResult = sanitizedJobResult({ ...job, result_json: JSON.stringify(result) }, result);
      const receipt = db.prepare(`
        UPDATE ${OPERATION_TABLE}
        SET terminal_status = ?, result_json = ?, finished_at = ?
        WHERE operation_id = ? AND request_sha256 = ? AND terminal_status = ''
      `).run(terminalStatus, JSON.stringify(receiptResult), timestamp, jobId, job.request_sha256);
      if (Number(receipt.changes || 0) !== 1) {
        throw codedError("删除作业终态 receipt 不完整", "SHORT_VIDEO_DELETE_OPERATION_INCOMPLETE");
      }
    }
  }

  function rememberPending(db, jobId, statusValue, phase, error) {
    const code = String(error?.code || "SHORT_VIDEO_DELETE_FAILED").slice(0, 100);
    const message = String(error?.message || error || "删除作业等待恢复").slice(0, 2000);
    try {
      const update = db.prepare(`
        UPDATE short_video_delete_jobs
        SET status = ?, phase = ?, error = ?, error_code = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND owner_id = ? AND execution_token = ?
          AND status NOT IN ('completed', 'rolled_back')
      `).run(statusValue, phase, message, code, now(), jobId, ownerId, requireActiveExecutionToken(jobId));
      if (Number(update.changes || 0) !== 1) {
        warn?.("[short-video-delete-journal-owner-lost]", jobId);
      }
    } catch (writeError) {
      warn?.("[short-video-delete-journal]", writeError);
    }
  }

  function updateJob(db, jobId, values) {
    const executionToken = requireActiveExecutionToken(jobId);
    const result = db.prepare(`
      UPDATE short_video_delete_jobs
      SET status = ?, phase = ?, error = ?, error_code = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND owner_id = ? AND execution_token = ?
        AND status IN ('running', 'rollback_pending', 'cleanup_pending')
    `).run(values.status, values.phase, values.error || "", values.errorCode || "", now(), jobId, ownerId, executionToken);
    if (Number(result.changes || 0) !== 1) {
      throw codedError("删除作业 lease 已丢失", "SHORT_VIDEO_DELETE_LEASE_LOST");
    }
  }

  async function inspectCleanupCandidate(job, item) {
    const expected = quarantineIdentity(item);
    const quarantine = lstatIfPresent(item.quarantine_path);
    const source = lstatIfPresent(item.original_path);
    const guardOwned = isOwnedGuard(item.original_path, job, item.ordinal, item.guard_identity_json);
    if (quarantine) {
      const identity = requireManagedFileIdentity(item.quarantine_path, item.managed_root, expected, "隔离文件已被替换");
      if (!guardOwned) throw codedError("源文件 guard 已被替换", "SHORT_VIDEO_DELETE_GUARD_REPLACED");
      return { mode: "delete", identity, guardOwned: true };
    }
    if (guardOwned) return { mode: "guard_only", identity: null, guardOwned: true };
    if (source) throw codedError("隔离文件和源文件 guard 均不符合持久计划", "SHORT_VIDEO_DELETE_CLEANUP_STATE_UNKNOWN");
    return { mode: "already_cleaned", identity: null, guardOwned: false };
  }

  function assertCleanupCandidateCheap(job, item, candidate) {
    if (candidate.mode === "delete") {
      assertCheapManagedFileIdentity(item.quarantine_path, item.managed_root, candidate.identity, "隔离文件已被替换");
      if (!isOwnedGuard(item.original_path, job, item.ordinal, item.guard_identity_json)) {
        throw codedError("源文件 guard 已被替换", "SHORT_VIDEO_DELETE_GUARD_REPLACED");
      }
    } else if (candidate.mode === "guard_only") {
      if (!isOwnedGuard(item.original_path, job, item.ordinal, item.guard_identity_json)) {
        throw codedError("源文件 guard 已被替换", "SHORT_VIDEO_DELETE_GUARD_REPLACED");
      }
    } else if (lstatIfPresent(item.original_path) || lstatIfPresent(item.quarantine_path)) {
      throw codedError("隔离清理状态已变化", "SHORT_VIDEO_DELETE_CLEANUP_STATE_UNKNOWN");
    }
  }

  async function cleanupIsolatedItem(db, job, item, candidate) {
    if (candidate.mode === "delete") {
      assertCleanupCandidateCheap(job, item, candidate);
      await invokeHook(hooks.beforeQuarantineCleanup, { jobId: job.id, ordinal: item.ordinal });
      const action = beginFsAction(
        db,
        job,
        item,
        "quarantine-cleanup",
        item.quarantine_path,
        "",
        candidate.identity
      );
      capturePathIntoEvidence(
        db,
        job,
        item,
        action,
        (candidatePath) => captureManagedFileIdentity(candidatePath, item.managed_root),
        { neutralize: true }
      );
      removeOwnedGuard(db, job, item);
    } else if (candidate.mode === "guard_only") {
      removeOwnedGuard(db, job, item);
    }
    removeOwnedGuardTemp(db, job, item);
  }

  async function inspectRestoreCandidate(job, item) {
    const sourceExpected = parseJson(item.source_identity_json, null);
    const persistedQuarantine = parseJson(item.quarantine_identity_json, null);
    const source = lstatIfPresent(item.original_path);
    const quarantine = lstatIfPresent(item.quarantine_path);
    if (quarantine) {
      const currentQuarantine = persistedQuarantine
        ? requireManagedFileIdentity(
            item.quarantine_path,
            item.managed_root,
            persistedQuarantine,
            "隔离文件已被替换",
            { rollbackOwnedQuarantine: true }
          )
        : requireManagedFileIdentity(
            item.quarantine_path,
            item.managed_root,
            sourceExpected,
            "隔离文件身份无法从源计划转换",
            { transitionAfterRename: true }
          );
      let incompleteExclusiveGuard = null;
      if (source && !isOwnedGuard(item.original_path, job, item.ordinal, item.guard_identity_json)) {
        if (String(item.guard_publish_mode || "") === GUARD_PUBLISH_EXCLUSIVE_CREATE
          && !String(item.guard_publish_identity_json || "")) {
          throw codedError(
            "exclusive guard 已创建但缺少目的文件身份检查点",
            "SHORT_VIDEO_DELETE_GUARD_PUBLISH_IDENTITY_MISSING"
          );
        }
        incompleteExclusiveGuard = captureOwnedIncompleteExclusiveGuard(job, item);
        if (!incompleteExclusiveGuard) {
          throw codedError("原文件位置已被其他文件占用", "SHORT_VIDEO_DELETE_GUARD_REPLACED");
        }
      }
      return {
        mode: "restore",
        identity: currentQuarantine,
        guardOwned: Boolean(source),
        incompleteExclusiveGuard
      };
    }
    if (source && isOwnedGuard(item.original_path, job, item.ordinal, item.guard_identity_json)) {
      throw codedError("隔离文件缺失，无法恢复源文件", "SHORT_VIDEO_DELETE_QUARANTINE_MISSING");
    }
    if (item.state === "planned" && source && !isOwnedGuard(item.original_path, job, item.ordinal, item.guard_identity_json)) {
      return { mode: "already_source", identity: captureManagedFileIdentity(item.original_path, item.managed_root, source) };
    }
    if (item.state === "restoring" && source && persistedQuarantine) {
      const restored = requireManagedFileIdentity(
        item.original_path,
        item.managed_root,
        persistedQuarantine,
        "恢复后的源文件身份不一致",
        { rollbackAfterRename: true }
      );
      return { mode: "already_source", identity: restored };
    }
    const restored = requireManagedFileIdentity(item.original_path, item.managed_root, sourceExpected, "源文件和隔离文件均不符合持久计划");
    return { mode: "already_source", identity: restored };
  }

  function assertRestoreCandidateCheap(job, item, candidate) {
    if (candidate.mode === "restore") {
      assertCheapManagedFileIdentity(item.quarantine_path, item.managed_root, candidate.identity, "隔离文件已被替换");
      const source = lstatIfPresent(item.original_path);
      if (source) {
        if (candidate.incompleteExclusiveGuard) {
          assertOwnedIncompleteExclusiveGuard(job, item, candidate.incompleteExclusiveGuard);
        } else if (!isOwnedGuard(item.original_path, job, item.ordinal, item.guard_identity_json)) {
          throw codedError("原文件位置已被其他文件占用", "SHORT_VIDEO_DELETE_GUARD_REPLACED");
        }
      }
      return;
    }
    assertCheapManagedFileIdentity(item.original_path, item.managed_root, candidate.identity, "恢复后的源文件身份不一致");
  }

  async function restoreIsolatedItem(db, job, item, candidate) {
    if (candidate.mode === "restore") {
      if (candidate.incompleteExclusiveGuard) {
        removeOwnedIncompleteExclusiveGuard(db, job, item, candidate.incompleteExclusiveGuard);
      } else if (candidate.guardOwned) moveOwnedGuardAside(db, item.original_path, job, item);
      else removeOwnedGuardTemp(db, job, item);
      assertPathMissing(item.original_path, "原文件位置已被其他文件占用");
      await invokeHook(hooks.beforeItemRestored, { jobId: job.id, ordinal: item.ordinal });
      const restored = await publishManagedFileNoReplaceAndCaptureSource(
        db,
        job,
        item,
        "restore-media",
        item.quarantine_path,
        item.original_path,
        candidate.identity
      );
      await invokeHook(hooks.afterRestoreRenamed, { jobId: job.id, ordinal: item.ordinal });
      removeOwnedGuardTemp(db, job, item);
      return restored;
    }
    removeOwnedGuardTemp(db, job, item);
    return candidate.identity;
  }

  function quarantineIdentity(item) {
    const expected = parseJson(item?.quarantine_identity_json, null);
    if (!expected) {
      throw codedError("隔离文件身份检查点缺失", "SHORT_VIDEO_DELETE_QUARANTINE_IDENTITY_MISSING");
    }
    return expected;
  }

  async function assertItemReadyForCommit(item, job) {
    if (["skipped", "alias", "retained"].includes(item.disposition)) return null;
    if (item.disposition === "missing") {
      assertPathMissing(item.original_path, "删除计划中的缺失路径已被占用");
      return null;
    }
    if (item.state !== "isolated") throw codedError("仍有文件未完成隔离", "SHORT_VIDEO_DELETE_NOT_ISOLATED");
    const expected = quarantineIdentity(item);
    const current = requireManagedFileIdentity(
      item.quarantine_path,
      item.managed_root,
      expected,
      "隔离文件已被替换",
      { compareChangeTime: true }
    );
    if (!isOwnedGuard(item.original_path, job, item.ordinal, item.guard_identity_json)) {
      throw codedError("源文件 guard 已被替换", "SHORT_VIDEO_DELETE_GUARD_REPLACED");
    }
    return current;
  }

  async function createGuard(db, originalPath, root, expectedSource, job, ordinal, jobDir) {
    const content = guardContent(job, ordinal);
    const tempPath = guardTempPath(jobDir, job, ordinal);
    assertPathMissing(tempPath, "guard 临时路径已被占用");
    let handle = null;
    try {
      handle = fsOps.openSync(tempPath, "wx", 0o600);
      fsOps.writeFileSync(handle, content, "utf8");
      fsOps.fsyncSync(handle);
    } finally {
      if (handle !== null) fsOps.closeSync(handle);
    }
    if (fsOps.readFileSync(tempPath, "utf8") !== content) {
      throw codedError("guard 临时文件内容不完整", "SHORT_VIDEO_DELETE_GUARD_INCOMPLETE");
    }
    assertGuardDestination(originalPath, root, expectedSource);
    checkpointGuardPublishMode(db, job.id, ordinal, "", GUARD_PUBLISH_HARDLINK);
    await invokeHook(hooks.beforeGuardPublish, { jobId: job.id, ordinal, originalPath });
    let publishMode = GUARD_PUBLISH_HARDLINK;
    try {
      fsOps.linkSync(tempPath, originalPath);
    } catch (error) {
      if (!guardExclusiveFallbackAllowed(error)) {
        throw codedError("guard 目标已被占用或无法原子发布", "SHORT_VIDEO_DELETE_GUARD_NO_CLOBBER", error?.message);
      }
      assertPathMissing(originalPath, "guard hardlink 发布结果不明确");
      checkpointGuardPublishMode(
        db,
        job.id,
        ordinal,
        GUARD_PUBLISH_HARDLINK,
        GUARD_PUBLISH_EXCLUSIVE_CREATE
      );
      publishMode = GUARD_PUBLISH_EXCLUSIVE_CREATE;
      let destinationHandle = null;
      try {
        destinationHandle = fsOps.openSync(originalPath, "wx", 0o600);
        const publicationIdentity = captureIdentity(fsOps.fstatSync(destinationHandle, { bigint: true }));
        if (String(publicationIdentity.size) !== "0"
          || String(publicationIdentity.nlink) !== "1"
          || String(publicationIdentity.dev) !== String(expectedSource.dev)) {
          throw codedError("exclusive guard 初始身份无效", "SHORT_VIDEO_DELETE_GUARD_PUBLISH_IDENTITY_INVALID");
        }
        await invokeHook(hooks.afterExclusiveGuardOpen, { jobId: job.id, ordinal, originalPath });
        checkpointExclusiveGuardPublishIdentity(db, job.id, ordinal, publicationIdentity);
        fsOps.writeFileSync(destinationHandle, content, "utf8");
        fsOps.fsyncSync(destinationHandle);
      } catch (fallbackError) {
        throw codedError("guard 无法以 exclusive create 发布", "SHORT_VIDEO_DELETE_GUARD_NO_CLOBBER", fallbackError?.message);
      } finally {
        if (destinationHandle !== null) fsOps.closeSync(destinationHandle);
      }
    }
    const guardIdentity = capturePlainFileIdentity(originalPath);
    if (fsOps.readFileSync(originalPath, "utf8") !== content) {
      throw codedError("guard 原子发布后身份不一致", "SHORT_VIDEO_DELETE_GUARD_REPLACED");
    }
    checkpointPublishedGuard(db, job.id, ordinal, publishMode, guardIdentity);
    try {
      const item = readItem(db, job.id, ordinal);
      const preparedProof = captureOwnedGuardCapability(tempPath, job, ordinal, "");
      if (!item || !preparedProof) {
        throw codedError("guard 临时文件清理证据缺失", "SHORT_VIDEO_DELETE_GUARD_TEMP_REPLACED");
      }
      removeProvenGuardThroughPrivateCandidate(
        db,
        job,
        item,
        tempPath,
        preparedProof,
        "prepared-publish",
        publishMode === GUARD_PUBLISH_HARDLINK ? originalPath : ""
      );
    } catch (error) {
      if (String(error?.code || "") === "SHORT_VIDEO_DELETE_FS_ACTION_UNBOUND") throw error;
      throw codedError("guard 临时文件清理失败", "SHORT_VIDEO_DELETE_GUARD_TEMP_CLEANUP", error?.message);
    }
    return guardIdentity;
  }

  function guardExclusiveFallbackAllowed(error) {
    return ["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(String(error?.code || "").toUpperCase());
  }

  function removeOwnedGuardTemp(db, job, item) {
    if (!item.quarantine_path || !item.managed_root) return;
    const jobDir = path.dirname(item.quarantine_path);
    const tempPath = guardTempPath(jobDir, job, item.ordinal);
    const entry = lstatIfPresent(tempPath);
    if (!entry) return;
    requireOwnedJobDirectory(job, jobDir, item.managed_root);
    const expected = parseJson(item.source_identity_json, null);
    const proof = captureOwnedPreparedGuardCapability(tempPath, job, item.ordinal);
    if (!expected || !proof || String(proof.dev) !== String(expected.dev)) {
      throw codedError("guard 临时文件不在源文件卷", "SHORT_VIDEO_DELETE_GUARD_TEMP_REPLACED");
    }
    const publishedEntry = lstatIfPresent(item.original_path);
    const retainedPath = publishedEntry
      && String(publishedEntry.dev) === String(proof.dev)
      && String(publishedEntry.ino) === String(proof.ino)
        ? item.original_path
        : "";
    removeProvenGuardThroughPrivateCandidate(db, job, item, tempPath, proof, "prepared", retainedPath);
  }

  function moveOwnedGuardAside(db, originalPath, job, item) {
    const initialPublishedProof = captureOwnedGuardCapability(
      originalPath,
      job,
      item.ordinal,
      item.guard_identity_json
    );
    if (!initialPublishedProof) {
      throw codedError("原文件位置已被其他文件占用", "SHORT_VIDEO_DELETE_GUARD_REPLACED");
    }
    const jobDir = path.dirname(item.quarantine_path);
    requireOwnedJobDirectory(job, jobDir, item.managed_root);
    const tempPath = guardTempPath(jobDir, job, item.ordinal);
    const prepared = lstatIfPresent(tempPath);
    if (!prepared) {
      removeProvenGuardThroughPrivateCandidate(db, job, item, originalPath, initialPublishedProof, "published");
      return;
    }
    if (!isOwnedGuard(tempPath, job, item.ordinal, "")) {
      throw codedError("guard 临时路径已被替换", "SHORT_VIDEO_DELETE_GUARD_TEMP_REPLACED");
    }
    requireOwnedJobDirectory(job, jobDir, item.managed_root);
    const expectedSource = parseJson(item.source_identity_json, null);
    assertGuardDestination(originalPath, item.managed_root, expectedSource);
    const published = capturePlainFileIdentity(originalPath);
    const preparedIdentity = capturePlainFileIdentity(tempPath);
    if (!expectedSource
      || String(published.dev) !== String(expectedSource.dev)
      || String(preparedIdentity.dev) !== String(expectedSource.dev)) {
      throw codedError("guard 发布文件不在源文件卷", "SHORT_VIDEO_DELETE_GUARD_TEMP_REPLACED");
    }
    const sameInode = String(published.dev) === String(preparedIdentity.dev)
      && String(published.ino) === String(preparedIdentity.ino);
    const publishMode = persistedOrRecoveredGuardPublishMode(db, job, item, {
      published,
      prepared: preparedIdentity,
      sameInode
    });
    if (publishMode === GUARD_PUBLISH_HARDLINK && !sameInode) {
      throw codedError("guard 临时路径不是已发布 guard 的同一硬链接", "SHORT_VIDEO_DELETE_GUARD_TEMP_REPLACED");
    }
    if (publishMode === GUARD_PUBLISH_EXCLUSIVE_CREATE && sameInode) {
      throw codedError("exclusive-create guard 意外共享 inode", "SHORT_VIDEO_DELETE_GUARD_TEMP_REPLACED");
    }
    // The persisted publication intent and both exact owned guard values prove
    // whether the source name is the prepared hardlink or an independently
    // created no-clobber guard. Removing only that owned source name leaves the
    // prepared checkpoint available until the media rename has completed.
    removeProvenGuardThroughPrivateCandidate(
      db,
      job,
      item,
      originalPath,
      published,
      "published",
      publishMode === GUARD_PUBLISH_HARDLINK ? tempPath : ""
    );
  }

  function checkpointGuardPublishMode(db, jobId, ordinal, expectedMode, nextMode) {
    if (!GUARD_PUBLISH_MODES.has(nextMode)) {
      throw codedError("guard 发布模式无效", "SHORT_VIDEO_DELETE_GUARD_MODE_INVALID");
    }
    beginImmediate(db);
    try {
      heartbeat(db, jobId);
      requireOwnedJob(db, jobId);
      const updated = db.prepare(`
        UPDATE short_video_delete_items
        SET guard_publish_mode = ?, updated_at = ?
        WHERE job_id = ? AND ordinal = ? AND state = 'isolating' AND guard_publish_mode = ?
      `).run(nextMode, now(), jobId, ordinal, expectedMode);
      if (Number(updated.changes || 0) !== 1) {
        throw codedError("guard 发布模式 CAS 失败", "SHORT_VIDEO_DELETE_GUARD_MODE_CHANGED");
      }
      relinquishableExecutions.delete(String(jobId || ""));
      db.exec("COMMIT");
    } catch (error) {
      rollback(db);
      throw error;
    }
  }

  function checkpointPublishedGuard(db, jobId, ordinal, publishMode, guardIdentity) {
    beginImmediate(db);
    try {
      heartbeat(db, jobId);
      requireOwnedJob(db, jobId);
      const updated = db.prepare(`
        UPDATE short_video_delete_items
        SET guard_identity_json = ?, updated_at = ?
        WHERE job_id = ? AND ordinal = ? AND state = 'isolating' AND guard_publish_mode = ?
      `).run(JSON.stringify(guardIdentity), now(), jobId, ordinal, publishMode);
      if (Number(updated.changes || 0) !== 1) {
        throw codedError("guard 发布身份 CAS 失败", "SHORT_VIDEO_DELETE_GUARD_MODE_CHANGED");
      }
      db.exec("COMMIT");
    } catch (error) {
      rollback(db);
      throw error;
    }
  }

  function checkpointExclusiveGuardPublishIdentity(db, jobId, ordinal, publicationIdentity) {
    if (String(publicationIdentity?.size || "") !== "0"
      || String(publicationIdentity?.nlink || "") !== "1") {
      throw codedError("exclusive guard 初始身份无效", "SHORT_VIDEO_DELETE_GUARD_PUBLISH_IDENTITY_INVALID");
    }
    const executionToken = requireActiveExecutionToken(jobId);
    beginImmediate(db);
    try {
      heartbeat(db, jobId);
      requireOwnedJob(db, jobId);
      const updated = db.prepare(`
        UPDATE short_video_delete_items
        SET guard_publish_identity_json = ?, updated_at = ?
        WHERE job_id = ? AND ordinal = ? AND state = 'isolating'
          AND guard_publish_mode = 'exclusive_create'
          AND guard_publish_identity_json = ''
          AND EXISTS (
            SELECT 1 FROM short_video_delete_jobs owner
            WHERE owner.id = short_video_delete_items.job_id
              AND owner.owner_id = ? AND owner.execution_token = ?
          )
      `).run(JSON.stringify(publicationIdentity), now(), jobId, ordinal, ownerId, executionToken);
      if (Number(updated.changes || 0) !== 1) {
        throw codedError("exclusive guard 身份 CAS 失败", "SHORT_VIDEO_DELETE_GUARD_PUBLISH_IDENTITY_CHANGED");
      }
      relinquishableExecutions.delete(String(jobId || ""));
      db.exec("COMMIT");
    } catch (error) {
      rollback(db);
      throw error;
    }
  }

  function persistedOrRecoveredGuardPublishMode(db, job, item, observed) {
    const persisted = String(item?.guard_publish_mode || "");
    if (GUARD_PUBLISH_MODES.has(persisted)) return persisted;
    if (persisted || String(item?.guard_publish_provenance || "") !== "legacy_v3") {
      throw codedError("guard 发布模式缺失且无法安全推导", "SHORT_VIDEO_DELETE_GUARD_MODE_MISSING");
    }

    const firstProof = proveLegacyV3GuardPublication(job, item, observed);
    const executionToken = requireActiveExecutionToken(job.id);
    beginImmediate(db);
    try {
      heartbeat(db, job.id);
      requireOwnedJob(db, job.id);
      const updated = db.prepare(`
        UPDATE short_video_delete_items
        SET guard_publish_mode = ?, updated_at = ?
        WHERE job_id = ? AND ordinal = ?
          AND state = 'restoring'
          AND guard_publish_mode = ''
          AND guard_publish_provenance = 'legacy_v3'
          AND EXISTS (
            SELECT 1 FROM short_video_delete_jobs owner
            WHERE owner.id = short_video_delete_items.job_id
              AND owner.owner_id = ? AND owner.execution_token = ?
              AND owner.status IN ('running', 'rollback_pending', 'cleanup_pending')
          )
      `).run(firstProof.mode, now(), job.id, item.ordinal, ownerId, executionToken);
      if (Number(updated.changes || 0) !== 1) {
        throw codedError("v3 guard 发布模式 CAS 失败", "SHORT_VIDEO_DELETE_GUARD_MODE_CHANGED");
      }
      db.exec("COMMIT");
    } catch (error) {
      rollback(db);
      throw error;
    }

    const current = readItem(db, job.id, item.ordinal);
    if (!current || String(current.guard_publish_mode || "") !== firstProof.mode) {
      throw codedError("v3 guard 发布模式持久化后发生变化", "SHORT_VIDEO_DELETE_GUARD_MODE_CHANGED");
    }
    const secondProof = proveLegacyV3GuardPublication(requireOwnedJob(db, job.id), current);
    if (secondProof.mode !== firstProof.mode
      || !matchesExactSnapshot(secondProof.published, firstProof.published)
      || !matchesExactSnapshot(secondProof.prepared, firstProof.prepared)
      || !matchesExactSnapshot(secondProof.quarantine, firstProof.quarantine)) {
      throw codedError("v3 guard 发布证据在持久化期间发生变化", "SHORT_VIDEO_DELETE_GUARD_MODE_CHANGED");
    }
    return firstProof.mode;
  }

  function proveLegacyV3GuardPublication(job, item, observed = null) {
    try {
      if (String(item?.guard_publish_provenance || "") !== "legacy_v3") throw new Error("not legacy v3");
      const expectedSource = parseJson(item.source_identity_json, null);
      if (!expectedSource) throw new Error("source identity missing");
      const jobDir = path.dirname(item.quarantine_path);
      requireOwnedJobDirectory(job, jobDir, item.managed_root);
      assertGuardDestination(item.original_path, item.managed_root, expectedSource);
      const quarantine = requireManagedFileIdentity(
        item.quarantine_path,
        item.managed_root,
        expectedSource,
        "v3 隔离文件身份与源计划不一致",
        { transitionAfterRename: true }
      );
      const prepared = captureOwnedGuardCapability(
        guardTempPath(jobDir, job, item.ordinal),
        job,
        item.ordinal,
        ""
      );
      const published = captureOwnedGuardCapability(
        item.original_path,
        job,
        item.ordinal,
        item.guard_identity_json
      );
      if (!prepared || !published
        || String(quarantine.dev) !== String(expectedSource.dev)
        || String(prepared.dev) !== String(expectedSource.dev)
        || String(published.dev) !== String(expectedSource.dev)) {
        throw new Error("guard or quarantine device mismatch");
      }
      if (observed && (!matchesExactSnapshot(published, observed.published)
        || !matchesExactSnapshot(prepared, observed.prepared))) {
        throw new Error("guard changed before legacy proof");
      }
      const sameInode = String(prepared.dev) === String(published.dev)
        && String(prepared.ino) === String(published.ino);
      let mode = "";
      if (sameInode) mode = GUARD_PUBLISH_HARDLINK;
      else if (String(prepared.nlink) === "1" && String(published.nlink) === "1") {
        mode = GUARD_PUBLISH_EXCLUSIVE_CREATE;
      }
      if (!mode || (observed && Boolean(observed.sameInode) !== sameInode)) {
        throw new Error("guard link relationship is not a v3 publication proof");
      }
      return { mode, published, prepared, quarantine };
    } catch (error) {
      throw codedError(
        "v3 guard 发布来源无法满足安全恢复证明",
        "SHORT_VIDEO_DELETE_GUARD_MODE_MISSING",
        error?.message
      );
    }
  }

  function requireOwnedJobDirectory(job, jobDir, root) {
    ensurePlainDirectory(jobDir, root, false);
    const marker = path.join(jobDir, OWNER_MARKER);
    const markerEntry = lstatIfPresent(marker);
    if (!markerEntry || !markerEntry.isFile() || markerEntry.isSymbolicLink()) {
      throw codedError("隔离目录缺少 ownership marker", "SHORT_VIDEO_DELETE_QUARANTINE_OWNER");
    }
    if (fsOps.readFileSync(marker, "utf8") !== `${job.id}:${job.quarantine_token}`) {
      throw codedError("隔离目录 ownership marker 不匹配", "SHORT_VIDEO_DELETE_QUARANTINE_OWNER");
    }
  }

  function assertGuardDestination(originalPath, root, expectedSource) {
    assertManagedRoot(root);
    const resolved = path.resolve(originalPath);
    if (!isInside(resolved, root) || samePath(resolved, root)) {
      throw codedError("guard 目标不在受管根内", "SHORT_VIDEO_DELETE_PATH_ESCAPE");
    }
    const parent = path.dirname(resolved);
    const parentEntry = fsOps.lstatSync(parent, { bigint: true });
    if (!parentEntry.isDirectory() || parentEntry.isSymbolicLink()) {
      throw codedError("guard 目标父目录已变化", "SHORT_VIDEO_DELETE_PATH_ESCAPE");
    }
    const parentRealPathKey = pathKey(realpath(parent));
    if (!expectedSource || parentRealPathKey !== expectedSource.parentRealPathKey) {
      throw codedError("guard 目标父目录已变化", "SHORT_VIDEO_DELETE_PATH_ESCAPE");
    }
  }

  function removeOwnedGuard(db, job, item) {
    const originalPath = item.original_path;
    const entry = lstatIfPresent(originalPath);
    if (!entry) return;
    const proof = captureOwnedGuardCapability(
      originalPath,
      job,
      item.ordinal,
      item.guard_identity_json
    );
    if (!proof) {
      throw codedError("原文件位置已被其他文件占用", "SHORT_VIDEO_DELETE_GUARD_REPLACED");
    }
    removeProvenGuardThroughPrivateCandidate(db, job, item, originalPath, proof, "published-cleanup");
  }

  function isOwnedGuard(originalPath, job, ordinal, storedIdentityJson) {
    const entry = lstatIfPresent(originalPath);
    if (!entry || !entry.isFile() || entry.isSymbolicLink()) return false;
    const expectedIdentity = parseJson(storedIdentityJson, null);
    if (expectedIdentity && !identityMatches(captureIdentity(entry), expectedIdentity)) return false;
    if (Number(entry.size) > 1024) return false;
    try {
      return fsOps.readFileSync(originalPath, "utf8") === guardContent(job, ordinal);
    } catch {
      return false;
    }
  }

  function guardContent(job, ordinal) {
    return `${GUARD_PREFIX}:${job.id}:${job.quarantine_token}:${ordinal}`;
  }

  function ensureOwnedJobDirectory(job, root, sourceDevice) {
    assertManagedRoot(root);
    const base = path.join(root, SHORT_VIDEO_DELETE_QUARANTINE_DIR);
    ensurePlainDirectory(base, root);
    const jobDir = path.join(base, `${job.id}-${job.quarantine_token.slice(0, 16)}`);
    ensurePlainDirectory(jobDir, root);
    const jobEntry = fsOps.lstatSync(jobDir, { bigint: true });
    if (String(jobEntry.dev) !== String(sourceDevice)) {
      throw codedError("隔离目录与源文件不在同一卷", "SHORT_VIDEO_DELETE_CROSS_VOLUME");
    }
    const marker = path.join(jobDir, OWNER_MARKER);
    const content = `${job.id}:${job.quarantine_token}`;
    const markerEntry = lstatIfPresent(marker);
    if (!markerEntry) {
      const entries = fsOps.readdirSync(jobDir);
      if (entries.length) throw codedError("隔离目录缺少 ownership marker", "SHORT_VIDEO_DELETE_QUARANTINE_OWNER");
      fsOps.writeFileSync(marker, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } else if (!markerEntry.isFile() || markerEntry.isSymbolicLink() || fsOps.readFileSync(marker, "utf8") !== content) {
      throw codedError("隔离目录 ownership marker 不匹配", "SHORT_VIDEO_DELETE_QUARANTINE_OWNER");
    }
    return jobDir;
  }

  function finalizeOwnedDirectories(db, job, items) {
    reconcileFsActions(db, job);
    const directories = [...new Set(items
      .filter((item) => item.managed_root && item.quarantine_path)
      .map((item) => path.dirname(item.quarantine_path)))];
    for (const jobDir of directories) {
      const root = managedRootFor(jobDir, managedRoots);
      if (!root) throw codedError("隔离目录不在受管根内", "SHORT_VIDEO_DELETE_QUARANTINE_ESCAPE");
      const marker = path.join(jobDir, OWNER_MARKER);
      const entry = lstatIfPresent(jobDir);
      if (!entry) continue;
      ensurePlainDirectory(jobDir, root, false);
      if (lstatIfPresent(marker)) {
        const markerContent = `${job.id}:${job.quarantine_token}`;
        const markerProof = captureExactSmallFileCapability(marker, markerContent);
        if (!markerProof) {
          throw codedError("隔离目录 ownership marker 不匹配", "SHORT_VIDEO_DELETE_QUARANTINE_OWNER");
        }
        const item = items.find((candidate) => path.dirname(candidate.quarantine_path || "") === jobDir);
        if (!item) throw codedError("隔离目录缺少文件动作 owner", "SHORT_VIDEO_DELETE_FS_ACTION_CHANGED");
        const action = beginFsAction(
          db,
          job,
          item,
          `owner-marker-finalize-${item.ordinal}`,
          marker,
          "",
          markerProof
        );
        capturePathIntoEvidence(
          db,
          job,
          item,
          action,
          (candidatePath) => captureExactSmallFileCapability(candidatePath, markerContent),
          { neutralize: true }
        );
        reconcileFsActions(db, job);
      }
      const remaining = fsOps.readdirSync(jobDir);
      if (remaining.length) {
        throw codedError(
          `隔离目录仍有未收敛 evidence: ${jobDir}`,
          "SHORT_VIDEO_DELETE_FS_ACTION_UNBOUND"
        );
      }
      fsOps.rmdirSync(jobDir);
      const base = path.dirname(jobDir);
      try {
        fsOps.rmdirSync(base);
      } catch (error) {
        if (!isMissing(error) && !isNonEmpty(error)) throw error;
      }
    }
  }

  function ensurePlainDirectory(directoryPath, root, create = true) {
    let entry = lstatIfPresent(directoryPath);
    if (!entry && create) {
      try {
        fsOps.mkdirSync(directoryPath, { mode: 0o700 });
      } catch (error) {
        if (String(error?.code || "").toUpperCase() !== "EEXIST") throw error;
      }
      entry = lstatIfPresent(directoryPath);
    }
    if (!entry || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw codedError("隔离目录不是受管普通目录", "SHORT_VIDEO_DELETE_QUARANTINE_OWNER");
    }
    const rootReal = realpath(root);
    const directoryReal = realpath(directoryPath);
    if (!isInside(directoryReal, rootReal) || samePath(directoryReal, rootReal)) {
      throw codedError("隔离目录通过链接逃逸受管根", "SHORT_VIDEO_DELETE_QUARANTINE_ESCAPE");
    }
    if (process.platform !== "win32" && (Number(entry.mode) & 0o777) !== 0o700) {
      try {
        fsOps.chmodSync(directoryPath, 0o700);
      } catch (error) {
        throw codedError("隔离目录权限不安全", "SHORT_VIDEO_DELETE_QUARANTINE_PERMISSIONS", error?.message);
      }
    }
    return entry;
  }

  function captureManagedFileIdentity(filePath, root, entry = null) {
    assertManagedRoot(root);
    const lexical = path.resolve(filePath);
    if (!isInside(lexical, root) || samePath(lexical, root)) {
      throw codedError("文件路径不在受管根内", "SHORT_VIDEO_DELETE_PATH_ESCAPE");
    }
    const lexicalEntry = entry || fsOps.lstatSync(filePath, { bigint: true });
    if (!lexicalEntry.isFile() || lexicalEntry.isSymbolicLink()) {
      throw codedError("删除目标不是普通文件", "SHORT_VIDEO_DELETE_NOT_FILE");
    }
    const before = captureIdentity(lexicalEntry);
    const rootReal = realpath(root);
    const fileReal = realpath(filePath);
    if (!isInside(fileReal, rootReal) || samePath(fileReal, rootReal)) {
      throw codedError("文件通过链接逃逸受管根", "SHORT_VIDEO_DELETE_PATH_ESCAPE");
    }
    const after = captureIdentity(fsOps.lstatSync(filePath, { bigint: true }));
    if (!matchesCheapIdentity(after, before)) {
      throw codedError("文件路径在身份采集期间发生变化", "SHORT_VIDEO_DELETE_FILE_REPLACED");
    }
    return {
      ...after,
      realPathKey: pathKey(fileReal),
      parentRealPathKey: pathKey(realpath(path.dirname(filePath))),
      rootRealPathKey: pathKey(rootReal),
      aliasRisk: pathHasAliasRisk(filePath, root, fileReal, rootReal)
    };
  }

  function assertCheapManagedFileIdentity(filePath, root, expected, message) {
    assertManagedRoot(root);
    const lexical = path.resolve(filePath);
    if (!isInside(lexical, root) || samePath(lexical, root)) {
      throw codedError("文件路径不在受管根内", "SHORT_VIDEO_DELETE_PATH_ESCAPE");
    }
    const entry = fsOps.lstatSync(filePath, { bigint: true });
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw codedError(message, "SHORT_VIDEO_DELETE_FILE_REPLACED");
    }
    const current = captureIdentity(entry);
    const rootReal = realpath(root);
    const fileReal = realpath(filePath);
    if (!isInside(fileReal, rootReal) || samePath(fileReal, rootReal)) {
      throw codedError("文件通过链接逃逸受管根", "SHORT_VIDEO_DELETE_PATH_ESCAPE");
    }
    current.realPathKey = pathKey(fileReal);
    current.parentRealPathKey = pathKey(realpath(path.dirname(filePath)));
    current.rootRealPathKey = pathKey(rootReal);
    current.aliasRisk = pathHasAliasRisk(filePath, root, fileReal, rootReal);
    if (!expected || !matchesCheapIdentity(current, expected)) {
      throw codedError(message, "SHORT_VIDEO_DELETE_FILE_REPLACED");
    }
    for (const key of ["realPathKey", "parentRealPathKey", "rootRealPathKey"]) {
      if (expected[key] && String(current[key] || "") !== String(expected[key])) {
        throw codedError(message, "SHORT_VIDEO_DELETE_FILE_REPLACED");
      }
    }
    if (Object.prototype.hasOwnProperty.call(expected, "aliasRisk")
      && Boolean(current.aliasRisk) !== Boolean(expected.aliasRisk)) {
      throw codedError(message, "SHORT_VIDEO_DELETE_FILE_REPLACED");
    }
    return current;
  }

  function requireManagedFileIdentity(filePath, root, expected, message, options = {}) {
    const current = captureManagedFileIdentity(filePath, root);
    const matches = options.rollbackAfterRename
      ? matchesRollbackRenameTransition(current, expected)
      : options.transitionAfterRename
        ? matchesRenameTransition(current, expected)
      : options.rollbackOwnedQuarantine
        ? matchesRollbackQuarantine(current, expected)
        : matchesExactSnapshot(current, expected);
    if (
      !expected
      || !matches
    ) {
      throw codedError(message, "SHORT_VIDEO_DELETE_FILE_REPLACED");
    }
    return current;
  }

  function capturePlainFileIdentity(filePath) {
    const entry = fsOps.lstatSync(filePath, { bigint: true });
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw codedError("guard 不是普通文件", "SHORT_VIDEO_DELETE_GUARD_REPLACED");
    }
    return captureIdentity(entry);
  }

  function captureOwnedGuardCapability(filePath, job, ordinal, storedIdentityJson) {
    const lexicalEntry = fsOps.lstatSync(filePath, { bigint: true });
    if (!lexicalEntry.isFile() || lexicalEntry.isSymbolicLink() || Number(lexicalEntry.size) > 1024) return null;
    const handle = fsOps.openSync(filePath, "r");
    let before;
    let after;
    let content;
    try {
      before = captureIdentity(fsOps.fstatSync(handle, { bigint: true }));
      if (!matchesCheapIdentity(before, captureIdentity(lexicalEntry))) return null;
      content = fsOps.readFileSync(handle, "utf8");
      after = captureIdentity(fsOps.fstatSync(handle, { bigint: true }));
    } finally {
      fsOps.closeSync(handle);
    }
    if (!matchesExactSnapshot(after, before) || content !== guardContent(job, ordinal)) return null;
    const finalIdentity = captureIdentity(fsOps.lstatSync(filePath, { bigint: true }));
    if (!matchesCheapIdentity(finalIdentity, after)) return null;
    const expected = parseJson(storedIdentityJson, null);
    if (expected && !identityMatches(after, expected)) return null;
    return after;
  }

  function captureOwnedPreparedGuardCapability(filePath, job, ordinal) {
    const lexicalEntry = fsOps.lstatSync(filePath, { bigint: true });
    const expectedContent = guardContent(job, ordinal);
    if (!lexicalEntry.isFile()
      || lexicalEntry.isSymbolicLink()
      || Number(lexicalEntry.size) > Buffer.byteLength(expectedContent)) return null;
    const handle = fsOps.openSync(filePath, "r");
    let before;
    let after;
    let content;
    try {
      before = captureIdentity(fsOps.fstatSync(handle, { bigint: true }));
      if (!matchesCheapIdentity(before, captureIdentity(lexicalEntry))) return null;
      content = fsOps.readFileSync(handle, "utf8");
      after = captureIdentity(fsOps.fstatSync(handle, { bigint: true }));
    } finally {
      fsOps.closeSync(handle);
    }
    if (!matchesExactSnapshot(after, before) || !expectedContent.startsWith(content)) return null;
    const finalIdentity = captureIdentity(fsOps.lstatSync(filePath, { bigint: true }));
    return matchesCheapIdentity(finalIdentity, after) ? after : null;
  }

  function captureExactSmallFileCapability(filePath, expectedContent) {
    const lexicalEntry = fsOps.lstatSync(filePath, { bigint: true });
    if (!lexicalEntry.isFile() || lexicalEntry.isSymbolicLink() || Number(lexicalEntry.size) > 4096) return null;
    const handle = fsOps.openSync(filePath, "r");
    let before;
    let after;
    let content;
    try {
      before = captureIdentity(fsOps.fstatSync(handle, { bigint: true }));
      if (!matchesCheapIdentity(before, captureIdentity(lexicalEntry))) return null;
      content = fsOps.readFileSync(handle, "utf8");
      after = captureIdentity(fsOps.fstatSync(handle, { bigint: true }));
    } finally {
      fsOps.closeSync(handle);
    }
    if (!matchesExactSnapshot(after, before) || content !== expectedContent) return null;
    const finalIdentity = captureIdentity(fsOps.lstatSync(filePath, { bigint: true }));
    return matchesCheapIdentity(finalIdentity, after) ? after : null;
  }

  function actionObjectMatches(actual, expected) {
    if (!actual || !expected) return false;
    return String(actual.dev || "") === String(expected.dev || "")
      && String(actual.ino || "") === String(expected.ino || "")
      && String(actual.size || "") === String(expected.size || "")
      && String(actual.birthtimeNs || "") === String(expected.birthtimeNs || "")
      && String(actual.mtimeNs || "") === String(expected.mtimeNs || "");
  }

  function actionInodeMatches(actual, expected) {
    return String(actual?.dev || "") === String(expected?.dev || "")
      && String(actual?.ino || "") === String(expected?.ino || "")
      && String(actual?.birthtimeNs || "") === String(expected?.birthtimeNs || "");
  }

  function beginFsAction(db, job, item, kind, sourcePath, targetPath, expectedIdentity) {
    const ordinal = Number(item?.ordinal ?? -1);
    const actionKey = `${ordinal}:${kind}`;
    const existing = db.prepare(`
      SELECT * FROM ${FS_ACTION_TABLE} WHERE job_id = ? AND action_key = ?
    `).get(job.id, actionKey) || null;
    if (existing) {
      if (existing.kind !== kind
        || path.resolve(existing.source_path) !== path.resolve(sourcePath)
        || String(existing.target_path || "") !== String(targetPath || "")
        || !actionObjectMatches(parseJson(existing.expected_identity_json, null), expectedIdentity)) {
        throw codedError("文件动作 journal 与当前计划不一致", "SHORT_VIDEO_DELETE_FS_ACTION_CHANGED");
      }
      if (existing.stage === "manual") {
        throw codedError(
          `文件动作需要人工处理；保留证据: ${existing.evidence_path}`,
          "SHORT_VIDEO_DELETE_FS_ACTION_UNBOUND"
        );
      }
      return existing;
    }
    const jobDir = path.dirname(item.quarantine_path);
    requireOwnedJobDirectory(job, jobDir, item.managed_root);
    const actionId = crypto.randomBytes(24).toString("hex");
    const evidenceDir = path.join(jobDir, `.evidence-${actionId}`);
    const evidencePath = path.join(evidenceDir, "captured");
    beginImmediate(db);
    try {
      heartbeat(db, job.id);
      requireOwnedJob(db, job.id);
      db.prepare(`
        INSERT INTO ${FS_ACTION_TABLE} (
          job_id, action_key, ordinal, kind, source_path, target_path,
          evidence_dir, evidence_path, expected_identity_json,
          observed_identity_json, stage, error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'intent', '', ?, ?)
      `).run(
        job.id,
        actionKey,
        ordinal,
        kind,
        path.resolve(sourcePath),
        targetPath ? path.resolve(targetPath) : "",
        evidenceDir,
        evidencePath,
        JSON.stringify(expectedIdentity),
        now(),
        now()
      );
      db.exec("COMMIT");
    } catch (error) {
      rollback(db);
      throw error;
    }
    return db.prepare(`SELECT * FROM ${FS_ACTION_TABLE} WHERE job_id = ? AND action_key = ?`)
      .get(job.id, actionKey);
  }

  function updateFsAction(db, job, action, stage, observedIdentity = null, errorMessage = "") {
    const executionToken = requireActiveExecutionToken(job.id);
    beginImmediate(db);
    try {
      heartbeat(db, job.id);
      requireOwnedJob(db, job.id);
      const updated = db.prepare(`
        UPDATE ${FS_ACTION_TABLE}
        SET stage = ?, observed_identity_json = ?, error = ?, updated_at = ?
        WHERE job_id = ? AND action_key = ?
          AND EXISTS (
            SELECT 1 FROM short_video_delete_jobs owner
            WHERE owner.id = ${FS_ACTION_TABLE}.job_id
              AND owner.owner_id = ? AND owner.execution_token = ?
          )
      `).run(
        stage,
        observedIdentity ? JSON.stringify(observedIdentity) : String(action.observed_identity_json || ""),
        String(errorMessage || "").slice(0, 2000),
        now(),
        job.id,
        action.action_key,
        ownerId,
        executionToken
      );
      if (Number(updated.changes || 0) !== 1) {
        throw codedError("文件动作状态 CAS 失败", "SHORT_VIDEO_DELETE_LEASE_LOST");
      }
      db.exec("COMMIT");
    } catch (error) {
      rollback(db);
      throw error;
    }
    return db.prepare(`SELECT * FROM ${FS_ACTION_TABLE} WHERE job_id = ? AND action_key = ?`)
      .get(job.id, action.action_key);
  }

  function failFsAction(db, job, action, reason) {
    const message = `${reason}; foreign/evidence retained at ${action.evidence_path}`;
    try {
      updateFsAction(db, job, action, "manual", null, message);
    } catch {}
    throw codedError(message, "SHORT_VIDEO_DELETE_FS_ACTION_UNBOUND");
  }

  function ensureFsActionEvidenceDirectory(action, item) {
    const jobDir = path.dirname(item.quarantine_path);
    if (path.dirname(action.evidence_dir) !== jobDir
      || path.dirname(action.evidence_path) !== action.evidence_dir) {
      throw codedError("文件动作 evidence 路径逃逸", "SHORT_VIDEO_DELETE_FS_ACTION_CHANGED");
    }
    const existing = lstatIfPresent(action.evidence_dir);
    if (!existing) {
      try {
        fsOps.mkdirSync(action.evidence_dir, { mode: 0o700 });
      } catch (error) {
        if (String(error?.code || "").toUpperCase() !== "EEXIST") throw error;
      }
    }
    ensurePlainDirectory(action.evidence_dir, item.managed_root, false);
  }

  function capturePathIntoEvidence(db, job, item, action, captureCandidate, options = {}) {
    ensureFsActionEvidenceDirectory(action, item);
    let evidenceEntry = lstatIfPresent(action.evidence_path);
    const sourceEntry = lstatIfPresent(action.source_path);
    if (!evidenceEntry) {
      if (!sourceEntry) return failFsAction(db, job, action, "source and evidence are both missing");
      fsOps.renameSync(action.source_path, action.evidence_path);
      hooks.afterFsActionSystemCall?.({
        jobId: job.id,
        ordinal: Number(action.ordinal),
        kind: action.kind,
        boundary: "captured"
      });
      evidenceEntry = lstatIfPresent(action.evidence_path);
    }
    if (["captured", "neutralized"].includes(action.stage)) {
      if (lstatIfPresent(action.source_path)) {
        return failFsAction(db, job, action, "source name was repopulated after atomic capture");
      }
      const persistedObserved = parseJson(action.observed_identity_json, null);
      const handle = fsOps.openSync(action.evidence_path, options.neutralize ? "r+" : "r");
      try {
        const bound = captureIdentity(fsOps.fstatSync(handle, { bigint: true }));
        if (!persistedObserved || !actionInodeMatches(bound, persistedObserved)) {
          return failFsAction(db, job, action, "evidence name no longer resolves to the captured inode");
        }
        if (action.stage === "neutralized") {
          if (String(bound.size || "") !== "0") {
            return failFsAction(db, job, action, "neutralized evidence was repopulated");
          }
          return { action, observed: bound };
        }
        if (!options.neutralize) return { action, observed: bound };
        if (String(bound.nlink || "") !== "1") {
          return failFsAction(db, job, action, "refusing handle truncation while evidence inode has other links");
        }
        fsOps.ftruncateSync(handle, 0);
        fsOps.fsyncSync(handle);
        hooks.afterFsActionSystemCall?.({
          jobId: job.id,
          ordinal: Number(action.ordinal),
          kind: action.kind,
          boundary: "neutralized"
        });
        const neutralized = captureIdentity(fsOps.fstatSync(handle, { bigint: true }));
        action = updateFsAction(db, job, action, "neutralized", neutralized);
        hooks.afterFsActionNeutralized?.({
          jobId: job.id,
          ordinal: Number(action.ordinal),
          kind: action.kind
        });
        return { action, observed: neutralized };
      } finally {
        fsOps.closeSync(handle);
      }
    }
    let observed = null;
    try {
      observed = captureCandidate(action.evidence_path);
    } catch {}
    const expected = parseJson(action.expected_identity_json, null);
    if (!observed || !actionObjectMatches(observed, expected)) {
      return failFsAction(db, job, action, "atomic capture moved an unproven object");
    }
    if (lstatIfPresent(action.source_path)) {
      return failFsAction(db, job, action, "source name was repopulated during atomic capture");
    }
    if (action.stage === "intent") action = updateFsAction(db, job, action, "captured", observed);
    if (!options.neutralize) return { action, observed };
    if (action.stage === "neutralized") return { action, observed };

    const handle = fsOps.openSync(action.evidence_path, "r+");
    try {
      const bound = captureIdentity(fsOps.fstatSync(handle, { bigint: true }));
      const persistedObserved = parseJson(action.observed_identity_json, observed);
      if (!actionInodeMatches(bound, persistedObserved)) {
        return failFsAction(db, job, action, "evidence name no longer resolves to the captured inode");
      }
      if (String(bound.nlink || "") !== "1") {
        return failFsAction(db, job, action, "refusing handle truncation while evidence inode has other links");
      }
      fsOps.ftruncateSync(handle, 0);
      fsOps.fsyncSync(handle);
      hooks.afterFsActionSystemCall?.({
        jobId: job.id,
        ordinal: Number(action.ordinal),
        kind: action.kind,
        boundary: "neutralized"
      });
      const neutralized = captureIdentity(fsOps.fstatSync(handle, { bigint: true }));
      action = updateFsAction(db, job, action, "neutralized", neutralized);
      hooks.afterFsActionNeutralized?.({
        jobId: job.id,
        ordinal: Number(action.ordinal),
        kind: action.kind
      });
      return { action, observed: neutralized };
    } finally {
      fsOps.closeSync(handle);
    }
  }

  async function publishManagedFileNoReplaceAndCaptureSource(
    db,
    job,
    item,
    kind,
    sourcePath,
    targetPath,
    expectedIdentity
  ) {
    let action = beginFsAction(db, job, item, kind, sourcePath, targetPath, expectedIdentity);
    const targetEntry = lstatIfPresent(targetPath);
    if (!targetEntry) {
      try {
        fsOps.linkSync(sourcePath, targetPath);
        hooks.afterFsActionSystemCall?.({
          jobId: job.id,
          ordinal: Number(item.ordinal),
          kind,
          boundary: "linked"
        });
      } catch (error) {
        if (kind === "isolate-media") {
          const sourceAfterFailure = captureManagedIdentityIfPresent(sourcePath, item.managed_root);
          if (sourceAfterFailure
            && actionObjectMatches(sourceAfterFailure, expectedIdentity)
            && !lstatIfPresent(targetPath)
            && !lstatIfPresent(action.evidence_path)) {
            action = updateFsAction(
              db,
              job,
              action,
              "cancelled",
              sourceAfterFailure,
              `no-replace link unavailable (${String(error?.code || "unknown")})`
            );
            finalizeReconciledFsAction(db, job, item, action);
            resetCancelledIsolationItem(db, job, item);
            throw codedError(
              "文件系统不支持安全 no-replace 隔离，源文件未改变",
              "SHORT_VIDEO_DELETE_ISOLATE_NO_REPLACE_UNAVAILABLE",
              error?.message
            );
          }
        }
        return failFsAction(
          db,
          job,
          action,
          `atomic no-replace publication failed (${String(error?.code || "unknown")})`
        );
      }
    }
    let targetIdentity = null;
    try {
      targetIdentity = captureManagedFileIdentity(targetPath, item.managed_root);
    } catch {}
    if (!targetIdentity || !actionObjectMatches(targetIdentity, expectedIdentity)) {
      return failFsAction(db, job, action, "no-replace target is not the planned media object");
    }
    const captured = capturePathIntoEvidence(
      db,
      job,
      item,
      action,
      (candidatePath) => captureManagedFileIdentity(candidatePath, item.managed_root),
      { neutralize: false }
    );
    action = captured.action;
    action = releasePrivateEvidenceLink(db, job, item, action, targetPath);
    let finalTarget = null;
    try {
      finalTarget = captureManagedFileIdentity(targetPath, item.managed_root);
    } catch {}
    if (!finalTarget || !actionObjectMatches(finalTarget, expectedIdentity)) {
      return failFsAction(db, job, action, "published media target changed after source capture");
    }
    if (action.stage === "released") finalizeReconciledFsAction(db, job, item, action);
    return finalTarget;
  }

  function resetCancelledIsolationItem(db, job, item) {
    const executionToken = requireActiveExecutionToken(job.id);
    beginImmediate(db);
    try {
      heartbeat(db, job.id);
      requireOwnedJob(db, job.id);
      const updated = db.prepare(`
        UPDATE short_video_delete_items
        SET state = 'planned', error = '', updated_at = ?
        WHERE job_id = ? AND ordinal = ? AND state = 'isolating'
          AND EXISTS (
            SELECT 1 FROM short_video_delete_jobs owner
            WHERE owner.id = short_video_delete_items.job_id
              AND owner.owner_id = ? AND owner.execution_token = ?
          )
      `).run(now(), job.id, item.ordinal, ownerId, executionToken);
      if (Number(updated.changes || 0) !== 1) {
        throw codedError("取消隔离 intent CAS 失败", "SHORT_VIDEO_DELETE_LEASE_LOST");
      }
      db.exec("COMMIT");
    } catch (error) {
      rollback(db);
      throw error;
    }
  }

  function releasePrivateEvidenceLink(db, job, item, action, retainedPath) {
    if (action.stage === "released") return action;
    if (action.stage !== "captured") {
      return failFsAction(db, job, action, "media evidence is not in a releasable captured state");
    }
    ensureFsActionEvidenceDirectory(action, item);
    const retainedEntry = lstatIfPresent(retainedPath);
    if (!retainedEntry) return failFsAction(db, job, action, "retained media name is missing");
    const handle = fsOps.openSync(action.evidence_path, "r");
    try {
      const bound = captureIdentity(fsOps.fstatSync(handle, { bigint: true }));
      const observed = parseJson(action.observed_identity_json, null);
      const retained = captureIdentity(retainedEntry);
      if (!observed
        || !actionInodeMatches(bound, observed)
        || String(bound.dev) !== String(retained.dev)
        || String(bound.ino) !== String(retained.ino)
        || Number(bound.nlink || 0) < 2) {
        return failFsAction(db, job, action, "private media evidence is not linked to the retained target");
      }
      // This is the only regular-file unlink in the protocol. The name is a
      // 192-bit capability inside an atomically-created 0700 directory and is
      // never passed to a hook before this call. Public/managed names never use
      // unlink. Same-user processes that enumerate and mutate private protocol
      // directories are outside the supported threat boundary.
      fs.unlinkSync(action.evidence_path);
      hooks.afterFsActionSystemCall?.({
        jobId: job.id,
        ordinal: Number(action.ordinal),
        kind: action.kind,
        boundary: "released"
      });
      const after = captureIdentity(fsOps.fstatSync(handle, { bigint: true }));
      if (Number(after.nlink || 0) !== Number(bound.nlink || 0) - 1) {
        return failFsAction(db, job, action, "private evidence link count did not decrease exactly once");
      }
      return updateFsAction(db, job, action, "released", after);
    } finally {
      fsOps.closeSync(handle);
    }
  }

  function releaseIsolateMediaEvidence(db, job, item) {
    reconcileFsActions(db, job);
    const action = db.prepare(`
      SELECT * FROM ${FS_ACTION_TABLE}
      WHERE job_id = ? AND action_key = ?
    `).get(job.id, `${Number(item.ordinal)}:isolate-media`) || null;
    if (!action || action.stage === "released") return readItem(db, job.id, item.ordinal) || item;
    if (action.stage === "manual") {
      throw codedError(
        `媒体 evidence 需要人工处理: ${action.evidence_path}`,
        "SHORT_VIDEO_DELETE_FS_ACTION_UNBOUND"
      );
    }
    const retainedPath = item.quarantine_path;
    releasePrivateEvidenceLink(db, job, item, action, retainedPath);
    const expected = parseJson(item.quarantine_identity_json, null)
      || parseJson(item.source_identity_json, null);
    const current = captureManagedFileIdentity(retainedPath, item.managed_root);
    if (!expected || !actionObjectMatches(current, expected)) {
      throw codedError("释放 isolate evidence 后媒体身份不一致", "SHORT_VIDEO_DELETE_FS_ACTION_UNBOUND");
    }
    beginImmediate(db);
    try {
      heartbeat(db, job.id);
      requireOwnedJob(db, job.id);
      const updated = db.prepare(`
        UPDATE short_video_delete_items
        SET quarantine_identity_json = ?, updated_at = ?
        WHERE job_id = ? AND ordinal = ?
          AND EXISTS (
            SELECT 1 FROM short_video_delete_jobs owner
            WHERE owner.id = short_video_delete_items.job_id
              AND owner.owner_id = ? AND owner.execution_token = ?
          )
      `).run(JSON.stringify(current), now(), job.id, item.ordinal, ownerId, requireActiveExecutionToken(job.id));
      if (Number(updated.changes || 0) !== 1) {
        throw codedError("媒体 evidence 释放检查点 CAS 失败", "SHORT_VIDEO_DELETE_LEASE_LOST");
      }
      db.exec("COMMIT");
    } catch (error) {
      rollback(db);
      throw error;
    }
    return readItem(db, job.id, item.ordinal);
  }

  function reconcileFsActions(db, job) {
    const actions = db.prepare(`
      SELECT * FROM ${FS_ACTION_TABLE}
      WHERE job_id = ?
      ORDER BY created_at, action_key
    `).all(job.id);
    for (let action of actions) {
      const item = readItem(db, job.id, action.ordinal);
      if (!item) {
        failFsAction(db, job, action, "filesystem action has no item owner");
      }
      if (action.stage === "manual") {
        action = reconcileReleasedManualMediaAction(db, job, item, action);
      }
      if (action.stage === "manual") {
        throw codedError(
          `文件动作需要人工处理；保留证据: ${action.evidence_path}`,
          "SHORT_VIDEO_DELETE_FS_ACTION_UNBOUND"
        );
      }
      if (["isolate-media", "restore-media"].includes(action.kind)) {
        action = reconcileMediaFsAction(db, job, item, action);
      } else {
        action = reconcileRemovalFsAction(db, job, item, action);
      }
      if (["neutralized", "released", "cancelled"].includes(action.stage)) {
        finalizeReconciledFsAction(db, job, item, action);
      }
    }
  }

  function reconcileReleasedManualMediaAction(db, job, item, action) {
    if (!["isolate-media", "restore-media"].includes(String(action.kind || ""))
      || !String(action.error || "").startsWith("published media target changed after source capture")
      || lstatIfPresent(action.source_path)
      || lstatIfPresent(action.evidence_path)) {
      return action;
    }
    const expected = parseJson(action.expected_identity_json, null);
    const target = captureManagedIdentityIfPresent(action.target_path, item.managed_root);
    if (!expected || !target || !actionObjectMatches(target, expected)) return action;
    return updateFsAction(
      db,
      job,
      action,
      "released",
      target,
      "自动确认已发布目标仍是原计划文件"
    );
  }

  function reconcileMediaFsAction(db, job, item, action) {
    const expected = parseJson(action.expected_identity_json, null);
    const sourcePresent = Boolean(lstatIfPresent(action.source_path));
    const targetPresent = Boolean(lstatIfPresent(action.target_path));
    const evidencePresent = Boolean(lstatIfPresent(action.evidence_path));
    const source = captureManagedIdentityIfPresent(action.source_path, item.managed_root);
    const target = captureManagedIdentityIfPresent(action.target_path, item.managed_root);
    const evidence = captureManagedIdentityIfPresent(action.evidence_path, item.managed_root);
    if (action.stage === "intent") {
      const sourceExpected = sourcePresent && actionObjectMatches(source, expected);
      const targetExpected = targetPresent && actionObjectMatches(target, expected);
      const evidenceExpected = evidencePresent && actionObjectMatches(evidence, expected);
      if (sourceExpected && !targetPresent && !evidencePresent) {
        return updateFsAction(db, job, action, "cancelled", source);
      }
      if (sourceExpected && targetExpected && !evidencePresent) {
        const captured = capturePathIntoEvidence(
          db,
          job,
          item,
          action,
          (candidatePath) => captureManagedFileIdentity(candidatePath, item.managed_root),
          { neutralize: false }
        );
        action = captured.action;
      } else if (!sourcePresent && targetExpected && evidenceExpected) {
        action = updateFsAction(db, job, action, "captured", evidence);
      } else {
        return failFsAction(db, job, action, "media intent paths cannot be safely reconciled");
      }
    }
    if (action.stage === "captured") {
      const currentTarget = captureManagedIdentityIfPresent(action.target_path, item.managed_root);
      const currentEvidence = captureManagedIdentityIfPresent(action.evidence_path, item.managed_root);
      if (!currentTarget || !actionObjectMatches(currentTarget, expected)) {
        return failFsAction(db, job, action, "retained media target changed before evidence release");
      }
      if (!currentEvidence) {
        return updateFsAction(db, job, action, "released", currentTarget);
      }
      action = releasePrivateEvidenceLink(db, job, item, action, action.target_path);
    }
    if (action.stage === "released") {
      const currentTarget = captureManagedIdentityIfPresent(action.target_path, item.managed_root);
      if (lstatIfPresent(action.evidence_path)
        || lstatIfPresent(action.source_path)
        || !currentTarget
        || !actionObjectMatches(currentTarget, expected)) {
        return failFsAction(db, job, action, "released media action no longer matches its target");
      }
    }
    return action;
  }

  function reconcileRemovalFsAction(db, job, item, action) {
    if (action.kind === "guard-prepared-publish"
      && !GUARD_PUBLISH_MODES.has(String(item.guard_publish_mode || ""))) {
      throw codedError("guard 发布模式缺失且无法安全推导", "SHORT_VIDEO_DELETE_GUARD_MODE_MISSING");
    }
    const expected = parseJson(action.expected_identity_json, null);
    if (action.stage === "intent") {
      if (lstatIfPresent(action.source_path) && !lstatIfPresent(action.evidence_path)) {
        action = capturePathIntoEvidence(
          db,
          job,
          item,
          action,
          (candidatePath) => captureRemovalCandidate(job, item, action, candidatePath),
          { neutralize: !action.target_path }
        ).action;
        if (action.target_path) {
          action = releasePrivateEvidenceLink(db, job, item, action, action.target_path);
        }
      } else if (!lstatIfPresent(action.source_path) && lstatIfPresent(action.evidence_path)) {
        const captured = captureRemovalCandidate(job, item, action, action.evidence_path);
        if (!captured || !actionObjectMatches(captured, expected)) {
          return failFsAction(db, job, action, "removal intent captured an unproven object");
        }
        action = updateFsAction(db, job, action, "captured", captured);
      } else {
        return failFsAction(db, job, action, "removal intent paths cannot be safely reconciled");
      }
    }
    if (action.stage === "captured") {
      const evidence = lstatIfPresent(action.evidence_path);
      if (!evidence && action.target_path) {
        const retained = captureRemovalCandidate(job, item, action, action.target_path);
        if (retained && actionObjectMatches(retained, expected)) {
          return updateFsAction(db, job, action, "released", retained);
        }
      }
      if (!evidence) return failFsAction(db, job, action, "captured removal evidence is missing");
      action = capturePathIntoEvidence(
        db,
        job,
        item,
        action,
        (candidatePath) => captureRemovalCandidate(job, item, action, candidatePath),
        { neutralize: !action.target_path }
      ).action;
      if (action.target_path) {
        action = releasePrivateEvidenceLink(db, job, item, action, action.target_path);
      }
    }
    if (action.stage === "neutralized") {
      const entry = lstatIfPresent(action.evidence_path);
      if (entry && (!entry.isFile() || entry.isSymbolicLink() || Number(entry.size) !== 0)) {
        return failFsAction(db, job, action, "neutralized evidence is missing or non-empty");
      }
    }
    if (action.stage === "released" && lstatIfPresent(action.evidence_path)) {
      return failFsAction(db, job, action, "released removal action retained an evidence name");
    }
    return action;
  }

  function captureRemovalCandidate(job, item, action, candidatePath) {
    if (action.kind === "quarantine-cleanup") {
      return captureManagedFileIdentity(candidatePath, item.managed_root);
    }
    if (action.kind.startsWith("owner-marker-")) {
      return captureExactSmallFileCapability(candidatePath, `${job.id}:${job.quarantine_token}`);
    }
    if (action.kind === "guard-partial-remove") {
      return captureExclusiveGuardPrefixCapability(
        candidatePath,
        job,
        item.ordinal,
        parseJson(item.guard_publish_identity_json, null)
      )?.identity || null;
    }
    if (action.kind.startsWith("guard-")) {
      if (action.kind.includes("prepared")) {
        return captureOwnedPreparedGuardCapability(candidatePath, job, item.ordinal);
      }
      return captureOwnedGuardCapability(candidatePath, job, item.ordinal, "");
    }
    return null;
  }

  function captureManagedIdentityIfPresent(filePath, root) {
    if (!filePath || !lstatIfPresent(filePath)) return null;
    try {
      return captureManagedFileIdentity(filePath, root);
    } catch {
      return null;
    }
  }

  function finalizeReconciledFsAction(db, job, item, action) {
    if (action.stage === "neutralized" && lstatIfPresent(action.evidence_path)) {
      removePrivateNeutralizedEvidence(db, job, item, action);
    }
    if (lstatIfPresent(action.evidence_path)) {
      return failFsAction(db, job, action, "reconciled action still has evidence content");
    }
    try {
      fs.rmdirSync(action.evidence_dir);
    } catch (error) {
      if (!isMissing(error)) return failFsAction(db, job, action, "evidence directory is not empty");
    }
    beginImmediate(db);
    try {
      heartbeat(db, job.id);
      requireOwnedJob(db, job.id);
      const removed = db.prepare(`
        DELETE FROM ${FS_ACTION_TABLE}
        WHERE job_id = ? AND action_key = ? AND stage = ?
      `).run(job.id, action.action_key, action.stage);
      if (Number(removed.changes || 0) !== 1) {
        throw codedError("已收敛文件动作删除 CAS 失败", "SHORT_VIDEO_DELETE_LEASE_LOST");
      }
      db.exec("COMMIT");
    } catch (error) {
      rollback(db);
      throw error;
    }
  }

  function removePrivateNeutralizedEvidence(db, job, item, action) {
    ensureFsActionEvidenceDirectory(action, item);
    const handle = fsOps.openSync(action.evidence_path, "r");
    try {
      const bound = captureIdentity(fsOps.fstatSync(handle, { bigint: true }));
      const observed = parseJson(action.observed_identity_json, null);
      if (!observed
        || !actionInodeMatches(bound, observed)
        || String(bound.size || "") !== "0"
        || String(bound.nlink || "") !== "1") {
        return failFsAction(db, job, action, "neutralized private evidence changed before release");
      }
      fs.unlinkSync(action.evidence_path);
      hooks.afterFsActionSystemCall?.({
        jobId: job.id,
        ordinal: Number(action.ordinal),
        kind: action.kind,
        boundary: "evidence_unlinked"
      });
      const after = captureIdentity(fsOps.fstatSync(handle, { bigint: true }));
      if (String(after.nlink || "") !== "0") {
        return failFsAction(db, job, action, "neutralized evidence unlink did not release exactly one name");
      }
    } finally {
      fsOps.closeSync(handle);
    }
  }

  function captureOwnedIncompleteExclusiveGuard(job, item) {
    if (String(item?.guard_publish_mode || "") !== GUARD_PUBLISH_EXCLUSIVE_CREATE) return null;
    const publicationIdentity = parseJson(item.guard_publish_identity_json, null);
    const expectedSource = parseJson(item.source_identity_json, null);
    if (!publicationIdentity || !expectedSource
      || String(publicationIdentity.size || "") !== "0"
      || String(publicationIdentity.nlink || "") !== "1"
      || String(publicationIdentity.dev || "") !== String(expectedSource.dev || "")) return null;
    const jobDir = path.dirname(item.quarantine_path);
    requireOwnedJobDirectory(job, jobDir, item.managed_root);
    assertGuardDestination(item.original_path, item.managed_root, expectedSource);
    const prepared = captureOwnedGuardCapability(
      guardTempPath(jobDir, job, item.ordinal),
      job,
      item.ordinal,
      ""
    );
    const published = captureExclusiveGuardPrefixCapability(
      item.original_path,
      job,
      item.ordinal,
      publicationIdentity
    );
    if (!prepared || !published
      || String(prepared.dev) !== String(expectedSource.dev)
      || String(published.identity.dev) !== String(expectedSource.dev)
      || (String(prepared.dev) === String(published.identity.dev)
        && String(prepared.ino) === String(published.identity.ino))) return null;
    return { published: published.identity, prepared, content: published.content };
  }

  function captureExclusiveGuardPrefixCapability(filePath, job, ordinal, publicationIdentity) {
    const lexicalEntry = fsOps.lstatSync(filePath, { bigint: true });
    if (!lexicalEntry.isFile() || lexicalEntry.isSymbolicLink() || Number(lexicalEntry.size) > 1024) return null;
    const handle = fsOps.openSync(filePath, "r");
    let before;
    let after;
    let content;
    try {
      before = captureIdentity(fsOps.fstatSync(handle, { bigint: true }));
      if (!matchesCheapIdentity(before, captureIdentity(lexicalEntry))) return null;
      content = fsOps.readFileSync(handle, "utf8");
      after = captureIdentity(fsOps.fstatSync(handle, { bigint: true }));
    } finally {
      fsOps.closeSync(handle);
    }
    const expectedContent = guardContent(job, ordinal);
    if (!matchesExactSnapshot(after, before)
      || content === expectedContent
      || !expectedContent.startsWith(content)
      || !matchesExclusiveGuardPublishIdentity(after, publicationIdentity)) return null;
    const finalIdentity = captureIdentity(fsOps.lstatSync(filePath, { bigint: true }));
    if (!matchesCheapIdentity(finalIdentity, after)) return null;
    return { identity: after, content };
  }

  function matchesExclusiveGuardPublishIdentity(actual, expected) {
    return String(expected?.size || "") === "0"
      && String(expected?.nlink || "") === "1"
      && String(actual?.dev || "") === String(expected?.dev || "")
      && String(actual?.ino || "") === String(expected?.ino || "")
      && String(actual?.birthtimeNs || "") === String(expected?.birthtimeNs || "")
      && String(actual?.nlink || "") === "1";
  }

  function assertOwnedIncompleteExclusiveGuard(job, item, expected) {
    const current = captureOwnedIncompleteExclusiveGuard(job, item);
    if (!current
      || current.content !== expected.content
      || !matchesExactSnapshot(current.published, expected.published)
      || !matchesExactSnapshot(current.prepared, expected.prepared)) {
      throw codedError("exclusive guard 半写文件已被替换", "SHORT_VIDEO_DELETE_GUARD_REPLACED");
    }
    return current;
  }

  function removeOwnedIncompleteExclusiveGuard(db, job, item, expected) {
    const current = assertOwnedIncompleteExclusiveGuard(job, item, expected);
    const action = beginFsAction(
      db,
      job,
      item,
      "guard-partial-remove",
      item.original_path,
      "",
      current.published
    );
    capturePathIntoEvidence(
      db,
      job,
      item,
      action,
      (candidatePath) => captureExclusiveGuardPrefixCapability(
        candidatePath,
        job,
        item.ordinal,
        parseJson(item.guard_publish_identity_json, null)
      )?.identity || null,
      { neutralize: true }
    );
  }

  function removeProvenGuardThroughPrivateCandidate(
    db,
    job,
    item,
    sourcePath,
    proof,
    actionKind,
    retainedPath = ""
  ) {
    const action = beginFsAction(db, job, item, `guard-${actionKind}`, sourcePath, retainedPath, proof);
    const captured = capturePathIntoEvidence(
      db,
      job,
      item,
      action,
      (candidatePath) => actionKind.includes("prepared")
        ? captureOwnedPreparedGuardCapability(candidatePath, job, item.ordinal)
        : captureOwnedGuardCapability(candidatePath, job, item.ordinal, ""),
      { neutralize: !retainedPath }
    );
    if (retainedPath) releasePrivateEvidenceLink(db, job, item, captured.action, retainedPath);
  }

  function captureIdentity(entry) {
    const dev = String(entry?.dev ?? "");
    const ino = String(entry?.ino ?? "");
    if (!dev || !ino || dev === "0" || ino === "0") {
      throw codedError("文件系统没有提供可用的 dev/ino ownership", "SHORT_VIDEO_DELETE_IDENTITY_UNAVAILABLE");
    }
    return {
      dev,
      ino,
      nlink: String(entry.nlink ?? ""),
      size: String(entry.size ?? ""),
      birthtimeNs: String(entry.birthtimeNs ?? ""),
      mtimeNs: String(entry.mtimeNs ?? ""),
      ctimeNs: String(entry.ctimeNs ?? "")
    };
  }

  function identityMatches(actual, expected, options = {}) {
    const stable = matchesStableIdentity(actual, expected);
    return stable && (!options.compareChangeTime
      || String(actual?.ctimeNs || "") === String(expected?.ctimeNs || ""));
  }

  function matchesStableIdentity(actual, expected) {
    return String(actual?.dev || "") === String(expected?.dev || "")
      && String(actual?.ino || "") === String(expected?.ino || "")
      && String(actual?.size || "") === String(expected?.size || "")
      && String(actual?.birthtimeNs || "") === String(expected?.birthtimeNs || "")
      && String(actual?.mtimeNs || "") === String(expected?.mtimeNs || "");
  }

  function matchesCheapIdentity(actual, expected) {
    return String(actual?.dev || "") === String(expected?.dev || "")
      && String(actual?.ino || "") === String(expected?.ino || "")
      && (!expected?.nlink || String(actual?.nlink || "") === String(expected.nlink))
      && String(actual?.size || "") === String(expected?.size || "")
      && String(actual?.mtimeNs || "") === String(expected?.mtimeNs || "")
      && String(actual?.ctimeNs || "") === String(expected?.ctimeNs || "");
  }

  function matchesExactSnapshot(actual, expected) {
    if (!matchesStableIdentity(actual, expected)) return false;
    if (expected?.nlink && String(actual?.nlink || "") !== String(expected.nlink)) return false;
    if (String(actual?.ctimeNs || "") !== String(expected?.ctimeNs || "")) return false;
    for (const key of ["realPathKey", "parentRealPathKey", "rootRealPathKey"]) {
      if (expected?.[key] && String(actual?.[key] || "") !== String(expected[key])) return false;
    }
    if (Object.prototype.hasOwnProperty.call(expected || {}, "aliasRisk")
      && Boolean(actual?.aliasRisk) !== Boolean(expected.aliasRisk)) return false;
    return true;
  }

  function matchesRenameTransition(actual, expected) {
    if (String(actual?.dev || "") !== String(expected?.dev || "")
      || String(actual?.ino || "") !== String(expected?.ino || "")
      || (expected?.nlink && String(actual?.nlink || "") !== String(expected.nlink))
      || String(actual?.size || "") !== String(expected?.size || "")
      || String(actual?.birthtimeNs || "") !== String(expected?.birthtimeNs || "")
      || String(actual?.mtimeNs || "") !== String(expected?.mtimeNs || "")) return false;
    return !expected?.rootRealPathKey
      || String(actual?.rootRealPathKey || "") === String(expected.rootRealPathKey);
  }

  function matchesRollbackRenameTransition(actual, expected) {
    return String(actual?.dev || "") === String(expected?.dev || "")
      && String(actual?.ino || "") === String(expected?.ino || "")
      && (!expected?.nlink || String(actual?.nlink || "") === String(expected.nlink))
      && String(actual?.size || "") === String(expected?.size || "")
      && String(actual?.mtimeNs || "") === String(expected?.mtimeNs || "")
      && (!expected?.rootRealPathKey
        || String(actual?.rootRealPathKey || "") === String(expected.rootRealPathKey));
  }

  function matchesRollbackQuarantine(actual, expected) {
    if (!matchesStableIdentity(actual, expected)) return false;
    if (expected?.nlink && String(actual?.nlink || "") !== String(expected.nlink)) return false;
    for (const key of ["realPathKey", "parentRealPathKey", "rootRealPathKey"]) {
      if (expected?.[key] && String(actual?.[key] || "") !== String(expected[key])) return false;
    }
    if (Object.prototype.hasOwnProperty.call(expected || {}, "aliasRisk")
      && Boolean(actual?.aliasRisk) !== Boolean(expected.aliasRisk)) return false;
    return true;
  }

  function assertManagedRoot(root) {
    const expected = managedRoots.find((candidate) => samePath(candidate, root));
    if (!expected) throw codedError("持久计划中的受管根无效", "SHORT_VIDEO_DELETE_ROOT_INVALID");
    const entry = fsOps.lstatSync(expected, { bigint: true });
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw codedError("受管根不是普通目录", "SHORT_VIDEO_DELETE_ROOT_INVALID");
    }
  }

  function managedRootGroupKey(root) {
    const lexicalKey = pathKey(root);
    if (rootGroupCache.has(lexicalKey)) return rootGroupCache.get(lexicalKey);
    try {
      const groupKey = pathKey(realpath(root));
      rootGroupCache.set(lexicalKey, groupKey);
      return groupKey;
    } catch (error) {
      throw codedError("受管根 canonical identity 无法解析", "SHORT_VIDEO_DELETE_ROOT_INVALID", error?.message);
    }
  }

  function managedRootGroupForRealPath(realPathKey) {
    for (const root of managedRoots) {
      let groupKey;
      try {
        groupKey = managedRootGroupKey(root);
      } catch {
        continue;
      }
      if (isInside(realPathKey, groupKey) && !samePath(realPathKey, groupKey)) return groupKey;
    }
    return "";
  }

  function pathHasAliasRisk(filePath, root, fileRealPath = "", rootRealPath = "") {
    const lexical = path.resolve(filePath);
    const lexicalRoot = path.resolve(root);
    const relative = path.relative(lexicalRoot, lexical);
    if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return true;
    const physicalRoot = rootRealPath || realpath(root);
    const physicalFile = fileRealPath || realpath(filePath);
    return pathKey(path.resolve(physicalRoot, relative)) !== pathKey(physicalFile);
  }

  function isQuarantinePath(value, root) {
    const relative = path.relative(path.resolve(root), path.resolve(value));
    const first = relative.split(path.sep)[0] || "";
    return first.toLocaleLowerCase() === SHORT_VIDEO_DELETE_QUARANTINE_DIR.toLocaleLowerCase();
  }

  function databaseDisposition(db, job) {
    const ids = videoIds(job);
    if (!ids.length) return "partial";
    const placeholders = ids.map(() => "?").join(", ");
    const count = Number(db.prepare(`SELECT COUNT(*) AS count FROM short_videos WHERE id IN (${placeholders})`).get(...ids)?.count || 0);
    if (count === ids.length) return "uncommitted";
    if (count === 0) return "committed";
    return "partial";
  }

  function canonicalPathKey(value) {
    let current = path.resolve(String(value || ""));
    const suffix = [];
    while (true) {
      const entry = lstatIfPresent(current);
      if (entry) {
        return pathKey(path.join(realpath(current), ...suffix));
      }
      const parent = path.dirname(current);
      if (samePath(parent, current)) return "";
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }

  function hasOutsideReferences(references, keys, selectedIds, rootGroupKey = "") {
    const referenced = keys.some(([kind, key]) => [...(references.get(referenceLookupKey(kind, key)) || [])]
      .some((videoId) => !selectedIds.has(videoId)));
    if (referenced) return true;
    const uncertainGroups = rootGroupKey ? [rootGroupKey, "*"] : ["*"];
    return uncertainGroups.some((group) => [...(references.get(referenceLookupKey("uncertain", group)) || [])]
      .some((videoId) => !selectedIds.has(videoId)));
  }

  function assertNoLateReferences(db, job, references) {
    const ids = new Set(videoIds(job));
    for (const item of readItems(db, job.id)) {
      if (!["delete", "missing", "alias"].includes(item.disposition)) continue;
      const keys = [
        ["path", item.path_key],
        ["real", item.real_path_key],
        ["identity", item.identity_key]
      ].filter(([, value]) => value);
      if (hasOutsideReferences(references, keys, ids, managedRootGroupKey(item.managed_root))) {
        throw codedError("隔离路径新增了其他短视频引用", "SHORT_VIDEO_DELETE_LATE_REFERENCE");
      }
    }
  }

  function referencesFromRows(rows) {
    const map = new Map();
    const addKey = (kind, key, videoId) => {
      if (!key) return;
      const lookup = referenceLookupKey(kind, key);
      if (!map.has(lookup)) map.set(lookup, new Set());
      map.get(lookup).add(String(videoId));
    };
    for (const row of rows || []) {
      const videoId = String(row.owner_video_id ?? row.ownerVideoId ?? "");
      const lexicalKey = String(row.path_key ?? row.pathKey ?? "");
      const realPathKey = String(row.real_path_key ?? row.realPathKey ?? "");
      const identityKey = String(row.identity_key ?? row.identityKey ?? "");
      const rootGroupKey = String(row.root_group_key ?? row.rootGroupKey ?? "");
      const probeState = String(row.probe_state ?? row.probeState ?? "unverified");
      addKey("path", lexicalKey, videoId);
      if (probeState === "ready") {
        addKey("real", realPathKey, videoId);
        addKey("identity", identityKey, videoId);
        if ((Boolean(row.aliasRisk) || Number(row.nlink || 0) > 1) && rootGroupKey) {
          addKey("uncertain", rootGroupKey, videoId);
        }
      } else if (probeState !== "missing") {
        // A failed or otherwise unclassifiable current reference cannot prove
        // which managed root it reaches. Preserve every selected file when no
        // narrower root group is available rather than silently dropping it.
        addKey("uncertain", rootGroupKey || "*", videoId);
      }
    }
    return map;
  }

  function createReferenceProbeCache() {
    return {
      directories: new Map(),
      directoryEntries: new Map()
    };
  }

  function probeReferenceDirectory(directoryPath, cache) {
    const resolved = path.resolve(directoryPath);
    const key = pathKey(resolved);
    if (cache.directories.has(key)) return cache.directories.get(key);
    const parent = path.dirname(resolved);
    if (!samePath(parent, resolved)) {
      const parentState = probeReferenceDirectory(parent, cache);
      if (parentState !== "ready") {
        cache.directories.set(key, parentState);
        return parentState;
      }
    }
    try {
      const entry = fsOps.statSync(resolved, { bigint: true });
      const state = entry.isDirectory() ? "ready" : "missing";
      cache.directories.set(key, state);
      return state;
    } catch (error) {
      const state = isMissing(error) || isInvalidPath(error) ? "missing" : "failed";
      cache.directories.set(key, state);
      return state;
    }
  }

  function probeReferenceDirectoryEntries(directoryPath, cache) {
    const key = pathKey(path.resolve(directoryPath));
    if (cache.directoryEntries.has(key)) return cache.directoryEntries.get(key);
    try {
      const entries = new Set(fsOps.readdirSync(directoryPath).map((name) => pathKey(String(name))));
      const result = { state: "ready", entries };
      cache.directoryEntries.set(key, result);
      return result;
    } catch (error) {
      const result = {
        state: isMissing(error) || isInvalidPath(error) ? "missing" : "failed",
        entries: new Set()
      };
      cache.directoryEntries.set(key, result);
      return result;
    }
  }

  function probeReferencePath(value, cache = createReferenceProbeCache()) {
    const text = String(value || "");
    if (text.includes("\0")) return { probeState: "missing" };
    const lexicalRoot = managedRootFor(text, managedRoots);
    let lexicalRootGroupKey = "";
    if (lexicalRoot) lexicalRootGroupKey = managedRootGroupKey(lexicalRoot);
    const resolved = path.resolve(text);
    const parent = path.dirname(resolved);
    const parentState = probeReferenceDirectory(parent, cache);
    if (parentState !== "ready") {
      return { probeState: parentState, rootGroupKey: lexicalRootGroupKey };
    }
    const listing = probeReferenceDirectoryEntries(parent, cache);
    if (listing.state !== "ready") {
      return { probeState: listing.state, rootGroupKey: lexicalRootGroupKey };
    }
    if (!listing.entries.has(pathKey(path.basename(resolved)))) {
      return { probeState: "missing", rootGroupKey: lexicalRootGroupKey };
    }
    try {
      const entry = fsOps.statSync(resolved, { bigint: true });
      if (!entry.isFile()) return { probeState: "missing", rootGroupKey: lexicalRootGroupKey };
      const resolvedRealPath = realpath(resolved);
      const realPathKey = pathKey(resolvedRealPath);
      const actualRootGroupKey = managedRootGroupForRealPath(realPathKey);
      const identity = captureIdentity(entry);
      const aliasRisk = !lexicalRoot
        || pathHasAliasRisk(resolved, lexicalRoot, resolvedRealPath, realpath(lexicalRoot));
      if (!actualRootGroupKey) {
        return {
          probeState: "outside",
          realPathKey,
          identityKey: physicalIdentityKey(identity),
          rootGroupKey: lexicalRootGroupKey,
          aliasRisk,
          nlink: identity.nlink
        };
      }
      return {
        probeState: "ready",
        realPathKey,
        identityKey: physicalIdentityKey(identity),
        rootGroupKey: actualRootGroupKey,
        aliasRisk,
        nlink: identity.nlink
      };
    } catch (error) {
      if (isMissing(error) || isInvalidPath(error)) return { probeState: "missing", rootGroupKey: lexicalRootGroupKey };
      return { probeState: "failed", rootGroupKey: lexicalRootGroupKey };
    }
  }

  function assertNoReservationConflicts(db, videoIdsValue, items) {
    const keys = [
      ...videoIdsValue.map((id) => ["video", id]),
      ...items.filter((item) => ["delete", "missing", "alias", "retained"].includes(item.disposition)).flatMap((item) => [
        ["path", item.pathKey],
        ["real", item.realPathKey],
        ["identity", item.identityKey]
      ].filter(([, value]) => value))
    ];
    const query = db.prepare(`
      SELECT 1 FROM short_video_delete_reservations
      WHERE kind = ? AND reservation_key = ? AND released_at = ''
      LIMIT 1
    `);
    if (keys.some(([kind, key]) => query.get(kind, key))) {
      throw statusError(
        "另一个短视频删除作业正在处理这些记录或文件",
        409,
        "SHORT_VIDEO_DELETE_CONFLICT"
      );
    }
  }

  function buildResult(db, jobId) {
    const job = readJob(db, jobId);
    const stored = parseJson(job?.result_json, null);
    return stored || buildResultFromRows(job, readItems(db, jobId));
  }

  function executionResult(db, jobId, options = {}) {
    const job = readJob(db, jobId);
    if (!job) throw statusError("短视频删除作业不存在", 404, "SHORT_VIDEO_DELETE_JOB_NOT_FOUND");
    const result = { ...sanitizedJobResult(job, buildResult(db, jobId)) };
    const items = readItems(db, jobId);
    const completed = job.status === "completed";
    const cleanupPending = job.status === "cleanup_pending";
    const pending = ACTIVE_STATUSES.includes(String(job.status || ""));
    const publicState = publicJob(job);
    const keyedOperation = isKeyedJob(job);
    const keyedRollbackPending = keyedOperation && job.status === "rollback_pending";
    if (cleanupPending) {
      result.deletedFiles = items
        .filter((item) => item.disposition === "delete" && item.state === "cleaned")
        .map((item) => item.relative_path);
    }
    return {
      ...result,
      ok: completed || cleanupPending,
      accepted: !keyedRollbackPending && (completed || pending) && !publicState.manualInterventionRequired,
      pending,
      recoveryRequired: job.status === "rollback_pending",
      recoverable: publicState.recoverable,
      retryable: publicState.retryable,
      code: publicState.errorCode,
      manualInterventionRequired: publicState.manualInterventionRequired,
      processRestartRequired: publicState.processRestartRequired,
      state: publicState.state,
      status: String(job.status || ""),
      jobId: String(job.id || ""),
      operationId: keyedOperation ? String(job.id || "") : "",
      keyedOperation,
      replayed: options.replayed === true,
      httpStatus: deleteJobHttpStatus(publicState),
      logicalDeleteCommitted: databaseDisposition(db, job) === "committed",
      physicalCleanupComplete: completed,
      cleanupPendingFiles: cleanupPending
        ? items.filter((item) => item.disposition === "delete" && item.state !== "cleaned").length
        : 0
    };
  }

  function receiptExecutionResult(operation) {
    const statusValue = String(operation.terminal_status || "");
    const expired = !String(operation.result_json || "");
    const result = sanitizedJobResult({
      id: operation.operation_id,
      status: statusValue,
      request_sha256: operation.request_sha256,
      result_json: operation.result_json,
      video_ids_json: "[]",
      created_at: operation.created_at,
      updated_at: operation.finished_at,
      finished_at: operation.finished_at
    });
    const completed = statusValue === "completed";
    return {
      ...result,
      ok: completed && !expired,
      accepted: completed && !expired,
      pending: false,
      recoveryRequired: false,
      retryable: false,
      manualInterventionRequired: false,
      processRestartRequired: false,
      state: expired ? "expired" : statusValue,
      status: statusValue,
      terminalStatus: statusValue,
      jobId: String(operation.operation_id || ""),
      operationId: String(operation.operation_id || ""),
      keyedOperation: true,
      replayed: true,
      receiptOnly: true,
      expired,
      resultExpired: expired,
      code: expired ? "SHORT_VIDEO_DELETE_OPERATION_EXPIRED" : "",
      httpStatus: completed && !expired ? 200 : 409,
      logicalDeleteCommitted: completed,
      physicalCleanupComplete: completed,
      cleanupPendingFiles: 0
    };
  }

  function pendingOperationError(db, jobId, cause, fallback) {
    const error = operationError(cause, fallback);
    const job = readJob(db, jobId);
    if (!job || !ACTIVE_STATUSES.includes(job.status)) return error;
    error.statusCode = job.status === "rollback_pending" ? 500 : Number(error.statusCode || 500);
    const manualInterventionRequired = requiresManualIntervention(job.error_code || error.code);
    error.retryable = !manualInterventionRequired;
    error.publicBody = {
      ok: false,
      accepted: false,
      pending: true,
      recoveryRequired: true,
      retryable: !manualInterventionRequired,
      manualInterventionRequired,
      processRestartRequired: false,
      status: String(job.status || "rollback_pending"),
      jobId: String(job.id || ""),
      code: publicDeleteErrorCode(job.error_code || error.code)
    };
    return error;
  }

  function buildResultFromRows(job, items) {
    const ids = videoIds(job);
    return {
      ok: true,
      id: String(job?.anchor_id || ids[0] || ""),
      ids,
      count: ids.length,
      scope: String(job?.scope || "single"),
      groupDir: job?.group_dir ? String(displayPath(job.group_dir)) : "",
      title: String(job?.title || ""),
      deletedFiles: items.filter((item) => ["delete", "alias"].includes(item.disposition)).map((item) => item.relative_path),
      deletedStoredCovers: 0,
      coverCleanupError: "",
      missingFiles: items.filter((item) => item.disposition === "missing").map((item) => item.relative_path),
      skippedFiles: items.filter((item) => ["skipped", "retained"].includes(item.disposition)).map((item) => ({
        path: item.relative_path,
        reason: item.reason || ""
      })),
      emptyRemovedPaths: []
    };
  }

  function publicJob(row) {
    const ids = parseJson(row.video_ids_json, []);
    const pending = ACTIVE_STATUSES.includes(String(row.status || ""));
    const leaseExpired = pending && !leaseActive(row.lease_until);
    const localExecutionToken = activeExecutionTokenFor(row.id);
    const sameProcessExecutionFence = pending
      && leaseExpired
      && ownerProcessId(row.owner_id) === process.pid
      && (!localExecutionToken || String(row.execution_token || "") !== localExecutionToken);
    const blockedByActiveOwner = pending && (
      Boolean(String(row.execution_token || ""))
      && String(row.execution_token || "") !== localExecutionToken
        ? durableExecutionStillExclusive(row.owner_id, row.lease_until, row.execution_token)
        : Boolean(localExecutionToken)
          || ownerStillExclusive(row.owner_id, row.lease_until)
    );
    const stalled = leaseExpired && blockedByActiveOwner;
    // A worker_thread crash cannot be distinguished from an active sibling
    // isolate by PID liveness. Keep the durable token fenced until a process
    // restart proves the old PID dead, and expose the availability tradeoff
    // instead of advertising unsafe automatic recovery.
    const processRestartRequired = sameProcessExecutionFence;
    const manualInterventionRequired = requiresManualIntervention(row.error_code)
      || processRestartRequired;
    const requiresAttention = row.status === "rollback_pending"
      || stalled
      || processRestartRequired
      || Boolean(row.error_code);
    const publicRow = {
      id: row.id,
      status: row.status,
      state: manualInterventionRequired ? "manual" : row.status,
      phase: row.phase,
      scope: row.scope,
      videoCount: Array.isArray(ids) ? ids.length : 0,
      attempts: Number(row.attempts || 0),
      owner_id: String(row.owner_id || ""),
      lease_until: String(row.lease_until || ""),
      pending,
      requiresAttention,
      stalled,
      leaseExpired,
      blockedByActiveOwner,
      recoverable: pending && !blockedByActiveOwner && !manualInterventionRequired,
      retryable: pending && !blockedByActiveOwner && !manualInterventionRequired,
      manualInterventionRequired,
      processRestartRequired,
      errorCode: publicDeleteErrorCode(row.error_code),
      error: publicPendingMessage(row.error_code),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      finishedAt: String(row.finished_at || ""),
      keyedOperation: isKeyedJob(row),
      result: sanitizedJobResult(row)
    };
    publicRow.httpStatus = deleteJobHttpStatus(publicRow);
    return publicRow;
  }

  function publicReceipt(operation) {
    const replay = receiptExecutionResult(operation);
    return {
      id: replay.jobId,
      status: replay.status,
      state: replay.state,
      phase: replay.status,
      scope: replay.scope,
      videoCount: replay.count,
      attempts: 0,
      owner_id: "",
      lease_until: "",
      pending: false,
      requiresAttention: replay.status === "rolled_back" || replay.expired,
      stalled: false,
      leaseExpired: false,
      blockedByActiveOwner: false,
      recoverable: false,
      retryable: false,
      manualInterventionRequired: false,
      processRestartRequired: false,
      errorCode: "",
      error: "",
      createdAt: String(operation.created_at || ""),
      updatedAt: String(operation.finished_at || ""),
      finishedAt: String(operation.finished_at || ""),
      keyedOperation: true,
      receiptOnly: true,
      expired: replay.expired,
      resultExpired: replay.resultExpired,
      code: replay.code,
      result: sanitizedJobResult({ result_json: operation.result_json }),
      httpStatus: replay.httpStatus
    };
  }

  function deleteJobHttpStatus(job) {
    if (job.manualInterventionRequired) return 409;
    if (job.keyedOperation && job.status === "rollback_pending") return 500;
    if (job.status === "completed") return 200;
    if (job.status === "rolled_back") return 409;
    return ACTIVE_STATUSES.includes(String(job.status || "")) ? 202 : 200;
  }

  function isKeyedJob(row) {
    return Boolean(String(row?.request_sha256 || ""));
  }

  function coverDeleteReceipt(job) {
    return isKeyedJob(job)
      ? { operationId: String(job.id || ""), requestSha256: String(job.request_sha256 || "") }
      : undefined;
  }

  function sanitizedJobResult(row, fallback = null) {
    const ids = videoIds(row);
    const stored = parseJson(row?.result_json, null);
    const value = stored && typeof stored === "object" ? stored : fallback;
    const source = value && typeof value === "object" ? value : {};
    const stringList = (items) => uniqueStrings(Array.isArray(items) ? items : [], 10_000)
      .map((item) => item.slice(0, 2_000));
    const skippedFiles = Array.isArray(source.skippedFiles)
      ? source.skippedFiles.slice(0, 10_000).map((item) => ({
          path: String(item?.path || "").slice(0, 2_000),
          reason: String(item?.reason || "").slice(0, 500)
        }))
      : [];
    return {
      ok: source.ok !== false,
      id: String(source.id || row?.anchor_id || ids[0] || "").slice(0, 200),
      ids: stringList(Array.isArray(source.ids) ? source.ids : ids),
      count: Math.max(0, Number(source.count ?? ids.length) || 0),
      scope: String(source.scope || row?.scope || "single").slice(0, 20),
      groupDir: String(source.groupDir || "").slice(0, 2_000),
      title: String(source.title || row?.title || "").slice(0, 1_000),
      deletedFiles: stringList(source.deletedFiles),
      deletedStoredCovers: Math.max(0, Number(source.deletedStoredCovers || 0) || 0),
      coverCleanupError: String(source.coverCleanupError || "").slice(0, 1_000),
      missingFiles: stringList(source.missingFiles),
      skippedFiles,
      emptyRemovedPaths: stringList(source.emptyRemovedPaths)
    };
  }

  function publicHookJob(row) {
    return row ? { id: row.id, status: row.status, phase: row.phase } : null;
  }

  function publicPendingMessage(code) {
    if (!code) return "";
    if (String(code).includes("CLEANUP")) return "隔离文件清理等待重试";
    if (String(code).includes("GUARD") || String(code).includes("REPLACED")) return "文件位置已变化，等待安全恢复";
    return "删除作业等待安全恢复";
  }

  function publicDeleteErrorCode(code) {
    const value = String(code || "");
    return value.startsWith("SHORT_VIDEO_DELETE_")
      ? value
      : value ? "SHORT_VIDEO_DELETE_RECOVERY_REQUIRED" : "";
  }

  function pruneTerminalJobs(db) {
    const limit = Math.max(1, Math.min(10_000, Number(terminalJobLimit || 200)));
    const staleLegacy = db.prepare(`
      SELECT id FROM short_video_delete_jobs
      WHERE status IN ('completed', 'rolled_back')
        AND request_sha256 = ''
      ORDER BY finished_at DESC, id DESC
      LIMIT -1 OFFSET ?
    `).all(limit);
    const staleKeyed = db.prepare(`
      SELECT id FROM short_video_delete_jobs
      WHERE status IN ('completed', 'rolled_back')
        AND request_sha256 <> ''
      ORDER BY finished_at DESC, id DESC
      LIMIT -1 OFFSET ?
    `).all(limit);
    const stale = [...staleLegacy, ...staleKeyed];
    const remove = db.prepare(`
      DELETE FROM short_video_delete_jobs
      WHERE id = ?
        AND status IN ('completed', 'rolled_back')
        AND NOT EXISTS (
          SELECT 1 FROM short_video_delete_reservations reservation
          WHERE reservation.job_id = short_video_delete_jobs.id AND reservation.released_at = ''
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${FS_ACTION_TABLE} action
          WHERE action.job_id = short_video_delete_jobs.id
        )
    `);
    let removed = 0;
    for (const row of stale) removed += Number(remove.run(row.id).changes || 0);
    const retentionMs = Math.max(
      DEFAULT_KEYED_TERMINAL_RETENTION_MS,
      Number(keyedTerminalRetentionMs || DEFAULT_KEYED_TERMINAL_RETENTION_MS)
    );
    const currentTime = Date.parse(String(now() || ""));
    const cutoff = new Date((Number.isFinite(currentTime) ? currentTime : Date.now()) - retentionMs).toISOString();
    const compactedReceipts = db.prepare(`
      UPDATE ${OPERATION_TABLE}
      SET result_json = ''
      WHERE terminal_status IN ('completed', 'rolled_back')
        AND finished_at <> ''
        AND finished_at < ?
        AND result_json <> ''
        AND NOT EXISTS (
          SELECT 1 FROM short_video_delete_jobs job
          WHERE job.id = ${OPERATION_TABLE}.operation_id
        )
    `).run(cutoff);
    return removed + Number(compactedReceipts.changes || 0);
  }

  function readJob(db, jobId) {
    return db.prepare("SELECT * FROM short_video_delete_jobs WHERE id = ?").get(String(jobId || "")) || null;
  }

  function readOperation(db, operationId) {
    return db.prepare(`SELECT * FROM ${OPERATION_TABLE} WHERE operation_id = ?`)
      .get(String(operationId || "")) || null;
  }

  function readOperationReplayState(db, operationId) {
    const row = db.prepare(`
      SELECT
        operation.operation_id AS replay_operation_id,
        operation.request_sha256 AS replay_request_sha256,
        operation.terminal_status AS replay_terminal_status,
        operation.result_json AS replay_result_json,
        operation.created_at AS replay_created_at,
        operation.finished_at AS replay_finished_at,
        job.*
      FROM (SELECT ? AS lookup_id) lookup
      LEFT JOIN ${OPERATION_TABLE} operation
        ON operation.operation_id = lookup.lookup_id
      LEFT JOIN short_video_delete_jobs job
        ON job.id = lookup.lookup_id
    `).get(String(operationId || ""));
    const operation = row?.replay_operation_id
      ? {
          operation_id: row.replay_operation_id,
          request_sha256: row.replay_request_sha256,
          terminal_status: row.replay_terminal_status,
          result_json: row.replay_result_json,
          created_at: row.replay_created_at,
          finished_at: row.replay_finished_at
        }
      : null;
    const job = row?.id ? row : null;
    return { operation, job };
  }

  function requireOwnedJob(db, jobId) {
    const job = readJob(db, jobId);
    const executionToken = activeExecutionTokenFor(jobId);
    if (!job
      || job.owner_id !== ownerId
      || !executionToken
      || String(job.execution_token || "") !== executionToken
      || !ACTIVE_STATUSES.includes(job.status)) {
      throw codedError("删除作业 lease 已丢失", "SHORT_VIDEO_DELETE_LEASE_LOST");
    }
    return job;
  }

  function readItems(db, jobId) {
    return db.prepare("SELECT * FROM short_video_delete_items WHERE job_id = ? ORDER BY ordinal").all(jobId);
  }

  function readItem(db, jobId, ordinal) {
    return db.prepare(`
      SELECT * FROM short_video_delete_items WHERE job_id = ? AND ordinal = ?
    `).get(jobId, ordinal) || null;
  }

  function rowsForIds(db, ids) {
    const placeholders = ids.map(() => "?").join(", ");
    return new Map(db.prepare(`SELECT * FROM short_videos WHERE id IN (${placeholders})`).all(...ids)
      .map((row) => [String(row.id), row]));
  }

  function videoIds(job) {
    const parsed = parseJson(job?.video_ids_json, []);
    return Array.isArray(parsed) ? parsed.map((id) => String(id || "")).filter(Boolean) : [];
  }

  function leaseUntil() {
    return new Date(Date.now() + Math.max(5_000, Number(leaseDurationMs || 30_000))).toISOString();
  }

  function leaseActive(value) {
    const expiresAt = Date.parse(String(value || ""));
    return Number.isFinite(expiresAt) && expiresAt > Date.now();
  }

  function ownerStillExclusive(value, leaseValue) {
    const previousOwner = String(value || "");
    if (!previousOwner) return false;
    const pid = ownerProcessId(previousOwner);
    if (!pid) return leaseActive(leaseValue);
    // A different worker_thread has the same PID. A matching durable execution
    // token is the only proof that the caller owns that work; process liveness
    // must otherwise keep the fence closed even when the timestamp is stale.
    if (pid === process.pid) return true;
    return ownerProcessAlive(previousOwner);
  }

  function requiresManualIntervention(code) {
    const value = String(code || "");
    // Recovery classifications are fail-closed: new or unknown filesystem
    // integrity failures are manual until they are explicitly audited as a
    // safe automatic retry.
    return Boolean(value) && !AUTOMATIC_RECOVERY_CODES.has(value);
  }

  function durableExecutionStillExclusive(previousOwner, previousLease, previousExecutionToken) {
    if (previousExecutionToken) {
      // A durable execution token is a fence, not a lease hint. It may only be
      // displaced when its standard PID owner is provably dead; unknown owner
      // formats and missing owners remain fail-closed.
      const pid = ownerProcessId(previousOwner);
      if (!pid) return true;
      return ownerProcessAlive(previousOwner);
    }
    if (!previousOwner) return false;
    return ownerStillExclusive(previousOwner, previousLease);
  }

  function ownerProcessAlive(value) {
    const pid = ownerProcessId(value);
    if (!pid) return String(value || "") !== "";
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  function quarantineFilePath(root, jobId, token, ordinal, originalPath) {
    const digest = crypto.createHash("sha256").update(pathKey(originalPath)).digest("hex").slice(0, 16);
    const jobDir = path.join(root, SHORT_VIDEO_DELETE_QUARANTINE_DIR, `${jobId}-${token.slice(0, 16)}`);
    return path.join(jobDir, `${String(ordinal).padStart(6, "0")}-${digest}.quarantine`);
  }

  function guardTempPath(jobDir, job, ordinal) {
    const token = String(job?.quarantine_token || "").slice(0, 16);
    return path.join(jobDir, `.guard-${String(ordinal).padStart(6, "0")}-${token}.prepared`);
  }

  function lstatIfPresent(targetPath) {
    try {
      return fsOps.lstatSync(targetPath, { bigint: true });
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  function assertPathMissing(targetPath, message) {
    if (lstatIfPresent(targetPath)) throw codedError(message, "SHORT_VIDEO_DELETE_PATH_OCCUPIED");
  }

  function realpath(value) {
    const operation = fsOps.realpathSyncNative || fsOps.realpathSync?.native || fs.realpathSync.native;
    return path.resolve(operation(value));
  }

  async function invokeHook(hook, payload) {
    if (typeof hook !== "function") return;
    await hook(payload);
  }

  function ownerProcessId(value) {
    const match = /^short-video-delete-owner-(\d+)-/.exec(String(value || ""));
    if (!match) return 0;
    const pid = Number(match[1]);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  }

  function newExecutionToken() {
    return crypto.randomBytes(24).toString("hex");
  }

  function beginExecution(jobId, executionToken = newExecutionToken()) {
    const key = String(jobId || "");
    if (activeExecutions.has(key)) {
      throw codedError("删除作业已有活动执行", "SHORT_VIDEO_DELETE_EXECUTION_ACTIVE");
    }
    activeExecutions.set(key, executionToken);
    return executionToken;
  }

  function transferExecution(previousJobId, jobId, executionToken) {
    const previousKey = String(previousJobId || "");
    const key = String(jobId || "");
    if (activeExecutions.get(previousKey) !== executionToken || activeExecutions.has(key)) {
      throw codedError("删除作业执行 token 转换失败", "SHORT_VIDEO_DELETE_EXECUTION_ACTIVE");
    }
    activeExecutions.delete(previousKey);
    activeExecutions.set(key, executionToken);
  }

  function endExecution(db, jobId, executionToken) {
    const key = String(jobId || "");
    if (activeExecutions.get(key) !== executionToken) return;
    try {
      if (!db || key.startsWith("preflight:")) return;
      const released = db.prepare(`
        UPDATE short_video_delete_jobs
        SET owner_id = '', lease_until = '', execution_token = '', updated_at = ?, version = version + 1
        WHERE id = ? AND owner_id = ? AND execution_token = ?
          AND status IN ('running', 'rollback_pending', 'cleanup_pending')
      `).run(now(), key, ownerId, executionToken);
      if (Number(released.changes || 0) === 1) {
        relinquishableExecutions.delete(key);
      } else {
        const current = readJob(db, key);
        if (current
          && ACTIVE_STATUSES.includes(String(current.status || ""))
          && current.owner_id === ownerId
          && String(current.execution_token || "") === executionToken) {
          relinquishableExecutions.set(key, executionToken);
        }
      }
    } catch (error) {
      relinquishableExecutions.set(key, executionToken);
      warn?.("[short-video-delete-execution-release]", error);
    } finally {
      activeExecutions.delete(key);
      resolveExecutionDrainIfReady();
    }
  }

  function resolveExecutionDrainIfReady() {
    if (activeExecutions.size || !resolveCloseDrain) return;
    const resolve = resolveCloseDrain;
    resolveCloseDrain = null;
    closeDrainPromise = null;
    resolve();
  }

  function activeExecutionTokenFor(jobId) {
    return activeExecutions.get(String(jobId || "")) || "";
  }

  function requireActiveExecutionToken(jobId) {
    const token = activeExecutionTokenFor(jobId);
    if (!token) throw codedError("删除作业执行 token 已丢失", "SHORT_VIDEO_DELETE_LEASE_LOST");
    return token;
  }

  return {
    assertPathWritesAllowed,
    beginClose,
    close,
    execute,
    executeLogical,
    initialize,
    lookupOperation,
    recoverPending,
    status
  };
}

function plannedItem(
  ordinal,
  originalPath,
  pathKeyValue,
  relativePath,
  disposition,
  reason,
  managedRoot = "",
  quarantinePath = "",
  sourceIdentity = null,
  realPathKey = "",
  identityKey = ""
) {
  return {
    ordinal,
    originalPath,
    pathKey: pathKeyValue,
    realPathKey,
    identityKey,
    relativePath,
    disposition,
    reason,
    managedRoot,
    quarantinePath,
    sourceIdentity
  };
}

function physicalIdentityKey(identity) {
  const dev = String(identity?.dev || "");
  const ino = String(identity?.ino || "");
  return dev && ino ? `${dev}:${ino}` : "";
}

function referenceLookupKey(kind, value) {
  return `${String(kind || "")}\0${String(value || "")}`;
}

function normalizeRoots(values) {
  const roots = [];
  const seen = new Set();
  for (const value of values || []) {
    const resolved = path.resolve(String(value || "").trim());
    const key = pathKey(resolved);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    roots.push(resolved);
  }
  return roots.sort((left, right) => right.length - left.length);
}

function managedRootFor(filePath, roots) {
  const resolved = path.resolve(filePath);
  return roots.find((root) => isInside(resolved, root) && !samePath(resolved, root)) || "";
}

function isInside(filePath, rootPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(filePath));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right);
}

function pathKey(value) {
  const normalized = path.resolve(String(value || "")).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function uniqueStrings(values, maxItems) {
  const result = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function ensureColumn(db, table, column, definition) {
  const hasColumn = () => schemaHasColumn(db, table, column);
  if (hasColumn()) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    if (!hasColumn()) throw error;
  }
}

function schemaHasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
}

function beginImmediate(db) {
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    if (isSqliteBusy(error)) throw statusError("短视频数据库正忙，请稍后重试", 503, "SHORT_VIDEO_DELETE_BUSY", true);
    throw error;
  }
}

function rollback(db) {
  try {
    if (db.isTransaction) db.exec("ROLLBACK");
  } catch {}
}

function isSqliteBusy(error) {
  return Number(error?.errcode) === 5
    || Number(error?.errno) === 5
    || String(error?.code || "").toUpperCase() === "SQLITE_BUSY"
    || /database is locked|database table is locked|SQLITE_BUSY/i.test(String(error?.message || error));
}

function isReservationConflict(error) {
  return String(error?.code || "") === "SHORT_VIDEO_DELETE_CONFLICT"
    || /short video delete reservation conflict|idx_short_video_delete_reservation_active/i.test(String(error?.message || error));
}

function isCoverReceiptConflict(error) {
  return String(error?.code || "") === "SHORT_VIDEO_DELETE_COVER_RECEIPT_CONFLICT";
}

function isMissing(error) {
  return ["ENOENT", "ENOTDIR"].includes(String(error?.code || "").toUpperCase());
}

function isInvalidPath(error) {
  return ["ERR_INVALID_ARG_VALUE", "EINVAL"].includes(String(error?.code || "").toUpperCase());
}

function isNonEmpty(error) {
  return ["ENOTEMPTY", "EEXIST"].includes(String(error?.code || "").toUpperCase());
}

function codedError(message, code, causeMessage = "") {
  const error = new Error(causeMessage ? `${message}: ${causeMessage}` : message);
  error.code = code;
  return error;
}

function statusError(message, statusCode, code, retryable = false) {
  const error = codedError(message, code);
  error.statusCode = statusCode;
  error.retryable = retryable;
  if (statusCode < 500) error.expose = true;
  return error;
}

function operationError(cause, fallback) {
  if (cause?.statusCode) return cause;
  const error = new Error(fallback, { cause });
  error.code = String(cause?.code || "SHORT_VIDEO_DELETE_FAILED");
  error.statusCode = isSqliteBusy(cause) ? 503 : 500;
  error.retryable = error.statusCode === 503;
  return error;
}
