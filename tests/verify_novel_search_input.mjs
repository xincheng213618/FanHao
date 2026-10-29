import assert from "node:assert/strict";
import fs from "node:fs";
import { runNovelReaderFixture } from "./verify_novel_reader_requests.mjs";

const source = fs.readFileSync(new URL("../public/modules/novels/novel-page.js", import.meta.url), "utf8");
const current = await runNovelReaderFixture({ casePattern: "novel search input" });
assert.equal(current.checks, 14);
const sorting = await runNovelReaderFixture({ casePattern: "novel sort input" });
assert.equal(sorting.checks, 6);
for (const control of [
  { name: "live composing input retention", marker: "  function reuseNovelLibraryMenu(previous) {", replacement: "  function reuseNovelLibraryMenu(previous) {\n    return false;", pattern: "novel search input retains", failure: /a current search response must retain the composing input node/ },
  { name: "detached search ownership", marker: "if (!isCurrentNovelSearch(search, menuContext)) return;", replacement: "", pattern: "novel search input retires detached", failure: /a detached search form must not leave the new book/ },
  { name: "native sort ancestry retention", marker: "  function retainNovelLibrarySort(home, replacement, previous) {", replacement: "  function retainNovelLibrarySort(home, replacement, previous) {\n    return null;", pattern: "novel sort input preserves native keyboard selection in books ignore-abort", failure: /same-query sort results must preserve native select\/options and its complete ancestor chain/ },
  { name: "retired sort ownership", marker: 'if (!sort.isConnected || state.activeView !== "novels" || state.novel.book || state.novel.chapter || sortContext !== novelSearchContext()) return;', replacement: "", pattern: "novel sort input respects newer composition navigation and retired controls ignore-abort", failure: /a retired novel sort must not request into a newer query/ }
]) {
  assert.equal(source.split(control.marker).length, 2);
  await assert.rejects(() => runNovelReaderFixture({
    casePattern: control.pattern,
    sourceOverrides: { "/modules/novels/novel-page.js": source.replace(control.marker, control.replacement) }
  }), { name: "AssertionError", message: control.failure });
  console.log(`PASS negative control detects missing ${control.name}`);
}
console.log("Novel search input passed (14 search + 6 native sort private Chromium cases and 4 behavior negative controls; synthetic composition/API only)");
