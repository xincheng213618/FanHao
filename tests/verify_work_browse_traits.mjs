import assert from "node:assert/strict";
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
  const state = { stamp: 0, reads: 0, fail: false, cacheable: true, depth: 0 };
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
    actorMovieStamp: () => `fixture:${state.stamp}`, workQueryStamp: () => `fixture:${state.stamp}`,
    userStateStamp: () => "user", peoplePayloadStamp: () => "people",
    actorMissingSearchWorks: () => [], rankingMissingSearchWorks: () => [],
    clampInteger: (value, fallback, min, max) => value === null || value === "" || !Number.isFinite(Number(value)) ? fallback : Math.max(min, Math.min(max, Math.trunc(Number(value)))),
    defaultWorkLimit: 2, maxWorkLimit: 64,
    enrichLocalWorksWithActorMovieIndex: (values) => values,
    library: { worksById: new Map(works.map((work) => [work.id, work])) },
    peopleScopeService: { normalize: () => "main", workMatches: (_work, scope) => scope === "main" },
    prewarmRemoteImagesForWorks: () => {}, publicWork: (work) => ({ id: work.id, title: work.title }),
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
    assert.deepEqual(payload.works[1].traits.editions.map(({ key }) => key), ["uncensoredAi"]);
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
