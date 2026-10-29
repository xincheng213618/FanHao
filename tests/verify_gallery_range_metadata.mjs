import assert from "node:assert/strict";
import fs from "node:fs";
import { runGalleryReaderFixture } from "./verify_web_gallery_requests.mjs";

// Actual mouse and native Chromium touch range gestures, with a synthetic
// complete-directory response delivered while the pointer remains down.
const current = await runGalleryReaderFixture({ casePattern: "pager range metadata:" });
assert.equal(current.checks, 4);
const source = fs.readFileSync(new URL("../public/modules/content-index/gallery-renderer.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
for (const negative of [
  {
    name: "active native range domain",
    marker: 'if (rangeScrubbing) {\n      pendingRangeImages = { images: nextList, options: { ...updateOptions } };\n      return true;\n    }',
    replacement: "// Negative control: apply metadata in the middle of a drag.",
    casePattern: "pager range metadata: full directory completion preserves an active native mouse drag",
    failure: /full directory completion must not reset the native slider domain or discard the held preview/
  },
  {
    name: "deferred directory commit",
    marker: "updateImages(pending.images, { ...pending.options, index: nextIndex });",
    replacement: "currentIndex = nextIndex; update();",
    casePattern: "pager range metadata: full directory completion preserves an active native mouse drag",
    failure: /releasing the native range drag must apply the deferred full directory/
  },
  {
    name: "cancelled preview semantics",
    marker: "if (pending) updateImages(pending.images, pending.options);",
    replacement: "if (pending) updateImages(pending.images, { ...pending.options, index: Number(range.value) - 1 });",
    casePattern: "pager range metadata: native touch cancellation",
    failure: /cancelling a range drag must restore the actually viewed picture rather than commit its preview/
  }
]) {
  assert.equal(source.split(negative.marker).length, 2, `negative must alter only ${negative.name}`);
  await assert.rejects(() => runGalleryReaderFixture({ casePattern: negative.casePattern,
    sourceOverrides: { "/modules/content-index/gallery-renderer.js": source.replace(negative.marker, negative.replacement) }
  }), { name: "AssertionError", message: negative.failure });
  console.log(`PASS negative control detects missing ${negative.name}`);
}
console.log("Gallery range metadata passed (4 private Chromium scenarios + 3 independent negative controls)");
