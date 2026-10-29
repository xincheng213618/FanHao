import assert from "node:assert/strict";
import fs from "node:fs";
import { runMangaReaderFixture } from "./verify_manga_reader_requests.mjs";

// Actual manga reader and private Chromium. The network only serves synthetic
// API/image responses, including controlled 503s and delayed retry completion.
const source = fs.readFileSync(new URL("../public/modules/photos/manga-page.js", import.meta.url), "utf8");
const current = await runMangaReaderFixture({ casePattern: "image retry" });
assert.equal(current.checks, 9);
const marker = 'const current = () => figure.isConnected && state.activeView === "manga" && state.manga.chapter === chapter;';
assert.equal(source.split(marker).length, 2, "negative must remove only the image's page owner check");
await assert.rejects(() => runMangaReaderFixture({
  casePattern: "image retry ignores old controls and response after next chapter",
  sourceOverrides: { "/modules/photos/manga-page.js": source.replace(marker, "const current = () => true;") }
}), { name: "AssertionError", message: /detached retry controls must not replace an old image source/ });
console.log("PASS negative control detects detached image retry ownership");
const styles = fs.readFileSync(new URL("../public/modules/photos/manga.css", import.meta.url), "utf8");
const sizeMarker = ".manga-reader-image.load-failed:has(img:not([width]))";
assert.equal(styles.split(sizeMarker).length, 2, "negative must restore only the failed image's unconditional minimum height");
await assert.rejects(() => runMangaReaderFixture({
  casePattern: "image retry short banner success",
  sourceOverrides: { "/modules/photos/manga.css": styles.replace(sizeMarker, ".manga-reader-image.load-failed") }
}), { name: "AssertionError", message: /known short images must retain declared ratio/ });
console.log("PASS negative control detects short image failure geometry inflation");
const recoveryMarker = "compactFailure = height < 60 || height / width < .25;";
assert.equal(source.split(recoveryMarker).length, 2, "negative must disable only compact recovery placement");
await assert.rejects(() => runMangaReaderFixture({
  casePattern: "image retry consecutive short failures",
  sourceOverrides: { "/modules/photos/manga-page.js": source.replace(recoveryMarker, "compactFailure = false;") }
}), { name: "AssertionError", message: /each consecutive short failure must have a separate pointer-reachable retry target/ });
console.log("PASS negative control detects overlapping consecutive short-image retries");
const focusMarker = "if (document.activeElement === retry) (compactFailure ? failure : figure).focus({ preventScroll: true });";
assert.equal(source.split(focusMarker).length, 2, "negative must restore only the old compact retry focus target");
await assert.rejects(() => runMangaReaderFixture({
  casePattern: "image retry keyboard",
  sourceOverrides: { "/modules/photos/manga-page.js": source.replace(focusMarker, "if (document.activeElement === retry) figure.focus({ preventScroll: true });") }
}), { name: "AssertionError", message: /pending compact retry must retain focus inside its recovery row/ });
console.log("PASS negative control detects keyboard focus escaping compact recovery");
console.log("Manga image retry passed (9 browser cases and 4 behavior negative controls)");
