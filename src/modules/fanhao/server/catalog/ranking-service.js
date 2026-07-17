const RANKING_COVER_BATCH_SIZE = 200;
const DEFAULT_RANKING_KEY = "y2025";
const RANKING_PREWARM_PAGE_SIZE = 64;
const RANKING_PAGE_CACHE_LIMIT = 64;

export function createRankingService({
  clampInteger,
  createId,
  dbBoolOrNull,
  getCoreDb,
  getSearchStamp,
  localWorkByCodeKey,
  localWorkCodeKeys,
  looseWorkCodeKey,
  maxWorkLimit,
  normalizeWorkCode,
  parseJsonTextArray,
  prewarmCoreWorkCovers,
  prewarmWorkInfoDetails,
  prewarmRemoteImagesForWorks,
  proxiedRemoteImageUrl,
  publicWork,
  storedWorkCodeKey,
  userStateStamp = () => ""
}) {
  let rankingMissingSearchCache = null;
  let rankingRowsCache = new Map();
  let rankingSummariesCache = null;
  let rankingWorkSourcesCache = new Map();
  let rankingPageCache = new Map();
  let rankingPageCacheStamp = "";

  function listLabel(listType, listKey, fallback = "") {
    const key = String(listKey || "");
    if (fallback) return fallback;
    if (listType === "top") {
      if (!key || key === "all") return "TOP250 全部";
      if (key === "censored") return "TOP250 有码";
      if (key === "uncensored") return "TOP250 无码";
      if (key === "western") return "TOP250 欧美";
      if (key === "fc2") return "TOP250 FC2";
      const year = /^y?(\d{4})$/i.exec(key)?.[1];
      if (year) return `TOP250 ${year}`;
    }
    return key ? `${listType} ${key}` : listType;
  }

  function sourceParts(sourceKey = "") {
    const [listType = "top", ...rest] = String(sourceKey || "top:").split(":");
    return { listType: listType || "top", listKey: rest.join(":") || "" };
  }

  function summaries() {
    const stamp = getSearchStamp();
    if (rankingSummariesCache?.stamp === stamp) return rankingSummariesCache.items;
    const localKeys = localWorkCodeKeys();
    const result = [];
    let succeeded = true;
    try {
      const rows = getCoreDb()
        .prepare(
          `
          SELECT
            c.id AS collection_id,
            c.name AS list_label,
            c.source_key,
            COUNT(ci.work_id) AS total,
            MAX(ci.updated_at) AS updated_at,
            MAX(c.source_url) AS page_url
          FROM collections c
          JOIN collection_items ci ON ci.collection_id = c.id
          WHERE c.type = 'ranking'
          GROUP BY c.id
          ORDER BY
            CASE WHEN c.source_key GLOB 'top:y[0-9][0-9][0-9][0-9]' THEN 0 ELSE 1 END,
            c.source_key DESC
          `
        )
        .all();

      for (const row of rows) {
        const { listType, listKey } = sourceParts(row.source_key);
        const listRows = getCoreDb()
          .prepare(
            `
            SELECT w.code_search AS code_key
            FROM collection_items ci
            JOIN works w ON w.id = ci.work_id
            WHERE ci.collection_id = ?
            `
          )
          .all(row.collection_id);
        const localTotal = listRows.filter((item) => localKeys.has(storedWorkCodeKey(item.code_key))).length;
        result.push({
          type: listType,
          key: listKey,
          label: listLabel(listType, listKey, row.list_label),
          total: Number(row.total || 0),
          localTotal,
          missingTotal: Math.max(0, Number(row.total || 0) - localTotal),
          updatedAt: row.updated_at || "",
          pageUrl: row.page_url || ""
        });
      }
    } catch (error) {
      succeeded = false;
      console.warn("[rankings]", error.message);
    }
    if (succeeded) rankingSummariesCache = { stamp, items: result };
    return result;
  }

  function rows(listType = "top", listKey = "") {
    const normalizedListKey = listKey || "";
    const stamp = getSearchStamp();
    const cacheKey = `${listType}:${normalizedListKey}`;
    const cached = rankingRowsCache.get(cacheKey);
    if (cached?.stamp === stamp) return cached.rows;

    try {
      const rankingRows = getCoreDb()
        .prepare(
          `
          SELECT
            ? AS list_type,
            ? AS list_key,
            c.name AS list_label,
            ci.rank_no,
            w.id AS core_work_id,
            w.code,
            w.code_search AS code_key,
            COALESCE(ci.title_snapshot, w.title) AS title,
            wref.url AS detail_url,
            w.release_date,
            COALESCE(ci.rating_snapshot, w.rating) AS rating,
            COALESCE(ci.rating_count_snapshot, w.rating_count) AS rating_count,
            c.source_url AS page_url,
            ci.fetched_at,
            ci.updated_at
          FROM collections c
          JOIN collection_items ci ON ci.collection_id = c.id
          JOIN works w ON w.id = ci.work_id
          LEFT JOIN work_external_refs wref ON wref.work_id = w.id AND wref.provider = 'javdb-video'
          WHERE c.type = 'ranking'
            AND c.source_key = ?
          ORDER BY ci.rank_no ASC, w.code ASC
          `
        )
        .all(listType, normalizedListKey, `${listType}:${normalizedListKey}`);
      hydrateRankingCoverUrls(rankingRows);
      rankingRowsCache.delete(cacheKey);
      rankingRowsCache.set(cacheKey, { stamp, rows: rankingRows });
      while (rankingRowsCache.size > 32) rankingRowsCache.delete(rankingRowsCache.keys().next().value);
      return rankingRows;
    } catch (error) {
      console.warn("[rankings]", error.message);
      return [];
    }
  }

  function hydrateRankingCoverUrls(rankingRows = []) {
    const workIds = [...new Set((rankingRows || [])
      .map((row) => Number(row?.core_work_id))
      .filter((workId) => Number.isSafeInteger(workId) && workId > 0))];
    const coverUrlByWorkId = new Map();

    for (let offset = 0; offset < workIds.length; offset += RANKING_COVER_BATCH_SIZE) {
      const batch = workIds.slice(offset, offset + RANKING_COVER_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(", ");
      try {
        const coverRows = getCoreDb()
          .prepare(
            `
            SELECT CAST(owner_id AS TEXT) AS work_id, remote_url
            FROM images
            WHERE owner_type = 'work'
              AND owner_id IN (${placeholders})
              AND kind = 'cover'
            ORDER BY owner_id ASC, CASE WHEN source = 'javdb_rankings' THEN 0 ELSE 1 END, id ASC
            `
          )
          .all(...batch);
        for (const coverRow of coverRows) {
          if (!coverUrlByWorkId.has(coverRow.work_id)) {
            coverUrlByWorkId.set(coverRow.work_id, coverRow.remote_url || "");
          }
        }
      } catch (error) {
        console.warn("[rankings-cover]", error.message);
      }
    }

    for (const row of rankingRows || []) {
      row.image_url = coverUrlByWorkId.get(String(row.core_work_id || "")) || "";
    }
    return rankingRows;
  }

  function workFromRow(row, localByCode = localWorkByCodeKey()) {
    const codeKey = storedWorkCodeKey(row.code_key) || looseWorkCodeKey(row.code);
    const localWork = codeKey ? localByCode.get(codeKey) : null;
    const ranking = {
      type: row.list_type || "top",
      key: row.list_key || "",
      label: listLabel(row.list_type || "top", row.list_key || "", row.list_label || ""),
      rankNo: Number(row.rank_no || 0),
      pageUrl: row.page_url || "",
      updatedAt: row.updated_at || ""
    };

    if (localWork) {
      return { ...localWork, ranking, missingLocal: false };
    }

    const code = normalizeWorkCode(row.code) || row.code || "";
    const title = row.title && row.title !== row.code ? row.title : code || row.title || "未下载作品";
    return {
      id: createId("r", `${row.list_type || "top"}|${row.list_key || ""}|${codeKey || row.code || row.rank_no}`),
      personId: "",
      personName: "",
      title,
      directoryName: code,
      relativePath: "",
      coverId: null,
      remoteCoverUrl: proxiedRemoteImageUrl(row.image_url),
      videoCount: 0,
      playableCount: 0,
      imageCount: 0,
      infoCount: 0,
      videos: [],
      images: [],
      infos: [],
      modifiedAt: "",
      missingLocal: true,
      javdbUrl: row.detail_url || "",
      actorUrl: "",
      ranking,
      infoSummary: {
        code,
        title: row.title || "",
        releaseDate: row.release_date || "",
        durationMinutes: null,
        rating: row.rating ?? null,
        ratingCount: row.rating_count ?? null,
        hasMagnet: dbBoolOrNull(row.has_magnet),
        isStreamable: dbBoolOrNull(row.is_streamable),
        hasSubtitles: dbBoolOrNull(row.has_subtitles),
        javdbTags: parseJsonTextArray(row.javdb_tags_json)
      }
    };
  }

  function preparedWorkSource(listType = "top", listKey = "") {
    const normalizedListKey = listKey || "";
    const stamp = getSearchStamp();
    const cacheKey = `${listType}:${normalizedListKey}`;
    const cached = rankingWorkSourcesCache.get(cacheKey);
    if (cached?.stamp === stamp) return cached.source;

    const rankingRows = rows(listType, normalizedListKey);
    const localByCode = localWorkByCodeKey();
    const allWorks = rankingRows.map((row) => workFromRow(row, localByCode));
    const localWorks = allWorks.filter((work) => !work.missingLocal);
    const missingWorks = allWorks.filter((work) => work.missingLocal);
    const source = {
      allWorks,
      localTotal: localWorks.length,
      missingTotal: missingWorks.length,
      missingWorks,
      rankingRows
    };
    rankingWorkSourcesCache.delete(cacheKey);
    rankingWorkSourcesCache.set(cacheKey, { stamp, source });
    while (rankingWorkSourcesCache.size > 32) rankingWorkSourcesCache.delete(rankingWorkSourcesCache.keys().next().value);
    return source;
  }

  function worksPayload(url, listType = "top") {
    const listKey = url.searchParams.get("key") || "";
    const onlyMissing = ["1", "true", "yes"].includes(String(url.searchParams.get("missing") || "").toLowerCase());
    const limit = clampInteger(url.searchParams.get("limit"), maxWorkLimit, 1, maxWorkLimit);
    const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const pageCacheKey = `${listType}:${listKey}:${onlyMissing ? "missing" : "all"}:${limit}:${offset}`;
    const cachedPage = readCachedPage(pageCacheKey);
    if (cachedPage) return cachedPage;

    const source = preparedWorkSource(listType, listKey);
    const { allWorks, localTotal, missingTotal, rankingRows } = source;
    const sourceWorks = onlyMissing ? source.missingWorks : allWorks;
    const pageSource = sourceWorks.slice(offset, offset + limit);
    prewarmCoreWorkCovers(pageSource);
    prewarmWorkInfoDetails(pageSource);
    const sourceById = new Map(pageSource.map((work) => [work.id, work]));
    const page = pageSource.map((work) => publicWork(work));
    prewarmRemoteImagesForWorks(page);
    for (const work of page) {
      const source = sourceById.get(work.id);
      if (source?.ranking) work.ranking = source.ranking;
    }
    const payload = {
      type: listType,
      key: listKey,
      label: listLabel(listType, listKey, rankingRows[0]?.list_label || ""),
      count: page.length,
      total: sourceWorks.length,
      rankingTotal: allWorks.length,
      localTotal,
      missingTotal,
      limit,
      offset,
      updatedAt: rankingRows[0]?.updated_at || "",
      pageUrl: rankingRows[0]?.page_url || "",
      works: page
    };
    cachePage(pageCacheKey, payload);
    return payload;
  }

  function readCachedPage(cacheKey) {
    ensurePageCache();
    if (!rankingPageCache.has(cacheKey)) return null;
    const cached = rankingPageCache.get(cacheKey);
    rankingPageCache.delete(cacheKey);
    rankingPageCache.set(cacheKey, cached);
    return cached;
  }

  function cachePage(cacheKey, payload) {
    ensurePageCache();
    rankingPageCache.set(cacheKey, payload);
    while (rankingPageCache.size > RANKING_PAGE_CACHE_LIMIT) {
      rankingPageCache.delete(rankingPageCache.keys().next().value);
    }
  }

  function ensurePageCache() {
    const stamp = `${getSearchStamp()}:${userStateStamp()}`;
    if (rankingPageCacheStamp === stamp) return;
    rankingPageCacheStamp = stamp;
    rankingPageCache.clear();
  }

  function prewarm() {
    const lists = summaries();
    const topLists = lists.filter((item) => item.type === "top");
    const preferred = topLists.find((item) => item.key === DEFAULT_RANKING_KEY) || topLists[0];
    if (!preferred) return;
    const orderedLists = [preferred, ...topLists.filter((item) => item !== preferred)];
    const pageWorks = [];
    const seenWorkIds = new Set();
    for (const list of orderedLists) {
      const source = preparedWorkSource(list.type, list.key);
      for (const work of source.allWorks.slice(0, RANKING_PREWARM_PAGE_SIZE)) {
        if (!work?.id || seenWorkIds.has(work.id)) continue;
        seenWorkIds.add(work.id);
        pageWorks.push(work);
      }
    }
    prewarmCoreWorkCovers(pageWorks);
    prewarmWorkInfoDetails(pageWorks);
  }

  function missingSearchWorks() {
    const stamp = getSearchStamp();
    if (rankingMissingSearchCache?.stamp === stamp) return rankingMissingSearchCache.works;

    const localByCode = localWorkByCodeKey();
    const seen = new Set();
    const works = [];
    const missingRows = [];

    try {
      const rankingRows = getCoreDb()
        .prepare(
          `
          SELECT
            substr(c.source_key, 1, instr(c.source_key || ':', ':') - 1) AS list_type,
            substr(c.source_key, instr(c.source_key || ':', ':') + 1) AS list_key,
            c.name AS list_label,
            ci.rank_no,
            w.id AS core_work_id,
            w.code,
            w.code_search AS code_key,
            COALESCE(ci.title_snapshot, w.title) AS title,
            wref.url AS detail_url,
            w.release_date,
            COALESCE(ci.rating_snapshot, w.rating) AS rating,
            COALESCE(ci.rating_count_snapshot, w.rating_count) AS rating_count,
            c.source_url AS page_url,
            ci.fetched_at,
            ci.updated_at
          FROM collections c
          JOIN collection_items ci ON ci.collection_id = c.id
          JOIN works w ON w.id = ci.work_id
          LEFT JOIN work_external_refs wref ON wref.work_id = w.id AND wref.provider = 'javdb-video'
          WHERE c.type = 'ranking'
          ORDER BY ci.rank_no ASC, ci.updated_at DESC, c.source_key DESC, w.code ASC
          `
        )
        .all();

      for (const row of rankingRows) {
        const codeKey = storedWorkCodeKey(row.code_key) || looseWorkCodeKey(row.code);
        if (!codeKey || seen.has(codeKey) || localByCode.has(codeKey)) continue;
        seen.add(codeKey);
        missingRows.push(row);
      }
      hydrateRankingCoverUrls(missingRows);
      for (const row of missingRows) works.push(workFromRow(row, localByCode));
    } catch (error) {
      console.warn("[rankings-search]", error.message);
    }

    rankingMissingSearchCache = { stamp, works };
    return works;
  }

  function invalidateSearch() {
    rankingMissingSearchCache = null;
    rankingRowsCache = new Map();
    rankingSummariesCache = null;
    rankingWorkSourcesCache = new Map();
    rankingPageCache = new Map();
    rankingPageCacheStamp = "";
  }

  return {
    invalidateSearch,
    listLabel,
    missingSearchWorks,
    prewarm,
    rows,
    sourceParts,
    summaries,
    workFromRow,
    worksPayload
  };
}
