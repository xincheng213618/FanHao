import assert from "node:assert/strict";
import fs from "node:fs";
import { runNovelReaderFixture } from "./verify_novel_reader_requests.mjs";

const source = fs.readFileSync(new URL("../public/modules/novels/novel-page.js", import.meta.url), "utf8");
const current = await runNovelReaderFixture({ casePattern: "chapter retry" });
assert.equal(current.checks, 12);
for (const control of [
  {
    name: "failed chapter action ownership",
    marker: "if (!isCurrentChapterFailure(failure)) return;",
    replacement: "",
    pattern: "chapter retry yields to a new book",
    failure: /old retry controls cannot navigate away from a new book/
  },
  {
    name: "persistent chapter recovery action",
    marker: 'if (tone === "error" && !retryFailure) {',
    replacement: 'if (tone === "error") {',
    pattern: "chapter retry preserves",
    failure: /the retry action must not expire with the old transient error timer/
  },
  {
    name: "newer reader focus intent",
    marker: "const restoreRetryFocus = options.retryFocus && options.retryFocusRevision === readerFocusRevision;",
    replacement: "const restoreRetryFocus = options.retryFocus;",
    pattern: "chapter retry respects newer settings focus",
    failure: /a chapter retry result must not steal newer settings focus/
  }
]) {
  assert.equal(source.split(control.marker).length, 2);
  await assert.rejects(() => runNovelReaderFixture({
    casePattern: control.pattern,
    sourceOverrides: { "/modules/novels/novel-page.js": source.replace(control.marker, control.replacement) }
  }), { name: "AssertionError", message: control.failure });
  console.log(`PASS negative control detects missing ${control.name}`);
}
console.log("Novel navigation recovery passed (12 private Chromium cases and 3 behavior negative controls; synthetic API/text only)");
