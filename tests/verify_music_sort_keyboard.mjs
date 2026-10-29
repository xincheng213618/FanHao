import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMusicReaderFixture } from "./verify_music_reader_requests.mjs";

// Native selects/keyboard in the actual music host with private synthetic APIs.
// Controlled Audio establishes playback intent/identity, not media decoding.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caseOption = process.argv.find(value => value.startsWith("--case="));
const negativeOnly = process.argv.includes("--negative-only");
assert(!(caseOption && negativeOnly), "--case and --negative-only cannot be combined");
if (!negativeOnly) await runMusicReaderFixture({ casePattern: caseOption?.slice(7) || "music sort keyboard " });
if (!caseOption) {
  const source = fs.readFileSync(path.join(root, "public/modules/music/music-page.js"), "utf8").replaceAll("\r\n", "\n");
  for (const negative of [
    { name: "native select ancestry", casePattern: "music sort keyboard library remains usable after a native selection", marker: "const retained = retainMusicSortControls(currentPanel, nextPanel);", replacement: "const retained = false;", failure: /a native music sort selection must retain its own connected control and keyboard focus after results arrive/ },
    { name: "native option identity", casePattern: "music sort keyboard library remains usable after a native selection", marker: "sort.value = nextSort.value;", replacement: "const replacementValue = nextSort.value; sort.replaceChildren(...nextSort.options); sort.value = replacementValue;", failure: /native sort options must keep their identity while the same selection context refreshes/ },
    { name: "owned sort failure refresh", casePattern: "music sort keyboard library can recover after a read failure", marker: "if (!state.music.playlistDialogOpen && listFailure?.message === state.music.status && refreshMusicLibraryContent()) return;", replacement: "", failure: /a current sort read failure must preserve its native control and keyboard focus/ },
    { name: "detached sort ownership", casePattern: "music sort keyboard detached controls cannot reload a new view", marker: 'if (!sort.isConnected || state.activeView !== "music" || state.music.mode !== "library") return;', replacement: "", failure: /a detached sort control must not reload the current collection or change its conditions/ },
    { name: "newer focus precedence", casePattern: "music sort keyboard refresh respects a newer external focus", marker: "    return true;\n  }\n\n  function captureMusicInputFocus() {", replacement: "    sort.focus({ preventScroll: true });\n    return true;\n  }\n\n  function captureMusicInputFocus() {", failure: /a sort response must preserve a user's newer focus outside its controls/ }
  ]) {
    assert.equal(source.split(negative.marker).length - 1, 1, `negative must modify its current owning behavior: ${negative.name}`);
    await assert.rejects(() => runMusicReaderFixture({ casePattern: negative.casePattern, sourceOverrides: { "/modules/music/music-page.js": source.replace(negative.marker, negative.replacement) } }), { name: "AssertionError", message: negative.failure });
    console.log(`PASS negative control detects missing ${negative.name}`);
  }
}
