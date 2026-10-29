import assert from "node:assert/strict";
import fs from "node:fs";
import { runMangaReaderFixture } from "./verify_manga_reader_requests.mjs";

// Actual manga module/CSS in private Chromium, with synthetic update receipts,
// completed/incomplete chapter DTOs and decoded images. No real comic is used.
const current = await runMangaReaderFixture({ casePattern: "reader chapter navigation:" });
assert.equal(current.checks, 4);
const source = fs.readFileSync(new URL("../public/modules/photos/manga-page.js", import.meta.url), "utf8");
for (const negative of [
  {
    name: "reader navigation refresh",
    marker: "if (state.manga.chapter) refreshReaderChapterNavigation();",
    replacement: "if (state.manga.chapter) return;",
    failure: /completed downloads must make the next chapter reachable without leaving the current reader/
  },
  {
    name: "current directory click target",
    marker: "const adjacent = readerChapterNeighbors(state.manga.comic, chapter)[action];",
    replacement: 'const adjacent = action === "previous" ? previous : next;',
    failure: /enabled next action must resolve the new directory target rather than its old captured neighbor/
  }
]) {
  assert.equal(source.split(negative.marker).length, 2, `negative must alter only ${negative.name}`);
  await assert.rejects(() => runMangaReaderFixture({
    casePattern: "reader chapter navigation: completed update",
    sourceOverrides: { "/modules/photos/manga-page.js": source.replace(negative.marker, negative.replacement) }
  }), { name: "AssertionError", message: negative.failure });
  console.log(`PASS negative control detects missing ${negative.name}`);
}
console.log("Manga chapter navigation passed (4 private Chromium scenarios + 2 independent negative controls)");
