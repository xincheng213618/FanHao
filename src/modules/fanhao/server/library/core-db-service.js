import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { attachCoreImageStore } from "../../../../platform/server/core-image-store.js";
import { readTableStampRow, tableStampValue } from "./table-stamp-query.js";
import { createTableStampWorkerClient } from "./table-stamp-worker-client.js";

const DEFAULT_TABLE_STAMP_CACHE_MS = 5000;

function ensureColumn(db, table, column, definition) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!rows.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function ensureCoreTables(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_works_updated_at ON works(updated_at);
    CREATE INDEX IF NOT EXISTS idx_works_status_code_search ON works(status, code_search, id);
    CREATE INDEX IF NOT EXISTS idx_work_people_updated_at ON work_people(updated_at);
    CREATE INDEX IF NOT EXISTS idx_people_updated_at ON people(updated_at);
    CREATE INDEX IF NOT EXISTS idx_person_external_refs_updated_at ON person_external_refs(updated_at);
    CREATE INDEX IF NOT EXISTS idx_work_external_refs_updated_at ON work_external_refs(updated_at);
    CREATE INDEX IF NOT EXISTS idx_person_aliases_updated_at ON person_aliases(updated_at);
    CREATE INDEX IF NOT EXISTS idx_collection_items_updated_at ON collection_items(updated_at);
    CREATE TABLE IF NOT EXISTS local_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
      local_work_id INTEGER REFERENCES local_works(id) ON DELETE CASCADE,
      file_id TEXT NOT NULL UNIQUE,
      file_type TEXT NOT NULL CHECK(file_type IN ('video', 'image', 'info')),
      file_path TEXT NOT NULL,
      name TEXT NOT NULL,
      title TEXT,
      ext TEXT,
      relative_path TEXT,
      size INTEGER,
      modified_at TEXT,
      playable INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_local_files_work ON local_files(work_id, file_type, sort_order);
    CREATE INDEX IF NOT EXISTS idx_local_files_local_work ON local_files(local_work_id);
    CREATE INDEX IF NOT EXISTS idx_local_files_path ON local_files(file_path);
  `);
}

function ensureCoreSchema(db) {
  db.exec("SAVEPOINT fanhao_core_schema_init");
  try {
    ensureColumn(db, "people", "gender", "TEXT NOT NULL DEFAULT 'unknown'");
    ensureColumn(db, "works", "has_magnet", "INTEGER");
    ensureColumn(db, "works", "is_streamable", "INTEGER");
    ensureColumn(db, "works", "has_subtitles", "INTEGER");
    ensureColumn(db, "works", "javdb_tags_json", "TEXT");
    ensureColumn(db, "person_external_refs", "updated_at", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "work_external_refs", "updated_at", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "person_aliases", "updated_at", "TEXT NOT NULL DEFAULT ''");
    ensureCoreTables(db);
    db.exec("RELEASE SAVEPOINT fanhao_core_schema_init");
  } catch (error) {
    try {
      db.exec("ROLLBACK TO SAVEPOINT fanhao_core_schema_init; RELEASE SAVEPOINT fanhao_core_schema_init;");
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `Core schema migration failed and rollback also failed: ${error.message}`);
    }
    throw error;
  }
}

export function createCoreDbService({
  createDatabase = (filePath) => new DatabaseSync(filePath),
  dbPath,
  ensureDataDir,
  imageDbPath,
  now = Date.now,
  refreshTableStampRow = null,
  tableStampCacheMs = DEFAULT_TABLE_STAMP_CACHE_MS,
  warn = console.warn
}) {
  let db = null;
  let tableStampCache = new Map();
  let globalStampVersion = 0;
  const stampRefreshes = new Map();
  const tableStampVersions = new Map();
  const tableStampWorker = refreshTableStampRow ? null : createTableStampWorkerClient({ dbPath, imageDbPath });
  const refreshStampRow = refreshTableStampRow || tableStampWorker.refresh;

  function getDb() {
    if (!db) {
      let candidate = null;
      try {
        ensureDataDir();
        candidate = createDatabase(dbPath);
        candidate.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
        attachCoreImageStore(candidate, { dbPath: imageDbPath });
        ensureCoreSchema(candidate);
        db = candidate;
      } catch (error) {
        if (candidate) {
          try {
            candidate.close();
          } catch (closeError) {
            warn("[core-db-close]", closeError?.message || closeError);
          }
        }
        db = null;
        tableStampCache.clear();
        warn("[core-db]", error.message);
        throw error;
      }
    }
    return db;
  }

  function hasDb() {
    return fs.existsSync(dbPath);
  }

  function invalidateTableStamp(...tables) {
    if (!tables.length) {
      globalStampVersion += 1;
      for (const [table, cached] of tableStampCache) {
        const version = stampVersion(table);
        tableStampCache.set(table, {
          ...cached,
          checkedAt: now(),
          stamp: tableStampValue(table, version, cached.row)
        });
        scheduleTableStampRefresh(table, version);
      }
      return;
    }
    for (const table of tables) {
      tableStampVersions.set(table, Number(tableStampVersions.get(table) || 0) + 1);
      const cached = tableStampCache.get(table);
      if (!cached) continue;
      const version = stampVersion(table);
      tableStampCache.set(table, {
        ...cached,
        checkedAt: now(),
        stamp: tableStampValue(table, version, cached.row)
      });
      scheduleTableStampRefresh(table, version);
    }
  }

  function tableDataStamp(table) {
    const checkedAt = now();
    const cached = tableStampCache.get(table);
    if (cached) {
      if (checkedAt - cached.checkedAt >= tableStampCacheMs) {
        scheduleTableStampRefresh(table, stampVersion(table));
      }
      return cached.stamp;
    }

    const coreDb = getDb();
    try {
      const version = stampVersion(table);
      const row = readTableStampRow(coreDb, table);
      const stamp = tableStampValue(table, version, row);
      tableStampCache.set(table, { checkedAt, row, stamp });
      return stamp;
    } catch (error) {
      warn("[core-db-stamp]", table, error.message);
      const fallback = tableStampValue(table, stampVersion(table), null);
      tableStampCache.set(table, { checkedAt, row: null, stamp: fallback });
      return fallback;
    }
  }

  function stampVersion(table) {
    return `${globalStampVersion}:${Number(tableStampVersions.get(table) || 0)}`;
  }

  function scheduleTableStampRefresh(table, version) {
    if (stampRefreshes.has(table)) return;
    const refresh = Promise.resolve()
      .then(() => refreshStampRow(table))
      .then((row) => {
        if (stampVersion(table) !== version) return;
        tableStampCache.set(table, {
          checkedAt: now(),
          row,
          stamp: tableStampValue(table, version, row)
        });
      })
      .catch((error) => {
        warn("[core-db-stamp-refresh]", table, error?.message || error);
        const cached = tableStampCache.get(table);
        if (cached && stampVersion(table) === version) {
          tableStampCache.set(table, { ...cached, checkedAt: now() });
        }
      })
      .finally(() => {
        if (stampRefreshes.get(table) === refresh) stampRefreshes.delete(table);
      });
    stampRefreshes.set(table, refresh);
  }

  return {
    getDb,
    hasDb,
    invalidateTableStamp,
    tableDataStamp
  };
}
