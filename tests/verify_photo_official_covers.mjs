import assert from "node:assert/strict";
import { mkdtempSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createImageGalleryDbService } from "../src/modules/content-index/server/image-gallery-db-service.js";
import { imageLibraryCacheIdentity } from "../src/modules/content-index/server/image-library-index-contract.js";
import { createPhotoSetService } from "../src/modules/photos/server/photo-set-service.js";
import { archiveDiskSignature, ARCHIVE_IMAGE_INDEXER_VERSION } from "../src/platform/server/archive-image-service.js";
import { fetchMetartCover, fetchMetartModel, metartModelSlug } from "../tools/metart_photo_source.mjs";
import { collectionIdFromArg, planOfficialCovers, saveOfficialCovers } from "../tools/sync_photo_official_covers.mjs";

const site = "E6B595104E3411DF98790800200C9A66";
const cdn = `https://gccdn.metartnetwork.com/${site}`;
const slug = "example-person";
const model = { id: "A".repeat(32), name: "Example Person", page: `/model/${slug}`,
  asset: `${cdn}/media/headshots/${slug}.jpg` };
const sample = Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0xff, 0xd9]);

test("MetArt source pins gallery and cover identity, including pagination", async () => {
  assert.equal(metartModelSlug(`https://www.metart.com${model.page}`), slug);
  assert.throws(() => metartModelSlug(`https://www.metart.com.evil.invalid${model.page}`));
  const records = Array.from({ length: 25 }, (_, index) => {
    const UUID = index.toString(16).toUpperCase().padStart(32, "0");
    return { UUID, type: "GALLERY", siteUUID: site, name: `Test ${index}`, publishedAt: "2020-01-01T08:00:00Z",
      path: `${model.page}/gallery/20200101/TEST_${index}`, models: [{ UUID: model.id, path: model.page }],
      hasCover: true, coverImagePath: `/media/${UUID}/cover_${UUID}.jpg` };
  });
  records[23].siteUUID = "B".repeat(32);
  records[24].coverImagePath = "/media/wrong.jpg";
  const offsets = [];
  const got = await fetchMetartModel(slug, (input, options) => {
    const url = new URL(input), after = Number(url.searchParams.get("after"));
    offsets.push(after);
    assert.equal(url.origin, "https://www.metart.com");
    assert.equal(options.redirect, "error");
    return Response.json({ UUID: model.id, name: model.name, siteUUID: site, path: model.page,
      headshotImagePath: `/media/headshots/${slug}.jpg`, latestGalleriesCount: 25, latestGalleries: records.slice(after, after + 24) });
  });
  assert.deepEqual(offsets, [0, 24]);
  assert.equal(got.galleries.length, 24);
  assert.equal(got.asset, model.asset);
  assert.equal(got.galleries.at(-1).asset, null);
  const jpeg = (url, options) => {
    assert.equal(options.redirect, "error");
    return new Response(sample, { headers: { "content-type": "image/jpeg" } });
  };
  assert.deepEqual(await fetchMetartCover(got.galleries[0].asset, { maxBytes: 10, fetchImpl: jpeg }), sample);
  await assert.rejects(fetchMetartCover(got.asset, { maxBytes: 5, fetchImpl: jpeg }), /大小限制/u);
  await assert.rejects(fetchMetartCover(got.asset, { maxBytes: 32, fetchImpl: () => new Response("not an image", {
    headers: { "content-type": "image/jpeg" }
  }) }), /JPEG 不完整/u);
});

test("SQLite import only replaces fallback, is repeatable and serves versioned JPEG", async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fanhao-official-cover-test-"));
  const storage = createImageGalleryDbService({ dbPath: ":memory:", ensureDataDir() {} });
  const files = [];
  t.after(() => { storage.close(); files.forEach(file => rmSync(file)); rmdirSync(root); });
  const db = storage.getDb();
  // Exercise applying from a DB used by the pre-import app as well.
  db.exec("ALTER TABLE photo_set_covers DROP COLUMN official_source; ALTER TABLE photo_category_covers DROP COLUMN official_source;");
  const config = { PHOTO_SET_ROOTS: [root], ARCHIVE_EXTS: new Set(["zip"]), COVER_HINTS: new Set(["poster"]), PHOTO_SET_COVER_GENERATOR_VERSION: 3 };
  const collectionId = `local|${model.name}`;
  assert.equal(collectionIdFromArg(`/photo/collection/raw-${Buffer.from(collectionId).toString("base64url")}?category=catalog%3Alikes`), collectionId);
  const snapshot = imageLibraryCacheIdentity({ archiveExts: config.ARCHIVE_EXTS, photoSetRoots: [root] });
  db.prepare("INSERT INTO photo_library_snapshot VALUES (1, ?, 'snapshot', '', '[]', '{}', '{}', '{}')").run(snapshot);
  const assets = { ...model, galleries: [] }, albums = new Map(), signatures = new Map();
  for (const [index, name] of ["Fallback", "Embedded", "Manual", "Unverified", "Other Publisher"].entries()) {
    const id = `album-${index}`, relativePath = `${id}.zip`, file = path.join(root, relativePath);
    files.push(file);
    writeFileSync(file, id);
    const signature = archiveDiskSignature(file, statSync(file));
    const album = { id, sourceRoot: root, relativePath, title: `${index === 4 ? "Other" : "MetArt"} -2020-01-01 Example Person - ${name} (х25) 1000x2000 _by Artist`,
      subCategory: model.name, size: signature.archiveSize, updatedAt: new Date(signature.archiveMtimeMs).toISOString(),
      archiveIdentity: signature.archiveIdentity, coverUrl: `/media/gallery-cover/${id}` };
    db.prepare("INSERT INTO photo_library_archives VALUES (?,?,?,?)").run(id, index, collectionId, JSON.stringify(album));
    if (index !== 3) db.prepare(`INSERT INTO photo_set_image_indexes(archive_path, archive_identity, image_count, images_json, indexer_version, updated_at)
      VALUES (?,?,1,?,?,'')`).run(file, signature.archiveIdentity, JSON.stringify([{ path: index === 1 ? "poster.jpg" : "first.jpg" }]), ARCHIVE_IMAGE_INDEXER_VERSION);
    assets.galleries.push({ id, title: name, date: "2020-01-01", page: `/example/${index}`, asset: `${cdn}/${id}.jpg` });
    albums.set(id, album); signatures.set(id, signature);
  }
  const initial = planOfficialCovers(db, collectionId, assets, config);
  assert.deepEqual(initial.rows.map(row => row.state), ["ready", "ready", "existing-embedded-cover", "ready", "archive-index-required"]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM photo_set_covers").get().n, 0);
  const manual = (id, revision) => {
    const { archivePath, archiveSize, archiveMtimeMs, archiveIdentity } = signatures.get(id);
    db.prepare("INSERT INTO photo_set_cover_overrides VALUES (?,?,?,?,?, 'first.jpg', 1, ?, ?)")
      .run(id, archivePath, archiveSize, archiveMtimeMs, archiveIdentity, Buffer.from("manual JPEG"), revision);
  };
  manual("album-2", "concurrent");
  const downloads = new Map(initial.rows.filter(row => row.state === "ready").map(row => [row.source.asset, sample]));
  const result = saveOfficialCovers(db, { collectionId, model: assets, config, initial, downloads });
  assert.deepEqual(result.rows.map(row => row.state), ["imported", "imported", "existing-embedded-cover", "existing-custom-cover", "archive-index-required"]);
  const rerun = planOfficialCovers(db, collectionId, assets, config);
  assert.deepEqual(rerun.rows.slice(0, 2).map(row => row.state), ["already-imported", "already-imported"]);

  const service = createPhotoSetService({ coverGeneratorVersion: 4, getImageGalleryDb: () => db,
    publishedPhotoSetById: id => albums.get(id), safeChildPath: path.join });
  t.after(() => service.stop());
  const url = albums.get("album-0").coverUrl;
  const versioned = service.withCoverOverrides([{ coverUrl: url }])[0].coverUrl;
  const revision = new URL(versioned, "http://localhost").searchParams.get("cover");
  assert.match(revision, /^[a-f0-9]{64}$/u);
  const res = { writeHead(code, headers) { this.code = code; this.headers = headers; }, end(body) { this.body = body; } };
  await service.serveCover(res, "album-0", { revision });
  assert.equal(res.code, 200);
  assert.equal(res.headers["Content-Type"], "image/jpeg");
  assert.match(res.headers["Cache-Control"], /max-age/u);
  assert.deepEqual(res.body, sample);
  manual("album-0", "user-selection");
  assert.equal(service.withCoverOverrides([{ coverUrl: url }])[0].coverUrl, `${url}?cover=user-selection`);
  await service.serveCover(res, "album-0", { revision });
  assert.equal(res.body.toString(), "manual JPEG");
});
