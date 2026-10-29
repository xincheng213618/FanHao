import assert from "node:assert/strict";
import fs from "node:fs";
import { runMangaReaderFixture } from "./verify_manga_reader_requests.mjs";

// Real manga page and private Chromium. APIs and delayed image responses are
// synthetic; no production library, service or browser profile is accessed.
const source = fs.readFileSync(new URL("../public/modules/photos/manga-page.js", import.meta.url), "utf8");
const marker = "if (Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0) {";
assert.equal(source.split(marker).length, 2, "negative must disable only the page dimension hints");
const result = await runMangaReaderFixture({ casePattern: "image dimensions" });
assert.equal(result.checks, 3);
await assert.rejects(() => runMangaReaderFixture({
  casePattern: "image dimensions 1000",
  sourceOverrides: { "/modules/photos/manga-page.js": source.replace(marker, "if (false) {") }
}), error => {
  assert.equal(error.name, "AssertionError");
  assert.match(error.message, /must load at most 6 nearby images|must reserve their actual aspect ratio/);
  console.log(`MEASURE missing dimensions: ${error.message.split("\n")[0]}`);
  return true;
});
console.log("PASS negative control detects collapsed pages without dimension hints");
console.log("Manga image layout passed (3 browser cases and 1 behavior negative control)");
