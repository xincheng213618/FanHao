import assert from "node:assert/strict";
import fs from "node:fs";
import { runGalleryReaderFixture } from "./verify_web_gallery_requests.mjs";

// Actual image pager and native document fullscreen; all media/API responses
// are synthetic. Deferred and rejected native promises exercise ownership.
const current = await runGalleryReaderFixture({ casePattern: "pager fullscreen" });
assert.equal(current.checks, 7);
const source = fs.readFileSync(new URL("../public/modules/content-index/gallery-renderer.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
for (const negative of [
  {
    name: "native capability entry",
    marker: "fullscreen.hidden = !fullscreenSupported() || Boolean(document.fullscreenElement && !active);",
    replacement: "fullscreen.hidden = false;",
    casePattern: "pager fullscreen policy:",
    failure: /a native policy-disabled fullscreen action must be hidden instead of producing an unhandled rejection/
  },
  {
    name: "retry feedback",
    marker: 'fullscreenStatus.textContent = "全屏切换失败，请重试。";\n          fullscreenStatus.hidden = false;',
    replacement: 'fullscreenStatus.textContent = ""; fullscreenStatus.hidden = true;',
    casePattern: "pager fullscreen lifecycle: a rejected native",
    failure: /a fullscreen rejection needs visible retry feedback in the current reader/
  },
  {
    name: "single native transition",
    marker: "!fullscreenCurrent() || fullscreenOperation || !fullscreenSupported()",
    replacement: "!fullscreenCurrent() || !fullscreenSupported()",
    casePattern: "pager fullscreen lifecycle: a pending native",
    failure: /a pending fullscreen request must not start another native enter or exit/
  },
  {
    name: "late fullscreen ownership",
    marker: "if (!fullscreenCurrent() && document.fullscreenElement === overlay) await document.exitFullscreen();",
    replacement: "if (!fullscreenCurrent() && document.fullscreenElement) await document.exitFullscreen();",
    casePattern: "pager fullscreen lifecycle: late success",
    failure: /an old fullscreen completion must not exit fullscreen owned by a newer reader/
  }
]) {
  assert.equal(source.split(negative.marker).length, 2, `negative must alter only ${negative.name}`);
  await assert.rejects(() => runGalleryReaderFixture({ casePattern: negative.casePattern,
    sourceOverrides: { "/modules/content-index/gallery-renderer.js": source.replace(negative.marker, negative.replacement) }
  }), { name: "AssertionError", message: negative.failure });
  console.log(`PASS negative control detects missing ${negative.name}`);
}
console.log("Gallery fullscreen passed (7 private Chromium scenarios + 4 independent negative controls)");
