import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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
  const held = new Set(), requests = new Map(), progressWrites = [], uploadWrites = [], faults = [], unexpected = [], libraryReads = [];
  const pageStartupMessages = new WeakMap(), recentApiRequests = [];
  const browserPageLimit = 80;
  let browser = null, checks = 0, libraryFeed = null, activeCase = "", gateSequence = 0, requestSequence = 0, caseRequestStart = 0;
  let browserPages = 0, totalBrowserPages = 0;
  const launchBrowser = () => chromium.launch({ executablePath, headless: true,
    args: ["--host-resolver-rules=MAP fanhao-novel.test 127.0.0.1", "--no-proxy-server"] });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture"), key = `${url.pathname}${url.search}`;
    const requestId = ++requestSequence;
    const apiRequest = url.pathname.startsWith("/api/") ? { id: requestId, method: req.method, url: key } : null;
    if (apiRequest) { recentApiRequests.push(apiRequest); if (recentApiRequests.length > 12) recentApiRequests.shift(); }
    requests.set(key, (requests.get(key) || 0) + 1);
    if (url.pathname === "/api/novels") libraryReads.push({ offset: Number(url.searchParams.get("offset") || 0), limit: Number(url.searchParams.get("limit") || 0) });
    try {
      const progress = req.method === "POST" && /^\/api\/novels\/[AB]\/progress$/.test(url.pathname);
      const correction = ["PATCH", "DELETE"].includes(req.method) && /^\/api\/novels\/[AB]$/.test(url.pathname);
      const reimport = req.method === "POST" && /^\/api\/novels\/[AB]\/reimport$/.test(url.pathname);
      const upload = req.method === "POST" && url.pathname === "/api/novels/upload";
      assert(req.method === "GET" || progress || correction || reimport || upload, `unmodelled fixture mutation: ${req.method} ${key}`);
      let body = null;
      if (progress || reimport || upload || (correction && req.method === "PATCH")) { let input = ""; for await (const chunk of req) input += chunk; body = JSON.parse(input); if (progress) progressWrites.push({ bookId: url.pathname.split("/")[3], ...body }); if (upload) uploadWrites.push(body); }
      const gate = [...held].find(value => !value.used && value.match(url, req));
      if (apiRequest && gate) apiRequest.gate = { id: gate.id, createdCase: gate.createdCase, released: Boolean(gate.released) };
      if (gate) { gate.used = true; gate.url = key; gate.body = body; res.once("close", () => { gate.closed = true; }); gate.requestedResolve(); await gate.promise; if (gate.error) { sendJson(res, { error: gate.error }, 503); return; } if (gate.reply) { sendJson(res, gate.reply); return; } }
      if (url.pathname === "/probe") { sendText(res, harness(), "text/html; charset=utf-8"); return; }
      if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      if (progress) { sendJson(res, { progress: { ...body, updatedAt: "2026-01-01T00:00:00Z" } }); return; }
      if (upload) { sendJson(res, { book: { ...book("A"), title: body.fileName } }); return; }
      if (reimport) { sendJson(res, { kind: "book", book: book(url.pathname.split("/")[3]) }); return; }
      if (correction) { sendJson(res, req.method === "PATCH" ? { book: { ...book(url.pathname.split("/")[3]), ...body } } : { deleted: true }); return; }
      const chapterMatch = /^\/api\/novels\/([AB])\/chapters\/([123])$/.exec(url.pathname);
      if (chapterMatch) { sendJson(res, chapterResponse(chapterMatch[1], Number(chapterMatch[2]))); return; }
      const catalogMatch = /^\/api\/novels\/([AB])\/catalog$/.exec(url.pathname);
      if (catalogMatch) { const id = catalogMatch[1]; sendJson(res, { sourceRealm: book(id).sourceRealm, catalogRevision: book(id).catalogRevision, chapters: [1, 2, 3].map(index => chapter(id, index)), total: 3 }); return; }
      if (url.pathname === "/api/novels/authors") {
        const query = String(url.searchParams.get("q") || ""), sort = url.searchParams.get("sort") || "books", offset = Math.max(0, Number(url.searchParams.get("offset") || 0)), limit = Math.min(5000, Number(url.searchParams.get("limit") || 48));
        const authors = Array.from({ length: 5000 }, (_, index) => ({ name: index === 123 ? "张三" : index === 456 ? "张三丰" : index === 3 ? "Synthetic" : index === 4 ? "未知作者" : `Author ${String(index).padStart(5, "0")}`, bookCount: 5000 - index, chapterCount: (5000 - index) * 3 }))
          .filter(author => author.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
        if (sort === "name") authors.sort((a, b) => a.name.localeCompare(b.name));
        sendJson(res, { authors: authors.slice(offset, offset + limit), total: authors.length, offset, limit, query, sort, sourceRealm: "server:fixture" }); return;
      }
      if (url.pathname.startsWith("/api/novels/authors/")) { const name = decodeURIComponent(url.pathname.slice("/api/novels/authors/".length));
        sendJson(res, { ...libraryData(), books: libraryData().books.map(book => ({ ...book, author: name })), author: { name, bookCount: 2, chapterCount: 6, charCount: 36000, sizeBytes: 108000 } }); return; }
      const bookMatch = /^\/api\/novels\/([AB])$/.exec(url.pathname);
      if (bookMatch) { sendJson(res, { serverClockMs: Date.now(), book: book(bookMatch[1]), chapterTotal: 3 }); return; }
      if (url.pathname === "/api/novels") {
        if (libraryFeed) {
          const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
          const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get("limit") || 48)));
          const books = libraryFeed.books.slice(offset, offset + limit);
          sendJson(res, { ...libraryFeed, books, offset, limit, nextOffset: offset + books.length });
        } else sendJson(res, libraryData());
        return;
      }
      if (url.pathname === "/api/modules") { sendJson(res, { product: { id: "suite" }, modules: [] }); return; }
      if (url.pathname === "/api/novels/summary") { sendJson(res, libraryData().summary); return; }
      if (url.pathname === "/api/novels/collection") { sendJson(res, { adapters: [], tasks: [], summary: {} }); return; }
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
  const plainHttpBase = `http://fanhao-novel.test:${server.address().port}`;
  const run = async (name, task) => {
    if (casePattern && !name.includes(casePattern)) return;
    activeCase = name; caseRequestStart = requestSequence;
    if (browserPages >= browserPageLimit) {
      assert.equal(browser.contexts().length, 0, `completed novel cases must release contexts before recycling: ${name}`);
      console.log("NOVEL_BROWSER_RECYCLE", JSON.stringify({ completed: checks, browserPages, totalBrowserPages, contexts: 0, next: name }));
      await browser.close(); browser = null;
      browser = await launchBrowser(); browserPages = 0;
    }
    await task();
    assert.equal(browser.contexts().length, 0, `novel case leaked a browser context: ${name}`);
    checks++; console.log(`PASS ${name}`);
  };
  try {
    browser = await launchBrowser();
    for (const ignoreAbort of [true, false]) {
      const transport = ignoreAbort ? "ignore-abort" : "normal";
      await run(`reader LAN HTTP opens books and preserves progress sessions ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort, plainHttp: true });
        try {
          assert.deepEqual(await page.evaluate(() => [isSecureContext, typeof crypto.randomUUID, typeof crypto.getRandomValues]), [false, "undefined", "function"],
            "LAN compatibility must run on a genuinely non-secure HTTP origin without replacing browser crypto");
          const metadata = hold(url => url.pathname === "/api/novels/A");
          await page.getByRole("button", { name: "Book A", exact: true }).click(); await requested(metadata); await settle(page, metadata);
          assert.equal(await page.locator(".novel-detail-title").count(), 1, "LAN HTTP must open book details when native randomUUID is unavailable");
          await detailTitle(page, "Book A");
          const before = progressWrites.length;
          await page.getByRole("button", { name: "开始阅读", exact: true }).click(); await readerTitle(page, "A", 1); await ready(page);
          await until(() => progressWrites.length > before, "LAN HTTP must save its first reading position");
          const first = progressWrites[before];
          assert.match(first.progressSessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
            "LAN progress fallback must produce a valid version-4 UUID with the RFC variant");
          assert(Number.isSafeInteger(first.progressSessionStartedAt));
          await page.getByRole("button", { name: "下一章", exact: true }).click(); await readerTitle(page, "A", 2);
          await page.evaluate(() => { window.scrollTo(0, 420); dispatchEvent(new PageTransitionEvent("pagehide")); });
          await until(() => progressWrites.slice(before).some(write => write.chapterId === "A-2" && write.scrollRatio > 0), "LAN chapter navigation must save its live keepalive position");
          const writes = progressWrites.slice(before), last = writes.findLast(write => write.chapterId === "A-2" && write.scrollRatio > 0);
          assert.equal(last.progressSessionId, first.progressSessionId, "chapter changes must reuse the same document's cryptographic progress session");
          assert.equal(last.progressSessionStartedAt, first.progressSessionStartedAt);
          assert(last.progressSequence > first.progressSequence);
          assert.equal(last.sourceRealm, "server:fixture"); assert.equal(last.catalogRevision, "rev-A");
          await page.reload(); await ready(page); await readerTitle(page, "A", 2);
          const reloadedAt = progressWrites.length;
          await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide")));
          await until(() => progressWrites.length > reloadedAt, "a new LAN document must send progress");
          assert.notEqual(progressWrites[reloadedAt].progressSessionId, first.progressSessionId, "a new document must get a distinct progress session");
        } finally { await page.close(); }
      });
      await run(`reader LAN HTTP opens chapter deep links ${transport}`, async () => {
        const chapter = hold(url => url.pathname === "/api/novels/B/chapters/2");
        const page = await newPage({ real: true, ignoreAbort, plainHttp: true, route: "/novels/B/2", waitReady: false });
        try {
          await requested(chapter); await settle(page, chapter);
          assert.equal(await page.locator(".novel-reader-page").count(), 1, "LAN HTTP chapter deep links must finish navigation without native randomUUID");
          await readerTitle(page, "B", 2); await ready(page);
          assert.deepEqual(await page.evaluate(() => [isSecureContext, typeof crypto.randomUUID]), [false, "undefined"]);
          assert.equal(new URL(page.url()).pathname, "/novels/B/2");
        } finally { await page.close(); }
      });
      await run(`reader adjacent navigation joins repeated commands for its pending chapter ${transport}`, async () => {
        const match = url => url.pathname === "/api/novels/A/chapters/3";
        const pending = hold(match), extras = [hold(match), hold(match), hold(match)];
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/A/2" });
        try {
          await readerTitle(page, "A", 2); await requested(pending);
          await page.evaluate(() => { window.__adjacentParagraph = document.querySelector(".novel-reader-content p");
            const range = document.createRange(); range.selectNodeContents(__adjacentParagraph); getSelection().removeAllRanges(); getSelection().addRange(range); window.__adjacentSelection = getSelection().toString(); });
          const reads = countRequests(match), next = page.getByRole("button", { name: "下一章", exact: true });
          await next.click(); await page.locator(".novel-reader-paper h1").evaluate(heading => { heading.tabIndex = -1; heading.focus({ preventScroll: true }); });
          await page.keyboard.press("ArrowRight"); await tick(page); await page.keyboard.press("ArrowRight"); await tick(page); await next.click(); await tick(page);
          assert.equal(countRequests(match), reads, "repeated next-chapter commands must join the pending target instead of cancelling and restarting its read");
          assert.equal(await page.evaluate(url => __transport.aborted.includes(url), pending.url), false, "repeated next-chapter commands must retain the promoted prefetch transport");
          assert.equal(await page.evaluate(() => __adjacentParagraph === document.querySelector(".novel-reader-content p") && getSelection().toString() === __adjacentSelection), true);
          await settle(page, pending); await readerTitle(page, "A", 3);
        } finally { for (const gate of [pending, ...extras]) { gate.release(); held.delete(gate); } await page.close(); }
      });
      await run(`reader adjacent navigation allows an explicit retry after failure ${transport}`, async () => {
        const match = url => url.pathname === "/api/novels/A/chapters/3";
        const failed = hold(match, "Synthetic adjacent read failure"), retry = hold(match), extra = hold(match);
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/A/2" });
        try {
          await readerTitle(page, "A", 2); await requested(failed);
          const next = page.getByRole("button", { name: "下一章", exact: true });
          await next.click(); await settle(page, failed);
          await page.getByText("Synthetic adjacent read failure", { exact: true }).waitFor();
          const reads = countRequests(match);
          await next.click(); await tick(page);
          assert.equal(countRequests(match), reads + 1, "a failed adjacent command must release its target for an explicit retry");
          await requested(retry); await next.click(); await tick(page);
          assert.equal(countRequests(match), reads + 1, "repeated commands during the explicit retry must still share one read");
          await settle(page, retry); await readerTitle(page, "A", 3);
        } finally { for (const gate of [failed, retry, extra]) { gate.release(); held.delete(gate); } await page.close(); }
      });
      await run(`reader adjacent navigation lets new directions and routes supersede it ${transport}`, async () => {
        for (const error of ["", "Obsolete adjacent read failure"]) {
          const old = hold(url => url.pathname === "/api/novels/A/chapters/3", error);
          const match = url => url.pathname === "/api/novels/A/chapters/1";
          const current = hold(match), extra = hold(match);
          const page = await newPage({ real: true, ignoreAbort, route: "/novels/A/2" });
          try {
            await readerTitle(page, "A", 2); await requested(old);
            await page.getByRole("button", { name: "下一章", exact: true }).click();
            const previous = page.getByRole("button", { name: "上一章", exact: true });
            const reads = countRequests(match);
            await previous.click(); await tick(page);
            assert.equal(countRequests(match), reads + 1, "a new adjacent direction must supersede the pending destination immediately");
            await requested(current); await finishOld(page, old, ignoreAbort);
            await previous.click(); await tick(page);
            assert.equal(countRequests(match), reads + 1, "an obsolete adjacent finalizer must not release the newer pending destination");
            await navigateRoute(page, "/novels/B/2"); await readerTitle(page, "B", 2);
            await finishOld(page, current, ignoreAbort);
            assert.equal(await page.locator(".novel-reader-paper h1").textContent(), "B Chapter 2", "a route change must remain available while an adjacent command is pending");
            assert.equal(new URL(page.url()).pathname, "/novels/B/2");
          } finally { for (const gate of [old, current, extra]) { gate.release(); held.delete(gate); } await page.close(); }
        }
      });
      for (const mode of ["books", "author"]) await run(`novel sort input preserves native keyboard selection in ${mode} ${transport}`, async () => {
        for (const [width, error] of [[1280, ""], [320, "Synthetic novel sort failure"]]) {
          const page = await newPage({ real: true, ignoreAbort, route: mode === "author" ? "/novels/authors/Synthetic" : "/novels" });
          const endpoint = mode === "author" ? "/api/novels/authors/Synthetic" : "/api/novels";
          const first = hold(url => url.pathname === endpoint && url.searchParams.get("sort") === "chars", error);
          let second;
          try {
            await page.setViewportSize({ width, height: 740 });
            const sort = page.getByRole("combobox", { name: "小说排序", exact: true }); await sort.focus(); await sort.press("Home"); await tick(page);
            await page.waitForFunction(() => document.querySelector(".novel-sort")?.value === "updated" && document.querySelector(".novel-library-results")?.getAttribute("aria-busy") === "false");
            await page.evaluate(() => { const sort = document.querySelector(".novel-sort"); window.__nativeNovelSort = sort;
              window.__nativeNovelSortTree = [sort, ...sort.options, sort.parentElement, sort.closest(".novel-library-results"), sort.closest(".novel-library-workspace"), sort.closest(".novel-home")];
              window.__nativeNovelSortBlur = 0; sort.addEventListener("blur", () => __nativeNovelSortBlur++); });
            await sort.press("ArrowDown"); await requested(first);
            assert.equal(await sort.evaluate(node => node === document.activeElement && node.value === "chars"), true);
            await settle(page, first);
            assert.equal(await page.evaluate(() => __nativeNovelSort === document.querySelector(".novel-sort") && __nativeNovelSortTree.every(node => node.isConnected)), true,
              "same-query sort results must preserve native select/options and its complete ancestor chain");
            assert.equal(await sort.evaluate(node => node === document.activeElement), true, "sort success or failure must retain native keyboard focus");
            assert.equal(await page.evaluate(() => __nativeNovelSortBlur), 0);
            second = hold(url => url.pathname === endpoint && url.searchParams.get("sort") === "progress");
            const reads = countRequests(second.match); await page.keyboard.press("ArrowDown"); await tick(page);
            assert.equal(countRequests(second.match), reads + 1, "a second native ArrowDown after results must issue the next selected sort");
            await requested(second);
            assert.equal(await page.locator(".novel-library-results").getAttribute("aria-busy"), "true", "the retained live results must own the next request's busy state");
            await settle(page, second);
            assert.equal(await sort.inputValue(), "progress");
            assert.equal(await page.locator(".novel-library-results").getAttribute("aria-busy"), "false");
            assert.equal(await page.evaluate(() => __nativeNovelSortTree.every(node => node.isConnected) && document.activeElement === __nativeNovelSort && __nativeNovelSortBlur === 0), true);
            if (error) assert(!(await page.locator(".novel-status-line").textContent()).includes(error));
          } finally { for (const gate of [first, second].filter(Boolean)) { gate.release(); held.delete(gate); } await page.close(); }
        }
      });
      await run(`novel sort input respects newer composition navigation and retired controls ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort });
        const first = hold(url => url.pathname === "/api/novels" && url.searchParams.get("sort") === "chars");
        let old, query, retired;
        try {
          await page.setViewportSize({ width: 320, height: 740 });
          const sort = page.getByRole("combobox", { name: "小说排序", exact: true }); await sort.selectOption("chars"); await requested(first);
          const input = page.getByRole("searchbox", { name: "搜索小说", exact: true }); await input.fill("新的中文草稿");
          await input.evaluate(node => { window.__sortDraft = node; node.setSelectionRange(1, 3); node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "中文" })); });
          await settle(page, first);
          assert.deepEqual(await input.evaluate(node => [node === __sortDraft, node === document.activeElement, node.value, node.selectionStart, node.selectionEnd]), [true, true, "新的中文草稿", 1, 3],
            "a sort result must preserve a newer composing search draft and its native focus");
          retired = await sort.elementHandle();
          old = hold(url => url.pathname === "/api/novels" && url.searchParams.get("sort") === "title"); await sort.selectOption("title"); await requested(old);
          await input.evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文" })));
          query = hold(url => url.pathname === "/api/novels" && url.searchParams.get("q") === "新的中文草稿");
          await input.press("Enter"); await requested(query); await finishOld(page, old, ignoreAbort); await settle(page, query);
          assert.equal(await retired.evaluate(node => node.isConnected), false, "a new query must rebuild the old sort context");
          const reads = countRequests(url => url.pathname === "/api/novels");
          await retired.evaluate(node => { node.value = "size"; node.dispatchEvent(new Event("change", { bubbles: true })); }); await tick(page);
          assert.equal(countRequests(url => url.pathname === "/api/novels"), reads, "a retired novel sort must not request into a newer query");
          const current = await sort.elementHandle();
          const pending = hold(url => url.pathname === "/api/novels" && url.searchParams.get("sort") === "chars");
          try {
            await sort.selectOption("chars"); await requested(pending); await navigateRoute(page, "/novels/B/2"); await readerTitle(page, "B", 2); await finishOld(page, pending, ignoreAbort);
            const before = countRequests(url => url.pathname === "/api/novels");
            await current.evaluate(node => { node.value = "chapters"; node.dispatchEvent(new Event("change", { bubbles: true })); }); await tick(page);
            assert.equal(countRequests(url => url.pathname === "/api/novels"), before, "a retired novel sort must not leave a newer reader");
            assert.equal(await page.locator(".novel-reader-paper h1").textContent(), "B Chapter 2");
          } finally { pending.release(); held.delete(pending); }
        } finally { for (const gate of [first, old, query].filter(Boolean)) { gate.release(); held.delete(gate); } await page.close(); }
      });
      await run(`author discovery browses the existing author index without replacing the book list ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: "/novels" });
        try {
          const data = libraryPage(1000); data.books[900] = book("A"); await openOriginLibrary(page, data);
          assert.equal(await page.getByRole("button", { name: "浏览作者", exact: true }).count(), 1,
            "the library must expose its existing full author index instead of requiring an author to appear in the loaded book rows");
          const opener = page.getByRole("button", { name: "浏览作者", exact: true });
          for (const width of [1280, 320]) {
            await page.setViewportSize({ width, height: 820 }); await opener.scrollIntoViewIfNeeded(); await opener.focus(); await tick(page);
            await page.evaluate(() => { window.__authorSourceRows = [...document.querySelectorAll(".novel-book-row")]; window.__authorSourceScroll = scrollY; });
            const reads = countRequests(url => url.pathname === "/api/novels");
            await opener.press("Enter"); await page.locator(".novel-author-result").nth(47).waitFor();
            assert.equal(await page.locator(".novel-author-result").count(), 48, "five thousand authors must render as one bounded page");
            assert.match(await page.locator(".novel-author-status").textContent(), /5000 位作者/);
            const dialog = page.getByRole("dialog", { name: "浏览作者", exact: true });
            assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth && element.getBoundingClientRect().right <= innerWidth), true);
            const input = dialog.getByRole("searchbox", { name: "搜索作者", exact: true }); await input.focus();
            await page.keyboard.press("Shift+Tab");
            assert.equal(await dialog.getByRole("button", { name: "关闭作者浏览", exact: true }).evaluate(button => button === document.activeElement), true, "native dialog keyboard order must remain inside the author browser");
            await page.keyboard.press("Tab"); assert.equal(await input.evaluate(element => element === document.activeElement), true);
            if (width === 320 && ignoreAbort && process.argv.includes("--screenshots")) {
              const output = path.join(root, ".codex-artifacts", "novels"); await fs.promises.mkdir(output, { recursive: true });
              await page.screenshot({ path: path.join(output, "author-browser-320.png") });
            }
            if (width === 320) {
              const next = dialog.getByRole("button", { name: "下一页作者", exact: true });
              assert.equal(await next.evaluate(button => { const box = button.getBoundingClientRect(); return box.height >= 44 && box.bottom <= innerHeight
                && button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)); }), true,
              "author paging must remain a visible 44px target below the independently scrolling list on mobile");
              await next.click(); await page.getByText(/显示 49–96/).waitFor();
            }
            await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });
            assert.equal(await page.evaluate(() => __authorSourceRows.length === 1000 && __authorSourceRows.every((row, index) => row === document.querySelectorAll(".novel-book-row")[index]) && scrollY === __authorSourceScroll), true,
              "closing author discovery must retain every source book card and its actual document scroll");
            assert.equal(countRequests(url => url.pathname === "/api/novels"), reads);
            assert.equal(await opener.evaluate(button => button === document.activeElement), true);
            assert.equal(await page.evaluate(() => document.body.style.overflow), "");
          }
        } finally { libraryFeed = null; await page.close(); }
      });
      await run(`author discovery paginates delivered authors and resets sorted searches ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort });
        try {
          await page.getByRole("button", { name: "浏览作者", exact: true }).click(); await page.locator(".novel-author-result").nth(47).waitFor();
          const short = hold(url => url.pathname === "/api/novels/authors" && url.searchParams.get("offset") === "48", "", { authors: [0, 1, 2].map(index => ({ name: `Short ${index}`, bookCount: 2, chapterCount: 6 })), total: 999, offset: 48 });
          const next = page.getByRole("button", { name: "下一页作者", exact: true }); await next.focus(); await next.press("Enter"); await requested(short);
          const reads = countRequests(short.match); await next.press("Space"); await tick(page);
          assert.equal(countRequests(short.match), reads, "busy author paging must not submit duplicate reads");
          await settle(page, short); assert.equal(await page.locator(".novel-author-result").count(), 3);
          const empty = hold(url => url.pathname === "/api/novels/authors" && url.searchParams.get("offset") === "51", "", { authors: [], total: 999, offset: 51 });
          await next.click(); await tick(page);
          assert(countRequests(empty.match) > 0, "the next author page must continue after delivered rows rather than the requested page size");
          await requested(empty); await settle(page, empty);
          assert.equal(await next.isDisabled(), true, "an empty delivered author page must stop paging even if the old total was larger");
          assert.match(await page.locator(".novel-author-status").textContent(), /此页暂无作者/, "an empty author page must not claim an inverted displayed range");
          const previous = hold(short.match); await page.getByRole("button", { name: "上一页作者", exact: true }).click(); await requested(previous); await settle(page, previous);
          assert.equal(await page.locator(".novel-author-result").count(), 48);
          const sort = page.getByRole("combobox", { name: "作者排序", exact: true });
          const sorted = hold(url => url.pathname === "/api/novels/authors" && url.searchParams.get("sort") === "name" && url.searchParams.get("offset") === "0");
          await sort.selectOption("name"); await requested(sorted); await settle(page, sorted);
          const input = page.getByRole("searchbox", { name: "搜索作者", exact: true }); await input.fill("No-such-author"); await input.press("Enter");
          await page.getByText(/没有匹配的作者/).waitFor();
          assert.equal(await page.locator(".novel-author-result").count(), 0);
          assert.equal(await page.getByRole("button", { name: "上一页作者", exact: true }).isDisabled(), true);
          assert.equal(await next.isDisabled(), true);
        } finally { await page.close(); }
      });
      await run(`author discovery composes Chinese input and selects the canonical author view ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort });
        try {
          await page.getByRole("button", { name: "浏览作者", exact: true }).click(); await page.locator(".novel-author-result").nth(47).waitFor();
          const input = page.getByRole("searchbox", { name: "搜索作者", exact: true });
          const reads = countRequests(url => url.pathname === "/api/novels/authors");
          await input.evaluate(element => element.dispatchEvent(new CompositionEvent("compositionstart", { data: "张", bubbles: true })));
          await input.fill("张三"); await input.press("Enter"); await tick(page);
          assert.equal(countRequests(url => url.pathname === "/api/novels/authors"), reads, "IME candidate confirmation must not submit a partial author search");
          await input.press("Escape"); assert.equal(await page.getByRole("dialog", { name: "浏览作者", exact: true }).isVisible(), true, "Escape during composition must not close the author browser");
          await input.evaluate(element => element.dispatchEvent(new CompositionEvent("compositionend", { data: "张三", bubbles: true })));
          // Native search Escape may clear its value; commit the synthetic IME
          // candidate explicitly rather than treating composition events as text insertion.
          await input.fill("张三");
          const query = hold(url => url.pathname === "/api/novels/authors" && url.searchParams.get("q") === "张三");
          await input.press("Enter"); await requested(query); await input.evaluate(element => { element.setSelectionRange(0, 1); window.__authorInput = element; }); await settle(page, query);
          assert.equal(await page.locator(".novel-author-result").count(), 2);
          assert.deepEqual(await input.evaluate(element => [element === __authorInput, element === document.activeElement, element.selectionStart, element.selectionEnd]), [true, true, 0, 1]);
          await page.locator(".novel-author-result").first().focus(); await page.keyboard.press("Enter");
          await page.locator(".novel-home-head h1").filter({ hasText: /^张三$/ }).waitFor();
          assert.equal(decodeURIComponent(new URL(page.url()).pathname), "/novels/authors/张三", "author selection must reuse the existing encoded author works route");
          assert.equal(await page.locator(".novel-home-head h1").evaluate(heading => heading === document.activeElement), true);
          assert.equal(await page.locator(".novel-author-dialog").count(), 0);
        } finally { await page.close(); }
      });
      await run(`author discovery opens the explicit unknown author group ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort });
        try {
          await page.getByRole("button", { name: "浏览作者", exact: true }).click(); await page.locator(".novel-author-result").nth(47).waitFor();
          const match = url => decodeURIComponent(url.pathname) === "/api/novels/authors/未知作者";
          const reads = countRequests(match);
          await page.locator(".novel-author-result").filter({ has: page.getByText("未知作者", { exact: true }) }).click(); await tick(page);
          assert.equal(decodeURIComponent(new URL(page.url()).pathname), "/novels/authors/未知作者",
            "an explicit unknown-author directory group must open its author route instead of silently closing the dialog");
          assert.equal(countRequests(match), reads + 1, "the explicit unknown-author group must read its existing author API");
          await page.locator(".novel-home-head h1").filter({ hasText: /^未知作者$/ }).waitFor();
          assert.equal(await page.locator(".novel-book-row").count(), 2);
          assert.equal(await page.locator(".novel-book-author").count(), 0, "unknown-author book placeholders must keep their existing non-interactive semantics");
          assert.equal(await page.locator(".novel-author-dialog").count(), 0);
        } finally { await page.close(); }
      });
      await run(`author discovery retries failures without losing keyboard or newer draft intent ${transport}`, async () => {
        const failed = hold(url => url.pathname === "/api/novels/authors", "Synthetic author list unavailable");
        const page = await newPage({ real: true, ignoreAbort });
        try {
          await page.getByRole("button", { name: "浏览作者", exact: true }).click(); await requested(failed); await settle(page, failed);
          const retry = page.locator(".novel-author-dialog .novel-secondary-button");
          const again = hold(failed.match, "Second author list failure"); await retry.focus(); await retry.press("Space"); await requested(again);
          const reads = countRequests(failed.match); await retry.press("Enter"); await tick(page); assert.equal(countRequests(failed.match), reads);
          await settle(page, again);
          assert.equal(await retry.evaluate(button => button === document.activeElement), true, "a repeated author-list failure must keep its current keyboard retry focused");
          const success = hold(failed.match); await retry.press("Enter"); await requested(success); await settle(page, success);
          assert.equal(await page.locator(".novel-author-status").evaluate(status => status === document.activeElement), true);
          const input = page.getByRole("searchbox", { name: "搜索作者", exact: true });
          const unavailable = hold(url => url.pathname === "/api/novels/authors" && url.searchParams.get("q") === "Synthetic", "Filtered author list unavailable");
          await input.fill("Synthetic"); await input.press("Enter"); await requested(unavailable); await settle(page, unavailable);
          const pending = hold(unavailable.match); await retry.click(); await requested(pending); await input.focus(); await input.fill("Unsubmitted draft");
          await input.evaluate(element => element.setSelectionRange(2, 7)); await settle(page, pending);
          assert.deepEqual(await input.evaluate(element => [element.value, element === document.activeElement, element.selectionStart, element.selectionEnd]), ["Unsubmitted draft", true, 2, 7],
            "author retry completion must not overwrite a newer search draft, selection or focus");
        } finally { await page.close(); }
      });
      await run(`author discovery ignores replaced-query success and failure ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort });
        try {
          await page.getByRole("button", { name: "浏览作者", exact: true }).click(); await page.locator(".novel-author-result").nth(47).waitFor();
          const input = page.getByRole("searchbox", { name: "搜索作者", exact: true });
          for (const error of ["", "Obsolete author failure"]) {
            const old = hold(url => url.pathname === "/api/novels/authors" && url.searchParams.get("q") === "Author", error);
            await input.fill("Author"); await input.press("Enter"); await requested(old);
            const latest = hold(url => url.pathname === "/api/novels/authors" && url.searchParams.get("q") === "张三");
            await input.fill("张三"); await input.press("Enter"); await requested(latest);
            await finishOld(page, old, ignoreAbort);
            assert.equal(await page.locator(".novel-author-result").count(), 0, "a superseded author read must not populate a newer query while it is pending");
            assert.equal(await page.getByRole("button", { name: "下一页作者", exact: true }).getAttribute("aria-disabled"), "true", "an old author finalizer must not release the newer read's busy state");
            assert.equal(await page.getByText("Obsolete author failure", { exact: true }).count(), 0);
            await settle(page, latest); await page.locator(".novel-author-result").nth(1).waitFor();
            assert.equal(await page.locator(".novel-author-result").count(), 2, "a superseded author read must not replace the latest query results");
            assert.equal(await page.getByText("Obsolete author failure", { exact: true }).count(), 0);
            assert.match(await page.locator(".novel-author-status").textContent(), /张三/);
          }
        } finally { await page.close(); }
      });
      await run(`author discovery closes and reopens without old callbacks taking ownership ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort });
        try {
          for (const error of ["", "Closed author failure"]) {
            await page.getByRole("button", { name: "浏览作者", exact: true }).click(); await page.locator(".novel-author-result").nth(47).waitFor();
            await page.evaluate(() => { window.__oldAuthorResult = document.querySelector(".novel-author-result"); });
            const old = hold(url => url.pathname === "/api/novels/authors" && url.searchParams.get("q") === "Author", error);
            const input = page.getByRole("searchbox", { name: "搜索作者", exact: true }); await input.fill("Author"); await input.press("Enter"); await requested(old);
            await page.getByRole("button", { name: "关闭作者浏览", exact: true }).focus();
            await page.keyboard.press("Escape"); await page.locator(".novel-author-dialog").waitFor({ state: "detached" });
            assert.equal(await page.evaluate(url => __transport.aborted.includes(url), old.url), true, "closing author discovery must abort its pending read");
            await page.getByRole("button", { name: "浏览作者", exact: true }).click(); await page.locator(".novel-author-result").nth(47).waitFor();
            await page.evaluate(() => { window.__newAuthorDialog = document.querySelector(".novel-author-dialog"); });
            await finishOld(page, old, ignoreAbort);
            assert.equal(await page.evaluate(() => __newAuthorDialog === document.querySelector(".novel-author-dialog")), true, "an obsolete author dialog request must not own its replacement");
            assert.equal(await page.locator(".novel-author-result").count(), 48);
            await page.evaluate(() => __oldAuthorResult.click()); await tick(page);
            assert.equal(new URL(page.url()).pathname, "/novels", "a detached author result must not navigate the current library");
            await page.keyboard.press("Escape"); await page.locator(".novel-author-dialog").waitFor({ state: "detached" });
          }
        } finally { await page.close(); }
      });
      await run(`author discovery retires for a new reader and clamps a changed final page ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort });
        try {
          await page.getByRole("button", { name: "浏览作者", exact: true }).click(); await page.locator(".novel-author-result").nth(47).waitFor();
          const short = hold(url => url.pathname === "/api/novels/authors" && url.searchParams.get("offset") === "48", "", { authors: [], total: 20, offset: 48 });
          const clamp = hold(url => url.pathname === "/api/novels/authors" && url.searchParams.get("offset") === "0", "", { authors: Array.from({ length: 20 }, (_, index) => ({ name: `Remaining ${index}`, bookCount: 1 })), total: 20, offset: 0 });
          await page.getByRole("button", { name: "下一页作者", exact: true }).click(); await requested(short); await settle(page, short); await requested(clamp);
          assert.equal(await page.getByRole("button", { name: "下一页作者", exact: true }).getAttribute("aria-disabled"), "true", "the old page finalizer must not release the clamped read's busy state");
          await settle(page, clamp); assert.equal(await page.locator(".novel-author-result").count(), 20);
          assert.equal(await page.getByRole("button", { name: "上一页作者", exact: true }).isDisabled(), true);
          const old = hold(url => url.pathname === "/api/novels/authors" && url.searchParams.get("q") === "Author");
          const input = page.getByRole("searchbox", { name: "搜索作者", exact: true }); await input.fill("Author"); await input.press("Enter"); await requested(old);
          await navigateRoute(page, "/novels/B/2"); await readerTitle(page, "B", 2);
          await page.evaluate(() => { window.__authorNewReader = document.querySelector(".novel-reader-page"); });
          await finishOld(page, old, ignoreAbort);
          assert.equal(await page.locator(".novel-author-dialog").count(), 0);
          assert.equal(await page.evaluate(() => __authorNewReader === document.querySelector(".novel-reader-page") && scrollY === 0), true,
            "late author reads must not repaint or scroll a newly opened reader");
          assert.equal(await page.evaluate(() => document.body.style.overflow), "");
        } finally { await page.close(); }
      });
      await run(`reader bookmarks save multiple precise places without rebuilding long text ${transport}`, async () => {
        const reply = chapterResponse("A", 1);
        reply.chapter.content = Array.from({ length: 1000 }, (_, index) => `Synthetic bookmark paragraph ${index}. 完全合成的正文位置。`).join("\n\n");
        const initial = hold(url => url.pathname === "/api/novels/A/chapters/1", "", reply);
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/A/1", waitReady: false });
        try {
          await requested(initial); await settle(page, initial); await readerTitle(page, "A", 1); await ready(page);
          await page.locator('[data-reader-focus="toolbar-设置"]').click();
          assert.equal(await page.getByRole("button", { name: "保存当前位置书签", exact: true }).count(), 1,
            "a long chapter must support saving named chapter positions beyond its single latest reading-progress record");
          await saveBookmarkAt(page, .234567); await saveBookmarkAt(page, .765432);
          const marks = (await bookmarkStorage(page))[0].value.items;
          assert.equal(marks.length, 2); assert((await bookmarkStorage(page))[0].raw.length < 2000, "bookmarks must store scalar positions rather than chapter text");
          await page.getByRole("button", { name: "保存当前位置书签", exact: true }).click();
          assert.equal((await bookmarkStorage(page))[0].value.items.length, 2, "repeatedly saving the same place must not duplicate its bookmark");
          const target = page.locator(".novel-bookmark-open").last(); await target.focus();
          await page.evaluate(() => { window.__bookmarkReader = document.querySelector(".novel-reader-page"); window.__bookmarkParagraphs = [...document.querySelectorAll(".novel-reader-content p")];
            const range = document.createRange(); range.setStart(__bookmarkParagraphs[400].firstChild, 2); range.setEnd(__bookmarkParagraphs[400].firstChild, 15);
            getSelection().removeAllRanges(); getSelection().addRange(range); window.__bookmarkSelection = getSelection().toString(); });
          const reads = countRequests(url => url.pathname === "/api/novels/A/chapters/1");
          await target.press("Enter"); await tick(page);
          assert(Math.abs(await readerRatio(page) - marks[1].ratio) < .00001, "a same-chapter bookmark must restore its exact saved percentage");
          assert.equal(countRequests(url => url.pathname === "/api/novels/A/chapters/1"), reads);
          assert.equal(await page.evaluate(() => __bookmarkReader === document.querySelector(".novel-reader-page") && __bookmarkParagraphs.length === 1000
            && __bookmarkParagraphs.every((node, index) => node === document.querySelectorAll(".novel-reader-content p")[index]) && getSelection().toString() === __bookmarkSelection), true,
          "opening a same-chapter bookmark must keep all existing text nodes and the Range");
          await until(() => progressWrites.some(write => write.chapterId === "A-1" && Math.abs(write.scrollRatio - marks[1].ratio) < .00001), "bookmark jumps must persist through the existing progress writer");
          await page.reload(); await ready(page); await readerTitle(page, "A", 1);
          await page.locator('[data-reader-focus="toolbar-设置"]').click();
          await page.locator(".novel-bookmarks summary").click();
          assert.equal(await page.locator(".novel-bookmark-open").count(), 2, "bookmarks must survive a document reload");
          if (ignoreAbort && process.argv.includes("--screenshots")) {
            await page.setViewportSize({ width: 320, height: 740 }); await tick(page);
            const output = path.join(root, ".codex-artifacts", "novels"); await fs.promises.mkdir(output, { recursive: true });
            await page.screenshot({ path: path.join(output, "reader-bookmarks-320.png") });
          }
          await page.locator(".novel-bookmark-remove").last().focus(); await page.keyboard.press("Enter");
          assert.equal(await page.locator(".novel-bookmark-open").count(), 1);
          assert.equal(await page.locator(".novel-bookmark-remove").evaluate(button => button === document.activeElement), true, "removing a bookmark must leave keyboard focus on a live neighbouring action");
        } finally { await page.close(); }
      });
      await run(`reader bookmarks reopen another chapter from the book detail ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/A/1" });
        try {
          await readerTitle(page, "A", 1); await saveBookmarkAt(page, .42);
          const ratio = (await bookmarkStorage(page))[0].value.items[0].ratio;
          await navigateRoute(page, "/novels/A/3"); await readerTitle(page, "A", 3); await page.reload(); await ready(page); await readerTitle(page, "A", 3);
          await page.locator('[data-reader-focus="toolbar-书页"]').click(); await detailTitle(page, "Book A");
          await page.locator(".novel-bookmarks summary").click();
          const request = hold(url => url.pathname === "/api/novels/A/chapters/1");
          await page.locator(".novel-bookmark-open").focus(); await page.keyboard.press("Enter"); await requested(request);
          assert.equal(new URL(request.url, base).searchParams.get("chapterId"), "A-1", "cross-chapter bookmark reads must include the saved exact chapter identity");
          await settle(page, request); await readerTitle(page, "A", 1);
          assert(Math.abs(await readerRatio(page) - ratio) < .00001, "a cross-chapter bookmark must restore its own position rather than latest server progress or zero");
          await until(() => progressWrites.some(write => write.chapterId === "A-1" && Math.abs(write.scrollRatio - ratio) < .00001), "cross-chapter bookmark restoration must use the existing writer");
        } finally { await page.close(); }
      });
      await run(`reader bookmarks preserve the real library source through detail and reading ${transport}`, async () => {
        const data = libraryPage(96); data.books[50] = book("A");
        const page = await newPage({ real: true, ignoreAbort });
        try {
          const source = await openOriginLibrary(page, data);
          const top = await source.evaluate(button => button.closest(".novel-book-row").getBoundingClientRect().top);
          const reads = countRequests(url => url.pathname === "/api/novels");
          await source.press("Enter"); await detailTitle(page, "Book A");
          await page.locator(".novel-detail-actions button").first().click(); await readerTitle(page, "A", 1); await saveBookmarkAt(page, .37);
          await page.locator('[data-reader-focus="toolbar-书页"]').click(); await detailTitle(page, "Book A");
          await page.locator(".novel-bookmarks summary").click(); await page.locator(".novel-bookmark-open").click(); await readerTitle(page, "A", 1);
          await page.getByRole("button", { name: "返回列表", exact: true }).click(); await tick(page);
          assert.equal(countRequests(url => url.pathname === "/api/novels"), reads, "bookmark navigation must preserve the unchanged loaded source rather than treating its panel as a new source");
          assert.equal(await page.locator(".novel-book-row").count(), 96);
          assert.equal(await page.locator(".novel-section-search input").inputValue(), "Book");
          assert.equal(await page.locator(".novel-sort").inputValue(), "title");
          assert(Math.abs(await source.evaluate(button => button.closest(".novel-book-row").getBoundingClientRect().top) - top) < 2);
        } finally { libraryFeed = null; await page.close(); }
      });
      await run(`reader bookmarks reject a mismatched chapter response before caching and can retry ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/A/1" });
        try {
          await readerTitle(page, "A", 1); await saveBookmarkAt(page, .35);
          const ratio = (await bookmarkStorage(page))[0].value.items[0].ratio;
          await navigateRoute(page, "/novels/A/3"); await readerTitle(page, "A", 3); await page.reload(); await ready(page); await readerTitle(page, "A", 3);
          await page.locator('[data-reader-focus="toolbar-设置"]').click(); await page.locator(".novel-bookmarks summary").click();
          const bad = chapterResponse("A", 1); bad.chapter.id = "A-unexpected-chapter";
          const wrong = hold(url => url.pathname === "/api/novels/A/chapters/1", "", bad);
          await page.evaluate(() => { window.__bookmarkOldReader = document.querySelector(".novel-reader-page"); });
          await page.locator(".novel-bookmark-open").click(); await requested(wrong); await settle(page, wrong);
          assert.equal(await page.locator(".novel-reader-paper h1").textContent(), "A Chapter 3", "a mismatched bookmark response must never mount another chapter under the saved identity");
          assert.equal(await page.evaluate(() => __bookmarkOldReader === document.querySelector(".novel-reader-page")), true);
          await page.getByRole("button", { name: "完成", exact: true }).click();
          const valid = hold(wrong.match);
          const reads = countRequests(wrong.match);
          await page.getByRole("button", { name: "重试章节", exact: true }).click(); await tick(page);
          assert(countRequests(wrong.match) > reads, "a mismatched bookmark chapter must not poison the cache used by the next retry");
          await requested(valid); await settle(page, valid); await readerTitle(page, "A", 1);
          assert(Math.abs(await readerRatio(page) - ratio) < .00001, "retrying a bookmark read must retain its saved position and reject poisoned cache entries");
        } finally { await page.close(); }
      });
      await run(`reader bookmarks yield to newer navigation and retire old controls ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/A/1" });
        try {
          await readerTitle(page, "A", 1); await saveBookmarkAt(page, .32);
          await navigateRoute(page, "/novels/A/3"); await readerTitle(page, "A", 3); await page.reload(); await ready(page); await readerTitle(page, "A", 3);
          await page.locator('[data-reader-focus="toolbar-设置"]').click(); await page.locator(".novel-bookmarks summary").click();
          await page.evaluate(() => { window.__oldBookmarkButton = document.querySelector(".novel-bookmark-open"); });
          const old = hold(url => url.pathname === "/api/novels/A/chapters/1");
          await page.locator(".novel-bookmark-open").click(); await requested(old);
          await navigateRoute(page, "/novels/B/2"); await readerTitle(page, "B", 2);
          await page.evaluate(() => { window.__newBookmarkReader = document.querySelector(".novel-reader-page"); });
          await finishOld(page, old, ignoreAbort);
          assert.equal(await page.evaluate(() => __newBookmarkReader === document.querySelector(".novel-reader-page")), true, "late bookmark reads must preserve the newer book and its reader nodes");
          const count = countRequests(old.match); await page.evaluate(() => __oldBookmarkButton.click()); await tick(page);
          assert.equal(countRequests(old.match), count, "a detached bookmark action must not reopen its old book");
        } finally { await page.close(); }
      });
      await run(`reader bookmarks separate account owners and preserve old account data ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/A/1" });
        try {
          await readerTitle(page, "A", 1); await saveBookmarkAt(page, .2);
          const original = (await bookmarkStorage(page))[0];
          await page.evaluate(async () => { const { publishWebAccountChange } = await import("/platform/accounts/session-context.js"); publishWebAccountChange("fixture-other-account"); });
          await page.getByRole("button", { name: "保存当前位置书签", exact: true }).click();
          assert.equal((await bookmarkStorage(page))[0].raw, original.raw, "an old account's mounted bookmark control must not write after the account changes");
          await page.getByRole("button", { name: "完成", exact: true }).click(); await page.locator('[data-reader-focus="toolbar-设置"]').click();
          assert.equal(await page.locator(".novel-bookmark-open").count(), 0, "a new account must not inherit another account's bookmarks");
          await saveBookmarkAt(page, .6);
          const current = await bookmarkStorage(page);
          assert.equal(current.length, 2); assert.equal(current.find(entry => entry.key === original.key).raw, original.raw);
          assert(current.some(entry => entry.key.includes("fixture-other-account")), "bookmark persistence must use the actual account owner namespace");
        } finally { await page.close(); }
      });
      await run(`reader bookmarks separate realms books and disable outdated revisions ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/A/1" });
        try {
          await readerTitle(page, "A", 1); await saveBookmarkAt(page, .25);
          const other = chapterResponse("A", 1); other.book.sourceRealm = other.sourceRealm = "server:other"; other.next = null;
          const realm = hold(url => url.pathname === "/api/novels/A/chapters/1", "", other);
          await page.reload({ waitUntil: "commit" }); await requested(realm); await settle(page, realm); await ready(page); await readerTitle(page, "A", 1);
          await page.locator('[data-reader-focus="toolbar-设置"]').click();
          assert.equal(await page.locator(".novel-bookmark-open").count(), 0, "a different source realm must not reuse bookmarks with the same book ID");
          await saveBookmarkAt(page, .55);
          const changed = chapterResponse("A", 1); changed.book.catalogRevision = changed.catalogRevision = "rev-A-new"; changed.chapter.id = "A-new-1"; changed.next = null;
          const revision = hold(realm.match, "", changed);
          await page.reload({ waitUntil: "commit" }); await requested(revision); await settle(page, revision); await ready(page); await readerTitle(page, "A", 1);
          await page.locator('[data-reader-focus="toolbar-设置"]').click(); await page.locator(".novel-bookmarks summary").click();
          assert.equal(await page.locator(".novel-bookmark-open").isDisabled(), true, "bookmarks from an outdated catalog revision must be visibly unavailable for navigation");
          await page.getByText("目录已更新，旧书签不可定位", { exact: true }).waitFor();
          const reads = countRequests(realm.match); await page.evaluate(() => document.querySelector(".novel-bookmark-open").click()); await tick(page);
          assert.equal(countRequests(realm.match), reads);
          await page.locator(".novel-bookmark-remove").click(); assert.equal(await page.locator(".novel-bookmark-open").count(), 0);
          assert.equal((await bookmarkStorage(page)).find(entry => entry.key.includes("server:other")).value.items.length, 1);
          await navigateRoute(page, "/novels/B/1"); await readerTitle(page, "B", 1); await page.locator('[data-reader-focus="toolbar-设置"]').click();
          assert.equal(await page.locator(".novel-bookmark-open").count(), 0, "another book must not display this book's local bookmarks");
        } finally { await page.close(); }
      });
      await run(`reader bookmarks keep a bounded usable mobile list and recover storage failures ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/A/1" });
        try {
          await readerTitle(page, "A", 1); await saveBookmarkAt(page, .15);
          await page.evaluate(() => {
            window.__bookmarkKey = Object.keys(localStorage).find(key => key.startsWith("fanhao.novel.bookmarks.v1:"));
            const data = JSON.parse(localStorage.getItem(__bookmarkKey)), sample = data.items[0];
            data.items = Array.from({ length: 50 }, (_, index) => ({ ...sample, id: `seed-${index}`, ratio: index / 50 })); localStorage.setItem(__bookmarkKey, JSON.stringify(data));
          });
          await page.getByRole("button", { name: "完成", exact: true }).click(); await page.setViewportSize({ width: 320, height: 740 });
          await page.locator('[data-reader-focus="toolbar-设置"]').click(); await page.locator(".novel-bookmarks summary").click();
          assert.equal(await page.locator(".novel-bookmark-open").count(), 50);
          await saveBookmarkAt(page, .999); await page.getByText(/本书已有 50 个本机书签/).waitFor();
          assert.equal((await bookmarkStorage(page))[0].value.items.length, 50, "the per-book bookmark limit must not silently discard older saved positions");
          const remove = page.locator(".novel-bookmark-remove").first(); await remove.scrollIntoViewIfNeeded();
          assert.equal(await remove.evaluate(button => { const r = button.getBoundingClientRect(); return r.height >= 44 && button.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); }), true);
          await remove.click(); assert.equal(await page.locator(".novel-bookmark-open").count(), 49);
          await page.evaluate(() => { window.__bookmarkSet = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) {
            if (key.startsWith("fanhao.novel.bookmarks.v1:")) throw new DOMException("Synthetic quota", "QuotaExceededError"); return __bookmarkSet.call(this, key, value); }; });
          await page.getByRole("button", { name: "保存当前位置书签", exact: true }).click();
          assert.equal(await page.locator(".novel-bookmark-open").count(), 49, "a rejected storage write must not display a bookmark as saved");
          await page.getByText(/无法保存或读取本机书签/).waitFor();
          await page.evaluate(() => { Storage.prototype.setItem = __bookmarkSet; });
          await page.getByRole("button", { name: "保存当前位置书签", exact: true }).click();
          assert.equal(await page.locator(".novel-bookmark-open").count(), 50, "a storage failure must permit retry without refreshing the reader");
        } finally { await page.close(); }
      });
      await run(`reader bookmarks normalize damaged records and preserve unreadable storage ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/A/1" });
        try {
          await readerTitle(page, "A", 1); await saveBookmarkAt(page, .1);
          await page.evaluate(() => {
            window.__bookmarkBadKey = Object.keys(localStorage).find(key => key.startsWith("fanhao.novel.bookmarks.v1:"));
            const item = JSON.parse(localStorage.getItem(__bookmarkBadKey)).items[0];
            localStorage.setItem(__bookmarkBadKey, JSON.stringify({ version: 1, items: [
              { ...item, id: "duplicated", title: "Long title ".repeat(50), content: "Synthetic full body must not persist", nested: { text: "Synthetic body" } },
              { ...item, id: "duplicated", ratio: .8 }, { ...item, id: "" }, { ...item, id: "invalid", ratio: null }, { ...item, id: "good", ratio: .6 }
            ] }));
          });
          await page.getByRole("button", { name: "完成", exact: true }).click(); await page.locator('[data-reader-focus="toolbar-设置"]').click();
          assert.equal(await page.locator(".novel-bookmark-open").count(), 2, "damaged bookmark records must reject empty identities and collapse duplicate IDs without duplicating actions");
          await saveBookmarkAt(page, .9);
          const normalized = (await bookmarkStorage(page))[0].value.items;
          assert(normalized.every(item => Object.keys(item).sort().join(",") === "catalogRevision,chapterId,chapterIndex,id,ratio,title" && item.title.length <= 160),
            "persisted bookmarks must contain only bounded scalar fields instead of echoing unknown body or nested data");
          const prior = (await bookmarkStorage(page))[0].raw;
          await page.evaluate(() => localStorage.setItem(__bookmarkBadKey, "{broken"));
          await page.getByRole("button", { name: "完成", exact: true }).click(); await page.locator('[data-reader-focus="toolbar-设置"]').click();
          await page.getByText(/无法保存或读取本机书签/).waitFor();
          await page.getByRole("button", { name: "保存当前位置书签", exact: true }).click();
          assert.equal(await page.evaluate(() => localStorage.getItem(__bookmarkBadKey)), "{broken", "an unreadable storage record must not be silently overwritten as an empty bookmark list");
          await page.evaluate(prior => localStorage.setItem(__bookmarkBadKey, prior), prior);
          await saveBookmarkAt(page, .95);
          assert.equal(await page.locator(".novel-bookmark-open").count(), normalized.length + 1, "corrected storage must be usable again in the same mounted control");
        } finally { await page.close(); }
      });
      await run(`book metadata recovery exposes a failed direct link and retries its target ${transport}`, async () => {
        const failed = hold(url => url.pathname === "/api/novels/B" && url.searchParams.get("catalog") === "0", "Synthetic book metadata unavailable");
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/B", waitReady: false });
        try {
          await requested(failed); await settle(page, failed); await ready(page);
          console.log(`MEASURE book metadata failure ${transport}: ${JSON.stringify(await page.evaluate(() => ({ url: location.pathname,
            empty: document.querySelector(".novel-empty-card")?.textContent, errorVisible: [...document.querySelectorAll("body *")].some(element => element.children.length === 0 && element.textContent.includes("Synthetic book metadata unavailable") && element.getBoundingClientRect().height > 0) })))}`);
          assert.equal(await page.getByText("Synthetic book metadata unavailable", { exact: true }).isVisible(), true,
            "a failed direct book link must expose its metadata error instead of claiming that the library is empty");
          const retry = page.getByRole("button", { name: "重试打开书籍", exact: true });
          assert.equal(await retry.count(), 1, "a failed book metadata request must be retryable in the current URL without a page reload");
          const token = await page.evaluate(() => __documentToken);
          const again = hold(failed.match, "Second synthetic metadata failure");
          await retry.focus(); await retry.press("Enter"); await requested(again);
          const calls = countRequests(failed.match);
          await page.evaluate(() => document.querySelector(".novel-book-retry").click()); await tick(page);
          assert.equal(countRequests(failed.match), calls, "a pending book retry must stay single flight");
          await settle(page, again);
          assert.equal(await retry.evaluate(button => button === document.activeElement), true, "a repeated failure must return untouched keyboard intent to its current retry");
          const success = hold(failed.match);
          await retry.press("Enter"); await requested(success); await settle(page, success); await detailTitle(page, "Book B");
          assert.equal(await page.locator(".novel-detail-title").evaluate(title => title === document.activeElement), true, "a successful current keyboard retry must focus the opened book title");
          assert.equal(await page.evaluate(() => __documentToken), token);
          assert.equal(new URL(page.url()).pathname, "/novels/B");
        } finally { await page.close(); }
      });
      await run(`book metadata recovery returns to the unchanged loaded source ${transport}`, async () => {
        const data = libraryPage(96); data.books[0] = book("A"); data.books[50] = book("B");
        const page = await newPage({ real: true, ignoreAbort });
        try {
          await openOriginLibrary(page, data);
          const title = page.locator(".novel-book-title").filter({ hasText: /^Book B$/ });
          await title.scrollIntoViewIfNeeded(); await title.focus(); await tick(page);
          const top = await title.evaluate(button => button.closest(".novel-book-row").getBoundingClientRect().top);
          const reads = countRequests(url => url.pathname === "/api/novels");
          const failed = hold(url => url.pathname === "/api/novels/B" && url.searchParams.get("catalog") === "0", "Source metadata unavailable");
          await title.press("Enter"); await requested(failed); await settle(page, failed);
          await page.getByRole("button", { name: "返回列表", exact: true }).click(); await tick(page);
          assert.equal(countRequests(url => url.pathname === "/api/novels"), reads, "a failed book open must return to its unchanged source without refetching or losing the loaded prefix");
          assert.equal(await page.locator(".novel-book-row").count(), 96);
          assert.equal(await page.locator(".novel-section-search input").inputValue(), "Book");
          assert.equal(await page.locator(".novel-sort").inputValue(), "title");
          assert(Math.abs(await title.evaluate(button => button.closest(".novel-book-row").getBoundingClientRect().top) - top) < 2);
          assert.equal(await title.evaluate(button => button === document.activeElement), true);
          const failedAgain = hold(failed.match, "Repeated source metadata failure");
          await title.press("Enter"); await requested(failedAgain); await settle(page, failedAgain);
          // A same-book history target still belongs to the real list captured
          // before failure; the error shell itself must never become a list source.
          await navigateRoute(page, "/novels/B?q=Book&category=Fixture&sort=title"); await detailTitle(page, "Book B");
          await page.getByRole("button", { name: "返回列表", exact: true }).click(); await tick(page);
          assert(Math.abs(await title.evaluate(button => button.closest(".novel-book-row").getBoundingClientRect().top) - top) < 2,
            "same-book history after failure must retain the real source anchor instead of capturing the metadata error shell");
        } finally { libraryFeed = null; await page.close(); }
      });
      await run(`book metadata recovery never presents the old book as a failed new target ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/A/1" });
        try {
          await readerTitle(page, "A", 1);
          const failed = hold(url => url.pathname === "/api/novels/B" && url.searchParams.get("catalog") === "0", "New B metadata unavailable");
          await navigateRoute(page, "/novels/B"); await requested(failed); await settle(page, failed);
          assert.equal(await page.locator(".novel-detail-title").count(), 0, "a failed B metadata load must not leave A's detail masquerading as the requested book");
          assert.equal(await page.getByText("New B metadata unavailable", { exact: true }).isVisible(), true);
          await page.setViewportSize({ width: 320, height: 720 });
          const retry = page.getByRole("button", { name: "重试打开书籍", exact: true });
          await retry.scrollIntoViewIfNeeded();
          assert.equal(await retry.evaluate(button => { const box = button.getBoundingClientRect(); return box.height >= 44
            && box.left >= 0 && box.right <= innerWidth && button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)); }), true);
          const success = hold(failed.match); await retry.click(); await requested(success); await settle(page, success); await detailTitle(page, "Book B");
        } finally { await page.close(); }
      });
      for (const result of ["success", "failure"]) await run(`book metadata recovery retires late retry ${result} after newer navigation ${transport}`, async () => {
        const failed = hold(url => url.pathname === "/api/novels/A" && url.searchParams.get("catalog") === "0", "Initial metadata failure");
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/A", waitReady: false });
        try {
          await requested(failed); await settle(page, failed); await ready(page);
          await page.evaluate(() => { window.__oldBookRetry = document.querySelector(".novel-book-retry"); });
          const retry = hold(failed.match, result === "failure" ? "Obsolete metadata retry failure" : "");
          await page.getByRole("button", { name: "重试打开书籍", exact: true }).click(); await requested(retry);
          await navigateRoute(page, "/novels/B/2"); await readerTitle(page, "B", 2);
          await page.evaluate(() => { window.__newBookReader = document.querySelector(".novel-reader-page"); });
          await finishOld(page, retry, ignoreAbort);
          assert.equal(await page.evaluate(() => __newBookReader === document.querySelector(".novel-reader-page")), true,
            "late metadata retry completion must preserve the newer reader DOM and status");
          assert.equal(await page.locator(".novel-book-recovery").count(), 0);
          const calls = countRequests(failed.match);
          await page.evaluate(() => __oldBookRetry.click()); await tick(page);
          assert.equal(countRequests(failed.match), calls, "a detached metadata retry must not navigate back to its obsolete target");
          assert.equal(new URL(page.url()).pathname, "/novels/B/2");
        } finally { await page.close(); }
      });
      for (const result of ["success", "failure"]) await run(`book metadata recovery keeps newer composing search and focus on retry ${result} ${transport}`, async () => {
        const failed = hold(url => url.pathname === "/api/novels/A" && url.searchParams.get("catalog") === "0", "Initial metadata failure");
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/A", waitReady: false });
        try {
          await requested(failed); await settle(page, failed); await ready(page);
          const retry = hold(failed.match, result === "failure" ? "Current retry unavailable" : "");
          await page.getByRole("button", { name: "重试打开书籍", exact: true }).click(); await requested(retry);
          const input = page.locator(".novel-section-search input");
          await input.focus(); await input.fill("未提交的新草稿");
          await input.evaluate(element => { window.__bookRecoverySearch = element; element.setSelectionRange(2, 5);
            element.dispatchEvent(new CompositionEvent("compositionstart", { data: "新", bubbles: true })); });
          await settle(page, retry);
          assert.equal(await input.evaluate(element => element === __bookRecoverySearch), true,
            "book retry completion must keep a newer composing search form connected");
          assert.equal(await input.inputValue(), "未提交的新草稿");
          assert.deepEqual(await input.evaluate(element => [element === document.activeElement, element.selectionStart, element.selectionEnd]), [true, 2, 5],
            "book retry completion must not reclaim newer search focus or selection");
          await input.evaluate(element => element.dispatchEvent(new CompositionEvent("compositionend", { data: "新", bubbles: true })));
          const query = hold(url => url.pathname === "/api/novels" && url.searchParams.get("q") === "未提交的新草稿");
          await input.press("Enter"); await requested(query); await settle(page, query);
          assert.equal(new URL(page.url()).searchParams.get("q"), "未提交的新草稿", "the retained search form must still submit through the current navigation context");
        } finally { await page.close(); }
      });
      await run(`novel import navigation preserves a reader while its selected batch continues ${transport}`, async () => {
        const first = hold((url, req) => url.pathname === "/api/novels/upload" && req.method === "POST");
        const second = hold(first.match);
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/manage" });
        try {
          await page.setViewportSize({ width: 320, height: 740 });
          await page.locator(".novel-management-side-item").filter({ hasText: "书库上传" }).click();
          await page.locator(".novel-upload-input").setInputFiles(["first.txt", "second.txt"].map(name => ({ name, mimeType: "text/plain", buffer: Buffer.from(`第一章 合成\n\n${name} 完全合成正文。`) })));
          await requested(first); await navigateRoute(page, "/novels");
          const row = page.locator(".novel-book-row").filter({ has: page.getByRole("button", { name: "Book B", exact: true }) });
          await row.getByRole("button", { name: "开始阅读", exact: true }).click(); await readerTitle(page, "B", 1);
          await page.getByRole("button", { name: "下一章", exact: true }).click(); await readerTitle(page, "B", 2);
          await page.evaluate(() => { window.__importReader = document.querySelector(".novel-reader-page"); window.__importParagraph = document.querySelector(".novel-reader-content p");
            const range = document.createRange(); range.selectNodeContents(__importParagraph); getSelection().removeAllRanges(); getSelection().addRange(range); window.__importSelection = getSelection().toString(); scrollTo(0, 420); });
          await tick(page); const before = await page.evaluate(() => ({ route: `${location.pathname}${location.search}`, scroll: scrollY }));
          await settle(page, first); await requested(second);
          assert.equal(await page.evaluate(() => __importReader === document.querySelector(".novel-reader-page") && __importParagraph === document.querySelector(".novel-reader-content p") && getSelection().toString() === __importSelection), true,
            "a background TXT import receipt must not rebuild the user's current chapter or discard its selection");
          await settle(page, second); await tick(page);
          assert.deepEqual(await page.evaluate(() => ({ route: `${location.pathname}${location.search}`, scroll: scrollY })), before,
            "finishing a selected TXT batch must not navigate away from the chapter opened in the meantime");
          assert.equal(await page.locator(".novel-reader-paper h1").textContent(), "B Chapter 2");
          const reads = countRequests(url => url.pathname === "/api/novels");
          await page.getByRole("button", { name: "返回列表", exact: true }).click(); await page.locator(".novel-book-row").first().waitFor();
          assert.equal(countRequests(url => url.pathname === "/api/novels"), reads + 1,
            "confirmed background imports must invalidate the source-list cache without repainting the reader");
          await navigateRoute(page, "/novels/manage"); await page.locator(".novel-management-side-item").filter({ hasText: "书库上传" }).click();
          assert.match(await page.locator(".novel-upload-status").textContent(), /已上传 2 本小说/, "returning to imports must expose its completed batch receipt");
        } finally { for (const gate of [first, second]) { gate.release(); held.delete(gate); } await page.close(); }
      });
      await run(`novel import navigation keeps current management controls and its failed receipt ${transport}`, async () => {
        const pending = hold((url, req) => url.pathname === "/api/novels/upload" && req.method === "POST", "Synthetic import failure");
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/manage" });
        try {
          await page.setViewportSize({ width: 320, height: 740 });
          const section = page.locator(".novel-management-side-item").filter({ hasText: "书库上传" }); await section.click();
          const retired = await page.locator(".novel-upload-input").elementHandle();
          await page.locator(".novel-upload-input").setInputFiles({ name: "failed.txt", mimeType: "text/plain", buffer: Buffer.from("第一章 合成\n\n待失败正文。") });
          await requested(pending); await navigateRoute(page, "/novels"); await navigateRoute(page, "/novels/manage"); await section.click();
          assert.equal(await page.getByRole("button", { name: "正在上传", exact: true }).isDisabled(), true);
          const before = uploadWrites.length, reads = countRequests(url => url.pathname === "/api/novels/summary");
          await page.locator(".novel-upload-input").setInputFiles({ name: "duplicate.txt", mimeType: "text/plain", buffer: Buffer.from("第一章 重复\n\n不得并行提交。") }); await tick(page);
          assert.equal(uploadWrites.length, before, "a running import batch must reject a duplicate file-selection event");
          await section.focus(); await page.evaluate(() => { window.__importSection = document.activeElement; });
          await settle(page, pending);
          assert.match(await page.locator(".novel-upload-status").textContent(), /已上传 0 本，失败 1 本：failed.txt：Synthetic import failure/);
          assert.equal(await page.evaluate(() => __importSection === document.activeElement && __importSection.isConnected), true,
            "an import completion must not replace the current management controls or their native focus");
          assert.equal(countRequests(url => url.pathname === "/api/novels/summary"), reads, "returning to management must not let the old import refresh its new navigation");
          const picker = page.getByRole("button", { name: "选择 TXT 文件", exact: true });
          assert.equal(await picker.isEnabled(), true);
          await picker.scrollIntoViewIfNeeded(); assert.equal(await picker.evaluate(button => { const rect = button.getBoundingClientRect(); return button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)); }), true);
          await retired.evaluate(input => { const files = new DataTransfer(); files.items.add(new File(["retired"], "retired.txt", { type: "text/plain" })); input.files = files.files; input.dispatchEvent(new Event("change")); }); await tick(page);
          assert.equal(uploadWrites.length, before, "a detached import picker must not start a new batch after completion");
        } finally { pending.release(); held.delete(pending); await page.close(); }
      });
      await run(`novel import navigation yields during its final summary refresh ${transport}`, async () => {
        const pending = hold((url, req) => url.pathname === "/api/novels/upload" && req.method === "POST");
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/manage" });
        let summary;
        try {
          await page.locator(".novel-management-side-item").filter({ hasText: "书库上传" }).click();
          await page.locator(".novel-upload-input").setInputFiles({ name: "refresh.txt", mimeType: "text/plain", buffer: Buffer.from("第一章 合成\n\n统计刷新中的正文。") });
          await requested(pending); summary = hold(url => url.pathname === "/api/novels/summary"); await settle(page, pending); await requested(summary);
          await navigateRoute(page, "/novels/B/2"); await readerTitle(page, "B", 2);
          await page.evaluate(() => { window.__importRefreshReader = document.querySelector(".novel-reader-page"); });
          await finishOld(page, summary, ignoreAbort);
          assert.equal(await page.evaluate(() => __importRefreshReader === document.querySelector(".novel-reader-page")), true,
            "an obsolete final import summary must not repaint a newer reader");
          assert.equal(new URL(page.url()).pathname, "/novels/B/2");
        } finally { for (const gate of [pending, summary].filter(Boolean)) { gate.release(); held.delete(gate); } await page.close(); }
      });
      await run(`novel import navigation updates its overview in place and yields to management sections ${transport}`, async () => {
        for (const leave of [false, true]) {
          const pending = hold((url, req) => url.pathname === "/api/novels/upload" && req.method === "POST");
          const page = await newPage({ real: true, ignoreAbort, route: "/novels/manage" });
          let summary, newer;
          try {
            const section = page.locator(".novel-management-side-item").filter({ hasText: "书库上传" }); await section.click();
            summary = hold(url => url.pathname === "/api/novels/summary", "", { totals: { books: 123, chapters: 456, chars: 789, bytes: 999 }, scannedAt: "2026-01-01T00:00:00Z" });
            await page.locator(".novel-upload-input").setInputFiles({ name: "overview.txt", mimeType: "text/plain", buffer: Buffer.from("第一章 合成\n\n原位更新统计。") });
            await requested(pending); await settle(page, pending); await requested(summary);
            if (leave) {
              await page.locator(".novel-management-side-item").filter({ hasText: "站点配置" }).click();
              newer = hold(url => url.pathname === "/api/novels/summary", "Latest overview failure");
              await section.click();
              await requested(newer); await settle(page, newer);
            }
            await section.focus(); await page.evaluate(() => { window.__importOverview = document.querySelector(".novel-management"); window.__importOverviewFocus = document.activeElement; window.__importStats = document.querySelector("#statsRow").textContent; });
            if (leave) await finishOld(page, summary, ignoreAbort); else await settle(page, summary);
            assert.equal(await page.evaluate(() => __importOverview === document.querySelector(".novel-management") && __importOverviewFocus === document.activeElement), true,
              "an upload summary refresh must retain the current management panel and native focus");
            if (leave) assert.equal(await page.locator("#statsRow").textContent(), await page.evaluate(() => __importStats),
              "an aborted upload summary must not publish into the reopened management section");
            else {
              assert.equal(await page.locator('[data-novel-upload-metric="books"]').textContent(), "123");
              assert.equal(await page.locator('[data-novel-upload-metric="chapters"]').textContent(), "456");
              assert.equal(await page.locator('[data-novel-upload-metric="library"]').textContent(), "123 本 · 456 章");
            }
            if (leave) assert.match(await page.locator(".novel-upload-status").textContent(), /已上传 1 本小说；书库统计暂未更新：Latest overview failure/,
              "an older import finalizer must preserve the newer overview read's failure receipt");
            else await page.getByText("已上传 1 本小说", { exact: true }).waitFor();
            assert.equal(await page.getByRole("button", { name: "选择 TXT 文件", exact: true }).isEnabled(), true);
          } finally { for (const gate of [pending, summary, newer].filter(Boolean)) { gate.release(); held.delete(gate); } await page.close(); }
        }
      });
      await run(`novel import navigation refreshes stale numbers when returning to upload ${transport}`, async () => {
        const pending = hold((url, req) => url.pathname === "/api/novels/upload" && req.method === "POST");
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/manage" });
        let summary;
        try {
          const upload = page.locator(".novel-management-side-item").filter({ hasText: "书库上传" }); await upload.click();
          await page.locator(".novel-upload-input").setInputFiles({ name: "outside.txt", mimeType: "text/plain", buffer: Buffer.from("第一章 合成\n\n切到配置时结束导入。") });
          await requested(pending); await page.locator(".novel-management-side-item").filter({ hasText: "站点配置" }).click(); await settle(page, pending);
          summary = hold(url => url.pathname === "/api/novels/summary", "", { totals: { books: 123, chapters: 456, chars: 789, bytes: 999 } });
          const before = countRequests(summary.match); await upload.click(); await tick(page);
          assert.equal(countRequests(summary.match), before + 1, "returning to upload must freshly read statistics invalidated by its completed background batch");
          await requested(summary); await upload.focus(); await page.evaluate(() => { window.__returnedImportFocus = document.activeElement; }); await settle(page, summary);
          assert.equal(await page.locator('[data-novel-upload-metric="books"]').textContent(), "123");
          assert.equal(await page.locator('[data-novel-upload-metric="chapters"]').textContent(), "456");
          assert.equal(await page.evaluate(() => __returnedImportFocus === document.activeElement && __returnedImportFocus.isConnected), true);
          assert.match(await page.locator(".novel-upload-status").textContent(), /已上传 1 本小说/);
        } finally { for (const gate of [pending, summary].filter(Boolean)) { gate.release(); held.delete(gate); } await page.close(); }
      });
      await run(`novel import navigation refreshes after a newer file commits during returned statistics ${transport}`, async () => {
        const first = hold((url, req) => url.pathname === "/api/novels/upload" && req.method === "POST"), second = hold(first.match);
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/manage" });
        let old, fresh;
        try {
          const upload = page.locator(".novel-management-side-item").filter({ hasText: "书库上传" }); await upload.click();
          const before = uploadWrites.length;
          await page.locator(".novel-upload-input").setInputFiles(["first-returned.txt", "second-returned.txt"].map(name => ({ name, mimeType: "text/plain", buffer: Buffer.from("第一章 合成\n\n统计交错中的正文。") })));
          await requested(first); await settle(page, first); await requested(second);
          await navigateRoute(page, "/novels"); await navigateRoute(page, "/novels/manage");
          await page.locator(".novel-management-side-item").filter({ hasText: "站点配置" }).click();
          const summaryMatch = url => url.pathname === "/api/novels/summary";
          old = hold(summaryMatch, "", { totals: { books: 3, chapters: 9, chars: 54000, bytes: 162000 } });
          await upload.click(); await requested(old);
          fresh = hold(summaryMatch, "", { totals: { books: 4, chapters: 12, chars: 72000, bytes: 216000 } });
          const reads = countRequests(summaryMatch);
          await settle(page, second); await page.getByText("已上传 2 本小说", { exact: true }).waitFor();
          await upload.focus(); await page.evaluate(() => { window.__returnedSummaryPanel = document.querySelector(".novel-management"); window.__returnedSummaryFocus = document.activeElement; });
          await settle(page, old); await tick(page);
          assert.equal(countRequests(summaryMatch), reads + 1, "a returned overview read superseded by another confirmed file must obtain a fresh snapshot instead of leaving only a dirty flag");
          await requested(fresh);
          assert.notEqual(await page.locator('[data-novel-upload-metric="books"]').textContent(), "3", "statistics captured before the latest confirmed file must not be published");
          await settle(page, fresh);
          assert.equal(await page.locator('[data-novel-upload-metric="books"]').textContent(), "4");
          assert.equal(await page.locator('[data-novel-upload-metric="chapters"]').textContent(), "12");
          assert.equal(uploadWrites.length, before + 2, "refreshing the overview must never resubmit either selected file");
          assert.equal(await page.evaluate(() => __returnedSummaryPanel === document.querySelector(".novel-management") && __returnedSummaryFocus === document.activeElement), true);
        } finally { for (const gate of [first, second, old, fresh].filter(Boolean)) { gate.release(); held.delete(gate); } await page.close(); }
      });
      await run(`novel import navigation stops old-account files and permits a new-account import ${transport}`, async () => {
        const pending = hold((url, req) => url.pathname === "/api/novels/upload" && req.method === "POST");
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/manage" });
        let summary, recovered;
        try {
          await page.locator(".novel-management-side-item").filter({ hasText: "书库上传" }).click();
          const before = uploadWrites.length;
          await page.locator(".novel-upload-input").setInputFiles(["old-first.txt", "old-second.txt"].map(name => ({ name, mimeType: "text/plain", buffer: Buffer.from("第一章 旧账号\n\n合成正文。") })));
          await requested(pending); await page.evaluate(async () => { const { publishWebAccountChange } = await import("/platform/accounts/session-context.js"); publishWebAccountChange("fixture-import-other"); });
          await settle(page, pending); await tick(page);
          assert.equal(uploadWrites.length, before + 1, "an account switch must stop unsubmitted files from the old selected batch");
          assert.equal(await page.locator(".novel-upload-status").textContent(), "", "the new account must not display the old batch's receipt");
          assert.equal(await page.getByRole("button", { name: "选择 TXT 文件", exact: true }).isEnabled(), true);
          summary = hold(url => url.pathname === "/api/novels/summary", "Synthetic summary refresh failure");
          await page.locator(".novel-upload-input").setInputFiles({ name: "new-account.txt", mimeType: "text/plain", buffer: Buffer.from("第一章 新账号\n\n合成正文。") });
          await requested(summary); await settle(page, summary);
          assert.deepEqual(uploadWrites.slice(before).map(body => body.fileName), ["old-first.txt", "new-account.txt"]);
          assert.match(await page.locator(".novel-upload-status").textContent(), /已上传 1 本小说；书库统计暂未更新：Synthetic summary refresh failure/,
            "a failed summary refresh must retain the confirmed import count and its refresh error");
          assert.equal(await page.getByRole("button", { name: "选择 TXT 文件", exact: true }).isEnabled(), true);
          recovered = hold(url => url.pathname === "/api/novels/summary");
          await page.locator(".novel-management-side-item").filter({ hasText: "站点配置" }).click();
          await page.locator(".novel-management-side-item").filter({ hasText: "书库上传" }).click();
          await requested(recovered); await settle(page, recovered);
          assert.equal(await page.locator(".novel-upload-status").textContent(), "已上传 1 本小说", "a successful current overview refresh must clear its prior statistics warning without losing the import receipt");
        } finally { for (const gate of [pending, summary, recovered].filter(Boolean)) { gate.release(); held.delete(gate); } await page.close(); }
      });
      await run(`novel upload preserves BOM-selected Chinese text and legacy encodings ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/manage" });
        try {
          await page.locator(".novel-management-side-item").filter({ hasText: "书库上传" }).click();
          const content = "合成书名\n作者：测试\n\n第一章 春风\n\n中文正文😀，保留标点与换行。";
          const littleEndian = Buffer.from(content, "utf16le");
          const bigEndian = Buffer.from(littleEndian).swap16();
          const legacy = "Chapter 1\n\n中文测试";
          const before = uploadWrites.length;
          const files = [
            { name: "synthetic-utf16le.txt", mimeType: "text/plain", buffer: Buffer.concat([Buffer.from([0xff, 0xfe]), littleEndian]) },
            { name: "synthetic-utf16be.txt", mimeType: "text/plain", buffer: Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian]) },
            { name: "synthetic-utf8.txt", mimeType: "text/plain", buffer: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content)]) },
            { name: "synthetic-gbk.txt", mimeType: "text/plain", buffer: Buffer.concat([Buffer.from("Chapter 1\n\n"), Buffer.from("d6d0cec4b2e2cad4", "hex")]) }
          ];
          await page.locator(".novel-upload-input").setInputFiles(files);
          await until(() => uploadWrites.length === before + files.length, "the selected synthetic files must reach the controlled upload endpoint");
          await page.getByText("已上传 4 本小说", { exact: true }).waitFor();
          const submitted = uploadWrites.slice(before);
          console.log(`MEASURE novel upload encoding ${transport}: ${JSON.stringify(submitted.map(entry => ({ file: entry.fileName, encoding: entry.encoding, starts: [...entry.text.slice(0, 8)].map(char => char.codePointAt(0).toString(16)) })))}`);
          assert.deepEqual(submitted.map(entry => ({ encoding: entry.encoding, text: entry.text })), [
            { encoding: "utf-16le", text: content }, { encoding: "utf-16be", text: content },
            { encoding: "utf-8", text: content }, { encoding: "gb18030", text: legacy }
          ], "TXT import must honor a UTF-16 BOM instead of submitting Chinese mojibake, while preserving UTF-8 and legacy GB18030 decoding");
          assert.deepEqual(submitted.map(entry => entry.sizeBytes), files.map(file => file.buffer.length));
          const { createNovelStore } = await import("../src/modules/novels/server/store.js");
          const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-novel-upload-encoding-"));
          try {
            const store = createNovelStore({ dbPath: path.join(temporary, "parser.sqlite") });
            for (const body of submitted.slice(0, 3)) {
              const imported = store.uploadBook(body);
              const parsed = imported.chapters.find(chapter => chapter.title === "第一章 春风");
              assert(parsed, "the real upload parser must recognize the original Chinese chapter title from the browser's submitted text");
              assert.equal(store.chapterDetail(imported.book.id, parsed.index).chapter.content, "中文正文😀，保留标点与换行。",
                "the real temporary SQLite chapter must preserve the submitted Chinese and valid surrogate pair");
              assert.equal(imported.book.author, "测试");
            }
          } finally {
            for (const name of ["parser.sqlite", "parser.sqlite-journal", "parser.sqlite-wal", "parser.sqlite-shm"]) {
              try { fs.unlinkSync(path.join(temporary, name)); } catch (error) { if (error.code !== "ENOENT") throw error; }
            }
            fs.rmdirSync(temporary);
          }
        } finally { await page.close(); }
      });
      await run(`novel upload rejects damaged BOM text before posting and remains retryable ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/manage" });
        try {
          await page.locator(".novel-management-side-item").filter({ hasText: "书库上传" }).click();
          const before = uploadWrites.length;
          for (const [name, bytes] of [
            ["odd-le.txt", [0xff, 0xfe, 0x2d]], ["odd-be.txt", [0xfe, 0xff, 0x4e]],
            ["high-le.txt", [0xff, 0xfe, 0x00, 0xd8, 0x41, 0x00]], ["low-be.txt", [0xfe, 0xff, 0xdc, 0x00]]
          ]) {
            await page.locator(".novel-upload-input").setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(bytes) });
            await page.waitForFunction(() => /^已上传 \d+ 本(?:小说|，失败)/.test(document.querySelector(".novel-management-status")?.textContent || ""));
            assert.equal(uploadWrites.length, before, "damaged UTF-16 must fail locally instead of posting replacement text");
            assert.match(await page.locator(".novel-management-status").textContent(), new RegExp(`已上传 0 本，失败 1 本：${name}：UTF-16(?:LE|BE) 文本不完整`),
              "the final upload receipt must retain the failed file name and decoding error after the summary refresh");
            assert.equal(await page.getByRole("button", { name: "选择 TXT 文件", exact: true }).isEnabled(), true,
              "a malformed file must leave the real picker available for a corrected file");
          }
          const corrected = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("第一章 合成\n\n修正后的正文。", "utf16le")]);
          await page.locator(".novel-upload-input").setInputFiles({ name: "corrected.txt", mimeType: "text/plain", buffer: corrected });
          await page.getByText("已上传 1 本小说", { exact: true }).waitFor();
          assert.equal(uploadWrites.length, before + 1);
          assert.equal(uploadWrites.at(-1).text, "第一章 合成\n\n修正后的正文。");
          assert.equal(await page.getByText(/文本不完整或包含无效字符/).count(), 0, "a corrected file must clear the previous decoding error");
        } finally { await page.close(); }
      });
      await run(`novel upload continues a mixed batch and bounds visible failures ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/manage" });
        try {
          await page.setViewportSize({ width: 320, height: 740 });
          await page.locator(".novel-management-side-item").filter({ hasText: "书库上传" }).click();
          const before = uploadWrites.length;
          const files = Array.from({ length: 5 }, (_, index) => ({ name: `broken-${index}.txt`, mimeType: "text/plain", buffer: Buffer.from([0xff, 0xfe, 0x41]) }));
          files.splice(2, 0, { name: "valid.txt", mimeType: "text/plain", buffer: Buffer.from("第一章 合成\n\n中途的有效正文。") });
          await page.locator(".novel-upload-input").setInputFiles(files);
          await page.getByText(/已上传 1 本，失败 5 本：/).waitFor();
          assert.deepEqual(uploadWrites.slice(before).map(body => [body.fileName, body.text, body.encoding]), [["valid.txt", "第一章 合成\n\n中途的有效正文。", "utf-8"]],
            "invalid encoded files must not stop or duplicate the later valid file in the same selected batch");
          const status = await page.locator(".novel-management-status").textContent();
          for (const index of [0, 1, 2]) assert(status.includes(`broken-${index}.txt`));
          for (const index of [3, 4]) assert(!status.includes(`broken-${index}.txt`));
          assert(status.includes("另 2 本失败"), "large failure batches must keep the visible error receipt bounded with an accurate remainder");
          assert.equal(await page.locator(".novel-management-status").evaluate(element => element.scrollWidth <= element.clientWidth), true,
            "the bounded import error receipt must remain readable at a 320px viewport");
        } finally { await page.close(); }
      });
      await run(`novel upload decoding also protects the existing reimport picker ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/A" });
        try {
          await detailTitle(page, "Book A"); await page.locator(".novel-detail-tools summary").click();
          await page.getByRole("button", { name: "重新导入", exact: true }).click();
          const dialog = page.locator("dialog.novel-reimport-dialog");
          const before = countRequests(url => url.pathname === "/api/novels/A/reimport");
          await dialog.locator('input[type="file"]').setInputFiles({ name: "broken-be.txt", mimeType: "text/plain", buffer: Buffer.from([0xfe, 0xff, 0xd8, 0x00]) });
          await dialog.getByText(/UTF-16BE 文本不完整或包含无效字符/).waitFor();
          assert.equal(countRequests(url => url.pathname === "/api/novels/A/reimport"), before);
          const text = "第一章 合成\n\n重新导入的中文😀正文。";
          const corrected = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]);
          const request = hold((url, req) => url.pathname === "/api/novels/A/reimport" && req.method === "POST");
          await dialog.locator('input[type="file"]').setInputFiles({ name: "corrected-be.txt", mimeType: "text/plain", buffer: corrected });
          await requested(request);
          assert.equal(request.body.text, text, "reimport must use the same strict BOM decoding as the batch picker");
          assert.equal(request.body.encoding, "utf-16be");
          await settle(page, request);
          await dialog.getByText(/重新导入完成/).waitFor();
        } finally { await page.close(); }
      });
      await run(`reader fullscreen preserves native long chapter reading ${transport}`, async () => {
        const reply = chapterResponse("A", 1);
        reply.chapter.content = Array.from({ length: 1000 }, (_, index) => `Synthetic fullscreen paragraph ${index}. 完全合成的长章节正文。`).join("\n\n");
        const initial = hold(url => url.pathname === "/api/novels/A/chapters/1", "", reply);
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/A/1", waitReady: false });
        try {
          await requested(initial); await settle(page, initial); await readerTitle(page, "A", 1); await ready(page);
          await page.locator('[data-reader-focus="toolbar-设置"]').click();
          const control = page.getByRole("button", { name: "全屏阅读", exact: true });
          if (!await control.count()) {
            await page.evaluate(() => {
              const probe = document.createElement("button"); probe.id = "nativeFullscreenProbe"; probe.textContent = "Native fullscreen probe";
              probe.style.cssText = "position:fixed;top:0;left:0;z-index:100000";
              probe.addEventListener("click", () => document.documentElement.requestFullscreen()); document.body.append(probe);
            });
            await page.locator("#nativeFullscreenProbe").click();
            await page.waitForFunction(() => document.fullscreenElement === document.documentElement);
            console.log(`MEASURE native novel fullscreen ${transport}: ${JSON.stringify(await page.evaluate(() => ({ enabled: document.fullscreenEnabled, width: innerWidth, height: innerHeight, paragraphs: document.querySelectorAll('.novel-reader-content p').length })))}`);
            await page.evaluate(() => document.exitFullscreen());
          }
          assert.equal(await control.count(), 1, "a supported reader must offer native fullscreen reading without a browser menu");
          await page.evaluate(() => {
            window.__fullscreenPage = document.querySelector(".novel-reader-page");
            window.__fullscreenParagraphs = [...document.querySelectorAll(".novel-reader-content p")];
            const paragraph = __fullscreenParagraphs[500];
            window.scrollTo(0, paragraph.getBoundingClientRect().top + scrollY - 160);
          });
          await control.focus();
          await page.evaluate(() => {
            const range = document.createRange(); range.setStart(__fullscreenParagraphs[500].firstChild, 2); range.setEnd(__fullscreenParagraphs[500].firstChild, 12);
            const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
            window.__fullscreenAnchorTop = __fullscreenParagraphs[500].getBoundingClientRect().top;
            window.__fullscreenSelection = selection.toString();
          });
          const checkReading = async () => {
            const reading = await page.evaluate(() => ({ page: __fullscreenPage === document.querySelector(".novel-reader-page"),
              paragraphs: __fullscreenParagraphs.every(paragraph => paragraph.isConnected), count: document.querySelectorAll(".novel-reader-content p").length,
              selection: getSelection().toString() === __fullscreenSelection, top: __fullscreenParagraphs[500].getBoundingClientRect().top - __fullscreenAnchorTop,
              focus: document.activeElement?.dataset.readerFocus }));
            assert.deepEqual(reading, { page: true, paragraphs: true, count: 1000, selection: true, top: 0, focus: "fullscreen-toggle" },
              "native fullscreen must preserve the existing long chapter, Range, viewport anchor and keyboard focus");
          };
          await control.press("Enter"); await page.waitForFunction(() => document.fullscreenElement === document.documentElement); await tick(page);
          await checkReading();
          const ratio = await page.evaluate(() => { const page = document.querySelector(".novel-reader-page");
            return (scrollY - (page.getBoundingClientRect().top + scrollY)) / (page.scrollHeight - innerHeight); });
          await until(() => progressWrites.some(write => write.bookId === "A" && write.chapterId === "A-1" && Math.abs(write.scrollRatio - ratio) < .0001),
            "fullscreen reading must persist the actual current scroll position through the existing progress writer");
          const exit = page.getByRole("button", { name: "退出全屏", exact: true });
          await exit.press("Enter"); await page.waitForFunction(() => !document.fullscreenElement); await tick(page);
          await checkReading();
          await control.press("Enter"); await page.waitForFunction(() => document.fullscreenElement === document.documentElement); await tick(page);
          await page.evaluate(() => document.exitFullscreen()); await tick(page);
          assert.equal(await control.count(), 1, "external/native fullscreen exit must update the existing control");
          await checkReading();
          await control.press("Enter"); await page.waitForFunction(() => document.fullscreenElement === document.documentElement); await tick(page);
          await page.getByRole("button", { name: "完成", exact: true }).click();
          await page.locator(".novel-reader-bottom button").filter({ hasText: "下一章" }).click(); await readerTitle(page, "A", 2);
          assert.equal(await page.evaluate(() => document.fullscreenElement === document.documentElement), true, "adjacent chapters must keep native fullscreen reading");
          await page.goBack(); await readerTitle(page, "A", 1);
          assert.equal(await page.evaluate(() => document.fullscreenElement === document.documentElement), true, "chapter history navigation must keep native fullscreen reading");
          await page.goForward(); await readerTitle(page, "A", 2);
          assert.equal(await page.evaluate(() => document.fullscreenElement === document.documentElement), true);
          await page.locator('[data-reader-focus="toolbar-书页"]').click(); await detailTitle(page, "Book A");
          await page.waitForFunction(() => !document.fullscreenElement);
        } finally { await page.close(); }
      });
      await run(`reader fullscreen is reachable on narrow screens ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/A/1" });
        try {
          await readerTitle(page, "A", 1);
          for (const width of [320, 390]) {
            await page.setViewportSize({ width, height: 720 });
            await page.locator('[data-reader-focus="toolbar-设置"]').click();
            const control = page.getByRole("button", { name: "全屏阅读", exact: true });
            await control.scrollIntoViewIfNeeded();
            assert.equal(await control.evaluate(button => { const rect = button.getBoundingClientRect();
              return rect.width >= 44 && rect.height >= 44 && rect.left >= 0 && rect.right <= innerWidth
                && button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)); }), true,
              "fullscreen must have an actual reachable 44px target on narrow screens");
            await control.click(); await page.waitForFunction(() => document.fullscreenElement === document.documentElement); await tick(page);
            if (width === 320 && ignoreAbort && process.argv.includes("--screenshots")) {
              const output = path.join(root, ".codex-artifacts", "novels"); await fs.promises.mkdir(output, { recursive: true });
              await page.screenshot({ path: path.join(output, "reader-fullscreen-320.png") });
            }
            await page.getByRole("button", { name: "退出全屏", exact: true }).click(); await page.waitForFunction(() => !document.fullscreenElement); await tick(page);
            await page.getByRole("button", { name: "完成", exact: true }).click();
          }
        } finally { await page.close(); }
      });
      await run(`reader fullscreen preserves the settling viewport anchor ${transport}`, async () => {
        const reply = chapterResponse("A", 1);
        reply.chapter.content = Array.from({ length: 1000 }, (_, index) => `Synthetic fullscreen viewport paragraph ${index}. ${"合成的换行正文用于验证宽度变化后的阅读锚点。".repeat(8)}`).join("\n\n");
        const initial = hold(url => url.pathname === "/api/novels/A/chapters/1", "", reply);
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/A/1", waitReady: false });
        try {
          await requested(initial); await settle(page, initial); await readerTitle(page, "A", 1); await ready(page);
          await page.locator('[data-reader-focus="toolbar-设置"]').click();
          await page.getByRole("button", { name: "全屏阅读", exact: true }).focus();
          await page.evaluate(() => {
            const native = document.documentElement.requestFullscreen.bind(document.documentElement);
            document.documentElement.requestFullscreen = async () => { await native(); await new Promise(resolve => { window.__releaseFullscreen = resolve; }); };
            window.__fullscreenAnchor = document.querySelectorAll(".novel-reader-content p")[500];
            window.scrollTo(0, __fullscreenAnchor.getBoundingClientRect().top + scrollY - 1);
            window.__fullscreenAnchorTop = __fullscreenAnchor.getBoundingClientRect().top;
          });
          await page.getByRole("button", { name: "全屏阅读", exact: true }).press("Enter");
          await page.waitForFunction(() => document.fullscreenElement === document.documentElement && Boolean(window.__releaseFullscreen));
          // A real browser viewport reflow while the native transition completes.
          // Disable browser scroll anchoring only in this controlled layout fixture so
          // the app's own transition restoration has an observable responsibility.
          await page.addStyleTag({ content: "html, body, * { overflow-anchor: none !important; }" });
          await page.setViewportSize({ width: 980, height: 760 });
          await page.evaluate(() => __releaseFullscreen()); await tick(page);
          assert(Math.abs(await page.evaluate(() => __fullscreenAnchor.getBoundingClientRect().top - __fullscreenAnchorTop)) < 1,
            "fullscreen viewport settling must restore the original paragraph anchor after actual reflow");
          assert.equal(await page.evaluate(() => __fullscreenAnchor.isConnected), true);
          await page.evaluate(() => document.exitFullscreen());
        } finally { await page.close(); }
      });
      await run(`reader fullscreen recovers from rejection and ignores detached controls ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/A/1" });
        try {
          await readerTitle(page, "A", 1); await page.locator('[data-reader-focus="toolbar-设置"]').click();
          await page.evaluate(() => {
            const native = document.documentElement.requestFullscreen.bind(document.documentElement); window.__fullscreenCalls = 0;
            document.documentElement.requestFullscreen = () => { __fullscreenCalls++; return __fullscreenCalls === 1 ? Promise.reject(new Error("synthetic fullscreen denial")) : native(); };
            window.__oldFullscreenButton = document.querySelector('[data-reader-focus="fullscreen-toggle"]');
          });
          const control = page.getByRole("button", { name: "全屏阅读", exact: true });
          await control.click(); await page.getByRole("status").filter({ hasText: "无法切换全屏" }).waitFor();
          assert.equal(await control.getAttribute("aria-busy"), "false");
          await control.click(); await page.waitForFunction(() => document.fullscreenElement === document.documentElement); await tick(page);
          await page.evaluate(() => { const native = document.exitFullscreen.bind(document); window.__nativeExitFullscreen = native;
            document.exitFullscreen = () => Promise.reject(new Error("synthetic exit denial")); });
          await page.getByRole("button", { name: "退出全屏", exact: true }).click();
          await page.getByRole("status").filter({ hasText: "无法切换全屏" }).waitFor();
          assert.equal(await page.evaluate(() => document.fullscreenElement === document.documentElement), true);
          await page.evaluate(() => { document.exitFullscreen = __nativeExitFullscreen; });
          await page.getByRole("button", { name: "退出全屏", exact: true }).click(); await page.waitForFunction(() => !document.fullscreenElement); await tick(page);
          await page.getByRole("button", { name: "完成", exact: true }).click();
          await page.locator(".novel-reader-bottom button").filter({ hasText: "下一章" }).click(); await readerTitle(page, "A", 2);
          await page.evaluate(() => __oldFullscreenButton.click()); await tick(page);
          assert.equal(await page.evaluate(() => __fullscreenCalls), 2, "a detached old chapter's fullscreen action must be inert");
          assert.equal(await page.evaluate(() => document.fullscreenElement), null);
        } finally { await page.close(); }
      });
      await run(`reader fullscreen respects newer navigation and scroll intent ${transport}`, async () => {
        const reply = chapterResponse("A", 1);
        reply.chapter.content = Array.from({ length: 1000 }, (_, index) => `Synthetic fullscreen intent ${index}.`).join("\n\n");
        const initial = hold(url => url.pathname === "/api/novels/A/chapters/1", "", reply);
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/A/1", waitReady: false });
        try {
          await requested(initial); await settle(page, initial); await readerTitle(page, "A", 1); await ready(page);
          await page.locator('[data-reader-focus="toolbar-设置"]').click();
          await page.evaluate(() => {
            const native = document.documentElement.requestFullscreen.bind(document.documentElement);
            window.__fullscreenCalls = 0;
            document.documentElement.requestFullscreen = async () => { __fullscreenCalls++; await native(); await new Promise(resolve => { window.__releaseFullscreen = resolve; }); };
          });
          await page.getByRole("button", { name: "全屏阅读", exact: true }).click();
          await page.waitForFunction(() => document.fullscreenElement === document.documentElement && Boolean(window.__releaseFullscreen));
          await page.evaluate(() => document.querySelector('[data-reader-focus="fullscreen-toggle"]').click());
          assert.equal(await page.evaluate(() => __fullscreenCalls), 1, "a pending native transition must remain single flight");
          await page.evaluate(() => {
            document.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 500 })); window.scrollTo(0, 700);
          });
          await page.getByRole("button", { name: "楷书", exact: true }).focus();
          const top = await page.evaluate(() => scrollY);
          await page.evaluate(() => __releaseFullscreen()); await tick(page);
          assert.equal(await page.evaluate(() => scrollY), top, "a late fullscreen completion must yield to newer scrolling");
          assert.equal(await page.getByRole("button", { name: "楷书", exact: true }).evaluate(button => button === document.activeElement), true,
            "a late fullscreen completion must not reclaim settings focus");
          await page.getByRole("button", { name: "退出全屏", exact: true }).click(); await page.waitForFunction(() => !document.fullscreenElement); await tick(page);
          await page.getByRole("button", { name: "全屏阅读", exact: true }).click();
          await page.waitForFunction(() => document.fullscreenElement === document.documentElement && document.querySelector('[data-reader-focus="fullscreen-toggle"]').getAttribute("aria-busy") === "true");
          await page.locator('[data-reader-focus="toolbar-书页"]').click(); await detailTitle(page, "Book A");
          await page.waitForFunction(() => !document.fullscreenElement);
          await page.evaluate(() => __releaseFullscreen()); await tick(page);
          assert.equal(await page.locator(".novel-settings-panel").count(), 0);
          assert.equal(await page.evaluate(() => document.fullscreenElement), null, "an old enter completion must not leave a detail page in reader-owned fullscreen");
        } finally { await page.close(); }
      });
      await run(`reader fullscreen leaves external ownership untouched ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/A/1" });
        try {
          await readerTitle(page, "A", 1);
          await page.evaluate(() => {
            const probe = document.createElement("button"); probe.id = "externalFullscreen"; probe.textContent = "External fullscreen";
            probe.style.cssText = "position:fixed;top:0;left:0;z-index:100000";
            probe.onclick = () => document.documentElement.requestFullscreen(); document.body.append(probe);
          });
          await page.locator("#externalFullscreen").click(); await page.waitForFunction(() => document.fullscreenElement === document.documentElement);
          await page.locator('[data-reader-focus="toolbar-书页"]').click(); await detailTitle(page, "Book A"); await tick(page);
          assert.equal(await page.evaluate(() => document.fullscreenElement === document.documentElement), true, "leaving the reader must not exit fullscreen acquired by a different owner");
          await page.locator(".novel-detail-actions button").filter({ hasText: /开始阅读|继续阅读/ }).first().click(); await readerTitle(page, "A", 1);
          await page.locator('[data-reader-focus="toolbar-设置"]').click();
          assert.equal(await page.locator(".novel-reader-fullscreen").isVisible(), false);
          await page.evaluate(() => document.exitFullscreen());
          await page.getByRole("button", { name: "全屏阅读", exact: true }).waitFor();
          assert.equal(await page.locator(".novel-reader-fullscreen").count(), 1, "native fullscreen changes must reveal the existing supported control without replacing settings");
          await page.locator('[data-reader-focus="toolbar-书页"]').click(); await detailTitle(page, "Book A");
          await page.evaluate(() => Object.defineProperty(document, "fullscreenEnabled", { value: false, configurable: true }));
          await page.locator(".novel-detail-actions button").filter({ hasText: /开始阅读|继续阅读/ }).first().click(); await readerTitle(page, "A", 1);
          await page.locator('[data-reader-focus="toolbar-设置"]').click();
          assert.equal(await page.locator(".novel-reader-fullscreen").count(), 0, "unsupported hosts must retain the original reading controls without a dead fullscreen action");
        } finally { await page.close(); }
      });
      await run(`reader fullscreen returns to the source list anchor ${transport}`, async () => {
        const data = libraryPage(96); data.books[50] = book("A");
        const reply = chapterResponse("A", 1);
        reply.chapter.content = Array.from({ length: 1000 }, (_, index) => `Synthetic fullscreen return paragraph ${index}.`).join("\n\n");
        const initial = hold(url => url.pathname === "/api/novels/A/chapters/1", "", reply);
        const page = await newPage({ real: true, ignoreAbort });
        try {
          await openOriginLibrary(page, data);
          // The source key includes its realm; locate through the actual title instead.
          const title = page.locator(".novel-book-title").filter({ hasText: /^Book A$/ });
          const source = title.locator("xpath=ancestor::article");
          const action = source.locator(".novel-book-actions button").last();
          await action.scrollIntoViewIfNeeded(); await action.focus(); await tick(page);
          const top = await source.evaluate(entry => entry.getBoundingClientRect().top);
          await action.press("Enter"); await requested(initial); await settle(page, initial); await readerTitle(page, "A", 1);
          await page.locator('[data-reader-focus="toolbar-设置"]').click();
          await page.getByRole("button", { name: "全屏阅读", exact: true }).click();
          await page.waitForFunction(() => document.fullscreenElement === document.documentElement); await tick(page);
          await page.getByRole("button", { name: "完成", exact: true }).click();
          await page.getByRole("button", { name: "返回列表", exact: true }).click();
          await page.waitForFunction(() => !document.fullscreenElement); await source.waitFor(); await tick(page);
          assert.equal(await page.locator(".novel-book-row").count(), 96);
          assert(Math.abs(await source.evaluate(entry => entry.getBoundingClientRect().top) - top) < 2,
            "returning from native fullscreen must exit before restoring the source list anchor");
          assert.equal(await action.evaluate(button => button === document.activeElement), true);
        } finally { libraryFeed = null; await page.close(); }
      });
      await run(`library origin returns to loaded search conditions and book anchor ${transport}`, async () => {
        const data = libraryPage(96);
        data.books.forEach((entry, index) => { entry.title = index < 50 ? `Book ${String(index).padStart(4, "0")}` : `Book B${index}`; });
        data.books[50] = book("A");
        const first = hold(url => url.pathname === "/api/novels" && url.searchParams.get("offset") === "0", "", { ...data, books: data.books.slice(0, 48), offset: 0 });
        const second = hold(url => url.pathname === "/api/novels" && url.searchParams.get("offset") === "48", "", { ...data, books: data.books.slice(48), offset: 48 });
        const page = await newPage({ real: true, ignoreAbort, route: "/novels?q=Book&category=Fixture&sort=title", waitReady: false });
        try {
          await requested(first); await settle(page, first); await ready(page);
          await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
          await requested(second); await settle(page, second);
          assert.equal(await page.locator(".novel-book-row").count(), 96);
          const source = page.locator(".novel-book-title").filter({ hasText: /^Book A$/ });
          await source.scrollIntoViewIfNeeded(); await source.focus(); await tick(page);
          const top = await source.evaluate(button => button.closest(".novel-book-row").getBoundingClientRect().top);
          const reads = countRequests(url => url.pathname === "/api/novels");
          await source.press("Enter"); await detailTitle(page, "Book A");
          const back = page.getByRole("button", { name: "返回列表", exact: true });
          const available = await back.count();
          if (!available) {
            await page.locator(".novel-breadcrumbs button").filter({ hasText: "小说书库" }).click();
            await page.locator(".novel-book-row").first().waitFor();
            console.log(`MEASURE missing list return ${transport}: ${JSON.stringify(await page.evaluate(() => ({ query: document.querySelector('.novel-section-search input').value, sort: document.querySelector('.novel-sort').value, rows: document.querySelectorAll('.novel-book-row').length, url: location.pathname + location.search })))}`);
          }
          assert.equal(available, 1, "an opened library book must offer a return to its exact source list");
          await back.click(); await tick(page);
          assert.equal(countRequests(url => url.pathname === "/api/novels"), reads, "an unchanged library return must reuse the entire loaded prefix");
          await page.locator(".novel-book-row").nth(95).waitFor(); await tick(page);
          assert.equal(await page.locator(".novel-section-search input").inputValue(), "Book");
          assert.equal(await page.locator(".novel-sort").inputValue(), "title");
          assert.equal(new URL(page.url()).searchParams.get("category"), "Fixture");
          assert(Math.abs(await source.evaluate(button => button.closest(".novel-book-row").getBoundingClientRect().top) - top) < 2, "returning must restore the source book's viewport anchor");
          assert.equal(await source.evaluate(button => button === document.activeElement), true, "a keyboard-opened book must return focus to its original list action");
        } finally { await page.close(); }
      });
      for (const mode of ["reader", "author", "mine", "rankings"]) await run(`library origin preserves ${mode} source ${transport}`, async () => {
        const data = mode === "rankings" ? rankingPage(48) : libraryPage(mode === "mine" ? 2 : 48);
        const index = mode === "mine" ? 0 : 20;
        if (mode === "rankings") data.books[0] = book("Ranking-48");
        data.books[index] = book("A");
        if (mode === "mine") data.books[index].progress = { chapterIndex: 1, chapterId: "A-1", catalogRevision: "rev-A", scrollRatio: .4 };
        if (mode === "author") data.author = { name: "Synthetic", bookCount: 48, chapterCount: 144 };
        const endpoint = mode === "author" ? "/api/novels/authors/Synthetic" : "/api/novels";
        const offset = mode === "rankings" ? "48" : "0";
        const initial = hold(url => url.pathname === endpoint && url.searchParams.get("offset") === offset, "", data);
        const route = mode === "rankings" ? "/novels/rankings?sort=updated&page=2" : mode === "mine" ? "/novels/mine"
          : mode === "author" ? "/novels/authors/Synthetic?q=Book&category=Fixture&sort=chars" : "/novels?q=Book&category=Fixture&sort=title";
        const page = await newPage({ real: true, ignoreAbort, route, waitReady: false });
        try {
          await requested(initial); await settle(page, initial); await ready(page);
          const title = page.locator(mode === "mine" ? ".novel-recent-item" : mode === "rankings" ? ".novel-ranking-book" : ".novel-book-title").filter({ hasText: mode === "mine" ? "Book A" : /^Book A$/ });
          const entry = mode === "mine" ? title : title.locator(mode === "rankings" ? "xpath=ancestor::tr" : "xpath=ancestor::article");
          const action = mode === "reader" ? entry.locator(".novel-book-actions button").last() : title;
          await action.scrollIntoViewIfNeeded(); await action.focus(); await tick(page);
          const top = await entry.evaluate(entry => entry.getBoundingClientRect().top);
          const reads = countRequests(url => url.pathname === endpoint);
          const chapterRead = mode === "mine" ? hold(url => url.pathname === "/api/novels/A/chapters/1", "", { ...chapterResponse("A", 1), book: data.books[index] }) : null;
          await action.press("Enter");
          if (chapterRead) { await requested(chapterRead); await settle(page, chapterRead); }
          if (["reader", "mine"].includes(mode)) await readerTitle(page, "A", 1); else await detailTitle(page, "Book A");
          const fresh = ["mine", "rankings"].includes(mode) ? hold(url => url.pathname === endpoint && url.searchParams.get("offset") === offset, "", data) : null;
          await page.getByRole("button", { name: "返回列表", exact: true }).click();
          if (fresh) {
            await requested(fresh);
            const params = new URL(fresh.url, base).searchParams;
            assert.equal(params.get("sort") || "updated", mode === "mine" ? "progress" : "updated");
            if (mode === "mine") assert.equal(params.get("reading"), "1");
            await settle(page, fresh);
          }
          await title.waitFor(); await tick(page);
          assert.equal(countRequests(url => url.pathname === endpoint), reads + Number(Boolean(fresh)), `${mode} must use its intended cache/fresh policy`);
          assert.equal(new URL(page.url()).pathname, new URL(route, base).pathname);
          if (mode === "rankings") assert.equal(new URL(page.url()).searchParams.get("page"), "2");
          if (["reader", "author"].includes(mode)) {
            assert.equal(await page.locator(".novel-section-search input").inputValue(), "Book");
            assert.equal(new URL(page.url()).searchParams.get("category"), "Fixture");
          }
          assert(Math.abs(await entry.evaluate(entry => entry.getBoundingClientRect().top) - top) < 2, `${mode} must restore the source entry's visible position`);
          assert.equal(await action.evaluate(action => action === document.activeElement), true, `${mode} must restore the original list action focus`);
        } finally { await page.close(); }
      });
      await run(`library origin failed fresh return retries its loaded range and target ${transport}`, async () => {
        const data = originLibraryData(96, 50), page = await newPage({ real: true, ignoreAbort, waitReady: false });
        try {
          const source = await openOriginLibrary(page, data);
          await source.press("Enter"); await detailTitle(page, "Book A");
          await openCorrection(page); await submitCorrection(page, "PATCH"); await detailTitle(page, "Corrected Book A");
          const failed = hold(url => url.pathname === "/api/novels", "Origin return failed");
          await page.getByRole("button", { name: "返回列表", exact: true }).click(); await requested(failed); await settle(page, failed);
          const retry = hold(url => url.pathname === "/api/novels", "", data);
          await page.locator(".novel-library-autoload button").click(); await requested(retry);
          assert.equal(new URL(retry.url, base).searchParams.get("limit"), "96", "a failed source return must retry its original loaded range instead of only the first 48 books");
          await settle(page, retry); await page.locator(".novel-book-row").nth(95).waitFor(); await tick(page);
          assert.equal(await page.locator(".novel-section-search input").inputValue(), "Book");
          assert.equal(await source.evaluate(button => button === document.activeElement), true, "a recovered return must restore the original book action");
        } finally { libraryFeed = null; await page.close(); }
      });
      for (const method of ["PATCH", "DELETE"]) await run(`library origin ${method} refreshes confirmed changes and chooses a surviving target ${transport}`, async () => {
        const data = originLibraryData(3, 1), page = await newPage({ real: true, ignoreAbort, waitReady: false });
        try {
          const source = await openOriginLibrary(page, data);
          await source.press("Enter"); await detailTitle(page, "Book A"); await openCorrection(page);
          const changed = { ...data, books: method === "DELETE" ? data.books.filter(entry => entry.id !== "A")
            : data.books.map(entry => entry.id === "A" ? { ...entry, title: "Corrected Book A" } : entry), total: method === "DELETE" ? 2 : 3 };
          const fresh = hold(url => url.pathname === "/api/novels", "", changed);
          await submitCorrection(page, method);
          if (method === "PATCH") {
            await detailTitle(page, "Corrected Book A");
            await page.getByRole("button", { name: "返回列表", exact: true }).click();
          }
          await requested(fresh);
          const params = new URL(fresh.url, base).searchParams;
          assert.equal(params.get("q"), "Book"); assert.equal(params.get("category"), "Fixture"); assert.equal(params.get("sort"), "title");
          await settle(page, fresh); await tick(page);
          assert.equal(await page.locator(".novel-book-row").count(), changed.books.length);
          const focus = method === "DELETE" ? page.locator(".novel-book-title").nth(1) : page.locator(".novel-book-title").filter({ hasText: /^Corrected Book A$/ });
          assert.equal(await focus.evaluate(button => button === document.activeElement), true, "a changed source must focus its surviving original book or adjacent entry");
          if (method === "DELETE") {
            assert.equal(await page.locator('.novel-book-row[data-novel-book-key*=\'"A"\']').count(), 0, "returning after deletion must not resurrect the deleted book");
            assert((await page.locator(".novel-status-line").textContent()).includes("已删除《Book A》"));
          }
          assert.equal(new URL(page.url()).searchParams.get("q"), "Book");
          assert.equal(await page.getByRole("button", { name: "返回列表", exact: true }).count(), 0);
        } finally { libraryFeed = null; await page.close(); }
      });
      for (const operation of ["PATCH", "DELETE", "reimport"]) await run(`library origin late ${operation} invalidates a newer cached source without changing its book ${transport}`, async () => {
        const data = { ...libraryData(), sourceRealm: "server:fixture", listRevision: "origin-before-mutation" };
        const page = await newPage({ real: true, ignoreAbort, waitReady: false });
        try {
          const source = await openOriginLibrary(page, data); await source.press("Enter"); await detailTitle(page, "Book A");
          const method = operation === "reimport" ? "POST" : operation;
          const pathname = operation === "reimport" ? "/api/novels/A/reimport" : "/api/novels/A";
          const receipt = operation === "DELETE" ? { deleted: true } : { kind: "book", book: { ...book("A"), title: "Changed Book A" } };
          const mutation = hold((url, req) => url.pathname === pathname && req.method === method, "", receipt);
          if (operation === "reimport") {
            await page.locator(".novel-detail-tools summary").click();
            await page.getByRole("button", { name: "重新导入", exact: true }).click();
            await page.getByRole("button", { name: "直接读取原文件", exact: true }).click();
          } else { await openCorrection(page); await submitCorrection(page, method); }
          await requested(mutation); await page.keyboard.press("Escape");
          await page.locator(".novel-breadcrumbs button").filter({ hasText: "小说书库" }).click();
          await page.locator(".novel-book-title").filter({ hasText: /^Book B$/ }).click(); await detailTitle(page, "Book B");
          await page.waitForFunction(() => !document.querySelector(".novel-catalog-loading")); await tick(page);
          await page.evaluate(() => { window.__newMutationReturnBook = document.querySelector(".novel-detail"); });
          libraryFeed = { ...data, listRevision: "origin-after-mutation", books: operation === "DELETE" ? [book("B")] : [{ ...book("A"), title: "Changed Book A" }, book("B")], total: operation === "DELETE" ? 1 : 2 };
          await settle(page, mutation);
          assert.equal(await page.evaluate(() => __newMutationReturnBook === document.querySelector(".novel-detail") && document.querySelector(".novel-detail-title")?.textContent === "Book B"), true, "late mutations must not replace the newer book while invalidating its source");
          const reads = countRequests(url => url.pathname === "/api/novels");
          await page.getByRole("button", { name: "返回列表", exact: true }).click(); await tick(page);
          assert.equal(countRequests(url => url.pathname === "/api/novels"), reads + 1, "a confirmed old mutation must invalidate the newer source cache before its return");
          await page.waitForFunction(count => document.querySelectorAll(".novel-book-row").length === count, libraryFeed.books.length);
          assert.equal(await page.locator(".novel-book-title").filter({ hasText: /^Book A$/ }).count(), 0, "a source return must not resurrect a deleted or changed book snapshot");
          if (operation !== "DELETE") assert.equal(await page.locator(".novel-book-title").filter({ hasText: /^Changed Book A$/ }).count(), 1);
        } finally { libraryFeed = null; await page.close(); }
      });
      await run(`library origin mutation also invalidates a list read already in flight ${transport}`, async () => {
        const data = { ...libraryData(), sourceRealm: "server:fixture", listRevision: "origin-before-mutation" };
        const page = await newPage({ real: true, ignoreAbort, waitReady: false });
        try {
          const source = await openOriginLibrary(page, data); await source.press("Enter"); await detailTitle(page, "Book A"); await openCorrection(page);
          const deleted = hold((url, req) => url.pathname === "/api/novels/A" && req.method === "DELETE", "", { deleted: true });
          await submitCorrection(page, "DELETE"); await requested(deleted); await page.keyboard.press("Escape");
          const oldList = hold(url => url.pathname === "/api/novels", "", data);
          await page.locator(".novel-breadcrumbs button").filter({ hasText: "小说书库" }).click(); await requested(oldList);
          libraryFeed = { ...data, books: [book("B")], total: 1, listRevision: "origin-after-mutation" };
          await settle(page, deleted); await settle(page, oldList);
          await page.locator(".novel-book-title").filter({ hasText: /^Book B$/ }).click(); await detailTitle(page, "Book B");
          const reads = countRequests(url => url.pathname === "/api/novels");
          await page.getByRole("button", { name: "返回列表", exact: true }).click(); await tick(page);
          assert.equal(countRequests(url => url.pathname === "/api/novels"), reads + 1, "a list response begun before a confirmed mutation must not become a reusable source cache");
          await page.waitForFunction(() => document.querySelectorAll(".novel-book-row").length === 1);
          assert.equal(await page.locator(".novel-book-title").textContent(), "Book B");
        } finally { libraryFeed = null; await page.close(); }
      });
      await run(`library origin current reimport completes and invalidates its cached prefix ${transport}`, async () => {
        const data = originLibraryData(3, 1), page = await newPage({ real: true, ignoreAbort, waitReady: false });
        try {
          const source = await openOriginLibrary(page, data); await source.press("Enter"); await detailTitle(page, "Book A");
          await page.locator(".novel-detail-tools summary").click();
          await page.getByRole("button", { name: "重新导入", exact: true }).click();
          await page.getByRole("button", { name: "直接读取原文件", exact: true }).click();
          await page.locator(".novel-reimport-dialog .novel-correction-message.success").waitFor();
          await page.locator(".novel-reimport-dialog").getByRole("button", { name: "完成", exact: true }).click();
          const reads = countRequests(url => url.pathname === "/api/novels");
          await page.getByRole("button", { name: "返回列表", exact: true }).click(); await tick(page);
          assert.equal(countRequests(url => url.pathname === "/api/novels"), reads + 1, "a confirmed reimport must invalidate the cached source even when summary identity fields are unchanged");
          await page.locator(".novel-book-row").nth(2).waitFor();
          assert.equal(await source.evaluate(button => button === document.activeElement), true);
        } finally { libraryFeed = null; await page.close(); }
      });
      await run(`library origin fresh prefix crosses 5000 using delivered rows ${transport}`, async () => {
        const original = originLibraryData(6000, 5999);
        const data = { ...original, books: [...original.books.slice(0, 96), ...original.books.slice(92, 96), ...original.books.slice(96)], total: 6004 };
        const page = await newPage({ real: true, ignoreAbort, waitReady: false });
        try {
          const source = await openOriginLibrary(page, data);
          await source.press("Enter"); await detailTitle(page, "Book A"); await openCorrection(page); await submitCorrection(page, "PATCH"); await detailTitle(page, "Corrected Book A");
          const books = data.books.map(entry => entry.id === "A" ? { ...entry, title: "Corrected Book A" } : entry);
          const first = hold(url => url.pathname === "/api/novels" && url.searchParams.get("limit") === "5000", "", { ...data, books: books.slice(0, 4980), offset: 0, nextOffset: 4980, limit: 5000 });
          const second = hold(url => url.pathname === "/api/novels" && url.searchParams.get("offset") === "4980", "", { ...data, books: books.slice(4980), offset: 4980, nextOffset: 6004, limit: 1024 });
          const reads = libraryReads.length;
          await page.getByRole("button", { name: "返回列表", exact: true }).click(); await requested(first); await settle(page, first);
          await until(() => libraryReads.length > reads + 1, "source prefix must request its next delivered offset");
          assert.deepEqual(libraryReads[reads + 1], { offset: 4980, limit: 1024 }, "source restoration must continue after delivered rows to the original raw cursor, not unique books or the requested 5000-row limit");
          await requested(second); await settle(page, second); await page.locator(".novel-book-row").nth(5999).waitFor(); await tick(page);
          assert.equal(await page.locator(".novel-book-row").count(), 6000);
          assert.equal(await page.locator(".novel-book-title").filter({ hasText: /^Corrected Book A$/ }).evaluate(button => button === document.activeElement), true);
          assert.equal(await page.locator(".novel-library-autoload button").count(), 0);
        } finally { libraryFeed = null; await page.close(); }
      });
      await run(`library origin empty fresh prefix stops continuation ${transport}`, async () => {
        const data = originLibraryData(6, 5), page = await newPage({ real: true, ignoreAbort, waitReady: false, manualObservers: true });
        try {
          const source = await openOriginLibrary(page, data);
          await source.press("Enter"); await detailTitle(page, "Book A"); await openCorrection(page); await submitCorrection(page, "PATCH"); await detailTitle(page, "Corrected Book A");
          const first = hold(url => url.pathname === "/api/novels" && url.searchParams.get("offset") === "0", "", { ...data, books: data.books.slice(0, 2), offset: 0, nextOffset: 2 });
          const empty = hold(url => url.pathname === "/api/novels" && url.searchParams.get("offset") === "2", "", { ...data, books: [], offset: 2, nextOffset: 2 });
          await page.getByRole("button", { name: "返回列表", exact: true }).click(); await requested(first); await settle(page, first); await requested(empty); await settle(page, empty);
          assert.equal(await page.locator(".novel-book-row").count(), 2);
          assert.equal(await page.locator(".novel-library-autoload button").count(), 0, "an empty last prefix page must not reopen continuation from the nonempty merged prefix");
          assert.equal(await page.evaluate(() => [...__observers].some(observer => observer.targets.size)), false);
        } finally { libraryFeed = null; await page.close(); }
      });
      for (const intent of ["focus", "search"]) await run(`library origin fresh return respects newer ${intent} ${transport}`, async () => {
        const data = rankingPage(48); data.books[0] = book("Ranking-48"); data.books[20] = book("A");
        const initial = hold(url => url.pathname === "/api/novels" && url.searchParams.get("offset") === "48", "", data);
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/rankings?page=2&sort=updated", waitReady: false });
        try {
          await requested(initial); await settle(page, initial); await ready(page);
          const source = page.locator(".novel-ranking-book").filter({ hasText: /^Book A$/ });
          await source.scrollIntoViewIfNeeded(); await source.focus(); await source.press("Enter"); await detailTitle(page, "Book A");
          const fresh = hold(url => url.pathname === "/api/novels" && url.searchParams.get("offset") === "48", "", data);
          await page.getByRole("button", { name: "返回列表", exact: true }).click(); await requested(fresh);
          const input = page.locator(".novel-section-search input");
          await input.fill(intent === "focus" ? "Unsubmitted return draft" : "Other");
          await input.evaluate(input => input.setSelectionRange(1, 4));
          if (intent === "focus") {
            const scroll = await page.evaluate(() => scrollY);
            await settle(page, fresh);
            assert.equal(await page.evaluate(() => scrollY), scroll, "a fresh source return must not override newer user focus by scrolling back to its old book");
            assert.deepEqual(await input.evaluate(input => [input.value, input.selectionStart, input.selectionEnd, input === document.activeElement]), ["Unsubmitted return draft", 1, 4, true]);
          } else {
            const next = hold(url => url.pathname === "/api/novels" && url.searchParams.get("q") === "Other", "", libraryPage(1, "Other"));
            await input.press("Enter"); await requested(next); await settle(page, next);
            await page.evaluate(() => { window.__newReturnDestination = document.querySelector(".novel-home"); });
            const route = `${new URL(page.url()).pathname}${new URL(page.url()).search}`;
            await finishOld(page, fresh, ignoreAbort);
            assert.equal(await page.evaluate(() => __newReturnDestination === document.querySelector(".novel-home")), true, "an obsolete source return must not replace the newer search");
            assert.equal(`${new URL(page.url()).pathname}${new URL(page.url()).search}`, route);
            assert.equal(await input.inputValue(), "Other");
          }
        } finally { await page.close(); }
      });
      await run(`library origin deletion clamps the source ranking page and focuses a neighbor ${transport}`, async () => {
        const initialData = { ...rankingPage(96), books: [book("A")], total: 97, nextOffset: 97 };
        const initial = hold(url => url.pathname === "/api/novels" && url.searchParams.get("offset") === "96", "", initialData);
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/rankings?page=3&sort=updated", waitReady: false });
        try {
          await requested(initial); await settle(page, initial); await ready(page);
          const source = page.locator(".novel-ranking-book"); await source.focus(); await source.press("Enter"); await detailTitle(page, "Book A");
          await openCorrection(page);
          const emptied = hold(url => url.pathname === "/api/novels" && url.searchParams.get("offset") === "96", "", { ...initialData, books: [], total: 96, nextOffset: 96 });
          const neighbors = rankingPage(48); neighbors.total = 96; neighbors.books[0] = book("B"); neighbors.books[1] = book("Ranking-49");
          const clamped = hold(url => url.pathname === "/api/novels" && url.searchParams.get("offset") === "48", "", neighbors);
          await submitCorrection(page, "DELETE"); await requested(emptied); await settle(page, emptied); await requested(clamped); await settle(page, clamped); await tick(page);
          assert.equal(new URL(page.url()).pathname, "/novels/rankings"); assert.equal(new URL(page.url()).searchParams.get("page"), "2");
          assert.equal(await page.locator(".novel-ranking-row").count(), 48);
          assert.equal(await page.locator(".novel-ranking-row").first().evaluate(row => row === document.activeElement), true, "a legal source page clamp must still restore the surviving neighbor focus");
          assert.equal(await page.locator(".novel-ranking-book").filter({ hasText: /^Book A$/ }).count(), 0);
        } finally { await page.close(); }
      });
      await run(`library origin return remains reachable at narrow widths ${transport}`, async () => {
        for (const width of [320, 390]) for (const error of ["", "Narrow source catalog unavailable"]) {
          const page = await newPage({ real: true, ignoreAbort, waitReady: false });
          const catalog = hold(url => url.pathname === "/api/novels/A/catalog", error);
          try {
            await page.setViewportSize({ width, height: 760 });
            const source = await openOriginLibrary(page, originLibraryData(3, 1));
            const reads = countRequests(url => url.pathname === "/api/novels");
            await source.press("Enter"); await requested(catalog); await detailTitle(page, "Book A");
            const input = page.locator(".novel-section-search input");
            await input.fill("未提交的目录草稿"); await input.evaluate(input => input.setSelectionRange(2, 7));
            await page.locator(".novel-detail-tools summary").click();
            const back = page.getByRole("button", { name: "返回列表", exact: true }); await back.scrollIntoViewIfNeeded();
            await back.focus(); await tick(page);
            await back.evaluate(button => {
              const selectors = [".novel-detail", ".novel-section-menu", ".novel-breadcrumbs", ".novel-detail-hero", ".novel-detail-tools", ".novel-section-search", ".novel-section-search input"];
              const entries = selectors.map(selector => ({ selector, node: document.querySelector(selector) }));
              const ancestors = new Map();
              for (const element of [button, ...entries.map(entry => entry.node)]) for (let node = element; node; node = node.parentElement) ancestors.set(node, node.parentElement);
              const record = window.__narrowCatalogDetail = { button, entries, ancestors, blur: 0, removals: 0, scroll: scrollY };
              button.addEventListener("blur", () => record.blur++);
              record.observer = new MutationObserver(records => {
                for (const mutation of records) for (const removed of mutation.removedNodes) {
                  if (removed.nodeType === Node.ELEMENT_NODE && [button, ...entries.map(entry => entry.node)].some(node => removed === node || removed.contains(node))) record.removals++;
                }
              });
              record.observer.observe(document.querySelector("#workGrid"), { childList: true, subtree: true });
            });
            await settle(page, catalog);
            assert.deepEqual(await page.evaluate(() => {
              const record = __narrowCatalogDetail, input = document.querySelector(".novel-section-search input");
              return { entries: record.entries.every(({ selector, node }) => node.isConnected && node === document.querySelector(selector)),
                ancestors: [...record.ancestors].every(([node, parent]) => node.isConnected && node.parentElement === parent),
                focus: document.activeElement === record.button, blur: record.blur, removals: record.removals,
                draft: input.value, range: [input.selectionStart, input.selectionEnd], toolsOpen: document.querySelector(".novel-detail-tools").open,
                scroll: scrollY === record.scroll, title: document.querySelector(".novel-detail-title").textContent };
            }), { entries: true, ancestors: true, focus: true, blur: 0, removals: 0, draft: "未提交的目录草稿", range: [2, 7], toolsOpen: true,
              scroll: true, title: "Book A" }, "catalog completion must preserve the usable metadata detail, its full control ancestry and the user's newer focus and draft");
            if (error) assert.equal(await page.locator(".novel-catalog-loading.error").textContent(), error);
            else assert.equal(await page.locator(".novel-catalog-grid button").count(), 3);
            const rect = await back.boundingBox();
            assert(rect && rect.height >= 44 && rect.x >= 0 && rect.x + rect.width <= width, "the source return action must expose a 44px touch target inside the narrow viewport");
            assert.equal(await back.evaluate(button => { const rect = button.getBoundingClientRect(); return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest("button") === button; }), true);
            await page.evaluate(() => __narrowCatalogDetail.observer.disconnect());
            await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.locator(".novel-book-row").nth(2).waitFor();
            assert.equal(await page.locator(".novel-section-search input").inputValue(), "Book");
            assert.equal(await page.locator(".novel-sort").inputValue(), "title");
            assert.equal(countRequests(url => url.pathname === "/api/novels"), reads, "the retained native return action must restore its unchanged source without rereading it");
          } finally { catalog.release(); libraryFeed = null; await page.close(); }
        }
      });
      await run(`library origin deep links have no invented source ${transport}`, async () => {
        for (const route of ["/novels/A", "/novels/A/1"]) {
          const page = await newPage({ real: true, ignoreAbort, route });
          try {
            if (route.endsWith("/1")) await readerTitle(page, "A", 1); else await detailTitle(page, "Book A");
            assert.equal(await page.getByRole("button", { name: "返回列表", exact: true }).count(), 0, "deep links must retain the existing full-library navigation without a fake return context");
            assert.equal(await page.locator(".novel-breadcrumbs button").filter({ hasText: "小说书库" }).count(), 1);
          } finally { await page.close(); }
        }
      });
      for (const method of ["PATCH", "DELETE"]) for (const error of ["", "obsolete correction error"]) {
        await run(`book correction ${method} ${error ? "failure" : "success"} yields to another reader ${transport}`, async () => {
          const page = await newPage({ real: true, ignoreAbort, route: "/novels/A" });
          try {
            await detailTitle(page, "Book A");
            const old = hold((url, req) => url.pathname === "/api/novels/A" && req.method === method, error,
              method === "PATCH" ? { book: { ...book("A"), title: "Corrected Book A" } } : { deleted: true });
            await openCorrection(page); await submitCorrection(page, method); await requested(old);
            await page.keyboard.press("Escape"); await page.locator("dialog.novel-correction-dialog").waitFor({ state: "detached" });
            await navigateRoute(page, "/novels/B/2"); await readerTitle(page, "B", 2);
            const before = await rememberCorrectionDestination(page);
            await settle(page, old);
            await assertCorrectionDestination(page, before, `${method} late ${error ? "failure" : "success"}`);
          } finally { await page.close(); }
        });
      }
      await run(`book correction PATCH receipt preserves newer dialog drafts ${transport}`, async () => {
        for (const editing of ["values", "composition"]) {
          const page = await newPage({ real: true, ignoreAbort, route: "/novels/A" });
          const submitted = { title: "V1 submitted title", author: "V1 author", category: "V1 category", summary: "V1 submitted summary" };
          const newer = { title: "V2 newer title", author: "V2 author", category: "V2 category", summary: "V2 newer summary 合成草稿。\n".repeat(40) };
          const first = hold((url, req) => url.pathname === "/api/novels/A" && req.method === "PATCH", "", { book: { ...book("A"), ...submitted } });
          let second;
          try {
            await detailTitle(page, "Book A"); await openCorrection(page);
            const dialog = page.locator("dialog.novel-correction-dialog");
            await fillCorrectionDraft(dialog, submitted);
            await dialog.getByRole("button", { name: "保存校正", exact: true }).click(); await requested(first);
            assert.deepEqual(first.body, submitted, "the first PATCH must contain only the draft actually submitted at V1");
            if (editing === "values") await fillCorrectionDraft(dialog, newer);
            const input = dialog.getByLabel(editing === "values" ? "作品简介" : "书名", { exact: true });
            await input.focus();
            if (editing === "composition") await input.evaluate(node => node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "候选" })));
            await rememberCorrectionDraft(page, input, editing === "values");
            await settle(page, first);
            assert.equal(await page.evaluate(() => __correctionDraftSnapshot.dialog.isConnected && __correctionDraftSnapshot.dialog.open
              && __correctionDraftSnapshot.dialog === document.querySelector("dialog.novel-correction-dialog")), true,
            "a saved receipt must not discard newer correction edits or interrupt an active composition");
            await assertCorrectionDraft(page, editing === "values" ? newer : submitted);
            assert.equal(await page.locator(".novel-detail-title").textContent(), submitted.title, "preserving the new draft must not discard the already accepted V1 receipt");
            assert.match(await dialog.locator(".novel-correction-message").innerText(), /未保存|输入.*(?:进行|结束)/, "the current dialog must explain that its remaining input is not a newly confirmed save");
            assert.equal(await dialog.getByRole("button", { name: "保存校正", exact: true }).isEnabled(), true);
            assert.equal(await dialog.locator(".novel-danger-button").isEnabled(), true);
            let finalDraft = newer;
            if (editing === "composition") {
              finalDraft = { ...submitted, title: "V2 composition candidate" };
              await input.evaluate((node, value) => {
                node.value = value;
                node.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true, inputType: "insertCompositionText", data: "候选" }));
                node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "候选" }));
              }, finalDraft.title);
            }
            const beforeArm = countRequests(url => url.pathname === "/api/novels/A");
            await dialog.getByRole("button", { name: "删除小说", exact: true }).click(); await tick(page);
            assert((await dialog.locator(".novel-correction-message").innerText()).includes(submitted.title), "delete confirmation must name the last accepted book title rather than its initial value or unsaved draft");
            assert.equal(countRequests(url => url.pathname === "/api/novels/A"), beforeArm, "arming delete must not mutate a book or autosave the newer draft");
            second = hold((url, req) => url.pathname === "/api/novels/A" && req.method === "PATCH", "", { book: { ...book("A"), ...finalDraft } });
            await dialog.getByRole("button", { name: "保存校正", exact: true }).click(); await requested(second);
            assert.deepEqual(second.body, finalDraft, "the next native save must submit the retained V2 fields rather than replay V1");
            assert.equal(await dialog.locator(".novel-danger-button").textContent(), "删除小说", "starting another PATCH must disarm the previous delete confirmation");
            await settle(page, second); await detailTitle(page, finalDraft.title);
            assert.equal(await dialog.count(), 0, "a confirmed unchanged draft must still close normally");
            assert.equal(new URL(page.url()).pathname, "/novels/A");
          } finally { first.release(); held.delete(first); second?.release(); if (second) held.delete(second); await page.close(); }
        }
      });
      for (const method of ["PATCH", "DELETE"]) {
        await run(`book correction ${method} closed instance yields to replacement dialog ${transport}`, async () => {
          const page = await newPage({ real: true, ignoreAbort, route: "/novels/A" });
          try {
            await detailTitle(page, "Book A");
            const old = hold((url, req) => url.pathname === "/api/novels/A" && req.method === method, "",
              method === "PATCH" ? { book: { ...book("A"), title: "Corrected Book A" } } : { deleted: true });
            await openCorrection(page); await submitCorrection(page, method); await requested(old);
            await page.keyboard.press("Escape"); await page.locator("dialog.novel-correction-dialog").waitFor({ state: "detached" });
            await openCorrection(page);
            const dialog = page.locator("dialog.novel-correction-dialog");
            await dialog.getByLabel("书名", { exact: true }).fill("Replacement draft");
            const current = method === "PATCH" ? hold((url, req) => url.pathname === "/api/novels/A" && req.method === "PATCH", "", { book: { ...book("A"), title: "Replacement draft" } }) : null;
            if (current) {
              await dialog.getByRole("button", { name: "保存校正", exact: true }).click(); await requested(current);
              assert.equal(current.body.title, "Replacement draft", "a new dialog must be able to save independently of the old pending instance");
              await dialog.getByRole("button", { name: "取消", exact: true }).focus();
            }
            await page.evaluate(() => { window.__replacementDialog = document.querySelector("dialog.novel-correction-dialog"); window.__correctionDetail = document.querySelector(".novel-detail"); });
            await settle(page, old);
            assert.equal(await page.evaluate(() => __replacementDialog === document.querySelector("dialog.novel-correction-dialog") && __replacementDialog.open), true, "old completion must not close the replacement dialog");
            assert.equal(await page.evaluate(() => __correctionDetail === document.querySelector(".novel-detail")), true, "closed correction instances must not repaint the current book beneath a new dialog");
            assert.equal(await page.locator(".novel-detail-title").textContent(), "Book A");
            assert.equal(await dialog.getByLabel("书名", { exact: true }).inputValue(), "Replacement draft");
            const focused = current ? dialog.getByRole("button", { name: "取消", exact: true }) : dialog.getByLabel("书名", { exact: true });
            assert.equal(await focused.evaluate(control => control === document.activeElement), true);
            assert.equal(await dialog.locator("button[type=submit]").isDisabled(), Boolean(current), "old completion/finally must preserve the replacement dialog's own busy state");
            assert.equal(new URL(page.url()).pathname, "/novels/A");
            if (current) { await settle(page, current); await detailTitle(page, "Replacement draft"); }
          } finally { await page.close(); }
        });

        await run(`book correction ${method} current failure retry ${transport}`, async () => {
          const page = await newPage({ real: true, ignoreAbort, route: "/novels/A" });
          try {
            await detailTitle(page, "Book A"); await openCorrection(page);
            const failed = hold((url, req) => url.pathname === "/api/novels/A" && req.method === method, "synthetic correction failure");
            await submitCorrection(page, method); await requested(failed);
            const dialog = page.locator("dialog.novel-correction-dialog");
            assert.equal(await dialog.locator("button[type=submit]").isDisabled(), true);
            assert.equal(await dialog.locator(".novel-danger-button").isDisabled(), true, "saving and deleting the same book must be mutually exclusive while pending");
            assert.equal(await dialog.getByRole("button", { name: "取消", exact: true }).isEnabled(), true, "a pending mutation must still allow the reader to cancel the dialog");
            assert.equal(await dialog.getByRole("button", { name: "关闭", exact: true }).isEnabled(), true);
            const readCount = countRequests(url => url.pathname === "/api/novels/A");
            await page.keyboard.press("Enter"); await tick(page);
            assert.equal(countRequests(url => url.pathname === "/api/novels/A"), readCount, "Enter during a pending correction must not duplicate its mutation");
            const retryTitle = "New draft after the submitted correction";
            if (method === "PATCH") {
              await dialog.getByLabel("书名", { exact: true }).fill(retryTitle);
              await rememberCorrectionDraft(page, dialog.getByLabel("书名", { exact: true }));
            }
            await settle(page, failed);
            assert.equal(await dialog.locator(".novel-correction-message").textContent(), "synthetic correction failure");
            if (method === "PATCH") await assertCorrectionDraft(page, { title: retryTitle, author: book("A").author, category: book("A").category, summary: "" });
            assert.equal(await dialog.getByRole("button", { name: "保存校正", exact: true }).isEnabled(), true);
            assert.equal(await dialog.locator(".novel-danger-button").isEnabled(), true);
            const succeeded = hold((url, req) => url.pathname === "/api/novels/A" && req.method === method, "",
              method === "PATCH" ? { book: { ...book("A"), title: retryTitle } } : { deleted: true });
            const library = method === "DELETE" ? hold(url => url.pathname === "/api/novels", "", { ...libraryData(), books: [book("B")], total: 1 }) : null;
            if (method === "PATCH") {
              assert.equal(await dialog.getByLabel("书名", { exact: true }).inputValue(), retryTitle);
              await dialog.getByRole("button", { name: "保存校正", exact: true }).click();
            } else await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
            await requested(succeeded); await settle(page, succeeded);
            if (method === "PATCH") { assert.equal(succeeded.body.title, retryTitle); await detailTitle(page, retryTitle); }
            else {
              await requested(library); await settle(page, library);
              await page.locator(".novel-book-row").waitFor();
              assert.equal(await page.locator(".novel-book-row").count(), 1);
              assert((await page.locator(".novel-book-title").textContent()).includes("Book B"));
              assert((await page.locator(".novel-home").textContent()).includes("已删除《Book A》"));
              assert.equal(new URL(page.url()).pathname, "/novels");
            }
            assert.equal(await dialog.count(), 0);
          } finally { await page.close(); }
        });
      }
      await run(`book correction DELETE refresh yields to another reader ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/A" });
        try {
          await detailTitle(page, "Book A"); await openCorrection(page);
          const deleted = hold((url, req) => url.pathname === "/api/novels/A" && req.method === "DELETE", "", { deleted: true });
          const library = hold(url => url.pathname === "/api/novels", "", { ...libraryData(), books: [book("B")], total: 1 });
          await submitCorrection(page, "DELETE"); await requested(deleted); await settle(page, deleted); await requested(library);
          await navigateRoute(page, "/novels/B/2"); await readerTitle(page, "B", 2);
          const before = await rememberCorrectionDestination(page);
          await finishOld(page, library, ignoreAbort);
          await assertCorrectionDestination(page, before, "a completed deletion's late library refresh");
        } finally { await page.close(); }
      });
      await run(`reader modified arrows preserve native browser history ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/B/1" });
        try {
          await readerTitle(page, "B", 1);
          await navigateRoute(page, "/novels/A/2"); await readerTitle(page, "A", 2);
          await page.locator(".novel-reader-content p").first().click();
          assert.equal(await page.evaluate(() => document.activeElement.tagName), "BODY", "history shortcuts must be tested from the actual reading surface");
          await page.evaluate(() => {
            window.__historyArrowKeys = [];
            window.addEventListener("keydown", event => { if (event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) __historyArrowKeys.push({ key: event.key, prevented: event.defaultPrevented }); });
          });
          const historyLength = await page.evaluate(() => history.length);
          await page.keyboard.press("Alt+ArrowLeft"); await tick(page);
          assert.equal(await page.evaluate(() => __historyArrowKeys.at(-1).prevented), false, "Alt+Left must leave native browser history unclaimed by the chapter shortcut");
          // Headless Chromium delivers the real key but can omit browser-chrome
          // accelerators. Exercise its actual history when that default is absent.
          if (new URL(page.url()).pathname === "/novels/A/2") await page.goBack();
          await readerTitle(page, "B", 1);
          assert.equal(new URL(page.url()).pathname, "/novels/B/1", "Alt+Left must return to the previous history entry rather than open A's previous chapter");
          await page.keyboard.press("Alt+ArrowRight"); await tick(page);
          assert.equal(await page.evaluate(() => __historyArrowKeys.at(-1).prevented), false, "Alt+Right must leave native forward history unclaimed by the chapter shortcut");
          if (new URL(page.url()).pathname === "/novels/B/1") await page.goForward();
          await readerTitle(page, "A", 2);
          assert.equal(new URL(page.url()).pathname, "/novels/A/2", "Alt+Right must restore forward history rather than open B's next chapter");
          assert.equal(await page.evaluate(() => history.length), historyLength, "native back/forward must not append chapter history entries");
          await page.keyboard.press("ArrowLeft"); await readerTitle(page, "A", 1);
          await page.keyboard.press("ArrowRight"); await readerTitle(page, "A", 2);
          assert.equal(await page.evaluate(() => history.length), historyLength + 2, "unmodified arrows must retain the existing adjacent-chapter shortcut");
        } finally { await page.close(); }
      });
      await run(`reader modified arrows preserve native text selection ${transport}`, async () => {
        const reply = chapterResponse("A", 2);
        reply.chapter.content = Array.from({ length: 1000 }, (_, index) => `Synthetic selection paragraph ${index}. 完全合成正文。`).join("\n\n");
        const read = hold(url => url.pathname === "/api/novels/A/chapters/2", "", reply);
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/A/2", waitReady: false });
        try {
          await requested(read); await settle(page, read); await ready(page); await readerTitle(page, "A", 2); await tick(page);
          await page.evaluate(() => {
            window.__nativeArrowReader = document.querySelector(".novel-reader-page");
            window.__nativeArrowParagraphs = [...document.querySelectorAll(".novel-reader-content p")];
            window.__nativeArrowEvents = [];
            window.addEventListener("keydown", event => { if (["ArrowLeft", "ArrowRight"].includes(event.key)) __nativeArrowEvents.push({ prevented: event.defaultPrevented, key: event.key }); });
            document.activeElement?.blur();
            const range = document.createRange(); range.setStart(__nativeArrowParagraphs[0].firstChild, 10); range.setEnd(__nativeArrowParagraphs[0].firstChild, 20);
            getSelection().removeAllRanges(); getSelection().addRange(range);
          });
          const scroll = await page.evaluate(() => scrollY);
          await page.keyboard.press("Shift+ArrowRight"); await tick(page);
          assert.equal(await page.evaluate(() => __nativeArrowEvents.at(-1).prevented), false, "modified arrows must keep their native selection behavior");
          assert.equal(await page.evaluate(() => getSelection().toString()), reply.chapter.content.slice(10, 21));
          await page.keyboard.press("Shift+ArrowLeft"); await tick(page);
          assert.equal(await page.evaluate(() => getSelection().toString()), reply.chapter.content.slice(10, 20));
          for (const flag of ["ctrlKey", "metaKey", "altKey"]) {
            await page.evaluate(flag => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true, [flag]: true })), flag);
            assert.equal(await page.evaluate(() => __nativeArrowEvents.at(-1).prevented), false, `${flag} must not be claimed by the chapter shortcut`);
          }
          assert.equal(await page.locator(".novel-reader-content p").count(), 1000);
          assert.equal(await page.evaluate(() => __nativeArrowReader === document.querySelector(".novel-reader-page") && __nativeArrowParagraphs.every((paragraph, index) => paragraph === document.querySelectorAll(".novel-reader-content p")[index])), true, "native selection operations must keep every paragraph mounted");
          assert.equal(await page.evaluate(() => scrollY), scroll);
          assert.equal(new URL(page.url()).pathname, "/novels/A/2");
        } finally { await page.close(); }
      });
      await run(`detail metadata releases standalone host before catalog ${transport}`, async () => {
        const metadata = hold(url => url.pathname === "/api/novels/A" && url.searchParams.get("catalog") === "0", "",
          { book: { ...book("A"), progress: { chapterIndex: 2, scrollRatio: 0.4 } }, chapterTotal: 3 });
        const catalog = hold(url => url.pathname === "/api/novels/A/catalog");
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/A", waitReady: false });
        try {
          await requested(metadata); await settle(page, metadata);
          await requested(catalog); await ready(page); await detailTitle(page, "Book A");
          assert.equal(await page.locator(".novel-detail-title").isVisible(), true, "metadata must be visible while the catalog response is still held");
          assert.equal(await page.evaluate(() => getComputedStyle(document.body).visibility), "visible", "the standalone host must release its body visibility gate");
          assert.equal(await page.locator(".novel-catalog-loading").textContent(), "正在读取章节目录…");
          assert.equal(await page.locator(".novel-detail-actions button").filter({ hasText: "继续阅读" }).isEnabled(), true);
          const progress = page.locator(".novel-detail-chapter-action").filter({ hasText: "上次读到" }).locator("button");
          assert.match(await progress.textContent(), /^2 · 第\s*2\s*章$/, "metadata must expose the saved chapter even before its catalog title is known");
          await progress.evaluate(button => { window.__earlyProgressDetail = { detail: document.querySelector(".novel-detail"), hero: document.querySelector(".novel-detail-hero"), button }; });
          assert.equal(new URL(page.url()).pathname, "/novels/A");
          await page.setViewportSize({ width: 1280, height: 400 });
          await tick(page); // Finish the metadata render's initial scroll restoration before measuring user scroll.
          await page.evaluate(() => window.scrollTo(0, 180)); await tick(page);
          const scroll = await page.evaluate(() => window.scrollY); assert(scroll > 0);
          await settle(page, catalog);
          assert.equal(await page.locator(".novel-catalog-grid button").count(), 3);
          assert.equal(await progress.textContent(), "2 · A Chapter 2", "the accepted catalog must replace the fallback progress title with the actual saved chapter title");
          assert.equal(await progress.evaluate(button => button === __earlyProgressDetail.button && document.querySelector(".novel-detail") === __earlyProgressDetail.detail
            && document.querySelector(".novel-detail-hero") === __earlyProgressDetail.hero), true, "updating the known progress title must preserve the original reading action and hero");
          assert.equal(await page.evaluate(() => window.scrollY), scroll, "late catalog rendering preserves the user's detail scroll");
        } finally { metadata.release(); catalog.release(); await page.close(); }
      });

      await run(`detail metadata switches books before new catalog ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          await page.evaluate(() => fixture.page.openBook("A")); await detailTitle(page, "Book A");
          await page.waitForFunction(() => !fixture.state.novel.catalogLoading);
          const catalog = hold(url => url.pathname === "/api/novels/B/catalog");
          await page.evaluate(() => { fixture.pending.push(fixture.page.openBook("B")); }); await requested(catalog);
          await detailTitle(page, "Book B");
          assert.equal(await page.locator(".novel-detail-title").isVisible(), true);
          assert.equal(await page.locator(".novel-catalog-loading").textContent(), "正在读取章节目录…");
          assert.equal(await page.locator(".novel-catalog-grid button").count(), 0, "A's catalog cannot remain under B's metadata");
          assert.equal(await page.evaluate(() => fixture.state.novel.loading), false);
          assert.equal(new URL(page.url()).pathname, "/novels/B");
          await settle(page, catalog);
          assert((await page.locator(".novel-catalog-grid").textContent()).includes("B Chapter 1"));
        } finally { await page.close(); }
      });

      for (const error of ["", "obsolete catalog error"]) for (const target of ["home", "book", "reader"]) {
        await run(`detail metadata pending catalog yields to ${target} ${error ? "error" : "success"} ${transport}`, async () => {
          const catalog = hold(url => url.pathname === "/api/novels/A/catalog", error);
          const page = await newPage({ real: true, ignoreAbort, route: "/novels/A", waitReady: false });
          try {
            await requested(catalog); await ready(page); await detailTitle(page, "Book A");
            if (target === "home") {
              await page.locator(".novel-breadcrumbs button").filter({ hasText: "小说书库" }).click();
              await page.locator(".novel-book-row").first().waitFor();
            } else if (target === "book") {
              await navigateRoute(page, "/novels/B"); await detailTitle(page, "Book B");
              await page.waitForFunction(() => !document.querySelector(".novel-catalog-loading"));
            } else {
              await page.locator(".novel-detail-actions button").filter({ hasText: "开始阅读" }).click();
              await readerTitle(page, "A", 1);
            }
            const selector = target === "home" ? ".novel-home" : target === "book" ? ".novel-detail" : ".novel-reader-page";
            await page.evaluate(selector => { window.__currentDetailDestination = document.querySelector(selector); }, selector);
            const route = new URL(page.url()).pathname;
            await finishOld(page, catalog, ignoreAbort);
            assert.equal(await page.evaluate(selector => window.__currentDetailDestination === document.querySelector(selector), selector), true, "obsolete catalog completion cannot rebuild the new destination");
            assert.equal(new URL(page.url()).pathname, route);
            assert(!(await page.locator("#workGrid").textContent()).includes("obsolete catalog error"));
            if (target === "book") {
              assert.equal(await page.locator(".novel-detail-title").textContent(), "Book B");
              const currentCatalog = await page.locator(".novel-catalog-grid").textContent();
              assert(currentCatalog.includes("B Chapter 1") && !currentCatalog.includes("A Chapter 1"), "an obsolete A catalog must not update B's currently displayed chapter data");
            }
            assert(await page.evaluate(url => __transport.aborted.includes(url), catalog.url), "leaving early detail must abort its catalog read");
          } finally { await page.close(); }
        });
      }

      await run(`detail metadata catalog failure retries without rereading metadata ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          const metadataBefore = countRequests(url => url.pathname === "/api/novels/A");
          const catalogsBefore = countRequests(url => url.pathname === "/api/novels/A/catalog");
          const failed = hold(url => url.pathname === "/api/novels/A/catalog", "controlled catalog failure");
          await page.evaluate(() => fixture.page.openBook("A")); await requested(failed); await detailTitle(page, "Book A");
          await page.evaluate(() => { fixture.catalogRecoveryOuter = [".novel-detail", ".novel-section-menu", ".novel-breadcrumbs", ".novel-detail-hero"]
            .map(selector => ({ selector, node: document.querySelector(selector) })); });
          await settle(page, failed);
          assert.equal(await page.locator(".novel-catalog-loading.error").textContent(), "controlled catalog failure");
          assert.equal(await page.evaluate(() => fixture.catalogRecoveryOuter.every(({ selector, node }) => node.isConnected && node === document.querySelector(selector))), true,
            "a catalog failure must only replace its own section, keeping the usable metadata controls live");
          const retry = hold(url => url.pathname === "/api/novels/A/catalog");
          await page.locator(".novel-catalog button").filter({ hasText: "重试目录" }).click(); await requested(retry);
          assert.equal(await page.locator(".novel-catalog-loading").textContent(), "正在读取章节目录…");
          assert.equal(await page.locator(".novel-detail-title").isVisible(), true);
          await settle(page, retry);
          assert.equal(await page.locator(".novel-catalog-grid button").count(), 3);
          assert.equal(await page.evaluate(() => fixture.catalogRecoveryOuter.every(({ selector, node }) => node.isConnected && node === document.querySelector(selector))), true,
            "retrying the current catalog must preserve the metadata shell and hero");
          assert.equal(countRequests(url => url.pathname === "/api/novels/A/catalog"), catalogsBefore + 2, "catalog retry must read the original target exactly once more");
          assert.equal(countRequests(url => url.pathname === "/api/novels/A"), metadataBefore + 1, "catalog retry cannot duplicate the metadata request");
          await page.locator(".novel-detail-actions button").filter({ hasText: "开始阅读" }).click(); await readerTitle(page, "A", 1);
        } finally { await page.close(); }
      });

      for (const catalogError of ["", "controlled catalog failure"]) await run(`detail metadata ${catalogError ? "failed" : "interrupted"} catalog remains retryable after chapter failure ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          const catalog = hold(url => url.pathname === "/api/novels/A/catalog", catalogError);
          await page.evaluate(() => fixture.page.openBook("A")); await requested(catalog); await detailTitle(page, "Book A");
          if (catalogError) await settle(page, catalog);
          const chapterRead = hold(url => url.pathname === "/api/novels/A/chapters/1", "controlled chapter failure");
          await page.locator(".novel-detail-actions button").filter({ hasText: "开始阅读" }).click(); await requested(chapterRead);
          assert.equal(await page.locator(".novel-detail .novel-status-line").textContent(), "正在翻开章节");
          if (!catalogError) await finishOld(page, catalog, ignoreAbort);
          await settle(page, chapterRead);
          assert.equal(await page.evaluate(() => fixture.state.novel.catalogLoading), false, "cancelling a catalog cannot leave an eternal loading indicator");
          assert.equal(await page.locator(".novel-detail-title").textContent(), "Book A");
          assert.equal(await page.locator(".novel-detail .novel-status-line").textContent(), "controlled chapter failure");
          assert.equal(await page.locator(".novel-detail .novel-status-line").isVisible(), true);
          assert.equal(await page.locator(".novel-catalog-loading.error").textContent(), catalogError || "章节目录读取已中断，请重试");
          const retry = hold(url => url.pathname === "/api/novels/A/catalog");
          await page.locator(".novel-catalog button").filter({ hasText: "重试目录" }).click(); await requested(retry); await settle(page, retry);
          assert.equal(await page.locator(".novel-catalog-grid button").count(), 3);
          await page.locator(".novel-breadcrumbs button").filter({ hasText: "小说书库" }).click();
          await page.locator(".novel-book-row").first().waitFor(); assert.equal(await page.locator(".novel-detail").count(), 0);
        } finally { await page.close(); }
      });

      for (const error of ["", "controlled search failure"]) await run(`novel search input retains composing draft after ${error ? "failure" : "success"} ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          const first = hold(url => url.pathname === "/api/novels" && url.searchParams.get("q") === "FirstQuery", error);
          const search = page.getByRole("searchbox", { name: "搜索小说", exact: true });
          await search.fill("FirstQuery"); await search.press("Enter"); await requested(first);
          await search.focus();
          await search.evaluate(input => {
            fixture.searchInput = input;
            input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
            input.value = "zhongwen";
            input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
            input.setSelectionRange(1, 5);
          });
          await settle(page, first);
          assert.equal(await page.evaluate(() => fixture.searchInput.isConnected && fixture.searchInput === document.querySelector(".novel-section-search input")), true,
            "a current search response must retain the composing input node");
          assert.equal(await search.evaluate(input => input === document.activeElement), true);
          assert.deepEqual(await search.evaluate(input => [input.value, input.selectionStart, input.selectionEnd]), ["zhongwen", 1, 5]);
          assert.equal(await page.evaluate(() => fixture.state.novel.query), "FirstQuery", "draft text must not become a committed search");
          await search.evaluate(input => {
            input.value = "中文续搜";
            input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文续搜" }));
            input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: false }));
          });
          const next = hold(url => url.pathname === "/api/novels" && url.searchParams.get("q") === "中文续搜");
          const nextReads = countRequests(next.match);
          await search.press("Enter"); await requested(next);
          assert.equal(await search.evaluate(input => input === document.activeElement), true, "a submitted search must focus its current replacement input");
          await settle(page, next);
          assert.equal(await search.inputValue(), "中文续搜");
          assert.equal(await search.evaluate(input => input === document.activeElement), true);
          assert.equal(countRequests(next.match), nextReads + 1);
        } finally { await page.close(); }
      });
      await run(`novel search input respects newer menu focus during results ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          const result = hold(url => url.pathname === "/api/novels" && url.searchParams.get("q") === "FirstQuery");
          const search = page.getByRole("searchbox", { name: "搜索小说", exact: true });
          await search.fill("FirstQuery"); await search.press("Enter"); await requested(result);
          const menu = page.locator(".novel-section-menu").getByRole("button", { name: "书库", exact: true });
          await menu.focus(); await settle(page, result);
          assert.equal(await menu.evaluate(button => button === document.activeElement), true, "search completion must not replace a newer focused navigation control");
        } finally { await page.close(); }
      });
      await run(`novel search input clears draft on explicit return to the same library ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          const search = page.getByRole("searchbox", { name: "搜索小说", exact: true });
          await search.fill("UnsubmittedDraft");
          const refresh = hold(url => url.pathname === "/api/novels" && !url.searchParams.get("q"));
          await page.locator(".novel-section-menu").getByRole("button", { name: "书库", exact: true }).click(); await requested(refresh);
          assert.equal(await search.inputValue(), "", "explicit library navigation must reset an old unsubmitted draft");
          await settle(page, refresh);
          assert.equal(await search.inputValue(), "");
        } finally { await page.close(); }
      });

      await run(`novel search input clears draft on explicit return to the same author ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          await page.locator(".novel-book-author").first().click();
          await page.waitForFunction(() => fixture.state.novel.mode === "author" && !fixture.state.novel.loading);
          const search = page.getByRole("searchbox", { name: "搜索小说", exact: true });
          await search.fill("UnsubmittedDraft");
          const refresh = hold(url => url.pathname === "/api/novels/authors/Synthetic");
          await page.locator(".novel-book-author").first().click(); await requested(refresh);
          assert.equal(await search.inputValue(), "", "explicit author navigation must reset an old unsubmitted draft");
          await settle(page, refresh);
          assert.equal(await search.inputValue(), "");
          assert.equal(await page.evaluate(() => fixture.state.novel.author), "Synthetic");
        } finally { await page.close(); }
      });

      await run(`novel search input resets draft on same-parameter history navigation ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: "/novels?q=Committed" });
        try {
          const search = page.getByRole("searchbox", { name: "搜索小说", exact: true });
          await search.fill("UnsubmittedDraft");
          await search.evaluate(input => { window.__preHistorySearch = input; history.pushState(null, "", location.href); });
          const refresh = hold(url => url.pathname === "/api/novels" && url.searchParams.get("q") === "Committed");
          await page.goBack(); await requested(refresh);
          assert.equal(await search.inputValue(), "Committed", "history navigation must restore the committed query even when route parameters match");
          assert.equal(await page.evaluate(() => window.__preHistorySearch.isConnected), false);
          await settle(page, refresh);
          assert.equal(await search.inputValue(), "Committed");
          assert.equal(new URL(page.url()).searchParams.get("q"), "Committed");
        } finally { await page.close(); }
      });

      await run(`novel search input retires detached form after book navigation ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          await page.locator(".novel-section-search").evaluate(form => { fixture.oldSearchForm = form; });
          await page.evaluate(() => fixture.page.openBook("B")); await detailTitle(page, "Book B");
          await page.waitForFunction(() => !fixture.state.novel.catalogLoading);
          const before = countRequests(url => url.pathname === "/api/novels");
          await page.evaluate(() => {
            fixture.oldSearchForm.querySelector("input").value = "ObsoleteSearch";
            fixture.oldSearchForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
          }); await tick(page);
          assert.equal(countRequests(url => url.pathname === "/api/novels"), before, "a detached search form must not leave the new book");
          assert.equal(await page.locator(".novel-detail-title").textContent(), "Book B");
        } finally { await page.close(); }
      });

      await run(`reader settings preserve 1000 paragraphs and update controls in place ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          const reply = chapterResponse("A", 1);
          reply.chapter.content = Array.from({ length: 1000 }, (_, index) => `Synthetic settings paragraph ${index}. No real library content.`).join("\n\n");
          const chapterRead = hold(url => url.pathname === "/api/novels/A/chapters/1", "", reply);
          await launchChapter(page, "A", 1); await requested(chapterRead); await settle(page, chapterRead); await readerTitle(page, "A", 1);
          await page.locator('[data-reader-focus="toolbar-设置"]').click(); await tick(page);
          await page.evaluate(() => {
            fixture.settingsReader = document.querySelector(".novel-reader-page");
            fixture.settingsParagraphs = [...document.querySelectorAll(".novel-reader-content p")];
            fixture.settingsControl = document.querySelector('[data-reader-focus="fontSize-plus"]');
            const reader = fixture.settingsReader;
            window.scrollTo(0, reader.offsetTop + (reader.scrollHeight - innerHeight) * .4);
          }); await tick(page);
          const ratio = await readerRatio(page), route = new URL(page.url()).pathname;
          const measured = await measureReaderRender(page, async () => {
            for (const key of ["fontSize-plus", "lineHeight-plus", "width-minus", "font-simsun", "toolbar-夜间", "theme-green"]) {
              // DOM clicks keep the fixed panel from scrolling the long reader into view.
              await page.locator(`[data-reader-focus="${key}"]`).evaluate(button => { button.focus({ preventScroll: true }); button.click(); });
              await tick(page);
              assert(Math.abs(await readerRatio(page) - ratio) < .001, `${key} must preserve the reading ratio after reflow`);
              assert.equal(await page.evaluate(() => {
                const paragraphs = document.querySelectorAll(".novel-reader-content p");
                return fixture.settingsReader === document.querySelector(".novel-reader-page")
                  && fixture.settingsParagraphs.every((paragraph, index) => paragraph === paragraphs[index]);
              }), true,
              "changing reader settings must retain the mounted text nodes");
            }
          });
          assert.deepEqual(measured, { roots: 0, elements: 0 }, "settings changes must not recreate any reader or control elements");
          assert.equal(await page.evaluate(() => fixture.settingsControl === document.querySelector('[data-reader-focus="fontSize-plus"]')), true);
          assert.equal(new URL(page.url()).pathname, route);
          assert.equal(await page.locator(".novel-reader-content p").count(), 1000);
          assert.equal(await page.locator('[data-reader-focus="theme-green"]').getAttribute("aria-pressed"), "true");
          assert.equal(await page.locator('[data-reader-focus="font-simsun"]').getAttribute("aria-pressed"), "true");
          assert.equal(await page.locator('[data-reader-focus="toolbar-夜间"]').getAttribute("aria-pressed"), "false");
          assert.equal(await page.locator('[data-reader-focus="fontSize-plus"]').evaluate(button => button.parentElement.querySelector("span").textContent), "21px");
          assert.equal(await page.locator('[data-reader-focus="lineHeight-plus"]').evaluate(button => button.parentElement.querySelector("span").textContent), "2.0");
          assert.equal(await page.locator('[data-reader-focus="width-minus"]').evaluate(button => button.parentElement.querySelector("span").textContent), "940px");
          const appearance = await page.locator(".novel-reader-page").evaluate(reader => ({ theme: reader.classList.contains("theme-green"), night: reader.classList.contains("night"), size: reader.style.getPropertyValue("--novel-font-size"), font: reader.style.getPropertyValue("--novel-font-family"), lineHeight: reader.style.getPropertyValue("--novel-line-height"), width: reader.style.getPropertyValue("--novel-reader-width") }));
          assert.deepEqual(appearance, { theme: true, night: false, size: "21px", font: 'SimSun, "Songti SC", serif', lineHeight: "2", width: "940px" });
          console.log(`MEASURE reader settings: ${measured.roots} reader renders, ${measured.elements} elements for 6 changes on 1000 paragraphs (${transport})`);

          for (const [key, count, value, opposite] of [["fontSize-plus", 9, "30px", "fontSize-minus"], ["fontSize-minus", 14, "16px", "fontSize-plus"],
            ["lineHeight-plus", 4, "2.4", "lineHeight-minus"], ["lineHeight-minus", 9, "1.5", "lineHeight-plus"],
            ["width-plus", 7, "1080px", "width-minus"], ["width-minus", 16, "760px", "width-plus"]]) {
            const control = page.locator(`[data-reader-focus="${key}"]`);
            for (let index = 0; index < count; index++) await control.evaluate(button => { button.focus({ preventScroll: true }); button.click(); });
            await tick(page);
            assert.equal(await control.isDisabled(), true, `${key} must disable at its limit`);
            assert.equal(await control.evaluate(button => button.parentElement.querySelector("span").textContent), value);
            assert.equal(await page.evaluate(() => document.activeElement?.dataset.readerFocus), opposite, "a newly disabled control must move focus to the enabled stepper action");
          }
          const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("fanhao.novel.settings")));
          assert.deepEqual({ fontSize: stored.fontSize, lineHeight: stored.lineHeight, width: stored.width, font: stored.font, theme: stored.theme, night: stored.night },
            { fontSize: 16, lineHeight: 1.5, width: 760, font: "simsun", theme: "green", night: false });
          await page.locator('[data-reader-focus="settings-close"]').click(); await tick(page);
          await page.locator('[data-reader-focus="toolbar-夜间"]').click(); await tick(page);
          assert.equal(await page.locator(".novel-reader-page.night").count(), 1, "night switching also works while settings are closed");
          assert.equal(await page.locator('[data-reader-focus="toolbar-夜间"]').getAttribute("aria-pressed"), "true");
          await page.locator('[data-reader-focus="toolbar-设置"]').click(); await tick(page);
          assert.equal(await page.locator('[data-reader-focus="theme-green"]').getAttribute("aria-pressed"), "false", "night mode must clear the day theme's pressed state");
          assert.equal(await page.locator('[data-reader-focus="fontSize-minus"]').isDisabled(), true);
        } finally { await page.close(); }
      });

      await run(`reader position preserves long chapter selection focus and saves exact ratios ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          const reply = chapterResponse("A", 1);
          reply.chapter.content = Array.from({ length: 1000 }, (_, index) => `Synthetic position paragraph ${index}. 这是合成的长章节定位正文。`).join("\n\n");
          const read = hold(url => url.pathname === "/api/novels/A/chapters/1", "", reply);
          await launchChapter(page, "A", 1); await requested(read); await settle(page, read); await readerTitle(page, "A", 1);
          await page.locator('[data-reader-focus="toolbar-设置"]').click(); await tick(page);
          const input = page.getByRole("spinbutton", { name: "章节阅读百分比", exact: true });
          const route = page.url();
          await page.evaluate(() => { fixture.positionReader = document.querySelector(".novel-reader-page"); fixture.positionParagraphs = [...document.querySelectorAll(".novel-reader-content p")]; });
          const measured = await measureReaderRender(page, async () => {
            for (const percent of [37.5, 0.1, 0, 100]) {
              await input.fill(String(percent));
              await page.evaluate(() => {
                const range = document.createRange(); range.setStart(fixture.positionParagraphs[0].firstChild, 2); range.setEnd(fixture.positionParagraphs[0].firstChild, 18);
                getSelection().removeAllRanges(); getSelection().addRange(range); fixture.positionSelection = getSelection().toString();
                document.querySelector('[data-reader-focus="position-percent"]').focus({ preventScroll: true });
              });
              const before = progressWrites.length;
              await input.press("Enter"); await tick(page);
              const actualRatio = Math.max(0, Math.min(1, await readerRatio(page)));
              assert(Math.abs(actualRatio - percent / 100) < .00005, `must locate the requested chapter percentage ${percent}, including near-zero values (actual ${actualRatio})`);
              assert.equal(await input.evaluate(node => node === document.activeElement), true, "a percentage jump keeps the submitting input focused");
              assert.equal(await page.evaluate(() => getSelection().toString() === fixture.positionSelection), true, "a percentage jump preserves the selected chapter text");
              await until(() => progressWrites.slice(before).some(write => write.bookId === "A" && write.chapterId === "A-1" && Math.abs(write.scrollRatio - percent / 100) < .00005), "a percentage jump must save the actual located ratio through the progress writer");
            }
          });
          assert.deepEqual(measured, { roots: 0, elements: 0 }, "percentage positioning must not rebuild the reader, text or controls");
          assert.equal(await page.evaluate(() => fixture.positionReader === document.querySelector(".novel-reader-page") && fixture.positionParagraphs.every((node, index) => node === document.querySelectorAll(".novel-reader-content p")[index])), true);
          assert.equal(page.url(), route); assert.equal(await page.locator(".novel-reader-content p").count(), 1000);
          await input.fill("0.05"); await input.press("Enter"); await tick(page);
          await input.press("Escape"); await tick(page); await page.locator('[data-reader-focus="toolbar-设置"]').click(); await tick(page);
          assert(Math.abs(await readerRatio(page) - .0005) < .00005, "a precise near-zero position must survive later settings changes");
          const resumed = chapterResponse("A", 1); resumed.chapter.content = reply.chapter.content;
          resumed.book.progress = { chapterIndex: 1, chapterId: "A-1", catalogRevision: "rev-A", scrollRatio: .0005 };
          const restore = hold(url => url.pathname === "/api/novels/A/chapters/1", "", resumed);
          await launchChapter(page, "A", 1); await requested(restore); await settle(page, restore); await readerTitle(page, "A", 1);
          assert(Math.abs(await readerRatio(page) - .0005) < .00005, "a saved near-zero percentage must restore exactly when reopening the chapter");
          assert.equal(await input.inputValue(), "0.05", "a settings panel mounted with the restored chapter shows its precise current position");
        } finally { await page.close(); }
      });

      await run(`reader position validates input and supports narrow keyboard and touch controls ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: "/novels/A/1" });
        try {
          await readerTitle(page, "A", 1); await page.setViewportSize({ width: 320, height: 640 }); await tick(page);
          await page.evaluate(() => { const reader = document.querySelector(".novel-reader-page"); window.scrollTo(0, reader.offsetTop + (reader.scrollHeight - innerHeight) * .4); }); await tick(page);
          await page.locator('[data-reader-focus="toolbar-设置"]').click(); await tick(page);
          const input = page.getByRole("spinbutton", { name: "章节阅读百分比", exact: true });
          assert(Math.abs(Number(await input.inputValue()) - 40) < .2, "opening position controls reads the current chapter ratio");
          const before = await readerRatio(page);
          for (const invalid of ["", "-1", "100.1"]) {
            await input.fill(invalid); await input.press("Enter"); await tick(page);
            assert.equal(await input.getAttribute("aria-invalid"), "true");
            assert((await page.locator(".novel-reader-position-hint").textContent()).includes("请输入"));
            assert(Math.abs(await readerRatio(page) - before) < .00005, "invalid percentages must not move the reader");
          }
          await input.fill("50"); await input.press("ArrowUp"); assert.equal(await input.inputValue(), "50.1");
          const submit = page.getByRole("button", { name: "跳转到章节百分比", exact: true });
          assert.equal(await submit.evaluate(button => { const box = button.getBoundingClientRect(); return box.height >= 44 && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight && document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === button; }), true,
            "a narrow settings panel must keep percentage positioning reachable");
          await submit.click(); await tick(page);
          assert(Math.abs(await readerRatio(page) - .501) < .0002); assert.equal(await submit.evaluate(node => node === document.activeElement), true);
          assert.equal(await input.getAttribute("aria-invalid"), null);
          await input.fill("50.123"); await input.press("Enter"); await tick(page);
          assert(Math.abs(await readerRatio(page) - .50123) < .0002, "explicit decimal precision is not rounded to the input step");
          if (process.argv.includes("--screenshots")) {
            const output = path.join(root, ".codex-artifacts", "novels"); fs.mkdirSync(output, { recursive: true });
            await page.locator(".novel-settings-panel").screenshot({ path: path.join(output, "reader-position-320.png") });
          }
          await input.press("Escape"); assert.equal(await page.locator(".novel-settings-panel").count(), 0);
          assert.equal(await page.evaluate(() => document.activeElement?.dataset.readerFocus), "toolbar-设置");
        } finally { await page.close(); }
      });

      await run(`reader position retires detached controls after panel and chapter changes ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          await openChapter(page, "A", 1);
          await page.locator('[data-reader-focus="toolbar-设置"]').click(); await tick(page);
          await page.locator(".novel-reader-position").evaluate(form => { fixture.oldPosition = form; form.querySelector("input").value = "90"; });
          await page.getByRole("spinbutton", { name: "章节阅读百分比", exact: true }).press("Escape"); await tick(page);
          await page.locator('[data-reader-focus="toolbar-设置"]').click(); await tick(page);
          const before = await readerRatio(page);
          await page.evaluate(() => fixture.oldPosition.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); await tick(page);
          assert(Math.abs(await readerRatio(page) - before) < .00005, "an old percentage form must not move the reader after settings are replaced");
          await openChapter(page, "B", 2); await tick(page);
          await page.evaluate(() => fixture.oldPosition.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); await tick(page);
          assert.equal(await page.evaluate(() => scrollY), 0); assert.equal(await page.locator(".novel-reader-paper h1").textContent(), "B Chapter 2");
        } finally { await page.close(); }
      });

      await run(`reader position queued frames yield to new chapters and newer scroll intent ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          await openChapter(page, "A", 1); await page.locator('[data-reader-focus="toolbar-设置"]').click(); await tick(page);
          await page.evaluate(() => { __holdFrames = true; const form = document.querySelector(".novel-reader-position"); form.querySelector("input").value = "80"; form.requestSubmit(); fixture.oldPositionFrame = [...__heldFrames.values()][0]; });
          await openChapter(page, "B", 2); await page.evaluate(() => fixture.oldPositionFrame(performance.now()));
          assert.equal(await page.evaluate(() => scrollY), 0, "an old percentage frame cannot apply its ratio to a new chapter");
          await page.evaluate(() => { __holdFrames = false; const frames = [...__heldFrames.values()]; __heldFrames.clear(); for (const frame of frames) frame(performance.now()); }); await tick(page);
          if (!await page.locator(".novel-reader-position").count()) await page.locator('[data-reader-focus="toolbar-设置"]').click();
          await tick(page);
          await page.evaluate(() => {
            __holdFrames = true; const form = document.querySelector(".novel-reader-position"); form.querySelector("input").value = "90"; form.requestSubmit();
            const old = [...__heldFrames.values()][0]; dispatchEvent(new WheelEvent("wheel", { deltaY: 200, bubbles: true })); window.scrollTo(0, 400); old(performance.now()); __holdFrames = false;
          }); await tick(page);
          assert.equal(await page.evaluate(() => scrollY), 400, "new user scroll intent cancels a queued percentage jump");
        } finally { await page.close(); }
      });

      await run(`chapter retry preserves the reader and remains available after another failure ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          await openChapter(page, "A", 1);
          await page.evaluate(() => {
            const setTimeout = window.setTimeout.bind(window);
            window.__readerErrorTimers = [];
            window.setTimeout = (callback, delay, ...args) => { if (delay === 3600) __readerErrorTimers.push(callback); return setTimeout(callback, delay, ...args); };
          });
          const failed = hold(url => url.pathname === "/api/novels/A/chapters/3", "controlled chapter failure. ".repeat(25));
          await launchChapter(page, "A", 3); await requested(failed); await settle(page, failed);
          const retry = page.getByRole("button", { name: "重试章节", exact: true });
          assert.equal(await retry.count(), 1, "a failed chapter target needs an in-context retry action");
          assert.equal(await page.evaluate(() => __readerErrorTimers.length), 0, "the retry action must not expire with the old transient error timer");
          await page.setViewportSize({ width: 320, height: 640 }); await tick(page);
          assert.equal(await retry.evaluate(button => {
            const bounds = button.getBoundingClientRect();
            return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight
              && document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2) === button;
          }), true, "a long chapter error must keep retry visible and pointer-reachable on a narrow screen");
          await page.locator('[data-reader-focus="toolbar-设置"]').click(); await tick(page);
          await page.locator('[data-reader-focus="settings-close"]').click(); await tick(page);
          assert.equal(await retry.isVisible(), true, "reader controls must not discard the failed chapter target");
          const progressFailure = hold((url, request) => request.method === "POST" && url.pathname === "/api/novels/A/progress", "progress connection failed");
          const before = await rememberReader(page);
          await requested(progressFailure); await settle(page, progressFailure);
          assert.equal(await retry.isVisible(), true, "a progress-write error must not erase the failed chapter's recovery action");
          const progressRetry = page.locator(".novel-progress-save-retry"); await progressRetry.waitFor({ state: "visible" });
          assert.equal(await progressRetry.evaluate(button => { const r = button.getBoundingClientRect(); return r.height >= 44 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === button; }), true,
            "progress and chapter retry actions must remain independently reachable");
          const progressAgain = hold(progressFailure.match), chapterReads = countRequests(failed.match);
          try {
            await progressRetry.click(); await requested(progressAgain);
            assert.deepEqual({ realm: progressAgain.body.sourceRealm, revision: progressAgain.body.catalogRevision, chapter: progressAgain.body.chapterId, index: progressAgain.body.chapterIndex },
              { realm: "server:fixture", revision: "rev-A", chapter: "A-1", index: 1 }, "progress recovery must save the displayed source chapter, not the failed chapter target");
            assert.equal(countRequests(failed.match), chapterReads, "saving progress must not retry the failed chapter read");
            await settle(page, progressAgain); await progressRetry.waitFor({ state: "detached" });
            assert.equal(await retry.isVisible(), true, "an acknowledged progress retry must clear only its own error"); await assertReaderPreserved(page, before);
          } finally { progressAgain.release(); }
          const again = hold(failed.match, "second chapter failure"), readCount = countRequests(failed.match);
          await retry.evaluate(button => { fixture.oldChapterRetry = button; });
          await retry.click(); await requested(again);
          await page.evaluate(() => fixture.oldChapterRetry.click()); await tick(page);
          assert.equal(countRequests(failed.match), readCount + 1, "a detached retry control cannot duplicate the in-flight read");
          await assertReaderPreserved(page, before);
          await settle(page, again);
          assert.equal(await retry.isVisible(), true);
          assert.equal(await retry.evaluate(button => button === document.activeElement), true, "a keyboard or pointer retry that fails returns focus to the current retry action");
          const success = hold(failed.match);
          await retry.click(); await requested(success); await assertReaderPreserved(page, before); await settle(page, success);
          await readerTitle(page, "A", 3);
          assert.equal(await retry.count(), 0);
          assert.equal(await page.evaluate(() => document.activeElement.matches(".novel-reader-paper h1")), true, "successful retry focuses the newly opened chapter heading");
        } finally { await page.close(); }
      });
      for (const error of ["", "retry failed while adjusting settings"]) await run(`chapter retry respects newer settings focus ${error ? "error" : "success"} ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          await openChapter(page, "A", 1);
          const failed = hold(url => url.pathname === "/api/novels/A/chapters/3", "controlled chapter failure");
          await launchChapter(page, "A", 3); await requested(failed); await settle(page, failed);
          const pending = hold(failed.match, error);
          await page.getByRole("button", { name: "重试章节", exact: true }).click(); await requested(pending);
          await page.locator('[data-reader-focus="toolbar-设置"]').click(); await tick(page);
          const font = page.locator('[data-reader-focus="fontSize-plus"]');
          await font.focus();
          await settle(page, pending);
          assert.equal(await page.locator(".novel-settings-panel").count(), 1);
          assert.equal(await font.evaluate(button => button === document.activeElement), true, "a chapter retry result must not steal newer settings focus");
          await font.press("Enter");
          assert.equal(await page.evaluate(() => fixture.state.novel.settings.fontSize), 21, "the current settings control must remain usable");
        } finally { await page.close(); }
      });

      for (const error of ["", "obsolete retry failure"]) await run(`chapter retry yields to a new book ${error ? "error" : "success"} ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          await openChapter(page, "A", 1);
          const failed = hold(url => url.pathname === "/api/novels/A/chapters/3", "controlled chapter failure");
          await launchChapter(page, "A", 3); await requested(failed); await settle(page, failed);
          const retry = page.getByRole("button", { name: "重试章节", exact: true });
          await retry.evaluate(button => { fixture.oldChapterRetry = button; });
          const pending = hold(failed.match, error);
          await retry.click(); await requested(pending);
          await page.evaluate(() => fixture.page.openBook("B")); await detailTitle(page, "Book B");
          await page.waitForFunction(() => !fixture.state.novel.catalogLoading);
          const reads = countRequests(failed.match);
          await page.evaluate(() => fixture.oldChapterRetry.click()); await tick(page);
          assert.equal(countRequests(failed.match), reads, "old retry controls cannot navigate away from a new book");
          await finishOld(page, pending, ignoreAbort);
          assert.equal(await page.locator(".novel-detail-title").textContent(), "Book B");
          assert.equal(await retry.count(), 0);
          assert(!(await page.locator("#workGrid").textContent()).includes("obsolete retry failure"));
        } finally { await page.close(); }
      });
      await run(`chapter retry is retired by a new chapter in the same book ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          await openChapter(page, "A", 1);
          const failed = hold(url => url.pathname === "/api/novels/A/chapters/3", "controlled chapter failure");
          await launchChapter(page, "A", 3); await requested(failed); await settle(page, failed);
          await page.getByRole("button", { name: "重试章节", exact: true }).evaluate(button => { fixture.oldChapterRetry = button; });
          await openChapter(page, "A", 2);
          const reads = countRequests(failed.match);
          await page.evaluate(() => fixture.oldChapterRetry.click()); await tick(page);
          assert.equal(countRequests(failed.match), reads);
          await readerTitle(page, "A", 2);
        } finally { await page.close(); }
      });

      await run(`small catalog keyboard skips hidden pagination even with no matches ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          await openChapter(page, "A", 1);
          await page.locator('[data-reader-focus="toolbar-目录"]').click();
          await page.waitForFunction(() => document.querySelectorAll(".novel-reader-catalog-list .novel-chapter-button").length === 3);
          const close = page.locator('[data-reader-focus="catalog-close"]');
          const order = page.locator(".novel-catalog-order");
          const lastChapter = page.locator(".novel-reader-catalog-list .novel-chapter-button").last();
          assert.equal(await page.locator(".novel-catalog-pagination").isVisible(), false, "short catalogs keep pagination hidden");
          await close.focus(); await page.keyboard.press("Shift+Tab");
          assert.equal(await lastChapter.evaluate(button => button === document.activeElement), true);
          await page.keyboard.press("Tab");
          assert.equal(await close.evaluate(button => button === document.activeElement), true);

          await page.locator('[data-reader-focus="catalog-search"]').fill("no such chapter");
          assert.equal(await page.locator(".novel-reader-catalog-list .novel-chapter-button").count(), 0);
          await order.focus(); await page.keyboard.press("Tab");
          assert.equal(await close.evaluate(button => button === document.activeElement), true, "empty small catalog forward Tab must wrap from the last visible control");
          await page.keyboard.press("Shift+Tab");
          assert.equal(await order.evaluate(button => button === document.activeElement), true, "empty small catalog reverse Tab must skip the hidden page controls");
          for (let index = 0; index < 6; index++) {
            await page.keyboard.press("Tab");
            assert.equal(await page.locator(".novel-reader-drawer-panel").evaluate(panel => panel.contains(document.activeElement)), true);
          }
          await page.keyboard.press("Escape");
          assert.equal(await page.locator('[data-reader-focus="toolbar-目录"]').evaluate(button => button === document.activeElement), true);
        } finally { await page.close(); }
      });

      await run(`long catalog bounds DOM and locates current chapter across filtering and ordering ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          const reply = chapterResponse("A", 1);
          reply.book.chapterCount = 10000; reply.chapterTotal = 10000; reply.chapter = chapter("A", 9000); reply.prev = reply.next = null;
          const chapterRead = hold(url => url.pathname === "/api/novels/A/chapters/9000", "", reply);
          await launchChapter(page, "A", 9000); await requested(chapterRead); await settle(page, chapterRead); await readerTitle(page, "A", 9000);
          const before = await rememberReader(page);
          const catalog = hold(url => url.pathname === "/api/novels/A/catalog", "", longCatalog());
          await page.locator('[data-reader-focus="toolbar-目录"]').click(); await requested(catalog);
          const measured = await measureReaderRender(page, () => settle(page, catalog));
          const buttons = page.locator(".novel-reader-catalog-list .novel-chapter-button");
          assert.equal(await buttons.count(), 120, "a 10,000 chapter directory must mount only one bounded page");
          assert(measured.elements < 300, `long catalog completion allocated ${measured.elements} elements`);
          assert.equal(measured.roots, 0, "directory metadata must not replace the mounted reader");
          assert.equal(await page.locator('.novel-reader-catalog-list [aria-current="page"]').getAttribute("data-chapter-index"), "9000");
          const pageInput = page.getByRole("spinbutton", { name: "目录页码", exact: true });
          assert.equal(await pageInput.inputValue(), "75", "opening a deep reader must start on the current chapter's page");
          assert.equal(await pageInput.getAttribute("max"), "84");
          await pageInput.fill("84"); await pageInput.press("Enter");
          assert.equal(await buttons.count(), 40);
          assert.match(await buttons.first().textContent(), /9,961 · A Chapter 9961/);
          assert.match(await buttons.last().textContent(), /10,000 · Target Chapter 10000/);
          assert.equal(await page.getByRole("button", { name: "下一页目录", exact: true }).isDisabled(), true);
          await page.locator(".novel-catalog-order").click();
          assert.equal(await pageInput.inputValue(), "1");
          assert.match(await buttons.first().textContent(), /10,000 · Target Chapter 10000/);
          const search = page.locator('[data-reader-focus="catalog-search"]');
          await search.fill("Target");
          assert.equal(await buttons.count(), 100, "search must include matches beyond the mounted page");
          await search.fill("no such chapter");
          assert.equal(await buttons.count(), 0);
          assert.equal(await page.locator(".novel-catalog-empty").textContent(), "没有匹配的章节");
          await page.getByRole("button", { name: "当前章节", exact: true }).click();
          assert.equal(await search.inputValue(), "");
          assert.equal(await pageInput.inputValue(), "9", "current chapter locator must honor descending order");
          assert.equal(await page.evaluate(() => document.activeElement?.dataset.chapterIndex), "9000");
          assert.equal(await buttons.count(), 120);
          assert.equal(await page.evaluate(() => window.scrollY), before.scroll, "directory navigation must not move the underlying reader");
          console.log(`MEASURE long catalog: ${await buttons.count()} mounted chapter buttons from 10000 chapters; ${measured.elements} elements on completion (${transport})`);
          await page.setViewportSize({ width: 390, height: 820 }); await tick(page);
          assert.equal(await page.locator(".novel-reader-drawer-panel").evaluate(panel => panel.scrollWidth <= panel.clientWidth), true,
            "long catalog controls must fit the narrow reader panel");
          await pageInput.focus(); await page.keyboard.press("Escape"); await tick(page);
          assert.equal(await page.locator(".novel-reader-drawer").count(), 0, "Escape from the page input closes the catalog");
          await page.locator('[data-reader-focus="toolbar-目录"]').click(); await tick(page);
          assert.equal(await pageInput.inputValue(), "9", "reopening locates the current chapter in the cached descending directory");

          await search.fill("A Chapter 9001");
          assert.equal(await buttons.count(), 1);
          const selectedReply = { ...reply, chapter: chapter("A", 9001) };
          const selected = hold(url => url.pathname === "/api/novels/A/chapters/9001", "", selectedReply);
          await buttons.click(); await requested(selected);
          assert.equal(new URL(selected.url, base).searchParams.get("chapterId"), "A-9001", "selection must keep the exact catalog chapter identity");
          await page.evaluate(() => fixture.page.openBook("B")); await detailTitle(page, "Book B");
          await finishOld(page, selected, ignoreAbort);
          assert.equal(await page.locator(".novel-detail-title").textContent(), "Book B", "late deep chapter selection cannot replace newer navigation");
        } finally { await page.close(); }
      });

      await run(`long detail catalog paginates without rereading and clamps page input ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          const metadata = hold(url => url.pathname === "/api/novels/A", "", { book: { ...book("A"), chapterCount: 10000 }, chapterTotal: 10000 });
          const catalog = hold(url => url.pathname === "/api/novels/A/catalog", "", longCatalog());
          await page.evaluate(() => { fixture.pending.push(fixture.page.openBook("A")); }); await requested(metadata); await settle(page, metadata); await requested(catalog); await settle(page, catalog);
          const reads = countRequests(url => url.pathname.startsWith("/api/novels/A"));
          const buttons = page.locator(".novel-catalog-grid .novel-chapter-button");
          const pageInput = page.getByRole("spinbutton", { name: "目录页码", exact: true });
          assert.equal(await buttons.count(), 120);
          assert.equal(await pageInput.inputValue(), "1");
          await page.getByRole("button", { name: "下一页目录", exact: true }).click();
          assert.match(await buttons.first().textContent(), /121 · A Chapter 121/);
          await pageInput.fill("999"); await pageInput.press("Enter");
          assert.equal(await pageInput.inputValue(), "84"); assert.equal(await buttons.count(), 40);
          await pageInput.fill("0"); await pageInput.press("Enter");
          assert.equal(await pageInput.inputValue(), "1");
          assert.equal(await page.getByRole("button", { name: "上一页目录", exact: true }).isDisabled(), true);
          assert.equal(countRequests(url => url.pathname.startsWith("/api/novels/A")), reads, "local directory navigation must reuse the fetched catalog");
        } finally { await page.close(); }
      });

      for (const context of ["reader", "detail"]) await run(`catalog composition defers filtering and owns its committed input ${context} ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          const size = context === "reader" ? 10000 : 5000;
          const catalogData = longCatalog(); catalogData.chapters = catalogData.chapters.slice(0, size); catalogData.total = size;
          for (const [index, item] of catalogData.chapters.entries()) if (index % 100 === 99) item.title = `目标章节 ${index + 1}`;
          const catalog = hold(url => url.pathname === "/api/novels/A/catalog", "", catalogData);
          if (context === "reader") {
            const reply = chapterResponse("A", 1); reply.book.chapterCount = size; reply.chapterTotal = size;
            const read = hold(url => url.pathname === "/api/novels/A/chapters/1", "", reply);
            await launchChapter(page, "A", 1); await requested(read); await settle(page, read); await readerTitle(page, "A", 1);
            await page.evaluate(() => {
              fixture.composingReader = document.querySelector(".novel-reader-page");
              fixture.composingParagraph = document.querySelector(".novel-reader-content p");
              const range = document.createRange(); range.selectNodeContents(fixture.composingParagraph);
              getSelection().removeAllRanges(); getSelection().addRange(range); fixture.composingRange = range; fixture.composingSelection = getSelection().toString();
            });
            await page.locator('[data-reader-focus="toolbar-目录"]').focus(); await page.keyboard.press("Enter");
          } else {
            const metadata = hold(url => url.pathname === "/api/novels/A", "", { book: { ...book("A"), chapterCount: size }, chapterTotal: size });
            await page.evaluate(() => { fixture.pending.push(fixture.page.openBook("A")); }); await requested(metadata); await settle(page, metadata);
          }
          await requested(catalog); await settle(page, catalog);
          await page.getByRole("button", { name: "下一页目录", exact: true }).focus(); await page.keyboard.press("Enter");
          const search = page.getByRole("searchbox", { name: "搜索章节", exact: true }); await search.focus();
          await search.evaluate(input => { fixture.compositionSearch = input; });
          const buttons = page.locator(".novel-chapter-button"), reads = countRequests(url => url.pathname === "/api/novels/A/catalog");
          await buttons.evaluateAll(nodes => { fixture.composingButtons = nodes; });
          const composing = await measureReaderRender(page, () => search.evaluate(input => {
            input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
            for (const value of ["m", "mu", "mu biao", "目"]) {
              input.value = value; input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
            }
          }));
          console.log(`MEASURE directory IME ${size}: ${JSON.stringify(composing)} for 4 intermediate input events (${transport})`);
          assert.equal(await page.evaluate(() => fixture.state.novel.catalogQuery), "", "intermediate IME text must not become a committed catalog query");
          assert.deepEqual(composing, { roots: 0, elements: 0 }, "IME composition must not rebuild directory results");
          assert.equal(await page.getByRole("spinbutton", { name: "目录页码", exact: true }).inputValue(), "2", "IME composition keeps the current directory page");
          assert.equal(await page.evaluate(() => fixture.composingButtons.every((node, index) => node === document.querySelectorAll(".novel-chapter-button")[index])), true);
          await search.evaluate(input => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true, cancelable: true })));
          assert.equal(await page.evaluate(() => fixture.compositionSearch.isConnected && document.activeElement === fixture.compositionSearch), true,
            "an IME cancellation Escape must not close the reader catalog or steal focus");
          await search.evaluate(input => {
            input.value = ""; input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); input.dispatchEvent(new InputEvent("input", { bubbles: true }));
          });
          assert.equal(await page.getByRole("spinbutton", { name: "目录页码", exact: true }).inputValue(), "2", "cancelling composition preserves the previous committed page");
          await search.evaluate(input => {
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, keyCode: 27, bubbles: true, cancelable: true }));
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 229, bubbles: true, cancelable: true }));
          });
          assert.equal(await page.evaluate(() => fixture.compositionSearch.isConnected && document.activeElement === fixture.compositionSearch), true,
            "composition flags and legacy 229 keep cancellation keys local to the input");
          const committed = await measureReaderRender(page, () => search.evaluate(input => {
            input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); input.value = "目标章节";
            input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "目标章节" }));
          }));
          assert.deepEqual(committed, { roots: 0, elements: size / 100 }, "the completed Chinese query renders its bounded matches exactly once");
          assert.equal(await buttons.count(), size / 100); assert.equal(await page.evaluate(() => fixture.state.novel.catalogQuery), "目标章节");
          const duplicate = await measureReaderRender(page, () => search.evaluate(input => input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: false }))));
          assert.deepEqual(duplicate, { roots: 0, elements: 0 }, "the trailing composition input must not render the same query twice");
          if (context === "reader") {
            assert.equal(await page.evaluate(() => fixture.composingReader === document.querySelector(".novel-reader-page") && fixture.composingParagraph === document.querySelector(".novel-reader-content p")), true,
              "catalog composition keeps the mounted chapter text");
            await search.press("Escape"); assert.equal(await page.locator(".novel-reader-drawer").count(), 0, "after composition ends, normal Escape still closes the catalog");
            assert.equal(await page.evaluate(() => fixture.composingRange.startContainer.isConnected && fixture.composingRange.toString() === fixture.composingSelection), true,
              "catalog composition must not invalidate the chapter selection anchors");
            await page.locator('[data-reader-focus="toolbar-目录"]').focus(); await page.keyboard.press("Enter"); await tick(page);
          }
          await search.fill("A Chapter 11"); assert((await buttons.count()) > 0 && (await buttons.count()) <= 120, "ordinary input still filters synchronously within the mounted page limit");
          assert.equal(countRequests(url => url.pathname === "/api/novels/A/catalog"), reads, "local catalog composition cannot reread the directory");
          await search.evaluate(input => { fixture.oldCatalogSearch = input; input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); input.value = "旧目录"; });
          await page.evaluate(() => fixture.page.openBook("B")); await detailTitle(page, "Book B"); await page.waitForFunction(() => !fixture.state.novel.catalogLoading);
          await page.evaluate(() => { fixture.oldCatalogSearch.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "旧目录" })); fixture.oldCatalogSearch.dispatchEvent(new InputEvent("input", { bubbles: true })); });
          assert.equal(await page.evaluate(() => fixture.state.novel.catalogQuery), "", "a detached catalog input must not commit its old query into the new book");
        } finally { await page.close(); }
      });

      await run(`reader panels preserve selection and toolbar identity across keyboard close ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          await openChapter(page, "A", 1); const before = await rememberReader(page);
          await page.evaluate(() => {
            const paragraph = document.querySelector(".novel-reader-content p");
            const range = document.createRange(); range.setStart(paragraph.firstChild, 0); range.setEnd(paragraph.firstChild, 12);
            getSelection().removeAllRanges(); getSelection().addRange(range);
            fixture.selectedText = getSelection().toString();
            fixture.settingsTrigger = document.querySelector('[data-reader-focus="toolbar-设置"]');
            fixture.catalogTrigger = document.querySelector('[data-reader-focus="toolbar-目录"]');
          });
          await page.locator('[data-reader-focus="toolbar-设置"]').focus(); await page.keyboard.press("Enter");
          await assertReaderPreserved(page, before);
          assert.equal(await page.evaluate(() => getSelection().toString() === fixture.selectedText), true, "opening settings must not clear selected chapter text");
          assert.equal(await page.locator('[data-reader-focus="toolbar-设置"]').getAttribute("aria-expanded"), "true");
          await page.keyboard.press("Escape"); await tick(page);
          assert.equal(await page.evaluate(() => document.activeElement === fixture.settingsTrigger), true, "Escape must restore the original settings trigger");
          assert.equal(await page.locator('[data-reader-focus="toolbar-设置"]').getAttribute("aria-expanded"), "false");
          const catalog = hold(url => url.pathname === "/api/novels/A/catalog");
          await page.locator('[data-reader-focus="toolbar-目录"]').focus(); await page.keyboard.press("Enter"); await requested(catalog);
          assert.equal(await page.locator(".novel-reader-paper").evaluate(node => node.inert), true);
          assert.equal(await page.locator(".novel-reader-toolbar").evaluate(node => node.inert), true);
          await page.keyboard.press("Tab");
          assert.equal(await page.evaluate(() => document.activeElement.dataset.readerFocus), "catalog-close", "a loading catalog keeps keyboard focus in its close control");
          await page.keyboard.press("Escape"); await tick(page);
          assert.equal(await page.evaluate(() => document.activeElement === fixture.catalogTrigger), true);
          assert.equal(await page.locator(".novel-reader-paper").evaluate(node => node.inert), false);
          assert.equal(await page.locator(".novel-reader-toolbar").evaluate(node => node.inert), false);
          assert.equal(await page.locator('[data-reader-focus="toolbar-目录"]').getAttribute("aria-expanded"), "false");
          const measured = await measureReaderRender(page, () => settle(page, catalog));
          assert.deepEqual(measured, { roots: 0, elements: 0 });
          await assertReaderPreserved(page, before);
          assert.equal(await page.evaluate(() => getSelection().toString() === fixture.selectedText), true);
        } finally { await page.close(); }
      });

      await run(`reader catalog loading renders 1000 paragraphs once and reuses cached catalog ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          const reply = chapterResponse("A", 1);
          reply.chapter.content = Array.from({ length: 1000 }, (_, index) => `Synthetic long paragraph ${index}. No real library content.`).join("\n\n");
          const chapterRead = hold(url => url.pathname === "/api/novels/A/chapters/1", "", reply);
          await launchChapter(page, "A", 1); await requested(chapterRead); await settle(page, chapterRead); await readerTitle(page, "A", 1);
          const before = await rememberReader(page), catalog = hold(url => url.pathname === "/api/novels/A/catalog");
          const reads = countRequests(catalog.match);
          await page.locator('[data-reader-focus="toolbar-设置"]').click(); await tick(page);
          assert.equal(await page.locator(".novel-settings-panel").count(), 1);
          await assertReaderPreserved(page, before);
          const measured = await measureReaderRender(page, async () => {
            await page.locator('[data-reader-focus="toolbar-目录"]').click(); await requested(catalog);
          });
          assert.equal(measured.roots, 0, "opening an uncached catalog must retain the mounted chapter");
          assert(measured.elements < 50, `catalog opening created ${measured.elements} elements instead of only its panel`);
          console.log(`MEASURE catalog loading: ${measured.roots} reader render, ${measured.elements} elements for 1000 paragraphs (${transport})`);
          assert.equal(await page.locator(".novel-reader-content p").count(), 1000);
          assert.equal(await page.locator(".novel-settings-panel").count(), 0);
          assert.equal(await page.locator(".novel-catalog-loading").textContent(), "正在读取章节目录…");
          assert.equal(await page.locator(".novel-catalog-loading").isVisible(), true);
          await assertReaderPositionAndFocus(page, before, "catalog-close");
          assert.equal(countRequests(catalog.match), reads + 1);
          await settle(page, catalog);
          await assertReaderPreserved(page, before);
          assert.equal(await page.locator(".novel-reader-catalog-list button").count(), 3);
          await assertReaderPositionAndFocus(page, before, "catalog-close");
          const closed = await measureReaderRender(page, () => page.locator('[data-reader-focus="catalog-close"]').click());
          assert.deepEqual(closed, { roots: 0, elements: 0 }); assert.equal(await page.locator(".novel-reader-drawer").count(), 0);
          await assertReaderPositionAndFocus(page, before, "toolbar-目录");
          const reopened = await measureReaderRender(page, () => page.locator('[data-reader-focus="toolbar-目录"]').click());
          assert.equal(reopened.roots, 0); assert(reopened.elements < 50); assert.equal(await page.locator(".novel-reader-catalog-list button").count(), 3);
          await assertReaderPositionAndFocus(page, before, "catalog-search");
          assert.equal(countRequests(catalog.match), reads + 1, "cached catalog open/close must not issue a second GET");
          await page.locator('[data-reader-focus="catalog-search"]').fill("Chapter 3");
          assert.equal(await page.locator(".novel-reader-catalog-list button").count(), 1);
          await page.locator(".novel-reader-catalog-list button").click(); await readerTitle(page, "A", 3);
        } finally { await page.close(); }
      });

      await run(`reader catalog loading failure can close and retry once ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          await openChapter(page, "A", 1); const before = await rememberReader(page);
          const failed = hold(url => url.pathname === "/api/novels/A/catalog", "controlled reader catalog error"), reads = countRequests(failed.match);
          const measured = await measureReaderRender(page, async () => {
            await page.locator('[data-reader-focus="toolbar-目录"]').click(); await requested(failed);
          });
          assert.equal(measured.roots, 0); await assertReaderPreserved(page, before); await assertReaderPositionAndFocus(page, before, "catalog-close");
          await settle(page, failed);
          assert.equal(await page.locator(".novel-catalog-loading.error").textContent(), "controlled reader catalog error");
          assert.equal(await page.evaluate(() => fixture.state.novel.catalogLoading), false);
          await assertReaderPositionAndFocus(page, before, "catalog-close");
          await page.locator('[data-reader-focus="catalog-close"]').click(); await tick(page);
          await assertReaderPositionAndFocus(page, before, "toolbar-目录");
          const retry = hold(failed.match);
          const retried = await measureReaderRender(page, async () => {
            await page.locator('[data-reader-focus="toolbar-目录"]').click(); await requested(retry);
          });
          assert.equal(retried.roots, 0); await assertReaderPreserved(page, before); assert.equal(await page.locator(".novel-catalog-loading").textContent(), "正在读取章节目录…");
          await assertReaderPositionAndFocus(page, before, "catalog-close");
          await settle(page, retry); assert.equal(await page.locator(".novel-reader-catalog-list button").count(), 3);
          assert.equal(countRequests(failed.match), reads + 2); assert.equal(await page.evaluate(() => fixture.state.novel.catalogError), "");
        } finally { await page.close(); }
      });

      for (const error of ["", "obsolete reader catalog error"]) {
        await run(`reader catalog loading completion after close preserves reader ${error ? "error" : "success"} ${transport}`, async () => {
          const page = await newPage({ ignoreAbort });
          try {
            await openChapter(page, "A", 1); await rememberReader(page);
            const catalog = hold(url => url.pathname === "/api/novels/A/catalog", error);
            await page.locator('[data-reader-focus="toolbar-目录"]').click(); await requested(catalog);
            await page.locator('[data-reader-focus="catalog-close"]').click(); const before = await rememberReader(page);
            const completed = await measureReaderRender(page, () => settle(page, catalog));
            assert.deepEqual(completed, { roots: 0, elements: 0 }, "a closed catalog completion cannot rebuild the reader");
            await assertReaderPreserved(page, before); await assertReaderPositionAndFocus(page, before, "toolbar-目录");
            assert.equal(await page.locator(".novel-reader-drawer").count(), 0);
            assert.equal(await page.evaluate(() => fixture.state.novel.catalogLoading), false);
          } finally { await page.close(); }
        });

        for (const target of ["book", "leave"]) await run(`reader catalog loading yields to ${target} ${error ? "error" : "success"} ${transport}`, async () => {
          const page = await newPage({ ignoreAbort });
          try {
            await openChapter(page, "A", 1);
            const catalog = hold(url => url.pathname === "/api/novels/A/catalog", error);
            await page.locator('[data-reader-focus="toolbar-目录"]').click(); await requested(catalog);
            if (target === "book") {
              await openChapter(page, "B", 2); await rememberReader(page);
            } else {
              await page.evaluate(() => { fixture.page.resetReader(); fixture.state.activeView = "gallery"; document.querySelector("#workGrid").replaceChildren(document.createElement("section")); });
            }
            const destination = await page.evaluate(() => {
              fixture.catalogDestination = document.querySelector("#workGrid").firstElementChild;
              return { scroll: window.scrollY, route: `${location.pathname}${location.search}` };
            });
            const completed = await measureReaderRender(page, () => finishOld(page, catalog, ignoreAbort));
            assert.deepEqual(completed, { roots: 0, elements: 0 }, "obsolete catalog response cannot create elements in the new destination");
            assert.equal(await page.evaluate(() => fixture.catalogDestination === document.querySelector("#workGrid").firstElementChild), true);
            assert.deepEqual(await page.evaluate(() => ({ scroll: window.scrollY, route: `${location.pathname}${location.search}` })), destination);
            assert(!(await page.locator("#workGrid").textContent()).includes("obsolete reader catalog error"));
            assert(await page.evaluate(url => __transport.aborted.includes(url), catalog.url));
            if (target === "book") assert.deepEqual(await snapshot(page), { book: "B", chapter: 2, loading: false, status: "" });
          } finally { await page.close(); }
        });
      }

      await run(`ranking recovery retries initial failures with keyboard focus and newer intent ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort });
        try {
          const match = url => url.pathname === "/api/novels" && url.searchParams.get("sort") === "chars" && url.searchParams.get("offset") === "0";
          const failed = hold(match, "Controlled initial ranking failure");
          await page.locator(".novel-section-menu").getByRole("button", { name: "排行榜", exact: true }).click(); await requested(failed); await settle(page, failed);
          const retry = page.getByRole("button", { name: "重试排行榜", exact: true });
          assert.equal(await retry.count(), 1, "an initial ranking failure needs an in-context retry action");
          await page.setViewportSize({ width: 320, height: 640 });
          assert.equal(await retry.evaluate(button => { button.scrollIntoView(); const box = button.getBoundingClientRect(); return box.height >= 44 && box.left >= 0 && box.right <= innerWidth && document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === button; }), true,
            "ranking recovery must stay visible and clickable at 320px");
          if (process.argv.includes("--screenshots")) {
            const output = path.join(root, ".codex-artifacts", "novels"); fs.mkdirSync(output, { recursive: true });
            await page.locator(".novel-ranking-board").screenshot({ path: path.join(output, "ranking-retry-320.png") });
          }
          const again = hold(match, "Controlled ranking retry failure"); await retry.focus(); await retry.press("Enter"); await requested(again); await settle(page, again);
          assert((await page.locator(".novel-ranking-status").textContent()).includes("Controlled ranking retry failure"));
          assert.equal(await retry.evaluate(button => button === document.activeElement), true, "a failed keyboard ranking retry returns focus to its current recovery action");
          assert.equal(await retry.evaluate(button => { const box = button.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight && button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)); }), true,
            "a restored ranking retry focus must remain visible and reachable");
          const newerFocus = hold(match, "Controlled ranking failure after focus change");
          await retry.press("Enter"); await requested(newerFocus);
          const menu = page.locator(".novel-section-menu").getByRole("button", { name: "书库", exact: true }); await menu.focus(); await settle(page, newerFocus);
          assert.equal(await menu.evaluate(button => button === document.activeElement), true, "a ranking retry response must respect newer menu focus");
          const success = hold(match, "", rankingPage(0)); await retry.focus(); await retry.press("Enter"); await requested(success);
          assert.equal(await retry.count(), 0, "loading ranking results cannot offer another retry");
          await settle(page, success);
          assert.equal(await page.locator(".novel-ranking-row").count(), 48);
          assert.equal(await page.locator(".novel-ranking-status").count(), 0);
          assert.equal(await page.locator(".novel-ranking-heading h2").evaluate(heading => heading === document.activeElement), true,
            "a successful keyboard retry moves focus to the current ranking results heading");
          assert.equal(await page.locator(".novel-ranking-heading h2").evaluate(heading => { const box = heading.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight && heading.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)); }), true,
            "ranking results focus must be visible above the table after retry");
          assert.equal(new URL(success.url, base).searchParams.get("sort"), "chars");
          assert.equal(new URL(success.url, base).searchParams.get("offset"), "0");
        } finally { await page.close(); }
      });

      await run(`ranking recovery retains old rows and current page and retires stale actions ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort });
        try {
          const match = (sort, offset) => url => url.pathname === "/api/novels" && (url.searchParams.get("sort") || "updated") === sort && Number(url.searchParams.get("offset") || 0) === offset;
          const initial = hold(match("chars", 0), "", rankingPage(0));
          await page.locator(".novel-section-menu").getByRole("button", { name: "排行榜", exact: true }).click(); await requested(initial); await settle(page, initial);
          const failed = hold(match("chars", 48), "Controlled ranking page failure");
          await page.getByRole("button", { name: "第 2 页", exact: true }).click(); await requested(failed);
          assert.equal(await page.locator(".novel-ranking-board").getAttribute("aria-busy"), "true");
          assert.equal((await page.locator(".novel-ranking-position").first().textContent()).trim(), "1", "a pending page cannot relabel retained rows as the new page");
          await settle(page, failed);
          const status = page.locator(".novel-ranking-status");
          assert((await status.textContent()).includes("Controlled ranking page failure"));
          assert((await status.textContent()).includes("仍显示上次"), "a failed replacement must explain that the old ranking rows are retained");
          assert.equal(await page.locator(".novel-ranking-board").getAttribute("aria-busy"), "false");
          const retry = page.getByRole("button", { name: "重试排行榜", exact: true });
          const again = hold(match("chars", 48), "Controlled ranking page retry failure"); await retry.click(); await requested(again);
          assert.equal(new URL(again.url, base).searchParams.get("offset"), "48", "retry must read the failed ranking page, not its first page");
          await settle(page, again);
          await retry.evaluate(button => { window.__oldRankingRetry = button; });
          const newerSort = hold(match("updated", 0), "Controlled replacement ranking sort failure");
          await page.getByRole("button", { name: "按日期", exact: true }).click(); await requested(newerSort);
          const before = countRequests(url => url.pathname === "/api/novels");
          await page.evaluate(() => __oldRankingRetry.dispatchEvent(new MouseEvent("click"))); await tick(page);
          assert.equal(countRequests(url => url.pathname === "/api/novels"), before, "a detached ranking retry cannot restart an old page after a new sort");
          await settle(page, newerSort);
          assert((await status.textContent()).includes("Controlled replacement ranking sort failure"));
          const pending = hold(match("updated", 0), "", rankingPage(0));
          await retry.evaluate(button => { window.__oldRankingRetry = button; }); await retry.click(); await requested(pending);
          await page.locator(".novel-ranking-book").filter({ hasText: /^Book B$/ }).click(); await detailTitle(page, "Book B");
          const reads = countRequests(url => url.pathname === "/api/novels");
          await page.evaluate(() => __oldRankingRetry.dispatchEvent(new MouseEvent("click"))); await tick(page);
          assert.equal(countRequests(url => url.pathname === "/api/novels"), reads, "an obsolete ranking retry cannot leave a new book detail");
          await finishOld(page, pending, ignoreAbort);
          assert.equal(await page.locator(".novel-detail-title").textContent(), "Book B");
          assert.equal(await page.locator(".novel-ranking-status").count(), 0);
        } finally { await page.close(); }
      });

      await run(`library date formatting shares one formatter across 1000 dated books ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          const data = libraryPage(1000);
          for (const book of data.books) book.updatedAt = "2026-10-28T12:00:00Z";
          data.books[1].updatedAt = "invalid-date";
          delete data.books[2].updatedAt;
          const measured = await page.evaluate(data => {
            Object.assign(fixture.state.novel, { mode: "books", category: "all", query: "", author: "", data, loading: false, hasMore: false });
            const original = Intl.DateTimeFormat;
            let created = 0;
            Intl.DateTimeFormat = new Proxy(original, { construct(target, args) { created++; return Reflect.construct(target, args); } });
            const samples = [];
            try {
              for (let sample = 0; sample < 3; sample++) {
                const start = performance.now();
                fixture.page.renderView();
                const renderMs = performance.now() - start;
                document.querySelector(".novel-library").getBoundingClientRect();
                samples.push({ renderMs: +renderMs.toFixed(2), withLayoutMs: +(performance.now() - start).toFixed(2) });
              }
              return { created, samples };
            } finally { Intl.DateTimeFormat = original; }
          }, data);
          console.log(`MEASURE 1000 dated books: ${JSON.stringify(measured)} (${transport})`);
          assert(measured.created <= 1, "dated books must reuse the shared date formatter instead of constructing one per row");
          assert.equal(await page.locator(".novel-book-row").count(), 1000, "date formatting optimization must keep every book mounted");
          const dates = await page.locator(".novel-book-latest").allTextContents();
          assert(dates[0].includes("2026-10-28")); assert(dates[1].includes("invalid-date")); assert(!dates[2].includes("更新"));
          await page.evaluate(() => { fixture.state.novel.mode = "rankings"; fixture.state.novel.data.books = fixture.state.novel.data.books.slice(0, 3); fixture.page.renderView(); });
          assert.deepEqual(await page.locator(".novel-ranking-date").allTextContents(), ["2026-10-28", "invalid-date", "—"]);
        } finally { await page.close(); }
      });

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

      await run(`book opening preserves the loaded library while metadata is pending ${transport}`, async () => {
        const page = await newPage({ ignoreAbort, manualObservers: true });
        const metadata = hold(url => url.pathname === "/api/novels/A" && url.searchParams.get("catalog") === "0");
        try {
          await seedBookOpeningSource(page, 1000);
          const button = page.locator(".novel-book-row").filter({ has: page.getByRole("button", { name: "Book A", exact: true }) }).locator(".novel-book-detail");
          const before = await rememberBookOpeningSource(page, button);
          const reads = countRequests(url => url.pathname === "/api/novels"), calls = countRequests(metadata.match);
          await button.click(); await requested(metadata);
          await assertBookOpeningSource(page, before, 1000);
          assert.equal(await button.getAttribute("aria-busy"), "true");
          assert.equal(await button.getAttribute("aria-disabled"), "true");
          assert.equal(await button.evaluate(button => button.disabled), false, "the busy opening action must retain native keyboard focus");
          assert.match(await button.textContent(), /正在打开/, "the original action must expose the pending book operation");
          assert.equal(await page.locator(".novel-library-results").getAttribute("aria-busy"), "true");
          await page.evaluate(() => fixture.bookOpening.more?.click());
          await button.press("Enter"); await button.press("Space"); await tick(page);
          assert.equal(countRequests(metadata.match), calls + 1, "repeated native activation of the pending target must stay single flight");
          assert.equal(countRequests(url => url.pathname === "/api/novels"), reads, "opening metadata must not request another library page");
          await assertBookOpeningSource(page, before, 1000);
          await settle(page, metadata); await detailTitle(page, "Book A");
          assert.equal(await page.locator(".novel-library").count(), 0, "accepted metadata must enter the book's detail layout");
          assert.equal(await page.locator(".novel-book-row").count(), 0);
          assert.equal(await page.evaluate(() => fixture.bookOpening.home.isConnected), false);
          assert.deepEqual(await snapshot(page), { book: "A", chapter: null, loading: false, status: "" });
        } finally { metadata.release(); await page.close(); }
      });

      await run(`book opening failed metadata keeps its target recovery and can retry ${transport}`, async () => {
        const page = await newPage({ ignoreAbort, manualObservers: true });
        const failed = hold(url => url.pathname === "/api/novels/A" && url.searchParams.get("catalog") === "0", "Pending source book unavailable");
        try {
          await seedBookOpeningSource(page, 48);
          const button = page.locator(".novel-book-row").filter({ has: page.getByRole("button", { name: "Book A", exact: true }) }).locator(".novel-book-detail");
          const before = await rememberBookOpeningSource(page, button);
          await button.press("Enter"); await requested(failed);
          await assertBookOpeningSource(page, before, 48);
          await settle(page, failed);
          assert.equal(await page.getByText("Pending source book unavailable", { exact: true }).isVisible(), true);
          assert.equal(await page.locator(".novel-book-recovery").count(), 1, "a current metadata failure must keep the requested target's established recovery layout");
          assert.equal(await page.locator(".novel-detail-title").count(), 0);
          assert.equal(await page.locator(".novel-book-recovery").evaluate(panel => panel.textContent.includes("Book A")), true);
          const retry = page.getByRole("button", { name: "重试打开书籍", exact: true });
          const recovered = hold(failed.match);
          await retry.focus(); await retry.press("Enter"); await requested(recovered); await settle(page, recovered);
          await detailTitle(page, "Book A");
          assert.equal(await page.locator(".novel-book-recovery").count(), 0);
          assert.equal(await page.locator(".novel-detail-title").evaluate(title => title === document.activeElement), true);
        } finally { failed.release(); await page.close(); }
      });

      await run(`book opening yields to newer book query and view ownership ${transport}`, async () => {
        const page = await newPage({ ignoreAbort, manualObservers: true });
        const oldBook = hold(url => url.pathname === "/api/novels/A" && url.searchParams.get("catalog") === "0", "Obsolete opening A failure");
        try {
          await seedBookOpeningSource(page, 48);
          const source = await page.evaluate(() => ({ ids: fixture.state.novel.data.books.map(book => book.id), nextOffset: fixture.state.novel.data.nextOffset,
            query: fixture.state.novel.query, category: fixture.state.novel.category, sort: fixture.state.novel.sort }));
          const reads = countRequests(url => url.pathname === "/api/novels");
          const detailButton = id => page.locator(".novel-book-row").filter({ has: page.getByRole("button", { name: `Book ${id}`, exact: true }) }).locator(".novel-book-detail");
          await detailButton("A").click(); await requested(oldBook);
          const current = hold(url => url.pathname === "/api/novels/B" && url.searchParams.get("catalog") === "0");
          await detailButton("B").click(); await requested(current); await settle(page, current); await detailTitle(page, "Book B");
          await page.evaluate(() => { fixture.openedB = document.querySelector(".novel-detail"); });
          await finishOld(page, oldBook, ignoreAbort);
          assert.equal(await page.evaluate(() => fixture.openedB === document.querySelector(".novel-detail")), true, "an old opening failure must not repaint the newer book");
          assert.equal(await page.locator(".novel-book-recovery").count(), 0);
          await page.getByRole("button", { name: "返回列表", exact: true }).click(); await tick(page);
          assert.equal(await page.locator(".novel-book-row").count(), 48);
          assert.equal(countRequests(url => url.pathname === "/api/novels"), reads, "replacing a pending A with B must keep the already loaded source cache valid");
          assert.equal(await page.evaluate(() => fixture.state.novel.data === fixture.bookOpeningData), true);
          assert.deepEqual(await page.evaluate(() => ({ ids: fixture.state.novel.data.books.map(book => book.id), nextOffset: fixture.state.novel.data.nextOffset,
            query: fixture.state.novel.query, category: fixture.state.novel.category, sort: fixture.state.novel.sort })), source);

          const oldSuccess = hold(oldBook.match);
          await detailButton("A").click(); await requested(oldSuccess);
          const queryData = libraryPage(3); queryData.books[0] = book("A"); queryData.books[1] = book("B");
          const query = hold(url => url.pathname === "/api/novels" && url.searchParams.get("q") === "new source query", "", queryData);
          const input = page.locator(".novel-section-search input");
          await input.fill("new source query"); await input.press("Enter"); await requested(query);
          await page.evaluate(() => { fixture.newOpeningQuery = document.querySelector(".novel-home"); });
          await finishOld(page, oldSuccess, ignoreAbort);
          assert.equal(await page.evaluate(() => fixture.newOpeningQuery === document.querySelector(".novel-home")), true);
          assert.equal(await page.locator(".novel-detail-title").count(), 0, "obsolete metadata success cannot replace a newer library query");
          assert.deepEqual(await page.evaluate(() => ({ loading: fixture.state.novel.loading, status: fixture.state.novel.status, query: fixture.state.novel.query })),
            { loading: true, status: "正在读取小说书库", query: "new source query" }, "the old completion must not release the newer query's busy state");
          assert.equal(await page.locator(".novel-home-loading").count(), 1);
          assert.equal(await input.inputValue(), "new source query");
          await settle(page, query);
          assert.equal(await page.locator(".novel-book-row").count(), 3);
          assert.equal(await page.evaluate(() => fixture.state.novel.query), "new source query");

          const nextSort = await page.locator(".novel-sort").inputValue() === "title" ? "updated" : "title";
          const replacementMatch = url => url.pathname === "/api/novels" && url.searchParams.get("q") === "new source query"
            && (url.searchParams.get("sort") || "updated") === nextSort;
          const replacement = hold(replacementMatch, "", libraryPage(1));
          await page.locator(".novel-sort").selectOption(nextSort); await requested(replacement);
          const conditions = await page.evaluate(() => ({ query: fixture.state.novel.query, category: fixture.state.novel.category,
            sort: fixture.state.novel.sort, cursor: fixture.state.novel.data.nextOffset ?? fixture.state.novel.data.offset + fixture.state.novel.data.books.length }));
          assert.equal(conditions.cursor, 3, "the pending replacement still displays the last delivered raw prefix");
          const replacementA = hold(oldBook.match, "Obsolete A during library replacement");
          await detailButton("A").click(); await requested(replacementA);
          const replacementB = hold(url => url.pathname === "/api/novels/B" && url.searchParams.get("catalog") === "0");
          await detailButton("B").click(); await requested(replacementB); await settle(page, replacementB); await detailTitle(page, "Book B");
          await finishOld(page, replacementA, ignoreAbort); await finishOld(page, replacement, ignoreAbort);
          await detailTitle(page, "Book B");
          const freshData = { ...libraryPage(2), books: [book("A"), book("B")], nextOffset: 2 };
          const fresh = hold(replacementMatch, "", freshData), readsBeforeReturn = countRequests(url => url.pathname === "/api/novels");
          await page.getByRole("button", { name: "返回列表", exact: true }).click(); await requested(fresh);
          const freshUrl = new URL(fresh.url, base);
          assert.equal(freshUrl.searchParams.get("offset"), "0", "a source opened during an unconfirmed replacement must return through a fresh first page");
          assert.equal(freshUrl.searchParams.get("q"), conditions.query);
          assert.equal(freshUrl.searchParams.get("category") || "all", conditions.category);
          assert.equal(freshUrl.searchParams.get("sort") || "updated", conditions.sort);
          assert.equal(countRequests(url => url.pathname === "/api/novels"), readsBeforeReturn + 1, "pending-library A then B cannot turn the unconfirmed source into a reusable cache");
          await settle(page, fresh);
          assert.equal(await page.locator(".novel-book-row").count(), 2);
          assert.equal(await page.evaluate(() => fixture.state.novel.data.nextOffset), 2);
          assert.deepEqual(await page.evaluate(() => ({ query: fixture.state.novel.query, category: fixture.state.novel.category, sort: fixture.state.novel.sort })),
            { query: conditions.query, category: conditions.category, sort: conditions.sort });

          const leaving = hold(oldBook.match, "Obsolete opening after leave");
          await detailButton("A").click(); await requested(leaving);
          await page.evaluate(() => {
            fixture.page.resetReader(); fixture.state.activeView = "gallery";
            fixture.openingDestination = document.createElement("button"); fixture.openingDestination.textContent = "new view action";
            document.querySelector("#workGrid").replaceChildren(fixture.openingDestination); fixture.openingDestination.focus();
          });
          await finishOld(page, leaving, ignoreAbort);
          assert.equal(await page.evaluate(() => document.querySelector("#workGrid").firstChild === fixture.openingDestination
            && document.activeElement === fixture.openingDestination && fixture.state.activeView === "gallery"), true, "a late opening error must not replace or refocus a newer module view");
          assert.equal(await page.locator(".novel-book-recovery").count(), 0);
        } finally { oldBook.release(); await page.close(); }
      });

      await run(`read opening preserves ordinary and author libraries and restores the selected chapter ${transport}`, async () => {
        for (const mode of ["books", "author"]) {
          const target = mode === "author" ? 2 : 1, restoreRatio = mode === "author" ? 0.375 : 0;
          const saved = { chapterId: `A-${target}`, chapterIndex: target, chapterCount: 3, sourceRealm: "server:fixture", catalogRevision: "rev-A", scrollRatio: mode === "author" ? 0.375 : 0.7 };
          const reply = { ...chapterResponse("A", target), book: { ...book("A"), progress: saved }, next: null };
          const page = await newPage({ ignoreAbort, manualObservers: true });
          const chapter = hold(url => url.pathname === `/api/novels/A/chapters/${target}`, "", reply);
          try {
            await seedBookOpeningSource(page, 1000, { mode, progress: mode === "author" ? saved : null });
            const read = page.locator(".novel-book-row").filter({ has: page.getByRole("button", { name: "Book A", exact: true }) }).locator(".novel-book-actions button").last();
            assert.equal(await read.textContent(), mode === "author" ? "继续阅读" : "开始阅读");
            const before = await rememberBookOpeningSource(page, read);
            const listReads = countRequests(url => url.pathname === "/api/novels" || url.pathname.startsWith("/api/novels/authors/"));
            const metadataReads = countRequests(url => url.pathname === "/api/novels/A"), calls = countRequests(chapter.match), writes = progressWrites.length;
            await read.click(); await requested(chapter);
            await assertBookOpeningSource(page, before, 1000, "chapter");
            assert.equal(await read.getAttribute("aria-busy"), "true");
            assert.equal(await read.getAttribute("aria-disabled"), "true");
            assert.equal(await read.evaluate(button => button.disabled), false);
            assert.match(await read.textContent(), /正在翻开/);
            assert.equal(await page.locator(".novel-library-results").getAttribute("aria-busy"), "true");
            assert.equal(await page.locator(".novel-reader-page").count(), 0, "a pending first chapter must keep its real source instead of presenting a fake reader");
            await read.press("Enter"); await read.press("Space");
            await page.evaluate(() => fixture.bookOpening.more?.click()); await tick(page);
            assert.equal(countRequests(chapter.match), calls + 1, "repeated native activation of the same reading target must stay single flight");
            assert.equal(countRequests(url => url.pathname === "/api/novels" || url.pathname.startsWith("/api/novels/authors/")), listReads, "reading cannot append or reload its previous source");
            assert.equal(countRequests(url => url.pathname === "/api/novels/A"), metadataReads, "the source reading action must request its selected chapter directly");
            await assertBookOpeningSource(page, before, 1000, "chapter");
            await settle(page, chapter); await readerTitle(page, "A", target);
            const geometry = await assertReadOpeningGeometry(page, restoreRatio);
            assert.deepEqual(await page.evaluate(() => ({ book: fixture.state.novel.book.id, chapter: fixture.state.novel.chapter.id,
              realm: fixture.state.novel.book.sourceRealm, revision: fixture.state.novel.book.catalogRevision })),
              { book: "A", chapter: `A-${target}`, realm: "server:fixture", revision: "rev-A" });
            assert.equal(await page.locator(".novel-book-row").count(), 0);
            assert.equal(new URL(page.url()).pathname, `/novels/A/${target}`);
            await until(() => progressWrites.slice(writes).some(write => write.bookId === "A" && write.chapterId === `A-${target}`), "the accepted reading target must save its measured progress");
            const progress = progressWrites.slice(writes).findLast(write => write.bookId === "A" && write.chapterId === `A-${target}`);
            assert.equal(progress.sourceRealm, "server:fixture"); assert.equal(progress.catalogRevision, "rev-A"); assert.equal(progress.chapterIndex, target);
            assert(Math.abs(progress.scrollRatio - geometry.expectedRatio) < 0.01, "saved progress must reflect explicit start versus continued reading after real scroll clamping");
          } finally { chapter.release(); await page.close(); }
        }
      });

      await run(`read opening first failure retains its library recovery and can retry the native action ${transport}`, async () => {
        const page = await newPage({ ignoreAbort, manualObservers: true });
        const failed = hold(url => url.pathname === "/api/novels/A/chapters/1", "First source chapter unavailable");
        try {
          await seedBookOpeningSource(page, 48);
          const read = page.locator(".novel-book-row").filter({ has: page.getByRole("button", { name: "Book A", exact: true }) }).locator(".novel-book-actions button").last();
          const before = await rememberBookOpeningSource(page, read);
          await read.press("Enter"); await requested(failed); await assertBookOpeningSource(page, before, 48, "chapter");
          await settle(page, failed);
          assert.equal(await page.locator(".novel-book-row").count(), 48);
          assert.equal(await page.locator(".novel-reader-page").count(), 0);
          assert.equal(await page.locator('[data-reader-focus="chapter-retry"]').count(), 0, "a failed first list read must not invent an already-open reader retry action");
          assert.equal(await page.locator(".novel-book-recovery").count(), 0, "a chapter failure must not become a metadata-target recovery page");
          assert.match(await page.locator(".novel-status-line").textContent(), /First source chapter unavailable/);
          assert.deepEqual(await snapshot(page), { book: null, chapter: null, loading: false, status: "First source chapter unavailable" });
          assert.equal(await read.textContent(), "开始阅读");
          assert.equal(await read.getAttribute("aria-busy"), null);
          const recovered = hold(failed.match, "", { ...chapterResponse("A", 1), next: null });
          await read.focus(); await read.press("Enter"); await requested(recovered); await settle(page, recovered); await readerTitle(page, "A", 1);
          await assertReadOpeningGeometry(page, 0);
          assert.equal(await page.locator('[data-reader-focus="chapter-retry"]').count(), 0);
        } finally { failed.release(); await page.close(); }
      });

      await run(`read opening distinguishes detail intent and yields to newer source ownership ${transport}`, async () => {
        const page = await newPage({ ignoreAbort, manualObservers: true });
        try {
          await seedBookOpeningSource(page, 48);
          const row = id => page.locator(".novel-book-row").filter({ has: page.getByRole("button", { name: `Book ${id}`, exact: true }) });
          const read = id => row(id).locator(".novel-book-actions button").last();
          const detail = id => row(id).locator(".novel-book-detail");
          const sourceSnapshot = () => page.evaluate(() => ({ ids: fixture.state.novel.data.books.map(book => book.id), nextOffset: fixture.state.novel.data.nextOffset,
            mode: fixture.state.novel.mode, query: fixture.state.novel.query, category: fixture.state.novel.category, author: fixture.state.novel.author, sort: fixture.state.novel.sort }));
          const source = await sourceSnapshot(), sourceReads = countRequests(url => url.pathname === "/api/novels");

          const oldRead = hold(url => url.pathname === "/api/novels/A/chapters/1", "Obsolete read while opening A details");
          await read("A").click(); await requested(oldRead);
          const metadata = hold(url => url.pathname === "/api/novels/A" && url.searchParams.get("catalog") === "0");
          await detail("A").click(); await requested(metadata); await settle(page, metadata); await detailTitle(page, "Book A");
          await page.evaluate(() => { fixture.readOpeningDetail = document.querySelector(".novel-detail"); });
          await finishOld(page, oldRead, ignoreAbort);
          assert.equal(await page.evaluate(() => fixture.readOpeningDetail === document.querySelector(".novel-detail")), true, "a same-book detail intent must supersede a pending chapter read and survive its failure");
          assert.equal(await page.locator(".novel-reader-page").count(), 0);
          await page.getByRole("button", { name: "返回列表", exact: true }).click(); await tick(page);
          assert.deepEqual(await sourceSnapshot(), source);
          assert.equal(countRequests(url => url.pathname === "/api/novels"), sourceReads, "a confirmed source stays reusable after read-to-detail redirection");

          const oldMetadata = hold(metadata.match);
          await detail("A").click(); await requested(oldMetadata);
          const currentRead = hold(oldRead.match, "", { ...chapterResponse("A", 1), next: null });
          await read("A").click(); await requested(currentRead); await settle(page, currentRead); await readerTitle(page, "A", 1);
          await page.evaluate(() => { fixture.readOpeningReader = document.querySelector(".novel-reader-page"); });
          await finishOld(page, oldMetadata, ignoreAbort);
          assert.equal(await page.evaluate(() => fixture.readOpeningReader === document.querySelector(".novel-reader-page")), true, "a same-book reading intent must supersede pending metadata and survive its success");
          assert.deepEqual(await snapshot(page), { book: "A", chapter: 1, loading: false, status: "" });
          await page.getByRole("button", { name: "返回列表", exact: true }).click(); await tick(page);
          assert.deepEqual(await sourceSnapshot(), source);
          assert.equal(await page.evaluate(() => fixture.state.novel.data === fixture.bookOpeningData), true);
          assert.equal(countRequests(url => url.pathname === "/api/novels"), sourceReads, "detail-to-read redirection must preserve the entire confirmed raw source prefix");

          const bProgress = { chapterId: "B-2", chapterIndex: 2, chapterCount: 3, sourceRealm: "server:fixture", catalogRevision: "rev-B", scrollRatio: 0.4 };
          const obsolete = hold(url => url.pathname === "/api/novels/B/chapters/1", "", { ...chapterResponse("B", 1), next: null });
          await read("B").click(); await requested(obsolete);
          const queryData = { ...libraryPage(3), nextOffset: 3 }; queryData.books[0] = book("A"); queryData.books[1] = { ...book("B"), progress: bProgress };
          const query = hold(url => url.pathname === "/api/novels" && url.searchParams.get("q") === "read replacement query", "", queryData);
          const input = page.locator(".novel-section-search input");
          await input.fill("read replacement query"); await input.press("Enter"); await requested(query);
          await page.evaluate(() => { fixture.readOpeningQuery = document.querySelector(".novel-home"); });
          await finishOld(page, obsolete, ignoreAbort);
          assert.equal(await page.evaluate(() => fixture.readOpeningQuery === document.querySelector(".novel-home")), true);
          assert.deepEqual(await page.evaluate(() => ({ loading: fixture.state.novel.loading, query: fixture.state.novel.query, status: fixture.state.novel.status })),
            { loading: true, query: "read replacement query", status: "正在读取小说书库" }, "obsolete chapter success cannot release a newer query or fabricate its reader");
          assert.equal(await page.locator(".novel-reader-page").count(), 0);
          await settle(page, query); assert.equal(await page.locator(".novel-book-row").count(), 3);

          const nextSort = await page.locator(".novel-sort").inputValue() === "title" ? "updated" : "title";
          const replacementMatch = url => url.pathname === "/api/novels" && url.searchParams.get("q") === "read replacement query" && (url.searchParams.get("sort") || "updated") === nextSort;
          const replacing = hold(replacementMatch, "", libraryPage(1));
          await page.locator(".novel-sort").selectOption(nextSort); await requested(replacing);
          const conditions = await sourceSnapshot(); assert.equal(conditions.nextOffset, 3);
          const replacingRead = hold(url => url.pathname === "/api/novels/B/chapters/2", "Obsolete read during source replacement");
          await read("B").click(); await requested(replacingRead);
          const replacingMetadata = hold(metadata.match);
          await detail("A").click(); await requested(replacingMetadata); await settle(page, replacingMetadata); await detailTitle(page, "Book A");
          await finishOld(page, replacingRead, ignoreAbort); await finishOld(page, replacing, ignoreAbort);
          const freshData = { ...libraryPage(2), books: [book("A"), { ...book("B"), progress: bProgress }], nextOffset: 2 };
          const fresh = hold(replacementMatch, "", freshData), beforeFresh = countRequests(url => url.pathname === "/api/novels");
          await page.getByRole("button", { name: "返回列表", exact: true }).click(); await requested(fresh);
          const url = new URL(fresh.url, base);
          assert.equal(url.searchParams.get("offset"), "0", "an unconfirmed library replacement followed by read-to-detail must return through a fresh first page");
          assert.equal(url.searchParams.get("q"), conditions.query); assert.equal(url.searchParams.get("category") || "all", conditions.category); assert.equal(url.searchParams.get("sort") || "updated", conditions.sort);
          assert.equal(countRequests(url => url.pathname === "/api/novels"), beforeFresh + 1);
          await settle(page, fresh);
          assert.deepEqual(await sourceSnapshot(), { ids: ["A", "B"], nextOffset: 2, mode: conditions.mode, query: conditions.query, category: conditions.category, author: conditions.author, sort: conditions.sort });

          const leaving = hold(replacingRead.match, "Obsolete chapter after leaving novels");
          await read("B").click(); await requested(leaving);
          await page.evaluate(() => {
            fixture.page.resetReader(); fixture.state.activeView = "gallery";
            fixture.readOpeningDestination = document.createElement("button"); fixture.readOpeningDestination.textContent = "new module action";
            document.querySelector("#workGrid").replaceChildren(fixture.readOpeningDestination); fixture.readOpeningDestination.focus();
          });
          await finishOld(page, leaving, ignoreAbort);
          assert.equal(await page.evaluate(() => document.querySelector("#workGrid").firstChild === fixture.readOpeningDestination
            && document.activeElement === fixture.readOpeningDestination && fixture.state.activeView === "gallery"), true, "an obsolete first-read failure must not replace or refocus a newer module");
          assert.equal(await page.locator(".novel-reader-page, .novel-book-recovery").count(), 0);
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
          assert.equal(await page.evaluate(() => fixture.beforeBook.isConnected), false, "an unknown target outside the delivered prefix must use the fallback layout rather than claim the old list as its confirmed source");
          await settle(page, detail); await detailTitle(page, "Book A");
          assert.equal(await page.evaluate(() => fixture.beforeBook.isConnected), false, "accepted book metadata must replace the source with the final detail layout");
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
  function hold(match, error = "", reply = null) {
    let release, requestedResolve;
    const gate = { id: ++gateSequence, createdCase: activeCase, match, error, reply, used: false, closed: false, released: false,
      promise: new Promise(resolve => { release = resolve; }), requested: new Promise(resolve => { requestedResolve = resolve; }),
      release: () => { gate.released = true; release(); }, requestedResolve };
    held.add(gate); return gate;
  }
  async function requested(gate, timeout = 5000) {
    let timer;
    try { await Promise.race([gate.requested, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`new request did not start before obsolete I/O finished (${timeout}ms)`)), timeout); })]); }
    catch (error) {
      try {
        const pages = browser?.contexts().flatMap(context => context.pages()) || [];
        const states = await Promise.all(pages.map(async page => {
          let diagnosticTimer;
          try {
            const state = await Promise.race([page.evaluate(() => ({ readyState: document.readyState, moduleLoading: document.documentElement.classList.contains("app-module-loading"),
              fixture: Boolean(window.fixture), title: document.querySelector(".novel-detail-title")?.textContent, rows: document.querySelectorAll(".novel-book-row").length,
              text: document.body?.textContent?.slice(0, 240) })), new Promise(resolve => { diagnosticTimer = setTimeout(() => resolve("renderer diagnostic unavailable"), 1000); })]);
            return { url: page.url(), startup: (pageStartupMessages.get(page) || []).slice(-8), state };
          } catch (diagnosticError) { return { url: page.url(), error: diagnosticError.message }; }
          finally { clearTimeout(diagnosticTimer); }
        }));
        console.error("NOVEL_REQUEST_START_FAILURE", JSON.stringify({ case: activeCase, completed: checks, browserPages, totalBrowserPages,
          expected: { id: gate.id, match: String(gate.match).slice(0, 400), used: gate.used, closed: gate.closed, released: gate.released },
          requests: recentApiRequests.filter(request => request.id > caseRequestStart), pages: states, faults: faults.slice(-4), unexpected: unexpected.slice(-4) }));
      } catch (diagnosticError) { console.error("NOVEL_REQUEST_DIAGNOSTIC_FAILURE", diagnosticError.message); }
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function settle(page, gate) { const before = await page.evaluate(url => __transport.settled.filter(item => item.url === url).length, gate.url); gate.release(); await page.waitForFunction(({ url, before }) => __transport.settled.filter(item => item.url === url).length > before, { url: gate.url, before }, { timeout: 5000 }); await tick(page); }
  async function finishOld(page, gate, ignoreAbort) { if (ignoreAbort) await settle(page, gate); else { await until(() => gate.closed, "normal transport must close the obsolete foreground read"); gate.release(); await tick(page); } }
  async function newPage({ real = false, ignoreAbort = true, route = "/novels", waitReady = true, initialBack = false, manualFrames = false, manualObservers = false, plainHttp = false } = {}) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.on("pageerror", error => faults.push(error.message));
    browserPages++; totalBrowserPages++;
    const startupMessages = [];
    const recordStartupMessage = message => { startupMessages.push(message.slice(0, 300)); if (startupMessages.length > 8) startupMessages.shift(); };
    pageStartupMessages.set(page, startupMessages);
    page.on("console", message => { if (message.type() === "error") recordStartupMessage(message.text()); });
    page.on("requestfailed", request => recordStartupMessage(`${new URL(request.url()).pathname}: ${request.failure()?.errorText}`));
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
    const origin = plainHttp ? plainHttpBase : base;
    await page.goto(real ? `${origin}${route}` : `${origin}/probe`, { waitUntil: waitReady ? "load" : "commit" });
    if (waitReady) {
      try { if (real) await ready(page); else await page.waitForFunction(() => Boolean(window.fixture?.ready)); }
      catch (error) {
        const startup = await page.evaluate(() => ({ url: location.pathname, readyState: document.readyState, fixtureReady: window.fixture?.ready,
          moduleLoading: document.documentElement.classList.contains("app-module-loading"), body: document.body?.textContent?.slice(0, 240) })).catch(() => null);
        error.message += `\nNovel fixture startup diagnostics: ${JSON.stringify({ startup, console: startupMessages.slice(-6), faults: faults.slice(-3), unexpected: unexpected.slice(-3),
          libraryFeed: libraryFeed ? { books: libraryFeed.books.length, total: libraryFeed.total } : null,
          unusedHeld: [...held].filter(gate => !gate.used).slice(-6).map(gate => String(gate.match)),
          pendingHeld: [...held].filter(gate => gate.used && !gate.closed).slice(-6).map(gate => gate.url) })}`;
        throw error;
      }
    }
    return page;
  }
  async function readLibraryPage(page, data, options = {}) {
    const gate = hold(url => url.pathname === "/api/novels", "", data);
    await startLibraryRead(page, options); await requested(gate); await settle(page, gate);
    return gate;
  }
  async function openOriginLibrary(page, data) {
    libraryFeed = data;
    await page.goto(`${base}/novels?q=Book&category=Fixture&sort=title`); await ready(page);
    await page.locator(".novel-book-row").first().waitFor();
    const expected = new Set(data.books.map(entry => novelFixtureBookKey(entry, data.sourceRealm))).size;
    while (await page.locator(".novel-book-row").count() < expected) {
      const current = await page.locator(".novel-book-row").count();
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForFunction(count => document.querySelectorAll(".novel-book-row").length > count, current);
    }
    const source = page.locator(".novel-book-title").filter({ hasText: /^Book A$/ });
    await source.scrollIntoViewIfNeeded(); await source.focus(); await tick(page);
    return source;
  }
}

async function ready(page) { await page.waitForFunction(() => !document.documentElement.classList.contains("app-module-loading"), null, { timeout: 5000 }); }
async function tick(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function openCorrection(page) {
  if (!await page.locator(".novel-detail-tools").evaluate(details => details.open)) await page.locator(".novel-detail-tools summary").click();
  await page.getByRole("button", { name: "校正信息", exact: true }).click();
  await page.locator("dialog.novel-correction-dialog").waitFor();
}
async function submitCorrection(page, method) {
  const dialog = page.locator("dialog.novel-correction-dialog");
  if (method === "PATCH") {
    await dialog.getByLabel("书名", { exact: true }).fill("Corrected Book A");
    await dialog.getByRole("button", { name: "保存校正", exact: true }).click();
  } else {
    await dialog.getByRole("button", { name: "删除小说", exact: true }).click();
    await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
  }
}
async function fillCorrectionDraft(dialog, draft) {
  for (const [label, key] of [["书名", "title"], ["作者", "author"], ["分类", "category"], ["作品简介", "summary"]]) {
    await dialog.getByLabel(label, { exact: true }).fill(draft[key]);
  }
}
async function rememberCorrectionDraft(page, input, scrollable = false) {
  await input.evaluate((node, scrollable) => {
    node.setSelectionRange(2, 7, "backward");
    if (scrollable) node.scrollTop = Math.min(60, node.scrollHeight - node.clientHeight);
  }, scrollable);
  await tick(page);
  await input.evaluate(node => {
    const dialog = node.closest("dialog"), controls = [...dialog.querySelectorAll(".novel-correction-fields input,.novel-correction-fields textarea")];
    const ancestors = new Map();
    for (const control of controls) for (let ancestor = control; ancestor; ancestor = ancestor.parentElement) ancestors.set(ancestor, ancestor.parentElement);
    const snapshot = window.__correctionDraftSnapshot = { dialog, input: node, ancestors: [...ancestors], blur: 0, removed: 0,
      range: [node.selectionStart, node.selectionEnd, node.selectionDirection], top: node.scrollTop, dialogTop: dialog.scrollTop, scroll: scrollY,
      route: location.href };
    node.addEventListener("blur", () => { snapshot.blur++; });
    snapshot.observer = new MutationObserver(records => {
      for (const record of records) for (const removed of record.removedNodes) if (removed === node || removed.contains?.(node)) snapshot.removed++;
    });
    snapshot.observer.observe(document.body, { childList: true, subtree: true });
  });
  if (scrollable) assert(await input.evaluate(node => node.scrollTop > 0), "the pending draft must exercise a genuinely scrolled textarea");
}
async function assertCorrectionDraft(page, draft) {
  const actual = await page.evaluate(() => {
    const snapshot = __correctionDraftSnapshot, input = snapshot.input, dialog = document.querySelector("dialog.novel-correction-dialog");
    const records = snapshot.observer.takeRecords();
    for (const record of records) for (const removed of record.removedNodes) if (removed === input || removed.contains?.(input)) snapshot.removed++;
    snapshot.observer.disconnect();
    const controls = [...dialog.querySelectorAll(".novel-correction-fields input,.novel-correction-fields textarea")];
    return { same: dialog === snapshot.dialog && dialog.open, ancestors: snapshot.ancestors.every(([node, parent]) => node.isConnected && node.parentElement === parent),
      focus: document.activeElement === input, blur: snapshot.blur, removed: snapshot.removed,
      range: [input.selectionStart, input.selectionEnd, input.selectionDirection], expectedRange: snapshot.range,
      scroll: input.scrollTop === snapshot.top && dialog.scrollTop === snapshot.dialogTop && scrollY === snapshot.scroll,
      route: location.href === snapshot.route, values: controls.map(control => control.value) };
  });
  assert.deepEqual(actual, { same: true, ancestors: true, focus: true, blur: 0, removed: 0,
    range: actual.expectedRange, expectedRange: actual.expectedRange, scroll: true,
    route: true, values: [draft.title, draft.author, draft.category, draft.summary] },
  "a current correction receipt must preserve every raw field, live ancestor, native focus, selection and scroll position");
}
async function rememberCorrectionDestination(page) {
  await tick(page);
  await page.evaluate(() => {
    window.__correctionReader = document.querySelector(".novel-reader-page");
    window.__correctionParagraph = document.querySelector(".novel-reader-content p");
    const range = document.createRange(); range.selectNodeContents(__correctionParagraph);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    window.__correctionSelection = getSelection().toString(); window.scrollTo(0, 420);
  });
  await tick(page);
  return page.evaluate(() => ({ scroll: scrollY, route: `${location.pathname}${location.search}` }));
}
async function assertCorrectionDestination(page, before, label) {
  assert.equal(await page.evaluate(() => __correctionReader === document.querySelector(".novel-reader-page") && __correctionParagraph === document.querySelector(".novel-reader-content p")), true, `${label} must not rebuild another book's current reader`);
  assert((await page.locator(".novel-reader-meta").last().textContent()).includes("Book B"), `${label} must not mix A's metadata into B's chapter`);
  assert.deepEqual(await page.evaluate(() => ({ scroll: scrollY, route: `${location.pathname}${location.search}` })), before);
  assert.equal(await page.evaluate(() => getSelection().toString() === __correctionSelection), true, `${label} must preserve the reader's selection`);
}
async function until(predicate, message) { const deadline = Date.now() + 5000; while (!predicate()) { assert(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 10)); } }
async function navigateRoute(page, target) { await page.evaluate(url => { history.pushState(null, "", url); dispatchEvent(new PopStateEvent("popstate")); }, target); }
async function startLibraryRead(page, options = {}) { await page.evaluate(options => { fixture.pending.push(fixture.page.loadNovels({ skipRoute: true, ...options }).catch(error => fixture.rejections.push(error.message))); }, options); }
async function openChapter(page, id, index) { await page.evaluate(([id, index]) => fixture.page.openChapter(id, index, { skipRoute: true }), [id, index]); await readerTitle(page, id, index); }
async function launchChapter(page, id, index) { await page.evaluate(([id, index]) => { fixture.pending.push(fixture.page.openChapter(id, index, { skipRoute: true })); }, [id, index]); }
async function detailTitle(page, title) { await page.waitForFunction(title => document.querySelector(".novel-detail-title")?.textContent === title, title, { timeout: 5000 }); }
async function readerTitle(page, id, index) { await page.waitForFunction(([id, index]) => document.querySelector(".novel-reader-paper h1")?.textContent === `${id} Chapter ${index}`, [id, index], { timeout: 5000, polling: 25 }); }
async function snapshot(page) { return page.evaluate(() => ({ book: fixture.state.novel.book?.id ?? null, chapter: fixture.state.novel.chapter?.index ?? null, loading: fixture.state.novel.loading, status: fixture.state.novel.status })); }
async function rememberReader(page) { await tick(page); await page.evaluate(() => { fixture.reader = document.querySelector(".novel-reader-page"); fixture.firstParagraph = fixture.reader.querySelector(".novel-reader-content p"); window.scrollTo(0, 420); }); await tick(page); const before = await page.evaluate(() => ({ scroll: window.scrollY, route: `${location.pathname}${location.search}` })); assert(before.scroll > 0, "reader preservation must measure nonzero document scroll"); return before; }
async function readerRatio(page) { return page.locator(".novel-reader-page").evaluate(reader => (scrollY - (reader.getBoundingClientRect().top + scrollY)) / (reader.scrollHeight - innerHeight)); }
async function saveBookmarkAt(page, ratio) {
  if (!await page.locator(".novel-settings-panel").count()) await page.locator('[data-reader-focus="toolbar-设置"]').click();
  // Settings opening restores the previous reader position on a frame. Settle
  // that earlier intent before this helper chooses a new bookmark position.
  await tick(page);
  const target = await page.evaluate(ratio => {
    const reader = document.querySelector(".novel-reader-page");
    const top = scrollY + reader.getBoundingClientRect().top + (reader.scrollHeight - innerHeight) * ratio;
    window.scrollTo(0, top);
    return Math.max(0, Math.min(document.documentElement.scrollHeight - innerHeight, top));
  }, ratio);
  await tick(page);
  assert(Math.abs(await page.evaluate(() => scrollY) - target) <= 2, "bookmark fixture must reach its requested reader position before saving");
  await page.getByRole("button", { name: "保存当前位置书签", exact: true }).click();
}
async function bookmarkStorage(page) { return page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("fanhao.novel.bookmarks.v1:"))
  .map(key => ({ key, raw: localStorage.getItem(key), value: JSON.parse(localStorage.getItem(key)) }))); }
async function assertReaderPreserved(page, before) { assert.equal(await page.evaluate(() => fixture.reader === document.querySelector(".novel-reader-page") && fixture.firstParagraph === document.querySelector(".novel-reader-content p")), true, "obsolete response must preserve mounted current text"); assert.deepEqual(await page.evaluate(() => ({ scroll: window.scrollY, route: `${location.pathname}${location.search}` })), before, "obsolete response must preserve current route/scroll"); }
async function seedLibrary(page, count, total = count) {
  await page.evaluate(data => {
    Object.assign(fixture.state.novel, { mode: "books", category: "all", query: "", author: "", sort: "updated", data, loading: false, loadingMore: false, status: "", libraryError: "", hasMore: data.books.length < data.total });
    fixture.page.renderView();
    fixture.shell = document.querySelector(".novel-library");
    fixture.cards = [...document.querySelectorAll(".novel-book-row")];
  }, libraryPage(count, "Fixture", 0, total));
}
async function seedBookOpeningSource(page, count, options = {}) {
  const index = Math.floor(count / 2) - 1;
  const data = originLibraryData(count, index);
  data.books[index + 1] = book("B");
  if (Object.hasOwn(options, "progress")) data.books[index].progress = options.progress;
  const mode = options.mode || "books";
  if (mode === "author") data.author = { name: "Synthetic", bookCount: count, chapterCount: count * 3, charCount: count * 18000, sizeBytes: count * 54000 };
  data.total = count + 50; data.nextOffset = count;
  await page.evaluate(({ data, mode }) => {
    Object.assign(fixture.state.novel, { mode, category: "Fixture", query: "Book", author: mode === "author" ? "Synthetic" : "", sort: "title", data,
      book: null, chapter: null, loading: false, loadingMore: false, status: "", libraryError: "", hasMore: true });
    fixture.page.renderView(); fixture.bookOpeningData = fixture.state.novel.data;
  }, { data, mode });
}
async function rememberBookOpeningSource(page, button) {
  await button.scrollIntoViewIfNeeded(); await button.focus(); await tick(page);
  return button.evaluate(button => {
    fixture.bookOpening?.observer.disconnect();
    const chain = element => { const result = []; for (let node = element; node; node = node.parentElement) result.push({ node, parent: node.parentElement }); return result; };
    const input = document.querySelector(".novel-section-search input"), sort = document.querySelector(".novel-sort");
    input.value = "unsubmitted source draft"; input.setSelectionRange(2, 7);
    const current = fixture.bookOpening = { home: document.querySelector(".novel-home"), library: document.querySelector(".novel-library"),
      cards: [...document.querySelectorAll(".novel-book-row")], chains: [...chain(button), ...chain(input), ...chain(sort)],
      button, input, sort, more: document.querySelector(".novel-library-autoload button"), data: fixture.state.novel.data, blur: 0, removedCards: 0 };
    button.addEventListener("blur", () => { current.blur++; });
    current.observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.removedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        current.removedCards += Number(node.matches(".novel-book-row")) + node.querySelectorAll(".novel-book-row").length;
      }
    });
    current.observer.observe(document.querySelector("#workGrid"), { childList: true, subtree: true });
    return { scroll: scrollY, route: `${location.pathname}${location.search}` };
  });
}
async function assertBookOpeningSource(page, before, count, operation = "metadata") {
  assert.deepEqual(await page.evaluate(() => {
    const source = fixture.bookOpening, cards = [...document.querySelectorAll(".novel-book-row")];
    return { home: source.home === document.querySelector(".novel-home"), library: source.library === document.querySelector(".novel-library"),
      cards: source.cards.every((card, index) => card.isConnected && card === cards[index]), count: cards.length,
      ancestors: source.chains.every(({ node, parent }) => node.isConnected && node.parentElement === parent),
      focus: document.activeElement === source.button, blur: source.blur, removedCards: source.removedCards,
      data: fixture.state.novel.data === source.data, raw: source.input.value, range: [source.input.selectionStart, source.input.selectionEnd] };
  }), { home: true, library: true, cards: true, count, ancestors: true, focus: true, blur: 0, removedCards: 0, data: true,
    raw: "unsubmitted source draft", range: [2, 7] }, `pending ${operation} must preserve every source row, the complete live control ancestry and untouched native focus`);
  assert.deepEqual(await page.evaluate(() => ({ scroll: scrollY, route: `${location.pathname}${location.search}` })), before,
    `pending ${operation} must keep the source's current scroll and URL`);
}
async function assertReadOpeningGeometry(page, requestedRatio) {
  const ratio = Math.max(0, Math.min(1, Number(requestedRatio || 0)));
  await page.waitForFunction(ratio => {
    const reader = document.querySelector(".novel-reader-page"); if (!reader) return false;
    const top = reader.getBoundingClientRect().top + scrollY, readable = Math.max(0, reader.scrollHeight - innerHeight);
    const maximum = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    const target = ratio === 0 ? 0 : Math.max(0, Math.min(maximum, top + readable * ratio));
    return Math.abs(scrollY - target) <= 2;
  }, ratio, { timeout: 5000 });
  const geometry = await page.locator(".novel-reader-page").evaluate((reader, ratio) => {
    const top = reader.getBoundingClientRect().top + scrollY, readable = Math.max(0, reader.scrollHeight - innerHeight);
    const maximum = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    const target = ratio === 0 ? 0 : Math.max(0, Math.min(maximum, top + readable * ratio));
    return { requestedRatio: ratio, top, readable, maximum, target, actual: scrollY,
      expectedRatio: readable ? Math.max(0, Math.min(1, (target - top) / readable)) : 0,
      measuredRatio: readable ? Math.max(0, Math.min(1, (scrollY - top) / readable)) : 0 };
  }, ratio);
  assert(geometry.readable > 0, "read opening progress must be measured on a genuinely scrollable chapter");
  assert(Math.abs(geometry.actual - geometry.target) <= 2, "the accepted chapter must restore its requested position within the real document scroll bounds");
  console.log(`MEASURE read opening geometry ${JSON.stringify(geometry)}`);
  return geometry;
}
async function measureLibraryRefresh(page, action) {
  await page.evaluate(() => {
    fixture.refreshElements = 0; fixture.originalCreateElement = document.createElement;
    document.createElement = function (...args) { fixture.refreshElements++; return fixture.originalCreateElement.apply(this, args); };
  });
  try { await action(); }
  finally { await page.evaluate(() => { document.createElement = fixture.originalCreateElement; }); }
}
async function measureReaderRender(page, action) {
  await page.evaluate(() => {
    fixture.readerElements = 0; fixture.readerRenders = 0; fixture.readerCreateElement = document.createElement;
    document.createElement = function (...args) { fixture.readerElements++; return fixture.readerCreateElement.apply(this, args); };
    fixture.readerObserver = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) if (node.classList?.contains("novel-reader-page")) fixture.readerRenders++;
    });
    fixture.readerObserver.observe(document.querySelector("#workGrid"), { childList: true });
  });
  try {
    await action(); await tick(page);
    return await page.evaluate(() => ({ roots: fixture.readerRenders, elements: fixture.readerElements }));
  } finally {
    await page.evaluate(() => { document.createElement = fixture.readerCreateElement; fixture.readerObserver.disconnect(); });
  }
}
async function assertReaderPositionAndFocus(page, before, focus) {
  assert.deepEqual(await page.evaluate(() => ({ scroll: window.scrollY, route: `${location.pathname}${location.search}` })), before);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.readerFocus), focus);
}
async function preservedLibrary(page) { return page.evaluate(() => fixture.shell === document.querySelector(".novel-library") && fixture.cards.every((card, index) => card.isConnected && card === document.querySelectorAll(".novel-book-row")[index])); }
function sendText(res, body, type, cache = "no-store") { if (res.destroyed) return; res.writeHead(200, { "Content-Type": type, "Cache-Control": cache }); res.end(body); }
function sendJson(res, body, status = 200) { if (res.destroyed) return; res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); }
function book(id) { return { id, title: `Book ${id}`, author: "Synthetic", category: "Fixture", sourceRealm: "server:fixture", catalogRevision: `rev-${id}`, chapterCount: 3, charCount: 18000, sizeBytes: 54000, coverUrl: `/synthetic/${id}.svg`, progress: null }; }
function chapter(id, index) { return { id: `${id}-${index}`, bookId: id, index, title: `${id} Chapter ${index}`, charCount: 6000, content: Array.from({ length: 80 }, (_, paragraph) => `Synthetic ${id} chapter ${index} paragraph ${paragraph + 1}. 这是完全合成的小说正文，用于验证阅读页面与滚动位置，不来自真实资料库。`).join("\n\n") }; }
function chapterResponse(id, index) { return { serverClockMs: Date.now(), book: book(id), sourceRealm: "server:fixture", catalogRevision: `rev-${id}`, chapter: chapter(id, index), chapters: [], chapterTotal: 3, prev: index > 1 ? chapter(id, index - 1) : null, next: index < 3 ? chapter(id, index + 1) : null }; }
function longCatalog() { return { sourceRealm: "server:fixture", catalogRevision: "rev-A", total: 10000,
  chapters: Array.from({ length: 10000 }, (_, index) => ({ id: `A-${index + 1}`, bookId: "A", index: index + 1, title: index % 100 === 99 ? `Target Chapter ${index + 1}` : `A Chapter ${index + 1}`, charCount: 50 })) }; }
function libraryData() { return { books: [book("A"), book("B")], total: 2, limit: 48, offset: 0, summary: { totals: { books: 2, chapters: 6, chars: 36000, bytes: 108000 }, categories: [], recent: [] } }; }
function libraryPage(count, category = "Fixture", offset = 0, total = count) {
  return {
    books: Array.from({ length: count }, (_, index) => ({ ...book(`${category}-${offset + index}`), coverUrl: "", category })),
    total, limit: 48, offset,
    facets: [{ name: "Fixture", count: total }, { name: "Other", count: 48 }],
    summary: { totals: { books: total, authors: 1 }, categories: [{ name: "Fixture", count: total }, { name: "Other", count: 48 }], recent: [] }
  };
}
function rankingPage(offset) {
  const data = libraryPage(48, "Ranking", offset, 144);
  data.books[0] = book("A"); data.books[1] = book("B");
  return data;
}
function originLibraryData(count, index) {
  const data = { ...libraryPage(count), sourceRealm: "server:fixture", listRevision: "origin-library-v1" };
  data.books.forEach((entry, position) => { entry.title = position < index ? `Book ${String(position).padStart(5, "0")}` : `Book B${String(position).padStart(5, "0")}`; });
  data.books[index] = book("A");
  return data;
}
function novelFixtureBookKey(entry, realm) { return JSON.stringify([entry.sourceRealm || realm || "", String(entry.id)]); }
function harness() {
  return `<!doctype html><meta charset=utf-8><link rel=stylesheet href=/css/foundation.css><link rel=stylesheet href=/modules/novels/styles.css><link rel=stylesheet href=/modules/novels/library.css><link rel=stylesheet href=/modules/novels/detail.css><link rel=stylesheet href=/modules/novels/reader-refinements.css><style>body{margin:0;background:#1c2220;color:white}</style><main><div id=statsRow></div><div id=workGrid></div></main><script type=module>
import {createNovelPage} from '/modules/novels/novel-page.js'; import {routeUrl} from '/js/router.js';
const state={activeView:'novels',novel:{data:${JSON.stringify(libraryData())}}}; const els={workGrid:document.querySelector('#workGrid'),statsRow:document.querySelector('#statsRow')},noop=()=>{},numberFormatter=new Intl.NumberFormat('zh-CN');
const api=async(url,options={})=>{const init={...options};if(init.body&&typeof init.body!=='string'){init.body=JSON.stringify(init.body);init.headers={'Content-Type':'application/json'}}const res=await fetch(url,init),data=await res.json();if(!res.ok)throw new Error(data.error||'controlled error');return data;};
const route=(overrides={})=>history.replaceState(null,'',routeUrl({view:'novels',novelBookId:state.novel.book?.id||'',novelChapterIndex:String(state.novel.chapter?.index||''),...overrides}));
const page=createNovelPage({api,state,els,formatNumber:value=>numberFormatter.format(value||0),formatBytes:value=>String(value||0),formatDateTime:value=>String(value||''),cancelScheduledWorkRendering:noop,disconnectPeopleIndexAutoload:noop,resetProgressiveCoverLoading:noop,hidePersonProfile:noop,setMainHeader:noop,openAdminScript:noop,pushRoute:route,replaceRoute:route,syncRouteAfterNavigation:options=>{if(!options?.skipRoute)route(options?.routeOverrides)}});
window.fixture={state,page,pending:[],rejections:[],ready:true};page.enter({skipRoute:true,deferInitialLoad:true});
</script>`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runNovelReaderFixture({ legacyNovel: process.argv.includes("--legacy-novel"), legacyHost: process.argv.includes("--legacy-host"), casePattern: process.argv.find(value => value.startsWith("--case="))?.slice(7) || "" });
