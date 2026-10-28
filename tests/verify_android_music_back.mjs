import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { appFunction, createNavigationFixtureDocument } from "./fixtures/android-gallery-navigation-harness.mjs";
import { captureAccountOwner, confirmAccountOwner, setAccountOwner } from "../android-client/www/js/account-owner.js";

// Execute the whole music factory (including its actual search/sheet helpers),
// Android module, normalized registry and shell native-Back dispatcher. Only
// DOM/layout, clocks, storage, audio and HTTP completion are controlled. No
// service, real media/database, browser or physical device is accessed.
const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const viewUrl = new URL("../android-client/www/modules/music/music-views.js", import.meta.url);
const viewSource = read("android-client/www/modules/music/music-views.js");
const sheetsUrl = new URL("../android-client/www/modules/music/music-sheets.js", import.meta.url);
const sheetsSource = read("android-client/www/modules/music/music-sheets.js");
const controlFocusImport = /import \{ createMusicControlFocus \} from "([^"]+)";/.exec(viewSource)?.[1];
assert(controlFocusImport, "the actual music factory composes the control-focus helper");
const controlFocusUrl = new URL(controlFocusImport, viewUrl);
const controlFocusSource = fs.readFileSync(controlFocusUrl, "utf8").replace(/\r\n/g, "\n");
const preferenceImport = /import \{ createMusicTrackPreferences \} from "([^"]+)";/.exec(viewSource)?.[1];
assert(preferenceImport, "the whole music factory composes its actual track preference helper");
const preferenceUrl = new URL(preferenceImport, viewUrl);
const preferenceSource = fs.readFileSync(preferenceUrl, "utf8").replace(/\r\n/g, "\n");
const moduleSource = read("android-client/www/modules/music/android-module.js").replace(/^import[^\n]*\n/gm, "").replace(/^export /gm, "");
const registrySource = read("android-client/www/js/android-module-registry.js").replace(/^export /gm, "");
const appSource = read("android-client/www/app.js");
const appUrl = new URL("../android-client/www/app.js", import.meta.url);
const appSheetImport = /import \{ closeMobileActionSheet \} from "([^"]+)";/.exec(appSource)?.[1];
assert(appSheetImport, "the actual shell imports the shared-sheet close implementation");
const sharedSheetUrl = new URL(appSheetImport, appUrl);
assert(sharedSheetUrl.searchParams.get("v"), "the actual shell uses a versioned shared-sheet singleton");
const playlistViewImport = /import \{ createMusicPlaylistView \} from "([^"]+)";/.exec(viewSource)?.[1];
assert(playlistViewImport, "the whole music factory composes the actual playlist view");
const playlistViewUrl = new URL(playlistViewImport, viewUrl);
const playlistViewSource = fs.readFileSync(playlistViewUrl, "utf8").replace(/\r\n/g, "\n");
const playlistSheetImport = /import \{ openMobileActionSheet \} from "([^"]+)";/.exec(playlistViewSource)?.[1];
assert(playlistSheetImport, "the actual playlist management imports the shared sheet");
assert.equal(new URL(playlistSheetImport, playlistViewUrl).href, sharedSheetUrl.href,
  "playlist management and shell Back must share the exact versioned sheet module URL");
const { closeMobileActionSheet } = await import(sharedSheetUrl.href);
const backStart = appSource.indexOf("window.fanhaoHandleNativeBack = () => {");
assert(backStart >= 0, "actual shell Back dispatcher exists");
const backSource = appSource.slice(backStart, appSource.indexOf("\n};", backStart) + 3);
const mainSource = read("android-client/android/app/src/main/java/local/fanhao/library/MainActivity.java");
assert(mainSource.includes('if (!"true".equals(handled)) {\n          moveTaskToBack(true);'),
  "unhandled Back uses the source-verified native task fallback; this is not device acceptance");
const original = Object.fromEntries(["window", "document", "localStorage", "fetch", "dispatchEvent", "CustomEvent", "__musicBackFixture"].map(key => [key, globalThis[key]]));
const settle = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
const copy = value => JSON.parse(JSON.stringify(value));
let cases = 0, selectedCase = "", fixtureId = 0;

const importUrl = (source, url) => `data:text/javascript;base64,${Buffer.from(source.replace(/from "(\.\.?\/[^\"]+)"/g,
  (_all, relative) => `from ${JSON.stringify(new URL(relative, url).href)}`)).toString("base64")}`;

async function importFactory(source = viewSource, sheetsCode = null, focusCode = null, preferenceCode = null) {
  if (sheetsCode) {
    const pattern = /^import \{ createMusicSheets \} from "[^\"]+";$/m;
    assert(pattern.test(source), "actual views compose the actual music sheets helper");
    source = source.replace(pattern, `import { createMusicSheets } from ${JSON.stringify(importUrl(sheetsCode, sheetsUrl))};`);
  }
  if (focusCode) {
    const pattern = /^import \{ createMusicControlFocus \} from "[^"]+";$/m;
    assert(pattern.test(source), "focus negative controls replace the actual composed helper");
    source = source.replace(pattern, `import { createMusicControlFocus } from ${JSON.stringify(importUrl(focusCode, controlFocusUrl))};`);
  }
  if (preferenceCode) {
    const pattern = /^import \{ createMusicTrackPreferences \} from "[^"]+";$/m;
    assert(pattern.test(source), "preference negative controls replace the actual composed helper");
    source = source.replace(pattern, `import { createMusicTrackPreferences } from ${JSON.stringify(importUrl(preferenceCode, preferenceUrl))};`);
  }
  const hook = "  installLifecycle();";
  assert.equal(source.split(hook).length, 2, "one actual factory lifecycle boundary");
  const exposed = source.replace(hook, `
  globalThis.__musicBackFixture = { state, openMusicSearch, openTrackActions, renderShell, closeSearch,
    commitMusicSearch, refreshMountedSearchResults, loadPlaylists, loadSmartPlaylists,
    activate() { moduleActive = true; },
    setAudio(value) { audio = value; }, getAudio() { return audio; } };
  installLifecycle();`);
  return (await import(importUrl(exposed, viewUrl))).createMusicViews;
}

function fixture(createMusicViews, { code = moduleSource, view = "music", stack = true, routeNavigation = false, allowRestoreAudio = false } = {}) {
  const document = globalThis.document = createNavigationFixtureDocument();
  const prototype = Object.getPrototypeOf(document.body);
  if (!Object.getOwnPropertyDescriptor(prototype, "isConnected")) {
    Object.defineProperty(prototype, "isConnected", { get() { return this.ownerDocument.body.contains(this); } });
    Object.defineProperty(prototype, "childNodes", { get() { return this.children; } });
    prototype.blur = function() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; };
    prototype.scrollTo = function(options) { if (Number.isFinite(options?.top)) this.scrollTop = options.top; };
    const focus = prototype.focus;
    prototype.focus = function(...args) {
      const previous = this.ownerDocument.activeElement; focus.apply(this, args);
      if (previous !== this) this.dispatchEvent({ type: "focusin", target: this, bubbles: true });
    };
    const html = Object.getOwnPropertyDescriptor(prototype, "innerHTML");
    Object.defineProperty(prototype, "innerHTML", { ...html, set(value) {
      html.set.call(this, value);
      const owner = this.ownerDocument;
      if (owner.body && owner.activeElement && !owner.body.contains(owner.activeElement)) owner.activeElement = owner.body;
    } });
    const matches = prototype.matches;
    prototype.matches = function(selector) {
      if (selector.includes(":not(:disabled)")) return selector.split(",").some(part => !this.disabled
        && matches.call(this, part.trim().replace(":not(:disabled)", "")));
      return matches.call(this, selector);
    };
    const queryAll = prototype.querySelectorAll;
    prototype.querySelectorAll = function(selector) {
      if (selector.includes(",")) {
        const matches = new Set(selector.split(",").flatMap(part => this.querySelectorAll(part.trim()))), ordered = [];
        const visit = node => { for (const child of node.children) { if (matches.has(child)) ordered.push(child); visit(child); } };
        visit(this); return ordered;
      }
      if (!selector.startsWith(":scope") && selector.includes(">")) {
        const [parent, child] = selector.split(/\s*>\s*/);
        return this.querySelectorAll(parent).flatMap(node => node.children.filter(candidate => candidate.matches(child)));
      }
      const parts = selector.trim().split(/\s+/);
      if (parts.length < 2 || selector.startsWith(":scope")) return queryAll.call(this, selector);
      return queryAll.call(this, parts.at(-1)).filter(node => {
        let ancestor = node.parentNode;
        for (let index = parts.length - 2; index >= 0; index--) {
          while (ancestor && ancestor !== this.parentNode && !ancestor.matches?.(parts[index])) ancestor = ancestor.parentNode;
          if (!ancestor || ancestor === this.parentNode) return false;
          ancestor = ancestor.parentNode;
        }
        return true;
      });
    };
  }
  document.querySelector = selector => document.body.querySelector(selector);
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  document.removeEventListener = (type, callback) => {
    const kept = (document.listeners.get(type) || []).map((handler, index) => ({ handler, capture: document.listenerCaptures.get(type)?.[index] }))
      .filter(entry => entry.handler !== callback);
    document.listeners.set(type, kept.map(entry => entry.handler)); document.listenerCaptures.set(type, kept.map(entry => entry.capture));
  };
  document.createTextNode = text => { const node = document.createElement("span"); node.textContent = text; return node; };
  document.body.parentNode = document; document.activeElement = document.body;
  const listeners = new Map(), calls = [], requests = [], routes = [], events = [], dialogs = [], clocks = new Map(), frames = new Map(), storage = new Map();
  let timerId = 0, frameId = 0, sourceUrl = "http://music-back.fixture.invalid:29998";
  const fetch = (url, options = {}) => {
    assert(/^http:\/\/music-back(?:-other)?\.fixture\.invalid:29998\/api\//.test(String(url))
      || (allowRestoreAudio && String(url) === "http://music-back.fixture.invalid:29998/synthetic/audio/restore"), "only explicitly controlled synthetic fixture HTTP is allowed");
    let complete, fail;
    // Deliberately deliver after abort too, to verify the production reply guard.
    const promise = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
    requests.push({ url: String(url), options, signal: options.signal, settled: false, resolve(payload, status = 200) {
      this.settled = true; complete({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => payload });
    }, reject(error = new Error("Synthetic network failure")) { this.settled = true; fail(error); }, resolveAudio() {
      this.settled = true; complete({ ok: true, status: 200, blob: async () => new Blob([new Uint8Array(16)], { type: "audio/wav" }) });
    } });
    return promise;
  };
  const window = globalThis.window = {
    addEventListener(type, callback) { const entries = listeners.get(type) || []; entries.push(callback); listeners.set(type, entries); },
    removeEventListener(type, callback) { listeners.set(type, (listeners.get(type) || []).filter(item => item !== callback)); },
    dispatchEvent(event) { events.push({ type: event.type, detail: event.detail }); for (const callback of [...listeners.get(event.type) || []]) callback(event); return true; },
    prompt(...args) { dialogs.push({ kind: "prompt", args, focus: document.activeElement, sheet: document.querySelector(".mobile-action-sheet-overlay") }); return null; },
    confirm(...args) { dialogs.push({ kind: "confirm", args, focus: document.activeElement, sheet: document.querySelector(".mobile-action-sheet-overlay") }); return false; },
    setTimeout(fn, delay) { const id = ++timerId; clocks.set(id, { fn, delay }); return id; },
    clearTimeout(id) { clocks.delete(id); }, setInterval() { return ++timerId; }, clearInterval() {},
    requestAnimationFrame(fn) { const id = ++frameId; frames.set(id, fn); return id; }, cancelAnimationFrame(id) { frames.delete(id); },
    scrollTo() {}, scrollY: 0,
    history: { state: { marker: "music-back-fixture" }, length: 3, back: () => calls.push("history") }, fetch
  };
  globalThis.localStorage = { getItem: key => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
  window.localStorage = globalThis.localStorage;
  globalThis.fetch = fetch;
  globalThis.dispatchEvent = event => window.dispatchEvent(event);
  globalThis.CustomEvent = original.CustomEvent || class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } };
  const els = { viewContent: document.createElement("main"), viewTitle: {}, viewKicker: {}, viewMeta: {},
    appConfirmOverlay: { hidden: true }, settingsOverlay: { hidden: true } };
  document.body.append(els.viewContent);
  let audit, app, raw;
  const host = { els, getActiveUrl: () => sourceUrl,
    navigation: { showView: (...args) => {
      calls.push(args);
      if (app) { app.currentView = args[0]; app.currentViewParams = args[1]; }
      if (routeNavigation) {
        const pending = raw.api.musicViews.renderMusicList(args[1]); routes.push({ params: args[1], pending }); return pending;
      }
      // Existing scenarios retain their shell-only navigation boundary.
      audit?.renderShell();
    }, replaceViewParams: (...args) => calls.push({ replace: args }) }, ui: { setActiveBottom() {} } };
  const context = vm.createContext({ createMusicViews, window, document });
  const create = vm.runInContext(`(function(){${code}\nreturn createAndroidModule;})()`, context);
  raw = create({ host });
  audit = globalThis.__musicBackFixture; audit.activate();
  const api = vm.runInContext(`(function(){${registrySource}\nreturn { normalizeModule, createRegistry };})()`, context);
  const normalized = api.normalizeModule(raw, { id: "music", client: { android: {} } });
  const registry = api.createRegistry([normalized]);
  app = vm.createContext({ window, document, androidModuleRegistry: registry, els, closeMobileActionSheet,
    // This factory fixture has no shell menus; the gallery harness exercises
    // their real dispatcher. Observe only the unhandled menu-layer boundary.
    modePickerBackCalls: 0,
    closeActiveModePicker(restoreFocus) {
      assert.equal(restoreFocus, true, "native Back requests focus restoration at the menu boundary");
      app.modePickerBackCalls += 1;
      return false;
    },
    mediaViewer: { close: () => false }, searchSurfaceExpanded: false, currentView: view, currentViewParams: {}, HISTORY_MARKER: "music-back-fixture",
    normalizeChannelMode: value => value, returnToStackView: () => { if (stack) calls.push("stack"); return stack; },
    applyBackState: () => calls.push("apply-back"), settleAppConfirmation() {}, closeSettings() {}, closeSearchSurface() {} });
  vm.runInContext(appFunction(appSource, "isRootNavigationView") + "\n" + backSource, app);
  fixtureId++;
  return { document, window, els, raw, registry, audit, calls, requests, routes, events, dialogs, clocks, frames, host, app,
    back: () => window.fanhaoHandleNativeBack(),
    emit: (type, detail) => window.dispatchEvent({ type, detail }),
    setSource: (value = "http://music-back-other.fixture.invalid:29998") => { sourceUrl = value; },
    flushFrames() { const ready = [...frames.values()]; frames.clear(); ready.forEach(callback => callback(performance.now())); return ready.length; },
    navigate: () => calls.filter(Array.isArray),
    elapse(delay) { for (const [id, timer] of [...clocks]) if (timer.delay <= delay && clocks.delete(id)) timer.fn(); },
    input(value) {
      const input = document.querySelector(".music-mobile-search-input"); assert(input, "actual search input is mounted");
      input.value = value;
      input.dispatchEvent({ type: "input", target: input, bubbles: true });
    }
  };
}

function assertSearchBack(createMusicViews, options = {}) {
  const f = fixture(createMusicViews, options), s = f.audit.state;
  f.audit.openMusicSearch();
  assert(f.document.querySelector(".music-mobile-search-surface"), "actual blank search surface is visible");
  assert.equal(f.back(), true, "Back consumes the blank music search");
  assert.equal(f.app.modePickerBackCalls, 1, "an absent shell menu lets Back reach the music module");
  assert.equal(s.searchOpen, false, "blank search closes");
  assert.equal(s.query, "");
  assert.equal(f.document.querySelector(".music-mobile-search-surface"), null);
  assert.equal(f.navigate().length, 1);
  assert.equal(f.back(), false, "next Back reaches the normal music root fallback");
  assert.equal(f.calls.includes("stack"), false, "closing search does not pop unrelated history");
}

function assertLayeredBack(createMusicViews) {
  const f = fixture(createMusicViews), s = f.audit.state;
  const current = { id: "synthetic-playing", title: "Synthetic playing song", durationMs: 120000, streamUrl: "/fixture/playing" };
  const queued = { id: "synthetic-next", title: "Synthetic next song", durationMs: 150000, streamUrl: "/fixture/next" };
  const audioCalls = [], audio = { paused: false, currentTime: 37.5, duration: 120, volume: 0.63, src: "fixture:playing",
    pause: () => audioCalls.push("pause"), play: () => { audioCalls.push("play"); return Promise.resolve(); }, load: () => audioCalls.push("load") };
  Object.assign(s, { current, queue: [current, queued], playing: true, data: { tracks: [current, queued], total: 2 } });
  f.audit.setAudio(audio);
  f.audit.openMusicSearch();
  Object.assign(s, { fullscreen: true, queueOpen: true, queueManageOpen: true, trackActionId: current.id });
  f.audit.renderShell();
  assert(f.document.querySelector(".music-mobile-track-actions-sheet"));
  assert.equal(f.back(), true);
  assert.equal(s.trackActionId, "", "first Back closes the top track actions");
  assert.equal(s.queueOpen, true); assert.equal(s.fullscreen, true); assert.equal(s.searchOpen, true);
  assert.equal(f.back(), true);
  assert.equal(s.queueOpen, false); assert.equal(s.queueManageOpen, false);
  assert.equal(s.fullscreen, true, "queue Back preserves full player"); assert.equal(s.searchOpen, true);
  assert.equal(f.back(), true);
  assert.equal(s.fullscreen, false, "next Back closes full player"); assert.equal(s.searchOpen, true);
  assert.equal(f.navigate().length, 0, "modal/full player returns preserve search and route");
  assert.equal(f.back(), true); assert.equal(s.searchOpen, false);
  assert.equal(f.back(), false, "only the final root Back reaches native fallback");
  assert.equal(s.current, current); assert.deepEqual(s.queue, [current, queued]); assert.equal(s.playing, true);
  assert.equal(f.audit.getAudio(), audio); assert.equal(audio.currentTime, 37.5); assert.equal(audio.src, "fixture:playing");
  assert.deepEqual(audioCalls, [], "Back does not pause, restart or reload background playback");
}

function trackActionFixture(createMusicViews) {
  const f = fixture(createMusicViews), s = f.audit.state;
  const current = { id: "fixture-playing", title: "Playing fixture", streamUrl: "/fixture/playing", durationMs: 120000 };
  const candidate = { id: "fixture-A", title: "Candidate fixture", streamUrl: "/fixture/A", durationMs: 120000,
    artistId: "fixture-artist", albumId: "fixture-album", downloadUrl: "/fixture/download", favorite: false };
  const other = { ...candidate, id: "fixture-B", title: "Other fixture" };
  Object.assign(s, { dashboard: false, current, playing: true, queue: [current], mode: "playlist", playlistId: "fixture-playlist",
    data: { tracks: [candidate, other], total: 2 }, gapless: false, crossfadeSeconds: 0 });
  f.audit.openTrackActions(candidate.id);
  const sheet = f.document.querySelector(".music-mobile-track-actions-sheet"); assert(sheet);
  const actions = sheet.querySelectorAll(".music-mobile-track-action-choice");
  assert.equal(actions.length, 9, "all real queue/play/favorite/navigation/download/playlist track actions are present");
  const button = label => actions.find(node => node.getAttribute("aria-label") === label);
  return { ...f, s, current, candidate, other, sheet, actions, button,
    done: sheet.querySelectorAll("button").find(node => node.textContent === "完成"),
    backdrop: f.document.querySelector(".music-mobile-track-actions-backdrop") };
}

function playlistManagementFixture(createMusicViews, { playing = false } = {}) {
  const f = fixture(createMusicViews), s = f.audit.state;
  const playlist = { id: "fixture-management-playlist", name: "Synthetic playlist management", description: "Fixture description", trackCount: 1 };
  const track = { id: "fixture-management-track", title: "Synthetic playlist track", streamUrl: "", downloadUrl: "", durationMs: 120000 };
  const audioCalls = [], audio = { paused: false, currentTime: 37.5, duration: 120, volume: 0.63, src: "fixture:playlist-playing",
    pause: () => audioCalls.push("pause"), play: () => { audioCalls.push("play"); return Promise.resolve(); }, load: () => audioCalls.push("load") };
  Object.assign(s, { mode: "playlist", dashboard: false, playlistId: playlist.id, playlists: [playlist], playlist,
    data: { playlist, tracks: [track], total: 1 } });
  if (playing) {
    Object.assign(s, { current: track, queue: [track], playing: true });
    f.audit.setAudio(audio);
  }
  f.audit.renderShell();
  const trigger = f.document.querySelector(".music-mobile-playlist-management");
  assert(trigger, "the whole factory renders the real playlist management entry");
  assert.equal(trigger.tagName, "BUTTON", "playlist management uses an explicit button instead of a native details popup");
  assert.equal(trigger.getAttribute("aria-label"), "管理歌单");
  assert.equal(trigger.getAttribute("aria-haspopup"), "dialog");
  const open = (button = trigger) => {
    const other = f.document.createElement("button"); f.document.body.append(other); other.focus();
    button.click();
    const sheet = f.document.querySelector(".music-mobile-playlist-management-sheet");
    assert(sheet?.classList.contains("mobile-action-sheet-panel"), "real playlist management opens the actual shared sheet");
    assert.equal(sheet.getAttribute("role"), "dialog");
    const options = sheet.querySelectorAll(".mobile-action-sheet-option");
    assert.deepEqual(options.map(option => option.textContent), ["编辑歌单", "删除歌单"]);
    return { sheet, options };
  };
  return { ...f, s, playlist, track, trigger, audio, audioCalls, open };
}

function libraryControlFixture(createMusicViews, kind, options = {}) {
  const f = fixture(createMusicViews, options), s = f.audit.state;
  const track = { id: "fixture-library-playing", title: "Synthetic library song", artistId: "fixture-library-artist", albumId: "fixture-library-album",
    artist: "Synthetic artist", album: "Synthetic album", durationMs: 120000, positionMs: 37500, streamUrl: "", downloadUrl: "" };
  const audioCalls = [], audio = { paused: false, currentTime: 37.5, duration: 120, volume: 0.63, src: "fixture:library-playing",
    addEventListener() {},
    pause: () => audioCalls.push("pause"), play: () => { audioCalls.push("play"); return Promise.resolve(); }, load: () => audioCalls.push("load") };
  Object.assign(s, { mode: "library", dashboard: false, current: track, queue: [track], playing: true,
    data: { tracks: [track], total: 1, artists: [{ id: track.artistId, name: track.artist }],
      albums: [{ id: track.albumId, artistId: track.artistId, title: track.album }],
      genres: [{ id: "Fixture genre", name: "Fixture genre" }], languages: [{ name: "Fixture language" }] } });
  f.audit.setAudio(audio); f.audit.renderShell();
  const selector = kind === "sort" ? ".music-mobile-focused-library-sort" : ".music-mobile-focused-library-filter";
  const overlaySelector = kind === "sort" ? ".music-mobile-library-sort-sheet" : ".music-mobile-library-filter-overlay";
  const trigger = f.document.querySelector(selector); assert(trigger, `real ${kind} trigger is mounted`);
  const open = () => {
    trigger.click(); f.flushFrames();
    const overlay = f.document.querySelector(overlaySelector); assert(overlay, `actual ${kind} panel opens`);
    assert(overlay.contains(f.document.activeElement), `actual ${kind} panel receives focus before dismissal`);
    return overlay;
  };
  const playbackUnchanged = () => {
    assert.equal(s.current, track); assert.deepEqual(s.queue, [track]); assert.equal(s.playing, true); assert.equal(track.positionMs, 37500);
    assert.equal(f.audit.getAudio(), audio); assert.equal(audio.currentTime, 37.5); assert.equal(audio.src, "fixture:library-playing");
    assert.equal(audio.volume, 0.63); assert.equal(audio.paused, false); assert.deepEqual(audioCalls, []);
  };
  return { ...f, s, track, audio, selector, overlaySelector, trigger, open, playbackUnchanged };
}

function fire(node, type, values = {}) {
  const event = { type, bubbles: true, defaultPrevented: false, ...values,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
  node.dispatchEvent(event); return event;
}

function userClick(node) {
  assert(node?.isConnected && !node.disabled, "a live enabled control receives the gesture");
  if (!fire(node, "pointerdown", { pointerId: 1, isPrimary: true }).defaultPrevented) node.focus();
  node.click();
}

// Preference cases load the real route and detail transport before using its
// controls. In particular, an ID alone must not fabricate source provenance.
async function preferenceFixture(createMusicViews) {
  const f = fixture(createMusicViews, { routeNavigation: true });
  const s = f.audit.state, a = f.host.getActiveUrl(), b = "http://music-back-other.fixture.invalid:29998";
  setAccountOwner(a, "account:preference-A", { force: true });
  setAccountOwner(b, "account:preference-B", { force: true });
  const track = (label, changes = {}) => ({ id: "preference-shared-id", title: `${label} title`, artist: `${label} artist`,
    album: `${label} album`, artistId: `${label}-artist`, albumId: `${label}-album`, streamUrl: "", downloadUrl: "",
    favorite: false, rating: 0, positionMs: 37500, durationMs: 120000, ...changes });
  const audioCalls = [], audio = { paused: false, currentTime: 37.5, duration: 120, volume: 0.63, readyState: 1,
    src: "fixture:preference-audio", playbackRate: 1, addEventListener() {}, removeEventListener() {},
    pause: () => audioCalls.push("pause"), play: () => { audioCalls.push("play"); return Promise.resolve(); }, load: () => audioCalls.push("load") };
  f.audit.setAudio(audio); s.resumeQueue = true; s.gapless = false; s.crossfadeSeconds = 0; s.volume = 0.63;
  const writes = (field = null) => f.requests.filter(request => request.options.method === "POST"
    && (!field || new URL(request.url).pathname.endsWith(`/${field}`)));
  const reads = () => f.requests.filter(request => !request.settled && (!request.options.method || request.options.method === "GET"));
  const catalogue = items => ({ tracks: copy(items), total: items.length, hasMore: false });
  const completeReads = async (items, detail = null) => {
    for (let step = 0; step < 8; step++) {
      await settle();
      const pending = reads(); if (!pending.length) break;
      for (const request of pending) {
        const path = new URL(request.url).pathname;
        if (path === "/api/music/tracks") request.resolve(catalogue(items));
        else if (path === "/api/music/playlists") request.resolve({ playlists: [] });
        else if (path === "/api/music/smart-playlists") request.resolve({ smartPlaylists: [] });
        else if (path === "/api/music/artists") request.resolve({ artists: [], total: 0 });
        else if (path === "/api/music/albums") request.resolve({ albums: [], total: 0 });
        else {
          assert(detail && path === `/api/music/tracks/${detail.id}`, `only known preference fixture reads are completed: ${path}`);
          request.resolve({ track: copy(detail), lyrics: { lines: [], raw: "" }, prevId: "", nextId: "" });
        }
      }
    }
    await settle();
  };
  const mount = async (url = a, items = [track("A")], { current = false, params = {} } = {}) => {
    f.setSource(url);
    const route = f.raw.api.musicViews.renderMusicList({ mode: "library", dashboard: "0", ...params,
      ...(current ? { trackId: items[0].id } : {}) });
    const detail = current ? items[0] : items.find(track => track.id === params.trackId) || null;
    await completeReads(items, detail); await route; await settle();
    f.audit.renderShell();
    assert(f.document.querySelector(".music-mobile-track"), "the real route mounts a synthetic track row");
  };
  const click = async (field, value, surface = "row") => {
    let button;
    if (field === "rating") {
      Object.assign(s, { fullscreen: true, playbackSheetOpen: true }); f.audit.renderShell();
      button = f.document.querySelectorAll(".music-mobile-rating button").find(node => node.getAttribute("aria-label") === (value ? `设为 ${value} 星` : "清除评分"));
    } else if (surface === "player" || surface === "player more") {
      Object.assign(s, { fullscreen: true, playbackSheetOpen: false }); f.audit.renderShell();
      if (surface === "player more") {
        userClick(f.document.querySelector(".music-mobile-full-more"));
        button = f.document.querySelectorAll(".music-mobile-track-action-choice").find(node => ["收藏歌曲", "取消收藏"].includes(node.getAttribute("aria-label")));
      } else button = f.document.querySelectorAll(".music-mobile-full-quick-actions button").find(node => ["收藏", "取消收藏"].includes(node.getAttribute("aria-label")));
    } else {
      Object.assign(s, { fullscreen: false, playbackSheetOpen: false }); f.audit.renderShell();
      const row = f.document.querySelectorAll(".music-mobile-track").find(node => node.dataset.trackId === "preference-shared-id");
      assert(row, "the source-owned real row exists");
      if (surface === "more") {
        userClick(row.querySelector(".track-more"));
        button = f.document.querySelectorAll(".music-mobile-track-action-choice").find(node => ["收藏歌曲", "取消收藏"].includes(node.getAttribute("aria-label")));
      } else button = row.querySelector(".track-favorite");
    }
    assert(button, `the real ${surface} ${field} control exists`); userClick(button); await settle();
    if (surface === "more" || surface === "player more") {
      assert.equal(f.document.querySelector(".music-mobile-track-actions-sheet"), null,
        "More favorite closes its sheet immediately, before success or failure arrives");
      assert.equal(f.document.querySelector(".music-mobile-track-actions-backdrop"), null, "More favorite also removes the blocking backdrop immediately");
    }
  };
  const receipt = (request, field, value, changes = {}, failure = false) => request.resolve(failure
    ? { error: "Synthetic preference write failure" }
    : { ok: true, track: track("receipt metadata must not merge", { favorite: true, rating: 1, positionMs: 1, [field]: value, ...changes }) }, failure ? 503 : 200);
  const stable = () => {
    assert.equal(f.audit.getAudio(), audio); assert.equal(audio.src, "fixture:preference-audio");
    assert.equal(audio.currentTime, 37.5); assert.equal(audio.volume, 0.63); assert.equal(audio.paused, false);
    assert.deepEqual(audioCalls, [], "preference receipts never pause, play, load or seek Audio");
  };
  const saved = key => JSON.parse(f.window.localStorage.getItem(`fanhao.android.music.${key}`) || "null");
  await mount(a, [track("A")], { current: true });
  return { ...f, s, a, b, audio, track, writes, reads, catalogue, completeReads, mount, click, receipt, stable, saved };
}

async function assertPreferenceSameOwner(createMusicViews) {
  for (const field of ["favorite", "rating"]) for (const transition of ["active", "deactivate", "route"]) {
    const f = await preferenceFixture(createMusicViews), value = field === "favorite" ? true : 5;
    await f.click(field, value); const request = f.writes(field)[0]; assert(request);
    const confirmations = f.events.filter(event => event.type === "fanhaoAccountOwnerConfirmed").length;
    if (transition === "route") await f.mount(f.a, [f.track("new route")]);
    const before = copy(f.s.current), beforeList = copy(f.s.data.tracks[0]);
    let sentinel;
    if (transition === "deactivate") {
      f.raw.deactivate(); sentinel = f.document.createElement("p"); sentinel.textContent = "foreign page"; f.els.viewContent.replaceChildren(sentinel);
    }
    assert.equal(request.signal.aborted, false, "accepted preference writes survive route/sheet/module retirement");
    f.receipt(request, field, value); await settle();
    assert.deepEqual(copy(f.s.current), { ...before, [field]: value }, "same-owner receipt patches only its current-track field");
    assert.deepEqual(copy(f.s.data.tracks[0]), { ...beforeList, [field]: value }, "same-source routes accept only the preference field");
    if (sentinel) assert.equal(f.els.viewContent.children[0], sentinel, "inactive receipt cannot repaint the foreign page");
    assert(f.events.filter(event => event.type === "fanhaoAccountOwnerConfirmed").length > confirmations, "success uses actual API same-owner confirmation");
    assert.equal(f.saved("lastTrack").activeUrl, f.a); assert.equal(f.saved("lastTrack").track[field], value); f.stable();
    const savedQueue = f.saved("playbackQueue"); assert.equal(savedQueue.activeUrl, f.a);
    assert.equal(savedQueue.queue.find(track => track.id === f.s.current.id)[field], value, "same-owner queue restore record receives only its matching preference field");
  }
}

async function assertPreferenceSourceOwnership(createMusicViews) {
  for (const surface of ["row", "more", "player", "player more"]) {
    const f = await preferenceFixture(createMusicViews);
    await f.mount(f.b, [f.track("B", { favorite: true })]);
    if (surface === "player more") {
      userClick(f.document.querySelector(".music-mobile-track .track-more"));
      const add = f.document.querySelectorAll(".music-mobile-track-action-choice").find(node => node.getAttribute("aria-label") === "加入队列");
      assert(add); userClick(add); await settle();
      assert.equal(f.document.querySelector(".music-mobile-track-actions-sheet"), null, "row B's non-favorite action closes before player A opens More");
      assert.equal(f.writes().length, 0, "warming row B's More target does not send a mutation");
    }
    const beforeCurrent = copy(f.s.current), beforeList = copy(f.s.data.tracks[0]);
    await f.click("favorite", null, surface); const request = f.writes("favorite")[0]; assert(request);
    const player = surface.startsWith("player"), url = player ? f.a : f.b, value = player;
    assert.equal(new URL(request.url).origin, url, "row/More use their explicit track source; player uses playback source");
    assert.equal(JSON.parse(request.options.body).favorite, value, "desired value comes from the selected entity, not a colliding ID");
    f.receipt(request, "favorite", value); await settle();
    assert.deepEqual(copy(f.s.current), player ? { ...beforeCurrent, favorite: true } : beforeCurrent, "B's ID cannot change current A");
    assert.deepEqual(copy(f.s.data.tracks[0]), player ? beforeList : { ...beforeList, favorite: false });
    assert.deepEqual(copy(f.s.queue[0]), player ? beforeList : { ...beforeList, favorite: false }, "queue is patched according to its own source");
    const last = f.saved("lastTrack"); assert.equal(last.activeUrl, f.a); assert.equal(last.track.title, beforeCurrent.title);
    assert.equal(last.track.favorite, player);
    const savedQueue = f.saved("playbackQueue"); assert.equal(savedQueue.activeUrl, f.a);
    assert.equal(savedQueue.queue[0].title, beforeCurrent.title, "B list/queue updates cannot rewrite source A's persisted playback queue"); assert.equal(savedQueue.queue[0].favorite, player,
      "B list/queue updates cannot rewrite source A's persisted playback queue"); f.stable();
  }
  {
    const f = await preferenceFixture(createMusicViews);
    await f.mount(f.b, [f.track("B", { favorite: false })]);
    await f.click("favorite"); f.receipt(f.writes("favorite")[0], "favorite", true); await settle();
    assert.equal(f.s.current.favorite, false, "colliding source B true acknowledgement cannot update source A false current");
    assert.equal(f.saved("lastTrack").track.favorite, false, "source B cannot update source A restore record"); f.stable();
  }
  const f = await preferenceFixture(createMusicViews);
  await f.click("favorite", null, "more"); const rejected = f.writes("favorite")[0];
  f.receipt(rejected, "favorite", true, {}, true); await settle();
  await f.click("favorite"); assert.equal(f.writes("favorite").length, 2, "More failure leaves the next real UI action usable");
  f.receipt(f.writes("favorite")[1], "favorite", true); await settle(); f.stable();
}

async function assertPreferenceLane(createMusicViews, failure = false, latestFailure = false) {
  const f = await preferenceFixture(createMusicViews);
  await f.click("rating", 1); const first = f.writes("rating")[0]; assert(first);
  await f.click("rating", 3); await f.click("rating", 5);
  assert.equal(f.writes("rating").length, 1, "one physical preference lane has only one write in flight");
  f.receipt(first, "rating", 1, {}, failure); await settle();
  assert.equal(f.s.current.rating, 0, "old success/failure is suppressed when a newer desired value exists");
  const second = f.writes("rating")[1]; assert(second, "the newest queued desired value starts after the prior write settles");
  assert.equal(JSON.parse(second.options.body).rating, 5, "intermediate pending values are coalesced");
  f.receipt(second, "rating", 5, {}, latestFailure); await settle();
  const confirmed = latestFailure ? 1 : 5;
  assert.equal(f.s.current.rating, confirmed, "latest failure restores the interim server-confirmed value that was not painted while pending");
  assert.equal(f.s.data.tracks[0].rating, confirmed); assert.equal(f.saved("lastTrack").track.rating, confirmed);
  await f.click("rating", 3); const failed = f.writes("rating")[2]; assert(failed);
  f.receipt(failed, "rating", 3, {}, true); await settle();
  assert.equal(f.s.current.rating, confirmed, "a failed new value retains the last confirmed value"); f.stable();
}

async function assertPreferenceFavoriteIntent(createMusicViews) {
  const f = await preferenceFixture(createMusicViews);
  await f.click("favorite"); const first = f.writes("favorite")[0]; assert.equal(JSON.parse(first.options.body).favorite, true);
  await f.click("favorite"); await f.click("favorite"); await f.click("favorite");
  assert.equal(f.writes("favorite").length, 1, "favorite repeated clicks do not open parallel physical writes");
  f.receipt(first, "favorite", true); await settle();
  const last = f.writes("favorite")[1]; assert(last); assert.equal(JSON.parse(last.options.body).favorite, false, "favorite flips the latest desired value, including pending clicks");
  assert.equal(f.s.current.favorite, false, "superseded favorite acknowledgement is not painted");
  f.receipt(last, "favorite", false); await settle(); assert.equal(f.s.current.favorite, false); assert.equal(f.writes("favorite").length, 2); f.stable();
}

async function assertPreferenceIndependentFields(createMusicViews) {
  for (const order of ["favorite first", "rating first"]) {
    const f = await preferenceFixture(createMusicViews), current = copy(f.s.current);
    await f.click("favorite"); await f.click("rating", 5);
    const favorite = f.writes("favorite")[0], rating = f.writes("rating")[0]; assert(favorite && rating, "different fields may each own a physical lane");
    const respond = async field => { f.receipt(field === "favorite" ? favorite : rating, field, field === "favorite" ? true : 5,
      field === "favorite" ? { rating: 0 } : { favorite: false }); await settle(); };
    await respond(order.startsWith("favorite") ? "favorite" : "rating"); await respond(order.startsWith("favorite") ? "rating" : "favorite");
    assert.deepEqual(copy(f.s.current), { ...current, favorite: true, rating: 5 }, "full DTO snapshots cannot overwrite another preference field or track metadata");
    assert.deepEqual(copy(f.s.data.tracks[0]), { ...current, favorite: true, rating: 5 });
    const fifthStar = f.document.querySelectorAll(".music-mobile-rating button")[4]; assert(fifthStar);
    userClick(fifthStar); await settle();
    const clear = f.writes("rating")[1]; assert(clear); assert.equal(JSON.parse(clear.options.body).rating, 0,
      "clicking confirmed fifth star again clears rating without a fixture-forced render or stale listener value");
    f.receipt(clear, "rating", 0); await settle(); assert.equal(f.s.current.rating, 0); f.stable();
  }
  for (const invalid of ["id", "field"]) {
    const f = await preferenceFixture(createMusicViews), before = copy(f.s.current);
    await f.click("rating", 5); const rejected = f.writes("rating")[0];
    rejected.resolve({ track: invalid === "id" ? { ...f.track("invalid"), id: "wrong-id", rating: 5 } : { id: before.id, title: "missing preference field" } }); await settle();
    assert.deepEqual(copy(f.s.current), before, "invalid acknowledgement ID or missing field cannot pollute the current track");
    await f.click("rating", 5); const retry = f.writes("rating")[1]; assert(retry, "invalid acknowledgement releases the lane for a real retry");
    f.receipt(retry, "rating", 5); await settle(); assert.equal(f.s.current.rating, 5); f.stable();
  }
}

async function assertPreferencePersistence(createMusicViews) {
  for (const mismatch of ["source", "id"]) {
    const f = await preferenceFixture(createMusicViews);
    await f.click("favorite"); const request = f.writes("favorite")[0];
    const unrelated = f.track("unrelated persisted owner", { id: mismatch === "id" ? "unrelated-id" : f.s.current.id });
    const last = { activeUrl: mismatch === "source" ? f.b : f.a, trackId: unrelated.id, track: unrelated };
    const queue = { activeUrl: last.activeUrl, currentTrackId: unrelated.id, queue: [unrelated] };
    f.window.localStorage.setItem("fanhao.android.music.lastTrack", JSON.stringify(last));
    f.window.localStorage.setItem("fanhao.android.music.playbackQueue", JSON.stringify(queue));
    f.receipt(request, "favorite", true); await settle();
    assert.deepEqual(f.saved("lastTrack"), last, "a preference response cannot replace an unrelated persisted source/id record");
    assert.deepEqual(f.saved("playbackQueue"), queue, "an unrelated persisted queue is preserved"); f.stable();
  }
}

async function assertPreferenceSourceReturn(createMusicViews, newerIntent = false) {
  const f = await preferenceFixture(createMusicViews);
  await f.click("rating", 1); const old = f.writes("rating")[0];
  await f.mount(f.b, [f.track("B")]); await f.mount(f.a, [f.track("returned A", { positionMs: 62000 })]);
  const before = copy(f.s.data.tracks[0]);
  if (newerIntent) await f.click("rating", 5);
  assert.equal(f.writes("rating").length, 1, "source round trips do not split one physical owner lane");
  f.receipt(old, "rating", 1); await settle();
  assert.deepEqual(copy(f.s.data.tracks[0]), { ...before, rating: newerIntent ? 0 : 1 }, "returning to the real owner preserves metadata and applies only an unsuperseded field");
  if (newerIntent) {
    const latest = f.writes("rating")[1]; assert(latest); assert.equal(JSON.parse(latest.options.body).rating, 5);
    f.receipt(latest, "rating", 5); await settle(); assert.equal(f.s.data.tracks[0].rating, 5);
  }
  f.stable();
}

async function assertPreferenceAccountRevision(createMusicViews) {
  for (const { roundTrip, pending } of [{ roundTrip: false, pending: true }, { roundTrip: true, pending: false }, { roundTrip: true, pending: true }]) {
    const f = await preferenceFixture(createMusicViews), owner = captureAccountOwner(f.a).owner;
    await f.click("favorite"); const old = f.writes("favorite")[0];
    if (pending) await f.click("favorite");
    setAccountOwner(f.a, "account:preference-replacement");
    if (roundTrip) setAccountOwner(f.a, owner);
    await f.mount(f.a, [f.track("new account")]);
    if (roundTrip) await f.click("favorite");
    assert.equal(f.writes("favorite").length, 1, "an account revision does not open a second physical lane for the same logical owner");
    const before = copy(f.s.data.tracks[0]), beforeCurrent = copy(f.s.current), beforeLast = f.saved("lastTrack"), beforeQueue = f.saved("playbackQueue");
    f.receipt(old, "favorite", true); await settle();
    assert.deepEqual(copy(f.s.data.tracks[0]), before, "old account revision cannot apply an acknowledgement even after account round trip");
    assert.deepEqual(copy(f.s.current), beforeCurrent); assert.deepEqual(f.saved("lastTrack"), beforeLast); assert.deepEqual(f.saved("playbackQueue"), beforeQueue);
    const writes = f.writes("favorite"); assert.equal(writes.length, roundTrip ? 2 : 1, "old queued credentials are never sent after account change");
    if (roundTrip) {
      const fresh = writes[1]; assert.equal(JSON.parse(fresh.options.body).favorite, true, "only the fresh revision's latest intent is sent");
      f.receipt(fresh, "favorite", true); await settle(); assert.equal(f.s.data.tracks[0].favorite, true);
    }
    f.stable();
  }
}

async function assertPreferenceLateRead(createMusicViews) {
  for (const field of ["favorite", "rating"]) {
    const f = await preferenceFixture(createMusicViews), value = field === "favorite" ? true : 5;
    const route = f.raw.api.musicViews.renderMusicList({ mode: "library", dashboard: "0" }); await settle();
    const read = f.reads().find(request => new URL(request.url).pathname === "/api/music/tracks"); assert(read);
    await f.click(field, value); const write = f.writes(field)[0]; assert(write);
    f.receipt(write, field, value); await settle();
    const stale = f.track("late GET metadata", { favorite: field === "rating", rating: field === "favorite" ? 4 : 0, positionMs: 62000 });
    read.resolve(f.catalogue([stale])); await f.completeReads([stale]); await route; await settle();
    assert.deepEqual(copy(f.s.data.tracks[0]), { ...stale, [field]: value }, "late GET keeps fresh metadata/other fields while overlaying the acknowledged preference field"); f.stable();
  }
  const f = await preferenceFixture(createMusicViews);
  await f.click("rating", 1); const first = f.writes("rating")[0]; await f.click("rating", 5);
  f.receipt(first, "rating", 1); await settle(); const latest = f.writes("rating")[1]; assert(latest);
  assert.equal(f.s.current.rating, 0, "interim acknowledgement remains unpublished while the latest write is pending");
  const route = f.raw.api.musicViews.renderMusicList({ mode: "library", dashboard: "0" }); await settle();
  await f.completeReads([f.track("pending GET", { rating: 1 })]); await route; await settle();
  assert.equal(f.s.current.rating, 0); assert.equal(f.s.data.tracks[0].rating, 0); assert.equal(f.s.queue[0].rating, 0,
    "pending GET cannot publish the interim acknowledgement through the list or queue");
  f.receipt(latest, "rating", 5, {}, true); await settle();
  assert.equal(f.s.current.rating, 1); assert.equal(f.s.data.tracks[0].rating, 1); assert.equal(f.s.queue[0].rating, 1,
    "latest failure publishes the actual interim confirmed value after the entire preference chain settles");
  assert.equal(f.saved("lastTrack").track.rating, 1); assert.equal(f.saved("playbackQueue").queue[0].rating, 1); f.stable();
}

async function playbackSettingsFixture(createMusicViews) {
  const f = await preferenceFixture(createMusicViews);
  const trigger = () => f.document.querySelector(".music-mobile-full-settings");
  const sheet = () => f.document.querySelector(".music-mobile-playback-settings-sheet");
  const controls = () => {
    const panel = sheet(); assert(panel, "the real playback settings panel is mounted");
    const close = panel.querySelectorAll("button").find(button => button.getAttribute("aria-label") === "关闭播放设置");
    assert(close); assert.equal(close.textContent, "完成", "the panel has a visible completion action");
    return { panel, close, head: panel.querySelector(".music-mobile-queue-head"), handle: panel.querySelector(".music-mobile-sheet-handle"),
      backdrop: f.document.querySelector(".music-mobile-sheet-backdrop"),
      rating: panel.querySelectorAll(".music-mobile-rating button")[4],
      shuffle: panel.querySelector(".music-mobile-playback-shuffle"),
      speed: panel.querySelector(".music-mobile-speed select"), volume: panel.querySelector("input") };
  };
  const open = () => {
    assert(trigger()?.isConnected, "the real full-player settings trigger is visible");
    userClick(trigger()); f.flushFrames();
    const panel = controls();
    assert.equal(panel.panel.getAttribute("role"), "dialog");
    assert(panel.panel.textContent.includes(f.s.current.title), "settings identifies the current song");
    assert.equal(f.document.activeElement, panel.close, "opening settings focuses its visible completion action");
    assert.equal(trigger().getAttribute("aria-expanded"), "true");
    return panel;
  };
  userClick(f.document.querySelector(".music-mobile-mini-open"));
  assert(f.s.fullscreen); assert(trigger(), "mini-player opens a full player with a real settings entry");
  assert.equal(trigger().textContent, "播放设置");
  assert.equal(trigger().getAttribute("aria-haspopup"), "dialog");
  const switchTrack = async () => {
    const next = f.track("settings next", { id: "settings-next-id" });
    await f.mount(f.a, [f.track("A"), next], { params: { trackId: next.id } });
    assert.equal(f.s.current.id, next.id, "the actual route and detail GET select the next song");
    return next;
  };
  const persistence = () => Object.fromEntries(["volume", "playbackSpeed", "shuffle", "lastTrack", "playbackQueue"]
    .map(key => [key, f.window.localStorage.getItem(`fanhao.android.music.${key}`)]));
  return { ...f, trigger, sheet, controls, open, switchTrack, persistence };
}

async function assertPlaybackSettingsClose(createMusicViews) {
  for (const method of ["button", "native Back", "backdrop", "Escape", "swipe"]) {
    const f = await playbackSettingsFixture(createMusicViews), panel = f.open();
    const current = f.s.current, queue = f.s.queue, writes = f.writes().length, navigation = f.calls.length;
    if (method === "button") userClick(panel.close);
    if (method === "native Back") assert.equal(f.back(), true);
    if (method === "backdrop") userClick(panel.backdrop);
    if (method === "Escape") assert(fire(panel.close, "keydown", { key: "Escape" }).defaultPrevented);
    if (method === "swipe") {
      fire(panel.head, "touchstart", { touches: [{ clientX: 15, clientY: 20 }] });
      fire(panel.head, "touchend", { changedTouches: [{ clientX: 15, clientY: 100 }] });
    }
    f.flushFrames();
    assert.equal(f.sheet(), null, `${method} closes the playback settings panel`);
    assert.equal(f.document.querySelector(".music-mobile-sheet-backdrop"), null);
    assert.equal(f.s.fullscreen, true, "closing settings preserves the full player");
    assert.equal(f.document.activeElement, f.trigger(), "closing playback settings restores its current real entry");
    assert.equal(f.trigger().getAttribute("aria-expanded"), "false");
    assert.equal(f.s.current, current); assert.equal(f.s.queue, queue); assert.equal(f.writes().length, writes);
    assert.equal(f.calls.length, navigation); f.stable();
    assert.equal(f.back(), true); assert.equal(f.s.fullscreen, false, "the next native Back closes the full player");
    assert.equal(f.calls.length, navigation); f.stable();
  }
}

async function assertPlaybackSettingsKeyboard(createMusicViews) {
  const f = await playbackSettingsFixture(createMusicViews), { panel, close } = f.open();
  const available = panel.querySelectorAll("button,input,select").filter(node => !node.disabled && !node.hidden);
  assert(available.length >= 8); assert.equal(available[0], close);
  const last = available.at(-1); last.focus();
  assert(fire(last, "keydown", { key: "Tab" }).defaultPrevented, "forward Tab wraps at the final panel control");
  assert.equal(f.document.activeElement, close);
  assert(fire(close, "keydown", { key: "Tab", shiftKey: true }).defaultPrevented, "reverse Tab wraps at the first panel control");
  assert.equal(f.document.activeElement, last);
  const controls = f.controls(), shuffle = f.s.shuffle, speed = f.s.playbackSpeed;
  userClick(controls.shuffle); assert.equal(f.s.shuffle, !shuffle); userClick(controls.shuffle); assert.equal(f.s.shuffle, shuffle);
  controls.speed.value = "2"; fire(controls.speed, "change"); assert.equal(f.s.playbackSpeed, 2); assert.equal(f.audio.playbackRate, 2);
  controls.speed.value = String(speed); fire(controls.speed, "change");
  controls.volume.value = "42"; fire(controls.volume, "input"); assert.equal(f.s.volume, 0.42); assert.equal(f.audio.volume, 0.42);
  controls.volume.value = "63"; fire(controls.volume, "input");
  assert.equal(f.writes().length, 0, "local playback settings do not create server mutations"); f.stable();
}

async function assertPlaybackSettingsRating(createMusicViews) {
  for (const deactivate of [false, true]) {
    const f = await playbackSettingsFixture(createMusicViews), panel = f.open();
    userClick(panel.rating); await settle(); const request = f.writes("rating")[0]; assert(request);
    assert.equal(new URL(request.url).origin, f.a); assert.deepEqual(JSON.parse(request.options.body), { rating: 5 });
    userClick(panel.close); if (deactivate) f.raw.deactivate();
    const foreign = f.document.createElement("p");
    if (deactivate) { foreign.textContent = "unrelated route"; f.els.viewContent.replaceChildren(foreign); }
    assert.equal(request.signal.aborted, false, "a submitted rating outlives the settings panel");
    f.receipt(request, "rating", 5); await settle(); f.flushFrames();
    assert.equal(f.s.current.rating, 5); assert.equal(f.s.data.tracks[0].rating, 5);
    assert.equal(f.saved("lastTrack").track.rating, 5);
    if (deactivate) assert.equal(f.els.viewContent.children[0], foreign, "inactive rating completion cannot replace the current page");
    else {
      const reopened = f.open(); userClick(reopened.rating); await settle();
      const clear = f.writes("rating")[1]; assert(clear); assert.deepEqual(JSON.parse(clear.options.body), { rating: 0 });
      f.receipt(clear, "rating", 0); await settle(); assert.equal(f.s.current.rating, 0);
    }
    f.stable();
  }
}

async function assertPlaybackSettingsRetired(createMusicViews, transition = "close reopen") {
  const f = await playbackSettingsFixture(createMusicViews), old = f.open();
  if (transition === "close reopen") { userClick(old.close); f.flushFrames(); f.open(); }
  if (transition === "switch track") {
    await f.switchTrack(); f.flushFrames();
    assert(f.sheet(), "an open settings panel survives a real track change");
    assert(f.sheet().textContent.includes(f.s.current.title), "the new settings panel binds to the new current song");
  }
  if (transition === "deactivate") {
    f.raw.deactivate(); f.els.viewContent.replaceChildren(f.document.createElement("p"));
  }
  const state = copy(f.s), stored = f.persistence(), writes = f.writes().length, live = f.sheet();
  old.rating.click(); old.shuffle.click(); old.speed.value = "2"; fire(old.speed, "change");
  old.volume.value = "11"; fire(old.volume, "input"); old.close.click(); old.backdrop.click();
  fire(old.head, "touchstart", { touches: [{ clientX: 10, clientY: 10 }] });
  fire(old.head, "touchend", { changedTouches: [{ clientX: 10, clientY: 100 }] });
  fire(old.handle, "touchstart", { touches: [{ clientX: 10, clientY: 10 }] });
  fire(old.handle, "touchend", { changedTouches: [{ clientX: 10, clientY: 100 }] });
  await settle(); f.flushFrames();
  assert.deepEqual(copy(f.s), state, "retired settings controls cannot change current music state");
  assert.deepEqual(f.persistence(), stored, "retired settings controls cannot change persisted preferences");
  assert.equal(f.writes().length, writes, "retired rating callbacks cannot submit new HTTP writes");
  assert.equal(f.sheet(), live, "retired dismissal callbacks cannot close a replacement settings panel"); f.stable();
  if (transition === "switch track") {
    const current = f.s.current, rating = f.controls().rating; userClick(rating); await settle();
    const write = f.writes("rating").at(-1); assert(write.url.includes(`/tracks/${current.id}/rating`));
    write.resolve({ track: { ...current, rating: 5 } }); await settle(); assert.equal(current.rating, 5);
  }
}

async function assertPlaybackSettingsFocusRetired(createMusicViews, transition = "Tab") {
  const f = await playbackSettingsFixture(createMusicViews), panel = f.open();
  userClick(panel.close); assert(f.frames.size > 0, "settings close queues its real focus restoration");
  const expected = f.document.createElement("button"); expected.textContent = "later user destination"; f.document.body.append(expected);
  if (transition === "Tab") { fire(f.document.body, "keydown", { key: "Tab" }); expected.focus(); expected.blur(); }
  if (transition === "deactivate") f.raw.deactivate();
  if (transition === "route") await f.mount();
  if (transition === "source") f.setSource(f.b);
  if (transition === "account round trip") {
    const owner = captureAccountOwner(f.a).owner; setAccountOwner(f.a, "account:settings-focus-other"); setAccountOwner(f.a, owner);
  }
  if (transition === "target replaced") {
    const target = f.trigger(), replacement = f.document.createElement("button"); replacement.className = target.className;
    replacement.textContent = target.textContent; target.replaceWith(replacement);
  }
  f.document.activeElement = f.document.body; f.flushFrames();
  assert(f.document.activeElement === f.document.body, "retired playback settings close focus cannot steal a later user's focus"); f.stable();
}

async function assertPlaybackSettingsInvalidScope(createMusicViews) {
  for (const scope of ["source", "account"]) for (const dismissal of ["button", "native Back"]) {
    const f = await playbackSettingsFixture(createMusicViews), panel = f.open();
    if (scope === "source") f.setSource(f.b);
    else setAccountOwner(f.a, "account:settings-visible-replacement");
    assert(panel.panel.isConnected, "scope invalidation deliberately retains the visible current settings DOM");
    const before = copy(f.s), stored = f.persistence(), writes = f.writes().length;
    panel.rating.click(); panel.shuffle.click(); panel.speed.value = "2"; fire(panel.speed, "change");
    panel.volume.value = "11"; fire(panel.volume, "input"); await settle();
    assert.deepEqual(copy(f.s), before, "a still-visible settings panel cannot mutate after its scope becomes invalid");
    assert.deepEqual(f.persistence(), stored); assert.equal(f.writes().length, writes);
    if (dismissal === "button") userClick(panel.close); else assert.equal(f.back(), true, "Back can dismiss a mounted panel whose source/account is invalid");
    f.flushFrames();
    assert.equal(f.sheet(), null, "visible settings remains dismissible after source/account changes without a render");
    assert.equal(f.s.fullscreen, true); assert.equal(f.document.activeElement, f.document.body,
      "dismissing an invalid-scope panel does not restore focus under the replacement scope");
    assert.equal(f.writes().length, writes); f.stable();
  }
}

async function miniPlayerFixture(createMusicViews) {
  const f = await preferenceFixture(createMusicViews), next = f.track("mini next", { id: "mini-next-id" });
  await f.mount(f.a, [f.track("A"), next]);
  const controls = () => {
    const player = f.document.querySelector(".music-mobile-mini-player"); assert(player);
    return { player, opener: player.querySelector(".music-mobile-mini-open"),
      play: player.querySelector(".primary"),
      next: player.querySelectorAll("button").find(node => node.getAttribute("aria-label") === "下一首"),
      queue: player.querySelectorAll("button").find(node => node.getAttribute("aria-label") === "播放队列") };
  };
  const full = () => f.document.querySelector(".music-mobile-full-player");
  const dismiss = () => full()?.querySelector(".music-mobile-full-dismiss");
  const open = (kind = "opener", flush = true) => {
    const before = controls(), origin = before[kind]; assert(origin, `the real mini ${kind} control exists`);
    assert.equal(before.opener.tagName, "BUTTON", "the mini opener has native button semantics");
    assert.equal(before.opener.type, "button"); assert.equal(before.opener.getAttribute("aria-haspopup"), "dialog");
    userClick(origin); if (flush) f.flushFrames();
    assert(f.s.fullscreen && full(), "the live mini control opens the actual full player");
    if (flush) assert(f.document.activeElement === (kind === "queue"
      ? full().querySelector(".music-mobile-queue-sheet .music-mobile-sheet-close") : dismiss()),
    "opening the full player focuses the close action of its topmost surface");
    return { origin, full: full(), dismiss: dismiss() };
  };
  const switchTrack = async () => f.mount(f.a, [f.track("A"), next], { params: { trackId: next.id } });
  const snapshot = () => ({ state: copy(f.s), requests: f.requests.length, calls: f.calls.length,
    last: f.saved("lastTrack"), queue: f.saved("playbackQueue") });
  return { ...f, nextTrack: next, controls, full, dismiss, open, switchTrack, snapshot };
}

function miniTouch(node, type, touches = [], changedTouches = touches) {
  return fire(node, type, { touches, changedTouches });
}

const miniPoint = (identifier, clientX = 100, clientY = 100) => ({ identifier, clientX, clientY });

async function assertMiniPlayerOpenBack(createMusicViews) {
  for (const entry of ["opener", "queue", "settings child"]) {
    const f = await miniPlayerFixture(createMusicViews), current = f.s.current, queue = f.s.queue;
    const kind = entry === "queue" ? "queue" : "opener", before = f.snapshot(); f.open(kind);
    if (entry === "queue") {
      assert(f.s.queueOpen); assert.equal(f.back(), true); f.flushFrames();
      assert.equal(f.s.queueOpen, false); assert.equal(f.s.fullscreen, true, "Back closes queue before the full player");
      assert(f.document.activeElement === f.full().querySelector(".music-mobile-full-queue"), "closing queue first restores its full-player trigger");
    }
    if (entry === "settings child") {
      userClick(f.document.querySelector(".music-mobile-full-settings")); f.flushFrames();
      assert(f.s.playbackSheetOpen); assert.equal(f.back(), true); f.flushFrames();
      assert.equal(f.s.playbackSheetOpen, false); assert.equal(f.s.fullscreen, true, "Back closes settings before the full player");
    }
    if (entry === "opener") userClick(f.dismiss()); else assert.equal(f.back(), true);
    f.flushFrames();
    assert.equal(f.s.fullscreen, false); assert.equal(f.full(), null);
    assert(f.document.activeElement === f.controls()[kind], "final player close returns focus to its actual mini entry");
    assert.equal(f.s.current, current); assert.equal(f.s.queue, queue); assert.equal(f.requests.length, before.requests);
    assert.equal(f.calls.length, before.calls); assert.deepEqual(f.saved("lastTrack"), before.last); f.stable();
  }
}

async function assertMiniPlayerRetired(createMusicViews, transition = "rerender") {
  const f = await miniPlayerFixture(createMusicViews), old = f.controls();
  miniTouch(old.opener, "touchstart", [miniPoint(1)]);
  if (transition === "rerender") f.audit.renderShell();
  if (transition === "switch track") await f.switchTrack();
  if (transition === "deactivate") {
    f.raw.deactivate(); assert(old.player.isConnected, "deactivation is tested before the host removes the old DOM");
  }
  const before = f.snapshot();
  old.opener.click(); old.player.click(); old.play.click(); old.next.click(); old.queue.click();
  miniTouch(old.opener, "touchend", [], [miniPoint(1, 100, 0)]);
  miniTouch(old.player, "touchstart", [miniPoint(2)]);
  miniTouch(old.player, "touchend", [], [miniPoint(2, 0, 100)]);
  await settle(); f.flushFrames();
  assert.deepEqual(f.snapshot(), before, "retired mini callbacks and gesture tails cannot change state navigation persistence or requests"); f.stable();
}

async function assertMiniPlayerGestures(createMusicViews) {
  for (const invalid of ["orphan end", "cancelled", "multi start", "multi join", "wrong identifier", "control origin"]) {
    const f = await miniPlayerFixture(createMusicViews), controls = f.controls(), node = invalid === "control origin" ? controls.next : controls.opener;
    const before = f.snapshot();
    if (invalid !== "orphan end") miniTouch(node, "touchstart", invalid === "multi start" ? [miniPoint(1), miniPoint(2)] : [miniPoint(1)]);
    if (invalid === "cancelled") miniTouch(node, "touchcancel", [], [miniPoint(1)]);
    if (invalid === "multi join") miniTouch(node, "touchstart", [miniPoint(1), miniPoint(2)]);
    miniTouch(node, "touchend", [], [invalid === "orphan end" ? miniPoint(1, 0, -100)
      : miniPoint(invalid === "wrong identifier" ? 2 : 1, 100, 0)]);
    await settle(); f.flushFrames();
    assert.deepEqual(f.snapshot(), before, "an invalid mini gesture cannot open the player or choose a track"); f.stable();
  }
  {
    const f = await miniPlayerFixture(createMusicViews), opener = f.controls().opener, before = f.requests.length;
    miniTouch(opener, "touchstart", [miniPoint(1)]); miniTouch(opener, "touchmove", [miniPoint(1, 100, 40)]);
    miniTouch(opener, "touchend", [], [miniPoint(1, 100, 0)]);
    f.flushFrames(); assert(f.s.fullscreen, "a valid upward swipe from the native opener opens the player");
    assert(f.document.activeElement === f.dismiss()); assert.equal(f.requests.length, before); f.stable();
  }
  {
    const f = await miniPlayerFixture(createMusicViews), opener = f.controls().opener, count = f.requests.length;
    miniTouch(opener, "touchstart", [miniPoint(1)]); miniTouch(opener, "touchmove", [miniPoint(1, 40, 100)]);
    miniTouch(opener, "touchend", [], [miniPoint(1, 0, 100)]); await settle();
    const detail = f.requests.slice(count).find(request => new URL(request.url).pathname === `/api/music/tracks/${f.nextTrack.id}`);
    assert(detail, "a valid horizontal swipe from the opener invokes the real adjacent-track GET");
    assert.equal(f.s.fullscreen, false); await f.completeReads([f.track("A"), f.nextTrack], f.nextTrack); await settle();
    assert.equal(f.s.current.id, f.nextTrack.id); f.stable();
  }
  {
    const f = await miniPlayerFixture(createMusicViews); f.s.repeat = "none"; f.audit.renderShell();
    const opener = f.controls().opener, before = f.snapshot();
    // At the queue's first item a right swipe is consumed without a rerender,
    // so its follow-up click tests suppression independently of detachment.
    miniTouch(opener, "touchstart", [miniPoint(1)]); miniTouch(opener, "touchend", [], [miniPoint(1, 190, 100)]);
    fire(opener, "click", { detail: 1 }); await settle(); f.flushFrames();
    assert.deepEqual(f.snapshot(), before, "a consumed swipe suppresses its synthetic click even while the opener stays mounted"); f.stable();
    fire(opener, "click", { detail: 0 }); f.flushFrames();
    assert(f.s.fullscreen, "a keyboard-like click remains independent of touch click suppression");
  }
}

async function assertMiniPlayerFocusRetired(createMusicViews, phase = "open", transition = "Tab") {
  const f = await miniPlayerFixture(createMusicViews);
  f.open("opener", phase === "close");
  if (phase === "close") userClick(f.dismiss());
  assert(f.frames.size > 0, "mini/full transition has a pending real focus commit");
  if (transition === "Tab") fire(f.document.body, "keydown", { key: "Tab" });
  if (transition === "deactivate") f.raw.deactivate();
  if (transition === "source") f.setSource(f.b);
  if (transition === "account round trip") {
    const owner = captureAccountOwner(f.a).owner; setAccountOwner(f.a, "account:mini-focus-other"); setAccountOwner(f.a, owner);
  }
  if (transition === "target replaced") {
    const target = phase === "open" ? f.dismiss() : f.controls().opener, replacement = f.document.createElement("button");
    replacement.className = target.className; target.replaceWith(replacement);
  }
  f.document.activeElement = f.document.body; f.flushFrames();
  assert(f.document.activeElement === f.document.body, "a retired mini/full focus commit cannot steal later focus"); f.stable();
}

function asyncControlFixture(createMusicViews, kind, options = {}) {
  const f = libraryControlFixture(createMusicViews, "sort", { routeNavigation: true, ...options });
  const search = kind !== "library sort";
  if (search) {
    Object.assign(f.s, { query: "same query", searchOpen: true, searchScope: "songs" });
    f.audit.renderShell();
  }
  const catalogue = { ...f.s.data, tracks: [f.track], total: 1, hasMore: false, query: search ? "same query" : "" };
  const initialQueue = f.s.queue;
  const targetSelector = kind === "library sort" ? ".music-mobile-focused-library-sort"
    : kind === "search sort" ? ".music-mobile-search-results-actions .music-mobile-sort" : ".music-mobile-search-filter-menu summary";
  const target = () => f.document.querySelector(targetSelector);
  const start = async ({ sort = "rating", filter = "已收藏" } = {}) => {
    const count = f.requests.length, routes = f.routes.length;
    const input = f.document.querySelector(".music-mobile-search-input");
    if (kind === "library sort") {
      userClick(target()); f.flushFrames();
      const label = { rating: "评分", title: "歌名", duration: "时长" }[sort];
      const choice = f.document.querySelectorAll(".music-mobile-library-sort-choice").find(button => button.querySelector("strong")?.textContent === label);
      userClick(choice);
    } else if (kind === "search sort") {
      const select = target(); fire(select, "pointerdown", { pointerId: 1 }); select.focus(); select.value = sort; fire(select, "change");
    } else {
      const summary = target(); userClick(summary);
      // The VM controls the native details disclosure default action only.
      summary.parentNode.open = true;
      const choice = f.document.querySelectorAll(".music-mobile-search-quick-filters button").find(button => button.textContent === filter);
      userClick(choice);
    }
    await settle();
    const primary = f.requests.slice(count).find(request => new URL(request.url).pathname === "/api/music/tracks");
    assert(primary, `${kind} reaches the actual controlled track transport`);
    const params = new URL(primary.url).searchParams;
    if (search) assert.equal(params.get("q"), "same query");
    if (kind.endsWith("sort")) assert.equal(params.get("sort"), sort);
    else if (filter === "已收藏") assert.equal(params.get("favorite"), "1");
    else if (filter === "有歌词") assert.equal(params.get("lyrics"), "1");
    return { primary, input, route: f.routes.length > routes ? f.routes.at(-1).pending : null };
  };
  const auxiliary = async (failure = false) => {
    for (const request of f.requests.filter(request => !request.settled && new URL(request.url).pathname !== "/api/music/tracks")) {
      const pathname = new URL(request.url).pathname;
      assert(["/api/music/playlists", "/api/music/smart-playlists", "/api/music/artists", "/api/music/albums"].includes(pathname), "only known synthetic auxiliary catalogue reads are completed");
      request.resolve(failure ? { error: "Synthetic auxiliary catalogue failure" }
        : pathname.endsWith("smart-playlists") ? { smartPlaylists: [] }
          : pathname.endsWith("playlists") ? { playlists: [] }
            : pathname.endsWith("artists") ? { artists: catalogue.artists, total: 1 }
              : { albums: catalogue.albums, total: 1 }, failure ? 503 : 200);
    }
    await settle();
  };
  const complete = async (action, failure = false) => {
    action.primary.resolve(failure ? { error: "Synthetic controlled catalogue failure" } : catalogue, failure ? 503 : 200);
    await settle();
  };
  const finish = async (action, auxiliaryFailure = false) => { await auxiliary(auxiliaryFailure); if (action.route) await action.route; await settle(); };
  const mediaUnchanged = () => {
    assert.equal(f.s.current, f.track); assert.equal(f.audit.getAudio(), f.audio);
    assert.equal(f.audio.src, "fixture:library-playing"); assert.equal(f.audio.currentTime, 37.5); assert.equal(f.track.positionMs, 37500);
    assert.equal(f.s.playing, true); assert.equal(f.audio.paused, false);
    if (search) assert.equal(f.s.queue, initialQueue, "search controls preserve the existing playback queue object");
  };
  const destination = () => { const button = f.document.createElement("button"); f.document.body.append(button); return button; };
  const interrupt = (interaction, node = destination()) => {
    if (interaction === "Tab") { fire(f.document.activeElement || f.document.body, "keydown", { key: "Tab" }); node.focus(); }
    if (interaction === "click") userClick(node);
    if (interaction === "input") { node.focus(); fire(node, "input"); }
    // Returning to body cannot resurrect an intent cancelled by real events.
    node.blur(); assert.equal(f.document.activeElement, f.document.body);
    return node;
  };
  return { ...f, kind, search, catalogue, target, start, auxiliary, complete, finish, mediaUnchanged, destination, interrupt };
}

async function assertAsyncControlResult(createMusicViews, kind, failure = false) {
  const f = asyncControlFixture(createMusicViews, kind), action = await f.start();
  const trace = label => { if (process.env.FANHAO_MUSIC_BACK_TRACE) console.log(JSON.stringify({ kind, failure, label, frames: f.frames.size,
    listeners: f.document.listeners.get("keydown")?.length, focus: f.document.activeElement?.tagName,
    pending: f.requests.filter(request => !request.settled).map(request => new URL(request.url).pathname) })); };
  trace("started");
  confirmAccountOwner(captureAccountOwner(f.host.getActiveUrl()));
  const confirmations = f.events.filter(event => event.type === "fanhaoAccountOwnerConfirmed").length;
  assert(confirmations > 0, "the real account-owner confirmation reaches this controlled window through the global bridge");
  await f.complete(action, failure); trace("primary"); await f.finish(action); trace("finished"); f.flushFrames(); trace("frame");
  assert(f.events.filter(event => event.type === "fanhaoAccountOwnerConfirmed").length > confirmations,
    "real fetchJson/observeAccountResponse adds same-owner confirmation events instead of bypassing that path");
  assert(f.document.activeElement === f.target(), `${kind} ${failure ? "failure" : "success"} restores its operation-owned new control`);
  assert.equal(f.s.loading, false);
  if (failure) assert.match(f.s.status, /Synthetic controlled catalogue failure/);
  if (kind === "search filter") assert.equal(f.document.querySelector(".music-mobile-search-input"), action.input, "query filter keeps the mounted search input");
  if (kind === "search sort") assert.equal(f.document.querySelector(".music-mobile-search-input").value, "same query", "native sort can rebuild an available input with the same query");
  f.mediaUnchanged();
  const destination = f.destination(); fire(f.document.activeElement, "keydown", { key: "Tab" }); destination.focus();
  const side = f.audit.loadPlaylists(); await settle(); await f.auxiliary(); await side; f.flushFrames();
  assert(f.document.activeElement === destination, "an independent later catalogue response cannot repeat a consumed focus intent");
  f.mediaUnchanged();
}

async function assertAsyncControlInterrupted(createMusicViews, kind, interaction, stage) {
  const f = asyncControlFixture(createMusicViews, kind), action = await f.start();
  if (stage === "queued frame") { await f.complete(action); await f.finish(action); }
  const input = interaction === "input" ? f.document.createElement("input") : null;
  if (input) f.document.body.append(input);
  f.interrupt(interaction, input || undefined);
  if (stage === "pending") { await f.complete(action); await f.finish(action); }
  f.flushFrames();
  assert(f.document.activeElement === f.document.body, `${kind} must not revive focus after ${interaction} and return to body (${stage})`);
  f.mediaUnchanged();
}

async function assertAsyncControlRetired(createMusicViews, kind, transition, failure) {
  const f = asyncControlFixture(createMusicViews, kind), sourceUrl = f.host.getActiveUrl(), previousOwner = captureAccountOwner(sourceUrl).owner;
  if (transition === "account round trip") setAccountOwner(sourceUrl, "account:asyncFocusA");
  try {
    const action = await f.start(), following = [];
    const params = { mode: "library", dashboard: "0", ...(f.search ? { query: "same query", searchScope: "songs" } : {}) };
    if (transition === "deactivate") f.raw.deactivate();
    if (transition === "new generation") following.push(f.raw.api.musicViews.renderMusicList(params));
    if (transition === "source") f.setSource();
    if (transition === "source round trip") {
      f.setSource(); following.push(f.raw.api.musicViews.renderMusicList(params));
      f.setSource(sourceUrl); following.push(f.raw.api.musicViews.renderMusicList(params));
    }
    if (transition === "account round trip") {
      setAccountOwner(sourceUrl, "account:asyncFocusB"); setAccountOwner(sourceUrl, "account:asyncFocusA");
    }
    const destination = f.destination();
    // Isolate operation ownership from the separate user-event cancellation
    // tests: a destination handoff itself must not cancel this intent first.
    f.document.activeElement = destination;
    await f.complete(action, failure);
    await settle();
    for (const request of f.requests.filter(request => !request.settled && new URL(request.url).pathname === "/api/music/tracks")) request.resolve(f.catalogue);
    await settle(); await f.finish(action); await f.auxiliary(); await Promise.all(following); f.flushFrames();
    assert(f.document.activeElement === destination, `${kind} old ${failure ? "failure" : "success"} cannot focus after ${transition}`);
    assert(f.requests.every(request => !request.options.method || request.options.method === "GET"));
    f.mediaUnchanged();
  } finally {
    if (transition === "account round trip") setAccountOwner(sourceUrl, previousOwner, { force: true });
  }
}

async function assertAsyncControlSequence(createMusicViews, kind, ordering, oldFailure) {
  const f = asyncControlFixture(createMusicViews, kind), first = await f.start();
  const second = await f.start({ sort: "title", filter: "有歌词" });
  assert(first.primary.signal.aborted || first.route, "the newer actual request replaces or retires the earlier operation");
  if (ordering === "old finally before new") {
    await f.complete(first, oldFailure); await f.finish(first); f.flushFrames();
    await f.complete(second); await f.finish(second); f.flushFrames();
    assert(f.document.activeElement === f.target(), "old finally cannot clear the newer operation's pending focus intent");
  } else {
    await f.complete(second); await f.finish(second); f.flushFrames();
    assert(f.document.activeElement === f.target(), "newer same-query operation restores its own target first");
    const state = copy(f.s), destination = f.destination(); destination.focus();
    await f.complete(first, oldFailure); await f.finish(first); f.flushFrames();
    assert(f.document.activeElement === destination, "late old success/failure cannot refocus over the newer operation");
    assert.deepEqual(copy(f.s), state, "late old completion cannot repaint the newer results or selection");
  }
  if (f.search) assert.equal(f.s.query, "same query");
  f.mediaUnchanged();
}

async function assertRetiredLibraryFocus(createMusicViews, kind, transition, neutralFocus = false) {
  const f = libraryControlFixture(createMusicViews, kind);
  const sourceUrl = f.host.getActiveUrl(), previousOwner = captureAccountOwner(sourceUrl).owner;
  if (transition === "account round trip") setAccountOwner(sourceUrl, "account:focusA");
  try {
    f.open(); assert.equal(f.back(), true);
    const queuedTrigger = f.document.querySelector(f.selector);
    assert(queuedTrigger?.isConnected); assert(f.frames.size > 0, "close queues its actual deferred focus callback");
    let pendingRoute = null;
    if (transition === "deactivate") f.raw.deactivate();
    if (transition === "source") f.setSource();
    if (transition === "account round trip") {
      setAccountOwner(sourceUrl, "account:focusB"); setAccountOwner(sourceUrl, "account:focusA");
    }
    if (transition === "trigger replaced") {
      f.audit.renderShell(); assert.equal(queuedTrigger.isConnected, false, "replacement retires the exact captured trigger");
      assert(f.document.querySelector(f.selector)?.isConnected, "the same selector exists on a different live control");
    }
    if (transition === "route generation") {
      pendingRoute = f.raw.api.musicViews.renderMusicList({ mode: "library", dashboard: "0" });
      // Model a retained control during same-route DOM reuse so generation is
      // checked independently of the captured-node connectivity guard.
      f.els.viewContent.append(queuedTrigger); assert.equal(queuedTrigger.isConnected, true);
    }
    const destination = neutralFocus ? f.document.body : f.document.createElement("button");
    if (!neutralFocus) f.document.body.append(destination);
    f.document.activeElement = destination;
    f.flushFrames();
    assert(f.document.activeElement === destination, `${kind} deferred close focus must not steal focus after ${transition}`);
    if (pendingRoute) {
      await settle();
      for (const request of f.requests) {
        const pathname = new URL(request.url).pathname;
        request.resolve(pathname === "/api/music/playlists" ? { playlists: [] }
          : pathname === "/api/music/smart-playlists" ? { smartPlaylists: [] }
            : { tracks: [f.track], total: 1, hasMore: false });
      }
      await pendingRoute; await settle();
      assert(f.requests.every(request => !request.options.method || request.options.method === "GET"), "route-generation check only completes controlled catalogue reads");
    } else {
      f.playbackUnchanged(); assert.equal(f.requests.length, 0);
    }
    assert.equal(f.calls.length, 0);
  } finally {
    if (transition === "account round trip") setAccountOwner(sourceUrl, previousOwner, { force: true });
  }
}

async function assertRetiredTrackActions(createMusicViews, retire) {
  const f = trackActionFixture(createMusicViews);
  if (retire === "closed") assert.equal(f.back(), true);
  if (retire === "reopened") { assert.equal(f.back(), true); f.audit.openTrackActions(f.candidate.id); }
  if (retire === "other track") f.audit.openTrackActions(f.other.id);
  if (retire === "deactivated") f.raw.deactivate();
  if (retire === "changed selection before paint") f.s.trackActionId = f.other.id;
  const snapshot = copy(f.s), navigation = f.calls.length;
  for (const button of f.actions) button.click();
  f.done.click(); f.backdrop.click();
  await settle();
  assert.deepEqual(copy(f.s), snapshot, `retired ${retire} track controls cannot queue, play, close another sheet or mutate state`);
  assert.equal(f.requests.length, 0, "retired track actions cannot begin playback/favorite/playlist HTTP");
  assert.equal(f.calls.length, navigation, "retired track actions cannot change catalogue navigation");
}

async function runCase(name, callback) {
  selectedCase = name;
  if (process.env.FANHAO_MUSIC_BACK_TRACE) console.log(`RUN ${name}`);
  await callback(); cases++;
}

try {
  const createMusicViews = await importFactory();
  await runCase("blank search through module/registry/app", () => assertSearchBack(createMusicViews));
  await runCase("entered query and restored query-only search", () => {
    for (const searchOpen of [true, false]) {
      const f = fixture(createMusicViews), s = f.audit.state;
      Object.assign(s, { searchOpen, query: "synthetic song" }); f.audit.renderShell();
      assert(f.document.querySelector(".music-mobile-search-surface"));
      assert.equal(f.back(), true); assert.equal(s.searchOpen, false); assert.equal(s.query, "");
      assert.equal(f.navigate().length, 1); assert.equal(f.back(), false);
    }
  });
  await runCase("track actions then queue then full player then search then root", () => assertLayeredBack(createMusicViews));
  await runCase("catalogue source/artist/album return context", async () => {
    const sources = [
      { mode: "library", dashboard: true },
      { mode: "library", dashboard: false, favorite: true },
      { mode: "library", dashboard: false, artistId: "fixture-artist", genre: "Fixture genre", language: "Fixture language" },
      { mode: "library", dashboard: false, artistId: "fixture-artist", albumId: "fixture-album" },
      { mode: "artists", dashboard: false, language: "Fixture language" },
      { mode: "albums", dashboard: false, genre: "Fixture genre" }
    ];
    for (const source of sources) {
      const f = fixture(createMusicViews), s = f.audit.state;
      Object.assign(s, source); f.audit.openMusicSearch();
      f.audit.commitMusicSearch("synthetic query"); await settle();
      assert.equal(f.requests.length, 1, "actual search reached only the controlled transport");
      assert.equal(f.back(), true); assert.equal(s.searchReturn, null); assert.equal(s.query, "");
      const [, params, navigation] = f.navigate().at(-1);
      assert.equal(params.mode, source.mode);
      assert.equal(params.dashboard, source.dashboard ? undefined : "0");
      assert.equal(params.favorite, source.favorite ? "1" : undefined);
      for (const key of ["artistId", "albumId", "genre", "language"]) assert.equal(params[key], source[key]);
      assert.equal(params.query, undefined); assert.equal(params.searchScope, undefined);
      assert.equal(navigation.skipHistory, true); assert.equal(navigation.replaceHistory, true);
      assert.equal(f.requests[0].signal.aborted, true);
      f.requests[0].resolve({ tracks: [], artists: [], albums: [], total: 999 }); await settle();
      assert.equal(s.query, ""); assert.equal(s.searchOpen, false);
    }
  });
  await runCase("pending live-search and suggestion timers cancel on Back", async () => {
    const f = fixture(createMusicViews); f.audit.openMusicSearch(); f.input("pending query");
    assert([...f.clocks.values()].some(timer => timer.delay === 90));
    assert([...f.clocks.values()].some(timer => timer.delay === 280));
    assert.equal(f.back(), true);
    assert.equal([...f.clocks.values()].some(timer => [90, 280].includes(timer.delay)), false);
    f.elapse(1000); await settle();
    assert.equal(f.requests.length, 0, "retired search timers cannot start HTTP or reopen search");
    assert.equal(f.audit.state.searchOpen, false); assert.equal(f.audit.state.query, "");
  });
  await runCase("active suggestion and mounted result requests abort; late replies ignored", async () => {
    const f = fixture(createMusicViews), s = f.audit.state;
    f.audit.openMusicSearch(); f.input("needle"); f.elapse(90); await settle();
    assert.equal(f.requests.length, 1); assert(f.requests[0].url.includes("/api/music/suggest?"));
    const mounted = f.audit.refreshMountedSearchResults("needle"); await settle();
    assert.equal(f.requests.length, 2, "actual mounted search is concurrently in flight");
    assert.equal(f.back(), true);
    assert(f.requests.every(request => request.signal.aborted), "both actual external request signals abort");
    const stateAfterBack = copy({ data: s.data, searchSuggestions: s.searchSuggestions, searchSuggestionLoading: s.searchSuggestionLoading,
      searchSuggestionQuery: s.searchSuggestionQuery, status: s.status, query: s.query, searchOpen: s.searchOpen });
    const shellAfterBack = f.els.viewContent.children[0];
    for (const request of f.requests) request.resolve({ tracks: [{ id: "retired-reply", title: "Retired" }], total: 999 });
    await mounted; await settle(); f.elapse(1000); await settle();
    assert.deepEqual(copy({ data: s.data, searchSuggestions: s.searchSuggestions, searchSuggestionLoading: s.searchSuggestionLoading,
      searchSuggestionQuery: s.searchSuggestionQuery, status: s.status, query: s.query, searchOpen: s.searchOpen }), stateAfterBack);
    assert.equal(f.els.viewContent.children[0], shellAfterBack, "late completions cannot repaint the returned catalogue");
    assert.equal(f.requests.length, 2, "cancelled live-search timer cannot start another request");
  });
  await runCase("player chevron keeps existing closeFullscreen semantics", () => {
    const f = fixture(createMusicViews), s = f.audit.state;
    f.audit.openMusicSearch(); s.fullscreen = true; f.audit.renderShell();
    const chevron = f.document.querySelector(".music-mobile-full-dismiss"); assert(chevron);
    chevron.click();
    assert.equal(s.fullscreen, false); assert.equal(s.searchOpen, true); assert.equal(f.navigate().length, 0);
    assert.equal(f.raw.api.musicViews.closeFullscreen(), false, "ordinary player close leaves an underlying search open");
    assert.equal(s.searchOpen, true);
    f.document.querySelector(".music-mobile-search-back").click();
    assert.equal(s.searchOpen, false); assert.equal(f.navigate().length, 1, "explicit search back still works");
  });
  await runCase("normal music root and other route history behavior", () => {
    const root = fixture(createMusicViews); assert.equal(root.back(), false); assert.equal(root.calls.length, 0);
    for (const stack of [true, false]) {
      const f = fixture(createMusicViews, { view: "unrelated-detail", stack });
      f.audit.openMusicSearch();
      assert.equal(f.registry.handleBack("unrelated-detail", {}), false);
      assert.equal(f.back(), true); assert.equal(f.audit.state.searchOpen, true, "inactive music route cannot steal Back");
      assert.deepEqual(f.calls, [stack ? "stack" : "history"]);
    }
  });
  await runCase("retired track actions after close/reopen/switch/deactivate", async () => {
    for (const retire of ["closed", "reopened", "other track", "deactivated", "changed selection before paint"]) {
      await assertRetiredTrackActions(createMusicViews, retire);
    }
  });
  await runCase("current track queue action works once and keeps background selection", () => {
    const f = trackActionFixture(createMusicViews), action = f.button("加入队列");
    action.click();
    assert.deepEqual(f.s.queue.map(track => track.id), [f.current.id, f.candidate.id]);
    assert.equal(f.s.current, f.current); assert.equal(f.s.playing, true); assert.equal(f.s.trackActionId, "");
    assert.equal(f.document.querySelector(".music-mobile-track-actions-sheet"), null);
    const snapshot = copy(f.s); action.click();
    assert.deepEqual(copy(f.s), snapshot, "accepted action retires its old button");
    assert.equal(f.requests.length, 0);
  });
  await runCase("current track sheet done and backdrop still dismiss", () => {
    for (const control of ["done", "backdrop"]) {
      const f = trackActionFixture(createMusicViews);
      f[control].click();
      assert.equal(f.s.trackActionId, "");
      assert.equal(f.document.querySelector(".music-mobile-track-actions-sheet"), null);
      assert.deepEqual(f.s.queue.map(track => track.id), [f.current.id]);
      assert.equal(f.s.current, f.current); assert.equal(f.s.playing, true);
    }
  });
  await runCase("visible current sheet works across metadata replacement and background track change", () => {
    for (const playingSelectedTrack of [true, false]) {
      const f = trackActionFixture(createMusicViews);
      const refreshed = { ...f.candidate, title: "Equivalent refreshed metadata" };
      f.s.data.tracks[0] = refreshed;
      f.s.current = playingSelectedTrack ? refreshed : { ...f.other };
      const current = f.s.current;
      assert.equal(f.sheet.isConnected, true, "the visible sheet still owns the same selected track ID");
      f.button("加入队列").click();
      assert.deepEqual(f.s.queue.map(track => track.id), [f.current.id, f.candidate.id]);
      assert.equal(f.s.current, current); assert.equal(f.s.playing, true);
      assert.equal(f.s.trackActionId, ""); assert.equal(f.requests.length, 0);
    }
  });
  await runCase("accepted async favorite survives sheet close and module deactivate", async () => {
    const f = await preferenceFixture(createMusicViews), current = f.s.current;
    const candidate = f.track("candidate", { id: "fixture-A" });
    await f.mount(f.a, [candidate, f.track("other", { id: "fixture-B" })]);
    f.s.playing = true;
    userClick(f.document.querySelectorAll(".music-mobile-track").find(node => node.dataset.trackId === candidate.id).querySelector(".track-more"));
    const favorite = f.document.querySelectorAll(".music-mobile-track-action-choice").find(node => node.getAttribute("aria-label") === "收藏歌曲");
    userClick(favorite); await settle();
    assert.equal(f.writes().length, 1); const request = f.writes()[0];
    assert(request.url.endsWith(`/api/music/tracks/${candidate.id}/favorite`));
    assert.equal(request.options.method, "POST"); assert.equal(JSON.parse(request.options.body).favorite, true);
    assert.equal(f.s.trackActionId, ""); f.audit.renderShell(); f.raw.deactivate();
    assert.equal(f.document.querySelector(".music-mobile-track-actions-sheet"), null);
    assert.equal(request.signal.aborted, false, "accepted favorite mutation is not cancelled with its UI");
    request.resolve({ track: { ...candidate, favorite: true } }); await settle();
    assert.equal(f.s.data.tracks.find(track => track.id === candidate.id).favorite, true);
    assert.equal(f.s.current, current); assert.equal(f.s.playing, true);
  });
  await runCase("playlist management shared sheet consumes native Back and preserves playback", async () => {
    const f = playlistManagementFixture(createMusicViews, { playing: true });
    const state = copy(f.s), { sheet, options } = f.open();
    assert.equal(f.document.activeElement, options[0], "opening management focuses its first real option");
    assert.equal(f.back(), true, "shell native Back consumes the shared management sheet before module navigation");
    assert.equal(f.app.modePickerBackCalls, 0, "the shared sheet closes before the shell menu boundary");
    assert.equal(sheet.isConnected, false);
    assert.equal(f.document.querySelector(".mobile-action-sheet-overlay"), null);
    assert.equal(f.document.activeElement, f.trigger, "same-module close restores the explicit management trigger");
    assert.deepEqual(copy(f.s), state, "closing management preserves the complete music state");
    assert.equal(f.audit.getAudio(), f.audio); assert.equal(f.audio.currentTime, 37.5); assert.equal(f.audio.src, "fixture:playlist-playing");
    assert.deepEqual(f.audioCalls, [], "closing playlist management does not pause, play or reload audio");
    assert.equal(f.calls.length, 0, "closing management does not navigate or pop history");
    options.forEach(option => option.click()); await settle();
    assert.equal(f.dialogs.length, 0, "closed management options cannot reach edit or delete prompts");
    assert.equal(f.requests.length, 0);
  });
  await runCase("playlist management lifecycle retires old options and detached triggers", async () => {
    for (const event of ["fanhaoViewWillRender", "pagehide"]) {
      const f = playlistManagementFixture(createMusicViews), retired = f.open();
      f.emit(event, { view: "unrelated-detail" });
      assert.equal(retired.sheet.isConnected, false, `${event} closes the real shared management sheet`);
      const destination = f.document.createElement("button"); f.els.viewContent.replaceChildren(destination); destination.focus();
      retired.options.forEach(option => option.click()); f.trigger.click(); await settle();
      assert.equal(f.document.querySelector(".mobile-action-sheet-overlay"), null, "detached management cannot reopen after leaving its page");
      assert.equal(f.document.activeElement, destination, "retired controls cannot restore focus over the destination");
      assert.equal(f.dialogs.length, 0); assert.equal(f.requests.length, 0); assert.equal(f.calls.length, 0);
      f.audit.renderShell();
      const currentTrigger = f.document.querySelector(".music-mobile-playlist-management"), current = f.open(currentTrigger);
      const state = copy(f.s), focus = f.document.activeElement;
      retired.options.forEach(option => option.click()); await settle();
      assert.equal(current.sheet.isConnected, true, "retired options cannot close a replacement management sheet");
      assert.equal(f.document.activeElement, focus); assert.deepEqual(copy(f.s), state);
      assert.equal(f.dialogs.length, 0); assert.equal(f.requests.length, 0); assert.equal(f.calls.length, 0);
      assert.equal(f.back(), true); assert.equal(f.document.activeElement, currentTrigger);
    }
  });
  await runCase("playlist management edit and delete restore focus before their original action prompts", async () => {
    for (const [label, kind] of [["编辑歌单", "prompt"], ["删除歌单", "confirm"]]) {
      const f = playlistManagementFixture(createMusicViews), { sheet, options } = f.open();
      const option = options.find(button => button.textContent === label); assert(option);
      option.click(); await settle();
      assert.equal(sheet.isConnected, false, `${label} closes its sheet`);
      assert.equal(f.dialogs.length, 1, `${label} reaches the original factory action boundary`);
      const dialog = f.dialogs[0];
      assert.equal(dialog.kind, kind); assert.equal(dialog.focus, f.trigger, `${label} restores its trigger before calling the action`);
      assert.equal(dialog.sheet, null, `${label} removes its modal before invoking the native dialog`);
      if (kind === "prompt") assert.deepEqual(dialog.args, ["歌单名称", f.playlist.name]);
      else assert(dialog.args[0].includes(f.playlist.name), "delete confirmation retains the selected playlist identity");
      assert.equal(f.requests.length, 0, "controlled cancellation keeps actual playlist writes out of this fixture");
      assert.equal(f.calls.length, 0); assert.equal(f.s.playlistId, f.playlist.id);
      option.click(); await settle(); assert.equal(f.dialogs.length, 1, "an accepted option is retired after returning from its action");
    }
  });
  await runCase("native Back restores newly rendered library sort and facet controls without disturbing audio", () => {
    for (const kind of ["sort", "facet"]) {
      const f = libraryControlFixture(createMusicViews, kind), state = copy(f.s), overlay = f.open();
      assert.equal(f.back(), true, `shell native Back closes the real ${kind} panel`);
      assert.equal(overlay.isConnected, false); assert.equal(f.document.querySelector(f.overlaySelector), null);
      const restored = f.document.querySelector(f.selector);
      assert(restored?.isConnected); assert.notEqual(restored, f.trigger, "renderShell replaces the original opener");
      assert(f.frames.size > 0, "focus restoration is deferred until the new control exists");
      f.flushFrames(); assert.equal(f.document.activeElement, restored, `native Back returns focus to the new ${kind} trigger`);
      assert.deepEqual(copy(f.s), state); f.playbackUnchanged();
      assert.equal(f.requests.length, 0); assert.equal(f.calls.length, 0, "panel Back does not navigate or pop history");
    }
  });
  await runCase("sort done backdrop and current-choice dismissal restore the new sort trigger", () => {
    for (const control of ["done", "backdrop", "current choice"]) {
      const f = libraryControlFixture(createMusicViews, "sort"), overlay = f.open(), sort = f.s.sort;
      const close = control === "done" ? overlay.querySelector(".music-mobile-library-sort-head button")
        : control === "backdrop" ? f.document.querySelector(".music-mobile-library-sort-backdrop")
          : overlay.querySelector(".music-mobile-library-sort-choice.active");
      assert(close, `actual ${control} control exists`); close.click(); f.flushFrames();
      assert.equal(f.document.querySelector(f.overlaySelector), null); assert.equal(f.s.sort, sort);
      assert.equal(f.document.activeElement, f.document.querySelector(f.selector), `${control} restores focus to the new trigger`);
      f.playbackUnchanged(); assert.equal(f.requests.length, 0); assert.equal(f.calls.length, 0, "current-choice dismissal does not start a new list load");
    }
  });
  await runCase("delayed library close focus retires on module route trigger source and account changes", async () => {
    for (const kind of ["sort", "facet"]) {
      for (const transition of ["deactivate", "route generation", "trigger replaced", "source", "account round trip"]) {
        try { await assertRetiredLibraryFocus(createMusicViews, kind, transition); }
        catch (error) { error.message = `${kind}/${transition}: ${error.message}`; throw error; }
      }
    }
  });
  await runCase("asynchronous control success and HTTP failure restore only their operation-owned current target", async () => {
    for (const kind of ["library sort", "search sort", "search filter"]) {
      for (const failure of [false, true]) {
        try { await assertAsyncControlResult(createMusicViews, kind, failure); }
        catch (error) { error.message = `${kind}/${failure ? "failure" : "success"}: ${error.message}`; throw error; }
      }
    }
  });
  await runCase("asynchronous controls reject both late success and failure after request-owner retirement", async () => {
    for (const kind of ["library sort", "search sort", "search filter"]) {
      for (const transition of ["deactivate", "new generation", "source", "source round trip", "account round trip"]) {
        for (const failure of [false, true]) {
          try { await assertAsyncControlRetired(createMusicViews, kind, transition, failure); }
          catch (error) { error.message = `${kind}/${transition}/${failure ? "failure" : "success"}: ${error.message}`; throw error; }
        }
      }
    }
  });
  await runCase("auxiliary catalogue failures finish the same asynchronous control intent once", async () => {
    for (const kind of ["library sort", "search sort", "search filter"]) {
      const f = asyncControlFixture(createMusicViews, kind), action = await f.start();
      await f.complete(action); await f.finish(action, true); f.flushFrames();
      assert(f.document.activeElement === f.target(), `${kind} finishes owned focus after controlled auxiliary failures`);
      assert.equal(f.s.loading, false); f.mediaUnchanged();
      const destination = f.destination(); destination.focus(); f.flushFrames();
      assert(f.document.activeElement === destination, "settled auxiliary failure cannot re-arm the consumed intent");
    }
  });
  await runCase("same-query control requests preserve the newer intent across old finally and old completion", async () => {
    for (const kind of ["library sort", "search sort", "search filter"]) {
      for (const ordering of ["old finally before new", "old after new"]) {
        for (const oldFailure of [false, true]) {
          try { await assertAsyncControlSequence(createMusicViews, kind, ordering, oldFailure); }
          catch (error) { error.message = `${kind}/${ordering}/${oldFailure ? "failure" : "success"}: ${error.message}`; throw error; }
        }
      }
    }
  });
  await runCase("later keyboard pointer and input interaction permanently revoke pending asynchronous control focus", async () => {
    for (const kind of ["library sort", "search sort", "search filter"]) {
      for (const interaction of ["Tab", "click", "input"]) {
        for (const stage of ["pending", "queued frame"]) {
          try { await assertAsyncControlInterrupted(createMusicViews, kind, interaction, stage); }
          catch (error) { error.message = `${kind}/${interaction}/${stage}: ${error.message}`; throw error; }
        }
      }
    }
  });
  await runCase("asynchronous focus commits retain their exact target instead of focusing a replacement", async () => {
    for (const kind of ["library sort", "search sort", "search filter"]) {
      const f = asyncControlFixture(createMusicViews, kind), action = await f.start();
      await f.complete(action); await f.finish(action);
      const target = f.target(), replacement = f.document.createElement(target.tagName.toLowerCase());
      replacement.className = target.className; target.replaceWith(replacement);
      assert.equal(target.isConnected, false); assert.equal(replacement.isConnected, true);
      f.document.activeElement = f.document.body; f.flushFrames();
      assert.equal(f.document.activeElement, f.document.body, `${kind} cannot redirect its queued commit to another matching node`);
      f.mediaUnchanged();
    }
  });
  await runCase("same-owner Tab after closing a library panel revokes its queued focus restoration", () => {
    for (const kind of ["sort", "facet"]) {
      const f = libraryControlFixture(createMusicViews, kind); f.open(); assert.equal(f.back(), true);
      fire(f.document.body, "keydown", { key: "Tab" }); f.document.activeElement = f.document.body; f.flushFrames();
      assert.equal(f.document.activeElement, f.document.body, "closing RAF respects later keyboard intent without any owner change");
      f.playbackUnchanged(); assert.equal(f.requests.length, 0);
    }
  });
  await runCase("route control focus waits for automatic queue restoration and its final render", async () => {
    for (const failure of [false, true]) {
      const f = asyncControlFixture(createMusicViews, "library sort", { allowRestoreAudio: true });
      Object.assign(f.s, { current: null, playing: false, queue: [], resumeQueue: true });
      Object.assign(f.audio, { src: "", currentTime: 0, paused: true });
      f.window.localStorage.setItem("fanhao.android.music.playbackQueue", JSON.stringify({
        activeUrl: f.host.getActiveUrl(), currentTrackId: f.track.id, queue: [f.track]
      }));
      f.audit.renderShell();
      const action = await f.start(); await f.complete(action); await f.auxiliary(); await settle();
      const detail = f.requests.find(request => new URL(request.url).pathname === `/api/music/tracks/${f.track.id}`);
      assert(detail, "the real no-current route tail automatically restores its saved queue track");
      const loadingTrigger = f.target(); f.flushFrames();
      assert.notEqual(f.document.activeElement, loadingTrigger, "primary list completion must not focus before automatic restoration finishes");
      if (failure) detail.resolve({ error: "Synthetic automatic restoration failure" }, 503);
      else detail.resolve({ track: { ...f.track, streamUrl: "/synthetic/audio/restore" }, lyrics: { lines: [], raw: "" }, prevId: "", nextId: "" });
      await settle();
      if (!failure) {
        const audio = f.requests.find(request => new URL(request.url).pathname === "/synthetic/audio/restore");
        assert(audio, "queue restoration reaches only the explicitly controlled synthetic audio boundary");
        audio.resolveAudio(); await settle();
      }
      await action.route; await settle(); f.flushFrames();
      assert.equal(f.document.activeElement, f.target(), "focus returns to the new sort control after the entire real route tail");
      assert.notEqual(f.target(), loadingTrigger, "automatic restoration performed its later accepted shell render");
      assert.equal(f.s.loading, false); assert.equal(f.s.playing, false, "automatic queue restoration preserves autoplay:false");
      if (failure) assert.match(f.s.status, /Synthetic automatic restoration failure/);
      else assert.equal(f.s.current?.id, f.track.id);
      assert(f.requests.every(request => !request.options.method || request.options.method === "GET"));
      if (String(f.audio.src).startsWith("blob:")) URL.revokeObjectURL(f.audio.src);
    }
  });
  await runCase("preference same-owner acknowledgements survive route and deactivate without repainting inactive DOM", () => assertPreferenceSameOwner(createMusicViews));
  await runCase("preference row More and player controls preserve each entity's source and persistence", () => assertPreferenceSourceOwnership(createMusicViews));
  await runCase("preference lanes serialize and coalesce latest values across old success and failure", async () => {
    for (const [failure, latestFailure] of [[false, false], [true, false], [false, true]]) await assertPreferenceLane(createMusicViews, failure, latestFailure);
  });
  await runCase("preference favorite toggles the latest desired value instead of stale displayed state", () => assertPreferenceFavoriteIntent(createMusicViews));
  await runCase("preference independent fields never merge another field or full track DTO", () => assertPreferenceIndependentFields(createMusicViews));
  await runCase("preference source round trip accepts owner data and suppresses superseded intent", async () => {
    for (const newerIntent of [false, true]) await assertPreferenceSourceReturn(createMusicViews, newerIntent);
  });
  await runCase("preference account changes retire unsent credentials without splitting the physical owner lane", () => assertPreferenceAccountRevision(createMusicViews));
  await runCase("preference receipts preserve unrelated persisted source and track records", () => assertPreferencePersistence(createMusicViews));
  await runCase("preference acknowledged fields overlay delayed GET snapshots independently", () => assertPreferenceLateRead(createMusicViews));
  await runCase("playback settings real entry and all dismissals preserve player playback and restore focus", () => assertPlaybackSettingsClose(createMusicViews));
  await runCase("playback settings keyboard Tab stays inside the actual panel", () => assertPlaybackSettingsKeyboard(createMusicViews));
  await runCase("playback settings submitted rating survives close and deactivate through its real entry", () => assertPlaybackSettingsRating(createMusicViews));
  await runCase("playback settings retired controls cannot affect a reopened panel next track or inactive module", async () => {
    for (const transition of ["close reopen", "switch track", "deactivate"]) await assertPlaybackSettingsRetired(createMusicViews, transition);
  });
  await runCase("playback settings delayed close focus respects later input route source account and target ownership", async () => {
    for (const transition of ["Tab", "deactivate", "route", "source", "account round trip", "target replaced"]) await assertPlaybackSettingsFocusRetired(createMusicViews, transition);
  });
  await runCase("playback settings remains dismissible when its mounted source or account becomes invalid", () => assertPlaybackSettingsInvalidScope(createMusicViews));
  await runCase("mini opener and queue enter the full player and Back returns through child sheets to the real origin", () => assertMiniPlayerOpenBack(createMusicViews));
  await runCase("retired mini click playback queue and swipe callbacks cannot affect a new or inactive page", async () => {
    for (const transition of ["rerender", "switch track", "deactivate"]) await assertMiniPlayerRetired(createMusicViews, transition);
  });
  await runCase("mini gestures require one live matching touch and consume their follow-up click", () => assertMiniPlayerGestures(createMusicViews));
  await runCase("mini opening and returning focus respect later input source account and exact destination", async () => {
    for (const phase of ["open", "close"]) for (const transition of ["Tab", "deactivate", "source", "account round trip", "target replaced"])
      await assertMiniPlayerFocusRetired(createMusicViews, phase, transition);
  });
  await runCase("negative control: old module closeFullscreen contract", () => {
    const code = moduleSource.replace("musicViews.handleBack?.()", "musicViews.closeFullscreen?.()");
    assert.notEqual(code, moduleSource);
    assert.throws(() => assertSearchBack(createMusicViews, { code }), /Back consumes the blank music search/);
  });
  await runCase("negative control: query-only guard misses empty search", async () => {
    const source = viewSource.replace("if (!state.searchOpen && !state.query) return false;", "if (!state.query) return false;");
    assert.notEqual(source, viewSource);
    const mutant = await importFactory(source);
    assert.throws(() => assertSearchBack(mutant), /Back consumes the blank music search/);
  });
  await runCase("negative control: search-first Back violates nested priority", async () => {
    const source = viewSource.replace("    if (closeFullscreen()) return true;\n    if (!state.searchOpen && !state.query) return false;",
      "    if (!state.searchOpen && !state.query) return closeFullscreen();");
    assert.notEqual(source, viewSource);
    const mutant = await importFactory(source);
    assert.throws(() => assertLayeredBack(mutant), /first Back closes the top track actions/);
  });
  await runCase("negative control: unguarded old track action can still mutate queue", async () => {
    const source = sheetsSource.replace("trackActionHandler(sheet, action)", "action");
    assert.notEqual(source, sheetsSource);
    const mutant = await importFactory(viewSource, source);
    const f = trackActionFixture(mutant), action = f.button("加入队列");
    assert.equal(f.back(), true); action.click();
    assert.throws(() => assert.deepEqual(f.s.queue.map(track => track.id), [f.current.id]), /deep-equal/);
  });
  await runCase("negative control: deferred library focus without active-module guard steals focus", async () => {
    // The new implementation has three retirement defences. Restore the old
    // missing-retirement behaviour across cancellation and both active guards.
    const detach = "function deactivate() {\n    controlFocus.cancel();";
    const binding = "controlFocus.bind(intent, () => moduleActive && generation === musicRenderGeneration);";
    assert.equal(viewSource.split(detach).length, 2); assert.equal(viewSource.split(binding).length, 2);
    const source = viewSource.replace(detach, "function deactivate() {").replace(binding, binding.replace("moduleActive && ", ""));
    const helper = controlFocusSource.replace("&& !intent.cancelled && isActive()", "&& !intent.cancelled");
    assert.notEqual(helper, controlFocusSource);
    const mutant = await importFactory(source, null, helper);
    await assert.rejects(() => assertRetiredLibraryFocus(mutant, "sort", "deactivate", true), /deferred close focus must not steal focus/);
  });
  await runCase("negative control: missing user-interaction listeners revives a cancelled close focus intent", async () => {
    const events = '["pointerdown", "keydown", "input", "compositionstart", "focusin", "wheel"]';
    assert.equal(controlFocusSource.split(events).length, 2);
    const mutant = await importFactory(viewSource, null, controlFocusSource.replace(events, "[]"));
    const f = libraryControlFixture(mutant, "sort"); f.open(); assert.equal(f.back(), true);
    fire(f.document.body, "keydown", { key: "Tab" }); f.document.activeElement = f.document.body; f.flushFrames();
    assert.throws(() => assert(f.document.activeElement === f.document.body, "missing user interaction cancellation steals focus"), /missing user interaction cancellation steals focus/);
  });
  await runCase("negative control: ID-only preference ownership corrupts colliding source entities", async () => {
    const boundary = /function sameOwner\(left, right\) \{[\s\S]*?\n  \}/;
    assert.equal(preferenceSource.match(new RegExp(boundary.source, "g"))?.length, 1);
    const helper = preferenceSource.replace(boundary, "function sameOwner(left, right) { return Boolean(left && right); }");
    const mutant = await importFactory(viewSource, null, null, helper);
    await assert.rejects(() => assertPreferenceSourceOwnership(mutant), /colliding source B true acknowledgement|source A's persisted playback queue/);
    console.log("Preference owner negative control: correctly rejected ID-only cross-source publication.");
  });
  await runCase("negative control: full preference DTO merging overwrites independent fields and metadata", async () => {
    const result = "patch: { id, [field]: saved.value }", send = "const data = await send(job.owner, id, field, job.desired);";
    assert.equal(preferenceSource.split(result).length, 2); assert.equal(preferenceSource.split(send).length, 2);
    const helper = preferenceSource.replace("let result = null;", "let result = null; let receivedTrack = null;")
      .replace(send, `${send}\n        receivedTrack = data?.track;`).replace(result, "patch: receivedTrack || { id, [field]: saved.value }");
    const source = viewSource.replace("if (belongs(track)) track[field] = patch[field];", "if (belongs(track)) Object.assign(track, patch);")
      .replace("binding.track[field] = patch[field];", "Object.assign(binding.track, patch);");
    assert.notEqual(source, viewSource);
    const mutant = await importFactory(source, null, null, helper);
    await assert.rejects(() => assertPreferenceIndependentFields(mutant), /full DTO snapshots cannot overwrite/);
    console.log("Preference field negative control: correctly rejected full DTO merging.");
  });
  await runCase("negative control: parallel same-field preference writes violate physical serialization", async () => {
    const boundary = "if (lane.active) {"; assert.equal(preferenceSource.split(boundary).length, 2);
    const mutant = await importFactory(viewSource, null, null, preferenceSource.replace(boundary, "if (false && lane.active) {"));
    await assert.rejects(() => assertPreferenceLane(mutant), /one physical preference lane has only one write in flight/);
    console.log("Preference order negative control: correctly rejected parallel same-field writes.");
  });
  await runCase("negative control: unguarded retired playback controls can change the active session", async () => {
    const boundary = "return isMountedPlaybackSettingsSession(session) && playbackSettingsOwnerCurrent(session);";
    assert.equal(viewSource.split(boundary).length, 2);
    const mutant = await importFactory(viewSource.replace(boundary, "return true;"));
    await assert.rejects(() => assertPlaybackSettingsRetired(mutant), /retired settings controls cannot change current music state/);
    console.log("Playback settings retired negative control: correctly rejected old controls changing the active session.");
  });
  await runCase("negative control: playback close focus without interaction retirement steals focus", async () => {
    const events = '["pointerdown", "keydown", "input", "compositionstart", "focusin", "wheel"]';
    assert.equal(controlFocusSource.split(events).length, 2);
    const mutant = await importFactory(viewSource, null, controlFocusSource.replace(events, "[]"));
    await assert.rejects(() => assertPlaybackSettingsFocusRetired(mutant), /retired playback settings close focus cannot steal a later user's focus/);
    console.log("Playback settings focus negative control: correctly rejected close focus after later user input.");
  });
  await runCase("negative control: detached mini controls without exact mounted identity can operate the current player", async () => {
    const boundary = 'moduleActive && !state.fullscreen && player.isConnected\n      && els.viewContent.querySelector(".music-mobile-mini-player") === player';
    assert.equal(viewSource.split(boundary).length, 2);
    const mutant = await importFactory(viewSource.replace(boundary, "moduleActive && !state.fullscreen"));
    await assert.rejects(() => assertMiniPlayerRetired(mutant), /retired mini callbacks and gesture tails cannot change/);
    console.log("Mini mounted negative control: correctly rejected detached controls operating the current player.");
  });
  await runCase("negative control: mini touchend without a real gesture start can open the player", async () => {
    const boundary = "const start = gesture;"; assert.equal(viewSource.split(boundary).length, 2);
    const mutant = await importFactory(viewSource.replace(boundary,
      "const start = gesture || { id: event.changedTouches?.[0]?.identifier, x: 0, y: 0 };"));
    await assert.rejects(() => assertMiniPlayerGestures(mutant), /an invalid mini gesture cannot open the player or choose a track/);
    console.log("Mini gesture negative control: correctly rejected an orphan touchend opening the player.");
  });
  await runCase("negative control: mini focus without later input retirement steals focus", async () => {
    const events = '["pointerdown", "keydown", "input", "compositionstart", "focusin", "wheel"]';
    assert.equal(controlFocusSource.split(events).length, 2);
    const mutant = await importFactory(viewSource, null, controlFocusSource.replace(events, "[]"));
    await assert.rejects(() => assertMiniPlayerFocusRetired(mutant), /a retired mini\/full focus commit cannot steal later focus/);
    console.log("Mini focus negative control: correctly rejected opening focus after later user input.");
  });
  console.log(`Android music Back verification passed (${cases} scenarios, including 14 negative controls; ${fixtureId} controlled fixtures).`);
} catch (error) {
  // An instrumented whole factory uses a data URL: avoid dumping its source as a stack.
  console.error(`${selectedCase || "fixture setup"}: ${error.name}: ${error.message}`);
  process.exitCode = 1;
} finally {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
}
