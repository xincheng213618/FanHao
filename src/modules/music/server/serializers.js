// Music store sub-module: serializers
import { DEFAULT_LIMIT } from "./constants.js";
import { normalizeTrackSort, parseJsonArray, trackOrderSql } from "./helpers.js";
import { catalogFilter } from "./query.js";
import { findSmartMix } from "./smart-mix.js";
import { musicSearchIndexJoin, musicSearchIndexRank, searchRankSql } from "./search.js";
import { coverStampFor } from "./scan.js";

export function trackRow(db, trackId) {
  return (
    db
      .prepare(
        `
        SELECT t.*, a.name AS artist_name, al.title AS album_name, al.cover_path,
               s.favorite, s.rating, s.position_ms, s.duration_ms AS state_duration_ms,
               s.play_count, s.last_played_at
        FROM music_tracks t
        LEFT JOIN music_artists a ON a.id = t.artist_id
        LEFT JOIN music_albums al ON al.id = t.album_id
        LEFT JOIN music_track_state s ON s.track_id = t.id
        WHERE t.id = ? AND t.status = 'ok'
      `
      )
      .get(trackId) || null
  );
}


export function lyricsForTrack(db, trackId) {
  const row = db.prepare("SELECT * FROM music_lyrics WHERE track_id = ?").get(trackId);
  if (!row) return { raw: "", lines: [] };
  return {
    raw: row.raw_text || "",
    path: row.lrc_path || "",
    lines: parseJsonArray(row.parsed_json)
  };
}


export function adjacentTracks(db, trackId, urlOrOptions = {}) {
  const params = urlOrOptions?.searchParams || new URLSearchParams();
  const playlistId = String(params.get("playlist") || params.get("playlistId") || "").trim();
  if (playlistId) {
    const rows = db
      .prepare(
        `
        SELECT t.id
        FROM music_playlist_items i
        JOIN music_tracks t ON t.id = i.track_id
        WHERE i.playlist_id = ? AND t.status = 'ok'
        ORDER BY i.sort_order ASC, i.added_at ASC
        LIMIT 2000
      `
      )
      .all(playlistId);
    const index = rows.findIndex((row) => row.id === trackId);
    return {
      prevId: index > 0 ? rows[index - 1].id : "",
      nextId: index >= 0 && index < rows.length - 1 ? rows[index + 1].id : ""
    };
  }
  const filter = catalogFilter(params);
  const smartMix = findSmartMix(params.get("smart") || params.get("smartId"));
  const rank = filter.q && !smartMix && !params.has("sort")
    ? (filter.searchKind ? musicSearchIndexRank(filter.searchKind, filter.q) : searchRankSql(filter.q))
    : { sql: "", args: [] };
  const where = filter.trackWhere ? `WHERE ${filter.trackWhere}` : "";
  const searchJoin = musicSearchIndexJoin(filter.searchKind);
  const rows = db
    .prepare(
      `
      SELECT t.id
      FROM music_tracks t
      ${searchJoin}
      LEFT JOIN music_track_state s ON s.track_id = t.id
      ${where}
      ORDER BY ${smartMix?.order || rank.sql || trackOrderSql(normalizeTrackSort(params.get("sort")))}
      LIMIT 2000
    `
    )
    .all(...filter.trackArgs, ...rank.args);
  const index = rows.findIndex((row) => row.id === trackId);
  return {
    prevId: index > 0 ? rows[index - 1].id : "",
    nextId: index >= 0 && index < rows.length - 1 ? rows[index + 1].id : ""
  };
}


export function publicArtist(row) {
  return {
    id: row.id || "",
    name: row.name || "",
    language: row.language || "其他",
    albumCount: Number(row.album_count || 0),
    trackCount: Number(row.track_count || 0),
    durationMs: Number(row.duration_ms || 0),
    sizeBytes: Number(row.size_bytes || 0)
  };
}


export function publicReportArtist(row) {
  return {
    id: row.id || "",
    name: row.name || "未知歌手",
    trackCount: Number(row.track_count || 0),
    plays: Number(row.plays || 0),
    lastPlayedAt: row.last_played_at || ""
  };
}


export function publicAlbum(row, options = {}) {
  const id = row.id || "";
  const coverStamp = coverStampFor(row.cover_path, row.updated_at);
  return {
    id,
    artistId: row.artist_id || "",
    artistName: row.artist_name || "",
    title: row.title || "",
    year: row.year || "",
    coverUrl: row.cover_path ? `/media/music-cover/${encodeURIComponent(id)}${coverStamp ? `?v=${encodeURIComponent(coverStamp)}` : ""}` : "",
    trackCount: Number(row.track_count || 0),
    durationMs: Number(row.duration_ms || 0),
    sizeBytes: Number(row.size_bytes || 0),
    updatedAt: row.updated_at || "",
    ...(options.detail ? {
      intro: row.intro_text || "",
      introPath: row.intro_path || "",
      sourcePath: row.source_path || "",
      relativePath: row.relative_path || ""
    } : {})
  };
}


export function publicPlaylist(row) {
  const id = row.id || "";
  return {
    id,
    name: row.name || "",
    description: row.description || "",
    trackCount: Number(row.track_count || 0),
    exportUrl: id ? `/api/music/playlists/${encodeURIComponent(id)}/export.m3u8` : "",
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || ""
  };
}


export function publicGenre(row) {
  return {
    id: row.name || "",
    name: row.name || "",
    trackCount: Number(row.track_count || 0),
    artistCount: Number(row.artist_count || 0),
    albumCount: Number(row.album_count || 0),
    durationMs: Number(row.duration_ms || 0),
    sizeBytes: Number(row.size_bytes || 0)
  };
}


export function publicSmartPlaylist(mix, count = 0) {
  return {
    id: mix.id || "",
    name: mix.name || "",
    description: mix.description || "",
    badge: mix.badge || "",
    trackCount: Number(count || 0),
    limit: Number(mix.limit || DEFAULT_LIMIT)
  };
}


export function publicTrack(row, options = {}) {
  const id = row.id || "";
  const albumId = row.album_id || "";
  const coverStamp = coverStampFor(row.cover_path, row.cover_updated_at);
  return {
    id,
    artistId: row.artist_id || "",
    albumId,
    title: row.title || "",
    artist: row.display_artist || row.artist_name || "",
    album: row.album_title || row.album_name || "",
    trackNo: Number(row.track_no || 0),
    discNo: Number(row.disc_no || 0),
    genre: row.genre || "",
    language: row.language || "其他",
    durationMs: Number(row.duration_ms || row.state_duration_ms || 0),
    codec: row.codec || "",
    sampleRate: Number(row.sample_rate || 0),
    bitDepth: Number(row.bit_depth || 0),
    channels: Number(row.channels || 0),
    hasLyrics: Boolean(row.has_lrc),
    streamUrl: `/media/music/${encodeURIComponent(id)}`,
    downloadUrl: `/media/music-download/${encodeURIComponent(id)}`,
    coverUrl: row.cover_path ? `/media/music-cover/${encodeURIComponent(albumId)}${coverStamp ? `?v=${encodeURIComponent(coverStamp)}` : ""}` : "",
    favorite: Boolean(row.favorite),
    rating: Number(row.rating || 0),
    positionMs: Number(row.position_ms || 0),
    playCount: Number(row.play_count || 0),
    lastPlayedAt: row.last_played_at || "",
    fileName: row.file_name || "",
    sizeBytes: Number(row.size_bytes || 0),
    ...(options.detail
      ? {
          sourcePath: row.source_path || "",
          relativePath: row.relative_path || "",
          lrcPath: row.lrc_path || "",
          mtimeMs: Number(row.mtime_ms || 0),
          updatedAt: row.updated_at || ""
        }
      : {})
  };
}
