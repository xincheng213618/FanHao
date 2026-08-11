import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { routeShortVideoApi } from "../src/modules/short-videos/server/routes.js";
import { ensureShortVideoCollectionSchema } from "../src/modules/short-videos/server/schema.js";
import { createShortVideoStore } from "../src/modules/short-videos/server/store.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-short-video-collections-"));
const dbPath = path.join(tempRoot, "short-videos.sqlite");
let pageCountHook = null;
const store = createShortVideoStore({
  dbPath,
  coverDbPath: path.join(tempRoot, "short-video-covers.sqlite"),
  roots: [],
  skipStartupMaintenance: true,
  collectionTestHooks: {
    afterCollectionPageCount(context) {
      pageCountHook?.(context);
    }
  }
});

try {
  const fixtures = verifyStoreContract();
  await verifyRouteContract(fixtures);
  await verifyBusyContract(fixtures);
  await verifyInjectedBusyPhases();
  verifyLegacyMigration();
  console.log("short-video-collections: ok (cursor, native offset fallback, detail, constraints, concurrency, busy)");
} finally {
  store.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function verifyStoreContract() {
  assert.deepEqual(store.listCollections(), { collections: [], total: 0 });
  const db = openFixtureDatabase(dbPath);
  try {
    insertFixtureVideo(db, "fixture-video-a", "10000001", "Fixture A");
    insertFixtureVideo(db, "fixture-video-b", "10000002", "Fixture B");
    insertFixtureVideo(db, "fixture-video-c", "10000003", "Fixture C");
    insertFixtureVideo(db, "fixture-outsider", "10000004", "Fixture outsider");
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
  assert.equal(store.renameCollection(favorites.id, { name: "旅行" }).collection.name, "旅行");
  assert.throws(() => store.renameCollection("collections", { name: "保留 ID" }), statusError(400));
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

  verifyCursorSnapshot(watchLater);
  verifyCollectionDetail(watchLater);
  verifyDatabaseConstraints(watchLater);

  const removed = store.removeCollectionVideo(watchLater.id, "fixture-video-a");
  assert.equal(removed.removed, true);
  assert.equal(store.removeCollectionVideo(watchLater.id, "fixture-video-a").removed, false, "remove must be idempotent");
  assert.throws(() => store.removeCollectionVideo(watchLater.id, "unknown-video"), statusError(404));
  store.addCollectionVideo(watchLater.id, "fixture-video-a");

  const cascadeDb = openFixtureDatabase(dbPath);
  try {
    cascadeDb.prepare("DELETE FROM short_videos WHERE id = ?").run("fixture-video-a");
    assert.equal(cascadeDb.prepare(`
      SELECT COUNT(*) AS count FROM short_video_collection_items
      WHERE collection_id = ? AND video_id = ?
    `).get(watchLater.id, "fixture-video-a").count, 0, "video FK must cascade collection membership");
  } finally {
    cascadeDb.close();
  }

  const deleted = store.deleteCollection(watchLater.id);
  assert.equal(deleted.removedItems, 2);
  assert.throws(() => store.listCollectionVideos(watchLater.id), statusError(404));
  assert.throws(() => store.deleteCollection(watchLater.id), statusError(404));
  return { busyCollection: favorites, outsiderId: "fixture-outsider" };
}

function verifyCursorSnapshot(collection) {
  const writer = openFixtureDatabase(dbPath);
  try {
    writer.prepare(`
      UPDATE short_video_collection_items SET added_at = ?
      WHERE collection_id = ? AND video_id = ?
    `).run("2026-01-01T00:00:00.000Z", collection.id, "fixture-video-a");
    writer.prepare(`
      UPDATE short_video_collection_items SET added_at = ?
      WHERE collection_id = ? AND video_id = ?
    `).run("2026-01-02T00:00:00.000Z", collection.id, "fixture-video-b");
    let insertedDuringSnapshot = false;
    pageCountHook = () => {
      if (insertedDuringSnapshot) return;
      insertedDuringSnapshot = true;
      writer.prepare(`
        INSERT INTO short_video_collection_items (collection_id, video_id, added_at)
        VALUES (?, ?, ?)
      `).run(collection.id, "fixture-video-c", "2026-01-03T00:00:00.000Z");
    };
    const firstPage = store.listCollectionVideos(
      collection.id,
      new URL("http://fixture/api/short-videos/collections/list/videos?limit=1")
    );
    pageCountHook = null;
    assert.equal(firstPage.total, 2, "COUNT and rows must share the pre-insert read snapshot");
    assert.equal(firstPage.count, 1);
    assert.equal(firstPage.hasMore, true);
    assert.ok(firstPage.nextCursor);
    assert.equal(firstPage.videos[0].id, "fixture-video-b", "a concurrent front insert must not shift the page");

    const secondUrl = new URL("http://fixture/api/short-videos/collections/list/videos?limit=1");
    secondUrl.searchParams.set("cursor", firstPage.nextCursor);
    secondUrl.searchParams.set("offset", "999999");
    const secondPage = store.listCollectionVideos(collection.id, secondUrl);
    assert.equal(secondPage.videos[0].id, "fixture-video-a");
    assert.equal(secondPage.offset, 0, "a valid keyset cursor must take precedence over fallback offset");
    assert.equal(secondPage.hasMore, false);
    assert.equal(new Set([...firstPage.videos, ...secondPage.videos].map((video) => video.id)).size, 2);
    assert.equal(store.listCollectionVideos(collection.id).videos[0].id, "fixture-video-c", "refresh must reveal the concurrent insert");
    assert.throws(() => store.listCollectionVideos(
      collection.id,
      new URL("http://fixture/api/short-videos/collections/list/videos?cursor=not-a-valid-cursor")
    ), statusError(400));
  } finally {
    pageCountHook = null;
    writer.close();
  }
}

function verifyCollectionDetail(collection) {
  assert.throws(() => store.collectionVideoDetail(collection.id, "fixture-outsider"), statusError(404));
  const many = store.createCollection({ name: "分页详情" }).collection;
  const db = openFixtureDatabase(dbPath);
  try {
    db.exec("BEGIN IMMEDIATE");
    const insertItem = db.prepare(`
      INSERT INTO short_video_collection_items (collection_id, video_id, added_at)
      VALUES (?, ?, ?)
    `);
    for (let index = 0; index < 52; index += 1) {
      const id = `many-video-${String(index).padStart(2, "0")}`;
      insertFixtureVideo(db, id, `2000${String(index).padStart(4, "0")}`, `Many ${index}`);
      insertItem.run(many.id, id, new Date(Date.UTC(2026, 1, 1, 0, 0, index)).toISOString());
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    db.close();
  }
  const firstPage = store.listCollectionVideos(many.id);
  assert.equal(firstPage.videos.length, 48);
  assert.equal(firstPage.videos.some((video) => video.id === "many-video-01"), false);
  const nativeFallback = store.listCollectionVideos(
    many.id,
    new URL("http://fixture/api/short-videos/collections/list/videos?offset=36&limit=10")
  );
  assert.equal(nativeFallback.offset, 36, "Native no-cursor recovery must echo its bounded offset");
  assert.deepEqual(
    nativeFallback.videos.map((video) => video.id),
    Array.from({ length: 10 }, (_, index) => `many-video-${String(15 - index).padStart(2, "0")}`),
    "Native no-cursor recovery must continue from the emitted WebView slice boundary"
  );
  assert.ok(nativeFallback.nextCursor, "a non-final offset fallback page must convert subsequent requests back to keyset pagination");
  const boundedFallback = store.listCollectionVideos(
    many.id,
    new URL("http://fixture/api/short-videos/collections/list/videos?offset=-10&limit=999")
  );
  assert.equal(boundedFallback.offset, 0, "fallback offset must be clamped to the collection start");
  assert.equal(boundedFallback.limit, 120, "fallback requests must retain the collection API page-size ceiling");
  const maximumFallback = store.listCollectionVideos(
    many.id,
    new URL("http://fixture/api/short-videos/collections/list/videos?offset=1000001&limit=1")
  );
  assert.equal(maximumFallback.offset, 1_000_000, "fallback offset must have a finite scan budget");
  assert.equal(maximumFallback.videos.length, 0);
  const afterNativeFallbackUrl = new URL("http://fixture/api/short-videos/collections/list/videos?offset=1&limit=10");
  afterNativeFallbackUrl.searchParams.set("cursor", nativeFallback.nextCursor);
  const afterNativeFallback = store.listCollectionVideos(many.id, afterNativeFallbackUrl);
  assert.equal(afterNativeFallback.offset, 0, "cursor continuation after fallback must ignore any stale offset");
  assert.deepEqual(
    afterNativeFallback.videos.map((video) => video.id),
    ["many-video-05", "many-video-04", "many-video-03", "many-video-02", "many-video-01", "many-video-00"],
    "cursor continuation after fallback must have no gap or duplicate"
  );
  const deepMember = store.collectionVideoDetail(many.id, "many-video-01");
  assert.equal(deepMember.video.id, "many-video-01", "detail must resolve a member beyond the first page");
  assert.equal(deepMember.prevId, "many-video-02");
  assert.equal(deepMember.nextId, "many-video-00");
  assert.equal(deepMember.prevVideo.id, "many-video-02");
  assert.equal(deepMember.nextVideo.id, "many-video-00");

  const cascadeDb = openFixtureDatabase(dbPath);
  try {
    cascadeDb.prepare("DELETE FROM short_video_collections WHERE id = ?").run(many.id);
    assert.equal(cascadeDb.prepare(`
      SELECT COUNT(*) AS count FROM short_video_collection_items WHERE collection_id = ?
    `).get(many.id).count, 0, "collection FK must cascade membership");
  } finally {
    cascadeDb.close();
  }
}

function verifyDatabaseConstraints(collection) {
  const db = openFixtureDatabase(dbPath);
  try {
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    const foreignKeys = db.prepare("PRAGMA foreign_key_list(short_video_collection_items)").all();
    assert.deepEqual(
      new Set(foreignKeys.map((row) => `${row.from}:${row.table}:${row.on_delete}`)),
      new Set(["collection_id:short_video_collections:CASCADE", "video_id:short_videos:CASCADE"])
    );
    assert.throws(() => db.prepare(`
      INSERT INTO short_video_collections (
        id, local_user_id, name, normalized_name, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("svc_duplicate_fixture", "local:self", "duplicate", "稍后 看", 99, "", ""), /UNIQUE constraint failed/i);
    assert.ok(collection.id);
  } finally {
    db.close();
  }
}

async function verifyRouteContract(fixtures) {
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
      calls.push([
        "videos",
        collectionId,
        url.searchParams.get("cursor"),
        url.searchParams.get("offset"),
        url.searchParams.get("limit")
      ]);
      return { collection: { id: collectionId }, videos: [], total: 0, offset: 0 };
    },
    collectionVideoDetail(collectionId, videoId) {
      calls.push(["detail", collectionId, videoId]);
      return { collection: { id: collectionId }, video: { id: videoId }, prevId: "", nextId: "" };
    },
    addCollectionVideo(collectionId, videoId) {
      calls.push(["add", collectionId, videoId]);
      return { added: true, collectionId, videoId };
    },
    removeCollectionVideo(collectionId, videoId) {
      calls.push(["remove", collectionId, videoId]);
      return { removed: true, collectionId, videoId };
    },
    videoDetail(videoId) {
      calls.push(["video-detail", videoId]);
      return { video: { id: videoId } };
    }
  };

  const listed = await invokeRoute({ method: "GET", pathname: "/api/short-videos/collections", store: fixtureStore });
  assert.equal(listed.status, 200);
  assert.deepEqual(calls, ["list"]);
  const reservedVideoDetail = await invokeRoute({
    method: "GET",
    pathname: "/api/short-videos/videos/collections",
    store: fixtureStore
  });
  assert.equal(reservedVideoDetail.status, 200);
  assert.deepEqual(calls.at(-1), ["video-detail", "collections"], "the explicit detail API must not collide with the collection index");

  let gateCalls = 0;
  const gate = () => {
    gateCalls += 1;
    return true;
  };
  assert.equal((await invokeRoute({
    method: "POST",
    pathname: "/api/short-videos/collections",
    body: { name: "API fixture" },
    store: fixtureStore,
    requireLocalAdmin: gate
  })).status, 201);
  assert.equal((await invokeRoute({
    method: "PATCH",
    pathname: "/api/short-videos/collections/svc_fixture",
    body: { name: "Renamed" },
    store: fixtureStore,
    requireLocalAdmin: gate
  })).status, 200);
  const videos = await invokeRoute({
    method: "GET",
    pathname: "/api/short-videos/collections/svc_fixture/videos?cursor=fixture-cursor&offset=36&limit=48",
    store: fixtureStore
  });
  assert.equal(videos.status, 200);
  assert.deepEqual(
    calls.at(-1),
    ["videos", "svc_fixture", "fixture-cursor", "36", "48"],
    "the collection route must preserve cursor, bounded offset fallback, and limit for repository precedence"
  );
  const detail = await invokeRoute({
    method: "GET",
    pathname: "/api/short-videos/collections/svc_fixture/videos/fixture-video-b",
    store: fixtureStore
  });
  assert.equal(detail.status, 200);
  assert.deepEqual(calls.at(-1), ["detail", "svc_fixture", "fixture-video-b"]);
  assert.equal((await invokeRoute({
    method: "PUT",
    pathname: "/api/short-videos/collections/svc_fixture/videos/fixture-video-b",
    store: fixtureStore,
    requireLocalAdmin: gate
  })).status, 200);
  assert.equal((await invokeRoute({
    method: "DELETE",
    pathname: "/api/short-videos/collections/svc_fixture/videos/fixture-video-b",
    store: fixtureStore,
    requireLocalAdmin: gate
  })).status, 200);
  assert.equal((await invokeRoute({
    method: "DELETE",
    pathname: "/api/short-videos/collections/svc_fixture",
    store: fixtureStore,
    requireLocalAdmin: gate
  })).status, 200);
  assert.equal(gateCalls, 5, "every collection mutation must pass through the trusted same-origin gate");

  const outsider = await invokeRoute({
    method: "GET",
    pathname: `/api/short-videos/collections/${fixtures.busyCollection.id}/videos/${fixtures.outsiderId}`,
    store
  });
  assert.equal(outsider.status, 404, "the real route must reject a non-member detail request");
  assert.equal((await invokeRoute({
    method: "GET",
    pathname: "/api/short-videos/collections/%ZZ/videos",
    store: fixtureStore
  })).status, 400);

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
  assert.equal(calls.length, blockedCallsBefore);

  const busyError = Object.assign(new Error("短视频数据库正忙，请稍后重试"), {
    statusCode: 503,
    retryable: true
  });
  const busyResponse = await invokeRoute({
    method: "GET",
    pathname: "/api/short-videos/collections",
    store: { listCollections() { throw busyError; } }
  });
  assert.equal(busyResponse.status, 503);
  assert.deepEqual(
    busyResponse.payload,
    { error: "短视频数据库正忙，请稍后重试", retryable: true },
    "only a sanitized BUSY wrapper may advertise retryability"
  );

  for (const fixture of [
    { error: new Error("database disk image is malformed"), status: 503 },
    { error: Object.assign(new Error("permanent service failure"), { statusCode: 503 }), status: 503 },
    { error: Object.assign(new Error("server failure"), { statusCode: 500 }), status: 500 },
    { error: Object.assign(new Error("name conflict"), { statusCode: 409 }), status: 409 }
  ]) {
    const response = await invokeRoute({
      method: "GET",
      pathname: "/api/short-videos/collections",
      store: { listCollections() { throw fixture.error; } }
    });
    assert.equal(response.status, fixture.status);
    assert.equal(Object.hasOwn(response.payload || {}, "retryable"), false, `HTTP ${fixture.status} must not invent retryability`);
  }
}

async function verifyBusyContract({ busyCollection }) {
  const locker = openFixtureDatabase(dbPath);
  locker.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  const startedAt = performance.now();
  try {
    const response = await invokeRoute({
      method: "PATCH",
      pathname: `/api/short-videos/collections/${busyCollection.id}`,
      body: { name: "锁测试" },
      store,
      requireLocalAdmin: () => true
    });
    assert.equal(response.status, 503);
    assert.equal(response.payload.retryable, true);
    assert.equal(response.payload.error, "短视频数据库正忙，请稍后重试");
    assert.ok(performance.now() - startedAt < 250, "one locked collection mutation must keep a sub-250ms server budget");
  } finally {
    locker.exec("ROLLBACK");
    locker.close();
  }
}

async function verifyInjectedBusyPhases() {
  const phasePath = path.join(tempRoot, "busy-phases.sqlite");
  let failurePhase = "";
  let phaseDatabase = null;
  const phaseStore = createShortVideoStore({
    dbPath: phasePath,
    coverDbPath: path.join(tempRoot, "busy-phases-covers.sqlite"),
    roots: [],
    skipStartupMaintenance: true,
    collectionTestHooks: {
      beforeCollectionTransactionStatement(context) {
        phaseDatabase = context.db;
        if (failurePhase === "begin" && context.statement.startsWith("BEGIN")) {
          const error = new Error("SQLITE_BUSY while beginning fixture transaction");
          error.code = "SQLITE_BUSY";
          throw error;
        }
        if (failurePhase === "commit" && context.statement === "COMMIT") {
          const error = new Error("database table is locked near short_video_collections fixture SQL");
          error.errno = 5;
          throw error;
        }
      },
      afterCollectionTransactionWork(context) {
        phaseDatabase = context.db;
        if (failurePhase !== "middle") return;
        const error = new Error("fixture SQL must never cross the HTTP boundary");
        error.errcode = 5;
        throw error;
      }
    }
  });
  const startedAt = performance.now();
  try {
    for (const phase of ["begin", "middle", "commit"]) {
      failurePhase = phase;
      const response = await invokeRoute({
        method: "POST",
        pathname: "/api/short-videos/collections",
        body: { name: `busy-${phase}` },
        store: phaseStore,
        requireLocalAdmin: () => true
      });
      assert.equal(response.status, 503, `${phase} busy failures must be retryable service-unavailable responses`);
      assert.deepEqual(response.payload, {
        error: "短视频数据库正忙，请稍后重试",
        retryable: true
      });
      assert.equal(phaseDatabase?.isTransaction, false, `${phase} failure must not leave a transaction open`);
      assert.doesNotMatch(JSON.stringify(response.payload), /SELECT|INSERT|UPDATE|DELETE|short_video_collections|fixture SQL/i);
      failurePhase = "";
      assert.equal(phaseStore.listCollections().total, 0, `${phase} failure must roll back all collection writes`);
    }
    assert.ok(performance.now() - startedAt < 2500, "BEGIN/middle/COMMIT busy retries must have a bounded total wait budget");
    assert.equal(phaseStore.createCollection({ name: "事务已恢复" }).collection.name, "事务已恢复");
  } finally {
    phaseStore.close();
  }
}

function verifyLegacyMigration() {
  const legacyPath = path.join(tempRoot, "legacy-short-videos.sqlite");
  const legacyOptions = {
    dbPath: legacyPath,
    coverDbPath: path.join(tempRoot, "legacy-short-video-covers.sqlite"),
    roots: [],
    skipStartupMaintenance: true
  };
  const freshStore = createShortVideoStore(legacyOptions);
  freshStore.listCollections();
  freshStore.close();
  const legacy = new DatabaseSync(legacyPath);
  try {
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE short_video_collection_items;
      DROP TABLE short_video_collections;
      CREATE TABLE short_video_collections (
        id TEXT PRIMARY KEY,
        local_user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE short_video_collection_items (
        collection_id TEXT NOT NULL,
        video_id TEXT NOT NULL,
        added_at TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(collection_id, video_id)
      );
      INSERT INTO short_video_collections VALUES ('legacy-a', 'local:self', '  稍后　看 ', 0, '', '');
      INSERT INTO short_video_collections VALUES ('legacy-b', 'local:self', '稍后 看', 1, '', '');
      INSERT INTO short_video_collection_items VALUES ('legacy-a', 'missing-video', '');
      UPDATE short_video_meta SET value = 'legacy' WHERE key = 'schema_version';
    `);
  } finally {
    legacy.close();
  }
  const migrationDb = new DatabaseSync(legacyPath);
  try {
    migrationDb.exec("PRAGMA foreign_keys = OFF");
    assert.equal(migrationDb.prepare("PRAGMA foreign_keys").get().foreign_keys, 0);
    assert.throws(() => ensureShortVideoCollectionSchema(migrationDb, {
      afterCreateNextTables({ db }) {
        db.exec("CREATE TABLE short_video_collections (id TEXT)");
      }
    }), /short_video_collections already exists/i, "a conflicting DDL statement must abort the whole migration");
    assert.equal(migrationDb.isTransaction, false, "failed collection DDL migration must not leak its transaction");
    assert.equal(migrationDb.prepare("PRAGMA foreign_keys").get().foreign_keys, 0, "failed migration must restore foreign_keys=OFF");
    assert.deepEqual(
      migrationDb.prepare("PRAGMA table_info(short_video_collections)").all().map((row) => row.name),
      ["id", "local_user_id", "name", "sort_order", "created_at", "updated_at"],
      "failed DDL migration must leave the original table intact"
    );
    assert.equal(migrationDb.prepare("SELECT COUNT(*) AS count FROM short_video_collections").get().count, 2);
    assert.equal(migrationDb.prepare("SELECT COUNT(*) AS count FROM short_video_collection_items").get().count, 1);
    assert.equal(migrationDb.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name IN ('short_video_collections_next', 'short_video_collection_items_next')
    `).get().count, 0, "failed DDL migration must roll back both temporary tables");

    migrationDb.exec("PRAGMA foreign_keys = ON");
    ensureShortVideoCollectionSchema(migrationDb);
    assert.equal(migrationDb.prepare("PRAGMA foreign_keys").get().foreign_keys, 1, "successful migration must restore foreign_keys=ON");
    const finalForeignKeys = migrationDb.prepare("PRAGMA foreign_key_list(short_video_collection_items)").all();
    assert.deepEqual(
      new Set(finalForeignKeys.map((row) => `${row.from}:${row.table}:${row.to}:${row.on_delete}`)),
      new Set([
        "collection_id:short_video_collections:id:CASCADE",
        "video_id:short_videos:id:CASCADE"
      ]),
      "renamed collection item FKs must target the final production table names"
    );
    assert.equal(migrationDb.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.equal(migrationDb.prepare("SELECT COUNT(*) AS count FROM short_video_collection_items").get().count, 0, "legacy orphan memberships must not survive FK migration");
  } finally {
    migrationDb.close();
  }
  const migratedStore = createShortVideoStore(legacyOptions);
  try {
    const migrated = migratedStore.listCollections().collections;
    assert.equal(migrated.length, 2);
    assert.equal(new Set(migrated.map((collection) => collection.name.toLowerCase())).size, 2, "legacy duplicate names must migrate deterministically");
  } finally {
    migratedStore.close();
  }
}

function openFixtureDatabase(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA busy_timeout = 1000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON");
  return db;
}

function insertFixtureVideo(db, id, awemeId, title) {
  db.prepare(`
    INSERT INTO short_videos (id, aweme_id, title, source_path, published_at, liked_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, awemeId, title, `${id}.mp4`, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
}

async function invokeRoute({ method, pathname, body = {}, store: fixtureStore, requireLocalAdmin = () => true }) {
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
      shortVideoStore: fixtureStore
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
