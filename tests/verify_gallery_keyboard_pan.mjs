import assert from "node:assert/strict";
import fs from "node:fs";
import { runGalleryReaderFixture } from "./verify_web_gallery_requests.mjs";

// Real Chromium keyboard scrolling of a decoded, magnified synthetic image.
// Other reader controls and fitted images keep the existing navigation keys.
const current = await runGalleryReaderFixture({ casePattern: "pager keyboard pan:" });
assert.equal(current.checks, 4);
const source = fs.readFileSync(new URL("../public/modules/content-index/gallery-renderer.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
for (const negative of [
  {
    name: "native image scrolling",
    replacement: "false",
    casePattern: "pager keyboard pan: a magnified image",
    failure: /vertical inspection of a magnified focused image must not change the current photo/
  },
  {
    name: "fitted navigation scope",
    replacement: "imageNode.naturalWidth && event.target === stage",
    casePattern: "pager keyboard pan: native horizontal boundaries and fitted navigation 1280px",
    failure: /fitted image arrow navigation must retain its existing page-switch behavior/
  },
  {
    name: "focused image scope",
    replacement: "zoomLevel > 1 && imageNode.naturalWidth",
    casePattern: "pager keyboard pan: other focused controls",
    failure: /magnification must not change keys belonging to a different focused reader control/
  }
]) {
  const marker = "zoomLevel > 1 && imageNode.naturalWidth && event.target === stage";
  assert.equal(source.split(marker).length, 2, `negative must alter only ${negative.name}`);
  await assert.rejects(() => runGalleryReaderFixture({ casePattern: negative.casePattern,
    sourceOverrides: { "/modules/content-index/gallery-renderer.js": source.replace(marker, negative.replacement) }
  }), { name: "AssertionError", message: negative.failure });
  console.log(`PASS negative control detects missing ${negative.name}`);
}
console.log("Gallery keyboard pan passed (4 private Chromium scenarios + 3 independent negative controls)");
