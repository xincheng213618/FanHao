import assert from "node:assert/strict";
import fs from "node:fs";
import { runGalleryReaderFixture } from "./verify_web_gallery_requests.mjs";

// Actual gallery host and native Chromium controls; all summary, item, and
// reader responses are controlled synthetic reads. No scan or write endpoint.
const pattern = process.argv.find(value => value.startsWith("--case="))?.slice(7) || "";
const negativeOnly = process.argv.includes("--negative-only");
assert(!(negativeOnly && pattern), "--case and --negative-only cannot be combined");
if (!negativeOnly) {
  const result = await runGalleryReaderFixture({ casePattern: pattern || "summary recovery:" });
  if (!pattern) assert.equal(result.checks, 6, "the default summary recovery gate must execute all six behavior families");
}
if (!pattern) {
  const rendererPath = "/modules/content-index/gallery-renderer.js", pagePath = "/modules/content-index/gallery-page.js";
  const read = file => fs.readFileSync(new URL(`../public${file}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const renderer = read(rendererPath), page = read(pagePath);
  for (const negative of [
    {
      name: "cold overview failure recovery", path: rendererPath, source: renderer,
      marker: "const failure = page.getSummaryReadFailure?.();", replacement: "const failure = null;",
      casePattern: "summary recovery: a cold failure exposes",
      failure: /a cold gallery summary failure must expose a read-only retry/
    },
    {
      name: "live native retry surface", path: rendererPath, source: renderer,
      marker: "if (!options.readerActive && refreshGallerySummaryContent(options)) return true;", replacement: "// Negative: replace the overview shell on each receipt.",
      casePattern: "summary recovery: native repeated retry",
      failure: /busy summary retry must retain native focus|a repeated summary failure must keep the native retry/
    },
    {
      name: "newer input intent priority", path: rendererPath, source: renderer,
      marker: 'if (!hadFocus || newerIntent || !result?.isCurrent() || !shell?.isConnected || state.activeView !== "gallery"',
      replacement: 'if (!hadFocus || !result?.isCurrent() || !shell?.isConnected || state.activeView !== "gallery"',
      casePattern: "summary recovery: a new draft and IME",
      failure: /summary retry completion must preserve newer raw composition, selection, focus, and every live input ancestor/
    },
    {
      name: "inactive view publication owner", path: pagePath, source: page,
      marker: 'function refreshGalleryAfterLibraryChange(options = {}) {\n    if (state.activeView !== "gallery") return;',
      replacement: "function refreshGalleryAfterLibraryChange(options = {}) {",
      casePattern: "summary recovery: inactive view",
      failure: /inactive gallery retry completion must not paint or focus the new view/
    }
  ]) {
    assert.equal(negative.source.split(negative.marker).length, 2, `negative must change exactly one ${negative.name} marker`);
    await assert.rejects(() => runGalleryReaderFixture({ casePattern: negative.casePattern,
      sourceOverrides: { [negative.path]: negative.source.replace(negative.marker, negative.replacement) }
    }), { name: "AssertionError", message: negative.failure });
    console.log(`PASS negative control detects missing ${negative.name}`);
  }
}
console.log(`Gallery summary recovery passed (${pattern ? "selected behavior" : negativeOnly ? "4 independent behavior negative controls" : "6 private Chromium behavior families + 4 independent negative controls"})`);
