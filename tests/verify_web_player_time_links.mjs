import assert from "node:assert/strict";
import fs from "node:fs";
import { runWebPlayerFixture } from "./verify_web_player_lifecycle.mjs";

const caseOption = process.argv.find(value => value.startsWith("--case="));
const current = await runWebPlayerFixture({ casePattern: caseOption?.slice(7) || "time link" });
if (!caseOption) {
  assert.equal(current.checks, 20);
  const player = fs.readFileSync(new URL("../public/js/player-page.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const control = fs.readFileSync(new URL("../public/js/player-time-link.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  for (const negative of [
    { name: "URL start intent", source: player, path: "/js/player-page.js", marker: 'let pendingLinkStart = parsePlaybackStart(params.get("t"));', replacement: "let pendingLinkStart = null;", count: 1, pattern: "time link starts the selected", failure: /a URL time position must override/ },
    { name: "clipboard UI ownership", source: control, path: "/js/player-time-link.js", marker: "owner === revision && button.isConnected", replacement: "button.isConnected", count: 2, pattern: "time link clipboard failure", failure: /an old clipboard failure must not open/ },
    { name: "canonical locator", source: control, path: "/js/player-time-link.js", marker: "const link = new URL(base.pathname, base.origin);", replacement: "const link = new URL(base.href);", count: 1, pattern: "time link copies the current", failure: /omit unrelated query\/hash data/ },
    { name: "fractional compatibility position", source: player, path: "/js/player-page.js", marker: 'if (mode !== "direct" && appliedTarget > playbackOffset) els.video.currentTime = appliedTarget - playbackOffset;', replacement: "", count: 1, pattern: "time link compatibility", failure: /the fractional part of a compatibility link/ },
    { name: "explicit file identity", source: player, path: "/js/player-page.js", marker: "if (requestedVideoId && requestedVideoId !== video.id)", replacement: "if (false)", count: 1, pattern: "time link unavailable file", failure: /a missing explicit file must not apply/ },
    { name: "released copy ownership", source: player, path: "/js/player-page.js", marker: "function stopCurrentPlayback() {\n  timeLinkControl.invalidate();", replacement: "function stopCurrentPlayback() {", count: 1, pattern: "time link released playback failure", failure: /released playback must disable/ },
    { name: "copy button playback protection", source: player, path: "/js/player-page.js", marker: "#playerShortcutsButton, #playerTimeJumpButton, #copyTimeLinkButton", replacement: "#playerShortcutsButton, #playerTimeJumpButton", count: 1, pattern: "time link copying preserves paused muted media with clipboard copy", failure: /copying a time link must not activate autoplay-muted playback/ },
    { name: "manual copy playback protection", source: player, path: "/js/player-page.js", marker: 'document.querySelector("dialog[open]")', replacement: 'document.querySelector("#playerShortcutsDialog[open], .player-time-jump-dialog[open]")', count: 1, pattern: "time link copying preserves paused muted media with manual copy", failure: /manual copy keys and closing its dialog must not activate autoplay-muted playback/ }
  ]) {
    assert.equal(negative.source.split(negative.marker).length - 1, negative.count);
    const overridden = negative.source.replaceAll(negative.marker, negative.replacement);
    await assert.rejects(() => runWebPlayerFixture({
      casePattern: negative.pattern,
      ...(negative.path === "/js/player-page.js" ? { sourceOverride: overridden } : { sourceOverrides: { [negative.path]: overridden } })
    }), { name: "AssertionError", message: negative.failure });
    console.log(`PASS negative control detects missing ${negative.name}`);
  }
  console.log("Player time links passed (20 private Chromium cases and 8 behavior negative controls; controlled clipboard/media and synthetic API)");
}
