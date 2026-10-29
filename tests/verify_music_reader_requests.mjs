import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Actual /music index/standalone host and actual createMusicPage in Chromium.
// Private loopback synthetic APIs/SVGs; Audio is controlled, never decoded.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(root, "public");

export async function runMusicReaderFixture({ legacyMusic = false, legacyHost = false, legacySearchAppend = false, sourceOverrides = {}, casePattern = "" } = {}) {
  const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"]
    .filter(Boolean).find(value => fs.existsSync(value));
  assert(executablePath, "Chrome or Edge required for private music browser fixture");
  const overrides = new Map(sourceOverrides instanceof Map ? sourceOverrides : Object.entries(sourceOverrides));
  for (const relative of [...(legacyMusic ? ["public/modules/music/music-page.js", "public/modules/music/actions.js"] : []), ...(legacyHost ? ["public/js/standalone-host.js"] : [])]) {
    const result = spawnSync("git", ["show", `HEAD:${relative}`], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); overrides.set(`/${relative.slice(7)}`, result.stdout);
  }
  if (legacySearchAppend) {
    // Only remove the new query guard in memory: use the actual previous raw
    // append branch without changing request ownership or playback behavior.
    const source = fs.readFileSync(path.join(publicRoot, "modules/music/actions.js"), "utf8");
    assert.match(source, /!music\(\)\.query && Boolean\(music\(\)\.current\) && view\.appendLibraryTrackPage/);
    overrides.set("/modules/music/actions.js", source.replace("!music().query && Boolean(music().current) && view.appendLibraryTrackPage", "Boolean(music().current) && view.appendLibraryTrackPage"));
  }
  const held = new Set(), requests = new Map(), faults = [], unexpected = [];
  const pageStartupFailures = new WeakMap();
  const methodRequests = [], playlistMutations = [];
  const ratingValues = new Map();
  const ratingSubmissions = [];
  let queuePlaylistSaveEnabled = false;
  const queuePlaylistSaves = [];
  let playlistState = null;
  let historyState = null;
  const progressSessions = new Map(), progressHeads = new Map();
  let progressClockMs = Date.now();
  const browserPageLimit = 80;
  let browser = null, checks = 0, browserCases = 0, browserPages = 0, totalBrowserPages = 0, browserRestarts = 0;
  const activeSockets = new Set(), socketErrors = [];
  let connectionsCreated = 0, peakConnections = 0, musicModuleRequests = 0;
  const connectionSnapshot = () => ({ created: connectionsCreated, closed: connectionsCreated - activeSockets.size, active: activeSockets.size, peak: peakConnections, errors: socketErrors.slice() });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture"), key = `${url.pathname}${url.search}`;
    requests.set(key, (requests.get(key) || 0) + 1);
    if (req.method === "GET" && url.pathname === "/modules/music/music-page.js") musicModuleRequests++;
    methodRequests.push({ method: req.method, path: url.pathname });
    try {
      const progressWrite = req.method === "POST" && /^\/api\/music\/tracks\/[^/]+\/progress$/.test(url.pathname);
      const progressClaim = req.method === "POST" && /^\/api\/music\/tracks\/([^/]+)\/progress-session$/.exec(url.pathname);
      const ratingWrite = req.method === "POST" && /^\/api\/music\/tracks\/([^/]+)\/rating$/.exec(url.pathname);
      const favoriteWrite = req.method === "POST" && /^\/api\/music\/tracks\/[^/]+\/favorite$/.test(url.pathname);
      const queuePlaylistCreate = queuePlaylistSaveEnabled && req.method === "POST" && url.pathname === "/api/music/playlists";
      const playlistEdit = req.method === "PUT" && url.pathname === "/api/music/playlists/new";
      const playlistAdd = req.method === "POST" && url.pathname === "/api/music/playlists/new/tracks";
      const playlistRemove = req.method === "DELETE" && url.pathname === "/api/music/playlists/new/tracks/P";
      const playlistDelete = req.method === "DELETE" && url.pathname === "/api/music/playlists/new";
      const playlistOrder = req.method === "PUT" && url.pathname === "/api/music/playlists/new/tracks/order";
      const playlistMutation = playlistEdit || playlistAdd || playlistRemove || playlistDelete || playlistOrder;
      const historyDelete = req.method === "DELETE" && url.pathname === "/api/music/history";
      assert(req.method === "GET" || progressWrite || progressClaim || ratingWrite || favoriteWrite || queuePlaylistCreate || (playlistState && playlistMutation) || (historyState && historyDelete), `unexpected synthetic mutation: ${req.method} ${key}`);
      const body = ["POST", "PUT"].includes(req.method) ? JSON.parse(await readBody(req)) : null;
      if (ratingWrite) ratingSubmissions.push({ id: decodeURIComponent(ratingWrite[1]), rating: body.rating });
      if (favoriteWrite) assert.deepEqual(Object.keys(body), ["favorite"]);
      if (queuePlaylistCreate) { assert.deepEqual(Object.keys(body).sort(), ["description", "name", "trackIds"]); queuePlaylistSaves.push(body); }
      if (historyDelete) assert.equal(await readBody(req), "", "history DELETE must not send a body");
      if (playlistMutation) {
        assert(playlistState?.has("new"), "playlist mutation requires its private case state");
        if (playlistEdit) assert.deepEqual(body, { name: "Renamed playlist", description: "Edited in fixture" });
        else if (playlistAdd) assert.deepEqual(body, { trackId: "B" });
        else if (playlistOrder) {
          assert.deepEqual(Object.keys(body), ["trackIds"]);
          assert(body.trackIds.length > 0 && new Set(body.trackIds).size === body.trackIds.length);
          assert(body.trackIds.every(id => ["P", "A", "B"].includes(id)));
        }
        else assert.equal(await readBody(req), "", "playlist DELETE must not send a body");
        playlistMutations.push({ method: req.method, path: url.pathname, body });
      }
      const gate = [...held].find(value => !value.used && value.match(url, req.method));
      if (gate) {
        gate.used = true; gate.url = key; gate.method = req.method; res.once("close", () => { gate.closed = true; }); res.once("finish", () => { gate.finished = true; }); gate.requestedResolve(); await gate.promise;
        if (gate.error) { sendJson(res, { error: gate.error }, 503); return; }
        if (gate.body) { sendJson(res, gate.body); return; }
      }
      if (url.pathname === "/probe") { sendText(res, harness(url.searchParams.has("queue-search-shell")), "text/html; charset=utf-8"); return; }
      if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      if (queuePlaylistCreate) {
        const playlist = { ...body, id: "queue-saved" }; playlistState.set(playlist.id, playlist);
        sendJson(res, { playlist: playlistSummary(playlist) }); return;
      }
      if (historyState && url.pathname === "/api/music/history") {
        if (historyDelete) { historyState.trackIds = []; historyState.cleared += 1; sendJson(res, { ok: true }); }
        else sendJson(res, { tracks: historyState.trackIds.map(track), total: historyState.trackIds.length, hasMore: false, summary: summary(), artists: artists(), albums: albums(), genres: [] });
        return;
      }
      if (playlistMutation) {
        const playlist = playlistState.get("new");
        if (playlistEdit) Object.assign(playlist, body);
        else if (playlistAdd && !playlist.trackIds.includes(body.trackId)) playlist.trackIds.push(body.trackId);
        else if (playlistRemove) playlist.trackIds = playlist.trackIds.filter(id => id !== "P");
        else if (playlistDelete) playlistState.delete("new");
        else if (playlistOrder) playlist.trackIds = [...body.trackIds, ...playlist.trackIds.filter(id => !body.trackIds.includes(id))];
        sendJson(res, playlistDelete ? { ok: true } : playlistDetail("new")); return;
      }
      const playlistRead = /^\/api\/music\/playlists\/([^/]+)$/.exec(url.pathname);
      if (playlistRead && playlistState) {
        const detail = playlistDetail(decodeURIComponent(playlistRead[1]));
        sendJson(res, detail || { error: "synthetic playlist not found" }, detail ? 200 : 404); return;
      }
      if (ratingWrite) {
        assert(Number.isInteger(body?.rating) && body.rating >= 0 && body.rating <= 5 && Object.keys(body).length === 1);
        const id = decodeURIComponent(ratingWrite[1]); ratingValues.set(id, body.rating);
        sendJson(res, { track: { ...track(id), rating: body.rating } }); return;
      }
      if (progressClaim) {
        const trackId = decodeURIComponent(progressClaim[1]), active = progressHeads.get(trackId);
        assert(body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).every(name => name === "previousSessionId"), "synthetic claim body must match the server contract");
        if (body.previousSessionId !== undefined) assert.match(body.previousSessionId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
        if (active && active.progressSessionId === body.previousSessionId) { sendJson(res, { ...active, serverClockMs: Math.max(Date.now(), progressClockMs) }); return; }
        progressClockMs = Math.max(Date.now(), progressClockMs) + 1;
        const session = { trackId, progressSessionId: randomUUID(), progressSessionStartedAt: progressClockMs };
        progressSessions.set(session.progressSessionId, session); sendJson(res, { ...session, serverClockMs: progressClockMs }); return;
      }
      if (progressWrite) {
        const session = progressSessions.get(body.progressSessionId);
        if (session && session.trackId === decodeURIComponent(url.pathname.split("/").at(-2)) && session.progressSessionStartedAt === body.progressSessionStartedAt) {
          const active = progressHeads.get(session.trackId);
          if (!active || active.progressSessionStartedAt <= session.progressSessionStartedAt) progressHeads.set(session.trackId, session);
        }
        sendJson(res, { ok: true }); return;
      }
      const trackMatch = /^\/api\/music\/tracks\/([^/]+)$/.exec(url.pathname);
      if (trackMatch) { const id = decodeURIComponent(trackMatch[1]); sendJson(res, { track: { ...track(id), rating: ratingValues.get(id) || 0 }, lyrics: lyrics(id), prevId: "", nextId: "" }); return; }
      if (url.pathname === "/api/music/tracks") {
        const data = trackList(url); data.tracks = data.tracks.map(track => ({ ...track, rating: ratingValues.get(track.id) || 0 }));
        if (url.searchParams.get("sort") === "rating") data.tracks.sort((a, b) => b.rating - a.rating);
        sendJson(res, data); return;
      }
      if (url.pathname === "/api/music/artists") { sendJson(res, { artists: artists(), total: 2, hasMore: false, summary: summary() }); return; }
      if (url.pathname === "/api/music/albums") { sendJson(res, { albums: albums(), total: 1, hasMore: false, summary: summary() }); return; }
      if (url.pathname === "/api/music/playlists") { sendJson(res, { playlists: playlistState ? [...playlistState.values()].map(playlistSummary) : [{ id: "new", name: "New playlist", trackCount: 2 }] }); return; }
      if (url.pathname === "/api/music/smart-playlists") { sendJson(res, { smartPlaylists: [{ id: "new-smart", name: "New smart", trackCount: 2 }] }); return; }
      if (url.pathname === "/api/music/suggest") { sendJson(res, { tracks: [], artists: [], albums: [] }); return; }
      if (url.pathname === "/api/modules") { sendJson(res, { product: { id: "suite" }, modules: [] }); return; }
      if (url.pathname.startsWith("/api/")) { unexpected.push(key); sendJson(res, { error: "unmodelled synthetic API" }, 404); return; }
      if (url.pathname.startsWith("/synthetic/audio/")) { unexpected.push(key); sendJson(res, { error: "controlled Audio must not fetch stream" }, 500); return; }
      if (url.pathname.startsWith("/synthetic/") || url.pathname === "/assets/music/turntable-dark-v1.png") {
        sendText(res, '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#729b7c"/></svg>', "image/svg+xml", "public, max-age=86400"); return;
      }
      if (overrides.has(url.pathname)) { sendText(res, overrides.get(url.pathname), url.pathname.endsWith(".css") ? "text/css" : "text/javascript"); return; }
      const target = /^\/music(?:\/|$)/.test(url.pathname) ? path.join(publicRoot, "index.html") : path.resolve(publicRoot, url.pathname.replace(/^\/+/, ""));
      assert(target.startsWith(`${publicRoot}${path.sep}`), "fixture static paths must stay in public");
      const type = target.endsWith(".html") ? "text/html; charset=utf-8" : target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : target.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";
      sendText(res, await fs.promises.readFile(target), type);
    } catch (error) { unexpected.push(`${key}: ${error.message}`); if (!res.destroyed) sendJson(res, { error: error.message }, 500); }
  });
  server.on("connection", socket => {
    connectionsCreated++; activeSockets.add(socket); peakConnections = Math.max(peakConnections, activeSockets.size);
    socket.once("close", () => activeSockets.delete(socket));
    socket.once("error", error => {
      socketErrors.push({ code: error.code, syscall: error.syscall });
      if (socketErrors.length > 4) socketErrors.shift();
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const run = async (name, task) => {
    if (casePattern && !name.includes(casePattern)) return;
    if (browserPages >= browserPageLimit) {
      assert.equal(browser.contexts().length, 0, `completed music cases must release their contexts before recycling: ${name}`);
      console.log("MUSIC_BROWSER_RECYCLE", JSON.stringify({ completed: checks, browserCases, browserPages, totalBrowserPages, contexts: 0, connections: connectionSnapshot(), next: name }));
      await browser.close();
      browser = null;
      browser = await chromium.launch({ executablePath, headless: true });
      browserCases = 0; browserPages = 0;
      browserRestarts++;
    }
    // browser.newPage owns a fresh context; page.close must release it before
    // another case starts. Never recycle/retry a case which threw an error.
    await task();
    assert.equal(browser.contexts().length, 0, `music case leaked a browser context: ${name}`);
    checks++; browserCases++;
    console.log(`PASS ${name}`);
  };
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    await verifyQueueSearch();
    await verifySearchDuplicateSessions();
    for (const ignoreAbort of [true, false]) {
      const transport = ignoreAbort ? "ignore-abort" : "normal";
      if (ignoreAbort) for (const mode of ["library", "artists", "albums"]) await run(`list more keyboard ${mode} preserves Space and advances to new results`, async () => {
        const { page, endpoint, rows, firstCount } = await newMoreKeyboardPage(mode, { width: mode === "library" ? 320 : 1440 });
        try {
          const playing = await playlistPlaybackState(page);
          await page.locator(rows).evaluateAll(items => { window.__originalMoreItems = items; });
          let offset = firstCount;
          for (const last of [false, true]) {
            const count = mode === "library" && last ? 60 : firstCount, data = moreKeyboardData(mode, offset, count, !last);
            const read = hold(url => url.pathname === endpoint && url.searchParams.get("offset") === String(offset), "", data);
            const before = countRequests(read.match), button = page.locator(".music-load-more");
            try {
              await button.focus(); await page.keyboard.press("Space"); await requested(read);
              assert.equal(await button.evaluate(button => document.activeElement === button && !button.disabled), true, "a pending continuation must retain its native keyboard focus");
              assert.equal(await button.getAttribute("aria-disabled"), "true"); assert.equal(await button.getAttribute("aria-busy"), "true");
              await page.keyboard.press("Space"); await tick(page);
              assert.equal(countRequests(read.match) - before, 1, "repeated Space must share one list continuation request");
              assert.deepEqual(await playlistPlaybackState(page), playing, "waiting for more results must never start paused music");
              await settle(page, read);
              assert.equal(await page.evaluate(() => __originalMoreItems.every(item => item.isConnected)), true, "in-place continuation must retain existing result nodes");
              await assertMoreFocus(page, mode, offset);
              if (mode === "library" && !last && process.env.MUSIC_MORE_SCREENSHOT) await page.screenshot({ path: process.env.MUSIC_MORE_SCREENSHOT });
              assert.deepEqual(await playlistPlaybackState(page), playing);
              await page.keyboard.press("Tab");
              assert.equal(await page.evaluate(({ mode, offset }) => mode === "library" ? document.activeElement.closest(".music-track-row")?.dataset.musicTrackId === `MORE-${offset}`
                : document.activeElement === document.querySelectorAll(mode === "artists" ? ".music-artist-browser-card" : ".music-album-browser-card")[offset + 1], { mode, offset }), true, "native Tab must continue through the newly delivered result order");
            } finally { read.release(); held.delete(read); }
            offset += count;
          }
          assert.equal(await page.locator(".music-load-more").count(), 0);
        } finally { await page.close(); }
      });
      if (ignoreAbort) for (const mode of ["library", "artists", "albums"]) await run(`list more keyboard ${mode} retries its original offset after failure`, async () => {
        const { page, endpoint, rows, firstCount } = await newMoreKeyboardPage(mode);
        const failed = hold(url => url.pathname === endpoint && url.searchParams.get("offset") === String(firstCount), "Synthetic continuation failure");
        const retried = hold(url => url.pathname === endpoint && url.searchParams.get("offset") === String(firstCount), "", moreKeyboardData(mode, firstCount, firstCount, false));
        try {
          const playing = await playlistPlaybackState(page);
          await page.locator(rows).evaluateAll(items => { window.__originalMoreItems = items; });
          await page.locator(".music-load-more").evaluate(button => { window.__failedMore = button; });
          await page.locator(".music-load-more").focus(); await page.keyboard.press("Space"); await requested(failed); await page.keyboard.press("Space"); await settle(page, failed);
          assert.equal(await page.evaluate(() => __failedMore.isConnected && document.activeElement === __failedMore && !__failedMore.disabled), true, "a failed continuation must leave its original focused button available for retry");
          assert.equal(await page.locator(".music-load-more").getAttribute("aria-disabled"), "false");
          assert((await page.locator(".music-list-append-error").textContent()).includes("Synthetic continuation failure"));
          assert.equal(await page.evaluate(() => __originalMoreItems.every(item => item.isConnected)), true);
          assert.deepEqual(await playlistPlaybackState(page), playing);
          await page.keyboard.press("Space"); await requested(retried); await page.keyboard.press("Space"); await tick(page);
          assert.deepEqual(await playlistPlaybackState(page), playing, "retrying a continuation must not start paused music");
          await settle(page, retried); await assertMoreFocus(page, mode, firstCount);
          assert.equal(await page.locator(".music-list-append-error").count(), 0);
          assert.equal(await page.locator(".music-load-more").count(), 0);
        } finally { for (const read of [failed, retried]) { read.release(); held.delete(read); } await page.close(); }
      });
      if (ignoreAbort) await run("list more keyboard query fallback retains a wheel accepted while pending", async () => {
        const { page, endpoint, firstCount } = await newMoreKeyboardPage("library", { data: moreKeyboardData("library", 0, 120, true), query: "Needle" });
        const read = hold(url => url.pathname === endpoint && url.searchParams.get("offset") === String(firstCount), "", moreKeyboardData("library", firstCount, 120, true));
        try {
          const playing = await playlistPlaybackState(page), more = page.locator(".music-load-more");
          await more.focus(); await more.scrollIntoViewIfNeeded();
          const before = await page.locator(".music-track-panel").evaluate(panel => { const r = panel.getBoundingClientRect(); return { top: panel.scrollTop, x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
          assert(before.top > 500, "the continuation must start inside a genuinely scrollable long result list");
          await page.keyboard.press("Space"); await requested(read);
          await page.mouse.move(before.x, before.y); await page.mouse.wheel(0, -450);
          await page.waitForFunction(top => document.querySelector(".music-track-panel").scrollTop < top - 100, before.top);
          await page.evaluate(() => new Promise(resolve => { let previous = -1, stable = 0; const check = () => { const top = document.querySelector(".music-track-panel").scrollTop; stable = top === previous ? stable + 1 : 0; previous = top; if (stable >= 4) resolve(); else requestAnimationFrame(check); }; requestAnimationFrame(check); }));
          const intended = await page.locator(".music-track-panel").evaluate(panel => panel.scrollTop);
          assert.equal(await more.evaluate(button => document.activeElement === button), true);
          await settle(page, read); await tick(page);
          assert(Math.abs(await page.locator(".music-track-panel").evaluate(panel => panel.scrollTop) - intended) < 2, "fallback continuation must retain the real wheel position accepted while pending");
          assert.equal(await page.locator(".music-load-more").evaluate(button => document.activeElement === button), true, "a user's pending wheel must not move focus into newly appended rows");
          assert.deepEqual(await playlistPlaybackState(page), playing);
        } finally { read.release(); held.delete(read); await page.close(); }
      });
      if (ignoreAbort) await run("list more keyboard query fallback yields to a newer search selection", async () => {
        const { page, endpoint, firstCount } = await newMoreKeyboardPage("library", { data: moreKeyboardData("library", 0, 120, true), query: "Needle" });
        const read = hold(url => url.pathname === endpoint && url.searchParams.get("offset") === String(firstCount), "", moreKeyboardData("library", firstCount, 120, true));
        try {
          const playing = await playlistPlaybackState(page);
          await page.locator(".music-load-more").focus(); await page.keyboard.press("Space"); await requested(read);
          const input = page.locator('[data-music-search="library"]'); await input.focus(); await input.evaluate(input => input.setSelectionRange(1, 4));
          await settle(page, read); await tick(page);
          assert.deepEqual(await input.evaluate(input => ({ focused: document.activeElement === input, value: input.value, selection: [input.selectionStart, input.selectionEnd] })), { focused: true, value: "Needle", selection: [1, 4] }, "a continuation must yield to a newer input focus and selection");
          assert.deepEqual(await playlistPlaybackState(page), playing);
        } finally { read.release(); held.delete(read); await page.close(); }
      });
      if (ignoreAbort) await run("list more keyboard focuses a new song group instead of its preferred replacement", async () => {
        const data = moreKeyboardData("library", 0, 120, true);
        data.tracks[0] = { ...track("same-mp3"), title: "Identical song", artist: "Synthetic Artist", fileName: "identical.mp3", hasLyrics: false };
        const preferred = { ...data.tracks[0], id: "same-flac", fileName: "identical.flac", codec: "flac", sampleRate: 96000, bitDepth: 24, streamUrl: "/synthetic/audio/same-flac" };
        const { page, endpoint } = await newMoreKeyboardPage("library", { width: 320, data, query: "Synthetic" });
        const read = hold(url => url.pathname === endpoint && url.searchParams.get("offset") === "120", "", { ...data, tracks: [preferred, track("MORE-120")], total: 122, hasMore: false });
        try {
          const playing = await playlistPlaybackState(page);
          await page.locator(".music-load-more").focus(); await page.keyboard.press("Space"); await requested(read); await settle(page, read); await tick(page);
          assert.equal(await page.locator('.music-track-table [data-music-track-id="same-flac"]').count(), 1);
          assert.equal(await page.locator(".music-track-table .music-track-row:not(.head)").count(), 121);
          await assertMoreFocus(page, "library", 120);
          assert.deepEqual(await playlistPlaybackState(page), playing);
          await page.keyboard.press("Enter"); await page.waitForFunction(() => __audios[0].src.endsWith("/synthetic/audio/MORE-120") && !__audios[0].paused);
          assert.equal(await page.locator(".music-now-panel").getAttribute("data-music-track-id"), "MORE-120", "Enter must play the truly new focused song rather than an old group's replacement");
        } finally { read.release(); held.delete(read); await page.close(); }
      });
      if (ignoreAbort) for (const hasMore of [true, false]) await run(`list more keyboard duplicate-only page remains operable ${hasMore ? "with another page" : "at the end"}`, async () => {
        const data = moreKeyboardData("library", 0, 120, true);
        const { page, endpoint } = await newMoreKeyboardPage("library", { data, query: "Needle" });
        const read = hold(url => url.pathname === endpoint && url.searchParams.get("offset") === "120", "", { ...data, tracks: [data.tracks[0]], total: hasMore ? 300 : 121, hasMore });
        try {
          const playing = await playlistPlaybackState(page), before = countRequests(url => url.pathname === endpoint && url.searchParams.has("offset"));
          await page.locator(".music-load-more").focus(); await page.keyboard.press("Space"); await requested(read); await settle(page, read); await tick(page);
          assert.equal(await page.locator(".music-track-table .music-track-row:not(.head)").count(), 120);
          assert.equal(await page.locator(hasMore ? ".music-load-more" : ".music-list-complete").evaluate(target => document.activeElement === target), true, "a duplicate-only page must retain a meaningful keyboard continuation instead of jumping to an old song");
          assert.equal(countRequests(url => url.pathname === endpoint && url.searchParams.has("offset")) - before, 1, "a duplicate-only response must not start another page automatically");
          if (!hasMore) { await page.keyboard.press("Space"); await tick(page); assert.equal(await page.locator(".music-load-more").count(), 0); }
          assert.deepEqual(await playlistPlaybackState(page), playing);
        } finally { read.release(); held.delete(read); await page.close(); }
      });
      if (ignoreAbort) for (const error of ["", "Obsolete continuation failure"]) await run(`list more keyboard old ${error ? "failure" : "success"} yields to another catalog continuation`, async () => {
        const { page, endpoint } = await newMoreKeyboardPage("library");
        const old = hold(url => url.pathname === endpoint && url.searchParams.get("offset") === "120", error, moreKeyboardData("library", 120, 120, true));
        const current = hold(url => url.pathname === "/api/music/albums" && !url.searchParams.has("offset"), "", moreKeyboardData("albums", 0, 80, true));
        const append = hold(url => url.pathname === "/api/music/albums" && url.searchParams.get("offset") === "80", "", moreKeyboardData("albums", 80, 80, false));
        try {
          const playing = await playlistPlaybackState(page);
          await page.locator(".music-load-more").evaluate(button => { window.__oldMore = button; });
          await page.locator(".music-load-more").focus(); await page.keyboard.press("Space"); await requested(old);
          await navigateRoute(page, "/music/albums"); await requested(current); await settle(page, current);
          const currentReads = countRequests(url => url.pathname === "/api/music/albums");
          await page.evaluate(() => __oldMore.click()); await tick(page);
          assert.equal(countRequests(url => url.pathname === "/api/music/albums"), currentReads, "a detached continuation must never read another catalog's page");
          await page.locator(".music-load-more").focus(); await page.keyboard.press("Space"); await requested(append);
          const before = countRequests(url => url.pathname === "/api/music/albums");
          await page.evaluate(() => __oldMore.click()); await settle(page, old); await tick(page);
          assert.equal(countRequests(url => url.pathname === "/api/music/albums"), before, "a detached continuation must never read another catalog's page");
          assert.equal(await page.locator(".music-load-more").evaluate(button => document.activeElement === button && button.getAttribute("aria-busy") === "true"), true, "an old completion must preserve the new catalog's busy focus");
          assert.equal(await page.locator(".music-list-append-error").count(), 0);
          await settle(page, append); await assertMoreFocus(page, "albums", 80);
          assert.deepEqual(await playlistPlaybackState(page), playing);
        } finally { for (const read of [old, current, append]) { read.release(); held.delete(read); } await page.close(); }
      });
      if (ignoreAbort) for (const mode of ["artists", "albums"]) for (const width of [320, 390]) await run(`music alphabet browsing ${mode} clears an empty letter at ${width}px`, async () => {
        const { page, data } = await newAlphabetPage(mode, width), endpoint = `/api/music/${mode}`;
        const empty = hold(url => url.pathname === endpoint && url.searchParams.get("letter") === "Z", "", { ...data, [mode]: [], total: 0 });
        const cleared = hold(url => url.pathname === endpoint && !url.searchParams.has("letter"), "", data);
        try {
          const playing = await playlistPlaybackState(page), group = page.getByRole("group", { name: "按首字母筛选", exact: true });
          const letter = group.getByRole("button", { name: "Z", exact: true });
          if (width === 320) await letter.tap(); else { await letter.focus(); await page.keyboard.press("Enter"); }
          await requested(empty); await settle(page, empty);
          assert.equal(await page.getByRole("button", { name: "显示全部首字母", exact: true }).count(), 1, "an empty alphabet filter must offer an explicit all-letters action instead of requiring users to guess which letter to toggle");
          assert.equal(await group.getByRole("button", { name: "Z", exact: true }).getAttribute("aria-pressed"), "true", "the active alphabet filter must expose its selected state");
          const all = group.getByRole("button", { name: "显示全部首字母", exact: true }); await all.scrollIntoViewIfNeeded();
          assert.equal(await all.evaluate(button => { const r = button.getBoundingClientRect(); return r.width >= 44 && r.height >= 44 && r.left >= 0 && r.right <= innerWidth && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === button; }), true, "the all-letters action must remain visible and touchable at 44px on compact screens");
          if (width === 320) await all.tap(); else { await all.focus(); await page.keyboard.press("Space"); }
          await requested(cleared);
          const params = new URL(cleared.url, base).searchParams;
          assert.equal(params.get("q"), "Needle"); assert.equal(params.get("language"), "Fixture"); assert.equal(params.get("sort"), mode === "artists" ? "name" : "year");
          await settle(page, cleared);
          const currentAll = page.getByRole("button", { name: "显示全部首字母", exact: true });
          assert.equal(await currentAll.getAttribute("aria-pressed"), "true");
          assert.equal(await page.locator(`.music-${mode === "artists" ? "artist" : "album"}-browser-card`).count(), 1);
          if (width === 390) assert.equal(await currentAll.evaluate(button => document.activeElement === button), true, "keyboard alphabet selection must preserve its action after results refresh");
          assert.deepEqual(await playlistPlaybackState(page), playing, "alphabet browsing must preserve the playing source, position and queue");
          if (width === 320 && mode === "artists" && process.env.MUSIC_ALPHABET_SCREENSHOT) await page.screenshot({ path: process.env.MUSIC_ALPHABET_SCREENSHOT });
        } finally { for (const read of [empty, cleared]) { read.release(); held.delete(read); } await page.close(); }
      });
      if (ignoreAbort) await run("music alphabet browsing retains numeric and special letter contracts", async () => {
        const { page, data } = await newAlphabetPage("artists", 320);
        try {
          for (const [label, value] of [["0-9", "0"], ["待", "待"], ["#", "#"]]) {
            const read = hold(url => url.pathname === "/api/music/artists" && url.searchParams.get("letter") === value, "", { ...data, artists: [], total: 0 });
            try { await page.getByRole("group", { name: "按首字母筛选", exact: true }).getByRole("button", { name: label, exact: true }).tap(); await requested(read); await settle(page, read);
              assert.equal(await page.getByRole("group", { name: "按首字母筛选", exact: true }).getByRole("button", { name: label, exact: true }).getAttribute("aria-pressed"), "true");
            } finally { read.release(); held.delete(read); }
          }
        } finally { await page.close(); }
      });
      if (ignoreAbort) await run("music alphabet browsing clearing yields to a newer search selection", async () => {
        const { page, data } = await newAlphabetPage("artists", 390);
        const empty = hold(url => url.pathname === "/api/music/artists" && url.searchParams.get("letter") === "Z", "", { ...data, artists: [], total: 0 });
        const cleared = hold(url => url.pathname === "/api/music/artists" && !url.searchParams.has("letter"), "", data);
        try {
          await page.getByRole("group", { name: "按首字母筛选", exact: true }).getByRole("button", { name: "Z", exact: true }).click(); await requested(empty); await settle(page, empty);
          await page.getByRole("button", { name: "显示全部首字母", exact: true }).focus(); await page.keyboard.press("Space"); await requested(cleared);
          await page.getByRole("searchbox", { name: "搜索歌手", exact: true }).focus();
          await page.getByRole("searchbox", { name: "搜索歌手", exact: true }).evaluate(input => input.setSelectionRange(1, 4));
          await settle(page, cleared);
          assert.deepEqual(await page.getByRole("searchbox", { name: "搜索歌手", exact: true }).evaluate(input => ({ focused: document.activeElement === input, value: input.value, selection: [input.selectionStart, input.selectionEnd] })), { focused: true, value: "Needle", selection: [1, 4] }, "alphabet clearing must preserve a newer search focus and selection");
        } finally { for (const read of [empty, cleared]) { read.release(); held.delete(read); } await page.close(); }
      });
      if (ignoreAbort) await run("music alphabet browsing removed controls cannot clear another catalog", async () => {
        const { page } = await newAlphabetPage("artists", 390);
        const data = { albums: [{ id: "later", title: "Later album", artistName: "Later performer", trackCount: 1 }], total: 1, hasMore: false, summary: summary() };
        const later = hold(url => url.pathname === "/api/music/albums" && !url.searchParams.has("letter"), "", data);
        const filtered = hold(url => url.pathname === "/api/music/albums" && url.searchParams.get("letter") === "L", "", data);
        try {
          await page.getByRole("button", { name: "显示全部首字母", exact: true }).evaluate(button => { window.__oldAlphabetAll = button; });
          await navigateRoute(page, "/music/albums?q=Later"); await requested(later); await settle(page, later);
          await page.getByRole("group", { name: "按首字母筛选", exact: true }).getByRole("button", { name: "L", exact: true }).click(); await requested(filtered); await settle(page, filtered);
          const reads = countRequests(url => url.pathname === "/api/music/albums");
          await page.evaluate(() => __oldAlphabetAll.click()); await tick(page);
          assert.equal(countRequests(url => url.pathname === "/api/music/albums"), reads, "a removed all-letters control must not clear another catalog's selected filter");
          assert.equal(await page.getByRole("group", { name: "按首字母筛选", exact: true }).getByRole("button", { name: "L", exact: true }).getAttribute("aria-pressed"), "true");
        } finally { for (const read of [later, filtered]) { read.release(); held.delete(read); } await page.close(); }
      });
      if (ignoreAbort) for (const width of [320, 390, 768]) await run(`compact music rows retain readable short song titles at ${width}px`, async () => {
        const page = await newPage({ real: true });
        try {
          await page.setViewportSize({ width, height: 900 });
          const title = page.locator('.music-track-table [data-music-track-id="P"] .music-track-title strong');
          const size = await title.evaluate(title => { const range = document.createRange(); range.selectNodeContents(title); return { visible: title.getBoundingClientRect().width, text: range.getBoundingClientRect().width }; });
          console.log(`MEASURE compact music title ${width}: ${JSON.stringify(size)}`);
          assert(size.visible >= size.text, "a short song title must remain readable instead of losing its column to fixed action widths");
          const row = page.locator('.music-track-table [data-music-track-id="P"]');
          const geometry = await row.evaluate(row => { const title = row.querySelector(".music-track-title").getBoundingClientRect(), actions = row.querySelector(".music-track-actions").getBoundingClientRect(); return { height: row.getBoundingClientRect().height, stacked: actions.top >= title.bottom }; });
          assert.equal(geometry.stacked, width <= 560, "only compact screens should move song actions below their title");
          assert.equal(geometry.height, width <= 560 ? 104 : 52, "compact row height must match its content-visibility placeholder");
          assert.equal(await row.evaluate(row => Number.parseFloat(getComputedStyle(row).containIntrinsicSize.match(/[0-9.]+px/)?.[0] || "0")), width <= 560 ? 104 : 52);
          if (width === 320 && process.env.MUSIC_COMPACT_SCREENSHOT) await page.screenshot({ path: process.env.MUSIC_COMPACT_SCREENSHOT });
        } finally { await page.close(); }
      });
      if (ignoreAbort) await run("compact music rows keep long song labels bounded and accessible", async () => {
        const fullTitle = "A memorable synthetic title with a very long album recording suffix ".repeat(5);
        const initial = hold(url => url.pathname === "/api/music/tracks", "", { ...trackList(), tracks: [{ ...track("P"), title: fullTitle }], total: 1, hasMore: false });
        const page = await newPage({ real: true, waitReady: false });
        try {
          await requested(initial); await settle(page, initial); await ready(page); await page.setViewportSize({ width: 320, height: 900 });
          const row = page.locator('.music-track-table [data-music-track-id="P"]');
          assert((await row.getAttribute("aria-label")).includes(fullTitle));
          assert.equal(await row.evaluate(row => { const r = row.getBoundingClientRect(), title = row.querySelector(".music-track-title strong"), t = title.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && t.width >= 120 && getComputedStyle(title).textOverflow === "ellipsis"; }), true);
        } finally { initial.release(); held.delete(initial); await page.close(); }
      });
      if (ignoreAbort) for (const touch of [false, true]) await run(`compact music rows expose independent ${touch ? "touch" : "mouse"} actions at 320px`, async () => {
        const page = await newComponentPage(ignoreAbort, touch);
        try {
          await page.setViewportSize({ width: 320, height: 900 });
          const buttons = page.locator(".music-track-action");
          assert.equal(await buttons.count(), 3);
          for (let index = 0; index < 3; index++) {
            const button = buttons.nth(index); await button.scrollIntoViewIfNeeded();
            const target = await button.evaluate(button => { const r = button.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, reachable: r.width >= 44 && r.height >= 44 && r.left >= 0 && r.right <= innerWidth && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === button }; });
            assert.equal(target.reachable, true, "compact song actions must offer unobstructed targets of at least 44px");
            if (touch) await page.touchscreen.tap(target.x, target.y); else await button.click();
          }
          assert.deepEqual(await page.evaluate(() => __componentCalls), ["next", "append", "download"], "song actions must keep their own targets without bubbling into row playback");
          await page.locator(".music-track-row").focus(); await page.keyboard.press("Enter");
          assert.deepEqual(await page.evaluate(() => __componentCalls), ["next", "append", "download", "play"]);
        } finally { await page.close(); }
      });
      if (ignoreAbort) for (const choice of ["artists", "playlist", "album", "all albums"]) await run(`music drawer navigation ${choice} reveals the chosen collection before its response`, async () => {
        const page = await newDrawerPage(choice === "artists" || choice === "album" ? 320 : 390);
        const isPlaylist = choice === "playlist", isAlbum = choice === "album";
        const path = choice === "artists" ? "/api/music/artists" : isPlaylist ? "/api/music/playlists/new" : isAlbum ? "/api/music/tracks" : "/api/music/albums";
        const data = isPlaylist ? { ...trackList(), tracks: [track("B")], total: 1, hasMore: false, playlist: { id: "new", name: "New playlist", trackCount: 1 } } : null;
        const read = hold(url => url.pathname === path && (!isAlbum || url.searchParams.get("album") === "album-1"), "", data);
        try {
          const playing = await playlistPlaybackState(page), drawer = page.locator(".music-library-layer");
          if (choice !== "artists") await drawer.locator("summary").filter({ hasText: isPlaylist ? /^歌单/ : /^专辑/ }).click();
          const target = choice === "artists" ? drawer.getByRole("button", { name: /^歌手浏览/ })
            : isPlaylist ? drawer.getByRole("button", { name: /^New playlist/ }) : isAlbum ? drawer.locator(".music-album-mini").first() : drawer.getByRole("button", { name: /^查看全部专辑/ });
          if (isPlaylist || choice === "all albums") { await target.focus(); await page.keyboard.press(isPlaylist ? "Space" : "Enter"); } else await target.click();
          await requested(read);
          assert.equal(await page.locator(".music-library-layer").count(), 0, "choosing a music collection must dismiss the mobile library overlay before waiting for its response");
          assert.equal(await page.getByRole("button", { name: "打开音乐资料库", exact: true }).evaluate(button => document.activeElement === button && button.getAttribute("aria-expanded") === "false"), true, "drawer navigation must return focus to its visible launcher while loading");
          assert.deepEqual(await playlistPlaybackState(page), playing);
          await settle(page, read);
          assert.equal(new URL(page.url()).pathname, choice === "artists" ? "/music/artists" : isPlaylist ? "/music/playlist/new" : isAlbum ? "/music/album/album-1" : "/music/albums");
          const firstResult = page.locator(choice === "artists" ? ".music-artist-browser-card" : choice === "all albums" ? ".music-album-browser-card" : ".music-track-table .music-track-row:not(.head)").first();
          await firstResult.scrollIntoViewIfNeeded();
          assert.equal(await firstResult.evaluate(row => { const r = row.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return r.width > 0 && r.height > 0 && (row === hit || row.contains(hit)); }), true, "the selected collection must be visible and hit-testable without another close action");
          assert.deepEqual(await playlistPlaybackState(page), playing, "choosing a mobile collection must preserve the current audio position and queue");
          if (choice === "artists" && process.env.MUSIC_DRAWER_SCREENSHOT) await page.screenshot({ path: process.env.MUSIC_DRAWER_SCREENSHOT });
        } finally { read.release(); held.delete(read); await page.close(); }
      });
      if (ignoreAbort) await run("music drawer navigation read failures remain visible after closing", async () => {
        const page = await newDrawerPage(), failed = hold(url => url.pathname === "/api/music/artists", "Selected artists temporarily unavailable");
        try {
          const playing = await playlistPlaybackState(page);
          await page.locator(".music-library-layer").getByRole("button", { name: /^歌手浏览/ }).click(); await requested(failed); await settle(page, failed);
          assert.equal(await page.locator(".music-library-layer").count(), 0);
          assert((await page.locator(".music-list-read-error").textContent()).includes("Selected artists temporarily unavailable"));
          const retry = page.locator(".music-list-retry"); await retry.scrollIntoViewIfNeeded();
          assert.equal(await retry.evaluate(button => { const r = button.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === button; }), true);
          assert.deepEqual(await playlistPlaybackState(page), playing);
        } finally { failed.release(); held.delete(failed); await page.close(); }
      });
      if (ignoreAbort) await run("music drawer navigation ignores removed controls and yields to new focus", async () => {
        const page = await newDrawerPage(), read = hold(url => url.pathname === "/api/music/artists");
        try {
          const target = page.locator(".music-library-layer").getByRole("button", { name: /^歌手浏览/ });
          await target.evaluate(button => { window.__oldDrawerNavigation = button; }); await target.click(); await requested(read);
          const reads = countRequests(url => url.pathname === "/api/music/artists");
          await page.evaluate(() => __oldDrawerNavigation.click()); await tick(page);
          assert.equal(countRequests(url => url.pathname === "/api/music/artists"), reads, "a removed drawer control must not restart or replace its selected collection read");
          const volume = page.locator('.music-player-bar input[aria-label="音量"]'); await volume.focus();
          assert.equal(await volume.evaluate(input => document.activeElement === input), true);
          await page.evaluate(() => { window.__drawerNewFocus = document.activeElement; });
          await settle(page, read);
          assert.equal(await page.evaluate(() => document.activeElement === __drawerNewFocus), true, "a collection response must not reclaim a user's newer focus after closing its drawer");
          assert.equal(await page.locator(".music-library-layer").count(), 0);
        } finally { read.release(); held.delete(read); await page.close(); }
      });
      if (ignoreAbort) await run("music drawer navigation keeps playlist management separate from choosing a collection", async () => {
        const page = await newDrawerPage();
        try {
          const drawer = page.locator(".music-library-layer");
          await drawer.locator("summary").filter({ hasText: /^歌单/ }).click();
          await drawer.getByRole("button", { name: "新建歌单", exact: true }).click();
          await page.locator(".music-playlist-dialog").waitFor();
          assert.equal(await page.locator(".music-library-layer").count(), 1, "playlist management must retain its original drawer context");
          await page.keyboard.press("Escape");
          assert.equal(await page.locator(".music-playlist-dialog").count(), 0);
          assert.equal(await drawer.getByRole("button", { name: "新建歌单", exact: true }).evaluate(button => document.activeElement === button), true);
        } finally { await page.close(); }
      });
      if (ignoreAbort) for (const mode of ["library", "artists", "albums"]) await run(`music sort keyboard ${mode} remains usable after a native selection`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: `/music/${mode}` });
        const selector = mode === "library" ? ".music-sort" : `[aria-label="${mode === "artists" ? "歌手排序" : "专辑排序"}"]`;
        const endpoint = `/api/music/${mode === "library" ? "tracks" : mode}`, value = mode === "library" ? "artist" : mode === "artists" ? "name" : "title";
        const nextValue = mode === "library" ? "title" : mode === "artists" ? "count" : "year";
        const firstData = musicSortData(mode, true), secondData = musicSortData(mode, false);
        const read = hold(url => url.pathname === endpoint && url.searchParams.get("sort") === value, "", firstData.body);
        const next = hold(url => url.pathname === endpoint && url.searchParams.get("sort") === nextValue, "", secondData.body);
        try {
          if (mode === "library") await startPausedSortAudio(page);
          await page.setViewportSize({ width: mode === "albums" ? 320 : mode === "artists" ? 390 : 1440, height: 900 });
          const playing = await playlistPlaybackState(page);
          const select = page.locator(selector);
          await select.evaluate(select => { window.__nativeMusicSort = select; window.__nativeMusicSortOptions = [...select.options]; });
          await select.focus(); await page.keyboard.press("ArrowDown"); await requested(read); await settle(page, read);
          assert.equal(await page.evaluate(() => __nativeMusicSort.isConnected && document.activeElement === __nativeMusicSort), true, "a native music sort selection must retain its own connected control and keyboard focus after results arrive");
          assert.equal(await page.evaluate(() => __nativeMusicSortOptions.every((option, index) => option === __nativeMusicSort.options[index])), true, "native sort options must keep their identity while the same selection context refreshes");
          assert.equal(await page.locator(selector).inputValue(), value);
          assert.deepEqual(await page.locator(firstData.selector).allTextContents(), firstData.labels);
          await page.keyboard.press(mode === "artists" ? "ArrowUp" : "ArrowDown"); await requested(next); await settle(page, next);
          assert.equal(await page.evaluate(() => document.activeElement === __nativeMusicSort && __nativeMusicSort.isConnected), true);
          assert.equal(await page.locator(selector).inputValue(), nextValue);
          assert.deepEqual(await page.locator(secondData.selector).allTextContents(), secondData.labels);
          assert.equal(new URL(page.url()).searchParams.get("sort") || (mode === "artists" ? "count" : ""), nextValue);
          await page.keyboard.press("Space"); await page.keyboard.press("Escape");
          assert.deepEqual(await playlistPlaybackState(page), playing, "native sort keys must preserve paused playback, its position and queue");
        } finally { for (const gate of [read, next]) { gate.release(); held.delete(gate); } await page.close(); }
      });
      if (ignoreAbort) for (const mode of ["library", "artists", "albums"]) await run(`music sort keyboard ${mode} can recover after a read failure`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: `/music/${mode}` });
        const selector = mode === "library" ? ".music-sort" : `[aria-label="${mode === "artists" ? "歌手排序" : "专辑排序"}"]`;
        const endpoint = `/api/music/${mode === "library" ? "tracks" : mode}`, value = mode === "library" ? "artist" : mode === "artists" ? "name" : "title";
        const resetValue = mode === "library" ? "album" : mode === "artists" ? "count" : "updated";
        const failed = hold(url => url.pathname === endpoint && url.searchParams.get("sort") === value, "Native sort temporary failure");
        const data = musicSortData(mode, false), recovered = hold(url => url.pathname === endpoint && (url.searchParams.get("sort") || "album") === resetValue, "", data.body);
        try {
          if (mode === "library") await startPausedSortAudio(page);
          const playing = await playlistPlaybackState(page);
          await page.locator(selector).evaluate(select => { window.__failedMusicSort = select; });
          await page.locator(selector).focus(); await page.keyboard.press("ArrowDown"); await requested(failed); await settle(page, failed);
          assert.equal(await page.locator(".music-list-retry").count(), 1);
          assert.equal(await page.evaluate(() => __failedMusicSort.isConnected && document.activeElement === __failedMusicSort), true, "a current sort read failure must preserve its native control and keyboard focus");
          await page.keyboard.press("ArrowUp"); await requested(recovered); await settle(page, recovered);
          assert.equal(await page.locator(".music-list-retry").count(), 0);
          assert.deepEqual(await page.locator(data.selector).allTextContents(), data.labels);
          assert.deepEqual(await playlistPlaybackState(page), playing);
        } finally { for (const gate of [failed, recovered]) { gate.release(); held.delete(gate); } await page.close(); }
      });
      if (ignoreAbort) await run("music sort keyboard refresh respects a newer external focus", async () => {
        const page = await newPage({ real: true }), read = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("sort") === "artist");
        try {
          await startPausedSortAudio(page);
          await page.locator(".music-sort").evaluate(select => { window.__nativeMusicSort = select; });
          await page.locator(".music-sort").focus(); await page.keyboard.press("ArrowDown"); await requested(read);
          await page.locator('.music-player-bar input[aria-label="音量"]').focus();
          await page.evaluate(() => { window.__newSortFocus = document.activeElement; }); await settle(page, read);
          assert.equal(await page.evaluate(() => __nativeMusicSort.isConnected && document.activeElement === __newSortFocus), true, "a sort response must preserve a user's newer focus outside its controls");
        } finally { read.release(); held.delete(read); await page.close(); }
      });
      if (ignoreAbort) await run("music sort keyboard detached controls cannot reload a new view", async () => {
        const page = await newPage({ real: true });
        try {
          await page.locator(".music-sort").evaluate(select => { window.__oldMusicSort = select; });
          await page.locator(".music-sidebar.embedded").getByRole("button", { name: /^专辑浏览/ }).click();
          await page.locator(".music-album-browser-grid").waitFor(); await tick(page);
          assert.equal(await page.evaluate(() => __oldMusicSort.isConnected), false);
          const reads = countRequests(url => url.pathname === "/api/music/albums");
          await page.evaluate(() => { __oldMusicSort.value = "rating"; __oldMusicSort.dispatchEvent(new Event("change", { bubbles: true })); }); await tick(page);
          assert.equal(countRequests(url => url.pathname === "/api/music/albums"), reads, "a detached sort control must not reload the current collection or change its conditions");
          assert.equal(new URL(page.url()).pathname, "/music/albums");
        } finally { await page.close(); }
      });
      for (const kind of ["album", "artist"]) await run(`playback context opens the current ${kind} and returns through history ${transport}`, async () => {
        const current = currentContextTrack();
        const artist = { id: current.artistId, name: current.artist, language: "Other", trackCount: 1 };
        const album = { id: current.albumId, title: current.album, artistName: current.artist, trackCount: 1 };
        const initialData = { ...trackList(), tracks: [current], total: 1, hasMore: false,
          artists: [...Array.from({ length: 8 }, (_, index) => ({ id: `earlier-${index}`, name: `Earlier artist ${index}`, trackCount: 1 })), artist],
          albums: [...Array.from({ length: 6 }, (_, index) => ({ id: `earlier-album-${index}`, title: `Earlier album ${index}`, trackCount: 1 })), album] };
        const initial = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "OldNeedle", "", initialData);
        const detail = hold(url => url.pathname === "/api/music/tracks/P", "", { track: current, lyrics: lyrics("P"), prevId: "", nextId: "" });
        const other = { ...track("B"), artistId: kind === "artist" ? current.artistId : "other-performer", artist: kind === "artist" ? current.artist : "Other performer",
          albumId: kind === "album" ? current.albumId : "other-album", album: kind === "album" ? current.album : "Other album", language: "Different", genre: "Different" };
        const destination = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get(kind) === current[kind === "album" ? "albumId" : "artistId"], "", { ...initialData, tracks: [current, other], total: 2 });
        const page = await newPage({ real: true, ignoreAbort, route: "/music/library?q=OldNeedle&genre=OldGenre&language=Other&favorite=1", waitReady: false });
        try {
          await requested(initial); await settle(page, initial); await ready(page);
          const sourceRoute = new URL(page.url()).pathname + new URL(page.url()).search;
          await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click(); await requested(detail); await settle(page, detail);
          await page.waitForFunction(() => __audios[0]?.src.endsWith("/synthetic/audio/P") && !__audios[0].paused);
          if (!ignoreAbort) await page.locator(".music-player-controls").getByRole("button", { name: "暂停", exact: true }).click();
          await page.evaluate(() => { __audios[0].currentTime = 42; window.__contextAudio = __audios[0]; });
          const playing = await playlistPlaybackState(page), token = await page.evaluate(() => __documentToken);
          assert.equal(await page.locator(".music-album-mini").filter({ hasText: current.album }).count(), 0);
          await page.setViewportSize({ width: ignoreAbort ? 1440 : kind === "album" ? 320 : 390, height: 900 });
          // LAN HTTP can provide getRandomValues without secure-context
          // randomUUID; a source history entry must still be recoverable.
          if (!ignoreAbort && kind === "artist") await page.evaluate(() => Object.defineProperty(crypto, "randomUUID", { value: undefined }));
          await page.getByRole("button", { name: "打开当前歌曲播放页", exact: true }).click();
          assert.equal(await page.evaluate(() => history.state.standaloneRoute), true, "the context snapshot must preserve the host's existing history fields");
          assert.equal(await page.getByRole("button", { name: `浏览专辑：${current.album}`, exact: true }).count(), 1, "a currently playing album outside the sidebar must be directly browsable from its song page");
          const button = page.getByRole("button", { name: `浏览${kind === "album" ? "专辑" : "歌手"}：${current[kind]}`, exact: true });
          await button.scrollIntoViewIfNeeded();
          assert.equal(await button.evaluate(button => { const rect = button.getBoundingClientRect(), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2); return rect.height >= 44 && rect.left >= 0 && rect.right <= innerWidth && (hit === button || button.contains(hit)); }), true, "current context actions must be visible and hit-testable with 44px targets");
          if (!ignoreAbort && kind === "album" && process.env.MUSIC_CONTEXT_SCREENSHOT) await page.screenshot({ path: process.env.MUSIC_CONTEXT_SCREENSHOT });
          if (ignoreAbort && kind === "artist") await button.click();
          else if (ignoreAbort) { await button.focus(); await button.press("Space"); }
          else {
            const previous = kind === "artist" ? page.getByRole("button", { name: "返回音乐库", exact: true }) : page.getByRole("button", { name: `浏览歌手：${current.artist}`, exact: true });
            await previous.focus(); await page.keyboard.press("Tab");
            assert.equal(await button.evaluate(button => document.activeElement === button), true);
            await page.keyboard.press("Enter");
          }
          assert.equal(new URL(page.url()).pathname, `/music/${kind}/${current[kind === "album" ? "albumId" : "artistId"]}`, "context navigation must leave the stage at its exact collection URL");
          await requested(destination);
          const params = new URL(destination.url, base).searchParams;
          assert.equal(params.get(kind), current[kind === "album" ? "albumId" : "artistId"]);
          assert.equal(params.get(kind === "album" ? "artist" : "album"), null, "album context must include other performers and artist context must include other albums");
          for (const key of ["q", "genre", "favorite", "language"]) assert.equal(params.get(key), null, "current context must not inherit unrelated library filters");
          await settle(page, destination);
          assert.deepEqual(await page.locator(".music-track-table .music-track-row:not(.head)").evaluateAll(rows => rows.map(row => row.dataset.musicTrackId)), ["P", "B"]);
          assert.deepEqual(await playlistPlaybackState(page), playing, "browsing current context must preserve the song, listening position and queue");
          assert.equal(await page.evaluate(() => __contextAudio === __audios[0] && __audios.length === 1), true);
          const restore = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "OldNeedle", "", initialData);
          try {
            const detailReads = countRequests(url => url.pathname === "/api/music/tracks/P");
            await page.goBack({ waitUntil: "commit" }); await ready(page); await page.locator(".music-stage-meta h2").waitFor();
            assert.equal(new URL(page.url()).pathname, "/music/track/P");
            assert.equal(await page.evaluate(() => __documentToken), token);
            assert.equal(countRequests(url => url.pathname === "/api/music/tracks/P"), detailReads, "Back to the same playing song must not reopen its media");
            assert.deepEqual(await audioState(page), playing.audio);
            const restoreStarted = page.waitForRequest(request => { const url = new URL(request.url()); return url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "OldNeedle"; }, { timeout: 1500 }).then(() => true, () => false);
            await page.getByRole("button", { name: "返回音乐库", exact: true }).click();
            assert.equal(await restoreStarted, true, "a history-restored stage must read its own collection before rendering a cached context");
            await requested(restore);
            const restoredParams = new URL(restore.url, base).searchParams;
            assert.equal(restoredParams.get("genre"), "OldGenre", "history must restore the stage entry's original genre rather than the browsed collection");
            assert.equal(restoredParams.get("language"), "Other", "history must restore source conditions that are absent from a track URL");
            assert.equal(restoredParams.get("favorite"), "1");
            await settle(page, restore);
            assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, sourceRoute);
            assert.deepEqual(await page.locator(".music-track-table .music-track-row:not(.head)").evaluateAll(rows => rows.map(row => row.dataset.musicTrackId)), ["P"], "leaving a history-restored stage must read the original collection instead of reusing the browsed context");
            assert.deepEqual(await playlistPlaybackState(page), playing);
          } finally { restore.release(); held.delete(restore); }
        } finally { for (const read of [initial, detail, destination]) { read.release(); held.delete(read); } await page.close(); }
      });
      await run(`playback context old controls yield to a pending and then current song ${transport}`, async () => {
        const { page, current } = await newCurrentContextPage(ignoreAbort);
        const next = hold(url => url.pathname === "/api/music/tracks/A");
        try {
          const old = page.getByRole("button", { name: `浏览专辑：${current.album}`, exact: true }); await old.evaluate(button => { window.__oldContextControl = button; });
          await page.locator(".music-stage-player .music-player-controls").getByRole("button", { name: "下一首", exact: true }).click(); await requested(next);
          await page.evaluate(() => __oldContextControl.click());
          assert.equal(new URL(page.url()).pathname, "/music/track/P", "a pending new song must keep ownership when an old context control is activated");
          await settle(page, next); await page.waitForFunction(() => fixture.state.music.current?.id === "A");
          const playing = await playbackState(page), reads = countRequests(url => url.pathname === "/api/music/tracks");
          await page.evaluate(() => { window.__contextDestination = document.querySelector(".music-player-stage"); __oldContextControl.click(); });
          assert.equal(countRequests(url => url.pathname === "/api/music/tracks"), reads, "detached context controls must not browse the previous song's collection");
          assert.equal(await page.evaluate(() => __contextDestination === document.querySelector(".music-player-stage")), true);
          assert.deepEqual(await playbackState(page), playing);
        } finally { next.release(); await page.close(); }
      });
      await run(`playback context failed collection keeps its URL and playing source ${transport}`, async () => {
        const { page, current } = await newCurrentContextPage(ignoreAbort);
        const failed = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("album") === current.albumId, "Current album temporarily unavailable");
        try {
          const playing = await playbackState(page);
          await page.getByRole("button", { name: `浏览专辑：${current.album}`, exact: true }).click(); await requested(failed); await settle(page, failed);
          assert.equal(new URL(page.url()).pathname, `/music/album/${current.albumId}`);
          assert.equal(await page.locator(".music-list-retry").count(), 1);
          assert((await page.locator(".music-list-read-error").textContent()).includes("Current album temporarily unavailable"));
          assert.deepEqual(await playbackState(page), playing, "a context read failure must not interrupt the playing song or change its queue");
        } finally { failed.release(); await page.close(); }
      });
      if (ignoreAbort) {
        await run("playback context late collection yields to history navigation", async () => {
          const { page, current } = await newCurrentContextPage(ignoreAbort, {}, true);
          const late = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("album") === current.albumId);
          try {
            const playing = await playlistPlaybackState(page);
            await page.getByRole("button", { name: `浏览专辑：${current.album}`, exact: true }).click(); await requested(late);
            await page.goBack({ waitUntil: "commit" }); await page.locator(".music-stage-meta h2").waitFor();
            await page.evaluate(() => { window.__returnedStage = document.querySelector(".music-player-stage"); });
            await finishOld(page, late, ignoreAbort);
            assert.equal(new URL(page.url()).pathname, "/music/track/P", "an obsolete context response must not leave the stage restored by Back");
            assert.equal(await page.evaluate(() => __returnedStage === document.querySelector(".music-player-stage")), true);
            assert.deepEqual(await playlistPlaybackState(page), playing);
          } finally { late.release(); held.delete(late); await page.close(); }
        });
        await run("playback context foreign history cannot invent a collection origin", async () => {
          const { page } = await newCurrentContextPage(ignoreAbort, {}, true);
          try {
            await page.evaluate(() => {
              history.pushState({ ...history.state, fanhaoMusicTrackReturn: { owner: "another-page-token", route: { view: "music", musicMode: "library", musicArtistId: "foreign-artist" }, scroll: {} } }, "", "/music/track/P");
              dispatchEvent(new PopStateEvent("popstate"));
            });
            await tick(page); await page.locator(".music-stage-meta h2").waitFor();
            await page.getByRole("button", { name: "返回音乐库", exact: true }).click();
            assert.equal(new URL(page.url()).pathname, "/music/library", "a source snapshot from another page session must not invent a collection origin");
            assert.equal(countRequests(url => url.pathname === "/api/music/tracks" && url.searchParams.get("artist") === "foreign-artist"), 0);
          } finally { await page.close(); }
        });
        for (const origin of ["artist", "album", "playlist"]) await run(`playback context returns to its ${origin} source entry`, async () => {
          const current = currentContextTrack(), sourceId = origin === "playlist" ? "new" : current[`${origin}Id`];
          const sourcePath = `/music/${origin}/${sourceId}`;
          const sourceMatch = url => origin === "playlist" ? url.pathname === "/api/music/playlists/new" : url.pathname === "/api/music/tracks" && url.searchParams.get(origin) === sourceId;
          const sourceData = { ...trackList(), tracks: [current], total: 1, hasMore: false, playlist: { id: "new", name: "Origin playlist", trackCount: 1 } };
          const initial = hold(sourceMatch, "", sourceData), detail = hold(url => url.pathname === "/api/music/tracks/P", "", { track: current, lyrics: lyrics("P") });
          const destination = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("album") === current.albumId, "", { ...sourceData, tracks: [current, { ...track("B"), artistId: current.artistId, albumId: current.albumId }], total: 2 });
          const page = await newPage({ real: true, route: sourcePath, waitReady: false });
          try {
            await requested(initial); await settle(page, initial); await ready(page);
            await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click(); await requested(detail); await settle(page, detail);
            await page.waitForFunction(() => __audios[0]?.src.endsWith("/synthetic/audio/P") && !__audios[0].paused); await page.evaluate(() => { __audios[0].currentTime = 42; });
            const playing = await playlistPlaybackState(page);
            await page.getByRole("button", { name: "打开当前歌曲播放页", exact: true }).click();
            await page.getByRole("button", { name: `浏览专辑：${current.album}`, exact: true }).click(); await requested(destination); await settle(page, destination);
            if (origin === "artist") {
              // Two entries have exactly the same song URL but different
              // collection origins; only the current history entry may win.
              const second = hold(sourceMatch, "", { ...sourceData, tracks: [current, track("B")], total: 2 });
              const albumRestore = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("album") === current.albumId, "", { ...sourceData, tracks: [current, track("B")], total: 2 });
              try {
                await page.getByRole("button", { name: "打开当前歌曲播放页", exact: true }).click();
                await page.getByRole("button", { name: `浏览歌手：${current.artist}`, exact: true }).click(); await requested(second); await settle(page, second);
                await page.goBack({ waitUntil: "commit" }); await page.locator(".music-stage-meta h2").waitFor();
                await page.getByRole("button", { name: "返回音乐库", exact: true }).click(); await requested(albumRestore); await settle(page, albumRestore);
                assert.equal(new URL(page.url()).pathname, `/music/album/${current.albumId}`, "identical song URLs must return to their own history entry's collection");
                await page.goBack({ waitUntil: "commit" }); await page.locator(".music-track-panel").waitFor();
              } finally { for (const read of [second, albumRestore]) { read.release(); held.delete(read); } }
            }
            const restored = hold(sourceMatch, "", sourceData);
            try {
              await page.goBack({ waitUntil: "commit" }); await page.locator(".music-stage-meta h2").waitFor();
              await page.getByRole("button", { name: "返回音乐库", exact: true }).click(); await requested(restored); await settle(page, restored);
              assert.equal(new URL(page.url()).pathname, sourcePath, "Back and the stage return action must restore the actual originating collection");
              assert.deepEqual(await visiblePlaylistTracks(page), ["P"]);
              assert.deepEqual(await playlistPlaybackState(page), playing);
            } finally { restored.release(); held.delete(restored); }
          } finally { for (const read of [initial, detail, destination]) { read.release(); held.delete(read); } await page.close(); }
        });
        await run("playback context missing IDs remain honest readable metadata", async () => {
          const { page } = await newCurrentContextPage(ignoreAbort, { artistId: "", albumId: "" });
          try {
            assert.equal(await page.locator(".music-stage-context .music-current-context").count(), 0, "missing collection IDs must not create misleading navigation buttons");
            assert((await page.locator(".music-stage-context").textContent()).includes("Current artist outside sidebar"));
            assert((await page.locator(".music-stage-context").textContent()).includes("Current album outside sidebar"));
          } finally { await page.close(); }
        });
        await run("playback context old or invalid account controls cannot browse", async () => {
          const { page, current } = await newCurrentContextPage(ignoreAbort);
          const faultsBefore = faults.length;
          try {
            const path = new URL(page.url()).pathname, reads = countRequests(url => url.pathname === "/api/music/tracks");
            await page.evaluate(() => { window.__contextOwner = __fanhaoWebAccountContext.owner; __fanhaoWebAccountContext.owner = "new-context-owner"; });
            await page.getByRole("button", { name: `浏览专辑：${current.album}`, exact: true }).click();
            assert.equal(new URL(page.url()).pathname, path, "an old account's context control must not browse using a new account");
            await page.evaluate(() => { __fanhaoWebAccountContext.owner = __contextOwner; __fanhaoWebAccountContext.invalid = true; });
            await page.getByRole("button", { name: `浏览专辑：${current.album}`, exact: true }).click();
            assert.equal(new URL(page.url()).pathname, path);
            assert.equal(countRequests(url => url.pathname === "/api/music/tracks"), reads);
            assert.deepEqual(faults.slice(faultsBefore), [], "invalid account context actions must fail closed without page errors");
          } finally { await page.evaluate(() => { __fanhaoWebAccountContext.owner = __contextOwner; __fanhaoWebAccountContext.invalid = false; }); await page.close(); }
        });
      }
      for (const mode of ["library", "artists", "albums"]) await run(`library recovery ${mode} replaces failed results and retries current conditions ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        const endpoint = `/api/music/${mode === "library" ? "tracks" : mode}`, query = "Recovered";
        const rows = mode === "library" ? ".music-track-table .music-track-row:not(.head)" : mode === "artists" ? ".music-artist-browser-card" : ".music-album-browser-card";
        const failed = hold(url => url.pathname === endpoint && url.searchParams.get("q") === query, "Synthetic library outage");
        const failedAgain = hold(url => url.pathname === endpoint && url.searchParams.get("q") === query, "Repeated library outage");
        const data = mode === "library" ? { ...trackList(), tracks: [{ ...track("B"), title: "Recovered song", favorite: true }], total: 1, hasMore: false }
          : mode === "artists" ? { artists: [{ ...artists()[1], name: "Recovered artist" }], total: 1, hasMore: false, summary: summary() }
            : { albums: [{ ...albums()[0], title: "Recovered album" }], total: 1, hasMore: false, summary: summary() };
        const recovered = hold(url => url.pathname === endpoint && url.searchParams.get("q") === query, "", data);
        try {
          await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click(); await page.waitForFunction(() => fixture.state.music.current?.id === "P" && !__audios[0].paused);
          await page.evaluate(() => { __audios[0].currentTime = 42; });
          if (mode !== "library") { await launchRoute(page, { musicMode: mode }); await page.waitForFunction(() => !fixture.state.music.loading); }
          const sort = mode === "library" ? "title" : mode === "artists" ? "name" : "year";
          await page.locator(mode === "library" ? ".music-sort" : `[aria-label="${mode === "artists" ? "歌手排序" : "专辑排序"}"]`).selectOption(sort); await page.waitForFunction(() => !fixture.state.music.loading);
          if (mode === "library") { await page.locator(".music-favorite-filter").click(); await page.waitForFunction(() => !fixture.state.music.loading); }
          const playing = await playbackState(page);
          if (mode === "library") await page.setViewportSize({ width: ignoreAbort ? 390 : 320, height: 900 });
          await page.locator(`[data-music-search="${mode}"]`).fill(query); await requested(failed); await settle(page, failed);
          assert.equal(await page.locator(rows).count(), 0, "a failed new query must not present items from the previous library selection as its results");
          assert.equal(await page.locator(".music-list-retry").count(), 1, "a failed music list must offer a direct retry for its current conditions");
          assert((await page.locator(".music-list-read-error").textContent()).includes("Synthetic library outage"));
          await page.locator(".music-list-retry").scrollIntoViewIfNeeded();
          assert.equal(await page.locator(".music-list-retry").evaluate(button => { const rect = button.getBoundingClientRect(); return rect.height >= 44 && rect.left >= 0 && rect.right <= innerWidth && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === button; }), true, "the music recovery action must be visible and hit-testable with a 44px target");
          const historyLength = await page.evaluate(() => history.length);
          await page.locator(".music-list-retry").focus(); await page.locator(".music-list-retry").press("Enter");
          assert.equal(await page.evaluate(() => fixture.state.music.query), query, "retry must retain its committed search query instead of navigating to an unfiltered collection");
          await requested(failedAgain); await settle(page, failedAgain);
          assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("music-list-retry")), true, "a repeated current failure must return keyboard focus to the new retry action");
          assert((await page.locator(".music-list-read-error").textContent()).includes("Repeated library outage"));
          await page.locator(".music-list-retry").press("Space"); await requested(recovered);
          const params = new URL(recovered.url, base).searchParams;
          assert.equal(params.get("q"), query); assert.equal(params.get("sort"), sort);
          if (mode === "library") assert.equal(params.get("favorite"), "1");
          await settle(page, recovered);
          assert.equal(await page.locator(rows).count(), 1);
          assert.equal(await page.locator(".music-list-read-error").count(), 0);
          assert.equal(await page.evaluate(() => document.activeElement === document.querySelector(".music-panel-heading strong")), true, "a successful current retry must focus its own list heading");
          assert.equal(await page.evaluate(() => history.length), historyLength, "retry must replace the current route instead of adding history entries");
          assert.equal(new URL(page.url()).searchParams.get("q"), query);
          assert.deepEqual(await playbackState(page), playing, "list recovery must preserve the playing source, listening point and queue");
        } finally { for (const read of [failed, failedAgain, recovered]) { read.release(); held.delete(read); } await page.close(); }
      });
      for (const error of ["", "Retry failed after newer input focus"]) await run(`library recovery ${error ? "failure" : "success"} respects a newer search focus ${transport}`, async () => {
        const page = await newListRecoveryPage(ignoreAbort);
        const retry = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "Recovery", error, { ...trackList(), tracks: [{ ...track("B"), title: "Recovery song" }], total: 1, hasMore: false });
        try {
          const playing = await playbackState(page);
          await page.locator(".music-list-retry").focus(); await page.locator(".music-list-retry").press("Enter"); await requested(retry);
          const input = page.locator('[data-music-search="library"]'); await input.focus(); await input.evaluate(input => input.setSelectionRange(1, 4));
          await settle(page, retry);
          assert.deepEqual(await input.evaluate(input => [input.value, input.selectionStart, input.selectionEnd, document.activeElement === input]), ["Recovery", 1, 4, true], "a list retry must not steal a newer search focus or selection");
          assert.equal(await page.locator(".music-list-retry").count(), Number(Boolean(error)));
          assert.deepEqual(await playbackState(page), playing);
        } finally { retry.release(); await page.close(); }
      });
      for (const target of ["new query", "popstate"]) await run(`library recovery late retry and old button yield to ${target} ${transport}`, async () => {
        const page = await newListRecoveryPage(ignoreAbort, true);
        const old = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "Recovery", "Obsolete retry failure");
        const current = hold(url => url.pathname === (target === "new query" ? "/api/music/tracks" : "/api/music/artists") && (target !== "new query" || url.searchParams.get("q") === "NewQuery"));
        try {
          const playing = await audioState(page);
          await page.locator(".music-list-retry").evaluate(button => { window.__oldListRetry = button; });
          await page.locator(".music-list-retry").focus(); await page.locator(".music-list-retry").press("Enter"); await requested(old);
          if (target === "new query") await page.locator('[data-music-search="library"]').fill("NewQuery"); else await navigateRoute(page, "/music/artists");
          await requested(current); await settle(page, current); await ready(page);
          const input = page.locator(`[data-music-search="${target === "new query" ? "library" : "artists"}"]`); await input.focus();
          await page.evaluate(() => { window.__listRecoveryDestination = document.querySelector(".music-track-panel"); });
          const before = countRequests(url => url.pathname.startsWith("/api/music/"));
          await finishOld(page, old, ignoreAbort); await page.evaluate(() => __oldListRetry.click()); await page.waitForTimeout(260);
          assert.equal(countRequests(url => url.pathname.startsWith("/api/music/")), before, "an unloaded retry action must not start another read in a newer navigation");
          assert.equal(await page.evaluate(() => __listRecoveryDestination === document.querySelector(".music-track-panel")), true);
          assert.equal(await input.evaluate(input => document.activeElement === input), true, "an obsolete retry result must not take focus from its newer route");
          assert.equal(await input.inputValue(), target === "new query" ? "NewQuery" : "");
          assert(!(await page.locator("#workGrid").textContent()).includes("Obsolete retry failure"));
          assert.deepEqual(await audioState(page), playing);
        } finally { old.release(); current.release(); await page.close(); }
      });
      await run(`library recovery stays usable when a new song takes foreground ownership ${transport}`, async () => {
        const page = await newListRecoveryPage(ignoreAbort);
        const old = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "Recovery", "Discarded retry reason");
        const current = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "Recovery", "", { ...trackList(), tracks: [{ ...track("B"), title: "Recovery song" }], total: 1, hasMore: false });
        try {
          await page.locator(".music-list-retry").click(); await requested(old);
          await page.locator(".music-player-controls").getByRole("button", { name: "下一首", exact: true }).click();
          await page.waitForFunction(() => fixture.state.music.current?.id === "A" && !__audios[0].paused); const playing = await playbackState(page);
          await settle(page, old);
          assert.equal(await page.locator(".music-list-retry").isEnabled(), true, "choosing another song must not strand the still-current list's retry control");
          assert(!(await page.locator("#workGrid").textContent()).includes("Discarded retry reason"), "an obsolete foreground error must not replace the chosen song's status");
          await page.locator(".music-list-retry").click(); await requested(current); await settle(page, current);
          assert.equal(await page.locator(".music-list-retry").count(), 0);
          assert.deepEqual(await playbackState(page), playing);
        } finally { old.release(); current.release(); await page.close(); }
      });
      await run(`library recovery busy keyboard retry preserves paused playback ${transport}`, async () => {
        const page = await newListRecoveryPage(ignoreAbort);
        const pending = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "Recovery", "Held keyboard retry failure");
        const recovered = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "Recovery", "", { ...trackList(), tracks: [{ ...track("B"), title: "Recovery song" }], total: 1, hasMore: false });
        try {
          await page.locator(".music-player-controls").getByRole("button", { name: "暂停", exact: true }).click();
          await page.locator(".music-list-retry").focus(); await page.locator(".music-list-retry").press("Space"); await requested(pending);
          const reads = countRequests(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "Recovery");
          await page.keyboard.press("Space");
          await page.keyboard.press("Enter");
          assert.equal(await page.evaluate(() => __audios[0].paused), true, "busy list recovery must keep Space on its focused action instead of starting paused audio");
          assert.equal(countRequests(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "Recovery"), reads, "a busy retry action must not issue duplicate reads");
          await settle(page, pending);
          assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("music-list-retry")), true, "ignored activation of the busy action must allow focus to return to the replacement retry");
          assert.equal(await page.evaluate(() => __audios[0].paused), true);
          await page.locator(".music-list-retry").press("Enter"); await requested(recovered); await settle(page, recovered);
          assert.equal(await page.locator(".music-list-retry").count(), 0);
          assert.equal(await page.evaluate(() => document.activeElement === document.querySelector(".music-panel-heading strong")), true, "keyboard recovery must continue from the replacement retry to its successful heading");
          assert.equal(await page.evaluate(() => __audios[0].paused), true);
        } finally { pending.release(); recovered.release(); await page.close(); }
      });
      if (ignoreAbort) await run("library recovery old-account controls cannot start reads for a new account", async () => {
        const page = await newListRecoveryPage(ignoreAbort);
        try {
          const before = countRequests(url => url.pathname.startsWith("/api/music/"));
          await page.evaluate(() => { window.__oldRecoveryOwner = __fanhaoWebAccountContext.owner; __fanhaoWebAccountContext.owner = "new-recovery-owner"; });
          await page.locator(".music-list-retry").click(); await page.waitForTimeout(260);
          assert.equal(countRequests(url => url.pathname.startsWith("/api/music/")), before, "an old-account retry must not use the new account's credentials");
          await page.evaluate(() => { __fanhaoWebAccountContext.owner = __oldRecoveryOwner; });
        } finally { await page.close(); }
      });
      if (ignoreAbort) for (const phase of ["before click", "during retry"]) await run(`library recovery invalid account ${phase} fails closed`, async () => {
        const page = await newListRecoveryPage(ignoreAbort);
        const pending = phase === "during retry" ? hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "Recovery", "Failure during invalid session") : null;
        const faultsBefore = faults.length;
        try {
          if (pending) { await page.locator(".music-list-retry").click(); await requested(pending); }
          const before = countRequests(url => url.pathname.startsWith("/api/music/"));
          await page.evaluate(() => { __fanhaoWebAccountContext.invalid = true; });
          if (pending) await settle(page, pending); else await page.locator(".music-list-retry").click();
          await page.waitForTimeout(80);
          assert.equal(countRequests(url => url.pathname.startsWith("/api/music/")), before, "an invalid account must not start a retry with fallback credentials");
          assert.deepEqual(faults.slice(faultsBefore), [], "invalid account ownership checks must return inactive without producing a page error");
        } finally { pending?.release(); await page.evaluate(() => { __fanhaoWebAccountContext.invalid = false; }); await page.close(); }
      });
      for (const target of ["all songs", "favorites", "artist", "album", "genre"]) await run(`browse navigation ${target} leaves an unrelated empty search ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        const query = `No matching fixture song ${target} ${transport}`;
        const empty = { ...trackList(), tracks: [], total: 0, hasMore: false, genres: [{ id: "fixture-genre", name: "Fixture genre", trackCount: 300 }] };
        const reads = [hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === query, "", empty), hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === query, "", empty)];
        const expected = { artist: target === "artist" ? "artist-B" : "", album: target === "album" ? "album-1" : "", genre: target === "genre" ? "Fixture genre" : "", favorite: target === "favorites" ? "1" : "" };
        const destination = hold(url => url.pathname === "/api/music/tracks" && !url.searchParams.get("q") && Object.entries(expected).every(([key, value]) => (url.searchParams.get(key) || "") === value), "", { ...trackList(), tracks: [track("B")], total: 1, hasMore: false });
        try {
          await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click(); await page.waitForFunction(() => fixture.state.music.current?.id === "P" && !__audios[0].paused);
          await page.evaluate(() => { __audios[0].currentTime = 42; }); const playing = await playbackState(page);
          await page.locator('[data-music-search="library"]').fill(query); await requested(reads[0]); await settle(page, reads[0]); reads[1].release();
          await page.waitForFunction(() => !fixture.state.music.loading);
          assert.equal(await page.locator(".music-track-table .music-track-row:not(.head)").count(), 0);
          const sidebar = page.locator(".music-sidebar.embedded");
          if (target === "all songs" || target === "favorites") await sidebar.getByRole("button", { name: target === "all songs" ? /^全部歌曲/ : /^我喜欢/ }).click();
          else {
            await sidebar.locator("summary").filter({ hasText: target === "artist" ? /^歌手/ : target === "album" ? /^专辑/ : /^风格/ }).click();
            const control = target === "album" ? sidebar.locator(".music-album-mini").first() : sidebar.getByRole("button", { name: target === "artist" ? /^Artist B/ : /^Fixture genre/ });
            await control.focus(); await control.press("Enter");
          }
          assert.equal(await page.evaluate(() => fixture.state.music.query), "", "context navigation must clear the previous search before requesting its new collection");
          await requested(destination); await settle(page, destination); await page.waitForFunction(() => !fixture.state.music.loading);
          assert.equal(await page.locator('[data-music-search="library"]').inputValue(), "", "choosing a new collection must leave the previous empty search and restore its songs");
          assert.deepEqual(await page.locator(".music-track-table .music-track-row:not(.head)").evaluateAll(rows => rows.map(row => row.dataset.musicTrackId)), ["B"], "the actual response for the new collection must be visible");
          const route = await page.evaluate(async () => { const { routeFromUrl } = await import("/js/router.js"); const route = routeFromUrl(); return { query: route.musicQuery, artist: route.musicArtistId, album: route.musicAlbumId, genre: route.musicGenre, favorite: route.musicFavorite }; });
          assert.deepEqual(route, { query: "", artist: expected.artist, album: expected.album, genre: expected.genre, favorite: Boolean(expected.favorite) }, "the new collection URL must contain its own conditions without the unrelated query");
          assert.deepEqual(await playbackState(page), playing, "collection navigation must preserve the current audio, listening point and queue");
        } finally { destination.release(); held.delete(destination); for (const read of reads) { read.release(); held.delete(read); } await page.close(); }
      });
      for (const mode of ["artists", "albums"]) await run(`browse navigation ${mode} card leaves its catalog search ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        const artistMode = mode === "artists", query = artistMode ? "Artist B" : "Synthetic album";
        const catalog = hold(url => url.pathname === `/api/music/${mode}` && url.searchParams.get("q") === query, "", artistMode ? { artists: [artists()[1]], total: 1, hasMore: false, summary: summary() } : { albums: albums(), total: 1, hasMore: false, summary: summary() });
        const destination = hold(url => url.pathname === "/api/music/tracks" && !url.searchParams.get("q") && url.searchParams.get(artistMode ? "artist" : "album") === (artistMode ? "artist-B" : "album-1"), "", { ...trackList(), tracks: [track("B")], total: 1, hasMore: false });
        try {
          await launchRoute(page, { musicMode: mode }); await page.waitForFunction(() => !fixture.state.music.loading);
          await page.locator(`[data-music-search="${mode}"]`).fill(query); await requested(catalog); await settle(page, catalog);
          const card = page.locator(artistMode ? ".music-artist-browser-card" : ".music-album-browser-card").first(); await card.focus(); await card.press("Enter");
          assert.equal(await page.evaluate(() => fixture.state.music.query), "", "opening a catalog card must start its collection without the catalog's search query");
          await requested(destination); await settle(page, destination);
          assert.deepEqual(await page.locator(".music-track-table .music-track-row:not(.head)").evaluateAll(rows => rows.map(row => row.dataset.musicTrackId)), ["B"]);
          assert.equal(new URL(page.url()).searchParams.get("q"), null);
          assert.equal(new URL(page.url()).pathname, artistMode ? "/music/artist/artist-B" : "/music/album/album-1");
        } finally { catalog.release(); destination.release(); await page.close(); }
      });
      await run(`browse navigation local sorting and favorite filtering retain the current search ${transport}`, async () => {
        const page = await newPage({ ignoreAbort }), query = `Keep this query ${transport}`;
        const first = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === query && !url.searchParams.get("sort"));
        const sorted = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === query && url.searchParams.get("sort") === "title" && !url.searchParams.get("favorite"));
        const filtered = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === query && url.searchParams.get("sort") === "title" && url.searchParams.get("favorite") === "1");
        try {
          await page.locator('[data-music-search="library"]').fill(query); await requested(first); await settle(page, first);
          await page.locator(".music-sort").selectOption("title"); await requested(sorted); await settle(page, sorted);
          await page.locator(".music-favorite-filter").click(); await requested(filtered); await settle(page, filtered);
          assert.equal(await page.locator('[data-music-search="library"]').inputValue(), query, "local sorting and filtering must not turn a query into an unfiltered collection navigation");
          assert.equal(new URL(page.url()).searchParams.get("q"), query);
          assert.equal(new URL(page.url()).searchParams.get("sort"), "title");
          assert.equal(await page.locator(".music-track-table .music-track-title strong").first().textContent(), `Track ${query}-1`);
        } finally { first.release(); sorted.release(); filtered.release(); await page.close(); }
      });
      await run(`browse navigation ignores late reads and suggestions from the exited search ${transport}`, async () => {
        const page = await newPage({ ignoreAbort }), query = `Old browsing term ${transport}`;
        const old = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === query);
        const suggestion = hold(url => url.pathname === "/api/music/suggest" && url.searchParams.get("q") === query, "", { tracks: [track("A")], artists: [], albums: [] });
        const current = hold(url => url.pathname === "/api/music/tracks" && !url.searchParams.get("q"), "", { ...trackList(), tracks: [track("B")], total: 1, hasMore: false });
        try {
          await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click(); await page.waitForFunction(() => fixture.state.music.current?.id === "P" && !__audios[0].paused);
          const playing = await playbackState(page);
          await page.locator('[data-music-search="library"]').fill(query); await requested(old); await requested(suggestion);
          await page.locator(".music-sidebar.embedded").getByRole("button", { name: /^全部歌曲/ }).click();
          assert.equal(await page.evaluate(() => fixture.state.music.query), "", "context navigation must clear the previous search before requesting its new collection");
          await requested(current); await settle(page, current); await page.evaluate(() => { fixture.browseDestination = document.querySelector(".music-track-panel"); });
          await finishOld(page, old, ignoreAbort); await finishOld(page, suggestion, ignoreAbort); await page.waitForTimeout(280);
          assert.equal(await page.evaluate(() => fixture.browseDestination === document.querySelector(".music-track-panel")), true, "late results for an exited query must not replace the new collection");
          assert.equal(await page.locator('[data-music-search="library"]').inputValue(), "");
          assert.equal(await page.locator(".music-search-suggest-item").count(), 0);
          assert.deepEqual(await page.locator(".music-track-table .music-track-row:not(.head)").evaluateAll(rows => rows.map(row => row.dataset.musicTrackId)), ["B"]);
          assert.deepEqual(await playbackState(page), playing);
        } finally { old.release(); suggestion.release(); current.release(); held.delete(current); await page.close(); }
      });
      await run(`browse navigation direct links and browser back keep their explicit query ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: "/music/library?q=InitialNeedle&sort=artist" });
        try {
          assert.equal(await page.locator('[data-music-search="library"]').inputValue(), "InitialNeedle");
          assert.equal(await page.locator(".music-sort").inputValue(), "artist");
          await navigateRoute(page, "/music/artist/artist-B?q=OtherNeedle&sort=title"); await ready(page);
          await page.waitForFunction(() => document.querySelector('[data-music-search="library"]')?.value === "OtherNeedle" && !document.querySelector(".music-track-panel")?.hasAttribute("aria-busy"));
          const token = await page.evaluate(() => __documentToken);
          await page.goBack({ waitUntil: "commit" }); await ready(page);
          await page.waitForFunction(() => document.querySelector('[data-music-search="library"]')?.value === "InitialNeedle" && !document.querySelector(".music-track-panel")?.hasAttribute("aria-busy"));
          assert.equal(new URL(page.url()).searchParams.get("q"), "InitialNeedle");
          assert.equal(await page.locator(".music-sort").inputValue(), "artist");
          assert.equal(await page.locator(".music-track-table .music-track-title strong").first().textContent(), "Track InitialNeedle-1");
          assert.equal(await page.evaluate(() => __documentToken), token, "browser back must restore the query within the actual music document");
        } finally { await page.close(); }
      });
      for (const width of [1440, 390, 320]) await run(`playback volume stays available across views at ${width}px ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click(); await page.waitForFunction(() => fixture.state.music.current?.id === "P" && !__audios[0].paused);
          await page.locator(".music-volume").fill("0");
          await page.locator(".music-volume").evaluate(input => { fixture.oldVolumeControl = input; });
          const playing = await audioState(page);
          await page.setViewportSize({ width, height: 720 });
          await page.getByRole("button", { name: "打开当前歌曲播放页", exact: true }).click();
          assert.equal(await page.locator(".music-stage-player .music-volume").count(), 1, "the current-song page must expose volume without making the listener leave the playback view");
          await tick(page);
          const volume = page.locator(".music-stage-player .music-volume");
          assert.equal(await volume.inputValue(), "0", "the single-track volume must retain the quiet volume selected in the music library");
          await volume.scrollIntoViewIfNeeded();
          assert.equal(await volume.evaluate(input => { const rect = input.getBoundingClientRect(), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2); return rect.height >= 44 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight && hit === input; }), true, "the single-track volume control must be visible, hit-testable and at least 44px tall");
          await page.locator('.music-lyric-lines [data-index="0"]').scrollIntoViewIfNeeded(); await tick(page);
          await assertVisibleLyric(page, 0);
          if (process.env.MUSIC_VOLUME_SCREENSHOT && width === 320 && !ignoreAbort) await page.screenshot({ path: process.env.MUSIC_VOLUME_SCREENSHOT });
          await volume.focus(); await page.keyboard.press("End"); assert.equal(await page.evaluate(() => __audios[0].volume), 1);
          await page.keyboard.press("Home"); assert.equal(await page.evaluate(() => __audios[0].volume), 0);
          await volume.fill("37"); await page.keyboard.press("ArrowLeft");
          assert.deepEqual(await page.evaluate(() => [fixture.state.music.volume, __audios[0].volume, localStorage.getItem("fanhao.music.volume")]), [.36, .36, "0.36"], "native range keyboard input must update the live player, state and saved volume together");
          await page.keyboard.press("Space");
          await page.evaluate(() => { fixture.oldVolumeControl.value = "100"; fixture.oldVolumeControl.dispatchEvent(new InputEvent("input", { bubbles: true })); });
          assert.equal(await page.evaluate(() => __audios[0].volume), .36, "an old library volume control must not overwrite the current playback view");
          assert.deepEqual(await audioState(page), playing, "volume adjustment must preserve the source, listening point and playback intent");
          await page.getByRole("button", { name: "返回音乐库", exact: true }).click();
          assert.equal(await page.locator(".music-volume").inputValue(), "36");
          await page.locator('.music-track-table [data-music-track-id="B"] .music-track-title').click(); await page.waitForFunction(() => fixture.state.music.current?.id === "B" && !__audios[0].paused);
          assert.deepEqual(await page.evaluate(() => [fixture.state.music.volume, __audios[0].volume, __audios.length]), [.36, .36, 1], "view changes and a new song must retain the selected volume without rebuilding Audio");
        } finally { await page.close(); }
      });
      if (ignoreAbort) await run("playback volume survives unavailable preference storage during view changes", async () => {
        const page = await newPage({ ignoreAbort });
        try {
          await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click(); await page.waitForFunction(() => fixture.state.music.current?.id === "P" && !__audios[0].paused);
          await page.evaluate(() => { const set = Storage.prototype.setItem, get = Storage.prototype.getItem; Storage.prototype.setItem = function (key, value) { if (key === "fanhao.music.volume") throw new DOMException("Synthetic blocked volume preference", "SecurityError"); return set.call(this, key, value); }; Storage.prototype.getItem = function (key) { if (key === "fanhao.music.volume") throw new DOMException("Synthetic blocked volume preference", "SecurityError"); return get.call(this, key); }; });
          await page.locator(".music-volume").fill("0"); await page.getByRole("button", { name: "打开当前歌曲播放页", exact: true }).click();
          assert.deepEqual(await page.locator(".music-volume").evaluate(input => [input.value, fixture.state.music.volume, __audios[0].volume]), ["0", 0, 0], "blocked preferences must not make the playback view show a different volume from the live audio");
          await page.locator(".music-volume").fill("37"); await page.getByRole("button", { name: "返回音乐库", exact: true }).click();
          assert.deepEqual(await page.locator(".music-volume").evaluate(input => [input.value, fixture.state.music.volume, __audios[0].volume, __audios[0].paused]), ["37", .37, .37, false]);
        } finally { await page.close(); }
      });
      await run(`playlist dialog Escape closes and returns to its opening control ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click(); await page.waitForFunction(() => fixture.state.music.current?.id === "P" && !__audios[0].paused);
          await page.evaluate(() => { __audios[0].currentTime = 42; }); const playing = await audioState(page);
          const initial = hold(url => url.pathname === "/api/music/playlists");
          try {
            const immediate = await page.locator(".music-now-panel").getByRole("button", { name: "加入歌单", exact: true }).evaluate(button => {
              const original = window.requestAnimationFrame; window.__playlistInitialFrames = [];
              window.requestAnimationFrame = callback => { __playlistInitialFrames.push(callback); return 0; };
              try {
                button.focus(); button.click();
                const inside = Boolean(document.activeElement?.closest(".music-playlist-dialog"));
                document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
                return { inside, remaining: document.querySelectorAll(".music-playlist-dialog").length, returned: document.activeElement === button };
              } finally { window.requestAnimationFrame = original; }
            });
            assert.equal(immediate.remaining, 0, "a mounted playlist dialog must handle Escape before any focus animation frame");
            assert.equal(immediate.inside, true, "mounting a playlist dialog must synchronously transfer keyboard focus into it");
            assert.equal(immediate.returned, true);
            await requested(initial); await settle(page, initial);
            assert.equal(await page.locator(".music-playlist-dialog").count(), 0, "late initial choices must not reopen an immediately dismissed dialog");
          } finally { initial.release(); held.delete(initial); }
          const opening = await openKeyboardPlaylistDialog(page, true);
          const input = page.locator(".music-playlist-dialog-form input"); await input.waitFor(); await input.focus();
          await input.press("Escape");
          assert.equal(await page.locator(".music-playlist-dialog").count(), 0, "Escape must dismiss the playlist dialog instead of trapping the user in an unresponsive modal");
          assert.equal(await opening.evaluate(button => document.activeElement === button), true, "closing the playlist dialog must return keyboard focus to its opener");
          assert.deepEqual(await audioState(page), playing, "dismissing the playlist dialog must preserve playback and listening position");
        } finally { await page.close(); }
      });
      await run(`playlist dialog native Tab stays within its visible controls ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click(); await page.waitForFunction(() => fixture.state.music.current?.id === "P" && !__audios[0].paused);
          await openKeyboardPlaylistDialog(page);
          const dialog = page.locator(".music-playlist-dialog"); await dialog.waitFor();
          await page.waitForFunction(() => document.activeElement?.matches(".music-playlist-dialog-form input")); await tick(page);
          await dialog.locator('button[type="submit"]').focus(); await page.keyboard.press("Tab");
          assert.equal(await dialog.evaluate(dialog => dialog.contains(document.activeElement)), true, "Tab from the final dialog control must stay in the modal rather than reaching covered page controls");
          assert.equal(await dialog.getByRole("button", { name: "关闭", exact: true }).evaluate(button => document.activeElement === button), true);
          await page.keyboard.press("Shift+Tab");
          assert.equal(await dialog.locator('button[type="submit"]').evaluate(button => document.activeElement === button), true, "reverse Tab from the first control must wrap to the final dialog control");
        } finally { await page.close(); }
      });
      await run(`playlist dialog composition and native form submission remain available ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click(); await page.waitForFunction(() => fixture.state.music.current?.id === "P" && !__audios[0].paused);
          await openKeyboardPlaylistDialog(page);
          const input = page.locator(".music-playlist-dialog-form input"); await input.waitFor(); await input.focus();
          const before = countRequests(url => url.pathname.startsWith("/api/music/"));
          const ignored = await input.evaluate(input => {
            const results = [];
            input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
            for (const key of ["Escape", "Enter"]) {
              const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }); input.dispatchEvent(event); results.push(event.defaultPrevented);
            }
            input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
            for (const flags of [{ keyCode: 229 }, { isComposing: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
              const event = new KeyboardEvent("keydown", { key: "Escape", ...flags, bubbles: true, cancelable: true }); input.dispatchEvent(event); results.push(event.defaultPrevented);
            }
            fixture.playlistFormSubmits = 0;
            input.form.addEventListener("submit", () => fixture.playlistFormSubmits++);
            return results;
          });
          assert(ignored.every(prevented => !prevented), "candidate and modified Escape keys must retain their native behavior");
          assert.equal(await page.locator(".music-playlist-dialog").count(), 1, "IME candidate Escape must leave the dialog open");
          await input.press("Enter");
          assert.equal(await page.evaluate(() => fixture.playlistFormSubmits), 1, "native Enter must still submit the playlist form");
          assert.equal(countRequests(url => url.pathname.startsWith("/api/music/")), before, "an empty playlist name must not create a playlist or change playback");
          await input.press("Escape"); assert.equal(await page.locator(".music-playlist-dialog").count(), 0);
        } finally { await page.close(); }
      });
      await run(`playlist dialog skips disabled controls and contains programmatic focus ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click(); await page.waitForFunction(() => fixture.state.music.current?.id === "P" && !__audios[0].paused);
          await openKeyboardPlaylistDialog(page);
          const dialog = page.locator(".music-playlist-dialog"), input = dialog.locator("input"); await input.waitFor(); await input.focus(); await tick(page);
          await dialog.evaluate(dialog => { for (const button of dialog.querySelectorAll('button:not([aria-label="关闭"])')) button.disabled = true; });
          await input.press("Tab");
          assert.equal(await dialog.getByRole("button", { name: "关闭", exact: true }).evaluate(button => document.activeElement === button), true, "disabled dialog actions must be skipped when wrapping forward");
          await page.keyboard.press("Shift+Tab"); assert.equal(await input.evaluate(input => document.activeElement === input), true);
          await page.locator(".music-sort").focus();
          assert.equal(await input.evaluate(input => document.activeElement === input), true, "a programmatic background focus must stay inside the active modal");
          await dialog.evaluate(dialog => { for (const control of dialog.querySelectorAll("button,input")) control.disabled = true; dialog.focus(); });
          await page.keyboard.press("Tab");
          assert.equal(await dialog.evaluate(dialog => document.activeElement === dialog), true, "a dialog with no enabled controls must retain a keyboard focus fallback");
          await page.keyboard.press("Shift+Tab"); assert.equal(await dialog.evaluate(dialog => document.activeElement === dialog), true);
          await page.locator(".music-sort").focus(); assert.equal(await dialog.evaluate(dialog => document.activeElement === dialog), true);
          await page.keyboard.press("Escape"); assert.equal(await page.locator(".music-playlist-dialog").count(), 0);
        } finally { await page.close(); }
      });
      await run(`playlist dialog detached controls cannot close a newer dialog or navigation ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click(); await page.waitForFunction(() => fixture.state.music.current?.id === "P" && !__audios[0].paused);
          await openKeyboardPlaylistDialog(page);
          await page.locator(".music-playlist-dialog").evaluate(dialog => { fixture.oldPlaylistDialog = dialog; });
          await page.locator(".music-playlist-dialog-form input").press("Escape");
          await page.locator('.music-track-table [data-music-track-id="B"] .music-track-title').click(); await page.waitForFunction(() => fixture.state.music.current?.id === "B" && !__audios[0].paused);
          await openKeyboardPlaylistDialog(page);
          await page.locator(".music-playlist-dialog-form input").fill("New dialog draft");
          await page.evaluate(() => {
            const old = fixture.oldPlaylistDialog, input = old.querySelector("input"); input.value = "Obsolete draft"; input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            old.querySelector('[aria-label="关闭"]').click(); old.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
            old.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
          });
          assert.deepEqual(await page.evaluate(() => [fixture.state.music.playlistDialogOpen, fixture.state.music.playlistDialogTrackId, fixture.state.music.playlistDialogName]), [true, "B", "New dialog draft"], "detached dialog controls must not close or edit a newer dialog");
          await launchRoute(page, { musicMode: "artists" }); await page.waitForFunction(() => fixture.state.music.mode === "artists" && !fixture.state.music.loading);
          assert.equal(await page.locator(".music-playlist-dialog").count(), 0, "explicit navigation must release the old dialog and its focus containment");
          await page.locator('[data-music-search="artists"]').focus();
          assert.equal(await page.evaluate(() => document.activeElement?.dataset.musicSearch), "artists");
          await page.evaluate(() => fixture.oldPlaylistDialog.querySelector('[aria-label="关闭"]').click());
          assert.equal(await page.evaluate(() => document.activeElement?.dataset.musicSearch), "artists", "closing a stale dialog must not restore old navigation focus");
        } finally { await page.close(); }
      });
      await run(`playlist dialog late choices preserve current typing and stable button focus ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        const choices = [{ id: "second", name: "Second playlist", trackCount: 1 }, { id: "new", name: "New playlist", trackCount: 2 }];
        try {
          await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click(); await page.waitForFunction(() => fixture.state.music.current?.id === "P" && !__audios[0].paused);
          const playing = await audioState(page);
          for (const typed of [true, false]) {
            const read = hold(url => url.pathname === "/api/music/playlists", "", { playlists: typed ? choices : [...choices].reverse() });
            try {
              await page.locator(".music-now-panel").getByRole("button", { name: "加入歌单", exact: true }).click(); await requested(read);
              await page.waitForFunction(() => document.activeElement?.matches(".music-playlist-dialog-form input")); await tick(page);
              if (typed) {
                await page.locator(".music-playlist-dialog-form input").fill("Keyboard draft");
                await page.locator(".music-playlist-dialog-form input").evaluate(input => input.setSelectionRange(2, 6));
              } else await page.locator('[data-music-playlist-id="new"]').focus();
              const remounted = await page.evaluate(() => {
                const original = window.requestAnimationFrame, frames = [];
                window.requestAnimationFrame = callback => { frames.push(callback); return 0; };
                try {
                  fixture.page.renderView();
                  const input = document.querySelector(".music-playlist-dialog-form input"), active = document.activeElement;
                  return { input: [input.value, input.selectionStart, input.selectionEnd, active === input], playlist: active?.dataset.musicPlaylistId };
                } finally { window.requestAnimationFrame = original; for (const callback of frames) callback(performance.now()); }
              });
              if (typed) assert.deepEqual(remounted.input, ["Keyboard draft", 2, 6, true], "a complete music render must synchronously restore the mounted modal's draft, selection and focus");
              else assert.equal(remounted.playlist, "new", "a complete music render must synchronously restore the focused playlist by ID");
              await page.evaluate(() => {
                const previous = document.querySelector(".music-playlist-dialog-backdrop");
                window.__playlistChoicesFrames = []; window.__playlistChoicesRaf = window.requestAnimationFrame;
                window.requestAnimationFrame = callback => { __playlistChoicesFrames.push(callback); return 0; };
                window.__playlistChoicesMounted = new Promise(resolve => {
                  const observer = new MutationObserver(() => {
                    const next = document.querySelector(".music-playlist-dialog-backdrop");
                    if (!next || next === previous) return;
                    observer.disconnect();
                    const input = next.querySelector("input"), active = document.activeElement;
                    const result = { input: [input.value, input.selectionStart, input.selectionEnd, active === input], playlist: active?.dataset.musicPlaylistId };
                    active.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
                    resolve({ ...result, remaining: document.querySelectorAll(".music-playlist-dialog").length });
                  });
                  observer.observe(document.querySelector(".music-shell"), { childList: true });
                });
              });
              read.release();
              const immediate = await page.evaluate(() => __playlistChoicesMounted);
              await page.evaluate(() => { window.requestAnimationFrame = __playlistChoicesRaf; for (const callback of __playlistChoicesFrames) callback(performance.now()); });
              await tick(page);
              if (typed) assert.deepEqual(immediate.input, ["Keyboard draft", 2, 6, true], "late playlist choices must preserve the current name draft, selection and focus before a focus frame");
              else assert.equal(immediate.playlist, "new", "late reordered playlist choices must preserve the focused playlist by ID before a focus frame");
              assert.equal(immediate.remaining, 0, "rebuilt playlist choices must immediately retain Escape dismissal without waiting for a focus frame");
            } finally { read.release(); }
          }
          assert.deepEqual(await audioState(page), playing);
        } finally { await page.close(); }
      });
      for (const navigation of ["popstate", "back"]) await run(`playlist dialog ${navigation} releases stale focus frames and pending choices ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort });
        const old = hold(url => url.pathname === "/api/music/playlists");
        try {
          await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click(); await page.waitForFunction(() => __audios[0]?.src.endsWith("/synthetic/audio/P") && !__audios[0].paused);
          await page.evaluate(() => { __audios[0].currentTime = 42; });
          if (navigation === "back") { await navigateRoute(page, "/music/library?sort=artist"); await page.waitForFunction(() => document.querySelector(".music-sort")?.value === "artist" && !document.querySelector(".music-track-panel")?.hasAttribute("aria-busy")); }
          const playing = await audioState(page), documentToken = await page.evaluate(() => __documentToken);
          // Hold only the synchronous initial modal focus frame, then restore
          // native animation frames before exercising real host navigation.
          await page.locator(".music-now-panel").getByRole("button", { name: "加入歌单", exact: true }).evaluate(button => {
            const original = window.requestAnimationFrame; window.__playlistFocusFrames = [];
            window.requestAnimationFrame = callback => { __playlistFocusFrames.push(callback); return 0; };
            button.click();
            window.requestAnimationFrame = original;
          });
          await requested(old);
          if (navigation === "back") await page.goBack({ waitUntil: "commit" }); else await navigateRoute(page, "/music/artists");
          await ready(page);
          const input = page.locator(`[data-music-search="${navigation === "back" ? "library" : "artists"}"]`); await input.waitFor(); await input.focus();
          await finishOld(page, old, ignoreAbort);
          await page.evaluate(() => { for (const callback of __playlistFocusFrames) callback(performance.now()); }); await tick(page);
          assert.equal(await page.locator(".music-playlist-dialog").count(), 0, "new history navigation must not reopen the old playlist dialog");
          assert.equal(await input.evaluate(input => document.activeElement === input), true, "old modal focus frames and playlist responses must not take focus from the new route");
          assert.equal(await page.evaluate(() => __documentToken), documentToken);
          assert.deepEqual(await audioState(page), playing, "history navigation away from a modal must preserve audio and listening position");
        } finally { old.release(); await page.close(); }
      });
      await run(`search suggestions survive their own automatic list refresh ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        const suggestion = hold(url => url.pathname === "/api/music/suggest" && url.searchParams.get("q") === "slow-suggest", "", { tracks: [track("A")], artists: [], albums: [] });
        const list = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "slow-suggest");
        try {
          await page.setViewportSize({ width: ignoreAbort ? 390 : 320, height: 900 });
          await page.locator('[data-music-search="library"]').fill("slow-suggest"); await requested(suggestion); await requested(list);
          suggestion.release(); list.release();
          await page.waitForFunction(() => fixture.state.music.query === "slow-suggest" && !fixture.state.music.loading); await tick(page);
          assert.equal(await page.locator(".music-search-suggest-item").count(), 1, "the current suggestion response must remain usable after its own debounced list refresh");
          const button = page.locator(".music-search-suggest-item"); await button.scrollIntoViewIfNeeded();
          assert.equal(await button.evaluate(button => { const box = button.getBoundingClientRect(); const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2); return box.height >= 44 && box.left >= 0 && box.right <= innerWidth && (hit === button || button.contains(hit)); }), true, "current suggestions must be visible and clickable on a narrow viewport");
          if (process.env.MUSIC_SUGGEST_SCREENSHOT && !ignoreAbort) await page.screenshot({ path: process.env.MUSIC_SUGGEST_SCREENSHOT });
          const reads = countRequests(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "slow-suggest");
          if (ignoreAbort) await button.click();
          else { await page.locator('[data-music-search="library"]').focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Enter"); }
          await page.waitForFunction(() => fixture.state.music.current?.id === "A" && !__audios[0].paused);
          assert.equal(await page.locator(".music-search-suggest-item").count(), 0);
          await page.waitForTimeout(260);
          assert.equal(countRequests(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "slow-suggest"), reads, "picking a song must not leave a trailing automatic search");
        } finally { suggestion.release(); list.release(); await page.close(); }
      });
      await run(`search suggestions keep keyboard focus when an earlier response precedes the list ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        const suggestion = hold(url => url.pathname === "/api/music/suggest" && url.searchParams.get("q") === "early-suggest", "", { tracks: [track("A"), track("B")], artists: [], albums: [] });
        const list = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "early-suggest");
        try {
          await page.locator('[data-music-search="library"]').fill("early-suggest"); await requested(suggestion); suggestion.release();
          await page.locator(".music-search-suggest-item").first().waitFor();
          await page.locator('[data-music-search="library"]').focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Tab");
          await page.evaluate(() => { fixture.state.music.suggestions.tracks.reverse(); });
          await requested(list); list.release(); await page.waitForFunction(() => !fixture.state.music.loading); await tick(page);
          assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("music-search-suggest-item")), true, "the same-query list response must preserve the user's focused suggestion");
          assert.equal(await page.evaluate(() => document.activeElement?.dataset.musicSuggestionKey), "track:B", "suggestion focus must follow its stable item ID when the same-query order changes");
          await page.keyboard.press("Enter"); await page.waitForFunction(() => fixture.state.music.current?.id === "B" && !__audios[0].paused);
        } finally { suggestion.release(); list.release(); await page.close(); }
      });
      await run(`search suggestions keep only the latest query and reject detached buttons ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        const old = hold(url => url.pathname === "/api/music/suggest" && url.searchParams.get("q") === "obsolete-suggest", "", { tracks: [track("A")], artists: [], albums: [] });
        const current = hold(url => url.pathname === "/api/music/suggest" && url.searchParams.get("q") === "current-suggest", "", { tracks: [track("B")], artists: [], albums: [] });
        const list = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "current-suggest");
        try {
          await page.locator('[data-music-search="library"]').fill("obsolete-suggest"); await requested(old);
          await page.locator('[data-music-search="library"]').fill("current-suggest"); await requested(current); await requested(list);
          await settle(page, current); await settle(page, list); await finishOld(page, old, ignoreAbort);
          assert.deepEqual(await page.locator(".music-search-suggest-item strong").allTextContents(), ["Track B"], "late suggestions must not replace the latest query's choices");
          await page.locator(".music-search-suggest-item").evaluate(button => { fixture.oldSuggestionButton = button; });
          await page.locator('[data-music-search="library"]').fill("ab");
          await page.evaluate(() => fixture.oldSuggestionButton.click()); await page.waitForTimeout(280);
          assert.deepEqual(await page.evaluate(() => [fixture.state.music.query, fixture.state.music.current?.id || null, document.querySelectorAll(".music-search-suggest-item").length]), ["ab", null, 0], "a detached suggestion must not play or clear the newer query");
          assert.equal(countRequests(url => url.pathname === "/api/music/suggest" && url.searchParams.get("q") === "ab"), 0, "short queries must not start suggestion reads");
        } finally { old.release(); current.release(); list.release(); await page.close(); }
      });
      await run(`search suggestions native Enter and Escape cancel old choices ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          for (const key of ["Enter", "Escape"]) {
            const query = `cancel-${key.toLowerCase()}`;
            const before = countRequests(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === query);
            const old = hold(url => url.pathname === "/api/music/suggest" && url.searchParams.get("q") === query, "", { tracks: [track("A")], artists: [], albums: [] });
            try {
              await page.locator('[data-music-search="library"]').fill(query); await requested(old);
              await page.locator('[data-music-search="library"]').press(key); await finishOld(page, old, ignoreAbort); await page.waitForTimeout(280);
              // Native search inputs clear on Escape; Enter submits the query.
              assert.deepEqual(await page.evaluate(() => [fixture.state.music.query, fixture.state.music.current?.id || null, document.querySelectorAll(".music-search-suggest-item").length]), [key === "Escape" ? "" : query, null, 0], `${key} must not allow a canceled suggestion to reappear or play`);
              assert.equal(countRequests(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === query) - before, key === "Escape" ? 0 : 1, `${key} must consume the old query's debounce without a duplicate`);
            } finally { old.release(); }
          }
        } finally { await page.close(); }
      });
      await run(`search suggestions composition and navigation cancel nonempty responses ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        const old = hold(url => url.pathname === "/api/music/suggest" && url.searchParams.get("q") === "before-ime-suggest", "", { tracks: [track("A")], artists: [], albums: [] });
        try {
          await page.locator('[data-music-search="library"]').fill("before-ime-suggest"); await requested(old);
          await page.locator('[data-music-search="library"]').evaluate(input => {
            input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); input.value = "输入草稿";
            input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
          });
          await finishOld(page, old, ignoreAbort); await page.waitForTimeout(280);
          assert.equal(await page.locator(".music-search-suggest-item").count(), 0);
          assert.equal(await page.locator('[data-music-search="library"]').inputValue(), "输入草稿");
          assert.equal(countRequests(url => ["/api/music/tracks", "/api/music/suggest"].includes(url.pathname) && url.searchParams.get("q") === "输入草稿"), 0);
          await launchRoute(page, { musicMode: "library", musicQuery: "leave-suggest" }); await page.waitForFunction(() => !fixture.state.music.loading);
          const leaving = hold(url => url.pathname === "/api/music/suggest" && url.searchParams.get("q") === "leave-suggest-again", "", { tracks: [track("B")], artists: [], albums: [] });
          try {
            await page.locator('[data-music-search="library"]').fill("leave-suggest-again"); await requested(leaving);
            await launchRoute(page, { musicMode: "artists" }); await page.waitForFunction(() => fixture.state.music.mode === "artists" && !fixture.state.music.loading);
            await finishOld(page, leaving, ignoreAbort);
            assert.deepEqual(await page.evaluate(() => [fixture.state.music.mode, fixture.state.music.query, document.querySelectorAll(".music-search-suggest-item").length]), ["artists", "", 0], "leaving the library must invalidate even a nonempty late suggestion");
          } finally { leaving.release(); }
        } finally { old.release(); await page.close(); }
      });
      if (ignoreAbort) {
        await run("search suggestions cached choice consumes the pending automatic search", async () => {
          const page = await newPage({ ignoreAbort });
          const suggestion = hold(url => url.pathname === "/api/music/suggest" && url.searchParams.get("q") === "cached-suggest", "", { tracks: [track("A")], artists: [], albums: [] });
          const list = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "cached-suggest");
          try {
            await page.locator('[data-music-search="library"]').fill("cached-suggest"); await requested(suggestion); await requested(list);
            await settle(page, suggestion); await settle(page, list);
            const before = countRequests(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "cached-suggest");
            // A cached response is synchronous, so the click is unambiguously
            // before the next list debounce instead of racing its 220ms timer.
            await page.locator('[data-music-search="library"]').evaluate(input => {
              input.value = ""; input.dispatchEvent(new InputEvent("input", { bubbles: true }));
              input.value = "cached-suggest"; input.dispatchEvent(new InputEvent("input", { bubbles: true }));
              document.querySelector(".music-search-suggest-item").click();
            });
            await page.waitForFunction(() => fixture.state.music.current?.id === "A" && !__audios[0].paused); await page.waitForTimeout(280);
            assert.equal(countRequests(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "cached-suggest"), before, "choosing a cached song must cancel its not-yet-fired list debounce");
            assert.equal(await page.locator(".music-search-suggest-item").count(), 0);
          } finally { suggestion.release(); list.release(); await page.close(); }
        });
        await run("search suggestions preserve newer external focus and playback", async () => {
          const page = await newPage({ ignoreAbort });
          const suggestion = hold(url => url.pathname === "/api/music/suggest" && url.searchParams.get("q") === "external-focus", "", { tracks: [track("A")], artists: [], albums: [] });
          const list = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "external-focus");
          try {
            await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click(); await page.waitForFunction(() => fixture.state.music.current?.id === "P" && !__audios[0].paused);
            await page.evaluate(() => { __audios[0].currentTime = 42; }); const playing = await audioState(page);
            await page.locator('[data-music-search="library"]').fill("external-focus"); await requested(suggestion); await settle(page, suggestion);
            await page.locator(".music-volume").focus(); await requested(list); await settle(page, list);
            assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("music-volume")), true, "a later external focus must not be replaced by suggestion focus restoration");
            assert.deepEqual(await audioState(page), playing, "suggestion refresh must preserve the current source, time and playing intent");
          } finally { suggestion.release(); list.release(); await page.close(); }
        });
        await run("search suggestions artist and album choices navigate once without interrupting audio", async () => {
          const page = await newPage({ ignoreAbort });
          try {
            await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click(); await page.waitForFunction(() => fixture.state.music.current?.id === "P" && !__audios[0].paused);
            await page.evaluate(() => { __audios[0].currentTime = 42; }); const playing = await audioState(page);
            for (const kind of ["artist", "album"]) {
              const query = `group-${kind}`, target = kind === "artist" ? "Artist B" : "Synthetic album";
              const body = { tracks: [], artists: kind === "artist" ? [{ id: "artist-B", name: target, trackCount: 2 }] : [], albums: kind === "album" ? [{ id: "album-1", title: target, artistName: "Artist B", trackCount: 2 }] : [] };
              const suggestion = hold(url => url.pathname === "/api/music/suggest" && url.searchParams.get("q") === query, "", body);
              const list = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === query);
              try {
                const before = countRequests(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === target);
                await page.locator('[data-music-search="library"]').fill(query); await requested(suggestion); await requested(list);
                await settle(page, suggestion); await settle(page, list);
                await page.locator(".music-search-suggest-item").click(); await page.waitForFunction(target => fixture.state.music.query === target && !fixture.state.music.loading, target); await page.waitForTimeout(280);
                assert.equal(countRequests(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === target) - before, 1, "a group suggestion must navigate to its result query exactly once");
                assert.deepEqual(await page.evaluate(() => [fixture.state.music.mode, fixture.state.music.artistId, fixture.state.music.albumId, fixture.state.music.favorite]), ["library", "all", "all", false]);
                assert.equal(await page.locator('[data-music-search="library"]').inputValue(), target);
                assert.deepEqual(await audioState(page), playing, "artist and album suggestions must preserve existing playback");
              } finally { suggestion.release(); list.release(); }
            }
          } finally { await page.close(); }
        });
      }
      await run(`rating writes preserve the last selected score ${transport}`, async () => {
        ratingValues.delete("A");
        const page = await newPage({ ignoreAbort });
        const first = hold(url => url.pathname === "/api/music/tracks/A/rating");
        try {
          await page.locator('.music-track-table [data-music-track-id="A"] .music-track-title').click();
          await page.waitForFunction(() => fixture.state.music.current?.id === "A" && !__audios[0].paused);
          const playback = await audioState(page);
          await page.locator(".music-rating.now").getByRole("button", { name: "设为 3 星", exact: true }).click(); await requested(first);
          await page.locator(".music-rating.now").getByRole("button", { name: "设为 5 星", exact: true }).click();
          await page.waitForTimeout(60); first.release();
          for (let attempt = 0; attempt < 30 && !(first.finished && ratingValues.get("A") === 5); attempt++) await page.waitForTimeout(20);
          assert.equal(ratingValues.get("A"), 5, "the last selected score must remain persisted when an earlier rating write finishes late");
          await page.waitForFunction(() => fixture.state.music.current?.rating === 5);
          assert.equal(await page.locator(".music-rating.now .active").count(), 5);
          assert.deepEqual(await audioState(page), playback, "rating changes must preserve audio, position and playback intent");
        } finally { first.release(); await page.close(); }
      });
      if (ignoreAbort) {
        await run("rating writes coalesce unsent choices to the latest score", async () => {
          const page = await newRatingPage(), first = hold(url => url.pathname === "/api/music/tracks/A/rating"), start = ratingSubmissions.length;
          try {
            await clickRating(page, 3); await requested(first); await clickRating(page, 4); await clickRating(page, 5);
            await tick(page);
            assert.deepEqual(ratingSubmissions.slice(start).map(item => item.rating), [3], "only one score write may be in flight for the same account and track");
            first.release(); await waitRating(page, "A", 5);
            assert.deepEqual(ratingSubmissions.slice(start).map(item => item.rating), [3, 5], "only the newest unsent rating should be committed");
          } finally { first.release(); await page.close(); }
        });
        await run("rating writes preserve an explicit clear as the final score", async () => {
          const page = await newRatingPage(5), first = hold(url => url.pathname === "/api/music/tracks/A/rating");
          try {
            await clickRating(page, 3); await requested(first); await clickRating(page, 0); first.release(); await waitRating(page, "A", 0);
            assert.equal(await page.locator(".music-rating.now .active").count(), 0);
          } finally { first.release(); await page.close(); }
        });
        for (const failedLatest of [false, true]) await run(`rating writes ${failedLatest ? "retain the confirmed score after latest failure and retry" : "continue after an obsolete failure"}`, async () => {
          const page = await newRatingPage();
          if (failedLatest) await page.setViewportSize({ width: 320, height: 740 });
          const first = hold(url => url.pathname === "/api/music/tracks/A/rating", failedLatest ? "" : "Obsolete score save failed");
          const last = hold(url => url.pathname === "/api/music/tracks/A/rating", failedLatest ? "Latest score save failed" : "");
          let retry;
          try {
            await clickRating(page, 3); await requested(first); await clickRating(page, 5); first.release(); await requested(last); last.release();
            if (failedLatest) {
              await page.waitForFunction(() => fixture.state.music.status.includes("评分未保存"));
              assert.deepEqual(await page.evaluate(() => [fixture.state.music.current.rating, fixture.state.music.status.includes("3 星")]), [3, true], "a failed last write must retain and explain the last confirmed score");
              assert.equal(ratingValues.get("A"), 3);
              const alert = page.locator('.music-rating-feedback[role="alert"]');
              assert.equal(await alert.isVisible(), true, "the current rating failure cause must be visible rather than only stored in status");
              assert((await alert.innerText()).includes("Latest score save failed"));
              assert((await alert.innerText()).includes("3 星"));
              assert.equal(await alert.evaluate(node => {
                window.__ratingFailureNotice = node;
                const rect = node.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
                  && node.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
              }), true, "the rating failure must remain inside the narrow viewport and be unobstructed");
              retry = hold(url => url.pathname === "/api/music/tracks/A/rating");
              await clickRating(page, 5); await requested(retry);
              assert.equal(await alert.evaluate(node => node === __ratingFailureNotice && node.isConnected), true, "starting a retry must retain the unconfirmed failure notice");
              assert.equal(await alert.isVisible(), true);
              await settle(page, retry); await waitRating(page, "A", 5);
              assert.equal(await page.evaluate(() => fixture.state.music.status), "", "successful rating retry must clear its owned error");
              assert.equal(await page.locator(".music-rating-feedback").count(), 0, "only a confirmed rating retry may clear the visible failure");
            } else {
              await waitRating(page, "A", 5); assert.equal(await page.evaluate(() => fixture.state.music.status), "", "an obsolete failure must not obscure a successful later choice");
            }
          } finally { first.release(); last.release(); retry?.release(); await page.close(); }
        });
        await run("rating writes refresh the confirmed score order after a later save fails", async () => {
          const page = await newRatingPage();
          const first = hold(url => url.pathname === "/api/music/tracks/A/rating"), last = hold(url => url.pathname === "/api/music/tracks/A/rating", "Latest sorted score failed");
          try {
            await page.locator(".music-sort").selectOption("rating"); await page.waitForFunction(() => !fixture.state.music.loading);
            await clickRating(page, 3); await requested(first); await clickRating(page, 5); first.release(); await requested(last); last.release();
            await page.waitForFunction(() => fixture.state.music.status.includes("评分未保存"));
            assert.equal(await page.locator(".music-track-table [data-music-track-id]").first().getAttribute("data-music-track-id"), "A", "the last confirmed score must refresh rating-sorted membership and order even when a later save fails");
          } finally { first.release(); last.release(); await page.close(); }
        });
        for (const outcome of ["refresh failure", "new navigation", "new request error", "new score failure"]) await run(`rating writes confirmed-score refresh preserves ${outcome}`, async () => {
          const page = await newRatingPage();
          const first = hold(url => url.pathname === "/api/music/tracks/A/rating"), last = hold(url => url.pathname === "/api/music/tracks/A/rating", "Latest sorted score failed");
          let refresh, newer;
          try {
            await page.locator(".music-sort").selectOption("rating"); await page.waitForFunction(() => !fixture.state.music.loading);
            refresh = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("sort") === "rating", outcome === "refresh failure" ? "Confirmed score list failed" : "");
            await clickRating(page, 3); await requested(first); await clickRating(page, 5); first.release(); await requested(last); last.release(); await requested(refresh);
            if (outcome === "refresh failure") {
              refresh.release(); await page.waitForFunction(() => fixture.state.music.status.includes("评分未保存") && fixture.state.music.status.includes("Confirmed score list failed"));
              assert.equal(await page.evaluate(() => fixture.state.music.current.rating), 3, "a failed refresh must keep the confirmed rating and expose its real cause");
            } else {
              if (outcome === "new navigation") {
                await page.getByRole("button", { name: /^歌手浏览/ }).first().click(); await page.waitForFunction(() => fixture.state.music.mode === "artists" && !fixture.state.music.loading);
              } else if (outcome === "new request error") {
                newer = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("sort") === "rating" && Number(url.searchParams.get("offset")) > 0, "Newer rating refresh failure");
                await page.locator(".music-track-panel .music-load-more").click(); await requested(newer); newer.release();
                await page.waitForFunction(() => fixture.state.music.status === "Newer rating refresh failure");
              } else {
                const reads = countMethodRequests("GET", "/api/music/tracks");
                newer = hold(url => url.pathname === "/api/music/tracks/A/rating", "Newer score save failed");
                await clickRating(page, 2); await requested(newer); newer.release();
                await page.waitForFunction(() => fixture.state.music.status.includes("Newer score save failed"));
                assert.equal(countMethodRequests("GET", "/api/music/tracks"), reads, "a failed newer score must exercise the unchanged list generation");
              }
              const before = await page.evaluate(() => [location.href, fixture.state.music.mode, fixture.state.music.status, fixture.state.music.current.rating]);
              refresh.release(); for (let attempt = 0; attempt < 30 && !refresh.finished; attempt++) await page.waitForTimeout(20); await tick(page);
              assert.deepEqual(await page.evaluate(() => [location.href, fixture.state.music.mode, fixture.state.music.status, fixture.state.music.current.rating]), before, "an obsolete confirmed-score refresh must not cover newer navigation or request errors");
            }
          } finally { first.release(); last.release(); refresh?.release(); newer?.release(); await page.close(); }
        });
        await run("rating writes successful-score refresh failures preserve a later score error", async () => {
          const page = await newRatingPage(); let refresh, newer;
          try {
            await page.locator(".music-sort").selectOption("rating"); await page.waitForFunction(() => !fixture.state.music.loading);
            refresh = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("sort") === "rating", "Obsolete successful-score refresh failed");
            await clickRating(page, 3); await requested(refresh);
            const reads = countMethodRequests("GET", "/api/music/tracks");
            newer = hold(url => url.pathname === "/api/music/tracks/A/rating", "Newer score save failed");
            await clickRating(page, 2); await requested(newer); newer.release();
            await page.waitForFunction(() => fixture.state.music.status.includes("Newer score save failed"));
            assert.equal(countMethodRequests("GET", "/api/music/tracks"), reads);
            const status = await page.evaluate(() => fixture.state.music.status);
            refresh.release(); for (let attempt = 0; attempt < 30 && !refresh.finished; attempt++) await page.waitForTimeout(20); await tick(page);
            assert.equal(await page.evaluate(() => fixture.state.music.status), status, "an old successful-score refresh error must not replace a newer rating failure cause");
          } finally { refresh?.release(); newer?.release(); await page.close(); }
        });
        await run("rating writes for different tracks remain parallel", async () => {
          for (const outcome of ["success", "failure"]) {
            const page = await newRatingPage(), first = hold(url => url.pathname === "/api/music/tracks/A/rating", outcome === "failure" ? "Obsolete stage rating failure" : "");
            const detail = hold(url => url.pathname === "/api/music/tracks/B", "", { track: track("B"), lyrics: { raw: "", lines: Array.from({ length: 5000 }, (_, index) => ({ timeMs: index * 1000, text: `Line B ${index}` })) } });
            try {
              await page.evaluate(() => { fixture.state.music.data.rawTracks = [null, ...fixture.state.music.data.tracks, { ...fixture.state.music.data.tracks.find(track => track.id === "A") }]; });
              await clickRating(page, 3); await requested(first);
              await page.locator('.music-queue-row[data-music-track-id="B"] .music-queue-play').click(); await requested(detail); await settle(page, detail);
              await page.waitForFunction(() => fixture.state.music.current?.id === "B");
              await clickRating(page, 4); await waitRating(page, "B", 4);
              assert.equal(first.finished, undefined, "an unrelated track must not wait for a held rating write");
              await page.getByRole("button", { name: "展开播放页", exact: true }).click();
              await page.locator(".music-lyric-find input").fill("Line B");
              await page.evaluate(() => { __audios[0].currentTime = 42; });
              const known = await favoriteKnownMetadata(page, "A"), playing = await audioState(page), route = page.url(), reads = countMethodRequests("GET", "/api/music/tracks");
              assert.equal(new URL(route).pathname, "/music/track/B");
              await captureFavoriteOwnershipSurface(page, { inputSelector: ".music-lyric-find input", scrollSelector: ".music-stage-content", draft: "  新的评分草稿  " });
              await page.locator(".music-stage-content").evaluate(node => { node.scrollTop = 112; __favoriteOwnershipSurface.top = node.scrollTop; });
              assert.equal(await page.locator(".music-stage-content").evaluate(node => node.scrollTop), 112, "the newer B stage must have a real scroll position before A's rating settles");
              await settle(page, first); await assertFavoriteOwnershipSurface(page, "rating");
              assert.deepEqual(await page.evaluate(() => [fixture.state.music.current.id, fixture.state.music.current.rating]), ["B", 4], "old-track score completion must not replace the new current song");
              assert.deepEqual(await favoriteKnownMetadata(page, "A"), known.map(item => ({ ...item, rating: outcome === "success" ? 3 : Number(item.rating || 0) })), "same-account rating confirmation must update known A copies without changing their other metadata");
              assert.equal(await page.locator(".music-rating-feedback").count(), 0, "an obsolete rating failure must not appear over B's newer playback page");
              assert.equal(countMethodRequests("GET", "/api/music/tracks"), reads); assert.equal(page.url(), route);
              assert.deepEqual(await audioState(page), playing);
            } finally { first.release(); detail.release(); held.delete(detail); await page.close(); }
          }
        });
        for (const change of ["owner", "revision"]) await run(`rating writes discard unsent old-account choices after ${change} changes`, async () => {
          const page = await newRatingPage(), first = hold(url => url.pathname === "/api/music/tracks/A/rating"), start = ratingSubmissions.length;
          try {
            await clickRating(page, 3); await requested(first); await clickRating(page, 5);
            await page.evaluate(change => {
              const context = globalThis.__fanhaoWebAccountContext;
              if (change === "owner") context.owner = "synthetic-new-account";
              else { localStorage.setItem("fanhao.web.accountRevision.v1", "synthetic-rating-revision"); context.revision = "synthetic-rating-revision"; }
              fixture.state.music.current = { ...fixture.state.music.current, rating: 2 };
            }, change);
            first.release(); for (let attempt = 0; attempt < 30 && !first.finished; attempt++) await page.waitForTimeout(20); await tick(page);
            assert.deepEqual(ratingSubmissions.slice(start).map(item => item.rating), [3], "an unsent old-account score must not use the new account's credentials");
            assert.equal(await page.evaluate(() => fixture.state.music.current.rating), 2, "an old-account response must not update new-account rating state");
          } finally { first.release(); await page.close(); }
        });
        await run("rating writes do not publish old failures into a newer library view", async () => {
          const page = await newRatingPage(), first = hold(url => url.pathname === "/api/music/tracks/A/rating", "Old score failure");
          try {
            await clickRating(page, 3); await requested(first);
            await page.getByRole("button", { name: /^歌手浏览/ }).first().click();
            await page.waitForFunction(() => fixture.state.music.mode === "artists" && !fixture.state.music.loading);
            const before = await page.evaluate(() => [location.href, fixture.state.music.status, document.querySelector(".music-artist-grid")?.textContent]);
            first.release(); for (let attempt = 0; attempt < 30 && !first.finished; attempt++) await page.waitForTimeout(20); await tick(page);
            assert.deepEqual(await page.evaluate(() => [location.href, fixture.state.music.status, document.querySelector(".music-artist-grid")?.textContent]), before, "obsolete score errors must preserve the newer view and its status");
            assert.equal(await page.locator(".music-rating-feedback").count(), 0, "a retired rating failure must not create a visible alert on a new navigation");
          } finally { first.release(); await page.close(); }
        });
      }
      for (const paused of [false, true]) await run(`lyric plain reads and finds all text while ${paused ? "paused" : "playing"} ${transport}`, async () => {
        const raw = Array.from({ length: 5000 }, (_, index) => index === 8 ? "" : [10, 4800].includes(index) ? `Plain needle ${index}` : `Plain lyric ${index}`).join("\r\n");
        const page = await newLyricFindPage(ignoreAbort, 320, [], raw);
        try {
          assert.equal(await page.locator(".music-lyric-plain-label").count(), 1, "raw lyrics without timestamps must be readable instead of reporting no lyrics");
          assert.equal(await page.locator(".music-lyric-plain-label").textContent(), "纯文本歌词 · 无时间轴");
          if (paused) await page.locator(".music-stage-player").getByRole("button", { name: "暂停", exact: true }).click();
          const before = await audioState(page), select = page.getByRole("combobox", { name: "歌词段落", exact: true });
          assert.equal(await page.locator(".music-lyric-lines > p[data-index]").count(), 120);
          assert.equal(await page.locator(".music-lyric-lines > button").count(), 0, "plain text must not expose seek buttons");
          assert.equal(await page.locator('.music-lyric-lines [data-index="8"]').textContent(), "", "plain lyrics must preserve stanza breaks");
          assert.equal(await page.getByRole("button", { name: "回到当前", exact: true }).count(), 0);
          const input = page.getByRole("searchbox", { name: "查找当前歌词" });
          await input.fill("needle");
          assert.equal(await page.locator(".music-lyric-find-count").textContent(), "1 / 2");
          await input.press("Enter");
          assert.equal(await page.locator(".music-lyric-search-current").getAttribute("data-index"), "4800");
          assert.equal(await select.inputValue(), "40"); await assertVisibleLyric(page, 4800);
          if (process.env.MUSIC_LYRIC_SCREENSHOT) await page.screenshot({ path: process.env.MUSIC_LYRIC_SCREENSHOT });
          const row = page.locator('.music-lyric-lines [data-index="4800"]');
          await row.click(); await row.focus(); await row.press("Enter");
          await page.locator(".music-lyric-lines").evaluate(lines => {
            window.__plainLyricScrollEnded = false;
            lines.addEventListener("scrollend", () => { window.__plainLyricScrollEnded = true; }, { once: true });
          });
          await row.press("Space"); await row.press("ArrowRight");
          assert.deepEqual(await audioState(page), before, "plain lyric click and keyboard reading must never seek or change playback");
          await page.waitForFunction(() => window.__plainLyricScrollEnded);
          await select.selectOption("41"); await assertVisibleLyric(page, 4920);
          await page.locator(".music-lyric-lines").evaluate(element => element.scrollTo({ top: element.scrollHeight, behavior: "instant" })); await tick(page);
          await assertVisibleLyric(page, 4999);
          assert.equal(await page.locator(".music-lyric-lines > p[data-index]").count(), 80);
          assert.deepEqual(await audioState(page), before, "plain lyric browsing must preserve audio intent");
        } finally { await page.close(); }
      });
      await run(`lyric plain keeps text ownership and query across redraw ${transport}`, async () => {
        const raw = "<em>可复制的纯文本</em>\nPlain needle\n" + Array.from({ length: 245 }, (_, index) => `Plain stanza ${index}`).join("\n");
        const page = await newLyricFindPage(ignoreAbort, 1440, [], raw);
        try {
          assert.equal(await page.locator('.music-lyric-lines [data-index="0"]').textContent(), "<em>可复制的纯文本</em>");
          assert.equal(await page.locator(".music-lyric-lines em").count(), 0, "raw lyrics must remain literal selectable text");
          assert.equal(await page.locator('.music-lyric-lines [data-index="0"]').evaluate(element => getComputedStyle(element).userSelect), "text");
          const input = page.getByRole("searchbox", { name: "查找当前歌词" });
          await input.fill("needle");
          await page.evaluate(() => { fixture.state.music.lyrics = { ...fixture.state.music.lyrics }; fixture.page.renderView(); });
          assert.equal(await input.inputValue(), "needle", "identical raw source redraw must retain the current query");
          await page.evaluate(() => { fixture.oldPlain = { input: document.querySelector(".music-lyric-find input"), next: document.querySelector('[aria-label="下一段歌词"]'), row: document.querySelector(".music-lyric-search-current") }; });
          await page.evaluate(() => { fixture.state.music.lyrics = { raw: "Replacement plain source", lines: [] }; fixture.page.renderView(); });
          const before = await audioState(page);
          await page.evaluate(() => {
            const old = fixture.oldPlain; old.input.value = "stanza"; old.input.dispatchEvent(new InputEvent("input", { bubbles: true })); old.next.click(); old.row.click();
          });
          assert.equal(await input.inputValue(), "", "replacement raw source must reset the old query");
          assert.equal(await page.locator(".music-lyric-lines").textContent(), "Replacement plain source");
          assert.equal(await page.locator(".music-lyric-find-count").textContent(), "输入文字查找", "detached plain lookup must not repaint its replacement");
          await input.evaluate(element => {
            element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); element.value = "Replacement";
            element.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
            element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape", isComposing: true }));
          });
          assert.equal(await page.locator(".music-track-page").count(), 1);
          assert.equal(await page.locator(".music-lyric-find-count").textContent(), "输入文字查找");
          await input.evaluate(element => element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
          assert.equal(await page.locator(".music-lyric-find-count").textContent(), "1 / 1");
          await page.getByRole("button", { name: "返回音乐库", exact: true }).click();
          await page.evaluate(() => fixture.oldPlain.next.click());
          await page.getByRole("button", { name: "打开当前歌曲播放页", exact: true }).click();
          assert.equal(await input.inputValue(), "");
          assert.deepEqual(await audioState(page), before);
          const old = hold(url => url.pathname === "/api/music/tracks/P", "", { track: track("P"), lyrics: { raw: "Obsolete plain source", lines: [] } });
          try {
            await launchTrack(page, "P"); await requested(old);
            await page.locator(".music-stage-player").getByRole("button", { name: "下一首", exact: true }).click(); await stageTitle(page, "Track B");
            await input.fill("Second B"); const replacement = await playbackState(page); await finishOld(page, old, ignoreAbort);
            assert.deepEqual(await playbackState(page), replacement);
            assert.equal(await page.locator(".music-lyric-plain-label").count(), 0);
            assert.equal(await page.locator(".music-lyric-search-current").textContent(), "Second B", "obsolete plain detail must not replace timed lyrics");
          } finally { old.release(); }
        } finally { await page.close(); }
      });
      await run(`lyric plain distinguishes empty source and timed priority ${transport}`, async () => {
        const page = await newLyricFindPage(ignoreAbort, 1440, [], " \r\n\t ");
        try {
          assert.equal(await page.locator(".music-lyric-lines").textContent(), "暂无歌词");
          assert.equal(await page.getByRole("searchbox", { name: "查找当前歌词" }).count(), 0);
          await page.evaluate(() => { fixture.state.music.lyrics = { raw: "Must not duplicate timed lyrics", lines: [{ timeMs: 7000, text: "Timed wins" }] }; fixture.page.renderView(); });
          assert.equal(await page.locator(".music-lyric-plain-label").count(), 0);
          assert.equal(await page.locator(".music-lyric-lines > button").textContent(), "Timed wins");
          await page.locator(".music-lyric-lines > button").click();
          assert.equal(await page.evaluate(() => __audios[0].currentTime), 7, "timed lyric click must retain its seek behavior");
        } finally { await page.close(); }
      });
      await run(`lyric browse reads every paragraph without search or seeking ${transport}`, async () => {
        const source = Array.from({ length: 5000 }, (_, index) => ({ timeMs: index * 1000, text: `Browse lyric ${index}` }));
        const page = await newLyricFindPage(ignoreAbort, 1440, source);
        try {
          const select = page.getByRole("combobox", { name: "歌词段落", exact: true });
          assert.equal(await select.count(), 1, "long lyrics must expose manual paragraph browsing without a search query");
          const beforeFocus = await audioState(page);
          await select.focus(); assert.deepEqual(await audioState(page), beforeFocus, "paragraph selection focus must not pause or seek audio");
          await page.evaluate(() => { __audios[0].currentTime = 121; __audios[0].dispatchEvent(new Event("timeupdate")); }); await tick(page);
          assert.equal(await select.inputValue(), "0", "focused paragraph selection must not be rewritten by playback across a page boundary");
          await page.evaluate(() => { fixture.paragraphControls = [...document.querySelectorAll(".music-lyric-window-controls button, .music-lyric-window-controls select")]; });
          const before = await audioState(page), seen = [];
          for (let paragraph = 0; paragraph < 42; paragraph++) {
            if (paragraph) await page.getByRole("button", { name: "下一段歌词", exact: true }).click();
            const indices = await page.locator(".music-lyric-lines > button").evaluateAll(rows => rows.map(row => Number(row.dataset.index)));
            assert.equal(indices[0], paragraph * 120, "manual paragraphs must expose the next contiguous lyric range");
            assert(indices.length <= 120, "manual browsing must keep the lyric DOM bounded");
            seen.push(...indices);
          }
          assert.deepEqual(seen, source.map((_, index) => index));
          assert.equal(await page.locator(".music-lyric-window-label").textContent(), "第 4921–5000 行 · 共 5000 行");
          assert.equal(await page.getByRole("button", { name: "下一段歌词", exact: true }).isDisabled(), true);
          assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "上一段歌词", "reaching the last paragraph must leave an available control focused");
          await page.keyboard.press("Enter"); assert.equal(await select.inputValue(), "40");
          await select.focus(); await select.press("Home"); assert.equal(await select.inputValue(), "0");
          assert.equal(await select.evaluate(element => document.activeElement === element), true);
          await select.press("End"); await select.press("Escape"); assert.equal(await select.inputValue(), "41");
          assert.equal(await page.locator(".music-track-page").count(), 1, "native paragraph selection keys must not close the song page");
          assert.deepEqual(await audioState(page), before, "manual lyric paragraphs must not seek, load, pause, or restart audio");
          assert.equal(await page.evaluate(() => fixture.paragraphControls.every(control => control.isConnected) && fixture.paragraphControls[1] === document.querySelector('[aria-label="歌词段落"]')), true, "manual browsing must retain the paragraph controls themselves");
          await page.evaluate(() => { __audios[0].currentTime = 122; __audios[0].dispatchEvent(new Event("timeupdate")); }); await tick(page);
          assert.equal(await select.inputValue(), "41", "playback must leave the manually selected paragraph in place");
        } finally { await page.close(); }
      });
      await run(`lyric browse synchronizes find and current paragraph while paused ${transport}`, async () => {
        const source = Array.from({ length: 5000 }, (_, index) => ({ timeMs: index * 1000, text: [10, 4800].includes(index) ? `Needle ${index}` : `Browse lyric ${index}` }));
        const page = await newLyricFindPage(ignoreAbort, 320, source);
        try {
          await page.locator(".music-stage-player").getByRole("button", { name: "暂停", exact: true }).click();
          const before = await audioState(page), select = page.getByRole("combobox", { name: "歌词段落", exact: true });
          await select.selectOption("41");
          await assertVisibleLyric(page, 4920);
          await page.locator(".music-lyric-lines").evaluate(element => element.scrollTo({ top: element.scrollHeight, behavior: "instant" })); await tick(page);
          await assertVisibleLyric(page, 4999);
          await page.getByRole("searchbox", { name: "查找当前歌词" }).fill("needle");
          assert.equal(await select.inputValue(), "0", "search location must synchronize the displayed lyric paragraph");
          await page.getByRole("button", { name: "下一处歌词", exact: true }).click();
          assert.equal(await select.inputValue(), "40");
          assert.equal(await page.locator(".music-lyric-search-current").getAttribute("data-index"), "4800");
          await page.getByRole("button", { name: "下一段歌词", exact: true }).click();
          assert.equal(await select.inputValue(), "41"); assert.equal(await page.locator(".music-lyric-find-count").textContent(), "2 / 2");
          await page.getByRole("button", { name: "上一处歌词", exact: true }).click(); assert.equal(await select.inputValue(), "0");
          await select.selectOption("41");
          if (process.env.MUSIC_LYRIC_DIAGNOSTICS) console.log("LYRIC_VIEWPORT", await page.locator(".music-lyric-lines").evaluate(element => {
            const rect = node => { const value = node.getBoundingClientRect(); return { top: value.top, bottom: value.bottom, height: value.height }; };
            const styles = getComputedStyle(element);
            return { scrollTop: element.scrollTop, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, rect: rect(element), first: rect(element.querySelector("button")), player: rect(document.querySelector(".music-stage-player")), meta: rect(element.closest(".music-stage-meta")), paddingTop: styles.paddingTop, paddingBottom: styles.paddingBottom, mask: styles.maskImage, overflowY: styles.overflowY, innerHeight };
          }));
          if (process.env.MUSIC_LYRIC_SCREENSHOT) await page.screenshot({ path: process.env.MUSIC_LYRIC_SCREENSHOT });
          await page.getByRole("button", { name: "回到当前", exact: true }).click(); await tick(page);
          assert.equal(await select.inputValue(), "0"); assert.equal(await page.locator(".music-lyric-lines .active").getAttribute("data-index"), "42");
          assert.deepEqual(await audioState(page), before);
          assert.equal(await page.locator(".music-lyric-window-controls").evaluate(element => element.scrollWidth <= element.clientWidth + 1 && element.getBoundingClientRect().right <= innerWidth + 1), true);
          assert.equal(await page.locator(".music-lyric-window-controls button, .music-lyric-window-controls select").evaluateAll(controls => controls.every(control => control.getBoundingClientRect().height >= 44)), true, "mobile paragraph controls must provide 44px touch targets");
        } finally { await page.close(); }
      });
      await run(`lyric browse old controls cannot change closed or replacement pages ${transport}`, async () => {
        const source = Array.from({ length: 5000 }, (_, index) => ({ timeMs: index * 1000, text: `Browse lyric ${index}` }));
        const page = await newLyricFindPage(ignoreAbort, 1440, source);
        const useOld = () => page.evaluate(() => { const old = fixture.oldParagraph; old.select.value = "41"; old.select.dispatchEvent(new Event("change", { bubbles: true })); old.next.click(); });
        try {
          await page.evaluate(() => { fixture.oldParagraph = { select: document.querySelector('[aria-label="歌词段落"]'), next: document.querySelector('[aria-label="下一段歌词"]') }; });
          await page.getByRole("button", { name: "返回音乐库", exact: true }).click();
          const closed = await playbackState(page); await useOld(); assert.deepEqual(await playbackState(page), closed);
          assert.equal(await page.evaluate(() => fixture.state.music.lyricFollowPaused), false, "old paragraph controls must not change closed or reopened following");
          await page.getByRole("button", { name: "打开当前歌曲播放页", exact: true }).click();
          await useOld(); assert.equal(await page.getByRole("combobox", { name: "歌词段落" }).inputValue(), "0");
          assert.equal(await page.evaluate(() => fixture.state.music.lyricFollowPaused), false);
          await page.locator(".music-stage-player").getByRole("button", { name: "下一首", exact: true }).click(); await stageTitle(page, "Track B");
          const replacement = await playbackState(page); await useOld(); assert.deepEqual(await playbackState(page), replacement);
          assert.equal(await page.getByRole("combobox", { name: "歌词段落" }).count(), 0);
          assert.equal(await page.evaluate(() => fixture.state.music.lyricFollowPaused), false);
        } finally { await page.close(); }
      });
      await run(`lyric find counts and locates late matching lines ${transport}`, async () => {
        const page = await newLyricFindPage(ignoreAbort);
        try {
          const input = page.getByRole("searchbox", { name: "查找当前歌词", exact: true });
          assert.equal(await input.count(), 1, "the current song must provide an in-lyrics search entry");
          const reads = [countMethodRequests("GET", "/api/music/tracks"), countMethodRequests("GET", "/api/music/suggest")];
          await input.fill("needle");
          assert.equal(await page.locator(".music-lyric-find-count").textContent(), "1 / 3", "current lyric find must count matching lines across the full source");
          await page.getByRole("button", { name: "下一处歌词", exact: true }).click();
          assert.equal(await page.locator(".music-lyric-search-current").getAttribute("data-index"), "150", "find must reach matches beyond the old 120-line prefix");
          await page.getByRole("button", { name: "下一处歌词", exact: true }).click();
          assert.equal(await page.locator(".music-lyric-search-current").getAttribute("data-index"), "230");
          assert.equal(await page.locator(".music-lyric-find-count").textContent(), "3 / 3");
          await page.getByRole("button", { name: "下一处歌词", exact: true }).click();
          assert.equal(await page.locator(".music-lyric-search-current").getAttribute("data-index"), "3");
          await page.getByRole("button", { name: "上一处歌词", exact: true }).click();
          assert.equal(await page.locator(".music-lyric-find-count").textContent(), "3 / 3");
          assert.deepEqual(await page.evaluate(() => [__audios[0].currentTime, __audios[0].paused]), [42, false], "finding lyrics must not seek or pause playback");
          assert.deepEqual([countMethodRequests("GET", "/api/music/tracks"), countMethodRequests("GET", "/api/music/suggest")], reads, "current lyric find must not issue library or suggestion searches");
        } finally { await page.close(); }
      });
      for (const paused of [false, true]) await run(`lyric find matched click preserves ${paused ? "paused" : "playing"} intent ${transport}`, async () => {
        const page = await newLyricFindPage(ignoreAbort);
        try {
          if (paused) await page.locator(".music-stage-player").getByRole("button", { name: "暂停", exact: true }).click();
          const before = await audioState(page), queue = await page.evaluate(() => fixture.state.music.queue.map(track => track.id));
          await page.getByRole("searchbox", { name: "查找当前歌词" }).fill("needle");
          await page.getByRole("button", { name: "下一处歌词", exact: true }).click();
          if (paused) await page.locator(".music-lyric-search-current").press("Space");
          else await page.locator(".music-lyric-search-current").click();
          await page.waitForFunction(() => document.querySelector(".music-lyric-lines .active")?.dataset.index === "150");
          assert.deepEqual(await audioState(page), { ...before, currentTime: 300 }, "clicking a found lyric must use its timestamp without restarting or pausing audio");
          assert.deepEqual(await page.evaluate(() => fixture.state.music.queue.map(track => track.id)), queue);
          assert.equal(await page.evaluate(() => fixture.state.music.lyricFollowPaused), false);
          assert.equal(await page.locator(".music-lyric-follow").evaluate(button => button.classList.contains("visible")), false);
        } finally { await page.close(); }
      });
      await run(`lyric find manual location and return preserve lyric following ${transport}`, async () => {
        const source = Array.from({ length: 360 }, (_, index) => ({ timeMs: index * 2000, text: [3, 150, 230].includes(index) ? `Needle lyric ${index}` : `Synthetic lyric ${index}` }));
        const page = await newLyricFindPage(ignoreAbort, 1440, source);
        try {
          await page.getByRole("searchbox", { name: "查找当前歌词" }).fill("needle");
          await page.getByRole("button", { name: "下一处歌词", exact: true }).click();
          const before = await page.locator(".music-lyric-lines").evaluate(lines => lines.scrollTop);
          const first = await page.locator(".music-lyric-lines > button").first().getAttribute("data-index");
          await page.evaluate(() => { __audios[0].currentTime = 500; __audios[0].dispatchEvent(new Event("timeupdate")); }); await tick(page);
          assert.equal(await page.locator(".music-lyric-lines > button").first().getAttribute("data-index"), first, "playback must preserve the manually located lyric window range");
          assert.equal(await page.locator(".music-lyric-search-current").getAttribute("data-index"), "150", "playback must not replace the user's manually located lyric window");
          assert.equal(await page.locator(".music-lyric-lines").evaluate(lines => lines.scrollTop), before);
          await page.getByRole("button", { name: "回到当前", exact: true }).click(); await tick(page);
          assert.equal(await page.locator(".music-lyric-lines .active").getAttribute("data-index"), "250", "returning to current must follow the full lyric source beyond the old prefix");
          assert.equal(await page.evaluate(() => fixture.state.music.lyricFollowPaused), false);
          assert.equal(await page.locator(".music-lyric-lines > button").count(), 120);
          assert.equal(await page.evaluate(() => __audios[0].currentTime), 500);
        } finally { await page.close(); }
      });
      await run(`lyric find keyboard line browsing keeps focus while playback advances ${transport}`, async () => {
        const page = await newLyricFindPage(ignoreAbort);
        try {
          await page.locator('.music-lyric-lines [data-index="10"]').focus();
          await page.evaluate(() => { __audios[0].currentTime = 460; __audios[0].dispatchEvent(new Event("timeupdate")); }); await tick(page);
          assert.equal(await page.evaluate(() => document.activeElement?.dataset.index), "10", "keyboard lyric browsing must keep its focused line while playback advances");
          await page.keyboard.press("Enter"); await tick(page);
          assert.deepEqual(await page.evaluate(() => [__audios[0].currentTime, __audios[0].paused, fixture.state.music.lyricFollowPaused]), [20, false, false]);
          assert.equal(await page.locator(".music-lyric-lines .active").getAttribute("data-index"), "10");
        } finally { await page.close(); }
      });
      await run(`lyric find literal no-match and clear controls ${transport}`, async () => {
        const lines = Array.from({ length: 240 }, (_, index) => ({ timeMs: index * 2000, text: index === 150 ? "Literal [a+b] <img src=x>" : `Line ${index}` }));
        const page = await newLyricFindPage(ignoreAbort, 1440, lines);
        try {
          const input = page.getByRole("searchbox", { name: "查找当前歌词" });
          await input.fill("absent"); assert.equal(await page.locator(".music-lyric-find-count").textContent(), "无匹配");
          assert.equal(await page.getByRole("button", { name: "下一处歌词", exact: true }).isDisabled(), true);
          await input.fill("[a+b]"); assert.equal(await page.locator(".music-lyric-find-count").textContent(), "1 / 1");
          assert.equal(await page.locator(".music-lyric-search-current").textContent(), "Literal [a+b] <img src=x>");
          assert.equal(await page.locator(".music-lyric-lines img").count(), 0);
          await input.press("Escape");
          assert.equal(await input.inputValue(), ""); assert.equal(await page.locator(".music-lyric-find-count").textContent(), "输入文字查找");
          assert.equal(await page.locator(".music-track-page").count(), 1, "clearing lyric find must not close the song page");
          await input.press("Escape"); await library(page);
          assert.deepEqual(await page.evaluate(() => [__audios[0].currentTime, __audios[0].paused]), [42, false]);
        } finally { await page.close(); }
      });
      await run(`lyric find IME confirmation and cancellation stay local ${transport}`, async () => {
        const page = await newLyricFindPage(ignoreAbort);
        try {
          const input = page.getByRole("searchbox", { name: "查找当前歌词" }); await input.focus();
          await input.evaluate(input => {
            input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); input.value = "needle";
            input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
            for (const key of ["Enter", "Escape"]) input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
          });
          assert.equal(await page.locator(".music-lyric-find-count").textContent(), "输入文字查找");
          assert.equal(await input.inputValue(), "needle", "IME candidate cancellation must preserve the uncommitted lyric query");
          await input.evaluate(input => {
            input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
            input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            for (const key of ["Enter", "Escape"]) input.dispatchEvent(new KeyboardEvent("keydown", { key, keyCode: 229, bubbles: true, cancelable: true }));
          });
          assert.equal(await page.locator(".music-lyric-find-count").textContent(), "1 / 3", "candidate confirmation must not advance or clear lyric find");
          assert.equal(await input.evaluate(input => input === document.activeElement), true);
          await input.press("Enter"); assert.equal(await page.locator(".music-lyric-find-count").textContent(), "2 / 3");
          await input.press("Shift+Enter"); assert.equal(await page.locator(".music-lyric-find-count").textContent(), "1 / 3");
          await input.press("Control+Enter"); assert.equal(await page.locator(".music-lyric-find-count").textContent(), "1 / 3");
          assert.deepEqual(await page.evaluate(() => [__audios[0].currentTime, __audios[0].paused]), [42, false]);
        } finally { await page.close(); }
      });
      for (const destination of ["new song", "closed page"]) await run(`lyric find detached controls cannot mutate ${destination} ${transport}`, async () => {
        const page = await newLyricFindPage(ignoreAbort);
        try {
          await page.getByRole("searchbox", { name: "查找当前歌词" }).fill("needle");
          await page.evaluate(() => { fixture.oldLyricFind = { input: document.querySelector(".music-lyric-find input"), next: document.querySelector('[aria-label="下一处歌词"]'), line: document.querySelector(".music-lyric-search-current"), lines: document.querySelector(".music-lyric-lines"), follow: document.querySelector(".music-lyric-follow") }; });
          if (destination === "new song") {
            await page.locator(".music-stage-player").getByRole("button", { name: "下一首", exact: true }).click(); await stageTitle(page, "Track B");
            await page.getByRole("searchbox", { name: "查找当前歌词" }).fill("Second B");
            await page.evaluate(() => fixture.oldLyricFind.follow.click());
            assert.equal(await page.evaluate(() => fixture.state.music.lyricFollowPaused), true, "an old follow control must not resume another song's lyric window");
            await page.getByRole("button", { name: "回到当前", exact: true }).click(); await tick(page);
          } else await page.getByRole("button", { name: "返回音乐库", exact: true }).click();
          const before = await playbackState(page);
          await page.evaluate(() => {
            const old = fixture.oldLyricFind; old.input.value = "synthetic"; old.input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            old.input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); old.next.click(); old.line.click(); old.lines.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
          });
          assert.deepEqual(await playbackState(page), before, "detached lyric controls must not seek or rewrite another page's playback");
          if (destination === "new song") {
            assert.equal(await page.evaluate(() => fixture.state.music.lyricFollowPaused), false, "an old lyric surface must not pause the new song's following");
            assert.equal(await page.locator(".music-lyric-search-current").getAttribute("data-index"), "1", "detached lyric find must not repaint the new song's matches");
            await page.getByRole("searchbox", { name: "查找当前歌词" }).fill("");
          }
          if (destination === "closed page") await page.getByRole("button", { name: "打开当前歌曲播放页", exact: true }).click();
          assert.equal(await page.getByRole("searchbox", { name: "查找当前歌词" }).inputValue(), "", "a new song or reopened page must not inherit the old lyric query");
          assert.equal(await page.locator(".music-lyric-find-count").textContent(), "输入文字查找");
        } finally { await page.close(); }
      });
      await run(`lyric find empty new source clears the old finder ${transport}`, async () => {
        const page = await newLyricFindPage(ignoreAbort);
        const empty = hold(url => url.pathname === "/api/music/tracks/B", "", { track: track("B"), lyrics: { raw: "", lines: [] } });
        try {
          await page.getByRole("searchbox", { name: "查找当前歌词" }).fill("needle");
          await page.locator(".music-stage-player").getByRole("button", { name: "下一首", exact: true }).click(); await requested(empty); empty.release(); await stageTitle(page, "Track B");
          assert.equal(await page.getByRole("searchbox", { name: "查找当前歌词" }).count(), 0);
          assert.equal(await page.locator(".music-lyric-lines").textContent(), "暂无歌词");
          assert.equal(await page.locator(".music-lyric-search-current").count(), 0);
        } finally { empty.release(); await page.close(); }
      });
      for (const error of ["", "Synthetic obsolete lyric detail failure"]) await run(`lyric find ignores slow obsolete detail ${error ? "failure" : "success"} ${transport}`, async () => {
        const page = await newLyricFindPage(ignoreAbort);
        const old = hold(url => url.pathname === "/api/music/tracks/P", error);
        try {
          await page.getByRole("searchbox", { name: "查找当前歌词" }).fill("needle");
          await launchTrack(page, "P"); await requested(old);
          await page.locator(".music-stage-player").getByRole("button", { name: "下一首", exact: true }).click(); await stageTitle(page, "Track B");
          const input = page.getByRole("searchbox", { name: "查找当前歌词" }); await input.fill("Lyric B");
          const before = await playbackState(page); await finishOld(page, old, ignoreAbort);
          assert.deepEqual(await playbackState(page), before);
          assert.equal(await input.inputValue(), "Lyric B"); assert.equal(await page.locator(".music-lyric-find-count").textContent(), "1 / 1", "an obsolete detail must not reset the new song's lyric query");
        } finally { old.release(); await page.close(); }
      });
      await run(`lyric find long source stays bounded and follows outside prefix ${transport}`, async () => {
        const lines = Array.from({ length: 5000 }, (_, index) => ({ timeMs: index * 1000, text: index === 4800 ? "Needle near the end" : `Long lyric ${index}` }));
        const page = await newLyricFindPage(ignoreAbort, 1440, lines);
        try {
          await page.getByRole("searchbox", { name: "查找当前歌词" }).fill("needle");
          assert.equal(await page.locator(".music-lyric-search-current").getAttribute("data-index"), "4800", "all current lyric lines must be searchable without prefix truncation");
          assert.equal(await page.locator(".music-lyric-lines > button").count(), 120, "a far lyric match must not mount the entire long source");
          await page.getByRole("button", { name: "回到当前", exact: true }).click(); await tick(page);
          await page.evaluate(() => { __audios[0].currentTime = 4900; __audios[0].dispatchEvent(new Event("timeupdate")); }); await tick(page);
          assert.equal(await page.locator(".music-lyric-lines .active").getAttribute("data-index"), "4900");
          assert.equal(await page.locator(".music-lyric-lines > button").count(), 120);
          assert.equal(await page.evaluate(() => __audios[0].paused), false);
        } finally { await page.close(); }
      });
      await run(`lyric find narrow controls remain usable ${transport}`, async () => {
        const page = await newLyricFindPage(ignoreAbort, 320);
        try {
          await page.getByRole("searchbox", { name: "查找当前歌词" }).fill("needle");
          await page.getByRole("button", { name: "下一处歌词", exact: true }).click();
          assert.equal(await page.locator(".music-lyric-find-count").textContent(), "2 / 3");
          assert.equal(await page.locator(".music-lyric-find").evaluate(element => element.scrollWidth <= element.clientWidth + 1 && element.getBoundingClientRect().right <= innerWidth + 1), true);
        } finally { await page.close(); }
      });
      for (const size of [240, 2400]) await run(`large queue move interaction ${size} tracks ${transport}`, async () => {
        const page = await newLongQueuePage(ignoreAbort, 1440);
        try {
          const index = Math.floor(size * .8), id = `Q${index + 1}`;
          await page.evaluate(size => {
            const music = fixture.state.music;
            music.queue = Array.from({ length: size }, (_, index) => index ? { ...music.current, id: `Q${index + 1}`, title: `Queued synthetic ${index + 1}` } : music.current);
            music.queueVisibleLimit = size; music.queueExpanded = true; fixture.page.renderView();
          }, size);
          const samples = [];
          for (const action of ["上移", "下移", "上移"]) {
            const button = page.locator(`.music-queue-row[data-music-track-id="${id}"]`).getByRole("button", { name: action, exact: true });
            await button.focus();
            await page.evaluate(({ id, action }) => {
              const rows = [...document.querySelectorAll(".music-queue-row")];
              const button = rows.find(row => row.dataset.musicTrackId === id).querySelector(`[aria-label="${action}"]`);
              const createElement = Document.prototype.createElement;
              let start = 0, created = 0;
              button.addEventListener("click", () => {
                start = performance.now();
                Document.prototype.createElement = function (...args) { created++; return createElement.apply(this, args); };
              }, { capture: true, once: true });
              button.addEventListener("click", () => {
                const elapsedMs = performance.now() - start;
                Document.prototype.createElement = createElement;
                fixture.queueMoveSample = { elapsedMs, created, retainedRows: rows.filter(row => row.isConnected).length };
              }, { once: true });
            }, { id, action });
            await button.click();
            samples.push(await page.evaluate(() => fixture.queueMoveSample));
          }
          console.log(`QUEUE_MOVE_MEASUREMENT ${JSON.stringify({ size, transport, samples })}`);
          assert(samples.every(sample => sample.retainedRows === size), "adjacent queue moves must retain the existing song rows");
          assert(samples.every(sample => sample.created <= 24), "an adjacent move must not rebuild DOM proportional to queue length");
          assert.equal(await page.evaluate(() => document.activeElement?.closest(".music-queue-row")?.dataset.musicTrackId), id, "adjacent queue moves must keep focus on the moved song");
          assert.deepEqual(await page.locator(".music-queue-row").evaluateAll(rows => rows.map(row => row.dataset.musicTrackId)), await page.evaluate(() => fixture.state.music.queue.map(track => track.id)), "the visible queue order must match every accepted move");
          assert.deepEqual(await page.evaluate(id => ({ current: fixture.state.music.current.id, position: __audios[0].currentTime, paused: __audios[0].paused, index: fixture.state.music.queue.findIndex(track => track.id === id) }), id), { current: "P", position: 42, paused: false, index: index - 1 });
        } finally { await page.close(); }
      });
      for (const operation of ["play", "remove"]) await run(`queue move retained row ${operation} targets the same song ${transport}`, async () => {
        const page = await newLongQueuePage(ignoreAbort, 1440);
        try {
          const row = page.locator('.music-queue-row[data-music-track-id="L200"]');
          await page.evaluate(() => { fixture.movedRow = document.querySelector('.music-queue-row[data-music-track-id="L200"]'); });
          for (const action of ["上移", "上移", "下移"]) await row.getByRole("button", { name: action, exact: true }).click();
          assert.equal(await page.evaluate(() => fixture.movedRow === document.querySelector('.music-queue-row[data-music-track-id="L200"]')), true, "repeated moves must reuse the song's interactive row");
          assert.equal(await page.evaluate(() => fixture.state.music.queue.findIndex(track => track.id === "L200")), 198);
          assert.equal(await page.locator(".music-queue-row.active").getAttribute("data-music-track-id"), "P");
          if (operation === "play") {
            await row.locator(".music-queue-play").press("Enter");
            await page.waitForFunction(() => fixture.state.music.current?.id === "L200" && __audios[0].src.endsWith("/synthetic/audio/L200"));
            assert.equal(await page.locator(".music-queue-row.active").getAttribute("data-music-track-id"), "L200");
            assert.equal(await row.getByRole("button", { name: "移出队列", exact: true }).isDisabled(), true);
          } else {
            const next = await page.evaluate(() => fixture.state.music.queue[199].id);
            await row.getByRole("button", { name: "移出队列", exact: true }).press("Space");
            assert.equal(await row.count(), 0, "the retained remove closure must remove its own song after reordering");
            assert.equal(await page.evaluate(() => fixture.state.music.queue.some(track => track.id === "L200")), false);
            assert.equal(await page.locator('.music-queue-row[data-music-track-id="L199"]').count(), 1);
            assert.equal(await page.evaluate(() => document.activeElement?.closest(".music-queue-row")?.dataset.musicTrackId), next);
          }
        } finally { await page.close(); }
      });
      for (const fallback of ["partial queue", "mismatched DOM"]) await run(`queue move ${fallback} falls back safely ${transport}`, async () => {
        const partial = fallback === "partial queue", id = partial ? "L100" : "L200";
        const page = await newLongQueuePage(ignoreAbort, 1440, { all: !partial });
        try {
          await page.evaluate(({ id, partial }) => {
            fixture.fallbackRow = document.querySelector(`.music-queue-row[data-music-track-id="${id}"]`);
            if (!partial) fixture.fallbackRow.parentElement.insertBefore(fixture.fallbackRow, fixture.fallbackRow.previousElementSibling);
          }, { id, partial });
          await page.locator(`.music-queue-row[data-music-track-id="${id}"]`).getByRole("button", { name: "上移", exact: true }).click();
          const expected = await page.evaluate(partial => fixture.state.music.queue.slice(0, partial ? 120 : undefined).map(track => track.id), partial);
          assert.deepEqual(await page.locator(".music-queue-row").evaluateAll(rows => rows.map(row => row.dataset.musicTrackId)), expected, "a mismatched or partial queue must display the accepted order after its fallback");
          assert.equal(await page.evaluate(() => fixture.fallbackRow.isConnected), false, "an unverified queue must retain its full refresh fallback");
          assert.equal(await page.evaluate(() => document.activeElement?.closest(".music-queue-row")?.dataset.musicTrackId), id);
          assert.equal(await page.locator(".music-queue-load-more").count(), partial ? 1 : 0);
        } finally { await page.close(); }
      });
      for (const width of [1440, 390]) await run(`long queue playing a later song preserves queue context ${width}px ${transport}`, async () => {
        const page = await newLongQueuePage(ignoreAbort, width);
        try {
          const play = page.locator('.music-queue-row[data-music-track-id="L200"] .music-queue-play');
          await play.focus();
          const before = await page.locator(".music-queue-list").evaluate(list => list.scrollTop);
          await play.press("Enter");
          await page.waitForFunction(() => fixture.state.music.current?.id === "L200" && !__audios[0].paused);
          assert.equal(await page.evaluate(() => document.activeElement?.closest(".music-queue-row")?.dataset.musicTrackId), "L200", "starting another queue song must preserve its keyboard focus");
          assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("music-queue-play")), true);
          assert(Math.abs(await page.locator(".music-queue-list").evaluate(list => list.scrollTop) - before) < 2, "starting another queue song must preserve the visible queue position");
          assert.equal(await page.locator(".music-queue-row").count(), 240);
          assert.equal(await page.evaluate(() => __audios[0].src.endsWith("/synthetic/audio/L200")), true);
        } finally { await page.close(); }
      });
      for (const width of [1440, 390]) for (const operation of ["move", "remove"]) await run(`long queue ${operation} before first playback preserves focus ${width}px ${transport}`, async () => {
        const page = await newLongQueuePage(ignoreAbort, width, { playing: false });
        try {
          const action = operation === "move" ? "下移" : "移出队列";
          const button = page.locator('.music-queue-row[data-music-track-id="P"]').getByRole("button", { name: action, exact: true });
          await button.focus(); await button.press("Enter");
          assert.deepEqual(await page.evaluate(() => [document.activeElement?.closest(".music-queue-row")?.dataset.musicTrackId, document.activeElement?.getAttribute("aria-label")]), [operation === "move" ? "P" : "A", action], "queue edits before playback must preserve focus through summary replacement");
          assert.equal(await page.evaluate(() => Boolean(fixture.state.music.current)), false);
          assert.equal(await page.locator(".music-now-panel").getAttribute("data-music-track-id"), "A");
        } finally { await page.close(); }
      });
      for (const width of [1440, 390]) await run(`long queue pending playback respects a newer external focus ${width}px ${transport}`, async () => {
        const page = await newLongQueuePage(ignoreAbort, width);
        const detail = hold(url => url.pathname === "/api/music/tracks/L200");
        try {
          const play = page.locator('.music-queue-row[data-music-track-id="L200"] .music-queue-play');
          await play.focus(); await play.press("Enter"); await requested(detail);
          const external = page.locator(".music-search input"); await external.focus();
          detail.release();
          await page.waitForFunction(() => fixture.state.music.current?.id === "L200");
          assert.equal(await external.evaluate(input => document.activeElement === input), true, "completed queue playback must preserve a newer external focus");
        } finally { detail.release(); await page.close(); }
      });
      for (const width of [1440, 390]) await run(`long queue keyboard edit preserves reading position ${width}px ${transport}`, async () => {
        const page = await newLongQueuePage(ignoreAbort, width);
        try {
          const move = page.locator('.music-queue-row[data-music-track-id="L200"]').getByRole("button", { name: "上移", exact: true });
          await move.focus();
          const before = await page.locator(".music-queue-list").evaluate(list => list.scrollTop);
          assert(before > 1000, "the fixture must edit a row far below the queue start");
          await move.press("Enter");
          assert.equal(await page.evaluate(() => document.activeElement?.closest(".music-queue-row")?.dataset.musicTrackId), "L200", "queue editing must keep keyboard focus on the moved song");
          const after = await page.locator(".music-queue-list").evaluate(list => list.scrollTop);
          assert(Math.abs(after - before) < 2, `queue editing must preserve the visible queue position (${before} -> ${after})`);
          assert.deepEqual(await page.evaluate(() => ({ current: fixture.state.music.current.id, position: __audios[0].currentTime, paused: __audios[0].paused, index: fixture.state.music.queue.findIndex(item => item.id === "L200") })), { current: "P", position: 42, paused: false, index: 198 });
          assert.equal(await page.locator(".music-queue-list").evaluate(list => list.scrollWidth <= list.clientWidth + 1), true, "long titles must remain within the narrow queue");
        } finally { await page.close(); }
      });
      for (const width of [1440, 390]) await run(`long queue removal keeps focus on its next song ${width}px ${transport}`, async () => {
        const page = await newLongQueuePage(ignoreAbort, width);
        try {
          const remove = page.locator('.music-queue-row[data-music-track-id="L200"]').getByRole("button", { name: "移出队列", exact: true });
          await remove.focus();
          const before = await page.locator(".music-queue-list").evaluate(list => list.scrollTop);
          await remove.press("Enter");
          assert.deepEqual(await page.evaluate(() => [document.activeElement?.closest(".music-queue-row")?.dataset.musicTrackId, document.activeElement?.getAttribute("aria-label")]), ["L201", "移出队列"], "removing a row must focus the same action on the next surviving song");
          assert.equal(await page.locator('.music-queue-row[data-music-track-id="L200"]').count(), 0);
          assert(Math.abs(await page.locator(".music-queue-list").evaluate(list => list.scrollTop) - before) < 2, "queue removal must preserve the visible queue position");
        } finally { await page.close(); }
      });
      for (const width of [1440, 390]) for (const edge of ["first", "last"]) await run(`long queue ${edge} disabled move has a keyboard fallback ${width}px ${transport}`, async () => {
        const page = await newLongQueuePage(ignoreAbort, width);
        try {
          const id = edge === "first" ? "A" : "L239", action = edge === "first" ? "上移" : "下移", opposite = edge === "first" ? "下移" : "上移";
          const move = page.locator(`.music-queue-row[data-music-track-id="${id}"]`).getByRole("button", { name: action, exact: true });
          await move.focus(); await move.press("Enter");
          assert.deepEqual(await page.evaluate(() => [document.activeElement?.closest(".music-queue-row")?.dataset.musicTrackId, document.activeElement?.getAttribute("aria-label"), document.activeElement?.disabled]), [id, opposite, false], "a newly disabled move must leave an enabled action focused on the same song");
          await page.keyboard.press("Enter");
          assert.equal(await page.evaluate(id => fixture.state.music.queue.findIndex(item => item.id === id), id), edge === "first" ? 1 : 238, "keyboard interaction must continue after reaching the boundary");
        } finally { await page.close(); }
      });
      for (const width of [1440, 390]) await run(`long queue pagination focuses the first appended song ${width}px ${transport}`, async () => {
        const page = await newLongQueuePage(ignoreAbort, width, { all: false });
        try {
          const more = page.locator(".music-queue-load-more"); await more.focus();
          const before = await page.locator(".music-queue-list").evaluate(list => list.scrollTop);
          await more.press("Enter");
          assert.equal(await page.evaluate(() => document.activeElement?.closest(".music-queue-row")?.dataset.musicTrackId), "L121", "loading the next queue page must leave focus at its first appended song");
          assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("music-queue-play")), true);
          assert(Math.abs(await page.locator(".music-queue-list").evaluate(list => list.scrollTop) - before) < 2);
          assert.equal(await page.locator(".music-queue-row").count(), 240);
        } finally { await page.close(); }
      });
      for (const width of [1440, 390]) await run(`long queue collapse and expand retain the toggle ${width}px ${transport}`, async () => {
        const page = await newLongQueuePage(ignoreAbort, width);
        try {
          const toggle = page.locator('[data-music-queue-action="expand"]'); await toggle.focus(); await toggle.press("Enter");
          assert.equal(await page.evaluate(() => document.activeElement?.dataset.musicQueueAction), "expand");
          assert.equal(await toggle.textContent(), "全部");
          await page.keyboard.press("Enter");
          assert.equal(await page.evaluate(() => document.activeElement?.dataset.musicQueueAction), "expand");
          assert.equal(await toggle.textContent(), "精简");
        } finally { await page.close(); }
      });
      for (const width of [1440, 390]) await run(`long queue clearing keeps an available playback control focused ${width}px ${transport}`, async () => {
        const page = await newLongQueuePage(ignoreAbort, width);
        try {
          page.once("dialog", dialog => dialog.accept());
          const clear = page.locator('[data-music-queue-action="clear"]'); await clear.focus(); await clear.press("Enter");
          assert.equal(await page.locator(".music-queue-row").count(), 1);
          assert.equal(await page.evaluate(() => document.activeElement?.closest(".music-queue-row")?.dataset.musicTrackId), "P");
          assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("music-queue-play")), true);
          assert.equal(await page.evaluate(() => __audios[0].paused), false);
        } finally { await page.close(); }
      });
      for (const width of [1440, 390]) await run(`long queue update does not steal another control's focus ${width}px ${transport}`, async () => {
        const page = await newLongQueuePage(ignoreAbort, width);
        try {
          await page.locator('.music-queue-row[data-music-track-id="L200"] .music-queue-play').focus();
          const before = await page.locator(".music-queue-list").evaluate(list => list.scrollTop);
          const append = page.locator('.music-track-table [data-music-track-id="L220"]').getByRole("button", { name: /^加入队列 / });
          await append.focus(); await append.press("Enter");
          assert.equal(await append.evaluate(button => document.activeElement === button), true, "queue edits started outside the queue must preserve that external focus");
          assert(Math.abs(await page.locator(".music-queue-list").evaluate(list => list.scrollTop) - before) < 2);
        } finally { await page.close(); }
      });
      for (const firstOutcome of ["success", "failure"]) await run(`queue membership rollback after earlier ${firstOutcome} ${transport}`, async () => {
        playlistState = new Map([
          ["new", { id: "new", name: "New playlist", description: "Original description", trackIds: ["P", "A", "B"] }]
        ]);
        const page = await newPage({ real: true, ignoreAbort, route: "/music/playlist/new" });
        try {
          await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click();
          await page.waitForFunction(() => __audios[0]?.src.endsWith("/synthetic/audio/P") && !__audios[0].paused);
          await page.evaluate(() => { __audios[0].currentTime = 42; });
          const audio = (await playlistPlaybackState(page)).audio;
          const isOrder = (url, method) => method === "PUT" && url.pathname === "/api/music/playlists/new/tracks/order";
          const first = hold(isOrder, firstOutcome === "failure" ? "Synthetic first order failure" : "");
          await page.locator('.music-queue-row[data-music-track-id="B"]').getByRole("button", { name: "上移", exact: true }).click();
          await requested(first);
          await page.locator('.music-queue-row[data-music-track-id="A"]').getByRole("button", { name: "移出队列", exact: true }).click();
          await page.locator('.music-queue-row[data-music-track-id="B"]').getByRole("button", { name: "上移", exact: true }).click();
          assert.deepEqual((await playlistPlaybackState(page)).queue, ["B", "P"]);
          const last = hold(isOrder, "Synthetic latest order failure");
          await settle(page, first); await requested(last); await settle(page, last);
          assert.deepEqual((await playlistPlaybackState(page)).queue, ["P", "B"], "failed sorting must never resurrect a track explicitly removed from the queue");
          assert.deepEqual((await playlistPlaybackState(page)).audio, audio);
        } finally { await page.close(); playlistState = null; }
      });
      for (const firstOutcome of ["success", "failure"]) for (const lastOutcome of ["success", "failure"]) await run(`queue serial order ${firstOutcome} then ${lastOutcome} ${transport}`, async () => {
        playlistState = new Map([
          ["new", { id: "new", name: "New playlist", description: "Original description", trackIds: ["P", "A", "B"] }],
          ["other", { id: "other", name: "Other playlist", description: "Other description", trackIds: ["B"] }]
        ]);
        const page = await newPage({ real: true, ignoreAbort, route: "/music/playlist/new" });
        try {
          await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click();
          await page.waitForFunction(() => __audios[0]?.src.endsWith("/synthetic/audio/P") && !__audios[0].paused);
          await page.evaluate(() => { __audios[0].currentTime = 42; });
          const audio = (await playlistPlaybackState(page)).audio;
          const before = countMethodRequests("PUT", "/api/music/playlists/new/tracks/order");
          const isOrder = (url, method) => method === "PUT" && url.pathname === "/api/music/playlists/new/tracks/order";
          const first = hold(isOrder, firstOutcome === "failure" ? "Synthetic first order failure" : "");
          await page.locator('.music-queue-row[data-music-track-id="B"]').getByRole("button", { name: "上移", exact: true }).click();
          await requested(first);
          await page.locator('.music-queue-row[data-music-track-id="B"]').getByRole("button", { name: "上移", exact: true }).click();
          await page.locator('.music-queue-row[data-music-track-id="A"]').getByRole("button", { name: "上移", exact: true }).click();
          assert.deepEqual((await playlistPlaybackState(page)).queue, ["B", "A", "P"]);
          assert.equal(countMethodRequests("PUT", "/api/music/playlists/new/tracks/order") - before, 1, "only one same-playlist write may be in flight");
          const last = hold(isOrder, lastOutcome === "failure" ? "Synthetic latest order failure" : "");
          await settle(page, first); await requested(last);
          assert.equal(countMethodRequests("PUT", "/api/music/playlists/new/tracks/order") - before, 2, "the intermediate unsent order must be coalesced");
          assert.deepEqual(playlistMutations.at(-1).body, { trackIds: ["B", "A", "P"] });
          await settle(page, last);
          const expected = lastOutcome === "success" ? ["B", "A", "P"] : firstOutcome === "success" ? ["P", "B", "A"] : ["P", "A", "B"];
          assert.deepEqual((await playlistPlaybackState(page)).queue, expected);
          assert.deepEqual((await playlistPlaybackState(page)).audio, audio);
          assert.deepEqual(playlistState.get("new").trackIds, expected, "persisted order must agree with the final accepted result");
          await navigateRoute(page, "/music/playlist/other");
          await page.waitForFunction(() => document.querySelector(".music-panel-heading strong")?.textContent === "Other playlist");
          await navigateRoute(page, "/music/playlist/new");
          await page.waitForFunction(() => document.querySelector(".music-panel-heading strong")?.textContent === "New playlist");
          assert.deepEqual(await visiblePlaylistTracks(page), expected, "reopening the playlist must retain its confirmed order");
        } finally { await page.close(); playlistState = null; }
      });
      for (const outcome of ["success", "failure"]) for (const target of ["current", "remove", "new playlist"]) await run(`queue order ${outcome} preserves ${target} ${transport}`, async () => {
        playlistState = new Map([
          ["new", { id: "new", name: "New playlist", description: "Original description", trackIds: ["P", "A", "B"] }],
          ["other", { id: "other", name: "Other playlist", description: "Other description", trackIds: ["B"] }]
        ]);
        const page = await newPage({ real: true, ignoreAbort, route: "/music/playlist/new" });
        try {
          await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click();
          await page.waitForFunction(() => __audios[0]?.src.endsWith("/synthetic/audio/P") && !__audios[0].paused);
          await page.evaluate(() => { __audios[0].currentTime = 42; });
          const audio = (await playlistPlaybackState(page)).audio;
          const write = hold((url, method) => method === "PUT" && url.pathname === "/api/music/playlists/new/tracks/order", outcome === "failure" ? "Synthetic reorder failure" : "");
          await page.locator('.music-queue-row[data-music-track-id="B"]').getByRole("button", { name: "上移", exact: true }).click();
          await requested(write);
          assert.deepEqual((await playlistPlaybackState(page)).queue, ["P", "B", "A"]);
          if (target === "remove") await page.locator('.music-queue-row[data-music-track-id="A"]').getByRole("button", { name: "移出队列", exact: true }).click();
          else if (target === "new playlist") {
            await navigateRoute(page, "/music/playlist/other");
            await page.waitForFunction(() => document.querySelector(".music-panel-heading strong")?.textContent === "Other playlist");
          }
          const expectedQueue = (await playlistPlaybackState(page)).queue;
          await capturePlaylistDestination(page);
          const route = page.url(), beforeReads = countMethodRequests("GET", "/api/music/playlists/other");
          await settle(page, write);
          assert.equal(page.url(), route);
          assert.deepEqual((await playlistPlaybackState(page)).audio, audio, "order completion must preserve the actual playing source and position");
          if (outcome === "failure" && target === "current") {
            assert.deepEqual((await playlistPlaybackState(page)).queue, ["P", "A", "B"], "a current failed order must still roll back");
          } else {
            assert.deepEqual((await playlistPlaybackState(page)).queue, expectedQueue, "an obsolete order must preserve newer queue operations");
            await assertPlaylistDestination(page);
          }
          if (target === "new playlist") {
            let editedName;
            page.once("dialog", async dialog => { editedName = dialog.defaultValue(); await dialog.dismiss(); });
            await page.locator(".music-panel-actions").getByRole("button", { name: "编辑", exact: true }).click();
            assert.equal(editedName, "Other playlist", "an old success must not replace the playlist used by subsequent actions");
          }
          assert.equal(countMethodRequests("GET", "/api/music/playlists/other"), beforeReads, "old completion must not reload the new destination");
          assert.equal(write.closed, true, "accepted write must complete even after navigation");
          assert.deepEqual(playlistState.get("new").trackIds, outcome === "success" ? ["P", "B", "A"] : ["P", "A", "B"]);
        } finally { await page.close(); playlistState = null; }
      });
      await run(`track row keyboard activates only its focused surface ${transport}`, async () => {
        const page = await newComponentPage(ignoreAbort);
        try {
          const row = page.locator("[data-component-track-row]");
          for (const key of ["Enter", "Space", "Shift+Enter", "Shift+Space"]) {
            await page.evaluate(() => { __componentCalls.length = 0; });
            await row.focus(); await row.press(key);
            assert.deepEqual(await page.evaluate(() => __componentCalls), ["play"], `the focused row must keep its ${key} activation`);
          }
          for (const [label, action] of [["下一首播放 Synthetic component", "next"], ["加入队列 Synthetic component", "append"], ["下载 Synthetic component", "download"]]) {
            const button = row.getByRole("button", { name: label, exact: true });
            for (const input of ["Enter", "Space", "pointer"]) {
              await page.evaluate(() => { __componentCalls.length = 0; });
              if (input === "pointer") await button.click();
              else { await button.focus(); await button.press(input); }
              assert.deepEqual(await page.evaluate(() => __componentCalls), [action], `${label} must keep its native ${input} action without playing the row`);
            }
          }
          await page.evaluate(() => { __componentCalls.length = 0; });
          await row.locator(".music-track-title strong").click();
          assert.deepEqual(await page.evaluate(() => __componentCalls), ["play"], "clicks on the song title must still bubble to row playback");
        } finally { await page.close(); }
      });
      await run(`track row keyboard preserves IME modifiers and handled events ${transport}`, async () => {
        const page = await newComponentPage(ignoreAbort);
        try {
          const outcomes = await page.locator("[data-component-track-row]").evaluate(row => {
            const outcomes = [];
            for (const key of ["Enter", " "]) for (const flags of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { handled: true }]) {
              const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...flags });
              if (flags.handled) event.preventDefault();
              row.dispatchEvent(event);
              outcomes.push({ key, flags, prevented: event.defaultPrevented });
            }
            return outcomes;
          });
          assert.deepEqual(await page.evaluate(() => __componentCalls), [], "IME, modified and already handled events must not play the row");
          assert(outcomes.every(item => item.prevented === Boolean(item.flags.handled)), "ignored keys must preserve their default behavior and existing cancellation");
        } finally { await page.close(); }
      });
      for (const mode of ["library", "artists", "albums"]) await run(`IME search ${mode} commits once and retains input ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          if (mode !== "library") {
            await launchRoute(page, { musicMode: mode });
            await page.waitForFunction(mode => fixture.state.music.mode === mode && !fixture.state.music.loading, mode);
          }
          const endpoint = `/api/music/${mode === "library" ? "tracks" : mode}`;
          const old = hold(url => url.pathname === endpoint && url.searchParams.get("q") === "BeforeComposition");
          const input = page.locator(`[data-music-search="${mode}"]`);
          await input.fill("BeforeComposition"); await requested(old);
          const beforeReads = countRequests(url => [endpoint, "/api/music/suggest"].includes(url.pathname));
          await input.evaluate(input => {
            fixture.composingInput = input;
            fixture.compositionKeys = [];
            window.addEventListener("keydown", event => fixture.compositionKeys.push(event.key));
            input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
            input.value = "zhoujielun";
            input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true, inputType: "insertCompositionText" }));
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true }));
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
          });
          await page.waitForTimeout(300);
          assert.equal(countRequests(url => [endpoint, "/api/music/suggest"].includes(url.pathname)), beforeReads, "uncommitted input must issue no list or suggestion reads");
          await finishOld(page, old, ignoreAbort);
          assert.equal(await input.evaluate(input => input === fixture.composingInput && document.activeElement === input), true, "an obsolete response must not replace the composing input");
          assert.equal(await input.inputValue(), "zhoujielun");
          assert.equal(await page.evaluate(() => fixture.state.music.query), "BeforeComposition", "draft composition must not change the committed query");
          const committedBefore = countRequests(url => url.pathname === endpoint && url.searchParams.get("q") === "周杰伦");
          const suggestionsBefore = countRequests(url => url.pathname === "/api/music/suggest" && url.searchParams.get("q") === "周杰伦");
          const committed = hold(url => url.pathname === endpoint && url.searchParams.get("q") === "周杰伦");
          await input.evaluate(input => {
            input.value = "周杰伦";
            input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "周杰伦" }));
            // Safari can deliver a confirmation key after compositionend.
            for (const key of ["Enter", "Escape"]) input.dispatchEvent(new KeyboardEvent("keydown", { key, keyCode: 229, bubbles: true, cancelable: true }));
            input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "周杰伦" }));
          });
          await requested(committed);
          assert.deepEqual(await page.evaluate(() => fixture.compositionKeys), [], "candidate keys must not reach page-level navigation shortcuts");
          assert.equal(countRequests(url => url.pathname === endpoint && url.searchParams.get("q") === "周杰伦") - committedBefore, 1, "compositionend and its final input event must share one debounced search");
          if (mode === "library") assert.equal(countRequests(url => url.pathname === "/api/music/suggest" && url.searchParams.get("q") === "周杰伦") - suggestionsBefore, 1, "the post-composition Escape must not cancel the committed suggestion request");
          await settle(page, committed);
          assert.equal(await page.locator(`[data-music-search="${mode}"]`).inputValue(), "周杰伦");
          assert.equal(await page.evaluate(() => document.activeElement?.dataset.musicSearch), mode);
        } finally { await page.close(); }
      });
      await run(`IME search detached input cannot publish after navigation ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          await page.locator('[data-music-search="library"]').evaluate(input => {
            fixture.oldComposingInput = input;
            input.focus();
            input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
            input.value = "unfinished";
            input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
          });
          await launchRoute(page, { musicMode: "artists" });
          await page.waitForFunction(() => fixture.state.music.mode === "artists" && !fixture.state.music.loading);
          const before = countRequests(url => url.pathname.startsWith("/api/music/"));
          await page.evaluate(() => {
            const input = fixture.oldComposingInput;
            input.value = "迟到输入";
            input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "迟到输入" }));
            input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
          });
          await page.waitForTimeout(300);
          assert.equal(countRequests(url => url.pathname.startsWith("/api/music/")), before);
          assert.deepEqual(await page.evaluate(() => [fixture.state.music.mode, fixture.state.music.query]), ["artists", ""]);
        } finally { await page.close(); }
      });
      await run(`IME search normal Enter still submits immediately ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          const before = countRequests(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "NormalQuery");
          const submitted = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "NormalQuery");
          const input = page.locator('[data-music-search="library"]');
          await input.fill("NormalQuery"); await input.press("Enter"); await requested(submitted);
          await settle(page, submitted);
          await page.waitForTimeout(300);
          assert.equal(countRequests(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "NormalQuery") - before, 1, "Enter must consume its pending debounce");
          assert.equal(await page.locator('[data-music-search="library"]').inputValue(), "NormalQuery");
        } finally { await page.close(); }
      });
      for (const scenario of ["current success", "new navigation success", "new navigation failure"]) {
        await run(`history clear ${scenario} ${transport}`, async () => {
          historyState = { trackIds: ["P", "A"], cleared: 0 };
          const page = await newPage({ real: true, ignoreAbort, route: "/music/history" });
          try {
            await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click();
            await page.waitForFunction(() => document.querySelector(".music-now-panel")?.dataset.musicTrackId === "P");
            await page.waitForFunction(() => __audios[0]?.src.endsWith("/synthetic/audio/P") && !__audios[0].paused);
            await page.evaluate(() => { __audios[0].currentTime = 42; });
            const playing = await playlistPlaybackState(page);
            const beforeWrites = countMethodRequests("DELETE", "/api/music/history");
            const failed = scenario.endsWith("failure");
            const write = hold((url, method) => method === "DELETE" && url.pathname === "/api/music/history", failed ? "obsolete history clear failure" : "");
            page.once("dialog", dialog => dialog.accept());
            await page.locator(".music-panel-actions").getByRole("button", { name: "清空", exact: true }).click();
            await requested(write);
            let destination = null, beforeReads = 0;
            if (scenario !== "current success") {
              beforeReads = countMethodRequests("GET", "/api/music/tracks");
              destination = hold((url, method) => method === "GET" && url.pathname === "/api/music/tracks");
              await navigateRoute(page, "/music/library"); await requested(destination);
              await capturePlaylistDestination(page);
              assert.equal(write.closed, false, "navigation must not cancel a history write already sent");
            }
            await settle(page, write);
            assert.equal(countMethodRequests("DELETE", "/api/music/history") - beforeWrites, 1, "history clearing must not retry");
            assert.equal(historyState.cleared, failed ? 0 : 1);
            assert.deepEqual(historyState.trackIds, failed ? ["P", "A"] : []);
            if (destination) {
              assert.equal(countMethodRequests("GET", "/api/music/tracks") - beforeReads, 1, "obsolete history completion must not restart the newer list request");
              await assertPlaylistDestination(page);
              assert.equal(new URL(page.url()).pathname, "/music/library");
              await settle(page, destination);
              await page.waitForFunction(() => document.querySelector(".music-panel-heading strong")?.textContent === "全部歌曲");
              assert.deepEqual((await visiblePlaylistTracks(page)).slice(0, 3), ["P", "A", "B"]);
            } else {
              await page.waitForFunction(() => !document.querySelector(".music-track-panel")?.hasAttribute("aria-busy") && document.querySelectorAll(".music-track-table .music-track-row:not(.head)").length === 0);
              assert.equal(new URL(page.url()).pathname, "/music/history");
              assert.equal(await page.locator(".music-panel-heading strong").textContent(), "最近播放");
              assert.equal(await page.locator(".music-panel-actions").getByRole("button", { name: "清空", exact: true }).count(), 0);
            }
            assert.deepEqual(await playlistPlaybackState(page), playing, "clearing history must preserve current audio, queue and playback position");
          } finally { await page.close(); historyState = null; }
        });
      }
      for (const operation of ["edit", "add", "remove", "delete"]) for (const navigate of [false, true]) {
        await run(`playlist mutation ${operation} ${navigate ? "cannot replace newer navigation" : "current success"} ${transport}`, async () => {
          const page = await newPlaylistPage(operation, ignoreAbort);
          try {
            const mutationBefore = playlistMutations.length, spec = playlistMutationSpec(operation);
            const write = hold((url, method) => url.pathname === spec.path && method === spec.method);
            const playing = await playlistPlaybackState(page);
            await clickPlaylistMutation(page, operation); await requested(write);
            let destination = null, destinationBefore = 0;
            if (navigate) {
              destinationBefore = countMethodRequests("GET", "/api/music/playlists/other");
              destination = hold((url, method) => method === "GET" && url.pathname === "/api/music/playlists/other");
              await navigateRoute(page, "/music/playlist/other"); await requested(destination);
              await capturePlaylistDestination(page);
            }
            // Writes deliberately outlive navigation and carry no AbortSignal.
            // Even normal transport must settle their response instead of closing it.
            await settle(page, write);
            assert.deepEqual(playlistMutations.slice(mutationBefore), [{ method: spec.method, path: spec.path, body: spec.body }]);
            assertPlaylistMutationApplied(operation);
            if (navigate) {
              assert.equal(countMethodRequests("GET", "/api/music/playlists/other") - destinationBefore, 1, "obsolete mutation must not restart the newer playlist request");
              await assertPlaylistDestination(page);
              assert.equal(new URL(page.url()).pathname, "/music/playlist/other");
              await settle(page, destination);
              await page.waitForFunction(() => document.querySelector(".music-panel-heading strong")?.textContent === "Other playlist");
              assert.deepEqual(await visiblePlaylistTracks(page), ["B"]);
            } else {
              await assertCurrentPlaylistMutation(page, operation);
            }
            assert.deepEqual(await playlistPlaybackState(page), playing, "playlist writes must preserve the current audio, queue and playback position");
          } finally { await page.close(); playlistState = null; }
        });
      }
      for (const operation of ["edit", "add"]) await run(`playlist mutation ${operation} sidebar refresh cannot replace newer navigation ${transport}`, async () => {
        const page = await newPlaylistPage(operation, ignoreAbort);
        try {
          const spec = playlistMutationSpec(operation), write = hold((url, method) => url.pathname === spec.path && method === spec.method);
          const playing = await playlistPlaybackState(page);
          await clickPlaylistMutation(page, operation); await requested(write);
          const sidebar = hold((url, method) => method === "GET" && url.pathname === "/api/music/playlists");
          await settle(page, write); await requested(sidebar);
          const destinationBefore = countMethodRequests("GET", "/api/music/playlists/other");
          const destination = hold((url, method) => method === "GET" && url.pathname === "/api/music/playlists/other");
          await navigateRoute(page, "/music/playlist/other"); await requested(destination); await capturePlaylistDestination(page);
          await finishOld(page, sidebar, ignoreAbort);
          assert.equal(countMethodRequests("GET", "/api/music/playlists/other") - destinationBefore, 1, "obsolete sidebar completion must not restart the newer playlist request");
          await assertPlaylistDestination(page);
          assert.equal(new URL(page.url()).pathname, "/music/playlist/other");
          await settle(page, destination);
          await page.waitForFunction(() => document.querySelector(".music-panel-heading strong")?.textContent === "Other playlist");
          assert.deepEqual(await visiblePlaylistTracks(page), ["B"]);
          assert.deepEqual(await playlistPlaybackState(page), playing);
          assertPlaylistMutationApplied(operation);
        } finally { await page.close(); playlistState = null; }
      });
      for (const control of ["sort", "search"]) for (const target of ["library", "track page"]) {
        await run(`list control ${control} publishes after playing selection in ${target} ${transport}`, async () => {
          const page = await newPage({ ignoreAbort });
          try {
            const result = control === "sort"
              ? { ...trackList(), tracks: [...trackList().tracks].reverse() }
              : trackList(new URL("http://fixture/api/music/tracks?q=Latest"));
            const gate = hold(url => url.pathname === "/api/music/tracks" && (control === "sort" ? url.searchParams.get("sort") === "title" : url.searchParams.get("q") === "Latest"), "", result);
            await useListControl(page, control); await requested(gate);
            await page.locator('.music-track-table [data-music-track-id="B"] .music-track-title').click();
            await page.waitForFunction(() => fixture.state.music.current?.id === "B");
            if (target === "track page") await page.evaluate(() => fixture.page.openTrack("B", { openPage: true, autoplay: false }));
            else await page.locator('[data-music-search="library"]').focus();
            await page.evaluate(() => {
              __audios[0].currentTime = 42;
              fixture.listShell = document.querySelector(".music-shell");
              fixture.listPlayer = document.querySelector(".music-player-bar");
              fixture.listNow = document.querySelector(".music-now-panel");
              const input = document.querySelector('[data-music-search="library"]');
              if (input) input.setSelectionRange(2, 4);
            });
            const playing = await playbackState(page), route = page.url();
            await beginMusicRenderMeasurement(page); await settle(page, gate);
            const measured = await endMusicRenderMeasurement(page);
            console.log(`MEASURE list ${control} selection ${target} ${transport}: ${JSON.stringify(measured)}`);
            assert.deepEqual(await page.evaluate(() => fixture.state.music.data.tracks.map(item => item.id)), result.tracks.map(item => item.id));
            assert.equal(measured.fullRenders, 0, "current list success may replace its panel but never the shell or player");
            assert.equal(await page.evaluate(() => fixture.listShell === document.querySelector(".music-shell")), true);
            assert.deepEqual(await playbackState(page), playing); assert.equal(page.url(), route);
            if (target === "track page") {
              assert.equal(measured.elements, 0, "a newer player page must not be replaced by library content");
              assert.equal(await page.locator(".music-track-page").count(), 1);
              const acceptedReads = countRequests(url => url.pathname === "/api/music/tracks");
              await page.getByRole("button", { name: "返回音乐库", exact: true }).click();
              await tick(page);
              assert.equal(countRequests(url => url.pathname === "/api/music/tracks"), acceptedReads, "returning from a live song page must keep its accepted list without an unowned replacement read");
              assert.equal(new URL(page.url()).pathname, "/music/library");
              assert.equal(new URL(page.url()).searchParams.get(control === "sort" ? "sort" : "q"), control === "sort" ? "title" : "Latest");
            } else {
              assert.equal(await page.evaluate(() => fixture.listPlayer === document.querySelector(".music-player-bar") && fixture.listNow === document.querySelector(".music-now-panel")), true);
              assert.equal(await page.evaluate(() => document.activeElement?.dataset.musicSearch), "library");
              if (control === "search") assert.deepEqual(await page.locator('[data-music-search="library"]').evaluate(input => [input.selectionStart, input.selectionEnd]), [2, 4]);
            }
            assert.deepEqual(await page.locator(".music-track-table .music-track-row:not(.head)").evaluateAll(rows => rows.map(row => row.dataset.musicTrackId)), result.tracks.map(item => item.id), "the current visible list must agree with the accepted sorted/search response");
            assert.deepEqual(await playbackState(page), playing);
            assert.equal(await page.locator(".music-track-panel").getAttribute("aria-busy"), null);
            assert.equal(await page.locator(".music-load-more").isEnabled(), true);
          } finally { await page.close(); }
        });
      }

      for (const control of ["sort", "search"]) for (const target of ["new sort", "expand", "leave"]) {
        await run(`list control ${control} obsolete after ${target} ${transport}`, async () => {
          const page = await newPage({ ignoreAbort });
          try {
            const old = hold(url => url.pathname === "/api/music/tracks" && (control === "sort" ? url.searchParams.get("sort") === "title" : url.searchParams.get("q") === "Latest"), "", { ...trackList(), tracks: [track("obsolete")] });
            await useListControl(page, control); await requested(old);
            await page.locator('.music-track-table [data-music-track-id="B"] .music-track-title').click();
            await page.waitForFunction(() => fixture.state.music.current?.id === "B");
            let current = null;
            if (target === "new sort") {
              current = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("sort") === "artist");
              await page.locator(".music-sort").selectOption("artist"); await requested(current);
            } else if (target === "expand") {
              await page.getByRole("button", { name: "展开播放页", exact: true }).click();
            } else {
              await page.evaluate(() => {
                fixture.page.resetReader(); fixture.state.activeView = "novels";
                document.querySelector("#workGrid").innerHTML = '<section id="synthetic-destination">Other module</section>';
              });
            }
            const playing = await playbackState(page), route = page.url(), list = await listState(page);
            await page.evaluate(() => { fixture.listDestination = document.querySelector("#workGrid").firstElementChild; });
            await beginMusicRenderMeasurement(page); await finishOld(page, old, ignoreAbort);
            assert.deepEqual(await endMusicRenderMeasurement(page), { fullRenders: 0, elements: 0 });
            assert.equal(await page.evaluate(() => fixture.listDestination === document.querySelector("#workGrid").firstElementChild), true);
            assert.deepEqual(await playbackState(page), playing); assert.equal(page.url(), route);
            assert.deepEqual(await listState(page), list, "a superseded list cannot publish into a new list or destination");
            assert(!(await page.locator("#workGrid").textContent()).includes("Track obsolete"));
            if (current) {
              assert.equal(await page.locator(".music-track-panel").getAttribute("aria-busy"), "true");
              await settle(page, current); assert.equal(await page.locator(".music-sort").inputValue(), "artist");
            }
          } finally { await page.close(); }
        });
      }

      for (const mode of ["artists", "albums"]) await run(`alphabet ${mode} failure renders once and retries ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          await launchRoute(page, { musicMode: mode });
          await page.waitForFunction(mode => fixture.state.music.mode === mode && !fixture.state.music.loading, mode);
          const failed = hold(url => url.pathname === `/api/music/${mode}` && url.searchParams.get("letter") === "A", "controlled alphabet failure");
          await beginOwnedListErrorMeasurement(page);
          const letter = page.locator(".music-alpha-index-item").filter({ hasText: /^A$/ });
          // Keyboard activation exercises the real accessible button even when
          // the compact synthetic sidebar overlaps its pointer hit rectangle.
          await letter.focus(); await letter.press("Enter"); await requested(failed);
          assert.equal(await page.locator(".music-track-panel").getAttribute("aria-busy"), "true");
          await settle(page, failed);
          assert.equal((await endMusicRenderMeasurement(page)).fullRenders, 0, "a current alphabet rejection must update its error surface without rebuilding the music shell");
          await assertOwnedListErrorMeasurement(page);
          assert((await page.locator("#workGrid").textContent()).includes("controlled alphabet failure"));
          assert.equal(await page.locator(".music-list-retry").count(), 1);
          assert.deepEqual(await page.locator(".music-alpha-index-item.active").allTextContents(), ["A"]);
          assert.equal(await page.locator('.music-alpha-index-item[data-music-letter="A"]').getAttribute("aria-pressed"), "true");
          assert.equal(await page.locator(".music-track-panel").getAttribute("aria-busy"), null);
          const payload = mode === "artists" ? { artists: [{ id: "beta", name: "Beta artist", trackCount: 1 }], total: 1, hasMore: false, summary: summary() }
            : { albums: [{ id: "beta", title: "Beta album", artistName: "Beta artist", trackCount: 1 }], total: 1, hasMore: false, summary: summary() };
          const retry = hold(url => url.pathname === `/api/music/${mode}` && url.searchParams.get("letter") === "B", "", payload);
          const nextLetter = page.locator(".music-alpha-index-item").filter({ hasText: /^B$/ });
          await nextLetter.focus(); await nextLetter.press("Enter"); await requested(retry);
          assert.equal(await page.locator(".music-track-panel").getAttribute("aria-busy"), "true");
          await settle(page, retry);
          assert.deepEqual(await page.locator(".music-alpha-index-item.active").allTextContents(), ["B"]);
          assert.equal(await page.locator('.music-alpha-index-item[data-music-letter="B"]').getAttribute("aria-pressed"), "true");
          assert.deepEqual(await page.locator(mode === "artists" ? ".music-artist-browser-card strong" : ".music-album-browser-card > span:not(.music-cover) > strong").allTextContents(), [mode === "artists" ? "Beta artist" : "Beta album"]);
          assert.equal(await page.locator(".music-list-read-error").count(), 0);
          assert(!(await page.locator("#workGrid").textContent()).includes("controlled alphabet failure"));
          assert.equal(await page.locator(".music-track-panel").getAttribute("aria-busy"), null);
        } finally { await page.close(); }
      });

      await run(`rating caller presents a failed list refresh once and retries ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          await page.locator('.music-track-table [data-music-track-id="B"] .music-track-title').click();
          await page.waitForFunction(() => fixture.state.music.current?.id === "B");
          await page.locator(".music-sort").selectOption("rating");
          await page.waitForFunction(() => !fixture.state.music.loading);
          const playing = await audioState(page);
          const failed = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("sort") === "rating", "controlled rating refresh failure");
          await beginOwnedListErrorMeasurement(page);
          await page.locator(".music-now-panel").getByRole("button", { name: "设为 3 星", exact: true }).click();
          await requested(failed); await settle(page, failed);
          assert.equal((await endMusicRenderMeasurement(page)).fullRenders, 0, "the rating caller must publish its owned list rejection without rebuilding the music shell");
          await assertOwnedListErrorMeasurement(page);
          assert.deepEqual(await page.evaluate(() => [fixture.state.music.current.rating, fixture.state.music.status]), [3, "controlled rating refresh failure"]);
          assert.equal(await page.locator(".music-now-panel .music-rating.now").getAttribute("aria-label"), "评分：3", "the confirmed score must remain visible when its dependent list refresh fails");
          assert.equal(await page.locator(".music-list-retry").count(), 1);
          assert.equal(await page.locator(".music-list-read-error").isVisible(), true, "a saved score's failed list refresh must expose its real recovery cause");
          assert.equal(await page.locator(".music-rating-feedback").count(), 0, "the existing list recovery must not duplicate the same rating refresh cause");
          assert.equal(await page.locator(".music-track-panel").getAttribute("aria-busy"), null);
          assert.equal(await page.locator(".music-sort").inputValue(), "rating");
          const retry = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("sort") === "rating");
          await page.locator(".music-now-panel").getByRole("button", { name: "设为 4 星", exact: true }).click();
          await requested(retry); await settle(page, retry);
          assert.deepEqual(await page.evaluate(() => [fixture.state.music.current.rating, fixture.state.music.status]), [4, ""]);
          assert.equal(await page.locator(".music-list-read-error").count(), 0);
          assert.equal(await page.locator(".music-track-table .music-track-row:not(.head)").count(), 120);
          assert.equal(await page.locator(".music-track-panel").getAttribute("aria-busy"), null);
          assert.deepEqual(await audioState(page), playing);
        } finally { await page.close(); }
      });

      await run(`favorite ownership late writes preserve native playback and filter intentions ${transport}`, async () => {
        for (const destination of ["playback", "filter"]) for (const outcome of ["success", "failure"]) {
          const page = await newPage({ ignoreAbort });
          const write = hold((url, method) => url.pathname === "/api/music/tracks/A/favorite" && method === "POST",
            outcome === "failure" ? "Obsolete favorite POST failure" : "",
            outcome === "success" ? { track: { ...track("A"), title: "Obsolete favorite title", rating: 1, favorite: true } } : null);
          try {
            await page.locator('.music-track-table [data-music-track-id="A"] .music-track-title').click();
            await page.waitForFunction(() => fixture.state.music.current?.id === "A");
            // A raw prefix is a legitimate retained search cache, including duplicate occurrences.
            await page.evaluate(() => { fixture.state.music.data.rawTracks = [null, ...fixture.state.music.data.tracks, { ...fixture.state.music.data.tracks.find(track => track.id === "A") }]; });
            await page.locator(".music-now-panel").getByRole("button", { name: "收藏", exact: true }).click(); await requested(write);
            if (destination === "playback") {
              const detail = hold(url => url.pathname === "/api/music/tracks/B", "", { track: track("B"), lyrics: { raw: "", lines: Array.from({ length: 5000 }, (_, index) => ({ timeMs: index * 1000, text: `Line B ${index}` })) } });
              try {
                await page.locator('.music-track-table [data-music-track-id="B"] .music-track-title').click(); await requested(detail); await settle(page, detail);
              } finally { detail.release(); held.delete(detail); }
              await page.waitForFunction(() => fixture.state.music.current?.id === "B");
              await page.getByRole("button", { name: "展开播放页", exact: true }).click();
              await page.locator(".music-lyric-find input").fill("Line B");
            } else {
              await page.locator(".music-favorite-filter").click();
              await page.waitForFunction(() => fixture.state.music.favorite && !fixture.state.music.loading);
            }
            const known = await favoriteKnownMetadata(page, "A"), playing = await audioState(page);
            await captureFavoriteOwnershipSurface(page, destination === "playback" ? { inputSelector: ".music-lyric-find input", scrollSelector: ".music-stage-content" } : {});
            if (destination === "playback") {
              await page.locator(".music-stage-content").evaluate(node => { node.scrollTop = 112; __favoriteOwnershipSurface.top = node.scrollTop; });
              assert.equal(await page.locator(".music-stage-content").evaluate(node => node.scrollTop), 112, "the visible B stage must have a real nonzero scroll position before the old favorite settles");
              assert.equal(new URL(page.url()).pathname, "/music/track/B");
            }
            const reads = countMethodRequests("GET", "/api/music/tracks"), route = page.url();
            await settle(page, write);
            await assertFavoriteOwnershipSurface(page);
            assert.deepEqual(await audioState(page), playing); assert.equal(page.url(), route);
            assert.equal(countMethodRequests("GET", "/api/music/tracks"), reads, "a stale favorite completion must not refresh a newer filter");
            assert.deepEqual(await favoriteKnownMetadata(page, "A"), outcome === "success" ? known.map(item => ({ ...item, favorite: true })) : known,
              "same-account confirmation must merge only favorite into known occurrences, preserving newer titles and ratings");
            assert.equal(await page.evaluate(() => fixture.state.music.current.id), destination === "playback" ? "B" : "A");
          } finally { write.release(); held.delete(write); await page.close(); }
        }
        ratingValues.set("A", 0);
        const page = await newPage({ ignoreAbort });
        const write = hold((url, method) => url.pathname === "/api/music/tracks/A/favorite" && method === "POST", "", { track: { ...track("A"), title: "Old favorite metadata", rating: 0, favorite: true } });
        try {
          await page.locator('.music-track-table [data-music-track-id="A"] .music-track-title').click();
          await page.waitForFunction(() => fixture.state.music.current?.id === "A" && fixture.state.music.current.rating === 0);
          await page.evaluate(() => { fixture.state.music.data.rawTracks = [null, ...fixture.state.music.data.tracks, { ...fixture.state.music.data.tracks.find(track => track.id === "A") }]; });
          await page.locator(".music-now-panel").getByRole("button", { name: "收藏", exact: true }).click(); await requested(write);
          await clickRating(page, 5); await waitRating(page, "A", 5);
          const confirmed = await favoriteKnownMetadata(page, "A");
          assert(confirmed.every(track => track.rating === 5), "the native rating must be confirmed in every known copy before the favorite response");
          await queueSearchInput(page).focus(); await captureQueueSearchEdit(page, "  待确认收藏草稿  ");
          await page.evaluate(() => { __audios[0].currentTime = 42; window.__favoriteRatingShell = document.querySelector(".music-shell"); });
          const playing = await audioState(page), route = page.url(), reads = countMethodRequests("GET", "/api/music/tracks");
          const scroll = await page.locator(".music-track-panel").evaluate(panel => ({ top: panel.scrollTop, page: scrollY }));
          await beginMusicRenderMeasurement(page); await settle(page, write);
          assert.equal((await endMusicRenderMeasurement(page)).fullRenders, 0, "a same-context favorite confirmation must not rebuild the full music shell");
          await assertQueueSearchEdit(page);
          assert.equal(await page.evaluate(() => __favoriteRatingShell === document.querySelector(".music-shell")), true);
          assert.deepEqual(await favoriteKnownMetadata(page, "A"), confirmed.map(track => ({ ...track, favorite: true })),
            "an older favorite DTO must preserve the later confirmed rating and metadata in current, queue, tracks and raw tracks");
          assert.equal(await page.locator(".music-rating.now").getAttribute("aria-label"), "评分：5");
          assert.equal(await page.locator(".music-rating.now button.active").count(), 5);
          assert.equal(countMethodRequests("GET", "/api/music/tracks"), reads, "local queue composition and metadata writes must not navigate or reread the library");
          assert.deepEqual(await page.locator(".music-track-panel").evaluate(panel => ({ top: panel.scrollTop, page: scrollY })), scroll);
          assert.deepEqual(await audioState(page), playing); assert.equal(page.url(), route);
        } finally { write.release(); held.delete(write); await page.close(); }
      });
      await run(`favorite ownership dependent reads yield to newer errors and account identity ${transport}`, async () => {
        for (const outcome of ["success", "failure"]) {
          const page = await newPage({ ignoreAbort });
          const write = hold((url, method) => url.pathname === "/api/music/tracks/A/favorite" && method === "POST", "", { track: { ...track("A"), favorite: true } });
          const obsolete = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("favorite") === "1", "Obsolete favorite GET failure");
          let newer;
          try {
            await page.locator('.music-track-table [data-music-track-id="A"] .music-track-title').click();
            await page.waitForFunction(() => fixture.state.music.current?.id === "A");
            // The first favorites read is a completed user navigation; hold only its later dependent refresh.
            held.delete(obsolete); await page.locator(".music-favorite-filter").click();
            await page.waitForFunction(() => fixture.state.music.favorite && !fixture.state.music.loading); held.add(obsolete);
            await page.locator(".music-now-panel").getByRole("button", { name: "收藏", exact: true }).click();
            await requested(write); await settle(page, write); await requested(obsolete);
            newer = hold(url => url.pathname === "/api/music/tracks" && !url.searchParams.has("favorite"), outcome === "failure" ? "Newer explicit library failure" : "");
            await page.locator(".music-favorite-filter").click(); await requested(newer); await settle(page, newer);
            await page.waitForFunction(() => !fixture.state.music.loading);
            assert.equal(await page.evaluate(() => fixture.state.music.status), outcome === "failure" ? "Newer explicit library failure" : "");
            const playing = await audioState(page), route = page.url(), reads = countMethodRequests("GET", "/api/music/tracks");
            await captureFavoriteOwnershipSurface(page);
            await finishOld(page, obsolete, ignoreAbort); await assertFavoriteOwnershipSurface(page);
            assert.deepEqual(await audioState(page), playing); assert.equal(page.url(), route);
            assert.equal(countMethodRequests("GET", "/api/music/tracks"), reads);
            assert.equal(await page.evaluate(() => fixture.state.music.current.favorite), true);
          } finally { for (const gate of [write, obsolete, newer].filter(Boolean)) { gate.release(); held.delete(gate); } await page.close(); }
        }
        {
          const page = await newPage({ ignoreAbort });
          const writes = [];
          try {
            await page.locator('.music-track-table [data-music-track-id="A"] .music-track-title').click();
            await page.waitForFunction(() => fixture.state.music.current?.id === "A");
            await page.locator(".music-favorite-filter").click(); await page.waitForFunction(() => fixture.state.music.favorite && !fixture.state.music.loading);
            const first = hold((url, method) => url.pathname === "/api/music/tracks/A/favorite" && method === "POST", "", { track: { ...track("A"), favorite: true } }); writes.push(first);
            const read = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("favorite") === "1", "Old favorite maintenance failure"); writes.push(read);
            await page.locator(".music-now-panel").getByRole("button", { name: "收藏", exact: true }).click(); await requested(first); await settle(page, first); await requested(read);
            const newer = hold((url, method) => url.pathname === "/api/music/tracks/A/favorite" && method === "POST", "New favorite save failure"); writes.push(newer);
            const reads = countMethodRequests("GET", "/api/music/tracks");
            await page.locator(".music-now-panel").getByRole("button", { name: "已收藏", exact: true }).click(); await requested(newer); await settle(page, newer);
            await page.waitForFunction(() => fixture.state.music.status === "New favorite save failure");
            assert.equal(await page.locator(".music-list-retry").count(), 0);
            assert((await page.locator("#workGrid").textContent()).includes("New favorite save failure"));
            const alert = page.locator('.music-favorite-feedback[role="alert"]');
            assert.equal(await alert.isVisible(), true, "the current favorite save failure must be visibly announced");
            await alert.evaluate(node => { window.__newFavoriteAlert = { node, parent: node.parentElement, text: node.textContent }; });
            await captureFavoriteOwnershipSurface(page, { inputSelector: '.music-queue-search input[type="search"]' });
            const playing = await audioState(page), route = page.url();
            await settle(page, read); await assertFavoriteOwnershipSurface(page);
            assert.equal(await page.evaluate(() => fixture.state.music.status), "New favorite save failure", "an older favorite maintenance failure must not replace the newer favorite save error");
            assert.equal(await page.locator(".music-list-retry").count(), 0, "obsolete maintenance must not publish a stale list retry panel");
            assert.equal(await alert.isVisible(), true);
            assert.equal(await alert.evaluate(node => node === __newFavoriteAlert.node && node.parentElement === __newFavoriteAlert.parent && node.textContent === __newFavoriteAlert.text), true,
              "the newer visible favorite alert must retain its original node, parent and cause after the obsolete read");
            assert.equal(countMethodRequests("GET", "/api/music/tracks"), reads);
            assert.deepEqual(await audioState(page), playing); assert.equal(page.url(), route);
            // Explicit controller redraw: this is not represented as a native navigation.
            await page.evaluate(() => fixture.page.renderView());
            assert.equal(await page.locator(".music-list-retry").count(), 0, "a later controller render must not resurrect obsolete favorite recovery");
            assert.deepEqual(await page.evaluate(() => [fixture.state.music.status, document.querySelector("#workGrid").textContent.includes("New favorite save failure")]), ["New favorite save failure", true]);
            assert.equal(await alert.isVisible(), true, "the current favorite cause must remain visible after a controller render");
          } finally { for (const gate of writes) { gate.release(); held.delete(gate); } await page.close(); }
        }
        // This uses index -> standalone-host -> createApiClient, not the probe's unguarded synthetic API.
        const page = await newPage({ real: true, ignoreAbort });
        const write = hold((url, method) => url.pathname === "/api/music/tracks/P/favorite" && method === "POST", "", { track: { ...track("P"), favorite: true } });
        try {
          await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click();
          await page.waitForFunction(() => __audios[0]?.src.endsWith("/synthetic/audio/P"));
          await page.locator(".music-now-panel").getByRole("button", { name: "收藏", exact: true }).click(); await requested(write);
          await page.evaluate(async () => { const { publishWebAccountChange } = await import("/platform/accounts/session-context.js"); publishWebAccountChange("new-favorite-account"); });
          const playing = await audioState(page), route = page.url(), reads = countMethodRequests("GET", "/api/music/tracks");
          await captureFavoriteOwnershipSurface(page);
          await settle(page, write); await assertFavoriteOwnershipSurface(page);
          assert.equal(await page.evaluate(() => __fanhaoWebAccountContext.owner), "new-favorite-account");
          assert.equal(countMethodRequests("GET", "/api/music/tracks"), reads); assert.equal(page.url(), route);
          assert.deepEqual(await audioState(page), playing);
          assert.equal(await page.locator(".music-now-panel").getByRole("button", { name: "收藏", exact: true }).count(), 1,
            "the real API's ACCOUNT_CHANGED rejection must not publish an old confirmation or an error screen");
        } finally { write.release(); held.delete(write); await page.close(); }
      });
      await run(`favorite ownership accepted append maintains current favorite membership ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        const initial = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("favorite") === "1", "", { ...trackList(), tracks: trackList().tracks.map(track => ({ ...track, favorite: true })) });
        const write = hold((url, method) => url.pathname === "/api/music/tracks/A/favorite" && method === "POST", "", { track: { ...track("A"), favorite: false } });
        const append = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("offset") === "120", "", { ...trackList(new URL("http://fixture/api/music/tracks?offset=120&limit=120")), tracks: trackList(new URL("http://fixture/api/music/tracks?offset=120&limit=120")).tracks.map(track => ({ ...track, favorite: true })) });
        let refreshed;
        try {
          await page.locator(".music-favorite-filter").click(); await requested(initial); await settle(page, initial);
          const detail = hold(url => url.pathname === "/api/music/tracks/A", "", { track: { ...track("A"), favorite: true }, lyrics: lyrics("A") });
          try {
            await page.locator('.music-track-table [data-music-track-id="A"] .music-track-title').click(); await requested(detail); await settle(page, detail);
          } finally { detail.release(); held.delete(detail); }
          await page.waitForFunction(() => fixture.state.music.current?.id === "A");
          const playing = await audioState(page);
          await page.locator(".music-now-panel").getByRole("button", { name: "已收藏", exact: true }).click(); await requested(write);
          await page.locator(".music-track-panel .music-load-more").click(); await requested(append); await settle(page, append);
          assert.equal(await page.evaluate(() => fixture.state.music.data.tracks.length), 240);
          refreshed = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("favorite") === "1" && Number(url.searchParams.get("offset") || 0) === 0, "", { ...trackList(), tracks: ["P", "B"].map(id => ({ ...track(id), favorite: true })), total: 2, hasMore: false });
          const reads = countMethodRequests("GET", "/api/music/tracks");
          await settle(page, write); await requested(refreshed); await settle(page, refreshed);
          assert.equal(countMethodRequests("GET", "/api/music/tracks"), reads + 1, "a successful same-filter append must not suppress the confirmed membership refresh");
          assert.deepEqual(await visiblePlaylistTracks(page), ["P", "B"]);
          assert.deepEqual(await page.evaluate(() => [fixture.state.music.favorite, fixture.state.music.current.id, fixture.state.music.current.favorite, fixture.state.music.queue.find(track => track.id === "A")?.favorite]), [true, "A", false, false]);
          assert.equal(await page.locator(".music-now-panel").getByRole("button", { name: "收藏", exact: true }).count(), 1);
          assert.deepEqual(await audioState(page), playing);
        } finally { for (const gate of [initial, write, append, refreshed].filter(Boolean)) { gate.release(); held.delete(gate); } await page.close(); }
      });
      await run(`favorite caller preserves a confirmed change after list failure ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        const writes = [];
        try {
          await page.locator('.music-track-table [data-music-track-id="B"] .music-track-title').click();
          await page.waitForFunction(() => fixture.state.music.current?.id === "B");
          await page.locator(".music-favorite-filter").click(); await page.waitForFunction(() => !fixture.state.music.loading);
          const playing = await audioState(page);
          const write = hold((url, method) => url.pathname === "/api/music/tracks/B/favorite" && method === "POST", "", { track: { ...track("B"), favorite: true } }); writes.push(write);
          const failed = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("favorite") === "1", "controlled favorite refresh failure"); writes.push(failed);
          await beginOwnedListErrorMeasurement(page);
          await page.locator(".music-now-panel").getByRole("button", { name: "收藏", exact: true }).click(); await requested(write); await settle(page, write);
          await requested(failed); await settle(page, failed);
          assert.equal((await endMusicRenderMeasurement(page)).fullRenders, 0);
          await assertOwnedListErrorMeasurement(page);
          assert.deepEqual(await page.evaluate(() => [fixture.state.music.current.favorite, fixture.state.music.status]), [true, "controlled favorite refresh failure"]);
          assert.equal(await page.locator(".music-now-panel").getByRole("button", { name: "已收藏", exact: true }).count(), 1, "a confirmed favorite change must remain visible when its dependent list refresh fails");
          const undo = hold((url, method) => url.pathname === "/api/music/tracks/B/favorite" && method === "POST", "", { track: { ...track("B"), favorite: false } }); writes.push(undo);
          const recovered = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("favorite") === "1", "", { ...trackList(), tracks: [{ ...track("P"), favorite: true }], total: 1, hasMore: false }); writes.push(recovered);
          await page.locator(".music-now-panel").getByRole("button", { name: "已收藏", exact: true }).click(); await requested(undo); await settle(page, undo);
          await requested(recovered); await settle(page, recovered);
          assert.deepEqual(await page.evaluate(() => [fixture.state.music.current.favorite, fixture.state.music.status]), [false, ""]);
          assert.equal(await page.locator(".music-now-panel").getByRole("button", { name: "收藏", exact: true }).count(), 1);
          assert.deepEqual(await visiblePlaylistTracks(page), ["P"]);
          assert.equal(await page.locator(".music-list-read-error").count(), 0);
          assert.deepEqual(await audioState(page), playing);
        } finally { for (const read of writes) { read.release(); held.delete(read); } await page.close(); }
      });

      for (const error of ["", "obsolete append failure"]) for (const target of ["library", "rerendered library", "track page"]) {
        await run(`append after playing selection ${target} ${error ? "failure and retry" : "success"} ${transport}`, async () => {
          const page = await newPage({ ignoreAbort });
          try {
            const old = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("offset") === "120", error);
            const idleLabel = await page.locator(".music-load-more").textContent();
            await page.locator(".music-load-more").click(); await requested(old);
            await page.locator('.music-track-table [data-music-track-id="B"] .music-track-title').click();
            await page.waitForFunction(() => fixture.state.music.current?.id === "B");
            // Exercise the public openTrack option too: unlike the explicit
            // expand control, selecting a track page need not cancel list I/O.
            if (target === "track page") await page.evaluate(() => fixture.page.openTrack("B", { openPage: true, autoplay: false }));
            if (target === "rerendered library") await page.evaluate(() => fixture.page.renderView());
            await page.evaluate(() => {
              __audios[0].currentTime = 42;
              fixture.appendShell = document.querySelector(".music-shell");
              fixture.appendRow = document.querySelector(".music-track-row:not(.head)");
              fixture.appendPlayer = document.querySelector(".music-player-bar");
              fixture.appendNow = document.querySelector(".music-now-panel");
            });
            const playing = await playbackState(page), route = page.url();
            await beginMusicRenderMeasurement(page); await settle(page, old);
            const measured = await endMusicRenderMeasurement(page);
            console.log(`MEASURE append selection ${target} ${error ? "failure" : "success"} ${transport}: ${JSON.stringify(measured)}`);
            assert.equal(measured.fullRenders, 0, "finishing an append must preserve the selected playback surface");
            assert.equal(await page.evaluate(() => fixture.appendShell === document.querySelector(".music-shell")), true);
            assert.deepEqual(await playbackState(page), playing); assert.equal(page.url(), route);
            assert.deepEqual(await page.evaluate(() => [fixture.state.music.loading, fixture.state.music.loadingMore]), [false, false]);
            assert.equal(await page.evaluate(() => fixture.state.music.data.tracks.length), error ? 120 : 240);
            assert(!(await page.locator("#workGrid").textContent()).includes("obsolete append failure"));
            if (target === "track page") {
              assert.equal(measured.elements, 0, "a mounted player page has no list to update");
              assert.equal(await page.locator(".music-track-page").count(), 1);
              await page.getByRole("button", { name: "返回音乐库", exact: true }).click();
            } else {
              assert.equal(await page.evaluate(() => fixture.appendRow === document.querySelector(".music-track-row:not(.head)")), true, "the existing 120 rows stay mounted");
              assert.equal(await page.evaluate(() => fixture.appendPlayer === document.querySelector(".music-player-bar") && fixture.appendNow === document.querySelector(".music-now-panel")), true);
              if (error) assert.equal(measured.elements, 0, "superseded errors only restore the existing retry control");
              else assert(measured.elements > 1000 && measured.elements < 1800, "only the incoming 120 rows should be created");
            }
            assert.equal(await page.locator(".music-track-table .music-track-row:not(.head)").count(), error ? 120 : 240);
            assert.equal(await page.locator(".music-load-more").isEnabled(), true);
            assert.equal(await page.locator(".music-load-more").textContent(), error ? idleLabel : "再加载 60 首");
            if (error) {
              const retry = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("offset") === "120");
              await page.locator(".music-load-more").click(); await requested(retry); await settle(page, retry);
              assert.equal(await page.locator(".music-track-table .music-track-row:not(.head)").count(), 240);
              assert.deepEqual(await playbackState(page), playing, "retrying the append must retain playback and the selected queue");
              assert.equal(await page.locator(".music-load-more").isEnabled(), true);
            }
          } finally { await page.close(); }
        });
      }

      for (const error of ["", "obsolete append failure"]) for (const target of ["sort", "expand", "leave"]) {
        await run(`append control obsolete after ${target} ${error ? "failure" : "success"} ${transport}`, async () => {
          const page = await newPage({ ignoreAbort });
          try {
            const old = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("offset") === "120", error);
            await page.locator(".music-load-more").click(); await requested(old);
            await page.locator('.music-track-table [data-music-track-id="B"] .music-track-title').click();
            await page.waitForFunction(() => fixture.state.music.current?.id === "B");
            let current = null;
            if (target === "sort") {
              current = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("sort") === "title");
              await page.locator(".music-sort").selectOption("title"); await requested(current);
            } else if (target === "expand") {
              await page.getByRole("button", { name: "展开播放页", exact: true }).click();
            } else {
              await page.evaluate(() => {
                fixture.page.resetReader(); fixture.state.activeView = "novels";
                document.querySelector("#workGrid").innerHTML = '<section id="synthetic-destination">Other module</section>';
              });
            }
            const playing = await playbackState(page), route = page.url(), list = await listState(page);
            await page.evaluate(() => { fixture.appendDestination = document.querySelector("#workGrid").firstElementChild; });
            await beginMusicRenderMeasurement(page); await finishOld(page, old, ignoreAbort);
            assert.deepEqual(await endMusicRenderMeasurement(page), { fullRenders: 0, elements: 0 });
            assert.equal(await page.evaluate(() => fixture.appendDestination === document.querySelector("#workGrid").firstElementChild), true);
            assert.deepEqual(await playbackState(page), playing); assert.equal(page.url(), route);
            assert.deepEqual(await listState(page), list, "old append completion cannot modify a new navigation or list owner");
            if (current) {
              assert.equal(await page.locator(".music-track-panel").getAttribute("aria-busy"), "true");
              await settle(page, current); assert.equal(await page.locator(".music-sort").inputValue(), "title");
            }
          } finally { await page.close(); }
        });
      }

      for (const append of [false, true]) await run(`list error renders once and ${append ? "append" : "sort"} control retries ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          const failed = hold(url => url.pathname === "/api/music/tracks", "controlled list failure");
          await page.evaluate(() => { window.__errorMusicShell = document.querySelector(".music-shell"); window.__errorMusicSort = document.querySelector(".music-sort"); window.__errorMore = document.querySelector(".music-load-more"); window.__errorRows = [...document.querySelectorAll(".music-track-row:not(.head)")]; });
          if (!append) await page.evaluate(() => {
            window.__errorTableUpdates = 0;
            window.__errorTableObserver = new MutationObserver(records => {
              for (const record of records) for (const node of record.addedNodes) if (node.querySelector?.(".music-list-read-error")) __errorTableUpdates++;
            });
            __errorTableObserver.observe(document.querySelector(".music-track-panel"), { childList: true });
          });
          await beginMusicRenderMeasurement(page);
          if (append) await page.locator(".music-load-more").click();
          else await page.locator(".music-sort").selectOption("title");
          await requested(failed);
          assert.equal(new URL(failed.url, base).searchParams.get("offset"), append ? "120" : null);
          assert.equal(await page.locator(".music-track-panel").getAttribute("aria-busy"), "true");
          await settle(page, failed);
          const measured = await endMusicRenderMeasurement(page);
          console.log(`MEASURE list ${append ? "append" : "sort"} failure ${transport}: ${JSON.stringify(measured)}`);
          assert.equal(measured.fullRenders, 0, append ? "an append rejection must preserve its current shell, results and native retry control" : "a current sort rejection must update its owned error panel without replacing the native control's shell");
          if (append) assert.equal(await page.evaluate(() => __errorMusicShell === document.querySelector(".music-shell") && __errorMore === document.querySelector(".music-load-more") && __errorRows.every(row => row.isConnected)), true, "append failure must retain its original rows and retry control");
          if (!append) assert.equal(await page.evaluate(() => __errorMusicShell === document.querySelector(".music-shell") && __errorMusicSort === document.querySelector(".music-sort") && __errorMusicSort.isConnected), true, "a failed full read must retain the same native sort ancestry");
          if (!append) assert.equal(await page.evaluate(() => { __errorTableObserver.disconnect(); return __errorTableUpdates; }), 1, "one current sort rejection must mount its owned error table exactly once");
          assert(append ? measured.elements > 0 && measured.elements < 10 : measured.elements > 0 && measured.elements < 500, append ? "append failure should only add its bounded inline error instead of rebuilding the existing 120 rows" : "a failed full read should render a bounded error panel instead of rebuilding old results");
          assert.equal(await page.locator(".music-track-table .music-track-row:not(.head)").count(), append ? 120 : 0);
          assert.equal(await page.locator(".music-track-panel").getAttribute("aria-busy"), null);
          assert((await page.locator("#workGrid").textContent()).includes("controlled list failure"));
          assert.deepEqual(await page.evaluate(() => [fixture.state.music.loading, fixture.state.music.loadingMore]), [false, false]);
          assert.equal(await page.locator(append ? ".music-load-more" : ".music-list-retry").isEnabled(), true, "a current failure must release its own retry control");
          const retry = hold(url => url.pathname === "/api/music/tracks");
          if (append) await page.locator(".music-load-more").click();
          else await page.locator(".music-sort").selectOption("artist");
          await requested(retry);
          assert.equal(new URL(retry.url, base).searchParams.get("offset"), append ? "120" : null, "failed appends cannot advance the requested offset");
          await settle(page, retry);
          assert.equal(await page.locator(".music-track-table .music-track-row:not(.head)").count(), append ? 240 : 120);
          assert.equal(await page.locator(".music-track-panel").getAttribute("aria-busy"), null);
          assert(!(await page.locator("#workGrid").textContent()).includes("controlled list failure"));
        } finally { await page.close(); }
      });

      for (const target of ["sort", "track", "leave"]) await run(`list error obsolete control request preserves ${target} ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          const old = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("sort") === "title", "obsolete control failure");
          await page.locator(".music-sort").selectOption("title"); await requested(old);
          let current = null;
          if (target === "sort") {
            current = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("sort") === "artist");
            await page.locator(".music-sort").selectOption("artist"); await requested(current);
          } else if (target === "track") {
            await page.locator('.music-track-table [data-music-track-id="B"] .music-track-title').click();
            await page.waitForFunction(() => fixture.state.music.current?.id === "B");
          } else {
            // The synthetic destination replaces the shared outlet only after
            // calling the same public reset hook used by the standalone host.
            await page.evaluate(() => {
              fixture.page.resetReader(); fixture.state.activeView = "novels";
              document.querySelector("#workGrid").innerHTML = '<section id="synthetic-destination">Other module</section>';
            });
          }
          await page.evaluate(() => { fixture.errorDestination = document.querySelector("#workGrid").firstElementChild; });
          await beginMusicRenderMeasurement(page);
          // Choosing a track lets the list finish as background metadata;
          // changing the list or leaving the page cancels its transport.
          if (target === "track") await settle(page, old);
          else await finishOld(page, old, ignoreAbort);
          const measured = await endMusicRenderMeasurement(page);
          assert.equal(measured.fullRenders, 0, "an obsolete rejection cannot invoke the UI catch and rebuild the current view");
          assert.equal(measured.elements, 0);
          assert.equal(await page.evaluate(() => fixture.errorDestination === document.querySelector("#workGrid").firstElementChild), true);
          assert(!(await page.locator("#workGrid").textContent()).includes("obsolete control failure"));
          if (current) {
            assert.equal(await page.locator(".music-track-panel").getAttribute("aria-busy"), "true");
            await settle(page, current); assert.equal(await page.locator(".music-sort").inputValue(), "artist");
          } else if (target === "leave") assert.equal(await page.locator("#synthetic-destination").isVisible(), true);
        } finally { await page.close(); }
      });

      for (const error of ["", "old music error"]) {
        const result = error ? "error" : "success";
        for (const navigation of ["track", "list", "back", "close"]) await run(`host initial A held to ${navigation} ${result} ${transport}`, async () => {
          const old = hold(url => url.pathname === "/api/music/tracks/A", error);
          const next = navigation === "close" ? null : hold(url => url.pathname === (navigation === "track" ? "/api/music/tracks/B" : "/api/music/tracks"));
          const page = await newPage({ real: true, ignoreAbort, route: "/music/track/A", waitReady: false, initialBack: navigation === "back" });
          try {
            await requested(old); const token = await page.evaluate(() => __documentToken);
            if (navigation === "back") await page.goBack({ waitUntil: "commit" });
            else if (navigation === "close") await page.keyboard.press("Escape");
            else await navigateRoute(page, navigation === "track" ? "/music/track/B" : "/music/library");
            if (next) { await requested(next, 2000); await settle(page, next); }
            await ready(page); if (navigation === "track") await stageTitle(page, "Track B"); else await library(page);
            assert.equal(await page.evaluate(() => __documentToken), token, "history/close must keep the initial document");
            await finishOld(page, old, ignoreAbort);
            assert.equal(new URL(page.url()).pathname, navigation === "track" ? "/music/track/B" : "/music/library");
            assert.equal(await page.locator(navigation === "track" ? ".music-track-page" : ".music-library-page").count(), 1);
            if (navigation === "track") assert.equal(await page.locator(".music-stage-meta h2").textContent(), "Track B");
            assert(!(await page.locator("#workGrid").textContent()).includes("old music error"));
            assert(await page.evaluate(() => __transport.aborted.some(url => url.split("?")[0] === "/api/music/tracks/A")), "new history intent must abort old A even with ignored AbortSignal");
          } finally { await page.close(); }
        });

        await run(`rapid track owner error finally ${result} ${transport}`, async () => {
          const page = await newPage({ ignoreAbort });
          try {
            const old = hold(url => url.pathname === "/api/music/tracks/A", error); await launchTrack(page, "A"); await requested(old);
            const current = hold(url => url.pathname === "/api/music/tracks/B"); await launchTrack(page, "B"); await requested(current);
            await finishOld(page, old, ignoreAbort);
            assert.deepEqual(await trackState(page), { current: null, opening: "B", status: "正在打开歌曲" }, "old track must not clear B's current loading owner");
            assert.equal(await page.locator(".music-shell").getAttribute("aria-busy"), "true");
            await settle(page, current); assert.deepEqual(await trackState(page), { current: "B", opening: "", status: "" });
            assert.equal(await page.evaluate(() => fixture.state.music.lyrics.raw), "Lyric B"); assert.match((await audioState(page)).src, /\/synthetic\/audio\/B$/);
          } finally { await page.close(); }
        });

        await run(`list owner error finally ${result} ${transport}`, async () => {
          const page = await newPage({ ignoreAbort });
          try {
            const old = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "old", error); await launchList(page, "old"); await requested(old);
            const current = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "new"); await launchList(page, "new"); await requested(current);
            await finishOld(page, old, ignoreAbort);
            assert.deepEqual(await listState(page), { query: "new", loading: true, loadingMore: false, status: "正在读取音乐库", count: 120 }, "old list must not clear newest loading/error status");
            assert.equal(await page.locator(".music-track-panel").getAttribute("aria-busy"), "true");
            await settle(page, current); assert.equal(await page.evaluate(() => fixture.state.music.data.tracks[0].id), "new-1");
            assert.equal(await page.locator(".music-track-panel").getAttribute("aria-busy"), null);
          } finally { await page.close(); }
        });

        await run(`append selection and current finally ${result} ${transport}`, async () => {
          const page = await newPage({ ignoreAbort });
          try {
            const old = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("offset") === "120" && !url.searchParams.has("q"), error);
            await launchAppend(page); await requested(old); await loadList(page, "new");
            const current = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "new" && url.searchParams.get("offset") === "120");
            await launchAppend(page); await requested(current); await finishOld(page, old, ignoreAbort);
            assert.deepEqual(await listState(page), { query: "new", loading: false, loadingMore: true, status: "正在加载更多", count: 120 });
            await settle(page, current); assert.equal(await page.evaluate(() => fixture.state.music.data.tracks.length), 240);
            assert(await page.evaluate(() => fixture.state.music.data.tracks.every(track => track.id.startsWith("new-"))));
          } finally { await page.close(); }
        });

        await run(`restoreLastTrack cannot own newer list ${result} ${transport}`, async () => {
          const page = await newPage({ ignoreAbort, saved: "A" });
          try {
            const old = hold(url => url.pathname === "/api/music/tracks/A", error);
            await page.evaluate(() => { fixture.state.music.mode = "home"; fixture.pending.push(fixture.page.loadMusic({ skipRoute: true }).catch(error => fixture.rejections.push(error.message))); }); await requested(old);
            const current = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "new");
            await launchRoute(page, { musicMode: "library", musicQuery: "new" }); await requested(current);
            await finishOld(page, old, ignoreAbort);
            assert.equal(await page.evaluate(() => fixture.state.music.current), null, "old automatic restore must not become the current song");
            assert.deepEqual(await listState(page), { query: "new", loading: true, loadingMore: false, status: "正在读取音乐库", count: 80 });
            assert.equal((await audioState(page)).loads, 0, "old automatic restore must not load Audio");
            await settle(page, current); assert.equal(await page.evaluate(() => fixture.state.music.data.tracks[0].id), "new-1");
          } finally { await page.close(); }
        });

        await run(`pending openPlayerStage close cancels continuation ${result} ${transport}`, async () => {
          const page = await newPage({ ignoreAbort });
          try {
            await page.evaluate(() => { fixture.state.music.queue = fixture.state.music.data.tracks; fixture.page.renderView(); });
            const old = hold(url => url.pathname === "/api/music/tracks/P", error);
            await page.locator(".music-player-identity").evaluate(element => element.click()); await requested(old); await page.keyboard.press("Escape"); await tick(page);
            assert.equal(await page.evaluate(() => fixture.state.music.openingTrackId), "", "Escape must cancel the pending expand intent before its track response");
            await finishOld(page, old, ignoreAbort); assert.equal(await page.locator(".music-track-page").count(), 0);
            assert.equal(await page.evaluate(() => fixture.state.music.current), null); assert.equal((await audioState(page)).loads, 0);
            assert.equal(new URL(page.url()).pathname, "/music/library");
          } finally { await page.close(); }
        });

        await run(`host saved A restoration yields to chosen B ${result} ${transport}`, async () => {
          const old = hold(url => url.pathname === "/api/music/tracks/A", error), current = hold(url => url.pathname === "/api/music/tracks/B");
          const page = await newPage({ real: true, ignoreAbort, route: "/music", saved: "A", waitReady: false });
          try {
            await requested(old); await navigateRoute(page, "/music/track/B"); await requested(current, 2000); await settle(page, current); await ready(page); await stageTitle(page, "Track B");
            await finishOld(page, old, ignoreAbort);
            assert.equal(new URL(page.url()).pathname, "/music/track/B"); assert.equal(await page.locator(".music-stage-meta h2").textContent(), "Track B");
            assert.match((await audioState(page)).src, /\/synthetic\/audio\/B$/); assert.equal((await audioState(page)).loads, 1);
            assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("fanhao.music.lastTrack")).trackId), "B");
          } finally { await page.close(); }
        });

        await run(`host close cancels background metadata and displays foreground tracks ${result} ${transport}`, async () => {
          const old = hold(url => url.pathname === "/api/music/tracks", error, { ...trackList(), tracks: [track("Old")], total: 1, hasMore: false });
          const page = await newPage({ real: true, ignoreAbort, route: "/music/track/P" });
          try {
            await requested(old); await stageTitle(page, "Track P"); await page.evaluate(async () => { await __audios[0].play(); __audios[0].currentTime = 42; });
            const before = await audioState(page), current = hold(url => url.pathname === "/api/music/tracks");
            await page.locator(".music-stage-close").evaluate(button => button.click()); await requested(current, 2000); await settle(page, current);
            await page.locator(".music-track-row:not(.head)").first().waitFor(); assert.equal(await page.locator(".music-track-row:not(.head)").count(), 120, "close must render the newly loaded foreground list");
            await page.evaluate(() => { __mountedFirstTrack = document.querySelector(".music-track-row:not(.head)"); });
            await finishOld(page, old, ignoreAbort);
            assert.equal(await page.evaluate(() => __mountedFirstTrack === document.querySelector(".music-track-row:not(.head)")), true, "obsolete background response must not replace the mounted current list");
            assert.equal(new URL(page.url()).pathname, "/music/library"); assert.equal(await page.locator(".music-track-page").count(), 0);
            assert.equal(await page.locator(".music-now-panel").getAttribute("data-music-track-id"), "P"); assert.deepEqual(await audioState(page), before);
            assert.deepEqual(await page.locator(".music-queue-row").evaluateAll(rows => rows.map(row => row.dataset.musicTrackId)), ["P"]);
            assert(!(await page.locator(".music-track-table").textContent()).includes("Track Old"));
          } finally { await page.close(); }
        });
      }

      await run(`side lists belong to newest selection ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          const oldPlaylist = hold(url => url.pathname === "/api/music/playlists", "", { playlists: [{ id: "old", name: "Old playlist" }] });
          const oldSmart = hold(url => url.pathname === "/api/music/smart-playlists", "", { smartPlaylists: [{ id: "old-smart", name: "Old smart" }] });
          await page.evaluate(() => { fixture.state.music.playlistsLoadedAt = 0; fixture.state.music.smartPlaylistsLoadedAt = 0; });
          await launchList(page, "old"); await requested(oldPlaylist); await requested(oldSmart);
          const newPlaylist = hold(url => url.pathname === "/api/music/playlists"), newSmart = hold(url => url.pathname === "/api/music/smart-playlists");
          await launchList(page, "new"); await requested(newPlaylist); await requested(newSmart); await settle(page, newPlaylist); await settle(page, newSmart);
          await page.waitForFunction(() => !fixture.state.music.loading);
          await finishOld(page, oldPlaylist, ignoreAbort); await finishOld(page, oldSmart, ignoreAbort);
          assert.deepEqual(await page.evaluate(() => [fixture.state.music.playlists.map(item => item.id), fixture.state.music.smartPlaylists.map(item => item.id)]), [["new"], ["new-smart"]]);
          assert(!(await page.locator(".music-sidebar.embedded").textContent()).includes("Old playlist"));
        } finally { await page.close(); }
      });

      await run(`same append shares selection and offset ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          const gate = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("offset") === "120"), before = countRequests(gate.match);
          await page.evaluate(() => { fixture.pending.push(fixture.page.loadMusic({ append: true, skipRoute: true, restoreLast: false })); fixture.pending.push(fixture.page.loadMusic({ append: true, skipRoute: true, restoreLast: false })); }); await requested(gate); await tick(page);
          assert.equal(countRequests(gate.match) - before, 1, "duplicate append must share the current selection/offset request");
          await settle(page, gate); assert.equal(await page.evaluate(() => fixture.state.music.data.tracks.length), 240);
          assert.equal(await page.evaluate(() => new Set(fixture.state.music.data.tracks.map(item => item.id)).size), 240);
        } finally { await page.close(); }
      });

      for (const chooseWhileAppending of [false, true]) await run(`search append replaces preferred cross-page format while playing ${chooseWhileAppending ? "with later selection " : ""}${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          await page.evaluate(() => fixture.page.openTrack("P", { autoplay: true, openPage: false }));
          await page.evaluate(() => { __audios[0].currentTime = 42; });
          let playing = await playbackState(page);
          const first = { ...track("same-mp3"), title: "Identical song", artist: "Synthetic Artist", fileName: "identical.mp3", hasLyrics: false, favorite: false, rating: 5, playCount: 19 };
          const second = { ...track("distinct"), title: "Distinct song", artist: "Synthetic Artist" };
          const preferred = { ...first, id: "same-flac", fileName: "identical.flac", codec: "flac", sampleRate: 96000, bitDepth: 24, streamUrl: "/synthetic/audio/same-flac", favorite: true, rating: 3, playCount: 2 };
          const firstPage = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "Synthetic" && !url.searchParams.has("offset"), "", { ...trackList(), tracks: [first, second], total: 4, hasMore: true });
          await page.evaluate(() => { fixture.state.music.query = "Synthetic"; fixture.pending.push(fixture.page.loadMusic({ skipRoute: true, keepCurrent: true, restoreLast: false })); });
          await requested(firstPage); await settle(page, firstPage); await page.waitForFunction(() => !fixture.state.music.loading);
          await page.evaluate(() => {
            __searchPlayerBar = document.querySelector(".music-player-bar"); __searchNowPanel = document.querySelector(".music-now-panel");
            const style = document.createElement("style"); style.textContent = ".music-track-panel{height:100px!important;max-height:100px!important;min-height:0!important;overflow-y:auto!important}"; document.head.append(style);
            document.querySelector(".music-track-panel").scrollTop = 30;
          });
          const scrollTop = await page.locator(".music-track-panel").evaluate(panel => panel.scrollTop); assert(scrollTop > 0, "the private search panel must have an actual scroll position");
          const next = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "Synthetic" && url.searchParams.get("offset") === "2", "", { ...trackList(), tracks: [preferred], total: 4, hasMore: true });
          await launchAppend(page); await requested(next);
          if (chooseWhileAppending) {
            await page.locator('.music-track-table [data-music-track-id="distinct"] .music-track-title').click();
            await page.waitForFunction(() => fixture.state.music.current?.id === "distinct");
            await page.evaluate(scrollTop => {
              __audios[0].currentTime = 42;
              __searchPlayerBar = document.querySelector(".music-player-bar"); __searchNowPanel = document.querySelector(".music-now-panel");
              document.querySelector(".music-track-panel").scrollTop = scrollTop;
            }, scrollTop);
            playing = await playbackState(page);
          }
          await settle(page, next); await page.waitForFunction(() => !fixture.state.music.loadingMore);
          assert.deepEqual(await page.evaluate(() => fixture.state.music.data.tracks.map(item => [item.id, item.duplicateCount || 1])), [["same-flac", 2], ["distinct", 1]]);
          assert.deepEqual(await page.evaluate(() => { const group = fixture.state.music.data.tracks[0]; return { duplicateIds: group.duplicateIds, favorite: group.favorite, rating: group.rating, playCount: group.playCount }; }),
            { duplicateIds: ["same-mp3", "same-flac"], favorite: true, rating: 5, playCount: 19 }, "cross-page representatives must aggregate metadata from all raw versions without scoring the aggregate as a member");
          await assertSearchDuplicateOracle(page);
          assert.deepEqual(await page.locator(".music-track-table .music-track-row:not(.head)").evaluateAll(rows => rows.map(row => row.dataset.musicTrackId)), ["same-flac", "distinct"], "search DOM must render merged preferred tracks, not incoming raw rows");
          assert.match(await page.locator('.music-track-table [data-music-track-id="same-flac"]').innerText(), /2 个版本/);
          assert.equal(await page.evaluate(() => fixture.state.music.data.rawLoaded), 3);
          assert.equal(await page.locator(".music-track-panel").evaluate(panel => panel.scrollTop), scrollTop, "merged search refresh must restore the previous panel scroll");
          assert.deepEqual(await playbackState(page), playing, "preferred search version must not replace the currently playing source or queue");
          assert.equal(await page.evaluate(() => __searchPlayerBar === document.querySelector(".music-player-bar") && __searchNowPanel === document.querySelector(".music-now-panel")), true, "search refresh must preserve mounted player surfaces");
          const last = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "Synthetic" && url.searchParams.get("offset") === "3", "", { ...trackList(), tracks: [track("tail")], total: 4, hasMore: false });
          await launchAppend(page); await requested(last); await settle(page, last); await page.waitForFunction(() => !fixture.state.music.loadingMore);
          assert.deepEqual(await page.locator(".music-track-table .music-track-row:not(.head)").evaluateAll(rows => rows.map(row => row.dataset.musicTrackId)), ["same-flac", "distinct", "tail"]);
          assert.equal(await page.evaluate(() => fixture.state.music.data.rawLoaded), 4); assert.deepEqual(await playbackState(page), playing);
          await assertSearchDuplicateOracle(page);
          assert.equal(await page.evaluate(() => __searchPlayerBar.isConnected && __searchNowPanel.isConnected), true);
        } finally { await page.close(); }
      });

      await run(`route cancels obsolete search and suggestion timers ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          const before = countRequests(url => ["/api/music/tracks", "/api/music/suggest"].includes(url.pathname));
          await page.evaluate(async () => {
            const input = document.querySelector('[data-music-search="library"]'); input.value = "old"; input.dispatchEvent(new Event("input", { bubbles: true }));
            const route = { musicMode: "library", musicTrackId: "B" }; history.replaceState(null, "", "/music/track/B"); fixture.page.applyRouteState(route); fixture.page.enter({ deferInitialLoad: true, skipRoute: true }); await fixture.page.openRouteTarget(route);
            await new Promise(resolve => setTimeout(resolve, 800));
          });
          assert.equal(countRequests(url => ["/api/music/tracks", "/api/music/suggest"].includes(url.pathname)), before, "obsolete debounce timers must not launch list or suggestions after navigation");
          assert.equal(new URL(page.url()).pathname, "/music/track/B"); assert.equal(await page.locator(".music-stage-meta h2").textContent(), "Track B");
          assert.deepEqual(await trackState(page), { current: "B", opening: "", status: "" });
        } finally { await page.close(); }
      });

      await run(`host initial saved A restores paused normally ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: "/music", saved: "A" });
        try {
          assert.equal(new URL(page.url()).pathname, "/music"); await library(page);
          assert.equal(await page.locator(".music-now-panel").getAttribute("data-music-track-id"), "A"); assert.equal(await page.locator(".music-now-info h3").textContent(), "Track A");
          assert.deepEqual(await audioState(page), { src: `${base}/synthetic/audio/A`, currentTime: 0, paused: true, loads: 1 });
        } finally { await page.close(); }
      });

      for (const target of ["/music/library", "/music/library?q=new", "/music/artist/artist-P"]) await run(`host playing P survives browse ${target} ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: "/music/track/P" });
        try {
          await stageTitle(page, "Track P"); await page.evaluate(async () => { await __audios[0].play(); __audios[0].currentTime = 42; });
          const before = await audioState(page); await navigateRoute(page, target); await library(page); await page.waitForFunction(() => !document.querySelector(".music-track-panel")?.hasAttribute("aria-busy"));
          assert.deepEqual(await audioState(page), before, "browse must preserve controlled Audio source, load count, time and playing state");
          assert.equal(await page.locator(".music-now-panel").getAttribute("data-music-track-id"), "P");
          assert.equal(await page.locator(".music-now-info h3").textContent(), "Track P");
          assert.deepEqual(await page.locator(".music-queue-row").evaluateAll(rows => rows.map(row => row.dataset.musicTrackId)), ["P"]);
          assert.equal(new URL(page.url()).pathname, new URL(target, base).pathname);
        } finally { await page.close(); }
      });

      await run(`probe playing lyrics and queue survive list search artist ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          await page.evaluate(() => fixture.page.openTrack("P", { autoplay: true, openPage: true })); await page.evaluate(() => { __audios[0].currentTime = 42; });
          const before = await playbackState(page);
          for (const route of [{ musicMode: "library" }, { musicMode: "library", musicQuery: "new" }, { musicMode: "library", musicArtistId: "artist-P" }]) {
            await page.evaluate(async route => { fixture.page.applyRouteState(route); fixture.page.enter({ deferInitialLoad: true, skipRoute: true }); await fixture.page.openRouteTarget(route); }, route);
            assert.deepEqual(await playbackState(page), before, "navigation must preserve current, lyrics, queue and controlled audio");
          }
        } finally { await page.close(); }
      });
    }
    assert(checks > 0, `no music fixture cases matched: ${casePattern}`); assert.deepEqual(faults, [], "Chromium page errors must not be hidden"); assert.deepEqual(unexpected, [], "fixture must only use modelled loopback endpoints and static sources");
    console.log(`Music reader fixture passed (${checks} cases; private Chromium, actual music host, controlled Audio without decoding)`); return { checks, browserRestarts };
  } finally { for (const gate of held) gate.release(); if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

  function countRequests(match) { return [...requests].filter(([url]) => match(new URL(url, base))).reduce((sum, [, count]) => sum + count, 0); }
  function countMethodRequests(method, pathname) { return methodRequests.filter(request => request.method === method && request.path === pathname).length; }
  async function verifyQueueSearch() {
    await run("queue search: complete local queue matches normalized title artist and album", async () => {
      const page = await newQueueSearchPage();
      try {
        const input = queueSearchInput(page);
        assert.equal(await input.count(), 1, "a long playing queue must provide local search beyond its rendered prefix");
        assert.equal(await page.locator('.music-queue-row[data-music-track-id="Q1901"]').count(), 0);
        const before = await playbackState(page), reads = countRequests(url => url.pathname.startsWith('/api/music/'));
        for (const [query, ids] of [['fullwidth hero', ['Q1901']], ['FAR ARTIST', ['Q1901']], ['far album', ['Q1901']], ['ALPHA', ['Q1902']], ['ｌａｓｔ ａｌｂｕｍ', ['Q2400']], ['No synthetic queue result', []]]) {
          await input.fill(query); await tick(page);
          assert.deepEqual(await queueSearchRowIds(page), ids, "queue search must match all tracks by normalized title, artist and album outside the rendered prefix");
          assert.deepEqual((await queueSearchNumbers(page)).slice(0, 2), [ids.length, 2400]);
        }
        await page.getByRole('button', { name: '清除队列查找', exact: true }).click();
        assert.equal(await input.inputValue(), ''); assert.equal(await page.locator('.music-queue-row').count(), 120);
        assert.deepEqual(await playbackState(page), before, "local queue filtering must preserve Audio at 42 seconds, current track and complete queue order");
        assert.equal(countRequests(url => url.pathname.startsWith('/api/music/')), reads, "typing and clearing queue search must issue zero music API requests");
      } finally { await page.close(); }
    });
    await run("queue search: matching results stay paged and clearing restores the prior window", async () => {
      const page = await newQueueSearchPage();
      try {
        await page.locator('.music-queue-load-more').click(); assert.equal(await page.locator('.music-queue-row').count(), 240);
        const original = await queueSearchRowIds(page), input = queueSearchInput(page), reads = countRequests(url => url.pathname.startsWith('/api/music/'));
        await input.fill('queued synthetic'); assert.equal(await page.locator('.music-queue-row').count(), 120, "a broad queue match must start with a bounded result page");
        assert.equal((await queueSearchNumbers(page))[0], 2396);
        assert.doesNotMatch(await page.locator('.music-queue-title small').textContent(), /已显示|全部/, "a filtered queue header must not show a conflicting unfiltered page window");
        assert.deepEqual(await page.evaluate(() => [fixture.state.music.queueExpanded, fixture.state.music.queueVisibleLimit]), [true, 240], "finding queue matches must not rewrite the underlying expanded queue window");
        await beginMusicRenderMeasurement(page);
        await page.evaluate(() => {
          window.__queueMoreRows = [...document.querySelectorAll('.music-queue-row')]; window.__queueMoreRemoved = 0;
          window.__queueMoreObserver = new MutationObserver(records => { for (const record of records) for (const node of record.removedNodes) {
            if (node.classList?.contains('music-queue-row')) __queueMoreRemoved++; __queueMoreRemoved += node.querySelectorAll?.('.music-queue-row').length || 0;
          } });
          __queueMoreObserver.observe(document.querySelector('.music-queue-list'), { childList: true, subtree: true });
        });
        const more = page.locator('.music-queue-load-more'); await more.focus(); await more.press('Enter');
        await tick(page);
        const creation = await endMusicRenderMeasurement(page), append = await page.evaluate(() => {
          __queueMoreObserver.disconnect(); return { retained: __queueMoreRows.filter(row => row.isConnected).length, removed: __queueMoreRemoved };
        });
        console.log('QUEUE_SEARCH_APPEND', JSON.stringify({ ...creation, ...append }));
        assert.equal(append.retained, 120, "appending queue matches must retain the existing matching song rows");
        assert.equal(append.removed, 0, "appending queue matches must not remove previously mounted result rows");
        assert(creation.elements <= 750 && creation.fullRenders === 0, "appending queue matches must only create the next bounded page and its continuation control");
        assert.equal(await page.locator('.music-queue-row').count(), 240);
        assert.match(await page.locator('.music-queue-search-count').textContent(), /已显示\s*240(?:\D|$)/, "the match status must report its current filtered page size");
        assert.equal(await page.locator('.music-queue-row').nth(120).locator('.music-queue-play').evaluate(node => node === document.activeElement), true,
          "loading more queue matches must focus the first appended matching song");
        await input.fill('fullwidth hero'); await page.getByRole('button', { name: '清除队列查找', exact: true }).click();
        assert.deepEqual(await queueSearchRowIds(page), original, "clearing queue search must restore the prior expanded page instead of truncating or expanding the queue");
        await page.locator('[data-music-queue-action="expand"]').click(); const preview = await queueSearchRowIds(page);
        await input.fill('fullwidth hero'); await page.getByRole('button', { name: '清除队列查找', exact: true }).click();
        assert.deepEqual(await queueSearchRowIds(page), preview, "clearing a queue lookup started from preview must restore that same preview");
        assert.equal(countRequests(url => url.pathname.startsWith('/api/music/')), reads);
      } finally { await page.close(); }
    });
    await run("queue search: narrow native keyboard and composition select only the explicit song", async () => {
      for (const candidateKey of ['Enter', 'Unidentified']) {
        const page = await newQueueSearchPage(320);
        try {
          const input = queueSearchInput(page), before = await audioState(page), reads = countRequests(url => url.pathname.startsWith('/api/music/'));
          const songReads = countRequests(url => url.pathname === '/api/music/tracks/Q1901');
          await input.fill('alpha');
          await input.evaluate((node, key) => {
            node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '候选' })); node.value = 'fullwidth hero';
            node.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, inputType: 'insertCompositionText', data: '候选' }));
            node.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, keyCode: 229, isComposing: true }));
          }, candidateKey);
          assert.deepEqual(await queueSearchRowIds(page), ['Q1902'], "queue composition must preserve its last accepted result set");
          await input.evaluate(node => {
            node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '候选' }));
            node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '候选' }));
            node.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          }); await tick(page);
          assert.equal(await input.evaluate(node => node === document.activeElement), true, "queue IME confirmation followed by submit must not move focus or start playback");
          assert.deepEqual(await queueSearchRowIds(page), ['Q1901']); assert.deepEqual(await audioState(page), before);
          assert.equal(countRequests(url => url.pathname.startsWith('/api/music/')), reads);
          await input.press('Tab'); assert.equal(await page.getByRole('button', { name: '清除队列查找', exact: true }).evaluate(node => node === document.activeElement), true);
          const clearBox = await page.getByRole('button', { name: '清除队列查找', exact: true }).evaluate(node => { const rect = node.getBoundingClientRect(), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            return { height: rect.height, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, hit: hit === node, hitClass: hit?.className }; });
          console.log('QUEUE_SEARCH_CLEAR_TARGET', JSON.stringify(clearBox));
          assert(clearBox.height >= 44 && clearBox.left >= 0 && clearBox.right <= clearBox.width && clearBox.hit, "the queue search clear button must fit completely inside the narrow viewport");
          await page.keyboard.press('Shift+Tab'); await input.press('Enter');
          const play = page.locator('.music-queue-row[data-music-track-id="Q1901"] .music-queue-play');
          assert.equal(await play.evaluate(node => node === document.activeElement), true, "queue search Enter must first focus the real matching song button");
          assert.deepEqual(await audioState(page), before);
          assert.equal(await input.evaluate(node => { const rect = node.getBoundingClientRect(); return rect.height >= 44 && rect.left >= 0 && rect.right <= innerWidth && node.closest('form').scrollWidth <= node.closest('form').clientWidth + 1
            && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === node; }), true, "the queue search input must be a visible 44px target on a narrow screen");
          const playBox = await play.evaluate(node => { const rect = node.getBoundingClientRect(), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            return { top: rect.top, bottom: rect.bottom, viewport: innerHeight, hit: hit?.closest('button') === node, hitClass: hit?.className,
              playerTop: document.querySelector('.music-player-bar').getBoundingClientRect().top }; });
          console.log('QUEUE_SEARCH_PLAY_TARGET', JSON.stringify(playBox));
          // Native nearest scrolling rounds offsets; retain the hit test while
          // allowing one CSS pixel at the viewport edge for physical rounding.
          assert(playBox.top >= -1 && playBox.bottom <= playBox.viewport + 1 && playBox.hit, "the focused matching queue song must be visible and unobstructed before playback");
          if (candidateKey === 'Enter') { const directory = path.join(root, '.codex-artifacts', 'music'); fs.mkdirSync(directory, { recursive: true }); await page.screenshot({ path: path.join(directory, 'queue-search-320.png') }); }
          await play.press('Enter'); await page.waitForFunction(() => fixture.state.music.current?.id === 'Q1901' && __audios[0].src.endsWith('/synthetic/audio/Q1901'));
          assert.equal(countRequests(url => url.pathname === '/api/music/tracks/Q1901') - songReads, 1, "one explicit matching-song activation must start exactly one detail read");
        } finally { await page.close(); }
      }
    });
    await run("queue search: filtered move and removal use full queue identities and boundaries", async () => {
      const page = await newQueueSearchPage();
      try {
        const input = queueSearchInput(page), audio = await audioState(page); await input.fill('fullwidth hero');
        const row = page.locator('.music-queue-row[data-music-track-id="Q1901"]');
        assert.equal(await row.getByRole('button', { name: '上移', exact: true }).isEnabled(), true, "the first filtered match is movable when it is not first in the complete queue");
        await row.getByRole('button', { name: '上移', exact: true }).press('Enter');
        assert.deepEqual(await page.evaluate(() => fixture.state.music.queue.slice(1899, 1902).map(item => item.id)), ['Q1901', 'Q1900', 'Q1902'],
          "a filtered move must swap its real full-queue neighbor rather than the previous visible match");
        await row.getByRole('button', { name: '移出队列', exact: true }).press('Space');
        assert.equal(await page.evaluate(() => fixture.state.music.queue.some(item => item.id === 'Q1901')), false);
        assert.equal(await page.evaluate(() => fixture.state.music.queue.length), 2399); assert.equal((await queueSearchRowIds(page)).length, 0);
        await input.fill('last album'); assert.equal(await page.locator('.music-queue-row[data-music-track-id="Q2400"]').getByRole('button', { name: '下移', exact: true }).isDisabled(), true);
        await input.fill('track p'); assert.equal(await page.locator('.music-queue-row[data-music-track-id="P"]').getByRole('button', { name: '移出队列', exact: true }).isDisabled(), true);
        assert.deepEqual(await audioState(page), audio);
      } finally { await page.close(); }
    });
    await run("queue search: saving and clearing act on the complete queue", async () => {
      queuePlaylistSaveEnabled = true; playlistState = new Map();
      const page = await newQueueSearchPage();
      const save = hold((url, method) => method === 'POST' && url.pathname === '/api/music/playlists');
      try {
        page.on('dialog', dialog => dialog.accept(dialog.type() === 'prompt' ? 'Synthetic queue snapshot' : undefined));
        const queue = await page.evaluate(() => fixture.state.music.queue.map(item => item.id)), audio = await audioState(page);
        await queueSearchInput(page).fill('fullwidth hero');
        assert((await page.locator('.music-queue-search-note').textContent()).includes('整个队列'));
        await page.locator('[data-music-queue-action="save"]').click(); await requested(save);
        assert.deepEqual(queuePlaylistSaves.at(-1).trackIds, queue, "saving a filtered queue must submit every full-queue song in its original order");
        await settle(page, save); await page.waitForFunction(() => fixture.state.music.mode === 'playlist' && fixture.state.music.activePlaylistId === 'queue-saved' && !fixture.state.music.loading);
        await queueSearchInput(page).fill('fullwidth hero'); await page.locator('[data-music-queue-action="clear"]').click(); await tick(page);
        assert.deepEqual(await page.evaluate(() => fixture.state.music.queue.map(item => item.id)), ['P'], "clearing a filtered queue must remove every noncurrent song, including hidden matches");
        assert.deepEqual(await audioState(page), audio);
      } finally { save.release(); await page.close(); playlistState = null; queuePlaylistSaveEnabled = false; }
    });
    await run("queue search: metadata membership and rollback retain the live composing input", async () => {
      for (const cause of ['metadata', 'membership', 'rollback', 'rollback dialog']) {
        let page, pending;
        try {
          const rollback = cause.startsWith('rollback');
          if (rollback) {
            playlistState = new Map([['new', { id: 'new', name: 'New playlist', description: '', trackIds: ['P', 'A', 'B'] }]]);
            page = await newPage();
            await page.evaluate(() => { fixture.state.music.mode = 'playlist'; fixture.state.music.activePlaylistId = 'new'; return fixture.page.loadMusic({ skipRoute: true, restoreLast: false }); });
            await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click(); await page.waitForFunction(() => fixture.state.music.current?.id === 'P'); await page.evaluate(() => { __audios[0].currentTime = 42; });
            pending = hold((url, method) => method === 'PUT' && url.pathname === '/api/music/playlists/new/tracks/order', 'Synthetic queue search order failure');
            await page.locator('.music-queue-row[data-music-track-id="B"]').getByRole('button', { name: '上移', exact: true }).click(); await requested(pending);
          } else page = await newQueueSearchPage();
          if (cause === 'metadata') {
            pending = hold((url, method) => method === 'POST' && url.pathname === '/api/music/tracks/P/favorite');
            pending.body = { track: { ...track('P'), title: 'Far current confirmed', favorite: true } };
            await page.locator('.music-now-panel .music-now-actions').getByRole('button', { name: '收藏', exact: true }).click(); await requested(pending);
          }
          const audio = await audioState(page), input = queueSearchInput(page), query = rollback ? 'track' : 'far'; await input.fill(query);
          if (cause === 'rollback dialog') {
            await page.locator('.music-now-panel .music-now-actions').getByRole('button', { name: '加入歌单', exact: true }).click(); await tick(page);
            const dialogInput = page.locator('.music-playlist-dialog input'); await dialogInput.fill('  Unsubmitted playlist  ');
            await dialogInput.evaluate(node => {
              node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '候选' })); node.setSelectionRange(2, 8);
              window.__queueDialogInput = node; window.__queueDialogChain = []; for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) __queueDialogChain.push(ancestor);
            });
          } else await captureQueueSearchEdit(page, rollback ? '  ＴＲＡＣＫ  ' : '  ＦＡＲ  ');
          if (cause === 'membership') await page.locator('.music-queue-row[data-music-track-id="Q1901"]').getByRole('button', { name: '移出队列', exact: true }).evaluate(node => node.click());
          else await settle(page, pending);
          if (cause === 'metadata') await page.waitForFunction(() => fixture.state.music.current?.title === 'Far current confirmed');
          if (rollback) await page.waitForFunction(() => fixture.state.music.queue.map(item => item.id).join(',') === 'P,A,B');
          await tick(page);
          if (cause === 'rollback dialog') assert.deepEqual(await page.locator('.music-playlist-dialog input').evaluate(node => [node === __queueDialogInput, __queueDialogChain.every(ancestor => ancestor.isConnected), node === document.activeElement, node.value, node.selectionStart, node.selectionEnd]),
            [true, true, true, '  Unsubmitted playlist  ', 2, 8], "a background queue rollback must preserve a newer playlist dialog's live composing input and focus");
          else await assertQueueSearchEdit(page);
          const ids = cause === 'metadata' ? ['P', 'Q1901'] : cause === 'membership' ? [] : ['P', 'A', 'B'];
          assert.deepEqual(await queueSearchRowIds(page), ids, "queue search results must reflect current metadata, membership and accepted rollback order");
          assert.deepEqual(await audioState(page), audio);
        } finally { pending?.release(); if (page) await page.close(); playlistState = null; }
      }
    });
    await run("queue search: old controls and late playback yield to new route account and focus", async () => {
      for (const destination of ['route', 'account', 'new focus']) {
        const page = await newQueueSearchPage(); let detail;
        try {
          const input = queueSearchInput(page); await input.fill('fullwidth hero');
          await page.evaluate(() => { window.__retiredQueueForm = document.querySelector('.music-queue-search'); window.__retiredQueueRow = document.querySelector('.music-queue-row[data-music-track-id="Q1901"]'); });
          if (destination === 'new focus') {
            detail = hold(url => url.pathname === '/api/music/tracks/Q1901'); await page.locator('.music-queue-row[data-music-track-id="Q1901"] .music-queue-play').click(); await requested(detail);
            const external = page.locator('.music-search input'); await external.focus(); await settle(page, detail);
            await page.waitForFunction(() => fixture.state.music.current?.id === 'Q1901');
            assert.equal(await external.evaluate(node => node === document.activeElement), true, "a delayed matching-song read must respect a newer external focus");
            continue;
          }
          if (destination === 'route') await page.getByRole('button', { name: '打开当前歌曲播放页', exact: true }).click();
          else await page.evaluate(() => { window.__queueAccountOwner = __fanhaoWebAccountContext.owner; __fanhaoWebAccountContext.owner = 'new-queue-search-owner'; });
          const external = destination === 'route' ? page.locator('.music-stage-player').getByRole('button', { name: '暂停', exact: true }) : page.locator('.music-search input'); await external.focus();
          const before = await playbackState(page), route = page.url(), reads = countRequests(url => url.pathname.startsWith('/api/music/'));
          await page.evaluate(() => {
            const input = __retiredQueueForm.querySelector('input'); input.value = 'obsolete'; input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
            input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' }));
            __retiredQueueForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); __retiredQueueForm.querySelector('button').click();
            __retiredQueueRow.querySelector('.music-queue-play').click(); __retiredQueueRow.querySelector('[aria-label="上移"]').click(); __retiredQueueRow.querySelector('[aria-label="移出队列"]').click();
          }); await tick(page);
          assert.deepEqual(await playbackState(page), before, "retired or old-account queue search controls must not play, reorder or remove songs");
          assert.equal(page.url(), route); assert.equal(await external.evaluate(node => node === document.activeElement), true);
          assert.equal(countRequests(url => url.pathname.startsWith('/api/music/')), reads);
        } finally { detail?.release(); await page.evaluate(() => { if (window.__queueAccountOwner !== undefined) __fanhaoWebAccountContext.owner = __queueAccountOwner; }); await page.close(); }
      }
    });
  }
  function playlistSummary(playlist) { return { id: playlist.id, name: playlist.name, description: playlist.description, trackCount: playlist.trackIds.length }; }
  function playlistDetail(id) {
    const playlist = playlistState.get(id);
    return playlist ? { playlist: playlistSummary(playlist), tracks: playlist.trackIds.map(track), total: playlist.trackIds.length, summary: summary(), artists: artists(), albums: albums(), genres: [] } : null;
  }
  function playlistMutationSpec(operation) {
    return {
      edit: { method: "PUT", path: "/api/music/playlists/new", body: { name: "Renamed playlist", description: "Edited in fixture" } },
      add: { method: "POST", path: "/api/music/playlists/new/tracks", body: { trackId: "B" } },
      remove: { method: "DELETE", path: "/api/music/playlists/new/tracks/P", body: null },
      delete: { method: "DELETE", path: "/api/music/playlists/new", body: null },
    }[operation];
  }
  async function newPlaylistPage(operation, ignoreAbort) {
    const requestStart = methodRequests.length, faultStart = faults.length, unexpectedStart = unexpected.length;
    playlistState = new Map([
      ["new", { id: "new", name: "New playlist", description: "Original description", trackIds: ["P", "A"] }],
      ["other", { id: "other", name: "Other playlist", description: "Other description", trackIds: ["B"] }],
    ]);
    let page, phase = "create-page";
    try {
      page = await newPage({ real: true, ignoreAbort, route: operation === "add" ? "/music/library" : "/music/playlist/new" });
      const id = operation === "add" ? "B" : "P";
      phase = `click-track-${id}`;
      await page.locator(`.music-track-table [data-music-track-id="${id}"] .music-track-title`).click();
      phase = "wait-current-track";
      await page.waitForFunction(id => document.querySelector(".music-now-panel")?.dataset.musicTrackId === id, id);
      phase = "wait-controlled-audio";
      await page.waitForFunction(id => __audios[0]?.src.endsWith(`/synthetic/audio/${id}`) && !__audios[0].paused, id);
      await page.evaluate(() => { __audios[0].currentTime = 42; });
      return page;
    } catch (error) {
      let timer, documentState = "page unavailable";
      if (page && !page.isClosed()) {
        try {
          documentState = await Promise.race([page.evaluate(() => ({ url: location.href, readyState: document.readyState,
            classes: document.documentElement.className, bodyClasses: document.body?.className,
            headings: [...document.querySelectorAll('.music-panel-heading strong')].slice(0, 3).map(node => node.textContent.slice(0, 160)),
            errors: [...document.querySelectorAll('.music-status, .music-error, .music-list-read-error, [role="alert"]')].slice(0, 4).map(node => node.textContent.slice(0, 300)),
            tracks: [...document.querySelectorAll('.music-track-table .music-track-row:not(.head)')].slice(0, 10).map(node => node.dataset.musicTrackId),
            text: document.body?.textContent.slice(0, 600)
          })), new Promise(resolve => { timer = setTimeout(() => resolve("renderer diagnostic unavailable"), 1000); })]);
        } catch (diagnosticError) { documentState = `diagnostic failed: ${diagnosticError.message.slice(0, 200)}`; }
        finally { clearTimeout(timer); }
      }
      const pendingGates = [...held].filter(gate => !gate.used || (!gate.finished && !gate.closed));
      console.error("MUSIC_PLAYLIST_FIXTURE_FAILURE", JSON.stringify({ operation, ignoreAbort, phase, documentState,
        requests: methodRequests.slice(requestStart).filter(request => request.path.startsWith('/api/')).slice(-20),
        startup: (pageStartupFailures.get(page) || []).slice(-8), faults: faults.slice(faultStart, faultStart + 8), unexpected: unexpected.slice(unexpectedStart, unexpectedStart + 8),
        serverPlaylists: [...(playlistState?.values() || [])].slice(0, 3).map(playlist => ({ id: playlist.id, tracks: playlist.trackIds.slice(0, 10) })),
        pendingGateCount: pendingGates.length, gates: pendingGates.slice(-12).map(gate => ({ match: String(gate.match).slice(0, 240), url: gate.url,
          used: gate.used, released: gate.released, finished: Boolean(gate.finished), closed: gate.closed,
          error: String(gate.error || "").slice(0, 160), bodyKeys: gate.body ? Object.keys(gate.body).slice(0, 8) : [] })) }));
      if (page && !page.isClosed()) await page.close().catch(() => {});
      throw error;
    }
  }
  async function clickPlaylistMutation(page, operation) {
    if (operation === "edit") {
      const answers = ["Renamed playlist", "Edited in fixture"];
      const answer = dialog => dialog.accept(answers.shift());
      page.on("dialog", answer);
      try { await page.locator(".music-panel-actions").getByRole("button", { name: "编辑", exact: true }).click(); }
      finally { page.off("dialog", answer); }
      assert.equal(answers.length, 0, "edit must ask for name and description");
    } else if (operation === "delete") {
      page.once("dialog", dialog => dialog.accept());
      await page.locator(".music-panel-actions").getByRole("button", { name: "删除歌单", exact: true }).click();
    } else if (operation === "remove") {
      await page.locator(".music-now-panel").getByRole("button", { name: "移出歌单", exact: true }).click();
    } else {
      await page.locator(".music-now-panel").getByRole("button", { name: "加入歌单", exact: true }).click();
      await page.locator(".music-playlist-choice").filter({ hasText: "New playlist" }).click();
    }
  }
  function assertPlaylistMutationApplied(operation) {
    if (operation === "delete") assert.equal(playlistState.has("new"), false);
    else if (operation === "edit") assert.equal(playlistState.get("new").name, "Renamed playlist");
    else assert.deepEqual(playlistState.get("new").trackIds, operation === "add" ? ["P", "A", "B"] : ["A"]);
  }
  async function assertCurrentPlaylistMutation(page, operation) {
    if (operation === "edit") {
      await page.waitForFunction(() => document.querySelector(".music-panel-heading strong")?.textContent === "Renamed playlist");
      assert.equal(new URL(page.url()).pathname, "/music/playlist/new");
      assert.deepEqual(await visiblePlaylistTracks(page), ["P", "A"]);
    } else if (operation === "remove") {
      await page.waitForFunction(() => [...document.querySelectorAll(".music-track-table .music-track-row:not(.head)")].map(row => row.dataset.musicTrackId).join(",") === "A");
      assert.equal(new URL(page.url()).pathname, "/music/playlist/new");
    } else if (operation === "delete") {
      await page.waitForURL(`${base}/music/library`);
      await page.waitForFunction(() => !document.querySelector(".music-track-panel")?.hasAttribute("aria-busy"));
      assert.deepEqual((await visiblePlaylistTracks(page)).slice(0, 3), ["P", "A", "B"]);
      assert(!(await page.locator(".music-sidebar.embedded").textContent()).includes("New playlist"));
    } else {
      await page.waitForFunction(() => [...document.querySelectorAll(".music-sidebar.embedded .music-playlist-list button")].some(button => button.textContent.includes("New playlist") && button.textContent.includes("3")));
      assert.equal(new URL(page.url()).pathname, "/music/library");
      assert.deepEqual((await visiblePlaylistTracks(page)).slice(0, 3), ["P", "A", "B"]);
      assert.equal(await page.locator(".music-playlist-dialog").count(), 0);
    }
  }
  async function verifySearchDuplicateSessions() {
    await run('search append confirmed writes preserve raw metadata and current playback', async () => {
      for (const ignoreAbort of [true, false]) for (const field of ['favorite', 'rating']) {
        const primary = { ...track('same-flac'), title: 'Confirmed duplicate song', artist: 'Synthetic Artist', fileName: 'same.flac', codec: 'flac', bitDepth: 24, sampleRate: 96000, favorite: false, rating: 0, playCount: 3 };
        const other = { ...primary, id: 'same-mp3', fileName: 'same.mp3', codec: 'mp3', bitDepth: 0, sampleRate: 44100, playCount: 7 };
        const raw = field === 'rating' ? [primary, other, null] : [primary, other];
        const first = hold(url => url.pathname === '/api/music/tracks' && url.searchParams.get('q') === 'Synthetic' && !url.searchParams.has('offset'), '', { ...trackList(), tracks: raw, total: raw.length + 2, hasMore: true });
        const page = await newPage({ ignoreAbort });
        const metadata = hold(url => url.pathname === '/api/music/tracks/same-flac', '', { track: primary, lyrics: lyrics('same-flac'), prevId: '', nextId: '' });
        const confirmed = field === 'favorite' ? true : 5;
        const write = hold((url, method) => method === 'POST' && url.pathname === '/api/music/tracks/same-flac/' + field, '', { track: { ...primary, [field]: confirmed } });
        const seed = hold(url => url.pathname === '/api/music/tracks' && url.searchParams.get('q') === 'Synthetic' && url.searchParams.get('offset') === String(raw.length), '', { ...trackList(), tracks: [track('seed-tail')], total: raw.length + 2, hasMore: true });
        const next = hold(url => url.pathname === '/api/music/tracks' && url.searchParams.get('q') === 'Synthetic' && url.searchParams.get('offset') === String(raw.length + 1), '', { ...trackList(), tracks: [track('tail')], total: raw.length + 2, hasMore: false });
        try {
          await page.locator('[data-music-search="library"]').fill('Synthetic'); await requested(first); await settle(page, first);
          await page.waitForFunction(() => !fixture.state.music.loading && fixture.state.music.data.tracks.length === 1);
          assert.equal(await page.evaluate(() => fixture.state.music.data.tracks[0].duplicateCount), 2);
          assert.equal(await page.evaluate(() => fixture.state.music.data.tracks[0] === fixture.state.music.data.rawTracks[0]), false);
          await page.locator('.music-track-table [data-music-track-id="same-flac"] .music-track-title').click(); await requested(metadata); await settle(page, metadata);
          await page.waitForFunction(() => fixture.state.music.current?.id === 'same-flac' && !__audios[0].paused);
          await page.evaluate(() => { __audios[0].currentTime = 42; });
          const playing = await playbackState(page);
          // Warm the actual search accumulator before mutating a raw member.
          await page.locator('.music-load-more').click(); await requested(seed); await settle(page, seed);
          await page.waitForFunction(() => !fixture.state.music.loadingMore);
          await page.locator('.music-player-bar').getByRole('button', { name: field === 'favorite' ? '收藏' : '设为 5 星', exact: true }).click();
          await requested(write); await settle(page, write);
          await page.waitForFunction(({ field, confirmed }) => fixture.state.music.data.tracks[0][field] === confirmed, { field, confirmed });
          const rawValue = await page.evaluate(field => fixture.state.music.data.rawTracks.find(track => track?.id === 'same-flac')[field], field);
          assert.equal(rawValue, confirmed, 'a confirmed search metadata write must update its matching raw member before another append');
          await page.locator('.music-load-more').click(); await requested(next); await settle(page, next);
          await page.waitForFunction(() => !fixture.state.music.loadingMore);
          assert.equal(await page.evaluate(field => fixture.state.music.data.tracks[0][field], field), confirmed, 'a confirmed duplicate-group metadata write must survive appending an unrelated page');
          assert.equal(await page.evaluate(() => fixture.state.music.data.rawLoaded), raw.length + 2, 'search offsets must consume raw rows including null entries instead of displayed groups');
          if (field === 'rating') {
            assert.equal(await page.evaluate(() => fixture.state.music.data.rawTracks.filter(track => track === null).length), 1);
            assert((await page.locator('.music-track-table [data-music-track-id="same-flac"]').innerText()).includes('★★★★★'));
          }
          await assertSearchDuplicateOracle(page); assert.deepEqual(await playbackState(page), playing, 'metadata confirmation and later search append must preserve the current source, queue and 42-second position');
        } finally { for (const gate of [first, metadata, write, seed, next]) { gate.release(); held.delete(gate); } await page.close(); }
      }
    });
    await run('search append sessions retire older queries and restore uncollapsed lists', async () => {
      for (const ignoreAbort of [true, false]) {
        const page = await newPage({ ignoreAbort }), gates = [];
        const member = (id, preferred = false) => ({ ...track(id), title: 'Shared AB song', artist: 'Synthetic AB Artist', fileName: id + (preferred ? '.flac' : '.mp3'), codec: preferred ? 'flac' : 'mp3', favorite: false, rating: 0 });
        const read = async (query, incoming, { offset = null, hasMore = true } = {}) => {
          const gate = hold(url => url.pathname === '/api/music/tracks' && (url.searchParams.get('q') || '') === query
            && (offset === null ? !url.searchParams.has('offset') : url.searchParams.get('offset') === String(offset)), '', { ...trackList(), tracks: incoming, total: offset === null ? incoming.length + 3 : offset + incoming.length + Number(hasMore), hasMore });
          gates.push(gate);
          if (offset === null) await page.locator('[data-music-search="library"]').fill(query); else await page.locator('.music-load-more').click();
          await requested(gate); await settle(page, gate); await page.waitForFunction(() => !fixture.state.music.loading && !fixture.state.music.loadingMore); return gate;
        };
        try {
          await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click();
          await page.waitForFunction(() => fixture.state.music.current?.id === 'P' && !__audios[0].paused);
          await page.evaluate(() => { __audios[0].currentTime = 42; }); const playing = await playbackState(page);
          await read('A', [member('A1'), member('A2')]); await read('A', [member('A3', true)], { offset: 2 });
          const old = hold(url => url.pathname === '/api/music/tracks' && url.searchParams.get('q') === 'A' && url.searchParams.get('offset') === '3', '', { ...trackList(), tracks: [member('obsolete-A')], total: 4, hasMore: false }); gates.push(old);
          await page.locator('.music-load-more').click(); await requested(old);
          await read('B', [member('B1'), member('B2')]); await finishOld(page, old, ignoreAbort);
          await read('B', [member('B3', true)], { offset: 2, hasMore: false });
          assert.deepEqual(await page.evaluate(() => fixture.state.music.data.tracks[0].duplicateIds), ['B1', 'B2', 'B3'], 'an obsolete search append must not pollute a new same-key group');
          assert.equal(await page.evaluate(() => fixture.state.music.data.rawLoaded), 3); await assertSearchDuplicateOracle(page);
          await read('', [member('plain1'), member('plain2')], { hasMore: false });
          assert.deepEqual(await page.evaluate(() => fixture.state.music.data.tracks.map(track => track.id)), ['plain1', 'plain2'], 'clearing search must restore the raw list rather than reuse deduplicated search groups');
          await read('C', [member('C1'), member('C2')]); await read('C', [member('C3', true)], { offset: 2, hasMore: false });
          assert.deepEqual(await page.evaluate(() => fixture.state.music.data.tracks[0].duplicateIds), ['C1', 'C2', 'C3']);
          await assertSearchDuplicateOracle(page); assert.deepEqual(await playbackState(page), playing);
        } finally { for (const gate of gates) { gate.release(); held.delete(gate); } await page.close(); }
      }
    });
  }
  function hold(match, error = "", body = null) {
    let release, requestedResolve; const gate = { match, error, body, used: false, released: false, closed: false, promise: new Promise(resolve => { release = resolve; }), requested: new Promise(resolve => { requestedResolve = resolve; }), release: () => { gate.released = true; release(); }, requestedResolve }; held.add(gate); return gate;
  }
  async function requested(gate, timeout = 5000) { let timer; try { await Promise.race([gate.requested, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`new request did not start before obsolete I/O finished (${timeout}ms)`)), timeout); })]); } finally { clearTimeout(timer); } }
  async function settle(page, gate) { const identity = { url: gate.url, method: gate.method }; const before = await page.evaluate(({ url, method }) => __transport.settled.filter(item => item.url === url && item.method === method).length, identity); gate.release(); await page.waitForFunction(({ url, method, before }) => __transport.settled.filter(item => item.url === url && item.method === method).length > before, { ...identity, before }, { timeout: 5000 }); await tick(page); }
  async function finishOld(page, gate, ignoreAbort) { if (ignoreAbort) await settle(page, gate); else { await until(() => gate.closed, "normal transport must close the obsolete request"); gate.release(); await tick(page); } }
  async function newComponentPage(ignoreAbort, touch = false) {
    const page = await newPage({ ignoreAbort, touch });
    await page.evaluate(async () => {
      const { createComponents } = await import("/modules/music/views/components.js");
      window.__componentCalls = [];
      const track = { id: "component-track", title: "Synthetic component", artist: "Fixture", durationMs: 10000 };
      const components = createComponents({
        music: fixture.state.music,
        actions: {
          async openTrackFromList(item, list, options) { if (item !== track || !Array.isArray(list) || options.autoplay !== true) throw new Error("invalid component play arguments"); __componentCalls.push("play"); },
          queueTrackNext(item) { if (item !== track) throw new Error("invalid component next track"); __componentCalls.push("next"); },
          appendTrackToQueue(item) { if (item !== track) throw new Error("invalid component appended track"); __componentCalls.push("append"); },
          downloadTrack(item) { if (item !== track) throw new Error("invalid component download track"); __componentCalls.push("download"); }
        },
        formatNumber: String, showError(error) { throw error; },
        registerMusicTrackElement() {}, registerCurrentTrackIndicator() {}, registerPlaybackButton() {}
      });
      const row = components.trackRow(track, 0);
      row.setAttribute("data-component-track-row", "");
      document.querySelector("#workGrid").replaceChildren(row);
    });
    return page;
  }
  async function newRatingPage(initial = 0) {
    ratingValues.set("A", initial); ratingValues.delete("B");
    const page = await newPage();
    await page.locator('.music-track-table [data-music-track-id="A"] .music-track-title').click();
    await page.waitForFunction(() => fixture.state.music.current?.id === "A" && !__audios[0].paused);
    return page;
  }
  async function newListRecoveryPage(ignoreAbort, real = false) {
    const page = await newPage({ ignoreAbort, real });
    const failed = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("q") === "Recovery", "Synthetic initial recovery failure");
    try {
      await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click(); await page.waitForFunction(() => __audios[0]?.src.endsWith("/synthetic/audio/P") && !__audios[0].paused);
      await page.evaluate(() => { __audios[0].currentTime = 42; });
      await page.locator('[data-music-search="library"]').fill("Recovery"); await requested(failed); await settle(page, failed);
      assert.equal(await page.locator(".music-list-retry").count(), 1, "a current list failure must have its own recovery action");
      return page;
    } catch (error) { await page.close(); throw error; }
    finally { failed.release(); held.delete(failed); }
  }
  async function newCurrentContextPage(ignoreAbort, overrides = {}, real = false) {
    const page = await newPage({ ignoreAbort, real }), current = { ...currentContextTrack(), ...overrides };
    const detail = hold(url => url.pathname === "/api/music/tracks/P", "", { track: current, lyrics: lyrics("P"), prevId: "", nextId: "" });
    try {
      await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click(); await requested(detail); await settle(page, detail);
      await page.waitForFunction(() => __audios[0]?.src.endsWith("/synthetic/audio/P") && !__audios[0].paused); await page.evaluate(() => { __audios[0].currentTime = 42; });
      await page.getByRole("button", { name: "打开当前歌曲播放页", exact: true }).click();
      return { page, current };
    } catch (error) { await page.close(); throw error; }
    finally { detail.release(); held.delete(detail); }
  }
  async function newDrawerPage(width = 320) {
    const page = await newPage({ real: true });
    try {
      await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click();
      await page.waitForFunction(() => __audios[0]?.src.endsWith("/synthetic/audio/P") && !__audios[0].paused);
      await page.evaluate(() => { __audios[0].currentTime = 42; });
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole("button", { name: "打开音乐资料库", exact: true }).click();
      return page;
    } catch (error) { await page.close(); throw error; }
  }
  async function newAlphabetPage(mode, width) {
    const page = await newPage({ real: true, touch: width === 320 });
    const data = { [mode]: mode === "artists" ? [{ id: "needle", name: "Needle artist", language: "Fixture", trackCount: 1, albumCount: 1 }]
      : [{ id: "needle", title: "Needle album", artistName: "Fixture artist", trackCount: 1 }], total: 1, hasMore: false,
      languages: [{ name: "Fixture", artistCount: 1, albumCount: 1 }], summary: summary() };
    const initial = hold(url => url.pathname === `/api/music/${mode}` && url.searchParams.get("q") === "Needle", "", data);
    try {
      await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click();
      await page.waitForFunction(() => __audios[0]?.src.endsWith("/synthetic/audio/P") && !__audios[0].paused); await page.evaluate(() => { __audios[0].currentTime = 42; });
      await navigateRoute(page, `/music/${mode}?q=Needle&language=Fixture&sort=${mode === "artists" ? "name" : "year"}`); await requested(initial); await settle(page, initial);
      await page.setViewportSize({ width, height: 900 });
      return { page, data };
    } catch (error) { await page.close(); throw error; }
    finally { initial.release(); held.delete(initial); }
  }
  async function newMoreKeyboardPage(mode, { width = 1440, data = null, query = "" } = {}) {
    const page = await newPage({ real: true });
    const firstCount = mode === "library" ? data?.tracks.length || 120 : 80, endpoint = `/api/music/${mode === "library" ? "tracks" : mode}`;
    const rows = mode === "library" ? ".music-track-table .music-track-row:not(.head)" : mode === "artists" ? ".music-artist-browser-card" : ".music-album-browser-card";
    let initial;
    try {
      await startPausedSortAudio(page);
      if (mode !== "library" || data) {
        initial = hold(url => url.pathname === endpoint && !url.searchParams.has("offset"), "", data || moreKeyboardData(mode, 0, firstCount, true));
        await navigateRoute(page, `/music/${mode}${query ? `?q=${encodeURIComponent(query)}` : ""}`); await requested(initial); await settle(page, initial);
      }
      await page.setViewportSize({ width, height: 900 });
      return { page, firstCount, endpoint, rows };
    } catch (error) { await page.close(); throw error; }
    finally { if (initial) { initial.release(); held.delete(initial); } }
  }
  async function openKeyboardPlaylistDialog(page, keyboard = false) {
    const read = hold((url, method) => method === "GET" && url.pathname === "/api/music/playlists");
    const opening = page.locator(".music-now-panel").getByRole("button", { name: "加入歌单", exact: true });
    try {
      if (keyboard) { await opening.focus(); await opening.press("Enter"); } else await opening.click();
      await requested(read); await settle(page, read);
      await page.waitForFunction(() => document.activeElement?.matches(".music-playlist-dialog-form input")); await tick(page);
      return opening;
    } finally { read.release(); }
  }
  async function clickRating(page, value) { await page.locator(".music-rating.now").getByRole("button", { name: value ? `设为 ${value} 星` : "清除评分", exact: true }).click(); }
  async function waitRating(page, id, value) {
    for (let attempt = 0; attempt < 50 && ratingValues.get(id) !== value; attempt++) await page.waitForTimeout(20);
    assert.equal(ratingValues.get(id), value, "the backend must retain the final successful rating");
    await page.waitForFunction(({ id, value }) => fixture.state.music.current?.id === id && fixture.state.music.current.rating === value, { id, value });
  }
  async function newLyricFindPage(ignoreAbort, width = 1440, lines = null, raw = "") {
    const lyricLines = lines || Array.from({ length: 240 }, (_, index) => ({ timeMs: index * 2000, text: [3, 150, 230].includes(index) ? `Needle lyric ${index}` : `Synthetic lyric ${index}` }));
    const durationMs = Math.max(600000, Number(lyricLines.at(-1)?.timeMs || 0) + 120000);
    const page = await newPage({ ignoreAbort });
    await page.setViewportSize({ width, height: 900 });
    const detail = hold(url => url.pathname === "/api/music/tracks/A", "", { track: { ...track("A"), durationMs }, lyrics: { raw, lines: lyricLines }, prevId: "", nextId: "" });
    try {
      await page.locator('.music-track-table [data-music-track-id="A"] .music-track-title').click(); await requested(detail); detail.release();
      await page.waitForFunction(() => fixture.state.music.current?.id === "A" && !__audios[0].paused);
      await page.evaluate(durationMs => { __audios[0].duration = durationMs / 1000; __audios[0].currentTime = 42; }, durationMs);
      await page.getByRole("button", { name: "打开当前歌曲播放页", exact: true }).click();
      await page.locator(".music-stage-lyrics").waitFor({ state: "visible" });
      return page;
    } finally { detail.release(); }
  }
  async function assertVisibleLyric(page, index) {
    const visibility = await page.locator(`.music-lyric-lines [data-index="${index}"]`).evaluate(row => {
      const viewport = row.closest(".music-lyric-lines"), content = row.closest(".music-stage-content");
      const rect = row.getBoundingClientRect(), box = viewport.getBoundingClientRect(), clip = content.getBoundingClientRect();
      const player = document.querySelector(".music-stage-player").getBoundingClientRect();
      const top = Math.max(0, box.top, clip.top), bottom = Math.min(innerHeight, box.bottom, clip.bottom, player.top);
      return { visible: rect.top >= top - 1 && rect.bottom <= bottom + 1 && rect.height > 0, rowTop: rect.top, rowBottom: rect.bottom, top, bottom, scrollTop: viewport.scrollTop };
    });
    assert(visibility.visible, `paragraph lyric ${index} must be fully visible above the player and within its viewport: ${JSON.stringify(visibility)}`);
  }
  async function newLongQueuePage(ignoreAbort, width, { all = true, playing = true, queueSearchShell = false } = {}) {
    const page = await newPage({ ignoreAbort, queueSearchShell });
    await page.setViewportSize({ width, height: 900 });
    await page.locator(".music-track-panel .music-load-more").click();
    await page.waitForFunction(() => fixture.state.music.data.tracks.length === 240);
    if (width < 500) await page.evaluate(() => {
      fixture.state.music.data.tracks = fixture.state.music.data.tracks.map(item => ({ ...item, title: `${item.title} · ${"Synthetic long title 长标题 ".repeat(12)}` }));
      fixture.page.renderView();
    });
    if (playing) {
      await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click();
      await page.waitForFunction(() => __audios[0]?.src.endsWith("/synthetic/audio/P") && !__audios[0].paused);
      await page.evaluate(() => { __audios[0].currentTime = 42; });
    } else await page.evaluate(() => { fixture.state.music.queue = [...fixture.state.music.data.tracks]; fixture.page.renderView(); });
    await page.locator(".music-queue").getByRole("button", { name: "全部", exact: true }).click();
    if (all) await page.locator(".music-queue-load-more").click();
    return page;
  }
  async function newQueueSearchPage(width = 1440) {
    const page = await newLongQueuePage(true, width, { all: false, queueSearchShell: true });
    await page.evaluate(() => {
      const music = fixture.state.music;
      music.queue = Array.from({ length: 2400 }, (_, index) => index ? { ...music.current, id: `Q${index + 1}`, title: `Queued synthetic ${index + 1}`, artist: `Queue Artist ${index + 1}`, album: `Collection ${index + 1}`, streamUrl: `/synthetic/audio/Q${index + 1}` } : music.current);
      Object.assign(music.queue[1900], { title: 'ＦｕｌｌＷｉｄｔｈ Ｈｅｒｏ', artist: 'Far Artist', album: 'Far Album' });
      Object.assign(music.queue[1901], { title: 'aLpHa Finale', artist: 'Other singer', album: 'End collection' });
      Object.assign(music.queue[2399], { title: 'Last queue item', artist: 'Last Artist', album: 'Last Album' });
      music.queueExpanded = true; music.queueVisibleLimit = 120; fixture.page.renderView();
    });
    await tick(page); return page;
  }
  async function newPage({ real = false, ignoreAbort = true, route = "/music/library", waitReady = true, initialBack = false, saved = "", touch = false, queueSearchShell = false } = {}) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, hasTouch: touch }); page.on("pageerror", error => faults.push(error.message));
    browserPages++; totalBrowserPages++;
    const moduleRequestsAtStart = musicModuleRequests;
    const startupFailures = [], startupFaults = faults.length;
    const recordStartupFailure = entry => { startupFailures.push(entry); if (startupFailures.length > 8) startupFailures.shift(); };
    pageStartupFailures.set(page, startupFailures);
    page.on("requestfailed", request => recordStartupFailure({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }));
    page.on("console", message => { if (message.type() === "error") recordStartupFailure({ console: message.text().slice(0, 250) }); });
    await page.addInitScript(({ ignoreAbort, initialBack, saved }) => {
      window.__documentToken = Math.random(); window.__transport = { settled: [], aborted: [] }; window.__audios = [];
      class ControlledAudio extends EventTarget {
        constructor() { super(); this.src = ""; this.paused = true; this.currentTime = 0; this.duration = 180; this.loads = 0; this.volume = .82; this.playbackRate = 1; this.readyState = 4; this.preload = "metadata"; __audios.push(this); }
        load() { this.loads++; this.currentTime = 0; this.paused = true; queueMicrotask(() => this.dispatchEvent(new Event("loadedmetadata"))); }
        play() { this.paused = false; this.dispatchEvent(new Event("play")); return Promise.resolve(); }
        pause() { this.paused = true; this.dispatchEvent(new Event("pause")); }
        removeAttribute(name) { if (name === "src") this.src = ""; }
        get currentSrc() { return this.src; }
      }
      window.Audio = ControlledAudio; window.AudioContext = undefined; window.webkitAudioContext = undefined;
      if (saved) localStorage.setItem("fanhao.music.lastTrack", JSON.stringify({ trackId: saved }));
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (url, options = {}) => {
        const key = new URL(String(url), location.href), relative = `${key.pathname}${key.search}`;
        options.signal?.addEventListener("abort", () => __transport.aborted.push(relative), { once: true });
        const response = await originalFetch(url, ignoreAbort ? { ...options, cache: "no-store", signal: undefined } : options), originalJson = response.json.bind(response);
        response.json = async () => { try { return await originalJson(); } finally { __transport.settled.push({ url: relative, method: options.method || "GET", ok: response.ok }); } }; return response;
      };
      if (initialBack && location.pathname === "/music/track/A") { const deepLink = `${location.pathname}${location.search}`; history.replaceState(null, "", "/music/library"); history.pushState(null, "", deepLink); }
    }, { ignoreAbort, initialBack, saved });
    await page.goto(real ? `${base}${route}` : `${base}/probe${queueSearchShell ? '?queue-search-shell=1' : ''}`, { waitUntil: waitReady ? "load" : "commit" });
    if (waitReady) {
      try { if (real) await ready(page); else await page.waitForFunction(() => Boolean(window.fixture?.ready)); }
      catch (error) {
        let timer, documentState;
        try { documentState = await Promise.race([page.evaluate(() => ({ state: document.readyState, fixture: Boolean(window.fixture), text: document.body?.textContent.slice(0, 250), resources: performance.getEntriesByType("resource").slice(-8).map(entry => new URL(entry.name).pathname) })), new Promise(resolve => { timer = setTimeout(() => resolve("renderer diagnostic unavailable"), 1000); })]); }
        finally { clearTimeout(timer); }
        console.error("MUSIC_PAGE_STARTUP_FAILURE", JSON.stringify({ url: page.url(), completed: checks, browserPages, totalBrowserPages, connections: connectionSnapshot(), moduleRequestsSincePageStart: musicModuleRequests - moduleRequestsAtStart, faults: faults.slice(startupFaults), unexpected: unexpected.slice(-5), requests: startupFailures.slice(-8), documentState }));
        throw error;
      }
    }
    return page;
  }
}

async function ready(page) { await page.waitForFunction(() => !document.documentElement.classList.contains("app-module-loading"), null, { timeout: 5000 }); }
async function beginMusicRenderMeasurement(page) {
  await page.evaluate(() => {
    const measured = { fullRenders: 0, elements: 0 };
    const countShells = records => { for (const record of records) for (const node of record.addedNodes) if (node.classList?.contains("music-shell")) measured.fullRenders++; };
    const observer = new MutationObserver(countShells), originalCreate = document.createElement;
    observer.observe(document.querySelector("#workGrid"), { childList: true });
    document.createElement = function (...args) { measured.elements++; return originalCreate.apply(this, args); };
    window.__finishMusicRenderMeasurement = () => {
      countShells(observer.takeRecords()); observer.disconnect(); document.createElement = originalCreate;
      return measured;
    };
  });
}
async function endMusicRenderMeasurement(page) { return page.evaluate(() => window.__finishMusicRenderMeasurement()); }
async function favoriteKnownMetadata(page, id) {
  return page.evaluate(id => {
    const music = fixture.state.music;
    return [["current", [music.current]], ["queue", music.queue], ["tracks", music.data?.tracks], ["raw", music.data?.rawTracks]]
      .flatMap(([location, items]) => (items || []).flatMap((track, index) => track?.id === id ? [{ location, index, id: track.id, title: track.title, rating: track.rating ?? null, favorite: track.favorite ?? null }] : []));
  }, id);
}
async function captureFavoriteOwnershipSurface(page, { inputSelector = '[data-music-search="library"]', scrollSelector = ".music-track-panel", draft = "  新的收藏草稿  " } = {}) {
  const input = page.locator(inputSelector); await input.focus();
  await input.evaluate((node, { inputSelector, scrollSelector, draft }) => {
    node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "候选" }));
    node.value = draft;
    node.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true, inputType: "insertCompositionText", data: "候选" }));
    node.setSelectionRange(2, 7, "forward");
    const panel = document.querySelector(scrollSelector);
    const snapshot = window.__favoriteOwnershipSurface = { input: node, inputSelector, scrollSelector, ancestors: [], nodes: [...document.querySelectorAll(".music-shell,.music-layout,.music-now-panel,.music-player-bar,.music-track-panel,.music-track-row,.music-player-stage,.music-stage-content,.music-stage-meta,.music-lyric-lines,.music-lyric-find")],
      blur: 0, status: window.fixture?.state.music.status, text: document.querySelector(".music-list-read-error")?.textContent || "", raw: node.value, top: panel?.scrollTop || 0, scroll: scrollY };
    for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) snapshot.ancestors.push({ node: ancestor, parent: ancestor.parentElement });
    node.addEventListener("blur", () => snapshot.blur++);
  }, { inputSelector, scrollSelector, draft });
  await beginMusicRenderMeasurement(page);
}
async function assertFavoriteOwnershipSurface(page, operation = "favorite") {
  assert.deepEqual(await endMusicRenderMeasurement(page), { fullRenders: 0, elements: 0 }, `obsolete ${operation} completions must not reconstruct the newer UI`);
  assert.deepEqual(await page.evaluate(() => {
    const snapshot = __favoriteOwnershipSurface, input = document.querySelector(snapshot.inputSelector);
    return { same: input === snapshot.input, connected: snapshot.nodes.every(node => node.isConnected), ancestors: snapshot.ancestors.every(({ node, parent }) => node.isConnected && node.parentElement === parent),
      focus: document.activeElement === input, blur: snapshot.blur, raw: input?.value === snapshot.raw, range: [input?.selectionStart, input?.selectionEnd],
      status: window.fixture ? fixture.state.music.status === snapshot.status : true, error: (document.querySelector(".music-list-read-error")?.textContent || "") === snapshot.text,
      top: document.querySelector(snapshot.scrollSelector)?.scrollTop || 0, scroll: scrollY, expectedTop: snapshot.top, expectedScroll: snapshot.scroll };
  }).then(({ top, scroll, expectedTop, expectedScroll, ...result }) => ({ ...result, scroll: top === expectedTop && scroll === expectedScroll })),
  { same: true, connected: true, ancestors: true, focus: true, blur: 0, raw: true, range: [2, 7], status: true, error: true, scroll: true }, `obsolete ${operation}s must preserve the complete live ancestry, composing draft, native selection, focus and scroll`);
}
async function beginOwnedListErrorMeasurement(page) {
  await beginMusicRenderMeasurement(page);
  await page.evaluate(() => {
    const panel = document.querySelector(".music-track-panel"), sort = panel.querySelector("select");
    window.__ownedListErrorSurface = { shell: document.querySelector(".music-shell"), panel, sort, controls: sort.parentElement };
    window.__ownedListErrorMounts = 0;
    window.__ownedListErrorObserver = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) if (node.querySelector?.(".music-list-read-error")) __ownedListErrorMounts++;
    });
    __ownedListErrorObserver.observe(panel, { childList: true });
  });
}
async function assertOwnedListErrorMeasurement(page) {
  assert.deepEqual(await page.evaluate(() => {
    __ownedListErrorObserver.disconnect();
    const panel = document.querySelector(".music-track-panel"), sort = panel.querySelector("select");
    return { mounts: __ownedListErrorMounts, same: __ownedListErrorSurface.shell === document.querySelector(".music-shell")
      && __ownedListErrorSurface.panel === panel && __ownedListErrorSurface.sort === sort && sort.isConnected && __ownedListErrorSurface.controls === sort.parentElement };
  }), { mounts: 1, same: true }, "one owned list rejection must mount its error once while retaining the native sort ancestry");
}
async function tick(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function until(predicate, message) { const deadline = Date.now() + 5000; while (!predicate()) { assert(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 10)); } }
async function navigateRoute(page, target) { await page.evaluate(url => { history.pushState(null, "", url); dispatchEvent(new PopStateEvent("popstate")); }, target); }
async function stageTitle(page, title) { await page.waitForFunction(title => document.querySelector(".music-stage-meta h2")?.textContent === title, title, { timeout: 5000 }); }
async function library(page) { await page.locator(".music-library-page").waitFor({ state: "visible", timeout: 5000 }); }
async function launchTrack(page, id) { await page.evaluate(id => { fixture.pending.push(fixture.page.openTrack(id, { autoplay: false }).catch(error => fixture.rejections.push(error.message))); }, id); }
async function useListControl(page, control) {
  if (control === "sort") await page.locator(".music-sort").selectOption("title");
  else { const input = page.locator('[data-music-search="library"]'); await input.fill("Latest"); await input.press("Enter"); }
}
async function launchList(page, query) { await page.evaluate(query => { fixture.state.music.mode = "library"; fixture.state.music.query = query; fixture.pending.push(fixture.page.loadMusic({ skipRoute: true, restoreLast: false }).catch(error => fixture.rejections.push(error.message))); }, query); }
async function loadList(page, query) { await page.evaluate(query => { fixture.state.music.mode = "library"; fixture.state.music.query = query; return fixture.page.loadMusic({ skipRoute: true, restoreLast: false }); }, query); }
async function launchAppend(page) { await page.evaluate(() => { fixture.pending.push(fixture.page.loadMusic({ append: true, skipRoute: true, restoreLast: false }).catch(error => fixture.rejections.push(error.message))); }); }
async function launchRoute(page, route) { await page.evaluate(route => { fixture.page.applyRouteState(route); fixture.page.enter({ deferInitialLoad: true, skipRoute: true }); fixture.pending.push(fixture.page.openRouteTarget(route).catch(error => fixture.rejections.push(error.message))); }, route); }
async function trackState(page) { return page.evaluate(() => ({ current: fixture.state.music.current?.id ?? null, opening: fixture.state.music.openingTrackId, status: fixture.state.music.status })); }
async function listState(page) { return page.evaluate(() => ({ query: fixture.state.music.query, loading: fixture.state.music.loading, loadingMore: fixture.state.music.loadingMore, status: fixture.state.music.status, count: fixture.state.music.data?.tracks?.length || 0 })); }
async function audioState(page) { return page.evaluate(() => ({ src: __audios[0].src, currentTime: __audios[0].currentTime, paused: __audios[0].paused, loads: __audios[0].loads })); }
function queueSearchInput(page) { return page.locator('.music-queue-search input[type="search"]'); }
async function queueSearchRowIds(page) { return page.locator('.music-queue-row').evaluateAll(rows => rows.map(row => row.dataset.musicTrackId)); }
async function queueSearchNumbers(page) { return (await page.locator('.music-queue-search-count').textContent()).replaceAll(',', '').match(/\d+/g)?.map(Number) || []; }
async function captureQueueSearchEdit(page, raw) {
  await queueSearchInput(page).evaluate((node, raw) => {
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '候选' })); node.value = raw;
    node.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, inputType: 'insertCompositionText', data: '候选' }));
    node.setSelectionRange(2, raw.length - 2); window.__queueSearchEdit = { input: node, raw, ancestors: [], blur: 0 };
    for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) __queueSearchEdit.ancestors.push(ancestor);
    node.addEventListener('blur', () => __queueSearchEdit.blur++);
  }, raw);
}
async function assertQueueSearchEdit(page) {
  assert.deepEqual(await queueSearchInput(page).evaluate(node => ({ same: node === __queueSearchEdit.input, ancestors: __queueSearchEdit.ancestors.every(ancestor => ancestor.isConnected),
    focus: node === document.activeElement, raw: node.value === __queueSearchEdit.raw, range: [node.selectionStart, node.selectionEnd], blur: __queueSearchEdit.blur })),
    { same: true, ancestors: true, focus: true, raw: true, range: [2, (await queueSearchInput(page).inputValue()).length - 2], blur: 0 },
    "background queue updates must preserve the complete live search ancestry, composing raw text, selection and focus");
}
function moreKeyboardData(mode, start, count, hasMore) {
  const items = Array.from({ length: count }, (_, index) => mode === "library" ? track(`MORE-${start + index}`)
    : mode === "artists" ? { id: `artist-more-${start + index}`, name: "Repeated artist name", trackCount: 1, albumCount: 1 }
      : { id: `album-more-${start + index}`, title: "Repeated album name", artistName: "Repeated artist", trackCount: 1 });
  return { ...(mode === "library" ? trackList() : { summary: summary() }), [mode === "library" ? "tracks" : mode]: items, total: hasMore ? 300 : start + count, hasMore };
}
async function assertMoreFocus(page, mode, index) {
  assert.equal(await page.evaluate(({ mode, index }) => {
    const items = [...document.querySelectorAll(mode === "library" ? ".music-track-table .music-track-row:not(.head)" : mode === "artists" ? ".music-artist-browser-card" : ".music-album-browser-card")];
    const target = mode === "library" ? items.find(item => item.dataset.musicTrackId === `MORE-${index}`) : items[index];
    if (!target || document.activeElement !== target) return false;
    const r = target.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && (target === hit || target.contains(hit));
  }, { mode, index }), true, "keyboard continuation must focus its first new result, visible and unobstructed after scroll restoration");
}
async function startPausedSortAudio(page) {
  await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click();
  await page.waitForFunction(() => __audios[0]?.src.endsWith("/synthetic/audio/P") && !__audios[0].paused);
  await page.locator(".music-player-bar").getByRole("button", { name: "暂停", exact: true }).click();
  await page.evaluate(() => { __audios[0].currentTime = 42; });
}
function musicSortData(mode, reverse) {
  if (mode === "library") {
    const tracks = (reverse ? ["B", "P"] : ["P", "B"]).map(track);
    return { body: { ...trackList(), tracks, total: 2, hasMore: false }, selector: ".music-track-table .music-track-title strong", labels: tracks.map(track => track.title) };
  }
  if (mode === "artists") {
    const list = reverse ? [...artists()].reverse() : artists();
    return { body: { artists: list, total: list.length, hasMore: false, summary: summary() }, selector: ".music-artist-browser-card strong", labels: list.map(artist => artist.name) };
  }
  const list = [{ ...albums()[0] }, { ...albums()[0], id: "album-2", title: "Other album" }];
  if (reverse) list.reverse();
  return { body: { albums: list, total: list.length, hasMore: false, summary: summary() }, selector: ".music-album-browser-card > span:not(.music-cover) > strong", labels: list.map(album => album.title) };
}
async function playbackState(page) { return page.evaluate(() => ({ current: fixture.state.music.current?.id ?? null, lyrics: fixture.state.music.lyrics, queue: fixture.state.music.queue.map(track => track.id), playing: fixture.state.music.playing, audio: { src: __audios[0].src, currentTime: __audios[0].currentTime, paused: __audios[0].paused, loads: __audios[0].loads } })); }
async function assertSearchDuplicateOracle(page) {
  const result = await page.evaluate(async () => { const { collapseDuplicateTracks } = await import('/modules/music/format.js');
    return { actual: fixture.state.music.data.tracks, expected: collapseDuplicateTracks(fixture.state.music.data.rawTracks) }; });
  assert.deepEqual(result.actual, result.expected, 'published search groups must equal the unchanged stateless oracle over the accepted raw prefix');
}
async function playlistPlaybackState(page) { return page.evaluate(() => ({ current: document.querySelector(".music-now-panel")?.dataset.musicTrackId, queue: [...document.querySelectorAll(".music-queue-row")].map(row => row.dataset.musicTrackId), audio: { src: __audios[0].src, currentTime: __audios[0].currentTime, paused: __audios[0].paused, loads: __audios[0].loads } })); }
async function visiblePlaylistTracks(page) { return page.locator(".music-track-table .music-track-row:not(.head)").evaluateAll(rows => rows.map(row => row.dataset.musicTrackId)); }
async function capturePlaylistDestination(page) {
  await page.evaluate(() => {
    window.__playlistDestination = { nodes: [".music-shell", ".music-track-panel", ".music-player-bar", ".music-now-panel"].map(selector => document.querySelector(selector)), text: document.querySelector("#workGrid").textContent };
  });
}
async function assertPlaylistDestination(page) {
  assert.equal(await page.evaluate(() => [".music-shell", ".music-track-panel", ".music-player-bar", ".music-now-panel"].every((selector, index) => document.querySelector(selector) === __playlistDestination.nodes[index])), true, "obsolete completion must preserve the mounted destination");
  assert.equal(await page.evaluate(() => document.querySelector("#workGrid").textContent === __playlistDestination.text), true, "obsolete completion must not replace the current loading state or status");
}
function sendText(res, body, type, cache = "no-store") { if (res.destroyed) return; res.writeHead(200, { "Content-Type": type, "Cache-Control": cache }); res.end(body); }
function sendJson(res, body, status = 200) { if (res.destroyed) return; res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); }
async function readBody(req) { let value = ""; for await (const chunk of req) value += chunk; return value; }
function track(id) { return { id, title: `Track ${id}`, artist: `Artist ${id}`, artistId: `artist-${id}`, album: "Synthetic album", albumId: "album-1", durationMs: 180000, streamUrl: `/synthetic/audio/${id}`, fileName: `${id}.mp3`, hasLyrics: true, coverUrl: `/synthetic/cover/${id}.svg` }; }
function currentContextTrack() { return { ...track("P"), title: "OldNeedle song", artistId: "current-artist", artist: "Current artist outside sidebar", albumId: "current-album", album: "Current album outside sidebar", genre: "OldGenre", language: "Other", favorite: true }; }
function lyrics(id) { return { raw: `Lyric ${id}`, lines: [{ timeMs: 0, text: `Lyric ${id}` }, { timeMs: 10000, text: `Second ${id}` }] }; }
function artists() { return ["P", "B"].map(id => ({ id: `artist-${id}`, name: `Artist ${id}`, trackCount: 120 })); }
function albums() { return [{ id: "album-1", title: "Synthetic album", artistName: "Synthetic", trackCount: 300 }]; }
function summary() { return { totals: { tracks: 300, artists: 2, albums: 1, durationMs: 54000000 }, roots: [{ path: "Synthetic library" }], recent: [], topPlayed: [] }; }
function trackList(url = new URL("http://fixture/api/music/tracks?limit=120")) {
  const offset = Number(url.searchParams.get("offset") || 0), limit = Number(url.searchParams.get("limit") || 120), query = url.searchParams.get("q") || "";
  const tracks = Array.from({ length: Math.min(limit, 300 - offset) }, (_, index) => track(query ? `${query}-${offset + index + 1}` : ["P", "A", "B"][offset + index] || `L${offset + index + 1}`));
  return { tracks, total: 300, hasMore: offset + tracks.length < 300, summary: summary(), artists: artists(), albums: albums(), genres: [], languages: [] };
}
function harness(queueSearchShell = false) {
  // Queue-search geometry uses the same global box model as styles.css.
  // Existing fixture families keep their previous stylesheet environment.
  return `<!doctype html><meta charset=utf-8>${queueSearchShell ? '<link rel=stylesheet href=/css/shell.css>' : ''}<link rel=stylesheet href=/css/foundation.css><link rel=stylesheet href=/modules/music/styles/foundation.css><link rel=stylesheet href=/modules/music/styles/library.css><link rel=stylesheet href=/modules/music/styles/player.css><link rel=stylesheet href=/modules/music/styles/responsive.css><style>body{margin:0;background:#1c2220;color:white}</style><main><div id=statsRow></div><div id=workGrid></div></main><script type=module>
import {createMusicPage} from '/modules/music/music-page.js';
import {routeUrl} from '/js/router.js';
const state={activeView:'music',music:{mode:'library',data:${JSON.stringify(trackList())},summary:${JSON.stringify(summary())},artists:${JSON.stringify(artists())},albums:${JSON.stringify(albums())},hasMore:true,playlistsLoadedAt:Date.now(),smartPlaylistsLoadedAt:Date.now()}};
const els={workGrid:document.querySelector('#workGrid'),statsRow:document.querySelector('#statsRow')},noop=()=>{};
const api=async(url,options={})=>{const init={...options};if(init.body&&typeof init.body!=='string'){init.body=JSON.stringify(init.body);init.headers={'Content-Type':'application/json'}}const res=await fetch(url,init),data=await res.json();if(!res.ok)throw new Error(data.error||'controlled error');return data;};
const route=(overrides={})=>history.replaceState(null,'',routeUrl({view:'music',musicMode:state.music.mode,musicTrackId:state.music.trackPageOpen?state.music.current?.id:'',musicArtistId:state.music.artistId==='all'?'':state.music.artistId,musicQuery:state.music.query,...overrides}));
const page=createMusicPage({api,state,els,formatNumber:value=>new Intl.NumberFormat('zh-CN').format(value||0),formatBytes:value=>String(value||0),cancelScheduledWorkRendering:noop,disconnectPeopleIndexAutoload:noop,resetProgressiveCoverLoading:noop,hidePersonProfile:noop,setMainHeader:noop,openAdminScript:noop,pushRoute:route,replaceRoute:route,syncRouteAfterNavigation:options=>{if(!options?.skipRoute)route(options?.routeOverrides)}});
window.fixture={state,page,pending:[],rejections:[],ready:true};page.enter({skipRoute:true,deferInitialLoad:true});
</script>`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runMusicReaderFixture({ legacyMusic: process.argv.includes("--legacy-music"), legacyHost: process.argv.includes("--legacy-host"), legacySearchAppend: process.argv.includes("--legacy-search-append"), casePattern: process.argv.find(value => value.startsWith("--case="))?.slice(7) || "" });
