import assert from "node:assert/strict";
import fs from "node:fs";
import { runMusicReaderFixture } from "./verify_music_reader_requests.mjs";

// Real artist/album controls, native keyboard and emulated touch in private
// Chromium; synthetic API/controlled Audio only, no production library/media.
const caseOption = process.argv.find(value => value.startsWith("--case="));
const negativeOnly = process.argv.includes("--negative-only");
assert(!(caseOption && negativeOnly), "--case and --negative-only cannot be combined");
if (!negativeOnly) await runMusicReaderFixture({ casePattern: caseOption?.slice(7) || "music alphabet browsing " });
if (!caseOption) {
  const read = name => fs.readFileSync(new URL(`../public/modules/music/${name}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const components = read("views/components.js"), page = read("music-page.js");
  for (const control of [
    { name: "explicit all-letters recovery", source: components, file: "views/components.js", casePattern: "music alphabet browsing artists clears an empty letter at 320px", marker: 'const items = ["", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""), "0-9", "待", "#"];', replacement: 'const items = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""), "0-9", "待", "#"];', failure: /an empty alphabet filter must offer an explicit all-letters action instead of requiring users to guess which letter to toggle/ },
    { name: "selected letter semantics", source: components, file: "views/components.js", casePattern: "music alphabet browsing artists clears an empty letter at 320px", marker: 'button.setAttribute("aria-pressed", String((currentLetter || "") === value));', replacement: "", failure: /the active alphabet filter must expose its selected state/ },
    { name: "alphabet keyboard focus", source: page, file: "music-page.js", casePattern: "music alphabet browsing artists clears an empty letter at 390px", marker: 'if (alphabet && input.matches(".music-alpha-index-item")) return { letter: input.dataset.musicLetter || "", mode: alphabet.dataset.musicAlphaMode };', replacement: "", failure: /keyboard alphabet selection must preserve its action after results refresh/ },
    { name: "alphabet control ownership", source: components, file: "views/components.js", casePattern: "music alphabet browsing removed controls cannot clear another catalog", marker: "if (!button.isConnected || music.mode !== mode) return;", replacement: "", failure: /a removed all-letters control must not clear another catalog's selected filter/ }
  ]) {
    assert.equal(control.source.split(control.marker).length - 1, 1, `negative must modify its current owning behavior: ${control.name}`);
    await assert.rejects(() => runMusicReaderFixture({ casePattern: control.casePattern, sourceOverrides: { [`/modules/music/${control.file}`]: control.source.replace(control.marker, control.replacement) } }), { name: "AssertionError", message: control.failure });
    console.log(`PASS negative control detects missing ${control.name}`);
  }
}
