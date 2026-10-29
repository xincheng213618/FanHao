import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const publicRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const production = fs.readFileSync(path.join(publicRoot, "games/gomoku/gomoku.js"), "utf8");
const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean).find(value => fs.existsSync(value));
assert(executablePath, "Chrome or Edge is required for the private gomoku fixture");

async function runFixture({ source = production, pattern = "" } = {}) {
  const faults = [], requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture"); requests.push(url.pathname);
    try {
      assert.equal(req.method, "GET");
      if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      const target = path.resolve(publicRoot, url.pathname.replace(/^\/+/, ""));
      assert(target.startsWith(`${publicRoot}${path.sep}`));
      assert(!url.pathname.includes("/engine/"), "controlled Worker must not load the actual NNUE model or WASM");
      const content = url.pathname === "/games/gomoku/gomoku.js" ? source : await fs.promises.readFile(target);
      res.writeHead(200, { "content-type": target.endsWith(".html") ? "text/html; charset=utf-8" : target.endsWith(".css") ? "text/css" : "text/javascript" }); res.end(content);
    } catch (error) { faults.push(error.message); res.writeHead(500); res.end("fixture failure"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  let checks = 0;
  const run = async (name, task) => { if (pattern && !name.includes(pattern)) return; await task(); checks++; console.log(`PASS ${name}`); };
  async function open(failure = "") {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    page.on("pageerror", error => faults.push(error.message));
    await page.addInitScript(failure => {
      globalThis.__workers = []; globalThis.__workerFailure = failure;
      globalThis.Worker = class extends EventTarget {
        constructor(url) {
          super();
          if (__workerFailure === "constructor") { __workerFailure = ""; throw new DOMException("Synthetic Worker unavailable", "SecurityError"); }
          this.url = url; this.commands = []; this.terminated = 0; __workers.push(this);
        }
        postMessage(value) { if (__workerFailure === "postMessage") { __workerFailure = ""; throw new Error("Synthetic init failed"); } this.commands.push(value); }
        terminate() { this.terminated++; }
      };
      globalThis.__emit = (index, message) => __workers[index].dispatchEvent(new MessageEvent("message", { data: message }));
      globalThis.__error = index => __workers[index].dispatchEvent(new ErrorEvent("error", { message: "Synthetic engine failure" }));
    }, failure);
    await page.goto(`${base}/games/gomoku/index.html`);
    return page;
  }
  const ready = async (page, index = 0) => { await page.evaluate(index => __emit(index, { type: "ready" }), index); await page.locator("#loadingPanel.hidden").waitFor({ state: "attached" }); };
  const humanMove = async page => { const board = page.locator("#board"), box = await board.boundingBox(); await board.click({ position: { x: box.width / 2, y: box.height / 2 } }); await page.waitForFunction(() => __workers.at(-1).commands.some(value => value.command?.startsWith("YXBOARD "))); };
  try {
    await run("initial failure retries and rejects old Worker callbacks", async () => {
      const page = await open();
      try {
        assert.equal(await page.locator("#engineRetryButton").count(), 1, "engine failures need an in-page retry action");
        await page.evaluate(() => __error(0));
        assert.equal(await page.locator("#engineRetryButton").isVisible(), true);
        assert.equal(await page.evaluate(() => __workers[0].terminated), 1, "failed Worker must be terminated exactly once");
        await page.locator("#engineRetryButton").click();
        assert.equal(await page.evaluate(() => __workers.length), 2);
        await page.evaluate(() => { __emit(0, { type: "ready" }); __error(0); });
        assert.equal(await page.locator("#engineBadge").textContent(), "引擎加载中", "old Worker callbacks cannot publish into the retry");
        await ready(page, 1);
        assert.equal(await page.locator("#engineRetryButton").isVisible(), false);
        await humanMove(page);
        assert.match(await page.locator("#board").getAttribute("aria-label"), /已下 1 手/);
      } finally { await page.close(); }
    });
    await run("thinking failure preserves the game and resumes the pending AI turn", async () => {
      const page = await open();
      try {
        await ready(page); await humanMove(page);
        await page.evaluate(() => __error(0));
        assert.match(await page.locator("#board").getAttribute("aria-label"), /已下 1 手/);
        assert.equal(await page.locator("#thinkingIndicator").textContent(), "引擎不可用");
        assert.equal(await page.locator("#thinkingIndicator").evaluate(node => node.classList.contains("active")), false);
        assert.equal(await page.evaluate(() => __workers[0].terminated), 1, "failed Worker must be terminated exactly once");
        await page.locator("#engineRetryButton").click(); await ready(page, 1);
        await page.waitForFunction(() => __workers[1].commands.some(value => value.command === "YXBOARD 7,7,1 DONE"));
        await page.evaluate(() => { __emit(0, { type: "stdout", line: "7,9" }); __emit(1, { type: "stdout", line: "7,8" }); });
        assert.match(await page.locator("#board").getAttribute("aria-label"), /已下 2 手/);
        assert.equal(await page.locator("#statusTitle").textContent(), "轮到你了");
      } finally { await page.close(); }
    });
    await run("narrow screen long engine failure keeps retry reachable", async () => {
      const page = await open();
      try {
        await page.setViewportSize({ width: 320, height: 640 });
        await page.evaluate(() => __emit(0, { type: "error", message: "Synthetic long initialization error. ".repeat(20) }));
        const retry = page.locator("#engineRetryButton");
        assert.equal(await retry.evaluate(button => {
          const bounds = button.getBoundingClientRect(), board = document.querySelector("#boardWrap").getBoundingClientRect();
          const center = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
          return bounds.top >= board.top && bounds.bottom <= board.bottom && bounds.left >= 0 && bounds.right <= innerWidth && (center === button || button.contains(center));
        }), true, "long engine errors must not clip or cover the retry action on a 320px screen");
        const detail = page.locator("#loadingDetail");
        assert.equal(await detail.evaluate(node => node.scrollHeight > node.clientHeight), true, "long error details must have a bounded scrollable area");
        await detail.focus(); await page.keyboard.press("PageDown");
        await page.waitForFunction(() => document.querySelector("#loadingDetail").scrollTop > 0);
        await retry.click();
        assert.equal(await page.evaluate(() => __workers.length), 2, "a real pointer click must start a fresh Worker");
        await ready(page, 1);
        assert.equal(await page.locator("#thinkingIndicator").textContent(), "等待对局");
      } finally { await page.close(); }
    });
    for (const failure of ["constructor", "postMessage"]) await run(`${failure} failure becomes retryable without an uncaught error`, async () => {
      const page = await open(failure);
      try {
        assert.equal(await page.locator("#engineRetryButton").isVisible(), true);
        await page.locator("#engineRetryButton").click();
        await ready(page, await page.evaluate(() => __workers.length - 1));
        assert.equal(await page.locator("#engineBadge").textContent(), "Rapfi 已就绪");
      } finally { await page.close(); }
    });
    for (const message of [{ type: "exit", code: 1 }, { type: "stdout", line: "ERROR Synthetic search failure" }]) await run(`${message.type} failure exposes retry and new game recovers`, async () => {
      const page = await open();
      try {
        await ready(page);
        if (message.type === "stdout") await humanMove(page);
        await page.evaluate(message => __emit(0, message), message);
        assert.equal(await page.locator("#engineRetryButton").isVisible(), true);
        await page.locator("#newGameButton").click();
        assert.equal(await page.evaluate(() => __workers.length), 2, "new game must reload a failed engine");
        await ready(page, 1); assert.match(await page.locator("#board").getAttribute("aria-label"), /已下 0 手/);
      } finally { await page.close(); }
    });
    await run("settings storage failure still applies the selected side", async () => {
      const page = await open();
      try {
        await ready(page); await humanMove(page);
        await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException("Synthetic storage quota", "QuotaExceededError"); }; });
        await page.locator("#sideSelector label").filter({ hasText: "我执白" }).click();
        assert.match(await page.locator("#board").getAttribute("aria-label"), /已下 0 手/);
        await ready(page, 1);
        await page.waitForFunction(() => __workers[1].commands.some(value => value.command === "YXBOARD DONE"));
      } finally { await page.close(); }
    });
    await run("persisted page return restarts the engine with the current board", async () => {
      const page = await open();
      try {
        await ready(page); await humanMove(page);
        await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
        assert.equal(await page.evaluate(() => __workers[0].terminated), 1);
        await page.evaluate(() => { __emit(0, { type: "stdout", line: "7,8" }); dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); });
        assert.equal(await page.evaluate(() => __workers.length), 2);
        await ready(page, 1);
        await page.waitForFunction(() => __workers[1].commands.some(value => value.command === "YXBOARD 7,7,1 DONE"));
      } finally { await page.close(); }
    });
    assert(checks > 0); assert.deepEqual(faults, []); assert(!requests.some(value => value.includes("/engine/")));
    return { checks };
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

const current = await runFixture(); assert.equal(current.checks, 9);
for (const control of [
  { name: "old Worker callbacks", marker: "if (engineWorker !== worker) return;", replacement: "", pattern: "initial failure", failure: /old Worker callbacks cannot publish/ },
  { name: "Worker reclamation", marker: "worker?.terminate();", replacement: "", pattern: "thinking failure", failure: /failed Worker must be terminated exactly once/ },
  { name: "bounded error layout", marker: 'els.loadingPanel.classList.add("failed");', replacement: "", pattern: "narrow screen", failure: /long engine errors must not clip or cover/ }
]) {
  assert(production.includes(control.marker));
  await assert.rejects(() => runFixture({ source: production.replaceAll(control.marker, control.replacement), pattern: control.pattern }), { name: "AssertionError", message: control.failure });
  console.log(`PASS negative control detects missing ${control.name}`);
}
console.log("Tools gomoku lifecycle passed (9 private Chromium cases and 3 behavior negative controls; controlled Worker, no real model)");
