import assert from "node:assert/strict";
import fs from "node:fs";
import { runNovelReaderFixture } from "./verify_novel_reader_requests.mjs";

// Actual standalone novel UI, private Chromium and synthetic book/text APIs.
// These controls remove one current behavior at a time without using git HEAD.
const caseOption = process.argv.find(value => value.startsWith("--case="));
const negativeOnly = process.argv.includes("--negative-only");
assert(!(caseOption && negativeOnly), "--case and --negative-only cannot be combined");
if (!negativeOnly) {
  const result = await runNovelReaderFixture({ casePattern: caseOption?.slice(7) || "library origin " });
  assert(result.checks > 0, "the selected library-origin cases must exist");
}
if (!caseOption) {
  const readSource = file => fs.readFileSync(new URL(`../public/modules/novels/${file}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const page = readSource("novel-page.js"), restore = readSource("list-return.js");
  for (const control of [
    { name: "loaded-prefix reuse", source: page, path: "novel-page.js", casePattern: "library origin returns to loaded search conditions and book anchor ignore-abort", marker: "state.novel.data === context.data", replacement: "false", failure: /an unchanged library return must reuse the entire loaded prefix/ },
    { name: "visible source anchor restoration", source: restore, path: "list-return.js", casePattern: "library origin returns to loaded search conditions and book anchor ignore-abort", marker: 'window.scrollBy({ top: rect.top - top, behavior: "auto" });', replacement: "", failure: /returning must restore the source book's viewport anchor/ },
    { name: "failed return range recovery", source: page, path: "novel-page.js", casePattern: "library origin failed fresh return retries its loaded range and target ignore-abort", marker: "if (context?.retry && !options.append", replacement: "if (false && !options.append", failure: /a failed source return must retry its original loaded range instead of only the first 48 books/ },
    { name: "delivered-row prefix cursor", source: page, path: "novel-page.js", casePattern: "library origin fresh prefix crosses 5000 using delivered rows ignore-abort", marker: "const nextOffset = novelNextOffset(page, offset);", replacement: 'const nextOffset = offset + Number(params.get("limit"));', failure: /source restoration must continue after delivered rows to the original raw cursor, not unique books or the requested 5000-row limit/ },
    { name: "newer list interaction intent", source: restore, path: "list-return.js", casePattern: "library origin fresh return respects newer focus ignore-abort", marker: "document.addEventListener(type, noteIntent, { capture: true, passive: true, signal: controller.signal });", replacement: "", failure: /a fresh source return must not override newer user focus by scrolling back to its old book/ },
    { name: "live metadata detail during catalog completion", source: page, path: "novel-page.js", casePattern: "library origin return remains reachable at narrow widths ignore-abort",
      marker: 'const currentDetailScrollY = window.scrollY;\n        if (!updateCurrentBookDetailCatalog(owner, book)) renderView();',
      replacement: 'const currentDetailScrollY = window.scrollY;\n        renderView();',
      failure: /catalog completion must preserve the usable metadata detail/ }
  ]) {
    assert.equal(control.source.split(control.marker).length - 1, 1, `negative must modify its current owning behavior: ${control.name}`);
    await assert.rejects(() => runNovelReaderFixture({ casePattern: control.casePattern, sourceOverrides: { [`/modules/novels/${control.path}`]: control.source.replace(control.marker, control.replacement) } }), { name: "AssertionError", message: control.failure });
    console.log(`PASS negative control detects missing ${control.name}`);
  }
}
