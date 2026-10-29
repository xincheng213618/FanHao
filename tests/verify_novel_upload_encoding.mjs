import assert from "node:assert/strict";
import fs from "node:fs";
import { runNovelReaderFixture } from "./verify_novel_reader_requests.mjs";

// Real upload/reimport controls and POST bodies, plus the actual chapter parser
// in a newly allocated temporary SQLite database. No user files or live service.
const caseOption = process.argv.find(value => value.startsWith("--case="));
const negativeOnly = process.argv.includes("--negative-only");
assert(!(caseOption && negativeOnly), "--case and --negative-only cannot be combined");
if (!negativeOnly) {
  const result = await runNovelReaderFixture({ casePattern: caseOption?.slice(7) || "novel upload " });
  assert(result.checks > 0, "the selected upload encoding cases must exist");
}
if (!caseOption) {
  const source = fs.readFileSync(new URL("../public/modules/novels/novel-page.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  for (const control of [
    { name: "BOM-selected Unicode decoding", pattern: "novel upload preserves BOM-selected Chinese text and legacy encodings ignore-abort",
      marker: "if (unicodeEncoding) {", replacement: "if (false) {",
      failure: /TXT import must honor a UTF-16 BOM instead of submitting Chinese mojibake/ },
    { name: "malformed Unicode rejection", pattern: "novel upload rejects damaged BOM text before posting and remains retryable ignore-abort",
      marker: "new TextDecoder(unicodeEncoding, { fatal: true })", replacement: "new TextDecoder(unicodeEncoding, { fatal: false })",
      failure: /damaged UTF-16 must fail locally instead of posting replacement text/ },
    { name: "visible final decoding failure", pattern: "novel upload rejects damaged BOM text before posting and remains retryable ignore-abort",
      marker: 'failures.join("；")', replacement: '""',
      failure: /the final upload receipt must retain the failed file name and decoding error/ }
  ]) {
    assert.equal(source.split(control.marker).length - 1, 1, `negative must modify one current behavior: ${control.name}`);
    await assert.rejects(() => runNovelReaderFixture({ casePattern: control.pattern,
      sourceOverrides: { "/modules/novels/novel-page.js": source.replace(control.marker, control.replacement) }
    }), { name: "AssertionError", message: control.failure });
    console.log(`PASS negative control detects missing ${control.name}`);
  }
}
