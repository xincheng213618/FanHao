import assert from "node:assert/strict";
import fs from "node:fs";
import { runWebPlayerFixture } from "./verify_web_player_lifecycle.mjs";

// Current standalone player, both controlled UI and actual bundled Plyr.
// Native media callbacks are controlled; this gate does not decode video.
for (const realPlyr of [false, true]) {
  const result = await runWebPlayerFixture({ realPlyr, casePattern: "adjacent files " });
  assert.equal(result.checks, 3);
}
const source = fs.readFileSync(new URL("../public/js/player-page.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
for (const negative of [
  { name: "next-file direction", marker: 'els.fileNext?.addEventListener("click", () => playAdjacentFile(1));', replacement: 'els.fileNext?.addEventListener("click", () => playAdjacentFile(-1));', pattern: "adjacent files navigate",
    failure: /next-file action must select the following file synchronously/ },
  { name: "final-file boundary", marker: "  const target = index >= 0 ? videos[index + offset] : null;\n  if (!target || !els.fileNavigation", replacement: "  const target = index >= 0 ? (videos[index + offset] || videos[0]) : null;\n  if (!target || !els.fileNavigation", pattern: "adjacent files navigate",
    failure: /the last file must not wrap to the first file/ },
  { name: "current saved position", marker: "void playVideo(target);", replacement: "void playVideo({ ...target, progress: null });", pattern: "adjacent files use refreshed",
    failure: /adjacent navigation must use the latest descriptor and saved position/ },
  { name: "unavailable action audio intent", marker: ", #playerFileNavigation [aria-disabled='true']", replacement: "", pattern: "adjacent files navigate",
    failure: /an unavailable adjacent-file action must not restore autoplay audio/ }
]) {
  assert.equal(source.split(negative.marker).length - 1, 1, `negative must modify only ${negative.name}`);
  await assert.rejects(() => runWebPlayerFixture({ casePattern: negative.pattern, sourceOverride: source.replace(negative.marker, negative.replacement) }), { name: "AssertionError", message: negative.failure });
  console.log(`PASS negative control detects missing ${negative.name}`);
}
console.log("Player adjacent files passed (6 browser cases + 4 independent negative controls)");
