import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Actual Android music modules and DOM in private Chromium. Synthetic metadata,
// controlled Audio, a random loopback port; no library, media or production service.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const www = path.join(root, "android-client", "www");
const legacyRevision = "1f6ddf213f0fbab4d417fdf61636b957d1909338";
const legacy = process.argv.includes("--legacy") || process.argv.includes("--measure-legacy");
const measureOnly = process.argv.includes("--measure-legacy");
const legacyContainment = process.argv.includes("--legacy-containment");
const legacyCoverOrder = process.argv.includes("--legacy-cover-order");
const legacyAuxiliary = process.argv.includes("--legacy-auxiliary");
const legacySearchOverview = process.argv.includes("--legacy-search-overview");
const legacySearchOverviewServer = process.argv.includes("--legacy-search-overview-server");
const searchOverviewOnly = process.argv.includes("--search-overview-only") || legacySearchOverview || legacySearchOverviewServer;
const legacyComposition = process.argv.includes("--legacy-search-composition");
const compositionOnly = process.argv.includes("--composition-only") || legacyComposition;
const legacyRowLayout = process.argv.includes("--legacy-row-layout");
const legacyRowKeyboard = process.argv.includes("--legacy-row-keyboard");
const rowLayoutOnly = process.argv.includes("--row-layout-only") || legacyRowLayout || legacyRowKeyboard;
const rowNegativeCase = legacyRowLayout ? "row layout: flat titles and touch actions fit narrow viewports"
  : legacyRowKeyboard ? "row layout: real row and child keyboard/mouse activation stay distinct" : "";
const legacyTrackWriteLane = process.argv.includes("--legacy-track-write-lane");
const legacyTrackWriteRead = process.argv.includes("--legacy-track-write-read");
const trackWritesOnly = process.argv.includes("--track-writes-only") || legacyTrackWriteLane || legacyTrackWriteRead;
const trackWriteNegativeCase = legacyTrackWriteLane ? "track writes: rating lane sends one inflight and only the latest desired intent"
  : legacyTrackWriteRead ? "track writes: late real list and playback hydration GETs preserve confirmed fields" : "";
const legacyPlaybackFocus = process.argv.includes("--legacy-playback-focus");
const legacyPlaybackGrid = process.argv.includes("--legacy-playback-grid");
const playbackSettingsOnly = process.argv.includes("--playback-settings-only") || legacyPlaybackFocus || legacyPlaybackGrid;
const legacyMiniKeyboard = process.argv.includes("--legacy-mini-keyboard");
const legacyMiniGesture = process.argv.includes("--legacy-mini-gesture");
const miniPlayerOnly = process.argv.includes("--mini-player-only") || legacyMiniKeyboard || legacyMiniGesture;
let trackPreferencesSource = fs.readFileSync(path.join(www, "modules/music/music-track-preferences.js"), "utf8");
if (legacyTrackWriteLane || legacyTrackWriteRead) {
  const marker = legacyTrackWriteLane ? "      if (lane.active) {" : "      if (read && (saved.clock > read.clock";
  assert.equal(trackPreferencesSource.split(marker).length, 2, "write negative control must change one actual production hook");
  trackPreferencesSource = trackPreferencesSource.replace(marker, legacyTrackWriteLane ? "      if (false) {" : "      if (false && (saved.clock > read.clock");
}
const legacyControlFocus = process.argv.includes("--legacy-control-focus");
const unguardedControlIntent = process.argv.includes("--unguarded-control-intent");
const asyncFocusOnly = process.argv.includes("--async-focus-only") || legacyControlFocus || unguardedControlIntent;
const focusNegativeCase = legacyControlFocus ? "async control sort: success focuses the replacement trigger"
  : unguardedControlIntent ? "async control user tab then body: a pending reply cannot reclaim focus" : "";
let controlFocusSource = fs.readFileSync(path.join(www, "modules/music/music-control-focus.js"), "utf8");
if (legacyControlFocus || unguardedControlIntent) {
  const marker = legacyControlFocus ? "      target.focus({ preventScroll: true });"
    : '    for (const type of ["pointerdown", "keydown", "input", "compositionstart", "focusin", "wheel"]) listen(document, type);';
  assert.equal(controlFocusSource.split(marker).length, 2, "focus negative control must change one actual production hook");
  controlFocusSource = controlFocusSource.replace(marker, legacyControlFocus ? "      /* automatic control focus omitted */" : "    /* user interaction retirement omitted */");
}
const containmentRule = /\/\* Flat rows: 65px content[^]*?\n}\r?\n/;
const stylesSource = fs.readFileSync(path.join(www, "styles.css"), "utf8");
assert.match(stylesSource, containmentRule, "the full Android entry must include the flat-row rule");
const baselineStyles = stylesSource.replace(containmentRule, "");
const flatRows = ".music-mobile-shell > .music-mobile-list > .music-mobile-track";
const median = values => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(value => fs.existsSync(value));
assert(executablePath, "Chrome or Edge required for the private Android music fixture");
let viewsSource = fs.readFileSync(path.join(www, "modules/music/music-views.js"), "utf8");
if (legacyMiniKeyboard) {
  const hook = /(    const open = document\.createElement\()"button"(\);\r?\n    open\.type = "button";\r?\n    open\.className = "music-mobile-mini-open";)/g;
  assert.equal([...viewsSource.matchAll(hook)].length, 1, "mini keyboard negative restores one actual non-native opener");
  viewsSource = viewsSource.replace(hook, '$1"span"$2');
}
if (legacyMiniGesture) {
  const marker = "      if (!start || !isCurrent() || open.disabled) return;";
  assert.equal(viewsSource.split(marker).length, 2, "mini gesture negative changes one actual end-of-gesture ownership guard");
  viewsSource = viewsSource.replace(marker, "      if (!start || open.disabled) return;");
}
if (legacyPlaybackFocus) {
  const marker = '      "playback-close": ".music-mobile-playback-settings-sheet .music-mobile-playback-settings-close",';
  assert.equal(viewsSource.split(marker).length, 2, "playback focus negative must change one actual target mapping");
  viewsSource = viewsSource.replace(marker, '      "playback-close": ".fixture-missing-playback-focus",');
}
let rowHomeCss = fs.readFileSync(path.join(www, "modules/music/home.css"), "utf8");
if (legacyPlaybackGrid) {
  const blocks = [...rowHomeCss.matchAll(/body\.music-mobile-view \.music-mobile-playback-settings-body\s*\{[^}]+\}/g)]
    .filter(match => match[0].includes("grid-auto-rows: max-content;"));
  assert.equal(blocks.length, 1, "playback grid negative must restore one actual pre-fix row sizing rule");
  rowHomeCss = rowHomeCss.replace(blocks[0][0], blocks[0][0].replace(/^\s*grid-auto-rows: max-content;\r?\n/m, ""));
}
if (legacyRowLayout) {
  const rule = /body\.music-mobile-view \.music-mobile-track \.music-mobile-icon-button\.track-label\s*\{[^}]+\}/g;
  assert.equal([...rowHomeCss.matchAll(rule)].length, 1, "restore the actual historical 34px row actions in one production rule");
  rowHomeCss = rowHomeCss.replace(rule, block => block.replaceAll("44px", "34px"));
}
if (legacyRowKeyboard) {
  const marker = "      if (event.target !== row) return;";
  assert.equal(viewsSource.split(marker).length, 2, "restore the actual old row keyboard handler without its descendant guard");
  viewsSource = viewsSource.replace(marker, "      /* old row keyboard handler accepted descendant keys */");
}
if (legacyComposition) {
  const guard = "const isComposing = (event) => composing || event?.isComposing || event?.keyCode === 229;";
  assert.equal(viewsSource.split(guard).length, 2);
  viewsSource = viewsSource.replace(guard, "const isComposing = () => false;");
}
let paginationSource = fs.readFileSync(path.join(www, "modules/music/music-list-pagination.js"), "utf8");
if (legacyCoverOrder) {
  const currentOrder = /    img.alt = ([^\n]*)\r?\n    img.loading = ([^\n]*)\r?\n    img.decoding = "async";\r?\n    img.src = coverSource\(item\);/;
  assert.match(viewsSource, currentOrder, "negative control must restore the actual previous renderCover order");
  viewsSource = viewsSource.replace(currentOrder, "    img.src = coverSource(item);\n    img.alt = $1\n    img.loading = $2\n    img.decoding = \"async\";");
}
if (legacy) {
  // This exact old pagination kernel still uses render() for both phases. Current
  // page callbacks are ignored, so the real old whole-shell path is exercised.
  const result = spawnSync("git", ["show", `${legacyRevision}:android-client/www/modules/music/music-list-pagination.js`], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  paginationSource = result.stdout;
  assert.match(paginationSource, /state\.loadingMore = true;\s+render\(\);/);
  // Retain the previous actual per-tick row scan for the diagnostic comparison.
  viewsSource = viewsSource.replace(/    const rowsKey = JSON\.stringify\(\[playbackRowsGeneration, currentId, playing\]\);\s+if \(rowsKey === playbackRowsKey\) return;\s+playbackRowsKey = rowsKey;\r?\n/, "");
}
assert.match(viewsSource, /  installLifecycle\(\);/);
if (legacyAuxiliary) {
  // Restore only the previous successful side-response refresh, preserving the
  // current request ownership. The negative must fail on DOM replacement.
  const callback = "refreshMusicCatalogueUi: (kind) => refreshMusicCatalogueUi(kind)";
  assert.equal(viewsSource.split(callback).length, 2, "negative must replace the actual side-request refresh callback exactly once");
  viewsSource = viewsSource.replace(callback, "refreshMusicCatalogueUi: () => renderMusicUiPreservingSearch()");
}
if (legacySearchOverview || legacySearchOverviewServer) {
  const guard = "    if (signal?.aborted || getActiveUrl() !== requestUrl || (renderGuard && !renderGuard())) return;";
  assert.equal(viewsSource.split(guard).length, 2, "negative must replace the actual overview continuation guard exactly once");
  viewsSource = viewsSource.replace(guard, legacySearchOverviewServer
    ? "    if (signal?.aborted || (renderGuard && !renderGuard())) return;"
    : "    if (renderGuard && !renderGuard()) return;");
}
viewsSource = viewsSource.replace("  function renderShell() {", `
  function renderShell() {
    const started = performance.now(), before = window.__created;
    try { return renderShellMeasured(); }
    finally { window.__shellCalls.push({ ms: performance.now() - started, created: window.__created - before, rows: els.viewContent.querySelectorAll('.music-mobile-list .music-mobile-track').length }); }
  }
  function renderShellMeasured() {`);
viewsSource = viewsSource.replace("  installLifecycle();", `
  window.__musicListFixture = {
    state, audio: () => audio, search: query => refreshMountedSearchResults(query),
    playbackSource: () => currentPlaybackUrl, hydrate: id => hydratePromotedTrack(id),
    seed: (data, options = {}) => {
      // Synthetic read DTOs still pass the production provenance boundary. The
      // preference regressions below establish owners through real GET/open.
      const fixtureOwner = trackPreferences.owner(getActiveUrl(), captureAccountOwner(getActiveUrl()));
      trackPreferences.preparePayload(data, fixtureOwner);
      if (options.current) trackPreferences.preparePayload({ track: options.current }, fixtureOwner);
      state.data = { ...data, rawTracks: data.tracks, rawLoaded: data.tracks.length };
      state.summary = data.summary; state.queue = data.tracks; state.hasMore = data.hasMore;
      Object.assign(state, options); renderShell();
    },
    more: () => loadMoreTracks(), render: () => renderShell(), locate: () => locateCurrentTrack(), deactivate: () => deactivate(),
    side: kind => kind === 'smart' ? loadSmartPlaylists() : loadPlaylists(),
    route: params => renderMusicList(params)
  };
  installLifecycle();`);
viewsSource = viewsSource.replace("render: renderMusicUiPreservingSearch,", "render: () => { const start = performance.now(); renderMusicUiPreservingSearch(); window.__renderSamples.push(performance.now() - start); },");
// Observe the real quick-filter task without replacing its request/render logic.
const mountedSearchHook = /^  async function refreshMountedSearchResults\(([^)]*)\) \{/m;
assert.match(viewsSource, mountedSearchHook);
viewsSource = viewsSource.replace(mountedSearchHook, `  function refreshMountedSearchResults(...args) {
    const task = refreshMountedSearchResultsMeasured(...args);
    if (window.__captureFocusRequests) window.__fixtureFilterTask = task;
    return task;
  }
  async function refreshMountedSearchResultsMeasured($1) {`);
// Observe promises from the real UI handlers; keep their requests and ownership
// decisions intact, including replies which intentionally produce no DOM work.
for (const name of ["toggleFavorite", "setTrackRating"]) {
  const hook = new RegExp(`^  (?:async )?function ${name}\\(([^)]*)\\) \\{`, "m");
  assert.match(viewsSource, hook);
  viewsSource = viewsSource.replace(hook, `  function ${name}(...args) {
    const task = Promise.resolve(${name}Measured(...args));
    if (window.__captureTrackWrites) window.__trackWriteTasks.push(task.then(() => null, error => ({ code: error?.code, message: error?.message })));
    return task;
  }
  async function ${name}Measured($1) {`);
}
// The legacy baseline page had the same callback shape with no comma additions.
if (!viewsSource.includes("window.__renderSamples.push")) viewsSource = viewsSource.replace("render: renderMusicUiPreservingSearch", "render: () => { const start = performance.now(); renderMusicUiPreservingSearch(); window.__renderSamples.push(performance.now() - start); }");
viewsSource = viewsSource.replace("setLoadingState: setMusicPaginationLoadingState,", "setLoadingState: loading => { const start = performance.now(), value = setMusicPaginationLoadingState(loading); window.__phaseSamples.push({ phase: 'loading', ms: performance.now() - start }); return value; },")
  .replace("appendPage: appendMusicTrackPage", "appendPage: payload => { const start = performance.now(), value = appendMusicTrackPage(payload); window.__phaseSamples.push({ phase: 'append', ms: performance.now() - start }); return value; }");

const track = (index, overrides = {}) => ({ id: `T${index}`, title: `Synthetic Track ${index}`, artist: "Synthetic Artist", artistId: "S", album: "Synthetic Album", albumId: "A", durationMs: 180000, streamUrl: `/synthetic/audio/${index}`, coverUrl: `/synthetic/cover/${index}.svg`, fileName: `T${index}.mp3`, ...overrides });
const summary = { totals: { tracks: 2000, artists: 1, albums: 1, durationMs: 360000000 }, roots: [], recent: [], topPlayed: [] };
const data = (count, offset = 0, extra = {}) => ({ tracks: Array.from({ length: count }, (_, index) => track(offset + index + 1)), total: 2000, hasMore: true, summary, artists: [], albums: [], genres: [], languages: [], ...extra });
const auxiliarySmart = { smartPlaylists: [{ id: "S-late", name: "Late Smart", description: "Side description", trackCount: 80 }] };
const auxiliaryPlaylists = { playlists: [{ id: "P-late", name: "Late Playlist", description: "Side description", trackCount: 80 }] };
const gates = new Set(), errors = [], unexpected = [], requests = [];
let trackWriteFixture = null;
let browser, checks = 0;
const requestHandler = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-FanHao-Client, X-FanHao-Account-Owner");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, `http://${req.headers.host}`);
  requests.push(`${url.pathname}${url.search}`);
  try {
    if (trackWriteFixture && await trackWriteFixture.handle(req, res, url)) return;
    const gate = [...gates].find(item => !item.used && item.match(url));
    if (gate) {
      gate.used = true; gate.url = `${url.pathname}${url.search}`; gate.requestedResolve();
      res.once("close", () => { gate.closed = true; });
      await gate.promise;
      if (gate.error) { json(res, { error: gate.error }, 503); return; }
      if (gate.body) { json(res, gate.body); return; }
    }
    if (url.pathname === "/probe") { res.writeHead(200, { "Content-Type": "text/html" }); res.end(harness(url)); return; }
    if (url.pathname === "/api/music/tracks") { json(res, data(80, Number(url.searchParams.get("offset") || 0))); return; }
    if (url.pathname === "/api/music/suggest") { json(res, { tracks: [], artists: [], albums: [] }); return; }
    if (url.pathname === "/api/music/smart-playlists") { json(res, { smartPlaylists: [] }); return; }
    if (url.pathname === "/api/music/playlists") { json(res, { playlists: [] }); return; }
    if (/^\/api\/music\/(?:smart-playlists|playlists)\/[^/]+$/.test(url.pathname)) { json(res, data(80)); return; }
    if (url.pathname === "/api/music/artists") { json(res, { artists: [], total: 0, summary }); return; }
    if (url.pathname === "/api/music/albums") { json(res, { albums: [], total: 0, summary }); return; }
    if (url.pathname === "/api/music/search-lyrics") { json(res, { matches: [], total: 0 }); return; }
    if (url.pathname === "/api/music/lyrics/search") { json(res, { query: url.searchParams.get("q") || "", matches: [], total: 0,
      limit: Number(url.searchParams.get("limit") || 4), offset: Number(url.searchParams.get("offset") || 0), hasMore: false }); return; }
    if (/^\/api\/music\/tracks\/T\d+$/.test(url.pathname) && req.method === "GET") { json(res, { track: track(Number(url.pathname.split("T").at(-1))), lyrics: [] }); return; }
    if (url.pathname.startsWith("/api/music/tracks/") && req.method === "POST") { for await (const _chunk of req) { /* only synthetic progress traffic */ } json(res, { ok: true }); return; }
    if (url.pathname.startsWith("/api/")) { unexpected.push(url.pathname); json(res, { error: "unmodelled fixture API" }, 404); return; }
    if (url.pathname.startsWith("/synthetic/audio/")) {
      // Actual Android playback fetches its protected source into a blob before
      // assigning Audio.src. Supply generated bytes; AudioDouble never decodes them.
      res.writeHead(200, { "Content-Type": "audio/mpeg" }); res.end(Buffer.from("private controlled audio double")); return;
    }
    if (url.pathname.startsWith("/synthetic/") || url.pathname.startsWith("/assets/")) { res.writeHead(200, { "Content-Type": "image/svg+xml" }); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#888"/></svg>'); return; }
    if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    const target = path.resolve(www, url.pathname.replace(/^\/+/, ""));
    assert(target.startsWith(`${www}${path.sep}`), "static fixture path outside Android www");
    const source = url.pathname === "/modules/music/music-views.js" ? viewsSource : url.pathname === "/modules/music/music-list-pagination.js" ? paginationSource : url.pathname === "/modules/music/music-control-focus.js" ? controlFocusSource : url.pathname === "/modules/music/music-track-preferences.js" ? trackPreferencesSource : url.pathname === "/modules/music/home.css" ? rowHomeCss : url.pathname === "/styles.css" ? (legacyContainment ? baselineStyles : stylesSource) : await fs.promises.readFile(target);
    res.writeHead(200, { "Content-Type": target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : "application/octet-stream" }); res.end(source);
  } catch (error) { unexpected.push(`${url.pathname}: ${error.message}`); if (!res.destroyed) json(res, { error: error.message }, 500); }
};
const server = createServer(requestHandler), alternateServer = createServer(requestHandler);
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
await new Promise(resolve => alternateServer.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const alternateBase = `http://127.0.0.1:${alternateServer.address().port}`;
const run = async (name, task) => {
  if (miniPlayerOnly && !name.startsWith("mini player:")) return;
  if (legacyMiniKeyboard && name !== "mini player: native mouse Enter and Space roundtrips retain deep scroll and focus") return;
  if (legacyMiniGesture && name !== "mini player: retired mini and fullscreen nodes cannot change the new surface") return;
  if (playbackSettingsOnly && !name.startsWith("playback settings:")) return;
  if (legacyPlaybackFocus && name !== "playback settings: real Tab cycle and Escape keep focus in the active dialog") return;
  if (legacyPlaybackGrid && name !== "playback settings: cover and lyrics entry and scrollable controls fit three mobile viewports") return;
  if (trackWritesOnly && !name.startsWith("track writes:")) return;
  if (trackWriteNegativeCase && name !== trackWriteNegativeCase) return;
  if (compositionOnly && !name.startsWith("composition:")) return;
  if (asyncFocusOnly && !name.startsWith("async control ")) return;
  if (focusNegativeCase && name !== focusNegativeCase) return;
  if (rowLayoutOnly && !name.startsWith("row layout:")) return;
  if (rowNegativeCase && name !== rowNegativeCase) return;
  await task(); checks++; console.log(`${measureOnly ? "MEASURE" : "PASS"} ${name}`);
};
try {
  browser = await chromium.launch({ executablePath, headless: true });
  if (!measureOnly && !searchOverviewOnly) await verifyMusicSearchComposition();
  if (searchOverviewOnly) {
    await verifySearchOverviewOwnership();
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    console.log(`PASS Android music search overview: ${checks} actual Chromium scenarios`);
  }
  for (const count of searchOverviewOnly ? [] : [300, 1000]) await run(`flat library ${count}: loading and append preserve rows/player`, async () => {
    const page = await newPage(), gate = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("offset") === String(count), data(80, count));
    try {
      await seed(page, count); await page.evaluate(() => {
        const f = __musicListFixture, audio = f.audio(); f.state.current = f.state.data.tracks[0]; audio.paused = false; audio.currentTime = 41; f.render();
      });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.evaluate(() => {
        const f = __musicListFixture;
        snapshot(); window.__loadStart = performance.now(); window.__loadTask = f.more(); window.__loadingSyncMs = performance.now() - __loadStart;
      });
      await requested(gate);
      await page.evaluate(() => { __row.dataset.fixtureObserved = "true"; });
      const loading = await page.evaluate(() => ({ ...identities(), created: __created, synchronousMs: __loadingSyncMs, buttonDisabled: document.querySelector(".music-mobile-load-more").disabled, audioTime: __musicListFixture.audio().currentTime, paused: __musicListFixture.audio().paused }));
      if (!measureOnly) {
        assert.equal(loading.rowConnected, true); assert.equal(loading.miniConnected, true); assert.equal(loading.observerStillMounted, true);
        assert(loading.observedChanges > 0, "the existing row observer must remain attached during loading");
        assert.equal(loading.created, 0, "loading must update its existing button without rebuilding elements"); assert.equal(loading.buttonDisabled, true); assert.equal(loading.audioTime, 41); assert.equal(loading.paused, false);
      }
      await page.evaluate(() => { __created = 0; window.__settleStart = performance.now(); });
      gate.release(); await page.evaluate(() => __loadTask);
      const success = await page.evaluate(() => ({ ...identities(), created: __created, elapsedMs: performance.now() - __settleStart, rows: document.querySelectorAll(".music-mobile-list .music-mobile-track").length, rawLoaded: __musicListFixture.state.data.rawLoaded, renderSamples: __renderSamples, phaseSamples: __phaseSamples, audioTime: __musicListFixture.audio().currentTime, paused: __musicListFixture.audio().paused }));
      if (!measureOnly) {
        assert.equal(success.rowConnected, true); assert.equal(success.miniConnected, true); assert.equal(success.observerStillMounted, true);
        assert.equal(success.rows, count + 80); assert.equal(success.rawLoaded, count + 80); assert(success.created < 1600, `80 rows should create O(80) elements, got ${success.created}`);
        assert.equal(success.audioTime, 41); assert.equal(success.paused, false); assert.equal(new URL(gate.url, base).searchParams.get("offset"), String(count));
      }
      const ticks = await page.evaluate(() => {
        const audio = __musicListFixture.audio(), original = Element.prototype.querySelector;
        let queries = 0; Element.prototype.querySelector = function (...args) { queries++; return original.apply(this, args); };
        const start = performance.now(); for (let index = 0; index < 200; index++) { audio.currentTime = 20 + index / 10; audio.dispatchEvent(new Event("timeupdate")); }
        const elapsedMs = performance.now() - start; Element.prototype.querySelector = original;
        return { queries, elapsedMs, currentRows: document.querySelectorAll('.music-mobile-track[data-current="true"]').length };
      });
      if (!measureOnly) { assert(ticks.queries < 5000, "unchanged playback must not scan every row on each tick"); assert.equal(ticks.currentRows, 1); }
      console.log(JSON.stringify({ mode: legacy ? "legacy" : "current", count, loading, success, ticks }));
    } finally { gate.release(); await page.close(); }
  });
  if (!measureOnly && !searchOverviewOnly) {
    await run("failed page keeps rows and retries the same raw offset", async () => {
      const page = await newPage(); try {
        await seed(page, 300); const failed = hold(url => url.searchParams.get("offset") === "300", null, "controlled page error");
        await page.evaluate(() => { snapshot(); window.__loadTask = __musicListFixture.more().then(() => null, error => error.message); }); await requested(failed); failed.release();
        assert.equal(await page.evaluate(() => __loadTask), "controlled page error");
        assert.deepEqual(await page.evaluate(() => ({ row: __row.isConnected, mini: __mini.isConnected, disabled: document.querySelector(".music-mobile-load-more").disabled, count: __musicListFixture.state.data.rawLoaded })), { row: true, mini: true, disabled: false, count: 300 });
        const retry = hold(url => url.searchParams.get("offset") === "300", data(80, 300)); await page.evaluate(() => { window.__loadTask = __musicListFixture.more(); }); await requested(retry); retry.release(); await page.evaluate(() => __loadTask);
        assert.equal(await page.locator(".music-mobile-list .music-mobile-track").count(), 380);
      } finally { await page.close(); }
    });
    for (const ignoreAbort of [false, true]) for (const error of ["", "obsolete page error"]) await run(`route/filter supersedes ${ignoreAbort ? "ignored-abort" : "normal-abort"} page ${error ? "error" : "success"}`, async () => {
      const page = await newPage({ ignoreAbort }); const gate = hold(url => url.searchParams.get("offset") === "300", data(80, 300), error);
      try {
        await seed(page, 300); await page.evaluate(() => { window.__loadTask = __musicListFixture.more(); }); await requested(gate);
        await page.evaluate(() => __musicListFixture.route({ mode: "library", dashboard: "0", favorite: "1" }));
        const before = await page.locator(".music-mobile-list .music-mobile-track").count(); gate.release(); await page.evaluate(() => __loadTask);
        assert.equal(await page.locator(".music-mobile-list .music-mobile-track").count(), before); assert.equal(before, 80);
        assert.equal(await page.evaluate(() => __musicListFixture.state.loadingMore), false);
      } finally { gate.release(); await page.close(); }
    });
    await run("real load-more button double click starts only one page", async () => {
      const page = await newPage(), gate = hold(url => url.searchParams.get("offset") === "300", data(80, 300));
      try {
        await seed(page, 300); const before = requests.filter(key => new URL(key, base).searchParams.get("offset") === "300").length;
        await page.evaluate(() => { snapshot(); const more = document.querySelector(".music-mobile-load-more"); more.click(); more.click(); }); await requested(gate);
        gate.release(); await page.waitForFunction(() => !__musicListFixture.state.loadingMore);
        assert.equal(requests.filter(key => new URL(key, base).searchParams.get("offset") === "300").length - before, 1);
        assert.equal(await page.locator(".music-mobile-list .music-mobile-track").count(), 380); assert.equal(await page.evaluate(() => __row.isConnected && __mini.isConnected), true);
      } finally { gate.release(); await page.close(); }
    });
    await run("empty final library has no pagination request", async () => {
      const page = await newPage(); try {
        await page.evaluate(body => __musicListFixture.seed(body), data(0, 0, { hasMore: false, total: 0 }));
        const countTrackReads = () => requests.filter(key => new URL(key, base).pathname === "/api/music/tracks").length;
        const before = countTrackReads(); await page.evaluate(() => __musicListFixture.more());
        assert.equal(countTrackReads(), before); assert.equal(await page.locator(".music-mobile-load-more").count(), 0); assert.equal(await page.locator(".music-mobile-list .music-mobile-track").count(), 0);
      } finally { await page.close(); }
    });
    await run("same-ID metadata refresh and new-ID append remain unique", async () => {
      const page = await newPage(); const body = data(1, 300, { tracks: [track(1, { title: "Updated row", favorite: true }), track(301)], hasMore: false }); const gate = hold(url => url.searchParams.get("offset") === "300", body);
      try {
        await seed(page, 300); await page.evaluate(() => { __musicListFixture.state.current = __musicListFixture.state.data.tracks[0]; __musicListFixture.audio().paused = false; __musicListFixture.render(); snapshot(); window.__loadTask = __musicListFixture.more(); });
        await requested(gate); gate.release(); await page.evaluate(() => __loadTask);
        assert.equal(await page.locator('.music-mobile-list .music-mobile-track[data-track-id="T1"]').count(), 1); assert.equal(await page.locator(".music-mobile-list .music-mobile-track").count(), 301);
        assert.match(await page.locator('.music-mobile-list [data-track-id="T1"]').innerText(), /Updated row/); assert.equal(await page.evaluate(() => __musicListFixture.state.data.rawLoaded), 302);
        assert.equal(await page.locator('.music-mobile-list [data-track-id="T1"][data-current="true"]').count(), 1); assert.equal(await page.evaluate(() => __mini.isConnected), true);
        await page.evaluate(() => { __musicListFixture.render(); });
        assert.equal(await page.locator('.music-mobile-list [data-track-id="T1"]').count(), 1); assert.match(await page.locator('.music-mobile-list [data-track-id="T1"]').innerText(), /Updated row/);
        assert.deepEqual(await page.evaluate(() => ({ visible: __musicListFixture.state.data.tracks.length, queue: __musicListFixture.state.queue.length, unique: new Set(__musicListFixture.state.queue.map(track => track.id)).size, title: __musicListFixture.state.queue[0].title })), { visible: 301, queue: 301, unique: 301, title: "Updated row" });
        const next = hold(url => url.searchParams.get("offset") === "302", data(1, 301, { hasMore: false }));
        await page.evaluate(() => { __musicListFixture.state.hasMore = true; __musicListFixture.render(); window.__loadTask = __musicListFixture.more(); }); await requested(next); next.release(); await page.evaluate(() => __loadTask);
        assert.equal(await page.evaluate(() => __musicListFixture.state.data.rawLoaded), 303); assert.equal(await page.locator(".music-mobile-list .music-mobile-track").count(), 302);
      } finally { gate.release(); await page.close(); }
    });
    for (const count of [0, 80]) await run(`final page ${count} appended rows removes load-more`, async () => {
      const page = await newPage(); const gate = hold(url => url.searchParams.get("offset") === "300", data(count, 300, { hasMore: false }));
      try { await seed(page, 300); await page.evaluate(() => { snapshot(); window.__loadTask = __musicListFixture.more(); }); await requested(gate); gate.release(); await page.evaluate(() => __loadTask);
        assert.equal(await page.locator(".music-mobile-list .music-mobile-track").count(), 300 + count); assert.equal(await page.locator(".music-mobile-load-more").count(), 0); assert.equal(await page.evaluate(() => __row.isConnected && __mini.isConnected), true);
      } finally { gate.release(); await page.close(); }
    });
    await run("play/pause/current changes and newly mounted rows initialize playback marks", async () => {
      const page = await newPage(); try {
        await seed(page, 300); const result = await page.evaluate(() => {
          const f = __musicListFixture, audio = f.audio(); f.state.current = f.state.data.tracks[0]; audio.paused = false; audio.dispatchEvent(new Event("timeupdate"));
          const firstPlaying = document.querySelector('[data-track-id="T1"]').classList.contains("playing"); audio.pause();
          const paused = !document.querySelector('[data-track-id="T1"]').classList.contains("playing");
          f.state.current = f.state.data.tracks[1]; audio.paused = false; audio.dispatchEvent(new Event("timeupdate"));
          const switched = !document.querySelector('[data-track-id="T1"]').classList.contains("active") && document.querySelector('[data-track-id="T2"]').classList.contains("playing");
          f.render(); audio.dispatchEvent(new Event("timeupdate")); return { firstPlaying, paused, switched, fresh: document.querySelector('[data-track-id="T2"]').classList.contains("playing") };
        }); assert.deepEqual(result, { firstPlaying: true, paused: true, switched: true, fresh: true });
        const gate = hold(url => url.searchParams.get("offset") === "300", data(80, 300)); await page.evaluate(() => { window.__loadTask = __musicListFixture.more(); }); await requested(gate);
        await page.evaluate(() => { __musicListFixture.state.current = { id: "T301", title: "Synthetic Track 301", durationMs: 180000 }; __musicListFixture.audio().dispatchEvent(new Event("timeupdate")); }); gate.release(); await page.evaluate(() => __loadTask);
        assert.equal(await page.locator('.music-mobile-list [data-track-id="T301"].playing[data-current="true"]').count(), 1); assert.equal(await page.locator('.music-mobile-list [data-track-id="T2"].playing').count(), 0);
      } finally { await page.close(); }
    });
    await run("mounted search input/focus survives loading and collapsed result fallback", async () => {
      const page = await newPage(); const gate = hold(url => url.searchParams.get("offset") === "2", data(1, 2, { tracks: [track(3, { title: "Identical", artist: "One Artist" })], hasMore: false }));
      try {
        const body = data(2, 0, { tracks: [track(1, { title: "Identical", artist: "One Artist" }), track(2, { title: "Distinct", artist: "One Artist" })] });
        await page.evaluate(body => __musicListFixture.seed(body, { query: "Artist", searchOpen: true }), body);
        await page.locator(".music-mobile-search-input").focus(); await page.evaluate(() => { window.__searchInput = document.querySelector(".music-mobile-search-input"); window.__loadTask = __musicListFixture.more(); }); await requested(gate);
        assert.equal(await page.evaluate(() => __searchInput.isConnected && document.activeElement === __searchInput), true);
        gate.release(); await page.evaluate(() => __loadTask);
        assert.equal(await page.evaluate(() => __searchInput.isConnected && document.activeElement === __searchInput), true);
        assert.equal(await page.evaluate(() => __musicListFixture.state.data.tracks.length), 2); assert.equal(await page.evaluate(() => __musicListFixture.state.data.rawLoaded), 3);
        assert.equal(await page.locator(".music-mobile-list .music-mobile-track").count(), 2);
      } finally { gate.release(); await page.close(); }
    });
    await run("track pagination must not disable or relabel lyric pagination", async () => {
      const page = await newPage(), gate = hold(url => url.searchParams.get("offset") === "300", data(1, 300));
      try {
        await page.evaluate(body => __musicListFixture.seed(body, { query: "Synthetic", searchOpen: true, searchScope: "lyrics", lyricSearch: { matches: [{ track: body.tracks[0], timeMs: 1000, text: "Synthetic lyric" }], total: 20, hasMore: true, loading: false, loadingMore: false, error: "" } }), data(300));
        await page.evaluate(() => { window.__loadTask = __musicListFixture.more(); }); await requested(gate);
        const lyricMore = page.locator(".music-mobile-search-result-group-body > .music-mobile-load-more");
        assert.equal(await lyricMore.isDisabled(), false); assert.match(await lyricMore.innerText(), /已显示 1 首/);
        gate.release(); await page.evaluate(() => __loadTask); assert.equal(await lyricMore.isDisabled(), false); assert.match(await lyricMore.innerText(), /已显示 1 首/);
      } finally { gate.release(); await page.close(); }
    });
    await verifyCollectionDetailLayout();
    await verifyPlaylistDetailLayout();
    await verifyMusicSortFilterLayout();
    await verifyAsyncMusicControlFocus();
    await verifyMusicTrackRows();
    await verifyMusicTrackWrites();
    await verifyContainedRows();
    await verifyStartupCatalogue();
    await verifySearchOverviewOwnership();
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    console.log(`PASS Android music list rendering: ${checks} actual Chromium scenarios`);
  } else if (measureOnly) console.log("DIAGNOSTIC legacy rendering only; correctness assertions not run");
} finally {
  for (const gate of gates) gate.release();
  await browser?.close(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => alternateServer.close(resolve))]);
}

function json(res, body, status = 200) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); }
function hold(match, body = null, error = "") {
  let release, requestedResolve;
  const gate = { match, body, error, used: false, promise: new Promise(resolve => { release = resolve; }), requested: new Promise(resolve => { requestedResolve = resolve; }) };
  Object.assign(gate, { release, requestedResolve }); gates.add(gate); return gate;
}
async function requested(gate) { let timer; try { await Promise.race([gate.requested, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("fixture page request missing")), 5000); })]); } finally { clearTimeout(timer); } }
async function seed(page, count) { await page.evaluate(body => __musicListFixture.seed(body), data(count)); }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function bounded(promise, message = "track write fixture stage missing") {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 5000); })]); }
  finally { clearTimeout(timer); }
}
function createTrackWriteFixture() {
  const tracks = new Map(), writes = [], plans = [], reads = [];
  const key = (source, owner, id) => JSON.stringify([source, owner, id]);
  const get = (source, owner, id = "T1") => {
    const identity = key(source, owner, id);
    if (!tracks.has(identity)) tracks.set(identity, track(Number(id.slice(1)), {
      title: `${source === base ? "A" : "B"}-${owner}-歌曲${id}`, artist: `${owner} 合成歌手`,
      album: `${source === base ? "A" : "B"} 合成专辑`, favorite: false, rating: 0, positionMs: 12345
    }));
    return tracks.get(identity);
  };
  const fixture = {
    writes, get, lyrics: null, trackIds: ["T1", "T2"],
    patch(source, owner, patch, id = "T1") { Object.assign(get(source, owner, id), patch); },
    plan(field, { error = "" } = {}) {
      const accepted = deferred(), commit = deferred(), committed = deferred(), response = deferred(), completed = deferred();
      const plan = { field, error, accepted: accepted.promise, committed: committed.promise, completed: completed.promise,
        commit: () => commit.resolve(), respond: () => response.resolve(), release() { commit.resolve(); response.resolve(); } };
      Object.assign(plan, { accept: accepted.resolve, waitCommit: commit.promise, didCommit: committed.resolve,
        waitResponse: response.promise, finish: completed.resolve });
      plans.push(plan); return plan;
    },
    read(match) {
      const accepted = deferred(), response = deferred(), completed = deferred();
      const read = { match, accepted: accepted.promise, completed: completed.promise, release: response.resolve,
        accept: accepted.resolve, waitResponse: response.promise, finish: completed.resolve, used: false };
      reads.push(read); return read;
    },
    release() { for (const plan of plans) plan.release(); for (const read of reads) read.release(); },
    async handle(req, res, url) {
      const action = /^\/api\/music\/tracks\/(T\d+)\/(favorite|rating)$/.exec(url.pathname);
      const detail = /^\/api\/music\/tracks\/(T\d+)$/.exec(url.pathname);
      const list = url.pathname === "/api/music/tracks";
      if (!(action && req.method === "POST") && !(req.method === "GET" && (detail || list))) return false;
      const owner = String(req.headers["x-fanhao-account-owner"] || "guest"), source = url.origin;
      res.setHeader("X-FanHao-Account-Owner", owner);
      res.setHeader("Access-Control-Expose-Headers", "X-FanHao-Account-Owner");
      if (action) {
        let body = ""; for await (const chunk of req) body += chunk;
        const payload = JSON.parse(body), [id, field] = action.slice(1), plan = plans.find(item => !item.used && item.field === field);
        assert(plan, `unplanned synthetic ${field} POST`); plan.used = true;
        const record = { source, owner, id, field, method: req.method, body: payload, accepted: true, committed: false, responded: false, transportClosedEarly: false };
        plan.record = record; writes.push(record);
        res.once("close", () => { if (!record.responded) record.transportClosedEarly = true; });
        plan.accept(record);
        await plan.waitCommit;
        if (!plan.error) {
          get(source, owner, id)[field] = payload[field];
          record.committed = true; record.snapshot = structuredClone(get(source, owner, id));
        }
        plan.didCommit(record);
        await plan.waitResponse;
        record.responded = true;
        json(res, plan.error ? { error: plan.error } : { track: record.snapshot }, plan.error ? 503 : 200);
        plan.finish(record); return true;
      }
      const body = detail ? { track: structuredClone(get(source, owner, detail[1])), lyrics: structuredClone(fixture.lyrics || { lines: [], raw: "" }) }
        : data(fixture.trackIds.length, 0, { tracks: fixture.trackIds.map(id => structuredClone(get(source, owner, id))), total: fixture.trackIds.length, hasMore: false });
      const read = reads.find(item => !item.used && item.match(url, owner));
      if (read) { read.used = true; read.body = body; read.accept({ source, owner, body }); await read.waitResponse; }
      json(res, body); read?.finish(); return true;
    }
  };
  return fixture;
}
async function verifyMusicSearchComposition() {
  const open = async (options = {}) => {
    const page = await newPage(options);
    await page.evaluate(body => __musicListFixture.seed(body, { dashboard: false, mode: "library", query: "", searchOpen: true, searchScope: "songs" }), data(2));
    await page.locator(".music-mobile-search-input").focus();
    return page;
  };
  const searchRequests = start => requests.slice(start).map(value => new URL(value, base))
    .filter(url => ["/api/music/tracks", "/api/music/suggest"].includes(url.pathname) && url.searchParams.get("q"))
    .map(url => ({ path: url.pathname, query: url.searchParams.get("q") }));
  await run("composition: pending debounce and provisional pinyin create no search or suggestion request", async () => {
    const page = await open();
    try {
      const start = requests.length;
      await page.locator(".music-mobile-search-input").fill("pending");
      await page.evaluate(() => {
        const input = document.querySelector(".music-mobile-search-input");
        input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        input.value = "zhong";
        input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "zhong", isComposing: true }));
      });
      await page.waitForTimeout(380);
      assert.deepEqual(searchRequests(start), []);
      assert.equal(await page.evaluate(() => __musicListFixture.state.query), "");
      assert.equal(await page.locator(".music-mobile-search-input").inputValue(), "zhong");
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("music-mobile-search-input")), true);
    } finally { await page.close(); }
  });
  await run("composition: IME Enter arrows and Escape keep candidate input and history untouched", async () => {
    const page = await open();
    try {
      const result = await page.evaluate(() => {
        const input = document.querySelector(".music-mobile-search-input");
        input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); input.value = "中文";
        const outcomes = [];
        for (const key of ["Enter", "ArrowDown", "ArrowUp", "Escape"]) {
          const event = new KeyboardEvent("keydown", { key, isComposing: true, bubbles: true, cancelable: true });
          input.dispatchEvent(event); outcomes.push(event.defaultPrevented);
        }
        input.dispatchEvent(new Event("search", { bubbles: true }));
        return { outcomes, history: [...__musicListFixture.state.searchHistory], query: __musicListFixture.state.query, connected: input.isConnected };
      });
      assert.deepEqual(result, { outcomes: [false, false, false, false], history: [], query: "", connected: true });
      // Some engines report keyCode 229 after compositionend without isComposing.
      assert.equal(await page.evaluate(() => {
        __musicListFixture.render();
        const input = document.querySelector(".music-mobile-search-input"); input.value = "候选";
        const event = new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true });
        input.dispatchEvent(event);
        return event.defaultPrevented || __musicListFixture.state.query !== "";
      }), false);
    } finally { await page.close(); }
  });
  await run("composition: late pre-composition suggestions cannot reopen the candidate menu", async () => {
    const page = await open({ ignoreAbort: true });
    const old = hold(url => url.pathname === "/api/music/suggest" && url.searchParams.get("q") === "Old", { tracks: [], artists: [], albums: [] });
    try {
      await page.locator(".music-mobile-search-input").fill("Old"); await requested(old);
      await page.evaluate(() => {
        const input = document.querySelector(".music-mobile-search-input");
        input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); input.value = "zhong";
        input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true, data: "zhong" }));
      });
      const response = page.waitForResponse(value => new URL(value.url()).pathname === "/api/music/suggest");
      old.release(); await response; await frames(page);
      assert.deepEqual(await page.evaluate(() => ({ suggestions: __musicListFixture.state.searchSuggestions,
        loading: __musicListFixture.state.searchSuggestionLoading, index: __musicListFixture.state.searchSuggestionIndex,
        query: __musicListFixture.state.query })), { suggestions: [], loading: false, index: -1, query: "" });
      assert.equal(await page.locator(".music-mobile-search-input").inputValue(), "zhong");
    } finally { old.release(); await page.close(); }
  });
  await run("composition: committed characters search once and ordinary Enter still remembers the query", async () => {
    const page = await open();
    try {
      const start = requests.length;
      await page.evaluate(() => {
        const input = document.querySelector(".music-mobile-search-input"); window.__imeInput = input;
        input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        input.value = "中文";
        input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文" }));
        input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "中文", isComposing: false }));
      });
      await page.waitForFunction(() => __musicListFixture.state.query === "中文" && !__musicListFixture.state.loading);
      assert.equal(searchRequests(start).filter(value => value.path === "/api/music/tracks").length, 1);
      assert.equal(searchRequests(start).every(value => value.query === "中文"), true);
      assert.equal(await page.evaluate(() => __imeInput.isConnected && document.activeElement === __imeInput), true);
      await page.evaluate(() => {
        __musicListFixture.state.searchSuggestions = [];
        __imeInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      });
      assert.equal(await page.evaluate(() => __musicListFixture.state.searchHistory[0]), "中文");
    } finally { await page.close(); }
  });
  await run("composition: detached input and deactivated module cannot restart an old composition", async () => {
    for (const retire of ["rerender", "deactivate"]) {
      const page = await open();
      try {
        const start = requests.length;
        await page.evaluate(retire => {
          const input = document.querySelector(".music-mobile-search-input");
          input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); input.value = "旧查询";
          if (retire === "rerender") __musicListFixture.render(); else __musicListFixture.deactivate();
          input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "旧查询" }));
          input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "旧查询" }));
          input.dispatchEvent(new Event("search", { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        }, retire);
        await page.waitForTimeout(380);
        assert.deepEqual(searchRequests(start), []);
        assert.equal(await page.evaluate(() => __musicListFixture.state.query), "");
      } finally { await page.close(); }
    }
  });
}
async function newPage({ ignoreAbort = false, containment = true, width = 430, waitReady = true, params = null, routeNavigation = false, touch = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: touch }); page.on("pageerror", error => errors.push(error.message));
  if (!containment) await page.route("**/styles.css", route => route.fulfill({ contentType: "text/css", body: baselineStyles }));
  await page.addInitScript(({ ignoreAbort }) => {
    window.__shellCalls = []; window.__renderSamples = []; window.__phaseSamples = []; window.__audios = [];
    class AudioDouble extends EventTarget {
      constructor() { super(); this.src = ""; this.paused = true; this.currentTime = 0; this.duration = 180; this.readyState = 4; this.volume = .8; this.playbackRate = 1; __audios.push(this); }
      load() { this.currentTime = 0; this.paused = true; queueMicrotask(() => this.dispatchEvent(new Event("loadedmetadata"))); }
      play() { this.paused = false; this.dispatchEvent(new Event("play")); return Promise.resolve(); }
      pause() { this.paused = true; this.dispatchEvent(new Event("pause")); }
      removeAttribute(name) { if (name === "src") this.src = ""; }
      get currentSrc() { return this.src; }
    }
    window.Audio = AudioDouble; window.AudioContext = undefined; window.webkitAudioContext = undefined;
    // Bypass Chromium's in-flight same-URL HTTP cache lock in ignored-abort
    // scenarios, so a newer side request can settle before the old transport.
    const fetchImpl = window.fetch.bind(window); if (ignoreAbort) window.fetch = (url, options = {}) => fetchImpl(url, { ...options, signal: undefined, cache: "no-store" });
    let original = document.createElement.bind(document); window.__created = 0;
    document.createElement = (...args) => { __created++; return original(...args); };
    window.snapshot = () => {
      window.__row = document.querySelector(".music-mobile-list .music-mobile-track"); window.__mini = document.querySelector(".music-mobile-mini-player");
      window.__observerCount = 0; window.__observer = new MutationObserver(records => { __observerCount += records.length; }); __observer.observe(__row, { attributes: true }); __created = 0; __renderSamples.length = 0; __phaseSamples.length = 0;
    };
    window.identities = () => ({ rowConnected: __row.isConnected, miniConnected: __mini.isConnected, observerStillMounted: __row === document.querySelector(".music-mobile-list .music-mobile-track"), observedChanges: __observerCount });
  }, { ignoreAbort });
  const url = new URL(`${base}/probe`); if (params) url.searchParams.set("params", JSON.stringify(params));
  if (routeNavigation) url.searchParams.set("routeNavigation", "1");
  await page.goto(url.href, { waitUntil: waitReady ? "load" : "domcontentloaded" });
  await page.waitForFunction(waitReady ? () => Boolean(window.__ready) : () => Boolean(window.__startupTask)); return page;
}
function harness(url) {
  // Use the actual entry/cascade and shell classes: relinking module CSS after
  // home.css would override its 80px row geometry and invalidate layout evidence.
  return `<!doctype html><meta charset=utf-8><link rel=stylesheet href=/styles.css><body class=music-mobile-view><main class=app-shell><section id=contentPanel class=content-panel><div class=section-head><div><p id=viewKicker class=section-label></p><h2 id=viewTitle></h2></div></div><div id=viewMeta class=view-meta></div><div id=viewContent class=content-list aria-live=polite></div></section></main><script type=module>
import{createMusicViews}from'/modules/music/music-views.js';const els=Object.fromEntries(['viewKicker','viewTitle','viewMeta','viewContent'].map(id=>[id,document.getElementById(id)])),noop=()=>{};
window.__fixtureActiveUrl=location.origin;window.__fixtureAlternateUrl=${JSON.stringify(alternateBase)};
const page=createMusicViews({els,getActiveUrl:()=>__fixtureActiveUrl,setActiveBottom:noop,showView:${url.searchParams.get("routeNavigation") === "1" ? '(view,params)=>{if(view!=="music")throw new Error("Unexpected fixture route");window.__fixtureNavigation=window.__fixtureRoute(params);}' : "noop"},replaceViewParams:noop});
window.__fixtureView=page;let epoch=0,controller=null;
window.__fixtureRoute=params=>{++epoch;controller?.abort();controller=new AbortController();const owner=epoch,signal=controller.signal,guard=()=>owner===epoch&&!signal.aborted;guard.signal=signal;return page.renderMusicList(params,guard);};
window.__fixtureLeave=()=>{++epoch;controller?.abort();page.deactivate();};
window.__startupTask=__fixtureRoute(${JSON.stringify(JSON.parse(url.searchParams.get("params") || '{"mode":"library","dashboard":"0"}'))});await __startupTask;window.__ready=true;
</script>`;
}

async function frames(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function geometry(page) {
  return page.evaluate(selector => {
    const rows = [...document.querySelectorAll(selector)], first = rows[0], last = rows.at(-1), style = getComputedStyle(first);
    // The row's own box stays visible for layout/observers; its descendants are skipped.
    return { count: rows.length, first: first.getBoundingClientRect().height, last: last.getBoundingClientRect().height, bodyHeight: document.body.offsetHeight, contentVisibility: style.contentVisibility, intrinsic: style.containIntrinsicBlockSize, gap: getComputedStyle(first.parentElement).rowGap, skippedTail: !last.firstElementChild.checkVisibility({ contentVisibilityAuto: true }) };
  }, flatRows);
}
async function layoutSamples(page, body) {
  const samples = [];
  for (let repeat = 0; repeat < 5; repeat++) {
    await page.evaluate(() => { window.scrollTo(0, 0); void document.body.offsetHeight; });
    samples.push(await page.evaluate(body => {
      const start = performance.now(); __musicListFixture.seed(body); const rendered = performance.now();
      const height = document.body.offsetHeight, laidOut = performance.now();
      return { renderMs: rendered - start, layoutMs: laidOut - rendered, height };
    }, body));
    await frames(page);
  }
  return { renderMs: median(samples.map(sample => sample.renderMs)), layoutMs: median(samples.map(sample => sample.layoutMs)), height: samples.at(-1).height };
}
async function verifyCollectionDetailLayout() {
  for (const kind of ["artist", "album-no-art", "album-has-art"]) await run(`collection detail ${kind}: complete names and touch controls preserve playback on resize`, async () => {
    const page = await newPage({ width: 320 });
    const suffix = `TAIL_${kind}_9Z`;
    const title = "合成超长音乐名称用于确认手机详情能够显示完整内容".repeat(5)
      + "ContinuousLatinTitleWithoutSpaces".repeat(5) + suffix;
    const artist = kind === "artist", artwork = kind === "album-has-art" ? "/synthetic/cover/1.svg" : "";
    const body = data(2, 0, { total: 2, hasMore: false,
      tracks: [1, 2].map(index => track(index, { artist: artist ? title : "合成歌手", album: artist ? "合成专辑" : title, coverUrl: artwork })),
      artists: [{ id: "S", name: artist ? title : "合成歌手", language: "国语", albumCount: 1, trackCount: 2 }],
      albums: [{ id: "A", artistId: "S", artistName: "合成歌手", title: artist ? "合成专辑" : title, year: "2026", coverUrl: artwork, trackCount: 2 }]
    });
    const geometry = tail => page.evaluate(tail => {
      const hero = document.querySelector(".music-mobile-collection-detail"), title = hero.querySelector(".music-mobile-collection-identity strong");
      const text = title.firstChild, range = document.createRange();
      range.setStart(text, text.textContent.length - tail.length); range.setEnd(text, text.textContent.length);
      const box = title.getBoundingClientRect(), tailBoxes = [...range.getClientRects()], style = getComputedStyle(title);
      const controls = [...document.querySelectorAll(".music-mobile-collection-actions button, .music-mobile-collection-list-head button")];
      return {
        text: title.textContent, noArt: hero.classList.contains("no-art"),
        tailVisible: tailBoxes.length > 0 && tailBoxes.every(rect => rect.width > 0 && rect.height > 0
          && rect.left >= box.left - 3 && rect.right <= box.right + 3 && rect.top >= box.top - 3 && rect.bottom <= box.bottom + 3),
        controls: controls.map(button => { const rect = button.getBoundingClientRect(); return { label: button.textContent.trim(),
          touch: rect.width >= 44 && rect.height >= 44, inside: rect.left >= 0 && rect.right <= innerWidth }; }),
        overflow: document.documentElement.scrollWidth > innerWidth,
        // Tight line-height can leave visible glyph ink a couple of pixels beyond
        // the line box. Height overflow signals truncation only when it is clipped.
        titleClipped: title.scrollHeight > title.clientHeight + 1 && style.overflowY !== "visible",
        titleScrollHeight: title.scrollHeight, titleClientHeight: title.clientHeight,
        titleOverflowY: style.overflowY, titleHeight: box.height, lineHeight: Number.parseFloat(style.lineHeight),
        extraTitleActions: hero.querySelector(".music-mobile-collection-identity").querySelectorAll("button, a, summary").length,
        heroButtons: hero.querySelectorAll("button").length
      };
    }, tail);
    const playback = () => page.evaluate(() => ({
      sameAudio: __collectionAudio === __musicListFixture.audio(),
      sameMini: __collectionMini === document.querySelector(".music-mobile-mini-player") && __collectionMini.isConnected,
      sameQueue: __collectionQueue === __musicListFixture.state.queue,
      current: __musicListFixture.state.current?.id, time: __musicListFixture.audio().currentTime, paused: __musicListFixture.audio().paused
    }));
    try {
      await page.evaluate(({ body, artist }) => {
        const f = __musicListFixture;
        f.seed(body, { mode: "library", dashboard: false, query: "", searchOpen: false, artistId: "S", albumId: artist ? "" : "A",
          current: body.tracks[0], playing: true, loading: false, loadingMore: false });
        f.audio().paused = false; f.audio().currentTime = 57;
        window.__collectionAudio = f.audio(); window.__collectionMini = document.querySelector(".music-mobile-mini-player"); window.__collectionQueue = f.state.queue;
      }, { body, artist });
      await frames(page);
      for (const viewport of [{ width: 320, height: 568 }, { width: 568, height: 320 }]) {
        await page.setViewportSize(viewport); await frames(page);
        const actual = await geometry(suffix), context = `${kind} at ${viewport.width}px`;
        assert.equal(actual.text, title); assert.equal(actual.noArt, kind !== "album-has-art");
        assert.equal(actual.tailVisible, true, `${context}: the unique title suffix Range must fit inside its title box`);
        assert.equal(actual.titleClipped, false, `${context}: title text must not be clipped (${actual.titleScrollHeight}/${actual.titleClientHeight}, overflow ${actual.titleOverflowY})`);
        assert.deepEqual(actual.controls.map(control => control.label), ["播放全部", "随机播放", "定位"]);
        assert(actual.controls.every(control => control.touch && control.inside), `${context}: playback and locate controls need 44px touch boxes inside the viewport`);
        assert.equal(actual.overflow, false, `${context}: continuous Latin text must not widen the document`);
        assert.deepEqual(await playback(), { sameAudio: true, sameMini: true, sameQueue: true, current: "T1", time: 57, paused: false });
        await page.locator(".music-mobile-collection-list-head button").click(); await frames(page);
        await page.waitForFunction(() => document.querySelector('.music-mobile-list [data-track-id="T1"]').classList.contains("locating"));
        assert.deepEqual(await playback(), { sameAudio: true, sameMini: true, sameQueue: true, current: "T1", time: 57, paused: false });
      }
      await page.evaluate(() => {
        const f = __musicListFixture;
        f.state.data.artists[0].name = "短名"; f.state.data.albums[0].title = "短名";
        f.state.data.tracks.forEach(track => { track.artist = "短名"; track.album = "短名"; });
        f.render();
      });
      await page.setViewportSize({ width: 320, height: 568 }); await frames(page);
      const short = await geometry("短名");
      assert.equal(short.text, "短名"); assert.equal(short.tailVisible, true);
      assert.equal(short.titleClipped, false);
      assert(short.titleHeight <= short.lineHeight + 2, `${kind}: a short name should retain a single line`);
      assert.equal(short.extraTitleActions, 0); assert.equal(short.heroButtons, 3, "Short names need only Back and the existing two playback actions");
      assert.equal(short.overflow, false);
    } finally { await page.close(); }
  });
}

async function verifyPlaylistDetailLayout() {
  for (const kind of ["playlist", "empty", "smart"]) await run(`playlist detail ${kind}: full legal text and reachable controls retain the mounted player`, async () => {
    const page = await newPage({ width: 320 }), smart = kind === "smart", empty = kind === "empty";
    const titleTail = `TITLE_${kind}_9Z`, descriptionTail = `DESC_${kind}_7Q`;
    const title = smart
      ? "智能歌单长名称压力样本".repeat(12) + "ContinuousLatinSmartName".repeat(5) + titleTail
      : "合法自建歌单中文名称ContinuousLatinTitle".repeat(4).slice(0, 80 - titleTail.length) + titleTail;
    const description = smart ? "FLAC、WAV、ALAC 或 24bit/48kHz 以上音频。"
      : "合法歌单说明包含中文和ContinuousLatinDescription".repeat(12).slice(0, 300 - descriptionTail.length) + descriptionTail;
    if (!smart) { assert.equal(title.length, 80); assert.equal(description.length, 300); }
    const id = smart ? "hires" : "layout-playlist", metadata = { id, name: title, description, trackCount: empty ? 0 : 2 };
    const body = data(empty ? 0 : 2, 0, { total: empty ? 0 : 2, hasMore: false, [smart ? "smartPlaylist" : "playlist"]: metadata });
    const heroSelector = smart ? ".music-mobile-auto-hero" : ".music-mobile-playlist-hero";
    const identitySelector = smart ? ".music-mobile-auto-identity" : ".music-mobile-playlist-identity";
    const read = () => page.evaluate(({ heroSelector, identitySelector, titleTail, descriptionTail, smart }) => {
      const hero = document.querySelector(heroSelector), identity = hero.querySelector(identitySelector);
      const textGeometry = (node, tail) => {
        const text = node.firstChild, range = document.createRange(), box = node.getBoundingClientRect(), style = getComputedStyle(node);
        range.setStart(text, text.textContent.length - tail.length); range.setEnd(text, text.textContent.length);
        const rects = [...range.getClientRects()];
        return { text: node.textContent, tailVisible: rects.length > 0 && rects.every(rect => rect.width > 0 && rect.height > 0
          && rect.left >= box.left - 3 && rect.right <= box.right + 3 && rect.top >= box.top - 3 && rect.bottom <= box.bottom + 3),
          clipped: (node.scrollHeight > node.clientHeight + 1 && style.overflowY !== "visible")
            || (node.scrollWidth > node.clientWidth + 1 && style.overflowX !== "visible") };
      };
      const controls = [...document.querySelectorAll(`${heroSelector} button[aria-label='管理歌单'], .music-mobile-playlist-primary-actions button, .music-mobile-playlist-list-head button, .music-mobile-playlist-empty button`)];
      return {
        title: textGeometry(identity.querySelector("strong"), titleTail),
        description: smart ? null : textGeometry(identity.querySelector("em"), descriptionTail),
        controls: controls.map(button => { const box = button.getBoundingClientRect(); return { label: button.getAttribute("aria-label") || button.textContent.trim(),
          touch: box.width >= 44 && box.height >= 44, inside: box.left >= 0 && box.right <= innerWidth }; }),
        management: hero.querySelectorAll("button[aria-label='管理歌单']").length,
        overflow: document.documentElement.scrollWidth > innerWidth
      };
    }, { heroSelector, identitySelector, titleTail, descriptionTail, smart });
    const playback = () => page.evaluate(() => {
      const f = __musicListFixture, saved = __playlistLayout;
      return { hero: saved.hero.isConnected && saved.hero === document.querySelector(saved.selector),
        audio: saved.audio === f.audio(), mini: saved.mini.isConnected && saved.mini === document.querySelector(".music-mobile-mini-player"),
        queue: saved.queue === f.state.queue, current: f.state.current?.id, position: f.audio().currentTime, paused: f.audio().paused };
    });
    const expectedPlayback = { hero: true, audio: true, mini: true, queue: true, current: "T1", position: 37.5, paused: false };
    try {
      await page.evaluate(({ body, smart, id, heroSelector }) => {
        const f = __musicListFixture;
        f.seed(body, { mode: smart ? "smart" : "playlist", dashboard: false, smartId: smart ? id : "", playlistId: smart ? "" : id,
          artistId: "", albumId: "", query: "", searchOpen: false, loading: false, loadingMore: false,
          current: body.tracks[0] || { id: "T1", title: "正在播放的合成歌曲", durationMs: 180000 }, playing: true });
        f.audio().paused = false; f.audio().currentTime = 37.5;
        window.__playlistLayout = { selector: heroSelector, hero: document.querySelector(heroSelector), audio: f.audio(),
          mini: document.querySelector(".music-mobile-mini-player"), queue: f.state.queue };
      }, { body, smart, id, heroSelector });
      await frames(page);
      for (const viewport of [{ width: 320, height: 568 }, { width: 568, height: 320 }]) {
        await page.setViewportSize(viewport); await frames(page);
        const actual = await read(), context = `${kind} at ${viewport.width}px`;
        assert.equal(actual.title.text, title); assert.equal(actual.title.tailVisible, true, `${context}: the nonzero title suffix Range must remain inside the title`);
        assert.equal(actual.title.clipped, false, `${context}: title text must not be clipped`);
        if (!smart) {
          assert.equal(actual.description.text, description); assert.equal(actual.description.tailVisible, true, `${context}: all 300 description characters must remain visible`);
          assert.equal(actual.description.clipped, false);
        }
        assert.deepEqual(actual.controls.map(control => control.label), smart ? ["随机播放", "播放全部", "定位"]
          : empty ? ["管理歌单", "添加歌曲"] : ["管理歌单", "随机播放", "播放全部", "定位", "添加歌曲"]);
        assert(actual.controls.every(control => control.touch && control.inside), `${context}: every target needs 44px touch size without horizontal overflow`);
        assert.equal(actual.management, smart ? 0 : 1); assert.equal(actual.overflow, false);
        assert.deepEqual(await playback(), expectedPlayback);
        if (!smart) {
          const trigger = page.locator(heroSelector).getByRole("button", { name: "管理歌单", exact: true });
          assert.equal(await trigger.getAttribute("aria-haspopup"), "dialog");
          await trigger.click();
          const dialog = page.getByRole("dialog", { name: "管理歌单", exact: true });
          await dialog.waitFor(); assert.equal(await dialog.count(), 1);
          assert.deepEqual(await playback(), expectedPlayback);
          assert.deepEqual(await dialog.locator(".mobile-action-sheet-option").allTextContents(), ["编辑歌单", "删除歌单"]);
          for (const button of await dialog.locator(".mobile-action-sheet-option").all()) {
            assert.equal(await button.isVisible(), true);
            await button.scrollIntoViewIfNeeded();
            const target = await button.evaluate(button => {
              const box = button.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
              return { touch: box.width >= 44 && box.height >= 44,
                reachable: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight && (hit === button || button.contains(hit)),
                overflow: document.documentElement.scrollWidth > innerWidth };
            });
            assert.deepEqual(target, { touch: true, reachable: true, overflow: false }, `${context}: menu actions must be scrollable into an unobscured touch position`);
          }
          await dialog.getByRole("button", { name: "关闭管理歌单", exact: true }).click();
          assert.equal(await dialog.count(), 0);
          assert.equal(await trigger.evaluate(button => document.activeElement === button), true, `${context}: visible close restores the management trigger focus`);
          assert.deepEqual(await playback(), expectedPlayback);
        }
        if (!empty) {
          await page.locator(".music-mobile-playlist-list-head").getByRole("button", { name: "定位", exact: true }).click(); await frames(page);
          await page.waitForFunction(() => document.querySelector('.music-mobile-list [data-track-id="T1"]').classList.contains("locating"));
          assert.deepEqual(await playback(), expectedPlayback);
        }
      }
      if (smart) {
        await page.evaluate(() => { __musicListFixture.state.data.smartPlaylist.name = "无损与高解析"; __musicListFixture.render(); });
        await page.setViewportSize({ width: 320, height: 568 }); await frames(page);
        const normal = await page.locator(`${identitySelector} strong`).evaluate(title => ({ text: title.textContent,
          singleLine: title.getBoundingClientRect().height <= Number.parseFloat(getComputedStyle(title).lineHeight) + 2 }));
        assert.deepEqual(normal, { text: "无损与高解析", singleLine: true });
      }
    } finally { await page.close(); }
  });
}

async function verifyMusicSortFilterLayout() {
  const prepare = async (page, body = data(2, 0, { hasMore: false, total: 2 }), options = {}) => {
    await page.evaluate(({ body, options }) => {
      const f = __musicListFixture;
      f.seed(body, { mode: "library", dashboard: false, query: "", searchOpen: false, smartId: "", playlistId: "", artistId: "", albumId: "",
        language: "", genre: "", sort: "album", artistSort: "count", albumSort: "updated", libraryFiltersOpen: false, sortSheetOpen: false,
        current: body.tracks[0], playing: true, loading: false, loadingMore: false, ...options });
      f.audio().paused = false; f.audio().currentTime = 37.5;
      window.__controlPlayback = { audio: f.audio(), current: f.state.current, queue: f.state.queue,
        input: document.querySelector(".music-mobile-search-input") };
    }, { body, options });
    await frames(page);
  };
  const playback = (page, { queue = true, input = false } = {}) => page.evaluate(({ queue, input }) => {
    const f = __musicListFixture, saved = __controlPlayback;
    return { audio: f.audio() === saved.audio, current: f.state.current === saved.current, position: f.audio().currentTime, paused: f.audio().paused,
      ...(queue ? { queue: f.state.queue === saved.queue } : {}),
      ...(input ? { input: saved.input.isConnected && document.querySelector(".music-mobile-search-input") === saved.input } : {}) };
  }, { queue, input });
  const expected = { audio: true, current: true, position: 37.5, paused: false, queue: true };
  const target = async (locator, context) => {
    await locator.scrollIntoViewIfNeeded();
    assert.deepEqual(await locator.evaluate(node => {
      const box = node.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { touch: box.width >= 44 && box.height >= 44, inside: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
        hit: hit === node || node.contains(hit), overflow: document.documentElement.scrollWidth > innerWidth };
    }), { touch: true, inside: true, hit: true, overflow: false }, context);
  };
  await run("library sort rating: sticky completion/current choice and closing focus preserve playback", async () => {
    const page = await newPage({ routeNavigation: true });
    try {
      await prepare(page, undefined, { sort: "rating" });
      for (const viewport of [{ width: 320, height: 568 }, { width: 568, height: 320 }]) {
        await page.setViewportSize(viewport); await frames(page);
        for (const close of ["done", "backdrop", "current"]) {
          await page.locator(".music-mobile-focused-library-sort").click(); await frames(page);
          const sheet = page.getByRole("dialog", { name: "选择排序方式", exact: true });
          const active = sheet.locator(".music-mobile-library-sort-choice.active");
          assert.equal(await active.locator("strong").textContent(), "评分");
          assert.equal(await active.evaluate(node => document.activeElement === node), true);
          const geometry = () => sheet.evaluate(sheet => {
            const head = sheet.querySelector("header").getBoundingClientRect(), done = sheet.querySelector("header button"), box = done.getBoundingClientRect();
            const current = sheet.querySelector(".active").getBoundingClientRect(), bounds = sheet.getBoundingClientRect();
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            return { done: box.top >= 0 && box.bottom <= innerHeight && (hit === done || done.contains(hit)),
              current: current.top >= head.bottom - 1 && current.bottom <= bounds.bottom + 1,
              header: Math.abs(head.top - bounds.top) <= 1, overflow: document.documentElement.scrollWidth > innerWidth };
          });
          assert.deepEqual(await geometry(), { done: true, current: true, header: true, overflow: false });
          await sheet.evaluate(node => { node.scrollTop = node.scrollHeight; }); await frames(page);
          assert.deepEqual(await geometry(), { done: true, current: true, header: true, overflow: false });
          if (close === "done") await sheet.getByRole("button", { name: "完成", exact: true }).click();
          if (close === "backdrop") await page.locator(".music-mobile-library-sort-backdrop").click({ position: { x: 5, y: 5 } });
          if (close === "current") await active.click();
          await frames(page); assert.equal(await sheet.count(), 0);
          assert.equal(await page.locator(".music-mobile-focused-library-sort").evaluate(node => document.activeElement === node), true);
          assert.equal(await page.evaluate(() => __musicListFixture.state.sort), "rating");
          assert.deepEqual(await playback(page), expected);
        }
      }
    } finally { await page.close(); }
  });
  await run("library facets: wrapped labels, actual album/reset requests and closing focus retain playback", async () => {
    const page = await newPage({ routeNavigation: true });
    const artistName = "合成长歌手名称用于筛选完整显示".repeat(3) + "ContinuousLatinArtistTAIL_A";
    const albumName = "合成长专辑名称用于筛选完整显示".repeat(3) + "ContinuousLatinAlbumTAIL_B";
    const body = data(2, 0, { hasMore: false, total: 2,
      artists: [{ id: "S", name: artistName, trackCount: 2 }], albums: [{ id: "A", title: albumName, artistName, trackCount: 2 }],
      languages: [{ name: "国语", trackCount: 2 }, { name: "合成语种长名称", trackCount: 1 }], genres: [{ name: "合成风格", trackCount: 2 }] });
    try {
      for (const viewport of [{ width: 320, height: 568 }, { width: 568, height: 320 }]) {
        await page.setViewportSize(viewport); await prepare(page, body, { language: "国语", genre: "合成风格", sort: "rating" });
        await page.locator(".music-mobile-focused-library-filter").click(); await frames(page);
        const dialog = page.getByRole("dialog", { name: "筛选歌曲", exact: true });
        assert.equal(await dialog.getByRole("button", { name: "返回全部歌曲", exact: true }).evaluate(node => document.activeElement === node), true);
        for (const [facet, label, tail] of [["歌手", artistName, "TAIL_A"], ["专辑", albumName, "TAIL_B"]]) {
          const choice = dialog.locator(`[data-facet='${facet}']`).getByRole("button", { name: label, exact: true });
          await target(choice, `${viewport.width}px ${facet} option`);
          assert.equal(await choice.evaluate((node, tail) => {
            const range = document.createRange(), text = node.firstChild, box = node.getBoundingClientRect();
            range.setStart(text, text.textContent.length - tail.length); range.setEnd(text, text.textContent.length);
            return [...range.getClientRects()].some(rect => rect.width > 0 && rect.height > 0 && rect.left >= box.left - 1 && rect.right <= box.right + 1
              && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1) && node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1;
          }, tail), true, `${facet} labels must retain their real nonzero suffix geometry`);
        }
        assert.equal(await dialog.locator(".music-mobile-facet-scroll button").evaluateAll(buttons => buttons.every(node => {
          const box = node.getBoundingClientRect(); return box.width >= 44 && box.height >= 44 && box.left >= 0 && box.right <= innerWidth;
        })), true);
        const selected = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("album") === "A", body);
        try {
          await dialog.locator("[data-facet='专辑']").getByRole("button", { name: albumName, exact: true }).click();
          await requested(selected); selected.release(); await page.evaluate(() => __fixtureNavigation); await frames(page);
          const params = new URL(selected.url, base).searchParams;
          assert.equal(params.get("album"), "A"); assert.equal(params.get("language"), "国语"); assert.equal(params.get("genre"), "合成风格"); assert.equal(params.get("sort"), "rating");
          assert.deepEqual(await page.evaluate(() => { const s = __musicListFixture.state; return { album: s.albumId, language: s.language, genre: s.genre, sort: s.sort }; }),
            { album: "A", language: "国语", genre: "合成风格", sort: "rating" });
          assert.deepEqual(await playback(page, { queue: false }), { audio: true, current: true, position: 37.5, paused: false });
        } finally { selected.release(); }
        const reset = hold(url => url.pathname === "/api/music/tracks" && !["album", "artist", "language", "genre"].some(key => url.searchParams.has(key)), body);
        try {
          await dialog.getByRole("button", { name: "重置", exact: true }).click(); await requested(reset); reset.release();
          await page.evaluate(() => __fixtureNavigation); await frames(page);
          assert.deepEqual(await page.evaluate(() => { const s = __musicListFixture.state; return [s.artistId, s.albumId, s.language, s.genre, s.sort]; }), ["", "", "", "", "rating"]);
          await dialog.getByRole("button", { name: "返回全部歌曲", exact: true }).click(); await frames(page);
          assert.equal(await dialog.count(), 0);
          assert.equal(await page.locator(".music-mobile-focused-library-filter").evaluate(node => document.activeElement === node), true);
          assert.deepEqual(await playback(page, { queue: false }), { audio: true, current: true, position: 37.5, paused: false });
        } finally { reset.release(); }
      }
    } finally { await page.close(); }
  });
  for (const config of [
    { mode: "artists", name: "歌手排序", field: "artistSort", values: ["name", "count"], path: "/api/music/artists", query: "" },
    { mode: "albums", name: "专辑排序", field: "albumSort", values: ["year", "tracks"], path: "/api/music/albums", query: "" },
    { mode: "library", name: "音乐排序", field: "sort", values: ["rating", "title"], path: "/api/music/tracks", query: "Synthetic" }
  ]) await run(`native ${config.mode}${config.query ? " search" : ""} sort: 44px select dispatches its real request field`, async () => {
    const page = await newPage({ routeNavigation: true });
    try {
      await prepare(page, undefined, { mode: config.mode, query: config.query, searchOpen: Boolean(config.query), searchScope: config.query ? "songs" : config.mode });
      for (const [index, viewport] of [{ width: 320, height: 568 }, { width: 568, height: 320 }].entries()) {
        await page.setViewportSize(viewport); await frames(page);
        const select = page.getByRole("combobox", { name: config.name, exact: true }), value = config.values[index];
        await target(select, `${config.name} closed native select at ${viewport.width}px`);
        const request = hold(url => url.pathname === config.path && url.searchParams.get("sort") === value, data(2, 0, { hasMore: false, total: 2 }));
        try {
          await select.selectOption(value); await requested(request); request.release(); await page.evaluate(() => __fixtureNavigation); await frames(page);
          assert.equal(new URL(request.url, base).searchParams.get("sort"), value);
          if (config.query) assert.equal(new URL(request.url, base).searchParams.get("q"), config.query);
          assert.equal(await page.evaluate(field => __musicListFixture.state[field], config.field), value);
          assert.equal(await page.evaluate(() => __musicListFixture.state.query), config.query);
          assert.deepEqual(await playback(page), expected);
        } finally { request.release(); }
      }
    } finally { await page.close(); }
  });
  await run("search filter details: native keyboard/mouse disclosure and one real filter request preserve search playback", async () => {
    const page = await newPage({ routeNavigation: true });
    try {
      await prepare(page, undefined, { query: "Synthetic", searchOpen: true, searchScope: "songs" });
      for (const viewport of [{ width: 320, height: 568 }, { width: 568, height: 320 }]) {
        await page.setViewportSize(viewport); await frames(page);
        const details = page.locator(".music-mobile-search-filter-menu"), summary = details.locator("summary");
        await target(summary, `native search filter summary at ${viewport.width}px`);
        await summary.focus(); await page.keyboard.press("Enter"); assert.equal(await details.getAttribute("open"), "");
        assert.deepEqual(await details.locator("button").allTextContents(), ["全部", "已收藏", "有歌词", "4 分以上", "无损"]);
        for (const button of await details.locator("button").all()) await target(button, `native search filter choice at ${viewport.width}px`);
        await summary.focus(); await page.keyboard.press("Space"); assert.equal(await details.getAttribute("open"), null);
        assert.equal(await summary.evaluate(node => document.activeElement === node), true);
        await summary.click(); assert.equal(await details.getAttribute("open"), "");
        await summary.click(); assert.equal(await details.getAttribute("open"), null);
        assert.deepEqual(await playback(page, { input: true }), { ...expected, input: true });
      }
      const start = requests.length, filtered = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("favorite") === "1", data(1, 0, { hasMore: false, total: 1 }));
      try {
        await page.locator(".music-mobile-search-filter-menu summary").click();
        await page.locator(".music-mobile-search-filter-menu").getByRole("button", { name: "已收藏", exact: true }).click();
        await requested(filtered); filtered.release();
        await page.waitForFunction(() => !__musicListFixture.state.loading && __musicListFixture.state.searchFavorite && __musicListFixture.state.data.tracks.length === 1);
        assert.equal(new URL(filtered.url, base).searchParams.get("q"), "Synthetic");
        assert.equal(requests.slice(start).filter(key => new URL(key, base).pathname === "/api/music/tracks").length, 1);
        assert.equal(await page.evaluate(() => __musicListFixture.state.query), "Synthetic");
        assert.deepEqual(await playback(page, { input: true }), { ...expected, input: true });
      } finally { filtered.release(); }
    } finally { await page.close(); }
  });
}

async function verifyAsyncMusicControlFocus() {
  const entries = [
    { id: "sort", mode: "library", query: "", path: "/api/music/tracks", value: "title", field: "sort", focus: ".music-mobile-focused-library-sort" },
    { id: "artists", mode: "artists", query: "", path: "/api/music/artists", value: "name", field: "artistSort", name: "歌手排序" },
    { id: "albums", mode: "albums", query: "", path: "/api/music/albums", value: "year", field: "albumSort", name: "专辑排序" },
    { id: "search-sort", mode: "library", query: "Synthetic", path: "/api/music/tracks", value: "title", field: "sort", name: "音乐排序" },
    { id: "quickfilter", mode: "library", query: "Synthetic", path: "/api/music/tracks", focus: ".music-mobile-search-filter-menu > summary" }
  ];
  const focusTarget = (page, entry) => entry.name ? page.getByRole("combobox", { name: entry.name, exact: true }) : page.locator(entry.focus);
  const setup = async (entry, { account = false, body = data(2, 0, { hasMore: false, total: 2 }) } = {}) => {
    const page = await newPage({ routeNavigation: true, ignoreAbort: true, width: 390 });
    if (account) await page.evaluate(async () => { const { setAccountOwner } = await import("/js/account-owner.js"); setAccountOwner(location.origin, "account:focusA"); });
    await page.evaluate(({ body, entry }) => {
      const f = __musicListFixture;
      window.__captureFocusRequests = true;
      window.__focusOwnerConfirmations = 0;
      window.addEventListener("fanhaoAccountOwnerConfirmed", event => {
        if (event.detail?.origin === location.origin) window.__focusOwnerConfirmations++;
      });
      f.seed(body, { mode: entry.mode, dashboard: false, query: entry.query, searchScope: entry.query ? "songs" : entry.mode,
        searchOpen: Boolean(entry.query), sort: "album", artistSort: "count", albumSort: "updated", favorite: false,
        searchFavorite: false, searchLyrics: false, searchMinRating: 0, searchQuality: "", artistId: "", albumId: "", genre: "", language: "",
        smartId: "", playlistId: "", libraryFiltersOpen: false, sortSheetOpen: false, current: body.tracks[0], playing: true, loading: false, loadingMore: false });
      f.audio().paused = false; f.audio().currentTime = 37.5;
      window.__asyncFocusSaved = { audio: f.audio(), current: f.state.current, queue: f.state.queue, input: document.querySelector(".music-mobile-search-input") };
      // Persistent host controls model a user's destination outside the routed module.
      const host = document.createElement("div"), away = document.createElement("button"), input = document.createElement("input");
      host.id = "focus-host"; away.id = "focus-away"; away.type = "button"; away.textContent = "另一个宿主操作";
      input.id = "focus-host-input"; input.setAttribute("aria-label", "宿主输入框"); host.append(away, input); document.body.prepend(host);
    }, { body, entry });
    await frames(page);
    return page;
  };
  const begin = async (page, entry, error = "", body = data(2, 0, { hasMore: false, total: 2 })) => {
    const gate = hold(url => url.origin === base && url.pathname === entry.path
      && (entry.id === "quickfilter" ? url.searchParams.get("favorite") === "1" && !url.searchParams.has("sort")
        : url.searchParams.get("sort") === entry.value), body, error);
    const trigger = focusTarget(page, entry); await trigger.evaluate(node => { window.__oldFocusControl = node; });
    if (entry.id === "sort") {
      await trigger.click();
      await page.getByRole("dialog", { name: "选择排序方式", exact: true }).getByRole("button", { name: "歌名", exact: true }).click();
    } else if (entry.id === "quickfilter") {
      await trigger.click();
      await page.locator(".music-mobile-search-filter-menu").getByRole("button", { name: "已收藏", exact: true }).click();
    } else {
      await trigger.focus(); await trigger.selectOption(entry.value);
    }
    await requested(gate);
    await page.evaluate(kind => { window.__pendingFocusTask = kind === "quickfilter" ? window.__fixtureFilterTask : window.__fixtureNavigation; }, entry.id);
    return gate;
  };
  const finish = async (page, gate, key = "__pendingFocusTask") => {
    gate.release(); await page.evaluate(key => window[key], key); await frames(page);
  };
  const assertPlayback = async (page, entry) => {
    assert.deepEqual(await page.evaluate(({ input, queue }) => {
      const f = __musicListFixture, saved = __asyncFocusSaved;
      return { audio: f.audio() === saved.audio, current: f.state.current === saved.current, position: f.audio().currentTime, paused: f.audio().paused,
        ...(queue ? { queue: f.state.queue === saved.queue } : {}),
        ...(input ? { input: saved.input.isConnected && document.querySelector(".music-mobile-search-input") === saved.input } : {}) };
    }, { input: entry.id === "quickfilter", queue: entry.id !== "sort" }),
    { audio: true, current: true, position: 37.5, paused: false, ...(entry.id !== "sort" ? { queue: true } : {}), ...(entry.id === "quickfilter" ? { input: true } : {}) });
  };
  for (const entry of entries) for (const failure of [false, true]) await run(`async control ${entry.id}: ${failure ? "failure" : "success"} focuses the replacement trigger`, async () => {
    const page = await setup(entry); let gate;
    try {
      gate = await begin(page, entry, failure ? "controlled focus error" : "");
      await finish(page, gate);
      assert.equal(await page.evaluate(() => __oldFocusControl.isConnected), false, "the assertion must observe a replacement after the real request/render path");
      assert.equal(await focusTarget(page, entry).evaluate(node => document.activeElement === node), true);
      if (!failure) assert(await page.evaluate(() => __focusOwnerConfirmations > 0), "successful focus recovery must survive real same-owner API confirmation events");
      assert.equal(await page.evaluate(() => __musicListFixture.state.query), entry.query);
      if (entry.id === "quickfilter") assert.equal(await page.evaluate(() => __musicListFixture.state.searchFavorite), true);
      else assert.equal(await page.evaluate(field => __musicListFixture.state[field], entry.field), entry.value);
      if (failure) assert.match(await page.evaluate(() => __musicListFixture.state.status), /controlled focus error/);
      await assertPlayback(page, entry);
    } finally { gate?.release(); await page.close(); }
  });
  for (const failure of [false, true]) await run(`async control comprehensive clear: ${failure ? "failure" : "success"} returns focus to the retained input`, async () => {
    const entry = { ...entries.find(entry => entry.id === "quickfilter"), query: "合成" };
    const body = data(3, 0, { hasMore: false, total: 3,
      tracks: [1, 2, 3].map(index => track(index, { title: `合成歌曲${index}`, favorite: index === 1 })) });
    const page = await setup(entry, { body }); let favorite, clear;
    try {
      favorite = await begin(page, entry, "", { ...body, tracks: [body.tracks[0]], total: 1 });
      await finish(page, favorite);
      assert.equal(await page.evaluate(() => __musicListFixture.state.searchFavorite), true);
      assert(await page.evaluate(() => __focusOwnerConfirmations > 0), "the prerequisite favorite request must use real owner confirmation");
      await page.locator(".music-mobile-search-scopes").getByRole("button", { name: "综合", exact: true }).click();
      await page.waitForFunction(() => __musicListFixture.state.searchScope === "all" && !__musicListFixture.state.lyricSearch.loading);
      const notice = page.locator(".music-mobile-search-filter-notice");
      assert.equal(await notice.locator("span").textContent(), "歌曲筛选：已收藏");
      assert.equal(await page.locator(".music-mobile-search-filter-menu").count(), 0, "comprehensive search has no song-menu summary to receive focus");
      await page.evaluate(() => { window.__focusOwnerConfirmations = 0; });
      clear = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "合成" && !url.searchParams.has("favorite"), body,
        failure ? "controlled comprehensive clear error" : "");
      const trigger = notice.getByRole("button", { name: "清除歌曲筛选", exact: true });
      await trigger.evaluate(node => { window.__clearFocusOrigin = node; });
      await trigger.focus(); await page.keyboard.press("Enter"); await requested(clear);
      await page.evaluate(() => { window.__pendingFocusTask = __fixtureFilterTask; });
      await finish(page, clear);
      const params = new URL(clear.url, base).searchParams;
      assert.equal(params.get("q"), "合成");
      for (const key of ["favorite", "lyrics", "minRating", "quality"]) assert.equal(params.has(key), false);
      assert.deepEqual(await page.evaluate(() => { const s = __musicListFixture.state; return {
        query: s.query, scope: s.searchScope, filters: [s.searchFavorite, s.searchLyrics, s.searchMinRating, s.searchQuality],
        oldConnected: __clearFocusOrigin.isConnected
      }; }), { query: "合成", scope: "all", filters: [false, false, 0, ""], oldConnected: false });
      assert.deepEqual(await page.locator(".music-mobile-search-input").evaluate(node => ({
        same: node === __asyncFocusSaved.input, focused: document.activeElement === node, value: node.value
      })), { same: true, focused: true, value: "合成" });
      assert.equal(await notice.count(), 0);
      if (failure) assert.match(await page.evaluate(() => __musicListFixture.state.status), /controlled comprehensive clear error/);
      else assert(await page.evaluate(() => __focusOwnerConfirmations > 0), "clear focus recovery must survive its real same-owner confirmation events");
      await assertPlayback(page, entry);
    } finally { favorite?.release(); clear?.release(); await page.close(); }
  });
  for (const intent of ["click", "tab then body", "search input"]) await run(`async control user ${intent}: a pending reply cannot reclaim focus`, async () => {
    const entry = entries.find(entry => entry.id === (intent === "click" ? "sort" : intent === "search input" ? "quickfilter" : "artists"));
    const page = await setup(entry); let gate;
    try {
      gate = await begin(page, entry);
      if (intent === "click") await page.locator("#focus-away").click();
      if (intent === "tab then body") {
        await page.locator("#focus-away").focus(); await page.keyboard.press("Tab");
        assert.equal(await page.evaluate(() => document.activeElement.id), "focus-host-input");
        await page.evaluate(() => document.activeElement.blur());
        assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
      }
      if (intent === "search input") {
        const input = page.locator(".music-mobile-search-input");
        await input.click(); await input.fill("Synthetic 正在编辑的输入");
        await input.evaluate(node => node.setSelectionRange(3, 8, "backward"));
      }
      await finish(page, gate);
      if (intent === "click") assert.equal(await page.evaluate(() => document.activeElement.id), "focus-away");
      if (intent === "tab then body") assert.equal(await page.evaluate(() => document.activeElement === document.body), true, "body after an intentional Tab/blur does not restore the old intent");
      if (intent === "search input") assert.deepEqual(await page.locator(".music-mobile-search-input").evaluate(node => ({
        same: node === __asyncFocusSaved.input, focused: node === document.activeElement, value: node.value,
        start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection
      })), { same: true, focused: true, value: "Synthetic 正在编辑的输入", start: 3, end: 8, direction: "backward" });
      await assertPlayback(page, entry);
    } finally { gate?.release(); await page.close(); }
  });
  for (const failure of [false, true]) await run(`async control newer sort wins before old filter ${failure ? "failure" : "success"}`, async () => {
    const oldEntry = entries.find(entry => entry.id === "quickfilter"), nextEntry = entries.find(entry => entry.id === "search-sort");
    const page = await setup(oldEntry); let old, latest;
    try {
      old = await begin(page, oldEntry, failure ? "obsolete focus error" : "");
      await page.evaluate(() => { window.__oldFilterFocusTask = __pendingFocusTask; });
      latest = await begin(page, nextEntry);
      await finish(page, latest);
      assert.equal(await focusTarget(page, nextEntry).evaluate(node => document.activeElement === node), true);
      await finish(page, old, "__oldFilterFocusTask");
      assert.equal(await focusTarget(page, nextEntry).evaluate(node => document.activeElement === node), true, "the retired summary must not steal the newer select's focus");
      assert.equal(await page.evaluate(() => __musicListFixture.state.sort), "title");
      await assertPlayback(page, nextEntry);
    } finally { old?.release(); latest?.release(); await page.close(); }
  });
  for (const retirement of ["source", "account round trip", "leave"]) await run(`async control ${retirement}: retired replies cannot focus the old route`, async () => {
    const entry = entries.find(entry => entry.id === (retirement === "source" ? "sort" : retirement === "leave" ? "albums" : "quickfilter"));
    const page = await setup(entry, { account: retirement === "account round trip" }); let gate;
    try {
      gate = await begin(page, entry);
      await page.evaluate(() => document.activeElement?.blur());
      if (retirement === "source") await page.evaluate(() => { __fixtureActiveUrl = __fixtureAlternateUrl; });
      if (retirement === "leave") await page.evaluate(() => __fixtureLeave());
      if (retirement === "account round trip") {
        assert.equal(await page.evaluate(async () => {
          const { captureAccountOwner, setAccountOwner } = await import("/js/account-owner.js"), old = captureAccountOwner(location.origin);
          setAccountOwner(location.origin, "account:focusB"); setAccountOwner(location.origin, "account:focusA");
          const next = captureAccountOwner(location.origin); return old.owner === next.owner && next.revision > old.revision;
        }), true);
      }
      await finish(page, gate);
      assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
      assert.deepEqual(await page.evaluate(() => ({ audio: __musicListFixture.audio() === __asyncFocusSaved.audio,
        current: __musicListFixture.state.current === __asyncFocusSaved.current, position: __musicListFixture.audio().currentTime })),
      { audio: true, current: true, position: 37.5 });
    } finally { gate?.release(); await page.close(); }
  });
}

async function verifyMusicTrackWrites() {
  const owner = "account:writeA";
  const setup = async ({ ignoreAbort = false, lyrics = false, tracks = 2, width = 390, touch = false, metadata = null } = {}) => {
    const fixture = createTrackWriteFixture(); trackWriteFixture = fixture;
    fixture.trackIds = Array.from({ length: tracks }, (_, index) => `T${index + 1}`);
    if (metadata) fixture.patch(base, owner, metadata);
    if (lyrics) fixture.lyrics = { lines: [{ timeMs: 0, text: "合成歌词第一行" }, { timeMs: 30000, text: "合成歌词第二行" }], raw: "[00:00]合成歌词第一行\n[00:30]合成歌词第二行" };
    const page = await newPage({ routeNavigation: true, ignoreAbort, width, touch });
    await page.evaluate(async ({ sourceA, sourceB, owner }) => {
      const { setAccountOwner } = await import("/js/account-owner.js");
      setAccountOwner(sourceA, owner); setAccountOwner(sourceB, owner);
      window.__trackWriteTasks = []; window.__captureTrackWrites = true; window.__writeConfirmations = 0;
      window.addEventListener("fanhaoAccountOwnerConfirmed", () => { __writeConfirmations++; });
      await __fixtureRoute({ mode: "library", dashboard: "0" });
      __musicListFixture.state.resumeQueue = true;
    }, { sourceA: base, sourceB: alternateBase, owner });
    await page.locator('.music-mobile-track[data-track-id="T1"] .music-mobile-track-text').click();
    await page.waitForFunction(() => __musicListFixture.state.current?.id === "T1" && !__musicListFixture.state.loading && !__musicListFixture.audio().paused);
    await page.evaluate(() => {
      const f = __musicListFixture; f.audio().currentTime = 37.5;
      window.__writePlayback = { audio: f.audio(), id: f.state.current.id, title: f.state.current.title, positionMs: f.state.current.positionMs };
      window.__writeConfirmations = 0;
    });
    const playReads = [];
    page.on("request", request => { if (request.method() === "GET" && /^\/api\/music\/tracks\/T\d+$/.test(new URL(request.url()).pathname)) playReads.push(request.url()); });
    return { page, fixture, playReads };
  };
  const drain = async page => {
    await page.evaluate(async () => { let count = 0; while (count < __trackWriteTasks.length) { const batch = __trackWriteTasks.slice(count); count += batch.length; await Promise.all(batch); } });
    await frames(page);
  };
  const finish = async (page, plan, { all = true } = {}) => {
    plan.commit(); await bounded(plan.committed);
    assert.equal(plan.record.transportClosedEarly, false, "an accepted synthetic POST must retain its response transport");
    plan.respond(); await bounded(plan.completed);
    if (all) await bounded(drain(page), "real track write task did not settle"); else await frames(page);
    assert.equal(plan.record.transportClosedEarly, false, "route and account changes cannot abort an already accepted POST");
  };
  const cleanup = async ({ page, fixture }) => {
    fixture.release();
    try { await bounded(drain(page), "track write cleanup did not settle"); }
    finally { await page.close(); trackWriteFixture = null; }
  };
  const surface = async page => {
    await page.evaluate(() => {
      const f = __musicListFixture;
      f.state.fullscreen = false; f.state.playbackSheetOpen = false;
      f.state.trackActionId = ""; f.state.queueOpen = false; f.render();
    });
  };
  const openSettings = async (page, { panel = null, keyboard = false } = {}) => {
    if (!(await page.locator(".music-mobile-full-player").count())) await page.locator(".music-mobile-mini-text").click();
    const sheet = page.getByRole("dialog", { name: "播放设置", exact: true });
    if (panel) await page.getByRole("button", { name: `切换到${panel === "lyrics" ? "歌词" : "封面"}`, exact: true }).click();
    if (!(await sheet.count())) {
      const trigger = page.locator(".music-mobile-full-settings");
      if (keyboard) { await trigger.focus(); await page.keyboard.press("Enter"); } else await trigger.click();
    }
    await sheet.waitFor({ state: "visible" }); await frames(page); return sheet;
  };
  const favorite = async (page, kind = "row") => {
    await surface(page);
    if (kind === "player") await page.locator(".music-mobile-mini-text").click();
    if (kind === "more") {
      await page.locator('.music-mobile-track[data-track-id="T1"] .track-more').click();
      await page.locator(".music-mobile-track-actions-sheet").getByRole("button", { name: /^(收藏歌曲|取消收藏)$/ }).click();
    } else await page.locator(kind === "player" ? ".music-mobile-full-quick-actions .favorite" : '.music-mobile-track[data-track-id="T1"] .track-favorite').click();
  };
  const rating = async (page, value = 5) => {
    await openSettings(page);
    await page.locator(".music-mobile-rating").getByRole("button", { name: `设为 ${value} 星`, exact: true }).click();
  };
  const snapshot = page => page.evaluate(() => {
    const f = __musicListFixture, pick = item => item && ({ id: item.id, title: item.title, positionMs: item.positionMs, favorite: Boolean(item.favorite), rating: Number(item.rating || 0) });
    return { current: pick(f.state.current), list: f.state.data.tracks.map(pick), queue: f.state.queue.map(pick), status: f.state.status,
      last: JSON.parse(localStorage.getItem("fanhao.android.music.lastTrack") || "null"),
      savedQueue: JSON.parse(localStorage.getItem("fanhao.android.music.playbackQueue") || "null"),
      playbackSource: f.playbackSource(), activeSource: __fixtureActiveUrl };
  });
  const assertPlayback = async ({ page, playReads }, { extraReads = 0 } = {}) => {
    assert.deepEqual(await page.evaluate(() => {
      const f = __musicListFixture, saved = __writePlayback;
      return { audio: f.audio() === saved.audio, id: f.state.current.id === saved.id, title: f.state.current.title === saved.title,
        positionMs: f.state.current.positionMs === saved.positionMs, time: f.audio().currentTime, paused: f.audio().paused };
    }), { audio: true, id: true, title: true, positionMs: true, time: 37.5, paused: false });
    assert.equal(playReads.length, extraReads, "writes and their child buttons must not issue playback GETs");
  };
  const assertFields = async (page, { favorite = false, rating = 0, listFavorite = favorite, listRating = rating,
    queueFavorite = listFavorite, queueRating = listRating, savedFavorite = favorite, savedRating = rating } = {}) => {
    const result = await snapshot(page);
    assert.deepEqual([result.current.favorite, result.current.rating], [favorite, rating]);
    const listed = result.list.find(item => item.id === "T1"), queued = result.queue.find(item => item.id === "T1");
    if (listed) assert.deepEqual([listed.favorite, listed.rating], [listFavorite, listRating]);
    if (queued) assert.deepEqual([queued.favorite, queued.rating], [queueFavorite, queueRating]);
    assert.equal(result.last.activeUrl, result.playbackSource, "last-track storage belongs to playback source, including while browsing another source");
    assert.deepEqual([result.last.track.favorite, result.last.track.rating], [favorite, rating]);
    assert.equal(result.savedQueue.activeUrl, result.playbackSource);
    const saved = result.savedQueue.queue.find(item => item.id === "T1");
    assert.deepEqual([saved.favorite, saved.rating], [savedFavorite, savedRating]);
    const row = page.locator('.music-mobile-track[data-track-id="T1"]');
    if (await row.count()) {
      assert.equal(await row.locator(".track-favorite").getAttribute("aria-label"), listFavorite ? "取消收藏" : "收藏");
      const meta = await row.locator(".music-mobile-track-text > small").textContent();
      if (listRating) assert(meta.includes("★".repeat(listRating) + "☆".repeat(5 - listRating)));
    }
    const stars = page.locator(".music-mobile-rating");
    if (await stars.count()) assert.equal(await stars.getAttribute("aria-label"), `评分：${rating || "未评分"}`);
  };
  const browse = async (page, source, params = {}) => {
    await page.evaluate(async ({ source, params }) => {
      __fixtureActiveUrl = source;
      __musicListFixture.state.fullscreen = false; __musicListFixture.state.playbackSheetOpen = false;
      await __fixtureRoute({ mode: "library", dashboard: "0", ...params });
    }, { source, params });
    await frames(page);
  };
  for (const field of ["favorite", "rating"]) await run(`track writes: current ${field} failure remains retryable and success persists`, async () => {
    const context = await setup(), { page, fixture } = context;
    try {
      const failed = fixture.plan(field, { error: `controlled ${field} error` });
      await (field === "favorite" ? favorite(page) : rating(page)); const accepted = await bounded(failed.accepted);
      assert.equal(accepted.method, "POST"); assert.equal(accepted.owner, owner);
      assert.deepEqual(accepted.body, { [field]: field === "favorite" ? true : 5 });
      await finish(page, failed); assert.equal(accepted.committed, false);
      await assertFields(page); assert.match((await snapshot(page)).status, new RegExp(`controlled ${field} error`));
      const alert = page.getByRole("alert");
      assert.equal(await alert.isVisible(), true); assert.match(await alert.textContent(), /未能确认.*可重试/);
      const retry = fixture.plan(field);
      await (field === "favorite" ? favorite(page) : rating(page)); await bounded(retry.accepted);
      assert.deepEqual(retry.record.body, accepted.body, "retry sends the desired value rather than flipping a failed favorite intent");
      await finish(page, retry);
      await assertFields(page, field === "favorite" ? { favorite: true } : { rating: 5 });
      assert.doesNotMatch((await snapshot(page)).status, new RegExp(`controlled ${field} error`));
      assert.equal(await alert.count(), 0);
      assert.equal(fixture.get(base, owner)[field], field === "favorite" ? true : 5);
      assert(await page.evaluate(() => __writeConfirmations > 0), "real same-owner response confirmation must not retire a normal write");
      await assertPlayback(context);
    } finally { await cleanup(context); }
  });
  for (const field of ["favorite", "rating"]) await run(`track writes: ${field} lane sends one inflight and only the latest desired intent`, async () => {
    const context = await setup(), { page, fixture } = context;
    try {
      const first = fixture.plan(field), latest = fixture.plan(field);
      await (field === "favorite" ? favorite(page) : rating(page, 2)); await bounded(first.accepted);
      await (field === "favorite" ? favorite(page) : rating(page, 3));
      if (field === "rating") await rating(page, 5);
      await frames(page); assert.equal(fixture.writes.length, 1, "pending same-field intents must not start a parallel POST");
      const pendingValue = (await snapshot(page)).current[field];
      await finish(page, first, { all: false }); await bounded(latest.accepted);
      assert.equal((await snapshot(page)).current[field], pendingValue, "an interim confirmation must not cover the newer pending intent");
      assert.deepEqual(latest.record.body, { [field]: field === "favorite" ? false : 5 });
      await finish(page, latest);
      await assertFields(page, field === "favorite" ? {} : { rating: 5 });
      assert.equal(fixture.get(base, owner)[field], field === "favorite" ? false : 5);
      assert.equal(fixture.writes.length, 2); await assertPlayback(context);
    } finally { await cleanup(context); }
  });
  for (const firstField of ["favorite", "rating"]) await run(`track writes: delayed ${firstField} full DTO cannot overwrite the other confirmed field`, async () => {
    const context = await setup(), { page, fixture } = context;
    try {
      const nextField = firstField === "favorite" ? "rating" : "favorite", first = fixture.plan(firstField), next = fixture.plan(nextField);
      await (firstField === "favorite" ? favorite(page) : rating(page)); await bounded(first.accepted);
      first.commit(); await bounded(first.committed);
      await (nextField === "favorite" ? favorite(page) : rating(page)); await bounded(next.accepted);
      await finish(page, next, { all: false });
      first.respond(); await bounded(first.completed); await drain(page);
      assert.equal(fixture.writes.length, 2); await assertFields(page, { favorite: true, rating: 5 });
      assert.equal(fixture.get(base, owner).favorite, true); assert.equal(fixture.get(base, owner).rating, 5);
      await assertPlayback(context);
    } finally { await cleanup(context); }
  });
  await run("track writes: latest rating failure restores its interim committed value and remains retryable", async () => {
    const context = await setup(), { page, fixture } = context;
    try {
      const first = fixture.plan("rating"), latest = fixture.plan("rating", { error: "latest rating write failed" });
      await rating(page, 1); await bounded(first.accepted); await rating(page, 5);
      const pendingValue = (await snapshot(page)).current.rating;
      await finish(page, first, { all: false }); await bounded(latest.accepted);
      assert.equal((await snapshot(page)).current.rating, pendingValue);
      assert.equal(fixture.get(base, owner).rating, 1);
      await finish(page, latest);
      assert.equal(latest.record.committed, false); await assertFields(page, { rating: 1 });
      assert.match((await snapshot(page)).status, /latest rating write failed/);
      assert.match(await page.getByRole("alert").textContent(), /latest rating write failed/);
      const retry = fixture.plan("rating"); await rating(page, 5); await bounded(retry.accepted);
      assert.deepEqual(retry.record.body, { rating: 5 }); await finish(page, retry);
      await assertFields(page, { rating: 5 }); assert.equal(fixture.get(base, owner).rating, 5);
      await assertPlayback(context);
    } finally { await cleanup(context); }
  });
  for (const returnToA of [false, true]) for (const failure of [false, true]) await run(`track writes: source A→B${returnToA ? "→A" : ""} late ${failure ? "failure" : "success"} respects playback and list provenance`, async () => {
    const context = await setup({ ignoreAbort: returnToA }), { page, fixture } = context;
    const field = returnToA ? "rating" : "favorite";
    try {
      const old = fixture.plan(field, { error: failure ? "obsolete source error" : "" });
      await (field === "favorite" ? favorite(page) : rating(page)); await bounded(old.accepted);
      await browse(page, alternateBase);
      if (returnToA) {
        fixture.patch(base, owner, { title: "A 返回后的新列表标题", positionMs: 98765 });
        await browse(page, base);
      }
      assert.equal(old.record.transportClosedEarly, false, "accepted writes are not cancelled by source navigation");
      await finish(page, old);
      const value = !failure && field === "favorite", score = !failure && field === "rating" ? 5 : 0;
      await assertFields(page, { favorite: value, rating: score, listFavorite: returnToA ? value : false, listRating: returnToA ? score : 0 });
      const result = await snapshot(page);
      assert.equal(result.list[0].title, returnToA ? "A 返回后的新列表标题" : fixture.get(alternateBase, owner).title);
      assert.equal(result.last.track.title, result.current.title); assert.equal(result.last.track.positionMs, 12345);
      assert.equal(fixture.get(base, owner)[field], failure ? (field === "favorite" ? false : 0) : (field === "favorite" ? true : 5));
      await assertPlayback(context);
    } finally { await cleanup(context); }
  });
  await run("track writes: returning to A with a newer favorite intent supersedes its old receipt", async () => {
    const context = await setup({ ignoreAbort: true }), { page, fixture } = context;
    try {
      const old = fixture.plan("favorite"), latest = fixture.plan("favorite");
      await favorite(page); await bounded(old.accepted); await browse(page, alternateBase); await browse(page, base);
      await favorite(page); await frames(page); assert.equal(fixture.writes.length, 1);
      await finish(page, old, { all: false }); await bounded(latest.accepted);
      assert.deepEqual(latest.record.body, { favorite: false });
      assert.equal((await snapshot(page)).current.favorite, false, "an old receipt cannot flash over a newer desired favorite value");
      await finish(page, latest); await assertFields(page); assert.equal(fixture.get(base, owner).favorite, false);
      await assertPlayback(context);
    } finally { await cleanup(context); }
  });
  for (const failure of [false, true]) await run(`track writes: account A→B→A retires old revisions without splitting the physical lane after ${failure ? "failure" : "success"}`, async () => {
    const context = await setup(), { page, fixture } = context;
    try {
      const old = fixture.plan("rating", { error: failure ? "obsolete account error" : "" }), latest = fixture.plan("rating");
      await rating(page, 2); await bounded(old.accepted); await rating(page, 3); // This old-revision pending 3 must never be sent.
      assert.equal(await page.evaluate(async () => {
        const { captureAccountOwner, setAccountOwner } = await import("/js/account-owner.js"), before = captureAccountOwner(location.origin);
        setAccountOwner(location.origin, "account:writeB"); setAccountOwner(location.origin, "account:writeA");
        const after = captureAccountOwner(location.origin); return before.owner === after.owner && after.revision > before.revision;
      }), true);
      await browse(page, base);
      await page.locator('.music-mobile-track[data-track-id="T1"] .music-mobile-track-text').click();
      await page.waitForFunction(() => !__musicListFixture.state.loading && !__musicListFixture.audio().paused);
      await page.evaluate(() => { __musicListFixture.audio().currentTime = 37.5; });
      await rating(page, 5); await frames(page);
      const beforeOldReply = await snapshot(page);
      assert.equal(fixture.writes.length, 1, "a new account revision shares the existing physical lane until its accepted POST settles");
      await finish(page, old, { all: false }); await bounded(latest.accepted);
      const afterOldReply = await snapshot(page);
      assert.equal(afterOldReply.current.rating, beforeOldReply.current.rating, "old account revision must not apply even after logical owner returns");
      assert.doesNotMatch(afterOldReply.status, /obsolete account|账号已切换/);
      assert.deepEqual(latest.record.body, { rating: 5 }, "discard unsent 3 from the retired account revision");
      assert.equal(latest.record.owner, owner);
      await finish(page, latest); await assertFields(page, { rating: 5 }); assert.equal(fixture.writes.length, 2);
      assert.doesNotMatch((await snapshot(page)).status, /obsolete account|账号已切换/); await assertPlayback(context, { extraReads: 1 });
    } finally { await cleanup(context); }
  });
  for (const leave of [false, true]) for (const failure of [false, true]) await run(`track writes: same-source ${leave ? "deactivate" : "route"} keeps accepted ${failure ? "failure" : "success"} scoped without reviving an old page`, async () => {
    const context = await setup(), { page, fixture } = context;
    const field = leave ? "rating" : "favorite";
    try {
      const old = fixture.plan(field, { error: failure ? "retired page write error" : "" });
      await (field === "favorite" ? favorite(page) : rating(page)); await bounded(old.accepted);
      if (leave) await page.evaluate(() => { __fixtureLeave(); document.getElementById("viewContent").replaceChildren(Object.assign(document.createElement("p"), { id: "write-host", textContent: "离开音乐后的页面" })); });
      else {
        await page.locator('.music-mobile-track[data-track-id="T2"] .music-mobile-track-text').click();
        await page.waitForFunction(() => __musicListFixture.state.current?.id === "T2" && !__musicListFixture.state.loading && !__musicListFixture.audio().paused);
        await page.evaluate(() => {
          const f = __musicListFixture; f.audio().currentTime = 37.5;
          Object.assign(__writePlayback, { id: f.state.current.id, title: f.state.current.title, positionMs: f.state.current.positionMs });
        });
        await browse(page, base, { sort: "title" });
      }
      await page.evaluate(() => { window.__writeShellCount = __shellCalls.length; });
      assert.equal(old.record.transportClosedEarly, false);
      await finish(page, old);
      await assertFields(page, { rating: leave && !failure ? 5 : 0, listFavorite: !leave && !failure,
        savedFavorite: !leave && !failure });
      if (leave) {
        assert.equal(await page.locator("#write-host").textContent(), "离开音乐后的页面");
        assert.equal(await page.evaluate(() => __shellCalls.length === __writeShellCount), true, "inactive write completion must not render the old music shell");
      } else assert.equal(await page.evaluate(() => __musicListFixture.state.sort), "title");
      assert.equal(fixture.get(base, owner)[field], failure ? (field === "favorite" ? false : 0) : (field === "favorite" ? true : 5));
      await assertPlayback(context, { extraReads: leave ? 0 : 1 });
    } finally { await cleanup(context); }
  });
  await run("track writes: late real list and playback hydration GETs preserve confirmed fields", async () => {
    for (const kind of ["list", "hydration"]) {
      const context = await setup(), { page, fixture } = context;
      try {
        const read = fixture.read(url => kind === "list" ? url.pathname === "/api/music/tracks" : url.pathname === "/api/music/tracks/T1");
        await page.evaluate(kind => { window.__lateWriteRead = kind === "list" ? __fixtureRoute({ mode: "library", dashboard: "0" }) : __musicListFixture.hydrate("T1"); }, kind);
        await bounded(read.accepted);
        const write = fixture.plan("favorite"); await favorite(page); await bounded(write.accepted); await finish(page, write);
        read.release(); await bounded(read.completed); await page.evaluate(() => __lateWriteRead); await frames(page);
        await assertFields(page, { favorite: true }); await assertPlayback(context, { extraReads: kind === "hydration" ? 1 : 0 });
      } finally { await cleanup(context); }
    }
  });
  await run("track writes: A playback and B same-id row More and player controls write to their own sources", async () => {
    const context = await setup(), { page, fixture } = context;
    try {
      await browse(page, alternateBase);
      const row = fixture.plan("favorite"), player = fixture.plan("favorite");
      await favorite(page, "row"); await bounded(row.accepted);
      await favorite(page, "player"); await bounded(player.accepted);
      assert.equal(fixture.writes.length, 2, "same ids on different sources use independent physical lanes");
      assert.equal(row.record.source, alternateBase); assert.equal(player.record.source, base);
      assert.deepEqual(row.record.body, { favorite: true }); assert.deepEqual(player.record.body, { favorite: true });
      await finish(page, player, { all: false });
      assert.equal(fixture.get(base, owner).favorite, true); assert.equal(fixture.get(alternateBase, owner).favorite, false);
      await finish(page, row); await assertFields(page, { favorite: true, listFavorite: true });
      const more = fixture.plan("favorite"); await favorite(page, "more"); await bounded(more.accepted);
      assert.equal(more.record.source, alternateBase); assert.deepEqual(more.record.body, { favorite: false });
      await finish(page, more); await assertFields(page, { favorite: true, listFavorite: false });
      assert.equal(fixture.get(base, owner).favorite, true); assert.equal(fixture.get(alternateBase, owner).favorite, false);
      await assertPlayback(context);
    } finally { await cleanup(context); }
  });
  const settingsTrigger = page => page.locator(".music-mobile-full-settings");
  const settingsClose = sheet => sheet.getByRole("button", { name: "关闭播放设置", exact: true });
  const centerHit = async (locator, { touch = true } = {}) => {
    await locator.evaluate(node => node.scrollIntoView({ block: "center", behavior: "instant" }));
    await frames(locator.page());
    return locator.evaluate((node, touch) => {
      const box = node.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return (!touch || (box.width >= 44 && box.height >= 44)) && box.left >= 0 && box.right <= innerWidth
        && box.top >= 0 && box.bottom <= innerHeight && (hit === node || node.contains(hit));
    }, touch);
  };
  const assertSettingsClosedFocus = async page => {
    await page.getByRole("dialog", { name: "播放设置", exact: true }).waitFor({ state: "detached" }); await frames(page);
    assert.equal(await page.locator(".music-mobile-full-player").count(), 1, "closing settings retains the full player");
    assert.equal(await settingsTrigger(page).evaluate(node => document.activeElement === node), true, "the connected settings entry receives return focus");
  };
  await run("playback settings: cover and lyrics entry and scrollable controls fit three mobile viewports", async () => {
    const context = await setup({ lyrics: true }), { page } = context;
    try {
      await page.evaluate(() => { window.__settingsQueue = __musicListFixture.state.queue; });
      for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 568, height: 320 }]) for (const panel of ["cover", "lyrics"]) {
        await page.setViewportSize(viewport);
        if (!(await page.locator(".music-mobile-full-player").count())) await page.locator(".music-mobile-mini-text").click();
        await page.getByRole("button", { name: `切换到${panel === "lyrics" ? "歌词" : "封面"}`, exact: true }).click();
        const topControls = page.locator(".music-mobile-full-top button");
        assert.equal(await settingsTrigger(page).evaluate(node => {
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), box = node.getBoundingClientRect(); let text;
          while ((text = walker.nextNode())) if (text.textContent.trim() === "播放设置") {
            const range = document.createRange(); range.selectNodeContents(text); const rect = range.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && rect.left >= box.left && rect.right <= box.right;
          }
          return false;
        }), true, "settings entry has rendered visible text, including beside an icon");
        assert.equal(await settingsTrigger(page).getAttribute("aria-haspopup"), "dialog");
        const boxes = await topControls.evaluateAll(nodes => nodes.map(node => { const b = node.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; }));
        assert(boxes.every(box => box.width >= 44 && box.height >= 44 && box.left >= 0 && box.right <= viewport.width));
        assert(boxes.every((box, index) => boxes.slice(index + 1).every(other => Math.min(box.right, other.right) <= Math.max(box.left, other.left)
          || Math.min(box.bottom, other.bottom) <= Math.max(box.top, other.top))), "new entry and existing More/back controls do not overlap");
        assert.equal(await centerHit(settingsTrigger(page)), true);
        const sheet = await openSettings(page);
        assert.equal(await sheet.getByText((await snapshot(page)).current.title, { exact: true }).count(), 1);
        assert.equal(await settingsClose(sheet).evaluate(node => document.activeElement === node), true);
        assert.equal(await sheet.locator(".music-mobile-rating button").count(), 5);
        const stars = await sheet.locator(".music-mobile-rating button").evaluateAll(nodes => nodes.map(node => { const b = node.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; }));
        assert(stars.every((box, index) => index === 0 || box.left >= stars[index - 1].right), "the five stars form a separate nonoverlapping row");
        assert.deepEqual(await sheet.evaluate(node => {
          const body = node.querySelector(".music-mobile-playback-settings-body"), rating = node.querySelector(".music-mobile-playback-rating");
          const visible = parent => [...parent.children].filter(child => getComputedStyle(child).display !== "none").map(child => child.getBoundingClientRect());
          const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > .5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > .5;
          const noOverlap = boxes => boxes.every((box, index) => boxes.slice(index + 1).every(other => !overlap(box, other)));
          const bounds = rating.getBoundingClientRect(), children = visible(rating), speed = node.querySelector(".music-mobile-speed").getBoundingClientRect();
          return { rows: noOverlap(visible(body)), ratingChildren: noOverlap(children),
            contained: children.every(box => box.left >= bounds.left - 1 && box.right <= bounds.right + 1 && box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1),
            speedClear: !overlap(bounds, speed) && children.every(box => !overlap(box, speed)) };
        }), { rows: true, ratingChildren: true, contained: true, speedClear: true }, `${viewport.width}×${viewport.height}: rating label/stars/hint fit their row and do not overlap adjacent controls`);
        assert.equal(await sheet.evaluate(node => node.scrollWidth <= node.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth), true);
        for (const control of await sheet.locator('button,select,input[type="range"]').all()) assert.equal(await centerHit(control), true, `${viewport.width}×${viewport.height}: every settings control is a reachable 44px target`);
        await sheet.locator(".music-mobile-playback-settings-body").evaluate(node => { node.scrollTop = node.scrollHeight; });
        assert.equal(await centerHit(settingsClose(sheet)), true, "completion stays reachable after reading the scroll body");
        await settingsClose(sheet).click(); await assertSettingsClosedFocus(page);
        assert.equal(await page.evaluate(() => __musicListFixture.state.queue === __settingsQueue), true); await assertPlayback(context);
      }
    } finally { await cleanup(context); }
  });
  await run("playback settings: real Tab cycle and Escape keep focus in the active dialog", async () => {
    const context = await setup(), { page } = context;
    try {
      const sheet = await openSettings(page, { keyboard: true });
      const close = settingsClose(sheet);
      assert.equal(await close.evaluate(node => document.activeElement === node), true, "initial settings focus belongs to its connected close control");
      const focusable = sheet.locator('button:not([disabled]),select:not([disabled]),input:not([disabled])');
      const count = await focusable.count(); assert(count >= 8);
      await page.keyboard.press("Shift+Tab");
      assert.equal(await focusable.last().evaluate(node => document.activeElement === node), true);
      await page.keyboard.press("Tab"); assert.equal(await close.evaluate(node => document.activeElement === node), true);
      for (let index = 0; index < count; index++) {
        await page.keyboard.press("Tab");
        assert.equal(await sheet.evaluate(node => node.contains(document.activeElement)), true, "Tab must not escape behind the settings dialog");
      }
      assert.equal(await close.evaluate(node => document.activeElement === node), true);
      await page.keyboard.press("Escape"); await assertSettingsClosedFocus(page); await assertPlayback(context);
    } finally { await cleanup(context); }
  });
  await run("playback settings: completion backdrop and Back close one layer and return focus", async () => {
    const context = await setup(), { page } = context;
    try {
      for (const method of ["completion", "backdrop", "Back"]) {
        const sheet = await openSettings(page);
        if (method === "completion") {
          await settingsClose(sheet).evaluate(node => { window.__retiredSettingsClose = node; });
          await sheet.locator(".music-mobile-rating button").first().evaluate(node => { window.__retiredSettingsRating = node; });
          await settingsClose(sheet).click();
        }
        else if (method === "Back") assert.equal(await page.evaluate(() => __fixtureView.handleBack()), true);
        else {
          await sheet.evaluate(node => { window.__newSettingsSheet = node; });
          assert.equal(await page.evaluate(() => {
            const count = __trackWriteTasks.length; __retiredSettingsClose.click(); __retiredSettingsRating.click();
            return __newSettingsSheet.isConnected && __musicListFixture.state.playbackSheetOpen && __trackWriteTasks.length === count;
          }), true, "retired close and rating controls cannot act on a replacement sheet");
          const point = await sheet.evaluate(node => ({ x: innerWidth / 2, y: Math.max(1, node.getBoundingClientRect().top / 2) }));
          assert.equal(await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.classList.contains("music-mobile-sheet-backdrop"), point), true);
          await page.mouse.click(point.x, point.y);
        }
        await assertSettingsClosedFocus(page); await assertPlayback(context);
      }
      assert.equal(await page.evaluate(() => __fixtureView.handleBack()), true);
      assert.equal(await page.locator(".music-mobile-full-player").count(), 0); await assertPlayback(context);
    } finally { await cleanup(context); }
    for (const retirement of ["source", "account"]) {
      const invalid = await setup(), { page } = invalid;
      try {
        const sheet = await openSettings(page);
        await page.evaluate(async retirement => {
          if (retirement === "source") __fixtureActiveUrl = __fixtureAlternateUrl;
          else { const { setAccountOwner } = await import("/js/account-owner.js"); setAccountOwner(location.origin, "account:writeB"); }
        }, retirement);
        if (retirement === "source") await settingsClose(sheet).click(); else await page.keyboard.press("Escape");
        await sheet.waitFor({ state: "detached" }); await frames(page);
        assert.equal(await page.locator(".music-mobile-full-player").count(), 1);
        assert.equal(await settingsTrigger(page).evaluate(node => document.activeElement === node), false, "an invalid owner may dismiss its visible sheet without scheduling stale focus");
        await assertPlayback(invalid);
      } finally { await cleanup(invalid); }
    }
  });
  await run("playback settings: controls retain Audio and an open sheet rebinds after natural next track", async () => {
    const context = await setup(), { page, fixture } = context;
    try {
      const sheet = await openSettings(page), speed = sheet.locator(".music-mobile-speed select"), volume = sheet.locator('input[type="range"]');
      await speed.selectOption("1.25");
      const beforeVolume = Number(await volume.inputValue()); await volume.focus(); await page.keyboard.press("ArrowLeft");
      const nextVolume = Number(await volume.inputValue()); assert.equal(nextVolume, beforeVolume - 1);
      await sheet.locator(".music-mobile-playback-shuffle").click();
      assert.deepEqual(await page.evaluate(() => { const f = __musicListFixture; return {
        rate: f.audio().playbackRate, stateRate: f.state.playbackSpeed, savedRate: Number(localStorage.getItem("fanhao.android.music.playbackSpeed")),
        volume: f.audio().volume, stateVolume: f.state.volume, savedVolume: Number(localStorage.getItem("fanhao.android.music.volume")),
        shuffle: f.state.shuffle, savedShuffle: localStorage.getItem("fanhao.android.music.shuffle") }; }),
      { rate: 1.25, stateRate: 1.25, savedRate: 1.25, volume: nextVolume / 100, stateVolume: nextVolume / 100, savedVolume: nextVolume / 100, shuffle: true, savedShuffle: "1" });
      await assertPlayback(context);
      await page.evaluate(() => { __musicListFixture.audio().currentTime = 180; __musicListFixture.audio().dispatchEvent(new Event("ended")); });
      await page.waitForFunction(() => __musicListFixture.state.current?.id === "T2" && !__musicListFixture.state.loading && !__musicListFixture.audio().paused);
      assert.equal(await sheet.count(), 1, "natural track advancement retains the settings surface");
      assert.equal(await sheet.getByText(fixture.get(base, owner, "T2").title, { exact: true }).count(), 1);
      await page.evaluate(() => { const f = __musicListFixture; f.audio().currentTime = 37.5; Object.assign(__writePlayback, { id: f.state.current.id, title: f.state.current.title, positionMs: f.state.current.positionMs }); });
      const plan = fixture.plan("rating"); await rating(page, 2); await bounded(plan.accepted);
      assert.equal(plan.record.id, "T2"); await finish(page, plan);
      assert.equal(fixture.get(base, owner).rating, 0); assert.equal(fixture.get(base, owner, "T2").rating, 2);
      assert.equal(await sheet.locator(".music-mobile-rating").getAttribute("aria-label"), "评分：2");
      await assertPlayback(context, { extraReads: 1 });
    } finally { await cleanup(context); }
  });
  await run("playback settings: real A playback while browsing B exposes retryable score errors and writes only A", async () => {
    const context = await setup(), { page, fixture } = context;
    try {
      await page.setViewportSize({ width: 320, height: 568 }); await browse(page, alternateBase);
      const sheet = await openSettings(page), failed = fixture.plan("rating", { error: "settings score unavailable" });
      await sheet.getByRole("button", { name: "设为 4 星", exact: true }).click(); await bounded(failed.accepted);
      assert.equal(failed.record.source, base); assert.equal(failed.record.owner, owner); await finish(page, failed);
      const alert = page.getByRole("alert"); assert.match(await alert.textContent(), /settings score unavailable/);
      assert.equal(await centerHit(alert, { touch: false }), true, "a rating error must be readable above the full player instead of hidden beneath it");
      const success = fixture.plan("rating"); await rating(page, 4); await bounded(success.accepted);
      assert.equal(success.record.source, base); assert.deepEqual(success.record.body, { rating: 4 }); await finish(page, success);
      await assertFields(page, { rating: 4, listRating: 0 });
      const clear = fixture.plan("rating"); await sheet.getByRole("button", { name: "清除评分", exact: true }).click(); await bounded(clear.accepted);
      assert.equal(clear.record.source, base); assert.deepEqual(clear.record.body, { rating: 0 }); await finish(page, clear);
      await assertFields(page); assert.equal(fixture.get(alternateBase, owner).rating, 0); await assertPlayback(context);
    } finally { await cleanup(context); }
  });
  await run("playback settings: deliberate Tab after close cancels pending return focus", async () => {
    const context = await setup(), { page } = context;
    try {
      const sheet = await openSettings(page);
      await settingsClose(sheet).hover(); await page.mouse.down();
      await page.evaluate(() => {
        window.__settingsSavedRaf = window.requestAnimationFrame.bind(window); window.__settingsRafs = [];
        window.requestAnimationFrame = callback => { __settingsRafs.push(callback); return 1000000 + __settingsRafs.length; };
      });
      await page.mouse.up(); await page.keyboard.press("Tab");
      await page.evaluate(() => { window.__settingsUserTarget = document.activeElement; });
      await page.evaluate(() => {
        window.requestAnimationFrame = __settingsSavedRaf;
        for (const callback of __settingsRafs.splice(0)) callback(performance.now());
      });
      await frames(page);
      assert.equal(await page.evaluate(() => document.activeElement === __settingsUserTarget), true, "the one-shot close focus must not override a newer Tab intent");
      await assertPlayback(context);
    } finally { await page.evaluate(() => { if (window.__settingsSavedRaf) window.requestAnimationFrame = __settingsSavedRaf; }); await cleanup(context); }
  });
  const mini = page => page.locator(".music-mobile-mini-player");
  const miniOpen = page => page.locator(".music-mobile-mini-open");
  const fullDismiss = page => page.locator(".music-mobile-full-dismiss");
  const activateMini = async (page, control, method) => {
    if (method === "click") await control.click();
    else {
      await control.focus(); assert.equal(await control.evaluate(node => document.activeElement === node), true, "the real mini control must be keyboard focusable");
      await page.keyboard.down(method); await page.keyboard.up(method);
    }
  };
  const resetPlaybackSnapshot = async page => page.evaluate(() => {
    const f = __musicListFixture; f.audio().currentTime = 37.5;
    Object.assign(__writePlayback, { id: f.state.current.id, title: f.state.current.title, positionMs: f.state.current.positionMs });
  });
  const deepAnchor = async page => {
    await page.evaluate(() => { const row = document.querySelector('[data-track-id="T150"]'); scrollTo(0, row.getBoundingClientRect().top + scrollY - 140); });
    await frames(page);
    return page.evaluate(() => ({ y: scrollY, top: document.querySelector('[data-track-id="T150"]').getBoundingClientRect().top }));
  };
  const assertAnchor = async (page, saved) => {
    const actual = await page.evaluate(() => ({ y: scrollY, top: document.querySelector('[data-track-id="T150"]').getBoundingClientRect().top }));
    assert(Math.abs(actual.y - saved.y) <= 1 && Math.abs(actual.top - saved.top) <= 1, `mini/full roundtrip preserves the actual list anchor: ${JSON.stringify({ saved, actual })}`);
  };
  await run("mini player: long titles and native entry plus shortcuts fit 320 and 390", async () => {
    const title = "合成长歌名用于检查手机迷你播放器".repeat(3) + "ContinuousLatinTitleWithoutSpaces".repeat(3), artist = "合成长歌手名称".repeat(5);
    const context = await setup({ metadata: { title, artist } }), { page } = context;
    try {
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 }); await frames(page);
        assert.equal(await miniOpen(page).getAttribute("aria-label"), `打开播放器：${title}，${artist}`);
        assert.equal(await miniOpen(page).evaluate(node => node.tagName), "BUTTON");
        const result = await mini(page).evaluate(node => {
          const rect = node.getBoundingClientRect(), open = node.querySelector(".music-mobile-mini-open"), title = open.querySelector("strong"), titleBox = title.getBoundingClientRect();
          const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT), text = walker.nextNode(), range = document.createRange();
          range.setStart(text, 0); range.setEnd(text, Math.min(2, text.textContent.length)); const prefix = range.getBoundingClientRect();
          const controls = [...node.querySelectorAll(":scope > button")].map(control => control.getBoundingClientRect());
          const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > .5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > .5;
          const hint = [...open.querySelectorAll("small,span")].find(child => child.textContent.trim() === "打开播放器"), hintBox = hint?.getBoundingClientRect();
          return { controls: controls.length, touch: controls.every(box => box.width >= 44 && box.height >= 44),
            inside: controls.every(box => box.left >= rect.left - 1 && box.right <= rect.right + 1 && box.top >= rect.top - 1 && box.bottom <= rect.bottom + 1),
            overlap: controls.some((box, index) => controls.slice(index + 1).some(other => overlap(box, other))),
            prefix: prefix.width > 0 && prefix.height > 0 && prefix.left >= titleBox.left - 1 && prefix.right <= titleBox.right + 1,
            twoLines: Math.abs(titleBox.height - parseFloat(getComputedStyle(title).lineHeight) * 2) <= 1,
            hint: Boolean(hintBox && hintBox.width > 0 && hintBox.height > 0 && getComputedStyle(hint).display !== "none" && !overlap(titleBox, hintBox)),
            overflow: document.documentElement.scrollWidth > innerWidth };
        });
        assert.deepEqual(result, { controls: 4, touch: true, inside: true, overlap: false, prefix: true, twoLines: true, hint: true, overflow: false });
        for (const button of await mini(page).locator(":scope > button").all()) assert.equal(await centerHit(button), true);
        await assertPlayback(context);
      }
    } finally { await cleanup(context); }
  });
  await run("mini player: native mouse Enter and Space roundtrips retain deep scroll and focus", async () => {
    for (const width of [320, 390]) {
      const context = await setup({ tracks: 300, width }), { page } = context;
      try {
        await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
        const anchor = await deepAnchor(page); assert(anchor.y > 10000);
        await page.evaluate(() => { window.__miniQueue = __musicListFixture.state.queue; });
        for (const method of legacyMiniKeyboard ? ["Enter"] : ["click", "Enter", "Space"]) {
          await activateMini(page, miniOpen(page), method); await frames(page);
          assert.equal(await page.locator(".music-mobile-full-player").count(), 1);
          assert.equal(await fullDismiss(page).evaluate(node => document.activeElement === node), true, "opening the player focuses its connected dismiss button");
          await assertAnchor(page, anchor);
          if (method === "click") await fullDismiss(page).click();
          else if (method === "Enter") await page.keyboard.press("Enter");
          else assert.equal(await page.evaluate(() => __fixtureView.handleBack()), true);
          await page.locator(".music-mobile-full-player").waitFor({ state: "detached" }); await frames(page);
          assert.equal(await miniOpen(page).evaluate(node => document.activeElement === node), true);
          await assertAnchor(page, anchor); assert.equal(await page.evaluate(() => __musicListFixture.state.queue === __miniQueue), true);
          await assertPlayback(context);
        }
      } finally { await cleanup(context); }
    }
  });
  await run("mini player: play next and queue keep separate native click and keyboard actions", async () => {
    for (const method of ["click", "Enter", "Space"]) {
      const context = await setup(), { page } = context;
      try {
        await activateMini(page, mini(page).getByRole("button", { name: "暂停", exact: true }), method); await frames(page);
        assert.equal(await page.locator(".music-mobile-full-player").count(), 0); assert.equal(await page.evaluate(() => __musicListFixture.audio().paused), true);
        await activateMini(page, mini(page).getByRole("button", { name: "播放", exact: true }), method); await frames(page);
        assert.equal(await page.locator(".music-mobile-full-player").count(), 0); await assertPlayback(context);
        await activateMini(page, mini(page).getByRole("button", { name: "下一首", exact: true }), method);
        await page.waitForFunction(() => __musicListFixture.state.current?.id === "T2" && !__musicListFixture.state.loading && !__musicListFixture.audio().paused);
        assert.equal(await page.locator(".music-mobile-full-player").count(), 0); await resetPlaybackSnapshot(page);
        assert.equal(await miniOpen(page).getAttribute("aria-label"), await page.evaluate(() => `打开播放器：${__musicListFixture.state.current.title}，${__musicListFixture.state.current.artist}`));
        await activateMini(page, mini(page).getByRole("button", { name: "播放队列", exact: true }), method); await frames(page);
        assert.equal(await page.getByRole("dialog", { name: "播放队列", exact: true }).count(), 1);
        assert.equal(await page.getByRole("button", { name: "关闭队列", exact: true }).evaluate(node => document.activeElement === node), true);
        assert.equal(await page.getByRole("dialog", { name: "播放设置", exact: true }).count(), 0);
        assert.equal(await page.locator(".music-mobile-track-actions-sheet").count(), 0);
        assert.equal(await page.evaluate(() => __fixtureView.handleBack()), true); await frames(page);
        assert.equal(await page.getByRole("dialog", { name: "播放队列", exact: true }).count(), 0);
        assert.equal(await page.locator(".music-mobile-full-player").count(), 1);
        assert.equal(await page.locator(".music-mobile-full-queue").evaluate(node => document.activeElement === node), true);
        assert.equal(await page.evaluate(() => __fixtureView.handleBack()), true); await frames(page);
        assert.equal(await mini(page).getByRole("button", { name: "播放队列", exact: true }).evaluate(node => document.activeElement === node), true, "queue returns to its actual mini origin");
        await assertPlayback(context, { extraReads: 1 });
      } finally { await cleanup(context); }
    }
  });
  await run("mini player: trusted touch swipes retain entry and shortcut gesture boundaries", async () => {
    const context = await setup({ touch: true, tracks: 3, width: 390 }), { page } = context;
    const cdp = await page.context().newCDPSession(page);
    const swipe = async (locator, dx, dy) => {
      const box = await locator.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx / 2, y: y + dy / 2 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx, y: y + dy }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    try {
      await swipe(miniOpen(page), -70, 0);
      await page.waitForFunction(() => __musicListFixture.state.current?.id === "T2" && !__musicListFixture.state.loading);
      await page.waitForTimeout(300); assert.equal(await page.locator(".music-mobile-full-player").count(), 0);
      await swipe(miniOpen(page), 70, 0);
      await page.waitForFunction(() => __musicListFixture.state.current?.id === "T1" && !__musicListFixture.state.loading);
      await page.waitForTimeout(300); assert.equal(await page.locator(".music-mobile-full-player").count(), 0); await resetPlaybackSnapshot(page);
      await swipe(mini(page).getByRole("button", { name: "暂停", exact: true }), 0, -70); await frames(page);
      assert.equal(await page.locator(".music-mobile-full-player").count(), 0); await assertPlayback(context, { extraReads: 2 });
      const point = await miniOpen(page).evaluate(node => { const box = node.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] }); await frames(page);
      assert.equal(await page.locator(".music-mobile-full-player").count(), 0);
      await activateMini(page, miniOpen(page), "Enter"); await frames(page);
      assert.equal(await page.locator(".music-mobile-full-player").count(), 1, "a cancelled touch cannot suppress the next native keyboard click");
      await fullDismiss(page).click(); await frames(page);
      await swipe(miniOpen(page), 0, -70); await frames(page);
      assert.equal(await page.locator(".music-mobile-full-player").count(), 1);
      assert.equal(await fullDismiss(page).evaluate(node => document.activeElement === node), true);
      await fullDismiss(page).click(); await frames(page);
      assert.equal(await miniOpen(page).evaluate(node => document.activeElement === node), true); await assertPlayback(context, { extraReads: 2 });
    } finally { await cdp.detach(); await cleanup(context); }
  });
  await run("mini player: retired mini and fullscreen nodes cannot change the new surface", async () => {
    const context = await setup({ touch: true }), { page } = context;
    try {
      await mini(page).evaluate(node => {
        window.__retiredMini = node; window.__retiredMiniButtons = [...node.querySelectorAll(":scope > button")];
        const box = __retiredMiniButtons[0].getBoundingClientRect();
        window.__retiredMiniStart = { identifier: 1, clientX: box.left + box.width * .75, clientY: box.top + box.height / 2 };
        const start = new Event("touchstart", { bubbles: true }); Object.defineProperty(start, "touches", { value: [__retiredMiniStart] });
        __retiredMiniButtons[0].dispatchEvent(start);
      });
      await browse(page, base, { sort: "title" });
      await page.evaluate(() => {
        for (const node of __retiredMiniButtons) node.click();
        const end = new Event("touchend", { bubbles: true }); Object.defineProperty(end, "touches", { value: [] });
        Object.defineProperty(end, "changedTouches", { value: [{ ...__retiredMiniStart, clientX: __retiredMiniStart.clientX - 70 }] });
        __retiredMiniButtons[0].dispatchEvent(end);
      });
      await frames(page); assert.equal(await page.locator(".music-mobile-full-player").count(), 0); await assertPlayback(context);
      await miniOpen(page).click(); await frames(page);
      await fullDismiss(page).evaluate(node => { window.__retiredFullDismiss = node; });
      await fullDismiss(page).click(); await frames(page); await miniOpen(page).click(); await frames(page);
      await page.evaluate(() => __retiredFullDismiss.click()); await frames(page);
      assert.equal(await page.locator(".music-mobile-full-player").count(), 1);
      assert.equal(await fullDismiss(page).evaluate(node => document.activeElement === node), true);
      await fullDismiss(page).click(); await frames(page); await assertPlayback(context);
    } finally { await cleanup(context); }
  });
  await run("mini player: deliberate Tab retires pending fullscreen return focus", async () => {
    const context = await setup(), { page } = context;
    try {
      await miniOpen(page).click(); await frames(page); await fullDismiss(page).hover(); await page.mouse.down();
      await page.evaluate(() => {
        window.__miniSavedRaf = window.requestAnimationFrame.bind(window); window.__miniRafs = [];
        window.requestAnimationFrame = callback => { __miniRafs.push(callback); return 2000000 + __miniRafs.length; };
      });
      await page.mouse.up(); await page.keyboard.press("Tab");
      await page.evaluate(() => { window.__miniUserTarget = document.activeElement; window.requestAnimationFrame = __miniSavedRaf; for (const callback of __miniRafs.splice(0)) callback(performance.now()); });
      await frames(page); assert.equal(await page.evaluate(() => document.activeElement === __miniUserTarget), true);
      await assertPlayback(context);
    } finally { await page.evaluate(() => { if (window.__miniSavedRaf) window.requestAnimationFrame = __miniSavedRaf; }); await cleanup(context); }
  });
}

async function verifyMusicTrackRows() {
  const chinese = "合成长歌名用来检查窄屏歌曲列表是否仍然可读".repeat(5);
  const latin = "ContinuousLatinTrackTitleWithoutSpaces".repeat(7);
  const flat = data(4, 0, { total: 4, hasMore: false, tracks: [chinese, latin, chinese, latin].map((title, index) => track(index + 1, {
    title: title + index, artist: "合成歌手", album: "合成专辑", coverUrl: index < 2 ? `/synthetic/cover/${index + 1}.svg` : ""
  })) });
  const search = data(3, 0, { total: 3, hasMore: false, tracks: [
    track(2, { title: chinese, artist: "合成歌手", coverUrl: "" }),
    track(3, { title: `${chinese} (Live)`, artist: "合成歌手", coverUrl: "" }),
    track(4, { title: latin, artist: "合成歌手", coverUrl: "/synthetic/cover/4.svg" })
  ] });
  const prepare = async (page, body, searching = false) => {
    await page.evaluate(({ body, searching }) => {
      const f = __musicListFixture;
      f.seed(body, { mode: "library", dashboard: false, query: searching ? "合成" : "", searchOpen: searching, searchScope: "songs",
        artistId: "", albumId: "", smartId: "", playlistId: "", trackActionId: "", fullscreen: false,
        searchCollapsedGroups: new Set(), searchExpandedVersionGroups: new Set(),
        current: searching ? { id: "T1", title: "合成背景歌曲", durationMs: 180000 } : body.tracks[0], playing: true, loading: false, loadingMore: false });
      f.audio().paused = false; f.audio().currentTime = 37.5;
      window.__rowAudio = f.audio();
    }, { body, searching });
    await frames(page);
  };
  const assertRows = async (page, searching = false) => {
    for (const row of await page.locator(".music-mobile-track").all()) {
      await row.scrollIntoViewIfNeeded(); await frames(page);
      const result = await row.evaluate(row => {
        const bounds = row.getBoundingClientRect(), title = row.querySelector(".music-mobile-track-title-line > strong"), titleBox = title.getBoundingClientRect();
        const text = row.querySelector(".music-mobile-track-text").getBoundingClientRect(), side = row.querySelector(".music-mobile-track-side").getBoundingClientRect();
        const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > .5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > .5;
        const inside = box => box.left >= bounds.left - 1 && box.right <= bounds.right + 1 && box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1;
        const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT), range = document.createRange();
        let node, remaining = 2, first = null;
        while ((node = walker.nextNode())) {
          if (!node.textContent.length) continue;
          if (!first) { first = node; range.setStart(node, 0); }
          const take = Math.min(remaining, node.textContent.length); range.setEnd(node, take); remaining -= take;
          if (!remaining) break;
        }
        const prefix = first && remaining === 0 && [...range.getClientRects()].some(rect => rect.width > 0 && rect.height > 0
          && rect.left >= titleBox.left - 2 && rect.right <= titleBox.right + 2 && rect.top >= titleBox.top - 2 && rect.bottom <= titleBox.bottom + 2);
        const cover = row.querySelector(".music-mobile-cover"), coverVisible = getComputedStyle(cover).display !== "none";
        const visibleParts = [...row.children].filter(node => getComputedStyle(node).display !== "none").map(node => node.getBoundingClientRect());
        const actions = [...row.querySelectorAll(".track-favorite,.track-more,.music-mobile-search-version-toggle")], boxes = actions.map(node => node.getBoundingClientRect());
        const match = row.querySelector(".music-mobile-track-match"), matchBox = match?.getBoundingClientRect();
        return { height: bounds.height, title: title.textContent, prefix: Boolean(prefix),
          inside: visibleParts.every(inside) && boxes.every(inside), overlap: overlap(text, side) || boxes.some((box, index) => boxes.slice(index + 1).some(other => overlap(box, other)))
            || Boolean(matchBox && overlap(titleBox, matchBox)),
          touch: boxes.every(box => box.width >= 44 && box.height >= 44), viewport: bounds.left >= 0 && bounds.right <= innerWidth,
          cover: coverVisible, coverLazy: cover.querySelector("img").loading === "lazy", match: match?.textContent || "",
          overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.equal(result.prefix, true, "the real first two title characters must have nonzero unclipped Range geometry");
      assert.equal(result.inside, true); assert.equal(result.overlap, false); assert.equal(result.touch, true, "row actions retain 44px touch boxes");
      assert.equal(result.viewport, true); assert.equal(result.overflow, false); assert.equal(result.coverLazy, true);
      assert.equal(result.cover, !(await row.getAttribute("class")).split(/\s+/).includes("no-cover"));
      if (searching) assert(result.match.length > 0); else assert.equal(result.height, 80);
      for (const action of await row.locator(".track-favorite,.track-more,.music-mobile-search-version-toggle").all()) {
        await action.evaluate(node => node.scrollIntoView({ block: "center", behavior: "instant" })); await frames(page);
        const target = await action.evaluate(node => { const box = node.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return { reachable: box.top >= 0 && box.bottom <= innerHeight && (hit === node || node.contains(hit)),
            label: node.getAttribute("aria-label") || node.textContent, top: box.top, bottom: box.bottom, hit: hit?.className || hit?.tagName || "none" }; });
        assert.equal(target.reachable, true, `visible action centers must hit their own control: ${JSON.stringify(target)}`);
      }
    }
  };
  await run("row layout: flat titles and touch actions fit narrow viewports", async () => {
    const page = await newPage();
    try {
      await prepare(page, flat);
      for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 568, height: 320 }]) {
        await page.setViewportSize(viewport); await assertRows(page);
        assert.deepEqual(await page.locator(".music-mobile-track-title-line > strong").allTextContents(), flat.tracks.map(track => track.title));
        assert.equal(await page.evaluate(() => __musicListFixture.audio() === __rowAudio && __musicListFixture.audio().currentTime === 37.5), true);
      }
    } finally { await page.close(); }
  });
  await run("row layout: real search matches and version markers keep readable title space", async () => {
    const page = await newPage();
    try {
      await prepare(page, search, true);
      assert.equal(await page.locator(".music-mobile-search-track-version-group").count(), 1);
      assert.equal(await page.locator(".music-mobile-search-version-toggle").textContent(), "2 个版本");
      assert(await page.locator(".music-mobile-track-text mark").count() > 0);
      for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 568, height: 320 }]) {
        await page.setViewportSize(viewport); await assertRows(page, true);
      }
      await page.locator(".music-mobile-search-version-toggle").click();
      assert.equal(await page.locator(".music-mobile-search-version-list").count(), 1); await assertRows(page, true);
      await page.locator(".music-mobile-search-version-toggle").click();
      assert.equal(await page.locator(".music-mobile-search-version-list").count(), 0);
      assert.equal(await page.evaluate(() => __musicListFixture.state.current.id), "T1");
      assert.equal(await page.evaluate(() => __musicListFixture.audio() === __rowAudio && __musicListFixture.audio().currentTime === 37.5), true);
    } finally { await page.close(); }
  });
  await run("row layout: real row and child keyboard/mouse activation stay distinct", async () => {
    const page = await newPage({ width: 320 }), playReads = [];
    const moreBody = { ...flat, tracks: flat.tracks.map(item => ({ ...item,
      artist: "合成长歌手名称".repeat(5) + "ContinuousArtistName".repeat(3), album: "合成长专辑名称".repeat(5) + "ContinuousAlbumName".repeat(3) })) };
    page.on("request", request => { const url = new URL(request.url()); if (request.method() === "GET" && /^\/api\/music\/tracks\/T\d+$/.test(url.pathname)) playReads.push(url.pathname); });
    const activate = async (locator, method) => {
      await locator.hover();
      if (method === "click") await locator.click();
      else { await locator.focus(); await page.keyboard.down(method); await page.keyboard.up(method); }
    };
    try {
      for (const kind of ["favorite", "more", "versions"]) for (const method of ["click", "Enter", "Space"]) {
        await page.setViewportSize({ width: 320, height: 568 });
        await prepare(page, kind === "versions" ? search : kind === "more" ? moreBody : flat, kind === "versions");
        const row = page.locator('.music-mobile-track[data-track-id="T2"]');
        const control = row.locator(kind === "favorite" ? ".track-favorite" : kind === "more" ? ".track-more" : ".music-mobile-search-version-toggle");
        const before = playReads.length;
        await control.hover(); await frames(page);
        assert.equal(playReads.length, before); assert.equal(await page.evaluate(() => __musicListFixture.state.current.id), "T1");
        if (kind === "favorite") {
          const candidate = flat.tracks[1], gate = hold(url => url.pathname === "/api/music/tracks/T2/favorite", { track: { ...candidate, favorite: true } });
          const action = page.waitForRequest(request => /\/api\/music\/tracks\/T2(?:\/favorite)?$/.test(new URL(request.url()).pathname));
          try {
            await activate(control, method); const request = await action;
            assert.equal(request.method(), "POST", "a descendant key must activate favorite instead of issuing a playback GET");
            assert.equal(new URL(request.url()).pathname, "/api/music/tracks/T2/favorite");
            assert.deepEqual(request.postDataJSON(), { favorite: true });
            await requested(gate); gate.release(); await page.waitForFunction(() => __musicListFixture.state.data.tracks.find(track => track.id === "T2").favorite);
          } finally { gate.release(); }
        } else {
          await activate(control, method); await frames(page);
          assert.equal(playReads.length, before, "child actions must not bubble into row playback");
          if (kind === "more") {
            const sheet = page.locator(".music-mobile-track-actions-sheet"); await sheet.waitFor({ state: "visible" });
            assert.equal(await page.evaluate(() => __musicListFixture.state.trackActionId), "T2");
            assert.deepEqual(await sheet.locator(".music-mobile-track-action-choice > strong").allTextContents(),
              ["立即播放", "下一首播放", "加入队列", "加入歌单", "收藏歌曲", "查看歌手", "查看专辑"]);
            assert.equal(await sheet.locator(".music-mobile-track-actions-head strong").textContent(), moreBody.tracks[1].title);
            assert.equal(await sheet.getByRole("button", { name: "查看歌手", exact: true }).locator("small").textContent(), moreBody.tracks[1].artist);
            assert.equal(await sheet.getByRole("button", { name: "查看专辑", exact: true }).locator("small").textContent(), moreBody.tracks[1].album);
            for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 568, height: 320 }]) {
              await page.setViewportSize(viewport); await frames(page);
              assert.deepEqual(await sheet.evaluate(sheet => {
                const bounds = sheet.getBoundingClientRect(), failures = [];
                const textFits = node => {
                  const range = document.createRange(), box = node.getBoundingClientRect(); range.selectNodeContents(node);
                  const rects = [...range.getClientRects()];
                  const fits = rects.length > 0 && rects.every(rect => rect.width > 0 && rect.height > 0 && rect.left >= box.left - 2
                    && rect.right <= box.right + 2 && rect.top >= box.top - 2 && rect.bottom <= box.bottom + 2);
                  if (!fits) failures.push({ text: node.textContent.slice(0, 30), width: box.width, height: box.height,
                    rects: rects.filter(rect => !rect.width || !rect.height || rect.left < box.left - 2 || rect.right > box.right + 2 || rect.top < box.top - 2 || rect.bottom > box.bottom + 2)
                      .slice(0, 2).map(rect => ({ width: rect.width, height: rect.height, left: rect.left - box.left, top: rect.top - box.top })) });
                  return fits;
                };
                return { panel: bounds.left >= 0 && bounds.right <= innerWidth && sheet.scrollWidth <= sheet.clientWidth + 1,
                  document: document.documentElement.scrollWidth <= innerWidth,
                  // The four primary descriptions are intentionally hidden; their
                  // labels and every displayed metadata field still need full text.
                  text: [...sheet.querySelectorAll(".music-mobile-track-actions-head strong,.music-mobile-track-actions-head small,.music-mobile-track-action-choice > strong,.music-mobile-track-action-choice:not(.primary) > small")].map(textFits).every(Boolean), failures };
              }), { panel: true, document: true, text: true, failures: [] }, `${viewport.width}px long track action text must remain inside its own boxes`);
              for (const choice of await sheet.locator(".music-mobile-track-action-choice").all()) {
                await choice.evaluate(node => node.scrollIntoView({ block: "center", behavior: "instant" })); await frames(page);
                assert.equal(await choice.evaluate(node => { const box = node.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
                  return box.width >= 44 && box.height >= 44 && box.left >= 0 && box.right <= innerWidth
                    && box.top >= 0 && box.bottom <= innerHeight && (hit === node || node.contains(hit)); }), true, "all seven real actions remain scrollable touch targets");
              }
              await sheet.evaluate(node => { node.scrollTop = node.scrollHeight; });
              const done = sheet.locator(".music-mobile-track-actions-head button");
              await done.evaluate(node => node.scrollIntoView({ block: "center", behavior: "instant" })); await frames(page);
              assert.equal(await done.evaluate(node => { const box = node.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
                return box.width >= 44 && box.height >= 44 && box.top >= 0 && box.bottom <= innerHeight && (hit === node || node.contains(hit)); }), true);
            }
            await sheet.locator(".music-mobile-track-actions-head button").click();
            await sheet.waitFor({ state: "detached" });
            assert.equal(await page.evaluate(() => __musicListFixture.state.trackActionId), "");
          } else assert.equal(await page.locator(".music-mobile-search-version-list").count(), 1);
        }
        assert.equal(playReads.length, before); assert.equal(await page.evaluate(() => __musicListFixture.state.current.id), "T1");
        assert.equal(await page.evaluate(() => __musicListFixture.audio() === __rowAudio && __musicListFixture.audio().currentTime === 37.5), true);
      }
      for (const method of ["click", "Enter", "Space"]) {
        await prepare(page, flat); const before = playReads.length, row = page.locator('.music-mobile-track[data-track-id="T2"]');
        await activate(method === "click" ? row.locator(".music-mobile-track-text") : row, method);
        await page.waitForFunction(() => __musicListFixture.state.current.id === "T2" && !__musicListFixture.audio().paused);
        assert.equal(playReads.length - before, 1); assert.equal(await page.evaluate(() => __musicListFixture.audio() === __rowAudio), true);
      }
    } finally { await page.close(); }
  });
}

async function verifyContainedRows() {
  for (const count of [80, 1000]) await run(`full CSS flat ${count}: calibrated scroll extent and cold layout`, async () => {
    const current = await newPage(), baseline = await newPage({ containment: false });
    try {
      assert.equal(await current.evaluate(() => CSS.supports("content-visibility", "auto") && CSS.supports("contain-intrinsic-block-size", "auto 65px")), true);
      const body = data(count), before = await layoutSamples(baseline, body), after = await layoutSamples(current, body);
      const oldGeometry = await geometry(baseline), newGeometry = await geometry(current);
      assert.equal(newGeometry.contentVisibility, "auto", "actual full CSS must skip offscreen flat rows");
      assert.equal(newGeometry.intrinsic, "auto 65px"); assert.equal(oldGeometry.contentVisibility, "visible");
      assert.equal(newGeometry.count, count); assert.equal(newGeometry.first, 80); assert.equal(newGeometry.last, 80);
      assert.equal(newGeometry.bodyHeight, oldGeometry.bodyHeight, "intrinsic content size must include the existing padding/border exactly");
      assert.equal(newGeometry.gap, oldGeometry.gap); assert.equal(oldGeometry.skippedTail, false);
      if (count === 1000) {
        assert.equal(newGeometry.skippedTail, true);
      }
      // CPU timing is diagnostic, not a load-sensitive CI threshold. Skipped
      // descendants, unchanged geometry and interaction are the fixed gates.
      console.log(JSON.stringify({ mode: "full-css-containment", count, baseline: before, current: after, geometry: newGeometry }));
    } finally { await current.close(); await baseline.close(); }
  });
  await run("full CSS resize/long labels retain row geometry and visible content", async () => {
    const page = await newPage(), baseline = await newPage({ containment: false });
    const body = data(1000); body.tracks = body.tracks.map((item, index) => ({ ...item, title: "很长的歌曲标题 Synthetic " .repeat(12) + index, artist: "很长歌手 Artist ".repeat(12), album: "很长专辑 Album ".repeat(12), coverUrl: index % 2 ? item.coverUrl : "", favorite: index % 3 === 0, rating: 5 }));
    try {
      await page.evaluate(body => __musicListFixture.seed(body), body); await baseline.evaluate(body => __musicListFixture.seed(body), body);
      for (const width of [320, 380, 430, 720, 430]) {
        await page.setViewportSize({ width, height: 900 }); await baseline.setViewportSize({ width, height: 900 }); await frames(page); await frames(baseline);
        const actual = await geometry(page), expected = await geometry(baseline);
        assert.equal(actual.first, expected.first); assert.equal(actual.last, expected.last); assert.equal(actual.bodyHeight, expected.bodyHeight);
        await page.evaluate(selector => document.querySelectorAll(selector)[499].scrollIntoView({ block: "center", behavior: "instant" }), flatRows); await frames(page);
        const visible = await page.evaluate(selector => {
          const row = document.querySelectorAll(selector)[499], bounds = row.getBoundingClientRect();
          const children = [...row.children].filter(child => getComputedStyle(child).display !== "none");
          const title = row.querySelector("strong");
          return { rendered: row.checkVisibility({ contentVisibilityAuto: true }), height: bounds.height, visible: bounds.top >= 0 && bounds.bottom <= innerHeight, inside: children.every(child => { const box = child.getBoundingClientRect(); return box.top >= bounds.top && box.bottom <= bounds.bottom; }), titleTruncated: title.scrollWidth > title.clientWidth || title.scrollHeight > title.clientHeight };
        }, flatRows);
        assert.deepEqual(visible, { rendered: true, height: 80, visible: true, inside: true, titleTruncated: true });
        await page.evaluate(() => window.scrollTo(0, 0));
      }
    } finally { await page.close(); await baseline.close(); }
  });
  await run("missing cover/short metadata keep the same placeholder and scroll target", async () => {
    const page = await newPage(), baseline = await newPage({ containment: false });
    const body = data(1000); body.tracks = body.tracks.map(item => ({ id: item.id, title: "短", streamUrl: item.streamUrl }));
    try {
      await page.evaluate(body => __musicListFixture.seed(body), body); await baseline.evaluate(body => __musicListFixture.seed(body), body); await frames(page); await frames(baseline);
      const actual = await geometry(page), expected = await geometry(baseline);
      assert.equal(actual.first, expected.first); assert.equal(actual.last, expected.last); assert.equal(actual.bodyHeight, expected.bodyHeight);
      await page.evaluate(selector => document.querySelectorAll(selector)[999].scrollIntoView({ block: "center", behavior: "instant" }), flatRows); await frames(page);
      assert.deepEqual(await page.evaluate(selector => { const row = document.querySelectorAll(selector)[999], box = row.getBoundingClientRect(); return { rendered: row.checkVisibility({ contentVisibilityAuto: true }), height: box.height, visible: box.top >= 0 && box.bottom <= innerHeight }; }, flatRows), { rendered: true, height: expected.last, visible: true });
    } finally { await page.close(); await baseline.close(); }
  });
  await run("1000-row tail scroll preserves observer/player and lazy covers", async () => {
    const requestStart = requests.length, page = await newPage(); try {
      await seed(page, 1000); await frames(page);
      await page.evaluate(selector => {
        const f = __musicListFixture; f.state.current = f.state.data.tracks[0]; f.audio().paused = false; f.audio().currentTime = 57; f.render();
        snapshot(); window.__tail = document.querySelectorAll(selector)[999]; window.__tailIntersections = [];
        window.__tailObserver = new IntersectionObserver(entries => __tailIntersections.push(...entries.map(entry => entry.isIntersecting))); __tailObserver.observe(__tail);
      }, flatRows);
      await page.waitForFunction(() => __tailIntersections.includes(false));
      await frames(page); await page.waitForTimeout(650);
      assert.equal(await page.evaluate(() => __tail.firstElementChild.checkVisibility({ contentVisibilityAuto: true })), false);
      const covers = requests.slice(requestStart).filter(key => /^\/synthetic\/cover\/\d+\.svg$/.test(new URL(key, base).pathname));
      assert(new Set(covers).size < 1000, "native lazy covers must not eagerly request all rows");
      assert(!covers.includes("/synthetic/cover/1000.svg"), "an offscreen tail cover must wait until scrolling");
      const baselineStart = requests.length, baseline = await newPage({ containment: false });
      try {
        await seed(baseline, 1000); await frames(baseline); await baseline.evaluate(() => {
          const f = __musicListFixture; f.state.current = f.state.data.tracks[0]; f.audio().paused = false; f.audio().currentTime = 57; f.render(); snapshot();
        });
        await frames(baseline); await baseline.waitForTimeout(650);
        const oldCovers = new Set(requests.slice(baselineStart).filter(key => /^\/synthetic\/cover\/\d+\.svg$/.test(new URL(key, base).pathname)));
        assert.equal(new Set(covers).size, oldCovers.size, "containment must preserve the same native lazy window at the same row positions");
        console.log(JSON.stringify({ mode: "lazy-cover-window", current: new Set(covers).size, baseline: oldCovers.size, total: 1000 }));
      } finally { await baseline.close(); }
      await page.evaluate(() => __tail.scrollIntoView({ block: "center", behavior: "instant" }));
      await page.waitForFunction(() => __tailIntersections.includes(true)); await frames(page);
      assert.equal(await page.evaluate(() => __tail.firstElementChild.checkVisibility({ contentVisibilityAuto: true })), true);
      await page.waitForFunction(() => __tail.querySelector(".music-mobile-cover img").complete && __tail.querySelector(".music-mobile-cover img").naturalWidth > 0);
      await page.evaluate(() => { __row.dataset.fixtureObserved = "tail-return"; window.scrollTo(0, 0); }); await frames(page);
      assert.deepEqual(await page.evaluate(() => ({ row: __row.isConnected, mini: __mini.isConnected, observer: __observerCount > 0, sameTail: __tail === document.querySelector('[data-track-id="T1000"]'), current: document.querySelector('[data-track-id="T1"]').classList.contains("playing"), time: __musicListFixture.audio().currentTime, paused: __musicListFixture.audio().paused })), { row: true, mini: true, observer: true, sameTail: true, current: true, time: 57, paused: false });
    } finally { await page.close(); }
  });
  await run("current-track locate after full list return renders the skipped row", async () => {
    const page = await newPage(); try {
      await seed(page, 1000); await page.evaluate(() => {
        const f = __musicListFixture; f.state.current = f.state.data.tracks[999]; f.audio().paused = false; f.audio().currentTime = 57; f.render();
        snapshot();
      });
      // The real locate click arrives after renderShell's deferred scroll restore.
      await frames(page); await page.evaluate(() => window.scrollTo(0, 0)); await frames(page);
      await page.evaluate(() => __musicListFixture.locate());
      await page.waitForFunction(() => { const row = document.querySelector('[data-track-id="T1000"]'), box = row.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; });
      assert.deepEqual(await page.evaluate(() => ({ rendered: document.querySelector('[data-track-id="T1000"]').checkVisibility({ contentVisibilityAuto: true }), active: document.querySelector('[data-track-id="T1000"]').classList.contains("active"), row: __row.isConnected, mini: __mini.isConnected, time: __musicListFixture.audio().currentTime, paused: __musicListFixture.audio().paused })), { rendered: true, active: true, row: true, mini: true, time: 57, paused: false });
      await page.evaluate(() => { window.scrollTo(0, 0); __musicListFixture.render(); }); await frames(page);
      await page.evaluate(() => __musicListFixture.locate());
      await page.waitForFunction(() => { const box = document.querySelector('[data-track-id="T1000"]').getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; });
      assert.equal(await page.locator(`${flatRows}[data-track-id="T1000"]`).count(), 1);
    } finally { await page.close(); }
  });
  await run("skipped rows remain focusable and actual keyboard/click playback works", async () => {
    const page = await newPage(); try {
      await seed(page, 1000); await frames(page);
      await page.evaluate(() => document.querySelector('[data-track-id="T1000"]').focus()); await frames(page);
      assert.deepEqual(await page.evaluate(() => { const row = document.querySelector('[data-track-id="T1000"]'), box = row.getBoundingClientRect(); return { focused: document.activeElement === row, visible: box.top < innerHeight && box.bottom > 0, rendered: row.checkVisibility({ contentVisibilityAuto: true }), outline: getComputedStyle(row).outlineWidth }; }), { focused: true, visible: true, rendered: true, outline: "2px" });
      await page.keyboard.press("Enter"); await page.waitForFunction(() => __musicListFixture.state.current?.id === "T1000" && !__musicListFixture.audio().paused);
      const selected = page.locator(`${flatRows}[data-track-id="T999"]`); await selected.scrollIntoViewIfNeeded(); await selected.click();
      await page.waitForFunction(() => __musicListFixture.state.current?.id === "T999" && !__musicListFixture.audio().paused);
      assert.equal(await page.locator(`${flatRows}[data-track-id="T999"][data-current="true"].playing`).count(), 1);
    } finally { await page.close(); }
  });
  await run("smart flat rows opt in while grouped search and other views retain their CSS", async () => {
    const page = await newPage(); try {
      await page.evaluate(body => __musicListFixture.seed(body, { mode: "smart", smartId: "synthetic", query: "", searchOpen: false }), data(300)); await frames(page);
      assert.equal((await geometry(page)).contentVisibility, "auto");
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".music-mobile-mini-player")).contentVisibility), "visible");
      await page.evaluate(body => __musicListFixture.seed(body, { mode: "library", smartId: "", query: "Synthetic", searchOpen: true, searchScope: "songs", current: body.tracks[0] }), data(80)); await frames(page);
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".music-mobile-search-result-group .music-mobile-track")).contentVisibility), "visible");
    } finally { await page.close(); }
  });
}

async function heldStartup({ params = { mode: "library", dashboard: "0" }, body = data(80), smartBody = auxiliarySmart, playlistBody = auxiliaryPlaylists, error = "", ignoreAbort = false } = {}) {
  const primaryPath = params.playlistId ? `/api/music/playlists/${params.playlistId}` : params.mode === "artists" ? "/api/music/artists" : params.mode === "albums" ? "/api/music/albums" : "/api/music/tracks";
  const primary = hold(url => url.pathname === primaryPath && url.origin === base, body);
  const smart = hold(url => url.pathname === "/api/music/smart-playlists" && url.origin === base, smartBody, error);
  const playlists = hold(url => url.pathname === "/api/music/playlists" && url.origin === base, playlistBody, error);
  const page = await newPage({ params, waitReady: false, ignoreAbort });
  try {
    await Promise.all([requested(primary), requested(smart), requested(playlists)]);
    primary.release(); await page.waitForFunction(() => __musicListFixture.state.data && !__musicListFixture.state.loading); await frames(page);
    return { page, primary, smart, playlists };
  } catch (failure) { primary.release(); smart.release(); playlists.release(); await page.close(); throw failure; }
}
async function closeStartup(group) { group.primary.release(); group.smart.release(); group.playlists.release(); await group.page.close(); }
async function settleStartup(group) { group.smart.release(); group.playlists.release(); await group.page.evaluate(() => __startupTask); await frames(group.page); }
async function snapshotStartup(page) {
  await page.evaluate(() => {
    const f = __musicListFixture; f.state.current = f.state.data.tracks[0]; f.audio().paused = false; f.audio().currentTime = 37; f.render();
  }); await frames(page);
  await page.evaluate(() => { snapshot(); document.querySelector('[data-track-id="T8"]').focus(); window.scrollTo(0, 400); window.__startupAudio = __musicListFixture.audio(); __created = 0; __shellCalls.length = 0; }); await frames(page);
}
async function startupSnapshot(page) {
  return page.evaluate(() => ({ row: __row.isConnected, mini: __mini.isConnected, focused: document.activeElement?.dataset.trackId || "", scroll: scrollY, sameAudio: __startupAudio === __musicListFixture.audio(), time: __musicListFixture.audio().currentTime, paused: __musicListFixture.audio().paused, rows: document.querySelectorAll('.music-mobile-list .music-mobile-track').length, current: __musicListFixture.state.current?.id, created: __created, calls: __shellCalls.slice() }));
}
async function verifyStartupCatalogue() {
  for (const [count, error] of [[80, ""], [1000, ""], [80, "controlled side failure"]]) await run(`startup ${count}: primary first, side ${error ? "failure" : "success"} keeps rows/focus/player`, async () => {
    const group = await heldStartup({ body: data(count), error }); try {
      const { page } = group; const initialCalls = await page.evaluate(() => __shellCalls.slice());
      await snapshotStartup(page); const before = await startupSnapshot(page); await page.waitForTimeout(200);
      group.smart.release(); await page.waitForTimeout(30); await frames(page); const afterSmart = await startupSnapshot(page);
      if (legacyAuxiliary) console.log(JSON.stringify({ mode: "legacy-side-refresh", count, before, afterSmart }));
      assert.deepEqual(afterSmart, before, "smart catalogue must not rebuild the primary rows or player");
      await settleStartup(group); assert.deepEqual(await startupSnapshot(page), before, "playlist catalogue must preserve the mounted primary view");
      assert.equal(await page.evaluate(() => __shellCalls.length), 0);
      assert.deepEqual(await page.evaluate(() => ({ smart: __musicListFixture.state.smartPlaylists.map(item => item.id), playlists: __musicListFixture.state.playlists.map(item => item.id) })), error ? { smart: [], playlists: [] } : { smart: ["S-late"], playlists: ["P-late"] });
      console.log(JSON.stringify({ mode: "startup-side-refresh", count, error: Boolean(error), initialCalls, auxiliaryCalls: 0, rowsRetained: count }));
    } finally { await closeStartup(group); }
  });
  await run("home side catalogues update their cards without replacing launcher/player", async () => {
    const smartBody = { smartPlaylists: [{ ...auxiliarySmart.smartPlaylists[0], id: "topplayed" }], summary: { ...summary, recent: [track(901)], totals: { ...summary.totals, tracks: 777 } } };
    const group = await heldStartup({ params: { mode: "library" }, smartBody }); try {
      const { page } = group; await page.evaluate(() => { window.__homeLauncher = document.querySelector('.music-mobile-home-search'); window.__homeMini = document.querySelector('.music-mobile-mini-player'); __shellCalls.length = 0; });
      await settleStartup(group);
      assert.match(await page.locator('.music-mobile-smart').innerText(), /Late Smart/); assert.match(await page.locator('.music-mobile-playlists').innerText(), /Late Playlist/);
      assert.match(await page.locator('.music-mobile-recent').innerText(), /Synthetic Track 901/);
      assert.equal(await page.evaluate(() => __homeLauncher.isConnected && __homeMini.isConnected && __shellCalls.length === 0), true);
    } finally { await closeStartup(group); }
  });
  await run("collection language sidebar updates without replacing artist rows/player", async () => {
    const body = data(0, 0, { artists: Array.from({ length: 80 }, (_, index) => ({ id: `artist-${index}`, name: `Artist ${index}`, albumCount: 2, trackCount: 10 })), total: 80 });
    const smartBody = { ...auxiliarySmart, summary: { ...summary, languages: [{ name: "Late language", artistCount: 80, albumCount: 40 }] } };
    const group = await heldStartup({ params: { mode: "artists" }, body, smartBody }); try {
      const { page } = group; await page.evaluate(() => { window.__artist = document.querySelector('.music-mobile-collection-artist-row'); window.__collectionMini = document.querySelector('.music-mobile-mini-player'); __shellCalls.length = 0; });
      await settleStartup(group); assert.match(await page.locator('.music-mobile-collection-languages').innerText(), /Late language/);
      assert.equal(await page.evaluate(() => __artist.isConnected && __collectionMini.isConnected && __shellCalls.length === 0), true); assert.equal(await page.locator('.music-mobile-collection-artist-row').count(), 80);
    } finally { await closeStartup(group); }
  });
  for (const kind of ["smart", "playlist"]) for (const primaryMetadata of [false, true]) await run(`${kind} detail: ${primaryMetadata ? "primary metadata wins" : "side fallback metadata refreshes"} without rebuilding rows`, async () => {
    const smart = kind === "smart", id = smart ? "S-late" : "P-late", key = smart ? "smartPlaylist" : "playlist";
    const body = data(80, 0, primaryMetadata ? { [key]: { id, name: "Primary Metadata", description: "Authoritative primary description" } } : {});
    const group = await heldStartup({ params: smart ? { mode: "smart", smartId: id } : { mode: "playlist", playlistId: id }, body }); try {
      const { page } = group, selector = smart ? ".music-mobile-auto-hero" : ".music-mobile-playlist-hero";
      await page.evaluate(selector => { snapshot(); window.__hero = document.querySelector(selector); __shellCalls.length = 0; }, selector);
      await settleStartup(group); assert.match(await page.locator(selector).innerText(), primaryMetadata ? /Primary Metadata/ : smart ? /Late Smart/ : /Late Playlist/);
      assert.equal(await page.evaluate(() => __row.isConnected && __mini.isConnected && __shellCalls.length === 0), true);
      if (primaryMetadata) assert.equal(await page.evaluate(() => __hero.isConnected), true);
    } finally { await closeStartup(group); }
  });
  await run("visible playlist picker refresh keeps dialog/list/fullplayer and audio mounted", async () => {
    const group = await heldStartup(); try {
      const { page } = group; await page.evaluate(() => {
        const f = __musicListFixture; f.state.current = f.state.data.tracks[0]; f.state.fullscreen = true; f.state.playlistSheetOpen = true; f.audio().paused = false; f.audio().currentTime = 37; f.render();
        snapshot(); window.__picker = document.querySelector('.music-mobile-playlist-sheet'); window.__pickerList = __picker.querySelector('.music-mobile-queue-list'); window.__fullPlayer = document.querySelector('.music-mobile-full-player'); window.__startupAudio = f.audio(); __shellCalls.length = 0;
      }); await frames(page);
      await settleStartup(group); assert.match(await page.locator('.music-mobile-playlist-sheet .music-mobile-queue-list').innerText(), /Late Playlist/);
      assert.deepEqual(await page.evaluate(() => ({ row: __row.isConnected, mini: __mini.isConnected, picker: __picker.isConnected, list: __pickerList.isConnected, fullPlayer: __fullPlayer.isConnected, calls: __shellCalls.length, sameAudio: __startupAudio === __musicListFixture.audio(), time: __startupAudio.currentTime, paused: __startupAudio.paused })), { row: true, mini: true, picker: true, list: true, fullPlayer: true, calls: 0, sameAudio: true, time: 37, paused: false });
    } finally { await closeStartup(group); }
  });
  await run("mounted search accepts matching side playlists while preserving input focus", async () => {
    const group = await heldStartup({ params: { mode: "library", query: "Late", searchScope: "songs" } }); try {
      const { page } = group; await page.evaluate(() => { __musicListFixture.state.searchScope = "playlists"; __musicListFixture.render(); }); await frames(page);
      await page.locator('.music-mobile-search-input').focus(); await page.evaluate(() => { window.__input = document.querySelector('.music-mobile-search-input'); __shellCalls.length = 0; });
      await settleStartup(group); assert.match(await page.locator('.music-mobile-search-playlist-list').innerText(), /Late Playlist/);
      assert.equal(await page.evaluate(() => __input.isConnected && document.activeElement === __input && __shellCalls.length === 0), true);
    } finally { await closeStartup(group); }
  });
  for (const intent of ["navigation", "deactivate", "url"]) for (const error of ["", "obsolete side error"]) await run(`old startup side ${error ? "error" : "success"} ignored after ${intent}`, async () => {
    const group = await heldStartup({ params: { mode: "library", dashboard: "0", trackId: "T999" }, error, ignoreAbort: true }); try {
      const { page } = group;
      if (intent === "deactivate") await page.evaluate(() => __fixtureLeave());
      else {
        if (intent === "url") await page.evaluate(() => { __fixtureActiveUrl = __fixtureAlternateUrl; });
        const origin = intent === "url" ? alternateBase : base;
        const smart = hold(url => url.origin === origin && url.pathname === "/api/music/smart-playlists", { smartPlaylists: [{ id: "S-new", name: "Current Smart" }] });
        const playlists = hold(url => url.origin === origin && url.pathname === "/api/music/playlists", { playlists: [{ id: "P-new", name: "Current Playlist" }] });
        await page.evaluate(() => { window.__newStartup = __fixtureRoute({ mode: "library", dashboard: "0", favorite: "1" }); });
        await Promise.all([requested(smart), requested(playlists)]); smart.release(); playlists.release(); await page.evaluate(() => __newStartup); await frames(page);
      }
      const read = () => page.evaluate(() => ({ smart: __musicListFixture.state.smartPlaylists.map(item => item.id), playlists: __musicListFixture.state.playlists.map(item => item.id), status: __musicListFixture.state.status, loading: __musicListFixture.state.loading, rows: document.querySelectorAll('.music-mobile-track').length, title: document.querySelector('#viewTitle').textContent }));
      const before = await read(), count = requests.filter(key => /^\/api\/music\/tracks\/T999/.test(key)).length;
      await page.evaluate(() => { window.__keptRow = document.querySelector('.music-mobile-track'); window.__keptMini = document.querySelector('.music-mobile-mini-player'); __shellCalls.length = 0; });
      await settleStartup(group); assert.deepEqual(await read(), before);
      assert.equal(await page.evaluate(() => __keptRow.isConnected && __keptMini.isConnected && __shellCalls.length === 0), true);
      assert.equal(requests.filter(key => /^\/api\/music\/tracks\/T999/.test(key)).length, count, "old outer track continuation must not issue a detail GET");
    } finally { await closeStartup(group); }
  });
  await run("new user selection during held startup is not replaced by old deep-link continuation", async () => {
    const group = await heldStartup({ params: { mode: "library", dashboard: "0", trackId: "T999" } });
    const detail = hold(url => url.pathname === "/api/music/tracks/T2", { track: track(2), lyrics: { lines: [] } }); try {
      const { page } = group; await page.locator('[data-track-id="T2"]').click(); await requested(detail);
      const reads = requests.filter(key => /^\/api\/music\/tracks\/T999/.test(key)).length;
      await settleStartup(group); assert.equal(await page.evaluate(() => __musicListFixture.state.loading), true, "old continuation cannot clear a newer pending selection");
      assert.equal(requests.filter(key => /^\/api\/music\/tracks\/T999/.test(key)).length, reads);
      detail.release(); await page.waitForFunction(() => __musicListFixture.state.current?.id === "T2" && !__musicListFixture.audio().paused);
    } finally { detail.release(); await closeStartup(group); }
  });
  for (const error of ["", "obsolete primary error"]) await run(`primary late ${error ? "error" : "success"} preserves a newer pending selection and its queue`, async () => {
    const page = await newPage(), primary = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("favorite") === "1", data(80, 100), error);
    const detail = hold(url => url.pathname === "/api/music/tracks/T2", { track: track(2), lyrics: { lines: [] } });
    try {
      await page.evaluate(() => { window.__newStartup = __fixtureRoute({ mode: "library", dashboard: "0", favorite: "1" }); }); await requested(primary);
      await page.locator('[data-track-id="T2"]').click(); await requested(detail); await frames(page);
      const read = () => page.evaluate(() => ({ loading: __musicListFixture.state.loading, status: __musicListFixture.state.status, queue: __musicListFixture.state.queue.map(item => item.id), rows: [...document.querySelectorAll('.music-mobile-list .music-mobile-track')].map(item => item.dataset.trackId), current: __musicListFixture.state.current?.id || "" }));
      const before = await read(); assert.equal(before.loading, true); assert.equal(before.queue[0], "T1");
      await page.evaluate(() => { snapshot(); __shellCalls.length = 0; });
      primary.release(); await page.evaluate(() => __newStartup); await frames(page); assert.deepEqual(await read(), before);
      assert.equal(await page.evaluate(() => __row.isConnected && __mini.isConnected && __shellCalls.length === 0), true);
      detail.release(); await page.waitForFunction(() => __musicListFixture.state.current?.id === "T2" && !__musicListFixture.audio().paused);
    } finally { primary.release(); detail.release(); await page.close(); }
  });
  for (const [kind, error] of [["smart", "obsolete refresh error"], ["playlists", ""]]) await run(`same-kind ${kind} refresh retains latest response after old ${error ? "error" : "success"}`, async () => {
    const page = await newPage({ ignoreAbort: true }); const endpoint = kind === "smart" ? "/api/music/smart-playlists" : "/api/music/playlists", field = kind === "smart" ? "smartPlaylists" : "playlists";
    const old = hold(url => url.pathname === endpoint, { [field]: [{ id: "old", name: "Old" }] }, error), latest = hold(url => url.pathname === endpoint, { [field]: [{ id: "latest", name: "Latest" }] });
    try {
      await page.evaluate(kind => { window.__oldRefresh = __musicListFixture.side(kind); }, kind); await requested(old);
      await page.evaluate(kind => { window.__latestRefresh = __musicListFixture.side(kind); }, kind); await requested(latest); latest.release(); await page.evaluate(() => __latestRefresh);
      old.release(); await page.evaluate(() => __oldRefresh); assert.deepEqual(await page.evaluate(field => __musicListFixture.state[field].map(item => item.id), field), ["latest"]);
    } finally { old.release(); latest.release(); await page.close(); }
  });
}

async function searchOverviewSnapshot(page) {
  return page.evaluate(() => ({
    overview: __musicListFixture.state.searchOverview,
    row: __overviewRow.isConnected,
    input: __overviewInput.isConnected,
    inputFocused: document.activeElement === __overviewInput,
    mini: __overviewMini?.isConnected ?? null,
    sameAudio: __overviewAudio === __musicListFixture.audio(),
    current: __musicListFixture.state.current?.id,
    queue: __musicListFixture.state.queue.map(item => item.id),
    time: __overviewAudio.currentTime,
    paused: __overviewAudio.paused,
    rows: document.querySelectorAll('.music-mobile-list .music-mobile-track').length,
    created: __created
  }));
}

async function snapshotSearchOverview(page) {
  await page.locator('.music-mobile-search-input').focus();
  await page.evaluate(() => {
    window.__overviewRow = document.querySelector('.music-mobile-list .music-mobile-track');
    window.__overviewInput = document.querySelector('.music-mobile-search-input');
    window.__overviewMini = document.querySelector('.music-mobile-mini-player');
    window.__overviewAudio = __musicListFixture.audio();
    __created = 0;
  });
  return searchOverviewSnapshot(page);
}

async function prepareSearchOverview(page, query) {
  await page.evaluate(query => {
    const f = __musicListFixture;
    f.state.current = f.state.data.tracks[0]; f.state.searchScope = 'songs';
    f.audio().paused = false; f.audio().currentTime = 37; f.render();
    window.__oldOverviewSearch = f.search(query);
  }, query);
}

async function verifySearchOverviewOwnership() {
  const artists = name => ({ artists: [{ id: name, name, trackCount: 3, albumCount: 1 }], total: 1 });
  const emptyAlbums = { albums: [], total: 0 };
  for (const ignoreAbort of [false, true]) for (const error of ["", "obsolete overview error"]) await run(`same-query overview ignores ${ignoreAbort ? "ignored-abort" : "normal-abort"} old ${error ? "503" : "success"}`, async () => {
    const page = await newPage({ ignoreAbort });
    const matches = endpoint => url => url.pathname === endpoint && url.searchParams.get('q') === 'Repeat';
    const oldArtist = hold(matches('/api/music/artists'), artists('Old Artist'), error);
    const oldAlbum = hold(matches('/api/music/albums'), emptyAlbums, error);
    let latestPrimary, latestArtist, latestAlbum;
    try {
      await prepareSearchOverview(page, 'Repeat');
      await Promise.all([requested(oldArtist), requested(oldAlbum)]);
      latestPrimary = hold(matches('/api/music/tracks'), data(80));
      latestArtist = hold(matches('/api/music/artists'), artists('Latest Artist'));
      latestAlbum = hold(matches('/api/music/albums'), emptyAlbums);
      await page.evaluate(() => { window.__latestOverviewSearch = __musicListFixture.search('Repeat'); });
      await requested(latestPrimary);
      if (!ignoreAbort) {
        // Normal abort rejects both old requests while the newer primary is held.
        // Those rejections must not clear the newer overview's loading state.
        await page.evaluate(() => __oldOverviewSearch);
        assert.deepEqual(await page.evaluate(() => __musicListFixture.state.searchOverview), {
          loading: true, artists: [], albums: [], artistTotal: 0, albumTotal: 0, error: ''
        });
      }
      latestPrimary.release(); await Promise.all([requested(latestArtist), requested(latestAlbum)]);
      latestArtist.release(); latestAlbum.release(); await page.evaluate(() => __latestOverviewSearch); await frames(page);
      const before = await snapshotSearchOverview(page);
      assert.equal(before.overview.artists[0]?.name, 'Latest Artist'); assert.equal(before.overview.error, '');
      oldArtist.release(); oldAlbum.release(); await page.evaluate(() => __oldOverviewSearch); await frames(page);
      assert.deepEqual(await searchOverviewSnapshot(page), before, "an old classification response must preserve the newer results, mounted rows, focus and player");
    } finally {
      for (const gate of [oldArtist, oldAlbum, latestPrimary, latestArtist, latestAlbum]) gate?.release();
      await page.close();
    }
  });
  for (const error of ["", "obsolete server overview error"]) await run(`old server overview ${error ? "503" : "success"} keeps the new server search mounted`, async () => {
    const page = await newPage({ ignoreAbort: true });
    const matches = endpoint => url => url.origin === base && url.pathname === endpoint && url.searchParams.get('q') === 'Server';
    const oldArtist = hold(matches('/api/music/artists'), artists('Old Server Artist'), error);
    const oldAlbum = hold(matches('/api/music/albums'), emptyAlbums, error);
    try {
      await prepareSearchOverview(page, 'Server'); await Promise.all([requested(oldArtist), requested(oldAlbum)]);
      // The host changes its server URL and renders the same music module. Its
      // route signal changes; the mounted search has a separate, un-aborted signal.
      await page.evaluate(() => {
        __fixtureActiveUrl = __fixtureAlternateUrl;
        return __fixtureRoute({ mode: 'library', dashboard: '0', query: 'Server', searchScope: 'songs' });
      }); await frames(page);
      const before = await snapshotSearchOverview(page);
      assert.deepEqual(before.overview.artists, []); assert.equal(before.overview.error, '');
      oldArtist.release(); oldAlbum.release(); await page.evaluate(() => __oldOverviewSearch); await frames(page);
      assert.deepEqual(await searchOverviewSnapshot(page), before, "the previous server's classification must not write into this search");
    } finally { oldArtist.release(); oldAlbum.release(); await page.close(); }
  });
  await run("current overview retains its successful classification when the other endpoint fails", async () => {
    const page = await newPage();
    const artist = hold(url => url.pathname === '/api/music/artists' && url.searchParams.get('q') === 'Partial', artists('Available Artist'));
    const album = hold(url => url.pathname === '/api/music/albums' && url.searchParams.get('q') === 'Partial', null, 'current album failure');
    try {
      await prepareSearchOverview(page, 'Partial'); await Promise.all([requested(artist), requested(album)]);
      artist.release(); album.release(); await page.evaluate(() => __oldOverviewSearch);
      assert.deepEqual(await page.evaluate(() => __musicListFixture.state.searchOverview), {
        loading: false, artists: artists('Available Artist').artists, albums: [], artistTotal: 1, albumTotal: 0, error: ''
      });
    } finally { artist.release(); album.release(); await page.close(); }
  });
}
