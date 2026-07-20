const DEFAULT_STUDIO_SORT = "releaseDesc";
const STUDIO_DETAIL_PREWARM_PAGE_SIZE = 48;
const STUDIO_DETAIL_PREWARM_LIMIT = 12;
const STUDIO_PAGE_CACHE_LIMIT = 256;
const STUDIO_SUMMARY_CACHE_LIMIT = 32;

export function createStudioService({
  clampInteger,
  filterWorkList = (works) => works,
  getCoreDb,
  getLibrary,
  getStamp,
  pagedWorksPayload,
  prewarmCoreWorkCovers = () => {},
  prewarmWorkInfoDetails = () => {},
  publicRemoteUrl,
  sortWorkList,
  userStateStamp = () => "",
  workFacets,
  workQueryStamp = () => ""
}) {
  let studioHierarchyCache = null;
  let studioDetailCacheStamp = null;
  let studioPageCacheStamp = null;
  let studioSummaryPayloadCacheStamp = null;
  let studioSummaryRowsCache = null;
  const studioMakerCache = new Map();
  const studioPageCache = new Map();
  const studioSummaryPayloadCache = new Map();
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
    ensureSummaryPayloadCache(sync.stamp);
    const cacheKey = `${q}:${limit}`;
    const cached = readLru(studioSummaryPayloadCache, cacheKey);
    if (cached) return cached;
    const rows = q ? querySummaryRows(q, limit) : cachedSummaryRows(sync.stamp).slice(0, limit);
    const makers = rows.map(publicMakerSummary);
    const payload = { sync, count: makers.length, makers };
    writeLru(studioSummaryPayloadCache, cacheKey, payload, STUDIO_SUMMARY_CACHE_LIMIT);
    return payload;
  }

  function ensureSummaryPayloadCache(stamp) {
    if (studioSummaryPayloadCacheStamp === stamp) return;
    studioSummaryPayloadCacheStamp = stamp;
    studioSummaryPayloadCache.clear();
  }

  function cachedSummaryRows(stamp) {
    if (studioSummaryRowsCache?.stamp === stamp) return studioSummaryRowsCache.rows;
    const rows = querySummaryRows("", 1000);
    studioSummaryRowsCache = { stamp, rows };
    return rows;
  }

  function querySummaryRows(q, limit) {
    return getCoreDb()
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
  }

  function prewarm() {
    const sync = ensureCatalog();
    const rows = cachedSummaryRows(sync.stamp);
    summaries(new URL("http://fanhao.local/api/studios?limit=500"));
    prewarmDetails(rows);
  }

  function prewarmDetails(rows) {
    const db = getCoreDb();
    const pageWorks = [];
    const pageWorkIds = new Set();
    for (const row of rows) {
      const makerId = String(row.maker_id || "");
      if (!makerId) continue;
      cachedMakerDetail(makerId, db);
      const workSet = cachedStudioWorks(makerId, "all", db);
      if (!workSet.sortedByMode.has(DEFAULT_STUDIO_SORT)) {
        workSet.sortedByMode.set(DEFAULT_STUDIO_SORT, sortWorkList(workSet.works, DEFAULT_STUDIO_SORT));
      }
      for (const work of workSet.sortedByMode.get(DEFAULT_STUDIO_SORT).slice(0, STUDIO_DETAIL_PREWARM_PAGE_SIZE)) {
        if (!work?.id || pageWorkIds.has(work.id)) continue;
        pageWorkIds.add(work.id);
        pageWorks.push(work);
      }
    }
    prewarmCoreWorkCovers(pageWorks);
    prewarmWorkInfoDetails(pageWorks);
    for (const row of rows.slice(0, STUDIO_DETAIL_PREWARM_LIMIT)) {
      const makerId = String(row.maker_id || "");
      if (!makerId) continue;
      for (const limit of [32, STUDIO_DETAIL_PREWARM_PAGE_SIZE]) {
        detailPayload(makerId, new URL(`http://fanhao.local/api/studios/${makerId}?seriesId=all&sort=${DEFAULT_STUDIO_SORT}&limit=${limit}&offset=0`));
      }
    }
  }

  function detailPayload(makerId, url) {
    const sync = ensureCatalog();
    ensurePageCache(sync.stamp);
    const db = getCoreDb();
    const requestedSeriesId = String(url.searchParams.get("seriesId") || "all").trim() || "all";
    const selectedSeriesId = requestedSeriesId === "all" || /^\d+$/.test(requestedSeriesId) ? requestedSeriesId : "all";
    const maker = cachedMakerDetail(makerId, db);
    if (!maker) return null;
    const workSet = cachedStudioWorks(makerId, selectedSeriesId, db);
    const filter = String(url.searchParams.get("filter") || "all").trim() || "all";
    const sort = url.searchParams.get("sort") || DEFAULT_STUDIO_SORT;
    const pageCacheKey = detailPageCacheKey(makerId, selectedSeriesId, filter, sort, url);
    const cachedPage = readLru(studioPageCache, pageCacheKey);
    if (cachedPage) return cachedPage;
    const filteredWorkSet = cachedFilteredStudioWorks(workSet, filter);
    let sorted = filteredWorkSet.sortedByMode.get(sort);
    if (!sorted) {
      sorted = sortWorkList(filteredWorkSet.works, sort);
      filteredWorkSet.sortedByMode.set(sort, sorted);
    }
    const payload = {
      sync,
      studio: maker.studio,
      selectedSeriesId,
      ...pagedWorksPayload(sorted, url, { filter, facets: cachedStudioFacets(workSet) })
    };
    writeLru(studioPageCache, pageCacheKey, payload, STUDIO_PAGE_CACHE_LIMIT);
    return payload;
  }

  function ensurePageCache(stamp) {
    const nextStamp = `${stamp}:${workQueryStamp()}:${userStateStamp()}`;
    if (studioPageCacheStamp === nextStamp) return;
    studioPageCacheStamp = nextStamp;
    studioPageCache.clear();
  }

  function detailPageCacheKey(makerId, selectedSeriesId, filter, sort, url) {
    return [
      String(makerId || ""),
      selectedSeriesId,
      filter,
      sort,
      url.searchParams.get("limit") || "",
      url.searchParams.get("offset") || "0"
    ].join(":");
  }

  function cachedStudioFacets(workSet) {
    const stamp = `${workQueryStamp()}:${userStateStamp()}`;
    if (workSet.facetsCache?.stamp === stamp) return workSet.facetsCache.facets;
    const facets = workFacets(workSet.works);
    workSet.facetsCache = { stamp, facets };
    return facets;
  }

  function cachedFilteredStudioWorks(workSet, filter) {
    const stamp = `${workQueryStamp()}:${userStateStamp()}`;
    if (workSet.queryCacheStamp !== stamp) {
      workSet.queryCacheStamp = stamp;
      workSet.filteredByMode.clear();
      workSet.sortedByMode.clear();
    }
    if (filter === "all") return workSet;
    if (!workSet.filteredByMode.has(filter)) {
      workSet.filteredByMode.set(filter, {
        works: filterWorkList(workSet.works, filter),
        sortedByMode: new Map()
      });
    }
    return workSet.filteredByMode.get(filter);
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
    const works = linkRows.map((item) => library.worksById.get(item.work_id)).filter(Boolean);
    const detail = {
      works,
      facetsCache: null,
      queryCacheStamp: `${workQueryStamp()}:${userStateStamp()}`,
      filteredByMode: new Map(),
      sortedByMode: new Map()
    };
    studioWorksCache.set(cacheKey, detail);
    return detail;
  }

  function readLru(cache, key) {
    if (!cache.has(key)) return null;
    const value = cache.get(key);
    cache.delete(key);
    cache.set(key, value);
    return value;
  }

  function writeLru(cache, key, value, limit) {
    cache.set(key, value);
    while (cache.size > limit) cache.delete(cache.keys().next().value);
  }

  function invalidate() {
    studioHierarchyCache = null;
    studioDetailCacheStamp = null;
    studioPageCacheStamp = null;
    studioSummaryPayloadCacheStamp = null;
    studioSummaryRowsCache = null;
    studioMakerCache.clear();
    studioPageCache.clear();
    studioSummaryPayloadCache.clear();
    studioWorksCache.clear();
  }

  return {
    detailPayload,
    ensureCatalog,
    invalidate,
    prewarm,
    prefixRowsForMaker,
    publicMaker,
    publicMakerSummary,
    publicSeries,
    seriesRowsForMaker,
    summaries
  };
}
