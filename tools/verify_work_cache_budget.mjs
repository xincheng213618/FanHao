import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setImmediate as immediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createWeightedCacheBudget, normalizeWorkSortMode } from "../src/modules/fanhao/server/works/work-cache-budget.js";
import { createWorkQueryService } from "../src/modules/fanhao/server/works/work-query-service.js";
import { createStudioService } from "../src/modules/fanhao/server/catalog/studio-service.js";
import { createCollectionQueryService } from "../src/modules/fanhao/server/user-state/collection-query-service.js";
import { routeUserStateApi } from "../src/modules/fanhao/server/user-state/routes.js";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createWorkClassificationService } from "../src/modules/fanhao/server/works/work-classification-service.js";
import { createWorkSorter } from "../src/modules/fanhao/server/works/work-sorter.js";
import { classifyWorkCategory, normalizeWorkCategory, summarizeWorkCategories, WORK_CATEGORY_OPTIONS } from "../src/modules/fanhao/server/works/work-category.js";
const clampInteger = (value, fallback, min, max) => Math.max(min, Math.min(max, Number(value ?? fallback)));
const legacyMissingPrefixCache = process.argv.includes("--legacy-missing-prefix-cache");
const legacyCollectionPageCache = process.argv.includes("--legacy-collection-page-cache");
assert(process.argv.slice(2).every(argument => ["--legacy-missing-prefix-cache", "--legacy-collection-page-cache"].includes(argument)), "known arguments");

if (!global.gc) {
  execFileSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
} else {
  verifyBudgetEviction();
  await verifyWeakOwnership();
  verifyQueryPages();
  verifyStudioPages();
  verifyPersonContextBudget();
  await verifyPersonContextWeakOwnership();
  await verifyMissingPrefixCache();
  await verifyCollectionPages();
  console.log("work-cache-budget: ok (weighted/count LRU, oversized pages, 48-row reuse, account/stamp isolation, weak owner GC and token cleanup, bounded person year/filter selections and source GC, bounded missing-code prefix records and keys, bounded collection pages)");
}


async function verifyMissingPrefixCache() {
  const source = readFileSync(new URL("../src/modules/fanhao/server/works/missing-code-search-service.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const changes = [
    ['import { createWeightedCacheBudget } ' + 'from ' + '"./work-cache-budget.js";\n\nconst MISSING_PREFIX_CACHE_LIMIT = 128;\nconst MISSING_PREFIX_WORK_BUDGET = 50_000;\nconst MISSING_PREFIX_MAX_KEY_LENGTH = 128;\n\nexport function', 'export function'],
    ['  // These buckets own missing-work DTOs, rather than references to the local\n  // library. Limit both their record count and request-derived metadata.\n  const prefixBudget = createWeightedCacheBudget(MISSING_PREFIX_WORK_BUDGET, MISSING_PREFIX_CACHE_LIMIT);\n  let coverWorkIdsCache', '  let coverWorkIdsCache'],
    ['    if (missingWorkIndexCache.stamp !== stamp) {\n      prefixBudget.clear();', '    if (missingWorkIndexCache.stamp !== stamp) {'],
    ['for (let length = Math.min(prefix.length, MISSING_PREFIX_MAX_KEY_LENGTH);', 'for (let length = prefix.length;'],
    ['const cached = prefixBudget.read(missingWorkIndexCache.prefixes, prefix.slice(0, length));', 'const cached = missingWorkIndexCache.prefixes.get(prefix.slice(0, length));'],
    ['    if (covers.cacheable && prefix.length <= MISSING_PREFIX_MAX_KEY_LENGTH) {\n      prefixBudget.write(missingWorkIndexCache.prefixes, prefix, entries, entries.length);\n    }', '    if (covers.cacheable) missingWorkIndexCache.prefixes.set(prefix, entries);']
  ];
  let previous = source;
  for (const [current, old] of changes) {
    assert.equal(previous.split(current).length, 2, "locate each complete old-prefix restoration slot");
    previous = previous.replace(current, old);
  }
  let restored = previous;
  for (const [current, old] of changes) restored = restored.replace(old, current);
  assert.equal(restored, source, "the complete old mechanism restores byte-for-byte; native SQL and public hydration helpers do not change");
  const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const helpers = ["storedWorkCodeKey", "dbBoolOrNull", "parseJsonArray", "uniqueTextArray", "parseJsonTextArray",
    "publicRemoteUrl", "isAllowedRemoteImageUrl", "proxiedRemoteImageUrl"];
  const functions = helpers.map(name => {
    const start = server.indexOf("function " + name + "("), body = server.indexOf(") {", start) + 2;
    assert(start >= 0 && body > start);
    let depth = 0, end = body;
    for (; end < server.length; end++) { if (server[end] === "{") depth++; else if (server[end] === "}" && --depth === 0) { end++; break; } }
    return server.slice(start, end);
  });
  const publicHelpers = new Function(functions.join("\n") + "\nreturn {" + helpers.join(",") + "};")();
  const { normalizeWorkCode } = await import("../lib/code-parser.js");
  const factory = text => {
    const slot = "  return { hydrate, prewarm, search, withReadStatus, readCacheable };";
    assert.equal(text.split(slot).length, 2);
    // Private test-only read access; no production API or mock database.
    let capturedBudget;
    const create = new Function("createWeightedCacheBudget", text.replace(/^import .*;\n/mu, "")
      .replace("export function createMissingCodeSearchService", "function createMissingCodeSearchService")
      .replace(slot, "  return { hydrate, prewarm, search, cacheState: () => missingWorkIndexCache };")
      + "\nreturn createMissingCodeSearchService;")((...args) => {
        capturedBudget = createWeightedCacheBudget(...args); return capturedBudget;
      });
    return dependencies => {
      capturedBudget = null;
      const service = create(dependencies), budget = capturedBudget;
      return { ...service, budgetState: () => budget?.diagnostics() };
    };
  };
  const currentFactory = factory(legacyMissingPrefixCache ? previous : source), previousFactory = factory(previous);
  const allDbs = [];
  let fullOracles = 0;
  function database() {
    const db = new DatabaseSync(":memory:"); allDbs.push(db);
    db.exec("PRAGMA temp_store=MEMORY;ATTACH DATABASE ':memory:' AS fanhao_images;"
      + "CREATE TABLE works(id INTEGER PRIMARY KEY,code_search TEXT,code TEXT,title TEXT,release_date TEXT,duration_minutes,rating,rating_count,has_magnet,is_streamable,has_subtitles,updated_at TEXT,status TEXT,javdb_tags_json TEXT);"
      + "CREATE INDEX fixture_code ON works(code_search);CREATE TABLE local_works(work_id INTEGER PRIMARY KEY);"
      + "CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT);CREATE TABLE work_people(work_id INTEGER,person_id INTEGER,role TEXT,sort_order INTEGER);"
      + "CREATE INDEX fixture_people ON work_people(work_id,role,sort_order,person_id);CREATE TABLE work_external_refs(work_id INTEGER,provider TEXT,url TEXT);"
      + "CREATE INDEX fixture_refs ON work_external_refs(work_id,provider);"
      + "CREATE TABLE fanhao_images.images(id INTEGER PRIMARY KEY,owner_id INTEGER,owner_type TEXT,kind TEXT,remote_url TEXT);"
      + "CREATE INDEX fanhao_images.fixture_images ON images(owner_type,owner_id,kind,id)");
    return db;
  }
  function seed(db, prefix, count, start = 1) {
    const insert = db.prepare("INSERT INTO works VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    db.exec("BEGIN");
    try {
      for (let index = 0; index < count; index++) {
        const key = prefix + String(index).padStart(6, "0");
        insert.run(start + index, key, key, "Title " + key, index % 3 ? "2026-10-01" : null,
          index % 4 ? 120 : null, index % 5 ? 4.5 : null, index % 7 ? 100 : null,
          [null, "", 0, 1, "1", "nonnumeric"][index % 6], index % 2, index % 3, "v1", "ok", '["Tag"," tag ","",null,"Other"]');
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function open(target, build = () => {}) {
    const db = database(); build(db);
    const state = { source: "s1", cover: "c1", counts: { cover: 0, prefix: 0, hydrate: 0 }, warnings: [], failure: null, before: null };
    const prepare = db.prepare.bind(db);
    db.prepare = sql => {
      const kind = sql.includes("w.javdb_tags_json") ? "hydrate" : sql.includes("w.code_search LIKE") ? "prefix"
        : sql.includes("SELECT image.owner_id") ? "cover" : null;
      if (kind && state.failure?.kind === kind && state.failure.stage === "prepare") throw state.failure.error;
      const statement = prepare(sql);
      return new Proxy(statement, { get(object, key) {
        const value = Reflect.get(object, key, object);
        if (typeof value !== "function") return value;
        if (key !== "all") return value.bind(object);
        return (...args) => {
          if (kind) state.counts[kind]++;
          if (kind && state.failure?.kind === kind && state.failure.stage === "all") throw state.failure.error;
          if (kind && state.before?.kind === kind) { const action = state.before.action; state.before = null; action(); }
          return value.apply(object, args);
        };
      } });
    };
    const service = target({ ...publicHelpers, normalizeWorkCode, getCoreDb: () => db,
      getSourceStamp: () => state.source, getCoverStamp: () => state.cover,
      warn: (...args) => state.warnings.push(args) });
    return { db, state, service, snapshot() {
      const map = service.cacheState().prefixes;
      return { entries: map.size, records: [...map.values()].reduce((sum, rows) => sum + rows.length, 0),
        keys: [...map.keys()], stamp: service.cacheState().stamp, budget: service.budgetState() };
    } };
  }
  function pair(build) {
    return { old: open(previousFactory, build), current: open(currentFactory, build) };
  }
  function each(pair, action) { action(pair.old); action(pair.current); }
  function compare(pair, query, hydrate = true) {
    const result = owner => {
      const works = owner.service.search(query);
      if (hydrate) owner.service.hydrate(works.slice(0, 48));
      return { total: works.length, works };
    };
    const before = result(pair.old), after = result(pair.current);
    assert.deepEqual(after, before, "complete missing-code search/hydrate DTO: " + String(query));
    assert.equal(JSON.stringify(after), JSON.stringify(before)); fullOracles++;
    return after;
  }
  const base = db => {
    seed(db, "abf", 6);
    db.exec("UPDATE works SET code_search='abf387',code='ABF-387',title='ABF-387' WHERE id IN(1,3);"
      + "UPDATE works SET code_search='abf388',code='ABF-388' WHERE id IN(2,4);"
      + "UPDATE works SET status='missing' WHERE id=6;INSERT INTO local_works VALUES(2);"
      + "INSERT INTO people VALUES(10,'演员甲'),(20,'演员乙');"
      + "INSERT INTO work_people VALUES(1,20,'actor',5),(1,10,'actor',1),(1,20,'director',0);"
      + "INSERT INTO work_external_refs VALUES(1,'javdb-video','https://javdb.com/v/synthetic'),(1,'other','file:///private');"
      + "INSERT INTO fanhao_images.images VALUES(1,1,'work','cover','https://jdbstatic.com/synthetic.jpg'),(2,5,'work','sample','https://example.invalid/sample');");
  };
  try {
    const ordinary = pair(base);
    for (const query of ["", null, "!!!", "ab", "ABF-387", "abf388", " ABF.000004 ", "not-present", "abf"])
      compare(ordinary, query);
    const first = compare(ordinary, "abf387");
    assert.equal(first.works[0].personId, "10"); assert.equal(first.works[0].searchHasCover, true);
    assert(first.works[0].remoteCoverUrl.startsWith("/media/remote-image?"));
    assert(compare(ordinary, "abf388").works.length === 0, "a local code excludes every duplicate canonical row");
    each(ordinary, owner => {
      const before = owner.state.counts.prefix;
      const broad = owner.service.search("ab"), narrow = owner.service.search("abf387");
      assert.equal(owner.state.counts.prefix, before, "a shorter admitted ancestor shares its native prefix query");
      assert.strictEqual(narrow[0], broad.find(work => work.id === narrow[0].id), "stable owner retains its actual owned work objects");
    });
    for (const [kind, stage] of [["prefix", "prepare"], ["prefix", "all"], ["hydrate", "all"], ["cover", "all"]]) {
      each(ordinary, owner => {
        owner.state.source += "e"; owner.state.cover += "e";
        owner.state.failure = { kind, stage, error: new Error("held native " + kind + "/" + stage) };
      });
      compare(ordinary, "abf387"); each(ordinary, owner => { owner.state.failure = null; });
      compare(ordinary, "abf387");
      assert.deepEqual(ordinary.current.state.warnings, ordinary.old.state.warnings, "SQL errors preserve warn/fallback/retry behavior");
    }
    each(ordinary, owner => {
      owner.db.prepare("UPDATE works SET title='published metadata' WHERE id=1").run();
      owner.state.source += "published";
      owner.db.prepare("INSERT INTO fanhao_images.images VALUES(3,5,'work','cover','https://jdbstatic.com/new.jpg')").run();
      owner.state.cover += "published";
    });
    assert.equal(compare(ordinary, "ab").works.find(work => work.id === "1").title, "published metadata");
    each(ordinary, owner => { owner.db.prepare("INSERT INTO local_works VALUES(1)").run(); owner.state.source += "local"; });
    assert.equal(compare(ordinary, "abf387").total, 0);
    each(ordinary, owner => {
      owner.state.source += "race";
      owner.state.before = { kind: "prefix", action() {
        owner.db.prepare("UPDATE works SET title='race publication' WHERE id=5").run(); owner.state.source += "next";
      } };
    });
    compare(ordinary, "ab");
    const raceReads = ordinary.current.state.counts.prefix;
    compare(ordinary, "ab");
    assert.equal(ordinary.current.state.counts.prefix, raceReads + 1, "the next request observes a stamp changed during the prior synchronous read");
    const pressure = pair(base);
    for (const query of ["seed0", "seed1", "seed2"]) compare(pressure, query, false);
    for (let index = 0; index < 2000; index++) compare(pressure, "empty" + String(index).padStart(6, "0"), false);
    const metadata = { old: pressure.old.snapshot(), current: pressure.current.snapshot() };
    const lru = pair();
    for (let index = 0; index < 128; index++) compare(lru, "lru" + String(index).padStart(3, "0"), false);
    compare(lru, "lru000", false); compare(lru, "lru128", false);
    const lruState = lru.current.snapshot();
    const weighted = pair(db => { for (let index = 0; index < 5; index++) seed(db, "batch" + index, 12000, 1 + index * 12000); });
    for (let index = 0; index < 5; index++) assert.equal(compare(weighted, "batch" + index).total, 12000);
    const rows = { old: weighted.old.snapshot(), current: weighted.current.snapshot() };
    const large = pair(db => seed(db, "big", 50001));
    compare(large, "empty-sentinel", false);
    assert.equal(compare(large, "big").total, 50001); assert.equal(compare(large, "big").total, 50001);
    const oversized = large.current.snapshot();
    const longKey = "long" + "x".repeat(136);
    const long = pair(db => seed(db, longKey, 2));
    assert.equal(compare(long, longKey).total, 2); compare(long, longKey);
    const uncachedLong = long.current.snapshot(), uncachedLongReads = long.current.state.counts.prefix;
    compare(long, longKey.slice(0, 128)); const longReads = long.current.state.counts.prefix;
    compare(long, longKey);
    assert.equal(long.current.state.counts.prefix, longReads, "overlength queries can still reuse a short admitted ancestor");
    const fresh = pair(base);
    compare(fresh, "abf387");
    assert.notStrictEqual(fresh.current.service.cacheState().prefixes, ordinary.current.service.cacheState().prefixes,
      "independent injected service owners do not share prefix maps");
    // All native complete-response/hydration/error/stamp/race checks precede
    // the old implementation's capacity failure, never a missing hook.
    console.log(JSON.stringify({ missingPrefixOracles: fullOracles, nativeConnections: allDbs.length,
      formerBuckets: metadata.old.entries, buckets: metadata.current.entries,
      formerRecords: rows.old.records, records: rows.current.records, oversizedReturned: 50001,
      oversizedCachedRecords: oversized.records, uncachedLongKeys: uncachedLong.entries }));
    assert.equal(metadata.old.entries, 2003, "the complete old mechanism accumulates every empty-prefix metadata key");
    assert.equal(rows.old.records, 60000, "five actual native buckets own sixty thousand distinct records");
    assert.equal(metadata.current.entries, 128, "missing-prefix metadata budget: at most 128 buckets are retained");
    assert.equal(rows.current.records, 48000, "missing-prefix owned-record budget: the oldest 12000-row bucket is evicted");
    assert.equal(metadata.current.budget.entries, 128); assert.equal(metadata.current.budget.weight, 0);
    assert.equal(rows.current.budget.entries, 4); assert.equal(rows.current.budget.weight, 48000);
    assert(lruState.keys.includes("lru000") && !lruState.keys.includes("lru001"), "native cache hits touch the global and owner LRU");
    assert.equal(oversized.records, 0, "a 50001-row result stays complete without any cached DTO ownership");
    assert.equal(oversized.entries, 1, "oversized results preserve an existing empty sentinel bucket");
    assert.equal(uncachedLong.entries, 0, "a genuine 140-character request/result does not retain a metadata key");
    assert.equal(uncachedLongReads, 2, "two oversized-key reads each execute the actual native prefix SQL");
    assert(long.current.snapshot().keys.every(key => key.length <= 128));
    each(ordinary, owner => { owner.state.source += "reset"; owner.service.search("empty-final"); });
    assert.equal(ordinary.current.snapshot().entries, 1, "a source stamp change releases all old buckets before the new admission");
    assert.equal(ordinary.current.snapshot().budget.entries, 1); assert.equal(ordinary.current.snapshot().budget.weight, 0);
  } finally {
    for (const db of allDbs) { db.close(); assert.equal(db.isOpen, false, "every private native SQLite owner is closed"); }
  }
}


async function verifyCollectionPages() {
  const source = readFileSync(new URL("../src/modules/fanhao/server/user-state/collection-query-service.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  // Restore the complete preceding page read/write mechanism. DTO assembly,
  // source reads, prewarming, work-payload LRU and stamp checks stay actual.
  const changes = [
    ['import { createWeightedCacheBudget } from ' + JSON.stringify("../works/work-cache-budget.js") + ';\n\n', ""],
    ["const COLLECTION_PAGE_WORK_BUDGET = 4096;\n", ""],
    ["  const pageBudget = createWeightedCacheBudget(COLLECTION_PAGE_WORK_BUDGET);\n", ""],
    [
      ["  function readPage(cacheKey) {", "    ensureCache();", "    return pageBudget.read(pageCache, cacheKey) || null;", "  }"].join("\n"),
      ["  function readPage(cacheKey) {", "    ensureCache();", "    if (!pageCache.has(cacheKey)) return null;", "    const cached = pageCache.get(cacheKey);", "    pageCache.delete(cacheKey);", "    pageCache.set(cacheKey, cached);", "    return cached;", "  }"].join("\n")
    ],
    [
      ["  function cachePage(cacheKey, payload) {", "    if (workInfoReadCacheable() === false) return payload;", "    ensureCache();", "    return pageBudget.write(pageCache, cacheKey, payload, payload.works.length, COLLECTION_PAGE_CACHE_LIMIT);", "  }"].join("\n"),
      ["  function cachePage(cacheKey, payload) {", "    if (workInfoReadCacheable() === false) return payload;", "    ensureCache();", "    pageCache.set(cacheKey, payload);", "    while (pageCache.size > COLLECTION_PAGE_CACHE_LIMIT) {", "      pageCache.delete(pageCache.keys().next().value);", "    }", "    return payload;", "  }"].join("\n")
    ],
    ["    cacheStamp = nextStamp;\n    pageBudget.clear();", "    cacheStamp = nextStamp;"]
  ];
  let previous = source;
  for (const [current, old] of changes) {
    assert.equal(previous.split(current).length, 2, "the complete collection page source hook exists once");
    previous = previous.replace(current, old);
  }
  let restored = previous;
  for (const [current, old] of changes.slice().reverse()) {
    if (old) restored = restored.replace(old, current);
    else if (current.startsWith("import ")) restored = current + restored;
    else if (current.startsWith("const ")) restored = restored.replace("const COLLECTION_PAGE_CACHE_LIMIT = 64;\n", "const COLLECTION_PAGE_CACHE_LIMIT = 64;\n" + current);
    else restored = restored.replace('  let cacheStamp = "";', current + '  let cacheStamp = "";');
  }
  assert.equal(restored, source, "the whole preceding mechanism reverses to the current module exactly");
  const slot = "    favoritesPayload,\n    historyPayload,\n    prewarm";
  function factory(text) {
    let budget;
    const create = new Function("createWeightedCacheBudget", text.replace(/^import .*;\n/gmu, "")
      .replaceAll("export function ", "function ")
      .replace(slot, slot + ",\n    cacheState: () => ({ pageCache, workPayloadCache })")
      + "\nreturn createCollectionQueryService;")((...args) => {
      budget = createWeightedCacheBudget(...args);
      return budget;
    });
    return deps => {
      budget = null;
      const service = create(deps);
      const ownedBudget = budget;
      return { ...service, budgetState: () => ownedBudget?.diagnostics() };
    };
  }
  const priorFactory = factory(previous);
  const currentFactory = factory(legacyCollectionPageCache ? previous : source);
  let oracles = 0, errors = 0;
  function owner(create, count) {
    const works = Array.from({ length: count }, (_, index) => ({ id: "collection-" + index, name: "Work " + index, rating: index % 5 }));
    const state = { user: "alice", work: "one", failure: null, failAfter: 0, publics: 0, trace: false, events: [] };
    const library = { scannedAt: "scan-one", worksById: new Map(works.map(work => [work.id, work])) };
    function event(name, value) {
      if (state.trace) state.events.push([name, value]);
      if (name === "public") state.publics++;
      if (state.failure?.stage === name && (!state.failAfter || state.publics === state.failAfter)) throw state.failure.error;
      return value;
    }
    const deps = {
      clampInteger: (value, fallback, min, max) => Math.max(min, Math.min(max,
        value === null || value === "" ? fallback : Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback)),
      favoriteStateService: {
        normalizeFavoriteFolderId: value => event("folder", value === "old" ? "default" : value),
        favoriteWorks: id => event("source", id === "empty" ? [] : works),
        publicFavoriteFolders: () => event("folders", [{ id: "default", name: "默认", count: works.length }])
      },
      getLibrary: () => event("library", library), maxWorkLimit: 16000, recentWatchedDays: 30,
      playbackProgressService: { historyEntries: () => event("source", works.map(work => ({ work }))) },
      filterWorkList: (list, filter) => event("filter", filter === "high" ? list.filter(work => work.rating >= 3) : list),
      sortWorkList: (list, sort) => event("sort", sort === "rating" ? [...list].sort((a, b) => b.rating - a.rating) : list),
      workFacets: list => event("facets", { all: list.length, high: list.filter(work => work.rating >= 3).length }),
      userStateStamp: () => event("userStamp", state.user), workQueryStamp: () => event("workStamp", state.work),
      prewarmCoreWorkCovers: list => event("cover", list.length),
      prewarmVideoProbesForWorks: list => event("probe", list.length),
      prewarmWorkInfoDetails: list => event("info", list.length),
      prewarmRemoteImagesForWorks: list => event("remote", list.length),
      publicWork: work => {
        event("public", work.id);
        return { id: work.id, name: work.name, rating: work.rating, user: state.user, work: state.work };
      }
    };
    return { service: create(deps), deps, state, works, library };
  }
  const pair = count => ({ prior: owner(priorFactory, count), current: owner(currentFactory, count) });
  const url = params => new URL("http://fixture/api/collection?" + new URLSearchParams(params));
  const read = (target, method, params) => target.service[method](url(params));
  function compare(targets, method, params = {}) {
    const old = read(targets.prior, method, params), current = read(targets.current, method, params);
    assert.deepEqual(current, old, "complete collection response");
    assert.equal(JSON.stringify(current), JSON.stringify(old), "complete collection JSON");
    oracles++;
    return { old, current };
  }
  function snapshot(target) {
    const { pageCache, workPayloadCache } = target.service.cacheState();
    const pages = [...pageCache.values()], works = [...workPayloadCache.values()];
    return {
      entries: pages.length, references: pages.reduce((sum, page) => sum + page.works.length, 0),
      workEntries: works.length, unique: new Set([...works, ...pages.flatMap(page => page.works)]).size,
      keys: [...pageCache.keys()], budget: target.service.budgetState()
    };
  }
  for (const size of [0, 1, 48, 4096, 20000]) {
    const targets = pair(size);
    const cases = [{}, { limit: 8 }, { limit: 48, offset: 48 }, { limit: 64, offset: 96 },
      { filter: "high", sort: "rating", limit: 200, offset: 8 }, { folder: "empty", days: "all" },
      { folder: "old", limit: "bad", offset: -1 }, { limit: 0, offset: 20 }, { limit: 16000, offset: 1 },
      { days: 7, limit: 48 }, { days: "all", limit: 48 }, { days: "bad", limit: 48 }];
    for (const method of ["favoritesPayload", "historyPayload"]) for (const params of cases) compare(targets, method, params);
    for (const [key, value] of [["user", "bob"], ["work", "two"]]) {
      targets.prior.state[key] = targets.current.state[key] = value;
      compare(targets, "historyPayload", { limit: 48 });
    }
    targets.prior.library.scannedAt = targets.current.library.scannedAt = "scan-two";
    compare(targets, "favoritesPayload", { limit: 64 });
    for (const target of Object.values(targets)) {
      const first = read(target, "historyPayload", { limit: 48, offset: 600 });
      assert.equal(read(target, "historyPayload", { limit: 48, offset: 600 }), first, "ordinary pages retain their object identity");
    }
    // Compare against the actual exported owner, not only the private inspection facade.
    const actual = owner(createCollectionQueryService, size);
    assert.equal(JSON.stringify(read(actual, "favoritesPayload", { limit: 48 })),
      JSON.stringify(read(owner(currentFactory, size), "favoritesPayload", { limit: 48 })));
    oracles++;
  }
  for (const stage of ["folder", "library", "workStamp", "userStamp", "source", "filter", "sort", "facets", "cover", "probe", "info", "public", "remote", "folders"]) {
    const targets = pair(64), error = new Error("held collection " + stage);
    for (const target of Object.values(targets)) {
      target.state.trace = true;
      target.state.failure = { stage, error };
      assert.throws(() => read(target, "favoritesPayload", { folder: "old", filter: "high", sort: "rating", limit: 48 }), caught => caught === error);
      assert.equal(snapshot(target).entries, 0, "a failed request cannot publish a partial page");
    }
    assert.deepEqual(targets.current.state.events, targets.prior.state.events, "ordinary failure call order remains");
    errors++;
    for (const target of Object.values(targets)) target.state.failure = null;
    compare(targets, "favoritesPayload", { folder: "old", filter: "high", sort: "rating", limit: 48 });
  }
  const partial = pair(64), partialError = new Error("held fifth public work");
  for (const target of Object.values(partial)) {
    target.state.failure = { stage: "public", error: partialError };
    target.state.failAfter = 5;
    assert.throws(() => read(target, "historyPayload", { limit: 48 }), error => error === partialError);
    assert.equal(snapshot(target).entries, 0);
    assert.equal(snapshot(target).workEntries, 4, "previous successfully prepared works retain the original request behavior");
    target.state.failure = null;
  }
  compare(partial, "historyPayload", { limit: 48 });
  errors++;
  const ordinary = pair(20000);
  const first = compare(ordinary, "favoritesPayload", { limit: 64, offset: 0 });
  for (let index = 1; index < 64; index++) compare(ordinary, index % 2 ? "favoritesPayload" : "historyPayload", { limit: 64, offset: index * 64, days: index + 1 });
  assert.equal(read(ordinary.current, "favoritesPayload", { limit: 64, offset: 0 }), first.current);
  assert.equal(read(ordinary.prior, "favoritesPayload", { limit: 64, offset: 0 }), first.old);
  compare(ordinary, "historyPayload", { limit: 64, offset: 64 * 64, days: 100 });
  assert.deepEqual(snapshot(ordinary.current).keys, snapshot(ordinary.prior).keys, "both LRUs touch the original page keys");
  compare(ordinary, "favoritesPayload", { limit: 16000 });
  assert.equal(read(ordinary.current, "favoritesPayload", { limit: 64, offset: 0 }), first.current, "an oversized request preserves ordinary pages");
  const normal = snapshot(ordinary.current);
  const large = pair(20000);
  for (let index = 0; index < 8; index++) compare(large, index % 2 ? "favoritesPayload" : "historyPayload",
    { limit: 16000, offset: index, sort: index % 2 ? "rating" : "", days: index + 1 });
  const retained = { prior: snapshot(large.prior), current: snapshot(large.current) };
  const empty = pair(0);
  for (let index = 0; index < 100; index++) compare(empty, "historyPayload", { days: index + 1, limit: 64 });
  assert.deepEqual(snapshot(empty.current).keys, snapshot(empty.prior).keys);
  const retired = ordinary.current.service.cacheState().pageCache;
  ordinary.prior.state.user = ordinary.current.state.user = "carol";
  compare(ordinary, "favoritesPayload", { limit: 64, offset: 0 });
  const reset = snapshot(ordinary.current);
  for (const endpoint of ["favorites", "history"]) {
    async function route(target) {
      let response;
      assert.equal(await routeUserStateApi({ method: "GET" }, {}, new URL("http://fixture/api/" + endpoint + "?limit=48"), {
        collectionQueryService: target.service,
        sendJson(_res, status, payload) { response = { status, payload }; }
      }), true);
      return response;
    }
    const targets = pair(64);
    assert.equal(JSON.stringify(await route(targets.current)), JSON.stringify(await route(targets.prior)));
    oracles++;
  }
  console.log(JSON.stringify({ collectionPageBudget: { oracles, errors, oldPageReferences: retained.prior.references,
    pageReferences: retained.current.references, oldUniqueDtos: retained.prior.unique, uniqueDtos: retained.current.unique,
    ordinaryPages: normal.entries, ordinaryReferences: normal.references, emptyPages: snapshot(empty.current).entries } }));
  // All DTOs, errors, retries, stamps, routes and ordinary LRU comparisons
  // precede the former mechanism's genuine retained-reference budget.
  assert.equal(retained.prior.references, 128000, "eight original large pages retain their complete work arrays");
  assert.equal(retained.current.references, 0, "collection page owned-work reference budget");
  assert.equal(retained.current.unique, 4096);
  assert.equal(retained.current.workEntries, 4096, "the independent work-payload limit remains");
  assert.equal(normal.entries, 64);
  assert.equal(normal.references, 4096);
  assert.equal(normal.budget.weight, 4096);
  assert.equal(snapshot(empty.current).entries, 64);
  assert.equal(snapshot(empty.current).budget.weight, 0, "zero-weight pages still obey the count limit");
  assert.equal(retired.size, 0, "a changed original stamp releases retired page ownership");
  assert.equal(reset.budget.entries, 1);
  assert.equal(reset.budget.weight, 64);
}


function personContextQuery() {
  const source = readFileSync(new URL("../src/modules/fanhao/server/works/work-query-service.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "").replace("export function createWorkQueryService", "function createWorkQueryService");
  let sharedBudget;
  const factory = new Function("classifyWorkCategory", "normalizeWorkCategory", "summarizeWorkCategories", "WORK_CATEGORY_OPTIONS",
    "createWorkSorter", "createWeightedCacheBudget", "normalizeWorkSortMode", source + "\nreturn createWorkQueryService;")(
    classifyWorkCategory, normalizeWorkCategory, summarizeWorkCategories, WORK_CATEGORY_OPTIONS, createWorkSorter,
    (...args) => {
      const value = createWeightedCacheBudget(...args);
      if (args[0] === 4_000_000) sharedBudget = value;
      return value;
    }, normalizeWorkSortMode);
  let classifications = 0;
  const classification = createWorkClassificationService({ appConfigService: { current: () => ({}) } });
  const filter = classification.filterForRequest;
  classification.filterForRequest = (works, ...args) => { classifications += works.length; return filter(works, ...args); };
  const service = factory({
    library: { worksById: new Map() }, actorMovieStamp: () => "fixture", workQueryStamp: () => "fixture",
    peoplePayloadStamp: () => "fixture", userStateStamp: () => "alice:fixture", workClassificationService: classification,
    clampInteger, defaultWorkLimit: 1, maxWorkLimit: 16000,
    publicWork: (work) => ({ id: work.id }), prewarmRemoteImagesForWorks: () => {}
  });
  const extra = { facets: {} };
  function call(works, context, offset = 0, filter = "all") {
    return service.listFromWorksPayload(works, new URL("http://fixture/?limit=1&sort=updated&offset=" + offset + "&filter=" + filter),
      extra, { lightweightInfo: true }, context);
  }
  return { call, budget: sharedBudget, classifications: () => classifications };
}

function verifyPersonContextBudget() {
  const fixture = personContextQuery();
  const work = { id: "one", title: "Fixture", coverId: "fixture" };
  const source = Array(20_000).fill(work);
  const context = { cache: new Map(), key: "first" };
  fixture.call(source, context);
  assert.equal(context.cache.size, 1);
  assert.equal(context.cache.get("first").sourceWorks, source, "the cached year source retains its exact identity");
  assert.equal(fixture.budget.diagnostics().weight, 60_000, "both 20000-row year/filter arrays and the existing sorted array count toward the 4m budget");
  const before = fixture.classifications();
  fixture.call(source, context, 1);
  assert.equal(fixture.classifications(), before, "a later offset reuses the admitted filter identity");
  assert.equal(fixture.budget.diagnostics().weight, 60_000, "cache hits do not register duplicate derived weights");
  context.key = "second"; fixture.call(source, context, 2);
  assert.equal(context.cache.size, 1, "one person source cannot retain every request/year selection");
  assert.ok(!context.cache.has("first"));
  const unknown = { cache: new Map(), key: "unknown" };
  fixture.call(source, unknown, 3, "unknown-filter");
  assert.equal(unknown.cache.size, 0, "unrecognized filters remain outside person source caching");
  const contexts = [];
  for (let index = 0; index < 80; index++) {
    const next = { cache: new Map(), key: String(index) };
    contexts.push(next); fixture.call(Array(20_000).fill(work), next);
    assert.ok(fixture.budget.diagnostics().weight <= 4_000_000, "all retained person arrays share the existing global reference cap");
  }
  assert.ok(contexts.some((next) => next.cache.size === 0), "the shared budget must evict person selections across owners");
  assert.equal(fixture.budget.diagnostics().maxWeight, 4_000_000);
}

async function verifyPersonContextWeakOwnership() {
  const fixture = personContextQuery();
  const work = { id: "weak-fixture", title: "Fixture", coverId: "fixture" };
  const refs = [];
  function register() {
    const source = [work];
    const context = { cache: new Map(), key: "selection" };
    fixture.call(source, context);
    return [new WeakRef(source), new WeakRef(context.cache)];
  }
  for (let index = 0; index < 200; index++) refs.push(...register());
  assert.equal(fixture.budget.diagnostics().weight, 600);
  await immediate(); global.gc(); await immediate(); global.gc();
  assert.ok(refs.every((ref) => !ref.deref()), "person context/year arrays must be released when their source owner disappears");
  assert.equal(fixture.budget.diagnostics().entries, 0, "collected person selections and their sorted WeakMap owners leave no budget registry");
  assert.equal(fixture.budget.diagnostics().weight, 0);
}

function verifyBudgetEviction() {
  const budget = createWeightedCacheBudget(10, 4);
  const a = new Map(), b = new Map();
  const write = (owner, key, weight, limit) => budget.write(owner, key, { key }, weight, limit);
  write(a, "old", 4); write(b, "recent", 4);
  budget.read(a, "old"); write(b, "new", 4);
  assert.ok(a.has("old")); assert.ok(!b.has("recent"), "global LRU touches span all owners");
  assert.equal(budget.diagnostics().weight, 8);
  write(a, "old", 1);
  assert.equal(budget.diagnostics().weight, 5, "replacement unregisters the previous weight");
  write(a, "large", 11);
  assert.ok(!a.has("large")); assert.equal(budget.diagnostics().weight, 5);
  write(a, "first", 1, 2); write(a, "second", 1, 2);
  assert.ok(!a.has("old"), "per-owner count eviction unregisters shared weight and token");
  assert.equal(budget.diagnostics().weight, 6);
  b.delete("new");
  assert.equal(budget.diagnostics().weight, 2, "direct owner invalidation is reconciled by sweep");
  budget.clear(a); assert.equal(budget.diagnostics().entries, 0);
  for (let i = 0; i < 10; i++) write(a, String(i), 0);
  assert.equal(a.size, 4, "zero-row results still have a metadata entry limit");
  assert.equal(budget.diagnostics().entries, 4);
  budget.clear(); assert.equal(a.size, 0); assert.equal(budget.diagnostics().weight, 0);
  assert.equal(normalizeWorkSortMode("ranking"), "updated");
  assert.equal(normalizeWorkSortMode("size"), "sizeDesc");
}

async function verifyWeakOwnership() {
  const budget = createWeightedCacheBudget(100_000);
  const sortedBySource = new WeakMap();
  const refs = [];
  function register(index) {
    const source = [{ id: index }];
    const owner = new Map();
    sortedBySource.set(source, owner);
    budget.write(owner, "updated", { works: [...source] }, 1);
    return new WeakRef(source);
  }
  for (let index = 0; index < 2000; index++) refs.push(register(index));
  assert.equal(budget.diagnostics().entries, 2000);
  await immediate(); global.gc(); await immediate(); global.gc();
  assert.ok(refs.every((ref) => !ref.deref()), "the global eviction index must not keep WeakMap source keys alive");
  assert.equal(budget.diagnostics().entries, 0, "reclaimed weak owners must not leave an accumulating token registry");
  assert.equal(budget.diagnostics().weight, 0);
}

function fixtureWorks() {
  return Array.from({ length: 20_000 }, (_, index) => ({ id: String(index), title: `Fixture ${index}`, modifiedAt: String(index), playableCount: 1 }));
}

function verifyQueryPages() {
  const works = fixtureWorks();
  let user = "alice", stamp = "one";
  const service = createWorkQueryService({
    library: { worksById: new Map(works.map((work) => [work.id, work])) },
    actorMovieStamp: () => "fixture", actorMissingSearchWorks: () => [],
    clampInteger, defaultWorkLimit: 48, maxWorkLimit: 16000,
    enrichLocalWorksWithActorMovieIndex: (items) => items,
    favoriteStateService: { isFavoriteWork: () => false }, playbackProgressService: { getWorkProgress: () => null },
    isVrWork: () => false, workHasCoreCover: () => false, workInfoFacetRow: () => null,
    peopleScopeService: { normalize: () => "main", workMatches: (_work, scope) => scope === "main" },
    publicWork: (work) => ({ id: work.id, owner: user }), prewarmRemoteImagesForWorks: () => {},
    publicWorkAvailability: () => ({}), workQueryStamp: () => stamp, userStateStamp: () => user,
    localWorksByCodePrefix: () => works, fastMissingCodeSearch: () => [], storedWorkCodeKey: (value) => value,
    dedupeWorksForDisplay: (items) => items
  });
  for (const [mode, count] of [["list", 96], ["search", 192]]) {
    const call = (offset, limit = 48) => service[mode === "list" ? "listPayload" : "searchPayload"](new URL(`http://fixture/api/works?q=AB&sort=updated&limit=${limit}&offset=${offset}`));
    const first = call(0);
    for (let index = 1; index < count; index++) assert.equal(call(index * 48).count, 48);
    assert.equal(call(0), first, `${mode} retains every normal 48-row page up to its existing count limit`);
    const large = call(0, 16000);
    assert.equal(large.count, 16000); assert.equal(large.limit, 16000); assert.equal(large.total, 20000);
    assert.notEqual(call(0, 16000), large, `${mode} keeps the API limit but bypasses caching for an oversized page`);
    assert.equal(call(0), first, `${mode} an uncached large page does not evict normal page responses`);
    user += "-next";
    assert.notEqual(call(0), first, `${mode} page reuse does not cross user state`);
    stamp += "-next";
    const refreshed = call(0);
    assert.equal(refreshed.works[0].owner, user, "a fresh source stamp rebuilds DTO state");
  }
}

function verifyStudioPages() {
  const works = fixtureWorks();
  let stamp = "one", owner = "alice", sortedCalls = 0;
  const service = createStudioService({
    clampInteger, getLibrary: () => ({ worksById: new Map(works.map((work) => [work.id, work])) }), getStamp: () => stamp,
    getCoreDb: () => ({ prepare(sql) {
      if (sql.includes("SELECT COUNT(*) FROM makers")) return { get: () => ({ maker_count: 1 }) };
      if (sql.includes("FROM makers m")) return { get: () => ({ maker_id: "1", name: "fixture" }) };
      if (sql.includes("FROM series s")) return { all: () => [] };
      if (sql.includes("FROM work_makers wm")) return { all: () => works.map((work) => ({ work_id: work.id })) };
      throw new Error(sql);
    } }), publicRemoteUrl: (value) => value, userStateStamp: () => owner,
    sortWorkList: (items) => { sortedCalls++; return [...items]; }, workFacets: (items) => ({ all: items.length }),
    pagedWorksPayload(items, url, extra) {
      const limit = clampInteger(url.searchParams.get("limit"), 48, 1, 16000), offset = Number(url.searchParams.get("offset"));
      const page = items.slice(offset, offset + limit).map((work) => ({ id: work.id, owner }));
      return { ...extra, count: page.length, limit, offset, total: items.length, works: page };
    }
  });
  const call = (offset, limit = 48) => service.detailPayload("1", new URL(`http://fixture/api/studios/1?limit=${limit}&offset=${offset}&sort=updated`));
  const first = call(0);
  for (let index = 1; index < 256; index++) assert.equal(call(index * 48).count, 48);
  assert.equal(call(0), first, "studio preserves all 256 normal pages under its row budget");
  const large = call(0, 16000); assert.equal(large.count, 16000); assert.equal(large.limit, 16000);
  assert.notEqual(call(0, 16000), large); assert.equal(call(0), first);
  owner = "bob"; assert.equal(call(0).works[0].owner, "bob");
  const before = sortedCalls; stamp = "two"; call(0);
  assert.equal(sortedCalls, before + 1, "source stamp clears the previous weighted derivations");
  service.invalidate(); const again = call(0); assert.notEqual(again, first);
}
