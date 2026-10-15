import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright-core";
import { createNovelStore } from "../src/modules/novels/server/store.js";

// Real Chromium + current novel page. Only generated text and private loopback
// progress writes; default persistence is the actual store in a fresh SQLite.
// --memory-ledger is a packet-order baseline, never server acceptance evidence.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(root, "public");

export async function runNovelProgressFixture({ legacyNovel = false, legacyClockSlot = false, memoryLedger = false, sourceOverrides = {}, casePattern = "" } = {}) {
  const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean).find(value => fs.existsSync(value));
  assert(executablePath, "Chrome or Edge required for private novel progress fixture");
  const overrides = new Map(sourceOverrides instanceof Map ? sourceOverrides : Object.entries(sourceOverrides));
  if (legacyNovel) {
    const result = spawnSync("git", ["show", "HEAD:public/modules/novels/novel-page.js"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); overrides.set("/modules/novels/novel-page.js", result.stdout);
  }
  if (legacyClockSlot) {
    const sourcePath = "/modules/novels/novel-page.js", source = overrides.get(sourcePath) || fs.readFileSync(path.join(publicRoot, "modules/novels/novel-page.js"), "utf8");
    assert.equal((source.match(/^[ \t]*invalidateProgressClock\(\);[ \t]*\r?$/gm) || []).length, 2, "clock-slot negative control must remove only the two navigation invalidation calls");
    overrides.set(sourcePath, source.replace(/^[ \t]*invalidateProgressClock\(\);[ \t]*\r?$/gm, ""));
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-novel-progress-browser-"));
  const cases = [], gates = new Set(), clockGates = new Set(), faults = [], unexpected = [];
  let current = null, checks = 0, browser = null;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture");
    try {
      const progressMatch = /^\/api\/novels\/([^/]+)\/progress$/.exec(url.pathname);
      assert(req.method === "GET" || (req.method === "POST" && progressMatch), `unmodelled mutation: ${req.method} ${url.pathname}`);
      if (progressMatch && req.method === "POST") {
        const test = owner(decodeURIComponent(progressMatch[1]));
        let input = ""; for await (const chunk of req) input += chunk;
        const entry = { bookId: decodeURIComponent(progressMatch[1]), body: JSON.parse(input), committed: false };
        test.received.push(entry);
        const gate = [...gates].find(value => !value.used && value.match(entry));
        if (gate) { gate.used = true; gate.entry = entry; gate.requestedResolve(); await gate.promise; }
        if (gate?.error) { entry.error = gate.error; sendJson(res, { error: gate.error }, 503); return; }
        try {
          const progress = memoryLedger ? { ...entry.body, bookId: entry.bookId } : test.store.saveProgress(entry.bookId, entry.body);
          assert(progress, "synthetic progress book must exist"); entry.committed = true; entry.result = progress;
          if (memoryLedger) test.ledger.set(entry.bookId, progress);
          test.committed.push(entry); sendJson(res, { ok: true, progress });
        } catch (error) { entry.error = error.message; entry.code = error.code; sendJson(res, { error: error.message, code: error.code }, error.statusCode || 500); }
        return;
      }
      if (url.pathname === "/probe") { sendText(res, harness(current.library()), "text/html; charset=utf-8"); return; }
      if (url.pathname === "/left") { sendText(res, "<!doctype html><title>Left synthetic reader</title>", "text/html"); return; }
      if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      const chapterMatch = /^\/api\/novels\/([^/]+)\/chapters\/(\d+)$/.exec(url.pathname);
      if (chapterMatch) { const id = decodeURIComponent(chapterMatch[1]), test = owner(id), detail = test.store.chapterDetail(id, Number(chapterMatch[2]), { sourceRealm: url.searchParams.get("sourceRealm") || undefined, catalogRevision: url.searchParams.get("catalogRevision") || undefined, chapterId: url.searchParams.get("chapterId") || undefined }); if (test.recoveryBook === detail.book.id) { detail.book.progressRecovery = { status: "needs_review", reason: "synthetic_confirmation" }; detail.book.progress = null; } sendJson(res, detail); return; }
      const catalogMatch = /^\/api\/novels\/([^/]+)\/catalog$/.exec(url.pathname);
      if (catalogMatch) { const id = decodeURIComponent(catalogMatch[1]); sendJson(res, owner(id).store.catalog(id, url)); return; }
      const bookMatch = /^\/api\/novels\/([^/]+)$/.exec(url.pathname);
      if (bookMatch) {
        const id = decodeURIComponent(bookMatch[1]), store = owner(id).store;
        const gate = url.searchParams.get("catalog") === "0" && [...clockGates].find(value => !value.used && value.bookId === id);
        if (gate) { gate.used = true; res.once("close", () => { gate.closed = true; }); await gate.promise; }
        const data = url.searchParams.get("catalog") === "0" ? store.bookMeta(id) : store.bookDetail(id);
        if (gate) gate.data = data; sendJson(res, data); return;
      }
      if (url.pathname === "/api/novels") { sendJson(res, current.library()); return; }
      if (url.pathname === "/api/modules") { sendJson(res, { product: { id: "suite" }, modules: [] }); return; }
      if (url.pathname.startsWith("/api/")) { unexpected.push(url.pathname); sendJson(res, { error: "unmodelled synthetic API" }, 404); return; }
      if (url.pathname === "/synthetic.svg") { sendText(res, '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="#729b7c"/></svg>', "image/svg+xml"); return; }
      if (overrides.has(url.pathname)) { sendText(res, overrides.get(url.pathname), "text/javascript"); return; }
      const target = /^\/novels(?:\/|$)/.test(url.pathname) ? path.join(publicRoot, "index.html") : path.resolve(publicRoot, url.pathname.replace(/^\/+/, ""));
      assert(target.startsWith(publicRoot + path.sep), "static paths must stay inside public");
      const type = target.endsWith(".html") ? "text/html; charset=utf-8" : target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : "application/octet-stream";
      sendText(res, await fs.promises.readFile(target), type);
    } catch (error) { unexpected.push(`${url.pathname}: ${error.message}`); sendJson(res, { error: error.message }, 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  const run = async (name, task) => {
    if (casePattern && !name.includes(casePattern)) return;
    const dbPath = path.resolve(temporary, `case-${cases.length + 1}.sqlite`); assert(dbPath.startsWith(temporary + path.sep));
    const store = createNovelStore({ dbPath }), books = new Map();
    for (const id of ["A", "B"]) books.set(id, store.importCollectedBook({ title: `Book ${id}`, sourceUrl: `https://synthetic.invalid/case-${cases.length + 1}/${id}`, chapters: [1, 2].map(index => ({ title: `${id} Chapter ${index}`, content: syntheticText(id, index) })) }).book.id);
    current = { dbPath, store, books, received: [], committed: [], ledger: new Map(), recoveryBook: "", library: () => ({ books: [...books.values()].map(id => ({ ...store.bookDetail(id).book, coverUrl: "/synthetic.svg" })), total: 2, limit: 48, offset: 0, summary: store.summary() }) };
    cases.push(current); await task(current); checks++; console.log(`PASS ${name}`);
  };
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    await run("actual host late normal progress cannot roll back pagehide keepalive", async test => {
      const older = hold(entry => entry.bookId === test.books.get("A")), page = await newPage(test, true);
      try {
        await requested(older); const ratio = await scrollRatio(page, .8);
        await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide")));
        await until(() => test.committed.some(entry => entry.bookId === test.books.get("A") && entry.body.scrollRatio > .7), "keepalive must commit the latest visible progress before the older normal write releases");
        const latest = saved(test, "A"); older.release(); await until(() => older.entry.committed || older.entry.error, "older write must finish");
        console.log(`ORDER latest=${latest.scrollRatio.toFixed(3)} old=${older.entry.body.scrollRatio.toFixed(3)} final=${saved(test, "A").scrollRatio.toFixed(3)} ledger=${memoryLedger ? "memory" : "actual SQLite"}`);
        assert.equal(saved(test, "A").scrollRatio, latest.scrollRatio, "the delayed older normal packet must not replace the latest keepalive progress");
        assert(Math.abs(latest.scrollRatio - ratio) < .02, "keepalive must record the measured current reader ratio");
        if (!memoryLedger) {
          const keepalive = test.committed.find(entry => entry !== older.entry && entry.body.scrollRatio > .7);
          assert.match(keepalive.body.progressSessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, "page must use the actual UUID progress session contract");
          assert(Number.isSafeInteger(keepalive.body.progressSessionStartedAt));
          assert(Number.isSafeInteger(keepalive.body.progressSequence) && keepalive.body.progressSequence > older.entry.body.progressSequence);
          assert.equal(keepalive.body.progressSessionId, older.entry.body.progressSessionId, "normal and keepalive must share one document session");
          assert.equal(keepalive.body.progressSessionStartedAt, older.entry.body.progressSessionStartedAt);
          assert.equal(keepalive.result.applied, true); assert.equal(older.entry.result?.applied, false, "actual SQLite must return the current progress with applied:false for the late lower sequence");
        }
      } finally { older.release(); await page.close(); }
    });

    await run("real document leave keeps latest after older packet commits", async test => {
      const older = hold(entry => entry.bookId === test.books.get("A")), page = await newPage(test, true);
      try {
        await requested(older); await scrollRatio(page, .75); await page.goto(`${base}/left`);
        await until(() => test.committed.some(entry => entry.body.scrollRatio > .7), "real document leave must deliver a loopback keepalive packet");
        const latest = saved(test, "A"); older.release(); await until(() => older.entry.committed || older.entry.error, "older write must finish after reader document disappears");
        assert.equal(saved(test, "A").scrollRatio, latest.scrollRatio, "unloaded reader's older normal packet must not roll back its final progress");
      } finally { older.release(); await page.close(); }
    });

    await run("200 visible progress flushes conflate slow normal write", async test => {
      const older = hold(entry => entry.bookId === test.books.get("A")), page = await newPage(test);
      try {
        await openChapter(page, test.books.get("A"), 1); await requested(older);
        const ratio = await page.evaluate(async () => {
          let ratio = 0;
          for (let index = 0; index < 200; index++) {
            const reader = document.querySelector(".novel-reader-page"), top = reader.getBoundingClientRect().top + scrollY, height = Math.max(1, reader.scrollHeight - innerHeight);
            ratio = .1 + .8 * index / 199; scrollTo(0, top + height * ratio); dispatchEvent(new Event("scroll")); fixture.page.resetReader();
          }
          return ratio;
        });
        assert.equal(test.received.length, 1, "one normal packet must remain in flight while newer positions accumulate");
        older.release(); await until(() => saved(test, "A")?.scrollRatio > .85, "latest conﬂated progress must persist"); await stable(test);
        assert(test.received.length <= 3, `200 samples must have a bounded write backlog, received ${test.received.length}`);
        assert(Math.abs(saved(test, "A").scrollRatio - ratio) < .02);
      } finally { older.release(); await page.close(); }
    });

    await run("slow normal write retains last progress for both books", async test => {
      const older = hold(entry => entry.bookId === test.books.get("A")), page = await newPage(test);
      try {
        await openChapter(page, test.books.get("A"), 1); await requested(older); const expected = new Map();
        for (const [id, index, ratio] of [["A", 1, .2], ["B", 1, .35], ["A", 2, .65], ["B", 2, .8]]) {
          await openChapter(page, test.books.get(id), index); expected.set(id, { index, ratio: await scrollRatio(page, ratio) }); await page.evaluate(() => fixture.page.resetReader());
        }
        older.release(); await until(() => [...expected].every(([id, value]) => saved(test, id)?.chapterIndex === value.index && Math.abs(saved(test, id).scrollRatio - value.ratio) < .02), "each book's latest chapter/ratio must survive conflation"); await stable(test);
        assert(test.received.length <= 5, `two-book latest writes must stay bounded, received ${test.received.length}`);
      } finally { older.release(); await page.close(); }
    });

    await run("queued recovery confirmation completes and reenables reader", async test => {
      const older = hold(entry => entry.bookId === test.books.get("A")), page = await newPage(test);
      try {
        await openChapter(page, test.books.get("A"), 1); await requested(older); test.recoveryBook = test.books.get("B");
        await openChapter(page, test.books.get("B"), 1); await scrollRatio(page, .55);
        const confirm = page.locator(".novel-progress-recovery-confirm"); await confirm.evaluate(button => button.click()); assert(await confirm.isDisabled(), "recovery confirmation must remain pending behind a slow normal save");
        await page.evaluate(() => { for (let index = 0; index < 200; index++) dispatchEvent(new Event("scroll")); });
        older.release(); await until(() => saved(test, "B")?.scrollRatio > .5, "queued explicit recovery confirmation must not be dropped");
        await page.waitForFunction(() => !fixture.state.novel.book.progressRecovery); assert.equal(await page.locator(".novel-progress-recovery-confirm").count(), 0, "the confirmation promise must resolve successfully and update reader recovery state");
      } finally { older.release(); await page.close(); }
    });

    await run("unapplied explicit recovery keeps banner unlocked until actual retry acknowledgement", async test => {
      assert(!memoryLedger, "recovery sequence acceptance requires the actual SQLite store");
      test.recoveryBook = test.books.get("A"); const confirmation = hold(entry => entry.bookId === test.books.get("A")), page = await newPage(test);
      try {
        await openChapter(page, test.books.get("A"), 1); const ratio = await scrollRatio(page, .6);
        const confirm = page.locator(".novel-progress-recovery-confirm"); await confirm.evaluate(button => button.click()); await requested(confirmation);
        const higher = { ...confirmation.entry.body, progressSequence: confirmation.entry.body.progressSequence + 1, scrollRatio: .9 };
        assert.equal(test.store.saveProgress(test.books.get("A"), higher).applied, true, "a real higher-sequence SQLite commit must make the held confirmation obsolete");
        confirmation.release(); await until(() => confirmation.entry.committed, "obsolete confirmation must receive an actual store response");
        assert.equal(confirmation.entry.result.applied, false); await page.waitForFunction(() => !document.querySelector(".novel-progress-recovery-confirm")?.disabled);
        assert(await page.evaluate(() => Boolean(fixture.state.novel.book.progressRecovery)), "applied:false must retain the recovery banner"); assert.equal(await confirm.count(), 1);
        let acknowledgement = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          const before = test.received.length; await confirm.evaluate(button => button.click());
          await until(() => test.received.length > before && (test.received[before].committed || test.received[before].error), "recovery retry must settle");
          const retry = test.received[before];
          if (retry.result?.applied) { acknowledgement = retry; break; }
          assert.equal(retry.result?.applied, false); await page.waitForFunction(() => !document.querySelector(".novel-progress-recovery-confirm")?.disabled);
          assert(await page.evaluate(() => Boolean(fixture.state.novel.book.progressRecovery)), "another unapplied retry must remain recoverable");
        }
        assert(acknowledgement, "a fresh higher-sequence explicit retry must eventually get an actual applied acknowledgement");
        assert(acknowledgement.body.progressSequence > higher.progressSequence); await page.waitForFunction(() => !fixture.state.novel.book.progressRecovery);
        assert.equal(await confirm.count(), 0); assert(Math.abs(saved(test, "A").scrollRatio - ratio) < .02);
      } finally { confirmation.release(); await page.close(); }
    });

    await run("expired session renewal retains newest scroll while fresh clock GET waits", async test => {
      assert(!memoryLedger, "session expiry acceptance requires the actual SQLite store");
      const page = await newPage(test); let clock = null;
      try {
        await openChapter(page, test.books.get("A"), 1); await until(() => test.committed.length > 0, "initial fenced progress must commit");
        const initial = test.committed[0].body, floor = initial.progressSessionStartedAt + 24 * 60 * 60 * 1000 + 1;
        assert(Number.isSafeInteger(floor)); assert(test.dbPath.startsWith(temporary + path.sep));
        const db = new DatabaseSync(test.dbPath);
        try { db.prepare("INSERT INTO novel_meta(key,value) VALUES ('progress_clock_ms', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(floor)); } finally { db.close(); }
        clock = holdClock(test.books.get("A")); await scrollRatio(page, .35); await requested(clock);
        const latest = await scrollRatio(page, .83); await page.evaluate(() => { fixture.renewReader = document.querySelector(".novel-reader-page"); fixture.renewParagraph = document.querySelector(".novel-reader-content p"); });
        await until(() => test.received.filter(entry => entry.code === "NOVEL_PROGRESS_SESSION_EXPIRED").length >= 2, "a newer scroll save must advance the progress revision while clock renewal is pending");
        assert(await page.evaluate(() => fixture.state.novel.book.progress.scrollRatio > .8), "the newest optimistic position must already be visible before clock renewal");
        clock.release();
        await until(() => test.committed.some(entry => entry.body.progressSessionId !== initial.progressSessionId && entry.body.scrollRatio > .8), "fresh clock renewal must save the newer measured position");
        const renewed = test.committed.find(entry => entry.body.progressSessionId !== initial.progressSessionId && entry.body.scrollRatio > .8);
        assert.equal(renewed.result.applied, true); assert.notEqual(renewed.body.progressSessionId, initial.progressSessionId);
        assert.equal(renewed.body.progressSessionStartedAt, clock.data.serverClockMs); assert(renewed.body.progressSessionStartedAt >= floor); assert.equal(renewed.body.progressSequence, 1);
        assert(Math.abs(saved(test, "A").scrollRatio - latest) < .02);
        assert(await page.evaluate(() => fixture.renewReader === document.querySelector(".novel-reader-page") && fixture.renewParagraph === document.querySelector(".novel-reader-content p")), "clock-only renewal must preserve the mounted reader text");
      } finally { clock?.release(); await page.close(); }
    });

    await run("cached adjacent chapter cancels obsolete clock slot and renews independently", async test => {
      assert(!memoryLedger, "cached-chapter expiry acceptance requires the actual SQLite store");
      const page = await newPage(test); let oldClock = null, newClock = null;
      try {
        await openChapter(page, test.books.get("A"), 1); await until(() => test.committed.length > 0, "initial chapter progress must commit");
        await page.waitForFunction(() => __chapterReads.some(value => value.index === 2)); await frames(page);
        const cachedClock = await page.evaluate(() => __chapterReads.find(value => value.index === 2).serverClockMs), initial = test.committed[0].body;
        const floor = initial.progressSessionStartedAt + 24 * 60 * 60 * 1000 + 1;
        assert(cachedClock < floor, "next-chapter prefetch must hold a valid cache entry with the older clock");
        assert(test.dbPath.startsWith(temporary + path.sep)); const db = new DatabaseSync(test.dbPath);
        try { db.prepare("INSERT INTO novel_meta(key,value) VALUES ('progress_clock_ms', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(floor)); } finally { db.close(); }
        oldClock = holdClock(test.books.get("A")); await scrollRatio(page, .25); await requested(oldClock);
        newClock = holdClock(test.books.get("A")); const readsBefore = await page.evaluate(() => __chapterReads.filter(value => value.index === 2).length);
        await page.evaluate(() => fixture.page.openAdjacent(1)); await frames(page);
        assert.equal(await page.locator(".novel-reader-paper h1").textContent(), "A Chapter 2");
        assert.equal(await page.evaluate(() => __chapterReads.filter(value => value.index === 2).length), readsBefore, "adjacent chapter must use the warmed cache rather than an incidental fresh chapter GET");
        await scrollRatio(page, .2); await requested(newClock); await until(() => oldClock.closed, "changing chapter must abort the obsolete clock request");
        const latest = await scrollRatio(page, .87);
        await until(() => test.received.filter(entry => entry.body.chapterIndex === 2 && entry.code === "NOVEL_PROGRESS_SESSION_EXPIRED").length >= 2, "new chapter must retain its newer scroll revision while its own clock request is held");
        oldClock.release(); await frames(page);
        assert.equal(await page.locator(".novel-reader-paper h1").textContent(), "A Chapter 2");
        assert(await page.evaluate(() => fixture.state.novel.book.progress.scrollRatio > .85), "the released obsolete clock request must not replace the new chapter position");
        newClock.release();
        await until(() => test.committed.some(entry => entry.body.chapterIndex === 2 && entry.body.progressSessionId !== initial.progressSessionId && entry.body.scrollRatio > .85), "the new chapter's independent renewal must save its latest position");
        const renewed = test.committed.find(entry => entry.body.chapterIndex === 2 && entry.body.progressSessionId !== initial.progressSessionId);
        assert.equal(renewed.result.applied, true); assert.equal(renewed.body.progressSessionStartedAt, newClock.data.serverClockMs); assert(renewed.body.progressSessionStartedAt >= floor);
        assert.equal(renewed.body.progressSequence, 1); assert.equal(saved(test, "A").chapterIndex, 2); assert(Math.abs(saved(test, "A").scrollRatio - latest) < .02);
      } finally { oldClock?.release(); newClock?.release(); await page.close(); }
    });
    assert(checks > 0, `no novel progress cases matched: ${casePattern}`); assert.deepEqual(faults, []); assert.deepEqual(unexpected, []);
    console.log(`Novel progress fixture passed (${checks} cases; Chromium + ${memoryLedger ? "memory packet ledger" : "actual private SQLite store"})`); return { checks };
  } finally {
    for (const gate of [...gates, ...clockGates]) gate.release(); if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const entry of fs.readdirSync(temporary)) { const target = path.resolve(temporary, entry); assert(target.startsWith(temporary + path.sep)); assert(fs.statSync(target).isFile()); fs.unlinkSync(target); } fs.rmdirSync(temporary);
  }

  function hold(match, error = "") { let release, requestedResolve; const gate = { match, error, used: false, promise: new Promise(resolve => { release = resolve; }), requested: new Promise(resolve => { requestedResolve = resolve; }), release, requestedResolve }; gates.add(gate); return gate; }
  function holdClock(bookId) { let release; const gate = { bookId, used: false, promise: new Promise(resolve => { release = resolve; }), release }; clockGates.add(gate); return gate; }
  function owner(bookId) { const test = cases.find(value => [...value.books.values()].includes(bookId)); assert(test, "request must target a private fixture book"); return test; }
  async function requested(gate) { await until(() => gate.used, "expected controlled API request did not arrive"); }
  function saved(test, id) { const bookId = test.books.get(id); return memoryLedger ? test.ledger.get(bookId) : test.store.bookDetail(bookId).book.progress; }
  async function stable(test) { let count = test.received.length, last = Date.now(); const deadline = Date.now() + 7000; while (Date.now() - last < 400) { assert(Date.now() < deadline, "progress queue must drain in bounded time"); await new Promise(resolve => setTimeout(resolve, 20)); if (count !== test.received.length) { count = test.received.length; last = Date.now(); } } }
  async function newPage(test, real = false) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.on("pageerror", error => faults.push(error.message));
    // Never pause local unload/keepalive traffic in Playwright interception:
    // its page route callback can disappear when the reader document unloads.
    await page.route(url => url.origin !== base, route => { unexpected.push(`blocked non-fixture origin: ${new URL(route.request().url()).origin}`); return route.abort(); });
    await page.addInitScript(() => {
      window.__progressPackets = []; window.__chapterReads = []; const original = fetch.bind(window);
      window.fetch = async (url, options = {}) => {
        if (String(url).includes("/progress")) __progressPackets.push({ url: String(url), body: typeof options.body === "string" ? JSON.parse(options.body) : options.body, keepalive: Boolean(options.keepalive) });
        const response = await original(url, options);
        if (new URL(String(url), location.href).pathname.includes("/chapters/")) { const json = response.json.bind(response); response.json = async () => { const data = await json(); __chapterReads.push({ index: data.chapter?.index, serverClockMs: data.serverClockMs }); return data; }; }
        return response;
      };
    });
    await page.goto(real ? `${base}/novels/${test.books.get("A")}/1` : `${base}/probe`);
    if (real) await page.waitForFunction(() => !document.documentElement.classList.contains("app-module-loading")); else await page.waitForFunction(() => fixture?.ready);
    return page;
  }
}

async function openChapter(page, id, index) { await page.evaluate(([id, index]) => fixture.page.openChapter(id, index, { skipRoute: true }), [id, index]); await frames(page); }
async function frames(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function scrollRatio(page, ratio) { return page.evaluate(async ratio => { const reader = document.querySelector(".novel-reader-page"), top = reader.getBoundingClientRect().top + scrollY, height = Math.max(1, reader.scrollHeight - innerHeight); scrollTo(0, top + height * ratio); dispatchEvent(new Event("scroll")); await new Promise(resolve => requestAnimationFrame(resolve)); return Math.max(0, Math.min(1, (scrollY - top) / height)); }, ratio); }
async function until(predicate, message) { const deadline = Date.now() + 7000; while (!predicate()) { assert(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 10)); } }
function sendText(res, body, type) { if (res.destroyed) return; res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); }
function sendJson(res, body, status = 200) { if (res.destroyed) return; res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); }
function syntheticText(id, index) { return Array.from({ length: 90 }, (_, paragraph) => `${id}/${index} synthetic paragraph ${paragraph}. 这些正文完全由 fixture 生成，专门用于测量当前阅读位置和请求顺序，不来自实际资料库。`).join("\n\n"); }
function harness(data) {
  return `<!doctype html><meta charset=utf-8><link rel=stylesheet href=/css/foundation.css><link rel=stylesheet href=/modules/novels/styles.css><link rel=stylesheet href=/modules/novels/library.css><link rel=stylesheet href=/modules/novels/detail.css><link rel=stylesheet href=/modules/novels/reader-refinements.css><main><div id=statsRow></div><div id=workGrid></div></main><script type=module>
import {createNovelPage} from '/modules/novels/novel-page.js'; const state={activeView:'novels',novel:{data:${JSON.stringify(data)}}},noop=()=>{};
const api=async(url,options={})=>{const init={...options};if(init.body&&typeof init.body!=='string'){init.body=JSON.stringify(init.body);init.headers={'Content-Type':'application/json'}}const res=await fetch(url,init),data=await res.json();if(!res.ok)throw Object.assign(new Error(data.error||'controlled error'),{code:data.code,statusCode:res.status});return data;};
const page=createNovelPage({api,state,els:{workGrid:document.querySelector('#workGrid'),statsRow:document.querySelector('#statsRow')},formatNumber:String,formatBytes:String,formatDateTime:String,cancelScheduledWorkRendering:noop,disconnectPeopleIndexAutoload:noop,resetProgressiveCoverLoading:noop,hidePersonProfile:noop,setMainHeader:noop,openAdminScript:noop,pushRoute:noop,replaceRoute:noop,syncRouteAfterNavigation:noop});window.fixture={state,page,ready:true};page.enter({skipRoute:true,deferInitialLoad:true});</script>`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runNovelProgressFixture({ legacyNovel: process.argv.includes("--legacy-novel"), legacyClockSlot: process.argv.includes("--legacy-clock-slot"), memoryLedger: process.argv.includes("--memory-ledger"), casePattern: process.argv.find(value => value.startsWith("--case="))?.slice(7) || "" });
