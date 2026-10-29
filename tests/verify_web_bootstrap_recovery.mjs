import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// The actual shared HTML and local modules, served on a private loopback port.
// Failures and API responses are synthetic; never contact a running library.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(projectRoot, "public");
export async function runWebBootstrapFixture({ casePattern = "", sourceOverrides = {}, screenshots = false } = {}) {
  const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"]
    .filter(Boolean).find(value => fs.existsSync(value));
  assert(executablePath, "Chrome or Edge is required for the private bootstrap fixture");
  const overrides = new Map(Object.entries(sourceOverrides)), requests = [], pages = new Set(), held = new Set(), unexpected = [];
  const shortEntryPath = new URL(fs.readFileSync(path.join(publicRoot, "index.html"), "utf8").match(/const shortVideoModuleUrl = "([^"]+)"/)[1], "http://fixture").pathname;
  let failurePath = "", browser, checks = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture"), pathname = url.pathname;
    requests.push({ method: req.method, url: pathname + url.search });
    try {
      const gate = [...held].find(value => !value.used && value.match(url, req));
      if (gate) { gate.used = true; gate.requestedResolve(); await gate.promise; }
      if (pathname === failurePath) { send(res, "Synthetic startup module unavailable", "text/plain", 503); return; }
      if (pathname === "/api/modules") { send(res, JSON.stringify({ product: { id: "suite" }, modules: [] }), "application/json"); return; }
      if (pathname.startsWith("/api/")) { unexpected.push(`${req.method} ${pathname}`); throw new Error(`unmodelled private API ${req.method} ${pathname}`); }
      const asset = /^\/(?:music|tools|photo|short-videos|fanhao)(?:\/|$)/.test(pathname) ? "/index.html" : pathname;
      const target = path.resolve(publicRoot, asset.replace(/^\/+/, ""));
      assert(target.startsWith(publicRoot + path.sep));
      const body = overrides.has(asset) ? overrides.get(asset) : await fs.promises.readFile(target);
      const mime = asset.endsWith(".html") ? "text/html; charset=utf-8" : asset.endsWith(".js") ? "text/javascript" : asset.endsWith(".css") ? "text/css" : asset.endsWith(".svg") ? "image/svg+xml" : "application/json";
      send(res, body, mime);
    } catch (error) { if (!res.destroyed) send(res, error.message, "text/plain", 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const run = async (name, task) => { if (casePattern && !name.includes(casePattern)) return; await task(); checks++; console.log(`PASS ${name}`); };
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    await run("bootstrap cold standalone failure exposes recovery", async () => {
      for (const [kind, target] of [["entry", "/standalone-app.js"], ["nested", "/modules/music/music-page.js"]]) {
        failurePath = target;
        const page = await newPage();
        try {
          await page.goto(`${base}/music?mode=library&q=Draft#synthetic`, { waitUntil: "load" });
          await page.waitForFunction(() => !document.documentElement.classList.contains("app-module-loading"), null, { timeout: 5000 });
          await tick(page);
          const actual = await snapshot(page);
          console.log("BOOTSTRAP_FAILURE", JSON.stringify({ kind, ...actual }));
          assert.equal(actual.moduleLoading, false);
          assert.equal(actual.bodyVisibility, "visible");
          assert.equal(actual.retryCount, 1, "a failed shared bootstrap must expose one visible native reload control instead of a blank library shell");
          assert.equal(actual.alertCount, 1, "a failed shared bootstrap must explain the startup failure accessibly");
          assert.deepEqual(page.startupErrors, [], "handled bootstrap import failures must not escape as unhandled page errors");
          assert(requests.every(request => request.method === "GET"), "bootstrap recovery must not scan, mutate, or submit library data");
        } finally { await page.close(); pages.delete(page); failurePath = ""; }
      }
    });
    await run("bootstrap other entry branches expose recovery", async () => {
      for (const [route, target] of [["/fanhao", "/fanhao-app.js"], ["/short-videos", shortEntryPath]]) {
        failurePath = target; const page = await newPage();
        try {
          await page.goto(base + route, { waitUntil: "load" }); await settled(page);
          const actual = await snapshot(page);
          assert.equal(actual.retryCount, 1, "each shared entry branch must expose its failed import recovery");
          assert.equal(actual.alertCount, 1); assert.equal(actual.bodyVisibility, "visible");
          assert.deepEqual(page.startupErrors, []);
        } finally { await page.close(); pages.delete(page); failurePath = ""; }
      }
    });
    await run("bootstrap native reload is single flight and preserves the complete URL", async () => {
      for (const key of ["Enter", "Space"]) {
        failurePath = "/standalone-app.js"; const page = await newPage();
        let route = "/tools?client=android&source=synthetic%20link#keep-position";
        let reload;
        try {
          await page.setViewportSize({ width: 320, height: 740 });
          await page.goto(base + route, { waitUntil: "load" }); await settled(page);
          if (key === "Space") {
            route = "/tools?client=android&source=new%20current#new-position";
            await page.evaluate(route => history.replaceState(null, "", route), route);
          }
          const button = page.locator("#appStartupReload");
          assert.equal(await button.count(), 1, "startup recovery must expose one native reload control");
          await button.focus();
          const hit = await button.evaluate(button => { const r = button.getBoundingClientRect(); return { left: r.left, right: r.right, height: r.height,
            hit: button.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) }; });
          assert(hit.left >= -1 && hit.right <= 321 && hit.height >= 44 && hit.hit, "320px startup reload must be fully visible with a native 44px hit target");
          const before = documentReads(route); failurePath = "";
          reload = hold(url => url.pathname === "/tools");
          const navigated = page.waitForNavigation({ waitUntil: "load" });
          navigated.catch(() => {});
          await page.keyboard.press(key); await requested(reload);
          assert.equal(requests.filter(request => request.url.startsWith('/tools')).at(-1).url, route.split('#')[0], 'startup reload must request the current query rather than the originally captured startup URL');
          await page.keyboard.press("Enter"); await page.keyboard.press("Space");
          assert.equal(documentReads(route), before + 1, "repeated native activation must start only one document reload");
          reload.release(); await navigated; await settled(page);
          await page.locator(".game-library").waitFor();
          assert.equal(documentReads(route), before + 1, "a busy recovery control must not schedule another reload after document arrival");
          assert.equal(await page.evaluate(() => window.__startupInitialHref), base + route, "reloading startup must preserve the current exact path, query, and fragment before ordinary host canonicalization");
          assert.equal(await page.locator("#appStartupNotice").count(), 0);
          assert.deepEqual(page.startupErrors, []);
        } finally { reload?.release(); await page.close(); pages.delete(page); failurePath = ""; }
      }
    });
    await run("bootstrap late failure and retired recovery yield to a newer route", async () => {
      for (const state of ["waiting-route", "accepted-pending", "retired"]) {
        const pending = state !== "retired", accepted = state !== "waiting-route";
        failurePath = "/standalone-app.js";
        const gate = pending ? hold(url => url.pathname === failurePath) : null;
        const page = await newPage();
        try {
          await page.goto(`${base}/music?mode=library`, { waitUntil: pending ? "commit" : "load" });
          if (pending) { await requested(gate); await page.waitForFunction(() => document.readyState !== "loading"); }
          else { await settled(page); await page.locator("#appStartupReload").evaluate(button => { window.retiredStartupReload = button; }); }
          const beforeDocuments = requests.filter(request => /^\/(?:music|tools)\?/.test(request.url)).length;
          // Lifecycle double: an independently accepted same-document route/UI
          // replaces a bootstrap which has not obtained the current host yet.
          await page.evaluate(accepted => {
            history.replaceState(null, "", "/tools?accepted=new#current");
            if (!accepted) return;
            document.documentElement.classList.remove("app-module-loading", "app-styles-loading");
            document.body.innerHTML = '<main id="new-bootstrap-owner"><h1>Accepted current view</h1><input aria-label="Current edit" value="new raw draft"></main>';
            document.querySelector("input").focus(); document.querySelector("input").setSelectionRange(1, 4);
          }, accepted);
          const expected = await page.evaluate(() => ({ html: document.body.innerHTML, active: document.activeElement.outerHTML, selection: [document.activeElement.selectionStart, document.activeElement.selectionEnd] }));
          if (pending) { gate.release(); await settled(page); }
          else { await page.evaluate(() => retiredStartupReload.click()); await tick(page); }
          if (accepted) assert.deepEqual(await page.evaluate(() => ({ html: document.body.innerHTML, active: document.activeElement.outerHTML, selection: [document.activeElement.selectionStart, document.activeElement.selectionEnd] })), expected,
            "a late bootstrap failure or retired reload control must not replace or refocus a newer accepted view");
          else {
            assert.equal(await page.locator('#appStartupNotice[role="alert"]').count(), 1, "a URL changed during pending startup still needs an actionable document-scoped failure");
            assert.equal(await page.locator("#appStartupReload").count(), 1);
            assert.equal(await page.evaluate(() => document.activeElement === document.body), true, "startup failure recovery must not automatically steal focus");
          }
          assert.equal(page.url(), `${base}/tools?accepted=new#current`);
          assert.equal(requests.filter(request => /^\/(?:music|tools)\?/.test(request.url)).length, beforeDocuments, "a retired bootstrap reload must not reload a newer route");
          assert.deepEqual(page.startupErrors, []);
        } finally { gate?.release(); await page.close(); pages.delete(page); failurePath = ""; }
      }
    });
    await run("bootstrap normal tools startup remains usable with failed optional styles", async () => {
      for (const styleFailure of [false, true]) {
        failurePath = styleFailure ? "/css/foundation.css" : "";
        const page = await newPage();
        try {
          await page.goto(`${base}/tools`, { waitUntil: "load" }); await settled(page); await page.locator(".game-library").waitFor();
          assert.equal(await page.locator(".game-library-card").count(), 4);
          assert.equal(await page.locator('#appStartupNotice[role="alert"]').count(), 0, "an optional stylesheet failure must not become a fatal module failure");
          assert.equal(await page.locator("#appStartupNotice").count(), Number(styleFailure), "only an actual stylesheet failure should show a nonfatal startup notice");
          if (styleFailure) assert.equal(await page.locator("#appStartupNotice").getAttribute("role"), "status");
          assert.deepEqual(page.startupErrors, []);
        } finally { await page.close(); pages.delete(page); failurePath = ""; }
      }
    });
    await run("bootstrap short video import runs before held styles and handles early rejection", async () => {
      for (const error of [false, true]) {
        const styles = hold(url => url.pathname === "/css/foundation.css");
        overrides.set(shortEntryPath, "window.__bootstrapEntryExecuted = (window.__bootstrapEntryExecuted || 0) + 1;" + (error
          ? "throw new Error('Synthetic early bootstrap rejection');" : "document.documentElement.dataset.appModule = 'synthetic-short-video';"));
        const page = await newPage();
        try {
          if (error) await page.setViewportSize({ width: 320, height: 740 });
          const response = page.waitForResponse(response => new URL(response.url()).pathname === shortEntryPath);
          response.catch(() => {});
          await page.goto(`${base}/short-videos`, { waitUntil: "commit" }); await requested(styles); await response;
          await page.waitForFunction(() => document.readyState !== "loading", null, { polling: 10, timeout: 5000 });
          await page.waitForFunction(() => window.__bootstrapEntryExecuted === 1, null, { polling: 10, timeout: 5000 });
          await page.evaluate(async () => { for (let turn = 0; turn < 2; turn++) await new Promise(resolve => setTimeout(resolve, 0)); });
          const heldState = await page.evaluate(() => { const notice = document.querySelector('#appStartupNotice'); return {
            notice: Boolean(notice), noticeVisible: Boolean(notice?.getClientRects().length && getComputedStyle(notice).visibility === 'visible'),
            bodyVisibility: getComputedStyle(document.body).visibility, classes: document.documentElement.className,
            executed: window.__bootstrapEntryExecuted || 0, module: document.documentElement.dataset.appModule || '', readyState: document.readyState
          }; });
          console.log('BOOTSTRAP_HELD_STYLES', JSON.stringify({ error, ...heldState, pageerrors: page.startupErrors }));
          assert.equal(await page.evaluate(() => document.documentElement.classList.contains("app-styles-loading")), true);
          assert.equal(heldState.executed, 1, "short video import evaluation must remain parallel with stylesheet loading, not just its preload request");
          assert.deepEqual(page.startupErrors, [], "a short video import rejection must be observed immediately while styles are still pending");
          if (error) {
            assert(heldState.notice && heldState.noticeVisible, 'an already rejected short video bootstrap must expose visible recovery while its stylesheet is still pending');
            assert.equal(heldState.bodyVisibility, 'hidden', 'early fatal recovery must not prematurely reveal the uninitialized application body');
            const button = await page.locator('#appStartupReload').evaluate(button => { const r = button.getBoundingClientRect(); return { width: r.width, height: r.height, left: r.left, right: r.right,
              hit: button.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)), disabled: button.disabled }; });
            assert(button.height >= 44 && button.width >= 44 && button.left >= -1 && button.right <= 321 && button.hit && !button.disabled,
              'the inline fatal recovery button must remain visible and clickable at 320px even while external CSS is pending');
            if (screenshots) {
              const target = path.join(projectRoot, '.codex-artifacts/bootstrap/startup-recovery-320.png');
              fs.mkdirSync(path.dirname(target), { recursive: true });
              // Capture the actual compositor without waiting for an external
              // stylesheet/font readiness promise which is deliberately held.
              const session = await page.context().newCDPSession(page);
              const result = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
              fs.writeFileSync(target, Buffer.from(result.data, 'base64')); await session.detach();
              console.log('SCREENSHOT', target);
            }
          }
          styles.release(); await settled(page);
          assert.equal(await page.locator('#appStartupNotice[role="alert"]').count(), Number(error));
          assert.deepEqual(page.startupErrors, []);
        } finally { styles.release(); overrides.delete(shortEntryPath); failurePath = ""; await page.close(); pages.delete(page); }
      }
    });
    assert(checks > 0, `no bootstrap cases matched ${casePattern}`);
    assert.deepEqual(unexpected, [], "the private bootstrap fixture must model every API it uses");
    assert(requests.every(request => request.method === "GET"));
    console.log(`Web bootstrap recovery passed (${checks} private Chromium behavior families)`);
    return { checks };
  } finally {
    for (const gate of held) gate.release();
    for (const page of pages) await page.close().catch(() => {});
    if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  async function newPage() {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); pages.add(page);
    page.startupErrors = []; page.resourceFailures = [];
    await page.addInitScript(() => { window.__startupInitialHref = location.href; });
    page.on("pageerror", error => page.startupErrors.push(error.message));
    page.on("requestfailed", request => page.resourceFailures.push({ url: new URL(request.url()).pathname, error: request.failure()?.errorText }));
    await page.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    return page;
  }
  function hold(match) {
    let release, requestedResolve; const gate = { match, used: false, promise: new Promise(resolve => { release = resolve; }), requested: new Promise(resolve => { requestedResolve = resolve; }), release, requestedResolve };
    held.add(gate); return gate;
  }
  async function requested(gate) { let timer; try { await Promise.race([gate.requested, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("held bootstrap request did not start")), 5000); })]); } finally { clearTimeout(timer); } }
  function documentReads(route) { return requests.filter(request => request.url === route.split("#")[0]).length; }
  async function settled(page) { await page.waitForFunction(() => !document.documentElement.classList.contains("app-module-loading") && !document.documentElement.classList.contains("app-styles-loading"), null, { timeout: 5000 }); await tick(page); }
  async function snapshot(page) {
    const value = await page.evaluate(() => ({
      moduleLoading: document.documentElement.classList.contains("app-module-loading"), classes: document.documentElement.className,
      bodyVisibility: getComputedStyle(document.body).visibility, title: document.title,
      retryCount: [...document.querySelectorAll("button")].filter(button => /重新加载|重试加载|重新载入/.test(button.textContent) && button.getClientRects().length).length,
      alertCount: [...document.querySelectorAll('[role="alert"]')].filter(node => node.getClientRects().length).length,
      body: document.body.innerText.slice(0, 1600), main: document.querySelector("#workGrid")?.innerHTML.slice(0, 800)
    }));
    return { ...value, pageerrors: page.startupErrors, requestfailed: page.resourceFailures };
  }
}
function send(res, body, type, status = 200) { res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); }
async function tick(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pattern = process.argv.find(value => value.startsWith("--case="))?.slice(7) || "", negativeOnly = process.argv.includes('--negative-only');
  assert(!(negativeOnly && pattern), '--case and --negative-only cannot be combined');
  if (!negativeOnly) {
    const current = await runWebBootstrapFixture({ casePattern: pattern, screenshots: process.argv.includes('--screenshots') });
    if (!pattern) assert.equal(current.checks, 6, 'the default bootstrap gate must execute all six behavior families');
  }
  if (!pattern) {
    const source = fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8').replaceAll('\r\n', '\n');
    for (const negative of [
      { name: 'fatal module recovery UI', marker: 'moduleFailed = true;', replacement: 'return;', casePattern: 'bootstrap cold standalone',
        failure: /a failed shared bootstrap must expose one visible native reload control/ },
      { name: 'complete document reload URL', marker: 'window.location.reload();', replacement: 'window.location.assign(window.location.pathname);', casePattern: 'bootstrap native reload',
        failure: /startup reload must request the current query rather than the originally captured startup URL/ },
      { name: 'new ready view ownership', marker: 'const ownsStartup = () => window.location.href === startupHref\n          || document.documentElement.classList.contains("app-module-loading");',
        replacement: 'const ownsStartup = () => true;', casePattern: 'bootstrap late failure',
        failure: /a late bootstrap failure or retired reload control must not replace or refocus a newer accepted view/ },
      { name: 'immediate short-video fatal recovery', marker: 'shortVideoModulePromise.catch(() => window.__fanhaoReportStartupFailure?.());', replacement: 'shortVideoModulePromise.catch(() => {});',
        casePattern: 'bootstrap short video import', failure: /an already rejected short video bootstrap must expose visible recovery while its stylesheet is still pending/ }
    ]) {
      assert.equal(source.split(negative.marker).length, 2, `negative must alter exactly one ${negative.name} marker`);
      await assert.rejects(() => runWebBootstrapFixture({ casePattern: negative.casePattern, sourceOverrides: { '/index.html': source.replace(negative.marker, negative.replacement) } }),
        { name: 'AssertionError', message: negative.failure });
      console.log(`PASS negative control detects missing ${negative.name}`);
    }
  }
  console.log(`Web bootstrap gate passed (${pattern ? 'selected family' : negativeOnly ? '4 independent negative controls' : '6 behavior families + 4 independent negative controls'})`);
}
