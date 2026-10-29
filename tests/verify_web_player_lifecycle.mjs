import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { parsePlaybackTimeInput } from "../public/js/player-time-jump.js";

// Actual standalone player/DOM, private loopback and synthetic play-info only.
// Media callbacks and play promises are controlled; no video bytes are decoded.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(root, "public");
const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean).find(value => fs.existsSync(value));
assert(executablePath, "Chrome or Edge required for the private player fixture");

export async function runWebPlayerFixture({ sourceOverride = null, sourceOverrides = {}, casePattern = "", realPlyr = false } = {}) {
  const held = new Set(), faults = [], writes = [];
  const progressReceivers = new Set();
  const waitForProgressWrite = predicate => new Promise((resolve, reject) => {
    const receiver = { predicate, resolve: write => { clearTimeout(receiver.timer); resolve(write); } };
    receiver.timer = setTimeout(() => {
      progressReceivers.delete(receiver);
      reject(new assert.AssertionError({ message: "the final progress snapshot must reach the private server after navigation" }));
    }, 5000);
    progressReceivers.add(receiver);
  });
  let checks = 0;
  const work = { id: "fixture-work", title: "Synthetic player", relativePath: "fixture", videos: ["A", "B", "C"].map((id, index) => ({ id, name: `Video ${id}`, ext: ".mp4", playable: true, progress: { videoId: id, position: 31 + 42 * index, duration: 600 } })) };
  const info = (id, extra = {}) => ({ mode: "direct", streamUrl: `/synthetic/${id}`, fallbackStreamUrl: `/synthetic/${id}-compat`, duration: 600, label: `Direct ${id}`, ...extra });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture");
    const json = (payload, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
    try {
      const gate = [...held].find(value => !value.used && value.path === url.pathname);
      if (gate) {
        gate.used = true; gate.requestedResolve(); await gate.promise;
        if (res.destroyed) return;
        json(gate.payload || { error: "Synthetic play-info failure" }, gate.status); return;
      }
      if (url.pathname === "/api/works/fixture-work") { json({ work }); return; }
      if (url.pathname === "/api/gallery-media/media-fixture") { json({ item: { id: "media-fixture", title: "Synthetic media", mediaKind: "movie", videos: work.videos } }); return; }
      if (url.pathname === "/api/disk-usage/item") { json({ work: { ...work, diskUsage: true, videos: work.videos.map(video => ({ ...video, diskDrive: url.searchParams.get("drive"), diskPath: `fixture/${video.id}.mp4` })) } }); return; }
      if (url.pathname === "/api/disk-usage/playinfo") { const id = /([ABC])\.mp4$/.exec(url.searchParams.get("path") || "")?.[1] || "A"; json(info(id)); return; }
      if (url.pathname === "/api/works/fixture-work/move-job") { json({ job: null }); return; }
      const play = /^\/api\/playinfo\/([ABC])$/.exec(url.pathname);
      if (play) { json(info(play[1])); return; }
      if (url.pathname.startsWith("/api/progress/")) {
        let body = ""; for await (const chunk of req) body += chunk;
        const write = { path: url.pathname, body: JSON.parse(body) };
        writes.push(write);
        for (const receiver of progressReceivers) if (receiver.predicate(write)) {
          progressReceivers.delete(receiver); receiver.resolve(write);
        }
        json({}); return;
      }
      if (url.pathname === "/api/works/fixture-work/subtitles") {
        const id = url.searchParams.get("videoId");
        json({ tracks: realPlyr ? [{ id: `sub-${id}`, url: "/synthetic/subtitle.vtt", label: "Synthetic 中文", language: "zh", autoSelect: true }] : [] }); return;
      }
      if (url.pathname === "/synthetic/subtitle.vtt") { res.writeHead(200, { "content-type": "text/vtt" }); res.end("WEBVTT\n\n00:00:00.000 --> 00:10:00.000\nSynthetic subtitle\n"); return; }
      if (url.pathname.startsWith("/api/")) { faults.push(`unexpected API ${req.method} ${url.pathname}`); json({}, 404); return; }
      if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      if (url.pathname === "/fixture-away") { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>Away</title><p>Private navigation target</p>"); return; }
      if (sourceOverrides[url.pathname] !== undefined) { res.writeHead(200, { "content-type": "text/javascript" }); res.end(sourceOverrides[url.pathname]); return; }
      // Plyr is a UI boundary here; the real player page, controls and subtitle
      // module still run. Native media is controlled by the browser init script.
      if (!realPlyr && url.pathname === "/vendor/plyr/plyr.min.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(""); return; }
      if (url.pathname === "/js/player-page.js") {
        const source = sourceOverride || await fs.promises.readFile(path.join(publicRoot, "js/player-page.js"), "utf8");
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(source + "\nwindow.__stopPlayerForFixture = stopCurrentPlayback;\n"
          + `\nwindow.__refreshPlayerFilesForFixture = ({ remove = "", replaceOwner = false } = {}) => {
            const videos = currentWork.videos.filter(video => video.id !== remove).map(video => ({ ...video,
              name: video.id === "B" ? "Video B revised" : video.name,
              progress: video.id === "B" ? { videoId: "B", position: 166, duration: 600, percent: 27.6 } : video.progress }));
            if (replaceOwner) currentWork = { ...currentWork, videos }; else currentWork.videos = videos;
            renderFiles(currentWork);
          };\n`
          + (realPlyr ? "\nwindow.__playerHostVideo = () => els.video;\n" : "")); return;
      }
      const target = path.resolve(publicRoot, url.pathname.replace(/^\/+/, ""));
      assert(target.startsWith(`${publicRoot}${path.sep}`), "fixture static paths stay in public");
      const content = await fs.promises.readFile(target);
      res.writeHead(200, { "content-type": target.endsWith(".html") ? "text/html" : target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : "image/svg+xml" });
      res.end(content);
    } catch (error) { faults.push(error.message); if (!res.destroyed) json({ error: error.message }, 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  const hold = (id, payload, status = 200) => {
    let release, requestedResolve;
    const gate = { path: `/api/playinfo/${id}`, payload, status, used: false, promise: new Promise(resolve => { release = resolve; }), requested: new Promise(resolve => { requestedResolve = resolve; }), requestedResolve: () => requestedResolve(), release: () => { held.delete(gate); release(); } };
    held.add(gate); return gate;
  };
  const run = async (name, task) => { if (casePattern && !name.includes(casePattern)) return; await task(); checks++; console.log(`PASS ${name}`); };
  async function open(ignoreAbort = true, query = "", { waitForSource = true } = {}) {
    const page = await browser.newPage();
    page.on("pageerror", error => faults.push(String(error)));
    await page.addInitScript(({ ignoreAbort }) => {
      const states = new WeakMap();
      const state = media => { if (!states.has(media)) states.set(media, { src: "", paused: true, ready: 0, time: 0 }); return states.get(media); };
      window.__media = { seeks: [], plays: [], pending: [], holdPlay: false, duration: 600 };
      window.__copiedLinks = [];
      window.__clipboardPending = [];
      window.__clipboardDenied = false;
      window.__holdClipboard = false;
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText(value) {
        __copiedLinks.push(value);
        if (__holdClipboard) return new Promise((resolve, reject) => __clipboardPending.push({ resolve, reject }));
        return __clipboardDenied ? Promise.reject(new DOMException("Synthetic clipboard denial", "NotAllowedError")) : Promise.resolve();
      } } });
      Object.defineProperties(HTMLMediaElement.prototype, {
        src: { configurable: true, get() { return state(this).src; }, set(value) { Object.assign(state(this), { src: new URL(value, location.href).href, ready: 0, time: 0 }); } },
        currentSrc: { configurable: true, get() { return state(this).src; } },
        duration: { configurable: true, get() { return state(this).ready >= 1 ? __media.duration : NaN; } },
        readyState: { configurable: true, get() { return state(this).ready; } },
        paused: { configurable: true, get() { return state(this).paused; } },
        ended: { configurable: true, get() { return state(this).ready >= 1 && state(this).time >= __media.duration; } },
        currentTime: { configurable: true, get() { return state(this).time; }, set(value) { state(this).time = value; __media.seeks.push(value); } }
      });
      HTMLMediaElement.prototype.pause = function () { const s = state(this), changed = !s.paused; s.paused = true; if (changed) setTimeout(() => this.dispatchEvent(new Event("pause")), 0); };
      HTMLMediaElement.prototype.load = function () { Object.assign(state(this), { ready: 0, time: 0 }); };
      HTMLMediaElement.prototype.play = function () {
        if (this.ended) state(this).time = 0;
        state(this).paused = false; __media.plays.push(this.src); this.dispatchEvent(new Event("play"));
        if (!__media.holdPlay) return Promise.resolve();
        return new Promise((resolve, reject) => __media.pending.push({ resolve, reject }));
      };
      const removeAttribute = HTMLMediaElement.prototype.removeAttribute;
      HTMLMediaElement.prototype.removeAttribute = function (name) { if (name === "src") Object.assign(state(this), { src: "", ready: 0, time: 0 }); return removeAttribute.call(this, name); };
      window.__emitMedia = (type, dispatch = true) => {
        const video = document.querySelector("#playerVideo");
        if (type === "loadedmetadata") state(video).ready = 1;
        if (type === "canplay") state(video).ready = 4;
        if (dispatch) video.dispatchEvent(new Event(type));
      };
      const fetch = window.fetch.bind(window);
      window.__readSignals = [];
      window.__readFinished = [];
      window.__progressSends = [];
      window.fetch = (url, init = {}) => {
        if (String(url).includes("/api/progress/")) __progressSends.push({ path: String(url), body: JSON.parse(init.body), keepalive: init.keepalive === true });
        const playInfo = String(url).includes("/api/playinfo/");
        if (playInfo) {
          __readSignals.push(init.signal);
          if (ignoreAbort) { init = { ...init }; delete init.signal; }
        }
        const reading = fetch(url, init);
        if (!playInfo) return reading;
        return reading.then(async response => {
          await response.clone().arrayBuffer();
          __readFinished.push(String(url));
          return response;
        }, error => { __readFinished.push(String(url)); throw error; });
      };
    }, { ignoreAbort });
    await page.goto(`${base}/player.html?workId=fixture-work${query}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.documentElement.classList.contains("app-module-loading"));
    const initialId = new URLSearchParams(query).get("videoId");
    if (waitForSource) await sourceIs(page, ["A", "B", "C"].includes(initialId) ? initialId : "A");
    if (realPlyr && waitForSource) await page.waitForFunction(() => document.querySelector("#playerVideo")?.plyr?.ready);
    return page;
  }
  const sourceIs = (page, id) => page.waitForFunction(id => document.querySelector("#playerVideo").src.endsWith(`/synthetic/${id}`), id);
  const choose = (page, id) => page.locator(".player-file-button").filter({ hasText: `Video ${id}` }).click();
  const tick = page => page.evaluate(() => new Promise(resolve => setTimeout(resolve, 20)));
  async function probeFileList(page) {
    await page.evaluate(() => {
      window.__fileRows = [...document.querySelectorAll("#playerFiles .player-file-button")];
      window.__fileAddedElements = 0; window.__fileBlurs = 0;
      __fileRows[1].addEventListener("blur", () => __fileBlurs++);
      window.__fileObserver = new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) __fileAddedElements += 1 + node.querySelectorAll("*").length; });
      __fileObserver.observe(document.querySelector("#playerFiles"), { childList: true, subtree: true });
    });
  }
  try {
    await run("adjacent files navigate from the collapsed player with bounded native controls", async () => {
      const page = await open();
      try {
        await page.setViewportSize({ width: 320, height: 820 });
        assert.equal(await page.locator("#playerFileNavigation").count(), 1, "the standalone player must expose adjacent-file controls outside its sidebar");
        if (await page.locator("#toggleSidebarButton").getAttribute("aria-expanded") === "true") await page.locator("#toggleSidebarButton").click();
        const previous = page.locator("#playerFilePrevious"), next = page.locator("#playerFileNext");
        assert.equal(await previous.getAttribute("aria-disabled"), "true");
        await page.evaluate(() => { __emitMedia("loadedmetadata"); document.querySelector("#playerVideo").currentTime = 185; });
        await next.click();
        assert.equal(await page.locator("#playerFilePosition").textContent(), "2 / 3", "next-file action must select the following file synchronously");
        await sourceIs(page, "B"); await page.evaluate(() => __emitMedia("loadedmetadata"));
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 73);
        assert.equal(await page.evaluate(() => __progressSends.some(write => write.path.endsWith("/A") && write.body.position === 185)), true, "file navigation must flush the departing file's progress");
        assert.equal(await next.evaluate(button => document.activeElement === button), true);
        const boxes = await page.locator("#playerFileNavigation button").evaluateAll(buttons => buttons.map(button => { const box = button.getBoundingClientRect(); return [box.left >= 0 && box.right <= innerWidth, box.width >= 44 && box.height >= 44]; }));
        assert.deepEqual(boxes, [[true, true], [true, true]], "320px adjacent-file buttons must remain usable outside the hidden sidebar");
        await page.waitForFunction(() => document.querySelector("#playerSidebar").getBoundingClientRect().left >= innerWidth);
        await page.screenshot({ path: path.join(process.env.TEMP, "fanhao-player-adjacent-320.png") });
        await next.click(); await sourceIs(page, "C");
        assert.equal(await next.getAttribute("aria-disabled"), "true");
        assert.equal(await next.evaluate(button => document.activeElement === button), true, "a final-file boundary must retain keyboard focus");
        const reads = await page.evaluate(() => __readSignals.length);
        await page.evaluate(() => { __emitMedia("loadedmetadata"); const video = document.querySelector("#playerVideo"); video.muted = true; video.dataset.autoplayMuted = "1"; });
        await page.keyboard.press("Space"); await tick(page);
        assert.equal(await page.evaluate(() => __readSignals.length), reads, "the last file must not wrap to the first file");
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.muted), true, "an unavailable adjacent-file action must not restore autoplay audio");
        await previous.click(); await sourceIs(page, "B");
        await previous.click(); await sourceIs(page, "A");
        assert.equal(await previous.getAttribute("aria-disabled"), "true");
        await page.keyboard.press("Space"); await tick(page);
        assert.equal(await page.locator("#playerFilePosition").textContent(), "1 / 3");
        await page.evaluate(() => { __refreshPlayerFilesForFixture({ remove: "B" }); __refreshPlayerFilesForFixture({ remove: "C" }); });
        assert.equal(await page.locator("#playerFileNavigation").evaluate(group => group.hidden), true, "single-file works do not need file navigation controls");
      } finally { await page.close(); }
    });
    await run("adjacent files replace a pending gallery file without accepting its late response", async () => {
      const page = await open(true, "&mediaId=media-fixture"); const pending = hold("B");
      try {
        await page.locator("#playerFileNext").click(); await pending.requested;
        await page.locator("#playerFileNext").click(); await sourceIs(page, "C");
        pending.release(); await page.waitForFunction(() => __readFinished.some(path => path.includes("/playinfo/B"))); await tick(page);
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.src.endsWith("/synthetic/C")), true, "late preparation of the previous adjacent file must not replace the newer selection");
        assert.equal(await page.locator("#playerFilePosition").textContent(), "3 / 3");
        assert.equal(await page.locator(".player-file-button[aria-current='true']").textContent(), "Video C");
      } finally { pending.release(); await page.close(); }
    });
    await run("adjacent files use refreshed disk descriptors and current membership", async () => {
      const page = await open(true, "&diskDrive=C%3A&diskPath=fixture%2FA.mp4");
      try {
        await page.evaluate(() => __refreshPlayerFilesForFixture());
        await page.locator("#playerFileNext").click(); await sourceIs(page, "B"); await page.evaluate(() => __emitMedia("loadedmetadata"));
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 166, "adjacent navigation must use the latest descriptor and saved position");
        await page.locator("#playerFilePrevious").click(); await sourceIs(page, "A");
        await page.evaluate(() => __refreshPlayerFilesForFixture({ remove: "B", replaceOwner: true }));
        await page.locator("#playerFileNext").click(); await sourceIs(page, "C");
        assert.equal(await page.locator("#playerFilePosition").textContent(), "2 / 2", "removed files must not remain in adjacent navigation");
      } finally { await page.close(); }
    });
    await run("file list switching retains 1000 native rows and keyboard focus", async () => {
      const original = work.videos;
      work.videos = [...original, ...Array.from({ length: 997 }, (_, index) => ({ id: `extra-${index}`, name: `Extra file ${index}`, ext: ".mp4", playable: true }))];
      const page = await open();
      try {
        await probeFileList(page);
        const button = page.locator(".player-file-button").filter({ hasText: "Video B" });
        await button.focus(); await page.keyboard.press("Enter"); await sourceIs(page, "B"); await tick(page);
        const measured = await page.evaluate(() => ({ retained: __fileRows.filter(row => row.isConnected).length, added: __fileAddedElements,
          focus: document.activeElement === __fileRows[1], blurs: __fileBlurs }));
        console.log(`MEASURE file list ${realPlyr ? "bundled Plyr" : "controlled UI"}: ${JSON.stringify(measured)}`);
        assert.equal(measured.retained, 1000, "choosing one file must preserve all 1000 existing file rows");
        assert.deepEqual([measured.added, measured.focus, measured.blurs], [0, true, 0], "file switching must retain its native button focus without rebuilding or transient blur");
        assert.equal(await button.getAttribute("aria-current"), "true", "the selected file must be exposed as the current item");
        await page.keyboard.press("Tab");
        assert.equal(await page.locator(".player-file-button").filter({ hasText: "Video C" }).evaluate(button => document.activeElement === button), true, "Tab must continue from the chosen file to its next row");
        await page.keyboard.press("Enter"); await sourceIs(page, "C");
      } finally { work.videos = original; await page.close(); }
    });
    await run("file list pending keyboard selection keeps the latest file owner", async () => {
      const page = await open(), pending = hold("B", info("B"));
      try {
        await probeFileList(page); await page.locator(".player-file-button").filter({ hasText: "Video B" }).focus();
        await page.keyboard.press("Enter"); await pending.requested;
        assert.equal(await page.evaluate(() => document.activeElement === __fileRows[1]), true, "a pending file selection must keep the current file-list button focused");
        await page.keyboard.press("Tab"); await page.keyboard.press("Enter"); await sourceIs(page, "C");
        pending.release(); await page.waitForFunction(() => __readFinished.some(path => path.endsWith("/B"))); await tick(page);
        assert.equal(await page.evaluate(() => document.querySelector("#playerVideo").src.endsWith("/synthetic/C")), true);
        assert.equal(await page.locator(".player-file-button").filter({ hasText: "Video C" }).getAttribute("aria-current"), "true");
      } finally { pending.release(); await page.close(); }
    });
    await run("file list snapshot metadata refreshes descriptors and retires removed controls", async () => {
      const page = await open();
      try {
        await probeFileList(page); await page.evaluate(() => __refreshPlayerFilesForFixture());
        assert.equal(await page.evaluate(() => __fileRows.every(row => row.isConnected)), true, "same-order metadata refresh must retain file rows");
        assert.equal(await page.locator(".player-file-button").filter({ hasText: "Video B revised" }).count(), 1);
        const before = await page.evaluate(() => __readSignals.length);
        await choose(page, "B");
        assert.equal(await page.evaluate(() => __readSignals.length), before + 1, "a retained file button must prepare its refreshed descriptor");
        await sourceIs(page, "B"); await page.evaluate(() => __emitMedia("loadedmetadata"));
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 166, "a retained file button must use the refreshed video descriptor and progress");
        const old = await page.locator(".player-file-button").filter({ hasText: "Video B revised" }).elementHandle();
        await choose(page, "C"); await sourceIs(page, "C");
        await page.evaluate(() => __refreshPlayerFilesForFixture({ remove: "B", replaceOwner: true }));
        const reads = await page.evaluate(() => __readSignals.length);
        await old.evaluate(button => button.click()); await tick(page);
        assert.equal(await page.evaluate(() => __readSignals.length), reads, "a retired file-list row must not prepare playback under a newer work snapshot");
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.src.endsWith("/synthetic/C")), true);
      } finally { await page.close(); }
    });
    for (const mode of ["direct", "remux"]) for (const paused of [false, true]) await run(`time jump ${mode} keeps ${paused ? "paused" : "playing"} intent and fractional seconds`, async () => {
      const page = await open();
      const gate = mode === "remux" ? hold("B", info("B", { mode })) : null;
      try {
        if (gate) {
          await choose(page, "B"); await gate.requested; gate.release();
          await page.waitForFunction(() => document.querySelector("#playerVideo").src.endsWith("/synthetic/B?t=73"));
        }
        await page.evaluate(paused => {
          __emitMedia("loadedmetadata");
          const video = document.querySelector("#playerVideo");
          if (paused) video.pause();
          video.muted = true; video.dataset.autoplayMuted = "1";
        }, paused);
        const plays = await page.evaluate(() => __media.plays.length);
        await page.locator("#playerTimeJumpButton").click();
        const dialog = page.getByRole("dialog", { name: "跳到时间", exact: true });
        await dialog.waitFor({ state: "visible" });
        assert.equal(await page.evaluate(() => __media.plays.length), plays, "opening time jump must not activate autoplay-muted media");
        const input = dialog.getByLabel("播放位置", { exact: true });
        await input.fill("1:23.5"); await input.press("Enter");
        await dialog.waitFor({ state: "detached" });
        if (mode === "remux") await page.waitForFunction(() => document.querySelector("#playerVideo").src.endsWith("/synthetic/B?t=83"));
        await page.evaluate(() => __emitMedia("loadedmetadata"));
        assert.deepEqual(await page.locator("#playerVideo").evaluate(video => [video.currentTime, video.paused, video.muted]), [mode === "direct" ? 83.5 : 0.5, paused, true], "manual positioning must preserve fractional absolute time and playback intent");
        const id = mode === "direct" ? "A" : "B";
        assert.equal(await page.evaluate(id => __progressSends.some(write => write.path.endsWith(`/${id}`) && write.body.position === 83.5), id), true, "time jump must reuse the current file's progress writer");
      } finally { gate?.release(); await page.close(); }
    });
    await run("time jump validates input and latest decoded range without moving media", async () => {
      const page = await open();
      try {
        await page.evaluate(() => __emitMedia("loadedmetadata"));
        await page.locator("#playerTimeJumpButton").click();
        const dialog = page.getByRole("dialog", { name: "跳到时间", exact: true });
        const input = dialog.getByLabel("播放位置", { exact: true });
        for (const value of ["", "-1", "1:99", "1:60:00", "abc", "Infinity", "1e2", "601"]) {
          const before = await page.evaluate(() => [__media.seeks.length, __media.plays.length]);
          await input.fill(value); await dialog.getByRole("button", { name: "跳转", exact: true }).click();
          assert.equal(await dialog.getByRole("alert").isVisible(), true, `invalid ${value} must remain editable`);
          assert.equal(await input.evaluate(node => node === document.activeElement), true);
          assert.deepEqual(await page.evaluate(() => [__media.seeks.length, __media.plays.length]), before, "invalid input must not change playback");
        }
        await input.fill("1:30");
        await page.evaluate(() => { __media.duration = 60; __emitMedia("durationchange"); });
        await input.press("Enter");
        assert.match(await dialog.getByRole("alert").textContent(), /1:00/);
        await input.fill("0"); await input.press("Enter");
        await dialog.waitFor({ state: "detached" });
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 0, "zero is an explicit valid target");
      } finally { await page.close(); }
    });
    await run("time jump before direct metadata retains a target beyond a short probe hint", async () => {
      const page = await open();
      const gate = hold("B", info("B", { duration: 60 }));
      try {
        await choose(page, "B"); await gate.requested; gate.release(); await sourceIs(page, "B");
        await page.locator("#playerTimeJumpButton").click();
        const dialog = page.getByRole("dialog", { name: "跳到时间", exact: true });
        await dialog.getByLabel("播放位置", { exact: true }).fill("1:23.5");
        await dialog.getByRole("button", { name: "跳转", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        await page.evaluate(() => { __media.duration = 90; __emitMedia("loadedmetadata"); });
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 83.5, "unknown direct duration must not reject a valid target based on a short probe hint");
      } finally { gate.release(); await page.close(); }
    });
    await run("time jump retires stale forms across file selection page return and stop", async () => {
      const page = await open();
      try {
        for (const transition of ["file", "return", "stop"]) {
          await page.locator("#playerTimeJumpButton").click();
          await page.getByRole("dialog", { name: "跳到时间", exact: true }).waitFor({ state: "visible" });
          await page.evaluate(transition => {
            const form = document.querySelector(".player-time-jump-dialog form");
            window.__oldTimeJumpForm = form;
            form.querySelector("input").value = "222";
            if (transition === "file") document.querySelectorAll(".player-file-button")[1].click();
            else if (transition === "return") {
              window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
              window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
            } else __stopPlayerForFixture();
          }, transition);
          await page.getByRole("dialog", { name: "跳到时间", exact: true }).waitFor({ state: "detached" });
          if (transition !== "stop") await sourceIs(page, "B");
          const before = await page.evaluate(() => [__media.seeks.length, __media.plays.length]);
          await page.evaluate(() => __oldTimeJumpForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
          assert.deepEqual(await page.evaluate(() => [__media.seeks.length, __media.plays.length]), before, "a stale time form must not affect a new file/source");
        }
        assert.equal(await page.locator("#playerTimeJumpButton").isDisabled(), true);
      } finally { await page.close(); }
    });
    await run("time jump G opens at 320px and cancel or composition leaves media unchanged", async () => {
      const page = await open();
      try {
        await page.setViewportSize({ width: 320, height: 640 });
        await page.locator("#toggleSidebarButton").focus();
        const expanded = await page.locator("#toggleSidebarButton").getAttribute("aria-expanded");
        const before = await page.evaluate(() => [__media.seeks.length, __media.plays.length]);
        await page.keyboard.press("g");
        const dialog = page.getByRole("dialog", { name: "跳到时间", exact: true });
        const input = dialog.getByLabel("播放位置", { exact: true });
        await input.fill("42");
        await input.evaluate(node => {
          node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
          node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
          node.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
          node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
        });
        assert.equal(await dialog.isVisible(), true);
        assert.deepEqual(await page.evaluate(() => [__media.seeks.length, __media.plays.length]), before);
        assert.equal(await dialog.evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && node.scrollWidth <= node.clientWidth; }), true);
        if (process.argv.includes("--screenshots")) {
          const output = path.join(root, ".codex-artifacts", "player");
          fs.mkdirSync(output, { recursive: true });
          await dialog.screenshot({ path: path.join(output, "time-jump-320.png") });
        }
        await dialog.getByRole("button", { name: "取消", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        assert.equal(await page.locator("#toggleSidebarButton").evaluate(node => node === document.activeElement), true);
        assert.equal(await page.locator("#toggleSidebarButton").getAttribute("aria-expanded"), expanded);
        assert.deepEqual(await page.evaluate(() => [__media.seeks.length, __media.plays.length]), before);
        await page.keyboard.press("g");
        await page.getByRole("dialog", { name: "跳到时间", exact: true }).waitFor({ state: "visible" });
        await page.keyboard.press("Escape");
        await page.getByRole("dialog", { name: "跳到时间", exact: true }).waitFor({ state: "detached" });
        assert.equal(await page.locator("#toggleSidebarButton").getAttribute("aria-expanded"), expanded);
        assert.deepEqual(await page.evaluate(() => [__media.seeks.length, __media.plays.length]), before);
      } finally { await page.close(); }
    });
    for (const paused of [false, true]) await run(`shortcut help keeps ${paused ? "paused" : "playing"} media and restores button focus`, async () => {
      const page = await open();
      try {
        await page.evaluate(paused => {
          __emitMedia("loadedmetadata");
          const video = document.querySelector("#playerVideo");
          if (paused) video.pause();
          video.muted = true;
          video.dataset.autoplayMuted = "1";
        }, paused);
        const snapshot = () => page.evaluate(() => {
          const video = document.querySelector("#playerVideo");
          return { paused: video.paused, time: video.currentTime, volume: video.volume, muted: video.muted, plays: __media.plays.length, seeks: __media.seeks.length };
        });
        const before = await snapshot();
        const button = page.locator("#playerShortcutsButton");
        await button.click();
        const dialog = page.getByRole("dialog", { name: "播放快捷键" });
        await dialog.waitFor({ state: "visible" });
        assert.equal(await dialog.getByRole("button", { name: "关闭", exact: true }).evaluate(node => node === document.activeElement), true);
        for (const key of ["ArrowRight", "ArrowUp", "k", "m", "i", "?"]) await page.keyboard.press(key);
        for (const key of ["Tab", "Shift+Tab"]) {
          await page.keyboard.press(key);
          assert.equal(await dialog.evaluate(node => document.activeElement === document.body || node.contains(document.activeElement)), true, "native modal Tab may reach browser chrome but must not focus background controls");
        }
        await page.keyboard.press("Escape");
        assert.equal(await dialog.isVisible(), false);
        assert.equal(await button.evaluate(node => node === document.activeElement), true, "Escape must return focus to the help opener");
        assert.deepEqual(await snapshot(), before, "reading or closing help must not activate autoplay-muted media or change playback");
        await button.click();
        await page.keyboard.press("Space");
        assert.equal(await dialog.isVisible(), false, "Space activates the focused close button");
        assert.deepEqual(await snapshot(), before);
      } finally { await page.close(); }
    });
    await run("shortcut help question mark opens a bounded modal at 320px", async () => {
      const page = await open();
      try {
        await page.setViewportSize({ width: 320, height: 640 });
        await page.locator("#toggleSidebarButton").focus();
        const expanded = await page.locator("#toggleSidebarButton").getAttribute("aria-expanded");
        await page.keyboard.press("?");
        const dialog = page.getByRole("dialog", { name: "播放快捷键" });
        await dialog.waitFor({ state: "visible" });
        assert.equal(await dialog.evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && node.scrollWidth <= node.clientWidth; }), true, "help must fit the 320px viewport without horizontal overflow");
        await dialog.getByRole("button", { name: "关闭", exact: true }).click({ trial: true });
        if (process.argv.includes("--screenshots")) {
          const output = path.join(root, ".codex-artifacts", "player");
          fs.mkdirSync(output, { recursive: true });
          await dialog.screenshot({ path: path.join(output, "shortcut-help-320.png") });
        }
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#toggleSidebarButton").getAttribute("aria-expanded"), expanded, "Escape must close help without toggling the mobile sidebar");
        assert.equal(await page.locator("#toggleSidebarButton").evaluate(node => node === document.activeElement), true);
      } finally { await page.close(); }
    });
    await run("shortcut help ignores text input composition modifiers and other dialogs", async () => {
      const page = await open();
      try {
        await page.evaluate(() => {
          const input = document.createElement("input"); input.id = "fixture-shortcut-input";
          document.body.append(input); input.focus();
        });
        await page.keyboard.type("?");
        assert.equal(await page.locator("#fixture-shortcut-input").inputValue(), "?");
        assert.equal(await page.locator("#playerShortcutsDialog").evaluate(node => node.open), false);
        const before = await page.evaluate(() => [__media.plays.length, __media.seeks.length, document.querySelector("#playerVideo").paused]);
        await page.evaluate(() => {
          for (const options of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
            for (const key of ["?", "g", "k", "ArrowRight"]) document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));
          }
        });
        assert.equal(await page.locator("#playerShortcutsDialog").evaluate(node => node.open), false);
        assert.equal(await page.locator(".player-time-jump-dialog").count(), 0);
        assert.deepEqual(await page.evaluate(() => [__media.plays.length, __media.seeks.length, document.querySelector("#playerVideo").paused]), before, "composition and modified keys must not seek or toggle playback");
        await page.evaluate(() => { document.querySelector("#fixture-shortcut-input").remove(); __clipboardDenied = true; });
        await page.locator("#copyTimeLinkButton").click();
        await page.getByRole("dialog", { name: "复制时间链接" }).waitFor({ state: "visible" });
        await page.getByRole("dialog", { name: "复制时间链接" }).getByRole("button", { name: "关闭", exact: true }).focus();
        await page.keyboard.press("?");
        assert.equal(await page.locator("#playerShortcutsDialog").evaluate(node => node.open), false, "another dialog must keep ownership of its keyboard interaction");
      } finally { await page.close(); }
    });
    await run("time link starts the selected file once and leaves later selections normal", async () => {
      const page = await open(true, "&videoId=B&t=101.25");
      try {
        await page.evaluate(() => __emitMedia("loadedmetadata"));
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 101.25, "a URL time position must override the selected file saved progress");
        await choose(page, "C"); await sourceIs(page, "C"); await page.evaluate(() => __emitMedia("loadedmetadata"));
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 115, "a consumed URL start must not leak into another file");
        await choose(page, "B"); await sourceIs(page, "B"); await page.evaluate(() => __emitMedia("loadedmetadata"));
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 73, "later ordinary selection uses its saved resume position");
      } finally { await page.close(); }
    });
    await run("time link explicit zero overrides saved progress", async () => {
      const page = await open(true, "&t=0");
      try { await page.evaluate(() => __emitMedia("loadedmetadata")); assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 0); }
      finally { await page.close(); }
    });
    await run("time link unavailable file does not retarget its timestamp", async () => {
      const page = await open(true, "&videoId=removed-file&t=101.25");
      try {
        await page.evaluate(() => __emitMedia("loadedmetadata"));
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 31, "a missing explicit file must not apply its timestamp to the fallback file");
        await page.locator("#copyTimeLinkButton").click();
        const copied = new URL(await page.evaluate(() => __copiedLinks.at(-1)));
        assert.equal(copied.searchParams.get("videoId"), "A");
      } finally { await page.close(); }
    });
    await run("time link invalid positions retain ordinary saved progress", async () => {
      for (const value of ["", "-1", "Infinity", "abc", "1e3"]) {
        const page = await open(true, `&t=${encodeURIComponent(value)}`);
        try { await page.evaluate(() => __emitMedia("loadedmetadata")); assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 31, `invalid link position ${value} must retain saved progress`); }
        finally { await page.close(); }
      }
    });
    await run("time link read failure can retry the original requested position", async () => {
      const failure = hold("B", null, 503), opening = open(true, "&videoId=B&t=101.25", { waitForSource: false });
      await failure.requested; failure.release();
      const page = await opening;
      try {
        assert.equal(await page.locator("#copyTimeLinkButton").isDisabled(), true);
        await choose(page, "B"); await sourceIs(page, "B"); await page.evaluate(() => __emitMedia("loadedmetadata"));
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 101.25, "retry must retain the unconsumed URL start intent");
      } finally { failure.release(); await page.close(); }
    });
    await run("time link copies the current selected file and precise position", async () => {
      const page = await open(true, "&t=9&returnTo=%2Ffixture-private&nonce=fixture#old");
      try {
        await page.evaluate(() => __emitMedia("loadedmetadata"));
        await choose(page, "B"); await sourceIs(page, "B"); await page.evaluate(() => { __emitMedia("loadedmetadata"); document.querySelector("#playerVideo").currentTime = 87.25; });
        await page.locator("#copyTimeLinkButton").click();
        await page.waitForFunction(() => !document.querySelector("#playerTimeLinkStatus").hidden);
        const copied = new URL(await page.evaluate(() => __copiedLinks.at(-1)));
        assert.equal(copied.origin, base);
        assert.deepEqual(Object.fromEntries(copied.searchParams), { workId: "fixture-work", videoId: "B", t: "87.25" }, "copied link must use the current file and omit unrelated query/hash data");
        assert.equal(copied.hash, "");
      } finally { await page.close(); }
    });
    for (const paused of [false, true]) for (const denied of [false, true]) await run(`time link copying preserves ${paused ? "paused" : "playing"} muted media with ${denied ? "manual" : "clipboard"} copy`, async () => {
      const page = await open();
      try {
        await page.evaluate(({ paused, denied }) => {
          __emitMedia("loadedmetadata");
          const video = document.querySelector("#playerVideo");
          if (paused) video.pause();
          video.muted = true; video.dataset.autoplayMuted = "1";
          __clipboardDenied = denied;
        }, { paused, denied });
        const snapshot = () => page.evaluate(() => {
          const video = document.querySelector("#playerVideo");
          return { paused: video.paused, time: video.currentTime, volume: video.volume, muted: video.muted, autoMuted: video.dataset.autoplayMuted, plays: __media.plays.length, seeks: __media.seeks.length };
        });
        const before = await snapshot(), button = page.locator("#copyTimeLinkButton");
        if (denied) { await button.focus(); await page.keyboard.press("Enter"); }
        else await button.click();
        if (denied) {
          const dialog = page.getByRole("dialog", { name: "复制时间链接", exact: true });
          await dialog.waitFor({ state: "visible" });
          assert.deepEqual(await snapshot(), before, "opening a time link must not activate autoplay-muted playback");
          const input = dialog.getByLabel("定位链接");
          await input.focus(); await page.keyboard.press("Control+c");
          await input.press("ArrowLeft");
          await dialog.getByRole("button", { name: "关闭", exact: true }).click();
          assert.equal(await button.evaluate(node => node === document.activeElement), true);
          assert.deepEqual(await snapshot(), before, "manual copy keys and closing its dialog must not activate autoplay-muted playback");
        } else {
          await page.waitForFunction(() => !document.querySelector("#playerTimeLinkStatus").hidden);
          assert.deepEqual(await snapshot(), before, "copying a time link must not activate autoplay-muted playback");
        }
        await page.locator(".player-stage").click({ position: { x: 10, y: 10 } });
        assert.equal(await page.locator("#playerVideo").evaluate(video => !video.muted && video.dataset.autoplayMuted !== "1"), true, "explicit interaction with the video still restores autoplay audio");
      } finally { await page.close(); }
    });
    await run("time link denied clipboard offers a reachable manual copy at 320px", async () => {
      const page = await open();
      try {
        await page.setViewportSize({ width: 320, height: 844 });
        if (await page.locator("#toggleSidebarButton").getAttribute("aria-expanded") === "false") await page.locator("#toggleSidebarButton").click();
        await page.evaluate(() => { __emitMedia("loadedmetadata"); __clipboardDenied = true; });
        await page.locator("#copyTimeLinkButton").click();
        const dialog = page.getByRole("dialog", { name: "复制时间链接" });
        await dialog.waitFor({ state: "visible" });
        const input = dialog.getByLabel("定位链接");
        const selection = await input.evaluate(node => [node.readOnly, node.selectionStart, node.selectionEnd, node.value.length]);
        assert.deepEqual(selection, [true, 0, selection[3], selection[3]]);
        const before = await page.evaluate(() => __media.seeks.length);
        await dialog.getByRole("button", { name: "关闭", exact: true }).focus(); await page.keyboard.press("ArrowRight");
        assert.equal(await page.evaluate(() => __media.seeks.length), before, "dialog keys must not seek the player behind it");
        assert.equal(await dialog.evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }), true);
        if (process.argv.includes("--screenshots")) {
          const output = path.join(root, ".codex-artifacts", "player");
          fs.mkdirSync(output, { recursive: true });
          await dialog.screenshot({ path: path.join(output, "time-link-copy-320.png") });
        }
        await page.keyboard.press("Escape");
        assert.equal(await dialog.count(), 0);
        assert.equal(await page.locator("#toggleSidebarButton").getAttribute("aria-expanded"), "true", "Escape closes only the manual-copy dialog");
        await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }));
        await page.locator("#copyTimeLinkButton").click();
        await page.getByRole("dialog", { name: "复制时间链接" }).waitFor({ state: "visible" });
        assert.equal(await page.getByRole("dialog").getByLabel("定位链接").inputValue(), await page.evaluate(() => __copiedLinks.at(-1)), "HTTP contexts without Clipboard API retain the same manual-copy URL");
        await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
      } finally { await page.close(); }
    });
    for (const fail of [false, true]) await run(`time link clipboard ${fail ? "failure" : "success"} cannot replace a newer file UI`, async () => {
      const page = await open();
      try {
        await page.evaluate(() => { __emitMedia("loadedmetadata"); __holdClipboard = true; });
        await page.locator("#copyTimeLinkButton").click(); await page.locator("#copyTimeLinkButton").click({ force: true });
        assert.equal(await page.evaluate(() => __copiedLinks.length), 1, "a pending clipboard write must remain single flight");
        await choose(page, "B"); await sourceIs(page, "B");
        await page.evaluate(fail => { __holdClipboard = false; fail ? __clipboardPending[0].reject(new Error("Synthetic late clipboard error")) : __clipboardPending[0].resolve(); }, fail);
        await tick(page);
        assert.equal(await page.locator(".player-time-link-dialog").count(), 0, "an old clipboard failure must not open a dialog on a newer file");
        assert.equal(await page.locator("#playerTimeLinkStatus").isVisible(), false);
        await page.locator("#copyTimeLinkButton").click();
        assert.equal(new URL(await page.evaluate(() => __copiedLinks.at(-1))).searchParams.get("videoId"), "B");
      } finally { await page.close(); }
    });
    await run("time link page return retires a pending clipboard dialog", async () => {
      const page = await open(true, "&t=42");
      try {
        await page.evaluate(() => { __holdClipboard = true; }); await page.locator("#copyTimeLinkButton").click();
        await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })); window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); });
        await page.waitForFunction(() => __readFinished.length === 2); await tick(page);
        await page.evaluate(() => __clipboardPending[0].reject(new Error("Late after return"))); await tick(page);
        assert.equal(await page.locator(".player-time-link-dialog").count(), 0, "an exited copy intent stays retired even after returning to the same file");
        await page.evaluate(() => __emitMedia("loadedmetadata"));
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 42);
      } finally { await page.close(); }
    });
    for (const fail of [false, true]) await run(`time link released playback ${fail ? "failure" : "success"} retires its copy UI`, async () => {
      const page = await open();
      try {
        await page.evaluate(() => { __emitMedia("loadedmetadata"); __holdClipboard = true; });
        await page.locator("#copyTimeLinkButton").click();
        await page.evaluate(() => __stopPlayerForFixture());
        assert.equal(await page.locator("#copyTimeLinkButton").evaluate(button => button.disabled), true, "released playback must disable its time-link control");
        await page.evaluate(fail => { fail ? __clipboardPending[0].reject(new Error("Late released copy")) : __clipboardPending[0].resolve(); }, fail);
        await tick(page);
        assert.equal(await page.locator(".player-time-link-dialog").count(), 0, "a released player's clipboard result must not restore a stale dialog");
        assert.equal(await page.locator("#playerTimeLinkStatus").isVisible(), false);
        await choose(page, "B"); await sourceIs(page, "B");
        assert.equal(await page.locator("#copyTimeLinkButton").isDisabled(), false);
      } finally { await page.close(); }
    });
    for (const kind of ["media", "disk"]) await run(`time link ${kind} source opens and copies its active locator`, async () => {
      const page = await open(true, `&videoId=B&t=101.25${kind === "media" ? "&mediaId=media-fixture" : "&diskDrive=Q&diskPath=fixture%2FA.mp4"}`);
      try {
        await page.evaluate(() => __emitMedia("loadedmetadata"));
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 101.25);
        await page.locator("#copyTimeLinkButton").click();
        const copied = new URL(await page.evaluate(() => __copiedLinks.at(-1)));
        assert.equal(copied.searchParams.has("workId"), false);
        assert.equal(copied.searchParams.get("videoId"), "B");
        assert.equal(copied.searchParams.get("t"), "101.25");
        if (kind === "media") assert.equal(copied.searchParams.get("mediaId"), "media-fixture");
        else { assert.equal(copied.searchParams.get("diskDrive"), "Q"); assert.equal(copied.searchParams.get("diskPath"), "fixture/B.mp4"); }
      } finally { await page.close(); }
    });
    await run("time link beyond metadata stops at the actual end", async () => {
      const page = await open(true, "&t=1200");
      try { await page.evaluate(() => __emitMedia("loadedmetadata")); assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 600); assert.equal(await page.locator("#playerVideo").evaluate(video => video.paused), true); }
      finally { await page.close(); }
    });
    await run("time link compatibility mode keeps a fractional absolute position", async () => {
      const remux = hold("B", info("B", { mode: "remux" }));
      const opening = open(true, "&videoId=B&t=101.25", { waitForSource: false });
      await remux.requested; remux.release();
      const page = await opening;
      try {
        await page.waitForFunction(() => document.querySelector("#playerVideo").src.endsWith("/synthetic/B?t=101"));
        await page.evaluate(() => __emitMedia("loadedmetadata"));
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), .25, "the fractional part of a compatibility link must remain inside its generated segment");
        await page.locator("#copyTimeLinkButton").click();
        assert.equal(new URL(await page.evaluate(() => __copiedLinks.at(-1))).searchParams.get("t"), "101.25");
      } finally { remux.release(); await page.close(); }
    });
    if (realPlyr) {
      await run("real Plyr mode changes preserve the visible owned video", async () => {
        const page = await open(), remux = hold("B", info("B", { mode: "remux" }));
        try {
          await page.locator('#playerVideo track[data-subtitle-id="sub-A"]').waitFor({ state: "attached" });
          await page.evaluate(() => { window.__originalVideo = document.querySelector("#playerVideo"); __originalVideo.muted = true; __originalVideo.volume = 0.37; __originalVideo.playbackRate = 1.5; });
          await choose(page, "B"); await remux.requested; remux.release();
          await page.waitForFunction(() => __readFinished.some(url => url.includes("/api/playinfo/B"))); await tick(page);
          assert.equal(await page.evaluate(() => __playerHostVideo().isConnected && document.querySelector("#playerVideo") === __playerHostVideo() && __playerHostVideo().plyr.media === __playerHostVideo()), true, "Plyr mode changes must keep the host's owned video connected and visible");
          assert.match(await page.locator("#playerVideo").evaluate(video => video.src), /\/synthetic\/B\?t=73$/, `visible video must receive the compatibility stream; notice: ${await page.locator("#playerNotice").textContent()}; browser errors: ${faults.join("; ")}`);
          await page.locator('#playerVideo track[data-subtitle-id="sub-B"]').waitFor({ state: "attached" });
          assert.match(await page.locator('#playerVideo track[data-subtitle-id="sub-B"]').getAttribute("src"), /offsetSeconds=-73/);
          assert.equal(await page.locator('.plyr__controls #playerSeekControl').count(), 1, "the custom timeline must be attached exactly once to the current controls");
          await page.evaluate(() => { window.__compatVideo = document.querySelector("#playerVideo"); });
          await page.evaluate(() => __emitMedia("loadedmetadata"));
          await choose(page, "C"); await sourceIs(page, "C");
          assert.equal(await page.evaluate(() => document.querySelector("#playerVideo") === __playerHostVideo() && __playerHostVideo().plyr.media === __playerHostVideo()), true, "switching back to direct must retain the current video and its real Plyr instance");
          await page.evaluate(() => __emitMedia("loadedmetadata"));
          assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 115);
          assert.equal(await page.locator(".player-stage video").count(), 1);
          assert.equal(await page.locator(".player-stage .plyr").count(), 1);
          assert.equal(await page.locator(".player-stage > #playerSeekControl").count(), 1, "direct mode must return the single custom timeline to its host");
          assert.deepEqual(await page.locator("#playerVideo").evaluate(video => ({ muted: video.muted, volume: video.volume, rate: video.playbackRate })), { muted: true, volume: 0.37, rate: 1.5 });
          await page.locator('#playerVideo track[data-subtitle-id="sub-C"]').waitFor({ state: "attached" });
          assert.match(await page.locator('#playerVideo track[data-subtitle-id="sub-C"]').getAttribute("src"), /offsetSeconds=0/);
          const source = await page.locator("#playerVideo").evaluate(video => video.src);
          await page.evaluate(() => { for (const video of [__originalVideo, __compatVideo]) for (const type of ["error", "waiting", "loadedmetadata", "canplay"]) video.dispatchEvent(new Event(type)); });
          await page.waitForTimeout(230);
          assert.equal(await page.locator("#playerVideo").evaluate(video => video.src), source, "detached media errors must not change the current source");
          assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 115);
          assert.equal(await page.evaluate(() => __playerHostVideo().plyr.ready && __playerHostVideo().plyr.media === __playerHostVideo()), true, "old Plyr cleanup must not clear the newly constructed player");
        } finally { remux.release(); await page.close(); }
      });
      await run("real Plyr late compatibility read cannot replace a newer direct player", async () => {
        const page = await open(), remux = hold("B", info("B", { mode: "remux" }));
        try {
          await choose(page, "B"); await remux.requested;
          await choose(page, "C"); await sourceIs(page, "C");
          await page.evaluate(() => { window.__latestPlyr = document.querySelector("#playerVideo").plyr; });
          remux.release();
          await page.waitForFunction(() => __readFinished.some(url => url.includes("/api/playinfo/B"))); await tick(page);
          assert.equal(await page.evaluate(() => __playerHostVideo() === document.querySelector("#playerVideo") && __playerHostVideo().plyr === __latestPlyr), true, "an obsolete mode read cannot rebuild or detach the new direct player");
          assert.match(await page.locator("#playerVideo").evaluate(video => video.src), /\/synthetic\/C$/);
          assert.equal(await page.locator(".player-stage.stream-controls").count(), 0);
          assert.equal(await page.locator(".player-stage .plyr").count(), 1);
        } finally { remux.release(); await page.close(); }
      });
      await run("real Plyr deferred compatibility control and paused return keep current intent", async () => {
        const page = await open();
        try {
          await page.locator('#playerVideo track[data-subtitle-id="sub-A"]').waitFor({ state: "attached" });
          await page.evaluate(() => __emitMedia("error"));
          await page.waitForFunction(() => document.querySelector("#playerVideo").src.endsWith("/synthetic/A-compat?t=31"));
          assert.equal(await page.evaluate(() => __playerHostVideo() === document.querySelector("#playerVideo")), true);
          await page.locator('.plyr__controls [data-plyr="play"]').click();
          assert.equal(await page.locator("#playerVideo").evaluate(video => video.paused), true);
          await page.evaluate(() => {
            const range = document.querySelector("#playerSeekRange"); range.value = "90";
            range.dispatchEvent(new Event("input")); range.dispatchEvent(new Event("change"));
          });
          assert.equal(await page.locator(".player-stage.stream-pending").count(), 1);
          await page.locator('.plyr__controls [data-plyr="play"]').click();
          assert.equal(await page.locator(".player-stage.stream-pending").count(), 0, "native play must activate the deferred compatibility source");
          await page.locator('.plyr__controls [data-plyr="play"]').click();
          assert.equal(await page.locator("#playerVideo").evaluate(video => video.paused), true);
          await page.evaluate(() => {
            window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
            window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
          });
          await page.waitForFunction(() => __readFinished.length === 2); await tick(page);
          await page.evaluate(() => { __emitMedia("loadedmetadata"); __emitMedia("canplay"); });
          assert.equal(await page.locator("#playerVideo").evaluate(video => video.paused), true, "native pause intent must survive deferred playback and a mode-changing return");
          assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 90);
          assert.equal(await page.evaluate(() => __media.plays.length), 2);
          assert.equal(await page.evaluate(() => __playerHostVideo() === document.querySelector("#playerVideo") && __playerHostVideo().plyr.media === __playerHostVideo()), true);
          assert.equal(await page.locator("#playerSeekControl").count(), 1);
        } finally { await page.close(); }
      });
      for (const mode of ["direct", "remux"]) for (const interaction of ["button click", "focused k", "focused Space"]) await run(`real Plyr ${mode} ${interaction} pause before metadata remains paused`, async () => {
        const page = await open(), remux = mode === "remux" ? hold("B", info("B", { mode: "remux" })) : null;
        try {
          if (remux) { await choose(page, "B"); await remux.requested; remux.release(); await page.waitForFunction(() => document.querySelector("#playerVideo").src.endsWith("/synthetic/B?t=73")); }
          const button = page.locator('.plyr__controls [data-plyr="play"]');
          const activate = async () => {
            if (interaction === "button click") { await button.click(); return; }
            await button.focus();
            await button.press(interaction === "focused k" ? "k" : "Space");
          };
          if (!remux) await activate();
          await activate();
          assert.equal(await page.locator("#playerVideo").evaluate(video => video.paused), true);
          assert.equal(await page.evaluate(() => __media.plays.length), 1, "the real control must start one play attempt before its explicit pause");
          await page.evaluate(() => { __emitMedia("loadedmetadata"); __emitMedia("canplay"); });
          assert.equal(await page.locator("#playerVideo").evaluate(video => video.paused), true, "real Plyr pause intent must survive delayed metadata");
          assert.equal(await page.evaluate(() => __media.plays.length), 1);
        } finally { remux?.release(); await page.close(); }
      });
    }
    for (const ignoreAbort of [true, false]) for (const fail of [false, true]) await run(`latest play-info ${ignoreAbort ? "ignores" : "honors"} abort ${fail ? "old failure" : "old success"}`, async () => {
      const page = await open(ignoreAbort), old = hold("B", fail ? null : info("B"), fail ? 503 : 200);
      try {
        await choose(page, "B"); await old.requested;
        await choose(page, "C"); await sourceIs(page, "C");
        assert.equal(await page.evaluate(() => __readSignals.at(-2).aborted), true, "the superseded read receives AbortSignal");
        old.release();
        await page.waitForFunction(() => __readFinished.some(url => url.includes("/api/playinfo/B")));
        await tick(page);
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.src.endsWith("/synthetic/C")), true, "late play-info must not replace the selected source");
        assert.equal(await page.locator("#playerNotice").isVisible(), false, "late failures must not hide the current player");
        assert.match(await page.locator(".player-file-button.active").textContent(), /Video C/);
      } finally { old.release(); await page.close(); }
    });
    await run("metadata belongs to latest file", async () => {
      const page = await open();
      try {
        await choose(page, "B"); await sourceIs(page, "B");
        await page.evaluate(() => __emitMedia("loadedmetadata"));
        assert.deepEqual(await page.evaluate(() => __media.seeks), [73], "replaced source must not apply its old resume position");
        assert.equal(await page.evaluate(() => __media.plays.length), 1, "metadata must only start the current file once");
      } finally { await page.close(); }
    });
    await run("pending direct keyboard seeks accumulate and survive metadata", async () => {
      const page = await open();
      try {
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowLeft");
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 0, "the unready media need not seek until metadata exists");
        await page.evaluate(() => __emitMedia("loadedmetadata"));
        assert.deepEqual(await page.evaluate(() => __media.seeks), [41], "pending keyboard seeks must accumulate from the requested resume position and apply after metadata");
      } finally { await page.close(); }
    });
    await run("direct terminal seek before metadata stays at the end until replay", async () => {
      const page = await open(), short = hold("B", info("B", { duration: 90 }));
      try {
        await choose(page, "B"); await short.requested; short.release(); await sourceIs(page, "B");
        await page.evaluate(() => { __media.duration = 90; });
        await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight");
        await page.evaluate(() => __emitMedia("loadedmetadata"));
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 90, "a pending seek to the end must apply the terminal position");
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.paused), true, "reaching the end while loading must not restart playback");
        assert.equal(await page.evaluate(() => __media.plays.length), 0);
        // The focused file button owns Space; move to the page shortcut context.
        await page.mouse.click(2, 2);
        await page.keyboard.press("Space");
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 0, "an explicit replay can start again from the end");
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.paused), false);
      } finally { short.release(); await page.close(); }
    });
    await run("direct terminal seek uses actual shorter metadata and corrects progress", async () => {
      const page = await open();
      try {
        await choose(page, "B"); await sourceIs(page, "B");
        await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight");
        const corrected = page.waitForResponse(response => response.url().endsWith("/api/progress/B")
          && response.request().postDataJSON()?.position === 80 && response.request().postDataJSON()?.duration === 80);
        await page.evaluate(() => { __media.duration = 80; __emitMedia("loadedmetadata"); });
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 80, "shorter metadata must clamp a pending seek to the actual end");
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.paused), true);
        await corrected;
      } finally { await page.close(); }
    });
    await run("direct terminal seek after metadata uses the decoded duration", async () => {
      const page = await open();
      try {
        await choose(page, "B"); await sourceIs(page, "B");
        await page.evaluate(() => { __media.duration = 90; __emitMedia("loadedmetadata"); });
        await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight");
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 90, "ready direct seeks must clamp to decoded duration instead of stale probe hints");
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.paused), true, "an explicit seek to the end must stop rather than queue a future seek");
      } finally { await page.close(); }
    });
    await run("direct shorter duration hint preserves pending resume across page return", async () => {
      const page = await open(), shortHint = hold("B", info("B", { duration: 60 }));
      let restored;
      try {
        await choose(page, "B"); await shortHint.requested; shortHint.release(); await sourceIs(page, "B");
        const beforeWrites = writes.length;
        await page.keyboard.press("ArrowLeft");
        await tick(page);
        assert.equal(writes.slice(beforeWrites).some(write => write.body.position > write.body.duration), false,
          "a pending position beyond an unverified hint must not write an invalid duration");
        restored = hold("B", info("B", { duration: 60 }));
        await page.evaluate(() => {
          window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
          window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
        });
        await restored.requested; restored.release();
        await page.waitForFunction(() => __readFinished.length === 3); await tick(page);
        const corrected = page.waitForResponse(response => response.url().endsWith("/api/progress/B")
          && response.request().postDataJSON()?.position === 63 && response.request().postDataJSON()?.duration === 90);
        await page.evaluate(() => { __media.duration = 90; __emitMedia("loadedmetadata"); });
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 63, "a short probe hint must not discard the saved position or its pending keyboard adjustment");
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.paused), false);
        await corrected;
      } finally { shortHint.release(); restored?.release(); await page.close(); }
    });
    await run("direct keyboard seek wins while metadata event is queued", async () => {
      const page = await open();
      try {
        await page.evaluate(() => __emitMedia("loadedmetadata", false));
        await page.keyboard.press("ArrowRight");
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 41, "the pending resume remains the seek base before its metadata callback");
        await page.evaluate(() => __emitMedia("loadedmetadata"));
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 41, "metadata must not rewind an already accepted keyboard seek");
      } finally { await page.close(); }
    });
    await run("direct fallback before metadata keeps pending resume and autoplay", async () => {
      const page = await open();
      try {
        await page.evaluate(() => __emitMedia("error"));
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.src.endsWith("/synthetic/A-compat?t=31")), true, "compatibility fallback must keep the pending direct resume position");
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.paused), false);
      } finally { await page.close(); }
    });
    await run("paused direct fallback stays paused until explicit start", async () => {
      const page = await open();
      try {
        await page.evaluate(() => { __emitMedia("loadedmetadata"); document.querySelector("#playerVideo").pause(); __emitMedia("error"); });
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.paused), true, "a paused direct source must not autoplay merely because compatibility fallback is available");
        assert.equal(await page.locator("#playerStreamStart").isVisible(), true);
        assert.equal(await page.evaluate(() => __media.plays.length), 1);
        await page.locator("#playerStreamStart").click();
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.paused), false);
        assert.equal(await page.evaluate(() => __media.plays.length), 2);
      } finally { await page.close(); }
    });
    await run("deferred compatibility start resumes the live position on return", async () => {
      const page = await open();
      try {
        await page.evaluate(() => { __emitMedia("loadedmetadata"); document.querySelector("#playerVideo").pause(); __emitMedia("error"); });
        await page.locator("#playerStreamStart").click();
        await page.evaluate(() => {
          __emitMedia("loadedmetadata");
          document.querySelector("#playerVideo").currentTime = 5;
          window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
          window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
        });
        await page.waitForFunction(() => __readFinished.length === 2); await tick(page);
        await sourceIs(page, "A");
        await page.evaluate(() => __emitMedia("loadedmetadata"));
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 36, "live position after deferred compatibility metadata must replace its initial pending position");
      } finally { await page.close(); }
    });
    await run("current read failure remains visible and file retry works", async () => {
      const page = await open(), failed = hold("B", null, 503);
      try {
        await choose(page, "B"); await failed.requested; failed.release();
        await page.waitForFunction(() => document.querySelector("#playerNotice").textContent.includes("Synthetic play-info failure"));
        assert.equal(await page.locator("#playerNotice").isVisible(), true);
        await choose(page, "B"); await sourceIs(page, "B");
        await page.evaluate(() => __emitMedia("loadedmetadata"));
        assert.equal(await page.locator("#playerNotice").isVisible(), false);
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 73);
      } finally { failed.release(); await page.close(); }
    });
    await run("old play promise cannot mute or change new source", async () => {
      const page = await open();
      try {
        await page.evaluate(() => { __media.holdPlay = true; __emitMedia("loadedmetadata"); });
        await choose(page, "B"); await sourceIs(page, "B");
        await page.evaluate(() => __emitMedia("loadedmetadata"));
        await page.evaluate(() => __media.pending[0].reject(new DOMException("Old blocked audio", "NotAllowedError"))); await tick(page);
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.muted), false, "an old rejection must not mute the selected video");
        assert.equal(await page.evaluate(() => __media.plays.length), 2, "old policy failures must not start a third play attempt");
        await page.evaluate(() => __media.pending[1].reject(new Error("Current failure"))); await tick(page);
        assert.match(await page.locator("#playerVideo").getAttribute("data-playback-error"), /Current failure/);
      } finally { await page.close(); }
    });
    await run("old success cannot clear latest play error on the same source", async () => {
      const page = await open();
      try {
        await page.evaluate(() => {
          __media.holdPlay = true;
          __emitMedia("loadedmetadata");
          document.querySelector("#playerVideo").pause();
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
        });
        assert.equal(await page.evaluate(() => __media.pending.length), 2);
        await page.evaluate(() => __media.pending[1].reject(new Error("Latest attempt failed"))); await tick(page);
        await page.evaluate(() => __media.pending[0].resolve()); await tick(page);
        assert.match(await page.locator("#playerVideo").getAttribute("data-playback-error"), /Latest attempt failed/, "earlier success must not clear a later play failure");
      } finally { await page.close(); }
    });
    await run("current blocked autoplay retains muted fallback and trusted audio restore", async () => {
      const page = await open();
      try {
        await page.evaluate(() => { __media.holdPlay = true; __emitMedia("loadedmetadata"); });
        await page.evaluate(() => __media.pending[0].reject(new DOMException("Current blocked audio", "NotAllowedError"))); await tick(page);
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.muted), true);
        assert.equal(await page.locator("#playerVideo").getAttribute("data-autoplay-muted"), "1");
        assert.equal(await page.evaluate(() => __media.pending.length), 2);
        await page.evaluate(() => __media.pending[1].resolve()); await tick(page);
        await page.locator("#toggleSidebarButton").click();
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.muted), false);
        assert.equal(await page.locator("#playerVideo").getAttribute("data-autoplay-muted"), null);
        assert.equal(await page.evaluate(() => __media.pending.length), 3);
        await page.evaluate(() => __media.pending[2].resolve());
      } finally { await page.close(); }
    });
    await run("segmented seek keeps latest source and ignores queued old pause", async () => {
      const page = await open(), remux = hold("B", info("B", { mode: "remux", label: "Synthetic remux" }));
      try {
        await choose(page, "B"); await remux.requested; remux.release();
        await page.waitForFunction(() => document.querySelector("#playerVideo").src.endsWith("/synthetic/B?t=73"));
        await page.evaluate(() => {
          __media.holdPlay = true;
          const range = document.querySelector("#playerSeekRange");
          range.value = "150"; range.dispatchEvent(new Event("input")); range.dispatchEvent(new Event("change"));
        });
        await page.waitForFunction(() => document.querySelector("#playerVideo").src.endsWith("/synthetic/B?t=150"));
        // The old pause task is delivered after the new source's immediate play.
        await tick(page);
        await page.evaluate(() => __media.pending[0].reject(new DOMException("Current remux autoplay blocked", "NotAllowedError"))); await tick(page);
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.muted), true, "queued old pause must not invalidate the new source's autoplay recovery");
        assert.match(await page.locator("#playerDurationTime").textContent(), /2:30 \/ 10:00/);
        await page.evaluate(() => __media.pending[1].resolve());
      } finally { remux.release(); await page.close(); }
    });
    await run("page exit cancels pending file and persisted return restores selection", async () => {
      const page = await open(), old = hold("B", info("B"));
      try {
        await choose(page, "B"); await old.requested;
        await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
        assert.equal(await page.evaluate(() => __readSignals.at(-1).aborted), true);
        old.release(); await tick(page);
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.src), "", "a page that left must not acquire a source from late play-info");
        await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
        await sourceIs(page, "B");
        await page.evaluate(() => __emitMedia("loadedmetadata"));
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 73);
      } finally { old.release(); await page.close(); }
    });
    await run("unready file does not overwrite saved progress with zero", async () => {
      const page = await open();
      try {
        const before = await page.evaluate(() => __progressSends.length);
        await choose(page, "B"); await sourceIs(page, "B");
        await page.evaluate(() => window.dispatchEvent(new Event("beforeunload"))); await tick(page);
        assert.equal(await page.evaluate(() => __progressSends.length), before, "metadata-free navigation must not report a fake zero progress");
        await page.evaluate(() => __emitMedia("loadedmetadata"));
        await page.evaluate(() => window.dispatchEvent(new Event("beforeunload"))); await tick(page);
        assert.equal(await page.evaluate(() => __progressSends.at(-1).body.position), 73);
        assert.equal(await page.evaluate(() => __progressSends.at(-1).path), "/api/progress/B");
      } finally { await page.close(); }
    });
    await run("final progress bypasses throttle and uses teardown-safe delivery", async () => {
      const page = await open();
      try {
        await page.evaluate(() => __emitMedia("loadedmetadata"));
        await page.keyboard.press("ArrowRight");
        await page.evaluate(() => { document.querySelector("#playerVideo").currentTime = 42.5; window.dispatchEvent(new Event("beforeunload")); });
        const last = await page.evaluate(() => __progressSends.at(-1));
        assert.equal(last.body.position, 42.5, "final progress must bypass the recent periodic or seek report throttle");
        assert.equal(last.keepalive, true, "final progress must request delivery that survives document teardown");
        await page.evaluate(() => {
          const wallClock = Date.now;
          Date.now = () => wallClock() + 60000;
          window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
        });
        assert.equal(await page.evaluate(() => __progressSends.filter(send => send.keepalive).length), 1, "paired exit events must not duplicate an identical final snapshot when the wall clock changes");
      } finally { await page.close(); }
    });
    await run("final progress pagehide alone preserves replay zero and skips unready", async () => {
      const page = await open(), short = hold("B", info("B", { duration: 90 }));
      try {
        await page.evaluate(() => {
          window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
          window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
        });
        assert.equal(await page.evaluate(() => __progressSends.length), 0, "unready pagehide must not save a fabricated zero");
        await page.waitForFunction(() => __readFinished.length === 2); await tick(page);
        await choose(page, "B"); await short.requested; short.release(); await sourceIs(page, "B");
        await page.evaluate(() => { __media.duration = 90; __emitMedia("loadedmetadata"); });
        await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight");
        await page.mouse.click(2, 2); await page.keyboard.press("Space");
        await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
        const last = await page.evaluate(() => __progressSends.at(-1));
        assert.equal(last.body.position, 0, "a genuine replay at zero must replace completed progress on pagehide");
        assert.equal(last.body.duration, 90);
        assert.equal(last.keepalive, true);
      } finally { short.release(); await page.close(); }
    });
    await run("final progress actual navigation delivers the latest current snapshot", async () => {
      const page = await open();
      try {
        await page.evaluate(() => __emitMedia("loadedmetadata"));
        await page.keyboard.press("ArrowRight");
        await page.evaluate(() => { document.querySelector("#playerVideo").currentTime = 52.75; });
        const delivered = waitForProgressWrite(write => write.path === "/api/progress/A" && write.body.position === 52.75);
        await page.goto(`${base}/fixture-away`);
        const final = await delivered;
        assert.deepEqual(final.body, { workId: "fixture-work", position: 52.75, duration: 600 });
        assert.equal(new URL(page.url()).pathname, "/fixture-away");
      } finally { await page.close(); }
    });
    await run("final progress hidden document flushes the current position once", async () => {
      const page = await open();
      try {
        await page.evaluate(() => __emitMedia("loadedmetadata"));
        await page.keyboard.press("ArrowRight");
        await page.evaluate(() => {
          document.querySelector("#playerVideo").currentTime = 43.75;
          Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
          document.dispatchEvent(new Event("visibilitychange"));
          document.dispatchEvent(new Event("visibilitychange"));
        });
        assert.equal(await page.evaluate(() => __progressSends.at(-1).body.position), 43.75, "backgrounding must flush the current position despite a recent seek report");
        assert.equal(await page.evaluate(() => __progressSends.filter(send => send.keepalive).length), 1);
        await page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        assert.equal(await page.evaluate(() => __progressSends.filter(send => send.keepalive).length), 1, "returning to visibility does not send a second exit record");
      } finally { await page.close(); }
    });
    await run("final progress file switching captures the old file latest position", async () => {
      const page = await open();
      try {
        await page.evaluate(() => __emitMedia("loadedmetadata"));
        await page.keyboard.press("ArrowRight");
        await page.evaluate(() => { document.querySelector("#playerVideo").currentTime = 42.25; });
        await choose(page, "B"); await sourceIs(page, "B");
        const last = await page.evaluate(() => __progressSends.at(-1));
        assert.equal(last.path, "/api/progress/A");
        assert.equal(last.body.position, 42.25, "switching files must flush the old file before updating its identity");
        assert.equal(last.keepalive, false);
        await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
        assert.equal(await page.evaluate(() => __progressSends.at(-1).path), "/api/progress/A", "the unready new file cannot overwrite progress with its unloaded zero");
      } finally { await page.close(); }
    });
    await run("persisted return preserves a pending direct resume position", async () => {
      const page = await open();
      try {
        await choose(page, "B"); await sourceIs(page, "B");
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 0);
        await page.evaluate(() => {
          window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
          window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
        });
        await page.waitForFunction(() => __readSignals.length === 3);
        await sourceIs(page, "B");
        await page.evaluate(() => __emitMedia("loadedmetadata"));
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 73, "leaving before metadata must not turn a pending resume into zero");
        assert.equal(await page.evaluate(() => __media.plays.length), 1, "leaving before metadata must preserve the pending autoplay intent");
      } finally { await page.close(); }
    });
    await run("persisted return keeps an explicitly paused pending source paused", async () => {
      const page = await open();
      try {
        await page.evaluate(() => {
          __emitMedia("loadedmetadata");
          document.querySelector("#playerVideo").pause();
          window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
          window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
        });
        await page.waitForFunction(() => __readFinished.length === 2); await tick(page);
        // Leave again while the explicitly paused restore still awaits metadata.
        await page.evaluate(() => {
          window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
          window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
        });
        await page.waitForFunction(() => __readFinished.length === 3); await tick(page);
        await page.evaluate(() => __emitMedia("loadedmetadata"));
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 31);
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.paused), true);
        assert.equal(await page.evaluate(() => __media.plays.length), 1, "an explicitly paused restore must not become autoplay while waiting for metadata");
      } finally { await page.close(); }
    });
    await run("keyboard pause before metadata survives persisted return", async () => {
      const page = await open();
      try {
        await page.keyboard.press("Space");
        await page.keyboard.press("Space");
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.paused), true);
        await page.evaluate(() => {
          window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
          window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
        });
        await page.waitForFunction(() => __readFinished.length === 2); await tick(page);
        await page.evaluate(() => __emitMedia("loadedmetadata"));
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.currentTime), 31);
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.paused), true, "explicit keyboard pause while loading must survive page return");
        assert.equal(await page.evaluate(() => __media.plays.length), 1);
      } finally { await page.close(); }
    });
    await run("keyboard pause prevents late remux metadata and canplay autoplay", async () => {
      const page = await open(), remux = hold("B", info("B", { mode: "remux", label: "Synthetic remux" }));
      try {
        await choose(page, "B"); await remux.requested; remux.release();
        await page.waitForFunction(() => document.querySelector("#playerVideo").src.endsWith("/synthetic/B?t=73"));
        await page.keyboard.press("k");
        await page.evaluate(() => { __emitMedia("loadedmetadata"); __emitMedia("canplay"); });
        assert.equal(await page.locator("#playerVideo").evaluate(video => video.paused), true, "late readiness events must not undo explicit keyboard pause");
        assert.equal(await page.evaluate(() => __media.plays.length), 1);
      } finally { remux.release(); await page.close(); }
    });
    assert(checks > 0, `no player fixture cases matched: ${casePattern}`);
    assert.deepEqual(faults, []);
    console.log(`Web player lifecycle fixture passed (${checks} cases; ${realPlyr ? "actual bundled Plyr, " : ""}controlled media, synthetic API; no real decoding)`);
    return { checks };
  } finally {
    for (const receiver of progressReceivers) clearTimeout(receiver.timer);
    for (const gate of held) gate.release();
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [input, seconds] of [["0", 0], ["90.25", 90.25], ["1:23.5", 83.5], ["1:02:03.25", 3723.25], ["1：23", 83], ["120:00", 7200]]) assert.equal(parsePlaybackTimeInput(input), seconds);
  for (const input of [null, "", "-1", "1e2", "Infinity", "1:60", "1:60:00", "0:0:0:0", "9007199254740992", "1: 3"]) assert.equal(parsePlaybackTimeInput(input), null);
  const caseOption = process.argv.find(value => value.startsWith("--case="));
  await runWebPlayerFixture({ casePattern: caseOption?.slice(7) || "" });
  if (!caseOption) {
    const source = fs.readFileSync(path.join(publicRoot, "js", "player-page.js"), "utf8").replace(/\r\n/g, "\n");
    for (const negative of [
      { name: "latest play-info ignores abort old success", marker: "if (!request.isCurrent()) return;", replacement: "", failure: /late play-info must not replace/ },
      { name: "metadata belongs to latest file", marker: "const sourceEvents = { once: true, signal: controller.signal };", replacement: "const sourceEvents = { once: true };", failure: /replaced source must not apply/ },
      { name: "old success cannot clear latest play error", marker: " && attemptId === playbackAttempt", replacement: "", failure: /earlier success must not clear/ },
      { name: "pending direct keyboard seeks", marker: "const seekTarget = pendingSourcePosition ?? target;", replacement: "const seekTarget = target;", failure: /pending keyboard seeks must accumulate/ },
      { name: "direct fallback before metadata", marker: "if (pendingSourcePosition != null) return clampSeekTime(pendingSourcePosition);", replacement: "", failure: /compatibility fallback must keep the pending direct resume/ },
      { name: "paused direct fallback", marker: "const autoPlay = pendingSourceAutoPlay ?? (!els.video.paused && !els.video.ended);", replacement: "const autoPlay = true;", failure: /a paused direct source must not autoplay/ },
      { name: "deferred compatibility start resumes the live position", marker: "      pendingSourcePosition = null;\n      pendingSourceAutoPlay = null;", replacement: "      if (mode === 'direct') pendingSourcePosition = null;\n      pendingSourceAutoPlay = null;", failure: /live position after deferred compatibility metadata/ },
      { name: "persisted return preserves a pending direct resume", marker: "pendingSourceAutoPlay ?? (hasPreparedPlayback ? (!els.video.paused && !els.video.ended) : true)", replacement: "hasPreparedPlayback ? (!els.video.paused && !els.video.ended) : true", failure: /leaving before metadata must preserve the pending autoplay/ },
      { name: "keyboard pause before metadata survives", marker: "if (pendingSourcePosition != null) pendingSourceAutoPlay = false;", replacement: "", failure: /explicit keyboard pause while loading must survive/ },
      { name: "direct terminal seek before metadata", marker: "if (bounded && appliedTarget >= directDuration) pauseVideoPlayback();", replacement: "", failure: /a pending seek to the end must apply the terminal position/ },
      { name: "direct terminal seek after metadata", marker: "&& Number.isFinite(elementDuration) && elementDuration > 0) return elementDuration;", replacement: "&& false) return elementDuration;", failure: /ready direct seeks must clamp to decoded duration/ },
      { name: "direct terminal seek after metadata", marker: "if (target >= els.video.duration) pauseVideoPlayback();", replacement: "", failure: /an explicit seek to the end must stop/ },
      { name: "final progress bypasses", marker: "reportProgress(null, { force: true, keepalive: true });", replacement: "reportProgress(null, { keepalive: true });", failure: /final progress must bypass/ },
      { name: "final progress bypasses", marker: "...(options.keepalive ? { keepalive: true } : {}),", replacement: "", failure: /final progress must request delivery/ },
      { name: "final progress bypasses", marker: "if (options.keepalive && lastKeepaliveProgress?.source === playbackSourceController", replacement: "if (false && lastKeepaliveProgress?.source === playbackSourceController", failure: /paired exit events must not duplicate/ },
      { name: "final progress pagehide alone", marker: 'window.addEventListener("pagehide", () => {\n  flushPlaybackProgress();', replacement: 'window.addEventListener("pagehide", () => {', failure: /a genuine replay at zero must replace/ },
      { name: "final progress hidden document", marker: 'if (document.visibilityState === "hidden") flushPlaybackProgress();', replacement: "", failure: /backgrounding must flush/ },
      { name: "final progress file switching", marker: "async function playVideo(video, options = {}) {\n  reportProgress(null, { force: true });", replacement: "async function playVideo(video, options = {}) {\n  reportProgress();", failure: /switching files must flush the old file/ }
    ]) {
      assert(source.includes(negative.marker), `negative must change the current implementation: ${negative.name}`);
      await assert.rejects(() => runWebPlayerFixture({ casePattern: negative.name, sourceOverride: source.replaceAll(negative.marker, negative.replacement) }), { name: "AssertionError", message: negative.failure });
      console.log(`PASS negative control detects missing ${negative.name}`);
    }
  }
}
