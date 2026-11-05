import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { chromium } from "playwright-core";

// Full Android index/app/adapter/current CSS and native DOM/images. Only Audio
// and synthetic loopback API bytes are controlled; no real service/media/DB.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const www = path.join(project, "android-client/www"), before = "bfb83068";
const hashes = { "/app.js": "b1bba65873c8686d1c2cbcb9080c217547fd6de43b8af371fc1137b284e79b2b",
  "/modules/music/music-views.js": "404dd40bfc0d994041bfa095a10cf2e254574ca662bfd7602f7e71431df778ba" };
const oldSources = {}, currentSources = {};
for (const [url, hash] of Object.entries(hashes)) {
  oldSources[url] = execFileSync("git", ["show", `${before}:android-client/www${url}`], { cwd: project, encoding: "utf8" }).replaceAll("\r\n", "\n");
  assert.equal(createHash("sha256").update(oldSources[url]).digest("hex"), hash, `fixed complete ${url}`);
  currentSources[url] = fs.readFileSync(path.join(www, url), "utf8").replaceAll("\r\n", "\n");
}
assert.ok(process.argv.slice(2).every(value => value === "--legacy-background" || value.startsWith("--case=")));
const negative = process.argv.includes("--legacy-background"), pattern = process.argv.find(value => value.startsWith("--case="))?.slice(7) || "";
assert.ok(!pattern || ["scale", "updates", "retirement", "owner"].includes(pattern), "known bounded case");
if (negative) {
  const marker = "  function reuseMountedMusicBackground() {";
  assert.equal(currentSources["/modules/music/music-views.js"].split(marker).length, 2);
  currentSources["/modules/music/music-views.js"] = currentSources["/modules/music/music-views.js"].replace(marker, `${marker}\n    return false; // Only restore the full-background fallback.`);
}
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(fs.existsSync);
assert.ok(executablePath, "installed private Chromium required");
let browser, sequence = 0, comparisons = 0;
const failures = [], surfaces = [];
function track(index, prefix = "") {
  return { id: `${prefix}T${index + 1}`, title: `合成歌曲 ${String(index + 1).padStart(4, "0")}`, artist: `合成歌手 ${index % 2}`,
    artistId: `S${index % 2}`, album: "合成专辑", albumId: "A", fileName: `T${index + 1}.mp3`, durationMs: 180000,
    streamUrl: `/synthetic/audio/T${index + 1}`, coverUrl: `/synthetic/cover-${index}.svg`, favorite: false, rating: 0 };
}
function startup() {
  localStorage.setItem("fanhao.serverUrl", location.origin);
  localStorage.setItem("fanhao.android.lastView", JSON.stringify({ view: "music", params: { mode: "library", dashboard: "0" } }));
  window.__musicAudit = { realm: crypto.randomUUID(), rows: 0, elements: 0, audios: [], intervals: [], bindings: new WeakMap(), host: null, read: null, api: null };
  class AudioDouble extends EventTarget {
    constructor() { super(); this.src = ""; this.paused = true; this.currentTime = 0; this.duration = 180; this.readyState = 4; this.volume = .8; this.playbackRate = 1; __musicAudit.audios.push(this); }
    load() { this.currentTime = 0; this.paused = true; queueMicrotask(() => this.dispatchEvent(new Event("loadedmetadata"))); }
    play() { this.paused = false; this.dispatchEvent(new Event("play")); return Promise.resolve(); }
    pause() { this.paused = true; this.dispatchEvent(new Event("pause")); }
    removeAttribute(name) { if (name === "src") this.src = ""; }
    get currentSrc() { return this.src; }
  }
  window.Audio = AudioDouble; window.AudioContext = undefined; window.webkitAudioContext = undefined;
  const create = document.createElement;
  document.createElement = function (...args) { __musicAudit.elements++; return create.apply(this, args); };
  const interval = window.setInterval;
  window.setInterval = function (callback, delay, ...args) { const id = interval.call(this, callback, delay, ...args); __musicAudit.intervals.push({ id, callback, delay }); return id; };
}
function instrument(source, url) {
  if (url === "/app.js") {
    const marker = "function createAndroidModuleHost() {\n  return Object.freeze({";
    assert.equal(source.split(marker).length, 2);
    return source.replace(marker, "function createAndroidModuleHost() {\n  window.__musicAudit.updateServer = updateServer;\n  return window.__musicAudit.host = Object.freeze({");
  }
  const start = "export function createMusicViews(deps) {", row = "  function renderTrackRow(track, index, options = {}) {";
  assert.equal(source.split(start).length, 2); assert.equal(source.split(row).length, 2);
  source = source.replace(start, `${start}\n  window.__musicAudit.read = () => ({ state, audio, progressBindings });\n  window.__musicAudit.invoke = { sleep: value => setSleepTimer(value) };`)
    .replace(row, `${row}\n    window.__musicAudit.rows++;`);
  const card = '    row.dataset.trackId = track.id || "";';
  assert.equal(source.split(card).length, 2);
  source = source.replace(card, `${card}\n    window.__musicAudit.bindings.set(row, track);`);
  const error = "    onError(error, record) {";
  assert.equal(source.split(error).length, 2);
  source = source.replace(error, "    onError: window.__musicAudit.reportError = function (error, record) {");
  const returned = "  return {\n    closeFullscreen,"; assert.equal(source.split(returned).length, 2);
  return source.replace(returned, "  return window.__musicAudit.api = {\n    closeFullscreen,");
}
async function surface(sources) {
  const cases = new Map(), held = new Set(); let otherServer;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture"), f = cases.get(req.headers["x-fixture-case"]), p = url.pathname.replace(/^\/source-two/, "");
    const sourceTwo = req.socket.localPort === otherServer?.address()?.port;
    const send = (body, type = "application/json", status = 200) => { if (!res.destroyed) { res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "*" }); res.end(body); } };
    try {
      if (req.method === "OPTIONS") return send("", "text/plain", 204);
      if (p.startsWith("/api/")) {
        assert.ok(f); const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
        const record = { path: p, query: Object.fromEntries(url.searchParams), method: req.method, body, rows: 0 }; f.requests.push(record);
        const summary = { totals: { tracks: f.tracks.length, artists: 2, albums: 1, durationMs: f.tracks.length * 180000 }, roots: [], recent: [], topPlayed: [] };
        let payload = {};
        if (p === "/api/music/tracks") {
          assert.equal(req.method, "GET");
          let tracks = f.tracks;
          if (sourceTwo) tracks = tracks.map(value => ({ ...value, title: `另一来源 ${value.title}` }));
          if (url.searchParams.get("q")) tracks = tracks.filter(value => value.title.includes(url.searchParams.get("q")));
          if (url.searchParams.get("artist")) tracks = tracks.filter(value => value.artistId === url.searchParams.get("artist"));
          if (url.searchParams.get("favorite")) tracks = tracks.filter(value => value.favorite);
          const limit = Number(url.searchParams.get("limit") || 80), offset = Number(url.searchParams.get("offset") || 0);
          payload = { tracks: tracks.slice(offset, offset + limit), summary, total: tracks.length, offset, limit, nextOffset: Math.min(tracks.length, offset + limit),
            hasMore: offset + limit < tracks.length, artists: [], albums: [], genres: [], languages: [] }; record.rows = payload.tracks.length;
        } else if (/^\/api\/music\/tracks\/T\d+$/.test(p)) { assert.equal(req.method, "GET"); payload = { track: f.tracks.find(value => value.id === p.split("/").at(-1)), lyrics: f.lyrics || { lines: [], raw: "" } }; }
        else if (/^\/api\/music\/tracks\/T\d+\/(?:favorite|rating|progress|progress-session)$/.test(p)) {
          assert.equal(req.method, "POST"); const id = p.split("/").at(-2), value = f.tracks.find(value => value.id === id);
          if (p.endsWith("/favorite")) value.favorite = Boolean(body.favorite);
          if (p.endsWith("/rating")) value.rating = Number(body.rating || 0);
          payload = p.endsWith("/progress-session") ? { progressSessionStartedAt: Date.UTC(2026, 10, 5), progressSessionId: `synthetic-session-${++f.sessions}` } : { track: value, ok: true };
        } else if (p === "/api/music/smart-playlists") payload = { smartPlaylists: [] };
        else if (p === "/api/music/playlists") payload = { playlists: [] };
        else if (p === "/api/music/artists") payload = { artists: [], total: 0, summary };
        else if (p === "/api/music/albums") payload = { albums: [], total: 0, summary };
        else if (p === "/api/music/summary") payload = summary;
        else if (p === "/api/library") payload = { people: [], works: [], totals: { people: 0, works: 0, videos: 0, infoFiles: 0 }, user: { favorites: [], historyCount: 0 }, availableRoots: [], access: { mode: "loopback" } };
        else if (p === "/api/modules") payload = { modules: [] };
        else if (p === "/api/accounts/status") payload = { user: f.accountId ? { id: f.accountId, username: "Synthetic" } : null, accountLoginRequired: false, registrationEnabled: true };
        else if (p === "/api/auth/status") payload = { authenticated: Boolean(f.accountId), user: f.accountId ? { id: f.accountId, username: "Synthetic" } : null };
        else if (p === "/api/history") payload = { works: [], total: 0 };
        else if (p === "/api/favorites/folders") payload = { folders: [] };
        else if (p === "/api/system/control") payload = { ok: true, platform: "unsupported", actions: [] };
        else if (p === "/api/android/update") payload = { available: false, versionCode: 0 };
        else if (p.endsWith("/summary")) payload = { totals: {}, items: [], channels: [] };
        else failures.push(`unmodelled API ${req.method} ${p}`);
        const gate = f.holds.find(value => !value.used && value.match(url));
        if (gate) { gate.used = true; held.add(gate); gate.requested(); await gate.promise; held.delete(gate); }
        return send(JSON.stringify(payload));
      }
      if (p.startsWith("/synthetic/audio/")) return send("controlled AudioDouble bytes", "audio/mpeg");
      if (p.startsWith("/synthetic/")) return send('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#888"/></svg>', "image/svg+xml");
      if (p === "/favicon.ico") return send("", "image/x-icon", 204);
      const relative = url.pathname === "/" ? "/index.html" : url.pathname, target = path.resolve(www, `.${relative}`); assert.ok(target.startsWith(`${www}${path.sep}`));
      let code = sources[relative] || fs.readFileSync(target);
      if (Object.hasOwn(hashes, relative)) code = instrument(code.toString().replaceAll("\r\n", "\n"), relative);
      if (relative === "/index.html") code = code.toString().replace("<head>", `<head><script>(${startup.toString()})()</script>`);
      send(code, relative.endsWith(".js") ? "text/javascript" : relative.endsWith(".css") ? "text/css" : relative.endsWith(".html") ? "text/html" : "application/octet-stream");
    } catch (error) { failures.push(`${url.pathname}: ${error.message}`); send(error.message, "text/plain", 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  otherServer = createServer(server.listeners("request")[0]);
  await new Promise(resolve => otherServer.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const result = { base, otherBase: `http://127.0.0.1:${otherServer.address().port}`, async open(count = 160) {
    const id = `case-${++sequence}`, f = { id, tracks: Array.from({ length: count }, (_, index) => track(index)), requests: [], sessions: 0, holds: [] };
    cases.set(id, f); f.context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, extraHTTPHeaders: { "X-Fixture-Case": id } });
    f.page = await f.context.newPage(); f.page.on("pageerror", error => failures.push(error.message));
    await f.page.route(new RegExp(`^https?://(?!127\\.0\\.0\\.1:(?:${server.address().port}|${otherServer.address().port})(?:/|$))`), route => route.abort());
    await f.page.goto(base, { waitUntil: "networkidle" }); await ready(f.page, Math.min(80, count));
    for (let visible = Math.min(80, count); visible < count;) {
      await f.page.evaluate(() => document.querySelector(".music-mobile-load-more").click()); visible = Math.min(count, visible + 80); await ready(f.page, visible);
    }
    return f;
  }, async close() { for (const gate of held) gate.release(); for (const value of [server, otherServer]) { value.closeAllConnections(); await new Promise(resolve => value.close(resolve)); } } };
  surfaces.push(result); return result;
}
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function ready(page, count) {
  await page.waitForFunction(count => document.querySelectorAll("#viewContent .music-mobile-list .music-mobile-track").length === count
    && !document.querySelector("#viewContent .music-mobile-load-more:disabled"), count, { timeout: 30000 }); await frames(page);
}
async function fullscreen(f, open) {
  await f.page.locator(open ? ".music-mobile-mini-open" : ".music-mobile-full-dismiss").focus(); await f.page.keyboard.press("Enter");
  await f.page.waitForFunction(open => Boolean(document.querySelector("#viewContent .music-mobile-full-player")) === open, open); await frames(f.page);
}
async function snapshot(page) {
  return page.evaluate(() => {
    const { state, audio } = __musicAudit.read(), full = document.querySelector("#viewContent .music-mobile-full-player");
    return { route: __musicAudit.host.navigation.currentParams(), title: document.querySelector("#viewTitle").textContent, meta: document.querySelector("#viewMeta").textContent,
      current: state.current, queue: state.queue.map(value => value.id), playing: state.playing, fullscreen: state.fullscreen,
      lyricFollowPaused: state.lyricFollowPaused, fullPanel: state.fullPanel, queueOpen: state.queueOpen,
      audio: { count: __musicAudit.audios.length, paused: audio.paused, time: audio.currentTime, rate: audio.playbackRate },
      rows: [...document.querySelectorAll("#viewContent .music-mobile-list .music-mobile-track")].map(row => ({ track: __musicAudit.bindings.get(row), text: row.textContent, className: row.className })),
      mini: document.querySelector("#viewContent .music-mobile-mini-player")?.textContent || "", fullText: full?.textContent || "",
      controls: [...(full?.querySelectorAll("button,input,select") || [])].map(node => ({ label: node.getAttribute("aria-label"), text: node.textContent,
        disabled: node.disabled, value: "value" in node ? node.value : null, type: node.type, title: node.title })), playerClass: document.body.classList.contains("music-player-open") };
  });
}
function compare(actual, expected, label) { assert.ok(isDeepStrictEqual(actual, expected), label); comparisons++; }
async function select(f, id = "T1") {
  await f.page.locator(`.music-mobile-list .music-mobile-track[data-track-id="${id}"]`).press("Enter");
  await f.page.waitForFunction(id => { const { state, audio } = __musicAudit.read(); return state.current?.id === id && !state.loading && !audio.paused; }, id);
  await frames(f.page);
}
async function press(f, selector) { await f.page.locator(selector).focus(); await f.page.keyboard.press("Enter"); await frames(f.page); }
async function both(old, next, action, label) {
  await action(old); await action(next); compare(await snapshot(next.page), await snapshot(old.page), label);
}
async function updates(oldSurface, nextSurface) {
  const old = await oldSurface.open(120), next = await nextSurface.open(120);
  try {
    for (const f of [old, next]) f.lyrics = { raw: "[00:00]合成歌词\n[00:01]下一句", lines: [{ timeMs: 0, text: "合成歌词" }, { timeMs: 1000, text: "下一句" }] };
    await both(old, next, f => select(f), "real row selection, audio and hydrated current track");
    await both(old, next, f => fullscreen(f, true), "playing track opens full player");
    await both(old, next, async f => {
      await f.page.locator(".music-mobile-progress.full input").evaluate(node => { node.value = "250"; node.dispatchEvent(new Event("input", { bubbles: true })); });
      await f.page.waitForFunction(() => __musicAudit.read().audio.currentTime === 45);
    }, "full progress seek retains audio and updates both progress surfaces");
    await both(old, next, async f => {
      await press(f, ".music-mobile-full-quick-actions .favorite");
      await f.page.waitForFunction(() => __musicAudit.read().state.current.favorite === true);
    }, "favorite response synchronizes current and background rows");
    await both(old, next, f => press(f, ".music-mobile-full-settings"), "playback settings open");
    await both(old, next, async f => {
      await press(f, '.music-mobile-playback-settings-sheet button[aria-label="设为 4 星"]');
      await f.page.waitForFunction(() => __musicAudit.read().state.current.rating === 4);
    }, "rating response updates retained background bindings");
    await both(old, next, f => press(f, ".music-mobile-playback-settings-close"), "settings close preserves full player");
    await both(old, next, f => press(f, ".music-mobile-full-queue"), "queue opens using current data");
    await both(old, next, f => press(f, ".music-mobile-queue-sheet .music-mobile-sheet-close"), "queue close returns to player");
    await both(old, next, async f => {
      await press(f, '.music-mobile-full-controls button[aria-label="下一首"]');
      await f.page.waitForFunction(() => __musicAudit.read().state.current?.id === "T2" && !__musicAudit.read().state.loading);
      await frames(f.page);
    }, "track change while full updates current and visible background");
    await both(old, next, async f => { await f.page.evaluate(() => __musicAudit.invoke.sleep(10)); await frames(f.page); }, "sleep timer updates full player and metadata");
    await both(old, next, async f => { await f.page.evaluate(() => __musicAudit.intervals.filter(value => value.delay === 30000).at(-1).callback()); await frames(f.page); }, "actual sleep interval retains its ordinary full-render behavior");
    await both(old, next, f => fullscreen(f, false), "close exposes the latest track, rating and timer state");
    await both(old, next, async f => { await f.page.evaluate(() => __musicAudit.reportError({ code: "MUSIC_PROGRESS_CAPACITY", message: "合成进度容量已满" })); await fullscreen(f, true); }, "background capacity callback is visible on next presentation");
    await both(old, next, f => fullscreen(f, false), "capacity status remains visible after close");
    assert.equal(await next.page.locator("#viewMeta").textContent(), "合成进度容量已满");
    await next.page.evaluate(() => { window.__audioBefore = __musicAudit.read().audio; });
    for (let round = 0; round < 4; round++) { await fullscreen(next, true); await fullscreen(next, false); }
    const lifecycle = await next.page.evaluate(() => ({ same: window.__audioBefore === __musicAudit.read().audio,
      bindings: __musicAudit.read().progressBindings.length,
      connected: __musicAudit.read().progressBindings.every(binding => Object.values(binding).some(node => node?.isConnected)),
      full: document.querySelectorAll("#viewContent .music-mobile-full-player").length }));
    assert.deepEqual(lifecycle, { same: true, bindings: 1, connected: true, full: 0 }, "repeat close prunes removed full bindings without replacing audio");
    console.log("Music fullscreen current-state updates and audio/binding lifetime passed");
  } finally { await old.context.close(); await next.context.close(); }
}
async function retirement(surface) {
  const f = await surface.open(120);
  try {
    f.lyrics = { raw: "合成歌词", lines: [{ timeMs: 0, text: "合成歌词" }, { timeMs: 1000, text: "下一句" }] };
    await select(f); await fullscreen(f, true); await press(f, 'button[aria-label="切换到歌词"]');
    await f.page.evaluate(() => { window.__oldFull = document.querySelector("#viewContent .music-mobile-full-player"); });
    await fullscreen(f, false); await fullscreen(f, true);
    const before = await snapshot(f.page), requests = f.requests.length;
    await f.page.evaluate(() => {
      const current = document.querySelector("#viewContent .music-mobile-full-player"), retired = window.__oldFull;
      retired.hidden = true; current.parentElement.append(retired);
      const lines = retired.querySelector(".music-mobile-full-lyric-lines");
      lines.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 }));
      lines.dispatchEvent(new Event("touchstart", { bubbles: true, cancelable: true }));
      const input = retired.querySelector(".music-mobile-progress.full input"); input.value = "900"; input.dispatchEvent(new Event("input", { bubbles: true }));
      retired.querySelector('.music-mobile-full-controls button[aria-label="下一首"]').click();
      retired.querySelector(".music-mobile-full-dismiss").click();
      retired.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      retired.remove();
    });
    await frames(f.page); compare(await snapshot(f.page), before, "retired full reinserted under current shell cannot seek, navigate, close or pause lyric follow");
    assert.equal(f.requests.length, requests, "retired full sends no request");
    await f.page.evaluate(() => { window.__retiredShell = document.querySelector("#viewContent .music-mobile-shell"); __musicAudit.host.navigation.showView("history", {}); });
    await f.page.waitForFunction(() => __musicAudit.host.navigation.currentView() === "history" && !document.querySelector("#viewContent .music-mobile-shell"));
    assert.equal(await f.page.evaluate(() => __musicAudit.read().progressBindings.length), 0, "deactivate releases DOM bindings");
    await f.page.evaluate(() => __musicAudit.host.navigation.showView("music", { mode: "library", dashboard: "0" })); await ready(f.page, 80);
    const reopened = await snapshot(f.page), afterRoute = f.requests.length;
    await f.page.evaluate(() => {
      const old = window.__retiredShell; old.hidden = true; document.querySelector("#viewContent").append(old);
      old.querySelector(".music-mobile-mini-open").click(); old.querySelector(".music-mobile-track").click();
      old.querySelector(".music-mobile-full-controls button")?.click(); old.remove();
    });
    await frames(f.page); compare(await snapshot(f.page), reopened, "route retirement prevents reinserted old background controls from reopening or selecting");
    assert.equal(f.requests.length, afterRoute);
    console.log("Music fullscreen retired full/shell events and deactivate passed");
  } finally { await f.context.close(); }
}
async function owner(surface) {
  const f = await surface.open(120);
  try {
    await fullscreen(f, true);
    await f.page.evaluate(source => { window.__oldShell = document.querySelector("#viewContent .music-mobile-shell"); __musicAudit.updateServer(source); __musicAudit.host.ui.renderCurrentView(); }, surface.otherBase);
    await ready(f.page, 80);
    await f.page.waitForFunction(() => document.querySelector("#viewContent .music-mobile-list .music-mobile-track")?.textContent.includes("另一来源"));
    const current = await snapshot(f.page), sent = f.requests.length;
    await f.page.evaluate(() => { const old = window.__oldShell; old.hidden = true; document.querySelector("#viewContent").append(old); old.querySelector(".music-mobile-mini-open").click(); old.querySelector(".music-mobile-full-dismiss").click(); old.remove(); });
    await frames(f.page); compare(await snapshot(f.page), current, "source replacement retires connected old full/background controls"); assert.equal(f.requests.length, sent);
    await f.page.evaluate(() => { __musicAudit.updateServer(location.origin); __musicAudit.host.ui.renderCurrentView(); }); await ready(f.page, 80);
    await f.page.waitForFunction(() => !document.querySelector("#viewContent .music-mobile-list .music-mobile-track")?.textContent.includes("另一来源"));
    const realm = await f.page.evaluate(() => __musicAudit.realm);
    const auth = () => { globalThis.Capacitor = { Plugins: { FanHaoAuth: {
      getSession: async () => ({ token: localStorage.getItem("synthetic.fixture.session") || "" }),
      loginAccount: async () => { localStorage.setItem("synthetic.fixture.session", "usr.synthetic_A"); return { token: "usr.synthetic_A" }; }
    } } }; };
    await f.context.addInitScript(auth); await f.page.evaluate(auth); f.accountId = "syntheticA";
    const navigation = f.page.waitForNavigation({ waitUntil: "networkidle" });
    const login = f.page.evaluate(async () => { const { authenticateAccount } = await import("/js/server-auth.js"); const { fetchJson } = await import("/js/api.js"); await authenticateAccount(location.origin, "login", { username: "Synthetic" }); await fetchJson(location.origin, "/api/accounts/status"); })
      .catch(error => assert.match(error.message, /Execution context was destroyed|navigation/));
    await Promise.all([navigation, login]); await ready(f.page, 80);
    assert.notEqual(await f.page.evaluate(() => __musicAudit.realm), realm, "actual account switch destroys prior DOM/JS owner");
    await fullscreen(f, true); await fullscreen(f, false);
    console.log("Music fullscreen source and native-account document ownership passed");
  } finally { await f.context.close(); }
}
async function scale(oldSurface, nextSurface, count) {
  const old = await oldSurface.open(count), next = await nextSurface.open(count), budgets = [];
  try {
    compare(await snapshot(next.page), await snapshot(old.page), `initial ${count}-track actual entry`);
    for (let repeat = 0; repeat < 3; repeat++) for (const open of [true, false]) {
      for (const f of [old, next]) await f.page.evaluate(() => { __musicAudit.beforeRows = __musicAudit.rows; __musicAudit.beforeElements = __musicAudit.elements; });
      await fullscreen(old, open); await fullscreen(next, open);
      if (open && repeat === 0) for (const f of [old, next]) assert.equal(await f.page.locator(".music-mobile-full-backdrop img").evaluate(async node => { await node.decode(); return node.naturalWidth; }), 100, "native synthetic cover decodes without test src compensation");
      compare(await snapshot(next.page), await snapshot(old.page), `${count}-track ${open ? "open" : "close"} ${repeat}: complete state/background/full controls`);
      const read = async f => f.page.evaluate(() => ({ rows: __musicAudit.rows - __musicAudit.beforeRows, elements: __musicAudit.elements - __musicAudit.beforeElements }));
      const first = await read(old), second = await read(next); assert.equal(first.rows, count); budgets.push(second.rows);
      if (repeat === 2) console.log(`Music fullscreen ${count} ${open ? "open" : "close"}: rows ${first.rows} -> ${second.rows}, createElement ${first.elements} -> ${second.elements}`);
    }
    compare(next.requests.filter(value => value.path === "/api/music/tracks"), old.requests.filter(value => value.path === "/api/music/tracks"), "same initial offset GETs; full-screen presentation adds no request");
    return budgets;
  } finally { await old.context.close(); await next.context.close(); }
}
try {
  browser = await chromium.launch({ headless: true, executablePath });
  const oldSurface = await surface(oldSources), nextSurface = await surface(currentSources), budgets = [];
  if (!pattern || pattern === "scale") for (const count of [120, 1000, 3000]) budgets.push(...await scale(oldSurface, nextSurface, count));
  if (!pattern || pattern === "updates") await updates(oldSurface, nextSurface);
  if (!pattern || pattern === "retirement") await retirement(nextSurface);
  if (!pattern || pattern === "owner") await owner(nextSurface);
  assert.deepEqual(failures, []);
  for (const rows of budgets) assert.equal(rows, 0, "fullscreen presentation must not rebuild background track rows");
  console.log(`Android music fullscreen passed (${comparisons} complete actual-entry comparisons; synthetic APIs and controlled Audio only)`);
} finally { await browser?.close(); for (const owner of surfaces) await owner.close(); }
