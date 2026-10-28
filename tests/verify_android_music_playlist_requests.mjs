import assert from "node:assert/strict";
import fs from "node:fs";
import { createNavigationFixtureDocument } from "./fixtures/android-gallery-navigation-harness.mjs";
import { captureAccountOwner, setAccountOwner } from "../android-client/www/js/account-owner.js";

// Run the complete music factory, including real API and catalogue helpers.
// DOM, Audio, storage, clocks and network completion are controlled boundaries;
// no library, media, service or physical Android device is accessed.
const viewUrl = new URL("../android-client/www/modules/music/music-views.js", import.meta.url);
const viewSource = fs.readFileSync(viewUrl, "utf8").replace(/\r\n/g, "\n");
const originals = Object.fromEntries(["window", "document", "localStorage", "fetch", "Audio", "__musicPlaylistFixture"].map(key => [key, globalThis[key]]));
const copy = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
let cases = 0, selectedCase = "", fixtureId = 0;

async function importFactory(source = viewSource) {
  const hook = "  installLifecycle();";
  assert.equal(source.split(hook).length, 2);
  const instrumented = source.replace(hook, `
  globalThis.__musicPlaylistFixture = { state, renderShell, openTrack, appendTrackToQueue,
    removeTrackFromCurrentPlaylist, editCurrentPlaylist, deleteCurrentPlaylist,
    createPlaylistFromPrompt, saveQueueAsPlaylist, addTrackToPlaylist,
    activate() { moduleActive = true; } };
  installLifecycle();`);
  const imports = instrumented.replace(/from "(\.\.?\/[^\"]+)"/g,
    (_all, relative) => `from ${JSON.stringify(new URL(relative, viewUrl).href)}`);
  return (await import(`data:text/javascript;base64,${Buffer.from(imports).toString("base64")}`)).createMusicViews;
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
      if (parts.length < 2) return queryAll.call(this, selector);
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
  const requests = [], calls = [], storage = new Map(), clocks = new Map();
  let sourceUrl = `http://music-playlist-${++fixtureId}.fixture.invalid:29998`, timerId = 0;
  const fetch = (url, options = {}) => {
    assert(/^http:\/\/music-playlist-\d+(?:-other)?\.fixture\.invalid:29998\/api\//.test(String(url)), "only synthetic HTTP is allowed");
    return new Promise((resolve, reject) => requests.push({ url: String(url), options, signal: options.signal,
      resolve(payload) { resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => payload }); }, reject }));
  };
  globalThis.window = {
    addEventListener() {}, setTimeout(fn, delay) { const id = ++timerId; clocks.set(id, { fn, delay }); return id; },
    clearTimeout(id) { clocks.delete(id); }, setInterval() { return ++timerId; }, clearInterval() {},
    requestAnimationFrame() { return ++timerId; }, cancelAnimationFrame() {}, scrollTo() {}, scrollY: 0,
    confirm() { return true; }, prompt(label) { return label === "歌单名称" ? "Edited fixture" : "Edited description"; }, fetch
  };
  globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key) };
  globalThis.fetch = fetch;
  globalThis.Audio = class {
    constructor() { this.currentTime = 37.5; this.duration = 120; this.paused = false; this.src = "fixture:playing"; }
    addEventListener() {}
    pause() { throw new Error("playlist management must preserve playback"); }
    load() { throw new Error("playlist management must preserve playback"); }
  };
  const els = { viewContent: document.createElement("main"), viewTitle: {}, viewKicker: {}, viewMeta: {} };
  document.body.append(els.viewContent);
  setAccountOwner(sourceUrl, "account:fixture-A");
  const music = createMusicViews({ els, getActiveUrl: () => sourceUrl, showView: (...args) => calls.push(args), replaceViewParams() {}, setActiveBottom() {} });
  const audit = globalThis.__musicPlaylistFixture; audit.activate();
  const current = { id: "playing-fixture", title: "Playing fixture", durationMs: 120000 };
  const other = { id: "other-fixture", title: "Other fixture" };
  const playlist = { id: "playlist-fixture", name: "Initial fixture", trackCount: 2 };
  Object.assign(audit.state, { mode: "playlist", playlistId: playlist.id, playlist, playlists: [playlist], dashboard: false,
    data: { playlist, tracks: [current, other], total: 2 }, current, queue: [current, other], playing: true,
    gapless: false, crossfadeSeconds: 0 });
  audit.renderShell();
  return { music, audit, state: audit.state, document, els, requests, calls, storage, current, other, playlist,
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
      // Mirror the shell's account-pending content clear without deactivating
      // this factory or changing its route/server generation.
      els.viewContent.replaceChildren();
    },
    async begin(kind) {
      const first = requests.length;
      const pending = kind === "remove" ? audit.removeTrackFromCurrentPlaylist(other.id)
        : kind === "edit" ? audit.editCurrentPlaylist() : audit.deleteCurrentPlaylist();
      // Observe rejections immediately, even when a fixture holds the write.
      pending.catch(() => {}); await settle();
      assert.equal(requests.length, first + 1);
      const request = requests[first];
      assert.equal(request.options.method, kind === "edit" ? "PUT" : "DELETE");
      assert.equal(new URL(request.url).pathname, `/api/music/playlists/${playlist.id}${kind === "remove" ? `/tracks/${other.id}` : ""}`);
      if (kind === "edit") assert.deepEqual(JSON.parse(request.options.body), { name: "Edited fixture", description: "Edited description" });
      return { pending, request };
    },
    async beginAddition(kind) {
      Object.assign(audit.state, { fullscreen: false, queueOpen: false, queueManageOpen: false,
        playlistSheetOpen: false, playlistActionTrackId: "" });
      if (kind === "create") Object.assign(audit.state, { mode: "library", playlistId: "", dashboard: true });
      if (kind === "create-with-track" || kind === "add") audit.state.playlistActionTrackId = other.id;
      if (kind === "create-current" || kind === "add-current") Object.assign(audit.state, { fullscreen: true, playlistSheetOpen: true });
      if (kind === "save") Object.assign(audit.state, { fullscreen: true, queueOpen: true, queueManageOpen: true });
      audit.renderShell(); const first = requests.length;
      const pending = kind === "create" ? audit.createPlaylistFromPrompt({ openAfterCreate: true })
        : kind === "create-with-track" ? audit.createPlaylistFromPrompt({ addTrackId: other.id })
        : kind === "create-current" ? audit.createPlaylistFromPrompt({ addCurrent: true })
        : kind === "save" ? audit.saveQueueAsPlaylist()
        : audit.addTrackToPlaylist(playlist.id, kind === "add-current" ? current.id : other.id);
      pending.catch(() => {}); await settle(); assert.equal(requests.length, first + 1);
      const request = requests[first]; assert.equal(request.options.method, "POST");
      assert.equal(new URL(request.url).pathname, kind.startsWith("add") ? `/api/music/playlists/${playlist.id}/tracks` : "/api/music/playlists");
      const body = JSON.parse(request.options.body);
      if (kind === "create") assert.deepEqual(body, { name: "Edited fixture" });
      if (kind === "create-with-track" || kind === "create-current") assert.deepEqual(body, { name: "Edited fixture", trackIds: [kind === "create-current" ? current.id : other.id] });
      if (kind === "save") assert.deepEqual(body, { name: "Edited fixture", description: "从播放队列保存", trackIds: [current.id, other.id] });
      if (kind.startsWith("add")) assert.deepEqual(body, { trackId: kind === "add-current" ? current.id : other.id });
      return { request, pending };
    },
    async renderRoute(mode = "library", playlistId = "") {
      const first = requests.length;
      const pending = music.renderMusicList({ mode, playlistId, dashboard: "0" }); await settle();
      const reads = requests.slice(first); assert.equal(reads.length, 3);
      for (const request of reads) request.resolve({ tracks: [{ id: `new-${mode}`, title: "New fixture" }], total: 1,
        smartPlaylists: [], playlists: [], playlist: playlistId ? { id: playlistId, name: "Reopened fixture" } : null, hasMore: false });
      await pending; await settle();
    },
    async selectTrack({ complete = true } = {}) {
      const first = requests.length;
      const pending = audit.openTrack("new-selection", { autoplay: false }); pending.catch(() => {}); await settle();
      assert.equal(requests.length, first + 1); const request = requests[first];
      assert.equal(new URL(request.url).pathname, "/api/music/tracks/new-selection");
      if (complete) { request.resolve({ track: { id: "new-selection", title: "Newest selected fixture" } }); await pending; await settle(); }
      return { pending, request };
    }
  };
}

const writeResult = f => ({ playlist: { ...f.playlist, name: "Written fixture", trackCount: 1 }, tracks: [f.current], total: 1 });

async function assertRetired(createMusicViews, kind, transition, failure = false) {
  const f = fixture(createMusicViews), { request, pending } = await f.begin(kind);
  let selected;
  if (transition === "route") await f.renderRoute("library");
  if (transition === "other playlist") await f.renderRoute("playlist", "different-fixture");
  if (transition === "same route") await f.renderRoute("playlist", f.playlist.id);
  if (transition === "source") f.setSource();
  if (transition === "deactivate") f.music.deactivate();
  if (transition === "selection") selected = await f.selectTrack();
  if (transition === "pending selection") selected = await f.selectTrack({ complete: false });
  if (transition.startsWith("account")) f.switchAccount(transition);
  const snapshot = copy(f.state), shell = f.els.viewContent.children[0], requestCount = f.requests.length, navigation = f.calls.length;
  assert.equal(request.signal.aborted, false, "accepted write survives UI transitions");
  if (failure) { request.reject(new Error("Retired fixture failure")); await assert.doesNotReject(pending); }
  else { request.resolve(writeResult(f)); await pending; }
  await settle();
  assert.deepEqual(copy(f.state), snapshot, `retired ${kind} after ${transition} cannot replace the new list, queue or status`);
  assert.equal(f.els.viewContent.children[0], shell, "retired completion cannot repaint");
  assert.equal(f.requests.length, requestCount, "retired completion cannot refresh a different catalogue");
  assert.equal(f.calls.length, navigation, "retired deletion cannot navigate away from the user's current context");
  if (selected && transition === "pending selection") { selected.request.resolve({ track: { id: "new-selection", title: "Newest fixture" } }); await selected.pending; }
}

async function runCase(name, callback) { selectedCase = name; await callback(); cases++; }

async function retireAddition(f, transition) {
  if (transition === "route") await f.renderRoute("library");
  if (transition === "same route") await f.renderRoute(f.state.mode, f.state.playlistId);
  if (transition === "selection") await f.selectTrack();
  if (transition === "source") f.setSource();
  if (transition === "deactivate") f.music.deactivate();
  if (transition.startsWith("account")) f.switchAccount(transition);
  if (transition === "close sheet" || transition === "reopen sheet") {
    const flags = Object.fromEntries(["fullscreen", "queueOpen", "queueManageOpen", "playlistSheetOpen", "playlistActionTrackId"].map(key => [key, f.state[key]]));
    assert.equal(f.music.handleBack(), true, "actual Back closes the originating surface");
    if (transition === "reopen sheet") { Object.assign(f.state, flags); f.audit.renderShell(); }
  }
  if (transition === "queue") f.audit.appendTrackToQueue({ id: "post-start-queue", title: "Newly queued fixture" });
}

async function assertRetiredAddition(createMusicViews, kind, transition, failure = false) {
  const f = fixture(createMusicViews), { request, pending } = await f.beginAddition(kind);
  await retireAddition(f, transition);
  const snapshot = copy(f.state), shell = f.els.viewContent.children[0], count = f.requests.length, navigation = f.calls.length;
  assert.equal(request.signal.aborted, false, "accepted POST survives page and surface changes");
  if (failure) { request.reject(new Error("Retired addition failure")); await assert.doesNotReject(pending); }
  else {
    request.resolve(writeResult(f)); await settle();
    assert.equal(f.requests.length, count, "retired addition cannot refresh a new catalogue");
    await pending;
  }
  await settle(); assert.deepEqual(copy(f.state), snapshot, `retired ${kind} after ${transition} cannot replace state or close another sheet`);
  assert.equal(f.els.viewContent.children[0], shell, "retired addition cannot repaint");
  assert.equal(f.requests.length, count, "retired addition cannot refresh a new catalogue");
  assert.equal(f.calls.length, navigation, "retired addition cannot navigate to its playlist");
}

try {
  const createMusicViews = await importFactory();
  for (const kind of ["create", "create-with-track", "create-current", "save", "add", "add-current"]) {
    for (const transition of ["route", "same route", "selection", "source", "deactivate", "account pending", "account round trip"]) {
      for (const failure of [false, true]) await runCase(`${kind}: stale POST ${failure ? "failure" : "success"} after ${transition}`,
        () => assertRetiredAddition(createMusicViews, kind, transition, failure));
    }
    if (kind !== "create") for (const transition of ["close sheet", "reopen sheet"]) {
      for (const failure of [false, true]) await runCase(`${kind}: stale POST ${failure ? "failure" : "success"} after ${transition}`,
        () => assertRetiredAddition(createMusicViews, kind, transition, failure));
    }
    await runCase(`${kind}: current POST applies, refreshes catalogue and keeps playback`, async () => {
      const f = fixture(createMusicViews), { request, pending } = await f.beginAddition(kind), queue = f.state.queue;
      request.resolve(writeResult(f)); await settle(); assert.equal(f.requests.length, 2);
      assert.equal(new URL(f.requests[1].url).pathname, "/api/music/playlists");
      f.requests[1].resolve({ playlists: [writeResult(f).playlist] }); await pending; await settle();
      assert.equal(f.state.current, f.current); assert.equal(f.state.playing, true);
      if (kind === "create" || kind === "save") {
        assert.equal(f.calls.length, 1); assert.equal(f.calls[0][1].mode, "playlist"); assert.equal(f.state.queue, queue);
      } else {
        assert.equal(f.calls.length, 0); assert.equal(f.state.playlistSheetOpen, false); assert.equal(f.state.playlistActionTrackId, "");
        assert.match(f.state.status, /已加入/);
        if (kind.startsWith("add")) assert.deepEqual(f.state.queue, [f.current]);
        else assert.equal(f.state.queue, queue);
      }
    });
    await runCase(`${kind}: current POST error is visible and retryable`, async () => {
      const f = fixture(createMusicViews), { request, pending } = await f.beginAddition(kind), snapshot = copy(f.state);
      request.reject(new Error("Current addition failure")); await assert.rejects(pending, /Current addition failure/); await settle();
      assert.equal(f.state.status, "Current addition failure"); assert.equal(f.els.viewMeta.textContent, "Current addition failure");
      assert.deepEqual(copy(f.state), { ...snapshot, status: "Current addition failure" }); assert.equal(f.calls.length, 0);
      const retry = await f.beginAddition(kind); retry.request.reject(new Error("Retry addition failure")); await assert.rejects(retry.pending, /Retry addition failure/);
    });
    for (const transition of ["route", "selection", "account round trip", ...(kind === "create" ? [] : ["reopen sheet"])]) {
      await runCase(`${kind}: POST acknowledgement followed by ${transition} during catalogue refresh`, async () => {
        const f = fixture(createMusicViews), { request, pending } = await f.beginAddition(kind);
        request.resolve(writeResult(f)); await settle(); const refresh = f.requests[1]; assert(refresh);
        await retireAddition(f, transition); const snapshot = copy(f.state), shell = f.els.viewContent.children[0], calls = f.calls.length;
        refresh.resolve({ playlists: [{ id: "retired-post-playlist" }] }); await pending; await settle();
        assert.deepEqual(copy(f.state), snapshot); assert.equal(f.els.viewContent.children[0], shell); assert.equal(f.calls.length, calls);
      });
    }
  }
  await runCase("save: changed queue retires automatic navigation after POST", () => assertRetiredAddition(createMusicViews, "save", "queue"));
  await runCase("add: newly queued songs survive the old addition response", () => assertRetiredAddition(createMusicViews, "add", "queue"));
  for (const kind of ["remove", "edit", "delete"]) {
    for (const transition of ["route", "other playlist", "same route", "source", "deactivate", "selection", "pending selection"]) {
      await runCase(`${kind}: late success after ${transition}`, () => assertRetired(createMusicViews, kind, transition));
    }
    await runCase(`${kind}: late failure after navigation`, () => assertRetired(createMusicViews, kind, "route", true));
    for (const transition of ["account pending", "account", "account round trip"]) {
      for (const failure of [false, true]) await runCase(`${kind}: account transition ${transition} late ${failure ? "failure" : "success"}`,
        () => assertRetired(createMusicViews, kind, transition, failure));
    }
    await runCase(`${kind}: current write applies and refreshes the current catalogue`, async () => {
      const f = fixture(createMusicViews), queue = f.state.queue, { request, pending } = await f.begin(kind);
      request.resolve(writeResult(f)); await settle(); assert.equal(f.requests.length, 2);
      assert.equal(new URL(f.requests[1].url).pathname, "/api/music/playlists");
      const result = writeResult(f);
      f.requests[1].resolve({ playlists: kind === "delete" ? [] : [result.playlist] }); await pending; await settle();
      assert.equal(f.state.current, f.current); assert.equal(f.state.playing, true);
      if (kind === "delete") {
        assert.equal(f.state.mode, "library"); assert.equal(f.state.playlistId, ""); assert.equal(f.calls.length, 1);
        assert.equal(f.calls[0][0], "music"); assert.equal(f.calls[0][1].mode, "library"); assert.equal(f.state.queue, queue);
      } else {
        assert.deepEqual(f.state.data.tracks, [f.current]); assert.deepEqual(f.state.queue, [f.current]);
        assert.equal(f.state.playlist.name, "Written fixture"); assert.equal(f.calls.length, 0);
      }
    });
    await runCase(`${kind}: navigation while refreshing prevents late UI and forced return`, async () => {
      const f = fixture(createMusicViews), { request, pending } = await f.begin(kind);
      request.resolve(writeResult(f)); await settle(); const refresh = f.requests[1]; assert(refresh);
      await f.renderRoute("library"); const snapshot = copy(f.state), shell = f.els.viewContent.children[0], calls = f.calls.length;
      refresh.resolve({ playlists: [{ id: "stale-playlist", name: "Stale fixture" }] }); await pending; await settle();
      assert.deepEqual(copy(f.state), snapshot); assert.equal(f.els.viewContent.children[0], shell); assert.equal(f.calls.length, calls);
    });
    await runCase(`${kind}: selecting a track while refreshing preserves its queue and route`, async () => {
      const f = fixture(createMusicViews), { request, pending } = await f.begin(kind);
      request.resolve(writeResult(f)); await settle(); const refresh = f.requests[1]; assert(refresh);
      await f.selectTrack(); const snapshot = copy(f.state), shell = f.els.viewContent.children[0], calls = f.calls.length;
      refresh.resolve({ playlists: [{ id: "stale-playlist" }] }); await pending; await settle();
      assert.deepEqual(copy(f.state), snapshot); assert.equal(f.els.viewContent.children[0], shell); assert.equal(f.calls.length, calls);
    });
    for (const failure of [false, true]) await runCase(`${kind}: account round trip during catalogue refresh late ${failure ? "failure" : "success"}`, async () => {
      const f = fixture(createMusicViews), { request, pending } = await f.begin(kind);
      request.resolve(writeResult(f)); await settle(); const refresh = f.requests[1]; assert(refresh);
      f.switchAccount("account round trip"); const snapshot = copy(f.state), count = f.requests.length, calls = f.calls.length;
      if (failure) refresh.reject(new Error("Retired account catalogue failure"));
      else refresh.resolve({ playlists: [{ id: "retired-account-playlist" }] });
      await assert.doesNotReject(pending); await settle();
      assert.deepEqual(copy(f.state), snapshot); assert.equal(f.els.viewContent.children.length, 0);
      assert.equal(f.requests.length, count); assert.equal(f.calls.length, calls); assert.equal(request.signal.aborted, false);
    });
    await runCase(`${kind}: current failure preserves the list and remains retryable`, async () => {
      const f = fixture(createMusicViews), snapshot = copy(f.state), { request, pending } = await f.begin(kind);
      request.reject(new Error("Fixture write failure")); await assert.rejects(pending, /Fixture write failure/); await settle();
      assert.equal(f.state.status, "Fixture write failure");
      assert.equal(f.els.viewMeta.textContent, "Fixture write failure", "the current failure is visible");
      assert.deepEqual(copy(f.state), { ...snapshot, status: "Fixture write failure" }); assert.equal(f.calls.length, 0);
      const retry = await f.begin(kind); retry.request.reject(new Error("Retry fixture failure"));
      await assert.rejects(retry.pending, /Retry fixture failure/);
    });
  }
  for (const kind of ["remove", "edit"]) await runCase(`${kind}: queue changes while writing preserve newly queued songs`, async () => {
    const f = fixture(createMusicViews), { request, pending } = await f.begin(kind);
    f.audit.appendTrackToQueue({ id: "queued-after-write", title: "Newly queued fixture" });
    const queue = f.state.queue; request.resolve(writeResult(f)); await settle();
    f.requests[1].resolve({ playlists: [writeResult(f).playlist] }); await pending; await settle();
    assert.equal(f.state.queue, queue); assert(queue.some(track => track.id === "queued-after-write"));
    assert.deepEqual(f.state.data.tracks, [f.current], "current list still reflects the acknowledged write");
  });
  await runCase("older same-page acknowledgement cannot overwrite a newer playlist operation", async () => {
    const f = fixture(createMusicViews), old = await f.begin("edit"), current = await f.begin("remove");
    old.request.resolve(writeResult(f)); await old.pending; await settle(); assert.equal(f.requests.length, 2);
    current.request.resolve(writeResult(f)); await settle(); assert.equal(f.requests.length, 3);
    f.requests[2].resolve({ playlists: [writeResult(f).playlist] }); await current.pending;
    assert.equal(f.state.status, "已移出歌单"); assert.deepEqual(f.state.queue, [f.current]);
  });
  await runCase("cancelled confirmation and prompt start no write", async () => {
    for (const kind of ["remove", "edit", "delete"]) {
      const f = fixture(createMusicViews), snapshot = copy(f.state); window.confirm = () => false; window.prompt = () => null;
      if (kind === "remove") await f.audit.removeTrackFromCurrentPlaylist(f.other.id);
      if (kind === "edit") await f.audit.editCurrentPlaylist();
      if (kind === "delete") await f.audit.deleteCurrentPlaylist();
      assert.equal(f.requests.length, 0); assert.deepEqual(copy(f.state), snapshot);
    }
  });
  await runCase("negative control: missing write acknowledgement guard revives an old playlist", async () => {
    const source = viewSource.replaceAll("    if (!operation.isCurrent()) return;\n", ""); assert.notEqual(source, viewSource);
    const mutant = await importFactory(source);
    await assert.rejects(() => assertRetired(mutant, "edit", "other playlist"), /retired edit after other playlist/);
  });
  await runCase("negative control: ignoring a new queue loses its newly queued song", async () => {
    const source = viewSource.replaceAll("canReplaceQueue: () => state.queue === queue", "canReplaceQueue: () => true"); assert.notEqual(source, viewSource);
    const mutant = await importFactory(source), f = fixture(mutant), { request, pending } = await f.begin("remove");
    f.audit.appendTrackToQueue({ id: "queued-after-write", title: "Newest fixture" }); const queue = f.state.queue;
    request.resolve(writeResult(f)); await settle(); f.requests[1].resolve({ playlists: [] }); await pending;
    assert.throws(() => assert.equal(f.state.queue, queue), /reference-equal/);
  });
  await runCase("negative control: missing account revision guard lets an old failure revive content", async () => {
    const mutant = viewSource.replaceAll("&& isAccountOwnerCurrent(accountOwner)", ""); assert.notEqual(mutant, viewSource);
    const createMutant = await importFactory(mutant);
    await assert.rejects(() => assertRetired(createMutant, "edit", "account round trip"), /账号已切换/);
  });
  await runCase("negative control: unguarded POST refreshes a newer route", async () => {
    const source = viewSource.replaceAll("if (!operation.isCurrent()) return null;", "").replaceAll("if (!operation.isCurrent()) return;", "");
    assert.notEqual(source, viewSource); const mutant = await importFactory(source);
    await assert.rejects(() => assertRetiredAddition(mutant, "create", "route"), /retired create after route/);
  });
  await runCase("negative control: ignoring sheet identity lets POST close its reopened replacement", async () => {
    const source = viewSource.replace("&& surface.isConnected && els.viewContent?.contains(surface)", "");
    assert.notEqual(source, viewSource); const mutant = await importFactory(source);
    await assert.rejects(() => assertRetiredAddition(mutant, "add", "reopen sheet"), /retired addition cannot refresh a new catalogue/);
  });
  console.log(`Android music playlist request verification passed (${cases} scenarios, including 5 negative controls; ${fixtureId} controlled fixtures).`);
} catch (error) {
  console.error(`${selectedCase || "fixture setup"}: ${error.name}: ${error.message}`); process.exitCode = 1;
} finally {
  for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
}
