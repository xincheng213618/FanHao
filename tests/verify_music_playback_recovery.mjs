import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Actual music page + native Chromium Audio decoding an in-memory silent WAV.
// Every API, stream and progress write belongs to this private loopback server.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(root, "public");

export async function runMusicPlaybackRecoveryFixture({ casePattern = "", sourceOverrides = {} } = {}) {
  const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean).find(value => fs.existsSync(value));
  assert(executablePath, "Chrome or Edge required for native music recovery fixture");
  const wav = silentWav(60), faults = [], unexpected = [], requests = new Map(), failures = new Set(), heldStreams = new Map(), heldClaims = new Map();
  const savedPositions = new Map();
  const overrides = new Map(Object.entries(sourceOverrides));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture");
    requests.set(url.pathname, (requests.get(url.pathname) || 0) + 1);
    try {
      if (url.pathname === "/probe") { respond(res, harness(), "text/html; charset=utf-8"); return; }
      if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      const stream = /^\/synthetic\/audio\/([AB])\.wav$/.exec(url.pathname);
      if (stream) {
        if (failures.has(stream[1])) { respond(res, "Synthetic temporary outage", "text/plain", 503); return; }
        const held = heldStreams.get(stream[1]);
        if (held) { held.requestedResolve(); await held.promise; }
        if (res.destroyed) return;
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
        const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
        assert(start <= end && end < wav.length, "native WAV fixture range must be valid");
        res.writeHead(range ? 206 : 200, { "Content-Type": "audio/wav", "Cache-Control": "no-store", "Accept-Ranges": "bytes", "Content-Length": end - start + 1, ...(range ? { "Content-Range": `bytes ${start}-${end}/${wav.length}` } : {}) });
        res.end(wav.subarray(start, end + 1)); return;
      }
      const detail = /^\/api\/music\/tracks\/([AB])$/.exec(url.pathname);
      if (detail && req.method === "GET") { json(res, { track: { ...track(detail[1]), positionMs: savedPositions.get(detail[1]) || 0 }, lyrics: { raw: "", lines: [] }, serverClockMs: Date.now() }); return; }
      const progress = /^\/api\/music\/tracks\/([AB])\/(progress|progress-session|progress-clock)$/.exec(url.pathname);
      if (progress) {
        if (progress[2] === "progress-clock") assert.equal(req.method, "GET");
        else { assert.equal(req.method, "POST"); await readBody(req); }
        const held = progress[2] === "progress-session" && heldClaims.get(progress[1]);
        if (held) { held.requestedResolve(); await held.promise; }
        json(res, progress[2] === "progress-session" ? { trackId: progress[1], progressSessionId: randomUUID(), progressSessionStartedAt: Date.now(), serverClockMs: Date.now() } : { ok: true, serverClockMs: Date.now() }); return;
      }
      if (req.method === "GET" && /\.(js|css|svg|png)$/.test(url.pathname)) {
        const filename = path.resolve(publicRoot, `.${decodeURIComponent(url.pathname)}`);
        assert(filename.startsWith(`${publicRoot}${path.sep}`), "static fixture path must stay in public");
        respond(res, overrides.get(url.pathname) ?? fs.readFileSync(filename), url.pathname.endsWith(".css") ? "text/css" : url.pathname.endsWith(".svg") ? "image/svg+xml" : url.pathname.endsWith(".png") ? "image/png" : "text/javascript"); return;
      }
      unexpected.push(`${req.method} ${url.pathname}`); respond(res, "Unmodelled fixture endpoint", "text/plain", 404);
    } catch (error) { unexpected.push(error.message); respond(res, error.message, "text/plain", 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  let checks = 0;
  const run = async (name, task) => { if (casePattern && !name.includes(casePattern)) return; await task(); checks++; console.log(`PASS ${name}`); };
  try {
    for (const paused of [false, true]) await run(`native playback volume stays consistent across views while ${paused ? "paused" : "playing"}`, async () => {
      const page = await newPage();
      try {
        await page.evaluate(() => { __audios[0].muted = false; });
        await page.locator('.music-track-table [data-music-track-id="A"] .music-track-title').click();
        await page.waitForFunction(() => fixture.state.music.current?.id === "A" && __audios[0].readyState >= 1 && !__audios[0].paused);
        if (paused) {
          await page.locator(".music-player-controls").getByRole("button", { name: "暂停", exact: true }).click();
          await page.waitForFunction(() => __audios[0].paused && !fixture.state.music.playing);
          await page.evaluate(() => { __audios[0].currentTime = 42; });
        }
        const before = await page.evaluate(() => {
          window.__volumeAudio = __audios[0]; window.__volumePlaybackEvents = [];
          for (const event of ["play", "pause", "loadstart"]) __volumeAudio.addEventListener(event, () => __volumePlaybackEvents.push(event));
          return { src: __volumeAudio.src, time: __volumeAudio.currentTime, paused: __volumeAudio.paused };
        });
        const streamReads = requests.get("/synthetic/audio/A.wav");
        await page.locator(".music-volume").fill("0");
        await page.getByRole("button", { name: "打开当前歌曲播放页", exact: true }).click();
        assert.equal(await page.locator(".music-stage-player .music-volume").count(), 1, "the current-song page must expose volume without making the listener leave the playback view");
        const volume = page.locator(".music-stage-player .music-volume");
        assert.equal(await volume.inputValue(), "0");
        await volume.fill("37"); await volume.focus(); await page.keyboard.press("ArrowLeft"); await page.keyboard.press("Space");
        assert.deepEqual(await page.evaluate(() => [fixture.state.music.volume, __audios[0].volume, fixture.state.music.playing, __audios[0].paused]), [.36, .36, !paused, paused], "single-track keyboard volume must match native Audio without changing play or pause intent");
        await page.getByRole("button", { name: "返回音乐库", exact: true }).click();
        assert.equal(await page.locator(".music-volume").inputValue(), "36");
        const after = await page.evaluate(() => ({ same: __volumeAudio === __audios[0] && __audios.length === 1 && __audios[0] instanceof HTMLAudioElement, src: __audios[0].src, time: __audios[0].currentTime, paused: __audios[0].paused, events: __volumePlaybackEvents }));
        assert.equal(after.same, true, "volume view changes must keep the same native Audio element");
        assert.equal(after.src, before.src); assert.equal(after.paused, before.paused); assert.deepEqual(after.events, [], "volume adjustment must not restart, pause or reload native audio");
        assert(after.time >= before.time - .05 && after.time < before.time + 5, "volume adjustment must preserve the native listening point");
        assert.equal(requests.get("/synthetic/audio/A.wav"), streamReads, "volume view changes must not request the current audio again");
        await page.locator('.music-track-table [data-music-track-id="B"] .music-track-title').click();
        await page.waitForFunction(() => fixture.state.music.current?.id === "B" && __audios[0].readyState >= 1 && !__audios[0].paused);
        assert.deepEqual(await page.evaluate(() => [fixture.state.music.volume, __audios[0].volume, __audios.length, localStorage.getItem("fanhao.music.volume")]), [.36, .36, 1, "0.36"], "a newly selected native song must retain the same volume and Audio element");
      } finally { await page.close(); }
    });
    await run("native queue loop-all next and previous wrap the boundaries", async () => {
      const page = await newPage();
      try {
        await page.locator('.music-track-table [data-music-track-id="B"] .music-track-title').click();
        await page.waitForFunction(() => fixture.state.music.current?.id === "B" && __audios[0].readyState >= 1 && !__audios[0].paused);
        const requestedFirst = page.waitForRequest(request => new URL(request.url()).pathname === "/api/music/tracks/A", { timeout: 1500 }).then(() => true, () => false);
        await page.locator(".music-player-controls").getByRole("button", { name: "下一首", exact: true }).click();
        assert(await requestedFirst, "loop-all next at the last song must request the first queued song");
        await page.waitForFunction(() => fixture.state.music.current?.id === "A" && __audios[0].readyState >= 1 && !__audios[0].paused);
        const requestedLast = page.waitForRequest(request => new URL(request.url()).pathname === "/api/music/tracks/B", { timeout: 1500 }).then(() => true, () => false);
        await page.locator(".music-player-controls").getByRole("button", { name: "上一首", exact: true }).click();
        assert(await requestedLast, "loop-all previous at the first song must request the last queued song");
        await page.waitForFunction(() => fixture.state.music.current?.id === "B" && __audios[0].readyState >= 1 && !__audios[0].paused);
        assert.equal(await page.evaluate(() => fixture.state.music.repeat), "all");
        await page.locator(".music-progress input").fill("1000");
        await page.waitForFunction(() => fixture.state.music.current?.id === "A" && __audios[0].readyState >= 1 && !__audios[0].paused);
        assert.deepEqual(await page.evaluate(() => fixture.state.music.queue.map(item => item.id)), ["A", "B"], "manual and automatic looping must keep queue order");
      } finally { await page.close(); }
    });
    for (const mode of ["one", "none"]) await run(`native queue ${mode} playback keeps manual boundaries and automatic mode`, async () => {
      const page = await newPage();
      try {
        await page.locator('.music-track-table [data-music-track-id="A"] .music-track-title').click();
        await page.waitForFunction(() => __audios[0].readyState >= 1 && !__audios[0].paused);
        await setRepeat(page, mode);
        const initialReads = requests.get("/api/music/tracks/B") || 0;
        await page.locator(".music-player-controls").getByRole("button", { name: "上一首", exact: true }).click();
        assert.equal(await page.evaluate(() => fixture.state.music.current.id), "A", "non-looping manual previous must stay at the first song");
        assert.equal(requests.get("/api/music/tracks/B") || 0, initialReads);
        await page.locator(".music-player-controls").getByRole("button", { name: "下一首", exact: true }).click();
        await page.waitForFunction(() => fixture.state.music.current?.id === "B" && __audios[0].readyState >= 1 && !__audios[0].paused);
        const firstReads = requests.get("/api/music/tracks/A") || 0;
        await page.locator(".music-player-controls").getByRole("button", { name: "下一首", exact: true }).click();
        assert.equal(await page.evaluate(() => fixture.state.music.current.id), "B", "single-song and ordered manual next must stop at the last queued song");
        assert.equal(requests.get("/api/music/tracks/A") || 0, firstReads);
        await page.locator(".music-progress input").fill("1000");
        if (mode === "one") await page.waitForFunction(() => __audios[0].currentTime < 1 && !__audios[0].paused && fixture.state.music.playing);
        else await page.waitForFunction(() => __audios[0].ended && __audios[0].paused && !fixture.state.music.playing);
        assert.equal(await page.evaluate(() => fixture.state.music.current.id), "B");
        assert.equal(requests.get("/api/music/tracks/A") || 0, firstReads, "an explicit automatic wrap=false must not become loop-all");
      } finally { await page.close(); }
    });
    await run("native queue shuffle skips the current song without changing order", async () => {
      const page = await newPage();
      try {
        await page.locator('.music-track-table [data-music-track-id="B"] .music-track-title').click();
        await page.waitForFunction(() => __audios[0].readyState >= 1 && !__audios[0].paused);
        await page.locator(".music-player-controls").getByRole("button", { name: "随机播放已关闭", exact: true }).click();
        await page.locator(".music-player-controls").getByRole("button", { name: "下一首", exact: true }).click();
        await page.waitForFunction(() => fixture.state.music.current?.id === "A" && __audios[0].readyState >= 1 && !__audios[0].paused);
        await page.locator(".music-player-controls").getByRole("button", { name: "上一首", exact: true }).click();
        await page.waitForFunction(() => fixture.state.music.current?.id === "B" && __audios[0].readyState >= 1 && !__audios[0].paused);
        assert.deepEqual(await page.evaluate(() => [fixture.state.music.shuffle, fixture.state.music.queue.map(item => item.id)]), [true, ["A", "B"]]);
      } finally { await page.close(); }
    });
    await run("native queue current song survives clearing the other songs", async () => {
      const page = await newPage();
      try {
        await page.locator('.music-track-table [data-music-track-id="B"] .music-track-title').click();
        await page.waitForFunction(() => __audios[0].readyState >= 1 && !__audios[0].paused);
        assert.equal(await page.locator('.music-queue-row[data-music-track-id="B"]').getByRole("button", { name: "移出队列", exact: true }).isDisabled(), true);
        const reads = requests.get("/synthetic/audio/B.wav");
        page.once("dialog", dialog => dialog.accept());
        await page.locator('[data-music-queue-action="clear"]').click();
        assert.deepEqual(await page.evaluate(() => [fixture.state.music.current.id, fixture.state.music.queue.map(item => item.id), __audios[0].paused]), ["B", ["B"], false]);
        assert.equal(await page.locator('[data-music-queue-action="clear"]').isDisabled(), true);
        await page.locator(".music-player-controls").getByRole("button", { name: "下一首", exact: true }).click();
        assert.equal(requests.get("/synthetic/audio/B.wav"), reads, "one-song looping must not reload the current native source");
        assert.deepEqual(await page.evaluate(() => [fixture.state.music.current.id, __audios[0].paused, fixture.state.music.playing]), ["B", false, true]);
      } finally { await page.close(); }
    });
    for (const target of [null, 0, 5, 10]) await run(`native initial metadata ${target === null ? "restores saved position" : `respects a newer keyboard seek ${target}s`}`, async () => {
      savedPositions.set("A", 8000);
      const held = holdStream("A"), page = await newPage();
      try {
        await page.locator('.music-track-table [data-music-track-id="A"] .music-track-title').click();
        await held.requested;
        await page.waitForFunction(() => fixture.state.music.current?.id === "A" && fixture.state.music.playing);
        await page.locator(".music-now-panel").click({ position: { x: 5, y: 5 } });
        if (target !== null) {
          await page.keyboard.press("ArrowRight");
          if (target === 0) await page.keyboard.press("ArrowLeft");
          if (target === 10) await page.keyboard.press("ArrowRight");
          assert.equal(await page.evaluate(() => __audios[0].currentTime), target, "keyboard seek must set a native default start while metadata is pending");
        }
        await page.locator(".music-now-panel").getByRole("button", { name: "暂停", exact: true }).click();
        held.release();
        await page.waitForFunction(() => __audios[0].readyState >= 1 && !__audios[0].error && __audios[0].paused);
        assert.equal(await page.evaluate(() => __audios[0].currentTime), target ?? 8, "initial metadata must preserve a newer user seek instead of restoring the stale saved position");
        assert.deepEqual(await page.evaluate(() => [__audios[0].paused, fixture.state.music.playing]), [true, false], "initial metadata must not restart an explicit pause");
      } finally { held.release(); savedPositions.clear(); await page.close(); }
    });
    for (const shared of [false, true]) await run(`initial seek intent cannot suppress a new ${shared ? "same-source" : "different-source"} track resume`, async () => {
      savedPositions.set("A", 8000); savedPositions.set("B", 17000);
      const page = await newPage({ controlled: true });
      try {
        await page.evaluate(() => { __media.deferMetadata = true; });
        await page.locator('.music-track-table [data-music-track-id="A"] .music-track-title').click();
        await page.waitForFunction(() => fixture.state.music.current?.id === "A");
        await page.locator(".music-now-panel").click({ position: { x: 5, y: 5 } }); await page.keyboard.press("ArrowRight");
        assert.equal(await page.evaluate(() => __audios[0].currentTime), 5);
        await page.evaluate(async shared => { fixture.sharedSource = shared; await fixture.page.openTrack("B", { autoplay: false }); __audios[0].metadata(); }, shared);
        assert.deepEqual(await page.evaluate(() => [fixture.state.music.current.id, __audios[0].currentTime]), ["B", 17], "an old seek must not suppress the replacement track's saved resume");
      } finally { savedPositions.clear(); await page.close(); }
    });
    for (const shared of [false, true]) await run(`native initial seek releases its default start for a new ${shared ? "same-source" : "different-source"} track`, async () => {
      savedPositions.set("A", 8000);
      const held = holdStream("A"), page = await newPage();
      try {
        await page.locator('.music-track-table [data-music-track-id="A"] .music-track-title').click(); await held.requested;
        await page.waitForFunction(() => fixture.state.music.playing);
        await page.locator(".music-now-panel").click({ position: { x: 5, y: 5 } }); await page.keyboard.press("ArrowRight");
        await page.evaluate(async shared => { fixture.sharedSource = shared; await fixture.page.openTrack("B", { autoplay: false }); }, shared);
        held.release(); await page.waitForFunction(() => __audios[0].readyState >= 1 && !__audios[0].error);
        assert.deepEqual(await page.evaluate(() => [fixture.state.music.current.id, __audios[0].currentTime, __audios[0].paused]), ["B", 0, true], "a replacement track must discard the old initial default start and pending play intent");
      } finally { held.release(); savedPositions.clear(); await page.close(); }
    });
    await run("native account reload releases a pending initial seek", async () => {
      savedPositions.set("A", 8000);
      const held = holdStream("A"), page = await newPage();
      try {
        await page.locator('.music-track-table [data-music-track-id="A"] .music-track-title').click(); await held.requested;
        await page.waitForFunction(() => fixture.state.music.playing && globalThis.__fanhaoWebAccountContext?.installed);
        await page.locator(".music-now-panel").click({ position: { x: 5, y: 5 } }); await page.keyboard.press("ArrowRight");
        const reads = requests.get("/synthetic/audio/A.wav");
        await Promise.all([
          page.waitForEvent("domcontentloaded"),
          page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "fanhao.web.accountRevision.v1", newValue: "synthetic-account-switch" })))
        ]);
        await page.waitForFunction(() => fixture?.ready);
        held.release();
        assert.deepEqual(await page.evaluate(() => [fixture.state.music.current, __audios[0].src, __audios[0].paused, fixture.writes]), [null, "", true, []], "account lifecycle reload must release the old seek without new playback or progress");
        assert.equal(requests.get("/synthetic/audio/A.wav"), reads);
      } finally { held.release(); savedPositions.clear(); await page.close(); }
    });
    await run("native initial seek remains current through an explicit failed-stream retry", async () => {
      savedPositions.set("A", 8000); failures.add("A");
      const page = await newPage(); let held;
      try {
        await page.locator('.music-track-table [data-music-track-id="A"] .music-track-title').click();
        await page.waitForFunction(() => __audios[0].error && fixture.state.music.playbackError);
        await page.locator(".music-now-panel").click({ position: { x: 5, y: 5 } }); await page.keyboard.press("ArrowRight");
        assert.equal(await page.evaluate(() => __audios[0].currentTime), 5);
        failures.delete("A"); held = holdStream("A"); await retry(page); await held.requested;
        await page.locator(".music-now-panel").getByRole("button", { name: "暂停", exact: true }).click();
        held.release(); await page.waitForFunction(() => __audios[0].readyState >= 1 && !__audios[0].error);
        assert.deepEqual(await page.evaluate(() => [__audios[0].currentTime, __audios[0].paused]), [5, true], "an explicit retry must keep a newer initial seek rather than its stale saved point");
      } finally { held?.release(); failures.clear(); savedPositions.clear(); await page.close(); }
    });
    await run("native playback speed keeps saved preference on first source", async () => {
      const page = await newPage({ speed: .75 });
      try {
        await page.locator('.music-track-table [data-music-track-id="A"] .music-track-title').click();
        await page.waitForFunction(() => __audios[0].readyState >= 1 && !__audios[0].paused);
        assert.deepEqual(await speedState(page), [.75, "0.75", .75, .75], "the first native song must preserve the saved speed in state, UI and media");
      } finally { await page.close(); }
    });
    await run("native playback speed survives selecting the next song", async () => {
      const page = await newPage();
      try {
        await page.locator('.music-track-table [data-music-track-id="A"] .music-track-title').click();
        await page.waitForFunction(() => __audios[0].readyState >= 1 && !__audios[0].paused);
        await page.locator(".music-speed-wrap select").selectOption("1.5");
        assert.equal(await page.evaluate(() => __audios[0].playbackRate), 1.5);
        await page.locator('.music-queue-row[data-music-track-id="B"] .music-queue-play').click();
        await page.waitForFunction(() => fixture.state.music.current?.id === "B" && __audios[0].readyState >= 1 && !__audios[0].paused);
        assert.deepEqual(await speedState(page), [1.5, "1.5", 1.5, 1.5], "the next native song must play at the selected speed, matching its UI");
      } finally { await page.close(); }
    });
    for (const pending of [false, true]) await run(`native playback speed survives failed-stream retry${pending ? " with newer pending speed and pause" : ""}`, async () => {
      failures.add("A");
      const page = await newPage(); let held;
      try {
        await page.locator('.music-track-table [data-music-track-id="A"] .music-track-title').click();
        await page.waitForFunction(() => __audios[0].error && fixture.state.music.playbackError);
        await page.locator(".music-speed-wrap select").selectOption("1.5");
        await page.locator(".music-volume").fill("31");
        failures.delete("A");
        if (pending) held = holdStream("A");
        await retry(page);
        if (pending) {
          await held.requested;
          await page.waitForFunction(() => fixture.state.music.playing && !__audios[0].paused);
          await page.locator(".music-speed-wrap select").selectOption("0.75");
          await page.locator(".music-now-panel").getByRole("button", { name: "暂停", exact: true }).click();
          held.release();
        }
        await page.waitForFunction(() => __audios[0].readyState >= 1 && !__audios[0].error);
        assert.deepEqual(await speedState(page), pending ? [.75, "0.75", .75, .75] : [1.5, "1.5", 1.5, 1.5], "native retry must retain the latest speed, including a selection made before metadata");
        assert.equal(await page.evaluate(() => __audios[0].volume), .31);
        assert.deepEqual(await page.evaluate(() => [__audios[0].paused, fixture.state.music.playing]), [pending, !pending], "rate preservation must keep the later native pause intent");
        assert.deepEqual(await page.evaluate(() => fixture.state.music.queue.map(item => item.id)), ["A", "B"]);
        if (pending) {
          await retry(page); await page.waitForFunction(() => !__audios[0].paused && fixture.state.music.playing);
          assert.deepEqual(await speedState(page), [.75, "0.75", .75, .75]);
        }
      } finally { held?.release(); failures.clear(); await page.close(); }
    });
    for (const entry of ["toggle", "queue", "library"]) await run(`native failed stream retries the same song through ${entry}`, async () => {
      failures.add("A");
      const page = await newPage();
      try {
        await page.locator('.music-track-table [data-music-track-id="A"] .music-track-title').click();
        await page.waitForFunction(() => __audios[0].error && fixture.state.music.playbackError);
        const failed = await page.evaluate(() => ({ error: __audios[0].error.code, source: __audios[0].currentSrc, paused: __audios[0].paused }));
        assert(failed.error > 0 && failed.paused, `the failed native element must be ready for a new play intent: ${JSON.stringify(failed)}`);
        assert.equal(await page.locator(".music-now-panel").getByRole("button", { name: "播放", exact: true }).count(), 1, "a terminal failure must expose an available play control");
        const before = requests.get("/synthetic/audio/A.wav") || 0;
        failures.delete("A");
        if (entry === "toggle") await page.locator(".music-now-panel").getByRole("button", { name: "播放", exact: true }).click();
        else if (entry === "queue") await page.locator('.music-queue-row[data-music-track-id="A"] .music-queue-play').click();
        else await page.locator('.music-track-table [data-music-track-id="A"] .music-track-title').click();
        await page.waitForTimeout(250);
        assert((requests.get("/synthetic/audio/A.wav") || 0) > before, "explicit replay after a terminal media failure must request the same stream again");
        await page.waitForFunction(() => !__audios[0].paused && !__audios[0].error && __audios[0].readyState >= 2 && !fixture.state.music.playbackError);
        assert.deepEqual(await page.evaluate(() => ({ current: fixture.state.music.current.id, queue: fixture.state.music.queue.map(item => item.id) })), { current: "A", queue: ["A", "B"] });
      } finally { failures.clear(); await page.close(); }
    });
    await run("native failed stream waits for an explicit retry", async () => {
      failures.add("A"); const page = await newPage();
      try {
        await page.locator('.music-track-table [data-music-track-id="A"] .music-track-title').click();
        await page.waitForFunction(() => __audios[0].error && fixture.state.music.playbackError);
        const before = requests.get("/synthetic/audio/A.wav") || 0;
        failures.delete("A"); await page.waitForTimeout(250);
        assert.equal(requests.get("/synthetic/audio/A.wav"), before, "service recovery must not silently restart a failed song");
        assert.equal(await page.evaluate(() => __audios[0].paused), true);
      } finally { failures.clear(); await page.close(); }
    });
    await run("native paused retry restores its saved point without restarting", async () => {
      failures.add("A"); const page = await newPage(); let held;
      try {
        await page.locator('.music-track-table [data-music-track-id="A"] .music-track-title').click();
        await page.waitForFunction(() => __audios[0].error && fixture.state.music.playbackError);
        await page.evaluate(() => { fixture.state.music.current.positionMs = 42000; });
        failures.delete("A"); held = holdStream("A");
        await retry(page); await held.requested;
        await page.locator(".music-now-panel").getByRole("button", { name: "暂停", exact: true }).click();
        held.release();
        await page.waitForFunction(() => __audios[0].readyState >= 1 && !__audios[0].error);
        const restored = await page.evaluate(() => ({ position: __audios[0].currentTime, paused: __audios[0].paused, playing: fixture.state.music.playing }));
        assert(restored.position >= 42 && restored.position < 42.2, `native retry must restore its saved listening point: ${JSON.stringify(restored)}`);
        assert(restored.paused && !restored.playing, "a later explicit pause must survive real pending media recovery");
      } finally { held?.release(); failures.clear(); await page.close(); }
    });
    await run("native same-source new track discards an old default start and play intent", async () => {
      failures.add("A"); const page = await newPage(); let held;
      try {
        await page.locator('.music-track-table [data-music-track-id="A"] .music-track-title').click();
        await page.waitForFunction(() => __audios[0].error && fixture.state.music.playbackError);
        await page.evaluate(() => { fixture.state.music.current.positionMs = 42000; });
        failures.delete("A"); held = holdStream("A"); await retry(page); await held.requested;
        await page.evaluate(async () => { fixture.sharedSource = true; await fixture.page.openTrack("B", { autoplay: false }); });
        held.release(); await page.waitForFunction(() => __audios[0].readyState >= 1 && !__audios[0].error);
        assert.deepEqual(await page.evaluate(() => [fixture.state.music.current.id, __audios[0].currentTime, __audios[0].paused]), ["B", 0, true], "same-source replacement must discard the old default start and pending play");
      } finally { held?.release(); failures.clear(); await page.close(); }
    });
    for (const change of ["owner", "revision"]) await run(`native account ${change} change cancels its old default start`, async () => {
      failures.add("A"); const page = await newPage(); let held;
      try {
        await page.locator('.music-track-table [data-music-track-id="A"] .music-track-title').click();
        await page.waitForFunction(() => __audios[0].error && fixture.state.music.playbackError);
        await page.evaluate(() => { fixture.state.music.current.positionMs = 42000; });
        failures.delete("A"); held = holdStream("A"); await retry(page); await held.requested;
        await page.evaluate(change => {
          fixture.staleWritesStart = fixture.writes.length;
          const context = globalThis.__fanhaoWebAccountContext;
          if (change === "owner") context.owner = "guest";
          else { localStorage.setItem("fanhao.web.accountRevision.v1", "synthetic-new-revision"); context.revision = "synthetic-new-revision"; }
        }, change);
        held.release(); await page.waitForFunction(() => __audios[0].readyState >= 1 && !__audios[0].error);
        assert.deepEqual(await page.evaluate(() => [__audios[0].currentTime, __audios[0].paused, fixture.state.music.playing]), [0, true, false], "an old account default start must be removed and stay paused in native media");
        await page.waitForTimeout(150);
        assert.deepEqual(await page.evaluate(() => fixture.writes.slice(fixture.staleWritesStart)), [], "discarding old native media must not save progress or played receipts for the new account");
      } finally { held?.release(); failures.clear(); await page.close(); }
    });
    for (const position of [42, 59]) await run(`retry metadata restores the listening point ${position}s`, async () => {
      const page = await controlledFailurePage(position);
      try {
        await retry(page); await page.evaluate(() => __audios[0].metadata());
        assert.equal(await page.evaluate(() => __audios[0].currentTime), position, "retry metadata must restore the pre-error listening point");
        assert.deepEqual(await page.evaluate(() => [__audios[0].volume, __audios[0].playbackRate, fixture.state.music.queue.map(item => item.id)]), [.31, 1.25, ["A", "B"]]);
      } finally { await page.close(); }
    });
    await run("repeated failure before metadata keeps the original listening point", async () => {
      const page = await controlledFailurePage();
      try {
        await retry(page);
        await page.evaluate(() => { const audio = __audios[0]; audio.error = { code: 2 }; audio.dispatchEvent(new Event("error")); });
        await retry(page); await page.evaluate(() => __audios[0].metadata());
        assert.equal(await page.evaluate(() => __audios[0].currentTime), 42);
      } finally { await page.close(); }
    });
    await run("pause while retry metadata is pending cannot restart playback", async () => {
      const page = await controlledFailurePage();
      try {
        await page.waitForFunction(() => fixture.writes.some(record => record.positionMs === 42000));
        const writes = await page.evaluate(() => fixture.writes.length);
        await retry(page);
        await page.locator(".music-now-panel").getByRole("button", { name: "暂停", exact: true }).click();
        await page.waitForFunction(writes => fixture.writes.length > writes, writes);
        assert.equal(await page.evaluate(writes => fixture.writes.slice(writes).some(record => record.positionMs === 0), writes), false, "pausing a pending retry must not overwrite the listening point with an unloaded zero");
        await page.evaluate(() => __audios[0].metadata());
        assert.deepEqual(await page.evaluate(() => [__audios[0].currentTime, __audios[0].paused, __audios[0].__plays]), [42, true, 2], "metadata recovery must preserve the later pause intent");
      } finally { await page.close(); }
    });
    for (const shared of [false, true]) for (const positionMs of [0, 8000]) await run(`new ${shared ? "same-source" : "different-source"} track discards old retry position ${positionMs / 1000}s`, async () => {
      const page = await controlledFailurePage();
      try {
        await retry(page);
        if (shared) await page.evaluate(() => { fixture.sharedSource = true; });
        await page.locator('.music-queue-row[data-music-track-id="B"] .music-queue-play').click();
        await page.waitForFunction(() => fixture.state.music.current?.id === "B");
        await page.evaluate(positionMs => { fixture.state.music.current.positionMs = positionMs; __audios[0].metadata(); }, positionMs);
        assert.equal(await page.evaluate(() => __audios[0].currentTime), positionMs / 1000, "an old retry must not seek the newly selected track");
        assert.equal(await page.evaluate(() => fixture.state.music.playbackError), "");
      } finally { await page.close(); }
    });
    await run("released media ignores old metadata and error events", async () => {
      const page = await controlledFailurePage();
      try {
        await retry(page);
        await page.evaluate(() => {
          const audio = __audios[0]; audio.pause(); audio.removeAttribute("src"); audio.load(); fixture.state.music.current = null;
          audio.dispatchEvent(new Event("loadedmetadata")); audio.dispatchEvent(new Event("error"));
        });
        assert.deepEqual(await page.evaluate(() => [__audios[0].currentTime, __audios[0].paused, __audios[0].__plays, fixture.state.music.playbackError]), [0, true, 2, ""]);
      } finally { await page.close(); }
    });
    for (const change of ["owner", "revision"]) await run(`account ${change} change discards pending retry position`, async () => {
      const claim = holdRequest(heldClaims, "A");
      const page = await controlledFailurePage();
      try {
        await claim.requested;
        await retry(page);
        await page.evaluate(change => {
          fixture.staleWritesStart = fixture.writes.length;
          const context = globalThis.__fanhaoWebAccountContext;
          if (change === "owner") context.owner = "guest";
          else { localStorage.setItem("fanhao.web.accountRevision.v1", "synthetic-new-revision"); context.revision = "synthetic-new-revision"; }
          __audios[0].__seeks.length = 0;
          __audios[0].metadata();
          __audios[0].dispatchEvent(new Event("timeupdate"));
        }, change);
        assert.deepEqual(await page.evaluate(() => [__audios[0].currentTime, __audios[0].paused]), [0, true], "an old account retry must not retain its default listening point or play intent after the account transition");
        claim.release(); await page.waitForFunction(() => fixture.claims > 0);
        await page.waitForTimeout(150);
        assert.deepEqual(await page.evaluate(() => fixture.writes.slice(fixture.staleWritesStart)), [], "discarding a pending retry must not write progress or played receipts using the new account");
      } finally { claim.release(); await page.close(); }
    });
    await run("new seek while retry is pending takes precedence", async () => {
      const page = await controlledFailurePage();
      try {
        await retry(page);
        await page.evaluate(() => { __media.handlers.seekto({ seekTime: 17 }); __audios[0].metadata(); });
        assert.equal(await page.evaluate(() => __audios[0].currentTime), 17, "retry must not overwrite a newer explicit seek");
      } finally { await page.close(); }
    });
    await run("NotAllowed play rejection retries without reloading healthy media", async () => {
      const page = await newPage({ controlled: true });
      try {
        await page.evaluate(() => { __media.rejectNextPlay = true; });
        await page.locator('.music-track-table [data-music-track-id="A"] .music-track-title').click();
        await page.waitForFunction(() => Boolean(fixture.state.music.playbackError));
        const loads = await page.evaluate(() => __audios[0].__loads);
        await retry(page);
        assert.equal(await page.evaluate(() => __audios[0].__loads), loads, "autoplay policy rejection must not reload an otherwise healthy stream");
        assert.equal(await page.evaluate(() => fixture.state.music.playbackError), "");
      } finally { await page.close(); }
    });
    assert(checks > 0, `no recovery cases matched: ${casePattern}`);
    assert.deepEqual(faults, [], "native recovery must not hide page errors");
    assert.deepEqual(unexpected, [], "recovery must only use synthetic fixture endpoints");
    console.log(`Music playback recovery fixture passed (${checks} cases; private Chromium, native synthetic WAV + controlled metadata boundaries)`);
    return { checks };
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

  async function retry(page) { await page.locator(".music-now-panel").getByRole("button", { name: "播放", exact: true }).click(); }
  async function setRepeat(page, mode) {
    const labels = { all: "循环", one: "单曲", none: "顺序" };
    for (let attempt = 0; attempt < 3 && await page.evaluate(() => fixture.state.music.repeat) !== mode; attempt++) {
      const current = await page.evaluate(() => fixture.state.music.repeat);
      await page.locator(".music-player-controls").getByRole("button", { name: `播放模式：${labels[current]}`, exact: true }).click();
    }
    assert.equal(await page.evaluate(() => fixture.state.music.repeat), mode);
  }
  async function speedState(page) { return page.evaluate(() => [fixture.state.music.playbackSpeed, document.querySelector(".music-speed-wrap select").value, __audios[0].playbackRate, __audios[0].defaultPlaybackRate]); }
  function holdStream(id) { return holdRequest(heldStreams, id); }
  function holdRequest(heldRequests, id) {
    let release, requestedResolve;
    const held = { promise: new Promise(resolve => { release = resolve; }), requested: new Promise(resolve => { requestedResolve = resolve; }), requestedResolve: () => requestedResolve(), release: () => { if (heldRequests.get(id) === held) heldRequests.delete(id); release(); } };
    heldRequests.set(id, held); return held;
  }
  async function controlledFailurePage(position = 42) {
    const page = await newPage({ controlled: true });
    await page.locator('.music-track-table [data-music-track-id="A"] .music-track-title').click();
    await page.waitForFunction(() => fixture.state.music.current?.id === "A" && __audios[0].readyState === 4);
    await page.evaluate(position => {
      const audio = __audios[0]; audio.currentTime = position; audio.volume = .31; audio.playbackRate = 1.25; fixture.state.music.playbackSpeed = 1.25;
      fixture.state.music.current.positionMs = 8000;
      __media.deferMetadata = true; audio.error = { code: 2 }; audio.dispatchEvent(new Event("error"));
    }, position);
    return page;
  }
  async function newPage({ controlled = false, speed } = {}) {
    const page = await browser.newPage(); page.on("pageerror", error => faults.push(error.message));
    await page.addInitScript(({ controlled, speed }) => {
      if (speed !== undefined) localStorage.setItem("fanhao.music.playbackSpeed", String(speed));
      const OriginalAudio = window.Audio; window.__audios = [];
      window.__media = { deferMetadata: false, rejectNextPlay: false, handlers: {} };
      if (controlled) {
        window.AudioContext = undefined; window.webkitAudioContext = undefined;
        Object.defineProperty(navigator, "mediaSession", { configurable: true, value: { setActionHandler(name, handler) { __media.handlers[name] = handler; }, setPositionState() {} } });
        window.Audio = class extends EventTarget {
          constructor() { super(); this.src = ""; this.currentSrc = ""; this.paused = true; this._currentTime = 0; this.__seeks = []; this.duration = 60; this.readyState = 0; this.error = null; this.__loads = 0; this.__plays = 0; this.defaultPlaybackRate = this.playbackRate = 1; __audios.push(this); }
          get currentTime() { return this._currentTime; }
          set currentTime(value) { this._currentTime = value; this.__seeks.push(value); }
          load() { this.__loads++; this.error = null; this.paused = true; this._currentTime = 0; this.readyState = 0; this.currentSrc = ""; this.playbackRate = this.defaultPlaybackRate; if (this.src && !__media.deferMetadata) queueMicrotask(() => this.metadata()); }
          play() { this.__plays++; if (__media.rejectNextPlay) { __media.rejectNextPlay = false; this.paused = true; return Promise.reject(new DOMException("Synthetic autoplay policy rejection", "NotAllowedError")); } this.paused = false; this.dispatchEvent(new Event("play")); return Promise.resolve(); }
          pause() { this.paused = true; this.dispatchEvent(new Event("pause")); }
          metadata() { this.readyState = 4; this.currentSrc = this.src; this.dispatchEvent(new Event("loadedmetadata")); }
          removeAttribute(name) { if (name === "src") this.src = ""; }
        };
      } else window.Audio = function (...args) { const audio = new OriginalAudio(...args); audio.muted = true; __audios.push(audio); return audio; };
    }, { controlled, speed });
    await page.goto(`${base}/probe`); await page.waitForFunction(() => Boolean(window.fixture?.ready)); return page;
  }
}

function track(id) { return { id, title: `Synthetic ${id}`, artist: "Fixture", album: "Recovery", durationMs: 60000, streamUrl: `/synthetic/audio/${id}.wav`, fileName: `${id}.wav`, coverUrl: "" }; }
function harness() {
  return `<!doctype html><meta charset=utf-8><link rel=stylesheet href=/css/foundation.css><link rel=stylesheet href=/modules/music/styles/foundation.css><link rel=stylesheet href=/modules/music/styles/library.css><link rel=stylesheet href=/modules/music/styles/player.css><link rel=stylesheet href=/modules/music/styles/responsive.css><main><div id=statsRow></div><div id=workGrid></div></main><script type=module>
import {createMusicPage} from '/modules/music/music-page.js';
const tracks=${JSON.stringify([track("A"), track("B")])};
const state={activeView:'music',music:{mode:'library',data:{tracks,total:2,hasMore:false},summary:{totals:{tracks:2},roots:[]},artists:[],albums:[],hasMore:false,playlistsLoadedAt:Date.now(),smartPlaylistsLoadedAt:Date.now()}};
const api=async(url,options={})=>{const init={...options};if(options.method==='POST'&&url.split('?')[0].endsWith('/progress'))window.fixture?.writes.push({...options.body,accountOwner:globalThis.__fanhaoWebAccountContext?.owner,accountRevision:globalThis.__fanhaoWebAccountContext?.revision});if(init.body&&typeof init.body!=='string'){init.body=JSON.stringify(init.body);init.headers={'Content-Type':'application/json'};}const response=await fetch(url,init),data=await response.json();if(!response.ok)throw new Error(data.error||'Synthetic API failure');if(url.split('?')[0].endsWith('/progress-session'))window.fixture.claims++;if(data.track?.id==='B'&&window.fixture?.sharedSource)data.track.streamUrl=tracks[0].streamUrl;return data;};
const noop=()=>{};
const page=createMusicPage({api,state,els:{workGrid:document.querySelector('#workGrid'),statsRow:document.querySelector('#statsRow')},formatNumber:String,formatBytes:String,cancelScheduledWorkRendering:noop,disconnectPeopleIndexAutoload:noop,resetProgressiveCoverLoading:noop,hidePersonProfile:noop,setMainHeader:noop,openAdminScript:noop,pushRoute:noop,replaceRoute:noop,syncRouteAfterNavigation:noop});
window.fixture={state,page,ready:true,writes:[],claims:0};page.enter({skipRoute:true,deferInitialLoad:true});
</script>`;
}
function silentWav(seconds) {
  const rate = 8000, bytes = seconds * rate * 2, data = Buffer.alloc(44 + bytes);
  data.write("RIFF", 0); data.writeUInt32LE(36 + bytes, 4); data.write("WAVEfmt ", 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write("data", 36); data.writeUInt32LE(bytes, 40); return data;
}
function respond(res, body, type, status = 200) { if (!res.destroyed) { res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); } }
function json(res, body) { respond(res, JSON.stringify(body), "application/json"); }
async function readBody(req) { let body = ""; for await (const chunk of req) body += chunk; return JSON.parse(body || "{}"); }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const caseOption = process.argv.find(value => value.startsWith("--case="));
  await runMusicPlaybackRecoveryFixture({ casePattern: caseOption?.slice(7) || "" });
  if (!caseOption) {
    const source = fs.readFileSync(path.join(publicRoot, "modules/music/player/engine.js"), "utf8").replaceAll("\r\n", "\n");
    const actionsSource = fs.readFileSync(path.join(publicRoot, "modules/music/actions.js"), "utf8").replaceAll("\r\n", "\n");
    for (const negative of [
      { name: "terminal-media reload", casePattern: "native failed stream retries the same song through queue", marker: "if (audio.error && source && trackId) {", replacement: "if (false) {", failure: /explicit replay after a terminal media failure must request the same stream again/ },
      { name: "native default playback speed", casePattern: "native playback speed survives selecting the next song", marker: "audio.defaultPlaybackRate = rate;", replacement: "", failure: /the next native song must play at the selected speed, matching its UI/ },
      { name: "initial user seek precedence", casePattern: "native initial metadata respects a newer keyboard seek 5s", marker: "// A user seek owns this load's start point, including an explicit zero.\n    // Native Audio retains that default start until metadata becomes ready.\n    restoreSavedPosition = false;", replacement: "", failure: /initial metadata must preserve a newer user seek instead of restoring the stale saved position/ },
      { name: "initial seek retry precedence", casePattern: "native initial seek remains current through an explicit failed-stream retry", marker: "metadataLoaded || !restoreSavedPosition ?", replacement: "metadataLoaded ?", failure: /an explicit retry must keep a newer initial seek rather than its stale saved point/ },
      { name: "failed native pause state", casePattern: "native failed stream retries the same song through toggle", marker: "if (!audio.paused) audio.pause();", replacement: "", failure: /the failed native element must be ready for a new play intent/ },
      { name: "retry listening point", casePattern: "retry metadata restores the listening point 42s", marker: "const position = pending ? pending.position : Number(music().current?.positionMs || 0) / 1000;", replacement: "const position = Number(music().current?.positionMs || 0) / 1000;", failure: /retry metadata must restore the pre-error listening point/ },
      { name: "pending retry progress", casePattern: "pause while retry metadata is pending cannot restart playback", marker: "if (Number.isFinite(position) && position > 0) audio.currentTime = position;", replacement: "", failure: /pausing a pending retry must not overwrite the listening point with an unloaded zero/ },
      { name: "retry account ownership", casePattern: "account owner change discards pending retry position", marker: "return account.owner === pending.account.owner && account.revision === pending.account.revision;", replacement: "return true;", failure: /an old account retry must not retain its default listening point or play intent/ },
      { name: "stale default start disposal", casePattern: "native account owner change cancels its old default start", marker: "audio.currentTime = 0;\n    audio.pause();", replacement: "audio.pause();", failure: /an old account default start must be removed and stay paused in native media/ },
      { name: "same-source retry disposal", casePattern: "native same-source new track discards an old default start and play intent", marker: "if (audio.src !== target || resettingStart) {", replacement: "if (audio.src !== target) {", failure: /same-source replacement must discard the old default start and pending play/ },
      { name: "same-source default clearing", casePattern: "native same-source new track discards an old default start and play intent", marker: "if (resettingStart) audio.currentTime = 0;", replacement: "", failure: /same-source replacement must discard the old default start and pending play/ },
      { name: "discarded source callback suppression", casePattern: "native account owner change cancels its old default start", marker: "sourceDiscarded = true;", replacement: "", failure: /discarding old native media must not save progress or played receipts for the new account/ },
      { name: "progress claim account ownership", path: "/modules/music/actions.js", source: actionsSource, casePattern: "account owner change discards pending retry position", marker: "checkProgressAccount(request);", replacement: "", failure: /discarding a pending retry must not write progress or played receipts using the new account/ },
      { name: "manual loop-all queue wrap", path: "/modules/music/actions.js", source: actionsSource, casePattern: "native queue loop-all next and previous wrap the boundaries", marker: 'const wrap = options.wrap ?? (music().repeat === "all");', replacement: "const wrap = options.wrap;", failure: /loop-all next at the last song must request the first queued song/ },
      { name: "new seek precedence", casePattern: "new seek while retry is pending takes precedence", marker: "if (retryPosition && isRetryPositionCurrent(retryPosition)) retryPosition.position = position;", replacement: "", failure: /retry must not overwrite a newer explicit seek/ }
    ]) {
      const owningSource = negative.source || source;
      assert.equal(owningSource.split(negative.marker).length - 1, 1, `negative must modify its current owning guard: ${negative.name}`);
      await assert.rejects(() => runMusicPlaybackRecoveryFixture({ casePattern: negative.casePattern, sourceOverrides: { [negative.path || "/modules/music/player/engine.js"]: owningSource.replace(negative.marker, negative.replacement) } }), { name: "AssertionError", message: negative.failure });
      console.log(`PASS negative control detects missing ${negative.name}`);
    }
  }
}
