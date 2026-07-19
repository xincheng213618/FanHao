const IMAGE_STORE_SCHEMA = "fanhao_images";

export function attachCoreImageStore(db, {
  dbPath,
  ensureSchema = true
} = {}) {
  if (!dbPath) return false;

  const attached = db
    .prepare("PRAGMA database_list")
    .all()
    .some((row) => String(row.name || "") === IMAGE_STORE_SCHEMA);
  if (!attached) {
    db.prepare(`ATTACH DATABASE ? AS ${IMAGE_STORE_SCHEMA}`).run(dbPath);
  }
  if (ensureSchema) ensureCoreImageStore(db);
  return true;
}

export function ensureCoreImageStore(db) {
  db.exec(`
    PRAGMA ${IMAGE_STORE_SCHEMA}.journal_mode = WAL;
    PRAGMA ${IMAGE_STORE_SCHEMA}.synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS ${IMAGE_STORE_SCHEMA}.images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_type TEXT NOT NULL CHECK(owner_type IN ('work', 'person')),
      owner_id INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'cover',
      source_type TEXT NOT NULL CHECK(source_type IN ('local', 'remote', 'generated', 'unknown')),
      local_path TEXT,
      remote_url TEXT,
      storage_path TEXT,
      mime TEXT,
      image_blob BLOB,
      width INTEGER,
      height INTEGER,
      byte_size INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ok',
      error TEXT,
      source TEXT NOT NULL DEFAULT 'migration',
      legacy_table TEXT,
      legacy_key TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS ${IMAGE_STORE_SCHEMA}.idx_images_owner
      ON images(owner_type, owner_id, kind);
    CREATE INDEX IF NOT EXISTS ${IMAGE_STORE_SCHEMA}.idx_images_remote_url
      ON images(remote_url);
    CREATE INDEX IF NOT EXISTS ${IMAGE_STORE_SCHEMA}.idx_images_local_path
      ON images(local_path);
    CREATE INDEX IF NOT EXISTS ${IMAGE_STORE_SCHEMA}.idx_images_updated_at
      ON images(updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS ${IMAGE_STORE_SCHEMA}.idx_images_unique_asset
      ON images(owner_type, owner_id, kind, source_type, COALESCE(remote_url, ''), COALESCE(local_path, ''), sort_order);

    CREATE TABLE IF NOT EXISTS ${IMAGE_STORE_SCHEMA}.remote_image_cache (
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
    CREATE INDEX IF NOT EXISTS ${IMAGE_STORE_SCHEMA}.idx_remote_image_cache_hash
      ON remote_image_cache(url_hash);
    CREATE INDEX IF NOT EXISTS ${IMAGE_STORE_SCHEMA}.idx_remote_image_cache_status
      ON remote_image_cache(status);

    CREATE TABLE IF NOT EXISTS ${IMAGE_STORE_SCHEMA}.local_image_cache (
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
    CREATE INDEX IF NOT EXISTS ${IMAGE_STORE_SCHEMA}.idx_local_image_cache_path
      ON local_image_cache(file_path);
    CREATE INDEX IF NOT EXISTS ${IMAGE_STORE_SCHEMA}.idx_local_image_cache_status
      ON local_image_cache(status);
  `);
}

export const CORE_IMAGE_STORE_SCHEMA = IMAGE_STORE_SCHEMA;
