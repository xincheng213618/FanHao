import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequestHandler } from "../src/platform/server/http-app.js";
import { notFound, sendJson, sendText } from "../src/platform/server/responses.js";
import { createAccountUserStateService } from "../src/modules/fanhao/server/collections/account-user-state-service.js";
import { createPlaybackProgressService } from "../src/modules/fanhao/server/playback/playback-progress-service.js";
import { createImageLibraryService } from "../src/modules/content-index/server/image-library-service.js";
import { createMediaRuntime } from "../src/modules/media/server/runtime.js";
import { createGalleryMediaService } from "../src/modules/media/server/gallery-media-service.js";

const guest = { favorites: {}, favoriteFolders: {}, progress: {} };
const scoped = createAccountUserStateService({ dbPath: ":memory:", legacyStateService: {
  state: guest, normalizeFavoriteFolders: value => value, revision: () => "guest"
} });
const playback = createPlaybackProgressService({ getLibrary: () => ({ worksById: new Map() }),
  getUserState: scoped.state, userStateService: scoped });

const media = (id, mediaKind, seriesName = "", title = id) => ({ id, mediaKind, category: "Fixture", seriesName, title,
  sourceRoot: "private synthetic root", relativePath: `fixture/${id}.mkv` });
const newMovies = Array.from({ length: 7 }, (_, index) => media(`more-${index}`, "movie"));
const wideMovies = Array.from({ length: 30 }, (_, index) => media(`wide-${index}`, "movie"));
let index = { mediaItems: [media("old", "tv", "Series", "E01"), media("recent", "tv", "Series", "E02"),
  media("anime", "anime", "Animation", "E03"), media("movie", "movie"), media("guest", "movie"),
  media("completed", "movie"), media("just-started", "movie"), media("western", "western"), ...newMovies, ...wideMovies] };
const library = createImageLibraryService({ getImageLibraryIndex: () => index, metadataService: {
  tvSeriesKey: (category, title) => `${category}:${title}`, tvSeriesRow: key => key,
  publicTvSeries: key => ({ coverUrl: `/media/tv-series-cover/${encodeURIComponent(key)}` }),
  movieRow: id => id, publicMovie: id => ({ title: `Film ${id}`, coverUrl: `/media/movie-cover/${id}` })
} });
const gallery = createGalleryMediaService({ getImageLibraryIndex: () => index, playbackProgressService: playback,
  publicGalleryMediaItem: library.publicGalleryMediaItem, getLinkedVideoById: id => media(id, "movie"),
  safeStat: () => assert.fail("continue shelf must not stat video files") });
const runtime = createMediaRuntime({ galleryMediaService: gallery, notFound, sendJson });
const handler = createRequestHandler({ attachAccessAnalytics() {}, attachAccessLogger() {}, requestCorsOrigin: () => "",
  requestAuthState: req => ({ allowed: req.headers["fixture-account"] !== "anonymous",
    user: req.headers["fixture-account"] ? { id: req.headers["fixture-account"] } : null }),
  runForUser: scoped.runForUser, routeAuth: () => false, sendLoginRequired: (_req, res) => sendJson(res, 401, {}),
  routeApi: runtime.routeApi, routeMedia: () => false, serveStatic: (_req, res) => notFound(res), sendJson, sendText
});
const server = createServer(handler).listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
const record = (position, day) => ({ position, duration: 200, updatedAt: `2026-11-${String(day).padStart(2, "0")}T00:00:00Z` });

function seed(owner, rows) {
  scoped.runForUser({ id: owner }, () => {
    Object.assign(scoped.state().progress, rows);
    scoped.save();
  });
}

async function read(account, kind = "all", expectedOwner, query = "") {
  const headers = account ? { "Fixture-Account": account } : {};
  if (expectedOwner) headers["X-FanHao-Account-Owner"] = expectedOwner;
  const response = await fetch(`${base}/api/gallery-media/continue-watching?kind=${kind}${query}`, { headers });
  return { response, body: await response.json() };
}

try {
  seed("alpha", { old: record(10, 1), recent: record(160, 4), anime: record(70, 2), movie: record(120, 3),
    completed: record(200, 10), "just-started": record(5, 10), removed: record(11, 10), western: record(12, 10) });
  seed("beta", Object.fromEntries(newMovies.map((item, i) => [item.id, record(100, i + 1)])));
  seed("wide", Object.fromEntries(wideMovies.map((item, i) => [item.id, record(100, i + 1)])));
  guest.progress.guest = record(11, 1);

  const [alpha, beta, local] = await Promise.all([read("alpha"), read("beta"), read("")]);
  assert.equal(alpha.response.status, 200);
  assert.equal(alpha.response.headers.get("cache-control"), "no-store");
  assert.equal(alpha.response.headers.get("x-fanhao-account-owner"), "account:alpha");
  assert.deepEqual(alpha.body.items.map(item => item.id), ["recent", "movie", "anime"]);
  assert.deepEqual(alpha.body.items[0], { id: "recent", title: "Series", episodeTitle: "E02",
    coverUrl: "/media/tv-series-cover/Fixture%3ASeries", percent: 80 });
  assert.deepEqual(beta.body.items.map(item => item.id), ["more-6", "more-5", "more-4", "more-3", "more-2", "more-1"]);
  const expanded = "&limit=24&includeProgressRevision=1";
  const candidate = (await read("alpha", "tv", undefined, expanded)).body.items[0];
  assert.equal(typeof candidate.progressRevision, "string");
  assert.deepEqual((await read("alpha", "tv", undefined, expanded)).body.items[0], candidate, "identical progress has a stable revision");
  assert.deepEqual((await read("beta", "movie", undefined, expanded)).body.items.map(item => item.id),
    ["more-6", "more-5", "more-4", "more-3", "more-2", "more-1", "more-0"]);
  const capped = (await read("wide", "movie", undefined, "&limit=99999&includeProgressRevision=1")).body.items;
  assert.equal(capped.length, 24);
  assert.equal(capped[0].id, "wide-29");
  scoped.runForUser({ id: "alpha" }, () => playback.saveVideoProgress("recent", { position: 161, duration: 200 }));
  const advanced = (await read("alpha", "tv", undefined, expanded)).body.items[0];
  assert.equal(advanced.id, candidate.id);
  assert.equal(Math.floor(advanced.percent), Math.floor(candidate.percent), "small advances may not change the displayed percentage");
  assert.notEqual(advanced.progressRevision, candidate.progressRevision);
  assert.deepEqual(local.body.items.map(item => item.id), ["guest"]);
  for (const [kind, id] of [["movie", "movie"], ["tv", "recent"], ["anime", "anime"]]) {
    assert.deepEqual((await read("alpha", kind)).body.items.map(item => item.id), [id]);
  }
  assert.deepEqual((await read("new-account")).body.items, []);
  assert.equal((await read("anonymous")).response.status, 401);
  assert.equal((await read("alpha", "all", "account:beta")).response.status, 409);
  assert.equal((await read("alpha", "western")).response.status, 400);

  scoped.runForUser({ id: "alpha" }, () => playback.saveVideoProgress("recent", { position: 200, duration: 200 }));
  assert.deepEqual((await read("alpha", "tv")).body.items.map(item => item.id), ["old"]);
  index = { mediaItems: index.mediaItems.filter(item => item.id !== "old") };
  assert.deepEqual((await read("alpha", "tv")).body.items, []);
  console.log("media continue watching: accounts, content scope, recent ordering, bounded results and index changes passed");
} finally {
  scoped.close();
  server.close();
  await once(server, "close");
}
