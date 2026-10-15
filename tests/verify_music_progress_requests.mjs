import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright-core";
import { createMusicStore } from "../src/modules/music/server/store.js";
import { ensureSchema } from "../src/modules/music/server/schema.js";
import { writeScanRecords } from "../src/modules/music/server/scan.js";
import { routeMusicApi } from "../src/modules/music/server/routes.js";

// Actual music page/host, HTTP routes and store in a private Chromium context
// and SQLite. Audio events/time are controlled; no audio is fetched or decoded.
// --legacy loads the verified old revision's client modules against the current store.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(root, "public");
const legacyRevision = "1f6ddf213f0fbab4d417fdf61636b957d1909338";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function runMusicProgressFixture({ legacy = false, sourceOverrides = {}, casePattern = "" } = {}) {
  const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean).find(value => fs.existsSync(value));
  assert(executablePath, "private music progress fixture requires Chromium");
  const overrides = new Map(sourceOverrides instanceof Map ? sourceOverrides : Object.entries(sourceOverrides));
  if (legacy) for (const name of ["music-page.js", "actions.js", "api.js", "music-progress-writer.js"]) {
    const result = spawnSync("git", ["show", `${legacyRevision}:public/modules/music/${name}`], { cwd: root, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr); overrides.set(`/modules/music/${name}`, result.stdout);
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-music-progress-browser-"));
  const cases = [], gates = new Set(), faults = [], unexpected = [];
  let current = null, browser = null, checks = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture");
    const test = cases.find(value => value.number === Number(req.headers["x-fixture-case"])) || current;
    try {
      const progress = /^\/api\/music\/tracks\/([^/]+)\/progress$/.exec(url.pathname);
      const claim = /^\/api\/music\/tracks\/([^/]+)\/progress-session$/.exec(url.pathname);
      assert(req.method === "GET" || (req.method === "POST" && (progress || claim)), `unmodelled mutation: ${req.method} ${url.pathname}`);
      if (url.pathname.startsWith("/api/music/")) {
        assert(test, "music API must belong to a private case");
        let input = "";
        if (req.method === "POST") for await (const chunk of req) input += chunk;
        const body = input ? JSON.parse(input) : {};
        const trackMatch = /^\/api\/music\/tracks\/([^/]+)(?:\/(?:progress|progress-clock|progress-session))?$/.exec(url.pathname);
        const entry = { method: req.method, path: url.pathname, trackId: trackMatch ? decodeURIComponent(trackMatch[1]) : "", body, committed: false, status: 0, result: null, closed: false };
        test.requests.push(entry); if (progress) test.received.push(entry);
        const gate = [...gates].find(value => value.test === test && !value.used && value.match(entry));
        res.once("close", () => { entry.closed = true; });
        if (gate) { gate.used = true; gate.entry = entry; await gate.promise; }
        const handled = await routeMusicApi(req, res, url, {
          musicStore: timedStore(test), readJsonBody: async () => body,
          requireLocalAdmin: () => assert.fail("fixture does not authorize admin mutations"),
          notFound: target => sendJson(target, { error: "missing synthetic music" }, 404),
          sendJson(target, status, data) {
            entry.status = status; entry.result = data;
            if (progress && status === 200) { entry.committed = true; test.committed.push(entry); }
            sendJson(target, data, status);
          }
        });
        assert(handled, `actual music route must handle ${url.pathname}`); return;
      }
      if (url.pathname === "/probe") { sendText(res, harness(test.store.listTracks(new URL("http://fixture/api/music/tracks?limit=120"))), "text/html; charset=utf-8"); return; }
      if (url.pathname === "/left") { sendText(res, "<!doctype html><title>Left synthetic music</title>", "text/html"); return; }
      if (url.pathname === "/api/modules") { sendJson(res, { product: { id: "suite" }, modules: [] }); return; }
      if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/media/music")) throw new Error(`unmodelled private endpoint: ${url.pathname}`);
      if (url.pathname === "/assets/music/turntable-dark-v1.png") { sendText(res, '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#729b7c"/></svg>', "image/svg+xml"); return; }
      if (overrides.has(url.pathname)) { sendText(res, overrides.get(url.pathname), "text/javascript"); return; }
      const target = /^\/music(?:\/|$)/.test(url.pathname) ? path.join(publicRoot, "index.html") : path.resolve(publicRoot, url.pathname.replace(/^\/+/, ""));
      assert(target.startsWith(publicRoot + path.sep), "static fixture paths must stay inside public");
      sendText(res, await fs.promises.readFile(target), target.endsWith(".html") ? "text/html; charset=utf-8" : target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : "application/octet-stream");
    } catch (error) { unexpected.push(`${url.pathname}: ${error.message}`); sendJson(res, { error: error.message }, 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  async function run(name, task) {
    if (casePattern && !name.includes(casePattern)) return;
    const number = cases.length + 1, dbPath = path.join(temporary, `case-${number}.sqlite`);
    const database = new DatabaseSync(dbPath);
    try { ensureSchema(database); writeScanRecords(database, syntheticCatalog(temporary, number), [], "2026-10-04T00:00:00.000Z"); } finally { database.close(); }
    const store = createMusicStore({ dbPath, roots: [] }), context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const test = { number, dbPath, store, context, received: [], committed: [], requests: [] }; cases.push(test); current = test;
    try { await task(test); checks++; console.log(`PASS ${name}`); }
    catch (error) {
      console.error(JSON.stringify({ case: name, saved: Object.fromEntries(["A", "B"].map(id => { const value = saved(test, id); return [id, { positionMs: value.positionMs, playCount: value.playCount }]; })), packets: test.received.slice(-8).map(entry => ({ trackId: entry.trackId, body: entry.body, status: entry.status, progressApplied: entry.result?.progressApplied, playedApplied: entry.result?.playedApplied, code: entry.result?.code })), clocks: test.requests.filter(entry => /\/(?:progress-clock|progress-session)$/.test(entry.path)).slice(-6).map(entry => ({ trackId: entry.trackId, status: entry.status, serverClockMs: entry.result?.serverClockMs, sessionStartedAt: entry.result?.progressSessionStartedAt, closed: entry.closed })), faults, unexpected }, null, 2));
      throw error;
    }
    finally { for (const gate of gates) if (gate.test === test) gate.release(); await context.close(); }
  }
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    await run("actual host late normal cannot roll back pagehide latest position", async test => {
      const page = await newPage(test, { real: true }); let older;
      try {
        await play(page, 10); await until(() => saved(test, "A").playCount === 1, "normal played report must commit");
        older = hold(test, entry => entry.method === "POST" && entry.path.endsWith("/progress") && entry.trackId === "A" && !entry.body.played);
        await position(page, 10, true); await requested(older);
        await position(page, 90); await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide")));
        await until(() => saved(test, "A").positionMs === 90000, "latest pagehide packet must commit while older normal is held");
        const latest = test.committed.find(entry => entry.body.positionMs === 90000); assert(latest); fence(latest.body);
        older.release(); await completed(older);
        assert.equal(saved(test, "A").positionMs, 90000, "older normal packet must not roll back the actual SQLite position");
        assert.equal(saved(test, "A").playCount, 1); assert.equal(older.entry.result.progressApplied, false);
        assert.equal(latest.body.progressSessionId, older.entry.body.progressSessionId);
        assert(latest.body.progressSequence > older.entry.body.progressSequence);
        assert((await packets(page)).some(value => value.keepalive && value.body.positionMs === 90000));
      } finally { older?.release(); await page.close(); }
    });

    await run("real document leave saves pending played token before its timer turn", async test => {
      const page = await newPage(test, { real: true });
      try {
        await play(page, 21, { holdTimers: true });
        await page.waitForFunction(() => __blockedWriteTimers.size > 0);
        assert.equal(test.received.length, 0, "controlled writer timer has not sent a normal played/progress request");
        await page.goto(`${base}/left`);
        await until(() => saved(test, "A").positionMs === 21000 && saved(test, "A").playCount === 1, "real document leave must persist the pending position and played token through private loopback");
        assert(test.received.some(entry => entry.body.played));
        assert((await packets(page)).some(value => value.keepalive && value.body.played));
      } finally { await page.close(); }
    });

    await run("normal played and document leave duplicate receipt count once", async test => {
      const older = hold(test, entry => entry.method === "POST" && entry.trackId === "A" && entry.body.played), page = await newPage(test, { real: true });
      try {
        await play(page, 10); await requested(older); await position(page, 42); await page.goto(`${base}/left`);
        await until(() => saved(test, "A").positionMs === 42000 && saved(test, "A").playCount === 1, "leave must commit the final pending played receipt once");
        const duplicate = test.committed.find(entry => entry.body.played); assert(duplicate);
        assert.match(duplicate.body.playedReportId, uuid); assert.equal(duplicate.body.playedReportId, older.entry.body.playedReportId);
        older.release(); await completed(older);
        assert.equal(saved(test, "A").playCount, 1, "normal and leave packets must share one actual SQLite played receipt");
        assert.equal(saved(test, "A").positionMs, 42000);
      } finally { older.release(); await page.close(); }
    });

    await run("new document owns position while old played remains independent and explicit resume reclaims", async test => {
      const older = hold(test, entry => entry.method === "POST" && entry.trackId === "A" && entry.body.played), oldPage = await newPage(test);
      let newPageValue;
      try {
        await open(oldPage, "A"); await play(oldPage, 10); await requested(older);
        newPageValue = await newPage(test); await open(newPageValue, "A"); await play(newPageValue, 90);
        await until(() => saved(test, "A").positionMs === 90000 && saved(test, "A").playCount === 1, "new document must commit its distinct owner and played intent");
        const fresh = test.committed.find(entry => entry.body.played); fence(fresh.body);
        assert.notEqual(fresh.body.progressSessionId, older.entry.body.progressSessionId);
        assert(fresh.body.progressSessionStartedAt > older.entry.body.progressSessionStartedAt);
        older.release(); await completed(older);
        assert.equal(saved(test, "A").positionMs, 90000); assert.equal(saved(test, "A").playCount, 2, "a stale position owner must still contribute its distinct played receipt once");
        assert.equal(older.entry.result.progressApplied, false);
        await oldPage.evaluate(() => __audios[0].pause()); await play(oldPage, 30); await position(oldPage, 30, true);
        await until(() => saved(test, "A").positionMs === 30000, "an explicit old-tab resume must claim a fresh server-clock owner");
        const reclaimed = test.committed.findLast(entry => entry.body.positionMs === 30000);
        assert(reclaimed.body.progressSessionStartedAt > fresh.body.progressSessionStartedAt);
        assert.notEqual(reclaimed.body.progressSessionId, older.entry.body.progressSessionId);
        assert.equal(saved(test, "A").playCount, 2, "resuming the same loaded track must not invent another played intent");
      } finally { older.release(); await oldPage.close(); await newPageValue?.close(); }
    });

    await run("actual host route navigation preserves playing source and progress writes", async test => {
      const page = await newPage(test, { real: true });
      try {
        await play(page, 12); await until(() => saved(test, "A").playCount === 1, "playing report must persist");
        const before = await audioState(page);
        for (const target of ["/music/library", "/music/library?q=Track", "/music/artist/artist-A"]) {
          await page.evaluate(target => { history.pushState(null, "", target); dispatchEvent(new PopStateEvent("popstate")); }, target);
          await page.locator(".music-library-page").waitFor({ state: "visible" }); assert.deepEqual(await audioState(page), before);
        }
        await position(page, 55, true); await until(() => saved(test, "A").positionMs === 55000, "navigation must keep the playing track's progress writer alive");
        assert.equal(saved(test, "A").playCount, 1); assert.equal(new URL(page.url()).pathname, "/music/artist/artist-A");
      } finally { await page.close(); }
    });

    await run("late ignored-abort owner clock cannot attach old owner to new source", async test => {
      const oldClock = hold(test, entry => entry.method === "POST" && entry.path === "/api/music/tracks/A/progress-session"), page = await newPage(test, { ignoreAbort: true });
      try {
        await open(page, "A"); await play(page, 12); await requested(oldClock);
        await open(page, "B"); await play(page, 66); await until(() => saved(test, "B").playCount === 1, "new source must independently claim and save its playback owner");
        await stable(test);
        const newOwner = test.committed.findLast(entry => entry.trackId === "B"); fence(newOwner.body);
        const beforeLateClock = test.received.length;
        oldClock.release(); await until(() => oldClock.entry.status === 200, "obsolete source clock must eventually settle");
        await position(page, 70, true); await until(() => saved(test, "B").positionMs === 70000, "new source must remain writable after stale clock settles");
        assert.equal((await audioState(page)).current, "B");
        assert(test.committed.filter(entry => entry.trackId === "B" && test.received.indexOf(entry) >= beforeLateClock).every(entry => entry.body.progressSessionId === newOwner.body.progressSessionId));
        assert.equal(saved(test, "B").playCount, 1, "the old source clock must not invent another played intent for B");
      } finally { oldClock.release(); await page.close(); }
    });

    await run("pageshow resumes bounded writer work without replaying played receipt", async test => {
      const page = await newPage(test);
      try {
        await open(page, "A"); await play(page, 11); await until(() => saved(test, "A").playCount === 1, "initial played receipt must commit");
        await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
        const before = test.received.length;
        await page.evaluate(() => { dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); });
        await position(page, 61, true); await until(() => saved(test, "A").positionMs === 61000, "pageshow must release the writer for later visible saves");
        await stable(test); assert(test.received.length - before <= 3, "pageshow must not duplicate listeners or replay an unbounded write backlog");
        assert.equal(saved(test, "A").playCount, 1);
      } finally { await page.close(); }
    });

    await run("expired owner renews latest position without counting old played again", async test => {
      const page = await newPage(test); let clock;
      try {
        await open(page, "A"); await play(page, 15); await until(() => saved(test, "A").playCount === 1, "initial played receipt must persist");
        await stable(test);
        const initial = test.committed.findLast(entry => entry.trackId === "A").body;
        advanceClock(test, initial.progressSessionStartedAt + 24 * 60 * 60 * 1000 + 1);
        clock = hold(test, entry => entry.method === "POST" && entry.path === "/api/music/tracks/A/progress-session");
        await position(page, 35, true); await requested(clock); await position(page, 83, true); clock.release();
        await until(() => saved(test, "A").positionMs === 83000, "fresh expired-owner claim must retain the latest position sampled while POST waits");
        const renewed = test.committed.findLast(entry => entry.body.positionMs === 83000); fence(renewed.body);
        assert.notEqual(renewed.body.progressSessionId, initial.progressSessionId);
        assert(renewed.body.progressSessionStartedAt >= initial.progressSessionStartedAt + 24 * 60 * 60 * 1000 + 1);
        assert.equal(saved(test, "A").playCount, 1, "clock renewal must not re-mark the already acknowledged played intent");
      } finally { clock?.release(); await page.close(); }
    });

    await run("frozen server time reserves distinct document births and reuses active claims within slots", async test => {
      // Only synchronous actual store calls see the controlled server clock;
      // browser clocks, request scheduling and fixture deadlines remain real.
      test.serverNow = Date.now();
      const older = hold(test, entry => entry.method === "POST" && entry.trackId === "A" && entry.body.played);
      const oldPage = await newPage(test); let newerPage;
      try {
        await open(oldPage, "A"); await play(oldPage, 10, { holdTimers: true });
        await oldPage.waitForFunction(() => __blockedWriteTimers.size > 0);
        await until(() => test.requests.some(entry => entry.path.endsWith("/progress-session") && entry.status === 200), "first document must reserve its real server session");
        const oldClaim = test.requests.find(entry => entry.path.endsWith("/progress-session")).result;
        await untilBrowserOwner(oldPage, oldClaim.progressSessionId); await releaseTimers(oldPage); await requested(older);
        assert.equal(older.entry.body.progressSessionId, oldClaim.progressSessionId);
        newerPage = await newPage(test); await open(newerPage, "A"); await play(newerPage, 90, { holdTimers: true });
        await until(() => test.requests.filter(entry => entry.path.endsWith("/progress-session") && entry.status === 200).length === 2, "second document must reserve a fresh real server session");
        const newClaim = test.requests.filter(entry => entry.path.endsWith("/progress-session")).at(-1).result;
        assert.match(newClaim.progressSessionId, uuid); assert.notEqual(newClaim.progressSessionId, oldClaim.progressSessionId);
        assert(newClaim.progressSessionStartedAt > oldClaim.progressSessionStartedAt, "durable reserve must allocate distinct born values while Date.now is unchanged");
        await untilBrowserOwner(newerPage, newClaim.progressSessionId); await releaseTimers(newerPage);
        await until(() => saved(test, "A").positionMs === 90000 && saved(test, "A").playCount === 1, "the later reserved document must own the current position");
        older.release(); await completed(older); await stable(test);
        assert.equal(saved(test, "A").positionMs, 90000, "older reserved packet must not reclaim the later position under equal wall clock");
        assert.equal(saved(test, "A").playCount, 2); assert.equal(older.entry.result.progressApplied, false);
        const before = sessionCount(test);
        const reused = await newerPage.evaluate(async sessionId => {
          const values = [];
          for (let index = 0; index < 140; index++) {
            const response = await fetch('/api/music/tracks/A/progress-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ previousSessionId: sessionId }) });
            values.push({ status: response.status, ...await response.json() });
          }
          return values;
        }, newClaim.progressSessionId);
        assert(reused.every(value => value.status === 200 && value.progressSessionId === newClaim.progressSessionId && value.progressSessionStartedAt === newClaim.progressSessionStartedAt), "active owner claims must return the existing server identity");
        assert.equal(sessionCount(test), before, "more than 128 active reclaims must not consume additional retained session slots");
        assert.equal(saved(test, "A").positionMs, 90000); assert.equal(saved(test, "A").playCount, 2);
      } finally { older.release(); await oldPage.close(); await newerPage?.close(); }
    });
    assert(checks > 0, `no music progress cases matched: ${casePattern}`); assert.deepEqual(faults, [], "actual client errors must not be hidden"); assert.deepEqual(unexpected, []);
    console.log(`Music progress fixture passed (${checks} cases; actual Chromium/page/HTTP/store/private SQLite, controlled Audio without decoding)`); return { checks };
  } finally {
    for (const gate of gates) gate.release(); if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const test of cases) await test.store.stop();
    const resolved = fs.realpathSync(temporary); assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase()); assert(path.basename(resolved).startsWith("fanhao-music-progress-browser-"));
    for (const name of fs.readdirSync(resolved)) { const file = path.resolve(resolved, name); assert.equal(path.dirname(file), resolved); assert(fs.lstatSync(file).isFile()); fs.unlinkSync(file); } fs.rmdirSync(resolved);
  }

  function hold(test, match) { let release; const gate = { test, match, used: false, entry: null, promise: new Promise(resolve => { release = resolve; }), release }; gates.add(gate); return gate; }
  async function newPage(test, { real = false, ignoreAbort = false } = {}) {
    const page = await test.context.newPage(); page.on("pageerror", error => faults.push(error.message));
    await page.route(url => url.origin !== base, route => { unexpected.push(`blocked outside fixture: ${new URL(route.request().url()).origin}`); return route.abort(); });
    await page.addInitScript(({ number, ignoreAbort }) => {
      window.__audios = []; window.__packetsKey = `fixture.music.packets.${number}`; window.__blockedWriteTimers = new Map(); window.__holdWriteTimers = false;
      const nativeSetTimeout = window.setTimeout.bind(window), nativeClearTimeout = window.clearTimeout.bind(window); let blockedId = -1;
      window.setTimeout = (callback, delay, ...args) => {
        if (__holdWriteTimers && new Error().stack.includes("music-progress-writer.js")) { const id = blockedId--; __blockedWriteTimers.set(id, { callback, delay, args }); return id; }
        return nativeSetTimeout(callback, delay, ...args);
      };
      window.clearTimeout = id => { if (id < 0) __blockedWriteTimers.delete(id); else nativeClearTimeout(id); };
      class ControlledAudio extends EventTarget {
        constructor() { super(); this.src = ""; this.paused = true; this.currentTime = 0; this.duration = 180; this.loads = 0; this.volume = .82; this.playbackRate = 1; this.readyState = 4; this.preload = "metadata"; __audios.push(this); }
        load() { this.loads++; this.currentTime = 0; this.paused = true; queueMicrotask(() => this.dispatchEvent(new Event("loadedmetadata"))); }
        play() { this.paused = false; this.dispatchEvent(new Event("play")); return Promise.resolve(); }
        pause() { this.paused = true; this.dispatchEvent(new Event("pause")); }
        removeAttribute(name) { if (name === "src") this.src = ""; }
        get currentSrc() { return this.src; }
      }
      window.Audio = ControlledAudio; window.AudioContext = undefined; window.webkitAudioContext = undefined;
      const original = window.fetch.bind(window);
      window.fetch = async (url, options = {}) => {
        const target = new URL(String(url), location.href), headers = new Headers(options.headers); headers.set("X-Fixture-Case", String(number));
        if (/\/progress$/.test(target.pathname)) {
          const packets = JSON.parse(localStorage.getItem(__packetsKey) || "[]"); packets.push({ body: typeof options.body === "string" ? JSON.parse(options.body) : options.body, keepalive: Boolean(options.keepalive) }); localStorage.setItem(__packetsKey, JSON.stringify(packets));
        }
        const response = await original(url, { ...options, headers, ...(ignoreAbort ? { signal: undefined } : {}) });
        if (response.ok && /\/progress-session$/.test(target.pathname)) {
          const readJson = response.json.bind(response);
          response.json = async () => { const data = await readJson(); window.__lastClaimOwner = data.progressSessionId; return data; };
        }
        return response;
      };
    }, { number: test.number, ignoreAbort });
    await page.goto(real ? `${base}/music/track/A` : `${base}/probe`);
    await page.waitForFunction(real ? () => !document.documentElement.classList.contains("app-module-loading") && document.querySelector(".music-stage-meta h2")?.textContent === "Track A" : () => window.fixture?.ready);
    return page;
  }
}

function saved(test, id) { const track = test.store.trackDetail(id)?.track; assert(track, "private synthetic track must exist"); return track; }
function timedStore(test) {
  if (!Number.isSafeInteger(test.serverNow)) return test.store;
  return new Proxy(test.store, { get(target, name) {
    const value = target[name]; if (typeof value !== "function") return value;
    return (...args) => { const original = Date.now; Date.now = () => test.serverNow; try { return value.apply(target, args); } finally { Date.now = original; } };
  } });
}
function sessionCount(test) { const db = new DatabaseSync(test.dbPath, { readOnly: true }); try { return db.prepare("SELECT COUNT(*) AS count FROM music_progress_sessions WHERE track_id='A'").get().count; } finally { db.close(); } }
function fence(body) { assert.match(body.progressSessionId, uuid); assert(Number.isSafeInteger(body.progressSessionStartedAt)); assert(Number.isSafeInteger(body.progressSequence) && body.progressSequence > 0); }
async function open(page, id) { await page.evaluate(id => fixture.page.openTrack(id, { autoplay: false, skipRoute: true, openPage: true }), id); }
async function play(page, seconds, { holdTimers = false } = {}) { await page.evaluate(({ seconds, holdTimers }) => { __holdWriteTimers = holdTimers; __audios[0].currentTime = seconds; return __audios[0].play(); }, { seconds, holdTimers }); }
async function releaseTimers(page) { await page.evaluate(() => { __holdWriteTimers = false; const timers = [...__blockedWriteTimers.values()]; __blockedWriteTimers.clear(); for (const value of timers) value.callback(...value.args); }); }
async function untilBrowserOwner(page, id) { await page.waitForFunction(id => window.__lastClaimOwner === id, id); }
async function position(page, seconds, pause = false) { await page.evaluate(({ seconds, pause }) => { __audios[0].currentTime = seconds; __audios[0].dispatchEvent(new Event("timeupdate")); if (pause) __audios[0].pause(); }, { seconds, pause }); }
async function audioState(page) { return page.evaluate(() => ({ current: window.fixture?.state.music.current?.id || new URL(__audios[0].src).pathname.split("/").at(-1), src: __audios[0].src, currentTime: __audios[0].currentTime, paused: __audios[0].paused, loads: __audios[0].loads })); }
async function packets(page) { return page.evaluate(() => JSON.parse(localStorage.getItem(__packetsKey) || "[]")); }
async function requested(gate) { await until(() => gate.used, "controlled actual music request did not arrive"); }
async function completed(gate) { await until(() => gate.entry.committed || gate.entry.status >= 400, "held actual music progress route did not finish"); assert.equal(gate.entry.status, 200); }
async function until(predicate, message) { const deadline = Date.now() + 7000; while (!predicate()) { assert(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 10)); } }
async function stable(test) { let count = test.received.length, last = Date.now(); const deadline = Date.now() + 5000; while (Date.now() - last < 350) { assert(Date.now() < deadline, "writer queue must drain in bounded time"); await new Promise(resolve => setTimeout(resolve, 20)); if (test.received.length !== count) { count = test.received.length; last = Date.now(); } } }
function advanceClock(test, value) { const db = new DatabaseSync(test.dbPath); try { db.prepare("INSERT INTO music_meta(key,value) VALUES ('progress_clock_ms',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(value)); } finally { db.close(); } }
function sendText(res, body, type) { if (res.destroyed) return; res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); }
function sendJson(res, body, status = 200) { if (res.destroyed) return; res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); }
function syntheticCatalog(directory, number) {
  const result = { artists: [], albums: [], tracks: [], lyrics: [] }, updatedAt = "2026-10-04T00:00:00.000Z";
  for (const id of ["A", "B"]) {
    result.artists.push({ id: `artist-${id}`, name: `Artist ${id}`, sortName: id, language: "中文", sourceRoot: directory, sourcePath: path.join(directory, `case-${number}-artist-${id}`), relativePath: id, albumCount: 1, trackCount: 1, durationMs: 180000, sizeBytes: 1, updatedAt });
    result.albums.push({ id: `album-${id}`, artistId: `artist-${id}`, title: `Album ${id}`, sortTitle: id, year: "2026", coverPath: "", introPath: "", introText: "", sourceRoot: directory, sourcePath: path.join(directory, `case-${number}-album-${id}`), relativePath: id, trackCount: 1, durationMs: 180000, sizeBytes: 1, updatedAt });
    result.tracks.push({ id, artistId: `artist-${id}`, albumId: `album-${id}`, title: `Track ${id}`, sortTitle: id, displayArtist: `Artist ${id}`, albumTitle: `Album ${id}`, trackNo: 1, discNo: 1, genre: "Synthetic", language: "中文", sourceRoot: directory, sourcePath: path.join(directory, `case-${number}-${id}.synthetic`), relativePath: `${id}.synthetic`, fileName: `${id}.synthetic`, ext: ".synthetic", sizeBytes: 1, mtimeMs: 1, durationMs: 180000, codec: "synthetic", sampleRate: 44100, bitDepth: 16, channels: 2, lrcPath: "", hasLrc: 1, status: "ok", error: "", updatedAt });
    result.lyrics.push({ trackId: id, lrcPath: "", rawText: `Lyric ${id}`, parsedJson: JSON.stringify([{ timeMs: 0, text: `Lyric ${id}` }, { timeMs: 10000, text: `Second ${id}` }]), updatedAt });
  }
  return result;
}
function harness(data) {
  return `<!doctype html><meta charset=utf-8><link rel=stylesheet href=/css/foundation.css><link rel=stylesheet href=/modules/music/styles/foundation.css><link rel=stylesheet href=/modules/music/styles/library.css><link rel=stylesheet href=/modules/music/styles/player.css><link rel=stylesheet href=/modules/music/styles/responsive.css><main><div id=statsRow></div><div id=workGrid></div></main><script type=module>
import {createMusicPage} from '/modules/music/music-page.js';import {routeUrl} from '/js/router.js';
const state={activeView:'music',music:{mode:'library',data:${JSON.stringify(data)},summary:${JSON.stringify(data.summary)},artists:${JSON.stringify(data.artists)},albums:${JSON.stringify(data.albums)},playlistsLoadedAt:Date.now(),smartPlaylistsLoadedAt:Date.now()}},noop=()=>{};
const api=async(url,options={})=>{const init={...options};if(init.body&&typeof init.body!=='string'){init.body=JSON.stringify(init.body);init.headers={'Content-Type':'application/json'}}const res=await fetch(url,init),data=await res.json();if(!res.ok)throw Object.assign(new Error(data.error||'controlled error'),{status:res.status,statusCode:res.status,code:data.code,retryable:data.retryable,payload:data});return data};
const route=(overrides={})=>history.replaceState(null,'',routeUrl({view:'music',musicMode:state.music.mode,musicTrackId:state.music.trackPageOpen?state.music.current?.id:'',...overrides}));
const page=createMusicPage({api,state,els:{workGrid:document.querySelector('#workGrid'),statsRow:document.querySelector('#statsRow')},formatNumber:String,formatBytes:String,cancelScheduledWorkRendering:noop,disconnectPeopleIndexAutoload:noop,resetProgressiveCoverLoading:noop,hidePersonProfile:noop,setMainHeader:noop,openAdminScript:noop,pushRoute:route,replaceRoute:route,syncRouteAfterNavigation:options=>{if(!options?.skipRoute)route(options?.routeOverrides)}});window.fixture={state,page,ready:true};page.enter({skipRoute:true,deferInitialLoad:true});</script>`;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runMusicProgressFixture({ legacy: process.argv.includes("--legacy"), casePattern: process.argv.find(value => value.startsWith("--case="))?.slice(7) || "" });
