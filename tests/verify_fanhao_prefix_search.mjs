import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Actual Web shell and index; only synthetic catalog data on private HTTP.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), publicRoot = path.join(root, "public");
const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean).find(file => fs.existsSync(file));
assert(executablePath, "private Chromium required");

export async function runPrefixSearch({ casePattern = "", sourceOverrides = {} } = {}) {
  const prefixes = Array.from({ length: 1200 }, (_, index) => ({ prefix: `PFX-${String(index).padStart(4, "0")}`, localCount: 1200 - index, maker: { name: `Synthetic maker ${index}` }, makers: [] }));
  prefixes[5].localCount = 9999;
  prefixes[1198].maker = { name: "主要厂商" }; prefixes[1198].makers = [{ name: "主要厂商" }, { name: "星河工作室" }];
  const faults = [], held = new Set(); let runtime, checks = 0;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://fixture");
      assert.equal(req.method, "GET", "index search must not write");
      if (url.pathname === "/api/library") return json(res, { people: [], works: [], totals: {}, user: {}, access: { mode: "local" } });
      if (url.pathname === "/api/code-prefixes") {
        runtime.reads++;
        if (runtime.pending) { runtime.pending.arrived(); await runtime.pending.wait; }
        return json(res, { prefixes, localWorkCount: 720600, mappedCount: prefixes.length });
      }
      if (url.pathname.startsWith("/api/code-prefixes/")) { runtime.details.push(decodeURIComponent(url.pathname.split("/").at(-1))); return json(res, { codePrefix: { prefix: runtime.details.at(-1), localCount: 1 }, works: [{ id: "selected-work", title: "Selected synthetic work", videoCount: 1 }], total: 1, facets: { all: 1 } }); }
      if (url.pathname.startsWith("/api/")) return json(res, {});
      if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      if (sourceOverrides[url.pathname] !== undefined) return send(res, sourceOverrides[url.pathname], "text/javascript");
      const filename = path.resolve(publicRoot, `.${decodeURIComponent(url.pathname)}`);
      assert(filename.startsWith(`${publicRoot}${path.sep}`));
      const target = fs.statSync(filename, { throwIfNoEntry: false })?.isFile() ? filename : path.join(publicRoot, "index.html");
      return send(res, await fs.promises.readFile(target), target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : "text/html");
    } catch (error) { faults.push(error.message); if (!res.destroyed) json(res, { error: error.message }, 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ executablePath, headless: true });
  try {
    await run("prefix search finds unloaded prefixes and alternate makers locally", async () => {
      const page = await open();
      try {
        assert.equal(await page.locator(".code-prefix-row").count(), 64);
        assert.equal(await page.getByRole("button", { name: "PFX-1199", exact: true }).count(), 0);
        const input = page.getByRole("searchbox", { name: "搜索番号前缀或厂商" });
        await input.fill("  pFx-1199  ");
        await page.getByRole("button", { name: "PFX-1199", exact: true }).waitFor();
        assert.equal(await page.locator(".code-prefix-row").count(), 1, "search must include prefixes beyond the initially rendered page");
        assert.match(await page.locator(".code-prefix-index-summary").textContent(), /1 \/ 1,200/);
        await input.fill("星河");
        assert.equal(await page.getByRole("button", { name: "PFX-1198", exact: true }).count(), 1, "search must include alternate maker records");
        assert.equal(await page.locator(".code-prefix-row").count(), 1, "alternate maker records must be searchable");
        assert.equal(runtime.reads, 1, "local index searches must reuse the complete catalog read");
        await page.getByRole("button", { name: "PFX-1198", exact: true }).click(); await page.locator('[data-work-id="selected-work"]').waitFor();
        assert.deepEqual(runtime.details, ["PFX-1198"]); assert.equal(new URL(page.url()).searchParams.get("prefix"), "PFX-1198");
        await page.goBack(); await page.getByRole("button", { name: "PFX-1198", exact: true }).waitFor();
        assert.equal(await input.inputValue(), "星河", "Back from a prefix must retain its index query");
        assert.equal(await page.locator(".code-prefix-row").count(), 1);
        assert.equal(runtime.reads, 1, "returning to the filtered index must reuse its complete catalog");
      } finally { await page.close(); }
    });
    await run("prefix search retains controls, sorts matches and appends only matches", async () => {
      const page = await open();
      try {
        const input = page.getByRole("searchbox", { name: "搜索番号前缀或厂商" });
        await input.fill("pfx-00"); await page.getByRole("button", { name: "PFX-0000", exact: true }).waitFor();
        assert.equal(await page.locator(".code-prefix-link").first().textContent(), "PFX-0005", "filtered results must initially keep count order");
        await page.evaluate(() => { window.__prefixInput = document.querySelector(".code-prefix-index-search input"); window.__prefixSort = document.querySelector("#codePrefixSortSelect"); });
        await page.locator("#codePrefixSortSelect").selectOption("name");
        assert.equal(await page.locator(".code-prefix-link").first().textContent(), "PFX-0000", "name sorting must reorder the current matches");
        await page.locator(".code-prefix-index-load-more button").click();
        assert.equal(await page.locator(".code-prefix-row").count(), 100, "append must use the filtered index rather than the full catalog");
        assert.equal(await page.locator(".code-prefix-link").last().textContent(), "PFX-0099");
        assert.equal(await page.evaluate(() => __prefixInput.isConnected && __prefixSort.isConnected), true, "search and sort controls must remain connected while filtering");
        await input.fill("no such catalog"); assert.match(await page.locator("#workGrid").textContent(), /没有匹配/);
        await page.getByRole("button", { name: "清空索引搜索", exact: true }).click();
        assert.equal(await input.inputValue(), ""); assert.equal(await input.evaluate(node => document.activeElement === node), true);
        assert.equal(await page.locator(".code-prefix-row").count(), 64); assert.equal(runtime.reads, 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "320px index controls must fit the viewport");
        await page.screenshot({ path: path.join(process.env.TEMP, "fanhao-prefix-search-320.png"), fullPage: false });
      } finally { await page.close(); }
    });
    await run("prefix search preserves a draft and native focus while the catalog arrives", async () => {
      let arrived, release;
      const pending = { requested: new Promise(resolve => { arrived = resolve; }), wait: new Promise(resolve => { release = resolve; }), arrived: () => arrived(), release: () => { held.delete(pending); release(); } };
      held.add(pending);
      const page = await open({ pending, waitForRows: false });
      try {
        await pending.requested;
        const input = page.getByRole("searchbox", { name: "搜索番号前缀或厂商" });
        assert.equal(await input.count(), 1, "pending interactive index must expose its controls");
        await input.fill("pfx-1199"); await input.evaluate(node => { window.__prefixDraft = node; node.setSelectionRange(2, 5); });
        pending.release(); await page.getByRole("button", { name: "PFX-1199", exact: true }).waitFor();
        assert.deepEqual(await input.evaluate(node => [node === __prefixDraft, document.activeElement === node, node.selectionStart, node.selectionEnd, node.value]), [true, true, 2, 5, "pfx-1199"], "the first catalog read must preserve the user's newer query, selection and native focus");
        assert.equal(await page.locator(".code-prefix-row").count(), 1);
        const oldRow = await page.locator(".code-prefix-row").elementHandle(), oldInput = await input.elementHandle();
        await page.getByRole("button", { name: "清空索引搜索", exact: true }).click();
        await oldRow.evaluate(node => node.click()); await frames(page);
        assert.deepEqual(runtime.details, [], "detached filtered rows must not navigate");
        await page.locator("#fanhaoNavigationButton").click(); await page.locator('[data-view="people"][data-people-scope="main"]').click();
        await page.waitForURL(url => url.pathname === "/fanhao");
        const before = await page.locator("#workGrid").textContent();
        await oldInput.evaluate(node => { node.value = "retired"; node.dispatchEvent(new Event("input")); }); await frames(page);
        assert.equal(await page.locator("#workGrid").textContent(), before, "detached index inputs cannot replace a newer view");
      } finally { pending.release(); await page.close(); }
    });
    await run("prefix search keeps current automatic paging after a queued old observer", async () => {
      const page = await open();
      try {
        await page.evaluate(() => { window.__oldPrefixObserver = __prefixObservers.at(-1); });
        const input = page.getByRole("searchbox", { name: "搜索番号前缀或厂商" });
        await input.fill("pfx-00");
        await page.evaluate(() => __oldPrefixObserver.callback([{ isIntersecting: true }]));
        assert.equal(await page.evaluate(() => __prefixObservers.at(-1).connected), true, "a queued observer from previous matches must not disconnect current automatic paging");
        await page.evaluate(() => __prefixObservers.at(-1).callback([{ isIntersecting: true }]));
        await page.waitForFunction(() => document.querySelectorAll(".code-prefix-row").length === 100);
        assert.equal(await page.locator(".code-prefix-link").last().textContent(), "PFX-0099");
        assert.equal(await input.evaluate(node => document.activeElement === node), true);
        assert.equal(runtime.reads, 1);
      } finally { await page.close(); }
    });
    assert(checks > 0); assert.deepEqual(faults, []); console.log(`Prefix index search passed (${checks} actual-shell scenarios).`);
  } finally { for (const pending of held) pending.release(); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  async function run(name, action) { if (casePattern && !name.includes(casePattern)) return; await action(); checks++; console.log(`PASS ${name}`); }
  async function open({ pending = null, waitForRows = true } = {}) {
    runtime = { reads: 0, details: [], pending };
    const page = await browser.newPage({ viewport: { width: 320, height: 820 } }); page.on("pageerror", error => faults.push(error.message));
    page.setDefaultTimeout(5000);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: true } });
      window.__prefixObservers = [];
      window.IntersectionObserver = class {
        constructor(callback) { this.callback = callback; __prefixObservers.push(this); }
        observe(target) { this.target = target; this.connected = true; }
        disconnect() { this.connected = false; }
        unobserve() {}
      };
    });
    await page.goto(`${base}${pending ? "/fanhao" : "/fanhao/codes"}`);
    if (pending) { await page.locator("#fanhaoNavigationButton").click(); await page.locator('[data-view="codes"]:not([data-code-prefix])').click(); }
    if (waitForRows) await page.locator(".code-prefix-row").first().waitFor(); return page;
  }
  async function frames(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
}
function send(res, body, type) { if (!res.destroyed) { res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); } }
function json(res, body, status = 200) { if (!res.destroyed) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); } }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = process.argv.find(value => value.startsWith("--case=")), negativeOnly = process.argv.includes("--negative-only");
  assert(!(option && negativeOnly));
  if (!negativeOnly) await runPrefixSearch({ casePattern: option?.slice(7) || "" });
  if (!option) {
    const source = fs.readFileSync(path.join(publicRoot, "modules/fanhao/code-prefix-page.js"), "utf8").replaceAll("\r\n", "\n");
    for (const negative of [
      { name: "alternate maker matching", marker: "...(item.makers || []).map(maker => maker.name)", replacement: "...[]", pattern: "prefix search finds", failure: /search must include alternate maker records/ },
      { name: "filtered append source", marker: "const prefixes = renderedPrefixes;", replacement: "const prefixes = state.codePrefixes;", pattern: "prefix search retains", failure: /append must use the filtered index rather than the full catalog/ },
      { name: "pending search control retention", marker: 'const existingControls = els.statsRow.querySelector(".code-prefix-index-controls");', replacement: "const existingControls = null;", pattern: "prefix search preserves", failure: /the first catalog read must preserve the user's newer query, selection and native focus/ },
      { name: "detached row ownership", marker: 'if (row.isConnected === false || state.activeView !== "codes" || state.selectedCodePrefix) return;', replacement: "", pattern: "prefix search preserves", failure: /detached filtered rows must not navigate/ },
      { name: "queued observer ownership", marker: "if (!target.isConnected || indexLoadPending || !entries.some((entry) => entry.isIntersecting)) return;", replacement: "if (indexLoadPending || !entries.some((entry) => entry.isIntersecting)) return;", pattern: "prefix search keeps", failure: /a queued observer from previous matches must not disconnect current automatic paging/ }
    ]) {
      assert.equal(source.split(negative.marker).length - 1, 1, `negative must alter only ${negative.name}`);
      await assert.rejects(() => runPrefixSearch({ casePattern: negative.pattern, sourceOverrides: { "/modules/fanhao/code-prefix-page.js": source.replace(negative.marker, negative.replacement) } }), { name: "AssertionError", message: negative.failure });
      console.log(`PASS negative control detects missing ${negative.name}`);
    }
  }
}
