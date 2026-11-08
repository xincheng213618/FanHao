import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(file => fs.existsSync(file));
assert(chrome, "Chrome or Edge required for the actual Android startup fixture");
const baseline = process.argv.includes("--baseline");
const service = spawn(process.execPath, ["tests/serve_android_gallery_navigation_fixture.mjs"], { cwd: new URL("../", import.meta.url), stdio: ["ignore", "pipe", "inherit"] });
const exit = new Promise(resolve => service.once("exit", resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const moduleEntry = /\/modules\/[^/]+\/android-module\.js$/;
const mobile = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
let browser;
try {
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Synthetic service start timed out")), 15000);
    service.once("error", error => { clearTimeout(timer); reject(error); });
    service.once("exit", code => { clearTimeout(timer); reject(new Error(`Synthetic service exited ${code}`)); });
    let output = "";
    service.stdout.on("data", data => { output += data; const url = /http:\/\/127\.0\.0\.1:\d+/.exec(output); if (url) { clearTimeout(timer); resolve(url[0]); } });
  });
  const created = await fetch(`${origin}/fixture/new-run`, { method: "POST" });
  assert.equal(created.status, 200);
  const { url } = await created.json();
  const entry = `${origin}${url}#tools`;
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  for (const { name, bridgeMs, assetMs } of [
    { name: "local", bridgeMs: 0, assetMs: 0 },
    { name: "slow-session", bridgeMs: 135, assetMs: 0 },
    { name: "slow-session-and-assets", bridgeMs: 135, assetMs: 95 }
  ]) {
    const samples = [];
    for (let iteration = 0; iteration < 4; iteration++) {
      const page = await browser.newPage(mobile);
      const entries = [], errors = [];
      page.on("pageerror", error => errors.push(error.message));
      try {
        await page.route("**/*", async route => {
          const request = route.request(), url = new URL(request.url());
          if (url.origin !== origin || !["GET", "HEAD"].includes(request.method())) {
            errors.push(`${request.method()} ${url.origin}${url.pathname}`);
            return route.abort();
          }
          if (moduleEntry.test(url.pathname)) {
            entries.push(request.url());
            if (assetMs) await delay(assetMs);
          }
          return route.continue();
        });
        if (baseline) await page.route(url => url.pathname.endsWith("/www/app.js"), async route => {
          const response = await route.fetch(), body = await response.text();
          const marker = "const preparedImports = prepareAndroidModuleImports(CLIENT_VERSION);";
          assert.equal(body.split(marker).length, 2, "baseline removes only eager bundled module imports");
          await route.fulfill({ response, body: body.replace(marker, "const preparedImports = undefined;") });
        });
        await page.addInitScript(ms => {
          const state = window.startupMeasurements = {};
          window.Capacitor = { Plugins: { FanHaoAuth: { getSession: () => {
            state.sessionStart = performance.now();
            return new Promise(resolve => setTimeout(() => { state.sessionEnd = performance.now(); resolve({ token: "" }); }, ms));
          } } } };
          const observer = new MutationObserver(() => {
            if (!document.querySelector(".tools-profile-header") || !document.getElementById("appStartup")?.hidden) return;
            state.firstTools = performance.now();
            observer.disconnect();
          });
          observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
        }, bridgeMs);
        await page.goto(entry);
        await page.locator(".tools-profile-header").waitFor();
        assert.deepEqual(errors, []);
        assert.equal(entries.length, 7, "each bundled entry is transferred exactly once");
        assert.equal(new Set(entries).size, 7);
        const measurement = await page.evaluate(() => ({ ...window.startupMeasurements,
          resources: performance.getEntriesByType("resource").filter(entry => /\/modules\/[^/]+\/android-module\.js\?client=/.test(entry.name))
            .map(({ startTime, responseEnd, initiatorType }) => ({ startTime, responseEnd, initiatorType })) }));
        const firstModule = Math.min(...measurement.resources.map(value => value.startTime));
        assert.equal(measurement.resources.length, 7);
        assert(Number.isFinite(measurement.firstTools));
        if (bridgeMs > 0) assert(baseline ? firstModule >= measurement.sessionEnd : firstModule < measurement.sessionEnd,
          "bundled entries either wait for the native account bridge or overlap it");
        if (iteration > 0) samples.push({ firstTools: measurement.firstTools, firstModule, sessionEnd: measurement.sessionEnd });
      } finally { await page.close(); }
    }
    console.log(JSON.stringify({ name, baseline, bridgeMs, assetMs, samples,
      medianMs: median(samples.map(row => row.firstTools)), moduleRequests: 7 }));
  }
  if (!baseline) await verifyCachedSelection(origin, entry);
} finally {
  await browser?.close(); service.kill("SIGTERM"); await Promise.race([exit, delay(3000)]);
}

async function verifyCachedSelection(origin, entry) {
  const page = await browser.newPage(mobile);
  let reload = false;
  const errors = [], reads = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.addInitScript(() => {
      window.startupModules = { evaluated: [], factories: [], sessionReady: false };
      window.Capacitor = { Plugins: { FanHaoAuth: { getSession: () => new Promise(resolve => {
        window.finishStartupSession = () => {
          window.startupModules.sessionReady = true;
          resolve({ token: "" });
        };
      }) } } };
    });
    await page.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      assert.equal(url.origin, origin);
      assert(["GET", "HEAD"].includes(request.method()));
      if (url.pathname.startsWith("/api/")) return route.abort();
      if (!url.pathname.endsWith("/modules/tools/android-module.js")) return route.continue();
      const selected = url.searchParams.get("fixtureCatalog") || "bundled";
      reads.push(selected);
      if (reload && selected === "bundled") return route.fulfill({ status: 404, body: "Unused bundled entry intentionally unavailable" });
      const response = await route.fetch(), source = await response.text();
      const marker = "export function createAndroidModule({ host }) {";
      assert.equal(source.split(marker).length, 2, "observe the actual Tools factory without replacing its behavior");
      const tag = JSON.stringify(selected);
      const body = source.replace(marker, `${marker}\n  window.startupModules.factories.push({ selected: ${tag}, sessionReady: window.startupModules.sessionReady });`)
        + `\nwindow.startupModules.evaluated.push(${tag});`;
      return route.fulfill({ response, body });
    });
    await page.goto(entry, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.finishStartupSession && window.startupModules.evaluated.includes("bundled"));
    assert.deepEqual(await page.evaluate(() => window.startupModules.factories), []);
    await page.evaluate(() => window.finishStartupSession());
    await page.locator(".tools-profile-header").waitFor();
    assert.deepEqual(await page.evaluate(() => window.startupModules.factories), [{ selected: "bundled", sessionReady: true }]);
    await page.evaluate(async () => {
      const { readCachedJson, writeCachedJson } = await import(new URL("./js/cache.js", location.href));
      const modules = [{ id: "tools", client: { android: { entry: "./modules/tools/android-module.js?fixtureCatalog=cached" } } }];
      await writeCachedJson(location.origin, "/api/modules", { modules });
      if (!(await readCachedJson(location.origin, "/api/modules"))?.payload?.modules) throw new Error("Missing catalogue in isolated IndexedDB");
    });
    reload = true;
    const failedUnused = page.waitForResponse(response => response.url().includes("/modules/tools/android-module.js?client=") && response.status() === 404);
    await page.reload({ waitUntil: "domcontentloaded" });
    await failedUnused;
    await page.waitForFunction(() => window.finishStartupSession);
    assert.deepEqual(await page.evaluate(() => window.startupModules.factories), []);
    await page.evaluate(() => window.finishStartupSession());
    await page.locator(".tools-profile-header").waitFor();
    assert.deepEqual(reads, ["bundled", "bundled", "cached"]);
    assert.deepEqual(await page.evaluate(() => window.startupModules.factories), [{ selected: "cached", sessionReady: true }]);
    assert.deepEqual(errors, [], "an unused rejected import does not surface as an unhandled error");
    console.log("PASS offline bundled tools, IndexedDB-selected override, factory ordering and unused import failure");
  } finally { await page.close(); }
}
