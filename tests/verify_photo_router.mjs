import assert from "node:assert/strict";
import { normalizePhotoBrowseCategory, normalizeRoute, routeFromUrl, routeUrl } from "../public/js/router.js";

globalThis.window = { location: new URL("http://fixture.invalid/photo/collections") };
const shelf = { view: "gallery", galleryMode: "photo", galleryPhotoView: "collections", gallerySort: "count" };
const from = value => normalizeRoute(routeFromUrl(value));

for (const [slug, category, legacy] of [
  ["sites", "catalog:sites", "名站套图"],
  ["xiuren", "catalog:xiuren", "[XIUREN] 秀人网"],
  ["yituyu", "catalog:yituyu", "[YITUYU艺图语]"],
  ["mslass", "catalog:mslass", "[MSLASS梦丝女神]"],
  ["korean-entertainment", "catalog:korean-entertainment", "韩国演艺圈"],
  ["bololi", "publisher:bololi"],
  ["cos", "[COS]"]
]) {
  const pathname = `/photo/categories/${slug}`;
  assert.equal(routeUrl({ ...shelf, galleryCategory: category }), pathname);
  assert.equal(from(pathname).galleryCategory, category);
  if (!legacy) continue;
  const query = new URLSearchParams({ category: legacy });
  const route = from(`/photo/collections?${query}`);
  assert.equal(normalizePhotoBrowseCategory(legacy), category);
  assert.equal(route.galleryCategory, category);
  assert.equal(routeUrl(route), pathname);
  assert.equal(from(`/photo/albums?${query}`).galleryCategory, legacy);
}

assert.equal(routeUrl(shelf), "/photo/collections");
assert.equal(from("/photo/collections").galleryCategory, "all");
assert.equal(from("/photo/categories/raw-_").galleryCategory, "all");
for (const category of ["其他写真 📷", "xiuren", "raw-Zm9v", "V:\\套图|收藏", "[XIUREN] 秀人网"]) {
  const url = routeUrl({ ...shelf, galleryCategory: category });
  assert.match(url, /^\/photo\/categories\/raw-[A-Za-z0-9_-]+$/);
  assert.equal(from(url).galleryCategory, category);
  assert.equal(routeUrl(from(url)), url);
}

const filters = { category: "[XIUREN] 秀人网", folder: "第二组", person: "某位模特", q: "手输词 & more" };
const filtered = from(`/photo/albums?${new URLSearchParams(filters)}`);
const filteredUrl = routeUrl(filtered);
const query = new URL(filteredUrl, window.location.href).searchParams;
assert.equal(query.get("q"), filters.q);
for (const key of ["category", "subCategory", "person"]) {
  assert.equal(query.has(key), false);
  assert.match(query.get(`${key}Key`), /^raw-[A-Za-z0-9_-]+$/);
}
assert.deepEqual(from(filteredUrl), filtered);

const collectionId = "V:\\套图卷|韩国演艺圈/菠萝社 📷";
const legacyDetail = from(`/photo/collection/${encodeURIComponent(collectionId)}?${new URLSearchParams({ category: "韩国演艺圈" })}`);
assert.equal(legacyDetail.galleryCategory, "韩国演艺圈");
assert.equal(legacyDetail.galleryPhotoCollection, collectionId);
const detailUrl = routeUrl(legacyDetail);
assert.match(detailUrl, /^\/photo\/collection\/raw-[A-Za-z0-9_-]+\?categoryKey=raw-[A-Za-z0-9_-]+$/);
assert.deepEqual(from(detailUrl), legacyDetail);

assert.equal(routeUrl(from("/photo/albums")), "/photo/albums");
assert.equal(routeUrl(from("/photo/set/album-123")), "/photo/set/album-123");
assert.equal(from("/media?kind=tv&category=韩剧").galleryCategory, "韩剧");
console.log("photo-router: canonical ASCII categories, opaque collection links, legacy inputs and search round trips passed");
