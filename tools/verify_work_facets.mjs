import assert from "node:assert/strict";
import { createWorkQueryService } from "../src/modules/fanhao/server/works/work-query-service.js";

const works = [undefined, null, "", "invalid", 0, "0", 4.5, "4.5"].map((rating, index) => ({
  id: `fixture-${index}`, infoSummary: { rating }
}));
const query = createWorkQueryService({
  favoriteStateService: { isFavoriteWork: () => false },
  playbackProgressService: { getWorkProgress: () => null },
  isVrWork: () => false, workHasCoreCover: () => false,
  workInfoFacetRow: () => null, userStateStamp: () => "fixture",
  actorMovieStamp: () => "fixture", workQueryStamp: () => "fixture",
  library: { worksById: new Map(works.map((work) => [work.id, work])) }
});
for (const facet of [query.facets, query.lightweightFacets]) {
  const result = facet(works);
  assert.equal(result.all, 8);
  assert.equal(result.rated, 4, "missing/empty/invalid ratings must not count as rated, while numeric zero remains valid");
  assert.equal(result.highRating, 2);
}
const missing = [{ id: "no-summary" }, { id: "empty-summary", infoSummary: {} }];
assert.equal(query.lightweightFacets(missing).rated, 0);
verifyBoundedFilterCaches();
console.log("work-facets: ok (full/search ratings, numeric zero, equivalent filters and bounded list/search/filter/sort caches)");

function verifyBoundedFilterCaches() {
  let filterCalls = 0;
  let sortCalls = 0;
  const available = [{ id: "one", title: "AB-001", playableCount: 1, infoCount: 1, infoSummary: { rating: 4.5 } }];
  const service = createWorkQueryService({
    actorMovieStamp: () => "fixture", actorMissingSearchWorks: () => [],
    clampInteger: (value, fallback, min, max) => Math.max(min, Math.min(max, Number(value) || fallback)),
    defaultWorkLimit: 1, maxWorkLimit: 64,
    enrichLocalWorksWithActorMovieIndex: (values) => values,
    favoriteStateService: { isFavoriteWork: () => false },
    isVrWork: () => true, workHasCoreCover: () => false,
    library: { worksById: new Map(available.map((work) => [work.id, work])) },
    playbackProgressService: { getWorkProgress: () => null },
    peopleScopeService: { normalize: () => "main", workMatches: (_work, scope) => scope === "main" },
    prewarmRemoteImagesForWorks: () => {}, publicWork: (work) => ({ ...work }),
    publicWorkAvailability: () => ({}), userStateStamp: () => "fixture",
    workHasLocalMarker: () => false, workInfoFacetRow: () => null, workQueryStamp: () => "fixture",
    localWorksByCodePrefix: () => available, fastMissingCodeSearch: () => [],
    storedWorkCodeKey: (value) => value.toLowerCase(), dedupeWorksForDisplay: (values) => values,
    recordPerformanceSpan: (label) => { if (label === "filter") filterCalls += 1; if (label === "sort") sortCalls += 1; }
  });
  const flags = ["playable", "info", "rated", "highRating", "localOnly", "missingCover", "vr"];
  const combinations = Array.from({ length: 127 }, (_, index) => flags.filter((_flag, bit) => (index + 1) & (1 << bit)).join(","));
  for (const mode of ["list", "search"]) {
    const call = (filter, limit = 1) => service[mode === "list" ? "listPayload" : "searchPayload"](
      new URL(`http://fixture/${mode}?q=AB&filter=${filter}&limit=${limit}`)
    );
    call("rated,playable");
    const beforeEquivalent = filterCalls;
    call("playable,rated");
    assert.equal(filterCalls, beforeEquivalent, `${mode} must share equivalent AND filter sources`);
    for (const filter of combinations) assert.equal(call(filter).total, 1);
    const beforeEvicted = filterCalls;
    call(combinations[0], 2); // A distinct response page must consult its source.
    assert.equal(filterCalls, beforeEvicted + 1, `${mode} must evict old sources instead of retaining every combination`);
    const beforeReused = filterCalls;
    call(combinations[0], 3);
    assert.equal(filterCalls, beforeReused, `${mode} must reuse its recent source after eviction/rebuild`);
    const sortCall = (sort, limit = 1) => service[mode === "list" ? "listPayload" : "searchPayload"](
      new URL(`http://fixture/${mode}?q=AB&sort=${sort}&limit=${limit}`)
    );
    for (let index = 0; index < 80; index += 1) assert.equal(sortCall(`unknown-${index}`).total, 1);
    const beforeSortReuse = sortCalls;
    sortCall("unknown-79", 2);
    assert.equal(sortCalls, beforeSortReuse, `${mode} must reuse recent source ordering`);
    const fallback = sortCall("unknown-0", 2);
    assert.equal(sortCalls, beforeSortReuse, `${mode} unknown modes must share the updated ordering instead of retaining identical copies`);
    assert.equal(fallback.sort, "unknown-0", "canonical cache keys must preserve the response sort contract");
    sortCall("size", 2);
    const beforeAlias = sortCalls;
    sortCall("sizeDesc", 2);
    assert.equal(sortCalls, beforeAlias, `${mode} legacy size aliases must share their sorted source`);
    sortCall("duration", 2);
    const beforeDurationAlias = sortCalls;
    sortCall("durationDesc", 2);
    assert.equal(sortCalls, beforeDurationAlias, `${mode} legacy duration aliases must share their sorted source`);
  }
}
