import assert from "node:assert/strict";
import fs from "node:fs";
import { runNovelReaderFixture } from "./verify_novel_reader_requests.mjs";

// Real chapter controls and ArrowRight; private synthetic text/API only.
const current = await runNovelReaderFixture({ casePattern: "reader adjacent navigation" });
assert.equal(current.checks, 6);
const source = fs.readFileSync(new URL("../public/modules/novels/novel-page.js", import.meta.url), "utf8");
for (const control of [
  { name: "same-target command reuse", pattern: "reader adjacent navigation joins repeated commands for its pending chapter ignore-abort",
    marker: "if (adjacentNavigation?.owner === navigationId && adjacentNavigation.bookId === bookId && adjacentNavigation.index === target.index) return;", replacement: "",
    failure: /repeated next-chapter commands must join the pending target instead of cancelling and restarting its read/ },
  { name: "new command finalizer ownership", pattern: "reader adjacent navigation lets new directions and routes supersede it ignore-abort",
    marker: "if (adjacentNavigation === pending) adjacentNavigation = null;", replacement: "adjacentNavigation = null;",
    failure: /an obsolete adjacent finalizer must not release the newer pending destination/ },
  { name: "failed command release", pattern: "reader adjacent navigation allows an explicit retry after failure ignore-abort",
    marker: "if (adjacentNavigation === pending) adjacentNavigation = null;", replacement: "",
    failure: /a failed adjacent command must release its target for an explicit retry/ }
]) {
  assert.equal(source.split(control.marker).length - 1, 1, `negative must modify one current behavior: ${control.name}`);
  await assert.rejects(() => runNovelReaderFixture({ casePattern: control.pattern,
    sourceOverrides: { "/modules/novels/novel-page.js": source.replace(control.marker, control.replacement) }
  }), { name: "AssertionError", message: control.failure });
  console.log(`PASS negative control detects missing ${control.name}`);
}
console.log("Novel adjacent navigation passed (6 private Chromium cases and 3 behavior negative controls)");
