import assert from "node:assert/strict";
import fs from "node:fs";
import { runMangaReaderFixture } from "./verify_manga_reader_requests.mjs";

// Actual manga host, native scroll/keyboard/image loading, synthetic chapters.
// RAF interception models an already queued compensation callback, not a
// renderer-wide freeze; no real library, service, or media is accessed.
const pattern = process.argv.find(value => value.startsWith("--case="))?.slice(7) || "";
const negativeOnly = process.argv.includes("--negative-only");
assert(!(negativeOnly && pattern), "--case and --negative-only cannot be combined");
if (!negativeOnly) {
  const result = await runMangaReaderFixture({ casePattern: pattern || "fit position:" });
  if (!pattern) assert.equal(result.checks, 5, "the default fit-position gate must execute all five behavior families");
}
if (!pattern) {
  const pagePath = "/modules/photos/manga-page.js", cssPath = "/modules/photos/manga.css";
  const read = file => fs.readFileSync(new URL(`../public${file}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const source = read(pagePath), css = read(cssPath);
  for (const negative of [
    {
      name: "undecoded original-width geometry", path: cssPath, source: css,
      marker: "width: var(--manga-original-width, auto);", replacement: "width: auto;",
      casePattern: "fit position: desktop width changes",
      failure: /original-width known metadata must reserve a nonzero distant page before it decodes/
    },
    {
      name: "current viewport anchor on fit change", path: pagePath, source,
      marker: "const anchor = readerPosition?.capture(readerTopInset(page));", replacement: "const anchor = null;",
      casePattern: "fit position: desktop width changes",
      failure: /changing manga width must retain the current reading page|changing manga width must retain the within-page reading ratio at the actual viewport inset/
    },
    {
      name: "newer user intent priority", path: pagePath, source,
      marker: "document.addEventListener(type, cancelForIntent, { capture: true, passive: true, signal: restoreEvents.signal });",
      replacement: "if (!position.fitChange) document.addEventListener(type, cancelForIntent, { capture: true, passive: true, signal: restoreEvents.signal });",
      casePattern: "fit position: newer wheel",
      failure: /deferred width compensation must respect newer user scrolling and focus instead of pulling back/
    }
  ]) {
    assert.equal(negative.source.split(negative.marker).length, 2, `negative must alter only one ${negative.name} marker`);
    await assert.rejects(() => runMangaReaderFixture({ casePattern: negative.casePattern,
      sourceOverrides: { [negative.path]: negative.source.replace(negative.marker, negative.replacement) }
    }), { name: "AssertionError", message: negative.failure });
    console.log(`PASS negative control detects missing ${negative.name}`);
  }
}
console.log(`Manga fit position passed (${pattern ? "selected behavior family" : negativeOnly ? "3 independent negative controls" : "5 private Chromium behavior families + 3 independent negative controls"})`);
