import assert from "node:assert/strict";
import fs from "node:fs";
import { runGalleryReaderFixture } from "./verify_web_gallery_requests.mjs";

// Actual decoded images, native size transitions and visible image coordinates.
// Deferred RAF replay verifies input priority and old/new image ownership.
const current = await runGalleryReaderFixture({ casePattern: "pager zoom anchor:" });
assert.equal(current.checks, 6);
const source = fs.readFileSync(new URL("../public/modules/content-index/gallery-renderer.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
for (const negative of [
  {
    name: "viewed image region",
    marker: "if (point) keepZoomRegion(point);",
    replacement: 'if (point) stage.scrollTo({ left: 0, top: 0, behavior: "auto" });',
    casePattern: "pager zoom anchor: changing magnification",
    failure: /changing magnification must keep the viewed detail instead of resetting the image to its top-left corner/
  },
  {
    name: "newer input priority",
    marker: 'document.addEventListener(type, cancel, { capture: true, passive: true, signal: anchor.events.signal });',
    replacement: "// Negative control: keep following after newer user input.",
    casePattern: "pager zoom anchor: deferred frames yield to newer wheel intent",
    failure: /a late zoom frame must yield to a newer scroll or focus instead of pulling the image back/
  },
  {
    name: "current zoom frame ownership",
    marker: "if (zoomAnchor !== anchor) return;",
    replacement: "if (zoomAnchor !== anchor) { stopZoomAnchor(); return; }",
    casePattern: "pager zoom anchor: an obsolete frame",
    failure: /an obsolete zoom frame must not stop the current image zoom session/
  }
]) {
  assert.equal(source.split(negative.marker).length, 2, `negative must alter only ${negative.name}`);
  await assert.rejects(() => runGalleryReaderFixture({ casePattern: negative.casePattern,
    sourceOverrides: { "/modules/content-index/gallery-renderer.js": source.replace(negative.marker, negative.replacement) }
  }), { name: "AssertionError", message: negative.failure });
  console.log(`PASS negative control detects missing ${negative.name}`);
}
console.log("Gallery zoom anchor passed (6 private Chromium scenarios + 3 independent negative controls)");
