// Music store sub-module: facets
import { findSmartMix, smartMixCondition, smartMixRequiresState } from "./smart-mix.js";
import { cachedMusicFacet } from "./facet-cache.js";
import { publicAlbum, publicArtist, publicGenre } from "./serializers.js";
import { metaValue, parseJsonObject } from "./helpers.js";
import { normalizeMusicLanguage } from "./language.js";

export { cachedMusicFacet } from "./facet-cache.js";

export const ARTIST_FACET_COLUMNS = "id,name,language,album_count,track_count,duration_ms,size_bytes";

export function prepareArtistFacet(db, sql) {
  try {
    return db.prepare(sql);
  } catch (error) {
    // Preserve old artist tables that lack optional public DTO columns.
    // Other prepare/read failures retain their original error and retry path.
    if (error?.code === "ERR_SQLITE_ERROR" && error.errcode === 1
      && /^no such column: (?:language|album_count|duration_ms|size_bytes)$/u.test(error.message)) {
      return db.prepare(sql.replace(ARTIST_FACET_COLUMNS, "*"));
    }
    throw error;
  }
}

export function artistFacet(db, language = "", selectedArtistId = "") {
  const normalizedLanguage = normalizeMusicLanguage(language);
  const rows = cachedMusicFacet(db, JSON.stringify(["artists", normalizedLanguage]), () => db
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
  const selected = prepareArtistFacet(db, `SELECT ${ARTIST_FACET_COLUMNS} FROM music_artists WHERE id = ? AND track_count > 0`).get(selectedArtistId);
  return selected ? [publicArtist(selected), ...rows.slice(0, 47)] : rows;
}


export const ALBUM_FACET_COLUMNS = "al.id,al.artist_id,al.title,al.year,al.cover_path,al.track_count,al.duration_ms,al.size_bytes,al.updated_at";

export function prepareAlbumFacet(db, sql) {
  try {
    return db.prepare(sql);
  } catch (error) {
    // Older album tables can lack optional DTO columns. Only a native
    // prepare-time missing column falls back to the original wide query.
    if (error?.code === "ERR_SQLITE_ERROR" && error.errcode === 1
      && /^no such column: al\.(?:year|cover_path|duration_ms|size_bytes|updated_at)$/u.test(error.message)) {
      return db.prepare(sql.replace(ALBUM_FACET_COLUMNS, "al.*"));
    }
    throw error;
  }
}

export function readUpdatedAlbumPage(db, originalSql, order, limit, offset) {
  db.exec("SAVEPOINT music_updated_album_page");
  try {
    let statement;
    try {
      const schema = db.prepare(`SELECT
        (SELECT sql FROM main.sqlite_schema WHERE type = 'table' AND name = 'music_artists' COLLATE NOCASE) AS artists,
        EXISTS(SELECT 1 FROM pragma_table_list('music_albums') WHERE schema = 'main' AND type = 'table' AND wr = 0) AS album_table,
        EXISTS(SELECT 1 FROM temp.sqlite_schema WHERE name COLLATE NOCASE IN ('music_albums', 'music_artists')) AS shadowed`).get();
      const columns = db.prepare("PRAGMA main.table_xinfo(music_albums)").all();
      if (schema?.album_table !== 1 || schema.shadowed !== 0
        || !/^CREATE\s+TABLE\s+music_artists\s*\(\s*id\s+TEXT\s+PRIMARY\s+KEY\s*,/iu.test(schema.artists || "")
        || !columns.some(column => column.name === "artist_id" && column.type.toUpperCase() === "TEXT")
        || columns.some(column => column.name.toLowerCase() === "_rowid_")) return null;

      const plan = db.prepare(`EXPLAIN QUERY PLAN ${originalSql}`).all(limit, offset);
      if (plan.length !== 3 || !plan[1].detail.endsWith(" LEFT-JOIN") || plan[2].detail !== "USE TEMP B-TREE FOR ORDER BY") return null;
      let ties = "al._rowid_ ASC";
      if (plan[0].detail === "SCAN al USING INDEX idx_music_albums_artist") {
        const keys = db.prepare("PRAGMA main.index_xinfo(idx_music_albums_artist)").all();
        if (keys.length !== 3 || keys[0].name !== "artist_id" || keys[1].name !== "title" || keys[2].cid !== -1
          || keys.some(key => key.coll !== "BINARY" || key.desc !== 0)) return null;
        ties = `al.artist_id COLLATE BINARY ASC, al.title COLLATE BINARY ASC, ${ties}`;
      } else if (plan[0].detail !== "SCAN al") return null;

      // The former temp sort breaks ties in album scan order. Reproduce that
      // order explicitly, using sequential reads and deferring artist lookup.
      const pageOrder = `${order}, ${ties}`;
      statement = db.prepare(`WITH page AS MATERIALIZED (
        SELECT al._rowid_ AS album_rowid FROM music_albums al NOT INDEXED
        ORDER BY ${pageOrder} LIMIT ? OFFSET ?
      )
      SELECT ${ALBUM_FACET_COLUMNS}, a.name AS artist_name
      FROM page CROSS JOIN music_albums al ON al._rowid_ = page.album_rowid
      LEFT JOIN music_artists a ON a.id = al.artist_id
      ORDER BY ${pageOrder}`);
    } catch {
      // Unrecognized or unavailable plans retain the original preparation.
      return null;
    }
    return statement.all(limit, offset);
  } finally {
    db.exec("RELEASE music_updated_album_page");
  }
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
  const cacheKey = JSON.stringify(["albums", artistId && artistId !== "all" ? artistId : "", genre && genre !== "all" ? genre : "", normalizedLanguage]);
  const rows = cachedMusicFacet(db, cacheKey, () => prepareAlbumFacet(db,
      `
      SELECT ${ALBUM_FACET_COLUMNS}, a.name AS artist_name
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
  const selected = prepareAlbumFacet(db,
    `SELECT ${ALBUM_FACET_COLUMNS},a.name AS artist_name FROM music_albums al LEFT JOIN music_artists a ON a.id=al.artist_id WHERE al.id=? AND al.track_count>0`)
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
  return cachedMusicFacet(db, JSON.stringify(["genres", artistId && artistId !== "all" ? artistId : ""]), () => db
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
  return cachedMusicFacet(db, JSON.stringify(["languages"]), () => db
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


export function smartMixListCounts(db) {
  const conditions = ["recent", "topplayed", "favorites", "toprated"]
    .map(id => ({ id, ...smartMixCondition(id) }));
  conditions.push(
    { id: "played", where: "(COALESCE(s.play_count, 0)>0 OR COALESCE(s.last_played_at, '')<>'')", args: [] },
    { id: "rated", where: "COALESCE(s.rating, 0)>0", args: [] }
  );
  const select = conditions.map(({ id, where }) => `COUNT(CASE WHEN ${where} THEN 1 END) AS ${id}`).join(", ");
  const eligible = conditions.map(({ where }) => `(${where})`).join(" OR ");
  const args = conditions.flatMap(condition => condition.args);
  const row = db.prepare(`
    SELECT ${select}
    FROM music_track_state s
    CROSS JOIN music_tracks t ON t.id=s.track_id
    WHERE t.status='ok' AND (${eligible})
  `).get(...args, ...args);
  const total = Number(db.prepare("SELECT COALESCE(SUM(track_count), 0) AS count FROM music_artists WHERE status = 'ok'").get()?.count || 0);
  // Rediscover retains its lazy cutoff at the original list position. Static
  // metadata and callers reading a single mix still use smartMixCount below.
  return new Map([
    ...conditions.slice(0, 4).map(({ id }) => [id, Number(row?.[id] || 0)]),
    ["unplayed", Math.max(0, total - Number(row?.played || 0))],
    ["unrated", Math.max(0, total - Number(row?.rated || 0))]
  ]);
}


export function smartMixCount(db, mix) {
  const condition = smartMixCondition(mix);
  if (["newest", "hires", "lyrics", "longform"].includes(mix.id)) {
    const stored = parseJsonObject(metaValue(db, "smart_static_counts_json"));
    if (Number.isFinite(Number(stored[mix.id]))) return Number(stored[mix.id]);
  }
  if (mix.id === "unplayed") {
    const total = Number(db.prepare("SELECT COALESCE(SUM(track_count), 0) AS count FROM music_artists WHERE status = 'ok'").get()?.count || 0);
    const played = Number(db.prepare(`SELECT COUNT(*) AS count FROM music_track_state s
      CROSS JOIN music_tracks t ON t.id=s.track_id
      WHERE t.status='ok' AND (COALESCE(s.play_count, 0)>0 OR COALESCE(s.last_played_at, '')<>'')`).get()?.count || 0);
    return Math.max(0, total - played);
  }
  if (mix.id === "unrated") {
    const total = Number(db.prepare("SELECT COALESCE(SUM(track_count), 0) AS count FROM music_artists WHERE status = 'ok'").get()?.count || 0);
    const rated = Number(db.prepare(`SELECT COUNT(*) AS count FROM music_track_state s
      CROSS JOIN music_tracks t ON t.id=s.track_id
      WHERE t.status='ok' AND COALESCE(s.rating, 0)>0`).get()?.count || 0);
    return Math.max(0, total - rated);
  }
  const from = smartMixRequiresState(mix)
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
