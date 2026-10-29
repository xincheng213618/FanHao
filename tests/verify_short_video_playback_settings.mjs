import assert from "node:assert/strict";
import { createShortVideoPlaybackSettings } from "../public/modules/short-videos/playback-settings.js";
import { formatPlaybackRate, normalizePlaybackRate } from "../public/modules/short-videos/state.js";

// Render the actual settings module with a small DOM/event double. There is no
// service, real media, browser profile, local storage or database in this test.
class Element extends EventTarget {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.dataset = {};
    this.className = "";
    this.ownText = "";
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      toggle: (name, force) => {
        const enabled = force ?? !this.classList.contains(name);
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        if (enabled) classes.add(name);
        else classes.delete(name);
        this.className = [...classes].join(" ");
        return enabled;
      },
      add: (...names) => names.forEach((name) => this.classList.toggle(name, true))
    };
  }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(""); }
  get isConnected() { return this.connected || Boolean(this.parentElement?.isConnected); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  append(...nodes) {
    for (const node of nodes) {
      node.remove();
      node.parentElement = this;
      this.children.push(node);
    }
  }
  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      this.parentElement = null;
    }
  }
  querySelectorAll(selector) {
    const matches = (node) => selector.startsWith(".")
      ? node.classList.contains(selector.slice(1))
      : node.tagName.toLowerCase() === selector;
    return this.children.flatMap((child) => [
      ...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { document.activeElement = this; }
  click() { if (!this.disabled) this.dispatchEvent(new Event("click")); }
}

function fixture({ rate = 1.5, gallery = false, speedOnlyDeps = false } = {}) {
  globalThis.document = {
    activeElement: null,
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => { const node = new Element("#text"); node.textContent = text; return node; }
  };
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  const browser = new Element("div");
  browser.connected = true;
  const trigger = new Element("button");
  browser.append(trigger);
  const video = { id: "settings-fixture", gallery, actions: {} };
  const state = { shortVideo: { current: video, playbackRate: rate, autoNext: false } };
  const calls = { closed: [], rates: [], isolation: [], focusLoops: [], fullPlayerReads: 0 };
  const deps = {
    state, playbackRates: [0.5, 0.75, 1, 1.25, 1.5, 2], normalizePlaybackRate, formatPlaybackRate,
    getBrowser: () => browser,
    getWorkGrid: () => browser,
    isGalleryPost: (item) => Boolean(item?.gallery),
    createIcon: () => new Element("span"),
    isolateShortVideoTransientModal: (overlay) => calls.isolation.push(overlay),
    bindShortVideoModalFocusLoop: (overlay, sheet, close) => calls.focusLoops.push({ overlay, sheet, close }),
    focusShortVideoTransientModal: (_sheet, target) => target.focus(),
    closePlaybackSettings: (overlay, options) => {
      calls.closed.push({ overlay, options });
      overlay.remove();
      if (options?.restoreFocus !== false) overlay._shortVideoReturnFocus?.focus();
    },
    setPlaybackRate: (value) => { state.shortVideo.playbackRate = value; calls.rates.push(value); },
    activePlayer: () => {
      calls.fullPlayerReads += 1;
      assert(!speedOnlyDeps, "the compact picker must not construct unrelated player/file actions");
      return null;
    },
    originalDouyinUrl: () => {
      assert(!speedOnlyDeps, "the compact picker must not resolve sharing/file actions");
      return "";
    },
    syncShortVideoFullscreenControl() {},
    syncActivePlaybackMode() {}, writeAutoNextPreference() {},
    showBrowserToast() {}, toggleClearScreen() {}, toggleShortVideoFullscreen() {},
    isCurrentShortVideo: () => true,
    deleteShortVideo: async () => { throw new Error("unexpected delete"); },
    runShortVideoLocalAction: () => { throw new Error("unexpected local-file action"); },
    openAdjacent: async () => { throw new Error("unexpected navigation"); },
    openDouyinLink: () => { throw new Error("unexpected external navigation"); },
    shareShortVideo: () => { throw new Error("unexpected sharing"); },
    toggleShortVideoDislike: async () => { throw new Error("unexpected dislike"); },
    loadVideos: async () => { throw new Error("unexpected loading"); },
    showError: (error) => { throw error; }
  };
  const show = createShortVideoPlaybackSettings(deps);
  const overlay = () => browser.querySelector(".short-video-more-overlay");
  return { browser, trigger, video, state, calls, show, overlay };
}

const previousDocument = globalThis.document;
const previousWindow = globalThis.window;
try {
  {
    const f = fixture({ speedOnlyDeps: true });
    f.show(f.video, { trigger: f.trigger, speedOnly: true });
    const overlay = f.overlay();
    const sheet = overlay.querySelector(".short-video-more-sheet");
    const rates = sheet.querySelector(".short-video-speed-grid").querySelectorAll("button");
    assert(overlay.classList.contains("is-speed-picker"));
    assert(sheet.classList.contains("is-speed-picker"));
    assert.equal(sheet.getAttribute("role"), "dialog");
    assert.equal(sheet.getAttribute("aria-modal"), "true");
    assert.equal(sheet.querySelector("h2").textContent, "播放速度");
    assert.equal(sheet.querySelectorAll("button").length, 7, "compact mode contains only close and six rates");
    assert.deepEqual(rates.map((button) => button.textContent), ["0.5x", "0.75x", "1x", "1.25x", "1.5x", "2x"]);
    assert.equal(rates.filter((button) => button.getAttribute("aria-pressed") === "true").length, 1);
    assert.equal(document.activeElement, rates[4], "opening focuses the selected rate");
    assert.equal(rates[4].getAttribute("aria-pressed"), "true");
    assert.equal(f.calls.fullPlayerReads, 0);
    assert.deepEqual(f.calls.isolation, [overlay]);
    assert.equal(f.calls.focusLoops[0].sheet, sheet);
    assert.equal(overlay._shortVideoReturnFocus, f.trigger);
    rates[5].click();
    assert.deepEqual(f.calls.rates, [2]);
    assert.equal(f.state.shortVideo.playbackRate, 2);
    assert.equal(f.overlay(), null, "selecting a rate immediately closes compact mode");
    assert.equal(document.activeElement, f.trigger, "closing returns focus through the normal close hook");
  }

  {
    const f = fixture({ speedOnlyDeps: true, rate: 1 });
    f.show(f.video, { trigger: f.trigger, speedOnly: true });
    f.overlay().click();
    assert.equal(f.overlay(), null, "backdrop click dismisses compact mode");
    assert.deepEqual(f.calls.rates, [], "dismissing never changes speed");
    assert.equal(document.activeElement, f.trigger);
    f.show(f.video, { trigger: f.trigger, speedOnly: true });
    f.overlay().querySelector(".short-video-more-close").click();
    assert.equal(f.overlay(), null, "the explicit close button dismisses compact mode");
    f.show(f.video, { trigger: f.trigger, speedOnly: true });
    f.calls.focusLoops.at(-1).close();
    assert.equal(f.overlay(), null, "the focus-loop dismissal callback closes the active picker");
  }

  {
    const f = fixture({ speedOnlyDeps: true });
    f.show(f.video, { trigger: f.trigger, speedOnly: true });
    const firstOverlay = f.overlay();
    const secondTrigger = new Element("button");
    f.browser.append(secondTrigger);
    f.show(f.video, { trigger: secondTrigger, speedOnly: true });
    assert.equal(f.calls.closed[0].overlay, firstOverlay);
    assert.deepEqual(f.calls.closed[0].options, { restoreFocus: false });
    assert.equal(firstOverlay.isConnected, false);
    assert.equal(f.browser.querySelectorAll(".short-video-more-overlay").length, 1);
    assert.equal(f.overlay()._shortVideoReturnFocus, secondTrigger);
    assert.equal(document.activeElement.textContent, "1.5x");
  }

  {
    const f = fixture();
    f.show(f.video, { trigger: f.trigger });
    const overlay = f.overlay();
    assert(!overlay.classList.contains("is-speed-picker"));
    assert.equal(overlay.querySelector("h2").textContent, "更多功能");
    assert(overlay.textContent.includes("下载原文件"));
    assert(overlay.textContent.includes("删除同组"));
    assert.equal(f.calls.fullPlayerReads, 1);
    assert.equal(document.activeElement, overlay.querySelector(".short-video-more-close"));
    const rates = overlay.querySelector(".short-video-speed-grid").querySelectorAll("button");
    rates[2].click();
    assert.equal(f.overlay(), overlay, "the full settings menu remains open after speed selection");
    assert.equal(rates[2].getAttribute("aria-pressed"), "true");
    assert.equal(rates[4].getAttribute("aria-pressed"), "false");
    assert.equal(overlay.querySelector(".short-video-speed-section").textContent.includes("当前 1x"), true);
  }

  {
    const f = fixture({ gallery: true });
    f.show(f.video, { trigger: f.trigger, speedOnly: true });
    const overlay = f.overlay();
    assert(!overlay.classList.contains("is-speed-picker"), "gallery requests keep their full playback menu");
    assert.equal(overlay.querySelector(".short-video-speed-section"), null, "gallery music has no speed control");
    assert(overlay.textContent.includes("播放 / 暂停图集"));
    assert(overlay.textContent.includes("切换图集内容"));
    assert(overlay.textContent.includes("作者文件夹"));
    assert.equal(f.state.shortVideo.playbackRate, 1.5);
    assert.deepEqual(f.calls.rates, []);
  }
} finally {
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
}

console.log("short-video-playback-settings: compact speed selection, focus, dismissal, replacement and full/gallery menus passed");
