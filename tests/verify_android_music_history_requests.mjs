import assert from "node:assert/strict";
import fs from "node:fs";
import { createNavigationFixtureDocument } from "./fixtures/android-gallery-navigation-harness.mjs";
import { captureAccountOwner, setAccountOwner } from "../android-client/www/js/account-owner.js";

// Execute the complete music factory and history-action helper. Only DOM,
// clocks, storage, Audio and HTTP completion are controlled. Writes affect no
// real library, and deliberately settle after a route has retired.
const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const viewUrl = new URL("../android-client/www/modules/music/music-views.js", import.meta.url);
const historyUrl = new URL("../android-client/www/modules/music/music-history-actions-view.js", import.meta.url);
const viewSource = read("android-client/www/modules/music/music-views.js");
const historySource = read("android-client/www/modules/music/music-history-actions-view.js");
const originals = Object.fromEntries(["window", "document", "localStorage", "fetch", "Audio", "__musicHistoryFixture"].map(key => [key, globalThis[key]]));
const copy = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
let cases = 0, selectedCase = "", fixtureId = 0;

function importUrl(source, base) {
  return `data:text/javascript;base64,${Buffer.from(source.replace(/from "(\.\.?\/[^\"]+)"/g,
    (_all, relative) => `from ${JSON.stringify(new URL(relative, base).href)}`)).toString("base64")}`;
}

async function importFactory(historyCode = historySource, viewCode = viewSource) {
  const pattern = /^import \{ createMusicHistoryActionsView \} from "[^\"]+";$/m;
  assert(pattern.test(viewCode));
  const source = viewCode.replace(pattern, `import { createMusicHistoryActionsView } from ${JSON.stringify(importUrl(historyCode, historyUrl))};`);
  const hook = "  installLifecycle();";
  assert.equal(source.split(hook).length, 2);
  const instrumented = source.replace(hook, `
  globalThis.__musicHistoryFixture = { state, renderShell, activate() { moduleActive = true; } };
  installLifecycle();`);
  return (await import(importUrl(instrumented, viewUrl))).createMusicViews;
}

function fixture(createMusicViews) {
  const document = globalThis.document = createNavigationFixtureDocument();
  const prototype = Object.getPrototypeOf(document.body);
  if (!Object.getOwnPropertyDescriptor(prototype, "isConnected")) {
    Object.defineProperty(prototype, "isConnected", { get() { return this.ownerDocument.body.contains(this); } });
    Object.defineProperty(prototype, "childNodes", { get() { return this.children; } });
    prototype.blur = function() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; };
    const queryAll = prototype.querySelectorAll;
    prototype.querySelectorAll = function(selector) {
      if (selector.includes(",")) return [...new Set(selector.split(",").flatMap(part => this.querySelectorAll(part.trim())))];
      if (selector.startsWith(":scope > ")) {
        const parts = selector.slice(9).trim().split(/\s*>\s*/);
        let nodes = [this];
        for (const part of parts) nodes = nodes.flatMap(node => node.children.filter(child => child.matches(part)));
        return nodes;
      }
      const parts = selector.trim().split(/\s+/);
      if (parts.length < 2 || selector.startsWith(":scope")) return queryAll.call(this, selector);
      return queryAll.call(this, parts.at(-1)).filter(node => {
        let ancestor = node.parentNode;
        for (let i = parts.length - 2; i >= 0; i--) {
          while (ancestor && ancestor !== this.parentNode && !ancestor.matches?.(parts[i])) ancestor = ancestor.parentNode;
          if (!ancestor || ancestor === this.parentNode) return false;
          ancestor = ancestor.parentNode;
        }
        return true;
      });
    };
  }
  document.querySelector = selector => document.body.querySelector(selector);
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  document.createTextNode = text => { const node = document.createElement("span"); node.textContent = text; return node; };
  const requests = [], storage = new Map(), clocks = new Map();
  let sourceUrl = `http://music-history-${++fixtureId}.fixture.invalid:29998`, timerId = 0;
  const fetch = (url, options = {}) => {
    assert(/^http:\/\/music-history-\d+(?:-other)?\.fixture\.invalid:29998\/api\//.test(String(url)), "only synthetic HTTP is allowed");
    return new Promise((resolve, reject) => requests.push({ url: String(url), options, signal: options.signal,
      resolve(payload) { resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => payload }); }, reject }));
  };
  globalThis.window = {
    addEventListener() {}, setTimeout(fn, delay) { const id = ++timerId; clocks.set(id, { fn, delay }); return id; },
    clearTimeout(id) { clocks.delete(id); }, setInterval() { return ++timerId; }, clearInterval() {},
    requestAnimationFrame() { return ++timerId; }, cancelAnimationFrame() {}, scrollTo() {}, scrollY: 0,
    confirm() { return true; }, fetch
  };
  globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key) };
  globalThis.fetch = fetch;
  globalThis.Audio = class {
    constructor() { this.currentTime = 37.5; this.duration = 120; this.paused = false; this.src = "fixture:playing"; }
    addEventListener() {}
    pause() { throw new Error("history management must preserve playback"); }
    load() { throw new Error("history management must preserve playback"); }
  };
  const els = { viewContent: document.createElement("main"), viewTitle: {}, viewKicker: {}, viewMeta: {} };
  document.body.append(els.viewContent);
  setAccountOwner(sourceUrl, "account:fixture-A");
  const music = createMusicViews({ els, getActiveUrl: () => sourceUrl, showView() {}, replaceViewParams() {}, setActiveBottom() {} });
  const audit = globalThis.__musicHistoryFixture; audit.activate();
  const current = { id: "playing-fixture", title: "Playing fixture", durationMs: 120000 };
  Object.assign(audit.state, { mode: "history", dashboard: false, data: { tracks: [current], rawTracks: [current], rawLoaded: 1, total: 1 },
    current, queue: [current], playing: true, hasMore: true, gapless: false, crossfadeSeconds: 0, historyActionsOpen: true });
  audit.renderShell();
  const button = document.querySelector(".music-mobile-history-clear"); assert(button);
  return { music, audit, state: audit.state, document, els, requests, current, button,
    setSource() { sourceUrl = sourceUrl.replace(".fixture", "-other.fixture"); },
    switchAccount(transition) {
      const previous = captureAccountOwner(sourceUrl);
      setAccountOwner(sourceUrl, "pending");
      if (transition !== "account pending") setAccountOwner(sourceUrl, "account:fixture-B");
      if (transition === "account round trip") {
        setAccountOwner(sourceUrl, "account:fixture-A");
        const current = captureAccountOwner(sourceUrl);
        assert.equal(current.owner, previous.owner); assert(current.revision > previous.revision);
      }
      // The real shell clears account content in the pending stage before a
      // reload/deactivate; keep the factory alive to exercise that boundary.
      els.viewContent.replaceChildren();
    },
    async beginClear() { button.click(); await settle(); assert.equal(requests.length, 1); assert.equal(requests[0].options.method, "DELETE");
      assert.equal(new URL(requests[0].url).pathname, "/api/music/history"); assert.equal(requests[0].signal.aborted, false); return requests[0]; },
    async renderRoute(mode = "library") {
      const first = requests.length;
      const pending = music.renderMusicList({ mode, dashboard: "0" }); await settle();
      const reads = requests.slice(first); assert.equal(reads.length, 3, "actual route runs its catalogue and list reads");
      for (const request of reads) request.resolve({ tracks: [{ id: `new-${mode}`, title: "New fixture" }], total: 1,
        smartPlaylists: [], playlists: [], hasMore: false });
      await pending; await settle();
    }
  };
}

async function assertRetired(createMusicViews, transition, failure = false) {
  const f = fixture(createMusicViews), request = await f.beginClear();
  if (transition === "route") await f.renderRoute("library");
  if (transition === "same route") await f.renderRoute("history");
  if (transition === "source") f.setSource();
  if (transition === "deactivate") f.music.deactivate();
  if (transition.startsWith("account")) f.switchAccount(transition);
  const snapshot = copy(f.state), shell = f.els.viewContent.children[0], count = f.requests.length;
  assert.equal(request.signal.aborted, false, "accepted DELETE survives navigation");
  if (failure) request.reject(new Error("Retired fixture failure")); else request.resolve({ ok: true });
  await settle();
  assert.deepEqual(copy(f.state), snapshot, `retired ${transition} completion cannot replace current data/status`);
  assert.equal(f.els.viewContent.children[0], shell, "retired completion cannot repaint");
  assert.equal(f.requests.length, count, "retired success cannot start a smart-playlist refresh against the current source");
}

async function runCase(name, callback) { selectedCase = name; await callback(); cases++; }

try {
  const createMusicViews = await importFactory();
  for (const transition of ["route", "same route", "source", "deactivate", "account pending", "account", "account round trip"]) {
    for (const failure of [false, true]) await runCase(`${transition}: late ${failure ? "failure" : "success"}`, () => assertRetired(createMusicViews, transition, failure));
  }
  await runCase("current success clears history and refreshes smart playlists without changing playback", async () => {
    const f = fixture(createMusicViews), queue = f.state.queue, request = await f.beginClear();
    assert.equal(f.state.loading, true); assert.equal(f.state.historyActionsOpen, false);
    request.resolve({ ok: true }); await settle();
    assert.deepEqual(f.state.data.tracks, []); assert.equal(f.state.data.total, 0); assert.equal(f.state.hasMore, false);
    assert.equal(f.state.loading, false); assert.equal(f.state.status, "");
    assert.equal(f.requests.length, 2); assert.equal(new URL(f.requests[1].url).pathname, "/api/music/smart-playlists");
    f.requests[1].resolve({ smartPlaylists: [{ id: "empty-history", name: "Fresh fixture" }], summary: { marker: "fresh" } }); await settle();
    assert.equal(f.state.summary.marker, "fresh"); assert.equal(f.state.current, f.current);
    assert.equal(f.state.queue, queue); assert.equal(f.state.playing, true);
    assert(f.document.querySelector(".music-mobile-playlist-empty"), "current history shows its empty state");
  });
  await runCase("navigation during smart-playlist refresh cannot overwrite newer catalogue or repaint", async () => {
    const f = fixture(createMusicViews), request = await f.beginClear();
    request.resolve({ ok: true }); await settle(); const refresh = f.requests[1]; assert(refresh);
    await f.renderRoute("library"); const snapshot = copy(f.state), shell = f.els.viewContent.children[0];
    refresh.resolve({ smartPlaylists: [{ id: "retired-smart" }], summary: { marker: "retired" } }); await settle();
    assert.deepEqual(copy(f.state), snapshot); assert.equal(f.els.viewContent.children[0], shell);
  });
  for (const failure of [false, true]) await runCase(`account round trip during smart-playlist refresh: late ${failure ? "failure" : "success"}`, async () => {
    const f = fixture(createMusicViews), request = await f.beginClear();
    request.resolve({ ok: true }); await settle(); const refresh = f.requests[1]; assert(refresh);
    f.switchAccount("account round trip"); const snapshot = copy(f.state), count = f.requests.length;
    if (failure) refresh.reject(new Error("Retired account catalogue failure"));
    else refresh.resolve({ smartPlaylists: [{ id: "retired-account-smart" }], summary: { marker: "retired-account" } });
    await settle(); assert.deepEqual(copy(f.state), snapshot); assert.equal(f.els.viewContent.children.length, 0);
    assert.equal(f.requests.length, count); assert.equal(request.signal.aborted, false);
  });
  await runCase("current failure preserves history, releases loading and permits retry", async () => {
    const f = fixture(createMusicViews), data = f.state.data, request = await f.beginClear();
    request.reject(new Error("Fixture unavailable")); await settle();
    assert.equal(f.state.data, data); assert.equal(f.state.loading, false); assert.equal(f.state.status, "Fixture unavailable");
    f.document.querySelector('[aria-label="管理播放记录"]').click();
    f.document.querySelector(".music-mobile-history-clear").click(); await settle();
    assert.equal(f.requests.length, 2); assert.equal(f.requests[1].options.method, "DELETE");
    f.requests[1].reject(new Error("Second fixture failure")); await settle();
  });
  await runCase("retired and repeated sheet controls cannot start another DELETE", async () => {
    const f = fixture(createMusicViews), request = await f.beginClear();
    f.button.click(); f.button.click(); await settle(); assert.equal(f.requests.length, 1);
    await f.renderRoute("history"); const count = f.requests.length; f.button.click(); await settle();
    assert.equal(f.requests.length, count); request.resolve({ ok: true }); await settle();
  });
  await runCase("cancelled confirmation keeps history and starts no write", async () => {
    const f = fixture(createMusicViews), snapshot = copy(f.state); window.confirm = () => false;
    f.button.click(); await settle(); assert.deepEqual(copy(f.state), snapshot); assert.equal(f.requests.length, 0);
  });
  await runCase("negative control: missing acknowledgement guard empties newer history", async () => {
    const mutant = historySource.replace("await deleteJson(sourceUrl, \"/api/music/history\");\n      if (!isCurrent()) return;", "await deleteJson(sourceUrl, \"/api/music/history\");");
    assert.notEqual(mutant, historySource);
    const createMutant = await importFactory(mutant);
    await assert.rejects(() => assertRetired(createMutant, "same route"), /retired same route completion/);
  });
  await runCase("negative control: missing failure guard overwrites new page status", async () => {
    const mutant = historySource.replace("} catch (error) {\n      if (!isCurrent()) return;", "} catch (error) {");
    assert.notEqual(mutant, historySource); const createMutant = await importFactory(mutant);
    await assert.rejects(() => assertRetired(createMutant, "route", true), /retired route completion/);
  });
  await runCase("negative control: missing account revision guard revives old account content", async () => {
    const mutant = viewSource.replaceAll("&& isAccountOwnerCurrent(accountOwner)", ""); assert.notEqual(mutant, viewSource);
    const createMutant = await importFactory(historySource, mutant);
    await assert.rejects(() => assertRetired(createMutant, "account round trip"), /retired account round trip completion/);
  });
  console.log(`Android music history request verification passed (${cases} scenarios, including 3 negative controls; ${fixtureId} controlled fixtures).`);
} catch (error) {
  console.error(`${selectedCase || "fixture setup"}: ${error.name}: ${error.message}`); process.exitCode = 1;
} finally {
  for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
}
