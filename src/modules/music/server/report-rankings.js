import { ALBUM_FACET_COLUMNS, prepareAlbumFacet } from "./facets.js";

function sparseReportEligible(database, hasUniqueTrackJoins) {
  try {
    const sample = database.prepare(`
      SELECT COUNT(*) AS count,
             COUNT(NULLIF(COALESCE(last_played_at, ''), '')) AS dated,
             COUNT(DISTINCT NULLIF(COALESCE(last_played_at, ''), '')) AS distinct_dates,
             COUNT(CASE WHEN typeof(play_count) NOT IN ('integer', 'null') OR COALESCE(play_count, 0) < 0
                  OR typeof(last_played_at) NOT IN ('text', 'null')
                  OR (COALESCE(play_count, 0) > 0 AND COALESCE(last_played_at, '') = '') THEN 1 END) AS invalid
      FROM (SELECT play_count, last_played_at FROM music_track_state LIMIT 1025)
    `).get();
    // Missing state contributes neither plays nor a timestamp beyond ''. A
    // distinct nonempty maximum also identifies the same album's bare artist
    // column and makes the previous ranking order independent of row traversal.
    if (sample.count > 1024 || sample.invalid || sample.dated !== sample.distinct_dates || !hasUniqueTrackJoins(database)) return false;
    if (database.prepare(`SELECT 1 FROM temp.sqlite_schema
      WHERE name COLLATE NOCASE IN ('music_tracks', 'music_track_state', 'music_artists', 'music_albums') LIMIT 1`).get()) return false;
    const index = database.prepare("PRAGMA main.index_list(music_tracks)").all().find(row => row.name === "idx_music_tracks_artist");
    const leading = index?.partial === 0 ? database.prepare("PRAGMA main.index_xinfo(idx_music_tracks_artist)").get() : null;
    if (leading?.name !== "artist_id" || leading.coll !== "BINARY" || leading.seqno !== 0 || leading.key !== 1) return false;
    return !database.prepare(`
      SELECT 1 FROM music_track_state s
      CROSS JOIN music_tracks t ON t.id = s.track_id
      LEFT JOIN music_artists a ON a.id = t.artist_id
      LEFT JOIN music_albums al ON al.id = t.album_id
      WHERE t.status = 'ok' AND COALESCE(s.play_count, 0) > 0 AND (a.id IS NULL OR al.id IS NULL)
      LIMIT 1
    `).get();
  } catch {
    return false;
  }
}

export function sparseMusicReportRankings(database, hasUniqueTrackJoins) {
  if (database.isTransaction) return null;
  database.exec("SAVEPOINT music_report_rankings");
  try {
    if (!sparseReportEligible(database, hasUniqueTrackJoins)) return null;
    const artists = database.prepare(`
      WITH ranked AS MATERIALIZED (
        SELECT a.id, a.name, COALESCE(SUM(s.play_count), 0) AS plays,
               MAX(COALESCE(s.last_played_at, '')) AS last_played_at
        FROM music_track_state s CROSS JOIN music_tracks t ON t.id = s.track_id
        LEFT JOIN music_artists a ON a.id = t.artist_id
        WHERE t.status = 'ok'
        GROUP BY a.id HAVING plays > 0
        ORDER BY plays DESC, last_played_at DESC, a.name COLLATE NOCASE
        LIMIT 8
      )
      SELECT id, name, (
        SELECT COUNT(DISTINCT counted.id) FROM main.music_tracks counted INDEXED BY idx_music_tracks_artist
        WHERE counted.artist_id COLLATE BINARY = ranked.id AND counted.status = 'ok'
      ) AS track_count, plays, last_played_at
      FROM ranked ORDER BY plays DESC, last_played_at DESC, name COLLATE NOCASE
    `).all();
    const albums = prepareAlbumFacet(database, `
      SELECT ${ALBUM_FACET_COLUMNS}, a.name AS artist_name,
             COALESCE(SUM(s.play_count), 0) AS plays,
             MAX(COALESCE(s.last_played_at, '')) AS last_played_at
      FROM music_track_state s CROSS JOIN music_tracks t ON t.id = s.track_id
      LEFT JOIN music_albums al ON al.id = t.album_id
      LEFT JOIN music_artists a ON a.id = t.artist_id
      WHERE t.status = 'ok'
      GROUP BY al.id HAVING plays > 0
      ORDER BY plays DESC, last_played_at DESC, al.title COLLATE NOCASE
      LIMIT 8
    `).all();
    return { artists, albums };
  } finally {
    database.exec("RELEASE music_report_rankings");
  }
}
