import assert from "node:assert/strict";
import fs from "node:fs";
import { runMangaReaderFixture } from "./verify_manga_reader_requests.mjs";

// Actual standalone manga host, local synthetic thousand-chapter metadata,
// native keyboard and simulated composition. No real library/API/media.
const pattern = process.argv.find(value => value.startsWith("--case="))?.slice(7) || "";
const negativeOnly = process.argv.includes("--negative-only");
assert(!(negativeOnly && pattern), "--case and --negative-only cannot be combined");
if (!negativeOnly) {
  const current = await runMangaReaderFixture({ casePattern: pattern || "directory search:" });
  if (!pattern) assert.equal(current.checks, 6);
}
if (!pattern) {
  const source = fs.readFileSync(new URL("../public/modules/photos/manga-page.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  for (const negative of [
    {
      name: "normalized title and chapter identity",
      marker: 'function normalizeChapterQuery(value) { return String(value || "").normalize("NFKC").toLocaleLowerCase().trim(); }',
      replacement: 'function normalizeChapterQuery(value) { return String(value || "").toLocaleLowerCase().trim(); }',
      casePattern: "directory search: a thousand",
      failure: /directory search must match normalized titles and the real chapter index/
    },
    {
      name: "composition confirmation submit ownership",
      marker: "if (view.candidateSubmit) { view.candidateSubmit = false; return; }",
      replacement: "// Negative control: process the submit belonging to IME confirmation.",
      casePattern: "directory search: composition confirmation",
      failure: /compositionend followed by browser submit must not move focus or open a chapter/
    },
    {
      name: "live directory input ancestry",
      marker: "function refreshDetailKeepingCatalog() {",
      replacement: "function refreshDetailKeepingCatalog() {\n    return false;",
      casePattern: "directory search: background metadata",
      failure: /background directory metadata must retain the complete live input ancestry, raw text, selection and focus/
    },
    {
      name: "retired directory row ownership",
      marker: "if (!currentDetailView(view) || view.rows.get(key) !== record || row.hidden) return;",
      replacement: "// Negative control: allow an old directory row to act in a newer comic.",
      casePattern: "directory search: retired controls",
      failure: /retired directory search and row controls must preserve the new route, reader, progress and focus/
    }
  ]) {
    assert.equal(source.split(negative.marker).length, 2, `negative must alter only ${negative.name}`);
    await assert.rejects(() => runMangaReaderFixture({ casePattern: negative.casePattern,
      sourceOverrides: { "/modules/photos/manga-page.js": source.replace(negative.marker, negative.replacement) }
    }), { name: "AssertionError", message: negative.failure });
    console.log(`PASS negative control detects missing ${negative.name}`);
  }
  console.log(`Manga directory search passed (${negativeOnly ? 0 : 6} private Chromium scenarios + 4 independent behavior negative controls; synthetic metadata and composition)`);
}
