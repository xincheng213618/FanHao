import assert from "node:assert/strict";
import fs from "node:fs";
import { runGalleryReaderFixture } from "./verify_web_gallery_requests.mjs";

// Actual image pager in private Chromium; partial/full albums and repeated
// HTTP failures are synthetic. Both toolbar and image entry paths are exercised.
const current = await runGalleryReaderFixture({ casePattern: "pager catalog recovery:" });
assert.equal(current.checks, 6);
const source = fs.readFileSync(new URL("../public/modules/content-index/gallery-renderer.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
for (const negative of [
  {
    name: "full-directory recovery entry",
    marker: "catalogRetry.hidden = false;",
    replacement: "catalogRetry.hidden = true;",
    casePattern: "pager catalog recovery: failed directory retries from the toolbar entry",
    failure: /a failed full directory must offer recovery instead of silently trapping a large album at its initial loaded range/
  },
  {
    name: "complete directory application",
    marker: "if (Array.isArray(images) && images.length) updateImages(images, { sourceKey });",
    replacement: "if (Array.isArray(images) && images.length) {}",
    casePattern: "pager catalog recovery: failed directory retries from the toolbar entry",
    failure: /a successful catalog retry must restore the full navigation range/
  },
  {
    name: "newer focus priority",
    marker: "if (request.restoreFocus && document.activeElement === stage) catalogRetry.focus({ preventScroll: true });",
    replacement: "if (request.restoreFocus) catalogRetry.focus({ preventScroll: true });",
    casePattern: "pager catalog recovery: failed directory retries from the figure entry",
    failure: /a repeated catalog failure must respect newer focus or keep the original retry reachable/
  }
]) {
  assert.equal(source.split(negative.marker).length, 2, `negative must alter only ${negative.name}`);
  await assert.rejects(() => runGalleryReaderFixture({ casePattern: negative.casePattern,
    sourceOverrides: { "/modules/content-index/gallery-renderer.js": source.replace(negative.marker, negative.replacement) }
  }), { name: "AssertionError", message: negative.failure });
  console.log(`PASS negative control detects missing ${negative.name}`);
}
console.log("Gallery catalog recovery passed (6 private Chromium scenarios + 3 independent negative controls)");
