import assert from "node:assert/strict";
import { createImageGalleryDbService } from "../src/modules/content-index/server/image-gallery-db-service.js";
import { createImageLibraryService, photoShelfCollectionScope } from "../src/modules/content-index/server/image-library-service.js";
import { createPhotoBrowseCategoryStore } from "../src/modules/content-index/server/photo-browse-category-store.js";
import { createPhotoLibraryStore } from "../src/modules/content-index/server/photo-library-store.js";
import { createPhotoSetService } from "../src/modules/photos/server/photo-set-service.js";

const root = "T:\\";
const loli = "萝莉系列";
const others = "小众系列";
const fetish = "恋足恋物";
const galli = "[GALLI嘉丽]舞蹈生日记";
const kitty = "kittyWawa袜小喵";
const likes = "我喜欢的";
const favorites = [
  ["Milena D (Sunna)_33Sets", "Milena D"],
  ["paloma b", "Paloma B"],
  ["Emily Bloom", "Emily Bloom"]
];
const folders = ["[战前女神]", "风之领域", "喵糖映画", "喵写真", "纳丝摄影", "轻兰映画", "森萝财团", "少女映画", "少女秩序", "兔玩映画", "妖精视觉"];
const coverUrl = id => `/fixture-cover/${id}`;
const timestamp = "2026-11-08T00:00:00Z";
const album = (id, category, subCategory, inner = "") => ({
  id, category, subCategory, title: `Test ${id}`, personName: `Person ${id}`, sourceRoot: root, rootLabel: root,
  relativePath: [category, subCategory, inner, `${id}.zip`].filter(Boolean).join("/"),
  size: 10, imageCount: 1, coverUrl: coverUrl(id), updatedAt: timestamp
});
const photoSets = [
  ...folders.map((folder, i) => album(`base-${i}`, loli, folder)),
  album("rabbit-a", loli, "兔玩映画", "1301-1400"),
  album("rabbit-b", loli, "兔玩映画", "1301-1400/1380"),
  album("rabbit-c", loli, "兔玩映画", "1401-1500/1440"),
  album("qinglan", loli, "轻兰映画", "Grand"),
  album("galli-a", others, galli, "Folder A"), album("galli-b", others, galli, "Folder B"),
  album("other-a", others, "Others A"), album("other-b", others, "Others B"),
  album("kitty", fetish, kitty), album("fetish", fetish, "现有合集"),
  ...favorites.flatMap(([folder], index) => ["Met-Art", "FemJoy/2011"].map((site, siteIndex) => ({
    ...album(`person-${index}-${siteIndex}`, likes, folder, site),
    personName: site
  }))),
  album("ungrouped", likes, "")
];
const db = createImageGalleryDbService({ dbPath: ":memory:", ensureDataDir() {} });
const browse = createPhotoBrowseCategoryStore({ getDb: db.getDb });
const baseOptions = { photoCollectionRootValue: "__root__", photoSetService: { coverUrl }, maxItemLimit: 100,
  clampInteger: (value, fallback) => value === null ? fallback : Number(value) };
const store = createPhotoLibraryStore({ getDb: db.getDb, archiveExts: [".zip"], photoSetRoots: [root],
  project: createImageLibraryService(baseOptions).projectPhotoIndex });
const service = createImageLibraryService({ ...baseOptions, photoLibraryStore: store, photoBrowseCategoryStore: browse,
  cachePreparedQueries: true, getImageLibraryRevision: store.revision,
  getImageLibraryIndex: () => assert.fail("shelf browsing must use the SQLite publication") });

function page(category, filters = {}) {
  const params = new URLSearchParams({ mode: "photo", photoView: "collections", collectionPage: 1,
    collectionLocale: "zh-CN", category, ...filters });
  return service.itemsPayload(new URL(`http://fixture/api/image-library/items?${params}`));
}

try {
  store.publish({ scannedAt: timestamp, roots: [], photoSets });
  const sqlite = db.getDb();
  const mappings = sqlite.prepare("SELECT * FROM photo_browse_category_folders WHERE source_category=?").all(loli);
  assert.equal(mappings.length, 8);
  sqlite.prepare("DELETE FROM photo_browse_category_folders WHERE source_category=?").run(loli);
  const original = page(loli, { sort: "count" });
  assert.equal(original.total, 11);
  assert.equal(original.stats.albumCount, 15);
  const rabbit = original.items.find(item => item.title === "兔玩映画");
  assert.equal(rabbit.albumCount, 4);
  assert.deepEqual(photoShelfCollectionScope(rabbit.collectionId), { sourceRoot: root, category: loli, subCategory: "兔玩映画" });
  assert.equal(page(loli, { sort: "count", direction: "asc", offset: 10, limit: 1 }).items[0].id, rabbit.id);
  const detail = page(loli, { collection: rabbit.collectionId, sort: "title" });
  assert.deepEqual(detail.items.map(item => item.id), ["base-9", "rabbit-a", "rabbit-b", "rabbit-c"]);
  assert.equal(detail.collectionSummary.title, "兔玩映画");
  const legacyId = `${root}|${loli}/兔玩映画/1301-1400/1380`;
  assert.deepEqual(page(loli, { collection: legacyId }).items.map(item => item.id), ["rabbit-b"]);
  assert.equal(page("all", { collection: "shelf:invalid" }).total, 0);

  const peopleShelves = page("catalog:likes", { sort: "title" });
  assert.equal(peopleShelves.total, 4, "each person appears once, including when sites nest further");
  assert.equal(peopleShelves.stats.albumCount, 7);
  assert(peopleShelves.items.some(item => item.albumCount === 1), "archives directly under the category still have a collection");
  for (const [index, [folder, person]] of favorites.entries()) {
    const shelf = peopleShelves.items.find(item => item.title === person);
    assert.deepEqual(photoShelfCollectionScope(shelf.collectionId), { sourceRoot: root, category: likes, subCategory: folder });
    const detail = page("catalog:likes", { collection: shelf.collectionId });
    assert.equal(detail.collectionSummary.title, person);
    assert.equal(detail.total, 2);
    assert(detail.items.every(item => item.personName === person));
    const siteLink = page("catalog:likes", { collection: `${root}|${likes}/${folder}/Met-Art` });
    assert.equal(siteLink.collectionSummary.title, person);
    assert.deepEqual(siteLink.items.map(item => item.id), [`person-${index}-0`], "old publisher links keep their original contents");
    assert.equal(page("catalog:likes", { photoView: "albums", person }).total, 2);
  }
  const people = page("catalog:likes", { photoView: "people" });
  for (const [, name] of favorites) assert(people.items.some(item => item.name === name && item.count === 2));
  const reader = createPhotoSetService({
    safeChildPath: (_root, relativePath) => relativePath,
    archiveImagesPayload: async () => ({ images: [] })
  });
  const albumDetail = await reader.publicDetail(store.byId("person-0-0"));
  assert.equal(albumDetail.personName, "Milena D");

  const restore = sqlite.prepare("INSERT INTO photo_browse_category_folders(category_id, source_category, sub_category) VALUES(?,?,?)");
  for (const row of mappings) restore.run(row.category_id, row.source_category, row.sub_category);
  const remaining = page("catalog:loli-series");
  assert.equal(remaining.total, 3);
  assert.equal(remaining.stats.albumCount, 3);
  assert.deepEqual(remaining.items.map(item => item.title).sort(), ["喵写真", "纳丝摄影", "少女映画"].sort());
  assert.equal(page(loli, { photoView: "albums" }).total, 3);
  assert.equal(page(loli, { photoView: "people" }).total, 3);
  assert.deepEqual(page(loli, { collection: legacyId }).items.map(item => item.id), ["rabbit-b"], "old bookmarks survive a taxonomy move");
  const oldShelf = page("all", { collection: rabbit.collectionId });
  assert.equal(oldShelf.collectionSummary.browseCategory.id, "tuwan");
  assert.equal(oldShelf.collectionSummary.browseParent.id, "sites");
  const routed = page("catalog:tuwan", { sort: "title", direction: "desc", offset: 1, limit: 2 });
  assert.equal(routed.categoryDirect, true);
  assert.equal(routed.collection, rabbit.collectionId);
  assert.equal(routed.total, 4);
  assert.deepEqual(routed.items.map(item => item.id), ["rabbit-b", "rabbit-a"]);

  const sites = page("catalog:sites");
  const siteCards = new Map(sites.items.map(item => [item.browseCategoryId, item]));
  assert.equal(siteCards.get("tuwan").albumCount, 4);
  assert(siteCards.get("tuwan").coverUrl);
  assert.equal(siteCards.get("galli").albumCount, 2);
  assert.equal(siteCards.get("kitty-wawa").albumCount, 1);
  assert.equal(page("catalog:galli").collectionSummary.title, "嘉丽");
  assert.equal(page("catalog:sites", { photoView: "albums" }).total, 14);
  assert.equal(page("catalog:sites", { photoView: "people" }).total, 14);
  assert.deepEqual(page(others, { sort: "title", direction: "desc", offset: 1, limit: 1 }).items.map(item => item.title), ["Others A"]);
  assert.equal(page(others).stats.albumCount, 2);
  const fetishPage = page("catalog:fetish");
  assert.equal(fetishPage.total, 2);
  assert.equal(fetishPage.stats.albumCount, 2);
  assert.equal(fetishPage.items[0].browseCategoryId, "lady-antebellum");
  assert.deepEqual(page("catalog:fetish", { photoView: "albums" }).items.map(item => item.id).sort(), ["base-0", "fetish"]);
  console.log("photo shelf collections: first-level groups, nested issues, taxonomy membership, reverse pages and old links verified");
} finally {
  db.close();
}
