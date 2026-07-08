import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const AUDIO_EXTS = new Set([".flac", ".mp3", ".m4a", ".aac", ".wav", ".ogg", ".opus"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const DEFAULT_LIMIT = 600;
const MAX_LIMIT = 2000;
const MAX_LYRIC_BYTES = 1024 * 1024;
const MAX_INTRO_BYTES = 512 * 1024;
const KUWO_UTF16LE_PREFIX = Buffer.from([0x77, 0x91, 0x11, 0x62, 0xf3, 0x97, 0x50, 0x4e]);
const REDISCOVER_DAYS = 30;
const MUSIC_GENRE_ALIASES = new Map([
  ["c-pop", "华语流行"],
  ["cpop", "华语流行"],
  ["mandopop", "华语流行"],
  ["chinese pop", "华语流行"],
  ["pop", "流行"],
  ["folk", "民谣"],
  ["rock", "摇滚"],
  ["r&b", "R&B/嘻哈"],
  ["hip-hop", "R&B/嘻哈"],
  ["hip hop", "R&B/嘻哈"],
  ["rap", "R&B/嘻哈"],
  ["dj", "DJ/Remix"],
  ["remix", "DJ/Remix"],
  ["live", "现场"],
  ["instrumental", "轻音乐"]
]);
const MUSIC_TITLE_GENRE_HINTS = [
  { genre: "DJ/Remix", pattern: /\b(?:dj|remix|club mix|mix)\b|混音|电音|舞曲/iu },
  { genre: "现场", pattern: /\b(?:live|concert|unplugged)\b|演唱会|现场|巡回|巡演|音乐节|不插电|海宁站|重庆演出/iu },
  { genre: "伴奏", pattern: /伴奏|karaoke|off vocal/iu },
  { genre: "轻音乐", pattern: /纯音乐|钢琴曲|piano|instrumental/iu }
];
const MUSIC_ARTIST_GENRE_HINTS = [
  { genre: "民谣", pattern: /许巍|海来阿木|赵雷|马頔|宋冬野|尧十三/iu },
  { genre: "摇滚", pattern: /崔健|黑豹|唐朝|beyond|逃跑计划|新裤子|万能青年旅店/iu },
  { genre: "R&B/嘻哈", pattern: /周杰伦|jay\s*chou|陶喆|方大同|王力宏|潘玮柏/iu },
  { genre: "华语流行", pattern: /s\.?\s*h\.?\s*e|田馥甄|hebe|selina|ella|张韶涵|戴佩妮|梁静茹|孙燕姿|蔡依林|王菲|陈奕迅|五月天|林俊杰/iu }
];
const SMART_MIXES = [
  {
    id: "recent",
    name: "最近播放",
    description: "按最近播放时间自动更新，适合继续刚才的听歌顺序。",
    badge: "继续听",
    order: "s.last_played_at DESC, t.album_title COLLATE NOCASE ASC, t.track_no ASC",
    limit: 120
  },
  {
    id: "favorites",
    name: "我喜欢",
    description: "所有已收藏歌曲，按最近收藏或更新靠前。",
    badge: "收藏",
    order: "s.updated_at DESC, t.title COLLATE NOCASE ASC",
    limit: 200
  },
  {
    id: "toprated",
    name: "高分精选",
    description: "4 星及以上歌曲，按评分和更新时间排序。",
    badge: "4★+",
    order: "COALESCE(s.rating, 0) DESC, s.updated_at DESC, t.title COLLATE NOCASE ASC",
    limit: 200
  },
  {
    id: "unrated",
    name: "待评分",
    description: "还没有评分的歌曲，适合边听边整理。",
    badge: "待评",
    order: "t.album_title COLLATE NOCASE ASC, t.disc_no ASC, t.track_no ASC, t.title COLLATE NOCASE ASC",
    limit: 240
  },
  {
    id: "hires",
    name: "无损与高解析",
    description: "FLAC、WAV、ALAC 或 24bit/48kHz 以上音频。",
    badge: "Hi-Res",
    order: "COALESCE(t.bit_depth, 0) DESC, COALESCE(t.sample_rate, 0) DESC, t.album_title COLLATE NOCASE ASC, t.track_no ASC",
    limit: 240
  },
  {
    id: "lyrics",
    name: "带歌词",
    description: "已匹配 LRC 歌词的歌曲，适合沉浸播放。",
    badge: "LRC",
    order: "t.album_title COLLATE NOCASE ASC, t.disc_no ASC, t.track_no ASC, t.title COLLATE NOCASE ASC",
    limit: 240
  },
  {
    id: "longform",
    name: "长曲沉浸",
    description: "5 分钟以上的长曲，按时长优先。",
    badge: "5min+",
    order: "t.duration_ms DESC, t.title COLLATE NOCASE ASC",
    limit: 160
  },
  {
    id: "rediscover",
    name: "重温收藏",
    description: "收藏或听过、但最近 30 天没有播放的歌曲。",
    badge: "重温",
    order: "COALESCE(s.last_played_at, '') ASC, COALESCE(s.updated_at, '') DESC, t.title COLLATE NOCASE ASC",
    limit: 160
  }
];

export function createMusicStore(options = {}) {
  const dbPath = options.dbPath;
  const roots = normalizeRoots(options.roots || []);
  const ffprobePath = options.ffprobePath || "ffprobe";
  if (!dbPath) throw new Error("music dbPath is required");

  let db = null;

  function database() {
    if (!db) {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      db = new DatabaseSync(dbPath);
      ensureSchema(db);
    }
    return db;
  }

  function invalidate() {
    if (!db) return;
    try {
      db.close();
    } catch {}
    db = null;
  }

  function summary() {
    const database = dbOrOpen();
    const totals =
      database
        .prepare(
          `
          SELECT
            COUNT(*) AS tracks,
            COUNT(DISTINCT artist_id) AS artists,
            COUNT(DISTINCT album_id) AS albums,
            COALESCE(SUM(size_bytes), 0) AS bytes,
            COALESCE(SUM(duration_ms), 0) AS durationMs
          FROM music_tracks
          WHERE status = 'ok'
        `
        )
        .get() || {};
    const recent = database
      .prepare(
        `
        SELECT t.*, a.name AS artist_name, al.title AS album_name, al.cover_path,
               s.favorite, s.rating, s.position_ms, s.duration_ms AS state_duration_ms,
               s.play_count, s.last_played_at
        FROM music_track_state s
        JOIN music_tracks t ON t.id = s.track_id
        LEFT JOIN music_artists a ON a.id = t.artist_id
        LEFT JOIN music_albums al ON al.id = t.album_id
        WHERE t.status = 'ok' AND COALESCE(s.last_played_at, '') <> ''
        ORDER BY s.last_played_at DESC
        LIMIT 8
      `
      )
      .all()
      .map(publicTrack);
    return {
      dbPath,
      roots: roots.map(rootStatus),
      scannedAt: metaValue(database, "scanned_at"),
      totals: {
        tracks: Number(totals.tracks || 0),
        artists: Number(totals.artists || 0),
        albums: Number(totals.albums || 0),
        bytes: Number(totals.bytes || 0),
        durationMs: Number(totals.durationMs || 0)
      },
      recent
    };
  }

  function facets() {
    const database = dbOrOpen();
    return {
      summary: summary(),
      artists: artistFacet(database),
      albums: albumFacet(database),
      genres: genreFacet(database)
    };
  }

  function listArtists(urlOrOptions = {}) {
    const params = urlOrOptions?.searchParams || new URLSearchParams();
    const query = String(params.get("q") || params.get("search") || "").trim();
    const limit = clampInt(params.get("limit"), 200, 1, MAX_LIMIT);
    const conditions = ["track_count > 0"];
    const args = [];
    if (query) {
      conditions.push("name LIKE ? ESCAPE '\\'");
      args.push(`%${escapeLike(query)}%`);
    }
    const rows = dbOrOpen()
      .prepare(
        `
        SELECT *
        FROM music_artists
        WHERE ${conditions.join(" AND ")}
        ORDER BY track_count DESC, name COLLATE NOCASE
        LIMIT ?
      `
      )
      .all(...args, limit);
    return {
      artists: rows.map(publicArtist),
      total: rows.length,
      query,
      summary: summary()
    };
  }

  function listAlbums(urlOrOptions = {}) {
    const params = urlOrOptions?.searchParams || new URLSearchParams();
    const filter = catalogFilter(params);
    const limit = clampInt(params.get("limit"), 400, 1, MAX_LIMIT);
    const sort = normalizeAlbumSort(params.get("sort"));
    const where = filter.albumWhere ? `WHERE ${filter.albumWhere}` : "";
    const order = {
      title: "al.title COLLATE NOCASE ASC",
      year: "COALESCE(al.year, '') DESC, al.title COLLATE NOCASE ASC",
      tracks: "al.track_count DESC, al.title COLLATE NOCASE ASC",
      updated: "al.updated_at DESC, al.title COLLATE NOCASE ASC"
    }[sort] || "al.updated_at DESC, al.title COLLATE NOCASE ASC";
    const rows = dbOrOpen()
      .prepare(
        `
        SELECT al.*, a.name AS artist_name
        FROM music_albums al
        LEFT JOIN music_artists a ON a.id = al.artist_id
        ${where}
        ORDER BY ${order}
        LIMIT ?
      `
      )
      .all(...filter.albumArgs, limit);
    return {
      albums: rows.map(publicAlbum),
      total: rows.length,
      query: filter.q,
      artistId: filter.artistId,
      genre: filter.genre,
      sort,
      summary: summary()
    };
  }

  function listTracks(urlOrOptions = {}) {
    const params = urlOrOptions?.searchParams || new URLSearchParams();
    const filter = catalogFilter(params);
    const smartMix = findSmartMix(filter.smartId);
    const sort = normalizeTrackSort(params.get("sort"));
    const limit = clampInt(params.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const where = filter.trackWhere ? `WHERE ${filter.trackWhere}` : "";
    const order = smartMix ? smartMix.order : trackOrderSql(sort);
    const database = dbOrOpen();
    const total = database.prepare(`SELECT COUNT(*) AS count FROM music_tracks t LEFT JOIN music_track_state s ON s.track_id = t.id ${where}`).get(...filter.trackArgs)?.count || 0;
    const rows = database
      .prepare(
        `
        SELECT t.*, a.name AS artist_name, al.title AS album_name, al.cover_path,
               s.favorite, s.rating, s.position_ms, s.duration_ms AS state_duration_ms,
               s.play_count, s.last_played_at
        FROM music_tracks t
        LEFT JOIN music_artists a ON a.id = t.artist_id
        LEFT JOIN music_albums al ON al.id = t.album_id
        LEFT JOIN music_track_state s ON s.track_id = t.id
        ${where}
        ORDER BY ${order}
        LIMIT ? OFFSET ?
      `
      )
      .all(...filter.trackArgs, limit, offset);
    return {
      tracks: rows.map(publicTrack),
      total: Number(total || 0),
      limit,
      offset,
      hasMore: offset + rows.length < Number(total || 0),
      query: filter.q,
      artistId: filter.artistId,
      albumId: filter.albumId,
      genre: filter.genre,
      favorite: filter.favorite,
      smartId: filter.smartId,
      smartPlaylist: smartMix ? publicSmartPlaylist(smartMix, total) : null,
      sort,
      summary: summary(),
      artists: artistFacet(database),
      albums: albumFacet(database, filter.artistId, filter.genre),
      genres: genreFacet(database, filter.artistId)
    };
  }

  function trackDetail(trackId, urlOrOptions = {}) {
    const database = dbOrOpen();
    const row = trackRow(database, trackId);
    if (!row) return null;
    const lyrics = lyricsForTrack(database, row.id);
    const adjacent = adjacentTracks(database, row.id, urlOrOptions);
    return {
      track: publicTrack(row, { detail: true }),
      lyrics,
      prevId: adjacent.prevId,
      nextId: adjacent.nextId
    };
  }

  function saveProgress(trackId, body = {}) {
    const database = dbOrOpen();
    const row = database.prepare("SELECT id, duration_ms FROM music_tracks WHERE id = ? AND status = 'ok'").get(trackId);
    if (!row) return null;
    const positionMs = clampInt(body.positionMs ?? body.position_ms, 0, 0, Number.MAX_SAFE_INTEGER);
    const durationMs = clampInt(body.durationMs ?? body.duration_ms, Number(row.duration_ms || 0), 0, Number.MAX_SAFE_INTEGER);
    const played = Boolean(body.played);
    const now = new Date().toISOString();
    const current = database.prepare("SELECT play_count FROM music_track_state WHERE track_id = ?").get(row.id);
    database
      .prepare(
        `
        INSERT INTO music_track_state (track_id, favorite, position_ms, duration_ms, play_count, last_played_at, updated_at)
        VALUES (?, 0, ?, ?, ?, ?, ?)
        ON CONFLICT(track_id) DO UPDATE SET
          position_ms = excluded.position_ms,
          duration_ms = excluded.duration_ms,
          play_count = CASE WHEN ? THEN COALESCE(music_track_state.play_count, 0) + 1 ELSE COALESCE(music_track_state.play_count, 0) END,
          last_played_at = CASE WHEN ? THEN excluded.last_played_at ELSE COALESCE(music_track_state.last_played_at, '') END,
          updated_at = excluded.updated_at
      `
      )
      .run(row.id, positionMs, durationMs, played ? Number(current?.play_count || 0) + 1 : Number(current?.play_count || 0), played ? now : "", now, played ? 1 : 0, played ? 1 : 0);
    return publicTrack(trackRow(database, row.id), { detail: true });
  }

  function toggleFavorite(trackId, body = {}) {
    const database = dbOrOpen();
    const row = database.prepare("SELECT id, duration_ms FROM music_tracks WHERE id = ? AND status = 'ok'").get(trackId);
    if (!row) return null;
    const current = database.prepare("SELECT favorite FROM music_track_state WHERE track_id = ?").get(row.id);
    const favorite = Object.prototype.hasOwnProperty.call(body, "favorite") ? Boolean(body.favorite) : !Boolean(current?.favorite);
    const now = new Date().toISOString();
    database
      .prepare(
        `
        INSERT INTO music_track_state (track_id, favorite, position_ms, duration_ms, play_count, last_played_at, updated_at)
        VALUES (?, ?, 0, ?, 0, '', ?)
        ON CONFLICT(track_id) DO UPDATE SET
          favorite = excluded.favorite,
          updated_at = excluded.updated_at
      `
      )
      .run(row.id, favorite ? 1 : 0, Number(row.duration_ms || 0), now);
    return publicTrack(trackRow(database, row.id), { detail: true });
  }

  function setRating(trackId, body = {}) {
    const database = dbOrOpen();
    const row = database.prepare("SELECT id, duration_ms FROM music_tracks WHERE id = ? AND status = 'ok'").get(trackId);
    if (!row) return null;
    const rating = clampInt(body.rating ?? body.stars ?? body.value, 0, 0, 5);
    const now = new Date().toISOString();
    database
      .prepare(
        `
        INSERT INTO music_track_state (track_id, favorite, rating, position_ms, duration_ms, play_count, last_played_at, updated_at)
        VALUES (?, 0, ?, 0, ?, 0, '', ?)
        ON CONFLICT(track_id) DO UPDATE SET
          rating = excluded.rating,
          updated_at = excluded.updated_at
      `
      )
      .run(row.id, rating, Number(row.duration_ms || 0), now);
    return publicTrack(trackRow(database, row.id), { detail: true });
  }

  function listHistory(urlOrOptions = {}) {
    const params = urlOrOptions?.searchParams || new URLSearchParams();
    const limit = clampInt(params.get("limit"), 100, 1, MAX_LIMIT);
    const database = dbOrOpen();
    const rows = database
      .prepare(
        `
        SELECT t.*, a.name AS artist_name, al.title AS album_name, al.cover_path,
               s.favorite, s.rating, s.position_ms, s.duration_ms AS state_duration_ms,
               s.play_count, s.last_played_at
        FROM music_track_state s
        JOIN music_tracks t ON t.id = s.track_id
        LEFT JOIN music_artists a ON a.id = t.artist_id
        LEFT JOIN music_albums al ON al.id = t.album_id
        WHERE t.status = 'ok' AND COALESCE(s.last_played_at, '') <> ''
        ORDER BY s.last_played_at DESC
        LIMIT ?
      `
      )
      .all(limit);
    return {
      tracks: rows.map(publicTrack),
      total: rows.length,
      limit,
      summary: summary(),
      artists: artistFacet(database),
      albums: albumFacet(database),
      genres: genreFacet(database)
    };
  }

  function clearHistory() {
    dbOrOpen()
      .prepare(
        `
        UPDATE music_track_state
        SET last_played_at = '', play_count = 0, updated_at = ?
        WHERE COALESCE(last_played_at, '') <> '' OR COALESCE(play_count, 0) > 0
      `
      )
      .run(new Date().toISOString());
    return { ok: true };
  }

  function listPlaylists() {
    const database = dbOrOpen();
    const rows = database
      .prepare(
        `
        SELECT p.*, COUNT(i.track_id) AS track_count
        FROM music_playlists p
        LEFT JOIN music_playlist_items i ON i.playlist_id = p.id
        GROUP BY p.id
        ORDER BY p.updated_at DESC, p.created_at DESC
      `
      )
      .all();
    return { playlists: rows.map(publicPlaylist), total: rows.length };
  }

  function listSmartPlaylists() {
    const database = dbOrOpen();
    const smartPlaylists = SMART_MIXES.map((mix) => publicSmartPlaylist(mix, smartMixCount(database, mix)));
    return {
      smartPlaylists,
      total: smartPlaylists.length,
      summary: summary()
    };
  }

  function smartPlaylistDetail(smartPlaylistId, urlOrOptions = {}) {
    const mix = findSmartMix(smartPlaylistId);
    if (!mix) return null;
    const params = urlOrOptions?.searchParams || new URLSearchParams();
    const limit = clampInt(params.get("limit"), mix.limit || DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const database = dbOrOpen();
    const condition = smartMixCondition(mix);
    const where = `WHERE t.status = 'ok' AND ${condition.where}`;
    const total = database.prepare(`SELECT COUNT(*) AS count FROM music_tracks t LEFT JOIN music_track_state s ON s.track_id = t.id ${where}`).get(...condition.args)?.count || 0;
    const rows = database
      .prepare(
        `
        SELECT t.*, a.name AS artist_name, al.title AS album_name, al.cover_path,
               s.favorite, s.rating, s.position_ms, s.duration_ms AS state_duration_ms,
               s.play_count, s.last_played_at
        FROM music_tracks t
        LEFT JOIN music_artists a ON a.id = t.artist_id
        LEFT JOIN music_albums al ON al.id = t.album_id
        LEFT JOIN music_track_state s ON s.track_id = t.id
        ${where}
        ORDER BY ${mix.order}
        LIMIT ? OFFSET ?
      `
      )
      .all(...condition.args, limit, offset);
    return {
      smartPlaylist: publicSmartPlaylist(mix, total),
      tracks: rows.map(publicTrack),
      total: Number(total || 0),
      limit,
      offset,
      hasMore: offset + rows.length < Number(total || 0),
      summary: summary(),
      artists: artistFacet(database),
      albums: albumFacet(database),
      genres: genreFacet(database)
    };
  }

  function createPlaylist(input = {}) {
    const name = String(typeof input === "string" ? input : input.name || "").trim().slice(0, 80);
    if (!name) throw httpError(400, "歌单名称不能为空");
    const now = new Date().toISOString();
    const id = hashText(`playlist:${now}:${name}:${crypto.randomBytes(8).toString("hex")}`).slice(0, 20);
    dbOrOpen()
      .prepare("INSERT INTO music_playlists (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, name, String(input.description || "").trim().slice(0, 300), now, now);
    return playlistDetail(id);
  }

  function playlistDetail(playlistId) {
    const database = dbOrOpen();
    const row = database.prepare("SELECT * FROM music_playlists WHERE id = ?").get(playlistId);
    if (!row) return null;
    const tracks = database
      .prepare(
        `
        SELECT t.*, a.name AS artist_name, al.title AS album_name, al.cover_path,
               s.favorite, s.rating, s.position_ms, s.duration_ms AS state_duration_ms,
               s.play_count, s.last_played_at,
               i.sort_order, i.added_at
        FROM music_playlist_items i
        JOIN music_tracks t ON t.id = i.track_id
        LEFT JOIN music_artists a ON a.id = t.artist_id
        LEFT JOIN music_albums al ON al.id = t.album_id
        LEFT JOIN music_track_state s ON s.track_id = t.id
        WHERE i.playlist_id = ? AND t.status = 'ok'
        ORDER BY i.sort_order ASC, i.added_at ASC
      `
      )
      .all(row.id)
      .map(publicTrack);
    return {
      playlist: publicPlaylist({ ...row, track_count: tracks.length }),
      tracks,
      total: tracks.length,
      summary: summary(),
      artists: artistFacet(database),
      albums: albumFacet(database),
      genres: genreFacet(database)
    };
  }

  function playlistM3u(playlistId, options = {}) {
    const database = dbOrOpen();
    const row = database.prepare("SELECT * FROM music_playlists WHERE id = ?").get(playlistId);
    if (!row) return null;
    const mode = String(options.pathMode || options.path || "").trim().toLowerCase() === "relative" ? "relative" : "absolute";
    const tracks = database
      .prepare(
        `
        SELECT t.title, t.display_artist, t.duration_ms, t.source_path, t.relative_path, t.file_name,
               i.sort_order, i.added_at
        FROM music_playlist_items i
        JOIN music_tracks t ON t.id = i.track_id
        WHERE i.playlist_id = ? AND t.status = 'ok'
        ORDER BY i.sort_order ASC, i.added_at ASC
      `
      )
      .all(row.id);
    return {
      fileName: `${safePlaylistFileName(row.name)}.m3u8`,
      content: formatM3uPlaylist(row, tracks, mode),
      trackCount: tracks.length,
      pathMode: mode
    };
  }

  function deletePlaylist(playlistId) {
    const database = dbOrOpen();
    const row = database.prepare("SELECT id FROM music_playlists WHERE id = ?").get(playlistId);
    if (!row) return null;
    database.prepare("DELETE FROM music_playlist_items WHERE playlist_id = ?").run(playlistId);
    database.prepare("DELETE FROM music_playlists WHERE id = ?").run(playlistId);
    return { ok: true };
  }

  function addToPlaylist(playlistId, trackId) {
    const database = dbOrOpen();
    const playlist = database.prepare("SELECT id FROM music_playlists WHERE id = ?").get(playlistId);
    if (!playlist) return null;
    const track = database.prepare("SELECT id FROM music_tracks WHERE id = ? AND status = 'ok'").get(trackId);
    if (!track) throw httpError(404, "歌曲不存在");
    const now = new Date().toISOString();
    const nextOrder = Number(database.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS value FROM music_playlist_items WHERE playlist_id = ?").get(playlistId)?.value || 1);
    database
      .prepare("INSERT OR IGNORE INTO music_playlist_items (playlist_id, track_id, sort_order, added_at) VALUES (?, ?, ?, ?)")
      .run(playlistId, track.id, nextOrder, now);
    database.prepare("UPDATE music_playlists SET updated_at = ? WHERE id = ?").run(now, playlistId);
    return playlistDetail(playlistId);
  }

  function removeFromPlaylist(playlistId, trackId) {
    const database = dbOrOpen();
    const playlist = database.prepare("SELECT id FROM music_playlists WHERE id = ?").get(playlistId);
    if (!playlist) return null;
    database.prepare("DELETE FROM music_playlist_items WHERE playlist_id = ? AND track_id = ?").run(playlistId, trackId);
    database.prepare("UPDATE music_playlists SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), playlistId);
    return playlistDetail(playlistId);
  }

  function trackFile(trackId) {
    const row = dbOrOpen().prepare("SELECT id, source_path, ext FROM music_tracks WHERE id = ? AND status = 'ok'").get(trackId);
    if (!row?.source_path) return null;
    return safeStoredFile(row.source_path, "audio", row.id);
  }

  function coverFile(albumId) {
    const row = dbOrOpen().prepare("SELECT id, cover_path FROM music_albums WHERE id = ?").get(albumId);
    if (!row?.cover_path) return null;
    return safeStoredFile(row.cover_path, "image", row.id);
  }

  function scan(input = {}) {
    const scanRoots = normalizeRoots(input.root ? [input.root] : input.roots?.length ? input.roots : roots);
    const limit = clampInt(input.limit, 0, 0, Number.MAX_SAFE_INTEGER);
    const dryRun = Boolean(input.dryRun || input.dry_run);
    if (!scanRoots.length) throw httpError(400, "没有配置音乐目录");
    const records = scanMusicRoots(scanRoots, { ffprobePath, limit });
    const result = scanSummary(records, scanRoots, dryRun);
    if (!dryRun) writeScanRecords(dbOrOpen(), records, scanRoots, result.scannedAt);
    return result;
  }

  function dbOrOpen() {
    return database();
  }

  return {
    coverFile,
    dbPath,
    facets,
    invalidate,
    addToPlaylist,
    clearHistory,
    createPlaylist,
    deletePlaylist,
    listHistory,
    listAlbums,
    listArtists,
    listPlaylists,
    listSmartPlaylists,
    listTracks,
    playlistDetail,
    playlistM3u,
    removeFromPlaylist,
    saveProgress,
    scan,
    smartPlaylistDetail,
    setRating,
    summary,
    toggleFavorite,
    trackDetail,
    trackFile
  };
}

function ensureSchema(db) {
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
  `);
  ensureColumn(db, "music_tracks", "genre", "TEXT");
  ensureColumn(db, "music_track_state", "rating", "INTEGER DEFAULT 0");
  db.exec("CREATE INDEX IF NOT EXISTS idx_music_tracks_genre ON music_tracks(genre);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_music_track_state_rating ON music_track_state(rating, updated_at);");
  backfillMissingTrackGenres(db);
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (columns.some((column) => column.name === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition};`);
}

function backfillMissingTrackGenres(db) {
  const rows = db
    .prepare(
      `
      SELECT id, title, display_artist, album_title, file_name, relative_path, genre
      FROM music_tracks
      WHERE status = 'ok' AND TRIM(COALESCE(genre, '')) = ''
    `
    )
    .all();
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

function scanMusicRoots(scanRoots, options = {}) {
  const ffprobePath = options.ffprobePath || "ffprobe";
  const limit = Number(options.limit || 0);
  const files = [];
  for (const root of scanRoots) {
    if (!safeStat(root)?.isDirectory()) continue;
    for (const filePath of walkFiles(root)) {
      if (!AUDIO_EXTS.has(path.extname(filePath).toLowerCase())) continue;
      files.push({ root, filePath });
      if (limit > 0 && files.length >= limit) break;
    }
    if (limit > 0 && files.length >= limit) break;
  }
  files.sort((a, b) => a.filePath.localeCompare(b.filePath, undefined, { numeric: true, sensitivity: "base" }));

  const now = new Date().toISOString();
  const dirCache = new Map();
  const artistMap = new Map();
  const albumMap = new Map();
  const tracks = [];
  const lyrics = [];

  for (const { root, filePath } of files) {
    const stat = safeStat(filePath);
    if (!stat?.isFile()) continue;
    const relativePath = path.relative(root, filePath);
    const parts = relativePath.split(/[\\/]/).filter(Boolean);
    const artistFolder = parts[0] || "未知歌手";
    const albumFolder = parts.length > 2 ? parts[parts.length - 2] : "单曲";
    const albumDir = path.dirname(filePath);
    const probe = probeAudio(filePath, ffprobePath);
    const parsedName = parseTrackName(path.basename(filePath, path.extname(filePath)));
    const artistName = cleanArtistName(probe.artist || parsedName.artist || artistFolder);
    const albumTitle = cleanAlbumTitle(probe.album || albumFolder);
    const artistPath = path.join(root, artistFolder);
    const artistId = hashText(`artist:${artistPath.toLowerCase()}`).slice(0, 20);
    const albumId = hashText(`album:${albumDir.toLowerCase()}`).slice(0, 20);
    const trackId = hashText(`track:${path.resolve(filePath).toLowerCase()}`).slice(0, 24);
    const trackTitle = cleanTrackTitle(probe.title || parsedName.title || path.basename(filePath, path.extname(filePath)));
    const trackGenre = musicGenreForTrack({
      genre: probe.genre,
      artistName,
      albumTitle,
      title: trackTitle,
      fileName: path.basename(filePath),
      relativePath
    });
    const albumFiles = cachedDirEntries(dirCache, albumDir);
    const lrcPath = findCompanionLyric(albumFiles, albumDir, filePath);
    const lyricText = lrcPath ? readSmallText(lrcPath, MAX_LYRIC_BYTES) : "";
    const parsedLyrics = parseLrc(lyricText);

    if (!artistMap.has(artistId)) {
      artistMap.set(artistId, {
        id: artistId,
        name: artistName,
        sortName: sortKey(artistName),
        sourceRoot: root,
        sourcePath: artistPath,
        relativePath: path.relative(root, artistPath),
        albumIds: new Set(),
        trackCount: 0,
        durationMs: 0,
        sizeBytes: 0,
        updatedAt: now
      });
    }

    if (!albumMap.has(albumId)) {
      const coverPath = findAlbumCover(albumFiles, albumDir, albumTitle);
      const introPath = findAlbumIntro(albumFiles, albumDir, albumTitle);
      albumMap.set(albumId, {
        id: albumId,
        artistId,
        title: albumTitle,
        sortTitle: sortKey(albumTitle),
        year: probe.year || yearFromText(albumTitle),
        coverPath,
        introPath,
        introText: introPath ? readSmallText(introPath, MAX_INTRO_BYTES) : "",
        sourceRoot: root,
        sourcePath: albumDir,
        relativePath: path.relative(root, albumDir),
        trackCount: 0,
        durationMs: 0,
        sizeBytes: 0,
        updatedAt: now
      });
    }

    const artist = artistMap.get(artistId);
    const album = albumMap.get(albumId);
    const durationMs = Number(probe.durationMs || 0);
    artist.albumIds.add(albumId);
    artist.trackCount += 1;
    artist.durationMs += durationMs;
    artist.sizeBytes += stat.size;
    album.trackCount += 1;
    album.durationMs += durationMs;
    album.sizeBytes += stat.size;

    tracks.push({
      id: trackId,
      artistId,
      albumId,
      title: trackTitle,
      sortTitle: sortKey(trackTitle),
      displayArtist: cleanArtistName(probe.artist || parsedName.artist || artistName),
      albumTitle,
      trackNo: probe.trackNo || parsedName.trackNo || 0,
      discNo: probe.discNo || 0,
      genre: trackGenre,
      sourceRoot: root,
      sourcePath: path.resolve(filePath),
      relativePath,
      fileName: path.basename(filePath),
      ext: path.extname(filePath).toLowerCase(),
      sizeBytes: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs || 0),
      durationMs,
      codec: probe.codec || "",
      sampleRate: probe.sampleRate || 0,
      bitDepth: probe.bitDepth || 0,
      channels: probe.channels || 0,
      lrcPath,
      hasLrc: lrcPath ? 1 : 0,
      status: "ok",
      error: probe.error || "",
      updatedAt: now
    });

    if (lrcPath || lyricText) {
      lyrics.push({
        trackId,
        lrcPath,
        rawText: lyricText,
        parsedJson: JSON.stringify(parsedLyrics),
        updatedAt: now
      });
    }
  }

  return {
    artists: [...artistMap.values()].map((artist) => ({ ...artist, albumCount: artist.albumIds.size })),
    albums: [...albumMap.values()],
    tracks,
    lyrics
  };
}

function writeScanRecords(db, records, scanRoots, scannedAt) {
  ensureSchema(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM music_search").run();
    db.prepare("DELETE FROM music_lyrics").run();
    db.prepare("DELETE FROM music_tracks").run();
    db.prepare("DELETE FROM music_albums").run();
    db.prepare("DELETE FROM music_artists").run();

    const insertArtist = db.prepare(`
      INSERT INTO music_artists (
        id, name, sort_name, source_root, source_path, relative_path, album_count,
        track_count, duration_ms, size_bytes, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?)
    `);
    for (const artist of records.artists) {
      insertArtist.run(
        artist.id,
        artist.name,
        artist.sortName,
        artist.sourceRoot,
        artist.sourcePath,
        artist.relativePath,
        artist.albumCount,
        artist.trackCount,
        artist.durationMs,
        artist.sizeBytes,
        artist.updatedAt
      );
    }

    const insertAlbum = db.prepare(`
      INSERT INTO music_albums (
        id, artist_id, title, sort_title, year, cover_path, intro_path, intro_text,
        source_root, source_path, relative_path, track_count, duration_ms, size_bytes, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const album of records.albums) {
      insertAlbum.run(
        album.id,
        album.artistId,
        album.title,
        album.sortTitle,
        album.year,
        album.coverPath,
        album.introPath,
        album.introText,
        album.sourceRoot,
        album.sourcePath,
        album.relativePath,
        album.trackCount,
        album.durationMs,
        album.sizeBytes,
        album.updatedAt
      );
    }

    const insertTrack = db.prepare(`
      INSERT INTO music_tracks (
        id, artist_id, album_id, title, sort_title, display_artist, album_title,
        track_no, disc_no, genre, source_root, source_path, relative_path, file_name,
        ext, size_bytes, mtime_ms, duration_ms, codec, sample_rate, bit_depth,
        channels, lrc_path, has_lrc, status, error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSearch = db.prepare(`
      INSERT INTO music_search (track_id, title, artist, album, lyrics)
      VALUES (?, ?, ?, ?, ?)
    `);
    const lyricByTrack = new Map(records.lyrics.map((lyric) => [lyric.trackId, lyric]));
    for (const track of records.tracks) {
      insertTrack.run(
        track.id,
        track.artistId,
        track.albumId,
        track.title,
        track.sortTitle,
        track.displayArtist,
        track.albumTitle,
        track.trackNo,
        track.discNo,
        track.genre,
        track.sourceRoot,
        track.sourcePath,
        track.relativePath,
        track.fileName,
        track.ext,
        track.sizeBytes,
        track.mtimeMs,
        track.durationMs,
        track.codec,
        track.sampleRate,
        track.bitDepth,
        track.channels,
        track.lrcPath,
        track.hasLrc,
        track.status,
        track.error,
        track.updatedAt
      );
      insertSearch.run(track.id, track.title, track.displayArtist, track.albumTitle, lyricByTrack.get(track.id)?.rawText || "");
    }

    const insertLyric = db.prepare(`
      INSERT INTO music_lyrics (track_id, lrc_path, raw_text, parsed_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const lyric of records.lyrics) {
      insertLyric.run(lyric.trackId, lyric.lrcPath, lyric.rawText, lyric.parsedJson, lyric.updatedAt);
    }

    db.prepare("INSERT OR REPLACE INTO music_meta (key, value) VALUES ('schema_version', '1')").run();
    db.prepare("INSERT OR REPLACE INTO music_meta (key, value) VALUES ('scanned_at', ?)").run(scannedAt);
    db.prepare("INSERT OR REPLACE INTO music_meta (key, value) VALUES ('roots_json', ?)").run(JSON.stringify(scanRoots));
    db.prepare("DELETE FROM music_playlist_items WHERE track_id NOT IN (SELECT id FROM music_tracks)").run();
    db.exec("COMMIT");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function scanSummary(records, scanRoots, dryRun) {
  const scannedAt = new Date().toISOString();
  return {
    ok: true,
    dryRun,
    roots: scanRoots.map(rootStatus),
    scannedAt,
    totals: {
      artists: records.artists.length,
      albums: records.albums.length,
      tracks: records.tracks.length,
      lyrics: records.lyrics.length,
      bytes: records.tracks.reduce((sum, item) => sum + Number(item.sizeBytes || 0), 0),
      durationMs: records.tracks.reduce((sum, item) => sum + Number(item.durationMs || 0), 0)
    }
  };
}

function trackRow(db, trackId) {
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

function lyricsForTrack(db, trackId) {
  const row = db.prepare("SELECT * FROM music_lyrics WHERE track_id = ?").get(trackId);
  if (!row) return { raw: "", lines: [] };
  return {
    raw: row.raw_text || "",
    path: row.lrc_path || "",
    lines: parseJsonArray(row.parsed_json)
  };
}

function adjacentTracks(db, trackId, urlOrOptions = {}) {
  const params = urlOrOptions?.searchParams || new URLSearchParams();
  const filter = catalogFilter(params);
  const smartMix = findSmartMix(params.get("smart") || params.get("smartId"));
  const where = filter.trackWhere ? `WHERE ${filter.trackWhere}` : "";
  const rows = db
    .prepare(
      `
      SELECT t.id
      FROM music_tracks t
      LEFT JOIN music_track_state s ON s.track_id = t.id
      ${where}
      ORDER BY ${smartMix?.order || trackOrderSql(normalizeTrackSort(params.get("sort")))}
      LIMIT 2000
    `
    )
    .all(...filter.trackArgs);
  const index = rows.findIndex((row) => row.id === trackId);
  return {
    prevId: index > 0 ? rows[index - 1].id : "",
    nextId: index >= 0 && index < rows.length - 1 ? rows[index + 1].id : ""
  };
}

function catalogFilter(params = new URLSearchParams()) {
  const q = String(params.get("q") || params.get("search") || "").trim();
  const artistId = String(params.get("artist") || params.get("artistId") || "").trim();
  const albumId = String(params.get("album") || params.get("albumId") || "").trim();
  const genre = String(params.get("genre") || params.get("musicGenre") || "").trim();
  const smartMix = findSmartMix(params.get("smart") || params.get("smartId"));
  const favorite = ["1", "true", "yes"].includes(String(params.get("favorite") || "").trim().toLowerCase());
  const trackWhere = ["t.status = 'ok'"];
  const trackArgs = [];
  const albumWhere = [];
  const albumArgs = [];
  if (artistId && artistId !== "all") {
    trackWhere.push("t.artist_id = ?");
    trackArgs.push(artistId);
    albumWhere.push("al.artist_id = ?");
    albumArgs.push(artistId);
  }
  if (albumId && albumId !== "all") {
    trackWhere.push("t.album_id = ?");
    trackArgs.push(albumId);
  }
  if (genre && genre !== "all") {
    trackWhere.push("t.genre = ? COLLATE NOCASE");
    trackArgs.push(genre);
    albumWhere.push("al.id IN (SELECT album_id FROM music_tracks WHERE status = 'ok' AND genre = ? COLLATE NOCASE)");
    albumArgs.push(genre);
  }
  if (favorite) {
    trackWhere.push("COALESCE(s.favorite, 0) = 1");
  }
  if (smartMix) {
    const condition = smartMixCondition(smartMix);
    trackWhere.push(condition.where);
    trackArgs.push(...condition.args);
  }
  if (q) {
    const like = `%${escapeLike(q)}%`;
    trackWhere.push(`(
      t.title LIKE ? ESCAPE '\\' OR
      t.display_artist LIKE ? ESCAPE '\\' OR
      t.album_title LIKE ? ESCAPE '\\' OR
      t.genre LIKE ? ESCAPE '\\' OR
      t.file_name LIKE ? ESCAPE '\\' OR
      t.id IN (SELECT track_id FROM music_search WHERE music_search MATCH ?)
    )`);
    trackArgs.push(like, like, like, like, like, ftsTerm(q));
    albumWhere.push(`(
      al.title LIKE ? ESCAPE '\\' OR
      a.name LIKE ? ESCAPE '\\'
    )`);
    albumArgs.push(like, like);
  }
  return {
    q,
    artistId,
    albumId,
    genre,
    smartId: smartMix?.id || "",
    favorite,
    trackWhere: trackWhere.join(" AND "),
    trackArgs,
    albumWhere: albumWhere.join(" AND "),
    albumArgs
  };
}

function artistFacet(db) {
  return db
    .prepare(
      `
      SELECT id, name, album_count, track_count, duration_ms, size_bytes
      FROM music_artists
      WHERE track_count > 0
      ORDER BY track_count DESC, name COLLATE NOCASE
      LIMIT 200
    `
    )
    .all()
    .map(publicArtist);
}

function albumFacet(db, artistId = "", genre = "") {
  const args = [];
  const where = [];
  if (artistId && artistId !== "all") {
    where.push("al.artist_id = ?");
    args.push(artistId);
  }
  if (genre && genre !== "all") {
    where.push("al.id IN (SELECT album_id FROM music_tracks WHERE status = 'ok' AND genre = ? COLLATE NOCASE)");
    args.push(genre);
  }
  return db
    .prepare(
      `
      SELECT al.*, a.name AS artist_name
      FROM music_albums al
      LEFT JOIN music_artists a ON a.id = al.artist_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY al.track_count DESC, al.title COLLATE NOCASE
      LIMIT 240
    `
    )
    .all(...args)
    .map(publicAlbum);
}

function genreFacet(db, artistId = "") {
  const args = [];
  const where = ["status = 'ok'", "TRIM(COALESCE(genre, '')) <> ''"];
  if (artistId && artistId !== "all") {
    where.push("artist_id = ?");
    args.push(artistId);
  }
  return db
    .prepare(
      `
      SELECT
        TRIM(genre) AS name,
        COUNT(*) AS track_count,
        COUNT(DISTINCT artist_id) AS artist_count,
        COUNT(DISTINCT album_id) AS album_count,
        COALESCE(SUM(duration_ms), 0) AS duration_ms,
        COALESCE(SUM(size_bytes), 0) AS size_bytes
      FROM music_tracks
      WHERE ${where.join(" AND ")}
      GROUP BY TRIM(genre) COLLATE NOCASE
      ORDER BY track_count DESC, name COLLATE NOCASE
      LIMIT 120
    `
    )
    .all(...args)
    .map(publicGenre);
}

function findSmartMix(id) {
  const value = String(id || "").trim().toLowerCase();
  return SMART_MIXES.find((mix) => mix.id === value) || null;
}

function smartMixCondition(mixOrId) {
  const mix = typeof mixOrId === "string" ? findSmartMix(mixOrId) : mixOrId;
  if (!mix) return { where: "1 = 0", args: [] };
  if (mix.id === "recent") return { where: "COALESCE(s.last_played_at, '') <> ''", args: [] };
  if (mix.id === "favorites") return { where: "COALESCE(s.favorite, 0) = 1", args: [] };
  if (mix.id === "toprated") return { where: "COALESCE(s.rating, 0) >= 4", args: [] };
  if (mix.id === "unrated") return { where: "COALESCE(s.rating, 0) = 0", args: [] };
  if (mix.id === "hires") {
    return {
      where: "(LOWER(COALESCE(t.codec, '')) IN ('flac', 'wav', 'alac') OR COALESCE(t.bit_depth, 0) >= 24 OR COALESCE(t.sample_rate, 0) >= 48000)",
      args: []
    };
  }
  if (mix.id === "lyrics") return { where: "COALESCE(t.has_lrc, 0) = 1", args: [] };
  if (mix.id === "longform") return { where: "COALESCE(t.duration_ms, 0) >= 300000", args: [] };
  if (mix.id === "rediscover") {
    const cutoff = new Date(Date.now() - REDISCOVER_DAYS * 24 * 60 * 60 * 1000).toISOString();
    return {
      where: "(COALESCE(s.favorite, 0) = 1 OR COALESCE(s.play_count, 0) > 0) AND (COALESCE(s.last_played_at, '') = '' OR s.last_played_at < ?)",
      args: [cutoff]
    };
  }
  return { where: "1 = 0", args: [] };
}

function smartMixCount(db, mix) {
  const condition = smartMixCondition(mix);
  return Number(
    db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM music_tracks t
        LEFT JOIN music_track_state s ON s.track_id = t.id
        WHERE t.status = 'ok' AND ${condition.where}
      `
      )
      .get(...condition.args)?.count || 0
  );
}

function publicArtist(row) {
  return {
    id: row.id || "",
    name: row.name || "",
    albumCount: Number(row.album_count || 0),
    trackCount: Number(row.track_count || 0),
    durationMs: Number(row.duration_ms || 0),
    sizeBytes: Number(row.size_bytes || 0),
    sourcePath: row.source_path || "",
    relativePath: row.relative_path || ""
  };
}

function publicAlbum(row) {
  const id = row.id || "";
  const coverStamp = coverStampFor(row.cover_path);
  return {
    id,
    artistId: row.artist_id || "",
    artistName: row.artist_name || "",
    title: row.title || "",
    year: row.year || "",
    coverUrl: row.cover_path ? `/media/music-cover/${encodeURIComponent(id)}${coverStamp ? `?v=${encodeURIComponent(coverStamp)}` : ""}` : "",
    intro: row.intro_text || "",
    introPath: row.intro_path || "",
    sourcePath: row.source_path || "",
    relativePath: row.relative_path || "",
    trackCount: Number(row.track_count || 0),
    durationMs: Number(row.duration_ms || 0),
    sizeBytes: Number(row.size_bytes || 0),
    updatedAt: row.updated_at || ""
  };
}

function publicPlaylist(row) {
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

function formatM3uPlaylist(playlist, tracks = [], pathMode = "absolute") {
  const lines = ["#EXTM3U", `#PLAYLIST:${m3uText(playlist.name || "FanHao 歌单")}`];
  for (const track of tracks) {
    const seconds = Math.round(Number(track.duration_ms || 0) / 1000);
    const artist = track.display_artist || "";
    const title = track.title || path.basename(track.file_name || track.source_path || "music", path.extname(track.file_name || ""));
    const label = artist ? `${artist} - ${title}` : title;
    const target = pathMode === "relative" ? track.relative_path || track.file_name || track.source_path || "" : track.source_path || track.relative_path || track.file_name || "";
    lines.push(`#EXTINF:${seconds > 0 ? seconds : -1},${m3uText(label)}`);
    lines.push(m3uPath(target));
  }
  return `${lines.join("\n")}\n`;
}

function m3uText(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function m3uPath(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function safePlaylistFileName(value) {
  return String(value || "FanHao 歌单")
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "FanHao 歌单";
}

function publicGenre(row) {
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

function publicSmartPlaylist(mix, count = 0) {
  return {
    id: mix.id || "",
    name: mix.name || "",
    description: mix.description || "",
    badge: mix.badge || "",
    trackCount: Number(count || 0),
    limit: Number(mix.limit || DEFAULT_LIMIT)
  };
}

function publicTrack(row, options = {}) {
  const id = row.id || "";
  const albumId = row.album_id || "";
  const coverStamp = coverStampFor(row.cover_path);
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
    relativePath: row.relative_path || "",
    sizeBytes: Number(row.size_bytes || 0),
    ...(options.detail
      ? {
          sourcePath: row.source_path || "",
          lrcPath: row.lrc_path || "",
          mtimeMs: Number(row.mtime_ms || 0),
          updatedAt: row.updated_at || ""
        }
      : {})
  };
}

function probeAudio(filePath, ffprobePath) {
  const result = {
    title: "",
    artist: "",
    album: "",
    genre: "",
    year: "",
    trackNo: 0,
    discNo: 0,
    durationMs: 0,
    codec: "",
    sampleRate: 0,
    bitDepth: 0,
    channels: 0,
    error: ""
  };
  try {
    const probe = spawnSync(
      ffprobePath,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration:format_tags=title,artist,album,genre,date,year,track,disc",
        "-show_entries",
        "stream=codec_name,sample_rate,channels,bits_per_raw_sample,bits_per_sample",
        "-of",
        "json",
        filePath
      ],
      { encoding: "utf8", windowsHide: true, timeout: 12000, maxBuffer: 1024 * 1024 }
    );
    if (probe.error) {
      result.error = probe.error.message || String(probe.error);
      return result;
    }
    if (probe.status !== 0 && probe.stderr) result.error = String(probe.stderr).trim().slice(0, 500);
    const data = JSON.parse(probe.stdout || "{}");
    const tags = normalizeTags(data?.format?.tags || {});
    const stream = Array.isArray(data?.streams) ? data.streams[0] || {} : {};
    result.title = tags.title || "";
    result.artist = tags.artist || "";
    result.album = tags.album || "";
    result.genre = tags.genre || "";
    result.year = yearFromText(tags.date || tags.year || "");
    result.trackNo = numberPrefix(tags.track);
    result.discNo = numberPrefix(tags.disc);
    result.durationMs = Math.round(Number(data?.format?.duration || 0) * 1000) || 0;
    result.codec = String(stream.codec_name || "").toUpperCase();
    result.sampleRate = Number(stream.sample_rate || 0) || 0;
    result.bitDepth = Number(stream.bits_per_raw_sample || stream.bits_per_sample || 0) || 0;
    result.channels = Number(stream.channels || 0) || 0;
  } catch (error) {
    result.error = error.message || String(error);
  }
  return result;
}

function normalizeTags(tags = {}) {
  const result = {};
  for (const [key, value] of Object.entries(tags || {})) {
    result[String(key).toLowerCase()] = String(value || "").trim();
  }
  return result;
}

function musicGenreForTrack(input = {}) {
  return cleanMusicGenre(input.genre) || inferMusicGenre(input);
}

function cleanMusicGenre(value) {
  const raw = String(value || "")
    .replace(/\0/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "";
  const first = raw.split(/[;,|、]/u).map((item) => item.trim()).find(Boolean) || "";
  const id3Number = /^\(?(\d{1,3})\)?$/u.exec(first);
  if (id3Number) {
    const mapped = id3GenreName(Number(id3Number[1]));
    if (mapped) return mapped;
  }
  const normalized = MUSIC_GENRE_ALIASES.get(first.toLowerCase()) || first;
  return normalized.slice(0, 32);
}

function inferMusicGenre(input = {}) {
  const artistText = [input.artistName, input.displayArtist, input.artist].filter(Boolean).join(" ");
  const titleText = [input.title, input.albumTitle, input.album, input.fileName, input.relativePath].filter(Boolean).join(" ");
  for (const hint of MUSIC_TITLE_GENRE_HINTS) {
    if (hint.pattern.test(titleText)) return hint.genre;
  }
  for (const hint of MUSIC_ARTIST_GENRE_HINTS) {
    if (hint.pattern.test(artistText)) return hint.genre;
  }
  const combined = `${artistText} ${titleText}`;
  return /[\u4e00-\u9fff]/u.test(combined) ? "华语流行" : "其他";
}

function id3GenreName(value) {
  const names = [
    "Blues",
    "Classic Rock",
    "Country",
    "Dance",
    "Disco",
    "Funk",
    "Grunge",
    "Hip-Hop",
    "Jazz",
    "Metal",
    "New Age",
    "Oldies",
    "Other",
    "流行",
    "R&B/嘻哈",
    "Rap",
    "Reggae",
    "摇滚",
    "Techno",
    "Industrial",
    "Alternative",
    "Ska",
    "Death Metal",
    "Pranks",
    "Soundtrack",
    "Euro-Techno",
    "Ambient",
    "Trip-Hop",
    "Vocal",
    "Jazz+Funk",
    "Fusion",
    "Trance",
    "Classical",
    "Instrumental",
    "Acid",
    "House",
    "Game",
    "Sound Clip",
    "Gospel",
    "Noise",
    "AlternRock",
    "Bass",
    "Soul",
    "Punk",
    "Space",
    "Meditative",
    "Instrumental Pop",
    "Instrumental Rock",
    "Ethnic",
    "Gothic",
    "Darkwave",
    "Techno-Industrial",
    "Electronic",
    "Pop-Folk",
    "Eurodance",
    "Dream",
    "Southern Rock",
    "Comedy",
    "Cult",
    "Gangsta",
    "Top 40",
    "Christian Rap",
    "流行/摇滚",
    "Jungle",
    "Native American",
    "Cabaret",
    "New Wave",
    "Psychadelic",
    "Rave",
    "Showtunes",
    "Trailer",
    "Lo-Fi",
    "Tribal",
    "Acid Punk",
    "Acid Jazz",
    "Polka",
    "Retro",
    "Musical",
    "摇滚",
    "Hard Rock"
  ];
  return cleanMusicGenre(names[value] || "");
}

function parseTrackName(stem) {
  const clean = String(stem || "").trim();
  const trackNoMatch = /^(\d{1,3})[\s._-]+(.+)$/u.exec(clean);
  const withoutNo = trackNoMatch ? trackNoMatch[2].trim() : clean;
  const split = /^(.{1,80}?)[\s]*-[\s]*(.+)$/u.exec(withoutNo);
  return {
    trackNo: trackNoMatch ? Number(trackNoMatch[1]) || 0 : 0,
    artist: split ? split[1].trim() : "",
    title: split ? split[2].trim() : withoutNo
  };
}

function findAlbumCover(files, dir, albumTitle) {
  const images = files.filter((name) => IMAGE_EXTS.has(path.extname(name).toLowerCase()) && !isJunkAssetName(name));
  if (!images.length) return "";
  const albumKey = cleanComparable(albumTitle);
  const exact = images.find((name) => cleanComparable(path.basename(name, path.extname(name))) === albumKey);
  const preferred =
    exact ||
    images.find((name) => /^(cover|folder|front|album|封面)$/iu.test(path.basename(name, path.extname(name)).trim())) ||
    images.find((name) => /cover|folder|front|album|封面/iu.test(name)) ||
    images[0];
  return preferred ? path.join(dir, preferred) : "";
}

function findAlbumIntro(files, dir, albumTitle) {
  const txts = files.filter((name) => path.extname(name).toLowerCase() === ".txt" && !isJunkAssetName(name));
  if (!txts.length) return "";
  const albumKey = cleanComparable(albumTitle);
  const preferred =
    txts.find((name) => /简介|介绍|说明/u.test(name)) ||
    txts.find((name) => cleanComparable(path.basename(name, path.extname(name))).includes(albumKey)) ||
    txts[0];
  return preferred ? path.join(dir, preferred) : "";
}

function findCompanionLyric(files, dir, audioPath) {
  const base = path.basename(audioPath, path.extname(audioPath)).toLowerCase();
  const exact = files.find((name) => path.extname(name).toLowerCase() === ".lrc" && path.basename(name, path.extname(name)).toLowerCase() === base);
  return exact ? path.join(dir, exact) : "";
}

function parseLrc(text) {
  const lines = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const stamps = [...rawLine.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const content = rawLine.replace(/\[[^\]]+\]/g, "").trim();
    if (!content) continue;
    for (const stamp of stamps) {
      const minutes = Number(stamp[1] || 0);
      const seconds = Number(stamp[2] || 0);
      const fraction = String(stamp[3] || "0").padEnd(3, "0").slice(0, 3);
      lines.push({ timeMs: minutes * 60 * 1000 + seconds * 1000 + Number(fraction), text: content });
    }
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs);
}

function readSmallText(filePath, maxBytes) {
  const stat = safeStat(filePath);
  if (!stat?.isFile() || stat.size > maxBytes) return "";
  try {
    return decodeTextBuffer(fs.readFileSync(filePath)).replace(/^\uFEFF/, "").trim();
  } catch {
    return "";
  }
}

function decodeTextBuffer(buffer) {
  const source = Buffer.from(buffer);
  const hasKuwoPrefix = source.subarray(0, KUWO_UTF16LE_PREFIX.length).equals(KUWO_UTF16LE_PREFIX);
  const textBuffer = hasKuwoPrefix ? source.subarray(KUWO_UTF16LE_PREFIX.length) : source;
  for (const encoding of ["utf-8", "gb18030", "gbk", "big5"]) {
    try {
      const text = new TextDecoder(encoding, { fatal: encoding === "utf-8" }).decode(textBuffer);
      if (!text.includes("\uFFFD") || encoding !== "utf-8") return cleanDecodedText(text, hasKuwoPrefix);
    } catch {}
  }
  return cleanDecodedText(textBuffer.toString("utf8"), hasKuwoPrefix);
}

function cleanDecodedText(text, stripKuwoPrefix) {
  const cleaned = String(text || "").replace(/^\uFEFF/, "");
  return stripKuwoPrefix ? cleaned.replace(/^\s*-\s*/, "") : cleaned;
}

function cachedDirEntries(cache, dir) {
  if (cache.has(dir)) return cache.get(dir);
  const entries = safeReadDir(dir);
  cache.set(dir, entries);
  return entries;
}

function* walkFiles(root) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of safeReadDirEntries(current)) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        yield fullPath;
      }
    }
  }
}

function normalizeRoots(values) {
  return [...new Set((Array.isArray(values) ? values : [values]).map((item) => String(item || "").trim()).filter(Boolean).map((item) => path.resolve(item)))];
}

function rootStatus(root) {
  const stat = safeStat(root);
  return { path: root, exists: Boolean(stat?.isDirectory()) };
}

function safeStoredFile(filePath, type, id = "") {
  const normalized = path.resolve(filePath);
  const stat = safeStat(normalized);
  if (!stat?.isFile()) return null;
  return {
    id: id || hashText(normalized).slice(0, 16),
    path: normalized,
    type,
    ext: path.extname(normalized).toLowerCase(),
    size: stat.size,
    modifiedAt: stat.mtime?.toISOString?.() || ""
  };
}

function coverStampFor(filePath) {
  const stat = safeStat(filePath);
  return stat?.isFile() ? `${stat.size}-${Math.floor(stat.mtimeMs || 0)}` : "";
}

function metaValue(db, key) {
  try {
    return db.prepare("SELECT value FROM music_meta WHERE key = ?").get(key)?.value || "";
  } catch {
    return "";
  }
}

function normalizeTrackSort(value) {
  const sort = String(value || "album").trim();
  return ["album", "title", "artist", "duration", "played", "favorite", "rating"].includes(sort) ? sort : "album";
}

function normalizeAlbumSort(value) {
  const sort = String(value || "updated").trim();
  return ["updated", "title", "year", "tracks"].includes(sort) ? sort : "updated";
}

function trackOrderSql(sort) {
  if (sort === "title") return "t.title COLLATE NOCASE ASC, t.display_artist COLLATE NOCASE ASC";
  if (sort === "artist") return "t.display_artist COLLATE NOCASE ASC, t.album_title COLLATE NOCASE ASC, t.track_no ASC, t.title COLLATE NOCASE ASC";
  if (sort === "duration") return "t.duration_ms DESC, t.title COLLATE NOCASE ASC";
  if (sort === "played") return "s.last_played_at IS NULL ASC, s.last_played_at DESC, t.album_title COLLATE NOCASE ASC, t.track_no ASC";
  if (sort === "favorite") return "COALESCE(s.favorite, 0) DESC, s.updated_at DESC, t.title COLLATE NOCASE ASC";
  if (sort === "rating") return "COALESCE(s.rating, 0) DESC, s.updated_at DESC, t.title COLLATE NOCASE ASC";
  return "t.album_title COLLATE NOCASE ASC, t.disc_no ASC, t.track_no ASC, t.title COLLATE NOCASE ASC";
}

function cleanArtistName(value) {
  return String(value || "未知歌手")
    .replace(/[（(]\s*(?:完结|更新中|全集|无损)\s*[）)]/giu, "")
    .replace(/\s+/g, " ")
    .trim() || "未知歌手";
}

function cleanAlbumTitle(value) {
  return String(value || "单曲").replace(/\s+/g, " ").trim() || "单曲";
}

function cleanTrackTitle(value) {
  return String(value || "未命名歌曲")
    .replace(/^\d{1,3}[\s._-]+/u, "")
    .replace(/\s+/g, " ")
    .trim() || "未命名歌曲";
}

function cleanComparable(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function sortKey(value) {
  return String(value || "").trim().toLowerCase();
}

function yearFromText(value) {
  const match = /(19|20)\d{2}/.exec(String(value || ""));
  return match ? match[0] : "";
}

function numberPrefix(value) {
  const match = /^(\d{1,3})/.exec(String(value || "").trim());
  return match ? Number(match[1]) || 0 : 0;
}

function isJunkAssetName(name) {
  return /微信公众号|欢迎关注|阿里云盘|达人招募|延期卡|50TB|扫码|二维码/iu.test(String(name || ""));
}

function ftsTerm(value) {
  return `"${String(value || "").replace(/"/g, '""')}"`;
}

function escapeLike(value) {
  return String(value || "").replace(/[\\%_]/g, (item) => `\\${item}`);
}

function hashText(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function safeReadDirEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeStat(filePath) {
  try {
    return filePath ? fs.statSync(filePath) : null;
  } catch {
    return null;
  }
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function clampInt(value, fallback, min, max) {
  if (value === null || value === undefined || String(value).trim?.() === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}
