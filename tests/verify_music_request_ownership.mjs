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
  for (const method of ["getTracks", "getHome", "getArtists", "getAlbums", "getHistory", "getPlaylist", "getSmartPlaylist", "getReport", "getTrack", "getPlaylists", "getSmartPlaylists", "createPlaylist", "importM3u", "deletePlaylist", "updatePlaylist", "addTrackToPlaylist", "removeTrackFromPlaylist", "reorderPlaylist", "runScript", "clearHistory", "setFavorite", "setRating"]) {
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

function favoriteOwnershipFixture(t) {
  const f = fixture(t);
  const current = { ...track("A"), title: "Current A metadata", rating: 5, favorite: true };
  const prefix = [current, track("B"), ...Array.from({ length: 118 }, (_, index) => track(`existing-${index}`))];
  f.state.music.current = current;
  f.state.music.queue = [current, track("B")];
  f.state.music.data = { tracks: prefix.map(item => ({ ...item })), rawTracks: prefix.map(item => ({ ...item })), rawLoaded: 120, total: 300, hasMore: true };
  f.state.music.hasMore = true;
  f.audio.src = current.streamUrl;
  return f;
}

test("favorite ownership late success and failure preserve newer navigation, playback and controller leave", async t => {
  for (const outcome of ["success", "failure"]) for (const destination of ["navigation", "playback", "leave"]) await t.test(`${outcome} to ${destination}`, async sub => {
    const f = favoriteOwnershipFixture(sub);
    f.state.music.query = "Current";
    f.state.music.data.rawTracks.unshift(null, { ...f.state.music.current });
    f.state.music.data.rawLoaded += 2;
    const saving = f.actions.toggleFavorite("A").then(() => null, error => error), write = f.requests[0];
    assert.deepEqual(write.args, ["A", false]);
    assert.equal(write.signal, undefined, "accepted writes must not be cancelled by leaving the view");
    if (destination === "playback") {
      const opening = f.actions.openTrack("B", { openPage: true });
      f.requests.find(request => request.method === "getTrack").resolve(trackData("B")); await opening;
    } else {
      f.actions.beginNavigation();
      if (destination === "leave") f.state.activeView = "novels"; // Explicit controller contract, not native cross-module UI.
      else f.state.music.favorite = true;
    }
    f.state.music.status = "New destination status";
    const events = f.events.length, reads = f.requests.length, routes = f.routes.length, current = f.state.music.current;
    if (outcome === "success") write.resolve({ track: { ...track("A"), favorite: false, title: "Obsolete title", rating: 0 } });
    else write.reject(new Error("Obsolete favorite failure"));
    assert.equal(await saving, null, "obsolete errors must not reach a newer page's showError callback");
    assert.equal(f.events.length, events); assert.equal(f.requests.length, reads); assert.equal(f.routes.length, routes);
    assert.equal(f.state.music.status, "New destination status");
    if (destination === "playback") assert.equal(f.state.music.current, current);
    for (const item of [f.state.music.queue[0], f.state.music.data.tracks[0], ...f.state.music.data.rawTracks.filter(item => item?.id === "A")]) {
      assert.equal(item.favorite, outcome !== "success");
      assert.equal(item.title, "Current A metadata"); assert.equal(item.rating, 5, "stale favorite DTOs must not overwrite newer metadata");
    }
    assert.equal(f.state.music.data.rawTracks[0], null);
    assert.equal(f.audio.currentTime, 12);
  });
});

test("favorite ownership waits for a same-context read and maintains only accepted results", async t => {
  for (const outcome of ["success", "failure"]) await t.test(outcome, async sub => {
    const f = favoriteOwnershipFixture(sub); f.state.music.favorite = true;
    const saving = f.actions.toggleFavorite("A").then(() => null, error => error), write = f.requests[0];
    const reading = f.actions.loadMusic({ append: true, keepCurrent: true }).then(() => null, error => error), read = f.requests[1];
    assert.equal(read.args[0].get("offset"), "120");
    write.resolve({ track: { ...track("A"), favorite: false, title: "Obsolete title", rating: 0 } }); await tick();
    assert.equal(f.requests.length, 2, "favorite confirmation must wait rather than replace an in-flight read");
    assert.equal(read.signal.aborted, false);
    if (outcome === "success") read.resolve({ ...listData("C"), total: 300, hasMore: true });
    else read.reject(new Error("Newer append failure"));
    const readError = await reading; await tick();
    if (outcome === "success") {
      assert.equal(f.requests.length, 3, "an accepted append must still trigger favorite membership maintenance");
      assert.equal(Number(f.requests[2].args[0].get("offset") || 0), 0);
      f.requests[2].resolve(listData("B", "C"));
    } else {
      assert.equal(f.actions.getListReadFailure(), null, "append errors do not create replacement-list retry records");
      assert.equal(readError?.message, "Newer append failure");
      assert.equal(f.requests.length, 2, "a failed append's status must not be hidden by an automatic favorite reload");
      assert.equal(f.state.music.status, "Newer append failure");
    }
    assert.equal(await saving, null);
    assert.equal(f.state.music.current.favorite, false);
    assert.equal(f.state.music.current.title, "Current A metadata"); assert.equal(f.state.music.current.rating, 5);
    if (outcome === "success") assert.deepEqual(f.state.music.data.tracks.map(item => item.id), ["B", "C"]);
  });
});

test("favorite ownership started during a replacement read waits and reapplies only its confirmed field", async t => {
  const f = favoriteOwnershipFixture(t); f.state.music.favorite = true;
  const reading = f.actions.loadMusic({ keepCurrent: true, restoreLast: false });
  const saving = f.actions.toggleFavorite("A"), write = f.requests[1];
  write.resolve({ track: { ...track("A"), favorite: false, title: "Obsolete title", rating: 0 } }); await tick();
  assert.equal(f.requests.length, 2); assert.equal(f.requests[0].signal.aborted, false);
  f.requests[0].resolve({ ...listData("A", "B"), tracks: [{ ...track("A"), title: "New read title", rating: 4, favorite: true }, track("B")] });
  await reading; await tick();
  assert.equal(f.requests.length, 3);
  assert.equal(f.state.music.data.tracks[0].favorite, false, "a precommit read body must not undo the accepted favorite confirmation");
  assert.equal(f.state.music.data.tracks[0].title, "New read title"); assert.equal(f.state.music.data.tracks[0].rating, 4);
  f.requests[2].resolve(listData("B")); await saving;
});

test("favorite ownership accepted ordinary append refreshes the current star without an extra GET", async t => {
  const f = favoriteOwnershipFixture(t);
  const saving = f.actions.toggleFavorite("A"), write = f.requests[0];
  const reading = f.actions.loadMusic({ append: true, keepCurrent: true });
  f.requests[1].resolve({ ...listData("C"), total: 300, hasMore: true }); await reading;
  const start = f.events.length;
  write.resolve({ track: { ...track("A"), favorite: false, title: "Obsolete title", rating: 0 } }); await saving;
  assert.equal(f.requests.length, 2);
  const metadata = f.events.slice(start).filter(event => event.name === "refreshTrackMetadata");
  assert.equal(metadata.length, 1, "the current star must not stay stale after a successful ordinary append");
  assert.equal(metadata[0].args[0].favorite, false);
  assert.equal(metadata[0].args[0].title, "Current A metadata"); assert.equal(metadata[0].args[0].rating, 5);
});

test("favorite ownership keeps favorite-sort and smart membership maintenance", async t => {
  for (const context of ["sort", "smart"]) await t.test(context, async sub => {
    const f = favoriteOwnershipFixture(sub);
    if (context === "sort") f.state.music.sort = "favorite";
    else { f.state.music.mode = "smart"; f.state.music.activeSmartPlaylistId = "new-smart"; }
    const saving = f.actions.toggleFavorite("A");
    f.requests[0].resolve({ track: { ...track("A"), favorite: false } }); await tick();
    assert.equal(f.requests[1].method, context === "sort" ? "getTracks" : "getSmartPlaylist");
    const params = f.requests[1].args[context === "sort" ? 0 : 1];
    assert.equal(Number(params.get("offset") || 0), 0);
    if (context === "sort") assert.equal(params.get("sort"), "favorite");
    f.requests[1].resolve(listData("B")); await saving;
    assert.equal(f.state.music.current.favorite, false);
  });
});

test("favorite ownership account owner, revision and invalidation suppress old confirmations and failures", async t => {
  const account = globalThis.__fanhaoWebAccountContext, original = { ...account };
  const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => { Object.assign(account, original); if (storage) Object.defineProperty(globalThis, "localStorage", storage); else delete globalThis.localStorage; });
  for (const change of ["owner", "revision", "invalid"]) for (const outcome of ["success", "failure"]) await t.test(`${change} ${outcome}`, async sub => {
    Object.assign(account, { owner: "old-owner", revision: "old-revision", invalid: false });
    globalThis.localStorage = { getItem: () => account.revision };
    const f = favoriteOwnershipFixture(sub), saving = f.actions.toggleFavorite("A").then(() => null, error => error);
    if (change === "owner") account.owner = "new-owner";
    else if (change === "revision") account.revision = "new-revision";
    else account.invalid = true;
    const events = f.events.length, current = f.state.music.current, data = f.state.music.data, queue = f.state.music.queue;
    if (outcome === "success") f.requests[0].resolve({ track: { ...track("A"), favorite: false } });
    else f.requests[0].reject(new Error("Old account favorite failure"));
    assert.equal(await saving, null);
    assert.equal(f.state.music.current, current); assert.equal(f.state.music.queue, queue); assert.equal(f.state.music.data, data);
    assert.equal(current.favorite, true); assert.equal(f.events.length, events); assert.equal(f.requests.length, 1);
  });
});

test("favorite feedback retirement does not hide an ordinary replacement read failure", async t => {
  const f = favoriteOwnershipFixture(t);
  const saving = f.actions.toggleFavorite("A").then(() => null, error => error);
  f.requests[0].reject(new Error("Current favorite save failure"));
  assert.equal((await saving)?.message, "Current favorite save failure");
  assert.equal(f.actions.getFavoriteFailure()?.message, "Current favorite save failure");
  assert.equal(f.actions.getFavoriteFailure()?.saved, false);
  const reading = f.actions.loadMusic({ keepCurrent: true, restoreLast: false });
  assert.equal(f.actions.getFavoriteFailure(), null, "an explicit newer read must retire the previous favorite feedback");
  f.requests[1].reject(new Error("Ordinary replacement failure"));
  await assert.rejects(reading, /Ordinary replacement failure/);
  assert.equal(f.state.music.status, "Ordinary replacement failure");
  assert.equal(f.actions.getListReadFailure()?.message, "Ordinary replacement failure", "independent failed reads must retain their normal retry contract");
  f.state.music.favorite = true;
  const first = f.actions.toggleFavorite("A").then(() => null, error => error);
  f.requests[2].resolve({ track: { ...track("A"), favorite: false } }); await tick();
  assert.equal(f.requests[3].method, "getTracks");
  const newer = f.actions.toggleFavorite("A").then(() => null, error => {
    // Model the real UI caller publishing its rejected POST, not another read.
    f.state.music.status = error.message; return error;
  });
  f.requests[4].reject(new Error("正在读取音乐库"));
  assert.equal((await newer)?.message, "正在读取音乐库");
  f.requests[3].reject(new Error("Obsolete favorite read failure"));
  assert.equal(await first, null);
  assert.equal(f.state.music.status, "正在读取音乐库", "retiring an old read must preserve a newer error even when its text equals that read's old loading caption");
  assert.equal(f.actions.getListReadFailure(), null, "a retired read must not create a stale retry record");
  assert.equal(f.actions.getFavoriteFailure()?.message, "正在读取音乐库");
  assert.equal(f.actions.getFavoriteFailure()?.saved, false);
});

test("favorite feedback keeps a shared refresh failure after newer success and permits a fresh undo", async t => {
  const f = favoriteOwnershipFixture(t); f.state.music.favorite = true;
  const first = f.actions.toggleFavorite("A").then(() => null, error => error);
  f.requests[0].resolve({ track: { ...track("A"), favorite: false } }); await tick();
  const read = f.requests[1];
  assert.equal(read.method, "getTracks");
  const newer = f.actions.toggleFavorite("A").then(() => null, error => error);
  f.requests[2].resolve({ track: { ...track("A"), favorite: true } }); await tick();
  assert.equal(f.requests.length, 3, "a newer successful favorite must share the pending same-context read rather than cancel it");
  assert.equal(read.signal.aborted, false);
  read.reject(new Error("Shared favorite refresh failure"));
  assert.equal((await first)?.message, "Shared favorite refresh failure", "starting or confirming a newer favorite must not silently swallow a shared refresh failure");
  assert.equal(await newer, null);
  assert.equal(f.state.music.status, "Shared favorite refresh failure");
  assert.equal(f.actions.getListReadFailure()?.message, "Shared favorite refresh failure");
  assert.equal(f.state.music.current.favorite, true);
  const undo = f.actions.toggleFavorite("A");
  assert.deepEqual(f.requests[3].args, ["A", false]);
  f.requests[3].resolve({ track: { ...track("A"), favorite: false } }); await tick();
  assert.equal(f.requests[4].method, "getTracks");
  assert.equal(Number(f.requests[4].args[0].get("offset") || 0), 0);
  f.requests[4].resolve(listData("B")); await undo;
  assert.equal(f.state.music.current.favorite, false);
  assert.equal(f.actions.getListReadFailure(), null); assert.equal(f.state.music.status, "");
  assert.equal(f.actions.getFavoriteFailure(), null, "a confirmed fresh undo must retire old favorite feedback");
  const older = f.actions.toggleFavorite("A").then(() => null, error => error);
  const failed = f.actions.toggleFavorite("A").then(() => null, error => { f.state.music.status = error.message; return error; });
  f.requests[6].reject(new Error("Newer favorite failure to carry"));
  assert.equal((await failed)?.message, "Newer favorite failure to carry");
  assert.equal(f.actions.getFavoriteFailure()?.message, "Newer favorite failure to carry");
  f.requests[5].resolve({ track: { ...track("A"), favorite: true } }); await tick();
  assert.equal(f.requests[7].method, "getTracks");
  assert.equal(f.actions.getFavoriteFailure()?.message, "Newer favorite failure to carry", "an older successful write and its maintenance must not clear a newer favorite failure");
  assert.equal(f.state.music.status, "Newer favorite failure to carry");
  const latest = f.actions.toggleFavorite("A").then(() => null, error => error);
  f.requests[8].resolve({ track: { ...track("A"), favorite: false } }); await tick();
  assert.equal(f.requests.length, 9, "the latest favorite success must share the already pending maintenance read");
  assert.equal(f.actions.getFavoriteFailure(), null, "the latest success must clear the carried favorite failure");
  f.requests[7].reject(new Error("Carried maintenance still failed"));
  assert.equal((await older)?.message, "Carried maintenance still failed");
  assert.equal(await latest, null);
  assert.equal(f.state.music.status, "Carried maintenance still failed");
  assert.equal(f.actions.getListReadFailure()?.message, "Carried maintenance still failed", "clearing a carried hint must not silence a subsequently failed read or lose its retry");
  const explicit = f.actions.loadMusic({ keepCurrent: true, restoreLast: false });
  assert.equal(f.actions.getFavoriteFailure(), null);
  f.requests[9].resolve(listData("B")); await explicit;
  assert.equal(f.actions.getFavoriteFailure(), null); assert.equal(f.actions.getListReadFailure(), null);
});

function ratingOwnershipFixture(t) {
  const f = favoriteOwnershipFixture(t);
  for (const item of [f.state.music.current, ...f.state.music.queue, ...f.state.music.data.tracks, ...f.state.music.data.rawTracks]) if (item.id === "A") item.rating = 0;
  return f;
}

test("rating feedback retains a failed confirmation until retry ACK and retires on explicit reads", async t => {
  const f = ratingOwnershipFixture(t);
  const saving = f.actions.setTrackRating("A", 5).catch(error => error);
  f.requests[0].reject(new Error("Current rating POST failure"));
  const error = await saving, failure = f.actions.getRatingFailure();
  assert.match(error.message, /Current rating POST failure/);
  assert.equal(failure?.trackId, "A"); assert.equal(failure?.saved, false); assert.equal(failure?.error, error);
  assert.equal(f.state.music.current.rating, 0);
  const retry = f.actions.setTrackRating("A", 4);
  assert.equal(f.actions.getRatingFailure(), failure, "a newly started rating retry must not claim an unconfirmed save succeeded");
  f.requests[1].resolve({ track: { ...track("A"), rating: 4 } }); await retry;
  assert.equal(f.actions.getRatingFailure(), null); assert.equal(f.state.music.current.rating, 4);
  const failed = f.actions.setTrackRating("A", 2).catch(error => error);
  f.requests[2].reject(new Error("Another rating failure")); await failed;
  assert.match(f.actions.getRatingFailure()?.message, /Another rating failure/);
  const reading = f.actions.loadMusic({ keepCurrent: true, restoreLast: false });
  assert.equal(f.actions.getRatingFailure(), null, "explicit newer library reads must retire old rating feedback");
  f.requests[3].reject(new Error("Ordinary read remains recoverable"));
  await assert.rejects(reading, /Ordinary read remains recoverable/);
  assert.equal(f.actions.getListReadFailure()?.message, "Ordinary read remains recoverable");
});

test("rating ownership updates known copies without requesting a newer track stage rebuild", async t => {
  for (const outcome of ["success", "failure"]) await t.test(outcome, async sub => {
    const f = ratingOwnershipFixture(sub), saving = f.actions.setTrackRating("A", 3).catch(error => error), write = f.requests[0];
    const opening = f.actions.openTrack("B", { openPage: true });
    f.requests[1].resolve({ ...trackData("B"), track: { ...track("B"), rating: 4 } }); await opening;
    const current = f.state.music.current, routes = f.routes.length, loads = f.loads.length, events = f.events.length;
    if (outcome === "success") write.resolve({ track: { ...track("A"), rating: 3 } });
    else write.reject(new Error("Obsolete A score failed"));
    assert.equal(await saving, undefined);
    assert.equal(f.state.music.current, current); assert.equal(current.rating, 4);
    assert.equal(f.loads.length, loads); assert.equal(f.routes.length, routes); assert.equal(f.requests.length, 2);
    assert.equal(f.actions.getRatingFailure(), null);
    for (const item of [f.state.music.queue[0], f.state.music.data.tracks[0], f.state.music.data.rawTracks[0]]) {
      assert.equal(item.rating, outcome === "success" ? 3 : 0); assert.equal(item.title, "Current A metadata"); assert.equal(item.favorite, true);
    }
    for (const event of f.events.slice(events).filter(event => event.name === "refreshTrackMetadata")) {
      assert.equal(event.args[1]?.allowStage, false, "a stale rating completion may update library stars but must not rebuild the current B stage");
    }
  });
});

test("rating feedback survives internal maintenance for another field or track", async t => {
  for (const kind of ["favorite", "rating"]) await t.test(kind, async sub => {
    const f = ratingOwnershipFixture(sub);
    f.state.music.favorite = kind === "favorite"; f.state.music.sort = kind === "rating" ? "rating" : "title";
    let maintaining, write;
    if (kind === "favorite") { maintaining = f.actions.toggleFavorite("A"); write = f.requests[0]; }
    const failing = f.actions.setTrackRating("B", 5).catch(error => error), failedWrite = f.requests.at(-1);
    failedWrite.reject(new Error("Unconfirmed B rating failure")); await failing;
    assert.match(f.actions.getRatingFailure()?.message, /Unconfirmed B rating failure/);
    if (kind === "rating") { maintaining = f.actions.setTrackRating("A", 3); write = f.requests.at(-1); }
    write.resolve({ track: { ...track("A"), ...(kind === "rating" ? { rating: 3 } : { favorite: false }) } }); await tick();
    const read = f.requests.at(-1); assert.equal(read.method, "getTracks");
    assert.equal(f.actions.getRatingFailure()?.trackId, "B");
    assert.match(f.actions.getRatingFailure()?.message, /Unconfirmed B rating failure/, "unrelated confirmed maintenance must not hide a rating that has no ACK");
    read.resolve(listData("A", "B")); await maintaining;
    assert.match(f.actions.getRatingFailure()?.message, /Unconfirmed B rating failure/);
    const explicit = f.actions.loadMusic({ keepCurrent: true, restoreLast: false });
    assert.equal(f.actions.getRatingFailure(), null);
    f.requests.at(-1).resolve(listData("A", "B")); await explicit;
  });
});

test("rating confirmation survives an accepted ordinary pending read without replacing it", async t => {
  for (const outcome of ["success", "later failure"]) await t.test(outcome, async sub => {
    const f = ratingOwnershipFixture(sub); f.state.music.sort = "title";
    const reading = f.actions.loadMusic({ keepCurrent: true, restoreLast: false }), read = f.requests[0], confirmed = outcome === "success" ? 5 : 3;
    const first = f.actions.setTrackRating("A", confirmed);
    let observedError = null;
    const last = outcome === "later failure" ? f.actions.setTrackRating("A", 5).catch(error => { observedError = error; return error; }) : first;
    f.requests[1].resolve({ track: { ...track("A"), rating: confirmed } }); await tick();
    if (outcome === "later failure") {
      assert.equal(f.requests[2].method, "setRating"); f.requests[2].reject(new Error("Later score failed during title read")); await tick();
      assert.match(observedError?.message, /Later score failed during title read/, "an ordinary pending read must not delay a current POST failure reaching its UI caller");
      assert.match(f.actions.getRatingFailure()?.message, /Later score failed during title read/);
    }
    assert.equal(f.requests.filter(request => request.method === "getTracks").length, 1); assert.equal(read.signal.aborted, false);
    read.resolve({ ...listData("A", "B"), tracks: [{ ...track("A"), title: "Accepted newer read title", rating: 0 }, track("B")] });
    await reading; await first; const error = await last; await tick();
    if (outcome === "later failure") { assert.match(error?.message, /Later score failed during title read/); assert.match(f.actions.getRatingFailure()?.message, /3 星/); }
    for (const item of [f.state.music.current, f.state.music.queue[0], f.state.music.data.tracks[0], f.state.music.data.rawTracks[0]]) assert.equal(item.rating, confirmed, "the accepted list snapshot must not undo a confirmed score");
    assert.equal(f.state.music.data.tracks[0].title, "Accepted newer read title");
    assert.equal(f.requests.filter(request => request.method === "getTracks").length, 1, "an ordinary same-context read must be awaited, not replaced with an extra GET");
  });
});

test("rating capacity rejection is recoverable once existing track writes settle", async t => {
  const f = ratingOwnershipFixture(t);
  const busyTracks = Array.from({ length: 8 }, (_, index) => ({ ...track(`busy-${index}`), rating: 0 }));
  f.state.music.queue.push(...busyTracks);
  const pending = busyTracks.map(item => f.actions.setTrackRating(item.id, 3));
  const rejected = await f.actions.setTrackRating("A", 5).catch(error => error);
  assert.equal(f.requests.length, 8, "the ninth distinct track must not bypass the bounded write capacity");
  assert.match(rejected.message, /评分保存繁忙/); assert.match(f.actions.getRatingFailure()?.message, /评分保存繁忙/);
  assert.equal(f.state.music.current.rating, 0);
  for (const request of f.requests) request.resolve({ track: { ...track(request.args[0]), rating: 3 } });
  await Promise.all(pending);
  assert.match(f.actions.getRatingFailure()?.message, /评分保存繁忙/, "other tracks completing must not clear this track's rejected save");
  const retry = f.actions.setTrackRating("A", 5);
  assert.equal(f.requests.length, 9);
  f.requests[8].resolve({ track: { ...track("A"), rating: 5 } }); await retry;
  assert.equal(f.state.music.current.rating, 5); assert.equal(f.actions.getRatingFailure(), null);
});

test("rating callers expose one current shared refresh rejection after a newer score is confirmed", async t => {
  const f = ratingOwnershipFixture(t); f.state.music.sort = "rating";
  const failures = [];
  const first = f.actions.setTrackRating("A", 3).catch(error => { failures.push(error); });
  f.requests[0].resolve({ track: { ...track("A"), rating: 3 } }); await tick();
  const read = f.requests[1]; assert.equal(read.method, "getTracks");
  const second = f.actions.setTrackRating("A", 4).catch(error => { failures.push(error); });
  f.requests[2].resolve({ track: { ...track("A"), rating: 4 } }); await tick();
  assert.equal(f.requests.length, 3); assert.equal(read.signal.aborted, false);
  read.reject(new Error("Current shared rating refresh failure")); await Promise.all([first, second]);
  assert.equal(failures.length, 1, "exactly one current rating caller must expose a shared failed read to showError rather than silently resolving both");
  assert.equal(failures[0].message, "Current shared rating refresh failure");
  const failure = f.actions.getRatingFailure();
  assert.equal(failure?.error, failures[0]); assert.equal(failure?.saved, true);
  assert.equal(failure?.message, "Current shared rating refresh failure");
  assert.equal(f.actions.getListReadFailure()?.message, failure.message);
  for (const item of [f.state.music.current, f.state.music.queue[0], f.state.music.data.tracks[0], f.state.music.data.rawTracks[0]]) assert.equal(item.rating, 4);
  assert.equal(f.state.music.loading, false);
  assert.equal(f.requests.filter(request => request.method === "getTracks").length, 1);
});

function queueOrderFixture(t) {
  const f = fixture(t, { mode: "playlist" });
  f.state.music.activePlaylistId = "target";
  f.state.music.activePlaylist = { id: "target", name: "Original playlist" };
  f.state.music.data = { ...listData("A", "B", "C"), playlist: f.state.music.activePlaylist };
  f.state.music.queue = f.state.music.data.tracks;
  f.state.music.current = f.state.music.queue[0];
  f.audio.src = f.state.music.current.streamUrl;
  f.audio.paused = false;
  return f;
}

test("queue reorder current success updates its playlist without replacing playback or queue", async t => {
  const f = queueOrderFixture(t);
  f.actions.moveQueueTrack("B", -1);
  const queue = f.state.music.queue, current = f.state.music.current;
  assert.deepEqual(f.requests[0].args, ["target", { trackIds: ["B", "A", "C"] }]);
  assert.equal(f.requests[0].signal, undefined, "accepted order writes must not be cancelled by navigation");
  const playlist = { id: "target", name: "Saved playlist" };
  f.requests[0].resolve({ playlist }); await tick();
  assert.equal(f.state.music.queue, queue);
  assert.equal(f.state.music.current, current);
  assert.equal(f.audio.paused, false);
  assert.equal(f.audio.currentTime, 12);
  assert.equal(f.state.music.activePlaylist, playlist);
  assert.equal(f.state.music.data.playlist, playlist);
  assert.equal(f.state.music.status, "歌单顺序已保存");
  assert.equal(f.state.music.playlistsLoadedAt, 0);
  assert.deepEqual(f.errors, []);
});

test("queue reorder current failure rolls back its own optimistic order and remains visible", async t => {
  const f = queueOrderFixture(t);
  f.actions.moveQueueTrack("B", -1);
  const failure = new Error("current reorder failure");
  f.requests[0].reject(failure); await tick();
  assert.deepEqual(f.state.music.queue.map(item => item.id), ["A", "B", "C"]);
  assert.deepEqual(f.errors, [failure]);
  assert.equal(f.state.music.current.id, "A");
  assert.equal(f.audio.paused, false);
});

for (const outcome of ["success", "failure"]) for (const next of ["append", "remove", "clear", "new order", "new playlist", "leave", "new track"]) {
  test(`queue reorder late ${outcome} preserves ${next}`, async t => {
    const f = queueOrderFixture(t);
    f.actions.moveQueueTrack("B", -1);
    const write = f.requests[0];
    if (next === "append") f.actions.appendTrackToQueue(track("D"));
    else if (next === "remove") f.actions.removeTrackFromQueue("C");
    else if (next === "clear") f.actions.clearQueueAfterCurrent();
    else if (next === "new order") f.actions.moveQueueTrack("C", -1);
    else if (next === "new playlist") {
      f.actions.beginNavigation();
      f.state.music.activePlaylistId = "other";
      f.state.music.activePlaylist = { id: "other", name: "New playlist" };
      f.state.music.data = { ...listData("D"), playlist: f.state.music.activePlaylist };
      f.state.music.queue = f.state.music.data.tracks;
      f.state.music.status = "new playlist status";
    } else if (next === "leave") {
      f.actions.beginNavigation(); f.state.activeView = "novels";
      f.state.music.status = "destination status";
    } else {
      const opening = f.actions.openTrack("chosen", { openPage: true });
      f.requests.find(request => request.method === "getTrack").resolve(trackData("chosen"));
      await opening;
    }
    const queue = f.state.music.queue, playlist = f.state.music.activePlaylist, data = f.state.music.data;
    const status = f.state.music.status, events = f.events.length, requests = f.requests.length;
    if (outcome === "success") write.resolve({ playlist: { id: "target", name: "Obsolete reorder response" } });
    else write.reject(new Error("obsolete reorder failure"));
    await tick();
    assert.equal(f.state.music.queue, queue, "old completion must not replace newer queue edits");
    assert.equal(f.state.music.activePlaylist, playlist);
    assert.equal(f.state.music.data, data);
    assert.equal(f.state.music.status, status);
    assert.equal(f.events.length, events, "old completion must not rerender the current destination");
    assert.equal(f.requests.length, requests + (next === "new order" ? 1 : 0), "only an already accepted pending order may start after the previous write settles");
    assert.deepEqual(f.errors, [], "old errors cannot enter the new page's error handler");
    assert.equal(write.signal, undefined);
    if (outcome === "success") assert.equal(f.state.music.playlistsLoadedAt, 0);
    if (next !== "new track") assert.equal(f.audio.paused, false);
  });
}

for (const first of ["success", "failure"]) for (const last of ["success", "failure"]) {
  test(`queue reorder serializes writes after ${first} then ${last}`, async t => {
    const f = queueOrderFixture(t);
    f.actions.moveQueueTrack("B", -1);
    f.actions.moveQueueTrack("C", -1);
    assert.equal(f.requests.length, 1, "same-playlist writes cannot race to the server");
    assert.deepEqual(f.state.music.queue.map(item => item.id), ["B", "C", "A"]);
    if (first === "success") f.requests[0].resolve({ playlist: { id: "target", name: "First order" } });
    else f.requests[0].reject(new Error("first order failure"));
    await tick();
    assert.equal(f.requests.length, 2);
    assert.deepEqual(f.requests[1].args, ["target", { trackIds: ["B", "C", "A"] }]);
    assert.equal(f.requests[1].signal, undefined);
    const failure = new Error("latest order failure");
    if (last === "success") f.requests[1].resolve({ playlist: { id: "target", name: "Final order" } });
    else f.requests[1].reject(failure);
    await tick();
    assert.deepEqual(f.state.music.queue.map(item => item.id), last === "success" ? ["B", "C", "A"] : first === "success" ? ["B", "A", "C"] : ["A", "B", "C"], "latest failure must return to the last confirmed order, including when both writes failed");
    assert.deepEqual(f.errors, last === "success" ? [] : [failure]);
    assert.equal(f.audio.paused, false);
    assert.equal(f.audio.currentTime, 12);
  });
}

for (const first of ["success", "failure"]) for (const edit of ["append", "remove"]) {
  test(`queue reorder rollback preserves ${edit} membership after earlier ${first}`, async t => {
    const f = queueOrderFixture(t);
    f.actions.moveQueueTrack("B", -1);
    if (edit === "append") {
      f.actions.appendTrackToQueue(track("D"));
      f.actions.moveQueueTrack("D", -1);
    } else {
      f.actions.removeTrackFromQueue("C");
      f.actions.moveQueueTrack("A", -1);
    }
    if (first === "success") f.requests[0].resolve({ playlist: { id: "target", name: "First order" } });
    else f.requests[0].reject(new Error("first order failure"));
    await tick();
    f.requests[1].reject(new Error("latest order failure")); await tick();
    const expected = edit === "append"
      ? first === "success" ? ["B", "A", "C", "D"] : ["A", "B", "C", "D"]
      : first === "success" ? ["B", "A"] : ["A", "B"];
    assert.deepEqual(f.state.music.queue.map(item => item.id), expected, "rollback must restore confirmed order while preserving current membership and the added track's prior slot");
    assert.equal(f.audio.paused, false);
    assert.equal(f.errors.length, 1);
  });
}

test("queue reorder keeps only the latest pending order during rapid adjustments", async t => {
  const f = queueOrderFixture(t);
  f.actions.moveQueueTrack("B", -1);
  for (let index = 0; index < 101; index++) f.actions.moveQueueTrack("C", index % 2 ? 1 : -1);
  const expected = f.state.music.queue.map(item => item.id);
  assert.equal(f.requests.length, 1, "rapid input must not accumulate physical writes");
  f.requests[0].resolve({ playlist: { id: "target", name: "First order" } }); await tick();
  assert.equal(f.requests.length, 2, "intermediate unsent orders must be coalesced");
  assert.deepEqual(f.requests[1].args[1].trackIds, expected);
  f.requests[1].resolve({ playlist: { id: "target", name: "Final order" } }); await tick();
  assert.deepEqual(f.state.music.queue.map(item => item.id), expected);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.errors, []);
});

test("queue reorder bounds distinct pending playlists and releases settled capacity", async t => {
  const f = queueOrderFixture(t);
  for (let index = 0; index < 9; index++) {
    f.state.music.activePlaylistId = `p${index}`;
    f.state.music.queue = ["A", "B", "C"].map(track);
    f.actions.moveQueueTrack("B", -1);
  }
  await tick();
  assert.equal(f.requests.length, 8, "distinct playlists also need a physical write bound");
  assert.deepEqual(f.state.music.queue.map(item => item.id), ["A", "B", "C"], "a rejected new order must roll back visibly");
  assert.match(f.errors[0].message, /繁忙/);
  for (const request of f.requests) request.resolve({ playlist: { id: request.args[0] } });
  await tick();
  f.actions.moveQueueTrack("B", -1);
  assert.equal(f.requests.length, 9, "settled slots must accept new orders again");
  f.requests[8].resolve({ playlist: { id: "p8" } }); await tick();
});

test("queue reorder never sends an unsent old-account order using a new account", async t => {
  const account = globalThis.__fanhaoWebAccountContext;
  const original = { ...account };
  t.after(() => Object.assign(account, original));
  account.owner = "first-account";
  const f = queueOrderFixture(t);
  f.actions.moveQueueTrack("B", -1);
  f.actions.moveQueueTrack("C", -1);
  assert.equal(f.requests.length, 1);
  account.owner = "second-account";
  const queue = f.state.music.queue, status = f.state.music.status;
  const loadedAt = f.state.music.playlistsLoadedAt;
  f.requests[0].resolve({ playlist: { id: "target", name: "Old account response" } }); await tick();
  assert.equal(f.requests.length, 1, "the unsent order must not adopt the new account's identity");
  assert.equal(f.state.music.queue, queue);
  assert.equal(f.state.music.status, status);
  assert.equal(f.state.music.playlistsLoadedAt, loadedAt, "an old account response must not invalidate the new account's cache");
  assert.deepEqual(f.errors, []);
});

test("queue reorder separates same-revision owners and their rollback bases", async t => {
  const account = globalThis.__fanhaoWebAccountContext;
  const original = { ...account };
  t.after(() => Object.assign(account, original));
  account.owner = "first-account";
  const f = queueOrderFixture(t);
  f.actions.moveQueueTrack("B", -1);
  account.owner = "guest";
  f.state.music.queue = ["C", "B", "A"].map(track);
  f.actions.moveQueueTrack("B", -1);
  assert.equal(f.requests.length, 2, "a guest transition with unchanged revision must use its own writer slot");
  f.requests[0].resolve({ playlist: { id: "target", name: "Old account" } }); await tick();
  f.requests[1].reject(new Error("guest order failure")); await tick();
  assert.deepEqual(f.state.music.queue.map(item => item.id), ["C", "B", "A"], "guest rollback must not reuse another account's confirmed order");
  assert.equal(f.errors.length, 1);
});

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
