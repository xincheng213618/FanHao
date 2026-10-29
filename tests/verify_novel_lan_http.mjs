import assert from "node:assert/strict";
import fs from "node:fs";
import { runNovelReaderFixture } from "./verify_novel_reader_requests.mjs";
import { runNovelProgressFixture } from "./verify_novel_progress_requests.mjs";

// A private host-resolver mapping reaches only 127.0.0.1, while Chromium uses
// genuine non-secure HTTP capabilities; no crypto polyfill or LAN server.
const reader = await runNovelReaderFixture({ casePattern: "reader LAN HTTP" });
assert.equal(reader.checks, 4);
const progress = await runNovelProgressFixture({ plainHttp: true });
assert.equal(progress.checks, 11); // Includes ordinary save failures and manual retries on genuine HTTP.
const source = fs.readFileSync(new URL("../public/modules/novels/novel-page.js", import.meta.url), "utf8");
for (const control of [
  { name: "LAN cryptographic UUID fallback", marker: "id: newProgressSessionId()", replacement: "id: window.crypto.randomUUID()",
    failure: /LAN HTTP must open book details when native randomUUID is unavailable/ },
  { name: "UUID version contract", marker: "bytes[6] = (bytes[6] & 0x0f) | 0x40;", replacement: "bytes[6] = bytes[6] & 0x0f;",
    failure: /LAN progress fallback must produce a valid version-4 UUID with the RFC variant/ }
]) {
  assert.equal(source.split(control.marker).length - 1, 1, `negative control must modify one current behavior: ${control.name}`);
  await assert.rejects(() => runNovelReaderFixture({ casePattern: "reader LAN HTTP opens books and preserves progress sessions ignore-abort",
    sourceOverrides: { "/modules/novels/novel-page.js": source.replace(control.marker, control.replacement) }
  }), { name: "AssertionError", message: control.failure });
  console.log(`PASS negative control detects missing ${control.name}`);
}
console.log("Novel LAN HTTP passed (4 actual host + 11 private SQLite progress cases; 2 behavior negative controls)");
