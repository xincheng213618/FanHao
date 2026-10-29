import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { disposeShortVideoMedia } from "../public/modules/short-videos/player-source-lifecycle.js";
import { createShortVideoTranscodeStatusView } from "../public/modules/short-videos/transcode-status-view.js";

// Run the production management wrapper. Only its dynamic import is gated;
// mount/stop behavior and route rendering remain the actual implementation.
const file = new URL("../public/modules/short-videos/transcode-management-page.js", import.meta.url);
const source = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
assert.equal((source.match(/\bimport\(/g) || []).length, 1);
const implementation = source.replace("export function", "function").replace(/\bimport\(([^)]+)\)/, "loadModule($1)");
const pageSource = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function pageFunction(name) {
  const start = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(pageSource)?.index;
  assert(start != null, name);
  return pageSource.slice(start, pageSource.indexOf("\n  }", start) + 4);
}
const settle = async () => { for (let turn = 0; turn < 18; turn++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

class Element extends EventTarget {
  constructor(tag = "div") {
    super(); this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.className = ""; this.ownText = "";
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: name => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), name])].join(" "); }
    };
  }
  get isConnected() { return this.connected || Boolean(this.parentElement?.isConnected); }
  get textContent() { return this.ownText + this.children.map(node => node.textContent).join(""); }
  set textContent(value) { this.children.forEach(node => { node.parentElement = null; }); this.children = []; this.ownText = String(value); }
  set innerHTML(value) { assert.equal(value, ""); this.replaceChildren(); }
  append(...nodes) { nodes.forEach(node => { node.remove(); node.parentElement = this; this.children.push(node); }); }
  replaceChildren(...nodes) { this.textContent = ""; this.append(...nodes); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
  querySelectorAll(selector) {
    const matches = node => selector.split(",").some(part => part.trim().startsWith(".")
      ? node.classList.contains(part.trim().slice(1)) : node.tagName.toLowerCase() === part.trim());
    return this.children.flatMap(node => [...(matches(node) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function fixture({ code = implementation } = {}) {
  const requests = [], apiCalls = [], factories = [], mounts = [], operations = [], headers = [];
  const root = new Element("main"); root.connected = true;
  const state = { activeView: "shortVideos", shortVideo: { mode: "transcoding", current: { id: "old" },
    prevVideo: { id: "prev" }, nextVideo: { id: "next" }, prevId: "prev", nextId: "next" } };
  const document = { createElement: tag => new Element(tag) };
  let stops = 0, polling = false, mountedPage = null, failMount = false;
  const api = async (...args) => { apiCalls.push(args); return {}; };
  const view = {
    mount(page) {
      operations.push({ name: "mount", page }); mounts.push(page); mountedPage = page; polling = true;
      page.replaceChildren(new Element("article")); void api("/fixture/status-read");
      if (failMount) { failMount = false; throw new Error("partial mount failed"); }
    },
    stopPolling() { operations.push({ name: "stop", page: mountedPage }); stops++; polling = false; mountedPage = null; }
  };
  const module = { createShortVideoTranscodeStatusView(deps) { factories.push(deps); return view; } };
  const context = vm.createContext({ document, loadModule(url) { const request = { url, ...deferred() }; requests.push(request); return request.promise; } });
  vm.runInContext(`${code}\nglobalThis.create=createShortVideoTranscodeManagementPage;`, context);
  const wrapper = context.create({ api, els: { workGrid: root }, formatBytes: String, setMainHeader: (...args) => headers.push(args), state });
  const render = () => { wrapper.render(); return root.children.at(-1); };
  return { wrapper, root, state, document, requests, apiCalls, factories, mounts, operations, headers, module, view, render,
    failNextMount() { failMount = true; }, get stops() { return stops; }, get polling() { return polling; } };
}

async function stoppedPendingImportCannotMount(code = implementation) {
  for (const failure of [false, true]) {
    const f = fixture({ code }), page = f.render(), initial = page.textContent;
    f.wrapper.stop(); f.wrapper.stop();
    if (failure) f.requests[0].reject(new Error("old module failed")); else f.requests[0].resolve(f.module);
    await settle();
    assert.equal(f.mounts.length, 0, "a stopped lazy page cannot mount or start status requests later");
    assert.equal(f.apiCalls.length, 0); assert.equal(f.stops, 0, "stopping an unresolved import cannot enqueue a stop against a future mount");
    assert.equal(page.textContent, initial, "a stopped page ignores late import errors even while its old node remains connected");
  }
}
await stoppedPendingImportCannotMount();

{
  const f = fixture(); f.wrapper.activate();
  assert.equal(f.state.shortVideo.current, null); assert.equal(f.state.shortVideo.prevVideo, null); assert.equal(f.state.shortVideo.nextVideo, null);
  assert.equal(f.state.shortVideo.prevId, ""); assert.equal(f.state.shortVideo.nextId, ""); assert.equal(f.headers.length, 1);
  const first = f.render(), second = f.render();
  assert.equal(f.requests.length, 1, "concurrent renders share the module download");
  f.requests[0].resolve(f.module); await settle();
  assert.equal(f.factories.length, 1); assert.equal(f.factories[0].formatBytes, String);
  assert.deepEqual(f.mounts, [second]); assert.equal(first.querySelector("article"), null);
  assert.equal(f.polling, true); f.wrapper.stop();
}
{
  const f = fixture(), first = f.render();
  f.wrapper.stop(); const second = f.render(); f.requests[0].resolve(f.module); await settle();
  assert.deepEqual(f.mounts, [second]); assert.equal(first.querySelector("article"), null);
  assert.equal(f.polling, true); assert.equal(f.stops, 0, "an old unresolved stop cannot stop the current owner after import");
  f.wrapper.stop();
}
async function mountedStopIsSynchronous(code = implementation) {
  const f = fixture({ code }); const first = f.render(); f.requests[0].resolve(f.module); await settle();
  assert.deepEqual(f.mounts, [first]); assert.equal(f.polling, true);
  f.wrapper.stop(); assert.equal(f.polling, false, "mounted polling must stop synchronously when its page leaves");
  assert.equal(f.stops, 1); f.wrapper.stop(); assert.equal(f.stops, 1, "repeated stop releases a mounted owner once");
  const second = f.render(); await settle();
  assert.equal(f.requests.length, 1); assert.equal(f.factories.length, 1);
  assert.deepEqual(f.mounts, [first, second]); assert.equal(f.polling, true); assert.equal(f.stops, 1);
  f.wrapper.stop();
}
await mountedStopIsSynchronous();

{
  const f = fixture(); f.render(); f.requests[0].resolve(f.module); await settle();
  const second = f.render(); assert.equal(f.polling, false, "render revokes its previous mounted owner before scheduling replacement");
  await settle(); assert.equal(f.mounts.at(-1), second); assert.equal(f.polling, true);
  assert.deepEqual(f.operations.map(item => item.name), ["mount", "stop", "mount"]);
  f.wrapper.stop();
}
{
  const f = fixture(); f.render(); f.requests[0].resolve(f.module); await settle();
  f.wrapper.stop(); const pending = f.render(); f.wrapper.stop(); await settle();
  assert.equal(f.mounts.length, 1); assert.equal(pending.querySelector("article"), null, "a cached module's already-queued mount still checks its current page");
}
for (const invalidation of ["mode", "view", "detached"]) {
  const f = fixture(), page = f.render(), text = page.textContent;
  if (invalidation === "mode") f.state.shortVideo.mode = "feed";
  if (invalidation === "view") f.state.activeView = "other-module";
  if (invalidation === "detached") page.remove();
  f.requests[0].resolve(f.module); await settle();
  assert.equal(f.mounts.length, 0); assert.equal(f.apiCalls.length, 0); assert.equal(page.textContent, text);
}
{
  const f = fixture(), first = f.render(); f.wrapper.stop(); const second = f.render();
  f.requests[0].reject(new Error("module unavailable")); await settle();
  assert.doesNotMatch(first.textContent, /module unavailable/); assert.match(second.textContent, /module unavailable/);
  const retry = f.render(); assert.equal(f.requests.length, 2, "a failed module can be retried by the next render");
  f.requests[1].resolve(f.module); await settle(); assert.deepEqual(f.mounts, [retry]); f.wrapper.stop();
}
for (const invalidModule of [{}, { createShortVideoTranscodeStatusView() { throw new Error("factory failed"); } }]) {
  const f = fixture(), page = f.render(); f.requests[0].resolve(invalidModule); await settle();
  assert(page.querySelector(".short-video-transcode-error"));
  const retry = f.render(); assert.equal(f.requests.length, 2); f.requests[1].resolve(f.module); await settle();
  assert.deepEqual(f.mounts, [retry]); f.wrapper.stop();
}
{
  const f = fixture(); const page = f.render(); f.failNextMount(); f.requests[0].resolve(f.module); await settle();
  assert.equal(f.polling, false); assert.equal(f.stops, 1, "a partially mounted owner is released when mount throws");
  assert.match(page.textContent, /partial mount failed/); assert(page.querySelector(".short-video-transcode-error"));
  const retry = f.render(); await settle(); assert.equal(f.mounts.at(-1), retry); assert.equal(f.polling, true); f.wrapper.stop();
}

// Use the actual composition-root render/route functions to verify the old
// transcode import cannot replace or resume a paused current video.
function pageBridge(f) {
  let current = null;
  const env = vm.createContext({ state: f.state, els: { workGrid: f.root }, document: f.document, transcodeManagementPage: f.wrapper,
    shortVideoHomePresentation: null, ensureState() {}, invalidateShortVideoListWork() {}, syncShortVideoNativePlaybackModes() {}, cancelShortVideoPanelLoading() {},
    stopShortVideoSoundPreview() {}, cancelShortVideoAutoNext() {}, cancelShortVideoBrowseGestures() {}, resetShortVideoWindow() {}, clearPendingPlayerClick() {},
    releaseUnusedShortVideoPreloads() {}, disposeShortVideoMedia, setBodyClass() {}, renderHome() {}, renderStats() {}, shortVideoOpeningId: "",
    renderBrowser() {
      current = new Element("video"); Object.assign(current, { src: "/fixture/A", currentTime: 7.9682, paused: true, muted: false, pauses: 0, loads: 0 });
      current.pause = () => { current.pauses++; current.paused = true; }; current.load = () => current.loads++;
      current.removeAttribute = name => { if (name === "src") current.src = ""; }; f.root.append(current);
    }
  });
  vm.runInContext(`${pageFunction("refreshShortVideoHome")}\n${pageFunction("renderView")}\n${pageFunction("openRouteTarget")}\nglobalThis.api={renderView,openRouteTarget};`, env);
  return { api: env.api, get current() { return current; } };
}
for (const failure of [false, true]) {
  const f = fixture(), bridge = pageBridge(f);
  await bridge.api.openRouteTarget({ shortVideoMode: "transcoding" }); const previous = f.root.children[0];
  f.state.shortVideo.mode = "feed"; f.state.shortVideo.current = { id: "A" }; bridge.api.renderView();
  const player = bridge.current, before = { src: player.src, time: player.currentTime, paused: player.paused, pauses: player.pauses, loads: player.loads };
  if (failure) f.requests[0].reject(new Error("late import")); else f.requests[0].resolve(f.module);
  await settle();
  assert.equal(previous.isConnected, false); assert.equal(bridge.current, player); assert.equal(f.root.children[0], player);
  assert.deepEqual({ src: player.src, time: player.currentTime, paused: player.paused, pauses: player.pauses, loads: player.loads }, before);
  assert.equal(f.mounts.length, 0); assert.equal(f.apiCalls.length, 0);
}

// Bridge the wrapper to the actual status-view factory as well: the retired
// GET remains pending while a remounted view starts its own polling resource.
const statusHelpersFile = new URL("./verify_short_video_transcode_lifecycle.mjs", import.meta.url);
let statusHelpers = fs.readFileSync(statusHelpersFile, "utf8");
statusHelpers = statusHelpers.slice(0, statusHelpers.indexOf("\nlet groups = 0;"));
statusHelpers = statusHelpers.replace(/from "(\.\.\/public\/[^\"]+)"/g, (_, relative) => `from "${new URL(relative, statusHelpersFile).href}"`);
const { fixture: statusFixture, status } = await import(`data:text/javascript;base64,${Buffer.from(`${statusHelpers}\nexport { fixture, status };`).toString("base64")}`);
const globals = Object.fromEntries(["document", "window", "navigator"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
try {
  const f = statusFixture(), module = deferred(), reads = [];
  const state = { activeView: "shortVideos", shortVideo: { mode: "transcoding" } };
  const context = vm.createContext({ document: f.doc, loadModule: () => module.promise });
  vm.runInContext(`${implementation}\nglobalThis.create=createShortVideoTranscodeManagementPage;`, context);
  const wrapper = context.create({ state, els: { workGrid: f.container }, formatBytes: String, setMainHeader() {},
    api(path, options) { const request = { path, options, ...deferred() }; reads.push(request); return request.promise; }
  });
  wrapper.render(); module.resolve({ createShortVideoTranscodeStatusView }); await settle();
  assert.equal(reads.length, 1); assert.equal(f.intervals.size, 1);
  wrapper.stop(); assert.equal(f.intervals.size, 0); assert.equal(f.win.listenerCount(), 0); assert.equal(f.doc.listenerCount(), 0);
  wrapper.render(); await settle(); const page = f.container.children.at(-1);
  assert.equal(reads.length, 2, "actual remount starts a fresh GET while its retired request is still pending");
  const before = f.snapshot(); reads[0].resolve(status("retired-wrapper-read")); await settle();
  assert.deepEqual(f.snapshot(), before); assert(!page.textContent.includes("retired-wrapper-read"));
  reads[1].resolve(status("fresh-wrapper-read")); await settle(); assert(page.textContent.includes("fresh-wrapper-read"));
  wrapper.stop(); assert.equal(f.intervals.size, 0); assert.equal(f.win.listenerCount(), 0); assert.equal(f.doc.listenerCount(), 0);
} finally {
  for (const [name, descriptor] of Object.entries(globals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
  }
}

// Negative controls execute weakened copies of the real wrapper in memory.
const unowned = implementation.replace(/const isCurrent = \(\) =>[\s\S]+?;/,
  'const isCurrent = () => page.isConnected && state.shortVideo.mode === "transcoding";');
assert.notEqual(unowned, implementation);
await assert.rejects(stoppedPendingImportCannotMount(unowned), /stopped lazy page cannot mount/);
const lateStop = implementation.replace("view?.stopPolling?.();", "Promise.resolve().then(() => view?.stopPolling?.());");
assert.notEqual(lateStop, implementation);
await assert.rejects(mountedStopIsSynchronous(lateStop), /mounted polling must stop synchronously/);

console.log("short-video-transcode-page: passed actual lazy page ownership, synchronous stop, shared import/remount/retry, partial mount cleanup and paused-player route handoff");
