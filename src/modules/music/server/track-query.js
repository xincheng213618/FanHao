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
