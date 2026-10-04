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
const containmentRule = /\/\* Flat rows: 51px content[^]*?\n}\r?\n/;
const stylesSource = fs.readFileSync(path.join(www, "styles.css"), "utf8");
assert.match(stylesSource, containmentRule, "the full Android entry must include the flat-row rule");
const baselineStyles = stylesSource.replace(containmentRule, "");
const flatRows = ".music-mobile-shell > .music-mobile-list > .music-mobile-track";
const median = values => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(value => fs.existsSync(value));
assert(executablePath, "Chrome or Edge required for the private Android music fixture");
let viewsSource = fs.readFileSync(path.join(www, "modules/music/music-views.js"), "utf8");
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
viewsSource = viewsSource.replace("  function renderShell() {", `
  function renderShell() {
    const started = performance.now(), before = window.__created;
    try { return renderShellMeasured(); }
    finally { window.__shellCalls.push({ ms: performance.now() - started, created: window.__created - before, rows: els.viewContent.querySelectorAll('.music-mobile-list .music-mobile-track').length }); }
  }
  function renderShellMeasured() {`);
viewsSource = viewsSource.replace("  installLifecycle();", `
  window.__musicListFixture = {
    state, audio: () => audio,
    seed: (data, options = {}) => {
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
let browser, checks = 0;
const requestHandler = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-FanHao-Client, X-FanHao-Account-Owner");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, `http://${req.headers.host}`);
  requests.push(`${url.pathname}${url.search}`);
  try {
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
    if (url.pathname === "/api/music/smart-playlists") { json(res, { smartPlaylists: [] }); return; }
    if (url.pathname === "/api/music/playlists") { json(res, { playlists: [] }); return; }
    if (/^\/api\/music\/(?:smart-playlists|playlists)\/[^/]+$/.test(url.pathname)) { json(res, data(80)); return; }
    if (url.pathname === "/api/music/artists") { json(res, { artists: [], total: 0, summary }); return; }
    if (url.pathname === "/api/music/albums") { json(res, { albums: [], total: 0, summary }); return; }
    if (url.pathname === "/api/music/search-lyrics") { json(res, { matches: [], total: 0 }); return; }
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
    const source = url.pathname === "/modules/music/music-views.js" ? viewsSource : url.pathname === "/modules/music/music-list-pagination.js" ? paginationSource : url.pathname === "/styles.css" ? (legacyContainment ? baselineStyles : stylesSource) : await fs.promises.readFile(target);
    res.writeHead(200, { "Content-Type": target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : "application/octet-stream" }); res.end(source);
  } catch (error) { unexpected.push(`${url.pathname}: ${error.message}`); if (!res.destroyed) json(res, { error: error.message }, 500); }
};
const server = createServer(requestHandler), alternateServer = createServer(requestHandler);
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
await new Promise(resolve => alternateServer.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const alternateBase = `http://127.0.0.1:${alternateServer.address().port}`;
const run = async (name, task) => { await task(); checks++; console.log(`${measureOnly ? "MEASURE" : "PASS"} ${name}`); };
try {
  browser = await chromium.launch({ executablePath, headless: true });
  for (const count of [300, 1000]) await run(`flat library ${count}: loading and append preserve rows/player`, async () => {
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
  if (!measureOnly) {
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
    await verifyContainedRows();
    await verifyStartupCatalogue();
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    console.log(`PASS Android music list rendering: ${checks} actual Chromium scenarios`);
  } else console.log("DIAGNOSTIC legacy rendering only; correctness assertions not run");
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
async function newPage({ ignoreAbort = false, containment = true, width = 430, waitReady = true, params = null } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 } }); page.on("pageerror", error => errors.push(error.message));
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
  await page.goto(url.href, { waitUntil: waitReady ? "load" : "domcontentloaded" });
  await page.waitForFunction(waitReady ? () => Boolean(window.__ready) : () => Boolean(window.__startupTask)); return page;
}
function harness(url) {
  // Use the actual entry/cascade and shell classes: relinking module CSS after
  // home.css would override its 66px row geometry and invalidate layout evidence.
  return `<!doctype html><meta charset=utf-8><link rel=stylesheet href=/styles.css><body class=music-mobile-view><main class=app-shell><section id=contentPanel class=content-panel><div class=section-head><div><p id=viewKicker class=section-label></p><h2 id=viewTitle></h2></div></div><div id=viewMeta class=view-meta></div><div id=viewContent class=content-list aria-live=polite></div></section></main><script type=module>
import{createMusicViews}from'/modules/music/music-views.js';const els=Object.fromEntries(['viewKicker','viewTitle','viewMeta','viewContent'].map(id=>[id,document.getElementById(id)])),noop=()=>{};
window.__fixtureActiveUrl=location.origin;window.__fixtureAlternateUrl=${JSON.stringify(alternateBase)};
const page=createMusicViews({els,getActiveUrl:()=>__fixtureActiveUrl,setActiveBottom:noop,showView:noop,replaceViewParams:noop});
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
async function verifyContainedRows() {
  for (const count of [80, 1000]) await run(`full CSS flat ${count}: calibrated scroll extent and cold layout`, async () => {
    const current = await newPage(), baseline = await newPage({ containment: false });
    try {
      assert.equal(await current.evaluate(() => CSS.supports("content-visibility", "auto") && CSS.supports("contain-intrinsic-block-size", "auto 51px")), true);
      const body = data(count), before = await layoutSamples(baseline, body), after = await layoutSamples(current, body);
      const oldGeometry = await geometry(baseline), newGeometry = await geometry(current);
      assert.equal(newGeometry.contentVisibility, "auto", "actual full CSS must skip offscreen flat rows");
      assert.equal(newGeometry.intrinsic, "auto 51px"); assert.equal(oldGeometry.contentVisibility, "visible");
      assert.equal(newGeometry.count, count); assert.equal(newGeometry.first, 66); assert.equal(newGeometry.last, 66);
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
          return { rendered: row.checkVisibility({ contentVisibilityAuto: true }), height: bounds.height, visible: bounds.top >= 0 && bounds.bottom <= innerHeight, inside: children.every(child => { const box = child.getBoundingClientRect(); return box.top >= bounds.top && box.bottom <= bounds.bottom; }), titleTruncated: row.querySelector("strong").scrollWidth > row.querySelector("strong").clientWidth };
        }, flatRows);
        assert.deepEqual(visible, { rendered: true, height: 66, visible: true, inside: true, titleTruncated: true });
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
