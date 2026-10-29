import assert from "node:assert/strict";
import fs from "node:fs";
import { runMusicReaderFixture } from "./verify_music_reader_requests.mjs";

// Actual createMusicPage/CSS, private synthetic API/playlist state and controlled
// Audio in Chromium. This does not decode media or access the user's library.
const caseOption = process.argv.find(value => value.startsWith("--case="));
const negativeOnly = process.argv.includes("--negative-only");
assert(!(negativeOnly && caseOption), "--case and --negative-only cannot be combined");
if (!negativeOnly) {
  const current = await runMusicReaderFixture({ casePattern: caseOption?.slice(7) || "queue search:" });
  if (!caseOption) assert.equal(current.checks, 7);
}
if (!caseOption) {
  const source = fs.readFileSync(new URL("../public/modules/music/music-page.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  for (const negative of [
    {
      name: "complete queue search scope",
      marker: "return (state.music.queue || []).flatMap((track, index) => {",
      replacement: "return (state.music.queue || []).slice(0, DESKTOP_QUEUE_PAGE_SIZE).flatMap((track, index) => {",
      casePattern: "queue search: complete local",
      failure: /queue search must match all tracks by normalized title, artist and album outside the rendered prefix/
    },
    {
      name: "full queue operation index",
      marker: "for (const { track, index } of matches.slice(0, limit)) list.append(createQueueRow(track, index, list));",
      replacement: "for (const [index, { track }] of matches.slice(0, limit).entries()) list.append(createQueueRow(track, index, list));",
      casePattern: "queue search: filtered move",
      failure: /the first filtered match is movable when it is not first in the complete queue/
    },
    {
      name: "live search ancestry during metadata update",
      marker: 'const queuePanel = nowPanel.querySelector(".music-queue"), view = queueViews.get(queuePanel);\n    if (queueViewCurrent(view)) {',
      replacement: 'const queuePanel = nowPanel.querySelector(".music-queue"), view = queueViews.get(queuePanel);\n    if (false) {',
      casePattern: "queue search: metadata membership",
      failure: /background queue updates must preserve the complete live search ancestry, composing raw text, selection and focus/
    },
    {
      name: "IME confirmation submit ownership",
      marker: "if (view.candidateSubmit) { view.candidateSubmit = false; return; }",
      replacement: "// Negative control: process the submit belonging to composition confirmation.",
      casePattern: "queue search: narrow native",
      failure: /queue IME confirmation followed by submit must not move focus or start playback/
    }
  ]) {
    assert.equal(source.split(negative.marker).length, 2, `negative source marker must be unique: ${negative.name}`);
    await assert.rejects(() => runMusicReaderFixture({ casePattern: negative.casePattern,
      sourceOverrides: { "/modules/music/music-page.js": source.replace(negative.marker, negative.replacement) }
    }), { name: "AssertionError", message: negative.failure });
    console.log(`PASS negative control detects missing ${negative.name}`);
  }
  console.log(`Music queue search passed (${negativeOnly ? 0 : 7} private Chromium families + 4 independent behavior negative controls; controlled Audio, synthetic API and composition)`);
}
