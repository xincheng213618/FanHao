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

export function createGalleryMetadataService({
  createId,
  getImageGalleryDb,
  notFound
}) {
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
      const rows = getImageGalleryDb().prepare("SELECT * FROM tv_series_metadata").all();
      return new Map(rows.map((row) => [row.series_key, row]));
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
      const rows = getImageGalleryDb().prepare("SELECT * FROM movie_metadata").all();
      return new Map(rows.map((row) => [row.media_id, row]));
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
    if (!row || row.status !== "ok") return null;
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
    sendCover(res, movieRow(mediaId));
  }

  return {
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
