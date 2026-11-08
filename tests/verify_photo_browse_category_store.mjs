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
  assert.equal(store.children("sites").stats.albumCount, 0);
  assert.equal(store.children("sites").total, 0);
  assert.equal(store.byPublisherId("bololi"), null);
  for (const [id, name, parentId, sourceCategory] of [
    ["japan", "日本", null, "日本写真集"],
    ["ys-web", "YS Web", "japan", "YS Web"],
    ["maxi-247", "Maxi-247", "japan", "Maxi-247 - 301 Rei"],
    ["korea", "韩国", null, "韩国写真集"],
    ["make-model", "Make Model", "korea", "[Make model]"],
    ["korean-entertainment", "韩国演艺圈", "korea", "韩国演艺圈"],
    ["korean-other", "其他韩国写真", "korea", "韩国"],
    ["street", "精选街拍", null, "精选街拍"],
    ["mojing", "魔镜街拍", "street", "魔镜街拍"],
    ["leeheeexpress", "LeeheeExpress", "korea", "[LeeheeExpress]"],
    ["partycat", "轰趴猫", "sites", "[Partycat]"],
    ["tuigirl", "推女郎", "sites", "[TuiGirl] 推女郎"],
    ["slady", "猎女神", "sites", "[SLADY]猎女神"],
    ["likes", "我喜欢的", null, "我喜欢的"],
    ["miscellaneous", "零散", "likes", "[零散]"]
  ]) assert.deepEqual(store.bySourceCategory(sourceCategory), { id, name, parentId, sourceCategory });
  assert.deepEqual(store.children("japan").items, []);
  assert.deepEqual(store.children("korea").items, []);
  assert.deepEqual(store.children("street").items, []);

  const db = service.getDb();
  const scopes = Object.fromEntries([
    ["xiuren", 2, 11, 100], ["yituyu", 1, 6, 200], ["mslass", 1, 4, 300], ["korean-entertainment", 1, 8, 400],
    ["girlt", 1, 3, 50], ["qingdouke", 1, 2, 100], ["bololi", 3, 9, 150],
    ["japan", 2, 12, 500], ["ys-web", 3, 16, 600], ["maxi-247", 1, 2, 50],
    ["korea", 2, 10, 300], ["make-model", 1, 4, 150], ["korean-other", 1, 1, 25],
    ["street", 2, 6, 40], ["mojing", 1, 3, 30],
    ["likes", 2, 12, 75], ["miscellaneous", 1, 1, 10]
  ].map(([id, total, albumCount, totalBytes]) => [store.byId(id).sourceCategory, { counts: { updated: { total, albumCount, totalBytes } } }]));
  db.prepare("INSERT INTO photo_library_snapshot VALUES (1,?,?,?,?,?,?,?)")
    .run("fixture", "revision-a", "2026-11-08", "[]", "{}", "{}", JSON.stringify(scopes));
  const put = db.prepare("INSERT INTO photo_library_collections (category,sort,locale,position,data_json) VALUES (?, 'count', 'zh-CN', 0, ?)");
  for (const id of ["xiuren", "yituyu", "mslass", "korean-entertainment", "girlt", "qingdouke", "bololi"]) {
    put.run(store.byId(id).sourceCategory, JSON.stringify({ collectionId: `fixture|${id}`, coverUrl: `/cover/${id}`, updatedAt: "2026-11-07" }));
  }

  const first = store.children("sites", { limit: 1, sort: "title", locale: "en-US" });
  const rest = store.children("sites", { offset: 1 });
  assert.equal(first.total, 6);
  assert.equal(first.scannedAt, "2026-11-08");
  assert.deepEqual(first.stats, { ratedCount: 0, totalBytes: 900, albumCount: 35 });
  assert.equal(first.listRevision, rest.listRevision);
  assert.deepEqual(first.items.map(item => [item.id, item.browseCategoryId, item.albumCount, item.coverUrl]),
    [["browse:xiuren", "xiuren", 11, "/cover/xiuren"]]);
  assert.deepEqual(rest.items.map(item => item.browseCategoryId), ["yituyu", "mslass", "girlt", "qingdouke", "bololi"]);
  assert.equal(rest.items.at(-1).browsePublisherId, undefined, "taxonomy does not invent a missing publisher");
  assert.equal(store.byId("girlt").sourceCategory, "[Girlt] 果团网");
  assert.equal(store.byId("qingdouke").sourceCategory, "[QingDouKe] 青豆客");
  assert.equal(store.byId("ugirls").parentId, "sites");
  assert.deepEqual(store.children("sites", { offset: 6 }).items, [], "empty seed entries do not consume page slots");
  const own = store.children("fetish", { offset: 2, limit: 1, loadSource({ category, limit, offset }) {
    assert.deepEqual({ category, limit, offset }, { category: "恋足恋物", limit: 1, offset: 2 });
    return { items: [{ id: "own-third" }], total: 3, stats: { totalBytes: 0, albumCount: 3 }, listRevision: "own" };
  } });
  assert.deepEqual(own.items, [{ id: "own-third" }]);
  assert.equal(own.total, 3);

  function loadOwnSource({ category, limit, offset }) {
    const { total, totalBytes, albumCount } = scopes[category].counts.updated;
    const items = Array.from({ length: total }, (_, index) => ({ id: `${category}-${index}` }));
    return { items: items.slice(offset, offset + limit), total, stats: { totalBytes, albumCount }, listRevision: category };
  }
  const japan = store.children("japan", { loadSource: loadOwnSource });
  assert.deepEqual(japan.items.map(item => item.id), ["browse:ys-web", "browse:maxi-247", "日本写真集-0", "日本写真集-1"]);
  assert.deepEqual(japan.stats, { ratedCount: 0, totalBytes: 1150, albumCount: 30 });
  const korea = store.children("korea", { loadSource: loadOwnSource, offset: 2, limit: 2 });
  assert.deepEqual(korea.items.map(item => item.id), ["browse:korean-other", "韩国写真集-0"]);
  assert.equal(korea.total, 5);
  assert.deepEqual(korea.stats, { ratedCount: 0, totalBytes: 875, albumCount: 23 });
  assert.equal(korea.listRevision, store.children("korea", { loadSource: loadOwnSource }).listRevision);
  const street = store.children("street", { loadSource: loadOwnSource });
  assert.deepEqual(street.items.map(item => item.id), ["browse:mojing", "精选街拍-0", "精选街拍-1"]);
  assert.deepEqual(street.stats, { ratedCount: 0, totalBytes: 70, albumCount: 9 });
  const likes = store.children("likes", { loadSource: loadOwnSource });
  assert.deepEqual(likes.items.map(item => item.id), ["browse:miscellaneous", "我喜欢的-0", "我喜欢的-1"]);
  assert.equal(likes.stats.albumCount, 13);

  db.exec(`INSERT INTO photo_publishers VALUES ('bololi', '菠萝社', 'BoLoli');
    INSERT INTO photo_publisher_members VALUES ('bololi', 'video', 'fixture-video', '', 0);
    INSERT INTO photo_publisher_video_items VALUES ('fixture-video', '{}');`);
  const bololi = { id: "bololi", name: "菠萝社", parentId: "sites", sourceCategory: "[BoLoli]波萝社", publisherId: "bololi" };
  assert.deepEqual(store.byId("bololi"), bololi);
  assert.deepEqual(store.bySourceCategory(bololi.sourceCategory), bololi);
  assert.deepEqual(store.byPublisherId("bololi"), bololi);
  const published = store.children("sites", { offset: 5, limit: 1 });
  assert.equal(published.items[0].browsePublisherId, "bololi");
  assert.notEqual(published.listRevision, first.listRevision, "publishing a publisher invalidates the old card URL");

  const definitions = new Map(store.list().map(item => [item.id, item]));
  assert.equal(definitions.get("sites").issueCount, 35);
  assert.equal(definitions.get("sites").collectionCount, 9);
  assert.equal(definitions.get("xiuren").singleCollectionId, undefined);
  assert.equal(definitions.get("yituyu").singleCollectionId, "fixture|yituyu");
  assert.equal(definitions.get("korean-entertainment").issueCount, 8);
  assert.equal(definitions.get("japan").collectionCount, 6);
  assert.equal(definitions.get("korea").collectionCount, 5);
  assert.equal(definitions.get("street").collectionCount, 3);

  delete scopes[bololi.sourceCategory];
  db.prepare("UPDATE photo_library_snapshot SET scopes_json=?").run(JSON.stringify(scopes));
  assert.equal(store.children("sites").items.at(-1).browsePublisherId, "bololi", "a registered video still makes the publisher browsable");
  db.exec("DELETE FROM photo_publisher_video_items WHERE id='fixture-video';");
  assert.equal(store.children("sites").total, 5, "an empty publisher shell consumes no site slot");

  db.exec(`UPDATE photo_library_snapshot SET revision='revision-b';
    UPDATE photo_browse_categories SET name='我的名站' WHERE id='sites';
    UPDATE photo_browse_categories SET parent_id=NULL, name='我的演艺圈' WHERE id='korean-entertainment';`);
  service.close();
  assert.equal(store.byId("sites").name, "我的名站", "reopening preserves local category definitions");
  assert.notEqual(store.children("sites").listRevision, first.listRevision);
  assert.equal(store.children("sites").items[0].catalogCategory, "我的名站");
  assert.deepEqual(store.bySourceCategory("韩国演艺圈"), {
    id: "korean-entertainment", name: "我的演艺圈", parentId: "korea", sourceCategory: "韩国演艺圈"
  });
  service.close();
  assert.equal(store.byId("korean-entertainment").parentId, "korea", "legacy reparenting is idempotent");
  console.log("photo-browse-category-store: country and street scopes, legacy migration, empty entries, publisher links and paging verified");
} finally {
  service.close();
  removeVerifiedTempDir(root);
}
