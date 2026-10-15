import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setImmediate as immediate } from "node:timers/promises";
import { createWorkQueryService } from "../src/modules/fanhao/server/works/work-query-service.js";
import { createWorkPresenterService } from "../src/modules/fanhao/server/works/presenter-service.js";

// Real person/query/presenter modules and synthetic records only. The former
// admission policy retains the same 12 pages/source with no reference budget.
const args = process.argv.slice(2);
assert.ok(args.every(value => ["--legacy-budget", "--weak-owner"].includes(value)));
const legacy = args.includes("--legacy-budget");
const sourceUrl = new URL("../src/modules/fanhao/server/people/person-detail-service.js", import.meta.url);
const original = fs.readFileSync(sourceUrl, "utf8").replace(/\r\n/g, "\n");
async function load(unbounded = false) {
  let source = original;
  if (unbounded) {
    assert.equal(source.split("const PERSON_DETAIL_PAGE_WORK_BUDGET = 8192;").length, 2);
    source = source.replace("const PERSON_DETAIL_PAGE_WORK_BUDGET = 8192;", "const PERSON_DETAIL_PAGE_WORK_BUDGET = Number.MAX_SAFE_INTEGER;");
  }
  source = source.replace(/from "(\.\.?\/[^"]+)"/gu, (_, relative) => `from "${new URL(relative, sourceUrl).href}"`);
  const hook = "    detailPayload,";
  assert.equal(source.split(hook).length, 2);
  source = source.replace(hook, `    cacheSnapshot() {
      let pages = 0, references = 0; const payloads = new Set(); const owners = [];
      for (const [key, source] of detailSourceCache) {
        if (!source) continue;
        owners.push({ key, keys: [...source.pageCache.keys()] }); pages += source.pageCache.size;
        for (const page of source.pageCache.values()) {
          references += page.works.length;
          for (const work of page.works) payloads.add(work);
        }
      }
      return { sources: detailSourceCache.size, pages, references, uniqueDtos: payloads.size, owners, budget: detailPageBudget.diagnostics() };
    },
    weakPageOwner: key => new WeakRef(detailSourceCache.get(key).pageCache),
${hook}`);
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).createPersonDetailService;
}
const createCurrent = await load(legacy), createPrior = await load(true);
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const clampCode = server.slice(server.indexOf("function clampInteger("), server.indexOf("function allWorks("));
assert.ok(clampCode.includes("Number.isFinite"));
const clampInteger = new Function(clampCode + "\nreturn clampInteger;")();
let comparisons = 0;

function fixture(create, count = 120) {
  const state = { user: "alice:1", works: "works:1", people: "people:1", visibility: "visible:1", failAt: 0 };
  const target = { state, publicWorks: 0, sources: 0, pageCalls: 0, covers: 0, remotes: 0 };
  const works = Array.from({ length: count }, (_, i) => ({ id: String(i + 1), personId: "p0", title: `Title ${String(count - i).padStart(5, "0")}`,
    directoryName: `Work ${i}`, relativePath: `fixture/${i}`, modifiedAt: `2026-01-${String(i % 28 + 1).padStart(2, "0")}`,
    videos: [], images: [], infos: [], coverId: `cover-${i}`, playableCount: i % 2, infoCount: 1,
    infoSummary: { code: `CODE-${i}`, releaseDate: i % 2 ? "2025-01-01" : "2024-01-01", rating: i % 3 ? 4.2 : null, actors: ["Synthetic"] } }));
  const people = new Map(Array.from({ length: 132 }, (_, i) => [`p${i}`, { id: `p${i}`, name: `Person ${i}`, works: works.map(work => work.id), sourcePaths: ["fixture"] }]));
  const library = { scannedAt: "scan:1", worksById: new Map(works.map(work => [work.id, work])), peopleById: people };
  const favorite = { isFavoriteWork: id => Number(id) % 2 === (state.user.startsWith("alice") ? 0 : 1),
    publicFavoriteForWork(id) { return this.isFavoriteWork(id) ? { folderId: state.user, folderName: "Fixture" } : null; } };
  const progress = { getWorkProgress: work => Number(work.id) % 3 ? null : { workId: work.id, updatedAt: "2026", owner: state.user }, getVideoProgress: () => null };
  const presenter = createWorkPresenterService({
    getLibrary: () => library, displayPersonForWork: id => people.get(id), actorProfileRow: () => null, publicActorProfile: () => null,
    publicActorProfileSnapshot: () => ({ profile: null, avatar: null }), isGPerson: () => false,
    publicCoreWorkCover: id => ({ coverUrl: `/fixture-cover/${id}` }), manualCoverStateService: { manualCoverForWork: () => null },
    favoriteStateService: favorite, playbackProgressService: progress, localWorkMarkers: () => [], displayWorkTitle: value => value || "",
    publicWorkInfoSummary: (_row, fallback) => fallback || null, publicWorkInfoMetadata: () => { throw Error("list must not load full metadata"); },
    workInfoDetailRow: () => { throw Error("lightweight person lists must not load detail rows"); },
    uniqueTextArray: value => [...new Set(value || [])], dbBoolOrNull: value => value == null ? null : Boolean(Number(value)),
    firstPresentValue: (...values) => values.find(value => value != null) ?? null, proxiedRemoteImageUrl: value => value || ""
  });
  const scope = { normalize: value => value === "western" ? "western" : "main", personMatches: () => true, workMatches: () => true };
  const query = createWorkQueryService({ library, actorMovieStamp: () => "actor:1", workQueryStamp: () => state.works,
    peoplePayloadStamp: () => state.people, userStateStamp: () => state.user, clampInteger, defaultWorkLimit: 48, maxWorkLimit: 16000,
    favoriteStateService: favorite, playbackProgressService: progress, peopleScopeService: scope,
    isVrWork: () => false, workHasCoreCover: () => true, workHasLocalMarker: () => false, workInfoFacetRow: () => null,
    publicWork(...args) { target.publicWorks++; if (state.failAt === target.publicWorks) throw new Error("synthetic presenter failure"); return presenter.publicWork(...args); },
    prewarmCoreWorkCovers: () => { target.covers++; }, prewarmRemoteImagesForWorks: () => { target.remotes++; },
    workClassificationService: { visibilityStamp: () => state.visibility, filterForRequest: rows => rows }
  });
  const service = create({ library, maxActorAvatarBytes: 1024, peoplePayloadStamp: () => state.people, workQueryStamp: () => state.works,
    userStateStamp: () => state.user, mergedPersonRecord: value => value,
    resolveLibraryPersonByPublicId: id => { target.sources++; return people.get(id); }, corePersonFallbackRecord: () => null,
    mergedActorMovieRows: () => [], coreMissingWorksForPerson: () => [], missingActorWorksForPerson: () => [],
    enrichLocalWorksWithActorMovieInfo: value => value, dedupeWorksForDisplay: value => value, workCodeKeySetForWorks: () => new Set(),
    storedWorkCodeKey: value => String(value || ""), publicPerson: presenter.publicPerson, peopleScopeService: scope,
    workQueryService: { ...query, listFromWorksPayload(...args) { target.pageCalls++; return query.listFromWorksPayload(...args); } }
  });
  return Object.assign(target, { library, service,
    read(person = "p0", params = {}) { return service.detailPayload(person, new URL("http://fixture/person?" + new URLSearchParams({ limit: "48", ...params }))); } });
}
function pair(count) { return { prior: fixture(createPrior, count), current: fixture(createCurrent, count) }; }
function compare(target, person = "p0", params = {}) {
  const expected = target.prior.read(person, params), actual = target.current.read(person, params);
  assert.deepEqual(actual, expected); comparisons++; return actual;
}
function bounded(target) {
  const snapshot = target.service.cacheSnapshot();
  assert.ok(snapshot.sources <= 128); assert.ok(snapshot.references <= 8192, `person pages retain ${snapshot.references} references, exceeding 8192`);
  assert.equal(snapshot.references, snapshot.budget.weight); assert.equal(snapshot.pages, snapshot.budget.entries);
  assert.ok(snapshot.owners.every(owner => owner.keys.length <= 12));
  return snapshot;
}

if (args.includes("--weak-owner")) {
  assert.equal(typeof global.gc, "function");
  const target = fixture(createCurrent, 60); target.read();
  const owner = target.service.weakPageOwner("main:p0");
  for (let i = 1; i <= 128; i++) target.read(`p${i}`);
  const snapshot = bounded(target); assert.ok(!snapshot.owners.some(value => value.key === "main:p0"));
  let collected = false;
  for (let i = 0; i < 12; i++) { await immediate(); global.gc(); if (!owner.deref()) { collected = true; break; } }
  assert.ok(collected, "the shared page budget must not keep an evicted person's page owner alive");
  console.log(JSON.stringify({ ok: true, evictedOwnerCollected: true }));
} else {
  const large = pair(16000);
  const sorts = ["title", "updated", "videos", "progress", "releaseDesc", "releaseAsc", "ratingDesc", "ratingAsc", "ratingCountDesc", "popularityDesc", "sizeDesc", "durationDesc"];
  for (const sort of sorts) assert.equal(compare(large, "p0", { limit: "16000", sort }).count, 16000);
  const priorLarge = large.prior.service.cacheSnapshot(), currentLarge = bounded(large.current);
  assert.equal(priorLarge.references, 192000); assert.ok(priorLarge.uniqueDtos > 4096);
  assert.equal(currentLarge.references, 0); assert.equal(currentLarge.pages, 0);
  const largePageCalls = large.current.pageCalls;
  compare(large, "p0", { limit: "16000", sort: "title" }); assert.equal(large.current.pageCalls, largePageCalls + 1);
  const hot = compare(large); const smallCalls = large.current.pageCalls;
  compare(large, "p0", { limit: "16000", sort: "title" });
  const beforeHot = large.current.pageCalls; assert.equal(large.current.read().works, hot.works);
  assert.equal(large.current.pageCalls, beforeHot); assert.equal(beforeHot, smallCalls + 1);

  const ordinary = pair(240);
  for (const sort of sorts) compare(ordinary, "p0", { sort });
  assert.equal(bounded(ordinary.current).pages, 12);
  const touch = compare(ordinary, "p0", { sort: "title" });
  compare(ordinary, "p0", { sort: "durationAsc" });
  const pageCalls = ordinary.current.pageCalls; assert.equal(ordinary.current.read("p0", { sort: "title" }).works, touch.works);
  assert.equal(ordinary.current.pageCalls, pageCalls);
  compare(ordinary, "p0", { sort: "updated" }); assert.equal(ordinary.current.pageCalls, pageCalls + 1);

  // Global LRU across person owners: the fourth 2048-row page fills the budget.
  const global = pair(4096);
  const first = compare(global, "p0", { limit: "2048" });
  for (let i = 1; i < 4; i++) compare(global, `p${i}`, { limit: "2048" });
  assert.equal(bounded(global.current).references, 8192);
  assert.equal(global.current.read("p0", { limit: "2048" }).works, first.works);
  compare(global, "p4", { limit: "2048" });
  const keys = bounded(global.current).owners.filter(owner => owner.keys.length).map(owner => owner.key);
  assert.ok(keys.includes("main:p0")); assert.ok(!keys.includes("main:p1"));

  for (const key of ["scan", "works", "people"]) {
    for (const item of [ordinary.prior, ordinary.current]) {
      if (key === "scan") item.library.scannedAt += ":next"; else item.state[key] += ":next";
    }
    compare(ordinary); const snapshot = bounded(ordinary.current); assert.equal(snapshot.sources, 1); assert.equal(snapshot.pages, 1); assert.equal(snapshot.references, 48);
  }
  for (const [key, value] of [["user", "bob:1"], ["visibility", "visible:2"], ["user", "alice:1"]]) {
    ordinary.current.state[key] = value; ordinary.prior.state[key] = value;
    const result = compare(ordinary, "p0", { filter: "favorite" });
    assert.ok(result.works.every(work => work.favorite)); bounded(ordinary.current);
  }
  for (const params of [{ year: "2024" }, { year: "2025", filter: "rated" }, { offset: "99999" }, { limit: "bad", offset: "bad" },
    { scope: "western" }, { includeMissingLocal: "0", includeCompilation: "0" }]) compare(ordinary, "p0", params);
  assert.equal(compare(ordinary, "unknown-person"), null);

  const evict = pair(60);
  for (let i = 0; i < 128; i++) compare(evict, `p${i}`);
  compare(evict, "p0"); compare(evict, "p128");
  const released = bounded(evict.current); assert.equal(released.sources, 128); assert.equal(released.pages, 128); assert.equal(released.references, 128 * 48);
  assert.ok(released.owners.some(owner => owner.key === "main:p0"));
  assert.ok(!released.owners.some(owner => owner.key === "main:p1"), "source LRU touches survive while evicted source pages unregister");
  compare(evict, "unknown-person");
  assert.equal(bounded(evict.current).pages, 127, "negative source entries also release the evicted positive source's page budget");
  const empty = fixture(createCurrent, 0);
  for (let person = 0; person < 128; person++) for (const sort of sorts) empty.read(`p${person}`, { sort });
  const emptySnapshot = bounded(empty); assert.equal(emptySnapshot.pages, 128 * 12); assert.equal(emptySnapshot.references, 0);
  empty.read("p128"); assert.equal(bounded(empty).sources, 128); assert.equal(empty.service.cacheSnapshot().pages, 127 * 12 + 1);

  const failure = pair(120);
  for (const item of [failure.prior, failure.current]) {
    item.state.failAt = 10;
    assert.throws(() => item.read(), /synthetic presenter failure/);
    assert.equal(item.service.cacheSnapshot().pages, 0);
    item.state.failAt = 0;
  }
  compare(failure); assert.equal(bounded(failure.current).pages, 1);
  const weak = execFileSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), "--weak-owner"], { encoding: "utf8" }).trim();
  assert.equal(JSON.parse(weak).evictedOwnerCollected, true);
  console.log(JSON.stringify({ ok: true, comparisons, previousLargeReferences: priorLarge.references, previousLargeUniqueDtos: priorLarge.uniqueDtos,
    currentLargeReferences: currentLarge.references, pageReferenceBudget: 8192, ordinaryPageLimit: 12,
    sourceLimit: released.sources, emptyPages: emptySnapshot.pages, evictedOwnerCollected: true }));
}
