import assert from "node:assert/strict";
import fs from "node:fs";
import { runMangaReaderFixture } from "./verify_manga_reader_requests.mjs";

// Actual /manga host with private synthetic SVGs/metadata. Only viewport or
// scroll/keyboard-exposed images are decoded after natural network completion.
const caseOption = process.argv.find(value => value.startsWith("--case="));
const negativeOnly = process.argv.includes("--negative-only");
assert(!(caseOption && negativeOnly), "--case and --negative-only cannot be combined");
if (!negativeOnly) {
  const current = await runMangaReaderFixture({ casePattern: caseOption?.slice(7) || "library covers:" });
  if (!caseOption) assert.equal(current.checks, 4);
}
if (!caseOption) {
  const source = fs.readFileSync(new URL("../public/modules/photos/manga-page.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  for (const negative of [
    {
      name: "initial shelf cover deferral",
      marker: "const cover = coverMarkup(comic, comic.title, { lazy: true });",
      replacement: "const cover = coverMarkup(comic, comic.title);",
      casePattern: "library covers: first viewport",
      failure: /the initial manga shelf must stay within its viewport cover request budget/
    },
    {
      name: "replacement shelf cover deferral",
      marker: "holder.innerHTML = coverMarkup(comic, title, { lazy: true });",
      replacement: "holder.innerHTML = coverMarkup(comic, title);",
      casePattern: "library covers: same-url metadata",
      failure: /a replacement distant shelf cover must be deferred at creation without an eager request/
    },
    {
      name: "detail hero first-read policy",
      marker: "function coverMarkup(comic, title, { lazy = false } = {}) {",
      replacement: "function coverMarkup(comic, title, { lazy = true } = {}) {",
      casePattern: "library covers: detail heroes",
      failure: /the first-read detail hero must retain its non-lazy loading policy/
    }
  ]) {
    assert.equal(source.split(negative.marker).length, 2, `negative must alter only ${negative.name}`);
    await assert.rejects(() => runMangaReaderFixture({ casePattern: negative.casePattern,
      sourceOverrides: { "/modules/photos/manga-page.js": source.replace(negative.marker, negative.replacement) }
    }), { name: "AssertionError", message: negative.failure });
    console.log(`PASS negative control detects missing ${negative.name}`);
  }
  console.log(`Manga library covers passed (${negativeOnly ? 0 : 4} private Chromium families + 3 independent behavior negative controls; native image loading and synthetic SVGs)`);
}
