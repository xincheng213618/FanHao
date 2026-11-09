import assert from "node:assert/strict";
import { createWorkSearchCacheFixture, searchUrl } from "./fixtures/work-search-cache-recovery.mjs";
import { deriveWorkTraits } from "../lib/work-traits.js";
import { createWorkQueryService } from "../src/modules/fanhao/server/works/work-query-service.js";

assert.ok(process.argv.slice(2).every(value => ["--legacy-poison", "--legacy-consumers-only"].includes(value)));
const legacy = process.argv.includes("--legacy-poison");
const legacyConsumersOnly = process.argv.includes("--legacy-consumers-only");
assert.ok(!(legacy && legacyConsumersOnly), "provider and consumer negative controls are separate");
const fixtures = [], warnings = [], warn = console.warn;
let oracles = 0, fallbacks = 0;
console.warn = (...args) => warnings.push(args);
function fixture(options = {}) { const value = createWorkSearchCacheFixture({ legacy, connectConsumers: !legacyConsumersOnly, ...options }); fixtures.push(value); return value; }
function expected(options = {}) { return fixture({ legacy: false, connectConsumers: true, ...options }); }
function previous(options = {}) { return fixture({ legacy: true, ...options }); }
function equal(actual, expectedValue, message, fallback = false) {
  assert.deepEqual(actual, expectedValue, message);
  assert.equal(JSON.stringify(actual), JSON.stringify(expectedValue), message + " serialized DTO");
  oracles++; if (fallback) fallbacks++;
}
function fault(target, reader, phase, extra = {}) { target.state.failure = { reader, phase, ...extra }; }
function matches(target, query) { const matcher = target.text.createMatcher(query); return target.works.map(work => matcher(work)); }
function verifySearchSourceCategories() {
  const target = expected();
  target.works[1].personName = "Anime";
  target.state.db.prepare("UPDATE works SET title=? WHERE id=3").run("FC2 PPV 333");
  let categoryReads = 0, account = "first";
  const dependencies = target.grouped.works;
  const query = createWorkQueryService({
    ...dependencies,
    library: target.library,
    workQueryStamp: () => target.state.stamp,
    userStateStamp: () => account,
    favoriteStateService: {
      ...dependencies.favoriteStateService,
      isFavoriteWork: id => account === "second" && id === "1"
    },
    peopleScopeService: {
      ...dependencies.peopleScopeService,
      workMatcher: scope => scope === "western" ? work => work.id === "2" : () => true,
      workMatchesDirect(work, scope) {
        assert.equal(scope, "western");
        categoryReads++;
        return work.id === "1";
      }
    }
  });
  const page = (filter = "all", sort = "codeAsc", offset = 0, category = "all") =>
    query.searchPayload(searchUrl("AA", filter, sort, 1, offset, category));
  const counts = payload => Object.fromEntries(payload.categories.map(({ value, count }) => [value, count]));
  const first = page();
  const initial = { censored: 3, western: 1, fc2: 1, anime: 1 };
  assert.deepEqual(counts(first), initial, "summary uses direct classification across the full source");
  assert.equal(categoryReads, 6);
  assert.equal(first.facets.favorite, 0);
  assert.equal(page("all", "codeAsc", 1).offset, 1);
  assert.deepEqual(counts(page("localOnly")), initial);
  assert.deepEqual(counts(page("all", "releaseDesc")), initial);
  const western = page("all", "codeAsc", 0, "western");
  assert.deepEqual(western.works.map(work => work.id), ["2"], "selected category uses indexed membership");
  assert.deepEqual(counts(western), initial, "selected category still reports direct source-wide counts");
  assert.equal(categoryReads, 6, "paging, filter, sort and selected category reuse the source summary");

  account = "second";
  const second = page();
  assert.equal(second.facets.favorite, 1, "the same page reads the new account's favorites");
  assert.equal(first.facets.favorite, 0);
  assert.deepEqual(page("favorite").works.map(work => work.id), ["1"]);
  assert.deepEqual(counts(second), initial);
  assert.equal(categoryReads, 6, "account changes refresh user facets without rescanning categories");

  target.state.db.exec("UPDATE works SET status='unavailable' WHERE id=3");
  target.state.stamp = "next-catalog";
  fault(target, "prefix", "all");
  for (const offset of [0, 1]) {
    const failed = target.adapters.withWorkSearchReadStatus(() => page("all", "codeAsc", offset));
    assert.equal(failed.cacheable, false);
    assert.deepEqual(counts(failed.value), { censored: 0, western: 1, fc2: 0, anime: 1 });
    assert.equal(categoryReads, 6 + 2 * (offset + 1), "each incomplete source computes its own fallback summary");
  }
  target.state.failure = null;
  const refreshed = { censored: 3, western: 1, fc2: 0, anime: 1 };
  assert.deepEqual(counts(page()), refreshed, "the new catalog source excludes the removed FC2 work after same-stamp repair");
  assert.equal(categoryReads, 15);
  assert.deepEqual(counts(page("all", "codeAsc", 1)), refreshed);
  assert.deepEqual(counts(first), initial, "source replacement does not mutate old responses");
  assert.equal(categoryReads, 15, "the recovered source reuses its fresh summary");
}
function verifySearchPersonProfileRecovery() {
  const target = expected();
  let profileAvailable = false, searchReads = 0, profileReads = 0, searchReader;
  const query = createWorkQueryService({
    ...target.grouped.works,
    library: target.library,
    searchPeople() {
      searchReads++;
      const row = profileAvailable ? { displayName: "Recovered profile" } : { displayName: "Older profile" };
      searchReader = Object.assign(() => {
        profileReads++;
        return row;
      }, { cacheable: profileAvailable });
      return { exact: [], people: [target.person], readProfile: searchReader };
    },
    publicPerson() {
      assert.fail("search chips should not retry an independent point profile read");
    },
    createPublicPersonPresenter(readProfile) {
      assert.equal(readProfile, searchReader, "the chip presenter uses the matching attempt's reader");
      return (person, options) => {
        assert.equal(options.skipFallbackAvatar, true);
        return { id: person.id, displayName: readProfile(person.id).displayName };
      };
    }
  });
  const page = offset => query.searchPayload(searchUrl("needle phrase", "all", "codeAsc", 1, offset));
  assert.deepEqual(page(0).people, [{ id: target.person.id, displayName: "Older profile" }]);
  profileAvailable = true;
  const recovered = page(1).people;
  assert.deepEqual(recovered, [{ id: target.person.id, displayName: "Recovered profile" }],
    "another page at the same stamp retries an incomplete people source");
  assert.deepEqual(page(0).people, recovered, "the original incomplete page also retries");
  assert.equal(searchReads, 2, "only the successful source is retained");
  assert.equal(profileReads, 2, "each search attempt projects the chip from its shared profile reader");
}
function createReleaseSortFixture() {
  const target = expected({ count: 0, localCount: 0 });
  const dependencies = target.grouped.works;
  let account = "first", metadataReads = 0, titleReads = 0, presenting = false;
  for (let index = 0; index < 4800; index++) {
    const id = String(index < 2 ? 2 - index : index + 1);
    const group = Math.floor(index / 2);
    const date = index < 2 ? "2099-12-31" : `2026-${String(group % 12 + 1).padStart(2, "0")}-01`;
    const work = {
      id, personId: "1", title: `Fixture title ${group % 91}`, directoryName: `Fixture ${id}`,
      modifiedAt: "2026-01-01", playableCount: index < 2400 || (index >= 4600 && index < 4760) ? 1 : 0,
      videos: [], images: [], infos: [],
      infoSummary: {
        hasMagnet: index < 1150,
        get releaseDate() {
          if (!presenting) metadataReads++;
          return id === "2400" && target.state.stamp === "catalog-next" ? "2100-01-01" : date;
        }
      }
    };
    target.works.push(work);
    target.library.worksById.set(id, work);
  }
  const isWestern = work => Number(work.id) > 4600;
  const favorites = dependencies.favoriteStateService;
  favorites.isFavoriteWork = id => account === "first" ? Number(id) % 2 === 0 : Number(id) < 4000 && Number(id) % 2 === 1;
  favorites.publicFavoriteForWork = id => favorites.isFavoriteWork(id) ? { folderId: account, folderName: account } : null;
  const query = createWorkQueryService({
    ...dependencies,
    library: target.library,
    workQueryStamp: () => target.state.stamp,
    userStateStamp: () => account,
    localWorksByCodePrefix: () => target.works,
    fastMissingCodeSearch: () => [],
    workHasLocalMarker: work => Number(work.id) <= 1100,
    displayWorkTitle(title) { titleReads++; return String(title); },
    peopleScopeService: {
      ...dependencies.peopleScopeService,
      workMatcher: scope => scope === "western" ? isWestern : () => true,
      workMatchesDirect: isWestern
    },
    publicWork(...args) {
      presenting = true;
      try { return dependencies.publicWork(...args); }
      finally { presenting = false; }
    }
  });
  return {
    page(filter = "all", { sort = "releaseDesc", category = "censored", offset = 0 } = {}) {
      metadataReads = titleReads = 0;
      const url = searchUrl("AA", filter, sort, 48, offset, category);
      if (sort === "releaseDesc") url.searchParams.delete("sort");
      const data = query.searchPayload(url);
      return { data, metadataReads, titleReads };
    },
    nextAccount() { account = "second"; },
    nextCatalog() { target.state.stamp = "catalog-next"; }
  };
}
function verifySearchReleaseSortReuse() {
  const actual = createReleaseSortFixture(), oracle = createReleaseSortFixture();
  function compare(filter, options, message) {
    const result = actual.page(filter, options), baseline = oracle.page(filter, options);
    equal(result.data, baseline.data, message);
    return { result, baseline };
  }
  function sorted(page, total, message) {
    assert.equal(page.data.total, total);
    assert.equal(page.metadataReads, total, message);
    assert.ok(page.titleReads > 0, "the fixture exercises tied title keys");
  }
  function reused(page, message) {
    assert.equal(page.metadataReads, 0, message);
    assert.equal(page.titleReads, 0, message);
  }

  sorted(actual.page(), 4600, "prime the category parent through the normal first page");
  const dense = compare("playable", {}, "dense release subset has full DTO and order parity");
  sorted(dense.baseline, 2400, "a dense subset with no warmed parent still sorts directly");
  reused(dense.result, "a dense subset reuses the warmed parent's release ordering");
  assert.deepEqual(dense.result.data.works.slice(0, 2).map(work => work.id), ["2", "1"], "stable ties keep source order");
  const next = compare("playable", { offset: 48 }, "release subset continuation keeps order and metadata");
  reused(next.result, "continuation reuses the ordered subset");
  sorted(compare("playable", { sort: "releaseAsc" }, "ascending request retains independent ordering").result,
    2400, "the descending parent cannot serve ascending results");
  sorted(compare("localMarkedA", {}, "minority subset retains direct-sort parity").result,
    1100, "a minority subset does not scan the larger parent order");
  const quarter = compare("hasMagnet", {}, "a quarter of the parent retains full order parity");
  sorted(quarter.baseline, 1150, "the quarter-size oracle sorts directly");
  reused(quarter.result, "a subset exactly at 25 percent reuses the parent order");
  sorted(actual.page("all", { category: "western" }), 200, "warm the small category separately");
  sorted(compare("playable", { category: "western" }, "small dense subset retains direct-sort parity").result,
    160, "a small subset still sorts even when it is most of its parent");

  const first = compare("favorite", {}, "initial favorite filter preserves full DTO parity").result;
  reused(first, "the first account reuses the category order");
  for (const fixture of [actual, oracle]) fixture.nextAccount();
  const second = compare("favorite", {}, "account switch refreshes favorite membership and cards").result;
  reused(second, "the second account can use the same release order");
  assert.equal(first.data.facets.favorite, 2300);
  assert.equal(second.data.facets.favorite, 2000);
  assert.equal(first.data.works[0].favoriteFolderId, "first");
  assert.equal(second.data.works[0].favoriteFolderId, "second");
  assert.notEqual(second.data.works[0].id, first.data.works[0].id);

  for (const fixture of [actual, oracle]) fixture.nextCatalog();
  const changed = compare("playable", {}, "catalog revision invalidates the old category release order").result;
  sorted(changed, 2400, "a catalog revision cannot reuse the prior parent's order");
  assert.equal(changed.data.works[0].id, "2400", "the new release date appears before old ties");
}
function verifyConsumerNegativeControl() {
  const results = [], failures = [];
  const cases = [
    { name: "text source/page", reader: "text", query: "needle phrase", filter: "all" },
    { name: "missing-prefix source/page", reader: "prefix", query: "AA", filter: "all" },
    { name: "late hydrate prepared DTO/page", reader: "hydrate", query: "AA", filter: "all", offset: 1 },
    { name: "prefix missing source/filter/result", reader: "prefix", query: "AA", filter: "missingLocal", prefix: true }
  ];
  for (const phase of ["prepare", "all"]) for (const item of cases) {
    const actual = fixture({ legacy: false, connectConsumers: false });
    const protectedConsumer = expected(), healthy = expected();
    const first = searchUrl(item.query, item.filter, "codeAsc", 1, item.offset || 0);
    const alternate = searchUrl(item.query, item.filter, item.reader === "hydrate" ? "codeAsc" : "releaseDesc", 2, item.offset || 0);
    const page = (target, url) => item.prefix ? target.prefix.detailPayload("AA", url) : target.query.searchPayload(url);
    for (const target of [actual, protectedConsumer]) {
      fault(target, item.reader, phase);
      page(target, first);
      target.state.failure = null;
      // Repair and prime only the real provider at the same stamp. The full
      // consumer DTO oracle below therefore isolates upper cache admission.
      if (item.reader === "text") {
        assert.deepEqual(matches(target, item.query), matches(healthy, item.query), "current text provider has independently recovered");
      } else {
        const rows = target.missing.hydrate(target.missing.search("AA"));
        assert.deepEqual(rows, healthy.missing.hydrate(healthy.missing.search("AA")), "current missing provider has independently recovered");
      }
    }
    for (const [variant, url] of [["alternate source/DTO", alternate], ["original page/result", first]]) {
      const message = `consumer-only same-stamp full DTO recovery: ${item.name} ${phase} ${variant}`;
      equal(page(protectedConsumer, url), page(healthy, url), "connected " + message);
      const actualDto = page(actual, url), expectedDto = page(healthy, url);
      const serializedDifferent = JSON.stringify(actualDto) !== JSON.stringify(expectedDto);
      try {
        equal(actualDto, expectedDto, message);
        results.push({ reader: item.name, phase, variant, failed: false, serializedDifferent });
      } catch (error) {
        if (!(error instanceof assert.AssertionError)) throw error;
        results.push({ reader: item.name, phase, variant, failed: true, serializedDifferent });
        failures.push(error);
      }
    }
  }
  console.log(JSON.stringify({ consumerOnlyNegativeControl: results, protectedFullDtoOracles: oracles,
    nativeConnections: fixtures.length }));
  // Report the first complete recovery DTO difference, after exercising every
  // consumer boundary. No SQL-count or structural assertion masks this oracle.
  if (failures.length) throw failures[0];
  assert.fail("consumer-only negative control must expose an upper cache recovery DTO failure");
}
try {
  if (legacyConsumersOnly) {
    verifyConsumerNegativeControl();
  } else {
  if (!legacy) {
    verifySearchSourceCategories();
    verifySearchPersonProfileRecovery();
    verifySearchReleaseSortReuse();
  }
  // Compact prefix records carry labels before detail hydration. Full-source
  // facets and tag filters must include later pages without reading details.
  const lateTraits = fixture();
  const localPage = lateTraits.query.searchPayload(searchUrl("AA", "all", "codeAsc", 1, 4));
  assert.equal(localPage.works[0].id, "1");
  assert.equal(localPage.traitFacets.tags.find(tag => tag.name === "fixture")?.count, 6);
  assert.equal(lateTraits.state.counts.hydrate, 0, "off-page category counts do not hydrate missing detail rows");
  const filteredLocalPage = lateTraits.query.searchPayload(searchUrl("AA", "tag:fixture", "codeAsc", 1, 4));
  assert.equal(filteredLocalPage.total, 6, "tag filters include unhydrated later-page missing works");
  assert.equal(filteredLocalPage.traitFacets.tags.find(tag => tag.name === "fixture")?.count, 6);
  assert.equal(lateTraits.state.counts.hydrate, 0, "filtering the complete label projection does not load off-page details");
  const hydratedPage = lateTraits.query.searchPayload(searchUrl("AA", "all", "codeAsc", 1, 0));
  assert.equal(hydratedPage.works[0].id, "3");
  assert.deepEqual(hydratedPage.works[0].infoSummary.javdbTags, ["fixture"]);
  assert.deepEqual(hydratedPage.works[0].traits.tags, ["fixture"], "pending-to-hydrated DTO recomputes traits without a stamp change");
  assert.equal(hydratedPage.traitFacets.tags.find(tag => tag.name === "fixture")?.count, 6,
    "full-source facet counts remain stable after same-stamp detail hydration");
  assert.equal(localPage.traitFacets.tags.find(tag => tag.name === "fixture")?.count, 6,
    "later hydration does not mutate a previously returned response object");
  for (const phase of ["prepare", "all"]) {
    const retryTraits = fixture();
    retryTraits.query.searchPayload(searchUrl("AA", "all", "codeAsc", 1, 4));
    fault(retryTraits, "hydrate", phase);
    const url = searchUrl("AA", "all", "codeAsc", 1, 0);
    const failedTraits = retryTraits.adapters.withWorkSearchReadStatus(() => retryTraits.query.searchPayload(url));
    if (!legacy) assert.equal(failedTraits.cacheable, false);
    assert.deepEqual(failedTraits.value.works[0].traits.tags, ["fixture"], "detail failure retains independently complete compact labels");
    retryTraits.state.failure = null;
    const recoveredTraits = retryTraits.query.searchPayload(url);
    assert.deepEqual(recoveredTraits.works[0].traits.tags, ["fixture"], "failed hydration does not cache incomplete traits at the same stamp");
    assert.equal(recoveredTraits.traitFacets.tags.find(tag => tag.name === "fixture")?.count, 6,
      "failed hydration does not freeze incomplete trait facet counts");
  }

  const completeTags = fixture({ count: 50 });
  const wideDescription = "private synopsis ".repeat(5000);
  const tagFields = [
    { label: "類別", value: "單體作品 / 眼鏡" },
    { name: " Ge_n.re:S ", value: ["美少女電影", "戀愛"] },
    { key: "カテゴリ", value: "OL、秘書" },
    { label: "", name: "tags", value: "制服" },
    { label: "简介", value: wideDescription }
  ];
  const updateTags = completeTags.state.db.prepare("UPDATE works SET fields_json=? WHERE id=?");
  for (const id of [1, 3]) updateTags.run(JSON.stringify(tagFields), id);
  for (const id of [10, 20, 30, 40, 50]) updateTags.run('[{"label":"类别","value":"后页标签"}]', id);
  updateTags.run("not JSON", 4); updateTags.run("42", 5);
  updateTags.run('[null,7,"not JSON",{"label":"not-category","value":"ignored"}]', 6);
  const manyTags = Array.from({ length: 200 }, (_, index) => `bounded-tag-${index}`);
  completeTags.state.db.prepare("UPDATE works SET javdb_tags_json=? WHERE id=7").run(JSON.stringify(["x".repeat(81), ...manyTags]));
  const unhydratedFilteredPage = completeTags.query.searchPayload(searchUrl("AA", `tag:${encodeURIComponent("后页标签")}`, "codeAsc", 2, 5));
  assert.equal(unhydratedFilteredPage.total, 5, "filter matches five later-page rows before any detail hydration");
  assert.equal(unhydratedFilteredPage.count, 0);
  assert.equal(unhydratedFilteredPage.traitFacets.tags.find(tag => tag.name === "后页标签")?.count, 5);
  assert.equal(completeTags.state.counts.hydrate, 0);
  const fullTagSource = completeTags.query.searchPayload(searchUrl("AA", "all", "codeAsc", 2, 48));
  assert.equal(fullTagSource.total, 50);
  assert.equal(fullTagSource.traitFacets.tags.find(tag => tag.name === "眼镜")?.count, 2);
  assert.equal(fullTagSource.traitFacets.tags.find(tag => tag.name === "后页标签")?.count, 5);
  assert.equal(completeTags.state.counts.hydrate, 0, "full-source tags do not prewarm off-page details or covers");
  const compactMissing = completeTags.missing.search("AA");
  const remoteThree = compactMissing.find(work => work.id === "3");
  assert.deepEqual(deriveWorkTraits(remoteThree).tags, fullTagSource.works.find(work => work.id === "1").traits.tags,
    "prefix and local metadata reuse all current category aliases and list syntax");
  assert.equal(JSON.stringify(compactMissing).includes(wideDescription), false, "prefix cache never retains the complete metadata fields payload");
  assert.equal(compactMissing.find(work => work.id === "7").infoSummary.javdbTags.length, 128);
  assert.ok(compactMissing.find(work => work.id === "7").infoSummary.javdbTags.every(tag => tag.length <= 80));
  const visibleTags = completeTags.query.searchPayload(searchUrl("AA", `tag:${encodeURIComponent("后页标签")}`, "codeAsc", 2, 0));
  assert.equal(visibleTags.total, 5);
  assert.equal(visibleTags.count, 2);
  assert.ok(visibleTags.works.every(work => work.traits.tags.includes("后页标签")));
  assert.equal(visibleTags.traitFacets.tags.find(tag => tag.name === "后页标签")?.count, 5);

  const oldColumns = fixture();
  oldColumns.state.db.exec("ALTER TABLE works DROP COLUMN fields_json; ALTER TABLE works DROP COLUMN javdb_tags_json");
  const absentTags = oldColumns.missing.withReadStatus(() => oldColumns.missing.search("AA"));
  assert.equal(absentTags.cacheable, true, "only confirmed absent optional columns permit a complete empty-label downgrade");
  assert.equal(absentTags.value.length, 4);
  assert.ok(absentTags.value.every(work => work.infoSummary.tags.length === 0 && work.infoSummary.javdbTags.length === 0));
  const absenceReads = { ...oldColumns.state.counts };
  oldColumns.missing.search("AA");
  assert.deepEqual(oldColumns.state.counts, absenceReads, "confirmed absent optional columns retain successful prefix caching");

  for (const phase of ["prepare", "all"]) for (const reader of ["text", "actors", "makers", "series"]) {
    const actual = fixture(), old = previous(), healthy = expected();
    for (const target of [actual, old]) fault(target, reader, phase);
    const failed = actual.text.withReadStatus(() => matches(actual, "needle phrase"));
    equal(failed.value, matches(old, "needle phrase"), "the complete old partial-map matcher fallback remains unchanged", true);
    if (!legacy) assert.equal(failed.cacheable, false);
    actual.state.failure = null;
    for (const query of ["needle phrase", "actor phrase", "label phrase", "maker", "series", "raw phrase", "fixture", "private", "", "n", "zz missing", "Metadata1"]) {
      equal(matches(actual, query), matches(healthy, query), "text/gram index retries the failed SQL at the same stamp");
    }
    const reads = { ...actual.state.counts };
    equal(matches(actual, "needle phrase"), matches(healthy, "needle phrase"), "healthy matcher keeps its successful index");
    assert.deepEqual(actual.state.counts, reads);
  }

  for (const phase of ["prepare", "all"]) for (const reader of ["text", "actors", "makers", "series", "cover", "prefix", "hydrate"]) {
    const actual = fixture(), old = previous(), healthy = expected();
    const query = ["cover", "prefix", "hydrate"].includes(reader) ? "AA" : "needle phrase";
    const firstFilter = reader === "hydrate" ? "all" : "missingCover";
    fault(actual, reader, phase); fault(old, reader, phase);
    const failed = actual.adapters.withWorkSearchReadStatus(() => actual.query.searchPayload(searchUrl(query, firstFilter, "ratingDesc", 1)));
    if (!legacy) assert.equal(failed.cacheable, false, "each injected reader is actually consumed by its public search request");
    assert.ok(actual.state.counts[reader] > 0);
    equal(failed.value, old.query.searchPayload(searchUrl(query, firstFilter, "ratingDesc", 1)), "old public failed search DTO remains identical", true);
    actual.state.failure = null;
    // A different filter/order/page request first catches poisoned sources
    // even if the original response page was correctly kept out of its cache.
    for (const filter of ["all", "missingCover", "info", "rated", "highRating", "missingLocal"])
      for (const sort of ["ratingDesc", "releaseAsc", "updated", "codeAsc"])
        for (const offset of [0, 1]) {
          const url = searchUrl(query, filter, sort, 1, offset);
          equal(actual.query.searchPayload(url), healthy.query.searchPayload(url), "same-stamp source/filter/sort/DTO/page recovery");
        }
    const url = searchUrl(query, firstFilter, "ratingDesc", 1);
    equal(actual.query.searchPayload(url), healthy.query.searchPayload(url), "original failed page recovers at the same stamp");
    const complete = actual.query.searchPayload(url), reads = { ...actual.state.counts };
    assert.equal(actual.query.searchPayload(url), complete, "healthy public search page retains identity");
    assert.deepEqual(actual.state.counts, reads);
  }

  for (const phase of ["prepare", "all"]) for (const reader of ["cover", "prefix", "hydrate"]) {
    const actual = fixture(), old = previous(), healthy = expected();
    fault(actual, reader, phase); fault(old, reader, phase);
    const first = searchUrl("AA", reader === "hydrate" ? "all" : "missingCover", "ratingDesc", 1, 2);
    const failed = actual.adapters.withWorkSearchReadStatus(() => actual.prefix.detailPayload("AA", first));
    if (!legacy) assert.equal(failed.cacheable, false);
    equal(failed.value, old.prefix.detailPayload("AA", first), "actual server prefix/page adapters preserve old failed DTOs", true);
    actual.state.failure = null;
    for (const filter of ["all", "missingCover", "highRating", "info", "rated", "missingLocal"])
      for (const sort of ["ratingDesc", "releaseAsc", "codeAsc"])
        for (const [limit, offset] of [[1, 0], [1, 2], [2, 1]]) {
          const url = searchUrl("AA", filter, sort, limit, offset);
          equal(actual.prefix.detailPayload("AA", url), healthy.prefix.detailPayload("AA", url),
            "same-stamp prefix source/filter/result/page/hydration recovery through actual server constructor");
        }
    equal(actual.prefix.detailPayload("AA", first), healthy.prefix.detailPayload("AA", first), "original prefix failure page also retries");
  }

  for (const phase of ["prepare", "all"]) {
    const actual = fixture(), old = previous(), healthy = expected();
    for (const target of [actual, old]) target.missing.prewarm();
    for (const target of [actual, old, healthy]) {
      target.state.db.exec("DELETE FROM fanhao_images.images WHERE owner_id=3");
      target.state.stamp = "next";
    }
    for (const target of [actual, old]) fault(target, "cover", phase);
    equal(actual.missing.search("AA"), old.missing.search("AA"), "warm cover failure retains the complete old cover-set fallback", true);
    actual.state.failure = null;
    equal(actual.missing.search("AA"), healthy.missing.search("AA"), "old cover fallback cannot poison prefix DTOs at the new stamp");
  }

  for (const phase of ["prepare", "all"]) {
    const actual = fixture(), old = previous(), healthy = expected();
    for (const target of [actual, old]) matches(target, "needle phrase");
    for (const target of [actual, old, healthy]) {
      target.state.db.exec("UPDATE works SET title=title||' refreshed phrase'");
      target.state.stamp = "next";
    }
    fault(actual, "makers", phase); fault(old, "makers", phase);
    equal(matches(actual, "refreshed phrase"), matches(old, "refreshed phrase"), "warm text failure keeps this attempt's partial map", true);
    actual.state.failure = null;
    equal(matches(actual, "label phrase"), matches(healthy, "label phrase"), "warm partial text map must retry later missing batches at the same stamp");
  }

  const native = fixture(), nativeExpected = expected();
  native.state.db.exec("ALTER TABLE fanhao_images.images RENAME TO unavailable_images");
  const nativeFailed = native.query.searchPayload(searchUrl("AA", "missingCover", "ratingDesc", 1));
  assert.ok(nativeFailed.works.every(work => work.personId === "" || work.id === "1"));
  native.state.db.exec("ALTER TABLE fanhao_images.unavailable_images RENAME TO images");
  equal(native.query.searchPayload(searchUrl("AA", "all", "ratingDesc", 1)), nativeExpected.query.searchPayload(searchUrl("AA", "all", "ratingDesc", 1)),
    "native attached-table cover and hydration errors recover without changing stamps");
  const nativePrefix = fixture(), nativePrefixExpected = expected();
  nativePrefix.state.db.exec("ALTER TABLE works RENAME TO unavailable_works");
  nativePrefix.query.searchPayload(searchUrl("AA", "all", "ratingDesc", 1));
  nativePrefix.state.db.exec("ALTER TABLE unavailable_works RENAME TO works");
  equal(nativePrefix.query.searchPayload(searchUrl("AA", "all", "ratingDesc", 1)),
    nativePrefixExpected.query.searchPayload(searchUrl("AA", "all", "ratingDesc", 1)), "native missing-work SQL schema restoration retries upper source and page");
  for (const table of ["works", "work_people", "makers", "series"]) {
    const actual = fixture(), healthy = expected();
    actual.state.db.exec(`ALTER TABLE ${table} RENAME TO unavailable_${table}`);
    actual.text.withReadStatus(() => matches(actual, "needle phrase"));
    actual.state.db.exec(`ALTER TABLE unavailable_${table} RENAME TO ${table}`);
    equal(matches(actual, "label phrase"), matches(healthy, "label phrase"), "native text query schema restoration retries the complete index");
  }

  const scoped = fixture({ count: 1002, localCount: 1002 });
  fault(scoped, "actors", "all");
  const outer = scoped.text.withReadStatus(() => {
    scoped.text.prewarm();
    for (const query of ["needle phrase", "actor phrase", "raw phrase"]) matches(scoped, query);
    assert.equal(scoped.text.withReadStatus(() => "independent value").cacheable, true);
    return "public return";
  });
  if (!legacy) {
    equal(outer, { value: "public return", cacheable: false }, "nested text status propagates without changing values", true);
    assert.equal(scoped.state.counts.actors, 1, "one operation reuses its failed map and grams across all works");
  }
  scoped.text.prewarm();
  assert.equal(scoped.state.counts.actors, 2, "an independent failed prewarm retries");
  scoped.state.failure = null;
  assert.ok(matches(scoped, "actor phrase").every(Boolean));

  const owner = fixture(), ownerExpected = expected();
  const ownerRead = owner.adapters.withWorkSearchReadStatus(() => {
    owner.state.db.close();
    equal(matches(owner, "needle phrase"), [false, false], "closed native owner uses the prior empty text fallback", true);
    owner.state.db = ownerExpected.state.db;
    equal(matches(owner, "needle phrase"), matches(ownerExpected, "needle phrase"), "new native owner retries inside the same failed outer scope");
    return "restored";
  });
  if (!legacy) assert.equal(ownerRead.cacheable, false);
  // The expected fixture owns the shared replacement; avoid closing it twice.
  owner.close = () => {};

  const missingOwner = fixture(), missingOwnerExpected = expected();
  const missingOwnerRead = missingOwner.adapters.withWorkSearchReadStatus(() => {
    missingOwner.state.db.close();
    equal(missingOwner.missing.search("AA"), [], "closed native missing owner preserves the old empty failure", true);
    missingOwner.state.db = missingOwnerExpected.state.db;
    equal(missingOwner.missing.hydrate(missingOwner.missing.search("AA")),
      missingOwnerExpected.missing.hydrate(missingOwnerExpected.missing.search("AA")),
      "replacement native owner retries cover/prefix/hydration in the same failed synchronous scope");
    return "restored owner";
  });
  if (!legacy) assert.equal(missingOwnerRead.cacheable, false);
  missingOwner.close = () => {};

  const invalidated = fixture(), invalidatedExpected = expected();
  fault(invalidated, "actors", "all");
  const invalidatedRead = invalidated.text.withReadStatus(() => {
    matches(invalidated, "actor phrase");
    invalidated.state.failure = null;
    invalidated.text.invalidate();
    equal(matches(invalidated, "actor phrase"), matches(invalidatedExpected, "actor phrase"),
      "invalidation releases operation-local failed maps and gram indexes");
    return "recovered match";
  });
  if (!legacy) assert.equal(invalidatedRead.cacheable, false, "invalidation preserves the outer operation's earlier failure");

  const scopedCovers = fixture();
  fault(scopedCovers, "cover", "all");
  const coverRead = scopedCovers.missing.withReadStatus(() => {
    scopedCovers.missing.prewarm();
    for (const prefix of ["AA", "AA0", "AA003", "BB", "missing"]) scopedCovers.missing.search(prefix);
    return "prefix arrays";
  });
  if (!legacy) {
    assert.equal(coverRead.cacheable, false);
    assert.equal(scopedCovers.state.counts.cover, 1, "one outer operation shares failed cover reads across prefixes");
  }
  scopedCovers.missing.prewarm();
  if (!legacy) assert.equal(scopedCovers.state.counts.cover, 2, "new failed cover prewarm retries at the same stamp");

  const missing = fixture(), missingExpected = expected();
  for (const reader of ["cover", "prefix", "hydrate"]) {
    fault(missing, reader, "all");
    const result = missing.adapters.withWorkSearchReadStatus(() => {
      const rows = missing.missing.search("AA");
      return missing.missing.hydrate(rows);
    });
    if (!legacy) assert.equal(result.cacheable, false);
    missing.state.failure = null;
    equal(missing.missing.hydrate(missing.missing.search("AA")), missingExpected.missing.hydrate(missingExpected.missing.search("AA")),
      "direct missing search/hydrate arrays remain retryable");
    missing.state.stamp = missingExpected.state.stamp = reader;
  }

  const healthy = fixture(), oldHealthy = previous();
  const cold = fixture();
  cold.text.prewarm();
  assert.deepEqual(cold.state.counts, { text: 1, actors: 1, makers: 1, series: 1, cover: 0, prefix: 0, hydrate: 0 },
    "healthy cold text prewarm retains the original four SQL projections");
  cold.text.prewarm(); matches(cold, "needle phrase");
  assert.deepEqual(cold.state.counts, { text: 1, actors: 1, makers: 1, series: 1, cover: 0, prefix: 0, hydrate: 0 },
    "healthy warm text prewarm and matcher construction perform no SQL");
  cold.missing.prewarm(); cold.missing.prewarm();
  assert.equal(cold.state.counts.cover, 1, "healthy cover prewarm retains one batch and warm reuse");
  const empty = fixture({ count: 0, localCount: 0 });
  assert.equal(empty.text.prewarm(), undefined);
  assert.equal(empty.text.createMatcher("empty phrase")({ id: "new", title: "empty phrase", personId: "1" }), true);
  assert.equal(empty.state.counts.text, 1, "a matcher reads metadata only when it receives an unindexed work");
  const emptyNoRead = fixture({ count: 0, localCount: 0 });
  emptyNoRead.text.prewarm(); emptyNoRead.text.prewarm();
  emptyNoRead.text.createMatcher("empty phrase"); emptyNoRead.text.createMatcher("");
  assert.deepEqual(emptyNoRead.state.counts, { text: 0, actors: 0, makers: 0, series: 0, cover: 0, prefix: 0, hydrate: 0 },
    "empty library prewarm and matcher construction preserve the original zero SQL reads");
  for (const query of ["AA", "AA003", "BB", "zz empty", "", "a"]) {
    equal(healthy.missing.search(query), oldHealthy.missing.search(query), "healthy prefix DTOs preserve full arrays, empties and order");
    const rows = healthy.missing.search(query), oldRows = oldHealthy.missing.search(query);
    assert.equal(healthy.missing.hydrate(rows), rows);
    equal(rows, oldHealthy.missing.hydrate(oldRows), "healthy hydration preserves arrays and complete row DTOs");
  }
  const extra = { id: "missing-extra", title: "extra phrase", personId: "1", videos: [], images: [], infos: [] };
  healthy.text.prewarm([extra]); oldHealthy.text.prewarm([extra]);
  equal(healthy.text.createMatcher("extra phrase")(extra), oldHealthy.text.createMatcher("extra phrase")(extra), "extra works retain prewarm coverage");
  for (const query of ["needle phrase", "raw phrase", "private", "", "n", "absent phrase"])
    equal(matches(healthy, query), matches(oldHealthy, query), "successful text and normalized matching remains identical");
  equal(healthy.missing.search("totally-empty"), [], "a successful empty prefix remains an ordinary complete value");
  const reads = { ...healthy.state.counts };
  equal(healthy.missing.search("totally-empty"), [], "successful empty prefix is reused");
  assert.deepEqual(healthy.state.counts, reads);
  const sentinel = new Error("callback exception");
  assert.throws(() => healthy.adapters.withWorkSearchReadStatus(() => { throw sentinel; }), error => error === sentinel);
  assert.equal(healthy.adapters.workSearchReadCacheable(), true, "exception cleanup releases all synchronous scopes");
  const caught = healthy.adapters.withWorkSearchReadStatus(() => {
    assert.throws(() => healthy.text.withReadStatus(() => { throw sentinel; }), error => error === sentinel);
    return "outer fallback";
  });
  if (!legacy) equal(caught, { value: "outer fallback", cacheable: false }, "caught child exceptions preserve original errors and failure admission", true);
  console.log(JSON.stringify({ workSearchCacheRecovery: "ok", oracles, fallbacks, nativeConnections: fixtures.length,
    textBatchReads: scoped.state.counts, warnings: warnings.length }));
  }
} finally {
  console.warn = warn;
  for (const value of fixtures) value.close();
}
