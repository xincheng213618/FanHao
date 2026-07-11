import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

const webReader = read("public", "modules", "content-index", "gallery-renderer.js");
for (const marker of [
  "GALLERY_READER_IMAGE_CONCURRENCY = 4",
  "new IntersectionObserver",
  "imageOffset: currentImages.length",
  "mergePhotoReaderImages",
  "captureGalleryReaderScrollAnchor",
  "gallery-reader-progress",
  "gallery-reader-fit-group",
  "gallery-image-pager-thumbnails",
  "applyZoom",
  "requestFullscreen",
  "event.key.toLowerCase() === \"f\"",
  "gallery-reader-shell",
  "gallery-reader-retry",
  "releaseGalleryReaderFigure",
  "if (viewer.isConnected) activateGalleryReaderImages(viewer)"
]) {
  assert(webReader.includes(marker), `web photo reader is missing: ${marker}`);
}
assert.match(webReader, /dataset\.gallerySrc[\s\S]+?removeAttribute\("src"\)[\s\S]+?classList\.add\("failed"\)/, "web photo reader must preserve failed image URLs for retry");

const webStyles = read("public", "modules", "content-index", "styles.css");
for (const marker of [
  ".gallery-reader-toolbar::after",
  "body.gallery-view .gallery-reader-shell .gallery-reader-toolbar",
  ".gallery-image-pager-top-actions",
  ".gallery-image-pager-thumbnail.active",
  "@media (max-width: 760px)"
]) {
  assert(webStyles.includes(marker), `web photo reader styles are missing: ${marker}`);
}
const shellStyles = read("public", "css", "shell.css");
assert.match(shellStyles, /body\.gallery-view \.main\s*\{\s*overflow: visible;/, "gallery main must not create a scroll container that breaks the sticky reader toolbar");

const androidReader = read("android-client", "www", "platform", "content-index", "channel-views.js");
for (const marker of [
  "PHOTO_DETAIL_IMAGE_CONCURRENCY = 4",
  "retryPhotoDetailImage",
  "photoRetrySrc",
  "const imageOffset = loadedImages.length",
  "mergePhotoDetailImages",
  "releasePhotoDetailImage",
  "options.imageOffset"
]) {
  assert(androidReader.includes(marker), `Android photo reader is missing: ${marker}`);
}

const androidStyles = read("android-client", "www", "css", "lists.css");
assert(androidStyles.includes(".photo-preview-tile.load-failed"), "Android photo reader needs a visible retry state");

const photoRoutes = read("src", "modules", "photos", "server", "routes.js");
assert(photoRoutes.includes("imageOffset"), "photo detail API must support incremental image offsets");

console.log("photo-reader-clients: ok");
