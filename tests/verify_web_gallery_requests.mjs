import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

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
  let browser = null, checks = 0, fullscreenDenied = false;
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
      if (url.pathname === "/api/image-library/items") { sendJson(res, { items: [listItem("A"), listItem("B")], count: 2, total: 2, facets: {} }); return; }
      if (url.pathname === "/api/modules") { sendJson(res, { product: { id: "suite" }, modules: [] }); return; }
      if (url.pathname === "/api/image-library/summary") { sendJson(res, { totals: { photoSets: 2, manga: 1 }, facets: {}, scannedAt: "synthetic", cache: null }); return; }
      if (url.pathname.startsWith("/synthetic/")) {
        sendText(res, '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><rect width="800" height="1000" fill="#729b7c"/></svg>', "image/svg+xml", "public, max-age=86400"); return;
      }
      if (overrides.has(url.pathname)) { sendText(res, overrides.get(url.pathname), url.pathname.endsWith('.css') ? "text/css" : "text/javascript"); return; }
      const target = /^\/(?:photo|manga|media|western)(?:\/|$)/.test(url.pathname) ? path.join(publicRoot, "index.html") : path.resolve(publicRoot, url.pathname.replace(/^\/+/, ""));
      assert(target.startsWith(`${publicRoot}${path.sep}`));
      sendText(res, await fs.promises.readFile(target), target.endsWith(".html") ? "text/html; charset=utf-8" : target.endsWith(".js") ? "text/javascript" : "text/css");
    } catch (error) { if (!res.destroyed) { res.writeHead(500); res.end(error.message); } }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const run = async (name, task) => { if (casePattern && !name.includes(casePattern)) return; await task(); checks++; console.log(`PASS ${name}`); };
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    await run('summary recovery: a cold failure exposes an actionable read-only retry', async () => {
      const failed = hold((url, method) => method === 'GET' && url.pathname === '/api/image-library/summary' && url.search === '', 'Synthetic cold summary unavailable');
      const beforeItems = countRequests(url => url.pathname === '/api/image-library/items'), methodStart = apiMethods.length;
      const page = await newPage({ real: true, route: '/photo', waitReady: false });
      try {
        await requested(failed); await settle(page, failed);
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
      const old = hold(url => url.pathname === "/api/photo-sets/A"), page = await newPage({ real: true, route: "/photo/set/A", waitReady: false });
      try {
        await requested(old); await page.locator(".gallery-controls").waitFor({ state: "attached" });
        // The initial loading stylesheet hides the body. Dispatch the actual
        // DOM handlers here without altering that stylesheet; the separate
        // post-boot case below exercises an ordinary visible pointer click.
        await page.evaluate(action => {
          if (action === "list") [...document.querySelectorAll(".gallery-submode-button")].find(button => button.textContent === "全部套图").click();
          else { const input = document.querySelector(".gallery-search"); input.value = "B"; input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); }
        }, action);
        await page.waitForFunction(() => !document.documentElement.classList.contains("app-module-loading"), null, { timeout: 1500 });
        assert.equal(new URL(page.url()).pathname, "/photo/albums"); assert.equal(new URL(page.url()).searchParams.get("q"), action === "search" ? "B" : null);
        assert(await page.evaluate(() => __transport.aborted.some(url => url.startsWith("/api/photo-sets/A"))));
        await settle(page, old); assert.equal(await page.locator(".gallery-reader-title").count(), 0); assert.equal(new URL(page.url()).pathname, "/photo/albums");
      } finally { await page.close(); }
    });
    await run("route visible local list click", async () => {
      const page = await newPage({ real: true });
      try {
        const old = hold(url => url.pathname === "/api/photo-sets/A"); await navigateRoute(page, "/photo/set/A"); await requested(old);
        await page.getByRole("button", { name: "全部套图", exact: true }).click();
        assert.equal(new URL(page.url()).pathname, "/photo/albums"); await settle(page, old);
        assert.equal(await page.locator(".gallery-reader-title").count(), 0); assert.equal(new URL(page.url()).pathname, "/photo/albums");
      } finally { await page.close(); }
    });
    for (const target of ["/photo/set/B", "/manga"]) await run(`route module import late startup ${target}`, async () => {
      const module = hold(url => url.pathname === "/modules/content-index/gallery-page.js");
      const firstTarget = hold(url => ["/api/photo-sets/A", "/api/photo-sets/B", "/api/manga"].includes(url.pathname));
      const before = countRequests(url => url.pathname === "/api/photo-sets/A"), page = await newPage({ real: true, route: "/photo/set/A", waitReady: false });
      try {
        await requested(module); await navigateRoute(page, target); module.release();
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
  function isSummary(url, method = 'GET') { return method === 'GET' && url.pathname === '/api/image-library/summary' && url.search === ''; }
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
  async function newPage({ real = false, ignoreAbort = true, observer = true, route = "/photo?photoView=albums", waitReady = true, initialBack = false } = {}) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.on("pageerror", error => faults.push(error.message));
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
async function dragPager(page, input, x1, y1, x2, y2) {
  const box = await page.locator('.gallery-image-pager-stage').boundingBox();
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
