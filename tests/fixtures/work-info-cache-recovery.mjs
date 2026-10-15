import { DatabaseSync } from "node:sqlite";
import { createWorkInfoService } from "../../src/modules/fanhao/server/works/work-info-service.js";
import { createWorkPresenterService } from "../../src/modules/fanhao/server/works/presenter-service.js";
import { createWorkQueryService } from "../../src/modules/fanhao/server/works/work-query-service.js";
import { createWorkDetailService } from "../../src/modules/fanhao/server/works/work-detail-service.js";
import { createPersonDetailService } from "../../src/modules/fanhao/server/people/person-detail-service.js";
import { createActorMovieService } from "../../src/modules/fanhao/server/people/actor-movie-service.js";
import { createWorkCodeIndexService } from "../../src/modules/fanhao/server/works/work-code-index-service.js";
import { createWorkFilterService } from "../../src/modules/fanhao/server/works/work-filter-service.js";
import { createWorkSorter } from "../../src/modules/fanhao/server/works/work-sorter.js";
import { createCollectionQueryService } from "../../src/modules/fanhao/server/user-state/collection-query-service.js";
import { createFanhaoDependencies } from "../../src/modules/fanhao/server/composition.js";

export function parseJson(value) { try { return JSON.parse(value || "[]"); } catch { return []; } }
export function uniqueText(value) { return [...new Set(value || [])]; }
export function codeKey(value) { return String(value || "").replace(/[^A-Za-z0-9]/g, "").toLowerCase(); }
export function looseCodeKey(value) { return /^[A-Z]{2}-\d+$/i.test(String(value)) ? codeKey(value) : ""; }
export function clampInteger(value, fallback, min, max) {
  return Math.max(min, Math.min(max, value === null ? fallback : Number(value)));
}
export function workInfoUrl(filter = "all", sort = "ratingDesc", offset = 0, limit = 48) {
  return new URL(`http://fixture.test/api/works?filter=${filter}&sort=${sort}&limit=${limit}&offset=${offset}`);
}

// Each caller owns an actual private database. This helper never opens an
// application path, starts a process, or removes a filesystem probe.
export function createWorkInfoDatabase({ count = 2 } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    ATTACH DATABASE ':memory:' AS fanhao_images;
    CREATE TABLE works(id INTEGER PRIMARY KEY,code TEXT,code_search TEXT,title TEXT,release_date TEXT,duration_minutes INTEGER,rating REAL,rating_count INTEGER,director TEXT,fields_json TEXT,raw_text TEXT,status TEXT,error TEXT,updated_at TEXT,has_magnet INTEGER,is_streamable INTEGER,has_subtitles INTEGER,javdb_tags_json TEXT);
    CREATE TABLE local_works(id INTEGER PRIMARY KEY,work_id INTEGER,source_info_id INTEGER,source_name TEXT,source_info_path TEXT,source_size INTEGER,source_mtime INTEGER);
    CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE work_people(work_id INTEGER,person_id INTEGER,role TEXT,source TEXT,sort_order INTEGER,created_at TEXT,updated_at TEXT);
    CREATE TABLE person_external_refs(id INTEGER PRIMARY KEY,person_id INTEGER,provider TEXT,external_key TEXT,url TEXT);
    CREATE TABLE work_external_refs(work_id INTEGER,provider TEXT,url TEXT);
    CREATE TABLE makers(id INTEGER PRIMARY KEY,name TEXT,name_search TEXT,source TEXT);
    CREATE TABLE work_makers(work_id INTEGER,maker_id INTEGER,role TEXT);
    CREATE TABLE maker_external_refs(maker_id INTEGER,provider TEXT,url TEXT);
    CREATE TABLE series(id INTEGER PRIMARY KEY,maker_id INTEGER,name TEXT,name_search TEXT,kind TEXT,source TEXT);
    CREATE TABLE work_series(work_id INTEGER,series_id INTEGER);
    CREATE TABLE series_external_refs(series_id INTEGER,provider TEXT,url TEXT);
    CREATE TABLE fanhao_images.images(id INTEGER PRIMARY KEY,owner_type TEXT,owner_id INTEGER,kind TEXT,remote_url TEXT,image_blob BLOB,local_path TEXT,source TEXT,updated_at TEXT,sort_order INTEGER);
    CREATE TABLE collections(id INTEGER PRIMARY KEY,type TEXT,source_key TEXT,name TEXT,source_url TEXT);
    CREATE TABLE collection_items(collection_id INTEGER,work_id INTEGER,rank_no INTEGER,title_snapshot TEXT,rating_snapshot REAL,rating_count_snapshot INTEGER,fetched_at TEXT,updated_at TEXT);
    INSERT INTO people VALUES(1,'Actor');
    INSERT INTO person_external_refs VALUES(1,1,'javdb-actor','actor','https://fixture.test/actor');
    INSERT INTO makers VALUES(1,'Maker','maker','fixture');
    INSERT INTO series VALUES(1,1,'Series','series','series','fixture');
    INSERT INTO collections VALUES(1,'ranking','top:fixture','Fixture ranking','https://fixture.test/ranking');
  `);
  const work = db.prepare("INSERT INTO works VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const local = db.prepare("INSERT INTO local_works VALUES(?,?,1,'fixture','private fixture',1,1)");
  const actor = db.prepare("INSERT INTO work_people VALUES(?,1,'actor','actor_movies',?,'2026','2026')");
  const cover = db.prepare("INSERT INTO fanhao_images.images VALUES(?,'work',?,'cover',?,NULL,'','fixture','2026',0)");
  db.exec("BEGIN");
  for (let id = 1; id <= count; id++) {
    const code = `${id === 2 ? "BB" : "AA"}-${String(id).padStart(3, "0")}`;
    work.run(id, code, codeKey(code), `Metadata ${id}`, id === 2 ? "2026-01-01" : "2020-01-01",
      id === 2 ? 120 : 60, id === 2 ? 4.8 : 3.2, id === 2 ? 99 : 5,
      "Director", '[{"label":"Fixture","value":"Private"}]', `Raw ${id}`, "ok", "", "2026", 1, 0, 1, '["fixture"]');
    local.run(id, id); actor.run(id, id); cover.run(id, id, `https://fixture.test/${id}`);
    db.prepare("INSERT INTO work_makers VALUES(?,1,'maker')").run(id);
    db.prepare("INSERT INTO work_series VALUES(?,1)").run(id);
    db.prepare("INSERT INTO collection_items VALUES(1,?,?,NULL,NULL,NULL,'2026','2026')").run(id, id);
  }
  db.exec("COMMIT");
  return db;
}

export function createWorkInfoCacheFixture({ connectStatus = true, count = 2, dependencies: overrides = {} } = {}) {
  const state = { db: createWorkInfoDatabase({ count }), stamp: "fixed", failure: null,
    counts: { row: 0, facet: 0, detail: 0, other: 0 }, onRead: null };
  const owners = new WeakMap();
  function getCoreDb() {
    if (owners.has(state.db)) return owners.get(state.db);
    const db = state.db;
    const owner = { prepare(sql) {
      const reader = sql.includes("GROUP BY w.id") && sql.includes("source_info_id") ? "detail"
        : sql.includes("CAST(w.id AS TEXT) AS work_id") && sql.includes("FROM works w") && sql.includes("WHERE w.status = 'ok'")
          ? sql.includes("w.title") ? "row" : "facet" : "other";
      state.counts[reader]++;
      failed(reader, "prepare");
      const statement = db.prepare(sql);
      return new Proxy(statement, { get(target, key) {
        if (["all", "get"].includes(key)) return (...params) => {
          failed(reader, "all", params);
          return target[key](...params);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    } };
    owners.set(db, owner);
    return owner;
  }
  function failed(reader, phase, params = []) {
    state.onRead?.(reader, phase, params);
    const failure = state.failure;
    if (!failure || failure.reader !== reader || failure.phase !== phase
      || (failure.at && failure.at !== state.counts[reader])
      || (failure.from && state.counts[reader] < failure.from)) return;
    if (failure.once) state.failure = null;
    throw Object.assign(new Error(`controlled ${reader} ${phase} failure`), { code: "SQLITE_BUSY" });
  }
  const info = createWorkInfoService({ getCoreDb, getStamp: () => state.stamp, displayWorkTitle: String,
    parseJsonArray: parseJson, parseJsonTextArray: parseJson, proxiedRemoteImageUrl: value => value || "",
    proxiedRemoteImageUrlArray: value => value || [], publicRemoteUrl: value => value || "",
    renderInfoMetadataText: () => "Fixture fields", uniqueTextArray: uniqueText });
  const status = { withWorkInfoReadStatus: connectStatus ? info.withReadStatus : undefined,
    workInfoReadCacheable: connectStatus ? info.readCacheable : undefined };
  const works = Array.from({ length: count }, (_, index) => ({ id: String(index + 1), title: `Local ${index + 1}`,
    directoryName: `Local ${index + 1}`, personId: "1", videos: [], images: [], infos: [],
    playableCount: 0, infoCount: 0, modifiedAt: "2026" }));
  const person = { id: "1", name: "Actor", works: works.map(work => work.id), workCount: count };
  const library = { scannedAt: "scan", worksById: new Map(works.map(work => [work.id, work])),
    peopleById: new Map([[person.id, person]]), people: [person], filesById: new Map() };
  const favoriteStateService = { isFavoriteWork: () => false, publicFavoriteForWork: () => null,
    favoriteWorks: () => works, normalizeFavoriteFolderId: value => value, publicFavoriteFolders: () => [] };
  const playbackProgressService = { getWorkProgress: () => null, getVideoProgress: () => null,
    historyEntries: () => works.map(work => ({ work })) };
  const prewarmWorkInfoDetails = rows => info.prewarmDetailRows(rows.map(work => work.id), { includeMetadata: false });
  const presenter = createWorkPresenterService({ ...status, getLibrary: () => library,
    getPersonFallbackAvatarStamp: () => state.stamp, displayPersonForWork: () => person,
    actorProfileRow: () => null, publicActorProfile: () => null,
    publicActorProfileSnapshot: () => ({ profile: null, avatar: null }), publicCoreWorkCover: () => null,
    manualCoverStateService: { manualCoverForWork: () => null }, favoriteStateService, playbackProgressService,
    localWorkMarkers: () => [], isGPerson: () => false, displayWorkTitle: String,
    publicWorkInfoSummary: info.publicSummary, publicWorkInfoMetadata: info.publicMetadata,
    workInfoDetailRow: info.detailRow, uniqueTextArray: uniqueText,
    dbBoolOrNull: value => value == null ? null : Boolean(Number(value)), firstPresentValue: info.firstPresentValue,
    proxiedRemoteImageUrl: value => value || "", prewarmWorkInfoDetails });
  const code = createWorkCodeIndexService({ ...status, getLibrary: () => library, getStamp: () => `${library.scannedAt}:${state.stamp}`,
    looseWorkCodeKey: looseCodeKey, storedWorkCodeKey: codeKey, workInfoRow: info.row });
  const filter = createWorkFilterService({ favoriteStateService, playbackProgressService, workInfoFacetRow: info.facetRow });
  const sort = createWorkSorter({ displayWorkTitle: String, progressForWork: () => null, metadataForWork: work => {
    const row = info.facetRow(work.id);
    return { releaseDate: row?.release_date || "", rating: row?.rating ?? null,
      ratingCount: row?.rating_count || 0, duration: row?.duration_minutes || 0, code: row?.code || work.title };
  } });
  const deps = { ...status, diskUsage: {}, getLibrary: () => library, getCoreDb,
    actorMovieStamp: () => state.stamp, actorMovieInfoStamp: () => state.stamp,
    workQueryStamp: () => state.stamp, userStateStamp: () => state.stamp, peoplePayloadStamp: () => state.stamp,
    enrichLocalWorksWithActorMovieIndex: rows => rows, enrichLocalWorksWithActorMovieIndexResult: undefined,
    enrichLocalWorksWithActorMovieInfo: rows => rows, actorMissingSearchWorks: () => [],
    actorMissingSearchWorksForPeople: () => [], rankingMissingSearchWorks: () => [], actorMissingSearchResult: undefined,
    actorMissingSearchResultForPeople: undefined, mergedActorMovieRowsResult: undefined,
    missingActorWorksResultForPerson: undefined, rankingMissingSearchResult: undefined,
    withWorkSearchReadStatus: undefined, workSearchReadCacheable: undefined,
    createWorkSearchMatcher: () => () => true, searchPeople: () => ({ exact: [], matchedPersonIds: [], people: [] }),
    dedupeWorksForDisplay: rows => rows, defaultWorkLimit: 48, maxWorkLimit: 1000, clampInteger,
    favoriteStateService, playbackProgressService,
    peopleScopeService: { normalize: () => "main", workMatches: () => true, workMatchesDirect: () => false, personMatches: () => true },
    isVrWork: () => false, workHasCoreCover: () => false, workHasLocalMarker: () => false,
    workInfoFacetRow: info.facetRow, workInfoRow: info.row, publicWorkAvailability: presenter.publicWorkAvailability,
    publicWork: presenter.publicWork, publicPerson: presenter.publicPerson, storedWorkCodeKey: codeKey,
    localSearchWorkByCodeKey: code.localSearchWorkByCodeKey, localWorksByCodePrefix: code.localWorksByCodePrefix,
    prewarmLocalWorkCodeKeys: () => {}, prewarmRemoteImagesForWorks: () => {}, prewarmCoreWorkCovers: () => {},
    prewarmWorkInfoDetails, prewarmVideoProbesForWorks: () => {}, prewarmWorkSearch: () => {},
    prewarmPersonMerge: () => {}, scheduleBackground: () => {},
    workClassificationService: { visibilityStamp: () => "", filterForRequest: rows => rows }, displayWorkTitle: String,
    filterWorkList: filter.filter, sortWorkList: sort, workFacets: filter.facets, recentWatchedDays: 7,
    resolveLibraryWorkByPublicId: id => library.worksById.get(String(id)),
    resolveLibraryPersonByPublicId: id => library.peopleById.get(String(id)), mergedPersonRecord: value => value,
    mergedPersonMembers: id => [{ id }], mergedActorMovieRows: () => [], missingActorWorksForPerson: () => [],
    coreLocalWorkIdsForPeople: () => [], corePersonFallbackRecord: () => null, coreMissingWorksForPerson: () => [],
    workCodeKeySetForWorks: code.keySetForWorks, maxActorAvatarBytes: 1024, ...overrides };
  const grouped = createFanhaoDependencies(new Proxy(deps, {
    get: (object, field) => Object.hasOwn(object, field) ? object[field] : () => {}
  }));
  const query = createWorkQueryService({ ...grouped.works, library });
  const detail = createWorkDetailService({ ...grouped.works, library,
    publicPerson: value => presenter.publicPerson(value, { skipFallbackAvatar: true }) });
  const personDetail = createPersonDetailService({ ...grouped.works, library, workQueryService: query });
  const collection = createCollectionQueryService(grouped.userState);
  return { state, info, presenter, query, detail, personDetail, collection, code, library, works, person,
    dependencies: deps, grouped, getCoreDb, close: () => state.db.close() };
}

export function createActorMovieForWorkInfoFixture(fixture, overrides = {}) {
  return createActorMovieService({ ...fixture.dependencies,
    getCoreDb: fixture.getCoreDb, getInfoStamp: () => fixture.state.stamp,
    getSearchStamp: () => fixture.state.stamp, getStamp: () => fixture.state.stamp,
    localWorkCodeKeys: fixture.code.localCodeKeys, workCodeKeys: fixture.code.workCodeKeys,
    looseWorkCodeKey: looseCodeKey, storedWorkCodeKey: codeKey, normalizeWorkCode: String,
    parseJsonTextArray: parseJson, proxiedRemoteImageUrl: value => value || "",
    publicRemoteUrl: value => value || "", dbBoolOrNull: value => value == null ? null : Boolean(Number(value)),
    createId: (type, value) => `${type}:${value}`, ...overrides });
}
