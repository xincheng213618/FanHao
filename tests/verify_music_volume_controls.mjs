import assert from "node:assert/strict";
import fs from "node:fs";
import { runMusicReaderFixture } from "./verify_music_reader_requests.mjs";
import { runMusicPlaybackRecoveryFixture } from "./verify_music_playback_recovery.mjs";

// Current music volume UI, private Chromium, native keyboard and synthetic WAV.
// No actual music files, running service or user preferences are accessed.
const caseOption = process.argv.find(value => value.startsWith("--case="));
const negativeOnly = process.argv.includes("--negative-only");
assert(!(caseOption && negativeOnly), "--case and --negative-only cannot be combined");
if (!negativeOnly) {
  if (!caseOption || !caseOption.slice(7).startsWith("native ")) await runMusicReaderFixture({ casePattern: caseOption?.slice(7) || "playback volume " });
  if (!caseOption || caseOption.slice(7).startsWith("native ")) await runMusicPlaybackRecoveryFixture({ casePattern: caseOption?.slice(7) || "native playback volume " });
}
if (!caseOption) {
  const source = fs.readFileSync(new URL("../public/modules/music/music-page.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  for (const control of [
    { name: "single-track volume access", casePattern: "playback volume stays available across views at 1440px ignore-abort", marker: "options.append(renderPlaybackSpeedControl(track));\n    options.append(renderVolumeControl());\n    footer.append", replacement: "options.append(renderPlaybackSpeedControl(track));\n    footer.append", failure: /the current-song page must expose volume without making the listener leave the playback view/ },
    { name: "native volume application", casePattern: "playback volume stays available across views at 1440px ignore-abort", marker: "player.setVolume(value);", replacement: "", failure: /the single-track volume must retain the quiet volume selected in the music library/ },
    { name: "detached volume control ownership", casePattern: "playback volume stays available across views at 1440px ignore-abort", marker: 'if (!volume.isConnected || state.activeView !== "music") return;', replacement: "", failure: /an old library volume control must not overwrite the current playback view/ },
    { name: "live volume display with blocked storage", casePattern: "playback volume survives unavailable preference storage during view changes", marker: "state.music.volume = player.getAudio().volume;", replacement: "", failure: /blocked preferences must not make the playback view show a different volume from the live audio/ }
  ]) {
    assert.equal(source.split(control.marker).length - 1, 1, `negative must modify its current owning behavior: ${control.name}`);
    await assert.rejects(() => runMusicReaderFixture({ casePattern: control.casePattern, sourceOverrides: { "/modules/music/music-page.js": source.replace(control.marker, control.replacement) } }), { name: "AssertionError", message: control.failure });
    console.log(`PASS negative control detects missing ${control.name}`);
  }
}
