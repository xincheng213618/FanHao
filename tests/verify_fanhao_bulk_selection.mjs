import assert from "node:assert/strict";
import fs from "node:fs";
import { runFanhaoFavoriteUpdates } from "./verify_fanhao_favorite_updates.mjs";

// Reuse the real FanHao shell/person/paging fixture. These cases browse only;
// every API mutation is rejected and no destructive action is activated.
const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const negativeOnly = process.argv.includes("--negative-only");
if (!negativeOnly) {
  const result = await runFanhaoFavoriteUpdates({ casePattern: "person bulk selection" });
  assert.equal(result.checks, 3, "the focused bulk-selection entry must run all three native profiles");
}
for (const negative of [
  {
    name: "selection DOM retention",
    casePattern: "1000-card person bulk selection",
    marker: "function syncPersonBulkDeleteSelectionUi() {\n  if (!isPersonBulkDeleteActive()) return;",
    replacement: "function syncPersonBulkDeleteSelectionUi() {\n  if (!isPersonBulkDeleteActive()) return;\n  renderPersonWorkStats();\n  renderWorks();\n  return;",
    failure: /bulk selection must retain every original loaded work card/
  },
  {
    name: "retired select-all ownership",
    casePattern: "person bulk selection retired controls",
    marker: "    if (!isCurrentPersonBulkDeleteControl(selectAll, owner)) return;",
    replacement: "",
    failure: /retired select-all must not change the current person selection/
  }
]) {
  assert.equal(source.split(negative.marker).length - 1, 1, `negative needs one current owning branch: ${negative.name}`);
  await assert.rejects(() => runFanhaoFavoriteUpdates({ casePattern: negative.casePattern,
    sourceOverrides: { "/app.js": source.replace(negative.marker, negative.replacement) } }),
  error => error instanceof assert.AssertionError && negative.failure.test(error.message),
  `negative must reach its business assertion: ${negative.name}`);
  console.log(`PASS negative control detects missing ${negative.name}`);
}
console.log(negativeOnly
  ? "FanHao bulk selection negatives passed (2 independent business assertions; read-only synthetic APIs)."
  : "FanHao bulk selection passed (3 native profiles + 2 independent business negatives; read-only synthetic APIs).");
