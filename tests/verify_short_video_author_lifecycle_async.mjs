import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createShortVideoAuthorPanel } from "../public/modules/short-videos/author-panel.js";

// Execute the complete author factory with independently settled requests,
// layout callbacks and gallery pause reasons. The shared fake DOM comes from
// the metadata renderer fixture; no service, database or actual media is used.
const source = fs.readFileSync(new URL("../public/modules/short-videos/author-panel.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const rendererFixture = fs.readFileSync(new URL("./verify_short_video_reel_metadata.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const elementContext = vm.createContext({ EventTarget, Event });
vm.runInContext(`${rendererFixture.slice(rendererFixture.indexOf("class Element extends EventTarget"), rendererFixture.indexOf("\nconst page ="))}\nglobalThis.Element = Element;`, elementContext);
const Element = elementContext.Element;
const originalGlobals = { document: globalThis.document, window: globalThis.window, ResizeObserver: globalThis.ResizeObserver };
const settle = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
function assertSameChildren(root, before) {
  assert.equal(root.childNodes.length, before.length);
  before.forEach((node, index) => assert.equal(root.childNodes[index], node));
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

async function fixture({ initialTab = "works", switchAuthorFeed = true, gallery = null, throwAfterOldClose = false } = {}) {
  const browser = new Element(); browser.className = "short-video-browser"; browser.connected = true;
  const frames = new Map(), timers = new Map(), idle = new Map(), requests = [], navigation = [], prefetch = [], calls = [], observers = [];
  let sequence = 0, authorRequest = 0;
  const video = { id: "A", title: "Fixture A", tags: ["fixture-topic"], author: { secUid: "author-A", name: "Alice" },
    sound: { key: "fixture-sound", title: "Fixture sound" }, stats: {} };
  const state = { activeView: "shortVideos", shortVideo: { current: video, sort: "published", author: "all", source: "liked", query: "query", topic: "", sound: "", data: { retained: true } } };
  const document = { activeElement: null, createElement: tag => new Element(tag), createTextNode: text => { const node = new Element("#text"); node.textContent = text; return node; } };
  const window = {
    requestAnimationFrame(callback) { const handle = sequence++; frames.set(handle, callback); return handle; }, cancelAnimationFrame: handle => frames.delete(handle),
    setTimeout(callback, delay) { const handle = sequence++; timers.set(handle, { callback, delay }); return handle; }, clearTimeout: handle => timers.delete(handle),
    requestIdleCallback(callback) { const handle = sequence++; idle.set(handle, callback); return handle; }, cancelIdleCallback: handle => idle.delete(handle)
  };
  Object.assign(globalThis, { document, window, ResizeObserver: class {
    constructor(callback) { this.callback = callback; this.disconnectCalls = 0; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnectCalls++; }
  } });
  elementContext.document = document;
  const names = source.slice(source.indexOf("  const {") + 10, source.indexOf("  } = deps;")).split(",").map(name => name.trim()).filter(Boolean);
  const deps = Object.fromEntries(names.map(name => [name, () => {}]));
  Object.assign(deps, {
    state, els: { workGrid: { querySelector: () => browser } },
    api(url) { const request = { url, ...deferred() }; requests.push(request); return request.promise; },
    createIcon: () => new Element("span"), authorAvatar: () => new Element("span"), createAuthorFollowButton: () => new Element("button"),
    normalizeShortVideoTopic: value => String(value || ""), normalizeShortVideoSound: value => String(value || ""), normalizeShortVideoSortValue: value => value || "published",
    formatNumber: String, formatCompact: String, formatShortVideoMetric: () => "0", formatDate: () => "", formatBytes: () => "", formatDuration: () => "",
    shortVideoAuthorHandle: value => `@${value}`, shortVideoFeedSnapshot: () => ({}), shortVideoFriendlyError: error => error.message,
    shortVideosWithCovers: videos => videos, shortVideoCardCoverUrl: item => item.coverUrl || "/fixture/cover", isGalleryPost: () => false, cardTitle: item => item.title || item.id,
    setAuthorPanelTileMap: map => calls.push({ type: "tiles", size: map?.size }), cacheAuthorPanelVideos: () => calls.push({ type: "cache-works" }),
    cacheAuthorPanelVideo: item => calls.push({ type: "cache-related", id: item.id }), isShortVideoAuthorDetailPage: () => false,
    beginShortVideoPanelNavigation(item) { const owner = { id: item.id }; calls.push({ type: "navigation", id: item.id }); return owner; },
    hydratePromotedShortVideo(item, owner) { const request = { item, owner, ...deferred() }; navigation.push(request); return request.promise; },
    isCurrentShortVideoNavigation: () => true, activeReelStack: () => null,
    nextAuthorPanelVideoRequestId: () => ++authorRequest, currentAuthorPanelVideoRequestId: () => authorRequest,
    resumeActiveSound: () => calls.push({ type: "resume" }), replaceRoute: route => calls.push({ type: "route", route }),
    showError: error => calls.push({ type: "error", message: error.message }), showBrowserToast: message => calls.push({ type: "toast", message }),
    prefetchRelatedVideo(item) { const request = { item, ...deferred() }; prefetch.push(request); return request.promise; },
    lazyShortVideoCommentsView() {
      const comments = new Element(); comments.className = "short-video-comments";
      comments.shortVideoDisposeComments = () => { if (comments.disposed) return; comments.disposed = true; calls.push({ type: "dispose-comments" }); };
      return comments;
    },
    activeGalleryPlayer: () => gallery,
    closeAuthorPanel(panel, options = {}) {
      authorRequest++;
      panel.shortVideoDisposeAuthorPanel?.({ restorePlayback: options.restorePlayback !== false });
      panel.dataset.closing = "1";
      panel.releaseModal?.();
      if (options.animate === false) panel.remove();
      calls.push({ type: "close" });
    },
    isolateAuthorPanelAsMobileModal(panel) {
      if (throwAfterOldClose && calls.some(call => call.type === "close")) throw new Error("new panel construction failed");
      gallery?.shortVideoGalleryPause?.(panel);
      panel.releaseModal = () => gallery?.shortVideoGalleryResume?.(panel);
    }
  });
  const show = createShortVideoAuthorPanel(deps);
  await show(video, { initialTab, switchAuthorFeed });
  const panel = browser.querySelector(".short-video-author-panel"), content = panel.querySelector(".short-video-author-content");
  const tab = name => panel.querySelectorAll("button").find(button => button.dataset.tab === name).click();
  return { state, video, browser, panel, content, calls, requests, navigation, prefetch, frames, timers, idle, observers, document, show, tab,
    close() { deps.closeAuthorPanel(panel); },
    dispose(options) { panel.shortVideoDisposeAuthorPanel(options); },
    flushFrames() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); },
    flushIdle() { const callbacks = [...idle.values()]; idle.clear(); callbacks.forEach(callback => callback()); } };
}

try {
  for (const result of ["resolve", "reject"]) {
    const f = await fixture();
    const stateBefore = JSON.stringify(f.state);
    const callsBefore = f.calls.length, nodesBefore = [...f.content.childNodes];
    f.panel.dataset.closing = "1"; // A normal close intentionally retains its DOM for animation.
    if (result === "resolve") f.requests[0].resolve({ videos: [], total: 0 });
    else f.requests[0].reject(new Error("old works failed"));
    await settle();
    assert.equal(JSON.stringify(f.state), stateBefore, "late works cannot switch the feed after closing starts");
    assert.equal(f.navigation.length, 0);
    assert.equal(f.calls.length, callsBefore, "closed works cannot restore tile maps, caches or errors");
    assertSameChildren(f.content, nodesBefore);
    f.dispose();
  }

  for (const initialTab of ["works", "related", "ai", "topic", "sound"]) {
    for (const result of ["resolve", "reject"]) {
      const f = await fixture({ initialTab });
      const queued = [...f.frames.values(), ...[...f.timers.values()].map(timer => timer.callback)];
      const contentBefore = [...f.content.childNodes], stateBefore = JSON.stringify(f.state);
      f.dispose({ restorePlayback: false }); f.dispose();
      assert.equal(f.frames.size + f.timers.size + f.idle.size, 0, `${initialTab}: all scheduled handles are released`);
      assert.equal(f.observers[0].disconnectCalls, 1);
      const callsBefore = f.calls.length;
      for (const request of f.requests) {
        if (result === "resolve") request.resolve({ videos: [{ id: "late", author: { signature: "late" } }], total: 1 });
        else request.reject(new Error("obsolete failure"));
      }
      queued.forEach(callback => callback());
      f.observers[0].callback();
      f.tab("works");
      await settle();
      assert.equal(f.calls.length, callsBefore, `${initialTab}/${result}: queued callbacks and stale tabs are silent`);
      assert.equal(JSON.stringify(f.state), stateBefore);
      assertSameChildren(f.content, contentBefore);
      assert.equal(f.document.activeElement, null);
    }
  }

  {
    const f = await fixture({ initialTab: "comments", switchAuthorFeed: false });
    const first = f.content.querySelector(".short-video-comments");
    f.tab("detail");
    assert.equal(first.disposed, true, "tab replacement disposes a mounted comment view or lazy placeholder before detach");
    f.tab("comments"); f.dispose(); f.dispose();
    assert.equal(f.calls.filter(call => call.type === "dispose-comments").length, 2, "panel disposal also releases the current comment view once");
    f.requests[0].resolve({ videos: [], total: 0 }); await settle();
  }

  {
    const f = await fixture({ initialTab: "comments", switchAuthorFeed: false });
    f.flushFrames(); f.flushFrames();
    const input = new Element("textarea"); f.content.append(input); input.focus();
    for (const { callback } of f.timers.values()) callback();
    assert.equal(f.document.activeElement, input, "the opening timer cannot take focus back from an already focused input");
    f.dispose(); f.requests[0].resolve({ videos: [], total: 0 }); await settle();
  }

  {
    const f = await fixture({ switchAuthorFeed: false });
    f.requests[0].resolve({ videos: [], total: 0 }); await settle();
    const oldSort = f.content.querySelector("select"), count = f.requests.length, previousSort = f.state.shortVideo.sort;
    f.tab("detail"); oldSort.value = "likes"; oldSort.dispatchEvent(new Event("change"));
    assert.equal(f.requests.length, count, "a detached old tab cannot launch another sort request");
    assert.equal(f.state.shortVideo.sort, previousSort);
    f.dispose();
  }

  {
    const f = await fixture({ initialTab: "related", switchAuthorFeed: false });
    f.requests.find(request => request.url.includes("/related?")).resolve({ videos: [{ id: "B", title: "B", author: {} }] });
    await settle();
    assert.equal(f.idle.size, 1);
    const queuedIdle = [...f.idle.values()][0];
    f.dispose(); queuedIdle();
    assert.equal(f.idle.size, 0);
    assert.equal(f.prefetch.length, 0, "an already queued idle callback cannot warm an obsolete panel");
    f.requests.find(request => !request.url.includes("/related?")).resolve({ videos: [], total: 0 }); await settle();
  }

  {
    const f = await fixture({ switchAuthorFeed: false });
    f.requests[0].resolve({ videos: [{ id: "B", title: "B", author: {} }], total: 1 }); await settle();
    f.content.querySelector(".short-video-author-tile").click(); await settle();
    assert.equal(f.state.shortVideo.current.id, "B");
    assert.equal(f.navigation.length, 1);
    f.close();
    f.navigation[0].resolve(true); await settle();
    assert.equal(f.state.shortVideo.current.id, "B", "panel disposal retains an explicitly accepted video navigation");
    assert.equal(f.calls.filter(call => call.type === "resume").length, 1, "disposal never starts or cancels another playback attempt");
    assert.equal(f.calls.filter(call => call.type === "toast" || call.type === "error").length, 0);
  }

  for (const userPaused of [false, true]) {
    const reasons = new Set(userPaused ? ["user"] : []), events = [];
    const gallery = {
      shortVideoGalleryPause(reason) { reasons.add(reason); events.push({ type: "pause", reason, paused: reasons.size > 0 }); },
      shortVideoGalleryResume(reason) { reasons.delete(reason); events.push({ type: "resume", reason, paused: reasons.size > 0 }); }
    };
    const f = await fixture({ gallery, switchAuthorFeed: false });
    const oldPanel = f.panel;
    await f.show(f.video, { initialTab: "detail", switchAuthorFeed: false });
    const nextPanel = f.browser.querySelector(".short-video-author-panel");
    assert.notEqual(nextPanel, oldPanel);
    assert.equal(oldPanel.dataset.disposed, "1");
    assert(events.every(event => event.paused), "old modal release and new isolation have no transient gallery resume gap");
    assert.equal(reasons.size, userPaused ? 2 : 1, "only the new modal and original user pause reason remain");
    nextPanel.shortVideoDisposeAuthorPanel(); nextPanel.releaseModal();
    assert.equal(reasons.size, userPaused ? 1 : 0);
    for (const request of f.requests) request.resolve({ videos: [], total: 0 });
    await settle();
  }

  {
    const reasons = new Set(), gallery = {
      shortVideoGalleryPause: reason => reasons.add(reason), shortVideoGalleryResume: reason => reasons.delete(reason)
    };
    const f = await fixture({ gallery, switchAuthorFeed: false, throwAfterOldClose: true });
    await assert.rejects(f.show(f.video, { initialTab: "detail", switchAuthorFeed: false }), /construction failed/);
    assert.equal(reasons.size, 0, "failed replacement also releases the temporary gallery handoff reason");
    for (const request of f.requests) request.resolve({ videos: [], total: 0 });
    await settle();
  }

  console.log("short-video-author-lifecycle-async: actual factory rejects closing/disposed work, list/layout callbacks, stale tabs and child views while preserving accepted navigation");
} finally {
  Object.assign(globalThis, originalGlobals);
}
