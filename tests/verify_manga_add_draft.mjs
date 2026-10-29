import assert from "node:assert/strict";
import fs from "node:fs";
import { runMangaReaderFixture } from "./verify_manga_reader_requests.mjs";

// Actual standalone manga host; native form submission and private synthetic
// add/update receipts exercise editing, busy/failure changes and old controls.
const current = await runMangaReaderFixture({ casePattern: "library add draft:" });
assert.equal(current.checks, 5);
const source = fs.readFileSync(new URL("../public/modules/photos/manga-page.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
for (const negative of [
  {
    name: "unsubmitted add form retention",
    marker: "if (add?.dataset.addViewKey && add.dataset.addViewKey === nextAdd?.dataset.addViewKey) retained.set(nextAdd, add);",
    replacement: "// Negative control: recreate the idle add form on background updates.",
    casePattern: "library add draft: a background comic update",
    failure: /a background library refresh must not erase an unsubmitted comic source link/
  },
  {
    name: "add lifecycle refresh boundary",
    marker: 'if (!addRunning) addPanel.dataset.addViewKey = JSON.stringify([state.manga.addUrl, state.manga.addJob?.id || "", progress, state.manga.addError, addedComic?.id || ""]);',
    replacement: 'addPanel.dataset.addViewKey = "fixed";',
    casePattern: "library add draft: a background comic update",
    failure: /starting a submitted add job must update the preserved form into its disabled busy state/
  },
  {
    name: "retired add form ownership",
    marker: 'const currentAdd = () => addPanel.isConnected && currentLibraryView(libraryView)\n        && addPanel.closest(".manga-library") === libraryView.page && libraryView.page.querySelector(".manga-add-panel") === addPanel;',
    replacement: "const currentAdd = () => true;",
    casePattern: "library add draft: retired form cannot submit or close a new comic",
    failure: /retired add controls must not submit their draft into a newer view or comic/
  }
]) {
  assert.equal(source.split(negative.marker).length, 2, `negative must alter only ${negative.name}`);
  await assert.rejects(() => runMangaReaderFixture({ casePattern: negative.casePattern,
    sourceOverrides: { "/modules/photos/manga-page.js": source.replace(negative.marker, negative.replacement) }
  }), { name: "AssertionError", message: negative.failure });
  console.log(`PASS negative control detects missing ${negative.name}`);
}
console.log("Manga add draft passed (5 private Chromium scenarios + 3 independent negative controls)");
