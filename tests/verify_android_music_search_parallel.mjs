import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright-core";

const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(file => fs.existsSync(file));
assert(chrome, "Chrome or Edge is required for the Android search fixture");
const baseline = process.argv.includes("--baseline"), delayMs = 155;
const service = spawn(process.execPath, ["tests/serve_android_gallery_navigation_fixture.mjs"], { cwd: new URL("../", import.meta.url), stdio: ["ignore", "pipe", "inherit"] });
const exit = new Promise(resolve => service.once("exit", resolve));
const endpoints = ["tracks", "artists", "albums", "lyrics/search"];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const isLookup = (request, endpoint, query) => {
  const url = new URL(request.url());
  return url.pathname === `/api/music/${endpoint}` && url.searchParams.get("q") === query;
};
const mobile = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
let browser;
try {
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Synthetic service start timed out")), 15000);
    service.once("error", error => { clearTimeout(timer); reject(error); });
    service.once("exit", code => { clearTimeout(timer); reject(new Error(`Synthetic service exited ${code}`)); });
    let output = "";
    service.stdout.on("data", data => { output += data; const url = /http:\/\/127\.0\.0\.1:\d+/.exec(output); if (url) { clearTimeout(timer); resolve(url[0]); } });
  });
  const created = await fetch(`${origin}/fixture/new-run?scenario=music-search`, { method: "POST" });
  assert.equal(created.status, 200);
  const run = await created.json();
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  for (const route of ["entry", "submit"]) {
    const samples = [];
    for (let index = 0; index < 3; index++) {
      const query = route === "entry" ? "合成" : "合成歌手";
      const lyric = `合成歌词命中：${query}`;
      const page = await browser.newPage(mobile);
      const faults = [], timing = new Map();
      page.on("pageerror", error => faults.push(error.message));
      try {
        await page.route("**/*", async intercepted => {
          const request = intercepted.request(), url = new URL(request.url());
          if (url.origin !== origin || !["GET", "HEAD"].includes(request.method())) {
            faults.push(`${request.method()} ${url.origin}${url.pathname}`);
            return intercepted.abort();
          }
          const endpoint = url.pathname.replace(/^\/api\/music\//, "");
          if (!endpoints.includes(endpoint) || url.searchParams.get("q") !== query) return intercepted.continue();
          assert(!timing.has(endpoint), `one ${endpoint} read for ${query}`);
          const record = { start: performance.now(), end: 0 };
          timing.set(endpoint, record);
          const [response] = await Promise.all([intercepted.fetch(), delay(delayMs)]);
          record.end = performance.now();
          if (endpoint !== "lyrics/search") return intercepted.fulfill({ response });
          const payload = await response.json();
          payload.total = 1;
          payload.matches = [{ track: { id: "fixture-lyric-match", title: "合成命中歌曲", artist: "合成歌手" }, text: lyric, timeMs: 1250 }];
          return intercepted.fulfill({ response, json: payload });
        });
        if (baseline) await page.route(url => url.pathname.endsWith("/modules/music/music-views.js"), async intercepted => {
          const response = await intercepted.fetch();
          const body = await response.text();
          const marker = "  function startComprehensiveSearch(requestUrl, routeSignal) {";
          assert.equal(body.split(marker).length, 2, "baseline disables only the early secondary requests");
          await intercepted.fulfill({ response, body: body.replace(marker, `${marker}\n    return null;`) });
        });
        await page.addInitScript(({ query, lyric, submit }) => {
          const result = window.searchTimings = {};
          const inspect = () => {
            const input = document.querySelector(".music-mobile-search-input");
            if (input?.value !== query || (submit && !result.start)) return;
            if (!result.songs && document.querySelector(".music-mobile-search-content-region .music-mobile-track[data-track-id]")) result.songs = performance.now();
            if (!result.classified && document.querySelector(".music-mobile-search-artist-rail, .music-mobile-search-album-rail")) result.classified = performance.now();
            if (!result.lyrics && [...document.querySelectorAll(".music-mobile-lyric-search-context")].some(node => node.textContent.includes(lyric))) result.lyrics = performance.now();
          };
          new MutationObserver(inspect).observe(document, { childList: true, subtree: true });
          document.addEventListener("keydown", event => {
            if (event.key === "Enter" && event.target.matches(".music-mobile-search-input") && event.target.value === query) result.start = performance.now();
          }, true);
        }, { query, lyric, submit: route === "submit" });
        await page.goto(`${origin}${run.url}`);
        if (route === "submit") {
          await page.locator(".music-mobile-search-artist-rail").waitFor();
          const input = page.locator(".music-mobile-search-input");
          await input.fill(query);
          await input.press("Enter");
        }
        await page.waitForFunction(() => searchTimings.songs && searchTimings.classified && searchTimings.lyrics);
        assert.deepEqual(faults, []);
        const tracks = timing.get("tracks");
        assert.equal(timing.size, 4, "songs, artist, album and lyric endpoint set stays unchanged");
        assert(endpoints.slice(1).every(endpoint => baseline ? timing.get(endpoint).start >= tracks.end : timing.get(endpoint).start < tracks.end),
          "the secondary lookups either wait for tracks or start while its response is in flight");
        const ui = await page.evaluate(() => searchTimings);
        const start = ui.start || 0;
        samples.push({ songs: ui.songs - start, classified: ui.classified - start, lyrics: ui.lyrics - start,
          lastRequestStart: Math.max(...[...timing.values()].map(record => record.start)) - tracks.start });
      } finally { await page.close(); }
    }
    console.log(JSON.stringify({ route, baseline, delayMs, samples, medians: Object.fromEntries(Object.keys(samples[0]).map(key => [key, median(samples.map(sample => sample[key]))])), reads: 4 }));
  }
  if (!baseline) {
    for (const boundary of ["new query", "account", "tracks failure"]) await checkBoundary(origin, run.url, boundary);
  }
} finally {
  await browser?.close(); service.kill("SIGTERM"); await Promise.race([exit, delay(3000)]);
}

async function checkBoundary(origin, fixtureUrl, boundary) {
  const page = await browser.newPage(mobile);
  const query = "合成歌手", newQuery = "合成晴空";
  const staleText = "不应显示的旧歌词";
  let releaseTracks, releaseSections;
  const trackGate = new Promise(resolve => { releaseTracks = resolve; });
  const sectionGate = new Promise(resolve => { releaseSections = resolve; });
  const faults = [];
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin || !["GET", "HEAD"].includes(request.method())) {
        faults.push(`${request.method()} ${url.origin}${url.pathname}`);
        return route.abort();
      }
      const endpoint = endpoints.find(name => isLookup(request, name, query));
      if (!endpoint) return route.continue();
      if (endpoint === "tracks") {
        await trackGate;
        if (boundary === "tracks failure") return route.fulfill({ status: 503, json: { error: "合成歌曲请求失败" } });
      }
      if (boundary === "tracks failure") await sectionGate;
      if (endpoint === "lyrics/search") return route.fulfill({ json: { total: 1, limit: 4, matches: [{
        text: staleText, track: { id: "fixture-boundary-lyric", title: "合成歌曲", artist: "合成歌手" }
      }] } });
      return route.continue();
    });
    await page.goto(`${origin}${fixtureUrl}`);
    await page.locator(".music-mobile-search-artist-rail").waitFor();
    const input = page.locator(".music-mobile-search-input");
    const sectionEndpoints = endpoints.slice(1);
    const started = sectionEndpoints.map(endpoint => page.waitForEvent(boundary === "tracks failure" ? "request" : "response", {
      predicate: item => isLookup(boundary === "tracks failure" ? item : item.request(), endpoint, query)
    }));
    await input.fill(query);
    await input.press("Enter");
    await Promise.all(started);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(await page.getByText(staleText, { exact: true }).count(), 0, "completed auxiliary results wait for their primary songs");
    assert.equal(await page.locator(".music-mobile-search-artist-rail").count(), 0);
    if (boundary === "tracks failure") {
      const cancelled = sectionEndpoints.map(endpoint => page.waitForEvent("requestfailed", { predicate: request => isLookup(request, endpoint, query) }));
      releaseTracks();
      await page.waitForFunction(() => document.querySelector("#viewMeta")?.textContent === "合成歌曲请求失败");
      for (const request of await Promise.all(cancelled)) assert.match(request.failure().errorText, /ERR_ABORTED/);
      releaseSections();
    } else {
      const cancelled = page.waitForEvent("requestfailed", { predicate: request => isLookup(request, "tracks", query) });
      if (boundary === "account") {
        await page.evaluate(async () => {
          const { setAccountOwner } = await import(new URL("./js/account-owner.js", location.href));
          setAccountOwner(location.origin, "pending");
        });
        await page.waitForFunction(() => !document.querySelector(".music-mobile-search-input"));
      } else {
        await input.fill(newQuery);
        await input.press("Enter");
        await page.waitForFunction(query => document.querySelector(".music-mobile-search-input")?.value === query
          && document.querySelector(".music-mobile-track[data-track-id]"), newQuery);
      }
      assert.match((await cancelled).failure().errorText, /ERR_ABORTED/);
      releaseTracks();
    }
    assert.equal(await page.getByText(staleText, { exact: true }).count(), 0);
    assert.deepEqual(faults, []);
    assert.deepEqual(errors, []);
    console.log(`PASS ${boundary}: held comprehensive search cannot publish stale sections`);
  } finally { releaseTracks(); releaseSections(); await page.close(); }
}
