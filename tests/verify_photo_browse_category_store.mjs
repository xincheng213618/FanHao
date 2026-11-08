import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createImageGalleryDbService } from "../src/modules/content-index/server/image-gallery-db-service.js";
import { createPhotoBrowseCategoryStore } from "../src/modules/content-index/server/photo-browse-category-store.js";
import { removeVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-photo-browse-category-"));
const service = createImageGalleryDbService({ dbPath: path.join(root, "gallery.sqlite"), ensureDataDir() {} });
const store = createPhotoBrowseCategoryStore({ getDb: service.getDb });
try {
  const xiuren = { id: "xiuren", name: "秀人网", parentId: "sites", sourceCategory: "[XIUREN] 秀人网" };
  assert.deepEqual(store.byId("xiuren"), xiuren);
  assert.deepEqual(store.bySourceCategory(xiuren.sourceCategory), xiuren);
  assert.equal(store.bySourceCategory("秀人网"), null);
  assert.equal(store.byId("missing"), null);
  assert.equal(store.children("yituyu"), null);
  assert.equal(store.children("missing"), null);
  assert.equal(store.byId("korean-entertainment").parentId, null);
  assert.equal(store.children("sites").stats.albumCount, 0);

  const db = service.getDb();
  const scopes = Object.fromEntries([
    ["xiuren", 2, 11, 100], ["yituyu", 1, 6, 200], ["mslass", 1, 4, 300], ["korean-entertainment", 1, 8, 400]
  ].map(([id, total, albumCount, totalBytes]) => [store.byId(id).sourceCategory, { counts: { updated: { total, albumCount, totalBytes } } }]));
  db.prepare("INSERT INTO photo_library_snapshot VALUES (1,?,?,?,?,?,?,?)")
    .run("fixture", "revision-a", "2026-11-08", "[]", "{}", "{}", JSON.stringify(scopes));
  const put = db.prepare("INSERT INTO photo_library_collections (category,sort,locale,position,data_json) VALUES (?, 'count', 'zh-CN', 0, ?)");
  for (const id of ["xiuren", "yituyu", "mslass", "korean-entertainment"]) {
    put.run(store.byId(id).sourceCategory, JSON.stringify({ collectionId: `fixture|${id}`, coverUrl: `/cover/${id}`, updatedAt: "2026-11-07" }));
  }

  const first = store.children("sites", { limit: 1, sort: "title", locale: "en-US" });
  const rest = store.children("sites", { offset: 1 });
  assert.equal(first.total, 3);
  assert.equal(first.scannedAt, "2026-11-08");
  assert.deepEqual(first.stats, { ratedCount: 0, totalBytes: 600, albumCount: 21 });
  assert.equal(first.listRevision, rest.listRevision);
  assert.deepEqual(first.items.map(item => [item.id, item.browseCategoryId, item.albumCount, item.coverUrl]),
    [["browse:xiuren", "xiuren", 11, "/cover/xiuren"]]);
  assert.deepEqual(rest.items.map(item => item.browseCategoryId), ["yituyu", "mslass"]);

  const definitions = new Map(store.list().map(item => [item.id, item]));
  assert.equal(definitions.get("sites").issueCount, 21);
  assert.equal(definitions.get("sites").collectionCount, 4);
  assert.equal(definitions.get("xiuren").singleCollectionId, undefined);
  assert.equal(definitions.get("yituyu").singleCollectionId, "fixture|yituyu");
  assert.equal(definitions.get("korean-entertainment").issueCount, 8);

  db.exec("UPDATE photo_library_snapshot SET revision='revision-b'; UPDATE photo_browse_categories SET name='我的名站' WHERE id='sites';");
  service.close();
  assert.equal(store.byId("sites").name, "我的名站", "reopening preserves local category definitions");
  assert.notEqual(store.children("sites").listRevision, first.listRevision);
  assert.equal(store.children("sites").items[0].catalogCategory, "我的名站");
  console.log("photo-browse-category-store: seeded definitions, counts, stable paging, revision and persistence verified");
} finally {
  service.close();
  removeVerifiedTempDir(root);
}
