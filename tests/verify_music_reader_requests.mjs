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
  const methodRequests = [], playlistMutations = [];
  let playlistState = null;
  let historyState = null;
  const progressSessions = new Map(), progressHeads = new Map();
  let progressClockMs = Date.now();
  let browser = null, checks = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture"), key = `${url.pathname}${url.search}`;
    requests.set(key, (requests.get(key) || 0) + 1);
    methodRequests.push({ method: req.method, path: url.pathname });
    try {
      const progressWrite = req.method === "POST" && /^\/api\/music\/tracks\/[^/]+\/progress$/.test(url.pathname);
      const progressClaim = req.method === "POST" && /^\/api\/music\/tracks\/([^/]+)\/progress-session$/.exec(url.pathname);
      const ratingWrite = req.method === "POST" && /^\/api\/music\/tracks\/([^/]+)\/rating$/.exec(url.pathname);
      const playlistEdit = req.method === "PUT" && url.pathname === "/api/music/playlists/new";
      const playlistAdd = req.method === "POST" && url.pathname === "/api/music/playlists/new/tracks";
      const playlistRemove = req.method === "DELETE" && url.pathname === "/api/music/playlists/new/tracks/P";
      const playlistDelete = req.method === "DELETE" && url.pathname === "/api/music/playlists/new";
      const playlistMutation = playlistEdit || playlistAdd || playlistRemove || playlistDelete;
      const historyDelete = req.method === "DELETE" && url.pathname === "/api/music/history";
      assert(req.method === "GET" || progressWrite || progressClaim || ratingWrite || (playlistState && playlistMutation) || (historyState && historyDelete), `unexpected synthetic mutation: ${req.method} ${key}`);
      const body = ["POST", "PUT"].includes(req.method) ? JSON.parse(await readBody(req)) : null;
      if (historyDelete) assert.equal(await readBody(req), "", "history DELETE must not send a body");
      if (playlistMutation) {
        assert(playlistState?.has("new"), "playlist mutation requires its private case state");
        if (playlistEdit) assert.deepEqual(body, { name: "Renamed playlist", description: "Edited in fixture" });
        else if (playlistAdd) assert.deepEqual(body, { trackId: "B" });
        else assert.equal(await readBody(req), "", "playlist DELETE must not send a body");
        playlistMutations.push({ method: req.method, path: url.pathname, body });
      }
      const gate = [...held].find(value => !value.used && value.match(url, req.method));
      if (gate) {
        gate.used = true; gate.url = key; gate.method = req.method; res.once("close", () => { gate.closed = true; }); gate.requestedResolve(); await gate.promise;
        if (gate.error) { sendJson(res, { error: gate.error }, 503); return; }
        if (gate.body) { sendJson(res, gate.body); return; }
      }
      if (url.pathname === "/probe") { sendText(res, harness(), "text/html; charset=utf-8"); return; }
      if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
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
        sendJson(res, playlistDelete ? { ok: true } : playlistDetail("new")); return;
      }
      const playlistRead = /^\/api\/music\/playlists\/([^/]+)$/.exec(url.pathname);
      if (playlistRead && playlistState) {
        const detail = playlistDetail(decodeURIComponent(playlistRead[1]));
        sendJson(res, detail || { error: "synthetic playlist not found" }, detail ? 200 : 404); return;
      }
      if (ratingWrite) {
        assert(Number.isInteger(body?.rating) && body.rating >= 0 && body.rating <= 5 && Object.keys(body).length === 1);
        sendJson(res, { track: { ...track(decodeURIComponent(ratingWrite[1])), rating: body.rating } }); return;
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
      if (trackMatch) { const id = decodeURIComponent(trackMatch[1]); sendJson(res, { track: track(id), lyrics: lyrics(id), prevId: "", nextId: "" }); return; }
      if (url.pathname === "/api/music/tracks") { sendJson(res, trackList(url)); return; }
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
      if (overrides.has(url.pathname)) { sendText(res, overrides.get(url.pathname), "text/javascript"); return; }
      const target = /^\/music(?:\/|$)/.test(url.pathname) ? path.join(publicRoot, "index.html") : path.resolve(publicRoot, url.pathname.replace(/^\/+/, ""));
      assert(target.startsWith(`${publicRoot}${path.sep}`), "fixture static paths must stay in public");
      const type = target.endsWith(".html") ? "text/html; charset=utf-8" : target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : target.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";
      sendText(res, await fs.promises.readFile(target), type);
    } catch (error) { unexpected.push(`${key}: ${error.message}`); if (!res.destroyed) sendJson(res, { error: error.message }, 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const run = async (name, task) => { if (casePattern && !name.includes(casePattern)) return; await task(); checks++; console.log(`PASS ${name}`); };
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    for (const ignoreAbort of [true, false]) {
      const transport = ignoreAbort ? "ignore-abort" : "normal";
      for (const scenario of ["current success", "new navigation success", "new navigation failure"]) {
        await run(`history clear ${scenario} ${transport}`, async () => {
          historyState = { trackIds: ["P", "A"], cleared: 0 };
          const page = await newPage({ real: true, ignoreAbort, route: "/music/history" });
          try {
            await page.locator('.music-track-table [data-music-track-id="P"] .music-track-title').click();
            await page.waitForFunction(() => document.querySelector(".music-now-panel")?.dataset.musicTrackId === "P");
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
              await page.getByRole("button", { name: "返回音乐库", exact: true }).click();
            } else {
              assert.equal(await page.evaluate(() => fixture.listPlayer === document.querySelector(".music-player-bar") && fixture.listNow === document.querySelector(".music-now-panel")), true);
              assert.equal(await page.evaluate(() => document.activeElement?.dataset.musicSearch), "library");
              if (control === "search") assert.deepEqual(await page.locator('[data-music-search="library"]').evaluate(input => [input.selectionStart, input.selectionEnd]), [2, 4]);
            }
            assert.deepEqual(await page.locator(".music-track-table .music-track-row:not(.head)").evaluateAll(rows => rows.map(row => row.dataset.musicTrackId)), result.tracks.map(item => item.id), "the current visible list must agree with the accepted sorted/search response");
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
          await beginMusicRenderMeasurement(page);
          const letter = page.locator(".music-alpha-index-item").filter({ hasText: /^A$/ });
          // Keyboard activation exercises the real accessible button even when
          // the compact synthetic sidebar overlaps its pointer hit rectangle.
          await letter.focus(); await letter.press("Enter"); await requested(failed); await settle(page, failed);
          assert.equal((await endMusicRenderMeasurement(page)).fullRenders, 1);
          assert((await page.locator("#workGrid").textContent()).includes("controlled alphabet failure"));
          assert.deepEqual(await page.locator(".music-alpha-index-item.active").allTextContents(), ["A"]);
          assert.equal(await page.locator(".music-track-panel").getAttribute("aria-busy"), null);
          const retry = hold(url => url.pathname === `/api/music/${mode}` && url.searchParams.get("letter") === "B");
          const nextLetter = page.locator(".music-alpha-index-item").filter({ hasText: /^B$/ });
          await nextLetter.focus(); await nextLetter.press("Enter"); await requested(retry); await settle(page, retry);
          assert.deepEqual(await page.locator(".music-alpha-index-item.active").allTextContents(), ["B"]);
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
          const failed = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("sort") === "rating", "controlled rating refresh failure");
          await beginMusicRenderMeasurement(page);
          await page.locator(".music-now-panel").getByRole("button", { name: "设为 3 星", exact: true }).click();
          await requested(failed); await settle(page, failed);
          assert.equal((await endMusicRenderMeasurement(page)).fullRenders, 1, "the rating caller must handle an awaited list rejection exactly once");
          assert.deepEqual(await page.evaluate(() => [fixture.state.music.current.rating, fixture.state.music.status]), [3, "controlled rating refresh failure"]);
          const retry = hold(url => url.pathname === "/api/music/tracks" && url.searchParams.get("sort") === "rating");
          await page.locator(".music-now-panel").getByRole("button", { name: "设为 4 星", exact: true }).click();
          await requested(retry); await settle(page, retry);
          assert.deepEqual(await page.evaluate(() => [fixture.state.music.current.rating, fixture.state.music.status]), [4, ""]);
        } finally { await page.close(); }
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
          await beginMusicRenderMeasurement(page);
          if (append) await page.locator(".music-load-more").click();
          else await page.locator(".music-sort").selectOption("title");
          await requested(failed);
          assert.equal(new URL(failed.url, base).searchParams.get("offset"), append ? "120" : null);
          assert.equal(await page.locator(".music-track-panel").getAttribute("aria-busy"), "true");
          await settle(page, failed);
          const measured = await endMusicRenderMeasurement(page);
          console.log(`MEASURE list ${append ? "append" : "sort"} failure ${transport}: ${JSON.stringify(measured)}`);
          assert.equal(measured.fullRenders, 1, "one current rejection must replace the full music shell only once");
          assert(measured.elements > 1000 && measured.elements < 2400, "120 synthetic rows should be rebuilt once, not twice");
          assert.equal(await page.locator(".music-track-table .music-track-row:not(.head)").count(), 120);
          assert.equal(await page.locator(".music-track-panel").getAttribute("aria-busy"), null);
          assert((await page.locator("#workGrid").textContent()).includes("controlled list failure"));
          assert.deepEqual(await page.evaluate(() => [fixture.state.music.loading, fixture.state.music.loadingMore]), [false, false]);
          assert.equal(await page.locator(".music-load-more").isEnabled(), true, "append failure must release the retry control");
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
          const first = { ...track("same-mp3"), title: "Identical song", artist: "Synthetic Artist", fileName: "identical.mp3", hasLyrics: false };
          const second = { ...track("distinct"), title: "Distinct song", artist: "Synthetic Artist" };
          const preferred = { ...first, id: "same-flac", fileName: "identical.flac", codec: "flac", sampleRate: 96000, bitDepth: 24, streamUrl: "/synthetic/audio/same-flac" };
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
    console.log(`Music reader fixture passed (${checks} cases; private Chromium, actual music host, controlled Audio without decoding)`); return { checks };
  } finally { for (const gate of held) gate.release(); if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

  function countRequests(match) { return [...requests].filter(([url]) => match(new URL(url, base))).reduce((sum, [, count]) => sum + count, 0); }
  function countMethodRequests(method, pathname) { return methodRequests.filter(request => request.method === method && request.path === pathname).length; }
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
    playlistState = new Map([
      ["new", { id: "new", name: "New playlist", description: "Original description", trackIds: ["P", "A"] }],
      ["other", { id: "other", name: "Other playlist", description: "Other description", trackIds: ["B"] }],
    ]);
    const page = await newPage({ real: true, ignoreAbort, route: operation === "add" ? "/music/library" : "/music/playlist/new" });
    const id = operation === "add" ? "B" : "P";
    await page.locator(`.music-track-table [data-music-track-id="${id}"] .music-track-title`).click();
    await page.waitForFunction(id => document.querySelector(".music-now-panel")?.dataset.musicTrackId === id, id);
    await page.evaluate(() => { __audios[0].currentTime = 42; });
    return page;
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
  function hold(match, error = "", body = null) {
    let release, requestedResolve; const gate = { match, error, body, used: false, closed: false, promise: new Promise(resolve => { release = resolve; }), requested: new Promise(resolve => { requestedResolve = resolve; }), release, requestedResolve }; held.add(gate); return gate;
  }
  async function requested(gate, timeout = 5000) { let timer; try { await Promise.race([gate.requested, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`new request did not start before obsolete I/O finished (${timeout}ms)`)), timeout); })]); } finally { clearTimeout(timer); } }
  async function settle(page, gate) { const identity = { url: gate.url, method: gate.method }; const before = await page.evaluate(({ url, method }) => __transport.settled.filter(item => item.url === url && item.method === method).length, identity); gate.release(); await page.waitForFunction(({ url, method, before }) => __transport.settled.filter(item => item.url === url && item.method === method).length > before, { ...identity, before }, { timeout: 5000 }); await tick(page); }
  async function finishOld(page, gate, ignoreAbort) { if (ignoreAbort) await settle(page, gate); else { await until(() => gate.closed, "normal transport must close the obsolete request"); gate.release(); await tick(page); } }
  async function newPage({ real = false, ignoreAbort = true, route = "/music/library", waitReady = true, initialBack = false, saved = "" } = {}) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.on("pageerror", error => faults.push(error.message));
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
    await page.goto(real ? `${base}${route}` : `${base}/probe`, { waitUntil: waitReady ? "load" : "commit" });
    if (waitReady) { if (real) await ready(page); else await page.waitForFunction(() => Boolean(window.fixture?.ready)); } return page;
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
async function playbackState(page) { return page.evaluate(() => ({ current: fixture.state.music.current?.id ?? null, lyrics: fixture.state.music.lyrics, queue: fixture.state.music.queue.map(track => track.id), playing: fixture.state.music.playing, audio: { src: __audios[0].src, currentTime: __audios[0].currentTime, paused: __audios[0].paused, loads: __audios[0].loads } })); }
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
function lyrics(id) { return { raw: `Lyric ${id}`, lines: [{ timeMs: 0, text: `Lyric ${id}` }, { timeMs: 10000, text: `Second ${id}` }] }; }
function artists() { return ["P", "B"].map(id => ({ id: `artist-${id}`, name: `Artist ${id}`, trackCount: 120 })); }
function albums() { return [{ id: "album-1", title: "Synthetic album", artistName: "Synthetic", trackCount: 300 }]; }
function summary() { return { totals: { tracks: 300, artists: 2, albums: 1, durationMs: 54000000 }, roots: [{ path: "Synthetic library" }], recent: [], topPlayed: [] }; }
function trackList(url = new URL("http://fixture/api/music/tracks?limit=120")) {
  const offset = Number(url.searchParams.get("offset") || 0), limit = Number(url.searchParams.get("limit") || 120), query = url.searchParams.get("q") || "";
  const tracks = Array.from({ length: Math.min(limit, 300 - offset) }, (_, index) => track(query ? `${query}-${offset + index + 1}` : ["P", "A", "B"][offset + index] || `L${offset + index + 1}`));
  return { tracks, total: 300, hasMore: offset + tracks.length < 300, summary: summary(), artists: artists(), albums: albums(), genres: [], languages: [] };
}
function harness() {
  return `<!doctype html><meta charset=utf-8><link rel=stylesheet href=/css/foundation.css><link rel=stylesheet href=/modules/music/styles/foundation.css><link rel=stylesheet href=/modules/music/styles/library.css><link rel=stylesheet href=/modules/music/styles/player.css><link rel=stylesheet href=/modules/music/styles/responsive.css><style>body{margin:0;background:#1c2220;color:white}</style><main><div id=statsRow></div><div id=workGrid></div></main><script type=module>
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
