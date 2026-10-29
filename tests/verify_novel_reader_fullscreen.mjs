import assert from "node:assert/strict";
import fs from "node:fs";
import { runNovelReaderFixture } from "./verify_novel_reader_requests.mjs";

// Native document fullscreen in the actual novel host; synthetic books/text only.
const caseOption = process.argv.find(value => value.startsWith("--case="));
const negativeOnly = process.argv.includes("--negative-only");
assert(!(caseOption && negativeOnly), "--case and --negative-only cannot be combined");
if (!negativeOnly) {
  const result = await runNovelReaderFixture({ casePattern: caseOption?.slice(7) || "reader fullscreen " });
  assert(result.checks > 0, "the selected native fullscreen scenarios must exist");
}
if (!caseOption) {
  const read = file => fs.readFileSync(new URL(`../public/modules/novels/${file}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const page = read("novel-page.js"), fullscreen = read("reader-fullscreen.js");
  for (const control of [
    { name: "supported reader entry", source: page, path: "novel-page.js", pattern: "reader fullscreen preserves native long chapter reading ignore-abort",
      marker: "if (readerFullscreen.state().supported) panel.append(readerFullscreenControl());", replacement: "",
      failure: /a supported reader must offer native fullscreen reading without a browser menu/ },
    { name: "native viewport anchor", source: fullscreen, path: "reader-fullscreen.js", pattern: "reader fullscreen preserves the settling viewport anchor ignore-abort",
      marker: "window.scrollBy({ top: paragraph.getBoundingClientRect().top - top, left: 0, behavior: \"auto\" });", replacement: "window.scrollBy({ top: 0, left: 0, behavior: \"auto\" });",
      failure: /fullscreen viewport settling must restore the original paragraph anchor after actual reflow/ },
    { name: "external fullscreen ownership", source: fullscreen, path: "reader-fullscreen.js", pattern: "reader fullscreen leaves external ownership untouched ignore-abort",
      marker: "if (!owned || document.fullscreenElement !== root) return;", replacement: "if (document.fullscreenElement !== root) return;",
      failure: /leaving the reader must not exit fullscreen acquired by a different owner/ },
    { name: "newer scrolling intent", source: fullscreen, path: "reader-fullscreen.js", pattern: "reader fullscreen respects newer navigation and scroll intent ignore-abort",
      marker: "document.addEventListener(type, intent, { capture: true, passive: true, signal: controller.signal });", replacement: "",
      failure: /a late fullscreen completion must yield to newer scrolling/ }
  ]) {
    assert.equal(control.source.split(control.marker).length - 1, 1, `negative must modify one current behavior: ${control.name}`);
    await assert.rejects(() => runNovelReaderFixture({ casePattern: control.pattern,
      sourceOverrides: { [`/modules/novels/${control.path}`]: control.source.replace(control.marker, control.replacement) }
    }), { name: "AssertionError", message: control.failure });
    console.log(`PASS negative control detects missing ${control.name}`);
  }
}
