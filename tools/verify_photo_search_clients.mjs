import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

const webPage = read("public", "modules", "content-index", "gallery-page.js");
assert(webPage.includes('sort: query ? "relevance"'), "Web photo search must request relevance order");
assert(webPage.includes("mergeImageLibraryListItems"), "Web photo pagination must merge offset pages");
assert(webPage.includes("targetCount - offset"), "Web photo pagination must request only the missing range");

const router = read("public", "js", "router.js");
assert(router.includes("photoSearch ? \"all\""), "A direct Web photo search must default to the full library");

const webRenderer = read("public", "modules", "content-index", "gallery-renderer.js");
assert(!webRenderer.includes('createGalleryFilterField("文件夹"'), "Web photo controls must not render the folder dropdown");
for (const marker of [
  "renderPagedImageLibrarySearchSummary",
  "gallerySearchMatchText",
  "多个词可同时匹配",
  "startingPhotoSearch",
  "search.value = nextQuery",
  "controls.append(searchRow, hierarchy)",
  "按相关性排序"
]) {
  assert(webRenderer.includes(marker), `Web photo search is missing: ${marker}`);
}

const androidViews = read("android-client", "www", "platform", "content-index", "channel-views.js");
for (const marker of [
  'sort: text ? "relevance"',
  "mergeChannelPageData",
  "limit - offset",
  "channelSearchMatchText",
  "同时包含",
  '"relevance"'
]) {
  assert(androidViews.includes(marker), `Android photo search is missing: ${marker}`);
}

const androidApp = read("android-client", "www", "app.js");
assert(androidApp.includes("startingPhotoSearch"), "Android must reset implicit photo filters when starting a search");

const service = read("src", "modules", "content-index", "server", "image-library-service.js");
for (const marker of [
  "preparedPhotoCatalog",
  "createImageSearchQuery",
  "compareImageSearchResults",
  "matchFields"
]) {
  assert(service.includes(marker), `photo search service is missing: ${marker}`);
}

console.log("photo-search-clients: ok");
