import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Actual shell/collection controllers, private HTTP and synthetic works only.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), publicRoot = path.join(root, "public");
const views = [
  { id: "favorites", path: "/api/favorites", route: "/fanhao/favorites", label: "收藏" },
  { id: "history", path: "/api/history", route: "/fanhao/history", label: "观看记录" },
  { id: "vr", path: "/api/works", route: "/fanhao/vr", label: "VR 作品" }
];
export async function runCollectionRecovery({ casePattern = "", sourceOverrides = {} } = {}) {
  const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean).find(file => fs.existsSync(file));
  assert(executablePath, "private Chromium required");
  let runtime, checks = 0;
  const faults = [], held = new Set();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture"), current = runtime;
    try {
      if (url.pathname === "/api/library") { await current.libraryWait; json(res, { people: [{ id: "recovery-person", name: "Synthetic recovery person", workCount: 3 }], works: [], totals: {}, user: {}, access: { mode: "local" } }); return; }
      const view = views.find(view => view.path === url.pathname);
      if (view) {
        current.reads.push({ view: view.id, query: Object.fromEntries(url.searchParams) });
        const plan = current.plans[view.id]?.shift() || current.lastPlan[view.id];
        if (plan) current.lastPlan[view.id] = plan;
        plan?.arrived?.(); if (plan?.wait) await plan.wait;
        if (plan?.error) { json(res, { error: plan.error }, 503); return; }
        json(res, { works: [0, 1, 2].map(index => ({ id: `${view.id}-${index}`, title: `${view.id} Synthetic ${index}`, videoCount: 1, playableCount: 1, vr: true, favorite: view.id === "favorites" })), total: 3, count: 3,
          folders: [{ id: "default", name: "默认", count: 3 }], selectedFolderId: url.searchParams.get("folder") || "all" }); return;
      }
      if (url.pathname.startsWith("/api/")) { json(res, {}); return; }
      if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      if (sourceOverrides[url.pathname] !== undefined) { send(res, sourceOverrides[url.pathname], "text/javascript"); return; }
      const filename = path.resolve(publicRoot, `.${decodeURIComponent(url.pathname)}`);
      assert(filename.startsWith(`${publicRoot}${path.sep}`), "static paths stay in public");
      const target = fs.statSync(filename, { throwIfNoEntry: false })?.isFile() ? filename : path.join(publicRoot, "index.html");
      send(res, await fs.promises.readFile(target), target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : "text/html; charset=utf-8");
    } catch (error) { faults.push(error.message); json(res, { error: error.message }, 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  const run = async (name, task) => { if (casePattern && !name.includes(casePattern)) return; await task(); checks++; console.log(`PASS ${name}`); };
  try {
    for (const view of views) {
      for (const failed of [false, true]) {
        await run(`${view.id} startup consumes the settled ${failed ? "failed" : "successful"} first read once`, async () => {
          const library = gate(), message = "Synthetic startup read failure";
          const page = await open(view, [failed ? { error: message } : {}], false, library.wait);
          try {
            await page.waitForFunction(() => window.fixtureCollectionReplies.length === 1);
            assert.equal(runtime.reads.filter(read => read.view === view.id).length, 1, "boot prefetch must make one first-page request while library metadata is pending");
            library.release();
            if (failed) await errorVisible(page, message);
            else await page.locator("#workGrid .work-card").first().waitFor();
            await page.waitForLoadState("networkidle");
            assert.equal(runtime.reads.filter(read => read.view === view.id).length, 1, "activation must consume the settled boot result without a duplicate collection read");
            if (failed) {
              runtime.plans[view.id] = [{}];
              await page.locator(".collection-retry-button").click();
              await page.locator("#workGrid .work-card").first().waitFor();
              assert.equal(runtime.reads.filter(read => read.view === view.id).length, 2, "explicit retry starts exactly one fresh collection read");
            }
          } finally { library.release(); await page.close(); }
        });
      }
      await run(`${view.id} recovery keeps conditions through repeated failure and keyboard success`, async () => {
        const firstError = `${view.label} Synthetic ${"long-error-without-spaces-".repeat(15)}`;
        const page = await open(view, [{ error: firstError }]);
        try {
          await errorVisible(page, firstError);
          assert.equal(await page.locator(".collection-retry-button").count(), 1, "a failed collection read must provide a reachable retry action");
          const button = page.locator(".collection-retry-button"), before = await page.evaluate(() => [location.href, history.length]);
          const initialReads = runtime.reads.filter(read => read.view === view.id).length;
          await button.scrollIntoViewIfNeeded();
          assert.equal(await button.evaluate(button => { const box = button.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2); return box.height >= 44 && box.left >= 0 && box.right <= innerWidth && (hit === button || button.contains(hit)); }), true, "the retry must fit and remain clickable at 320px");
          runtime.plans[view.id] = [{ error: "Synthetic repeated failure" }];
          await button.focus(); await page.keyboard.press("Enter"); await errorVisible(page, "Synthetic repeated failure");
          assert.equal(await page.locator(".collection-retry-button").evaluate(button => document.activeElement === button), true, "repeated failure must return keyboard focus to the replacement retry");
          runtime.plans[view.id] = [{}];
          await page.keyboard.press("Space"); await page.locator("#workGrid .work-card").first().waitFor();
          assert.equal(await page.locator("#workGrid .work-card").count(), 3);
          assert.equal(await page.locator("#currentTitle").evaluate(title => document.activeElement === title), true, "a successful retry must focus the current collection heading");
          assert.deepEqual(await page.evaluate(() => [location.href, history.length]), before, "retry must not add a route history entry");
          const reads = runtime.reads.filter(read => read.view === view.id);
          assert.equal(reads.length, initialReads + 2); assert(reads.every(read => JSON.stringify(read.query) === JSON.stringify(reads[0].query)), "all retries must preserve the selected query and offset");
        } finally { await page.close(); }
      });
      await run(`${view.id} recovery respects newer search focus and selection`, async () => {
        const pending = gate(), page = await open(view, [{ error: "Synthetic initial failure" }]);
        try {
          await errorVisible(page, "Synthetic initial failure"); runtime.plans[view.id] = [pending]; await page.locator(".collection-retry-button").focus(); await page.keyboard.press("Enter"); await pending.requested;
          const input = page.locator("#workSearch"); await input.fill("新的未提交草稿"); await input.evaluate(input => input.setSelectionRange(1, 4));
          await release(page, pending, view); await page.locator("#workGrid .work-card").first().waitFor();
          assert.deepEqual(await input.evaluate(input => [input.value, input.selectionStart, input.selectionEnd, document.activeElement === input]), ["新的未提交草稿", 1, 4, true], "retry completion must preserve the newer search focus and draft selection");
        } finally { pending.release(); await page.close(); }
      });
      await run(`${view.id} recovery preserves a nondefault folder range or sort`, async () => {
        const page = await open(view, [{}]);
        try {
          await page.locator("#workGrid .work-card").first().waitFor();
          runtime.plans[view.id] = [{ error: "Synthetic selected condition failure" }];
          if (view.id === "favorites") await page.locator('[data-favorite-folder="default"]').click();
          else if (view.id === "history") await page.locator(".history-range-controls").getByRole("button", { name: "7 天", exact: true }).click();
          else await page.locator("#sortSelect").selectOption("title");
          await errorVisible(page, "Synthetic selected condition failure");
          const selected = runtime.reads.filter(read => read.view === view.id).at(-1).query;
          assert.equal(view.id === "favorites" ? selected.folder : view.id === "history" ? selected.days : selected.sort, view.id === "favorites" ? "default" : view.id === "history" ? "7" : "title");
          runtime.plans[view.id] = [{}];
          await page.locator(".collection-retry-button").click(); await page.locator("#workGrid .work-card").first().waitFor(); await frames(page);
          assert.deepEqual(runtime.reads.filter(read => read.view === view.id).at(-1).query, selected, "recovery must preserve a nondefault selected condition");
        } finally { await page.close(); }
      });
      await run(`${view.id} recovery late response and detached retry yield to a new view`, async () => {
        const pending = gate(), page = await open(view, [{ error: "Synthetic obsolete failure" }], true);
        try {
          await errorVisible(page, "Synthetic obsolete failure"); const old = await page.locator(".collection-retry-button").elementHandle();
          runtime.plans[view.id] = [pending]; await old.click(); await pending.requested;
          const next = views[(views.indexOf(view) + 1) % views.length];
          await page.locator("#fanhaoNavigationButton").click(); await page.locator(`[data-view="${next.id}"]`).click();
          await page.locator(`[data-work-id="${next.id}-0"]`).waitFor();
          await page.locator("#workSearch").fill("新页面草稿"); const before = await surface(page);
          await release(page, pending, view);
          assert.deepEqual(await surface(page), before, "an obsolete recovery must not repaint, refocus or navigate the newer view");
          await page.waitForLoadState("networkidle");
          const reads = runtime.reads.filter(read => read.view === view.id).length;
          await old.evaluate(button => button.click()); await frames(page);
          assert.equal(runtime.reads.filter(read => read.view === view.id).length, reads, "a detached retry cannot start another read of its old collection");
        } finally { pending.release(); await page.close(); }
      });
    }
    assert(checks > 0); assert.deepEqual(faults, [], "collection recovery must not hide runtime faults");
    console.log(`Collection recovery passed (${checks} actual-shell cases; synthetic APIs).`); return { checks };
  } finally {
    for (const pending of held) pending.release();
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  async function open(view, plans, ignoreAbort = false, libraryWait) {
    runtime = { reads: [], plans: { [view.id]: [...plans] }, lastPlan: {}, libraryWait };
    const page = await browser.newPage({ viewport: { width: 320, height: 900 } }); page.on("pageerror", error => faults.push(error.message));
    await page.addInitScript(ignoreAbort => {
      Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: true } });
      window.fixtureCollectionReplies = [];
      const read = fetch.bind(window);
      window.fetch = async (url, options = {}) => {
        const next = { ...options }, collection = ["/api/favorites", "/api/history", "/api/works"].some(path => String(url).startsWith(path));
        if (ignoreAbort && collection) delete next.signal;
        const response = await read(url, next);
        if (collection) { await response.clone().text(); window.fixtureCollectionReplies.push({ path: String(url), status: response.status }); }
        return response;
      };
    }, ignoreAbort);
    await page.goto(`${base}${view.route}`); return page;
  }
  function gate() { let arrived, release; const pending = { requested: new Promise(resolve => { arrived = resolve; }), wait: new Promise(resolve => { release = resolve; }), arrived: () => arrived(), release: () => { held.delete(pending); release(); } }; held.add(pending); return pending; }
  async function errorVisible(page, message) {
    try { await page.waitForFunction(message => document.querySelector("#workGrid")?.textContent.includes(message), message); await frames(page); }
    catch (error) { console.log("RECOVERY STARTUP", JSON.stringify({ reads: runtime.reads, faults, page: await page.evaluate(() => ({ url: location.href, loading: document.documentElement.className, body: document.body.innerText.slice(0, 1600) })) })); throw error; }
  }
  async function frames(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
  async function release(page, pending, view) { const response = page.waitForResponse(response => new URL(response.url()).pathname === view.path); pending.release(); await (await response).finished(); await frames(page); }
  async function surface(page) { return page.evaluate(() => ({ url: location.href, grid: document.querySelector("#workGrid").textContent, title: document.querySelector("#currentTitle").textContent, value: document.querySelector("#workSearch").value, focused: document.activeElement?.id })); }
}
function send(res, body, type, status = 200) { if (!res.destroyed) { res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); } }
function json(res, body, status = 200) { send(res, JSON.stringify(body), "application/json", status); }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const caseOption = process.argv.find(value => value.startsWith("--case="));
  const negativeOnly = process.argv.includes("--negative-only");
  assert(!(caseOption && negativeOnly), "case and negative-only are separate entry points");
  if (!negativeOnly) await runCollectionRecovery({ casePattern: caseOption?.slice(7) || "" });
  if (!caseOption) {
    for (const negative of [
      { name: "boot read failure reuse", path: "/app.js", file: "app.js", marker: "collectionPage.prefetch(initialRoute.view, { retainFailureForActivation: true });", replacement: "collectionPage.prefetch(initialRoute.view);", pattern: "favorites startup consumes the settled failed", failure: /activation must consume the settled boot result without a duplicate collection read/ },
      { name: "collection recovery action", path: "/app.js", file: "app.js", marker: "renderReadError: renderCollectionReadError,", replacement: "", pattern: "favorites recovery keeps", failure: /a failed collection read must provide a reachable retry action/ },
      { name: "same-retry focus ownership", path: "/modules/fanhao/features/collections/collection-page.js", file: "modules/fanhao/features/collections/collection-page.js", marker: "owner.revision = readRevision;", replacement: "", pattern: "favorites recovery keeps", failure: /repeated failure must return keyboard focus to the replacement retry/ },
      { name: "new focus intent", path: "/modules/fanhao/search-recovery.js", file: "modules/fanhao/search-recovery.js", marker: "if (!hadFocus || newerFocusIntent || !isCurrent()) return;", replacement: "if (!hadFocus || !isCurrent()) return;", pattern: "favorites recovery respects", failure: /retry completion must preserve the newer search focus and draft selection/ }
    ]) {
      const source = fs.readFileSync(path.join(publicRoot, negative.file), "utf8").replaceAll("\r\n", "\n");
      assert.equal(source.split(negative.marker).length - 1, 1, `negative must modify only ${negative.name}`);
      await assert.rejects(() => runCollectionRecovery({ casePattern: negative.pattern, sourceOverrides: { [negative.path]: source.replace(negative.marker, negative.replacement) } }), { name: "AssertionError", message: negative.failure });
      console.log(`PASS negative control detects missing ${negative.name}`);
    }
  }
}
