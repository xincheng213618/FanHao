import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMusicReaderFixture } from "./verify_music_reader_requests.mjs";

// Actual music DOM/CSS in private Chromium, with synthetic APIs and controlled
// Audio. This verifies queue interaction and ownership, not audio decoding.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caseOption = process.argv.find(value => value.startsWith("--case="));
const negativeOnly = process.argv.includes("--negative-only");
assert(!(negativeOnly && caseOption), "--negative-only cannot be combined with --case");
if (!negativeOnly) await runMusicReaderFixture({ casePattern: caseOption?.slice(7) || "long queue" });

if (!caseOption) {
  const source = fs.readFileSync(path.join(root, "public/modules/music/music-page.js"), "utf8").replaceAll("\r\n", "\n");
  for (const negative of [
    {
      name: "queue membership refresh focus",
      casePattern: "long queue removal keeps focus on its next song 1440px ignore-abort",
      marker: "else refreshQueueRows(view);\n      restoreQueueContext(queuePanel, context);",
      replacement: "else refreshQueueRows(view);",
      failure: /removing a row must focus the same action on the next surviving song/
    },
    {
      name: "queue scroll capture",
      casePattern: "long queue removal keeps focus on its next song 1440px ignore-abort",
      marker: "const context = { scrollTop: list?.scrollTop || 0, focus: null };",
      replacement: "const context = { scrollTop: 0, focus: null };",
      failure: /queue removal must preserve the visible queue position/
    },
    {
      name: "queue pagination focus",
      casePattern: "long queue pagination focuses the first appended song 1440px ignore-abort",
      marker: "restoreQueueContext(panel, context);",
      failure: /loading the next queue page must leave focus at its first appended song/
    },
    {
      name: "current song summary refresh",
      casePattern: "long queue playing a later song preserves queue context 1440px ignore-abort",
      marker: 'refreshQueueRows(view);\n      restoreQueueContext(queuePanel, context);\n      playerBar.replaceWith(renderPlayerBar());',
      replacement: 'refreshQueueRows(view);\n      playerBar.replaceWith(renderPlayerBar());',
      failure: /starting another queue song must preserve its keyboard focus/
    },
    {
      name: "unplayed queue summary refresh",
      casePattern: "long queue move before first playback preserves focus 1440px ignore-abort",
      marker: "else refreshQueueRows(view);\n      restoreQueueContext(queuePanel, context);",
      replacement: "else refreshQueueRows(view);",
      failure: /queue edits before playback must preserve focus through summary replacement/
    }
  ]) {
    assert.equal(source.split(negative.marker).length - 1, 1, `negative must modify its current owning restoration: ${negative.name}`);
    await assert.rejects(() => runMusicReaderFixture({
      casePattern: negative.casePattern,
      sourceOverrides: { "/modules/music/music-page.js": source.replace(negative.marker, negative.replacement || "") }
    }), { name: "AssertionError", message: negative.failure });
    console.log(`PASS negative control detects missing ${negative.name}`);
  }
}
