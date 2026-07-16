import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { readTableStampRow, tableStampValue } from "./table-stamp-query.js";
import { createTableStampWorkerClient } from "./table-stamp-worker-client.js";

const DEFAULT_TABLE_STAMP_CACHE_MS = 5000;

function ensureColumn(db, table, column, definition) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!rows.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function ensureCoreCacheTables(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_works_updated_at ON works(updated_at);
    CREATE INDEX IF NOT EXISTS idx_work_people_updated_at ON work_people(updated_at);
    CREATE TABLE IF NOT EXISTS remote_image_cache (
      url TEXT PRIMARY KEY,
      url_hash TEXT NOT NULL,
      content_type TEXT,
      image_blob BLOB,
      byte_length INTEGER,
      status TEXT NOT NULL DEFAULT 'ok',
      error TEXT,
      fetched_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_remote_image_cache_hash ON remote_image_cache(url_hash);
    CREATE INDEX IF NOT EXISTS idx_remote_image_cache_status ON remote_image_cache(status);
    CREATE TABLE IF NOT EXISTS local_image_cache (
      file_id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      relative_path TEXT,
      content_type TEXT,
      image_blob BLOB,
      byte_length INTEGER,
      source_size INTEGER,
      source_mtime TEXT,
      status TEXT NOT NULL DEFAULT 'ok',
      error TEXT,
      cached_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_local_image_cache_path ON local_image_cache(file_path);
    CREATE INDEX IF NOT EXISTS idx_local_image_cache_status ON local_image_cache(status);
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

export function createCoreDbService({
  createDatabase = (filePath) => new DatabaseSync(filePath),
  dbPath,
  ensureDataDir,
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
  const tableStampWorker = refreshTableStampRow ? null : createTableStampWorkerClient({ dbPath });
  const refreshStampRow = refreshTableStampRow || tableStampWorker.refresh;

  function getDb() {
    if (!db) {
      ensureDataDir();
      db = createDatabase(dbPath);
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
      try {
        ensureColumn(db, "people", "gender", "TEXT NOT NULL DEFAULT 'unknown'");
        ensureColumn(db, "works", "has_magnet", "INTEGER");
        ensureColumn(db, "works", "is_streamable", "INTEGER");
        ensureColumn(db, "works", "has_subtitles", "INTEGER");
        ensureColumn(db, "works", "javdb_tags_json", "TEXT");
        ensureColumn(db, "images", "image_blob", "BLOB");
        ensureCoreCacheTables(db);
      } catch (error) {
        warn("[core-db]", error.message);
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

    try {
      const version = stampVersion(table);
      const row = readTableStampRow(getDb(), table);
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
