import assert from "node:assert/strict";
import fs from "node:fs";
import { runMusicReaderFixture } from "./verify_music_reader_requests.mjs";

// Actual library/catalog failures, native keyboard and standalone popstate in
// private Chromium. Synthetic APIs and controlled Audio, no real music data.
const caseOption = process.argv.find(value => value.startsWith("--case="));
const negativeOnly = process.argv.includes("--negative-only");
assert(!(caseOption && negativeOnly), "--case and --negative-only cannot be combined");
if (!negativeOnly) {
  for (const casePattern of caseOption ? [caseOption.slice(7)] : ["library recovery ", "list error "]) await runMusicReaderFixture({ casePattern });
}
if (!caseOption) {
  const readSource = name => fs.readFileSync(new URL(`../public/modules/music/${name}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const page = readSource("music-page.js"), actions = readSource("actions.js");
  for (const control of [
    { name: "failed selection presentation", source: page, path: "music-page.js", casePattern: "library recovery library replaces failed results and retries current conditions ignore-abort", marker: "if (failure) table.append(renderListReadRecovery(failure));", replacement: "if (false) table.append(renderListReadRecovery(failure));", failure: /a failed new query must not present items from the previous library selection as its results/ },
    { name: "list failure account ownership", source: actions, path: "actions.js", casePattern: "library recovery old-account controls cannot start reads for a new account", marker: "return account.owner === failure.account.owner && account.revision === failure.account.revision ? failure : null;", replacement: "return failure;", failure: /an old-account retry must not use the new account's credentials/ },
    { name: "newer retry focus intent", source: page, path: "music-page.js", casePattern: "library recovery success respects a newer search focus ignore-abort", marker: "if (hadFocus && !newerIntent && retry?.isCurrent() && !state.music.trackPageOpen)", replacement: "if (hadFocus && retry?.isCurrent() && !state.music.trackPageOpen)", failure: /a list retry must not steal a newer search focus or selection/ },
    { name: "retry selection preservation", source: actions, path: "actions.js", casePattern: "library recovery library replaces failed results and retries current conditions ignore-abort", marker: "beginNavigation();\n    const pending = loadMusic({ replaceRoute: true, keepCurrent: true, restoreLast: failure.restoreLast, retryFailure: failure });", replacement: 'beginNavigation();\n    music().query = "";\n    const pending = loadMusic({ replaceRoute: true, keepCurrent: true, restoreLast: failure.restoreLast, retryFailure: failure });', failure: /retry must retain its committed search query instead of navigating to an unfiltered collection/ },
    { name: "list recovery after foreground changes", source: actions, path: "actions.js", casePattern: "library recovery stays usable when a new song takes foreground ownership ignore-abort", marker: "if (isMusicLoadCurrent(request) && options.retryFailure && !append && !background) {", replacement: "if (false) {", failure: /choosing another song must not strand the still-current list's retry control/ },
    { name: "invalid failure-owner getter", source: actions, path: "actions.js", casePattern: "library recovery invalid account before click fails closed", marker: "let account;\n    try { account = captureWebAccount(); } catch { return null; }", replacement: "const account = captureWebAccount();", failure: /invalid account ownership checks must return inactive without producing a page error/ },
    { name: "invalid asynchronous retry owner", source: actions, path: "actions.js", casePattern: "library recovery invalid account during retry fails closed", marker: "let account;\n      try { account = captureWebAccount(); } catch { return false; }", replacement: "const account = captureWebAccount();", failure: /invalid account ownership checks must return inactive without producing a page error/ },
    // Reproduce the old observed blur as well as native disabling: Chromium
    // can defer that focus transition to different keyboard event boundaries.
    { name: "busy recovery keyboard focus", source: page, path: "music-page.js", casePattern: "library recovery busy keyboard retry preserves paused playback ignore-abort", marker: 'button.setAttribute("aria-disabled", "true");', replacement: "button.disabled = true; button.blur();", failure: /busy list recovery must keep Space on its focused action instead of starting paused audio/ }
  ]) {
    assert.equal(control.source.split(control.marker).length - 1, 1, `negative must modify its current owning behavior: ${control.name}`);
    await assert.rejects(() => runMusicReaderFixture({ casePattern: control.casePattern, sourceOverrides: { [`/modules/music/${control.path}`]: control.source.replace(control.marker, control.replacement) } }), { name: "AssertionError", message: control.failure });
    console.log(`PASS negative control detects missing ${control.name}`);
  }
}
