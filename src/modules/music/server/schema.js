// Music store sub-module: schema
import { backfillMissingTrackGenres, backfillMusicLanguages } from "./backfill.js";
import { insertMusicShortSearchRow } from "./search.js";

export function ensureSchema(db) {
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS music_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS music_artists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_name TEXT,
      language TEXT NOT NULL DEFAULT '其他',
      source_root TEXT NOT NULL,
      source_path TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      album_count INTEGER DEFAULT 0,
      track_count INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      size_bytes INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ok',
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_music_artists_name ON music_artists(name);
    CREATE TABLE IF NOT EXISTS music_albums (
      id TEXT PRIMARY KEY,
      artist_id TEXT NOT NULL,
      title TEXT NOT NULL,
      sort_title TEXT,
      year TEXT,
      cover_path TEXT,
      intro_path TEXT,
      intro_text TEXT,
      source_root TEXT NOT NULL,
      source_path TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      track_count INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      size_bytes INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_music_albums_artist ON music_albums(artist_id, title);
    CREATE INDEX IF NOT EXISTS idx_music_albums_title ON music_albums(title);
    CREATE TABLE IF NOT EXISTS music_tracks (
      id TEXT PRIMARY KEY,
      artist_id TEXT NOT NULL,
      album_id TEXT NOT NULL,
      title TEXT NOT NULL,
      sort_title TEXT,
      display_artist TEXT,
      album_title TEXT,
      track_no INTEGER,
      disc_no INTEGER,
      genre TEXT,
      language TEXT NOT NULL DEFAULT '其他',
      source_root TEXT NOT NULL,
      source_path TEXT NOT NULL UNIQUE,
      relative_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      ext TEXT NOT NULL,
      size_bytes INTEGER,
      mtime_ms INTEGER,
      duration_ms INTEGER,
      codec TEXT,
      sample_rate INTEGER,
      bit_depth INTEGER,
      channels INTEGER,
      lrc_path TEXT,
      has_lrc INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ok',
      error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_music_tracks_artist ON music_tracks(artist_id, album_id, track_no, title);
    CREATE INDEX IF NOT EXISTS idx_music_tracks_album ON music_tracks(album_id, track_no, title);
    CREATE INDEX IF NOT EXISTS idx_music_tracks_title ON music_tracks(title);
    CREATE TABLE IF NOT EXISTS music_lyrics (
      track_id TEXT PRIMARY KEY,
      lrc_path TEXT,
      raw_text TEXT,
      parsed_json TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS music_track_state (
      track_id TEXT PRIMARY KEY,
      favorite INTEGER DEFAULT 0,
      rating INTEGER DEFAULT 0,
      position_ms INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      play_count INTEGER DEFAULT 0,
      last_played_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_music_track_state_favorite ON music_track_state(favorite, updated_at);
    CREATE INDEX IF NOT EXISTS idx_music_track_state_played ON music_track_state(last_played_at);
    CREATE TABLE IF NOT EXISTS music_playlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS music_playlist_items (
      playlist_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      added_at TEXT NOT NULL,
      PRIMARY KEY (playlist_id, track_id)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS music_search USING fts5(
      track_id UNINDEXED,
      title,
      artist,
      album,
      lyrics,
      tokenize='trigram'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS music_search_short USING fts5(
      track_id UNINDEXED,
      title,
      artist,
      album,
      genre,
      file_name,
      tokenize='unicode61 remove_diacritics 0'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS music_search_short_vocab USING fts5vocab(
      music_search_short,
      'row'
    );
  `);
  ensureColumn(db, "music_tracks", "genre", "TEXT");
  ensureColumn(db, "music_tracks", "language", "TEXT NOT NULL DEFAULT '其他'");
  ensureColumn(db, "music_artists", "language", "TEXT NOT NULL DEFAULT '其他'");
  ensureColumn(db, "music_track_state", "rating", "INTEGER DEFAULT 0");
  db.exec("CREATE INDEX IF NOT EXISTS idx_music_tracks_genre ON music_tracks(genre);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_music_tracks_language ON music_tracks(language, artist_id, album_id);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_music_artists_language ON music_artists(language, track_count DESC, name);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_music_tracks_album_sort ON music_tracks(status, album_title COLLATE NOCASE, disc_no, track_no, title COLLATE NOCASE);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_music_tracks_language_album_sort ON music_tracks(language, status, album_title COLLATE NOCASE, disc_no, track_no, title COLLATE NOCASE);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_music_tracks_artist_sort ON music_tracks(status, display_artist COLLATE NOCASE, album_title COLLATE NOCASE, track_no, title COLLATE NOCASE);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_music_tracks_title_sort ON music_tracks(status, title COLLATE NOCASE, display_artist COLLATE NOCASE);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_music_albums_track_count ON music_albums(track_count DESC, title COLLATE NOCASE);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_music_artists_track_count ON music_artists(track_count DESC, name COLLATE NOCASE);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_music_track_state_rating ON music_track_state(rating, updated_at);");
  backfillMissingTrackGenres(db);
  backfillMusicLanguages(db);
  ensureMusicShortSearchIndex(db);
}


export function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (columns.some((column) => column.name === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition};`);
}


export function ensureMusicShortSearchIndex(db) {
  const trackCount = Number(db.prepare("SELECT COUNT(*) AS count FROM music_tracks WHERE status = 'ok'").get()?.count || 0);
  const indexedCount = Number(db.prepare("SELECT COUNT(*) AS count FROM music_search_short").get()?.count || 0);
  if (trackCount === indexedCount) return;
  const rows = db
    .prepare("SELECT id, title, display_artist, album_title, genre, file_name FROM music_tracks WHERE status = 'ok'")
    .all();
  const insert = db.prepare(`
    INSERT INTO music_search_short (track_id, title, artist, album, genre, file_name)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  db.exec("SAVEPOINT rebuild_music_search_short");
  try {
    db.prepare("DELETE FROM music_search_short").run();
    for (const row of rows) insertMusicShortSearchRow(insert, row);
    db.exec("RELEASE SAVEPOINT rebuild_music_search_short");
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT rebuild_music_search_short");
    db.exec("RELEASE SAVEPOINT rebuild_music_search_short");
    throw error;
  }
}
