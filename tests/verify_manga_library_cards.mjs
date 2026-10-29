import assert from "node:assert/strict";
import fs from "node:fs";
import { runMangaReaderFixture } from "./verify_manga_reader_requests.mjs";

// Actual standalone manga host, synthetic shelf/cover/job responses and the
// unchanged 1200ms polling timer. No real collection, database or service.
const caseOption = process.argv.find(value => value.startsWith("--case="));
const negativeOnly = process.argv.includes("--negative-only");
assert(!(caseOption && negativeOnly), "--case and --negative-only cannot be combined");
if (!negativeOnly) {
  const current = await runMangaReaderFixture({ casePattern: caseOption?.slice(7) || "library cards:" });
  if (!caseOption) assert.equal(current.checks, 8);
}
if (!caseOption) {
  const source = fs.readFileSync(new URL("../public/modules/photos/manga-page.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  for (const negative of [
    {
      name: "live source shelf during metadata reads",
      marker: 'const keepLibrary = type === "comic" && currentLibraryView(source);',
      replacement: 'const keepLibrary = false;',
      casePattern: "library cards: opening a thousand-card shelf preserves drafts through failure and retry normal",
      failure: /opening a comic must retain every existing shelf card while its metadata is pending or failed/
    },
    {
      name: "bounded shelf construction",
      marker: "const next = renderLibrary({ includeCards: false, comics });",
      replacement: "const next = renderLibrary({ includeCards: false, comics });\n    comics.forEach(comic => renderComicCard(comic, view)); // Negative: construct discarded staging cards.",
      casePattern: "library cards: unchanged running",
      failure: /an unchanged thousand-card poll must do bounded construction outside the retained cards/
    },
    {
      name: "accepted card metadata updates",
      marker: "} else updateComicCard(record, comic);",
      replacement: "} // Negative control: keep stale fields on an existing card.",
      casePattern: "library cards: fresh metadata",
      failure: /accepted library metadata must update every visible comic-card field and its accessible name/
    },
    {
      name: "focused card reorder anchor",
      marker: "const anchorIndex = wanted.indexOf(anchor);",
      replacement: "const anchorIndex = -1;",
      casePattern: "library cards: background reordering",
      failure: /a background reorder must preserve surviving cards and keep the focused card connected without blur/
    },
    {
      name: "retired shelf card ownership",
      marker: "if (!currentLibraryView(view) || view.cards.get(id) !== record || card.parentElement !== view.grid\n          || view.grid.parentElement !== view.page) return;",
      replacement: "// Negative control: allow an obsolete shelf card to navigate the new view.",
      casePattern: "library cards: retired cards",
      failure: /retired shelf cards must not replace a newer detail, generation or current library membership/
    }
  ]) {
    assert.equal(source.split(negative.marker).length, 2, `negative must alter only ${negative.name}`);
    await assert.rejects(() => runMangaReaderFixture({ casePattern: negative.casePattern,
      sourceOverrides: { "/modules/photos/manga-page.js": source.replace(negative.marker, negative.replacement) }
    }), { name: "AssertionError", message: negative.failure });
    console.log(`PASS negative control detects missing ${negative.name}`);
  }
  console.log(`Manga library cards passed (${negativeOnly ? 0 : 8} private Chromium families + 5 independent behavior negative controls; synthetic library/add polling and metadata reads)`);
}
