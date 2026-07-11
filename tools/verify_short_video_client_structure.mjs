import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createShortVideoViews } from "../android-client/www/modules/short-videos/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleDir = path.join(root, "android-client", "www", "modules", "short-videos");
const requiredParts = [
  "api.js",
  "index.js",
  "shared.js",
  "list/controller.js",
  "list/view.js",
  "panels/author-panel.js",
  "panels/playback-panels.js",
  "platform/native-player.js",
  "player/interactions.js",
  "player/media-cache.js",
  "player/native-feed.js",
  "player/reel-controller.js",
  "ui/icons.js",
  "styles/list.css",
  "styles/reel.css",
  "styles/author-panel.css",
  "styles/playback-panels.css"
];

for (const relativePath of requiredParts) {
  assert(fs.statSync(path.join(moduleDir, relativePath), { throwIfNoEntry: false })?.isFile(), `missing short-video part: ${relativePath}`);
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

const styles = fs.readFileSync(path.join(moduleDir, "styles.css"), "utf8");
for (const style of ["list", "reel", "author-panel", "playback-panels"]) {
  assert(styles.includes(`./styles/${style}.css`), `missing short-video CSS import: ${style}`);
}

const androidEntrySource = fs.readFileSync(path.join(moduleDir, "android-module.js"), "utf8");
const androidListSource = fs.readFileSync(path.join(moduleDir, "list", "view.js"), "utf8");
const androidListStyles = fs.readFileSync(path.join(moduleDir, "styles", "list.css"), "utf8");
assert(androidEntrySource.includes('view: "shortVideoSearch"'), "Android short-video search must use a dedicated route");
assert(androidEntrySource.includes("short-video-chrome-row"), "Android short-video chrome must keep search and groups in one compact row");
assert(!androidEntrySource.includes("short-video-chrome-sort"), "Android short-video chrome must not reserve a separate sorting tag");
assert(androidEntrySource.includes("if (value === activeGroup)") && androidEntrySource.includes("openSortDialog(host, params)"), "tapping the active Android short-video group must open sorting");
assert(androidEntrySource.indexOf('row.append(search)') > androidEntrySource.indexOf('for (const [value, label]'), "Android short-video search must stay at the far right of the group row");
assert(androidEntrySource.includes("short-video-sort-overlay"), "Android short-video sorting must open a compact dialog");
assert(androidListSource.includes("short-video-search-page-form"), "Android short-video search route must render its own search form");
assert(!androidListSource.includes("renderSearchFilters"), "Android short-video search must not retain the shared shell filter renderer");
assert(!androidListSource.includes("`${formatCompact(listState.data?.total || 0)} 条"), "Android short-video lists must not render total video counts");
assert(!androidListSource.includes("author.count || 0"), "Android short-video author cards must not render author totals");
assert(!androidListSource.includes("shell.append(renderLibraryTabs()"), "Android short-video group tabs must live in module chrome, not a second row");
const browserPanelStyles = androidListStyles.slice(
  androidListStyles.indexOf("body.short-video-mobile-browser-view #contentPanel"),
  androidListStyles.indexOf("body.short-video-mobile-browser-view #viewContent")
);
assert(browserPanelStyles.includes("border: 0;") && browserPanelStyles.includes("box-shadow: none;"), "Android short-video playback must clear the shared content panel frame");

const views = createShortVideoViews({
  els: {},
  getActiveUrl: () => "http://127.0.0.1:29998",
  goBack() {},
  setActiveBottom() {},
  showView() {}
});
assert.deepEqual(
  Object.keys(views).sort(),
  ["deactivate", "getSearchState", "renderBrowser", "renderList", "renderSearch", "submitSearch"],
  "short-video public contract changed"
);

const appSource = fs.readFileSync(path.join(root, "android-client", "www", "app.js"), "utf8");
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
  const playerSource = fs.readFileSync(path.join(root, "public", "modules", "short-videos", "short-video-page.js"), "utf8");
  const viewerSource = fs.readFileSync(path.join(root, "public", "modules", "short-videos", "styles", "viewer.css"), "utf8");
  const galleryNavigationSource = fs.readFileSync(path.join(root, "public", "modules", "short-videos", "styles", "gallery-navigation.css"), "utf8");
  const listSource = fs.readFileSync(path.join(root, "public", "modules", "short-videos", "styles", "list.css"), "utf8");
  const panelSource = fs.readFileSync(path.join(root, "public", "modules", "short-videos", "styles", "panels.css"), "utf8");
  const responsiveSource = fs.readFileSync(path.join(root, "public", "modules", "short-videos", "styles", "responsive.css"), "utf8");
  const staticServerSource = fs.readFileSync(path.join(root, "src", "platform", "server", "static-files.js"), "utf8");
  const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");

  assert(
    indexSource.includes("const shortVideoEntry =") && indexSource.includes('import("/short-video-app.js?v='),
    "web shell must route short-video URLs to the dedicated entry"
  );
  assert(entrySource.includes("createShortVideoPage"), "dedicated web entry must create the short-video page");
  assert(entrySource.includes('element.inert = true') && entrySource.includes('"#adminModal"') && entrySource.includes('"#detailDrawer"'), "dedicated short-video entry must isolate unrelated shell dialogs from keyboard focus");
  assert(entrySource.includes("openRouteTarget"), "dedicated web entry must restore direct video routes");
  assert(entrySource.includes('next.view !== "shortVideos"'), "dedicated web entry must hand non-short-video history routes back to the full shell");
  for (const unrelatedModule of ["gallery-page", "gallery-renderer", "music-page", "novel-page", "people-page", "admin-modal"]) {
    assert(!entrySource.includes(unrelatedModule), `dedicated web entry must not import ${unrelatedModule}`);
  }
  assert(playerSource.includes("keepalive: true"), "short-video watch writes must survive page exit");
  assert(playerSource.includes("let shortVideoListRequestId = 0;") && playerSource.includes("const requestId = ++shortVideoListRequestId;") && playerSource.includes("if (requestId !== shortVideoListRequestId) return;"), "short-video list responses must ignore stale source and sort requests");
  assert(playerSource.includes('state.shortVideo.source === "liked" ? "入库时间" : "发布时间"'), "short-video time sorting must name the active ingestion or publication timestamp");
  assert(responsiveSource.includes(".short-video-control-volume .short-video-volume-popover") && responsiveSource.includes("display: none;"), "mobile video controls must keep the desktop volume slider out of the caption and action rail");
  assert(playerSource.includes('toggleActiveMute().then((soundOn) =>') && playerSource.includes('showBrowserToast(soundOn ? "声音已开启" : "已静音")'), "keyboard mute must report the final browser-approved sound state");
  assert(playerSource.includes('["F", "进入 / 退出全屏"]') && playerSource.includes('["双击画面", "点赞当前作品"]'), "desktop shortcut help must expose fullscreen and Douyin-style double-click liking");
  assert(playerSource.includes('galleryMode ? "播放 / 暂停图集" : "播放 / 暂停视频"') && playerSource.includes('galleryMode ? "切换图集内容" : "视频快退 / 快进 5 秒"') && playerSource.includes('if (!galleryMode) sheet.append(speedSection);'), "gallery playback settings must describe gallery controls and must not change background-music speed");
  assert(playerSource.includes("function setReelPanelInteractionState(panel, interactive)") && playerSource.includes("panel.inert = !interactive") && playerSource.includes("setReelPanelInteractionState(incoming, true)") && playerSource.includes("setReelPanelInteractionState(outgoing, false)"), "reel promotion must expose only the current work to keyboard and assistive interaction");
  assert(playerSource.includes("const SHORT_VIDEO_WHEEL_DISTANCE = 82;"), "short-video wheel navigation must use a responsive gesture threshold");
  assert(playerSource.includes("`${currentIndex + 1}/${images.length}`"), "gallery counter must use the compact Douyin-style 1/5 format");
  assert(playerSource.includes("pager.append(previous, counter, next)"), "desktop gallery navigation must group previous, counter, and next controls");
  assert(viewerSource.includes(".short-video-gallery-pager") && viewerSource.includes("bottom: max(74px"), "desktop gallery navigation must stay centered above the playback bar");
  assert(playerSource.includes("short-video-gallery-edge-nav") && galleryNavigationSource.includes(".short-video-gallery-player:hover .short-video-gallery-edge-nav") && responsiveSource.includes(".short-video-gallery-edge-nav"), "desktop galleries must expose Douyin-style edge navigation while mobile keeps swipe-first controls");
  assert(viewerSource.includes(".short-video-gallery-progress") && viewerSource.includes("bottom: max(48px"), "desktop gallery progress must follow Douyin's bottom-aligned segmented timeline");
  assert(playerSource.includes("resolveGalleryIndex") && playerSource.includes("SHORT_VIDEO_GALLERY_ADVANCE_MS"), "gallery navigation must loop continuously like Douyin's note viewer");
  assert(playerSource.includes("let advanceRemainingMs = SHORT_VIDEO_GALLERY_ADVANCE_MS;"), "gallery images must use the shared Douyin-style auto-advance interval");
  assert(playerSource.includes("is-gallery-timing-paused") && viewerSource.includes("shortVideoGallerySegmentProgress"), "gallery progress must animate with playback time and pause with page visibility");
  assert(playerSource.includes("const projectedDelta = rawDelta + velocity * 180;") && playerSource.includes("--short-video-gallery-settle-duration"), "gallery drag release must use velocity projection and motion-adaptive settling");
  assert(viewerSource.includes(".short-video-reel-panel.is-gallery-post") && viewerSource.includes(".short-video-stage.is-gallery-stage"), "gallery pages must keep a stable full-canvas stage across portrait and landscape items");
  assert(playerSource.includes("function activeShortVideoFullscreenTarget()") && playerSource.includes('querySelector?.(".short-video-browser")') && playerSource.includes('fullscreenElement.classList?.contains?.("short-video-browser")') && playerSource.includes("async function toggleShortVideoFullscreen()") && playerSource.includes('document.addEventListener("fullscreenchange", syncShortVideoFullscreenControls)'), "short-video fullscreen must include captions, action rail, controls, and stay synchronized after Escape");
  assert(viewerSource.includes(".short-video-browser:fullscreen") && viewerSource.includes("width: 100vw") && viewerSource.includes("height: 100vh"), "short-video fullscreen shell must fill the display without dropping player controls");
  assert(playerSource.includes("当前浏览器不支持网页全屏"), "short-video fullscreen must explain unsupported browser environments instead of failing silently");
  assert(playerSource.indexOf("rail.append(authorRailButton(video))") < playerSource.indexOf("rail.append(aiButton)"), "short-video rail must keep the author and primary actions above auxiliary AI tools like Douyin");
  assert(playerSource.includes("animateRailActionButton(button, nextActive)") && viewerSource.includes("shortVideoRailActionPulse"), "short-video like and collect actions must provide optimistic Douyin-style motion feedback");
  assert(playerSource.includes("short-video-sound-rail-cover") && viewerSource.includes("shortVideoSoundRailSpin"), "short-video sound actions should use the real sound cover and playback motion");
  assert(responsiveSource.includes(".short-video-sound-rail-cover") && responsiveSource.includes("border-width: 2px;"), "mobile short-video sound covers must fit inside the compact action rail");
  assert(playerSource.includes("primaryTabItems") && playerSource.includes("contextTabItems") && viewerSource.includes(".short-video-author-context-tabs"), "short-video side panels must separate primary Douyin-style tabs from local extension tools");
  assert(playerSource.includes("const syncContextTabOverflow = () =>") && playerSource.includes('"扩展信息，可横向滚动"') && panelSource.includes(".short-video-author-context-tabs.has-overflow.is-scroll-end"), "narrow comment panels must expose horizontally scrollable extension tabs with visible edge affordances");
  assert(responsiveSource.includes("@media (max-width: 680px)") && responsiveSource.includes(".short-video-author-panel.is-open .short-video-author-sheet"), "narrow tablet comment panels must become overlay sheets before the player and sidebar overlap");
  assert(playerSource.includes("bindAuthorPanelDragToClose") && playerSource.includes("mouseFallbackActive") && playerSource.includes("向下拖动关闭面板") && responsiveSource.includes("--short-video-author-sheet-drag-y"), "mobile comment sheets must support pointer and mouse drag handles without hijacking content scrolling");
  assert(playerSource.includes('window.addEventListener("pointerup", (event) => settle(event)') && playerSource.includes('window.addEventListener("pointercancel", (event) => settle(event, true)') && playerSource.includes("if (pointerId >= 0) {") && playerSource.includes("moveDrag(event.clientY, event.timeStamp);"), "mobile comment sheet dragging must keep moving and settle even when pointer capture switches between pointer and mouse events");
  assert(playerSource.includes("isolateAuthorPanelAsMobileModal") && playerSource.includes("restoreAuthorPanelModalIsolation") && playerSource.includes('element.setAttribute("inert", "")'), "mobile comment sheets must isolate background playback controls and restore them after closing");
  assert(playerSource.includes("resolveAuthorPanelReturnFocus") && playerSource.includes("panel.dataset.returnFocusTab") && playerSource.includes(".short-video-reel-panel.is-current"), "author and recommendation sheets must restore focus to the matching control after switching the active work");
  assert(playerSource.includes("bindShortVideoModalFocusLoop") && playerSource.includes("focusableSelector") && playerSource.includes("event.shiftKey"), "playback settings and share dialogs must trap keyboard focus inside the active modal");
  assert(playerSource.includes("isolateShortVideoTransientModal") && playerSource.includes("restoreShortVideoTransientModalIsolation") && playerSource.includes("overlay._shortVideoModalSiblings"), "playback settings and share dialogs must isolate background playback controls and restore them after closing");
  assert(playerSource.includes("overlay._shortVideoPausedGallery = gallery") && playerSource.includes('gallery.shortVideoGalleryPause?.("modal")') && playerSource.includes('gallery.shortVideoGalleryResume?.("modal")'), "modal overlays must freeze gallery position and resume only after closing");
  assert(playerSource.includes("focusShortVideoTransientModal") && playerSource.includes("window.requestAnimationFrame(() => window.requestAnimationFrame(focusTarget))"), "playback settings and share dialogs must restore initial focus after inert background processing");
  assert(responsiveSource.includes(".short-video-browser.is-controls-idle .short-video-control-bar:not(.is-gallery)") && responsiveSource.includes("> :not(.short-video-control-progress-wrap)") && responsiveSource.includes("bottom: -6px;"), "idle video playback must keep a thin bottom progress line while hiding secondary controls");
  assert(responsiveSource.includes("inset: auto 0 -8px;"), "mobile idle playback progress must stay pinned inside the viewport bottom edge");
  assert(responsiveSource.includes(".short-video-stage.is-gallery-stage.is-sound-blocked.is-sound-hint-visible::after") && responsiveSource.includes("bottom: max(126px"), "desktop gallery sound prompts must stay above the page counter instead of covering it");
  assert(responsiveSource.includes(".short-video-close,") && responsiveSource.includes(".short-video-browser-search") && responsiveSource.includes("background: rgba(8, 9, 13, .66)") && responsiveSource.includes("backdrop-filter: blur(14px)"), "top playback navigation must remain legible over bright video frames");
  assert(responsiveSource.includes(".short-video-more-sheet .short-video-more-head") && responsiveSource.includes("position: sticky;") && responsiveSource.includes("top: -17px;"), "short mobile playback sheets must keep their heading and close control reachable while scrolling");
  assert(playerSource.includes('`评论 ${formatShortVideoMetric(video, "comments")}`'), "short-video side panels must expose the current comment count in the primary tab without presenting unknown statistics as zero");
  assert(playerSource.includes("function shortVideoAuthorHandle") && playerSource.includes('replace(/^(?:@\\s*)+/u, "")') && playerSource.includes("name.textContent = shortVideoAuthorHandle(video.author?.name)"), "short-video author handles must normalize imported leading @ signs instead of rendering @@ names");
  assert(playerSource.includes("syncRelatedPanelCurrentItem") && playerSource.includes("replaceVideoFromAuthorPanel(resolved?.video || video, panel, neighbors)"), "related short-video cards must switch the active work without closing the side panel");
  assert(playerSource.includes("short-video-related-current") && viewerSource.includes("aspect-ratio: 4 / 3"), "related short-video cards must expose the current item with Douyin-style 4:3 thumbnails");
  assert(playerSource.includes("short-video-caption-sound") && viewerSource.includes(".short-video-caption-sound-cover"), "short-video captions must expose the current sound as a first-class local entry");
  assert(playerSource.includes('captionToggle.textContent = "… 展开"') && viewerSource.includes(".short-video-caption-copy.can-expand:not(.is-expanded)"), "long short-video captions must use an inline Douyin-style expand affordance");
  assert(listSource.includes(".short-video-sort-select option") && listSource.includes("color-scheme: dark;"), "author sort options must stay readable in the dark short-video workspace");
  assert(playerSource.includes("formatShortVideoMetric(video, \"likes\")") && listSource.includes(".short-video-like-badge.is-unknown"), "unknown short-video statistics must render as a pending placeholder instead of a fake zero");
  assert(playerSource.includes("short-video-caption-context-button") && viewerSource.includes(".short-video-caption-context"), "short-video caption tools must stay visible and touch-accessible");
  assert(playerSource.includes("disposeShortVideoMedia") && playerSource.includes('querySelectorAll?.("video, audio")'), "short-video work switches must explicitly stop both video and gallery background audio");
  const activePlayerSource = playerSource.slice(playerSource.indexOf("function activePlayer()"), playerSource.indexOf("function closeTransientPlayerControls()"));
  assert(!activePlayerSource.includes("short-video-gallery-image"), "gallery live-photo clips must not become the global sound player");
  const promoteAdjacentSource = playerSource.slice(playerSource.indexOf("function promoteAdjacentPanelDom"), playerSource.indexOf("function promoteAdjacentMedia"));
  assert(promoteAdjacentSource.indexOf('const previousPlayer = outgoing.querySelector(".short-video-player")') < promoteAdjacentSource.indexOf('player.muted = Boolean(state.shortVideo.muted);'), "adjacent video switches must silence the outgoing player before restoring incoming sound");
  assert(playerSource.includes("syncGalleryCaptionState") && playerSource.includes("short-video-caption-meta") && viewerSource.includes("shortVideoCaptionMetaNext"), "gallery page changes must keep the caption page indicator in sync with directional feedback");
  assert(playerSource.includes("gallerySoundState") && viewerSource.includes(".short-video-caption-sound-cover.is-playing"), "gallery background music state must stay visible across page changes");
  assert(playerSource.includes("needsGallerySoundRefresh") && playerSource.includes("replaceCurrentReelDom(state.shortVideo.current)"), "related gallery switches must attach sound when richer detail arrives after the lightweight card");
  assert(playerSource.includes("shortVideoResolvedDetailCache") && playerSource.includes("resolvedShortVideoDetail(video.id)"), "related short-video switches must distinguish resolved detail from an in-flight request");
  assert(playerSource.includes("prefetchRelatedVideo") && playerSource.includes("prefetchShortVideoFirstMedia") && playerSource.includes("requestIdleCallback"), "related short-video cards must prefetch full detail and first media before opening");
  assert(playerSource.includes('button.dataset.detailReady = "1"') && viewerSource.includes(".short-video-related-item.is-opening"), "related short-video cards must expose prefetch readiness and fallback opening feedback");
  assert(playerSource.includes("replaceCurrentReelDom(video, { transition: true })") && playerSource.includes("cloneNode(true)") && playerSource.includes("is-transition-outgoing"), "direct related switches must retain a static outgoing gallery frame during the first-media transition");
  assert(viewerSource.includes("shortVideoDirectIncoming") && viewerSource.includes("shortVideoDirectOutgoing"), "direct related switches must cross-fade incoming and outgoing work panels");
  assert(playerSource.includes('event.key?.toLowerCase?.() === "f"'), "short-video fullscreen must support the desktop F shortcut");
  assert(playerSource.includes("if (document.fullscreenElement) toggleShortVideoFullscreen();\n        else closeOrRevealBrowser();"), "Escape must leave fullscreen before it is allowed to close the active short-video player");
  assert(playerSource.includes('window.matchMedia?.("(max-width: 680px)")?.matches') && playerSource.includes("轻触画面恢复操作界面") && playerSource.includes("进入后轻触画面恢复"), "mobile clear-screen playback must explain the touch gesture that restores the interface");
  assert(playerSource.includes("setVolumePopoverOpen(!compactVolume)") && playerSource.includes("if (!player.paused) {\n          clearPlayerSoundBlocked(stage);") && playerSource.includes("markPlayerSoundBlocked(stage);"), "mobile volume taps must toggle mute without opening the desktop slider or falsely re-muting a player that kept playing");
  assert(playerSource.includes("clip.onended = () =>"), "gallery video items must advance only after playback ends");
  assert(playerSource.includes("if (images.length > 1 && wrap.isConnected"), "single-item gallery videos must finish their progress without trying to navigate away");
  assert(playerSource.includes("currentTime / duration") && playerSource.includes("--short-video-gallery-media-progress"), "gallery live-video progress must follow actual media time instead of appearing complete immediately");
  assert(viewerSource.includes("scaleX(var(--short-video-gallery-media-progress, 0))"), "gallery live-video segments must render the synchronized media progress ratio");
  assert(playerSource.includes("advanceRemainingMs = Math.max(0, advanceRemainingMs - (Date.now() - advanceStartedAt))"), "gallery image timing must preserve the remaining auto-advance delay while hidden");
  assert(playerSource.includes("wrap.shortVideoGalleryPause = pauseAutoAdvance"), "gallery players must expose lifecycle pause support");
  assert(playerSource.includes("gallery?.shortVideoGalleryResume?.()"), "gallery players must resume image timing and mixed-video playback after returning to the page");
  assert(playerSource.includes('audio.className = "short-video-player short-video-gallery-audio"'), "gallery posts must play downloaded background music through the shared player lifecycle");
  assert(playerSource.includes("video.galleryItems"), "gallery rendering must accept ordered image and video items");
  assert(playerSource.includes("scheduleLocalSoundPoll"), "open galleries must detect background music downloaded after page load");
  assert(playerSource.includes("}, 15000);"), "gallery background-music polling must stay lightweight");
  assert(serverSource.includes("FANHAO_DOUYIN_SYNC_MS || 60 * 1000"), "download-manager changes must be detected within one minute by default");
  assert(responsiveSource.includes(".short-video-gallery-progress") && responsiveSource.includes("display: none;"), "mobile gallery must keep the image counter without the desktop progress strip");
  assert(playerSource.includes("SHORT_VIDEO_GALLERY_GESTURE_HINT_KEY") && playerSource.includes("左右滑动翻图 · 上下滑动切作品") && playerSource.includes("sessionStorage?.setItem"), "mobile galleries must explain both navigation gestures once per browsing session");
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
  assert(playerSource.includes("if (isShortVideoGestureClickBlocked(wrap)) return;"), "gallery swipes must not toggle playback through a synthetic click");
  assert(playerSource.includes('setIconButton(centerPlay, "play", "继续播放图集")') && playerSource.includes("galleryUserPaused && currentReady"), "paused galleries must expose a centered resume control like Douyin");
  assert(playerSource.includes('counter.classList.add(direction > 0 ? "is-page-next" : "is-page-previous")') && playerSource.includes("syncGalleryCaptionState(direction)"), "gallery media, page counter, and caption metadata must commit with the same direction");
  assert(playerSource.includes("requestedIndex = currentIndex;") && playerSource.includes('loadRetry.setAttribute("aria-label", `重试载入第 ${index + 1} 项`)'), "failed gallery loads must retain the committed page and expose a retry action");
  assert(playerSource.includes('wrap.dataset.gallerySoundMuted = muted ? "1" : "0";') && playerSource.includes('audio.addEventListener("volumechange", syncGallerySoundState)'), "gallery sound visuals must distinguish muted playback from audible playback");
  assert(playerSource.includes('stage?.classList.contains("is-sound-blocked") && backgroundAudio') && playerSource.includes('result === "playing"'), "blocked gallery autoplay must only report success after audio actually starts");
  assert(playerSource.includes("wrap.shortVideoGalleryPlaySound = playGallerySound") && playerSource.includes("gallery?.shortVideoGalleryPlaySound?.();"), "the gallery sound control must start paused audio after unmuting");
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
  assert(staticServerSource.includes("max-age=31536000, immutable"), "versioned static assets must stay cacheable");
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
      && responsiveSource.includes("grid-template-columns: 30px 64px minmax(0, 1fr) 44px 40px 30px 30px;")
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
