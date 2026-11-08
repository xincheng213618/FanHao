import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { photoCatalogCollections } from "../public/modules/content-index/photo-catalog.js";
import { sendJson as sendCatalogJson } from "../src/platform/server/responses.js";

// Actual Web host/modules and Chromium; all API responses/images are synthetic.
// Ignoring AbortSignal deliberately proves ownership independently of transport.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(root, "public");
export async function runGalleryReaderFixture({ timings = false, legacy = false, legacyHost = false, sourceOverrides = {}, casePattern = "" } = {}) {
  const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean).find(value => fs.existsSync(value));
  assert(executablePath, "Chrome or Edge required for the private browser fixture");
  const overrides = new Map(sourceOverrides instanceof Map ? sourceOverrides : Object.entries(sourceOverrides)), held = new Set(), requests = new Map(), faults = [];
  const apiMethods = [];
  if (legacy) for (const file of ["gallery-page.js", "gallery-renderer.js"]) {
    const relative = `public/modules/content-index/${file}`;
    const result = spawnSync("git", ["show", `HEAD:${relative}`], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); overrides.set(`/${relative.slice(7)}`, result.stdout);
  }
  if (legacyHost) {
    const result = spawnSync("git", ["show", "HEAD:public/js/standalone-host.js"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); overrides.set("/js/standalone-host.js", result.stdout);
  }
  let browser = null, checks = 0, fullscreenDenied = false, collectionShelf = null;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture"), key = `${url.pathname}${url.search}`;
    requests.set(key, (requests.get(key) || 0) + 1);
    if (url.pathname.startsWith('/api/')) apiMethods.push({ method: req.method, url: key });
    if (fullscreenDenied) res.setHeader('Permissions-Policy', 'fullscreen=()');
    try {
      const gate = [...held].find(value => !value.used && value.match(url, req.method));
      if (gate) {
        gate.used = true; gate.url = key; res.once("close", () => { gate.closed = true; });
        gate.requestedResolve(); await gate.promise;
        if (gate.error) { sendJson(res, { error: gate.error }, 503); return; }
        if (gate.body !== null) { sendJson(res, gate.body); return; }
      }
      if (url.pathname === "/probe") { sendText(res, harness(), "text/html; charset=utf-8"); return; }
      const albumMatch = /^\/api\/photo-sets\/([^/]+)$/.exec(url.pathname);
      if (albumMatch) {
        const offset = Number(url.searchParams.get("imageOffset") || 0);
        const limit = url.searchParams.get("imageLimit") === "all" ? 10000 : Number(url.searchParams.get("imageLimit") || 160);
        sendJson(res, { album: album(albumMatch[1], offset, limit), cache: null }); return;
      }
      const chapterMatch = /^\/api\/manga\/([^/]+)\/chapters\/([^/]+)$/.exec(url.pathname);
      if (chapterMatch) {
        const comic = manga(chapterMatch[1]), index = Number(chapterMatch[2]);
        sendJson(res, { comic, chapter: { index, title: `Chapter ${index}`, imageCount: 3, images: album(`C-${index}`, 0, 3).images } }); return;
      }
      const comicMatch = /^\/api\/manga\/([^/]+)$/.exec(url.pathname);
      if (comicMatch) { sendJson(res, { comic: manga(comicMatch[1]) }); return; }
      if (url.pathname === "/api/manga") { sendJson(res, { comics: [manga("C")] }); return; }
      const mediaMatch = /^\/api\/gallery-media\/([^/]+)$/.exec(url.pathname);
      if (mediaMatch) { sendJson(res, { item: { id: mediaMatch[1], title: `Media ${mediaMatch[1]}`, mediaKind: mediaMatch[1] === "Movie" ? "movie" : "western", streamUrl: "" } }); return; }
      if (url.pathname === "/api/image-library/items") {
        if (collectionShelf) sendCatalogJson(res, 200, collectionShelf(url));
        else sendJson(res, { items: [listItem("A"), listItem("B")], count: 2, total: 2, facets: {} });
        return;
      }
      if (url.pathname === "/api/modules") { sendJson(res, { product: { id: "suite" }, modules: [] }); return; }
      if (url.pathname === "/api/image-library/summary") { sendJson(res, { totals: { photoSets: 2, manga: 1 }, facets: {}, scannedAt: "synthetic", cache: null }); return; }
      if (url.pathname.startsWith("/synthetic/")) {
        sendText(res, '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><rect width="800" height="1000" fill="#729b7c"/></svg>', "image/svg+xml", "public, max-age=86400"); return;
      }
      const target = url.pathname === "/photo/maintenance" ? path.join(publicRoot, "modules/photos/maintenance/index.html")
        : /^\/(?:photo|manga|media|western)(?:\/|$)/.test(url.pathname) ? path.join(publicRoot, "index.html")
          : path.resolve(publicRoot, url.pathname.replace(/^\/+/, ""));
      assert(target.startsWith(`${publicRoot}${path.sep}`));
      sendText(res, overrides.get(url.pathname) ?? await fs.promises.readFile(target), target.endsWith(".html") ? "text/html; charset=utf-8" : target.endsWith(".js") ? "text/javascript" : "text/css");
    } catch (error) { if (!res.destroyed) { res.writeHead(500); res.end(error.message); } }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const run = async (name, task) => { if (casePattern && !name.includes(casePattern)) return; await task(); checks++; console.log(`PASS ${name}`); };
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    await run('photo cover warm progress can pause and resume in standalone maintenance', async () => {
      const page = await browser.newPage();
      const actions = [];
      let status = "running", done = 3;
      const draining = Promise.withResolvers();
      try {
        await page.route(/\/api\/photo-cover-warm(?:\/(?:pause|resume))?$/, async route => {
          const pathname = new URL(route.request().url()).pathname;
          if (route.request().method() === "POST") {
            const action = pathname.split("/").at(-1);
            actions.push(action);
            status = action === "pause" ? "pausing" : "running";
          } else if (status === "pausing") {
            await draining.promise;
            status = "paused";
            done++;
          }
          await route.fulfill({ json: {
            status, total: 10, done, remaining: 10 - done, collectionCount: 2,
            counts: { cached: 2, generated: done - 2, skipped: 0, missing: 0, failed: 0 },
            collection: { title: "测试合集", index: 1, done, total: 5 }
          } });
        });
        await page.route('**/api/photo-maintenance/index', route => route.fulfill({ json: {
          task: route.request().method() === "POST" ? {
            status: "running", logs: ['IMAGE_LIBRARY_PROGRESS {"percent":5,"message":"正在准备扫描"}']
          } : null
        } }));
        await page.goto(`${base}/photo`, { waitUntil: "domcontentloaded" });
        const link = page.getByRole("link", { name: "图库维护" });
        await link.waitFor();
        const panel = page.getByRole("region", { name: "图片封面预热" });
        assert.equal(await panel.count(), 0);
        assert.equal(apiMethods.some(item => item.url === "/api/photo-cover-warm"), false);
        await link.click();
        await page.waitForURL(`${base}/photo/maintenance`);
        await panel.getByText(/合集 1\/2 · 测试合集/).waitFor();
        assert.equal(await panel.getByRole("progressbar").getAttribute("value"), "3");
        await panel.getByRole("button", { name: "暂停", exact: true }).click();
        const pausing = panel.getByRole("button", { name: "正在暂停…" });
        await pausing.waitFor({ timeout: 5000 });
        assert.equal(await pausing.isDisabled(), true);
        draining.resolve();
        await panel.getByText(/已处理 4 \/ 10 · 剩余 6/).waitFor();
        await panel.getByRole("button", { name: "继续", exact: true }).click();
        await panel.getByRole("button", { name: "暂停", exact: true }).waitFor();
        assert.deepEqual(actions, ["pause", "resume"]);
        await page.getByRole("button", { name: "刷新套图索引" }).click();
        await page.getByText("正在刷新 · 正在准备扫描").waitFor();
        assert.equal(await page.getByRole("progressbar", { name: "套图索引刷新进度" }).getAttribute("value"), "5");
      } finally {
        draining.resolve();
        await page.close();
      }
    });
    await run('photo cold overview delivery overlaps renderer download', async () => {
      collectionShelf = collectionShelfFixture(12);
      const rendererPath = '/modules/content-index/gallery-renderer.js', summaryPath = '/api/image-library/summary';
      const renderer = hold(url => url.pathname === rendererPath), summary = hold(isSummary), delay = 300;
      const itemPath = '/api/image-library/items', before = apiMethods.length;
      for (const gate of [renderer, summary]) gate.requested.then(() => setTimeout(gate.release, delay));
      const page = await newPage({ real: true, route: '/photo?sort=title', waitReady: false });
      try {
        const visibleAt = await (await page.waitForFunction(() => {
          const card = document.querySelector('.gallery-collection-card');
          if (!card || getComputedStyle(card).visibility !== 'visible') return null;
          const rect = card.getBoundingClientRect();
          return rect.bottom > 0 && rect.top < innerHeight ? performance.now() : null;
        })).jsonValue();
        const timings = await page.evaluate(({ rendererPath, summaryPath, itemPath, visibleAt }) => {
          const resources = performance.getEntriesByType('resource');
          const read = path => resources.find(entry => new URL(entry.name).pathname === path);
          const renderer = read(rendererPath), summary = read(summaryPath), items = read(itemPath), start = renderer.startTime;
          return { rendererEndMs: Math.round(renderer.responseEnd - start), summaryStartMs: Math.round(summary.startTime - start),
            summaryEndMs: Math.round(summary.responseEnd - start), itemsStartMs: Math.round(items.startTime - start), firstCardMs: Math.round(visibleAt - start) };
        }, { rendererPath, summaryPath, itemPath, visibleAt });
        const reads = apiMethods.slice(before).filter(item => item.url.startsWith('/api/image-library/'));
        console.log('MEASURE photo cold overview', JSON.stringify({ delay, ...timings, reads }));
        assert.equal(await page.locator('.gallery-collection-card').count(), 12);
        assert.deepEqual(reads.map(item => [item.method, new URL(item.url, base).pathname]), [['GET', summaryPath], ['GET', itemPath]]);
        assert.equal(reads[0].url, `${summaryPath}?mode=photo`);
        assert(timings.itemsStartMs >= timings.summaryEndMs, 'list I/O still requires a successful overview');
        assert(timings.summaryStartMs < timings.rendererEndMs, 'the cold overview must begin before renderer delivery completes');
      } finally { releaseSummaryGates(renderer, summary); collectionShelf = null; await page.close(); }
    });
    await run('photo collection cards are usable while covers are pending', async () => {
      const shelf = collectionShelfFixture(80);
      collectionShelf = url => {
        const payload = shelf(url);
        for (const item of payload.items) item.coverUrl = `/media/gallery-cover/${encodeURIComponent(item.id)}?v=fixture`;
        return payload;
      };
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      const coverRequests = new Set();
      let release;
      const coversPending = new Promise(resolve => { release = resolve; });
      try {
        await page.route('**/media/gallery-cover/**', async route => {
          coverRequests.add(route.request().url());
          await coversPending;
          await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' });
        });
        await page.goto(`${base}/photo/collections?category=Category+1&sort=title`, { waitUntil: 'domcontentloaded' });
        const cards = page.locator('.gallery-collection-card');
        await cards.first().waitFor({ state: 'visible' });
        await until(() => coverRequests.size > 0, 'viewport covers must start loading');
        assert.equal(await cards.count(), 8);
        assert.equal(await cards.first().locator('.gallery-card-cover').evaluate(cover => getComputedStyle(cover).aspectRatio), '2 / 3');
        const firstCover = cards.first().locator('img');
        assert.equal(await firstCover.getAttribute('decoding'), 'async');
        assert.equal(await firstCover.evaluate(img => img.complete), false);
        assert([...coverRequests].every(url => {
          const params = new URL(url).searchParams;
          return params.get('fallback') === '1' && params.get('v') === 'fixture';
        }));
        await cards.first().click();
        await page.waitForURL(url => url.pathname.startsWith('/photo/collection/'));
      } finally { release(); collectionShelf = null; await page.close(); }
    });
    for (const publisher of [{ id: 'bololi', name: '菠萝社', code: 'BoLoli' }, null]) {
      await run(`photo collection detail paints metadata before overview and covers with ${publisher ? 'publisher' : 'category'} breadcrumb`, async () => {
        const category = '[XIUREN] 秀人网';
        const previewTitle = 'NO.010 目录合集';
        const title = '合成详情合集';
        const collection = `V:\\图库卷|${category}/${previewTitle}`;
        const categoryValue = publisher ? 'publisher:bololi' : category;
        const isItems = url => url.pathname === '/api/image-library/items';
        const overview = hold(isSummary);
        const detail = hold(url => isItems(url) && url.searchParams.get('collection') === collection, '', {
          items: [
            { ...listItem('detail-pending'), title: '封面加载中的套图', albumSubject: '封面加载中的套图', personName: '合成人物', archiveDate: '2026-10-05', size: 2048,
              coverUrl: '/media/gallery-cover/detail-pending?v=fixture' },
            { ...listItem('detail-missing'), title: '没有封面的套图', coverUrl: '/media/gallery-cover/detail-missing?v=fixture' }
          ],
          count: 2, total: 2, facets: {},
          collectionSummary: { title, category, publisher, rootLabel: 'V:\\图库卷', largeCategoryTitle: `V:\\图库卷 / ${category}`, count: 2, size: 4096, imageCount: 20000 }
        });
        const parent = hold(url => isItems(url) && url.searchParams.get('category') === categoryValue && !url.searchParams.has('collection'));
        const page = await newPage({ real: true, route: `/photo/collection/${encodeURIComponent(collection)}`, waitReady: false });
        const coverRequests = new Map();
        let releaseCovers;
        const coversPending = new Promise(resolve => { releaseCovers = resolve; });
        try {
          await page.route('**/media/gallery-cover/detail-*', async route => {
            const url = new URL(route.request().url());
            coverRequests.set(url.pathname, url.searchParams);
            await coversPending;
            if (url.pathname.endsWith('/detail-missing')) await route.fulfill({ status: 204 });
            else await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' });
          });
          await Promise.all([requested(overview), requested(detail)]);
          const heading = page.locator('.gallery-collection-hero-copy > strong');
          const breadcrumb = page.locator('.gallery-collection-breadcrumb');
          await heading.waitFor({ state: 'visible' });
          assert.equal(await heading.innerText(), previewTitle);
          assert.deepEqual(await breadcrumb.locator('button').allTextContents(), ['图库', '秀人网']);
          assert.equal(await breadcrumb.locator('strong').innerText(), previewTitle);
          assert.doesNotMatch(await breadcrumb.innerText(), /V:|图库卷/);
          assert.equal(overview.closed, false, 'detail request starts while overview remains pending');

          await settle(page, detail);
          const pending = page.locator('[data-gallery-album-id="detail-pending"]');
          const missing = page.locator('[data-gallery-album-id="detail-missing"]');
          await pending.waitFor({ state: 'visible' });
          await until(() => coverRequests.size === 2, 'both visible covers must start without waiting for either response');
          assert.equal(await heading.innerText(), title);
          assert.match(await page.locator('.gallery-collection-hero-copy').innerText(), /2 期.*4\.00 KB.*20,000 张/);
          assert.match(await pending.locator('..').innerText(), /封面加载中的套图[\s\S]*合成人物[\s\S]*2026-10-05/);
          assert.equal(await pending.locator('img').evaluate(img => img.complete), false);
          assert.equal(await missing.locator('img').evaluate(img => img.complete), false);
          assert([...coverRequests.values()].every(params => params.get('fallback') === 'empty' && params.get('v') === 'fixture'));
          assert.deepEqual(await breadcrumb.locator('button').allTextContents(), ['图库', publisher?.name || '秀人网']);
          assert.equal(await breadcrumb.locator('strong').innerText(), title);
          assert.doesNotMatch(await breadcrumb.innerText(), /V:|图库卷/);
          assert.equal(overview.closed, false, 'the detail and card metadata render with the overview held');
          if (publisher) {
            await pending.locator('img').evaluate(img => { window.__collectionCover = img; });
            await settle(page, overview);
            assert(await pending.locator('img').evaluate(img => img === window.__collectionCover && !img.complete),
              'the late overview keeps the live card and its pending cover');
          }

          releaseCovers();
          await missing.locator('img').waitFor({ state: 'detached' });
          assert.equal(await missing.locator('.gallery-card-body strong').innerText(), '没有封面的套图');
          assert.match(await missing.locator('.gallery-card-cover').evaluate(cover => getComputedStyle(cover, '::after').content), /^(?:none|normal|"")$/);

          await breadcrumb.getByRole('button', { name: publisher?.name || '秀人网' }).click();
          await page.waitForURL(url => url.pathname === (publisher ? '/photo/categories/bololi' : '/photo/categories/xiuren'));
          if (!publisher) await settle(page, overview);
          await requested(parent);
          assert.equal(new URL(parent.url, base).searchParams.get('category'), categoryValue);
        } finally { releaseCovers(); releaseSummaryGates(overview, detail, parent); await page.close(); }
      });
    }
    await run('photo direct category shows card counts while overview and cover are pending', async () => {
      const path = '/photo/categories/yituyu';
      const overview = hold(isSummary);
      const category = hold(url => url.pathname === '/api/image-library/items' && url.searchParams.get('category') === 'catalog:yituyu', '', {
        categoryDirect: true,
        collectionSummary: {
          title: '艺图语', count: 3,
          browseCategory: { id: 'yituyu', name: '艺图语' },
          browseParent: { id: 'sites', name: '名站套图' }
        },
        items: [{ ...listItem('yituyu-fixture'), title: '[YITUYU艺图语] VOL.2754 冷暖光影[23P／85.5MB]',
          albumNumber: 'VOL.2754', albumSubject: '冷暖光影', personName: '夏铃蔓', archiveDate: '2026-10-05', size: 89_653_248,
          contentImageCount: 23, coverUrl: '/media/gallery-cover/yituyu-fixture?v=fixture' },
        { ...listItem('yituyu-fixture-late'), title: '样例人物', personName: '样例人物', archiveDate: '2026-10-04',
          coverUrl: '/media/gallery-cover/yituyu-fixture-late?v=fixture' },
        { ...listItem('yituyu-fixture-no-date'), title: '无编号与日期', coverUrl: '' }],
        count: 3, total: 3, facets: {}
      });
      const lateCount = hold(url => url.pathname === '/api/image-library/photo-card-counts'
        && url.searchParams.getAll('ids').includes('yituyu-fixture-late'), '', { counts: { 'yituyu-fixture-late': 17 } });
      const page = await newPage({ real: true, route: path, waitReady: false });
      let coverStarted = false, releaseCover;
      const coverPending = new Promise(resolve => { releaseCover = resolve; });
      try {
        await page.route('**/media/gallery-cover/yituyu-fixture*', async route => {
          coverStarted = true;
          await coverPending;
          await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' });
        });
        await Promise.all([requested(overview), requested(category)]);
        await settle(page, category);

        const heading = page.locator('.gallery-collection-hero-copy > strong');
        const card = page.locator('[data-gallery-album-id="yituyu-fixture"]');
        await heading.waitFor({ state: 'visible' });
        await card.waitFor({ state: 'visible' });
        await until(() => coverStarted, 'the category cover must start without waiting for the overview');
        assert.equal(await heading.innerText(), '艺图语');
        assert.deepEqual(await page.locator('.gallery-collection-breadcrumb button').allTextContents(), ['图库', '名站套图']);
        const body = card.locator('.gallery-card-body');
        const metadata = card.locator('..').locator('.gallery-card-date-row');
        assert.equal(await body.locator('strong').innerText(), '冷暖光影');
        assert.equal(await metadata.locator('time').innerText(), '2026-10-05');
        await metadata.getByRole('link', { name: '查看人物 夏铃蔓 的套图' }).waitFor();
        assert.doesNotMatch(`${await body.innerText()} ${await metadata.innerText()}`, /MB|VOL\.2754/);
        assert.equal(await body.locator('strong').evaluate(node => getComputedStyle(node).textAlign), 'center');
        const issue = card.getByText('VOL.2754', { exact: true });
        const count = card.getByRole('img', { name: '23 张图片' });
        assert(await issue.isVisible() && await count.isVisible(), 'the issue and image count show while the cover is pending');
        assert.equal(await count.innerText(), '23');
        assert.equal(await count.locator('svg[aria-hidden="true"]').count(), 1);
        const coverBox = await card.locator('.gallery-card-cover').boundingBox();
        const countBox = await count.boundingBox();
        assert.equal(countBox.x + countBox.width, coverBox.x + coverBox.width);
        assert.equal(countBox.y + countBox.height, coverBox.y + coverBox.height);
        assert.equal(await count.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0.56)');
        assert.equal(await card.locator('img').evaluate(img => img.complete), false);
        assert.equal(overview.closed, false);
        assert.equal(await page.evaluate(url => __transport.settled.some(item => item.url === url), overview.url), false);
        assert.equal(page.url(), `${base}${path}`);
        const lateCard = page.locator('[data-gallery-album-id="yituyu-fixture-late"]');
        assert.equal(await lateCard.locator('.gallery-card-leading-badge').innerText(), '2026-10-04');
        assert.equal(await lateCard.locator('.gallery-card-badges span').count(), 1);
        assert.equal(await lateCard.locator('.gallery-photo-image-count').count(), 0);
        assert.equal(await page.locator('[data-gallery-album-id="yituyu-fixture-no-date"] .gallery-card-leading-badge').count(), 0);
        assert.equal(await lateCard.locator('.gallery-card-date-row').innerText(), '2026-10-04');
        releaseCover();
        await requested(lateCount);
        await settle(page, lateCount);
        const lateBadge = lateCard.getByRole('img', { name: '17 张图片' });
        await lateBadge.waitFor({ state: 'visible' });
        assert.equal(await lateBadge.innerText(), '17');
        assert.equal(await lateBadge.getAttribute('class'), await count.getAttribute('class'));
      } finally { releaseCover(); releaseSummaryGates(overview, category, lateCount); await page.close(); }
    });
    await run('photo card special mark toggles without opening the album', async () => {
      const isMark = (url, method) => url.pathname === '/api/photo-sets/A/mark' && method === 'PUT';
      const save = hold(isMark, '', { id: 'A', markedA: true });
      const remove = hold(isMark, '', { id: 'A', markedA: false });
      const page = await newPage({ real: true, route: '/photo/albums' });
      try {
        const card = page.locator('[data-gallery-album-id="A"]');
        const mark = page.locator('.gallery-photo-mark[data-photo-mark-id="A"]');
        await card.hover();
        await mark.click();
        await requested(save);
        await settle(page, save);
        assert.equal(await mark.getAttribute('aria-pressed'), 'true');
        assert.equal(new URL(page.url()).pathname, '/photo/albums');
        await mark.click();
        await requested(remove);
        await settle(page, remove);
        assert.equal(await mark.getAttribute('aria-pressed'), 'false');
      } finally { releaseSummaryGates(save, remove); await page.close(); }
    });
    await run('photo metadata links filter albums and reveal opens the current archive', async () => {
      const items = [
        { ...listItem('A'), photoSite: 'MetArt', personName: 'Jeff Milton', photoRegion: 'western', archiveDate: '2019-12-18' },
        { ...listItem('B'), photoSite: 'MetArtX', personName: 'Dakota Pink', photoRegion: 'western', archiveDate: '2019-01-18' }
      ];
      collectionShelf = url => {
        const site = url.searchParams.get('site'), person = url.searchParams.get('person');
        const matches = items.filter(item => (!site || item.photoSite === site) && (!person || item.personName === person));
        return { items: matches, count: matches.length, total: matches.length, facets: {} };
      };
      const reveal = hold((url, method) => url.pathname === '/api/photo-sets/A/reveal' && method === 'POST', '', { ok: true });
      const page = await newPage({ real: true, route: '/photo/albums' });
      try {
        const site = page.getByRole('link', { name: '查看网站 MetArt 的套图', exact: true });
        await site.waitFor();
        assert.equal(await site.evaluate(link => Boolean(link.closest('button'))), false);
        await site.click();
        await page.getByRole('heading', { name: 'MetArt · 套图' }).waitFor();
        assert.equal(new URL(page.url()).searchParams.get('site'), 'MetArt');
        assert.equal(await page.locator('[data-gallery-album-id="B"]').count(), 0);
        await page.getByRole('link', { name: '查看人物 Jeff Milton 的套图' }).click();
        await page.locator('.gallery-person-bar').getByText('Jeff Milton').waitFor();
        assert(apiMethods.some(({ url }) => new URL(url, base).searchParams.get('person') === 'Jeff Milton'));
        await page.locator('[data-gallery-album-id="A"]').click();
        const button = page.getByRole('button', { name: '定位文件' });
        await button.click();
        await requested(reveal);
        assert.equal(await button.isDisabled(), true);
        await settle(page, reveal);
        await page.locator('.gallery-photo-reveal-control [role="status"]').filter({ hasText: '已请求定位' }).waitFor();
        assert.equal(new URL(page.url()).pathname, '/photo/set/A');
      } finally { releaseSummaryGates(reveal); collectionShelf = null; await page.close(); }
    });
    await run('photo scroll pagination runs while four same-origin covers are pending', async () => {
      const isList = (url, offset) => url.pathname === '/api/image-library/items'
        && url.searchParams.get('q') === 'pressure' && Number(url.searchParams.get('offset')) === offset;
      const items = Array.from({ length: 80 }, (_, index) => listItem(`pressure-${index}`));
      const initial = hold(url => isList(url, 0), '', { items, count: 80, total: 81, scannedAt: 'pressure', facets: {} });
      const next = hold(url => isList(url, 80), '', { items: [listItem('end')], count: 1, total: 81, scannedAt: 'pressure', facets: {} });
      const covers = items.map(item => hold(url => url.pathname === item.coverUrl));
      const page = await newPage({ real: true, route: '/photo/albums?q=pressure', waitReady: false });
      try {
        await requested(initial);
        await settle(page, initial);
        await until(() => covers.filter(gate => gate.used).length >= 4, 'four independent covers should load in parallel');
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight - window.innerHeight - 250));
        await page.mouse.move(640, 420);
        await page.mouse.wheel(0, 600);
        await requested(next, 2000);
        assert.equal(covers.filter(gate => gate.used).length, 4, 'pending covers leave connections for the list');
        await settle(page, next);
        await page.locator('[data-gallery-album-id="end"]').waitFor({ state: 'visible' });
        assert.equal(await page.locator('.gallery-more').count(), 0);
      } finally { releaseSummaryGates(initial, next, ...covers); await page.close(); }
    });
    await run('photo cold overview early failure preserves explicit summary recovery', async () => {
      const renderer = hold(url => url.pathname === '/modules/content-index/gallery-renderer.js');
      const failure = hold(isSummary, 'Synthetic overview failure during module delivery'), retry = hold(isSummary);
      const isItems = url => url.pathname === '/api/image-library/items';
      const items = hold(isItems), before = countRequests(isItems), overviewReads = countRequests(isSummary);
      const page = await newPage({ real: true, waitReady: false });
      try {
        await Promise.all([requested(renderer), requested(failure)]);
        await settle(page, failure);
        assert.equal(countRequests(isItems), before);
        renderer.release();
        const control = page.locator('.gallery-summary-retry');
        await control.waitFor();
        assert.match(await page.locator('.gallery-summary-recovery').innerText(), /Synthetic overview failure during module delivery/);
        assert.equal(countRequests(isItems), before);
        assert.equal(countRequests(isSummary) - overviewReads, 1);
        await control.click(); await requested(retry); await settle(page, retry);
        await requested(items); await settle(page, items);
        await page.locator('.gallery-photo-album-card').first().waitFor();
        assert.equal(countRequests(isItems) - before, 1);
      } finally { releaseSummaryGates(renderer, failure, retry, items); await page.close(); }
    });
    for (const route of ['/photo/set/B', '/media/W']) await run(`photo cold overview respects startup route change to ${route}`, async () => {
      const samePhoto = route.startsWith('/photo/');
      const renderer = hold(url => url.pathname === '/modules/content-index/gallery-renderer.js');
      const summary = hold(isSummary), reader = hold(url => url.pathname === (samePhoto ? '/api/photo-sets/B' : '/api/gallery-media/W'));
      const isPhotoItems = url => url.pathname === '/api/image-library/items' && url.searchParams.get('mode') === 'photo';
      const before = countRequests(isPhotoItems), overviewReads = countRequests(isSummary);
      const page = await newPage({ real: true, waitReady: false, ignoreAbort: false });
      try {
        await Promise.all([requested(renderer), requested(summary)]);
        await navigateRoute(page, route); renderer.release();
        await requested(reader); await settle(page, reader);
        await readerTitle(page, samePhoto ? 'Album B' : 'Media W');
        if (samePhoto) await settle(page, summary);
        else await until(() => summary.closed, 'leaving photo during module delivery must abort the early overview');
        assert.equal(countRequests(isPhotoItems), before);
        assert.equal(countRequests(isSummary) - overviewReads, 1);
        assert.equal(new URL(page.url()).pathname, route);
      } finally { releaseSummaryGates(renderer, summary, reader); await page.close(); }
    });
    await run('photo cold overview retires when its module fails', async () => {
      const renderer = hold(url => url.pathname === '/modules/content-index/gallery-renderer.js', 'Synthetic unavailable gallery renderer');
      const summary = hold(isSummary), isItems = url => url.pathname === '/api/image-library/items';
      const before = countRequests(isItems);
      const page = await newPage({ real: true, waitReady: false, ignoreAbort: false });
      try {
        await Promise.all([requested(renderer), requested(summary)]);
        renderer.release();
        await until(() => summary.closed, 'a failed module must abort its early overview');
        await page.locator('#appStartupNotice[role="alert"] #appStartupReload').waitFor();
        assert.equal(countRequests(isItems), before);
      } finally { releaseSummaryGates(renderer, summary); await page.close(); }
    });
    await run('collection shelf cold entry downloads only its visible page', async () => {
      collectionShelf = collectionShelfFixture(6250);
      const requestStart = apiMethods.length;
      const page = await newPage({ real: true, route: '/photo?sort=title', waitReady: false, downloadThroughput: 250_000 });
      try {
        const firstVisible = await (await page.waitForFunction(() => {
          const card = document.querySelector('.gallery-collection-card');
          return card && getComputedStyle(card).visibility === 'visible' ? performance.now() : null;
        })).jsonValue();
        const measured = await page.evaluate(visible => {
          const response = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/api/image-library/items');
          return { encodedBytes: response.encodedBodySize, decodedBytes: response.decodedBodySize,
            firstVisibleMs: Math.round(visible - response.startTime), afterResponseMs: Math.round(visible - response.responseEnd) };
        }, firstVisible);
        const itemReads = apiMethods.slice(requestStart).filter(item => item.url.startsWith('/api/image-library/items?'));
        console.log('MEASURE collection shelf cold page', JSON.stringify({ ...measured, downloadBytesPerSecond: 250_000, request: itemReads.at(-1)?.url }));
        assert.deepEqual(await page.locator('.gallery-collection-card strong').allTextContents(),
          Array.from({ length: 80 }, (_, index) => `Collection ${index + 1}`), 'the first 80 visible titles must keep their full order');
        assert.match(await page.locator('.gallery-content').innerText(), /6,250 个合集 · 50,000 期/);
        assert.equal(itemReads.length, 1, 'cold shelf must reuse one response');
        assert(measured.decodedBytes < 100_000, 'cold shelf must receive only the flat visible page');
      } finally { collectionShelf = null; await page.close(); }
    });
    await run('collection shelf native load-more covers each item without rebuilding the prefix', async () => {
      collectionShelf = collectionShelfFixture(167);
      const page = await newPage({ real: true, route: '/photo?sort=title' });
      const append = hold(url => url.pathname === '/api/image-library/items' && url.searchParams.get('offset') === '80');
      const end = hold(url => url.pathname === '/api/image-library/items' && url.searchParams.get('offset') === '160');
      try {
        const more = page.locator('.gallery-more');
        await page.evaluate(() => { window.__collectionFirst = document.querySelector('.gallery-collection-card'); });
        await more.evaluate(button => button.click()); await requested(append);
        assert.equal(await more.isDisabled(), true);
        assert.equal(await page.locator('.gallery-collection-card').count(), 80);
        assert.equal(new URL(append.url, base).searchParams.get('limit'), '80');
        assert.equal(new URL(append.url, base).searchParams.get('collectionPage'), '1');
        await settle(page, append);
        assert.equal(await page.locator('.gallery-collection-card').count(), 160);
        // Native scrollbar drags can deliver a scroll event without a page wheel event.
        await more.evaluate(button => window.scrollTo(0, button.getBoundingClientRect().top + scrollY - innerHeight - 500));
        await requested(end); await settle(page, end);
        assert.deepEqual(await page.locator('.gallery-collection-card strong').allTextContents(), Array.from({ length: 167 }, (_, index) => `Collection ${index + 1}`));
        assert.equal(await page.evaluate(() => document.querySelector('.gallery-collection-card') === __collectionFirst), true);
        assert.equal(await more.count(), 0);
        assert.match(await page.locator('.gallery-results-header').innerText(), /167 个合集 · 1,336 期/);
      } finally { releaseSummaryGates(append, end); collectionShelf = null; await page.close(); }
    });
    await run('collection shelf sorting, category, detail and search keep their own request shapes', async () => {
      const shelf = collectionShelfFixture(177);
      const overview = hold(isSummary, '', { totals: { photoSets: 1416 }, facets: {
        categories: [{ value: 'Category 1', count: 144 }, { value: 'Category 2', count: 144 }]
      } });
      collectionShelf = url => {
        const params = url.searchParams;
        if (params.has('collection')) return { items: [listItem('A')], total: 1, facets: {}, collectionSummary: { title: 'Fixture detail' } };
        if (params.has('q')) return { items: [listItem('B')], total: 1, facets: {}, query: params.get('q') };
        return shelf(url);
      };
      const page = await newPage({ real: true, route: '/photo?sort=title', waitReady: false });
      const items = url => url.pathname === '/api/image-library/items';
      const obsolete = hold(url => items(url) && url.searchParams.get('offset') === '80');
      const sorted = hold(url => items(url) && url.searchParams.get('sort') === 'size');
      const category = hold(url => items(url) && url.searchParams.get('category') === 'Category 1');
      const detail = hold(url => items(url) && url.searchParams.has('collection'));
      const search = hold(url => items(url) && url.searchParams.has('q'));
      const params = gate => new URL(gate.url, base).searchParams;
      try {
        await requested(overview); await settle(page, overview);
        const cards = page.locator('.gallery-collection-card');
        await cards.first().waitFor();
        await page.locator('.gallery-more').click(); await requested(obsolete);
        await page.locator('.gallery-results-header').getByRole('button', { name: '容量最大' }).click();
        await requested(sorted);
        assert.equal(params(sorted).get('offset'), '0');
        assert.equal(params(sorted).get('collectionPage'), '1');
        assert.equal(params(sorted).get('collectionLocale'), await page.evaluate(() => new Intl.Collator().resolvedOptions().locale));
        await settle(page, sorted);
        await settle(page, obsolete);
        assert.equal(await cards.count(), 80);
        assert.match(await cards.first().innerText(), /Collection 177\b/);

        const chips = page.locator('.gallery-photo-category-strip > button');
        const overviewLabels = await chips.allTextContents();
        await chips.filter({ hasText: 'Category 1' }).click();
        await requested(category);
        assert.equal(params(category).get('offset'), '0');
        assert.equal(params(category).get('sort'), 'count');
        assert.equal(params(category).get('collectionPage'), '1');
        await settle(page, category);
        assert.equal(await cards.count(), 18);
        assert.match(await cards.first().innerText(), /Collection 171\b/);
        assert.deepEqual(await chips.allTextContents(), overviewLabels);
        assert.match(await page.locator('.gallery-results-header').innerText(), /18 个合集 · 144 期/);
        assert.equal(await page.getByRole('link', { name: /资料入库/ }).count(), 0, 'collection cards are a single reading action');

        await cards.first().click(); await requested(detail);
        assert.equal(params(detail).get('photoView'), 'albums');
        assert.equal(params(detail).get('collection'), 'R|C171');
        assert.equal(params(detail).has('collectionPage'), false);
        await settle(page, detail);
        assert.match(await page.locator('.gallery-collection-hero').innerText(), /Fixture detail/);
        assert.equal(await page.locator('.gallery-collection-health').count(), 0, 'issue gaps and duplicates live on the analysis page');
        assert.equal(await page.getByRole('link', { name: '分析', exact: true }).getAttribute('href'), '/photo/analysis');

        const input = page.locator('.gallery-search');
        await input.fill('Needle'); await input.press('Enter'); await requested(search);
        assert.equal(params(search).get('q'), 'Needle');
        assert.equal(params(search).get('sort'), 'relevance');
        assert.equal(params(search).has('collectionPage'), false);
        await settle(page, search);
        assert.match(await page.locator('.gallery-photo-album-card').first().innerText(), /Album B/);
      } finally { releaseSummaryGates(overview, obsolete, sorted, category, detail, search); collectionShelf = null; await page.close(); }
    });
    await run('photo people browse has an inner sort, direction and person drill-down', async () => {
      const isPeople = url => url.pathname === '/api/image-library/items' && url.searchParams.get('photoView') === 'people';
      const people = [
        { type: 'photoPerson', id: '小亭', name: '小亭', value: '小亭', count: 30 },
        { type: 'photoPerson', id: '小乔', name: '小乔', value: '小乔', count: 26 }
      ];
      const result = (items, direction) => ({ items, photoView: 'people', total: items.length, facets: {}, sort: 'count', direction });
      const initial = hold(isPeople, '', result(people, 'desc'));
      const ascending = hold(url => isPeople(url) && url.searchParams.get('direction') === 'asc', '', result([...people].reverse(), 'asc'));
      const person = hold(url => url.pathname === '/api/image-library/items' && url.searchParams.get('person') === '小亭', '', {
        items: [{ ...listItem('person-album'), personName: '小亭' }], total: 1, facets: {}, sort: 'updated'
      });
      const page = await newPage({ real: true, route: '/photo/people', waitReady: false });
      try {
        await requested(initial); await settle(page, initial);
        await page.waitForURL(url => url.pathname === '/photo/people');
        assert.equal(await page.locator('.gallery-controls .gallery-photo-sort').count(), 0);
        const cards = page.locator('.gallery-photo-person-card strong');
        assert.deepEqual(await cards.allTextContents(), ['小亭', '小乔']);
        const count = page.locator('.gallery-results-header').getByRole('button', { name: '套图数量' });
        assert.equal(await count.locator('.gallery-photo-sort-direction').innerText(), '↓');
        await count.click();
        await requested(ascending); await settle(page, ascending);
        assert.equal(new URL(page.url()).searchParams.get('dir'), 'asc');
        assert.deepEqual(await cards.allTextContents(), ['小乔', '小亭']);
        assert.equal(await count.locator('.gallery-photo-sort-direction').innerText(), '↑');
        await page.keyboard.press('/');
        const input = page.getByRole('searchbox', { name: '搜索套图' });
        assert(await input.evaluate(node => node === document.activeElement));
        await page.locator('.gallery-photo-person-card').getByText('小亭').click();
        await requested(person); await settle(page, person);
        assert.equal(new URL(page.url()).pathname, '/photo/albums');
        assert.equal(new URL(person.url, base).searchParams.has('q'), false);
        await page.locator('[data-gallery-album-id="person-album"]').waitFor();
      } finally { releaseSummaryGates(initial, ascending, person); await page.close(); }
    });
    for (const mode of ['photo', 'media']) await run(`${mode} dedicated search clears browse scope and preserves browser Back`, async () => {
      const title = '合成搜索结果';
      const search = hold(url => url.pathname === '/api/image-library/items' && url.searchParams.get('mode') === mode
        && url.searchParams.get('q') === '独立搜索', '', {
        mode, query: '独立搜索', sort: 'relevance', total: 1, facets: {},
        items: [{ ...listItem('search-hit'), title, type: mode === 'photo' ? 'photo' : 'movie', mediaKind: mode === 'media' ? 'movie' : '' }]
      });
      const path = mode === 'photo' ? '/photo/categories/cos' : '/media?kind=tv&category=fixture';
      const page = await newPage({ real: true, route: path, waitReady: false });
      try {
        const input = page.locator('.gallery-search');
        await input.waitFor();
        await page.waitForURL(url => mode === 'photo' ? url.pathname === '/photo/categories/cos' : url.searchParams.get('kind') === 'tv');
        await input.fill('独立搜索'); await input.press('Enter');
        await requested(search); await settle(page, search);
        await page.waitForURL(url => url.pathname === `/${mode}/search` && url.searchParams.get('q') === '独立搜索');
        const params = new URL(search.url, base).searchParams;
        for (const key of ['category', 'collection', 'person', 'kind', 'seriesKey', 'date']) assert.equal(params.has(key), false);
        if (mode === 'photo') assert.equal(params.get('photoView'), 'albums');
        await page.getByText(title, { exact: true }).first().waitFor();
        assert.equal(await page.locator('.gallery-photo-category-strip, .gallery-photo-view-switch, .gallery-media-kind-switch').count(), 0);
        await page.goBack();
        await page.waitForURL(url => mode === 'photo' ? url.pathname === '/photo/categories/cos' : url.searchParams.get('kind') === 'tv');
        assert.equal(await input.inputValue(), '');
      } finally { releaseSummaryGates(search); await page.close(); }
    });
    await run('photo visible search button opens zero results and restores browsing on Back', async () => {
      const path = '/photo/collections';
      const query = '合成无匹配结果';
      const empty = hold(url => url.pathname === '/api/image-library/items' && url.searchParams.get('mode') === 'photo'
        && url.searchParams.get('q') === query, '', { mode: 'photo', query, sort: 'relevance', total: 0, facets: {}, items: [] });
      collectionShelf = collectionShelfFixture(12);
      const page = await newPage({ real: true, route: path, waitReady: false });
      try {
        const cards = page.locator('.gallery-collection-card');
        await cards.first().waitFor();
        assert.equal(await page.locator('.gallery-photo-view-switch').count(), 0);
        assert.equal(await page.getByRole('button', { name: /^(按合集|全部套图|按人物)$/ }).count(), 0);
        await page.setViewportSize({ width: 390, height: 844 });
        const input = page.getByRole('searchbox', { name: '搜索套图' });
        const submit = page.locator('.gallery-photo-search-box .gallery-media-search-submit');
        assert(await submit.isVisible());
        assert.equal(await submit.innerText(), '搜索');
        await input.fill(query);
        await submit.click();
        await requested(empty); await settle(page, empty);
        await page.waitForURL(url => url.pathname === '/photo/search' && url.searchParams.get('q') === query);
        assert.equal(new URL(empty.url, base).searchParams.get('sort'), 'relevance');
        assert.match(await page.locator('.gallery-search-summary').innerText(), /0 个匹配/);
        await page.getByText('没有匹配的套图', { exact: true }).waitFor();
        assert(await page.getByRole('button', { name: '返回浏览', exact: true }).isVisible());
        assert.equal(await page.locator('.gallery-photo-category-strip, .gallery-photo-view-switch').count(), 0);
        await page.goBack();
        await page.waitForURL(url => url.pathname === path && !url.searchParams.has('q'));
        await cards.first().waitFor();
        assert.equal(await input.inputValue(), '');
      } finally { releaseSummaryGates(empty); collectionShelf = null; await page.close(); }
    });
    await run('media search opens a series episode list and preserves its search on Back', async () => {
      const title = '合成剧集';
      const seriesKey = 'fixture-series';
      const isItems = url => url.pathname === '/api/image-library/items' && url.searchParams.get('mode') === 'media';
      const results = { mode: 'media', query: title, total: 1, facets: {}, items: [{
        ...listItem('series-result'), title, type: 'tvSeriesWork', mediaKind: 'tv', seriesName: title, seriesKey
      }] };
      const search = hold(url => isItems(url) && url.searchParams.get('q') === title, '', results);
      const episodes = hold(url => isItems(url) && url.searchParams.get('seriesKey') === seriesKey, '', {
        mode: 'media', total: 1, facets: {}, items: [{
          ...listItem('episode-result'), title: 'S01E01', type: 'movie', mediaKind: 'tv', seriesKey
        }]
      });
      const page = await newPage({ real: true, route: `/media/search?q=${encodeURIComponent(title)}`, waitReady: false });
      try {
        await requested(search); await settle(page, search);
        const series = page.locator('.gallery-movie-list-item').filter({ hasText: title });
        await series.click();
        await requested(episodes); await settle(page, episodes);
        const episodeQuery = new URL(episodes.url, base).searchParams;
        assert.equal(episodeQuery.has('q'), false);
        assert.equal(episodeQuery.get('kind'), 'tv');
        await page.waitForURL(url => url.pathname === '/media' && url.searchParams.get('seriesKey') === seriesKey);
        await page.getByText('选集播放', { exact: true }).waitFor();
        await page.goBack();
        await page.waitForURL(url => url.pathname === '/media/search' && url.searchParams.get('q') === title);
        assert.equal(await page.locator('.gallery-search').inputValue(), title);
      } finally { releaseSummaryGates(search, episodes); await page.close(); }
    });
    await run('photo collection people replace the person dropdown and filter within the collection', async () => {
      const collection = 'root|test-person-collection';
      const isCollection = url => url.pathname === '/api/image-library/items' && url.searchParams.get('collection') === collection;
      const result = {
        items: [listItem('collection-person-album')], total: 1,
        collectionSummary: { id: collection, title: '合成人物合集' },
        facets: { people: [{ value: '小亭', count: 30 }, { value: '小乔', count: 26 }] }, sort: 'updated'
      };
      const initial = hold(isCollection, '', result);
      const chosen = hold(url => isCollection(url) && url.searchParams.get('person') === '小亭', '', result);
      const page = await newPage({ real: true, route: `/photo/collection/${encodeURIComponent(collection)}`, waitReady: false });
      try {
        await requested(initial); await settle(page, initial);
        assert.equal(await page.locator('.gallery-collection-filters select').count(), 0);
        await page.locator('.gallery-photo-person-toggle').click();
        assert.deepEqual(await page.locator('.gallery-photo-person-card strong').allTextContents(), ['小亭', '小乔']);
        assert.equal(await page.locator('.gallery-photo-album-card').count(), 0);
        await page.locator('.gallery-photo-person-card').getByText('小亭').click();
        await requested(chosen); await settle(page, chosen);
        await page.locator('.gallery-photo-person-active').waitFor();
        assert.equal(await page.locator('.gallery-photo-person-active').innerText(), '小亭 ×');
        await page.locator('.gallery-photo-album-card').waitFor();
      } finally { releaseSummaryGates(initial, chosen); await page.close(); }
    });
    for (const downgrade of [false, true]) await run(`collection shelf rebases the prefix on ${downgrade ? 'legacy response shape' : 'source revision'} changes`, async () => {
      collectionShelf = collectionShelfFixture(170);
      const page = await newPage({ real: true, route: '/photo?sort=title' });
      const append = hold(url => url.pathname === '/api/image-library/items' && url.searchParams.get('offset') === '80');
      const rebase = hold(url => url.pathname === '/api/image-library/items' && url.searchParams.get('offset') === '0');
      try {
        await page.locator('.gallery-more').click(); await requested(append);
        collectionShelf = collectionShelfFixture(170, { grouped: downgrade, revision: downgrade ? 'fixture-v1' : 'fixture-v2', first: 1001 });
        append.release(); await requested(rebase);
        assert.equal(new URL(rebase.url, base).searchParams.get('limit'), '160');
        assert.match(await page.locator('.gallery-collection-card').first().innerText(), /Collection 1\b/);
        assert.equal(await page.locator('.gallery-collection-card').count(), 80);
        await settle(page, rebase);
        assert.deepEqual(await page.locator('.gallery-collection-card strong').allTextContents(), Array.from({ length: 160 }, (_, index) => `Collection ${index + 1001}`));
        assert.match(await page.locator('.gallery-results-header').innerText(), /170 个合集 · 1,360 期/);
        if (downgrade) {
          const count = countRequests(url => url.pathname === '/api/image-library/items');
          await page.locator('.gallery-more').click(); await tick(page);
          assert.equal(await page.locator('.gallery-collection-card').count(), 170);
          assert.equal(countRequests(url => url.pathname === '/api/image-library/items'), count, 'legacy grouped shelves must retain local load-more');
        }
      } finally { releaseSummaryGates(append, rebase); collectionShelf = null; await page.close(); }
    });
    await run('standalone cold entry overlaps module delivery with styles without early boot', async () => {
      const stylesheet = hold(url => url.pathname === '/modules/content-index/catalog.css');
      const isEntry = url => url.pathname === '/standalone-app.js';
      const entry = hold(isEntry);
      const startEntryCount = countRequests(isEntry);
      const startSummaryCount = countRequests(isSummary);
      const delay = 320;
      const page = await newPage({ real: true, route: '/photo/albums', waitReady: false });
      entry.requested.then(() => setTimeout(entry.release, delay));
      try {
        await requested(stylesheet);
        await new Promise(resolve => setTimeout(resolve, delay));
        const beforeStyles = { entry: entry.used, summary: countRequests(isSummary) - startSummaryCount,
          module: await page.evaluate(() => document.documentElement.dataset.appModule || null) };
        stylesheet.release();
        const visibleAt = await (await page.waitForFunction(() => {
          const card = document.querySelector('.gallery-card');
          return card && getComputedStyle(card).visibility === 'visible' ? performance.now() : null;
        })).jsonValue();
        const timings = await page.evaluate(visibleAt => {
          const resources = performance.getEntriesByType('resource');
          const start = resources.find(entry => new URL(entry.name).pathname === '/modules/content-index/catalog.css').startTime;
          const module = resources.find(entry => new URL(entry.name).pathname === '/standalone-app.js');
          return { entryStartMs: Math.round(module.startTime - start), visibleMs: Math.round(visibleAt - start) };
        }, visibleAt);
        console.log('MEASURE standalone cold photo', JSON.stringify({ delay, beforeStyles, ...timings,
          entryRequests: countRequests(isEntry) - startEntryCount }));
        assert.deepEqual(beforeStyles, { entry: true, summary: 0, module: null }, 'the standalone entry must download during style loading and execute after it');
        assert.equal(countRequests(isEntry) - startEntryCount, 1, 'the production import must reuse the preloaded module URL');
        assert.equal(await page.locator('#appStartupNotice').count(), 0);
      } finally { releaseSummaryGates(stylesheet, entry); await page.close(); }
    });
    await run('standalone preloaded entry preserves late style failure recovery', async () => {
      const stylesheet = hold(url => url.pathname === '/modules/content-index/catalog.css', 'Synthetic gallery stylesheet unavailable');
      const page = await newPage({ real: true, route: '/photo/albums', waitReady: false });
      try {
        await requested(stylesheet);
        await page.waitForFunction(() => performance.getEntriesByType('resource').some(entry =>
          new URL(entry.name).pathname === '/standalone-app.js'), null, { timeout: 5000 });
        assert.equal(await page.evaluate(() => document.documentElement.dataset.appModule || null), null,
          'a downloaded module must wait for the styles outcome before executing');
        stylesheet.release();
        await page.locator('.gallery-card').first().waitFor();
        const notice = page.locator('#appStartupNotice');
        assert.equal(await notice.getAttribute('role'), 'status');
        assert.equal(await notice.locator('#appStartupTitle').textContent(), '部分页面样式未加载');
        assert.equal(await notice.isVisible(), true);
      } finally { releaseSummaryGates(stylesheet); await page.close(); }
    });
    await run('summary recovery: a cold failure exposes an actionable read-only retry', async () => {
      const failed = hold(isSummary, 'Synthetic cold summary unavailable');
      const beforeItems = countRequests(url => url.pathname === '/api/image-library/items'), methodStart = apiMethods.length;
      const page = await newPage({ real: true, route: '/photo', waitReady: false });
      try {
        await requested(failed);
        await page.waitForFunction(() => document.documentElement.dataset.appModule === 'standalone'
          && !document.documentElement.classList.contains('app-module-loading'));
        await settle(page, failed);
        const actual = { body: await page.locator('.gallery-list-state').allTextContents(), retries: await page.locator('.gallery-list-state button').count(),
          items: countRequests(url => url.pathname === '/api/image-library/items') - beforeItems, api: apiMethods.slice(methodStart) };
        console.log('GALLERY_COLD_SUMMARY_FAILURE', JSON.stringify(actual));
        assert.equal(actual.items, 0, 'cold summary failure must not start items before the overview is available');
        assert.equal(actual.retries, 1, 'a cold gallery summary failure must expose a read-only retry instead of remaining in the loading state');
        assert(actual.body.join(' ').includes('Synthetic cold summary unavailable') && !actual.body.join(' ').includes('正在读取图库概览'));
        assert(apiMethods.slice(methodStart).every(request => request.method === 'GET'), 'summary recovery must not scan or write the image library');
      } finally { failed.release(); await page.close(); }
    });
    await run('summary recovery: native repeated retry keeps focus and reads the current query', async () => {
      const methodStart = apiMethods.length, before = countRequests(isSummary);
      const page = await coldSummaryPage('/photo?photoView=albums&q=Album%20B');
      const failed = hold(isSummary, 'Synthetic repeated summary failure');
      const success = hold(isSummary), items = hold(url => url.pathname === '/api/image-library/items', '', { items: [listItem('B')], count: 1, total: 1, facets: {} });
      try {
        await page.setViewportSize({ width: 320, height: 640 });
        const retry = page.locator('.gallery-summary-retry');
        await retry.focus(); await rememberSummaryControl(page);
        await page.keyboard.press('Enter'); await requested(failed);
        await page.keyboard.press('Space'); await page.keyboard.press('Enter'); await tick(page);
        assert.equal(countRequests(isSummary), before + 2, 'repeated native summary retry activation must share one in-flight GET');
        assert.equal(await retry.evaluate(button => document.activeElement === button && !button.disabled), true, 'busy summary retry must retain native focus so Space cannot activate another control');
        assert.equal(await retry.getAttribute('aria-disabled'), 'true');
        await settle(page, failed);
        assert.equal(await page.locator('.gallery-summary-recovery').textContent().then(text => text.includes('Synthetic repeated summary failure')), true);
        assert.equal(await summaryControlRetained(page), true, 'a repeated summary failure must keep the native retry and its ancestors connected and focused');
        const box = await retry.boundingBox(); assert(box && box.x >= -1 && box.x + box.width <= 321 && box.height >= 44, '320px summary recovery must expose the entire native retry hit area');
        assert.equal(await retry.evaluate(button => { const r = button.getBoundingClientRect(); return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), true);
        await page.keyboard.press('Space'); await requested(success);
        await page.keyboard.press('Enter'); await tick(page);
        assert.equal(countRequests(isSummary), before + 3);
        await settle(page, success); await requested(items);
        const url = new URL(items.url, base);
        assert.equal(url.searchParams.get('q'), 'Album B'); assert.equal(url.searchParams.get('photoView'), 'albums');
        assert.equal(url.searchParams.get('sort'), 'relevance'); assert.equal(url.searchParams.get('offset'), '0');
        await settle(page, items); await page.locator('.gallery-card').waitFor();
        assert.deepEqual(await page.locator('.gallery-card-body > strong').allTextContents(), ['Album B']);
        assert.equal(await page.locator('.gallery-summary-recovery').count(), 0);
        assert.equal(await page.locator('.gallery-browse-header h1').evaluate(heading => document.activeElement === heading), true, 'successful owned summary retry must restore focus to the current list heading');
        assert.equal(new URL(page.url()).searchParams.get('q'), 'Album B');
        assertReadOnly(methodStart);
      } finally { releaseSummaryGates(failed, success, items); await page.close(); }
    });
    await run('summary recovery: a new draft and IME keep their full live input chain', async () => {
      for (const error of ['', 'Synthetic retry with newer draft failed']) {
        const methodStart = apiMethods.length, page = await coldSummaryPage('/photo?photoView=albums&q=Album%20B');
        const retry = hold(isSummary, error), items = hold(url => url.pathname === '/api/image-library/items', '', { items: [listItem('B')], count: 1, total: 1, facets: {} });
        try {
          await page.locator('.gallery-summary-retry').click(); await requested(retry);
          const search = page.locator('.gallery-search'); await search.focus(); await search.fill('  未提交 Draft  ');
          await search.evaluate(input => {
            input.setSelectionRange(2, 5); input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '未' }));
            window.__summaryDraft = { input, parents: [], blur: 0, removed: false };
            for (let node = input; node; node = node.parentElement) __summaryDraft.parents.push(node);
            input.addEventListener('blur', () => __summaryDraft.blur++);
            __summaryDraft.observer = new MutationObserver(records => { for (const record of records) for (const node of record.removedNodes)
              if (__summaryDraft.parents.some(parent => node === parent || node.contains?.(parent))) __summaryDraft.removed = true; });
            __summaryDraft.observer.observe(document.body, { subtree: true, childList: true });
          });
          await settle(page, retry);
          if (!error) { await requested(items); assert.equal(new URL(items.url, base).searchParams.get('q'), 'Album B'); await settle(page, items); await page.locator('.gallery-card').waitFor(); }
          assert.deepEqual(await page.evaluate(() => ({ same: __summaryDraft.input === document.querySelector('.gallery-search'), connected: __summaryDraft.parents.every(node => node.isConnected), removed: __summaryDraft.removed,
            blur: __summaryDraft.blur, focused: document.activeElement === __summaryDraft.input, raw: __summaryDraft.input.value, selection: [__summaryDraft.input.selectionStart, __summaryDraft.input.selectionEnd] })),
          { same: true, connected: true, removed: false, blur: 0, focused: true, raw: '  未提交 Draft  ', selection: [2, 5] }, 'summary retry completion must preserve newer raw composition, selection, focus, and every live input ancestor');
          assert.equal(countRequests(url => url.pathname === '/api/image-library/items' && url.searchParams.get('q')?.includes('未提交')), 0, 'unsubmitted composition must not become a new gallery API query');
          await search.dispatchEvent('keydown', { key: 'Unidentified', keyCode: 229, isComposing: true, bubbles: true });
          await search.evaluate(input => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '未提交' })));
          assert.equal(await search.inputValue(), '  未提交 Draft  ');
          if (error) assert((await page.locator('.gallery-summary-recovery').textContent()).includes(error));
          assertReadOnly(methodStart);
        } finally { releaseSummaryGates(retry, items); await page.close(); }
      }
    });
    await run('summary recovery: a newer route owns retry results and reader status', async () => {
      for (const error of ['', 'Synthetic obsolete retry failed']) {
        const methodStart = apiMethods.length, page = await coldSummaryPage();
        const retry = hold(isSummary, error), reader = hold(url => url.pathname === '/api/photo-sets/B');
        try {
          const beforeItems = countRequests(url => url.pathname === '/api/image-library/items');
          await page.locator('.gallery-summary-retry').click(); await requested(retry);
          await navigateRoute(page, '/photo/set/B'); await requested(reader); await tick(page);
          const pending = await page.locator('#workGrid').innerHTML();
          await settle(page, retry);
          assert.equal(await page.locator('#workGrid').innerHTML(), pending, 'a late summary retry cannot replace a newer reader loading surface');
          assert.equal(new URL(page.url()).pathname, '/photo/set/B');
          assert.equal(countRequests(url => url.pathname === '/api/image-library/items'), beforeItems, 'a retry started on the list must not start old list reads after a reader navigation');
          await settle(page, reader); await readerTitle(page, 'Album B');
          assert.equal(await page.locator('.gallery-summary-recovery').count(), 0);
          assertReadOnly(methodStart);
        } finally { releaseSummaryGates(retry, reader); await page.close(); }
      }
    });
    await run('summary recovery: inactive view and retired buttons cannot publish or retry', async () => {
      for (const error of ['', 'Synthetic inactive retry failed']) {
        const page = await newPage(), failed = hold(isSummary, 'Synthetic lifecycle cold failure');
        const retry = hold(isSummary, error), methodStart = apiMethods.length;
        try {
          await page.evaluate(() => { fixture.state.gallery.data = null; fixture.state.gallery.list = null; fixture.renderer.renderView(); fixture.summaryTask = fixture.page.loadImageLibrary({ reload: true }); });
          await requested(failed); await settle(page, failed); await page.evaluate(() => fixture.summaryTask);
          await page.locator('.gallery-summary-retry').evaluate(button => { fixture.retiredSummaryRetry = button; button.click(); }); await requested(retry);
          // Lifecycle double: real cross-product navigation unloads the document.
          await page.evaluate(() => {
            fixture.state.activeView = 'novels'; fixture.page.resetReader();
            document.querySelector('#workGrid').innerHTML = '<button id="new-summary-owner">New owner</button>';
            document.querySelector('#statsRow').textContent = 'New owner stats'; document.querySelector('#new-summary-owner').focus();
          });
          const before = await page.evaluate(() => ({ body: document.querySelector('#workGrid').innerHTML, stats: document.querySelector('#statsRow').innerHTML, status: fixture.state.gallery.status, active: document.activeElement.id }));
          const reads = countRequests(isSummary);
          await page.evaluate(() => fixture.retiredSummaryRetry.click()); await settle(page, retry);
          await page.evaluate(() => fixture.retiredSummaryRetry.click()); await tick(page);
          assert.deepEqual(await page.evaluate(() => ({ body: document.querySelector('#workGrid').innerHTML, stats: document.querySelector('#statsRow').innerHTML, status: fixture.state.gallery.status, active: document.activeElement.id })), before,
            'inactive gallery retry completion must not paint or focus the new view');
          assert.equal(countRequests(isSummary), reads, 'retired summary recovery buttons must not start another read');
          assertReadOnly(methodStart);
        } finally { releaseSummaryGates(failed, retry); await page.close(); }
      }
    });
    await run('summary recovery: the first items failure retains its existing retry path', async () => {
      const methodStart = apiMethods.length, page = await coldSummaryPage('/photo?photoView=albums&category=fixture');
      const summary = hold(isSummary), failedItems = hold(url => url.pathname === '/api/image-library/items', 'Synthetic first items unavailable');
      const items = hold(url => url.pathname === '/api/image-library/items', '', { items: [listItem('B')], count: 1, total: 1, facets: {} });
      try {
        await page.locator('.gallery-summary-retry').click(); await requested(summary); await settle(page, summary);
        await requested(failedItems); await settle(page, failedItems);
        const retry = page.locator('.gallery-list-state button');
        assert.equal(await retry.textContent(), '重试'); assert((await page.locator('.gallery-list-state').textContent()).includes('Synthetic first items unavailable'));
        assert.equal(await page.locator('.gallery-summary-recovery').count(), 0, 'a successful overview must hand failure recovery to the existing items reader');
        const summaries = countRequests(isSummary);
        await retry.focus(); await page.keyboard.press('Enter'); await requested(items);
        assert.equal(new URL(items.url, base).searchParams.get('category'), 'fixture');
        await settle(page, items); await page.locator('.gallery-card').waitFor();
        assert.deepEqual(await page.locator('.gallery-card-body > strong').allTextContents(), ['Album B']);
        assert.equal(countRequests(isSummary), summaries, 'first-items retry must not reread or rescan a recovered overview');
        assertReadOnly(methodStart);
      } finally { releaseSummaryGates(summary, failedItems, items); await page.close(); }
    });
    for (const pointer of ['mouse', 'touch']) await run(`pager range metadata: full directory completion preserves an active native ${pointer} drag`, async () => {
      const page = await newPage({ real: true });
      const full = hold(url => url.pathname === '/api/photo-sets/A' && url.searchParams.get('imageLimit') === 'all');
      let gesture;
      try {
        await clickAlbum(page, 'A'); await readerTitle(page, 'Album A'); await page.locator('.gallery-reader-open').click(); await requested(full);
        await page.setViewportSize({ width: 320, height: 640 });
        const range = page.locator('.gallery-image-pager-range'); gesture = await beginRangeGesture(page, pointer);
        const preview = await range.inputValue();
        assert(Number(preview) > 30 && Number(preview) < 150, 'native slider input must preview a noninitial page while the pointer is held');
        assert.equal(await page.evaluate(() => window.__rangePointerType), pointer);
        const targetReads = countRequests(url => url.pathname === `/synthetic/A/${preview}.svg`);
        const before = await range.evaluate(range => ({ value: range.value, max: range.max, source: document.querySelector('.gallery-image-pager-stage img').getAttribute('src') }));
        await settle(page, full);
        const after = await range.evaluate(range => ({ value: range.value, max: range.max, source: document.querySelector('.gallery-image-pager-stage img').getAttribute('src') }));
        console.log(JSON.stringify({ mode: 'gallery-range-during-directory', pointer, before, after }));
        assert.deepEqual(after, before, 'full directory completion must not reset the native slider domain or discard the held preview');
        assert.equal(countRequests(url => url.pathname === `/synthetic/A/${preview}.svg`), targetReads, 'a held range preview must not fetch the candidate image before commit');
        await gesture.finish(); await tick(page);
        assert.equal(await range.getAttribute('max'), '10000', 'releasing the native range drag must apply the deferred full directory');
        assert.equal(await range.inputValue(), preview);
        assert.equal(await page.locator('.gallery-image-pager-stage img').getAttribute('src'), `/synthetic/A/${preview}.svg`);
      } finally { await gesture?.finish().catch(() => {}); full.release(); await page.close(); }
    });
    await run('pager range metadata: native touch cancellation applies the new directory without committing the preview', async () => {
      const page = await newPage({ real: true });
      const full = hold(url => url.pathname === '/api/photo-sets/A' && url.searchParams.get('imageLimit') === 'all');
      let gesture;
      try {
        await clickAlbum(page, 'A'); await readerTitle(page, 'Album A'); await page.locator('.gallery-reader-open').click(); await requested(full); await page.setViewportSize({ width: 320, height: 640 });
        await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('+'); await pagerZoomReady(page); await tick(page);
        await page.evaluate(() => { window.__rangeImage = document.querySelector('.gallery-image-pager-stage img'); window.__rangeInput = document.querySelector('.gallery-image-pager-range'); });
        gesture = await beginRangeGesture(page, 'touch');
        assert(Number(await page.locator('.gallery-image-pager-range').inputValue()) > 30);
        await settle(page, full); await gesture.finish(true); await tick(page);
        assert.equal(await page.locator('.gallery-image-pager-range').getAttribute('max'), '10000', 'cancelling a range drag must still apply the newly loaded complete directory');
        assert.equal(await page.locator('.gallery-image-pager-range').inputValue(), '3', 'cancelling a range drag must restore the actually viewed picture rather than commit its preview');
        assert.equal(await page.locator('.gallery-image-pager-stage img').getAttribute('src'), '/synthetic/A/3.svg');
        assert.equal(await page.locator('.gallery-image-pager-zoom').textContent(), '125%');
        assert.equal(await page.evaluate(() => __rangeImage === document.querySelector('.gallery-image-pager-stage img') && __rangeInput === document.querySelector('.gallery-image-pager-range')), true);
      } finally { await gesture?.finish().catch(() => {}); full.release(); await page.close(); }
    });
    await run('pager range metadata: closing retires a deferred directory and the old range controls', async () => {
      const page = await newPage({ real: true });
      const full = hold(url => url.pathname === '/api/photo-sets/A' && url.searchParams.get('imageLimit') === 'all');
      let gesture;
      try {
        await clickAlbum(page, 'A'); await readerTitle(page, 'Album A'); await page.locator('.gallery-reader-open').click(); await requested(full); await page.setViewportSize({ width: 320, height: 640 });
        gesture = await beginRangeGesture(page, 'mouse'); await settle(page, full);
        await page.evaluate(() => { window.__oldHeldRange = document.querySelector('.gallery-image-pager-range'); });
        await page.keyboard.press('Escape'); await gesture.finish();
        await page.locator('.gallery-reader-back').click(); await clickAlbum(page, 'B'); await readerTitle(page, 'Album B');
        await page.locator('.gallery-reader-open').click(); await page.waitForFunction(() => document.querySelector('.gallery-image-pager-range').max === '10000');
        await page.keyboard.press('+'); await pagerZoomReady(page); await tick(page);
        const before = await page.evaluate(() => ({ value: document.querySelector('.gallery-image-pager-range').value, max: document.querySelector('.gallery-image-pager-range').max,
          source: document.querySelector('.gallery-image-pager-stage img').getAttribute('src'), zoom: document.querySelector('.gallery-image-pager-zoom').textContent }));
        await page.evaluate(() => { __oldHeldRange.value = '80'; for (const type of ['input', 'change', 'pointerup', 'pointercancel']) __oldHeldRange.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, { bubbles: true, pointerId: 1 }) : new Event(type, { bubbles: true })); }); await tick(page);
        assert.deepEqual(await page.evaluate(() => ({ value: document.querySelector('.gallery-image-pager-range').value, max: document.querySelector('.gallery-image-pager-range').max,
          source: document.querySelector('.gallery-image-pager-stage img').getAttribute('src'), zoom: document.querySelector('.gallery-image-pager-zoom').textContent })), before,
          'retired range controls must not apply the old album directory to a newer reader');
      } finally { await gesture?.finish().catch(() => {}); full.release(); await page.close(); }
    });
    await run('pager zoom anchor: changing magnification keeps the visible detail at the viewport center', async () => {
      const page = await newPage({ real: true });
      const full = hold(url => url.pathname === '/api/photo-sets/A' && url.searchParams.get('imageLimit') === 'all');
      try {
        await clickAlbum(page, 'A'); await readerTitle(page, 'Album A'); await page.locator('.gallery-reader-open').click(); await requested(full);
        await page.setViewportSize({ width: 320, height: 640 });
        for (let index = 0; index < 8; index++) await page.keyboard.press('+');
        await pagerZoomReady(page);
        await page.locator('.gallery-image-pager-stage').evaluate(stage => { stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) * .5; stage.scrollTop = (stage.scrollHeight - stage.clientHeight) * .5; });
        const before = await zoomRegion(page);
        assert(before.imagePoint && before.left > 30 && before.top > 30, 'zoom anchor fixture must inspect an actually visible magnified image region');
        await page.getByRole('button', { name: '缩小图片', exact: true }).click(); await pagerZoomReady(page);
        const after = await zoomRegion(page);
        console.log(JSON.stringify({ mode: 'gallery-zoom-region', before, after }));
        assert(Math.abs(after.u - before.u) < .005 && Math.abs(after.v - before.v) < .005,
          'changing magnification must keep the viewed detail instead of resetting the image to its top-left corner');
        await page.getByRole('button', { name: '放大图片', exact: true }).click(); await pagerZoomReady(page); await tick(page);
        const enlarged = await zoomRegion(page);
        assert(Math.abs(enlarged.u - before.u) < .005 && Math.abs(enlarged.v - before.v) < .005);
        await page.keyboard.press('0'); await pagerZoomReady(page); await tick(page);
        assert.deepEqual(await page.locator('.gallery-image-pager-stage').evaluate(stage => [stage.scrollLeft, stage.scrollTop]), [0, 0], 'resetting to the fitted image keeps the existing overview behavior');
      } finally { full.release(); await page.close(); }
    });
    await run('pager zoom anchor: desktop bounds clamp without losing the vertical detail', async () => {
      const page = await newPage({ real: true });
      const full = hold(url => url.pathname === '/api/photo-sets/A' && url.searchParams.get('imageLimit') === 'all');
      try {
        await clickAlbum(page, 'A'); await readerTitle(page, 'Album A'); await page.locator('.gallery-reader-open').click(); await requested(full);
        for (let index = 0; index < 8; index++) await page.keyboard.press('+'); await pagerZoomReady(page); await tick(page);
        await page.locator('.gallery-image-pager-stage').evaluate(stage => { stage.scrollLeft = stage.scrollWidth - stage.clientWidth; stage.scrollTop = (stage.scrollHeight - stage.clientHeight) * .6; });
        const before = await zoomRegion(page);
        await page.getByRole('button', { name: '缩小图片', exact: true }).click(); await pagerZoomReady(page); await tick(page);
        const after = await zoomRegion(page);
        assert(Math.abs(after.v - before.v) < .005, 'zoom bounds must preserve the vertical detail while clamping an image that fits horizontally');
        const expectedLeft = await page.locator('.gallery-image-pager-stage').evaluate((stage, u) => {
          const bounds = stage.getBoundingClientRect(), rect = stage.querySelector('img').getBoundingClientRect();
          return Math.max(0, Math.min(stage.scrollWidth - stage.clientWidth, stage.scrollLeft + rect.left + rect.width * u - bounds.left - stage.clientLeft - stage.clientWidth / 2));
        }, before.u);
        assert(Math.abs(after.left - expectedLeft) < 1, 'horizontal zoom anchoring must clamp to the actual image scroll range');
        assert(after.imagePoint);
      } finally { full.release(); await page.close(); }
    });
    await run('pager zoom anchor: same-image metadata does not interrupt the animated detail', async () => {
      const page = await newPage({ real: true });
      const full = hold(url => url.pathname === '/api/photo-sets/A' && url.searchParams.get('imageLimit') === 'all');
      try {
        await clickAlbum(page, 'A'); await readerTitle(page, 'Album A'); await page.locator('.gallery-reader-open').click(); await requested(full); await page.setViewportSize({ width: 320, height: 640 });
        for (let index = 0; index < 6; index++) await page.keyboard.press('+'); await pagerZoomReady(page); await tick(page);
        await page.locator('.gallery-image-pager-stage').evaluate(stage => { stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) * .5; stage.scrollTop = (stage.scrollHeight - stage.clientHeight) * .5; window.__zoomImage = stage.querySelector('img'); });
        const before = await zoomRegion(page);
        await page.getByRole('button', { name: '放大图片', exact: true }).click(); await settle(page, full); await pagerZoomReady(page); await tick(page);
        const after = await zoomRegion(page);
        assert.equal(await page.locator('.gallery-image-pager-range').getAttribute('max'), '10000');
        assert(Math.abs(after.u - before.u) < .005 && Math.abs(after.v - before.v) < .005, 'same-image directory completion must preserve the detail of an active zoom transition');
        assert.equal(await page.evaluate(() => __zoomImage === document.querySelector('.gallery-image-pager-stage img')), true);
      } finally { full.release(); await page.close(); }
    });
    for (const intent of ['wheel', 'focus']) await run(`pager zoom anchor: deferred frames yield to newer ${intent} intent`, async () => {
      const page = await newPage({ real: true });
      const full = hold(url => url.pathname === '/api/photo-sets/A' && url.searchParams.get('imageLimit') === 'all');
      try {
        await clickAlbum(page, 'A'); await readerTitle(page, 'Album A'); await page.locator('.gallery-reader-open').click(); await requested(full); await page.setViewportSize({ width: 320, height: 640 });
        for (let index = 0; index < 4; index++) await page.keyboard.press('+'); await pagerZoomReady(page); await tick(page);
        await page.locator('.gallery-image-pager-stage').evaluate(stage => { stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) * .4; stage.scrollTop = (stage.scrollHeight - stage.clientHeight) * .35; });
        await holdZoomFrames(page);
        await page.getByRole('button', { name: '放大图片', exact: true }).click(); await pagerZoomReady(page);
        if (intent === 'wheel') {
          const top = await page.locator('.gallery-image-pager-stage').evaluate(stage => stage.scrollTop);
          await page.mouse.move(160, 240); await page.mouse.wheel(0, 100);
          await page.waitForFunction(top => document.querySelector('.gallery-image-pager-stage').scrollTop >= top + 99, top);
        } else await page.locator('.gallery-image-pager-range').focus();
        const before = await zoomRegion(page);
        await page.evaluate(() => __zoomFrames.splice(0).forEach(callback => callback(performance.now()))); await tick(page);
        const after = await zoomRegion(page);
        assert.deepEqual([after.left, after.top, after.source, after.imagePoint], [before.left, before.top, before.source, before.imagePoint],
          'a late zoom frame must yield to a newer scroll or focus instead of pulling the image back');
        assert(Math.abs(after.u - before.u) < .001 && Math.abs(after.v - before.v) < .001,
          'a late zoom frame must yield to a newer scroll or focus instead of pulling the image back');
        if (intent === 'focus') assert.equal(await page.locator('.gallery-image-pager-range').evaluate(input => input === document.activeElement), true);
      } finally { full.release(); await page.close(); }
    });
    await run('pager zoom anchor: an obsolete frame cannot cancel the zoom of a newer image', async () => {
      const page = await newPage({ real: true });
      const full = hold(url => url.pathname === '/api/photo-sets/A' && url.searchParams.get('imageLimit') === 'all');
      try {
        await clickAlbum(page, 'A'); await readerTitle(page, 'Album A'); await page.locator('.gallery-reader-open').click(); await requested(full); await page.setViewportSize({ width: 320, height: 640 });
        await holdZoomFrames(page); await page.getByRole('button', { name: '放大图片', exact: true }).click();
        await page.waitForFunction(() => __zoomFrames.length > 0);
        await page.getByRole('button', { name: '下一张', exact: true }).click(); await page.locator('.gallery-image-pager-stage img').evaluate(image => image.decode()); await pagerZoomReady(page);
        await page.locator('.gallery-image-pager-stage').focus(); await page.keyboard.press('+'); await pagerZoomReady(page);
        assert.equal(await page.evaluate(() => __zoomFrames.length), 2);
        await page.evaluate(() => { __zoomFrames[0](performance.now()); __zoomFrames[1](performance.now()); }); await tick(page);
        const after = await zoomRegion(page);
        assert(after.top > 10 && Math.abs(after.v - .5) < .005, 'an obsolete zoom frame must not stop the current image zoom session');
        assert.equal(after.source, '/synthetic/A/2.svg');
        await page.keyboard.press('Escape'); await page.locator('.gallery-reader-open').click();
        await page.evaluate(() => __zoomFrames.forEach(callback => callback(performance.now()))); await tick(page);
        assert.equal(await page.locator('.gallery-image-pager-zoom').textContent(), '100%');
        assert.deepEqual(await page.locator('.gallery-image-pager-stage').evaluate(stage => [stage.scrollLeft, stage.scrollTop]), [0, 0]);
      } finally { full.release(); await page.close(); }
    });
    await run('pager keyboard pan: a magnified image can be inspected vertically without changing photos', async () => {
      const page = await newPage({ real: true });
      const full = hold(url => url.pathname === '/api/photo-sets/A' && url.searchParams.get('imageLimit') === 'all');
      try {
        await clickAlbum(page, 'A'); await readerTitle(page, 'Album A'); await page.locator('.gallery-reader-open').click(); await requested(full);
        await page.keyboard.press('+'); await page.keyboard.press('+'); await pagerZoomReady(page); await tick(page);
        const stage = page.locator('.gallery-image-pager-stage'); await stage.focus(); await stage.evaluate(stage => stage.scrollTo({ left: 0, top: 0, behavior: 'auto' }));
        const before = await stage.evaluate(stage => ({ top: stage.scrollTop, max: stage.scrollHeight - stage.clientHeight, src: stage.querySelector('img').getAttribute('src') }));
        assert(before.max > 100, 'keyboard inspection must use a real magnified image with overflow');
        await page.keyboard.press('ArrowDown'); await tick(page);
        const after = await stage.evaluate(stage => ({ top: stage.scrollTop, src: stage.querySelector('img').getAttribute('src'), range: document.querySelector('.gallery-image-pager-range').value }));
        console.log(JSON.stringify({ mode: 'gallery-keyboard-pan', before, after }));
        assert.equal(after.src, before.src, 'vertical inspection of a magnified focused image must not change the current photo');
        await page.waitForFunction(() => document.querySelector('.gallery-image-pager-stage').scrollTop > 20);
        const down = await stage.evaluate(stage => stage.scrollTop);
        await page.keyboard.press('ArrowUp'); await page.waitForFunction(() => document.querySelector('.gallery-image-pager-stage').scrollTop < 1);
        await page.keyboard.press('PageDown'); await page.waitForFunction(() => document.querySelector('.gallery-image-pager-stage').scrollTop > 150);
        await page.keyboard.press('PageUp'); await page.waitForFunction(() => document.querySelector('.gallery-image-pager-stage').scrollTop < 1);
        assert.equal(await page.locator('.gallery-image-pager-range').inputValue(), '1');
        assert.equal(await page.locator('.gallery-image-pager-zoom').textContent(), '150%');
        assert.equal(await stage.evaluate(stage => stage === document.activeElement), true);
        console.log(JSON.stringify({ mode: 'gallery-native-keyboard-vertical', down, range: 1, zoom: '150%' }));
      } finally { full.release(); await page.close(); }
    });
    for (const width of [1280, 320]) await run(`pager keyboard pan: native horizontal boundaries and fitted navigation ${width}px`, async () => {
      const page = await newPage({ real: true });
      const full = hold(url => url.pathname === '/api/photo-sets/A' && url.searchParams.get('imageLimit') === 'all');
      try {
        await clickAlbum(page, 'A'); await readerTitle(page, 'Album A'); await page.locator('.gallery-reader-open').click(); await requested(full);
        await page.setViewportSize({ width, height: width === 320 ? 640 : 900 });
        const stage = page.locator('.gallery-image-pager-stage'); await stage.focus();
        for (let index = 0; index < 8; index++) await page.keyboard.press('+');
        await pagerZoomReady(page); await tick(page);
        await stage.evaluate(stage => { stage.scrollLeft = 0; stage.scrollTop = 0; });
        assert(await stage.evaluate(stage => stage.scrollWidth - stage.clientWidth > 30), 'keyboard inspection must use actual horizontal image overflow');
        await page.evaluate(() => { window.__keyboardImage = document.querySelector('.gallery-image-pager-stage img'); });
        await page.keyboard.press('ArrowRight');
        await tick(page);
        assert.equal(await page.locator('.gallery-image-pager-range').inputValue(), '1', 'horizontal inspection of a magnified focused image must not switch photos');
        await page.waitForFunction(() => document.querySelector('.gallery-image-pager-stage').scrollLeft > 20);
        await page.keyboard.press('ArrowLeft'); await page.waitForFunction(() => document.querySelector('.gallery-image-pager-stage').scrollLeft < 1);
        await stage.evaluate(stage => stage.scrollLeft = stage.scrollWidth - stage.clientWidth);
        await page.keyboard.press('ArrowRight'); await tick(page);
        assert.equal(await page.locator('.gallery-image-pager-range').inputValue(), '1', 'the magnified scroll boundary must not unexpectedly advance to another photo');
        assert.equal(await page.evaluate(() => __keyboardImage === document.querySelector('.gallery-image-pager-stage img')), true);
        await page.keyboard.press('0'); await page.keyboard.press('ArrowRight');
        assert.equal(await page.locator('.gallery-image-pager-range').inputValue(), '2', 'fitted image arrow navigation must retain its existing page-switch behavior');
        assert.equal(await page.locator('.gallery-image-pager-zoom').textContent(), '100%');
      } finally { full.release(); await page.close(); }
    });
    await run('pager keyboard pan: other focused controls and closed readers keep their existing keys', async () => {
      const page = await newPage({ real: true });
      const full = hold(url => url.pathname === '/api/photo-sets/A' && url.searchParams.get('imageLimit') === 'all');
      try {
        await clickAlbum(page, 'A'); await readerTitle(page, 'Album A'); await page.locator('.gallery-reader-open').click(); await requested(full);
        await page.keyboard.press('+'); await page.keyboard.press('+'); await pagerZoomReady(page);
        const zoom = page.locator('.gallery-image-pager-zoom'); await zoom.focus(); await page.keyboard.press('ArrowDown');
        assert.equal(await page.locator('.gallery-image-pager-range').inputValue(), '2', 'magnification must not change keys belonging to a different focused reader control');
        await page.locator('.gallery-image-pager-stage img').evaluate(image => image.decode());
        await page.keyboard.press('+'); await page.locator('.gallery-image-pager-range').focus(); await page.keyboard.press('Home');
        assert.equal(await page.locator('.gallery-image-pager-range').inputValue(), '1');
        await page.locator('.gallery-image-pager-counter').click();
        const input = page.locator('.gallery-image-pager-jump input'); await input.fill('12'); await input.press('Home'); await input.press('ArrowRight');
        assert.deepEqual(await input.evaluate(input => [input.selectionStart, input.selectionEnd]), [1, 1]);
        assert.equal(await page.locator('.gallery-image-pager-range').inputValue(), '1');
        await input.press('Escape'); await page.keyboard.press('Escape');
        assert.equal(await page.locator('.gallery-image-pager').count(), 0);
        assert.equal(await page.evaluate(() => { const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }); document.dispatchEvent(event); return event.defaultPrevented; }), false,
          'closing the reader must release its keyboard handler');
      } finally { full.release(); await page.close(); }
    });
    for (const entry of ['toolbar', 'figure']) await run(`pager catalog recovery: failed directory retries from the ${entry} entry`, async () => {
      const page = await newPage({ real: true });
      const full = hold(url => url.pathname === '/api/photo-sets/A' && url.searchParams.get('imageLimit') === 'all', 'Synthetic full directory unavailable');
      const initialReads = countRequests(full.match), initialImages = countRequests(url => url.pathname.startsWith('/synthetic/A/'));
      try {
        await clickAlbum(page, 'A'); await readerTitle(page, 'Album A');
        if (entry === 'toolbar') await page.locator('.gallery-reader-open').click();
        else { await page.locator('.gallery-reader-figure img').first().evaluate(image => image.decode()); await page.locator('.gallery-reader-figure').first().press('Enter'); }
        await requested(full);
        await page.keyboard.press('End'); await page.keyboard.press('+');
        await settle(page, full);
        const before = await page.evaluate(() => ({ counter: document.querySelector('.gallery-image-pager-counter').textContent,
          max: document.querySelector('.gallery-image-pager-range').max, nextDisabled: document.querySelector('.gallery-image-pager-control-row button:last-child').disabled,
          recovery: Boolean(document.querySelector('.gallery-image-pager-catalog-retry')), text: document.querySelector('.gallery-image-pager').textContent.includes('Synthetic full directory unavailable') }));
        console.log(JSON.stringify({ mode: 'gallery-full-directory-failure', before }));
        assert.equal(await page.locator('.gallery-image-pager-catalog-retry').isVisible(), true,
          'a failed full directory must offer recovery instead of silently trapping a large album at its initial loaded range');
        await page.locator('.gallery-image-pager-stage img').evaluate(image => image.decode());
        await page.evaluate(() => { window.__catalogSnapshot = { pager: document.querySelector('.gallery-image-pager'), image: document.querySelector('.gallery-image-pager-stage img'),
          reader: document.querySelector('.gallery-reader-images'), figures: [...document.querySelectorAll('.gallery-reader-figure')], counter: document.querySelector('.gallery-image-pager-counter') }; });
        const retry = page.locator('.gallery-image-pager-catalog-retry');
        const repeated = hold(full.match, 'Synthetic repeated directory error');
        await retry.focus(); await retry.press('Enter'); await requested(repeated);
        await retry.evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        assert.equal(countRequests(full.match) - initialReads, 2, 'repeated retry input must share one full-directory read');
        const newerFocus = page.getByRole('button', { name: '放大图片', exact: true });
        if (entry === 'figure') await newerFocus.focus();
        await settle(page, repeated);
        assert.equal(await (entry === 'figure' ? newerFocus : retry).evaluate(control => control === document.activeElement), true,
          'a repeated catalog failure must respect newer focus or keep the original retry reachable');
        const recovered = hold(full.match);
        await retry.focus(); await retry.press('Enter'); await requested(recovered);
        if (entry === 'toolbar') {
          await page.locator('.gallery-image-pager-counter').click(); await page.locator('.gallery-image-pager-jump input').fill('6789');
          await page.locator('.gallery-image-pager-jump input').evaluate(input => { input.setSelectionRange(1, 3); window.__catalogDraft = input; });
        } else await newerFocus.focus();
        await settle(page, recovered);
        assert.equal(await page.locator('.gallery-image-pager-range').getAttribute('max'), '10000', 'a successful catalog retry must restore the full navigation range');
        assert.equal(await page.locator('.gallery-image-pager-catalog').isVisible(), false);
        assert.match(await page.locator('.gallery-image-pager-counter').textContent(), /第 160 \/ 10,000 张/);
        assert.equal(await page.locator('.gallery-image-pager-zoom').textContent(), '125%');
        assert.equal(await page.evaluate(() => __catalogSnapshot.pager === document.querySelector('.gallery-image-pager') && __catalogSnapshot.image === document.querySelector('.gallery-image-pager-stage img')
          && __catalogSnapshot.reader === document.querySelector('.gallery-reader-images') && __catalogSnapshot.figures.every((figure, index) => figure === document.querySelectorAll('.gallery-reader-figure')[index])
          && __catalogSnapshot.counter === document.querySelector('.gallery-image-pager-counter')), true, 'directory recovery must retain the current image, controls and all loaded reader figures');
        if (entry === 'toolbar') {
          assert.deepEqual(await page.locator('.gallery-image-pager-jump input').evaluate(input => [input === __catalogDraft, input === document.activeElement, input.value, input.selectionStart, input.selectionEnd]), [true, true, '6789', 1, 3],
            'directory recovery must preserve the current jump draft, selection and focus');
          await page.keyboard.press('Escape');
        } else assert.equal(await newerFocus.evaluate(button => button === document.activeElement), true);
        const imagesRead = countRequests(url => url.pathname.startsWith('/synthetic/A/')) - initialImages;
        assert(imagesRead < 60, 'loading the complete directory must not request every full-size image');
        console.log(JSON.stringify({ mode: 'gallery-catalog-recovered', entry, fullReads: countRequests(full.match) - initialReads, range: 10000, imagesRead, retainedFigures: await page.locator('.gallery-reader-figure').count() }));
      } finally { full.release(); await page.close(); }
    });
    await run('pager catalog recovery: closing and reopening shares the pending retry', async () => {
      const page = await newPage({ real: true });
      const first = hold(url => url.pathname === '/api/photo-sets/A' && url.searchParams.get('imageLimit') === 'all', 'Synthetic directory error');
      const initialReads = countRequests(first.match);
      try {
        await clickAlbum(page, 'A'); await readerTitle(page, 'Album A'); await page.locator('.gallery-reader-open').click(); await requested(first); await settle(page, first);
        const retried = hold(first.match); await page.locator('.gallery-image-pager-catalog-retry').click(); await requested(retried);
        await page.evaluate(() => { window.__oldCatalogRetry = document.querySelector('.gallery-image-pager-catalog-retry'); });
        await page.keyboard.press('Escape'); await page.locator('.gallery-reader-open').click();
        await page.evaluate(() => __oldCatalogRetry.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        await tick(page); assert.equal(countRequests(first.match) - initialReads, 2, 'a reopened reader must reuse the existing page-owned catalog retry');
        await page.locator('.gallery-image-pager-range').focus(); await settle(page, retried);
        assert.equal(await page.locator('.gallery-image-pager-range').getAttribute('max'), '10000');
        assert.equal(await page.locator('.gallery-image-pager-range').evaluate(input => input === document.activeElement), true);
      } finally { first.release(); await page.close(); }
    });
    for (const error of ['', 'Synthetic old retry error']) await run(`pager catalog recovery: old ${error ? 'failure' : 'success'} cannot affect a newer album request`, async () => {
      const page = await newPage({ real: true });
      const first = hold(url => url.pathname === '/api/photo-sets/A' && url.searchParams.get('imageLimit') === 'all', 'Synthetic directory error');
      try {
        await clickAlbum(page, 'A'); await readerTitle(page, 'Album A'); await page.locator('.gallery-reader-open').click(); await requested(first); await settle(page, first);
        const old = hold(first.match, error); await page.locator('.gallery-image-pager-catalog-retry').click(); await requested(old);
        await page.keyboard.press('Escape'); await page.locator('.gallery-reader-back').click(); await clickAlbum(page, 'B'); await readerTitle(page, 'Album B');
        const current = hold(url => url.pathname === '/api/photo-sets/B' && url.searchParams.get('imageLimit') === 'all');
        await page.locator('.gallery-reader-open').click(); await requested(current); await page.keyboard.press('ArrowRight'); await page.keyboard.press('+');
        await page.locator('.gallery-image-pager-range').focus();
        await page.evaluate(() => { window.__newCatalogPager = document.querySelector('.gallery-image-pager'); window.__newCatalogImage = document.querySelector('.gallery-image-pager-stage img'); });
        await settle(page, old);
        assert.equal(await page.locator('.gallery-image-pager-catalog').getAttribute('aria-busy'), 'true', 'an obsolete request must not release the newer album catalog busy state');
        assert.equal(await page.locator('.gallery-image-pager-catalog-retry').isVisible(), false);
        await settle(page, current);
        assert.equal(await page.evaluate(() => __newCatalogPager === document.querySelector('.gallery-image-pager') && __newCatalogImage === document.querySelector('.gallery-image-pager-stage img')), true);
        assert.match(await page.locator('.gallery-image-pager-counter').textContent(), /第 2 \/ 10,000 张/);
        assert.equal(await page.locator('.gallery-image-pager-zoom').textContent(), '125%');
        assert.equal(await page.locator('.gallery-image-pager-range').evaluate(input => input === document.activeElement), true);
      } finally { first.release(); await page.close(); }
    });
    await run('pager catalog recovery: directory and image retries remain reachable at 320px', async () => {
      const page = await newPage({ real: true });
      const full = hold(url => url.pathname === '/api/photo-sets/A' && url.searchParams.get('imageLimit') === 'all', 'Synthetic directory unavailable');
      try {
        await page.route('**/synthetic/A/1.svg', route => route.fulfill({ status: 503, contentType: 'text/plain', body: 'Synthetic image failure' }));
        await clickAlbum(page, 'A'); await readerTitle(page, 'Album A'); await page.locator('.gallery-reader-open').click(); await requested(full); await settle(page, full);
        await page.setViewportSize({ width: 320, height: 640 }); await tick(page);
        for (const selector of ['.gallery-image-pager-catalog-retry', '.gallery-image-pager-retry']) assert(await page.locator(selector).evaluate(button => { const rect = button.getBoundingClientRect(); return rect.height >= 44 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight && button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)); }),
          'directory recovery and image recovery must remain independently clickable in a narrow reader');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        const directory = path.join(root, '.codex-artifacts', 'gallery'); fs.mkdirSync(directory, { recursive: true });
        await page.screenshot({ path: path.join(directory, 'catalog-recovery-320.png') });
      } finally { full.release(); await page.close(); }
    });
    await run('pager fullscreen policy: denied native capability does not offer a broken action', async () => {
      fullscreenDenied = true;
      const page = await newPage({ real: true });
      const full = hold(url => url.pathname === '/api/photo-sets/A' && url.searchParams.get('imageLimit') === 'all');
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      try {
        await clickAlbum(page, 'A'); await readerTitle(page, 'Album A'); await page.locator('.gallery-reader-open').click(); await requested(full);
        assert.equal(await page.evaluate(() => document.fullscreenEnabled), false, 'the actual browser must enforce the synthetic document Permissions-Policy');
        const button = page.getByRole('button', { name: '全屏', exact: true });
        const offered = await button.isVisible();
        if (offered) { await button.click(); await tick(page); }
        console.log(JSON.stringify({ mode: 'gallery-fullscreen-policy', supported: false, offered, errors }));
        assert.equal(offered, false, 'a native policy-disabled fullscreen action must be hidden instead of producing an unhandled rejection');
        await page.keyboard.press('ArrowRight');
        assert.match(await page.locator('.gallery-image-pager-counter').textContent(), /第 2 \/ 160 张/);
      } finally { fullscreenDenied = false; full.release(); await page.close(); }
    });
    await run('pager fullscreen lifecycle: native entry and exit retain the actual image and reading controls', async () => {
      const page = await newPage({ real: true });
      const full = hold(url => url.pathname === '/api/photo-sets/A' && url.searchParams.get('imageLimit') === 'all');
      try {
        await clickAlbum(page, 'A'); await readerTitle(page, 'Album A'); await page.locator('.gallery-reader-open').click(); await requested(full);
        await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('+'); await page.keyboard.press('+'); await pagerZoomReady(page);
        await page.evaluate(() => { window.__fsImage = document.querySelector('.gallery-image-pager-stage img'); window.__fsOverlay = document.querySelector('.gallery-image-pager'); document.querySelector('.gallery-image-pager-stage').scrollTop = 40; });
        const button = page.locator('[data-gallery-fullscreen]');
        const reads = countRequests(url => url.pathname.startsWith('/api/'));
        for (const active of [true, false]) {
          await button.click(); await page.waitForFunction(active => Boolean(document.fullscreenElement) === active, active); await tick(page);
          assert.equal(await page.evaluate(() => __fsImage === document.querySelector('.gallery-image-pager-stage img') && __fsOverlay === document.querySelector('.gallery-image-pager')), true);
          assert.equal(await page.locator('.gallery-image-pager-zoom').textContent(), '150%');
          assert.match(await page.locator('.gallery-image-pager-counter').textContent(), /第 3 \/ 160 张/);
          assert.equal(await button.getAttribute('aria-pressed'), String(active));
          assert.equal(await button.evaluate(button => button === document.activeElement), true, 'native fullscreen must preserve the focused reader control');
          assert.equal(countRequests(url => url.pathname.startsWith('/api/')), reads);
        }
        await page.keyboard.press('ArrowRight'); assert.match(await page.locator('.gallery-image-pager-counter').textContent(), /第 4 \/ 160 张/);
        await page.keyboard.press('Escape'); assert.equal(await page.locator('.gallery-image-pager').count(), 0);
        assert.equal(await page.locator('.gallery-reader-open').evaluate(button => button === document.activeElement), true);
      } finally { full.release(); await page.close(); }
    });
    await run('pager fullscreen lifecycle: a rejected native transition can be retried in the same reader', async () => {
      const page = await newPage({ real: true });
      const full = hold(url => url.pathname === '/api/photo-sets/A' && url.searchParams.get('imageLimit') === 'all');
      try {
        await clickAlbum(page, 'A'); await readerTitle(page, 'Album A'); await page.locator('.gallery-reader-open').click(); await requested(full);
        await page.setViewportSize({ width: 320, height: 640 });
        await page.evaluate(() => {
          const overlay = document.querySelector('.gallery-image-pager'), native = overlay.requestFullscreen.bind(overlay);
          window.__fsCalls = 0; window.__fsImage = overlay.querySelector('img');
          overlay.requestFullscreen = () => ++__fsCalls === 1 ? Promise.reject(new Error('Synthetic temporary fullscreen rejection')) : native();
        });
        const button = page.locator('[data-gallery-fullscreen]'); await button.click();
        await page.waitForFunction(() => document.querySelector('[data-gallery-fullscreen]').getAttribute('aria-busy') === 'false');
        assert.equal(await page.locator('.gallery-image-pager-fullscreen-status').evaluate(node => !node.hidden && node.textContent.includes('请重试')), true,
          'a fullscreen rejection needs visible retry feedback in the current reader');
        assert.equal(await button.evaluate(button => button === document.activeElement), true);
        assert.equal(await page.evaluate(() => __fsImage === document.querySelector('.gallery-image-pager-stage img')), true);
        const directory = path.join(root, '.codex-artifacts', 'gallery'); fs.mkdirSync(directory, { recursive: true });
        await page.screenshot({ path: path.join(directory, 'pager-fullscreen-error-320.png') });
        await button.click(); await page.waitForFunction(() => document.fullscreenElement === document.querySelector('.gallery-image-pager'));
        assert.equal(await page.locator('.gallery-image-pager-fullscreen-status').evaluate(node => node.hidden), true);
        await page.evaluate(() => { window.__fsExit = document.exitFullscreen.bind(document); document.exitFullscreen = () => Promise.reject(new Error('Synthetic temporary exit rejection')); });
        await button.click(); await page.waitForFunction(() => document.querySelector('[data-gallery-fullscreen]').getAttribute('aria-busy') === 'false');
        assert.equal(await page.locator('.gallery-image-pager-fullscreen-status').evaluate(node => !node.hidden), true);
        assert.equal(await button.getAttribute('aria-pressed'), 'true');
        await page.evaluate(() => { document.exitFullscreen = __fsExit; });
        await button.click(); await page.waitForFunction(() => !document.fullscreenElement);
        assert.equal(await page.evaluate(() => __fsCalls), 2);
      } finally { full.release(); await page.close(); }
    });
    await run('pager fullscreen lifecycle: a pending native promise remains single flight and respects later focus', async () => {
      const page = await newPage({ real: true });
      const full = hold(url => url.pathname === '/api/photo-sets/A' && url.searchParams.get('imageLimit') === 'all');
      try {
        await clickAlbum(page, 'A'); await readerTitle(page, 'Album A'); await page.locator('.gallery-reader-open').click(); await requested(full);
        await page.evaluate(() => {
          const overlay = document.querySelector('.gallery-image-pager'), native = overlay.requestFullscreen.bind(overlay), exit = document.exitFullscreen.bind(document);
          window.__fsCalls = window.__fsExits = 0;
          overlay.requestFullscreen = async () => { __fsCalls++; await native(); await new Promise(resolve => { window.__releaseFullscreen = resolve; }); };
          document.exitFullscreen = () => { __fsExits++; return exit(); };
        });
        const button = page.locator('[data-gallery-fullscreen]'); await button.click(); await page.waitForFunction(() => Boolean(window.__releaseFullscreen) && document.fullscreenElement === document.querySelector('.gallery-image-pager'));
        const rect = await button.boundingBox(); await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
        await page.keyboard.press('f'); await tick(page);
        assert.equal(await page.evaluate(() => __fsCalls === 1 && __fsExits === 0), true, 'a pending fullscreen request must not start another native enter or exit');
        await page.keyboard.press('+'); await page.locator('.gallery-image-pager-range').focus();
        await page.evaluate(() => __releaseFullscreen());
        await page.waitForFunction(() => document.querySelector('[data-gallery-fullscreen]').getAttribute('aria-busy') === 'false');
        assert.equal(await page.locator('.gallery-image-pager-range').evaluate(input => input === document.activeElement), true, 'late native completion must respect the newer focused control');
        assert.equal(await page.locator('.gallery-image-pager-zoom').textContent(), '125%');
        assert.equal(await page.evaluate(() => document.fullscreenElement === document.querySelector('.gallery-image-pager')), true);
      } finally { await page.evaluate(() => window.__releaseFullscreen?.()).catch(() => {}); full.release(); await page.close(); }
    });
    for (const result of ['success', 'rejection']) await run(`pager fullscreen lifecycle: late ${result} preserves a newer reader`, async () => {
      const page = await newPage({ real: true });
      const full = hold(url => url.pathname === '/api/photo-sets/A' && url.searchParams.get('imageLimit') === 'all');
      try {
        await clickAlbum(page, 'A'); await readerTitle(page, 'Album A'); await page.locator('.gallery-reader-open').click(); await requested(full);
        await page.evaluate(result => {
          const overlay = document.querySelector('.gallery-image-pager'), native = overlay.requestFullscreen.bind(overlay);
          overlay.requestFullscreen = async () => {
            try { await native(); await new Promise((resolve, reject) => { window.__releaseOldFullscreen = () => result === 'success' ? resolve() : reject(new Error('Synthetic old fullscreen rejection')); }); }
            finally { window.__oldFullscreenSettled = true; }
          };
        }, result);
        await page.locator('[data-gallery-fullscreen]').click(); await page.waitForFunction(() => Boolean(window.__releaseOldFullscreen));
        await page.locator('.gallery-image-pager-top > button').click(); await page.waitForFunction(() => !document.fullscreenElement);
        if (result === 'rejection') { await page.locator('.gallery-reader-back').click(); await clickAlbum(page, 'B'); await readerTitle(page, 'Album B'); }
        await page.locator('.gallery-reader-open').click(); await page.locator('[data-gallery-fullscreen]').click();
        await page.waitForFunction(() => document.fullscreenElement === document.querySelector('.gallery-image-pager'));
        await page.keyboard.press('+'); await page.locator('.gallery-image-pager-counter').focus();
        await page.evaluate(() => { window.__newFullscreenReader = document.querySelector('.gallery-image-pager'); __releaseOldFullscreen(); });
        await page.waitForFunction(() => window.__oldFullscreenSettled); await tick(page);
        assert.equal(await page.evaluate(() => document.fullscreenElement === __newFullscreenReader && __newFullscreenReader === document.querySelector('.gallery-image-pager')), true,
          'an old fullscreen completion must not exit fullscreen owned by a newer reader');
        assert.equal(await page.locator('.gallery-image-pager-fullscreen-status').evaluate(node => node.hidden), true);
        assert.equal(await page.locator('.gallery-image-pager-counter').evaluate(button => button === document.activeElement), true);
        assert.equal(await page.locator('.gallery-image-pager-zoom').textContent(), '125%');
      } finally { await page.evaluate(() => window.__releaseOldFullscreen?.()).catch(() => {}); full.release(); await page.close(); }
    });
    await run('pager fullscreen lifecycle: external fullscreen ownership remains untouched', async () => {
      const page = await newPage({ real: true });
      const full = hold(url => url.pathname === '/api/photo-sets/A' && url.searchParams.get('imageLimit') === 'all');
      try {
        await clickAlbum(page, 'A'); await readerTitle(page, 'Album A');
        await page.evaluate(() => { const button = document.createElement('button'); button.id = 'external-fullscreen'; button.textContent = 'Synthetic external fullscreen'; button.onclick = () => document.documentElement.requestFullscreen(); document.body.append(button); });
        await page.locator('#external-fullscreen').click(); await page.waitForFunction(() => document.fullscreenElement === document.documentElement);
        await page.locator('.gallery-reader-open').click(); await requested(full);
        assert.equal(await page.locator('[data-gallery-fullscreen]').isVisible(), false);
        await page.keyboard.press('f'); await page.locator('.gallery-image-pager-top > button').click(); await tick(page);
        assert.equal(await page.evaluate(() => document.fullscreenElement === document.documentElement), true, 'closing an image reader must not exit fullscreen acquired outside that reader');
      } finally { full.release(); await page.close(); }
    });
    for (const error of ["", "old reader error"]) {
      await run(`host late album ${error ? "error" : "success"}`, async () => {
        const page = await newPage({ real: true });
        try {
          const late = hold(url => url.pathname === "/api/photo-sets/A", error);
          await clickAlbum(page, "A"); await requested(late); await clickAlbum(page, "B"); await readerTitle(page, "Album B"); await settle(page, late);
          assert.equal(await page.locator(".gallery-reader-title strong").textContent(), "Album B");
          assert.match(page.url(), /\/photo\/set\/B/, "stale album must not rewrite the actual standalone route");
          assert(!(await page.locator("#workGrid").textContent()).includes("old reader error"));
          assert(await page.evaluate(() => __transport.aborted.length > 0), "new intent must abort even when the transport ignores the signal");
        } finally { await page.close(); }
      });
      await run(`host back late pagination ${error ? "error" : "success"}`, async () => {
        const page = await newPage({ real: true });
        try {
          await clickAlbum(page, "A"); await readerTitle(page, "Album A");
          const late = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.has("imageOffset"), error);
          await more(page); await requested(late); await page.locator(".gallery-reader-back").click(); await page.locator(".gallery-card").first().waitFor(); await settle(page, late);
          assert.equal(await page.locator(".gallery-reader-title").count(), 0, "back must not be undone by late pagination");
          assert(!(await page.locator("#workGrid").textContent()).includes("old reader error")); assert.equal(new URL(page.url()).pathname, "/photo/albums");
        } finally { await page.close(); }
      });
      await run(`pagination owner and finally ${error ? "error" : "success"}`, async () => {
        const page = await newPage();
        try {
          await open(page, "A"); const old = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.has("imageOffset"), error);
          await more(page); await requested(old); await open(page, "B");
          const current = hold(url => url.pathname === "/api/photo-sets/B" && url.searchParams.has("imageOffset"));
          await more(page); await requested(current); await settle(page, old);
          assert.deepEqual(await page.evaluate(() => ({ id: fixture.state.gallery.album.id, count: fixture.state.gallery.album.images.length, status: fixture.state.gallery.status, disabled: document.querySelector(".gallery-more").disabled })),
            { id: "B", count: 160, status: "正在继续读取图片", disabled: true }, "old finally/error must not clear the current loading owner");
          await settle(page, current); assert.equal(await page.evaluate(() => fixture.state.gallery.album.images.length), 320); assert.equal(await page.locator(".gallery-more").isDisabled(), false);
        } finally { await page.close(); }
      });
    }
    await run("normal transport abort", async () => {
      const page = await newPage({ ignoreAbort: false });
      try {
        const old = hold(url => url.pathname === "/api/photo-sets/A");
        await page.evaluate(() => { fixture.pending = fixture.page.openPhotoSet("A"); }); await requested(old); await open(page, "B"); await page.evaluate(() => fixture.pending);
        assert.equal(await page.evaluate(() => fixture.state.gallery.album.id), "B"); await until(() => old.closed, "aborted transport must close"); old.release();
      } finally { await page.close(); }
    });
    for (const summaryError of ["", "obsolete summary failure"]) for (const readerState of ["pending", "failed", "loaded"]) {
      await run(`late summary ${summaryError ? "failure" : "success"} preserves ${readerState} reader status`, async () => {
        const page = await newPage();
        const summary = hold(url => url.pathname === "/api/image-library/summary", summaryError);
        const current = hold(url => url.pathname === "/api/photo-sets/B", readerState === "failed" ? "current reader failure" : "");
        try {
          await page.evaluate(() => { fixture.summaryTask = fixture.page.loadImageLibrary({ reload: true }); });
          await requested(summary);
          await page.evaluate(() => { fixture.readerTask = fixture.page.openPhotoSet("B"); });
          await requested(current);
          if (readerState !== "pending") { await settle(page, current); await page.evaluate(() => fixture.readerTask); }
          const expectedStatus = readerState === "pending" ? "正在读取套图" : readerState === "failed" ? "current reader failure" : "";
          assert.equal(await page.evaluate(() => fixture.state.gallery.status), expectedStatus);
          await settle(page, summary); await page.evaluate(() => fixture.summaryTask);
          assert.equal(await page.evaluate(() => fixture.state.gallery.status), expectedStatus, "summary completion cannot own a newer reader's status");
          if (readerState !== "loaded") assert.equal(await page.locator(".gallery-status").textContent(), expectedStatus);
          assert.equal(await page.evaluate(() => fixture.state.gallery.loading), false);
          if (!summaryError) assert.equal(await page.evaluate(() => fixture.state.gallery.data.scannedAt), "synthetic", "reader ownership must not discard fresh library metadata");
          await page.evaluate(() => fixture.page.loadImageLibrary());
          assert.equal(await page.evaluate(() => fixture.state.gallery.status), expectedStatus, "cached library metadata must also preserve reader status");
          if (readerState === "pending") { await settle(page, current); await page.evaluate(() => fixture.readerTask); }
          if (readerState !== "failed") assert.equal(await page.evaluate(() => fixture.state.gallery.album.id), "B");
        } finally { summary.release(); current.release(); await page.close(); }
      });
    }
    await run("library summary still owns list status and all gallery modes", async () => {
      const page = await newPage();
      try {
        for (const mode of ["photo", "manga", "western", "media", "movie", "tv"]) {
          await page.evaluate(value => { fixture.page.resetReader(); fixture.state.gallery.mode = value; return fixture.page.loadImageLibrary({ reload: true }); }, mode);
          assert.equal(await page.evaluate(() => fixture.state.gallery.status), "索引 synthetic");
        }
        const summary = hold(url => url.pathname === "/api/image-library/summary", "current summary failure");
        await page.evaluate(() => { fixture.summaryTask = fixture.page.loadImageLibrary({ reload: true }); });
        await requested(summary); await settle(page, summary); await page.evaluate(() => fixture.summaryTask);
        assert.equal(await page.evaluate(() => fixture.state.gallery.status), "current summary failure");
      } finally { await page.close(); }
    });
    await run("summary started during a pending reader preserves its status", async () => {
      const page = await newPage();
      const current = hold(url => url.pathname === "/api/photo-sets/B");
      const summary = hold(url => url.pathname === "/api/image-library/summary");
      try {
        await page.evaluate(() => { fixture.readerTask = fixture.page.openPhotoSet("B"); });
        await requested(current);
        await page.evaluate(() => { fixture.summaryTask = fixture.page.loadImageLibrary({ reload: true }); });
        await requested(summary);
        assert.equal(await page.locator(".gallery-status").textContent(), "正在读取套图", "starting a background summary must not take the reader's loading surface");
        await settle(page, summary); await page.evaluate(() => fixture.summaryTask);
        assert.equal(await page.locator(".gallery-status").textContent(), "正在读取套图");
        await settle(page, current); await page.evaluate(() => fixture.readerTask);
        assert.equal(await page.evaluate(() => fixture.state.gallery.album.id), "B");
      } finally { current.release(); summary.release(); await page.close(); }
    });
    await run("inactive gallery ignores its delayed summary callback", async () => {
      const page = await newPage();
      try {
        const before = countRequests(url => url.pathname === "/api/image-library/summary");
        await page.evaluate(async () => {
          const original = window.setTimeout;
          let delayed;
          window.setTimeout = (callback, delay, ...args) => delay === 1000 ? (delayed = callback, 0) : original(callback, delay, ...args);
          try {
            fixture.state.gallery.data = null;
            fixture.state.gallery.mode = "media";
            fixture.page.enter({ skipRoute: true });
            if (!delayed) throw new Error("expected delayed media summary");
            // Controller lifecycle double: actual cross-product navigation
            // unloads the document and is outside this callback-level check.
            fixture.state.activeView = "novels";
            fixture.page.resetReader();
            delayed();
            await fixture.page.loadImageLibrary({ reload: true });
          } finally { window.setTimeout = original; }
        });
        await tick(page);
        assert.equal(countRequests(url => url.pathname === "/api/image-library/summary"), before);
      } finally { await page.close(); }
    });
    await run("same album reopened generation", async () => {
      const page = await newPage();
      try {
        await open(page, "A"); const old = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.has("imageOffset"), "old reader error");
        await more(page); await requested(old); await page.locator(".gallery-reader-back").click(); await open(page, "A");
        const current = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.has("imageOffset")); await more(page); await requested(current);
        await settle(page, old); assert.equal(await page.locator(".gallery-more").isDisabled(), true);
        assert.equal(await page.evaluate(() => fixture.state.gallery.status), "正在继续读取图片"); assert.equal(await page.evaluate(() => fixture.state.gallery.album.images.length), 160);
        await settle(page, current); assert.equal(await page.evaluate(() => fixture.state.gallery.album.images.length), 320);
      } finally { await page.close(); }
    });
    await run("shared reader album manga gallery navigation", async () => {
      const page = await newPage();
      try {
        const oldAlbum = hold(url => url.pathname === "/api/photo-sets/A"); await page.evaluate(() => { fixture.page.openPhotoSet("A"); }); await requested(oldAlbum);
        await page.evaluate(() => { fixture.state.gallery.mode = "manga"; return fixture.page.openMangaComic("C"); }); await settle(page, oldAlbum);
        assert.deepEqual(await page.evaluate(() => [fixture.state.gallery.album, fixture.state.gallery.comic.id, fixture.state.gallery.chapter.index]), [null, "C", 1]);
        const oldChapter = hold(url => url.pathname === "/api/manga/C/chapters/2", "old chapter error"); await page.evaluate(() => { fixture.page.openMangaChapter(2); }); await requested(oldChapter);
        await page.evaluate(() => { fixture.state.gallery.mode = "western"; return fixture.page.openGalleryMedia("W"); }); await settle(page, oldChapter);
        assert.deepEqual(await page.evaluate(() => [fixture.state.gallery.comic, fixture.state.gallery.chapter, fixture.state.gallery.media.id, fixture.state.gallery.status]), [null, null, "W", ""]);
        const oldMedia = hold(url => url.pathname === "/api/gallery-media/Movie"); await page.evaluate(() => { fixture.page.openGalleryMedia("Movie"); }); await requested(oldMedia);
        await page.evaluate(() => { fixture.state.gallery.mode = "photo"; return fixture.page.openPhotoSet("B"); }); await settle(page, oldMedia);
        assert.equal(await page.evaluate(() => fixture.state.gallery.album.id), "B"); assert(!page.url().includes("player.html"), "old movie must not redirect the album");
      } finally { await page.close(); }
    });
    await run("chapter and directory late responses", async () => {
      const page = await newPage();
      try {
        await page.evaluate(() => { fixture.state.gallery.mode = "manga"; return fixture.page.openMangaComic("C"); });
        const old = hold(url => url.pathname === "/api/manga/C/chapters/1"); await page.evaluate(() => { fixture.page.openMangaChapter(1); }); await requested(old);
        await page.evaluate(() => fixture.page.openMangaChapter(2)); await settle(page, old); assert.equal(await page.evaluate(() => fixture.state.gallery.chapter.index), 2);
        const lateComic = hold(url => url.pathname === "/api/manga/D"); await page.evaluate(() => { fixture.page.openMangaComic("D"); }); await requested(lateComic);
        await page.evaluate(() => { fixture.page.resetReader(); fixture.renderer.renderView(); }); const before = countRequests(url => url.pathname.startsWith("/api/manga/D/chapters/")); await settle(page, lateComic);
        assert.equal(await page.evaluate(() => fixture.state.gallery.comic), null); assert.equal(countRequests(url => url.pathname.startsWith("/api/manga/D/chapters/")), before, "late directory must not launch a chapter");
      } finally { await page.close(); }
    });
    for (const [count, observer, targets] of [[1000, true, [200, 400, 800]], [300, false, [50, 150, 250]]]) await run(`reader loading reaches visible images after long scrolls ${observer ? "observer" : "fallback"}`, async () => {
      const page = await newPage({ observer });
      try {
        const imageReads = countRequests(url => /^\/synthetic\/A\/\d+\.svg$/.test(url.pathname));
        await open(page, 'A');
        await page.evaluate(count => {
          fixture.state.gallery.album = { ...fixture.state.gallery.album, images: Array.from({ length: count }, (_, index) => ({ index: index + 1, name: `Synthetic ${index + 1}`, url: `/synthetic/A/${index + 1}.svg` })) };
          fixture.renderer.renderView();
        }, count);
        await page.waitForFunction(visibleReaderImage);
        const viewer = await page.locator('.gallery-reader-images').elementHandle();
        for (const target of targets) {
          await page.locator(`.gallery-reader-figure[data-image-index="${target}"]`).scrollIntoViewIfNeeded();
          try { await page.waitForFunction(visibleReaderImage, null, { timeout: 3000 }); }
          catch (error) { if (error.name !== 'TimeoutError') throw error; }
          const visible = await page.evaluate(visibleReaderImage);
          const pending = await page.evaluate(() => [...document.querySelectorAll('[data-gallery-loading="1"]')].map(figure => figure.dataset.imageIndex));
          console.log(JSON.stringify({ mode: 'photo-reader-visible-loading', observer, target, visible, pending }));
          assert(visible, "long scrolling must decode an actually visible image instead of stalling behind native-lazy queue slots");
          await page.locator(`.gallery-reader-figure[data-image-index="${visible.index}"] img`).evaluate(image => image.decode());
          assert.equal(await viewer.evaluate(node => node.isConnected && node === document.querySelector('.gallery-reader-images')), true);
        }
        const requestedImages = countRequests(url => /^\/synthetic\/A\/\d+\.svg$/.test(url.pathname)) - imageReads;
        assert(requestedImages <= 4 + targets.length * 16, "long scrolling must retain the application preload window instead of loading the whole album");
        console.log(JSON.stringify({ mode: 'photo-reader-request-budget', observer, pages: count, requestedImages }));
        await viewer.dispose();
      } finally { await page.close(); }
    });
    for (const observer of [true, false]) await run(`reader loading discards queued images after fast jumps ${observer ? "observer" : "fallback"}`, async () => {
      const page = await newPage({ real: true, observer });
      const first = hold(url => url.pathname === "/synthetic/A/1.svg");
      const abandoned = url => {
        const index = Number(/^\/synthetic\/A\/(\d+)\.svg$/.exec(url.pathname)?.[1]);
        return index >= 10 && index < 70;
      };
      const before = countRequests(abandoned);
      const jump = index => page.locator(`.gallery-reader-figure[data-image-index="${index}"]`).evaluate(figure => figure.scrollIntoView({ block: "center", behavior: "instant" }));
      const figureLoaded = index => page.waitForFunction(index => {
        const figure = document.querySelector(`.gallery-reader-figure[data-image-index="${index}"]`);
        const image = figure?.querySelector("img");
        return figure?.classList.contains("loaded") && image.complete && image.naturalWidth > 0;
      }, index, { timeout: 5000 });
      try {
        await clickAlbum(page, "A"); await readerTitle(page, "Album A"); await requested(first);
        for (const index of [20, 40, 60, 80]) {
          await jump(index);
          await page.waitForFunction(index => document.querySelector(`.gallery-reader-figure[data-image-index="${index}"]`)?.dataset.galleryQueued === "1", index);
        }
        assert.equal(countRequests(abandoned), before, "the held startup image must keep the visited windows pending");
        first.release();
        await figureLoaded(80);
        const staleReads = countRequests(abandoned) - before;
        console.log(`GALLERY_QUEUED_IMAGE_MEASUREMENT ${JSON.stringify({ observer, staleReads })}`);
        assert.equal(staleReads, 0, "leaving a preload window must discard its unstarted full-size requests");
        await jump(40);
        await figureLoaded(40);
        assert(countRequests(abandoned) > before, "returning to a discarded window must queue and decode its images again");
      } finally { first.release(); await page.close(); }
    });
    for (const [count, observer] of [[1000, true], [300, false]]) await run(`reader width ${count} pages preserves images focus and loader ${observer ? "observer" : "fallback"}`, async () => {
      const page = await newPage({ observer });
      try {
        await open(page, "A");
        await page.evaluate(count => {
          fixture.state.gallery.album = { ...fixture.state.gallery.album, images: Array.from({ length: count }, (_, i) => ({ index: i + 1, name: `Synthetic ${i + 1}`, url: `/synthetic/A/${i + 1}.svg` })) };
          fixture.renderer.renderView();
        }, count);
        await page.waitForFunction(() => document.querySelector('.gallery-reader-figure')?.classList.contains('loaded'));
        await page.evaluate(() => scrollTo(0, 500)); await tick(page);
        await page.evaluate(() => {
          fixture.widthSnapshot = { viewer: document.querySelector('.gallery-reader-images'), figures: [...document.querySelectorAll('.gallery-reader-figure')], images: [...document.querySelectorAll('.gallery-reader-figure img')], observer: __readerObservers.at(-1), buttons: [...document.querySelectorAll('.gallery-reader-fit-group button')] };
          fixture.widthWork = { elements: 0, images: 0 }; const create = document.createElement.bind(document);
          document.createElement = (tag, ...args) => { fixture.widthWork.elements++; if(String(tag).toLowerCase() === 'img') fixture.widthWork.images++; return create(tag, ...args); };
        });
        const apiReads = countRequests(url => url.pathname.startsWith('/api/'));
        const firstReads = countRequests(url => url.pathname === '/synthetic/A/1.svg');
        for (const [fit, name] of [[false, "原始大小"], [true, "适应宽度"]]) {
          const button = page.getByRole('button', { name, exact: true }); await button.evaluate(node => node.focus({ preventScroll: true }));
          const before = await page.locator('.gallery-reader-figure').first().evaluate(node => ({ top: node.getBoundingClientRect().top, width: node.querySelector('img').getBoundingClientRect().width }));
          await page.evaluate(() => { fixture.widthWork.elements = fixture.widthWork.images = 0; });
          await button.press('Enter'); await tick(page);
          const after = await page.evaluate(() => ({ viewer: fixture.widthSnapshot.viewer === document.querySelector('.gallery-reader-images'), figures: fixture.widthSnapshot.figures.every(node => node.isConnected), images: fixture.widthSnapshot.images.every(node => node.isConnected), focused: fixture.widthSnapshot.buttons.includes(document.activeElement), elements: fixture.widthWork.elements, createdImages: fixture.widthWork.images, className: document.querySelector('.gallery-reader-images').className, top: document.querySelector('.gallery-reader-figure').getBoundingClientRect().top, width: document.querySelector('.gallery-reader-figure img').getBoundingClientRect().width, observer: fixture.widthSnapshot.observer === __readerObservers.at(-1) && !fixture.widthSnapshot.observer?.disconnected }));
          console.log(JSON.stringify({ mode: 'photo-reader-width', count, fit, before, after }));
          assert.equal(after.viewer && after.figures && after.images && after.focused, true, "width switching must preserve mounted images, toolbar focus and the reader loader");
          assert.equal(after.elements, 0, "width switching must create zero replacement elements");
          assert.equal(after.createdImages, 0);
          assert(Math.abs(after.top - before.top) < 2, "width switching must keep the current reading anchor");
          if (observer) assert.equal(after.observer, true);
          assert.equal(await button.getAttribute('aria-pressed'), 'true');
          assert.equal(countRequests(url => url.pathname.startsWith('/api/')), apiReads);
          assert.equal(countRequests(url => url.pathname === '/synthetic/A/1.svg'), firstReads, "width switching must not request the current image again");
          assert.equal(await page.evaluate(() => fixture.state.gallery.fitWidth), fit);
          assert.equal(after.className.includes(fit ? 'fit-width' : 'natural-width'), true);
          assert(fit ? after.width > before.width : after.width < before.width);
        }
      } finally { await page.close(); }
    });
    await run("reader width deep anchor uses logarithmic geometry", async () => {
      const page = await newPage(), count = 2400, index = 2000;
      try {
        await open(page, "A");
        await page.evaluate(count => {
          fixture.state.gallery.album = { ...fixture.state.gallery.album, images: Array.from({ length: count }, (_, offset) => ({
            index: offset + 1, name: `Synthetic ${offset + 1}`, url: `/synthetic/A/${offset + 1}.svg`
          })) };
          fixture.renderer.renderView();
        }, count);
        const figure = page.locator(`.gallery-reader-figure[data-image-index="${index}"]`);
        await figure.evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
        await page.waitForFunction(index => document.querySelector(`.gallery-reader-figure[data-image-index="${index}"]`)?.classList.contains('loaded'), index);
        await tick(page);
        if (timings) {
          const cdp = await page.context().newCDPSession(page);
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        }
        const samples = [];
        for (const fit of [false, true, false]) {
          const before = await figure.evaluate(node => {
            node.scrollIntoView({ block: 'start', behavior: 'instant' });
            window.scrollBy(0, 150);
            return node.getBoundingClientRect().top;
          });
          const sample = await page.getByRole('button', { name: fit ? '适应宽度' : '原始大小', exact: true }).evaluate(button => {
            const originalRect = Element.prototype.getBoundingClientRect;
            let figureReads = 0;
            Element.prototype.getBoundingClientRect = function (...args) {
              if (this.classList.contains('gallery-reader-figure')) figureReads++;
              return originalRect.apply(this, args);
            };
            const start = performance.now();
            try { button.click(); return { figureReads, elapsedMs: performance.now() - start }; }
            finally { Element.prototype.getBoundingClientRect = originalRect; }
          });
          await tick(page);
          const after = await figure.evaluate(node => node.getBoundingClientRect().top);
          assert(Math.abs(before - after) < 2, 'width switching must preserve the same deep figure position');
          samples.push(sample);
        }
        console.log(`GALLERY_WIDTH_DEEP ${JSON.stringify({ count, index, cpuRate: timings ? 4 : 1, samples })}`);
        assert(samples.every(sample => sample.figureReads <= Math.ceil(Math.log2(count)) + 2), 'capturing a deep width anchor must not read the preceding figures');
      } finally { await page.close(); }
    });
    await run("reader width retains a pending startup image and the append queue", async () => {
      const page = await newPage(), first = hold(url => url.pathname === '/synthetic/A/1.svg');
      const append = hold(url => url.pathname === '/api/photo-sets/A' && url.searchParams.has('imageOffset'));
      try {
        const reads = countRequests(url => /^\/synthetic\/A\/\d+\.svg$/.test(url.pathname));
        await open(page, 'A'); await requested(first);
        await page.evaluate(() => { fixture.widthPending = { viewer: document.querySelector('.gallery-reader-images'), image: document.querySelector('.gallery-reader-figure img'), observer: __readerObservers.at(-1) }; });
        await page.getByRole('button', { name: '原始大小', exact: true }).press('Enter');
        await page.evaluate(() => document.querySelector('.gallery-more').click()); await requested(append); await settle(page, append);
        assert.equal(await page.evaluate(() => fixture.widthPending.viewer === document.querySelector('.gallery-reader-images') && fixture.widthPending.image === document.querySelector('.gallery-reader-figure img') && fixture.widthPending.image.parentElement.dataset.galleryLoading === '1' && fixture.widthPending.observer === __readerObservers.at(-1) && !fixture.widthPending.observer.disconnected), true,
          "fit changes must keep the startup image and its original loader across an append");
        assert.equal(await page.locator('.gallery-reader-figure').count(), 320);
        assert.equal(await page.locator('.gallery-reader-images').evaluate(node => node.classList.contains('natural-width')), true);
        assert.equal(countRequests(url => /^\/synthetic\/A\/\d+\.svg$/.test(url.pathname)) - reads, 1, "fit changes must not reset the one-slot startup image gate");
        first.release(); await page.waitForFunction(() => fixture.widthPending.image.parentElement.classList.contains('loaded'));
        await page.waitForFunction(() => document.querySelector('.gallery-reader-figure[data-image-index="2"]').classList.contains('loaded'));
      } finally { first.release(); append.release(); await page.close(); }
    });
    await run("reader width delayed anchors yield to navigation scroll and focus intent", async () => {
      const page = await newPage();
      try {
        await open(page, 'A'); await page.waitForFunction(() => document.querySelector('.gallery-reader-figure')?.classList.contains('loaded'));
        await page.evaluate(() => { fixture.oldWidthButtons = [...document.querySelectorAll('.gallery-reader-fit-group button')]; window.scrollTo(0, 500); }); await tick(page);
        await holdReaderWidthFrames(page); await page.getByRole('button', { name: '原始大小', exact: true }).evaluate(button => { button.focus({ preventScroll: true }); button.click(); });
        await open(page, 'B'); await releaseReaderWidthFrames(page); await tick(page);
        assert.equal(await page.evaluate(() => scrollY), 0, "old width frames must not scroll a newly opened album");
        await page.evaluate(() => fixture.oldWidthButtons[0].click());
        assert.equal(await page.evaluate(() => fixture.state.gallery.fitWidth), false, "detached width buttons must not change a new reader's preference");
        await page.waitForFunction(() => document.querySelector('.gallery-reader-figure')?.classList.contains('loaded'));
        for (const [index, intent] of ['wheel', 'focus', 'keyboard'].entries()) {
          await page.evaluate(() => window.scrollTo(0, 500)); await tick(page);
          await holdReaderWidthFrames(page);
          await page.locator('.gallery-reader-fit-group button[aria-pressed="false"]').evaluate(button => { button.focus({ preventScroll: true }); button.click(); });
          const top = 650 + index * 10;
          await page.evaluate(({ intent, top }) => {
            if (intent === 'wheel') dispatchEvent(new WheelEvent('wheel', { deltaY: 200, bubbles: true }));
            else if (intent === 'focus') document.querySelector('.gallery-reader-open').focus({ preventScroll: true });
            else document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            window.scrollTo(0, top);
          }, { intent, top });
          await releaseReaderWidthFrames(page); await tick(page);
          assert.equal(await page.evaluate(() => scrollY), top, `new ${intent} intent must cancel the old width anchor`);
          if (intent === 'focus') assert.equal(await page.locator('.gallery-reader-open').evaluate(node => document.activeElement === node), true);
        }
        await page.evaluate(() => window.scrollTo(0, 500)); await tick(page);
        const top = await page.locator('.gallery-reader-figure').first().evaluate(node => node.getBoundingClientRect().top);
        await holdReaderWidthFrames(page);
        await page.evaluate(() => { const buttons = document.querySelectorAll('.gallery-reader-fit-group button'); buttons[0].click(); buttons[1].click(); buttons[0].click(); });
        await releaseReaderWidthFrames(page); await tick(page);
        assert(Math.abs(await page.locator('.gallery-reader-figure').first().evaluate(node => node.getBoundingClientRect().top) - top) < 2, "rapid fit changes must share the original reading anchor");
        await page.evaluate(() => { fixture.state.gallery.album = null; fixture.state.gallery.comic = { id: 'Empty', title: 'Synthetic empty catalog', chapters: [] }; fixture.state.gallery.chapter = null; fixture.renderer.renderView(); });
        await page.getByRole('button', { name: '原始大小', exact: true }).click();
        assert.equal(await page.evaluate(() => fixture.state.gallery.fitWidth), false, "a toolbar without image pages retains its previous preference behavior");
      } finally { await page.close(); }
    });
    for (const [input, width] of [["mouse", 1280], ["touch", 320]]) await run(`pager pan ${input} reaches magnified image in both directions`, async () => {
      const page = await newPage();
      const full = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.get("imageLimit") === "all");
      try {
        await page.setViewportSize({ width, height: 900 });
        await open(page, "A"); await readerTitle(page, "Album A");
        await page.locator(".gallery-reader-open").click(); await requested(full);
        const image = page.locator(".gallery-image-pager-stage img"), stage = page.locator(".gallery-image-pager-stage");
        await image.evaluate(image => image.decode());
        const zoomIn = page.getByRole("button", { name: "放大图片", exact: true });
        for (let i = 0; i < 8; i++) await zoomIn.click();
        await pagerZoomReady(page); await tick(page);
        await stage.evaluate(stage => stage.scrollTo({ left: 0, top: 0, behavior: 'auto' }));
        const before = await stage.evaluate(stage => {
          const image = stage.querySelector("img");
          fixture.panImage = image; fixture.panOverlay = stage.closest('.gallery-image-pager');
          const outer = stage.getBoundingClientRect(), rect = image.getBoundingClientRect();
          const x = outer.left + stage.clientWidth / 2, y = outer.top + stage.clientHeight / 2;
          return { left: stage.scrollLeft, top: stage.scrollTop, maxLeft: stage.scrollWidth - stage.clientWidth,
            maxTop: stage.scrollHeight - stage.clientHeight, source: image.getAttribute('src'), bodyTop: scrollY,
            imagePoint: document.elementFromPoint(x, y) === image, u: (x - rect.left) / rect.width, v: (y - rect.top) / rect.height };
        });
        assert(before.maxLeft > 30 && before.maxTop > 30, "synthetic magnified image must overflow both directions");
        const reads = countRequests(url => /^\/synthetic\/A\/\d+\.svg$/.test(url.pathname));
        await dragPager(page, input, .75, .75, .25, .25);
        const after = await stage.evaluate(stage => {
          const image = stage.querySelector('img'), outer = stage.getBoundingClientRect(), rect = image.getBoundingClientRect();
          const x = outer.left + stage.clientWidth / 2, y = outer.top + stage.clientHeight / 2;
          return { left: stage.scrollLeft, top: stage.scrollTop, imagePoint: document.elementFromPoint(x, y) === image,
            u: (x - rect.left) / rect.width, v: (y - rect.top) / rect.height };
        });
        console.log(JSON.stringify({ mode: 'pager-pan', input, width, before, after }));
        assert(after.left > 30 && after.top > 30, "dragging a zoomed image must reveal its magnified right and lower regions");
        assert(before.imagePoint && after.imagePoint && after.u > before.u + .03 && after.v > before.v + .03,
          "the visible decoded image region must move right and down, not merely change a hidden scroll offset");
        await dragPager(page, input, .25, .25, .75, .75);
        assert.equal(await stage.evaluate(stage => stage.scrollLeft < 2 && stage.scrollTop < 2), true, "reverse drag must reach the image origin");
        assert.equal(await image.evaluate(image => image === fixture.panImage && image.closest('.gallery-image-pager') === fixture.panOverlay), true);
        assert.equal(await image.getAttribute('src'), before.source);
        assert.equal(await page.locator('.gallery-image-pager-zoom').textContent(), '300%');
        assert.equal(await page.locator('.gallery-image-pager-range').inputValue(), '1');
        assert.equal(await page.evaluate(() => scrollY), before.bodyTop);
        assert.equal(countRequests(url => /^\/synthetic\/A\/\d+\.svg$/.test(url.pathname)), reads, "panning must not request more image data");
      } finally { full.release(); await page.close(); }
    });
    await run("pager pan cancel releases touch capture and fitted swipe still changes page", async () => {
      const page = await newPage();
      const full = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.get("imageLimit") === "all");
      let session;
      try {
        await page.setViewportSize({ width: 320, height: 900 }); await open(page, "A");
        await page.locator('.gallery-reader-open').click(); await requested(full);
        await page.locator('.gallery-image-pager-stage img').evaluate(image => image.decode());
        for (let i = 0; i < 4; i++) await page.getByRole('button', { name: '放大图片', exact: true }).click();
        await pagerZoomReady(page);
        const stage = page.locator('.gallery-image-pager-stage'), box = await stage.boundingBox();
        await stage.evaluate(stage => stage.addEventListener('pointerdown', event => { fixture.panPointer = event.pointerId; }));
        session = await page.context().newCDPSession(page);
        await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
        const point = { x: box.x + box.width * .75, y: box.y + box.height * .75, id: 0 };
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, x: point.x - 60, y: point.y - 80 }] });
        assert.equal(await stage.evaluate(stage => stage.classList.contains('panning') && stage.hasPointerCapture(fixture.panPointer)), true);
        await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
        assert.equal(await stage.evaluate(stage => !stage.classList.contains('panning') && !stage.hasPointerCapture(fixture.panPointer)), true, "touch cancellation must release the captured pan");
        const stopped = await stage.evaluate(stage => [stage.scrollLeft, stage.scrollTop]);
        await stage.evaluate(stage => stage.dispatchEvent(new PointerEvent('pointermove', { pointerId: fixture.panPointer, clientX: 0, clientY: 0, bubbles: true })));
        assert.deepEqual(await stage.evaluate(stage => [stage.scrollLeft, stage.scrollTop]), stopped, "cancelled pan cannot consume later pointer events");
        await page.locator('.gallery-image-pager-zoom').click();
        await pagerZoomReady(page);
        assert.equal(await stage.evaluate(stage => stage.scrollLeft === 0 && stage.scrollTop === 0), true);
        await dragPager(page, 'touch', .75, .5, .25, .5);
        assert.equal(await page.locator('.gallery-image-pager-range').inputValue(), '2', "100% touch swipe retains the existing next-image navigation");
        assert.equal(await page.locator('.gallery-image-pager-zoom').textContent(), '100%');
      } finally { await session?.detach(); full.release(); await page.close(); }
    });
    await run("pager pan survives same-image metadata and stops on close or new image", async () => {
      const page = await newPage();
      const full = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.get("imageLimit") === "all");
      try {
        await open(page, 'A'); await page.locator('.gallery-reader-open').click(); await requested(full);
        await page.locator('.gallery-image-pager-stage img').evaluate(image => image.decode());
        for (let i = 0; i < 8; i++) await page.getByRole('button', { name: '放大图片', exact: true }).click();
        await pagerZoomReady(page);
        const stage = page.locator('.gallery-image-pager-stage'), box = await stage.boundingBox();
        await page.mouse.move(box.x + box.width * .75, box.y + box.height * .75); await page.mouse.down();
        await page.mouse.move(box.x + box.width * .65, box.y + box.height * .65, { steps: 4 });
        await stage.evaluate(stage => { fixture.oldPanStage = stage; fixture.oldPanImage = stage.querySelector('img'); });
        const panned = await stage.evaluate(stage => [stage.scrollLeft, stage.scrollTop]);
        await settle(page, full);
        assert.equal(await stage.evaluate(stage => stage.classList.contains('panning') && stage.querySelector('img') === fixture.oldPanImage), true, "same-image full metadata must retain the active gesture and image");
        assert.deepEqual(await stage.evaluate(stage => [stage.scrollLeft, stage.scrollTop]), panned);
        await page.mouse.move(4, 4, { steps: 8 });
        assert.equal(await stage.evaluate(stage => stage.scrollTop > 100), true, "capture keeps panning when the pointer crosses toolbar boundaries");
        await page.keyboard.press('Escape'); await page.mouse.up();
        assert.equal(await page.evaluate(() => fixture.oldPanStage.classList.contains('panning')), false);
        await page.locator('.gallery-reader-open').click(); await page.locator('.gallery-image-pager-stage img').evaluate(image => image.decode());
        const current = await page.locator('.gallery-image-pager-stage').evaluate(stage => [stage.scrollLeft, stage.scrollTop]);
        await page.evaluate(() => {
          for (const type of ['pointerdown', 'pointermove', 'pointerup']) fixture.oldPanStage.dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, clientX: 10, clientY: 10, bubbles: true }));
        });
        assert.deepEqual(await page.locator('.gallery-image-pager-stage').evaluate(stage => [stage.scrollLeft, stage.scrollTop]), current, "detached pan controls cannot move a reopened viewer");
        await page.getByRole('button', { name: '放大图片', exact: true }).click();
        await page.getByRole('button', { name: '下一张', exact: true }).click();
        assert.equal(await page.locator('.gallery-image-pager-zoom').textContent(), '100%');
        assert.equal(await page.locator('.gallery-image-pager-stage').evaluate(stage => !stage.classList.contains('panning') && stage.scrollLeft === 0 && stage.scrollTop === 0), true);
      } finally { full.release(); await page.mouse.up().catch(() => {}); await page.close(); }
    });
    for (const width of [1280, 320]) await run(`pager jump exact first last and same page ${width}px`, async () => {
      const page = await newPage({ real: true });
      const full = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.get("imageLimit") === "all");
      try {
        await page.setViewportSize({ width, height: 740 }); await clickAlbum(page, "A"); await readerTitle(page, "Album A");
        await page.locator(".gallery-reader-open").click(); await requested(full); await settle(page, full);
        const counter = page.locator("button.gallery-image-pager-counter");
        assert.equal(await counter.count(), 1, "pager must expose its counter as an exact page jump entry");
        await counter.focus(); await page.keyboard.press("Enter");
        const input = page.getByRole("textbox", { name: "目标图片序号", exact: true });
        assert.equal(await input.getAttribute("inputmode"), "numeric");
        assert.equal(await input.evaluate(node => document.activeElement === node), true);
        assert.equal(await page.locator(".gallery-image-pager-jump").evaluate(panel => { const r = panel.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }), true);
        assert.equal(await page.getByRole("button", { name: "跳转", exact: true }).evaluate(button => { const r = button.getBoundingClientRect(); return r.height >= 44 && button.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); }), true);
        await input.fill("5000"); await input.press("Enter");
        assert.equal(await page.locator(".gallery-image-pager-range").inputValue(), "5000");
        assert.equal(await page.locator(".gallery-image-pager-stage img").getAttribute("src"), "/synthetic/A/5000.svg");
        assert.equal(await counter.evaluate(node => document.activeElement === node), true, "successful jump must return focus to its counter");
        await page.keyboard.press("+"); assert.equal(await page.locator(".gallery-image-pager-zoom").textContent(), "125%");
        await counter.press("Enter"); assert.equal(await input.inputValue(), "5000"); await input.press("Enter");
        assert.equal(await page.locator(".gallery-image-pager-zoom").textContent(), "125%", "a same-page jump must preserve zoom");
        for (const value of ["1", "10000"]) {
          await counter.press("Enter"); await input.fill(value); await page.getByRole("button", { name: "跳转", exact: true }).click();
          assert.equal(await page.locator(".gallery-image-pager-range").inputValue(), value);
          assert.equal(await page.locator(".gallery-image-pager-zoom").textContent(), "100%", "different-page jumps use the existing fitted-page navigation behavior");
        }
        assert.equal(await page.getByRole("button", { name: "下一张", exact: true }).isDisabled(), true);
        await page.keyboard.press("ArrowLeft"); assert.equal(await page.locator(".gallery-image-pager-range").inputValue(), "9999");
        assert.equal(await page.locator(".gallery-image-pager").evaluate(node => node.scrollWidth <= innerWidth), true, "jump entry must not widen the narrow viewer");
      } finally { full.release(); await page.close(); }
    });
    await run("pager jump invalid values cancel and focus preserve the current page", async () => {
      const page = await newPage(), full = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.get("imageLimit") === "all");
      try {
        await open(page, "A"); await page.locator(".gallery-reader-open").click(); await requested(full);
        await page.keyboard.press("ArrowRight"); await page.keyboard.press("+");
        const counter = page.locator("button.gallery-image-pager-counter"); await counter.click();
        const input = page.getByRole("textbox", { name: "目标图片序号", exact: true });
        const reads = countRequests(url => url.pathname.startsWith("/api/"));
        for (const value of ["", "0", "-1", "1.5", "1e2", "abc", "161", "9007199254740992"]) {
          await input.fill(value); await input.press("Enter");
          assert.equal(await page.locator(".gallery-image-pager-jump").isVisible(), true, "invalid jump input must remain open with a validation message");
          assert.equal(await input.getAttribute("aria-invalid"), "true", "invalid jump input must remain open with a validation message");
          assert.equal(await page.locator(".gallery-image-pager-range").inputValue(), "2");
          assert.equal(await page.locator(".gallery-image-pager-zoom").textContent(), "125%");
          assert.equal(await input.evaluate(node => document.activeElement === node), true);
        }
        assert.equal(countRequests(url => url.pathname.startsWith("/api/")), reads, "invalid navigation must not reload album metadata");
        await input.press("Escape"); assert.equal(await page.locator(".gallery-image-pager-jump").isVisible(), false);
        assert.equal(await page.locator(".gallery-image-pager").count(), 1); assert.equal(await counter.evaluate(node => document.activeElement === node), true);
        await counter.press("Enter"); await page.getByRole("button", { name: "取消跳转", exact: true }).click();
        assert.equal(await page.locator(".gallery-image-pager-zoom").textContent(), "125%");
        await page.keyboard.press("Escape"); assert.equal(await page.locator(".gallery-image-pager").count(), 0);
        assert.equal(await page.locator(".gallery-reader-open").evaluate(node => document.activeElement === node), true);
      } finally { full.release(); await page.close(); }
    });
    await run("pager jump late full metadata preserves the editing draft and zoom", async () => {
      const page = await newPage(), full = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.get("imageLimit") === "all");
      try {
        await open(page, "A"); await page.locator(".gallery-reader-open").click(); await requested(full); await page.keyboard.press("+");
        await page.locator("button.gallery-image-pager-counter").click(); const input = page.getByRole("textbox", { name: "目标图片序号", exact: true });
        await input.fill("6789"); await input.press("Enter"); assert.equal(await input.getAttribute("aria-invalid"), "true");
        await input.evaluate(node => { fixture.jumpInput = node; node.setSelectionRange(1, 3); });
        await settle(page, full);
        assert.match(await page.locator(".gallery-image-pager-jump-hint").textContent(), /10,000/);
        assert.deepEqual(await input.evaluate(node => [node === fixture.jumpInput, document.activeElement === node, node.value, node.selectionStart, node.selectionEnd]), [true, true, "6789", 1, 3], "late full metadata must preserve the jump draft, selection and focus");
        assert.equal(await page.locator(".gallery-image-pager-range").inputValue(), "1"); assert.equal(await page.locator(".gallery-image-pager-zoom").textContent(), "125%");
        await input.press("Enter"); assert.equal(await page.locator(".gallery-image-pager-range").inputValue(), "6789");
      } finally { full.release(); await page.close(); }
    });
    await run("pager jump native editing IME and Tab stay in the jump controls", async () => {
      const page = await newPage(), full = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.get("imageLimit") === "all");
      try {
        await open(page, "A"); await page.locator(".gallery-reader-open").click(); await requested(full);
        for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
        await page.locator("button.gallery-image-pager-counter").click(); const input = page.getByRole("textbox", { name: "目标图片序号", exact: true });
        await input.fill("123"); await input.press("Home");
        assert.equal(await page.locator(".gallery-image-pager-range").inputValue(), "7", "native jump input editing must not activate image navigation shortcuts");
        await input.press("ArrowRight");
        assert.equal(await input.evaluate(node => node.selectionStart), 1);
        await input.press("End"); await input.press("ArrowUp");
        assert.equal(await page.locator(".gallery-image-pager-range").inputValue(), "7", "native jump input editing must not activate image navigation shortcuts");
        await input.fill("15");
        assert.equal(await input.evaluate(node => ["ctrlKey", "metaKey", "altKey"].every(modifier => { const event = new KeyboardEvent("keydown", { key: "Enter", [modifier]: true, bubbles: true, cancelable: true }); node.dispatchEvent(event); return !event.defaultPrevented; })), true);
        await input.evaluate(node => {
          node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
          for (const key of ["Enter", "Escape"]) node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
          node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
          node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true }));
        });
        assert.equal(await page.locator(".gallery-image-pager-jump").isVisible(), true); assert.equal(await page.locator(".gallery-image-pager-range").inputValue(), "7");
        await input.press("Tab"); assert.equal(await page.getByRole("button", { name: "跳转", exact: true }).evaluate(node => document.activeElement === node), true);
        await page.keyboard.press("Tab"); assert.equal(await page.getByRole("button", { name: "取消跳转", exact: true }).evaluate(node => document.activeElement === node), true);
        await page.keyboard.press("Tab"); assert.equal(await input.evaluate(node => document.activeElement === node), true);
        await page.keyboard.press("Shift+Tab"); assert.equal(await page.getByRole("button", { name: "取消跳转", exact: true }).evaluate(node => document.activeElement === node), true);
        await input.focus(); await input.press("Enter"); assert.equal(await page.locator(".gallery-image-pager-range").inputValue(), "15");
      } finally { full.release(); await page.close(); }
    });
    await run("pager jump close reopen retires old controls and old metadata", async () => {
      const page = await newPage(), fullA = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.get("imageLimit") === "all"), fullB = hold(url => url.pathname === "/api/photo-sets/B" && url.searchParams.get("imageLimit") === "all");
      try {
        await open(page, "A"); await page.locator(".gallery-reader-open").click(); await requested(fullA); await page.locator("button.gallery-image-pager-counter").click();
        await page.evaluate(() => { fixture.oldJump = { input: document.querySelector('.gallery-image-pager-jump input'), buttons: [...document.querySelectorAll('.gallery-image-pager-jump button')], counter: document.querySelector('button.gallery-image-pager-counter') }; });
        await page.locator(".gallery-image-pager-top").getByRole("button", { name: "返回", exact: true }).click();
        await open(page, "B"); await page.locator(".gallery-reader-open").click(); await requested(fullB); await page.locator("button.gallery-image-pager-counter").click();
        const input = page.getByRole("textbox", { name: "目标图片序号", exact: true }); await input.fill("35");
        await page.evaluate(() => { const old = fixture.oldJump; old.input.value = '50'; for (const button of old.buttons) button.click(); old.counter.click(); old.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
        await settle(page, fullA);
        assert.equal(await input.inputValue(), "35"); assert.equal(await input.evaluate(node => document.activeElement === node), true);
        assert.equal(await page.locator(".gallery-image-pager-stage img").getAttribute("src"), "/synthetic/B/1.svg");
        assert.match(await page.locator(".gallery-image-pager-counter").textContent(), /第 1 \/ 160 张/);
        await input.press("Enter"); assert.equal(await page.locator(".gallery-image-pager-stage img").getAttribute("src"), "/synthetic/B/35.svg");
      } finally { fullA.release(); fullB.release(); await page.close(); }
    });
    for (const outcome of ["success", "failure"]) await run(`pager image retry ${outcome} retains current image, zoom and controls`, async () => {
      const page = await newPage();
      let broken;
      const retryRead = hold(url => url.pathname === "/synthetic/A/1.svg", outcome === "failure" ? "Synthetic retry failure" : "");
      try {
        broken = await openFailedPager(page);
        await page.setViewportSize({ width: 320, height: 740 }); await tick(page);
        const retry = page.locator(".gallery-image-pager-retry");
        assert.equal(await retry.evaluate(button => {
          const box = button.getBoundingClientRect();
          return box.height >= 44 && document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === button;
        }), true, "failed image recovery must stay pointer-reachable on a narrow pager");
        const retryBounds = await retry.boundingBox();
        await page.mouse.move(retryBounds.x + retryBounds.width / 2, retryBounds.y + retryBounds.height / 2);
        await page.mouse.down(); await page.mouse.move(retryBounds.x + retryBounds.width / 2, retryBounds.y + retryBounds.height / 2 - 60); await page.mouse.up();
        await retry.evaluate(button => button.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true })));
        assert.match(await page.locator(".gallery-image-pager-counter").textContent(), /第 1 \/ 160 张/, "recovery controls must not become image swipe/wheel navigation");
        await page.locator(".gallery-image-pager-top-actions").getByRole("button", { name: "放大图片", exact: true }).click();
        await page.evaluate(() => {
          fixture.pager = document.querySelector(".gallery-image-pager");
          fixture.pagerImage = document.querySelector(".gallery-image-pager-stage img");
          fixture.pagerThumbs = [...document.querySelectorAll(".gallery-image-pager-thumbnail")];
        });
        const before = await pagerRetrySnapshot(page), reads = countRequests(url => url.pathname.startsWith("/api/")), imageReads = countRequests(url => url.pathname === "/synthetic/A/1.svg");
        broken.useServer(); await retry.focus(); await page.keyboard.press("Enter"); await requested(retryRead);
        assert.equal(await retry.isDisabled(), true);
        assert.equal(await page.locator(".gallery-image-pager-stage").getAttribute("aria-busy"), "true");
        await retry.evaluate(button => button.dispatchEvent(new MouseEvent("click"))); await tick(page);
        assert.equal(countRequests(url => url.pathname === "/synthetic/A/1.svg"), imageReads + 1, "repeated retry clicks must share one current image read");
        assert.equal(await page.evaluate(() => document.activeElement.matches(".gallery-image-pager-stage")), true);
        retryRead.release();
        if (outcome === "success") await page.locator(".gallery-image-pager-stage img").evaluate(image => image.decode());
        else {
          await page.waitForFunction(() => !document.querySelector(".gallery-image-pager-retry").disabled);
          assert.equal(await retry.evaluate(button => document.activeElement === button), true, "a failed keyboard retry must remain actionable");
          await page.keyboard.press("Enter"); await page.locator(".gallery-image-pager-stage img").evaluate(image => image.decode());
        }
        assert.equal(await page.locator(".gallery-image-pager-error").isVisible(), false);
        assert.equal(await page.locator(".gallery-image-pager-stage").getAttribute("aria-busy"), null);
        assert.deepEqual(await pagerRetrySnapshot(page), before, "current image recovery must preserve the mounted viewer, thumbnails, page, zoom, route and scroll");
        assert.equal(countRequests(url => url.pathname.startsWith("/api/")), reads, "retry must not reload album metadata");
        await page.keyboard.press("Escape");
        assert.equal(await page.locator(".gallery-reader-open").evaluate(button => button === document.activeElement), true);
      } finally { retryRead.release(); broken?.full.release(); await page.close(); }
    });
    await run("pager image retry survives late full metadata and preserves newer focus", async () => {
      const page = await newPage(); let broken;
      const retryRead = hold(url => url.pathname === "/synthetic/A/1.svg", "Synthetic retry failure");
      try {
        broken = await openFailedPager(page);
        await page.locator(".gallery-image-pager-top-actions").getByRole("button", { name: "放大图片", exact: true }).click();
        await settle(page, broken.full);
        assert.equal(await page.locator(".gallery-image-pager-range").getAttribute("max"), "10000");
        assert.equal(await page.locator(".gallery-image-pager-error").isVisible(), true, "late full metadata must keep the failed current image actionable");
        assert.equal(await page.locator(".gallery-image-pager-zoom").textContent(), "125%");
        // Wait for the replacement thumbnail's deliberate 503 to settle first.
        await page.waitForFunction(() => document.querySelector('.gallery-image-pager-thumbnail[data-index="0"] img')?.complete);
        broken.useServer(); await page.locator(".gallery-image-pager-retry").focus(); await page.keyboard.press("Enter"); await requested(retryRead);
        const control = page.locator(".gallery-image-pager-zoom"); await control.focus();
        retryRead.release(); await page.waitForFunction(() => !document.querySelector(".gallery-image-pager-retry").disabled);
        assert.equal(await control.evaluate(button => button === document.activeElement), true, "late retry failure must respect a newer focused control");
        assert.equal(await page.locator(".gallery-image-pager-zoom").textContent(), "125%");
      } finally { retryRead.release(); broken?.full.release(); await page.close(); }
    });
    for (const error of ["", "Synthetic old retry failure"]) await run(`pager image retry yields to next image ${error ? "failure" : "success"}`, async () => {
      const page = await newPage(); let broken;
      const retryRead = hold(url => url.pathname === "/synthetic/A/1.svg", error);
      try {
        broken = await openFailedPager(page); broken.useServer();
        await page.locator(".gallery-image-pager-retry").click(); await requested(retryRead);
        await page.evaluate(() => { fixture.oldImageRetry = document.querySelector(".gallery-image-pager-retry"); });
        await page.locator(".gallery-image-pager-controls").getByRole("button", { name: "下一张", exact: true }).click();
        await page.locator(".gallery-image-pager-stage img").evaluate(image => image.decode());
        assert.match(await page.locator(".gallery-image-pager-counter").textContent(), /第 2 \/ 160 张/);
        assert.equal(await page.locator(".gallery-image-pager-error").isVisible(), false);
        const source = await page.locator(".gallery-image-pager-stage img").getAttribute("src"), reads = countRequests(url => url.pathname === "/synthetic/A/1.svg");
        retryRead.release(); await tick(page);
        await page.evaluate(() => {
          const image = document.querySelector(".gallery-image-pager-stage img"), descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
          fixture.pagerSourceWrites = 0;
          Object.defineProperty(image, "src", {
            get() { return descriptor.get.call(this); },
            set(value) { fixture.pagerSourceWrites++; descriptor.set.call(this, value); }
          });
          fixture.oldImageRetry.dispatchEvent(new MouseEvent("click"));
          document.querySelector(".gallery-image-pager-stage img").dispatchEvent(new Event("error"));
        }); await tick(page);
        assert.equal(await page.evaluate(() => fixture.pagerSourceWrites), 0, "an obsolete retry action cannot replace the current image source");
        assert.equal(await page.locator(".gallery-image-pager-stage img").getAttribute("src"), source);
        assert.equal(await page.locator(".gallery-image-pager-error").isVisible(), false);
        assert.equal(countRequests(url => url.pathname === "/synthetic/A/1.svg"), reads, "an obsolete retry action cannot restart an earlier image");
      } finally { retryRead.release(); broken?.full.release(); await page.close(); }
    });
    await run("pager image retry close and reopen rejects old controls and callbacks", async () => {
      const page = await newPage(); let broken;
      const retryRead = hold(url => url.pathname === "/synthetic/A/1.svg");
      try {
        broken = await openFailedPager(page); broken.useServer();
        await page.locator(".gallery-image-pager-retry").click(); await requested(retryRead);
        await page.evaluate(() => { fixture.oldImageRetry = document.querySelector(".gallery-image-pager-retry"); fixture.oldPagerImage = document.querySelector(".gallery-image-pager-stage img"); });
        await page.keyboard.press("Escape"); await page.locator(".gallery-reader-open").click();
        await page.locator(".gallery-image-pager-stage img").evaluate(image => image.decode());
        const reads = countRequests(url => url.pathname === "/synthetic/A/1.svg");
        retryRead.release();
        await page.evaluate(() => { fixture.oldImageRetry.dispatchEvent(new MouseEvent("click")); fixture.oldPagerImage.dispatchEvent(new Event("load")); fixture.oldPagerImage.dispatchEvent(new Event("error")); }); await tick(page);
        assert.equal(await page.locator(".gallery-image-pager-error").isVisible(), false);
        assert.equal(await page.locator(".gallery-image-pager-stage img").evaluate(image => image.naturalWidth), 800);
        assert.equal(countRequests(url => url.pathname === "/synthetic/A/1.svg"), reads, "closed overlay handlers must not issue another image request");
      } finally { retryRead.release(); broken?.full.release(); await page.close(); }
    });
    for (const width of [1280, 360]) await run(`pager thumbnail strip scrolls through an entire 83-image album at ${width}px`, async () => {
      const page = await newPage();
      await page.setViewportSize({ width, height: 760 });
      const data = { ...album("A", 0, 83), imageCount: 83 };
      const initial = hold(url => url.pathname === "/api/photo-sets/A", "", { album: data });
      try {
        const opening = open(page, "A"); await requested(initial); initial.release(); await opening;
        await page.locator(".gallery-reader-open").click();
        const strip = page.locator(".gallery-image-pager-thumbnails");
        const counter = page.locator(".gallery-image-pager-counter");
        await strip.locator('[data-index="0"]').evaluate(button => { fixture.firstThumb = button; });
        await page.getByRole("button", { name: "下一张", exact: true }).click();
        assert.equal(await strip.locator('[data-index="0"]').evaluate(button => button === fixture.firstThumb), true);
        assert(await strip.locator("button").count() < 30, "large strips should mount only nearby thumbnails");
        if (width === 360) {
          await dragPager(page, "touch", 0.85, 0.5, 0.15, 0.5, ".gallery-image-pager-thumbnails");
          await page.waitForFunction(() => document.querySelector(".gallery-image-pager-thumbnails").scrollLeft > 0);
        }
        await strip.hover(); await page.mouse.wheel(0, 6000);
        const last = strip.locator('[data-index="82"]');
        await last.waitFor();
        assert.match(await counter.textContent(), /第 2 \/ 83 张/, "scrolling thumbnails does not turn the main page");
        await last.click();
        assert.match(await counter.textContent(), /第 83 \/ 83 张/);
        await strip.hover(); await page.mouse.wheel(0, -6000);
        await strip.locator('[data-index="0"]').click();
        assert.match(await counter.textContent(), /第 1 \/ 83 张/);
      } finally { initial.release(); await page.close(); }
    });
    await run("photo archive video mounts the gallery player and fetches only on play", async () => {
      const page = await newPage();
      const video = { id: "fixture-video", title: "示例视频.webm", ext: ".webm", streamUrl: "/synthetic/video/first.webm" };
      const videoOnly = hold(url => url.pathname === "/api/photo-sets/A", "", {
        album: { ...album("A", 0, 0), imageCount: 0, videos: [video] }
      });
      const mixed = hold(url => url.pathname === "/api/photo-sets/B", "", {
        album: { ...album("B", 0, 2), imageCount: 2, videos: [video, { ...video, id: "second", title: "第二段.webm", streamUrl: "/synthetic/video/second.webm" }] }
      });
      const reads = [];
      try {
        const recording = fs.readFileSync(new URL("./fixtures/gallery-archive-clip.webm", import.meta.url));
        await page.route("**/synthetic/video/*.webm", route => {
          reads.push(new URL(route.request().url()).pathname);
          return route.fulfill({ contentType: "video/webm", body: recording });
        });
        const opening = open(page, "A"); await requested(videoOnly); videoOnly.release(); await opening;
        const player = page.locator(".gallery-media-web-player");
        const videoNode = player.locator("video");
        assert.equal(await page.locator(".gallery-reader-open").count(), 0);
        assert.equal(await videoNode.getAttribute("src"), null);
        assert.deepEqual(reads, []);
        await player.getByRole("button", { name: "播放或暂停" }).click();
        await page.waitForFunction(() => {
          const video = document.querySelector(".gallery-media-web-player video");
          return video?.videoWidth || video?.error;
        }, null, { timeout: 5000 });
        const media = await videoNode.evaluate(node => ({ width: node.videoWidth, error: node.error?.message }));
        assert.equal(media.width, 32, JSON.stringify({ media, reads, bytes: recording.length }));
        assert(reads.includes(video.streamUrl));
        await videoNode.evaluate(node => { fixture.retiredVideo = node; });
        const openingMixed = open(page, "B"); await requested(mixed); mixed.release(); await openingMixed;
        await page.waitForFunction(() => !fixture.retiredVideo.hasAttribute("src"));
        assert.equal(await page.locator(".gallery-reader-figure").count(), 2);
        const before = reads.length;
        await page.getByRole("combobox", { name: "归档视频", exact: true }).selectOption("1");
        assert.equal(await videoNode.getAttribute("src"), null);
        assert.equal(reads.length, before);
        await player.getByRole("button", { name: "播放或暂停" }).click();
        await page.waitForFunction(() => document.querySelector(".gallery-media-web-player video")?.videoWidth === 32);
        assert(reads.includes("/synthetic/video/second.webm"));
      } finally { videoOnly.release(); mixed.release(); await page.close(); }
    });
    await run("pager cover editing saves the requested member and updates the album card", async () => {
      const page = await newPage({ real: true, route: "/photo?photoView=albums&category=fixture" });
      const data = { ...album("A", 0, 83), imageCount: 83, coverEditable: true };
      data.images = data.images.map(image => ({ ...image, archivePath: `photos/${image.index}.jpg` }));
      const initial = hold(url => url.pathname === "/api/photo-sets/A", "", { album: data });
      const writes = [];
      const coverUrl = "/media/gallery-cover/A?cover=fixture-new";
      await page.route("**/api/photo-sets/A/cover", async route => {
        writes.push({ method: route.request().method(), body: route.request().postDataJSON() });
        if (writes.length === 1) await route.fulfill({ status: 409, json: { error: "Synthetic conflict" } });
        else await route.fulfill({ json: { coverImageIndex: 23, coverUrl } });
      });
      try {
        await clickAlbum(page, "A"); await requested(initial); initial.release(); await readerTitle(page, "Album A");
        await page.locator(".gallery-reader-figure").first().press("Enter");
        await page.getByRole("button", { name: "编辑封面", exact: true }).click();
        const input = page.locator(".gallery-image-pager-jump input");
        assert.equal(await input.inputValue(), "1");
        await input.fill("84"); await input.press("Enter");
        assert.equal(await input.getAttribute("aria-invalid"), "true");
        assert.equal(writes.length, 0);
        await input.fill("23"); await input.press("Enter");
        await page.getByText("Synthetic conflict", { exact: true }).waitFor();
        assert.equal(await input.inputValue(), "23");
        await input.press("Enter");
        await page.getByText("第 23 张已设为封面", { exact: true }).waitFor();
        assert.deepEqual(writes, Array.from({ length: 2 }, () => ({ method: "PUT", body: { imageIndex: 23, memberPath: "photos/23.jpg" } })));
        assert.match(await page.locator(".gallery-image-pager-counter").textContent(), /第 1 \/ 83 张/);
        await page.keyboard.press("Escape");
        await page.locator(".gallery-reader-open").click();
        await page.getByRole("button", { name: "编辑封面", exact: true }).waitFor();
        await page.keyboard.press("Escape");
        await page.locator(".gallery-reader-back").click();
        await page.waitForFunction(() => document.querySelector('[data-gallery-album-id="A"] img')?.src.includes('cover=fixture-new'));
      } finally { initial.release(); await page.close(); }
    });
    await run("pager keyboard modal focus and opener restoration", async () => {
      const page = await newPage({ real: true });
      const full = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.get("imageLimit") === "all");
      try {
        await clickAlbum(page, "A"); await readerTitle(page, "Album A");
        await page.locator(".gallery-reader-open").click(); await requested(full);
        assert.equal(await page.locator(".gallery-image-pager-stage").evaluate(node => node === document.activeElement), true);
        const close = page.locator(".gallery-image-pager-top > button").first();
        await close.focus(); await page.keyboard.press("Shift+Tab");
        assert.equal(await page.locator(".gallery-image-pager-thumbnail").last().evaluate(node => node === document.activeElement), true, "reverse Tab wraps inside the modal");
        await page.keyboard.press("Tab");
        assert.equal(await close.evaluate(node => node === document.activeElement), true, "forward Tab wraps inside the modal");
        for (let index = 0; index < 22; index++) {
          await page.keyboard.press("Tab");
          assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest(".gallery-image-pager"))), true, "Tab must never reach the album behind the reader");
        }
        await page.evaluate(() => document.querySelector(".gallery-reader-back").focus());
        assert.equal(await page.locator(".gallery-image-pager-stage").evaluate(node => node === document.activeElement), true, "background programmatic focus remains in the modal");
        await page.keyboard.press("Escape");
        assert.equal(await page.locator(".gallery-image-pager").count(), 0);
        assert.equal(await page.locator(".gallery-reader-open").evaluate(node => node === document.activeElement), true, "closing restores the actual opener");
        assert.equal(await page.evaluate(() => document.body.style.overflow), "");
        await page.locator(".gallery-reader-open").press("Enter");
        await page.keyboard.press("Escape");
        assert.equal(await page.locator(".gallery-reader-open").evaluate(node => node === document.activeElement), true, "reopen retains a fresh focus owner");
      } finally { full.release(); await page.close(); }
    });
    await run("pager keyboard thumbnail focus survives navigation and metadata", async () => {
      const page = await newPage();
      const full = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.get("imageLimit") === "all");
      try {
        await open(page, "A"); await page.locator(".gallery-reader-open").click(); await requested(full);
        await page.locator('.gallery-image-pager-thumbnail[data-index="2"]').focus();
        await page.keyboard.press("Enter");
        assert.match(await page.locator(".gallery-image-pager-counter").textContent(), /第 3 \/ 160 张/);
        assert.equal(await page.evaluate(() => document.activeElement.matches('.gallery-image-pager-thumbnail[data-index="2"]')), true, "thumbnail activation must retain keyboard focus after replacing the strip");
        await settle(page, full);
        await page.waitForFunction(() => document.querySelector(".gallery-image-pager-range")?.max === "10000");
        assert.equal(await page.evaluate(() => document.activeElement.matches('.gallery-image-pager-thumbnail[data-index="2"]')), true, "late full metadata must preserve the focused thumbnail");
        await page.keyboard.press("ArrowRight");
        assert.match(await page.locator(".gallery-image-pager-counter").textContent(), /第 4 \/ 10,000 张/);
        assert.equal(await page.evaluate(() => document.activeElement.matches('.gallery-image-pager-thumbnail[data-index="3"]')), true);
      } finally { full.release(); await page.close(); }
    });
    await run("pager keyboard controls remain visible while focused", async () => {
      const page = await newPage();
      const full = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.get("imageLimit") === "all");
      try {
        await open(page, "A");
        await page.evaluate(() => {
          const setTimeout = window.setTimeout.bind(window);
          window.__pagerHide = [];
          window.setTimeout = (callback, delay, ...args) => delay === 2500 ? (__pagerHide.push(callback), 0) : setTimeout(callback, delay, ...args);
        });
        await page.locator(".gallery-reader-open").click(); await requested(full);
        await page.locator(".gallery-image-pager-range").focus();
        await page.evaluate(() => __pagerHide.at(-1)());
        assert.equal(await page.locator(".gallery-image-pager").evaluate(node => node.classList.contains("chrome-hidden")), false, "idle timeout must not hide a focused control");
        await page.locator(".gallery-image-pager-stage").focus();
        await page.evaluate(() => __pagerHide.at(-1)());
        assert.equal(await page.locator(".gallery-image-pager").evaluate(node => node.classList.contains("chrome-hidden")), true, "idle image viewing still hides chrome");
        await page.keyboard.press("Tab");
        assert.equal(await page.locator(".gallery-image-pager").evaluate(node => node.classList.contains("chrome-hidden")), false, "Tab reveals the control that receives focus");
      } finally { full.release(); await page.close(); }
    });
    await run("pager keyboard preserves modified shortcuts and native controls", async () => {
      const page = await newPage();
      const full = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.get("imageLimit") === "all");
      try {
        await open(page, "A"); await page.locator(".gallery-reader-open").click(); await requested(full);
        await page.keyboard.press("ArrowRight");
        assert.match(await page.locator(".gallery-image-pager-counter").textContent(), /第 2 \/ 160 张/);
        for (const init of [{ ctrlKey: true, key: "ArrowRight" }, { metaKey: true, key: "End" }, { altKey: true, key: "Home" }, { ctrlKey: true, key: "+" }, { isComposing: true, key: "ArrowRight" }]) {
          const cancelled = await page.evaluate(value => {
            const event = new KeyboardEvent("keydown", { ...value, bubbles: true, cancelable: true });
            document.querySelector(".gallery-image-pager-stage").dispatchEvent(event);
            return event.defaultPrevented;
          }, init);
          assert.equal(cancelled, false, `reader must leave modified/composing key alone: ${JSON.stringify(init)}`);
          assert.match(await page.locator(".gallery-image-pager-counter").textContent(), /第 2 \/ 160 张/);
          assert.equal(await page.locator(".gallery-image-pager-zoom").textContent(), "100%");
        }
        await page.locator(".gallery-image-pager-range").focus(); await page.keyboard.press("End");
        assert.match(await page.locator(".gallery-image-pager-counter").textContent(), /第 160 \/ 160 张/);
        await page.keyboard.press("Home");
        assert.match(await page.locator(".gallery-image-pager-counter").textContent(), /第 1 \/ 160 张/);
        await page.keyboard.press("ArrowRight");
        assert.equal(await page.locator(".gallery-image-pager-range").inputValue(), "2");
        await page.keyboard.press("Escape");
        const cancelled = await page.evaluate(() => {
          const event = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
          document.dispatchEvent(event); return event.defaultPrevented;
        });
        assert.equal(cancelled, false, "closed reader releases its keyboard handler");
        await page.locator(".gallery-reader-back").focus();
        assert.equal(await page.locator(".gallery-reader-back").evaluate(node => node === document.activeElement), true, "closed reader releases its focus guard");
      } finally { full.release(); await page.close(); }
    });
    await run("host pager late metadata retains page and zoom", async () => {
      const page = await newPage({ real: true });
      try {
        await clickAlbum(page, "A"); await readerTitle(page, "Album A"); const full = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.get("imageLimit") === "all");
        await page.locator(".gallery-reader-open").click(); await requested(full);
        const next = page.locator(".gallery-image-pager-controls").getByRole("button", { name: "下一张", exact: true }); await next.click(); await next.click();
        await page.locator(".gallery-image-pager-top-actions").getByRole("button", { name: "放大图片", exact: true }).click();
        assert.match(await page.locator(".gallery-image-pager-counter").textContent(), /第 3 \/ 160 张/);
        const src = await page.locator(".gallery-image-pager-stage img").getAttribute("src"); await settle(page, full);
        await page.waitForFunction(() => document.querySelector(".gallery-image-pager-range")?.max === "10000");
        assert.match(await page.locator(".gallery-image-pager-counter").textContent(), /第 3 \/ 10,000 张/); assert.equal(await page.locator(".gallery-image-pager-zoom").textContent(), "125%");
        assert.equal(await page.locator(".gallery-image-pager-stage img").getAttribute("src"), src);
      } finally { await page.close(); }
    });
    await run("full metadata single flight and stale overlay", async () => {
      const page = await newPage();
      try {
        await open(page, "A"); const full = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.get("imageLimit") === "all"), before = countRequests(full.match);
        await page.locator(".gallery-reader-open").click(); await requested(full); await page.keyboard.press("Escape"); await page.locator(".gallery-reader-open").click(); await tick(page);
        assert.equal(countRequests(full.match) - before, 1, "reopening shares the full metadata task"); await open(page, "B"); await settle(page, full);
        assert.equal(await page.evaluate(() => fixture.state.gallery.album.id), "B"); assert.equal(await page.evaluate(() => Boolean(fixture.state.gallery.album.fullImages)), false); assert.equal(await page.locator(".gallery-image-pager").count(), 0);
      } finally { await page.close(); }
    });
    for (const observer of [true, false]) await run(`append retains DOM queue ${observer ? "observer" : "fallback"}`, async () => {
      const page = await newPage({ observer });
      try {
        await open(page, "A"); await page.waitForFunction(() => document.querySelector(".gallery-reader-figure")?.classList.contains("loaded")); await tick(page);
        const pending = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.has("imageOffset"));
        const full = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.get("imageLimit") === "all"), before = countRequests(pending.match);
        await page.evaluate(() => {
          fixture.first = document.querySelector(".gallery-reader-figure"); fixture.img = fixture.first.querySelector("img"); fixture.readerObserver = __readerObservers.at(-1); fixture.viewer = document.querySelector(".gallery-reader-images");
          const button = document.querySelector(".gallery-more"); button.dispatchEvent(new MouseEvent("click")); button.dispatchEvent(new MouseEvent("click"));
        }); await requested(pending); await page.locator(".gallery-reader-open").click(); await requested(full);
        await page.locator(".gallery-image-pager-controls").getByRole("button", { name: "下一张", exact: true }).click(); await page.evaluate(() => { fixture.overlay = document.querySelector(".gallery-image-pager"); }); await settle(page, pending);
        assert.equal(countRequests(pending.match) - before, 1, "double append click issues one page request"); assert.equal(await page.locator(".gallery-reader-figure").count(), 320);
        assert.equal(await page.evaluate(() => new Set(fixture.state.gallery.album.images.map(image => image.index)).size), 320);
        assert.equal(await page.evaluate(() => fixture.first === document.querySelector(".gallery-reader-figure") && fixture.img === fixture.first.querySelector("img") && fixture.viewer === document.querySelector(".gallery-reader-images")), true);
        assert.equal(await page.evaluate(() => fixture.overlay === document.querySelector(".gallery-image-pager")), true); assert.match(await page.locator(".gallery-image-pager-counter").textContent(), /第 2 \/ 160 张/);
        if (observer) assert.deepEqual(await page.evaluate(() => ({ same: fixture.readerObserver === __readerObservers.at(-1), disconnected: fixture.readerObserver.disconnected, observed: fixture.readerObserver.observed.size })), { same: true, disconnected: false, observed: 320 });
        await settle(page, full); assert.match(await page.locator(".gallery-image-pager-counter").textContent(), /第 2 \/ 10,000 张/); await page.keyboard.press("Escape");
        // Decoding the synthetic 800x1000 neighbours changes intrinsic heights.
        // Keep the target in view while those heights settle, just as scrolling
        // toward it would; an unregistered appended figure still never loads.
        const deadline = Date.now() + 5000;
        while (!await page.evaluate(() => document.querySelector('.gallery-reader-figure[data-image-index="161"]')?.classList.contains("loaded"))) {
          assert(Date.now() < deadline, "appended figure must enter the existing image loader");
          await page.locator('.gallery-reader-figure[data-image-index="161"]').scrollIntoViewIfNeeded(); await tick(page);
        }
      } finally { await page.close(); }
    });
    await run("page task single flight and summary preserves overlay", async () => {
      const page = await newPage();
      try {
        await open(page, "A"); const pending = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.has("imageOffset"));
        await page.evaluate(() => { const a = fixture.page.loadPhotoReaderImages(320), b = fixture.page.loadPhotoReaderImages(320); fixture.sameTask = a === b; fixture.task = a; }); await requested(pending);
        assert.equal(await page.evaluate(() => fixture.sameTask), true); await settle(page, pending); await page.evaluate(() => fixture.task);
        const full = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.get("imageLimit") === "all"); await page.locator(".gallery-reader-open").click(); await requested(full);
        await page.evaluate(() => { fixture.first = document.querySelector(".gallery-reader-figure"); fixture.overlay = document.querySelector(".gallery-image-pager"); }); await page.evaluate(() => fixture.page.loadImageLibrary({ reload: true }));
        assert.equal(await page.evaluate(() => fixture.first === document.querySelector(".gallery-reader-figure") && fixture.overlay === document.querySelector(".gallery-image-pager")), true); await settle(page, full);
      } finally { await page.close(); }
    });
    await run("append retains in flight startup queue", async () => {
      const page = await newPage();
      try {
        const before = countRequests(url => /^\/synthetic\/A\/\d+\.svg$/.test(url.pathname));
        const first = hold(url => url.pathname === "/synthetic/A/1.svg"); await open(page, "A"); await requested(first);
        await page.evaluate(() => { fixture.first = document.querySelector(".gallery-reader-figure"); fixture.img = fixture.first.querySelector("img"); fixture.readerObserver = __readerObservers.at(-1); });
        const pending = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.has("imageOffset")); await more(page); await requested(pending); await settle(page, pending);
        assert.equal(await page.evaluate(() => fixture.first === document.querySelector(".gallery-reader-figure") && fixture.img === fixture.first.querySelector("img") && fixture.first.dataset.galleryLoading === "1"), true);
        assert.equal(await page.evaluate(() => fixture.readerObserver === __readerObservers.at(-1) && !fixture.readerObserver.disconnected), true);
        assert.equal(countRequests(url => /^\/synthetic\/A\/\d+\.svg$/.test(url.pathname)) - before, 1, "pending startup image must retain the one-slot queue gate across append");
        first.release(); await page.waitForFunction(() => fixture.first.classList.contains("loaded"));
        await page.waitForFunction(() => document.querySelector('.gallery-reader-figure[data-image-index="2"]')?.classList.contains("loaded"));
      } finally { await page.close(); }
    });
    for (const ignoreAbort of [true, false]) for (const error of ["", "old route error"]) await run(`route boot B ${ignoreAbort ? "ignores abort" : "normal abort"} ${error ? "error" : "success"}`, async () => {
      const old = hold(url => url.pathname === "/api/photo-sets/A", error), current = hold(url => url.pathname === "/api/photo-sets/B");
      const page = await newPage({ real: true, route: "/photo/set/A", waitReady: false, ignoreAbort });
      try {
        await requested(old); await navigateRoute(page, "/photo/set/B");
        await requested(current, 1500);
        assert(await page.evaluate(() => __transport.aborted.some(url => url.startsWith("/api/photo-sets/A"))), "popstate intent must abort A before B settles");
        await settle(page, current); await readerTitle(page, "Album B");
        assert.equal(await page.evaluate(() => document.documentElement.classList.contains("app-module-loading")), false, "latest route must finish bootstrap while the obsolete transport is still held");
        assert.equal(new URL(page.url()).pathname, "/photo/set/B");
        await finishOld(page, old, ignoreAbort);
        assert.equal(await page.locator(".gallery-reader-title strong").textContent(), "Album B"); assert.equal(new URL(page.url()).pathname, "/photo/set/B");
        assert(!(await page.locator("#workGrid").textContent()).includes("old route error"));
        await page.locator(".gallery-reader-back").click();
        assert.equal(new URL(page.url()).pathname, "/photo/collections", "bootstrap must initialize routeReady for the current intent");
      } finally { await page.close(); }
    });
    for (const inPage of [false, true]) await run(`photo collection ${inPage ? "in-page" : "browser"} back restores deep cards on both levels after a delayed shelf reload`, async () => {
      const shelf = collectionShelfFixture(172);
      const albums = Array.from({ length: 172 }, (_, index) => listItem(`A${index}`));
      collectionShelf = url => {
        if (!url.searchParams.has("collection")) return shelf(url);
        const offset = Number(url.searchParams.get("offset")), limit = Number(url.searchParams.get("limit"));
        return { items: albums.slice(offset, offset + limit), total: albums.length, facets: {},
          collectionSummary: { title: "Fixture collection" } };
      };
      const page = await newPage({ real: true, route: "/photo/collections" });
      let returned;
      try {
        await page.locator(".gallery-more").evaluate(button => button.click());
        const card = page.locator(".gallery-collection-card").nth(110);
        await card.waitFor(); await tick(page);
        await card.evaluate(node => node.scrollIntoView({ block: "center", behavior: "instant" }));
        const origin = page.url();
        const top = await card.evaluate(node => node.getBoundingClientRect().top);
        const collectionBox = await card.boundingBox();
        await page.mouse.click(collectionBox.x + collectionBox.width / 2, collectionBox.y + collectionBox.height / 2);
        await page.waitForURL(url => url.pathname.startsWith("/photo/collection/"));
        const collectionUrl = page.url();
        assert.equal(await page.evaluate(() => scrollY), 0, "entering a collection must start at the top immediately");
        await page.locator(".gallery-photo-album-card").first().evaluate(node => { window.__firstCollectionAlbum = node; });
        await page.locator(".gallery-more").evaluate(button => button.click());
        const albumCard = page.locator('[data-gallery-album-id="A110"]');
        await albumCard.waitFor(); await tick(page);
        assert.equal(await page.evaluate(() => __firstCollectionAlbum === document.querySelector(".gallery-photo-album-card")), true,
          "loading more albums must retain the existing collection cards");
        await albumCard.evaluate(node => node.scrollIntoView({ block: "center", behavior: "instant" }));
        const albumTop = await albumCard.evaluate(node => node.getBoundingClientRect().top);
        if (inPage) {
          await albumCard.evaluate(node => node.focus({ preventScroll: true }));
          await page.keyboard.press("Enter");
        } else {
          const box = await albumCard.boundingBox();
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        }
        await readerTitle(page, "Album A110");
        assert.equal(await page.evaluate(() => scrollY), 0, "entering an album must start at the top immediately");
        const albumUrl = page.url();
        if (inPage) await page.locator(".gallery-reader-back").click();
        else await page.goBack();
        await page.waitForURL(collectionUrl);
        await page.waitForFunction(({ albumTop }) => {
          const target = document.querySelector('[data-gallery-album-id="A110"]');
          return target && Math.abs(target.getBoundingClientRect().top - albumTop) <= 3;
        }, { albumTop }, { timeout: 3500 });
        if (inPage) assert.equal(await albumCard.evaluate(node => document.activeElement === node), true);
        returned = hold(url => url.pathname === "/api/image-library/items" && !url.searchParams.has("collection"));
        if (inPage) await page.locator(".gallery-collection-breadcrumb").getByRole("button", { name: "图库", exact: true }).click();
        else await page.goBack();
        await requested(returned);
        assert.equal(page.url(), origin);
        await settle(page, returned);
        await page.waitForFunction(({ top }) => {
          const target = document.querySelectorAll(".gallery-collection-card")[110];
          return target && Math.abs(target.getBoundingClientRect().top - top) <= 3;
        }, { top }, { timeout: 3500 });
        if (inPage) {
          await page.goForward(); await page.waitForURL(collectionUrl);
          await page.goForward(); await page.waitForURL(albumUrl);
          await readerTitle(page, "Album A110");
        }
      } finally { returned?.release(); collectionShelf = null; await page.close(); }
    });
    for (const replacePending of [false, true]) await run(`photo collection browser back ${replacePending ? "after selecting a different pending album" : "while an album is still loading"}`, async () => {
      const shelf = collectionShelfFixture(12);
      collectionShelf = url => url.searchParams.has("collection")
        ? { items: [listItem("A"), listItem("B")], total: 2, facets: {}, collectionSummary: { title: "Fixture collection" } }
        : shelf(url);
      const page = await newPage({ real: true, route: "/photo/collections" });
      const first = hold(url => url.pathname === "/api/photo-sets/A");
      const second = replacePending ? hold(url => url.pathname === "/api/photo-sets/B") : null;
      try {
        await page.locator(".gallery-collection-card").first().click();
        await page.waitForURL(url => url.pathname.startsWith("/photo/collection/"));
        const collectionUrl = page.url();
        await clickAlbum(page, "A"); await requested(first);
        assert.equal(await page.locator(".gallery-reader-title").count(), 0);
        if (second) { await clickAlbum(page, "B"); await requested(second); }
        await page.goBack();
        assert.equal(page.url(), collectionUrl, "browser Back from a pending reader must return to the collection it was opened from");
        await settle(page, first);
        if (second) await settle(page, second);
        await page.locator(".gallery-photo-album-card").first().waitFor();
        assert.equal(page.url(), collectionUrl);
        assert.equal(await page.locator(".gallery-reader-title").count(), 0, "the late archive response must not reopen the reader");
        await page.goForward();
        await readerTitle(page, replacePending ? "Album B" : "Album A");
        await page.goBack();
        assert.equal(page.url(), collectionUrl);
      } finally { first.release(); second?.release(); collectionShelf = null; await page.close(); }
    });
    for (const error of ["", "old route error"]) await run(`route initial deep link browser back ${error ? "error" : "success"}`, async () => {
      const old = hold(url => url.pathname === "/api/photo-sets/A", error);
      const page = await newPage({ real: true, route: "/photo/set/A", waitReady: false, initialBack: true });
      try {
        await requested(old); await page.goBack();
        await page.waitForFunction(() => __transport.aborted.some(url => url.startsWith("/api/photo-sets/A")), null, { timeout: 1500 });
        await page.locator(".gallery-card").first().waitFor({ state: "visible", timeout: 5000 });
        assert.equal(new URL(page.url()).pathname, "/photo/albums"); assert.equal(await page.locator(".gallery-reader-title").count(), 0);
        await settle(page, old); assert.equal(new URL(page.url()).pathname, "/photo/albums"); assert.equal(await page.locator(".gallery-reader-title").count(), 0);
        assert(!(await page.locator("#workGrid").textContent()).includes("old route error"));
        // A usable current history owner must also accept an ordinary card click.
        await clickAlbum(page, "B"); await readerTitle(page, "Album B"); assert.equal(new URL(page.url()).pathname, "/photo/set/B");
      } finally { await page.close(); }
    });
    for (const error of ["", "old route error"]) await run(`route old settles while latest boot pending ${error ? "error" : "success"}`, async () => {
      const old = hold(url => url.pathname === "/api/photo-sets/A", error), current = hold(url => url.pathname === "/api/photo-sets/B");
      const page = await newPage({ real: true, route: "/photo/set/A", waitReady: false });
      try {
        await requested(old); await navigateRoute(page, "/photo/set/B"); await requested(current, 1500); await settle(page, old);
        assert.equal(new URL(page.url()).pathname, "/photo/set/B"); assert.equal(await page.locator(".gallery-reader-title").count(), 0);
        assert.equal(await page.evaluate(() => document.documentElement.classList.contains("app-module-loading")), true, "old completion must not finish the pending latest boot");
        assert(!(await page.locator("#workGrid").textContent()).includes("old route error"));
        await settle(page, current); await readerTitle(page, "Album B");
        assert.equal(await page.evaluate(() => document.documentElement.classList.contains("app-module-loading")), false);
      } finally { await page.close(); }
    });
    for (const action of ["list", "search"]) await run(`route boot local ${action} intent`, async () => {
      const route = action === "list" ? "/photo/set/A?photoView=albums" : "/photo/set/A";
      const old = hold(url => url.pathname === "/api/photo-sets/A"), page = await newPage({ real: true, route, waitReady: false });
      try {
        await requested(old); await page.locator(".gallery-controls").waitFor({ state: "attached" });
        // The initial loading stylesheet hides the body. Dispatch the actual
        // DOM handlers here without altering that stylesheet; the separate
        // post-boot case below exercises an ordinary visible pointer click.
        await page.evaluate(action => {
          if (action === "list") document.querySelector(".gallery-photo-category-strip > button").click();
          else { const input = document.querySelector(".gallery-search"); input.value = "B"; input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); }
        }, action);
        await page.waitForFunction(() => !document.documentElement.classList.contains("app-module-loading"), null, { timeout: 1500 });
        const destination = action === "search" ? "/photo/search" : "/photo/collections";
        assert.equal(new URL(page.url()).pathname, destination); assert.equal(new URL(page.url()).searchParams.get("q"), action === "search" ? "B" : null);
        assert(await page.evaluate(() => __transport.aborted.some(url => url.startsWith("/api/photo-sets/A"))));
        await settle(page, old); assert.equal(await page.locator(".gallery-reader-title").count(), 0); assert.equal(new URL(page.url()).pathname, destination);
      } finally { await page.close(); }
    });
    await run("route visible local list click", async () => {
      const page = await newPage({ real: true });
      try {
        const old = hold(url => url.pathname === "/api/photo-sets/A"); await navigateRoute(page, "/photo/set/A?photoView=albums"); await requested(old);
        await page.getByRole("button", { name: /^全部大类(?:，|$)/ }).click();
        assert.equal(new URL(page.url()).pathname, "/photo/collections"); await settle(page, old);
        assert.equal(await page.locator(".gallery-reader-title").count(), 0); assert.equal(new URL(page.url()).pathname, "/photo/collections");
      } finally { await page.close(); }
    });
    for (const target of ["/photo/set/B", "/manga"]) await run(`route module import late startup ${target}`, async () => {
      const module = hold(url => url.pathname === "/modules/content-index/gallery-page.js");
      const firstTarget = hold(url => ["/api/photo-sets/A", "/api/photo-sets/B", "/api/manga"].includes(url.pathname));
      const before = countRequests(url => url.pathname === "/api/photo-sets/A"), summaryReads = countRequests(isSummary);
      const page = await newPage({ real: true, route: "/photo/set/A", waitReady: false });
      try {
        await requested(module);
        assert.equal(countRequests(isSummary), summaryReads, "a direct album does not prefetch the browse overview");
        await navigateRoute(page, target); module.release();
        await requested(firstTarget);
        assert.equal(new URL(firstTarget.url, base).pathname, target === "/manga" ? "/api/manga" : "/api/photo-sets/B", "module await must select the latest route's first API request");
        firstTarget.release();
        if (target === "/manga") await page.locator(".manga-library").waitFor({ state: "visible", timeout: 5000 });
        else { await readerTitle(page, "Album B"); await page.waitForFunction(() => !document.documentElement.classList.contains("app-module-loading"), null, { timeout: 5000 }); }
        assert.equal(new URL(page.url()).pathname, target); assert.equal(countRequests(url => url.pathname === "/api/photo-sets/A"), before, "module await must read the latest startup URL before requesting the old target");
      } finally { await page.close(); }
    });
    for (const [initial, endpoint, target, title] of [
      ["/photo/set/A", "/api/photo-sets/A", "/media/W", "Media W"],
      ["/media/Movie", "/api/gallery-media/Movie", "/photo/set/B", "Album B"]
    ]) await run(`route gallery mode ${initial} to ${target}`, async () => {
      const old = hold(url => url.pathname === endpoint), page = await newPage({ real: true, route: initial, waitReady: false });
      try {
        await requested(old); await navigateRoute(page, target); await readerTitle(page, title);
        await page.waitForFunction(() => !document.documentElement.classList.contains("app-module-loading"), null, { timeout: 5000 });
        await settle(page, old); assert.equal(await page.locator(".gallery-reader-title strong").textContent(), title);
        assert.equal(new URL(page.url()).pathname, target, "late media must not redirect to player or restore the old gallery mode");
      } finally { await page.close(); }
    });
    for (const [initial, endpoint, target, selector] of [
      ["/photo/set/A", "/api/photo-sets/A", "/manga", ".manga-library"],
      ["/manga/C", "/api/manga/C", "/photo/set/B", ".gallery-reader-title"]
    ]) await run(`route module handoff ${initial} to ${target}`, async () => {
      const old = hold(url => url.pathname === endpoint), page = await newPage({ real: true, route: initial, waitReady: false });
      try {
        await requested(old); await navigateRoute(page, target);
        await page.locator(selector).waitFor({ state: "visible", timeout: 5000 });
        assert.equal(new URL(page.url()).pathname, target); await until(() => old.closed, "module handoff must unload/close the obsolete document's request"); old.release(); await tick(page);
        assert.equal(new URL(page.url()).pathname, target); assert.equal(await page.locator(selector).count(), 1);
        assert(!(await page.locator("#workGrid").textContent()).includes("old route error"));
      } finally { await page.close(); }
    });
    if (timings) await run("incremental render timing", async () => {
      const page = await newPage();
      try {
        await open(page, "A"); const results = [];
        for (const retained of [160, 800, 1600, 3200]) for (let sample = 0; sample < 3; sample++) {
          await page.evaluate(count => {
            const images = Array.from({ length: count }, (_, i) => ({ index: i + 1, name: `synthetic ${i + 1}`, url: `/synthetic/A/${i + 1}.svg` }));
            fixture.state.gallery.album = { ...fixture.state.gallery.album, images, imageCount: 10000 }; fixture.renderer.renderView();
          }, retained); await tick(page);
          const data = await page.evaluate(async () => {
            const viewer = document.querySelector(".gallery-reader-images"), first = viewer.firstElementChild, count = viewer.childElementCount, before = performance.now();
            const completion = new Promise(resolve => { const obs = new MutationObserver(() => { if (document.querySelector(".gallery-reader-images")?.childElementCount > count) { obs.disconnect(); resolve(); } }); obs.observe(document.querySelector("#workGrid"), { childList: true, subtree: true }); });
            document.querySelector(".gallery-more").click(); await completion;
            const current = document.querySelector(".gallery-reader-images");
            return { elapsedMs: +(performance.now() - before).toFixed(2), updateMs: +(performance.now() - (__transport.lastAlbumJsonAt || before)).toFixed(2), sameFirst: first === current.firstElementChild, figures: current.childElementCount };
          }); if (!legacy) assert.equal(data.sameFirst, true); assert.equal(data.figures, retained + 160); results.push({ retained, sample, ...data });
        }
        console.log(`incremental-render ${JSON.stringify(results)}`);
      } finally { await page.close(); }
    });
    assert(checks > 0, `no gallery fixture cases matched: ${casePattern}`);
    assert.deepEqual(faults, [], "private browser must not hide page errors"); console.log(`Web gallery reader fixture passed (${checks} cases; private Chromium, synthetic responses)`); return { checks };
  } finally {
    for (const value of held) value.release(); if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  function countRequests(match) { return [...requests].filter(([url]) => match(new URL(url, base))).reduce((sum, [, count]) => sum + count, 0); }
  async function openFailedPager(page) {
    let serveImage = false;
    await page.route("**/synthetic/A/1.svg", route => serveImage ? route.continue()
      : route.fulfill({ status: 503, contentType: "text/plain", body: "Synthetic image failure", headers: { "Cache-Control": "no-store" } }));
    await open(page, "A");
    const full = hold(url => url.pathname === "/api/photo-sets/A" && url.searchParams.get("imageLimit") === "all");
    await page.locator(".gallery-reader-open").click(); await requested(full);
    await page.locator(".gallery-image-pager-retry").waitFor({ state: "visible", timeout: 5000 });
    return { full, useServer: () => { serveImage = true; } };
  }
  function hold(match, error = "", body = null) {
    let release, requestedResolve; const value = { match, error, body, used: false, closed: false, promise: new Promise(resolve => { release = resolve; }), requested: new Promise(resolve => { requestedResolve = resolve; }), release, requestedResolve }; held.add(value); return value;
  }
  function isSummary(url, method = 'GET') { return method === 'GET' && url.pathname === '/api/image-library/summary' && ['', '?mode=photo'].includes(url.search); }
  function releaseSummaryGates(...gates) { for (const gate of gates) { if (!gate.used) held.delete(gate); gate.release(); } }
  function assertReadOnly(start) { assert(apiMethods.slice(start).every(request => request.method === 'GET' && !request.url.includes('/rescan')), 'summary recovery must use read-only APIs and never scan or write the library'); }
  async function coldSummaryPage(route = '/photo?photoView=albums') {
    const failed = hold(isSummary, 'Synthetic cold summary unavailable');
    const page = await newPage({ real: true, route, waitReady: false });
    try { await requested(failed); await settle(page, failed); assert.equal(await page.locator('.gallery-summary-retry').count(), 1, 'cold failure must offer one current summary recovery control'); return page; }
    catch (error) { await page.close(); throw error; }
    finally { failed.release(); }
  }
  async function rememberSummaryControl(page) { await page.locator('.gallery-summary-retry').evaluate(button => { window.__summaryControl = { button, parents: [] }; for (let node = button; node; node = node.parentElement) __summaryControl.parents.push(node); }); }
  async function summaryControlRetained(page) { return page.evaluate(() => __summaryControl.button === document.querySelector('.gallery-summary-retry') && document.activeElement === __summaryControl.button && __summaryControl.parents.every(node => node.isConnected)); }
  async function requested(gate, timeout = 5000) { let timer; try { await Promise.race([gate.requested, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("held request did not start")), timeout); })]); } finally { clearTimeout(timer); } }
  async function finishOld(page, gate, ignoreAbort) { if (ignoreAbort) await settle(page, gate); else { await until(() => gate.closed, "old aborted request must close"); gate.release(); await tick(page); } }
  async function settle(page, gate) {
    const before = await page.evaluate(url => __transport.settled.filter(item => item.url === url).length, gate.url); gate.release();
    await page.waitForFunction(({ url, before }) => __transport.settled.filter(item => item.url === url).length > before, { url: gate.url, before }); await tick(page);
  }
  async function newPage({ real = false, ignoreAbort = true, observer = true, route = "/photo?photoView=albums", waitReady = true, initialBack = false, downloadThroughput = null } = {}) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.on("pageerror", error => faults.push(error.message));
    if (downloadThroughput) {
      const session = await page.context().newCDPSession(page);
      await session.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput, uploadThroughput: -1 });
    }
    await page.addInitScript(({ ignoreAbort, observer, initialBack }) => {
      const originalFetch = window.fetch.bind(window); window.__transport = { settled: [], aborted: [], lastAlbumJsonAt: 0 };
      window.fetch = async (url, options = {}) => {
        const key = new URL(String(url), location.href), relative = `${key.pathname}${key.search}`;
        options.signal?.addEventListener("abort", () => __transport.aborted.push(relative), { once: true });
        // Bypass Chromium's cache-key lock so two deliberately uncancelled
        // requests for the same album/page can reach separate controlled gates.
        const response = await originalFetch(url, ignoreAbort ? { ...options, cache: "no-store", signal: undefined } : options), originalJson = response.json.bind(response);
        response.json = async () => { try { return await originalJson(); } finally { __transport.settled.push({ url: relative, ok: response.ok }); if (relative.startsWith("/api/photo-sets/")) __transport.lastAlbumJsonAt = performance.now(); } }; return response;
      };
      window.__readerObservers = [];
      if (observer) {
        const NativeObserver = window.IntersectionObserver;
        window.IntersectionObserver = class extends NativeObserver {
          constructor(callback, options) { super(callback, options); this.observed = new Set(); this.disconnected = false; if (options?.rootMargin === "900px 0px 1400px 0px") __readerObservers.push(this); }
          observe(node) { this.observed.add(node); super.observe(node); }
          disconnect() { this.disconnected = true; super.disconnect(); }
        };
      } else delete window.IntersectionObserver;
      if (initialBack && location.pathname === "/photo/set/A") {
        // Same-document history at bootstrap: a real goBack delivers popstate
        // while A is held, rather than unloading the entire reader document.
        const deepLink = `${location.pathname}${location.search}`;
        history.replaceState(null, "", "/photo/albums"); history.pushState(null, "", deepLink);
      }
    }, { ignoreAbort, observer, initialBack });
    await page.goto(real ? `${base}${route}` : `${base}/probe`, { waitUntil: waitReady ? "load" : "commit" });
    if (waitReady) { if (real) await page.locator(".gallery-card").first().waitFor(); else await page.waitForFunction(() => Boolean(window.fixture?.ready)); } return page;
  }
}
async function tick(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function beginRangeGesture(page, pointer) {
  const range = page.locator('.gallery-image-pager-range'), rect = await range.boundingBox();
  await range.evaluate(range => range.addEventListener('pointerdown', event => { window.__rangePointerType = event.pointerType; }, { once: true }));
  let finished = false;
  if (pointer === 'mouse') {
    await page.mouse.move(rect.x + rect.width * .65, rect.y + rect.height / 2); await page.mouse.down();
    return { finish: async () => { if (!finished) { finished = true; await page.mouse.up(); } } };
  }
  const session = await page.context().newCDPSession(page);
  const point = x => [{ x, y: rect.y + rect.height / 2, id: 1, radiusX: 2, radiusY: 2, force: 1 }];
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(rect.x + 8) });
  await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(rect.x + rect.width * .65) });
  return { finish: async cancel => { if (finished) return; finished = true;
    try { await session.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] }); }
    finally { await session.detach(); }
  } };
}
async function zoomRegion(page) {
  return page.locator('.gallery-image-pager-stage').evaluate(stage => {
    const image = stage.querySelector('img'), bounds = stage.getBoundingClientRect(), rect = image.getBoundingClientRect();
    const x = bounds.left + stage.clientLeft + stage.clientWidth / 2, y = bounds.top + stage.clientTop + stage.clientHeight / 2;
    return { left: stage.scrollLeft, top: stage.scrollTop, u: (x - rect.left) / rect.width, v: (y - rect.top) / rect.height,
      imagePoint: document.elementFromPoint(x, y) === image, source: image.getAttribute('src') };
  });
}
async function holdZoomFrames(page) {
  await page.evaluate(() => {
    const native = window.requestAnimationFrame.bind(window); window.__zoomFrames = [];
    window.requestAnimationFrame = callback => callback.name === 'follow'
      ? (__zoomFrames.push(callback), native(() => {})) : native(callback);
  });
}
async function pagerZoomReady(page) {
  await page.waitForFunction(() => {
    const image = document.querySelector('.gallery-image-pager-stage img');
    const rect = image?.getBoundingClientRect();
    return image?.complete && image.naturalWidth && Math.abs(rect.width - parseFloat(image.style.width)) < 1
      && Math.abs(rect.height - parseFloat(image.style.height)) < 1;
  });
}
async function dragPager(page, input, x1, y1, x2, y2, selector = '.gallery-image-pager-stage') {
  const box = await page.locator(selector).boundingBox();
  const from = { x: box.x + box.width * x1, y: box.y + box.height * y1 };
  const to = { x: box.x + box.width * x2, y: box.y + box.height * y2 };
  if (input === 'mouse') {
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 }); await page.mouse.up();
  } else {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...from, id: 0 }] });
      for (let step = 1; step <= 12; step++) await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * step / 12, y: from.y + (to.y - from.y) * step / 12, id: 0 }]
      });
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally { await session.detach(); }
  }
  await tick(page);
}
function visibleReaderImage() {
  const top = Math.max(0, document.querySelector('.gallery-reader-toolbar')?.getBoundingClientRect().bottom || 0);
  for (const figure of document.querySelectorAll('.gallery-reader-figure')) {
    const outer = figure.getBoundingClientRect();
    if (outer.bottom <= top || outer.top >= innerHeight) continue;
    const image = figure.querySelector('img');
    if (!image?.complete || !image.naturalWidth) continue;
    const rect = image.getBoundingClientRect(), upper = Math.max(top, rect.top), lower = Math.min(innerHeight, rect.bottom);
    if (lower <= upper || rect.width <= 0) continue;
    const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
    if (document.elementFromPoint(x, (upper + lower) / 2) === image) return { index: figure.dataset.imageIndex, naturalWidth: image.naturalWidth, top: rect.top, bottom: rect.bottom };
  }
  return null;
}
async function holdReaderWidthFrames(page) { await page.evaluate(() => { fixture.nativeWidthFrame = window.requestAnimationFrame; fixture.widthFrames = []; window.requestAnimationFrame = callback => { fixture.widthFrames.push(callback); return 0; }; }); }
async function releaseReaderWidthFrames(page) { await page.evaluate(() => { window.requestAnimationFrame = fixture.nativeWidthFrame; const frames = fixture.widthFrames; fixture.widthFrames = []; for (const frame of frames) frame(performance.now()); }); }
async function pagerRetrySnapshot(page) { return page.evaluate(() => ({
  viewer: fixture.pager === document.querySelector(".gallery-image-pager"),
  image: fixture.pagerImage === document.querySelector(".gallery-image-pager-stage img"),
  thumbnails: fixture.pagerThumbs.every((node, index) => node === document.querySelectorAll(".gallery-image-pager-thumbnail")[index]),
  counter: document.querySelector(".gallery-image-pager-counter").textContent,
  zoom: document.querySelector(".gallery-image-pager-zoom").textContent,
  range: document.querySelector(".gallery-image-pager-range").value,
  route: location.pathname + location.search,
  scroll: scrollY
})); }
async function until(predicate, message) { const deadline = Date.now() + 5000; while (!predicate()) { assert(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 10)); } }
async function open(page, id) { await page.evaluate(value => fixture.page.openPhotoSet(value), id); }
async function more(page) { await page.evaluate(() => document.querySelector(".gallery-more").click()); }
async function clickAlbum(page, id) { await page.getByRole("button").filter({ hasText: `Album ${id}` }).click(); }
async function readerTitle(page, title) { await page.waitForFunction(text => document.querySelector(".gallery-reader-title strong")?.textContent === text, title, { timeout: 5000 }); }
async function navigateRoute(page, target) { await page.evaluate(url => { history.pushState(null, "", url); dispatchEvent(new PopStateEvent("popstate")); }, target); }
function sendText(res, body, type, cache = "no-store") { res.writeHead(200, { "Content-Type": type, "Cache-Control": cache }); res.end(body); }
function sendJson(res, body, status = 200) { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); }
function collectionShelfFixture(collectionCount, { grouped = false, revision = "fixture-v1", first = 1 } = {}) {
  const groups = Array.from({ length: Math.min(10, collectionCount) }, (_, index) => {
    const category = `Category ${index + 1}`;
    return { id: `R|${category}`, type: "photoCollectionCategory", title: category, category, rootLabel: "R", collections: [] };
  });
  for (let index = 0; index < collectionCount; index++) {
    const group = groups[index % groups.length], n = index + first, id = `R|C${n}`, title = `Collection ${n}`;
    group.collections.push({ id, type: "photoCollection", title, category: group.category, subCategory: "Portraits", personName: "", seriesName: "",
      rootLabel: "R", ext: "", size: 1000 + index, updatedAt: "2026-01-01T00:00:00.000Z", imageCount: 64, albumCount: 8,
      collectionId: id, collectionTitle: title, playable: false, coverUrl: "/synthetic/collection.svg", routePath: `/photo/collection/${encodeURIComponent(id)}` });
  }
  for (const group of groups) {
    group.subCategory = group.collections.map(item => item.title).join(" · ");
    group.albumCount = group.collections.length * 8;
    group.collectionCount = group.collections.length;
  }
  const facets = { categories: groups.map(group => ({ value: group.category, count: group.albumCount })) };
  return url => {
    const params = url.searchParams, category = params.get("category"), limit = Number(params.get("limit") || 80), offset = Number(params.get("offset") || 0);
    const flat = !grouped && params.get("collectionPage") === "1";
    const selected = category ? groups.filter(group => group.category === category) : groups;
    const source = flat ? photoCatalogCollections(selected, params.get("sort")) : selected;
    const items = source.slice(offset, offset + limit);
    return { items, facets, limit, offset, count: items.length, total: source.length, nextOffset: offset + items.length, listRevision: revision,
      ...(flat ? { collectionPage: true, stats: { albumCount: source.reduce((sum, item) => sum + item.albumCount, 0) } } : {}) };
  };
}
function listItem(id) { return { id, type: "photo", title: `Album ${id}`, category: "fixture", imageCount: 10000, coverUrl: `/synthetic/${id}/cover.svg` }; }
function album(id, offset, limit) { return { ...listItem(id), images: Array.from({ length: Math.min(limit, 10000 - offset) }, (_, i) => ({ index: offset + i + 1, name: `synthetic ${offset + i + 1}`, url: `/synthetic/${id}/${offset + i + 1}.svg` })) }; }
function manga(id) { return { id, title: `Comic ${id}`, chapters: [1, 2].map(index => ({ index, title: `Chapter ${index}` })) }; }
function harness() {
  return `<!doctype html><meta charset=utf-8><link rel=stylesheet href=/modules/content-index/styles.css><style>body{margin:0;background:#1c2220;color:white}main{max-width:1050px;margin:auto}</style><main><div id=statsRow></div><div id=workGrid></div></main><script type=module>
import {createGalleryPage} from '/modules/content-index/gallery-page.js';
import {createGalleryRenderer} from '/modules/content-index/gallery-renderer.js';
const state={activeView:'gallery',accessMode:'local',uiConfig:{},gallery:{mode:'photo',photoView:'albums',category:'all',subCategory:'all',person:'all',photoDate:'all',query:'',sort:'updated',mediaKind:'all',seriesKey:'',visibleLimit:80,fitWidth:true,album:null,comic:null,media:null,data:{totals:{photoSets:2,manga:1},facets:{}},status:''}};
const els={workGrid:document.querySelector('#workGrid'),statsRow:document.querySelector('#statsRow')};
const noop=()=>{},formatNumber=value=>new Intl.NumberFormat('zh-CN').format(value||0);
const api=async(url,options={})=>{const res=await fetch(url,options);const data=await res.json();if(!res.ok)throw new Error(data.error||'controlled error');return data;};
let page;const route=()=>history.replaceState(null,'',state.gallery.album?'/photo/'+state.gallery.album.id:'/photo?photoView=albums');
const shared={api,state,els,formatNumber,formatBytes:value=>String(value||0),formatDateTime:value=>String(value||''),cancelScheduledWorkRendering:noop,disconnectPeopleIndexAutoload:noop,resetProgressiveCoverLoading:noop,writeStoredFlag:noop,includesText:(text,q)=>String(text||'').includes(q),openAdminScript:noop};
const renderer=createGalleryRenderer({...shared,getGalleryPage:()=>page});
page=createGalleryPage({...shared,clearPersonSelection:noop,hidePersonProfile:noop,setMainHeader:noop,normalizeUiConfig:value=>value,galleryModeLabel:renderer.modeLabel,renderGalleryStats:renderer.renderStats,renderGalleryView:renderer.renderView,pushRoute:route,replaceRoute:route,syncRouteAfterNavigation:route});
state.gallery.list={key:page.imageLibraryListKey(),items:${JSON.stringify([listItem("A"), listItem("B")])},total:2,facets:{}};
window.fixture={state,page,renderer,ready:true};renderer.renderView();
</script>`;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runGalleryReaderFixture({ casePattern: process.argv.find(value => value.startsWith("--case="))?.slice(7) || "" });
