import assert from "node:assert/strict";
import fs from "node:fs";
import { runMangaReaderFixture } from "./verify_manga_reader_requests.mjs";

// Native keyboard, document scrolling and decoded synthetic images in the
// actual standalone manga host. Never reads a real comic or running service.
const current = await runMangaReaderFixture({ casePattern: "reader page navigation:" });
assert.equal(current.checks, 7);
const source = fs.readFileSync(new URL("../public/modules/photos/manga-page.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
for (const negative of [
  {
    name: "reachable page entry",
    marker: "floating.append(readerPageNavigation(page, comic, chapter));",
    replacement: "// Negative control: no current-page entry in the reader.",
    casePattern: "reader page navigation: a long chapter",
    failure: /a long chapter needs a current-page and exact jump entry reachable while reading its middle/
  },
  {
    name: "retired page control ownership",
    marker: 'const current = () => currentReaderView(view);\n    const form = document.createElement("form");',
    replacement: 'const current = () => true;\n    const form = document.createElement("form");',
    casePattern: "reader page navigation: old controls cannot jump a new chapter",
    failure: /retired page controls must not cancel the newer reader page tracking session/
  },
  {
    name: "visible toolbar inset",
    marker: "- (position.pageJump || position.fitChange ? readerTopInset(page) : 0)",
    replacement: "- (position.fitChange ? readerTopInset(page) : 0)",
    casePattern: "reader page navigation: unknown target geometry respects complete",
    failure: /an unknown image target must settle below the visible reader toolbar without covering its first pixels/
  }
]) {
  assert.equal(source.split(negative.marker).length, 2, `negative must alter only ${negative.name}`);
  await assert.rejects(() => runMangaReaderFixture({ casePattern: negative.casePattern,
    sourceOverrides: { "/modules/photos/manga-page.js": source.replace(negative.marker, negative.replacement) }
  }), { name: "AssertionError", message: negative.failure });
  console.log(`PASS negative control detects missing ${negative.name}`);
}
console.log("Manga page navigation passed (7 private Chromium scenarios + 3 independent negative controls)");
