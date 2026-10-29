import assert from "node:assert/strict";
import fs from "node:fs";
import { runMangaReaderFixture } from "./verify_manga_reader_requests.mjs";

// Actual standalone manga host, document scrolling and native image decoding.
// Chapters, local progress and success/error responses are all synthetic.
const current = await runMangaReaderFixture({ casePattern: "reader position:" });
assert.equal(current.checks, 11);
const source = fs.readFileSync(new URL("../public/modules/photos/manga-page.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
for (const negative of [
  {
    name: "saved position on continue",
    marker: "renderView({ position: options.restorePosition ? readingPositionFor(comic.id, data.chapter?.index) : null });",
    replacement: "renderView({ position: null });",
    casePattern: "reader position: continue reading",
    failure: /continue reading must restore the saved page position inside a long chapter instead of restarting at page one/
  },
  {
    name: "image geometry settling",
    marker: 'const queueRestore = () => {\n      if (!restoring || frame != null) return;',
    replacement: 'let queuedOnce = false;\n    const queueRestore = () => {\n      if (queuedOnce || !restoring || frame != null) return;\n      queuedOnce = true;',
    casePattern: "reader position: missing geometry waits for images and respects complete",
    failure: /restored reading must keep the saved page and its relative offset after image layout or viewport changes/
  },
  {
    name: "newer reading intent",
    marker: "document.addEventListener(type, cancelForIntent, { capture: true, passive: true, signal: restoreEvents.signal });",
    replacement: "// Negative control: keep applying the old restore after new input.",
    casePattern: "reader position: missing geometry waits for images and respects wheel",
    failure: /late image geometry must yield to newer user scrolling or focus instead of pulling back to the saved position/
  }
]) {
  assert.equal(source.split(negative.marker).length, 2, `negative must alter only ${negative.name}`);
  await assert.rejects(() => runMangaReaderFixture({ casePattern: negative.casePattern,
    sourceOverrides: { "/modules/photos/manga-page.js": source.replace(negative.marker, negative.replacement) }
  }), { name: "AssertionError", message: negative.failure });
  console.log(`PASS negative control detects missing ${negative.name}`);
}
console.log("Manga reader position passed (11 private Chromium scenarios + 3 independent negative controls)");
