import assert from "node:assert/strict";
import fs from "node:fs";
import { runMusicReaderFixture } from "./verify_music_reader_requests.mjs";

// Actual 320/390px rows, native keyboard and emulated touch in private Chromium.
// Synthetic APIs and a real component consumer; no production audio/library.
const caseOption = process.argv.find(value => value.startsWith("--case="));
const negativeOnly = process.argv.includes("--negative-only");
assert(!(caseOption && negativeOnly), "--case and --negative-only cannot be combined");
if (!negativeOnly) await runMusicReaderFixture({ casePattern: caseOption?.slice(7) || "compact music rows " });
if (!caseOption) {
  const source = fs.readFileSync(new URL("../public/modules/music/styles/responsive.css", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  for (const control of [
    { name: "readable compact title column", casePattern: "compact music rows retain readable short song titles at 320px", marker: "grid-template-columns: 28px minmax(0, 1fr) auto;", replacement: "grid-template-columns: 38px minmax(0, 1fr) 64px 124px;", failure: /a short song title must remain readable instead of losing its column to fixed action widths/ },
    { name: "compact action touch targets", casePattern: "compact music rows expose independent touch actions at 320px", marker: ".music-track-action {\n    flex: 1 1 0;\n    min-width: 44px;\n    min-height: 44px;\n  }", replacement: ".music-track-action {\n    flex: 1 1 0;\n    min-width: 44px;\n    min-height: 28px;\n  }", failure: /compact song actions must offer unobstructed targets of at least 44px/ }
  ]) {
    assert.equal(source.split(control.marker).length - 1, 1, `negative must modify its current owning behavior: ${control.name}`);
    await assert.rejects(() => runMusicReaderFixture({ casePattern: control.casePattern, sourceOverrides: { "/modules/music/styles/responsive.css": source.replace(control.marker, control.replacement) } }), { name: "AssertionError", message: control.failure });
    console.log(`PASS negative control detects missing ${control.name}`);
  }
}
