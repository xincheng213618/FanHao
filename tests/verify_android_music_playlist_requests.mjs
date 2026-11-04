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
// The preceding local-removal kernel retained all surviving elements but
// validated and relabelled every later DOM row. Keep that actual algorithm for
// the DOM-work negative control; restoring a full-page render would miss it.
const previousQueueRemovalHelper = [
  "  function removeMountedQueueTrack(previousQueue, index) {",
  "    const mounted = mountedQueueList, queue = state.queue;",
  "    // Without a selected song the player previews queue[0]. A changed preview",
  "    // needs the existing full render to rebind its track-specific actions.",
  "    if (!mounted?.isCurrent() || mounted.queue !== previousQueue || (!state.current && index === 0)",
  "      || queue.length !== previousQueue.length - 1 || mounted.list.children.length !== previousQueue.length) return false;",
  "    for (let position = index; position < previousQueue.length; position++) {",
  "      const row = mounted.list.children[position];",
  "      if (!row?.classList.contains(\"music-mobile-queue-item\") || row.dataset.trackId !== String(previousQueue[position]?.id || \"\")",
  "        || Number(row.dataset.trackIndex) !== position || (position > index && queue[position - 1] !== previousQueue[position])) return false;",
  "    }",
  "    const removed = mounted.list.children[index], focused = document.activeElement;",
  "    const restoreFocus = removed.contains(focused);",
  "    const action = focused?.classList.contains(\"music-mobile-queue-action\") ? focused.getAttribute(\"aria-label\") : \"\";",
  "    const top = mounted.list.scrollTop;",
  "    removed.remove();",
  "    mounted.queue = queue;",
  "    if (!queue.length) mounted.list.append(messageBox(\"队列里还没有歌曲\"));",
  "    for (let position = index; position < queue.length; position++) {",
  "      const row = mounted.list.children[position], number = row.querySelector(\".music-mobile-queue-index\");",
  "      row.dataset.trackIndex = String(position);",
  "      if (number && !number.querySelector(\".music-mobile-playing-bars\")) number.textContent = String(position + 1).padStart(2, \"0\");",
  "    }",
  "    for (const row of new Set(queue.length ? [mounted.list.children[0], mounted.list.children[queue.length - 1]] : [])) {",
  "      if (!row) continue;",
  "      const position = Number(row.dataset.trackIndex);",
  "      for (const [label, disabled] of [[\"上移\", position === 0], [\"下移\", position === queue.length - 1]]) {",
  "        const button = row.querySelector(`[aria-label=\"${label}\"]`);",
  "        if (button) { button.disabled = disabled; button.classList.toggle(\"disabled\", disabled); }",
  "      }",
  "    }",
  "    mounted.count.textContent = `${formatNumber(queue.length)} 首`;",
  "    mounted.save.disabled = !queue.length;",
  "    mounted.manage.disabled = queue.length <= 1;",
  "    mounted.clear.disabled = queueRemovableCount() <= 0;",
  "    const toggle = els.viewContent?.querySelector(\".music-mobile-full-queue\");",
  "    if (toggle) toggle.disabled = !queue.length;",
  "    if (restoreFocus) {",
  "      const row = mounted.list.children[Math.min(index, queue.length - 1)];",
  "      const requested = action ? row?.querySelector(`[aria-label=\"${action}\"]`) : null;",
  "      const fallback = action ? [...(row?.querySelectorAll(\".music-mobile-queue-action\") || [])].find(button => !button.disabled) : null;",
  "      (requested && !requested.disabled ? requested : fallback || row || mounted.close).focus({ preventScroll: true });",
  "    }",
  "    mounted.list.scrollTop = top;",
  "    return true;",
  "  }"
].join("\n");
const copy = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
let cases = 0, selectedCase = "", fixtureId = 0;

async function importFactory(source = viewSource) {
  const hook = "  installLifecycle();";
  assert.equal(source.split(hook).length, 2);
  const instrumented = source.replace(hook, `
  globalThis.__musicPlaylistFixture = { state, renderShell, openTrack, appendTrackToQueue, moveQueueTrack, removeTrackFromQueue,
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
  const originalSourceUrl = `http://music-playlist-${++fixtureId}.fixture.invalid:29998`;
  let sourceUrl = originalSourceUrl, timerId = 0;
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
    restoreSource() { sourceUrl = originalSourceUrl; },
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

function queueOrderFixture(createMusicViews) {
  const f = fixture(createMusicViews);
  f.state.queue = [f.current, f.other, { id: "third-fixture", title: "Third fixture" }];
  return f;
}

const queueIds = f => f.state.queue.map(track => track.id);

async function assertCoalescedQueueOrder(createMusicViews) {
  const f = queueOrderFixture(createMusicViews);
  f.audit.moveQueueTrack(f.other.id, -1);
  for (let index = 0; index < 101; index++) f.audit.moveQueueTrack("third-fixture", index % 2 ? 1 : -1);
  await settle();
  assert.equal(f.requests.length, 1, "rapid queue adjustments keep one physical write in flight");
  const expected = queueIds(f);
  f.requests[0].resolve(writeResult(f)); await settle();
  assert.equal(f.requests.length, 2, "only the latest unsent full order is persisted");
  assert.deepEqual(JSON.parse(f.requests[1].options.body).trackIds, expected);
  f.requests[1].resolve(writeResult(f)); await settle();
  assert.deepEqual(queueIds(f), expected); assert.equal(f.state.status, "歌单顺序已保存");
  assert.equal(f.state.current, f.current); assert.equal(f.state.playing, true);
}

async function assertRetiredQueueOrder(createMusicViews, transition, failure) {
  const f = queueOrderFixture(createMusicViews);
  f.audit.moveQueueTrack(f.other.id, -1); await settle();
  const request = f.requests[0];
  if (transition === "queue") f.audit.appendTrackToQueue({ id: "new-member", title: "New member" });
  else await retireAddition(f, transition);
  const snapshot = copy(f.state), shell = f.els.viewContent.children[0], count = f.requests.length;
  assert.equal(request.signal.aborted, false, "an accepted order PUT survives UI transitions");
  if (failure) request.reject(new Error("Retired queue order failure"));
  else request.resolve(writeResult(f));
  await settle();
  assert.deepEqual(copy(f.state), snapshot, `retired order after ${transition} cannot replace state`);
  assert.equal(f.els.viewContent.children[0], shell, "retired order cannot repaint");
  assert.equal(f.requests.length, count, "retired order must not refresh another catalogue");
}

async function assertQueueOrderSurfaceChange(createMusicViews, control, failure) {
  const f = queueOrderFixture(createMusicViews), original = queueIds(f);
  Object.assign(f.state, { fullscreen: true, queueOpen: true, queueManageOpen: true, repeat: "all" });
  f.audit.renderShell(); f.audit.moveQueueTrack(f.other.id, -1); await settle();
  const ordered = queueIds(f), shell = f.els.viewContent.children[0];
  const button = f.document.querySelector(control === "repeat" ? ".music-mobile-queue-mode"
    : '.music-mobile-queue-tool[aria-label="完成整理"]');
  assert(button, "the real queue control must be mounted"); button.click();
  assert.notEqual(f.els.viewContent.children[0], shell, "the real handler repaints the shell");
  const repeat = f.state.repeat, managing = f.state.queueManageOpen;
  if (failure) f.requests[0].reject(new Error("Surface order failure")); else f.requests[0].resolve(writeResult(f));
  await settle();
  assert.deepEqual(queueIds(f), failure ? original : ordered, "a surface repaint does not retire queue ordering");
  assert.equal(f.state.status, failure ? "Surface order failure" : "歌单顺序已保存");
  assert.equal(f.state.repeat, repeat); assert.equal(f.state.queueManageOpen, managing);
  assert.equal(f.state.fullscreen, true); assert.equal(f.state.queueOpen, true);
}

function mountedQueueFixture(createMusicViews, count = 300, { currentIndex = 0, managing = true } = {}) {
  const f = queueOrderFixture(createMusicViews);
  f.state.queue = [f.current, f.other, ...Array.from({ length: Math.max(0, count - 2) }, (_, index) => ({ id: `queue-${index}`, title: `Queue ${index}` }))].slice(0, count);
  Object.assign(f.state, { fullscreen: true, queueOpen: true, queueManageOpen: managing,
    current: currentIndex === null ? null : f.state.queue[currentIndex] }); f.audit.renderShell();
  const list = f.document.querySelector(".music-mobile-full-player .music-mobile-queue-list"); list.scrollTop = 137;
  const createElement = f.document.createElement;
  let created = 0;
  f.document.createElement = (...args) => { created++; return createElement(...args); };
  return { ...f, list, created: () => created,
    shell: f.els.viewContent.children[0], full: f.document.querySelector(".music-mobile-full-player"),
    mini: f.document.querySelector(".music-mobile-mini-player") };
}

function assertQueueMounted(f) {
  assert.equal(f.els.viewContent.children[0], f.shell);
  assert.equal(f.document.querySelector(".music-mobile-full-player"), f.full);
  assert.equal(f.document.querySelector(".music-mobile-mini-player"), f.mini);
  assert.equal(f.document.querySelector(".music-mobile-full-player .music-mobile-queue-list"), f.list);
  assert.equal(f.list.scrollTop, 137);
}

async function assertLocalQueueMove(createMusicViews, count) {
  const f = mountedQueueFixture(createMusicViews, count); f.state.mode = "library";
  const original = [...f.list.children], up = original[1].querySelector('[aria-label="上移"]');
  up.focus(); up.click(); await settle();
  assertQueueMounted(f);
  assert.equal(original.filter(row => !row.isConnected).length, 2, "an adjacent move retires only two queue rows");
  assert(f.created() <= 32, "adjacent movement has a constant element-creation budget");
  assert.equal(f.document.activeElement, f.list.children[0].querySelector('[aria-label="下移"]'), "boundary focus follows the moved song to the enabled direction");
  assert.equal(f.list.children[0].dataset.trackId, f.other.id); assert.equal(f.list.children[1].dataset.trackId, f.current.id);
  assert.equal(f.list.children[0].querySelector('[aria-label="上移"]').disabled, true);
  assert.equal(f.list.children[1].querySelector('[aria-label="上移"]').disabled, false);
  const queue = f.state.queue; up.click(); original[1].click(); await settle();
  assert.equal(f.state.queue, queue, "retired row and child controls cannot operate the current queue");
  const later = original[6].querySelector('[aria-label="上移"]'); later.focus(); later.click(); await settle();
  assert.notEqual(f.state.queue, queue, "an unaffected row keeps working through the shared mounted-list owner");
  assert.equal(f.state.queue[5].id, original[6].dataset.trackId);
  assertQueueMounted(f); assert.equal(f.requests.length, 0);
}

async function assertLocalQueueRemoval(createMusicViews, count, removes) {
  const f = mountedQueueFixture(createMusicViews, count); f.state.mode = "library";
  const original = [...f.list.children], removed = new Set();
  const playing = original[0].querySelector(".music-mobile-playing-bars");
  for (let index = 0; index < removes; index++) {
    const row = f.list.children[1], button = row.querySelector('[aria-label="移出队列"]');
    removed.add(row); button.focus(); button.click(); await settle();
    assertQueueMounted(f); assert.equal(f.document.activeElement, f.list.children[1].querySelector('[aria-label="移出队列"]'));
    assert.equal(f.state.queue.length, count - index - 1);
    assert.equal(f.document.querySelector(".music-mobile-queue-heading small").textContent, `${count - index - 1} 首`);
    const queue = f.state.queue; button.click(); row.click(); await settle();
    assert.equal(f.state.queue, queue, "the removed row and control cannot remove another song or start playback");
  }
  assert.equal(f.created(), 0, "removing a queue member creates no replacement elements");
  assert(original.filter(row => !removed.has(row)).every(row => row.isConnected), "all surviving rows stay mounted");
  assert.equal(f.list.children[0].querySelector(".music-mobile-playing-bars"), playing);
  for (const [index, row] of [...f.list.children].entries()) {
    assert.equal(row.dataset.trackId, f.state.queue[index].id);
    assert.equal(row.dataset.trackIndex, undefined, "queue positions are derived rather than rewritten after removal");
    const number = row.querySelector(".music-mobile-queue-index");
    assert.equal(number.getAttribute("aria-hidden"), "true", "visual counters and playing bars do not repeat the row's accessible name");
    if (index) assert.equal(number.textContent, "", "the browser CSS counter owns visual numbering");
  }
  const shifted = original[removes + 2], oldPosition = f.state.queue.findIndex(track => track.id === shifted.dataset.trackId);
  shifted.querySelector('[aria-label="上移"]').click(); await settle();
  assert.equal(f.state.queue[oldPosition - 1].id, shifted.dataset.trackId, "surviving shifted rows operate at their current position");
  assertQueueMounted(f); assert.equal(f.requests.length, 0);
}

async function measureQueueRemovalDomWork(createMusicViews, count, removes) {
  const f = mountedQueueFixture(createMusicViews, count); f.state.mode = "library";
  const calls = { listReads: 0, listWrites: 0, rowQueries: 0, rowIdentityReads: 0, indexWrites: 0, numberWrites: 0 };
  let tracking = false, children = f.list.children;
  const originals = [...children];
  Object.defineProperty(f.list, "children", { configurable: true,
    get() { if (tracking) calls.listReads++; return children; },
    set(value) { if (tracking) calls.listWrites++; children = value; } });
  for (const row of originals) {
    const data = row.dataset;
    row.dataset = new Proxy(data, {
      get(target, key) { if (tracking && key === "trackId") calls.rowIdentityReads++; return Reflect.get(target, key); },
      set(target, key, value) { if (tracking && key === "trackIndex") calls.indexWrites++; return Reflect.set(target, key, value); }
    });
    // Count production calls on a row, not this DOM double's recursive selector
    // engine (native querySelector does not call descendants' JS methods).
    const query = row.querySelector;
    row.querySelector = function(...args) { if (tracking) calls.rowQueries++; return query.apply(this, args); };
    const number = row.querySelector(".music-mobile-queue-index");
    const text = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(number), "textContent");
    Object.defineProperty(number, "textContent", { configurable: true,
      get() { return text.get.call(this); },
      set(value) { if (tracking) calls.numberWrites++; text.set.call(this, value); } });
  }
  for (let index = 0; index < removes; index++) {
    const button = f.list.children[1].querySelector('[aria-label="移出队列"]');
    button.focus(); tracking = true;
    try { button.click(); await settle(); } finally { tracking = false; }
  }
  assertQueueMounted(f); assert.equal(f.created(), 0, "both current and preceding local kernels create no elements");
  assert.equal(f.state.queue.length, count - removes);
  assert.equal(originals.filter(row => !row.isConnected).length, removes, "the measured path retains surviving rows");
  return calls;
}

async function assertQueueRemovalDomBudget(createMusicViews, count, removes) {
  const calls = await measureQueueRemovalDomWork(createMusicViews, count, removes);
  assert.equal(calls.indexWrites + calls.numberWrites, 0, "removing a song performs no tail index/number DOM writes");
  assert(calls.rowIdentityReads <= removes * 4, "removal validates a constant number of row identities");
  assert(calls.rowQueries <= removes * 20 && calls.listReads <= removes * 40, "removal DOM reads stay independent of queue length: " + JSON.stringify(calls));
  return calls;
}

try {
  const createMusicViews = await importFactory();
  await runCase("queue order: rapid adjustments coalesce writes", () => assertCoalescedQueueOrder(createMusicViews));
  for (const count of [300, 1000]) await runCase(`queue order: ${count} mounted songs move with constant DOM work`,
    () => assertLocalQueueMove(createMusicViews, count));
  for (const count of [300, 1000]) for (const removes of [1, 10]) await runCase(`queue removal: ${count} songs ${removes} removals retain every surviving row`,
    () => assertLocalQueueRemoval(createMusicViews, count, removes));
  const removalDomWork = [];
  for (const count of [300, 1000]) for (const removes of [1, 10]) await runCase(`queue removal: ${count} songs ${removes} removals have constant DOM reads and writes`, async () => {
    removalDomWork.push({ count, removes, ...await assertQueueRemovalDomBudget(createMusicViews, count, removes) });
  });
  console.log(JSON.stringify({ queueRemovalDomWork: removalDomWork }));
  await runCase("queue removal: first and last boundaries and toolbar state update without replacing rows", async () => {
    const f = mountedQueueFixture(createMusicViews, 3, { currentIndex: 1 }); f.state.mode = "library";
    const [first, current, last] = [...f.list.children];
    first.querySelector('[aria-label="移出队列"]').click(); await settle(); assertQueueMounted(f);
    assert.equal(f.list.children[0], current); assert.equal(current.querySelector('[aria-label="上移"]').disabled, true);
    assert.equal(current.querySelector('[aria-label="移出队列"]').disabled, true);
    const queue = f.state.queue; f.audit.removeTrackFromQueue(f.state.current.id); current.querySelector('[aria-label="移出队列"]').click();
    assert.equal(f.state.queue, queue, "the actual operation also protects the current song");
    last.querySelector('[aria-label="移出队列"]').focus(); last.querySelector('[aria-label="移出队列"]').click(); await settle();
    assertQueueMounted(f); assert.deepEqual([...f.list.children], [current]);
    assert.equal(current.querySelector('[aria-label="下移"]').disabled, true);
    assert.equal(f.document.querySelector('[aria-label="完成整理"]').disabled, true);
    assert.equal(f.document.querySelector('[aria-label="清空其他歌曲"]').disabled, true);
    assert.equal(f.document.querySelector('[aria-label="存为歌单"]').disabled, false);
    assert.equal(f.document.activeElement, current, "removing the last removable member leaves focus on the protected current row");
    assert.equal(f.created(), 0);
  });
  for (const managing of [false, true]) await runCase(`queue removal: ${managing ? "managed" : "normal"} mode retains a later unaffected focus`, async () => {
    const f = mountedQueueFixture(createMusicViews, 20, { managing });
    const focused = f.list.children[10].querySelector('[aria-label="移出队列"]'); focused.focus();
    f.audit.removeTrackFromQueue(f.state.queue[3].id); await settle();
    assertQueueMounted(f); assert.equal(f.document.activeElement, focused); assert.equal(f.list.children[9], focused.closest(".music-mobile-queue-item"));
    assert.equal(f.created(), 0); assert.equal(f.requests.length, 0);
  });
  for (const transition of ["source", "account pending", "deactivate"]) await runCase(`queue removal: ${transition} retires old row actions`, async () => {
    const f = mountedQueueFixture(createMusicViews), row = f.list.children[2], button = row.querySelector('[aria-label="移出队列"]');
    if (transition === "source") f.setSource(); else if (transition === "deactivate") f.music.deactivate(); else f.switchAccount(transition);
    const queue = f.state.queue; button.click(); row.click(); await settle(); assert.equal(f.state.queue, queue); assert.equal(f.requests.length, 0);
  });
  await runCase("queue removal: an unselected preview change rebinds player actions through the existing full render", async () => {
    const f = mountedQueueFixture(createMusicViews, 3, { currentIndex: null }), next = f.state.queue[1];
    const row = f.list.children[0], button = row.querySelector('[aria-label="移出队列"]');
    button.click(); await settle();
    assert.equal(f.state.current, null); assert.equal(f.state.queue[0], next);
    assert.notEqual(f.document.querySelector(".music-mobile-full-player"), f.full);
    assert.equal(f.document.querySelector(".music-mobile-full-track-info strong").textContent, next.title);
    const queue = f.state.queue; row.click(); button.click(); await settle(); assert.equal(f.state.queue, queue); assert.equal(f.requests.length, 0);
  });
  await runCase("queue removal: emptying the queue preserves an outside current song and focuses the sheet close", async () => {
    const f = mountedQueueFixture(createMusicViews, 1);
    f.state.current = f.other; f.audit.renderShell();
    const list = f.document.querySelector(".music-mobile-full-player .music-mobile-queue-list");
    const full = f.document.querySelector(".music-mobile-full-player"), mini = f.document.querySelector(".music-mobile-mini-player"), before = f.created();
    const remove = list.children[0].querySelector('[aria-label="移出队列"]'); remove.focus(); remove.click(); await settle();
    assert.equal(f.state.current, f.other); assert.deepEqual(f.state.queue, []);
    assert.equal(f.document.querySelector(".music-mobile-full-player"), full); assert.equal(f.document.querySelector(".music-mobile-mini-player"), mini);
    assert.equal(f.document.querySelector(".music-mobile-full-player .music-mobile-queue-list"), list);
    assert.equal(list.textContent, "队列里还没有歌曲"); assert.equal(f.created() - before, 1, "only the empty-state element is created");
    assert.equal(f.document.activeElement, f.document.querySelector('[aria-label="关闭队列"]'));
    for (const label of ["存为歌单", "完成整理", "清空其他歌曲"]) assert.equal(f.document.querySelector(`[aria-label="${label}"]`).disabled, true);
    assert.equal(f.document.querySelector(".music-mobile-full-queue").disabled, true); assert.equal(f.requests.length, 0);
  });
  await runCase("queue order: acknowledgement preserves the mounted player and updates visible playlist metadata", async () => {
    const f = mountedQueueFixture(createMusicViews);
    f.list.children[1].querySelector('[aria-label="上移"]').click(); await settle();
    const before = f.created(), rows = [...f.list.children], focused = f.list.children[4].querySelector('[aria-label="上移"]');
    focused.focus();
    f.requests[0].resolve({ playlist: { ...f.playlist, name: "Acknowledged name", description: "Acknowledged description", trackCount: 300 } });
    await settle(); assertQueueMounted(f); assert.deepEqual([...f.list.children], rows);
    assert.equal(f.created(), before, "an acknowledgement creates no player, queue or metadata elements");
    assert.equal(f.document.activeElement, focused, "an acknowledgement cannot reclaim focus");
    assert.match(f.document.querySelector(".music-mobile-playlist-identity").textContent, /Acknowledged name.*300.*Acknowledged description/);
    assert.equal(f.document.querySelector(".music-mobile-queue-status").textContent, "歌单顺序已保存");
  });
  await runCase("queue order: current failed movement rolls back locally and preserves a later focus", async () => {
    const f = mountedQueueFixture(createMusicViews), original = queueIds(f);
    f.list.children[1].querySelector('[aria-label="上移"]').click(); await settle();
    const rows = [...f.list.children], focused = rows[5].querySelector('[aria-label="上移"]'); focused.focus();
    f.requests[0].reject(new Error("Controlled queue save failure")); await settle();
    assert.deepEqual(queueIds(f), original); assertQueueMounted(f);
    assert.equal(rows.filter(row => !row.isConnected).length, 2);
    assert.equal(f.document.activeElement, focused, "rollback leaves an unaffected user's new focus alone");
    assert.equal(f.document.querySelector(".music-mobile-queue-status").textContent, "Controlled queue save failure");
  });
  await runCase("queue order: child keyboard events cannot activate the surrounding play row", async () => {
    const f = mountedQueueFixture(createMusicViews);
    const row = f.list.children[1], child = row.querySelector('[aria-label="上移"]');
    for (const key of ["Enter", " "]) {
      const event = { type: "keydown", target: child, key, bubbles: true, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
      child.dispatchEvent(event); assert.equal(event.defaultPrevented, false, "the child button retains native keyboard activation");
    }
    assert.equal(f.requests.length, 0); assert.equal(f.state.queueOpen, true); assert.equal(f.state.current, f.current);
  });
  for (const control of ["repeat", "finish managing"]) for (const failure of [false, true]) {
    await runCase(`queue order: ${control} preserves current ${failure ? "failure rollback" : "acknowledgement"}`,
      () => assertQueueOrderSurfaceChange(createMusicViews, control, failure));
  }
  await runCase("queue order: a failed earlier order cannot roll back a later successful order", async () => {
    const f = queueOrderFixture(createMusicViews);
    f.audit.moveQueueTrack(f.other.id, -1); f.audit.moveQueueTrack("third-fixture", -1); await settle();
    const latestQueue = f.state.queue;
    f.requests[0].reject(new Error("Earlier order failure")); await settle();
    assert.equal(f.state.queue, latestQueue); assert.equal(f.requests.length, 2);
    f.requests[1].resolve(writeResult(f)); await settle();
    assert.equal(f.state.queue, latestQueue); assert.equal(f.state.status, "歌单顺序已保存");
  });
  for (const firstSucceeds of [false, true]) await runCase(`queue order: failed latest order restores ${firstSucceeds ? "confirmed" : "initial"} ordering and current members`, async () => {
    const f = queueOrderFixture(createMusicViews), added = { id: "added-member", title: "Added fixture" };
    f.audit.moveQueueTrack(f.other.id, -1); await settle();
    f.audit.appendTrackToQueue(added);
    // Keep a new member between old members; rollback must preserve its slot.
    const member = f.state.queue.pop(); f.state.queue.splice(1, 0, member);
    f.audit.moveQueueTrack("third-fixture", -1); await settle();
    const latestObjects = new Map(f.state.queue.map(track => [track.id, track]));
    latestObjects.get(f.other.id).title = "Updated after reordering";
    assert.equal(f.requests.length, 1);
    if (firstSucceeds) f.requests[0].resolve(writeResult(f)); else f.requests[0].reject(new Error("First order failure"));
    await settle(); assert.equal(f.requests.length, 2);
    f.requests[1].reject(new Error("Latest order failure")); await settle();
    assert.deepEqual(queueIds(f), firstSucceeds
      ? [f.other.id, added.id, f.current.id, "third-fixture"]
      : [f.current.id, added.id, f.other.id, "third-fixture"]);
    for (const track of f.state.queue) assert.equal(track, latestObjects.get(track.id), "rollback keeps live objects");
    assert.equal(f.state.status, "Latest order failure"); assert.equal(f.els.viewMeta.textContent, "Latest order failure");
    f.audit.moveQueueTrack("third-fixture", -1); await settle(); assert.equal(f.requests.length, 3, "failure releases the write slot for retry");
    f.requests[2].resolve(writeResult(f)); await settle(); assert.equal(f.state.status, "歌单顺序已保存");
  });
  for (const transition of ["route", "same route", "selection", "source", "deactivate", "account pending", "account", "account round trip", "queue"]) {
    for (const failure of [false, true]) await runCase(`queue order: ${transition} retires late ${failure ? "failure" : "success"}`,
      () => assertRetiredQueueOrder(createMusicViews, transition, failure));
  }
  await runCase("queue order: a pending old-account adjustment is never sent using the new account", async () => {
    const f = queueOrderFixture(createMusicViews);
    f.audit.moveQueueTrack(f.other.id, -1); f.audit.moveQueueTrack("third-fixture", -1); await settle();
    assert.equal(f.requests.length, 1); f.switchAccount("account round trip");
    const snapshot = copy(f.state); f.requests[0].resolve(writeResult(f)); await settle();
    assert.equal(f.requests.length, 1); assert.deepEqual(copy(f.state), snapshot);
    assert.equal(f.requests[0].signal.aborted, false);
  });
  await runCase("queue order: a source change cancels unsent adjustments and preserves an accepted PUT", async () => {
    const f = queueOrderFixture(createMusicViews);
    f.audit.moveQueueTrack(f.other.id, -1); f.audit.moveQueueTrack("third-fixture", -1); await settle();
    f.setSource(); const snapshot = copy(f.state);
    f.requests[0].resolve(writeResult(f)); await settle(); assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].signal.aborted, false); assert.deepEqual(copy(f.state), snapshot);
  });
  await runCase("queue order: returning to the original source does not revive a retired pending order", async () => {
    const f = queueOrderFixture(createMusicViews);
    f.audit.moveQueueTrack(f.other.id, -1); f.audit.moveQueueTrack("third-fixture", -1); await settle();
    f.setSource(); await f.renderRoute("playlist", f.playlist.id);
    f.restoreSource(); await f.renderRoute("playlist", f.playlist.id);
    const snapshot = copy(f.state), count = f.requests.length;
    f.requests[0].resolve(writeResult(f)); await settle(); assert.equal(f.requests.length, count);
    assert.deepEqual(copy(f.state), snapshot); assert.equal(f.requests[0].signal.aborted, false);
  });
  await runCase("queue order: distinct playlist capacity is bounded and released", async () => {
    const f = queueOrderFixture(createMusicViews);
    for (let index = 0; index < 9; index++) {
      f.state.playlistId = `bounded-${index}`; f.state.queue = [f.current, f.other];
      f.audit.moveQueueTrack(f.other.id, -1); await settle();
    }
    assert.equal(f.requests.length, 8); assert.deepEqual(queueIds(f), [f.current.id, f.other.id]);
    assert.match(f.state.status, /繁忙/);
    f.requests[0].resolve(writeResult(f)); await settle();
    f.audit.moveQueueTrack(f.other.id, -1); await settle(); assert.equal(f.requests.length, 9);
    for (const request of f.requests.slice(1)) request.resolve(writeResult(f)); await settle();
    assert.equal(f.state.status, "歌单顺序已保存");
  });
  await runCase("queue order: a local non-playlist queue is reordered without a write", async () => {
    const f = queueOrderFixture(createMusicViews); f.state.mode = "library";
    f.audit.moveQueueTrack(f.other.id, -1); await settle();
    assert.deepEqual(queueIds(f), [f.other.id, f.current.id, "third-fixture"]); assert.equal(f.requests.length, 0);
  });
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
  await runCase("negative control: parallel queue orders exceed the bounded write budget", async () => {
    const source = viewSource.replace("if (writes.active) {", "if (false) {"); assert.notEqual(source, viewSource);
    await assert.rejects(() => importFactory(source).then(assertCoalescedQueueOrder), /one physical write in flight/);
  });
  await runCase("negative control: unguarded queue acknowledgement repaints a different source", async () => {
    const source = viewSource.replace("if (!data || !request.isCurrent()) return data;", "if (!data) return data;");
    assert.notEqual(source, viewSource); const mutant = await importFactory(source);
    await assert.rejects(() => assertRetiredQueueOrder(mutant, "source", false), /retired order after source/);
  });
  await runCase("negative control: the preceding local removal still exceeds tail DOM budgets", async () => {
    const start = viewSource.indexOf("  function removeMountedQueueTrack(previousQueue, index) {");
    const end = viewSource.indexOf("\n  function clearQueueExceptCurrent()", start);
    assert(start >= 0 && end > start);
    const rowKey = '    row.dataset.trackId = String(track.id || "");\n    const mounted = mountedQueueList;';
    assert.equal(viewSource.split(rowKey).length, 2);
    // The preceding kernel validates its original data index before rewriting
    // it. Restore that initial field only for compatibility with the old kernel.
    const source = (viewSource.slice(0, start) + previousQueueRemovalHelper + "\n" + viewSource.slice(end))
      .replace(rowKey, rowKey.replace("\n", '\n    row.dataset.trackIndex = String(index);\n'));
    const mutant = await importFactory(source);
    const calls = await measureQueueRemovalDomWork(mutant, 1000, 1);
    assert.equal(calls.indexWrites, 998); assert.equal(calls.numberWrites, 998);
    console.log(JSON.stringify({ precedingLocalQueueRemovalDomWork: calls }));
    await assert.rejects(() => assertQueueRemovalDomBudget(mutant, 1000, 1), /no tail index\/number DOM writes/);
  });
  console.log(`Android music playlist request verification passed (${cases} scenarios, including 8 negative controls; ${fixtureId} controlled fixtures).`);
} catch (error) {
  console.error(`${selectedCase || "fixture setup"}: ${error.name}: ${error.message}`); process.exitCode = 1;
} finally {
  for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
}
