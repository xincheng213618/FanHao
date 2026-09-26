import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Isolated synthetic API and browser profile. Never connects to the user's library.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = path.join(root, "android-client/www");
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
const requests = [];
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://fixture");
  response.setHeader("Cache-Control", "no-store");
  if (url.pathname.startsWith("/api/")) {
    requests.push({ method: request.method, path: url.pathname });
    let payload = {};
    if (url.pathname === "/api/novels") {
      const query = url.searchParams.get("q") || "";
      const matching = books.filter((item) => !query || item.title.includes(query));
      payload = { books: matching, total: matching.length, sourceRealm, facets: [{ name: "旅行随笔", count: books.length }] };
    } else if (url.pathname.endsWith("/catalog")) {
      const query = url.searchParams.get("q") || "";
      const matching = chapters.filter((item) => !query || item.title.includes(query));
      const offset = Number(url.searchParams.get("offset") || 0);
      payload = { book, sourceRealm, chapters: matching.slice(offset, offset + 80), total: chapters.length, filteredTotal: matching.length, offset };
    } else if (url.pathname.includes("/chapters/")) {
      const index = Number(url.pathname.split("/").at(-1)) - 1;
      payload = { book, sourceRealm, chapter: chapters[index], prev: chapters[index - 1] || null, next: chapters[index + 1] || null };
    } else if (url.pathname.endsWith("/progress")) {
      payload = { ok: true, sourceRealm };
    } else if (url.pathname.startsWith("/api/novels/")) {
      payload = { book, sourceRealm, chapters: [] };
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
      let view = 'novels', params = {}, generation = 0;
      const module = createAndroidModule({ host: { els, getActiveUrl: () => location.origin,
        navigation: { showView, goBack: () => showView('novels'), hasBackStack: () => true },
        ui: { setActiveBottom() {}, setStatus() {}, renderCurrentView: () => showView(view, params), renderCurrentViewPreservingScroll: () => showView(view, params), scrollToTop: () => scrollTo(0, 0), refreshChrome } } });
      function refreshChrome() { chrome.innerHTML = ''; chrome.hidden = !module.renderChrome({ container: chrome, view }); }
      async function showView(next, nextParams = {}) {
        view = next; params = nextParams; const current = ++generation;
        panel.dataset.view = view; els.viewContent.className = 'content-list';
        document.body.classList.toggle('novel-reader-view', view === 'novelReader');
        document.body.classList.toggle('novel-search-page-view', view === 'novelSearch');
        document.getElementById('viewBack').hidden = view === 'novels';
        refreshChrome(); scrollTo(0, 0);
        await module.routes.find(route => route.view === view).render(params, () => generation === current);
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
  fs.createReadStream(target).pipe(response);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(value => value && fs.existsSync(value));
const browser = await chromium.launch({ executablePath, headless: true });
const artifactDir = process.env.FANHAO_MOBILE_UI_ARTIFACTS;
if (artifactDir) fs.mkdirSync(artifactDir, { recursive: true });
try {
  for (const scenario of ["slow-success", "failure-retry", "leave-pending"]) {
    const page = await browser.newPage({ viewport: { width: 400, height: 820 }, isMobile: true, hasTouch: true });
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
  for (const width of [320, 400]) {
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
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
