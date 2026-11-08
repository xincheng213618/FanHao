import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { deriveWorkTraits, mediaClassificationSearch } from "../lib/work-traits.js";
import { createCoreLibraryService } from "../src/modules/fanhao/server/library/core-library-service.js";
import { createWorkQueryService } from "../src/modules/fanhao/server/works/work-query-service.js";
import { createWorkFilterService } from "../src/modules/fanhao/server/works/work-filter-service.js";
import { createCollectionQueryService } from "../src/modules/fanhao/server/user-state/collection-query-service.js";

let checks = 0;
function check(name, callback) {
  try { callback(); } catch (error) { console.error(`work-browse-traits failed: ${name}`); throw error; }
  checks += 1;
}
const tagFilter = (value) => `tag:${encodeURIComponent(value)}`;
function request(filter = "all", extra = {}) {
  const url = new URL("http://fixture/api/works");
  for (const [key, value] of Object.entries({ q: "AB", filter, sort: "title", limit: 2, offset: 0, ...extra })) url.searchParams.set(key, String(value));
  return url;
}
function tagCount(payload, name) {
  return payload.traitFacets.tags.find((item) => item.name === name)?.count || 0;
}
function editionCount(payload, key) {
  return payload.traitFacets.editions.find((item) => item.key === key)?.count || 0;
}

function fixture(count = 50) {
  const rows = new Map();
  const works = Array.from({ length: count }, (_, index) => {
    const code = `AB-${100 + index}`;
    const editions = ["-U", "-AI去码", "-C", ""][index % 4];
    const work = {
      id: `work-${index}`, title: code, directoryName: code, personId: "person-one",
      playableCount: index % 3 ? 1 : 0, videoCount: 1, infoCount: 1,
      modifiedAt: `2026-10-${String(index % 20 + 1).padStart(2, "0")}`,
      infoSummary: { code, tags: ["摘要标签"], hasSubtitles: true, rating: 4.5 },
      videos: [{ name: `${code}${editions}.mp4` }]
    };
    if (index % 10 === 0) work.videos.push({ name: `${code}-U-C-4K.mp4` });
    rows.set(work.id, { trait_tags: index % 2 ? ["美少女電影", "戀愛"] : ["單體作品", "眼鏡", "制服,眼镜"] });
    return work;
  });
  const state = { stamp: 0, stampReads: 0, reads: 0, fail: false, cacheable: true, depth: 0 };
  function scoped(callback) {
    if (!state.depth) state.cacheable = true;
    state.depth += 1;
    let value;
    try { value = callback(); } finally { state.depth -= 1; }
    return { value, cacheable: state.cacheable };
  }
  const workInfoFacetRow = (id) => {
    state.reads += 1;
    if (state.fail) { state.cacheable = false; return null; }
    return rows.get(id) || null;
  };
  const favoriteStateService = { isFavoriteWork: (id) => Number(id.split("-").pop()) % 5 === 0 };
  const common = {
    favoriteStateService, playbackProgressService: { getWorkProgress: () => null },
    publicWorkAvailability: (work) => ({ hasMagnet: work.infoSummary?.hasMagnet }), isVrWork: () => false,
    workHasCoreCover: () => true, workHasLocalMarker: () => false, workInfoFacetRow
  };
  const service = createWorkQueryService({
    ...common,
    actorMovieStamp: () => `fixture:${state.stamp}`,
    workQueryStamp: () => { state.stampReads += 1; return `fixture:${state.stamp}`; },
    userStateStamp: () => "user", peoplePayloadStamp: () => "people",
    actorMissingSearchWorks: () => [], rankingMissingSearchWorks: () => [],
    searchPeople: () => ({ exact: [], people: [] }),
    createWorkSearchMatcher: (query) => (work) => work.title.toLowerCase().includes(query),
    clampInteger: (value, fallback, min, max) => value === null || value === "" || !Number.isFinite(Number(value)) ? fallback : Math.max(min, Math.min(max, Math.trunc(Number(value)))),
    defaultWorkLimit: 2, maxWorkLimit: 64,
    enrichLocalWorksWithActorMovieIndex: (values) => values,
    library: { worksById: new Map(works.map((work) => [work.id, work])) },
    peopleScopeService: { normalize: () => "main", workMatches: (_work, scope) => scope === "main" },
    prewarmRemoteImagesForWorks: () => {}, publicWork: (work) => ({ id: work.id, title: work.title }),
    localSearchWorkByCodeKey: () => new Map(works.map((work) => [work.infoSummary.code.replace("-", "").toLowerCase(), work])),
    localWorksByCodePrefix: () => works, fastMissingCodeSearch: () => [],
    storedWorkCodeKey: (value) => String(value).replace(/[^A-Z0-9]/gi, "").toLowerCase(),
    dedupeWorksForDisplay: (values) => values,
    withWorkInfoReadStatus: scoped, workInfoReadCacheable: () => state.cacheable
  });
  return { works, rows, state, scoped, workInfoFacetRow, service, filterService: createWorkFilterService(common) };
}

function collectionFor(env) {
  if (env.collection) return env.collection;
  const noop = () => {};
  env.collection = createCollectionQueryService({
    clampInteger: (value, fallback, min, max) => value === null || value === "" || !Number.isFinite(Number(value)) ? fallback : Math.max(min, Math.min(max, Math.trunc(Number(value)))),
    favoriteStateService: {
      favoriteWorks: () => env.works,
      normalizeFavoriteFolderId: (value) => value,
      publicFavoriteFolders: () => [{ id: "all", count: env.works.length }]
    },
    getLibrary: () => ({ worksById: new Map(env.works.map((work) => [work.id, work])) }),
    maxWorkLimit: 64, recentWatchedDays: 30,
    playbackProgressService: { historyEntries: () => env.works.map((work) => ({ work })) },
    filterWorkList: env.filterService.filter,
    sortWorkList: (works) => [...works].sort((left, right) => left.title.localeCompare(right.title, undefined, { numeric: true })),
    publicWork: (work) => ({ id: work.id, title: work.title, traits: env.filterService.traits(work) }),
    workFacets: env.filterService.facets,
    workInfoFacetRow: env.workInfoFacetRow,
    prewarmCoreWorkCovers: noop, prewarmRemoteImagesForWorks: noop,
    prewarmVideoProbesForWorks: noop, prewarmWorkInfoDetails: noop,
    withWorkInfoReadStatus: env.scoped, workInfoReadCacheable: () => env.state.cacheable,
    workQueryStamp: () => `fixture:${env.state.stamp}`, userStateStamp: () => "user"
  });
  return env.collection;
}

const modes = {
  list: ({ service }, url) => service.listPayload(url),
  search: ({ service }, url) => service.searchPayload(url),
  person: ({ works, service }, url) => service.listFromWorksPayload(works, url, { personId: "person-one" }),
  personLight: ({ works, service }, url) => service.listFromWorksPayload(works, url, { personId: "person-one" }, { lightweightInfo: true }),
  favorites: (env, url) => collectionFor(env).favoritesPayload(url),
  history: (env, url) => collectionFor(env).historyPayload(url)
};

check("bulk filtering, sorting and facet reads reuse the work revision within each pass", () => {
  const env = fixture(2_000);
  const tag = tagFilter("眼镜");
  const listUrl = request(`${tag},rated`, { sort: "ratingDesc" });
  assert.equal(env.service.listPayload(listUrl).total, 1_000);
  assert(env.state.stampReads < 64, `cold list read the work revision ${env.state.stampReads} times`);
  env.state.stampReads = 0;
  assert.equal(env.service.searchPayload(request(tag)).total, 1_000);
  assert(env.state.stampReads < 64, `cold search read the work revision ${env.state.stampReads} times`);

  env.rows.set("work-1", { trait_tags: ["眼镜"], rating: 5, rating_count: 100 });
  env.state.stamp += 1;
  const updated = env.service.listPayload(listUrl);
  assert.equal(updated.total, 1_001);
  assert.equal(updated.works[0].id, "work-1");
  assert.equal(tagCount(updated, "眼镜"), 1_001);
  assert.equal(env.service.searchPayload(request(tag)).total, 1_001);
});

check("classification search is paginated, local-only, and intersects with text and facets", () => {
  const env = fixture(8);
  env.works[0].videos = [{ name: "AB-100-LTXC.mkv", width: 3840, height: 2160 }];
  env.works[1].videos = [{ name: "AB-101-LTX.wmv", width: 1920, height: 1080 }];
  env.works[1].title += " text fixture";
  env.works[2].videos = [{ name: "AB-102-LTX-4K.mp4", width: 1280, height: 720 }];
  env.works[3].videos = [{ name: "AB-103-4K.mp4", width: 3840, height: 2160 }];
  env.works[3].relativePath = "V:/[A]/AB-103";
  env.works[4].videos = [{ name: "AB-104-LTX.mp4" }];
  env.works[4].missingLocal = true;
  const search = (q, filter = "all", offset = 0) => env.service.searchPayload(request(filter, { q, offset }));
  assert.equal(search("LTX").total, 3);
  assert.deepEqual(search("class:ltx", "all", 2).works.map(({ id }) => id), ["work-2"]);
  assert.deepEqual(search("class:ltx", "formatWmv,quality1080p").works.map(({ id }) => id), ["work-1"]);
  assert.deepEqual(search("class:ltx 720").works.map(({ id }) => id), ["work-2"]);
  for (const text of ["720", "1080", "SSIS-720"]) assert.equal(mediaClassificationSearch(text), null);
  assert.equal(mediaClassificationSearch("720p").key, "quality720p");
  assert.equal(mediaClassificationSearch("class:720").key, "quality720p");
  assert.equal(search("4K").total, 1);
  assert.equal(search("class:ltx AB").total, 3);
  assert.deepEqual(search("class:ltx AB-101").works.map(({ id }) => id), ["work-1"]);
  assert.deepEqual(search("class:ltx text fixture").works.map(({ id }) => id), ["work-1"]);
});

check("library projection reads only valid, version-matched dimensions across video IDs", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE people(id, name, display_name, folder_path);
      CREATE TABLE work_people(work_id, person_id, role, sort_order);
      CREATE TABLE works(id, code, title, release_date, duration_minutes, rating, rating_count,
        has_magnet, is_streamable, has_subtitles, javdb_tags_json, director, updated_at);
      CREATE TABLE local_works(id, work_id, local_path, source_mtime);
      CREATE TABLE local_files(local_work_id, file_id, file_type, file_path, name, title, ext,
        relative_path, size INTEGER, modified_at, playable, sort_order);
      INSERT INTO people VALUES (1, 'Fixture', 'Fixture', NULL);
      INSERT INTO work_people VALUES (100, 1, 'actor', 0);
      INSERT INTO works(id, code, title) VALUES (100, 'AB-100', 'AB-100');
      INSERT INTO local_works VALUES (1, 100, 'fixture/AB-100', 'one');
      INSERT INTO local_files VALUES (1, 'stored-1', 'video', 'fixture/AB-100-4K.mp4',
        'AB-100-4K.mp4', 'AB-100', '.mp4', 'fixture/AB-100-4K.mp4', 1234, 'one', 1, 1);
    `);
    const service = createCoreLibraryService({
      chooseCover: () => null, compareNaturalName: (a, b) => a.name.localeCompare(b.name),
      emptyLibrary: () => ({ availableRoots: [], missingRoots: [], worksById: new Map(), filesById: new Map(),
        people: [], peopleById: new Map(), totals: {} }),
      fileBase: String, getCoreDb: () => db, hasCoreDb: () => true, libraryRoots: [],
      normalizePersonSearchValue: String, parseJsonTextArray: () => [], dbBoolOrNull: () => null,
      personRecordFromWorks: (entry) => entry, relativeFromRoot: String,
      registerFiles: (index, files) => files.forEach((file) => index.filesById.set(file.id, file)),
      sourcePathToAbsolute: (value) => String(value || ""), uniquePersonNames: (values) => values
    });
    const loadWork = () => service.loadLibrary().worksById.get("100");
    const mediaPath = "fixture/AB-100-4K.mp4";
    assert.equal(deriveWorkTraits(loadWork()).flags.quality4k, true, "without a cache the explicit filename remains evidence");
    db.exec("CREATE TABLE video_probe_cache(file_id, file_path)");
    assert.equal(loadWork().videos[0].width, undefined, "a legacy optional schema does not block library loading");
    db.exec(`DROP TABLE video_probe_cache;
      CREATE TABLE video_probe_cache(file_id, file_path, source_size INTEGER, source_mtime, schema_version,
        status, probe_json, updated_at);`);
    const insert = db.prepare("INSERT INTO video_probe_cache VALUES (?, ?, ?, ?, 1, 'ok', ?, ?)");
    insert.run("100-1", mediaPath, 1234, "library:one", '{"width":1920,"height":1080}', "2026-11-01");
    insert.run("other-runtime-id", mediaPath, 1234, "library:older", '{"width":3840,"height":2160}', "2026-11-03");
    insert.run("other-size", mediaPath, 1222, "library:one", '{"width":3840,"height":2160}', "2026-11-03");
    insert.run("bad-json", mediaPath, 1234, "library:one", '{"width":', "2026-11-04");
    insert.run("bad-dimensions", mediaPath, 1234, "library:one", '{"width":"3840","height":2160}', "2026-11-04");
    const current = loadWork();
    assert.equal(current.videos[0].width, 1920);
    assert.equal(deriveWorkTraits(current).flags.quality1080p, true);
    assert.equal(deriveWorkTraits(current).flags.quality4k, false);
    db.exec("UPDATE local_files SET modified_at = 'new-file-version'");
    assert.equal(loadWork().videos[0].width, undefined, "replace invalidates measurements from previous file contents");
  } finally {
    db.close();
  }
});

for (const [mode, call] of Object.entries(modes)) {
  check(`${mode}: full result facets, compact metadata and page projection agree`, () => {
    const env = fixture();
    const payload = call(env, request());
    assert.equal(payload.total, 50);
    assert.equal(payload.count, 2);
    assert.equal(payload.traitFacets.total, 50);
    assert.equal(tagCount(payload, "摘要标签"), 50);
    assert.equal(tagCount(payload, "单体作品"), 25);
    assert.equal(tagCount(payload, "美少女电影"), 25);
    assert.equal(tagCount(payload, "眼镜"), 25);
    assert.equal(editionCount(payload, "uncensored"), 28);
    assert.equal(editionCount(payload, "uncensoredAi"), 13);
    assert.equal(editionCount(payload, "subtitled"), 15);
    assert.equal(editionCount(payload, "quality4k"), 5);
    assert.deepEqual(payload.works.map((work) => work.id), ["work-0", "work-1"]);
    assert.ok(payload.works[0].traits.tags.includes("单体作品"));
    assert.ok(payload.works[0].traits.tags.includes("摘要标签"));
    assert.equal(payload.works[1].traits.flags.uncensoredAi, true);
    assert.deepEqual(payload.works[1].traits.editions.map(({ key }) => key), ["uncensoredAi", "formatMp4"]);
    assert.ok(payload.works[0].traits.editions.every(({ evidence }) => evidence.length > 0));
  });

  check(`${mode}: canonical tag filters and AND combinations`, () => {
    const env = fixture();
    assert.equal(call(env, request(tagFilter("单体作品"))).total, 25);
    assert.equal(call(env, request(tagFilter("單體作品"))).total, 25);
    assert.equal(call(env, request(`${tagFilter("眼镜")},uncensored`)).total, 15);
    assert.equal(call(env, request(`${tagFilter("眼镜")},uncensoredAi`)).total, 0);
    assert.equal(call(env, request(`${tagFilter("眼镜")},uncensored,quality4k,playable`)).total, 3);
    assert.equal(call(env, request("uncensoredAi")).total, 13);
    const reduced = call(env, request(tagFilter("眼镜")));
    assert.equal(reduced.traitFacets.total, 25);
    assert.equal(tagCount(reduced, "眼镜"), 25);
    assert.equal(tagCount(reduced, "美少女电影"), 0);
  });

  check(`${mode}: commas in labels remain one encoded filter token`, () => {
    const env = fixture();
    const payload = call(env, request(`${tagFilter("制服,眼镜")},uncensored`));
    assert.equal(payload.total, 15);
    assert.equal(tagCount(payload, "制服,眼镜"), 15);
    assert.equal(call(env, request(tagFilter("制服"))).total, 0);
    assert.equal(call(env, request("tag:%E7%")).total, 0);
  });

  check(`${mode}: literal URI escapes and percent signs decode only once`, () => {
    const env = fixture();
    env.rows.get("work-0").trait_tags.push("制服,%2C", "100%自然");
    assert.equal(call(env, request(tagFilter("制服,%2C"))).total, 1);
    assert.equal(call(env, request(tagFilter("制服,,"))).total, 0);
    assert.equal(call(env, request(tagFilter("100%自然"))).total, 1);
  });

  check(`${mode}: a genuinely empty library returns empty trait facets`, () => {
    const empty = call(fixture(0), request());
    assert.equal(empty.total, 0);
    assert.equal(empty.count, 0);
    assert.deepEqual(empty.works, []);
    assert.deepEqual(empty.traitFacets, { tags: [], editions: [], total: 0 });
  });

  check(`${mode}: offsets and empty pages do not alter full result counts`, () => {
    const env = fixture();
    const page = call(env, request("all", { offset: 2, limit: 3 }));
    assert.equal(page.offset, 2);
    assert.equal(page.limit, 3);
    assert.equal(page.count, 3);
    assert.deepEqual(page.works.map((work) => work.id), ["work-2", "work-3", "work-4"]);
    assert.equal(tagCount(page, "眼镜"), 25);
    const beyond = call(env, request("all", { offset: 60 }));
    assert.equal(beyond.count, 0);
    assert.equal(beyond.total, 50);
    assert.equal(beyond.traitFacets.total, 50);
    const none = call(env, request(tagFilter("不存在")));
    assert.equal(none.count, 0);
    assert.equal(none.total, 0);
    assert.deepEqual(none.traitFacets, { tags: [], editions: [], total: 0 });
  });

  check(`${mode}: successful same-stamp traits reuse and metadata stamp invalidation`, () => {
    const env = fixture();
    const first = call(env, request());
    const before = env.state.reads;
    const again = call(env, request());
    assert.strictEqual(again.traitFacets, first.traitFacets);
    if (["list", "search"].includes(mode)) assert.equal(env.state.reads, before);
    env.rows.get("work-0").trait_tags = ["新入库类别"];
    env.state.stamp += 1;
    const fresh = call(env, request());
    assert.equal(tagCount(fresh, "眼镜"), 24);
    assert.equal(tagCount(fresh, "新入库类别"), 1);
    assert.ok(fresh.works[0].traits.tags.includes("新入库类别"));
    assert.notStrictEqual(fresh.traitFacets, first.traitFacets);
    assert.ok(env.state.reads > before);
  });

  check(`${mode}: failed initial metadata read retries at the same stamp`, () => {
    const env = fixture();
    env.state.fail = true;
    const unavailable = call(env, request(tagFilter("眼镜")));
    assert.equal(unavailable.total, 0);
    env.state.fail = false;
    const recovered = call(env, request(tagFilter("眼镜")));
    assert.equal(recovered.total, 25, "same-stamp recovery must not retain an empty filtered source after a trait metadata failure");
    assert.equal(tagCount(recovered, "眼镜"), 25);
    assert.ok(recovered.works.every((work) => work.traits.tags.includes("眼镜")));
  });

  check(`${mode}: magnet availability includes local works and requires explicit true`, () => {
    const env = fixture();
    const states = [true, false, null, undefined, "true", 1];
    for (const [index, work] of env.works.entries()) {
      work.infoSummary.hasMagnet = states[index % states.length];
      work.infoSummary.tags.push("含磁链");
      work.missingLocal = index % 4 === 0;
    }
    const all = call(env, request("all"));
    assert.equal(all.facets.hasMagnet, 9);
    assert.equal(tagCount(all, "含磁链"), 0, "availability labels never become content chips");
    const magnet = call(env, request("hasMagnet"));
    assert.equal(magnet.total, 9);
    assert.equal(magnet.count, 2);
    assert.equal(magnet.traitFacets.total, 9);
    assert.equal(call(env, request("hasMagnet,localOnly")).total, 4);
    assert.equal(call(env, request("hasMagnet,missingLocal")).total, 5);
    assert.equal(call(env, request(`hasMagnet,${tagFilter("眼镜")},uncensored`)).total, 6);
    assert.equal(call(env, request("hasMagnet,quality4k")).total, 2);
    assert.equal(call(env, request(`hasMagnet,${tagFilter("美少女电影")}`)).total, 0);
    for (let index = 0; index < states.length; index += 1) assert.equal(env.filterService.matches(env.works[index], "hasMagnet"), index === 0);
  });
}

check("independent filter service uses exactly the same traits and AND selection", () => {
  const env = fixture();
  const fromQuery = env.service.listPayload(request("all", { limit: 64 }));
  assert.deepEqual(env.filterService.traitFacets(env.works), fromQuery.traitFacets);
  for (const filter of [tagFilter("眼镜"), `${tagFilter("制服,眼镜")},uncensored`, "uncensoredAi", "uncensored", "subtitled", "quality4k", `${tagFilter("眼镜")},quality4k,playable`]) {
    const expected = env.service.listPayload(request(filter, { limit: 64 })).works.map((work) => work.id).sort();
    assert.deepEqual(env.filterService.filter(env.works, filter).map((work) => work.id).sort(), expected);
  }
  assert.deepEqual(env.filterService.filters(`${tagFilter("制服,眼镜")},uncensored,uncensored`), [tagFilter("制服,眼镜"), "uncensored"]);
  assert.equal(env.filterService.traits(env.works[3]).flags.subtitled, false, "JavDB availability.hasSubtitles is not local subtitle evidence");
});

console.log(`work-browse-traits: ok (${checks} integration checks: 50-work list/search/person/favorites/history paging, compact metadata, filters, magnets, counters and recovery)`);
