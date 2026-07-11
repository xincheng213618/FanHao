// Music store sub-module: facets
import { findSmartMix, smartMixCondition } from "./smart-mix.js";
import { MUSIC_FACET_CACHE } from "./constants.js";
import { publicAlbum, publicArtist, publicGenre } from "./serializers.js";
import { metaValue, parseJsonObject } from "./helpers.js";
import { normalizeMusicLanguage } from "./language.js";

export function artistFacet(db, language = "", selectedArtistId = "") {
  const normalizedLanguage = normalizeMusicLanguage(language);
  const rows = cachedMusicFacet(db, `artists:${normalizedLanguage || "all"}`, () => db
    .prepare(
      `
      SELECT id, name, language, album_count, track_count, duration_ms, size_bytes
      FROM music_artists
      WHERE track_count > 0${normalizedLanguage ? " AND language = ?" : ""}
      ORDER BY track_count DESC, name COLLATE NOCASE
      LIMIT 48
    `
    )
    .all(...(normalizedLanguage ? [normalizedLanguage] : []))
    .map(publicArtist));
  if (!selectedArtistId || selectedArtistId === "all" || rows.some((artist) => artist.id === selectedArtistId)) return rows;
  const selected = db.prepare("SELECT * FROM music_artists WHERE id = ? AND track_count > 0").get(selectedArtistId);
  return selected ? [publicArtist(selected), ...rows.slice(0, 47)] : rows;
}


export function albumFacet(db, artistId = "", genre = "", language = "", selectedAlbumId = "") {
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
  const normalizedLanguage = normalizeMusicLanguage(language);
  if (normalizedLanguage) {
    where.push("al.id IN (SELECT album_id FROM music_tracks WHERE status = 'ok' AND language = ?)");
    args.push(normalizedLanguage);
  }
  const cacheKey = `albums:${artistId || "all"}:${genre || "all"}:${normalizedLanguage || "all"}`;
  const rows = cachedMusicFacet(db, cacheKey, () => db
    .prepare(
      `
      SELECT al.*, a.name AS artist_name
      FROM music_albums al
      LEFT JOIN music_artists a ON a.id = al.artist_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY al.track_count DESC, al.title COLLATE NOCASE
      LIMIT 60
    `
    )
    .all(...args)
    .map(publicAlbum));
  if (!selectedAlbumId || selectedAlbumId === "all" || rows.some((album) => album.id === selectedAlbumId)) return rows;
  const selected = db
    .prepare("SELECT al.*,a.name AS artist_name FROM music_albums al LEFT JOIN music_artists a ON a.id=al.artist_id WHERE al.id=? AND al.track_count>0")
    .get(selectedAlbumId);
  return selected ? [publicAlbum(selected), ...rows.slice(0, 59)] : rows;
}


export function genreFacet(db, artistId = "") {
  const args = [];
  const where = ["status = 'ok'", "TRIM(COALESCE(genre, '')) <> ''"];
  if (artistId && artistId !== "all") {
    where.push("artist_id = ?");
    args.push(artistId);
  }
  return cachedMusicFacet(db, `genres:${artistId || "all"}`, () => db
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
      LIMIT 40
    `
    )
    .all(...args)
    .map(publicGenre));
}


export function languageFacet(db) {
  return cachedMusicFacet(db, "languages", () => db
    .prepare(
      `
      SELECT a.language AS name, COALESCE(SUM(a.track_count), 0) AS track_count,
             COUNT(*) AS artist_count,
             (
               SELECT COUNT(*)
               FROM music_albums al
               JOIN music_artists aa ON aa.id = al.artist_id
               WHERE aa.status = 'ok' AND aa.track_count > 0
                 AND aa.language = a.language AND al.track_count > 0
             ) AS album_count,
             COALESCE(SUM(a.duration_ms), 0) AS duration_ms,
             COALESCE(SUM(a.size_bytes), 0) AS size_bytes
      FROM music_artists a
      WHERE a.status = 'ok' AND a.track_count > 0
      GROUP BY a.language
      ORDER BY CASE a.language
        WHEN '中文' THEN 1 WHEN '英文' THEN 2 WHEN '日文' THEN 3
        WHEN '韩文' THEN 4 WHEN '其他' THEN 5 WHEN '待识别' THEN 6 ELSE 7 END
      `
    )
    .all()
    .map(publicGenre));
}


export function cachedMusicFacet(db, key, build) {
  let cache = MUSIC_FACET_CACHE.get(db);
  if (!cache) {
    cache = new Map();
    MUSIC_FACET_CACHE.set(db, cache);
  }
  if (cache.has(key)) return cache.get(key);
  const value = build();
  cache.set(key, value);
  return value;
}


export function smartMixCount(db, mix) {
  const condition = smartMixCondition(mix);
  if (["newest", "hires", "lyrics", "longform"].includes(mix.id)) {
    const stored = parseJsonObject(metaValue(db, "smart_static_counts_json"));
    if (Number.isFinite(Number(stored[mix.id]))) return Number(stored[mix.id]);
  }
  if (mix.id === "unplayed") {
    const total = Number(db.prepare("SELECT COALESCE(SUM(track_count), 0) AS count FROM music_artists WHERE status = 'ok'").get()?.count || 0);
    const played = Number(db.prepare("SELECT COUNT(*) AS count FROM music_track_state WHERE COALESCE(play_count, 0) > 0 OR COALESCE(last_played_at, '') <> ''").get()?.count || 0);
    return Math.max(0, total - played);
  }
  if (mix.id === "unrated") {
    const total = Number(db.prepare("SELECT COALESCE(SUM(track_count), 0) AS count FROM music_artists WHERE status = 'ok'").get()?.count || 0);
    const rated = Number(db.prepare("SELECT COUNT(*) AS count FROM music_track_state WHERE COALESCE(rating, 0) > 0").get()?.count || 0);
    return Math.max(0, total - rated);
  }
  const stateDriven = new Set(["recent", "topplayed", "favorites", "toprated", "rediscover"]);
  const from = stateDriven.has(mix.id)
    ? "music_track_state s CROSS JOIN music_tracks t ON t.id = s.track_id"
    : "music_tracks t";
  return Number(
    db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM ${from}
        WHERE t.status = 'ok' AND ${condition.where}
      `
      )
      .get(...condition.args)?.count || 0
  );
}
