import assert from "node:assert/strict";
import fs from "node:fs";
import { runNovelReaderFixture } from "./verify_novel_reader_requests.mjs";

// Actual TXT picker, navigation and account publication; private synthetic
// uploads only. No user files, running service or production database.
const current = await runNovelReaderFixture({ casePattern: "novel import navigation" });
assert.equal(current.checks, 14);
const source = fs.readFileSync(new URL("../public/modules/novels/novel-page.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
for (const control of [
  { name: "import-only DOM updates", pattern: "novel import navigation preserves a reader while its selected batch continues ignore-abort",
    marker: "  function updateUploadView() {", replacement: "  function updateUploadView() {\n    renderView();",
    failure: /a background TXT import receipt must not rebuild the user's current chapter or discard its selection/ },
  { name: "batch account ownership", pattern: "novel import navigation stops old-account files and permits a new-account import ignore-abort",
    marker: "return uploadJob && account.owner === uploadJob.account.owner && account.revision === uploadJob.account.revision ? uploadJob : null;", replacement: "return uploadJob;",
    failure: /an account switch must stop unsubmitted files from the old selected batch/ },
  { name: "confirmed-import source invalidation", pattern: "novel import navigation preserves a reader while its selected batch continues ignore-abort",
    marker: "          invalidateLibraryReturnData();\n          job.confirmed += 1;", replacement: "          job.confirmed += 1;",
    failure: /confirmed background imports must invalidate the source-list cache without repainting the reader/ },
  { name: "summary publication ownership", pattern: "novel import navigation updates its overview in place and yields to management sections ignore-abort",
    marker: 'if (!isCurrentSummary()) return;', replacement: "",
    failure: /an aborted upload summary must not publish into the reopened management section/ },
  { name: "stale overview refresh on return", pattern: "novel import navigation refreshes stale numbers when returning to upload ignore-abort",
    marker: 'if (value === "upload" && currentUploadJob()?.summaryDirty)', replacement: "if (false)",
    failure: /returning to upload must freshly read statistics invalidated by its completed background batch/ },
  { name: "confirmed-file summary freshness", pattern: "novel import navigation refreshes after a newer file commits during returned statistics ignore-abort",
    marker: "if (confirmed !== job.confirmed) return refreshUploadSummary(job);", replacement: "",
    failure: /a returned overview read superseded by another confirmed file must obtain a fresh snapshot instead of leaving only a dirty flag/ }
]) {
  assert.equal(source.split(control.marker).length - 1, 1, `negative must modify one current behavior: ${control.name}`);
  await assert.rejects(() => runNovelReaderFixture({ casePattern: control.pattern,
    sourceOverrides: { "/modules/novels/novel-page.js": source.replace(control.marker, control.replacement) }
  }), { name: "AssertionError", message: control.failure });
  console.log(`PASS negative control detects missing ${control.name}`);
}
console.log("Novel import navigation passed (14 private Chromium cases and 6 behavior negative controls)");
