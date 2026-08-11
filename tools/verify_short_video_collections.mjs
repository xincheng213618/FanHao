import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { routeShortVideoApi } from "../src/modules/short-videos/server/routes.js";
import { createShortVideoStore } from "../src/modules/short-videos/server/store.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-short-video-collections-"));
const dbPath = path.join(tempRoot, "short-videos.sqlite");
const store = createShortVideoStore({
  dbPath,
  coverDbPath: path.join(tempRoot, "short-video-covers.sqlite"),
  roots: [],
  skipStartupMaintenance: true
});

try {
  verifyStoreContract();
  await verifyRouteContract();
  console.log("short-video-collections: ok");
} finally {
  store.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function verifyStoreContract() {
  assert.deepEqual(store.listCollections(), { collections: [], total: 0 });
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      INSERT INTO short_videos (id, aweme_id, title, source_path, published_at, liked_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("fixture-video-a", "10000001", "Fixture A", "fixture-a.mp4", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    db.prepare(`
      INSERT INTO short_videos (id, aweme_id, title, source_path, published_at, liked_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("fixture-video-b", "10000002", "Fixture B", "fixture-b.mp4", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
  } finally {
    db.close();
  }

  assert.throws(() => store.createCollection({ name: "  " }), statusError(400));
  assert.throws(() => store.createCollection({ name: "x".repeat(41) }), statusError(400));

  const watchLater = store.createCollection({ name: "  稍后\u3000看  " }).collection;
  assert.equal(watchLater.name, "稍后 看", "collection names must normalize width and whitespace");
  assert.match(watchLater.id, /^svc_[a-f0-9]{32}$/);
  assert.throws(() => store.createCollection({ name: "稍后 看" }), statusError(409));
  assert.throws(() => store.createCollection({ name: "稍后 看\t" }), statusError(409));

  const favorites = store.createCollection({ name: "Favorites" }).collection;
  assert.throws(() => store.createCollection({ name: "favorites" }), statusError(409));
  assert.equal(store.renameCollection(favorites.id, { name: "FAVORITES" }).collection.name, "FAVORITES");
  const renamed = store.renameCollection(favorites.id, { name: "旅行" }).collection;
  assert.equal(renamed.name, "旅行");
  assert.throws(() => store.renameCollection("bad/id", { name: "非法" }), statusError(400));
  assert.throws(() => store.renameCollection("missing-list", { name: "不存在" }), statusError(404));

  const firstAdd = store.addCollectionVideo(watchLater.id, "10000001");
  assert.equal(firstAdd.added, true);
  assert.equal(firstAdd.videoId, "fixture-video-a", "aweme ids must resolve to canonical video ids");
  const duplicateAdd = store.addCollectionVideo(watchLater.id, "fixture-video-a");
  assert.equal(duplicateAdd.added, false, "adding the same video twice must be idempotent");
  assert.equal(duplicateAdd.addedAt, firstAdd.addedAt, "idempotent add must preserve the original timestamp");
  store.addCollectionVideo(watchLater.id, "fixture-video-b");
  assert.throws(() => store.addCollectionVideo(watchLater.id, "unknown-video"), statusError(404));
  assert.throws(() => store.addCollectionVideo("unknown-list", "fixture-video-a"), statusError(404));

  const paginationDb = new DatabaseSync(dbPath);
  try {
    paginationDb.prepare(`
      UPDATE short_video_collection_items SET added_at = ?
      WHERE collection_id = ? AND video_id = ?
    `).run("2026-01-01T00:00:00.000Z", watchLater.id, "fixture-video-a");
    paginationDb.prepare(`
      UPDATE short_video_collection_items SET added_at = ?
      WHERE collection_id = ? AND video_id = ?
    `).run("2026-01-02T00:00:00.000Z", watchLater.id, "fixture-video-b");
  } finally {
    paginationDb.close();
  }

  const firstPage = store.listCollectionVideos(
    watchLater.id,
    new URL("http://fixture/api/short-videos/collections/list/videos?limit=1&offset=0")
  );
  assert.equal(firstPage.total, 2);
  assert.equal(firstPage.count, 1);
  assert.equal(firstPage.hasMore, true);
  assert.equal(firstPage.nextOffset, 1);
  assert.equal(firstPage.videos[0].id, "fixture-video-b", "collection pages must sort by newest addition first");
  assert.equal(firstPage.videos[0].collectionAddedAt, "2026-01-02T00:00:00.000Z");
  const secondPage = store.listCollectionVideos(
    watchLater.id,
    new URL("http://fixture/api/short-videos/collections/list/videos?limit=1&offset=1")
  );
  assert.equal(secondPage.videos[0].id, "fixture-video-a");
  assert.equal(secondPage.hasMore, false);

  const removed = store.removeCollectionVideo(watchLater.id, "fixture-video-a");
  assert.equal(removed.removed, true);
  assert.equal(store.removeCollectionVideo(watchLater.id, "fixture-video-a").removed, false, "remove must be idempotent");
  assert.throws(() => store.removeCollectionVideo(watchLater.id, "unknown-video"), statusError(404));
  store.addCollectionVideo(watchLater.id, "fixture-video-a");
  store.deleteVideo("fixture-video-a", { deleteFiles: false });
  const afterVideoDelete = store.listCollectionVideos(watchLater.id);
  assert.deepEqual(afterVideoDelete.videos.map((video) => video.id), ["fixture-video-b"], "video deletion must cascade into collection items");

  const deleted = store.deleteCollection(watchLater.id);
  assert.equal(deleted.removedItems, 1);
  assert.throws(() => store.listCollectionVideos(watchLater.id), statusError(404));
  assert.throws(() => store.deleteCollection(watchLater.id), statusError(404));
}

async function verifyRouteContract() {
  const calls = [];
  const fixtureStore = {
    listCollections() {
      calls.push("list");
      return { collections: [], total: 0 };
    },
    createCollection(body) {
      calls.push(["create", body]);
      return { collection: { id: "svc_fixture", name: body.name } };
    },
    renameCollection(collectionId, body) {
      calls.push(["rename", collectionId, body]);
      return { collection: { id: collectionId, name: body.name } };
    },
    deleteCollection(collectionId) {
      calls.push(["delete", collectionId]);
      return { ok: true, id: collectionId };
    },
    listCollectionVideos(collectionId, url) {
      calls.push(["videos", collectionId, url.searchParams.get("offset")]);
      return { collection: { id: collectionId }, videos: [], total: 0 };
    },
    addCollectionVideo(collectionId, videoId) {
      calls.push(["add", collectionId, videoId]);
      return { added: true, collectionId, videoId };
    },
    removeCollectionVideo(collectionId, videoId) {
      calls.push(["remove", collectionId, videoId]);
      return { removed: true, collectionId, videoId };
    }
  };

  const listed = await invokeRoute({ method: "GET", pathname: "/api/short-videos/collections", store: fixtureStore });
  assert.equal(listed.status, 200);
  assert.deepEqual(calls, ["list"]);

  let gateCalls = 0;
  const created = await invokeRoute({
    method: "POST",
    pathname: "/api/short-videos/collections",
    body: { name: "API fixture" },
    store: fixtureStore,
    requireLocalAdmin: () => {
      gateCalls += 1;
      return true;
    }
  });
  assert.equal(created.status, 201);
  assert.equal(gateCalls, 1, "collection creation must use the trusted same-origin gate");

  const renamed = await invokeRoute({
    method: "PATCH",
    pathname: "/api/short-videos/collections/svc_fixture",
    body: { name: "Renamed" },
    store: fixtureStore,
    requireLocalAdmin: () => {
      gateCalls += 1;
      return true;
    }
  });
  assert.equal(renamed.status, 200);
  assert.deepEqual(calls.at(-1), ["rename", "svc_fixture", { name: "Renamed" }]);

  const videos = await invokeRoute({
    method: "GET",
    pathname: "/api/short-videos/collections/svc_fixture/videos?offset=12",
    store: fixtureStore
  });
  assert.equal(videos.status, 200);
  assert.deepEqual(calls.at(-1), ["videos", "svc_fixture", "12"]);

  const added = await invokeRoute({
    method: "PUT",
    pathname: "/api/short-videos/collections/svc_fixture/videos/fixture-video-b",
    store: fixtureStore,
    requireLocalAdmin: () => {
      gateCalls += 1;
      return true;
    }
  });
  assert.equal(added.status, 200);
  assert.deepEqual(calls.at(-1), ["add", "svc_fixture", "fixture-video-b"]);
  assert.equal(gateCalls, 3);

  const removed = await invokeRoute({
    method: "DELETE",
    pathname: "/api/short-videos/collections/svc_fixture/videos/fixture-video-b",
    store: fixtureStore,
    requireLocalAdmin: () => {
      gateCalls += 1;
      return true;
    }
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(calls.at(-1), ["remove", "svc_fixture", "fixture-video-b"]);

  const deleted = await invokeRoute({
    method: "DELETE",
    pathname: "/api/short-videos/collections/svc_fixture",
    store: fixtureStore,
    requireLocalAdmin: () => {
      gateCalls += 1;
      return true;
    }
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(calls.at(-1), ["delete", "svc_fixture"]);
  assert.equal(gateCalls, 5, "every collection mutation must pass through the trusted same-origin gate");

  const malformed = await invokeRoute({
    method: "GET",
    pathname: "/api/short-videos/collections/%ZZ/videos",
    store: fixtureStore
  });
  assert.equal(malformed.status, 400, "malformed route ids must be rejected as client errors");

  const blockedCallsBefore = calls.length;
  const blocked = await invokeRoute({
    method: "POST",
    pathname: "/api/short-videos/collections",
    body: { name: "Blocked" },
    store: fixtureStore,
    requireLocalAdmin: (_req, res) => {
      res.blocked = true;
      return false;
    }
  });
  assert.equal(blocked.response.blocked, true);
  assert.equal(blocked.status, null);
  assert.equal(calls.length, blockedCallsBefore, "a rejected mutation gate must not reach the store");
}

async function invokeRoute({ method, pathname, body = {}, store, requireLocalAdmin = () => true }) {
  const response = {};
  let sent = null;
  const handled = await routeShortVideoApi(
    { method },
    response,
    new URL(pathname, "http://fixture"),
    {
      notFound() {},
      onMutation() {},
      readJsonBody: async () => body,
      requireLocalAdmin,
      sendJson(_response, status, payload) {
        sent = { status, payload };
      },
      shortVideoStore: store
    }
  );
  assert.equal(handled, true);
  return { status: sent?.status ?? null, payload: sent?.payload, response };
}

function statusError(statusCode) {
  return (error) => {
    assert.equal(error?.statusCode, statusCode);
    return true;
  };
}
