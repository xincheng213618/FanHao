import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Actual shell with a synthetic 10,000-person library. A getter measures
// delivered person inspections; observer delivery is controlled, not timing.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), publicRoot = path.join(root, "public");
const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean).find(file => fs.existsSync(file));
assert(executablePath, "private Chromium required");

export async function runPeopleIndexSnapshot({ casePattern = "", sourceOverride = null } = {}) {
  const faults = [], reads = []; let checks = 0;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://fixture"); assert.equal(req.method, "GET", "index paging must not issue writes");
      if (url.pathname === "/api/library") {
        const scope = url.searchParams.get("scope") || "main"; reads.push(scope);
        const prefix = scope === "western" ? "W" : "M";
        const people = Array.from({ length: 10000 }, (_, index) => ({ id: `${prefix}-${index}`, name: `${prefix} Person ${String(index).padStart(5, "0")}`, workCount: 1, sourceCount: 1, actorProfile: { gender: index % 5 === 0 ? "male" : "female" } }));
        return json(res, { scope, people, works: [], totals: {}, user: {}, access: { mode: "local" } });
      }
      if (url.pathname.startsWith("/api/")) return json(res, {});
      if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      if (sourceOverride !== null && url.pathname === "/modules/fanhao/people-page.js") return send(res, sourceOverride, "text/javascript");
      const filename = path.resolve(publicRoot, `.${decodeURIComponent(url.pathname)}`); assert(filename.startsWith(`${publicRoot}${path.sep}`));
      const target = fs.statSync(filename, { throwIfNoEntry: false })?.isFile() ? filename : path.join(publicRoot, "index.html");
      return send(res, await fs.promises.readFile(target), target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : "text/html");
    } catch (error) { faults.push(error.message); if (!res.destroyed) json(res, { error: error.message }, 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ executablePath, headless: true });
  try {
    await run("people index appends inspect only the delivered page", async () => {
      const page = await open();
      try {
        const original = await page.locator(".person-index-card").all();
        await page.evaluate(() => { window.__initialPeopleCards = [...document.querySelectorAll(".person-index-card")]; });
        assert.equal(original.length, 48);
        assert.equal(await page.locator("#statsRow .stat strong").first().textContent(), "8,000");
        const initialReads = reads.length;
        for (let pageNumber = 2; pageNumber <= 4; pageNumber++) {
          await page.evaluate(() => { __profileInspections = 0; });
          const button = page.locator(".people-index-load-more button"); await button.click();
          assert.equal(await page.locator(".person-index-card").count(), pageNumber * 48);
          const inspected = await page.evaluate(() => __profileInspections);
          console.log(`MEASURE people append page ${pageNumber}: ${inspected} profile inspections for 48 new cards in a 10000-person library`);
          assert(inspected < 500, "appending one people page must not rescan all 10000 library records");
          assert.equal(await page.evaluate(() => __initialPeopleCards.every(node => node.isConnected)), true);
          assert.equal(await button.evaluate(node => document.activeElement === node), true);
        }
        assert.equal(await page.locator(".person-index-name", { hasText: "M Person 00000" }).count(), 0, "the snapshot must retain the existing gender filter");
        assert.equal(reads.length, initialReads, "local continuation must not reread the library");
      } finally { await page.close(); }
    });
    await run("people index retires old scope buttons and queued observers", async () => {
      const page = await open();
      try {
        const oldButton = await page.locator(".people-index-load-more button").elementHandle();
        await page.evaluate(() => { window.__oldPeopleObserver = __peopleObservers.filter(item => item.target?.classList.contains("people-index-load-more")).at(-1); });
        await changeScope(page, "western");
        await oldButton.evaluate(node => node.click());
        assert.equal(await page.locator(".person-index-card").count(), 48, "a retired load-more button must not append into a different library scope");
        await page.evaluate(() => __oldPeopleObserver.callback([{ isIntersecting: true }]));
        assert.equal(await page.evaluate(() => __peopleObservers.filter(item => item.target?.classList.contains("people-index-load-more")).at(-1).connected), true,
          "a queued old observer must not disconnect current people autoload");
        await page.evaluate(() => { __profileInspections = 0; __peopleObservers.filter(item => item.target?.classList.contains("people-index-load-more")).at(-1).callback([{ isIntersecting: true }]); });
        await page.waitForFunction(() => document.querySelectorAll(".person-index-card").length === 96);
        assert((await page.locator(".person-index-name").allTextContents()).every(name => name.startsWith("W ")));
        assert(await page.evaluate(() => __profileInspections < 500));
        await page.goBack();
        await page.locator(".person-index-name").filter({ hasText: "M Person" }).first().waitFor();
        assert.equal(await page.locator(".person-index-card").count(), 48, "returning to a scope must establish its own fresh snapshot");
      } finally { await page.close(); }
    });
    await run("people index discards a previously scheduled scope append", async () => {
      const page = await open();
      try {
        await page.evaluate(() => {
          const original = window.setTimeout; window.__peopleScheduled = [];
          window.setTimeout = (callback, delay, ...args) => delay === 80 ? (__peopleScheduled.push(() => callback(...args)), 0) : original(callback, delay, ...args);
          __peopleObservers.filter(item => item.target?.classList.contains("people-index-load-more")).at(-1).callback([{ isIntersecting: true }]);
          window.setTimeout = original;
        });
        await changeScope(page, "western");
        await page.evaluate(() => __peopleScheduled.forEach(callback => callback()));
        assert.equal(await page.locator(".person-index-card").count(), 48, "an old scheduled append must not advance the newly loaded scope");
        await page.locator(".people-index-load-more button").click(); assert.equal(await page.locator(".person-index-card").count(), 96);
      } finally { await page.close(); }
    });
    assert(checks > 0); assert.deepEqual(faults, []); console.log(`People index snapshot passed (${checks} actual-shell cases).`);
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  async function run(name, action) { if (casePattern && !name.includes(casePattern)) return; await action(); checks++; console.log(`PASS ${name}`); }
  async function open() {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } }); page.setDefaultTimeout(5000); page.on("pageerror", error => faults.push(error.message));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: true } });
      window.__peopleObservers = []; window.__profileInspections = 0;
      window.IntersectionObserver = class { constructor(callback) { this.callback = callback; __peopleObservers.push(this); } observe(target) { this.target = target; this.connected = true; } disconnect() { this.connected = false; } unobserve() {} };
      const fetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await fetch(...args);
        if (String(args[0]).includes("/api/library")) {
          const json = response.json.bind(response);
          response.json = async () => {
            const data = await json();
            for (const person of data.people) { const profile = person.actorProfile; Object.defineProperty(person, "actorProfile", { configurable: true, get() { __profileInspections++; return profile; } }); }
            return data;
          };
        }
        return response;
      };
    });
    await page.goto(`${base}/fanhao`); await page.locator(".person-index-card").first().waitFor(); return page;
  }
  async function changeScope(page, scope) {
    await page.locator("#fanhaoNavigationButton").click(); await page.locator(`[data-view="people"][data-people-scope="${scope}"]`).click();
    await page.locator(".person-index-name").filter({ hasText: scope === "western" ? "W Person" : "M Person" }).first().waitFor();
    await page.waitForURL(url => url.pathname === (scope === "western" ? "/western" : "/fanhao"));
  }
}
function send(res, body, type) { if (!res.destroyed) { res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); } }
function json(res, body, status = 200) { if (!res.destroyed) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); } }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = process.argv.find(value => value.startsWith("--case=")), negativeOnly = process.argv.includes("--negative-only");
  assert(!(option && negativeOnly));
  if (!negativeOnly) await runPeopleIndexSnapshot({ casePattern: option?.slice(7) || "" });
  if (!option) {
    const source = fs.readFileSync(path.join(publicRoot, "modules/fanhao/people-page.js"), "utf8").replaceAll("\r\n", "\n");
    for (const negative of [
      { name: "bounded snapshot continuation", pattern: "people index appends", failure: /appending one people page must not rescan all 10000 library records/,
        edits: [["const people = snapshot.people;", "const people = filteredPeople();"]] },
      { name: "retired control snapshot", pattern: "people index retires", failure: /a retired load-more button must not append into a different library scope/,
        edits: [['button.addEventListener("click", () => loadMorePeopleIndex(snapshot));', 'button.addEventListener("click", () => loadMorePeopleIndex());']] },
      { name: "queued observer ownership", pattern: "people index retires", failure: /a queued old observer must not disconnect current people autoload/,
        edits: [["if (peopleIndexLoadObserver !== observer || snapshot !== peopleIndexSnapshot || !target.isConnected\n          || peopleIndexLoadPending || !entries.some((entry) => entry.isIntersecting)) return;", "if (peopleIndexLoadPending || !entries.some((entry) => entry.isIntersecting)) return;"],
          ["      observer.disconnect();", "      peopleIndexLoadObserver?.disconnect();"]] }
    ]) {
      let altered = source;
      for (const [marker, replacement] of negative.edits) { assert.equal(altered.split(marker).length - 1, 1, `negative must alter its owning behavior: ${negative.name}`); altered = altered.replace(marker, replacement); }
      await assert.rejects(() => runPeopleIndexSnapshot({ casePattern: negative.pattern, sourceOverride: altered }), { name: "AssertionError", message: negative.failure });
      console.log(`PASS negative control detects missing ${negative.name}`);
    }
  }
}
