import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createImageGalleryDbService } from "../src/modules/content-index/server/image-gallery-db-service.js";
import { createPhotoCategoryCoverStore, PHOTO_CATEGORY_COVER_MAX_BYTES, PHOTO_CATEGORY_COVER_ROUTE } from "../src/modules/content-index/server/photo-category-cover-store.js";
import { createPhotoLibraryStore } from "../src/modules/content-index/server/photo-library-store.js";
import { routeContentIndexApi } from "../src/modules/content-index/server/routes.js";
import { ARCHIVE_IMAGE_INDEXER_VERSION } from "../src/platform/server/archive-image-service.js";
import { sendJson } from "../src/platform/server/responses.js";
import { removeVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "fanhao-photo-category-cover-"));
const galleryDb = createImageGalleryDbService({ dbPath: path.join(fixtureRoot, "gallery.sqlite"), ensureDataDir() {} });
const photoLibraryStore = createPhotoLibraryStore({ getDb: galleryDb.getDb, photoSetRoots: [fixtureRoot], archiveExts: [".zip"],
  project: snapshot => ({ archives: snapshot.photoSets.map(album => ({ album, collectionId: album.collectionId })),
    pages: [], overview: {}, facets: {}, scopes: {} }) });
const photoSetCoverUrl = (id, stamp = "") => `/media/gallery-cover/${encodeURIComponent(id)}${stamp ? `?v=${encodeURIComponent(stamp)}` : ""}`;
const store = createPhotoCategoryCoverStore({ getDb: galleryDb.getDb, getPhotoRevision: photoLibraryStore.revision, photoSetCoverUrl });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMJ8AAAAASUVORK5CYII=", "base64");
const jpeg = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8Af3//2Q==";
const webp = "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vz0AAA=";
const admin = { "X-Fixture-Admin": "yes" };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture");
  const routed = await routeContentIndexApi(req, res, url, {
    photoCategoryCoverStore: store, photoLibraryStore, sendJson,
    requireLocalAdmin(request, response) {
      if (request.headers["x-fixture-admin"] === "yes") return true;
      sendJson(response, 403, { error: "admin required" });
      return false;
    }
  });
  if (!routed) sendJson(res, 404, {});
});

try {
  const db = galleryDb.getDb();
  db.exec(`INSERT INTO photo_browse_categories (id, name, parent_id, source_category, position) VALUES
    ('fixture-group', 'Group', NULL, '[Own]', 0),
    ('fixture-child', 'Child', 'fixture-group', '[Child]', 0),
    ('fixture-grandchild', 'Grandchild', 'fixture-child', '[Grandchild]', 0);
    INSERT INTO photo_publishers VALUES ('fixture', 'Publisher', '');
    INSERT INTO photo_publisher_members VALUES ('fixture', 'collection', 'owned', '', 0);`);
  const updatedAt = "2026-11-08T00:00:00.000Z";
  const longCollectionId = `fixture|${"分组目录/".repeat(60)}利世 + #`;
  const photoSets = [
    { id: "a", title: "Alpha", category: "[Own]", collectionId: "owned" },
    { id: "b", title: "Beta 套图", category: "[Child]", collectionId: "other" },
    { id: "c", title: "Gamma 套图", category: "[Grandchild]", collectionId: "owned" },
    { id: "d", title: "Other", category: "[Other]", collectionId: "other" },
    { id: "e", title: "Long collection", category: "[Grandchild]", collectionId: longCollectionId }
  ].map(album => ({ ...album, updatedAt, sourceRoot: fixtureRoot, relativePath: `${album.id}.zip`, size: 42,
    coverUrl: `${photoSetCoverUrl(album.id, updatedAt)}&sig=fixture` }));
  photoLibraryStore.publish({ photoSets });
  const defaultCoverUrl = `${photoSets[0].coverUrl}&representative=1`;
  db.prepare(`INSERT INTO photo_library_collections (category, sort, locale, position, data_json)
    VALUES ('[Own]', 'count', 'zh-CN', 0, ?)`).run(JSON.stringify({ coverUrl: defaultCoverUrl }));
  const collectionDefaultCoverUrl = photoSets[2].coverUrl;
  db.prepare(`INSERT INTO photo_library_collections (category, sort, locale, position, data_json)
    VALUES ('all', 'count', 'zh-CN', 0, ?)`).run(JSON.stringify({ collectionId: "owned", coverUrl: collectionDefaultCoverUrl }));
  const archivePath = path.join(fixtureRoot, "a.zip");
  const timestamp = Date.parse(updatedAt);
  db.prepare(`INSERT INTO photo_set_image_indexes (archive_path, archive_size, archive_mtime_ms, archive_identity,
    indexer_version, image_count, images_json, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, '')`)
    .run(archivePath, 42, timestamp, JSON.stringify([archivePath, 42, timestamp, "1", "9"]), ARCHIVE_IMAGE_INDEXER_VERSION,
      JSON.stringify([{ path: "folder/COVER.JPG" }]));

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const group = "catalog:fixture-group";
  const publisher = "publisher:fixture";
  const collection = "collection:owned";
  const longCollection = `collection:${longCollectionId}`;
  const endpoint = (category, options = {}) => `${base}${PHOTO_CATEGORY_COVER_ROUTE}?${new URLSearchParams({ category, ...options })}`;
  const get = async (category, options, status = 200) => json(await fetch(endpoint(category, options), { headers: admin }), status);
  const put = async (category, body, status = 200, headers = admin) => json(await fetch(endpoint(category), {
    method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body)
  }), status);

  assert.equal((await fetch(endpoint(group))).status, 403);
  await put(group, { source: "default" }, 403, {});
  const first = await get(group, { limit: 2 });
  assert.deepEqual(first.settings, { source: "default", coverUrl: defaultCoverUrl });
  assert.deepEqual(first.choices, photoSets.slice(0, 2).map(({ id, title, coverUrl }) => ({ id, title, coverUrl })));
  assert.equal(first.total, 4);
  assert.equal(first.nextOffset, 2);
  assert.deepEqual((await get(group, { offset: 2 })).choices.map(album => album.id), ["c", "e"]);
  assert.equal((await get(group, { offset: 2 })).nextOffset, null);
  assert.deepEqual((await get(group, { q: "套图" })).choices.map(album => album.id), ["b", "c"]);
  assert.deepEqual((await get(group, { q: "ALPHA" })).choices.map(album => album.id), ["a"]);
  assert.deepEqual((await get(publisher)).choices.map(album => album.id), ["a", "c"]);
  assert.deepEqual((await get("[Other]")).choices.map(album => album.id), ["d"]);
  await get("catalog:missing", {}, 404);
  await put("all", { source: "default" }, 400);
  await put(group, { source: "album", albumId: "d" }, 400);
  await put(publisher, { source: "album", albumId: "b" }, 400);

  const ownCollection = await get(collection);
  assert.deepEqual(ownCollection.settings, { source: "default", coverUrl: collectionDefaultCoverUrl });
  assert.deepEqual(ownCollection.choices.map(album => album.id), ["a", "c"]);
  const longScope = await get(longCollection);
  assert.ok(longCollection.length > 256);
  assert.deepEqual(longScope.settings, { source: "default", coverUrl: photoSets[4].coverUrl });
  assert.deepEqual(longScope.choices.map(album => album.id), ["e"]);
  await get("collection:", {}, 400);
  await get("collection:missing", {}, 404);
  await get(`collection:${"a".repeat(4096)}`, {}, 400);
  await put(collection, { source: "album", albumId: "e" }, 400);
  await put(longCollection, { source: "album", albumId: "c" }, 400);

  const defaultRevision = store.revision();
  const { settings: selected } = await put("[Own]", { source: "album", albumId: "c" });
  assert.deepEqual(selected, { source: "album", albumId: "c", coverUrl: photoSets[2].coverUrl });
  assert.notEqual(store.revision(), defaultRevision);
  assert.deepEqual((await get(group)).settings, selected);
  assert.deepEqual(store.overrides(["[Own]", group, "[Other]", "all"]), new Map([["[Own]", selected], [group, selected]]));
  await put(publisher, { source: "album", albumId: "c" });
  db.exec("DELETE FROM photo_publisher_members WHERE publisher_id='fixture'");
  assert.equal((await get(publisher)).settings.source, "default");
  assert.equal(store.overrides([publisher]).size, 0);

  const { settings: uploaded } = await put(group, { source: "upload", data: png.toString("base64") });
  assert.equal(uploaded.source, "upload");
  assert.deepEqual(store.overrides([group]).get(group), uploaded);
  galleryDb.close();
  assert.deepEqual((await get("[Own]")).settings, uploaded, "upload settings persist after closing and reopening SQLite");
  const image = await fetch(`${base}${uploaded.coverUrl}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(image.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  const cached = await fetch(`${base}${uploaded.coverUrl}`, { headers: { "If-None-Match": image.headers.get("etag") } });
  assert.equal(cached.status, 304);
  assert.equal((await fetch(`${base}${uploaded.coverUrl}`, { method: "HEAD" })).headers.get("content-length"), String(png.length));
  await put(group, { source: "upload", data: "not base64" }, 400);
  await put(group, { source: "upload", data: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64") }, 415);
  await put(group, { source: "upload", data: Buffer.alloc(PHOTO_CATEGORY_COVER_MAX_BYTES + 1).toString("base64") }, 413);
  assert.deepEqual((await get(group)).settings, uploaded, "failed writes preserve the prior override");
  const { settings: replaced } = await put(group, { source: "upload", data: webp });
  assert.notEqual(replaced.coverUrl, uploaded.coverUrl);
  assert.equal((await fetch(`${base}${uploaded.coverUrl}`)).status, 404);
  assert.equal((await fetch(`${base}${replaced.coverUrl}`, { method: "HEAD" })).headers.get("content-type"), "image/webp");
  const { settings: publisherUpload } = await put(publisher, { source: "upload", data: jpeg });
  assert.equal((await fetch(`${base}${publisherUpload.coverUrl}`, { method: "HEAD" })).headers.get("content-type"), "image/jpeg");
  const revisionBeforeReset = store.revision();
  assert.deepEqual((await put("[Own]", { source: "default" })).settings, first.settings);
  assert.notEqual(store.revision(), revisionBeforeReset);
  assert.equal(store.overrides([group]).size, 0);
  assert.equal((await fetch(`${base}${replaced.coverUrl}`)).status, 404);

  const { settings: collectionSelection } = await put(collection, { source: "album", albumId: "a" });
  const { settings: collectionUpload } = await put(longCollection, { source: "upload", data: png.toString("base64") });
  assert.deepEqual(collectionSelection, { source: "album", albumId: "a", coverUrl: photoSets[0].coverUrl });
  assert.deepEqual(store.overrides([collection, longCollection, group]), new Map([[collection, collectionSelection], [longCollection, collectionUpload]]));
  assert.deepEqual((await get(group)).settings, first.settings, "collection covers do not change their category setting");
  assert.equal((await fetch(`${base}${collectionUpload.coverUrl}`, { method: "HEAD" })).headers.get("content-type"), "image/png");
  assert.deepEqual((await put(longCollection, { source: "default" })).settings, longScope.settings);
  assert.equal((await fetch(`${base}${collectionUpload.coverUrl}`)).status, 404);
  assert.deepEqual((await put(collection, { source: "default" })).settings, ownCollection.settings);

  const counts = `${base}/api/image-library/photo-card-counts`;
  assert.deepEqual(await json(await fetch(`${counts}?ids=a&ids=a&ids=b&ids=missing`), 200), { counts: { a: 0 } });
  assert.deepEqual(await json(await fetch(counts), 200), { counts: {} });
  const excessIds = new URLSearchParams(Array.from({ length: 25 }, (_, index) => ["ids", String(index)]));
  await json(await fetch(`${counts}?${excessIds}`), 400);
  console.log("photo covers: category and collection scopes, authorization, image validation, persistence, revision and card counts verified");
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  galleryDb.close();
  removeVerifiedTempDir(fixtureRoot);
}

async function json(response, status) {
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  return data;
}
