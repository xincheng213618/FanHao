import { trackOrderSql } from "./helpers.js";

// Columns consumed by publicTrack's list DTO. Detail and file access queries
// continue to own their full source/file metadata.
export const TRACK_LIST_COLUMNS = "t.id,t.artist_id,t.album_id,t.title,t.display_artist,t.album_title,t.track_no,t.disc_no,t.genre,t.language,t.duration_ms,t.codec,t.sample_rate,t.bit_depth,t.channels,t.has_lrc,t.file_name,t.size_bytes";
const listColumns = TRACK_LIST_COLUMNS.split(",");

export function prepareTrackList(db, sql) {
  // The former query remains the authority for prepare errors and the actual
  // schema. Inspect statement metadata without executing it or reading rows.
  // This also retains old optional fields and a legacy track-owned cover stamp.
  const complete = db.prepare(sql.replace(TRACK_LIST_COLUMNS, "t.*"));
  const columns = new Set();
  for (const column of complete.columns()) if (column.table?.toLowerCase() === "music_tracks") columns.add(column.column);
  const selected = [];
  for (const column of listColumns) if (columns.has(column.slice(2))) selected.push(column);
  if (columns.has("cover_updated_at")) selected.push("t.cover_updated_at");
  return db.prepare(sql.replace(TRACK_LIST_COLUMNS, selected.join(",")));
}

const FAVORITE_QUEUE_PREDICATE = "t.status = 'ok' AND COALESCE(s.favorite, 0) = 1";
const ALBUM_QUEUE_ORDER = trackOrderSql("album");
const MAX_SPARSE_FAVORITES = 1024;

export function readSparseFavoriteAlbumRows(db, filter, order, sql, args, prepare = (database, text) => database.prepare(text)) {
  if (filter.trackWhere !== FAVORITE_QUEUE_PREDICATE || order !== ALBUM_QUEUE_ORDER) return null;
  const ownsSnapshot = !db.isTransaction;
  if (ownsSnapshot) {
    try { db.exec("SAVEPOINT music_sparse_favorite_album"); }
    catch { return null; }
  }
  let readFailed = false;
  try {
    const statement = prepareSparseFavoriteAlbumRows(db, sql, args, prepare);
    return statement?.all(...args) ?? null;
  } catch (error) {
    readFailed = true;
    throw error;
  } finally {
    if (ownsSnapshot) {
      try { db.exec("RELEASE music_sparse_favorite_album"); }
      catch (error) { if (!readFailed) throw error; }
    }
  }
}

function prepareSparseFavoriteAlbumRows(db, sql, args, prepare) {
  try {
    const declarations = db.prepare(`SELECT name, sql FROM main.sqlite_schema
      WHERE name IN ('music_tracks','music_track_state','music_artists','music_albums',
        'idx_music_track_state_favorite','idx_music_tracks_album_sort')
        AND NOT EXISTS(SELECT 1 FROM temp.sqlite_schema WHERE name COLLATE NOCASE IN
          ('music_tracks','music_track_state','music_artists','music_albums'))`).all();
    const byName = new Map(declarations.map(row => [row.name, row.sql]));
    for (const table of ["music_tracks", "music_artists", "music_albums"]) {
      if (!new RegExp(`^CREATE\\s+TABLE\\s+${table}\\s*\\(\\s*id\\s+TEXT\\s+PRIMARY\\s+KEY\\s*,`, "iu").test(byName.get(table) || "")) return null;
    }
    if (!/^CREATE\s+TABLE\s+music_track_state\s*\(\s*track_id\s+TEXT\s+PRIMARY\s+KEY\s*,\s*favorite\s+INTEGER\s+DEFAULT\s+0\s*,/iu.test(byName.get("music_track_state") || "")) return null;
    if (byName.get("idx_music_track_state_favorite") !== "CREATE INDEX idx_music_track_state_favorite ON music_track_state(favorite, updated_at)"
      || byName.get("idx_music_tracks_album_sort") !== "CREATE INDEX idx_music_tracks_album_sort ON music_tracks(status, album_title COLLATE NOCASE, disc_no, track_no, title COLLATE NOCASE)") return null;
    const sample = db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT 1 FROM music_track_state INDEXED BY idx_music_track_state_favorite WHERE favorite = 1
      LIMIT ${MAX_SPARSE_FAVORITES + 1}
    )`).get();
    if (!Number.isInteger(sample?.count) || sample.count > MAX_SPARSE_FAVORITES) return null;
    if (!db.prepare(`SELECT 1 FROM pragma_table_list('music_tracks') WHERE schema = 'main' AND type = 'table' AND wr = 0
      AND NOT EXISTS(SELECT 1 FROM pragma_table_xinfo('music_tracks', 'main') WHERE name = '_rowid_' COLLATE NOCASE)
      AND (SELECT COUNT(*) FROM pragma_table_xinfo('music_tracks', 'main')
        WHERE name IN ('artist_id','album_id') AND type = 'TEXT' COLLATE NOCASE) = 2`).get()) return null;
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args);
    if (plan[0]?.detail !== "SEARCH t USING INDEX idx_music_tracks_album_sort (status=?)"
      || plan.some(row => row.detail.includes("TEMP B-TREE"))) return null;
    // The original ascending album index keeps equal sort keys in rowid order.
    const favoriteSql = sql
      .replace("FROM music_tracks t", "FROM music_track_state s INDEXED BY idx_music_track_state_favorite CROSS JOIN music_tracks t ON s.track_id = t.id")
      .replace("LEFT JOIN music_track_state s ON s.track_id = t.id", "")
      .replace(FAVORITE_QUEUE_PREDICATE, `${FAVORITE_QUEUE_PREDICATE} AND s.favorite = 1`)
      .replace(`ORDER BY ${ALBUM_QUEUE_ORDER}`, `ORDER BY ${ALBUM_QUEUE_ORDER}, t._rowid_ ASC`);
    return prepare(db, favoriteSql);
  } catch {
    return null;
  }
}
