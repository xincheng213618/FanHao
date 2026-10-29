import assert from "node:assert/strict";
import fs from "node:fs";
import { runGalleryReaderFixture } from "./verify_web_gallery_requests.mjs";

// Actual photo reader, private Chromium and synthetic image/API responses.
// DOM work and node identity are deterministic; loaded first-image requests,
// in-flight startup gating and later navigation/input ownership are observable.
const source = fs.readFileSync(new URL("../public/modules/content-index/gallery-renderer.js", import.meta.url), "utf8");
assert.equal((await runGalleryReaderFixture({ casePattern: "reader width" })).checks, 4);
for (const control of [
  { name: "in-place width update", marker: '    viewer.classList.toggle("fit-width", fitWidth);', replacement: '    renderGalleryView();\n    viewer.classList.toggle("fit-width", fitWidth);', pattern: "reader width 1000", failure: /width switching must preserve mounted images/ },
  { name: "width anchor ownership", marker: "if (galleryReaderWidthRestore !== owner) return;", replacement: "", pattern: "reader width delayed anchors", failure: /new wheel intent must cancel the old width anchor/ }
]) {
  assert.equal(source.split(control.marker).length, 2, `${control.name} must target one implementation`);
  await assert.rejects(() => runGalleryReaderFixture({ casePattern: control.pattern, sourceOverrides: { "/modules/content-index/gallery-renderer.js": source.replace(control.marker, control.replacement) } }), { name: "AssertionError", message: control.failure });
  console.log(`PASS negative control detects missing ${control.name}`);
}
console.log("Gallery reader width passed (4 browser cases and 2 behavior negative controls)");
