import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Actual shell/statistics/pagination; private HTTP and synthetic works only.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), publicRoot = path.join(root, "public");
const views = [
  ["favorites", "/fanhao/favorites", "/api/favorites"], ["history", "/fanhao/history", "/api/history"],
  ["vr", "/fanhao/vr", "/api/works"], ["search", "/fanhao?q=needle", "/api/search"],
  ["person", "/fanhao?personId=sort-person", "/api/people/sort-person"]
];
export async function runSortControls({ casePattern = "", sourceOverrides = {} } = {}) {
  const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean).find(file => fs.existsSync(file));
  assert(executablePath, "private Chromium required");
  const faults = [], held = new Set(), person = { id: "sort-person", name: "Synthetic sort person", workCount: 96 };
  let runtime, checks = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture"), current = runtime;
    try {
      assert.equal(req.method, "GET", "sorting must not issue writes");
      if (url.pathname === "/api/library") { json(res, { people: [person], works: [], totals: {}, user: {}, access: { mode: "local" } }); return; }
      if (views.some(view => view[2] === url.pathname)) {
        const offset = Number(url.searchParams.get("offset") || 0), limit = Number(url.searchParams.get("limit") || 48);
        current.reads.push({ path: url.pathname, offset, sort: url.searchParams.get("sort") });
        const pending = current.pending;
        if (pending && !pending.used && pending.offset === offset) { pending.used = true; pending.arrived(); await pending.wait; }
        json(res, { person, works: Array.from({ length: Math.min(limit, 96 - offset) }, (_, index) => ({ id: `work-${offset + index}`, title: `Synthetic work ${offset + index}`, favorite: true, videoCount: 1, playableCount: 1 })), people: [], total: 96, offset, limit, folders: [] }); return;
      }
      if (url.pathname.startsWith("/api/")) { json(res, {}); return; }
      if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      if (sourceOverrides[url.pathname] !== undefined) { send(res, sourceOverrides[url.pathname], "text/javascript"); return; }
      const filename = path.resolve(publicRoot, `.${decodeURIComponent(url.pathname)}`);
      assert(filename.startsWith(`${publicRoot}${path.sep}`));
      const target = fs.statSync(filename, { throwIfNoEntry: false })?.isFile() ? filename : path.join(publicRoot, "index.html");
      send(res, await fs.promises.readFile(target), target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : "text/html; charset=utf-8");
    } catch (error) { faults.push(error.message); json(res, { error: error.message }, 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ executablePath, headless: true });
  const run = async (name, task) => { if (casePattern && !name.includes(casePattern)) return; await task(); checks++; console.log(`PASS ${name}`); };
  try {
    for (const [name, route, apiPath] of views) {
      await run(`${name} sort control stays native and connected through keyboard reload`, async () => {
        const page = await open(route);
        try {
          const pending = gate(0); runtime.pending = pending;
          await probe(page); await page.locator("#sortSelect").focus(); await page.keyboard.press("ArrowDown"); await pending.requested;
          assert.equal(await page.evaluate(() => __sort.isConnected), true, "a pending same-list read must keep the native sort control connected");
          pending.release(); await page.waitForLoadState("networkidle"); await frames(page);
          await assertRetained(page);
          const reads = runtime.reads.length;
          const nextResponse = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === apiPath && url.searchParams.get("sort") === "title"; });
          await page.keyboard.press("ArrowDown"); await (await nextResponse).finished(); await frames(page);
          assert.equal(runtime.reads.length, reads + 1, "the next native arrow must change sorting without requiring a second focus");
          assert.equal(runtime.reads.at(-1).path, apiPath); assert.equal(runtime.reads.at(-1).sort, "title");
        } finally { runtime.pending?.release(); await page.close(); }
      });
      await run(`${name} sort control survives a background append`, async () => {
        const page = await open(route);
        try {
          const pending = gate(48); runtime.pending = pending;
          for (let attempt = 0; attempt < 60 && !pending.used; attempt++) {
            await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await page.waitForTimeout(20);
          }
          assert(pending.used, "actual progressive scrolling must request the next server page");
          await pending.requested;
          await probe(page); await page.locator("#sortSelect").focus();
          pending.release(); await page.locator('[data-work-id="work-95"]').waitFor(); await frames(page);
          await assertRetained(page);
          assert.equal(await page.locator(".work-card").count(), 96);
          assert.equal(await page.locator("#sortSelect").count(), 1);
          if (["favorites", "history", "vr"].includes(name)) assert.equal(await page.locator("#statsRow .stat strong").first().textContent(), "96", "statistics must still reflect the appended works");
          if (name === "favorites") assert.equal(await page.locator(".favorite-folder-controls").count(), 1);
          if (name === "history") assert.equal(await page.locator(".history-range-controls").count(), 1);
        } finally { runtime.pending?.release(); await page.close(); }
      });
    }
    await run("detached sort control cannot overwrite a new people index", async () => {
      const page = await open("/fanhao/favorites");
      try {
        const old = await page.locator("#sortSelect").elementHandle();
        await page.locator("#fanhaoNavigationButton").click(); await page.locator('[data-view="people"][data-people-scope="main"]').click();
        await page.locator(".person-index-card").waitFor();
        const before = await page.locator("#workGrid").textContent();
        await old.evaluate(select => { select.value = "title"; select.dispatchEvent(new Event("change", { bubbles: true })); }); await frames(page);
        assert.equal(await page.locator("#workGrid").textContent(), before, "a detached sort control must not replace a newly selected people index");
      } finally { await page.close(); }
    });
    assert(checks > 0); assert.deepEqual(faults, []); console.log(`Sort controls passed (${checks} actual-shell scenarios).`); return { checks };
  } finally { for (const pending of held) pending.release(); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  async function open(route) {
    runtime = { reads: [], pending: null };
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } }); page.on("pageerror", error => faults.push(error.message));
    await page.addInitScript(() => { Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: true } }); });
    await page.goto(`${base}${route}`); await page.locator("#sortSelect").waitFor(); await page.locator(".work-card").first().waitFor(); return page;
  }
  function gate(offset) { let arrived, release; const pending = { offset, requested: new Promise(resolve => { arrived = resolve; }), wait: new Promise(resolve => { release = resolve; }), arrived: () => arrived(), release: () => { held.delete(pending); release(); } }; held.add(pending); return pending; }
  async function frames(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
  async function probe(page) { await page.evaluate(() => { window.__sort = document.querySelector("#sortSelect"); window.__sortAncestors = [__sort.parentElement, __sort.parentElement.parentElement]; window.__sortOptions = [...__sort.options]; window.__sortBlurs = 0; __sort.addEventListener("blur", () => __sortBlurs++); }); }
  async function assertRetained(page) {
    assert.equal(await page.evaluate(() => __sort.isConnected && __sortAncestors.every(node => node.isConnected) && document.querySelector("#sortSelect") === __sort && [...__sort.options].every((option, index) => option === __sortOptions[index])), true, "same-list statistics updates must preserve the original sort control, ancestors and native options");
    assert.deepEqual(await page.evaluate(() => [document.activeElement === __sort, __sortBlurs]), [true, 0], "same-list statistics updates must preserve native sort focus without transient detach or blur");
  }
}
function send(res, body, type, status = 200) { if (!res.destroyed) { res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); } }
function json(res, body, status = 200) { send(res, JSON.stringify(body), "application/json", status); }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = process.argv.find(value => value.startsWith("--case=")), negativeOnly = process.argv.includes("--negative-only");
  assert(!(option && negativeOnly));
  if (!negativeOnly) await runSortControls({ casePattern: option?.slice(7) || "" });
  if (!option) {
    const source = fs.readFileSync(path.join(publicRoot, "app.js"), "utf8").replaceAll("\r\n", "\n");
    for (const negative of [
      { name: "connected statistics ancestor", marker: "for (const child of [...els.statsRow.children]) if (child !== controls) child.remove();", replacement: "for (const child of [...els.statsRow.children]) child.remove();", pattern: "favorites sort control stays", failure: /same-list statistics updates must preserve the original sort control, ancestors and native options/ },
      { name: "no transient wrapper move", marker: "if (wrap.parentElement !== els.statsRow) els.statsRow.append(wrap);", replacement: "els.statsRow.append(wrap);", pattern: "favorites sort control stays", failure: /same-list statistics updates must preserve native sort focus without transient detach or blur/ },
      { name: "pending search sort owner", marker: 'if (enteringSearch || state.searchQuery !== normalizedQuery) els.statsRow.innerHTML = "";', replacement: 'els.statsRow.innerHTML = "";', pattern: "search sort control stays", failure: /a pending same-list read must keep the native sort control connected/ },
      { name: "detached sort ownership", marker: "if (event.target?.isConnected === false) return;", replacement: "", pattern: "detached sort control", failure: /a detached sort control must not replace a newly selected people index/ }
    ]) {
      assert.equal(source.split(negative.marker).length - 1, 1, `negative must alter only ${negative.name}`);
      await assert.rejects(() => runSortControls({ casePattern: negative.pattern, sourceOverrides: { "/app.js": source.replace(negative.marker, negative.replacement) } }), { name: "AssertionError", message: negative.failure });
      console.log(`PASS negative control detects missing ${negative.name}`);
    }
  }
}
