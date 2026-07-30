import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
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
import { adminUrl } from "../public/js/admin-navigation.js";
import { publicPersonListItem } from "../src/modules/fanhao/server/people/person-list-presenter.js";
import { createPersonDetailService } from "../src/modules/fanhao/server/people/person-detail-service.js";
import { removeLocalWorksFromLibrary } from "../src/modules/fanhao/server/people/person-library-service.js";
import { normalizePersonWorkYear, personWorkYearOptions, worksForPersonYear } from "../src/modules/fanhao/server/people/person-work-year.js";
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
import { createWorkLocalMutationService } from "../src/modules/fanhao/server/works/work-local-mutation-service.js";
import { classifyWorkCategory, isAnimeWork, isFc2Work, normalizeWorkCategory, summarizeWorkCategories, WORK_CATEGORY_OPTIONS } from "../src/modules/fanhao/server/works/work-category.js";
import { createWorkFilterService } from "../src/modules/fanhao/server/works/work-filter-service.js";
import { createWorkSearchIndexService } from "../src/modules/fanhao/server/works/work-search-index-service.js";
import { comparePopularityMetadata, compareRatingCountMetadata } from "../src/modules/fanhao/server/works/work-sort-metadata.js";
import { createMediaResponseService } from "../src/platform/server/media-response-service.js";
import { sendJson } from "../src/platform/server/responses.js";
import { createVideoProbeCacheService } from "../src/platform/server/video-probe-cache-service.js";
import { createVideoProbeService, DEFAULT_VIDEO_PROBE_WAIT_MS } from "../src/platform/server/video-probe-service.js";
import { createCoreDbService } from "../src/modules/fanhao/server/library/core-db-service.js";
import { createCoreLibrarySyncService } from "../src/modules/fanhao/server/library/core-library-sync-service.js";
import { tableStampValue } from "../src/modules/fanhao/server/library/table-stamp-query.js";
import { fetchPreparedImage, portraitUrlForPerson } from "../android-client/www/js/image.js";
import { createWorkListState } from "../android-client/www/js/work-filtering.js";
import { filterPeopleForIndex, isBrowsableAuthor, normalizePeopleFilter } from "../android-client/www/modules/fanhao/people-views.js";
import { buildFanhaoSearchSuggestions, localAuthorSearchSuggestions } from "../android-client/www/modules/fanhao/search-page.js";
import { createWorkCoverLoader } from "../android-client/www/modules/fanhao/features/works/cover-loader.js";
import { compactWorkCode, displayWorkTitle, workGridBadge, workGridMeta, workGridPerson, workGridRankBadge } from "../android-client/www/modules/fanhao/features/works/card-presentation.js";
import { createWorkPageDataService } from "../android-client/www/modules/fanhao/features/works/page-data-service.js";
import { createWorkDetailDataService } from "../android-client/www/modules/fanhao/features/works/detail-data-service.js";
import { workCollectionPath } from "../android-client/www/modules/fanhao/features/works/collection-request.js";
import { personDetailPath } from "../android-client/www/modules/fanhao/features/people/detail-request.js";
import { createProgressiveWorkListRenderer } from "../android-client/www/modules/fanhao/features/works/progressive-list-renderer.js";
import { selectStudios, STUDIO_SORT_OPTIONS } from "../android-client/www/modules/fanhao/features/studios/index-model.js";
import { CATEGORY_OPTIONS, categoryWorksPath, normalizeCategory } from "../android-client/www/modules/fanhao/features/categories/category-views.js";
import { codePrefixDetailPath, normalizeCodePrefix } from "../android-client/www/modules/fanhao/features/code-prefixes/prefix-views.js";

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
const adminStyles = read("public/modules/system/admin.css");
const adminHtmlSource = read("public/admin.html");
const adminPageSource = read("public/admin.js");
const webApp = read("public/app.js");
const codePrefixPageSource = read("public/modules/fanhao/code-prefix-page.js");
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
const workPageAppenderSource = read("public/modules/fanhao/features/works/work-page-appender.js");
const workDetailServiceSource = read("src/modules/fanhao/server/works/work-detail-service.js");
const missingCodeSearchServiceSource = read("src/modules/fanhao/server/works/missing-code-search-service.js");
const workRoutesApiSource = read("src/modules/fanhao/server/works/routes-api.js");
const workPresenterServiceSource = read("src/modules/fanhao/server/works/presenter-service.js");
const playbackProgressServiceSource = read("src/modules/fanhao/server/playback/playback-progress-service.js");
const personDetailServiceSource = read("src/modules/fanhao/server/people/person-detail-service.js");
const personMergeServiceSource = read("src/modules/fanhao/server/people/person-merge-service.js");
const personLibraryServiceSource = read("src/modules/fanhao/server/people/person-library-service.js");
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
assert(indexHtml.includes('html.app-module-loading body') && indexHtml.includes('classList.add("app-module-loading")'), "standalone routes must stay hidden until their module shell is ready");
assert(indexHtml.includes('classList.remove("app-module-loading")'), "standalone boot failures must always release the initial visibility guard");
assert(indexHtml.includes('document.documentElement.classList.add("app-module-loading")') && !indexHtml.includes('if (!shortVideoEntry) document.documentElement.classList.add("app-module-loading")'), "all shared-shell routes must use the initial visibility guard");
assert(indexHtml.includes('id="currentPath">本地资料库</div>') && indexHtml.includes('id="currentTitle">资料库</h2>'), "the static shell must not expose a stale drive letter before boot");
assert(adminStyles.includes('.admin-modal[aria-hidden="true"]') && adminStyles.includes('.detail-drawer[aria-hidden="true"]'), "closed overlays must be removed from layout instead of remaining faintly visible");
assert(indexHtml.includes('id="topAdminLink" href="/admin#overview">设置与运维</a>'), "the library shell must expose one combined settings and operations entry");
assert(!indexHtml.includes('id="topRescanButton"') && !indexHtml.includes('id="adminModal"') && !indexHtml.includes("脚本与维护后台"), "the retired duplicate admin modal must not remain in the shared shell");
assert(adminUrl("overview") === "/admin#overview", "admin navigation must support the overview section");
assert(adminUrl("scripts", { scriptId: "novel-library-rescan" }) === "/admin?script=novel-library-rescan#scripts", "admin navigation must deep-link to a selected script");
assert(adminPageSource.includes('params.get("script")') && adminPageSource.includes("applyPendingScriptDefaults()"), "the admin page must restore script deep links and their pending defaults");
assert(adminHtmlSource.includes('class="app-module-loading"') && adminHtmlSource.includes('html.app-module-loading body'), "the admin page must hide its incomplete shell during startup");
assert(adminHtmlSource.includes('await import("/admin.js?v=20260727-initial-route-reveal-01")') && adminHtmlSource.includes('classList.remove("app-module-loading")'), "the admin page must release its visibility guard after startup");
assert(adminPageSource.includes("await init().catch"), "the admin page must finish its initial data load before becoming visible");
assert(fanhaoEntry.includes('import("./app.js'), "FanHao entry must boot the Web runtime explicitly");
assert(indexHtml.includes('/fanhao-app.js?v=20260727-admin-merge-01'), "FanHao shell changes must refresh the browser entry");
assert(indexHtml.includes('/modules/fanhao/work-cards.css?v=20260717-fanhao-viewport-render-01'), "viewport rendering styles must use a fresh browser URL");
assert(fanhaoEntry.includes('app.js?v=20260727-admin-merge-01'), "FanHao shell changes must refresh the app module");
assert(webApp.includes('await bootApp().catch') && webApp.includes('classList.remove("app-module-loading")'), "FanHao must reveal the page only after its initial route is rendered");
assert(webApp.includes('index.js?v=20260726-work-sort-01'), "work sorting changes must refresh the FanHao module barrel");
assert(!standaloneEntry.includes("app.js"), "standalone entry must not boot the FanHao runtime");
assert(!standaloneHost.includes("modules/fanhao/"), "standalone host must not load FanHao feature modules");
assert(standaloneHost.includes("loadCurrentModule(initialRoute.view)"), "standalone host must select one module from the current route");
const standaloneInitialRouteIndex = standaloneHost.indexOf("await host.applyRoute(initialRoute)");
const standaloneRevealIndex = standaloneHost.indexOf('classList.remove("app-module-loading")');
assert(standaloneInitialRouteIndex >= 0 && standaloneRevealIndex > standaloneInitialRouteIndex, "standalone routes must remain hidden until their complete initial route is ready");
assert(!standaloneHost.includes("window.requestAnimationFrame(resolve)"), "standalone startup must not reveal an intermediate loading DOM after one animation frame");
assert(standaloneHost.includes("routeApplication.catch(() => {}).then(() => applyRouteNow(next))"), "standalone history restores must be serialized");
for (const modulePath of ["content-index/gallery-page", "content-index/gallery-renderer", "music/music-page", "novels/novel-page", "tools/tools-page"]) {
  assert(standaloneHost.includes(`modules/${modulePath}.js`), `standalone host must route ${modulePath}`);
  assert(!webApp.includes(`modules/${modulePath}`), `FanHao runtime must not load ${modulePath}`);
}
assert(!webApp.includes("loadStandaloneFactories"), "FanHao runtime must not own standalone factory loading");
assert(!webApp.includes("standaloneFactories"), "FanHao runtime must not retain standalone factories");
assert(webApp.includes('adminUrl("scripts"') && webApp.includes('adminUrl("settings")'), "FanHao admin actions must route into the combined admin page");
assert(!webApp.includes("createLazyAdminModal") && !webApp.includes("admin-modal.js"), "FanHao startup must not load the retired duplicate admin modal");
assert(standaloneHost.includes('adminUrl("scripts"') && !standaloneHost.includes("createStandaloneAdmin") && !standaloneHost.includes("admin-modal.js"), "standalone modules must route admin actions into the combined admin page");
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
assert(workDetailServiceSource.includes("resolveVideoFileByPublicId ? resolveVideoFileByPublicId(videoId) : library.filesById.get(videoId)"), "FanHao play-info must validate or relocate indexed media before touching the gallery catalog");
assert(workRoutesApiSource.includes('source: url.searchParams.get("source") || "fanhao"') && workRoutesApiSource.includes("视频文件不存在或已移动"), "play-info routing must retain its media boundary and explain missing local files");
assert(playerPageSource.includes('mediaId ? "?source=gallery" : ""'), "the standalone gallery player must explicitly select gallery play-info lookup");
assert(playerHtmlSource.includes('class="app-module-loading"') && playerHtmlSource.includes('html.app-module-loading body'), "the standalone player must hide its incomplete shell during startup");
assert(playerHtmlSource.includes('await import("/js/player-page.js?v=20260727-initial-route-reveal-01")') && playerHtmlSource.includes('classList.remove("app-module-loading")'), "the standalone player must release its visibility guard after startup");
assert(playerPageSource.lastIndexOf("await load();") > playerPageSource.indexOf("async function load()"), "the standalone player must await its initial payload after all module declarations are initialized");
assert(playerPageSource.includes("setVideoSourceAt(resumePosition, { autoPlay: options.autoPlay !== false });"), "standalone player startup must begin playback without a second user action");
assert(playerPageSource.includes('name === "NotAllowedError" && options.allowMutedFallback'), "standalone player must keep autoplay running when the browser initially blocks sound");
assert(playerPageSource.includes("capturePlaybackSnapshot()") && playerPageSource.includes("await delay(LOCAL_MARKER_RELEASE_DELAY_MS);") && playerPageSource.includes("await restorePlaybackSnapshot(playbackSnapshot);"), "standalone player marker changes must release the media handle and resume the same playback");
assert(playerPageSource.includes('createMoveField("搜索人物", existingInput)') && playerPageSource.includes("searchMovePeople(movePeople, query)") && playerPageSource.includes("submit.disabled = !selectedExistingPerson"), "standalone player migration must select existing people by name rather than requiring an id");
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
assert(fanhaoModuleIndexSource.includes('people-page.js?v=20260724-person-local-refresh-01'), "person-local refresh changes must use a fresh browser module URL");
assert(fanhaoModuleIndexSource.includes('work-page-appender.js?v=20260724-work-pagination-02'), "in-place work pagination must use a fresh browser module URL");
assert(fanhaoModuleIndexSource.includes('ranking-page.js?v=20260726-work-sort-01') && fanhaoModuleIndexSource.includes('query.js?v=20260726-work-sort-01'), "work sorting changes must refresh ranking and shared query modules");
assert(webApp.includes('["ratingCountDesc", "评价人数最多"]') && webApp.includes('["popularityDesc", "热度最高"]') && !webApp.includes("评分最低"), "Web work sorting must expose audience and popularity sorts without the lowest-rating option");
assert(rankingPageSource.includes('["ratingCountDesc", "评价人数最多"]') && rankingPageSource.includes('["popularityDesc", "热度最高"]'), "ranking work sorting must expose audience and popularity sorts");
assert(fanhaoModuleIndexSource.includes('collection-page.js?v=20260724-work-pagination-01'), "collection pagination changes must use a fresh browser module URL");
assert(fanhaoModuleIndexSource.includes('studio-page.js?v=20260724-work-pagination-01'), "studio pagination changes must use a fresh browser module URL");
assert(collectionPageSource.includes("const collectionPrefetches = new Map()") && collectionPageSource.includes("warmHistoryRanges()"), "Web history ranges must reuse prefetched pages while the collection view remains active");
assert(collectionPageSource.includes("const COLLECTION_PREFETCH_TTL_MS = 5 * 60 * 1000") && collectionPageSource.includes("invalidatePrefetches"), "Web collection prefetches must survive normal reading time and expose explicit invalidation");
assert(peoplePageSource.includes("const PERSON_DETAIL_DESKTOP_PAGE_SIZE = 64") && peoplePageSource.includes("const PERSON_DETAIL_MOBILE_PAGE_SIZE = 48"), "person details must keep desktop and mobile first payloads bounded");
assert(peoplePageSource.includes("const personDetailPrefetches = new Map()") && peoplePageSource.includes("reusePrefetch: options.reusePrefetch !== false"), "person interactions must reuse prepared detail requests unless a local rescan explicitly invalidates them");
assert(peoplePageSource.includes("schedulePersonDetailPrefetch(person.id)") && peoplePageSource.includes("preparePersonDetailFromIntent(root, event.target)"), "delegated person cards must prepare details before desktop and touch clicks");
assert(peoplePageSource.includes("detailPending: true") && personProfileSource.includes("正在加载详情"), "Web person navigation must paint the indexed profile before the detail API returns");
assert(personProfileSource.includes("data-person-local-refresh") && personProfileSource.includes('textContent = "刷新本地"') && personProfileSource.includes("/api/admin/rescan-person"), "person details must expose a direct local refresh action");
assert(personProfileSource.includes("reusePrefetch: false") && peoplePageSource.includes("invalidatePersonDetailPrefetches(personId)"), "person local refresh must bypass stale prepared detail responses");
assert(personLibraryServiceSource.includes("reconcilePersonLocalWorks(previousWorks, works)"), "person rescans must reconcile disappeared local works with the core database");
assert(personLibraryServiceSource.includes("previousWork?.infoSummary") && personLibraryServiceSource.includes("work.infoSummary = { ...previousWork.infoSummary }"), "person rescans must preserve indexed work metadata");
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
  "android-client/www/modules/fanhao/features/works/detail-toolbar.js",
  "android-client/www/modules/fanhao/features/works/preview-media.js",
  "android-client/www/modules/fanhao/features/people/detail-request.js",
  "android-client/www/modules/fanhao/features/works/collection-request.js",
  "android-client/www/modules/fanhao/features/works/page-data-service.js",
  "android-client/www/modules/fanhao/features/works/progressive-list-renderer.js",
  "android-client/www/modules/fanhao/features/shared/viewport-image-loader.js",
  "android-client/www/modules/fanhao/features/rankings/ranking-views.js",
  "android-client/www/modules/fanhao/features/categories/category-views.js",
  "android-client/www/modules/fanhao/features/brands/brand-switch.js",
  "android-client/www/modules/fanhao/features/code-prefixes/prefix-views.js",
  "android-client/www/modules/fanhao/features/studios/index-model.js",
  "android-client/www/modules/fanhao/features/people/detail-work-toolbar.js",
  "android-client/www/modules/fanhao/chrome.js",
  "android-client/www/modules/fanhao/sheet.js",
  "android-client/www/modules/fanhao/search-page.js",
  "android-client/www/modules/fanhao/styles.css",
  "src/modules/fanhao/server/composition.js",
  "src/modules/fanhao/server/user-state/collection-query-service.js",
  "src/modules/fanhao/server/works/work-filter-service.js",
  "src/modules/fanhao/server/works/work-category.js"
]) {
  assert(fs.statSync(path.join(root, relativePath), { throwIfNoEntry: false })?.isFile(), `missing FanHao refactor part: ${relativePath}`);
}

const androidWorkViews = read("android-client/www/modules/fanhao/work-views.js");
const androidWorkFiltering = read("android-client/www/js/work-filtering.js");
const androidWorkPageDataService = read("android-client/www/modules/fanhao/features/works/page-data-service.js");
const androidWorkSearchDataService = read("android-client/www/modules/fanhao/features/works/search-data-service.js");
const androidSearchResultToolbar = read("android-client/www/modules/fanhao/features/works/search-result-toolbar.js");
const androidWorkDetailDataService = read("android-client/www/modules/fanhao/features/works/detail-data-service.js");
const androidPersonDetailRequest = read("android-client/www/modules/fanhao/features/people/detail-request.js");
const androidPersonDetailWorkToolbar = read("android-client/www/modules/fanhao/features/people/detail-work-toolbar.js");
const androidDetailViews = read("android-client/www/modules/fanhao/detail-views.js");
const androidPlayerSource = read("android-client/www/js/android-player.js");
const androidApp = read("android-client/www/app.js");
const androidCacheSource = read("android-client/www/js/cache.js");
const androidIndexHtml = read("android-client/www/index.html");
const androidFanhaoModule = read("android-client/www/modules/fanhao/android-module.js");
const androidFanhaoChrome = read("android-client/www/modules/fanhao/chrome.js");
const androidFanhaoSheet = read("android-client/www/modules/fanhao/sheet.js");
const androidMobileActionSheet = read("android-client/www/js/mobile-action-sheet.js");
const androidFanhaoSearchPage = read("android-client/www/modules/fanhao/search-page.js");
const androidFanhaoStyles = read("android-client/www/modules/fanhao/styles.css");
const androidStyles = read("android-client/www/styles.css");
const androidBaseStyles = read("android-client/www/css/base.css");
const androidNovelStyles = read("android-client/www/modules/novels/styles.css");
const androidMusicHomeStyles = read("android-client/www/modules/music/home.css");
const androidShortVideoListStyles = read("android-client/www/modules/short-videos/styles/list.css");
const androidToolModule = read("android-client/www/modules/tools/android-module.js");
const androidToolViews = read("android-client/www/modules/tools/tool-views.js");
const androidToolStyles = read("android-client/www/modules/tools/styles.css");
const androidPeopleViews = read("android-client/www/modules/fanhao/people-views.js");
const androidRankingViews = read("android-client/www/modules/fanhao/features/rankings/ranking-views.js");
const androidCategoryViews = read("android-client/www/modules/fanhao/features/categories/category-views.js");
const androidBrandSwitch = read("android-client/www/modules/fanhao/features/brands/brand-switch.js");
const androidCodePrefixViews = read("android-client/www/modules/fanhao/features/code-prefixes/prefix-views.js");
const androidWorkCards = read("android-client/www/modules/fanhao/features/works/cards.js");
const androidWorkActions = read("android-client/www/modules/fanhao/features/works/actions.js");
const androidWorkDetailToolbar = read("android-client/www/modules/fanhao/features/works/detail-toolbar.js");
const androidWorkCardPresentation = read("android-client/www/modules/fanhao/features/works/card-presentation.js");
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
assert(!androidFanhaoModule.includes('route("favorites"') && !androidFanhaoModule.includes('route("vr"') && !androidApp.includes("renderChannelFavoritesPanel"), "Android favorites and VR must remain work filters instead of independent pages or panels");
assert(androidFanhaoChrome.indexOf('{ label: "演员", view: "people" }') < androidFanhaoChrome.indexOf('{ label: "分类", view: "categories" }') && androidFanhaoChrome.includes('{ label: "厂牌", view: "studios" }'), "Android FanHao chrome must expose the four focused actor, category, ranking, and brand roots");
assert(!androidFanhaoChrome.includes('{ label: "作品", view: "works" }') && !androidFanhaoChrome.includes('{ label: "前缀", view: "codePrefixes" }') && !androidFanhaoChrome.includes('{ label: "片商", view: "studios" }'), "Android FanHao chrome must not keep redundant works, prefix, or studio tabs");
assert(androidFanhaoChrome.includes("if (view === tab.view)") && androidFanhaoChrome.includes("openSortDialog(host, activeSort)"), "tapping the active FanHao chrome tag must open its sort sheet");
assert(androidFanhaoChrome.includes('button.classList.toggle("has-menu", opensSort)') && androidFanhaoChrome.includes("点按选择${menuLabel}") && androidFanhaoStyles.includes(".fanhao-chrome-tag.has-menu"), "active FanHao tabs must visibly announce whether they open sorting or year selection");
assert(androidFanhaoStyles.includes(".fanhao-sort-sheet") && androidFanhaoStyles.includes("grid-template-columns: repeat(2"), "FanHao sorting must use the compact two-column bottom sheet");
assert(androidFanhaoChrome.includes("sheet.js?v=20260731-mobile-action-sheet-01") && androidFanhaoChrome.includes("openFanhaoSheet({") && androidFanhaoSheet.includes("openMobileActionSheet as openFanhaoSheet") && androidMobileActionSheet.includes("mobile-action-sheet-overlay"), "FanHao sorting must reuse the shared bottom sheet");
assert(androidFanhaoChrome.includes('if (view === "studios")') && androidFanhaoChrome.includes('title: "厂牌排序"') && androidWorkViews.includes("getStudioSortOptions"), "the active brand tab must open the shared studio sort sheet");
assert.deepEqual(STUDIO_SORT_OPTIONS.map((option) => option.value), ["count", "recent", "name"], "studio browsing must offer count, recency, and name ordering");
const studioIndexFixture = [
  { id: "beta", name: "Beta", localWorkCount: 3, latestReleaseDate: "2026-01-01" },
  { id: "alpha", name: "Alpha", localWorkCount: 8, latestReleaseDate: "2025-01-01" },
  { id: "gamma", name: "Gamma", localWorkCount: 8, latestReleaseDate: "2026-06-01" }
];
assert.deepEqual(selectStudios(studioIndexFixture, { sort: "count" }).map((studio) => studio.id), ["gamma", "alpha", "beta"], "studio count ordering must use recency as a stable tie breaker");
assert.deepEqual(selectStudios(studioIndexFixture, { sort: "recent" }).map((studio) => studio.id), ["gamma", "beta", "alpha"], "studio recency ordering must expose recently active makers first");
assert.deepEqual(selectStudios(studioIndexFixture, { sort: "name", query: "ALP" }).map((studio) => studio.id), ["alpha"], "studio name filtering must be case insensitive and retain active ordering");
assert(androidWorkViews.includes('input.placeholder = "筛选片商名称"') && androidWorkViews.includes("selectStudios(studios") && androidWorkViews.includes("studioActiveYears(studio)"), "Android studio browsing must combine direct filtering with useful activity metadata");
assert(androidListStyles.includes('.content-panel[data-view="studios"] > .view-meta') && androidListStyles.includes(".studio-index-tools") && /\.studio-list\s*\{[\s\S]*?grid-template-columns: repeat\(2/.test(androidListStyles), "Android studio browsing must merge its count into a compact toolbar and use a dense two-column index");
assert(androidApp.includes('const DEFAULT_VIEW = "categories"') && androidFanhaoModule.includes('route("categories"') && androidIndexHtml.includes('data-open-view="categories"'), "Android FanHao navigation must use category browsing as the default work entry");
assert.deepEqual(CATEGORY_OPTIONS.map((option) => option.value), ["all", "censored", "western", "fc2", "anime"], "Android categories must expose the complete library before the four broad classes");
assert(androidBrandSwitch.includes('{ view: "studios", label: "片商" }') && androidBrandSwitch.includes('{ view: "codePrefixes", label: "前缀" }') && androidWorkViews.includes('createBrandModeSwitch("studios"') && androidCodePrefixViews.includes('createBrandModeSwitch("codePrefixes"') && androidFanhaoStyles.includes(".fanhao-brand-switch"), "Android FanHao must merge studio and prefix browsing under one brand root without removing either path");
assert(androidFanhaoModule.includes('route("codePrefixes"') && androidFanhaoModule.includes('route("codePrefixDetail"') && androidFanhaoStyles.includes(".code-prefix-mobile-list"), "Android FanHao navigation must retain its mobile-specific code-prefix browser and detail route");
assert.equal(normalizeCodePrefix("fc2_ppv"), "FC2-PPV", "Android code-prefix routes must normalize pasted prefixes");
const androidPrefixUrl = new URL(codePrefixDetailPath("fc2_ppv", { filter: "missingLocal", sort: "releaseDesc", limit: 96 }), "http://fanhao.local");
assert.equal(androidPrefixUrl.pathname, "/api/code-prefixes/FC2-PPV", "Android code-prefix details must use the shared catalog endpoint");
assert.equal(androidPrefixUrl.searchParams.get("includeMissingLocal"), "1", "Android missing-prefix filtering must request missing works from the server");
assert.equal(androidPrefixUrl.searchParams.get("limit"), "96", "Android code-prefix details must preserve the active page size");
assert(androidCodePrefixViews.includes('input.placeholder = "筛选番号或厂商"') && androidCodePrefixViews.includes('showView("codePrefixDetail"') && androidCodePrefixViews.includes("pageDataService.warm"), "Android code-prefix browsing must provide direct filtering, detail navigation, and touch prewarming");
assert.deepEqual(WORK_CATEGORY_OPTIONS.map((option) => option.value), ["censored", "western", "fc2", "anime"], "FanHao categories must expose censored, western, FC2, and anime in the requested order");
assert.equal(normalizeWorkCategory("FC2"), "fc2", "server category parsing must be case insensitive");
assert.equal(normalizeWorkCategory("unknown"), "all", "unknown server categories must fall back to the complete library");
assert.equal(isFc2Work({ infoSummary: { code: "FC2-PPV-4923651" } }), true, "FC2 classification must recognize authoritative metadata codes");
assert.equal(isAnimeWork({ personName: "[动漫]" }), true, "anime classification must recognize the library actor marker");
assert.equal(classifyWorkCategory({ title: "FC2-123456" }, { isWestern: true }), "western", "western roots must remain authoritative when category signals overlap");
assert.deepEqual(summarizeWorkCategories([
  { title: "ABC-123" },
  { infoSummary: { code: "FC2-PPV-123456" } },
  { personName: "动漫" },
  { title: "WEST-001", western: true }
], { isWestern: (work) => work.western === true }).map(({ value, count }) => [value, count]), [["censored", 1], ["western", 1], ["fc2", 1], ["anime", 1]], "actor filmography category summaries must use the same exhaustive four-way classifier as catalog browsing");
assert.equal(normalizeCategory("anime"), "anime", "Android category routes must preserve supported category ids");
const westernCategoryUrl = new URL(categoryWorksPath("western", { filter: "playable", sort: "releaseDesc", limit: 64 }), "http://127.0.0.1");
assert.equal(westernCategoryUrl.searchParams.get("category"), "western", "Android category requests must send the selected server category");
assert.equal(westernCategoryUrl.searchParams.get("filter"), "playable", "Android category requests must preserve work filters");
assert.equal(westernCategoryUrl.searchParams.get("sort"), "releaseDesc", "Android category requests must preserve work sorting");
assert(androidCategoryViews.includes('strip.className = "fanhao-category-strip"') && androidCategoryViews.includes("data.categories") && androidCategoryViews.includes("compactSummary: true"), "Android categories must combine a four-way selector with the dense work browser");
assert(androidListStyles.includes(".fanhao-category-strip") && /\.fanhao-category-strip\s*\{[\s\S]*?grid-template-columns: repeat\(4/.test(androidListStyles), "Android category choices must fit in one compact four-column row");
assert(workRoutesApiSource.includes('url.pathname === "/api/fanhao/categories"') && workRoutesApiSource.includes("categorySummaryPayload()"), "FanHao must expose category counts from the module-scoped works API");
assert(androidFanhaoChrome.includes('view === "personDetail"') && androidFanhaoChrome.includes('view === "workDetail"') && androidFanhaoChrome.includes("renderDetailChrome(container, view, host)"), "Android FanHao detail routes must replace the catalog tabs with one compact detail header");
assert(androidFanhaoChrome.includes("host.navigation.goBack()") && androidFanhaoChrome.includes("title.dataset.fanhaoDetailTitle") && androidFanhaoStyles.includes(".fanhao-detail-chrome-row"), "Android FanHao detail headers must keep a sticky shared return action and updateable title");
assert(androidFanhaoChrome.includes("container.dataset.detailView = view") && androidFanhaoStyles.includes('.module-chrome[data-module="fanhao"][data-detail-view]') && androidFanhaoStyles.includes("position: fixed"), "Android FanHao detail return controls must retain stable hit testing after the page scrolls");
assert(androidFanhaoStyles.includes("min-height: 44px") && androidFanhaoStyles.includes("touch-action: manipulation"), "Android FanHao detail return controls must keep a direct phone-sized touch target");
assert(androidFanhaoSheet.includes("openMobileActionSheet as openFanhaoSheet") && androidMobileActionSheet.includes('backdrop.addEventListener("click", close)') && androidMobileActionSheet.includes('event.key === "Escape"') && androidMobileActionSheet.includes("config.options || []"), "the shared FanHao sheet must support backdrop, keyboard, and configurable actions");
assert(lines("android-client/www/modules/fanhao/sheet.js") <= 60, "the shared FanHao bottom sheet must stay focused");
assert(androidFanhaoSearchPage.includes("fanhao-search-page-form") && androidFanhaoSearchPage.includes("搜索历史") && androidFanhaoSearchPage.includes("input.focus({ preventScroll: true })"), "FanHao search must use a focused dedicated page with history");
assert(androidFanhaoSearchPage.includes('createSearchGroup("快捷搜索"') && androidFanhaoSearchPage.includes('createSearchGroup("演员推荐"') && androidFanhaoSearchPage.includes("getLibrary()?.people"), "FanHao search discovery must fill the landing page with local dynamic shortcuts");
assert(androidFanhaoSearchPage.includes('meta: "本地标记"') && androidFanhaoSearchPage.includes("remember: false"), "the local marker shortcut must remain distinct from actual search history");
assert(androidFanhaoSearchPage.includes('showView("personDetail", { personId: author.id }, { push: true })') && androidFanhaoSearchPage.includes('note: "点选直达"'), "recommended authors must open their detail directly without an intermediate search-result touch target");
assert(androidFanhaoStyles.includes(".fanhao-search-discovery-group") && androidFanhaoStyles.includes("min-height: 150px"), "FanHao search discovery must stay compact above the phone keyboard");
assert(androidWorkSearchDataService.includes("function suggestions") && androidWorkSearchDataService.includes('path(text, 6, "all", "updated")') && androidFanhaoSearchPage.includes("fanhao-search-suggestions"), "FanHao search must expose bounded live suggestions through the module-scoped endpoint");
assert(androidFanhaoSearchPage.includes("renderResultOverview") && androidFanhaoSearchPage.includes("fanhao-search-result-summary") && androidFanhaoSearchPage.includes("fanhao-search-person-card"), "FanHao search results must expose visible counts and portrait-backed actor matches");
assert(androidWorkSearchDataService.includes('category: String(category || "all")') && androidWorkViews.includes("serverSort, searchCategory") && androidWorkViews.includes("onCategoryChange: setSearchCategory"), "FanHao search must send and retain its route-local work category");
assert(androidWorkViews.includes("mountSearchResultToolbar({") && androidWorkViews.includes("hideControls: true") && androidSearchResultToolbar.includes('options.container.classList.add("has-result-toolbar")'), "FanHao search results must replace the clipped chip strip with a compact toolbar");
assert(androidSearchResultToolbar.includes('createToolbarButton("类型"') && androidSearchResultToolbar.includes('createToolbarButton("筛选"') && androidSearchResultToolbar.includes('createToolbarButton("排序"') && androidSearchResultToolbar.includes("openFanhaoSheet({"), "FanHao search controls must expose type, filter, and sort through the shared bottom sheet");
assert(androidFanhaoStyles.includes(".fanhao-search-result-toolbar") && androidFanhaoStyles.includes(".fanhao-search-results.has-result-toolbar") && androidFanhaoStyles.includes("position: fixed"), "FanHao search toolbar must stay reachable without covering the result grid");
assert(lines("android-client/www/modules/fanhao/features/works/search-result-toolbar.js") <= 140, "Android search result toolbar must stay focused");
assert(androidFanhaoModule.includes("replaceViewParams: host.navigation.replaceViewParams") && androidWorkViews.includes('preserveQuery: (query) => replaceViewParams("search", { query })') && androidFanhaoSearchPage.includes("preserveQuery(query)"), "direct live-suggestion navigation must preserve the typed query for the Android back path");
assert(androidFanhaoStyles.includes(".fanhao-search-suggestion") && androidFanhaoStyles.includes(".fanhao-search-result-summary") && androidFanhaoStyles.includes("object-fit: contain"), "FanHao search suggestions and complete actor portraits must have dedicated phone styling");
const authorSuggestions = localAuthorSearchSuggestions([
  { name: "collection", workCount: 900, sourceCount: 20 },
  { id: "male", actorProfile: { displayName: "男作者", gender: "male" }, workCount: 100, sourceCount: 12 },
  { id: "a-old", actorProfile: { displayName: "作者甲", gender: "female" }, workCount: 18, sourceCount: 3 },
  { id: "b", actorProfile: { displayName: "作者乙", gender: "female" }, workCount: 42, sourceCount: 2 },
  { id: "a-best", actorProfile: { displayName: "作者甲", gender: "female" }, workCount: 28, sourceCount: 5 },
  { id: "c", actorProfile: { displayName: "作者丙", gender: "female" }, workCount: 0, sourceCount: 9 }
], 2);
assert.deepEqual(authorSuggestions.map(({ id, name, workCount }) => [id, name, workCount]), [["a-best", "作者甲", 28], ["b", "作者乙", 42]], "local author search suggestions must deduplicate, rank by source coverage, and retain the direct-navigation id");
const liveSearchSuggestions = buildFanhaoSearchSuggestions({
  people: [
    { id: "person-1", actorProfile: { displayName: "演员甲" }, workCount: 21, avatarUrl: "/media/core-image/avatar-1" },
    { id: "person-2", name: "演员乙", workCount: 9 },
    { id: "person-3", name: "演员丙", workCount: 4 }
  ],
  works: [
    { id: "work-1", title: "FNS-220 测试作品", personName: "演员甲", videoCount: 1, coverId: "cover-1", infoSummary: { code: "FNS-220", releaseDate: "2026-07-23" } },
    { id: "work-2", title: "ABF-363 第二作品", personName: "演员乙", videoCount: 1, infoSummary: { code: "ABF-363" } },
    { id: "work-2", title: "重复作品" }
  ]
}, 4);
assert.deepEqual(liveSearchSuggestions.map(({ kind, id }) => [kind, id]), [["person", "person-1"], ["person", "person-2"], ["work", "work-1"], ["work", "work-2"]], "live FanHao suggestions must reserve room for both actor and work matches while deduplicating ids");
assert.equal(liveSearchSuggestions[0].detail, "21 部本地作品", "actor suggestions must explain their local work count");
assert.equal(liveSearchSuggestions[2].label, "FNS-220 · 测试作品", "work suggestions must retain both code and compact title");
assert(androidFanhaoModule.includes('mode: "dedicated"') && androidFanhaoChrome.includes('showView("search", { query: "" }, { push: true })'), "FanHao chrome search must navigate to the dedicated search route");
const filteredPersonDetailUrl = new URL(personDetailPath("person/13", {
  limit: 96,
  offset: 48,
  filter: "highRating,vr",
  year: "2024",
  sort: "ratingDesc"
}), "http://127.0.0.1");
assert.equal(filteredPersonDetailUrl.pathname, "/api/people/person%2F13", "Android person requests must encode public person ids");
assert.equal(filteredPersonDetailUrl.searchParams.get("limit"), "96", "Android person requests must preserve the active page size");
assert.equal(filteredPersonDetailUrl.searchParams.get("offset"), "48", "Android person requests must support server continuation offsets");
assert.equal(filteredPersonDetailUrl.searchParams.get("filter"), "highRating,vr", "Android person requests must send combined work filters to the server");
assert.equal(filteredPersonDetailUrl.searchParams.get("year"), "2024", "Android person requests must send the selected release year to the server");
assert.equal(filteredPersonDetailUrl.searchParams.get("sort"), "ratingDesc", "Android person requests must send the active work sort to the server");
assert.equal(filteredPersonDetailUrl.searchParams.get("includeMissingLocal"), "1", "Android person requests must explicitly retain missing catalog works");
assert.equal(filteredPersonDetailUrl.searchParams.get("includeCompilation"), "1", "Android person requests must explicitly retain compilation works");
const personYearWorks = [
  { id: "work-2024-a", infoSummary: { releaseDate: "2024-01-02" } },
  { id: "work-unknown", infoSummary: { releaseDate: "" } },
  { id: "work-2025", infoSummary: { releaseDate: "2025-06-03" } },
  { id: "work-2024-b", releaseDate: "2024-11-12" }
];
assert.equal(normalizePersonWorkYear("2024"), "2024", "actor year filtering must retain valid release years");
assert.equal(normalizePersonWorkYear("future"), "all", "actor year filtering must reject unsupported values");
assert.deepEqual(worksForPersonYear(personYearWorks, "2024").map((work) => work.id), ["work-2024-a", "work-2024-b"], "actor year filtering must select only matching releases");
assert.deepEqual(personWorkYearOptions(personYearWorks), [
  { value: "all", label: "全部年份", count: 4 },
  { value: "2025", label: "2025 年", count: 1 },
  { value: "2024", label: "2024 年", count: 2 },
  { value: "unknown", label: "日期未知", count: 1 }
], "actor year choices must be newest-first and retain undated works");
assert(androidDetailViews.includes("personDetailPath(personId, { ...getWorkListRequestState(), year: selectedYear, limit: getWorksLimit() })") && androidFanhaoModule.includes("getWorkListRequestState: workViews.getWorkListRequestState"), "Android person pages must combine the rendered work-list state with their selected year");
assert(androidWorkViews.includes("getWorkListRequestState: () => ({ filter: workListState.getServerFilterMode(), sort: workListState.getServerSortMode() })"), "Android work views must expose one authoritative server filter and sort snapshot");
assert(/function studioDetailPath[\s\S]*?filter: workListState\.getServerFilterMode\(\)[\s\S]*?return `\/api\/studios\//.test(androidWorkViews), "Android studio requests must send the authoritative server filter");
const filteredFavoriteCollectionUrl = new URL(workCollectionPath("favorites", { limit: 96, offset: 48, filter: "highRating,vr", sort: "ratingDesc", folderId: "folder/1" }), "http://127.0.0.1");
assert.equal(filteredFavoriteCollectionUrl.pathname, "/api/favorites", "Android favorite requests must use the collection endpoint");
assert.equal(filteredFavoriteCollectionUrl.searchParams.get("limit"), "96", "Android collection requests must preserve the active page size");
assert.equal(filteredFavoriteCollectionUrl.searchParams.get("offset"), "48", "Android collection requests must support server continuation offsets");
assert.equal(filteredFavoriteCollectionUrl.searchParams.get("filter"), "highRating,vr", "Android collection requests must send combined work filters to the server");
assert.equal(filteredFavoriteCollectionUrl.searchParams.get("sort"), "ratingDesc", "Android collection requests must send the active work sort to the server");
assert.equal(filteredFavoriteCollectionUrl.searchParams.get("folder"), "folder/1", "Android favorite requests must preserve encoded folder ids");
assert(androidWorkViews.includes('return workCollectionPath("history", {') && androidWorkViews.includes("filter: workListState.getServerFilterMode()") && !androidWorkViews.includes('workCollectionPath("favorites"'), "Android history must keep the authoritative filtered request builder without restoring the removed favorites page");
assert(androidWorkViews.includes("serverContinuationOptions(works, total)") && androidDetailViews.includes("activeFilterTotal: data.total || works.length"), "Android server-filtered pages must retain the server total for continuation");
assert(lines("android-client/www/modules/fanhao/features/people/detail-request.js") <= 24 && androidPersonDetailRequest.includes("URLSearchParams"), "Android person request construction must stay focused and encoded");
assert(androidWorkViews.includes("const searchListState = createWorkListState({") && androidWorkViews.includes("persist: false") && androidWorkViews.includes('initialFilterMode: "all"'), "FanHao Android search must start from an isolated unfiltered list state");
assert(androidWorkViews.includes("workListState: searchListState") && androidWorkViews.includes("listState: searchListState"), "FanHao Android search requests and controls must share their isolated list state");
assert(androidWorkViews.includes('searchListState.setFilterMode("all", { replace: true, rerender: false })') && androidWorkViews.includes('searchListState.setSortMode("updated", { rerender: false })'), "opening a fresh FanHao Android search must reset route-local filters");
assert(androidWorkViews.includes("const { container = els.viewContent, listState = workListState, ...renderOptions } = options"), "Android work rendering must allow route-owned list state and dedicated search containers");
assert(androidWorkFiltering.includes("const persist = context.persist !== false") && androidWorkFiltering.includes("if (persist && options.persist !== false)"), "Android list state must support non-persistent route-local filters");
assert(androidWorkFiltering.includes("const filterToReveal = activeFilters.size") && androidWorkFiltering.includes("function revealActiveFilter(filterStrip, button)") && androidWorkFiltering.includes("globalThis.requestAnimationFrame") && androidWorkFiltering.includes("filterStrip.scrollLeft = Math.max"), "Android work filters must reveal the active chip without moving the page vertically");
assert(androidWorkFiltering.includes('filterStrip.setAttribute("aria-label", "作品筛选")') && androidWorkFiltering.includes('button.setAttribute("aria-pressed", active ? "true" : "false")'), "Android work filters must expose their selected state to accessibility services");
assert(androidWorkFiltering.includes("controls.append(filterStrip)") && androidWorkFiltering.includes("function getSortOptions(options = {})") && !androidWorkFiltering.includes('document.createElement("select")'), "Android catalog sorting must leave its filter row and move sort options into sheets");
assert(androidWorkViews.includes("compactSummary: true") && androidWorkFiltering.includes('controls.classList.add("has-compact-summary")') && androidWorkFiltering.includes('summary.setAttribute("aria-label", `已载入'), "Android main work browsing must merge loaded and total counts into the filter rail");
assert(androidListStyles.includes('.content-panel[data-view="works"] > .view-meta') && androidListStyles.includes(".work-controls.has-compact-summary") && androidListStyles.includes("grid-template-columns: auto minmax(0, 1fr)"), "Android work browsing must reclaim the standalone count row without hiding filter access");
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
  const sortOptions = searchListState.getSortOptions();
  assert(sortOptions.some((option) => option.value === "ratingCountDesc" && option.label === "评价人数最多"), "Android work sorting must expose the rating-count option");
  assert(sortOptions.some((option) => option.value === "popularityDesc" && option.label === "热度最高"), "Android work sorting must expose the popularity option");
  assert(!sortOptions.some((option) => option.value === "ratingAsc") && !androidWorkFiltering.includes("评分最低"), "Android work sorting must remove the lowest-rating option");
  const sortFixtures = [
    { id: "audience", infoSummary: { rating: 4, ratingCount: 100 } },
    { id: "popular", infoSummary: { rating: 4.9, ratingCount: 90 } },
    { id: "small", infoSummary: { rating: 5, ratingCount: 80 } }
  ];
  assert.deepEqual(searchListState.visibleWorks(sortFixtures, { sortMode: "ratingCountDesc" }).map((work) => work.id), ["audience", "popular", "small"], "Android rating-count sorting must order by audience size");
  assert.deepEqual(searchListState.visibleWorks(sortFixtures, { sortMode: "popularityDesc" }).map((work) => work.id), ["popular", "audience", "small"], "Android popularity sorting must order by rating multiplied by audience size");
  const toolbarFilterOptions = searchListState.getFilterOptions([{ playableCount: 1, favorite: true }], { all: 12, playable: 7 });
  assert.equal(toolbarFilterOptions.find((option) => option.value === "all")?.count, 12, "detail filter menus must use the authoritative server total");
  assert.equal(toolbarFilterOptions.find((option) => option.value === "playable")?.count, 7, "detail filter menus must prefer server facets");
  assert.equal(toolbarFilterOptions.find((option) => option.value === "favorite")?.count, 1, "detail filter menus must retain local fallback counts");
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
assert(lines("android-client/www/modules/fanhao/features/works/card-presentation.js") <= 140, "FanHao Android work-card presentation helpers must stay focused");
assert(androidApp.includes(".sort(peopleViews.sortPeople)") && !androidApp.includes("const aVisual = portraitUrlForPerson(a) ? 1 : 0"), "Android home must reuse the author index ordering supported by compact person-list fields");
assert(androidPeopleViews.includes("const aVisual = portraitUrlForPerson(a) ? 1 : 0"), "Android people sorting must recognize portrait-only person-list avatar URLs");
assert.equal(portraitUrlForPerson({ avatarUrl: "/media/person/48/cover" }), "", "Android author cards must not present a work-cover fallback as a portrait");
assert.equal(portraitUrlForPerson({ avatarUrl: "/media/image/fallback", avatarImage: { source: "work_cover" } }), "", "Android author cards must reject explicitly sourced work-cover fallbacks");
assert.equal(portraitUrlForPerson({ coverId: "work-cover-without-avatar" }), "", "Android author cards must not infer a portrait from a generic work cover id");
assert.equal(portraitUrlForPerson({ avatarUrl: "/media/image/manual", avatarImage: { source: "manual_person_cover" } }), "/media/image/manual", "Android author cards must keep an intentional person portrait");
assert.equal(portraitUrlForPerson({ actorProfile: { avatarUrl: "https://example/avatar.jpg" } }), "https://example/avatar.jpg", "Android author cards must keep a profile portrait");
assert(androidApp.includes("const FAST_WORK_LIMIT = 48"), "Android FanHao work views must request a phone-sized interactive first page");
assert(androidApp.includes("const FAST_WORK_STEP = 48"), "Android FanHao work views must grow in phone-sized pages");
assert(androidApp.includes("const FAST_PEOPLE_LIMIT = 64"), "Android people index must keep its first page compact");
assert(androidApp.includes("const FAST_PEOPLE_STEP = 64"), "Android people index must grow in bounded pages");
assert(!androidApp.includes("return fast ? 480"), "Android FanHao detail and collection views must not restore oversized initial requests");
assert(androidPeopleViews.includes("avatarLoader.schedule(visual, imagePath)"), "Android people avatars must wait until their cards approach the viewport");
assert(androidPeopleViews.includes("appendPeopleCards(grid, people.slice(start, nextLimit)"), "Android people continuation must append only the next page");
assert(androidPeopleViews.includes("restorePeopleIndex(sourcePeople, sortMode, filterMode)") && androidPeopleViews.includes("cache.sourcePeople !== sourcePeople") && androidPeopleViews.includes("cache.filterMode !== filterMode"), "Android people navigation must restore only the matching actor category and sort without rebuilding it");
assert(androidPeopleViews.includes("els.viewContent.replaceChildren(...nodes)") && androidPeopleViews.includes("syncPeopleLimit(cache.grid.children.length)"), "Android people restoration must retain loaded cards and synchronize continuation with the rendered count");
assert(androidPeopleViews.includes("getSortOptions:") && androidPeopleViews.includes("setSortMode: setPeopleSortMode") && !androidPeopleViews.includes("createPeopleSortControls"), "Android author sorting must be owned by the active chrome tag instead of a permanent row");
assert(androidPeopleViews.includes('{ value: "sources", label: "多来源"') && !androidPeopleViews.includes('{ value: "videos"'), "Android author sorting must only offer fields present in the lightweight person payload");
assert(androidPeopleViews.includes("isBrowsableAuthor(person)") && androidPeopleViews.includes("noactor|unknownactor"), "Android author browsing must hide obvious placeholder and collection records without deleting library data");
assert.equal(isBrowsableAuthor({ name: "明里つむぎ" }), true, "real Japanese author names must remain browseable");
assert.equal(isBrowsableAuthor({ name: "Melody Marks" }), true, "real Western author names must remain browseable");
for (const placeholderName of ["noactor", "[动漫]", "[]", "精神文明建设之“绅士”养成（1995-2000）", "Elena Koshka actress pack 1", "Alexa Grace MegaPack 配图精装", "Mila Azul Collection Videos"]) {
  assert.equal(isBrowsableAuthor({ name: placeholderName }), false, `placeholder author record must stay out of the mobile index: ${placeholderName}`);
}
const actorFilterFixtures = [
  { id: "female", name: "明里つむぎ", avatarUrl: "/media/core-image/female", actorProfile: { gender: "female" }, isWestern: false },
  { id: "male", name: "黒田悠斗", avatarUrl: "/media/core-image/male", actorProfile: { gender: "male" }, isWestern: false },
  { id: "western", name: "Melody Marks", avatarUrl: "/media/core-image/western", actorProfile: { gender: "female" }, isWestern: true },
  { id: "fallback", name: "愛花未満", avatarUrl: "/media/person/fallback/cover", actorProfile: { gender: "female" }, isWestern: false }
];
assert.equal(normalizePeopleFilter("unknown"), "recommended", "unknown actor categories must fall back to recommendations");
assert.deepEqual(filterPeopleForIndex(actorFilterFixtures, "recommended").map((person) => person.id), ["female"], "actor recommendations must prioritize real portraits while excluding male and Western categories");
assert.deepEqual(filterPeopleForIndex(actorFilterFixtures, "male").map((person) => person.id), ["male"], "male actors must remain discoverable instead of being silently hidden");
assert.deepEqual(filterPeopleForIndex(actorFilterFixtures, "western").map((person) => person.id), ["western"], "Western actors must have a dedicated discovery category");
assert.equal(filterPeopleForIndex(actorFilterFixtures, "all").length, 4, "the all-actor category must retain every browseable actor");
assert(androidPeopleViews.includes('strip.className = "people-category-strip"') && androidPeopleViews.includes('strip.setAttribute("aria-label", "演员分类")'), "Android actor browsing must expose the compact JavDB-style category rail");
assert(!androidPeopleViews.includes('meta.className = "index-person-meta"') && !androidPeopleViews.includes('meta.textContent = `本地 ${formatNumber(person.workCount)} 部'), "Android author tiles must show identity without local-count or source metadata");
assert(androidSectionStyles.includes("grid-template-columns: repeat(3, minmax(0, 1fr))") && androidSectionStyles.includes("contain-intrinsic-size: auto 158px") && /\.index-person-body\s*\{[\s\S]*?text-align: center;/.test(androidSectionStyles), "Android author browsing must use a dense three-column identity grid with centered names");
assert(!androidPeopleViews.includes("renderCurrentViewPreservingScroll"), "Android people continuation must not rebuild the existing index");
assert(androidWorkCards.includes("coverLoader.schedule(thumb, imagePath)"), "Android work cards must defer cover reads until they approach the viewport");
assert(androidWorkCards.includes("compactMeta ? compactWorkCardTitle(work)") && androidWorkCardPresentation.includes("export function compactWorkCode(work)"), "Android compact work cards must keep the work code visible beside the cleaned title");
assert(androidWorkViews.includes('coverGrid: true') && androidWorkViews.includes('grid.className = `work-list${renderOptions.coverGrid ? " cover-grid" : ""}`'), "Android work, studio, and search collections must share the dense cover-grid renderer");
assert(androidDetailViews.includes("coverGrid: true") && androidRankingViews.includes("coverGrid: true"), "Android author works and rankings must reuse the dense cover-grid renderer");
assert(androidWorkCards.includes("createWorkCoverFrame(thumb, work)") && androidWorkCards.includes('identity.className = "work-card-grid-identity"') && androidWorkCards.includes('personLine.className = "work-card-grid-person"'), "Android cover-grid cards must reuse existing navigation while combining code and author into one dense identity row");
assert(androidListStyles.includes(".work-list.cover-grid") && androidListStyles.includes("grid-template-columns: repeat(3, minmax(0, 1fr))") && androidListStyles.includes("gap: 11px 7px") && androidListStyles.includes(".work-card-grid-identity"), "Android work browsing must use a compact three-column grid with a dense identity row");
assert.equal(workGridMeta({ infoSummary: { releaseDate: "2026-07-20", rating: 4.41 } }), "2026-07-20 · ★4.41", "Android work-grid metadata must keep release date and compact rating together");
assert.equal(workGridMeta({ infoSummary: { releaseDate: "2026-07-20", rating: 0, ratingCount: 0, durationMinutes: 110 } }), "2026-07-20 · 110分", "unrated work cards must prefer useful duration over a meaningless zero rating");
assert.equal(workGridMeta({ modifiedAt: "2025-01-02T12:00:00Z", videoCount: 2 }), "2025-01-02 · 2 个视频", "Android work-grid metadata must retain a useful fallback when rating data is absent");
assert.equal(workGridPerson({ personDisplayName: "noactor", infoSummary: { actors: ["明里つむぎ"] } }), "明里つむぎ", "Android dense work cards must recover a real author from metadata when the library group is a placeholder");
assert.equal(workGridPerson({ personName: "unknown actor" }), "", "Android dense work cards must omit placeholder author noise");
assert.equal(compactWorkCode({ infoSummary: { code: "B-008 人妻売春 08" } }), "B-008", "single-letter work codes must not leak title text into the grid code line");
assert.equal(displayWorkTitle({ title: "B-008 人妻売春 08" }, true), "人妻売春 08", "single-letter work codes must be removed from the compact grid title");
assert.deepEqual(workGridBadge({ missingLocal: true, playableCount: 1 }), { text: "未下载", variant: "missing" }, "missing-local state must outrank other work-grid badges");
assert.deepEqual(workGridRankBadge({ ranking: { rankNo: 7 }, playableCount: 1 }), { text: "TOP 7", variant: "rank" }, "ranking cards must expose their rank independently on the cover");
assert.deepEqual(workGridBadge({ ranking: { rankNo: 7 }, playableCount: 1 }), { text: "可播", variant: "playable" }, "ranking cards must retain playback state without hiding their rank");
assert.deepEqual(workGridBadge({ progress: { percent: 38 }, favorite: true }), { text: "在看 38%", variant: "progress" }, "active progress must be more visible than passive favorite state");
assert(androidWorkCards.includes("const hidePerson = Boolean(options.hidePerson)") && androidWorkCards.includes('const personName = hidePerson ? "" : workGridPerson(work)') && androidWorkCards.includes("if (person) body.append(person)"), "Android actor details must suppress repeated actor names in both compact and cover-grid cards");
assert(androidWorkCardPresentation.includes("function extractLeadingWorkCode(value)") && androidWorkCardPresentation.includes("work?.infoSummary?.code"), "Android compact work-code labels must prefer authoritative metadata and only infer codes from title prefixes");
assert(androidWorkViews.includes("workCards.resetCoverLoading();"), "Android work navigation must cancel stale offscreen cover work");
assert(androidWorkViews.includes("progressiveWorkListRenderer.render(grid, visible"), "Android work lists must expose the first card batch before building the remaining page");
assert(!androidWorkViews.includes("for (const work of visible) grid.append"), "Android work lists must not synchronously build the full first page");
assert(androidWorkViews.includes("() => loadMore && container.append(loadMore)"), "Android auto-load must wait until progressive work rendering reaches the active list end");
assert(!androidWorkViews.includes("els.viewContent.append(createLoadMoreButton"), "Android callers must not attach auto-load before progressive work rendering completes");
assert(androidWorkViews.includes("requireScrollIntent: true"), "Android FanHao pagination must require fresh downward scroll intent");
assert(androidWorkViews.includes("hasServerMore: works.length < total") && androidWorkViews.includes("total,"), "Android combined filters must retain the server-filtered continuation total");
assert(androidProgressiveWorkListRenderer.includes("container.isConnected === false"), "Android progressive work rendering must stop after navigation detaches its list");
assert(androidWorkCoverLoader.includes('const WORK_COVER_ROOT_MARGIN = "720px 0px"'), "Android work covers must start shortly before they enter the viewport");
assert(androidViewportImageLoader.includes("const pending = new Map()"), "Android viewport image loading must share one focused queue implementation");
assert(androidListStyles.includes("content-visibility: auto") && androidListStyles.includes("contain-intrinsic-size: auto 128px"), "Android work cards must skip offscreen layout and painting");
assert(workDetailHeroBodyStyles.includes("grid-template-columns: minmax(0, 1fr);") && !workDetailHeroBodyStyles.includes(" auto"), "Android work details must keep a full-width title header");
assert(workDetailTitleStyles.includes("-webkit-line-clamp: 3"), "Android work details must expose three full-width title lines");
assert(androidSectionStyles.includes('@media (max-width: 360px)') && androidSectionStyles.includes("-webkit-line-clamp: 4"), "narrow Android work details must retain a fourth title line");
assert(workDetailActionStyles.includes("flex-wrap: nowrap") && workDetailActionStyles.includes("width: 100%"), "Android work-detail actions must stay in one dedicated full-width row");
assert(workDetailActionButtonStyles.includes("flex: 1 1 0") && workDetailActionButtonStyles.includes("min-width: 0"), "Android work-detail actions must share the available phone width evenly");
assert(androidDetailViews.includes("titleBlock.append(title, author)") && androidDetailViews.includes("hero.append(body, cover, metaBody)"), "Android work details must give the title full width and place playback before metadata");
assert(androidDetailViews.includes("metaBody.append(actions)") && !androidDetailViews.includes("work-detail-updated") && !androidSectionStyles.includes(".work-detail-updated"), "Android work details must not spend a separate row on the filesystem update date");
assert(androidDetailViews.includes("playbackDurationText(work)") && androidDetailViews.includes("formatBytes((work.videos || [])") && androidDetailViews.includes('{ label: "大小", value: videoSize }'), "Android work facts must recover useful duration and total video size when scraped metadata is sparse");
assert(androidDetailViews.includes('highlights.classList.add("work-facts-highlights")') && !androidDetailViews.includes('appendFactRow(panel, "日期"') && !androidDetailViews.includes('appendFactRow(panel, "时长"') && !androidDetailViews.includes('appendFactRow(panel, "评分"'), "Android work facts must consolidate primary metrics instead of repeating them as full rows");
assert(!androidDetailViews.includes('appendFactRow(panel, "演员"') && !androidDetailViews.includes("options.actorLinks") && !androidSectionStyles.includes(".work-fact-chip.linked"), "Android work details must not repeat actors as metadata chips before the portrait cards");
const androidWorkActorPanelAppend = androidDetailViews.indexOf("if (personPanel) els.viewContent.append(personPanel)");
const androidWorkPreviewPanelAppend = androidDetailViews.indexOf("if (previewPanel) els.viewContent.append(previewPanel)");
assert(androidWorkActorPanelAppend >= 0 && androidWorkPreviewPanelAppend > androidWorkActorPanelAppend, "Android work details must place the navigable actor portraits before secondary preview media");
assert(androidSectionStyles.includes(".work-facts-highlights") && androidSectionStyles.includes("background: var(--surface-soft)"), "Android consolidated work facts must remain visually grouped at the start of the metadata panel");
assert(androidDetailViews.includes("strip.dataset.count = String(items.length)") && androidSectionStyles.includes('.work-facts-highlights[data-count="4"]') && androidSectionStyles.includes("grid-template-columns: repeat(2, minmax(0, 1fr))"), "Android four-metric work summaries must use a readable two-by-two grid instead of truncating dates and ratings");
assert(androidDetailViews.includes("createWorkDetailToolbar({") && androidDetailViews.includes("factsTarget: factPanel || fallbackInfoPanel") && !androidDetailViews.includes("createRelatedWorksPanel") && !androidDetailViews.includes("loadRelatedWorks"), "Android work details must keep playback and facts navigation without loading a trailing same-actor work shelf");
assert(androidWorkDetailToolbar.includes('createToolbarButton("播放"') && androidWorkDetailToolbar.includes('createToolbarButton("资料"') && !androidWorkDetailToolbar.includes('createToolbarButton("相关"') && /\.work-detail-toolbar\s*\{[\s\S]*?grid-template-columns: repeat\(2/.test(androidFanhaoStyles), "Android work details must use a balanced two-action contextual toolbar after removing related works");
assert(androidWorkDetailToolbar.includes('behavior: "smooth"') && androidWorkDetailToolbar.includes("playStatus(videos.length, progress)"), "Android work detail actions must reveal their target sections and expose playback state");
assert(lines("android-client/www/modules/fanhao/features/works/detail-toolbar.js") <= 90, "Android work-detail toolbar must stay focused");
assert(androidWorkActions.includes("actions.append(markerButton, favoriteButton, moreButton)") && !androidWorkActions.includes("actions.append(backButton") && !androidWorkActions.includes("actions.append(markerButton, favoriteButton, deleteButton"), "Android work details must reserve the main action row for common non-destructive actions");
assert(androidWorkActions.includes('title: "更多操作"') && androidWorkActions.includes('label: "复制番号"') && androidWorkActions.includes('label: "打开资料来源"') && androidWorkActions.includes('label: "删除本地文件"'), "Android work details must move utility and destructive actions into the shared more sheet");
assert(androidWorkActions.includes('variant: "danger wide"') && androidFanhaoStyles.includes(".fanhao-sort-option.danger") && androidFanhaoStyles.includes(".fanhao-sort-option.wide"), "Android destructive work actions must remain visually isolated in the sheet");
assert(!androidWorkActions.includes("createBackButton") && androidSectionStyles.includes(".work-detail-meta-body"), "Android work details must delegate return navigation to the shared sticky detail header");
assert(lines("android-client/www/modules/fanhao/features/works/actions.js") <= 190, "Android work actions must stay focused");
assert(androidIndexHtml.includes("styles.css?v=20260731-novel-actions-ui-53") && androidStyles.includes("css/base.css?v=20260730-mobile-search-ui-41") && androidStyles.includes("css/sections.css?v=20260730-auto-update-ui-50") && androidStyles.includes("css/lists.css?v=20260730-fanhao-cover-ui-43") && androidStyles.includes("modules/fanhao/styles.css?v=20260730-fanhao-work-detail-ui-46") && androidStyles.includes("modules/tools/styles.css?v=20260730-auto-update-ui-50") && androidStyles.includes("modules/novels/styles.css?v=20260731-novel-actions-ui-53") && androidStyles.includes("modules/music/home.css?v=20260730-music-palette-ui-42") && androidStyles.includes("modules/short-videos/styles.css?v=20260730-mobile-search-ui-41"), "Android mobile modules must refresh the shared search, cover, accent, work-detail, actor-card, tools-dashboard, novel shelf, and update style chain");
assert(androidBaseStyles.includes("--mobile-accent: #2f80ed") && androidBaseStyles.includes(".photo-chrome-tabs button.active") && androidBaseStyles.includes("background: var(--mobile-accent)") && androidFanhaoStyles.includes("border-color: var(--mobile-accent-border)") && androidShortVideoListStyles.includes(".short-video-search-page-field:focus-within") && androidShortVideoListStyles.includes("color: var(--mobile-accent)") && androidNovelStyles.includes('.novel-mobile-controls input[type="search"]:focus') && androidNovelStyles.includes("box-shadow: 0 0 0 3px var(--mobile-focus-ring)") && androidMusicHomeStyles.includes("caret-color: var(--mobile-accent)") && androidListStyles.includes(".work-cover-badge.progress") && androidListStyles.includes("background: var(--mobile-accent)"), "Android generic navigation, search focus, filters, and progress surfaces must share the blue-gray accent contract");
assert(/\.work-cover-frame > \.work-thumb,[\s\S]*?\.work-cover-frame > img\s*\{[\s\S]*?object-fit: cover;[\s\S]*?object-position: right center;/.test(androidListStyles), "Android FanHao work-grid covers must crop from the right so composite back-front artwork keeps the portrait front cover visible");
assert(androidIndexHtml.includes("app.js?v=20260731-novel-actions-ui-53") && androidApp.includes("config.js?v=20260731-novel-actions-ui-53") && androidApp.includes("cache.js?v=20260731-novel-actions-ui-53") && androidApp.includes("dom.js?v=20260731-novel-actions-ui-53") && androidCacheSource.includes("config.js?v=20260731-novel-actions-ui-53") && androidConfig.includes('CLIENT_VERSION = "20260731-novel-actions-ui-53"'), "Android novel shelf changes must refresh the complete application cache chain");
assert(androidToolModule.includes('tool-views.js?v=20260730-auto-update-ui-50'), "Android tools dashboard must use a fresh view module URL");
assert(androidToolViews.includes('section.className = "tools-dashboard"') && androidToolViews.includes('title.textContent = "小游戏"') && androidToolViews.includes('meta.textContent = "离线可用"'), "Android My page must focus on the compact offline game dashboard");
assert(!androidToolViews.includes("createTextWorkspace") && !androidToolViews.includes("文本整理") && !androidToolViews.includes("/api/tools/txt-format") && !androidToolStyles.includes("txt-native"), "Android My page must remove the complete text-formatting surface instead of only hiding its file picker");
assert(/\.tool-launch-grid\s*\{[\s\S]*?grid-template-columns: repeat\(2/.test(androidToolStyles) && androidToolStyles.includes(".tools-section-head"), "Android My page must keep its compact two-game grid");
assert(androidIndexHtml.includes('id="appUpdateButton"') && !androidIndexHtml.includes('id="checkAppUpdateButton"') && !androidIndexHtml.includes('id="installAppUpdateButton"'), "Android settings must expose exactly one application-update button");
assert(androidApp.includes("void checkAndroidUpdate({ silent: true });") && androidApp.includes("async function handleAndroidUpdateAction()") && androidApp.includes('els.appUpdateButton.textContent = "立即更新"') && androidApp.includes('els.appUpdateButton.textContent = "已是最新版本"'), "Android updates must check automatically and reuse one state-aware action button");
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
assert(!androidRankingViews.includes('stats.className = "ranking-stats"') && !androidRankingViews.includes('className = "ranking-chip-strip"') && androidRankingViews.includes("compactRankingLabel(item)"), "Android rankings must remove repeated metric cards and the duplicate inline year strip");
assert(androidFanhaoChrome.includes('title: "选择榜单年代"') && androidFanhaoChrome.includes('menuLabel: "年代"') && androidFanhaoChrome.includes("showValue: true") && androidWorkViews.includes("getRankingMenu: rankingViews.getYearMenu"), "the active ranking tab must expose its selected year and open the year picker instead of the generic work-sort sheet");
assert(androidRankingViews.includes("const rankingDataByKey = new Map()") && androidRankingViews.includes("const RANKING_WARM_LIMIT = 4") && androidRankingViews.includes("warmed >= RANKING_WARM_LIMIT") && androidRankingViews.includes('els.viewContent.setAttribute("aria-busy", "true")') && androidRankingViews.includes("void loadRankingYear(key, previousKey)"), "Android ranking year changes must preserve the current page while reusing a bounded set of prewarmed adjacent years");
assert(androidSectionStyles.includes('.content-panel[data-view="rankings"] > .view-meta') && !androidSectionStyles.includes(".ranking-stats div"), "Android rankings must keep only the compact metadata summary above the work grid");
assert(androidWorkViews.includes("renderOptions.hasServerMore"), "Android work rendering must expose server-side continuation");
assert.equal(new URL(workCollectionPath("history", { limit: 48 }), "http://127.0.0.1").searchParams.get("limit"), "48", "Android history must request a bounded first page");
assert(androidWorkViews.includes("const works = data.works || []"), "Android collections must define their rendered work list locally");
assert(androidWorkViews.includes("createWorkPageDataService") && androidWorkViews.includes("warmPrimaryCollections(activeUrl)") && androidWorkViews.includes("historyPath(getWorksLimit())"), "Android home must warm the remaining history page before navigation");
assert(!androidWorkViews.includes("warmCatalogSibling") && androidWorkPageDataService.includes("const inflight = new Map()"), "removing the standalone VR page must also remove its sibling prewarm request");
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
assert((androidDetailViews.match(/pageDataService\.load\(activeUrl, path/g) || []).length >= 1 && androidFanhaoModule.includes("pageDataService: workViews.pageDataService"), "Android person detail navigation must retain the shared cache/network race after removing related works");
assert(!androidDetailViews.includes("await readCachedJson(activeUrl, path)") && !androidDetailViews.includes("fetchJson(activeUrl, path"), "Android detail views must not wait for IndexedDB before starting their live request");
assert(androidWorkViews.includes('cards.js?v=20260721-fanhao-person-work-grid-20') && androidWorkCards.includes('card-presentation.js?v=20260721-fanhao-author-sort-density-08'), "Android actor work-grid changes must refresh cards without dropping the shared presentation rules");
assert((androidWorkViews.match(/pageDataService\.load\(activeUrl, path/g) || []).length >= 5 && androidWorkPageDataService.includes("Promise.race([freshRequest, cacheRequest])"), "remaining Android FanHao pages must race IndexedDB with the live response");
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
const androidPersonDetailHero = read("android-client/www/modules/fanhao/features/people/detail-hero.js");
assert(androidDetailViews.includes("getWorksLimit()"), "Android person details must use the bounded shared work limit");
assert(androidDetailViews.includes("hasServerMore:"), "Android person details must preserve server-side continuation");
assert(!androidDetailViews.includes("limit=2000"), "Android person details must not fetch every work before first render");
assert(androidDetailViews.includes("renderPersonPreview(indexedPerson)") && androidDetailViews.includes("正在加载作品"), "Android person navigation must paint the local index before the network request completes");
assert(androidDetailViews.includes("works.map((work) => imageUrlForWork(work)).find(Boolean)"), "Android person details must reuse the prepared work page for fallback artwork");
assert(androidDetailViews.includes('detail-hero.js?v=20260721-fanhao-person-categories-21'), "Android actor category summaries must use a fresh detail-hero URL");
assert(androidDetailViews.includes("hidePerson: true") && androidDetailViews.includes('createDetailSectionTitle("作品", "")'), "Android author pages must show works without repeating the author or a second work count");
assert(androidDetailViews.includes("hideControls: true") && androidDetailViews.includes("createPersonDetailWorkToolbar({"), "Android author pages must replace the wide chip strip with compact detail controls");
assert(androidPersonDetailWorkToolbar.includes('title: "作品筛选"') && androidPersonDetailWorkToolbar.includes('title: "发行年份"') && androidPersonDetailWorkToolbar.includes('title: "作品排序"') && androidPersonDetailWorkToolbar.includes("openFanhaoSheet({"), "Android actor work controls must open shared bottom sheets for filtering, year, and sorting");
assert(androidPersonDetailWorkToolbar.includes("activeFilterLabel") && androidPersonDetailWorkToolbar.includes("formatNumber(option.count || 0)"), "Android author filter controls must expose the active state and available counts");
assert(androidPersonDetailWorkToolbar.includes('createToolbarButton("年份"') && androidDetailViews.includes("onYearChange: (value) => setPersonWorkYear(personId, value)"), "Android actor details must expose and apply the release-year selection");
assert(androidFanhaoModule.includes("getWorkFilterOptions: workViews.getWorkFilterOptions") && androidFanhaoModule.includes('setWorkSortMode: (value) => workViews.setSortMode("works", value)'), "Android author detail controls must reuse the authoritative work-list state");
assert(androidWorkViews.includes("if (renderOptions.hideControls !== true)") && androidWorkViews.includes("getWorkFilterOptions: (works, facets)"), "Android work rendering must allow details to replace catalog controls without duplicating filter logic");
assert(androidDetailViews.includes("categories: data.categories") && androidDetailViews.includes("filmographyCount: data.filmographyCount") && androidPersonDetailHero.includes('workCountPrefix.textContent = filmographyCount === null ? "本地收录" : "出演过"') && androidPersonDetailHero.includes('filmographyCount === null ? "部作品" : "部影片"'), "Android actor details must distinguish indexed local works from the complete filmography");
assert(androidPersonDetailHero.includes('strip.className = "person-category-strip"') && androidPersonDetailHero.includes('strip.setAttribute("aria-label", "作品分类")') && androidPersonDetailHero.includes("formatNumber(category.count)") && androidSectionStyles.includes(".person-category-chip"), "Android actor identities must show compact authoritative category totals");
assert(!androidPersonDetailHero.includes("normalizePersonSource") && !androidPersonDetailHero.includes("珍藏1") && !androidSectionStyles.includes(".person-source-chip"), "Android actor identities must not expose disk roots or retired source labels as content categories");
assert(!androidPersonDetailHero.includes("createPersonFacts") && !androidPersonDetailHero.includes("个视频") && !androidPersonDetailHero.includes("份资料"), "Android actor identity must not repeat competing work-related counts");
assert(androidPeopleViews.includes('label: "本地作品"') && androidPeopleViews.includes('label: "多来源"') && !androidPeopleViews.includes('meta.textContent = `本地 ${formatNumber(person.workCount)} 部'), "Android actor indexes may sort by library metrics without rendering those metrics on identity cards");
assert(androidPersonDetailHero.includes("codex(?:smoke)?alias"), "Android author identity must hide stale smoke-test aliases");
assert(androidPeopleViews.includes("portraitUrlForPerson(person)") && androidPersonDetailHero.includes("portraitUrlForPerson(person)"), "Android author indexes and details must share portrait-only image selection");
assert(androidSectionStyles.includes(".person-detail-avatar-frame > img") && androidSectionStyles.includes("aspect-ratio: 4 / 3 !important") && androidSectionStyles.includes("object-fit: contain"), "Android author avatars must match the detail frame instead of overflowing at their intrinsic ratio");
assert(androidSectionStyles.includes("aspect-ratio: 4 / 5 !important") && androidSectionStyles.includes(".index-person-card .person-cover") && androidSectionStyles.includes("object-fit: cover") && androidSectionStyles.includes("object-position: center 18%"), "Android author index portraits must use a uniform face-focused crop");
assert(androidApp.includes('classList.toggle("fanhao-person-detail-view", currentView === "personDetail")') && androidFanhaoStyles.includes("body.fanhao-person-detail-view .bottom-nav"), "Android author details must hide the unrelated global bottom navigation");
assert(androidFanhaoStyles.includes(".person-detail-work-toolbar") && androidFanhaoStyles.includes("grid-template-columns: repeat(3") && /\.content-panel\[data-view="personDetail"\] \.work-list\.cover-grid\s*\{[\s\S]*?grid-template-columns: repeat\(3/.test(androidListStyles) && /\.content-panel\[data-view="personDetail"\] \.work-cover-frame > img\s*\{[\s\S]*?object-fit: contain/.test(androidListStyles) && androidListStyles.includes("aspect-ratio: 16 / 10") && androidListStyles.includes('.work-cover-badge.playable'), "Android actor details must use a fixed filter-year-sort toolbar and a three-column complete-cover work grid");
assert(androidApp.includes('classList.toggle("fanhao-work-detail-view", currentView === "workDetail")') && androidFanhaoStyles.includes("body.fanhao-work-detail-view .bottom-nav") && androidFanhaoStyles.includes(".work-detail-toolbar"), "Android work details must hide the unrelated global navigation and provide a contextual fixed toolbar");
assert(androidSectionStyles.includes('.content-panel[data-view="workDetail"] .work-detail-hero') && androidSectionStyles.includes("background: transparent") && androidSectionStyles.includes("scroll-margin-top"), "Android work details must use an immersive borderless hero and unobscured section jumps");
assert(androidApp.includes('"people", "personDetail", "history"') && androidSectionStyles.includes('.content-panel[data-feed-view="true"] .section-head'), "Android author details must use the immersive feed surface without a duplicate page heading");
assert(androidPersonDetailHero.includes("body.append(name, alias, workCount)") && !androidPersonDetailHero.includes("person-detail-eyebrow") && !androidPersonDetailHero.includes("person-detail-back"), "Android author identity must keep one compact summary without repeated labels or return controls");
assert(!androidPersonDetailHero.includes("cacheNote") && !androidPersonDetailHero.includes("正在同步详情") && !androidPersonDetailHero.includes("本地索引"), "Android author identity must not expose cache implementation status as profile information");
assert(androidDetailViews.includes("setDetailChromeTitle") && androidDetailViews.includes('[data-fanhao-detail-title]') && androidDetailViews.includes("person.actorProfile?.displayName || person.name"), "Android author and work details must update the shared sticky header with live identity data");
assert(androidSectionStyles.includes("grid-template-columns: clamp(104px, 32%, 128px)") && androidSectionStyles.includes(".person-detail-hero .detail-hero-body"), "Android author identity must leave first-screen space for the work grid");
assert(lines("android-client/www/modules/fanhao/features/people/detail-hero.js") <= 150, "Android author identity component must stay focused");
assert(lines("android-client/www/modules/fanhao/features/people/detail-work-toolbar.js") <= 110, "Android author work toolbar must stay focused");
assert(androidFanhaoIndex.includes('detail-views.js?v=20260730-fanhao-work-detail-ui-46') && androidDetailViews.includes('android-player.js?v=20260721-fanhao-media-relocate-16') && androidDetailViews.includes('detail-toolbar.js?v=20260730-fanhao-work-detail-ui-46'), "Android work-detail cleanup must refresh without dropping media recovery or the contextual toolbar");
assert(androidWorkViews.includes('page-data-service.js?v=20260717-fanhao-page-race-01') && androidWorkViews.includes('detail-data-service.js?v=20260717-fanhao-touch-intent-01'), "Android page-race service and gesture-aware intent changes must retain fresh module URLs");
assert(androidFanhaoIndex.includes('work-views.js?v=20260730-fanhao-ranking-year-ui-45') && androidWorkViews.includes('cache.js?v=20260721-fanhao-actor-counts-17') && androidWorkViews.includes('work-filtering.js?v=20260726-work-sort-01') && androidWorkViews.includes('search-page.js?v=20260721-fanhao-search-suggestions-19'), "Android ranking year switching must refresh work views without dropping search suggestions, actor-count caching, or dense browsing");
assert(androidFanhaoIndex.includes('people-views.js?v=20260730-fanhao-people-card-ui-47'), "Android actor-card cleanup must use the current people module URL");
assert(androidFanhaoModule.includes('chrome.js?v=20260730-fanhao-ranking-year-ui-45') && androidFanhaoModule.includes('index.js?v=20260730-fanhao-people-card-ui-47') && androidFanhaoModule.includes('prefix-views.js?v=20260730-fanhao-nav-ui-44'), "Android actor-card cleanup must refresh its view entry without dropping ranking or brand browsing");
assert(androidIndexHtml.includes('app.js?v=20260731-novel-actions-ui-53'), "Android novel shelf cleanup must refresh the app entry chain");
assert(androidPlayerSource.includes("mount.append(createPlayerErrorBox(error.message") && androidPlayerSource.includes("retry: () => playVideo"), "Android playback preparation failures must stay on the detail page with a retry action instead of opening a broken native player");
assert(androidWorkViews.includes('ranking-views.js?v=20260730-fanhao-ranking-year-ui-45'), "Android smooth ranking year changes must use a fresh module URL");
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
const loadMoreCodePrefixIndexSource = /function loadMoreIndex\(\)\s*\{([\s\S]*?)\n  \}/.exec(codePrefixPageSource)?.[1] || "";
const loadMoreCodePrefixDetailSource = /async function loadMore\(button\)\s*\{([\s\S]*?)\n  \}/.exec(codePrefixPageSource)?.[1] || "";
assert(loadMoreCodePrefixIndexSource.includes("body.append(fragment)") && loadMoreCodePrefixIndexSource.includes("appendIndexLoadMore(end, prefixes.length)"), "code-prefix index pagination must append rows without replacing the table");
assert(!loadMoreCodePrefixIndexSource.includes("els.workGrid.innerHTML"), "code-prefix index pagination must not clear the full grid");
assert(loadMoreCodePrefixDetailSource.includes("appendLoadedWorkPage();") && !loadMoreCodePrefixDetailSource.includes("renderWorks("), "code-prefix detail pagination must append the next server page without replacing the work grid");
const appendLoadMoreSource = /function appendLoadMore\([\s\S]*?\n\}/.exec(webApp)?.[0] || "";
assert(appendLoadMoreSource.includes("state.workVisibleLimit += state.workPageSize;\n      appendLoadedWorkPage();"), "client-side work pagination must append the next visible page without replacing the work grid");
assert((webApp.match(/appendLoadedWorkPage\(\);/g) || []).length >= 2, "search and person pagination must append the next server page without resetting scroll position");
assert(webApp.includes("function appendLoadedWorkPage()") && webApp.includes("appendWorkCardsInPlace({"), "shared work pagination must reconcile each next page without clearing the grid");
assert(workPageAppenderSource.includes("container.insertBefore(card, reference)") && workPageAppenderSource.includes("restoreScrollAnchor(anchor, anchorTop, viewport)"), "reordered work pages must reuse cards and preserve the visible scroll anchor");
assert(lines("public/modules/fanhao/features/works/work-page-appender.js") <= 120, "in-place work pagination must stay focused");
assert(peoplePage.includes("const PERSON_INDEX_DESKTOP_PAGE_SIZE = 64"), "Web people index must keep the desktop first page compact");
assert(peoplePage.includes("const PERSON_INDEX_MOBILE_PAGE_SIZE = 48"), "Web people index must keep the mobile first page compact");
assert(webApp.includes("state.personPageSize = peoplePage.personIndexPageSize()"), "Web people paging must adapt to the viewport instead of network location");
const fanhaoStyles = read("public/modules/fanhao/styles.css");
const rootStyles = read("public/styles.css");
const personCardStyles = /\.person-index-card\s*\{([\s\S]*?)\n\}/.exec(fanhaoStyles)?.[1] || "";
assert(!personCardStyles.includes("content-visibility"), "people cards must not flash in while scrolling");
assert(rootStyles.includes('modules/fanhao/styles.css?v=20260724-code-prefix-catalog-01'), "FanHao style changes must use a fresh browser cache key");
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
assert((webCollectionPage.match(/if \(append\) appendLoadedWorkPage\(\);/g) || []).length === 3, "favorite, history, and VR pagination must append without replacing the work grid");
assert(webApp.includes("hasCollectionServerMore"), "Web work rendering must expose collection continuation");
assert(webCollectionPage.includes("loadMoreVrWorks"), "Web VR lists must preserve server-side continuation");
assert(!webCollectionPage.includes('limit: "2000"'), "Web VR lists must not fetch thousands of works before first render");
assert(webApp.includes("hasVrServerMore"), "Web work rendering must expose VR continuation");
assert(webRankingPage.includes("if (options.append) appendLoadedWorkPage();"), "ranking pagination must append without replacing the work grid");
assert(studioPageSource.includes("if (append) appendLoadedWorkPage();"), "studio pagination must append without replacing the work grid");
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
assert(rankingServiceSource.includes("function uniqueRankingRows(items = [])") && rankingServiceSource.includes("const rankingRows = uniqueRankingRows(getCoreDb()") && rankingServiceSource.includes("COUNT(DISTINCT ci.work_id)"), "ranking summaries and pages must ignore duplicate collection memberships");
assert(rankingServiceSource.includes("const RANKING_PREWARM_PAGE_SIZE = 64"), "ranking startup must prepare the desktop first page");
assert(rankingServiceSource.includes("rankingWorkSourcesCache.get(cacheKey)"), "ranking pages must reuse prepared local and missing work sources");
assert(rankingServiceSource.includes("const RANKING_PAGE_CACHE_LIMIT = 64") && rankingServiceSource.includes("userStateStamp()"), "ranking pages must cache complete responses until ranking or user state changes");
assert(rankingServiceSource.includes("const orderedLists = [preferred, ...topLists.filter"), "ranking startup must prepare the default list first");
assert(rankingServiceSource.includes("const source = preparedWorkSource(list.type, list.key)"), "ranking startup must prepare every selectable list source");
assert(rankingServiceSource.includes("prewarmCoreWorkCovers(pageWorks)") && rankingServiceSource.includes("prewarmWorkInfoDetails(pageWorks)"), "ranking startup must batch visible metadata across selectable lists");
assert(catalogRuntimeSource.includes("deps.rankingService.prewarm();"), "ranking summaries and selectable list sources must be ready before first navigation");
assert(personDetailServiceSource.includes("const detailSourceCache = new Map()"), "person navigation must reuse prepared detail sources");
assert(personDetailServiceSource.includes("peoplePayloadStamp(scope)}:${workQueryStamp()"), "person detail sources must follow people and work data versions");
assert(personDetailServiceSource.includes("workQueryService.lightweightFacets(yearWorks)"), "person facets must remain live inside the selected year without hydrating detail-only metadata");
assert(personDetailServiceSource.includes("filmographyCount: source.works.length"), "person details must expose a stable full-filmography count independent of paging and filters");
assert(personDetailServiceSource.includes("categories: workQueryService.categorySummaryForWorks(allPersonWorks)") && personDetailServiceSource.includes("categories: source.categories"), "person details must classify the complete filmography once and reuse those category totals on every page");
const workInfoServiceSource = read("src/modules/fanhao/server/works/work-info-service.js");
const workQueryServiceSource = read("src/modules/fanhao/server/works/work-query-service.js");
const workClassificationServiceSource = read("src/modules/fanhao/server/works/work-classification-service.js");
const workFilterServiceSource = read("src/modules/fanhao/server/works/work-filter-service.js");
const workCodeIndexServiceSource = read("src/modules/fanhao/server/works/work-code-index-service.js");
const workSearchIndexServiceSource = read("src/modules/fanhao/server/works/work-search-index-service.js");
assert(workInfoServiceSource.includes("prewarmDetailRows(workIds"), "work-info details must support page-level batch hydration");
assert(workQueryServiceSource.includes('normalizeWorkCategory(url.searchParams.get("category"))') && workQueryServiceSource.includes("categorySummaryItems(stamp)"), "work list responses must carry the selected category and all four category counts");
assert(workQueryServiceSource.includes("categorySummaryForWorks") && workQueryServiceSource.includes("summarizeWorkCategories(works"), "actor filmographies must reuse the authoritative work category classifier");
assert(workQueryServiceSource.includes('const pageCacheKey = `${scope}:${category}:${filter}:${sort}:${limit}:${offset}`') && workQueryServiceSource.includes("categorySourcesCache?.stamp === stamp"), "category work pages and source partitions must use versioned bounded caches");
assert(workQueryServiceSource.includes("classifyWorkCategory(work, { isWestern: peopleScopeService.workMatches(work, \"western\") })"), "western-root membership must feed the shared work category classifier");
assert(personDetailServiceSource.includes("{ lightweightInfo: true }") && workQueryServiceSource.includes("lightweightFacets: lightweightWorkFacets"), "person first pages must reuse the lightweight work-list path");
assert(peoplePageSource.includes('includeMissingLocal: state.showMissingLocalWorks ? "1" : "0"') && peoplePageSource.includes('includeCompilation: state.showCompilationWorks ? "1" : "0"'), "person requests must send server-side missing-local and compilation visibility");
assert(workQueryServiceSource.includes("workClassificationService.filterForRequest(sourceWorks, url, filter)") && workQueryServiceSource.indexOf("filterForRequest(sourceWorks, url, filter)") < workQueryServiceSource.indexOf("sortWorkList(matchedWorks"), "person visibility must be filtered on the server before sorting and pagination");
assert(workQueryServiceSource.includes("filters.every((item) => matchesFilter(work, item))"), "server work queries must apply combined filter chips before pagination");
assert(studioService.indexOf("cachedFilteredStudioWorks(workSet, filter)") < studioService.indexOf("sortWorkList(filteredWorkSet.works, sort)"), "studio filters must run before sorting and pagination");
assert(studioService.includes("detailPageCacheKey(makerId, selectedSeriesId, filter, sort, url)"), "studio page caches must distinguish active server filters");
assert(workFilterServiceSource.includes("requested.every((item) => matches(work, item))") && lines("src/modules/fanhao/server/works/work-filter-service.js") <= 100, "shared server work filtering must support compact combined-filter semantics");
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
assert(workQueryServiceSource.includes("source.facetsStamp !== stamp") && workQueryServiceSource.includes("source.facetsByCategory.clear()"), "search category facets must only refresh after user state changes");
assert(workQueryServiceSource.includes("cachedSearchCategory(source, category)") && workQueryServiceSource.includes("categories: categorySummaryForWorks(source.works)") && workQueryServiceSource.includes("[rawQuery, category, filter, sort, limit, offset]"), "search responses must filter and cache by the selected work category while retaining all category counts");
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
for (const source of [server, workQueryServiceSource]) {
  assert(source.includes("displayWorkTitle(a.title || a.directoryName)") && source.includes('if (sort === "title") return titleResult;') && source.includes('if (sort === "progress")') && source.includes('if (sort === "videos")'), "server work sorting must cover every Android collection sort mode using displayed titles");
}
assert(workQueryServiceSource.includes('sort === "progress" ? `${currentStamp()}:${userStateStamp()}`'), "progress-sorted work caches must follow playback state changes");
assert(workFilterServiceSource.includes("if (!missingLocal && !work.coverId && !workHasCoreCover(work.id))"), "catalog facets must use the compact core-cover index");
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
assert(fanhaoRuntime.includes('process.env.FANHAO_EAGER_PREWARM !== "1"'), "full-library response prewarming must be opt-in so the HTTP port can open promptly");
assert(fanhaoRuntime.includes("library.start();"), "opt-in FanHao prewarming must retain the library response path");
assert(fanhaoRuntime.includes("catalog.start();"), "opt-in FanHao prewarming must retain the catalog response path");
assert(fanhaoRuntime.includes("userState.start();"), "opt-in FanHao prewarming must retain user collection response paths");
assert(userStateRuntime.includes("createCollectionQueryService(deps)") && userStateRuntime.includes("collectionQueryService.prewarm()"), "collection startup must delegate complete response preparation to one query service");
assert(collectionQueryServiceSource.includes("const COLLECTION_PREWARM_PAGE_SIZES = [8, 48, 64]"), "collection startup must prepare preview, phone, and desktop response sizes");
assert(collectionQueryServiceSource.includes("[0, 7, Number(recentWatchedDays || 0)]"), "collection startup must prepare all-time, seven-day, and default history ranges");
assert(collectionQueryServiceSource.includes("const COLLECTION_PAGE_CACHE_LIMIT = 64") && collectionQueryServiceSource.includes("userStateStamp()") && collectionQueryServiceSource.includes("workQueryStamp()"), "collection responses must stay cached until catalog or user state changes");
assert(collectionQueryServiceSource.indexOf("filterWorkList(source, filter)") < collectionQueryServiceSource.indexOf("sortWorkList(filtered, sort)"), "collection filters must run before sorting and pagination");
assert(collectionQueryServiceSource.includes('favorites:${selectedFolderId || "all"}:${filter}:${sort}:${limit}:${offset}') && collectionQueryServiceSource.includes("history:${days}:${filter}:${sort}:${limit}:${offset}"), "collection page caches must distinguish active filters and sorts");
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
assert.equal((collectionQueryServiceSource.match(/queried\.works\.slice\(offset, offset \+ limit\)/g) || []).length, 2, "favorites and history must paginate their fully queried collections before presenting work details");
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
const sortWorks = [
  { id: "audience", title: "Audience", infoSummary: { rating: 4, ratingCount: 100 } },
  { id: "popular", title: "Popular", infoSummary: { rating: 4.9, ratingCount: 90 } },
  { id: "small", title: "Small", infoSummary: { rating: 5, ratingCount: 80 } }
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
assert.deepEqual(
  selectVisibleWorks(sortWorks, { showCompilationWorks: true, showMissingLocalWorks: true, sortMode: "ratingCountDesc" }).map((work) => work.id),
  ["audience", "popular", "small"],
  "Web rating-count sorting must order by audience size"
);
assert.deepEqual(
  selectVisibleWorks(sortWorks, { showCompilationWorks: true, showMissingLocalWorks: true, sortMode: "popularityDesc" }).map((work) => work.id),
  ["popular", "audience", "small"],
  "Web popularity sorting must order by rating multiplied by audience size"
);
const sortMetadata = sortWorks.map((work) => ({ id: work.id, ...work.infoSummary }));
assert.deepEqual([...sortMetadata].sort(compareRatingCountMetadata).map((item) => item.id), ["audience", "popular", "small"], "server rating-count sorting must match the clients");
assert.deepEqual([...sortMetadata].sort(comparePopularityMetadata).map((item) => item.id), ["popular", "audience", "small"], "server popularity sorting must match the clients");

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
}, { isWestern: true });
assert.equal(personListItem.avatarUrl, "/media/person/27/cover", "person-list fallback covers must not expose long file identifiers");
assert.equal(personListItem.actorProfile.displayName, "Display Person", "person-list summaries must preserve display names");
assert.equal(personListItem.isWestern, true, "person-list summaries must expose Western membership for Android actor discovery");
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
const collectionQueryWorks = [
  { id: "collection-low", rating: 3.5 },
  { id: "collection-high-a", rating: 4.2 },
  { id: "collection-high-b", rating: 4.8 }
];
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
  filterWorkList(works, filter) {
    return filter === "highRating" ? works.filter((work) => work.rating >= 4) : works;
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
  sortWorkList(works, sort) {
    return sort === "ratingDesc" ? [...works].sort((a, b) => b.rating - a.rating) : works;
  },
  userStateStamp: () => collectionQueryStateStamp,
  workFacets: (works) => ({ all: works.length, highRating: works.filter((work) => work.rating >= 4).length }),
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
const filteredCollectionPage = cachedCollectionQueryService.historyPayload(new URL("http://127.0.0.1/api/history?filter=highRating&sort=ratingDesc&limit=1&offset=0"));
assert.equal(filteredCollectionPage.total, 2, "collection totals must describe the complete server-filtered result");
assert.equal(filteredCollectionPage.works[0].id, "collection-high-b", "collection filters and sorts must run before page slicing");
assert.deepEqual(filteredCollectionPage.facets, { all: 3, highRating: 2 }, "collection filter chips must describe the complete source collection");
assert.equal(filteredCollectionPage.filter, "highRating", "collection responses must echo the active filter");
assert.equal(filteredCollectionPage.sort, "ratingDesc", "collection responses must echo the active sort");
assert.equal(collectionQueryPublicWorkCount, 7, "filtered collection pages must reuse prepared works and present only newly visible entries");
assert.equal(cachedCollectionQueryService.historyPayload(new URL("http://127.0.0.1/api/history?filter=highRating&sort=ratingDesc&limit=1&offset=0")), filteredCollectionPage, "identical filtered collection requests must reuse their complete response");

let personDetailDataStamp = "person-v1";
let personDetailUserStateStamp = "user-v1";
let personDetailSourceBuildCount = 0;
let personDetailFacetReadCount = 0;
let personDetailPayloadReadCount = 0;
let personDetailPayloadOptions = null;
const personDetailFixture = { id: "person-1", name: "Person One", works: ["work-1"] };
const personDetailLibrary = {
  scannedAt: "scan-v1",
  worksById: new Map([["work-1", { id: "work-1", personId: "person-1", title: "Work One", infoSummary: { releaseDate: "2024-01-01" } }]])
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
    categorySummaryForWorks(works) {
      return [
        { value: "censored", label: "有码", count: works.length },
        { value: "western", label: "欧美", count: 0 },
        { value: "fc2", label: "FC2", count: 0 },
        { value: "anime", label: "动漫", count: 0 }
      ];
    },
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
assert.equal(firstPersonDetail.filmographyCount, 1, "prepared person details must expose the complete deduplicated filmography count");
assert.deepEqual(firstPersonDetail.categories, [
  { value: "censored", label: "有码", count: 1 },
  { value: "western", label: "欧美", count: 0 },
  { value: "fc2", label: "FC2", count: 0 },
  { value: "anime", label: "动漫", count: 0 }
], "prepared person details must expose stable category totals for the full filmography");
assert.equal(repeatedPersonDetail.filter, "rated", "prepared person details must preserve per-request filters");
const yearFilteredPersonDetail = cachedPersonDetailService.detailPayload("person-1", new URL("http://127.0.0.1/api/people/person-1?filter=all&year=2025&limit=48&offset=0"));
assert.equal(yearFilteredPersonDetail.year, "2025", "person detail responses must echo the normalized selected year");
assert.equal(yearFilteredPersonDetail.total, 0, "person detail responses must filter works before facets and pagination");
assert.equal(yearFilteredPersonDetail.filmographyCount, 1, "person detail filmography counts must remain stable when the selected year has no works");
assert.deepEqual(yearFilteredPersonDetail.years, [
  { value: "all", label: "全部年份", count: 1 },
  { value: "2024", label: "2024 年", count: 1 }
], "person detail responses must retain year choices from the complete filmography");
personDetailUserStateStamp = "user-v2";
cachedPersonDetailService.detailPayload("person-1", personDetailUrl);
assert.equal(personDetailFacetReadCount, 4, "favorite and progress changes must invalidate prepared person facets");
assert.equal(personDetailPayloadReadCount, 4, "favorite and progress changes must invalidate prepared person pages");
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
const studioWorks = [
  { id: "studio-high-vr", coverId: "cover-1", infoCount: 1, infoSummary: { rating: 4.5 }, playableCount: 1, vr: true },
  { id: "studio-high", coverId: "cover-2", infoCount: 1, infoSummary: { rating: 4.2 }, playableCount: 1, vr: false },
  { id: "studio-low", coverId: "cover-3", infoCount: 1, infoSummary: { rating: 3.8 }, playableCount: 1, vr: true }
];
const studioWorksById = new Map(studioWorks.map((work) => [work.id, work]));
const studioWorkFilterService = createWorkFilterService({
  isVrWork: (work) => work.vr,
  workInfoFacetRow: () => null
});
assert.deepEqual(studioWorkFilterService.filter(studioWorks, "highRating,vr").map((work) => work.id), ["studio-high-vr"], "shared studio filtering must apply every active chip before paging");
assert.equal(studioWorkFilterService.facets(studioWorks).highRating, 2, "shared studio facets must retain the full maker filter counts");
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
          all(makerId) {
            studioWorksReadCount += 1;
            const ids = Number(makerId) === 1 ? studioWorks.map((work) => work.id) : [studioWorks[2].id];
            return ids.map((workId) => ({ work_id: workId }));
          }
        };
      }
      throw new Error(`unexpected studio query: ${sql.slice(0, 80)}`);
    }
  }),
  filterWorkList: studioWorkFilterService.filter,
  getLibrary: () => ({ worksById: studioWorksById }),
  getStamp: () => studioDataStamp,
  pagedWorksPayload: (works, _url, extra) => {
    studioPagePayloadCount += 1;
    return { ...extra, count: works.length, total: works.length, works };
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
  workFacets: studioWorkFilterService.facets
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
const filteredStudioPage = cachedStudioService.detailPayload("1", new URL("http://127.0.0.1/api/studios/1?seriesId=all&filter=highRating%2Cvr&sort=releaseDesc&limit=24"));
assert.equal(filteredStudioPage.total, 1, "studio details must filter the complete maker work set before pagination");
assert.equal(filteredStudioPage.filter, "highRating,vr", "studio detail payloads must expose the applied combined filter");
assert.equal(filteredStudioPage.facets.highRating, 2, "studio detail facets must continue describing the complete maker work set");
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
          if (sql.includes("COUNT(DISTINCT ci.work_id)")) {
            rankingSummaryReadCount += 1;
            return [{ collection_id: 1, list_label: "TOP250 2025", source_key: "top:y2025", total: 2, updated_at: "v1", page_url: "https://example.com/ranking" }];
          }
          if (sql.includes("SELECT w.code_search AS code_key")) {
            rankingSummaryCodesReadCount += 1;
            return [
              { work_id: 101, code: "ABC-001", code_key: "abc001" },
              { work_id: 101, code: "ABC-001", code_key: "abc001" },
              { work_id: 102, code: "DEF-002", code_key: "def002" }
            ];
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
assert.equal(cachedRankingService.summaries()[0]?.total, 2, "ranking summaries must count unique works instead of duplicate collection rows");
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
assert.equal(cachedRankingPayload.rankingTotal, 2, "ranking payloads must remove duplicate works before pagination");
assert.deepEqual(cachedRankingPayload.works.map((work) => work.ranking.rankNo), [1, 2], "ranking deduplication must preserve the first authoritative rank");
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
  peopleScopeService: { normalize: () => "main", workMatches: (_work, scope) => scope === "main" },
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
const workCategorySummary = workQueryService.categorySummaryPayload();
assert.deepEqual(workCategorySummary.categories.map(({ value, count }) => [value, count]), [["censored", 1], ["western", 0], ["fc2", 0], ["anime", 0]], "category summaries must partition every local work into exactly one requested category");
assert.deepEqual(workQueryService.categorySummaryForWorks([queryWork]).map(({ value, count }) => [value, count]), [["censored", 1], ["western", 0], ["fc2", 0], ["anime", 0]], "person category summaries must classify only the supplied filmography instead of leaking whole-library totals");
assert.deepEqual(preparedWorkCoverIds, [queryWork.id], "FanHao startup must prepare first-page VR cover metadata");
assert.deepEqual(preparedWorkInfoIds, [queryWork.id], "FanHao startup must prepare first-page VR detail metadata");
assert.deepEqual(preparedWorkVideoIds, [queryWork.id], "FanHao startup must queue first-page VR playback probes");
assert.equal(workInfoReadCount, 0, "FanHao startup prewarm must not hydrate full work-info facets before the server listens");
assert(workInfoFacetReadCount > 0 && workInfoFacetReadCount <= 8, "FanHao startup prewarm must use only bounded compact work-info lookups");
assert.equal(workListPublicCount, 1, "FanHao startup must prepare each visible work payload once across common list variants");
const censoredWorkPage = workQueryService.listPayload(new URL("http://127.0.0.1/api/works?category=censored&limit=24&sort=releaseDesc"));
assert.equal(censoredWorkPage.category, "censored", "category work pages must echo the active category");
assert.equal(censoredWorkPage.total, 1, "category work pages must filter before pagination");
assert.equal(censoredWorkPage.categories.length, 4, "category work pages must carry all category counts for the mobile selector");
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
const westernWorkSearch = workQueryService.searchPayload(new URL("http://127.0.0.1/api/search?q=AB&category=western&limit=24&sort=releaseDesc"));
assert.equal(westernWorkSearch.category, "western", "search responses must echo the active category for the mobile toolbar");
assert.equal(westernWorkSearch.total, 0, "search category filtering must happen before pagination");
assert.deepEqual(westernWorkSearch.categories.map(({ value, count }) => [value, count]), [["censored", 1], ["western", 0], ["fc2", 0], ["anime", 0]], "search responses must retain complete query-scoped category counts after filtering");
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
const relocatedIndexedLibraryVideo = { ...indexedLibraryVideo, path: "G:/renamed/library-video.mp4" };
const indexedGalleryVideo = { id: "gallery-video", path: "V:/gallery/gallery-video.mp4", type: "video" };
let preparedPlayback = null;
let detailMaterializations = 0;
let galleryPlayInfoLookups = 0;
let libraryPlayInfoLookups = 0;
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
  resolveVideoFileByPublicId: (videoId) => {
    libraryPlayInfoLookups += 1;
    return videoId === indexedLibraryVideo.id ? relocatedIndexedLibraryVideo : null;
  },
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
assert.equal(indexedLibraryPlayInfo.file, relocatedIndexedLibraryVideo, "FanHao play-info must use the validated or relocated library file path");
assert.equal(libraryPlayInfoLookups, 1, "FanHao play-info must validate the indexed media path exactly once");
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

const localReconcileDb = new DatabaseSync(":memory:");
try {
  localReconcileDb.exec(`
    CREATE TABLE local_works (
      id INTEGER PRIMARY KEY,
      work_id INTEGER NOT NULL,
      local_path TEXT
    );
    CREATE TABLE local_files (
      id INTEGER PRIMARY KEY,
      local_work_id INTEGER,
      file_path TEXT
    );
    INSERT INTO local_works (id, work_id, local_path) VALUES
      (1, 101, 'O:\\Person\\Gone'),
      (2, 102, 'O:\\Person'),
      (3, 103, 'O:\\Person'),
      (4, 103, 'V:\\Other\\Person');
    INSERT INTO local_files (id, local_work_id, file_path) VALUES
      (1, 1, 'O:\\Person\\Gone\\one.mp4'),
      (2, 2, 'O:\\Person\\two.mp4'),
      (3, 3, 'O:\\Person\\three.mp4'),
      (4, 4, 'V:\\Other\\Person\\three.mp4');
  `);
  const localReconcileService = createCoreLibrarySyncService({
    getCoreDb: () => localReconcileDb,
    hasCoreDb: () => true,
    sourcePathToAbsolute: (value) => value
  });
  const reconciliation = localReconcileService.reconcilePersonLocalWorks(
    [
      { id: "101", relativePath: "O:/Person/Gone" },
      { id: "102", relativePath: "O:/Person" },
      { id: "103", relativePath: "O:/Person" }
    ],
    [{ id: "102", relativePath: "o:/person" }]
  );
  assert.deepEqual(reconciliation.deletedWorkIds, ["101"], "person reconciliation must report only works with no remaining local copy");
  assert.deepEqual(
    localReconcileDb.prepare("SELECT id FROM local_works ORDER BY id").all().map((row) => Number(row.id)),
    [2, 4],
    "person reconciliation must remove only disappeared work/path pairs"
  );
  assert.deepEqual(
    localReconcileDb.prepare("SELECT id FROM local_files ORDER BY id").all().map((row) => Number(row.id)),
    [2, 4],
    "person reconciliation must clear file rows for disappeared local works"
  );
} finally {
  localReconcileDb.close();
}

const sharedIndexedFile = { id: "shared-video", type: "video", playable: true };
const removedUniqueFile = { id: "removed-video", type: "video", playable: true };
const keptUniqueFile = { id: "kept-video", type: "video", playable: true };
const incrementalWorks = [
  {
    id: "1",
    personId: "10",
    title: "First",
    coverId: null,
    videoCount: 2,
    playableCount: 2,
    imageCount: 0,
    infoCount: 0,
    videos: [{ ...sharedIndexedFile }, removedUniqueFile],
    images: [],
    infos: []
  },
  {
    id: "2",
    personId: "10",
    title: "Second",
    coverId: null,
    videoCount: 2,
    playableCount: 2,
    imageCount: 0,
    infoCount: 0,
    videos: [sharedIndexedFile, keptUniqueFile],
    images: [],
    infos: []
  }
];
const incrementalPerson = {
  id: "10",
  name: "Incremental Person",
  relativePath: "O:/Incremental Person",
  sourcePaths: ["O:/Incremental Person"],
  sourceCount: 1,
  workCount: 2,
  videoCount: 4,
  playableCount: 4,
  imageCount: 0,
  infoCount: 0,
  works: ["1", "2"]
};
const incrementalLibrary = {
  scannedAt: null,
  people: [incrementalPerson],
  peopleById: new Map([["10", incrementalPerson]]),
  worksById: new Map(incrementalWorks.map((work) => [work.id, work])),
  filesById: new Map([
    [sharedIndexedFile.id, sharedIndexedFile],
    [removedUniqueFile.id, removedUniqueFile],
    [keptUniqueFile.id, keptUniqueFile]
  ]),
  fileRefCounts: new Map([
    [sharedIndexedFile.id, 2],
    [removedUniqueFile.id, 1],
    [keptUniqueFile.id, 1]
  ]),
  totals: {
    people: 1,
    works: 2,
    videos: 3,
    playableVideos: 3,
    images: 0,
    infoFiles: 0
  }
};
const compareIncrementalWorks = (left, right) => left.title.localeCompare(right.title);
const firstIncrementalRemoval = removeLocalWorksFromLibrary(incrementalLibrary, ["1"], compareIncrementalWorks);
assert.deepEqual(firstIncrementalRemoval.removedWorkIds, ["1"], "incremental deletion must report only removed local works");
assert.equal(incrementalLibrary.worksById.has("1"), false, "incremental deletion must remove the selected work index");
assert.equal(incrementalLibrary.filesById.has(removedUniqueFile.id), false, "incremental deletion must remove unreferenced file indexes");
assert.equal(incrementalLibrary.filesById.get(sharedIndexedFile.id), sharedIndexedFile, "incremental deletion must retain a shared file index used by a remaining work");
assert.equal(incrementalLibrary.fileRefCounts.get(sharedIndexedFile.id), 1, "incremental deletion must decrement shared file references without scanning every work");
assert.deepEqual(incrementalLibrary.peopleById.get("10")?.works, ["2"], "incremental deletion must rebuild only the affected person");
assert.equal(incrementalLibrary.totals.works, 1, "incremental deletion must decrement the work total");
assert.equal(incrementalLibrary.totals.videos, 2, "incremental deletion must decrement only unreferenced file totals");
removeLocalWorksFromLibrary(incrementalLibrary, ["2"], compareIncrementalWorks);
assert.equal(incrementalLibrary.peopleById.has("10"), false, "incremental deletion must remove a person after their last local work disappears");
assert.equal(incrementalLibrary.people.length, 0, "incremental deletion must keep people arrays and maps aligned");
assert.equal(incrementalLibrary.totals.people, 0, "incremental deletion must update the people total");
assert.equal(incrementalLibrary.totals.videos, 0, "incremental deletion must clear the final file totals");

const localMutationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-local-delete-"));
const localMutationDb = new DatabaseSync(":memory:");
try {
  const sharedPersonDir = path.join(localMutationRoot, "shared-person");
  const missingPersonDir = path.join(localMutationRoot, "missing-person");
  const firstVideoPath = path.join(sharedPersonDir, "one.mp4");
  const secondVideoPath = path.join(sharedPersonDir, "two.mp4");
  fs.mkdirSync(sharedPersonDir, { recursive: true });
  fs.writeFileSync(firstVideoPath, "one");
  fs.writeFileSync(secondVideoPath, "two");
  localMutationDb.exec(`
    CREATE TABLE works (id INTEGER PRIMARY KEY, updated_at TEXT);
    CREATE TABLE local_works (
      id INTEGER PRIMARY KEY,
      work_id INTEGER NOT NULL,
      local_path TEXT,
      source_info_path TEXT
    );
    CREATE TABLE local_files (
      id INTEGER PRIMARY KEY,
      work_id INTEGER NOT NULL,
      local_work_id INTEGER,
      file_path TEXT
    );
    INSERT INTO works (id, updated_at) VALUES (1, ''), (2, ''), (3, ''), (4, '');
  `);
  const insertLocalWork = localMutationDb.prepare("INSERT INTO local_works (id, work_id, local_path) VALUES (?, ?, ?)");
  const insertLocalFile = localMutationDb.prepare("INSERT INTO local_files (id, work_id, local_work_id, file_path) VALUES (?, ?, ?, ?)");
  insertLocalWork.run(1, 1, sharedPersonDir);
  insertLocalWork.run(2, 2, sharedPersonDir);
  insertLocalWork.run(3, 3, missingPersonDir);
  insertLocalWork.run(4, 4, missingPersonDir);
  insertLocalFile.run(1, 1, 1, firstVideoPath);
  insertLocalFile.run(2, 2, 2, secondVideoPath);
  insertLocalFile.run(3, 3, 3, path.join(missingPersonDir, "three.mp4"));
  insertLocalFile.run(4, 4, 4, path.join(missingPersonDir, "four.mp4"));

  const mutationWorks = new Map([1, 2, 3, 4].map((id) => [String(id), {
    id: String(id),
    personId: "10",
    personName: "Shared Person",
    title: `Work ${id}`,
    directoryName: "shared-person",
    missingLocal: false
  }]));
  const mutationReconcileBatches = [];
  const pathWithinMutationRoot = (targetPath, rootPath) => {
    const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  const localMutationService = createWorkLocalMutationService({
    ensureLibraryDirectoryPath(value) {
      const resolved = path.resolve(value);
      if (!pathWithinMutationRoot(resolved, localMutationRoot)) throw new Error("test path escaped temp root");
      return resolved;
    },
    getCoreDb: () => localMutationDb,
    getWorkById: (workId) => mutationWorks.get(String(workId)) || null,
    hasCoreDb: () => true,
    invalidateLibraryDerivedCaches() {},
    invalidateTableStamp() {},
    invalidateWorkCodeIndex() {},
    libraryOpenRoots: () => [localMutationRoot],
    localWorkMarkerKey: () => "",
    markerDirectoryName: (value) => value,
    pathWithinRoot: pathWithinMutationRoot,
    publicWork: (work) => work,
    reconcileDeletedLocalWorks(workIds) {
      mutationReconcileBatches.push([...workIds]);
    },
    relativeFromRoot: (value) => path.relative(localMutationRoot, value).replaceAll(path.sep, "/"),
    replacePathPrefix: (value) => value,
    resetWorkSearch() {},
    resolveLibraryPersonByPublicId: (personId) => String(personId) === "10" ? { id: "10", works: ["1", "2", "3", "4"] } : null,
    resolveLibraryWorkByPublicId: (workId) => mutationWorks.get(String(workId)) || null,
    safeStat: (value) => fs.statSync(value, { throwIfNoEntry: false }),
    sourcePathToAbsolute: (value) => path.resolve(value),
    uniqueTextArray: (values) => [...new Set(values)],
    workHasLocalMarker: () => false
  });

  const firstDelete = localMutationService.deleteWorkLocalFiles("1", { refresh: false });
  assert.equal(fs.existsSync(firstVideoPath), false, "deleting one work in a shared folder must remove only that work's file");
  assert.equal(fs.existsSync(secondVideoPath), true, "deleting one work must preserve sibling files in the same person folder");
  assert.equal(fs.existsSync(sharedPersonDir), true, "a shared person folder must remain while another work still uses it");
  assert.equal(localMutationDb.prepare("SELECT COUNT(*) AS count FROM local_works WHERE id = 1").get().count, 0, "the selected local-work row must be cleared");
  assert.equal(localMutationDb.prepare("SELECT COUNT(*) AS count FROM local_works WHERE id = 2").get().count, 1, "the sibling local-work row must remain");
  assert.deepEqual(firstDelete.clearedWorkIds, ["1"], "shared-folder deletion must report only the selected work as cleared");

  const staleDelete = localMutationService.deleteWorkLocalFiles("3");
  assert.deepEqual(new Set(staleDelete.clearedWorkIds), new Set(["3", "4"]), "one missing shared path must clear every stale local-work row for that path");
  assert.equal(localMutationDb.prepare("SELECT COUNT(*) AS count FROM local_works WHERE id IN (3, 4)").get().count, 0, "stale shared-path rows must not survive deletion");
  assert.deepEqual(mutationReconcileBatches, [["3", "4"]], "one-work deletion must reconcile only the cleared in-memory work ids");

  const personDelete = localMutationService.deletePersonLocalFiles("10", { workIds: ["2"] });
  assert.equal(personDelete.failedCount, 0, "selected person deletion must complete without per-work failures");
  assert.deepEqual(mutationReconcileBatches, [["3", "4"], ["2"]], "selected person deletion must reconcile one cleared-id batch without refreshing the full library");
  assert.equal(fs.existsSync(sharedPersonDir), false, "the last work may remove its now-exclusive folder");
  assert.throws(
    () => localMutationService.deletePersonLocalFiles("10", { workIds: [] }),
    /请选择要删除的作品/,
    "an explicit empty selection must never fall back to deleting every person work"
  );
} finally {
  localMutationDb.close();
  assert.equal(path.dirname(path.resolve(localMutationRoot)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase(), "mutation test cleanup must stay in the system temp directory");
  fs.rmSync(localMutationRoot, { recursive: true, force: true });
}

console.log("fanhao-structure: ok");
