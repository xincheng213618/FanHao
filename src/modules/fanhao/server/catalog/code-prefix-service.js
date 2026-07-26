import {
  codePrefixMatches,
  normalizeRequestedCodePrefix,
  workCodePrefixForWork
} from "../works/work-code-prefix.js";

const DETAIL_SOURCE_CACHE_LIMIT = 96;
const FC2_PLATFORM = Object.freeze({
  id: "fc2-content-market",
  name: "FC2 内容市场",
  kind: "platform",
  localCount: 0
});

export function createCodePrefixService({
  clampInteger,
  dedupeWorksForDisplay,
  defaultWorkLimit,
  fastMissingCodeSearch,
  filterWorkList,
  getCoreDb,
  getLibrary,
  getStamp,
  hydrateMissingSearchWorks = () => {},
  maxWorkLimit,
  pagedWorksPayload,
  sortWorkList,
  userStateStamp = () => "",
  workClassificationService,
  workFacets
}) {
  let catalogCache = null;
  let detailSourceStamp = "";
  const detailSourceCache = new Map();
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

  function sourceStamp() {
    const library = getLibrary();
    return `${library?.scannedAt || ""}:${getStamp()}`;
  }

  function responseStamp() {
    return `${sourceStamp()}:${workClassificationService.visibilityStamp()}:${userStateStamp()}`;
  }

  function ensureCatalog() {
    const stamp = sourceStamp();
    if (catalogCache?.stamp === stamp) return catalogCache;

    const groups = new Map();
    for (const work of getLibrary()?.worksById?.values?.() || []) {
      const prefix = workCodePrefixForWork(work);
      if (!prefix) continue;
      const group = groups.get(prefix) || { prefix, works: [] };
      group.works.push(work);
      groups.set(prefix, group);
    }

    const makersByWork = localMakerRowsByWork();
    const items = [...groups.values()].map((group) => publicPrefixSummary(group, makersByWork));
    items.sort(compareByCount);
    catalogCache = {
      stamp,
      groups,
      items,
      localWorkCount: items.reduce((sum, item) => sum + item.localCount, 0),
      mappedCount: items.filter((item) => Boolean(item.maker)).length
    };
    detailSourceCache.clear();
    detailSourceStamp = stamp;
    return catalogCache;
  }

  function summaries(url) {
    const catalog = ensureCatalog();
    const q = String(url?.searchParams?.get("q") || "").trim().toUpperCase();
    const sort = url?.searchParams?.get("sort") === "name" ? "name" : "count";
    const filtered = q
      ? catalog.items.filter((item) =>
          item.prefix.includes(q)
          || item.maker?.name?.toUpperCase().includes(q)
          || item.makers.some((maker) => maker.name.toUpperCase().includes(q)))
      : catalog.items;
    const prefixes = [...filtered].sort(sort === "name" ? compareByName : compareByCount);
    return {
      count: prefixes.length,
      localWorkCount: prefixes.reduce((sum, item) => sum + item.localCount, 0),
      mappedCount: prefixes.filter((item) => Boolean(item.maker)).length,
      sort,
      prefixes
    };
  }

  function detailPayload(rawPrefix, url) {
    const prefix = normalizeRequestedCodePrefix(rawPrefix);
    if (!prefix) return null;
    const family = url.searchParams.get("family") === "1";
    const source = detailSource(prefix, family);
    if (!source) return null;

    const filter = String(url.searchParams.get("filter") || "all").trim() || "all";
    const visible = workClassificationService.filterForRequest(source.works, url, filter);
    const filtered = filterWorkList(visible, filter);
    const sort = url.searchParams.get("sort") || "releaseDesc";
    const sorted = sortWorkList(filtered, sort);
    const limit = clampInteger(url.searchParams.get("limit"), defaultWorkLimit, 1, maxWorkLimit);
    const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    hydrateMissingSearchWorks(sorted.slice(offset, offset + limit));

    return {
      codePrefix: source.codePrefix,
      responseStamp: responseStamp(),
      ...pagedWorksPayload(sorted, url, {
        filter,
        facets: workFacets(source.works)
      })
    };
  }

  function detailSource(prefix, family) {
    const stamp = sourceStamp();
    if (detailSourceStamp !== stamp) {
      detailSourceStamp = stamp;
      detailSourceCache.clear();
    }
    const cacheKey = `${family ? "family" : "prefix"}:${prefix}`;
    if (detailSourceCache.has(cacheKey)) return touchDetailSource(cacheKey);

    const catalog = ensureCatalog();
    const localGroups = family
      ? [...catalog.groups.values()].filter((group) => prefixMatchesFamily(group.prefix, prefix))
      : [catalog.groups.get(prefix)].filter(Boolean);
    const localWorks = localGroups.flatMap((group) => group.works);
    const missingWorks = (fastMissingCodeSearch(prefix) || [])
      .filter((work) => codePrefixMatches(work, prefix, family));
    const works = dedupeWorksForDisplay([...localWorks, ...missingWorks]);
    if (!works.length && !localWorks.length) return null;

    const exactSummary = family ? null : catalog.items.find((item) => item.prefix === prefix);
    const codePrefix = family
      ? familySummary(prefix, localGroups, missingWorks)
      : {
          ...(exactSummary || { prefix, localCount: localWorks.length, maker: null, makers: [] }),
          family: false,
          missingCount: missingWorks.length,
          knownCount: works.length
        };
    const source = { codePrefix, works };
    detailSourceCache.set(cacheKey, source);
    while (detailSourceCache.size > DETAIL_SOURCE_CACHE_LIMIT) {
      detailSourceCache.delete(detailSourceCache.keys().next().value);
    }
    return source;
  }

  function familySummary(prefix, localGroups, missingWorks) {
    const localCount = localGroups.reduce((sum, group) => sum + group.works.length, 0);
    const platform = prefix === "FC2"
      ? { ...FC2_PLATFORM, localCount }
      : null;
    return {
      prefix,
      family: true,
      localCount,
      maker: platform,
      makers: platform ? [platform] : [],
      missingCount: missingWorks.length,
      knownCount: localCount + missingWorks.length
    };
  }

  function publicPrefixSummary(group, makersByWork) {
    const makerCounts = new Map();
    for (const work of group.works) {
      const seen = new Set();
      for (const maker of makersByWork.get(String(work.id)) || []) {
        if (!maker.id || seen.has(maker.id)) continue;
        seen.add(maker.id);
        const current = makerCounts.get(maker.id) || { ...maker, localCount: 0 };
        current.localCount += 1;
        makerCounts.set(maker.id, current);
      }
    }
    const makers = [...makerCounts.values()]
      .sort((a, b) => b.localCount - a.localCount || collator.compare(a.name, b.name));
    const platform = group.prefix.startsWith("FC2")
      ? { ...FC2_PLATFORM, localCount: group.works.length }
      : null;
    return {
      prefix: group.prefix,
      localCount: group.works.length,
      maker: platform || makers[0] || null,
      makers: platform ? [platform, ...makers] : makers
    };
  }

  function localMakerRowsByWork() {
    const rows = new Map();
    try {
      const makerRows = getCoreDb().prepare(`
        SELECT DISTINCT
          CAST(w.id AS TEXT) AS work_id,
          CAST(m.id AS TEXT) AS maker_id,
          m.name AS maker_name
        FROM works w
        JOIN local_works lw ON lw.work_id = w.id
        JOIN work_makers wm ON wm.work_id = w.id AND wm.role = 'maker'
        JOIN makers m ON m.id = wm.maker_id
        WHERE w.status = 'ok'
          AND TRIM(COALESCE(m.name, '')) <> ''
      `).all();
      for (const row of makerRows) {
        const workId = String(row.work_id || "");
        if (!workId) continue;
        const makers = rows.get(workId) || [];
        makers.push({
          id: String(row.maker_id || ""),
          name: String(row.maker_name || ""),
          kind: "maker"
        });
        rows.set(workId, makers);
      }
    } catch (error) {
      console.warn("[fanhao-code-prefix-makers]", error.message);
    }
    return rows;
  }

  function touchDetailSource(key) {
    const source = detailSourceCache.get(key);
    detailSourceCache.delete(key);
    detailSourceCache.set(key, source);
    return source;
  }

  function compareByCount(a, b) {
    return b.localCount - a.localCount || collator.compare(a.prefix, b.prefix);
  }

  function compareByName(a, b) {
    return collator.compare(a.prefix, b.prefix) || b.localCount - a.localCount;
  }

  function prefixMatchesFamily(candidate, family) {
    return candidate === family || candidate.startsWith(`${family}-`);
  }

  function prewarm() {
    ensureCatalog();
  }

  function invalidate() {
    catalogCache = null;
    detailSourceStamp = "";
    detailSourceCache.clear();
  }

  return {
    detailPayload,
    invalidate,
    prewarm,
    summaries
  };
}
