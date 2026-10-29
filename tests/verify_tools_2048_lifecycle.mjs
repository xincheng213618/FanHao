import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Actual 2048 HTML/main in Chromium with controlled Worker replies. The final
// family uses the unmodified bundled Worker and local WASM on this private host.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(root, "public"), gamePath = "/games/2048/";
const initial = "1100000000000000";
export async function run2048Fixture({ casePattern = "", sourceOverrides = {} } = {}) {
  const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"]
    .filter(Boolean).find(value => fs.existsSync(value));
  assert(executablePath, "Chrome or Edge required for private 2048 verification");
  const overrides = new Map(Object.entries(sourceOverrides)), pages = new Set(), faults = [], unexpected = [], held = new Set(), requests = [];
  let browser, checks = 0;
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://fixture").pathname; requests.push(pathname);
    try {
      assert.equal(req.method, "GET", "game verification must only read private static assets");
      const gate = [...held].find(gate => !gate.used && gate.path === pathname);
      if (gate) { gate.used = true; gate.requestedResolve(); await gate.promise; }
      if (pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      if (pathname === "/worker-probe") {
        res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
        res.end('<!doctype html><script>window.messages=[];window.workerErrors=[];window.realWorker=new Worker("/games/2048/worker.js",{type:"module"});realWorker.onmessage=e=>messages.push(e.data);realWorker.onerror=e=>workerErrors.push(e.message);</script>'); return;
      }
      const target = path.resolve(publicRoot, pathname.replace(/^\/+/, ""));
      assert(target.startsWith(publicRoot + path.sep) && pathname.startsWith(gamePath), "only private 2048 assets are modelled");
      const body = overrides.has(pathname) ? overrides.get(pathname) : await fs.promises.readFile(target);
      const type = pathname.endsWith(".html") ? "text/html; charset=utf-8" : pathname.endsWith(".wasm") ? "application/wasm" : "text/javascript";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body);
    } catch (error) { unexpected.push(error.message); if (!res.destroyed) { res.writeHead(500); res.end(error.message); } }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  const run = async (name, task) => { if (casePattern && !name.includes(casePattern)) return; await task(); checks++; console.log(`PASS ${name}`); };
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    await run("2048 stopped or replaced boards reject a late AI result", async () => {
      for (const intent of ["stop", "set-board", "same-board", "load-hex"]) {
        const page = await newPage();
        try {
          await setBoard(page); await page.locator("#btn-auto").click(); const request = await lastCommand(page);
          if (intent === "stop") await page.locator("#btn-auto").click();
          else if (intent === "load-hex") await page.evaluate(() => loadFromHex("3300000000000000"));
          else await setBoard(page, intent === "same-board" ? initial : "3300000000000000");
          const before = await snapshot(page);
          await emit(page, request, 1);
          assert.deepEqual(await snapshot(page), before, "a retired AI result must not change the stopped or replaced current board");
          assert.equal(before.auto, "Auto Run"); assert.equal(before.active, false);
        } finally { await page.close(); }
      }
    });
    await run("2048 manual movement and undo retire pending AI intent", async () => {
      for (const intent of ["move", "no-op", "undo"]) {
        const page = await newPage();
        try {
          await setBoard(page);
          if (intent === "undo") { await page.locator("#btn-step").click(); await emit(page, await lastCommand(page), 1); }
          await page.locator("#btn-step").click(); const request = await lastCommand(page), prior = await snapshot(page);
          if (intent === "undo") await page.locator("#btn-undo").click();
          else await page.keyboard.press(intent === "move" ? "ArrowRight" : "ArrowUp");
          const before = await snapshot(page);
          if (intent === "no-op") assert.equal(before.board, prior.board, "the manual no-op fixture must preserve the exact board");
          else assert.notEqual(before.board, prior.board);
          await emit(page, request, 1);
          assert.deepEqual(await snapshot(page), before, intent === "no-op"
            ? "a manual no-op intent must retire its AI request even when hex is unchanged"
            : "a manual direction or undo must not receive a second move from old AI work");
        } finally { await page.close(); }
      }
    });
    await run("2048 current step is single flight and consumes only its matching reply", async () => {
      const page = await newPage();
      try {
        await setBoard(page); await page.locator("#btn-step").click(); await page.locator("#btn-step").click(); await page.locator("#btn-step").click();
        assert.equal((await commands(page)).length, 1, "repeated current Step must share one request");
        const request = await lastCommand(page), before = await snapshot(page);
        assert(Number.isSafeInteger(request.requestId) && request.requestId > 0);
        await page.locator("#speed-slider").focus();
        await emit(page, { requestId: request.requestId + 1000 }, 0); await emit(page, {}, 1);
        assert.deepEqual(await snapshot(page), before, "unknown or untagged replies must not consume the pending step");
        await emit(page, request, 1);
        const after = await snapshot(page);
        assert.equal(after.board, "2100000000000000", "the current Step reply must actually merge tiles and add one new tile");
        assert.equal(after.score, "4"); assert.equal(after.auto, "Auto Run");
        await emit(page, request, 2); assert.deepEqual(await snapshot(page), after, "a duplicate consumed step reply must not move twice");
        assert.equal((await commands(page)).length, 1);
      } finally { await page.close(); }
    });
    await run("2048 auto restart and ordered pipeline ignore obsolete zero replies", async () => {
      const page = await newPage();
      try {
        await setBoard(page); await page.locator("#btn-auto").click(); const old = await lastCommand(page);
        await page.locator("#btn-auto").click(); await page.locator("#btn-auto").click(); const current = await lastCommand(page);
        assert.equal(current.board_encoded, old.board_encoded); assert(current.requestId > old.requestId, "same-board auto restart needs a fresh monotonic ID");
        const before = await snapshot(page);
        await emit(page, old, 0);
        assert.deepEqual(await snapshot(page), before, "an obsolete no-move reply must not stop a restarted auto session on the same board");
        await emit(page, { requestId: current.requestId + 1000 }, 0);
        await emit(page, current, 1);
        assert.equal((await snapshot(page)).board, "2100000000000000");
        const next = await lastCommand(page);
        assert.equal((await commands(page)).length, 3, "accepted auto work must synchronously schedule the updated board");
        assert.equal(next.board_encoded, "2100000000000000"); assert(next.requestId > current.requestId);
        const moving = await snapshot(page);
        await emit(page, current, 0); await emit(page, old, 2);
        assert.deepEqual(await snapshot(page), moving, "out-of-order replies must not consume the next auto request");
        await emit(page, next, 2);
        assert.equal((await commands(page)).length, 4, "a second current auto reply must continue the pipeline");
        assert.notEqual((await snapshot(page)).board, moving.board);
        const last = await lastCommand(page), finalBoard = (await snapshot(page)).board;
        await emit(page, last, 0);
        assert.equal((await snapshot(page)).auto, "Auto Run", "a current no-move reply must still stop auto");
        assert.equal((await snapshot(page)).board, finalBoard); assert.equal((await commands(page)).length, 4);
      } finally { await page.close(); }
    });
    await run("2048 step and auto changes retain only the latest mode", async () => {
      const page = await newPage();
      try {
        await setBoard(page); await page.locator("#btn-step").click(); const step = await lastCommand(page);
        await page.locator("#btn-auto").click(); const auto = await lastCommand(page);
        const before = await snapshot(page); await emit(page, step, 1);
        assert.deepEqual(await snapshot(page), before, "an earlier Step result must not become the first Auto move");
        await page.locator("#btn-step").click(); assert.equal((await commands(page)).length, 2, "Step remains inactive while Auto is running");
        await emit(page, auto, 1); assert.equal((await snapshot(page)).board, "2100000000000000");
        const pendingAuto = await lastCommand(page); await page.locator("#btn-auto").click();
        await page.locator("#btn-step").click(); const latest = await lastCommand(page), stopped = await snapshot(page);
        await emit(page, pendingAuto, 0); assert.deepEqual(await snapshot(page), stopped);
        await emit(page, latest, 2); assert.notEqual((await snapshot(page)).board, stopped.board);
      } finally { await page.close(); }
    });
    await run("2048 hidden pages retire AI work without automatically resuming", async () => {
      for (const mode of ["step", "auto"]) {
        const page = await newPage();
        try {
          await setBoard(page); await page.locator(mode === "auto" ? "#btn-auto" : "#btn-step").click(); const request = await lastCommand(page);
          await page.evaluate(() => { dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
          const before = await snapshot(page), reads = (await commands(page)).length;
          assert.equal(before.auto, "Auto Run"); assert.equal(before.active, false);
          await emit(page, request, 1); assert.deepEqual(await snapshot(page), before, "pagehide must retire both step and auto replies");
          assert.equal((await commands(page)).length, reads, "pageshow must not automatically restart the AI");
          await page.locator("#btn-step").click(); await emit(page, await lastCommand(page), 1);
          assert.equal((await snapshot(page)).board, "2100000000000000", "explicit Step after return must remain usable");
        } finally { await page.close(); }
      }
    });
    await run("2048 calculate issued before ready remains current after ready", async () => {
      const page = await newPage({ ready: false });
      try {
        await setBoard(page); await page.locator("#btn-step").click(); const request = await lastCommand(page);
        await page.evaluate(() => __emit({ type: 'ready' })); await emit(page, request, 1);
        assert.equal((await snapshot(page)).board, "2100000000000000", "a current pre-ready request must still be accepted after worker initialization");
        assert.equal((await snapshot(page)).score, "4");
      } finally { await page.close(); }
    });
    await run("2048 bundled worker and WASM echo queued and live request IDs", async () => {
      const wasm = hold(gamePath + 'ai_core.wasm'), page = await newPage({ controlled: false });
      let queued = 0;
      page.on('console', message => { if (message.text().includes('暂存任务')) queued++; });
      try {
        await page.goto(base + '/worker-probe'); await requested(wasm);
        await page.evaluate(() => {
          realWorker.postMessage({ type: 'calculate', board_encoded: '1100000000000000', requestId: 'queued-obsolete' });
          realWorker.postMessage({ type: 'calculate', board_encoded: '1100000000000000', requestId: 'queued-current' });
        });
        await until(() => queued === 2, 'the real Worker must process both calculate messages while its WASM response is held');
        assert.deepEqual(await page.evaluate(() => messages), []);
        wasm.release();
        await page.waitForFunction(() => messages.some(message => message.type === 'move_result') && messages.some(message => message.type === 'ready'), null, { timeout: 15000 });
        const first = await page.evaluate(() => messages.filter(message => message.type === 'move_result'));
        assert.equal(first.length, 1, 'initialization must calculate only the latest queued board');
        assert.equal(first[0].requestId, 'queued-current', 'the real bundled Worker must echo the latest queued request ID');
        assert([1, 2, 3, 4].includes(first[0].best_move), 'the bundled WASM must actually calculate a valid initial-board move');
        await page.evaluate(() => realWorker.postMessage({ type: 'calculate', board_encoded: '3300000000000000', requestId: 'live-current' }));
        await page.waitForFunction(() => messages.filter(message => message.type === 'move_result').length === 2, null, { timeout: 15000 });
        const second = await page.evaluate(() => messages.filter(message => message.type === 'move_result')[1]);
        assert.equal(second.requestId, 'live-current', 'the real bundled Worker must echo a post-ready request ID');
        assert([1, 2, 3, 4].includes(second.best_move));
        assert.deepEqual(await page.evaluate(() => workerErrors), []);
        console.log(`REAL_2048_WORKER ${JSON.stringify({ queuedBeforeReady: queued, queued: first[0], live: second, wasmBytes: fs.statSync(path.join(publicRoot, gamePath, 'ai_core.wasm')).size })}`);
      } finally { wasm.release(); await page.evaluate(() => realWorker?.terminate()).catch(() => {}); await page.close(); }
    });
    assert(checks > 0, `no 2048 cases matched ${casePattern}`);
    assert.deepEqual(faults, [], 'private 2048 pages must not hide runtime errors'); assert.deepEqual(unexpected, []);
    assert(!requests.some(url => url.startsWith('/api/')), 'game verification must not use real application APIs');
    console.log(`2048 lifecycle passed (${checks} private Chromium behavior families)`); return { checks };
  } finally {
    for (const gate of held) gate.release();
    for (const page of pages) await page.close().catch(() => {});
    if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  async function newPage({ controlled = true, ready = true } = {}) {
    const page = await browser.newPage(); pages.add(page); page.on('pageerror', error => faults.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    if (controlled) {
      await page.addInitScript(() => {
        Math.random = () => 0; globalThis.__workers = [];
        globalThis.Worker = class { constructor() { this.commands = []; __workers.push(this); } postMessage(message) { this.commands.push(message); } terminate() {} };
        globalThis.__emit = message => __workers[0].onmessage({ data: message });
      });
      await page.goto(base + gamePath + 'index.html'); if (ready) await page.evaluate(() => __emit({ type: 'ready' }));
    }
    return page;
  }
  function hold(path) { let release, requestedResolve; const gate = { path, used: false, promise: new Promise(resolve => { release = resolve; }), requested: new Promise(resolve => { requestedResolve = resolve; }), release, requestedResolve }; held.add(gate); return gate; }
}
async function setBoard(page, board = initial) { await page.locator('#board-input').fill(board); await page.locator('#btn-set').click(); }
async function commands(page) { return page.evaluate(() => __workers[0].commands.filter(command => command.type === 'calculate')); }
async function lastCommand(page) { return (await commands(page)).at(-1); }
async function emit(page, request, move) { await page.evaluate(({ request, move }) => __emit({ type: 'move_result', requestId: request.requestId, best_move: move }), { request, move }); }
async function snapshot(page) { return page.evaluate(() => ({ board: getGridHex(), score: document.querySelector('#score').textContent, auto: document.querySelector('#btn-auto').textContent, active: document.querySelector('#btn-auto').classList.contains('active') })); }
async function requested(gate) { let timer; try { await Promise.race([gate.requested, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('held WASM did not start')), 5000); })]); } finally { clearTimeout(timer); } }
async function until(predicate, message) { const deadline = Date.now() + 5000; while (!predicate()) { assert(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 10)); } }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pattern = process.argv.find(value => value.startsWith('--case='))?.slice(7) || '', negativeOnly = process.argv.includes('--negative-only');
  assert(!(negativeOnly && pattern), '--case and --negative-only cannot be combined');
  if (!negativeOnly) { const result = await run2048Fixture({ casePattern: pattern }); if (!pattern) assert.equal(result.checks, 8); }
  if (!pattern) {
    const read = file => fs.readFileSync(path.join(publicRoot, gamePath, file), 'utf8').replaceAll('\r\n', '\n');
    const main = read('main.js'), worker = read('worker.js');
    for (const negative of [
      { name: 'same-board response ID owner', file: 'main.js', source: main, marker: ' || e.data.requestId !== request.requestId', replacement: '',
        casePattern: '2048 auto restart', failure: /an obsolete no-move reply must not stop a restarted auto session on the same board/ },
      { name: 'manual no-op retirement', file: 'main.js', source: main,
        marker: '    // Accepted AI replies have already consumed their pending request.\n    invalidateAIRequest();', replacement: '    // Negative: a manual no-op leaves pending work alive.',
        casePattern: '2048 manual movement', failure: /a manual no-op intent must retire its AI request even when hex is unchanged/ },
      { name: 'real worker request ID echo', file: 'worker.js', source: worker, marker: "postMessage({ type: 'move_result', best_move: bestMove, requestId });", replacement: "postMessage({ type: 'move_result', best_move: bestMove });",
        casePattern: '2048 bundled worker', failure: /the real bundled Worker must echo the latest queued request ID/ }
    ]) {
      assert.equal(negative.source.split(negative.marker).length, 2, `negative must alter one ${negative.name} marker`);
      await assert.rejects(() => run2048Fixture({ casePattern: negative.casePattern, sourceOverrides: { [gamePath + negative.file]: negative.source.replace(negative.marker, negative.replacement) } }),
        { name: 'AssertionError', message: negative.failure });
      console.log(`PASS negative control detects missing ${negative.name}`);
    }
  }
  console.log(`2048 gate passed (${pattern ? 'selected family' : negativeOnly ? '3 independent negative controls' : '8 behavior families + 3 independent negative controls'})`);
}
