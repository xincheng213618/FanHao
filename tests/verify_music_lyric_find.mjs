import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMusicReaderFixture } from "./verify_music_reader_requests.mjs";

// Actual current-song lyric DOM in private Chromium, synthetic details and
// controlled Audio. No library/media/credentials or running service is used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caseOption = process.argv.find(value => value.startsWith("--case="));
const negativeOnly = process.argv.includes("--negative-only");
assert(!(negativeOnly && caseOption), "--negative-only cannot be combined with --case");
if (!negativeOnly) {
  for (const casePattern of caseOption ? [caseOption.slice(7) || "lyric find"] : ["lyric find", "lyric browse", "lyric plain"]) await runMusicReaderFixture({ casePattern });
}
if (!caseOption) {
  const readSource = file => fs.readFileSync(path.join(root, "public/modules/music", file), "utf8").replaceAll("\r\n", "\n");
  const page = readSource("music-page.js"), finder = readSource("views/lyric-finder.js");
  for (const negative of [
    { name: "full-source matching", source: finder, path: "views/lyric-finder.js", casePattern: "lyric find counts and locates late matching lines ignore-abort", marker: "index < lines.length", replacement: "index < Math.min(120, lines.length)", failure: /current lyric find must count matching lines across the full source/ },
    { name: "finder ownership", source: finder, path: "views/lyric-finder.js", casePattern: "lyric find detached controls cannot mutate new song ignore-abort", marker: "if (!isCurrent() || composing) return;", replacement: "if (composing) return;", failure: /an old lyric surface must not pause the new song's following/ },
    { name: "lyric click ownership", source: page, path: "music-page.js", casePattern: "lyric find detached controls cannot mutate new song ignore-abort", marker: 'button.addEventListener("click", () => {\n      if (!isCurrent()) return;\n      player.seekToLyricLine', replacement: 'button.addEventListener("click", () => {\n      player.seekToLyricLine', failure: /detached lyric controls must not seek or rewrite another page's playback/ },
    { name: "follow control ownership", source: page, path: "music-page.js", casePattern: "lyric find detached controls cannot mutate new song ignore-abort", marker: 'follow.addEventListener("click", () => { if (isCurrent()) resumeLyricFollow(); });', replacement: 'follow.addEventListener("click", resumeLyricFollow);', failure: /an old follow control must not resume another song's lyric window/ },
    { name: "IME key ownership", source: finder, path: "views/lyric-finder.js", casePattern: "lyric find IME confirmation and cancellation stay local ignore-abort", marker: "if (composing || event.isComposing || event.keyCode === 229) { event.stopPropagation(); return; }", replacement: "", failure: /IME candidate cancellation must preserve the uncommitted lyric query/ },
    { name: "bounded lyric DOM", source: page, path: "music-page.js", casePattern: "lyric find long source stays bounded and follows outside prefix ignore-abort", marker: "index < Math.min(lyricLines.length, owner.startIndex + 120)", replacement: "index < lyricLines.length", failure: /a far lyric match must not mount the entire long source/ },
    { name: "manual lyric window", source: page, path: "music-page.js", casePattern: "lyric find manual location and return preserve lyric following ignore-abort", marker: "if (!state.music.lyricFollowPaused || force) lyricViewport?.show(index);", replacement: "lyricViewport?.show(index);", failure: /playback must preserve the manually located lyric window range/ },
    { name: "keyboard lyric focus", source: page, path: "music-page.js", casePattern: "lyric find keyboard line browsing keeps focus while playback advances ignore-abort", marker: 'lines.addEventListener("focusin", pauseFollow);', replacement: "", failure: /keyboard lyric browsing must keep its focused line while playback advances/ },
    { name: "closed finder reset", source: page, path: "music-page.js", casePattern: "lyric find detached controls cannot mutate closed page ignore-abort", marker: "if (!state.music.trackPageOpen) lyricFinderState = null;", replacement: "", failure: /a new song or reopened page must not inherit the old lyric query/ },
    { name: "paragraph focus intent", source: page, path: "music-page.js", casePattern: "lyric browse reads every paragraph without search or seeking ignore-abort", marker: 'navigation.addEventListener("focusin", pauseFollow);', replacement: "", failure: /focused paragraph selection must not be rewritten by playback across a page boundary/ },
    { name: "paragraph selector synchronization", source: page, path: "music-page.js", casePattern: "lyric browse synchronizes find and current paragraph while paused ignore-abort", marker: "paragraph.value = String(Math.floor(owner.startIndex / 120));", replacement: "", failure: /search location must synchronize the displayed lyric paragraph/ },
    { name: "paragraph visible viewport", source: page, path: "music-page.js", casePattern: "lyric browse synchronizes find and current paragraph while paused ignore-abort", marker: 'if (immediate) container.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });', replacement: "", failure: /paragraph lyric 4920 must be fully visible above the player and within its viewport/ },
    { name: "paragraph owner", source: page, path: "music-page.js", casePattern: "lyric browse old controls cannot change closed or replacement pages ignore-abort", marker: "const browseParagraph = target => {\n        if (!isCurrent()) return;", replacement: "const browseParagraph = target => {", failure: /old paragraph controls must not change closed or reopened following/ },
    { name: "plain source fallback", source: page, path: "music-page.js", casePattern: "lyric plain reads and finds all text while playing ignore-abort", marker: 'const raw = String(lyrics?.raw || "");', replacement: 'const raw = "";', failure: /raw lyrics without timestamps must be readable instead of reporting no lyrics/ },
    { name: "plain keyboard reading", source: page, path: "music-page.js", casePattern: "lyric plain reads and finds all text while playing ignore-abort", marker: 'text.addEventListener("keydown", event => { if (isCurrent() && event.key !== "Escape") event.stopPropagation(); });', replacement: "", failure: /plain lyric click and keyboard reading must never seek or change playback/ },
    { name: "plain source query ownership", source: page, path: "music-page.js", casePattern: "lyric plain keeps text ownership and query across redraw ignore-abort", marker: "lyricFinderState?.trackId === trackId && lyricFinderState.source === source", replacement: "lyricFinderState?.trackId === trackId", failure: /replacement raw source must reset the old query/ }
  ]) {
    assert.equal(negative.source.split(negative.marker).length - 1, 1, `negative must modify its current owning behavior: ${negative.name}`);
    await assert.rejects(() => runMusicReaderFixture({ casePattern: negative.casePattern, sourceOverrides: { [`/modules/music/${negative.path}`]: negative.source.replace(negative.marker, negative.replacement) } }), { name: "AssertionError", message: negative.failure });
    console.log(`PASS negative control detects missing ${negative.name}`);
  }
}
