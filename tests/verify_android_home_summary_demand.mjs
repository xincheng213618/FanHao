import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { chromium } from "playwright-core";

// The real Android entry on private loopback, with only synthetic API data.
const project = path.resolve(import.meta.dirname, "..");
const www = path.join(project, "android-client", "www");
const previousApp = execFileSync("git", ["show", "f110040d02b1eb579461248da9960e97370fa4d2:android-client/www/app.js"], { cwd: project, encoding: "utf8" });
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(fs.existsSync);
assert(executablePath, "installed private Chromium required");
const errors = [];
const server = createServer((request, response) => {
  try {
    const url = new URL(request.url, "http://fixture");
    if (url.pathname === "/favicon.ico") { response.writeHead(204); response.end(); return; }
    const filename = path.resolve(www, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    assert(filename.startsWith(`${www}${path.sep}`));
    let source = fs.readFileSync(filename);
    if (url.pathname === "/app.js") {
      source = url.searchParams.get("v") === "fixture-previous" ? previousApp : source.toString("utf8");
      const boot = "bootApp().catch((error) => {";
      assert.equal(source.split(boot).length, 2);
      source = source.replace(boot, `window.__summaryProbe = { showView, loadDashboard, connectToServer };\n${boot}`);
    }
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }[path.extname(filename)];
    response.writeHead(200, { "Content-Type": contentType || "application/octet-stream", "Cache-Control": "no-store" });
    response.end(source);
  } catch (error) { errors.push(error.message); response.destroy(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const summaries = new Map([
  ["/api/image-library/summary", value => ({ totals: { photoSets: value + 1, manga: 2, movies: value + 2, tv: 3 } })],
  ["/api/novels/summary", value => ({ totals: { books: value + 3, chapters: 6 } })],
  ["/api/music/summary", value => ({ totals: { tracks: value + 4, albums: 5 } })],
  ["/api/short-videos/summary", value => ({ totals: { videos: value + 5, authors: 1 } })]
]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run(browser, previous, earlyHome = false) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  await context.addInitScript(() => localStorage.setItem("fanhao.serverUrl", location.origin));
  let holdOld = null, holdFresh = null;
  const holdLibrary = earlyHome ? Promise.withResolvers() : null;
  let libraryReplied = false;
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route(url => url.origin !== base, route => route.abort());
    await page.route("**/fixture-avatar.svg", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' }));
    if (previous) await page.route("**/app.js?*", route => route.continue({ url: `${base}/app.js?v=fixture-previous` }));
    let stage = 1;
    const requests = [];
    const oldReached = Promise.withResolvers();
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/library") {
        if (holdLibrary) await holdLibrary.promise;
        libraryReplied = true;
        return route.fulfill({ json: {
          people: [{ id: "synthetic-person", name: "Synthetic person", workCount: 2,
            actorProfile: { gender: "female", avatarUrl: "/fixture-avatar.svg" } }], works: [], totals: { people: 1, works: 2 }, access: { mode: "loopback" }
        } });
      }
      if (url.pathname === "/api/modules") return route.fulfill({ json: { modules: [] } });
      const summary = summaries.get(url.pathname);
      if (!summary) return route.fulfill({ json: {} });
      const group = stage;
      requests.push({ path: url.pathname, group });
      if (group === 3 && requests.filter(request => request.group === 3).length === 4) oldReached.resolve();
      if (group === 3 && holdOld) await holdOld.promise;
      if (group === 5 && holdFresh) await holdFresh.promise;
      if (group === 1) await delay(150);
      return route.fulfill({ json: summary(group * 10), headers: { "X-Fixture-Group": String(group) } });
    });
    const go = view => page.evaluate(view => __summaryProbe.showView(view), view);
    const refresh = () => page.evaluate(() => __summaryProbe.loadDashboard());
    const requestCount = group => requests.filter(request => request.group === group).length;
    const waitForValues = group => page.waitForFunction(group => {
      const count = group * 10;
      const matches = (id, value) => document.getElementById(id)?.textContent.includes(String(value));
      return matches("channelPhotoCount", count + 1) && matches("channelNovelCount", count + 3)
        && matches("channelMusicCount", count + 4) && matches("channelShortVideoCount", count + 5)
        && document.querySelectorAll("#omniGrid .omni-card").length === 7;
    }, group);

    if (earlyHome) {
      const library = page.waitForRequest(request => new URL(request.url()).pathname === "/api/library");
      await page.goto(base); await library;
      assert.equal(requestCount(1), 0);
      await go("home"); await waitForValues(1);
      assert.equal(requestCount(1), 4); assert.equal(libraryReplied, false);
      const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/library");
      holdLibrary.resolve(); await response;
      return { summaryRequests: 4, completedWhileLibraryHeld: true };
    }

    await page.goto(base);
    await page.locator(".index-person-card").first().waitFor();
    if (previous) await waitForValues(1);
    assert.equal(await page.locator("#omniSection").isHidden(), true);
    const startupRequests = requestCount(1);
    assert.equal(startupRequests, previous ? 4 : 0);
    const start = performance.now();
    await go("home");
    await page.locator("#omniSection").waitFor();
    await waitForValues(1);
    const firstHomeMs = Math.round(performance.now() - start);
    assert.deepEqual(requests.filter(request => request.group === 1).map(request => request.path).sort(), [...summaries.keys()].sort());
    await go("people"); await go("home"); await waitForValues(1);
    assert.equal(requestCount(1), 4, "same-source Home reopen must reuse its summaries");

    await go("people");
    stage = 2;
    await refresh();
    if (previous) await waitForValues(2);
    assert.equal(requestCount(2), previous ? 4 : 0, "a hidden refresh should defer Home-only summaries");
    await go("home"); await waitForValues(2); assert.equal(requestCount(2), 4);

    if (!previous) {
      stage = 3;
      holdOld = Promise.withResolvers();
      await refresh();
      let timeout;
      try {
        await Promise.race([oldReached.promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error("old refresh did not start")), 5000); })]);
      } finally { clearTimeout(timeout); }
      stage = 4;
      await refresh(); await waitForValues(4); assert.equal(requestCount(4), 4);
      const responses = Promise.all([...summaries.keys()].map(path => page.waitForResponse(response =>
        new URL(response.url()).pathname === path && response.headers()["x-fixture-group"] === "3")));
      holdOld.resolve();
      await Promise.all((await responses).map(response => response.finished()));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.match(await page.locator("#channelNovelCount").innerText(), /^43 本/, "older refresh must not overwrite newer visible data");
    }

    await go("people");
    const cachedGroup = previous ? 2 : 4;
    stage = 5;
    holdFresh = Promise.withResolvers();
    await page.reload(); await page.locator(".index-person-card").first().waitFor();
    if (previous) await waitForValues(cachedGroup);
    else assert.equal(requestCount(5), 0, "warm reload still defers Home-only requests");
    const warmStarted = performance.now();
    await go("home"); await waitForValues(cachedGroup);
    const warmHomeMs = Math.round(performance.now() - warmStarted);
    holdFresh.resolve(); await waitForValues(5); assert.equal(requestCount(5), 4);

    await go("people");
    stage = 6;
    assert.equal(await page.evaluate(() => __summaryProbe.connectToServer(location.origin)), true);
    if (previous) await waitForValues(6);
    else assert.equal(requestCount(6), 0, "a same-source reconnect while hidden defers summary work");
    await go("home"); await waitForValues(6); assert.equal(requestCount(6), 4);
    await go("people"); await go("home"); assert.equal(requestCount(6), 4, "reopening after a reconnect does not refetch the same batch");
    return { startupRequests, firstHomeRequests: 4 - startupRequests, firstHomeMs, warmHomeMs };
  } finally {
    holdOld?.resolve();
    holdFresh?.resolve();
    holdLibrary?.resolve();
    await context.close();
  }
}

let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  console.log(JSON.stringify({ mode: "previous", ...await run(browser, true) }));
  if (!process.argv.includes("--baseline-only")) {
    console.log(JSON.stringify({ mode: "current", ...await run(browser, false) }));
    console.log(JSON.stringify({ mode: "early Home", ...await run(browser, false, true) }));
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
