import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Actual /novels index/standalone host and createNovelPage in Chromium.
// Private loopback synthetic books, text, catalog and progress receipts only.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(root, "public");

export async function runNovelReaderFixture({ legacyNovel = false, legacyHost = false, sourceOverrides = {}, casePattern = "" } = {}) {
  const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"]
    .filter(Boolean).find(value => fs.existsSync(value));
  assert(executablePath, "Chrome or Edge required for private novel browser fixture");
  const overrides = new Map(sourceOverrides instanceof Map ? sourceOverrides : Object.entries(sourceOverrides));
  for (const [enabled, relative] of [[legacyNovel, "public/modules/novels/novel-page.js"], [legacyHost, "public/js/standalone-host.js"]]) {
    if (!enabled) continue;
    const result = spawnSync("git", ["show", `HEAD:${relative}`], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); overrides.set(`/${relative.slice(7)}`, result.stdout);
  }
  const held = new Set(), requests = new Map(), progressWrites = [], faults = [], unexpected = [];
  let browser = null, checks = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture"), key = `${url.pathname}${url.search}`;
    requests.set(key, (requests.get(key) || 0) + 1);
    try {
      const progress = req.method === "POST" && /^\/api\/novels\/[AB]\/progress$/.test(url.pathname);
      assert(req.method === "GET" || progress, `unmodelled fixture mutation: ${req.method} ${key}`);
      let body = null;
      if (progress) { let input = ""; for await (const chunk of req) input += chunk; body = JSON.parse(input); progressWrites.push({ bookId: url.pathname.split("/")[3], ...body }); }
      const gate = [...held].find(value => !value.used && value.match(url, req));
      if (gate) { gate.used = true; gate.url = key; gate.body = body; res.once("close", () => { gate.closed = true; }); gate.requestedResolve(); await gate.promise; if (gate.error) { sendJson(res, { error: gate.error }, 503); return; } if (gate.reply) { sendJson(res, gate.reply); return; } }
      if (url.pathname === "/probe") { sendText(res, harness(), "text/html; charset=utf-8"); return; }
      if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      if (progress) { sendJson(res, { progress: { ...body, updatedAt: "2026-01-01T00:00:00Z" } }); return; }
      const chapterMatch = /^\/api\/novels\/([AB])\/chapters\/([123])$/.exec(url.pathname);
      if (chapterMatch) { sendJson(res, chapterResponse(chapterMatch[1], Number(chapterMatch[2]))); return; }
      const catalogMatch = /^\/api\/novels\/([AB])\/catalog$/.exec(url.pathname);
      if (catalogMatch) { const id = catalogMatch[1]; sendJson(res, { sourceRealm: book(id).sourceRealm, catalogRevision: book(id).catalogRevision, chapters: [1, 2, 3].map(index => chapter(id, index)), total: 3 }); return; }
      const bookMatch = /^\/api\/novels\/([AB])$/.exec(url.pathname);
      if (bookMatch) { sendJson(res, { serverClockMs: Date.now(), book: book(bookMatch[1]), chapterTotal: 3 }); return; }
      if (url.pathname === "/api/novels") { sendJson(res, libraryData()); return; }
      if (url.pathname === "/api/modules") { sendJson(res, { product: { id: "suite" }, modules: [] }); return; }
      if (url.pathname.startsWith("/api/")) { unexpected.push(key); sendJson(res, { error: "unmodelled synthetic API" }, 404); return; }
      if (url.pathname.startsWith("/synthetic/")) { sendText(res, '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="#729b7c"/></svg>', "image/svg+xml", "public, max-age=86400"); return; }
      if (overrides.has(url.pathname)) { sendText(res, overrides.get(url.pathname), "text/javascript"); return; }
      const target = /^\/novels?(?:\/|$)/.test(url.pathname) ? path.join(publicRoot, "index.html") : path.resolve(publicRoot, url.pathname.replace(/^\/+/, ""));
      assert(target.startsWith(`${publicRoot}${path.sep}`), "static fixture paths must stay inside public");
      const type = target.endsWith(".html") ? "text/html; charset=utf-8" : target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : target.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";
      sendText(res, await fs.promises.readFile(target), type);
    } catch (error) { unexpected.push(`${key}: ${error.message}`); if (!res.destroyed) sendJson(res, { error: error.message }, 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  const run = async (name, task) => { if (casePattern && !name.includes(casePattern)) return; await task(); checks++; console.log(`PASS ${name}`); };
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    for (const ignoreAbort of [true, false]) {
      const transport = ignoreAbort ? "ignore-abort" : "normal";
      await run(`library refresh preserves 1000 cards and newest filters ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          await seedLibrary(page, 1000);
          const old = hold(url => url.pathname === "/api/novels" && url.searchParams.get("sort") === "title" && !url.searchParams.has("category"), "obsolete library error");
          await measureLibraryRefresh(page, () => page.locator(".novel-sort").selectOption("title")); await requested(old);
          assert.equal(await preservedLibrary(page), true, "starting a sort request must preserve all mounted cards");
          assert((await page.evaluate(() => fixture.refreshElements)) <= 8, "pending refresh must only build the small footer, not 1000 card trees");
          assert.equal(await page.locator(".novel-library-results").getAttribute("aria-busy"), "true");
          assert.equal(await page.locator(".novel-results-count").textContent(), "正在读取…");
          assert.equal(await page.locator(".novel-library-autoload button").count(), 0, "pending replacement cannot append the previous query");
          const current = hold(url => url.pathname === "/api/novels" && url.searchParams.get("category") === "Other", "", libraryPage(48, "Other"));
          await page.locator('[data-novel-category="Other"]').click(); await requested(current);
          assert.equal(await preservedLibrary(page), true, "changing category while sorting must still preserve the existing cards");
          assert.equal(await page.locator('[data-novel-category="Other"]').getAttribute("aria-pressed"), "true");
          assert.equal(await page.locator('[data-novel-category="all"]').getAttribute("aria-pressed"), "false");
          assert.equal(await page.locator(".novel-results-heading h2").textContent(), "Other");
          assert.equal(await page.locator(".novel-sort").inputValue(), "title");
          await finishOld(page, old, ignoreAbort);
          assert.equal(await preservedLibrary(page), true, "obsolete errors cannot rebuild or clear the latest loading view");
          assert(!(await page.locator("#workGrid").textContent()).includes("obsolete library error"));
          await settle(page, current);
          assert.equal(await page.locator(".novel-book-row").count(), 48);
          assert.equal(await page.locator(".novel-library-results").getAttribute("aria-busy"), "false");
          assert.equal(await page.evaluate(() => fixture.cards.every(card => !card.isConnected)), true, "current response replaces the preserved previous result exactly once");
        } finally { await page.close(); }
      });

      await run(`library refresh failure retry and reader layout ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          await seedLibrary(page, 1000, 1050);
          const failed = hold(url => url.pathname === "/api/novels", "controlled library error");
          await page.locator(".novel-sort").selectOption("title"); await requested(failed); await settle(page, failed);
          assert.equal(await page.locator(".novel-library-results").getAttribute("aria-busy"), "false");
          assert.equal(await page.locator(".novel-status-line").textContent(), "controlled library error");
          const retry = hold(url => url.pathname === "/api/novels", "", libraryPage(48));
          await page.locator(".novel-library-autoload button").filter({ hasText: "重新读取" }).click(); await requested(retry);
          assert.equal(new URL(retry.url, base).searchParams.get("offset"), "0", "retrying a replacement must read the new query's first page, not append after old cards");
          assert.equal(await page.locator(".novel-status-line").textContent(), "正在读取小说书库");
          assert.equal(await page.locator(".novel-library-autoload button").count(), 0);
          await settle(page, retry);
          assert.equal(await page.locator(".novel-book-row").count(), 48);
          const detail = hold(url => url.pathname === "/api/novels/A");
          await page.evaluate(() => { fixture.beforeBook = document.querySelector(".novel-library"); fixture.pending.push(fixture.page.openBook("A", { skipRoute: true })); }); await requested(detail);
          assert.equal(await page.evaluate(() => fixture.beforeBook.isConnected), false, "book navigation must use its own layout rather than the pending-library patch");
          await settle(page, detail); await detailTitle(page, "Book A");
          const mine = hold(url => url.pathname === "/api/novels" && url.searchParams.get("reading") === "1");
          await page.locator(".novel-section-menu button").filter({ hasText: /^我的$/ }).click(); await requested(mine);
          assert.equal(await page.locator(".novel-detail").count(), 0);
          assert.equal(await page.locator(".novel-home-loading").count(), 1, "a changed library layout must build its loading shell");
          await settle(page, mine);
          assert.equal(await page.locator(".novel-recent-item").count(), 2);
          assert.equal(await page.locator(".novel-sort").count(), 0, "mine mode cannot retain books-only sorting controls");
          const search = hold(url => url.pathname === "/api/novels" && url.searchParams.get("q") === "Synthetic query", "", libraryPage(48));
          await page.locator(".novel-section-search input").fill("Synthetic query");
          await page.locator(".novel-section-search button").click(); await requested(search);
          assert.equal(await page.locator(".novel-recent").count(), 0, "search cannot retain the previous mine layout");
          await settle(page, search);
          assert.equal(await page.locator(".novel-sort").count(), 1);
          assert.equal(await page.locator(".novel-results-heading h2").textContent(), "“Synthetic query”的搜索结果");
          assert.equal(await page.locator(".novel-controls button").filter({ hasText: "清除搜索" }).count(), 1);
        } finally { await page.close(); }
      });

      await run(`library refresh append loading and observer ownership ${transport}`, async () => {
        const page = await newPage({ ignoreAbort, manualObservers: true });
        try {
          await seedLibrary(page, 48, 50);
          await page.evaluate(() => { fixture.cards = [...document.querySelectorAll(".novel-book-row")]; fixture.observer = [...__observers].find(value => value.targets.size); });
          assert.equal(await page.evaluate(() => Boolean(fixture.observer)), true, "loaded library must arm its autoload sentinel");
          const append = hold(url => url.pathname === "/api/novels" && url.searchParams.get("offset") === "48", "", libraryPage(2, "Fixture", 48, 50));
          await page.evaluate(() => fixture.observer.callback([{ isIntersecting: true }])); await requested(append);
          assert.equal(await page.locator(".novel-library-results").getAttribute("aria-busy"), "true");
          assert.equal(await page.locator(".novel-library-autoload button").count(), 0);
          const reads = countRequests(url => url.pathname === "/api/novels");
          await page.evaluate(() => fixture.observer.callback([{ isIntersecting: true }])); await tick(page);
          assert.equal(countRequests(url => url.pathname === "/api/novels"), reads, "disconnected or already consumed sentinel cannot duplicate an append");
          await settle(page, append);
          assert.equal(await page.locator(".novel-book-row").count(), 50);
          assert.equal(await page.evaluate(() => fixture.cards.every((card, index) => card === document.querySelectorAll(".novel-book-row")[index])), true, "append preserves earlier cards");
          assert.equal(await page.locator(".novel-library-results").getAttribute("aria-busy"), "false");
          assert.equal(await page.evaluate(() => [...__observers].filter(value => value.targets.size).length), 0, "complete list does not rearm the observer");
        } finally { await page.close(); }
      });

      await run(`library pagination stable duplicates use raw offsets ${transport}`, async () => {
        const page = await newPage({ ignoreAbort, manualObservers: true });
        try {
          await readLibraryPage(page, { ...libraryPage(48, "Fixture", 0, 54), nextOffset: 48, listRevision: "stable-list" });
          await page.evaluate(() => { fixture.cards = [...document.querySelectorAll(".novel-book-row")]; });
          const middle = { ...libraryPage(4, "Fixture", 48, 54), nextOffset: 52, listRevision: "stable-list" };
          middle.books[0] = { ...book("Fixture-47"), title: "Updated overlapping book", coverUrl: "", category: "Fixture" };
          const append = hold(url => url.pathname === "/api/novels", "", middle);
          await startLibraryRead(page, { append: true }); await requested(append);
          assert.equal(new URL(append.url, base).searchParams.get("offset"), "48");
          await settle(page, append);
          assert.equal(await page.locator(".novel-book-row").count(), 51, "stable append deduplicates repeated book identities");
          assert.equal(await page.evaluate(() => fixture.cards.slice(0, 47).every((card, index) => card === document.querySelectorAll(".novel-book-row")[index])), true, "deduplicated append preserves unaffected prior rows");
          assert.equal(await page.locator(".novel-book-title").nth(47).textContent(), "Updated overlapping book", "overlapping identity refreshes its metadata rather than leaving a stale card");
          const last = hold(url => url.pathname === "/api/novels", "", { ...libraryPage(2, "Fixture", 52, 54), nextOffset: 54, listRevision: "stable-list" });
          await startLibraryRead(page, { append: true }); await requested(last);
          assert.equal(new URL(last.url, base).searchParams.get("offset"), "52", "wire offset follows consumed rows rather than the deduplicated card count");
          await settle(page, last);
          assert.equal(await page.locator(".novel-book-row").count(), 53);
          assert.equal(await page.evaluate(() => fixture.state.novel.hasMore), false, "raw total completion cannot loop merely because unique count is smaller");
        } finally { await page.close(); }
      });

      for (const change of ["revision", "realm"]) await run(`library pagination ${change} change rebuilds the loaded prefix ${transport}`, async () => {
        const page = await newPage({ ignoreAbort, manualObservers: true });
        try {
          const before = { ...libraryPage(48, "Fixture", 0, 50), nextOffset: 48, listRevision: "before-progress", sourceRealm: "realm-before" };
          for (const entry of before.books) entry.sourceRealm = "realm-before";
          await readLibraryPage(page, before);
          await page.evaluate(() => { fixture.cards = [...document.querySelectorAll(".novel-book-row")]; });
          const currentIdentity = { listRevision: change === "revision" ? "after-progress" : "before-progress", sourceRealm: change === "realm" ? "realm-after" : "realm-before" };
          const shifted = { ...libraryPage(2, "Fixture", 48, 50), nextOffset: 50, ...currentIdentity };
          for (const entry of shifted.books) entry.sourceRealm = currentIdentity.sourceRealm;
          shifted.books[0].title = "Discarded shifted tail";
          const append = hold(url => url.pathname === "/api/novels" && url.searchParams.get("offset") === "48", "", shifted);
          const fresh = { ...libraryPage(50, "Fixture", 0, 50), nextOffset: 50, ...currentIdentity };
          for (const entry of fresh.books) entry.sourceRealm = currentIdentity.sourceRealm;
          fresh.books.unshift({ ...fresh.books.pop(), title: "Previously unseen book moved first" });
          const rebase = hold(url => url.pathname === "/api/novels" && url.searchParams.get("offset") === "0" && url.searchParams.get("limit") === "96", "", fresh);
          await startLibraryRead(page, { append: true }); await requested(append); await settle(page, append); await requested(rebase);
          assert.equal(await page.evaluate(() => fixture.cards.every(card => card.isConnected)), true, "mixed-revision tail cannot publish before fresh prefix finishes");
          assert(!(await page.locator("#workGrid").textContent()).includes("Discarded shifted tail"));
          await settle(page, rebase);
          assert.equal(await page.locator(".novel-book-row").count(), 50);
          assert.equal(await page.locator(".novel-book-title").first().textContent(), "Previously unseen book moved first");
          assert.equal(await page.evaluate(() => new Set(fixture.state.novel.data.books.map(value => value.id)).size), 50, "prefix rebase retains every current book exactly once");
          assert.equal(await page.evaluate(() => fixture.state.novel.hasMore), false);
          assert.equal(await page.evaluate(() => fixture.state.novel.loadingMore), false);
          assert.equal(await page.evaluate(() => new Set([...document.querySelectorAll(".novel-book-row")].map(row => JSON.parse(row.dataset.novelBookKey)[0])).size), 1, "rows cannot merge identities from two source realms");
        } finally { await page.close(); }
      });

      await run(`library pagination mine append updates progress on a repeated identity ${transport}`, async () => {
        const page = await newPage({ ignoreAbort, manualObservers: true });
        try {
          const initial = { ...libraryPage(48, "Fixture", 0, 50), nextOffset: 48, listRevision: "mine-list" };
          initial.books[47].progress = { chapterIndex: 1, scrollRatio: .1 };
          await page.evaluate(() => { fixture.state.novel.mode = "mine"; });
          await readLibraryPage(page, initial);
          await page.evaluate(() => { fixture.cards = [...document.querySelectorAll(".novel-recent-item")]; fixture.oldProgress = fixture.cards[47].querySelector("span").textContent; });
          const middle = { ...libraryPage(2, "Fixture", 48, 50), nextOffset: 50, listRevision: "mine-list" };
          middle.books[0] = { ...initial.books[47], progress: { chapterIndex: 3, scrollRatio: .9 } };
          const append = hold(url => url.pathname === "/api/novels", "", middle);
          await startLibraryRead(page, { append: true }); await requested(append); await settle(page, append);
          assert.equal(await page.locator(".novel-recent-item").count(), 49);
          assert.equal(await page.evaluate(() => fixture.cards.slice(0, 47).every((card, index) => card === document.querySelectorAll(".novel-recent-item")[index])), true);
          assert.notEqual(await page.locator(".novel-recent-item span").nth(47).textContent(), await page.evaluate(() => fixture.oldProgress), "repeated mine identity refreshes the displayed reading ratio");
          assert.equal(await page.locator(".novel-recent-item span").nth(47).textContent(), "第 3/3 章 · 全书 96.7%");
          assert.equal(await page.locator(".novel-sort").count(), 0);
        } finally { await page.close(); }
      });

      await run(`library pagination repeated revision changes preserve old data and allow retry ${transport}`, async () => {
        const page = await newPage({ ignoreAbort, manualObservers: true });
        try {
          await readLibraryPage(page, { ...libraryPage(5000, "Fixture", 0, 5100), nextOffset: 5000, listRevision: "original-list" });
          await page.evaluate(() => { fixture.originalLibraryData = fixture.state.novel.data; fixture.cards = [...document.querySelectorAll(".novel-book-row")]; });
          const append = hold(url => url.pathname === "/api/novels" && url.searchParams.get("offset") === "5000", "", { ...libraryPage(48, "Fixture", 5000, 5100), nextOffset: 5048, listRevision: "changed-list" });
          const attempts = Array.from({ length: 3 }, (_, attempt) => ({
            prefix: hold(url => url.pathname === "/api/novels" && url.searchParams.get("offset") === "0" && url.searchParams.get("limit") === "5000", "", { ...libraryPage(5000, "Fixture", 0, 5100), nextOffset: 5000, listRevision: `prefix-${attempt}` }),
            tail: hold(url => url.pathname === "/api/novels" && url.searchParams.get("offset") === "5000", "", { ...libraryPage(48, "Fixture", 5000, 5100), nextOffset: 5048, listRevision: `tail-${attempt}` })
          }));
          const before = countRequests(url => url.pathname === "/api/novels");
          await startLibraryRead(page, { append: true }); await requested(append); await settle(page, append);
          for (const attempt of attempts) {
            await requested(attempt.prefix); await settle(page, attempt.prefix); await requested(attempt.tail); await settle(page, attempt.tail);
            assert.equal(await page.evaluate(() => fixture.state.novel.data === fixture.originalLibraryData), true, "each unstable prefix remains private until all pages share a revision");
          }
          await page.waitForFunction(() => !fixture.state.novel.loadingMore && Boolean(fixture.state.novel.libraryError));
          assert.equal(countRequests(url => url.pathname === "/api/novels"), before + 7, "three bounded prefix attempts cannot spin on a changing library");
          assert.equal(await page.evaluate(() => fixture.cards.every(card => card.isConnected)), true);
          assert.equal(await page.evaluate(() => fixture.state.novel.hasMore), true);
          assert.equal(await page.locator(".novel-library-autoload button").textContent(), "重试加载");
          assert.equal(await page.evaluate(() => [...__observers].filter(value => value.targets.size).length), 0, "unstable-prefix failure waits for explicit retry");
          const retry = hold(url => url.pathname === "/api/novels", "", { ...libraryPage(48, "Fixture", 5000, 5100), nextOffset: 5048, listRevision: "original-list" });
          await page.locator(".novel-library-autoload button").click(); await requested(retry);
          assert.equal(new URL(retry.url, base).searchParams.get("offset"), "5000", "failed rebases do not advance the saved raw offset");
          await settle(page, retry);
          assert.equal(await page.locator(".novel-book-row").count(), 5048);
          assert.equal(await page.evaluate(() => fixture.state.novel.libraryError), "");
        } finally { await page.close(); }
      });

      for (const target of ["query", "reader"]) await run(`library pagination pending rebase yields to ${target} ${transport}`, async () => {
        const page = await newPage({ ignoreAbort, manualObservers: true });
        try {
          await readLibraryPage(page, { ...libraryPage(48, "Fixture", 0, 50), nextOffset: 48, listRevision: "original-list" });
          const append = hold(url => url.pathname === "/api/novels" && url.searchParams.get("offset") === "48", "", { ...libraryPage(2, "Fixture", 48, 50), nextOffset: 50, listRevision: "changed-list" });
          const rebase = hold(url => url.pathname === "/api/novels" && url.searchParams.get("offset") === "0" && url.searchParams.get("limit") === "96", "", { ...libraryPage(50), nextOffset: 50, listRevision: "changed-list" });
          await startLibraryRead(page, { append: true }); await requested(append); await settle(page, append); await requested(rebase);
          if (target === "reader") {
            await openChapter(page, "B", 2); const before = await rememberReader(page); await finishOld(page, rebase, ignoreAbort); await assertReaderPreserved(page, before);
          } else {
            const current = hold(url => url.pathname === "/api/novels" && url.searchParams.get("sort") === "title", "", { ...libraryPage(3, "Other"), nextOffset: 3, listRevision: "new-query" });
            await page.locator(".novel-sort").selectOption("title"); await requested(current); await settle(page, current);
            await page.evaluate(() => { fixture.currentShell = document.querySelector(".novel-library"); fixture.currentFirst = document.querySelector(".novel-book-row"); });
            await finishOld(page, rebase, ignoreAbort);
            assert.equal(await page.evaluate(() => fixture.currentShell === document.querySelector(".novel-library") && fixture.currentFirst === document.querySelector(".novel-book-row")), true);
            assert.equal(await page.locator(".novel-book-row").count(), 3);
            assert.equal(await page.locator(".novel-sort").inputValue(), "title");
          }
          assert(await page.evaluate(url => __transport.aborted.includes(url), rebase.url), "new navigation cancels the entire obsolete prefix request owner");
        } finally { await page.close(); }
      });

      for (const [initial, oldPath, target, newPath, error, back] of [
        ["/novels/A", "/api/novels/A", "/novels/B", "/api/novels/B", "", false],
        ["/novels/A/1", "/api/novels/A/chapters/1", "/novels/B/2", "/api/novels/B/chapters/2", "", false],
        ["/novels/A/1", "/api/novels/A/chapters/1", "/novels/B/2", "/api/novels/B/chapters/2", "old novel error", false],
        ["/novels/A/1", "/api/novels/A/chapters/1", "/novels", "/api/novels", "", false],
        ["/novels/A/1", "/api/novels/A/chapters/1", "/novels", "/api/novels", "old novel error", false],
        ["/novels/A", "/api/novels/A", "/novels", "/api/novels", "", true]
      ]) await run(`host bootstrap ${initial} to ${back ? "back" : target} ${error ? "error" : "success"} ${transport}`, async () => {
        const old = hold(url => url.pathname === oldPath, error), current = hold(url => url.pathname === newPath);
        const page = await newPage({ real: true, ignoreAbort, route: initial, waitReady: false, initialBack: back });
        try {
          await requested(old); const token = await page.evaluate(() => __documentToken);
          if (back) await page.goBack({ waitUntil: "commit" }); else await navigateRoute(page, target);
          await requested(current, 2000); await settle(page, current); await ready(page);
          if (target === "/novels/B/2") await readerTitle(page, "B", 2); else if (target === "/novels/B") await detailTitle(page, "Book B"); else await page.locator(".novel-book-row").first().waitFor();
          assert.equal(await page.evaluate(() => __documentToken), token, "history must stay in the initial document");
          await finishOld(page, old, ignoreAbort); assert.equal(new URL(page.url()).pathname, target);
          if (target === "/novels/B/2") { assert.equal(await page.locator(".novel-reader-paper h1").textContent(), "B Chapter 2"); assert((await page.locator(".novel-reader-meta").last().textContent()).includes("Book B")); }
          else if (target === "/novels/B") assert.equal(await page.locator(".novel-detail-title").textContent(), "Book B");
          else { assert.equal(await page.locator(".novel-reader-page").count(), 0); assert.equal(await page.locator(".novel-detail").count(), 0); }
          assert(!(await page.locator("#workGrid").textContent()).includes("old novel error"));
          assert(await page.evaluate(path => __transport.aborted.some(url => url.split("?")[0] === path), oldPath), "new route must abort the obsolete foreground read");
        } finally { await page.close(); }
      });

      for (const error of ["", "old novel error"]) {
        const result = error ? "error" : "success";
        await run(`reader navigation old ${result} keeps newest loading ${transport}`, async () => {
          const page = await newPage({ ignoreAbort });
          try {
            await openChapter(page, "A", 1); const old = hold(url => url.pathname === "/api/novels/A/chapters/3", error);
            await launchChapter(page, "A", 3); await requested(old); const current = hold(url => url.pathname === "/api/novels/B/chapters/2");
            await launchChapter(page, "B", 2); await requested(current); await finishOld(page, old, ignoreAbort);
            assert.deepEqual(await snapshot(page), { book: "A", chapter: 1, loading: true, status: "正在翻开章节" }, "old reader error/finally cannot release the new request owner");
            assert.equal(await page.locator(".novel-reader-page").getAttribute("aria-busy"), "true");
            await settle(page, current); await readerTitle(page, "B", 2); assert.deepEqual(await snapshot(page), { book: "B", chapter: 2, loading: false, status: "" });
          } finally { await page.close(); }
        });

        await run(`library pending cannot replace new reader ${result} ${transport}`, async () => {
          const page = await newPage({ ignoreAbort });
          try {
            const old = hold(url => url.pathname === "/api/novels", error); await page.evaluate(() => { fixture.pending.push(fixture.page.loadNovels({ skipRoute: true }).catch(error => fixture.rejections.push(error.message))); }); await requested(old);
            await openChapter(page, "B", 2); const before = await rememberReader(page); await finishOld(page, old, ignoreAbort); await assertReaderPreserved(page, before);
            assert.deepEqual(await snapshot(page), { book: "B", chapter: 2, loading: false, status: "" });
          } finally { await page.close(); }
        });

        await run(`old next chapter prefetch preserves new reader ${result} ${transport}`, async () => {
          const page = await newPage({ ignoreAbort });
          try {
            const prefetch = hold(url => url.pathname === "/api/novels/A/chapters/2", error); await openChapter(page, "A", 1); await requested(prefetch);
            await openChapter(page, "B", 2); const before = await rememberReader(page);
            await finishOld(page, prefetch, ignoreAbort); await assertReaderPreserved(page, before); assert.deepEqual(await snapshot(page), { book: "B", chapter: 2, loading: false, status: "" });
            const retry = hold(url => url.pathname === "/api/novels/A/chapters/2"); await openChapter(page, "A", 1); await requested(retry, 2000);
            await settle(page, retry); // A cancelled prefetch must not seed a later cache hit.
          } finally { await page.close(); }
        });

        await run(`late progress receipt preserves new chapter identity ${result} ${transport}`, async () => {
          const page = await newPage({ ignoreAbort });
          try {
            const writesBefore = progressWrites.length;
            const old = hold((url, req) => req.method === "POST" && url.pathname === "/api/novels/A/progress", error);
            await openChapter(page, "A", 1); await requested(old);
            assert.deepEqual({ sourceRealm: old.body.sourceRealm, catalogRevision: old.body.catalogRevision, chapterId: old.body.chapterId, chapterIndex: old.body.chapterIndex }, { sourceRealm: "server:fixture", catalogRevision: "rev-A", chapterId: "A-1", chapterIndex: 1 });
            await openChapter(page, "B", 2); const before = await rememberReader(page); await settle(page, old); await assertReaderPreserved(page, before);
            await page.waitForFunction(() => fixture.state.novel.book?.progress?.chapterId === "B-2");
            assert.deepEqual(await page.evaluate(() => ({ book: fixture.state.novel.book.id, id: fixture.state.novel.book.progress.chapterId, revision: fixture.state.novel.book.progress.catalogRevision })), { book: "B", id: "B-2", revision: "rev-B" });
            assert.deepEqual(await snapshot(page), { book: "B", chapter: 2, loading: false, status: "" });
            await until(() => progressWrites.slice(writesBefore).some(write => write.bookId === "B" && write.chapterId === "B-2" && write.catalogRevision === "rev-B" && write.sourceRealm === "server:fixture"), "new debounce must send the current chapter's exact identity");
          } finally { await page.close(); }
        });
      }

      await run(`adjacent chapter adopts prefetch single flight and cancellation ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          const prefetch = hold(url => url.pathname === "/api/novels/A/chapters/2"); await openChapter(page, "A", 1); await requested(prefetch);
          const before = countRequests(prefetch.match); await page.evaluate(() => { fixture.pending.push(fixture.page.openAdjacent(1)); }); await tick(page);
          assert.equal(countRequests(prefetch.match), before, "adjacent chapter must adopt its matching prefetch instead of duplicating it");
          assert.equal(await page.evaluate(() => fixture.state.novel.loading), true); await openChapter(page, "B", 2); await finishOld(page, prefetch, ignoreAbort);
          assert.deepEqual(await snapshot(page), { book: "B", chapter: 2, loading: false, status: "" });
          assert(await page.evaluate(() => __transport.aborted.some(url => url.split("?")[0] === "/api/novels/A/chapters/2")), "adopted prefetch must gain foreground cancellation ownership");
        } finally { await page.close(); }
      });

      await run(`formal chapter restore starts fresh instead of joining prefetch ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          const prefetch = hold(url => url.pathname === "/api/novels/A/chapters/2"); await openChapter(page, "A", 1); await requested(prefetch);
          const before = countRequests(prefetch.match), current = hold(prefetch.match);
          await page.evaluate(() => { fixture.pending.push(fixture.page.openChapter("A", 2, { skipRoute: true, restoreProgress: true })); });
          await requested(current, 2000); assert.equal(countRequests(prefetch.match), before + 1, "formal restore must issue its own fresh chapter GET before obsolete prefetch releases");
          await settle(page, current); await readerTitle(page, "A", 2); await finishOld(page, prefetch, ignoreAbort);
          assert.deepEqual(await snapshot(page), { book: "A", chapter: 2, loading: false, status: "" });
          assert(await page.evaluate(() => __transport.aborted.some(url => url.split("?")[0] === "/api/novels/A/chapters/2")), "formal restore must cancel the obsolete matching prefetch");
        } finally { await page.close(); }
      });

      await run(`obsolete reader scroll frame cannot scroll new chapter ${transport}`, async () => {
        const page = await newPage({ ignoreAbort, manualFrames: true });
        try {
          const reply = chapterResponse("A", 1); reply.book.progress = { chapterIndex: 1, chapterId: "A-1", catalogRevision: "rev-A", scrollRatio: .5 };
          const old = hold(url => url.pathname === "/api/novels/A/chapters/1", "", reply);
          await launchChapter(page, "A", 1); await requested(old); old.release(); await readerTitle(page, "A", 1);
          await page.evaluate(() => { __oldScrollFrame = [...__heldFrames.values()][0]; }); assert(await page.evaluate(() => typeof __oldScrollFrame === "function"), "A must have scheduled a scroll restoration frame");
          await openChapter(page, "B", 2); await page.evaluate(() => __oldScrollFrame(performance.now()));
          assert.equal(await page.evaluate(() => window.scrollY), 0, "an already queued obsolete A frame must not apply A's .5 ratio to B");
          await page.evaluate(() => { __holdFrames = false; const frames = [...__heldFrames.values()]; __heldFrames.clear(); for (const frame of frames) frame(performance.now()); }); await tick(page);
          assert.equal(await page.evaluate(() => window.scrollY), 0); assert.deepEqual(await snapshot(page), { book: "B", chapter: 2, loading: false, status: "" });
        } finally { await page.close(); }
      });

      await run(`pagehide during pending server scroll restore never saves zero ${transport}`, async () => {
        const page = await newPage({ ignoreAbort, manualFrames: true });
        try {
          const writesBefore = progressWrites.length, reply = chapterResponse("A", 1);
          reply.book.progress = { chapterIndex: 1, chapterId: "A-1", catalogRevision: "rev-A", scrollRatio: .75 };
          const current = hold(url => url.pathname === "/api/novels/A/chapters/1", "", reply);
          await launchChapter(page, "A", 1); await requested(current); current.release(); await readerTitle(page, "A", 1);
          assert((await page.evaluate(() => __heldFrames.size)) > 0, "server progress must have a pending restoration frame");
          await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide")));
          await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 250)));
          assert.equal(progressWrites.length, writesBefore, "pending .75 server progress must not be replaced by the not-yet-restored zero scroll position");
          assert.equal(await page.evaluate(() => fixture.state.novel.book.progress.scrollRatio), .75);
          await page.evaluate(() => { __holdFrames = false; const frames = [...__heldFrames.values()]; __heldFrames.clear(); for (const frame of frames) frame(performance.now()); }); await tick(page);
          await until(() => progressWrites.length > writesBefore, "restored visible progress should subsequently save");
          assert(progressWrites.slice(writesBefore).every(write => write.scrollRatio > .7), "the first automatic save must use the restored position");
        } finally { await page.close(); }
      });

      await run(`leaving reader flushes measured progress without late zero writes ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          const initialWrites = progressWrites.length; await openChapter(page, "A", 1); await until(() => progressWrites.length > initialWrites, "initial reader progress should settle before leave");
          await rememberReader(page); const before = progressWrites.length;
          await page.evaluate(() => { fixture.page.resetReader?.(); fixture.state.activeView = "gallery"; document.querySelector("#workGrid").replaceChildren(document.createElement("section")); dispatchEvent(new PageTransitionEvent("pagehide")); });
          await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 700)));
          const writes = progressWrites.slice(before);
          assert(writes.length >= 1 && writes.length <= 2, "leave sends one captured position, with at most one keepalive duplicate of an active normal write");
          assert(writes.every(write => write.scrollRatio > 0), "leave must capture visible reader ratio before unmount rather than a delayed zero ratio");
          if (writes.length === 2) assert.deepEqual(writes[1], writes[0], "unload duplicate must retain the exact captured position and sequence");
          if (!legacyNovel) {
            assert(Number.isSafeInteger(writes[0].progressSequence));
            assert(Number.isSafeInteger(writes[0].progressSessionStartedAt));
            assert.match(writes[0].progressSessionId, /^[0-9a-f-]{36}$/);
          }
          assert.deepEqual({ book: writes[0].bookId, chapter: writes[0].chapterId, revision: writes[0].catalogRevision }, { book: "A", chapter: "A-1", revision: "rev-A" });
        } finally { await page.close(); }
      });
    }
    assert(checks > 0, `no novel fixture cases matched: ${casePattern}`); assert.deepEqual(faults, [], "Chromium page errors must not be hidden"); assert.deepEqual(unexpected, [], "fixture must use only modelled loopback endpoints and static sources");
    console.log(`Novel reader fixture passed (${checks} cases; private Chromium, actual novel host and synthetic text/progress)`); return { checks };
  } finally { for (const gate of held) gate.release(); if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

  function countRequests(match) { return [...requests].filter(([url]) => match(new URL(url, base))).reduce((sum, [, count]) => sum + count, 0); }
  function hold(match, error = "", reply = null) { let release, requestedResolve; const gate = { match, error, reply, used: false, closed: false, promise: new Promise(resolve => { release = resolve; }), requested: new Promise(resolve => { requestedResolve = resolve; }), release, requestedResolve }; held.add(gate); return gate; }
  async function requested(gate, timeout = 5000) { let timer; try { await Promise.race([gate.requested, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`new request did not start before obsolete I/O finished (${timeout}ms)`)), timeout); })]); } finally { clearTimeout(timer); } }
  async function settle(page, gate) { const before = await page.evaluate(url => __transport.settled.filter(item => item.url === url).length, gate.url); gate.release(); await page.waitForFunction(({ url, before }) => __transport.settled.filter(item => item.url === url).length > before, { url: gate.url, before }, { timeout: 5000 }); await tick(page); }
  async function finishOld(page, gate, ignoreAbort) { if (ignoreAbort) await settle(page, gate); else { await until(() => gate.closed, "normal transport must close the obsolete foreground read"); gate.release(); await tick(page); } }
  async function newPage({ real = false, ignoreAbort = true, route = "/novels", waitReady = true, initialBack = false, manualFrames = false, manualObservers = false } = {}) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.on("pageerror", error => faults.push(error.message));
    await page.addInitScript(({ ignoreAbort, initialBack, manualFrames, manualObservers }) => {
      window.__documentToken = Math.random(); window.__transport = { settled: [], aborted: [] }; const originalFetch = window.fetch.bind(window);
      window.__heldFrames = new Map(); window.__holdFrames = manualFrames; let heldFrameId = 0;
      const requestFrame = window.requestAnimationFrame.bind(window), cancelFrame = window.cancelAnimationFrame.bind(window);
      window.requestAnimationFrame = callback => { if (!__holdFrames) return requestFrame(callback); const id = --heldFrameId; __heldFrames.set(id, callback); return id; };
      window.cancelAnimationFrame = id => { if (id < 0) __heldFrames.delete(id); else cancelFrame(id); };
      window.__observers = new Set();
      if (manualObservers) window.IntersectionObserver = class {
        constructor(callback) { this.callback = callback; this.targets = new Set(); __observers.add(this); }
        observe(target) { this.targets.add(target); }
        disconnect() { this.targets.clear(); }
      };
      window.fetch = async (url, options = {}) => {
        const key = new URL(String(url), location.href), relative = `${key.pathname}${key.search}`; options.signal?.addEventListener("abort", () => __transport.aborted.push(relative), { once: true });
        const response = await originalFetch(url, ignoreAbort ? { ...options, cache: "no-store", signal: undefined } : options), originalJson = response.json.bind(response);
        response.json = async () => { try { return await originalJson(); } finally { __transport.settled.push({ url: relative, ok: response.ok }); } }; return response;
      };
      if (initialBack && location.pathname === "/novels/A") { const deepLink = `${location.pathname}${location.search}`; history.replaceState(null, "", "/novels"); history.pushState(null, "", deepLink); }
    }, { ignoreAbort, initialBack, manualFrames, manualObservers });
    await page.goto(real ? `${base}${route}` : `${base}/probe`, { waitUntil: waitReady ? "load" : "commit" });
    if (waitReady) { if (real) await ready(page); else await page.waitForFunction(() => Boolean(window.fixture?.ready)); } return page;
  }
  async function readLibraryPage(page, data, options = {}) {
    const gate = hold(url => url.pathname === "/api/novels", "", data);
    await startLibraryRead(page, options); await requested(gate); await settle(page, gate);
    return gate;
  }
}

async function ready(page) { await page.waitForFunction(() => !document.documentElement.classList.contains("app-module-loading"), null, { timeout: 5000 }); }
async function tick(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function until(predicate, message) { const deadline = Date.now() + 5000; while (!predicate()) { assert(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 10)); } }
async function navigateRoute(page, target) { await page.evaluate(url => { history.pushState(null, "", url); dispatchEvent(new PopStateEvent("popstate")); }, target); }
async function startLibraryRead(page, options = {}) { await page.evaluate(options => { fixture.pending.push(fixture.page.loadNovels({ skipRoute: true, ...options }).catch(error => fixture.rejections.push(error.message))); }, options); }
async function openChapter(page, id, index) { await page.evaluate(([id, index]) => fixture.page.openChapter(id, index, { skipRoute: true }), [id, index]); await readerTitle(page, id, index); }
async function launchChapter(page, id, index) { await page.evaluate(([id, index]) => { fixture.pending.push(fixture.page.openChapter(id, index, { skipRoute: true })); }, [id, index]); }
async function detailTitle(page, title) { await page.waitForFunction(title => document.querySelector(".novel-detail-title")?.textContent === title, title, { timeout: 5000 }); }
async function readerTitle(page, id, index) { await page.waitForFunction(([id, index]) => document.querySelector(".novel-reader-paper h1")?.textContent === `${id} Chapter ${index}`, [id, index], { timeout: 5000, polling: 25 }); }
async function snapshot(page) { return page.evaluate(() => ({ book: fixture.state.novel.book?.id ?? null, chapter: fixture.state.novel.chapter?.index ?? null, loading: fixture.state.novel.loading, status: fixture.state.novel.status })); }
async function rememberReader(page) { await tick(page); await page.evaluate(() => { fixture.reader = document.querySelector(".novel-reader-page"); fixture.firstParagraph = fixture.reader.querySelector(".novel-reader-content p"); window.scrollTo(0, 420); }); await tick(page); const before = await page.evaluate(() => ({ scroll: window.scrollY, route: `${location.pathname}${location.search}` })); assert(before.scroll > 0, "reader preservation must measure nonzero document scroll"); return before; }
async function assertReaderPreserved(page, before) { assert.equal(await page.evaluate(() => fixture.reader === document.querySelector(".novel-reader-page") && fixture.firstParagraph === document.querySelector(".novel-reader-content p")), true, "obsolete response must preserve mounted current text"); assert.deepEqual(await page.evaluate(() => ({ scroll: window.scrollY, route: `${location.pathname}${location.search}` })), before, "obsolete response must preserve current route/scroll"); }
async function seedLibrary(page, count, total = count) {
  await page.evaluate(data => {
    Object.assign(fixture.state.novel, { mode: "books", category: "all", query: "", author: "", sort: "updated", data, loading: false, loadingMore: false, status: "", libraryError: "", hasMore: data.books.length < data.total });
    fixture.page.renderView();
    fixture.shell = document.querySelector(".novel-library");
    fixture.cards = [...document.querySelectorAll(".novel-book-row")];
  }, libraryPage(count, "Fixture", 0, total));
}
async function measureLibraryRefresh(page, action) {
  await page.evaluate(() => {
    fixture.refreshElements = 0; fixture.originalCreateElement = document.createElement;
    document.createElement = function (...args) { fixture.refreshElements++; return fixture.originalCreateElement.apply(this, args); };
  });
  try { await action(); }
  finally { await page.evaluate(() => { document.createElement = fixture.originalCreateElement; }); }
}
async function preservedLibrary(page) { return page.evaluate(() => fixture.shell === document.querySelector(".novel-library") && fixture.cards.every((card, index) => card.isConnected && card === document.querySelectorAll(".novel-book-row")[index])); }
function sendText(res, body, type, cache = "no-store") { if (res.destroyed) return; res.writeHead(200, { "Content-Type": type, "Cache-Control": cache }); res.end(body); }
function sendJson(res, body, status = 200) { if (res.destroyed) return; res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); }
function book(id) { return { id, title: `Book ${id}`, author: "Synthetic", category: "Fixture", sourceRealm: "server:fixture", catalogRevision: `rev-${id}`, chapterCount: 3, charCount: 18000, sizeBytes: 54000, coverUrl: `/synthetic/${id}.svg`, progress: null }; }
function chapter(id, index) { return { id: `${id}-${index}`, bookId: id, index, title: `${id} Chapter ${index}`, charCount: 6000, content: Array.from({ length: 80 }, (_, paragraph) => `Synthetic ${id} chapter ${index} paragraph ${paragraph + 1}. 这是完全合成的小说正文，用于验证阅读页面与滚动位置，不来自真实资料库。`).join("\n\n") }; }
function chapterResponse(id, index) { return { serverClockMs: Date.now(), book: book(id), sourceRealm: "server:fixture", catalogRevision: `rev-${id}`, chapter: chapter(id, index), chapters: [], chapterTotal: 3, prev: index > 1 ? chapter(id, index - 1) : null, next: index < 3 ? chapter(id, index + 1) : null }; }
function libraryData() { return { books: [book("A"), book("B")], total: 2, limit: 48, offset: 0, summary: { totals: { books: 2, chapters: 6, chars: 36000, bytes: 108000 }, categories: [], recent: [] } }; }
function libraryPage(count, category = "Fixture", offset = 0, total = count) {
  return {
    books: Array.from({ length: count }, (_, index) => ({ ...book(`${category}-${offset + index}`), coverUrl: "", category })),
    total, limit: 48, offset,
    facets: [{ name: "Fixture", count: total }, { name: "Other", count: 48 }],
    summary: { totals: { books: total, authors: 1 }, categories: [{ name: "Fixture", count: total }, { name: "Other", count: 48 }], recent: [] }
  };
}
function harness() {
  return `<!doctype html><meta charset=utf-8><link rel=stylesheet href=/css/foundation.css><link rel=stylesheet href=/modules/novels/styles.css><link rel=stylesheet href=/modules/novels/library.css><link rel=stylesheet href=/modules/novels/detail.css><link rel=stylesheet href=/modules/novels/reader-refinements.css><style>body{margin:0;background:#1c2220;color:white}</style><main><div id=statsRow></div><div id=workGrid></div></main><script type=module>
import {createNovelPage} from '/modules/novels/novel-page.js'; import {routeUrl} from '/js/router.js';
const state={activeView:'novels',novel:{data:${JSON.stringify(libraryData())}}}; const els={workGrid:document.querySelector('#workGrid'),statsRow:document.querySelector('#statsRow')},noop=()=>{};
const api=async(url,options={})=>{const init={...options};if(init.body&&typeof init.body!=='string'){init.body=JSON.stringify(init.body);init.headers={'Content-Type':'application/json'}}const res=await fetch(url,init),data=await res.json();if(!res.ok)throw new Error(data.error||'controlled error');return data;};
const route=(overrides={})=>history.replaceState(null,'',routeUrl({view:'novels',novelBookId:state.novel.book?.id||'',novelChapterIndex:String(state.novel.chapter?.index||''),...overrides}));
const page=createNovelPage({api,state,els,formatNumber:value=>new Intl.NumberFormat('zh-CN').format(value||0),formatBytes:value=>String(value||0),formatDateTime:value=>String(value||''),cancelScheduledWorkRendering:noop,disconnectPeopleIndexAutoload:noop,resetProgressiveCoverLoading:noop,hidePersonProfile:noop,setMainHeader:noop,openAdminScript:noop,pushRoute:route,replaceRoute:route,syncRouteAfterNavigation:options=>{if(!options?.skipRoute)route(options?.routeOverrides)}});
window.fixture={state,page,pending:[],rejections:[],ready:true};page.enter({skipRoute:true,deferInitialLoad:true});
</script>`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runNovelReaderFixture({ legacyNovel: process.argv.includes("--legacy-novel"), legacyHost: process.argv.includes("--legacy-host"), casePattern: process.argv.find(value => value.startsWith("--case="))?.slice(7) || "" });
