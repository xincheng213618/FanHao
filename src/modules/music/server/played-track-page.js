// State rows are usually much smaller than the catalogue. Preserve non-null
// empty timestamps, which the public sort places before tracks without state.
export function playedTrackPageIds(database, filter, limit, offset) {
  if (filter.q || filter.smartId) return null;
  const rows = database.prepare(`
    SELECT t.id
    FROM music_track_state s INDEXED BY idx_music_track_state_played
    CROSS JOIN music_tracks t ON t.id = s.track_id
    WHERE ${filter.trackWhere} AND s.last_played_at IS NOT NULL
    ORDER BY s.last_played_at DESC, t.album_title COLLATE NOCASE ASC, t.track_no ASC
    LIMIT ? OFFSET ?
  `).all(...filter.trackArgs, limit, offset);
  // A page that crosses into NULL timestamps must retain the original
  // catalogue ordering and OFFSET semantics, including missing state rows.
  if (rows.length < limit) return null;
  return rows.map((row) => row.id);
}
