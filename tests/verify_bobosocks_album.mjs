import assert from "node:assert/strict";
import { BOBO_SOCKS_CATEGORY, parseBoBoSocksAlbum } from "../lib/bobosocks-album.js";
import { createImageGalleryDbService } from "../src/modules/content-index/server/image-gallery-db-service.js";
import { createImageLibraryService } from "../src/modules/content-index/server/image-library-service.js";
import { createPhotoBrowseCategoryStore } from "../src/modules/content-index/server/photo-browse-category-store.js";
import { createPhotoLibraryStore } from "../src/modules/content-index/server/photo-library-store.js";
import { createPhotoPublisherStore } from "../src/modules/content-index/server/photo-publisher-store.js";
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
const publishers = createPhotoPublisherStore({ getDb: db.getDb });
const projections = createImageLibraryService({ photoCollectionRootValue: "__root__", photoSetService: { coverUrl } });
const store = createPhotoLibraryStore({ getDb: db.getDb, archiveExts: [".zip"], photoSetRoots: ["fixture"], project: projections.projectPhotoIndex });
const serviceOptions = {
  cachePreparedQueries: true, photoBrowseCategoryStore: browse, photoPublisherStore: publishers, photoSetService: { coverUrl },
  getImageLibraryIndex: () => assert.fail("BoBoSocks must read the SQLite publication"),
  getImageLibraryRevision: store.revision, clampInteger: (value, fallback) => value === null ? fallback : Number(value),
  maxItemLimit: 100, photoCollectionRootValue: "__root__"
};
const snapshot = { scannedAt: "2026-11-08", roots: [], photoSets: [...bobosocks, ...physical] };
const service = createImageLibraryService({ ...serviceOptions, photoLibraryStore: store });
const fallback = createImageLibraryService({ ...serviceOptions, getImageLibraryIndex: () => snapshot });
const detail = createPhotoSetService({ archiveImagesPayload: async () => ({ images: [] }), getImageGalleryDb: db.getDb, safeChildPath: () => "fixture.zip" });

function page(category, options = {}, source = service) {
  const params = new URLSearchParams({ mode: "photo", photoView: "collections", collectionPage: "1", collectionLocale: "zh-CN", category, ...options });
  return source.itemsPayload(new URL(`http://fixture/api/image-library/items?${params}`));
}

try {
  assert.deepEqual(parseBoBoSocksAlbum(bobosocks[0].title), {
    albumNumber: "NO.285", albumSubject: "两双高跟鞋、灰丝大腿袜、黑丝大腿袜", personName: "稚予", photoPeople: ["稚予"]
  });
  assert.deepEqual(parseBoBoSocksAlbum(bobosocks[2].title).photoPeople, ["小甜豆", "稚予"]);
  assert.equal(parseBoBoSocksAlbum(bobosocks[2].title).albumSubject, "感谢陪伴，假期快乐哦");
  assert.deepEqual(parseBoBoSocksAlbum(bobosocks[4].title).photoPeople, []);
  assert.equal(parseBoBoSocksAlbum("[OTHER] NO.12 稚予-描述"), null);

  store.publish(snapshot);
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

  const people = (category, options = {}) => page(category, { photoView: "people", ...options });
  const directory = people("catalog:fetish");
  assert.equal(directory.direction, "desc");
  assert.equal(directory.total, 3);
  assert.deepEqual(directory.items.map(item => [item.type, item.id, item.value, item.name, item.count]), [
    ["photoPerson", "小甜豆", "小甜豆", "小甜豆", 3], ["photoPerson", "稚予", "稚予", "稚予", 3],
    ["photoPerson", "原有人物", "原有人物", "原有人物", 2]
  ]);
  const countAsc = people("catalog:fetish", { direction: "asc", offset: 1, limit: 1 });
  assert.equal(countAsc.listRevision, directory.listRevision);
  assert.equal(countAsc.nextOffset, 2);
  assert.deepEqual(countAsc.items, directory.items.slice().reverse().slice(1, 2));
  const titleAsc = people("catalog:fetish", { sort: "title" });
  assert.equal(titleAsc.direction, "asc");
  assert.deepEqual(people("catalog:fetish", { sort: "title", direction: "desc" }).items, [...titleAsc.items].reverse());
  assert.equal(people("catalog:fetish", { direction: "asc", offset: 100 }).items.length, 0);
  const found = people("catalog:bobosocks", { q: "小 甜豆", sort: "title" });
  assert.equal(found.sort, "title");
  assert.deepEqual(found.items.map(item => item.name), ["小甜豆"]);
  assert.equal(people("恋足恋物").items[0].name, "原有人物");
  assert.equal(people("catalog:missing").total, 0);

  const ownCollections = page("恋足恋物", { sort: "title" }).items;
  assert.deepEqual(page("恋足恋物", { sort: "title", direction: "desc", limit: 1 }).items, ownCollections.slice(-1));
  assert.deepEqual(page("恋足恋物", { sort: "title", direction: "desc", offset: 1, limit: 1 }).items, ownCollections.slice(0, 1));
  assert.deepEqual(page("恋足恋物", { sort: "title", direction: "desc", offset: 1, limit: 1 }, fallback).items, ownCollections.slice(0, 1));
  const groupFirst = page("catalog:fetish", { sort: "title", direction: "desc", limit: 2 });
  assert.deepEqual(groupFirst.items.map(item => item.id), ["browse:bobosocks", ownCollections[1].id]);
  assert.equal(page("catalog:fetish", { sort: "title", direction: "desc", offset: 2, limit: 2 }).items[0].id, ownCollections[0].id);
  const reverseDirect = page("catalog:bobosocks", { categoryContents: 1, sort: "title", direction: "desc", offset: 1, limit: 2 });
  assert.equal(reverseDirect.categoryDirect, true);
  assert.deepEqual(reverseDirect.items, albums.items.slice().reverse().slice(1, 3));
  for (const source of [service, fallback]) {
    for (const sort of ["updated", "size", "count", "title"]) {
      const options = { photoView: "albums", sort };
      const original = page("all", options, source).items;
      const direction = sort === "title" ? "desc" : "asc";
      assert.deepEqual(page("all", { ...options, direction, offset: 1, limit: 2 }, source).items,
        [...original].reverse().slice(1, 3));
    }
    const search = { photoView: "albums", q: "普通标题", sort: "title" };
    assert.deepEqual(page("all", { ...search, direction: "desc" }, source), page("all", search, source));
  }

  publishers.savePublisher({ id: "bololi", name: "Publisher" }, [
    { kind: "collection", targetId: albums.collection }, { kind: "collection", targetId: ownCollections[0].collectionId }
  ]);
  const publisherCategory = "publisher:bololi";
  const publisherPeople = people(publisherCategory);
  assert.deepEqual(publisherPeople.items.map(item => [item.name, item.count]), [["小甜豆", 3], ["稚予", 3], ["原有人物", 1]]);
  assert.deepEqual(people("catalog:sites").items, publisherPeople.items, "the group includes its publisher’s cross-category collections");
  const publisherAlbumOptions = { photoView: "albums", person: "稚予" };
  const publisherAlbums = page(publisherCategory, publisherAlbumOptions);
  assert.deepEqual(publisherAlbums.items.map(item => item.id).sort(), ["263", "274", "285"]);
  const publisherCollections = page(publisherCategory, { sort: "title" }).items;
  assert.equal(publisherCollections.length, 2);
  assert.deepEqual(page(publisherCategory, { sort: "title", direction: "desc", limit: 1 }).items, publisherCollections.slice(-1));
  assert.deepEqual(page(publisherCategory, { sort: "title", direction: "desc", offset: 1 }).items, publisherCollections.slice(0, 1));
  publishers.savePublisher({ id: "bololi", name: "Publisher" }, [{ kind: "collection", targetId: ownCollections[0].collectionId }]);
  const publisherChanged = people(publisherCategory);
  assert.deepEqual(publisherChanged.items.map(item => item.name), ["原有人物"]);
  assert.notEqual(publisherChanged.listRevision, publisherPeople.listRevision);
  const noLongerPublished = page(publisherCategory, publisherAlbumOptions);
  assert.equal(noLongerPublished.total, 0);
  assert.notEqual(noLongerPublished.listRevision, publisherAlbums.listRevision);

  const organized = [
    archive("portrait", "[]", "[]/Portrait Name", "Portrait Name NO.1", "Portrait Name"),
    archive("cos", "[COS]", "[COS]/COS Name", "COS Name NO.1", "COS Name")
  ];
  store.publish({ ...snapshot, photoSets: [...snapshot.photoSets, ...organized] });
  assert.equal(people("[]").items[0].name, "Portrait Name");
  assert.equal(people("[COS]").items[0].name, "COS Name");
  const names = people("all").items.map(item => item.name);
  assert(names.includes("Portrait Name") && names.includes("COS Name"));
  assert.deepEqual(page("[]", { photoView: "albums", person: "Portrait Name" }).items.map(item => item.id), ["portrait"]);
  assert.deepEqual(page("[COS]", { photoView: "albums", person: "COS Name" }).items.map(item => item.id), ["cos"]);
  const ordinaryFacets = page("all", { photoView: "albums" }).facets.people.map(item => item.value);
  assert(!ordinaryFacets.includes("Portrait Name") && !ordinaryFacets.includes("COS Name"));

  const opened = await detail.publicDetail(bobosocks[0]);
  assert.equal(opened.title, "NO.285 两双高跟鞋、灰丝大腿袜、黑丝大腿袜");
  assert.equal(opened.archiveTitle, bobosocks[0].title);
  assert.equal(opened.personName, "稚予");
  assert.equal((await detail.publicDetail(physical[0])).title, physical[0].title);
  console.log("bobosocks: mixed taxonomy pagination, indexed people, publisher scopes, bidirectional sorting and reader title verified");
} finally {
  db.close();
}
