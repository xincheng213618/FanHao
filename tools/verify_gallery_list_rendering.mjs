import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createChannelOracle, createMetadataChannelOracle, restrictPrivateNetwork } from "./fixtures/image-library-channel-server.mjs";

// Current page/renderer, the actual gallery CSS cascade and host formatters.
// All DTOs and SVGs are generated on a random private loopback port. No media,
// database, credentials or production service is used. Timings are diagnostic.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(root, "public");
const legacy = process.argv.includes("--legacy-list-refresh");
const legacyVisibility = process.argv.includes("--legacy-content-visibility");
const legacyOffset = process.argv.includes("--legacy-offset");
const caseFilter = process.argv.find(value => value.startsWith("--case="))?.slice(7) || "";
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(value => fs.existsSync(value));
assert(executablePath, "Chrome or Edge required for the private gallery fixture");
const host = fs.readFileSync(path.join(publicRoot, "js/standalone-host.js"), "utf8");
const formatters = host.slice(host.indexOf("function formatNumber("), host.indexOf("function includesText("));
assert.match(formatters, /function formatDateTime/);
const entry = fs.readFileSync(path.join(publicRoot, "index.html"), "utf8");
const galleryStyles = JSON.parse(`[${entry.match(/const galleryStyleUrls = \[([^]*?)\];/)[1].replace(/,\s*$/, "")}]`);
let catalogSource = fs.readFileSync(path.join(publicRoot, "modules/content-index/catalog.css"), "utf8");
if (legacyVisibility) {
  // Keep the same text geometry and current renderer; disable only actual
  // browser skipping. The negative must fail the offscreen visibility check.
  const marker = "    content-visibility: auto;";
  assert.equal(catalogSource.split(marker).length, 2);
  catalogSource = catalogSource.replace(marker, "    content-visibility: visible;");
}
let rendererSource = fs.readFileSync(path.join(publicRoot, "modules/content-index/gallery-renderer.js"), "utf8");
let pageSource = fs.readFileSync(path.join(publicRoot, "modules/content-index/gallery-page.js"), "utf8");
if (legacyOffset) {
  const marker = "offset > 0 && !sameImageLibraryRevision(currentList, data)";
  assert.equal(pageSource.split(marker).length, 2);
  pageSource = pageSource.replace(marker, "offset > 0 && false");
}
if (legacy) {
  // Restore the actual previous whole-list fallback while retaining current
  // response ownership and reader fixes. Failure must concern real DOM identity.
  const marker = "function refreshGalleryList(options = {}) {";
  assert.equal(rendererSource.split(marker).length, 2);
  rendererSource = rendererSource.replace(marker, `${marker}\n  return false;`);
}
for (const name of ["renderGalleryView", "renderGalleryResults"]) {
  const marker = `function ${name}(options = {}) {`;
  assert.equal(rendererSource.split(marker).length, 2);
  rendererSource = rendererSource.replace(marker, `function ${name}(options = {}) {
    const start = performance.now(), created = window.__created;
    try { return ${name}Measured(options); }
    finally { window.__renders.push({ kind: "${name}", ms: performance.now() - start, created: window.__created - created }); }
  }
  function ${name}Measured(options = {}) {`);
}
const item = (index, mode = "photo", extra = {}) => ({
  id: `I${index}`, type: mode === "photo" ? "photo" : mode === "manga" ? "manga" : "media",
  title: `Synthetic ${index}`, category: "fixture", subCategory: "fixture", personName: "Synthetic", mediaKind: "movie",
  size: 10000000, updatedAt: "2026-10-04", imageCount: 80, chapterCount: 2, coverUrl: `/synthetic/${index}.svg`,
  ...(mode === "media" || mode === "movie" ? { movieMetadata: { title: `Synthetic ${index}`, year: 2026, genres: ["Drama"], rating: 8.1, ratingCount: 1000 } } : {}), ...extra
});
const body = (count, offset = 0, mode = "photo", extra = {}) => ({ items: Array.from({ length: count }, (_, index) => item(offset + index + 1, mode)), total: 5000, facets: {}, stats: {}, ...extra });
const held = new Set(), requests = [], faults = [], unexpected = [];
let browser, checks = 0, oracle = null;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture"), key = `${url.pathname}${url.search}`;
  requests.push(key);
  try {
    const gate = [...held].find(value => !value.used && value.match(url));
    if (gate) {
      gate.used = true; gate.url = key; gate.requestedResolve(); res.once("close", () => { gate.closed = true; });
      await gate.promise;
      if (res.destroyed) return;
      if (gate.error) { json(res, { error: gate.error }, 503); return; }
      if (gate.body) { json(res, gate.body); return; }
    }
    if (url.pathname === "/probe") { send(res, harness(url), "text/html"); return; }
    if (url.pathname === "/api/image-library/items") { json(res, oracle ? oracle.payload(url) : body(Number(url.searchParams.get("limit") || 80), Number(url.searchParams.get("offset") || 0), url.searchParams.get("mode") || "photo")); return; }
    if (url.pathname === "/api/image-library/summary") { json(res, { totals: { photoSets: 12345, manga: 5000, movie: 5000 }, facets: { categories: [{ value: "late", count: 777 }], media: { categories: [{ value: "late", count: 777 }] } }, scannedAt: "2026-10-04" }); return; }
    const album = /^\/api\/photo-sets\/(.+)$/.exec(url.pathname);
    if (album) { json(res, { album: { ...item(Number(album[1].slice(1))), title: `Reader ${album[1]}`, images: [1, 2].map(index => ({ index, url: `/synthetic/reader-${index}.svg`, name: `Page ${index}` })), imageCount: 2 } }); return; }
    if (url.pathname.startsWith("/api/")) { unexpected.push(key); json(res, { error: "unmodelled synthetic API" }, 404); return; }
    if (url.pathname.startsWith("/synthetic/") || /^\/media\/(?:movie-cover|tv-series-cover|gallery-media-cover)\//.test(url.pathname)) { send(res, '<svg xmlns="http://www.w3.org/2000/svg" width="250" height="350"><rect width="250" height="350" fill="#719284"/></svg>', "image/svg+xml", "public, max-age=86400"); return; }
    if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    if (url.pathname === "/player.html") { send(res, "<!doctype html><title>Private player navigation target</title>", "text/html"); return; }
    const target = path.resolve(publicRoot, url.pathname.replace(/^\/+/, ""));
    assert(target.startsWith(`${publicRoot}${path.sep}`));
    const css = url.searchParams.get("unsupported") === "1" ? catalogSource.replace("@supports (content-visibility: auto)", "@supports (fanhao-unsupported: 1)") : catalogSource;
    send(res, url.pathname === "/modules/content-index/gallery-renderer.js" ? rendererSource : url.pathname === "/modules/content-index/gallery-page.js" ? pageSource : url.pathname === "/modules/content-index/catalog.css" ? css : await fs.promises.readFile(target), target.endsWith(".js") ? "text/javascript" : "text/css");
  } catch (error) { unexpected.push(`${key}: ${error.message}`); if (!res.destroyed) { res.writeHead(500); res.end(error.message); } }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const run = async (name, task) => { if (caseFilter && !name.includes(caseFilter)) return; await task(); checks++; console.log(`PASS ${name}`); };
const cardSelector = ".gallery-photo-album-card, .manga-grid > .gallery-card, .gallery-movie-list-item, .gallery-tv-series-card";
try {
  browser = await chromium.launch({ executablePath, headless: true });
  for (const mode of ['movie', 'tv']) for (const mutation of ['cover', 'other-kind', 'metadata']) await run(`actual metadata ${mode} 1000: ${mutation} write owns only its query revision`, async () => {
    const owner = createMetadataChannelOracle({ mode, sort: 'rating' }); oracle = owner; let page;
    try {
      page = await newPage({ mode, count: 1000, oracleSeed: true });
      const original = owner.payload({ limit: '1000' });
      if (mutation === 'cover') owner.coverWrite(); else if (mutation === 'other-kind') owner.otherKindWrite(); else owner.reorder(original.items[7].id);
      const latest = owner.payload({ limit: '1080' }), changed = mutation === 'metadata';
      if (!changed) { assert.deepEqual(latest.items.slice(0, 1000), original.items); assert.equal(latest.listRevision, original.listRevision, 'unrelated table writes must retain this channel revision'); }
      else assert.notEqual(latest.listRevision, original.listRevision);
      const start = requests.length, gate = hold(url => url.pathname === '/api/image-library/items' && url.searchParams.get('offset') === '1000');
      await snapshot(page); await page.evaluate(() => document.querySelector('.gallery-more').click()); await requested(gate);
      const pending = await read(page); if (legacy) console.log(JSON.stringify({ kind: 'legacy-tv-shelf', mode, pending })); assert(pending.row && pending.image && pending.focused && pending.observer, 'loading must retain actual media/TV shelf resources'); assert.equal(pending.created, 0); assert(await page.locator('.gallery-more').isDisabled());
      gate.release(); await settled(page, gate); await page.waitForFunction(() => !fixture.page.isImageLibraryListLoading()); await frames(page);
      const urls = requests.slice(start).filter(value => value.startsWith('/api/image-library/items')), result = await read(page);
      assert.equal(urls.length, changed ? 2 : 1); assert.equal(new URL(urls[0], base).searchParams.get('limit'), '80');
      if (changed) { assert.equal(new URL(urls[1], base).searchParams.get('offset'), '0'); assert.equal(new URL(urls[1], base).searchParams.get('limit'), '1080'); assert.deepEqual(await page.evaluate(() => fixture.state.gallery.list.items.map(value => value.id)), latest.items.map(value => value.id)); assert.equal(result.row, false, 'reordered prefix uses the complete fallback'); }
      else { assert(result.row && result.image && result.focused && result.observer); assert.equal(result.rows, 1080); assert(result.created < 1500); assert.equal(result.renders.length, 0); }
      console.log(JSON.stringify({ kind: 'metadata-write-boundary', client: 'web', mode, mutation, urls, pending, result }));
    } finally { await page?.close(); oracle = null; owner.close(); }
  });
  await run('TV 1000: error/retry retains shelf and original request range', async () => {
    const owner = createMetadataChannelOracle({ mode: 'tv' }); oracle = owner; let page; const failed = hold(url => url.pathname === '/api/image-library/items' && url.searchParams.get('offset') === '1000', null, 'private TV page error');
    try {
      page = await newPage({ mode: 'tv', count: 1000, oracleSeed: true }); await snapshot(page); await page.evaluate(() => { document.querySelector('.gallery-more').click(); document.querySelector('.gallery-more').dispatchEvent(new MouseEvent('click')); }); await requested(failed);
      assert.equal(await page.evaluate(() => fixture.state.gallery.visibleLimit), 1080); assert.equal(await page.evaluate(url => __transport.started[url], failed.url), 1); failed.release(); await settled(page, failed);
      assert((await read(page)).row && (await read(page)).focused); assert.match(await page.locator('.gallery-more').innerText(), /重试/);
      const retry = hold(url => url.pathname === '/api/image-library/items' && url.searchParams.get('offset') === '1000'); await page.evaluate(() => document.querySelector('.gallery-more').click()); await requested(retry); assert.equal(new URL(retry.url, base).searchParams.get('limit'), '80'); retry.release(); await settled(page, retry);
      assert.equal((await read(page)).rows, 1080); assert((await read(page)).row && (await read(page)).focused);
    } finally { failed.release(); await page?.close(); oracle = null; owner.close(); }
  });
  await run('TV metadata same-key replacement retains other cards and focused current action', async () => {
    const owner = createMetadataChannelOracle({ mode: 'tv', count: 160 }); oracle = owner; let page;
    try {
      page = await newPage({ mode: 'tv', count: 80, oracleSeed: true }); await snapshot(page); const id = await page.evaluate(() => fixture.state.gallery.list.items[7].id); owner.updateMetadata(id, { title: 'Updated private TV title' });
      await page.evaluate(() => { window.__unchanged = document.querySelector('.gallery-tv-series-card'); void fixture.page.loadImageLibraryItems({ force: true }); }); await page.waitForFunction(() => !fixture.page.isImageLibraryListLoading()); await frames(page);
      assert(await page.evaluate(() => __unchanged.isConnected && !__row.isConnected && document.activeElement.textContent.includes('Updated private TV title')));
      await page.locator('.gallery-tv-series-card').filter({ hasText: 'Updated private TV title' }).click(); assert.equal(await page.evaluate(() => fixture.state.gallery.seriesKey), id);
    } finally { await page?.close(); oracle = null; owner.close(); }
  });
  await run('TV source grouping changes use full fallback and complete current group order', async () => {
    const owner = createMetadataChannelOracle({ mode: 'tv', count: 160 }); oracle = owner; let page;
    try {
      page = await newPage({ mode: 'tv', count: 80, oracleSeed: true }); await snapshot(page); owner.mergeSeries('O9', 'O8'); const expected = owner.ids({ limit: '80' });
      await page.evaluate(() => { void fixture.page.loadImageLibraryItems({ force: true }); }); await page.waitForFunction(() => !fixture.page.isImageLibraryListLoading()); await frames(page);
      assert.equal((await read(page)).row, false); assert.deepEqual(await page.evaluate(() => fixture.state.gallery.list.items.map(value => value.id)), expected); assert.equal(await page.locator('.gallery-tv-series-card').count(), 80);
    } finally { await page?.close(); oracle = null; owner.close(); }
  });
  for (const mode of ["photo", "tv"]) await run(`actual backend 100 ${mode}: rescan/metadata reorder matches complete EOF oracle`, async () => {
    oracle = createChannelOracle({ mode, maxItemLimit: 30 });
    const page = await newPage({ mode, count: 24, oracleSeed: true });
    try {
      const before = await page.evaluate(() => fixture.state.gallery.list.listRevision);
      oracle.reorder(await page.evaluate(() => fixture.state.gallery.list.items.at(-1).id));
      const complete = []; for (let offset = 0; offset < 100; offset += 30) complete.push(...oracle.ids({ limit: '30', offset: String(offset), ...(mode === 'tv' ? { tvView: 'series' } : {}) }));
      assert.notEqual(oracle.payload().listRevision, before, 'actual owner revision must change on rescan/metadata edit');
      for (let attempt = 0; attempt < 8; attempt++) {
        if (await page.locator('.gallery-more').count() === 0) break;
        await page.evaluate(() => { document.querySelector('.gallery-more').click(); });
        await page.waitForFunction(() => !fixture.page.isImageLibraryListLoading()); await frames(page);
      }
      assert.deepEqual(await page.evaluate(() => fixture.state.gallery.list.items.map(value => value.id)), complete, 'new snapshot prefix must contain every real backend result in order');
      assert.equal(await page.locator('.gallery-more').count(), 0); assert.equal(await page.evaluate(() => fixture.state.gallery.list.rawLoaded), 100);
      console.log(JSON.stringify({ kind: 'actual-backend-oracle', client: 'web', mode, rows: complete.length }));
    } finally { oracle = null; await page.close(); }
  });
  await run("mixed revision prefix bounded retries retain old list and explicit retry recovers", async () => {
    const page = await newPage(), tail = hold(url => url.pathname === '/api/image-library/items' && url.searchParams.get('offset') === '80', { ...body(80, 80), listRevision: 'new' });
    const prefixes = Array.from({ length: 3 }, (_, index) => [hold(url => url.pathname === '/api/image-library/items' && url.searchParams.get('offset') === '0', { ...body(30), listRevision: `prefix-${index}`, nextOffset: 30 }), hold(url => url.pathname === '/api/image-library/items' && url.searchParams.get('offset') === '30', { ...body(30, 30), listRevision: `different-${index}`, nextOffset: 60 })]);
    try {
      await snapshot(page); await page.evaluate(() => document.querySelector('.gallery-more').click()); await requested(tail); tail.release();
      for (const pair of prefixes) for (const gate of pair) { await requested(gate); gate.release(); await settled(page, gate); }
      await page.waitForFunction(() => Boolean(fixture.state.gallery.listError));
      assert((await read(page)).row); assert.equal(await page.evaluate(() => fixture.state.gallery.list.rawLoaded), 80); assert.match(await page.locator('.gallery-more').innerText(), /重试/);
      const retry = hold(url => url.pathname === '/api/image-library/items' && url.searchParams.get('offset') === '80', { ...body(80, 80), listRevision: 'stable-new' }), prefix = hold(url => url.pathname === '/api/image-library/items' && url.searchParams.get('offset') === '0', { ...body(160), listRevision: 'stable-new', nextOffset: 160 });
      await page.evaluate(() => document.querySelector('.gallery-more').click()); await requested(retry); retry.release(); await requested(prefix); assert.equal(new URL(prefix.url, base).searchParams.get('limit'), '160'); prefix.release(); await settled(page, prefix);
      assert.equal(await page.locator('.gallery-photo-album-card').count(), 160); assert.equal(await page.evaluate(() => fixture.state.gallery.list.rawLoaded), 160);
    } finally { tail.release(); prefixes.flat().forEach(gate => gate.release()); await page.close(); }
  });
  await run("duplicate-heavy revision rebuild consumes raw prefix without chasing unique count", async () => {
    const page = await newPage(), tail = hold(url => url.pathname === '/api/image-library/items' && url.searchParams.get('offset') === '80', { ...body(80, 80), listRevision: 'duplicate-new' }), first = hold(url => url.pathname === '/api/image-library/items' && url.searchParams.get('offset') === '0', { ...body(100), items: Array.from({ length: 100 }, () => item(1)), nextOffset: 100, listRevision: 'duplicate-new' }), last = hold(url => url.pathname === '/api/image-library/items' && url.searchParams.get('offset') === '100', { ...body(60), items: Array.from({ length: 60 }, () => item(2)), nextOffset: 160, listRevision: 'duplicate-new' });
    try {
      await page.evaluate(() => document.querySelector('.gallery-more').click()); await requested(tail); tail.release(); await requested(first); first.release(); await requested(last); assert.equal(new URL(last.url, base).searchParams.get('limit'), '60'); last.release(); await settled(page, last);
      assert.deepEqual(await page.evaluate(() => ({ raw: fixture.state.gallery.list.rawLoaded, ids: fixture.state.gallery.list.items.map(value => value.id) })), { raw: 160, ids: ['I1', 'I2'] });
    } finally { tail.release(); first.release(); last.release(); await page.close(); }
  });
  await run("same-key forced refresh supersedes old append without clearing newer loading", async () => {
    const page = await newPage(), old = hold(url => url.pathname === '/api/image-library/items' && url.searchParams.get('offset') === '80', body(80, 80)), current = hold(url => url.pathname === '/api/image-library/items' && url.searchParams.get('offset') === '0', body(160, 1000));
    try {
      await page.evaluate(() => document.querySelector('.gallery-more').click()); await requested(old); await page.evaluate(() => { void fixture.page.loadImageLibraryItems({ force: true }); }); await requested(current); old.release(); await settled(page, old);
      assert(await page.evaluate(() => fixture.page.isImageLibraryListLoading())); current.release(); await settled(page, current); assert.equal(await page.evaluate(() => fixture.state.gallery.list.items[0].id), 'I1001'); assert.equal(await page.evaluate(() => fixture.state.gallery.list.items.length), 160);
    } finally { old.release(); current.release(); await page.close(); }
  });
  await run("actual backend 6000 capped first load and force refresh commit complete prefix once", async () => {
    oracle = createChannelOracle({ count: 6000, maxItemLimit: 5000 });
    const first = hold(url => url.pathname === '/api/image-library/items' && url.searchParams.get('offset') === '5000');
    const page = await newPage({ count: 6000, emptySeed: true });
    try {
      await requested(first); assert.equal(await page.evaluate(() => fixture.state.gallery.list?.items?.length || 0), 0, '5000-row partial prefix must not publish'); assert.equal(await page.locator('.gallery-photo-album-card').count(), 0);
      first.release(); await settled(page, first); await page.waitForFunction(() => !fixture.page.isImageLibraryListLoading()); assert.equal(await page.evaluate(() => fixture.state.gallery.list.rawLoaded), 6000); assert.equal(await page.locator('.gallery-photo-album-card').count(), 6000); await snapshot(page);
      const tail = hold(url => url.pathname === '/api/image-library/items' && url.searchParams.get('offset') === '5000');
      await page.evaluate(() => { void fixture.page.loadImageLibraryItems({ force: true }); }); await requested(tail); assert.equal(await page.evaluate(() => fixture.state.gallery.list.rawLoaded), 6000); assert((await read(page)).row); tail.release(); await settled(page, tail); await page.waitForFunction(() => !fixture.page.isImageLibraryListLoading());
      assert.equal(await page.evaluate(() => fixture.state.gallery.list.rawLoaded), 6000); assert.equal(await page.locator('.gallery-photo-album-card').count(), 6000); assert((await read(page)).row);
    } finally { first.release(); oracle = null; await page.close(); }
  });
  for (const navigation of ['query', 'leave', 'reader']) await run(`rebase prefix ${navigation} navigation preserves its current surface/status`, async () => {
    const page = await newPage(), tail = hold(url => url.pathname === '/api/image-library/items' && url.searchParams.get('offset') === '80', { ...body(80, 80), listRevision: 'changed' }), prefix = hold(url => url.pathname === '/api/image-library/items' && url.searchParams.get('offset') === '0' && !url.searchParams.has('q'), { ...body(160), listRevision: 'changed', nextOffset: 160 });
    try {
      await page.evaluate(() => document.querySelector('.gallery-more').click()); await requested(tail); tail.release(); await requested(prefix);
      if (navigation === 'reader') { await page.evaluate(() => fixture.page.openPhotoSet('I2')); await page.waitForFunction(() => fixture.state.gallery.album?.id === 'I2'); await page.evaluate(() => { window.__reader = document.querySelector('.gallery-reader-figure'); fixture.page.setStatus('Current reader status'); }); }
      else if (navigation === 'leave') await page.evaluate(() => { fixture.state.activeView = 'other'; document.querySelector('#workGrid').textContent = 'Private other view'; });
      else { await page.evaluate(() => { fixture.page.applyRouteState({ galleryMode: 'photo', galleryPhotoView: 'albums', galleryQuery: 'current' }); fixture.renderer.renderView(); }); await page.waitForFunction(() => !fixture.page.isImageLibraryListLoading()); }
      prefix.release(); await settled(page, prefix);
      if (navigation === 'reader') { assert(await page.evaluate(() => __reader.isConnected)); assert.equal(await page.evaluate(() => fixture.state.gallery.status), 'Current reader status'); assert.equal(await page.evaluate(() => fixture.state.gallery.list.rawLoaded), 160); }
      else if (navigation === 'leave') { assert.equal(await page.locator('#workGrid').innerText(), 'Private other view'); assert.equal(await page.evaluate(() => fixture.state.gallery.list.rawLoaded), 80); }
      else assert.equal(await page.evaluate(() => fixture.state.gallery.query), 'current');
    } finally { tail.release(); prefix.release(); await page.close(); }
  });
  for (const mode of ["photo", "manga", "media"]) for (const count of [80, 1000]) await run(`${mode} ${count}: loading and append retain rows/images/focus/observer`, async () => {
    const page = await newPage({ mode, count }), gate = hold(url => url.pathname === "/api/image-library/items" && url.searchParams.get("offset") === String(count), body(80, count, mode));
    try {
      const cdp = await page.context().newCDPSession(page); await cdp.send("Performance.enable");
      await snapshot(page); const before = await metrics(cdp);
      await page.evaluate(() => { const more = document.querySelector('.gallery-more'); more.click(); more.dispatchEvent(new MouseEvent('click')); }); await requested(gate);
      const loading = await read(page), pending = await metrics(cdp);
      if (legacy) console.log(JSON.stringify({ mode: "legacy-list-loading", libraryMode: mode, count, loading }));
      assert.equal(loading.row, true, "loading must retain the actual old card"); assert.equal(loading.image, true); assert.equal(loading.focused, true); assert.equal(loading.observer, true); assert.equal(loading.created, 0); assert.equal(loading.renders.length, 0);
      assert.equal(await page.locator('.gallery-more').isDisabled(), true); assert.equal(await page.evaluate(url => __transport.started[url], gate.url), 1);
      gate.release(); await settled(page, gate); await frames(page);
      const success = await read(page), after = await metrics(cdp);
      assert.equal(success.row, true); assert.equal(success.image, true); assert.equal(success.focused, true); assert.equal(success.observer, true); assert.equal(success.observedChanges > 0, true);
      assert.equal(success.rows, count + 80); assert.equal(success.renders.length, 0); assert(success.created < 1400, "creation must depend on the new page, not the mounted list");
      assert.equal(success.scroll, loading.scroll); assert.equal(await page.evaluate(() => fixture.state.gallery.list.rawLoaded), count + 80);
      assert.equal(await page.evaluate(() => [...__coverObservers].every(observer => [...observer.counts.values()].every(value => value === 1))), true);
      console.log(JSON.stringify({ mode: "incremental-gallery", libraryMode: mode, count, loading, success, loadingCpu: delta(before, pending), responseCpu: delta(pending, after) }));
    } finally { gate.release(); await page.close(); }
  });
  await run("same-ID metadata replaces only its card and keeps focus and current click metadata", async () => {
    const page = await newPage({ mode: "photo" }), gate = hold(url => url.pathname === "/api/image-library/items", { ...body(1, 80), items: [item(8, "photo", { title: "Updated metadata", imageCount: 999, coverUrl: "/synthetic/updated.svg" }), item(81)] });
    try {
      await snapshot(page); await page.evaluate(() => { window.__unchanged = document.querySelectorAll('.gallery-photo-album-card')[0]; window.__oldTarget = __row; document.querySelector('.gallery-more').click(); }); await requested(gate); gate.release(); await settled(page, gate);
      assert.equal(await page.evaluate(() => __unchanged.isConnected && !__oldTarget.isConnected && document.activeElement.textContent.includes('Updated metadata')), true);
      assert.equal(await page.locator('.gallery-photo-album-card').count(), 81); assert.equal(await page.locator('.gallery-photo-album-card').filter({ hasText: "Updated metadata" }).count(), 1);
      await page.locator('.gallery-photo-album-card').filter({ hasText: "Updated metadata" }).click(); await page.waitForFunction(() => fixture.state.gallery.album?.id === 'I8');
      assert.equal(await page.locator('.gallery-reader-title strong').textContent(), "Reader I8");
    } finally { gate.release(); await page.close(); }
  });
  await run("duplicates preserve first order/latest metadata and advance raw offset to EOF", async () => {
    const page = await newPage(), first = hold(url => url.pathname === "/api/image-library/items" && url.searchParams.get("offset") === "80", { ...body(2), items: [item(1, "photo", { title: "Latest one" }), item(81)], total: 84 });
    try {
      await snapshot(page); await page.evaluate(() => document.querySelector('.gallery-more').click()); await requested(first); first.release(); await settled(page, first);
      assert.deepEqual(await page.evaluate(() => ({ ids: fixture.state.gallery.list.items.slice(0, 2).map(item => item.id), last: fixture.state.gallery.list.items.at(-1).id, raw: fixture.state.gallery.list.rawLoaded })), { ids: ["I1", "I2"], last: "I81", raw: 82 });
      const last = hold(url => url.pathname === "/api/image-library/items" && url.searchParams.get("offset") === "82", { items: [item(81), item(82)], total: 84, facets: {} });
      await page.evaluate(() => document.querySelector('.gallery-more').click()); await requested(last); last.release(); await settled(page, last);
      assert.equal(await page.locator('.gallery-more').count(), 0); assert.equal(await page.locator('.gallery-photo-album-card').count(), 82); assert.equal(await page.evaluate(() => fixture.state.gallery.list.rawLoaded), 84);
      const reads = requests.length; await page.evaluate(() => fixture.page.loadImageLibraryItems()); assert.equal(requests.length, reads);
    } finally { first.release(); await page.close(); }
  });
  await run("current page failure preserves nodes and retry uses the same offset/limit", async () => {
    const page = await newPage(), failed = hold(url => url.pathname === "/api/image-library/items" && url.searchParams.get("offset") === "80", null, "controlled current error");
    try {
      await snapshot(page); await page.evaluate(() => document.querySelector('.gallery-more').click()); await requested(failed); failed.release(); await settled(page, failed);
      assert.equal((await read(page)).row, true); assert.match(await page.locator('.gallery-more').textContent(), /重试/); assert.equal(await page.locator('.gallery-more').isDisabled(), false);
      const retry = hold(url => url.pathname === "/api/image-library/items" && url.searchParams.get("offset") === "80", body(80, 80));
      await page.evaluate(() => document.querySelector('.gallery-more').click()); await requested(retry); assert.equal(new URL(retry.url, base).searchParams.get("limit"), "80"); retry.release(); await settled(page, retry);
      assert.equal((await read(page)).rows, 160); assert.equal((await read(page)).row, true);
    } finally { failed.release(); await page.close(); }
  });
  await run("append without total retains its known total and continues at the raw offset", async () => {
    const page = await newPage(), first = hold(url => url.pathname === "/api/image-library/items", { items: [item(81)] });
    try {
      await page.evaluate(() => document.querySelector('.gallery-more').click()); await requested(first); first.release(); await settled(page, first);
      assert.deepEqual(await page.evaluate(() => ({ total: fixture.state.gallery.list.total, raw: fixture.state.gallery.list.rawLoaded, hasMore: fixture.state.gallery.list.hasMore })), { total: 5000, raw: 81, hasMore: true });
      const next = hold(url => url.pathname === "/api/image-library/items" && url.searchParams.get('offset') === '81', { items: [item(82)], total: 82 });
      await page.evaluate(() => document.querySelector('.gallery-more').click()); await requested(next); next.release(); await settled(page, next);
      assert.equal(await page.locator('.gallery-photo-album-card').count(), 82); assert.equal(await page.locator('.gallery-more').count(), 0);
    } finally { first.release(); await page.close(); }
  });
  for (const ignoreAbort of [false, true]) for (const error of ["", "obsolete page error"]) await run(`${ignoreAbort ? "ignored" : "normal"} abort: changed query rejects old ${error ? "error" : "success"} and old finally`, async () => {
    const page = await newPage({ ignoreAbort }), old = hold(url => url.pathname === "/api/image-library/items" && url.searchParams.get("offset") === "80", body(80, 80), error);
    const current = hold(url => url.pathname === "/api/image-library/items" && url.searchParams.get("q") === "current", body(80, 1000));
    try {
      await snapshot(page); await page.evaluate(() => document.querySelector('.gallery-more').click()); await requested(old);
      await page.evaluate(() => { fixture.page.applyRouteState({ galleryMode: 'photo', galleryPhotoView: 'albums', galleryQuery: 'current' }); fixture.renderer.renderView(); }); await requested(current);
      assert.equal(await page.evaluate(() => __row.isConnected), false, "query change must legitimately replace the previous view");
      old.release(); if (ignoreAbort) await settled(page, old); else await page.waitForFunction(url => __transport.aborted.includes(url), old.url);
      assert.equal(await page.evaluate(() => fixture.page.isImageLibraryListLoading()), true); assert(!(await page.locator('#workGrid').innerText()).includes("obsolete page error"));
      current.release(); await settled(page, current); assert.equal(await page.locator('.gallery-photo-album-card').first().innerText().then(value => value.includes("Synthetic 1001")), true);
    } finally { old.release(); current.release(); await page.close(); }
  });
  for (const mode of ["photo", "manga", "media"]) await run(`${mode}: late summary patches consumers and preserves search/select/list`, async () => {
    const page = await newPage({ mode }), summary = hold(url => url.pathname === "/api/image-library/summary");
    try {
      await snapshot(page); await page.evaluate(() => { window.__search = document.querySelector('.gallery-search'); window.__select = document.querySelector('select.gallery-select'); __search.focus(); __search.value = 'unsubmitted draft'; __search.setSelectionRange(3, 9); window.__task = fixture.page.loadImageLibrary({ reload: true }); }); await requested(summary); summary.release(); await page.evaluate(() => __task); await frames(page);
      assert.equal(await page.evaluate(() => __row.isConnected && __image.isConnected && __search.isConnected && document.activeElement === __search && __search.value === 'unsubmitted draft' && __search.selectionStart === 3 && __search.selectionEnd === 9), true);
      assert.equal((await read(page)).observer, true); assert.equal((await read(page)).renders.length, 0); assert.equal(await page.evaluate(() => __select?.isConnected ?? true), true);
      if (mode === "photo") assert.match(await page.locator('.gallery-browse-header p').textContent(), /12,345/);
      if (mode === "media") {
        assert.equal(await page.locator('select.gallery-select option[value="late"]').textContent(), "late");
        assert.match(await page.locator('select.gallery-select option[value="late"]').getAttribute("title"), /777/);
      }
      await page.evaluate(() => { __search.value = 'current'; const field = __search.closest('.gallery-search-field, .gallery-media-search-field'); const button = field.querySelector('button'); if(button)button.click();else __search.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); });
      await page.waitForFunction(() => fixture.state.gallery.query === 'current' && !fixture.page.isImageLibraryListLoading());
      if (mode === "media") { await page.locator('select.gallery-select').first().selectOption('all'); await page.waitForFunction(() => fixture.state.gallery.category === 'all'); }
    } finally { summary.release(); await page.close(); }
  });
  await run("summary retained select listeners use the updated control value", async () => {
    const page = await newPage({ mode: "media" }); try {
      await page.evaluate(() => { window.__select = document.querySelector('select.gallery-select'); return fixture.page.loadImageLibrary({ reload: true }); });
      assert.equal(await page.evaluate(() => __select.isConnected), true); await page.locator('select.gallery-select').first().selectOption('late');
      await page.waitForFunction(() => fixture.state.gallery.category === 'late' && !fixture.page.isImageLibraryListLoading());
      assert(requests.some(value => new URL(value, base).searchParams.get('category') === 'late'));
    } finally { await page.close(); }
  });
  await run("same-ID movie metadata replacement keeps button focus and its actual navigation event", async () => {
    const page = await newPage({ mode: "media" }), gate = hold(url => url.pathname === "/api/image-library/items", { ...body(1, 80, "media"), items: [item(8, "media", { movieMetadata: { title: "Updated movie", year: 2026, rating: 9.5 } }), item(81, "media")] });
    try {
      await snapshot(page); await page.evaluate(() => document.querySelector('.gallery-more').click()); await requested(gate); gate.release(); await settled(page, gate);
      assert.equal(await page.evaluate(() => !__row.isConnected && document.activeElement.matches('button.gallery-movie-list-item') && document.activeElement.textContent.includes('Updated movie')), true);
      await page.locator('.gallery-movie-list-item').filter({ hasText: 'Updated movie' }).click(); await page.waitForURL('**/player.html?**');
      assert.equal(new URL(page.url()).searchParams.get('mediaId'), 'I8');
    } finally { gate.release(); await page.close(); }
  });
  await run("forced reordered result uses full fallback and preserves server order", async () => {
    const page = await newPage(), gate = hold(url => url.pathname === "/api/image-library/items", { ...body(80), items: [...body(80).items].reverse() });
    try { await snapshot(page); await page.evaluate(() => { window.__task = fixture.page.loadImageLibraryItems({ force: true }); }); await requested(gate); gate.release(); await page.evaluate(() => __task); assert.equal(await page.evaluate(() => __row.isConnected), false); assert.match(await page.locator('.gallery-photo-album-card').first().innerText(), /Synthetic 80/); }
    finally { gate.release(); await page.close(); }
  });
  await run("missing IDs use complete fallback without dropping unnamed rows", async () => {
    const page = await newPage(); try {
      await page.evaluate(data => fixture.seed(data), { ...body(3), items: [item(1), item(2, "photo", { id: "" }), item(3, "photo", { id: "" })] });
      await snapshot(page); const gate = hold(url => url.pathname === "/api/image-library/items", { ...body(1, 3), total: 4 });
      await page.evaluate(() => document.querySelector('.gallery-more').click()); await requested(gate); gate.release(); await settled(page, gate);
      assert.equal(await page.locator('.gallery-photo-album-card').count(), 4); assert.equal(await page.evaluate(() => __row.isConnected), false);
    } finally { await page.close(); }
  });
  await run("grouped collection sorting retains its full render fallback", async () => {
    const page = await newPage(); try {
      await page.evaluate(data => fixture.seed(data, { photoView: 'collections', sort: 'count', visibleLimit: 80 }), { items: [{ id: 'group', type: 'photoCategory', collections: Array.from({ length: 100 }, (_, index) => ({ id: `C${index}`, collectionId: `C${index}`, title: `Collection ${index}`, albumCount: index + 1, coverUrl: '/synthetic/group.svg' })) }], total: 1, facets: {} });
      await page.evaluate(() => { window.__groupCard = document.querySelector('.gallery-collection-card'); document.querySelector('.gallery-more').click(); }); await frames(page);
      assert.equal(await page.evaluate(() => __groupCard.isConnected), false); assert.equal(await page.locator('.gallery-collection-card').count(), 100); assert.match(await page.locator('.gallery-collection-card').first().innerText(), /Collection 99/);
    } finally { await page.close(); }
  });
  for (const empty of [true, false]) await run(`${empty ? "empty" : "final"} page hides load-more without an endless retry`, async () => {
    const page = await newPage(), gate = hold(url => url.pathname === "/api/image-library/items", body(empty ? 0 : 3, 80, "photo", { total: empty ? 5000 : 83 }));
    try { await snapshot(page); await page.evaluate(() => document.querySelector('.gallery-more').click()); await requested(gate); gate.release(); await settled(page, gate); assert.equal(await page.locator('.gallery-more').count(), 0); assert.equal((await read(page)).row, true); const before = requests.length; await page.evaluate(() => fixture.page.loadImageLibraryItems()); assert.equal(requests.length, before); }
    finally { gate.release(); await page.close(); }
  });
  for (const error of ["", "obsolete list failure"]) await run(`list late ${error ? "error" : "success"} while the image reader is open preserves reader/pager/status`, async () => {
    const page = await newPage(), gate = hold(url => url.pathname === "/api/image-library/items", body(80, 80, "photo", { scannedAt: "2026-10-04" }), error);
    try {
      await page.evaluate(() => document.querySelector('.gallery-more').click()); await requested(gate); await page.evaluate(() => fixture.page.openPhotoSet('I1'));
      await page.locator('.gallery-reader-figure').first().click(); await page.waitForSelector('.gallery-image-pager');
      await page.evaluate(() => { window.__figure = document.querySelector('.gallery-reader-figure'); window.__pager = document.querySelector('.gallery-image-pager'); window.__readerImage = __figure.querySelector('img'); window.__readerStatus = fixture.state.gallery.status; __renders.length = 0; });
      gate.release(); await settled(page, gate); assert.equal(await page.evaluate(() => __figure.isConnected && __pager.isConnected && __readerImage.isConnected && fixture.state.gallery.album.id === 'I1' && fixture.state.gallery.status === __readerStatus && __renders.length === 0), true);
    } finally { gate.release(); await page.close(); }
  });
  for (const error of ["", "obsolete list failure"]) await run(`old list ${error ? "error" : "success"} cannot clear a newer pending reader status or rebuild its view`, async () => {
    const page = await newPage(), list = hold(url => url.pathname === "/api/image-library/items", body(80, 80, "photo", { scannedAt: "2026-10-04" }), error), reader = hold(url => url.pathname === "/api/photo-sets/I1");
    try {
      await snapshot(page); await page.evaluate(() => document.querySelector('.gallery-more').click()); await requested(list);
      await page.evaluate(() => { window.__readerTask = fixture.page.openPhotoSet('I1'); }); await requested(reader);
      const status = await page.evaluate(() => fixture.state.gallery.status); assert.match(status, /正在读取/);
      list.release(); await settled(page, list); assert.equal(await page.evaluate(() => fixture.state.gallery.status), status); assert.equal((await read(page)).row, true); assert.equal((await read(page)).renders.length, 0);
      reader.release(); await page.evaluate(() => __readerTask); assert.equal(await page.locator('.gallery-reader-title strong').textContent(), 'Reader I1');
    } finally { list.release(); reader.release(); await page.close(); }
  });
  const mediaData = richMediaBody();
  for (const width of [1280, 900, 390]) await run("poster copy " + width + ": actual skipping, equal geometry and three diagnostic samples", async () => {
    const samples = { current: [], reference: [] };
    for (let repeat = 0; repeat < 3; repeat++) for (const reference of [false, true]) {
      const page = await newPage({ mode: "media" }), gate = hold(url => url.pathname === "/api/image-library/items" && url.searchParams.get("offset") === "1000", body(80, 1000, "media"));
      try {
        await page.setViewportSize({ width, height: 900 }); if (reference) await disablePosterVisibility(page);
        const cdp = await page.context().newCDPSession(page); await cdp.send("Performance.enable"); const before = await metrics(cdp);
        const domMs = await page.evaluate(data => { const started = performance.now(); fixture.seed(data, { visibleLimit: 1000 }); return performance.now() - started; }, mediaData);
        await frames(page); const full = delta(before, await metrics(cdp)), geometry = await mediaGeometry(page);
        assert.equal(await deepCopySkipped(page), !reference, "unvisited offscreen copy must actually skip layout/paint");
        assert.equal(await page.evaluate(() => document.querySelectorAll('.gallery-movie-list-item')[990].querySelector('img').hasAttribute('src')), false, "copy containment must not prefetch all covers");
        await snapshot(page); await page.evaluate(() => document.querySelector('.gallery-more').click()); await requested(gate);
        const beforeAppend = await metrics(cdp); gate.release(); await settled(page, gate); const append = delta(beforeAppend, await metrics(cdp)), identity = await read(page);
        assert(identity.row && identity.image && identity.focused && identity.observer); assert.equal(identity.rows, 1080);
        samples[reference ? "reference" : "current"].push({ domMs, full, append, geometry });
      } finally { gate.release(); await page.close(); }
    }
    for (let repeat = 0; repeat < 3; repeat++) assert.deepEqual(samples.current[repeat].geometry, samples.reference[repeat].geometry);
    const medians = values => ({ domMs: median(values.map(value => value.domMs)), full: medianMetrics(values.map(value => value.full)), append: medianMetrics(values.map(value => value.append)) });
    console.log(JSON.stringify({ mode: "poster-copy-visibility", width, current: medians(samples.current), reference: medians(samples.reference) }));
  });
  await run("same-node pure resize and poster/list round trips preserve unvisited row geometry", async () => {
    const current = await newPage({ mode: "media" }), reference = await newPage({ mode: "media" });
    try {
      await disablePosterVisibility(reference);
      for (const page of [current, reference]) { await page.evaluate(data => { fixture.seed(data, { visibleLimit: 1000 }); window.__stable = document.querySelectorAll('.gallery-movie-list-item')[990]; window.__io = __coverObservers.at(-1); }, mediaData); await frames(page); }
      const points = [[1280, "posters"], [1440, "posters"], [390, "posters"], [900, "posters"], [320, "posters"], [480, "posters"], [481, "posters"], [480, "posters"], [481, "posters"], [900, "list"], [900, "posters"], [390, "list"], [390, "posters"], [1280, "list"], [1280, "posters"]];
      for (const [width, layout] of points) {
        for (const page of [current, reference]) { await page.setViewportSize({ width, height: 900 }); await setMediaLayout(page, layout); await frames(page); }
        assert.deepEqual(await mediaGeometry(current), await mediaGeometry(reference), width + "/" + layout + ": document and card geometry must match old CSS exactly");
        assert.equal(await deepCopySkipped(current), layout === "posters");
        assert.deepEqual(await current.evaluate(() => ({ row: __stable.isConnected, io: __io === __coverObservers.at(-1) && !__io.off, rows: fixture.state.gallery.list.items.length, source: __stable.querySelector('img').getAttribute('src') })), { row: true, io: true, rows: 1000, source: null });
        if (width === 481 && layout === "posters") assert.deepEqual(await visibleMixedCopyGeometry(current), await visibleMixedCopyGeometry(reference), "scored TB/codec/TV/anime/series and missing metadata slots must fit naturally");
      }
    } finally { await current.close(); await reference.close(); }
  });
  await run("natural wheel, middle/end focus, cover IO, append and click keep poster resources", async () => {
    for (const width of [1280, 900, 390]) {
      const screenshots = [];
      for (const reference of [false, true]) {
        const page = await newPage({ mode: "media" }), gate = hold(url => url.pathname === "/api/image-library/items" && url.searchParams.get("offset") === "1000", body(80, 1000, "media", { total: 1080 }));
        try {
          await page.setViewportSize({ width, height: 900 }); if (reference) await disablePosterVisibility(page);
          await page.evaluate(data => fixture.seed(data, { visibleLimit: 1000 }), mediaData); await frames(page);
          screenshots.push(await exercisePosterInteractions(page, gate));
        } finally { gate.release(); await page.close(); }
      }
      await comparePosterPaint(screenshots[0], screenshots[1], width);
    }
  });
  await run("stable TV/anime series card keeps its actual series navigation", async () => {
    const page = await newPage({ mode: "media" });
    try {
      await page.evaluate(data => fixture.seed(data, { visibleLimit: 1000 }), mediaData); await frames(page);
      const card = page.locator('.gallery-movie-list-item').nth(2); await card.focus(); await frames(page); await card.click();
      assert.deepEqual(await page.evaluate(() => ({ kind: fixture.state.gallery.mediaKind, key: fixture.state.gallery.seriesKey, person: fixture.state.gallery.person })), { kind: 'anime', key: 'series-3', person: '合成动漫合集 3' });
    } finally { await page.close(); }
  });
  await run("unsupported content visibility retains the original responsive layout", async () => {
    const fallback = await newPage({ mode: "media", unsupportedVisibility: true }), reference = await newPage({ mode: "media" });
    try {
      await disablePosterVisibility(reference);
      for (const page of [fallback, reference]) { await page.evaluate(data => fixture.seed(data, { visibleLimit: 1000 }), mediaData); await frames(page); }
      for (const width of [1440, 900, 390, 480, 481, 480]) { for (const page of [fallback, reference]) { await page.setViewportSize({ width, height: 900 }); await frames(page); } assert.deepEqual(await mediaGeometry(fallback), await mediaGeometry(reference)); assert.equal(await deepCopySkipped(fallback), false); }
    } finally { await fallback.close(); await reference.close(); }
  });
  assert(checks > 0, "case filter must run an actual behavior scenario");
  assert.deepEqual(faults, []); assert.deepEqual(unexpected, []);
  console.log(`PASS gallery list rendering: ${checks} actual Chromium scenarios`);
} finally { for (const gate of held) gate.release(); await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

function send(res, text, type, cache = "no-store") { res.writeHead(200, { "Content-Type": type, "Cache-Control": cache }); res.end(text); }
function json(res, value, status = 200) { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); }
function hold(match, response = null, error = "") { let release, requestedResolve; const gate = { match, body: response, error, promise: new Promise(resolve => { release = resolve; }), requested: new Promise(resolve => { requestedResolve = resolve; }) }; Object.assign(gate, { release, requestedResolve }); held.add(gate); return gate; }
async function requested(gate) { let timer; try { await Promise.race([gate.requested, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("synthetic request did not start")), 5000); })]); } finally { clearTimeout(timer); } }
async function settled(page, gate) { const expected = await page.evaluate(url => __transport.started[url], gate.url); await page.waitForFunction(({ url, expected }) => __transport.settled.filter(value => value === url).length >= expected, { url: gate.url, expected }); await frames(page); }
async function frames(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function metrics(cdp) { return Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value])); }
function delta(before, after) { return { layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000, styleMs: (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000, taskMs: (after.TaskDuration - before.TaskDuration) * 1000 }; }
async function snapshot(page) {
  await page.evaluate(selector => { window.__row = document.querySelectorAll(selector)[7] || document.querySelector(selector); window.__image = __row.querySelector('img'); window.__coverObserver = __coverObservers.at(-1); __row.focus(); window.scrollTo(0, 400); window.__observed = 0; const observer = new MutationObserver(records => { __observed += records.length; }); observer.observe(__row, { attributes: true }); __row.dataset.fixtureObserved = 'true'; __created = 0; __renders.length = 0; }, cardSelector); await frames(page);
}
async function read(page) { return page.evaluate(selector => ({ row: __row.isConnected, image: __image.isConnected, focused: document.activeElement === __row, observer: !__coverObserver.off && __coverObservers.at(-1) === __coverObserver, observedChanges: __observed, rows: document.querySelectorAll(selector).length, created: __created, renders: __renders.slice(), scroll: scrollY }), cardSelector); }
async function newPage({ mode = "photo", count = 80, ignoreAbort = true, unsupportedVisibility = false, oracleSeed = false, emptySeed = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.on("pageerror", error => faults.push(error.message));
  await restrictPrivateNetwork(page, base, unexpected);
  await page.addInitScript(({ ignoreAbort }) => {
    window.__created = 0; window.__renders = []; window.__coverObservers = []; window.__transport = { started: {}, settled: [], aborted: [] };
    const create = document.createElement.bind(document); document.createElement = (...args) => { __created++; return create(...args); };
    const NativeObserver = window.IntersectionObserver; window.IntersectionObserver = class extends NativeObserver {
      constructor(callback, options) { super(callback, options); this.off = false; this.counts = new Map(); if (options?.rootMargin === '600px 0px') __coverObservers.push(this); }
      observe(node) { this.counts.set(node, (this.counts.get(node) || 0) + 1); super.observe(node); }
      disconnect() { this.off = true; super.disconnect(); }
    };
    const fetchImpl = window.fetch.bind(window); window.fetch = async (url, options = {}) => {
      const key = new URL(String(url), location.href), relative = key.pathname + key.search;
      __transport.started[relative] = (__transport.started[relative] || 0) + 1;
      options.signal?.addEventListener('abort', () => __transport.aborted.push(relative), { once: true });
      const response = await fetchImpl(url, ignoreAbort ? { ...options, cache: 'no-store', signal: undefined } : options), read = response.json.bind(response);
      response.json = async () => { try { return await read(); } finally { __transport.settled.push(relative); } }; return response;
    };
  }, { ignoreAbort });
  await page.goto(`${base}/probe?mode=${mode}&count=${count}${unsupportedVisibility ? "&unsupported=1" : ""}${oracleSeed ? "&oracle=1" : ""}${emptySeed ? "&empty=1" : ""}`); await page.waitForFunction(() => Boolean(window.fixture)); await frames(page); return page;
}
function median(values) { return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]; }
function medianMetrics(values) { return Object.fromEntries(["layoutMs", "styleMs", "taskMs"].map(key => [key, median(values.map(value => value[key]))])); }
function richMediaBody() {
  return body(1000, 0, "media", { items: Array.from({ length: 1000 }, (_, index) => {
    const i = index + 1, metadata = i % 4 === 0 ? {} : {
      title: i % 3 === 0 ? "复杂中文片名与一个非常长的副标题用于真实布局校准 " + i : "Synthetic " + i,
      year: 2026, countries: ["中华人民共和国"], genres: ["剧情", "悬疑", "Drama"],
      directors: ["合成导演名字", "Synthetic Director"], actors: ["Actor A", "很长的合成演员名字", "Actor C", "Actor D"],
      rating: i % 5 === 0 ? 0 : 8.1, ratingCount: 1234567
    };
    const value = item(i, "media", { coverUrl: i % 7 === 0 ? "" : "/synthetic/" + i + ".svg", ext: ["mp4", "webm", "rmvb"][i % 3], size: [1e7, 4e12, 123e12][i % 3], movieMetadata: metadata });
    if (i % 4 === 2 || i % 4 === 3) { value.mediaKind = i % 4 === 2 ? "tv" : "anime"; value.tvSeries = metadata; value.movieMetadata = null; }
    if (i % 8 === 3) { value.type = "tvSeriesWork"; value.seriesKey = "series-" + i; value.seriesName = "合成动漫合集 " + i; value.episodeCount = 12; }
    return value;
  }) });
}
async function disablePosterVisibility(page) {
  // Reconstruct the actual pre-change natural-height CSS, rather than comparing
  // against a reference that retains the new fixed slots and could hide clipping.
  await page.addStyleTag({ content: '.gallery-browse-shell .gallery-movie-explore[data-layout="posters"] .gallery-movie-list > .gallery-movie-list-item > .gallery-movie-list-copy{content-visibility:visible!important;block-size:auto!important;}' });
}
async function deepCopySkipped(page) { return page.evaluate(() => !document.querySelectorAll('.gallery-movie-list-title')[990].checkVisibility({ contentVisibilityAuto: true })); }
async function setMediaLayout(page, layout) { await page.evaluate(layout => { document.querySelector('.gallery-layout-switch button[data-layout="' + layout + '"]').click(); scrollTo(0, 0); }, layout); }
async function mediaGeometry(page) {
  return page.evaluate(() => {
    const cards = document.querySelectorAll('.gallery-movie-list-item');
    return { bodyHeight: document.body.scrollHeight, listHeight: document.querySelector('.gallery-movie-list').getBoundingClientRect().height, firstCopyHeight: cards[0].querySelector('.gallery-movie-list-copy').getBoundingClientRect().height,
      // Only measure outer boxes: asking for deep child rects would unskip them.
      cards: [0, 499, 990, 999].map(index => { const r = cards[index].getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }) };
  });
}
async function exercisePosterInteractions(page, gate) {
  const height = (await mediaGeometry(page)).listHeight; await page.mouse.wheel(0, Math.floor(height * .45));
  await page.waitForFunction(() => scrollY > 10000); await frames(page);
  assert.equal(await page.evaluate(() => { const row = [...document.querySelectorAll('.gallery-movie-list-item')].find(node => { const r = node.getBoundingClientRect(); return r.top > 0 && r.bottom < innerHeight; }); return row.querySelector('.gallery-movie-list-title').checkVisibility({ contentVisibilityAuto: true }); }), true);
  for (const index of [499, 999]) {
    await page.evaluate(index => { window.__target = document.querySelectorAll('.gallery-movie-list-item')[index]; if (index === 999) __target.scrollIntoView({ block: 'center', behavior: 'instant' }); __target.focus(); }, index); await frames(page);
    await page.waitForFunction(() => __target.querySelector('img')?.complete && __target.querySelector('img')?.naturalWidth > 0);
    assert.equal(await page.evaluate(() => {
      const r = __target.getBoundingClientRect(), copy = __target.querySelector('.gallery-movie-list-copy'), c = copy.getBoundingClientRect();
      return document.activeElement === __target && r.top >= 0 && r.bottom <= innerHeight && copy.querySelector('strong').checkVisibility({ contentVisibilityAuto: true })
        && [...copy.children].filter(node => getComputedStyle(node).display !== 'none').every(node => { const rect = node.getBoundingClientRect(); return rect.top >= c.top - .01 && rect.bottom <= c.bottom + .01; });
    }), true, "focused text and its children must be visible and unclipped");
  }
  await page.evaluate(() => { window.__last = __target; window.__img = __target.querySelector('img'); window.__io = __coverObservers.at(-1); document.querySelector('.gallery-more').click(); });
  await requested(gate); gate.release(); await settled(page, gate);
  assert.deepEqual(await page.evaluate(() => ({ row: __last.isConnected, image: __img.isConnected, io: __io === __coverObservers.at(-1) && !__io.off, focus: document.activeElement === __last, state: fixture.state.gallery.list.items.length, rows: document.querySelectorAll('.gallery-movie-list-item').length })), { row: true, image: true, io: true, focus: true, state: 1080, rows: 1080 });
  await page.evaluate(() => document.querySelectorAll('.gallery-movie-list-item')[1079].scrollIntoView({ block: 'center', behavior: 'instant' })); await frames(page);
  await page.waitForFunction(() => document.querySelectorAll('.gallery-movie-list-item')[1079].querySelector('img').naturalWidth > 0);
  await page.evaluate(() => { document.querySelector('.gallery-movie-list-item').focus(); scrollTo(0, 0); }); await frames(page);
  await page.addStyleTag({ content: '.gallery-movie-list-poster{transition:none!important;}' }); await page.locator('.gallery-movie-list-item').first().hover(); await frames(page);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.gallery-movie-list-item')).contentVisibility), 'visible');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.gallery-movie-list-item')).outlineStyle), 'solid');
  const paint = await page.evaluate(() => {
    const r = document.querySelector('.gallery-movie-list-item').getBoundingClientRect(), c = document.querySelector('.gallery-movie-list-copy').getBoundingClientRect(), x = Math.max(0, r.x - 6);
    return { clip: { x, y: r.y - 6, width: Math.min(innerWidth, r.right + 6) - x, height: r.height + 12 }, copy: c.toJSON(), caption: copyChildren(document.querySelector('.gallery-movie-list-copy')) };
    function copyChildren(copy) { return [...copy.querySelectorAll('*')].filter(node => getComputedStyle(node).display !== 'none').map(node => ({ text: node.textContent, font: getComputedStyle(node).font, rect: node.getBoundingClientRect().toJSON() })); }
  });
  const screenshot = await page.screenshot({ clip: paint.clip, animations: 'disabled' });
  await page.locator('.gallery-movie-list-item').filter({ hasText: 'Synthetic 1080' }).click(); await page.waitForURL(/player.html/); assert.equal(new URL(page.url()).searchParams.get('mediaId'), 'I1080');
  return { ...paint, png: screenshot };
}
async function visibleMixedCopyGeometry(page) {
  const results = [];
  for (let index = 0; index < 8; index++) {
    await page.evaluate(index => document.querySelectorAll('.gallery-movie-list-item')[index].scrollIntoView({ block: 'center', behavior: 'instant' }), index); await frames(page);
    results.push(await page.evaluate(index => {
      const copy = document.querySelectorAll('.gallery-movie-list-item')[index].querySelector('.gallery-movie-list-copy'), c = copy.getBoundingClientRect();
      return { height: c.height, visible: copy.querySelector('strong').checkVisibility({ contentVisibilityAuto: true }), children: [...copy.children].filter(node => getComputedStyle(node).display !== 'none').map(node => { const r = node.getBoundingClientRect(); return { text: node.textContent, top: r.top - c.top, bottom: r.bottom - c.top, height: r.height }; }) };
    }, index));
    const result = results.at(-1); assert(result.visible); for (const child of result.children) assert(child.top >= 0 && child.bottom <= result.height, "every visible mixed metadata row must fit inside the copy box");
  }
  await page.evaluate(() => scrollTo(0, 0)); await frames(page); return results;
}
async function comparePosterPaint(current, reference, width) {
  assert.deepEqual(current.copy, reference.copy); assert.deepEqual(current.caption, reference.caption, "visible text, font and glyph boxes must match natural-height CSS");
  const page = await browser.newPage();
  try {
    const pixels = await page.evaluate(async ({ images, copy, clip }) => {
      const decoded = [];
      for (const uri of images) { const image = new Image(); image.src = uri; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; canvas.getContext('2d').drawImage(image, 0, 0); decoded.push({ width: image.width, height: image.height, pixels: canvas.getContext('2d').getImageData(0, 0, image.width, image.height).data }); }
      const [a, b] = decoded; if (a.width !== b.width || a.height !== b.height) throw new Error('poster crop geometry changed');
      let inside = 0, outside = 0;
      for (let index = 0; index < a.pixels.length; index += 4) {
        if ([0, 1, 2].every(channel => a.pixels[index + channel] === b.pixels[index + channel])) continue;
        const x = index / 4 % a.width + clip.x, y = Math.floor(index / 4 / a.width) + clip.y;
        if (x >= copy.left && x < copy.right && y >= copy.top && y < copy.bottom) inside++; else outside++;
      }
      return { inside, outside };
    }, { images: [current.png, reference.png].map(value => 'data:image/png;base64,' + value.toString('base64')), copy: current.copy, clip: current.clip });
    // Containment can rasterize bold text differently even with identical glyph
    // boxes. No byte-equality or pixel-count threshold is imposed on that text.
    // Cover, hover shadow and focus outline remain outside copy containment.
    assert.equal(pixels.outside, 0, "cover, hover and focus pixels outside the copy must remain identical");
    console.log(JSON.stringify({ mode: "poster-paint", width, ...pixels }));
  } finally { await page.close(); }
}
function harness(url) {
  const mode = url.searchParams.get("mode") || "photo", count = Number(url.searchParams.get("count") || 80);
  const seedData = url.searchParams.has('empty') ? body(0, 0, mode, { total: 6000 }) : url.searchParams.has('oracle') ? oracle.payload({ limit: String(count), ...(mode === 'tv' ? { tvView: 'series' } : {}) }) : body(count, 0, mode);
  return `<!doctype html><meta charset=utf-8>${galleryStyles.map(href => `<link rel=stylesheet href="${href}${url.searchParams.get("unsupported") === "1" && href.includes("/catalog.css") ? "&unsupported=1" : ""}">`).join("")}<body class="gallery-view ${["photo", "manga"].includes(mode) ? "gallery-photo-view" : "gallery-media-view"}"><main class=app-shell><div id=statsRow></div><section id=workGrid></section></main><script type=module>
import{createGalleryPage}from'/modules/content-index/gallery-page.js';import{createGalleryRenderer}from'/modules/content-index/gallery-renderer.js';
const formatter=new Intl.NumberFormat('zh-CN');${formatters}
const noop=()=>{},state={activeView:'gallery',accessMode:'local',uiConfig:{},gallery:{mode:${JSON.stringify(mode)},photoView:'albums',category:'all',subCategory:'all',person:'all',photoDate:'all',query:'',sort:'updated',mediaKind:'all',seriesKey:'',visibleLimit:${count},fitWidth:true,album:null,comic:null,media:null,data:{totals:{photoSets:5000,manga:5000,movie:5000},facets:{},scannedAt:'initial'},status:''}},els={workGrid:document.querySelector('#workGrid'),statsRow:document.querySelector('#statsRow')};
const api=async(url,options={})=>{const res=await fetch(url,options),data=await res.json();if(!res.ok)throw new Error(data.error||'controlled synthetic error');return data;};let page;
const shared={api,state,els,formatNumber,formatBytes,formatDateTime,cancelScheduledWorkRendering:noop,disconnectPeopleIndexAutoload:noop,resetProgressiveCoverLoading:noop,writeStoredFlag:noop,includesText:(text,q)=>String(text).includes(q),openAdminScript:noop};
const renderer=createGalleryRenderer({...shared,getGalleryPage:()=>page});page=createGalleryPage({...shared,clearPersonSelection:noop,hidePersonProfile:noop,setMainHeader:noop,normalizeUiConfig:value=>value,galleryModeLabel:renderer.modeLabel,renderGalleryStats:renderer.renderStats,renderGalleryView:renderer.renderView,pushRoute:noop,replaceRoute:noop,syncRouteAfterNavigation:noop});
const seed=(data,options={})=>{Object.assign(state.gallery,options);state.gallery.list={...data,key:page.imageLibraryListKey(),rawLoaded:data.rawLoaded??data.items.length};renderer.renderStats();renderer.renderView();};
window.fixture={state,page,renderer,seed};seed(${JSON.stringify(seedData)},${JSON.stringify(url.searchParams.has('oracle') ? { sort: seedData.sort || 'updated', person: 'all' } : {})});${url.searchParams.has('empty') ? 'state.gallery.list=null;renderer.renderView();' : ''}
</script>`;
}
