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
  prewarmWorkInfoDetails,
  prewarmRemoteImagesForWorks,
  proxiedRemoteImageUrl,
  publicWork,
  storedWorkCodeKey
}) {
  let rankingMissingSearchCache = null;

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
    const localKeys = localWorkCodeKeys();
    const result = [];
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
      console.warn("[rankings]", error.message);
    }
    return result;
  }

  function rows(listType = "top", listKey = "") {
    try {
      return getCoreDb()
        .prepare(
          `
          SELECT
            ? AS list_type,
            ? AS list_key,
            c.name AS list_label,
            ci.rank_no,
            w.code,
            w.code_search AS code_key,
            COALESCE(ci.title_snapshot, w.title) AS title,
            wref.url AS detail_url,
            cover.remote_url AS image_url,
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
          LEFT JOIN images cover
            ON cover.id = (
              SELECT i.id
              FROM images i
              WHERE i.owner_type = 'work'
                AND i.owner_id = w.id
                AND i.kind = 'cover'
              ORDER BY CASE WHEN i.source = 'javdb_rankings' THEN 0 ELSE 1 END, i.id ASC
              LIMIT 1
            )
          WHERE c.type = 'ranking'
            AND c.source_key = ?
          ORDER BY ci.rank_no ASC, w.code ASC
          `
        )
        .all(listType, listKey || "", `${listType}:${listKey || ""}`);
    } catch (error) {
      console.warn("[rankings]", error.message);
      return [];
    }
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

  function worksPayload(url, listType = "top") {
    const listKey = url.searchParams.get("key") || "";
    const rankingRows = rows(listType, listKey);
    const localByCode = localWorkByCodeKey();
    const allWorks = rankingRows.map((row) => workFromRow(row, localByCode));
    const localTotal = allWorks.filter((work) => !work.missingLocal).length;
    const missingTotal = allWorks.length - localTotal;
    const onlyMissing = ["1", "true", "yes"].includes(String(url.searchParams.get("missing") || "").toLowerCase());
    const sourceWorks = onlyMissing ? allWorks.filter((work) => work.missingLocal) : allWorks;
    const limit = clampInteger(url.searchParams.get("limit"), maxWorkLimit, 1, maxWorkLimit);
    const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const pageSource = sourceWorks.slice(offset, offset + limit);
    prewarmWorkInfoDetails(pageSource);
    const sourceById = new Map(pageSource.map((work) => [work.id, work]));
    const page = pageSource.map((work) => publicWork(work));
    prewarmRemoteImagesForWorks(page);
    for (const work of page) {
      const source = sourceById.get(work.id);
      if (source?.ranking) work.ranking = source.ranking;
    }
    return {
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
  }

  function missingSearchWorks() {
    const stamp = getSearchStamp();
    if (rankingMissingSearchCache?.stamp === stamp) return rankingMissingSearchCache.works;

    const localByCode = localWorkByCodeKey();
    const seen = new Set();
    const works = [];

    try {
      const rankingRows = getCoreDb()
        .prepare(
          `
          SELECT
            substr(c.source_key, 1, instr(c.source_key || ':', ':') - 1) AS list_type,
            substr(c.source_key, instr(c.source_key || ':', ':') + 1) AS list_key,
            c.name AS list_label,
            ci.rank_no,
            w.code,
            w.code_search AS code_key,
            COALESCE(ci.title_snapshot, w.title) AS title,
            wref.url AS detail_url,
            cover.remote_url AS image_url,
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
          LEFT JOIN images cover
            ON cover.id = (
              SELECT i.id
              FROM images i
              WHERE i.owner_type = 'work'
                AND i.owner_id = w.id
                AND i.kind = 'cover'
              ORDER BY CASE WHEN i.source = 'javdb_rankings' THEN 0 ELSE 1 END, i.id ASC
              LIMIT 1
            )
          WHERE c.type = 'ranking'
          ORDER BY ci.rank_no ASC, ci.updated_at DESC, c.source_key DESC, w.code ASC
          `
        )
        .all();

      for (const row of rankingRows) {
        const codeKey = storedWorkCodeKey(row.code_key) || looseWorkCodeKey(row.code);
        if (!codeKey || seen.has(codeKey) || localByCode.has(codeKey)) continue;
        seen.add(codeKey);
        works.push(workFromRow(row, localByCode));
      }
    } catch (error) {
      console.warn("[rankings-search]", error.message);
    }

    rankingMissingSearchCache = { stamp, works };
    return works;
  }

  function invalidateSearch() {
    rankingMissingSearchCache = null;
  }

  return {
    invalidateSearch,
    listLabel,
    missingSearchWorks,
    rows,
    sourceParts,
    summaries,
    workFromRow,
    worksPayload
  };
}
