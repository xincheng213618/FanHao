import { randomUUID } from "node:crypto";
import {
  GALLERY_METADATA_CLOCK_CONTRACT_SQL,
  GALLERY_METADATA_CLOCK_TABLE,
  galleryMetadataClockKinds,
  trustedGalleryMetadataClockKinds,
  validGalleryMetadataClock
} from "../../../../lib/gallery-metadata-revision.js";

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeJsonObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function positiveEpisodeCount(value) {
  if (typeof value !== "string" && typeof value !== "number") return false;
  const match = /^(?:共\s*)?(\d+)(?:\.0+)?\s*(?:集|季|episodes?|seasons?)?$/iu.exec(String(value).trim());
  const count = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(count) && count > 0;
}

function positiveEpisodeDuration(value) {
  if (typeof value !== "string" && typeof value !== "number") return false;
  const text = String(value).trim();
  const positiveFinite = value => Number.isFinite(value) && value > 0;
  if (/^\d+(?:\.\d+)?$/u.test(text)) return positiveFinite(Number(text));
  const iso = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/iu.exec(text);
  if (iso) return positiveFinite(Number(iso[1] || 0) * 3600 + Number(iso[2] || 0) * 60 + Number(iso[3] || 0));
  const clock = /^(\d+):([0-5]\d):([0-5]\d)$/u.exec(text);
  if (clock) return positiveFinite(Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]));
  const unit = /^(?:约\s*)?(\d+(?:\.\d+)?)\s*(分钟|小时|秒钟|分|秒|hours?|hrs?|minutes?|mins?|seconds?|secs?)$/iu.exec(text);
  if (!unit) return false;
  const scale = /^(?:小时|hours?|hrs?)$/iu.test(unit[2]) ? 3600 : /^(?:分钟|分|minutes?|mins?)$/iu.test(unit[2]) ? 60 : 1;
  return positiveFinite(Number(unit[1]) * scale);
}

function jsonLdHasTvType(value) {
  let parsed;
  try { parsed = typeof value === "string" ? JSON.parse(value) : value; } catch { return false; }
  const pending = [parsed];
  const seen = new Set();
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) { pending.push(...node); continue; }
    const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
    if (types.some(type => typeof type === "string" && /^(?:https?:\/\/schema\.org\/)?TV(?:Series|Season|Episode)$/iu.test(type.trim()))) return true;
    if (node["@graph"]) pending.push(node["@graph"]);
  }
  return false;
}

// Publication guard only: retain the source record and its local classification.
// A title/year mismatch alone is not proof that a movie is actually television.
function movieMetadataHasTvEvidence(row) {
  if (!row) return false;
  const info = safeJsonObject(row.info_json);
  return positiveEpisodeCount(row.episode_count) || positiveEpisodeCount(row.season_count)
    || positiveEpisodeDuration(row.episode_duration)
    || positiveEpisodeCount(info["集数"]) || positiveEpisodeCount(info["季数"])
    || positiveEpisodeDuration(info["单集片长"])
    || jsonLdHasTvType(row.json_ld_json);
}

export function createGalleryMetadataService({
  createId,
  getImageGalleryDb,
  notFound
}) {
  const metadataProjections = new WeakMap();
  const listRevisions = new WeakMap();
  const revisionRealm = randomUUID();
  let connectionSequence = 0;
  let unavailableSequence = 0;

  function listRevision(mode = "media") {
    try {
      const db = getImageGalleryDb();
      let state = listRevisions.get(db);
      if (!state) {
        state = {
          identity: ++connectionSequence,
          schemaChanges: db.prepare("PRAGMA schema_version"),
          contract: db.prepare(GALLERY_METADATA_CLOCK_CONTRACT_SQL),
          schemaVersion: null,
          trustedKinds: new Set()
        };
        listRevisions.set(db, state);
      }
      const schemaVersion = state.schemaChanges.get().schema_version;
      if (schemaVersion !== state.schemaVersion) {
        // Schema changes can remove or replace a trigger under its original
        // name. Trust its complete contract, rather than just its presence.
        state.trustedKinds = trustedGalleryMetadataClockKinds(state.contract.all());
        state.schemaVersion = schemaVersion;
      }
      const kinds = galleryMetadataClockKinds(mode);
      if (kinds.every(kind => state.trustedKinds.has(kind))) {
        state.clock ||= db.prepare(`SELECT epoch, revision FROM ${GALLERY_METADATA_CLOCK_TABLE} WHERE kind = ?`);
        const clocks = kinds.map(kind => state.clock.get(kind));
        if (clocks.every(validGalleryMetadataClock)) {
          return JSON.stringify([revisionRealm, state.identity, schemaVersion, kinds, clocks]);
        }
      }
      state.localChanges ||= db.prepare("SELECT total_changes() AS changes");
      state.externalChanges ||= db.prepare("PRAGMA data_version");
      return JSON.stringify([revisionRealm, state.identity, schemaVersion, "fallback",
        state.localChanges.get().changes, state.externalChanges.get().data_version]);
    } catch {
      // A failed source probe must never authorize an append to an older page.
      return JSON.stringify([revisionRealm, "unavailable", ++unavailableSequence]);
    }
  }

  function metadataRowsMap(table, key) {
    const db = getImageGalleryDb();
    let state = metadataProjections.get(db);
    if (!state) {
      state = { schemaVersion: db.prepare("PRAGMA schema_version"), version: null, tables: new Map() };
      metadataProjections.set(db, state);
    }
    const version = state.schemaVersion.get().schema_version;
    if (version !== state.version) {
      state.tables.clear();
      state.version = version;
    }
    let statement = state.tables.get(table);
    if (!statement) {
      const quote = name => `"${String(name).replaceAll('"', '""')}"`;
      const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row => row.name);
      const projection = columns.map(name => name === "cover_blob"
        // node:sqlite reads TEXT through its first NUL; SQLite length() has
        // the same boundary. Empty BLOBs still become truthy Uint8Arrays.
        ? `CASE typeof("cover_blob") WHEN 'blob' THEN 1 WHEN 'text' THEN length("cover_blob") > 0 WHEN 'integer' THEN "cover_blob" != 0 WHEN 'real' THEN "cover_blob" != 0 ELSE NULL END AS "cover_blob"`
        : quote(name)).join(", ");
      statement = db.prepare(`SELECT ${projection || "*"} FROM ${quote(table)}`);
      state.tables.set(table, statement);
    }
    return new Map(statement.all().map(row => [row[key], row]));
  }

  function tvSeriesKey(category, seriesName) {
    return createId("tvs", `${String(category || "").trim()}|${String(seriesName || "").trim()}`);
  }

  function tvSeriesCoverUrl(seriesKey, updatedAt = "") {
    if (!seriesKey) return "";
    const suffix = updatedAt ? `?v=${encodeURIComponent(updatedAt)}` : "";
    return `/media/tv-series-cover/${encodeURIComponent(seriesKey)}${suffix}`;
  }

  function movieCoverUrl(mediaId, updatedAt = "") {
    if (!mediaId) return "";
    const suffix = updatedAt ? `?v=${encodeURIComponent(updatedAt)}` : "";
    return `/media/movie-cover/${encodeURIComponent(mediaId)}${suffix}`;
  }

  function tvSeriesRowsMap() {
    try {
      return metadataRowsMap("tv_series_metadata", "series_key");
    } catch (error) {
      console.warn("[tv-series-metadata-db]", error.message || error);
      return new Map();
    }
  }

  function tvSeriesRow(seriesKey) {
    if (!seriesKey) return null;
    try {
      return getImageGalleryDb().prepare("SELECT * FROM tv_series_metadata WHERE series_key = ?").get(seriesKey) || null;
    } catch (error) {
      console.warn("[tv-series-metadata-db]", error.message || error);
      return null;
    }
  }

  function movieRowsMap() {
    try {
      return metadataRowsMap("movie_metadata", "media_id");
    } catch (error) {
      console.warn("[movie-metadata-db]", error.message || error);
      return new Map();
    }
  }

  function movieRow(mediaId) {
    if (!mediaId) return null;
    try {
      return getImageGalleryDb().prepare("SELECT * FROM movie_metadata WHERE media_id = ?").get(mediaId) || null;
    } catch (error) {
      console.warn("[movie-metadata-db]", error.message || error);
      return null;
    }
  }

  function publicMovie(row) {
    if (!row || row.status !== "ok" || movieMetadataHasTvEvidence(row)) return null;
    return {
      mediaId: row.media_id || "",
      category: row.category || "",
      movieTitle: row.movie_title || "",
      doubanId: row.douban_id || "",
      doubanUrl: row.douban_url || "",
      title: row.douban_title || row.movie_title || "",
      originalTitle: row.original_title || "",
      aliases: safeJsonArray(row.aka_json),
      officialSite: row.official_site || "",
      year: row.year || "",
      rating: row.rating === null || row.rating === undefined ? null : Number(row.rating || 0),
      ratingCount: Number(row.rating_count || 0),
      ratingStars: safeJsonObject(row.rating_stars_json),
      ratingBetterThan: safeJsonArray(row.rating_better_than_json),
      directors: safeJsonArray(row.directors_json),
      writers: safeJsonArray(row.writers_json),
      genres: safeJsonArray(row.genres_json),
      actors: safeJsonArray(row.actors_json),
      countries: safeJsonArray(row.countries_json),
      languages: safeJsonArray(row.languages_json),
      pubdate: row.pubdate || "",
      releaseDates: safeJsonArray(row.release_dates_json),
      seasonCount: row.season_count === null || row.season_count === undefined ? null : Number(row.season_count || 0),
      episodeCount: row.episode_count === null || row.episode_count === undefined ? null : Number(row.episode_count || 0),
      episodeDuration: row.episode_duration || "",
      durations: safeJsonArray(row.durations_json),
      imdbId: row.imdb_id || "",
      info: safeJsonObject(row.info_json),
      detailSource: row.detail_source || "",
      summary: row.summary || "",
      coverUrl: row.cover_blob ? movieCoverUrl(row.media_id, row.updated_at || "") : "",
      fetchedAt: row.fetched_at || "",
      updatedAt: row.updated_at || ""
    };
  }

  function publicTvSeries(row) {
    if (!row || row.status !== "ok") return null;
    return {
      seriesKey: row.series_key || "",
      category: row.category || "",
      seriesName: row.series_name || "",
      doubanId: row.douban_id || "",
      doubanUrl: row.douban_url || "",
      title: row.douban_title || row.series_name || "",
      originalTitle: row.original_title || "",
      aliases: safeJsonArray(row.aka_json),
      officialSite: row.official_site || "",
      year: row.year || "",
      rating: row.rating === null || row.rating === undefined ? null : Number(row.rating || 0),
      ratingCount: Number(row.rating_count || 0),
      ratingStars: safeJsonObject(row.rating_stars_json),
      ratingBetterThan: safeJsonArray(row.rating_better_than_json),
      directors: safeJsonArray(row.directors_json),
      writers: safeJsonArray(row.writers_json),
      genres: safeJsonArray(row.genres_json),
      actors: safeJsonArray(row.actors_json),
      countries: safeJsonArray(row.countries_json),
      languages: safeJsonArray(row.languages_json),
      pubdate: row.pubdate || "",
      releaseDates: safeJsonArray(row.release_dates_json),
      seasonCount: row.season_count === null || row.season_count === undefined ? null : Number(row.season_count || 0),
      episodeCount: row.episode_count === null || row.episode_count === undefined ? null : Number(row.episode_count || 0),
      episodeDuration: row.episode_duration || "",
      durations: safeJsonArray(row.durations_json),
      imdbId: row.imdb_id || "",
      info: safeJsonObject(row.info_json),
      detailSource: row.detail_source || "",
      summary: row.summary || "",
      coverUrl: row.cover_blob ? tvSeriesCoverUrl(row.series_key, row.updated_at || "") : "",
      fetchedAt: row.fetched_at || "",
      updatedAt: row.updated_at || ""
    };
  }

  function sendCover(res, row) {
    if (!row?.cover_blob || row.status !== "ok") {
      notFound(res);
      return;
    }
    const buffer = Buffer.from(row.cover_blob);
    res.writeHead(200, {
      "Content-Type": row.cover_mime || "image/jpeg",
      "Content-Length": buffer.length,
      "Cache-Control": "public, max-age=86400",
      "Content-Disposition": "inline"
    });
    res.end(buffer);
  }

  function serveTvSeriesCover(res, seriesKey) {
    sendCover(res, tvSeriesRow(seriesKey));
  }

  function serveMovieCover(res, mediaId) {
    const row = movieRow(mediaId);
    if (movieMetadataHasTvEvidence(row)) {
      notFound(res);
      return;
    }
    sendCover(res, row);
  }

  return {
    listRevision,
    movieRow,
    movieRowsMap,
    publicMovie,
    publicTvSeries,
    serveMovieCover,
    serveTvSeriesCover,
    tvSeriesKey,
    tvSeriesRow,
    tvSeriesRowsMap
  };
}
