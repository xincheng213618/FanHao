import assert from "node:assert/strict";
import fs from "node:fs";
import { runMusicReaderFixture } from "./verify_music_reader_requests.mjs";

// Actual music hosts/native keyboard in private Chromium. Synthetic API and
// controlled Audio: no production service, library, media or decoding.
const caseOption = process.argv.find(value => value.startsWith("--case="));
const negativeOnly = process.argv.includes("--negative-only");
assert(!(caseOption && negativeOnly), "--case and --negative-only cannot be combined");
if (!negativeOnly) {
  const current = await runMusicReaderFixture({ casePattern: caseOption?.slice(7) || "list more keyboard " });
  if (!caseOption) assert.equal(current.checks, 13, "the default load-more gate must exercise all 13 current behavior cases");
}
if (!caseOption) {
  const source = fs.readFileSync(new URL("../public/modules/music/music-page.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const wheelMarker = `    if (pending?.newerIntent) {
      const panel = els.workGrid?.querySelector(".music-track-panel");
      if (panel) appendViewportRestore = { owner: pending.owner, data: state.music.data, top: panel.scrollTop, windowY: window.scrollY };
    }`;
  for (const control of [
    { name: "native busy focus", casePattern: "list more keyboard library preserves Space", edits: [['more.setAttribute("aria-disabled", String(busy));', 'more.disabled = busy;\n    more.setAttribute("aria-disabled", String(busy));']], failure: /a pending continuation must retain its native keyboard focus/ },
    { name: "first new result handoff", casePattern: "list more keyboard library preserves Space", edits: [['if (focus?.more) {', 'if (false && focus?.more) {']], failure: /keyboard continuation must focus its first new result, visible and unobstructed/ },
    { name: "duplicate group identity", casePattern: "list more keyboard focuses a new song group", edits: [['![result.id, ...(result.duplicateIds || [])].some', '![result.id].some']], failure: /keyboard continuation must focus its first new result, visible and unobstructed/ },
    { name: "pending wheel position", casePattern: "list more keyboard query fallback retains a wheel", edits: [[wheelMarker, ""], ['if (pending?.newerIntent) return { more: more.owner, keepViewport: true };', 'if (pending?.newerIntent) return null;']], failure: /fallback continuation must retain the real wheel position accepted while pending/ },
    { name: "detached continuation ownership", casePattern: "list more keyboard old success", edits: [['if (!more.isConnected || !isListOwnerCurrent(record.owner) || state.music.loadingMore) return;\n      more.closest', 'if (state.music.loadingMore) return;\n      more.closest']], failure: /a detached continuation must never read another catalog's page/ }
  ]) {
    let changed = source;
    for (const [marker, replacement] of control.edits) {
      assert.equal(changed.split(marker).length - 1, 1, `negative must change its current owning behavior: ${control.name}`);
      changed = changed.replace(marker, replacement);
    }
    await assert.rejects(() => runMusicReaderFixture({ casePattern: control.casePattern, sourceOverrides: { "/modules/music/music-page.js": changed } }), { name: "AssertionError", message: control.failure });
    console.log(`PASS negative control detects missing ${control.name}`);
  }
  console.log(`Music load-more keyboard gate passed (${negativeOnly ? "5 negative controls" : "13 positive cases + 5 negative controls"})`);
}
