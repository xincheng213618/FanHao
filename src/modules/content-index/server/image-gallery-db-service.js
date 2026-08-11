import { DatabaseSync } from "node:sqlite";

const TABLE_COLUMNS = {
  photo_set_covers: [
    ["archive_size", "INTEGER"],
    ["archive_mtime_ms", "INTEGER"],
    ["member_path", "TEXT"],
    ["cover_mime", "TEXT"],
    ["cover_blob", "BLOB"],
    ["cover_bytes", "INTEGER"],
    ["source_bytes", "INTEGER"],
    ["generator_version", "INTEGER NOT NULL DEFAULT 1"],
    ["status", "TEXT NOT NULL DEFAULT 'ok'"],
    ["error", "TEXT"],
    ["generated_at", "TEXT"],
    ["updated_at", "TEXT"]
  ],
  photo_set_image_indexes: [
    ["archive_path", "TEXT"],
    ["archive_size", "INTEGER"],
    ["archive_mtime_ms", "INTEGER"],
    ["image_count", "INTEGER"],
    ["images_json", "TEXT"],
    ["indexer_version", "INTEGER NOT NULL DEFAULT 1"],
    ["indexed_at", "TEXT"],
    ["updated_at", "TEXT"]
  ],
  tv_series_metadata: [
    ["category", "TEXT"],
    ["series_name", "TEXT NOT NULL DEFAULT ''"],
    ["douban_id", "TEXT"],
    ["douban_url", "TEXT"],
    ["douban_title", "TEXT"],
    ["original_title", "TEXT"],
    ["aka_json", "TEXT"],
    ["official_site", "TEXT"],
    ["year", "TEXT"],
    ["rating", "REAL"],
    ["rating_count", "INTEGER"],
    ["rating_stars_json", "TEXT"],
    ["rating_better_than_json", "TEXT"],
    ["directors_json", "TEXT"],
    ["writers_json", "TEXT"],
    ["genres_json", "TEXT"],
    ["actors_json", "TEXT"],
    ["countries_json", "TEXT"],
    ["languages_json", "TEXT"],
    ["pubdate", "TEXT"],
    ["release_dates_json", "TEXT"],
    ["season_count", "INTEGER"],
    ["episode_count", "INTEGER"],
    ["episode_duration", "TEXT"],
    ["durations_json", "TEXT"],
    ["imdb_id", "TEXT"],
    ["info_json", "TEXT"],
    ["json_ld_json", "TEXT"],
    ["summary", "TEXT"],
    ["cover_url", "TEXT"],
    ["cover_mime", "TEXT"],
    ["cover_blob", "BLOB"],
    ["cover_bytes", "INTEGER"],
    ["source", "TEXT"],
    ["detail_source", "TEXT"],
    ["status", "TEXT NOT NULL DEFAULT 'ok'"],
    ["error", "TEXT"],
    ["fetched_at", "TEXT"],
    ["updated_at", "TEXT NOT NULL DEFAULT ''"]
  ],
  movie_metadata: [
    ["category", "TEXT"],
    ["movie_title", "TEXT NOT NULL DEFAULT ''"],
    ["douban_id", "TEXT"],
    ["douban_url", "TEXT"],
    ["douban_title", "TEXT"],
    ["original_title", "TEXT"],
    ["aka_json", "TEXT"],
    ["official_site", "TEXT"],
    ["year", "TEXT"],
    ["rating", "REAL"],
    ["rating_count", "INTEGER"],
    ["rating_stars_json", "TEXT"],
    ["rating_better_than_json", "TEXT"],
    ["directors_json", "TEXT"],
    ["writers_json", "TEXT"],
    ["genres_json", "TEXT"],
    ["actors_json", "TEXT"],
    ["countries_json", "TEXT"],
    ["languages_json", "TEXT"],
    ["pubdate", "TEXT"],
    ["release_dates_json", "TEXT"],
    ["season_count", "INTEGER"],
    ["episode_count", "INTEGER"],
    ["episode_duration", "TEXT"],
    ["durations_json", "TEXT"],
    ["imdb_id", "TEXT"],
    ["info_json", "TEXT"],
    ["json_ld_json", "TEXT"],
    ["summary", "TEXT"],
    ["cover_url", "TEXT"],
    ["cover_mime", "TEXT"],
    ["cover_blob", "BLOB"],
    ["cover_bytes", "INTEGER"],
    ["source", "TEXT"],
    ["detail_source", "TEXT"],
    ["status", "TEXT NOT NULL DEFAULT 'ok'"],
    ["error", "TEXT"],
    ["fetched_at", "TEXT"],
    ["updated_at", "TEXT NOT NULL DEFAULT ''"]
  ],
  gallery_media_covers: [
    ["source_path", "TEXT NOT NULL DEFAULT ''"],
    ["source_size", "INTEGER"],
    ["source_mtime_ms", "INTEGER"],
    ["cover_mime", "TEXT"],
    ["cover_blob", "BLOB"],
    ["cover_bytes", "INTEGER"],
    ["generator_version", "INTEGER NOT NULL DEFAULT 1"],
    ["status", "TEXT NOT NULL DEFAULT 'ok'"],
    ["error", "TEXT"],
    ["generated_at", "TEXT"],
    ["updated_at", "TEXT NOT NULL DEFAULT ''"]
  ]
};

function ensureColumn(db, table, column, definition) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!rows.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS photo_set_covers (
      album_id TEXT PRIMARY KEY,
      archive_path TEXT NOT NULL,
      archive_size INTEGER,
      archive_mtime_ms INTEGER,
      member_path TEXT,
      cover_mime TEXT,
      cover_blob BLOB,
      cover_bytes INTEGER,
      source_bytes INTEGER,
      generator_version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'ok',
      error TEXT,
      generated_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_photo_set_covers_archive_path ON photo_set_covers(archive_path);
    CREATE INDEX IF NOT EXISTS idx_photo_set_covers_status ON photo_set_covers(status);
    CREATE INDEX IF NOT EXISTS idx_photo_set_covers_updated_at ON photo_set_covers(updated_at);
    CREATE TABLE IF NOT EXISTS photo_set_image_indexes (
      archive_path TEXT PRIMARY KEY,
      archive_size INTEGER,
      archive_mtime_ms INTEGER,
      image_count INTEGER,
      images_json TEXT NOT NULL,
      indexer_version INTEGER NOT NULL DEFAULT 1,
      indexed_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_photo_set_image_indexes_updated_at ON photo_set_image_indexes(updated_at);
    CREATE TABLE IF NOT EXISTS tv_series_metadata (
      series_key TEXT PRIMARY KEY,
      category TEXT,
      series_name TEXT NOT NULL,
      douban_id TEXT,
      douban_url TEXT,
      douban_title TEXT,
      original_title TEXT,
      aka_json TEXT,
      official_site TEXT,
      year TEXT,
      rating REAL,
      rating_count INTEGER,
      rating_stars_json TEXT,
      rating_better_than_json TEXT,
      directors_json TEXT,
      writers_json TEXT,
      genres_json TEXT,
      actors_json TEXT,
      countries_json TEXT,
      languages_json TEXT,
      pubdate TEXT,
      release_dates_json TEXT,
      season_count INTEGER,
      episode_count INTEGER,
      episode_duration TEXT,
      durations_json TEXT,
      imdb_id TEXT,
      info_json TEXT,
      json_ld_json TEXT,
      summary TEXT,
      cover_url TEXT,
      cover_mime TEXT,
      cover_blob BLOB,
      cover_bytes INTEGER,
      source TEXT,
      detail_source TEXT,
      status TEXT NOT NULL DEFAULT 'ok',
      error TEXT,
      fetched_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tv_series_metadata_category ON tv_series_metadata(category);
    CREATE INDEX IF NOT EXISTS idx_tv_series_metadata_douban_id ON tv_series_metadata(douban_id);
    CREATE INDEX IF NOT EXISTS idx_tv_series_metadata_status ON tv_series_metadata(status);
    CREATE TABLE IF NOT EXISTS movie_metadata (
      media_id TEXT PRIMARY KEY,
      category TEXT,
      movie_title TEXT NOT NULL,
      douban_id TEXT,
      douban_url TEXT,
      douban_title TEXT,
      original_title TEXT,
      aka_json TEXT,
      official_site TEXT,
      year TEXT,
      rating REAL,
      rating_count INTEGER,
      rating_stars_json TEXT,
      rating_better_than_json TEXT,
      directors_json TEXT,
      writers_json TEXT,
      genres_json TEXT,
      actors_json TEXT,
      countries_json TEXT,
      languages_json TEXT,
      pubdate TEXT,
      release_dates_json TEXT,
      season_count INTEGER,
      episode_count INTEGER,
      episode_duration TEXT,
      durations_json TEXT,
      imdb_id TEXT,
      info_json TEXT,
      json_ld_json TEXT,
      summary TEXT,
      cover_url TEXT,
      cover_mime TEXT,
      cover_blob BLOB,
      cover_bytes INTEGER,
      source TEXT,
      detail_source TEXT,
      status TEXT NOT NULL DEFAULT 'ok',
      error TEXT,
      fetched_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_movie_metadata_category ON movie_metadata(category);
    CREATE INDEX IF NOT EXISTS idx_movie_metadata_douban_id ON movie_metadata(douban_id);
    CREATE INDEX IF NOT EXISTS idx_movie_metadata_status ON movie_metadata(status);
    CREATE TABLE IF NOT EXISTS gallery_media_covers (
      media_id TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      source_size INTEGER,
      source_mtime_ms INTEGER,
      cover_mime TEXT,
      cover_blob BLOB,
      cover_bytes INTEGER,
      generator_version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'ok',
      error TEXT,
      generated_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gallery_media_covers_status ON gallery_media_covers(status);
    CREATE INDEX IF NOT EXISTS idx_gallery_media_covers_updated_at ON gallery_media_covers(updated_at);
  `);

  for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
    for (const [column, definition] of columns) {
      ensureColumn(db, table, column, definition);
    }
  }
}

export function createImageGalleryDbService({ dbPath, ensureDataDir }) {
  let db = null;

  function getDb() {
    if (!db) {
      ensureDataDir();
      db = new DatabaseSync(dbPath);
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
      ensureSchema(db);
    }
    return db;
  }

  function close() {
    if (!db) return;
    db.close();
    db = null;
  }

  return {
    close,
    getDb
  };
}
