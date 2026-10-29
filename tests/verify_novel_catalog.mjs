import assert from "node:assert/strict";
import fs from "node:fs";
import { runNovelReaderFixture } from "./verify_novel_reader_requests.mjs";

// Private Chromium, current reader/styles and synthetic 10,000-chapter catalogs.
const source = fs.readFileSync(new URL("../public/modules/novels/novel-page.js", import.meta.url), "utf8");
let longCatalogChecks = 0;
for (const pattern of ["long catalog bounds", "long detail catalog"]) {
  const current = await runNovelReaderFixture({ casePattern: pattern });
  assert.equal(current.checks, 2);
  longCatalogChecks += current.checks;
}
assert.equal(longCatalogChecks, 4);
const keyboard = await runNovelReaderFixture({ casePattern: "small catalog keyboard" });
assert.equal(keyboard.checks, 2);
const composition = await runNovelReaderFixture({ casePattern: "catalog composition" });
assert.equal(composition.checks, 4);

for (const control of [
  {
    name: "bounded directory DOM",
    marker: "const pageChapters = visible.slice(offset, offset + NOVEL_CATALOG_PAGE_SIZE);",
    replacement: "const pageChapters = visible;",
    failure: /a 10,000 chapter directory must mount only one bounded page/
  },
  {
    name: "current chapter location after sorting and filtering",
    marker: "state.novel.catalogPage = Math.floor(Math.max(0, position) / NOVEL_CATALOG_PAGE_SIZE);",
    replacement: "state.novel.catalogPage = 0;",
    failure: /current chapter locator must honor descending order/
  },
  {
    name: "visible keyboard controls in an empty small directory",
    marker: ".filter(control => control.getClientRects().length > 0);",
    replacement: ";",
    pattern: "small catalog keyboard",
    failure: /empty small catalog forward Tab must wrap from the last visible control/
  },
  {
    name: "deferred composing catalog search",
    marker: "if (composing || event.isComposing) return;",
    replacement: "",
    pattern: "catalog composition",
    failure: /intermediate IME text must not become a committed catalog query/
  },
  {
    name: "IME cancellation key ownership",
    marker: "if (composing || event.isComposing || event.keyCode === 229) event.stopPropagation();",
    replacement: "",
    pattern: "catalog composition",
    failure: /an IME cancellation Escape must not close the reader catalog or steal focus/
  },
  {
    name: "current catalog input ownership",
    marker: "if (!isCurrentCatalogBrowser()) return;",
    replacement: "",
    pattern: "catalog composition",
    failure: /a detached catalog input must not commit its old query into the new book/
  }
]) {
  assert.equal(source.split(control.marker).length, 2, `control must alter one production behavior: ${control.name}`);
  await assert.rejects(() => runNovelReaderFixture({
    casePattern: control.pattern || "long catalog bounds",
    sourceOverrides: { "/modules/novels/novel-page.js": source.replace(control.marker, control.replacement) }
  }), { name: "AssertionError", message: control.failure });
  console.log(`PASS negative control detects missing ${control.name}`);
}
console.log("Novel catalog fixture passed (10 browser cases and 6 behavior negative controls; synthetic metadata/composition only)");
