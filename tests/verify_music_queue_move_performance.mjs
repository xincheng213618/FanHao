import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMusicReaderFixture } from "./verify_music_reader_requests.mjs";

// Actual music page/CSS and button interactions in private Chromium. Timing is
// reported as a local measurement; stable gates assert retained interactive DOM,
// complete visible order, playing source, focus and safe full-refresh fallbacks.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caseOption = process.argv.find(value => value.startsWith("--case="));
const negativeOnly = process.argv.includes("--negative-only");
assert(!(negativeOnly && caseOption), "--negative-only cannot be combined with --case");
if (!negativeOnly) await runMusicReaderFixture({ casePattern: caseOption?.slice(7) || "queue move" });
if (!caseOption) {
  const source = fs.readFileSync(path.join(root, "public/modules/music/music-page.js"), "utf8").replaceAll("\r\n", "\n");
  for (const negative of [
    { name: "retained queue rows", casePattern: "large queue move interaction 2400 tracks ignore-abort", marker: "if (!view.model.query && moveCompleteQueueRow(queuePanel, queueMove)) updateQueueHead(view);", replacement: "if (false) updateQueueHead(view);", failure: /adjacent queue moves must retain the existing song rows/ },
    { name: "queue DOM ownership guard", casePattern: "queue move mismatched DOM falls back safely ignore-abort", marker: "row.dataset.musicTrackId !== trackId || queue[toIndex]?.id !== trackId || queue[fromIndex]?.id !== neighbor.dataset.musicTrackId", replacement: "false", failure: /a mismatched or partial queue must display the accepted order after its fallback/ },
    { name: "new first-row move state", casePattern: "long queue first disabled move has a keyboard fallback 1440px ignore-abort", marker: `currentRow.querySelector('[aria-label="上移"]').disabled = index === 0;`, replacement: "", failure: /a newly disabled move must leave an enabled action focused on the same song/ },
    { name: "retained queue focus", casePattern: "large queue move interaction 240 tracks ignore-abort", marker: "else refreshQueueRows(view);\n      restoreQueueContext(queuePanel, context);", replacement: "else refreshQueueRows(view);", failure: /adjacent queue moves must keep focus on the moved song/ }
  ]) {
    assert.equal(source.split(negative.marker).length - 1, 1, `negative must modify its current owning behavior: ${negative.name}`);
    await assert.rejects(() => runMusicReaderFixture({ casePattern: negative.casePattern, sourceOverrides: { "/modules/music/music-page.js": source.replace(negative.marker, negative.replacement) } }), { name: "AssertionError", message: negative.failure });
    console.log(`PASS negative control detects missing ${negative.name}`);
  }
}
