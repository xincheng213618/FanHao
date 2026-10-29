import assert from "node:assert/strict";
import fs from "node:fs";
import { runGalleryReaderFixture } from "./verify_web_gallery_requests.mjs";

// Actual renderer, private Chromium and synthetic album/images. Each negative
// removes only one guarantee so a passing check cannot come from the fixture.
const source = fs.readFileSync(new URL("../public/modules/content-index/gallery-renderer.js", import.meta.url), "utf8");
const current = await runGalleryReaderFixture({ casePattern: "pager keyboard" });
assert.equal(current.checks, 4);

const negatives = [
  {
    name: "modal Tab boundary",
    marker: 'if (event.key === "Tab") {',
    replacement: 'if (false && event.key === "Tab") {',
    pattern: "pager keyboard modal focus",
    failure: /reverse Tab wraps inside the modal/
  },
  {
    name: "thumbnail focus ownership",
    marker: "const restoreThumbnailFocus = thumbnails.contains(document.activeElement);",
    replacement: "const restoreThumbnailFocus = false;",
    pattern: "pager keyboard thumbnail focus",
    failure: /thumbnail activation must retain keyboard focus/
  },
  {
    name: "focused controls stay visible",
    marker: "if (imageFailed || imageRetrying || top.contains(document.activeElement) || controls.contains(document.activeElement)) return;",
    replacement: "if (false) return;",
    pattern: "pager keyboard controls remain visible",
    failure: /idle timeout must not hide a focused control/
  },
  {
    name: "browser and input method shortcuts",
    marker: "if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;",
    replacement: "if (event.defaultPrevented) return;",
    pattern: "pager keyboard preserves modified",
    failure: /reader must leave modified\/composing key alone/
  }
];
for (const negative of negatives) {
  assert.equal(source.split(negative.marker).length, 2, `negative must target exactly one implementation: ${negative.name}`);
  await assert.rejects(() => runGalleryReaderFixture({
    casePattern: negative.pattern,
    sourceOverrides: { "/modules/content-index/gallery-renderer.js": source.replace(negative.marker, negative.replacement) }
  }), { name: "AssertionError", message: negative.failure });
  console.log(`PASS negative control detects missing ${negative.name}`);
}
console.log("Photo pager keyboard fixture passed (4 browser cases and 4 behavior negative controls)");
