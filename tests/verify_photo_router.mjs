import assert from "node:assert/strict";
import { normalizePhotoBrowseCategory, normalizeRoute, routeFromUrl, routeUrl } from "../public/js/router.js";
import { createGalleryPage } from "../public/modules/content-index/gallery-page.js";

globalThis.window = { location: new URL("http://fixture.invalid/photo/collections") };
const shelf = { view: "gallery", galleryMode: "photo", galleryPhotoView: "collections", gallerySort: "count" };
const from = value => normalizeRoute(routeFromUrl(value));

for (const [slug, category, legacy] of [
  ["sites", "catalog:sites", "名站套图"],
  ["xiuren", "catalog:xiuren", "[XIUREN] 秀人网"],
  ["yituyu", "catalog:yituyu", "[YITUYU艺图语]"],
  ["mslass", "catalog:mslass", "[MSLASS梦丝女神]"],
  ["korean-entertainment", "catalog:korean-entertainment", "韩国演艺圈"],
  ["fetish", "catalog:fetish", "恋足恋物"],
  ["loli-series", "catalog:loli-series", "萝莉系列"],
  ["tuwan", "catalog:tuwan"],
  ["bobosocks", "catalog:bobosocks", "[BoBoSocks袜啵啵]"],
  ["bololi", "publisher:bololi", "[BoLoli]波萝社"],
  ["girlt", "catalog:girlt", "[Girlt] 果团网"],
  ["qingdouke", "catalog:qingdouke", "[QingDouKe] 青豆客"],
  ["japan", "catalog:japan", "日本写真集"],
  ["korea", "catalog:korea", "韩国写真集"],
  ["ys-web", "catalog:ys-web", "YS Web"],
  ["maxi-247", "catalog:maxi-247", "Maxi-247 - 301 Rei"],
  ["make-model", "catalog:make-model", "[Make model]"],
  ["street", "catalog:street", "精选街拍"],
  ["mojing", "catalog:mojing", "魔镜街拍"],
  ["leeheeexpress", "catalog:leeheeexpress", "[LeeheeExpress]"],
  ["partycat", "catalog:partycat", "[Partycat]"],
  ["tuigirl", "catalog:tuigirl", "[TuiGirl] 推女郎"],
  ["slady", "catalog:slady", "[SLADY]猎女神"],
  ["likes", "catalog:likes", "我喜欢的"],
  ["miscellaneous", "catalog:miscellaneous", "[零散]"],
  ["portraits", "catalog:portraits", "[]"],
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
  assert.equal(routeUrl({ ...shelf, galleryCategory: legacy }), pathname);
  const opaque = Buffer.from(legacy).toString("base64url");
  assert.equal(routeUrl(from(`/photo/categories/raw-${opaque}`)), pathname);
  assert.equal(from(`/photo/albums?${query}`).galleryCategory, legacy);
}

assert.equal(routeUrl(shelf), "/photo/collections");
assert.equal(from("/photo/collections").galleryCategory, "all");
assert.equal(routeUrl(from(`/photo/collections?${new URLSearchParams({ category: "丝袜恋足" })}`)), "/photo/categories/fetish");
assert.equal(from("/photo/categories/raw-_").galleryCategory, "all");
for (const category of ["其他写真 📷", "xiuren", "raw-Zm9v", "V:\\套图|收藏"]) {
  const url = routeUrl({ ...shelf, galleryCategory: category });
  assert.match(url, /^\/photo\/categories\/raw-[A-Za-z0-9_-]+$/);
  assert.equal(from(url).galleryCategory, category);
  assert.equal(routeUrl(from(url)), url);
}

const filters = { category: "[XIUREN] 秀人网", folder: "第二组", person: "某位模特", q: "手输词 & more" };
const { q: searchText, ...browseFilters } = filters;
const filtered = from(`/photo/albums?${new URLSearchParams(browseFilters)}`);
const filteredUrl = routeUrl(filtered);
const query = new URL(filteredUrl, window.location.href).searchParams;
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

const people = from("/photo/people");
assert.equal(people.galleryPhotoView, "people");
assert.equal(people.galleryAlbumId, "");
assert.equal(people.gallerySort, "count");
assert.equal(people.gallerySortDirection, "");
assert.equal(routeUrl(people), "/photo/people");
assert.equal(routeUrl(from("/photo?photoView=people")), "/photo/people");
assert.equal(routeUrl(from("/photo/people?sort=updated&dir=sideways&collection=obsolete")), "/photo/people");
const peopleSearch = from(`/photo/people?${new URLSearchParams({ q: filters.person, category: filters.category, sort: "title", dir: "asc" })}`);
assert.equal(peopleSearch.galleryPhotoView, "albums");
assert.equal(peopleSearch.gallerySort, "updated");
assert.equal(peopleSearch.gallerySortDirection, "");
assert.equal(peopleSearch.galleryQuery, filters.person);
assert.equal(new URL(routeUrl(peopleSearch), window.location.href).pathname, "/photo/search");
assert.deepEqual(from(routeUrl(peopleSearch)), peopleSearch);
assert.equal(routeUrl(from("/photo/collections?dir=asc")), "/photo/collections?dir=asc");
assert.equal(routeUrl(from("/photo/albums?sort=title&dir=desc")), "/photo/albums?sort=title&dir=desc");
assert.equal(routeUrl(from("/media?dir=asc")), "/media");

const queryString = new URLSearchParams({ q: searchText }).toString();
const scopedQuery = new URLSearchParams({ ...filters, date: "2026", collection: collectionId, kind: "tv", seriesKey: "series-1" });
for (const [legacy, canonical] of [
  [`/photo/albums?${scopedQuery}`, "/photo/search"],
  [`/photo/categories/xiuren?${scopedQuery}`, "/photo/search"],
  [`/photo/collection/${encodeURIComponent(collectionId)}?${scopedQuery}`, "/photo/search"],
  [`/photo/people?${scopedQuery}`, "/photo/search"],
  [`/media?${scopedQuery}`, "/media/search"],
  [`/movies?${scopedQuery}`, "/movie/search"],
  [`/gallery/tv?${scopedQuery}`, "/tv/search"],
  [`/gallery/western?${scopedQuery}`, "/western/search"],
  [`/manga?${scopedQuery}`, "/manga/search"],
  [`/gallery/manga?${scopedQuery}`, "/manga/search"]
]) {
  const expected = `${canonical}?${queryString}`;
  assert.equal(routeUrl(from(legacy)), expected);
  assert.equal(routeUrl(from(expected)), expected);
}
assert.equal(routeUrl(from("/photo/search")), "/photo/collections");
assert.equal(routeUrl(from("/movie/search")), "/movies");
assert.equal(routeUrl(from("/manga/search")), "/manga");
assert.equal(routeUrl(from(`/manga/search?${queryString}&sort=title`)), `/manga/search?${queryString}&sort=title`);
assert.equal(routeUrl(from(`/photo/search?${queryString}&sort=title&dir=desc`)), `/photo/search?${queryString}`);
for (const [detail, expected] of [
  ["/photo/set/album-123", "/photo/set/album-123"],
  ["/movie/movie-123", "/movies/movie-123"],
  ["/manga/comic-123", "/manga/comic-123"],
  ["/manga/comic-123/read/4", "/manga/comic-123/read/4"]
]) assert.equal(routeUrl(from(`${detail}?${scopedQuery}`)), `${expected}?${queryString}`);

globalThis.document = { activeElement: null };
const state = { activeView: "gallery", gallery: {} };
const requests = [];
const searchInput = { value: "" };
const gallery = createGalleryPage({
  state,
  els: { workGrid: { querySelector: selector => selector === ".gallery-search" ? searchInput : null } },
  async api(path) {
    requests.push(new URL(path, window.location.href).searchParams);
    return { items: [], total: 0 };
  },
  renderGalleryStats() {},
  renderGalleryView() {}
});
gallery.applyRouteState(from("/photo/people?sort=title&dir=asc"));
const ascendingKey = gallery.imageLibraryListKey();
await gallery.loadImageLibraryItems({ renderStart: false });
assert.equal(requests.at(-1).get("photoView"), "people");
assert.equal(requests.at(-1).has("q"), false);
assert.equal(requests.at(-1).get("sort"), "title");
assert.equal(requests.at(-1).get("direction"), "asc");
assert.equal(requests.at(-1).has("collectionPage"), false);
state.gallery.sortDirection = "desc";
assert.notEqual(gallery.imageLibraryListKey(), ascendingKey);
await gallery.loadImageLibraryItems({ renderStart: false });
assert.equal(requests.at(-1).get("direction"), "desc");
gallery.applyRouteState(people);
await gallery.loadImageLibraryItems({ renderStart: false });
assert.equal(requests.at(-1).get("sort"), "count");
assert.equal(requests.at(-1).has("direction"), false);
gallery.applyRouteState(from(`/photo/albums?${new URLSearchParams({ person: filters.person, q: searchText, dir: "asc" })}`));
// A request can start before the renderer writes its canonical search route.
Object.assign(state.gallery, { photoView: "people", photoCollection: collectionId, category: filters.category, person: filters.person,
  subCategory: filters.folder, photoDate: "2026", sort: "title", sortDirection: "asc" });
await gallery.loadImageLibraryItems({ renderStart: false });
assert.equal(requests.at(-1).get("photoView"), "albums");
for (const key of ["collection", "category", "person", "subCategory", "date"]) assert.equal(requests.at(-1).has(key), false);
assert.equal(requests.at(-1).get("q"), searchText);
assert.equal(requests.at(-1).get("sort"), "relevance");
assert.equal(requests.at(-1).has("direction"), false);
gallery.applyRouteState(from(`/media?${scopedQuery}`));
assert.equal(searchInput.value, searchText);
Object.assign(state.gallery, { category: "韩剧", mediaKind: "tv", person: "Series", seriesKey: "series-1" });
await gallery.loadImageLibraryItems({ renderStart: false });
for (const key of ["kind", "category", "person", "seriesKey"]) assert.equal(requests.at(-1).has(key), false);
assert.equal(requests.at(-1).get("q"), searchText);
gallery.applyRouteState(from("/media"));
assert.equal(searchInput.value, "", "history navigation replaces the focused input's old search draft");
console.log("photo-router: browse compatibility, dedicated search, detail return context and gallery request scopes passed");
