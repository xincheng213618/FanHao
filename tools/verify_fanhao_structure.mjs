import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { selectVisibleWorks } from "../public/modules/fanhao/features/works/query.js";
import { createWorkActions } from "../public/modules/fanhao/features/works/work-actions.js";
import { createViewportBatchRenderer } from "../public/modules/fanhao/features/works/viewport-batch-renderer.js";
import { createCollectionPage } from "../public/modules/fanhao/features/collections/collection-page.js";
import { createPlaybackPrefetch } from "../public/modules/fanhao/playback-prefetch.js";
import { createSearchRequestService } from "../public/modules/fanhao/search-request-service.js";
import { createLazyPersonProfile } from "../public/modules/fanhao/lazy-person-profile.js";
import { createLazyAdminModal } from "../public/modules/system/lazy-admin-modal.js";
import { publicPersonListItem } from "../src/modules/fanhao/server/people/person-list-presenter.js";
import { createPersonDetailService } from "../src/modules/fanhao/server/people/person-detail-service.js";
import { createPersonMergeService } from "../src/modules/fanhao/server/people/person-merge-service.js";
import { createPlaybackProgressService } from "../src/modules/fanhao/server/playback/playback-progress-service.js";
import { createRankingService } from "../src/modules/fanhao/server/catalog/ranking-service.js";
import { createStudioService } from "../src/modules/fanhao/server/catalog/studio-service.js";
import { createCollectionQueryService, prepareCollectionWorkPage } from "../src/modules/fanhao/server/user-state/collection-query-service.js";
import { createWorkInfoService } from "../src/modules/fanhao/server/works/work-info-service.js";
import { createWorkImageService } from "../src/modules/fanhao/server/works/image-service.js";
import { createWorkDetailService } from "../src/modules/fanhao/server/works/work-detail-service.js";
import { createMissingCodeSearchService } from "../src/modules/fanhao/server/works/missing-code-search-service.js";
import { createWorkQueryService } from "../src/modules/fanhao/server/works/work-query-service.js";
import { createWorkClassificationService } from "../src/modules/fanhao/server/works/work-classification-service.js";
import { createWorkSearchIndexService } from "../src/modules/fanhao/server/works/work-search-index-service.js";
import { createMediaResponseService } from "../src/platform/server/media-response-service.js";
import { sendJson } from "../src/platform/server/responses.js";
import { createVideoProbeCacheService } from "../src/platform/server/video-probe-cache-service.js";
import { createVideoProbeService, DEFAULT_VIDEO_PROBE_WAIT_MS } from "../src/platform/server/video-probe-service.js";
import { createCoreDbService } from "../src/modules/fanhao/server/library/core-db-service.js";
import { tableStampValue } from "../src/modules/fanhao/server/library/table-stamp-query.js";
import { fetchPreparedImage } from "../android-client/www/js/image.js";
import { createWorkListState } from "../android-client/www/js/work-filtering.js";
import { createWorkCoverLoader } from "../android-client/www/modules/fanhao/features/works/cover-loader.js";
import { createWorkPageDataService } from "../android-client/www/modules/fanhao/features/works/page-data-service.js";
import { createWorkDetailDataService } from "../android-client/www/modules/fanhao/features/works/detail-data-service.js";
import { createProgressiveWorkListRenderer } from "../android-client/www/modules/fanhao/features/works/progressive-list-renderer.js";

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
const lazyAdminModalSource = read("public/modules/system/lazy-admin-modal.js");
const webApp = read("public/app.js");
const peoplePageSource = read("public/modules/fanhao/people-page.js");
const personProfileSource = read("public/modules/fanhao/person-profile.js");
const fanhaoModuleIndexSource = read("public/modules/fanhao/index.js");
const latestRequestSource = read("public/modules/fanhao/latest-request.js");
const lazyPersonProfileSource = read("public/modules/fanhao/lazy-person-profile.js");
const searchRequestSource = read("public/modules/fanhao/search-request-service.js");
const rankingPageSource = read("public/modules/fanhao/ranking-page.js");
const studioPageSource = read("public/modules/fanhao/features/studios/studio-page.js");
const collectionPageSource = read("public/modules/fanhao/features/collections/collection-page.js");
const playbackPrefetchSource = read("public/modules/fanhao/playback-prefetch.js");
const playerPageSource = read("public/js/player-page.js");
const playerHtmlSource = read("public/player.html");
const workActionsSource = read("public/modules/fanhao/features/works/work-actions.js");
const viewportBatchRendererSource = read("public/modules/fanhao/features/works/viewport-batch-renderer.js");
const workDetailServiceSource = read("src/modules/fanhao/server/works/work-detail-service.js");
const missingCodeSearchServiceSource = read("src/modules/fanhao/server/works/missing-code-search-service.js");
const workRoutesApiSource = read("src/modules/fanhao/server/works/routes-api.js");
const workPresenterServiceSource = read("src/modules/fanhao/server/works/presenter-service.js");
const playbackProgressServiceSource = read("src/modules/fanhao/server/playback/playback-progress-service.js");
const personDetailServiceSource = read("src/modules/fanhao/server/people/person-detail-service.js");
const personMergeServiceSource = read("src/modules/fanhao/server/people/person-merge-service.js");
const workDetailPageSource = read("public/modules/fanhao/work-detail-page.js");
const videoProbeCacheSource = read("src/platform/server/video-probe-cache-service.js");
const videoProbeSource = read("src/platform/server/video-probe-service.js");
assert(indexHtml.includes('import("/fanhao-app.js'), "FanHao must have a dedicated Web entry");
assert(indexHtml.includes('import("/standalone-app.js'), "standalone modules must have a dedicated Web entry");
assert(indexHtml.includes('/^\\/western\\/.+/'), "western detail routes must use the standalone gallery host");
const fanhaoStyleList = indexHtml.match(/const fanhaoStyleUrls = \[([\s\S]*?)\n\s*\];/)?.[1] || "";
assert(fanhaoStyleList.includes("/modules/fanhao/styles.css") && fanhaoStyleList.includes("/modules/fanhao/work-cards.css"), "FanHao routes must load their module styles directly");
assert(fanhaoStyleList.includes("/modules/system/admin.css") && fanhaoStyleList.includes("/css/responsive.css"), "FanHao routes must retain shared admin and responsive styles");
for (const unrelatedStyle of ["/modules/novels/", "/modules/content-index/", "/modules/tools/", "/modules/short-videos/", "/modules/music/"]) {
  assert(!fanhaoStyleList.includes(unrelatedStyle), `FanHao startup must not load unrelated styles: ${unrelatedStyle}`);
}
assert(indexHtml.includes(": standaloneStyleEntry") && indexHtml.includes(": fanhaoStyleUrls;"), "only standalone modules should fall back to the full style graph");
assert(fanhaoEntry.includes('import("./app.js'), "FanHao entry must boot the Web runtime explicitly");
assert(indexHtml.includes('/fanhao-app.js?v=20260717-photo-library-workspace-01'), "workspace changes must refresh the FanHao browser entry");
assert(indexHtml.includes('/modules/fanhao/work-cards.css?v=20260717-fanhao-viewport-render-01'), "viewport rendering styles must use a fresh browser URL");
assert(fanhaoEntry.includes('app.js?v=20260717-photo-library-workspace-01'), "workspace changes must refresh the FanHao app module");
assert(webApp.includes('index.js?v=20260717-fanhao-viewport-render-01'), "viewport rendering changes must refresh the FanHao module barrel");
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
assert(webApp.includes("createLazyAdminModal") && webApp.includes('await import("./modules/system/admin-modal.js?v='), "FanHao startup must defer the admin console module until the first admin action");
assert(!webApp.includes('import { createAdminModal }'), "FanHao startup must not statically import the admin console");
assert(lazyAdminModalSource.includes("let instancePromise = null") && lazyAdminModalSource.includes("instancePromise = null") && lazyAdminModalSource.includes("const lazyModal = { load }"), "lazy admin loading must deduplicate concurrent opens and remain retryable after an import failure");
assert(webApp.includes("bindLazyAdminModal({ adminModal, els, openAdminScript, state })") && lazyAdminModalSource.includes("export function bindLazyAdminModal"), "admin event wiring must stay with the lazy admin boundary instead of growing the composition root");
assert(webApp.includes("createLazyPersonProfile") && webApp.includes('await import("./modules/fanhao/person-profile.js?v='), "FanHao startup must defer person-profile code until person interaction");
assert(!fanhaoModuleIndexSource.includes("createPersonProfile"), "the FanHao barrel must not pull person-profile code into the people index startup graph");
assert(!fanhaoModuleIndexSource.includes("createWorkDetailPage"), "the FanHao barrel must not pull the retired work drawer into the startup graph");
assert(!webApp.includes("createWorkDetailPage") && webApp.includes("createWorkActions"), "the FanHao composition root must use focused work actions without composing the retired drawer");
assert(webApp.includes("toggleFavorite(work.id, favorite)"), "work cards must expose immediate favorite-control feedback while the API is pending");
assert(webApp.includes("onCollectionStateChanged: () => collectionPage.invalidatePrefetches()") && workActionsSource.includes("onCollectionStateChanged();"), "favorite changes must invalidate prefetched collection pages");
assert(webApp.includes('window.open(playerPageUrl(work.id), "_blank", "noopener")'), "work cards must keep opening the standalone player");
assert(webApp.includes("playbackPrefetch.bindContainer(els.workGrid)") && webApp.includes("cover.dataset.playbackWorkId") && webApp.includes("body.dataset.playbackWorkId"), "work-card primary targets must delegate playback preparation through the persistent grid");
assert(!webApp.includes("playbackPrefetch.bind(cover") && !webApp.includes("playbackPrefetch.bind(body"), "work cards must not attach playback listeners per rendered card");
assert(webApp.includes("void playbackPrefetch.prepare(work.id)") && playbackPrefetchSource.includes("playback-prewarm"), "work-card activation must overlap player navigation with probe preparation");
assert(playbackPrefetchSource.includes('container.addEventListener("pointerover"') && playbackPrefetchSource.includes('container.addEventListener("focusin"') && playbackPrefetchSource.includes('container.addEventListener("pointerdown"'), "desktop hover, keyboard focus, and touch press must share delegated playback preparation");
assert(webApp.includes("const activeCoverImages = new Set()") && webApp.includes("bindProgressiveCoverLifecycle(els.workGrid)") && webApp.includes("if (!root.contains(img)) cancelActiveCoverImage(img)"), "detaching a work card must immediately retire its active cover request");
assert(webApp.includes('img.dataset.coverCancelled = "1"') && webApp.includes('img.removeAttribute("src")'), "leaving a work view must cancel cover requests that belong to the retired DOM");
assert(webApp.includes('img.dataset.coverCancelled === "1"') && webApp.includes("activeCoverImages.delete(img)"), "cancelled cover requests must not retry or retain active lifecycle entries");
assert(workRoutesApiSource.includes("playbackPrewarmPayload") && workRoutesApiSource.includes("/playback-prewarm$"), "FanHao must expose a focused playback-prewarm route");
assert(workDetailServiceSource.includes("replaceQueued: true") && workDetailServiceSource.includes("concurrency: 3"), "playback intent must take priority over speculative list probes without awaiting them");
assert(workDetailServiceSource.includes("const detailCache = new Map()") && workDetailServiceSource.includes("detailCacheStamp"), "work details must stay reusable across card intent and player startup");
assert(workDetailServiceSource.includes("const detail = detailPayload(workId)") && workDetailServiceSource.includes("detailReady: true"), "playback preparation must hydrate the complete work detail before player navigation");
assert(workDetailServiceSource.includes("const libraryFile = preferGallery ? null : library.filesById.get(videoId)"), "FanHao play-info must use the O(1) library file index before touching the gallery catalog");
assert(workRoutesApiSource.includes('source: url.searchParams.get("source") || "fanhao"'), "play-info routing must carry an explicit media source boundary");
assert(playerPageSource.includes('mediaId ? "?source=gallery" : ""'), "the standalone gallery player must explicitly select gallery play-info lookup");
assert(playerHtmlSource.includes("player-page.js?v=20260717-fanhao-playinfo-01"), "play-info lookup changes must refresh the standalone player module");
assert(workActionsSource.includes("captureFavoriteSnapshot") && workActionsSource.includes("restoreFavoriteSnapshot"), "optimistic favorite feedback must roll back cleanly after API failures");
assert(peoplePageSource.includes("const personIndexRecords = new WeakMap()") && peoplePageSource.includes("bindPeopleIndexInteractions();"), "person cards must keep navigation records behind one persistent interaction surface");
assert(peoplePageSource.includes('root.addEventListener("pointerover"') && peoplePageSource.includes('root.addEventListener("focusin"') && peoplePageSource.includes('root.addEventListener("pointerdown"'), "person cards must delegate mouse, keyboard, and touch preparation");
assert(!peoplePageSource.includes('card.addEventListener("click"') && !peoplePageSource.includes('card.addEventListener("pointerenter"') && !peoplePageSource.includes('card.addEventListener("pointerdown"'), "person cards must not allocate navigation and preparation listeners per item");
assert(peoplePageSource.includes("preparePersonProfile?.()") && peoplePageSource.includes("prefetchPersonDetails(person.id)"), "delegated person intent must prepare profile code and the exact detail request");
assert(lazyPersonProfileSource.includes("renderVersion") && lazyPersonProfileSource.includes("version !== renderVersion"), "late profile modules must not render after navigation invalidates them");
assert(viewportBatchRendererSource.includes("const DEFAULT_INITIAL_COUNT = 12"), "FanHao work lists must render only the above-fold cards before yielding");
assert(viewportBatchRendererSource.includes("const DEFAULT_BATCH_SIZE = 12"), "FanHao work lists must keep follow-up DOM tasks bounded");
assert(viewportBatchRendererSource.includes("const DEFAULT_LOOKAHEAD_DISTANCE = 720"), "FanHao work lists must limit client-side DOM expansion to the viewport lookahead");
assert(viewportBatchRendererSource.includes("observer.observe(sentinel)"), "FanHao work lists must append offscreen card batches only when their sentinel approaches the viewport");
assert(webApp.includes("els.workGrid.insertBefore(fragment, beforeNode)"), "FanHao work batches must stay ahead of the viewport sentinel");
assert(webApp.includes("const COVER_LOAD_BATCH_SIZE = 8"), "FanHao work covers must keep decode and request bursts bounded");
assert(webApp.includes("const COVER_EAGER_COUNT = 12"), "FanHao work lists must eagerly load only the above-fold covers");
assert(webApp.includes('const COVER_OBSERVER_ROOT_MARGIN = "420px 0px"'), "FanHao work covers must preload only a nearby row beyond the viewport");
assert(webApp.includes("img.dataset.coverIndex = String(index)"), "FanHao work covers must retain their absolute card priority across render batches");
assert(webApp.includes("activateProgressiveCoverImages(images)"), "FanHao work batches must schedule only newly attached covers");
assert(!webApp.includes("activateProgressiveCoverImages(els.workGrid)"), "FanHao work batches must not rescan every previously rendered cover");
assert(webApp.includes("const observer = new IntersectionObserver") && webApp.includes('rootMargin: `${WORK_AUTO_LOAD_DISTANCE}px 0px`'), "work continuation must load when its sentinel approaches the viewport");
assert(!webApp.includes("userScrollIntentUntil") && !webApp.includes("const movedDown = nextScrollY > lastScrollY + 1"), "work continuation must not depend on a short-lived input-intent window");
assert(webApp.includes('trigger.dataset.autoConsumed = "1"') && webApp.includes("observer?.disconnect();"), "one continuation sentinel must trigger at most one server page");
assert(!webApp.includes("WORK_AUTO_LOAD_RECHECK_DELAYS"), "work rendering must not schedule autonomous load-more cascades");
assert(!webApp.includes("workLoadMoreObserver"), "work continuation observers must stay scoped to their rendered sentinel");
assert(webApp.includes("const moduleNavigationPromise = initializeModuleNavigation();"), "FanHao startup must begin module navigation without blocking the first route");
assert(webApp.includes("collectionPage.prefetch(initialRoute.view);"), "direct collection routes must start their data request before library hydration");
assert(webApp.indexOf("collectionPage.prefetch(initialRoute.view);") < webApp.indexOf("await applyRoute(initialRoute);"), "collection and library startup requests must overlap");
assert(!webApp.includes("await initializeModuleNavigation();"), "FanHao startup must not serialize module discovery ahead of the first library request");
assert(webApp.indexOf("const moduleNavigationPromise = initializeModuleNavigation();") < webApp.indexOf("await applyRoute(initialRoute);"), "module discovery and route data must start concurrently");
assert(webApp.includes("await moduleNavigationPromise;"), "FanHao startup must still observe module-navigation completion");
assert(webApp.includes("const WORK_DESKTOP_PAGE_SIZE = 64") && webApp.includes("const WORK_MOBILE_PAGE_SIZE = 48"), "FanHao work APIs must use viewport-sized desktop and mobile first pages");
assert(webApp.includes("WORK_PAGE_SIZE_BY_ACCESS = Object.freeze({ local: 64, lan: 64, remote: 48 })"), "FanHao work APIs must keep page payloads bounded for each access mode");
assert(webApp.includes('globalThis.matchMedia?.("(max-width: 720px)")') && webApp.includes("pageSize: preferredWorkPageSize"), "search requests must follow the active desktop or mobile viewport");
assert(webApp.includes("Math.min(defaultWorkPageSize, Number(state.accessHints.workPageSize)"), "FanHao clients must not accept oversized work-page hints");
assert(latestRequestSource.includes("controller?.abort()"), "latest-request gates must abort superseded work");
assert(fanhaoModuleIndexSource.includes('people-page.js?v=20260717-fanhao-people-card-lifecycle-01'), "people-card lifecycle changes must use a fresh browser module URL");
assert(fanhaoModuleIndexSource.includes('ranking-page.js?v=20260717-fanhao-ranking-response-01'), "ranking navigation changes must use a fresh browser module URL");
assert(fanhaoModuleIndexSource.includes('collection-page.js?v=20260717-fanhao-collection-response-01'), "collection navigation changes must use a fresh browser module URL");
assert(fanhaoModuleIndexSource.includes('studio-page.js?v=20260717-fanhao-studio-first-paint-01'), "studio first-paint changes must use a fresh browser module URL");
assert(collectionPageSource.includes("const collectionPrefetches = new Map()") && collectionPageSource.includes("warmHistoryRanges()"), "Web history ranges must reuse prefetched pages while the collection view remains active");
assert(collectionPageSource.includes("const COLLECTION_PREFETCH_TTL_MS = 5 * 60 * 1000") && collectionPageSource.includes("invalidatePrefetches"), "Web collection prefetches must survive normal reading time and expose explicit invalidation");
assert(peoplePageSource.includes("const PERSON_DETAIL_DESKTOP_PAGE_SIZE = 64") && peoplePageSource.includes("const PERSON_DETAIL_MOBILE_PAGE_SIZE = 48"), "person details must keep desktop and mobile first payloads bounded");
assert(peoplePageSource.includes("const personDetailPrefetches = new Map()") && peoplePageSource.includes("reusePrefetch: true"), "person interactions must reuse prepared detail requests instead of issuing a duplicate click request");
assert(peoplePageSource.includes("schedulePersonDetailPrefetch(person.id)") && peoplePageSource.includes("preparePersonDetailFromIntent(root, event.target)"), "delegated person cards must prepare details before desktop and touch clicks");
assert(peoplePageSource.includes("detailPending: true") && personProfileSource.includes("正在加载详情"), "Web person navigation must paint the indexed profile before the detail API returns");
assert(peoplePageSource.includes("works.map((work) => workCoverUrl(work)).find(Boolean)"), "Web person details must reuse the prepared work page for fallback artwork");
assert(latestRequestSource.includes("sequence === requestSequence"), "latest-request gates must reject stale completions");
assert(peoplePageSource.includes("const personDetailRequests = createLatestRequestGate()"), "person navigation must own a cancellable latest request");
assert(peoplePageSource.includes("if (!request.isCurrent() || state.activeView !== \"people\""), "stale person responses must not overwrite newer navigation");
assert(webApp.includes("if (view !== \"people\") peoplePage.cancelPendingSelection()"), "leaving the people view must cancel pending person work");
assert(webApp.includes("const searchRequests = createSearchRequestService({"), "FanHao search must retain a cancellable active request");
assert(searchRequestSource.includes("const request = requests.begin()"), "search and load-more requests must replace stale work");
assert(searchRequestSource.includes("return request.isCurrent() ? data : null"), "stale search responses must not overwrite current navigation");
assert(searchRequestSource.includes("const prefetched = new Map()") && searchRequestSource.includes("consumePrefetch(target.key)"), "Web search submit must consume input-time request warmups");
assert(webApp.includes("searchRequests.prefetch(query)"), "Web search input must prepare the likely first page before Enter");
let resolveSearchPrefetch;
const searchRequestPaths = [];
const pendingSearchPrefetch = new Promise((resolve) => {
  resolveSearchPrefetch = resolve;
});
const searchRequestService = createSearchRequestService({
  api: async (requestPath) => {
    searchRequestPaths.push(requestPath);
    if (searchRequestPaths.length === 1) return pendingSearchPrefetch;
    return { q: "SSIS", works: [{ id: "ssis-1" }] };
  },
  filter: () => "all",
  pageSize: () => 48,
  sort: () => "releaseDesc"
});
searchRequestService.prefetch("J");
const sharedSearchSubmit = searchRequestService.fetchPage("J");
assert.equal(searchRequestPaths.length, 1, "submitting while input prefetch is pending must not duplicate the search request");
resolveSearchPrefetch({ q: "J", works: [{ id: "j-1" }] });
assert.deepEqual(await sharedSearchSubmit, { q: "J", works: [{ id: "j-1" }] }, "search submit must receive the pending prefetched response");
await searchRequestService.prefetch("SSIS");
assert.deepEqual(await searchRequestService.fetchPage("SSIS"), { q: "SSIS", works: [{ id: "ssis-1" }] }, "search submit must consume a completed input prefetch");
assert.equal(searchRequestPaths.length, 2, "completed search prefetches must also be reused once");
assert(rankingPageSource.includes("const rankingRequests = createLatestRequestGate()"), "ranking navigation must own a cancellable latest request");
assert(rankingPageSource.includes('state.activeView !== "rankings"'), "stale ranking responses must not overwrite newer navigation");
assert(rankingPageSource.includes("const [summary, anticipatedData] = await Promise.all(["), "Web ranking activation must overlap summary and first-page requests");
assert(webApp.includes('if (view !== "rankings") rankingPage.cancelPendingRequests()'), "leaving rankings must cancel pending requests");
assert(studioPageSource.includes("const studioRequests = createLatestRequestGate()"), "studio navigation must own a cancellable latest request");
assert(studioPageSource.includes('state.activeView !== "studios"'), "stale studio responses must not overwrite newer navigation");
assert(webApp.includes('if (view !== "studios") studioPage.cancelPendingRequests()'), "leaving studios must cancel pending requests");
assert(studioPageSource.includes("const studioPrefetches = new Map()") && studioPageSource.includes("return result.data;"), "studio activation must reuse its prepared detail request");
assert(studioPageSource.includes('bindStudioIntentSurface(els.workGrid, ".studio-card"') && studioPageSource.includes('root.addEventListener("pointerover", prefetch'), "studio cards must delegate desktop and touch detail preparation");
assert(!studioPageSource.includes('button.addEventListener("pointerenter", prefetch'), "studio cards must not allocate intent listeners per index item");
assert(studioPageSource.includes("const STUDIO_INDEX_INITIAL_COUNT = 64") && studioPageSource.includes("appendIndexBatch(state.studios, 0, studioIndexRenderSeq)"), "studio indexes must paint a bounded first batch");
assert(studioPageSource.includes("cancelIndexRendering()") && studioPageSource.includes("studioIndexRenderSeq += 1"), "leaving the studio index must cancel stale render batches");
assert(studioPageSource.includes('globalThis.scrollTo?.({ top: 0, left: 0, behavior: "auto" })'), "studio card activation must start the detail at the top instead of inheriting index scroll");
assert(collectionPageSource.includes("const collectionRequests = createLatestRequestGate()"), "collection navigation must own a cancellable latest request");
assert(collectionPageSource.includes("const COLLECTION_DESKTOP_PAGE_SIZE = 64"), "desktop collections must keep the first payload compact");
assert(collectionPageSource.includes("const COLLECTION_MOBILE_PAGE_SIZE = 48"), "mobile collections must use a smaller first payload");
assert(collectionPageSource.includes('globalThis.matchMedia?.("(max-width: 720px)")'), "collection page size must follow the active viewport");
assert(collectionPageSource.includes("const promise = api(path).then("), "collection navigation must prepare one reusable request before activation");
assert(collectionPageSource.includes("return trimPrefetchedPage(result.data, path);"), "collection activation must consume prefetched results instead of issuing a duplicate request");
assert(webApp.includes('button.addEventListener("pointerenter", prefetchCollection'), "desktop collection tabs must prefetch before click");
assert(webApp.includes('button.addEventListener("pointerdown", prefetchCollection'), "touch collection tabs must start prefetching before click");
assert(webApp.includes('button.addEventListener("focus", prefetchCollection)'), "keyboard and touch collection navigation must share the prepared request path");
assert(!playbackProgressServiceSource.includes(".map((video) => getVideoProgress"), "work progress must avoid allocating and sorting every video on list rendering");
assert(personMergeServiceSource.includes("personRecordCache") && personMergeServiceSource.includes("personRecordCacheStamp"), "repeated work cards for one person must reuse the merged person record");
assert(workPresenterServiceSource.includes("PERSON_FALLBACK_AVATAR_BATCH_SIZE = 48"), "person avatar fallback scans must prepare bounded work batches");
assert(workPresenterServiceSource.includes("prewarmCoreWorkCovers(batch)") && workPresenterServiceSource.includes("prewarmWorkInfoDetails(batch)"), "person avatar fallbacks must batch metadata before scanning works");
assert(workPresenterServiceSource.includes("personFallbackAvatarCache") && workPresenterServiceSource.includes("getPersonFallbackAvatarStamp"), "repeated person presentation must reuse versioned fallback avatars");
assert(!workPresenterServiceSource.includes("workCoverRow(work.id)"), "person and work cards must not repeat the retired per-work cover query after metadata prewarm");
assert(workPresenterServiceSource.includes("publicWorkInfoSummary(workInfoDetailRow(work.id), work.infoSummary)"), "person avatar fallbacks must reuse batch-prepared detail rows");
for (const view of ["favorites", "history", "vr"]) {
  assert(collectionPageSource.includes(`state.activeView !== "${view}"`), `stale ${view} responses must not overwrite newer navigation`);
}
assert(workDetailPageSource.includes("const workDetailRequests = createLatestRequestGate()"), "work details must own a cancellable latest request");
assert(workDetailPageSource.includes("const playInfoRequests = createLatestRequestGate()"), "playback probes must own a cancellable latest request");
assert(workDetailPageSource.includes("playInfoRequests.cancel();"), "closing or switching work details must cancel playback probes");
assert(videoProbeSource.includes("probeWaitMs = DEFAULT_VIDEO_PROBE_WAIT_MS") && DEFAULT_VIDEO_PROBE_WAIT_MS === 80, "cold playback probes must return a usable fallback within the interactive response budget");
assert(videoProbeSource.includes("persistentCache.get(file, stat)") && videoProbeSource.includes("persistentCache.set(file, stat, value)"), "completed playback probes must survive server restarts");
assert(videoProbeCacheSource.includes("source_size") && videoProbeCacheSource.includes("source_mtime"), "persistent playback probes must invalidate when their source file changes");
assert(videoProbeCacheSource.includes("const rowsByFile = new Map()") && videoProbeCacheSource.includes("rowsByFile.get(cacheKey(file.id, file.path))"), "playback requests must read persisted probes from a startup-hydrated memory index");
assert(read("server.js").includes("persistentCache: videoProbeCacheService"), "FanHao playback must compose the persistent probe cache into the runtime");
assert(read("server.js").includes("videoProbeCacheService.start();"), "persistent probe statements must initialize before the first playback request");
assert(videoProbeSource.includes("const prewarmQueue = []"), "visible playback probes must use a bounded background queue");
assert(videoProbeSource.includes("prewarmActive < prewarmConcurrency"), "background playback probes must keep concurrency bounded");
assert(videoProbeSource.includes("const resolvedProbeByFile = new Map()"), "prepared playback probes must avoid repeated slow file-stat calls");
assert(videoProbeSource.includes("if (options.replaceQueued)"), "newly visible playback probes must be able to discard stale queued work");
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
  "public/modules/fanhao/features/works/work-actions.js",
  "public/modules/fanhao/features/works/viewport-batch-renderer.js",
  "public/modules/fanhao/features/works/preview-media.js",
  "android-client/www/modules/fanhao/features/works/cards.js",
  "android-client/www/modules/fanhao/features/works/actions.js",
  "android-client/www/modules/fanhao/features/works/preview-media.js",
  "android-client/www/modules/fanhao/features/works/page-data-service.js",
  "android-client/www/modules/fanhao/features/works/progressive-list-renderer.js",
  "android-client/www/modules/fanhao/features/shared/viewport-image-loader.js",
  "android-client/www/modules/fanhao/features/rankings/ranking-views.js",
  "src/modules/fanhao/server/composition.js",
  "src/modules/fanhao/server/user-state/collection-query-service.js"
]) {
  assert(fs.statSync(path.join(root, relativePath), { throwIfNoEntry: false })?.isFile(), `missing FanHao refactor part: ${relativePath}`);
}

const androidWorkViews = read("android-client/www/modules/fanhao/work-views.js");
const androidWorkFiltering = read("android-client/www/js/work-filtering.js");
const androidWorkPageDataService = read("android-client/www/modules/fanhao/features/works/page-data-service.js");
const androidWorkSearchDataService = read("android-client/www/modules/fanhao/features/works/search-data-service.js");
const androidWorkDetailDataService = read("android-client/www/modules/fanhao/features/works/detail-data-service.js");
const androidDetailViews = read("android-client/www/modules/fanhao/detail-views.js");
const androidApp = read("android-client/www/app.js");
const androidIndexHtml = read("android-client/www/index.html");
const androidFanhaoModule = read("android-client/www/modules/fanhao/android-module.js");
const androidPeopleViews = read("android-client/www/modules/fanhao/people-views.js");
const androidRankingViews = read("android-client/www/modules/fanhao/features/rankings/ranking-views.js");
const androidWorkCards = read("android-client/www/modules/fanhao/features/works/cards.js");
const androidWorkCoverLoader = read("android-client/www/modules/fanhao/features/works/cover-loader.js");
const androidProgressiveWorkListRenderer = read("android-client/www/modules/fanhao/features/works/progressive-list-renderer.js");
const androidViewportImageLoader = read("android-client/www/modules/fanhao/features/shared/viewport-image-loader.js");
const androidListStyles = read("android-client/www/css/lists.css");
const androidSectionStyles = read("android-client/www/css/sections.css");
const androidConfig = read("android-client/www/js/config.js");
const workDetailHeroBodyStyles = /\.content-panel\[data-view="workDetail"\] \.detail-hero-body \{([\s\S]*?)\}/.exec(androidSectionStyles)?.[1] || "";
const workDetailTitleStyles = /\.content-panel\[data-view="workDetail"\] \.work-detail-title-block > strong \{([\s\S]*?)\}/.exec(androidSectionStyles)?.[1] || "";
const workDetailActionStyles = /\.content-panel\[data-view="workDetail"\] \.detail-action-row \{([\s\S]*?)\}/.exec(androidSectionStyles)?.[1] || "";
const workDetailActionButtonStyles = /\.content-panel\[data-view="workDetail"\] \.detail-action-row button \{([\s\S]*?)\}/.exec(androidSectionStyles)?.[1] || "";
assert(!androidWorkViews.includes("SEARCH_CHANNELS"), "FanHao Android must not own cross-module search channels");
assert(!/function createWorkCard\s*\(/.test(androidWorkViews), "FanHao Android work cards must stay in their feature module");
assert(!androidWorkViews.includes("createGlobalSearch"), "FanHao Android search must not use a cross-module aggregator");
assert(androidWorkSearchDataService.includes("/api/fanhao/search"), "FanHao Android search must use the module-scoped endpoint");
assert(!androidWorkViews.includes("data.channels"), "FanHao Android search must not render results from other modules");
assert(androidWorkViews.includes("const searchListState = createWorkListState({") && androidWorkViews.includes("persist: false") && androidWorkViews.includes('initialFilterMode: "all"'), "FanHao Android search must start from an isolated unfiltered list state");
assert(androidWorkViews.includes("workListState: searchListState") && androidWorkViews.includes("listState: searchListState"), "FanHao Android search requests and controls must share their isolated list state");
assert(androidWorkViews.includes('searchListState.setFilterMode("all", { replace: true, rerender: false })') && androidWorkViews.includes('searchListState.setSortMode("updated", { rerender: false })'), "opening a fresh FanHao Android search must reset route-local filters");
assert(androidWorkViews.includes("const { listState = workListState, ...renderOptions } = options"), "Android work rendering must allow a route-owned list state");
assert(androidWorkFiltering.includes("const persist = context.persist !== false") && androidWorkFiltering.includes("if (persist && options.persist !== false)"), "Android list state must support non-persistent route-local filters");
assert(androidWorkFiltering.includes("const filterToReveal = activeFilters.size") && androidWorkFiltering.includes("function revealActiveFilter(filterStrip, button)") && androidWorkFiltering.includes("globalThis.requestAnimationFrame") && androidWorkFiltering.includes("filterStrip.scrollLeft = Math.max"), "Android work filters must reveal the active chip without moving the page vertically");
assert(androidWorkFiltering.includes('filterStrip.setAttribute("aria-label", "作品筛选")') && androidWorkFiltering.includes('button.setAttribute("aria-pressed", active ? "true" : "false")'), "Android work filters must expose their selected state to accessibility services");
assert(lines("android-client/www/js/work-filtering.js") <= 320, "Android work filtering must stay focused");
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const listStateStorageReads = [];
const listStateStorageWrites = [];
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem(key) {
      listStateStorageReads.push(key);
      if (key.endsWith("workFilter")) return "highRating";
      if (key.endsWith("workSort")) return "ratingDesc";
      return null;
    },
    setItem(key, value) {
      listStateStorageWrites.push([key, value]);
    }
  }
});
try {
  const catalogListState = createWorkListState({ renderCurrentView() {} });
  const searchListState = createWorkListState({
    renderCurrentView() {},
    persist: false,
    initialFilterMode: "all",
    initialSortMode: "updated"
  });
  assert.equal(catalogListState.getFilterMode(), "highRating", "catalog list state must still restore its saved filter");
  assert.equal(catalogListState.getSortMode(), "ratingDesc", "catalog list state must still restore its saved sort");
  assert.equal(searchListState.getFilterMode(), "all", "search list state must ignore the catalog's saved filter");
  assert.equal(searchListState.getSortMode(), "updated", "search list state must ignore the catalog's saved sort");
  searchListState.setFilterMode("progress", { rerender: false });
  searchListState.setSortMode("title", { rerender: false });
  assert.equal(searchListState.getFilterMode(), "progress", "search filters must remain usable within the current search session");
  assert.equal(catalogListState.getFilterMode(), "highRating", "search filters must not mutate the catalog state");
  assert.equal(listStateStorageReads.length, 2, "only the persistent catalog state may read saved list preferences");
  assert.deepEqual(listStateStorageWrites, [], "route-local search state must not overwrite saved catalog preferences");
} finally {
  if (originalLocalStorageDescriptor) Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
  else delete globalThis.localStorage;
}
assert(androidWorkViews.includes("createRankingViews"), "FanHao Android rankings must stay in their feature module");
assert(lines("android-client/www/modules/fanhao/work-views.js") <= 750, "FanHao Android work views must stay below 750 lines");
assert(lines("android-client/www/modules/fanhao/features/works/cards.js") <= 320, "FanHao Android work cards must stay focused");
assert(androidApp.includes("const aVisual = imageUrlForPerson(a) ? 1 : 0"), "Android home must recognize compact person-list avatar URLs");
assert(androidPeopleViews.includes("const aVisual = imageUrlForPerson(a) ? 1 : 0"), "Android people sorting must recognize compact person-list avatar URLs");
assert(androidApp.includes("const FAST_WORK_LIMIT = 48"), "Android FanHao work views must request a phone-sized interactive first page");
assert(androidApp.includes("const FAST_WORK_STEP = 48"), "Android FanHao work views must grow in phone-sized pages");
assert(androidApp.includes("const FAST_PEOPLE_LIMIT = 64"), "Android people index must keep its first page compact");
assert(androidApp.includes("const FAST_PEOPLE_STEP = 64"), "Android people index must grow in bounded pages");
assert(!androidApp.includes("return fast ? 480"), "Android FanHao detail and collection views must not restore oversized initial requests");
assert(androidPeopleViews.includes("avatarLoader.schedule(visual, imagePath)"), "Android people avatars must wait until their cards approach the viewport");
assert(androidPeopleViews.includes("appendPeopleCards(grid, people.slice(start, nextLimit)"), "Android people continuation must append only the next page");
assert(androidPeopleViews.includes("restorePeopleIndex(sourcePeople, sortMode)") && androidPeopleViews.includes("cache.sourcePeople !== sourcePeople"), "Android people navigation must restore the current library index without rebuilding it");
assert(androidPeopleViews.includes("els.viewContent.replaceChildren(...nodes)") && androidPeopleViews.includes("syncPeopleLimit(cache.grid.children.length)"), "Android people restoration must retain loaded cards and synchronize continuation with the rendered count");
assert(!androidPeopleViews.includes("renderCurrentViewPreservingScroll"), "Android people continuation must not rebuild the existing index");
assert(androidWorkCards.includes("coverLoader.schedule(thumb, imagePath)"), "Android work cards must defer cover reads until they approach the viewport");
assert(androidWorkCards.includes("compactMeta ? compactWorkCardTitle(work)") && androidWorkCards.includes("function compactWorkCode(work)"), "Android compact work cards must keep the work code visible beside the cleaned title");
assert(androidWorkCards.includes("function extractLeadingWorkCode(value)") && androidWorkCards.includes("work?.infoSummary?.code"), "Android compact work-code labels must prefer authoritative metadata and only infer codes from title prefixes");
assert(androidWorkViews.includes("workCards.resetCoverLoading();"), "Android work navigation must cancel stale offscreen cover work");
assert(androidWorkViews.includes("progressiveWorkListRenderer.render(grid, visible"), "Android work lists must expose the first card batch before building the remaining page");
assert(!androidWorkViews.includes("for (const work of visible) grid.append"), "Android work lists must not synchronously build the full first page");
assert(androidWorkViews.includes("() => loadMore && els.viewContent.append(loadMore)"), "Android auto-load must wait until progressive work rendering reaches the real list end");
assert(!androidWorkViews.includes("els.viewContent.append(createLoadMoreButton"), "Android callers must not attach auto-load before progressive work rendering completes");
assert(androidWorkViews.includes("requireScrollIntent: true"), "Android FanHao pagination must require fresh downward scroll intent");
assert(androidWorkViews.includes("activeFilterTotal: options.activeFilterTotal ? total : undefined") && androidWorkFiltering.includes("options.activeFilterTotal"), "Android combined filters must display the server-filtered total");
assert(androidProgressiveWorkListRenderer.includes("container.isConnected === false"), "Android progressive work rendering must stop after navigation detaches its list");
assert(androidWorkCoverLoader.includes('const WORK_COVER_ROOT_MARGIN = "720px 0px"'), "Android work covers must start shortly before they enter the viewport");
assert(androidViewportImageLoader.includes("const pending = new Map()"), "Android viewport image loading must share one focused queue implementation");
assert(androidListStyles.includes("content-visibility: auto") && androidListStyles.includes("contain-intrinsic-size: auto 128px"), "Android work cards must skip offscreen layout and painting");
assert(workDetailHeroBodyStyles.includes("grid-template-columns: minmax(0, 1fr);") && !workDetailHeroBodyStyles.includes(" auto"), "Android work details must give the title and actions a full-width single-column header");
assert(workDetailTitleStyles.includes("-webkit-line-clamp: 3"), "Android work details must expose three full-width title lines");
assert(androidSectionStyles.includes('@media (max-width: 360px)') && androidSectionStyles.includes("-webkit-line-clamp: 4"), "narrow Android work details must retain a fourth title line");
assert(workDetailActionStyles.includes("flex-wrap: nowrap") && workDetailActionStyles.includes("width: 100%"), "Android work-detail actions must stay in one dedicated full-width row");
assert(workDetailActionButtonStyles.includes("flex: 1 1 0") && workDetailActionButtonStyles.includes("min-width: 0"), "Android work-detail actions must share the available phone width evenly");
assert(androidIndexHtml.includes("styles.css?v=20260720-fanhao-detail-layout-01"), "Android work-detail layout styles must retain their fresh WebView URL");
assert(androidIndexHtml.includes("app.js?v=20260720-fanhao-filter-back-01") && androidApp.includes("config.js?v=20260720-fanhao-filter-back-01") && androidConfig.includes('CLIENT_VERSION = "20260720-fanhao-filter-back-01"'), "Android work-filter and back-navigation changes must refresh the WebView cache chain");
const androidGoBackStart = androidApp.indexOf("function goBack()");
const androidGoBackStackPriority = androidApp.indexOf("if (returnToStackView()) return;", androidGoBackStart);
const androidGoBackBrowserHistory = androidApp.indexOf("window.history.back();", androidGoBackStart);
assert(androidGoBackStart >= 0 && androidGoBackStackPriority > androidGoBackStart && androidGoBackStackPriority < androidGoBackBrowserHistory, "Android UI back must restore the in-app view stack before stale browser history");
const androidNativeBackStart = androidApp.indexOf("window.fanhaoHandleNativeBack = () =>");
const androidNativeBackStackPriority = androidApp.indexOf("if (returnToStackView()) return true;", androidNativeBackStart);
const androidNativeBackBrowserHistory = androidApp.indexOf("window.history.back();", androidNativeBackStart);
assert(androidNativeBackStart >= 0 && androidNativeBackStackPriority > androidNativeBackStart && androidNativeBackStackPriority < androidNativeBackBrowserHistory, "Android native back must restore the in-app view stack before stale browser history");
assert(androidApp.includes("function returnToStackView()") && androidApp.includes("replaceHistory: true") && androidFanhaoModule.includes("host.navigation.goBack()"), "FanHao search close must replace its route with the originating in-app view");
assert(androidRankingViews.includes("const PAGE_SIZE = 48"), "Android rankings must request a phone-sized first page");
assert(androidRankingViews.includes("hasServerMore:"), "Android rankings must preserve server-side continuation");
assert(androidWorkViews.includes("renderOptions.hasServerMore"), "Android work rendering must expose server-side continuation");
assert(androidWorkViews.includes("/api/history?limit=${limit}&offset=0"), "Android history must request a bounded first page");
assert(androidWorkViews.includes("const works = data.works || []"), "Android collections must define their rendered work list locally");
assert(androidWorkViews.includes("createWorkPageDataService") && androidWorkViews.includes("warmPrimaryCollections(activeUrl)"), "Android home must warm and share collection requests before navigation");
assert(androidWorkViews.includes("warmCatalogSibling(activeUrl") && androidWorkPageDataService.includes("const inflight = new Map()"), "Android work and VR views must warm sibling pages and share requests");
assert(androidWorkViews.includes("pageDataService.load(activeUrl, path") && androidWorkViews.includes("warmStudioDetail(studio.id)"), "Android studio navigation must share touch warmups with its live detail request");
assert(androidWorkViews.includes('button.addEventListener("pointerdown", warmDetail'), "Android studio cards and series chips must begin loading on touch press");
assert(androidFanhaoModule.includes("prepare(query)") && androidWorkViews.includes("warmSearch: searchDataService.warm"), "Android search input must warm the exact page consumed by navigation");
assert(androidApp.includes("activeSearchController()?.prepare?.(query, searchContext())"), "Android shared search shell must debounce module-owned preparation");
assert(androidWorkCards.includes("const cardWorks = new WeakMap()") && androidWorkCards.includes("cardWorks.set(card, work)"), "Android work cards must retain navigation records without attaching them to global state");
assert(androidWorkViews.includes("roots: [els.viewContent, els.continuePreview]") && androidWorkDetailDataService.includes("function bindContainer(container)"), "Android work-card surfaces must share delegated interaction listeners");
assert(!androidWorkCards.includes('card.addEventListener("click"') && !androidWorkCards.includes('card.addEventListener("keydown"') && !androidWorkCards.includes('person.addEventListener("click"'), "Android work cards must not allocate navigation listeners per item");
assert(androidWorkDetailDataService.includes('container.addEventListener("pointerover"') && androidWorkDetailDataService.includes('container.addEventListener("focusin"') && androidWorkDetailDataService.includes("bindActivationIntent(container") && androidWorkDetailDataService.includes('target.addEventListener("pointerup"'), "Android mouse, keyboard, and confirmed touch intent must use delegated preparation");
assert(androidWorkDetailDataService.includes("TOUCH_TAP_SLOP_PX") && androidWorkDetailDataService.includes('event.pointerType === "touch"'), "Android work intent must distinguish taps from touch scrolling");
assert(androidWorkCards.includes('person.dataset.workIntentIgnore = "1"') && androidWorkDetailDataService.includes('target.closest("[data-work-intent-ignore]")'), "Android person navigation must not prefetch the surrounding work detail");
assert(read("android-client/www/modules/fanhao/detail-views.js").includes("workDetailDataService.load(workId") && androidWorkDetailDataService.includes("pageDataService.load(getActiveUrl(), path(workId)"), "Android work detail navigation must reuse the shared page race");
assert((androidDetailViews.match(/pageDataService\.load\(activeUrl, path/g) || []).length >= 2 && androidFanhaoModule.includes("pageDataService: workViews.pageDataService"), "Android person and related-work navigation must share the cache/network race");
assert(!androidDetailViews.includes("await readCachedJson(activeUrl, path)") && !androidDetailViews.includes("fetchJson(activeUrl, path"), "Android detail views must not wait for IndexedDB before starting their live request");
assert(androidWorkViews.includes('cards.js?v=20260720-fanhao-card-code-01'), "Android work-card code changes must refresh the card module URL");
assert((androidWorkViews.match(/pageDataService\.load\(activeUrl, path/g) || []).length >= 7 && androidWorkPageDataService.includes("Promise.race([freshRequest, cacheRequest])"), "Android FanHao pages must race IndexedDB with the live response");
const scheduledViewportBatches = new Map();
let nextViewportBatchId = 1;
let viewportObserverCallback = null;
let viewportObserverOptions = null;
let viewportObservedTarget = null;
const viewportContainer = {
  children: [],
  ownerDocument: {
    createElement() {
      return {
        isConnected: true,
        setAttribute() {},
        remove() {
          this.isConnected = false;
          const index = viewportContainer.children.indexOf(this);
          if (index >= 0) viewportContainer.children.splice(index, 1);
        }
      };
    }
  },
  append(child) {
    this.children.push(child);
  }
};
class ViewportObserver {
  constructor(callback, options) {
    viewportObserverCallback = callback;
    viewportObserverOptions = options;
  }
  observe(target) {
    viewportObservedTarget = target;
  }
  disconnect() {}
}
const viewportBatchRenderer = createViewportBatchRenderer({
  container: viewportContainer,
  initialCount: 2,
  batchSize: 2,
  lookaheadDistance: 720,
  IntersectionObserver: ViewportObserver,
  appendBatch(items, start, end, beforeNode) {
    const values = items.slice(start, end);
    const beforeIndex = beforeNode ? viewportContainer.children.indexOf(beforeNode) : -1;
    if (beforeIndex >= 0) viewportContainer.children.splice(beforeIndex, 0, ...values);
    else viewportContainer.children.push(...values);
    return end;
  },
  setTimer(callback) {
    const id = nextViewportBatchId++;
    scheduledViewportBatches.set(id, callback);
    return id;
  },
  clearTimer(id) {
    scheduledViewportBatches.delete(id);
  }
});
let viewportBatchComplete = false;
viewportBatchRenderer.render([1, 2, 3, 4, 5], () => {
  viewportBatchComplete = true;
});
assert.deepEqual(viewportContainer.children.slice(0, 2), [1, 2], "Web work lists must expose the first card batch synchronously");
assert.equal(viewportContainer.children.length, 3, "Web work lists must retain only one viewport sentinel beyond the first batch");
assert.equal(viewportObserverOptions.rootMargin, "720px 0px", "Web work batches must observe only the configured viewport lookahead");
assert.equal(scheduledViewportBatches.size, 0, "far-offscreen Web work batches must not schedule autonomous DOM work");
viewportObserverCallback([{ target: viewportObservedTarget, isIntersecting: true }]);
const runNextViewportBatch = () => {
  const entry = scheduledViewportBatches.entries().next().value;
  assert(entry, "an intersecting Web work sentinel must schedule one bounded batch");
  scheduledViewportBatches.delete(entry[0]);
  entry[1]();
};
runNextViewportBatch();
assert.deepEqual(viewportContainer.children.slice(0, 4), [1, 2, 3, 4], "Web work continuation must append one bounded batch ahead of its sentinel");
assert.equal(viewportBatchComplete, false, "Web load-more must stay hidden before the loaded page reaches its real end");
viewportObserverCallback([{ target: viewportObservedTarget, isIntersecting: true }]);
runNextViewportBatch();
assert.deepEqual(viewportContainer.children, [1, 2, 3, 4, 5], "Web viewport rendering must eventually append the complete loaded page");
assert.equal(viewportBatchComplete, true, "Web load-more must activate only after the loaded page reaches its real end");
const scheduledWorkBatches = new Map();
let nextWorkBatchId = 1;
const progressiveWorkListRenderer = createProgressiveWorkListRenderer({
  initialCount: 2,
  batchSize: 2,
  batchDelayMs: 16,
  setTimer(callback) {
    const id = nextWorkBatchId;
    nextWorkBatchId += 1;
    scheduledWorkBatches.set(id, callback);
    return id;
  },
  clearTimer(id) {
    scheduledWorkBatches.delete(id);
  }
});
const createListContainer = () => ({
  children: [],
  isConnected: true,
  append(child) {
    this.children.push(child);
  }
});
const runNextWorkBatch = () => {
  const entry = scheduledWorkBatches.entries().next().value;
  assert(entry, "Android progressive work rendering must schedule its next batch");
  const [id, callback] = entry;
  scheduledWorkBatches.delete(id);
  callback();
};
const progressiveWorkList = createListContainer();
let progressiveWorkListComplete = false;
progressiveWorkListRenderer.render(progressiveWorkList, [1, 2, 3, 4, 5], (value) => value, () => {
  progressiveWorkListComplete = true;
});
assert.deepEqual(progressiveWorkList.children, [1, 2], "Android work lists must render the first batch synchronously");
assert.equal(progressiveWorkListComplete, false, "Android work continuation must stay hidden while card batches are still rendering");
runNextWorkBatch();
assert.deepEqual(progressiveWorkList.children, [1, 2, 3, 4], "Android work lists must append one bounded continuation batch");
runNextWorkBatch();
assert.deepEqual(progressiveWorkList.children, [1, 2, 3, 4, 5], "Android work lists must eventually append the complete page");
assert.equal(progressiveWorkListComplete, true, "Android work continuation must activate after the complete page is rendered");
const staleWorkList = createListContainer();
progressiveWorkListRenderer.render(staleWorkList, ["old-1", "old-2", "old-3"], (value) => value);
const staleWorkBatch = scheduledWorkBatches.values().next().value;
const replacementWorkList = createListContainer();
progressiveWorkListRenderer.render(replacementWorkList, ["new-1"], (value) => value);
staleWorkBatch();
assert.deepEqual(staleWorkList.children, ["old-1", "old-2"], "Android navigation must cancel stale work-card batches");
assert.deepEqual(replacementWorkList.children, ["new-1"], "Android navigation must render the replacement list immediately");
let resolveWarmedWorkPage;
let workPageFetchCount = 0;
const writtenWorkPages = [];
const warmedWorkPageRequest = new Promise((resolve) => {
  resolveWarmedWorkPage = resolve;
});
const workPageDataService = createWorkPageDataService({
  fetchJson: async () => {
    workPageFetchCount += 1;
    if (workPageFetchCount === 1) return warmedWorkPageRequest;
    return { works: [{ id: `work-${workPageFetchCount}` }] };
  },
  writeCachedJson: async (activeUrl, path, data) => {
    writtenWorkPages.push({ activeUrl, path, data });
  }
});
const warmedWorkPath = "/api/works?limit=48&offset=0&sort=updated&filter=vr";
workPageDataService.warm("http://fanhao.local", [warmedWorkPath]);
const sharedWarmedWorkPage = workPageDataService.fetch("http://fanhao.local", warmedWorkPath, { reuseWarmed: true });
assert.equal(workPageFetchCount, 1, "Android work-page navigation must reuse a sibling prefetch still in flight");
resolveWarmedWorkPage({ works: [{ id: "work-vr" }] });
assert.deepEqual(await sharedWarmedWorkPage, { works: [{ id: "work-vr" }] }, "Android work-page prefetch must preserve the server payload");
assert.equal(writtenWorkPages.length, 1, "Android work-page prefetch must populate IndexedDB once");
workPageDataService.warm("http://fanhao.local", [warmedWorkPath]);
await Promise.resolve();
assert.equal(workPageFetchCount, 1, "completed Android sibling warmups must not repeat during the same app session");
await workPageDataService.fetch("http://fanhao.local", warmedWorkPath, { reuseWarmed: true });
assert.equal(workPageFetchCount, 2, "an in-flight Android warmup must be consumed once instead of leaking into a later navigation");
const completedWarmPath = "/api/studios/1?seriesId=all&limit=48&offset=0";
await workPageDataService.warm("http://fanhao.local", [completedWarmPath]);
assert.equal(workPageFetchCount, 3, "Android studio warmups must complete one background request");
await workPageDataService.fetch("http://fanhao.local", completedWarmPath, { reuseWarmed: true });
assert.equal(workPageFetchCount, 3, "Android touch navigation must consume a just-completed warmup without a second request");
await workPageDataService.fetch("http://fanhao.local", completedWarmPath);
assert.equal(workPageFetchCount, 4, "ordinary Android navigation must still revalidate a completed cached page");
let resolveWorkDetailFetch;
let resolveWorkDetailCache;
const workDetailLoadOrder = [];
const warmedWorkDetailPaths = [];
const pendingWorkDetailFetch = new Promise((resolve) => { resolveWorkDetailFetch = resolve; });
const pendingWorkDetailCache = new Promise((resolve) => { resolveWorkDetailCache = resolve; });
const racingWorkPageDataService = createWorkPageDataService({
  fetchJson(activeUrl, requestPath) {
    workDetailLoadOrder.push(["fetch", activeUrl, requestPath]);
    return pendingWorkDetailFetch;
  },
  readCachedJson(activeUrl, requestPath) {
    workDetailLoadOrder.push(["cache", activeUrl, requestPath]);
    return pendingWorkDetailCache;
  },
  writeCachedJson: async () => {}
});
const workDetailDataService = createWorkDetailDataService({
  getActiveUrl: () => "http://fanhao.local",
  pageDataService: {
    ...racingWorkPageDataService,
    warm(activeUrl, paths) {
      warmedWorkDetailPaths.push([activeUrl, ...paths]);
      return racingWorkPageDataService.warm(activeUrl, paths);
    }
  }
});
let cachedWorkDetailRendered = false;
const workDetailLoad = workDetailDataService.load("work / 1", {
  onCached() { cachedWorkDetailRendered = true; }
});
assert.deepEqual(workDetailLoadOrder.map((item) => item[0]), ["fetch", "cache"], "Android work detail must start the live request before awaiting IndexedDB");
resolveWorkDetailCache({ payload: { work: { id: "work / 1" } }, updatedAt: Date.now() });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(cachedWorkDetailRendered, true, "Android work detail must still paint an available cached response immediately");
resolveWorkDetailFetch({ work: { id: "work / 1" } });
assert.equal((await workDetailLoad).unchanged, true, "identical fresh work details must avoid rebuilding the cached detail DOM");
workDetailDataService.warm("work / 1");
assert.deepEqual(warmedWorkDetailPaths[0], ["http://fanhao.local", "/api/works/work%20%2F%201"], "Android work intent must warm the exact encoded detail path");
const delegatedWorkIntentHandlers = new Map();
let delegatedWorkIntentListenerCount = 0;
const delegatedWorkIntentRoot = {
  addEventListener(name, handler) {
    delegatedWorkIntentListenerCount += 1;
    delegatedWorkIntentHandlers.set(name, handler);
  },
  contains: () => true
};
const delegatedWorkCard = {
  dataset: { workDetailId: "delegated-work" },
  contains: () => false
};
const delegatedWorkBody = {
  closest(selector) {
    return selector === "[data-work-detail-id]" ? delegatedWorkCard : null;
  }
};
const delegatedPersonButton = {
  closest(selector) {
    if (selector === "[data-work-intent-ignore]") return delegatedPersonButton;
    return selector === "[data-work-detail-id]" ? delegatedWorkCard : null;
  }
};
workDetailDataService.bindContainer(delegatedWorkIntentRoot);
workDetailDataService.bindContainer(delegatedWorkIntentRoot);
assert.equal(delegatedWorkIntentListenerCount, 6, "Android work intent must allocate one gesture-aware listener set per persistent surface only once");
delegatedWorkIntentHandlers.get("pointerdown")({ target: delegatedPersonButton });
assert.equal(warmedWorkDetailPaths.length, 1, "touching a person button must not warm its surrounding work detail");
delegatedWorkIntentHandlers.get("pointerdown")({ target: delegatedWorkBody, pointerType: "mouse" });
assert.deepEqual(warmedWorkDetailPaths[1], ["http://fanhao.local", "/api/works/delegated-work"], "mouse activation must still warm the exact detail request");
delegatedWorkIntentHandlers.get("pointerdown")({ target: delegatedWorkBody, pointerType: "touch", pointerId: 7, clientX: 20, clientY: 20 });
delegatedWorkIntentHandlers.get("pointerup")({ target: delegatedWorkBody, pointerType: "touch", pointerId: 7, clientX: 20, clientY: 80 });
assert.equal(warmedWorkDetailPaths.length, 2, "touch scrolling must not warm an incidental work detail");
delegatedWorkIntentHandlers.get("pointerdown")({ target: delegatedWorkBody, pointerType: "touch", pointerId: 8, clientX: 20, clientY: 20 });
delegatedWorkIntentHandlers.get("pointerup")({ target: delegatedWorkBody, pointerType: "touch", pointerId: 8, clientX: 24, clientY: 25 });
assert.deepEqual(warmedWorkDetailPaths[2], ["http://fanhao.local", "/api/works/delegated-work"], "a confirmed touch tap must still warm the exact detail request");
const fastWorkPageDataService = createWorkPageDataService({
  fetchJson: async () => ({ work: { id: "fast-work" } }),
  readCachedJson: () => new Promise(() => {}),
  writeCachedJson: async () => {}
});
const fastWorkDetailDataService = createWorkDetailDataService({
  getActiveUrl: () => "http://fanhao.local",
  pageDataService: fastWorkPageDataService
});
const fastWorkDetail = await fastWorkDetailDataService.load("fast-work");
assert.equal(fastWorkDetail.data.work.id, "fast-work", "a fast Android detail response must not wait for a stalled IndexedDB read");
let coverObserverCallback = null;
let coverObserverOptions = null;
let coverObserverDisconnected = 0;
const observedCoverTargets = [];
const unobservedCoverTargets = [];
const loadedWorkCovers = [];
const deferredWorkCoverLoader = createWorkCoverLoader({
  createObserver(callback, options) {
    coverObserverCallback = callback;
    coverObserverOptions = options;
    return {
      disconnect() {
        coverObserverDisconnected += 1;
      },
      observe(target) {
        observedCoverTargets.push(target);
      },
      unobserve(target) {
        unobservedCoverTargets.push(target);
      }
    };
  },
  getActiveUrl: () => "http://127.0.0.1:29998",
  loadImage: (target, url, options) => loadedWorkCovers.push({ target, url, options })
});
const deferredCoverTarget = {};
deferredWorkCoverLoader.schedule(deferredCoverTarget, "/media/image/cover-1");
assert.equal(deferredWorkCoverLoader.pendingCount(), 1, "offscreen Android covers must remain queued without starting cache or network work");
assert.deepEqual(observedCoverTargets, [deferredCoverTarget], "queued Android covers must be observed once");
assert.equal(coverObserverOptions.rootMargin, "720px 0px", "cover observation must begin before the card reaches the viewport");
coverObserverCallback([{ target: deferredCoverTarget, isIntersecting: false, intersectionRatio: 0 }]);
assert.equal(loadedWorkCovers.length, 0, "far-offscreen Android covers must not read IndexedDB or network data");
coverObserverCallback([{ target: deferredCoverTarget, isIntersecting: true, intersectionRatio: 0.1 }]);
assert.equal(deferredWorkCoverLoader.pendingCount(), 0, "visible Android covers must leave the pending queue");
assert.deepEqual(unobservedCoverTargets, [deferredCoverTarget], "visible Android covers must stop observing after their first load");
assert.equal(loadedWorkCovers[0]?.url, "http://127.0.0.1:29998/media/image/cover-1", "deferred Android covers must retain the active server URL");
const cancelledCoverTarget = {};
deferredWorkCoverLoader.schedule(cancelledCoverTarget, "/media/image/cover-2");
deferredWorkCoverLoader.reset();
assert.equal(deferredWorkCoverLoader.pendingCount(), 0, "navigation must drop stale offscreen cover work");
assert.equal(coverObserverDisconnected, 1, "navigation must disconnect the previous cover observer");
const androidFanhaoIndex = read("android-client/www/modules/fanhao/index.js");
assert(androidDetailViews.includes("getWorksLimit()"), "Android person details must use the bounded shared work limit");
assert(androidDetailViews.includes("hasServerMore:"), "Android person details must preserve server-side continuation");
assert(!androidDetailViews.includes("limit=2000"), "Android person details must not fetch every work before first render");
assert(androidDetailViews.includes("renderPersonPreview(indexedPerson)") && androidDetailViews.includes("正在加载作品"), "Android person navigation must paint the local index before the network request completes");
assert(androidDetailViews.includes("works.map((work) => imageUrlForWork(work)).find(Boolean)"), "Android person details must reuse the prepared work page for fallback artwork");
assert(androidFanhaoIndex.includes('detail-views.js?v=20260717-fanhao-person-page-race-01'), "Android person-page race changes must use a fresh detail-view URL");
assert(androidWorkViews.includes('page-data-service.js?v=20260717-fanhao-page-race-01') && androidWorkViews.includes('detail-data-service.js?v=20260717-fanhao-touch-intent-01'), "Android page-race service and gesture-aware intent changes must retain fresh module URLs");
assert(androidFanhaoIndex.includes('work-views.js?v=20260720-fanhao-filter-back-01'), "Android work-filter visibility changes must use a fresh work-view URL");
assert(androidFanhaoIndex.includes('people-views.js?v=20260717-fanhao-people-return-cache-01'), "Android people restoration must use a fresh people-view URL");
assert(androidFanhaoModule.includes('index.js?v=20260720-fanhao-filter-back-01'), "Android work-filter visibility changes must refresh the FanHao module entry chain");
assert(androidIndexHtml.includes('app.js?v=20260720-fanhao-filter-back-01'), "Android work-filter and back-navigation changes must refresh the app entry chain");
assert(androidWorkViews.includes('ranking-views.js?v=20260717-fanhao-ranking-response-01'), "Android ranking views must retain their current module URL");
assert(androidRankingViews.includes("const PAGE_SIZE = 48") && androidRankingViews.includes("const [summary, anticipatedData] = await Promise.all(["), "Android rankings must overlap requests and keep the first response phone-sized");
for (const functionName of ["toggleLocalMarker", "deleteLocalFiles", "toggleFavorite", "createPreviewMediaPanel"]) {
  assert(!androidDetailViews.includes(`function ${functionName}(`), `Android detail must delegate ${functionName}`);
}
assert(lines("android-client/www/modules/fanhao/detail-views.js") <= 900, "FanHao Android detail views must stay below 900 lines");

const workDetail = read("public/modules/fanhao/work-detail-page.js");
assert(!/function createPreviewMediaSection\s*\(/.test(workDetail), "Web preview media must stay in its feature module");
assert(workDetail.includes("createWorkPreviewMedia"), "Web work detail must compose the preview feature");
assert(lines("public/modules/fanhao/work-detail-page.js") <= 1000, "Web work detail must stay below 1000 lines");
assert(lines("public/app.js") <= 2500, "FanHao Web composition root must stay below 2500 lines");

const favoriteState = {
  activeView: "people",
  currentWork: null,
  favoriteFolders: [],
  library: { user: null },
  works: [{ id: "work-1", favorite: false, favoriteFolderId: "", favoriteFolderName: "" }]
};
let resolveFavoriteRequest;
const favoriteRequest = new Promise((resolve) => {
  resolveFavoriteRequest = resolve;
});
const controlClasses = new Set();
const favoriteControl = {
  attributes: new Map(),
  classList: {
    remove(name) { controlClasses.delete(name); },
    toggle(name, enabled) { enabled ? controlClasses.add(name) : controlClasses.delete(name); }
  },
  disabled: false,
  setAttribute(name, value) { this.attributes.set(name, value); },
  title: ""
};
let workActionRenderCount = 0;
let collectionInvalidationCount = 0;
const workActions = createWorkActions({
  api: () => favoriteRequest,
  onCollectionStateChanged: () => { collectionInvalidationCount += 1; },
  renderFavoriteFolderControls: () => {},
  renderStatsForWorks: () => {},
  renderWorks: () => { workActionRenderCount += 1; },
  showError: (message) => assert.fail(message),
  state: favoriteState
});
const favoritePending = workActions.toggleFavorite("work-1", favoriteControl);
assert.equal(favoriteState.works[0].favorite, true, "favorite controls must update before the API completes");
assert.equal(favoriteControl.disabled, true, "favorite controls must block duplicate requests while pending");
assert(controlClasses.has("pending") && controlClasses.has("active"), "favorite controls must expose optimistic pending state");
resolveFavoriteRequest({
  favorite: true,
  favoriteFolder: { folderId: "default", folderName: "默认" },
  folders: [{ id: "default", name: "默认" }],
  user: { favorites: ["work-1"] }
});
await favoritePending;
assert.equal(favoriteControl.disabled, false, "favorite controls must become interactive after the API completes");
assert(!controlClasses.has("pending"), "favorite controls must clear pending state after the API completes");
assert.equal(favoriteState.works[0].favoriteFolderId, "default", "favorite responses must reconcile server folder state");
assert.equal(workActionRenderCount, 1, "favorite responses must refresh work cards once");
assert.equal(collectionInvalidationCount, 1, "successful favorite changes must invalidate prefetched collection pages once");
let favoriteRollbackMessage = "";
const rollbackWorkActions = createWorkActions({
  api: async () => { throw new Error("favorite unavailable"); },
  renderFavoriteFolderControls: () => {},
  renderStatsForWorks: () => {},
  renderWorks: () => {},
  showError: (message) => { favoriteRollbackMessage = message; },
  state: favoriteState
});
await rollbackWorkActions.toggleFavorite("work-1", favoriteControl);
assert.equal(favoriteState.works[0].favorite, true, "failed favorite requests must restore optimistic work state");
assert.equal(favoriteControl.getAttribute?.("aria-label") || favoriteControl.attributes.get("aria-label"), "取消收藏", "failed favorite requests must restore control state");
assert.equal(favoriteRollbackMessage, "favorite unavailable", "failed favorite requests must report a useful error");
assert.equal(collectionInvalidationCount, 1, "failed favorite changes must keep valid collection prefetches");
assert(lines("public/js/standalone-host.js") <= 650, "standalone Web host must stay below 650 lines");
const peoplePage = read("public/modules/fanhao/people-page.js");
const webRankingPage = read("public/modules/fanhao/ranking-page.js");
const loadMorePeopleSource = /function loadMorePeopleIndex\(\)\s*\{([\s\S]*?)\n\}/.exec(peoplePage)?.[1] || "";
assert(loadMorePeopleSource.includes("loadMoreRow.before(fragment)"), "people pagination must append cards without replacing the grid");
assert(!loadMorePeopleSource.includes("renderPeopleIndex()"), "people pagination must not rerender the full index");
assert(webApp.includes("appendLoadedPersonWorks();"), "person work pagination must append the next server page without resetting scroll position");
assert(webApp.includes("const prefixMatches = renderedIds.every"), "person work pagination must fall back safely when filters or sorting change during loading");
assert(peoplePage.includes("const PERSON_INDEX_DESKTOP_PAGE_SIZE = 64"), "Web people index must keep the desktop first page compact");
assert(peoplePage.includes("const PERSON_INDEX_MOBILE_PAGE_SIZE = 48"), "Web people index must keep the mobile first page compact");
assert(webApp.includes("state.personPageSize = peoplePage.personIndexPageSize()"), "Web people paging must adapt to the viewport instead of network location");
const fanhaoStyles = read("public/modules/fanhao/styles.css");
const rootStyles = read("public/styles.css");
const personCardStyles = /\.person-index-card\s*\{([\s\S]*?)\n\}/.exec(fanhaoStyles)?.[1] || "";
assert(!personCardStyles.includes("content-visibility"), "people cards must not flash in while scrolling");
assert(rootStyles.includes('modules/fanhao/styles.css?v=20260717-studio-detail-01'), "FanHao style changes must use a fresh browser cache key");
assert(webRankingPage.includes("limit: String(rankingPageSize())"), "Web rankings must request a bounded first page");
assert(webRankingPage.includes("const RANKING_DESKTOP_PAGE_SIZE = 64"), "Web rankings must keep the desktop first page compact");
assert(webRankingPage.includes("const RANKING_MOBILE_PAGE_SIZE = 48"), "Web rankings must use a smaller mobile first page");
assert(webRankingPage.includes('globalThis.matchMedia?.("(max-width: 720px)")'), "Web rankings must select the first page size from the viewport");
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
const prefetchedCollectionCalls = [];
const prefetchedCollectionState = {
  activeView: "vr",
  collectionTotal: 0,
  personWorksFacets: null,
  personWorksTotal: 0,
  searchPeople: [],
  selectedPerson: null,
  selectedPersonId: null,
  selectedStudio: null,
  selectedStudioSeriesId: "all",
  sortMode: "ranking",
  vrTotal: 0,
  workPageSize: 96,
  workVisibleLimit: 96,
  works: []
};
const prefetchedCollectionPage = createCollectionPage({
  api: async (requestPath) => {
    prefetchedCollectionCalls.push(requestPath);
    return {
      count: 64,
      total: 120,
      works: Array.from({ length: 64 }, (_, index) => ({ id: `vr-${index + 1}` }))
    };
  },
  els: { workGrid: { innerHTML: "" } },
  formatNumber: String,
  hidePersonProfile() {},
  renderEmpty() {},
  renderStatsForWorks() {},
  renderWorks() {},
  resetWorkPaging() {
    prefetchedCollectionState.workVisibleLimit = prefetchedCollectionState.workPageSize;
  },
  setMainHeader() {},
  state: prefetchedCollectionState
});
prefetchedCollectionPage.prefetch("vr");
prefetchedCollectionState.sortMode = "releaseDesc";
await prefetchedCollectionPage.loadVrWorks();
assert.equal(prefetchedCollectionCalls.length, 1, "prefetched VR activation must not issue a duplicate first-page request");
assert(prefetchedCollectionCalls[0].includes("limit=64"), "desktop VR prefetch must request only one compact first page");
assert(prefetchedCollectionCalls[0].includes("sort=releaseDesc"), "VR prefetch must normalize ranking state to the sort used after navigation");
assert.equal(prefetchedCollectionState.works.length, 64, "prefetched VR data must render as the active collection page");
const webStudioPage = read("public/modules/fanhao/features/studios/studio-page.js");
const studioSeriesControlStyles = /\.studio-series-controls \.stat-filter-group\s*\{([\s\S]*?)\n\}/.exec(fanhaoStyles)?.[1] || "";
assert(webStudioPage.includes("limit: String(studioPageSize())"), "Web studio details must request a bounded first page");
assert(webStudioPage.includes("const STUDIO_DESKTOP_PAGE_SIZE = 48"), "Web studio details must keep desktop first payloads compact");
assert(webStudioPage.includes("const STUDIO_MOBILE_PAGE_SIZE = 32"), "Web studio details must keep mobile first payloads compact");
assert(webStudioPage.includes('globalThis.matchMedia?.("(max-width: 720px)")'), "Web studio details must use the smaller mobile first page");
assert(webStudioPage.includes("loadMoreStudioWorks"), "Web studio details must preserve server-side continuation");
assert(!webStudioPage.includes('limit: "2000"'), "Web studio details must not fetch every work before first render");
assert(studioSeriesControlStyles.includes("flex-wrap: nowrap"), "studio series filters must stay on one compact row");
assert(studioSeriesControlStyles.includes("overflow-x: auto"), "studio series filters must remain reachable by horizontal scrolling");
assert(webApp.includes("hasStudioServerMore"), "Web work rendering must expose studio continuation");
const studioService = read("src/modules/fanhao/server/catalog/studio-service.js");
const catalogRuntimeSource = read("src/modules/fanhao/server/catalog/runtime.js");
const rankingServiceSource = read("src/modules/fanhao/server/catalog/ranking-service.js");
assert(studioService.includes("const makers = rows.map(publicMakerSummary)"), "studio index responses must use lightweight maker summaries");
assert(!studioService.includes("rows.map((row) => publicMaker(row, seriesRowsForMaker"), "studio indexes must not run one series query per maker");
assert(studioService.includes("const studioWorksCache = new Map()"), "studio detail paging must reuse versioned work sets");
assert(studioService.includes("sortedByMode: new Map()"), "studio detail paging must reuse sorted work lists");
assert(studioService.includes("ensureDetailCaches(stamp)"), "studio detail caches must follow the catalog version stamp");
assert(studioService.includes("studioSummaryRowsCache?.stamp === stamp"), "studio indexes must reuse versioned aggregate rows");
assert(studioService.includes('summaries(new URL("http://fanhao.local/api/studios?limit=500"))'), "studio startup must prepare the complete index response before first navigation");
assert(studioService.includes("prewarmDetails(rows)"), "studio startup must prepare detail sources before the first selection");
assert(studioService.includes("prewarmCoreWorkCovers(pageWorks)"), "studio startup must batch-hydrate first-page covers");
assert(studioService.includes("prewarmWorkInfoDetails(pageWorks)"), "studio startup must batch-hydrate first-page metadata");
assert(catalogRuntimeSource.includes("deps.studioService.prewarm()"), "studio aggregate rows must be ready before the first navigation");
assert(!studioService.includes("enrichLocalWorksWithActorMovieIndex(linkRows"), "studio details must not rerun actor-movie code matching for core library works");
assert(rankingServiceSource.includes("prewarmWorkInfoDetails(pageSource)"), "ranking pages must batch-hydrate visible local work metadata");
assert(rankingServiceSource.includes("hydrateRankingCoverUrls(rankingRows)"), "ranking pages must batch-hydrate cover URLs after the fast list query");
assert(!rankingServiceSource.includes("LEFT JOIN images cover"), "ranking list queries must not run one correlated image lookup per row");
assert(rankingServiceSource.includes("rankingSummariesCache?.stamp === stamp"), "ranking summaries must reuse versioned results");
assert(rankingServiceSource.includes("const RANKING_PREWARM_PAGE_SIZE = 64"), "ranking startup must prepare the desktop first page");
assert(rankingServiceSource.includes("rankingWorkSourcesCache.get(cacheKey)"), "ranking pages must reuse prepared local and missing work sources");
assert(rankingServiceSource.includes("const RANKING_PAGE_CACHE_LIMIT = 64") && rankingServiceSource.includes("userStateStamp()"), "ranking pages must cache complete responses until ranking or user state changes");
assert(rankingServiceSource.includes("const orderedLists = [preferred, ...topLists.filter"), "ranking startup must prepare the default list first");
assert(rankingServiceSource.includes("const source = preparedWorkSource(list.type, list.key)"), "ranking startup must prepare every selectable list source");
assert(rankingServiceSource.includes("prewarmCoreWorkCovers(pageWorks)") && rankingServiceSource.includes("prewarmWorkInfoDetails(pageWorks)"), "ranking startup must batch visible metadata across selectable lists");
assert(catalogRuntimeSource.includes("deps.rankingService.prewarm();"), "ranking summaries and selectable list sources must be ready before first navigation");
assert(personDetailServiceSource.includes("const detailSourceCache = new Map()"), "person navigation must reuse prepared detail sources");
assert(personDetailServiceSource.includes("peoplePayloadStamp(scope)}:${workQueryStamp()"), "person detail sources must follow people and work data versions");
assert(personDetailServiceSource.includes("workQueryService.lightweightFacets(source.works)"), "person facets must remain live without hydrating detail-only metadata");
const workInfoServiceSource = read("src/modules/fanhao/server/works/work-info-service.js");
const workQueryServiceSource = read("src/modules/fanhao/server/works/work-query-service.js");
const workClassificationServiceSource = read("src/modules/fanhao/server/works/work-classification-service.js");
const workCodeIndexServiceSource = read("src/modules/fanhao/server/works/work-code-index-service.js");
const workSearchIndexServiceSource = read("src/modules/fanhao/server/works/work-search-index-service.js");
assert(workInfoServiceSource.includes("prewarmDetailRows(workIds"), "work-info details must support page-level batch hydration");
assert(personDetailServiceSource.includes("{ lightweightInfo: true }") && workQueryServiceSource.includes("lightweightFacets: lightweightWorkFacets"), "person first pages must reuse the lightweight work-list path");
assert(peoplePageSource.includes('includeMissingLocal: state.showMissingLocalWorks ? "1" : "0"') && peoplePageSource.includes('includeCompilation: state.showCompilationWorks ? "1" : "0"'), "person requests must send server-side missing-local and compilation visibility");
assert(workQueryServiceSource.includes("workClassificationService.filterForRequest(sourceWorks, url, filter)") && workQueryServiceSource.indexOf("filterForRequest(sourceWorks, url, filter)") < workQueryServiceSource.indexOf("sortWorkList(matchedWorks"), "person visibility must be filtered on the server before sorting and pagination");
assert(workQueryServiceSource.includes("filters.every((item) => matchesFilter(work, item))"), "server work queries must apply combined filter chips before pagination");
assert(workClassificationServiceSource.includes("function isCompilation(work)") && workClassificationServiceSource.includes("function filterForRequest(works, url, filter"), "compilation classification and visibility must live on the server");
assert(personDetailServiceSource.includes('url.searchParams.get("includeMissingLocal")') && personDetailServiceSource.includes('url.searchParams.get("includeCompilation")'), "person page caches must distinguish server visibility options");
assert(webApp.includes('if (state.activeView === "people" && state.selectedPersonId) return state.works;'), "person cards must render the server page without client-side visibility filtering or sorting");
assert(webApp.includes("state.workVisibleLimit = Math.max(state.workVisibleLimit, state.works.length);"), "person continuation must expose each server page immediately instead of adding a second client paging layer");
const workAutoloadSource = /function setupWorkLoadMoreAutoload\([\s\S]*?\r?\n}\r?\n\r?\nfunction renderEmpty/.exec(webApp)?.[0] || "";
assert(workAutoloadSource.includes("new IntersectionObserver"), "work continuation must use viewport observation for automatic loading");
assert(!workAutoloadSource.includes('window.addEventListener("wheel"') && !workAutoloadSource.includes("userScrollIntentUntil"), "work continuation must not depend on short-lived wheel intent timing");
assert(workQueryServiceSource.includes("missing.filter((work) => work.missingLocal)"), "lightweight person pages must batch-hydrate SQL covers for missing-local works");
assert(workPresenterServiceSource.includes("if (work.missingLocal) {\n      // Missing-local works") && workPresenterServiceSource.includes("const coreCover = publicCoreWorkCover(work.id);"), "missing-local work cards must expose their cached SQL cover in lightweight pages");
assert(workQueryServiceSource.includes("prewarmWorkInfoDetails(missing)"), "work lists must batch-hydrate only unprepared detail rows before presentation");
assert(workQueryServiceSource.includes("prewarmVideoProbesForWorks(missing)"), "visible work pages must prepare playback probes only for unprepared works");
assert(workQueryServiceSource.includes("const LIST_PAGE_CACHE_LIMIT = 96") && workQueryServiceSource.includes("const WORK_PAYLOAD_CACHE_LIMIT = 4096"), "work lists must retain complete pages and prepared work payloads in bounded caches");
assert(workQueryServiceSource.includes("const PREWARM_PAGE_SIZES = [48, 64]"), "work-list startup must prepare phone and desktop response sizes");
assert(workQueryServiceSource.includes("const LEGACY_MOBILE_PROGRESS_LIMIT = 720") && workQueryServiceSource.includes("scheduleLegacyMobileProgressPrewarm()"), "old Android progress feeds must be prepared after startup");
assert(workQueryServiceSource.includes("const LEGACY_MOBILE_PREWARM_BATCH_SIZE = 48") && workQueryServiceSource.includes("scheduleBackground(prepareNextBatch"), "legacy Android progress preparation must yield between phone-sized batches");
assert(workQueryServiceSource.includes("function ensureWorkPayloadCache()") && !workQueryServiceSource.includes("listPageCache = new Map();\n    workPayloadCache = new Map();"), "favorite and progress changes must preserve prepared static work payloads");
assert(workQueryServiceSource.includes("publicWorkUserState(work)") && workQueryServiceSource.includes("favoriteStateService.publicFavoriteForWork?.(work.id)"), "reused work payloads must refresh their live favorite and progress fields");
assert(workQueryServiceSource.includes('["vr", "updated"]') && workQueryServiceSource.includes('["vr", "releaseDesc"]'), "VR startup must prepare Android and Web default ordering");
assert(workQueryServiceSource.includes("dynamicFacetCache.get(works)") && workQueryServiceSource.includes("userStateStamp()"), "work-list dynamic facets must remain cached until user state changes");
assert(workInfoServiceSource.includes("function facetRowsById()"), "work-list facets must use a compact metadata index");
assert(workQueryServiceSource.includes("staticWorkFacets(works);"), "compact work facets must be ready before the first list request");
assert(workQueryServiceSource.includes("sortWorkList(works, \"releaseDesc\")"), "the default work-list order must be ready before the first request");
assert(workQueryServiceSource.includes("[\"playable\", \"info\", \"rated\", \"highRating\", \"vr\"]"), "common work filters must be ready before first navigation");
assert(workQueryServiceSource.includes("prewarmWorkSearch([...rankingMissingWorks, ...actorMissingWorks]);"), "local and missing-work search indexes must be ready before the first query");
assert(workQueryServiceSource.indexOf("if (usesTextMatcher) prewarmWorkSearch") < workQueryServiceSource.indexOf("const matchesQuery = usesTextMatcher"), "cache invalidation must reindex missing-work candidates before matching a new text query");
assert(workQueryServiceSource.includes("prewarmPersonMerge();"), "person merge maps must be ready before the first search request");
assert(workQueryServiceSource.includes("const searchSourceCache = new Map()"), "search paging and return navigation must reuse matched work sources");
assert(workQueryServiceSource.includes("const source = cachedSearchSource(rawQuery"), "search responses must use the versioned matched-work cache");
assert(workQueryServiceSource.includes("source.facetsCache?.stamp === stamp"), "search facets must only refresh after user state changes");
assert(workQueryServiceSource.includes("const exactPersonSearch ="), "exact person searches must bypass the full local text scan");
assert(workCodeIndexServiceSource.includes("localWorkCodeIndexCache = { stamp, keys, rows, searchRows, prefixRows }"), "local code membership and work lookup must share one catalog pass");
assert(workCodeIndexServiceSource.includes("while (low < high)"), "local code-prefix search must use the sorted code index");
assert(workCodeIndexServiceSource.includes("let workCodeKeysCache = new WeakMap()"), "repeated person and catalog lookups must reuse parsed work code keys");
assert(workSearchIndexServiceSource.includes("const postings = new Map()"), "full-text search must build an in-memory candidate index during prewarm");
assert(workSearchIndexServiceSource.includes("function rarestPosting"), "search candidate selection must start from the rarest query gram");
assert(workSearchIndexServiceSource.includes("candidateIds && isIndexedWork && !candidateIds.has(work.id)"), "new search terms must skip exact checks for unrelated indexed works");
assert(lines("src/modules/fanhao/server/works/work-search-index-service.js") <= 240, "the work-search index service must stay focused");
assert(missingCodeSearchServiceSource.includes("missingCodeSearchPending: true"), "broad code-prefix searches must defer non-page detail hydration");
assert(missingCodeSearchServiceSource.includes("WHERE w.id IN (${placeholders})"), "visible missing-code results must batch-hydrate one page of details");
assert(missingCodeSearchServiceSource.includes("coverWorkIdsCache?.stamp === stamp"), "broad code-prefix searches must reuse the in-memory cover membership index");
assert(!missingCodeSearchServiceSource.includes("EXISTS (\n            SELECT 1\n            FROM images image"), "broad code-prefix result scans must not probe the cover index once per candidate");
assert(!missingCodeSearchServiceSource.includes("LIMIT 5000"), "code-prefix search must not truncate broad missing-work results");
assert(read("server.js").includes("missingCodeSearchService.prewarm();"), "FanHao startup must prepare broad-search cover membership before the first request");
assert(read("server.js").includes("hydrateMissingSearchWorks: missingCodeSearchService.hydrate"), "FanHao search composition must use page-level missing-result hydration");
const searchIndexWorks = [
  {
    id: "work-1",
    personId: "person-1",
    personName: "甲",
    title: "人妻精选",
    directoryName: "ABC-123",
    relativePath: "甲/ABC-123",
    videos: [{ name: "rare-file-token.mp4", title: "", relativePath: "甲/ABC-123/rare-file-token.mp4" }],
    images: [],
    infos: []
  },
  {
    id: "work-2",
    personId: "person-2",
    personName: "乙",
    title: "普通作品",
    directoryName: "DEF-456",
    relativePath: "乙/DEF-456",
    videos: [],
    images: [],
    infos: []
  }
];
const searchIndexLibrary = {
  scannedAt: "fixture-v1",
  peopleById: new Map([
    ["person-1", { id: "person-1", name: "甲" }],
    ["person-2", { id: "person-2", name: "乙" }]
  ]),
  worksById: new Map(searchIndexWorks.map((work) => [work.id, work]))
};
const searchIndex = createWorkSearchIndexService({
  getCoreDb: () => ({ prepare: () => ({ all: () => [] }) }),
  getLibrary: () => searchIndexLibrary,
  getSourceStamp: () => "fixture-v1",
  getWorkInfoStamp: () => "fixture-info-v1",
  normalizeSearchValue: (value) => String(value || "").toLowerCase().replace(/[\s._\-()[\]【】（）]+/g, ""),
  parseJsonArray: () => [],
  parseJsonTextArray: () => []
});
searchIndex.prewarm();
assert.deepEqual(searchIndexWorks.filter(searchIndex.createMatcher("人妻")).map((work) => work.id), ["work-1"], "indexed search must preserve title matches");
assert.deepEqual(searchIndexWorks.filter(searchIndex.createMatcher("abc123")).map((work) => work.id), ["work-1"], "indexed search must preserve normalized code matches");
assert.deepEqual(searchIndexWorks.filter(searchIndex.createMatcher("rare-file-token")).map((work) => work.id), ["work-1"], "indexed search must preserve raw file-name matches");
assert.deepEqual(searchIndexWorks.filter(searchIndex.createMatcher("桥本")).map((work) => work.id), [], "indexed search must reject absent terms without changing results");
const externalSearchWork = {
  id: "external-work",
  personId: "",
  personName: "",
  title: "人妻外部榜单作品",
  directoryName: "EXT-001",
  relativePath: "",
  videos: [],
  images: [],
  infos: []
};
assert.equal(searchIndex.createMatcher("人妻")(externalSearchWork), true, "candidate pruning must preserve non-local ranking and actor matches");
searchIndex.prewarm([externalSearchWork]);
assert.equal(searchIndex.createMatcher("人妻")(externalSearchWork), true, "candidate pruning must preserve prewarmed external matches");
const workImageServiceSource = read("src/modules/fanhao/server/works/image-service.js");
assert(workImageServiceSource.includes("FROM local_works lw"), "work-cover facets must index only local catalog entries");
assert(!workImageServiceSource.includes("SELECT DISTINCT CAST(owner_id AS TEXT)"), "work-cover facets must not hydrate every historical image owner");
assert(workImageServiceSource.includes("owner_id IN (${placeholders})"), "visible work covers must load metadata in bounded batches");
assert(workImageServiceSource.includes("workCoverMetadataCache = { stamp, rows: new Map() }"), "work-cover metadata batches must be reused until the image table changes");
const mediaResponseServiceSource = read("src/platform/server/media-response-service.js");
const mediaBlobWorkerClientSource = read("src/platform/server/media-blob-worker-client.js");
const mediaBlobWorkerSource = read("src/platform/server/media-blob-worker.js");
assert(mediaResponseServiceSource.includes("cachedRemoteImageUrls(remoteUrls)"), "visible work pages must batch-check warmed remote images");
assert(mediaResponseServiceSource.includes("work.cachedCover?.coverUrl, work.remoteCoverUrl"), "SQL cover metadata must still prewarm remote image blobs that are not cached yet");
assert(mediaResponseServiceSource.includes("await cachedMediaBlobRow"), "database-backed images must leave synchronous request handling");
assert(mediaResponseServiceSource.includes("mediaBlobCacheMaxBytes = 512 * 1024 * 1024"), "database-backed images must reuse a bounded memory hot cache");
assert(mediaResponseServiceSource.includes("remoteImageWarmQueue.length + remoteImageWarmActive >= queueLimit"), "remote-image prewarming must keep its backlog bounded");
assert(mediaResponseServiceSource.includes("for (const remoteUrl of remoteImageWarmQueue) remoteImageWarmQueued.delete(remoteUrl)"), "newly visible remote images must discard stale queued downloads");
assert(!mediaResponseServiceSource.includes("remoteImageCacheRow(remoteUrl)?.image_blob || remoteImageWarmQueued"), "remote-image warming must not read cached blobs on the response path");
assert(!mediaResponseServiceSource.includes("WHERE image_blob IS NOT NULL AND url IN"), "remote-image warming must use the URL covering index instead of opening cached blobs");
assert(mediaBlobWorkerClientSource.includes("new WorkerCtor"), "database-backed image reads must run outside the server main thread");
assert(mediaBlobWorkerSource.includes("SELECT image_blob, mime FROM images WHERE id = ?"), "the media worker must own core-image blob reads");
assert(mediaBlobWorkerSource.includes("INSERT INTO remote_image_cache"), "the media worker must own remote-image blob writes");

const server = read("server.js");
assert(server.includes("createFanhaoDependencies({"), "server composition must delegate FanHao dependency grouping");
assert(!/fanhao:\s*\{\s*catalog:/s.test(server), "server.js must not own FanHao runtime buckets");
assert(server.includes("if (!missingLocal && !work.coverId && !workHasCoreCover(work.id))"), "catalog facets must use the compact core-cover index");
assert(!server.includes("return !work.coverId && !workCoverRow(work.id);"), "catalog facets must not read cover blobs while counting missing covers");
assert(workSearchIndexServiceSource.includes("normalized: normalizeSearchValue(normalizedValues.join"), "deep raw metadata must stay out of the normalization hot path");
assert(server.includes("function prewarmWorkSearch(works = [])"), "local and missing-work search text must be prepared before the first query");
const worksRuntime = read("src/modules/fanhao/server/works/runtime.js");
assert(worksRuntime.includes("activeRequestDeps"), "work services must be reused for the active library snapshot");
assert(worksRuntime.includes("workQueryService.prewarm()"), "FanHao work queries must prewarm their full-library enrichment cache before serving requests");
const libraryRuntime = read("src/modules/fanhao/server/library/runtime.js");
const personListServiceSource = read("src/modules/fanhao/server/people/person-list-service.js");
const fanhaoRuntime = read("src/modules/fanhao/server/runtime.js");
const userStateRuntime = read("src/modules/fanhao/server/user-state/runtime.js");
const collectionQueryServiceSource = read("src/modules/fanhao/server/user-state/collection-query-service.js");
assert(libraryRuntime.includes("prewarmLibraryPeoplePayloads(requestDeps())"), "FanHao must prepare people payloads before the first library request");
assert(personListServiceSource.includes("const mainPeopleCache = new Map()"), "main and western people scopes must remain cached independently");
assert(fanhaoRuntime.includes("library.start();"), "FanHao startup must prewarm the library response path");
assert(fanhaoRuntime.includes("catalog.start();"), "FanHao startup must prewarm the catalog response path");
assert(fanhaoRuntime.includes("userState.start();"), "FanHao startup must prewarm user collection response paths");
assert(userStateRuntime.includes("createCollectionQueryService(deps)") && userStateRuntime.includes("collectionQueryService.prewarm()"), "collection startup must delegate complete response preparation to one query service");
assert(collectionQueryServiceSource.includes("const COLLECTION_PREWARM_PAGE_SIZES = [8, 48, 64]"), "collection startup must prepare preview, phone, and desktop response sizes");
assert(collectionQueryServiceSource.includes("[0, 7, Number(recentWatchedDays || 0)]"), "collection startup must prepare all-time, seven-day, and default history ranges");
assert(collectionQueryServiceSource.includes("const COLLECTION_PAGE_CACHE_LIMIT = 64") && collectionQueryServiceSource.includes("userStateStamp()") && collectionQueryServiceSource.includes("workQueryStamp()"), "collection responses must stay cached until catalog or user state changes");
const workInfoService = read("src/modules/fanhao/server/works/work-info-service.js");
const workPresenterService = read("src/modules/fanhao/server/works/presenter-service.js");
const workMediaRoutes = read("src/modules/fanhao/server/works/routes-media.js");
const coreDbService = read("src/modules/fanhao/server/library/core-db-service.js");
const coreImageStoreSource = read("src/platform/server/core-image-store.js");
const tableStampQuerySource = read("src/modules/fanhao/server/library/table-stamp-query.js");
const userStateRoutes = read("src/modules/fanhao/server/user-state/routes.js");
const userStateServiceSource = read("src/modules/fanhao/server/collections/user-state-service.js");
assert(workInfoService.includes("function detailRow(workId)"), "work metadata must load full details per work instead of hydrating the entire catalog");
assert(workInfoService.includes("SELECT 1\n              FROM local_works"), "work-list metadata must use a lightweight local-work index query");
assert(workPresenterService.includes("workInfoDetailRow(work.id)"), "work cards and details must hydrate full metadata only for the visible page");
assert(userStateRoutes.includes("collectionQueryService.favoritesPayload(url)") && userStateRoutes.includes("collectionQueryService.historyPayload(url)"), "collection routes must delegate response assembly to the cached query service");
assert(workMediaRoutes.includes("/media\\/person\\/([^/]+)\\/cover"), "person-list avatars must use a stable compact media URL");
assert(coreDbService.includes("const DEFAULT_TABLE_STAMP_CACHE_MS = 5000"), "FanHao table stamps must not rescan the core database between nearby interactions");
assert(coreDbService.includes("idx_works_updated_at ON works(updated_at)"), "work-info stamps must use a lightweight updated-at index");
assert(coreDbService.includes("idx_works_status_code_search ON works(status, code_search, id)"), "code-prefix searches must use a status-aware covering index");
assert(coreDbService.includes("idx_work_people_updated_at ON work_people(updated_at)"), "actor-movie stamps must use a lightweight updated-at index");
assert(coreImageStoreSource.includes("idx_images_updated_at") && coreImageStoreSource.includes("ON images(updated_at)"), "cover stamps must use a lightweight table-specific update index");
assert(coreDbService.includes("attachCoreImageStore(db, { dbPath: imageDbPath })"), "core queries must attach the separated image database");
assert(mediaBlobWorkerSource.includes("attachCoreImageStore(db, { dbPath: workerData.imageDbPath })"), "media workers must read and write the separated image database");
assert(tableStampQuerySource.includes("MAX(updated_at)"), "table stamps must track changes in their own target table");
assert(!tableStampQuerySource.includes("PRAGMA data_version"), "unrelated SQLite writes must not invalidate every FanHao cache");
assert(collectionQueryServiceSource.includes("allWorks.slice(offset, offset + limit)"), "favorites must paginate before presenting work details");
assert(collectionQueryServiceSource.includes("entries.slice(offset, offset + limit)"), "history must paginate before presenting work details");
assert(userStateServiceSource.includes("stateRevision += 1"), "favorite and progress mutations must version cached search facets");
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
const workClassificationService = createWorkClassificationService({
  appConfigService: {
    current: () => ({ compilationPrefixes: ["KWBD"], compilationKeywords: ["総集編"] })
  }
});
const classifiedWorks = [
  { id: "local", title: "LOCAL-001", missingLocal: false },
  { id: "missing", title: "NORMAL-001", missingLocal: true },
  { id: "prefix", title: "KWBD-001", missingLocal: true, infoSummary: { code: "KWBD-001" } },
  { id: "keyword", title: "SPECIAL 総集編", missingLocal: true }
];
assert.equal(workClassificationService.isCompilation(classifiedWorks[0]), false, "local works must not be classified as compilation placeholders");
assert.equal(workClassificationService.isCompilation(classifiedWorks[2]), true, "server compilation classification must honor configured prefixes");
assert.equal(workClassificationService.isCompilation(classifiedWorks[3]), true, "server compilation classification must honor configured keywords");
assert.deepEqual(
  workClassificationService.filterForRequest(classifiedWorks, new URL("http://fanhao.local/api/people/1?includeMissingLocal=0&includeCompilation=0")),
  [classifiedWorks[0]],
  "server visibility must remove missing-local and compilation works before pagination"
);
assert.deepEqual(
  workClassificationService.filterForRequest(classifiedWorks, new URL("http://fanhao.local/api/people/1?includeMissingLocal=1&includeCompilation=0")),
  [classifiedWorks[0], classifiedWorks[1]],
  "server visibility must allow ordinary missing-local works without leaking compilations"
);
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

let lazyAdminLoadCount = 0;
const lazyAdminCalls = [];
const lazyAdmin = createLazyAdminModal(async () => {
  lazyAdminLoadCount += 1;
  return { openModal: (options) => lazyAdminCalls.push(options.scriptId) };
});
assert.equal(lazyAdminLoadCount, 0, "the admin console must stay unloaded during FanHao startup");
await Promise.all([lazyAdmin.openModal({ scriptId: "first" }), lazyAdmin.openModal({ scriptId: "second" })]);
assert.equal(lazyAdminLoadCount, 1, "concurrent admin actions must share one module load");
assert.deepEqual(lazyAdminCalls, ["first", "second"], "queued admin actions must run after the module is ready");

let lazyAdminRetryCount = 0;
const retryableLazyAdmin = createLazyAdminModal(async () => {
  lazyAdminRetryCount += 1;
  if (lazyAdminRetryCount === 1) throw new Error("temporary import failure");
  return { openModal: () => "ready" };
});
await assert.rejects(retryableLazyAdmin.openModal({}), /temporary import failure/);
assert.equal(await retryableLazyAdmin.openModal({}), "ready", "a failed lazy import must be retryable");

const profileElement = {
  classList: { remove() {} },
  hidden: false,
  innerHTML: "existing"
};
let lazyProfileLoadCount = 0;
const lazyProfileRenders = [];
const lazyProfile = createLazyPersonProfile({
  els: { personProfile: profileElement },
  loadPersonProfile: async () => {
    lazyProfileLoadCount += 1;
    return { render: (person) => lazyProfileRenders.push(person.id) };
  }
});
lazyProfile.hide();
assert.equal(lazyProfileLoadCount, 0, "hiding the empty profile shell must not load person-profile code");
assert.equal(profileElement.hidden, true);
assert.equal(profileElement.innerHTML, "");
await Promise.all([lazyProfile.render({ id: "first" }), lazyProfile.load()]);
assert.equal(lazyProfileLoadCount, 1, "profile prefetch and render must share one module load");
assert.deepEqual(lazyProfileRenders, ["first"]);

let resolveStaleProfile;
const staleProfileRenders = [];
const staleLazyProfile = createLazyPersonProfile({
  els: { personProfile: profileElement },
  loadPersonProfile: () => new Promise((resolve) => { resolveStaleProfile = resolve; })
});
const staleRender = staleLazyProfile.render({ id: "stale" });
await Promise.resolve();
staleLazyProfile.hide();
resolveStaleProfile({ render: (person) => staleProfileRenders.push(person.id) });
await staleRender;
assert.deepEqual(staleProfileRenders, [], "a profile module resolving after navigation must not render stale person data");

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
for (const detailCount of ["videoCount", "playableCount", "imageCount", "infoCount", "isGSource"]) {
  assert(!(detailCount in personListItem), `person-list summaries must defer detail field: ${detailCount}`);
}
for (const actorDetail of ["movieCount", "javdbUrl", "javdbRefs"]) {
  assert(!(actorDetail in personListItem.actorProfile), `person-list summaries must defer actor detail: ${actorDetail}`);
}

const collectionPrepareEvents = [];
const collectionSourceWorks = [{ id: "history-1" }, { id: "history-2" }];
const preparedCollectionWorks = prepareCollectionWorkPage(collectionSourceWorks, {
  prewarmCoreWorkCovers(works) {
    collectionPrepareEvents.push(`cover:${works.length}`);
  },
  prewarmVideoProbesForWorks(works) {
    collectionPrepareEvents.push(`video:${works.length}`);
  },
  prewarmWorkInfoDetails(works) {
    collectionPrepareEvents.push(`info:${works.length}`);
  },
  publicWork(work) {
    collectionPrepareEvents.push(`public:${work.id}`);
    return { id: work.id, prepared: true };
  },
  prewarmRemoteImagesForWorks(works) {
    collectionPrepareEvents.push(`image:${works.length}`);
  }
});
assert.deepEqual(
  collectionPrepareEvents,
  ["cover:2", "video:2", "info:2", "public:history-1", "public:history-2", "image:2"],
  "collection pages must batch-prepare details before presentation and warm visible media afterward"
);
assert.deepEqual(preparedCollectionWorks.map((work) => work.id), ["history-1", "history-2"], "collection page preparation must preserve order");

let collectionQueryStateStamp = "state-v1";
let collectionQueryWorkStamp = "works-v1";
let collectionQueryPublicWorkCount = 0;
const collectionQueryWorks = [{ id: "collection-1" }, { id: "collection-2" }];
const collectionQueryLibrary = {
  scannedAt: "scan-v1",
  worksById: new Map(collectionQueryWorks.map((work) => [work.id, work]))
};
const cachedCollectionQueryService = createCollectionQueryService({
  clampInteger(value, fallback, min, max) {
    const number = value === null || value === "" ? fallback : Number(value);
    return Math.max(min, Math.min(max, Number.isFinite(number) ? number : fallback));
  },
  favoriteStateService: {
    favoriteWorks: () => collectionQueryWorks,
    normalizeFavoriteFolderId: () => "default",
    publicFavoriteFolders: () => [{ id: "default", name: "默认收藏", count: collectionQueryWorks.length }]
  },
  getLibrary: () => collectionQueryLibrary,
  maxWorkLimit: 2000,
  playbackProgressService: {
    historyEntries: () => collectionQueryWorks.map((work) => ({ work }))
  },
  prewarmCoreWorkCovers: () => {},
  prewarmRemoteImagesForWorks: () => {},
  prewarmVideoProbesForWorks: () => {},
  prewarmWorkInfoDetails: () => {},
  publicWork(work) {
    collectionQueryPublicWorkCount += 1;
    return { id: work.id, state: collectionQueryStateStamp, workStamp: collectionQueryWorkStamp };
  },
  recentWatchedDays: 30,
  userStateStamp: () => collectionQueryStateStamp,
  workQueryStamp: () => collectionQueryWorkStamp
});
const collectionHistoryUrl = new URL("http://127.0.0.1/api/history?days=30&limit=2&offset=0");
const cachedCollectionFirst = cachedCollectionQueryService.historyPayload(collectionHistoryUrl);
const cachedCollectionSecond = cachedCollectionQueryService.historyPayload(collectionHistoryUrl);
assert.equal(cachedCollectionSecond, cachedCollectionFirst, "identical collection requests must reuse the complete response object");
assert.equal(collectionQueryPublicWorkCount, 2, "repeated collection pages must not present the same works twice");
cachedCollectionQueryService.historyPayload(new URL("http://127.0.0.1/api/history?days=30&limit=1&offset=0"));
assert.equal(collectionQueryPublicWorkCount, 2, "phone and preview page sizes must reuse prepared work payloads");
collectionQueryStateStamp = "state-v2";
const collectionAfterStateChange = cachedCollectionQueryService.historyPayload(collectionHistoryUrl);
assert.notEqual(collectionAfterStateChange, cachedCollectionFirst, "progress and favorite changes must invalidate complete collection pages");
assert.equal(collectionQueryPublicWorkCount, 4, "user-state changes must refresh presented collection works");
collectionQueryWorkStamp = "works-v2";
cachedCollectionQueryService.historyPayload(collectionHistoryUrl);
assert.equal(collectionQueryPublicWorkCount, 6, "catalog metadata changes must refresh presented collection works");
cachedCollectionQueryService.favoritesPayload(new URL("http://127.0.0.1/api/favorites?limit=2&offset=0"));
assert.equal(collectionQueryPublicWorkCount, 6, "favorites and history must share prepared work payloads within one version");

let personDetailDataStamp = "person-v1";
let personDetailUserStateStamp = "user-v1";
let personDetailSourceBuildCount = 0;
let personDetailFacetReadCount = 0;
let personDetailPayloadReadCount = 0;
let personDetailPayloadOptions = null;
const personDetailFixture = { id: "person-1", name: "Person One", works: ["work-1"] };
const personDetailLibrary = {
  scannedAt: "scan-v1",
  worksById: new Map([["work-1", { id: "work-1", personId: "person-1", title: "Work One" }]])
};
const cachedPersonDetailService = createPersonDetailService({
  actorProfileMergeCandidates: () => [],
  actorProfileRow: () => null,
  adminCoreMutationService: {},
  coreMissingWorksForPerson() {
    personDetailSourceBuildCount += 1;
    return [];
  },
  corePersonFallbackRecord: () => null,
  dedupeWorksForDisplay: (works) => works,
  enrichLocalWorksWithActorMovieInfo: (works) => works,
  library: personDetailLibrary,
  manualCoverStateService: {},
  maxActorAvatarBytes: 1024,
  mergedActorMovieRows: () => [],
  mergedPersonRecord: (person) => person,
  missingActorWorksForPerson: () => [],
  peoplePayloadStamp: () => personDetailDataStamp,
  peopleScopeService: {
    normalize: () => "main",
    personMatches: () => true,
    workMatches: () => true
  },
  publicActorProfile: () => null,
  publicPerson: (person) => ({ id: person.id, name: person.name }),
  resolveLibraryPersonByPublicId: (personId) => personId === personDetailFixture.id ? personDetailFixture : null,
  storedWorkCodeKey: (value) => String(value || "").toLowerCase(),
  workLocalMutationService: {},
  workCodeKeySetForWorks: () => new Set(["work1"]),
  workQueryService: {
    visibilityStamp: () => "visibility-v1",
    lightweightFacets(works) {
      personDetailFacetReadCount += 1;
      return { all: works.length, favorite: personDetailFacetReadCount };
    },
    listFromWorksPayload(works, url, extra, options) {
      personDetailPayloadReadCount += 1;
      personDetailPayloadOptions = options;
      return { ...extra, count: works.length, total: works.length, filter: extra.filter, works };
    }
  },
  userStateStamp: () => personDetailUserStateStamp,
  workQueryStamp: () => "works-v1"
});
const personDetailUrl = new URL("http://127.0.0.1/api/people/person-1?filter=all&limit=48&offset=0");
const firstPersonDetail = cachedPersonDetailService.detailPayload("person-1", personDetailUrl);
assert.equal(personDetailServiceSource.includes("skipFallbackAvatar: true"), true, "person detail APIs must not rescan works for fallback avatars");
assert.deepEqual(personDetailPayloadOptions, { lightweightInfo: true }, "person detail first pages must not synchronously hydrate work-detail-only metadata");
const cachedFirstPersonDetail = cachedPersonDetailService.detailPayload("person-1", new URL(personDetailUrl));
assert.equal(personDetailFacetReadCount, 1, "identical person pages must reuse prepared facets while user state is unchanged");
assert.equal(personDetailPayloadReadCount, 1, "identical person pages must reuse their complete prepared response");
assert.equal(cachedFirstPersonDetail.works, firstPersonDetail.works, "cached person pages must preserve the prepared work list");
const repeatedPersonDetail = cachedPersonDetailService.detailPayload("person-1", new URL("http://127.0.0.1/api/people/person-1?filter=rated&limit=48&offset=48"));
assert.equal(personDetailSourceBuildCount, 1, "repeated person paging and filters must reuse the prepared work source");
assert.equal(personDetailFacetReadCount, 2, "person detail facets must still read live favorite and progress state");
assert.equal(personDetailPayloadReadCount, 2, "person detail paging must still build each requested response");
assert.equal(firstPersonDetail.person.id, "person-1", "prepared person details must preserve the person payload");
assert.equal(repeatedPersonDetail.filter, "rated", "prepared person details must preserve per-request filters");
personDetailUserStateStamp = "user-v2";
cachedPersonDetailService.detailPayload("person-1", personDetailUrl);
assert.equal(personDetailFacetReadCount, 3, "favorite and progress changes must invalidate prepared person facets");
assert.equal(personDetailPayloadReadCount, 3, "favorite and progress changes must invalidate prepared person pages");
personDetailDataStamp = "person-v2";
cachedPersonDetailService.detailPayload("person-1", personDetailUrl);
assert.equal(personDetailSourceBuildCount, 2, "person data changes must invalidate prepared detail sources");

let personMergeStamp = "merge-v1";
let mergedPersonWorkLookupCount = 0;
class CountingMergedWorkMap extends Map {
  get(key) {
    mergedPersonWorkLookupCount += 1;
    return super.get(key);
  }
}
const mergedPersonA = { id: "merge-a", name: "Merge A", relativePath: "F:/Merge A", sourcePaths: ["F:/Merge A"], sourceCount: 1, workCount: 2, works: ["merge-work-a1", "merge-work-a2"] };
const mergedPersonB = { id: "merge-b", name: "Merge B", relativePath: "G:/Merge B", sourcePaths: ["G:/Merge B"], sourceCount: 1, workCount: 1, works: ["merge-work-b1"] };
const personMergeLibrary = {
  people: [mergedPersonA, mergedPersonB],
  peopleById: new Map([[mergedPersonA.id, mergedPersonA], [mergedPersonB.id, mergedPersonB]]),
  worksById: new CountingMergedWorkMap([
    ["merge-work-a1", { id: "merge-work-a1", videoCount: 1, playableCount: 1, imageCount: 0, infoCount: 1 }],
    ["merge-work-a2", { id: "merge-work-a2", videoCount: 1, playableCount: 1, imageCount: 1, infoCount: 0 }],
    ["merge-work-b1", { id: "merge-work-b1", videoCount: 1, playableCount: 0, imageCount: 0, infoCount: 1 }]
  ])
};
const cachedPersonMergeService = createPersonMergeService({
  actorMovieRows: () => [],
  actorProfileAliases: () => [],
  actorProfileRow: (personId) => ({ javdb_actor_id: personId ? "actor-one" : "" }),
  getLibrary: () => personMergeLibrary,
  getStamp: () => personMergeStamp,
  normalizePersonSearchValue: (value) => String(value || "").trim().toLowerCase(),
  normalizeSourcePath: (value) => String(value || "").replaceAll("\\", "/").toLowerCase(),
  personHasVrMergeContent: () => false,
  preferredPersonDisplayName: (_row, fallback) => fallback,
  uniquePersonNames: (values) => [...new Set((values || []).filter(Boolean))]
});
const firstMergedPersonRecord = cachedPersonMergeService.record(mergedPersonA);
const firstMergedPersonLookupCount = mergedPersonWorkLookupCount;
assert.equal(firstMergedPersonRecord.works.length, 3, "merged person records must still combine every member work");
assert.equal(cachedPersonMergeService.record(mergedPersonB), firstMergedPersonRecord, "aliases must reuse the canonical merged person record");
assert.equal(mergedPersonWorkLookupCount, firstMergedPersonLookupCount, "repeated merged person presentation must avoid rescanning every member work");
personMergeStamp = "merge-v2";
cachedPersonMergeService.record(mergedPersonA);
assert(mergedPersonWorkLookupCount > firstMergedPersonLookupCount, "person merge data changes must rebuild cached records");

let studioDataStamp = "studio-v1";
let studioCatalogReadCount = 0;
let studioSummaryReadCount = 0;
let studioMakerDetailReadCount = 0;
let studioSeriesReadCount = 0;
let studioWorksReadCount = 0;
let studioSortCount = 0;
let studioCoverPrewarmCount = 0;
let studioInfoPrewarmCount = 0;
let studioPagePayloadCount = 0;
let studioUserStateStamp = "studio-user-v1";
const studioRows = [
  { maker_id: "1", name: "Studio One", normalized_name: "studio one", javdb_url: "", source: "test", work_count: 10, local_work_count: 8, first_release_date: "2024-01-01", latest_release_date: "2026-01-01" },
  { maker_id: "2", name: "Studio Two", normalized_name: "studio two", javdb_url: "", source: "test", work_count: 2, local_work_count: 1, first_release_date: "2025-01-01", latest_release_date: "2026-01-02" }
];
const cachedStudioService = createStudioService({
  clampInteger: (value, fallback, min, max) => Math.max(min, Math.min(max, Number(value ?? fallback))),
  getCoreDb: () => ({
    prepare(sql) {
      if (sql.includes("SELECT COUNT(*) FROM makers")) {
        return {
          get() {
            studioCatalogReadCount += 1;
            return { maker_count: 2, series_count: 0, link_count: 12 };
          }
        };
      }
      if (sql.includes("FROM makers m")) {
        return {
          all() {
            studioSummaryReadCount += 1;
            return studioRows;
          },
          get(makerId) {
            studioMakerDetailReadCount += 1;
            return studioRows.find((row) => Number(row.maker_id) === Number(makerId)) || null;
          }
        };
      }
      if (sql.includes("FROM series s")) {
        return {
          all() {
            studioSeriesReadCount += 1;
            return [];
          }
        };
      }
      if (sql.includes("FROM work_makers wm")) {
        return {
          all() {
            studioWorksReadCount += 1;
            return [];
          }
        };
      }
      throw new Error(`unexpected studio query: ${sql.slice(0, 80)}`);
    }
  }),
  getLibrary: () => ({ worksById: new Map() }),
  getStamp: () => studioDataStamp,
  pagedWorksPayload: () => {
    studioPagePayloadCount += 1;
    return {};
  },
  prewarmCoreWorkCovers: () => {
    studioCoverPrewarmCount += 1;
  },
  prewarmWorkInfoDetails: () => {
    studioInfoPrewarmCount += 1;
  },
  publicRemoteUrl: (value) => value,
  sortWorkList: (works) => {
    studioSortCount += 1;
    return works;
  },
  userStateStamp: () => studioUserStateStamp,
  workFacets: () => ({})
});
cachedStudioService.prewarm();
assert.equal(studioMakerDetailReadCount, 2, "studio startup must prepare every visible maker detail");
assert.equal(studioSeriesReadCount, 2, "studio startup must prepare every visible maker series list");
assert.equal(studioWorksReadCount, 2, "studio startup must prepare every visible maker work set");
assert.equal(studioSortCount, 2, "studio startup must prepare the default order for every visible maker");
assert.equal(studioCoverPrewarmCount, 1, "studio startup must batch first-page cover preparation");
assert.equal(studioInfoPrewarmCount, 1, "studio startup must batch first-page metadata preparation");
assert.equal(studioPagePayloadCount, 4, "studio startup must prepare phone and desktop detail pages for visible makers");
const studioSummaryUrl = new URL("http://127.0.0.1/api/studios?limit=500");
assert.equal(cachedStudioService.summaries(studioSummaryUrl).count, 2, "prewarmed studio indexes must preserve maker counts");
cachedStudioService.summaries(studioSummaryUrl);
assert.equal(studioSummaryReadCount, 1, "repeated studio indexes must reuse prewarmed aggregate rows");
cachedStudioService.detailPayload("1", new URL("http://127.0.0.1/api/studios/1?seriesId=all&sort=releaseDesc&limit=48"));
assert.equal(studioMakerDetailReadCount, 2, "first studio selection must reuse its prepared maker detail");
assert.equal(studioWorksReadCount, 2, "first studio selection must reuse its prepared work set");
assert.equal(studioSortCount, 2, "first studio selection must reuse its prepared default order");
assert.equal(studioPagePayloadCount, 4, "first studio selection must reuse its complete prepared page");
const uncachedStudioPageUrl = new URL("http://127.0.0.1/api/studios/1?seriesId=all&sort=releaseDesc&limit=24");
cachedStudioService.detailPayload("1", uncachedStudioPageUrl);
cachedStudioService.detailPayload("1", uncachedStudioPageUrl);
assert.equal(studioPagePayloadCount, 5, "repeated studio detail pages must reuse one complete response payload");
studioUserStateStamp = "studio-user-v2";
cachedStudioService.detailPayload("1", uncachedStudioPageUrl);
assert.equal(studioPagePayloadCount, 6, "studio detail pages must refresh after favorite or progress state changes");
cachedStudioService.summaries(new URL("http://127.0.0.1/api/studios?limit=500&q=studio"));
assert.equal(studioSummaryReadCount, 2, "studio keyword searches must preserve their direct SQL semantics");
studioDataStamp = "studio-v2";
cachedStudioService.summaries(studioSummaryUrl);
assert.equal(studioCatalogReadCount, 2, "studio data changes must refresh catalog metadata");
assert.equal(studioSummaryReadCount, 3, "studio data changes must invalidate aggregate rows");

let rankingDataStamp = "ranking-v1";
let rankingUserStateStamp = "ranking-user-v1";
let rankingListReadCount = 0;
let rankingCoverReadCount = 0;
let rankingSummaryReadCount = 0;
let rankingSummaryCodesReadCount = 0;
let rankingLocalMapReadCount = 0;
let rankingCoverPrewarmCount = 0;
let rankingInfoPrewarmCount = 0;
let rankingPublicWorkCount = 0;
const cachedRankingService = createRankingService({
  clampInteger: (value, fallback, min, max) => Math.max(min, Math.min(max, Number(value ?? fallback))),
  createId: (prefix, value) => `${prefix}:${value}`,
  dbBoolOrNull: (value) => value === null || value === undefined ? null : Boolean(value),
  getCoreDb: () => ({
    prepare(sql) {
      return {
        all(...args) {
          if (sql.includes("COUNT(ci.work_id)")) {
            rankingSummaryReadCount += 1;
            return [{ collection_id: 1, list_label: "TOP250 2025", source_key: "top:y2025", total: 2, updated_at: "v1", page_url: "https://example.com/ranking" }];
          }
          if (sql.includes("SELECT w.code_search AS code_key")) {
            rankingSummaryCodesReadCount += 1;
            return [{ code_key: "abc001" }, { code_key: "def002" }];
          }
          if (sql.includes("FROM images")) {
            rankingCoverReadCount += 1;
            assert.deepEqual(args, [101, 102], "ranking cover batches must bind only listed core work IDs");
            return [
              { work_id: "101", remote_url: "https://example.com/ranking-101.jpg" },
              { work_id: "101", remote_url: "https://example.com/fallback-101.jpg" },
              { work_id: "102", remote_url: "https://example.com/ranking-102.jpg" }
            ];
          }
          if (sql.includes("AND c.source_key = ?")) {
            rankingListReadCount += 1;
            return [
              { list_type: args[0], list_key: args[1], list_label: "TOP250 2025", rank_no: 1, core_work_id: 101, code: "ABC-001", code_key: "abc001", title: "ABC-001", detail_url: "", release_date: "2025-01-01", rating: 4.5, rating_count: 10, page_url: "", fetched_at: "", updated_at: "v1" },
              { list_type: args[0], list_key: args[1], list_label: "TOP250 2025", rank_no: 2, core_work_id: 102, code: "DEF-002", code_key: "def002", title: "DEF-002", detail_url: "", release_date: "2025-01-02", rating: 4.4, rating_count: 9, page_url: "", fetched_at: "", updated_at: "v1" }
            ];
          }
          throw new Error(`unexpected ranking query: ${sql.slice(0, 80)}`);
        }
      };
    }
  }),
  getSearchStamp: () => rankingDataStamp,
  localWorkByCodeKey: () => {
    rankingLocalMapReadCount += 1;
    return new Map();
  },
  localWorkCodeKeys: () => new Set(),
  looseWorkCodeKey: (value) => String(value || "").replace(/[^A-Za-z0-9]/g, "").toLowerCase(),
  maxWorkLimit: 1000,
  normalizeWorkCode: (value) => String(value || ""),
  parseJsonTextArray: () => [],
  prewarmCoreWorkCovers() {
    rankingCoverPrewarmCount += 1;
  },
  prewarmRemoteImagesForWorks() {},
  prewarmWorkInfoDetails() {
    rankingInfoPrewarmCount += 1;
  },
  proxiedRemoteImageUrl: (value) => value ? `/proxy?url=${encodeURIComponent(value)}` : "",
  publicWork: (work) => {
    rankingPublicWorkCount += 1;
    return { ...work };
  },
  storedWorkCodeKey: (value) => String(value || "").replace(/[^A-Za-z0-9]/g, "").toLowerCase(),
  userStateStamp: () => rankingUserStateStamp
});
cachedRankingService.prewarm();
assert.equal(rankingSummaryReadCount, 1, "ranking startup must prepare summary rows");
assert.equal(rankingSummaryCodesReadCount, 1, "ranking startup must prepare summary membership counts");
assert.equal(rankingListReadCount, 1, "ranking startup must prepare the default list rows");
assert.equal(rankingLocalMapReadCount, 1, "ranking startup must prepare its local and missing work source once");
assert.equal(rankingCoverPrewarmCount, 1, "ranking startup must batch first-page cover preparation");
assert.equal(rankingInfoPrewarmCount, 1, "ranking startup must batch first-page metadata preparation");
cachedRankingService.rows("top", "y2025");
cachedRankingService.rows("top", "y2025");
assert.equal(rankingListReadCount, 1, "repeated ranking pages must reuse cached list rows");
assert.equal(rankingCoverReadCount, 1, "repeated ranking pages must reuse batch-hydrated cover URLs");
const cachedRankingPayload = cachedRankingService.worksPayload(new URL("http://127.0.0.1/api/rankings/top?key=y2025&limit=48"));
assert.equal(cachedRankingPayload.works[0]?.remoteCoverUrl, "/proxy?url=https%3A%2F%2Fexample.com%2Franking-101.jpg", "ranking cover batches must preserve the preferred cover URL");
cachedRankingService.worksPayload(new URL("http://127.0.0.1/api/rankings/top?key=y2025&limit=48"));
assert.equal(rankingLocalMapReadCount, 1, "repeated ranking pages must reuse the prepared work source");
assert.equal(rankingPublicWorkCount, 2, "identical ranking pages must reuse the complete prepared response");
rankingUserStateStamp = "ranking-user-v2";
cachedRankingService.worksPayload(new URL("http://127.0.0.1/api/rankings/top?key=y2025&limit=48"));
assert.equal(rankingPublicWorkCount, 4, "favorite and progress changes must invalidate prepared ranking pages");
cachedRankingService.summaries();
cachedRankingService.summaries();
assert.equal(rankingSummaryReadCount, 1, "repeated ranking navigation must reuse summary rows");
assert.equal(rankingSummaryCodesReadCount, 1, "repeated ranking navigation must reuse summary membership counts");
rankingDataStamp = "ranking-v2";
cachedRankingService.rows("top", "y2025");
assert.equal(rankingListReadCount, 2, "ranking updates must invalidate cached list rows");
cachedRankingService.worksPayload(new URL("http://127.0.0.1/api/rankings/top?key=y2025&limit=48"));
assert.equal(rankingPublicWorkCount, 6, "ranking updates must invalidate complete prepared pages");
cachedRankingService.invalidateSearch();
cachedRankingService.rows("top", "y2025");
assert.equal(rankingListReadCount, 3, "explicit ranking invalidation must clear cached list rows");

let historyWorkLookupCount = 0;
class CountingWorkMap extends Map {
  get(key) {
    historyWorkLookupCount += 1;
    return super.get(key);
  }
}
const historyWorkOne = { id: "work-1", videos: [{ id: "video-1" }] };
const historyWorkTwo = { id: "work-2", videos: [{ id: "video-2" }] };
const historyLibrary = {
  filesById: new Map(),
  worksById: new CountingWorkMap([[historyWorkOne.id, historyWorkOne], [historyWorkTwo.id, historyWorkTwo]])
};
const historyUserState = {
  favorites: {},
  progress: {
    "video-1": { workId: "work-1", position: 10, duration: 100, updatedAt: new Date(Date.now() - 10 * 86400000).toISOString() },
    "video-2": { workId: "work-2", position: 20, duration: 100, updatedAt: new Date(Date.now() - 86400000).toISOString() }
  }
};
let historySaveCount = 0;
const playbackProgressService = createPlaybackProgressService({
  getLibrary: () => historyLibrary,
  publicFavoriteFolders: () => [],
  recentWatchedDays: 7,
  userState: historyUserState,
  userStateService: { save: () => { historySaveCount += 1; } }
});
assert.deepEqual(playbackProgressService.historyEntries().map((entry) => entry.work.id), ["work-2", "work-1"], "history must remain ordered by latest progress");
const initialHistoryLookupCount = historyWorkLookupCount;
assert.deepEqual(playbackProgressService.historyEntries({ days: 7 }).map((entry) => entry.work.id), ["work-2"], "history day filters must use the cached ordered index");
assert.equal(historyWorkLookupCount, initialHistoryLookupCount, "repeated history summaries must reuse resolved work entries");
assert.equal(playbackProgressService.getWorkProgress(historyWorkOne)?.videoId, "video-1", "work progress must preserve the latest playable entry");
assert.equal(playbackProgressService.saveVideoProgress("video-3", { workId: "work-1", position: 0, duration: 100 }), null, "opening a player at zero seconds must not create watch history");
assert.equal(historySaveCount, 0, "zero-second player startup must avoid a user-state write");
assert.equal(playbackProgressService.saveVideoProgress("video-1", { workId: "work-1", position: 0, duration: 100 })?.position, 10, "zero-second startup must not overwrite existing progress");
assert.equal(historySaveCount, 0, "preserving existing progress at zero seconds must avoid a user-state write");
historyUserState.progress["video-zero"] = { workId: "work-1", position: 0, duration: 100, updatedAt: new Date().toISOString() };
assert.equal(playbackProgressService.saveVideoProgress("video-zero", { workId: "work-1", position: 0, duration: 100 }), null, "stale zero-second progress must be removed instead of entering history");
assert.equal(historyUserState.progress["video-zero"], undefined, "zero-second cleanup must remove the stale progress row");
assert.equal(historySaveCount, 1, "zero-second cleanup must persist the removal once");
historySaveCount = 0;
playbackProgressService.saveVideoProgress("video-1", { workId: "work-1", position: 30, duration: 100 });
assert.equal(historySaveCount, 1, "progress updates must still persist user state");
assert.equal(playbackProgressService.historyEntries()[0]?.work.id, "work-1", "progress updates must invalidate the cached history order");

let workCoverMetadataStamp = "cover-v1";
let workCoverMetadataPrepareCount = 0;
let workCoverMetadataArgs = [];
const batchedWorkImageService = createWorkImageService({
  getCoreDb: () => ({
    prepare(sql) {
      workCoverMetadataPrepareCount += 1;
      assert(sql.includes("owner_id IN (?, ?)"), "cover metadata must bind one placeholder per visible work");
      return {
        all(...ids) {
          workCoverMetadataArgs = ids;
          return [
            { id: 11, work_id: "1", owner_id: 1, has_image_blob: 1, source: "generated", updated_at: "v1" },
            { id: 12, work_id: "1", owner_id: 1, has_image_blob: 0, remote_url: "https://example.com/older.jpg", source: "remote", updated_at: "v0" },
            { id: 21, work_id: "2", owner_id: 2, has_image_blob: 0, remote_url: "https://example.com/cover.jpg", source: "remote", updated_at: "v1" }
          ];
        }
      };
    }
  }),
  getPersonById: () => null,
  getStamp: () => workCoverMetadataStamp,
  getWorkById: () => null,
  hasCoreDb: () => true,
  proxiedRemoteImageUrl: (value) => `/proxy?url=${encodeURIComponent(value)}`
});
batchedWorkImageService.prewarmCoreWorkCoverMetadata(["1", "2"]);
batchedWorkImageService.prewarmCoreWorkCoverMetadata(["1", "2"]);
assert.equal(workCoverMetadataPrepareCount, 1, "repeated visible pages must reuse batch-hydrated cover metadata");
assert.deepEqual(workCoverMetadataArgs, [1, 2], "cover metadata batches must pass normalized numeric identifiers");
assert.equal(batchedWorkImageService.coreWorkCoverMetadataRow("1")?.id, 11, "cover metadata batches must preserve preferred cover order");
assert.equal(batchedWorkImageService.publicCoreWorkCover("2")?.coverUrl, "/proxy?url=https%3A%2F%2Fexample.com%2Fcover.jpg", "cached remote cover metadata must preserve proxied URLs");
workCoverMetadataStamp = "cover-v2";
batchedWorkImageService.prewarmCoreWorkCoverMetadata(["1", "2"]);
assert.equal(workCoverMetadataPrepareCount, 2, "image table changes must invalidate cached cover metadata");

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

const missingCodeSearchDb = new DatabaseSync(":memory:");
missingCodeSearchDb.exec(`
  CREATE TABLE works (
    id INTEGER PRIMARY KEY,
    code TEXT,
    code_search TEXT,
    title TEXT,
    release_date TEXT,
    duration_minutes INTEGER,
    rating REAL,
    rating_count INTEGER,
    has_magnet INTEGER,
    is_streamable INTEGER,
    has_subtitles INTEGER,
    javdb_tags_json TEXT,
    updated_at TEXT,
    status TEXT
  );
  CREATE TABLE local_works (work_id INTEGER);
  CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE work_people (work_id INTEGER, person_id INTEGER, role TEXT, sort_order INTEGER);
  CREATE TABLE work_external_refs (work_id INTEGER, provider TEXT, url TEXT);
  CREATE TABLE images (id INTEGER PRIMARY KEY, owner_type TEXT, owner_id INTEGER, kind TEXT, remote_url TEXT);
  INSERT INTO works VALUES
    (1, 'M-001', 'm001', 'Local M', '2026-01-01', 60, 4.0, 10, 0, 0, 0, '[]', '2026-01-01', 'ok'),
    (2, 'M-002', 'm002', 'Missing M', '2026-01-02', 90, 4.5, 20, 1, 1, 1, '["tag"]', '2026-01-02', 'ok'),
    (3, 'N-001', 'n001', 'Missing N', '2026-01-03', 70, 3.5, 5, 0, 0, 0, '[]', '2026-01-03', 'ok');
  INSERT INTO local_works VALUES (1);
  INSERT INTO people VALUES (9, 'Actor M');
  INSERT INTO work_people VALUES (2, 9, 'actor', 0);
  INSERT INTO work_external_refs VALUES (2, 'javdb-video', 'https://example.com/m002');
  INSERT INTO images VALUES (20, 'work', 2, 'cover', 'https://example.com/m002.jpg');
`);
let missingCodeCoverStamp = "cover-v1";
let missingCodeCoverIndexReads = 0;
let missingCodeSourceStamp = "source-v1";
let missingCodeRowIndexReads = 0;
const missingCodeSearchService = createMissingCodeSearchService({
  dbBoolOrNull: (value) => value === null || value === undefined ? null : Boolean(value),
  getCoverStamp: () => missingCodeCoverStamp,
  getSourceStamp: () => missingCodeSourceStamp,
  getCoreDb: () => ({
    prepare(sql) {
      if (sql.includes("SELECT image.owner_id")) missingCodeCoverIndexReads += 1;
      if (sql.includes("w.code_search AS code_key")) missingCodeRowIndexReads += 1;
      return missingCodeSearchDb.prepare(sql);
    }
  }),
  normalizeWorkCode: (value) => String(value || ""),
  parseJsonTextArray: (value) => JSON.parse(value || "[]"),
  proxiedRemoteImageUrl: (value) => value ? `/proxy?url=${encodeURIComponent(value)}` : "",
  publicRemoteUrl: (value) => String(value || ""),
  storedWorkCodeKey: (value) => String(value || "").replace(/[^A-Za-z0-9]/g, "").toLowerCase()
});
const lightweightMissingCodeWorks = missingCodeSearchService.search("M");
assert.deepEqual(lightweightMissingCodeWorks.map((work) => work.id), ["2"], "missing-code search must exclude matching local works without truncating the prefix source");
assert.equal(lightweightMissingCodeWorks[0].missingCodeSearchPending, true, "missing-code search must leave non-page details deferred");
assert.equal(lightweightMissingCodeWorks[0].searchHasCover, true, "deferred missing-code rows must retain lightweight cover presence for facets and dedupe");
missingCodeSearchService.search("M");
assert.equal(missingCodeCoverIndexReads, 1, "repeated broad-code searches must reuse cover membership from memory");
missingCodeSearchService.search("M0");
assert.equal(missingCodeRowIndexReads, 1, "related code prefixes must share one sorted missing-work memory bucket");
missingCodeCoverStamp = "cover-v2";
missingCodeSearchService.search("M");
assert.equal(missingCodeCoverIndexReads, 2, "cover-table changes must invalidate broad-search cover membership");
assert.equal(missingCodeRowIndexReads, 2, "cover-table changes must refresh lightweight cover flags in the missing-work index");
missingCodeSourceStamp = "source-v2";
missingCodeSearchService.search("M");
assert.equal(missingCodeRowIndexReads, 3, "core search-data changes must invalidate the missing-work index");
missingCodeSearchService.hydrate(lightweightMissingCodeWorks);
assert.equal(lightweightMissingCodeWorks[0].personName, "Actor M", "visible missing-code results must hydrate actor details in one page batch");
assert.equal(lightweightMissingCodeWorks[0].infoSummary.javdbTags[0], "tag", "visible missing-code results must retain deferred metadata");
assert(lightweightMissingCodeWorks[0].remoteCoverUrl.includes("m002.jpg"), "visible missing-code results must retain deferred cover URLs");
assert.equal(lightweightMissingCodeWorks[0].missingCodeSearchPending, undefined, "hydrated missing-code results must not stay pending");
missingCodeSearchDb.close();

let actorMovieDataStamp = "actor-v1";
let enrichmentCount = 0;
let localPrefixReadCount = 0;
let personMergePrewarmCount = 0;
let searchFavoriteFacetReadCount = 0;
let searchUserStateRevision = 1;
let searchFavoriteState = false;
let searchProgressState = null;
let searchProgressReadCount = 0;
let workListPublicCount = 0;
let workInfoReadCount = 0;
let workInfoFacetReadCount = 0;
let searchPersonOptions = null;
let preparedWorkCoverIds = [];
let preparedWorkInfoIds = [];
let preparedWorkVideoIds = [];
const searchPerson = {
  id: "person-1",
  name: "Exact Person",
  workCount: 1
};
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
  infoCount: 1
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
  favoriteStateService: {
    isFavoriteWork() {
      searchFavoriteFacetReadCount += 1;
      return searchFavoriteState;
    },
    publicFavoriteForWork: () => searchFavoriteState ? { folderId: "folder-1", folderName: "测试收藏" } : null
  },
  isVrWork: (work) => work.id === queryWork.id,
  library: { scannedAt: "library-v1", worksById: new Map([[queryWork.id, queryWork]]) },
  localSearchWorkByCodeKey: () => new Map([["abc001", queryWork]]),
  localWorksByCodePrefix: () => {
    localPrefixReadCount += 1;
    return [queryWork];
  },
  maxWorkLimit: 1000,
  peoplePayloadStamp: () => actorMovieDataStamp,
  peopleScopeService: { normalize: () => "main", workMatches: () => true },
  playbackProgressService: {
    getWorkProgress() {
      searchProgressReadCount += 1;
      return searchProgressState;
    }
  },
  prewarmCoreWorkCovers(works) {
    preparedWorkCoverIds.push(...works.map((work) => work.id));
  },
  prewarmLocalWorkCodeKeys() {},
  prewarmPersonMerge() {
    personMergePrewarmCount += 1;
  },
  prewarmRemoteImagesForWorks() {},
  prewarmVideoProbesForWorks(works) {
    preparedWorkVideoIds.push(...works.map((work) => work.id));
  },
  prewarmWorkInfoDetails(works) {
    preparedWorkInfoIds.push(...works.map((work) => work.id));
  },
  publicPerson: (person, options = {}) => {
    searchPersonOptions = options;
    return person;
  },
  publicWork: (work) => {
    workListPublicCount += 1;
    return { id: work.id, revision: searchUserStateRevision };
  },
  publicWorkAvailability: () => ({ hasMagnet: false }),
  rankingMissingSearchWorks: () => [],
  scheduleBackground: () => {},
  searchPeople: (query) => query === searchPerson.name
    ? { exact: [searchPerson], matchedPersonIds: [searchPerson.id], people: [searchPerson] }
    : { exact: [], matchedPersonIds: [], people: [] },
  storedWorkCodeKey: (value) => String(value || "").replace(/[^A-Za-z0-9]/g, "").toLowerCase(),
  userStateStamp: () => searchUserStateRevision,
  workHasCoreCover: () => false,
  workHasLocalMarker: (_work, marker) => marker === "A",
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
assert.equal(personMergePrewarmCount, 1, "FanHao startup must prepare person merge maps before search traffic");
assert.deepEqual(preparedWorkCoverIds, [queryWork.id], "FanHao startup must prepare first-page VR cover metadata");
assert.deepEqual(preparedWorkInfoIds, [queryWork.id], "FanHao startup must prepare first-page VR detail metadata");
assert.deepEqual(preparedWorkVideoIds, [queryWork.id], "FanHao startup must queue first-page VR playback probes");
assert.equal(workInfoReadCount, 0, "FanHao startup prewarm must not hydrate full work-info facets before the server listens");
assert(workInfoFacetReadCount > 0 && workInfoFacetReadCount <= 8, "FanHao startup prewarm must use only bounded compact work-info lookups");
assert.equal(workListPublicCount, 1, "FanHao startup must prepare each visible work payload once across common list variants");
preparedWorkCoverIds = [];
preparedWorkInfoIds = [];
preparedWorkVideoIds = [];
const lightweightFacetReadsBeforePersonPage = workInfoFacetReadCount;
const lightweightPersonFacets = workQueryService.lightweightFacets([queryWork]);
const lightweightPersonPage = workQueryService.listFromWorksPayload(
  [queryWork],
  new URL("http://127.0.0.1/api/people/person-1?limit=24&sort=releaseDesc"),
  { filter: "all", facets: lightweightPersonFacets },
  { lightweightInfo: true }
);
assert.equal(lightweightPersonPage.works[0].id, queryWork.id, "lightweight person pages must preserve visible work payloads");
assert.equal(workInfoFacetReadCount, lightweightFacetReadsBeforePersonPage, "lightweight person facets must not read detail-only work metadata");
assert.deepEqual(preparedWorkCoverIds, [], "lightweight person pages must not hydrate redundant SQL covers for local works");
assert.deepEqual(preparedWorkInfoIds, [], "lightweight person pages must not hydrate detail-only info rows");
assert.deepEqual(preparedWorkVideoIds, [], "lightweight person pages must leave playback probes to explicit hover, focus, or pointer intent");
const lightweightMissingWork = { ...queryWork, id: "missing-work-1", missingLocal: true };
const lightweightMissingPage = workQueryService.listFromWorksPayload(
  [lightweightMissingWork],
  new URL("http://127.0.0.1/api/people/person-1?limit=24&sort=releaseDesc"),
  { filter: "all" },
  { lightweightInfo: true }
);
assert.equal(lightweightMissingPage.works[0].id, lightweightMissingWork.id, "lightweight person pages must preserve missing-local works");
assert.deepEqual(preparedWorkCoverIds, [lightweightMissingWork.id], "lightweight person pages must batch-hydrate cached SQL covers for missing-local works");
assert.deepEqual(preparedWorkInfoIds, [], "missing-local cover hydration must not pull detail-only info rows");
assert.deepEqual(preparedWorkVideoIds, [], "missing-local cover hydration must not start playback probes");
const workListPublicCountAfterLightweightPage = workListPublicCount;
const cachedWorkListFirst = workQueryService.listPayload(workListUrl);
const listFavoriteReadsAfterFirstPage = searchFavoriteFacetReadCount;
const cachedWorkListSecond = workQueryService.listPayload(workListUrl);
assert.equal(cachedWorkListSecond, cachedWorkListFirst, "identical work-list requests must reuse the complete response object");
assert.equal(workListPublicCount, workListPublicCountAfterLightweightPage, "new page sizes must reuse already prepared full and lightweight work payloads");
assert.equal(searchFavoriteFacetReadCount, listFavoriteReadsAfterFirstPage, "repeated work lists must reuse unchanged dynamic facets");
assert.equal(enrichmentCount, 1, "repeated FanHao work-list requests must reuse the prewarmed full-library enrichment");
const combinedWorkListUrl = new URL("http://127.0.0.1/api/works?filter=progress%2Cinfo&limit=24&sort=updated");
const combinedWorkListBeforeProgress = workQueryService.listPayload(combinedWorkListUrl);
assert.equal(combinedWorkListBeforeProgress.total, 0, "combined work-list filters must apply every chip before pagination");
const workSearchUrl = new URL("http://127.0.0.1/api/search?q=AB&limit=24&sort=releaseDesc");
const cachedSearchFirst = workQueryService.searchPayload(workSearchUrl);
const combinedWorkSearchUrl = new URL("http://127.0.0.1/api/search?q=AB&filter=progress%2Cinfo&limit=24&sort=releaseDesc");
const combinedWorkSearchBeforeProgress = workQueryService.searchPayload(combinedWorkSearchUrl);
assert.equal(combinedWorkSearchBeforeProgress.total, 0, "combined work-search filters must apply every chip before pagination");
const favoriteFacetReadsAfterSearch = searchFavoriteFacetReadCount;
const cachedSearchSecond = workQueryService.searchPayload(workSearchUrl);
assert.equal(cachedSearchSecond, cachedSearchFirst, "identical search requests must reuse the complete response object");
assert.equal(localPrefixReadCount, 1, "repeated search paging must reuse the matched work source");
assert.equal(searchFavoriteFacetReadCount, favoriteFacetReadsAfterSearch, "repeated search paging must reuse unchanged user facets");
const exactPersonSearch = workQueryService.searchPayload(new URL("http://127.0.0.1/api/search?q=Exact%20Person&limit=24&sort=releaseDesc"));
assert.equal(exactPersonSearch.people[0]?.id, searchPerson.id, "exact person searches must retain compact person results");
assert.deepEqual(searchPersonOptions, { skipFallbackAvatar: true }, "search person chips must not scan works for unused fallback avatars");
const localMarkerSearch = workQueryService.searchPayload(new URL("http://127.0.0.1/api/search?q=%5BA%5D&limit=24&sort=releaseDesc"));
assert.equal(localMarkerSearch.total, 1, "exact [A] searches must use the local marker category instead of text or person matching");
const singleLetterCodeSearchUrl = new URL("http://127.0.0.1/api/search?q=A&limit=24&sort=releaseDesc");
const prefixReadsBeforeSingleLetterSearch = localPrefixReadCount;
const singleLetterCodeSearch = workQueryService.searchPayload(singleLetterCodeSearchUrl);
assert.equal(localPrefixReadCount, prefixReadsBeforeSingleLetterSearch + 1, "single-letter Latin searches must use the indexed code-prefix path");
assert.equal(singleLetterCodeSearch.total, 1, "single-letter code-prefix searches must preserve matching local works");
searchUserStateRevision += 1;
searchFavoriteState = true;
searchProgressState = { percent: 42 };
const workListPublicCountBeforeStateChange = workListPublicCount;
const refreshedWorkList = workQueryService.listPayload(workListUrl);
assert.notEqual(refreshedWorkList, cachedWorkListFirst, "favorite and progress changes must invalidate complete work-list responses");
assert.equal(workListPublicCount, workListPublicCountBeforeStateChange, "user-state changes must reuse prepared static work payloads");
assert.equal(refreshedWorkList.works[0].favorite, true, "reused work payloads must refresh favorite state");
assert.equal(refreshedWorkList.works[0].favoriteFolderId, "folder-1", "reused work payloads must refresh favorite folders");
assert.equal(refreshedWorkList.works[0].progress?.percent, 42, "reused work payloads must refresh playback progress");
const refreshedSearch = workQueryService.searchPayload(workSearchUrl);
assert.notEqual(refreshedSearch, cachedSearchFirst, "favorite and progress changes must invalidate complete search responses");
assert(searchFavoriteFacetReadCount > favoriteFacetReadsAfterSearch, "favorite and progress changes must refresh search facets");
const progressPageFirst = workQueryService.listPayload(new URL("http://127.0.0.1/api/works?filter=progress&limit=24&sort=updated"));
const progressReadsAfterFirstPage = searchProgressReadCount;
const progressPageSecond = workQueryService.listPayload(new URL("http://127.0.0.1/api/works?filter=progress&limit=48&sort=updated"));
assert.equal(progressPageFirst.total, 1, "progress filters must reflect the current playback state");
assert.equal(progressPageSecond.works[0].progress?.percent, 42, "different progress page sizes must retain current playback state");
assert.equal(searchProgressReadCount, progressReadsAfterFirstPage, "different progress page sizes must reuse the current user-state source and facets");
const combinedWorkListAfterProgress = workQueryService.listPayload(combinedWorkListUrl);
assert.equal(combinedWorkListAfterProgress.total, 1, "combined work-list caches must refresh when playback state changes");
assert.equal(combinedWorkListAfterProgress.facets.all, 1, "combined work-list facets must describe the filtered intersection");
const combinedWorkSearchAfterProgress = workQueryService.searchPayload(combinedWorkSearchUrl);
assert.equal(combinedWorkSearchAfterProgress.total, 1, "combined work-search caches must refresh when playback state changes");
const workListPublicCountBeforeStaticChange = workListPublicCount;
actorMovieDataStamp = "actor-v2";
workQueryService.listPayload(workListUrl);
assert.equal(enrichmentCount, 2, "actor-movie updates must invalidate the FanHao work-list enrichment cache");
assert.equal(workListPublicCount, workListPublicCountBeforeStaticChange + 1, "static work changes must still rebuild prepared work payloads");
const prefixReadsBeforeInvalidatedSearch = localPrefixReadCount;
workQueryService.searchPayload(workSearchUrl);
assert.equal(localPrefixReadCount, prefixReadsBeforeInvalidatedSearch + 1, "search data changes must invalidate matched work sources");

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

let coreBlobLoadCount = 0;
const workerBackedMediaResponseService = createMediaResponseService({
  coreImageRow: () => null,
  corePersonAvatarRow: () => null,
  getCoreDb: () => null,
  isAllowedRemoteImageUrl: () => true,
  maxRemoteImageBytes: 1024,
  mediaBlobStore: {
    actorAvatar: async () => null,
    cachedRemoteUrls: async () => [],
    coreImage: async () => {
      coreBlobLoadCount += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return { image_blob: new Uint8Array([9, 8, 7]), mime: "image/jpeg" };
    },
    remoteImage: async () => null,
    upsertRemote: async () => true,
    workCover: async () => null
  },
  mimeTypes: { ".jpg": "image/jpeg" },
  normalizeExt: (value) => path.extname(value),
  notFound: (res) => {
    res.writeHead(404);
    res.end();
  },
  proxiedRemoteImageUrl: (value) => value,
  publicRemoteUrl: (value) => value,
  safeStat: () => null,
  sendText: (res, statusCode, body) => {
    res.writeHead(statusCode);
    res.end(body);
  },
  workCoverRow: () => null
});
const firstCoreBlobResponse = testImageResponse();
await workerBackedMediaResponseService.serveCoreImage(firstCoreBlobResponse, "1", { version: "v1" });
const repeatedCoreBlobResponse = testImageResponse();
await workerBackedMediaResponseService.serveCoreImage(repeatedCoreBlobResponse, "1", { version: "v1" });
assert.equal(coreBlobLoadCount, 1, "repeated core-image requests must reuse the in-memory blob cache");
assert.deepEqual(firstCoreBlobResponse.body, Buffer.from([9, 8, 7]), "worker-backed core images must preserve bytes");
assert.deepEqual(repeatedCoreBlobResponse.body, Buffer.from([9, 8, 7]), "in-memory core images must preserve bytes");

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

const persistentProbeDb = new DatabaseSync(":memory:");
let persistentProbeCache = createVideoProbeCacheService({
  getDb: () => persistentProbeDb,
  now: () => "2026-07-17T00:00:00.000Z"
});
const restartVideoFile = {
  id: "restart-video",
  path: "G:/restart/video.mp4",
  ext: ".mp4",
  type: "video",
  size: 4096,
  modifiedAt: "2026-07-17T00:00:00.000Z"
};
const restartVideoStat = { size: 4096, mtimeMs: 12345 };
let persistentProbeExecCount = 0;
let persistentProbeStatCount = 0;
const persistentProbeOutput = JSON.stringify({
  format: { duration: "88.5" },
  streams: [
    { codec_type: "video", codec_name: "h264", width: 1280, height: 720 },
    { codec_type: "audio", codec_name: "aac" }
  ]
});
function persistentVideoProbeRuntime(stat = restartVideoStat) {
  return createVideoProbeService({
    directVideoExts: new Set([".mp4", ".m4v", ".webm"]),
    ffprobePath: "ffprobe",
    hasNvenc: false,
    persistentCache: persistentProbeCache,
    safeStat: () => {
      persistentProbeStatCount += 1;
      return stat;
    },
    spawnSyncFn: () => {
      persistentProbeExecCount += 1;
      return { status: 0, stdout: persistentProbeOutput };
    }
  });
}
const firstPersistentPlayInfo = persistentVideoProbeRuntime().playInfoForFile(restartVideoFile);
assert.equal(firstPersistentPlayInfo.duration, 88.5, "the first playback probe must retain accurate media metadata");
assert.equal(persistentProbeExecCount, 1, "the first unseen video must run ffprobe once");
assert.equal(persistentProbeStatCount, 1, "the first unseen video must validate its source file once");
persistentProbeCache = createVideoProbeCacheService({
  getDb: () => persistentProbeDb,
  now: () => "2026-07-17T00:00:01.000Z"
});
const restartedPersistentPlayInfo = persistentVideoProbeRuntime().playInfoForFile(restartVideoFile);
assert.equal(restartedPersistentPlayInfo.videoCodec, "h264", "a restarted runtime must restore persisted codec metadata");
assert.equal(persistentProbeExecCount, 1, "a restarted runtime must not probe an unchanged video again");
assert.equal(persistentProbeStatCount, 1, "a restarted runtime must validate the library signature without touching the network file");
const changedRestartVideoFile = { ...restartVideoFile, modifiedAt: "2026-07-17T00:00:01.000Z" };
persistentVideoProbeRuntime({ ...restartVideoStat, mtimeMs: restartVideoStat.mtimeMs + 1 }).playInfoForFile(changedRestartVideoFile);
assert.equal(persistentProbeExecCount, 2, "changing the source file signature must invalidate its persisted probe");
persistentProbeDb.close();

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

let playbackPrefetchApiCalls = 0;
let scheduledPlaybackPrefetch = null;
const playbackPrefetch = createPlaybackPrefetch({
  api: async (requestPath) => {
    playbackPrefetchApiCalls += 1;
    return { requestPath };
  },
  clearTimer: () => {
    scheduledPlaybackPrefetch = null;
  },
  setTimer: (callback) => {
    scheduledPlaybackPrefetch = callback;
    return 1;
  }
});
const delegatedPlaybackHandlers = new Map();
const delegatedPlaybackIntent = {
  dataset: { playbackWorkId: "delegated work" },
  closest: (selector) => (selector === "[data-playback-work-id]" ? delegatedPlaybackIntent : null)
};
const delegatedPlaybackGrid = {
  addEventListener: (name, handler) => delegatedPlaybackHandlers.set(name, handler),
  contains: (target) => target === delegatedPlaybackIntent,
  removeEventListener: (name, handler) => {
    if (delegatedPlaybackHandlers.get(name) === handler) delegatedPlaybackHandlers.delete(name);
  }
};
const unbindPlaybackPrefetch = playbackPrefetch.bindContainer(delegatedPlaybackGrid);
delegatedPlaybackHandlers.get("pointerover")({ target: delegatedPlaybackIntent, relatedTarget: null });
assert.equal(typeof scheduledPlaybackPrefetch, "function", "delegated card hover must schedule playback preparation");
delegatedPlaybackHandlers.get("pointerout")({ target: delegatedPlaybackIntent, relatedTarget: null });
assert.equal(scheduledPlaybackPrefetch, null, "delegated card exit must cancel delayed playback preparation");
delegatedPlaybackHandlers.get("focusin")({ target: delegatedPlaybackIntent });
assert.equal(playbackPrefetchApiCalls, 1, "delegated keyboard focus must prepare playback immediately");
unbindPlaybackPrefetch();
assert.equal(delegatedPlaybackHandlers.size, 0, "delegated playback listeners must expose lifecycle cleanup");
playbackPrefetchApiCalls = 0;
playbackPrefetch.schedule("work one");
assert.equal(playbackPrefetchApiCalls, 0, "pointer hover must avoid probing transient card flyovers");
scheduledPlaybackPrefetch();
await playbackPrefetch.prepare("work one");
assert.equal(playbackPrefetchApiCalls, 1, "hover and activation must reuse one playback-prewarm request");
playbackPrefetch.schedule("work two");
playbackPrefetch.cancel("work two");
assert.equal(scheduledPlaybackPrefetch, null, "leaving a work card must cancel its delayed playback preparation");

const preferredPlaybackVideo = { id: "video-b", path: "G:/work/video-b.mp4", playable: true };
const indexedLibraryVideo = { id: "library-video", path: "G:/work/library-video.mp4", type: "video" };
const indexedGalleryVideo = { id: "gallery-video", path: "V:/gallery/gallery-video.mp4", type: "video" };
let preparedPlayback = null;
let detailMaterializations = 0;
let galleryPlayInfoLookups = 0;
let workDetailStamp = "detail-1";
const workDetailService = createWorkDetailService({
  galleryMediaService: {
    byId: (videoId) => {
      galleryPlayInfoLookups += 1;
      return videoId === "gallery-video" ? { id: videoId } : null;
    },
    videoFile: () => indexedGalleryVideo
  },
  library: {
    filesById: new Map([[indexedLibraryVideo.id, indexedLibraryVideo]]),
    scannedAt: "scan-1",
    peopleById: new Map()
  },
  peoplePayloadStamp: () => "people-1",
  playbackProgressService: { getWorkProgress: () => ({ videoId: "video-b" }) },
  prewarmCoreWorkCovers: () => {},
  prewarmRemoteImagesForWorks: () => {},
  publicWork: (work) => {
    detailMaterializations += 1;
    return { id: work.id, videos: work.videos };
  },
  resolveLibraryWorkByPublicId: (workId) => workId === "work-1"
    ? {
        id: workId,
        videos: [
          { id: "video-a", path: "G:/work/video-a.mp4", playable: true },
          preferredPlaybackVideo
        ]
      }
    : null,
  userStateStamp: () => "user-1",
  videoProbeService: {
    async playInfoForFileAsync(file, videoId, options) {
      return { file, streamBase: options.streamBase || "/media/video", videoId };
    },
    prewarm(files, options) {
      preparedPlayback = { files, options };
      return { queued: 1, active: 1, pending: 0 };
    }
  },
  workQueryStamp: () => workDetailStamp
});
const playbackPrewarmPayload = workDetailService.playbackPrewarmPayload("work-1");
assert.equal(playbackPrewarmPayload.videoId, "video-b", "playback preparation must prefer the user's latest video progress");
assert.equal(playbackPrewarmPayload.detailReady, true, "playback preparation must report complete detail hydration");
assert.deepEqual(preparedPlayback.files, [preferredPlaybackVideo], "playback preparation must enqueue only the selected video");
assert.equal(preparedPlayback.options.replaceQueued, true, "explicit playback intent must replace lower-priority queued probes");
const prefetchedWorkDetail = workDetailService.detailPayload("work-1");
assert.equal(prefetchedWorkDetail.work.id, "work-1", "the player detail request must reuse the prefetched work");
assert.equal(detailMaterializations, 1, "playback intent and the following player request must share one detail materialization");
workDetailStamp = "detail-2";
workDetailService.detailPayload("work-1");
assert.equal(detailMaterializations, 2, "work detail cache entries must invalidate when their source stamp changes");
assert.equal(workDetailService.playbackPrewarmPayload("missing-work"), null, "playback preparation must preserve missing-work semantics");
const indexedLibraryPlayInfo = await workDetailService.playInfoPayload("library-video");
assert.equal(indexedLibraryPlayInfo.file, indexedLibraryVideo, "FanHao play-info must resolve directly from the library file index");
assert.equal(galleryPlayInfoLookups, 0, "FanHao play-info must not hydrate the unrelated gallery catalog");
const indexedGalleryPlayInfo = await workDetailService.playInfoPayload("gallery-video", { source: "gallery" });
assert.equal(indexedGalleryPlayInfo.file, indexedGalleryVideo, "explicit gallery play-info must preserve gallery media resolution");
assert.equal(indexedGalleryPlayInfo.streamBase, "/media/gallery-video", "gallery play-info must retain its media stream boundary");
assert.equal(galleryPlayInfoLookups, 1, "explicit gallery play-info must perform one gallery lookup");

let stampNow = 1000;
let synchronousStampReads = 0;
let backgroundStampReads = 0;
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
    return {
      get() {
        synchronousStampReads += 1;
        return { row_count: 1, max_rowid: 1, max_updated_at: "v1" };
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
assert.equal(
  tableStampValue("work_info", "0:0", { data_version: 1, row_count: 1, max_rowid: 1, max_updated_at: "v1" }),
  tableStampValue("work_info", "0:0", { data_version: 2, row_count: 1, max_rowid: 1, max_updated_at: "v1" }),
  "unrelated SQLite writes must not invalidate a table-specific cache"
);
resolveBackgroundStamp({ row_count: 2, max_rowid: 2, max_updated_at: "v2" });
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
