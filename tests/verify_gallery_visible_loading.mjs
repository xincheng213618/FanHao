import assert from "node:assert/strict";
import fs from "node:fs";
import { runGalleryReaderFixture } from "./verify_web_gallery_requests.mjs";

// Native image loading in private Chromium, actual queue/CSS and synthetic SVGs.
// A decoded image must occupy visible pixels below the sticky reader toolbar;
// src/complete on a distant or empty image cannot satisfy this fixture.
const source = fs.readFileSync(new URL("../public/modules/content-index/gallery-renderer.js", import.meta.url), "utf8");
assert.equal((await runGalleryReaderFixture({ casePattern: "reader loading reaches visible images" })).checks, 2);
const marker = '    img.loading = "eager";';
assert.equal(source.split(marker).length, 2, "negative must target the application queue's native-loading decision");
await assert.rejects(() => runGalleryReaderFixture({
  casePattern: "reader loading reaches visible images after long scrolls observer",
  sourceOverrides: { "/modules/content-index/gallery-renderer.js": source.replace(marker, '    img.loading = "lazy";') }
}), { name: "AssertionError", message: /long scrolling must decode an actually visible image/ });
console.log("PASS negative control detects queue slots blocked by native lazy loading");
console.log("Gallery visible loading passed (2 browser cases and 1 behavior negative control)");
