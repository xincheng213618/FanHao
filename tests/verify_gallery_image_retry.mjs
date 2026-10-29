import assert from "node:assert/strict";
import fs from "node:fs";
import { runGalleryReaderFixture } from "./verify_web_gallery_requests.mjs";

// Actual image pager and private Chromium, with synthetic 503s and controlled
// retry/metadata responses. No real albums, caches or service are accessed.
const source = fs.readFileSync(new URL("../public/modules/content-index/gallery-renderer.js", import.meta.url), "utf8");
const current = await runGalleryReaderFixture({ casePattern: "pager image retry" });
assert.equal(current.checks, 6);
for (const control of [
  {
    name: "current image ownership",
    marker: "if (!currentImage() || !imageFailed || imageRetrying) return;",
    replacement: "if (!currentImage() || imageRetrying) return;",
    pattern: "pager image retry yields to next image success",
    failure: /obsolete retry action cannot replace the current image source/
  },
  {
    name: "preserved retry zoom",
    marker: "applyZoom(zoomLevel, { preserveScroll: preserveImageScroll });",
    replacement: "applyZoom(1, { preserveScroll: preserveImageScroll });",
    pattern: "pager image retry success",
    failure: /current image recovery must preserve the mounted viewer/
  }
]) {
  assert.equal(source.split(control.marker).length, 2, `negative must target one guarantee: ${control.name}`);
  await assert.rejects(() => runGalleryReaderFixture({
    casePattern: control.pattern,
    sourceOverrides: { "/modules/content-index/gallery-renderer.js": source.replace(control.marker, control.replacement) }
  }), { name: "AssertionError", message: control.failure });
  console.log(`PASS negative control detects missing ${control.name}`);
}
console.log("Gallery image retry passed (6 browser cases and 2 behavior negative controls)");
