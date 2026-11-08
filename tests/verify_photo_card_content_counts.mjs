import assert from "node:assert/strict";
import path from "node:path";
import { createImageGalleryDbService } from "../src/modules/content-index/server/image-gallery-db-service.js";
import { createPhotoLibraryStore } from "../src/modules/content-index/server/photo-library-store.js";
import { ARCHIVE_IMAGE_INDEXER_VERSION } from "../src/platform/server/archive-image-service.js";

const sourceRoot = path.resolve("synthetic-counts-root");
const archiveSize = 29;
const mtimeMs = Date.parse("2026-10-01T09:30:00.123Z") + 0.5;
const dbService = createImageGalleryDbService({ dbPath: ":memory:", ensureDataDir() {} });
const store = createPhotoLibraryStore({ getDb: dbService.getDb, photoSetRoots: [sourceRoot], archiveExts: [".zip"],
  project: snapshot => ({ archives: snapshot.photoSets.map(album => ({ album, collectionId: "fixture" })),
    pages: [], overview: {}, facets: {}, scopes: {} }) });

function signature(archivePath, inode = "12", size = archiveSize, timestamp = mtimeMs) {
  return JSON.stringify([archivePath, size, timestamp, "1", inode]);
}

function album(id, { legacy = false, relativePath = `${id}.zip` } = {}) {
  return { id, sourceRoot, relativePath, size: archiveSize, updatedAt: new Date(mtimeMs).toISOString(),
    ...(legacy ? {} : { archiveIdentity: signature(path.resolve(sourceRoot, relativePath)) }) };
}

try {
  const db = dbService.getDb();
  const rows = [album("complete"), album("zero"), album("legacy", { legacy: true }), album("replacement"),
    album("old", { legacy: true }), album("mtime", { legacy: true }), album("size", { legacy: true }),
    album("malformed", { legacy: true }), album("truncated"), album("bad-member"), album("bad-identity", { legacy: true }),
    album("outside", { relativePath: "../outside.zip" }), album("unknown")];
  store.publish({ photoSets: rows });
  const revision = store.revision();
  const put = db.prepare(`INSERT INTO photo_set_image_indexes
    (archive_path, archive_size, archive_mtime_ms, archive_identity, indexer_version, image_count, images_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '')`);

  function measure(id, members, overrides = {}) {
    const row = rows.find(album => album.id === id);
    const archivePath = path.resolve(row.sourceRoot, row.relativePath);
    const size = overrides.size ?? archiveSize;
    const timestamp = overrides.mtime ?? mtimeMs;
    put.run(archivePath, size, timestamp, overrides.signature ?? signature(archivePath, "12", size, timestamp),
      overrides.version ?? ARCHIVE_IMAGE_INDEXER_VERSION, overrides.count ?? members.length,
      overrides.json ?? JSON.stringify(members.map(member => typeof member === "string" ? { path: member } : member)));
  }

  measure("complete", ["cover.jpg", "folder/COVER.JPG", "folder\\CoVeR.JpG", "uncover.jpg", "cover.jpeg", "封面.jpg"]);
  measure("zero", ["folder/cover.jpg"]);
  measure("legacy", ["cover.jpg", "chapter/photo.png"]);
  measure("replacement", ["photo.jpg"], { signature: signature(path.resolve(sourceRoot, "replacement.zip"), "13") });
  measure("old", ["photo.jpg"], { version: ARCHIVE_IMAGE_INDEXER_VERSION - 1 });
  measure("mtime", ["photo.jpg"], { mtime: mtimeMs + 1 });
  measure("size", ["photo.jpg"], { size: archiveSize + 1 });
  measure("malformed", ["photo.jpg"], { json: "[" });
  measure("truncated", ["photo.jpg"], { count: 2 });
  measure("bad-member", [{ name: "photo.jpg" }]);
  measure("bad-identity", ["photo.jpg"], { signature: "opaque" });
  measure("outside", ["photo.jpg"]);

  const prepare = db.prepare.bind(db), plans = [];
  db.prepare = sql => {
    const statement = prepare(sql);
    if (!sql.includes("json_each(?)")) return statement;
    return { iterate(...args) {
      plans.push(prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => row.detail));
      return statement.iterate(...args);
    } };
  };
  assert.deepEqual(Object.fromEntries(store.contentImageCounts(rows.map(row => row.id), revision)), { complete: 3, zero: 0, legacy: 1 });
  assert.equal(plans.length, 2);
  assert.ok(plans[0].some(detail => /SEARCH a USING .*\(id=\?\)/.test(detail)));
  assert.ok(plans[1].some(detail => /SEARCH i USING .*\(archive_path=\?\)/.test(detail)));
  assert.deepEqual(store.contentImageCounts(["complete", "complete", "missing"]), new Map([["complete", 3]]));
  assert.equal(store.contentImageCounts(["complete"], "old publication").size, 0);
  db.prepare = prepare;
  db.prepare("UPDATE photo_set_image_indexes SET image_count=2, images_json=? WHERE archive_path=?")
    .run(JSON.stringify([{ path: "cover.jpg" }, { path: "photo.jpg" }]), path.resolve(sourceRoot, "complete.zip"));
  assert.equal(store.contentImageCounts(["complete"], revision).get("complete"), 1, "counts follow member-index updates without a photo rescan");
  assert.equal(store.contentImageCounts([]).size, 0);
  console.log("photo card counts: batched primary-key reads, cover basename exclusion, zero, freshness and malformed cases passed");
} finally {
  dbService.close();
}
