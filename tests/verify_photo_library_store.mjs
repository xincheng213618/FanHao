import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createImageGalleryDbService } from "../src/modules/content-index/server/image-gallery-db-service.js";
import { createImageLibraryIndexService } from "../src/modules/content-index/server/image-library-index-service.js";
import { createImageLibraryService, PHOTO_COLLECTION_SORTS } from "../src/modules/content-index/server/image-library-service.js";
import { createPhotoLibraryStore } from "../src/modules/content-index/server/photo-library-store.js";
import { routeContentIndexApi } from "../src/modules/content-index/server/routes.js";
import { createPhotoSetService } from "../src/modules/photos/server/photo-set-service.js";
import { routePhotosApi } from "../src/modules/photos/server/routes.js";
import { readJsonBody, safeChildPath } from "../src/platform/server/request-io.js";
import { removeVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-photo-library-fixture-"));
const dbPath = path.join(root, "gallery.sqlite");
const jsonPath = path.join(root, "image-library-index.json");
const galleryDb = createImageGalleryDbService({ dbPath, ensureDataDir() {} });
const configuration = { archiveExts: [".zip"], photoSetRoots: [root], galleryMediaSources: [], videoExts: [".mp4"] };
const photoSetService = { coverUrl: (id, stamp) => `/media/gallery-cover/${id}?v=${stamp}` };
const serviceOptions = {
  photoCollectionRootValue: "__root__", photoSetService, maxItemLimit: 1000,
  clampInteger: (value, fallback, min, max) => Math.min(max, Math.max(min, value == null ? fallback : Number(value))),
  imageReaderCacheStatus: () => null
};
const project = createImageLibraryService(serviceOptions).projectPhotoIndex;
const store = createPhotoLibraryStore({ ...configuration, getDb: galleryDb.getDb, project });
const categories = ["秀人网", "人像", "__proto__"];
const snapshot = {
  scannedAt: "2026-10-01T00:00:00Z", roots: [{ root, label: "Fixture", exists: true }], mediaRoots: [],
  mediaItems: [{ id: "movie", title: "Fixture film", mediaKind: "movie" }],
  photoSets: Array.from({ length: 2400 }, (_, n) => {
    const category = categories[n % categories.length];
    const folder = `${category}/${["摄影", "Ångström", "第2组", "第10组"][n % 4]}-${n % 127}`;
    return {
      id: `album-${n}`, category, title: `专辑 ${n}`, personName: `人物 ${n % 25}`, subCategory: folder.split("/")[1],
      sourceRoot: root, relativePath: `${folder}/No.${n}.zip`, rootLabel: "Fixture", archiveExt: "zip",
      imageCount: n % 10, size: n + 100, updatedAt: new Date(1760000000000 + n % 53).toISOString()
    };
  })
};
const owner = createImageLibraryIndexService({
  ...configuration, photoLibraryStore: store,
  safeStat: () => assert.fail("SQLite browse must not scan the source roots")
});
const legacy = createImageLibraryService({ ...serviceOptions, getImageLibraryIndex: () => snapshot });
const sql = createImageLibraryService({ ...serviceOptions, photoLibraryStore: store, cachePreparedQueries: true,
  getImageLibraryRevision: store.revision,
  getImageLibraryIndex: () => assert.fail("published photo reads must not load the media index") });

function url(pathname, params) {
  return new URL(`${pathname}?${new URLSearchParams(params)}`, "http://fixture");
}

async function api(pathname, params) {
  let body;
  const result = await routeContentIndexApi({ method: "GET" }, {}, url(pathname, params), {
    imageLibraryService: sql, sendJson: (_res, status, data) => { assert.equal(status, 200, data.error); body = data; }
  });
  assert.equal(result, true);
  return body;
}

function comparable(result) {
  const { listRevision, ...rest } = result;
  assert.ok(listRevision);
  return rest;
}

function response() {
  return Object.assign(new EventEmitter(), {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.writableEnded = true; this.body = body; }
  });
}

async function verifyArchiveMarks(id) {
  const photoSetService = createPhotoSetService({
    archiveMarks: store.archiveMarks,
    archiveImagesPayload: async () => ({ images: [] }),
    getImageGalleryDb: galleryDb.getDb,
    photoSetById: owner.photoSetById,
    safeChildPath,
    setArchiveMarkedA: store.setArchiveMarkedA
  });
  function sendJson(res, status, body) { res.writeHead(status); res.end(body); }
  async function request(pathname, { method = "GET", body = "", local = true } = {}) {
    const req = Object.assign(Readable.from([Buffer.from(body)]), { method });
    const res = response();
    const handled = await routePhotosApi(req, res, url(pathname), {
      imageReaderCacheStatus: async () => null, photoSetService, readJsonBody, sendJson,
      requireLocalAdmin(_req, target) {
        if (!local) sendJson(target, 403, { error: "fixture forbids non-admin access" });
        return local;
      },
      notFound: target => sendJson(target, 404, { error: "not found" })
    });
    assert.equal(handled, true);
    return res;
  }
  const itemPath = `/api/photo-sets/${id}`;
  const toggle = (body, options) => request(`${itemPath}/mark`, { method: "PUT", body, ...options });
  const list = () => api("/api/image-library/items", { mode: "photo", photoView: "albums", limit: 1 });
  const baseline = await list();
  assert.equal(baseline.items[0].id, id);
  assert(!Object.hasOwn(baseline.items[0], "markedA"));
  assert.deepEqual(await list(), baseline);
  assert.equal((await toggle('{"markedA":true}', { local: false })).status, 403);
  for (const body of ['{"markedA":"true"}', '{}', '{']) assert.equal((await toggle(body)).status, 400);
  assert.equal((await request("/api/photo-sets/%FF/mark", { method: "PUT", body: '{"markedA":true}' })).status, 400);
  for (const markedA of [true, false]) {
    assert.equal((await request("/api/photo-sets/missing/mark", { method: "PUT", body: JSON.stringify({ markedA }) })).status, 404);
  }
  assert(!store.archiveMarks([id]).has(id));

  for (let repeat = 0; repeat < 2; repeat++) {
    const result = await toggle('{"markedA":true}');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { id, markedA: true });
  }
  const marked = await list();
  assert.deepEqual(marked, { ...baseline, items: [{ ...baseline.items[0], markedA: true }] });
  assert.equal((await request(itemPath)).body.album.markedA, true);

  galleryDb.close();
  assert.equal((await list()).items[0].markedA, true, "marks persist across a SQLite reopen");
  const album = owner.photoSetById(id);
  store.publish({ ...snapshot, photoSets: [album] }, { expectedRevision: store.revision() });
  assert.equal((await list()).items[0].markedA, true, "publishing a new index keeps the mark");
  for (let repeat = 0; repeat < 2; repeat++) {
    const result = await toggle('{"markedA":false}');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { id, markedA: false });
  }
  assert(!Object.hasOwn((await list()).items[0], "markedA"));
  assert(!Object.hasOwn((await request(itemPath)).body.album, "markedA"));
}

try {
  fs.writeFileSync(jsonPath, "invalid JSON must never be read or overwritten");
  assert.equal(owner.photoSetById("album-501"), null, "empty SQLite stays empty until a scan or explicit import");
  store.publish(snapshot, { photo: true, media: true, expectedRevision: "", expectedMediaRevision: "" });
  const warmPlan = store.coverWarmPlan();
  const warmIds = warmPlan.flatMap(group => group.albums);
  assert.ok(warmPlan.every(group => group.title && group.albums.length));
  assert.deepEqual(new Set(warmIds), new Set(snapshot.photoSets.map(album => album.id)));
  assert.equal(warmIds.length, snapshot.photoSets.length, "the warm plan queues each published album once");
  galleryDb.close();
  assert.equal(store.index().photoSets.length, 2400);
  assert.deepEqual(owner.getMediaIndex().mediaItems, snapshot.mediaItems);
  const overview = await api("/api/image-library/summary", { mode: "photo", cache: "0" });
  assert.equal(overview.totals.photoSets, 2400);
  assert.equal(overview.totals.photoBytes, snapshot.photoSets.reduce((sum, item) => sum + item.size, 0));
  assert.equal(overview.photoRoots[0].root, root);

  const db = galleryDb.getDb(), prepare = db.prepare.bind(db);
  let collectionRows = 0, archiveRows = 0;
  db.prepare = query => {
    const statement = prepare(query);
    if (!/^SELECT data_json FROM photo_library_/u.test(query)) return statement;
    return { all(...args) {
      const rows = statement.all(...args);
      if (query.includes("photo_library_collections")) collectionRows += rows.length;
      else archiveRows += rows.length;
      return rows;
    } };
  };
  for (const category of ["all", ...categories, "unknown"]) {
    for (const sort of PHOTO_COLLECTION_SORTS) {
      for (const locale of ["zh-CN", "en-US"]) {
        const params = { mode: "photo", photoView: "collections", collectionPage: 1, collectionLocale: locale, category, sort, limit: 17, offset: 80 };
        const before = collectionRows;
        const result = await api("/api/image-library/items", params);
        assert.deepEqual(comparable(result), comparable(legacy.itemsPayload(url("/api/image-library/items", params))));
        assert.equal(collectionRows - before, result.count);
        assert(result.count <= 17);
      }
    }
  }
  assert.equal(archiveRows, 0);
  const deepParams = { mode: "photo", photoView: "albums", collection: project(snapshot, []).archives[0].collectionId, limit: 1 };
  const detail = await api("/api/image-library/items", deepParams);
  assert.deepEqual(comparable(detail), comparable(legacy.itemsPayload(url("/api/image-library/items", deepParams))));
  assert(archiveRows > 0 && archiveRows < snapshot.photoSets.length);
  assert.equal(owner.photoSetById("album-501").id, "album-501");
  assert.equal(owner.photoSetById("unknown"), null);
  db.prepare = prepare;

  const first = store.revision();
  assert.throws(() => store.publish({ ...snapshot, photoSets: [snapshot.photoSets[0], snapshot.photoSets[0]] }), /UNIQUE/);
  assert.equal(store.revision(), first);
  assert.equal(store.summary().totals.photoSets, 2400);
  assert.throws(() => store.publish(snapshot, { expectedRevision: "stale" }), /已更新/);
  assert.equal(store.revision(), first);
  const firstMedia = store.mediaRevision();
  const broken = { ...snapshot, photoSets: snapshot.photoSets.slice(0, 1), mediaItems: [snapshot.mediaItems[0], snapshot.mediaItems[0]] };
  assert.throws(() => store.publish(broken, { photo: true, media: true }), /UNIQUE/);
  assert.equal(store.revision(), first, "a media write failure rolls back its accompanying photo publication");
  assert.equal(store.mediaRevision(), firstMedia);
  assert.deepEqual(store.mediaIndex().mediaItems, snapshot.mediaItems);
  assert.throws(() => store.publish(broken, { photo: true, media: true, expectedMediaRevision: "stale" }), /已更新/);
  assert.equal(store.revision(), first);

  const album = snapshot.photoSets[0];
  const archivePath = safeChildPath(album.sourceRoot, album.relativePath);
  const mtime = Date.parse(album.updatedAt);
  const signature = JSON.stringify([archivePath, album.size, mtime, "1", "2"]);
  const coverBlob = Buffer.from([255, 216, 255, 217]);
  db.prepare(`INSERT INTO photo_set_covers(album_id, archive_path, archive_size, archive_mtime_ms,
    archive_identity, cover_mime, cover_blob, generator_version, status, updated_at)
    VALUES (?, ?, ?, ?, ?, 'image/jpeg', ?, 2, 'ok', '')`).run(album.id, archivePath, album.size, mtime, signature, coverBlob);
  let stats = 0, archiveLists = 0;
  const covers = createPhotoSetService({
    coverGeneratorVersion: 2, getImageGalleryDb: galleryDb.getDb, safeChildPath,
    photoSetById: owner.photoSetById, publishedPhotoSetById: owner.publishedPhotoSetById,
    archiveImageSignature: async () => { stats++; return { archivePath, archiveSize: album.size, archiveMtimeMs: mtime,
      archiveIdentity: JSON.stringify([archivePath, album.size, mtime, "1", "3"]) }; },
    listArchiveImages: async () => { archiveLists++; return []; },
    notFound: res => { res.writeHead(404); res.end(); }
  });
  try {
    const legacyCover = response();
    await covers.serveCover(legacyCover, album.id);
    assert.equal(stats, 0);
    assert.deepEqual(legacyCover.body, coverBlob);

    const changedAlbum = { ...album, archiveIdentity: JSON.stringify([archivePath, album.size, mtime, "1", "3"]) };
    store.publish({ ...snapshot, photoSets: [changedAlbum] }, { expectedRevision: first });
    assert.notEqual(store.revision(), first);
    assert.equal(store.mediaRevision(), firstMedia, "photo publication leaves the media revision untouched");
    assert.match(owner.photoSetById(album.id).coverUrl, /[?&]sig=[a-f0-9]+/);
    const missingCover = response();
    const pending = covers.serveCover(missingCover, album.id, { fallback: true });
    assert.equal(missingCover.writableEnded, undefined);
    await pending;
    assert.equal(missingCover.status, 200);
    assert.match(missingCover.headers["Content-Type"], /^image\/svg\+xml/);
    assert.equal(archiveLists, 1);
    assert(stats > 0);
    const priorStats = stats;
    await covers.serveCover(response(), album.id, { fallback: true });
    assert.equal(stats, priorStats, "known negative covers also avoid waking the source disk");
  } finally {
    await covers.stop();
  }
  await verifyArchiveMarks(album.id);
  assert.equal(fs.readFileSync(jsonPath, "utf8"), "invalid JSON must never be read or overwritten");
  console.log(`photo-library-sqlite: single source, atomic photo and media publication, ${collectionRows} paged DTOs, indexed lookups, cover reuse and durable archive marks passed`);
} finally {
  galleryDb.close();
  removeVerifiedTempDir(root);
}
