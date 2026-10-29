import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMusicReaderFixture } from "./verify_music_reader_requests.mjs";

// Actual song-page controls, collection requests and browser Back in private
// Chromium. APIs/media are synthetic; controlled Audio does not prove decoding.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caseOption = process.argv.find(value => value.startsWith("--case="));
const negativeOnly = process.argv.includes("--negative-only");
assert(!(caseOption && negativeOnly), "--case and --negative-only cannot be combined");
if (!negativeOnly) await runMusicReaderFixture({ casePattern: caseOption?.slice(7) || "playback context " });
if (!caseOption) {
  const source = fs.readFileSync(path.join(root, "public/modules/music/music-page.js"), "utf8").replaceAll("\r\n", "\n");
  for (const negative of [
    { name: "current collection navigation", casePattern: "playback context opens the current album and returns through history ignore-abort", marker: "if (!id) return document.createTextNode(label);", replacement: "return document.createTextNode(label);", failure: /a currently playing album outside the sidebar must be directly browsable from its song page/ },
    { name: "pending song ownership", casePattern: "playback context old controls yield to a pending and then current song ignore-abort", marker: 'if (!button.isConnected || state.activeView !== "music" || !state.music.trackPageOpen || state.music.openingTrackId', replacement: 'if (!button.isConnected || state.activeView !== "music" || !state.music.trackPageOpen', failure: /a pending new song must keep ownership when an old context control is activated/ },
    { name: "account ownership", casePattern: "playback context old or invalid account controls cannot browse", marker: "if (current.owner !== account.owner || current.revision !== account.revision) return;", replacement: "", failure: /an old account's context control must not browse using a new account/ },
    { name: "source conditions restored from the history entry", casePattern: "playback context opens the current album and returns through history ignore-abort", marker: "if (trackReturnContext?.route) route = { ...route, ...trackReturnContext.route, musicTrackId: route.musicTrackId };", replacement: "", failure: /history must restore the stage entry's original genre rather than the browsed collection/ },
    { name: "fresh collection ownership after Back", casePattern: "playback context opens the current album and returns through history ignore-abort", marker: "if (returnContext?.fresh) state.music.data = null;", replacement: "", failure: /a history-restored stage must read its own collection before rendering a cached context/ },
    { name: "page session history ownership", casePattern: "playback context foreign history cannot invent a collection origin", marker: "if (!saved?.owner || saved.owner !== currentTrackReturnHistoryOwner() || !saved.route) return null;", replacement: "if (!saved?.owner || !saved.route) return null;", failure: /a source snapshot from another page session must not invent a collection origin/ }
  ]) {
    assert.equal(source.split(negative.marker).length - 1, 1, `negative must modify its current owning behavior: ${negative.name}`);
    await assert.rejects(() => runMusicReaderFixture({ casePattern: negative.casePattern, sourceOverrides: { "/modules/music/music-page.js": source.replace(negative.marker, negative.replacement) } }), { name: "AssertionError", message: negative.failure });
    console.log(`PASS negative control detects missing ${negative.name}`);
  }
}
