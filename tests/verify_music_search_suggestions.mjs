import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMusicReaderFixture } from "./verify_music_reader_requests.mjs";

// Actual music search inputs, native keyboard and suggestions in private
// Chromium; synthetic APIs and controlled Audio, never real library/media.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caseOption = process.argv.find(value => value.startsWith("--case="));
const negativeOnly = process.argv.includes("--negative-only");
assert(!(caseOption && negativeOnly), "--case and --negative-only cannot be combined");
if (!negativeOnly) {
  for (const casePattern of caseOption ? [caseOption.slice(7)] : ["search suggestions ", "IME search ", "route cancels obsolete search and suggestion timers"]) await runMusicReaderFixture({ casePattern });
}
if (!caseOption) {
  const source = fs.readFileSync(path.join(root, "public/modules/music/music-page.js"), "utf8").replaceAll("\r\n", "\n");
  for (const negative of [
    { name: "same-query suggestion lifetime", casePattern: "search suggestions survive their own automatic list refresh ignore-abort", marker: "searchTimer = window.setTimeout(() => actions.loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError), state.music.query ?", replacement: "searchTimer = window.setTimeout(() => loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError), state.music.query ?", failure: /the current suggestion response must remain usable after its own debounced list refresh/ },
    { name: "suggestion keyboard focus restoration", casePattern: "search suggestions keep keyboard focus when an earlier response precedes the list ignore-abort", marker: "if (Number.isInteger(focus.suggestion)) {", replacement: "if (false) {", failure: /the same-query list response must preserve the user's focused suggestion/ },
    { name: "stable suggestion identity", casePattern: "search suggestions keep keyboard focus when an earlier response precedes the list ignore-abort", marker: "focus.suggestionKey ? buttons.find(item => item.dataset.musicSuggestionKey === focus.suggestionKey) : buttons[focus.suggestion]", replacement: "buttons[focus.suggestion]", failure: /suggestion focus must follow its stable item ID when the same-query order changes/ },
    { name: "detached suggestion ownership", casePattern: "search suggestions keep only the latest query and reject detached buttons ignore-abort", marker: 'if (!box.isConnected || suggestionBox !== box || state.activeView !== "music" || state.music.mode !== "library"\n            || state.music.query !== query || state.music.suggestions !== suggestions) return;', replacement: "", failure: /a detached suggestion must not play or clear the newer query/ }
  ]) {
    assert.equal(source.split(negative.marker).length - 1, 1, `negative must modify its current owning behavior: ${negative.name}`);
    await assert.rejects(() => runMusicReaderFixture({ casePattern: negative.casePattern, sourceOverrides: { "/modules/music/music-page.js": source.replace(negative.marker, negative.replacement) } }), { name: "AssertionError", message: negative.failure });
    console.log(`PASS negative control detects missing ${negative.name}`);
  }
}
