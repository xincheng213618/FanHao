import assert from "node:assert/strict";
import fs from "node:fs";
import { runWebPlayerFixture } from "./verify_web_player_lifecycle.mjs";

// Same player.html and host, both the native-UI boundary and bundled Plyr.
// Media events and list snapshots are synthetic; no real video is decoded.
for (const realPlyr of [false, true]) {
  const result = await runWebPlayerFixture({ realPlyr, casePattern: "file list " });
  assert.equal(result.checks, 3);
}
const source = fs.readFileSync(new URL("../public/js/player-page.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
for (const negative of [
  { name: "file row reuse", marker: "if (!reusable) {", replacement: "if (true) {", pattern: "file list switching", realPlyr: true,
    failure: /choosing one file must preserve all 1000 existing file rows/ },
  { name: "refreshed file descriptor", marker: "row.video = video;", replacement: "", pattern: "file list snapshot",
    failure: /a retained file button must prepare its refreshed descriptor/ },
  { name: "retired row ownership", marker: "if (renderedFilesWork !== work || currentWork !== work || button.parentElement !== els.files\n            || !(work.videos || []).includes(row.video)) return;", replacement: "", pattern: "file list snapshot",
    failure: /a retired file-list row must not prepare playback under a newer work snapshot/ }
]) {
  assert.equal(source.split(negative.marker).length - 1, 1, `negative must alter only ${negative.name}`);
  await assert.rejects(() => runWebPlayerFixture({ casePattern: negative.pattern, realPlyr: negative.realPlyr || false,
    sourceOverride: source.replace(negative.marker, negative.replacement) }), { name: "AssertionError", message: negative.failure });
  console.log(`PASS negative control detects missing ${negative.name}`);
}
console.log("Player file list passed (6 browser cases + 3 independent negative controls)");
