import assert from "node:assert/strict";
import fs from "node:fs";
import { runNovelReaderFixture } from "./verify_novel_reader_requests.mjs";

// Real novel host, dialogs and navigation; PATCH/DELETE are private synthetic
// receipts only. No production library, file or database is read or mutated.
const source = fs.readFileSync(new URL("../public/modules/novels/novel-page.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const result = await runNovelReaderFixture({ casePattern: "book correction " });
assert.equal(result.checks, 20);
for (const control of [
  {
    name: "save response ownership",
    marker: "if (!isCurrentCorrection()) return;\n        state.novel.book =",
    replacement: "state.novel.book =",
    pattern: "book correction PATCH success yields to another reader",
    failure: /PATCH late success must not rebuild another book's current reader/
  },
  {
    name: "delete response ownership",
    marker: 'await api(`/api/novels/${encodeURIComponent(book.id)}`, { method: "DELETE" });\n        invalidateLibraryReturnData();\n        if (!isCurrentCorrection()) return;',
    replacement: 'await api(`/api/novels/${encodeURIComponent(book.id)}`, { method: "DELETE" });\n        invalidateLibraryReturnData();',
    pattern: "book correction DELETE success yields to another reader",
    failure: /DELETE late success must not rebuild another book's current reader/
  },
  {
    name: "dialog instance ownership",
    marker: 'const isCurrentCorrection = () => dialog.isConnected && dialog.open && state.activeView === "novels"',
    replacement: 'const isCurrentCorrection = () => state.activeView === "novels"',
    pattern: "book correction PATCH closed instance yields to replacement dialog",
    failure: /closed correction instances must not repaint the current book beneath a new dialog/
  },
  {
    name: "post-delete library refresh ownership",
    marker: 'if (refreshed === false || reloadOwner !== navigationId || state.activeView !== "novels") return;',
    replacement: "",
    pattern: "book correction DELETE refresh yields to another reader",
    failure: /a completed deletion's late library refresh must not rebuild another book's current reader/
  },
  {
    name: "pending save and delete interlock",
    marker: 'save.disabled = true;\n      deleteButton.disabled = true;\n      save.textContent = "正在保存";',
    replacement: 'save.disabled = true;\n      save.textContent = "正在保存";',
    pattern: "book correction PATCH current failure retry",
    failure: /saving and deleting the same book must be mutually exclusive while pending/
  },
  {
    name: "newer correction draft preservation",
    marker: "const hasNewDraft = composingFields.size > 0 || Object.keys(submitted).some(key => currentDraft[key] !== submitted[key]);",
    replacement: "const hasNewDraft = false;",
    pattern: "book correction PATCH receipt preserves newer dialog drafts ignore-abort",
    failure: /a saved receipt must not discard newer correction edits/
  }
]) {
  assert.equal(source.split(control.marker).length, 2, `${control.name} source marker must be unique`);
  await assert.rejects(() => runNovelReaderFixture({
    casePattern: control.pattern,
    sourceOverrides: { "/modules/novels/novel-page.js": source.replace(control.marker, control.replacement) }
  }), { name: "AssertionError", message: control.failure });
  console.log(`PASS negative control detects missing ${control.name}`);
}
console.log("Novel book mutation passed (20 private Chromium cases and 6 behavior negative controls; synthetic PATCH/DELETE receipts only)");
