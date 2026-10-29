import assert from "node:assert/strict";
import fs from "node:fs";
import { runNovelReaderFixture } from "./verify_novel_reader_requests.mjs";

// Actual reader, styles and browser selection. Private synthetic text/API only.
let checks = 0;
for (const pattern of ["reader panels", "reader catalog loading renders", "reader catalog loading failure"]) {
  const result = await runNovelReaderFixture({ casePattern: pattern });
  assert.equal(result.checks, 2); checks += result.checks;
}
const source = fs.readFileSync(new URL("../public/modules/novels/novel-page.js", import.meta.url), "utf8");
const marker = "  function updateReaderPanels() {";
assert.equal(source.split(marker).length, 2);
await assert.rejects(() => runNovelReaderFixture({
  casePattern: "reader panels",
  sourceOverrides: { "/modules/novels/novel-page.js": source.replace(marker, `${marker}\n    return false;`) }
}), { name: "AssertionError", message: /must preserve mounted current text/ });
console.log("PASS negative control detects full-reader rebuild on panel changes");
console.log(`Novel reader panels passed (${checks} private Chromium cases and 1 behavior negative control; synthetic text only)`);
