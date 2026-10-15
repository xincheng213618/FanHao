import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createAuthServices } from "../../src/platform/server/auth.js";
import { createRequestHandler } from "../../src/platform/server/http-app.js";
import { readBodyText } from "../../src/platform/server/request-io.js";
import { sendJson, sendHtml, sendText, redirect } from "../../src/platform/server/responses.js";
import { createUserStateService } from "../../src/modules/fanhao/server/collections/user-state-service.js";
import { createAccountUserStateService } from "../../src/modules/fanhao/server/collections/account-user-state-service.js";
import { createFavoriteStateService } from "../../src/modules/fanhao/server/collections/favorite-state-service.js";
import { createPlaybackProgressService } from "../../src/modules/fanhao/server/playback/playback-progress-service.js";
import { createWorkPresenterService } from "../../src/modules/fanhao/server/works/presenter-service.js";
import { createWorkQueryService } from "../../src/modules/fanhao/server/works/work-query-service.js";
import { createWorkFilterService } from "../../src/modules/fanhao/server/works/work-filter-service.js";
import { createWorkDetailService } from "../../src/modules/fanhao/server/works/work-detail-service.js";
import { createPersonDetailService } from "../../src/modules/fanhao/server/people/person-detail-service.js";
import { createCollectionQueryService } from "../../src/modules/fanhao/server/user-state/collection-query-service.js";
import { routeUserStateApi } from "../../src/modules/fanhao/server/user-state/routes.js";
import { createRankingService } from "../../src/modules/fanhao/server/catalog/ranking-service.js";
import { createStudioService } from "../../src/modules/fanhao/server/catalog/studio-service.js";
import { createCodePrefixService } from "../../src/modules/fanhao/server/catalog/code-prefix-service.js";

// Real account HTTP/auth and personal/query/presenter services; only media metadata is synthetic.
export function createAccountLibraryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-account-library-"));
  const statePath = path.join(root, "user-state.json");
  const legacy = createUserStateService({ statePath, ensureDataDir() {} });
  legacy.state.favorites["101"] = { folderId: "default", createdAt: "2026-01-01" };
  legacy.state.progress["v101"] = { workId: "101", position: 12, duration: 120, updatedAt: "2026-01-01" };
  legacy.state.manualCovers["101"] = { imageId: "shared-cover", updatedAt: "2026-01-01" };
  legacy.save();
  const originalLegacy = fs.readFileSync(statePath, "utf8");
  const scoped = createAccountUserStateService({ dbPath: path.join(root, "account-user-state.sqlite"), legacyStateService: legacy });
  const works = [101, 102].map((id) => ({ id: String(id), personId: "p1", title: `ABC-${id}`,
    directoryName: `ABC-${id}`, videos: [{ id: `v${id}`, type: "video", playable: true, size: 1024 }],
    images: [], infos: [], playableCount: 1, videoCount: 1, infoCount: 0, modifiedAt: "2026-01-01" }));
  const person = { id: "p1", name: "Fixture Person", works: works.map((work) => work.id) };
  const library = { scannedAt: "fixture-v1", worksById: new Map(works.map((work) => [work.id, work])),
    peopleById: new Map([[person.id, person]]), filesById: new Map(works.flatMap((work) => work.videos.map((video) => [video.id, video]))) };
  const favorite = createFavoriteStateService({ createId: (prefix, name) => `${prefix}-${name}`, defaultFavoriteFolderId: "default",
    defaultFavoriteFolderName: "默认收藏", getLibrary: () => library, maxFavoriteFolders: 40, getUserState: scoped.state, userStateService: scoped });
  const progress = createPlaybackProgressService({ getLibrary: () => library, publicFavoriteFolders: favorite.publicFavoriteFolders,
    recentWatchedDays: 30, getUserState: scoped.state, userStateService: scoped });
  const presenter = createWorkPresenterService({ actorProfileRow: () => null, publicActorProfile: () => null,
    displayPersonForWork: () => person, displayWorkTitle: (title) => title || "", getLibrary: () => library,
    favoriteStateService: favorite, playbackProgressService: progress, localWorkMarkers: () => [],
    firstPresentValue: (...values) => values.find((value) => value != null), dbBoolOrNull: (value) => value == null ? null : Boolean(value),
    uniqueTextArray: (values) => [...new Set(values || [])], workInfoDetailRow: () => null,
    publicWorkInfoSummary: (_row, summary) => summary || {}, publicWorkInfoMetadata: () => ({}),
    publicCoreWorkCover: () => null, preferredPersonDisplayName: (_row, name) => name,
    manualCoverStateService: { manualCoverForWork: (work) => legacy.state.manualCovers[work.id]
      ? { image: { id: legacy.state.manualCovers[work.id].imageId }, record: legacy.state.manualCovers[work.id] } : null } });
  const publicPerson = (value) => ({ id: value.id, name: value.name });
  const codeKey = (value) => String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  const noop = () => {};
  const shared = {
    library, getLibrary: () => library, actorMovieInfoStamp: () => "1", actorMovieStamp: () => "1",
    peoplePayloadStamp: () => "1", workQueryStamp: () => `metadata:1:${legacy.manualCoverRevision()}`, userStateStamp: scoped.revision,
    actorMissingSearchWorks: () => [], actorMissingSearchWorksForPeople: () => [],
    clampInteger: (value, fallback, min, max) => Math.max(min, Math.min(max, value == null ? fallback : Number(value))),
    createWorkSearchMatcher: (query) => (work) => work.title.toLowerCase().includes(String(query).toLowerCase()),
    dedupeWorksForDisplay: (items) => items, defaultWorkLimit: 48, maxWorkLimit: 1000,
    enrichLocalWorksWithActorMovieIndex: (items) => items, enrichLocalWorksWithActorMovieInfo: (items) => items,
    fastMissingCodeSearch: () => [], isVrWork: () => false, workHasCoreCover: () => false, workHasLocalMarker: () => false,
    localSearchWorkByCodeKey: () => new Map(works.map((work) => [codeKey(work.title), work])), localWorksByCodePrefix: () => works,
    favoriteStateService: favorite, playbackProgressService: progress,
    publicWork: presenter.publicWork, publicWorkAvailability: presenter.publicWorkAvailability, publicPerson,
    peopleScopeService: { normalize: () => "main", workMatches: () => true, personMatches: () => true },
    prewarmCoreWorkCovers: noop, prewarmLocalWorkCodeKeys: noop, prewarmPersonMerge: noop, prewarmWorkSearch: noop,
    prewarmWorkInfoDetails: noop, prewarmRemoteImagesForWorks: noop, prewarmVideoProbesForWorks: noop,
    rankingMissingSearchWorks: () => [], scheduleBackground: noop,
    searchPeople: () => ({ exact: [], people: [], matchedPersonIds: [] }), storedWorkCodeKey: codeKey,
    workInfoFacetRow: () => null, workInfoRow: () => null, recentWatchedDays: 30,
    resolveLibraryWorkByPublicId: (id) => library.worksById.get(id), resolveLibraryPersonByPublicId: (id) => library.peopleById.get(id)
  };
  const query = createWorkQueryService(shared);
  const filters = createWorkFilterService(shared);
  const sortWorkList = (items, sort) => [...items].sort((left, right) => sort === "progress"
    ? String(progress.getWorkProgress(right)?.updatedAt || "").localeCompare(String(progress.getWorkProgress(left)?.updatedAt || ""))
    : left.title.localeCompare(right.title));
  const detail = createWorkDetailService(shared);
  const people = createPersonDetailService({ ...shared, workQueryService: query,
    actorProfileRow: () => null, publicActorProfile: () => null, actorProfileMergeCandidates: () => [],
    coreMissingWorksForPerson: () => [], corePersonFallbackRecord: () => null, missingActorWorksForPerson: () => [],
    mergedActorMovieRows: () => [], mergedPersonRecord: (value) => value, maxActorAvatarBytes: 1024,
    workCodeKeySetForWorks: () => new Set(works.map((work) => codeKey(work.title))) });
  const collection = createCollectionQueryService({ ...shared, filterWorkList: filters.filter,
    sortWorkList, workFacets: query.lightweightFacets });
  const metadataDb = { prepare(sql) {
    const text = sql.replace(/\s+/g, " ").trim();
    const maker = { maker_id: "1", name: "Fixture Studio", work_count: 2, local_work_count: 2 };
    let rows;
    if (text.includes("(SELECT COUNT(*) FROM makers)")) rows = [{ maker_count: 1, series_count: 0, link_count: 2 }];
    else if (text.includes("FROM makers m") && text.includes("WHERE m.id = ?")) rows = [maker];
    else if (text.includes("FROM series s")) rows = [];
    else if (text.startsWith("SELECT DISTINCT CAST(wm.work_id AS TEXT)")) rows = works.map((work) => ({ work_id: work.id }));
    else if (text.includes("FROM works w") && text.includes("wm.role = 'maker'")) rows = works.map((work) => ({ work_id: work.id, maker_id: "1", maker_name: maker.name }));
    else if (text.includes("FROM collections c") && text.includes("JOIN collection_items ci")) rows = works.map((work, index) => ({
      core_work_id: Number(work.id), code: work.title, code_key: codeKey(work.title), list_type: "top", list_key: "all", rank_no: index + 1 }));
    else if (text.includes("FROM fanhao_images.images")) rows = [];
    else throw new Error(`Unmodeled fixture metadata query: ${text}`);
    return { all: () => structuredClone(rows), get: () => structuredClone(rows[0]) };
  } };
  const catalogDeps = { ...shared, getCoreDb: () => metadataDb, getStamp: () => "metadata:1", getSearchStamp: shared.workQueryStamp,
    publicRemoteUrl: (value) => value || "", filterWorkList: filters.filter, sortWorkList,
    pagedWorksPayload: query.listFromWorksPayload, workFacets: query.lightweightFacets,
    workClassificationService: { filterForRequest: (items) => items, visibilityStamp: () => "1" } };
  const ranking = createRankingService({ ...catalogDeps, localWorkByCodeKey: shared.localSearchWorkByCodeKey,
    localWorkCodeKeys: () => new Set(works.map((work) => codeKey(work.title))), looseWorkCodeKey: codeKey,
    normalizeWorkCode: (value) => value, parseJsonTextArray: () => [], proxiedRemoteImageUrl: (value) => value,
    createId: (prefix, value) => `${prefix}-${value}`, dbBoolOrNull: (value) => value == null ? null : Boolean(value) });
  const studio = createStudioService(catalogDeps);
  const prefix = createCodePrefixService(catalogDeps);
  let holdBody = null;
  const auth = createAuthServices({ authSecretPath: path.join(root, "auth-secret.txt"), accountsDbPath: path.join(root, "accounts.sqlite"),
    remoteWebPassword: "", ensureDataDir: noop, readBodyText, sendJson, sendHtml, redirect });
  const errors = [];
  const app = createRequestHandler({ ...auth, runForUser: scoped.runForUser, attachAccessAnalytics: noop, attachAccessLogger: noop,
    async routeApi(req, res, url) {
      const readJsonBody = async () => {
        const body = JSON.parse((await readBodyText(req)) || "{}");
        if (holdBody && body.fixtureHold) { const hold = holdBody; holdBody = null; hold.enter(); await hold.promise; }
        return body;
      };
      if (await routeUserStateApi(req, res, url, { ...shared, collectionQueryService: collection, readJsonBody,
        resolvePlayableVideoFile: (id) => library.filesById.get(id), sendJson, notFound: () => sendText(res, 404, "missing") })) return true;
      let result;
      if (url.pathname === "/api/library") result = { user: progress.userStateSummary() };
      if (url.pathname === "/api/works") result = query.listPayload(url);
      if (url.pathname === "/api/search") result = query.searchPayload(url);
      if (url.pathname.startsWith("/api/works/")) result = detail.detailPayload(url.pathname.split("/").at(-1));
      if (url.pathname === "/api/people/p1") result = people.detailPayload("p1", url);
      if (url.pathname === "/api/rankings/works") result = ranking.worksPayload(url);
      if (url.pathname === "/api/studios/1") result = studio.detailPayload("1", url);
      if (url.pathname === "/api/code-prefixes/ABC") result = prefix.detailPayload("ABC", url);
      if (result) { sendJson(res, 200, result); return true; }
      return false;
    }, routeMedia: () => false, serveStatic: (_req, res) => sendText(res, 404, "Fixture"),
    sendJson, sendHtml, sendText, logError: (...args) => { errors.push(args); console.error(...args); } });
  let server;
  return { root, legacy, scoped, favorite, progress, query, detail, people, collection, presenter, ranking, studio, prefix, library, errors, originalLegacy,
    pauseNextBody() {
      let release, enter;
      const promise = new Promise((resolve) => { release = resolve; });
      const entered = new Promise((resolve) => { enter = resolve; });
      holdBody = { enter, promise };
      return { entered, release };
    },
    async listen() { server = http.createServer(app); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); return `http://127.0.0.1:${server.address().port}`; },
    async close() {
      if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
      scoped.close(); auth.closeAccounts();
      for (const file of ["accounts.sqlite", "account-user-state.sqlite"]) {
        for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(path.join(root, file + suffix), { force: true });
      }
      for (const file of ["user-state.json", "auth-secret.txt"]) fs.rmSync(path.join(root, file), { force: true });
      fs.rmdirSync(root);
    }
  };
}
