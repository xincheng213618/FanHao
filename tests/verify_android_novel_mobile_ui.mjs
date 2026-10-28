import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Isolated synthetic API and browser profile. Never connects to the user's library.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = path.join(root, "android-client/www");
const legacyFirstCatalog = process.argv.includes("--legacy-first-catalog");
const catalogOnly = process.argv.includes("--catalog-only") || legacyFirstCatalog;
const legacyMenu = process.argv.includes("--legacy-menu");
const unguardedMenu = process.argv.includes("--unguarded-menu");
const menuOnly = process.argv.includes("--menu-only") || legacyMenu || unguardedMenu;
const legacyOverlays = process.argv.includes("--legacy-overlays");
const unguardedElements = process.argv.includes("--unguarded-overlay-elements");
const overlayOnly = process.argv.includes("--overlay-only") || legacyOverlays || unguardedElements;
const legacyCatalogInput = process.argv.includes("--legacy-catalog-input");
const unguardedCatalogQuery = process.argv.includes("--unguarded-catalog-query");
const unguardedCatalogResult = process.argv.includes("--unguarded-catalog-result");
const inputOnly = process.argv.includes("--catalog-input-only") || legacyCatalogInput || unguardedCatalogQuery || unguardedCatalogResult;
const legacyDetailCatalog = process.argv.includes("--legacy-detail-catalog");
const unguardedDetailQuery = process.argv.includes("--unguarded-detail-query");
const unguardedDetailOwner = process.argv.includes("--unguarded-detail-catalog-owner");
const detailOnly = process.argv.includes("--detail-catalog-only") || legacyDetailCatalog || unguardedDetailQuery || unguardedDetailOwner;
const legacyReaderEvents = process.argv.includes("--legacy-reader-events");
const unguardedReaderBack = process.argv.includes("--unguarded-reader-back");
const unguardedReaderContent = process.argv.includes("--unguarded-reader-content");
const unguardedProgressEntry = process.argv.includes("--unguarded-reader-progress-entry");
const unguardedProgressDelivery = process.argv.includes("--unguarded-reader-progress-delivery");
const unguardedProgressHandle = process.argv.includes("--unguarded-reader-progress-handle");
const readerEventsOnly = process.argv.includes("--reader-events-only") || legacyReaderEvents || unguardedReaderBack || unguardedReaderContent
  || unguardedProgressEntry || unguardedProgressDelivery || unguardedProgressHandle;
const focused = catalogOnly || menuOnly || overlayOnly || inputOnly || detailOnly || readerEventsOnly;
let viewsSource = fs.readFileSync(path.join(assets, "modules/novels/novel-views.js"), "utf8").replace(/\r\n/g, "\n");
const screenClick = `    screen.addEventListener("click", ownAction((event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("button, input, select, a, .novel-reader-toolbar, .novel-reader-settings-panel, .novel-reader-catalog-drawer")) return;
      toggleReaderMenu();
    }));`;
for (const [enabled, current, previous] of [
  // The earlier fast-path control restores its historical unowned body entry
  // as well, so it still reaches the fast-path ownership branch it tests.
  [legacyReaderEvents || unguardedMenu, screenClick, screenClick.replace('ownAction((event)', '(event)').replace('    }));', '    });')],
  [legacyReaderEvents || unguardedReaderBack, 'const back = actionButton("返回", ownAction(() => goBack()));', 'const back = actionButton("返回", () => goBack());'],
  [legacyReaderEvents || unguardedReaderContent, 'content.addEventListener("scroll", ownAction(scheduleReaderProgress), { passive: true });', 'content.addEventListener("scroll", scheduleReaderProgress, { passive: true });'],
  [unguardedProgressEntry, 'if (!isCurrentReaderSession(readerState.session) || !isReaderScreenMounted() || !readerState.book?.id || !readerState.chapter?.index) return;',
    'if (!isReaderScreenMounted() || !readerState.book?.id || !readerState.chapter?.index) return;']
]) if (enabled) {
  assert.equal(viewsSource.split(current).length, 2, 'one actual reader event ownership mutation');
  const original = viewsSource; viewsSource = viewsSource.replace(current, previous);
  if (current.startsWith('const back')) {
    const slot = viewsSource.indexOf(previous, viewsSource.indexOf('    const topBar = document.createElement("div");', viewsSource.indexOf('  function renderNovelReaderData')));
    assert(slot >= 0); assert.equal(viewsSource.slice(0, slot) + current + viewsSource.slice(slot + previous.length), original);
  } else assert.equal(viewsSource.replace(previous, current), original);
}
if (unguardedProgressDelivery || unguardedProgressHandle) {
  const start = viewsSource.indexOf('  function scheduleReaderProgress() {'), end = viewsSource.indexOf('  function updateReaderProgressUi(', start);
  const original = viewsSource.slice(start, end);
  let changed = original;
  const slots = unguardedProgressDelivery ? ['        if (!isCurrentReaderSession(session) || readerState.screen !== screen) return;\n',
    '      if (!isCurrentReaderSession(session) || readerState.screen !== screen) return;\n']
    : ['        if (readerState.progressFrame !== frameId) return;\n', '      if (readerState.progressTimer !== timerId) return;\n'];
  for (const slot of slots) { assert.equal(changed.split(slot).length, 2); changed = changed.replace(slot, ''); }
  assert.notEqual(changed, original);
  viewsSource = viewsSource.slice(0, start) + changed + viewsSource.slice(end);
}
for (const [enabled, before, after] of [
  [legacyDetailCatalog, '  function updateDetailCatalog(options = {}) {\n', '  function updateDetailCatalog(options = {}) {\n    return false;\n'],
  [unguardedDetailQuery, '      && query === String(catalogState.query ?? "").replace(/\\s+/g, " ").trim();', '      ;'],
  [unguardedDetailOwner, '      if ((page && (novelPage !== page || !page.isActive())) || book !== detailState.book || !els.viewContent.contains(catalog)) return;\n', '']
]) if (enabled) {
  const previous = viewsSource;
  assert.equal(viewsSource.split(before).length, 2, 'one precise detail-catalog mutation slot');
  viewsSource = viewsSource.replace(before, after);
  if (after) assert.equal(viewsSource.replace(after, before), previous, 'detail negative restores the original bytes');
}
if (legacyCatalogInput) {
  const current = '    if (!readerState.catalogOpen) drawer?.remove();\n    else if (!drawer) els.viewContent.append(createCatalogDrawer());\n    else if (options.catalog) updateCatalogDrawer(drawer);';
  const previous = '    if (!readerState.catalogOpen || options.catalog) drawer?.remove();\n    if (readerState.catalogOpen && (!drawer || options.catalog)) els.viewContent.append(createCatalogDrawer());';
  assert.equal(viewsSource.split(current).length, 2, 'negative restores only whole-drawer replacement');
  viewsSource = viewsSource.replace(current, previous);
}
if (unguardedCatalogQuery) {
  const guard = '      && query === String(catalogState.query || "").replace(/\\s+/g, " ").trim();';
  assert.equal(viewsSource.split(guard).length, 2, 'negative removes only current-query ownership');
  viewsSource = viewsSource.replace(guard, '      ;');
}
if (unguardedCatalogResult) {
  const guard = '      if (!button.isConnected) return;\n';
  assert.equal(viewsSource.split(guard).length, 2, 'negative removes only detached chapter-result ownership');
  viewsSource = viewsSource.replace(guard, '');
}
if (legacyOverlays) {
  const entry = "  function updateReaderOverlays(ratio, options = {}) {\n";
  assert.equal(viewsSource.split(entry).length, 2, "negative disables only actual overlay reuse");
  viewsSource = viewsSource.replace(entry, entry + "    return false;\n");
}
if (unguardedElements) {
  const gate = "      if (element && !element.isConnected) return;\n";
  assert.equal(viewsSource.split(gate).length, 2, "negative removes only detached-overlay ownership");
  viewsSource = viewsSource.replace(gate, "");
}
if (legacyMenu) {
  const fastPath = [
    '    if (!hadOverlay && isCurrentReaderSession(readerState.session) && isReaderScreenMounted()) {',
    '      readerState.screen.classList.toggle("menu-open", readerState.menuOpen);',
    '      scheduleReaderMenuAutoHide();',
    '      return;',
    '    }'
  ].join("\n");
  assert.equal(viewsSource.split(fastPath).length, 2, "negative removes only the actual menu fast path");
  viewsSource = viewsSource.replace(fastPath, "");
}
if (unguardedMenu) {
  const ownerGuard = 'if (!hadOverlay && isCurrentReaderSession(readerState.session) && isReaderScreenMounted())';
  assert.equal(viewsSource.split(ownerGuard).length, 2, 'negative removes only ownership from the actual menu fast path');
  viewsSource = viewsSource.replace(ownerGuard, 'if (!hadOverlay && isReaderScreenMounted())');
}
if (legacyFirstCatalog) {
  const guard = "    if (!needsCatalog || isLocalBookId(readerState.book?.id)) {";
  assert.equal(viewsSource.split(guard).length, 2, "negative must restore the actual previous first-open render exactly once");
  viewsSource = viewsSource.replace(guard, "    {");
}
const readerRender = "  function renderNovelReaderData(data = {}, cacheEntry = null, options = {}) {";
assert.equal(viewsSource.split(readerRender).length, 2, "count creation inside the actual reader renderer");
viewsSource = viewsSource.replace(readerRender, `${readerRender}
    const probe = window.__novelRenderProbe;
    if (!probe) return renderNovelReaderMeasured(data, cacheEntry, options);
    const started = performance.now(), before = probe.created, paragraphsBefore = probe.paragraphsCreated;
    try { return renderNovelReaderMeasured(data, cacheEntry, options); }
    finally { probe.renders.push({ ms: performance.now() - started, created: probe.created - before,
      paragraphsCreated: probe.paragraphsCreated - paragraphsBefore, loading: readerState.catalogLoading, open: readerState.catalogOpen }); }
  }
  function renderNovelReaderMeasured(data = {}, cacheEntry = null, options = {}) {`);
const catalogLoad = "  async function loadRemoteReaderCatalogPage(options = {}) {";
const detailRender = "  function renderNovelDetailData(data = {}, cacheEntry = null, options = {}) {";
assert.equal(viewsSource.split(detailRender).length, 2);
viewsSource = viewsSource.replace(detailRender, `${detailRender}
    const probe = window.__novelRenderProbe;
    if (!probe) return renderNovelDetailMeasured(data, cacheEntry, options);
    const started = performance.now(), before = probe.created;
    try { return renderNovelDetailMeasured(data, cacheEntry, options); }
    finally { probe.detailRenders.push({ ms: performance.now() - started, created: probe.created - before }); }
  }
  function renderNovelDetailMeasured(data = {}, cacheEntry = null, options = {}) {`);
const detailLoad = "  async function loadRemoteDetailCatalogPage(options = {}) {";
assert.equal(viewsSource.split(detailLoad).length, 2);
viewsSource = viewsSource.replace(detailLoad, `${detailLoad}
    const task = loadRemoteDetailCatalogMeasured(options);
    window.__novelRenderProbe?.catalogTasks.push(task);
    return task;
  }
  async function loadRemoteDetailCatalogMeasured(options = {}) {`);
const overlayUpdate = "  function updateReaderOverlays(ratio, options = {}) {";
assert.equal(viewsSource.split(overlayUpdate).length, 2);
viewsSource = viewsSource.replace(overlayUpdate, `${overlayUpdate}
    const probe = window.__novelRenderProbe;
    if (!probe) return updateReaderOverlaysMeasured(ratio, options);
    const started = performance.now(), before = probe.created, paragraphsBefore = probe.paragraphsCreated;
    try { return updateReaderOverlaysMeasured(ratio, options); }
    finally { probe.overlays.push({ ms: performance.now() - started, created: probe.created - before,
      paragraphsCreated: probe.paragraphsCreated - paragraphsBefore, loading: readerState.catalogLoading, open: readerState.catalogOpen }); }
  }
  function updateReaderOverlaysMeasured(ratio, options = {}) {`);
assert.equal(viewsSource.split(catalogLoad).length, 2, "await the actual remote catalog lifecycle in the fixture");
viewsSource = viewsSource.replace(catalogLoad, `${catalogLoad}
    const task = loadRemoteCatalogMeasured(options);
    window.__novelRenderProbe?.catalogTasks.push(task);
    return task;
  }
  async function loadRemoteCatalogMeasured(options = {}) {`);
const readerProgress = "  installReaderProgress();";
assert.equal(viewsSource.split(readerProgress).length, 2, "inspect the actual reader state and position without replacing its behavior");
viewsSource = viewsSource.replace(readerProgress, `
  window.__novelDetailProbe = {
    snapshot: () => ({ query: catalogState.query, loadedQuery: catalogState.loadedQuery,
      ids: detailState.chapters.map(chapter => chapter.id), total: catalogState.total,
      filteredTotal: catalogState.filteredTotal, offset: catalogState.offset,
      remotePaged: catalogState.remotePaged, bookId: detailState.book?.id,
      pageKind: novelPage?.kind })
  };
  window.__novelMenuProbe = {
    position: scrollReaderToRatio,
    rerender: () => renderNovelReaderData(currentReaderData(), null, { restoreRatio: captureReaderPositionRatio() }),
    snapshot: () => ({ menu: readerState.menuOpen, settingsOpen: readerState.settingsOpen,
      catalogOpen: readerState.catalogOpen, current: isCurrentReaderSession(readerState.session),
      bookId: readerState.book?.id, chapterIndex: readerState.chapter?.index,
      settings: JSON.stringify(readerState.settings), ratio: captureReaderRatio(),
      progress: readerState.book?.progress ? { ...readerState.book.progress } : null,
      progressPending: readerState.restoreFrame !== null || readerState.progressTimer !== null || readerState.progressFrame !== null
        || remoteProgressWrites.size > 0 || localProgressWriteIds.size > 0,
      immersive: document.body.classList.contains("novel-reader-immersive"),
      catalog: { query: catalogState.query, loadedQuery: catalogState.loadedQuery,
        ids: readerState.chapters.map(chapter => chapter.id), total: catalogState.total,
        filteredTotal: catalogState.filteredTotal, offset: catalogState.offset,
        loading: readerState.catalogLoading, error: readerState.catalogError } })
  };
${readerProgress}`);
const sourceRealm = "server:11111111-1111-4111-8111-111111111111";
const book = {
  id: "mobile-fixture", title: "山海之间", author: "测试作者", category: "旅行随笔",
  chapterCount: 161, charCount: 320000, sizeBytes: 960000, sourceRealm,
  summary: "这是一份用于验证手机排版的虚构书籍简介。行走在山与海之间，记录沿途的风景和日常。\n".repeat(7),
  latestChapterTitle: "第一百六十一章 归途"
};
const books = [book, { ...book, id: "long-title", title: "在遥远的山谷里寻找一座从未见过的小城：一段很长的旅行记录" },
  ...Array.from({ length: 4 }, (_, index) => ({ ...book, id: `book-${index}`, title: ["春日来信", "群星入海", "旧城漫步", "灯火可亲"][index] }))];
const chapters = Array.from({ length: 161 }, (_, index) => ({
  index: index + 1, id: `chapter-${index + 1}`, bookId: book.id,
  title: `第${index + 1}章 ${index ? "沿途风景" : "山间清晨"}`, charCount: 1800,
  content: "清晨的阳光穿过树梢，远处的山谷渐渐亮了起来。我们沿着小路出发，带着一张地图和几封旧信。这段文字仅用于检查阅读器排版与阅读进度。\n".repeat(30)
}));
const catalogBook = { ...book, id: "catalog-fixture", title: "Synthetic Long Catalog" };
const detailRevision = "33333333-3333-4333-8333-333333333333";
const detailProgressBook = { ...catalogBook, catalogRevision: detailRevision,
  progress: { chapterIndex: 100, chapterId: "chapter-100", catalogRevision: detailRevision, scrollRatio: 0 } };
const catalogText = Array.from({ length: 1000 }, (_, index) => `Synthetic paragraph ${index + 1}. Private text for measuring the Android catalog opening.`).join("\n\n");
const catalogChapters = chapters.map(chapter => ({ ...chapter, bookId: catalogBook.id, content: catalogText }));
const requests = [];
const catalogGates = new Set();
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://fixture");
  response.setHeader("Cache-Control", "no-store");
  if (url.pathname.startsWith("/api/")) {
    const entry = { method: request.method, path: url.pathname, query: url.search };
    if (request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      entry.body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    }
    requests.push(entry);
    const gate = [...catalogGates].find(item => !item.used && item.match(url));
    if (gate) {
      gate.used = true; gate.url = `${url.pathname}${url.search}`; gate.requested.resolve();
      response.once("close", () => { gate.closed = true; });
      await gate.released.promise;
      if (gate.error) { response.writeHead(503, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: gate.error })); return; }
    }
    const apiBook = url.searchParams.get('catalogRevision') === detailRevision ? detailProgressBook
      : url.pathname === `/api/novels/${catalogBook.id}` || url.pathname.startsWith(`/api/novels/${catalogBook.id}/`) ? catalogBook : book;
    const apiChapters = apiBook.id === catalogBook.id ? catalogChapters : chapters;
    let payload = {};
    if (url.pathname === "/api/novels") {
      const query = url.searchParams.get("q") || "";
      const matching = books.filter((item) => !query || item.title.includes(query));
      payload = { books: matching, total: matching.length, sourceRealm, facets: [{ name: "旅行随笔", count: books.length }] };
    } else if (url.pathname.endsWith("/catalog")) {
      const query = url.searchParams.get("q") || "";
      const matching = apiChapters.filter((item) => !query || item.title.includes(query));
      if (url.searchParams.get('order') === 'desc') matching.reverse();
      const anchor = Number(url.searchParams.get('anchor') || 0);
      const anchorPosition = anchor ? matching.findIndex(chapter => chapter.index === anchor) : 0;
      const offset = url.searchParams.has('offset') ? Number(url.searchParams.get("offset")) : Math.max(0, Math.floor(anchorPosition / 80) * 80);
      payload = { book: apiBook, sourceRealm, chapters: matching.slice(offset, offset + 80), total: apiChapters.length, filteredTotal: matching.length, offset };
    } else if (url.pathname.includes("/chapters/")) {
      const index = Number(url.pathname.split("/").at(-1)) - 1;
      payload = { book: apiBook, sourceRealm, chapter: apiChapters[index], prev: apiChapters[index - 1] || null, next: apiChapters[index + 1] || null };
    } else if (url.pathname.endsWith("/progress")) {
      payload = { ok: true, sourceRealm };
    } else if (url.pathname.startsWith("/api/novels/")) {
      payload = { book: apiBook, sourceRealm, chapters: [] };
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload));
    return;
  }
  if (url.pathname === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html lang="zh-CN" data-theme="light"><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><link rel="stylesheet" href="/styles.css"></head><body class="novel-library-view"><main class="app-shell"><header id="moduleChrome" class="module-chrome"></header><section id="contentPanel" class="content-panel" data-feed-view="true"><div class="section-head"><div><p id="viewKicker" class="section-label"></p><h2 id="viewTitle"></h2></div><div class="section-actions"><button id="viewBack" class="text-button">返回</button></div></div><div id="viewMeta" class="view-meta"></div><div id="viewContent" class="content-list"></div></section></main><nav class="bottom-nav"><button type="button">首页</button><button type="button">收藏</button><button type="button">小说</button><button type="button">我的</button></nav><script type="module">
      import { createAndroidModule } from '/modules/novels/android-module.js';
      const els = Object.fromEntries(['viewKicker','viewTitle','viewMeta','viewContent'].map(id => [id, document.getElementById(id)]));
      const panel = document.getElementById('contentPanel'), chrome = document.getElementById('moduleChrome');
      let view = 'novels', params = {}, generation = 0, controller = null, sourceUrl = location.origin;
      const module = createAndroidModule({ host: { els, getActiveUrl: () => sourceUrl,
        navigation: { showView, goBack: () => showView('novels'), hasBackStack: () => true },
        ui: { setActiveBottom() {}, setStatus() {}, renderCurrentView: () => showView(view, params), renderCurrentViewPreservingScroll: () => showView(view, params), scrollToTop: () => scrollTo(0, 0), refreshChrome } } });
      window.__novelUiFixture = { showView, invalidate: () => controller?.abort(),
        setSourceUrl: value => { sourceUrl = value; } };
      function refreshChrome() { chrome.innerHTML = ''; chrome.hidden = !module.renderChrome({ container: chrome, view }); }
      async function showView(next, nextParams = {}) {
        view = next; params = nextParams; const current = ++generation;
        controller?.abort(); controller = new AbortController();
        const signal = controller.signal, guard = () => generation === current && !signal.aborted; guard.signal = signal;
        window.dispatchEvent(new CustomEvent('fanhaoViewWillRender', { detail: { view, params } }));
        window.dispatchEvent(new CustomEvent('fanhaoViewChanged', { detail: { view, params } }));
        panel.dataset.view = view; els.viewContent.className = 'content-list';
        document.body.classList.toggle('novel-reader-view', view === 'novelReader');
        document.body.classList.toggle('novel-search-page-view', view === 'novelSearch');
        document.getElementById('viewBack').hidden = view === 'novels';
        refreshChrome(); scrollTo(0, 0);
        await module.routes.find(route => route.view === view).render(params, guard);
      }
      document.getElementById('viewBack').onclick = () => showView('novels');
      await showView('novels');
    </script></body></html>`);
    return;
  }
  const target = path.resolve(assets, `.${decodeURIComponent(url.pathname)}`);
  if (!target.startsWith(assets + path.sep) || !fs.statSync(target, { throwIfNoEntry: false })?.isFile()) {
    response.writeHead(404).end(); return;
  }
  response.writeHead(200, { "Content-Type": target.endsWith(".css") ? "text/css" : target.endsWith(".js") ? "text/javascript" : "application/octet-stream" });
  if (target === path.join(assets, "modules/novels/novel-views.js")) response.end(viewsSource);
  else fs.createReadStream(target).pipe(response);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(value => value && fs.existsSync(value));
const browser = await chromium.launch({ executablePath, headless: true });
const artifactDir = process.env.FANHAO_MOBILE_UI_ARTIFACTS;
if (artifactDir) fs.mkdirSync(artifactDir, { recursive: true });
try {
  for (const scenario of focused ? [] : ["slow-success", "failure-retry", "leave-pending"]) {
    const page = await browser.newPage({ viewport: { width: 400, height: 820 }, isMobile: true, hasTouch: true });
    if (scenario === "leave-pending") await page.addInitScript(() => {
      // Preserve this late-body shelf case with the host's real route signal.
      const fetchImpl = window.fetch.bind(window);
      window.fetch = (url, options = {}) => fetchImpl(url, { ...options, signal: undefined, cache: 'no-store' });
    });
    const gate = Promise.withResolvers();
    let reads = 0;
    await page.route("**/api/novels?*", async route => {
      const attempt = ++reads;
      if (attempt === 1) await gate.promise;
      await route.fulfill({ status: scenario === "failure-retry" && attempt === 1 ? 503 : 200,
        contentType: "application/json", body: JSON.stringify(scenario === "failure-retry" && attempt === 1
          ? { error: "模拟电脑暂不可达" } : { books, total: books.length, sourceRealm }) });
    });
    try {
      await page.goto(baseUrl);
      await page.getByRole("status").waitFor();
      assert.equal(await page.locator("#viewMeta").textContent(), "正在读取电脑书库");
      assert.equal(await page.getByText("电脑书库还没有小说。", { exact: false }).count(), 0);
      if (scenario === "leave-pending") {
        await page.getByRole("button", { name: "手机离线", exact: true }).click();
        await page.getByRole("button", { name: "导入 TXT", exact: true }).first().waitFor();
      }
      const pendingResponse = scenario === "leave-pending"
        ? page.waitForResponse(response => response.url().includes("/api/novels?")) : null;
      gate.resolve();
      if (scenario === "failure-retry") {
        await page.getByRole("alert").waitFor();
        assert.equal(await page.locator("#viewMeta").textContent(), "电脑书库读取失败");
        await page.getByRole("button", { name: "重试读取", exact: true }).click();
        await page.locator(".novel-mobile-book-detail").first().waitFor();
        assert.equal(reads, 2);
      } else if (scenario === "leave-pending") {
        await pendingResponse;
        assert.equal(await page.getByRole("button", { name: "手机离线", exact: true }).getAttribute("aria-pressed"), "true");
        assert.equal(await page.locator(".novel-mobile-book-detail").count(), 0);
      } else {
        await page.locator(".novel-mobile-book-detail").first().waitFor();
        assert.equal(await page.getByRole("status").count(), 0);
      }
      console.log(`PASS remote shelf state: ${scenario}`);
    } finally { gate.resolve(); await page.close(); }
  }
  for (const width of focused ? [] : [320, 400]) {
    const page = await browser.newPage({ viewport: { width, height: 820 }, isMobile: true, hasTouch: true });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(baseUrl);
    await page.locator(".novel-mobile-book-detail").first().waitFor();
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(await overflow(), false, `library must fit ${width}px`);
    if (artifactDir) await page.screenshot({ path: path.join(artifactDir, `fixture-library-${width}.png`) });
    const postsBefore = requests.filter(item => item.method === "POST").length;
    await page.locator(".novel-mobile-book-detail").first().click();
    await page.locator(".novel-mobile-chapter").first().waitFor();
    assert.equal(requests.filter(item => item.method === "POST").length, postsBefore, "opening details must not write reading progress");
    assert.equal(await page.locator(".novel-mobile-book-tools").getAttribute("open"), null);
    assert.equal(await overflow(), false, `detail must fit ${width}px`);
    if (artifactDir) await page.screenshot({ path: path.join(artifactDir, `fixture-detail-${width}.png`) });
    await page.getByRole("button", { name: "展开简介", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "收起简介", exact: true }).getAttribute("aria-expanded"), "true");
    await page.getByRole("button", { name: "收起简介", exact: true }).click();
    await page.getByRole("button", { name: "查看目录", exact: true }).click();
    assert.equal(await page.locator("#novelDetailCatalog").evaluate(el => document.activeElement === el), true);
    await page.locator(".novel-mobile-chapter").first().click();
    await page.locator(".novel-reader-content").waitFor();
    await page.locator(".novel-reader-content p").first().click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "A+", exact: true }).click();
    assert.equal(await page.locator(".novel-reader-screen").evaluate(el => el.style.getPropertyValue("--novel-reader-font")), "21px");
    if (artifactDir) await page.screenshot({ path: path.join(artifactDir, `fixture-reader-settings-${width}.png`) });
    await page.getByRole("button", { name: "完成", exact: true }).click();
    assert.equal(await page.locator(".novel-reader-settings-panel").count(), 0);
    await page.getByRole("button", { name: "夜间", exact: true }).click();
    await page.getByRole("button", { name: "目录", exact: true }).click();
    await page.locator(".novel-reader-catalog-drawer .novel-mobile-chapter").first().waitFor();
    assert.equal(await page.locator(".novel-reader-catalog-drawer").evaluate(el => getComputedStyle(el).backgroundColor), "rgb(36, 42, 51)");
    assert.equal(await overflow(), false, `night catalog must fit ${width}px`);
    if (artifactDir) await page.screenshot({ path: path.join(artifactDir, `fixture-reader-night-${width}.png`) });
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "书库", exact: true }).click();
    await page.getByRole("button", { name: "搜索小说", exact: true }).click();
    const search = page.locator(".novel-mobile-search-page-field input");
    const searchGate = Promise.withResolvers();
    await page.route("**/api/novels?*", async route => {
      await searchGate.promise;
      await route.continue();
    });
    await search.fill("山海");
    await search.press("Enter");
    await page.getByRole("status").waitFor();
    assert.equal(await search.inputValue(), "山海", "Search stays available while the request is pending");
    assert.equal(await page.getByText("没有搜到", { exact: false }).count(), 0);
    searchGate.resolve();
    await page.locator(".novel-mobile-book-row").first().waitFor();
    await page.unroute("**/api/novels?*");
    assert.equal(await page.locator(".novel-mobile-book-row").count(), 1);
    await page.locator(".novel-mobile-search-page-back").click();
    await page.evaluate(async () => {
      const { saveLocalNovelEntry } = await import('/js/local-novels.js');
      await saveLocalNovelEntry({ book: { id: 'local:mobile-ui-fixture', local: true, title: '离线验收书', author: '测试作者', chapterCount: 1 },
        chapters: [{ index: 1, title: '第一章 清晨', content: '仅用于浏览器测试的临时文本。' }] });
    });
    const networkBeforeOffline = requests.length;
    await page.getByRole("button", { name: "手机离线", exact: true }).click();
    await page.getByRole("button", { name: "查看《离线验收书》详情", exact: true }).waitFor();
    await page.getByRole("button", { name: "查看《离线验收书》详情", exact: true }).click();
    await page.locator(".novel-mobile-detail-body h1").waitFor();
    await page.locator("#viewBack").click();
    await page.getByRole("button", { name: "查看《离线验收书》详情", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "手机离线", exact: true }).getAttribute('aria-pressed'), 'true', 'detail return keeps the offline shelf selected');
    assert.equal(requests.length, networkBeforeOffline, 'offline shelf and local detail must not depend on a server request');
    await page.getByRole("button", { name: "电脑书库", exact: true }).click();
    await page.getByRole("button", { name: "查看《山海之间》详情", exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS ${width}px: library/detail navigation without progress writes, summary, catalog, reader settings, night mode, search, offline shelf without network`);
  }
  if (!menuOnly && !overlayOnly && !inputOnly && !detailOnly && !readerEventsOnly) await verifyFirstCatalogRendering();
  if (!catalogOnly && !overlayOnly && !inputOnly && !detailOnly && !readerEventsOnly) await verifyReaderMenuReuse();
  if (!catalogOnly && !menuOnly && !inputOnly && !detailOnly && !readerEventsOnly) await verifyOverlayReuse();
  if (!catalogOnly && !menuOnly && !overlayOnly && !detailOnly && !readerEventsOnly) await verifyCatalogInputReuse();
  if (!catalogOnly && !menuOnly && !overlayOnly && !inputOnly && !readerEventsOnly) await verifyDetailCatalogReuse();
  if (!catalogOnly && !menuOnly && !overlayOnly && !inputOnly && !detailOnly) await verifyReaderEventOwnership();
} finally {
  for (const gate of catalogGates) gate.released.resolve();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

function holdCatalog(error = "", offset = null, query = null) {
  const gate = {
    error, used: false, requested: Promise.withResolvers(), released: Promise.withResolvers(),
    match: url => url.pathname === `/api/novels/${catalogBook.id}/catalog`
      && (offset === null || url.searchParams.get("offset") === String(offset))
      && (query === null || url.searchParams.get("q") === query)
  };
  catalogGates.add(gate);
  return gate;
}

async function waitCatalogRequest(gate) {
  let timer;
  try {
    await Promise.race([gate.requested.promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("private catalog request missing")), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

async function catalogFrames(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function newCatalogReader({ local = false, ignoreAbort = false, readingMode = null, detail = false, progressDetail = false, cachedDetail = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 400, height: 820 }, isMobile: true, hasTouch: true });
  page.catalogErrors = [];
  page.on("pageerror", error => page.catalogErrors.push(error.message));
  await page.addInitScript(({ ignoreAbort, readingMode }) => {
    window.__novelRenderProbe = { created: 0, paragraphsCreated: 0, renders: [], detailRenders: [], overlays: [], catalogTasks: [] };
    window.__catalogSearchCallbacks = [];
    window.__readerProgressCallbacks = [];
    window.__holdReaderProgress = false;
    const catalogTimeout = window.setTimeout.bind(window);
    let heldCatalogSearch;
    window.__holdCatalogSearch = false;
    window.__releaseCatalogSearch = () => {
      if (!heldCatalogSearch) throw new Error('no held search');
      clearTimeout(heldCatalogSearch.id); const callback = heldCatalogSearch.callback;
      heldCatalogSearch = null; __holdCatalogSearch = false; callback();
    };
    window.setTimeout = (callback, delay, ...args) => {
      if (delay === 600) {
        const fire = () => callback(...args);
        const id = catalogTimeout(__holdReaderProgress ? () => {} : fire, __holdReaderProgress ? 60000 : delay);
        __readerProgressCallbacks.push({ id, run: () => { clearTimeout(id); fire(); } });
        return id;
      }
      if (delay === 260) {
        const fire = () => callback(...args); __catalogSearchCallbacks.push(fire);
        if (__holdCatalogSearch) {
          heldCatalogSearch = { id: catalogTimeout(() => {}, 60000), callback: fire };
          return heldCatalogSearch.id;
        }
      }
      return catalogTimeout(callback, delay, ...args);
    };
    const raf = requestAnimationFrame.bind(window), cancel = cancelAnimationFrame.bind(window), held = new Map();
    let holding = false, id = -1;
    window.requestAnimationFrame = callback => { if (!holding) return raf(callback); const current = id--; held.set(current, callback); return current; };
    window.cancelAnimationFrame = current => { if (current < 0) held.delete(current); else cancel(current); };
    window.__holdOverlayFrames = () => { holding = true; };
    window.__releaseOverlayFrames = () => { holding = false; for (const [current, callback] of held) raf(time => { if (held.delete(current)) callback(time); }); };
    const create = document.createElement.bind(document);
    document.createElement = (...args) => {
      __novelRenderProbe.created++;
      if (String(args[0]).toLowerCase() === 'p') __novelRenderProbe.paragraphsCreated++;
      return create(...args);
    };
    if (readingMode) {
      localStorage.setItem('fanhao.android.novel.settings', JSON.stringify({ readingMode, fontSize: 24, lineHeight: 1.96, theme: 'green' }));
      window.__novelNativeCalls = [];
      const record = type => async value => { __novelNativeCalls.push({ type, ...value }); };
      window.Capacitor = { Plugins: { FanHaoNovel: { setReaderImmersive: record('immersive'),
        setReaderBrightness: record('brightness'), clearReaderBrightness: record('clear-brightness') } } };
      const timeout = window.setTimeout.bind(window), clear = window.clearTimeout.bind(window);
      let autoHide;
      window.setTimeout = (callback, delay, ...args) => {
        if (delay !== 3600) return timeout(callback, delay, ...args);
        const item = { active: true, callback: () => callback(...args) };
        item.id = timeout(() => { item.active = false; item.callback(); }, delay);
        autoHide = item;
        return item.id;
      };
      window.clearTimeout = id => { if (autoHide?.id === id) autoHide.active = false; clear(id); };
      window.__novelAutoHideActive = () => Boolean(autoHide?.active);
      window.__fireNovelAutoHide = (stale = false) => {
        if (!autoHide || (!stale && !autoHide.active)) throw new Error('actual reader auto-hide was not scheduled');
        clearTimeout(autoHide.id); autoHide.callback();
      };
    }
    if (ignoreAbort) {
      const fetchImpl = window.fetch.bind(window);
      window.fetch = (url, options = {}) => fetchImpl(url, { ...options, signal: undefined, cache: 'no-store' });
    }
  }, { ignoreAbort, readingMode });
  await page.goto(baseUrl); await page.locator('.novel-mobile-book-detail').first().waitFor();
  if (progressDetail) await page.route(`**/api/novels/${catalogBook.id}?catalog=0`, route => route.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify({ book: detailProgressBook, sourceRealm }) }));
  if (cachedDetail) await page.evaluate(async ({ book, chapters }) => {
    const { writeCachedJson } = await import('/js/cache.js');
    await writeCachedJson(location.origin, `/api/novels/${book.id}`, { book, sourceRealm: book.sourceRealm, chapters });
  }, { book: { ...catalogBook, title: 'Old cached title' }, chapters: catalogChapters.map(({ content, ...chapter }) => chapter) });
  if (local) {
    await page.evaluate(async ({ book, chapters }) => {
      const { saveLocalNovelEntry } = await import('/js/local-novels.js');
      await saveLocalNovelEntry({ book, chapters });
    }, { book: { ...catalogBook, id: 'local:catalog-fixture', local: true },
      chapters: catalogChapters.map(chapter => ({ ...chapter, bookId: 'local:catalog-fixture' })) });
  }
  if (detail) {
    await page.evaluate(id => __novelUiFixture.showView('novelDetail', { id }), local ? 'local:catalog-fixture' : catalogBook.id);
    assert.equal(await page.locator('.novel-mobile-detail-hero').count(), 1, await page.locator('#viewContent').textContent());
    await page.locator('.novel-mobile-detail-hero').waitFor();
    return page;
  }
  await page.evaluate(id => __novelUiFixture.showView('novelReader', { id, chapterIndex: '1' }), local ? 'local:catalog-fixture' : catalogBook.id);
  await page.locator('.novel-reader-content').waitFor();
  await page.locator('.novel-reader-content p').nth(10).click();
  await catalogFrames(page);
  assert.equal(await page.locator('.novel-reader-content p').count(), 1000);
  return page;
}

async function resetCatalogProbe(page) {
  await catalogFrames(page);
  return page.evaluate(() => {
    const probe = __novelRenderProbe;
    probe.created = 0; probe.paragraphsCreated = 0; probe.renders.length = 0; probe.catalogTasks.length = 0;
    probe.overlays.length = 0;
    window.__catalogNodes = { screen: document.querySelector('.novel-reader-screen'),
      content: document.querySelector('.novel-reader-content'), paragraphs: [...document.querySelectorAll('.novel-reader-content p')],
      toolbar: document.querySelector('.novel-reader-toolbar') };
    return scrollY;
  });
}

async function catalogStats(page) {
  return page.evaluate(() => ({
    renders: __novelRenderProbe.renders.slice(), created: __novelRenderProbe.created,
    overlays: __novelRenderProbe.overlays.slice(),
    sameScreen: __catalogNodes.screen === document.querySelector('.novel-reader-screen'),
    sameContent: __catalogNodes.content === document.querySelector('.novel-reader-content'),
    sameToolbar: __catalogNodes.toolbar === document.querySelector('.novel-reader-toolbar'),
    sameParagraphs: __catalogNodes.paragraphs.every((p, i) => p === document.querySelectorAll('.novel-reader-content p')[i]),
    paragraphsCreated: __novelRenderProbe.paragraphsCreated,
    paragraphs: document.querySelectorAll('.novel-reader-content p').length, scroll: scrollY,
    loading: document.querySelector('.novel-reader-catalog-loading:not(.error)')?.textContent || '',
    error: document.querySelector('.novel-reader-catalog-loading.error')?.textContent || '',
    chapters: document.querySelectorAll('.novel-reader-catalog-drawer .novel-mobile-chapter').length
  }));
}

async function finishCatalog(page, gate) {
  gate.released.resolve();
  await page.evaluate(() => Promise.allSettled(__novelRenderProbe.catalogTasks));
  await catalogFrames(page);
}

function assertCatalogLoading(stats, scroll) {
  assert.equal(stats.renders.length, 0, "catalog loading must retain the mounted reader");
  assert.equal(stats.overlays.length, 1, "one remote catalog loading phase updates only one overlay");
  assert.equal(stats.paragraphsCreated, 0, "catalog loading must create zero chapter paragraphs");
  assert(stats.created < 32, `loading overlay stays bounded, got ${stats.created}`);
  assert(stats.sameScreen && stats.sameContent && stats.sameToolbar && stats.sameParagraphs, "every reader entity survives catalog loading");
  assert.equal(stats.paragraphs, 1000); assert.equal(stats.scroll, scroll);
  assert.equal(stats.loading, '正在读取章节目录…'); assert.equal(stats.error, '');
}

async function verifyFirstCatalogRendering() {
  let checks = 0;
  const run = async (name, task) => { await task(); checks++; console.log(`PASS ${name}`); };
  const catalogReads = () => requests.filter(request => request.path === `/api/novels/${catalogBook.id}/catalog`).length;
  for (const error of ["", "controlled catalog failure"]) await run(`1000-paragraph first catalog ${error ? '503 and retry' : 'success, cached reopen and pagination'}`, async () => {
    const page = await newCatalogReader(), gate = holdCatalog(error);
    try {
      const scroll = await resetCatalogProbe(page), reads = catalogReads();
      await page.getByRole('button', { name: '目录', exact: true }).click(); await waitCatalogRequest(gate);
      await catalogFrames(page); const loading = await catalogStats(page); assertCatalogLoading(loading, scroll);
      await finishCatalog(page, gate); const settled = await catalogStats(page);
      assert.equal(settled.renders.length, 0); assert.equal(settled.overlays.length, 2); assert.equal(settled.paragraphsCreated, 0);
      assert(settled.sameScreen && settled.sameContent && settled.sameToolbar && settled.sameParagraphs);
      assert.equal(settled.paragraphs, 1000); assert.equal(settled.scroll, scroll);
      assert.equal(settled.error, error); assert.equal(settled.chapters, error ? 0 : 80);
      assert.equal(catalogReads(), reads + 1);
      console.log(JSON.stringify({ mode: 'first-remote-catalog', error: Boolean(error), loading, settled }));
      await page.getByRole('button', { name: '关闭', exact: true }).click();
      if (error) {
        const retry = holdCatalog();
        try {
          const retryScroll = await resetCatalogProbe(page);
          await page.getByRole('button', { name: '目录', exact: true }).click(); await waitCatalogRequest(retry);
          await catalogFrames(page); assertCatalogLoading(await catalogStats(page), retryScroll);
          await finishCatalog(page, retry); const result = await catalogStats(page);
          assert.equal(result.renders.length, 0); assert.equal(result.overlays.length, 2); assert.equal(result.error, ''); assert.equal(result.chapters, 80);
          assert.equal(catalogReads(), reads + 2);
        } finally { retry.released.resolve(); }
      } else {
        await resetCatalogProbe(page);
        await page.getByRole('button', { name: '目录', exact: true }).click(); await catalogFrames(page);
        const reopened = await catalogStats(page);
        assert.equal(reopened.renders.length, 0); assert.equal(reopened.overlays.length, 1); assert.equal(reopened.paragraphsCreated, 0);
        assert(reopened.sameScreen && reopened.sameContent && reopened.sameToolbar && reopened.sameParagraphs);
        assert.equal(reopened.loading, ''); assert.equal(reopened.chapters, 80); assert.equal(catalogReads(), reads + 1);
        const next = holdCatalog('', 80);
        try {
          const nextScroll = await resetCatalogProbe(page);
          await page.getByRole('button', { name: '下一段', exact: true }).click(); await waitCatalogRequest(next);
          await catalogFrames(page); assertCatalogLoading(await catalogStats(page), nextScroll);
          await finishCatalog(page, next); const result = await catalogStats(page);
          assert.equal(result.renders.length, 0); assert.equal(result.overlays.length, 2); assert.equal(result.paragraphsCreated, 0);
          assert(result.sameScreen && result.sameContent && result.sameToolbar && result.sameParagraphs);
          assert.equal(result.chapters, 80); assert.equal(result.scroll, nextScroll);
          assert.match(await page.locator('.novel-reader-catalog-drawer .novel-mobile-chapter').first().textContent(), /^第81章/);
          assert.equal(catalogReads(), reads + 2);
        } finally { next.released.resolve(); }
      }
      assert.deepEqual(page.catalogErrors, []);
    } finally { gate.released.resolve(); await page.close(); }
  });
  await run('local catalog opens from its private IndexedDB chapter summaries without network', async () => {
    const page = await newCatalogReader({ local: true });
    try {
      const scroll = await resetCatalogProbe(page), requestCount = requests.length;
      await page.getByRole('button', { name: '目录', exact: true }).click();
      await page.locator('.novel-reader-catalog-drawer .novel-mobile-chapter').first().waitFor(); await catalogFrames(page);
      const result = await catalogStats(page);
      assert.equal(result.renders.length, 0, "the chapter DTO already includes the complete local catalog");
      assert.equal(result.overlays.length, 1); assert.equal(result.overlays[0].loading, false); assert.equal(result.overlays[0].open, true);
      assert.equal(result.paragraphsCreated, 0); assert.equal(result.paragraphs, 1000); assert.equal(result.chapters, 80);
      assert(result.sameScreen && result.sameContent && result.sameToolbar && result.sameParagraphs);
      assert.equal(result.scroll, scroll); assert.equal(requests.length, requestCount);
      assert.deepEqual(page.catalogErrors, []);
    } finally { await page.close(); }
  });
  for (const destination of ['close', 'leave']) for (const ignoreAbort of [false, true]) for (const error of ['', 'obsolete catalog failure']) await run(`catalog ${error ? '503' : 'success'} after ${destination}, ${ignoreAbort ? 'ignored abort' : 'normal abort'}`, async () => {
    const page = await newCatalogReader({ ignoreAbort }), gate = holdCatalog(error);
    try {
      await resetCatalogProbe(page);
      await page.getByRole('button', { name: '目录', exact: true }).click(); await waitCatalogRequest(gate);
      assert.equal((await catalogStats(page)).renders.length, 0);
      assert.equal((await catalogStats(page)).overlays.length, 1);
      if (destination === 'close') await page.getByRole('button', { name: '关闭', exact: true }).click();
      else await page.evaluate(() => __novelUiFixture.showView('novels'));
      await catalogFrames(page);
      await page.evaluate(() => { window.__catalogDestination = document.querySelector('#viewContent').firstElementChild; });
      const scroll = await resetCatalogProbe(page);
      await finishCatalog(page, gate);
      assert.equal(await page.evaluate(() => __catalogDestination === document.querySelector('#viewContent').firstElementChild && __catalogDestination.isConnected), true);
      const result = await catalogStats(page);
      assert.equal(result.renders.length, 0); assert.equal(result.created, 0); assert.equal(result.scroll, scroll);
      assert.equal(result.loading, ''); assert.equal(result.error, '');
      assert.equal(await page.locator('.novel-reader-catalog-drawer').count(), 0);
      if (destination === 'leave') assert.equal(await page.locator('.novel-reader-content').count(), 0);
      else assert.equal(result.paragraphs, 1000);
      assert.deepEqual(page.catalogErrors, []);
    } finally { gate.released.resolve(); await page.close(); }
  });
  console.log(`PASS Android novel first catalog rendering: ${checks} actual Chromium scenarios`);
}

async function clickReaderText(page) {
  // Avoid Playwright scrolling a distant paragraph into view before clicking it.
  await page.locator('.novel-reader-content p').first().evaluate(paragraph => paragraph.click());
  await catalogFrames(page);
}

async function settleMenuProgress(page, ratio) {
  await page.evaluate(value => __novelMenuProbe.position(value), ratio);
  await page.waitForFunction(value => {
    const state = __novelMenuProbe.snapshot();
    return !state.progressPending && state.progress && Math.abs(state.progress.scrollRatio - value) < .005;
  }, ratio);
}

async function storedMenuProgress(page, local) {
  if (local) return page.evaluate(async () => {
    const { readLocalNovelSummary } = await import('/js/local-novels.js');
    return (await readLocalNovelSummary('local:catalog-fixture')).book.progress;
  });
  return requests.findLast(request => request.path === `/api/novels/${catalogBook.id}/progress`)?.body;
}

async function beginMenuAction(page) {
  await resetCatalogProbe(page);
  return page.evaluate(() => {
    window.__menuNodes = {
      screen: document.querySelector('.novel-reader-screen'),
      paragraph: document.querySelector('.novel-reader-content p'),
      toolbar: document.querySelector('.novel-reader-toolbar'),
      focus: document.activeElement
    };
    return { ...__novelMenuProbe.snapshot(), stored: localStorage.getItem('fanhao.android.novel.settings'),
      nativeCalls: __novelNativeCalls.slice(), slider: document.querySelector('[data-novel-chapter-slider]').value };
  });
}

async function finishMenuAction(page) {
  await catalogFrames(page);
  await page.waitForTimeout(230); // The production opacity transition lasts 160ms.
  return page.evaluate(() => {
    const screen = document.querySelector('.novel-reader-screen'), paragraph = screen?.querySelector('.novel-reader-content p'),
      toolbar = screen?.querySelector('.novel-reader-toolbar');
    return { ...__novelMenuProbe.snapshot(), stored: localStorage.getItem('fanhao.android.novel.settings'),
      created: __novelRenderProbe.created, paragraphsCreated: __novelRenderProbe.paragraphsCreated,
      renderCalls: __novelRenderProbe.renders.length, paragraphs: screen?.querySelectorAll('.novel-reader-content p').length,
      sameScreen: __menuNodes.screen === screen, sameParagraph: __menuNodes.paragraph === paragraph,
      sameToolbar: __menuNodes.toolbar === toolbar, sameFocus: __menuNodes.focus === document.activeElement,
      opacity: toolbar && getComputedStyle(toolbar).opacity, font: paragraph && getComputedStyle(paragraph).fontSize,
      lineHeight: paragraph && getComputedStyle(paragraph).lineHeight, green: screen?.classList.contains('theme-green'),
      nativeCalls: __novelNativeCalls.slice(), autoHide: __novelAutoHideActive(),
      slider: screen?.querySelector('[data-novel-chapter-slider]')?.value };
  });
}

function assertMenuPreserved(before, after, fullRender = false) {
  assert(Math.abs(after.ratio - before.ratio) < .005, 'menu operation preserves the actual reading ratio');
  assert.equal(after.settings, before.settings); assert.equal(after.stored, before.stored);
  if (fullRender) {
    // The existing full renderer saves the restored position with a fresh timestamp.
    assert.equal(after.progress?.chapterIndex, before.progress?.chapterIndex);
    assert(Math.abs(after.progress.scrollRatio - before.progress.scrollRatio) < .005);
  } else assert.deepEqual(after.progress, before.progress);
  assert.equal(after.paragraphs, 1000);
}

async function verifyReaderMenuReuse() {
  let checks = 0;
  const pass = name => { checks++; console.log(`PASS ${name}`); };
  for (const readingMode of ['scroll', 'page']) for (const local of [false, true]) {
    const page = await newCatalogReader({ readingMode, local });
    try {
      await clickReaderText(page); // Start with the menu closed.
      await settleMenuProgress(page, .42);
      const saved = await storedMenuProgress(page, local);
      assert(Math.abs(saved.scrollRatio - .42) < .005, 'real progress storage contains the reading position');
      for (const action of ['open', 'close', 'open-again', 'auto-hide']) {
        await page.locator('[data-novel-chapter-slider]').evaluate(slider => slider.focus());
        const before = await beginMenuAction(page), requestCount = requests.length;
        if (action === 'auto-hide') await page.evaluate(() => __fireNovelAutoHide());
        else await clickReaderText(page);
        const after = await finishMenuAction(page), open = action === 'open' || action === 'open-again';
        console.log(JSON.stringify({ readingMode, local, action, created: after.created,
          paragraphsCreated: after.paragraphsCreated, renderCalls: after.renderCalls,
          requests: requests.length - requestCount, ratio: after.ratio }));
        assert.equal(after.paragraphsCreated, 0, 'a CSS-only menu operation must not recreate the 1000 chapter paragraphs');
        assert.equal(after.created, 0); assert.equal(after.renderCalls, 0);
        assertMenuPreserved(before, after);
        assert.equal(after.menu, open); assert.equal(after.opacity, open ? '1' : '0'); assert.equal(after.autoHide, open);
        assert.equal(after.sameScreen, true); assert.equal(after.sameParagraph, true); assert.equal(after.sameToolbar, true);
        assert.equal(after.sameFocus, true); assert.equal(after.slider, before.slider);
        assert.equal(after.font, '24px'); assert.equal(after.lineHeight, '47.04px'); assert.equal(after.green, true);
        assert.equal(after.immersive, true); assert.deepEqual(after.nativeCalls, before.nativeCalls);
        assert.equal(requests.length, requestCount, 'menu operation starts no HTTP request');
        assert.deepEqual(await storedMenuProgress(page, local), saved, 'menu operation keeps persisted progress intact');
        pass(`${readingMode} ${local ? 'local' : 'remote'} menu ${action}: nodes, focus, settings and saved progress`);
      }
      // A genuine movement still updates the live slider and existing storage after menu reuse.
      await page.locator('[data-novel-chapter-slider]').evaluate(slider => slider.blur());
      await settleMenuProgress(page, .61);
      const moved = await storedMenuProgress(page, local);
      assert(Math.abs(moved.scrollRatio - .61) < .005);
      assert.equal(await page.locator('[data-novel-chapter-slider]').inputValue(), '61');
      assert.deepEqual(page.catalogErrors, []);
    } finally { await page.close(); }
  }
  for (const readingMode of ['scroll', 'page']) {
    const page = await newCatalogReader({ readingMode });
    try {
      await clickReaderText(page); await settleMenuProgress(page, .42);
      for (const overlay of ['settings', 'catalog']) {
        await clickReaderText(page);
        await page.getByRole('button', { name: overlay === 'settings' ? '设置' : '目录', exact: true }).click();
        if (overlay === 'catalog') await page.locator('.novel-reader-catalog-drawer .novel-mobile-chapter').first().waitFor();
        await page.waitForFunction(() => !__novelMenuProbe.snapshot().progressPending);
        const before = await beginMenuAction(page);
        assert.equal(before.immersive, overlay !== 'settings');
        assert.equal(await page.evaluate(() => __novelAutoHideActive()), false, 'an overlay suppresses menu auto-hide');
        await clickReaderText(page);
        const after = await finishMenuAction(page);
        assertMenuPreserved(before, after, true);
        assert.equal(after.menu, false); assert.equal(after.settingsOpen, false); assert.equal(after.catalogOpen, false);
        assert.equal(after.paragraphsCreated, 0, 'closing an overlay retains the mounted chapter entities');
        assert.equal(after.renderCalls, 0); assert.equal(after.sameScreen, true);
        assert.equal(after.sameParagraph, true); assert.equal(after.sameToolbar, true);
        assert.equal(after.immersive, true); assert.equal(after.autoHide, false);
        assert.equal(await page.locator('.novel-reader-settings-panel, .novel-reader-catalog-drawer').count(), 0);
        assert.equal(after.nativeCalls.findLast(call => call.type === 'immersive').immersive, true);
        pass(`${readingMode} ${overlay} close retains chapter entities and restores immersive mode`);
      }
      // Existing setting operations persist and redraw at the retained reading position.
      await clickReaderText(page); await page.getByRole('button', { name: '设置', exact: true }).click();
      const ratio = await page.evaluate(() => __novelMenuProbe.snapshot().ratio);
      await page.getByRole('button', { name: 'A+', exact: true }).click();
      await page.getByRole('button', { name: '暖粉', exact: true }).click();
      await catalogFrames(page);
      const settings = await page.evaluate(() => ({ ...__novelMenuProbe.snapshot(),
        stored: JSON.parse(localStorage.getItem('fanhao.android.novel.settings')),
        font: getComputedStyle(document.querySelector('.novel-reader-content p')).fontSize,
        rose: document.querySelector('.novel-reader-screen').classList.contains('theme-rose') }));
      assert.equal(settings.font, '25px'); assert.equal(settings.rose, true);
      assert.equal(settings.stored.fontSize, 25); assert.equal(settings.stored.theme, 'rose');
      assert.equal(settings.immersive, false); assert(Math.abs(settings.ratio - ratio) < .005);
      await page.getByRole('button', { name: '完成', exact: true }).click();
      await catalogFrames(page); assert.equal(await page.evaluate(() => __novelMenuProbe.snapshot().immersive), true);
      assert.deepEqual(page.catalogErrors, []);
      pass(`${readingMode} font/theme settings preserve ratio, persistence and immersive state`);
    } finally { await page.close(); }
  }
  for (const ownership of ['route-abort', 'source-change']) for (const action of ['click', 'auto-hide']) {
    const page = await newCatalogReader({ readingMode: 'scroll' });
    try {
      await page.waitForFunction(() => !__novelMenuProbe.snapshot().progressPending);
      const before = await beginMenuAction(page), requestCount = requests.length;
      await page.evaluate(owner => {
        if (owner === 'route-abort') __novelUiFixture.invalidate();
        else __novelUiFixture.setSourceUrl(`${location.origin}/obsolete-source`);
      }, ownership);
      if (action === 'click') await clickReaderText(page);
      else await page.evaluate(() => __fireNovelAutoHide());
      const after = await finishMenuAction(page);
      assert.equal(after.current, false); assert.equal(after.opacity, '1', 'an obsolete owner cannot change the mounted menu class');
      assert.equal(after.created, 0); assert.equal(after.paragraphsCreated, 0);
      assert.equal(after.sameScreen, true); assert.equal(after.sameParagraph, true); assert.equal(after.sameToolbar, true);
      assert.equal(after.settings, before.settings); assert.equal(after.stored, before.stored);
      assert.deepEqual(after.nativeCalls, before.nativeCalls); assert.equal(requests.length, requestCount);
      assert.deepEqual(page.catalogErrors, []);
      pass(`menu ${action} keeps route/source ownership after ${ownership}`);
    } finally { await page.close(); }
  }
  const page = await newCatalogReader({ readingMode: 'scroll' });
  try {
    await page.evaluate(() => __novelUiFixture.showView('novels')); await catalogFrames(page);
    await resetCatalogProbe(page);
    const requestCount = requests.length;
    await page.evaluate(() => { window.__menuDestination = document.querySelector('#viewContent').firstElementChild; __fireNovelAutoHide(true); });
    await catalogFrames(page);
    assert.equal(await page.evaluate(() => __menuDestination === document.querySelector('#viewContent').firstElementChild && __menuDestination.isConnected), true);
    assert.equal((await catalogStats(page)).created, 0); assert.equal(requests.length, requestCount);
    assert.equal(await page.evaluate(() => document.body.classList.contains('novel-reader-immersive')), false);
    assert.equal(await page.locator('.novel-reader-screen').count(), 0);
    assert.deepEqual(page.catalogErrors, []);
    pass('expired auto-hide after leaving the reader cannot touch the new page');
  } finally { await page.close(); }
  console.log(`PASS Android novel menu reuse: ${checks} actual Chromium scenarios`);
}

async function verifyOverlayReuse() {
  let checks = 0;
  const pass = name => { checks++; console.log(`PASS ${name}`); };
  const stable = async page => {
    await catalogFrames(page);
    await page.waitForFunction(() => !__novelMenuProbe.snapshot().progressPending);
  };
  const sameReader = stats => {
    assert.equal(stats.renders.length, 0, 'overlay operation must not invoke the complete reader renderer');
    assert.equal(stats.paragraphsCreated, 0, 'overlay operation creates zero chapter paragraphs');
    assert(stats.sameScreen && stats.sameContent && stats.sameToolbar && stats.sameParagraphs,
      'all 1000 paragraphs, content, toolbar and screen retain their actual DOM identity');
  };
  for (const readingMode of ['scroll', 'page']) for (const local of [false, true]) {
    const page = await newCatalogReader({ readingMode, local });
    try {
      await settleMenuProgress(page, .42);
      const origin = await page.evaluate(() => __novelMenuProbe.snapshot().ratio);
      await resetCatalogProbe(page);
      await page.getByRole('button', { name: '设置', exact: true }).click(); await stable(page);
      sameReader(await catalogStats(page));
      assert.equal(await page.locator('.novel-reader-settings-panel').count(), 1);
      assert.equal(await page.evaluate(() => __novelMenuProbe.snapshot().immersive), false);
      await page.evaluate(() => {
        const panel = document.querySelector('.novel-reader-settings-panel');
        window.__obsoletePanel = { brightness: panel.querySelector('input'),
          plus: [...panel.querySelectorAll('button')].find(button => button.textContent === 'A+'),
          done: [...panel.querySelectorAll('button')].find(button => button.textContent === '完成') };
      });
      await page.getByRole('button', { name: '完成', exact: true }).click(); await stable(page);
      sameReader(await catalogStats(page));
      assert.equal(await page.locator('.novel-reader-settings-panel').count(), 0);
      assert.equal(await page.evaluate(() => __novelMenuProbe.snapshot().immersive), true);
      pass(`${readingMode} ${local ? 'local' : 'remote'} settings open/close reuses every chapter entity`);

      await page.getByRole('button', { name: '设置', exact: true }).click(); await stable(page);
      const before = await beginMenuAction(page), requestCount = requests.length;
      await page.evaluate(() => {
        window.__currentPanel = document.querySelector('.novel-reader-settings-panel');
        __obsoletePanel.brightness.value = '55';
        __obsoletePanel.brightness.dispatchEvent(new Event('input', { bubbles: true }));
        __obsoletePanel.brightness.dispatchEvent(new Event('change', { bubbles: true }));
        __obsoletePanel.plus.click(); __obsoletePanel.done.click();
      });
      const after = await finishMenuAction(page);
      assert.equal(after.settings, before.settings, 'detached settings never change the reopened panel or live reading preferences');
      assert.equal(after.stored, before.stored); assert.deepEqual(after.nativeCalls, before.nativeCalls);
      assert.equal(requests.length, requestCount); sameReader(await catalogStats(page));
      assert.equal(await page.evaluate(() => __currentPanel === document.querySelector('.novel-reader-settings-panel')), true);
      pass(`${readingMode} ${local ? 'local' : 'remote'} detached settings callbacks are inactive on the same reader screen`);

      await page.getByRole('button', { name: '目录', exact: true }).click();
      await page.locator('.novel-reader-catalog-drawer .novel-mobile-chapter').first().waitFor(); await stable(page);
      assert.equal(await page.locator('.novel-reader-settings-panel').count(), 0);
      assert.equal(await page.evaluate(() => __novelMenuProbe.snapshot().immersive), true);
      sameReader(await catalogStats(page));
      await page.evaluate(() => {
        const drawer = document.querySelector('.novel-reader-catalog-drawer');
        window.__obsoleteDrawer = { input: drawer.querySelector('input'), range: drawer.querySelector('select'),
          chapter: drawer.querySelector('.novel-mobile-chapter'), buttons: [...drawer.querySelectorAll('button')].filter(button => !button.classList.contains('novel-mobile-chapter')) };
      });
      await page.getByRole('button', { name: '关闭', exact: true }).click();
      await page.getByRole('button', { name: '目录', exact: true }).click();
      await page.locator('.novel-reader-catalog-drawer .novel-mobile-chapter').first().waitFor(); await stable(page);
      await resetCatalogProbe(page);
      const drawerBefore = await page.evaluate(() => {
        window.__currentDrawer = document.querySelector('.novel-reader-catalog-drawer');
        return { state: __novelMenuProbe.snapshot(), text: __currentDrawer.textContent,
          stored: localStorage.getItem('fanhao.android.novel.settings'), native: __novelNativeCalls.slice() };
      });
      const readsBefore = requests.length;
      await page.evaluate(() => {
        __obsoleteDrawer.input.value = 'obsolete query'; __obsoleteDrawer.input.dispatchEvent(new Event('input', { bubbles: true }));
        __obsoleteDrawer.range.value = '1'; __obsoleteDrawer.range.dispatchEvent(new Event('change', { bubbles: true }));
        for (const button of __obsoleteDrawer.buttons) button.click(); __obsoleteDrawer.chapter.click();
      });
      await page.waitForTimeout(330); await catalogFrames(page);
      assert.equal(await page.evaluate(() => __currentDrawer === document.querySelector('.novel-reader-catalog-drawer') && __currentDrawer.isConnected), true);
      assert.equal(await page.locator('.novel-reader-catalog-drawer').textContent(), drawerBefore.text);
      assert.equal(await page.evaluate(() => __novelMenuProbe.snapshot().chapterIndex), drawerBefore.state.chapterIndex);
      assert.equal(requests.length, readsBefore, 'detached catalog controls issue no API request or progress write');
      sameReader(await catalogStats(page));
      pass(`${readingMode} ${local ? 'local' : 'remote'} detached catalog search/order/range/chapter/close controls remain inactive`);

      await page.getByRole('button', { name: '关闭', exact: true }).click();
      await page.getByRole('button', { name: '设置', exact: true }).click(); await stable(page);
      await resetCatalogProbe(page); await page.evaluate(() => __holdOverlayFrames());
      await page.getByRole('button', { name: 'A+', exact: true }).evaluate(button => button.click());
      await page.getByRole('button', { name: '完成', exact: true }).evaluate(button => button.click());
      await page.getByRole('button', { name: '目录', exact: true }).evaluate(button => button.click());
      await page.locator('.novel-reader-catalog-drawer .novel-mobile-chapter').first().waitFor();
      await page.getByRole('button', { name: '关闭', exact: true }).evaluate(button => button.click());
      await page.evaluate(() => __releaseOverlayFrames()); await stable(page);
      assert(Math.abs((await page.evaluate(() => __novelMenuProbe.snapshot().ratio)) - origin) < .005, 'rapid font and overlay changes preserve the deferred reading position');
      sameReader(await catalogStats(page));
      assert.equal(await page.locator('.novel-reader-settings-panel, .novel-reader-catalog-drawer').count(), 0);
      pass(`${readingMode} ${local ? 'local' : 'remote'} rapid font/settings/catalog changes preserve the pending restore`);
      assert.deepEqual(page.catalogErrors, []);
    } finally { await page.close(); }
  }
  const page = await newCatalogReader({ readingMode: 'scroll' });
  try {
    await page.getByRole('button', { name: '目录', exact: true }).click();
    await page.locator('.novel-reader-catalog-drawer input').waitFor(); await stable(page);
    await page.locator('.novel-reader-catalog-drawer input').evaluate(input => { input.value = '129'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.evaluate(() => { window.__expiredSearch = __catalogSearchCallbacks.at(-1); });
    await page.getByRole('button', { name: '关闭', exact: true }).evaluate(button => button.click());
    await stable(page); const before = requests.length;
    await page.evaluate(() => __expiredSearch()); await page.waitForTimeout(300);
    assert.equal(requests.length, before, 'the canceled old search callback stays inactive after close');
    const gate = holdCatalog();
    try {
      await page.getByRole('button', { name: '目录', exact: true }).click(); await waitCatalogRequest(gate);
      assert.equal(new URL(gate.url, baseUrl).searchParams.get('q'), '129', 'reopening cannot treat an unfinished query as a loaded result');
      await finishCatalog(page, gate);
      assert.equal(await page.locator('.novel-reader-catalog-drawer .novel-mobile-chapter').count(), 1);
      assert.match(await page.locator('.novel-reader-catalog-drawer .novel-mobile-chapter').textContent(), /^第129章/);
      pass('remote canceled search is reloaded on reopen with its original query and exact results');
    } finally { gate.released.resolve(); }
    assert.deepEqual(page.catalogErrors, []);
  } finally { await page.close(); }
  console.log(`PASS Android novel overlay reuse: ${checks} actual Chromium scenarios`);
}

async function verifyCatalogInputReuse() {
  let checks = 0;
  const pass = name => { checks++; console.log(`PASS ${name}`); };
  const currentInput = page => page.evaluate(() => ({
    same: __catalogInputBefore === document.querySelector('.novel-reader-catalog-drawer input'),
    connected: __catalogInputBefore.isConnected, focused: document.activeElement === __catalogInputBefore,
    value: document.querySelector('.novel-reader-catalog-drawer input')?.value,
    caret: __catalogInputBefore.selectionStart, end: __catalogInputBefore.selectionEnd
  }));
  const retained = (actual, value) => {
    assert.equal(actual.connected, true, 'loading must retain the actual focused catalog input');
    assert.equal(actual.same, true); assert.equal(actual.focused, true); assert.equal(actual.value, value);
    assert.equal(actual.caret, value.length); assert.equal(actual.end, value.length);
  };
  for (const readingMode of ['scroll', 'page']) {
    const page = await newCatalogReader({ readingMode }), first = holdCatalog('', null, '1'), second = holdCatalog('', null, '12');
    try {
      await page.getByRole('button', { name: '目录', exact: true }).click();
      const input = page.locator('.novel-reader-catalog-drawer input'); await input.waitFor();
      await page.waitForFunction(() => !__novelMenuProbe.snapshot().progressPending); await resetCatalogProbe(page);
      await page.evaluate(() => {
        window.__catalogInputBefore = document.querySelector('.novel-reader-catalog-drawer input');
        window.__oldResultChapter = document.querySelector('.novel-reader-catalog-drawer .novel-mobile-chapter');
      });
      await input.click(); await page.keyboard.type('1'); await waitCatalogRequest(first);
      const actual = await currentInput(page); console.log(JSON.stringify({ catalogInputDuringLoad: actual })); retained(actual, '1');
      assert.equal(await page.locator('.novel-reader-catalog-drawer .novel-mobile-chapter').count(), 0);
      const beforeOldClick = requests.length;
      assert.equal(await page.evaluate(() => __oldResultChapter.isConnected), false);
      await page.evaluate(() => __oldResultChapter.click()); await catalogFrames(page);
      assert.equal((await catalogStats(page)).sameScreen, true, 'detached result callback cannot navigate the retained drawer');
      assert.equal(requests.length, beforeOldClick);
      pass(`${readingMode} loading keeps input/caret and fences removed chapter results`);

      await page.evaluate(() => { __holdCatalogSearch = true; }); await page.keyboard.type('2'); retained(await currentInput(page), '12');
      const beforeOldResponse = await page.evaluate(() => __novelMenuProbe.snapshot().catalog);
      await finishCatalog(page, first);
      assert.deepEqual(await page.evaluate(() => __novelMenuProbe.snapshot().catalog), beforeOldResponse,
        'older query response cannot replace the newer query intent or its source rows before debounce');
      retained(await currentInput(page), '12');
      assert.equal(await page.locator('.novel-reader-catalog-drawer .novel-mobile-chapter').count(), 0);
      pass(`${readingMode} superseded response preserves the complete current query/source/loading state`);

      await page.evaluate(() => __releaseCatalogSearch()); await waitCatalogRequest(second);
      await page.setViewportSize({ width: 400, height: 550 }); retained(await currentInput(page), '12');
      const box = await input.boundingBox(); assert(box.y >= 0 && box.y + box.height <= 550, 'focused search stays in the smaller readable viewport');
      await finishCatalog(page, second); retained(await currentInput(page), '12');
      const expected = catalogChapters.filter(chapter => chapter.title.includes('12')).map(chapter => chapter.title);
      assert.deepEqual(await page.locator('.novel-reader-catalog-drawer .novel-mobile-chapter strong').allTextContents(), expected);
      const stats = await catalogStats(page);
      assert(stats.sameScreen && stats.sameContent && stats.sameParagraphs && stats.sameToolbar);
      assert.equal(stats.renders.length, 0); assert.equal(stats.paragraphsCreated, 0);
      pass(`${readingMode} continuous real typing, viewport resize and exact final results retain every chapter entity`);
      assert.deepEqual(page.catalogErrors, []);
    } finally { first.released.resolve(); second.released.resolve(); await page.close(); }
  }
  for (const readingMode of ['scroll', 'page']) {
    const page = await newCatalogReader({ readingMode, local: true });
    try {
      await page.getByRole('button', { name: '目录', exact: true }).click();
      const input = page.locator('.novel-reader-catalog-drawer input'); await input.waitFor();
      await resetCatalogProbe(page); await page.evaluate(() => { window.__catalogInputBefore = document.querySelector('.novel-reader-catalog-drawer input'); });
      const reads = requests.length;
      await input.click(); await page.keyboard.type('12', { delay: 100 }); retained(await currentInput(page), '12');
      assert.deepEqual(await page.locator('.novel-reader-catalog-drawer .novel-mobile-chapter strong').allTextContents(),
        catalogChapters.filter(chapter => chapter.title.includes('12')).map(chapter => chapter.title));
      assert.equal(requests.length, reads, 'local typing stays offline');
      assert.equal((await catalogStats(page)).sameParagraphs, true);
      pass(`${readingMode} local filtering preserves actual keyboard focus, caret and offline behavior`);
      assert.deepEqual(page.catalogErrors, []);
    } finally { await page.close(); }
  }
  const page = await newCatalogReader({ readingMode: 'scroll' });
  const failure = holdCatalog('controlled query failure', null, '12'), retry = holdCatalog('', null, '129');
  try {
    await page.getByRole('button', { name: '目录', exact: true }).click();
    const input = page.locator('.novel-reader-catalog-drawer input'); await input.waitFor();
    await page.evaluate(() => { window.__catalogInputBefore = document.querySelector('.novel-reader-catalog-drawer input'); });
    await input.click(); await page.keyboard.type('12'); await waitCatalogRequest(failure);
    await finishCatalog(page, failure); retained(await currentInput(page), '12');
    assert.equal(await page.locator('.novel-reader-catalog-loading.error').textContent(), 'controlled query failure');
    assert.equal(await page.locator('.novel-reader-catalog-drawer .novel-mobile-chapter').count(), 0);
    await page.keyboard.type('9'); await waitCatalogRequest(retry); retained(await currentInput(page), '129');
    await finishCatalog(page, retry); retained(await currentInput(page), '129');
    assert.deepEqual(await page.locator('.novel-reader-catalog-drawer .novel-mobile-chapter strong').allTextContents(),
      catalogChapters.filter(chapter => chapter.title.includes('129')).map(chapter => chapter.title));
    assert.equal(await page.locator('.novel-reader-catalog-loading.error').count(), 0);
    pass('remote query failure keeps focus/caret and real typing retries with exact fresh results');
    await page.keyboard.type('x');
    await page.waitForFunction(() => !__novelMenuProbe.snapshot().catalog.loading
      && __novelMenuProbe.snapshot().catalog.loadedQuery === '129x');
    retained(await currentInput(page), '129x');
    assert.equal(await page.locator('.novel-reader-catalog-drawer .novel-mobile-chapter').count(), 0);
    assert.equal(await page.locator('.novel-mobile-catalog-empty').textContent(), '没有匹配的章节');
    pass('remote empty query result retains the actual input and presents truthful empty state');
    assert.deepEqual(page.catalogErrors, []);
  } finally { failure.released.resolve(); retry.released.resolve(); await page.close(); }
  console.log(`PASS Android novel catalog input reuse: ${checks} actual Chromium scenarios`);
}

async function verifyDetailCatalogReuse() {
  let checks = 0;
  const pass = name => { checks++; console.log(`PASS ${name}`); };
  const remember = async page => page.evaluate(() => {
    window.__detailNodes = { hero: document.querySelector('.novel-mobile-detail-hero'), summary: document.querySelector('.novel-mobile-summary-panel'),
      tools: document.querySelector('.novel-mobile-book-tools'), catalog: document.querySelector('#novelDetailCatalog'),
      browser: document.querySelector('#novelDetailCatalog .novel-mobile-catalog-browser'), input: document.querySelector('#novelDetailCatalog input'),
      results: [...document.querySelectorAll('#novelDetailCatalog .novel-mobile-chapter')] };
    __novelRenderProbe.detailRenders.length = 0;
  });
  const inputState = page => page.evaluate(() => ({ connected: __detailNodes.input.isConnected,
    same: __detailNodes.input === document.querySelector('#novelDetailCatalog input'), focused: document.activeElement === __detailNodes.input,
    value: __detailNodes.input.value, caret: __detailNodes.input.selectionStart, end: __detailNodes.input.selectionEnd,
    hero: __detailNodes.hero === document.querySelector('.novel-mobile-detail-hero'), catalog: __detailNodes.catalog === document.querySelector('#novelDetailCatalog'),
    browser: __detailNodes.browser === document.querySelector('#novelDetailCatalog .novel-mobile-catalog-browser'), renders: __novelRenderProbe.detailRenders.slice() }));
  const retained = (actual, value, focus = true) => {
    assert.equal(actual.connected, true); assert.equal(actual.same, true); assert.equal(actual.focused, focus);
    assert.equal(actual.value, value); assert.equal(actual.caret, value.length); assert.equal(actual.end, value.length);
    assert(actual.hero && actual.catalog && actual.browser); assert.deepEqual(actual.renders, []);
  };
  const titles = page => page.locator('#novelDetailCatalog .novel-mobile-chapter strong').allTextContents();
  const expectedTitles = query => catalogChapters.filter(chapter => chapter.title.includes(query)).map(chapter => chapter.title);
  const page = await newCatalogReader({ detail: true }), gate = holdCatalog('', null, '12');
  try {
    await page.getByRole('button', { name: '展开简介', exact: true }).click();
    await page.locator('.novel-mobile-book-tools summary').click();
    await page.evaluate(() => {
      window.__detailNodes = { hero: document.querySelector('.novel-mobile-detail-hero'), summary: document.querySelector('.novel-mobile-summary-panel'),
        tools: document.querySelector('.novel-mobile-book-tools'), catalog: document.querySelector('#novelDetailCatalog'),
        input: document.querySelector('#novelDetailCatalog input') };
      __novelRenderProbe.detailRenders.length = 0;
    });
    const input = page.locator('#novelDetailCatalog input'); await input.click(); await page.keyboard.type('12'); await waitCatalogRequest(gate);
    await finishCatalog(page, gate);
    const actual = await page.evaluate(() => ({ sameInput: __detailNodes.input === document.querySelector('#novelDetailCatalog input'),
      connected: __detailNodes.input.isConnected, focused: document.activeElement === __detailNodes.input,
      caret: __detailNodes.input.selectionStart, value: document.querySelector('#novelDetailCatalog input')?.value,
      sameHero: __detailNodes.hero === document.querySelector('.novel-mobile-detail-hero'),
      expanded: !document.querySelector('.novel-mobile-summary-panel').classList.contains('collapsed'),
      toolsOpen: document.querySelector('.novel-mobile-book-tools').open, renders: __novelRenderProbe.detailRenders.slice() }));
    console.log(JSON.stringify({ detailCatalogSearchAfterResponse: actual }));
    assert.equal(actual.connected, true, 'detail catalog response must retain the actual input');
    assert.equal(actual.sameInput, true); assert.equal(actual.focused, true); assert.equal(actual.value, '12'); assert.equal(actual.caret, 2);
    assert.equal(actual.sameHero, true); assert.equal(actual.expanded, true); assert.equal(actual.toolsOpen, true); assert.deepEqual(actual.renders, []);
    assert.deepEqual(await page.locator('#novelDetailCatalog .novel-mobile-chapter strong').allTextContents(),
      catalogChapters.filter(chapter => chapter.title.includes('12')).map(chapter => chapter.title));
    assert.deepEqual(page.catalogErrors, []);
    pass('detail input focus/caret, expanded sections, exact results and zero full renders');
  } finally { gate.released.resolve(); await page.close(); }

  for (const olderError of ['', 'controlled superseded detail failure']) {
    const page = await newCatalogReader({ detail: true }), first = holdCatalog(olderError, null, '1'), second = holdCatalog('', null, '12');
    try {
      await remember(page); const input = page.locator('#novelDetailCatalog input');
      await input.click(); await page.keyboard.type('1'); await waitCatalogRequest(first); retained(await inputState(page), '1');
      assert.equal(await page.locator('#novelDetailCatalog .novel-mobile-chapter').count(), 0);
      const reads = requests.length;
      await page.evaluate(() => __detailNodes.results[0].click()); await catalogFrames(page);
      assert.equal(requests.length, reads); assert.equal(await page.locator('.novel-reader-screen').count(), 0);
      pass(`detail loading removes and fences old results (${olderError ? 'error' : 'success'} response)`);
      await page.evaluate(() => { __holdCatalogSearch = true; }); await page.keyboard.type('2'); retained(await inputState(page), '12');
      const before = await page.evaluate(() => __novelDetailProbe.snapshot());
      await finishCatalog(page, first);
      assert.deepEqual(await page.evaluate(() => __novelDetailProbe.snapshot()), before, 'superseded detail response cannot replace current query, complete source rows or loaded identity before debounce');
      retained(await inputState(page), '12');
      assert.equal(await page.locator('#novelDetailCatalog .novel-reader-catalog-loading.error').count(), 0);
      assert.equal(await page.locator('#novelDetailCatalog .novel-mobile-chapter').count(), 0);
      pass(`detail obsolete ${olderError ? 'failure' : 'success'} preserves all current state before newer debounce`);
      await page.evaluate(() => __releaseCatalogSearch()); await waitCatalogRequest(second);
      await page.setViewportSize({ width: 400, height: 550 }); await input.scrollIntoViewIfNeeded();
      retained(await inputState(page), '12'); const box = await input.boundingBox();
      assert(box.y >= 0 && box.y + box.height <= 550, 'detail search remains usable in the resized viewport');
      const scroll = await page.evaluate(() => scrollY);
      await finishCatalog(page, second); retained(await inputState(page), '12');
      assert.equal(await page.evaluate(() => scrollY), scroll, 'partial reply does not replay the obsolete request-time scroll position');
      assert.deepEqual(await titles(page), expectedTitles('12')); assert.deepEqual(page.catalogErrors, []);
      pass(`detail continued keyboard typing and viewport resize preserve focus, caret, position and exact results (${olderError ? 'error' : 'success'})`);
    } finally { first.released.resolve(); second.released.resolve(); await page.close(); }
  }

  const retryPage = await newCatalogReader({ detail: true }), failure = holdCatalog('controlled detail query failure', null, '12'), retry = holdCatalog('', null, '129');
  try {
    await remember(retryPage); const input = retryPage.locator('#novelDetailCatalog input');
    await input.click(); await retryPage.keyboard.type('12'); await waitCatalogRequest(failure); await finishCatalog(retryPage, failure);
    retained(await inputState(retryPage), '12');
    assert.equal(await retryPage.locator('#novelDetailCatalog .novel-reader-catalog-loading.error').textContent(), 'controlled detail query failure');
    assert.deepEqual(await titles(retryPage), []);
    await retryPage.keyboard.type('9'); await waitCatalogRequest(retry); retained(await inputState(retryPage), '129');
    await finishCatalog(retryPage, retry); retained(await inputState(retryPage), '129'); assert.deepEqual(await titles(retryPage), expectedTitles('129'));
    assert.equal(await retryPage.locator('#novelDetailCatalog .novel-reader-catalog-loading.error').count(), 0);
    pass('detail search failure preserves the real input and continuous typing retries successfully');
    await retryPage.keyboard.type('x');
    await retryPage.waitForFunction(() => __novelDetailProbe.snapshot().loadedQuery === '129x'); retained(await inputState(retryPage), '129x');
    assert.deepEqual(await titles(retryPage), []); assert.equal(await retryPage.locator('#novelDetailCatalog .novel-mobile-catalog-empty').textContent(), '没有匹配的章节');
    assert.equal(await retryPage.locator('#novelDetailCatalog .novel-mobile-catalog-status').textContent(), '找到 0 章');
    assert.deepEqual(retryPage.catalogErrors, []); pass('detail empty response preserves focus and reports the exact zero-result state');
  } finally { failure.released.resolve(); retry.released.resolve(); await retryPage.close(); }

  const pagingPage = await newCatalogReader({ detail: true }), nextGate = holdCatalog('', 80), orderGate = holdCatalog();
  try {
    await pagingPage.getByRole('button', { name: '展开简介', exact: true }).click();
    await pagingPage.locator('.novel-mobile-book-tools summary').click(); await remember(pagingPage);
    await pagingPage.getByRole('button', { name: '下一段', exact: true }).click(); await waitCatalogRequest(nextGate);
    assert.equal(await pagingPage.getByRole('button', { name: '上一段', exact: true }).isDisabled(), true);
    assert.equal(await pagingPage.getByRole('button', { name: '下一段', exact: true }).isDisabled(), true);
    assert.equal(await pagingPage.getByLabel('目录分段', { exact: true }).isDisabled(), true);
    await finishCatalog(pagingPage, nextGate);
    assert.deepEqual(await titles(pagingPage), catalogChapters.slice(80, 160).map(chapter => chapter.title));
    assert.equal(await pagingPage.getByLabel('目录分段', { exact: true }).inputValue(), '1');
    assert.equal(await pagingPage.evaluate(() => __novelDetailProbe.snapshot().offset), 80);
    assert.equal(await pagingPage.evaluate(() => __detailNodes.input === document.querySelector('#novelDetailCatalog input')), true);
    assert.equal(await pagingPage.evaluate(() => !__detailNodes.summary.classList.contains('collapsed') && __detailNodes.tools.open), true);
    assert.deepEqual(await pagingPage.evaluate(() => __novelRenderProbe.detailRenders), []); pass('detail pagination keeps existing sections and updates the exact 80-row page and controls');
    await pagingPage.getByRole('button', { name: '正序', exact: true }).click(); await waitCatalogRequest(orderGate); await finishCatalog(pagingPage, orderGate);
    assert.deepEqual(await titles(pagingPage), [catalogChapters[0].title], 'descending order still anchors the existing first-chapter position');
    assert.equal(await pagingPage.getByRole('button', { name: '倒序', exact: true }).count(), 1);
    assert.equal(await pagingPage.getByLabel('目录分段', { exact: true }).inputValue(), '2');
    const rangeGate = holdCatalog('', 0);
    try {
      await pagingPage.getByLabel('目录分段', { exact: true }).selectOption('0'); await waitCatalogRequest(rangeGate); await finishCatalog(pagingPage, rangeGate);
      assert.deepEqual(await titles(pagingPage), [...catalogChapters].reverse().slice(0, 80).map(chapter => chapter.title));
      assert.equal(await pagingPage.getByLabel('目录分段', { exact: true }).inputValue(), '0');
    } finally { rangeGate.released.resolve(); }
    assert.deepEqual(await pagingPage.evaluate(() => __novelRenderProbe.detailRenders), []); assert.deepEqual(pagingPage.catalogErrors, []);
    pass('detail order changes retain the browser and return exact descending results');
  } finally { nextGate.released.resolve(); orderGate.released.resolve(); await pagingPage.close(); }

  const localPage = await newCatalogReader({ detail: true, local: true });
  try {
    await remember(localPage); const reads = requests.length; const input = localPage.locator('#novelDetailCatalog input');
    await input.click(); await localPage.keyboard.type('12', { delay: 100 }); retained(await inputState(localPage), '12');
    assert.deepEqual(await titles(localPage), expectedTitles('12')); assert.equal(requests.length, reads);
    assert.deepEqual(localPage.catalogErrors, []); pass('local detail actual keyboard filtering stays offline and retains input/caret');
  } finally { await localPage.close(); }

  const stalePage = await newCatalogReader({ detail: true });
  try {
    await remember(stalePage);
    await stalePage.evaluate(() => {
      __holdCatalogSearch = true;
      window.__staleDetailControls = [...document.querySelectorAll('#novelDetailCatalog input,#novelDetailCatalog button,#novelDetailCatalog select')];
    });
    await stalePage.locator('#novelDetailCatalog input').click(); await stalePage.keyboard.type('12');
    await stalePage.evaluate(() => { window.__staleDetailDebounce = __catalogSearchCallbacks.at(-1); });
    await stalePage.evaluate(id => __novelUiFixture.showView('novelDetail', { id }), catalogBook.id);
    const before = await stalePage.evaluate(() => ({ state: __novelDetailProbe.snapshot(), html: document.querySelector('#viewContent').innerHTML }));
    const reads = requests.length;
    await stalePage.evaluate(() => {
      for (const control of __staleDetailControls) {
        if (control.tagName === 'INPUT') { control.value = '999'; control.dispatchEvent(new Event('input', { bubbles: true })); }
        else if (control.tagName === 'SELECT') { control.value = '1'; control.dispatchEvent(new Event('change', { bubbles: true })); }
        else control.click();
      }
      __staleDetailDebounce();
    });
    await stalePage.evaluate(() => Promise.allSettled(__novelRenderProbe.catalogTasks)); await catalogFrames(stalePage);
    assert.deepEqual(await stalePage.evaluate(() => ({ state: __novelDetailProbe.snapshot(), html: document.querySelector('#viewContent').innerHTML })), before,
      'detached detail controls and old debounce cannot mutate or reload a newly opened same-book detail');
    assert.equal(requests.length, reads); assert.deepEqual(stalePage.catalogErrors, []);
    pass('detached detail controls and pending old debounce cannot affect a reopened same-book page');
  } finally { await stalePage.close(); }

  for (const error of ['', 'controlled detail late failure']) for (const change of ['route', 'source']) {
    const page = await newCatalogReader({ detail: true, ignoreAbort: true }), gate = holdCatalog(error, null, '7');
    try {
      await page.locator('#novelDetailCatalog input').click(); await page.keyboard.type('7'); await waitCatalogRequest(gate);
      if (change === 'route') await page.evaluate(() => __novelUiFixture.showView('novels'));
      else await page.evaluate(() => __novelUiFixture.setSourceUrl('http://different-fixture.invalid'));
      const before = await page.evaluate(() => ({ state: __novelDetailProbe.snapshot(), html: document.querySelector('#viewContent').innerHTML, scroll: scrollY }));
      await finishCatalog(page, gate);
      assert.deepEqual(await page.evaluate(() => ({ state: __novelDetailProbe.snapshot(), html: document.querySelector('#viewContent').innerHTML, scroll: scrollY })), before);
      assert.deepEqual(page.catalogErrors, []); pass(`late detail ${error ? 'failure' : 'success'} after ${change} switch cannot change current state or scroll`);
    } finally { gate.released.resolve(); await page.close(); }
  }

  const initialFailure = holdCatalog('controlled initial detail catalog failure'); initialFailure.released.resolve();
  const progressPage = await newCatalogReader({ detail: true, progressDetail: true }), recovered = holdCatalog('', null, '100');
  try {
    assert(initialFailure.used); assert.equal(await progressPage.locator('#novelDetailCatalog .novel-reader-catalog-loading.error').textContent(), initialFailure.error);
    assert.equal(await progressPage.locator('.novel-mobile-chapter-shortcut').first().locator('strong').textContent(), '100 · 第 100 章');
    await remember(progressPage); const posts = requests.filter(request => request.method === 'POST').length;
    const input = progressPage.locator('#novelDetailCatalog input'); await input.click(); await progressPage.keyboard.type('100'); await waitCatalogRequest(recovered);
    await finishCatalog(progressPage, recovered); retained(await inputState(progressPage), '100'); assert.deepEqual(await titles(progressPage), expectedTitles('100'));
    assert.equal(await progressPage.locator('.novel-mobile-chapter-shortcut').first().locator('strong').textContent(), '100 · 第100章 沿途风景');
    assert.equal(requests.filter(request => request.method === 'POST').length, posts, 'detail queries never write reading progress');
    pass('first catalog failure remains searchable and successful retry refreshes the progress chapter title without replacing the hero');
    await progressPage.locator('.novel-mobile-chapter-shortcut').first().click(); await progressPage.locator('.novel-reader-content').waitFor();
    const read = requests.findLast(request => request.path === `/api/novels/${catalogBook.id}/chapters/100`);
    assert.ok(read); const params = new URLSearchParams(read.query);
    assert.equal(params.get('chapterId'), 'chapter-100'); assert.equal(params.get('catalogRevision'), detailRevision); assert.equal(params.get('sourceRealm'), sourceRealm);
    assert.deepEqual(progressPage.catalogErrors, []); pass('retained progress shortcut opens the same verified chapter and catalog revision');
  } finally { initialFailure.released.resolve(); recovered.released.resolve(); await progressPage.close(); }

  const cacheFailure = holdCatalog('controlled full-cache catalog failure'); cacheFailure.released.resolve();
  const cachedPage = await newCatalogReader({ detail: true, cachedDetail: true });
  try {
    assert(cacheFailure.used); assert.equal(await cachedPage.locator('.novel-mobile-detail-body h1').textContent(), catalogBook.title,
      'fresh metadata still replaces the older cached title during the initial detail lifecycle');
    assert.equal(await cachedPage.evaluate(() => __novelDetailProbe.snapshot().remotePaged), false);
    assert.equal(await cachedPage.getByText('目录服务暂时不可用，当前显示完整缓存目录。', { exact: true }).count(), 1);
    await remember(cachedPage); const reads = requests.length; const input = cachedPage.locator('#novelDetailCatalog input');
    await input.click(); await cachedPage.keyboard.type('12', { delay: 100 }); retained(await inputState(cachedPage), '12');
    assert.deepEqual(await titles(cachedPage), expectedTitles('12')); assert.equal(requests.length, reads);
    assert.deepEqual(cachedPage.catalogErrors, []); pass('complete cached detail fallback keeps every source row, fresh metadata and offline filtering');
  } finally { cacheFailure.released.resolve(); await cachedPage.close(); }
  console.log(`PASS Android novel detail catalog reuse: ${checks} actual Chromium scenarios`);
}

async function verifyReaderEventOwnership() {
  let checks = 0;
  const pass = name => { checks++; console.log(`PASS ${name}`); };
  const settle = async page => {
    // A rerender first restores its scroll in RAF, then schedules its own save.
    // Drain that current-reader work before comparing obsolete event delivery.
    await catalogFrames(page);
    await page.waitForFunction(() => !__novelMenuProbe.snapshot().progressPending, null, { timeout: 10000 });
    await catalogFrames(page);
    await page.waitForFunction(() => !__novelMenuProbe.snapshot().progressPending, null, { timeout: 10000 });
  };
  const capture = page => page.evaluate(() => ({ state: __novelMenuProbe.snapshot(), html: document.querySelector('#viewContent').innerHTML,
    view: document.querySelector('#contentPanel').dataset.view, scroll: scrollY, native: __novelNativeCalls.slice(),
    slider: document.querySelector('[data-novel-chapter-slider]')?.value,
    progressText: document.querySelector('[data-novel-progress-summary]')?.textContent }));
  const remember = page => page.evaluate(() => {
    window.__obsoleteReaderNodes = { screen: document.querySelector('.novel-reader-screen'),
      paragraph: document.querySelector('.novel-reader-content p'), content: document.querySelector('.novel-reader-content'),
      back: document.querySelector('.novel-reader-back') };
  });
  const page = await newCatalogReader({ readingMode: 'scroll' });
  try {
    await page.waitForFunction(() => !__novelMenuProbe.snapshot().progressPending);
    await page.evaluate(() => {
      window.__oldReaderSurface = document.querySelector('.novel-reader-screen');
      window.__oldReaderParagraph = document.querySelector('.novel-reader-content p');
    });
    await page.evaluate(id => __novelUiFixture.showView('novelReader', { id, chapterIndex: '2' }), catalogBook.id);
    await page.locator('.novel-reader-content p').nth(10).click();
    await page.waitForFunction(() => !__novelMenuProbe.snapshot().progressPending); await catalogFrames(page);
    const before = await page.evaluate(() => __novelMenuProbe.snapshot());
    assert.equal(before.menu, true); assert.equal(before.chapterIndex, 2);
    assert.equal(await page.evaluate(() => __oldReaderSurface.isConnected), false);
    await page.evaluate(() => __oldReaderParagraph.click()); await catalogFrames(page);
    const after = await page.evaluate(() => __novelMenuProbe.snapshot());
    console.log(JSON.stringify({ oldReaderClick: { beforeMenu: before.menu, afterMenu: after.menu, chapter: after.chapterIndex } }));
    assert.deepEqual(after, before, 'a detached chapter body click cannot change the current reader state');
    assert.deepEqual(page.catalogErrors, []);
    pass('old reader body event keeps the current chapter and menu state');
  } finally { await page.close(); }
  for (const mode of ['scroll', 'page']) for (const local of [false, true]) for (const change of ['rerender', 'chapter']) {
    const page = await newCatalogReader({ readingMode: mode, local });
    try {
      await settle(page); await remember(page);
      if (change === 'rerender') await page.evaluate(() => __novelMenuProbe.rerender());
      else await page.evaluate(id => __novelUiFixture.showView('novelReader', { id, chapterIndex: '2' }), local ? 'local:catalog-fixture' : catalogBook.id);
      await settle(page);
      assert.equal(await page.evaluate(() => __obsoleteReaderNodes.screen.isConnected), false);
      const before = await capture(page), reads = requests.length;
      await page.evaluate(() => { __holdReaderProgress = true; });
      for (const event of ['click', 'back', 'scroll']) {
        await page.evaluate(kind => {
          if (kind === 'click') __obsoleteReaderNodes.paragraph.click();
          else if (kind === 'back') __obsoleteReaderNodes.back.click();
          else __obsoleteReaderNodes.content.dispatchEvent(new Event('scroll'));
        }, event);
        await catalogFrames(page);
        assert.deepEqual(await capture(page), before, `obsolete ${event} after ${change} cannot change the entire new reader state, DOM, position or native calls`);
        assert.equal(requests.length, reads);
      }
      assert.deepEqual(page.catalogErrors, []); pass(`${mode} ${local ? 'local' : 'remote'} ${change} fences old body/back/scroll callbacks`);
    } finally { await page.close(); }
  }
  for (const mode of ['scroll', 'page']) for (const change of ['abort', 'source']) {
    const page = await newCatalogReader({ readingMode: mode });
    try {
      await settle(page); await remember(page);
      await page.evaluate(kind => {
        __holdReaderProgress = true;
        if (kind === 'abort') __novelUiFixture.invalidate();
        else __novelUiFixture.setSourceUrl('http://inactive-fixture.invalid');
      }, change);
      const before = await capture(page), reads = requests.length;
      for (const event of ['click', 'back', 'scroll']) {
        await page.evaluate(kind => {
          if (kind === 'click') __obsoleteReaderNodes.paragraph.click();
          else if (kind === 'back') __obsoleteReaderNodes.back.click();
          else __obsoleteReaderNodes.content.dispatchEvent(new Event('scroll'));
        }, event);
        await catalogFrames(page); assert.deepEqual(await capture(page), before, `${change} expired surface ${event} is inactive`); assert.equal(requests.length, reads);
      }
      pass(`${mode} ${change} blocks still-mounted body/back/content events`);
      await page.evaluate(() => window.dispatchEvent(new Event('scroll'))); await catalogFrames(page);
      assert.deepEqual(await capture(page), before, 'the actual global scroll listener cannot schedule UI or progress work for an expired owner');
      assert.equal(requests.length, reads); assert.deepEqual(page.catalogErrors, []); pass(`${mode} ${change} global scroll queues no expired-reader work`);
    } finally { await page.close(); }
  }
  for (const change of ['abort', 'source']) {
    const page = await newCatalogReader({ readingMode: 'scroll' });
    try {
      await settleMenuProgress(page, .42); await remember(page);
      const callbacks = await page.evaluate(() => __readerProgressCallbacks.length);
      await page.evaluate(() => {
        __holdReaderProgress = true; __holdOverlayFrames();
        const screen = document.querySelector('.novel-reader-screen');
        scrollTo(0, screen.getBoundingClientRect().top + scrollY + (screen.scrollHeight - innerHeight) * .67);
      });
      await page.waitForFunction(count => __readerProgressCallbacks.length > count, callbacks, { polling: 20 });
      await page.evaluate(kind => { if (kind === 'abort') __novelUiFixture.invalidate(); else __novelUiFixture.setSourceUrl('http://inactive-fixture.invalid'); }, change);
      const before = await capture(page), reads = requests.length;
      assert.equal(before.state.progressPending, true);
      await page.evaluate(() => { __releaseOverlayFrames(); __readerProgressCallbacks.at(-1).run(); }); await catalogFrames(page);
      const after = await capture(page); before.state.progressPending = false;
      assert.deepEqual(after, before, 'previously queued scroll frame/debounce cannot update expired UI, current progress or original service data');
      assert.equal(requests.length, reads); assert.deepEqual(page.catalogErrors, []);
      pass(`${change} after actual scroll delivery retires its frame/timer and sends zero stale progress writes`);
    } finally { await page.close(); }
  }
  const cancelledPage = await newCatalogReader({ readingMode: 'scroll' });
  try {
    await settleMenuProgress(cancelledPage, .42);
    await cancelledPage.evaluate(() => { __holdReaderProgress = true; window.dispatchEvent(new Event('scroll')); });
    await catalogFrames(cancelledPage);
    await cancelledPage.evaluate(() => {
      window.__cancelledProgress = __readerProgressCallbacks.at(-1);
      const screen = document.querySelector('.novel-reader-screen');
      scrollTo(0, screen.getBoundingClientRect().top + scrollY + (screen.scrollHeight - innerHeight) * .67);
      window.dispatchEvent(new Event('scroll'));
    }); await catalogFrames(cancelledPage);
    const before = await capture(cancelledPage), reads = requests.length;
    assert.equal(before.state.progressPending, true);
    await cancelledPage.evaluate(() => __cancelledProgress.run()); await catalogFrames(cancelledPage);
    assert.deepEqual(await capture(cancelledPage), before, 'a cancelled earlier debounce cannot clear or save through the newer scheduled progress owner');
    assert.equal(requests.length, reads);
    await cancelledPage.evaluate(() => __readerProgressCallbacks.at(-1).run()); await settle(cancelledPage);
    const after = await capture(cancelledPage);
    assert.equal(after.state.progressPending, false); assert(Math.abs(after.state.progress.scrollRatio - .67) < .005);
    assert.equal(requests.length, reads + 1); assert.deepEqual(cancelledPage.catalogErrors, []);
    pass('cancelled debounce cannot consume its replacement; the newest real position is still saved exactly once');
  } finally { await cancelledPage.close(); }
  for (const local of [false, true]) {
    const page = await newCatalogReader({ readingMode: 'scroll', local });
    try {
      await settleMenuProgress(page, .42);
      await page.evaluate(() => {
        __holdReaderProgress = true;
        const screen = document.querySelector('.novel-reader-screen');
        scrollTo(0, screen.getBoundingClientRect().top + scrollY + (screen.scrollHeight - innerHeight) * .67);
        window.dispatchEvent(new Event('scroll'));
      }); await catalogFrames(page);
      const reads = requests.filter(request => request.method === 'POST').length;
      await page.locator('.novel-reader-back').click(); await page.locator('.novel-mobile-book-detail').first().waitFor();
      await page.waitForFunction(() => !__novelMenuProbe.snapshot().progressPending);
      const saved = await storedMenuProgress(page, local);
      assert(Math.abs(saved.scrollRatio - .67) < .005, 'normal navigation retains the final actual position even after the route is invalidated');
      if (local) assert.equal(requests.filter(request => request.method === 'POST').length, reads);
      else assert.equal(requests.filter(request => request.method === 'POST').length, reads + 1);
      assert.deepEqual(page.catalogErrors, []); pass(`${local ? 'local' : 'remote'} normal back navigation still flushes the final pending position`);
    } finally { await page.close(); }
  }
  console.log(`PASS Android novel reader event ownership: ${checks} actual Chromium scenarios`);
}
