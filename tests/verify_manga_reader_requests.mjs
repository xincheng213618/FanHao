import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Private loopback server, actual /manga index/host/module and Chromium.
// Synthetic APIs/SVGs only; simulated update/delete calls never reach an app.
// ignoreAbort proves ownership even when obsolete transport still completes.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(root, "public");

export async function runMangaReaderFixture({ legacyManga = false, legacyHost = false, legacyFit = false, sourceOverrides = {}, casePattern = "" } = {}) {
  const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"]
    .filter(Boolean).find(value => fs.existsSync(value));
  assert(executablePath, "Chrome or Edge required for the private manga browser fixture");
  const overrides = new Map(sourceOverrides instanceof Map ? sourceOverrides : Object.entries(sourceOverrides));
  for (const [enabled, relative] of [[legacyManga, "public/modules/photos/manga-page.js"], [legacyHost, "public/js/standalone-host.js"]]) {
    if (!enabled) continue;
    const result = spawnSync("git", ["show", `HEAD:${relative}`], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); overrides.set(`/${relative.slice(7)}`, result.stdout);
  }
  if (legacyFit) {
    const key = "/modules/photos/manga-page.js";
    const current = overrides.get(key) || fs.readFileSync(path.join(publicRoot, key.slice(1)), "utf8");
    const refresh = `      page.classList.toggle("fit-width", state.manga.fitWidth);
      page.classList.toggle("original-width", !state.manga.fitWidth);
      page.querySelector('[data-action="fit"]').textContent = state.manga.fitWidth ? "原始宽度" : "适应宽度";`;
    const normalized = current.replace(/\r\n/g, "\n");
    assert.equal(normalized.split(refresh).length, 2, "negative must restore only the actual previous fit-button render");
    overrides.set(key, normalized.replace(refresh, "      renderView();"));
  }
  const held = new Set(), requests = new Map(), faults = [], unexpected = [];
  let browser = null, checks = 0;
  let readerImageCount = 3;
  let readerImageDimensions = null;
  let readerImageIntrinsic = { width: 800, height: 1400 };
  let readerImageWait = null;
  const addBodies = [];
  let libraryComics = null;
  let addJobResponse = null;
  const comicSnapshots = new Map();
  const currentComic = id => comicSnapshots.get(id) || comic(id);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture"), key = `${url.pathname}${url.search}`;
    requests.set(key, (requests.get(key) || 0) + 1);
    try {
      const syntheticAdd = req.method === 'POST' && url.pathname === '/api/manga/add';
      const syntheticMutation = syntheticAdd || (req.method === "POST" && /^\/api\/manga\/[CD]\/update$/.test(url.pathname))
        || (req.method === "DELETE" && /^\/api\/manga\/[CD]$/.test(url.pathname));
      assert(req.method === "GET" || syntheticMutation, `unexpected fixture mutation: ${req.method} ${key}`);
      if (syntheticAdd) {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        assert(typeof body.url === 'string' && body.url.startsWith('https://example.invalid/'), 'comic add receipts must use synthetic links only');
        addBodies.push(body);
      }
      const gate = [...held].find(value => !value.used && value.match(url, req));
      if (gate) {
        gate.used = true; gate.url = key; res.once("close", () => { gate.closed = true; });
        gate.requestedResolve(); await gate.promise;
        if (gate.error) { sendJson(res, { error: gate.error }, 503); return; }
      }
      if (url.pathname === "/probe") { sendText(res, harness(), "text/html; charset=utf-8"); return; }
      if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      if (syntheticMutation) {
        if (syntheticAdd) { sendJson(res, { job: addJobResponse || { id: `synthetic-add-${addBodies.length}`, status: 'complete', comicId: 'D', message: 'Synthetic add complete' } }); return; }
        sendJson(res, req.method === "DELETE" ? { ok: true } : { job: { status: "complete", message: "Synthetic update complete" } }); return;
      }
      const chapterMatch = /^\/api\/manga\/([^/]+)\/chapters\/([^/]+)$/.exec(url.pathname);
      if (chapterMatch) { sendJson(res, { comic: currentComic(chapterMatch[1]), chapter: chapter(chapterMatch[1], Number(chapterMatch[2]), readerImageCount, readerImageDimensions) }); return; }
      const comicMatch = /^\/api\/manga\/([^/]+)$/.exec(url.pathname);
      if (comicMatch) { sendJson(res, { comic: currentComic(comicMatch[1]), update: { status: "idle" } }); return; }
      if (url.pathname === "/api/manga") { sendJson(res, { comics: libraryComics || [currentComic("C"), currentComic("D")] }); return; }
      if (addJobResponse && url.pathname === `/api/manga/jobs/${addJobResponse.id}`) { sendJson(res, { job: addJobResponse }); return; }
      if (url.pathname === "/api/modules") { sendJson(res, { product: { id: "suite" }, modules: [] }); return; }
      if (url.pathname.startsWith("/api/")) { unexpected.push(key); sendJson(res, { error: "unexpected synthetic API" }, 404); return; }
      if (url.pathname.startsWith("/synthetic/")) {
        if (/^\/synthetic\/[^/]+\/\d+\//.test(url.pathname)) await readerImageWait;
        const pageIndex = Number(/^\/synthetic\/[^/]+\/\d+\/(\d+)\.svg$/.exec(url.pathname)?.[1] || 1) - 1;
        const intrinsic = Array.isArray(readerImageIntrinsic) ? readerImageIntrinsic[pageIndex] || { width: 800, height: 1400 } : readerImageIntrinsic;
        sendText(res, `<svg xmlns="http://www.w3.org/2000/svg" width="${intrinsic.width}" height="${intrinsic.height}"><rect width="100%" height="100%" fill="#729b7c"/></svg>`, "image/svg+xml", "public, max-age=86400"); return;
      }
      if (overrides.has(url.pathname)) { sendText(res, overrides.get(url.pathname), url.pathname.endsWith(".css") ? "text/css" : "text/javascript"); return; }
      const target = /^\/manga(?:\/|$)/.test(url.pathname) ? path.join(publicRoot, "index.html") : path.resolve(publicRoot, url.pathname.replace(/^\/+/, ""));
      assert(target.startsWith(`${publicRoot}${path.sep}`), "static fixture paths must stay inside public");
      const type = target.endsWith(".html") ? "text/html; charset=utf-8" : target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : target.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";
      sendText(res, await fs.promises.readFile(target), type);
    } catch (error) { unexpected.push(`${key}: ${error.message}`); if (!res.destroyed) sendJson(res, { error: error.message }, 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const run = async (name, task) => { if (casePattern && !name.includes(casePattern)) return; await task(); checks++; console.log(`PASS ${name}`); };
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    await run('library covers: first viewport decodes visible covers while deferring the distant shelf', async () => {
      libraryComics = libraryCoverShelf('Cover');
      const isCover = url => /^\/synthetic\/Cover\d{4}\/cover\.svg$/.test(url.pathname);
      const before = countRequests(isCover), distantBefore = [500, 1000].map(index => countRequests(url => url.pathname === `/synthetic/Cover${String(index).padStart(4, '0')}/cover.svg`));
      const page = await newPage({ real: true, route: '/manga' });
      try {
        await page.waitForFunction(() => document.querySelectorAll('.manga-card img').length === 1000);
        await page.waitForFunction(() => {
          const visible = [...document.querySelectorAll('.manga-card img')].filter(image => { const rect = image.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth; });
          return visible.length > 0 && visible.every(image => image.complete && image.naturalWidth > 0);
        }, null, { timeout: 5000 });
        const visible = await page.evaluate(async () => {
          const all = [...document.querySelectorAll('.manga-card img')], images = all.filter(image => { const rect = image.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth; });
          // Decode only the actual viewport. Decoding the full model would force
          // native lazy images to load and invalidate the request measurement.
          const natural = images.filter(image => image.complete && image.naturalWidth > 0).length;
          await Promise.all(images.map(image => image.decode()));
          return { viewport: [innerWidth, innerHeight], scroll: scrollY, visible: images.length,
            natural, decoded: images.filter(image => image.complete && image.naturalWidth > 0).length,
            ids: images.map(image => image.closest('.manga-card').dataset.comicId), loading: [...new Set(all.map(image => image.loading))] };
        }); await tick(page);
        const actual = { ...visible, requests: countRequests(isCover) - before,
          distantRequests: [500, 1000].map((index, offset) => countRequests(url => url.pathname === `/synthetic/Cover${String(index).padStart(4, '0')}/cover.svg`) - distantBefore[offset]) };
        console.log('MANGA_LIBRARY_COVER_FIRST_VIEW', JSON.stringify(actual));
        assert.equal(visible.natural, visible.visible, 'initial viewport covers must complete naturally before explicit decode verification');
        assert(visible.visible > 0 && visible.decoded === visible.visible, 'visible manga shelf covers must actually decode in the initial viewport');
        assert(actual.requests <= 100, 'the initial manga shelf must stay within its viewport cover request budget');
        assert.deepEqual(actual.distantRequests, [0, 0], 'distant shelf covers must remain unrequested before scrolling or keyboard navigation');
      } finally { await page.close(); libraryComics = null; }
    });
    await run('library covers: scrolling and native keyboard exposure load real distant images', async () => {
      libraryComics = libraryCoverShelf('CoverVisit');
      const at = index => `/synthetic/CoverVisit${String(index).padStart(4, '0')}/cover.svg`;
      const before = [500, 1000].map(index => countRequests(url => url.pathname === at(index)));
      const page = await newPage({ real: true, route: '/manga' });
      try {
        await page.waitForFunction(() => document.querySelectorAll('.manga-card img').length === 1000); await tick(page);
        assert.deepEqual([500, 1000].map((index, offset) => countRequests(url => url.pathname === at(index)) - before[offset]), [0, 0]);
        await page.evaluate(() => { window.__coverVisitImages = [...document.querySelectorAll('.manga-card img')]; });
        const middle = page.locator('.manga-card[data-comic-id="CoverVisit0500"] button'); await middle.scrollIntoViewIfNeeded();
        await until(() => countRequests(url => url.pathname === at(500)) > before[0], 'scrolling to a distant card must naturally request its deferred cover');
        await assertLibraryCoverDecoded(page, 'CoverVisit0500');
        assert.equal(countRequests(url => url.pathname === at(1000)) - before[1], 0, 'visiting the middle of the library must not request its remote end');
        await middle.focus(); await middle.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement?.closest('.manga-card')?.dataset.comicId), 'CoverVisit0501');
        await assertLibraryCoverDecoded(page, 'CoverVisit0501');
        const penultimate = page.locator('.manga-card[data-comic-id="CoverVisit0999"] button'); await penultimate.scrollIntoViewIfNeeded(); await penultimate.focus(); await penultimate.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement?.closest('.manga-card')?.dataset.comicId), 'CoverVisit1000', 'native Tab must expose the actual final comic card');
        await until(() => countRequests(url => url.pathname === at(1000)) > before[1], 'native exposure at the library end must request the deferred final cover');
        await assertLibraryCoverDecoded(page, 'CoverVisit1000');
        assert.equal(await page.evaluate(() => __coverVisitImages.every((image, index) => image.isConnected && image === document.querySelectorAll('.manga-card img')[index])), true,
          'native image loading must preserve the complete original shelf and cover nodes');
      } finally { await page.close(); libraryComics = null; }
    });
    await run('library covers: same-url metadata reuses images and replacement leaves remain deferred', async () => {
      libraryComics = libraryCoverShelf('CoverMeta');
      const originalPath = '/synthetic/CoverMeta0500/cover.svg', replacementPath = '/synthetic/CoverMeta0500/revised-cover.svg';
      const initialReads = countRequests(url => url.pathname === originalPath), replacementReads = countRequests(url => url.pathname === replacementPath);
      const page = await newPage({ real: true, route: '/manga' }); let poll;
      try {
        await page.waitForFunction(() => document.querySelectorAll('.manga-card img').length === 1000);
        ({ poll } = await startLibraryCardPolling(page, 'cover-metadata'));
        await page.evaluate(() => { const card = document.querySelector('.manga-card[data-comic-id="CoverMeta0500"]'); window.__farCoverOriginal = card.querySelector('img'); window.__farCoverButton = card.querySelector('button'); });
        libraryComics[499] = { ...libraryComics[499], author: 'Updated synthetic cover author' };
        await publishLibraryCardPoll(page, poll, 'same cover metadata published');
        assert.equal(await page.evaluate(() => document.querySelector('.manga-card[data-comic-id="CoverMeta0500"] img') === __farCoverOriginal && __farCoverOriginal.loading === 'lazy'), true,
          'same-url metadata must preserve an unrequested lazy cover node');
        assert.equal(countRequests(url => url.pathname === originalPath) - initialReads, 0);
        poll = hold(url => url.pathname === `/api/manga/jobs/${addJobResponse.id}`);
        libraryComics[499] = { ...libraryComics[499], coverUrl: replacementPath };
        await publishLibraryCardPoll(page, poll, 'replacement cover metadata published');
        const replacement = page.locator('.manga-card[data-comic-id="CoverMeta0500"] img');
        const actual = await replacement.evaluate(image => ({ loading: image.loading, decoding: image.decoding, src: image.getAttribute('src'), originalConnected: __farCoverOriginal.isConnected,
          sameButton: image.closest('button') === __farCoverButton }));
        const requests = countRequests(url => url.pathname === replacementPath) - replacementReads;
        console.log('MANGA_LIBRARY_REPLACEMENT_COVER', JSON.stringify({ ...actual, requests }));
        assert(actual.loading === 'lazy' && actual.decoding === 'async' && requests === 0, 'a replacement distant shelf cover must be deferred at creation without an eager request');
        assert.equal(actual.src, replacementPath); assert.equal(actual.originalConnected, false); assert.equal(actual.sameButton, true);
        await page.locator('.manga-card[data-comic-id="CoverMeta0500"] button').scrollIntoViewIfNeeded();
        await until(() => countRequests(url => url.pathname === replacementPath) > replacementReads, 'an exposed replacement cover must naturally start its image request');
        await assertLibraryCoverDecoded(page, 'CoverMeta0500');
      } finally { poll?.release(); await page.close(); libraryComics = null; addJobResponse = null; }
    });
    await run('library covers: detail heroes remain eager and chapter images keep their own policy', async () => {
      const before = countRequests(url => url.pathname === '/synthetic/C/cover.svg');
      const page = await newPage({ real: true, route: '/manga/C' });
      try {
        await detailTitle(page, 'Comic C'); const hero = page.locator('.manga-detail-cover img');
        assert.notEqual(await hero.evaluate(image => image.loading), 'lazy', 'the first-read detail hero must retain its non-lazy loading policy');
        await page.waitForFunction(() => { const image = document.querySelector('.manga-detail-cover img'); return image?.complete && image.naturalWidth > 0; });
        await hero.evaluate(image => image.decode());
        assert.equal(countRequests(url => url.pathname === '/synthetic/C/cover.svg') - before, 1);
        await page.locator('.manga-chapter-row[data-chapter-index="1"] button').click(); await readerTitle(page, 'Comic C', 'Chapter 1'); await fitImagesReady(page);
        assert.deepEqual(await page.locator('.manga-reader-pages img').evaluateAll(images => images.map(image => image.loading)), ['eager', 'eager', 'lazy'],
          'shelf cover hints must not change the reader image loading policy');
      } finally { await page.close(); }
    });
    await run('library cards: unchanged running add polling preserves the focused thousand-card shelf', async () => {
      libraryComics = Array.from({ length: 1000 }, (_, index) => ({ ...comic(`Shelf${String(index + 1).padStart(4, '0')}`), title: `Synthetic shelf ${String(index + 1).padStart(4, '0')}` }));
      addJobResponse = { id: 'synthetic-library-card-poll', status: 'running', message: 'Synthetic add polling started', progressPercent: 10 };
      const poll = hold(url => url.pathname === '/api/manga/jobs/synthetic-library-card-poll');
      const page = await newPage({ real: true, route: '/manga' });
      try {
        await page.waitForFunction(() => document.querySelectorAll('.manga-card').length === 1000);
        await page.locator('.manga-library-controls [data-action="add"]').click();
        await page.locator('.manga-add-panel input').fill('https://example.invalid/synthetic-polling');
        const startedAt = Date.now(); await page.locator('.manga-add-panel button[type="submit"]').click();
        await page.waitForFunction(() => document.querySelector('.manga-job-progress strong')?.textContent === 'Synthetic add polling started');
        const button = page.locator('.manga-card').nth(499).locator('.manga-card-open'); await button.scrollIntoViewIfNeeded(); await button.focus();
        await requested(poll);
        const elapsedToPoll = Date.now() - startedAt;
        await page.evaluate(() => {
          const focused = document.activeElement, cards = [...document.querySelectorAll('.manga-card')], covers = cards.map(card => card.querySelector('img'));
          window.__shelfPoll = { focused, cards, covers, ancestors: [], blur: 0, addedCards: new Set(), removedCards: new Set(), scroll: scrollY };
          for (let node = focused; node; node = node.parentElement) __shelfPoll.ancestors.push(node);
          focused.addEventListener('blur', () => __shelfPoll.blur++);
          window.__shelfObserver = new MutationObserver(records => { for (const record of records) for (const [nodes, set] of [[record.addedNodes, __shelfPoll.addedCards], [record.removedNodes, __shelfPoll.removedCards]]) {
            for (const node of nodes) { if (node.classList?.contains('manga-card')) set.add(node); for (const card of node.querySelectorAll?.('.manga-card') || []) set.add(card); }
          } });
          __shelfObserver.observe(document.querySelector('#workGrid'), { childList: true, subtree: true });
          __fitCreated.total = __fitCreated.images = 0;
        });
        const libraryReads = countRequests(url => url.pathname === '/api/manga');
        addJobResponse = { ...addJobResponse, message: 'Synthetic add polling advanced', progressPercent: 20 };
        await settle(page, poll);
        await page.waitForFunction(() => document.querySelector('.manga-job-progress strong')?.textContent === 'Synthetic add polling advanced');
        const actual = await page.evaluate(() => {
          __shelfObserver.disconnect();
          return { cards: document.querySelectorAll('.manga-card').length, retained: __shelfPoll.cards.filter(card => card.isConnected).length,
            retainedCovers: __shelfPoll.covers.filter(image => image?.isConnected).length, ancestorsConnected: __shelfPoll.ancestors.every(node => node.isConnected),
            focused: document.activeElement === __shelfPoll.focused, active: document.activeElement?.tagName, blur: __shelfPoll.blur,
            createdElements: __fitCreated.total, addedCards: __shelfPoll.addedCards.size, removedCards: __shelfPoll.removedCards.size,
            scrollBefore: __shelfPoll.scroll, scrollAfter: scrollY };
        });
        console.log('MANGA_LIBRARY_CARD_POLL', JSON.stringify({ elapsedToPoll, additionalLibraryReads: countRequests(url => url.pathname === '/api/manga') - libraryReads, ...actual }));
        assert.equal(actual.retained, 1000, 'an unchanged library poll must retain every existing comic card');
        assert(actual.ancestorsConnected && actual.focused && actual.blur === 0, 'background add polling must retain the focused cover button and its complete ancestry');
        assert.equal(actual.addedCards, 0, 'an unchanged library poll must not construct new comic cards');
        assert.equal(actual.retainedCovers, 1000); assert.equal(actual.scrollAfter, actual.scrollBefore);
        assert(actual.createdElements < 60, 'an unchanged thousand-card poll must do bounded construction outside the retained cards');
      } finally { poll.release(); await page.close(); libraryComics = null; addJobResponse = null; }
    });
    await run('library cards: fresh metadata patches visible fields and preserves same-url cover fallbacks', async () => {
      libraryComics = ['C', 'D', 'E'].map(comic);
      const failedCover = hold(url => url.pathname === '/synthetic/C/cover.svg', 'Synthetic shelf cover unavailable');
      const page = await newPage({ real: true, route: '/manga', waitReady: false }); let poll;
      try {
        await requested(failedCover); failedCover.release(); await ready(page);
        await page.locator('.manga-card[data-comic-id="C"] .manga-cover-placeholder').waitFor();
        ({ poll } = await startLibraryCardPolling(page, 'metadata'));
        const card = page.locator('.manga-card[data-comic-id="C"]'); await card.locator('button').focus();
        assert.equal(await card.locator('.manga-cover-placeholder').count(), 1, 'same-url library updates must keep the existing failed-cover fallback without implicit retries');
        await page.evaluate(() => {
          const card = document.querySelector('.manga-card[data-comic-id="C"]'); window.__shelfMetadata = { card, button: card.querySelector('button'),
            placeholder: card.querySelector('.manga-cover-placeholder'), otherCover: document.querySelector('.manga-card[data-comic-id="D"] img'), ancestors: [] };
          for (let node = __shelfMetadata.button; node; node = node.parentElement) __shelfMetadata.ancestors.push(node);
        });
        const coverReads = countRequests(url => url.pathname === '/synthetic/C/cover.svg');
        libraryComics[0] = { ...libraryComics[0], title: 'Comic C revised', author: 'New synthetic author', site: 'new-site', chapterCount: 42, imageCount: 126 };
        comicSnapshots.set('C', libraryComics[0]);
        await publishLibraryCardPoll(page, poll, 'metadata fields published');
        assert.deepEqual(await card.evaluate(card => ({ title: card.querySelector('.manga-card-body strong').textContent, author: card.querySelector('.manga-card-body > span').textContent,
          counts: card.querySelector('.manga-card-body small').textContent, site: card.querySelector('.manga-card-site').textContent, label: card.querySelector('button').getAttribute('aria-label') })),
          { title: 'Comic C revised', author: 'New synthetic author', counts: '42 话 · 126 张', site: 'NEW-SITE', label: '查看《Comic C revised》详情' },
          'accepted library metadata must update every visible comic-card field and its accessible name');
        assert.equal(await card.evaluate(card => card === __shelfMetadata.card && card.querySelector('button') === __shelfMetadata.button && card.querySelector('.manga-cover-placeholder') === __shelfMetadata.placeholder
          && __shelfMetadata.placeholder.querySelector('small').textContent === 'Comic C revised' && __shelfMetadata.ancestors.every(node => node.isConnected) && document.activeElement === __shelfMetadata.button), true,
          'same-url metadata must preserve the existing failed-cover fallback, focused button and complete card ancestry');
        assert.equal(countRequests(url => url.pathname === '/synthetic/C/cover.svg'), coverReads, 'same-url metadata must not retry a failed cover implicitly');
        poll = hold(url => url.pathname === `/api/manga/jobs/${addJobResponse.id}`);
        libraryComics[0] = { ...libraryComics[0], coverUrl: '/synthetic/C/revised-cover.svg' }; comicSnapshots.set('C', libraryComics[0]);
        await publishLibraryCardPoll(page, poll, 'metadata cover published');
        await card.locator('img').waitFor();
        assert.equal(await card.locator('img').getAttribute('src'), '/synthetic/C/revised-cover.svg');
        assert.equal(await card.locator('img').getAttribute('alt'), '《Comic C revised》封面');
        assert.equal(await card.evaluate(card => card === __shelfMetadata.card && card.querySelector('button') === __shelfMetadata.button && document.activeElement === __shelfMetadata.button
          && __shelfMetadata.otherCover.isConnected && !__shelfMetadata.placeholder.isConnected), true, 'a changed cover URL must replace only that cover leaf while retaining the focused comic and other covers');
        await card.locator('img').evaluate(image => { window.__shelfChangedCover = image; });
        poll = hold(url => url.pathname === `/api/manga/jobs/${addJobResponse.id}`);
        libraryComics[0] = { ...libraryComics[0], coverUrl: '' }; comicSnapshots.set('C', libraryComics[0]);
        await publishLibraryCardPoll(page, poll, 'metadata empty cover published');
        assert.equal(await card.locator('img').count(), 0);
        assert.equal(await card.evaluate(card => card === __shelfMetadata.card && card.querySelector('button') === __shelfMetadata.button && document.activeElement === __shelfMetadata.button
          && !__shelfChangedCover.isConnected && card.querySelector('.manga-cover-placeholder small')?.textContent === 'Comic C revised' && __shelfMetadata.otherCover.isConnected), true,
          'removing a cover URL must replace only its image with a current-title placeholder');
        await card.locator('button').press('Enter'); await detailTitle(page, 'Comic C revised');
      } finally { failedCover.release(); poll?.release(); await page.close(); libraryComics = null; addJobResponse = null; comicSnapshots.delete('C'); }
    });
    await run('library cards: background reordering and membership keep surviving card identities', async () => {
      libraryComics = [{ ...comic('C'), title: 'Bravo', chapterCount: 5 }, { ...comic('D'), title: 'Charlie', chapterCount: 10 }, { ...comic('E'), title: 'Delta', chapterCount: 1 }];
      const page = await newPage({ real: true, route: '/manga' }); let poll;
      try {
        await page.locator('.manga-library-controls select').selectOption('title');
        ({ poll } = await startLibraryCardPolling(page, 'membership'));
        await page.locator('.manga-card[data-comic-id="D"] button').focus();
        await page.evaluate(() => { window.__shelfOrderCards = new Map([...document.querySelectorAll('.manga-card')].map(card => [card.dataset.comicId, card]));
          window.__shelfOrderButton = document.activeElement; window.__shelfOrderBlur = 0; __shelfOrderButton.addEventListener('blur', () => __shelfOrderBlur++); });
        libraryComics = [{ ...libraryComics[0], title: 'Zulu' }, { ...libraryComics[1], title: 'Alpha' }, { ...comic('F'), title: 'Middle', chapterCount: 1 }];
        comicSnapshots.set('F', libraryComics[2]);
        await publishLibraryCardPoll(page, poll, 'membership published');
        assert.deepEqual(await page.locator('.manga-card').evaluateAll(cards => cards.map(card => card.dataset.comicId)), ['D', 'F', 'C'], 'background membership and title updates must publish the actual accepted sorted shelf');
        assert.deepEqual(await page.evaluate(() => ({ c: document.querySelector('.manga-card[data-comic-id="C"]') === __shelfOrderCards.get('C'), d: document.querySelector('.manga-card[data-comic-id="D"]') === __shelfOrderCards.get('D'),
          e: __shelfOrderCards.get('E').isConnected, focused: document.activeElement === __shelfOrderButton, blur: __shelfOrderBlur })),
          { c: true, d: true, e: false, focused: true, blur: 0 }, 'a background reorder must preserve surviving cards and keep the focused card connected without blur');
        const reads = countRequests(url => url.pathname.startsWith('/api/'));
        await page.locator('.manga-library-controls select').selectOption('chapters');
        assert.deepEqual(await page.locator('.manga-card').evaluateAll(cards => cards.map(card => card.dataset.comicId)), ['D', 'C', 'F']);
        const search = page.locator('.manga-library-controls input'); await search.fill('Zulu'); await search.press('Enter');
        assert.deepEqual(await page.locator('.manga-card').evaluateAll(cards => cards.map(card => card.dataset.comicId)), ['C']);
        assert.equal(await page.evaluate(() => document.querySelector('.manga-card') === __shelfOrderCards.get('C')), true);
        const before = page.url(); await page.evaluate(() => __shelfOrderCards.get('D').querySelector('button').click()); await tick(page);
        assert.equal(page.url(), before, 'a card filtered out of the current shelf must not reopen itself');
        assert.equal(countRequests(url => url.pathname.startsWith('/api/')), reads, 'local shelf sort and filtering must not request metadata or accept filtered-out card actions');
        await search.fill('No matching synthetic shelf'); await search.press('Enter'); assert.equal(await page.locator('.manga-card').count(), 0);
        await search.fill(''); await search.press('Enter');
        assert.deepEqual(await page.locator('.manga-card').evaluateAll(cards => cards.map(card => card.dataset.comicId)), ['D', 'C', 'F']);
        const added = page.locator('.manga-card[data-comic-id="F"] button'); await added.focus(); await added.press('Enter'); await detailTitle(page, 'Middle');
        assert.equal(new URL(page.url()).pathname, '/manga/F', 'cards created after an empty shelf must bind to the live library owner and open their actual comic');
      } finally { poll?.release(); await page.close(); libraryComics = null; addJobResponse = null; comicSnapshots.delete('F'); }
    });
    await run('library cards: retired cards cannot reopen a removed comic or replace a new route', async () => {
      for (const target of ['removed member', 'new detail', 'replacement shelf']) {
        libraryComics = ['C', 'D', 'E'].map(comic);
        const page = await newPage({ real: true, route: '/manga' }); let poll;
        try {
          await page.locator('.manga-card[data-comic-id="C"]').waitFor();
          if (target === 'removed member') ({ poll } = await startLibraryCardPolling(page, 'retired'));
          await page.evaluate(() => { window.__retiredShelfCard = document.querySelector('.manga-card[data-comic-id="C"]'); });
          if (target === 'removed member') {
            libraryComics = libraryComics.filter(item => item.id !== 'C'); await publishLibraryCardPoll(page, poll, 'removed member published');
            assert.equal(await page.locator('.manga-card[data-comic-id="C"]').count(), 0);
          } else {
            await navigateRoute(page, '/manga/D'); await detailTitle(page, 'Comic D');
            if (target === 'replacement shelf') { await navigateRoute(page, '/manga'); await page.locator('.manga-library-controls').waitFor(); }
          }
          await tick(page); const before = await directorySearchSurface(page), reads = countRequests(url => url.pathname.startsWith('/api/'));
          await page.evaluate(() => __retiredShelfCard.querySelector('button').click()); await tick(page);
          assert.deepEqual(await directorySearchSurface(page), before, 'retired shelf cards must not replace a newer detail, generation or current library membership');
          assert.equal(countRequests(url => url.pathname.startsWith('/api/')), reads);
        } finally { poll?.release(); await page.close(); libraryComics = null; addJobResponse = null; }
      }
    });
    for (const ignoreAbort of [false, true]) {
      const transport = ignoreAbort ? 'ignore-abort' : 'normal';
      await run(`library cards: opening a thousand-card shelf preserves drafts through failure and retry ${transport}`, async () => {
        libraryComics = openingLibraryShelf();
        const match = url => url.pathname === '/api/manga/C';
        const failed = hold(match, 'Synthetic comic metadata unavailable'), gates = [failed];
        const page = await newPage({ real: true, ignoreAbort, route: '/manga' });
        try {
          await page.waitForFunction(() => document.querySelectorAll('.manga-card').length === 1000);
          await prepareLibraryOpeningDrafts(page);
          const target = page.locator('.manga-card[data-comic-id="C"] .manga-card-open');
          await target.scrollIntoViewIfNeeded(); await target.focus(); await tick(page);
          await snapshotLibraryOpening(page, target);
          const reads = countRequests(match), libraryReads = countRequests(url => url.pathname === '/api/manga');
          await target.press('Enter'); await requested(failed); await tick(page);
          const pending = await assertLibraryOpeningSurface(page, { focus: true, scroll: true });
          assert.equal(await target.evaluate(button => !button.disabled && button.getAttribute('aria-busy') === 'true'
            && button.getAttribute('aria-disabled') === 'true'), true, 'a pending shelf open must keep its native trigger focusable while exposing its busy state');
          await assertLibraryOpeningFeedback(page, { pending: true, title: 'Comic C' });
          await page.keyboard.press('Space'); await page.keyboard.press('Enter'); await tick(page);
          assert.equal(countRequests(match), reads + 1, 'repeated native activation of the same pending shelf target must use one metadata GET');
          await settle(page, failed);
          const failure = await assertLibraryOpeningSurface(page, { focus: true, scroll: true });
          await assertLibraryOpeningFeedback(page, { title: 'Comic C', cause: failed.error });
          assert.equal(await target.evaluate(button => !button.disabled && !button.hasAttribute('aria-busy')), true);
          const beforeClose = countRequests(url => url.pathname.startsWith('/api/'));
          await page.locator('.manga-add-panel [data-action="close"]').click();
          assert.equal(await page.locator('.manga-add-panel').count(), 0, 'the retained add panel must remain truly operable after a shelf-open owner handoff');
          assert.equal(countRequests(url => url.pathname.startsWith('/api/')), beforeClose, 'closing an unsubmitted retained add draft must not submit or reload the library');
          await assertLibraryOpeningFeedback(page, { title: 'Comic C', cause: failed.error });
          const retry = page.locator('.manga-library-open-retry'); await assertChapterControlHit(retry);
          const succeeded = hold(match); gates.push(succeeded);
          await retry.focus(); await snapshotLibraryOpening(page, retry); await retry.press('Enter'); await requested(succeeded);
          await assertLibraryOpeningSurface(page, { focus: true, scroll: true });
          await assertLibraryOpeningFeedback(page, { pending: true, title: 'Comic C' });
          await page.keyboard.press('Space'); await page.keyboard.press('Enter'); await tick(page);
          assert.equal(countRequests(match), reads + 2, 'a native shelf retry must stay single flight under repeated keyboard activation');
          await settle(page, succeeded); await detailTitle(page, 'Comic C');
          assert.equal(new URL(page.url()).pathname, '/manga/C');
          assert.equal(await page.locator('.manga-library-open-feedback').count(), 0, 'successful metadata must retire the old shelf feedback instead of attaching it to the detail');
          assert.equal(countRequests(url => url.pathname === '/api/manga'), libraryReads, 'opening and retrying metadata must not re-fetch the accepted source library');
          console.log('MANGA_LIBRARY_OPENING_RETAINED', JSON.stringify({ transport, pending, failure, metadataReads: countRequests(match) - reads }));
        } finally { for (const gate of gates) { gate.release(); held.delete(gate); } await page.close(); libraryComics = null; }
      });
      await run(`library cards: opening ownership permits a new target and retires superseded feedback ${transport}`, async () => {
        libraryComics = ['C', 'D', 'E'].map(comic);
        const page = await newPage({ real: true, ignoreAbort, route: '/manga' });
        const gates = [];
        const returnToShelf = async () => {
          await page.goBack(); await page.locator('.manga-library-controls').waitFor();
          await page.waitForFunction(() => !document.querySelector('.manga-status')); await tick(page);
        };
        try {
          await page.locator('.manga-card[data-comic-id="C"]').waitFor();
          for (const outcome of ['failure', 'success']) {
            const old = hold(url => url.pathname === '/api/manga/C', outcome === 'failure' ? 'Obsolete C metadata failed' : '');
            const current = hold(url => url.pathname === '/api/manga/D'); gates.push(old, current);
            const c = page.locator('.manga-card[data-comic-id="C"] .manga-card-open');
            const d = page.locator('.manga-card[data-comic-id="D"] .manga-card-open');
            await c.evaluate(button => { window.__retiredShelfOpeningCard = button; });
            await c.press('Enter'); await requested(old);
            await d.focus(); await snapshotLibraryOpening(page, d); await d.press('Enter'); await requested(current);
            await assertLibraryOpeningSurface(page, { focus: true, scroll: true });
            await assertLibraryOpeningFeedback(page, { pending: true, title: 'Comic D' });
            await finishOld(page, old, ignoreAbort);
            await assertLibraryOpeningSurface(page, { focus: true, scroll: true });
            assert.equal(await d.getAttribute('aria-busy'), 'true', 'an obsolete metadata catch or finally must not release the new target busy state');
            await assertLibraryOpeningFeedback(page, { pending: true, title: 'Comic D' });
            await settle(page, current); await detailTitle(page, 'Comic D'); await tick(page);
            const before = await directorySearchSurface(page), reads = countRequests(url => url.pathname.startsWith('/api/'));
            await page.evaluate(() => __retiredShelfOpeningCard.click()); await tick(page);
            assert.deepEqual(await directorySearchSurface(page), before, 'an old source card must not replace the new comic detail after its own metadata was superseded');
            assert.equal(countRequests(url => url.pathname.startsWith('/api/')), reads);
            await returnToShelf();
          }
          for (const destination of ['query', 'sort', 'route']) {
            const failed = hold(url => url.pathname === '/api/manga/C', 'Current C metadata failed'); gates.push(failed);
            const c = page.locator('.manga-card[data-comic-id="C"] .manga-card-open');
            await c.evaluate(button => { window.__retiredShelfOpeningCard = button; });
            await c.press('Enter'); await requested(failed); await settle(page, failed);
            await assertLibraryOpeningFeedback(page, { title: 'Comic C', cause: failed.error });
            const retry = page.locator('.manga-library-open-retry');
            await retry.evaluate(button => { window.__retiredShelfOpeningRetry = button; });
            const old = hold(url => url.pathname === '/api/manga/C'); gates.push(old);
            await retry.press('Enter'); await requested(old);
            if (destination === 'query') {
              const input = page.locator('.manga-library-controls input'); await input.fill('Comic D'); await input.press('Enter');
              assert.equal(await page.locator('.manga-card').count(), 1);
              assert.equal(await page.locator('.manga-card[data-comic-id="C"]').count(), 0);
            } else if (destination === 'sort') {
              await page.locator('.manga-library-controls select').selectOption('title');
              assert.equal(await c.evaluate(button => button === __retiredShelfOpeningCard && button.isConnected), true,
                'a same-ID card retained after local sorting remains a current usable control');
            } else { await navigateRoute(page, '/manga/D'); await detailTitle(page, 'Comic D'); }
            await tick(page);
            assert.equal(await page.locator('.manga-library-open-feedback').count(), 0, 'explicit query, sort or route changes must retire the previous open and failure feedback');
            const before = await directorySearchSurface(page), reads = countRequests(url => url.pathname.startsWith('/api/'));
            await finishOld(page, old, ignoreAbort);
            await page.evaluate(onlyRetry => {
              __retiredShelfOpeningRetry.click();
              if (!onlyRetry) __retiredShelfOpeningCard.click();
            }, destination === 'sort'); await tick(page);
            assert.deepEqual(await directorySearchSurface(page), before, 'retired metadata responses, retry and removed cards must not alter the new query, sort or route');
            assert.equal(countRequests(url => url.pathname.startsWith('/api/')), reads, 'retired shelf feedback must not launch a metadata request into a newer context');
            if (destination === 'sort') {
              const next = hold(url => url.pathname === '/api/manga/C'); gates.push(next);
              await c.press('Enter'); await requested(next); await settle(page, next); await detailTitle(page, 'Comic C');
              await returnToShelf();
            } else if (destination === 'query') {
              const d = page.locator('.manga-card[data-comic-id="D"] .manga-card-open');
              await d.press('Enter'); await detailTitle(page, 'Comic D'); await returnToShelf();
              const input = page.locator('.manga-library-controls input'); await input.fill(''); await input.press('Enter');
              assert.equal(await page.locator('.manga-card').count(), 3);
            }
          }
        } finally { for (const gate of gates) { gate.release(); held.delete(gate); } await page.close(); libraryComics = null; }
      });
    }
    await run('directory search: a thousand chapters filter locally by normalized title and identity', async () => {
      comicSnapshots.set('C', searchableCatalogComic('C'));
      const page = await newPage({ real: true, route: '/manga/C' });
      try {
        await detailTitle(page, 'Comic C'); await tick(page);
        const input = page.locator('.manga-directory-search-input');
        assert.equal(await input.count(), 1, 'a long manga directory must provide its own local chapter search');
        const reads = countRequests(url => url.pathname.startsWith('/api/'));
        const progressBefore = await progress(page, 'C');
        for (const [query, indices] of [['ALPHA', [127, 128]], ['fullwidth hero', [77]], ['１２７', [127]], ['５００５', [5005]], ['星辰', [5005]], ['No such synthetic chapter', []]]) {
          await input.fill(query); await tick(page);
          assert.deepEqual(await visibleDirectoryIndices(page), indices, 'directory search must match normalized titles and the real chapter index');
          assert.deepEqual(await directorySearchNumbers(page), [indices.length, 1000]);
        }
        assert.equal(await page.locator('.manga-directory-search-empty').isVisible(), true);
        await page.locator('.manga-directory-search-clear').click(); await tick(page);
        assert.equal(await input.inputValue(), ''); assert.equal((await visibleDirectoryIndices(page)).length, 1000);
        assert.deepEqual(await directorySearchNumbers(page), [1000, 1000]);
        assert.equal(await page.locator('.manga-directory-search-empty').isVisible(), false);
        await input.fill('Chapter 7'); const broader = await visibleDirectoryIndices(page);
        await page.evaluate(() => {
          window.__directoryRefineRows = [...document.querySelectorAll('.manga-chapter-row')]; window.__directoryMutations = []; window.__directoryNormalizeCalls = 0;
          window.__directoryMutationObserver = new MutationObserver(records => __directoryMutations.push(...records));
          __directoryMutationObserver.observe(document.querySelector('.manga-chapter-list'), { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });
          window.__directoryOriginalNormalize = String.prototype.normalize;
          String.prototype.normalize = function(...args) { __directoryNormalizeCalls++; return __directoryOriginalNormalize.apply(this, args); };
          __fitCreated.total = __fitCreated.images = 0;
        });
        await input.fill('Chapter 77'); await tick(page); const narrower = await visibleDirectoryIndices(page);
        const refinement = await page.evaluate(() => {
          __directoryMutationObserver.disconnect(); String.prototype.normalize = __directoryOriginalNormalize;
          return { sameRows: __directoryRefineRows.every((row, index) => row.isConnected && row === document.querySelectorAll('.manga-chapter-row')[index]),
            created: __fitCreated.total, normalizeCalls: __directoryNormalizeCalls,
            hiddenWrites: __directoryMutations.filter(record => record.type === 'attributes').length,
            childWrites: __directoryMutations.filter(record => record.type === 'childList').length };
        });
        const expectedWrites = broader.filter(index => !narrower.includes(index)).length;
        console.log(JSON.stringify({ mode: 'manga-directory-search-refinement', from: broader.length, to: narrower.length, expectedWrites, ...refinement }));
        assert(refinement.sameRows && refinement.created === 0 && refinement.childWrites === 0, 'refining a chapter query must preserve every directory row without creating or replacing elements');
        assert.equal(refinement.hiddenWrites, expectedWrites, 'refining a chapter query must change hidden only on rows whose visibility actually changes');
        assert(refinement.normalizeCalls <= 2, 'refining the local directory must not renormalize every chapter title');
        await input.fill('');
        assert.equal(await page.locator('.manga-chapter-row').count(), 1000, 'filtering must keep the complete local directory model available');
        assert.equal(await progress(page, 'C'), progressBefore, 'finding a chapter must not change reading progress');
        assert.equal(countRequests(url => url.pathname.startsWith('/api/')), reads, 'directory filtering and clearing must issue zero additional API requests');
      } finally { comicSnapshots.delete('C'); await page.close(); }
    });
    await run('directory search: native keyboard opens the available match on a narrow screen', async () => {
      comicSnapshots.set('C', searchableCatalogComic('C'));
      const page = await newPage({ real: true, route: '/manga/C' });
      try {
        await detailTitle(page, 'Comic C'); await page.setViewportSize({ width: 320, height: 740 });
        const input = page.locator('.manga-directory-search-input'); await input.fill('alpha');
        const reads = countRequests(url => url.pathname.startsWith('/api/'));
        await input.press('Tab'); assert.equal(await page.locator('.manga-directory-search-clear').evaluate(node => node === document.activeElement), true);
        assert.equal(await page.locator('.manga-directory-search-clear').evaluate(node => { const rect = node.getBoundingClientRect(); return rect.height >= 44 && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === node; }), true,
          'the new directory clear control must remain a visible 44px target at 320px');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.keyboard.press('Shift+Tab'); assert.equal(await input.evaluate(node => node === document.activeElement), true);
        await input.press('Enter');
        const button = page.locator('.manga-chapter-row[data-chapter-index="127"] button');
        assert.equal(await button.evaluate(node => node === document.activeElement), true, 'explicit directory Enter must focus the first matching available chapter');
        assert.equal(await page.locator('.manga-reader').count(), 0, 'search Enter must not start reading before the chapter button is explicitly activated');
        assert.equal(countRequests(url => url.pathname.startsWith('/api/')), reads);
        const match = await button.evaluate(node => { const rect = node.getBoundingClientRect(), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return { height: rect.height, top: rect.top, bottom: rect.bottom, viewport: innerHeight, hit: hit?.closest('button') === node, hitClass: hit?.className,
            searchTop: document.querySelector('.manga-directory-search').getBoundingClientRect().top, searchBottom: document.querySelector('.manga-directory-search').getBoundingClientRect().bottom }; });
        console.log(JSON.stringify({ mode: 'manga-directory-search-keyboard-320', match }));
        assert(match.height > 0 && match.top >= 0 && match.bottom <= match.viewport && match.hit, 'the focused chapter match must be fully visible and clickable at 320px');
        await page.keyboard.press('Tab'); assert.equal(await page.locator('.manga-chapter-row[data-chapter-index="127"] a').evaluate(node => node === document.activeElement), true);
        await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Enter'); await readerTitle(page, 'Comic C', 'Chapter 127');
        assert.equal(await progress(page, 'C'), 127); assert.equal(new URL(page.url()).pathname, '/manga/C/read/127');
        assert.equal(countRequests(url => url.pathname === '/api/manga/C/chapters/127'), 1);
      } finally { comicSnapshots.delete('C'); await page.close(); }
    });
    await run('directory search: composition confirmation and pending matches cannot start reading', async () => {
      for (const candidateKey of ['Enter', 'Unidentified']) {
      comicSnapshots.set('C', searchableCatalogComic('C'));
      const page = await newPage({ real: true, route: '/manga/C' });
      try {
        await detailTitle(page, 'Comic C'); const input = page.locator('.manga-directory-search-input'); await input.fill('777');
        const reads = countRequests(url => url.pathname.startsWith('/api/'));
        await input.evaluate((node, candidateKey) => {
          node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '候选' }));
          node.value = 'ALPHA'; node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', isComposing: true, data: '候选' }));
          node.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: candidateKey, isComposing: true, keyCode: 229 }));
        }, candidateKey);
        assert.deepEqual(await visibleDirectoryIndices(page), [777], 'composition must preserve the last accepted directory results');
        await input.evaluate(node => {
          node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '候选' }));
          node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '候选' }));
          node.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }); await tick(page);
        assert.equal(await input.evaluate(node => node === document.activeElement), true, 'compositionend followed by browser submit must not move focus or open a chapter');
        assert.deepEqual(await visibleDirectoryIndices(page), [127, 128]);
        await input.press('Enter');
        assert.equal(await page.locator('.manga-chapter-row[data-chapter-index="127"] button').evaluate(node => node === document.activeElement), true, 'a subsequent explicit Enter must focus the available result after composition confirmation');
        await input.focus(); await input.fill('ALPHA Pending');
        assert.deepEqual(await visibleDirectoryIndices(page), [128]);
        const pending = page.locator('.manga-chapter-row[data-chapter-index="128"] button'); assert.equal(await pending.isDisabled(), true);
        await input.press('Enter'); await input.press('ArrowDown'); await pending.evaluate(node => node.click()); await tick(page);
        assert.equal(await input.evaluate(node => node === document.activeElement), true);
        assert.equal(await page.locator('.manga-reader').count(), 0); assert.equal(await progress(page, 'C'), null);
        assert.equal(countRequests(url => url.pathname.startsWith('/api/')), reads, 'IME confirmation and unfinished search results must not issue chapter reads');
        await input.fill('alpha'); await input.press('ArrowDown');
        assert.equal(await page.locator('.manga-chapter-row[data-chapter-index="127"] button').evaluate(node => node === document.activeElement), true);
      } finally { comicSnapshots.delete('C'); await page.close(); }
      }
    });
    await run('directory search: background metadata preserves live input and publishes current matches', async () => {
      for (const composing of [false, true]) {
        comicSnapshots.set('C', searchableCatalogComic('C'));
        const page = await newPage({ real: true, route: '/manga/C' });
        const update = hold((url, req) => req.method === 'POST' && url.pathname === '/api/manga/C/update');
        let detail, library;
        try {
          await detailTitle(page, 'Comic C'); await page.locator('[data-action="update"]').click(); await requested(update);
          const input = page.locator('.manga-directory-search-input'); await input.fill('alpha');
          await input.evaluate((node, composing) => {
            if (composing) node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '候选' }));
            node.value = '  ＡＬＰＨＡ  '; node.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: composing, inputType: composing ? 'insertCompositionText' : 'insertText', data: 'ＡＬＰＨＡ' }));
            node.setSelectionRange(2, 7); window.__directoryInput = node; window.__directoryChain = []; window.__directoryBlur = 0;
            for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) __directoryChain.push(ancestor);
            node.addEventListener('blur', () => __directoryBlur++);
          }, composing);
          const changed = searchableCatalogComic('C');
          changed.chapters.find(chapter => chapter.index === 127).status = 'pending'; changed.chapters.find(chapter => chapter.index === 127).downloadedCount = 0;
          Object.assign(changed.chapters.find(chapter => chapter.index === 128), { status: 'done', downloadedCount: 3 });
          changed.chapters.push({ index: 1001, title: 'Alpha New', status: 'done', downloadedCount: 3, imageCount: 3 }); changed.chapterCount = 1001;
          comicSnapshots.set('C', changed);
          detail = hold((url, req) => req.method === 'GET' && url.pathname === '/api/manga/C'); library = hold(url => url.pathname === '/api/manga');
          await settle(page, update); await requested(detail); await requested(library); await settle(page, detail); await settle(page, library);
          await page.waitForFunction(() => Boolean(document.querySelector('.manga-chapter-row[data-chapter-index="1001"]')));
          assert.deepEqual(await input.evaluate(node => [node === __directoryInput, __directoryChain.every(ancestor => ancestor.isConnected), node === document.activeElement, node.value, node.selectionStart, node.selectionEnd, __directoryBlur]),
            [true, true, true, '  ＡＬＰＨＡ  ', 2, 7, 0], 'background directory metadata must retain the complete live input ancestry, raw text, selection and focus');
          assert.deepEqual(await visibleDirectoryIndices(page), [127, 128, 1001]); assert.deepEqual(await directorySearchNumbers(page), [3, 1001]);
          assert.equal(await page.locator('.manga-chapter-row[data-chapter-index="127"] button').isDisabled(), true);
          assert.equal(await page.locator('.manga-chapter-row[data-chapter-index="128"] button').isEnabled(), true, 'matching rows must use the latest download availability rather than their old captured status');
          if (composing) await input.evaluate(node => node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '候选' })));
          const reads = countRequests(url => url.pathname.startsWith('/api/')); await input.fill('Alpha New'); await input.press('Enter');
          assert.equal(await page.locator('.manga-chapter-row[data-chapter-index="1001"] button').evaluate(node => node === document.activeElement), true);
          assert.equal(countRequests(url => url.pathname.startsWith('/api/')), reads);
          await page.keyboard.press('Enter'); await readerTitle(page, 'Comic C', 'Chapter 1001');
        } finally { update.release(); detail?.release(); library?.release(); comicSnapshots.delete('C'); await page.close(); }
      }
    });
    await run('directory search: retired controls cannot alter a new route or reader', async () => {
      for (const destination of ['/manga/D', '/manga/C/read/2', '/manga']) {
        comicSnapshots.set('C', searchableCatalogComic('C'));
        const page = await newPage({ real: true, route: '/manga/C' });
        try {
          await detailTitle(page, 'Comic C');
          await page.evaluate(() => { window.__oldDirectoryForm = document.querySelector('.manga-directory-search'); window.__oldDirectoryButton = document.querySelector('.manga-chapter-row[data-chapter-index="1"] button'); });
          await navigateRoute(page, destination);
          if (destination === '/manga/D') await detailTitle(page, 'Comic D');
          else if (destination.includes('/read/')) { await readerTitle(page, 'Comic C', 'Chapter 2'); await fitImagesReady(page); }
          else await page.locator('.manga-library-controls').waitFor();
          await tick(page);
          const before = await directorySearchSurface(page), reads = countRequests(url => url.pathname.startsWith('/api/'));
          await page.evaluate(() => {
            const form = __oldDirectoryForm, input = form.querySelector('input'); input.value = '777';
            input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '777' }));
            input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '777' }));
            input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' }));
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            form.querySelector('button').click(); __oldDirectoryButton.click();
          }); await tick(page);
          assert.deepEqual(await directorySearchSurface(page), before, 'retired directory search and row controls must preserve the new route, reader, progress and focus');
          assert.equal(countRequests(url => url.pathname.startsWith('/api/')), reads, 'retired directory controls must not start chapter requests in a newer view');
        } finally { comicSnapshots.delete('C'); await page.close(); }
      }
      comicSnapshots.set('C', searchableCatalogComic('C'));
      const page = await newPage({ real: true, route: '/manga/C' });
      const obsolete = hold(url => url.pathname === '/api/manga/C/chapters/777'), current = hold(url => url.pathname === '/api/manga/C/chapters/778');
      try {
        await detailTitle(page, 'Comic C'); await page.locator('.manga-chapter-row[data-chapter-index="777"] button').click(); await requested(obsolete);
        const next = page.locator('.manga-chapter-row[data-chapter-index="778"] button'); assert.equal(await next.isEnabled(), true);
        await next.click(); await requested(current); await assertChapterFeedback(page, { pending: true, chapter: 778 });
        await settle(page, current); await readerTitle(page, 'Comic C', 'Chapter 778'); await fitImagesReady(page);
        await page.evaluate(() => { window.__directoryWinningReader = document.querySelector('.manga-reader'); window.__directoryWinningImages = [...document.querySelectorAll('.manga-reader-pages img')]; });
        await settle(page, obsolete);
        assert.deepEqual(await page.evaluate(() => ({ reader: document.querySelector('.manga-reader') === __directoryWinningReader,
          images: __directoryWinningImages.every((image, index) => image.isConnected && image === document.querySelectorAll('.manga-reader-pages img')[index]),
          chapter: document.querySelector('.manga-reader-identity span').textContent, route: location.pathname,
          progress: JSON.parse(localStorage.getItem('fanhao.manga.progress') || '{}').C })),
          { reader: true, images: true, chapter: 'Chapter 778', route: '/manga/C/read/778', progress: 778 },
          'a newer enabled directory selection must supersede a pending chapter and ignore its late response');
        assert.equal(countRequests(url => url.pathname === '/api/manga/C/chapters/777'), 1);
        assert.equal(countRequests(url => url.pathname === '/api/manga/C/chapters/778'), 1);
        assert.equal(await page.locator('.manga-chapter-feedback').count(), 0, 'the superseded chapter must not replay its old waiting or failure feedback after the new chapter wins');
      } finally { obsolete.release(); current.release(); comicSnapshots.delete('C'); await page.close(); }
    });
    await run('directory search: returning from a deep reader keeps search and its current match reachable', async () => {
      comicSnapshots.set('C', searchableCatalogComic('C'));
      const page = await newPage({ real: true, route: '/manga/C/read/777' });
      try {
        await readerTitle(page, 'Comic C', 'Chapter 777'); await fitImagesReady(page); await page.setViewportSize({ width: 320, height: 740 });
        const reads = countRequests(url => url.pathname.startsWith('/api/'));
        await page.locator('.manga-reader-bar [data-action="detail"]').press('Enter'); await detailTitle(page, 'Comic C'); await tick(page);
        const input = page.locator('.manga-directory-search-input');
        assert.equal(await input.inputValue(), ''); assert.equal((await visibleDirectoryIndices(page)).length, 1000);
        assert.equal((await catalogReturnSnapshot(page, 777)).visible, true);
        assert.equal(await input.evaluate(node => { const rect = node.getBoundingClientRect(); return rect.height >= 44 && rect.top >= 0 && rect.bottom <= innerHeight && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === node; }), true,
          'after returning to a deep chapter the directory search must remain visible and operable at 320px');
        await input.click(); await input.fill('777'); await input.press('Enter');
        const current = await catalogReturnSnapshot(page, 777); assert(current.visible && current.focused && current.hit, 'the current matching chapter must remain fully visible and clickable below the narrow search controls');
        assert.equal(await progress(page, 'C'), 777); assert.equal(countRequests(url => url.pathname.startsWith('/api/')), reads);
        const directory = path.join(root, '.codex-artifacts', 'manga'); fs.mkdirSync(directory, { recursive: true });
        await page.screenshot({ path: path.join(directory, 'directory-search-320.png') });
      } finally { comicSnapshots.delete('C'); await page.close(); }
    });
    await run('directory return: keyboard return reveals the current chapter in a long narrow catalog', async () => {
      comicSnapshots.set('C', catalogComic('C'));
      const page = await newPage({ real: true, route: '/manga/C/read/777' });
      try {
        await readerTitle(page, 'Comic C', 'Chapter 777'); await fitImagesReady(page);
        await page.setViewportSize({ width: 320, height: 740 });
        const reads = countRequests(url => url.pathname.startsWith('/api/'));
        const back = page.locator('.manga-reader-bar [data-action="detail"]'); await back.focus(); await back.press('Enter');
        await detailTitle(page, 'Comic C'); await tick(page);
        const actual = await catalogReturnSnapshot(page, 777);
        console.log(JSON.stringify({ mode: 'manga-directory-keyboard-return', actual }));
        assert(actual.visible, 'returning from a deep chapter must reveal its current directory entry in the viewport');
        assert.equal(actual.rows, 1000); assert.equal(actual.currentIndex, '777'); assert.equal(actual.currentCount, 1);
        assert(actual.focused && actual.hit, 'keyboard return must focus the visible native current-chapter button');
        assert.equal(await progress(page, 'C'), 777);
        assert.equal(countRequests(url => url.pathname.startsWith('/api/')), reads, 'returning to an already loaded directory must not refetch it or any chapter');
        const button = page.locator('.manga-chapter-row[data-chapter-index="777"] button');
        await page.keyboard.press('Tab');
        assert.equal(await page.locator('.manga-chapter-row[data-chapter-index="777"] a').evaluate(link => link === document.activeElement), true);
        await page.keyboard.press('Shift+Tab'); assert.equal(await button.evaluate(button => button === document.activeElement), true);
        const directory = path.join(root, '.codex-artifacts', 'manga'); fs.mkdirSync(directory, { recursive: true });
        await page.screenshot({ path: path.join(directory, 'directory-return-after-320.png') });
        await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
        await readerTitle(page, 'Comic C', 'Chapter 778'); assert.equal(await progress(page, 'C'), 778);
      } finally { comicSnapshots.delete('C'); await page.close(); }
    });
    await run('directory return: pointer footer return and a later refresh yield to user scrolling', async () => {
      comicSnapshots.set('C', catalogComic('C'));
      const page = await newPage({ real: true, route: '/manga/C' });
      const update = hold((url, req) => req.method === 'POST' && url.pathname === '/api/manga/C/update');
      try {
        await detailTitle(page, 'Comic C'); await page.locator('[data-action="update"]').click(); await requested(update);
        await page.locator('.manga-chapter-row[data-chapter-index="777"] button').click(); await readerTitle(page, 'Comic C', 'Chapter 777');
        await fitImagesReady(page); await page.locator('.manga-reader-footer [data-action="detail"]').click(); await detailTitle(page, 'Comic C'); await tick(page);
        const actual = await catalogReturnSnapshot(page, 777);
        assert(actual.visible && actual.hit, 'pointer footer return must reveal the same current-chapter directory target');
        assert.equal(actual.focused, false, 'pointer return must not force keyboard focus into the chapter catalog');
        const previous = await page.evaluate(() => scrollY); await page.mouse.move(600, 500); await page.mouse.wheel(0, -450);
        await page.waitForFunction(previous => scrollY < previous - 100, previous, { timeout: 3000 });
        const intended = await page.evaluate(() => scrollY); await settle(page, update); await tick(page);
        assert(Math.abs(await page.evaluate(() => scrollY) - intended) < 2, 'a background directory refresh must not restore an old return position over a newer user scroll');
        assert.equal((await catalogReturnSnapshot(page, 777)).currentIndex, '777', 'same-comic metadata refresh retains only the current-chapter marker');
      } finally { update.release(); comicSnapshots.delete('C'); await page.close(); }
    });
    await run('directory return: sparse chapter identities and explicit detail navigation stay distinct', async () => {
      comicSnapshots.set('C', catalogComic('C', [4, 77, 7777]));
      const page = await newPage({ real: true, route: '/manga/C/read/7777' });
      try {
        await readerTitle(page, 'Comic C', 'Chapter 7777'); await fitImagesReady(page);
        await page.locator('.manga-reader-bar [data-action="detail"]').press('Enter'); await detailTitle(page, 'Comic C'); await tick(page);
        const actual = await catalogReturnSnapshot(page, 7777);
        assert.equal(actual.currentIndex, '7777', 'directory return must resolve a chapter identity rather than its array position');
        assert.equal(actual.rows, 3); assert(actual.visible && actual.focused);
        await navigateRoute(page, '/manga/C'); await detailTitle(page, 'Comic C'); await tick(page);
        assert.equal(await page.evaluate(() => scrollY), 0, 'an explicit detail navigation must keep the normal book-header entry');
        assert.equal(await page.locator('.manga-catalog [aria-current]').count(), 0, 'reader return context must not leak into a later explicit detail navigation');
      } finally { comicSnapshots.delete('C'); await page.close(); }
    });
    for (const target of ['comic', 'chapter']) await run(`directory return: retired controls cannot change a new ${target}`, async () => {
      comicSnapshots.set('C', catalogComic('C'));
      const page = await newPage({ real: true, route: '/manga/C/read/777' });
      try {
        await readerTitle(page, 'Comic C', 'Chapter 777'); await fitImagesReady(page);
        await page.evaluate(() => { window.__retiredDirectory = document.querySelector('.manga-reader-bar [data-action="detail"]'); });
        await navigateRoute(page, target === 'comic' ? '/manga/D/read/2' : '/manga/C/read/778');
        await readerTitle(page, target === 'comic' ? 'Comic D' : 'Comic C', target === 'comic' ? 'Chapter 2' : 'Chapter 778');
        await fitImagesReady(page); await tick(page);
        const before = await page.evaluate(() => ({ html: document.querySelector('#workGrid').innerHTML, route: location.href, scroll: scrollY, progress: localStorage.getItem('fanhao.manga.progress') }));
        await page.evaluate(() => __retiredDirectory.click()); await tick(page);
        assert.deepEqual(await page.evaluate(() => ({ html: document.querySelector('#workGrid').innerHTML, route: location.href, scroll: scrollY, progress: localStorage.getItem('fanhao.manga.progress') })), before,
          'retired directory controls must not replace a newer comic or chapter reading surface');
      } finally { comicSnapshots.delete('C'); await page.close(); }
    });
    await run('library add draft: a background comic update preserves the unsubmitted source link', async () => {
      const page = await newPage({ real: true });
      const update = hold((url, req) => req.method === 'POST' && url.pathname === '/api/manga/C/update');
      const added = hold((url, req) => req.method === 'POST' && url.pathname === '/api/manga/add');
      const beforeAdds = addBodies.length;
      try {
        await openLibraryDuringUpdate(page, update); await page.locator('.manga-add-toggle').click();
        const input = page.locator('.manga-add-panel input');
        await input.fill('https://example.invalid/comic/new-draft');
        await input.evaluate(input => { window.__addInput = input; window.__addForm = input.form; window.__addBlur = 0; input.addEventListener('blur', () => __addBlur++); input.setSelectionRange(8, 20); });
        await settle(page, update);
        const after = await input.evaluate(input => ({ value: input.value, same: input === __addInput, form: input.form === __addForm, focus: input === document.activeElement,
          blur: __addBlur, selection: [input.selectionStart, input.selectionEnd] }));
        console.log(JSON.stringify({ mode: 'manga-add-link-draft', after }));
        assert.equal(after.value, 'https://example.invalid/comic/new-draft', 'a background library refresh must not erase an unsubmitted comic source link');
        assert(after.same && after.form && after.focus && after.blur === 0, 'the live add form must remain connected while a different comic finishes updating');
        assert.deepEqual(after.selection, [8, 20]);
        await page.keyboard.press('Tab');
        assert.equal(await page.locator('.manga-add-panel button[type="submit"]').evaluate(button => button === document.activeElement), true);
        await page.keyboard.press('Shift+Tab'); await input.press('Enter'); await requested(added);
        assert.deepEqual(addBodies.slice(beforeAdds), [{ url: 'https://example.invalid/comic/new-draft' }]);
        assert.equal(await input.isDisabled(), true, 'starting a submitted add job must update the preserved form into its disabled busy state');
        await page.evaluate(() => __addForm.querySelector('[data-action="close"]').click());
        assert.equal(await input.isDisabled(), true, 'a retired idle form must not clear an already accepted add request');
        await settle(page, added); await page.locator('.manga-add-panel [data-action="catalog"]').waitFor();
        await page.locator('.manga-add-panel [data-action="catalog"]').click(); await detailTitle(page, 'Comic D');
      } finally { update.release(); added.release(); await page.close(); }
    });
    await run('library add draft: editing a failed add survives another update and retries the actual link', async () => {
      const page = await newPage({ real: true });
      const update = hold((url, req) => req.method === 'POST' && url.pathname === '/api/manga/C/update');
      const failure = hold((url, req) => req.method === 'POST' && url.pathname === '/api/manga/add', 'Synthetic collector unavailable');
      const beforeAdds = addBodies.length;
      try {
        await openLibraryDuringUpdate(page, update); await page.locator('.manga-add-toggle').click();
        const input = page.locator('.manga-add-panel input'); await input.fill('https://example.invalid/failed'); await input.press('Enter'); await requested(failure); await settle(page, failure);
        await page.locator('.manga-add-panel [role="alert"]').waitFor();
        await input.fill('https://example.invalid/repaired');
        await input.evaluate(input => { window.__failedAddInput = input; input.setSelectionRange(8, 20); input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
        await settle(page, update);
        assert.deepEqual(await input.evaluate(input => [input === __failedAddInput, input === document.activeElement, input.value, input.selectionStart, input.selectionEnd]), [true, true, 'https://example.invalid/repaired', 8, 20],
          'background results must preserve the edited link, original failed form and composition selection');
        assert.equal(addBodies.length, beforeAdds + 1, 'editing a failed add draft must not submit it automatically');
        await input.evaluate(input => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
        const recovered = hold(failure.match); await input.press('Enter'); await requested(recovered);
        assert.equal(await page.locator('.manga-add-panel [role="alert"]').count(), 0, 'a new add attempt must clear the previous failure rather than freezing old status');
        assert.deepEqual(addBodies.slice(beforeAdds), [{ url: 'https://example.invalid/failed' }, { url: 'https://example.invalid/repaired' }]);
        await settle(page, recovered); await page.locator('.manga-add-panel [data-action="catalog"]').waitFor();
      } finally { update.release(); failure.release(); await page.close(); }
    });
    await run('library add draft: local sorting preserves an idle link without implicitly submitting it', async () => {
      const page = await newPage({ real: true });
      const beforeAdds = addBodies.length;
      try {
        await page.locator('.manga-add-toggle').click(); const input = page.locator('.manga-add-panel input'); await input.fill('https://example.invalid/sort-draft');
        await input.evaluate(input => { window.__sortedAddInput = input; input.setSelectionRange(8, 20); });
        const sort = page.locator('.manga-library-controls select'); await sort.focus(); await page.keyboard.press('ArrowDown'); await tick(page);
        assert.equal(await sort.evaluate(select => select === document.activeElement), true);
        assert.equal(await input.evaluate(input => input === __sortedAddInput && input.value === 'https://example.invalid/sort-draft'), true);
        assert.equal(addBodies.length, beforeAdds);
        await page.locator('.manga-add-panel [data-action="close"]').click();
        assert.equal(await page.locator('.manga-add-panel').count(), 0);
      } finally { await page.close(); }
    });
    for (const target of ['comic', 'route']) await run(`library add draft: retired form cannot submit or close a new ${target}`, async () => {
      const page = await newPage({ real: true });
      try {
        await page.locator('.manga-add-toggle').click(); await page.locator('.manga-add-panel input').fill('https://example.invalid/retired');
        await page.evaluate(() => { window.__retiredAddForm = document.querySelector('.manga-add-panel'); });
        await navigateRoute(page, target === 'comic' ? '/manga/D' : '/manga?q=Comic%20D&sort=title');
        if (target === 'comic') await detailTitle(page, 'Comic D');
        else await page.waitForFunction(() => document.querySelector('.manga-library-controls input')?.value === 'Comic D' && !document.querySelector('.manga-status'));
        const beforeAdds = addBodies.length;
        const beforeStarts = await page.evaluate(() => __transport.started.filter(url => url === '/api/manga/add').length);
        const before = await page.locator('#workGrid').innerHTML();
        await page.evaluate(() => { __retiredAddForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); __retiredAddForm.querySelector('[data-action="close"]').click(); }); await tick(page);
        assert.equal(await page.evaluate(() => __transport.started.filter(url => url === '/api/manga/add').length), beforeStarts, 'retired add controls must not submit their draft into a newer view or comic');
        assert.equal(addBodies.length, beforeAdds, 'retired add controls must not submit their draft into a newer view or comic');
        assert.equal(await page.locator('#workGrid').innerHTML(), before, 'retired add controls must not close or rebuild the newer surface');
      } finally { await page.close(); }
    });
    await run('reader page navigation: a long chapter exposes a reachable current-page jump control', async () => {
      readerImageCount = 1000; readerImageDimensions = { width: 800, height: 1400 };
      const page = await newPage({ real: true, route: '/manga/C/read/1' });
      try {
        await readerTitle(page, 'Comic C', 'Chapter 1'); await fitImagesReady(page);
        await page.setViewportSize({ width: 390, height: 844 }); await tick(page);
        await page.locator('.manga-reader-image').nth(499).evaluate(figure => { window.scrollTo(0, scrollY + figure.getBoundingClientRect().top + figure.getBoundingClientRect().height * .2); });
        await page.locator('.manga-reader-image img').nth(499).evaluate(image => image.decode()); await tick(page);
        const before = await page.evaluate(() => ({ scroll: scrollY, pages: document.querySelectorAll('.manga-reader-image').length,
          visibleActions: [...document.querySelectorAll('.manga-reader button, .manga-reader input')].filter(node => {
            const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight
              && node.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
          }).map(node => node.textContent || node.getAttribute('aria-label')) }));
        console.log(JSON.stringify({ mode: 'manga-long-chapter-navigation', before }));
        assert.equal(await page.locator('.manga-page-indicator').count(), 1, 'a long chapter needs a current-page and exact jump entry reachable while reading its middle');
        await page.waitForFunction(() => document.querySelector('.manga-page-indicator')?.dataset.page === '500');
        await page.evaluate(() => { window.__jumpReader = document.querySelector('.manga-reader'); window.__jumpImages = [...document.querySelectorAll('.manga-reader-image img')]; __fitCreated.total = __fitCreated.images = 0; });
        const reads = countRequests(url => url.pathname.startsWith('/api/'));
        const imageReads = countRequests(url => /^\/synthetic\/C\/1\//.test(url.pathname));
        await page.locator('.manga-page-indicator').click();
        const input = page.locator('.manga-page-jump input'); await input.fill('1000'); await input.press('Enter');
        await page.waitForFunction(() => document.querySelector('.manga-page-indicator')?.dataset.page === '1000');
        await page.locator('.manga-reader-image img').last().evaluate(image => image.decode()); await tick(page);
        assert.equal(await page.evaluate(() => __jumpReader === document.querySelector('.manga-reader') && __jumpImages.every((image, index) => image === document.querySelectorAll('.manga-reader-image img')[index])), true,
          'exact page navigation must retain the current reader and all original image nodes');
        assert.equal(countRequests(url => url.pathname.startsWith('/api/')), reads, 'page navigation is local and must not refetch the chapter or catalog');
        assert.equal(await page.locator('.manga-page-indicator').evaluate(button => button === document.activeElement), true);
        const requestsAfterJump = countRequests(url => /^\/synthetic\/C\/1\//.test(url.pathname));
        assert(requestsAfterJump < 30, 'jumping in a thousand-page chapter must keep native image loading near the visible pages');
        console.log(JSON.stringify({ mode: 'manga-page-jump-1000', apiReads: countRequests(url => url.pathname.startsWith('/api/')) - reads,
          initialImageReads: imageReads, imageReadsAfterJump: requestsAfterJump, images: readerImageCount, retained: true }));
      } finally { readerImageCount = 3; readerImageDimensions = null; await page.close(); }
    });
    await run('reader page navigation: native keyboard, boundaries and invalid drafts work on a narrow reader', async () => {
      readerImageCount = 40; readerImageDimensions = { width: 800, height: 1400 };
      const page = await newPage({ real: true, route: '/manga/C/read/1' });
      try {
        await readerTitle(page, 'Comic C', 'Chapter 1'); await fitImagesReady(page); await page.setViewportSize({ width: 320, height: 640 });
        const counter = page.locator('.manga-page-indicator'), input = page.locator('.manga-page-jump input');
        await counter.focus(); await page.keyboard.press('Enter');
        assert.equal(await input.evaluate(input => input === document.activeElement), true);
        const scroll = await page.evaluate(() => scrollY);
        for (const value of ['', '0', '41', '-1', '1.5', '1e1', '字']) {
          await input.fill(value); await input.press('Enter');
          assert.equal(await input.getAttribute('aria-invalid'), 'true');
          assert.equal(await input.evaluate(input => input === document.activeElement), true);
          assert.equal(await page.evaluate(() => scrollY), scroll, 'invalid page input must not move the reader');
        }
        await input.fill('40'); await page.keyboard.press('Tab');
        assert.equal(await page.locator('.manga-page-jump button[type="submit"]').evaluate(button => button === document.activeElement), true);
        await page.keyboard.press('Shift+Tab'); assert.equal(await input.evaluate(input => input === document.activeElement), true);
        await input.press('Enter'); await page.waitForFunction(() => document.querySelector('.manga-page-indicator').dataset.page === '40');
        await counter.press('Enter'); await input.fill('1'); await input.press('Enter');
        await page.waitForFunction(() => document.querySelector('.manga-page-indicator').dataset.page === '1');
        assert.equal(await page.evaluate(() => scrollY), 0);
        await counter.press('Enter');
        await input.evaluate(input => { input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); input.value = '9'; input.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })); });
        assert.equal(await page.locator('.manga-page-jump').evaluate(form => form.hidden), false);
        assert.equal(await page.evaluate(() => scrollY), 0, 'uncommitted IME input must not jump or close the page form');
        await input.evaluate(input => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
        await input.press('Escape');
        assert.equal(await counter.evaluate(button => button === document.activeElement), true);
        assert.equal(await page.locator('.manga-page-jump').evaluate(form => form.hidden), true);
      } finally { readerImageCount = 3; readerImageDimensions = null; await page.close(); }
    });
    for (const intent of ['complete', 'wheel']) await run(`reader page navigation: unknown target geometry respects ${intent}`, async () => {
      readerImageCount = 80; readerImageDimensions = Array.from({ length: 80 }, (_, index) => index < 6 ? { width: 800, height: 1400 } : {});
      let releaseImages; readerImageWait = new Promise(resolve => { releaseImages = resolve; });
      const targetReads = countRequests(url => url.pathname === '/synthetic/C/1/8.svg');
      const page = await newPage({ real: true, route: '/manga/C' });
      try {
        await detailTitle(page, 'Comic C'); await page.locator('[data-action="read"]').click(); await readerTitle(page, 'Comic C', 'Chapter 1');
        await page.locator('.manga-page-indicator').click(); await page.locator('.manga-page-jump input').fill('8'); await page.locator('.manga-page-jump input').press('Enter');
        await until(() => countRequests(url => url.pathname === '/synthetic/C/1/8.svg') > targetReads, 'this jump must reach its native lazy image even before it has geometry');
        if (intent === 'wheel') {
          const before = await page.evaluate(() => ({ scroll: scrollY, viewport: [innerWidth, innerHeight], targetTop: document.querySelectorAll('.manga-reader-image')[7].getBoundingClientRect().top }));
          console.log(JSON.stringify({ mode: 'manga-page-jump-wheel', before }));
          assert(before.scroll > 5000, 'the current jump must reach its real lazy target before user cancellation');
          await page.mouse.move(600, 500); await page.mouse.wheel(0, -450);
          await page.waitForFunction(previous => scrollY < previous - 100, before.scroll, { timeout: 3000 });
        }
        releaseImages();
        await page.locator('.manga-reader-image img').nth(7).evaluate(image => image.decode()); await tick(page); await tick(page);
        const top = await page.locator('.manga-reader-image').nth(7).evaluate(figure => figure.getBoundingClientRect().top);
        const inset = await page.locator('.manga-reader-bar').evaluate(bar => getComputedStyle(bar).position === 'sticky' ? bar.getBoundingClientRect().bottom : 0);
        if (intent === 'complete') {
          assert(Math.abs(top - inset) < 2, 'an unknown image target must settle below the visible reader toolbar without covering its first pixels');
          assert.equal(await page.locator('.manga-page-indicator').getAttribute('data-page'), '8');
        } else assert(Math.abs(top - inset) > 100, 'page jump settling must yield to a later user scroll rather than returning to the requested page');
      } finally { releaseImages(); readerImageWait = null; readerImageCount = 3; readerImageDimensions = null; await page.close(); }
    });
    for (const target of ['chapter', 'comic']) await run(`reader page navigation: old controls cannot jump a new ${target}`, async () => {
      readerImageCount = 40; readerImageDimensions = { width: 800, height: 1400 };
      const page = await newPage({ real: true, route: '/manga/C/read/1' });
      try {
        await readerTitle(page, 'Comic C', 'Chapter 1'); await page.locator('.manga-page-indicator').click();
        await page.evaluate(() => { window.__oldPageForm = document.querySelector('.manga-page-jump'); window.__oldPageCounter = document.querySelector('.manga-page-indicator'); });
        await navigateRoute(page, target === 'chapter' ? '/manga/C/read/2' : '/manga/D/read/2');
        await readerTitle(page, target === 'chapter' ? 'Comic C' : 'Comic D', 'Chapter 2'); await tick(page);
        const before = await page.evaluate(() => ({ scroll: scrollY, route: location.href, html: document.querySelector('.manga-reader').innerHTML }));
        await page.evaluate(() => { __oldPageCounter.click(); __oldPageForm.querySelector('input').value = '20'; __oldPageForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
        await tick(page);
        assert.deepEqual(await page.evaluate(() => ({ scroll: scrollY, route: location.href, html: document.querySelector('.manga-reader').innerHTML })), before,
          'retired page controls must not alter the newer chapter or comic reading surface');
        await page.locator('.manga-reader-image').nth(9).evaluate(figure => window.scrollTo(0, scrollY + figure.getBoundingClientRect().top + figure.getBoundingClientRect().height * .2));
        await tick(page); await tick(page);
        assert.equal(await page.locator('.manga-page-indicator').getAttribute('data-page'), '10',
          'retired page controls must not cancel the newer reader page tracking session');
      } finally { readerImageCount = 3; readerImageDimensions = null; await page.close(); }
    });
    await run('reader page navigation: a 320px form and compact image recovery remain independently reachable', async () => {
      readerImageCount = 3; readerImageDimensions = readerImageIntrinsic = { width: 1600, height: 100 };
      const failures = [1, 2, 3].map(index => hold(url => url.pathname === `/synthetic/C/1/${index}.svg`, 'Synthetic short image unavailable'));
      failures.forEach(gate => gate.release());
      const page = await newPage({ real: true, route: '/manga/C/read/1' });
      try {
        await readerTitle(page, 'Comic C', 'Chapter 1'); await page.setViewportSize({ width: 320, height: 640 });
        await page.waitForFunction(() => document.querySelectorAll('.manga-reader-recovery button').length === 3);
        await page.locator('.manga-page-indicator').click();
        const hit = async locator => locator.evaluate(node => { const rect = node.getBoundingClientRect(); return rect.height >= 44 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight && node.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)); });
        for (const locator of [page.locator('.manga-page-indicator'), page.locator('.manga-page-jump input'), ...await page.locator('.manga-page-jump button').all(), ...await page.locator('.manga-reader-recovery button').all()]) assert(await hit(locator), 'page navigation and every existing image retry must keep a 44px independently clickable target');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'narrow page navigation must not overflow horizontally');
        const directory = path.join(root, '.codex-artifacts', 'manga'); fs.mkdirSync(directory, { recursive: true });
        await page.screenshot({ path: path.join(directory, 'page-navigation-320.png') });
      } finally { failures.forEach(gate => gate.release()); readerImageCount = 3; readerImageDimensions = null; readerImageIntrinsic = { width: 800, height: 1400 }; await page.close(); }
    });
    await run('reader position: continue reading restores the saved page inside a long chapter', async () => {
      readerImageCount = 40; readerImageDimensions = { width: 800, height: 1400 };
      const page = await newPage({ real: true, route: '/manga/C/read/1' });
      try {
        await readerTitle(page, 'Comic C', 'Chapter 1'); await fitImagesReady(page);
        const before = await page.evaluate(() => {
          const image = document.querySelectorAll('.manga-reader-image')[7];
          window.scrollTo(0, scrollY + image.getBoundingClientRect().top + image.getBoundingClientRect().height * .35);
          return { scroll: scrollY, top: image.getBoundingClientRect().top, progress: localStorage.getItem('fanhao.manga.progress') };
        });
        assert(before.scroll > 5000, 'resume fixture must start well inside an actual long chapter');
        await page.locator('.manga-reader-bar [data-action="detail"]').click(); await detailTitle(page, 'Comic C');
        await page.locator('.manga-detail [data-action="read"]').click(); await readerTitle(page, 'Comic C', 'Chapter 1');
        await fitImagesReady(page); await tick(page);
        const after = await page.evaluate(() => ({ scroll: scrollY, top: document.querySelectorAll('.manga-reader-image')[7].getBoundingClientRect().top }));
        console.log(JSON.stringify({ mode: 'manga-chapter-position', before, after }));
        assert(Math.abs(after.top - before.top) < 3, 'continue reading must restore the saved page position inside a long chapter instead of restarting at page one');
      } finally { readerImageCount = 3; readerImageDimensions = null; await page.close(); }
    });
    await run('reader position: document reload and narrow viewport retain the page-relative position', async () => {
      readerImageCount = 40; readerImageDimensions = { width: 800, height: 1400 };
      const page = await newPage({ real: true, route: '/manga/C/read/1' });
      try {
        await readerTitle(page, 'Comic C', 'Chapter 1'); await fitImagesReady(page);
        await page.evaluate(() => { const rect = document.querySelectorAll('.manga-reader-image')[12].getBoundingClientRect(); window.scrollTo(0, scrollY + rect.top + rect.height * .6); });
        await page.reload(); await ready(page); await readerTitle(page, 'Comic C', 'Chapter 1'); await tick(page);
        await assertReadingAnchor(page, 12, .6);
        await page.locator('.manga-reader-bar [data-action="detail"]').click(); await detailTitle(page, 'Comic C');
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('.manga-detail [data-action="read"]').click(); await readerTitle(page, 'Comic C', 'Chapter 1'); await tick(page);
        await assertReadingAnchor(page, 12, .6);
        assert.equal(await page.locator('.manga-reader-pages').evaluate(area => area.scrollTop), 0, 'vertical reading position belongs to the actual document rather than the horizontal image container');
      } finally { readerImageCount = 3; readerImageDimensions = null; await page.close(); }
    });
    await run('reader position: a position before the first image retains the visible chapter controls', async () => {
      readerImageCount = 40; readerImageDimensions = { width: 800, height: 1400 };
      const page = await newPage({ real: true, route: '/manga/C/read/1' });
      try {
        await readerTitle(page, 'Comic C', 'Chapter 1'); await fitImagesReady(page);
        await page.setViewportSize({ width: 390, height: 844 }); await tick(page);
        await page.evaluate(() => window.scrollTo(0, 10));
        assert(await page.locator('.manga-reader-image').first().evaluate(figure => figure.getBoundingClientRect().top > 40));
        await page.locator('.manga-reader-bar [data-action="detail"]').click(); await detailTitle(page, 'Comic C');
        await page.locator('.manga-detail [data-action="read"]').click(); await readerTitle(page, 'Comic C', 'Chapter 1'); await tick(page);
        const after = await page.evaluate(() => {
          const button = document.querySelector('.manga-reader-bar [data-action="detail"]'), rect = button.getBoundingClientRect();
          return { scroll: scrollY, imageTop: document.querySelector('.manga-reader-image').getBoundingClientRect().top,
            controlsVisible: rect.top >= 0 && rect.bottom < innerHeight && button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)) };
        });
        console.log(JSON.stringify({ mode: 'manga-leading-position', after }));
        assert(after.controlsVisible && after.imageTop > 40, 'resuming before the first page must keep the chapter title and controls visible instead of scrolling them out');
      } finally { readerImageCount = 3; readerImageDimensions = null; await page.close(); }
    });
    await run('reader position: numeric legacy progress and explicit chapter starts remain compatible', async () => {
      readerImageCount = 40; readerImageDimensions = { width: 800, height: 1400 };
      const page = await newPage({ real: true, route: '/manga/C' });
      try {
        await detailTitle(page, 'Comic C'); await page.evaluate(() => { localStorage.setItem('fanhao.manga.progress', '{"C":2}'); });
        await page.locator('.manga-detail [data-action="read"]').click(); await readerTitle(page, 'Comic C', 'Chapter 2'); await tick(page);
        assert.equal(await page.evaluate(() => scrollY), 0, 'old numeric chapter progress still resumes its chapter at the start');
        await page.evaluate(() => { const rect = document.querySelectorAll('.manga-reader-image')[8].getBoundingClientRect(); window.scrollTo(0, scrollY + rect.top + rect.height * .3); });
        await page.locator('.manga-reader-bar [data-action="detail"]').click(); await detailTitle(page, 'Comic C');
        await page.locator('.manga-chapter-row button').nth(1).click(); await readerTitle(page, 'Comic C', 'Chapter 2'); await tick(page);
        assert.equal(await page.evaluate(() => scrollY), 0, 'explicit directory selection starts a chapter from the beginning even when it has a saved position');
        await page.locator('.manga-reader-bar [data-action="previous"]').click(); await readerTitle(page, 'Comic C', 'Chapter 1'); await tick(page);
        assert.equal(await page.evaluate(() => scrollY), 0, 'chapter navigation must not reuse a different chapter position');
        assert.equal(await progress(page, 'C'), 1, 'chapter progress keeps its numeric storage contract');
      } finally { readerImageCount = 3; readerImageDimensions = null; await page.close(); }
    });
    for (const intent of ['complete', 'wheel', 'focus', 'navigation']) await run(`reader position: missing geometry waits for images and respects ${intent}`, async () => {
      readerImageCount = 80;
      readerImageDimensions = Array.from({ length: 80 }, (_, index) => index < 6 ? { width: 800, height: 1400 } : {});
      let releaseImages; readerImageWait = new Promise(resolve => { releaseImages = resolve; });
      const page = await newPage({ real: true, route: '/manga/C' });
      try {
        await detailTitle(page, 'Comic C');
        await page.evaluate(() => { localStorage.setItem('fanhao.manga.progress', '{"C":1}'); localStorage.setItem('fanhao.manga.positions', '{"C":{"chapter":1,"page":7,"ratio":0.35,"atStart":false}}'); });
        await page.locator('.manga-detail [data-action="read"]').click(); await readerTitle(page, 'Comic C', 'Chapter 1'); await tick(page);
        await page.evaluate(() => { window.__positionReader = document.querySelector('.manga-reader'); window.__positionImages = [...document.querySelectorAll('.manga-reader-image img')]; });
        if (intent === 'wheel') {
          const previousScroll = await page.evaluate(() => scrollY);
          assert(previousScroll > 5000, 'mixed geometry must reach the real lazy target before user cancellation');
          await page.mouse.move(600, 500); await page.mouse.wheel(0, -450);
          await page.waitForFunction(previous => scrollY < previous - 100, previousScroll, { timeout: 3000 });
        }
        if (intent === 'focus') await page.locator('.manga-reader-footer [data-action="detail"]').focus();
        if (intent === 'navigation') {
          await navigateRoute(page, '/manga/D/read/2');
        }
        releaseImages();
        // Free the old image responses before waiting for the new JSON read:
        // HTTP/1 per-origin connections are deliberately occupied by this fixture.
        if (intent === 'navigation') await readerTitle(page, 'Comic D', 'Chapter 2');
        await page.waitForFunction(navigation => [...document.querySelectorAll('.manga-reader-image img')].slice(navigation ? 0 : 6, navigation ? 2 : 14)
          .every(image => image.complete && image.naturalWidth > 0), intent === 'navigation', { timeout: 5000 });
        await tick(page); await tick(page);
        if (intent === 'complete') {
          await assertReadingAnchor(page, 7, .35);
          assert.equal(await page.evaluate(() => __positionReader === document.querySelector('.manga-reader') && __positionImages.every((image, index) => image === document.querySelectorAll('.manga-reader-image img')[index])), true,
            'late image geometry must restore in place without rebuilding any reader image');
        } else if (intent === 'navigation') {
          assert.equal(await page.evaluate(() => scrollY), 0, 'old image completion must not scroll a newly opened comic or chapter');
          assert.equal(await progress(page, 'D'), 2);
        } else {
          const ratio = await page.locator('.manga-reader-image').nth(7).evaluate(figure => -figure.getBoundingClientRect().top / figure.getBoundingClientRect().height);
          assert(Math.abs(ratio - .35) > .1, 'late image geometry must yield to newer user scrolling or focus instead of pulling back to the saved position');
          if (intent === 'focus') assert.equal(await page.locator('.manga-reader-footer [data-action="detail"]').evaluate(button => document.activeElement === button), true);
        }
      } finally { releaseImages(); readerImageWait = null; readerImageCount = 3; readerImageDimensions = null; await page.close(); }
    });
    for (const result of ['success', 'failure', 'known failure']) await run(`reader position: a late preceding image ${result} keeps the restored page stable`, async () => {
      readerImageCount = 40;
      const known = result === 'known failure', index = known ? 0 : 6;
      readerImageDimensions = Array.from({ length: 40 }, (_, offset) => offset === index && !known ? {} : { width: 800, height: 1400 });
      const image = hold(url => url.pathname === `/synthetic/C/1/${index + 1}.svg`, result.includes('failure') ? 'Synthetic image unavailable' : '');
      const page = await newPage({ real: true, route: '/manga/C' });
      try {
        await detailTitle(page, 'Comic C');
        await page.evaluate(() => { localStorage.setItem('fanhao.manga.progress', '{"C":1}'); localStorage.setItem('fanhao.manga.positions', '{"C":{"chapter":1,"page":7,"ratio":0.35,"atStart":false}}'); });
        await page.locator('.manga-detail [data-action="read"]').click(); await readerTitle(page, 'Comic C', 'Chapter 1'); await requested(image); await tick(page);
        const before = await page.locator('.manga-reader-image').nth(index).evaluate(figure => figure.getBoundingClientRect().height);
        image.release();
        if (result.includes('failure')) await page.locator('.manga-reader-image').nth(index).locator('button').waitFor();
        else await page.locator('.manga-reader-image img').nth(index).evaluate(image => image.decode());
        await tick(page); await tick(page);
        await assertReadingAnchor(page, 7, .35);
        const after = await page.locator('.manga-reader-image').nth(index).evaluate(figure => figure.getBoundingClientRect().height);
        console.log(JSON.stringify({ mode: 'manga-resume-late-geometry', result, before, after }));
        if (known) assert.equal(after, before, 'declared image geometry must retain the restored anchor even when a late image fails');
        else assert(after > before, 'missing preceding geometry must actually grow after success or error before verifying its target anchor');
      } finally { image.release(); readerImageCount = 3; readerImageDimensions = null; await page.close(); }
    });
    await run('library filter controls: sorting preserves the unsubmitted search and native focus', async () => {
      const page = await newPage();
      try {
        await openTarget(page, {}); await page.locator('.manga-library-controls').waitFor();
        const input = page.locator('.manga-library-controls input[type="search"]'), sort = page.locator('.manga-library-controls select');
        await input.fill('Comic C');
        await input.evaluate(input => { input.setSelectionRange(1, 5); fixture.filterInput = input; fixture.filterForm = input.closest('form'); });
        await sort.focus(); await sort.evaluate(select => { fixture.filterSort = select; fixture.filterBlur = 0; select.addEventListener('blur', () => fixture.filterBlur++); });
        await page.keyboard.press('ArrowDown');
        await page.waitForFunction(() => fixture.state.manga.sort === 'title');
        const after = await page.evaluate(() => ({ query: fixture.state.manga.query, value: document.querySelector('.manga-library-controls input').value,
          sameInput: fixture.filterInput === document.querySelector('.manga-library-controls input'),
          sameForm: fixture.filterForm === document.querySelector('.manga-library-controls'),
          focused: fixture.filterSort === document.activeElement, blur: fixture.filterBlur }));
        console.log(JSON.stringify({ mode: 'manga-library-sort-draft', after }));
        assert.equal(after.value, 'Comic C', 'sorting must preserve the unsubmitted manga search instead of erasing the draft');
        assert.equal(after.query, '', 'sorting does not implicitly submit a draft query');
        assert(after.sameInput && after.sameForm && after.focused && after.blur === 0, 'sorting must preserve the native form/input/select and current focus');
        await page.keyboard.press('Shift+Tab');
        assert.equal(await input.evaluate(input => input === document.activeElement), true);
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => fixture.state.manga.query === 'Comic C');
        assert.equal(await page.locator('.manga-card').count(), 1);
        assert.match(await page.locator('.manga-card').textContent(), /Comic C/);
        assert.equal(await input.evaluate(input => input === document.activeElement), true, 'submitted local search must remain editable for the next query');
        await page.keyboard.press('Tab');
        assert.equal(await sort.evaluate(select => select === document.activeElement), true, 'forward Tab keeps the native input-to-sort order after refreshing results');
        await page.keyboard.press('Shift+Tab');
        assert.equal(await input.evaluate(input => input === document.activeElement), true);
      } finally { await page.close(); }
    });
    await run('library filter controls: background completion preserves a composing input and selection', async () => {
      const page = await newPage();
      const update = hold((url, req) => req.method === 'POST' && url.pathname === '/api/manga/C/update');
      try {
        await openTarget(page, { mangaComicId: 'C' }); await page.locator('[data-action="update"]').click(); await requested(update);
        await openTarget(page, {});
        const input = page.locator('.manga-library-controls input'); await input.focus();
        await input.evaluate(input => {
          fixture.composingInput = input; fixture.composingForm = input.closest('form'); fixture.composingLibrary = input.closest('.manga-library'); fixture.composingBlur = 0;
          input.addEventListener('blur', () => fixture.composingBlur++);
          input.dispatchEvent(new CompositionEvent('compositionstart', { data: '中', bubbles: true }));
          input.value = 'zhongwen'; input.setSelectionRange(1, 6);
          input.dispatchEvent(new InputEvent('input', { data: 'zhongwen', inputType: 'insertCompositionText', isComposing: true, bubbles: true }));
        });
        comicSnapshots.set('C', { ...comic('C'), title: '中文漫画' });
        await settle(page, update);
        await page.waitForFunction(() => fixture.state.manga.data?.comics.some(comic => comic.title === '中文漫画'));
        await page.locator('.manga-library-controls select').selectOption('title');
        assert.deepEqual(await input.evaluate(input => ({ same: input === fixture.composingInput, form: input.closest('form') === fixture.composingForm,
          library: input.closest('.manga-library') === fixture.composingLibrary, focus: input === document.activeElement,
          value: input.value, selection: [input.selectionStart, input.selectionEnd], blur: fixture.composingBlur, query: fixture.state.manga.query })),
          { same: true, form: true, library: true, focus: true, value: 'zhongwen', selection: [1, 6], blur: 0, query: '' },
          'background data/sort refresh must keep the live composing form chain and its unsubmitted selection');
        await input.evaluate(input => { input.value = '中文'; input.dispatchEvent(new CompositionEvent('compositionend', { data: '中文', bubbles: true })); });
        await input.press('Enter');
        assert.equal(await page.locator('.manga-card').count(), 1);
        assert.match(await page.locator('.manga-card').textContent(), /中文漫画/);
      } finally { update.release(); comicSnapshots.clear(); await page.close(); }
    });
    await run('library filter controls: clearing the submitted query restores the full local results', async () => {
      const page = await newPage();
      try {
        await openTarget(page, {});
        const input = page.locator('.manga-library-controls input'); await input.fill('Comic C'); await input.press('Enter');
        assert.equal(await page.locator('.manga-card').count(), 1);
        const reads = countRequests(url => url.pathname === '/api/manga');
        await input.fill('');
        await page.locator('.manga-library-controls select').selectOption('chapters');
        assert.equal(await page.locator('.manga-card').count(), 1, 'a sort change keeps the last submitted query while a clear is still a draft');
        await input.press('Enter');
        assert.equal(await page.locator('.manga-card').count(), 2);
        assert.equal(await input.evaluate(input => input === document.activeElement && input.value === ''), true);
        assert.equal(countRequests(url => url.pathname === '/api/manga'), reads, 'local query and sorting must not issue another library request');
      } finally { await page.close(); }
    });
    for (const destination of ['comic', 'route', 'view']) await run(`library filter controls: detached controls cannot change a new ${destination}`, async () => {
      const page = await newPage();
      try {
        await openTarget(page, {});
        await page.evaluate(() => { fixture.oldLibraryForm = document.querySelector('.manga-library-controls'); });
        if (destination === 'comic') {
          await openTarget(page, { mangaComicId: 'D' });
          await tick(page); // Settle the new detail's ResizeObserver before the ownership snapshot.
        }
        else if (destination === 'route') await page.evaluate(() => {
          fixture.page.applyRouteState({ mangaQuery: 'Comic D', mangaSort: 'chapters' });
          fixture.page.enter({ skipRoute: true, deferInitialLoad: true });
        });
        else await page.evaluate(() => { fixture.state.activeView = 'gallery'; document.querySelector('#workGrid').innerHTML = '<p>New gallery surface</p>'; });
        const before = await page.evaluate(() => ({ activeView: fixture.state.activeView, comic: fixture.state.manga.comic?.id || '', query: fixture.state.manga.query,
          sort: fixture.state.manga.sort, add: fixture.state.manga.addOpen, html: document.querySelector('#workGrid').innerHTML, route: location.href }));
        await page.evaluate(() => {
          const form = fixture.oldLibraryForm; form.querySelector('input').value = 'obsolete draft'; form.querySelector('select').value = 'title';
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          form.querySelector('select').dispatchEvent(new Event('change', { bubbles: true }));
          form.querySelector('[data-action="add"]').click();
        });
        assert.deepEqual(await page.evaluate(() => ({ activeView: fixture.state.activeView, comic: fixture.state.manga.comic?.id || '', query: fixture.state.manga.query,
          sort: fixture.state.manga.sort, add: fixture.state.manga.addOpen, html: document.querySelector('#workGrid').innerHTML, route: location.href })), before,
          'retired library controls must not alter a newer view, comic, route or its accepted filter state');
      } finally { await page.close(); }
    });
    await run('reader chapter navigation: completed update unlocks a newly downloaded next chapter', async () => {
      const page = await newPage();
      const update = hold((url, req) => req.method === 'POST' && url.pathname === '/api/manga/C/update');
      try {
        await openTarget(page, { mangaComicId: 'C' });
        await page.locator('[data-action="update"]').click(); await requested(update);
        await openTarget(page, { mangaComicId: 'C', mangaChapterIndex: '2' }); await readerTitle(page, 'Comic C', 'Chapter 2');
        assert.equal(await page.locator('.manga-reader-bar [data-action="next"]').isDisabled(), true);
        const before = await rememberReader(page);
        await page.locator('.manga-reader [data-action="fit"]').focus();
        await page.evaluate(() => { fixture.navImages = [...document.querySelectorAll('.manga-reader-pages img')]; fixture.navFit = document.activeElement; __fitCreated.total = __fitCreated.images = 0; });
        const next = { index: 3, title: 'Chapter 3', status: 'done', imageCount: 3, downloadedCount: 3 };
        comicSnapshots.set('C', { ...comic('C'), chapterCount: 3, doneChapterCount: 3, chapters: [...comic('C').chapters, next] });
        await settle(page, update);
        await page.waitForFunction(() => fixture.state.manga.comic?.chapters.length === 3 && fixture.state.manga.updates.C?.status === 'complete');
        await tick(page);
        await assertReaderPreserved(page, before);
        assert.equal(await page.evaluate(() => fixture.navImages.every((image, index) => image === document.querySelectorAll('.manga-reader-pages img')[index]) && document.activeElement === fixture.navFit), true);
        assert.deepEqual(await page.evaluate(() => __fitCreated), { total: 0, images: 0 }, 'background directory completion must update controls without constructing any reader nodes');
        assert.equal(await page.locator('.manga-reader-bar [data-action="next"]').isEnabled(), true,
          'completed downloads must make the next chapter reachable without leaving the current reader');
        await page.locator('.manga-reader-bar [data-action="next"]').click();
        assert.equal(await page.evaluate(() => __transport.started.includes('/api/manga/C/chapters/3')), true,
          'enabled next action must resolve the new directory target rather than its old captured neighbor');
        await readerTitle(page, 'Comic C', 'Chapter 3');
        assert.equal(await page.locator('.manga-reader-footer [data-action="next"]').isDisabled(), true);
        await page.locator('.manga-reader-footer [data-action="previous"]').click(); await readerTitle(page, 'Comic C', 'Chapter 2');
      } finally { update.release(); comicSnapshots.clear(); await page.close(); }
    });
    await run('reader chapter navigation: unfinished neighbor stays unavailable without skipping the story', async () => {
      const page = await newPage();
      const update = hold((url, req) => req.method === 'POST' && url.pathname === '/api/manga/C/update');
      try {
        await openTarget(page, { mangaComicId: 'C' });
        await page.locator('[data-action="update"]').click(); await requested(update);
        await openTarget(page, { mangaComicId: 'C', mangaChapterIndex: '1' }); await readerTitle(page, 'Comic C', 'Chapter 1');
        const before = await rememberReader(page);
        comicSnapshots.set('C', { ...comic('C'), chapters: [comic('C').chapters[0], { index: 2, title: 'Chapter 2', status: 'pending', downloadedCount: 0 },
          { index: 3, title: 'Chapter 3', status: 'done', downloadedCount: 3, imageCount: 3 }] });
        await settle(page, update);
        await page.waitForFunction(() => fixture.state.manga.comic?.chapters.length === 3);
        await assertReaderPreserved(page, before);
        const reads = await page.evaluate(() => __transport.started.filter(path => path.startsWith('/api/manga/C/chapters/')).length);
        for (const place of ['bar', 'footer']) {
          const next = page.locator(`.manga-reader-${place} [data-action="next"]`);
          assert.equal(await next.isDisabled(), true, 'an unfinished immediate neighbor must not be enabled or skipped');
          assert.match(await next.getAttribute('title'), /尚未下载完成/);
          await next.evaluate(button => button.click());
        }
        assert.equal(await page.evaluate(() => __transport.started.filter(path => path.startsWith('/api/manga/C/chapters/')).length), reads);
        assert.equal(await progress(page, 'C'), 1);
      } finally { update.release(); comicSnapshots.clear(); await page.close(); }
    });
    for (const destination of ['new comic', 'new chapter']) await run(`reader chapter navigation: late updated directory preserves ${destination}`, async () => {
      const page = await newPage();
      const update = hold((url, req) => req.method === 'POST' && url.pathname === '/api/manga/C/update');
      let detail, library;
      try {
        await openTarget(page, { mangaComicId: 'C' });
        await page.locator('[data-action="update"]').click(); await requested(update);
        await openTarget(page, { mangaComicId: 'C', mangaChapterIndex: '1' }); await readerTitle(page, 'Comic C', 'Chapter 1');
        detail = hold((url, req) => req.method === 'GET' && url.pathname === '/api/manga/C');
        library = hold(url => url.pathname === '/api/manga');
        await settle(page, update); await requested(detail); await requested(library);
        const comicId = destination === 'new comic' ? 'D' : 'C';
        if (comicId === 'D') await openTarget(page, { mangaComicId: 'D', mangaChapterIndex: '2' });
        else { await page.locator('.manga-reader-bar [data-action="next"]').click(); }
        await readerTitle(page, `Comic ${comicId}`, 'Chapter 2');
        const before = await rememberReader(page);
        await page.evaluate(() => { fixture.oldNavButtons = [...document.querySelectorAll('.manga-reader [data-action="previous"], .manga-reader [data-action="next"]')]; });
        comicSnapshots.set('C', { ...comic('C'), chapters: [...comic('C').chapters, { index: 3, title: 'Chapter 3', status: 'done', downloadedCount: 3 }] });
        await settle(page, detail); await settle(page, library);
        await assertReaderPreserved(page, before);
        assert.equal(await page.evaluate(() => fixture.oldNavButtons.every((button, index) => button === document.querySelectorAll('.manga-reader [data-action="previous"], .manga-reader [data-action="next"]')[index])), true);
        assert.equal(await page.locator('.manga-reader-bar [data-action="next"]').isDisabled(), true, 'an obsolete directory response cannot attach its new neighbor to another reader owner');
      } finally { update.release(); detail?.release(); library?.release(); comicSnapshots.clear(); await page.close(); }
    });
    for (const ignoreAbort of [true, false]) {
      const transport = ignoreAbort ? "ignore-abort" : "normal";
      await run(`chapter read feedback: a live middle reader survives repeated failure and native retry ${transport}`, async () => {
        readerImageCount = 300;
        readerImageDimensions = { width: 800, height: 1400 };
        const page = await newPage({ real: true, ignoreAbort, route: '/manga/C/read/1' });
        const match = url => url.pathname === '/api/manga/C/chapters/2';
        const first = hold(match, 'Synthetic next chapter unavailable'), gates = [first];
        try {
          await prepareFitReadingAnchor(page, 49, .4);
          const next = page.locator('.manga-reader-bar [data-action="next"]');
          await next.focus(); await snapshotChapterSurface(page, '.manga-reader', next);
          const reads = countRequests(match), initialProgress = await progress(page, 'C');
          await next.press('Enter'); await requested(first); await tick(page);
          await assertChapterSurface(page, { focus: true, scroll: true });
          await assertChapterFeedback(page, { pending: true, chapter: 2 });
          assert.equal(await next.evaluate(button => button.disabled), false, 'pending chapter navigation must retain native focus rather than disable its live control');
          assert.equal(await next.getAttribute('aria-busy'), 'true');
          await page.keyboard.press('Space'); await page.keyboard.press('Enter'); await tick(page);
          assert.equal(countRequests(match), reads + 1, 'repeated native activation of the pending chapter must share its one request');
          const scroll = await page.evaluate(() => scrollY);
          await page.mouse.move(700, 400); await page.mouse.wheel(0, 420);
          await page.waitForFunction(before => Math.abs(scrollY - before) > 100, scroll, { timeout: 5000 });
          const moved = await page.evaluate(() => { dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); return { scroll: scrollY, saved: JSON.parse(localStorage.getItem('fanhao.manga.positions') || '{}').C }; });
          assert(moved.saved?.chapter === 1 && moved.saved.page >= 49, 'reading while the next chapter waits must continue recording the visible source chapter position');
          await settle(page, first);
          await assertChapterSurface(page, { focus: true });
          assert.equal(await page.evaluate(() => scrollY), moved.scroll, 'a failed next chapter must not replay the source reader old saved position over newer scrolling');
          await assertChapterFeedback(page, { cause: first.error, chapter: 2 });
          assert.equal(await progress(page, 'C'), initialProgress, 'failed chapter reads must not advance the saved chapter identity');
          const retry = page.locator('[data-action="retry-chapter"]');
          await assertChapterControlHit(retry);
          const second = hold(match, 'Synthetic repeated chapter failure'); gates.push(second);
          await retry.focus(); await retry.press('Space'); await requested(second);
          await assertChapterFeedback(page, { pending: true, chapter: 2 });
          await page.keyboard.press('Enter'); await page.keyboard.press('Space'); await tick(page);
          assert.equal(countRequests(match), reads + 2, 'repeated native retry activation must not enqueue duplicate chapter reads');
          await settle(page, second); await assertChapterFeedback(page, { cause: second.error, chapter: 2 });
          await assertChapterSurface(page);
          const beforeWheel = await page.evaluate(() => scrollY);
          await page.mouse.move(700, 400); await page.mouse.wheel(0, 380);
          await page.waitForFunction(before => Math.abs(scrollY - before) > 100, beforeWheel, { timeout: 5000 });
          const persisted = await page.evaluate(() => {
            dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
            const figures = [...document.querySelectorAll('.manga-reader-image')], index = figures.findIndex(figure => figure.getBoundingClientRect().bottom > 0), rect = figures[index].getBoundingClientRect();
            return { expected: { chapter: 1, page: index, ratio: Math.round(Math.max(0, Math.min(1, -rect.top / rect.height)) * 1e6) / 1e6, atStart: scrollY < 1 || index === 0 && rect.top > 0 }, actual: JSON.parse(localStorage.getItem('fanhao.manga.positions') || '{}').C };
          });
          assert.deepEqual(persisted.actual, persisted.expected, 'after a chapter failure the original live reader must still save its actual current page and ratio');
          const success = hold(match); gates.push(success);
          await retry.focus(); await retry.press('Enter'); await requested(success); await assertChapterSurface(page);
          await settle(page, success); await readerTitle(page, 'Comic C', 'Chapter 2');
          assert.equal(await progress(page, 'C'), 2);
          assert.equal(await page.locator('.manga-chapter-feedback').count(), 0, 'successful retry must retire its previous error and waiting feedback');
          assert.equal(new URL(page.url()).pathname, '/manga/C/read/2');
        } finally { for (const gate of gates) { gate.release(); held.delete(gate); } await page.close(); readerImageCount = 3; readerImageDimensions = null; }
      });
      await run(`chapter read feedback: a narrow long directory retains drafts and exposes a real retry ${transport}`, async () => {
        comicSnapshots.set('C', catalogComic('C'));
        const page = await newPage({ real: true, ignoreAbort, route: '/manga/C' });
        const match = url => url.pathname === '/api/manga/C/chapters/777';
        const failed = hold(match, 'Synthetic deep chapter unavailable'), gates = [failed];
        try {
          await page.setViewportSize({ width: 320, height: 740 }); await detailTitle(page, 'Comic C'); await tick(page);
          const input = page.locator('.manga-directory-search-input');
          await input.fill('  Chapter  '); await input.evaluate(node => node.setSelectionRange(2, 7));
          const target = page.locator('.manga-chapter-row[data-chapter-index="777"] button');
          await target.scrollIntoViewIfNeeded(); await target.focus(); await snapshotChapterSurface(page, '.manga-detail', target);
          const reads = countRequests(match);
          await target.press('Enter'); await requested(failed); await tick(page);
          await assertChapterSurface(page, { focus: true, scroll: true });
          await assertChapterFeedback(page, { pending: true, chapter: 777 });
          assert.deepEqual(await input.evaluate(node => [node.value, node.selectionStart, node.selectionEnd]), ['  Chapter  ', 2, 7], 'pending chapter reads must keep the original directory draft and native input range');
          await input.focus(); await input.fill('  Chapter 777  '); await input.evaluate(node => node.setSelectionRange(2, 7));
          const selected = await page.evaluate(() => ({ scroll: scrollY }));
          await settle(page, failed); await assertChapterSurface(page);
          await assertChapterFeedback(page, { cause: failed.error, chapter: 777 });
          assert.deepEqual(await input.evaluate(node => [node.value, node.selectionStart, node.selectionEnd, node === document.activeElement]), ['  Chapter 777  ', 2, 7, true], 'chapter failure must not replace, blur or reset a newer directory search input');
          assert.equal(await page.evaluate(() => scrollY), selected.scroll);
          const retry = page.locator('[data-action="retry-chapter"]'); await assertChapterControlHit(retry);
          const current = hold(match); gates.push(current);
          await retry.focus(); await retry.press('Enter'); await requested(current);
          await page.keyboard.press('Space'); await page.keyboard.press('Enter'); await tick(page);
          assert.equal(countRequests(match), reads + 2, 'a pending deep-directory retry must remain single flight under native keyboard activation');
          await assertChapterSurface(page); await settle(page, current); await readerTitle(page, 'Comic C', 'Chapter 777');
          assert.equal(await progress(page, 'C'), 777); assert.equal(new URL(page.url()).pathname, '/manga/C/read/777');
        } finally { for (const gate of gates) { gate.release(); held.delete(gate); } comicSnapshots.delete('C'); await page.close(); }
      });
      for (const error of ["", "old manga error"]) {
        const result = error ? "error" : "success";
        for (const navigation of ["detail", "list", "back"]) await run(`host initial C held to ${navigation} ${result} ${transport}`, async () => {
          const old = hold(url => url.pathname === "/api/manga/C", error);
          const endpoint = navigation === "detail" ? "/api/manga/D" : "/api/manga";
          const next = hold(url => url.pathname === endpoint);
          const page = await newPage({ real: true, ignoreAbort, route: "/manga/C", waitReady: false, initialBack: navigation === "back" });
          try {
            await requested(old); const token = await page.evaluate(() => __documentToken);
            if (navigation === "back") await page.goBack({ waitUntil: "commit" });
            else await navigateRoute(page, navigation === "detail" ? "/manga/D" : "/manga");
            await requested(next, 2000); // New history intent must start before old C is released.
            await settle(page, next); await ready(page);
            if (navigation === "detail") await detailTitle(page, "Comic D"); else await page.locator(".manga-card").first().waitFor();
            assert.equal(await page.evaluate(() => __documentToken), token, "history must stay in the initial document");
            await finishOld(page, old, ignoreAbort);
            assert.equal(new URL(page.url()).pathname, navigation === "detail" ? "/manga/D" : "/manga");
            assert.equal(await page.locator(navigation === "detail" ? ".manga-detail" : ".manga-library").count(), 1);
            if (navigation === "detail") assert.equal(await page.locator(".manga-detail h1").textContent(), "Comic D", "old C must not replace the latest detail");
            assert(!(await page.locator("#workGrid").textContent()).includes("old manga error"));
            assert(await page.evaluate(() => __transport.aborted.includes("/api/manga/C")), "new route must abort old C even with ignored AbortSignal");
          } finally { await page.close(); }
        });

        await run(`rapid comic owner and finally ${result} ${transport}`, async () => {
          const page = await newPage({ ignoreAbort });
          try {
            const old = hold(url => url.pathname === "/api/manga/C", error); await launch(page, { mangaComicId: "C" }); await requested(old);
            const current = hold(url => url.pathname === "/api/manga/D"); await launch(page, { mangaComicId: "D" }); await requested(current);
            await finishOld(page, old, ignoreAbort);
            assert.deepEqual(await stateSnapshot(page), { comic: null, chapter: null, loading: true, status: "正在读取作品资料和目录" }, "old error/finally must not clear D loading owner");
            await settle(page, current); await detailTitle(page, "Comic D");
            assert.deepEqual(await stateSnapshot(page), { comic: "D", chapter: null, loading: false, status: "" });
          } finally { await page.close(); }
        });

        await run(`rapid chapter owner and finally ${result} ${transport}`, async () => {
          const page = await newPage({ ignoreAbort });
          try {
            await openTarget(page, { mangaComicId: "C" });
            const old = hold(url => url.pathname === "/api/manga/C/chapters/1", error); await clickChapter(page, 1); await requested(old);
            const current = hold(url => url.pathname === "/api/manga/C/chapters/2"); await clickChapter(page, 2); await requested(current);
            await finishOld(page, old, ignoreAbort);
            assert.deepEqual(await stateSnapshot(page), { comic: "C", chapter: null, loading: true, status: "正在读取章节" }, "old chapter error/finally must not clear chapter 2 owner");
            assert.equal(await progress(page, "C"), null, "superseded chapter must not persist progress");
            await settle(page, current); await readerTitle(page, "Comic C", "Chapter 2"); assert.equal(await progress(page, "C"), 2);
          } finally { await page.close(); }
        });

        await run(`cross comic old chapter ${result} ${transport}`, async () => {
          const page = await newPage({ ignoreAbort });
          try {
            await openTarget(page, { mangaComicId: "C" });
            const old = hold(url => url.pathname === "/api/manga/C/chapters/1", error); await clickChapter(page, 1); await requested(old);
            await openTarget(page, { mangaComicId: "D", mangaChapterIndex: "2" }); await readerTitle(page, "Comic D", "Chapter 2");
            const before = await rememberReader(page); await finishOld(page, old, ignoreAbort); await assertReaderPreserved(page, before);
            assert.equal(await progress(page, "C"), null); assert.equal(await progress(page, "D"), 2);
            assert.deepEqual(await stateSnapshot(page), { comic: "D", chapter: 2, loading: false, status: "" });
          } finally { await page.close(); }
        });

        await run(`host reader return directory late chapter ${result} ${transport}`, async () => {
          const page = await newPage({ real: true, ignoreAbort, route: "/manga/C/read/1" });
          try {
            const old = hold(url => url.pathname === "/api/manga/C/chapters/2", error);
            await page.locator('.manga-reader-bar [data-action="next"]').click(); await requested(old);
            await page.locator('.manga-reader-bar [data-action="detail"]').click(); await detailTitle(page, "Comic C");
            assert.equal(new URL(page.url()).pathname, "/manga/C"); await finishOld(page, old, ignoreAbort);
            assert.equal(await page.locator(".manga-reader").count(), 0); assert.equal(new URL(page.url()).pathname, "/manga/C");
            assert.equal(await progress(page, "C"), 1, "returning to directory must not save the superseded chapter");
            assert.equal(await page.locator('.manga-chapter-feedback').count(), 0, 'returning to the directory must retire old chapter feedback as well as its request');
          } finally { await page.close(); }
        });

        await run(`background library preserves reader ${result} ${transport}`, async () => {
          const page = await newPage({ ignoreAbort });
          try {
            const old = hold(url => url.pathname === "/api/manga", error);
            await page.evaluate(() => { fixture.state.manga.data = null; fixture.page.enter({ skipRoute: true }); }); await requested(old);
            await openTarget(page, { mangaComicId: "D", mangaChapterIndex: "2" }); await readerTitle(page, "Comic D", "Chapter 2");
            const before = await rememberReader(page); await finishOld(page, old, ignoreAbort); await assertReaderPreserved(page, before);
            assert.equal(await progress(page, "D"), 2);
            assert.deepEqual(await stateSnapshot(page), { comic: "D", chapter: 2, loading: false, status: "" });
          } finally { await page.close(); }
        });
      }

      await run(`late comic must not chain chapter ${transport}`, async () => {
        const page = await newPage({ ignoreAbort });
        try {
          const old = hold(url => url.pathname === "/api/manga/C"); const before = countRequests(url => url.pathname === "/api/manga/C/chapters/1");
          await launch(page, { mangaComicId: "C", mangaChapterIndex: "1" }); await requested(old);
          await openTarget(page, { mangaComicId: "D", mangaChapterIndex: "2" }); await readerTitle(page, "Comic D", "Chapter 2");
          await finishOld(page, old, ignoreAbort);
          assert.equal(countRequests(url => url.pathname === "/api/manga/C/chapters/1"), before, "superseded comic success must not launch its old chapter continuation");
          assert.deepEqual(await stateSnapshot(page), { comic: "D", chapter: 2, loading: false, status: "" }); assert.equal(await progress(page, "C"), null);
        } finally { await page.close(); }
      });

      await run(`host chapter popstate retains newest ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: "/manga/C/read/1" });
        try {
          const old = hold(url => url.pathname === "/api/manga/C/chapters/1", "old manga error");
          await navigateRoute(page, "/manga/C/read/1"); await requested(old);
          const current = hold(url => url.pathname === "/api/manga/C/chapters/2"); await navigateRoute(page, "/manga/C/read/2"); await requested(current, 2000);
          await finishOld(page, old, ignoreAbort); await settle(page, current); await readerTitle(page, "Comic C", "Chapter 2");
          assert.equal(new URL(page.url()).pathname, "/manga/C/read/2"); assert.equal(await progress(page, "C"), 2);
          await page.goBack({ waitUntil: "commit" }); await readerTitle(page, "Comic C", "Chapter 1"); assert.equal(new URL(page.url()).pathname, "/manga/C/read/1");
        } finally { await page.close(); }
      });

      for (const error of ["", "old background error"]) {
        const result = error ? "error" : "success";
        await run(`reader catalog background refresh ${result} ${transport}`, async () => {
          const page = await newPage({ ignoreAbort });
          try {
            await openTarget(page, { mangaComicId: "D", mangaChapterIndex: "2" }); await readerTitle(page, "Comic D", "Chapter 2");
            const background = hold(url => url.pathname === "/api/manga", error);
            await page.evaluate(() => { fixture.state.manga.data = null; fixture.page.enter({ skipRoute: true }); }); await requested(background);
            const before = await rememberReader(page); await settle(page, background); await assertReaderPreserved(page, before);
            assert.deepEqual(await stateSnapshot(page), { comic: "D", chapter: 2, loading: false, status: "" });
          } finally { await page.close(); }
        });

        await run(`update completion preserves mounted reader ${result} ${transport}`, async () => {
          const page = await newPage({ ignoreAbort });
          try {
            await openTarget(page, { mangaComicId: "C" });
            const update = hold((url, req) => req.method === "POST" && url.pathname === "/api/manga/C/update", error);
            await page.locator('[data-action="update"]').evaluate(button => button.click()); await requested(update);
            await openTarget(page, { mangaComicId: "C", mangaChapterIndex: "2" }); await readerTitle(page, "Comic C", "Chapter 2");
            const detail = error ? null : hold((url, req) => req.method === "GET" && url.pathname === "/api/manga/C");
            const library = error ? null : hold(url => url.pathname === "/api/manga");
            const before = await rememberReader(page); await settle(page, update);
            if (!error) { await requested(detail); await requested(library); await settle(page, detail); await settle(page, library); }
            await assertReaderPreserved(page, before); assert.deepEqual(await stateSnapshot(page), { comic: "C", chapter: 2, loading: false, status: "" });
          } finally { await page.close(); }
        });

        await run(`late delete C preserves D reader ${result} ${transport}`, async () => {
          const page = await newPage({ ignoreAbort });
          try {
            await openTarget(page, { mangaComicId: "C" });
            const deletion = hold((url, req) => req.method === "DELETE" && url.pathname === "/api/manga/C", error);
            await page.locator('[data-action="delete"]').evaluate(button => button.click()); await requested(deletion);
            await openTarget(page, { mangaComicId: "D", mangaChapterIndex: "2" }); await readerTitle(page, "Comic D", "Chapter 2");
            const before = await rememberReader(page); await settle(page, deletion); await assertReaderPreserved(page, before);
            assert.deepEqual(await stateSnapshot(page), { comic: "D", chapter: 2, loading: false, status: "" });
            assert.equal(await page.evaluate(() => fixture.state.manga.deletingComicId), "");
            if (!error) assert.equal(await page.evaluate(() => fixture.state.manga.data.comics.some(comic => comic.id === "C")), false, "simulated deletion must still remove C from cached library");
          } finally { await page.close(); }
        });
      }

      await run(`delete filters held current library without losing D ${transport}`, async () => {
        const page = await newPage({ real: true, ignoreAbort, route: "/manga/C" });
        try {
          const deletion = hold((url, req) => req.method === "DELETE" && url.pathname === "/api/manga/C");
          await page.locator('[data-action="delete"]').evaluate(button => button.click()); await requested(deletion);
          const library = hold(url => url.pathname === "/api/manga"); await navigateRoute(page, "/manga"); await requested(library);
          await settle(page, deletion); await settle(page, library); await page.locator(".manga-card").first().waitFor();
          assert.equal(new URL(page.url()).pathname, "/manga");
          assert.deepEqual(await page.locator(".manga-card-body strong").allTextContents(), ["Comic D"], "current C+D list response must retain D while filtering the completed C deletion");
          assert.equal(await page.locator(".manga-status").count(), 0, "current library finally must release its loading status");
          assert.equal(await page.locator(".manga-detail").count(), 0);
        } finally { await page.close(); }
      });
    }
    await verifyImageRetry();
    await verifyImageDimensions();
    await verifyFitRendering();
    await verifyFitReadingPosition();
    assert(checks > 0, `no manga fixture cases matched: ${casePattern}`);
    assert.deepEqual(faults, [], "private Chromium must not hide page errors");
    assert.deepEqual(unexpected, [], "private fixture must not access unmodelled APIs or files");
    console.log(`Manga reader fixture passed (${checks} cases; private Chromium, actual manga host and synthetic responses)`);
    return { checks };
  } finally {
    for (const gate of held) gate.release();
    if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }

  function countRequests(match) { return [...requests].filter(([url]) => match(new URL(url, base))).reduce((sum, [, count]) => sum + count, 0); }
  async function startLibraryCardPolling(page, tag) {
    addJobResponse = { id: `synthetic-shelf-${tag}`, status: 'running', message: `${tag} polling started`, progressPercent: 10, comicId: 'SyntheticIncoming', totalChapters: 2 };
    const poll = hold(url => url.pathname === `/api/manga/jobs/synthetic-shelf-${tag}`);
    await page.locator('.manga-library-controls [data-action="add"]').click(); await page.locator('.manga-add-panel input').fill(`https://example.invalid/shelf/${tag}`);
    await page.locator('.manga-add-panel button[type="submit"]').click();
    await page.waitForFunction(message => document.querySelector('.manga-job-progress strong')?.textContent === message, addJobResponse.message);
    return { poll };
  }
  async function publishLibraryCardPoll(page, poll, message) {
    await requested(poll); const library = hold(url => url.pathname === '/api/manga');
    addJobResponse = { ...addJobResponse, message, progressPercent: 20 };
    try { await settle(page, poll); await requested(library); await settle(page, library);
      await page.waitForFunction(message => document.querySelector('.manga-job-progress strong')?.textContent === message, message); await tick(page);
    } finally { library.release(); }
  }
  async function verifyImageRetry() {
    for (const [outcome, shape] of [["success", "page"], ["failure", "page"], ["success", "short banner"]]) await run(`image retry ${shape} ${outcome} retains chapter, other pages and reading context`, async () => {
      readerImageDimensions = shape === "short banner" ? { width: 1600, height: 100 } : { width: 800, height: 1400 };
      readerImageIntrinsic = readerImageDimensions;
      const match = url => url.pathname === "/synthetic/C/1/1.svg";
      const initialReads = countRequests(match);
      const failed = hold(match, "Synthetic image failure");
      const page = await newPage({ real: true, route: "/manga/C/read/1", waitReady: false });
      try {
        await requested(failed); failed.release(); await readerTitle(page, "Comic C", "Chapter 1"); await ready(page);
        const figure = page.locator(".manga-reader-image").first();
        const retry = page.getByRole("button", { name: "重试第 1 页", exact: true });
        await retry.waitFor({ state: "visible" });
        if (shape === "short banner") {
          assert.equal(await figure.evaluate(node => node.getBoundingClientRect().height), 67.5, "known short images must retain declared ratio while failed");
          assert.equal(await retry.evaluate(button => Boolean(button.closest(".manga-reader-recovery")) && button.getBoundingClientRect().height >= 44), true);
          await page.setViewportSize({ width: 320, height: 740 }); await tick(page);
          const narrow = await retry.evaluate(button => {
            const target = button.getBoundingClientRect(), parent = document.querySelector(".manga-reader-image").getBoundingClientRect();
            const hit = document.elementFromPoint(target.left + target.width / 2, target.top + target.height / 2);
            return { width: parent.width, height: parent.height, targetHeight: target.height, reachable: hit === button, hit: hit?.className, top: target.top, bottom: target.bottom };
          });
          assert(Math.abs(narrow.height / narrow.width - 100 / 1600) < .001 && narrow.targetHeight >= 44 && narrow.reachable,
            `a short image's narrow-screen retry overlay must remain reachable without inflating the image row: ${JSON.stringify(narrow)}`);
        }
        await page.locator(".manga-reader-pages img").nth(1).evaluate(image => image.decode());
        await page.evaluate(() => {
          window.__retryReader = document.querySelector(".manga-reader");
          window.__retryImages = [...document.querySelectorAll(".manga-reader-pages img")];
          window.scrollTo(0, 80);
        }); await tick(page);
        const before = await imageRetrySnapshot(page), reads = countRequests(url => url.pathname.startsWith("/api/manga"));
        const otherReads = countRequests(url => /^\/synthetic\/C\/1\//.test(url.pathname) && !match(url));
        const retryButton = page.locator(".manga-reader-image-error button").first();
        const retryRead = hold(match, outcome === "failure" ? "Synthetic image retry failure" : "");
        try {
          await retry.focus(); await page.keyboard.press("Enter"); await requested(retryRead);
          assert.equal(await figure.getAttribute("aria-busy"), "true");
          assert.equal(await retryButton.isDisabled(), true);
          await page.evaluate(() => document.querySelector(".manga-reader-image-error button").dispatchEvent(new MouseEvent("click")));
          assert.equal(countRequests(match) - initialReads, 2, "repeated retry clicks must share the pending image request");
          assert.equal(await page.evaluate(compact => document.activeElement.matches(compact ? ".manga-reader-recovery .manga-reader-image-error" : ".manga-reader-image"), shape === "short banner"), true,
            "retry must retain a focusable reading context while the button is disabled");
          retryRead.release();
          if (outcome === "success") {
            await figure.locator("img").evaluate(image => image.decode());
            assert.equal(await retryButton.isVisible(), false);
          } else {
            await retry.waitFor({ state: "visible" });
            await page.waitForFunction(() => !document.querySelector(".manga-reader-image-error button").disabled);
            assert.match(await page.locator(".manga-reader-image-error").first().textContent(), /第 1 页加载失败/);
            await retry.focus(); await page.keyboard.press("Enter");
            await figure.locator("img").evaluate(image => image.decode());
            assert.equal(countRequests(match) - initialReads, 3, "a failed retry must allow another explicit attempt");
          }
          assert.equal(await figure.getAttribute("aria-busy"), null);
          assert.deepEqual(await imageRetrySnapshot(page), before, "single-page recovery must retain mounted images, route, width, progress, scroll and geometry");
          assert.equal(countRequests(url => url.pathname.startsWith("/api/manga")), reads, "retry must not reload chapter metadata");
          assert.equal(countRequests(url => /^\/synthetic\/C\/1\//.test(url.pathname) && !match(url)), otherReads, "retry must not reload any other page");
        } finally { retryRead.release(); }
      } finally { failed.release(); await page.close(); readerImageDimensions = null; readerImageIntrinsic = { width: 800, height: 1400 }; }
    });
    for (const target of ["next chapter", "new comic", "directory"]) await run(`image retry ignores old controls and response after ${target}`, async () => {
      readerImageDimensions = { width: 800, height: 1400 };
      const match = url => url.pathname === "/synthetic/C/1/1.svg";
      const failed = hold(match, "Synthetic image failure");
      const page = await newPage({ real: true, route: "/manga/C/read/1", waitReady: false });
      const retryRead = hold(match);
      try {
        await requested(failed); failed.release(); await readerTitle(page, "Comic C", "Chapter 1"); await ready(page);
        await page.getByRole("button", { name: "重试第 1 页", exact: true }).waitFor();
        await page.evaluate(() => {
          window.__oldRetryImage = document.querySelector(".manga-reader-image img");
          window.__oldRetry = document.querySelector(".manga-reader-image-error button");
          __oldRetry.click();
        }); await requested(retryRead);
        await navigateRoute(page, target === "next chapter" ? "/manga/C/read/2" : target === "new comic" ? "/manga/D/read/2" : "/manga/C");
        if (target === "directory") await detailTitle(page, "Comic C");
        else await readerTitle(page, target === "new comic" ? "Comic D" : "Comic C", "Chapter 2");
        const before = await page.locator("#workGrid").innerHTML(), reads = countRequests(match), route = page.url();
        retryRead.release(); await page.waitForFunction(() => __oldRetryImage.complete); await tick(page);
        await page.evaluate(() => {
          const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
          window.__oldSourceWrites = 0;
          Object.defineProperty(__oldRetryImage, "src", {
            get() { return descriptor.get.call(this); },
            set(value) { __oldSourceWrites++; descriptor.set.call(this, value); }
          });
          __oldRetryImage.dispatchEvent(new Event("load"));
          __oldRetryImage.dispatchEvent(new Event("error"));
          __oldRetry.dispatchEvent(new MouseEvent("click"));
        }); await tick(page);
        assert.equal(await page.evaluate(() => __oldSourceWrites), 0, "detached retry controls must not replace an old image source");
        assert.equal(countRequests(match), reads, "detached retry controls cannot start another old image request");
        assert.equal(page.url(), route);
        assert.equal(await page.locator("#workGrid").innerHTML(), before, "obsolete image callbacks cannot update the current page");
      } finally { failed.release(); retryRead.release(); await page.close(); readerImageDimensions = null; }
    });
    await run("image retry is reachable without size metadata on a narrow reader", async () => {
      const match = url => url.pathname === "/synthetic/C/1/1.svg";
      const failed = hold(match, "Synthetic image failure");
      const page = await newPage({ real: true, route: "/manga/C/read/1", waitReady: false });
      try {
        await requested(failed); failed.release(); await readerTitle(page, "Comic C", "Chapter 1"); await ready(page);
        await page.setViewportSize({ width: 320, height: 740 });
        const retry = page.getByRole("button", { name: "重试第 1 页", exact: true });
        await retry.waitFor();
        assert.equal(await retry.evaluate(node => {
          const figure = node.closest("figure").getBoundingClientRect(), button = node.getBoundingClientRect();
          return button.width >= 44 && button.height >= 44 && button.left >= figure.left && button.right <= figure.right && button.bottom <= figure.bottom;
        }), true, "failed unknown-size images must keep the retry target inside their visible placeholder");
        await retry.click(); await page.locator(".manga-reader-pages img").first().evaluate(image => image.decode());
        assert.equal(await retry.isVisible(), false);
      } finally { failed.release(); await page.close(); }
    });
    await run("image retry consecutive short failures keep every recovery action reachable", async () => {
      readerImageCount = 6;
      readerImageDimensions = { width: 1600, height: 100 };
      readerImageIntrinsic = readerImageDimensions;
      const match = url => /^\/synthetic\/C\/1\//.test(url.pathname), initialReads = countRequests(match);
      const failures = Array.from({ length: 6 }, (_, index) => hold(url => url.pathname === `/synthetic/C/1/${index + 1}.svg`, "Synthetic consecutive image failure"));
      const page = await newPage({ real: true, route: "/manga/C/read/1", waitReady: false });
      try {
        await requested(failures[0]); failures.forEach(gate => gate.release());
        await readerTitle(page, "Comic C", "Chapter 1"); await ready(page);
        await page.setViewportSize({ width: 320, height: 740 });
        await page.waitForFunction(() => document.querySelectorAll(".manga-reader-image.load-failed").length === 6);
        await tick(page);
        await page.evaluate(() => {
          window.__retryReader = document.querySelector(".manga-reader");
          window.__retryImages = [...document.querySelectorAll(".manga-reader-pages img")];
        });
        const before = await imageRetrySnapshot(page);
        for (let index = 0; index < 6; index++) {
          const retry = page.getByRole("button", { name: `重试第 ${index + 1} 页`, exact: true });
          await retry.scrollIntoViewIfNeeded();
          assert.equal(await retry.evaluate(button => {
            const bounds = button.getBoundingClientRect();
            return bounds.height >= 44 && document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2) === button;
          }), true, "each consecutive short failure must have a separate pointer-reachable retry target");
          await retry.click(); await page.locator(".manga-reader-pages img").nth(index).evaluate(image => image.decode());
          assert.deepEqual(await imageRetrySnapshot(page), before, "recovering short pages must not inflate rows or move neighbours");
        }
        assert.equal(await page.locator(".manga-reader-recovery").isVisible(), false, "the recovery area hides after the final failed page recovers");
        assert.equal(countRequests(match) - initialReads, 12, "six failures plus six explicit retries must issue twelve image reads");
      } finally {
        failures.forEach(gate => gate.release()); await page.close();
        readerImageCount = 3; readerImageDimensions = null; readerImageIntrinsic = { width: 800, height: 1400 };
      }
    });
    await run("image retry keyboard stays in compact recovery and returns to reading after completion", async () => {
      readerImageCount = 100;
      readerImageDimensions = { width: 1600, height: 100 };
      readerImageIntrinsic = readerImageDimensions;
      const imagePath = index => `/synthetic/C/1/${index}.svg`;
      const failures = Array.from({ length: 6 }, (_, index) => hold(url => url.pathname === imagePath(index + 1), "Synthetic image failure"));
      const page = await newPage({ real: true, route: "/manga/C/read/1", waitReady: false });
      let pending;
      try {
        await requested(failures[0]); failures.forEach(gate => gate.release());
        await readerTitle(page, "Comic C", "Chapter 1"); await ready(page);
        await page.setViewportSize({ width: 320, height: 740 });
        await page.waitForFunction(() => document.querySelectorAll(".manga-reader-image.load-failed").length === 6);
        await page.evaluate(() => scrollTo(0, 500)); await tick(page);
        const before = await page.evaluate(() => scrollY);
        assert(before > 0, "keyboard recovery must start away from the failed image rows");
        const retry = index => page.getByRole("button", { name: `重试第 ${index} 页`, exact: true });
        const focusedRetry = () => page.evaluate(() => document.activeElement.textContent);
        pending = hold(url => url.pathname === imagePath(2));
        await retry(2).focus(); await page.keyboard.press("Enter"); await requested(pending);
        assert.equal(await page.evaluate(() => document.activeElement.matches(".manga-reader-recovery .manga-reader-image-error")), true,
          "a pending compact retry must retain focus inside its recovery row");
        await page.keyboard.press("Tab"); assert.equal(await focusedRetry(), "重试第 3 页");
        await page.keyboard.press("Shift+Tab"); assert.equal(await focusedRetry(), "重试第 1 页");
        pending.release(); await page.locator(".manga-reader-pages img").nth(1).evaluate(image => image.decode());
        assert.equal(await focusedRetry(), "重试第 1 页", "a completed earlier retry must preserve later keyboard focus");
        assert.equal(await page.evaluate(() => scrollY), before, "Tab inside compact recovery must not jump to the page footer");
        pending = hold(url => url.pathname === imagePath(1), "Synthetic retry failure");
        await page.keyboard.press("Enter"); await requested(pending); pending.release();
        await page.waitForFunction(() => document.activeElement.matches(".manga-reader-recovery button") && document.activeElement.textContent === "重试第 1 页" && !document.activeElement.disabled);
        await page.keyboard.press("Tab"); assert.equal(await focusedRetry(), "重试第 3 页");
        await page.keyboard.press("Shift+Tab"); assert.equal(await focusedRetry(), "重试第 1 页");
        for (const index of [1, 3, 4, 5, 6]) {
          await page.keyboard.press("Enter"); await page.locator(".manga-reader-pages img").nth(index - 1).evaluate(image => image.decode());
          if (index !== 6) {
            assert.equal(await focusedRetry(), `重试第 ${index === 1 ? 3 : index + 1} 页`, "successful compact retry moves to the next available action");
            assert.equal(await page.evaluate(() => {
              const target = document.activeElement, box = target.getBoundingClientRect();
              return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === target;
            }), true, "the next focused action must be visible inside the recovery scroller");
          }
          assert.equal(await page.evaluate(() => scrollY), before, "recovery focus changes must not move the reading viewport");
        }
        assert.equal(await page.locator(".manga-reader-recovery").isVisible(), false);
        assert.equal(await page.evaluate(() => document.activeElement.matches(".manga-reader-pages")), true, "last recovery returns focus to the current reading region");
      } finally {
        failures.forEach(gate => gate.release()); pending?.release(); await page.close();
        readerImageCount = 3; readerImageDimensions = null; readerImageIntrinsic = { width: 800, height: 1400 };
      }
    });
  }
  async function imageRetrySnapshot(page) {
    return page.evaluate(() => ({
      reader: __retryReader === document.querySelector(".manga-reader"),
      images: __retryImages.every((image, index) => image === document.querySelectorAll(".manga-reader-pages img")[index]),
      route: location.pathname + location.search,
      progress: localStorage.getItem("fanhao.manga.progress"),
      width: document.querySelector(".manga-reader").className,
      scroll: scrollY,
      geometry: [...document.querySelectorAll(".manga-reader-image")].map(node => {
        const box = node.getBoundingClientRect(); return { top: box.top + scrollY, height: box.height };
      })
    }));
  }
  async function verifyImageDimensions() {
    for (const count of [300, 1000]) await run(`image dimensions ${count} pages reserve geometry and bound startup reads`, async () => {
      readerImageCount = count;
      readerImageDimensions = { width: 800, height: 1400 };
      let release;
      readerImageWait = new Promise(resolve => { release = resolve; });
      const before = countRequests(url => /^\/synthetic\/C\/1\//.test(url.pathname));
      const page = await newPage({ real: true, route: "/manga/C/read/1", waitReady: false });
      try {
        await readerTitle(page, "Comic C", "Chapter 1"); await ready(page); await tick(page);
        await until(() => countRequests(url => /^\/synthetic\/C\/1\//.test(url.pathname)) > before, "first reader images must start before releasing their response");
        await page.waitForTimeout(150); // Let native lazy admission run while no page can decode.
        const startup = countRequests(url => /^\/synthetic\/C\/1\//.test(url.pathname)) - before;
        assert(startup <= 6, `sized ${count}-page chapter must load at most 6 nearby images before decoding, read ${startup}`);
        const geometry = await page.evaluate(() => [...document.querySelectorAll(".manga-reader-pages img")].map(image => {
          const rect = image.getBoundingClientRect();
          return { top: rect.top + scrollY, width: rect.width, height: rect.height, complete: image.complete };
        }));
        assert.equal(geometry.length, count);
        assert.equal(await page.locator(".manga-reader-image-error").count(), 0, "normal long chapters must not allocate hidden retry controls");
        assert(geometry.every(image => image.width > 700 && Math.abs(image.height / image.width - 1.75) < .001), "all pages must reserve their actual aspect ratio before any image decodes");
        assert.equal(geometry[0].complete, false);
        release(); await fitImagesReady(page); await page.waitForLoadState("networkidle");
        const after = await page.evaluate(() => [...document.querySelectorAll(".manga-reader-pages img")].map(image => {
          const rect = image.getBoundingClientRect(); return { top: rect.top + scrollY, width: rect.width, height: rect.height };
        }));
        for (let index = 0; index < count; index++) {
          assert.equal(after[index].top, geometry[index].top, "initial decode must not move following pages");
          assert.equal(after[index].height, geometry[index].height);
        }
        const distant = page.locator(".manga-reader-pages img").nth(20);
        await distant.scrollIntoViewIfNeeded();
        await distant.evaluate(image => image.decode());
        assert.equal(await distant.evaluate(image => image.naturalWidth), 800, "scrolling admits distant pages normally");
        console.log(JSON.stringify({ mode: "manga-image-dimensions", pages: count, startupRequests: startup, reservedHeight: geometry[0].height, decodeShift: 0 }));
      } finally { release(); await page.close(); readerImageCount = 3; readerImageDimensions = null; readerImageWait = null; }
    });
    await run("image dimensions preserve unknown and invalid metadata fallback", async () => {
      readerImageCount = 6;
      readerImageDimensions = [{ width: "800", height: "1400" }, {}, { width: 0, height: 1400 }, { width: 800, height: -1 }, { width: "Infinity", height: 1400 }, { width: 800.5, height: 1400 }];
      const page = await newPage({ real: true, route: "/manga/C/read/1" });
      try {
        await readerTitle(page, "Comic C", "Chapter 1"); await fitImagesReady(page);
        const attributes = await page.locator(".manga-reader-pages img").evaluateAll(images => images.map(image => [image.getAttribute("width"), image.getAttribute("height")]));
        assert.deepEqual(attributes, [["800", "1400"], ...Array.from({ length: 5 }, () => [null, null])], "only complete positive integer dimensions may reserve geometry");
        for (const image of await page.locator(".manga-reader-pages img").all()) {
          await image.scrollIntoViewIfNeeded(); await image.evaluate(image => image.decode());
          assert.equal(await image.evaluate(image => image.naturalWidth), 800, "older metadata must retain natural image loading");
        }
        await page.locator('[data-action="fit"]').click();
        assert.equal(await page.locator(".manga-reader-pages img").first().evaluate(image => image.getBoundingClientRect().width), 800, "dimension hints retain original-width rendering");
      } finally { await page.close(); readerImageCount = 3; readerImageDimensions = null; }
    });
  }
  async function verifyFitReadingPosition() {
    const configure = () => { readerImageCount = 100; readerImageDimensions = { width: 800, height: 1400 }; readerImageIntrinsic = { width: 800, height: 1400 }; };
    const reset = () => { readerImageCount = 3; readerImageDimensions = null; readerImageIntrinsic = { width: 800, height: 1400 }; readerImageWait = null; };
    const imageReads = () => countRequests(url => /^\/synthetic\/C\/1\//.test(url.pathname));
    await run('fit position: desktop width changes preserve a middle page and distant lazy geometry', async () => {
      configure(); const farBefore = countRequests(url => url.pathname === '/synthetic/C/1/100.svg');
      const page = await newPage({ real: true, route: '/manga/C/read/1' }); let release;
      try {
        await prepareFitReadingAnchor(page, 49, .63);
        const before = await fitReadingAnchor(page); assert.equal(before.index, 49);
        const distant = await page.locator('.manga-reader-image img').nth(20).evaluate(image => ({ natural: image.naturalWidth, loading: image.loading }));
        assert.deepEqual(distant, { natural: 0, loading: 'lazy' }, 'the fit fixture must retain a genuinely unrequested middle-distance image');
        await snapshotFitReadingNodes(page);
        for (const fit of [false, true]) {
          readerImageWait = new Promise(resolve => { release = resolve; });
          const reads = imageReads(); await page.locator('.manga-reader [data-action="fit"]').click(); await tick(page);
          const reserved = await page.locator('.manga-reader-image img').nth(20).evaluate(image => { const r = image.getBoundingClientRect(); return { width: r.width, height: r.height, natural: image.naturalWidth }; });
          assert(reserved.width > 0 && reserved.height > 0, 'original-width known metadata must reserve a nonzero distant page before it decodes');
          await assertFitReadingAnchor(page, before);
          release(); await page.waitForLoadState('networkidle'); await assertFitReadingAnchor(page, before);
          const created = await assertFitReadingNodes(page);
          const addedReads = imageReads() - reads;
          assert(addedReads <= 16, `switching width must keep a local native lazy window instead of admitting the whole chapter, read ${addedReads}`);
          assert.equal(countRequests(url => url.pathname === '/synthetic/C/1/100.svg'), farBefore, 'changing a middle page width must not request the unexposed final page');
          assert.equal(await page.locator('.manga-reader').evaluate(reader => reader.classList.contains('fit-width')), fit);
          console.log('MANGA_FIT_POSITION', JSON.stringify({ fit, before, after: await fitReadingAnchor(page), reserved, addedReads, created }));
        }
      } finally { release?.(); await page.close(); reset(); }
    });
    await run('fit position: narrow native toggles retain the visible page and decode only exposed images', async () => {
      configure(); const page = await newPage({ real: true, route: '/manga/C/read/1' });
      try {
        await page.setViewportSize({ width: 320, height: 740 }); await prepareFitReadingAnchor(page, 49, .42);
        const before = await fitReadingAnchor(page);
        await page.locator('.manga-page-indicator').click();
        assert.equal(await page.locator('.manga-page-jump').isVisible(), true);
        await assertFitReadingAnchor(page, before); await snapshotFitReadingNodes(page);
        const fit = page.locator('.manga-reader [data-action="fit-floating"]');
        for (const [mode, action] of [[false, 'click'], [true, 'Enter'], [false, 'Space'], [true, 'Enter']]) {
          const reads = imageReads();
          const box = await fit.boundingBox(); assert(box && box.x >= -1 && box.x + box.width <= 321 && box.height >= 44, '320px floating width toggle must be fully reachable with a 44px hit target');
          assert.equal(await fit.evaluate(button => { const r = button.getBoundingClientRect(); return button.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); }), true);
          if (action === 'click') await fit.click(); else { await fit.focus(); await page.keyboard.press(action); }
          await tick(page); await assertFitReadingAnchor(page, before);
          await exposedFitImageDecoded(page, 49); await assertFitReadingAnchor(page, before); await assertFitReadingNodes(page);
          assert.equal(await fit.evaluate(button => document.activeElement === button), true);
          assert.equal(await page.locator('.manga-reader').evaluate(reader => reader.classList.contains('fit-width')), mode);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'original image width must pan inside the page area rather than overflow the document');
          assert.equal(await page.locator('.manga-page-jump').isVisible(), true, 'the expanded page jump must not hide or displace the mobile width action');
          assert(imageReads() - reads <= 16, 'mobile width changes must preserve the bounded native lazy loading window');
        }
      } finally { await page.close(); reset(); }
    });
    await run('fit position: mixed known page shapes remain stable across late image decode', async () => {
      configure(); readerImageDimensions = Array.from({ length: 100 }, (_, index) => index % 3 ? { width: 800, height: 1400 } : { width: 1200, height: 600 });
      readerImageIntrinsic = readerImageDimensions;
      const image = hold(url => url.pathname === '/synthetic/C/1/50.svg');
      const page = await newPage({ real: true, route: '/manga/C/read/1' });
      try {
        await fitImagesReady(page); await scrollFitReadingAnchor(page, 49, .55); await requested(image);
        assert.equal(await page.locator('.manga-reader-image img').nth(49).evaluate(image => image.naturalWidth), 0);
        const before = await fitReadingAnchor(page); await snapshotFitReadingNodes(page);
        await page.locator('.manga-reader [data-action="fit"]').click(); await tick(page);
        await assertFitReadingAnchor(page, before);
        const height = await page.locator('.manga-reader-image').nth(49).evaluate(figure => figure.getBoundingClientRect().height);
        image.release(); await exposedFitImageDecoded(page, 49); await tick(page);
        assert.equal(await page.locator('.manga-reader-image').nth(49).evaluate(figure => figure.getBoundingClientRect().height), height, 'matching metadata and natural dimensions must not shift the current page on decode');
        await assertFitReadingAnchor(page, before); await assertFitReadingNodes(page);
        await page.locator('.manga-reader [data-action="fit"]').click(); await tick(page); await assertFitReadingAnchor(page, before);
      } finally { image.release(); await page.close(); reset(); }
    });
    await run('fit position: newer wheel and focus intent retire deferred compensation', async () => {
      for (const intent of ['wheel', 'focus', 'pagehide', 'hidden']) {
        configure(); const page = await newPage({ real: true, route: '/manga/C/read/1' });
        try {
          await prepareFitReadingAnchor(page, 49, .63); await holdFitCompensation(page);
          await page.locator('.manga-reader [data-action="fit"]').click();
          assert(await page.evaluate(() => __fitFrames.length > 0), 'the fit race must hold an actual deferred product compensation frame');
          if (intent === 'wheel') {
            const before = await page.evaluate(() => scrollY); await page.mouse.move(700, 400); await page.mouse.wheel(0, 420);
            await page.waitForFunction(before => Math.abs(scrollY - before) > 100, before, { polling: 10, timeout: 5000 });
          } else if (intent === 'focus') {
            await page.locator('.manga-page-indicator').focus();
            await page.evaluate(() => scrollTo(0, scrollY + 420));
          } else {
            const saved = await page.evaluate(intent => {
              const figures = [...document.querySelectorAll('.manga-reader-image')], index = figures.findIndex(figure => figure.getBoundingClientRect().bottom > 0), rect = figures[index].getBoundingClientRect();
              const expected = { chapter: 1, page: index, ratio: Math.round(Math.max(0, Math.min(1, -rect.top / rect.height)) * 1e6) / 1e6, atStart: scrollY < 1 || index === 0 && rect.top > 0 };
              // Synthetic lifecycle handoff, not a physical BFCache/device test.
              if (intent === 'hidden') { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); }
              else dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
              return { expected, actual: JSON.parse(localStorage.getItem('fanhao.manga.positions') || '{}').C };
            }, intent);
            assert.deepEqual(saved.actual, saved.expected, 'hiding during width compensation must save the actual new document-relative geometry');
          }
          const expected = await page.evaluate(() => ({ scroll: scrollY, focused: document.activeElement.className }));
          await releaseFitCompensation(page);
          assert.deepEqual(await page.evaluate(() => ({ scroll: scrollY, focused: document.activeElement.className })), expected,
            'deferred width compensation must respect newer user scrolling and focus instead of pulling back');
        } finally { await page.close(); reset(); }
      }
    });
    await run('fit position: rapid toggles and retired readers cannot replay an old anchor', async () => {
      for (const destination of ['', '/manga/C/read/2', '/manga/D/read/2']) {
        configure(); const page = await newPage({ real: true, route: '/manga/C/read/1' });
        try {
          await prepareFitReadingAnchor(page, 49, .63); const before = await fitReadingAnchor(page);
          await holdFitCompensation(page); await page.locator('.manga-reader [data-action="fit"]').evaluate(button => { window.__retiredFit = button; });
          await page.locator('.manga-reader [data-action="fit"]').click();
          if (!destination) {
            await page.locator('.manga-reader [data-action="fit"]').click(); await releaseFitCompensation(page);
            await assertFitReadingAnchor(page, before);
            assert.equal(await page.locator('.manga-reader').evaluate(reader => reader.classList.contains('fit-width')), true);
          } else {
            await navigateRoute(page, destination); await stopHoldingFitCompensation(page);
            await readerTitle(page, destination.includes('/D/') ? 'Comic D' : 'Comic C', 'Chapter 2'); await fitImagesReady(page); await tick(page);
            const expected = await page.evaluate(() => ({ route: location.pathname, scroll: scrollY, mode: document.querySelector('.manga-reader').className, preference: localStorage.getItem('fanhao.manga.fitWidth'), progress: localStorage.getItem('fanhao.manga.progress') }));
            await releaseFitCompensation(page); await page.evaluate(() => __retiredFit.click()); await tick(page);
            assert.deepEqual(await page.evaluate(() => ({ route: location.pathname, scroll: scrollY, mode: document.querySelector('.manga-reader').className, preference: localStorage.getItem('fanhao.manga.fitWidth'), progress: localStorage.getItem('fanhao.manga.progress') })), expected,
              'retired fit callbacks and controls must not move or change the newly opened reader');
          }
        } finally { await page.close(); reset(); }
      }
    });
  }
  async function verifyFitRendering() {
    for (const count of [300, 1000]) await run(`fit ${count} pages: both widths preserve images, focus and later reader preferences`, async () => {
      readerImageCount = count;
      const page = await newPage({ real: true, ignoreAbort: false, route: "/manga/C/read/1" });
      try {
        await fitImagesReady(page); await page.waitForLoadState("networkidle");
        for (const fit of [false, true]) await toggleFitWithoutRebuild(page, fit, count);
        await page.locator('.manga-reader-bar [data-action="next"]').click(); await readerTitle(page, "Comic C", "Chapter 2");
        assert.equal(await page.locator('.manga-reader').getAttribute('class'), 'manga-reader fit-width');
        await navigateRoute(page, "/manga/D/read/1"); await readerTitle(page, "Comic D", "Chapter 1");
        assert.equal(await page.locator('.manga-reader').getAttribute('class'), 'manga-reader fit-width');
        await page.locator('.manga-reader-identity [data-action="detail"]').click(); await detailTitle(page, "Comic D");
        await clickChapter(page, 1); await readerTitle(page, "Comic D", "Chapter 1");
        assert.equal(await page.locator('.manga-reader').getAttribute('class'), 'manga-reader fit-width');
        await page.reload(); await ready(page); await readerTitle(page, "Comic D", "Chapter 1");
        assert.equal(await page.locator('.manga-reader').getAttribute('class'), 'manga-reader fit-width');
        assert.equal(await page.evaluate(() => localStorage.getItem('fanhao.manga.fitWidth')), '1');
      } finally { await page.close(); readerImageCount = 3; }
    });
    for (const error of ["", "pending next chapter failure"]) await run(`fit during pending next chapter ${error ? '503' : 'success'} retains the selected width`, async () => {
      readerImageCount = 300;
      const page = await newPage({ real: true, ignoreAbort: false, route: "/manga/C/read/1" });
      const next = hold(url => url.pathname === "/api/manga/C/chapters/2", error);
      try {
        await fitImagesReady(page); await page.waitForLoadState("networkidle");
        const target = page.locator('.manga-reader-bar [data-action="next"]');
        await target.focus(); await snapshotChapterSurface(page, '.manga-reader', target);
        await target.click(); await requested(next); await tick(page);
        await assertChapterSurface(page, { focus: true, scroll: true });
        await assertChapterFeedback(page, { pending: true, chapter: 2 });
        await toggleFitWithoutRebuild(page, false, 300, { waitIdle: false });
        await settle(page, next); await readerTitle(page, "Comic C", error ? "Chapter 1" : "Chapter 2");
        if (error) {
          await assertChapterSurface(page);
          await assertChapterFeedback(page, { cause: error, chapter: 2 });
        }
        assert.equal(await page.locator('.manga-reader').getAttribute('class'), 'manga-reader original-width');
        assert.equal(await page.evaluate(() => localStorage.getItem('fanhao.manga.fitWidth')), '0');
        assert.equal(await progress(page, 'C'), error ? 1 : 2);
        assert.equal(await page.evaluate(url => __transport.settled.filter(item => item.url === url).at(-1).ok, next.url), !error);
        await page.waitForLoadState("networkidle"); await toggleFitWithoutRebuild(page, true, 300);
      } finally { next.release(); await page.close(); readerImageCount = 3; }
    });
    for (const error of ["", "obsolete next chapter failure"]) await run(`fit then new comic ignores old chapter ${error ? '503' : 'success'}`, async () => {
      readerImageCount = 300;
      const page = await newPage({ real: true, ignoreAbort: true, route: "/manga/C/read/1" });
      const next = hold(url => url.pathname === "/api/manga/C/chapters/2", error);
      try {
        await fitImagesReady(page); await page.waitForLoadState("networkidle");
        await page.locator('.manga-reader-bar [data-action="next"]').click(); await requested(next); await tick(page);
        await toggleFitWithoutRebuild(page, false, 300, { waitIdle: false });
        await navigateRoute(page, "/manga/D/read/2"); await readerTitle(page, "Comic D", "Chapter 2"); await fitImagesReady(page);
        const before = await snapshotFitReader(page);
        await finishOld(page, next, true);
        assert.deepEqual(await fitReaderSnapshot(page), before, "obsolete chapter completion must preserve the selected width and newer reader nodes");
        assert.equal(await progress(page, 'C'), 1); assert.equal(await progress(page, 'D'), 2);
        assert.equal(await page.locator('.manga-chapter-feedback').count(), 0, 'old chapter failure and finally must not reappear over a newer comic');
      } finally { next.release(); await page.close(); readerImageCount = 3; }
    });
  }

  async function toggleFitWithoutRebuild(page, fit, count, { waitIdle = true } = {}) {
    await fitImagesReady(page);
    if (waitIdle) await page.waitForLoadState("networkidle");
    const before = await snapshotFitReader(page), requestCount = countRequests(() => true);
    const width = await page.locator('.manga-reader-pages img').first().evaluate(image => image.getBoundingClientRect().width);
    await page.locator('.manga-reader [data-action="fit"]').click(); await tick(page);
    const after = await fitReaderSnapshot(page);
    console.log(JSON.stringify({ mode: 'manga-fit', count, fit, created: after.created, imagesCreated: after.imagesCreated, requests: countRequests(() => true) - requestCount, widthBefore: width,
      width: await page.locator('.manga-reader-pages img').first().evaluate(image => image.getBoundingClientRect().width) }));
    assert.equal(after.created, 0, "changing width must not create new reader elements");
    assert.equal(after.imagesCreated, 0, "changing width must not recreate the chapter's images");
    assert.equal(after.reader, true); assert.equal(after.images, true); assert.equal(after.button, true); assert.equal(after.focused, true);
    assert.equal(after.count, count); assert.equal(after.route, before.route); assert.equal(after.progress, before.progress);
    assert.equal(countRequests(() => true), requestCount, "width changes must not issue API or image requests");
    assert.equal(after.className, fit ? 'manga-reader fit-width' : 'manga-reader original-width');
    assert.equal(after.buttonText, fit ? '原始宽度' : '适应宽度'); assert.equal(after.preference, fit ? '1' : '0');
    assert.notEqual(await page.locator('.manga-reader-pages img').first().evaluate(image => image.getBoundingClientRect().width), width);
  }
  function hold(match, error = "") {
    let release, requestedResolve;
    const gate = { match, error, used: false, closed: false, promise: new Promise(resolve => { release = resolve; }), requested: new Promise(resolve => { requestedResolve = resolve; }), release, requestedResolve };
    held.add(gate); return gate;
  }
  async function requested(gate, timeout = 5000) {
    let timer; try { await Promise.race([gate.requested, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`new request did not start before obsolete I/O finished (${timeout}ms)`)), timeout); })]); }
    finally { clearTimeout(timer); }
  }
  async function settle(page, gate) {
    const before = await page.evaluate(url => __transport.settled.filter(item => item.url === url).length, gate.url); gate.release();
    await page.waitForFunction(({ url, before }) => __transport.settled.filter(item => item.url === url).length > before, { url: gate.url, before }, { timeout: 5000 }); await tick(page);
  }
  async function finishOld(page, gate, ignoreAbort) {
    if (ignoreAbort) await settle(page, gate);
    else { await until(() => gate.closed, "obsolete aborted request must close in the normal transport"); gate.release(); await tick(page); }
  }
  async function newPage({ real = false, ignoreAbort = true, route = "/manga", waitReady = true, initialBack = false } = {}) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.on("pageerror", error => faults.push(error.message));
    page.on("dialog", dialog => dialog.accept()); // Only synthetic delete endpoints exist in this fixture.
    await page.addInitScript(({ ignoreAbort, initialBack }) => {
      window.__documentToken = Math.random(); window.__transport = { started: [], settled: [], aborted: [] };
      window.__fitCreated = { total: 0, images: 0 };
      const create = document.createElement.bind(document);
      document.createElement = (...args) => { __fitCreated.total++; if (String(args[0]).toLowerCase() === 'img') __fitCreated.images++; return create(...args); };
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (url, options = {}) => {
        const key = new URL(String(url), location.href), relative = `${key.pathname}${key.search}`;
        __transport.started.push(relative);
        options.signal?.addEventListener("abort", () => __transport.aborted.push(relative), { once: true });
        // no-store removes Chromium cache-key serialization for same-chapter races.
        const response = await originalFetch(url, ignoreAbort ? { ...options, cache: "no-store", signal: undefined } : options), originalJson = response.json.bind(response);
        response.json = async () => { try { return await originalJson(); } finally { __transport.settled.push({ url: relative, ok: response.ok }); } }; return response;
      };
      if (initialBack && location.pathname === "/manga/C") {
        const deepLink = `${location.pathname}${location.search}`; history.replaceState(null, "", "/manga"); history.pushState(null, "", deepLink);
      }
    }, { ignoreAbort, initialBack });
    await page.goto(real ? `${base}${route}` : `${base}/probe`, { waitUntil: waitReady ? "load" : "commit" });
    if (waitReady) { if (real) await ready(page); else await page.waitForFunction(() => Boolean(window.fixture?.ready)); }
    return page;
  }
}

async function ready(page) { await page.waitForFunction(() => !document.documentElement.classList.contains("app-module-loading"), null, { timeout: 5000 }); }
async function openLibraryDuringUpdate(page, gate) {
  await page.locator('.manga-card').filter({ hasText: 'Comic C' }).locator('.manga-card-open').click(); await detailTitle(page, 'Comic C');
  await page.locator('[data-action="update"]').click(); await until(() => gate.used, 'native comic update must start the controlled background request');
  await page.goBack(); await page.locator('.manga-library-controls').waitFor();
  await page.waitForFunction(() => !document.querySelector('.manga-status'));
}
async function tick(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function until(predicate, message) { const deadline = Date.now() + 5000; while (!predicate()) { assert(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 10)); } }
async function navigateRoute(page, target) { await page.evaluate(url => { history.pushState(null, "", url); dispatchEvent(new PopStateEvent("popstate")); }, target); }
async function launch(page, route) { await page.evaluate(value => { fixture.pending.push(fixture.page.openRouteTarget(value)); }, route); }
async function openTarget(page, route) { await page.evaluate(value => fixture.page.openRouteTarget(value), route); }
async function clickChapter(page, index) { await page.locator(".manga-chapter-row button").nth(index - 1).evaluate(button => button.click()); }
async function detailTitle(page, title) { await page.waitForFunction(value => document.querySelector(".manga-detail h1")?.textContent === value, title, { timeout: 5000 }); }
async function readerTitle(page, title, chapterTitle) { await page.waitForFunction(([title, chapter]) => document.querySelector(".manga-reader-identity strong")?.textContent === title && document.querySelector(".manga-reader-identity span")?.textContent === chapter, [title, chapterTitle], { timeout: 5000 }); }
async function stateSnapshot(page) { return page.evaluate(() => ({ comic: fixture.state.manga.comic?.id ?? null, chapter: fixture.state.manga.chapter?.index ?? null, loading: fixture.state.manga.loading, status: fixture.state.manga.status })); }
async function progress(page, id) { return page.evaluate(id => JSON.parse(localStorage.getItem("fanhao.manga.progress") || "{}")[id] ?? null, id); }
function openingLibraryShelf() {
  const comics = Array.from({ length: 1000 }, (_, index) => ({ ...comic(`OpeningShelf${String(index + 1).padStart(4, '0')}`), title: `Synthetic opening shelf ${String(index + 1).padStart(4, '0')}` }));
  comics[499] = comic('C'); comics[500] = comic('D');
  return comics;
}
async function prepareLibraryOpeningDrafts(page) {
  await page.locator('.manga-library-controls [data-action="add"]').click();
  const search = page.locator('.manga-library-controls input'), add = page.locator('.manga-add-panel input');
  await search.fill('  Unsubmitted shelf search  '); await search.evaluate(input => input.setSelectionRange(2, 8, 'forward'));
  await add.fill('https://example.invalid/unsent-shelf-draft'); await add.evaluate(input => input.setSelectionRange(5, 14, 'backward'));
}
async function snapshotLibraryOpening(page, target) {
  await target.evaluate(button => {
    window.__openingSurface?.observer.disconnect();
    const page = document.querySelector('.manga-library'), cards = [...page.querySelectorAll('.manga-card')], covers = cards.map(card => card.querySelector('img'));
    const controls = page.querySelector('.manga-library-controls'), add = page.querySelector('.manga-add-panel');
    const nodes = [page, controls, controls.querySelector('input'), controls.querySelector('select'), add, add?.querySelector('input'),
      page.querySelector('.manga-card-grid'), ...cards, ...covers, button].filter(Boolean);
    const ancestors = new Map();
    for (const node of nodes) for (let parent = node; parent; parent = parent.parentElement) ancestors.set(parent, parent.parentElement);
    const fields = [...page.querySelectorAll('.manga-library-controls input, .manga-add-panel input')].map(input => ({ input, value: input.value,
      range: [input.selectionStart, input.selectionEnd, input.selectionDirection] }));
    const saved = window.__openingSurface = { page, cards, covers, controls, add, nodes, ancestors, fields, button,
      scroll: scrollY, blur: 0, removed: 0, addedImages: new Set(), articles: [] };
    button.addEventListener('blur', () => saved.blur++);
    saved.observer = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.removedNodes) if (node.nodeType === Node.ELEMENT_NODE && nodes.some(owned => node === owned || node.contains(owned))) saved.removed++;
        for (const node of record.addedNodes) {
          if (node.nodeName === 'IMG') saved.addedImages.add(node);
          for (const image of node.querySelectorAll?.('img') || []) saved.addedImages.add(image);
        }
      }
    });
    saved.observer.observe(document.querySelector('#workGrid'), { childList: true, subtree: true });
    window.__openingBaseCreate ||= document.createElement.bind(document);
    document.createElement = (...args) => {
      const node = __openingBaseCreate(...args);
      if (String(args[0]).toLowerCase() === 'article') saved.articles.push(node);
      return node;
    };
    __fitCreated.total = __fitCreated.images = 0;
  });
}
async function assertLibraryOpeningSurface(page, { focus = false, scroll = false } = {}) {
  const actual = await page.evaluate(() => {
    const saved = __openingSurface, cards = [...document.querySelectorAll('.manga-card')];
    return { expectedCards: saved.cards.length, retained: saved.cards.filter(card => card.isConnected).length,
      cardOrder: saved.cards.length === cards.length && saved.cards.every((card, index) => card === cards[index]),
      retainedCovers: saved.covers.filter(image => image?.isConnected).length,
      ancestors: [...saved.ancestors].every(([node, parent]) => node.isConnected && node.parentElement === parent),
      fields: saved.fields.every(({ input, value, range }) => input.isConnected && input.value === value
        && input.selectionStart === range[0] && input.selectionEnd === range[1] && input.selectionDirection === range[2]),
      removed: saved.removed, newCards: saved.articles.filter(article => article.classList.contains('manga-card')).length,
      newImages: saved.addedImages.size, createdElements: __fitCreated.total,
      focused: document.activeElement === saved.button, blur: saved.blur, scroll: scrollY === saved.scroll };
  });
  assert.equal(actual.retained, actual.expectedCards, 'opening a comic must retain every existing shelf card while its metadata is pending or failed');
  assert(actual.cardOrder && actual.retainedCovers === actual.expectedCards && actual.ancestors && actual.fields && actual.removed === 0,
    'pending or failed shelf metadata must preserve the complete live card, cover, search and add-form ancestry with the actual unsubmitted drafts and selections');
  assert.equal(actual.newCards, 0, 'opening or retrying a shelf comic must not construct replacement cards');
  assert.equal(actual.newImages, 0, 'opening or retrying shelf metadata must not replace or reassign any cover image');
  assert(actual.createdElements < 60, 'opening shelf metadata must bound construction to feedback outside the retained cards');
  if (focus) assert(actual.focused && actual.blur === 0, 'pending or failed shelf metadata must keep the original focused native card without transient blur');
  if (scroll) assert(actual.scroll, 'pending or failed shelf metadata must keep the current library scroll position');
  return actual;
}
async function assertLibraryOpeningFeedback(page, { pending = false, title, cause = '' }) {
  const feedback = page.locator('.manga-library-open-feedback');
  assert.equal(await feedback.count(), 1, 'a shelf metadata read needs its own visible waiting or failure feedback');
  assert.equal(await feedback.getAttribute('role'), pending ? 'status' : 'alert');
  const actual = await feedback.evaluate(node => {
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
      && rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top >= 0 && rect.bottom <= innerHeight,
      hit: node === hit || node.contains(hit), text: node.textContent };
  });
  assert(actual.visible && actual.hit, 'shelf open feedback must be reachable inside the actual scrolled library viewport');
  assert(actual.text.includes(title), 'shelf open feedback must identify the actual pending or failed comic');
  if (cause) assert(actual.text.includes(cause), 'failed shelf metadata must expose its real request cause rather than only hidden model status');
}
async function snapshotChapterSurface(page, selector, focus) {
  await focus.evaluate((button, selector) => {
    window.__chapterSurface?.observer.disconnect();
    const root = document.querySelector(selector), images = [...root.querySelectorAll('.manga-reader-image img')];
    const nodes = [root, ...root.querySelectorAll('.manga-reader-image, .manga-reader-image img, .manga-reader-bar, .manga-reader-footer, .manga-reader-floating, .manga-page-jump, .manga-page-jump input, .manga-directory-search, .manga-directory-search-input, .manga-catalog')];
    const ancestors = new Map();
    for (const element of [...nodes, button]) for (let node = element; node; node = node.parentElement) ancestors.set(node, node.parentElement);
    const saved = window.__chapterSurface = { selector, root, images, button, nodes, ancestors, scroll: scrollY, blur: 0, removed: 0, figures: 0 };
    button.addEventListener('blur', () => saved.blur++);
    saved.observer = new MutationObserver(records => {
      for (const mutation of records) for (const node of mutation.removedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE && nodes.some(element => node === element || node.contains(element))) saved.removed++;
      }
    });
    saved.observer.observe(document.querySelector('#workGrid'), { childList: true, subtree: true });
    const create = document.createElement.bind(document);
    document.createElement = (...args) => { if (String(args[0]).toLowerCase() === 'figure') saved.figures++; return create(...args); };
    __fitCreated.total = __fitCreated.images = 0;
  }, selector);
}
async function assertChapterSurface(page, { focus = false, scroll = false } = {}) {
  const actual = await page.evaluate(() => {
    const saved = __chapterSurface;
    return { root: saved.root === document.querySelector(saved.selector),
      ancestors: [...saved.ancestors].every(([node, parent]) => node.isConnected && node.parentElement === parent),
      images: saved.images.every((image, index) => image.isConnected && image === saved.root.querySelectorAll('.manga-reader-image img')[index]),
      removed: saved.removed, newImages: __fitCreated.images, newFigures: saved.figures,
      focus: document.activeElement === saved.button, blur: saved.blur, scroll: scrollY === saved.scroll, created: __fitCreated.total };
  });
  assert.deepEqual({ root: actual.root, ancestors: actual.ancestors, images: actual.images, removed: actual.removed, newImages: actual.newImages, newFigures: actual.newFigures },
    { root: true, ancestors: true, images: true, removed: 0, newImages: 0, newFigures: 0 },
    'pending and failed manga chapter reads must preserve the usable source surface and all image/control ancestors without rebuilding images or figures');
  if (focus) assert.deepEqual({ focus: actual.focus, blur: actual.blur }, { focus: true, blur: 0 }, 'chapter waiting and failure must preserve native focus without transient blur');
  if (scroll) assert.equal(actual.scroll, true, 'chapter waiting must not move the existing reading or directory position');
  return actual;
}
async function assertChapterControlHit(control) {
  const actual = await control.evaluate(node => {
    const rect = node.getBoundingClientRect(), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { width: rect.width, height: rect.height, visible: rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top >= 0 && rect.bottom <= innerHeight, hit: node === hit || node.contains(hit) };
  });
  assert(actual.visible && actual.hit && actual.width >= 44 && actual.height >= 44, 'chapter retry must remain a complete 44px native target inside the actual viewport and above other floating controls');
}
async function assertChapterFeedback(page, { pending = false, cause = '', chapter }) {
  const feedback = page.locator('.manga-chapter-feedback');
  assert.equal(await feedback.count(), 1, 'a chapter request needs visible waiting or failure feedback in its current source context');
  assert.equal(await feedback.getAttribute('role'), pending ? 'status' : 'alert');
  const visible = await feedback.evaluate(node => {
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { visible: style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= -1 && rect.right <= innerWidth + 1,
      hit: node === hit || node.contains(hit), text: node.textContent };
  });
  assert(visible.visible && visible.hit, 'chapter feedback must be in the actual middle-reader or deep-directory viewport without being covered');
  assert(new RegExp(`Chapter ${chapter}(?!\\d)|第\\s*${chapter}\\s*话`).test(visible.text), 'chapter feedback must identify the actual pending or failed target');
  if (cause) assert(visible.text.includes(cause), 'failed chapter feedback must expose the actual request cause instead of a hidden state string');
}
async function assertReadingAnchor(page, index, ratio) {
  const actual = await page.locator('.manga-reader-image').nth(index).evaluate(figure => -figure.getBoundingClientRect().top / figure.getBoundingClientRect().height);
  assert(Math.abs(actual - ratio) < .005, 'restored reading must keep the saved page and its relative offset after image layout or viewport changes');
}
async function fitImagesReady(page) {
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('.manga-reader-pages img')];
    return images.length > 1 && images.slice(0, 2).every(image => image.complete && image.naturalWidth > 0);
  }, null, { timeout: 5000 });
}
async function fitReadingAnchor(page) {
  return page.evaluate(() => {
    const reader = document.querySelector('.manga-reader'), bar = reader.querySelector('.manga-reader-bar');
    const inset = getComputedStyle(bar).position === 'sticky' ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
    const figures = [...reader.querySelectorAll('.manga-reader-image')], index = figures.findIndex(figure => figure.getBoundingClientRect().bottom > inset + 1);
    const rect = figures[index].getBoundingClientRect();
    return { index, ratio: (inset - rect.top) / rect.height, height: rect.height };
  });
}
async function scrollFitReadingAnchor(page, index, ratio) {
  await page.locator('.manga-reader-image').nth(index).evaluate((figure, ratio) => {
    const reader = figure.closest('.manga-reader'), bar = reader.querySelector('.manga-reader-bar');
    const inset = getComputedStyle(bar).position === 'sticky' ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
    const rect = figure.getBoundingClientRect(); scrollTo(0, scrollY + rect.top + rect.height * ratio - inset);
  }, ratio); await tick(page);
}
async function prepareFitReadingAnchor(page, index, ratio) {
  await fitImagesReady(page); await scrollFitReadingAnchor(page, index, ratio);
  await exposedFitImageDecoded(page, index); await page.waitForLoadState('networkidle'); await tick(page);
}
async function exposedFitImageDecoded(page, index) {
  await page.waitForFunction(index => { const image = document.querySelectorAll('.manga-reader-image img')[index]; return image?.complete && image.naturalWidth > 0; }, index, { timeout: 5000 });
  const exposed = await page.locator('.manga-reader-image img').nth(index).evaluate(async image => {
    const rect = image.getBoundingClientRect(), bar = image.closest('.manga-reader').querySelector('.manga-reader-bar');
    const inset = getComputedStyle(bar).position === 'sticky' ? bar.getBoundingClientRect().bottom : 0;
    const visible = rect.bottom > inset && rect.top < innerHeight && rect.width > 0;
    await image.decode(); return visible;
  });
  assert(exposed, 'fit decoding must only inspect an image already exposed by native scrolling or a current width change');
}
async function assertFitReadingAnchor(page, before) {
  const after = await fitReadingAnchor(page);
  assert.equal(after.index, before.index, 'changing manga width must retain the current reading page');
  assert(Math.abs(after.ratio - before.ratio) < .005, 'changing manga width must retain the within-page reading ratio at the actual viewport inset');
}
async function snapshotFitReadingNodes(page) {
  await page.evaluate(() => { const reader = document.querySelector('.manga-reader'); window.__fitReadingNodes = { reader, images: [...reader.querySelectorAll('.manga-reader-image img')] }; __fitCreated.total = __fitCreated.images = 0; });
}
async function assertFitReadingNodes(page) {
  const after = await page.evaluate(() => ({ reader: __fitReadingNodes.reader === document.querySelector('.manga-reader'),
    images: __fitReadingNodes.images.every((image, index) => image.isConnected && image === document.querySelectorAll('.manga-reader-image img')[index]),
    count: document.querySelectorAll('.manga-reader-image img').length, created: __fitCreated.total, imagesCreated: __fitCreated.images }));
  assert.deepEqual(after, { reader: true, images: true, count: 100, created: 0, imagesCreated: 0 }, 'fit position preservation must not recreate the reader, images, or any controls');
  return after.created;
}
async function holdFitCompensation(page) {
  await page.evaluate(() => {
    window.__fitNativeRAF = requestAnimationFrame.bind(window); window.__fitFrames = []; window.__fitHoldArmed = false;
    window.requestAnimationFrame = callback => __fitHoldArmed && String(callback).includes('finishRestore')
      ? (__fitFrames.push(callback), -__fitFrames.length) : __fitNativeRAF(callback);
    document.querySelector('.manga-reader [data-action="fit"]').addEventListener('click', () => { __fitHoldArmed = true; }, { capture: true, once: true });
  });
}
async function stopHoldingFitCompensation(page) { await page.evaluate(() => { window.requestAnimationFrame = __fitNativeRAF; __fitHoldArmed = false; }); }
async function releaseFitCompensation(page) {
  await stopHoldingFitCompensation(page);
  // Deliberately deliver even a retired/cancelled callback to model the race
  // where a browser frame was already queued before cancellation arrived.
  await page.evaluate(() => { const frames = __fitFrames.splice(0); for (const frame of frames) frame(performance.now()); }); await tick(page);
}
async function snapshotFitReader(page) {
  await page.evaluate(() => {
    const reader = document.querySelector('.manga-reader'), button = reader.querySelector('[data-action="fit"]');
    window.__fitSnapshot = { reader, button, images: [...reader.querySelectorAll('.manga-reader-pages img')] };
    button.focus(); __fitCreated.total = 0; __fitCreated.images = 0;
  });
  return fitReaderSnapshot(page);
}
async function fitReaderSnapshot(page) {
  return page.evaluate(() => {
    const reader = document.querySelector('.manga-reader'), images = [...reader.querySelectorAll('.manga-reader-pages img')];
    const button = reader.querySelector('[data-action="fit"]');
    return { reader: reader === __fitSnapshot.reader, button: button === __fitSnapshot.button,
      images: images.length === __fitSnapshot.images.length && images.every((image, index) => image === __fitSnapshot.images[index] && image.isConnected),
      focused: document.activeElement === __fitSnapshot.button, count: images.length,
      created: __fitCreated.total, imagesCreated: __fitCreated.images, className: reader.className, buttonText: button.textContent,
      preference: localStorage.getItem('fanhao.manga.fitWidth'), progress: localStorage.getItem('fanhao.manga.progress'),
      route: `${location.pathname}${location.search}`, scroll: scrollY };
  });
}
async function rememberReader(page) {
  await page.waitForFunction(() => [...document.querySelectorAll(".manga-reader-pages img")].slice(0, 2).every(image => image.complete && image.naturalWidth > 0));
  await page.evaluate(() => { fixture.reader = document.querySelector(".manga-reader"); fixture.firstImage = fixture.reader.querySelector("img"); window.scrollTo(0, 420); }); await tick(page);
  const before = await page.evaluate(() => ({ scroll: window.scrollY, route: `${location.pathname}${location.search}`, progress: localStorage.getItem("fanhao.manga.progress") }));
  assert(before.scroll > 0, "reader preservation must measure actual nonzero document scroll"); return before;
}
async function assertReaderPreserved(page, before) {
  assert.equal(await page.evaluate(() => fixture.reader === document.querySelector(".manga-reader") && fixture.firstImage === document.querySelector(".manga-reader-pages img")), true, "obsolete read must preserve the mounted reader and images");
  assert.deepEqual(await page.evaluate(() => ({ scroll: window.scrollY, route: `${location.pathname}${location.search}`, progress: localStorage.getItem("fanhao.manga.progress") })), before, "obsolete read must not rewrite scroll, route or progress");
}
function sendText(res, body, type, cache = "no-store") { if (res.destroyed) return; res.writeHead(200, { "Content-Type": type, "Cache-Control": cache }); res.end(body); }
function sendJson(res, body, status = 200) { if (res.destroyed) return; res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); }
function comic(id) {
  return { id, title: `Comic ${id}`, site: "fixture", author: "Synthetic", sourceUrl: `https://example.invalid/${id}`, coverUrl: `/synthetic/${id}/cover.svg`, chapterCount: 2, doneChapterCount: 2, imageCount: 6, downloadedCount: 6, failedCount: 0, updatedAt: "2026-01-01T00:00:00Z",
    chapters: [1, 2].map(index => ({ index, title: `Chapter ${index}`, status: "done", imageCount: 3, downloadedCount: 3 })) };
}
function catalogComic(id, indices = Array.from({ length: 1000 }, (_, index) => index + 1)) {
  return { ...comic(id), chapterCount: indices.length, doneChapterCount: indices.length,
    chapters: indices.map(index => ({ index, title: `Chapter ${index}`, status: 'done', imageCount: 3, downloadedCount: 3 })) };
}
function libraryCoverShelf(prefix) {
  return Array.from({ length: 1000 }, (_, index) => ({ ...comic(`${prefix}${String(index + 1).padStart(4, '0')}`), title: `Synthetic cover ${String(index + 1).padStart(4, '0')}` }));
}
async function assertLibraryCoverDecoded(page, id) {
  await page.waitForFunction(id => { const image = [...document.querySelectorAll('.manga-card')].find(card => card.dataset.comicId === id)?.querySelector('img');
    return image?.complete && image.naturalWidth > 0; }, id, { timeout: 5000 });
  const actual = await page.locator(`.manga-card[data-comic-id="${id}"] img`).evaluate(async image => {
    const rect = image.getBoundingClientRect(), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && image.closest('button') === hit?.closest('button');
    // This helper is only called after real scroll/keyboard exposure and a
    // completed native request; it never wakes up still-distant lazy images.
    await image.decode(); return { visible, decoded: image.complete && image.naturalWidth > 0 };
  });
  assert(actual.visible && actual.decoded, 'an exposed manga shelf cover must be visible and actually decode without replacing its card');
}
function searchableCatalogComic(id) {
  const value = catalogComic(id);
  Object.assign(value.chapters[76], { title: 'ＦｕｌｌＷｉｄｔｈ HERO' });
  Object.assign(value.chapters[126], { title: 'aLpHa Finale' });
  Object.assign(value.chapters[127], { title: 'ALPHA Pending', status: 'pending', downloadedCount: 0 });
  Object.assign(value.chapters[499], { index: 5005, title: '第500话·星辰' });
  value.doneChapterCount--;
  return value;
}
async function visibleDirectoryIndices(page) {
  return page.locator('.manga-chapter-row').evaluateAll(rows => rows.filter(row => row.getClientRects().length > 0).map(row => Number(row.dataset.chapterIndex)));
}
async function directorySearchNumbers(page) {
  return (await page.locator('.manga-directory-search-count').textContent()).replaceAll(',', '').match(/\d+/g)?.map(Number);
}
async function directorySearchSurface(page) {
  return page.evaluate(() => ({ html: document.querySelector('#workGrid').innerHTML, route: location.href, scroll: scrollY,
    progress: localStorage.getItem('fanhao.manga.progress'), focus: document.activeElement?.outerHTML }));
}
async function catalogReturnSnapshot(page, index) {
  return page.evaluate(index => {
    const rows = [...document.querySelectorAll('.manga-chapter-row')], row = rows.find(row => row.dataset.chapterIndex === String(index));
    const button = row?.querySelector('button'), rect = button?.getBoundingClientRect();
    return { rows: rows.length, currentCount: document.querySelectorAll('.manga-catalog [aria-current="true"]').length,
      currentIndex: document.querySelector('.manga-catalog [aria-current="true"]')?.closest('.manga-chapter-row').dataset.chapterIndex || '',
      top: rect?.top, bottom: rect?.bottom, scroll: scrollY, visible: Boolean(rect && rect.top >= 0 && rect.bottom <= innerHeight),
      hit: Boolean(rect && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('button') === button),
      focused: button === document.activeElement };
  }, index);
}
function chapter(id, index, imageCount = 3, dimensions = null) { return { index, title: `Chapter ${index}`, images: Array.from({ length: imageCount }, (_, page) => ({ ...(Array.isArray(dimensions) ? dimensions[page] : dimensions), url: `/synthetic/${id}/${index}/${page + 1}.svg` })) }; }
function harness() {
  return `<!doctype html><meta charset=utf-8><link rel=stylesheet href=/modules/photos/manga.css><style>body{margin:0;background:#1c2220;color:white}main{max-width:1050px;margin:auto}</style><main><div id=statsRow></div><div id=workGrid></div></main><script type=module>
import {createMangaPage} from '/modules/photos/manga-page.js';
const state={activeView:'manga',manga:{data:{comics:${JSON.stringify([comic("C"), comic("D")])}},comic:null,chapter:null,loading:false,status:''}};
const els={workGrid:document.querySelector('#workGrid'),statsRow:document.querySelector('#statsRow')},noop=()=>{};
const api=async(url,options={})=>{const res=await fetch(url,options),data=await res.json();if(!res.ok)throw new Error(data.error||'controlled error');return data;};
const route=(overrides={})=>{const id=overrides.mangaComicId??state.manga.comic?.id??'',chapter=overrides.mangaChapterIndex??state.manga.chapter?.index??'';history.replaceState(null,'',id?'/manga/'+id+(chapter?'/read/'+chapter:''):'/manga');};
const page=createMangaPage({api,state,els,formatNumber:value=>new Intl.NumberFormat('zh-CN').format(value||0),formatDateTime:value=>String(value||''),cancelScheduledWorkRendering:noop,disconnectPeopleIndexAutoload:noop,resetProgressiveCoverLoading:noop,hidePersonProfile:noop,setMainHeader:noop,writeStoredFlag:noop,pushRoute:route,syncRouteAfterNavigation:options=>{if(!options?.skipRoute)route(options?.routeOverrides)}});
window.fixture={state,page,pending:[],ready:true};page.enter({skipRoute:true,deferInitialLoad:true});
</script>`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runMangaReaderFixture({ legacyManga: process.argv.includes("--legacy-manga"), legacyHost: process.argv.includes("--legacy-host"), legacyFit: process.argv.includes("--legacy-fit"),
    casePattern: process.argv.find(value => value.startsWith("--case="))?.slice(7) || (process.argv.includes("--fit-only") || process.argv.includes("--legacy-fit") ? "fit " : "") });
}
