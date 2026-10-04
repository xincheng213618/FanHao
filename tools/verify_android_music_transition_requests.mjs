import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// Actual Android page function bodies with controlled transport, Audio and RAF.
// This fixture does not start a server, read a library or decode media. Blob
// transport and play-promise ownership have separate browser/source fixtures.
const sourcePath = new URL("../android-client/www/modules/music/music-views.js", import.meta.url);
const currentSource = fs.readFileSync(sourcePath, "utf8");

function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, `negative control source boundary: ${before}`);
  return source.replace(before, after);
}

function selectionLegacy(source) {
  for (const [before, after] of [
    ["loadMusic(isListCurrent)", "loadMusic(isCurrent)"],
    ["if (!isCurrent() || openTrackGeneration !== initialSelection || playReportSession !== initialPlaybackSession) return;", "if (!isCurrent()) return;"],
    ["if (!isCurrent() || openTrackGeneration !== restoringSelection) return;", "if (!isCurrent()) return;"],
    ["const isCurrent = () => generation === openTrackGeneration && getActiveUrl() === activeUrl", "const isCurrent = () => getActiveUrl() === activeUrl"],
    ["if (pendingTrackSelection === generation) pendingTrackSelection = 0;", "pendingTrackSelection = 0;"],
    ["if (pendingTrackSelection) return;", "// Previous ended path had no pending-selection gate."],
    ["if (pendingTrackSelection || !transitionPreloadEnabled()", "if (!transitionPreloadEnabled()"],
    ["&& openTrackGeneration === handoffSelection;", ";"],
    ["&& playReportSession === session && openTrackGeneration === selection;", "&& playReportSession === session;"]
  ]) source = replaceOnce(source, before, after);
  return source;
}

function body(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert(first >= 0 && last > first, `actual function boundary: ${start}`);
  return source.slice(first, last);
}

function actualFunctions(source) {
  return [
    ["  async function renderMusicList(", "  function applyRouteParams("],
    ["  async function loadMusic(", "  function applyLoadedMusicData("],
    ["  function applyLoadedMusicData(", "  async function loadSearchOverview("],
    ["  async function openTrack(", "  function ensureAudio("],
    ["  function installAudioEvents(", "  function renderShell("],
    ["  function crossfadeAudioPair(", "  function cancelAudioFade("],
    ["  function cancelCrossfade(", "  function setVolume("],
    ["  function nextQueueCandidate(", "  function maybePromoteGaplessPreload("],
    ["  function tryPromoteGaplessPreload(", "  function playVisibleCollection("],
    ["  async function restoreLastTrack(", "  function rememberLastTrack("]
  ].map(([start, end]) => body(source, start, end)).join("\n");
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function ticks() {
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
}

function fixture(source, { restore = false } = {}) {
  const api = [], loads = [], plays = [], frames = [], rendered = [], remembered = [], retired = [];
  let url = "http://synthetic.invalid", adjacentCalls = 0, preloadCalls = 0, progressSaves = 0;
  class AudioDouble extends EventTarget {
    constructor(name) {
      super(); this.name = name; this.readyState = 3; this.currentTime = 52;
      this.duration = 180; this.paused = false; this.volume = 0.86; this.playbackRate = 1;
    }
    play() { const gate = deferred(); plays.push({ target: this, ...gate }); return gate.promise; }
    pause() { this.paused = true; }
  }
  const outgoing = new AudioDouble("P"), incoming = new AudioDouble("A");
  const state = {
    mode: "library", query: "", sort: "updated", current: restore ? null : { id: "P", positionMs: 52000 },
    queue: restore ? [] : [{ id: "P" }, { id: "A", streamUrl: "/A" }],
    summary: {}, playing: true, playbackSpeed: 1, volume: 0.86, crossfadeSeconds: 0,
    resumeQueue: restore, repeat: "off", lyrics: { lines: [], raw: "" }
  };
  let context;
  const bindings = {
    state, outgoing, incoming, console, URLSearchParams, encodeURIComponent,
    DEFAULT_SORT: "updated", document: { body: { dataset: {} } },
    window: { performance: { now: () => 10 }, requestAnimationFrame: callback => { frames.push(callback); return frames.length; } },
    els: { viewTitle: {}, viewMeta: {}, viewKicker: {}, viewContent: {} },
    getActiveUrl: () => url,
    ensureAudio() { context.installAudioEvents(context.inspect().audio); },
    cancelMusicPagination() {}, applyRouteParams() {}, setActiveBottom() {},
    renderShell() { rendered.push({ kind: "shell", loading: state.loading, status: state.status, current: state.current?.id }); },
    renderMusicUiPreservingSearch() { rendered.push({ kind: "refresh", loading: state.loading, status: state.status, current: state.current?.id }); },
    emptySearchOverview: () => ({}), emptyLyricSearch: () => ({}), musicListPath: () => "/api/music/tracks",
    musicListQuery: () => "", selectedSmartPlaylist: () => null, selectedPlaylist: () => null,
    musicTitle: () => "", musicMeta: () => "", focusedLibraryView: { emptyMessage: () => "" },
    loadSmartPlaylists: async () => {}, loadPlaylists: async () => {},
    fetchJson(activeUrl, endpoint, options) { const gate = deferred(); api.push({ activeUrl, endpoint, options, ...gate }); return gate.promise; },
    cancelProgressClock() {}, createMusicProgressSession: (trackId, activeUrl, startedAt) => ({ trackId, activeUrl, startedAt }),
    hasLyrics: () => false, rememberLastTrack(track) { remembered.push(track.id); },
    absoluteUrl: (activeUrl, stream) => activeUrl + stream,
    audioSourceStore: { load(slot, target, targetUrl, options) { const gate = deferred(); loads.push({ slot, target, targetUrl, options, ...gate }); return gate.promise; } },
    playAudio() { context.inspect().audio.play(); }, cancelAudioFade() {},
    scheduleGaplessPreload() { preloadCalls += 1; }, updatePlaybackUi() {}, updateLyricHighlight() {},
    transitionPreloadEnabled: () => true, reportPlayedOnce() {},
    saveProgressSoon() { progressSaves += 1; }, maybePromoteGaplessPreload() {},
    sleepAfterCurrentTimerActive: () => false, expireSleepTimer() {},
    async playAdjacent() { adjacentCalls += 1; },
    retireAudioElement(target) { if (target) { retired.push(target.name); target.pause(); } },
    readPlaybackQueuePreference: () => ({ activeUrl: url, currentTrackId: "A", queue: [{ id: "A" }, { id: "C" }] }),
    normalizeQueueTrack: track => track,
    readLastTrackPreference: () => ({ activeUrl: url, trackId: "last-C", track: { id: "last-C" } })
  };
  context = vm.createContext(bindings);
  vm.runInContext(`
    let moduleActive=false, musicRenderGeneration=0, openTrackGeneration=0, pendingTrackSelection=0;
    let playReportSession=0, currentPlaybackUrl="http://synthetic.invalid";
    let gaplessPreloadAudio=incoming, gaplessPreloadTrackId="A", gaplessPreloadActiveUrl=currentPlaybackUrl;
    let audio=outgoing, gaplessHandoffPending=false, progressSession=null, progressClaimRequired=false, playedReport=null;
    let currentLyricIndex=-1, crossfadeToken=0, crossfadeOutgoingAudio=null;
    const audioEventTargets=new WeakSet();
    ${actualFunctions(source)}
    function inspect() { return { audio, openTrackGeneration, pendingTrackSelection, playReportSession, gaplessHandoffPending }; }
  `, context, { filename: fileURLToPath(sourcePath) });
  context.installAudioEvents(outgoing);
  const trackBody = (id, overrides = {}) => ({ track: { id, streamUrl: `/${id}`, positionMs: 52000, ...overrides }, lyrics: { lines: [], raw: "" }, serverClockMs: 123 });
  async function finishTrack(index, id) {
    api[index].resolve(trackBody(id)); await ticks();
    const load = loads.at(-1); assert(load, "current track must reach the guarded source transport");
    load.resolve(load.options.guard()); await ticks();
  }
  return { state, context, api, loads, plays, frames, rendered, remembered, retired, outgoing, incoming,
    trackBody, finishTrack, setUrl(value) { url = value; },
    counts: () => ({ adjacentCalls, preloadCalls, progressSaves }) };
}

const cases = [];
const add = (name, run) => cases.push({ name, run });

for (const failure of [false, true]) add(`primary:${failure ? "late-error" : "late-success"}-preserves-pending-selection`, async source => {
  const f = fixture(source), page = f.context.renderMusicList({});
  const chosen = f.context.openTrack("B", { autoplay: false });
  if (failure) f.api[0].reject(new Error("old primary failure"));
  else f.api[0].resolve({ tracks: [{ id: "L" }] });
  await page;
  assert.equal(f.state.loading, true); assert.equal(f.state.status, "正在打开歌曲");
  assert.deepEqual(Array.from(f.state.queue, track => track.id), ["P", "A"]);
  await f.finishTrack(1, "B"); await chosen; assert.equal(f.state.current.id, "B");
});

add("restore:normal-saved-queue-keeps-position-and-no-autoplay", async source => {
  const f = fixture(source, { restore: true }), page = f.context.renderMusicList({});
  f.api[0].resolve({ tracks: [{ id: "L" }] }); await ticks();
  assert.equal(f.api[1].endpoint, "/api/music/tracks/A");
  await f.finishTrack(1, "A"); await page;
  assert.equal(f.state.current.id, "A"); assert.equal(f.state.current.positionMs, 52000);
  assert.equal(f.plays.length, 0); assert.deepEqual(f.remembered, ["A"]);
});

add("restore:pending-saved-track-yields-to-user-without-last-track-fallback", async source => {
  const f = fixture(source, { restore: true }), page = f.context.renderMusicList({});
  f.api[0].resolve({ tracks: [{ id: "L" }] }); await ticks();
  const chosen = f.context.openTrack("B", { autoplay: false });
  f.api[1].resolve(f.trackBody("A")); await ticks();
  assert.equal(f.state.current, null); assert.equal(f.state.loading, true);
  assert.equal(f.api.length, 3); assert.equal(f.loads.length, 0); assert.deepEqual(f.remembered, []);
  await page;
  await f.finishTrack(2, "B"); await chosen; assert.equal(f.state.current.id, "B");
  assert.deepEqual(f.remembered, ["B"]);
});

add("gapless:pending-user-selection-blocks-automatic-promotion", async source => {
  const f = fixture(source), chosen = f.context.openTrack("B", { autoplay: false });
  assert.equal(f.context.tryPromoteGaplessPreload(), false);
  assert.equal(f.state.current.id, "P"); assert.equal(f.plays.length, 0);
  await f.finishTrack(0, "B"); await chosen; assert.equal(f.state.current.id, "B");
});

for (const result of ["success", "failure", "crossfade"]) add(`gapless:started-handoff-${result}-cannot-override-later-user-selection`, async source => {
  const f = fixture(source); if (result === "crossfade") f.state.crossfadeSeconds = 5;
  assert.equal(f.context.tryPromoteGaplessPreload({ crossfade: result === "crossfade" }), true);
  assert.equal(f.state.current.id, "A"); assert.equal(f.plays.length, 1);
  if (result === "crossfade") { f.plays[0].resolve(); await ticks(); assert.equal(f.frames.length, 1); }
  const chosen = f.context.openTrack("B", { autoplay: false }), renderCount = f.rendered.length;
  if (result === "failure") f.plays[0].reject(new Error("old incoming play rejected"));
  else if (result === "success") f.plays[0].resolve();
  else f.frames.shift()(5010);
  await ticks();
  assert.equal(f.state.current.id, "A", "old failure must not restore outgoing P over the pending selection");
  assert.equal(f.state.loading, true); assert.equal(f.state.status, "正在打开歌曲");
  assert.equal(f.context.inspect().audio, f.incoming);
  assert.equal(f.context.inspect().gaplessHandoffPending, false, "discard must release its own handoff marker");
  assert.equal(f.api.length, 1, "obsolete handoff must not hydrate or reopen A");
  assert.equal(f.rendered.length, renderCount); assert.equal(f.counts().preloadCalls, 0);
  await f.finishTrack(0, "B"); await chosen; assert.equal(f.state.current.id, "B");
});

for (const failure of [false, true]) add(`hydrate:${failure ? "late-error" : "late-success"}-preserves-pending-selection`, async source => {
  const f = fixture(source); f.state.current = { id: "A", positionMs: 52000 };
  const hydration = f.context.hydratePromotedTrack("A"), chosen = f.context.openTrack("B", { autoplay: false });
  const current = f.state.current, queue = f.state.queue, renderCount = f.rendered.length;
  if (failure) f.api[0].reject(new Error("old promoted metadata failed"));
  else f.api[0].resolve(f.trackBody("A", { title: "old hydrated title" }));
  await hydration;
  assert.strictEqual(f.state.current, current); assert.strictEqual(f.state.queue, queue);
  assert.equal(f.state.loading, true); assert.equal(f.state.status, "正在打开歌曲");
  assert.equal(f.rendered.length, renderCount); assert.deepEqual(f.remembered, []);
  await f.finishTrack(1, "B"); await chosen; assert.equal(f.state.current.id, "B");
});

add("selection:old-finally-cannot-release-new-pending-token", async source => {
  const f = fixture(source), old = f.context.openTrack("A", { autoplay: false });
  const chosen = f.context.openTrack("B", { autoplay: false }), owner = f.context.inspect().pendingTrackSelection;
  f.api[0].reject(new Error("obsolete A failed")); await old;
  assert.equal(f.context.inspect().pendingTrackSelection, owner); assert(owner > 0);
  assert.equal(f.state.status, "正在打开歌曲"); assert.equal(f.context.tryPromoteGaplessPreload(), false);
  await f.finishTrack(1, "B"); await chosen; assert.equal(f.context.inspect().pendingTrackSelection, 0);
});

add("ended:pending-user-selection-prevents-automatic-next", async source => {
  const f = fixture(source), chosen = f.context.openTrack("B", { autoplay: false });
  f.outgoing.dispatchEvent(new Event("ended")); await ticks();
  assert.equal(f.counts().progressSaves, 1, "ended still captures outgoing progress");
  assert.equal(f.counts().adjacentCalls, 0); assert.equal(f.plays.length, 0); assert.equal(f.state.current.id, "P");
  assert.equal(f.state.loading, true); assert.equal(f.state.status, "正在打开歌曲");
  await f.finishTrack(0, "B"); await chosen; assert.equal(f.state.current.id, "B");
});

export async function runAndroidMusicTransitionRequestsFixture({ caseName = "", legacy = false } = {}) {
  const source = legacy ? selectionLegacy(currentSource) : currentSource;
  const selected = cases.filter(test => !caseName || test.name === caseName);
  assert(selected.length, `unknown case: ${caseName}`);
  for (const test of selected) {
    await test.run(source);
    console.log(`android-music-transition-requests: PASS ${test.name}`);
  }
  console.log(`android-music-transition-requests: ${selected.length} cases PASS`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const caseName = process.argv.find(arg => arg.startsWith("--case="))?.slice(7) || "";
  await runAndroidMusicTransitionRequestsFixture({ caseName, legacy: process.argv.includes("--legacy-selection") });
}
