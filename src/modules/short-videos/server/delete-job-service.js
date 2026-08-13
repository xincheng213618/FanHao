import crypto from "node:crypto";
import fs from "node:fs";
import { open as openFile } from "node:fs/promises";
import path from "node:path";

export const SHORT_VIDEO_DELETE_QUARANTINE_DIR = ".fanhao-short-video-delete-quarantine";

const ACTIVE_STATUSES = ["running", "rollback_pending", "cleanup_pending"];
const TERMINAL_STATUSES = ["completed", "rolled_back"];
const OWNER_MARKER = ".owner";
const GUARD_PREFIX = "FANHAO_SHORT_VIDEO_DELETE_GUARD";
const ACTIVE_OWNER_IDS = new Set();
const ACTIVE_JOB_EXECUTIONS = new Map();
const PATH_REFERENCE_TABLE = "short_video_path_references";
const PATH_TOMBSTONE_TABLE = "short_video_path_tombstones";
const VIDEO_TOMBSTONE_TABLE = "short_video_delete_video_tombstones";
const PATH_COLUMNS = ["source_path", "cover_path", "music_path", "data_path"];
const DELETE_PROTOCOL_VERSION_META = "short_video_delete_protocol_version";
const DELETE_PROTOCOL_VERSION = "4";
const GUARD_PUBLISH_HARDLINK = "hardlink";
const GUARD_PUBLISH_EXCLUSIVE_CREATE = "exclusive_create";
const GUARD_PUBLISH_MODES = new Set([GUARD_PUBLISH_HARDLINK, GUARD_PUBLISH_EXCLUSIVE_CREATE]);
const DELETE_PROTOCOL_TABLES = [
  "short_video_delete_jobs",
  "short_video_delete_items",
  "short_video_delete_reservations",
  PATH_REFERENCE_TABLE,
  PATH_TOMBSTONE_TABLE,
  VIDEO_TOMBSTONE_TABLE
];

export function createShortVideoDeleteJobService({
  database,
  roots = [],
  coverCacheDir = "",
  deleteRows,
  deleteStoredCovers,
  displayPath = (value) => value,
  fsOps = fs,
  hooks = {},
  leaseDurationMs = 30_000,
  now = () => new Date().toISOString(),
  ownerId: configuredOwnerId = "",
  removeEmptyParents = () => [],
  terminalJobLimit = 200,
  warn = console.warn
} = {}) {
  if (typeof database !== "function") throw new Error("short video delete database is required");
  if (typeof deleteRows !== "function") throw new Error("short video delete row callback is required");
  const managedRoots = normalizeRoots([...roots, coverCacheDir].filter(Boolean));
  const configuredOwner = String(configuredOwnerId || "");
  let ownerId = configuredOwner || newOwnerId();
  const rootGroupCache = new Map();
  const referenceSnapshotsByJob = new Map();
  let recovering = false;
  let closed = false;
  ACTIVE_OWNER_IDS.add(ownerId);

  function newOwnerId() {
    return `short-video-delete-owner-${process.pid}-${crypto.randomUUID()}`;
  }

  function reopen() {
    if (!closed) return;
    ownerId = configuredOwner || newOwnerId();
    closed = false;
    ACTIVE_OWNER_IDS.add(ownerId);
  }

  function assertOpen() {
    if (closed) {
      throw codedError("短视频删除服务已关闭，必须创建新实例", "SHORT_VIDEO_DELETE_SERVICE_CLOSED");
    }
  }

  function initialize(db = database()) {
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
    return required.every(([type, name]) => existing.has(`${type}\0${name}`));
  }

  function ensureSchema(db = database()) {
    if (protocolSchemaCurrent(db)) return false;
    beginImmediate(db);
    try {
      if (protocolSchemaCurrent(db)) {
        db.exec("COMMIT");
        return false;
      }
      installProtocolSchemaInTransaction(db);
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
        quarantine_token TEXT NOT NULL,
        owner_id TEXT NOT NULL DEFAULT '',
        lease_until TEXT NOT NULL DEFAULT '',
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
    ensureColumn(db, "short_video_delete_items", "real_path_key", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "short_video_delete_items", "identity_key", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "short_video_delete_items", "guard_publish_mode", "TEXT NOT NULL DEFAULT ''");
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

  async function buildReferenceSnapshot(db, hookContext = null) {
    assertOpen();
    const jobKey = String(hookContext?.jobId || "");
    // The plan snapshot may be reused for the logical DB commit because all
    // selected files are already isolated and the full owner tuple CAS below
    // fences DB writers. Cleanup deliberately rebuilds the physical graph: it
    // is the last check before unlink and must see filesystem-only retargets.
    const hasPreviousSnapshot = hookContext?.phase === "commit"
      && Boolean(jobKey)
      && referenceSnapshotsByJob.has(jobKey);
    const previousRows = hasPreviousSnapshot ? referenceSnapshotsByJob.get(jobKey) : [];
    const expected = new Map();
    const remember = (ownerTable, ownerKey, ownerVideoId, pathColumn, rawPath) => {
      const text = String(rawPath || "").trim();
      if (!text) return;
      expected.set(`${ownerTable}\0${ownerKey}\0${pathColumn}`, {
        ownerTable,
        ownerKey: String(ownerKey),
        ownerVideoId: String(ownerVideoId),
        pathColumn,
        rawPath: text,
        pathKey: pathKey(text)
      });
    };
    if (hasPreviousSnapshot) {
      for (const row of previousRows) {
        remember(row.ownerTable, row.ownerKey, row.ownerVideoId, row.pathColumn, row.rawPath);
      }
    } else {
      for (const row of db.prepare(`
        SELECT owner_table, owner_key, owner_video_id, path_column, raw_path
        FROM ${PATH_REFERENCE_TABLE}
      `).all()) {
        remember(row.owner_table, row.owner_key, row.owner_video_id, row.path_column, row.raw_path);
      }
    }

    // The hook deliberately runs after the lexical owner snapshot but before the
    // one physical probe pass. The following write transaction compares the full
    // owner tuple set, so DB writers cannot invalidate this candidate unnoticed;
    // topology changes made by the test hook are included in the physical graph.
    if (hookContext) await invokeHook(hooks.afterReferenceSnapshot, hookContext);

    const previous = new Map(previousRows.map((row) => [referenceOwnerKey(row), row]));
    const targetKeys = hookContext?.jobId ? referenceTargetKeys(db, hookContext.jobId) : null;
    const probeCache = createReferenceProbeCache();
    const snapshots = [];
    for (const item of expected.values()) {
      const prior = previous.get(referenceOwnerKey(item));
      if (canReuseReferenceProbe(item, prior, targetKeys)) {
        snapshots.push({ ...item, ...referenceProbeEvidence(prior) });
      } else {
        snapshots.push({ ...item, ...probeReferencePath(item.rawPath, probeCache) });
      }
    }
    return snapshots;
  }

  function referenceOwnerKey(row) {
    return `${row.ownerTable ?? row.owner_table}\0${row.ownerKey ?? row.owner_key}\0${row.pathColumn ?? row.path_column}`;
  }

  function referenceProbeEvidence(row) {
    return {
      realPathKey: String(row?.realPathKey ?? row?.real_path_key ?? ""),
      identityKey: String(row?.identityKey ?? row?.identity_key ?? ""),
      rootGroupKey: String(row?.rootGroupKey ?? row?.root_group_key ?? ""),
      probeState: String(row?.probeState ?? row?.probe_state ?? "unverified"),
      aliasRisk: Boolean(row?.aliasRisk),
      nlink: String(row?.nlink || "")
    };
  }

  function referenceTargetKeys(db, jobId) {
    const keys = new Set();
    for (const item of readItems(db, jobId)) {
      for (const [kind, value] of [
        ["path", item.path_key],
        ["real", item.real_path_key],
        ["identity", item.identity_key]
      ]) {
        if (value) keys.add(referenceLookupKey(kind, value));
      }
    }
    return keys;
  }

  function canReuseReferenceProbe(item, prior, targetKeys) {
    if (!prior || !targetKeys) return false;
    if (String(prior.ownerVideoId ?? prior.owner_video_id ?? "") !== item.ownerVideoId
      || String(prior.rawPath ?? prior.raw_path ?? "") !== item.rawPath
      || String(prior.pathKey ?? prior.path_key ?? "") !== item.pathKey) {
      return false;
    }
    const evidence = referenceProbeEvidence(prior);
    if (evidence.probeState === "missing") return true;
    if (evidence.probeState !== "ready" || evidence.aliasRisk || Number(evidence.nlink || 0) > 1) return false;
    return ![
      referenceLookupKey("path", item.pathKey),
      referenceLookupKey("real", evidence.realPathKey),
      referenceLookupKey("identity", evidence.identityKey)
    ].some((key) => targetKeys.has(key));
  }

  function commitReferenceSnapshot(db, snapshots) {
    beginImmediate(db);
    try {
      const references = commitReferenceSnapshotInTransaction(db, snapshots);
      db.exec("COMMIT");
      return references;
    } catch (error) {
      rollback(db);
      throw error;
    }
  }

  function commitReferenceSnapshotInTransaction(db, snapshots) {
    if (!db?.isTransaction) {
      throw codedError("物理引用刷新必须持有数据库写事务", "SHORT_VIDEO_DELETE_REFERENCE_NOT_FENCED");
    }
    const currentKeys = new Set();
    for (const row of db.prepare(`SELECT id, ${PATH_COLUMNS.join(", ")} FROM short_videos`).all()) {
      for (const column of PATH_COLUMNS) {
        const rawPath = String(row[column] || "").trim();
        if (rawPath) currentKeys.add(`short_videos\0${row.id}\0${row.id}\0${column}\0${rawPath}`);
      }
    }
    for (const row of db.prepare("SELECT id, video_id, local_path FROM short_video_assets").all()) {
      const rawPath = String(row.local_path || "").trim();
      if (rawPath) currentKeys.add(`short_video_assets\0${row.id}\0${row.video_id}\0local_path\0${rawPath}`);
    }
    const snapshotKeys = new Set();
    for (const snapshot of snapshots || []) {
      const key = `${snapshot.ownerTable}\0${snapshot.ownerKey}\0${snapshot.ownerVideoId}\0${snapshot.pathColumn}\0${snapshot.rawPath}`;
      if (snapshotKeys.has(key)) {
        throw codedError("物理引用快照包含重复 owner", "SHORT_VIDEO_DELETE_REFERENCE_CHANGED");
      }
      snapshotKeys.add(key);
    }
    if (
      currentKeys.size !== snapshotKeys.size
      || [...currentKeys].some((key) => !snapshotKeys.has(key))
      || [...snapshotKeys].some((key) => !currentKeys.has(key))
    ) {
      throw codedError("短视频路径引用在物理探测期间发生变化", "SHORT_VIDEO_DELETE_REFERENCE_CHANGED");
    }
    const upsert = db.prepare(`
        INSERT INTO ${PATH_REFERENCE_TABLE} (
          owner_table, owner_key, owner_video_id, path_column, raw_path, path_key,
          real_path_key, identity_key, root_group_key, probe_state, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_table, owner_key, path_column) DO UPDATE SET
          owner_video_id = excluded.owner_video_id,
          raw_path = excluded.raw_path,
          path_key = excluded.path_key,
          real_path_key = excluded.real_path_key,
          identity_key = excluded.identity_key,
          root_group_key = excluded.root_group_key,
          probe_state = excluded.probe_state,
          updated_at = excluded.updated_at
    `);
    for (const snapshot of snapshots || []) {
      upsert.run(
        snapshot.ownerTable,
        snapshot.ownerKey,
        snapshot.ownerVideoId,
        snapshot.pathColumn,
        snapshot.rawPath,
        snapshot.pathKey,
        snapshot.realPathKey || "",
        snapshot.identityKey || "",
        snapshot.rootGroupKey || "",
        snapshot.probeState || "missing",
        now()
      );
    }
    // The durable table intentionally stores only the canonical lookup keys.
    // Keep the just-probed topology evidence (aliasRisk/nlink) for this stage's
    // decision; the complete owner-tuple CAS above proves it describes the
    // same base rows as the trigger-maintained projection.
    return referencesFromRows(snapshots || []);
  }

  async function synchronizeReferenceIndex(db) {
    return commitReferenceSnapshot(db, await buildReferenceSnapshot(db));
  }

  async function execute(rows, options = {}) {
    assertOpen();
    const db = database();
    const referenceSnapshot = await buildReferenceSnapshot(db, { phase: "plan" });
    const job = await persistPlan(db, rows, options, referenceSnapshot);
    const executionToken = beginExecution(job.id);
    referenceSnapshotsByJob.set(job.id, referenceSnapshot);
    try {
      try {
        await invokeHook(hooks.afterPlanPersisted, publicHookJob(job));
        await isolatePlannedFiles(db, job.id);
        await invokeHook(hooks.afterAllIsolated, publicHookJob(readJob(db, job.id)));
        await commitRows(db, job.id);
        await invokeHook(hooks.afterDatabaseCommit, publicHookJob(readJob(db, job.id)));
      } catch (error) {
        referenceSnapshotsByJob.delete(job.id);
        const current = readJob(db, job.id);
        if (!current) throw error;
        if (databaseDisposition(db, current) === "committed") {
          rememberPending(db, current.id, "cleanup_pending", "cleanup", error);
          warn?.("[short-video-delete-cleanup-pending]", error);
          return executionResult(db, current.id);
        }
        rememberPending(db, current.id, "rollback_pending", "rollback", error);
        try {
          const recovered = await recoverOne(db, current.id, executionToken);
          if (recovered?.status === "rolled_back") throw pendingOperationError(db, current.id, error, "删除本地文件失败");
        } catch (recoveryError) {
          if (recoveryError?.cause === error) throw recoveryError;
          rememberPending(db, current.id, "rollback_pending", "rollback", recoveryError);
          throw pendingOperationError(db, current.id, recoveryError, "短视频删除已安全隔离，等待恢复后重试");
        }
        throw pendingOperationError(db, current.id, error, "短视频删除已安全隔离，等待恢复后重试");
      }

      try {
        await cleanupCommitted(db, job.id, { executionToken });
      } catch (error) {
        rememberPending(db, job.id, "cleanup_pending", "cleanup", error);
        warn?.("[short-video-delete-cleanup-pending]", error);
      }
      return executionResult(db, job.id);
    } finally {
      endExecution(job.id, executionToken);
    }
  }

  async function persistPlan(db, inputRows, options, referenceSnapshot = null) {
    const requestedIds = uniqueStrings((inputRows || []).map((row) => row?.id), 10_000);
    if (!requestedIds.length) throw statusError("没有可删除的短视频记录", 404, "SHORT_VIDEO_DELETE_EMPTY");
    const jobId = `sv-delete-${crypto.randomUUID()}`;
    const token = crypto.randomBytes(24).toString("hex");
    const timestamp = now();
    const preRowsById = rowsForIds(db, requestedIds);
    if (preRowsById.size !== requestedIds.length) {
      throw statusError("短视频记录在删除计划创建前已发生变化", 409, "SHORT_VIDEO_DELETE_CHANGED");
    }
    const preRows = requestedIds.map((id) => preRowsById.get(id));
    const preReferences = referencesFromRows(referenceSnapshot || []);
    const items = await planItems(db, jobId, token, preRows, preReferences);
    beginImmediate(db);
    try {
      const rowsById = rowsForIds(db, requestedIds);
      if (rowsById.size !== requestedIds.length || !rowsSnapshotMatches(preRows, requestedIds.map((id) => rowsById.get(id)))) {
        throw statusError("短视频记录在删除计划创建前已发生变化", 409, "SHORT_VIDEO_DELETE_CHANGED");
      }
      const rows = requestedIds.map((id) => rowsById.get(id));
      const references = commitReferenceSnapshotInTransaction(db, referenceSnapshot || []);
      assertPlannedReferences(items, rows, references);
      assertNoReservationConflicts(db, requestedIds, items);
      const firstRow = rows[0];
      db.prepare(`
        INSERT INTO short_video_delete_jobs (
          id, status, phase, scope, anchor_id, title, group_dir, video_ids_json,
          result_json, quarantine_token, owner_id, lease_until, version, attempts,
          error, error_code, created_at, updated_at, finished_at
        ) VALUES (?, 'running', 'planned', ?, ?, ?, ?, ?, '', ?, ?, ?, 1, 1, '', '', ?, ?, '')
      `).run(
        jobId,
        String(options.scope || "single"),
        String(firstRow.id || ""),
        String(firstRow.title || firstRow.description || firstRow.file_name || ""),
        String(options.groupDir || ""),
        JSON.stringify(requestedIds),
        token,
        ownerId,
        leaseUntil(),
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
      return readJob(db, jobId);
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
      const sourceIdentity = await captureManagedFileIdentityAsync(originalPath, managedRoot, entry);
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
    for (const planned of readItems(db, jobId)) {
      if (planned.disposition !== "delete" || planned.state === "isolated") continue;
      const item = readItem(db, jobId, planned.ordinal);
      if (!item || !["planned", "isolating"].includes(item.state)) {
        throw codedError("隔离文件计划状态已变化", "SHORT_VIDEO_DELETE_ITEM_CHANGED");
      }
      const expected = parseJson(item.source_identity_json, null);
      const current = await requireManagedFileIdentityAsync(
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
              WHERE job.id = short_video_delete_items.job_id AND job.owner_id = ?
            )
        `).run(now(), jobId, item.ordinal, ownerId);
        if (Number(intent.changes || 0) !== 1) {
          throw codedError("隔离文件 intent CAS 失败", "SHORT_VIDEO_DELETE_LEASE_LOST");
        }
        db.exec("COMMIT");
      } catch (error) {
        rollback(db);
        throw error;
      }

      fsOps.renameSync(item.original_path, item.quarantine_path);
      const isolated = await requireManagedFileIdentityAsync(
        item.quarantine_path,
        item.managed_root,
        expected,
        "隔离文件身份已变化",
        { transitionAfterRename: true }
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
              WHERE job.id = short_video_delete_items.job_id AND job.owner_id = ?
            )
        `).run(JSON.stringify(isolated), JSON.stringify(guardIdentity), now(), jobId, item.ordinal, ownerId);
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
    const ids = videoIds(job);
    await invokeHook(hooks.beforeDatabaseCommit, publicHookJob(job));
    const preparedItems = new Map();
    for (const item of readItems(db, jobId)) {
      preparedItems.set(item.ordinal, await assertItemReadyForCommit(item, job));
    }
    let referenceSnapshot;
    try {
      referenceSnapshot = await buildReferenceSnapshot(db, { phase: "commit", jobId });
    } finally {
      referenceSnapshotsByJob.delete(jobId);
    }
    beginImmediate(db);
    try {
      const current = readJob(db, jobId);
      if (!current || current.owner_id !== ownerId) throw codedError("删除作业 lease 已丢失", "SHORT_VIDEO_DELETE_LEASE_LOST");
      const rows = rowsForIds(db, ids);
      if (rows.size !== ids.length) throw codedError("短视频记录在提交前已发生变化", "SHORT_VIDEO_DELETE_CHANGED");
      const references = commitReferenceSnapshotInTransaction(db, referenceSnapshot);
      assertNoLateReferences(db, current, references);
      const currentItems = readItems(db, jobId);
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
      db.prepare(`
        UPDATE short_video_delete_jobs
        SET status = 'cleanup_pending', phase = 'db_committed', result_json = ?,
            error = '', error_code = '', updated_at = ?, version = version + 1
        WHERE id = ? AND owner_id = ?
      `).run(JSON.stringify(result), now(), jobId, ownerId);
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
    if (databaseDisposition(db, job) !== "committed") {
      throw codedError("数据库删除尚未提交，拒绝清理隔离文件", "SHORT_VIDEO_DELETE_DIRECTION_MISMATCH");
    }
    updateJob(db, jobId, { status: "cleanup_pending", phase: "cleanup", error: "", errorCode: "" });
    let result = buildResult(db, jobId);
    let coverCleanupError = "";
    const currentJob = readJob(db, jobId);
    if (!Number(currentJob.cover_cleanup_done || 0)) {
      try {
        result.deletedStoredCovers = Number(deleteStoredCovers?.(videoIds(job)) || 0);
      } catch (error) {
        coverCleanupError = String(error?.message || error);
        result.coverCleanupError = coverCleanupError;
      }
      if (coverCleanupError) {
        db.prepare("UPDATE short_video_delete_jobs SET result_json = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(result), now(), jobId);
        throw codedError("短视频封面清理等待重试", "SHORT_VIDEO_DELETE_COVER_CLEANUP_PENDING", coverCleanupError);
      }
      db.prepare(`
        UPDATE short_video_delete_jobs
        SET cover_cleanup_done = 1, deleted_stored_covers = ?, result_json = ?, updated_at = ?
        WHERE id = ? AND owner_id = ?
      `).run(result.deletedStoredCovers, JSON.stringify(result), now(), jobId, ownerId);
    } else {
      result.deletedStoredCovers = Number(currentJob.deleted_stored_covers || 0);
    }

    const referenceSnapshot = await buildReferenceSnapshot(db, { phase: "cleanup", jobId });
    beginImmediate(db);
    try {
      const current = requireOwnedJob(db, jobId);
      if (databaseDisposition(db, current) !== "committed") {
        throw codedError("数据库删除尚未提交，拒绝清理隔离文件", "SHORT_VIDEO_DELETE_DIRECTION_MISMATCH");
      }
      const references = commitReferenceSnapshotInTransaction(db, referenceSnapshot);
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
      const candidate = await inspectCleanupCandidate(requireOwnedJob(db, jobId), planned);
      beginImmediate(db);
      try {
        heartbeat(db, jobId);
        requireOwnedJob(db, jobId);
        assertCleanupCandidateCheap(requireOwnedJob(db, jobId), planned, candidate);
        const intent = db.prepare(`
          UPDATE short_video_delete_items
          SET state = 'cleaning', error = '', updated_at = ?
          WHERE job_id = ? AND ordinal = ? AND state IN ('isolated', 'cleaning')
            AND EXISTS (
              SELECT 1 FROM short_video_delete_jobs job
              WHERE job.id = short_video_delete_items.job_id AND job.owner_id = ?
            )
        `).run(now(), jobId, planned.ordinal, ownerId);
        if (Number(intent.changes || 0) !== 1) throw codedError("隔离文件清理 intent CAS 失败", "SHORT_VIDEO_DELETE_LEASE_LOST");
        db.exec("COMMIT");
      } catch (error) {
        rollback(db);
        throw error;
      }

      await cleanupIsolatedItem(requireOwnedJob(db, jobId), { ...planned, state: "cleaning" }, candidate);

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
              WHERE job.id = short_video_delete_items.job_id AND job.owner_id = ?
            )
        `).run(now(), jobId, planned.ordinal, ownerId);
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
    finalizeOwnedDirectories(requireOwnedJob(db, jobId), finalItems);
    finishJob(db, jobId, "completed", result);
    pruneTerminalJobs(db);
    return readJob(db, jobId);
  }

  async function rollbackUncommitted(db, jobId, options = {}) {
    const job = options.claimedJob || claim(db, jobId, options.executionToken);
    if (!job) return readJob(db, jobId);
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
                WHERE job.id = short_video_delete_items.job_id AND job.owner_id = ?
              )
          `).run(now(), jobId, planned.ordinal, ownerId);
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
      const candidate = await inspectRestoreCandidate(requireOwnedJob(db, jobId), planned);
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
              WHERE job.id = short_video_delete_items.job_id AND job.owner_id = ?
            )
        `).run(now(), jobId, current.ordinal, ownerId);
        if (Number(intent.changes || 0) !== 1) throw codedError("源文件恢复 intent CAS 失败", "SHORT_VIDEO_DELETE_LEASE_LOST");
        db.exec("COMMIT");
      } catch (error) {
        rollback(db);
        throw error;
      }

      const restoredIdentity = await restoreIsolatedItem(requireOwnedJob(db, jobId), { ...planned, state: "restoring" }, candidate);

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
              WHERE job.id = short_video_delete_items.job_id AND job.owner_id = ?
            )
        `).run(JSON.stringify(restoredIdentity), now(), jobId, planned.ordinal, ownerId);
        if (Number(checkpoint.changes || 0) !== 1) throw codedError("源文件恢复检查点 CAS 失败", "SHORT_VIDEO_DELETE_LEASE_LOST");
        db.exec("COMMIT");
      } catch (error) {
        rollback(db);
        throw error;
      }
      await invokeHook(hooks.afterItemRestored, { jobId, ordinal: planned.ordinal });
    }
    finalizeOwnedDirectories(job, readItems(db, jobId));
    finishJob(db, jobId, "rolled_back", buildResult(db, jobId));
    pruneTerminalJobs(db);
    return readJob(db, jobId);
  }

  async function recoverPending({ db = database(), jobId = "" } = {}) {
    assertOpen();
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
        try {
          await recoverOne(db, row.id);
        } catch (error) {
          const current = readJob(db, row.id);
          if (current) {
            const disposition = databaseDisposition(db, current);
            rememberPending(
              db,
              current.id,
              disposition === "committed" ? "cleanup_pending" : "rollback_pending",
              disposition === "committed" ? "cleanup" : "rollback",
              error
            );
          }
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
      if (activeExecutionTokenFor(jobId, ownerId)) return readJob(db, jobId);
      token = beginExecution(jobId);
      ownsExecution = true;
    }
    try {
      const job = claim(db, jobId, token);
      if (!job) return readJob(db, jobId);
      const disposition = databaseDisposition(db, job);
      if (disposition === "committed") return cleanupCommitted(db, jobId, { claimedJob: job, executionToken: token });
      if (disposition === "uncommitted") return rollbackUncommitted(db, jobId, { claimedJob: job, executionToken: token });
      throw codedError("短视频记录处于部分删除状态，已停止自动文件操作", "SHORT_VIDEO_DELETE_PARTIAL_COMMIT");
    } finally {
      if (ownsExecution) endExecution(jobId, token);
    }
  }

  function status(db = database(), options = {}) {
    assertOpen();
    ensureSchema(db);
    const jobId = String(options.jobId || "").trim();
    if (jobId) {
      const row = readJob(db, jobId);
      if (!row) throw statusError("短视频删除作业不存在", 404, "SHORT_VIDEO_DELETE_JOB_NOT_FOUND");
      return { ok: true, job: publicJob(row) };
    }
    const counts = Object.fromEntries(db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM short_video_delete_jobs
      GROUP BY status
    `).all().map((row) => [row.status, Number(row.count || 0)]));
    const pending = db.prepare(`
      SELECT id, status, phase, scope, anchor_id, video_ids_json, attempts,
             owner_id, lease_until, error_code, created_at, updated_at
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
      const activeExecutionToken = activeExecutionTokenFor(jobId, previousOwner)
        || activeExecutionTokenFor(jobId, ownerId);
      if (activeExecutionToken && activeExecutionToken !== executionToken) {
        db.exec("COMMIT");
        return null;
      }
      const continuingExecution = Boolean(
        executionToken
        && activeExecutionToken === executionToken
        && (!previousOwner || previousOwner === ownerId)
      );
      if (
        previousOwner
        && !continuingExecution
        && previousOwner !== ownerId
        && ownerStillExclusive(previousOwner, previousLease)
      ) {
        db.exec("COMMIT");
        return null;
      }
      const result = db.prepare(`
        UPDATE short_video_delete_jobs
        SET owner_id = ?, lease_until = ?, attempts = attempts + 1,
            updated_at = ?, version = version + 1
        WHERE id = ? AND version = ? AND owner_id = ? AND lease_until = ?
          AND status IN ('running', 'rollback_pending', 'cleanup_pending')
      `).run(
        ownerId,
        leaseUntil(),
        now(),
        jobId,
        Number(job.version || 0),
        previousOwner,
        previousLease
      );
      if (Number(result.changes || 0) !== 1) {
        db.exec("COMMIT");
        return null;
      }
      db.exec("COMMIT");
      return readJob(db, jobId);
    } catch (error) {
      rollback(db);
      throw error;
    }
  }

  function close(db = null) {
    if (closed) return;
    closed = true;
    referenceSnapshotsByJob.clear();
    ACTIVE_OWNER_IDS.delete(ownerId);
    if (!db) return;
    try {
      db.prepare(`
        UPDATE short_video_delete_jobs
        SET owner_id = '', lease_until = '', updated_at = ?, version = version + 1
        WHERE owner_id = ? AND status IN ('running', 'rollback_pending', 'cleanup_pending')
      `).run(now(), ownerId);
    } catch (error) {
      warn?.("[short-video-delete-owner-close]", error);
    }
  }

  function heartbeat(db, jobId) {
    const result = db.prepare(`
      UPDATE short_video_delete_jobs
      SET lease_until = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND owner_id = ?
        AND status IN ('running', 'rollback_pending', 'cleanup_pending')
    `).run(leaseUntil(), now(), jobId, ownerId);
    if (Number(result.changes || 0) !== 1) {
      throw codedError("删除作业 lease 已丢失", "SHORT_VIDEO_DELETE_LEASE_LOST");
    }
  }

  function finishJob(db, jobId, terminalStatus, result) {
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
    const job = readJob(db, jobId);
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
          owner_id = '', lease_until = '', updated_at = ?, finished_at = ?, version = version + 1
      WHERE id = ? AND owner_id = ?
    `).run(
      terminalStatus,
      terminalStatus === "completed" ? "completed" : "rolled_back",
      JSON.stringify(result),
      timestamp,
      timestamp,
      jobId,
      ownerId
    );
    if (Number(update.changes || 0) !== 1) {
      throw codedError("删除作业终态 CAS 失败", "SHORT_VIDEO_DELETE_LEASE_LOST");
    }
  }

  function rememberPending(db, jobId, statusValue, phase, error) {
    const code = String(error?.code || "SHORT_VIDEO_DELETE_PENDING").slice(0, 100);
    const message = String(error?.message || error || "删除作业等待恢复").slice(0, 2000);
    try {
      const update = db.prepare(`
        UPDATE short_video_delete_jobs
        SET status = ?, phase = ?, error = ?, error_code = ?, owner_id = '', lease_until = '',
            updated_at = ?, version = version + 1
        WHERE id = ? AND owner_id = ? AND status NOT IN ('completed', 'rolled_back')
      `).run(statusValue, phase, message, code, now(), jobId, ownerId);
      if (Number(update.changes || 0) !== 1) {
        warn?.("[short-video-delete-journal-owner-lost]", jobId);
      }
    } catch (writeError) {
      warn?.("[short-video-delete-journal]", writeError);
    }
  }

  function updateJob(db, jobId, values) {
    const result = db.prepare(`
      UPDATE short_video_delete_jobs
      SET status = ?, phase = ?, error = ?, error_code = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND owner_id = ?
        AND status IN ('running', 'rollback_pending', 'cleanup_pending')
    `).run(values.status, values.phase, values.error || "", values.errorCode || "", now(), jobId, ownerId);
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
      const identity = await requireManagedFileIdentityAsync(item.quarantine_path, item.managed_root, expected, "隔离文件已被替换");
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

  async function cleanupIsolatedItem(job, item, candidate) {
    if (candidate.mode === "delete") {
      assertCleanupCandidateCheap(job, item, candidate);
      await invokeHook(hooks.beforeQuarantineCleanup, { jobId: job.id, ordinal: item.ordinal });
      fsOps.unlinkSync(item.quarantine_path);
      removeOwnedGuard(item.original_path, job, item.ordinal, item.guard_identity_json);
    } else if (candidate.mode === "guard_only") {
      removeOwnedGuard(item.original_path, job, item.ordinal, item.guard_identity_json);
    }
    removeOwnedGuardTemp(job, item);
  }

  async function inspectRestoreCandidate(job, item) {
    const sourceExpected = parseJson(item.source_identity_json, null);
    const persistedQuarantine = parseJson(item.quarantine_identity_json, null);
    const source = lstatIfPresent(item.original_path);
    const quarantine = lstatIfPresent(item.quarantine_path);
    if (quarantine) {
      const currentQuarantine = persistedQuarantine
        ? await requireManagedFileIdentityAsync(
            item.quarantine_path,
            item.managed_root,
            persistedQuarantine,
            "隔离文件已被替换",
            { rollbackOwnedQuarantine: true }
          )
        : await requireManagedFileIdentityAsync(
            item.quarantine_path,
            item.managed_root,
            sourceExpected,
            "隔离文件身份无法从源计划转换",
            { transitionAfterRename: true }
          );
      if (source && !isOwnedGuard(item.original_path, job, item.ordinal, item.guard_identity_json)) {
        throw codedError("原文件位置已被其他文件占用", "SHORT_VIDEO_DELETE_GUARD_REPLACED");
      }
      return { mode: "restore", identity: currentQuarantine, guardOwned: Boolean(source) };
    }
    if (source && isOwnedGuard(item.original_path, job, item.ordinal, item.guard_identity_json)) {
      throw codedError("隔离文件缺失，无法恢复源文件", "SHORT_VIDEO_DELETE_QUARANTINE_MISSING");
    }
    if (item.state === "planned" && source && !isOwnedGuard(item.original_path, job, item.ordinal, item.guard_identity_json)) {
      return { mode: "already_source", identity: await captureManagedFileIdentityAsync(item.original_path, item.managed_root, source) };
    }
    if (item.state === "restoring" && source && persistedQuarantine) {
      const restored = await requireManagedFileIdentityAsync(
        item.original_path,
        item.managed_root,
        persistedQuarantine,
        "恢复后的源文件身份不一致",
        { rollbackAfterRename: true }
      );
      return { mode: "already_source", identity: restored };
    }
    const restored = await requireManagedFileIdentityAsync(item.original_path, item.managed_root, sourceExpected, "源文件和隔离文件均不符合持久计划");
    return { mode: "already_source", identity: restored };
  }

  function assertRestoreCandidateCheap(job, item, candidate) {
    if (candidate.mode === "restore") {
      assertCheapManagedFileIdentity(item.quarantine_path, item.managed_root, candidate.identity, "隔离文件已被替换");
      const source = lstatIfPresent(item.original_path);
      if (source && !isOwnedGuard(item.original_path, job, item.ordinal, item.guard_identity_json)) {
        throw codedError("原文件位置已被其他文件占用", "SHORT_VIDEO_DELETE_GUARD_REPLACED");
      }
      return;
    }
    assertCheapManagedFileIdentity(item.original_path, item.managed_root, candidate.identity, "恢复后的源文件身份不一致");
  }

  async function restoreIsolatedItem(job, item, candidate) {
    if (candidate.mode === "restore") {
      if (candidate.guardOwned) moveOwnedGuardAside(item.original_path, job, item);
      else removeOwnedGuardTemp(job, item);
      assertPathMissing(item.original_path, "原文件位置已被其他文件占用");
      await invokeHook(hooks.beforeItemRestored, { jobId: job.id, ordinal: item.ordinal });
      fsOps.renameSync(item.quarantine_path, item.original_path);
      await invokeHook(hooks.afterRestoreRenamed, { jobId: job.id, ordinal: item.ordinal });
      removeOwnedGuardTemp(job, item);
      return requireManagedFileIdentityAsync(
        item.original_path,
        item.managed_root,
        candidate.identity,
        "恢复后的源文件身份不一致",
        { rollbackAfterRename: true }
      );
    }
    removeOwnedGuardTemp(job, item);
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
    const current = await requireManagedFileIdentityAsync(
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
      fsOps.unlinkSync(tempPath);
    } catch (error) {
      throw codedError("guard 临时文件清理失败", "SHORT_VIDEO_DELETE_GUARD_TEMP_CLEANUP", error?.message);
    }
    return guardIdentity;
  }

  function guardExclusiveFallbackAllowed(error) {
    return ["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(String(error?.code || "").toUpperCase());
  }

  function removeOwnedGuardTemp(job, item) {
    if (!item.quarantine_path || !item.managed_root) return;
    const jobDir = path.dirname(item.quarantine_path);
    const tempPath = guardTempPath(jobDir, job, item.ordinal);
    const entry = lstatIfPresent(tempPath);
    if (!entry) return;
    requireOwnedJobDirectory(job, jobDir, item.managed_root);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw codedError("guard 临时路径不是普通文件", "SHORT_VIDEO_DELETE_GUARD_TEMP_REPLACED");
    }
    const expected = parseJson(item.source_identity_json, null);
    if (!expected || String(entry.dev) !== String(expected.dev)) {
      throw codedError("guard 临时文件不在源文件卷", "SHORT_VIDEO_DELETE_GUARD_TEMP_REPLACED");
    }
    fsOps.unlinkSync(tempPath);
  }

  function moveOwnedGuardAside(originalPath, job, item) {
    if (!isOwnedGuard(originalPath, job, item.ordinal, item.guard_identity_json)) {
      throw codedError("原文件位置已被其他文件占用", "SHORT_VIDEO_DELETE_GUARD_REPLACED");
    }
    const jobDir = path.dirname(item.quarantine_path);
    requireOwnedJobDirectory(job, jobDir, item.managed_root);
    const tempPath = guardTempPath(jobDir, job, item.ordinal);
    const prepared = lstatIfPresent(tempPath);
    if (!prepared) {
      fsOps.renameSync(originalPath, tempPath);
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
    const publishMode = persistedOrInferredGuardPublishMode(item, sameInode);
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
    fsOps.unlinkSync(originalPath);
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

  function persistedOrInferredGuardPublishMode(item, sameInode) {
    const persisted = String(item?.guard_publish_mode || "");
    if (GUARD_PUBLISH_MODES.has(persisted)) return persisted;
    if (!persisted && sameInode) return GUARD_PUBLISH_HARDLINK;
    throw codedError("guard 发布模式缺失且无法安全推导", "SHORT_VIDEO_DELETE_GUARD_MODE_MISSING");
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

  function removeOwnedGuard(originalPath, job, ordinal, storedIdentityJson) {
    const entry = lstatIfPresent(originalPath);
    if (!entry) return;
    if (!isOwnedGuard(originalPath, job, ordinal, storedIdentityJson)) {
      throw codedError("原文件位置已被其他文件占用", "SHORT_VIDEO_DELETE_GUARD_REPLACED");
    }
    fsOps.unlinkSync(originalPath);
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

  function finalizeOwnedDirectories(job, items) {
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
        if (fsOps.readFileSync(marker, "utf8") !== `${job.id}:${job.quarantine_token}`) {
          throw codedError("隔离目录 ownership marker 不匹配", "SHORT_VIDEO_DELETE_QUARANTINE_OWNER");
        }
        fsOps.unlinkSync(marker);
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
    const handle = fsOps.openSync(filePath, "r");
    let before;
    let after;
    let contentSha256;
    try {
      before = captureIdentity(fsOps.fstatSync(handle, { bigint: true }));
      if (!matchesCheapIdentity(before, captureIdentity(lexicalEntry))) {
        throw codedError("文件路径在打开期间发生变化", "SHORT_VIDEO_DELETE_FILE_REPLACED");
      }
      contentSha256 = fullFileSha256(handle, before);
      after = captureIdentity(fsOps.fstatSync(handle, { bigint: true }));
    } finally {
      fsOps.closeSync(handle);
    }
    if (!matchesExactSnapshot(after, before)) {
      throw codedError("文件在身份采集期间发生变化", "SHORT_VIDEO_DELETE_FILE_REPLACED");
    }
    const finalEntry = fsOps.lstatSync(filePath, { bigint: true });
    if (!matchesCheapIdentity(captureIdentity(finalEntry), after)) {
      throw codedError("文件路径在身份采集后发生变化", "SHORT_VIDEO_DELETE_FILE_REPLACED");
    }
    const rootReal = realpath(root);
    const fileReal = realpath(filePath);
    if (!isInside(fileReal, rootReal) || samePath(fileReal, rootReal)) {
      throw codedError("文件通过链接逃逸受管根", "SHORT_VIDEO_DELETE_PATH_ESCAPE");
    }
    return {
      ...after,
      contentSha256,
      contentFingerprint: contentSha256,
      realPathKey: pathKey(fileReal),
      parentRealPathKey: pathKey(realpath(path.dirname(filePath))),
      rootRealPathKey: pathKey(rootReal),
      aliasRisk: pathHasAliasRisk(filePath, root, fileReal, rootReal)
    };
  }

  async function captureManagedFileIdentityAsync(filePath, root, entry = null) {
    assertManagedRoot(root);
    const lexical = path.resolve(filePath);
    if (!isInside(lexical, root) || samePath(lexical, root)) {
      throw codedError("文件路径不在受管根内", "SHORT_VIDEO_DELETE_PATH_ESCAPE");
    }
    const lexicalEntry = entry || fsOps.lstatSync(filePath, { bigint: true });
    if (!lexicalEntry.isFile() || lexicalEntry.isSymbolicLink()) {
      throw codedError("删除目标不是普通文件", "SHORT_VIDEO_DELETE_NOT_FILE");
    }
    const handle = await openFile(filePath, "r");
    let before;
    let after;
    let contentSha256;
    try {
      before = captureIdentity(await handle.stat({ bigint: true }));
      if (!matchesCheapIdentity(before, captureIdentity(lexicalEntry))) {
        throw codedError("文件路径在打开期间发生变化", "SHORT_VIDEO_DELETE_FILE_REPLACED");
      }
      contentSha256 = await fullFileSha256Async(handle, before);
      after = captureIdentity(await handle.stat({ bigint: true }));
    } finally {
      await handle.close();
    }
    if (!matchesExactSnapshot(after, before)) {
      throw codedError("文件在身份采集期间发生变化", "SHORT_VIDEO_DELETE_FILE_REPLACED");
    }
    const finalEntry = fsOps.lstatSync(filePath, { bigint: true });
    if (!matchesCheapIdentity(captureIdentity(finalEntry), after)) {
      throw codedError("文件路径在身份采集后发生变化", "SHORT_VIDEO_DELETE_FILE_REPLACED");
    }
    const rootReal = realpath(root);
    const fileReal = realpath(filePath);
    if (!isInside(fileReal, rootReal) || samePath(fileReal, rootReal)) {
      throw codedError("文件通过链接逃逸受管根", "SHORT_VIDEO_DELETE_PATH_ESCAPE");
    }
    return {
      ...after,
      contentSha256,
      contentFingerprint: contentSha256,
      realPathKey: pathKey(fileReal),
      parentRealPathKey: pathKey(realpath(path.dirname(filePath))),
      rootRealPathKey: pathKey(rootReal),
      aliasRisk: pathHasAliasRisk(filePath, root, fileReal, rootReal)
    };
  }

  async function requireManagedFileIdentityAsync(filePath, root, expected, message, options = {}) {
    const current = await captureManagedFileIdentityAsync(filePath, root);
    const matches = options.rollbackAfterRename
      ? matchesRollbackRenameTransition(current, expected)
      : options.transitionAfterRename
        ? matchesRenameTransition(current, expected)
      : options.rollbackOwnedQuarantine
        ? matchesRollbackQuarantine(current, expected)
        : matchesExactSnapshot(current, expected);
    if (!expected || !matches) throw codedError(message, "SHORT_VIDEO_DELETE_FILE_REPLACED");
    return current;
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
    const matches = options.transitionAfterRename
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
      && String(actual?.mtimeNs || "") === String(expected?.mtimeNs || "")
      && (!expected?.contentSha256
        || String(actual?.contentSha256 || "") === String(expected.contentSha256))
      && (!expected?.contentFingerprint
        || String(actual?.contentFingerprint || actual?.contentSha256 || "") === String(expected.contentFingerprint));
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
      || String(actual?.mtimeNs || "") !== String(expected?.mtimeNs || "")
      || (expected?.contentSha256
        && String(actual?.contentSha256 || "") !== String(expected.contentSha256))
      || (expected?.contentFingerprint
        && String(actual?.contentFingerprint || actual?.contentSha256 || "") !== String(expected.contentFingerprint))) return false;
    return !expected?.rootRealPathKey
      || String(actual?.rootRealPathKey || "") === String(expected.rootRealPathKey);
  }

  function matchesRollbackRenameTransition(actual, expected) {
    return String(actual?.dev || "") === String(expected?.dev || "")
      && String(actual?.ino || "") === String(expected?.ino || "")
      && (!expected?.nlink || String(actual?.nlink || "") === String(expected.nlink))
      && String(actual?.size || "") === String(expected?.size || "")
      && String(actual?.mtimeNs || "") === String(expected?.mtimeNs || "")
      && (!expected?.contentSha256
        || String(actual?.contentSha256 || "") === String(expected.contentSha256))
      && (!expected?.contentFingerprint
        || String(actual?.contentFingerprint || actual?.contentSha256 || "") === String(expected.contentFingerprint))
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

  function fullFileSha256(handle, entry) {
    const size = Number(entry?.size ?? 0);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw codedError("文件过大，无法建立安全内容指纹", "SHORT_VIDEO_DELETE_IDENTITY_UNAVAILABLE");
    }
    const hash = crypto.createHash("sha256");
    const chunkSize = 1024 * 1024;
    const buffer = Buffer.allocUnsafe(Math.min(chunkSize, Math.max(1, size)));
    let position = 0;
    while (position < size) {
      const length = Math.min(buffer.length, size - position);
      const read = fsOps.readSync(handle, buffer, 0, length, position);
      if (!read) throw codedError("文件内容在哈希采集期间被截断", "SHORT_VIDEO_DELETE_FILE_REPLACED");
      hash.update(buffer.subarray(0, read));
      position += read;
    }
    return hash.digest("hex");
  }

  async function fullFileSha256Async(handle, entry) {
    const size = Number(entry?.size ?? 0);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw codedError("文件过大，无法建立安全内容哈希", "SHORT_VIDEO_DELETE_IDENTITY_UNAVAILABLE");
    }
    const hash = crypto.createHash("sha256");
    const chunkSize = 1024 * 1024;
    const buffer = Buffer.allocUnsafe(Math.min(chunkSize, Math.max(1, size)));
    let position = 0;
    while (position < size) {
      const length = Math.min(buffer.length, size - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (!bytesRead) throw codedError("文件内容在哈希采集期间被截断", "SHORT_VIDEO_DELETE_FILE_REPLACED");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest("hex");
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

  function assertNoLateReferences(db, job, references = null) {
    const ids = new Set(videoIds(job));
    const currentReferences = references || pathReferences(db, { includePhysical: false });
    for (const item of readItems(db, job.id)) {
      if (!["delete", "missing", "alias"].includes(item.disposition)) continue;
      const keys = [
        ["path", item.path_key],
        ["real", item.real_path_key],
        ["identity", item.identity_key]
      ].filter(([, value]) => value);
      if (hasOutsideReferences(currentReferences, keys, ids, managedRootGroupKey(item.managed_root))) {
        throw codedError("隔离路径新增了其他短视频引用", "SHORT_VIDEO_DELETE_LATE_REFERENCE");
      }
    }
  }

  function pathReferences(db, { includePhysical = false } = {}) {
    if (!includePhysical) {
      return referencesFromRows(db.prepare(`SELECT * FROM ${PATH_REFERENCE_TABLE}`).all());
    }
    return referencesFromRows(buildReferenceSnapshot(db));
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

  function executionResult(db, jobId) {
    const job = readJob(db, jobId);
    if (!job) throw statusError("短视频删除作业不存在", 404, "SHORT_VIDEO_DELETE_JOB_NOT_FOUND");
    const result = { ...buildResult(db, jobId) };
    const items = readItems(db, jobId);
    const completed = job.status === "completed";
    const cleanupPending = job.status === "cleanup_pending";
    if (cleanupPending) {
      result.deletedFiles = items
        .filter((item) => item.disposition === "delete" && item.state === "cleaned")
        .map((item) => item.relative_path);
    }
    return {
      ...result,
      ok: completed || cleanupPending,
      accepted: completed || cleanupPending,
      pending: !completed,
      status: String(job.status || ""),
      jobId: String(job.id || ""),
      logicalDeleteCommitted: databaseDisposition(db, job) === "committed",
      physicalCleanupComplete: completed,
      cleanupPendingFiles: cleanupPending
        ? items.filter((item) => item.disposition === "delete" && item.state !== "cleaned").length
        : 0
    };
  }

  function pendingOperationError(db, jobId, cause, fallback) {
    const error = operationError(cause, fallback);
    const job = readJob(db, jobId);
    if (!job || !ACTIVE_STATUSES.includes(job.status)) return error;
    error.statusCode = job.status === "rollback_pending" ? 500 : Number(error.statusCode || 500);
    error.retryable = true;
    error.publicBody = {
      ok: false,
      accepted: false,
      pending: true,
      recoveryRequired: true,
      retryable: true,
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
    const blockedByActiveOwner = pending && (
      Boolean(activeExecutionTokenFor(row.id, row.owner_id) || activeExecutionTokenFor(row.id, ownerId))
      || (String(row.owner_id || "") !== ownerId && ownerStillExclusive(row.owner_id, row.lease_until))
    );
    const stalled = leaseExpired && blockedByActiveOwner;
    const requiresAttention = row.status === "rollback_pending" || stalled || Boolean(row.error_code);
    return {
      id: row.id,
      status: row.status,
      phase: row.phase,
      scope: row.scope,
      videoCount: Array.isArray(ids) ? ids.length : 0,
      attempts: Number(row.attempts || 0),
      pending,
      requiresAttention,
      stalled,
      leaseExpired,
      blockedByActiveOwner,
      recoverable: pending && !blockedByActiveOwner,
      errorCode: publicDeleteErrorCode(row.error_code),
      error: publicPendingMessage(row.error_code),
      createdAt: row.created_at,
      updatedAt: row.updated_at
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
    const stale = db.prepare(`
      SELECT id FROM short_video_delete_jobs
      WHERE status IN ('completed', 'rolled_back')
      ORDER BY finished_at DESC, id DESC
      LIMIT -1 OFFSET ?
    `).all(limit);
    if (!stale.length) return 0;
    const remove = db.prepare(`
      DELETE FROM short_video_delete_jobs
      WHERE id = ?
        AND status IN ('completed', 'rolled_back')
        AND NOT EXISTS (
          SELECT 1 FROM short_video_delete_reservations reservation
          WHERE reservation.job_id = short_video_delete_jobs.id AND reservation.released_at = ''
        )
    `);
    let removed = 0;
    for (const row of stale) removed += Number(remove.run(row.id).changes || 0);
    return removed;
  }

  function readJob(db, jobId) {
    return db.prepare("SELECT * FROM short_video_delete_jobs WHERE id = ?").get(String(jobId || "")) || null;
  }

  function requireOwnedJob(db, jobId) {
    const job = readJob(db, jobId);
    if (!job || job.owner_id !== ownerId || !ACTIVE_STATUSES.includes(job.status)) {
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
    if (ACTIVE_OWNER_IDS.has(previousOwner)) return true;
    const match = /^short-video-delete-owner-(\d+)-/.exec(previousOwner);
    if (!match) return leaseActive(leaseValue);
    const pid = Number(match[1]);
    if (pid === process.pid) return false;
    return ownerProcessAlive(previousOwner);
  }

  function ownerProcessAlive(value) {
    const match = /^short-video-delete-owner-(\d+)-/.exec(String(value || ""));
    if (!match) return String(value || "") !== "";
    const pid = Number(match[1]);
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

  function beginExecution(jobId) {
    const key = String(jobId || "");
    const registryKey = activeExecutionKey(key, ownerId);
    if (ACTIVE_JOB_EXECUTIONS.has(registryKey)) {
      throw codedError("删除作业已有活动执行", "SHORT_VIDEO_DELETE_EXECUTION_ACTIVE");
    }
    const token = crypto.randomBytes(24).toString("hex");
    ACTIVE_JOB_EXECUTIONS.set(registryKey, token);
    return token;
  }

  function endExecution(jobId, executionToken) {
    const registryKey = activeExecutionKey(jobId, ownerId);
    if (ACTIVE_JOB_EXECUTIONS.get(registryKey) === executionToken) ACTIVE_JOB_EXECUTIONS.delete(registryKey);
  }

  function activeExecutionTokenFor(jobId, executionOwnerId) {
    return ACTIVE_JOB_EXECUTIONS.get(activeExecutionKey(jobId, executionOwnerId)) || "";
  }

  function activeExecutionKey(jobId, executionOwnerId) {
    return `${String(executionOwnerId || "")}\0${String(jobId || "")}`;
  }

  return {
    assertPathWritesAllowed,
    close,
    execute,
    initialize,
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
  const hasColumn = () => db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
  if (hasColumn()) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    if (!hasColumn()) throw error;
  }
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
