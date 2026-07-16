import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

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
  dbPath,
  ensureDataDir,
  tableStampCacheMs = DEFAULT_TABLE_STAMP_CACHE_MS,
  warn = console.warn
}) {
  let db = null;
  let tableStampCache = new Map();
  let globalStampVersion = 0;
  const tableStampVersions = new Map();

  function getDb() {
    if (!db) {
      ensureDataDir();
      db = new DatabaseSync(dbPath);
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
      tableStampCache = new Map();
      globalStampVersion += 1;
      return;
    }
    for (const table of tables) {
      tableStampCache.delete(table);
      tableStampVersions.set(table, Number(tableStampVersions.get(table) || 0) + 1);
    }
  }

  function tableDataStamp(table) {
    const now = Date.now();
    const cached = tableStampCache.get(table);
    if (cached && now - cached.checkedAt < tableStampCacheMs) return cached.stamp;

    try {
      const tableMap = {
        actor_profiles: "people",
        actor_movies: "work_people",
        work_info: "works",
        work_covers: "images",
        javdb_rankings: "collection_items",
        local_image_cache: "local_image_cache",
        remote_image_cache: "remote_image_cache"
      };
      const safeTable = tableMap[table] || table;
      if (!/^[A-Za-z0-9_]+$/.test(safeTable)) throw new Error(`Invalid table: ${table}`);
      const version = `${globalStampVersion}:${Number(tableStampVersions.get(table) || 0)}`;
      const row = table === "work_covers"
        ? getDb()
          .prepare(
            `
            SELECT COUNT(*) AS count, COALESCE(MAX(owner_id), 0) AS max_owner_id
            FROM images INDEXED BY idx_images_unique_asset
            WHERE owner_type = 'work'
              AND kind = 'cover'
            `
          )
          .get()
        : getDb().prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), '') AS updated_at FROM ${safeTable}`).get();
      const stamp = table === "work_covers"
        ? `${version}:${Number(row?.count || 0)}:${Number(row?.max_owner_id || 0)}`
        : `${version}:${Number(row?.count || 0)}:${row?.updated_at || ""}`;
      tableStampCache.set(table, { checkedAt: now, stamp });
      return stamp;
    } catch (error) {
      warn("[core-db-stamp]", table, error.message);
      if (cached?.stamp) {
        tableStampCache.set(table, { checkedAt: now, stamp: cached.stamp });
        return cached.stamp;
      }
      const fallback = `${table}:unavailable`;
      tableStampCache.set(table, { checkedAt: now, stamp: fallback });
      return fallback;
    }
  }

  return {
    getDb,
    hasDb,
    invalidateTableStamp,
    tableDataStamp
  };
}
