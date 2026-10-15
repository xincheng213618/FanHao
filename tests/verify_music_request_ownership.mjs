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
    confirm: () => true,
    localStorage: { getItem: key => preferences.get(key) ?? null, setItem: (key, value) => preferences.set(key, value) },
    setTimeout(callback) { const id = timers.size + 1; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  globalThis.document = { querySelector() { return null; }, activeElement: null };
  const requests = [];
  const api = {};
  for (const method of ["getTracks", "getHome", "getArtists", "getAlbums", "getHistory", "getPlaylist", "getSmartPlaylist", "getReport", "getTrack", "getPlaylists", "getSmartPlaylists", "createPlaylist", "importM3u", "deletePlaylist", "updatePlaylist", "addTrackToPlaylist", "removeTrackFromPlaylist", "runScript", "clearHistory"]) {
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
  const adminRoutes = [];
  const router = { push: route => routes.push(["push", route]), replace: route => routes.push(["replace", route]), overrides: () => actions.musicRouteOverrides(), openAdminScript: id => adminRoutes.push(id) };
  const errors = [];
  const actions = createMusicActions({ state, api, player, view, router, showError: error => errors.push(error) });
  return { actions, state, requests, loads, routes, adminRoutes, events, audio, preferences, timers, progress, errors, get plays() { return plays; } };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const track = id => ({ id, title: id, streamUrl: `/fixture/${id}`, durationMs: 180000 });
const trackData = id => ({ track: track(id), lyrics: { lines: [{ text: id }] } });
const listData = (...ids) => ({ tracks: ids.map(track), total: ids.length, hasMore: false });

for (const outcome of ["success", "failure"]) {
  test(`clearHistory late ${outcome} cannot cancel or overwrite a newer page load`, async t => {
    const f = fixture(t, { mode: "history" });
    const pending = f.actions.clearHistory();
    const write = f.requests[0];
    f.actions.selectMusicMode("artists");
    const fresh = f.requests.find(request => request.method === "getArtists");
    const status = f.state.music.status;
    const events = f.events.length;
    const reads = f.requests.length;
    assert.equal(write.method, "clearHistory");
    assert.equal(write.signal, undefined, "navigation must not cancel a history mutation already sent");
    if (outcome === "success") write.resolve({ ok: true });
    else write.reject(new Error("obsolete history clear failure"));
    const settled = pending.then(() => null, error => error);
    await tick();
    assert.equal(fresh.signal.aborted, false, "the old write cannot cancel the user's newer page load");
    assert.equal(f.requests.length, reads, "the old write cannot start replacement reads or retry");
    assert.equal(f.state.music.mode, "artists");
    assert.equal(f.state.music.loading, true);
    assert.equal(f.state.music.status, status);
    assert.equal(f.events.length, events);
    assert.deepEqual(f.routes, []);
    assert.equal(await settled, null, "an obsolete failure must not reach the current UI error handler");
    fresh.resolve({ artists: [], total: 0 });
    await tick();
  });

  test(`clearHistory late ${outcome} preserves a newer foreground track`, async t => {
    const f = fixture(t, { mode: "history" });
    const pending = f.actions.clearHistory();
    const opening = f.actions.openTrack("chosen", { openPage: true });
    f.requests.find(request => request.method === "getTrack").resolve(trackData("chosen"));
    await opening;
    const status = f.state.music.status;
    const events = f.events.length;
    const routes = f.routes.length;
    const reads = f.requests.length;
    if (outcome === "success") f.requests[0].resolve({ ok: true });
    else f.requests[0].reject(new Error("obsolete foreground history failure"));
    const settled = pending.then(() => null, error => error);
    await tick();
    assert.equal(f.requests.length, reads);
    assert.equal(f.state.music.current.id, "chosen");
    assert.equal(f.state.music.trackPageOpen, true);
    assert.equal(f.state.music.status, status);
    assert.equal(f.events.length, events);
    assert.equal(f.routes.length, routes);
    assert.equal(await settled, null, "an obsolete failure must not reach the new track's error handler");
  });
}

test("clearHistory current success refreshes history while preserving playback and queue", async t => {
  const f = fixture(t, { mode: "history" });
  const current = track("playing"), queue = [current];
  f.state.music.current = current;
  f.state.music.queue = queue;
  f.state.music.data = listData("old-history");
  f.audio.src = current.streamUrl;
  f.audio.paused = false;
  const pending = f.actions.clearHistory();
  assert.deepEqual(f.requests[0].args, []);
  f.requests[0].resolve({ ok: true });
  await tick();
  assert.deepEqual(f.requests.map(request => request.method), ["clearHistory", "getHistory"]);
  f.requests[1].resolve(listData());
  await pending;
  assert.deepEqual(f.state.music.data.tracks, []);
  assert.equal(f.state.music.current, current);
  assert.equal(f.state.music.queue, queue);
  assert.equal(f.audio.src, current.streamUrl);
  assert.equal(f.audio.paused, false);
  assert.equal(f.state.music.loading, false);
  assert.equal(f.routes.length, 1);
  assert.equal(f.routes[0][0], "replace");
  assert.equal(f.routes[0][1].musicMode, "history");
});

test("clearHistory current failure rejects unchanged without clearing local history", async t => {
  const f = fixture(t, { mode: "history" });
  const data = listData("old-history");
  f.state.music.data = data;
  const pending = f.actions.clearHistory();
  const error = new Error("current history clear failure");
  f.requests[0].reject(error);
  await assert.rejects(pending, actual => actual === error);
  assert.equal(f.state.music.data, data);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.routes, []);
});

test("clearHistory does nothing when its confirmation is cancelled", async t => {
  const f = fixture(t, { mode: "history" });
  window.confirm = () => false;
  await f.actions.clearHistory();
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.routes, []);
});

test("clearHistory refresh yields to navigation after the write has already completed", async t => {
  const f = fixture(t, { mode: "history" });
  const pending = f.actions.clearHistory();
  f.requests[0].resolve({ ok: true });
  await tick();
  const history = f.requests.find(request => request.method === "getHistory");
  f.actions.beginNavigation();
  f.state.activeView = "novels";
  const events = f.events.length;
  assert.equal(history.signal.aborted, true);
  history.resolve(listData());
  await pending;
  assert.equal(f.state.music.data, null);
  assert.equal(f.events.length, events);
  assert.deepEqual(f.routes, []);
});

for (const outcome of ["success", "failure"]) {
  test(`startMusicRescan late ${outcome} preserves a newer loading page and releases its busy state`, async t => {
    const f = fixture(t);
    const pending = f.actions.startMusicRescan();
    const write = f.requests[0];
    assert.equal(write.method, "runScript");
    f.actions.selectMusicMode("artists");
    const status = f.state.music.status;
    const events = f.events.length;
    const reads = f.requests.length;
    assert.equal(f.state.music.rescanning, true, "navigation must not claim that the write has completed");
    assert.equal(write.signal, undefined, "navigation cancellation must not abort the script write");
    if (outcome === "success") write.resolve({ job: { id: "synthetic-rescan" } });
    else write.reject(new Error("obsolete rescan failure"));
    await pending;
    assert.equal(f.state.music.rescanning, false);
    assert.equal(f.state.music.mode, "artists");
    assert.equal(f.state.music.loading, true);
    assert.equal(f.state.music.status, status);
    assert.equal(f.events.length, events);
    assert.equal(f.requests.length, reads, "a settled write must not retry or trigger reads");
    assert.deepEqual(f.adminRoutes, []);
    assert.deepEqual(f.routes, []);
    f.requests.find(request => request.method === "getArtists").resolve({ artists: [], total: 0 });
    await tick();
  });

  test(`startMusicRescan late ${outcome} preserves a newer foreground track`, async t => {
    const f = fixture(t);
    const pending = f.actions.startMusicRescan();
    const opening = f.actions.openTrack("chosen", { openPage: true });
    f.requests.find(request => request.method === "getTrack").resolve(trackData("chosen"));
    await opening;
    const status = f.state.music.status;
    const events = f.events.length;
    const routes = f.routes.length;
    assert.equal(f.state.music.rescanning, true);
    if (outcome === "success") f.requests[0].resolve({ job: { id: "synthetic-rescan" } });
    else f.requests[0].reject(new Error("obsolete foreground rescan failure"));
    await pending;
    assert.equal(f.state.music.rescanning, false);
    assert.equal(f.state.music.current.id, "chosen");
    assert.equal(f.state.music.trackPageOpen, true);
    assert.equal(f.state.music.status, status);
    assert.equal(f.events.length, events);
    assert.equal(f.routes.length, routes);
    assert.deepEqual(f.adminRoutes, [], "an obsolete rescan must not redirect the chosen track to administration");
    assert.equal(f.requests.filter(request => request.method === "runScript").length, 1);
  });
}

test("startMusicRescan current success opens administration and clears its busy state", async t => {
  const f = fixture(t);
  f.state.music.summary = { roots: [{ path: "C:\\fixture\\music" }, { path: "C:\\fixture\\second" }] };
  const pending = f.actions.startMusicRescan();
  assert.equal(f.state.music.rescanning, true);
  assert.equal(f.state.music.status, "正在启动音乐库刷新");
  assert.deepEqual(f.requests[0].args, [{
    scriptId: "music-library-rescan",
    options: { roots: "C:\\fixture\\music\nC:\\fixture\\second", limit: 0, dryRun: false }
  }]);
  f.requests[0].resolve({ job: { id: "synthetic-rescan" } });
  await pending;
  assert.equal(f.state.music.rescanning, false);
  assert.equal(f.state.music.status, "音乐库刷新已启动，后台作业完成后会自动更新。");
  assert.deepEqual(f.adminRoutes, ["music-library-rescan"]);
  assert.equal(f.events.filter(event => event.name === "refresh").length, 2);
  assert.equal(f.requests.length, 1);
});

test("startMusicRescan current failure keeps its error visible and clears its busy state", async t => {
  const f = fixture(t);
  const pending = f.actions.startMusicRescan();
  f.requests[0].reject(new Error("current rescan failure"));
  await assert.doesNotReject(pending);
  assert.equal(f.state.music.rescanning, false);
  assert.equal(f.state.music.status, "current rescan failure");
  assert.deepEqual(f.adminRoutes, []);
  assert.equal(f.events.filter(event => event.name === "refresh").length, 2);
  assert.equal(f.requests.length, 1);
});

const existingPlaylistWrites = {
  editActivePlaylist: "updatePlaylist",
  addTrackToPlaylistTarget: "addTrackToPlaylist",
  removeTrackFromActivePlaylist: "removeTrackFromPlaylist"
};
const updatedPlaylist = { id: "target", name: "Updated playlist", description: "Updated description", trackCount: 2 };

function startExistingPlaylistWrite(f, method, { activeTarget = true } = {}) {
  f.state.music.mode = activeTarget ? "playlist" : "library";
  f.state.music.activePlaylistId = activeTarget ? "target" : "";
  f.state.music.activePlaylist = activeTarget ? { ...updatedPlaylist, name: "Old playlist", trackCount: 1 } : null;
  f.state.music.playlists = [{ ...updatedPlaylist, name: "Old playlist", trackCount: 1 }];
  f.state.music.data = listData("original-song");
  if (method === "editActivePlaylist") {
    const prompts = [updatedPlaylist.name, updatedPlaylist.description];
    window.prompt = () => prompts.shift();
    return f.actions.editActivePlaylist();
  }
  if (method === "addTrackToPlaylistTarget") {
    f.state.music.playlistDialogOpen = true;
    f.state.music.playlistDialogTrackId = "changed-song";
    return f.actions.addTrackToPlaylistTarget("target");
  }
  return f.actions.removeTrackFromActivePlaylist("changed-song");
}

for (const [method, apiMethod] of Object.entries(existingPlaylistWrites)) {
  test(`${method} preserves navigation while invalidating a completed write`, async t => {
    const f = fixture(t);
    const pending = startExistingPlaylistWrite(f, method);
    assert.equal(f.requests[0].method, apiMethod);
    f.actions.selectMusicMode("artists");
    const status = f.state.music.status;
    const events = f.events.length;
    const reads = f.requests.length;
    f.requests[0].resolve({ playlist: updatedPlaylist });
    await tick();
    assert.equal(f.state.music.mode, "artists");
    assert.equal(f.state.music.activePlaylist, null, "the old playlist cannot replace a new destination's selection");
    assert.equal(f.state.music.loading, true);
    assert.equal(f.state.music.status, status);
    assert.equal(f.state.music.playlistsLoadedAt, 0);
    assert.equal(f.requests.length, reads, "an obsolete write cannot initiate more reads");
    assert.equal(f.events.length, events);
    assert.deepEqual(f.routes, []);
    await pending;
    f.requests.find(request => request.method === "getArtists").resolve({ artists: [], total: 0 });
    await tick();
  });

  test(`${method} ignores an obsolete failure without disturbing a newer page`, async t => {
    const f = fixture(t);
    const pending = startExistingPlaylistWrite(f, method);
    const loadedAt = f.state.music.playlistsLoadedAt;
    f.actions.selectMusicMode("artists");
    const status = f.state.music.status;
    const events = f.events.length;
    f.requests[0].reject(new Error("obsolete playlist mutation failure"));
    await assert.doesNotReject(pending);
    assert.equal(f.state.music.loading, true);
    assert.equal(f.state.music.status, status);
    assert.equal(f.state.music.playlistsLoadedAt, loadedAt);
    assert.equal(f.events.length, events);
    assert.deepEqual(f.routes, []);
    f.requests.find(request => request.method === "getArtists").resolve({ artists: [], total: 0 });
    await tick();
    assert.deepEqual(f.errors, []);
  });

  test(`${method} preserves a foreground track selected during its write`, async t => {
    const f = fixture(t);
    const pending = startExistingPlaylistWrite(f, method);
    const opening = f.actions.openTrack("chosen", { openPage: true });
    f.requests.find(request => request.method === "getTrack").resolve(trackData("chosen"));
    await opening;
    const data = f.state.music.data;
    const status = f.state.music.status;
    const events = f.events.length;
    const routes = f.routes.length;
    const reads = f.requests.length;
    f.requests[0].resolve({ playlist: updatedPlaylist });
    await tick();
    assert.equal(f.state.music.current.id, "chosen");
    assert.equal(f.state.music.trackPageOpen, true);
    assert.equal(f.state.music.data, data);
    assert.equal(f.state.music.status, status);
    assert.equal(f.state.music.playlistsLoadedAt, 0);
    assert.equal(f.requests.length, reads);
    assert.equal(f.events.length, events);
    assert.equal(f.routes.length, routes);
    await pending;
  });

  test(`${method} cannot resume foreground work after navigation during sidebar refresh`, async t => {
    const f = fixture(t);
    const pending = startExistingPlaylistWrite(f, method);
    f.requests[0].resolve({ playlist: updatedPlaylist });
    await tick();
    const sidebar = f.requests.find(request => request.method === "getPlaylists");
    assert(sidebar, "successful writes must refresh the sidebar cache");
    const detail = f.requests.find(request => request.method === "getPlaylist");
    f.actions.beginNavigation();
    f.state.activeView = "novels";
    const status = f.state.music.status;
    const events = f.events.length;
    const reads = f.requests.length;
    assert.equal(sidebar.signal.aborted, true);
    sidebar.resolve({ playlists: [updatedPlaylist] });
    detail?.resolve({ ...listData("updated-song"), playlist: updatedPlaylist });
    await tick();
    assert.equal(f.requests.length, reads, "finishing an obsolete sidebar read must not start a new page load");
    assert.equal(f.events.length, events);
    assert.equal(f.state.music.status, status);
    assert.equal(f.state.music.playlistsLoadedAt, 0);
    assert.deepEqual(f.routes, []);
    await pending;
  });

  test(`${method} invalidates an in-flight pre-write sidebar snapshot after leaving the page`, async t => {
    const f = fixture(t);
    const pending = startExistingPlaylistWrite(f, method);
    f.state.music.playlistsLoadedAt = 0;
    f.actions.selectMusicMode("artists");
    const sidebar = f.requests.find(request => request.method === "getPlaylists");
    const reads = f.requests.length;
    f.requests[0].resolve({ playlist: updatedPlaylist });
    await tick();
    assert.equal(sidebar.signal.aborted, true);
    assert.equal(f.requests.length, reads, "the old mutation may invalidate caches but cannot refresh the new page");
    sidebar.resolve({ playlists: [{ id: "obsolete-snapshot" }] });
    f.requests.find(request => request.method === "getArtists").resolve({ artists: [], total: 0 });
    await tick();
    assert.equal(f.state.music.playlistsLoadedAt, 0);
    assert(!f.state.music.playlists.some(item => item.id === "obsolete-snapshot"));
    await pending;
  });

  test(`${method} refreshes the active playlist and sidebar after a current success`, async t => {
    const f = fixture(t);
    const pending = startExistingPlaylistWrite(f, method);
    const write = f.requests[0];
    assert.equal(write.method, apiMethod);
    assert.equal(write.args[0], "target");
    if (method === "editActivePlaylist") assert.deepEqual(write.args[1], { name: updatedPlaylist.name, description: updatedPlaylist.description });
    else if (method === "addTrackToPlaylistTarget") assert.deepEqual(write.args[1], { trackId: "changed-song" });
    else assert.equal(write.args[1], "changed-song");
    write.resolve({ playlist: updatedPlaylist });
    await tick();
    const sidebar = f.requests.find(request => request.method === "getPlaylists");
    assert(sidebar, "current success must not reuse the old sidebar name or track count");
    sidebar.resolve({ playlists: [updatedPlaylist] });
    await tick();
    f.requests.find(request => request.method === "getPlaylist").resolve({ ...listData("updated-song"), playlist: updatedPlaylist });
    const result = await pending;
    if (method === "editActivePlaylist") assert.equal(result, updatedPlaylist);
    assert.equal(f.state.music.activePlaylist, updatedPlaylist);
    assert.equal(f.state.music.data.tracks[0].id, "updated-song");
    assert.deepEqual(f.state.music.playlists, [updatedPlaylist]);
    assert(f.state.music.playlistsLoadedAt > 0);
    assert.equal(f.state.music.loading, false);
    assert.equal(f.routes.length, 1);
    assert.equal(f.routes[0][1].musicPlaylistId, "target");
  });

  test(`${method} preserves current failure identity and leaves the cache intact`, async t => {
    const f = fixture(t);
    const pending = startExistingPlaylistWrite(f, method);
    const playlist = f.state.music.activePlaylist;
    const loadedAt = f.state.music.playlistsLoadedAt;
    const error = new Error("current playlist mutation failure");
    f.requests[0].reject(error);
    await assert.rejects(pending, actual => actual === error);
    assert.equal(f.state.music.activePlaylist, playlist);
    assert.equal(f.state.music.activePlaylistId, "target");
    assert.equal(f.state.music.playlistsLoadedAt, loadedAt);
    assert.deepEqual(f.requests.map(request => request.method), [apiMethod]);
    assert.deepEqual(f.routes, []);
  });

  if (method !== "removeTrackFromActivePlaylist") test(`${method} yields when a newer sidebar request supersedes its refresh`, async t => {
    const f = fixture(t);
    const pending = startExistingPlaylistWrite(f, method);
    f.requests[0].resolve({ playlist: updatedPlaylist });
    await tick();
    const obsolete = f.requests.find(request => request.method === "getPlaylists");
    const fresh = f.actions.loadPlaylists();
    const latest = f.requests.at(-1);
    assert.equal(obsolete.signal.aborted, true);
    latest.resolve({ playlists: [{ id: "newer-sidebar" }] });
    await fresh;
    const events = f.events.length;
    const reads = f.requests.length;
    obsolete.resolve({ playlists: [updatedPlaylist] });
    await tick();
    assert.equal(f.requests.length, reads);
    assert.equal(f.events.length, events);
    assert.deepEqual(f.state.music.playlists.map(item => item.id), ["newer-sidebar"]);
    assert.deepEqual(f.routes, []);
    await pending;
  });
}

test("addTrackToPlaylistTarget refreshes only the sidebar when its target is not the current list", async t => {
  const f = fixture(t);
  const pending = startExistingPlaylistWrite(f, "addTrackToPlaylistTarget", { activeTarget: false });
  const data = f.state.music.data;
  f.requests[0].resolve({ ok: true });
  await tick();
  f.requests.find(request => request.method === "getPlaylists").resolve({ playlists: [updatedPlaylist] });
  await pending;
  assert.equal(f.state.music.mode, "library");
  assert.equal(f.state.music.data, data);
  assert.deepEqual(f.state.music.playlists, [updatedPlaylist]);
  assert.deepEqual(f.requests.map(request => request.method), ["addTrackToPlaylist", "getPlaylists"]);
  assert(f.events.some(event => event.name === "refreshLibrarySidebars"));
  assert.deepEqual(f.routes, []);
});

function startPlaylistDelete(f) {
  f.state.music.mode = "playlist";
  f.state.music.activePlaylistId = "delete-me";
  f.state.music.activePlaylist = { id: "delete-me", name: "Delete me" };
  f.state.music.playlists = [f.state.music.activePlaylist, { id: "keep-me", name: "Keep me" }];
  return f.actions.deleteActivePlaylist();
}

test("a delayed playlist deletion preserves a newer playlist and invalidates its sidebar cache", async t => {
  const f = fixture(t);
  const pending = startPlaylistDelete(f);
  const write = f.requests[0];
  assert.equal(write.args[0], "delete-me");
  f.actions.selectMusicMode("playlist", { playlistId: "keep-me" });
  f.requests.find(request => request.method === "getPlaylist").resolve({
    ...listData("kept-song"), playlist: { id: "keep-me", name: "Keep me" }
  });
  await tick();
  const data = f.state.music.data;
  const playlist = f.state.music.activePlaylist;
  const events = f.events.length;
  const routes = f.routes.length;
  const reads = f.requests.length;
  write.resolve({ ok: true });
  await tick();
  assert.equal(f.state.music.mode, "playlist");
  assert.equal(f.state.music.activePlaylistId, "keep-me");
  assert.equal(f.state.music.activePlaylist, playlist);
  assert.equal(f.state.music.data, data);
  assert.equal(f.state.music.playlistsLoadedAt, 0, "the next load must refresh the successfully changed playlist list");
  assert.equal(f.requests.length, reads, "an obsolete write cannot start a new foreground read");
  assert.equal(f.events.length, events);
  assert.equal(f.routes.length, routes);
  await pending;
});

test("an obsolete playlist deletion failure cannot interrupt a newer loading page", async t => {
  const f = fixture(t);
  const pending = startPlaylistDelete(f);
  const loadedAt = f.state.music.playlistsLoadedAt;
  f.actions.selectMusicMode("artists");
  const status = f.state.music.status;
  const events = f.events.length;
  f.requests[0].reject(new Error("obsolete delete failure"));
  await assert.doesNotReject(pending);
  assert.equal(f.state.music.mode, "artists");
  assert.equal(f.state.music.loading, true);
  assert.equal(f.state.music.status, status);
  assert.equal(f.state.music.playlistsLoadedAt, loadedAt, "a failed delete must not invalidate the playlist cache");
  assert.equal(f.events.length, events);
  assert.deepEqual(f.routes, []);
  f.requests.find(request => request.method === "getArtists").resolve({ artists: [], total: 0 });
  await tick();
  assert.deepEqual(f.errors, []);
});

test("a delayed playlist deletion preserves a newer foreground track", async t => {
  const f = fixture(t);
  const pending = startPlaylistDelete(f);
  const opening = f.actions.openTrack("chosen", { openPage: true });
  f.requests.find(request => request.method === "getTrack").resolve(trackData("chosen"));
  await opening;
  const events = f.events.length;
  const routes = f.routes.length;
  f.requests[0].resolve({ ok: true });
  await tick();
  assert.equal(f.state.music.mode, "playlist");
  assert.equal(f.state.music.current.id, "chosen");
  assert.equal(f.state.music.trackPageOpen, true);
  assert.equal(f.events.length, events);
  assert.equal(f.routes.length, routes);
  assert.equal(f.state.music.playlistsLoadedAt, 0);
  assert(!f.requests.some(request => request.method === "getTracks"));
  await pending;
});

test("a current playlist deletion refreshes the library and sidebar after success", async t => {
  const f = fixture(t);
  const pending = startPlaylistDelete(f);
  f.requests[0].resolve({ ok: true });
  await tick();
  assert.equal(f.state.music.mode, "library");
  assert.equal(f.state.music.activePlaylistId, "");
  assert.equal(f.state.music.activePlaylist, null);
  assert.equal(f.state.music.loading, true);
  const side = f.requests.find(request => request.method === "getPlaylists");
  assert(side, "successful deletion must bypass the otherwise fresh sidebar cache");
  side.resolve({ playlists: [{ id: "keep-me", name: "Keep me" }] });
  f.requests.find(request => request.method === "getTracks").resolve(listData("library-song"));
  await pending;
  assert.deepEqual(f.state.music.playlists.map(item => item.id), ["keep-me"]);
  assert.equal(f.state.music.data.tracks[0].id, "library-song");
  assert.equal(f.state.music.loading, false);
  assert.equal(f.routes.length, 1);
  assert.equal(f.routes[0][1].musicMode, "library");
});

test("a current playlist deletion failure preserves the playlist and rejects unchanged", async t => {
  const f = fixture(t);
  const pending = startPlaylistDelete(f);
  const playlist = f.state.music.activePlaylist;
  const loadedAt = f.state.music.playlistsLoadedAt;
  const error = new Error("current delete failure");
  f.requests[0].reject(error);
  await assert.rejects(pending, actual => actual === error);
  assert.equal(f.state.music.mode, "playlist");
  assert.equal(f.state.music.activePlaylistId, "delete-me");
  assert.equal(f.state.music.activePlaylist, playlist);
  assert.equal(f.state.music.playlistsLoadedAt, loadedAt);
  assert.deepEqual(f.requests.map(request => request.method), ["deletePlaylist"]);
  assert.deepEqual(f.routes, []);
});

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

test("current list errors propagate unchanged after cleanup and leave rendering to the caller", async t => {
  const f = fixture(t);
  const error = Object.assign(new Error("controlled list failure"), { code: "CONTROLLED_LIST_FAILURE" });
  const failed = f.actions.loadMusic({ keepCurrent: true });
  f.requests.find(request => request.method === "getTracks").reject(error);
  await assert.rejects(failed, actual => actual === error);
  assert.equal(f.state.music.loading, false);
  assert.equal(f.state.music.loadingMore, false);
  assert.equal(f.state.music.status, error.message);
  assert.equal(f.events.filter(event => event.name === "refresh").length, 0, "the UI catch owns the single error render");
  const retry = f.actions.loadMusic({ keepCurrent: true });
  f.requests.filter(request => request.method === "getTracks").at(-1).resolve(listData("retry"));
  await retry;
  assert.equal(f.state.music.data.tracks[0].id, "retry");
  assert.equal(f.state.music.loading, false);
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

const playlistActions = ["createPlaylistFromDialog", "saveQueueAsPlaylist", "importPlaylistM3uFromPrompt"];
const createdPlaylist = { id: "created-playlist", name: "Fixture playlist" };

function startPlaylistAction(f, method) {
  f.state.music.queue = [track("queued")];
  f.state.music.playlistDialogName = "Fixture playlist";
  window.prompt = () => method === "importPlaylistM3uFromPrompt" ? "#EXTM3U\nsynthetic.mp3" : "Fixture playlist";
  return f.actions[method]();
}

async function finishPlaylistAction(f, pending, write) {
  write.resolve({ playlist: createdPlaylist });
  await tick();
  f.requests.findLast(request => request.method === "getPlaylists").resolve({ playlists: [createdPlaylist] });
  await tick();
  f.requests.findLast(request => request.method === "getPlaylist").resolve({ playlist: createdPlaylist, ...listData("queued") });
  assert.equal(await pending, createdPlaylist);
  assert.equal(f.state.music.mode, "playlist");
  assert.equal(f.state.music.activePlaylistId, createdPlaylist.id);
  assert(f.state.music.playlistsLoadedAt > 0);
}

for (const method of playlistActions) {
  test(`${method} preserves navigation chosen while the write is pending`, async t => {
    const f = fixture(t);
    const pending = startPlaylistAction(f, method);
    const write = f.requests[0];
    assert.equal(write.signal, undefined, "navigation must not cancel an authorized playlist write");
    f.actions.selectMusicMode("artists");
    f.requests.find(request => request.method === "getArtists").resolve({ artists: [], total: 0 });
    await tick();
    const status = f.state.music.status;
    const events = f.events.length;
    const routes = f.routes.length;
    write.resolve({ playlist: createdPlaylist });
    assert.equal(await pending, createdPlaylist, "a completed write must still return its successful result");
    assert.equal(f.state.music.mode, "artists");
    assert.equal(f.state.music.status, status);
    assert.equal(f.state.music.playlistsLoadedAt, 0, "a background success must invalidate the playlist cache");
    assert.equal(f.events.length, events, "old completion must not refresh the newly chosen page");
    assert.equal(f.routes.length, routes);
    assert.deepEqual(f.requests.map(request => request.method), [write.method, "getArtists"], "old completion must not fetch unrelated playlists");
  });

  test(`${method} preserves navigation chosen during playlist refresh`, async t => {
    const f = fixture(t);
    const pending = startPlaylistAction(f, method);
    f.requests[0].resolve({ playlist: createdPlaylist });
    await tick();
    const obsolete = f.requests.find(request => request.method === "getPlaylists");
    f.actions.selectMusicMode("albums");
    assert.equal(obsolete.signal.aborted, true);
    f.requests.findLast(request => request.method === "getPlaylists").resolve({ playlists: [{ id: "current-list" }] });
    f.requests.find(request => request.method === "getAlbums").resolve({ albums: [], total: 0 });
    await tick();
    const status = f.state.music.status;
    const events = f.events.length;
    const routes = f.routes.length;
    obsolete.resolve({ playlists: [createdPlaylist] });
    assert.equal(await pending, createdPlaylist);
    assert.equal(f.state.music.mode, "albums");
    assert.equal(f.state.music.status, status);
    assert.deepEqual(f.state.music.playlists.map(playlist => playlist.id), ["current-list"]);
    assert.equal(f.events.length, events);
    assert.equal(f.routes.length, routes);
    assert(!f.requests.some(request => request.method === "getPlaylist"));
  });

  test(`${method} invalidates a playlist snapshot started before its successful write`, async t => {
    const f = fixture(t);
    const pending = startPlaylistAction(f, method);
    const write = f.requests[0];
    f.state.music.playlistsLoadedAt = 0;
    f.actions.selectMusicMode("artists");
    const obsolete = f.requests.find(request => request.method === "getPlaylists");
    write.resolve({ playlist: createdPlaylist });
    assert.equal(await pending, createdPlaylist);
    assert.equal(obsolete.signal.aborted, true);
    obsolete.resolve({ playlists: [{ id: "before-write" }] });
    f.requests.find(request => request.method === "getArtists").resolve({ artists: [], total: 0 });
    await tick();
    assert.equal(f.state.music.mode, "artists");
    assert.equal(f.state.music.playlistsLoadedAt, 0, "a pre-write snapshot must not restore cache freshness");
    assert.deepEqual(f.state.music.playlists, []);
    assert.equal(f.requests.filter(request => request.method === "getPlaylists").length, 1);
    const reload = f.actions.loadMusic({ keepCurrent: true });
    const current = f.requests.findLast(request => request.method === "getPlaylists");
    assert.notEqual(current, obsolete, "the next page refresh must fetch the invalidated cache");
    current.resolve({ playlists: [createdPlaylist] });
    f.requests.findLast(request => request.method === "getArtists").resolve({ artists: [], total: 0 });
    await reload;
    assert.deepEqual(f.state.music.playlists, [createdPlaylist]);
  });

  test(`${method} preserves a track selected while the write is pending`, async t => {
    const f = fixture(t);
    const pending = startPlaylistAction(f, method);
    const write = f.requests[0];
    const opening = f.actions.openTrack("chosen", { openPage: true });
    f.requests.find(request => request.method === "getTrack").resolve(trackData("chosen"));
    await opening;
    const events = f.events.length;
    const routes = f.routes.length;
    write.resolve({ playlist: createdPlaylist });
    assert.equal(await pending, createdPlaylist);
    assert.equal(f.state.music.current.id, "chosen");
    assert.equal(f.state.music.trackPageOpen, true);
    assert.equal(f.state.music.mode, "library");
    assert.equal(f.events.length, events);
    assert.equal(f.routes.length, routes);
    assert(!f.requests.some(request => request.method === "getPlaylists"));
  });

  test(`${method} still opens its playlist when the action stays current`, async t => {
    const f = fixture(t);
    const pending = startPlaylistAction(f, method);
    await finishPlaylistAction(f, pending, f.requests[0]);
    assert.deepEqual(f.requests.map(request => request.method), [method === "importPlaylistM3uFromPrompt" ? "importM3u" : "createPlaylist", "getPlaylists", "getPlaylist"]);
    assert.equal(f.routes.length, 1);
    assert.equal(f.routes[0][1].musicPlaylistId, createdPlaylist.id);
  });

  test(`${method} exposes a current API failure and allows retry`, async t => {
    const f = fixture(t);
    const pending = startPlaylistAction(f, method);
    f.requests[0].reject(new Error("playlist write failed"));
    await assert.rejects(pending, /playlist write failed/);
    assert(!f.requests.some(request => request.method === "getPlaylists"));
    const retry = startPlaylistAction(f, method);
    await finishPlaylistAction(f, retry, f.requests[1]);
  });

  test(`${method} ignores an obsolete API failure while a new page is loading`, async t => {
    const f = fixture(t);
    const pending = startPlaylistAction(f, method);
    f.actions.selectMusicMode("artists");
    const status = f.state.music.status;
    const events = f.events.length;
    f.requests[0].reject(new Error("obsolete playlist write failed"));
    assert.equal(await pending, null);
    assert.equal(f.state.music.mode, "artists");
    assert.equal(f.state.music.loading, true);
    assert.equal(f.state.music.status, status);
    assert.equal(f.events.length, events);
    assert.equal(f.routes.length, 0);
    f.requests.find(request => request.method === "getArtists").resolve({ artists: [], total: 0 });
    await tick();
    assert.deepEqual(f.errors, []);
  });
}
