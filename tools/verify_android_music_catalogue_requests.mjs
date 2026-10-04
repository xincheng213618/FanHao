import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMusicCatalogueRequests } from "../android-client/www/modules/music/music-catalogue-requests.js";

// Actual request-owner module with deferred Promise transports. No browser,
// server, account, media, timer, or external request is used by this fixture.
const kinds = [
  { name: "smart", method: "loadSmartPlaylists", array: "smartPlaylists", selected: "smartPlaylist", path: "/api/music/smart-playlists", selectedId: "smart-selected" },
  { name: "playlists", method: "loadPlaylists", array: "playlists", selected: "playlist", path: "/api/music/playlists", selectedId: "playlist-selected" }
];

function fixture() {
  let active = true, activeUrl = "http://catalogue-a.invalid";
  const primary = Object.freeze({ tracks: Object.freeze([Object.freeze({ id: "playing-track" })]), total: 1 });
  const queue = Object.freeze([Object.freeze({ id: "queued-track" })]);
  const current = Object.freeze({ id: "playing-track", positionMs: 90000 });
  const lyrics = Object.freeze([Object.freeze({ timeMs: 0, text: "synthetic lyric" })]);
  const state = {
    data: primary, queue, current, lyrics,
    summary: { version: "initial-summary" },
    smartId: "smart-selected", playlistId: "playlist-selected",
    smartPlaylists: [{ id: "smart-selected", version: "initial-smart" }],
    playlists: [{ id: "playlist-selected", version: "initial-playlists" }],
    mode: "library", query: "kept-query", offset: 48, playing: true
  };
  state.smartPlaylist = state.smartPlaylists[0]; state.playlist = state.playlists[0];
  const requests = [], refreshes = [], selections = { smart: 0, playlists: 0 };
  const module = createMusicCatalogueRequests({
    state, getActiveUrl: () => activeUrl, isActive: () => active,
    fetchJson(url, endpoint, options) {
      let resolve, reject;
      const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
      requests.push({ url, endpoint, options, resolve, reject });
      return pending;
    },
    selectedSmartPlaylist() { selections.smart += 1; return state.smartPlaylists.find((row) => row.id === state.smartId) || null; },
    selectedPlaylist() { selections.playlists += 1; return state.playlists.find((row) => row.id === state.playlistId) || null; },
    refreshMusicCatalogueUi(kind) { refreshes.push(kind); }
  });
  function assertPrimary() {
    assert.strictEqual(state.data, primary, "catalogue requests must preserve primary track data");
    assert.strictEqual(state.queue, queue, "catalogue requests must preserve the playback queue reference");
    assert.strictEqual(state.current, current, "catalogue requests must preserve the current track reference");
    assert.strictEqual(state.lyrics, lyrics, "catalogue requests must preserve lyrics");
    assert.deepEqual([state.mode, state.query, state.offset, state.playing], ["library", "kept-query", 48, true]);
  }
  const load = (kind, guard = null) => module[kind.method](guard);
  const capture = () => ({ smart: state.smartPlaylists, playlists: state.playlists, smartSelected: state.smartPlaylist, playlistSelected: state.playlist, summary: state.summary });
  function assertUnchanged(before) {
    assert.strictEqual(state.smartPlaylists, before.smart); assert.strictEqual(state.playlists, before.playlists);
    assert.strictEqual(state.smartPlaylist, before.smartSelected); assert.strictEqual(state.playlist, before.playlistSelected);
    assert.strictEqual(state.summary, before.summary); assertPrimary();
  }
  return { state, requests, refreshes, selections, load, capture, assertPrimary, assertUnchanged,
    setActive: (value) => { active = value; }, setUrl: (value) => { activeUrl = value; } };
}

function payload(kind, version) {
  return { [kind.array]: [{ id: kind.selectedId, version }], ...(kind.name === "smart" ? { summary: { version: `${version}-summary` } } : {}) };
}

function assertApplied(f, kind, body) {
  assert.strictEqual(f.state[kind.array], body[kind.array]);
  assert.strictEqual(f.state[kind.selected], body[kind.array][0]);
  if (kind.name === "smart") assert.strictEqual(f.state.summary, body.summary);
  f.assertPrimary();
}

const cases = [];
for (const kind of kinds) {
  const other = kinds.find((item) => item !== kind);
  const add = (name, run) => cases.push({ name: `${kind.name}:${name}`, run });

  add("latest-success-ignores-late-success", async () => {
    const f = fixture(), before = f.capture();
    const old = f.load(kind), fresh = f.load(kind);
    assert.equal(f.requests.length, 2, "latest request must start while the previous request is still pending");
    const body = payload(kind, "fresh"); f.requests[1].resolve(body); await fresh;
    assertApplied(f, kind, body);
    const accepted = f.capture(); f.requests[0].resolve(payload(kind, "old")); await old;
    f.assertUnchanged(accepted); assert.deepEqual(f.refreshes, [kind.name]);
    assert.equal(f.selections[kind.name], 1); assert.equal(f.selections[other.name], 0);
    assert.strictEqual(f.state[other.array], before[other.name]);
  });

  add("superseded-success-before-latest", async () => {
    const f = fixture(), before = f.capture();
    const old = f.load(kind), fresh = f.load(kind);
    f.requests[0].resolve(payload(kind, "old")); await old;
    f.assertUnchanged(before); assert.equal(f.refreshes.length, 0);
    const body = payload(kind, "fresh"); f.requests[1].resolve(body); await fresh;
    assertApplied(f, kind, body); assert.deepEqual(f.refreshes, [kind.name]);
  });

  add("stale-error-cannot-clear-latest", async () => {
    for (const errorFirst of [false, true]) {
      const f = fixture(), before = f.capture();
      const old = f.load(kind), fresh = f.load(kind);
      if (errorFirst) {
        f.requests[0].reject(new Error("synthetic old failure")); await old;
        f.assertUnchanged(before); assert.equal(f.refreshes.length, 0);
      }
      const body = payload(kind, "fresh"); f.requests[1].resolve(body); await fresh;
      const accepted = f.capture();
      if (!errorFirst) { f.requests[0].reject(new Error("synthetic old failure")); await old; }
      assertApplied(f, kind, body); f.assertUnchanged(accepted);
      assert.deepEqual(f.refreshes, [kind.name]); assert.equal(f.selections[kind.name], 1);
    }
  });

  add("fresh-error-clears-only-own-kind", async () => {
    const f = fixture(), before = f.capture();
    const old = f.load(kind), fresh = f.load(kind);
    f.requests[1].reject(new Error("synthetic fresh failure")); await fresh;
    assert.deepEqual(f.state[kind.array], []); assert.equal(f.state[kind.selected], null);
    assert.strictEqual(f.state[other.array], before[other.name]);
    assert.strictEqual(f.state[other.selected], other.name === "smart" ? before.smartSelected : before.playlistSelected);
    assert.strictEqual(f.state.summary, before.summary);
    assert.deepEqual(f.refreshes, [kind.name]); assert.equal(f.selections[kind.name], 0);
    const failedState = f.capture(); f.requests[0].resolve(payload(kind, "old")); await old;
    f.assertUnchanged(failedState); assert.deepEqual(f.refreshes, [kind.name]);
  });

  add("render-guard-invalidates-success-and-error", async () => {
    for (const failure of [false, true]) {
      const f = fixture(), before = f.capture(); let valid = true;
      const guard = () => valid;
      const pending = f.load(kind, guard); valid = false;
      if (failure) f.requests[0].reject(new Error("ignored guard failure"));
      else f.requests[0].resolve(payload(kind, "ignored guard success"));
      await pending; f.assertUnchanged(before);
      assert.equal(f.refreshes.length, 0); assert.equal(f.selections[kind.name], 0);
    }
  });

  add("captured-source-invalidates-success-and-error", async () => {
    for (const failure of [false, true]) {
      const f = fixture(), before = f.capture();
      const pending = f.load(kind); assert.equal(f.requests[0].url, "http://catalogue-a.invalid");
      f.setUrl("http://catalogue-b.invalid");
      if (failure) f.requests[0].reject(new Error("ignored source failure"));
      else f.requests[0].resolve(payload(kind, "ignored source success"));
      await pending; f.assertUnchanged(before); assert.equal(f.refreshes.length, 0);
    }
  });

  add("deactivation-invalidates-success-and-error", async () => {
    for (const failure of [false, true]) {
      const f = fixture(), before = f.capture();
      const pending = f.load(kind); f.setActive(false);
      if (failure) f.requests[0].reject(new Error("ignored inactive failure"));
      else f.requests[0].resolve(payload(kind, "ignored inactive success"));
      await pending; f.assertUnchanged(before); assert.equal(f.refreshes.length, 0);
    }
  });

  add("forwards-signal-timeout-and-captured-url", async () => {
    const f = fixture(), controller = new AbortController();
    const guard = () => true; guard.signal = controller.signal;
    const pending = f.load(kind, guard), request = f.requests[0];
    assert.equal(request.url, "http://catalogue-a.invalid"); assert.equal(request.endpoint, kind.path);
    assert.deepEqual(request.options, { timeoutMs: 12000, signal: controller.signal });
    const body = payload(kind, "transport"); request.resolve(body); await pending;
    assertApplied(f, kind, body); assert.deepEqual(f.refreshes, [kind.name]);
  });

  add("inactive-does-not-fetch", async () => {
    const f = fixture(), before = f.capture(); f.setActive(false);
    await f.load(kind);
    assert.equal(f.requests.length, 0); assert.equal(f.refreshes.length, 0); f.assertUnchanged(before);
  });

  add("initial-invalid-guard-does-not-fetch", async () => {
    const f = fixture(), before = f.capture();
    await f.load(kind, () => false);
    assert.equal(f.requests.length, 0); assert.equal(f.refreshes.length, 0); f.assertUnchanged(before);
  });
}

cases.push({ name: "independent-kinds:latest-generations", async run() {
  const f = fixture();
  const smartOld = f.load(kinds[0]), playlist = f.load(kinds[1]), smartFresh = f.load(kinds[0]);
  assert.equal(f.requests.length, 3);
  const playlistBody = payload(kinds[1], "playlist-fresh"); f.requests[1].resolve(playlistBody); await playlist;
  assertApplied(f, kinds[1], playlistBody);
  const smartBody = payload(kinds[0], "smart-fresh"); f.requests[2].resolve(smartBody); await smartFresh;
  assertApplied(f, kinds[0], smartBody); assertApplied(f, kinds[1], playlistBody);
  const accepted = f.capture(); f.requests[0].reject(new Error("old smart")); await smartOld;
  f.assertUnchanged(accepted); assert.deepEqual(f.refreshes, ["playlists", "smart"]);
} });

cases.push({ name: "independent-kinds:fresh-error-keeps-other-owner", async run() {
  const f = fixture();
  const smart = f.load(kinds[0]), playlist = f.load(kinds[1]);
  f.requests[0].reject(new Error("fresh smart failure")); await smart;
  assert.deepEqual(f.state.smartPlaylists, []); assert.equal(f.state.smartPlaylist, null);
  const body = payload(kinds[1], "playlist-still-current"); f.requests[1].resolve(body); await playlist;
  assertApplied(f, kinds[1], body); assert.deepEqual(f.refreshes, ["smart", "playlists"]);
} });

export async function runAndroidMusicCatalogueRequestsFixture({ caseName = "" } = {}) {
  const selected = cases.filter((test) => !caseName || test.name === caseName);
  assert(selected.length, `unknown case: ${caseName}`);
  for (const test of selected) {
    await test.run();
    console.log(`android-music-catalogue-requests: PASS ${test.name}`);
  }
  console.log(`android-music-catalogue-requests: ${selected.length} cases PASS`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const caseName = process.argv.find((arg) => arg.startsWith("--case="))?.slice(7) || "";
  await runAndroidMusicCatalogueRequestsFixture({ caseName });
}
