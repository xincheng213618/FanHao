import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { selectVisibleWorks } from "../public/modules/fanhao/features/works/query.js";
import { publicPersonListItem } from "../src/modules/fanhao/server/people/person-list-presenter.js";
import { createWorkInfoService } from "../src/modules/fanhao/server/works/work-info-service.js";
import { createWorkQueryService } from "../src/modules/fanhao/server/works/work-query-service.js";
import { createMediaResponseService } from "../src/platform/server/media-response-service.js";
import { sendJson } from "../src/platform/server/responses.js";
import { createVideoProbeService } from "../src/platform/server/video-probe-service.js";
import { createCoreDbService } from "../src/modules/fanhao/server/library/core-db-service.js";
import { fetchPreparedImage } from "../android-client/www/js/image.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const lines = (relativePath) => read(relativePath).split(/\r?\n/).length;

function captureJsonResponse(payload, acceptEncoding = "") {
  return new Promise((resolve) => {
    const response = {
      req: { headers: { "accept-encoding": acceptEncoding } },
      destroyed: false,
      writableEnded: false,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.writableEnded = true;
        resolve({ status: this.status, headers: this.headers, body: Buffer.from(body) });
      }
    };
    sendJson(response, 200, payload);
  });
}

const indexHtml = read("public/index.html");
const fanhaoEntry = read("public/fanhao-app.js");
const standaloneEntry = read("public/standalone-app.js");
const standaloneHost = read("public/js/standalone-host.js");
const webApp = read("public/app.js");
const peoplePageSource = read("public/modules/fanhao/people-page.js");
assert(indexHtml.includes('import("/fanhao-app.js'), "FanHao must have a dedicated Web entry");
assert(indexHtml.includes('import("/standalone-app.js'), "standalone modules must have a dedicated Web entry");
assert(indexHtml.includes('/^\\/western\\/.+/'), "western detail routes must use the standalone gallery host");
assert(fanhaoEntry.includes('import("./app.js'), "FanHao entry must boot the Web runtime explicitly");
assert(!standaloneEntry.includes("app.js"), "standalone entry must not boot the FanHao runtime");
assert(!standaloneHost.includes("modules/fanhao/"), "standalone host must not load FanHao feature modules");
assert(standaloneHost.includes("loadCurrentModule(initialRoute.view)"), "standalone host must select one module from the current route");
assert(standaloneHost.includes("routeApplication.catch(() => {}).then(() => applyRouteNow(next))"), "standalone history restores must be serialized");
for (const modulePath of ["content-index/gallery-page", "content-index/gallery-renderer", "music/music-page", "novels/novel-page", "tools/tools-page"]) {
  assert(standaloneHost.includes(`modules/${modulePath}.js`), `standalone host must route ${modulePath}`);
  assert(!webApp.includes(`modules/${modulePath}`), `FanHao runtime must not load ${modulePath}`);
}
assert(!webApp.includes("loadStandaloneFactories"), "FanHao runtime must not own standalone factory loading");
assert(!webApp.includes("standaloneFactories"), "FanHao runtime must not retain standalone factories");
assert(webApp.includes("const WORK_RENDER_INITIAL_COUNT = 24"), "FanHao work lists must render a small first batch for responsive interaction");
assert(webApp.includes("WORK_PAGE_SIZE_BY_ACCESS = Object.freeze({ local: 96, lan: 64, remote: 48 })"), "FanHao work APIs must keep page payloads bounded for each access mode");
assert(webApp.includes("Math.min(defaultWorkPageSize, Number(state.accessHints.workPageSize)"), "FanHao clients must not accept oversized work-page hints");
assert(peoplePageSource.includes("let personDetailAbortController = null"), "person navigation must own a cancellable latest request");
assert(peoplePageSource.includes("if (!request.isCurrent() || state.activeView !== \"people\""), "stale person responses must not overwrite newer navigation");
assert(webApp.includes("if (view !== \"people\") peoplePage.cancelPendingSelection()"), "leaving the people view must cancel pending person work");
for (const factoryName of ["createGalleryPage", "createGalleryRenderer", "createNovelPage", "createMusicPage", "createToolsPage"]) {
  assert(!webApp.includes(factoryName), `FanHao runtime must not compose ${factoryName}`);
}
const staticFiles = read("src/platform/server/static-files.js");
for (const alias of ["/novel", "/novel/", "/musics", "/musics/", "/songs", "/songs/"]) {
  assert(staticFiles.includes(`"${alias}"`), `static app fallback must preserve ${alias}`);
}
const responses = read("src/platform/server/responses.js");
assert(responses.includes("const JSON_COMPRESSION_MIN_BYTES = 4 * 1024"), "large API payloads must use negotiated compression");
assert(responses.includes('Vary: "Accept-Encoding"'), "compressed API responses must remain safe for intermediaries");
const responseFixture = { works: Array.from({ length: 256 }, (_, index) => ({ id: index, title: `work-${index}`, path: `person/work-${index}/video.mp4` })) };
const brotliResponse = await captureJsonResponse(responseFixture, "br, gzip");
assert.equal(brotliResponse.headers["Content-Encoding"], "br", "API responses must prefer Brotli when supported");
assert.deepEqual(JSON.parse(brotliDecompressSync(brotliResponse.body)), responseFixture, "Brotli API responses must preserve JSON payloads");
const gzipResponse = await captureJsonResponse(responseFixture, "br;q=0, gzip;q=1");
assert.equal(gzipResponse.headers["Content-Encoding"], "gzip", "API response negotiation must honor disabled encodings");
assert.deepEqual(JSON.parse(gunzipSync(gzipResponse.body)), responseFixture, "Gzip API responses must preserve JSON payloads");
const webRouter = read("public/js/router.js");
assert(webRouter.includes('if (routePath !== "/western") return null'), "exact /western must remain a FanHao people route");
assert(webRouter.includes('return "/gallery/western"'), "western gallery index must keep a refresh-safe standalone URL");
assert(!webRouter.includes("return `/music/artists${query"), "music artist route must not embed its own query string");
assert(!webRouter.includes("return `/music/albums${query"), "music album route must not embed its own query string");
const novelPage = read("public/modules/novels/novel-page.js");
assert(novelPage.includes("if (options.deferInitialLoad)"), "novel host must be able to defer its implicit list request");
assert(standaloneHost.includes("deferInitialLoad: true"), "standalone route restore must own the initial novel and music request");

for (const relativePath of [
  "public/modules/fanhao/index.js",
  "public/modules/fanhao/state.js",
  "public/modules/fanhao/features/works/query.js",
  "public/modules/fanhao/features/works/preview-media.js",
  "android-client/www/modules/fanhao/features/works/cards.js",
  "android-client/www/modules/fanhao/features/works/actions.js",
  "android-client/www/modules/fanhao/features/works/preview-media.js",
  "android-client/www/modules/fanhao/features/rankings/ranking-views.js",
  "src/modules/fanhao/server/composition.js"
]) {
  assert(fs.statSync(path.join(root, relativePath), { throwIfNoEntry: false })?.isFile(), `missing FanHao refactor part: ${relativePath}`);
}

const androidWorkViews = read("android-client/www/modules/fanhao/work-views.js");
const androidApp = read("android-client/www/app.js");
const androidPeopleViews = read("android-client/www/modules/fanhao/people-views.js");
const androidRankingViews = read("android-client/www/modules/fanhao/features/rankings/ranking-views.js");
assert(!androidWorkViews.includes("SEARCH_CHANNELS"), "FanHao Android must not own cross-module search channels");
assert(!/function createWorkCard\s*\(/.test(androidWorkViews), "FanHao Android work cards must stay in their feature module");
assert(!androidWorkViews.includes("createGlobalSearch"), "FanHao Android search must not use a cross-module aggregator");
assert(androidWorkViews.includes("/api/fanhao/search"), "FanHao Android search must use the module-scoped endpoint");
assert(!androidWorkViews.includes("data.channels"), "FanHao Android search must not render results from other modules");
assert(androidWorkViews.includes("createRankingViews"), "FanHao Android rankings must stay in their feature module");
assert(lines("android-client/www/modules/fanhao/work-views.js") <= 750, "FanHao Android work views must stay below 750 lines");
assert(lines("android-client/www/modules/fanhao/features/works/cards.js") <= 320, "FanHao Android work cards must stay focused");
assert(androidApp.includes("const aVisual = imageUrlForPerson(a) ? 1 : 0"), "Android home must recognize compact person-list avatar URLs");
assert(androidPeopleViews.includes("const aVisual = imageUrlForPerson(a) ? 1 : 0"), "Android people sorting must recognize compact person-list avatar URLs");
assert(androidApp.includes("const FAST_WORK_LIMIT = 80"), "Android FanHao work views must request a small interactive first page");
assert(androidApp.includes("const FAST_WORK_STEP = 80"), "Android FanHao work views must grow in bounded pages");
assert(!androidApp.includes("return fast ? 480"), "Android FanHao detail and collection views must not restore oversized initial requests");
assert(androidRankingViews.includes("const PAGE_SIZE = 80"), "Android rankings must request a bounded first page");
assert(androidRankingViews.includes("hasServerMore:"), "Android rankings must preserve server-side continuation");
assert(androidWorkViews.includes("options.hasServerMore"), "Android work rendering must expose server-side continuation");
assert(androidWorkViews.includes("/api/history?limit=${limit}&offset=0"), "Android history must request a bounded first page");
assert(androidWorkViews.includes("const works = data.works || []"), "Android collections must define their rendered work list locally");
const androidDetailViews = read("android-client/www/modules/fanhao/detail-views.js");
assert(androidDetailViews.includes("getWorksLimit()"), "Android person details must use the bounded shared work limit");
assert(androidDetailViews.includes("hasServerMore:"), "Android person details must preserve server-side continuation");
assert(!androidDetailViews.includes("limit=2000"), "Android person details must not fetch every work before first render");
for (const functionName of ["toggleLocalMarker", "deleteLocalFiles", "toggleFavorite", "createPreviewMediaPanel"]) {
  assert(!androidDetailViews.includes(`function ${functionName}(`), `Android detail must delegate ${functionName}`);
}
assert(lines("android-client/www/modules/fanhao/detail-views.js") <= 900, "FanHao Android detail views must stay below 900 lines");

const workDetail = read("public/modules/fanhao/work-detail-page.js");
assert(!/function createPreviewMediaSection\s*\(/.test(workDetail), "Web preview media must stay in its feature module");
assert(workDetail.includes("createWorkPreviewMedia"), "Web work detail must compose the preview feature");
assert(lines("public/modules/fanhao/work-detail-page.js") <= 1000, "Web work detail must stay below 1000 lines");
assert(lines("public/app.js") <= 2500, "FanHao Web composition root must stay below 2500 lines");
assert(lines("public/js/standalone-host.js") <= 650, "standalone Web host must stay below 650 lines");
const peoplePage = read("public/modules/fanhao/people-page.js");
const webRankingPage = read("public/modules/fanhao/ranking-page.js");
const loadMorePeopleSource = /function loadMorePeopleIndex\(\)\s*\{([\s\S]*?)\n\}/.exec(peoplePage)?.[1] || "";
assert(loadMorePeopleSource.includes("loadMoreRow.before(fragment)"), "people pagination must append cards without replacing the grid");
assert(!loadMorePeopleSource.includes("renderPeopleIndex()"), "people pagination must not rerender the full index");
const fanhaoStyles = read("public/modules/fanhao/styles.css");
const personCardStyles = /\.person-index-card\s*\{([\s\S]*?)\n\}/.exec(fanhaoStyles)?.[1] || "";
assert(!personCardStyles.includes("content-visibility"), "people cards must not flash in while scrolling");
assert(webRankingPage.includes("limit: String(rankingPageSize())"), "Web rankings must request a bounded first page");
assert(webRankingPage.includes("loadMoreRankingWorks"), "Web rankings must keep server-side continuation available");
assert(!webRankingPage.includes('limit: "1000"'), "Web rankings must not fetch the entire list before first render");
assert(webApp.includes("hasRankingServerMore"), "Web work rendering must expose ranking continuation");
const webCollectionPage = read("public/modules/fanhao/features/collections/collection-page.js");
assert(webCollectionPage.includes('params.set("limit", String(collectionPageSize()))'), "Web collections must request a bounded first page");
assert(webCollectionPage.includes("loadMoreCollectionWorks"), "Web collections must preserve server-side continuation");
assert(webApp.includes("hasCollectionServerMore"), "Web work rendering must expose collection continuation");
assert(webCollectionPage.includes("loadMoreVrWorks"), "Web VR lists must preserve server-side continuation");
assert(!webCollectionPage.includes('limit: "2000"'), "Web VR lists must not fetch thousands of works before first render");
assert(webApp.includes("hasVrServerMore"), "Web work rendering must expose VR continuation");
const webStudioPage = read("public/modules/fanhao/features/studios/studio-page.js");
assert(webStudioPage.includes("limit: String(studioPageSize())"), "Web studio details must request a bounded first page");
assert(webStudioPage.includes("loadMoreStudioWorks"), "Web studio details must preserve server-side continuation");
assert(!webStudioPage.includes('limit: "2000"'), "Web studio details must not fetch every work before first render");
assert(webApp.includes("hasStudioServerMore"), "Web work rendering must expose studio continuation");
const studioService = read("src/modules/fanhao/server/catalog/studio-service.js");
const rankingServiceSource = read("src/modules/fanhao/server/catalog/ranking-service.js");
assert(studioService.includes("const makers = rows.map(publicMakerSummary)"), "studio index responses must use lightweight maker summaries");
assert(!studioService.includes("rows.map((row) => publicMaker(row, seriesRowsForMaker"), "studio indexes must not run one series query per maker");
assert(studioService.includes("const studioWorksCache = new Map()"), "studio detail paging must reuse versioned work sets");
assert(studioService.includes("sortedByMode: new Map()"), "studio detail paging must reuse sorted work lists");
assert(studioService.includes("ensureDetailCaches(stamp)"), "studio detail caches must follow the catalog version stamp");
assert(!studioService.includes("enrichLocalWorksWithActorMovieIndex(linkRows"), "studio details must not rerun actor-movie code matching for core library works");
assert(rankingServiceSource.includes("prewarmWorkInfoDetails(pageSource)"), "ranking pages must batch-hydrate visible local work metadata");
const workInfoServiceSource = read("src/modules/fanhao/server/works/work-info-service.js");
const workQueryServiceSource = read("src/modules/fanhao/server/works/work-query-service.js");
const workCodeIndexServiceSource = read("src/modules/fanhao/server/works/work-code-index-service.js");
assert(workInfoServiceSource.includes("prewarmDetailRows(workIds"), "work-info details must support page-level batch hydration");
assert(workQueryServiceSource.includes("prewarmWorkInfoDetails(pageSource)"), "work lists must batch-hydrate detail rows before presentation");
assert(workInfoServiceSource.includes("function facetRowsById()"), "work-list facets must use a compact metadata index");
assert(workQueryServiceSource.includes("staticWorkFacets(works);"), "compact work facets must be ready before the first list request");
assert(workQueryServiceSource.includes("prewarmWorkSearch();"), "local and missing-work search indexes must be ready before the first query");
assert(workQueryServiceSource.includes("const exactPersonSearch ="), "exact person searches must bypass the full local text scan");
assert(workCodeIndexServiceSource.includes("localWorkCodeIndexCache = { stamp, keys, rows }"), "local code membership and work lookup must share one catalog pass");
assert(workCodeIndexServiceSource.includes("let workCodeKeysCache = new WeakMap()"), "repeated person and catalog lookups must reuse parsed work code keys");
const workImageServiceSource = read("src/modules/fanhao/server/works/image-service.js");
assert(workImageServiceSource.includes("FROM local_works lw"), "work-cover facets must index only local catalog entries");
assert(!workImageServiceSource.includes("SELECT DISTINCT CAST(owner_id AS TEXT)"), "work-cover facets must not hydrate every historical image owner");
const mediaResponseServiceSource = read("src/platform/server/media-response-service.js");
assert(mediaResponseServiceSource.includes("cachedRemoteImageUrls(remoteUrls)"), "visible work pages must batch-check warmed remote images");
assert(!mediaResponseServiceSource.includes("remoteImageCacheRow(remoteUrl)?.image_blob || remoteImageWarmQueued"), "remote-image warming must not read cached blobs on the response path");
assert(!mediaResponseServiceSource.includes("WHERE image_blob IS NOT NULL AND url IN"), "remote-image warming must use the URL covering index instead of opening cached blobs");

const server = read("server.js");
assert(server.includes("createFanhaoDependencies({"), "server composition must delegate FanHao dependency grouping");
assert(!/fanhao:\s*\{\s*catalog:/s.test(server), "server.js must not own FanHao runtime buckets");
assert(server.includes("if (!missingLocal && !work.coverId && !workHasCoreCover(work.id))"), "catalog facets must use the compact core-cover index");
assert(!server.includes("return !work.coverId && !workCoverRow(work.id);"), "catalog facets must not read cover blobs while counting missing covers");
assert(server.includes("normalized: normalizeSearchValue(normalizedValues.join"), "deep raw metadata must stay out of the pinyin-normalization hot path");
assert(server.includes("function prewarmWorkSearch()"), "local work search text must be prepared before the first query");
const worksRuntime = read("src/modules/fanhao/server/works/runtime.js");
assert(worksRuntime.includes("activeRequestDeps"), "work services must be reused for the active library snapshot");
assert(worksRuntime.includes("workQueryService.prewarm()"), "FanHao work queries must prewarm their full-library enrichment cache before serving requests");
const libraryRuntime = read("src/modules/fanhao/server/library/runtime.js");
const personListServiceSource = read("src/modules/fanhao/server/people/person-list-service.js");
const fanhaoRuntime = read("src/modules/fanhao/server/runtime.js");
assert(libraryRuntime.includes("prewarmLibraryPeoplePayloads(requestDeps())"), "FanHao must prepare people payloads before the first library request");
assert(personListServiceSource.includes("const mainPeopleCache = new Map()"), "main and western people scopes must remain cached independently");
assert(fanhaoRuntime.includes("library.start();"), "FanHao startup must prewarm the library response path");
const workInfoService = read("src/modules/fanhao/server/works/work-info-service.js");
const workPresenterService = read("src/modules/fanhao/server/works/presenter-service.js");
const workMediaRoutes = read("src/modules/fanhao/server/works/routes-media.js");
const coreDbService = read("src/modules/fanhao/server/library/core-db-service.js");
const userStateRoutes = read("src/modules/fanhao/server/user-state/routes.js");
assert(workInfoService.includes("function detailRow(workId)"), "work metadata must load full details per work instead of hydrating the entire catalog");
assert(workInfoService.includes("SELECT 1\n              FROM local_works"), "work-list metadata must use a lightweight local-work index query");
assert(workPresenterService.includes("workInfoDetailRow(work.id)"), "work cards and details must hydrate full metadata only for the visible page");
assert(workMediaRoutes.includes("/media\\/person\\/([^/]+)\\/cover"), "person-list avatars must use a stable compact media URL");
assert(coreDbService.includes("const DEFAULT_TABLE_STAMP_CACHE_MS = 5000"), "FanHao table stamps must not rescan the core database between nearby interactions");
assert(coreDbService.includes("idx_works_updated_at ON works(updated_at)"), "work-info stamps must use a lightweight updated-at index");
assert(coreDbService.includes("idx_work_people_updated_at ON work_people(updated_at)"), "actor-movie stamps must use a lightweight updated-at index");
assert(userStateRoutes.includes("allWorks.slice(offset, offset + limit)"), "favorites must paginate before presenting work details");
assert(userStateRoutes.includes("entries.slice(offset, offset + limit)"), "history must paginate before presenting work details");
const serviceLauncher = read("start-fanhao.ps1");
assert(
  /if \(-not \$ready\)[\s\S]*Stop-Process -Id \$process\.Id -Force/.test(serviceLauncher),
  "FanHao launcher must stop a startup process that never opens its port"
);
const serverRootFiles = fs.readdirSync(path.join(root, "src/modules/fanhao/server"), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
  .map((entry) => entry.name)
  .sort();
assert.deepEqual(serverRootFiles, ["composition.js", "runtime.js"], "FanHao server root must contain only composition files");
for (const feature of ["admin", "catalog", "collections", "library", "people", "playback", "user-state", "works"]) {
  assert(fs.statSync(path.join(root, "src/modules/fanhao/server", feature), { throwIfNoEntry: false })?.isDirectory(), `missing FanHao server feature: ${feature}`);
}

const works = [
  { id: "older", title: "BBB", missingLocal: false, infoSummary: { releaseDate: "2024-01-01" } },
  { id: "newer", title: "AAA", missingLocal: true, infoSummary: { releaseDate: "2025-01-01" } }
];
assert.deepEqual(
  selectVisibleWorks(works, { showCompilationWorks: true, showMissingLocalWorks: true, sortMode: "releaseDesc" }).map((work) => work.id),
  ["newer", "older"],
  "FanHao work query must preserve release ordering"
);
assert.deepEqual(
  selectVisibleWorks(works, { showCompilationWorks: true, showMissingLocalWorks: false }).map((work) => work.id),
  ["older"],
  "FanHao work query must preserve missing-local filtering"
);

const personListItem = publicPersonListItem({
  id: "27",
  name: "Person",
  relativePath: "G:/Person",
  sourcePaths: ["G:/Person", "O:/Person"],
  sourceCount: 2,
  workCount: 9,
  videoCount: 10,
  playableCount: 8,
  imageCount: 3,
  infoCount: 4,
  coverId: "long-local-image-id",
  avatarImage: { sourceAvatarUrl: "G:/Person/cover.jpg" },
  actorProfile: {
    personName: "Person",
    displayName: "Display Person",
    aliases: ["Alias"],
    gender: "female",
    movieCount: 12,
    javdbUrl: "https://example.invalid/person",
    javdbRefs: [{ id: "large-detail" }],
    updatedAt: "2026-07-17"
  }
});
assert.equal(personListItem.avatarUrl, "/media/person/27/cover", "person-list fallback covers must not expose long file identifiers");
assert.equal(personListItem.actorProfile.displayName, "Display Person", "person-list summaries must preserve display names");
assert(!("sourcePaths" in personListItem), "person-list summaries must defer source paths until person detail is opened");
assert(!("avatarImage" in personListItem), "person-list summaries must defer avatar metadata until person detail is opened");
assert(!("javdbRefs" in personListItem.actorProfile), "person-list summaries must defer full actor metadata until person detail is opened");

let workInfoDetailStamp = "detail-v1";
let workInfoDetailPrepareCount = 0;
let workInfoDetailArgs = [];
const batchedWorkInfoService = createWorkInfoService({
  getStamp: () => workInfoDetailStamp,
  getCoreDb: () => ({
    prepare(sql) {
      workInfoDetailPrepareCount += 1;
      assert(sql.includes("w.id IN (?, ?)"), "work-info batch queries must bind one placeholder per work");
      return {
        all(...ids) {
          workInfoDetailArgs = ids;
          return ids.map((id) => ({ work_id: String(id), title: `Work ${id}` }));
        }
      };
    }
  })
});
batchedWorkInfoService.prewarmDetailRows(["1", "2"]);
batchedWorkInfoService.prewarmDetailRows(["1", "2"]);
assert.equal(workInfoDetailPrepareCount, 1, "repeated work pages must reuse batch-hydrated detail rows");
assert.deepEqual(workInfoDetailArgs, [1, 2], "work-info batches must pass normalized numeric identifiers");
assert.equal(batchedWorkInfoService.detailRow("1")?.title, "Work 1", "single-work reads must reuse the batch detail cache");

let actorMovieDataStamp = "actor-v1";
let enrichmentCount = 0;
let workInfoReadCount = 0;
let workInfoFacetReadCount = 0;
const queryWork = {
  id: "work-1",
  personId: "person-1",
  title: "ABC-001",
  directoryName: "ABC-001",
  modifiedAt: "2026-07-16T00:00:00.000Z",
  videos: [],
  images: [],
  infos: [],
  missingLocal: false,
  playableCount: 0,
  infoCount: 0
};
const workQueryService = createWorkQueryService({
  actorMovieStamp: () => actorMovieDataStamp,
  actorMissingSearchWorks: () => [],
  clampInteger: (value, fallback, min, max) => Math.max(min, Math.min(max, Number(value ?? fallback))),
  createWorkSearchMatcher: () => () => false,
  dedupeWorksForDisplay: (items) => items,
  defaultWorkLimit: 24,
  enrichLocalWorksWithActorMovieIndex(items) {
    enrichmentCount += 1;
    return items;
  },
  fastMissingCodeSearch: () => [],
  favoriteStateService: { isFavoriteWork: () => false },
  isVrWork: () => false,
  library: { scannedAt: "library-v1", worksById: new Map([[queryWork.id, queryWork]]) },
  maxWorkLimit: 1000,
  peopleScopeService: { normalize: () => "main", workMatches: () => true },
  playbackProgressService: { getWorkProgress: () => null },
  prewarmLocalWorkCodeKeys() {},
  prewarmRemoteImagesForWorks() {},
  publicPerson: (person) => person,
  publicWork: (work) => ({ id: work.id }),
  publicWorkAvailability: () => ({ hasMagnet: false }),
  rankingMissingSearchWorks: () => [],
  searchPeople: () => ({ exact: [], matchedPersonIds: [], people: [] }),
  storedWorkCodeKey: (value) => String(value || "").replace(/[^A-Za-z0-9]/g, "").toLowerCase(),
  workHasCoreCover: () => false,
  workHasLocalMarker: () => false,
  workInfoFacetRow: () => {
    workInfoFacetReadCount += 1;
    return null;
  },
  workInfoRow: () => {
    workInfoReadCount += 1;
    return null;
  },
  workQueryStamp: () => actorMovieDataStamp,
  workRating: () => null,
  workRatingCount: () => 0,
  workReleaseDate: () => ""
});
const workListUrl = new URL("http://127.0.0.1/api/works?limit=24&sort=updated");
workQueryService.prewarm();
assert.equal(workInfoReadCount, 0, "FanHao startup prewarm must not hydrate full work-info facets before the server listens");
assert.equal(workInfoFacetReadCount, 1, "FanHao startup prewarm must hydrate only the compact work-info facet index");
workQueryService.listPayload(workListUrl);
workQueryService.listPayload(workListUrl);
assert.equal(enrichmentCount, 1, "repeated FanHao work-list requests must reuse the prewarmed full-library enrichment");
actorMovieDataStamp = "actor-v2";
workQueryService.listPayload(workListUrl);
assert.equal(enrichmentCount, 2, "actor-movie updates must invalidate the FanHao work-list enrichment cache");

let cachedLocalImageRow = null;
let localImageStatCount = 0;
let localImageReadCount = 0;
let resolveLocalImageRead;
const pendingLocalImageRead = new Promise((resolve) => {
  resolveLocalImageRead = resolve;
});
const testLocalImage = {
  id: "slow-cover",
  path: "G:/slow/cover.jpg",
  relativePath: "slow/cover.jpg",
  ext: ".jpg",
  size: 3,
  modifiedAt: "2026-07-17T00:00:00.000Z"
};
const mediaResponseService = createMediaResponseService({
  coreImageRow: () => null,
  corePersonAvatarRow: () => null,
  getCoreDb: () => ({
    prepare(sql) {
      return {
        get: () => cachedLocalImageRow,
        run(...args) {
          if (sql.includes("image_blob") && Buffer.isBuffer(args[4])) {
            cachedLocalImageRow = {
              content_type: args[3],
              image_blob: args[4],
              byte_length: args[5]
            };
          }
        }
      };
    }
  }),
  isAllowedRemoteImageUrl: () => true,
  localImageReadConcurrency: 1,
  localImageWaitMs: 1,
  maxRemoteImageBytes: 1024,
  mimeTypes: { ".jpg": "image/jpeg" },
  normalizeExt: (value) => path.extname(value),
  notFound: (res) => {
    res.writeHead(404);
    res.end();
  },
  proxiedRemoteImageUrl: (value) => value,
  publicRemoteUrl: (value) => value,
  readFile: async () => {
    localImageReadCount += 1;
    return pendingLocalImageRead;
  },
  safeStat: () => null,
  sendText: (res, statusCode, body) => {
    res.writeHead(statusCode);
    res.end(body);
  },
  statFile: async () => {
    localImageStatCount += 1;
    return {
      isFile: () => true,
      mtime: new Date(testLocalImage.modifiedAt),
      size: testLocalImage.size
    };
  },
  warn: () => {},
  workCoverRow: () => null
});
function testImageResponse() {
  return {
    body: null,
    headers: null,
    statusCode: null,
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = null) {
      this.body = body;
    }
  };
}
const firstSlowImageResponse = testImageResponse();
await Promise.race([
  mediaResponseService.servePreparedImage(firstSlowImageResponse, testLocalImage),
  new Promise((_, reject) => setTimeout(() => reject(new Error("slow local image blocked the request loop")), 100))
]);
assert.equal(firstSlowImageResponse.statusCode, 503, "slow FanHao covers must return a bounded preparation response");
assert.equal(firstSlowImageResponse.headers["X-FanHao-Image-Prepare"], "pending", "slow FanHao covers must expose a retryable preparation state");

const duplicateSlowImageResponse = testImageResponse();
await mediaResponseService.servePreparedImage(duplicateSlowImageResponse, testLocalImage);
assert.equal(duplicateSlowImageResponse.statusCode, 503, "duplicate slow-cover requests must remain bounded");
assert.equal(localImageStatCount, 1, "duplicate slow-cover requests must share one stat operation");
assert.equal(localImageReadCount, 1, "duplicate slow-cover requests must share one file read");

const queuedSlowImageResponse = testImageResponse();
await mediaResponseService.servePreparedImage(queuedSlowImageResponse, { ...testLocalImage, id: "queued-cover" });
assert.equal(queuedSlowImageResponse.statusCode, 503, "queued slow-cover requests must remain bounded");
assert.equal(localImageStatCount, 1, "cold-cover reads beyond the concurrency limit must remain queued");
assert.equal(localImageReadCount, 1, "cold-cover reads beyond the concurrency limit must not hit disk early");

resolveLocalImageRead(Buffer.from([1, 2, 3]));
for (let attempt = 0; attempt < 10 && localImageReadCount < 2; attempt += 1) {
  await new Promise((resolve) => setImmediate(resolve));
}
assert(cachedLocalImageRow, "completed slow-cover reads must populate the local image cache");
assert.equal(localImageStatCount, 2, "the local-cover queue must continue after an active read completes");
assert.equal(localImageReadCount, 2, "the local-cover queue must eventually read queued covers");
const cachedImageResponse = testImageResponse();
await mediaResponseService.servePreparedImage(cachedImageResponse, testLocalImage);
assert.equal(cachedImageResponse.statusCode, 200, "prepared FanHao covers must serve from cache on retry");
assert.deepEqual(cachedImageResponse.body, Buffer.from([1, 2, 3]), "prepared FanHao covers must preserve image bytes");

const originalFetch = globalThis.fetch;
let preparedImageFetchCount = 0;
globalThis.fetch = async () => {
  preparedImageFetchCount += 1;
  if (preparedImageFetchCount < 3) {
    return new Response(null, {
      status: 503,
      headers: { "X-FanHao-Image-Prepare": "pending" }
    });
  }
  return new Response(Buffer.from([4, 5, 6]), { status: 200 });
};
try {
  const preparedImageResponse = await fetchPreparedImage("http://127.0.0.1/media/image/slow-cover", {}, { retryDelaysMs: [0, 0] });
  assert.equal(preparedImageResponse.status, 200, "Android must retry a FanHao cover while the server prepares it");
  assert.equal(preparedImageFetchCount, 3, "Android prepared-cover retries must remain bounded and stop after success");
  preparedImageFetchCount = 0;
  globalThis.fetch = async () => {
    preparedImageFetchCount += 1;
    return new Response(null, { status: 503 });
  };
  const ordinaryFailureResponse = await fetchPreparedImage("http://127.0.0.1/media/image/unavailable-cover", {}, { retryDelaysMs: [0, 0] });
  assert.equal(ordinaryFailureResponse.status, 503, "Android must preserve ordinary image failures");
  assert.equal(preparedImageFetchCount, 1, "Android must only retry explicitly prepared FanHao covers");
} finally {
  globalThis.fetch = originalFetch;
}

let videoProbeStatCount = 0;
let videoProbeExecCount = 0;
let resolveVideoProbeStat;
const pendingVideoProbeStat = new Promise((resolve) => {
  resolveVideoProbeStat = resolve;
});
const videoProbeService = createVideoProbeService({
  directVideoExts: new Set([".mp4", ".m4v", ".webm"]),
  execFileFn: (_command, _args, _options, callback) => {
    videoProbeExecCount += 1;
    callback(null, JSON.stringify({
      format: { duration: "123.5" },
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
        { codec_type: "audio", codec_name: "aac" }
      ]
    }));
  },
  ffprobePath: "ffprobe",
  hasNvenc: false,
  probeWaitMs: 1,
  safeStat: () => null,
  statFile: async () => {
    videoProbeStatCount += 1;
    return pendingVideoProbeStat;
  }
});
const slowVideoFile = { id: "slow-video", path: "G:/slow/video.mp4", ext: ".mp4", type: "video" };
const firstPlayInfo = await Promise.race([
  videoProbeService.playInfoForFileAsync(slowVideoFile),
  new Promise((_, reject) => setTimeout(() => reject(new Error("slow video probe blocked the request loop")), 100))
]);
assert.equal(firstPlayInfo.mode, "direct", "slow direct-video probes must return a usable fallback");
assert.equal(firstPlayInfo.probePending, true, "slow video probes must expose their background preparation state");
const duplicatePlayInfo = await videoProbeService.playInfoForFileAsync(slowVideoFile);
assert.equal(duplicatePlayInfo.probePending, true, "duplicate slow video probes must remain bounded");
assert.equal(videoProbeStatCount, 1, "duplicate video-probe requests must share one file stat");
assert.equal(videoProbeExecCount, 0, "ffprobe must wait for the asynchronous file stat");

resolveVideoProbeStat({ size: 1024, mtimeMs: 12345 });
for (let attempt = 0; attempt < 10 && videoProbeExecCount < 1; attempt += 1) {
  await new Promise((resolve) => setImmediate(resolve));
}
assert.equal(videoProbeExecCount, 1, "the background video probe must continue after the API fallback returns");
const cachedPlayInfo = await videoProbeService.playInfoForFileAsync(slowVideoFile);
assert.equal(cachedPlayInfo.probePending, false, "completed video probes must serve from cache");
assert.equal(cachedPlayInfo.duration, 123.5, "completed video probes must preserve duration metadata");
assert.equal(cachedPlayInfo.videoCodec, "h264", "completed video probes must preserve codec metadata");

let stampNow = 1000;
let synchronousStampReads = 0;
let backgroundStampReads = 0;
let fakeDataVersion = 1;
let resolveBackgroundStamp;
const backgroundStamp = new Promise((resolve) => {
  resolveBackgroundStamp = resolve;
});
const fakeCoreDb = {
  exec() {},
  prepare(sql) {
    if (sql.startsWith("PRAGMA table_info")) {
      return {
        all: () => [
          { name: "gender" },
          { name: "has_magnet" },
          { name: "is_streamable" },
          { name: "has_subtitles" },
          { name: "javdb_tags_json" },
          { name: "image_blob" }
        ]
      };
    }
    if (sql === "PRAGMA data_version") {
      return { get: () => ({ data_version: fakeDataVersion }) };
    }
    return {
      get() {
        synchronousStampReads += 1;
        return { max_rowid: 1 };
      }
    };
  }
};
const backgroundStampCoreDb = createCoreDbService({
  createDatabase: () => fakeCoreDb,
  dbPath: "fake.sqlite",
  ensureDataDir() {},
  now: () => stampNow,
  refreshTableStampRow: async () => {
    backgroundStampReads += 1;
    return backgroundStamp;
  },
  tableStampCacheMs: 5,
  warn() {}
});
const initialWorkInfoStamp = backgroundStampCoreDb.tableDataStamp("work_info");
assert.equal(synchronousStampReads, 1, "the first table stamp must establish a synchronous startup baseline");
stampNow += 10;
assert.equal(backgroundStampCoreDb.tableDataStamp("work_info"), initialWorkInfoStamp, "stale table stamps must return their cached value immediately");
assert.equal(backgroundStampCoreDb.tableDataStamp("work_info"), initialWorkInfoStamp, "nearby stale reads must share one background refresh");
await new Promise((resolve) => setImmediate(resolve));
assert.equal(synchronousStampReads, 1, "stale table stamps must not query SQLite on the request thread");
assert.equal(backgroundStampReads, 1, "stale table stamps must deduplicate background refreshes");
fakeDataVersion = 2;
resolveBackgroundStamp({ data_version: fakeDataVersion, max_rowid: 2 });
for (let attempt = 0; attempt < 10 && backgroundStampCoreDb.tableDataStamp("work_info") === initialWorkInfoStamp; attempt += 1) {
  await new Promise((resolve) => setImmediate(resolve));
}
const refreshedWorkInfoStamp = backgroundStampCoreDb.tableDataStamp("work_info");
assert.notEqual(refreshedWorkInfoStamp, initialWorkInfoStamp, "background stamp refreshes must publish external database changes");
backgroundStampCoreDb.invalidateTableStamp("work_info");
const invalidatedWorkInfoStamp = backgroundStampCoreDb.tableDataStamp("work_info");
assert.notEqual(invalidatedWorkInfoStamp, refreshedWorkInfoStamp, "explicit mutations must invalidate dependent caches immediately");
assert.equal(synchronousStampReads, 1, "explicit stamp invalidation must not fall back to a synchronous SQLite query");

console.log("fanhao-structure: ok");
