import assert from "node:assert/strict";
import test from "node:test";
import { createMusicActions } from "../public/modules/music/actions.js";
import { ensureMusicState } from "../public/modules/music/state.js";

// Real actions source with controlled API, player and browser globals only.
// This never opens a server, media file, database or browser profile.
function fixture(t, { mode = "library", saved = null } = {}) {
  const originals = new Map(["window", "document"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const preferences = new Map(saved ? [["fanhao.music.lastTrack", JSON.stringify(saved)]] : []);
  const timers = new Map();
  globalThis.window = {
    localStorage: { getItem: key => preferences.get(key) ?? null, setItem: (key, value) => preferences.set(key, value) },
    setTimeout(callback) { const id = timers.size + 1; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  globalThis.document = { querySelector() { return null; }, activeElement: null };
  const requests = [];
  const api = {};
  for (const method of ["getTracks", "getHome", "getArtists", "getAlbums", "getHistory", "getPlaylist", "getSmartPlaylist", "getReport", "getTrack", "getPlaylists", "getSmartPlaylists"]) {
    api[method] = (...args) => new Promise((resolve, reject) => {
      const signal = args.find(arg => arg instanceof AbortSignal);
      requests.push({ method, args, signal, resolve, reject });
    });
  }
  const progress = [];
  api.setProgress = async (...args) => progress.push(args);
  const state = { activeView: "music", music: { mode, playlistsLoadedAt: Date.now(), smartPlaylistsLoadedAt: Date.now() } };
  ensureMusicState(state);
  const audio = { src: "", currentTime: 12, duration: 180, paused: true };
  const loads = [];
  let plays = 0;
  const player = {
    getAudio: () => audio,
    load(track, autoplay) { loads.push({ track, autoplay }); audio.src = track.streamUrl || `/fixture/${track.id}`; audio.paused = !autoplay; },
    play() { plays += 1; audio.paused = false; }
  };
  const events = [];
  const view = new Proxy({}, { get: (_target, name) => (...args) => { events.push({ name, args }); return false; } });
  const routes = [];
  const router = { push: route => routes.push(["push", route]), replace: route => routes.push(["replace", route]), overrides: () => actions.musicRouteOverrides() };
  const errors = [];
  const actions = createMusicActions({ state, api, player, view, router, showError: error => errors.push(error) });
  return { actions, state, requests, loads, routes, events, audio, preferences, timers, progress, errors, get plays() { return plays; } };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const track = id => ({ id, title: id, streamUrl: `/fixture/${id}`, durationMs: 180000 });
const trackData = id => ({ track: track(id), lyrics: { lines: [{ text: id }] } });
const listData = (...ids) => ({ tracks: ids.map(track), total: ids.length, hasMore: false });

test("a delayed home load cannot restore the saved track over a newer selection", async t => {
  const f = fixture(t, { mode: "home", saved: { trackId: "saved", track: track("saved") } });
  const loading = f.actions.loadMusic();
  const opening = f.actions.openTrack("chosen", { openPage: true });
  const chosen = f.requests.find(request => request.method === "getTrack");
  f.requests.find(request => request.method === "getHome").resolve(listData("home"));
  await tick();
  assert.deepEqual(f.requests.filter(request => request.method === "getTrack").map(request => request.args[0]), ["chosen"], "saved-track restore must not supersede the foreground selection");
  chosen.resolve(trackData("chosen"));
  await Promise.all([loading, opening]);
  assert.equal(f.state.music.current.id, "chosen");
  assert.deepEqual(f.loads.map(load => load.track.id), ["chosen"]);
});

test("navigation cancels pending reads while keeping playback and progress writes", async t => {
  const f = fixture(t);
  const playing = f.actions.openTrack("playing");
  f.requests[0].resolve(trackData("playing"));
  await playing;
  f.actions.saveProgressSoon(null, { immediate: true });
  const queue = f.state.music.queue;
  const lyrics = f.state.music.lyrics;
  const current = f.state.music.current;
  const source = f.audio.src;
  const opening = f.actions.openTrack("old", { openPage: true });
  const loading = f.actions.loadMusic({ keepCurrent: true });
  const oldTrack = f.requests.find(request => request.method === "getTrack" && request.args[0] === "old");
  const oldList = f.requests.find(request => request.method === "getTracks");
  const token = f.actions.beginNavigation();
  assert.equal(oldTrack.signal.aborted, true);
  assert.equal(oldList.signal.aborted, true);
  assert.equal(f.actions.isNavigationCurrent(token), true);
  assert.equal(f.state.music.loading, false);
  assert.equal(f.state.music.openingTrackId, "");
  assert.equal(f.state.music.current, current);
  assert.equal(f.state.music.lyrics, lyrics);
  assert.equal(f.state.music.queue, queue);
  assert.equal(f.audio.src, source);
  assert.equal(f.audio.paused, false);
  oldTrack.resolve(trackData("old"));
  oldList.resolve(listData("obsolete"));
  await Promise.all([opening, loading]);
  assert.equal(f.state.music.current, current);
  assert.equal(f.state.music.data, null);
  assert.equal(f.state.music.trackPageOpen, false);
  assert.deepEqual(f.routes, []);
  for (const callback of f.timers.values()) callback();
  await tick();
  assert(f.progress.some(([id, value]) => id === "playing" && value.positionMs === 12000));
});

test("old list errors and side responses cannot replace a new pending list", async t => {
  const f = fixture(t);
  f.state.music.playlistsLoadedAt = 0;
  f.state.music.smartPlaylistsLoadedAt = 0;
  const old = f.actions.loadMusic({ keepCurrent: true });
  const oldRequests = [...f.requests];
  f.actions.beginNavigation();
  f.state.music.query = "new";
  const fresh = f.actions.loadMusic({ keepCurrent: true });
  const freshRequests = f.requests.slice(oldRequests.length);
  freshRequests.find(request => request.method === "getPlaylists").resolve({ playlists: [{ id: "new-list" }] });
  freshRequests.find(request => request.method === "getSmartPlaylists").resolve({ smartPlaylists: [{ id: "new-smart" }] });
  await tick();
  const status = f.state.music.status;
  const refreshes = f.events.filter(event => event.name === "refresh").length;
  oldRequests.find(request => request.method === "getPlaylists").resolve({ playlists: [{ id: "old-list" }] });
  oldRequests.find(request => request.method === "getSmartPlaylists").resolve({ smartPlaylists: [{ id: "old-smart" }] });
  oldRequests.find(request => request.method === "getTracks").reject(new Error("old-list-error"));
  await old;
  assert.equal(f.state.music.loading, true);
  assert.equal(f.state.music.status, status);
  assert.deepEqual(f.state.music.playlists.map(item => item.id), ["new-list"]);
  assert.deepEqual(f.state.music.smartPlaylists.map(item => item.id), ["new-smart"]);
  assert.equal(f.events.filter(event => event.name === "refresh").length, refreshes);
  freshRequests.find(request => request.method === "getTracks").resolve(listData("fresh"));
  await fresh;
  assert.equal(f.state.music.loading, false);
  assert.equal(f.state.music.data.tracks[0].id, "fresh");
  assert.equal(f.routes.length, 1);
});

test("direct side list loads have latest request ownership", async t => {
  const f = fixture(t);
  const old = f.actions.loadPlaylists();
  const fresh = f.actions.loadPlaylists();
  assert.equal(f.requests[0].signal.aborted, true);
  f.requests[1].resolve({ playlists: [{ id: "fresh" }] });
  assert.equal(await fresh, true);
  const loadedAt = f.state.music.playlistsLoadedAt;
  f.requests[0].resolve({ playlists: [{ id: "old" }] });
  assert.equal(await old, false);
  assert.deepEqual(f.state.music.playlists.map(item => item.id), ["fresh"]);
  assert.equal(f.state.music.playlistsLoadedAt, loadedAt);
});

test("a cancelled restore cannot overwrite the chosen track or clear its preference", async t => {
  const f = fixture(t, { mode: "home", saved: { trackId: "saved", track: track("saved") } });
  const loading = f.actions.loadMusic();
  f.requests.find(request => request.method === "getHome").resolve(listData("home"));
  await tick();
  const restore = f.requests.find(request => request.method === "getTrack" && request.args[0] === "saved");
  assert(restore);
  const chosen = f.actions.openTrackFromList(track("chosen"), [track("chosen"), track("next")], { openPage: true });
  assert.equal(restore.signal.aborted, true);
  const token = f.actions.beginNavigation();
  assert.equal(f.actions.isNavigationCurrent(token), true);
  const final = f.actions.openTrackFromList(track("final"), [track("final"), track("next")], { openPage: true });
  assert.equal(f.actions.isNavigationCurrent(token), true, "track selection must not revoke a page navigation token");
  f.requests.find(request => request.method === "getTrack" && request.args[0] === "final").resolve(trackData("final"));
  await final;
  const queue = f.state.music.queue;
  const lyrics = f.state.music.lyrics;
  const preference = f.preferences.get("fanhao.music.lastTrack");
  restore.reject(new Error("saved missing"));
  f.requests.find(request => request.method === "getTrack" && request.args[0] === "chosen").resolve(trackData("chosen"));
  await Promise.all([loading, chosen]);
  assert.equal(f.state.music.current.id, "final");
  assert.equal(f.state.music.queue, queue);
  assert.equal(f.state.music.lyrics, lyrics);
  assert.equal(f.preferences.get("fanhao.music.lastTrack"), preference);
  assert.deepEqual(f.loads.map(load => load.track.id), ["final"]);
});

test("initial home restoration still loads the saved track without autoplay", async t => {
  const f = fixture(t, { mode: "home", saved: { trackId: "saved", track: track("saved") } });
  const loading = f.actions.loadMusic({ keepCurrent: true, restoreLast: true });
  f.requests[0].resolve(listData("home"));
  await tick();
  f.requests.find(request => request.method === "getTrack").resolve(trackData("saved"));
  await loading;
  assert.equal(f.state.music.current.id, "saved");
  assert.deepEqual(f.loads.map(load => load.autoplay), [false]);
  assert.equal(f.state.music.loading, false);
  assert.deepEqual(f.state.music.queue.map(item => item.id), ["saved", "home"]);
});

test("a current restore failure clears only the missing saved preference", async t => {
  const f = fixture(t, { mode: "home", saved: { trackId: "missing", track: track("missing") } });
  const loading = f.actions.loadMusic();
  f.requests[0].resolve(listData());
  await tick();
  f.requests.find(request => request.method === "getTrack").reject(new Error("missing"));
  await loading;
  assert.equal(f.state.music.current, null);
  assert.deepEqual(f.state.music.queue, []);
  assert.equal(f.preferences.get("fanhao.music.lastTrack"), "{}");
  assert.equal(f.state.music.status, "这里还没有音乐，先运行“刷新音乐库”。");
});

test("metadata list refresh skips restore and keeps the current queue", async t => {
  const f = fixture(t, { mode: "home", saved: { trackId: "saved", track: track("saved") } });
  const loading = f.actions.loadMusic({ keepCurrent: true });
  f.requests[0].resolve(listData("home"));
  await loading;
  assert.equal(f.requests.filter(request => request.method === "getTrack").length, 0);
  const opening = f.actions.openTrackFromList(track("chosen"), [track("chosen"), track("next")]);
  f.requests.find(request => request.method === "getTrack").resolve(trackData("chosen"));
  await opening;
  const queue = f.state.music.queue;
  const current = f.state.music.current;
  const metadata = f.actions.loadMusic({ keepCurrent: true });
  f.requests.filter(request => request.method === "getHome")[1].resolve(listData("metadata"));
  await metadata;
  assert.equal(f.state.music.queue, queue);
  assert.equal(f.state.music.current, current);
});

test("background metadata reads update their cache without taking foreground UI", async t => {
  const f = fixture(t, { mode: "home", saved: { trackId: "saved" } });
  f.state.music.status = "foreground-status";
  const events = f.events.length;
  const queue = f.state.music.queue;
  const loading = f.actions.loadMusic({ background: true, keepCurrent: true, restoreLast: true });
  assert.equal(f.state.music.status, "foreground-status");
  assert.equal(f.state.music.loading, false);
  f.requests[0].resolve(listData("metadata"));
  await loading;
  assert.equal(f.state.music.data.tracks[0].id, "metadata");
  assert.equal(f.state.music.queue, queue);
  assert.equal(f.requests.filter(request => request.method === "getTrack").length, 0);
  assert.equal(f.state.music.status, "foreground-status");
  assert.equal(f.events.length, events);
  assert.deepEqual(f.routes, []);
  const failed = f.actions.loadMusic({ background: true, keepCurrent: true });
  f.requests[1].reject(new Error("metadata-error"));
  await failed;
  assert.equal(f.state.music.status, "foreground-status");
  assert.equal(f.events.length, events);
});

test("duplicate append coalesces only the same selection and offset", async t => {
  const f = fixture(t);
  f.state.music.data = { ...listData("first"), rawTracks: [track("first")], rawLoaded: 1 };
  const first = f.actions.loadMusic({ append: true, keepCurrent: true });
  const duplicate = f.actions.loadMusic({ append: true, keepCurrent: true });
  assert.equal(first, duplicate);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].args[0].get("offset"), "1");
  f.requests[0].resolve(listData("second"));
  await first;
  assert.deepEqual(f.state.music.data.tracks.map(item => item.id), ["first", "second"]);
  const next = f.actions.loadMusic({ append: true, keepCurrent: true });
  assert.equal(f.requests[1].args[0].get("offset"), "2");
  f.state.music.query = "changed";
  const changed = f.actions.loadMusic({ append: true, keepCurrent: true });
  assert.notEqual(next, changed);
  assert.equal(f.requests[1].signal.aborted, true);
  f.requests[1].resolve(listData("obsolete"));
  await next;
  assert.equal(f.state.music.loadingMore, true);
  f.requests[2].resolve(listData("changed"));
  await changed;
  assert.deepEqual(f.state.music.data.tracks.map(item => item.id), ["first", "second", "changed"]);
});

test("a list finishing after foreground selection cannot replace its status or route", async t => {
  const f = fixture(t);
  const loading = f.actions.loadMusic({ keepCurrent: true });
  const opening = f.actions.openTrackFromList(track("chosen"), [track("chosen"), track("next")], { openPage: true });
  const queue = f.state.music.queue;
  const status = f.state.music.status;
  f.requests.find(request => request.method === "getTracks").resolve(listData("list"));
  await loading;
  assert.equal(f.state.music.status, status);
  assert.equal(f.state.music.queue, queue);
  assert.deepEqual(f.routes, []);
  f.requests.find(request => request.method === "getTrack").resolve(trackData("chosen"));
  await opening;
  assert.equal(f.routes.length, 1);
  assert.equal(f.routes[0][1].musicTrackId, "chosen");
});

test("a latest foreground list error remains visible and rejects", async t => {
  const f = fixture(t);
  const loading = f.actions.loadMusic();
  f.requests[0].reject(new Error("current-list-error"));
  await assert.rejects(loading, /current-list-error/);
  assert.equal(f.state.music.status, "current-list-error");
  assert.equal(f.state.music.loading, false);
});

test("a latest track error remains visible and rejects", async t => {
  const f = fixture(t);
  const opening = f.actions.openTrack("broken");
  f.requests[0].reject(new Error("current-track-error"));
  await assert.rejects(opening, /current-track-error/);
  assert.equal(f.state.music.status, "current-track-error");
  assert.equal(f.state.music.openingTrackId, "");
});

test("standalone saved-track restoration keeps its guarded failure recovery", async t => {
  const f = fixture(t, { mode: "home", saved: { trackId: "missing" } });
  const restoring = f.actions.restoreLastTrack();
  f.requests[0].reject(new Error("missing"));
  await restoring;
  assert.equal(f.preferences.get("fanhao.music.lastTrack"), "{}");
  assert.equal(f.state.music.status, "这里还没有音乐，先运行“刷新音乐库”。");
});

test("first smart playlist loading cannot navigate over a later track selection", async t => {
  const f = fixture(t);
  f.actions.selectFirstSmartPlaylist();
  const smart = f.requests[0];
  const opening = f.actions.openTrack("chosen");
  smart.resolve({ smartPlaylists: [{ id: "smart" }] });
  await tick();
  assert.equal(f.state.music.mode, "library");
  assert.equal(f.requests.filter(request => request.method === "getSmartPlaylist").length, 0);
  f.requests.find(request => request.method === "getTrack").resolve(trackData("chosen"));
  await opening;
});

test("a superseded restore tail cannot clear a newer pending list", async t => {
  const f = fixture(t, { mode: "home", saved: { trackId: "saved", track: track("saved") } });
  const old = f.actions.loadMusic();
  f.requests[0].resolve(listData("home"));
  await tick();
  const restoring = f.requests.find(request => request.method === "getTrack");
  f.actions.beginNavigation();
  f.state.music.mode = "library";
  f.state.music.query = "new";
  const fresh = f.actions.loadMusic({ keepCurrent: true });
  const status = f.state.music.status;
  const falseEvents = f.events.filter(event => event.name === "setMusicListLoadingState" && event.args[0] === false).length;
  restoring.resolve(trackData("saved"));
  await old;
  assert.equal(f.state.music.loading, true);
  assert.equal(f.state.music.status, status);
  assert.equal(f.events.filter(event => event.name === "setMusicListLoadingState" && event.args[0] === false).length, falseEvents);
  assert.equal(f.state.music.current, null);
  f.requests.find(request => request.method === "getTracks").resolve(listData("new"));
  await fresh;
  assert.equal(f.state.music.data.tracks[0].id, "new");
});

test("a saved-track restore also respects selection changes before the next request", async t => {
  const f = fixture(t, { mode: "home", saved: { trackId: "saved" } });
  const loading = f.actions.loadMusic();
  f.requests[0].resolve(listData("home"));
  await tick();
  const restore = f.requests.find(request => request.method === "getTrack");
  f.state.music.mode = "library";
  f.state.music.query = "typed";
  restore.resolve(trackData("saved"));
  await loading;
  assert.equal(f.state.music.current, null);
  assert.equal(f.state.music.openingTrackId, "");
  assert.equal(f.state.music.loading, false);
  assert.deepEqual(f.loads, []);
  assert.deepEqual(f.routes, []);
  assert.equal(JSON.parse(f.preferences.get("fanhao.music.lastTrack")).trackId, "saved");
});

test("selecting the already playing track revokes an older pending open", async t => {
  const f = fixture(t);
  const initial = f.actions.openTrack("current", { autoplay: false });
  f.requests[0].resolve(trackData("current"));
  await initial;
  const pending = f.actions.openTrack("old", { openPage: true });
  const same = await f.actions.openTrack("current", { autoplay: false });
  assert.equal(same.id, "current");
  assert.equal(f.requests[1].signal.aborted, true);
  f.requests[1].reject(new Error("obsolete"));
  assert.equal(await pending, null);
  assert.equal(f.state.music.current.id, "current");
  assert.equal(f.state.music.status, "");
  assert.equal(f.state.music.trackPageOpen, false);
  assert.equal(f.loads.length, 1);
  assert.deepEqual(f.routes, []);
});
