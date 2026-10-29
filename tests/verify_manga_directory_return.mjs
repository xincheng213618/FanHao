import assert from "node:assert/strict";
import fs from "node:fs";
import { runMangaReaderFixture } from "./verify_manga_reader_requests.mjs";

// Actual standalone host and native keyboard/pointer actions in a private
// synthetic 1000-chapter catalog. No real library, image or service is used.
const current = await runMangaReaderFixture({ casePattern: "directory return:" });
assert.equal(current.checks, 5);
const source = fs.readFileSync(new URL("../public/modules/photos/manga-page.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
for (const negative of [
  {
    name: "current chapter visibility",
    marker: 'target.closest(".manga-chapter-row").scrollIntoView({ block: "center", behavior: "instant" });',
    replacement: "// Negative control: leave the current chapter outside the visible catalog.",
    casePattern: "directory return: keyboard return",
    failure: /returning from a deep chapter must reveal its current directory entry in the viewport/
  },
  {
    name: "pointer focus policy",
    marker: "if (event.detail === 0) {",
    replacement: "if (true) {",
    casePattern: "directory return: pointer footer",
    failure: /pointer return must not force keyboard focus into the chapter catalog/
  },
  {
    name: "retired reader ownership",
    marker: 'page.querySelectorAll(\'[data-action="detail"]\').forEach((button) => button.addEventListener("click", (event) => {\n      if (!currentReaderView(view)) return;',
    replacement: 'page.querySelectorAll(\'[data-action="detail"]\').forEach((button) => button.addEventListener("click", (event) => {\n      // Negative control: permit a retired reader to return the newer view to its old directory.',
    casePattern: "directory return: retired controls cannot change a new comic",
    failure: /retired directory controls must not replace a newer comic or chapter reading surface/
  }
]) {
  assert.equal(source.split(negative.marker).length, 2, `negative must alter only ${negative.name}`);
  await assert.rejects(() => runMangaReaderFixture({ casePattern: negative.casePattern,
    sourceOverrides: { "/modules/photos/manga-page.js": source.replace(negative.marker, negative.replacement) }
  }), { name: "AssertionError", message: negative.failure });
  console.log(`PASS negative control detects missing ${negative.name}`);
}
console.log("Manga directory return passed (5 private Chromium scenarios + 3 independent negative controls)");
