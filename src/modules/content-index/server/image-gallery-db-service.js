import { DatabaseSync } from "node:sqlite";
import { ensureGalleryMetadataClocks } from "../../../../lib/gallery-metadata-revision.js";

const TABLE_COLUMNS = {
  photo_set_covers: [
    ["archive_identity", "TEXT"],
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
    ["archive_identity", "TEXT"],
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
    CREATE TABLE IF NOT EXISTS photo_library_snapshot (
      id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL, revision TEXT NOT NULL,
      scanned_at TEXT NOT NULL, roots_json TEXT NOT NULL, overview_json TEXT NOT NULL,
      facets_json TEXT NOT NULL, scopes_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS photo_library_archives (
      id TEXT PRIMARY KEY NOT NULL, position INTEGER NOT NULL UNIQUE,
      collection_id TEXT NOT NULL, data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_photo_library_archive_collection ON photo_library_archives(collection_id, position);
    CREATE INDEX IF NOT EXISTS idx_photo_library_archive_category ON photo_library_archives(json_extract(data_json, '$.category'), position);
    CREATE TABLE IF NOT EXISTS photo_library_archive_marks (
      album_id TEXT PRIMARY KEY NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS photo_library_collections (
      category TEXT NOT NULL, sort TEXT NOT NULL, locale TEXT NOT NULL, position INTEGER NOT NULL,
      data_json TEXT NOT NULL,
      PRIMARY KEY(category, sort, locale, position)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS photo_browse_categories (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL,
      parent_id TEXT REFERENCES photo_browse_categories(id), source_category TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_photo_browse_categories_parent ON photo_browse_categories(parent_id, position, id);
    INSERT OR IGNORE INTO photo_browse_categories (id, name, parent_id, source_category, position) VALUES
      ('sites', '名站套图', NULL, '', 0),
      ('xiuren', '秀人网', 'sites', '[XIUREN] 秀人网', 0),
      ('yituyu', '艺图语', 'sites', '[YITUYU艺图语]', 1),
      ('mslass', '梦丝女神', 'sites', '[MSLASS梦丝女神]', 2),
      ('girlt', '果团网', 'sites', '[Girlt] 果团网', 3),
      ('qingdouke', '青豆客', 'sites', '[QingDouKe] 青豆客', 4),
      ('bololi', '菠萝社', 'sites', '[BoLoli]波萝社', 5),
      ('ugirls', '尤果网', 'sites', '[Ugirls] 尤果网', 6),
      ('ligui', '丽柜', 'sites', '[Ligui丽柜]', 7),
      ('iess', '异思趣向', 'sites', '[IESS异思趣向]', 8),
      ('beautyleg', 'Beautyleg', 'sites', '[Beautyleg]', 9),
      ('rosi-arts', 'ROSI艺学妹', 'sites', '[ROSI艺学妹]', 10),
      ('ssa', '丝社', 'sites', '[SSA] 丝社', 11),
      ('toutiao', '头条女神', 'sites', '[TouTiao] 头条女神', 12),
      ('emergency-project', '紧急企划', 'sites', '[紧急企划]', 13),
      ('zhimeng', '织梦映像', 'sites', '织梦映像', 14),
      ('partycat', '轰趴猫', 'sites', '[Partycat]', 15),
      ('tuigirl', '推女郎', 'sites', '[TuiGirl] 推女郎', 16),
      ('slady', '猎女神', 'sites', '[SLADY]猎女神', 17),
      ('fetish', '恋足恋物', NULL, '恋足恋物', 2),
      ('bobosocks', '袜啵啵', 'fetish', '[BoBoSocks袜啵啵]', 0),
      ('japan', '日本', NULL, '日本写真集', 3),
      ('ys-web', 'YS Web', 'japan', 'YS Web', 0),
      ('maxi-247', 'Maxi-247', 'japan', 'Maxi-247 - 301 Rei', 1),
      ('korea', '韩国', NULL, '韩国写真集', 4),
      ('make-model', 'Make Model', 'korea', '[Make model]', 0),
      ('korean-entertainment', '韩国演艺圈', 'korea', '韩国演艺圈', 1),
      ('korean-other', '其他韩国写真', 'korea', '韩国', 2),
      ('leeheeexpress', 'LeeheeExpress', 'korea', '[LeeheeExpress]', 3),
      ('street', '精选街拍', NULL, '精选街拍', 5),
      ('mojing', '魔镜街拍', 'street', '魔镜街拍', 0),
      ('likes', '我喜欢的', NULL, '我喜欢的', 6),
      ('miscellaneous', '零散', 'likes', '[零散]', 0);
    UPDATE photo_browse_categories SET parent_id='korea'
      WHERE id='korean-entertainment' AND parent_id IS NULL AND source_category='韩国演艺圈';

    CREATE TABLE IF NOT EXISTS photo_category_covers (
      category_key TEXT PRIMARY KEY NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('album', 'upload')),
      version TEXT NOT NULL,
      album_id TEXT,
      mime TEXT,
      image BLOB,
      CHECK ((source='album' AND album_id IS NOT NULL AND mime IS NULL AND image IS NULL)
        OR (source='upload' AND album_id IS NULL AND mime IS NOT NULL AND mime IN ('image/jpeg', 'image/png', 'image/webp')
          AND image IS NOT NULL AND length(image) BETWEEN 1 AND 5242880))
    );

    CREATE TABLE IF NOT EXISTS photo_publishers (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, code TEXT NOT NULL DEFAULT ''
    );
    -- A publisher can be registered after its browse category is seeded.
    CREATE TABLE IF NOT EXISTS photo_browse_category_publishers (
      category_id TEXT PRIMARY KEY REFERENCES photo_browse_categories(id) ON DELETE CASCADE,
      publisher_id TEXT NOT NULL UNIQUE
    ) WITHOUT ROWID;
    INSERT OR IGNORE INTO photo_browse_category_publishers (category_id, publisher_id) VALUES ('bololi', 'bololi');
    CREATE TABLE IF NOT EXISTS photo_publisher_members (
      publisher_id TEXT NOT NULL REFERENCES photo_publishers(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('collection', 'video')),
      target_id TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL,
      PRIMARY KEY(publisher_id, kind, target_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_photo_publisher_members_target ON photo_publisher_members(kind, target_id);
    CREATE TABLE IF NOT EXISTS photo_publisher_video_items (
      id TEXT PRIMARY KEY NOT NULL, data_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gallery_media_library_snapshot (
      id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL, revision TEXT NOT NULL,
      scanned_at TEXT NOT NULL, roots_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gallery_media_library_items (
      id TEXT PRIMARY KEY NOT NULL, position INTEGER NOT NULL UNIQUE,
      media_kind TEXT NOT NULL, data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gallery_media_library_kind ON gallery_media_library_items(media_kind, position);

    CREATE TABLE IF NOT EXISTS photo_set_covers (
      album_id TEXT PRIMARY KEY,
      archive_path TEXT NOT NULL,
      archive_size INTEGER,
      archive_mtime_ms INTEGER,
      archive_identity TEXT,
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
      archive_identity TEXT,
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
  // Older or malformed optional clock state keeps the conservative reader
  // fallback; it must not make the established metadata schema unavailable.
  ensureGalleryMetadataClocks(db);
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
