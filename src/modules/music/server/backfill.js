import { metaValue } from "./helpers.js";
import { musicLanguageFromPath } from "./language.js";
import { musicGenreForTrack } from "./scan.js";

const MAX_GENRE_PROBE_ROWS = 128;

export function backfillMissingTrackGenres(db) {
  const missing = db.prepare(`
      SELECT id, title, display_artist, album_title, file_name, relative_path, genre
      FROM music_tracks
      WHERE status = 'ok' AND TRIM(COALESCE(genre, '')) = ''
    `);
  if (noMissingTrackGenres(db)) return;
  const rows = missing.all();
  if (!rows.length) return;
  const update = db.prepare("UPDATE music_tracks SET genre = ? WHERE id = ? AND TRIM(COALESCE(genre, '')) = ''");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const genre = musicGenreForTrack({
        genre: row.genre,
        artistName: row.display_artist,
        albumTitle: row.album_title,
        title: row.title,
        fileName: row.file_name,
        relativePath: row.relative_path
      });
      if (genre) update.run(genre, row.id);
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function noMissingTrackGenres(db) {
  // SQLite's default TRIM removes ASCII spaces. Every empty result comes
  // from NULL, text below '!', or a BLOB converted to text by TRIM.
  const select = `SELECT status = 'ok' AND TRIM(COALESCE(genre, '')) = '' AS missing
    FROM music_tracks INDEXED BY idx_music_tracks_genre WHERE`;
  const sql = `WITH candidates AS MATERIALIZED (
    ${select} genre IS NULL
    UNION ALL ${select} genre COLLATE BINARY < '!'
    UNION ALL ${select} genre COLLATE BINARY >= X''
    LIMIT ${MAX_GENRE_PROBE_ROWS + 1}
  ) SELECT COUNT(*) AS count, MAX(missing) AS missing FROM candidates`;
  try {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
    const searches = plan.filter(row => row.detail.startsWith("SEARCH music_tracks USING INDEX idx_music_tracks_genre (genre"));
    if (searches.length !== 3) return false;
    const result = db.prepare(sql).get();
    return result.count <= MAX_GENRE_PROBE_ROWS && !result.missing;
  } catch {
    return false;
  }
}

export function backfillMusicLanguages(db) {
  if (metaValue(db, "language_backfilled_v1") === "1") return;
  const tracks = db.prepare("SELECT id, relative_path FROM music_tracks").all();
  if (tracks.length) {
    const updateTrack = db.prepare("UPDATE music_tracks SET language = ? WHERE id = ?");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of tracks) updateTrack.run(musicLanguageFromPath(row.relative_path), row.id);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
  db.exec(`
    UPDATE music_artists
    SET language = COALESCE((
      SELECT t.language FROM music_tracks t
      WHERE t.artist_id = music_artists.id AND t.status = 'ok'
      GROUP BY t.language ORDER BY COUNT(*) DESC LIMIT 1
    ), '其他')
  `);
  db.prepare("INSERT OR REPLACE INTO music_meta (key, value) VALUES ('language_backfilled_v1', '1')").run();
}
