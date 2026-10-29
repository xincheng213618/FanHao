import assert from "node:assert/strict";
import fs from "node:fs";
import { runNovelReaderFixture } from "./verify_novel_reader_requests.mjs";

const source = fs.readFileSync(new URL("../public/modules/novels/novel-page.js", import.meta.url), "utf8");
const current = await runNovelReaderFixture({ casePattern: "reader modified arrows " });
assert.equal(current.checks, 4);
const marker = "if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;";
assert.equal(source.split(marker).length, 2);
for (const control of [
  {
    name: "browser history accelerator ownership",
    replacement: "if (event.ctrlKey || event.metaKey || event.shiftKey) return;",
    pattern: "reader modified arrows preserve native browser history",
    failure: /Alt\+Left must leave native browser history unclaimed by the chapter shortcut/
  },
  {
    name: "native text selection ownership",
    replacement: "if (event.altKey || event.ctrlKey || event.metaKey) return;",
    pattern: "reader modified arrows preserve native text selection",
    failure: /modified arrows must keep their native selection behavior/
  }
]) {
  await assert.rejects(() => runNovelReaderFixture({
    casePattern: control.pattern,
    sourceOverrides: { "/modules/novels/novel-page.js": source.replace(marker, control.replacement) }
  }), { name: "AssertionError", message: control.failure });
  console.log(`PASS negative control detects missing ${control.name}`);
}
console.log("Novel reader keyboard passed (4 private Chromium cases and 2 behavior negative controls; native key delivery and selection, browser history fallback where headless omits chrome accelerators)");
