import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createShortVideoSharePanel } from "../public/modules/short-videos/share-panel.js";
import { createShortVideoPanelLoadingController } from "../public/modules/short-videos/panel-loading-controller.js";
import { createShortVideoInteractionState } from "../public/modules/short-videos/interaction-state.js";

// Actual actions factory, share sheet and loading controller. Only dynamic
// import and browser clipboard/system-share APIs are controlled promises.
// No real clipboard, external sharing, service or database is accessed.
const source = fs.readFileSync(new URL("../public/modules/short-videos/actions-controller.js", import.meta.url), "utf8");
const factory = source.slice(source.indexOf("export function createShortVideoActionsController"))
  .replace("export function", "function").replace("import(moduleUrl)", "loadShareModule(moduleUrl)");
assert(factory.includes("loadShareModule(moduleUrl)"));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function settle() { for (let i = 0; i < 16; i++) await Promise.resolve(); }
class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.parent = null; this.className = ""; this.dataset = {}; this.attributes = new Map(); this.listeners = new Map(); this.style = {};
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(" "); }
    };
    this.focusCalls = 0; this.selectCalls = 0;
  }
  get isConnected() { return this.connectedRoot || Boolean(this.parent?.isConnected); }
  get parentElement() { return this.parent; }
  append(...nodes) { nodes.forEach(node => { node.remove(); node.parent = this; this.children.push(node); }); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  addEventListener(name, handler) { const handlers = this.listeners.get(name) || []; handlers.push(handler); this.listeners.set(name, handlers); }
  emit(name) { let result; for (const handler of this.listeners.get(name) || []) result = handler({ target: this, currentTarget: this }); return result; }
  querySelectorAll(selector) {
    const matches = node => selector.split(",").some(part => part.trim().startsWith(".") ? node.classList.contains(part.trim().slice(1)) : node.tagName === part.trim());
    return this.children.flatMap(node => [...(matches(node) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.focusCalls++; }
  select() { this.selectCalls++; }
}

function fixture({ injected = false } = {}) {
  const root = new Element("root"); root.connectedRoot = true;
  let browser = new Element("div"); browser.className = "short-video-browser"; root.append(browser);
  const trigger = new Element("button"); browser.append(trigger);
  const state = { activeView: "shortVideos", shortVideo: { current: { id: "A", title: "A title" }, source: "all", mode: "feed" } };
  const modules = [], copies = [], shares = [], toasts = [], mounts = [], timers = new Map();
  let timerId = 0, fallbackCopies = 0, copyWorks = true;
  const navigator = {
    clipboard: { writeText(value) { const operation = { ...deferred(), value }; copies.push(operation); return operation.promise; } },
    share(value) { const operation = { ...deferred(), value }; shares.push(operation); return operation.promise; }
  };
  const document = { body: root, createElement: tag => new Element(tag), createTextNode: () => new Element("text"), execCommand: () => { fallbackCopies++; return copyWorks; } };
  const window = { location: { hostname: "127.0.0.1", href: "http://127.0.0.1:29998/short-videos/A" },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimeout(id) { timers.delete(id); } };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: navigator });
  globalThis.document = document; globalThis.window = window;
  const contextSnapshot = () => ({ browser, id: state.shortVideo.current?.id, view: state.activeView });
  const controller = createShortVideoPanelLoadingController({ captureContext: contextSnapshot,
    isCurrentContext: owner => owner.browser === browser && owner.id === state.shortVideo.current?.id && owner.view === state.activeView,
    showError: (error, message) => toasts.push(error?.message || message) });
  const deps = {
    state, cardTitle: video => video.title || "Fixture", getBrowser: () => browser, getWorkGrid: () => root,
    bindModalFocusLoop() {}, closeTransientModal: overlay => overlay.remove(),
    focusTransientModal: sheet => mounts.push(sheet), galleryLabel: () => "3 张", isCurrentVideo: video => video.id === state.shortVideo.current?.id,
    isGalleryPost: () => false, isolateTransientModal() {}, shortVideoAuthorHandle: value => `@${value}`, showToast: message => toasts.push(message),
    ...(injected ? { requestPanel: controller.open } : {})
  };
  const env = vm.createContext({ document, window, navigator, URL, Promise, console, createShortVideoPanelLoadingController, createShortVideoInteractionState,
    createIcon: () => new Element("icon"), railButton() {}, formatCompact: String, formatDuration: () => "0:30", formatShortVideoMetric: () => "0",
    loadShareModule() { const operation = deferred(); modules.push(operation); return operation.promise; } });
  vm.runInContext(`${factory}\nglobalThis.factory = createShortVideoActionsController;`, env);
  const actions = env.factory(deps);
  return { root, state, trigger, actions, modules, copies, shares, toasts, mounts, timers, controller,
    browser: () => browser, overlay: () => browser.querySelector(".short-video-share-overlay"),
    resolveModule: async () => { await settle(); assert(modules.length, "current request starts its module load"); modules.at(-1).resolve({ createShortVideoSharePanel }); },
    navigate(id = "B") { browser.remove(); browser = new Element("div"); browser.className = "short-video-browser"; root.append(browser); state.shortVideo.current = { id, title: `${id} title` }; },
    clipboardTimeout() { for (const [id, timer] of [...timers]) if (timer.delay === 800) { timers.delete(id); timer.callback(); } },
    fallbackCopies: () => fallbackCopies, failFallback: () => { copyWorks = false; } };
}
const target = id => ({ id, title: `${id} share`, originalUrl: `https://fixture.invalid/${id}`, author: { name: "fixture" } });

for (const injected of [false, true]) {
  const f = fixture({ injected });
  const pending = f.actions.shareShortVideo(target("A"), { trigger: f.trigger });
  await settle(); f.navigate(); await f.resolveModule(); await pending;
  assert.equal(f.mounts.length, 0, "late share cannot mount in a newer video/browser");
  assert.deepEqual(f.toasts, []);
}

{
  const f = fixture(), pending = f.actions.shareShortVideo(target("A"), { trigger: f.trigger });
  await settle(); f.navigate(); f.modules[0].reject(new Error("old failure")); await pending;
  assert.deepEqual(f.toasts, [], "late module error is silent after navigation");
}

{
  const f = fixture(), pending = f.actions.shareShortVideo(target("A"), { trigger: f.trigger });
  await settle(); f.modules[0].reject(new Error("current module failure")); await pending;
  assert.deepEqual(f.toasts, ["current module failure"]);
  assert.equal(f.trigger.getAttribute("aria-busy"), null);
  const retry = f.actions.shareShortVideo(target("A"), { trigger: f.trigger });
  await f.resolveModule(); await retry;
  assert.equal(f.modules.length, 2, "failed imports can be retried");
  assert.equal(f.mounts.length, 1);
}

for (const change of ["trigger", "view", "scope"]) {
  const f = fixture(), pending = f.actions.shareShortVideo(target("C"), { trigger: f.trigger });
  await settle();
  if (change === "trigger") f.trigger.remove();
  if (change === "view") f.state.activeView = "music";
  if (change === "scope") f.state.shortVideo.source = "liked";
  await f.resolveModule(); await pending;
  assert.equal(f.mounts.length, 0, `${change} changes invalidate a standalone share request`);
}

{
  const f = fixture(), first = f.actions.shareShortVideo(target("A")), second = f.actions.shareShortVideo(target("C"));
  await f.resolveModule(); await Promise.all([first, second]);
  assert.equal(f.mounts.length, 1, "only the latest share intent mounts after the shared import");
  const link = f.overlay().querySelector("input").value;
  assert(link.includes("/short-videos/C"), "non-current target C stays shareable in current playback context A");
}

{
  const f = fixture({ injected: true }), pending = f.actions.shareShortVideo(target("A"));
  await settle();
  f.controller.cancel(); const search = new Element("section"); search.className = "short-video-search-overlay"; f.browser().append(search);
  await f.resolveModule(); await pending;
  assert.equal(f.overlay(), null, "new search intent invalidates a pending share");
  assert.equal(search.isConnected, true);
}

{
  const f = fixture({ injected: true }), settings = deferred();
  const pendingSettings = f.controller.open({ load: () => settings.promise, show: () => { throw new Error("old settings must not reopen over share"); } });
  await settle();
  const pendingShare = f.actions.shareShortVideo(target("C")); await f.resolveModule(); await pendingShare;
  settings.resolve(() => {}); await pendingSettings;
  assert.equal(f.mounts.length, 1); assert.deepEqual(f.toasts, []);
}

{
  const f = fixture(); let current = false;
  assert.equal(await f.actions.copyShortVideoValue("/old", "copied", { isCurrent: () => current }), false);
  assert.equal(f.copies.length, 0, "stale actions cannot start a new clipboard write");
}

for (const outcome of ["success", "rejection", "timeout"]) {
  const f = fixture(); let current = true;
  const pending = f.actions.copyShortVideoValue("/A", "copied", { isCurrent: () => current });
  current = false;
  if (outcome === "success") f.copies[0].resolve();
  if (outcome === "rejection") f.copies[0].reject(new Error("failed"));
  if (outcome === "timeout") f.clipboardTimeout();
  assert.equal(await pending, false);
  assert.equal(f.fallbackCopies(), 0, "old clipboard failures cannot trigger a second fallback write");
  assert.deepEqual(f.toasts, []);
}

{
  const f = fixture(), pending = f.actions.copyShortVideoValue("/legacy", "legacy copied");
  f.copies[0].resolve(); assert.equal(await pending, true);
  assert.deepEqual(f.toasts, ["legacy copied"], "existing comments/default copy callers keep their success behavior");
}

{
  const f = fixture(), pending = f.actions.copyShortVideoValue("/fallback", "fallback copied");
  f.copies[0].reject(new Error("clipboard unavailable")); assert.equal(await pending, true);
  assert.equal(f.fallbackCopies(), 1); assert.deepEqual(f.toasts, ["fallback copied"]);
}

for (const action of ["copy", "system-share", "system-share-success", "link-copy"]) {
  const f = fixture({ injected: true }), pending = f.actions.shareShortVideo(target("C")); await f.resolveModule(); await pending;
  const overlay = f.overlay(), buttons = overlay.querySelector(".short-video-share-actions").children;
  const button = action === "copy" ? buttons[0] : action.startsWith("system-share") ? buttons[3] : overlay.querySelector(".short-video-share-link").querySelector("button");
  const input = overlay.querySelector("input");
  const click = button.emit("click");
  overlay.remove();
  if (action.startsWith("system-share")) {
    assert(f.shares[0].value.url.includes("/short-videos/C"));
    if (action === "system-share") f.shares[0].reject(new Error("native share failed after close"));
    else f.shares[0].resolve();
  } else f.copies[0].reject(new Error("clipboard failed after close"));
  await click; await settle();
  assert.deepEqual(f.toasts, [], "closing share suppresses late copy/share errors and toasts");
  assert.equal(f.fallbackCopies(), 0);
  assert.equal(input.focusCalls, 0, "late failures cannot focus a removed input");
  assert.equal(button.classList.contains("is-done"), false);
}

{
  const f = fixture({ injected: true }), pending = f.actions.shareShortVideo(target("C")); await f.resolveModule(); await pending;
  const button = f.overlay().querySelector(".short-video-share-actions").children[0];
  f.controller.cancel(); await button.emit("click");
  assert.equal(f.copies.length, 0, "connected but superseded sheets cannot start stale actions");
}

console.log("short-video-share-lifecycle: passed lazy panel ownership, cross-panel supersession, non-current sharing, clipboard/native-share cancellation and legacy copy compatibility");
