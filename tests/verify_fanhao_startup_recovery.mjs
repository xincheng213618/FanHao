import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Real FanHao shell/router, private loopback reads and synthetic records only.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), publicRoot = path.join(root, "public");
export async function runStartupRecovery({ casePattern = "", sourceOverrides = {} } = {}) {
  const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean).find(file => fs.existsSync(file));
  assert(executablePath, "private Chromium required");
  let runtime, checks = 0;
  const faults = [], held = new Set();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture"), current = runtime;
    try {
      assert.equal(req.method, "GET", "startup recovery must not issue writes");
      if (url.pathname === "/api/library") {
        current.reads.push(url.search);
        const plan = current.plans.shift() || current.lastPlan || {};
        current.lastPlan = plan; plan.arrived?.(); if (plan.wait) await plan.wait;
        if (plan.delay) await new Promise(resolve => setTimeout(resolve, plan.delay));
        if (plan.error) { json(res, { error: plan.error }, 503); return; }
        const scope = url.searchParams.get("scope") || "main";
        json(res, { people: [0, 1, 2].map(index => ({ id: `person-${index}`, name: `Synthetic ${scope} person ${index}`, workCount: 3 })), works: [], totals: {}, user: {}, access: { mode: "local" }, scope }); return;
      }
      if (["/api/favorites", "/api/history", "/api/works", "/api/search"].includes(url.pathname)) {
        if (current.collectionError) { json(res, { error: current.collectionError }, 503); return; }
        json(res, { works: [0, 1, 2].map(index => ({ id: `work-${index}`, title: `Synthetic work ${index}`, favorite: true, videoCount: 1, playableCount: 1 })), count: 3, total: 3, folders: [] }); return;
      }
      if (url.pathname.startsWith("/api/")) { json(res, {}); return; }
      if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      const filename = path.resolve(publicRoot, `.${decodeURIComponent(url.pathname)}`);
      assert(filename.startsWith(`${publicRoot}${path.sep}`), "static reads stay in public");
      const target = fs.statSync(filename, { throwIfNoEntry: false })?.isFile() ? filename : path.join(publicRoot, "index.html");
      const type = target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : "text/html; charset=utf-8";
      const asset = current.assets.get(url.pathname);
      if (asset) {
        current.assetReads.push(`${url.pathname}${url.search}`);
        if (!asset.used) {
          asset.used = true; asset.arrived(); await asset.wait;
        }
        if (asset.error) { send(res, asset.error, type, 503); return; }
      }
      send(res, sourceOverrides[url.pathname] ?? await fs.promises.readFile(target), type);
    } catch (error) { faults.push(error.message); json(res, { error: error.message }, 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ executablePath, headless: true });
  const run = async (name, task) => { if (casePattern && !name.includes(casePattern)) return; await task(); checks++; console.log(`PASS ${name}`); };
  try {
    await run("FanHao cold entry overlaps shell and core delivery with styles", async () => {
      const css = "/modules/fanhao/work-cards.css", shell = "/fanhao-app.js", core = "/app.js", delay = 240;
      const assets = new Map([css, shell, core].map(asset => [asset, gate()]));
      for (const asset of assets.values()) asset.requested.then(() => setTimeout(asset.release, delay));
      const page = await open("/fanhao", [], false, "", { assets, waitUntil: "commit" });
      try {
        const at = await firstVisiblePerson(page);
        const timings = await page.evaluate(({ css, shell, core, at }) => {
          const entries = performance.getEntriesByType("resource");
          const resource = path => entries.find(entry => new URL(entry.name).pathname === path);
          const style = resource(css), start = style.startTime;
          return { shellStartMs: Math.round(resource(shell).startTime - start), coreStartMs: Math.round(resource(core).startTime - start),
            styleEndMs: Math.round(style.responseEnd - start), firstCardMs: Math.round(at - start) };
        }, { css, shell, core, at });
        console.log("MEASURE FanHao cold scripts", JSON.stringify({ delay, ...timings, assetReads: runtime.assetReads }));
        assert.equal(await page.locator(".person-index-card").count(), 3);
        assert.equal(runtime.reads.length, 1);
        for (const path of [shell, core]) assert.equal(runtime.assetReads.filter(url => url.split("?")[0] === path).length, 1, "preload and import must use one versioned URL");
        assert(timings.shellStartMs < timings.styleEndMs && timings.coreStartMs < timings.styleEndMs,
          "both FanHao scripts must begin downloading during style delivery");
      } finally { for (const asset of assets.values()) asset.release(); await page.close(); }
    });
    await run("FanHao downloaded modules wait for a late style failure", async () => {
      const style = gate(); style.error = "Synthetic unavailable stylesheet";
      const page = await open("/fanhao", [], false, "", {
        assets: new Map([["/modules/fanhao/work-cards.css", style]]), waitUntil: "commit"
      });
      try {
        await style.requested;
        await page.waitForFunction(() => {
          const paths = performance.getEntriesByType("resource").map(entry => new URL(entry.name).pathname);
          return paths.includes("/fanhao-app.js") && paths.includes("/app.js");
        }, null, { timeout: 5000 });
        assert.equal(await page.evaluate(() => document.documentElement.dataset.appModule || null), null,
          "downloaded shell and core must wait until stylesheet processing settles before executing");
        assert.equal(runtime.reads.length, 0);
        style.release();
        await firstVisiblePerson(page);
        const notice = page.locator("#appStartupNotice");
        assert.equal(await notice.getAttribute("role"), "status");
        assert.equal(await notice.locator("h2").textContent(), "部分页面样式未加载");
        assert.equal(await notice.isVisible(), true);
      } finally { style.release(); await page.close(); }
    });
    await run("FanHao unavailable preloaded core retains startup recovery", async () => {
      const core = gate(); core.error = "Synthetic unavailable core";
      const page = await open("/fanhao", [], false, "", { assets: new Map([["/app.js", core]]), waitUntil: "commit" });
      try {
        await core.requested; core.release();
        const notice = page.locator('#appStartupNotice[role="alert"]');
        await notice.waitFor();
        assert.equal(await notice.locator("h2").textContent(), "页面未能启动");
        assert.equal(await notice.locator("button").isVisible(), true);
        await page.waitForFunction(() => !document.documentElement.classList.contains("app-module-loading"));
        assert.equal(runtime.reads.length, 0);
      } finally { core.release(); await page.close(); }
    });
    await run("western cold entry opens with one scoped library read", async () => {
      const delay = 300;
      const page = await open("/western", [{ delay }, { delay }]);
      try {
        const visibleAt = await (await page.waitForFunction(() => {
          const card = document.querySelector(".person-index-card");
          return card?.textContent.includes("Synthetic western person") && getComputedStyle(card).visibility === "visible" ? performance.now() : null;
        })).jsonValue();
        const visibleMs = await page.evaluate(visibleAt => {
          const first = performance.getEntriesByType("resource").find(entry => new URL(entry.name).pathname === "/api/library");
          return Math.round(visibleAt - first.startTime);
        }, visibleAt);
        console.log("MEASURE western cold people", JSON.stringify({ delay, libraryReads: runtime.reads, visibleMs }));
        assert.deepEqual(runtime.reads, ["?scope=western"], "western cold entry must read only its requested library scope");
        assert.equal(await page.locator(".person-index-card").count(), 3);
        assert.equal(new URL(page.url()).pathname, "/western");
      } finally { await page.close(); }
    });
    for (const route of ["/fanhao", "/fanhao/favorites", "/western"]) {
      await run(`${route} startup failure retries in place with keyboard and history`, async () => {
        const message = `Synthetic startup failure ${"long-detail-without-spaces-".repeat(12)}`;
        const page = await open(route, [{ error: message }]);
        try {
          await errorVisible(page, message);
          const before = await page.evaluate(() => [location.href, history.length]);
          const retry = page.locator(".library-retry-button");
          assert.equal(await retry.count(), 1, "a failed initial library read must provide a reachable retry action");
          assert.equal(runtime.reads.length, 1, "a failed initial library read must wait for explicit recovery instead of retrying in the background");
          await retry.scrollIntoViewIfNeeded();
          assert.equal(await retry.evaluate(button => { const rect = button.getBoundingClientRect(); return rect.height >= 44 && rect.left >= 0 && rect.right <= innerWidth && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === button; }), true);
          runtime.plans = [{ error: "Synthetic repeated startup failure" }];
          await retry.focus(); await page.keyboard.press("Enter"); await errorVisible(page, "Synthetic repeated startup failure");
          assert.equal(await page.locator(".library-retry-button").evaluate(button => document.activeElement === button), true, "repeated startup failure must focus its replacement retry");
          runtime.plans = [{}]; await page.keyboard.press("Space");
          await page.waitForFunction(() => !document.querySelector(".library-retry-button") && /人物|收藏/.test(document.querySelector("#currentTitle")?.textContent || ""));
          await frames(page);
          assert.equal(await page.locator("#currentTitle").evaluate(title => document.activeElement === title), true, "successful startup recovery must focus the current heading");
          assert.deepEqual(await page.evaluate(() => [location.href, history.length]), before, "startup recovery must preserve the original route and history entry");
          assert.equal(await page.locator(route.includes("favorites") ? ".work-card" : ".person-index-card").count(), 3, "recovery must open the originally requested view");
        } finally { await page.close(); }
      });
    }
    for (const route of ["/fanhao", "/fanhao/codes", "/fanhao/favorites"]) {
      await run(`${route} startup recovery preserves a newer search draft and focus`, async () => {
        const pending = gate(), page = await open(route, [{ error: "Synthetic startup failure" }]);
        try {
          await errorVisible(page, "Synthetic startup failure"); runtime.plans = [pending];
          await page.locator(".library-retry-button").focus(); await page.keyboard.press("Enter"); await pending.requested;
          await page.locator("#workSearch").fill("新的未提交草稿");
          await page.locator("#workSearch").evaluate(input => input.setSelectionRange(1, 4));
          pending.release(); await page.waitForFunction(() => !document.querySelector(".library-retry-button")); await frames(page);
          assert.deepEqual(await page.locator("#workSearch").evaluate(input => [input.value, input.selectionStart, input.selectionEnd, document.activeElement === input]), ["新的未提交草稿", 1, 4, true], "startup retry completion must preserve the newer search draft, selection and focus");
        } finally { pending.release(); await page.close(); }
      });
    }
    for (const failed of [false, true]) await run(`startup recovery ${failed ? "late failure" : "late success"} yields to a new view and retires detached controls`, async () => {
      const pending = gate(), page = await open("/fanhao", [{ error: "Synthetic startup failure" }], true);
      try {
        await errorVisible(page, "Synthetic startup failure"); const old = await page.locator(".library-retry-button").elementHandle(); runtime.plans = [pending];
        await old.click(); await pending.requested;
        await navigate(page, "history"); await page.locator(".work-card").first().waitFor();
        await page.locator("#workSearch").fill("新页面草稿"); const before = await surface(page);
        if (failed) pending.error = "Synthetic obsolete startup retry failure";
        pending.release(); await page.waitForLoadState("networkidle"); await frames(page);
        assert.deepEqual(await surface(page), before, "a late startup retry must not repaint or refocus a newer view");
        const reads = runtime.reads.length; await old.evaluate(button => button.click()); await frames(page);
        assert.equal(runtime.reads.length, reads, "an unmounted startup retry cannot issue another old read");
      } finally { pending.release(); await page.close(); }
    });
    await run("failed startup keeps its browser history destination", async () => {
      const page = await open("/fanhao/favorites", [{ error: "Synthetic startup failure" }]);
      try {
        await errorVisible(page, "Synthetic startup failure"); runtime.plans = [{}];
        await navigate(page, "history"); await page.locator(".work-card").first().waitFor();
        assert.equal(new URL(page.url()).pathname, "/fanhao/history", "navigation after a failed startup must update the URL");
        await page.goBack(); await page.waitForFunction(() => document.querySelector("#currentTitle")?.textContent === "收藏");
        assert.equal(new URL(page.url()).pathname, "/fanhao/favorites", "back must return to the failed original destination");
      } finally { await page.close(); }
    });
    await run("western scope failure recovers the requested scope", async () => {
      const page = await open("/western", [{ error: "Synthetic western scope failure" }]);
      try {
        await errorVisible(page, "Synthetic western scope failure");
        assert.deepEqual(runtime.reads, ["?scope=western"]);
        runtime.plans = [{}]; await page.locator(".library-retry-button").click();
        await page.locator(".person-index-card").first().waitFor();
        assert.deepEqual(runtime.reads, ["?scope=western", "?scope=western"], "scope recovery must only retry the failed scope");
        assert.equal(await page.locator("#currentTitle").textContent(), "欧美人物");
        assert.equal(new URL(page.url()).pathname, "/western");
      } finally { await page.close(); }
    });
    await run("independent search stays usable when background library metadata fails", async () => {
      const page = await open("/fanhao?q=needle", [{ error: "Synthetic background library failure" }]);
      try {
        await page.locator(".work-card").first().waitFor(); await page.waitForLoadState("networkidle");
        assert.equal(await page.locator(".library-retry-button").count(), 0, "background metadata must not replace usable search results with startup recovery");
        assert.equal(await page.locator("#workSearch").inputValue(), "needle");
        assert.equal(await page.locator("#currentTitle").textContent(), "搜索：needle");
        assert.equal(await page.locator(".work-card").count(), 3);
      } finally { await page.close(); }
    });
    await run("startup retry refreshes a collection that also failed while offline", async () => {
      const page = await open("/fanhao/favorites", [{ error: "Synthetic offline metadata failure" }], false, "Synthetic offline collection failure");
      try {
        await errorVisible(page, "Synthetic offline metadata failure"); await page.waitForLoadState("networkidle");
        runtime.plans = [{}]; runtime.collectionError = "";
        await page.locator(".library-retry-button").focus(); await page.keyboard.press("Enter");
        await page.waitForFunction(() => document.querySelector(".work-card") || document.querySelector(".collection-retry-button"));
        assert.equal(await page.locator(".work-card").count(), 3, "explicit startup recovery must refresh an earlier offline collection failure instead of requiring another retry");
        assert.equal(await page.locator(".collection-retry-button").count(), 0);
      } finally { await page.close(); }
    });
    assert(checks > 0); assert.deepEqual(faults, []); console.log(`Startup recovery passed (${checks} actual-shell scenarios).`);
    return { checks };
  } finally { for (const pending of held) pending.release(); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  async function open(route, plans, ignoreAbort = false, collectionError = "", { assets = new Map(), waitUntil = "load" } = {}) {
    runtime = { plans: [...plans], reads: [], lastPlan: null, collectionError, assets, assetReads: [] };
    const page = await browser.newPage({ viewport: { width: 320, height: 900 } }); page.on("pageerror", error => faults.push(error.message));
    await page.addInitScript(ignoreAbort => { Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: true } }); if (ignoreAbort) { const read = fetch.bind(window); window.fetch = (url, options = {}) => { const next = { ...options }; if (String(url).startsWith("/api/library")) delete next.signal; return read(url, next); }; } }, ignoreAbort);
    await page.goto(`${base}${route}`, { waitUntil }); return page;
  }
  function gate() { let arrived, release; const pending = { requested: new Promise(resolve => { arrived = resolve; }), wait: new Promise(resolve => { release = resolve; }), arrived: () => arrived(), release: () => { held.delete(pending); release(); } }; held.add(pending); return pending; }
  async function errorVisible(page, message) { await page.waitForFunction(message => document.querySelector("#workGrid")?.textContent.includes(message), message); await frames(page); }
  async function firstVisiblePerson(page) {
    return (await page.waitForFunction(() => {
      const card = document.querySelector(".person-index-card");
      if (!card || getComputedStyle(card).visibility !== "visible") return null;
      const rect = card.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < innerHeight ? performance.now() : null;
    })).jsonValue();
  }
  async function frames(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
  async function navigate(page, view) { await page.locator("#fanhaoNavigationButton").click(); await page.locator(`[data-view="${view}"]`).click(); }
  async function surface(page) { return page.evaluate(() => ({ url: location.href, title: document.querySelector("#currentTitle").textContent, grid: document.querySelector("#workGrid").textContent, draft: document.querySelector("#workSearch").value, focus: document.activeElement?.id })); }
}
function send(res, body, type, status = 200) { if (!res.destroyed) { res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); } }
function json(res, body, status = 200) { send(res, JSON.stringify(body), "application/json", status); }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const caseOption = process.argv.find(value => value.startsWith("--case="));
  const negativeOnly = process.argv.includes("--negative-only");
  assert(!(caseOption && negativeOnly));
  if (!negativeOnly) await runStartupRecovery({ casePattern: caseOption?.slice(7) || "" });
  if (!caseOption) {
    for (const negative of [
      { name: "cold FanHao core download overlap", file: "index.html", url: "/fanhao", marker: 'preloadEntryModule("/app.js?v=20261106-card-cover-01");', replacement: "", pattern: "FanHao cold entry overlaps", failure: /both FanHao scripts must begin downloading during style delivery/ },
      { name: "scoped cold western read", file: "app.js", marker: 'if (next.view !== "people" && next.view !== "search") {', replacement: 'if (next.view !== "search") {', pattern: "western cold entry", failure: /western cold entry must read only its requested library scope/ },
      { name: "initial recovery action", file: "app.js", marker: "if (isCurrent()) renderLibraryReadError(next, error, navigationIntent);", replacement: "if (isCurrent()) renderEmpty(error.message);", pattern: "/fanhao startup failure retries", failure: /a failed initial library read must provide a reachable retry action/ },
      { name: "history after initial failure", file: "app.js", marker: "initializeRouteHistory({ preserveUrl: !applied });", replacement: "if (applied) initializeRouteHistory();", pattern: "failed startup keeps", failure: /navigation after a failed startup must update the URL/ },
      { name: "late failure navigation ownership", file: "app.js", marker: "if (isCurrent()) renderLibraryReadError(next, error, navigationIntent);", replacement: "renderLibraryReadError(next, error, navigationIntent);", pattern: "late failure yields", failure: /a late startup retry must not repaint or refocus a newer view/ },
      { name: "newer home draft", file: "app.js", marker: "if (!options.preserveSearchDraft) clearWorkSearch();", replacement: "clearWorkSearch();", occurrences: 2, pattern: "/fanhao startup recovery preserves", failure: /startup retry completion must preserve the newer search draft, selection and focus/ },
      { name: "newer prefix draft", file: "modules/fanhao/code-prefix-page.js", marker: "if (!options.preserveSearchDraft) clearWorkSearch();", replacement: "clearWorkSearch();", pattern: "/fanhao/codes startup recovery preserves", failure: /startup retry completion must preserve the newer search draft, selection and focus/ }
    ]) {
      const source = fs.readFileSync(path.join(publicRoot, negative.file), "utf8").replaceAll("\r\n", "\n");
      assert.equal(source.split(negative.marker).length - 1, negative.occurrences || 1, `negative must alter the expected owning behavior: ${negative.name}`);
      await assert.rejects(() => runStartupRecovery({ casePattern: negative.pattern, sourceOverrides: { [negative.url || `/${negative.file}`]: source.replaceAll(negative.marker, negative.replacement) } }), { name: "AssertionError", message: negative.failure });
      console.log(`PASS negative control detects missing ${negative.name}`);
    }
  }
}
