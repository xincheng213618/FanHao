import assert from "node:assert/strict";
import fs from "node:fs";
import { runGalleryReaderFixture } from "./verify_web_gallery_requests.mjs";

// Actual standalone gallery, renderer and CSS; synthetic albums/images only.
const source = fs.readFileSync(new URL("../public/modules/content-index/gallery-renderer.js", import.meta.url), "utf8");
assert.equal((await runGalleryReaderFixture({ casePattern: "pager jump" })).checks, 6);
for (const control of [
  { name: "jump validation", marker: "if (target == null) {", replacement: "if (false) {", pattern: "pager jump invalid values", failure: /invalid jump input must remain open/ },
  { name: "native input keys", marker: "} else if (jumpPanel.contains(event.target)) {", replacement: "} else if (false) {", pattern: "pager jump native editing", failure: /native jump input editing must not activate/ },
  { name: "late metadata draft ownership", marker: "jumpHint.textContent = `请输入 1 至 ${formatNumber(list.length)} 的整数`;", replacement: "jumpInput.value = String(currentIndex + 1);\n    jumpHint.textContent = `请输入 1 至 ${formatNumber(list.length)} 的整数`;", pattern: "pager jump late full metadata", failure: /late full metadata must preserve the jump draft/ }
]) {
  assert.equal(source.split(control.marker).length, 2, `${control.name} must target one implementation`);
  await assert.rejects(() => runGalleryReaderFixture({ casePattern: control.pattern, sourceOverrides: { "/modules/content-index/gallery-renderer.js": source.replace(control.marker, control.replacement) } }), { name: "AssertionError", message: control.failure });
  console.log(`PASS negative control detects missing ${control.name}`);
}
console.log("Gallery page jump passed (6 browser cases and 3 behavior negative controls)");
