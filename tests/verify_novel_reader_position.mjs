import assert from "node:assert/strict";
import fs from "node:fs";
import { runNovelReaderFixture } from "./verify_novel_reader_requests.mjs";

const source = fs.readFileSync(new URL("../public/modules/novels/novel-page.js", import.meta.url), "utf8");
const current = await runNovelReaderFixture({ casePattern: "reader position" });
assert.equal(current.checks, 8);
for (const control of [
  { name: "precise near-zero chapter position", marker: "if (ratio === 0) {", replacement: "if (ratio <= 0.001) {", pattern: "reader position preserves long", failure: /must locate the requested chapter percentage 0.1/ },
  { name: "current settings action ownership", marker: 'if (!form.isConnected || els.workGrid.querySelector(".novel-reader-position") !== form', replacement: "if (false", pattern: "reader position retires detached", failure: /an old percentage form must not move the reader after settings are replaced/ }
]) {
  assert.equal(source.split(control.marker).length, 2);
  await assert.rejects(() => runNovelReaderFixture({ casePattern: control.pattern,
    sourceOverrides: { "/modules/novels/novel-page.js": source.replace(control.marker, control.replacement) }
  }), { name: "AssertionError", message: control.failure });
  console.log(`PASS negative control detects missing ${control.name}`);
}
console.log("Novel position passed (8 private Chromium cases and 2 behavior negative controls; actual reader and synthetic text/progress only)");
