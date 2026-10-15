import assert from "node:assert/strict";
import { createCodePrefixService } from "../src/modules/fanhao/server/catalog/code-prefix-service.js";
import { createStudioService } from "../src/modules/fanhao/server/catalog/studio-service.js";
import { createWorkClassificationService } from "../src/modules/fanhao/server/works/work-classification-service.js";
import {
  codePrefixMatches,
  normalizeRequestedCodePrefix,
  workCodePrefix
} from "../src/modules/fanhao/server/works/work-code-prefix.js";

for (const [value, expected] of [
  ["IPX-735", "IPX"],
  ["FC2-PPV-3253595", "FC2-PPV"],
  ["FC2-1064996", "FC2"],
  ["300MIUM-123", "300MIUM"],
  ["[A].START-585 标题", "START"],
  ["IPX123", "IPX"]
]) {
  assert.equal(workCodePrefix(value), expected, `prefix parser should normalize ${value}`);
}
assert.equal(normalizeRequestedCodePrefix("fc2_ppv"), "FC2-PPV");
assert.equal(codePrefixMatches({ infoSummary: { code: "FC2-PPV-123" } }, "FC2", true), true);
assert.equal(codePrefixMatches({ infoSummary: { code: "IPXVR-123" } }, "IPX", false), false);

const localWorks = [
  localWork("1", "IPX-001"),
  localWork("2", "IPX-002"),
  localWork("3", "SONE-001"),
  localWork("4", "FC2-PPV-100001")
];
const makerRows = [
  { work_id: "1", maker_id: "10", maker_name: "IDEA POCKET" },
  { work_id: "2", maker_id: "10", maker_name: "IDEA POCKET" },
  { work_id: "3", maker_id: "11", maker_name: "S1 NO.1 STYLE" }
];
const missingByPrefix = {
  IPX: [
    missingWork("101", "IPX-003"),
    missingWork("102", "IPXVR-001")
  ],
  FC2: [missingWork("103", "FC2-PPV-100002")]
};

let sortCalls = 0;
let catalogStamp = "makers-v1";
let metadataStamp = "metadata-v1";
let ownerStamp = "account:alice:1";
let visibilityStamp = "visibility-v1";
let favoriteId = "1";
const hydratedPages = [];
const service = createCodePrefixService({
  clampInteger(value, fallback, min, max) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
  },
  dedupeWorksForDisplay(works) {
    return [...new Map(works.map((work) => [String(work.id), work])).values()];
  },
  defaultWorkLimit: 48,
  fastMissingCodeSearch(prefix) {
    return missingByPrefix[prefix] || [];
  },
  filterWorkList(works, filter) {
    if (filter === "favorite") return works.filter((work) => work.id === favoriteId);
    if (filter === "localOnly") return works.filter((work) => !work.missingLocal);
    if (filter === "missingLocal") return works.filter((work) => work.missingLocal);
    return works;
  },
  getCoreDb() {
    return { prepare: () => ({ all: () => makerRows }) };
  },
  getLibrary() {
    return {
      scannedAt: "test",
      worksById: new Map(localWorks.map((work) => [work.id, work]))
    };
  },
  getStamp: () => catalogStamp,
  workQueryStamp: () => metadataStamp,
  hydrateMissingSearchWorks(works) { hydratedPages.push(works.map((work) => work.id)); },
  maxWorkLimit: 1000,
  pagedWorksPayload(works, url, extra) {
    const limit = Number(url.searchParams.get("limit") || 48);
    const offset = Number(url.searchParams.get("offset") || 0);
    return {
      ...extra,
      count: works.slice(offset, offset + limit).length,
      total: works.length,
      limit,
      offset,
      sort: url.searchParams.get("sort") || "releaseDesc",
      works: works.slice(offset, offset + limit)
    };
  },
  sortWorkList(works) {
    sortCalls += 1;
    return [...works];
  },
  userStateStamp: () => ownerStamp,
  workClassificationService: {
    filterForRequest(works, url, filter) {
      const includeMissing = url.searchParams.get("includeMissingLocal") !== "0";
      if (includeMissing || filter === "missingLocal") return works;
      return works.filter((work) => !work.missingLocal);
    },
    visibilityStamp: () => visibilityStamp
  },
  workFacets(works) {
    return {
      all: works.length,
      localOnly: works.filter((work) => !work.missingLocal).length,
      missingLocal: works.filter((work) => work.missingLocal).length
    };
  }
});

const summaries = service.summaries(new URL("http://fanhao.local/api/code-prefixes?sort=count"));
const ipx = summaries.prefixes.find((item) => item.prefix === "IPX");
const fc2 = summaries.prefixes.find((item) => item.prefix === "FC2-PPV");
assert.equal(ipx.localCount, 2, "prefix counts must use local works only");
assert.equal(ipx.maker.name, "IDEA POCKET", "prefix rows must expose their dominant maker");
assert.equal(fc2.maker.name, "FC2 内容市场", "FC2 prefixes must be represented as a platform");
assert.equal(fc2.maker.kind, "platform");

const ipxWithMissing = service.detailPayload(
  "IPX",
  new URL("http://fanhao.local/api/code-prefixes/IPX?limit=48&includeMissingLocal=1")
);
assert.equal(ipxWithMissing.total, 3, "exact prefixes must include matching missing works");
assert.equal(ipxWithMissing.codePrefix.localCount, 2);
assert.equal(ipxWithMissing.codePrefix.missingCount, 1);

const ipxLocalOnly = service.detailPayload(
  "IPX",
  new URL("http://fanhao.local/api/code-prefixes/IPX?limit=48&includeMissingLocal=0")
);
assert.equal(ipxLocalOnly.total, 2, "the missing-local toggle must preserve the local prefix count");

const fc2Family = service.detailPayload(
  "FC2",
  new URL("http://fanhao.local/api/code-prefixes/FC2?family=1&limit=48&includeMissingLocal=1")
);
assert.equal(fc2Family.total, 2, "the FC2 family shortcut must include every FC2 sub-prefix");
assert.equal(fc2Family.codePrefix.maker.kind, "platform");

const prefixUrl = (query) => new URL(`http://fanhao.local/api/code-prefixes/IPX?${query}`);
const beforePages = sortCalls;
const firstPage = service.detailPayload("IPX", prefixUrl("sort=videos&limit=1&offset=0"));
const secondPage = service.detailPayload("IPX", prefixUrl("offset=1&limit=1&sort=videos"));
assert.equal(sortCalls, beforePages + 1, "pagination and query parameter order must share one sorted source");
assert.notEqual(firstPage.works[0].id, secondPage.works[0].id);
assert.deepEqual(hydratedPages.at(-1), secondPage.works.map((work) => work.id), "every page must still hydrate its visible slice");
for (const change of [
  () => { metadataStamp = "metadata-v2"; },
  () => { visibilityStamp = "visibility-v2"; },
  () => { catalogStamp = "makers-v2"; }
]) {
  const before = sortCalls;
  change();
  service.detailPayload("IPX", prefixUrl("sort=videos&limit=1&offset=0"));
  assert.equal(sortCalls, before + 1, "metadata, visibility and library changes invalidate derived ordering");
}
const alice = service.detailPayload("IPX", prefixUrl("filter=favorite"));
ownerStamp = "account:bob:1";
favoriteId = "2";
const bob = service.detailPayload("IPX", prefixUrl("filter=favorite"));
assert.deepEqual(alice.works.map((work) => work.id), ["1"]);
assert.deepEqual(bob.works.map((work) => work.id), ["2"], "equal account revisions must not share personal filtered results");
service.detailPayload("IPX", prefixUrl("sort=videos&probe=oldest"));
for (let index = 0; index < 96; index += 1) service.detailPayload("IPX", prefixUrl(`sort=videos&probe=${index}`));
const beforeEviction = sortCalls;
service.detailPayload("IPX", prefixUrl("sort=videos&probe=oldest"));
assert.equal(sortCalls, beforeEviction + 1, "derived result cache remains bounded");
service.invalidate();
const beforeInvalidation = sortCalls;
service.detailPayload("IPX", prefixUrl("sort=videos&probe=oldest"));
assert.equal(sortCalls, beforeInvalidation + 1);
verifyStudioVisibility();
verifyStudioCacheBounds();
console.log("code-prefix-catalog: ok (paging reuse, fresh metadata/visibility/library, account isolation, bounded invalidation, studio visibility and bounded sources)");

function verifyStudioCacheBounds() {
  const works = [localWork("cache-work", "IPX-001")];
  let filters = 0;
  let sorts = 0;
  let sourceQueries = 0;
  let makerQueries = 0;
  const studios = createStudioService({
    clampInteger: (value, fallback, min, max) => Math.max(min, Math.min(max, Number(value ?? fallback))),
    getCoreDb: () => ({
      prepare(sql) {
        if (sql.includes("SELECT COUNT(*) FROM makers")) return { get: () => ({ maker_count: 1, series_count: 0, link_count: 1 }) };
        if (sql.includes("FROM makers m")) return { get: (id) => { makerQueries += 1; return id === 1 ? { maker_id: "1", name: "fixture studio" } : null; } };
        if (sql.includes("FROM series s")) return { all: () => [] };
        if (sql.includes("FROM work_makers wm")) return { all: () => { sourceQueries += 1; return [{ work_id: "cache-work" }]; } };
        throw new Error(`unexpected studio cache fixture query: ${sql}`);
      }
    }),
    getLibrary: () => ({ worksById: new Map(works.map((work) => [work.id, work])) }),
    getStamp: () => "fixture-cache:1",
    filterWorkList: (items) => { filters += 1; return items; },
    pagedWorksPayload: (items) => ({ total: items.length, works: items }),
    publicRemoteUrl: (value) => value,
    sortWorkList: (items) => { sorts += 1; return [...items]; },
    workFacets: (items) => ({ all: items.length })
  });
  const detail = (query, maker = "1") => studios.detailPayload(maker, new URL(`http://fixture/api/studios/${maker}?${query}`));

  for (let index = 0; index < 110; index += 1) assert.equal(detail(`filter=query-${index}`).total, 1);
  const warmFilters = filters;
  detail("filter=query-109&offset=1");
  assert.equal(filters, warmFilters, "recent studio filter sources remain reusable across pages");
  detail("filter=query-0&offset=1");
  assert.equal(filters, warmFilters + 1, "studio filter source cache evicts and rebuilds old query combinations");

  for (let index = 0; index < 40; index += 1) assert.equal(detail(`sort=query-${index}`).total, 1);
  const warmSorts = sorts;
  detail("sort=query-39&offset=1");
  assert.equal(sorts, warmSorts, "recent studio ordering remains reusable across pages");
  detail("sort=query-0&offset=1");
  assert.equal(sorts, warmSorts, "studio unknown sorts share their updated fallback rather than allocating identical copies");
  detail("sort=size&offset=1");
  const beforeAlias = sorts;
  detail("sort=sizeDesc&offset=1");
  assert.equal(sorts, beforeAlias, "studio legacy sort aliases reuse the same ordering");
  detail("filter=info,playable&offset=1");
  const beforeEquivalent = filters;
  detail("filter=playable,info&offset=2");
  assert.equal(filters, beforeEquivalent, "equivalent studio AND filters share their array");

  for (let index = 1; index <= 140; index += 1) assert.equal(detail(`seriesId=${index}`).total, 1);
  const warmSources = sourceQueries;
  detail("seriesId=140&offset=1");
  assert.equal(sourceQueries, warmSources, "recent studio series sources are reused");
  detail("seriesId=1&offset=1");
  assert.equal(sourceQueries, warmSources + 1, "studio source cache evicts old series arrays");

  for (let index = 2; index <= 145; index += 1) assert.equal(detail("", String(index)), null);
  const warmMakers = makerQueries;
  assert.equal(detail("", "145"), null);
  assert.equal(makerQueries, warmMakers, "recent missing studio lookups are cached");
  assert.equal(detail("", "2"), null);
  assert.equal(makerQueries, warmMakers + 1, "missing studio lookup keys have the same bounded lifetime");
}

function verifyStudioVisibility() {
  const works = [localWork("local-1", "IPX-001"), missingWork("missing", "IPX-002"), missingWork("compilation", "COMP-001"), localWork("local-2", "IPX-003")];
  let prefixes = ["COMP"];
  let owner = "alice:1";
  let favorite = "local-1";
  let sorts = 0;
  const classification = createWorkClassificationService({ appConfigService: { current: () => ({ compilationPrefixes: prefixes, compilationKeywords: [] }) } });
  const studios = createStudioService({
    clampInteger: (value, fallback, min, max) => Math.max(min, Math.min(max, Number(value ?? fallback))),
    getCoreDb: () => ({
      prepare(sql) {
        if (sql.includes("SELECT COUNT(*) FROM makers")) return { get: () => ({ maker_count: 1, series_count: 0, link_count: works.length }) };
        if (sql.includes("FROM makers m")) return { get: () => ({ maker_id: "1", name: "fixture studio" }) };
        if (sql.includes("FROM series s")) return { all: () => [] };
        if (sql.includes("FROM work_makers wm")) return { all: () => works.map((work) => ({ work_id: work.id })) };
        throw new Error(`unexpected studio fixture query: ${sql}`);
      }
    }),
    getLibrary: () => ({ worksById: new Map(works.map((work) => [work.id, work])) }),
    getStamp: () => "fixture-library:1",
    filterWorkList: (items, filter) => filter === "missingLocal" ? items.filter((work) => work.missingLocal) : filter === "favorite" ? items.filter((work) => work.id === favorite) : items,
    pagedWorksPayload(items, url, extra) {
      const limit = Number(url.searchParams.get("limit") || 48);
      const offset = Number(url.searchParams.get("offset") || 0);
      return { ...extra, total: items.length, works: items.slice(offset, offset + limit), limit, offset };
    },
    publicRemoteUrl: (value) => value,
    sortWorkList: (items) => { sorts += 1; return [...items]; },
    userStateStamp: () => owner,
    workClassificationService: classification,
    workFacets: (items) => ({ all: items.length })
  });
  const detail = (query) => studios.detailPayload("1", new URL(`http://fixture/api/studios/1?${query}`));
  assert.equal(detail("includeCompilation=1&includeMissingLocal=1").total, 4);
  const first = detail("includeCompilation=0&includeMissingLocal=1&limit=1&offset=1");
  const beforeNext = sorts;
  const second = detail("includeCompilation=0&includeMissingLocal=1&limit=1&offset=2");
  assert.equal(first.total, 3);
  assert.deepEqual(first.works.map((work) => work.id), ["missing"]);
  assert.deepEqual(second.works.map((work) => work.id), ["local-2"], "studio visibility must apply before pagination so hidden compilations do not leave missing cards");
  assert.equal(sorts, beforeNext, "studio pages with the same visibility must share derived ordering");
  assert.equal(first.facets.all, 4, "studio facets retain the complete maker source");
  const onlyLocal = detail("includeCompilation=1&includeMissingLocal=0");
  assert.deepEqual(onlyLocal.works.map((work) => work.id), ["local-1", "local-2"]);
  assert.deepEqual(detail("filter=missingLocal&includeCompilation=0&includeMissingLocal=0").works.map((work) => work.id), ["missing"], "an explicit missing-local chip retains the shared visibility override semantics");
  assert.equal(detail("includeCompilation=1&includeMissingLocal=1").total, 4, "visibility toggles must not reuse a narrower page cache");
  prefixes = ["COMP", "IPX"];
  assert.equal(detail("includeCompilation=0&includeMissingLocal=1&limit=1&offset=1").total, 2, "a compilation configuration change invalidates page and sorted-result caches");
  assert.deepEqual(detail("filter=favorite").works.map((work) => work.id), ["local-1"]);
  owner = "bob:1";
  favorite = "local-2";
  assert.deepEqual(detail("filter=favorite").works.map((work) => work.id), ["local-2"]);
}

function localWork(id, code) {
  return {
    id,
    title: code,
    directoryName: code,
    infoSummary: { code },
    missingLocal: false,
    videoCount: 1,
    playableCount: 1
  };
}

function missingWork(id, code) {
  return {
    id,
    title: code,
    directoryName: code,
    infoSummary: { code },
    missingLocal: true,
    videoCount: 0,
    playableCount: 0
  };
}
