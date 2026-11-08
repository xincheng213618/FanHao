import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Real Android app, input, navigation and search module. Request bodies and
// media metadata are synthetic; the browser and API fixture use private loopback.
const root = fileURLToPath(new URL("../", import.meta.url));
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(fs.existsSync);
assert(executablePath, "installed private Chromium required");
const legacy = new Map(["search-page.js", "work-views.js"].map(name => {
  const path = `android-client/www/modules/fanhao/${name}`;
  return [name, execFileSync("git", ["show", `f110040d02b1eb579461248da9960e97370fa4d2:${path}`], { cwd: root, encoding: "utf8" })];
}));
const server = spawn(process.execPath, ["tests/serve_android_gallery_navigation_fixture.mjs"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
const serverExit = once(server, "exit");
const prefixes = ["S", "SY", "SYN", "SYN-0"];
const payloadSize = 120;
const latencyQueries = new Set([prefixes.at(-1), "SETTLED", "EXPANDED"]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser;
try {
  const origin = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(Error("private fixture startup timed out")), 10000);
    server.stdout.on("data", bytes => {
      output += bytes;
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    server.once("error", error => { clearTimeout(timer); reject(error); });
    server.once("exit", code => { clearTimeout(timer); reject(Error(`private fixture exited (${code})`)); });
  });
  browser = await chromium.launch({ executablePath, headless: true });
  for (const previous of process.argv.includes("--baseline-only") ? [true] : [true, false]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
    page.setDefaultTimeout(10000);
    const requests = [], faults = [];
    page.on("pageerror", error => faults.push(error.message));
    await page.route(url => url.origin !== origin, route => route.abort());
    if (previous) await page.route(url => url.pathname.includes("/modules/fanhao/") && legacy.has(url.pathname.split("/").at(-1)), route =>
      route.fulfill({ contentType: "text/javascript", body: legacy.get(new URL(route.request().url()).pathname.split("/").at(-1)) }));
    await page.route(url => url.origin === origin && url.pathname === "/api/fanhao/search", async route => {
      const url = new URL(route.request().url());
      const q = url.searchParams.get("q"), category = url.searchParams.get("category");
      const limit = Number(url.searchParams.get("limit"));
      const total = q === "DIRECT" ? 1 : payloadSize;
      const works = Array.from({ length: Math.min(limit, total) }, (_, index) => ({
        id: q === "DIRECT" ? "fixture-fanhao-work-1" : `fixture-${q}-${index}`,
        title: `Synthetic result ${q} ${index + 1}`, category, personName: "Fixture person",
        modifiedAt: "2026-10-01T00:00:00.000Z", videoCount: 0, playableCount: 0,
        cachedCover: { coverUrl: "/fixture/poster/work-one.svg" }
      }));
      const data = { q, category, total, limit, offset: 0, count: works.length, works, people: [], facets: { all: total }, traitFacets: {} };
      const json = JSON.stringify(data);
      requests.push({ q, limit, category, filter: url.searchParams.get("filter"), sort: url.searchParams.get("sort"),
        offset: url.searchParams.get("offset"), rows: works.length, bytes: Buffer.byteLength(json) });
      if (limit > 6 && latencyQueries.has(q)) await delay(150);
      return route.fulfill({ contentType: "application/json", body: json });
    });
    try {
      const run = await page.request.post(`${origin}/fixture/new-run?scenario=fanhao-search`);
      assert(run.ok(), await run.text());
      await page.goto(new URL((await run.json()).url, origin).href);
      const input = page.locator(".fanhao-search-page-field input");
      const cards = page.locator(".fanhao-search-results .work-card");
      const suggestion = page.locator(".fanhao-search-suggestion.work").first();
      await cards.first().waitFor();
      const waitSuggestion = async query => {
        await input.fill(query);
        await page.waitForFunction(q => document.querySelector(".fanhao-search-suggestion.work strong")?.textContent.includes(`result ${q} 1`), query);
      };
      const submit = async query => {
        const start = performance.now();
        await input.press("Enter");
        await page.waitForFunction(q => document.querySelector(".fanhao-search-results .work-card-title")?.textContent.includes(`result ${q} 1`), query);
        return Math.round(performance.now() - start);
      };
      const waitWarm = async query => {
        const response = page.waitForResponse(response => {
          const url = new URL(response.url());
          return url.pathname === "/api/fanhao/search" && url.searchParams.get("q") === query && Number(url.searchParams.get("limit")) > 6;
        });
        await waitSuggestion(query);
        await (await response).finished();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      };
      for (const query of prefixes) await waitSuggestion(query);
      const last = prefixes.at(-1);
      await delay(180);
      const typing = requests.filter(entry => prefixes.includes(entry.q));
      assert.deepEqual(typing.filter(entry => entry.limit === 6).map(entry => entry.q), prefixes);
      assert.deepEqual(typing.filter(entry => entry.limit > 6).map(entry => entry.q), previous ? prefixes : []);
      const briefSubmitMs = await submit(last);
      const committed = requests.filter(entry => prefixes.includes(entry.q));
      assert.equal(committed.filter(entry => entry.q === last && entry.limit === 48).length, 1, "commit uses one full current-query result request");
      assert.deepEqual(committed.filter(entry => entry.q !== last && entry.limit > 6).map(entry => entry.q), previous ? prefixes.slice(0, -1) : []);

      await waitWarm("SETTLED");
      const settledSubmitMs = await submit("SETTLED");
      assert.deepEqual(requests.filter(entry => entry.q === "SETTLED" && entry.limit > 6).map(entry => entry.limit), [48]);

      await page.locator(".fanhao-search-results .load-more button").click();
      await page.waitForFunction(() => document.querySelectorAll(".fanhao-search-results .work-card").length === 96);
      await waitWarm("EXPANDED");
      const expandedSubmitMs = await submit("EXPANDED");
      assert.deepEqual(requests.filter(entry => entry.q === "EXPANDED" && entry.limit > 6).map(entry => entry.limit).sort((a, b) => a - b), previous ? [48, 96] : [48]);

      await waitSuggestion("DIRECT");
      await suggestion.click();
      await page.waitForURL(url => url.hash.includes("workId=fixture-fanhao-work-1"));
      await page.locator(".work-detail-hero").waitFor();
      assert.deepEqual(requests.filter(entry => entry.q === "DIRECT").map(entry => entry.limit).sort((a, b) => a - b), previous ? [6, 48] : [6]);
      assert(requests.every(entry => entry.category === "censored" && entry.filter === "all" && entry.sort === "updated" && entry.offset === "0"),
        "suggestion, submit and continuation retain the dedicated route's actual query parameters");
      assert.deepEqual(faults, []);
      const summarize = list => ({ requests: list.length, rows: list.reduce((sum, entry) => sum + entry.rows, 0), jsonBytes: list.reduce((sum, entry) => sum + entry.bytes, 0) });
      console.log(JSON.stringify({ mode: previous ? "previous" : "current", beforeSubmit: summarize(typing), throughSubmit: summarize(committed),
        expandedListSubmit: summarize(requests.filter(entry => entry.q === "EXPANDED")), directSuggestion: summarize(requests.filter(entry => entry.q === "DIRECT")),
        submitToFirstResultMs: { brief: briefSubmitMs, settled: settledSubmitMs, expandedAndSettled: expandedSubmitMs } }));
    } finally { await page.close(); }
  }
} finally {
  await browser?.close();
  server.kill();
  await serverExit;
}
