import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createShortVideoViews } from "../android-client/www/modules/short-videos/index.js";
import {
  NATIVE_SHORT_VIDEO_FEED_SCHEMA_VERSION,
  createNativeShortVideoFeedPayload,
  stringifyNativeShortVideoFeed
} from "../android-client/www/modules/short-videos/player/native-feed-contract.js";
import { normalizeRoute as normalizeWebShortVideoRoute, routeFromUrl as webShortVideoRouteFromUrl, routeUrl as webShortVideoRouteUrl } from "../public/modules/short-videos/router.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleDir = path.join(root, "android-client", "www", "modules", "short-videos");
const requiredParts = [
  "api.js",
  "index.js",
  "shared.js",
  "search.js",
  "list/controller.js",
  "list/view.js",
  "player/native-feed-contract.js",
  "player/native-feed.js",
  "ui/icons.js",
  "styles/list.css"
];

for (const relativePath of requiredParts) {
  assert(fs.statSync(path.join(moduleDir, relativePath), { throwIfNoEntry: false })?.isFile(), `missing short-video part: ${relativePath}`);
}
const obsoletePlayerParts = ["panels/author-panel.js", "panels/playback-panels.js", "platform/native-player.js", "player/interactions.js", "player/media-cache.js", "player/reel-controller.js", "styles/author-panel.css", "styles/reel.css", "styles/playback-panels.css"];
for (const relativePath of obsoletePlayerParts) {
  assert(!fs.statSync(path.join(moduleDir, relativePath), { throwIfNoEntry: false }), `legacy Android WebView player must stay removed: ${relativePath}`);
}

const facade = fs.readFileSync(path.join(moduleDir, "short-video-views.js"), "utf8").trim();
assert(/^export \{ createShortVideoViews \} from /.test(facade), "short-video-views.js must stay a compatibility facade");
for (const filePath of sourceFiles(moduleDir)) {
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).length;
  assert(lines <= 600, `short-video JS file exceeds 600 lines: ${relative(filePath)} (${lines})`);
}
verifyFeatureReferences();
verifySharedImports();
verifyWebDedicatedEntry();
verifyWebShortVideoRouter();
verifyNativeFeedContract();

function verifyNativeFeedContract() {
  const source = {
    id: "video-1",
    mobileStreamUrl: "/media/mobile.mp4",
    streamUrl: "/media/original.mp4",
    width: 720,
    height: 1280,
    actualVideo: { width: 2160, height: 3840, longEdge: 3840, codec: "h265" },
    sound: { id: "sound-1", key: "local:sound-1", localAvailable: true },
    author: { id: "author-1", following: true },
    actions: { liked: true }
  };
  const payload = createNativeShortVideoFeedPayload([source, { streamUrl: "/missing-id.mp4" }]);
  assert.equal(payload.schemaVersion, NATIVE_SHORT_VIDEO_FEED_SCHEMA_VERSION, "native feed payload must declare its schema version");
  assert.equal(payload.videos.length, 1, "native feed payload must drop entries without a stable identity");
  assert.deepEqual(
    {
      streamUrl: payload.videos[0].streamUrl,
      width: payload.videos[0].width,
      height: payload.videos[0].height,
      codec: payload.videos[0].actualVideo.codec,
      soundId: payload.videos[0].sound.id,
      following: payload.videos[0].author.following,
      liked: payload.videos[0].actions.liked
    },
    {
      streamUrl: "/media/mobile.mp4",
      width: 2160,
      height: 3840,
      codec: "h265",
      soundId: "sound-1",
      following: true,
      liked: true
    },
    "native feed serialization must preserve playback, probe, sound, author, and action fields"
  );
  assert.deepEqual(JSON.parse(stringifyNativeShortVideoFeed([source])), payload, "native feed JSON must serialize the versioned envelope without drift");
}

function verifyWebShortVideoRouter() {
  const stats = webShortVideoRouteFromUrl("http://127.0.0.1/short-videos/stats/likes");
  assert.equal(stats.shortVideoMode, "likes", "the dedicated web router must parse the like statistics route");
  assert.equal(webShortVideoRouteUrl(stats, { initialParams: new URLSearchParams(), hash: "" }), "/short-videos/stats/likes", "the dedicated web router must preserve the stable statistics URL");
  const author = webShortVideoRouteFromUrl("http://127.0.0.1/short-videos/authors/sec%20uid?source=all&sort=likes");
  assert.deepEqual(
    { page: author.shortVideoAuthorPage, source: author.shortVideoSource, sort: author.shortVideoSort },
    { page: "sec uid", source: "all", sort: "likes" },
    "the dedicated web router must parse author routes and filters"
  );
  const detailUrl = webShortVideoRouteUrl(normalizeWebShortVideoRoute({
    view: "shortVideos",
    shortVideoId: "7576602172642822266",
    shortVideoMedia: "video",
    shortVideoQuality: "4k",
    shortVideoSource: "all",
    shortVideoSort: "likes"
  }), { initialParams: new URLSearchParams("client=android"), hash: "" });
  assert.equal(detailUrl, "/short-videos/7576602172642822266?client=android&media=video&quality=4k&source=all&sort=likes", "the dedicated web router must serialize direct video filters and client context");
  const diagnosticUrl = webShortVideoRouteUrl(stats, { initialParams: new URLSearchParams("perf=1"), hash: "" });
  assert.equal(diagnosticUrl, "/short-videos/stats/likes?perf=1", "the dedicated web router must preserve opt-in performance capture across history updates and defensive reloads");
}

const styles = fs.readFileSync(path.join(moduleDir, "styles.css"), "utf8");
for (const style of ["list"]) {
  assert(styles.includes(`./styles/${style}.css`), `missing short-video CSS import: ${style}`);
}

const androidEntrySource = fs.readFileSync(path.join(moduleDir, "android-module.js"), "utf8");
const androidListSource = fs.readFileSync(path.join(moduleDir, "list", "view.js"), "utf8");
const androidListControllerSource = fs.readFileSync(path.join(moduleDir, "list", "controller.js"), "utf8");
const androidNativeFeedSource = fs.readFileSync(path.join(moduleDir, "player", "native-feed.js"), "utf8");
const androidNativeFeedContractSource = fs.readFileSync(path.join(moduleDir, "player", "native-feed-contract.js"), "utf8");
const androidPlayerPluginSource = fs.readFileSync(path.join(root, "android-client", "android", "app", "src", "main", "java", "local", "fanhao", "library", "FanHaoPlayerPlugin.java"), "utf8");
const androidNativePlayerSource = fs.readFileSync(path.join(root, "android-client", "android", "app", "src", "main", "java", "local", "fanhao", "library", "NativeShortVideoActivity.java"), "utf8");
const androidNativePageViewSource = fs.readFileSync(path.join(root, "android-client", "android", "app", "src", "main", "java", "local", "fanhao", "library", "NativeShortVideoPageView.java"), "utf8");
const androidNativeFeedContractJavaSource = fs.readFileSync(path.join(root, "android-client", "android", "app", "src", "main", "java", "local", "fanhao", "library", "ShortVideoFeedContract.java"), "utf8");
const androidNativeFeedModelsSource = fs.readFileSync(path.join(root, "android-client", "android", "app", "src", "main", "java", "local", "fanhao", "library", "ShortVideoFeedModels.java"), "utf8");
const androidNativePlayerLayoutSource = fs.readFileSync(path.join(root, "android-client", "android", "app", "src", "main", "res", "layout", "native_short_player_view.xml"), "utf8");
assert(androidEntrySource.includes('view: "shortVideoSearch"'), "Android short-video search must use a dedicated route");
assert(androidEntrySource.includes("short-video-chrome-row"), "Android short-video chrome must keep search and groups in one compact row");
assert(!androidEntrySource.includes("short-video-chrome-sort"), "Android short-video chrome must not reserve a separate sorting tag");
assert(androidEntrySource.includes("if (value === activeGroup)") && androidEntrySource.includes("openSortDialog(host, params)"), "tapping the active Android short-video group must open sorting");
assert(androidEntrySource.indexOf('row.append(search)') > androidEntrySource.indexOf('for (const [value, label]'), "Android short-video search must stay at the far right of the group row");
assert(androidEntrySource.includes("short-video-sort-overlay"), "Android short-video sorting must open a compact dialog");
assert(androidEntrySource.includes('["following", "我的关注"]') && androidEntrySource.includes("FOLLOWING_AUTHOR_SORT_OPTIONS"), "Android short-video chrome must expose My Following and its author sort choices");
assert(androidListSource.includes("short-video-search-page-form"), "Android short-video search route must render its own search form");
assert(!androidListSource.includes("renderSearchFilters"), "Android short-video search must not retain the shared shell filter renderer");
assert(androidListSource.includes("short-video-search-result-meta") && androidListSource.includes("条相关内容"), "Android Douyin-style search must expose result context without adding counts to the normal feed chrome");
assert(androidListSource.includes('`${formatCompact(author.count || 0)} 条作品`'), "Android search-related users must expose their local work counts");
assert(!androidListSource.includes("shell.append(renderLibraryTabs()"), "Android short-video group tabs must live in module chrome, not a second row");
assert(!androidEntrySource.includes('view: "shortVideoBrowser"'), "Android short videos must not expose the legacy WebView playback route");
assert(androidListControllerSource.includes("await openNativeShortVideoFeed(video)"), "Android short-video cards must open the native feed");
assert(!androidListControllerSource.includes('showView("shortVideoBrowser"'), "Android list playback must not fall back to the legacy WebView player");
assert(androidListSource.includes("openShortVideoAuthor(author)"), "Android author cards must delegate to the native author entry");
assert(androidListControllerSource.includes("openAuthorPanel: true"), "Android author index must request the native author homepage");
assert(androidListControllerSource.includes('params.set("scope", "following")') && androidListControllerSource.includes('params.set("sort", listState.authorSort)') && androidListControllerSource.includes('params.set("filter", listState.authorFilter)'), "Android My Following must use server-backed author sorting and filtering before pagination");
assert(androidListSource.includes("renderFollowingAuthorTools") && androidListSource.includes("short-video-mobile-author-card-meta"), "Android My Following must show its totals, controls, and per-author liked counts");
assert(!androidListSource.includes("short-video-mobile-author-cleanup") && !androidListSource.includes("抖音清理"), "Android My Following cards must leave unfollowing to the author detail action");
assert(androidListControllerSource.includes("该作者还没有本地作品，正在打开抖音主页") && androidListControllerSource.includes("authorOriginalUrl(author)"), "Android followed authors without local works must still open their Douyin profile");
assert(androidNativeFeedSource.includes("openAuthorPanel: Boolean(options.openAuthorPanel)"), "Android native feed bridge must forward the author homepage request");
assert(androidNativeFeedContractSource.includes("NATIVE_SHORT_VIDEO_FEED_SCHEMA_VERSION = 1") && androidNativeFeedContractSource.includes("schemaVersion: NATIVE_SHORT_VIDEO_FEED_SCHEMA_VERSION"), "Android WebView bridge must emit a versioned native feed envelope");
assert(androidNativeFeedContractJavaSource.includes("static final int SCHEMA_VERSION = 1") && androidNativeFeedContractJavaSource.includes("unsupported short-video feed schema") && androidNativeFeedContractJavaSource.includes("normalized.charAt(0) == '['"), "Android native decoder must validate the current schema while preserving legacy array compatibility");
assert(androidPlayerPluginSource.includes("ShortVideoFeedContract.decode") && androidPlayerPluginSource.includes("短视频列表格式不受支持"), "Android player plugin must reject malformed native feeds before opening an Activity");
assert(androidNativePlayerSource.includes("videos.addAll(ShortVideoFeedContract.decode") && androidNativePlayerSource.includes("Unable to decode initial short-video feed") && !androidNativePlayerSource.includes("catch (Exception ignored) {}\n  }\n\n  private ShortVideoItem itemFromJson"), "Android Activity must delegate initial feed decoding and report failures instead of swallowing them");
assert(androidNativeFeedModelsSource.includes("final class ShortVideoItem") && androidNativeFeedModelsSource.includes("final class FeedPage") && !androidNativePlayerSource.includes("private static final class ShortVideoItem"), "Android feed data models must stay outside the oversized Activity");
assert(androidNativePlayerSource.includes("NativeShortVideoPageView.create(") && !androidNativePlayerSource.includes("class ShortVideoHolder"), "Android Activity must delegate page construction and holder state to the dedicated page-view module");
assert(androidNativePageViewSource.includes("final class NativeShortVideoPageView") && androidNativePageViewSource.includes("final class ShortVideoHolder extends RecyclerView.ViewHolder") && androidNativePageViewSource.includes("RenderEffect.createBlurEffect"), "Android native page view must own page construction, holder state, and presentation effects");
assert(androidNativePlayerSource.split(/\r?\n/).length <= 6150, "Android native short-video Activity exceeded its refactored 6150-line budget");
assert(androidNativePageViewSource.split(/\r?\n/).length <= 450, "Android native short-video page-view module exceeded its 450-line budget");
assert(androidPlayerPluginSource.includes("EXTRA_OPEN_AUTHOR_PANEL") && androidPlayerPluginSource.includes('call.getBoolean("openAuthorPanel", false)'), "Android player plugin must pass the native author homepage flag");
assert(androidNativePlayerSource.includes("if (openAuthorPanelOnStart) openInitialAuthorScreen(initialIndex)"), "Android native author entry must render the author screen before starting playback");
assert(androidNativeFeedContractSource.includes("following: Boolean(item.author?.following)") && androidNativePlayerSource.includes("authorFollowEndpoint(item)") && androidNativePlayerSource.includes('button.setText(following ? "已关注" : "已取关")'), "Android author detail must use the synchronized one-tap follow state action");
assert(androidNativePlayerSource.includes('Log.i(TAG, "author direct "') && !androidNativePlayerSource.includes("openAuthorPanelIfRequested()"), "Android native author entry must not expose a delayed first-video transition");
assert(androidNativePlayerSource.includes("screen.hasPlaybackContext && isSameVideo(item, currentAuthorItem(screen))"), "Direct author entry must not label the seed video as currently playing");
assert(androidNativePlayerSource.includes("LinearLayout profileSection = new LinearLayout(this)") && androidNativePlayerSource.includes("animateAuthorProfileSection(profileSection"), "Android native author profile details must collapse as one stable surface");
assert(androidNativePlayerSource.includes("profileTransitionGestureId") && androidNativePlayerSource.includes("screen.worksGestureId != profileTransitionGestureId[0]") && androidNativePlayerSource.includes("public boolean dispatchTouchEvent(MotionEvent event)") && androidNativePlayerSource.includes("screen.worksGestureDirection") && androidNativePlayerSource.includes("screen.worksScrollY >= dp(160)") && androidNativePlayerSource.includes("screen.worksScrollY <= dp(8)"), "Android native author profile collapse must consume one dispatched touch gesture per transition and use wide hysteresis");
assert(androidNativePlayerSource.includes("profileTransitionBlockedUntil") && androidNativePlayerSource.includes("now + 520L") && androidNativePlayerSource.includes("profileTransitionGestureId[0] = screen.worksGestureId"), "Android native author profile transition must be non-reentrant while animation and layout settle");
assert(androidNativePlayerSource.includes("resetAuthorWorksScrollToTop(screen)") && androidNativePlayerSource.includes("ViewGroup.FOCUS_BLOCK_DESCENDANTS") && androidNativePlayerSource.includes("scroll.fling(0)") && androidNativePlayerSource.includes("scroll.fullScroll(View.FOCUS_UP)") && androidNativePlayerSource.includes("scroll.postOnAnimation") && androidNativePlayerSource.includes("profileSection.postDelayed"), "Android native author profile expansion must stop inertial and focus compensation scrolling and restore the works grid to its true top after layout settles");
assert(!androidNativePlayerSource.includes("hero.setVisibility(collapsed ? View.GONE : View.VISIBLE)"), "Android native author scrolling must not restore multi-view visibility flicker");
assert(androidNativePlayerSource.includes("grid.setPadding(gridHorizontalPadding, dp(6), gridHorizontalPadding, dp(8))"), "Android native author works grid must keep equal horizontal padding");
assert(androidNativePlayerSource.includes("(screenWidth - gridHorizontalPadding * 2) / 3"), "Android native author works tiles must share the centered grid width");
assert(androidNativePlayerSource.includes("topSearchButton = new ImageView(this)"), "Android native player search should stay a compact icon instead of a wide web-style pill");
assert(!androidNativePlayerSource.includes('holder.rail.addView(railAction(android.R.drawable.ic_lock_silent_mode_off, "原声"'), "Android native player rail must not expose an external original-video link");
assert(!androidNativePlayerSource.includes('holder.rail.addView(railAction(android.R.drawable.ic_menu_manage, "更多"'), "Android native player rail must rely on stage long-press for playback tools");
assert(androidNativePlayerSource.includes("icon.setBackgroundColor(Color.TRANSPARENT)"), "Android native player rail icons must not restore circular shadow backgrounds");
assert(androidNativePlayerSource.includes("loadGalleryImage(holder, item, galleryIndex, direction);\n      scheduleGalleryAutoAdvance(holder, item, galleryIndex);"), "Android native gallery images must start their four-second timer when each page is bound");
assert(androidNativePlayerSource.includes("liked ? R.drawable.ic_short_heart : R.drawable.ic_short_heart_outline"), "Android native author tiles must distinguish liked and unliked works with solid and outline hearts");
assert(!androidNativePlayerSource.includes('badge.setBackground(roundedDrawable(0x99000000'), "Android native author tile hearts must not restore a dark pill background");
assert(androidListSource.includes("Boolean(video.actions?.liked)") && androidListSource.includes('liked ? "heart" : "heartOutline"'), "Android work grids must render each video's real liked state instead of guessing from the active page");
assert(androidNativeFeedContractSource.includes("liked: Boolean(item.actions?.liked)"), "Android native feed bridge must preserve each video's liked state");
assert(androidNativeFeedContractJavaSource.includes('actions.optBoolean("liked", false)') && androidNativePlayerSource.includes("item.libraryLiked || isLocallyLiked(item)"), "Android native author and player views must combine library and local liked state");
assert(androidNativeFeedSource.includes("stringifyNativeShortVideoFeed") && androidNativeFeedContractSource.includes("item.mobileStreamUrl || item.streamUrl"), "Android feeds must use the server-resolved stable mobile rendition without changing identity during playback");
assert(androidNativeFeedContractJavaSource.includes('row.optString("mobileStreamUrl", "")') && androidNativeFeedContractJavaSource.includes("mobilePlaybackUrl(row, baseUrl)"), "native pagination must preserve the server-resolved mobile rendition beyond the initial WebView payload");
assert(androidNativePlayerSource.includes('Log.i(TAG, "reuse " + oldIndex + " -> " + index') && androidNativePlayerSource.includes("if (key == centerIndex) continue") && !androidNativePlayerSource.includes("primeNeighborPlayer") && !androidNativePlayerSource.includes("primeRequestedIndexes"), "Android short-video playback must reuse one decoder and prefetch bytes without secretly playing adjacent videos");
assert(androidNativePlayerSource.includes("scheduleVideoPrefetch(index + 1)") && androidNativePlayerSource.includes("NEXT_VIDEO_PREFETCH_BYTES = 4L * 1024L * 1024L"), "Android short-video playback must retain bounded next-item data prefetch");
assert(androidNativePlayerLayoutSource.includes('app:surface_type="surface_view"') && !androidNativePlayerLayoutSource.includes('app:surface_type="texture_view"'), "Android short-video playback must use the lower-power SurfaceView path");
assert(androidListControllerSource.includes("appendListVideos(appendedVideos)") && androidListSource.includes("function appendListVideos(videos = [])") && androidListSource.includes("grid.append(renderCard(video))"), "Android list pagination must append only new cards instead of rebuilding every cover");
assert(androidListControllerSource.includes("const { api, getActiveUrl, listState, showView } = context"), "Android short-video search submit must receive the showView navigation dependency");
assert(androidListSource.includes("搜索历史") && androidListSource.includes("short-video-search-suggestions"), "Android short-video search must expose history and live suggestions");

const views = createShortVideoViews({
  els: {},
  getActiveUrl: () => "http://127.0.0.1:29998",
  goBack() {},
  setActiveBottom() {},
  showView() {}
});
assert.deepEqual(
  Object.keys(views).sort(),
  ["deactivate", "getSearchState", "renderList", "renderSearch", "submitSearch"],
  "short-video public contract changed"
);

const appSource = fs.readFileSync(path.join(root, "android-client", "www", "app.js"), "utf8");
assert(!appSource.includes("shortVideoBrowser"), "Android shell must not retain the legacy WebView playback route");
assert(
  appSource.includes("shortVideoViews?.deactivate?.()")
    || appSource.includes("androidModuleRegistry?.deactivateExcept(currentView, currentViewParams)"),
  "Android shell must deactivate short-video transient state when leaving the module"
);

console.log(`short-video-client: ok (${requiredParts.length} parts, ${sourceFiles(moduleDir).length} JS files)`);

function sourceFiles(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:js|mjs)$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function verifyFeatureReferences() {
  const files = sourceFiles(moduleDir).filter((filePath) => !/[\\/](?:index|android-module)\.js$/.test(filePath));
  const sources = new Map(files.map((filePath) => [filePath, fs.readFileSync(filePath, "utf8")]));
  const methodNames = new Set();
  const ownMethods = new Map();
  for (const [filePath, source] of sources) {
    const own = new Set([...source.matchAll(/^  (?:async )?function ([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]));
    ownMethods.set(filePath, own);
    for (const name of own) methodNames.add(name);
  }
  for (const [filePath, source] of sources) {
    const own = ownMethods.get(filePath);
    const proxies = new Set([...source.matchAll(/^  const ([A-Za-z_$][\w$]*) = \(\.\.\.args\) => context\./gm)].map((match) => match[1]));
    const missing = [...methodNames].filter((name) => (
      !own.has(name)
      && !proxies.has(name)
      && new RegExp(`\\b${name}\\b`).test(source)
    ));
    assert.equal(missing.length, 0, `missing short-video context proxies in ${relative(filePath)}: ${missing.join(", ")}`);
  }
}

function verifySharedImports() {
  const sharedPath = path.join(moduleDir, "shared.js");
  const sharedSource = fs.readFileSync(sharedPath, "utf8");
  const exported = [...sharedSource.matchAll(/^export (?:const|function) ([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]);
  for (const filePath of sourceFiles(moduleDir)) {
    if (filePath === sharedPath) continue;
    const source = fs.readFileSync(filePath, "utf8");
    const imported = new Set();
    for (const match of source.matchAll(/import \{([^}]+)\} from ["'][^"']*shared\.js[^"']*["']/g)) {
      for (const item of match[1].split(",")) imported.add(item.trim().split(/\s+as\s+/)[0]);
    }
    const missing = exported.filter((name) => new RegExp(`\\b${name}\\b`).test(source) && !imported.has(name));
    assert.equal(missing.length, 0, `missing shared imports in ${relative(filePath)}: ${missing.join(", ")}`);
  }
}

function verifyWebDedicatedEntry() {
  const indexSource = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const entryPath = path.join(root, "public", "short-video-app.js");
  const entrySource = fs.readFileSync(entryPath, "utf8");
  const performanceObserverSource = fs.readFileSync(path.join(root, "public", "modules", "short-videos", "performance-observers.js"), "utf8");
  const routerSource = fs.readFileSync(path.join(root, "public", "modules", "short-videos", "router.js"), "utf8");
  const playerSource = fs.readFileSync(path.join(root, "public", "modules", "short-videos", "short-video-page.js"), "utf8");
  const authorPagesSource = fs.readFileSync(path.join(root, "public", "modules", "short-videos", "author-pages.js"), "utf8");
  const webIconsSource = fs.readFileSync(path.join(root, "public", "modules", "short-videos", "icons.js"), "utf8");
  const shortVideoStateSource = fs.readFileSync(path.join(root, "public", "modules", "short-videos", "state.js"), "utf8");
  const commentsViewSource = fs.readFileSync(path.join(root, "public", "modules", "short-videos", "comments-view.js"), "utf8");
  const sharePanelSource = fs.readFileSync(path.join(root, "public", "modules", "short-videos", "share-panel.js"), "utf8");
  const playbackSettingsSource = fs.readFileSync(path.join(root, "public", "modules", "short-videos", "playback-settings.js"), "utf8");
  const authorPanelSource = fs.readFileSync(path.join(root, "public", "modules", "short-videos", "author-panel.js"), "utf8");
  const galleryPlayerSource = fs.readFileSync(path.join(root, "public", "modules", "short-videos", "gallery-player.js"), "utf8");
  const listCardsSource = fs.readFileSync(path.join(root, "public", "modules", "short-videos", "list-cards.js"), "utf8");
  const likeDistributionSource = fs.readFileSync(path.join(root, "public", "modules", "short-videos", "like-distribution-view.js"), "utf8");
  const viewerSource = fs.readFileSync(path.join(root, "public", "modules", "short-videos", "styles", "viewer.css"), "utf8");
  const galleryNavigationSource = fs.readFileSync(path.join(root, "public", "modules", "short-videos", "styles", "gallery-navigation.css"), "utf8");
  const listSource = fs.readFileSync(path.join(root, "public", "modules", "short-videos", "styles", "list.css"), "utf8");
  const panelSource = fs.readFileSync(path.join(root, "public", "modules", "short-videos", "styles", "panels.css"), "utf8");
  const responsiveSource = fs.readFileSync(path.join(root, "public", "modules", "short-videos", "styles", "responsive.css"), "utf8");
  const staticServerSource = fs.readFileSync(path.join(root, "src", "platform", "server", "static-files.js"), "utf8");
  const serverConfigSource = fs.readFileSync(path.join(root, "src", "bootstrap", "server-config.js"), "utf8");
  const shortVideoRuntimeSource = fs.readFileSync(path.join(root, "src", "modules", "short-videos", "server", "runtime.js"), "utf8");
  const shortVideoListWorkerSource = fs.readFileSync(path.join(root, "src", "modules", "short-videos", "server", "list-worker.js"), "utf8");
  const shortVideoCatalogWorkerClientPath = path.join(root, "src", "modules", "short-videos", "server", "catalog-worker-client.js");
  const shortVideoCatalogWorkerClientSource = fs.statSync(shortVideoCatalogWorkerClientPath, { throwIfNoEntry: false })?.isFile()
    ? fs.readFileSync(shortVideoCatalogWorkerClientPath, "utf8")
    : "";
  const shortVideoRoutesSource = fs.readFileSync(path.join(root, "src", "modules", "short-videos", "server", "routes.js"), "utf8");
  const shortVideoStoreSource = fs.readFileSync(path.join(root, "src", "modules", "short-videos", "server", "store.js"), "utf8");
  const shortVideoListPageQueriesSource = fs.readFileSync(path.join(root, "src", "modules", "short-videos", "server", "list-page-queries.js"), "utf8");
  const launcherSource = fs.readFileSync(path.join(root, "start-fanhao.ps1"), "utf8");
  const shortVideoBuildSource = fs.readFileSync(path.join(root, "tools", "build_short_video_web.mjs"), "utf8");

  assert(
    indexSource.includes("const shortVideoEntry =") && indexSource.includes('import("/short-video-app.min.js?v='),
    "web shell must route short-video URLs to the dedicated entry"
  );
  assert(playerSource.includes('from "./state.js?v=') && playerSource.includes("ensureShortVideoState(state"), "the Web short-video composition root must delegate state normalization and persistence helpers");
  assert(playerSource.includes("createShortVideoAuthorPages") && playerSource.includes("author-pages.js?v="), "the Web short-video composition root must delegate author routes, collection, and profile rendering");
  assert(playerSource.includes('from "./icons.js?v=') && !playerSource.includes("function iconMarkup("), "the Web short-video composition root must delegate its SVG registry and icon controls");
  assert(playerSource.split(/\r?\n/).length <= 7600, "the Web short-video composition root must stay below 7600 lines");
  assert(authorPagesSource.split(/\r?\n/).length <= 600, "short-video author-page controller must stay below 600 lines");
  assert(webIconsSource.split(/\r?\n/).length <= 120, "short-video icon registry must stay below 120 lines");
  assert(shortVideoStateSource.split(/\r?\n/).length <= 350, "short-video state and preference helpers must stay below 350 lines");
  assert(indexSource.includes("const shortVideoStyleUrls = [") && indexSource.includes("const shortVideoViewerStyleUrls = [") && indexSource.includes("const shortVideoDetailEntry = ") && indexSource.includes("window.__fanhaoEnsureShortVideoViewerStyles = () => loadStyleUrls(shortVideoViewerStyleUrls)") && indexSource.includes("window.__fanhaoStylesReady = loadStyleUrls(styleUrls)") && indexSource.includes("await window.__fanhaoStylesReady;"), "the dedicated short-video entry must load route-critical styles first and expose deduplicated on-demand viewer styles");
  assert(launcherSource.includes('$ShortVideoBuildScript = Join-Path $ProjectDir "tools\\build_short_video_web.mjs"') && launcherSource.includes("& node $ShortVideoBuildScript"), "the primary launcher must rebuild the production short-video bundle before serving it");
  assert(shortVideoBuildSource.includes('createHash("sha256")') && shortVideoBuildSource.includes("fs.writeFileSync(output, generated)") && shortVideoBuildSource.indexOf("fs.writeFileSync(output, generated)") < shortVideoBuildSource.indexOf("fs.writeFileSync(indexPath, indexSource)"), "the web build must publish bundle bytes before switching the content-hashed immutable URL");
  assert(indexSource.includes('const shortVideoModuleUrl = "/short-video-app.min.js?v=') && indexSource.includes('modulePreload.rel = "modulepreload"') && indexSource.includes('modulePreload.fetchPriority = "high"') && indexSource.includes("window.__fanhaoShortVideoModuleUrl = shortVideoModuleUrl"), "direct short-video navigation must discover its bundled production module from the document head at high priority");
  assert(playerSource.includes("const SHORT_VIDEO_ADJACENT_WARM_STABLE_MS = 650") && playerSource.includes("const SHORT_VIDEO_ADJACENT_WARM_RAPID_MS = 80") && playerSource.includes("const SHORT_VIDEO_RAPID_NAV_WARM_WINDOW_MS = 1200") && playerSource.includes("shortVideoLastNavigationAt = Date.now()") && playerSource.includes("const currentCooldown = stableDelayMs - (Date.now() - currentFrameReadyAt)") && playerSource.includes('mode: rapidNavigation ? "rapid-navigation" : "steady-playback"'), "adjacent 2K decoding must protect the initial stream while accelerating the next decoder during active navigation");
  assert(indexSource.indexOf("const shortVideoModulePromise = import(") < indexSource.indexOf("await window.__fanhaoStylesReady;", indexSource.indexOf("const shortVideoModulePromise = import(")) && indexSource.includes("await shortVideoModulePromise;"), "short-video module evaluation must overlap remaining stylesheet loading after the DOM is parsed");
  assert(!indexSource.includes('<link rel="stylesheet" href="/styles.css'), "short-video routes must not be blocked by the full application stylesheet graph");
  assert(entrySource.includes("createShortVideoPage"), "dedicated web entry must create the short-video page");
  assert(entrySource.includes('./modules/short-videos/router.js?v=') && !entrySource.includes('./js/router.js?v='), "the dedicated short-video bundle must not parse unrelated gallery, novel, and music route branches");
  const playbackPrimerPath = path.join(root, "public", "assets", "short-video-h264-2k-primer.mp4");
  const playbackPrimerSize = fs.statSync(playbackPrimerPath, { throwIfNoEntry: false })?.size || 0;
  assert(playbackPrimerSize > 0 && playbackPrimerSize <= 64 * 1024, "dedicated web entry must ship a tiny 2K H.264 playback decoder primer without adding meaningful transfer weight");
  assert(entrySource.includes("function primeShortVideoPlaybackDecoder") && entrySource.includes("requestVideoFrameCallback") && entrySource.includes("shortVideoPlaybackPrimerPromise"), "the dedicated entry must keep a decoder primer matching the real smooth playback stream available for idle list browsing");
  assert(entrySource.includes("const quietMs = 900") && entrySource.includes('activityEvents = ["pointerdown", "wheel", "touchstart", "keydown", "scroll"]') && entrySource.includes('markShortVideoPerformance("playback-decoder-primer-quiet-ready"') && entrySource.includes("window.cancelIdleCallback(idleHandle)"), "playback decoder priming must wait for a quiet interaction window and yield again when browsing resumes");
  assert(entrySource.includes("function startShortVideoPerformanceCapture") && entrySource.includes("performance-observers.js?v=") && entrySource.includes("import(moduleUrl)") && performanceObserverSource.includes("function startShortVideoPerformanceObservers") && performanceObserverSource.includes('supportedEntryTypes?.includes?.("longtask")') && performanceObserverSource.includes('markShortVideoPerformance("render-frame-sample"') && performanceObserverSource.includes('markShortVideoPerformance("media-frame-sample"') && performanceObserverSource.includes('markShortVideoPerformance("media-frame-segment"') && performanceObserverSource.includes("getVideoPlaybackQuality") && performanceObserverSource.includes("requestVideoFrameCallback(sampleMediaFrame)") && performanceObserverSource.includes("stallsOver100") && performanceObserverSource.includes('document.documentElement.dataset.shortVideoPerfCapture !== "1"'), "opt-in playback diagnostics must capture long tasks, compositor cadence, active media segments, and actual video-frame quality without adding production overhead");
  assert(entrySource.includes("scheduleShortVideoPlaybackDecoderPrimer") && entrySource.includes('reason: "direct-video-uses-real-stream"'), "direct video routes must decode the requested stream immediately instead of competing with a synthetic primer");
  assert(entrySource.includes("function createDirectShortVideoPlaybackPrewarm") && entrySource.includes("function takeDirectShortVideoPlaybackPrewarm") && entrySource.includes('markShortVideoPerformance("direct-video-prewarm-start"') && entrySource.includes('markShortVideoPerformance("direct-video-prewarm-taken"') && playerSource.includes("takeDirectShortVideoPlaybackPrewarm?.(video, source)"), "direct 4K video routes must begin the real smooth stream before detail hydration and hand the same decoder-backed element to the visible player");
  assert(entrySource.includes("ensureShortVideoViewerStyles: () => window.__fanhaoEnsureShortVideoViewerStyles") && playerSource.includes("const viewerStylesReady = Promise.resolve(ensureShortVideoViewerStyles?.())") && playerSource.includes("const detailPromise = fetchShortVideoDetail(videoId)") && playerSource.includes("Promise.all([detailPromise, viewerStylesReady])"), "opening a video from the list must overlap media/detail work with deferred viewer stylesheet loading before rendering the player");
  assert(!entrySource.includes("await Promise.race(["), "direct routes must not add a decoder-primer wait before requesting video details");
  assert(playerSource.includes("short-video-first-frame-poster") && viewerSource.includes(".short-video-first-frame-poster"), "the player must preserve a real cover until a painted video frame is available");
  assert(playerSource.includes("video-frame-painted") && playerSource.includes("video-first-frame-revealed"), "first-frame diagnostics must distinguish decoded frames from visual reveal");
  assert(playerSource.includes("if (frameHandle != null) return true") && entrySource.includes("if (!entry.frameHandle)") && entrySource.includes("if (!frameHandle)"), "repeated media-ready events must keep waiting for an in-flight painted-frame callback instead of revealing the poster early");
  assert(webIconsSource.includes("let shortVideoIconMarkupTable = null") && webIconsSource.includes("shortVideoIconMarkupTable || (shortVideoIconMarkupTable = {") && !webIconsSource.includes("const icons = {\n    ai:"), "the large SVG icon table must initialize once instead of being rebuilt for every list-card icon");
  assert(playerSource.includes('if (img.loading === "eager" || !observer) queueShortVideoCover(img)') && playerSource.includes('entry.target.fetchPriority = "high"') && playerSource.includes("coverLoadBatchSize = 2") && playerSource.includes("coverLoadBatchDelay = 24"), "cover activation must avoid synchronous per-image layout reads and drain eager images in frame-friendly batches");
  assert(playerSource.includes("function scheduleShortVideoAppendContinuation()") && playerSource.includes("scheduleShortVideoAppendContinuation();") && playerSource.includes("svAppendContinuationRaf = window.requestAnimationFrame"), "an appended virtual list must recheck the bottom threshold after browser scroll anchoring settles");
  assert(playerSource.includes('params.set("cursor", appendCursor)') && playerSource.includes('params.set("refresh", "1")') && playerSource.includes("const stableTotal = appendCursor"), "quality-filtered likes feeds must bypass stale pre-probe pages and preserve one cursor-pinned total while appending");
  assert(shortVideoListPageQueriesSource.includes("function encodeShortVideoListCursor") && shortVideoListPageQueriesSource.includes("function decodeShortVideoListCursor") && shortVideoListPageQueriesSource.includes("listCursor.total - listCursor.seen") && shortVideoListPageQueriesSource.includes("v.digg_count < ?"), "likes pagination must use a bounded opaque keyset cursor so concurrent metadata probes cannot shift OFFSET pages");
  assert(playerSource.includes("SHORT_VIDEO_NAV_PREFETCH_AFTER_FRAME_MS = 320") && playerSource.includes('current.dataset.shortVideoFrameReady !== "1"') && playerSource.includes('markShortVideoPerformance("adjacent-navigation-prefetch-start"'), "second-ring navigation prefetch must wait for the visible player to paint and settle instead of competing with cold first-frame startup");
  assert(playerSource.includes("let svTotal = 0") && playerSource.includes("const totalChanged = total !== previousTotal") && playerSource.includes("!force && !totalChanged && start === svStart && end === svEnd"), "virtual list pagination must invalidate an unchanged window when its total item count changes");
  assert(playerSource.includes("SHORT_VIDEO_DETAIL_NEIGHBOR_LIMIT = 1") && playerSource.includes('detailParams.set("neighbors", String(SHORT_VIDEO_DETAIL_NEIGHBOR_LIMIT))'), "detail requests must carry only the one adjacent ring represented by the three-panel reel");
  assert(playerSource.includes("SHORT_VIDEO_LOADED_COVER_CACHE_LIMIT = 512") && playerSource.includes("SHORT_VIDEO_WATCH_WRITE_CACHE_LIMIT = 128") && playerSource.includes("SHORT_VIDEO_AUTHOR_MENTION_CACHE_LIMIT = 256") && playerSource.includes("function trimShortVideoWatchWrites(") && playerSource.includes('markShortVideoPerformance("short-video-cache-state"'), "long-lived short-video cover, watch-write, and author-mention caches must stay bounded and expose opt-in long-run diagnostics");
  assert(playerSource.includes("const preferred = shortVideoAdjacentWarmDirection < 0 ? backward : forward") && playerSource.includes("prefetchAdjacentNavigation(candidate.video, candidate.direction, params)") && !playerSource.includes("candidates.forEach((item, index)"), "navigation look-ahead must follow the single warmed swipe direction instead of parsing both second-ring details");
  assert(playerSource.indexOf('player.preload = ghost ? "none" : "auto"') < playerSource.indexOf("player.src = playbackUrl") && playerSource.includes('player.fetchPriority = ghost ? "low" : "high"') && playerSource.includes('backdrop.loading = ghost ? "lazy" : "eager"'), "off-screen reels and their backdrops must receive low-priority loading policy before media src can start fetching");
  assert(playerSource.includes('current.dataset.shortVideoFrameReady !== "1"') && playerSource.includes("currentFrameReadyAt"), "adjacent 4K decoding must wait until the current stream paints its first frame");
  assert(playerSource.includes("SHORT_VIDEO_PREWARMED_SWITCH_ANIMATION_MS = 72") && playerSource.includes("motion?.prewarmed ? SHORT_VIDEO_PREWARMED_SWITCH_ANIMATION_MS"), "prewarmed adjacent video switches must use the shorter visual handoff without shortening cold or drag transitions");
  assert(playerSource.includes("function scheduleInitialAdjacentPanelsRefresh") && playerSource.includes("waitForVideoFirstFrame(player, SHORT_VIDEO_FIRST_FRAME_TIMEOUT_MS)") && playerSource.includes("window.requestIdleCallback(refresh, { timeout: 96 })") && playerSource.includes('markShortVideoPerformance("adjacent-panels-refresh-finish"'), "initial adjacent reel DOM must wait until the current video has painted instead of competing with its first frame");
  assert(playerSource.includes("SHORT_VIDEO_SWITCH_PRIME_TIMEOUT_MS = 1200") && playerSource.includes("const [, incomingReady] = await Promise.all") && playerSource.includes("if (canPromoteVideoPanel && incomingPlayer && !incomingReady)") && playerSource.includes('markShortVideoPerformance("adjacent-switch-rebounded"'), "a cold adjacent video must paint a frame before DOM promotion and must rebound instead of exposing a black current player on timeout");
  assert(playerSource.includes('player.dataset.shortVideoSlot = "current"') && playerSource.includes('previousPlayer.dataset.shortVideoSlot = direction > 0 ? "prev" : "next"') && playerSource.includes('markShortVideoPerformance("video-player-promoted"'), "promoted video elements must expose their current slot for playback control and diagnostics");
  assert(entrySource.includes('element.inert = true') && entrySource.includes('"#adminModal"') && entrySource.includes('"#detailDrawer"'), "dedicated short-video entry must isolate unrelated shell dialogs from keyboard focus");
  assert(entrySource.includes("openRouteTarget"), "dedicated web entry must restore direct video routes");
  assert(entrySource.includes('next.view !== "shortVideos"'), "dedicated web entry must hand non-short-video history routes back to the full shell");
  for (const unrelatedModule of ["gallery-page", "gallery-renderer", "music-page", "novel-page", "people-page", "admin-modal"]) {
    assert(!entrySource.includes(unrelatedModule), `dedicated web entry must not import ${unrelatedModule}`);
  }
  assert(playerSource.includes("keepalive: true"), "short-video watch writes must survive page exit");
  assert(!shortVideoRuntimeSource.includes("copyFileSync") && shortVideoRuntimeSource.includes("fs.promises.copyFile") && shortVideoRuntimeSource.includes("const videoCacheQueue = []"), "short-video cache misses must serve the source immediately and copy through one asynchronous background queue");
  assert(shortVideoRuntimeSource.includes("SHORT_VIDEO_STREAM_CHUNK_BYTES = 1 * 1024 * 1024") && shortVideoRuntimeSource.includes("SHORT_VIDEO_INITIAL_STREAM_CHUNK_BYTES = 2 * 1024 * 1024") && shortVideoRuntimeSource.includes("SHORT_VIDEO_STARTUP_CACHE_BYTES = 2 * 1024 * 1024") && shortVideoRuntimeSource.includes("queueStartupVideoCandidates") && shortVideoRuntimeSource.includes("cachedStartupVideoFile") && shortVideoRuntimeSource.includes("totalSize: descriptor.expectedSize"), "short-video playback must give the initial first-GOP request two megabytes, then return to one-megabyte response ranges while retaining the SSD startup prefix");
  assert(shortVideoRuntimeSource.includes('"X-FanHao-Media-Cache": file.cached ? "full" : (file.cachedStartup ? "startup" : "source")'), "short-video ranges must identify full, startup, and source cache paths for live verification");
  assert(playerSource.includes("function shortVideoPlaybackUrl") && playerSource.includes('source.replace("/media/short-video/", "/media/short-video-smooth/")') && playerSource.includes('rendition=2k30-v2-range2'), "4K web playback must route through a cache-versioned adaptive smooth rendition without changing the downloaded source file");
  assert(shortVideoRuntimeSource.includes("queueSmoothVideoCandidates") && shortVideoRuntimeSource.includes("buildSmoothVideoCache") && shortVideoRuntimeSource.includes('"X-FanHao-Playback-Rendition"') && shortVideoRuntimeSource.includes('"smooth-2k30"'), "top and currently opened 4K videos must build and expose a diagnostic H.264 30fps playback rendition");
  assert(shortVideoRuntimeSource.includes("SHORT_VIDEO_SMOOTH_CACHE_BACKLOG_LIMIT = 512") && shortVideoRuntimeSource.includes("SHORT_VIDEO_SMOOTH_CACHE_PAGE_SIZE = 256") && shortVideoRuntimeSource.includes("SHORT_VIDEO_SMOOTH_CACHE_REFILL_LOW_WATERMARK = 256") && shortVideoRuntimeSource.includes("store.smoothPlaybackCandidateCount()") && shortVideoRuntimeSource.includes("store.smoothPlaybackCandidates(pageLimit, smoothVideoCandidateScanOffset)") && shortVideoStoreSource.includes("function smoothPlaybackCandidates") && shortVideoStoreSource.includes("INDEXED BY idx_short_videos_smooth_digg") && shortVideoStoreSource.includes("actual_long_edge >= 2160") && shortVideoRuntimeSource.includes("smoothVideoCandidateBacklog") && shortVideoRuntimeSource.includes("refillSmoothVideoCandidateBacklog()"), "every video routed through adaptive smooth playback must page through an indexed, bounded, like-ordered background backlog without a fixed-total cutoff");
  assert(shortVideoRuntimeSource.includes("smoothVideoResolvedVersions") && shortVideoRuntimeSource.includes("smoothVideoCandidateVersion(video)") && shortVideoRuntimeSource.includes("rememberSmoothVideoResolved(id, descriptor)") && shortVideoRuntimeSource.includes("smoothVideoResolvedVersions.get(id) === version"), "smooth rendition candidates must remember the resolved source version and avoid requeueing already generated files");
  assert(shortVideoRuntimeSource.includes("function schedule4kSmoothVideoWarmup") && shortVideoRuntimeSource.includes("schedule4kSmoothVideoWarmup();") && shortVideoRuntimeSource.includes("schedule4kSmoothVideoWarmup(250);") && shortVideoStoreSource.includes("ORDER BY digg_count DESC, liked_at DESC, id DESC"), "all smooth playback renditions must seed in like order at service startup and after downloader syncs");
  assert(shortVideoRuntimeSource.includes("function refreshSmoothVideoCacheEntryIndex") && shortVideoRuntimeSource.includes("fs.readdirSync(cacheDir, { withFileTypes: true })") && shortVideoRuntimeSource.includes("rememberIndexedSmoothVideoCandidate(video)") && shortVideoStoreSource.includes("sourcePath: String(row.source_path || \"\")") && shortVideoRuntimeSource.includes("warmupDurationMs"), "smooth-rendition warmup must index the cache directory once instead of synchronously statting hundreds of resolved candidates on the HTTP thread");
  assert(shortVideoRuntimeSource.includes('url.pathname === "/api/short-videos/playback-cache-status"') && shortVideoRuntimeSource.includes("shortVideoPlaybackCacheStatus()") && shortVideoRuntimeSource.includes("playbackIdleInMs"), "short-video cache scheduling must expose read-only live diagnostics for queue and playback-idle verification");
  assert(shortVideoRuntimeSource.includes('["queued", "copying"].includes(result?.state)') && shortVideoRuntimeSource.includes('[...smoothVideoJobs.values()].some((job) => String(job.id) === id)'), "startup and smooth candidate quotas must count actual work instead of repeatedly stopping on cached head items");
  assert(shortVideoRuntimeSource.includes('/^\\/short-videos\\/[^/]+\\/?$/.test(url.pathname)') && shortVideoRuntimeSource.includes("noteShortVideoPlaybackActivity();\n      tryQueueStartupVideoCache") && (shortVideoRuntimeSource.match(/if \(req\.method === "GET"\) noteShortVideoPlaybackActivity\(\);/g) || []).length >= 3 && shortVideoRuntimeSource.includes("SHORT_VIDEO_SMOOTH_IDLE_AFTER_WATCH_MS = 12000") && shortVideoRuntimeSource.includes("deferSmoothVideoBackgroundForPlayback") && shortVideoRuntimeSource.includes('job.kind !== "background"') && shortVideoRuntimeSource.includes("retryAfterPlayback"), "background 4K transcoding must yield at direct-page, detail, and actual media GET entry points and remain idle while real viewing continues");
  assert(shortVideoRuntimeSource.includes('"-c:v", "h264_nvenc"') && shortVideoRuntimeSource.includes("force_original_aspect_ratio=decrease:force_divisible_by=2") && shortVideoRuntimeSource.includes("fps=${SHORT_VIDEO_SMOOTH_FPS}") && shortVideoRuntimeSource.includes('"-movflags", "+faststart"'), "smooth 4K playback renditions must cap their decoded edge, use GPU H.264 when available, and stay fast-start MP4 files");
  assert(shortVideoRuntimeSource.includes("SHORT_VIDEO_SMOOTH_MAX_EDGE = 2560") && shortVideoRuntimeSource.includes("cachedSmoothLegacy") && shortVideoRuntimeSource.includes('"smooth-4k30-legacy"'), "2K smooth playback migration must retain the prior 4K H.264 rendition as a temporary no-stall fallback");
  assert(shortVideoRuntimeSource.includes("SHORT_VIDEO_SMOOTH_CURRENT_DELAY_MS = 1200") && shortVideoRuntimeSource.includes("tryQueueStartupVideoCache(id, { delayMs: 0 })"), "current 4K playback must prime its SSD startup prefix before background transcoding can compete with first-frame I/O");
  assert(shortVideoRuntimeSource.includes("SHORT_VIDEO_SMOOTH_ON_DEMAND_WAIT_MS = 2800") && shortVideoRuntimeSource.includes("waitForSmoothVideoPlayback(id, sourceFile") && shortVideoRuntimeSource.includes('next.kind === "background"') && shortVideoRuntimeSource.includes("deferCurrentSmoothVideoAfterTimeout(id)") && shortVideoRuntimeSource.includes('"X-FanHao-Playback-Prepare"'), "a first uncached 4K range must briefly await its current-priority compatible rendition while only background migration jobs yield to active playback");
  assert(shortVideoRuntimeSource.includes("applyMobilePlaybackHints") && shortVideoRuntimeSource.includes("smoothVideoRenditionVersions.get(String(video.id") && shortVideoRuntimeSource.includes("rememberSmoothVideoResolved(video.id, descriptor, smoothVideoCacheEntryNames.has(currentName))") && shortVideoRuntimeSource.includes('rendition: "mobile-2560-h264-v3"'), "Android list responses must choose a smooth URL only after that exact rendition exists and rotate cache identity when transport semantics change");
  assert(shortVideoRuntimeSource.includes('req.headers?.["x-fanhao-client"]') && shortVideoRuntimeSource.includes("!androidPlayback && !sourceFile.cached") && shortVideoRuntimeSource.includes("file.maxRangeBytes = androidPlayback") && shortVideoRuntimeSource.includes("file.fullResponse = androidPlayback"), "Android Media3 requests must bypass physical startup-prefix files and artificial open-ended range truncation");
  assert(shortVideoRuntimeSource.includes("cachedStartupVideoFile(id, sourceFile) || sourceFile") && shortVideoRuntimeSource.includes('"source-compatible"'), "adaptive playback fallback must preserve startup-prefix and immutable compatible-source cache paths");
  assert(shortVideoRuntimeSource.includes("onWatch: queueWatchedVideoCache") && shortVideoRuntimeSource.includes("SHORT_VIDEO_CACHE_MIN_PROGRESS_MS") && shortVideoRoutesSource.includes("onWatch?.(videoId, body || {}, data)"), "only the active watched video may enter the deferred shared media cache");
  assert(shortVideoStoreSource.includes('"id, source_path, size_bytes, mtime_ms, actual_width, actual_height, actual_bit_rate, actual_codec, actual_frame_rate"') && shortVideoRuntimeSource.includes("const expectedSize = Math.max(0, Number(file.size || 0))") && !shortVideoRuntimeSource.includes("const sourceStat = safeStat(file.path)"), "shared-cache hits must resolve from catalog metadata without waking the original video disk");
  assert(shortVideoRuntimeSource.includes("storedSmoothVideoProbe(job.file)") && shortVideoRuntimeSource.includes("store.updateActualVideoPlaybackMetadata(job.id, probe)"), "smooth-cache decisions must reuse persisted codec and frame rate and save fallback probes");
  assert(shortVideoRuntimeSource.includes('cacheState: "stale-refreshing"') && shortVideoRuntimeSource.includes("queueListCacheRefresh(url, cachePath)") && shortVideoRuntimeSource.includes("const listCacheRefreshJobs = new Map()"), "expired short-video lists must return stale data immediately and deduplicate background refreshes");
  const catalogWorkerRuntimeReady = shortVideoRuntimeSource.includes('"/api/short-videos/authors": "authors"')
    && shortVideoRuntimeSource.includes('"/api/short-videos/facets": "facets"')
    && ((shortVideoRuntimeSource.includes('new Worker(new URL("./list-worker.js"')
      && shortVideoRuntimeSource.includes("function startDownloadManagerSync() {\n    ensureListQueryWorker();")
      && shortVideoRuntimeSource.includes('message?.type === "ready"')
      && shortVideoRuntimeSource.includes("return listQueryWorkerReadyPromise;"))
      || (shortVideoRuntimeSource.includes("createShortVideoCatalogWorkerClient")
        && shortVideoRuntimeSource.includes("catalogWorker.query(url")
        && shortVideoRuntimeSource.includes("catalogWorker.start()")
        && shortVideoCatalogWorkerClientSource.includes('new Worker(new URL("./list-worker.js"')
        && shortVideoCatalogWorkerClientSource.includes('message?.type === "ready"')
        && shortVideoCatalogWorkerClientSource.includes("return readyPromise;")));
  assert(catalogWorkerRuntimeReady && shortVideoListWorkerSource.includes('trustExplicitInvalidation: true') && shortVideoListWorkerSource.includes('["list", "authors", "facets"].includes(message?.type)') && shortVideoListWorkerSource.includes("store.listVideos(url)") && shortVideoListWorkerSource.includes("function warmStore(notifyReady = false)") && shortVideoListWorkerSource.includes("warmStore(true);") && shortVideoListWorkerSource.includes("warmStore();") && shortVideoListWorkerSource.includes('message?.type === "reset"'), "short-video catalog reads must share a reusable explicitly invalidated worker whose startup waits for recommendation and author cache warmup and whose mutations rebuild those caches off the HTTP thread");
  assert(shortVideoStoreSource.includes("trustExplicitInvalidation") && shortVideoStoreSource.includes("if (!explicitCatalogStamp) explicitCatalogStamp = liveStamp") && shortVideoStoreSource.includes('explicitCatalogStamp = ""'), "the list worker must keep serving its coherent warm catalog snapshot until the runtime sends an explicit reset after downloader synchronization");
  assert(shortVideoStoreSource.includes("function prepareAuthorSearchIndex") && shortVideoStoreSource.includes('enumerable: false') && shortVideoStoreSource.includes("author._searchText.includes(normalizedQuery)"), "author search must reuse a non-public normalized search index instead of rebuilding locale-aware text for every author on every request");
  assert(shortVideoStoreSource.includes('params.get("users") !== "0"') && shortVideoStoreSource.includes("users: userPage?.authors || []") && playerSource.includes('params.set("users", "0")'), "aggregate search must return matching users with the initial work page and skip repeating them during work pagination");
  assert(playerSource.includes("function renderAggregateSearchResults") && playerSource.includes('userTitle.textContent = "用户"') && playerSource.includes('workTitle.textContent = "作品"') && playerSource.includes("renderSearchUserCard(author)"), "web search must render user and work results together on one page");
  assert(shortVideoStoreSource.includes("if (options.recommendations)") && shortVideoStoreSource.includes("recommendedVideoIds(database, {") && !shortVideoStoreSource.includes("FROM short_videos v\n      LEFT JOIN short_video_stats s ON s.video_id = v.id\n      LEFT JOIN short_video_user_actions user_dislike"), "worker-only recommendation warmup must reuse denormalized engagement fields without the redundant stats-table join");
  assert(shortVideoStoreSource.includes("sourceTotals: new Map()") && shortVideoStoreSource.includes("fastSourceTotalCacheKey(filter)") && shortVideoStoreSource.includes("catalogCache.sourceTotals.set(sourceTotalKey") && shortVideoListPageQueriesSource.includes("Number.isFinite(totalOverride)"), "post and local list pages must reuse catalog-versioned relationship totals instead of recounting the complete membership table on every page");
  assert(shortVideoRuntimeSource.includes("cacheGeneration: generation") && shortVideoRuntimeSource.includes("persistShortVideoListCacheGeneration") && shortVideoRuntimeSource.includes("fs.renameSync(tempPath, filePath)"), "short-video list invalidation must survive restarts and cache writes must not expose partial JSON");
  assert(shortVideoRuntimeSource.includes('SHORT_VIDEO_LIST_CACHE_SCHEMA = "aggregate-search-v1"') && shortVideoRuntimeSource.includes("`${SHORT_VIDEO_LIST_CACHE_SCHEMA}:${url.pathname}?${normalized.toString()}`"), "short-video list response schema changes must rotate the persistent cache namespace");
  assert((shortVideoRoutesSource.match(/onMutation\?\.\(\);/g) || []).length >= 6 && shortVideoRoutesSource.includes("const data = shortVideoStore.recordWatch") && shortVideoRoutesSource.includes("onWatchMutation?.(videoId, body || {}, data);\n      onWatch?.(videoId"), "catalog mutations must invalidate all list generations while high-frequency watch writes use their dedicated path");
  assert(shortVideoRuntimeSource.includes("watchCacheGeneration: watchGeneration") && shortVideoRuntimeSource.includes("isWatchSensitiveShortVideoList") && shortVideoRuntimeSource.includes('data?.source || "").toLowerCase() === "history"') && shortVideoRuntimeSource.includes('data?.sort || "").toLowerCase() === "watched"'), "watch writes must invalidate only history membership and recent-watch ordering");
  assert(shortVideoRuntimeSource.includes("recordShortVideoWatchCacheMutation") && shortVideoRuntimeSource.includes("applyShortVideoWatchOverlays") && shortVideoRuntimeSource.includes("short-video-list-watch-overlays.json"), "ordinary cached lists must receive persisted per-video watch overlays without a full SQLite refresh");
  assert(playerSource.includes("let shortVideoListRequestId = 0;") && playerSource.includes("const requestId = ++shortVideoListRequestId;") && playerSource.includes("if (requestId !== shortVideoListRequestId) return;"), "short-video list responses must ignore stale source and sort requests");
  assert(playerSource.includes("const SV_BUFFER_ROWS = 5;") && playerSource.includes("startRow = Math.max(0, rawStartRow - bufferRows)"), "the short-video virtual list must keep a bounded off-screen card window");
  assert(playerSource.includes("const SV_INITIAL_BUFFER_ROWS = 2;") && playerSource.includes("initialWindow ? SV_INITIAL_BUFFER_ROWS : SV_BUFFER_ROWS") && playerSource.includes("scheduleShortVideoWindowExpansion()") && playerSource.includes("requestIdleCallback(expand, { timeout: 180 })"), "the first short-video paint must build a smaller card window and expand the scroll buffer only when the main thread is idle");
  assert(!playerSource.includes("const h = first.getBoundingClientRect().height") && playerSource.includes("Card aspect ratio and metadata height are deterministic CSS values"), "initial virtual-grid setup must trust its deterministic card-height estimate instead of forcing a synchronous layout measurement");
  assert(playerSource.includes("function isShortVideoViewportOutsideWindow()") && playerSource.includes("if (isShortVideoViewportOutsideWindow())"), "large scrollbar jumps must refill the virtual window before the next paint");
  assert(playerSource.includes("const existingCards = new Map(") && playerSource.includes("card?.shortVideoCardRecord !== video") && playerSource.includes('markShortVideoPerformance("short-video-window-render"'), "virtual-list row changes must reuse unchanged cards instead of rebuilding the entire interactive window");
  assert(!playerSource.includes("visible: rect.bottom > 0 && rect.top < viewportHeight") && playerSource.includes('if (img.loading === "eager" || !observer) queueShortVideoCover(img)') && playerSource.includes("scheduleShortVideoCoverDrain()"), "visible short-video covers must queue without forcing layout and begin loading on the next task");
  assert(playerSource.includes('["following", "我的关注"]') && playerSource.includes('params.set("scope", "following")') && authorPagesSource.includes('["authors", "following"].includes(state.shortVideo?.source)'), "My Following must reuse the author index and request only followed authors");
  assert(playerSource.includes('["followed", "最近关注"]') && playerSource.includes('["count", "视频数量"]') && playerSource.includes('["liked", "喜欢视频数"]') && playerSource.includes('params.set("filter", state.shortVideo.authorFilter)') && playerSource.includes("只看未点赞"), "My Following must expose server-backed author sorting and an unliked-only filter");
  assert(!playerSource.includes("short-video-author-index-cleanup") && !playerSource.includes("beginFollowingCleanup") && !listSource.includes(".short-video-author-index-cleanup"), "web My Following cards must leave unfollowing to the author detail action");
  assert(playerSource.includes("/api/short-videos/authors/") && playerSource.includes('variant === "page" ? "已取关"') && playerSource.includes("if (!authorFollowKey(video, author))"), "web author detail must support one-tap follow changes even when the author has no local videos");
  assert(playerSource.includes('state.shortVideo.source === "liked" ? "入库时间" : "发布时间"'), "short-video time sorting must name the active ingestion or publication timestamp");
  assert(responsiveSource.includes(".short-video-control-volume .short-video-volume-popover") && responsiveSource.includes("display: none;"), "mobile video controls must keep the desktop volume slider out of the caption and action rail");
  assert(playerSource.includes('toggleActiveMute().then((soundOn) =>') && playerSource.includes('showBrowserToast(soundOn ? "声音已开启" : "已静音")'), "keyboard mute must report the final browser-approved sound state");
  assert(playbackSettingsSource.includes('["F", "进入 / 退出全屏"]') && playbackSettingsSource.includes('["双击画面", "点赞当前作品"]'), "desktop shortcut help must expose fullscreen and Douyin-style double-click liking");
  assert(playbackSettingsSource.includes('galleryMode ? "播放 / 暂停图集" : "播放 / 暂停视频"') && playbackSettingsSource.includes('galleryMode ? "切换图集内容" : "视频快退 / 快进 5 秒"') && playbackSettingsSource.includes('if (!galleryMode) sheet.append(speedSection);'), "gallery playback settings must describe gallery controls and must not change background-music speed");
  assert(playerSource.includes("function setReelPanelInteractionState(panel, interactive)") && playerSource.includes("panel.inert = !interactive") && playerSource.includes("setReelPanelInteractionState(incoming, true)") && playerSource.includes("setReelPanelInteractionState(outgoing, false)"), "reel promotion must expose only the current work to keyboard and assistive interaction");
  assert(playerSource.includes("const SHORT_VIDEO_WHEEL_DISTANCE = 82;"), "short-video wheel navigation must use a responsive gesture threshold");
  assert(galleryPlayerSource.includes("`${currentIndex + 1}/${images.length}`"), "gallery counter must use the compact Douyin-style 1/5 format");
  assert(galleryPlayerSource.includes("pager.append(previous, counter, next)"), "desktop gallery navigation must group previous, counter, and next controls");
  assert(viewerSource.includes(".short-video-gallery-pager") && viewerSource.includes("bottom: max(74px"), "desktop gallery navigation must stay centered above the playback bar");
  assert(galleryPlayerSource.includes("short-video-gallery-edge-nav") && galleryNavigationSource.includes(".short-video-gallery-player:hover .short-video-gallery-edge-nav") && responsiveSource.includes(".short-video-gallery-edge-nav"), "desktop galleries must expose Douyin-style edge navigation while mobile keeps swipe-first controls");
  assert(viewerSource.includes(".short-video-gallery-progress") && viewerSource.includes("bottom: max(48px"), "desktop gallery progress must follow Douyin's bottom-aligned segmented timeline");
  assert(galleryPlayerSource.includes("resolveGalleryIndex") && galleryPlayerSource.includes("SHORT_VIDEO_GALLERY_ADVANCE_MS"), "gallery navigation must loop continuously like Douyin's note viewer");
  assert(galleryPlayerSource.includes("let advanceRemainingMs = SHORT_VIDEO_GALLERY_ADVANCE_MS;"), "gallery images must use the shared Douyin-style auto-advance interval");
  assert(galleryPlayerSource.includes("is-gallery-timing-paused") && viewerSource.includes("shortVideoGallerySegmentProgress"), "gallery progress must animate with playback time and pause with page visibility");
  assert(galleryPlayerSource.includes("const projectedDelta = rawDelta + velocity * 180;") && galleryPlayerSource.includes("--short-video-gallery-settle-duration"), "gallery drag release must use velocity projection and motion-adaptive settling");
  assert(viewerSource.includes(".short-video-reel-panel.is-gallery-post") && viewerSource.includes(".short-video-stage.is-gallery-stage"), "gallery pages must keep a stable full-canvas stage across portrait and landscape items");
  assert(playerSource.includes("function activeShortVideoFullscreenTarget()") && playerSource.includes("return browser ? els.workGrid : null") && playerSource.includes("fullscreenElement === els.workGrid") && playerSource.includes("async function toggleShortVideoFullscreen()") && playerSource.includes('document.addEventListener("fullscreenchange", syncShortVideoFullscreenControls)'), "short-video fullscreen must use the stable work grid so reel replacement cannot exit fullscreen");
  assert(viewerSource.includes(".work-grid:fullscreen") && viewerSource.includes("width: 100vw") && viewerSource.includes("height: 100vh"), "short-video fullscreen shell must fill the display without dropping player controls");
  assert(playerSource.includes("function toggleShortVideoSmartFill()") && playerSource.includes('control.dataset.shortVideoCompact === "true"') && playerSource.includes('smartFill.className = "short-video-control-icon short-video-control-smart-fill"') && playerSource.includes("SHORT_VIDEO_SMART_FILL_KEY"), "short-video controls must expose and remember a compact Douyin-style smart fill switch");
  assert(playerSource.includes('tools.className = "short-video-control-tools"') && playerSource.includes('clearScreen.setAttribute("role", "switch")') && viewerSource.includes(".short-video-control-switch-track"), "desktop playback controls must group reference-style switch and tool controls");
  assert(playerSource.includes("function shortVideoPlaybackQualityLabel(video)") && playerSource.includes('return "超清 4K"') && playerSource.includes("actual.bitRate"), "player quality must display the persisted actual video resolution and bitrate");
  assert(playerSource.includes('pip.className = "short-video-control-icon short-video-control-pip"') && playerSource.includes("player.requestPictureInPicture()"), "desktop playback controls must expose direct picture-in-picture access");
  assert(playbackSettingsSource.includes('playbackSettingsAction("抖音原视频"') && playbackSettingsSource.includes("openDouyinLink"), "the original-video link must remain available in playback settings");
  assert(playerSource.includes("function ensureShortVideoPlaybackSettings") && playerSource.includes("playback-settings.js?v=") && playerSource.includes("ensureShortVideoPlaybackSettings()") && playbackSettingsSource.includes("function showPlaybackSettings") && playbackSettingsSource.includes("播放速度") && playbackSettingsSource.includes("删除同组"), "the full playback settings sheet must stay outside the startup bundle");
  assert(playerSource.includes("function scheduleShortVideoPlaybackSettingsWarmup") && playerSource.includes('markShortVideoPerformance("playback-settings-warm-ready")') && playerSource.includes('window.requestIdleCallback(warm, { timeout: 700 })') && playerSource.includes('if (!player.classList.contains("is-ghost") && isCurrentShortVideo(video))'), "playback settings must warm only after the visible video has revealed its first frame");
  assert(playerSource.includes("function ensureShortVideoAuthorPanel") && playerSource.includes("author-panel.js?v=") && playerSource.includes('markShortVideoPerformance("author-panel-module-ready")') && authorPanelSource.includes("function showAuthorPanel") && authorPanelSource.includes("function shortVideoRelatedView") && authorPanelSource.includes("function shortVideoInsightView"), "author, related, recognition, topic, and sound panels must stay outside the direct-video startup bundle");
  assert(playerSource.includes("function ensureShortVideoGalleryPlayer") && playerSource.includes("gallery-player.js?v=") && playerSource.includes('markShortVideoPerformance("gallery-player-module-ready")') && playerSource.indexOf("if (ghost) return placeholder;") < playerSource.indexOf("ensureShortVideoGalleryPlayer().then") && galleryPlayerSource.includes("function renderGalleryPlayer"), "the gallery player must stay outside direct-video startup and adjacent ghost galleries must not load it early");
  assert(playerSource.includes("function ensureShortVideoListCards") && playerSource.includes("list-cards.js?v=") && playerSource.includes('markShortVideoPerformance("list-cards-module-ready")') && playerSource.includes("if (!append && !shortVideoListCards)") && listCardsSource.includes("function renderVideoCard") && listCardsSource.includes("function renderAuthorIndexCard"), "feed and author cards must load with list data instead of inflating direct-video startup");
  assert(viewerSource.includes(".short-video-browser.is-smart-fill .short-video-reel-panel:not(.is-gallery-post)") && viewerSource.includes(".short-video-browser.is-smart-fill .short-video-stage:not(.is-gallery-stage)") && viewerSource.includes("height: 100%"), "smart fill must expand the video stage into the current screen canvas without changing gallery layout");
  assert(viewerSource.includes(".short-video-player {") && viewerSource.includes("position: absolute") && viewerSource.includes("max-height: 100%") && viewerSource.includes("object-fit: contain"), "every video display mode must preserve the complete foreground frame without cropping");
  assert(viewerSource.includes(".short-video-stage:not(.is-gallery-stage)::before") && viewerSource.includes("filter: blur(30px) saturate(.9) brightness(.56)") && viewerSource.includes("transform: scale(1.08)"), "every contained short-video stage must fill empty space with an edge-safe Gaussian-blurred background");
  assert(playerSource.includes("当前浏览器不支持网页全屏"), "short-video fullscreen must explain unsupported browser environments instead of failing silently");
  assert(playerSource.indexOf("rail.append(authorRailButton(video))") < playerSource.indexOf("rail.append(aiButton)"), "short-video rail must keep the author and primary actions above auxiliary AI tools like Douyin");
  assert(playerSource.includes("animateRailActionButton(button, nextActive)") && viewerSource.includes("shortVideoRailActionPulse"), "short-video like and collect actions must provide optimistic Douyin-style motion feedback");
  assert(playerSource.includes("short-video-sound-rail-cover") && viewerSource.includes("shortVideoSoundRailSpin"), "short-video sound actions should use the real sound cover and playback motion");
  assert(responsiveSource.includes(".short-video-sound-rail-cover") && responsiveSource.includes("border-width: 2px;"), "mobile short-video sound covers must fit inside the compact action rail");
  assert(authorPanelSource.includes("primaryTabItems") && authorPanelSource.includes("contextTabItems") && viewerSource.includes(".short-video-author-context-tabs"), "short-video side panels must separate primary Douyin-style tabs from local extension tools");
  assert(authorPanelSource.includes("const syncContextTabOverflow = () =>") && authorPanelSource.includes('"扩展信息，可横向滚动"') && panelSource.includes(".short-video-author-context-tabs.has-overflow.is-scroll-end"), "narrow comment panels must expose horizontally scrollable extension tabs with visible edge affordances");
  assert(playerSource.includes("function ensureShortVideoCommentsView") && playerSource.includes("comments-view.js?v=") && playerSource.includes("lazyShortVideoCommentsView(video, panel)") && commentsViewSource.includes("function shortVideoCommentsView(video)") && commentsViewSource.includes("我的本地评论") && commentsViewSource.includes("同步评论"), "comment synchronization and local editing must load only after the user opens the comment panel instead of inflating video startup");
  assert(playerSource.includes("function ensureShortVideoSharePanel") && playerSource.includes("share-panel.js?v=") && playerSource.includes("ensureShortVideoSharePanel()") && sharePanelSource.includes("function showSharePanel") && sharePanelSource.includes("发送给朋友") && sharePanelSource.includes("复制分享文案") && sharePanelSource.includes("系统分享"), "the full share sheet must load only when requested instead of inflating video startup");
  assert(responsiveSource.includes("@media (max-width: 680px)") && responsiveSource.includes(".short-video-author-panel.is-open .short-video-author-sheet"), "narrow tablet comment panels must become overlay sheets before the player and sidebar overlap");
  assert(playerSource.includes("bindAuthorPanelDragToClose") && playerSource.includes("mouseFallbackActive") && authorPanelSource.includes("向下拖动关闭面板") && responsiveSource.includes("--short-video-author-sheet-drag-y"), "mobile comment sheets must support pointer and mouse drag handles without hijacking content scrolling");
  assert(playerSource.includes('window.addEventListener("pointerup", (event) => settle(event)') && playerSource.includes('window.addEventListener("pointercancel", (event) => settle(event, true)') && playerSource.includes("if (pointerId >= 0) {") && playerSource.includes("moveDrag(event.clientY, event.timeStamp);"), "mobile comment sheet dragging must keep moving and settle even when pointer capture switches between pointer and mouse events");
  assert(playerSource.includes("isolateAuthorPanelAsMobileModal") && playerSource.includes("restoreAuthorPanelModalIsolation") && playerSource.includes('element.setAttribute("inert", "")'), "mobile comment sheets must isolate background playback controls and restore them after closing");
  assert(playerSource.includes("resolveAuthorPanelReturnFocus") && authorPanelSource.includes("panel.dataset.returnFocusTab") && playerSource.includes(".short-video-reel-panel.is-current"), "author and recommendation sheets must restore focus to the matching control after switching the active work");
  assert(playerSource.includes("bindShortVideoModalFocusLoop") && playerSource.includes("focusableSelector") && playerSource.includes("event.shiftKey"), "playback settings and share dialogs must trap keyboard focus inside the active modal");
  assert(playerSource.includes("isolateShortVideoTransientModal") && playerSource.includes("restoreShortVideoTransientModalIsolation") && playerSource.includes("overlay._shortVideoModalSiblings"), "playback settings and share dialogs must isolate background playback controls and restore them after closing");
  assert(playerSource.includes("overlay._shortVideoPausedGallery = gallery") && playerSource.includes('gallery.shortVideoGalleryPause?.("modal")') && playerSource.includes('gallery.shortVideoGalleryResume?.("modal")'), "modal overlays must freeze gallery position and resume only after closing");
  assert(playerSource.includes("focusShortVideoTransientModal") && playerSource.includes("window.requestAnimationFrame(() => window.requestAnimationFrame(focusTarget))"), "playback settings and share dialogs must restore initial focus after inert background processing");
  assert(responsiveSource.includes(".short-video-browser.is-controls-idle .short-video-control-bar:not(.is-gallery)") && responsiveSource.includes("> :not(.short-video-control-progress-wrap)") && responsiveSource.includes("bottom: -6px;"), "idle video playback must keep a thin bottom progress line while hiding secondary controls");
  assert(responsiveSource.includes("inset: auto 0 -8px;"), "mobile idle playback progress must stay pinned inside the viewport bottom edge");
  assert(responsiveSource.includes(".short-video-stage.is-gallery-stage.is-sound-blocked.is-sound-hint-visible::after") && responsiveSource.includes("bottom: max(126px"), "desktop gallery sound prompts must stay above the page counter instead of covering it");
  assert(responsiveSource.includes(".short-video-close,") && responsiveSource.includes(".short-video-browser-search") && responsiveSource.includes("background: rgba(8, 9, 13, .66)") && responsiveSource.includes("backdrop-filter: blur(14px)"), "top playback navigation must remain legible over bright video frames");
  assert(playerSource.includes("showShortVideoSearchOverlay(event.currentTarget)") && playerSource.includes("closeShortVideoSearchOverlay") && !playerSource.includes('search.addEventListener("click", showHomeAndFocusSearch)'), "player search must open over the current video instead of returning to the short-video home first");
  assert(playerSource.includes('overlay.className = "short-video-search-overlay"') && playerSource.includes("isolateShortVideoTransientModal(overlay)") && panelSource.includes(".short-video-search-overlay") && panelSource.includes("backdrop-filter: blur(13px)"), "player search must keep the current video under an accessible dimmed search overlay");
  assert(playerSource.includes('commitShortVideoSearch(query, { global: true, pushRoute: true })') && playerSource.includes('state.shortVideo.author = "all"') && playerSource.includes("replaceRoute: !options.pushRoute"), "player search submission must search globally and preserve the detail route for browser back navigation");
  assert(responsiveSource.includes(".short-video-more-sheet .short-video-more-head") && responsiveSource.includes("position: sticky;") && responsiveSource.includes("top: -17px;"), "short mobile playback sheets must keep their heading and close control reachable while scrolling");
  assert(authorPanelSource.includes('`评论 ${formatShortVideoMetric(video, "comments")}`'), "short-video side panels must expose the current comment count in the primary tab without presenting unknown statistics as zero");
  assert(authorPagesSource.includes("function shortVideoAuthorHandle") && authorPagesSource.includes('replace(/^(?:@\\s*)+/u, "")') && playerSource.includes("name.textContent = shortVideoAuthorHandle(video.author?.name)"), "short-video author handles must normalize imported leading @ signs instead of rendering @@ names");
  assert(authorPagesSource.includes("function renderAuthorSignature") && authorPagesSource.includes("short-video-author-mention") && authorPagesSource.includes("/api/short-videos/authors/resolve?mention=") && listSource.includes(".short-video-author-mention"), "web author signatures must turn @mentions into local author-page navigation");
  assert(playerSource.includes("resolveShortVideoAuthor(requestedAuthorPage)") && playerSource.includes("state.shortVideo.authorDetail = { ...(state.shortVideo.authorDetail || {}), ...author }"), "direct author routes must resolve profile metadata even when the author has no local videos");
  assert(playerSource.includes("syncRelatedPanelCurrentItem") && authorPanelSource.includes("replaceVideoFromAuthorPanel(resolved?.video || video, panel, neighbors)"), "related short-video cards must switch the active work without closing the side panel");
  assert(authorPanelSource.includes("short-video-related-current") && viewerSource.includes("aspect-ratio: 4 / 3"), "related short-video cards must expose the current item with Douyin-style 4:3 thumbnails");
  assert(playerSource.includes("short-video-caption-sound") && viewerSource.includes(".short-video-caption-sound-cover"), "short-video captions must expose the current sound as a first-class local entry");
  assert(playerSource.includes('captionToggle.textContent = "… 展开"') && viewerSource.includes(".short-video-caption-copy.can-expand:not(.is-expanded)"), "long short-video captions must use an inline Douyin-style expand affordance");
  assert(listSource.includes(".short-video-sort-select option") && listSource.includes("color-scheme: dark;"), "author sort options must stay readable in the dark short-video workspace");
  assert(listCardsSource.includes("formatShortVideoMetric(video, \"likes\")") && listSource.includes(".short-video-like-badge.is-unknown"), "unknown short-video statistics must render as a pending placeholder instead of a fake zero");
  assert(playerSource.includes('shell.className = "short-video-home short-video-distribution-page"') && playerSource.includes('shortVideoMode: "likes"') && listSource.includes(".short-video-distribution-page-nav") && !listSource.includes(".short-video-distribution-overlay"), "like distribution must render as a standalone statistics page instead of a modal");
  assert(routerSource.includes('? "/short-videos/stats/likes"') && routerSource.includes('likesStatsPage ? "likes" : "feed"'), "the like distribution page must have a stable dedicated route");
  assert(playerSource.includes("ensureLikeDistributionView") && playerSource.includes("import(moduleUrl)") && playerSource.includes("like-distribution-view.js?v="), "the statistics renderer must load on its own route instead of inflating video-detail startup");
  assert(likeDistributionSource.includes("0-1 万每 1 千一组") && likeDistributionSource.includes("1-10 万每 1 万一组") && likeDistributionSource.includes("10-100 万每 10 万一组") && likeDistributionSource.includes("100-500 万每 100 万一组") && likeDistributionSource.includes("区间按左闭右开统计"), "the statistics page must explain its multiscale long-tail binning rules");
  assert(likeDistributionSource.includes("function likeDistributionDensityPerThousand") && likeDistributionSource.includes("Math.log1p(density) / maxLogDensity") && likeDistributionSource.includes("每千赞 · 对数柱") && listSource.includes(".short-video-distribution-density-value"), "unequal like bins must compare normalized per-thousand density with an explicit logarithmic bar scale");
  assert(likeDistributionSource.includes("function renderLikeDistributionLogChart") && likeDistributionSource.includes("点赞—密度双对数图") && likeDistributionSource.includes("xLog: Math.log10(centerLikes)") && likeDistributionSource.includes("yLog: Math.log10(density)") && likeDistributionSource.includes("只统计本地已下载视频") && listSource.includes(".short-video-distribution-log-chart"), "the statistics page must distinguish the selected local sample and expose a separate log-log distribution chart for candidate feature values");
  assert(likeDistributionSource.includes("Math.log10(200000)") && likeDistributionSource.includes("20-100万已回测") && likeDistributionSource.includes("minLikes >= 200000") && likeDistributionSource.includes('tag.textContent = "已回测"'), "the cumulative quality-audit band must include the newly audited 20w-50w range without losing the existing 50w-100w coverage");
  assert(likeDistributionSource.includes("function renderContentValueMap") && likeDistributionSource.includes("内容传播结构图") && likeDistributionSource.includes("藏 / 赞（对数轴）→") && likeDistributionSource.includes("转 / 赞（对数轴）→") && likeDistributionSource.includes("insightAxisRate") && listSource.includes(".short-video-insight-map-chart"), "the statistics page must plot real save/share ratios on readable log axes while comparing content types inside similar like-count bands");
  const contentInsightPanelSource = likeDistributionSource.slice(likeDistributionSource.indexOf("function renderLikeDistributionPanel"));
  assert(!contentInsightPanelSource.includes("renderHighResInsight(") && shortVideoRoutesSource.includes("shortVideoStore.queueQualityUpgrades"), "content insights must not duplicate the downloader's already-automatic highest-quality workflow");
  assert(likeDistributionSource.includes("function renderInsightRankings") && likeDistributionSource.includes("作者样本表现") && likeDistributionSource.includes("题材样本表现") && likeDistributionSource.includes("前 20%：") && listSource.includes(".short-video-insight-ranking-columns"), "content insights must expose honest author and topic sample performance as navigable follow-up lists");
  assert(likeDistributionSource.includes("short-video-distribution-legacy") && likeDistributionSource.includes("查看样本结构与点赞分布（研究用）"), "the descriptive long-tail chart must remain available without dominating the action dashboard");
  assert(likeDistributionSource.includes("function renderLikeDistributionDetailTable") && likeDistributionSource.includes('pending.textContent = "展开后生成研究图表…"') && likeDistributionSource.includes('legacy.addEventListener("toggle", scheduleLegacyBuild)') && likeDistributionSource.includes("legacyBody.replaceChildren(renderLikeDistributionLogChart(bins))") && likeDistributionSource.includes("window.requestAnimationFrame"), "the collapsed research-only distribution chart and table must be built lazily across animation frames instead of inflating the initial statistics DOM");
  assert(playerSource.includes("short-video-caption-context-button") && viewerSource.includes(".short-video-caption-context"), "short-video caption tools must stay visible and touch-accessible");
  assert(authorPanelSource.includes('sort.className = "short-video-author-sort-select"') && authorPanelSource.includes('sort.setAttribute("aria-label", "作者作品排序")') && authorPanelSource.includes('params.set("sort", nextSort)') && authorPanelSource.includes("switchToAuthorWorksFeed(video, author, panel, authorWorksSort)") && viewerSource.includes(".short-video-author-sort-select"), "author side-panel works must expose server-backed sorting and preserve that order when entering the author feed");
  assert(playerSource.includes("disposeShortVideoMedia") && playerSource.includes('querySelectorAll?.("video, audio")'), "short-video work switches must explicitly stop both video and gallery background audio");
  const activePlayerSource = playerSource.slice(playerSource.indexOf("function activePlayer()"), playerSource.indexOf("function closeTransientPlayerControls()"));
  assert(!activePlayerSource.includes("short-video-gallery-image"), "gallery live-photo clips must not become the global sound player");
  const promoteAdjacentSource = playerSource.slice(playerSource.indexOf("function promoteAdjacentPanelDom"), playerSource.indexOf("function promoteAdjacentMedia"));
  assert(promoteAdjacentSource.indexOf('const previousPlayer = outgoing.querySelector(".short-video-player")') < promoteAdjacentSource.indexOf('player.muted = Boolean(state.shortVideo.muted);'), "adjacent video switches must silence the outgoing player before restoring incoming sound");
  assert(galleryPlayerSource.includes("syncGalleryCaptionState") && galleryPlayerSource.includes("short-video-caption-meta") && viewerSource.includes("shortVideoCaptionMetaNext"), "gallery page changes must keep the caption page indicator in sync with directional feedback");
  assert(galleryPlayerSource.includes("gallerySoundState") && viewerSource.includes(".short-video-caption-sound-cover.is-playing"), "gallery background music state must stay visible across page changes");
  assert(authorPanelSource.includes("needsGallerySoundRefresh") && authorPanelSource.includes("replaceCurrentReelDom(state.shortVideo.current)"), "related gallery switches must attach sound when richer detail arrives after the lightweight card");
  assert(playerSource.includes("shortVideoResolvedDetailCache") && authorPanelSource.includes("resolvedShortVideoDetail(video.id)"), "related short-video switches must distinguish resolved detail from an in-flight request");
  assert(playerSource.includes("prefetchRelatedVideo") && playerSource.includes("prefetchShortVideoFirstMedia") && playerSource.includes("requestIdleCallback"), "related short-video cards must prefetch full detail and first media before opening");
  assert(playerSource.includes("function prewarmShortVideoPlayback") && playerSource.includes("waitForVideoFirstFrame(player, timeout)") && playerSource.includes("SHORT_VIDEO_PLAYBACK_PRELOAD_LIMIT = 1"), "web short-video cards must decode only one bounded first-frame preload before playback");
  assert(playerSource.includes("let timeoutHandle = 0") && playerSource.includes('player.addEventListener("error", onUnavailable, { once: true })') && playerSource.includes('player.addEventListener("emptied", onUnavailable, { once: true })') && playerSource.includes("window.clearTimeout(timeoutHandle)"), "first-frame waits must release timeout closures and painted-frame callbacks immediately after success, media failure, or decoder release");
  assert(playerSource.includes("shortVideoAdjacentWarmDirection") && playerSource.includes("function releaseOffscreenVideoDecoder") && playerSource.includes('player.dataset.shortVideoDecoderReleased = "1"') && playerSource.includes('releaseOffscreenVideoDecoder(opposite, `adjacent-${oppositeSlot}`)'), "the short-video viewer must keep only the current and likely navigation direction decoded");
  assert.match(playerSource, /player\.dataset\.streamUrl\s*\|\|\s*shortVideoPlaybackUrl\(video\)\s*\|\|\s*player\.currentSrc/, "released adjacent players must resume from the adaptive smooth URL rather than the original HEVC stream");
  assert(!playerSource.includes('document.createElement(useStaticBackdrop ? "img" : "video")') && playerSource.includes('document.createElement(staticBackdropUrl ? "img" : "div")'), "missing covers must use a static backdrop instead of decoding the active 4K stream twice");
  assert(playerSource.includes("function takePrewarmedShortVideoPlayer") && playerSource.includes("player = ghost ? null : takePrewarmedShortVideoPlayer(video)"), "the active reel must reuse the exact video element that performed first-frame warmup");
  assert(listCardsSource.includes('open.addEventListener("pointerdown", prewarmPlayback') && listCardsSource.includes("openVideo(video.id, { video })") && playerSource.includes("hydratePromotedShortVideo(openingVideo)"), "opening a feed card must start warmup immediately, render from cached data, and hydrate detail in the background");
  assert(authorPanelSource.includes('button.dataset.detailReady = "1"') && viewerSource.includes(".short-video-related-item.is-opening"), "related short-video cards must expose prefetch readiness and fallback opening feedback");
  assert(authorPanelSource.includes("replaceCurrentReelDom(video, { transition: true })") && authorPanelSource.includes("cloneNode(true)") && authorPanelSource.includes("is-transition-outgoing"), "direct related switches must retain a static outgoing gallery frame during the first-media transition");
  assert(viewerSource.includes("shortVideoDirectIncoming") && viewerSource.includes("shortVideoDirectOutgoing"), "direct related switches must cross-fade incoming and outgoing work panels");
  assert(playerSource.includes('event.key?.toLowerCase?.() === "f"'), "short-video fullscreen must support the desktop F shortcut");
  assert(playerSource.includes("if (document.fullscreenElement) toggleShortVideoFullscreen();\n        else closeOrRevealBrowser();"), "Escape must leave fullscreen before it is allowed to close the active short-video player");
  assert(playerSource.includes('window.matchMedia?.("(max-width: 680px)")?.matches') && playerSource.includes("轻触画面恢复操作界面") && playbackSettingsSource.includes('window.matchMedia?.("(max-width: 680px)")?.matches') && playbackSettingsSource.includes("进入后轻触画面恢复"), "mobile clear-screen playback must explain the touch gesture that restores the interface");
  assert(playerSource.includes("setVolumePopoverOpen(!compactVolume)") && playerSource.includes("if (!player.paused) {\n          clearPlayerSoundBlocked(stage);") && playerSource.includes("markPlayerSoundBlocked(stage);"), "mobile volume taps must toggle mute without opening the desktop slider or falsely re-muting a player that kept playing");
  assert(galleryPlayerSource.includes("clip.onended = () =>"), "gallery video items must advance only after playback ends");
  assert(galleryPlayerSource.includes("if (images.length > 1 && wrap.isConnected"), "single-item gallery videos must finish their progress without trying to navigate away");
  assert(galleryPlayerSource.includes("currentTime / duration") && galleryPlayerSource.includes("--short-video-gallery-media-progress"), "gallery live-video progress must follow actual media time instead of appearing complete immediately");
  assert(viewerSource.includes("scaleX(var(--short-video-gallery-media-progress, 0))"), "gallery live-video segments must render the synchronized media progress ratio");
  assert(galleryPlayerSource.includes("advanceRemainingMs = Math.max(0, advanceRemainingMs - (Date.now() - advanceStartedAt))"), "gallery image timing must preserve the remaining auto-advance delay while hidden");
  assert(galleryPlayerSource.includes("wrap.shortVideoGalleryPause = pauseAutoAdvance"), "gallery players must expose lifecycle pause support");
  assert(galleryPlayerSource.includes("wrap.shortVideoGalleryResume = resumeAutoAdvance") && playerSource.includes("gallery?.shortVideoGalleryResume?.()"), "gallery players must resume image timing and mixed-video playback after returning to the page");
  assert(galleryPlayerSource.includes('audio.className = "short-video-player short-video-gallery-audio"'), "gallery posts must play downloaded background music through the shared player lifecycle");
  assert(playerSource.includes("video.galleryItems"), "gallery rendering must accept ordered image and video items");
  assert(galleryPlayerSource.includes("scheduleLocalSoundPoll") && galleryPlayerSource.includes('metadata: "1"'), "open galleries must refresh rich metadata so newly downloaded background music becomes visible");
  assert(galleryPlayerSource.includes("scheduleLocalSoundPoll(0)") && galleryPlayerSource.includes("delayMs = 15000"), "gallery background music must refresh immediately once and keep later polling lightweight");
  assert(serverConfigSource.includes("FANHAO_DOUYIN_SYNC_MS || 60 * 1000"), "download-manager changes must be detected within one minute by default");
  assert(responsiveSource.includes(".short-video-gallery-progress") && responsiveSource.includes("display: none;"), "mobile gallery must keep the image counter without the desktop progress strip");
  assert(playerSource.includes("SHORT_VIDEO_GALLERY_GESTURE_HINT_KEY") && galleryPlayerSource.includes("左右滑动翻图 · 上下滑动切作品") && galleryPlayerSource.includes("sessionStorage?.setItem"), "mobile galleries must explain both navigation gestures once per browsing session");
  assert(viewerSource.includes(".short-video-gallery-gesture-hint") && responsiveSource.includes(".short-video-gallery-gesture-hint.is-visible"), "the mobile gallery gesture hint must stay hidden on desktop and fade in without blocking media input");
  assert(playerSource.includes("openAdjacent(direction, { motion: wheelMotion })"), "short-video wheel navigation must finish with motion-adaptive timing");
  assert(playerSource.includes('classList.toggle("is-volume-open", expanded)'), "short-video volume popover must expose its open state to responsive layout");
  assert(playerSource.includes("const wasPlaying = !player.paused && !player.ended;"), "short-video mute changes must preserve active playback intent");
  assert(playerSource.includes("if (wasPlaying) player.play?.().catch(() => {});"), "short-video volume changes must preserve active playback intent");
  assert(playerSource.includes("let shortVideoVisibilitySnapshot = null;"), "short-video visibility changes must retain playback intent");
  assert(playerSource.includes("wasPlaying: Boolean(current && !current.paused && !current.ended)"), "short-video visibility changes must record whether playback was active");
  assert(playerSource.includes("if (!resume?.wasPlaying || resume.videoId !== currentVideoId)"), "short-video visibility restore must not autoplay paused or replaced videos");
  assert(playerSource.includes("current.muted = Boolean(state.shortVideo.muted);"), "short-video visibility restore must retain the user's paused sound preference");
  assert(playerSource.includes("function markPlayerSoundBlocked(stage)"), "short-video autoplay fallback must expose a bounded sound hint");
  const restoreSoundSource = playerSource.slice(playerSource.indexOf("function restorePlayerSound"), playerSource.indexOf("function activeShortVideoStage"));
  assert(restoreSoundSource.includes("player.play?.().catch") && restoreSoundSource.includes("if (!player.paused)") && !restoreSoundSource.includes("if (!shouldResume) return"), "clicking a blocked-sound video must preserve audible playback and ignore rejected play promises when media is already running");
  assert(playerSource.includes('if (stage.classList.contains("is-sound-blocked")) {\n          event.preventDefault();'), "the first sound-restoration click must not fall through to native playback toggling");
  assert(playerSource.includes("}, 2400);"), "short-video sound hint must clear without blocking later sound recovery");
  assert(playerSource.includes("const SHORT_VIDEO_DOUBLE_TAP_WINDOW_MS = 520;"), "short-video playback intent must survive the browser's full double-tap window");
  assert((playerSource.match(/event\.pointerType === "touch"/g) || []).length >= 4, "touch gestures must not be settled again by duplicate pointer events");
  assert(playerSource.includes("markShortVideoGestureClickBlocked(event.target);"), "short-video swipes must suppress the browser's synthetic follow-up click");
  assert(galleryPlayerSource.includes("if (isShortVideoGestureClickBlocked(wrap)) return;"), "gallery swipes must not toggle playback through a synthetic click");
  assert(galleryPlayerSource.includes('setIconButton(centerPlay, "play", "继续播放图集")') && galleryPlayerSource.includes("galleryUserPaused && currentReady"), "paused galleries must expose a centered resume control like Douyin");
  assert(galleryPlayerSource.includes('counter.classList.add(direction > 0 ? "is-page-next" : "is-page-previous")') && galleryPlayerSource.includes("syncGalleryCaptionState(direction)"), "gallery media, page counter, and caption metadata must commit with the same direction");
  assert(galleryPlayerSource.includes("requestedIndex = currentIndex;") && galleryPlayerSource.includes('loadRetry.setAttribute("aria-label", `重试载入第 ${index + 1} 项`)'), "failed gallery loads must retain the committed page and expose a retry action");
  assert(galleryPlayerSource.includes('wrap.dataset.gallerySoundMuted = muted ? "1" : "0";') && galleryPlayerSource.includes('audio.addEventListener("volumechange", syncGallerySoundState)'), "gallery sound visuals must distinguish muted playback from audible playback");
  assert(galleryPlayerSource.includes('stage?.classList.contains("is-sound-blocked") && backgroundAudio') && galleryPlayerSource.includes('result === "playing"'), "blocked gallery autoplay must only report success after audio actually starts");
  assert(galleryPlayerSource.includes("wrap.shortVideoGalleryPlaySound = playGallerySound") && playerSource.includes("gallery?.shortVideoGalleryPlaySound?.();"), "the gallery sound control must start paused audio after unmuting");
  assert(galleryPlayerSource.includes("wrap.shortVideoGalleryRestoreSound = restoreGallerySound") && playerSource.includes("gallery?.shortVideoGalleryRestoreSound?.()"), "the gallery sound button must restore blocked audio inside the user's click gesture");
  assert(playerSource.includes('mute.addEventListener("pointerdown"') && playerSource.includes("shortVideoSoundRestoredOnPointerDown") && viewerSource.includes(".short-video-gallery-sound-toggle.is-pending") && viewerSource.includes("cursor: pointer"), "pending and blocked gallery sound must remain visibly clickable and start restoration from the physical pointer gesture");
  assert(galleryPlayerSource.includes("wrap.shortVideoGalleryRefreshSound = async") && playerSource.includes("gallery?.shortVideoGalleryRefreshSound?.()") && playerSource.includes("背景音乐准备中，点击刷新") && !playerSource.includes("mute.disabled = !localReady"), "pending gallery sound must remain clickable and refresh local availability on demand");
  assert(playerSource.includes("pendingPlayerTap = {"), "short-video taps must remember playback intent while arbitrating a double tap");
  assert(playerSource.includes("player.dataset.shortVideoTapWasPlaying = pendingPlayerTap.wasPlaying ? \"1\" : \"0\";"), "short-video tap intent must stay attached to the video that receives the double tap");
  assert(playerSource.includes("if (tap && tap.player?.dataset?.shortVideoTapToken === tap.token)"), "short-video tap cleanup must tolerate an empty initial tap state");
  assert(playerSource.includes("togglePlay();\n        playerClickTimer = window.setTimeout"), "short-video single taps must toggle playback immediately instead of waiting for double-tap arbitration");
  assert(playerSource.includes("const tapWasPlaying = player.dataset.shortVideoTapWasPlaying;"), "short-video double taps must recover the receiving video's playback intent");
  assert(playerSource.includes('if (tapWasPlaying === "1" && player.paused)'), "short-video double taps must restore active playback after liking");
  assert(playerSource.includes("player.dataset.shortVideoTapPauseGuard = pauseGuard;"), "short-video double taps must guard against an in-flight play when the video started paused");
  assert(playerSource.includes('player.addEventListener("play", enforcePausedTapState);'), "short-video paused-state restoration must catch late play events");
  assert(playerSource.includes("}, 240);"), "short-video paused-state guard must clear quickly after double-tap arbitration");
  assert(playerSource.includes("if (pendingPlayerTap?.player !== player) clearPendingPlayerClick();"), "short-video hold gestures must preserve the first tap's intent through the second pointerdown");
  assert(playerSource.includes("scrubPlayer?.pause?.()"), "short-video progress dragging must pause decode contention while scrubbing");
  assert(playerSource.includes("scrubSeekRaf = window.requestAnimationFrame"), "short-video progress dragging must throttle seeks to rendered frames");
  assert(playerSource.includes('typeof player.fastSeek === "function"'), "short-video progress dragging should use fast seeks when the browser supports them");
  assert(playerSource.includes("if (shouldResume) player.play?.().catch(() => {});"), "short-video progress dragging must restore prior playback intent");
  assert(viewerSource.includes("backface-visibility: hidden;"), "short-video reel surfaces must stay compositor-stable during transitions");
  assert(viewerSource.includes(".short-video-stage.is-sound-blocked.is-sound-hint-visible::after"), "short-video sound hint must be tied to an explicit transient state");
  assert(viewerSource.includes("@keyframes shortVideoSoundHint"), "short-video sound hint must fade without persistent obstruction");
  assert(staticServerSource.includes("createBrotliCompress"), "static delivery must support Brotli compression");
  assert(staticServerSource.includes('"Content-Encoding": encoding'), "static delivery must advertise compression");
  assert(staticServerSource.includes("CONTENT_HASH_VERSION") && staticServerSource.includes("max-age=31536000, immutable"), "content-hashed static assets must stay immutable without trusting hand-maintained version labels");
  assert(
    responsiveSource.includes("top: auto;") && responsiveSource.includes("bottom: max(70px, calc(env(safe-area-inset-bottom) + 66px));"),
    "mobile short-video rail must anchor above the bottom controls"
  );
  assert(
    responsiveSource.includes("@media (max-width: 560px) and (max-height: 620px)")
      && responsiveSource.includes("min-height: 38px;"),
    "short-height players must compact the action rail"
  );
  assert(
    responsiveSource.includes(".short-video-browser.is-volume-open .short-video-rail")
      && responsiveSource.includes("pointer-events: none;"),
    "mobile volume adjustment must not collide with the action rail"
  );
  assert(
    responsiveSource.includes("@media (max-width: 360px)")
      && responsiveSource.includes("grid-template-columns: 30px 64px minmax(0, 1fr);")
      && responsiveSource.includes(".short-video-control-tools")
      && responsiveSource.includes("gap: 0 4px;"),
    "narrow short-video controls must fit without dropping core actions"
  );
  assert(
    responsiveSource.includes(".short-video-stage.is-sound-blocked.is-sound-hint-visible ~ .short-video-caption"),
    "mobile captions should move only while the transient sound hint is visible"
  );
}

function relative(filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, "/");
}
