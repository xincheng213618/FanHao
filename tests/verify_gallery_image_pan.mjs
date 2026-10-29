import assert from "node:assert/strict";
import fs from "node:fs";
import { runGalleryReaderFixture } from "./verify_web_gallery_requests.mjs";

// Trusted mouse/touch input over the actual Web reader. Every API and decoded
// image belongs to the private Chromium fixture, not the application library.
const current = await runGalleryReaderFixture({ casePattern: "pager pan " });
assert.equal(current.checks, 4);
const source = fs.readFileSync(new URL("../public/modules/content-index/gallery-renderer.js", import.meta.url), "utf8");
const marker = "if (zoomLevel <= 1 || !imageNode.naturalWidth || event.button !== 0 || event.isPrimary === false || imagePan) return;";
assert.equal(source.split(marker).length, 2, "negative must disable only magnified-image pan admission");
await assert.rejects(() => runGalleryReaderFixture({
  casePattern: "pager pan mouse",
  sourceOverrides: { "/modules/content-index/gallery-renderer.js": source.replace(marker, "return;") }
}), { name: "AssertionError", message: /dragging a zoomed image must reveal its magnified right and lower regions/ });
console.log("PASS negative control detects the missing mouse pan");
const styles = fs.readFileSync(new URL("../public/modules/content-index/styles.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const touch = "  overflow: auto;\n  touch-action: none;";
assert.equal(styles.split(touch).length, 2, "negative must restore only the image scrollport's native gesture arbitration");
await assert.rejects(() => runGalleryReaderFixture({
  casePattern: "pager pan touch",
  sourceOverrides: { "/modules/content-index/styles.css": styles.replace(touch, "  overflow: auto;") }
}), { name: "AssertionError", message: /dragging a zoomed image must reveal its magnified right and lower regions/ });
console.log("PASS negative control detects native scrolling cancelling the touch pan");
console.log("Gallery image pan passed (4 private Chromium scenarios + 2 independent negative controls)");
