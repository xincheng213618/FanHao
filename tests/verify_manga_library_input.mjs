import assert from "node:assert/strict";
import fs from "node:fs";
import { runMangaReaderFixture } from "./verify_manga_reader_requests.mjs";

// Actual manga module/CSS in private Chromium. Trusted native keyboard actions
// and synthetic composition/update events never use the real library or media.
const current = await runMangaReaderFixture({ casePattern: "library filter controls:" });
assert.equal(current.checks, 6);
const source = fs.readFileSync(new URL("../public/modules/photos/manga-page.js", import.meta.url), "utf8");
for (const negative of [
  {
    name: "local library form retention",
    marker: "if (!state.manga.chapter && !state.manga.comic && refreshLibraryKeepingControls()) { syncLibraryComicFeedback(); return; }",
    replacement: "// Negative control: replace the library form on every refresh.",
    casePattern: "library filter controls: sorting",
    failure: /sorting must preserve the unsubmitted manga search instead of erasing the draft/
  },
  {
    name: "connected form ancestor chain",
    marker: "const next = renderLibrary({ includeCards: false, comics });",
    replacement: "const next = renderLibrary({ includeCards: false, comics }); current.append(controls);",
    casePattern: "library filter controls: sorting",
    failure: /sorting must preserve the native form\/input\/select and current focus/
  },
  {
    name: "retired control ownership",
    marker: 'const current = () => page.isConnected && state.activeView === "manga" && !state.manga.comic && !state.manga.chapter\n      && page.dataset.readerGeneration === String(readerGeneration);',
    replacement: "const current = () => true;",
    casePattern: "library filter controls: detached controls cannot change a new comic",
    failure: /retired library controls must not alter a newer view, comic, route or its accepted filter state/
  }
]) {
  const normalized = source.replaceAll("\r\n", "\n");
  assert.equal(normalized.split(negative.marker).length, 2, `negative must alter only ${negative.name}`);
  await assert.rejects(() => runMangaReaderFixture({
    casePattern: negative.casePattern,
    sourceOverrides: { "/modules/photos/manga-page.js": normalized.replace(negative.marker, negative.replacement) }
  }), { name: "AssertionError", message: negative.failure });
  console.log(`PASS negative control detects missing ${negative.name}`);
}
console.log("Manga library input passed (6 private Chromium scenarios + 3 independent negative controls)");
