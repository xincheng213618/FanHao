import assert from "node:assert/strict";
import { BOBO_SOCKS_CATEGORY, parseBoBoSocksAlbum } from "../lib/bobosocks-album.js";
import { createImageGalleryDbService } from "../src/modules/content-index/server/image-gallery-db-service.js";
import { createImageLibraryService } from "../src/modules/content-index/server/image-library-service.js";
import { createPhotoBrowseCategoryStore } from "../src/modules/content-index/server/photo-browse-category-store.js";
import { createPhotoLibraryStore } from "../src/modules/content-index/server/photo-library-store.js";
import { createPhotoSetService } from "../src/modules/photos/server/photo-set-service.js";

const rows = [
  ["285", " 稚予-两双高跟鞋、灰丝大腿袜、黑丝大腿袜", "稚予-两双高跟鞋、灰丝大腿袜、黑丝大腿袜"],
  ["275", "小甜豆-高跟鞋、板鞋", ""],
  ["274", " 小甜豆稚予-感谢陪伴，假期快乐哦", "小甜豆稚予-感谢陪伴，假期快乐哦"],
  ["263", " 小甜豆与稚予-两双高跟鞋", "小甜豆与稚予-两双高跟鞋"],
  ["203", " 三双靴子、黑丝、网袜", "三双靴子、黑丝、网袜"]
];

function archive(id, category, directory, title, personName) {
  return {
    id, category, title, personName, type: "photoSet", subCategory: "", rootLabel: "fixture",
    sourceRoot: "fixture", relativePath: `${directory}/${id}.zip`, archiveExt: "zip",
    size: 10, updatedAt: "2026-11-08T00:00:00Z", imageCount: 1
  };
}

const bobosocks = rows.map(([id, body, person]) => archive(id, BOBO_SOCKS_CATEGORY, BOBO_SOCKS_CATEGORY,
  `${BOBO_SOCKS_CATEGORY}NO.${id}${body}[145P+1V／5.46GB]`, person));
const physical = ["现有合集一", "现有合集二"].map((name, index) => archive(`legacy-${index}`, "恋足恋物", `恋足恋物/${name}`,
  `${name} NO.1 普通标题`, "原有人物"));

const coverUrl = id => `/cover/${id}`;
const db = createImageGalleryDbService({ dbPath: ":memory:", ensureDataDir() {} });
const browse = createPhotoBrowseCategoryStore({ getDb: db.getDb });
const projections = createImageLibraryService({ photoCollectionRootValue: "__root__", photoSetService: { coverUrl } });
const store = createPhotoLibraryStore({ getDb: db.getDb, archiveExts: [".zip"], photoSetRoots: ["fixture"], project: projections.projectPhotoIndex });
const service = createImageLibraryService({
  cachePreparedQueries: true, photoLibraryStore: store, photoBrowseCategoryStore: browse, photoSetService: { coverUrl },
  getImageLibraryIndex: () => assert.fail("BoBoSocks must read the SQLite publication"),
  getImageLibraryRevision: store.revision, clampInteger: (value, fallback) => value === null ? fallback : Number(value),
  maxItemLimit: 100, photoCollectionRootValue: "__root__"
});
const detail = createPhotoSetService({ archiveImagesPayload: async () => ({ images: [] }), getImageGalleryDb: db.getDb, safeChildPath: () => "fixture.zip" });

function page(category, options = {}) {
  const params = new URLSearchParams({ mode: "photo", photoView: "collections", collectionPage: "1", collectionLocale: "zh-CN", category, ...options });
  return service.itemsPayload(new URL(`http://fixture/api/image-library/items?${params}`));
}

try {
  assert.deepEqual(parseBoBoSocksAlbum(bobosocks[0].title), {
    albumNumber: "NO.285", albumSubject: "两双高跟鞋、灰丝大腿袜、黑丝大腿袜", personName: "稚予", photoPeople: ["稚予"]
  });
  assert.deepEqual(parseBoBoSocksAlbum(bobosocks[2].title).photoPeople, ["小甜豆", "稚予"]);
  assert.equal(parseBoBoSocksAlbum(bobosocks[2].title).albumSubject, "感谢陪伴，假期快乐哦");
  assert.deepEqual(parseBoBoSocksAlbum(bobosocks[4].title).photoPeople, []);
  assert.equal(parseBoBoSocksAlbum("[OTHER] NO.12 稚予-描述"), null);

  store.publish({ scannedAt: "2026-11-08", roots: [], photoSets: [...bobosocks, ...physical] });
  assert.equal(store.byId("285").personName, rows[0][2], "published archive row still has the old inferred person");
  const first = page("catalog:fetish", { limit: 1 });
  const rest = page("catalog:fetish", { offset: 1 });
  assert.equal(first.items[0].browseCategoryId, "bobosocks");
  assert.equal(first.total, 3);
  assert.equal(first.stats.albumCount, 7);
  assert.equal(first.listRevision, rest.listRevision);
  assert.deepEqual(rest.items.map(item => item.title).sort(), ["现有合集一", "现有合集二"].sort());
  assert.equal(browse.list().find(item => item.id === "fetish").issueCount, 7);

  const albums = page("catalog:bobosocks", { categoryContents: 1, sort: "title" });
  assert.equal(albums.categoryDirect, true);
  assert.equal(albums.collectionSummary.browseParent.id, "fetish");
  assert.deepEqual(albums.facets.people.map(item => [item.value, item.count]), [["小甜豆", 3], ["稚予", 3]]);
  assert.equal(albums.items.find(item => item.id === "285").albumSubject, "两双高跟鞋、灰丝大腿袜、黑丝大腿袜");
  assert.equal(albums.items.find(item => item.id === "203").personName, "");
  assert.deepEqual(page("catalog:bobosocks", { categoryContents: 1, sort: "title" }).items, albums.items, "warm query keeps parsed subjects");
  assert.deepEqual(page("catalog:bobosocks", { categoryContents: 1, person: "稚予" }).items.map(item => item.id).sort(), ["263", "274", "285"]);
  const rawDetail = page("all", { collection: albums.collection });
  assert.equal(rawDetail.collectionSummary.browseParent.id, "fetish");

  const opened = await detail.publicDetail(bobosocks[0]);
  assert.equal(opened.title, "NO.285 两双高跟鞋、灰丝大腿袜、黑丝大腿袜");
  assert.equal(opened.archiveTitle, bobosocks[0].title);
  assert.equal(opened.personName, "稚予");
  assert.equal((await detail.publicDetail(physical[0])).title, physical[0].title);
  console.log("bobosocks: mixed taxonomy pagination, indexed person and subject, multi-person facets, and reader title verified");
} finally {
  db.close();
}
