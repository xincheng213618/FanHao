import assert from "node:assert/strict";
import fs from "node:fs";
import { runNovelReaderFixture } from "./verify_novel_reader_requests.mjs";

const source = fs.readFileSync(new URL("../public/modules/novels/novel-page.js", import.meta.url), "utf8");
const current = await runNovelReaderFixture({ casePattern: "ranking recovery" });
assert.equal(current.checks, 4);
for (const control of [
  { name: "visible ranking recovery", marker: "if (state.novel.loading || state.novel.libraryError) {", replacement: "if (false) {", pattern: "ranking recovery retries initial", failure: /an initial ranking failure needs an in-context retry action/ },
  { name: "current ranking retry ownership", marker: "if (!isCurrentRankingRetry(panel, retryContext)) return;", replacement: "", pattern: "ranking recovery retains old", failure: /a detached ranking retry cannot restart an old page after a new sort/ },
  { name: "retained first-page rank positions", marker: "Number(data.offset ?? state.novel.page * limit)", replacement: "Number(data.offset || state.novel.page * limit)", pattern: "ranking recovery retains old", failure: /a pending page cannot relabel retained rows as the new page/ }
]) {
  assert.equal(source.split(control.marker).length, 2);
  await assert.rejects(() => runNovelReaderFixture({ casePattern: control.pattern,
    sourceOverrides: { "/modules/novels/novel-page.js": source.replace(control.marker, control.replacement) }
  }), { name: "AssertionError", message: control.failure });
  console.log(`PASS negative control detects missing ${control.name}`);
}
console.log("Novel ranking recovery passed (4 actual-host Chromium cases and 3 behavior negative controls; synthetic books/API only)");
