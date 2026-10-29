import assert from "node:assert/strict";
import fs from "node:fs";
import { runWebPlayerFixture } from "./verify_web_player_lifecycle.mjs";

// Keep the bundled Plyr implementation, actual player.html and host module.
// Only media and local APIs are controlled: this is not a decoder benchmark.
const caseOption = process.argv.find(value => value.startsWith("--case="));
await runWebPlayerFixture({ realPlyr: true, casePattern: caseOption?.slice(7) || "real Plyr" });

if (!caseOption) {
  await runWebPlayerFixture({ realPlyr: true, casePattern: "shortcut help" });
  await runWebPlayerFixture({ realPlyr: true, casePattern: "time jump" });
  await runWebPlayerFixture({ realPlyr: true, casePattern: "time link copying preserves" });
  const source = fs.readFileSync(new URL("../public/js/player-page.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const mediaAdoption = /    const restoredVideo = els\.stage\?\.querySelector\("#playerVideo"\);\n    if \(restoredVideo && restoredVideo !== els\.video\) \{\n      els\.video = restoredVideo;\n      installPlayerVideoEvents\(\);\n    \}/;
  const playbackBridge = /  const currentPlayer = player;\n  player\.togglePlay = \(playing\) => \{[\s\S]*?\n  \};/;
  for (const negative of [
    {
      name: "real Plyr mode changes preserve the visible owned video",
      marker: mediaAdoption, failure: /Plyr mode changes must keep the host's owned video connected and visible/
    },
    {
      name: "real Plyr direct button click pause before metadata remains paused",
      marker: playbackBridge, failure: /real Plyr pause intent must survive delayed metadata/
    },
    {
      name: "real Plyr direct button click pause before metadata remains paused",
      marker: /  els\.video\.autoplay = false;/, failure: /real Plyr pause intent must survive delayed metadata/
    }
  ]) {
    assert.equal([...source.matchAll(new RegExp(negative.marker.source, "g"))].length, 1, `negative must change exactly one owning boundary: ${negative.marker}`);
    await assert.rejects(() => runWebPlayerFixture({ realPlyr: true, casePattern: negative.name, sourceOverride: source.replace(negative.marker, "") }), { name: "AssertionError", message: negative.failure });
    console.log(`PASS real Plyr negative detects missing ${negative.marker === mediaAdoption ? "media adoption" : negative.marker === playbackBridge ? "playback intent bridge" : "host autoplay ownership"}`);
  }
}
