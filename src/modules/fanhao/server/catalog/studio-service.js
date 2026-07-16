export function createStudioService({
  clampInteger,
  enrichLocalWorksWithActorMovieIndex,
  getCoreDb,
  getLibrary,
  getStamp,
  pagedWorksPayload,
  publicRemoteUrl,
  sortWorkList,
  workFacets
}) {
  let studioHierarchyCache = null;
  let studioDetailCacheStamp = null;
  const studioMakerCache = new Map();
  const studioWorksCache = new Map();

  function ensureDetailCaches(stamp) {
    if (studioDetailCacheStamp === stamp) return;
    studioDetailCacheStamp = stamp;
    studioMakerCache.clear();
    studioWorksCache.clear();
  }

  function ensureCatalog({ force = false } = {}) {
    const stamp = getStamp();
    ensureDetailCaches(stamp);
    if (!force && studioHierarchyCache?.stamp === stamp) return studioHierarchyCache;
    const db = getCoreDb();
    const counts = db
      .prepare(
        `
        SELECT
          (SELECT COUNT(*) FROM makers) AS maker_count,
          (SELECT COUNT(*) FROM series) AS series_count,
          (SELECT COUNT(*) FROM work_makers) AS link_count
        `
      )
      .get();
    studioHierarchyCache = {
      stamp,
      makerCount: Number(counts?.maker_count || 0),
      seriesCount: Number(counts?.series_count || 0),
      prefixCount: 0,
      linkCount: Number(counts?.link_count || 0),
      syncedAt: new Date().toISOString()
    };
    return studioHierarchyCache;
  }

  function prefixRowsForMaker(makerId) {
    return [];
  }

  function seriesRowsForMaker(makerId) {
    return getCoreDb()
      .prepare(
        `
        SELECT
          CAST(s.id AS TEXT) AS series_id,
          CAST(s.maker_id AS TEXT) AS maker_id,
          s.name,
          s.name_search AS normalized_name,
          s.kind,
          ref.url AS javdb_url,
          '' AS primary_prefix,
          s.source,
          COUNT(DISTINCT ws.work_id) AS work_count,
          COUNT(DISTINCT lw.work_id) AS local_work_count,
          MIN(w.release_date) AS first_release_date,
          MAX(w.release_date) AS latest_release_date
        FROM series s
        LEFT JOIN series_external_refs ref ON ref.series_id = s.id
        LEFT JOIN work_series ws ON ws.series_id = s.id
        LEFT JOIN works w ON w.id = ws.work_id
        LEFT JOIN local_works lw ON lw.work_id = ws.work_id
        WHERE maker_id = ?
        GROUP BY s.id
        ORDER BY work_count DESC, s.name
        `
      )
      .all(Number(makerId));
  }

  function publicSeries(row, prefixRows = []) {
    const prefixes = prefixRows
      .filter((item) => item.series_id === row.series_id)
      .map((item) => ({
        prefix: item.prefix,
        source: item.source || "",
        confidence: item.confidence ?? 1,
        workCount: item.work_count || 0,
        localWorkCount: item.local_work_count || 0
      }));
    return {
      id: row.series_id,
      makerId: row.maker_id,
      name: row.name || "",
      kind: row.kind || "series",
      url: publicRemoteUrl(row.javdb_url),
      primaryPrefix: row.primary_prefix || prefixes[0]?.prefix || "",
      prefixes,
      source: row.source || "",
      workCount: row.work_count || 0,
      localWorkCount: row.local_work_count || 0,
      firstReleaseDate: row.first_release_date || "",
      latestReleaseDate: row.latest_release_date || ""
    };
  }

  function publicMaker(row, seriesRows = [], prefixRows = []) {
    return {
      id: row.maker_id,
      name: row.name || "",
      url: publicRemoteUrl(row.javdb_url),
      source: row.source || "",
      workCount: row.work_count || 0,
      localWorkCount: row.local_work_count || 0,
      firstReleaseDate: row.first_release_date || "",
      latestReleaseDate: row.latest_release_date || "",
      series: seriesRows.map((seriesRow) => publicSeries(seriesRow, prefixRows)),
      prefixes: prefixRows
        .filter((item) => !item.series_id)
        .map((item) => ({
          prefix: item.prefix,
          source: item.source || "",
          confidence: item.confidence ?? 1,
          workCount: item.work_count || 0,
          localWorkCount: item.local_work_count || 0
        }))
    };
  }

  function publicMakerSummary(row) {
    return {
      id: row.maker_id,
      name: row.name || "",
      url: publicRemoteUrl(row.javdb_url),
      source: row.source || "",
      workCount: row.work_count || 0,
      localWorkCount: row.local_work_count || 0,
      firstReleaseDate: row.first_release_date || "",
      latestReleaseDate: row.latest_release_date || ""
    };
  }

  function summaries(url) {
    const sync = ensureCatalog();
    const limit = clampInteger(url.searchParams.get("limit"), 120, 1, 1000);
    const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
    const rows = getCoreDb()
      .prepare(
        `
        SELECT
          CAST(m.id AS TEXT) AS maker_id,
          m.name,
          m.name_search AS normalized_name,
          ref.url AS javdb_url,
          m.source,
          COUNT(DISTINCT wm.work_id) AS work_count,
          COUNT(DISTINCT lw.work_id) AS local_work_count,
          MIN(w.release_date) AS first_release_date,
          MAX(w.release_date) AS latest_release_date
        FROM makers m
        LEFT JOIN maker_external_refs ref ON ref.maker_id = m.id
        LEFT JOIN work_makers wm ON wm.maker_id = m.id
        LEFT JOIN works w ON w.id = wm.work_id
        LEFT JOIN local_works lw ON lw.work_id = wm.work_id
        WHERE (? = '' OR m.name_search LIKE ? OR m.name LIKE ?)
        GROUP BY m.id
        ORDER BY work_count DESC, name
        LIMIT ?
        `
      )
      .all(q, `%${q}%`, `%${q}%`, limit);
    const makers = rows.map(publicMakerSummary);
    return { sync, count: makers.length, makers };
  }

  function detailPayload(makerId, url) {
    const sync = ensureCatalog();
    const db = getCoreDb();
    const requestedSeriesId = String(url.searchParams.get("seriesId") || "all").trim() || "all";
    const selectedSeriesId = requestedSeriesId === "all" || /^\d+$/.test(requestedSeriesId) ? requestedSeriesId : "all";
    const maker = cachedMakerDetail(makerId, db);
    if (!maker) return null;
    const workSet = cachedStudioWorks(makerId, selectedSeriesId, db);
    const sort = url.searchParams.get("sort") || "releaseDesc";
    let sorted = workSet.sortedByMode.get(sort);
    if (!sorted) {
      sorted = sortWorkList(workSet.works, sort);
      workSet.sortedByMode.set(sort, sorted);
    }
    return {
      sync,
      studio: maker.studio,
      selectedSeriesId,
      ...pagedWorksPayload(sorted, url, { facets: workSet.facets })
    };
  }

  function cachedMakerDetail(makerId, db) {
    const cacheKey = String(makerId);
    if (studioMakerCache.has(cacheKey)) return studioMakerCache.get(cacheKey);
    const row = db
      .prepare(
        `
        SELECT
          CAST(m.id AS TEXT) AS maker_id,
          m.name,
          m.name_search AS normalized_name,
          ref.url AS javdb_url,
          m.source,
          COUNT(DISTINCT wm.work_id) AS work_count,
          COUNT(DISTINCT lw.work_id) AS local_work_count,
          MIN(w.release_date) AS first_release_date,
          MAX(w.release_date) AS latest_release_date
        FROM makers m
        LEFT JOIN maker_external_refs ref ON ref.maker_id = m.id
        LEFT JOIN work_makers wm ON wm.maker_id = m.id
        LEFT JOIN works w ON w.id = wm.work_id
        LEFT JOIN local_works lw ON lw.work_id = wm.work_id
        WHERE m.id = ?
        GROUP BY m.id
        `
      )
      .get(Number(makerId));
    if (!row) {
      studioMakerCache.set(cacheKey, null);
      return null;
    }
    const seriesRows = seriesRowsForMaker(makerId);
    const prefixRows = prefixRowsForMaker(makerId);
    const detail = { studio: publicMaker(row, seriesRows, prefixRows) };
    studioMakerCache.set(cacheKey, detail);
    return detail;
  }

  function cachedStudioWorks(makerId, selectedSeriesId, db) {
    const cacheKey = `${makerId}:${selectedSeriesId}`;
    const cached = studioWorksCache.get(cacheKey);
    if (cached) return cached;
    const filterBySeries = selectedSeriesId !== "all";
    const linkRows = filterBySeries
      ? db.prepare("SELECT DISTINCT CAST(wm.work_id AS TEXT) AS work_id FROM work_makers wm JOIN work_series ws ON ws.work_id = wm.work_id JOIN local_works lw ON lw.work_id = wm.work_id WHERE wm.maker_id = ? AND ws.series_id = ?").all(Number(makerId), Number(selectedSeriesId))
      : db.prepare("SELECT DISTINCT CAST(wm.work_id AS TEXT) AS work_id FROM work_makers wm JOIN local_works lw ON lw.work_id = wm.work_id WHERE wm.maker_id = ?").all(Number(makerId));
    const library = getLibrary();
    const works = enrichLocalWorksWithActorMovieIndex(linkRows.map((item) => library.worksById.get(item.work_id)).filter(Boolean));
    const detail = { works, facets: workFacets(works), sortedByMode: new Map() };
    studioWorksCache.set(cacheKey, detail);
    return detail;
  }

  function invalidate() {
    studioHierarchyCache = null;
    studioDetailCacheStamp = null;
    studioMakerCache.clear();
    studioWorksCache.clear();
  }

  return {
    detailPayload,
    ensureCatalog,
    invalidate,
    prefixRowsForMaker,
    publicMaker,
    publicMakerSummary,
    publicSeries,
    seriesRowsForMaker,
    summaries
  };
}
