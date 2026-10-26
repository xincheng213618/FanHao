import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createWorkSearchIndexService } from "../../src/modules/fanhao/server/works/work-search-index-service.js";
import { createMissingCodeSearchService } from "../../src/modules/fanhao/server/works/missing-code-search-service.js";
import { createWeightedCacheBudget } from "../../src/modules/fanhao/server/works/work-cache-budget.js";
import { createWorkQueryService } from "../../src/modules/fanhao/server/works/work-query-service.js";
import { createWorkFilterService } from "../../src/modules/fanhao/server/works/work-filter-service.js";
import { createCodePrefixService } from "../../src/modules/fanhao/server/catalog/code-prefix-service.js";
import { createFanhaoDependencies } from "../../src/modules/fanhao/server/composition.js";
import { createWorkInfoCacheFixture, codeKey, parseJson, clampInteger } from "./work-info-cache-recovery.mjs";

// Exact pre-fix engines, captured before this change. The control restores
// their SQL, map admission, text/gram caching and prefix/hydration algorithms.
function legacyFactory(file, hash, name) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  assert.equal(createHash("sha256").update(source).digest("hex"), hash, "complete legacy source fingerprint");
  return new Function("createWeightedCacheBudget", source.replace(/^import .*;\n/mu, "")
    .replace(`export function ${name}`, `function ${name}`) + `\nreturn ${name};`)(createWeightedCacheBudget);
}
const legacyText = legacyFactory("./work-search-cache-legacy.txt", "3fb6035273bbbb22a0dd951d1392a5075ffa4f69e258c9f28bb9310f4531539e", "createWorkSearchIndexService");
const legacyMissing = legacyFactory("./missing-code-search-cache-legacy.txt", "412c93ac4f2e218970ca9d558642d90fb3716fb66ac17786bebafa09d63ad690", "createMissingCodeSearchService");

function serverFunction(name) {
  const source = readFileSync(new URL("../../server.js", import.meta.url), "utf8");
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `actual server ${name} adapter exists`);
  const body = source.indexOf(") {", start) + 2;
  let depth = 0, end = body;
  for (; end < source.length; end++) {
    if (source[end] === "{") depth++;
    else if (source[end] === "}" && --depth === 0) { end++; break; }
  }
  return source.slice(start, end);
}

function statusAdapter(service) {
  return { ...service, withReadStatus: service.withReadStatus || (callback => ({ value: callback(), cacheable: true })),
    readCacheable: service.readCacheable || (() => true) };
}

export function createWorkSearchCacheFixture({ legacy = false, connectConsumers = true, count = 6, localCount = 2 } = {}) {
  const base = createWorkInfoCacheFixture({ count });
  const state = { ...base.state, counts: { text: 0, actors: 0, makers: 0, series: 0, cover: 0, prefix: 0, hydrate: 0 },
    failure: null, warnings: [], onRead: null };
  base.state.db.exec(`DELETE FROM local_works WHERE work_id > ${localCount};
    UPDATE works SET title=title||' needle phrase',raw_text=raw_text||' raw phrase';
    INSERT INTO makers VALUES(2,'Label phrase','labelphrase','fixture');
    INSERT INTO work_makers VALUES(1,2,'label');
    UPDATE people SET name='Actor phrase';`);
  base.works.splice(localCount);
  for (const work of base.works) { work.code = `AA-${work.id.padStart(3, "0")}`; work.directoryName = work.code; }
  for (const [id] of base.library.worksById) if (Number(id) > localCount) base.library.worksById.delete(id);
  base.person.works = base.works.map(work => work.id);
  base.person.workCount = localCount;
  const owners = new WeakMap();
  function getCoreDb() {
    if (owners.has(state.db)) return owners.get(state.db);
    const db = state.db;
    const owner = { prepare(sql) {
      const reader = sql.includes("SELECT image.owner_id") ? "cover" : sql.includes("w.code_search LIKE") ? "prefix"
        : sql.includes("w.javdb_tags_json") ? "hydrate" : sql.includes("FROM work_people wp\n") ? "actors"
          : sql.includes("FROM work_makers wm\n") ? "makers" : sql.includes("FROM work_series ws\n") ? "series" : "text";
      state.counts[reader]++;
      failed(reader, "prepare");
      const statement = db.prepare(sql);
      return new Proxy(statement, { get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        if (key !== "all") return value.bind(target);
        return (...params) => { failed(reader, "all", params); return value.apply(target, params); };
      } });
    } };
    owners.set(db, owner);
    return owner;
  }
  function failed(reader, phase, params = []) {
    state.onRead?.(reader, phase, params);
    const failure = state.failure;
    if (!failure || failure.reader !== reader || failure.phase !== phase
      || (failure.at && failure.at !== state.counts[reader])) return;
    if (failure.once) state.failure = null;
    throw Object.assign(new Error(`controlled ${reader} ${phase} failure`), { code: "SQLITE_BUSY" });
  }
  const text = statusAdapter((legacy ? legacyText : createWorkSearchIndexService)({ getCoreDb,
    getLibrary: () => base.library, getSourceStamp: () => state.stamp, getWorkInfoStamp: () => state.stamp,
    normalizeSearchValue: codeKey, parseJsonArray: parseJson, parseJsonTextArray: parseJson }));
  const missingOptions = { getCoreDb,
    getCoverStamp: () => state.stamp, getSourceStamp: () => state.stamp, normalizeWorkCode: String,
    parseJsonTextArray: parseJson, storedWorkCodeKey: codeKey, publicRemoteUrl: value => value || "",
    proxiedRemoteImageUrl: value => value || "", dbBoolOrNull: value => value == null ? null : Boolean(Number(value)),
    warn: (...args) => state.warnings.push(args) };
  const missing = statusAdapter((legacy ? legacyMissing : createMissingCodeSearchService)(missingOptions));
  if (legacy) {
    // The captured negative control keeps its original cache/read/hydration
    // algorithms. Share only the newly introduced compact label projection so
    // DTO comparisons continue to isolate cache recovery, not feature fields.
    const labels = createMissingCodeSearchService({ ...missingOptions, getCoreDb: () => state.db, warn: () => {} });
    const legacySearch = missing.search;
    missing.search = (query) => {
      const works = legacySearch(query);
      const projected = new Map(labels.search(query).map((work) => [work.id, work]));
      for (const work of works) {
        const labelWork = projected.get(work.id);
        if (!labelWork || work.missingCodeSearchTraitsReady) continue;
        const ordered = {};
        for (const [key, value] of Object.entries(work)) {
          ordered[key] = value;
          if (key === "missingCodeSearchPending") ordered.missingCodeSearchTraitsReady = labelWork.missingCodeSearchTraitsReady;
        }
        const { javdbTags: _oldTags, ...summary } = work.infoSummary;
        ordered.infoSummary = { ...summary, tags: labelWork.infoSummary.tags, javdbTags: labelWork.infoSummary.javdbTags };
        for (const key of Object.keys(work)) delete work[key];
        Object.assign(work, ordered);
      }
      return works;
    };
  }
  const adapters = new Function("workSearchIndexService", "missingCodeSearchService",
    serverFunction("withWorkSearchReadStatus") + "\n" + serverFunction("workSearchReadCacheable")
    + "\nreturn { withWorkSearchReadStatus, workSearchReadCacheable };")(text, missing);
  // This control removes only the optional consumer bindings. Both current
  // providers and the actual server adapter functions remain unchanged.
  const consumerStatus = { withWorkSearchReadStatus: connectConsumers ? adapters.withWorkSearchReadStatus : undefined,
    workSearchReadCacheable: connectConsumers ? adapters.workSearchReadCacheable : undefined };
  const dependencies = { ...base.dependencies, ...consumerStatus, createWorkSearchMatcher: text.createMatcher,
    prewarmWorkSearch: text.prewarm, fastMissingCodeSearch: missing.search, hydrateMissingSearchWorks: missing.hydrate };
  const grouped = createFanhaoDependencies(new Proxy(dependencies, {
    get: (object, field) => Object.hasOwn(object, field) ? object[field] : () => {}
  }));
  const query = createWorkQueryService({ ...grouped.works, library: base.library });
  assert.equal(grouped.works.withWorkSearchReadStatus, consumerStatus.withWorkSearchReadStatus, "actual composition forwards the optional status adapter");
  assert.equal(grouped.works.workSearchReadCacheable, consumerStatus.workSearchReadCacheable, "actual composition forwards the optional getter");
  const workFilterService = createWorkFilterService(dependencies);
  const pageAdapter = new Function("clampInteger", "DEFAULT_WORK_LIMIT", "MAX_WORK_LIMIT", "prewarmCoreWorkCovers", "prewarmWorkInfoDetails", "publicWork", "prewarmRemoteImagesForWorks", "workFilterService",
    serverFunction("pagedWorksPayload") + "\nreturn pagedWorksPayload;")(
    clampInteger, 48, 1000, () => {}, dependencies.prewarmWorkInfoDetails, base.presenter.publicWork, () => {}, workFilterService);
  const prefixDependencies = {
    createCodePrefixService, ...consumerStatus, withWorkInfoReadStatus: base.info.withReadStatus, workInfoReadCacheable: base.info.readCacheable,
    clampInteger, dedupeWorksForDisplay: rows => rows, DEFAULT_WORK_LIMIT: 48, MAX_WORK_LIMIT: 1000,
    missingCodeSearchService: missing, workFilterService,
    getCoreDb: () => state.db, library: base.library, studioCatalogStamp: () => state.stamp,
    pagedWorksPayload: pageAdapter, sortWorkList: dependencies.sortWorkList,
    accountUserStateService: { revision: () => "private user" }, workClassificationService: dependencies.workClassificationService,
    workFacets: dependencies.workFacets, workQueryStamp: () => state.stamp
  };
  const server = readFileSync(new URL("../../server.js", import.meta.url), "utf8");
  const constructorStart = server.indexOf("const codePrefixService = createCodePrefixService({");
  const constructorEnd = server.indexOf("\n});", constructorStart) + 4;
  assert.ok(constructorStart > 0 && constructorEnd > constructorStart, "actual server prefix constructor exists");
  const prefix = new Function(...Object.keys(prefixDependencies), server.slice(constructorStart, constructorEnd)
    + "\nreturn codePrefixService;")(...Object.values(prefixDependencies));
  return { ...base, state, text, missing, query, prefix, dependencies, grouped, adapters,
    close() { if (state.db.isOpen) state.db.close(); } };
}

export function searchUrl(query = "needle phrase", filter = "all", sort = "releaseDesc", limit = 48, offset = 0, category = "all") {
  const url = new URL("http://fixture.test/api/works/search");
  for (const [key, value] of Object.entries({ q: query, filter, sort, limit, offset, category })) url.searchParams.set(key, value);
  return url;
}
