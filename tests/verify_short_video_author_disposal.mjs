import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { disposeShortVideoMedia } from "../public/modules/short-videos/player-source-lifecycle.js";

// Compose the actual author factory with the actual page close, modal, drag
// and render lifecycle. All requests/layout clocks/media are controlled.
const helperFile = new URL("./verify_short_video_author_lifecycle_async.mjs", import.meta.url);
let helper = fs.readFileSync(helperFile, "utf8");
helper = helper.slice(0, helper.indexOf("\ntry {"));
helper = helper.replace("throwAfterOldClose = false } = {})", "throwAfterOldClose = false, setup = null } = {})");
helper = helper.replace("  const show = createShortVideoAuthorPanel(deps);", "  const integration = setup?.({ browser, window, document, state, video, frames, timers, idle, calls });\n  if (integration) Object.assign(deps, integration.deps);\n  const show = createShortVideoAuthorPanel(deps);");
helper = helper.replace("return { state, video, browser, panel, content,", "return { integration, state, video, browser, panel, content,");
helper = helper.replaceAll("import.meta.url", JSON.stringify(helperFile.href));
helper = helper.replace(/from "(\.\.\/public\/[^\"]+)"/g, (_, relative) => `from "${new URL(relative, helperFile).href}"`);
const { fixture: authorFixture, Element } = await import(`data:text/javascript;base64,${Buffer.from(`${helper}\nexport { fixture, Element };`).toString("base64")}`);
const page = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const take = name => {
  const start = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(page)?.index;
  assert(start != null, name);
  return page.slice(start, page.indexOf("\n  }", start) + 4);
};
const names = ["disposeAuthorPanelResources", "closeAuthorPanel", "bindAuthorPanelDragToClose", "clearAuthorPanelCaches", "refreshShortVideoHome", "renderView",
  "resolveAuthorPanelReturnFocus", "isolateAuthorPanelAsMobileModal", "restoreAuthorPanelModalIsolation", "isolateShortVideoTransientModal",
  "restoreShortVideoTransientModalIsolation", "acquireShortVideoModalInert", "releaseShortVideoModalInert"];
Element.prototype.getClientRects = function () { return this.isConnected ? [{}] : []; };

function media(document, id = "A") {
  const node = document.createElement("video"); node.className = "short-video-player";
  node.dataset.videoId = id; node.src = `/fixture/${id}`;
  node.playCalls = 0; node.pauseCalls = 0; node.loadCalls = 0; node.paused = false;
  node.play = async () => { node.playCalls++; node.paused = false; };
  node.pause = () => { node.pauseCalls++; node.paused = true; };
  node.load = () => { node.loadCalls++; };
  return node;
}

function integration({ browser, window, document, state }) {
  const root = new Element(); root.connected = true; browser.connected = false; root.append(browser);
  const reel = new Element(); reel.className = "short-video-reel-panel is-current";
  const trigger = new Element("button"); trigger.className = "short-video-caption-author";
  const main = media(document); reel.append(main, trigger); browser.append(reel); document.activeElement = trigger;
  Object.defineProperty(root, "innerHTML", { set() { root.replaceChildren(); } });
  const listeners = new Set(), calls = [], contexts = [];
  window.addEventListener = (type, callback, options = {}) => {
    const entry = { type, callback }; listeners.add(entry);
    options.signal?.addEventListener("abort", () => listeners.delete(entry), { once: true });
  };
  window.matchMedia = query => ({ matches: query.includes("max-width") });
  const env = vm.createContext({
    window, document, AbortController, Date, state, els: { workGrid: root }, disposeShortVideoMedia,
    authorPanelVideoRequestId: 0, authorPanelReturnFeed: { original: true }, authorPanelVideoCache: null, authorPanelTileMap: null,
    shortVideoOpeningId: "", shortVideoHomePresentation: null, shortVideoWheelController: null,
    activePlayer: () => main, activeGalleryPlayer: () => null,
    cancelShortVideoPanelLoading() {}, cancelShortVideoAutoNext() {}, cancelShortVideoBrowseGestures() {}, clearPendingPlayerClick() {}, stopShortVideoSoundPreview() {},
    syncShortVideoNativePlaybackModes() {}, resetShortVideoWindow() {}, ensureState() {}, setBodyClass() {},
    releaseUnusedShortVideoPreloads() {},
    transcodeManagementPage: { stop() {} }, renderHome() {}, renderBrowser() { contexts.push("new-browser"); },
    bindShortVideoModalFocusLoop() {},
    restoreAuthorPanelFeed: async () => { calls.push("restore-feed"); }, showError: error => { throw error; }
  });
  vm.runInContext(`${names.map(take).join("\n")}\nglobalThis.api = { ${names.join(", ")} };`, env);
  return { root, browser, main, trigger, env, api: env.api, calls, contexts, listeners, deps: {
    els: { workGrid: root }, closeAuthorPanel: env.api.closeAuthorPanel,
    bindAuthorPanelDragToClose: env.api.bindAuthorPanelDragToClose,
    isolateAuthorPanelAsMobileModal: env.api.isolateAuthorPanelAsMobileModal,
    setAuthorPanelReturnFeed: snapshot => { env.authorPanelReturnFeed = snapshot; },
    nextAuthorPanelVideoRequestId: () => ++env.authorPanelVideoRequestId,
    currentAuthorPanelVideoRequestId: () => env.authorPanelVideoRequestId
  } };
}
async function fixture(options = {}) {
  const f = await authorFixture({ initialTab: "comments", switchAuthorFeed: false, setup: integration, ...options });
  return { ...f, ...f.integration };
}
const oldGlobals = { window: globalThis.window, document: globalThis.document, ResizeObserver: globalThis.ResizeObserver };

try {
  for (const destination of ["list", "other-video"]) {
    const f = await fixture();
    const oldCallbacks = [...f.frames.values(), ...[...f.timers.values()].map(timer => timer.callback)];
    const comments = f.content.querySelector(".short-video-comments"), observer = f.observers[0];
    f.env.authorPanelVideoCache = new Map([["A", f.video]]); f.env.authorPanelTileMap = new Map([["A", f.panel]]);
    const requestId = f.env.authorPanelVideoRequestId;
    assert.equal(f.listeners.size, 4, "the actual drag binder holds four global listeners while open");
    f.state.shortVideo.current = destination === "list" ? null : { id: "B" };
    f.api.renderView();
    assert.equal(f.panel.isConnected, false); assert.equal(f.panel.dataset.disposed, "1");
    assert.equal(f.listeners.size, 0); assert.equal(observer.disconnectCalls, 1);
    assert.equal(comments.disposed, true); assert.equal(f.frames.size + f.timers.size + f.idle.size, 0);
    assert.equal(f.env.authorPanelVideoCache, null); assert.equal(f.env.authorPanelTileMap, null);
    assert.equal(f.env.authorPanelVideoRequestId, requestId + 1); assert.equal(f.env.authorPanelReturnFeed, null);
    assert.equal(f.main.paused, true); assert.equal(f.main.src, ""); assert.equal(f.main.playCalls, 0);
    const focus = f.document.activeElement, calls = f.calls.length;
    oldCallbacks.forEach(callback => callback()); observer.callback();
    assert.equal(f.document.activeElement, focus, "already queued opening/modal focus cannot escape forced disposal");
    assert.equal(f.calls.length, calls); assert.equal(f.main.playCalls, 0);
    f.api.disposeAuthorPanelResources(f.panel); assert.equal(observer.disconnectCalls, 1);
  }

  {
    const f = await fixture(), comments = f.content.querySelector(".short-video-comments");
    const oldCallbacks = [...f.frames.values()];
    f.api.closeAuthorPanel(f.panel);
    assert.equal(f.panel.isConnected, true); assert.equal(f.panel.dataset.closing, "1");
    assert.equal(f.listeners.size, 0); assert.equal(f.observers[0].disconnectCalls, 1); assert.equal(comments.disposed, true);
    assert.equal(f.panel._shortVideoModalIsolationActive, true, "closing animation retains the modal lease until its finish");
    oldCallbacks.forEach(callback => callback());
    assert.equal(f.document.activeElement, f.trigger);
    const finish = f.timers.get(f.panel._shortVideoCloseTimer).callback;
    finish(); finish();
    assert.equal(f.panel.isConnected, false); assert.equal(f.panel._shortVideoModalIsolationActive, false);
    assert.deepEqual(f.calls, ["restore-feed"]); assert.equal(f.timers.size, 0);
  }

  {
    const f = await fixture(); f.api.closeAuthorPanel(f.panel);
    const finish = f.timers.get(f.panel._shortVideoCloseTimer).callback;
    f.api.closeAuthorPanel(f.panel, { animate: false, restoreFeed: false, restoreFocus: false });
    assert.equal(f.panel.isConnected, false, "a forced close overrides an in-progress closing animation immediately");
    assert.equal(f.timers.size, 0); assert.equal(f.panel._shortVideoFinishAuthorClose, null);
    const replacement = new Element("button"); f.browser.append(replacement); f.document.activeElement = replacement;
    f.env.authorPanelVideoCache = new Map([["B", {}]]); f.env.authorPanelTileMap = new Map([["B", replacement]]);
    finish();
    assert.equal(f.document.activeElement, replacement); assert.equal(f.calls.length, 0);
    assert(f.env.authorPanelVideoCache.has("B")); assert(f.env.authorPanelTileMap.has("B"));
  }

  {
    const f = await fixture(); f.api.closeAuthorPanel(f.panel);
    const finish = f.timers.get(f.panel._shortVideoCloseTimer).callback;
    f.panel.remove(); finish();
    assert.equal(f.calls.length, 0, "detaching during a closing animation cannot restore the old feed");
    assert.equal(f.document.activeElement, f.trigger); assert.equal(f.timers.size, 0);
  }

  // The actual gallery must be disposed before the modal lease is released.
  const galleryFile = new URL("./verify_short_video_gallery_metadata.mjs", import.meta.url);
  let galleryHelpers = fs.readFileSync(galleryFile, "utf8");
  galleryHelpers = galleryHelpers.slice(0, galleryHelpers.indexOf("\n{\n  const f = fixture();"));
  galleryHelpers = galleryHelpers.replace(/from "(\.\.\/public\/[^\"]+)"/g, (_, relative) => `from "${new URL(relative, galleryFile).href}"`);
  const { fixture: galleryFixture, Element: GalleryElement } = await import(`data:text/javascript;base64,${Buffer.from(`${galleryHelpers}\nexport { fixture, Element };`).toString("base64")}`);
  GalleryElement.prototype.hasAttribute = function (name) { return this.attributes.has(name); };
  Object.defineProperty(GalleryElement.prototype, "parentElement", { get() { return this.parent || null; } });
  const g = galleryFixture(); await g.readyAll();
  g.gallery.shortVideoGalleryUpdateMetadata({ id: g.video.id, sound: { localAvailable: true, previewUrl: "/fixture/music" } });
  await g.flushFrames();
  const audio = g.gallery.querySelector("audio"), plays = audio.playCalls;
  const browser = g.root; browser.className = "short-video-browser";
  const panel = new GalleryElement("section"); panel.className = "short-video-author-panel"; browser.append(panel);
  const root = new GalleryElement("div"); root.connected = true; browser.connected = false; root.append(browser);
  Object.defineProperty(root, "innerHTML", { set() { root.replaceChildren(); } });
  g.state.activeView = "shortVideos";
  const env = vm.createContext({ window, document, state: g.state, els: { workGrid: root }, disposeShortVideoMedia,
    releaseUnusedShortVideoPreloads() {}, shortVideoHomePresentation: null,
    activePlayer: () => audio, activeGalleryPlayer: () => g.gallery, shortVideoWheelController: null,
    cancelShortVideoPanelLoading() {}, cancelShortVideoAutoNext() {}, cancelShortVideoBrowseGestures() {}, clearPendingPlayerClick() {}, stopShortVideoSoundPreview() {},
    syncShortVideoNativePlaybackModes() {}, resetShortVideoWindow() {}, ensureState() {}, setBodyClass() {},
    transcodeManagementPage: { stop() {} }, renderHome() {}, shortVideoOpeningId: "", authorPanelVideoRequestId: 0, authorPanelReturnFeed: {},
    authorPanelVideoCache: null, authorPanelTileMap: null
  });
  vm.runInContext(`${names.filter(name => !["bindAuthorPanelDragToClose", "closeAuthorPanel", "isolateAuthorPanelAsMobileModal", "resolveAuthorPanelReturnFocus"].includes(name)).map(take).join("\n")}\nglobalThis.api = { isolateShortVideoTransientModal, renderView };`, env);
  env.api.isolateShortVideoTransientModal(panel);
  assert.equal(g.gallery.classList.contains("is-gallery-timing-paused"), true);
  g.state.shortVideo.current = null; env.api.renderView();
  assert.equal(audio.paused, true); assert.equal(audio.playCalls, plays, "forced root cleanup cannot briefly replay gallery music while releasing the old modal");
  assert.equal(panel._shortVideoModalIsolationActive, false); assert.equal(panel.isConnected, false);
  await g.dispose();

  console.log("short-video-author-disposal: passed actual factory/page route disposal, drag/observer/timer release, forced animated close, cache references and gallery modal teardown");
} finally {
  Object.assign(globalThis, oldGlobals);
}
