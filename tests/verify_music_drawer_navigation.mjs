import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMusicReaderFixture } from "./verify_music_reader_requests.mjs";

// Actual mobile drawer navigation and native keyboard, private synthetic APIs.
// Controlled Audio establishes unchanged playback intent, not media decoding.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caseOption = process.argv.find(value => value.startsWith("--case="));
const negativeOnly = process.argv.includes("--negative-only");
assert(!(caseOption && negativeOnly), "--case and --negative-only cannot be combined");
if (!negativeOnly) await runMusicReaderFixture({ casePattern: caseOption?.slice(7) || "music drawer navigation " });
if (!caseOption) {
  const source = fs.readFileSync(path.join(root, "public/modules/music/music-page.js"), "utf8").replaceAll("\r\n", "\n");
  for (const negative of [
    { name: "synchronous drawer dismissal", casePattern: "music drawer navigation artists reveals the chosen collection before its response", marker: "else closeLibraryDrawerBefore(action);", replacement: "else action();", failure: /choosing a music collection must dismiss the mobile library overlay before waiting for its response/ },
    { name: "visible launcher focus", casePattern: "music drawer navigation artists reveals the chosen collection before its response", marker: "refreshLibraryDrawer({ focus: true });\n    action();", replacement: "refreshLibraryDrawer();\n    action();", failure: /drawer navigation must return focus to its visible launcher while loading/ },
    { name: "removed drawer ownership", casePattern: "music drawer navigation ignores removed controls and yields to new focus", marker: 'if (!side.isConnected || state.activeView !== "music") return;', replacement: "", failure: /a removed drawer control must not restart or replace its selected collection read/ },
    { name: "playlist management context", casePattern: "music drawer navigation keeps playlist management separate from choosing a collection", marker: 'createPlaylistButton.addEventListener("click", () => actions.openPlaylistDialog().catch(showError));', replacement: 'createPlaylistButton.addEventListener("click", navigationAction(() => actions.openPlaylistDialog().catch(showError)));', failure: /playlist management must retain its original drawer context/ }
  ]) {
    assert.equal(source.split(negative.marker).length - 1, 1, `negative must modify its current owning behavior: ${negative.name}`);
    await assert.rejects(() => runMusicReaderFixture({ casePattern: negative.casePattern, sourceOverrides: { "/modules/music/music-page.js": source.replace(negative.marker, negative.replacement) } }), { name: "AssertionError", message: negative.failure });
    console.log(`PASS negative control detects missing ${negative.name}`);
  }
}
