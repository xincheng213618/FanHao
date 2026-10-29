import assert from "node:assert/strict";
import fs from "node:fs";
import { runMusicReaderFixture } from "./verify_music_reader_requests.mjs";

// Actual music modal, native keyboard, real standalone history and synthetic
// APIs. Controlled Audio checks playback invariants without media decoding.
const caseOption = process.argv.find(value => value.startsWith("--case="));
const negativeOnly = process.argv.includes("--negative-only");
assert(!(caseOption && negativeOnly), "--case and --negative-only cannot be combined");
if (!negativeOnly) await runMusicReaderFixture({ casePattern: caseOption?.slice(7) || "playlist dialog " });
if (!caseOption) {
  const source = fs.readFileSync(new URL("../public/modules/music/music-page.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  for (const control of [
    { name: "modal Escape dismissal", casePattern: "playlist dialog Escape closes and returns to its opening control ignore-abort", marker: 'if (event.key === "Escape") {\n        event.preventDefault();\n        event.stopPropagation();\n        actions.closePlaylistDialog();', replacement: 'if (false) {\n        event.preventDefault();\n        event.stopPropagation();\n        actions.closePlaylistDialog();', failure: /a mounted playlist dialog must handle Escape before any focus animation frame/ },
    { name: "modal Tab containment", casePattern: "playlist dialog native Tab stays within its visible controls ignore-abort", marker: '} else if (event.key === "Tab") {', replacement: '} else if (false) {', failure: /Tab from the final dialog control must stay in the modal rather than reaching covered page controls/ },
    { name: "composition candidate ownership", casePattern: "playlist dialog composition and native form submission remain available ignore-abort", marker: 'if (composing || event.isComposing || event.keyCode === 229) { event.stopPropagation(); return; }', replacement: 'if (false) { event.stopPropagation(); return; }', failure: /candidate and modified Escape keys must retain their native behavior/ },
    { name: "programmatic focus containment", casePattern: "playlist dialog skips disabled controls and contains programmatic focus ignore-abort", marker: 'if (ownsDialog() && !dialog.contains(event.target)) focusInside();', replacement: '', failure: /a programmatic background focus must stay inside the active modal/ },
    { name: "detached dialog ownership", casePattern: "playlist dialog detached controls cannot close a newer dialog or navigation ignore-abort", marker: 'const ownsDialog = () => backdrop.isConnected && state.activeView === "music" && state.music.playlistDialogOpen\n      && state.music.playlistDialogTrackId === trackId && els.workGrid?.querySelector(".music-playlist-dialog-backdrop") === backdrop;', replacement: 'const ownsDialog = () => true;', failure: /detached dialog controls must not close or edit a newer dialog/ },
    { name: "route-owned modal release", casePattern: "playlist dialog detached controls cannot close a newer dialog or navigation ignore-abort", marker: 'state.music.libraryDrawerOpen = false;\n    state.music.playlistDialogOpen = false;\n    state.music.playlistDialogTrackId = "";\n    state.music.playlistDialogName = "";\n    state.music.trackPageOpen = Boolean(route.musicTrackId);', replacement: 'state.music.libraryDrawerOpen = false;\n    state.music.trackPageOpen = Boolean(route.musicTrackId);', failure: /explicit navigation must release the old dialog and its focus containment/ },
    { name: "synchronous mounted modal focus", casePattern: "playlist dialog Escape closes and returns to its opening control ignore-abort", marker: 'if (focus) restorePlaylistDialogFocus(next, previousFocus);', replacement: 'if (focus) window.requestAnimationFrame(() => restorePlaylistDialogFocus(next, previousFocus));', failure: /a mounted playlist dialog must handle Escape before any focus animation frame/ }
  ]) {
    assert.equal(source.split(control.marker).length - 1, 1, `negative must modify its current owning behavior: ${control.name}`);
    await assert.rejects(() => runMusicReaderFixture({ casePattern: control.casePattern, sourceOverrides: { "/modules/music/music-page.js": source.replace(control.marker, control.replacement) } }), { name: "AssertionError", message: control.failure });
    console.log(`PASS negative control detects missing ${control.name}`);
  }
}
