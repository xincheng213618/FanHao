import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createMusicListRequestBuilder } from "../android-client/www/modules/music/music-list-request.js";
import { createMusicListPagination } from "../android-client/www/modules/music/music-list-pagination.js";

const source = fs.readFileSync(new URL("../android-client/www/modules/music/music-views.js", import.meta.url), "utf8");

test("all music list transitions cancel pending pagination before changing state", () => {
  for (const name of ["renderMusicList", "loadMusic", "refreshMountedSearchResults", "focusSearchDiscoveryScope", "switchSearchScope", "updateListParams", "deactivate"]) {
    assert.match(source, new RegExp(`(?:async )?function ${name}\\([^\\n]*\\) \\{\\s*cancelMusicPagination\\(\\);`), `${name} must cancel pending pagination`);
  }
  assert.match(source, /cancelPending: cancelMusicPagination, loadMoreTracks \} = createMusicListPagination\(/);
  assert.match(source, /isActive: \(\) => moduleActive/);
});

function createFixture(overrides = {}) {
  const first = { id: "first" };
  const state = {
    mode: "library", query: "", searchScope: "all", sort: "updated",
    artistSort: "count", albumSort: "updated", smartId: "",
    data: { tracks: [first], rawTracks: [first], rawLoaded: 1, total: 3 },
    queue: [first], summary: { marker: "initial" },
    hasMore: true, loading: false, loadingMore: false,
    ...overrides
  };
  const requests = [];
  let activeUrl = "http://music-a.test";
  let active = true;
  let renders = 0;
  const { musicListQuery } = createMusicListRequestBuilder({
    autoCollectionLimit: 300, defaultLimit: 80, defaultSort: "updated", state
  });
  const pagination = createMusicListPagination({
    state,
    getActiveUrl: () => activeUrl,
    isActive: () => active,
    musicListQuery,
    render: () => { renders += 1; },
    collapseDuplicateTracks: (tracks) => Array.from(new Map(tracks.map((track) => [track.id, track])).values()),
    fetchJson(url, path, options) {
      return new Promise((resolve, reject) => {
        // Intentionally ignore abort: a completed body/native bridge may still settle.
        requests.push({ url, path, options, resolve, reject });
      });
    }
  });
  return {
    state, requests, ...pagination,
    get renders() { return renders; },
    setActive(value) { active = value; },
    setUrl(value) { activeUrl = value; }
  };
}

function stalePage() {
  return { tracks: [{ id: "stale" }], artists: [{ id: "stale-artist" }], albums: [{ id: "stale-album" }], summary: { marker: "stale" }, hasMore: false };
}

for (const mode of ["library", "artists", "albums", "smart"]) {
  test(`${mode}: current pages append with correct endpoint and offset`, async () => {
    const key = mode === "artists" ? "artists" : mode === "albums" ? "albums" : "tracks";
    const fixture = createFixture({ mode, ...(key !== "tracks" ? { data: { [key]: [{ id: "first" }] } } : {}) });
    const pending = fixture.loadMoreTracks();
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.state.loadingMore, true);
    const request = fixture.requests[0];
    assert.equal(new URL(request.path, request.url).pathname, `/api/music/${key}`);
    assert.equal(new URL(request.path, request.url).searchParams.get("offset"), "1");
    request.resolve({ [key]: [{ id: "second" }], summary: { marker: "next" }, hasMore: false });
    await pending;
    assert.deepEqual(fixture.state.data[key].map((item) => item.id), ["first", "second"]);
    assert.equal(fixture.state.loadingMore, false);
    assert.equal(fixture.state.hasMore, false);
    assert.equal(fixture.state.summary.marker, "next");
    if (key === "tracks") assert.equal(fixture.state.queue, fixture.state.data.tracks);
  });
}

test("search pagination uses raw offset and keeps the playback queue", async () => {
  const fixture = createFixture({ query: "same", data: { tracks: [{ id: "first" }], rawTracks: [{ id: "first" }, { id: "first" }], rawLoaded: 2 } });
  const queue = fixture.state.queue;
  const pending = fixture.loadMoreTracks();
  const request = fixture.requests[0];
  assert.equal(new URL(request.path, request.url).searchParams.get("offset"), "2");
  request.resolve({ tracks: [{ id: "first" }, { id: "second" }], hasMore: false });
  await pending;
  assert.deepEqual(fixture.state.data.tracks.map((track) => track.id), ["first", "second"]);
  assert.equal(fixture.state.data.rawLoaded, 4);
  assert.equal(fixture.state.queue, queue);
});

for (const transition of ["mode", "query", "server", "replacement", "deactivate"]) {
  test(`late page cannot mutate a list after ${transition} changes`, async () => {
    const fixture = createFixture();
    const pending = fixture.loadMoreTracks();
    if (transition === "mode") fixture.state.mode = "albums";
    if (transition === "query") fixture.state.query = "new search";
    if (transition === "server") fixture.setUrl("http://music-b.test");
    if (transition === "replacement") fixture.state.data = { tracks: [{ id: "new-first" }], rawLoaded: 1 };
    if (transition === "deactivate") fixture.setActive(false);
    const data = fixture.state.data;
    const queue = fixture.state.queue;
    const summary = fixture.state.summary;
    const renders = fixture.renders;
    fixture.requests[0].resolve(stalePage());
    await pending;
    assert.equal(fixture.state.data, data, "stale response must preserve the current data object");
    assert.equal(fixture.state.queue, queue, "stale response must not change the playback queue");
    assert.equal(fixture.state.summary, summary, "stale response must not change summary");
    assert.equal(fixture.state.hasMore, true, "stale response must not change hasMore");
    assert.equal(fixture.renders, renders, "stale response must not render into the active view");
    assert.equal(fixture.state.loadingMore, false);
  });
}

test("cancel frees a new page immediately and old finally does not clear its busy state", async () => {
  const fixture = createFixture();
  const old = fixture.loadMoreTracks();
  fixture.cancelPending();
  assert.equal(fixture.state.loadingMore, false, "cancel must immediately release loadingMore");
  assert.equal(fixture.requests[0].options.signal?.aborted, true, "cancel must abort transport");
  fixture.state.data = { tracks: [{ id: "new-first" }], rawTracks: [{ id: "new-first" }], rawLoaded: 1 };
  const current = fixture.loadMoreTracks();
  assert.equal(fixture.requests.length, 2);
  const renders = fixture.renders;
  fixture.requests[0].resolve(stalePage());
  await old;
  assert.equal(fixture.state.loadingMore, true, "old finally must not clear a newer page's loading flag");
  assert.equal(fixture.renders, renders);
  fixture.requests[1].resolve({ tracks: [{ id: "new-second" }], hasMore: false });
  await current;
  assert.deepEqual(fixture.state.data.tracks.map((track) => track.id), ["new-first", "new-second"]);
  assert.equal(fixture.state.loadingMore, false);
});

for (const [field, value, initial] of [
  ["sort", "title", {}],
  ["favorite", true, {}],
  ["artistId", "new-artist", {}],
  ["albumId", "new-album", {}],
  ["genre", "rock", {}],
  ["language", "中文", {}],
  ["smartId", "recent", { mode: "smart" }],
  ["artistSort", "name", { mode: "artists", data: { artists: [{ id: "first" }] } }],
  ["albumSort", "title", { mode: "albums", data: { albums: [{ id: "first" }] } }],
  ["searchScope", "lyrics", { query: "song" }],
  ["searchFavorite", true, { query: "song" }],
  ["searchLyrics", true, { query: "song" }],
  ["searchMinRating", 4, { query: "song" }],
  ["searchQuality", "lossless", { query: "song" }]
]) {
  test(`changing ${field} invalidates the page snapshot`, async () => {
    const fixture = createFixture(initial);
    const pending = fixture.loadMoreTracks();
    const data = fixture.state.data;
    fixture.state[field] = value;
    fixture.requests[0].resolve(stalePage());
    await pending;
    assert.equal(fixture.state.data, data);
    assert.equal(fixture.state.summary.marker, "initial");
    assert.equal(fixture.state.hasMore, true);
    assert.equal(fixture.renders, 1);
  });
}

test("returning to the same list does not revive a cancelled request", async () => {
  const fixture = createFixture();
  const data = fixture.state.data;
  const pending = fixture.loadMoreTracks();
  fixture.cancelPending();
  fixture.state.query = "another query";
  fixture.cancelPending();
  fixture.state.query = "";
  fixture.requests[0].resolve(stalePage());
  await pending;
  assert.equal(fixture.state.data, data);
  assert.equal(fixture.state.summary.marker, "initial");
  assert.equal(fixture.renders, 1);
});

test("an aborted rejection cannot fail or repaint a newer page", async () => {
  const fixture = createFixture();
  const old = fixture.loadMoreTracks();
  fixture.cancelPending();
  const current = fixture.loadMoreTracks();
  const renders = fixture.renders;
  fixture.requests[0].reject(new Error("aborted request"));
  await assert.doesNotReject(old);
  assert.equal(fixture.state.loadingMore, true);
  assert.equal(fixture.renders, renders);
  fixture.requests[1].resolve({ tracks: [{ id: "second" }], hasMore: false });
  await current;
  assert.equal(fixture.state.loadingMore, false);
});

for (const [name, overrides] of [
  ["the first page is loading", { loading: true }],
  ["a page is already loading", { loadingMore: true }],
  ["the last page was reached", { hasMore: false }],
  ["no first page is loaded", { data: null }],
  ["the list does not paginate", { mode: "history" }]
]) {
  test(`paging is blocked while ${name}`, async () => {
    const fixture = createFixture(overrides);
    const pending = fixture.loadMoreTracks();
    fixture.requests[0]?.resolve(stalePage());
    await pending;
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.renders, 0);
  });
}

test("an inactive module cannot start a page request", async () => {
  const fixture = createFixture();
  fixture.setActive(false);
  await fixture.loadMoreTracks();
  assert.equal(fixture.requests.length, 0);
});

test("repeated taps coalesce while the page is in flight", async () => {
  const fixture = createFixture();
  const first = fixture.loadMoreTracks();
  await fixture.loadMoreTracks();
  assert.equal(fixture.requests.length, 1);
  fixture.requests[0].resolve({ tracks: [{ id: "second" }], hasMore: false });
  await first;
  assert.equal(fixture.state.data.tracks.length, 2);
});

test("a current failure releases paging and remains retryable", async () => {
  const fixture = createFixture();
  const pending = fixture.loadMoreTracks();
  fixture.requests[0].reject(new Error("offline"));
  await assert.rejects(pending, /offline/);
  assert.equal(fixture.state.loadingMore, false);
  assert.equal(fixture.state.hasMore, true);
  const retry = fixture.loadMoreTracks();
  assert.equal(fixture.requests.length, 2);
  fixture.requests[1].resolve({ tracks: [{ id: "second" }], hasMore: false });
  await retry;
  assert.equal(fixture.state.data.tracks.length, 2);
});
