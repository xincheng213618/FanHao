import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  MUSIC_LANGUAGES,
  buildArtistLanguageConsensus,
  musicLanguageForArtist,
  musicLanguageFromPath,
  normalizeMusicLanguage
} from "./language.js";
import {
  buildMusicIdentityKnowledge,
  isUnknownMusicArtist,
  resolveMusicTrackIdentity
} from "./identity.js";

import { DEFAULT_LIMIT, MAX_LIMIT, MAX_PAGE_LIMIT } from "./constants.js";
import { SMART_MIXES, findSmartMix, smartMixCondition } from "./smart-mix.js";
import { canUseShortVocabularyCount, musicSearchIndexCondition, musicSearchIndexJoin, musicSearchIndexKind, musicSearchIndexRank, musicSearchIndexTerm, musicShortSearchDocumentCount, searchRankSql } from "./search.js";
import { createM3uTrackMatcher, formatM3uPlaylist, parseM3u, playlistTrackIdsFromInput, readM3uInput, safePlaylistFileName } from "./m3u.js";
import { adjacentTracks, lyricsForTrack, publicAlbum, publicArtist, publicPlaylist, publicReportArtist, publicSmartPlaylist, publicTrack, trackRow } from "./serializers.js";
import { albumFacet, artistFacet, cachedMusicFacet, genreFacet, languageFacet, smartMixCount } from "./facets.js";
import { catalogFilter } from "./query.js";
import { normalizeRoots, rootStatus, safeStoredFile, scanMusicRoots, scanSummary, writeScanRecords } from "./scan.js";
import { ensureSchema } from "./schema.js";
import { artistNameForSort, buildLetterCondition, clampInt, escapeLike, hashText, httpError, metaValue, normalizeAlbumSort, normalizeTrackSort, trackOrderSql } from "./helpers.js";

export function createMusicStore(options = {}) {
  const dbPath = options.dbPath;
  const roots = normalizeRoots(options.roots || []);
  const ffprobePath = options.ffprobePath || "ffprobe";
  if (!dbPath) throw new Error("music dbPath is required");

  let db = null;
  let summaryCache = null;
  let summaryCachedAt = 0;

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
    summaryCache = null;
    summaryCachedAt = 0;
  }

  function summary() {
    if (summaryCache && Date.now() - summaryCachedAt < 5000) return summaryCache;
    const database = dbOrOpen();
    const totals =
      database
        .prepare(
          `
          SELECT
            COALESCE(SUM(track_count), 0) AS tracks,
            COUNT(*) AS artists,
            COALESCE(SUM(size_bytes), 0) AS bytes,
            COALESCE(SUM(duration_ms), 0) AS durationMs
          FROM music_artists
          WHERE status = 'ok'
        `
        )
        .get() || {};
    const albumTotal = Number(database.prepare("SELECT COUNT(*) AS count FROM music_albums").get()?.count || 0);
    const listening =
      database
        .prepare(
          `
          SELECT
            COUNT(*) AS listenedTracks,
            COALESCE(SUM(s.play_count), 0) AS plays
          FROM music_track_state s
          WHERE COALESCE(s.play_count, 0) > 0
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
        CROSS JOIN music_tracks t ON t.id = s.track_id
        LEFT JOIN music_artists a ON a.id = t.artist_id
        LEFT JOIN music_albums al ON al.id = t.album_id
        WHERE COALESCE(s.last_played_at, '') <> ''
        ORDER BY s.last_played_at DESC
        LIMIT 8
      `
      )
      .all()
      .map(publicTrack);
    const topPlayed = database
      .prepare(
        `
        SELECT t.*, a.name AS artist_name, al.title AS album_name, al.cover_path,
               s.favorite, s.rating, s.position_ms, s.duration_ms AS state_duration_ms,
               s.play_count, s.last_played_at
        FROM music_track_state s
        CROSS JOIN music_tracks t ON t.id = s.track_id
        LEFT JOIN music_artists a ON a.id = t.artist_id
        LEFT JOIN music_albums al ON al.id = t.album_id
        WHERE COALESCE(s.play_count, 0) > 0
        ORDER BY COALESCE(s.play_count, 0) DESC, COALESCE(s.last_played_at, '') DESC, t.title COLLATE NOCASE ASC
        LIMIT 8
      `
      )
      .all()
      .map(publicTrack);
    summaryCache = {
      dbPath,
      roots: roots.map(rootStatus),
      scannedAt: metaValue(database, "scanned_at"),
      totals: {
        tracks: Number(totals.tracks || 0),
        artists: Number(totals.artists || 0),
        albums: albumTotal,
        bytes: Number(totals.bytes || 0),
        durationMs: Number(totals.durationMs || 0),
        listenedTracks: Number(listening.listenedTracks || 0),
        plays: Number(listening.plays || 0)
      },
      languages: languageFacet(database),
      recent,
      topPlayed
    };
    summaryCachedAt = Date.now();
    return summaryCache;
  }

  function facets() {
    const database = dbOrOpen();
    return {
      summary: summary(),
      artists: artistFacet(database),
      albums: albumFacet(database),
      genres: genreFacet(database),
      languages: languageFacet(database)
    };
  }

  function report() {
    const database = dbOrOpen();
    const overview = summary();
    const favorites = Number(
      database
        .prepare(
          `
          SELECT COUNT(*) AS count
          FROM music_track_state s
          JOIN music_tracks t ON t.id = s.track_id
          WHERE t.status = 'ok' AND COALESCE(s.favorite, 0) = 1
        `
        )
        .get()?.count || 0
    );
    const topArtists = database
      .prepare(
        `
        SELECT
          a.id,
          a.name,
          COUNT(DISTINCT t.id) AS track_count,
          COALESCE(SUM(s.play_count), 0) AS plays,
          MAX(COALESCE(s.last_played_at, '')) AS last_played_at
        FROM music_tracks t
        LEFT JOIN music_artists a ON a.id = t.artist_id
        LEFT JOIN music_track_state s ON s.track_id = t.id
        WHERE t.status = 'ok'
        GROUP BY a.id
        HAVING plays > 0
        ORDER BY plays DESC, last_played_at DESC, a.name COLLATE NOCASE
        LIMIT 8
      `
      )
      .all()
      .map(publicReportArtist);
    const topAlbums = database
      .prepare(
        `
        SELECT
          al.*,
          a.name AS artist_name,
          COALESCE(SUM(s.play_count), 0) AS plays,
          MAX(COALESCE(s.last_played_at, '')) AS last_played_at
        FROM music_tracks t
        LEFT JOIN music_albums al ON al.id = t.album_id
        LEFT JOIN music_artists a ON a.id = t.artist_id
        LEFT JOIN music_track_state s ON s.track_id = t.id
        WHERE t.status = 'ok'
        GROUP BY al.id
        HAVING plays > 0
        ORDER BY plays DESC, last_played_at DESC, al.title COLLATE NOCASE
        LIMIT 8
      `
      )
      .all()
      .map((row) => ({
        ...publicAlbum(row),
        plays: Number(row.plays || 0),
        lastPlayedAt: row.last_played_at || ""
      }));
    const topTracks = database
      .prepare(
        `
        SELECT t.*, a.name AS artist_name, al.title AS album_name, al.cover_path,
               s.favorite, s.rating, s.position_ms, s.duration_ms AS state_duration_ms,
               s.play_count, s.last_played_at
        FROM music_track_state s
        JOIN music_tracks t ON t.id = s.track_id
        LEFT JOIN music_artists a ON a.id = t.artist_id
        LEFT JOIN music_albums al ON al.id = t.album_id
        WHERE t.status = 'ok' AND COALESCE(s.play_count, 0) > 0
        ORDER BY COALESCE(s.play_count, 0) DESC, COALESCE(s.last_played_at, '') DESC, t.title COLLATE NOCASE ASC
        LIMIT 12
      `
      )
      .all()
      .map(publicTrack);
    const activityMonths = database
      .prepare(
        `
        SELECT
          substr(s.last_played_at, 1, 7) AS month,
          COUNT(*) AS track_count,
          COALESCE(SUM(s.play_count), 0) AS plays
        FROM music_track_state s
        JOIN music_tracks t ON t.id = s.track_id
        WHERE t.status = 'ok' AND COALESCE(s.last_played_at, '') <> ''
        GROUP BY month
        ORDER BY month DESC
        LIMIT 12
      `
      )
      .all()
      .reverse()
      .map((row) => ({
        month: row.month || "",
        trackCount: Number(row.track_count || 0),
        plays: Number(row.plays || 0)
      }));
    return {
      summary: overview,
      counts: {
        ...(overview.totals || {}),
        favorites
      },
      topArtists,
      topAlbums,
      topTracks,
      recent: overview.recent || [],
      activityMonths,
      tracks: topTracks,
      total: topTracks.length,
      artists: artistFacet(database),
      albums: albumFacet(database),
      genres: genreFacet(database)
    };
  }

  function suggest(queryOrUrl = "") {
    const params = queryOrUrl?.searchParams;
    const query = String(params ? params.get("q") || params.get("search") || "" : queryOrUrl || "").trim();
    if (!query) return { query, tracks: [], artists: [], albums: [] };
    const database = dbOrOpen();
    const searchKind = musicSearchIndexKind(query);
    const indexed = Boolean(searchKind);
    const like = `%${escapeLike(query)}%`;
    const trackSearch = indexed
      ? musicSearchIndexCondition(searchKind)
      : `(t.title LIKE ? ESCAPE '\\' OR t.display_artist LIKE ? ESCAPE '\\' OR t.album_title LIKE ? ESCAPE '\\' OR t.file_name LIKE ? ESCAPE '\\')`;
    const trackArgs = indexed ? [musicSearchIndexTerm(searchKind, query)] : [like, like, like, like];
    const rank = indexed ? musicSearchIndexRank(searchKind, query) : searchRankSql(query);
    const tracks = database
      .prepare(
        `
        SELECT t.*, a.name AS artist_name, al.title AS album_name, al.cover_path,
               s.favorite, s.rating, s.position_ms, s.duration_ms AS state_duration_ms,
               s.play_count, s.last_played_at
        FROM music_tracks t
        ${musicSearchIndexJoin(searchKind)}
        LEFT JOIN music_artists a ON a.id = t.artist_id
        LEFT JOIN music_albums al ON al.id = t.album_id
        LEFT JOIN music_track_state s ON s.track_id = t.id
        WHERE t.status = 'ok' AND ${trackSearch}
        ORDER BY ${rank.sql}
        LIMIT 8
      `
      )
      .all(...trackArgs, ...rank.args)
      .map(publicTrack);
    const artists = database
      .prepare(
        `
        SELECT *
        FROM music_artists
        WHERE track_count > 0 AND name LIKE ? ESCAPE '\\'
        ORDER BY track_count DESC, name COLLATE NOCASE
        LIMIT 5
      `
      )
      .all(like)
      .map(publicArtist);
    const albums = database
      .prepare(
        `
        SELECT al.*, a.name AS artist_name
        FROM music_albums al
        LEFT JOIN music_artists a ON a.id = al.artist_id
        WHERE al.track_count > 0 AND (
          al.title LIKE ? ESCAPE '\\' OR
          a.name LIKE ? ESCAPE '\\'
        )
        ORDER BY al.track_count DESC, al.title COLLATE NOCASE
        LIMIT 5
      `
      )
      .all(like, like)
      .map(publicAlbum);
    return { query, tracks, artists, albums };
  }

  function listArtists(urlOrOptions = {}) {
    const params = urlOrOptions?.searchParams || new URLSearchParams();
    const query = String(params.get("q") || params.get("search") || "").trim();
    const language = normalizeMusicLanguage(params.get("language") || params.get("lang"));
    const sort = String(params.get("sort") || "count").trim().toLowerCase() === "name" ? "name" : "count";
    const limit = clampInt(params.get("limit"), 80, 1, MAX_PAGE_LIMIT);
    const offset = clampInt(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const conditions = ["track_count > 0"];
    const args = [];
    if (language) {
      conditions.push("language = ?");
      args.push(language);
    }
    if (query) {
      conditions.push("name LIKE ? ESCAPE '\\'");
      args.push(`%${escapeLike(query)}%`);
    }
    const letter = String(params.get("letter") || "").trim();
    if (letter) {
      const lc = buildLetterCondition(letter, "name", "name");
      if (lc) {
        conditions.push(lc.sql);
        if (lc.args.length) args.push(...lc.args);
      }
    }
    const database = dbOrOpen();
    let total;
    let rows;
    if (sort === "name") {
      const buildSortedRows = () => database
          .prepare(`SELECT * FROM music_artists WHERE ${conditions.join(" AND ")}`)
          .all(...args)
          .sort((left, right) => artistNameForSort(left.name).localeCompare(artistNameForSort(right.name), "zh-CN", { numeric: true, sensitivity: "base" }));
      const sortedRows = query
        ? buildSortedRows()
        : cachedMusicFacet(database, `artist-browser:${language || "all"}:${letter || "all"}:name`, buildSortedRows);
      total = sortedRows.length;
      rows = sortedRows.slice(offset, offset + limit);
    } else {
      total = Number(database.prepare(`SELECT COUNT(*) AS count FROM music_artists WHERE ${conditions.join(" AND ")}`).get(...args)?.count || 0);
      rows = database
        .prepare(
          `
          SELECT * FROM music_artists
          WHERE ${conditions.join(" AND ")}
          ORDER BY track_count DESC, name COLLATE NOCASE ASC
          LIMIT ? OFFSET ?
        `
        )
        .all(...args, limit, offset);
    }
    return {
      artists: rows.map(publicArtist),
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
      query,
      language,
      letter,
      sort,
      languages: languageFacet(database),
      summary: summary()
    };
  }

  function listAlbums(urlOrOptions = {}) {
    const params = urlOrOptions?.searchParams || new URLSearchParams();
    const filter = catalogFilter(params);
    const letter = String(params.get("letter") || "").trim();
    let albumWhere = filter.albumWhere;
    let albumArgs = filter.albumArgs ? [...filter.albumArgs] : [];
    if (letter) {
      const lc = buildLetterCondition(letter, "al.title", "a.name");
      if (lc) {
        albumWhere = albumWhere ? `${albumWhere} AND ${lc.sql}` : lc.sql;
        if (lc.args.length) albumArgs.push(...lc.args);
      }
    }
    const limit = clampInt(params.get("limit"), 80, 1, MAX_PAGE_LIMIT);
    const offset = clampInt(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const sort = normalizeAlbumSort(params.get("sort"));
    const where = albumWhere ? `WHERE ${albumWhere}` : "";
    const order = {
      title: "al.title COLLATE NOCASE ASC",
      year: "COALESCE(al.year, '') DESC, al.title COLLATE NOCASE ASC",
      tracks: "al.track_count DESC, al.title COLLATE NOCASE ASC",
      updated: "al.updated_at DESC, al.title COLLATE NOCASE ASC"
    }[sort] || "al.updated_at DESC, al.title COLLATE NOCASE ASC";
    const database = dbOrOpen();
    const total = Number(database
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM music_albums al
        LEFT JOIN music_artists a ON a.id = al.artist_id
        ${where}
      `
      )
      .get(...albumArgs)?.count || 0);
    const rows = database
      .prepare(
        `
        SELECT al.*, a.name AS artist_name
        FROM music_albums al
        LEFT JOIN music_artists a ON a.id = al.artist_id
        ${where}
        ORDER BY ${order}
        LIMIT ? OFFSET ?
      `
      )
      .all(...albumArgs, limit, offset);
    return {
      albums: rows.map(publicAlbum),
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
      query: filter.q,
      artistId: filter.artistId,
      genre: filter.genre,
      language: filter.language,
      letter,
      sort,
      languages: languageFacet(database),
      summary: summary()
    };
  }

  function listTracks(urlOrOptions = {}) {
    const params = urlOrOptions?.searchParams || new URLSearchParams();
    const filter = catalogFilter(params);
    const smartMix = findSmartMix(filter.smartId);
    const sort = normalizeTrackSort(params.get("sort"));
    const limit = clampInt(params.get("limit"), DEFAULT_LIMIT, 1, MAX_PAGE_LIMIT);
    const offset = clampInt(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const where = filter.trackWhere ? `WHERE ${filter.trackWhere}` : "";
    const rank = filter.q && !smartMix && !params.has("sort")
      ? (filter.searchKind ? musicSearchIndexRank(filter.searchKind, filter.q) : searchRankSql(filter.q))
      : { sql: "", args: [] };
    const order = smartMix ? smartMix.order : rank.sql || trackOrderSql(sort);
    const database = dbOrOpen();
    const stateJoin = filter.needsState ? "LEFT JOIN music_track_state s ON s.track_id = t.id" : "";
    const searchJoin = musicSearchIndexJoin(filter.searchKind);
    const total = canUseShortVocabularyCount(filter)
      ? musicShortSearchDocumentCount(database, filter.q)
      : database.prepare(`SELECT COUNT(*) AS count FROM music_tracks t ${searchJoin} ${stateJoin} ${where}`).get(...filter.trackArgs)?.count || 0;
    const rows = database
      .prepare(
        `
        SELECT t.*, a.name AS artist_name, al.title AS album_name, al.cover_path,
               s.favorite, s.rating, s.position_ms, s.duration_ms AS state_duration_ms,
               s.play_count, s.last_played_at
        FROM music_tracks t
        ${searchJoin}
        LEFT JOIN music_artists a ON a.id = t.artist_id
        LEFT JOIN music_albums al ON al.id = t.album_id
        LEFT JOIN music_track_state s ON s.track_id = t.id
        ${where}
        ORDER BY ${order}
        LIMIT ? OFFSET ?
      `
      )
      .all(...filter.trackArgs, ...rank.args, limit, offset);
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
      language: filter.language,
      favorite: filter.favorite,
      smartId: filter.smartId,
      smartPlaylist: smartMix ? publicSmartPlaylist(smartMix, total) : null,
      sort,
      relevance: Boolean(rank.sql),
      summary: summary(),
      languages: languageFacet(database),
      artists: artistFacet(database, filter.language, filter.artistId),
      albums: albumFacet(database, filter.artistId, filter.genre, filter.language, filter.albumId),
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
    const trackIds = playlistTrackIdsFromInput(input);
    const now = new Date().toISOString();
    const id = hashText(`playlist:${now}:${name}:${crypto.randomBytes(8).toString("hex")}`).slice(0, 20);
    const database = dbOrOpen();
    const insertPlaylist = database.prepare("INSERT INTO music_playlists (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
    const insertItem = database.prepare("INSERT OR IGNORE INTO music_playlist_items (playlist_id, track_id, sort_order, added_at) VALUES (?, ?, ?, ?)");
    const findTrack = database.prepare("SELECT id FROM music_tracks WHERE id = ? AND status = 'ok'");
    let addedTracks = 0;
    database.exec("BEGIN IMMEDIATE");
    try {
      insertPlaylist.run(id, name, String(input.description || "").trim().slice(0, 300), now, now);
      for (const trackId of trackIds) {
        const track = findTrack.get(trackId);
        if (!track?.id) continue;
        addedTracks += 1;
        insertItem.run(id, track.id, addedTracks, now);
      }
      if (trackIds.length && !addedTracks) throw httpError(400, "没有可加入歌单的歌曲");
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
    return playlistDetail(id);
  }

  function updatePlaylist(playlistId, input = {}) {
    const database = dbOrOpen();
    const row = database.prepare("SELECT * FROM music_playlists WHERE id = ?").get(playlistId);
    if (!row) return null;
    const name = String(input.name ?? row.name ?? "").trim().slice(0, 80);
    if (!name) throw httpError(400, "歌单名称不能为空");
    const description = String(input.description ?? row.description ?? "").trim().slice(0, 300);
    database
      .prepare("UPDATE music_playlists SET name = ?, description = ?, updated_at = ? WHERE id = ?")
      .run(name, description, new Date().toISOString(), playlistId);
    return playlistDetail(playlistId);
  }

  function importM3uPlaylist(input = {}) {
    const source = readM3uInput(input);
    const parsed = parseM3u(source.content);
    if (!parsed.entries.length) throw httpError(400, "M3U 文件里没有可导入的歌曲路径");
    const database = dbOrOpen();
    const matcher = createM3uTrackMatcher(database);
    const matched = [];
    const missing = [];
    const seenTrackIds = new Set();
    for (const entry of parsed.entries) {
      const match = matcher.match(entry, source.baseDir);
      if (match?.id && !seenTrackIds.has(match.id)) {
        seenTrackIds.add(match.id);
        matched.push(match.id);
      } else {
        missing.push(entry);
      }
    }
    if (!matched.length) throw httpError(400, "没有匹配到音乐库里的歌曲");

    const now = new Date().toISOString();
    const requestedName = String(input.name || "").trim();
    const name = (requestedName || parsed.name || source.name || "导入歌单").slice(0, 80);
    const id = hashText(`playlist:${now}:${name}:${crypto.randomBytes(8).toString("hex")}`).slice(0, 20);
    const insertPlaylist = database.prepare("INSERT INTO music_playlists (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
    const insertItem = database.prepare("INSERT OR IGNORE INTO music_playlist_items (playlist_id, track_id, sort_order, added_at) VALUES (?, ?, ?, ?)");
    database.exec("BEGIN IMMEDIATE");
    try {
      insertPlaylist.run(id, name, String(input.description || "M3U 导入").trim().slice(0, 300), now, now);
      matched.forEach((trackId, index) => insertItem.run(id, trackId, index + 1, now));
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {}
      throw error;
    }

    const detail = playlistDetail(id);
    return {
      ...detail,
      importSummary: {
        source: source.source,
        matched: matched.length,
        missing: missing.length,
        total: parsed.entries.length,
        missingEntries: missing.slice(0, 20)
      }
    };
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

  function reorderPlaylist(playlistId, input = {}) {
    const database = dbOrOpen();
    const playlist = database.prepare("SELECT id FROM music_playlists WHERE id = ?").get(playlistId);
    if (!playlist) return null;
    const requested = playlistTrackIdsFromInput(input);
    if (!requested.length) throw httpError(400, "缺少歌曲排序");
    const existing = database
      .prepare(
        `
        SELECT track_id
        FROM music_playlist_items
        WHERE playlist_id = ?
        ORDER BY sort_order ASC, added_at ASC
      `
      )
      .all(playlistId)
      .map((row) => row.track_id);
    const existingSet = new Set(existing);
    const ordered = requested.filter((trackId) => existingSet.has(trackId));
    if (!ordered.length) throw httpError(400, "没有可排序的歌曲");
    const orderedSet = new Set(ordered);
    const nextOrder = [...ordered, ...existing.filter((trackId) => !orderedSet.has(trackId))];
    const now = new Date().toISOString();
    const updateItem = database.prepare("UPDATE music_playlist_items SET sort_order = ? WHERE playlist_id = ? AND track_id = ?");
    database.exec("BEGIN IMMEDIATE");
    try {
      nextOrder.forEach((trackId, index) => updateItem.run(index + 1, playlistId, trackId));
      database.prepare("UPDATE music_playlists SET updated_at = ? WHERE id = ?").run(now, playlistId);
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
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
    if (!dryRun) {
      writeScanRecords(dbOrOpen(), records, scanRoots, result.scannedAt);
      summaryCache = null;
      summaryCachedAt = 0;
    }
    return result;
  }

  function dbOrOpen() {
    return database();
  }

  return {
    coverFile,
    dbPath,
    facets,
    report,
    suggest,
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
    importM3uPlaylist,
    playlistDetail,
    playlistM3u,
    reorderPlaylist,
    removeFromPlaylist,
    saveProgress,
    scan,
    smartPlaylistDetail,
    setRating,
    summary,
    toggleFavorite,
    trackDetail,
    trackFile,
    updatePlaylist
  };
}
