import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createChannelOracle, createMetadataChannelOracle, restrictPrivateNetwork } from "./fixtures/image-library-channel-server.mjs";

// Long-term actual-factory browser regression. CSS, cache, image and auto-load
// imports are the complete current Android cascade. Only DTOs/SVGs are private.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const androidRoot = path.join(root, "android-client/www");
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(value => fs.existsSync(value));
assert(executablePath, "Chrome or Edge required for the private Android fixture");
const caseFilter = process.argv.find(value => value.startsWith("--case="))?.slice(7) || "";
const legacyRender = process.argv.includes("--legacy-list-refresh"), legacyOffset = process.argv.includes("--legacy-offset");
const legacySearch = process.argv.includes("--legacy-search-header");
let source = fs.readFileSync(path.join(androidRoot, "platform/content-index/channel-views.js"), "utf8");
const returnMarker = "    deactivate: () => { cancelChannelRequest();";
assert.equal(source.split(returnMarker).length, 2);
source = source.replace(returnMarker, "    diagnostics: () => ({ state: channelPageState, mounted: mountedChannelList }),\n" + returnMarker);
if (legacyRender) {
  const marker = "if (refreshChannelList(mode, data, paging)) return;";
  assert.equal(source.split(marker).length, 2); source = source.replace(marker, "if (false) return;");
}
if (legacyOffset) {
  const marker = "  function channelRevisionChanged(existing, incoming) {";
  assert.equal(source.split(marker).length, 2); source = source.replace(marker, `${marker}\n    return false;`);
}
if (legacySearch) {
  const marker = "if (mediaMode && openMediaSearch && header?.mode === mode && header.handler === openMediaSearch";
  assert.equal(source.split(marker).length, 2); source = source.replace(marker, "if (false && mediaMode && openMediaSearch && header?.mode === mode && header.handler === openMediaSearch");
}
const renderMarker = "  function renderChannelData(mode, data = {}, cacheEntry = null, paging = {}) {";
assert.equal(source.split(renderMarker).length, 2);
source = source.replace(renderMarker, `${renderMarker}
    const start = performance.now(), created = window.__created;
    try { return renderChannelDataMeasured(mode, data, cacheEntry, paging); }
    finally { window.__renders.push({ created: window.__created - created, ms: performance.now() - start }); }
  }
  function renderChannelDataMeasured(mode, data = {}, cacheEntry = null, paging = {}) {`);
const item = (index, mode = "photo", extra = {}) => ({ id: `I${index}`, type: mode === "photo" ? "photo" : mode === "manga" ? "manga" : "media", title: `Synthetic ${index}`, category: "fixture", personName: "Synthetic", mediaKind: "movie", size: 10000, imageCount: 2, updatedAt: "2026-10-04", coverUrl: `/synthetic/${index}.svg`, ...extra });
const body = (count, offset = 0, mode = "photo", extra = {}) => ({ items: Array.from({ length: count }, (_, index) => item(offset + index + 1, mode)), total: 5000, nextOffset: offset + count, listRevision: "private-stable", photoView: "albums", facets: {}, sort: "updated", ...extra });
const gates = new Set(), requests = [], unexpected = [], faults = [];
let oracle = null, checks = 0, browser;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture"), key = `${url.pathname}${url.search}`;
  requests.push(key);
  try {
    const gate = [...gates].find(value => !value.used && value.match(url));
    if (gate) { gate.used = true; gate.url = key; gate.requestedResolve(); await gate.promise; if (res.destroyed) return; if (gate.error) return json(res, { error: gate.error }, 503); if (gate.body) return json(res, gate.body); }
    if (url.pathname === "/probe") return send(res, harness(url), "text/html");
    const apiPath = url.pathname.replace(/^\/source-(?:one|two)/, "");
    if (apiPath === "/api/image-library/items") return json(res, oracle ? oracle.payload(url) : body(Number(url.searchParams.get("limit") || 24), Number(url.searchParams.get("offset") || 0), url.searchParams.get("mode") || "photo", { query: url.searchParams.get("q") || "", photoView: url.searchParams.get("photoView") || "albums", tvView: url.searchParams.get("tvView") || "series", sort: url.searchParams.get("sort") || "updated" }));
    if (apiPath === "/api/manga/tasks") return json(res, { jobs: [] });
    if (apiPath.startsWith("/synthetic/") || /^\/media\/(?:movie-cover|tv-series-cover|gallery-media-cover)\//.test(apiPath)) return send(res, '<svg xmlns="http://www.w3.org/2000/svg" width="250" height="350"><rect width="250" height="350" fill="#719284"/></svg>', "image/svg+xml");
    if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    if (!url.pathname.startsWith("/android/")) throw new Error("unmodelled private route");
    const target = path.resolve(androidRoot, url.pathname.slice("/android/".length));
    assert(target.startsWith(`${androidRoot}${path.sep}`));
    return send(res, url.pathname === "/android/platform/content-index/channel-views.js" ? source : await fs.promises.readFile(target), target.endsWith(".js") ? "text/javascript" : "text/css");
  } catch (error) { unexpected.push(`${key}: ${error.message}`); if (!res.destroyed) { res.writeHead(500); res.end(error.message); } }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const run = async (name, task) => { if (caseFilter && !name.includes(caseFilter)) return; await task(); checks++; console.log(`PASS ${name}`); };
try {
  browser = await chromium.launch({ executablePath, headless: true });
  for (const mode of ['movie', 'tv']) for (const mutation of ['cover', 'other-kind', 'metadata']) await run(`actual metadata ${mode} 1000: ${mutation} write owns only its query revision`, async () => {
    const owner = createMetadataChannelOracle({ mode, sort: 'rating' }); oracle = owner; let page;
    try {
      page = await newPage({ mode, count: 1000, sort: 'rating' }); const original = owner.payload({ limit: '1000' });
      if (mutation === 'cover') owner.coverWrite(); else if (mutation === 'other-kind') owner.otherKindWrite(); else owner.reorder(original.items[7].id);
      const latest = owner.payload({ limit: '1048' }), changed = mutation === 'metadata';
      if (!changed) { assert.deepEqual(latest.items.slice(0, 1000), original.items); assert.equal(latest.listRevision, original.listRevision); } else assert.notEqual(latest.listRevision, original.listRevision);
      const start = requests.length, gate = holdOffset(1000, null); await snapshot(page); await page.evaluate(() => document.querySelector('.channel-more').click()); await requested(gate); const pending = await read(page);
      assert(pending.row && pending.image && pending.focus && pending.observer); assert(pending.renders.every(value => value.created < 10)); gate.release(); await page.waitForFunction(() => !fixture.pending); await frames(page);
      const urls = requests.slice(start).filter(value => value.includes('/api/image-library/items')), result = await read(page); assert.equal(urls.length, changed ? 2 : 1); assert.equal(new URL(urls[0], base).searchParams.get('limit'), '48');
      if (changed) { assert.equal(new URL(urls[1], base).searchParams.get('offset'), '0'); assert.equal(new URL(urls[1], base).searchParams.get('limit'), '1048'); assert.deepEqual(await page.evaluate(() => fixture.data().items.map(value => value.id)), latest.items.map(value => value.id)); assert.equal(result.row, false); }
      else { assert(result.row && result.image && result.focus && result.observer); assert.equal(result.rows, 1048); assert(result.created < 1300); }
      console.log(JSON.stringify({ kind: 'metadata-write-boundary', client: 'android', mode, mutation, urls, pending, result }));
    } finally { await page?.close(); oracle = null; owner.close(); }
  });
  for (const count of [500, 1000]) await run(`media search header ${count}: pending/cache/error/retry keep focus nodes and one callback`, async () => {
    const page = await newPage({ mode: 'movie', count }), path = `/api/image-library/items?mode=movie&limit=48&offset=${count}&sort=updated`, gate = holdOffset(count, null, 'controlled search-header error');
    try {
      await page.evaluate(async ({ path, cached }) => { await fixture.writeCache(fixture.initialSource, path, cached); window.__search = document.querySelector('.media-list-search'); window.__count = document.querySelector('.media-list-count'); __search.focus(); __search.click(); __created = 0; __renders = []; }, { path, cached: body(48, count, 'movie') });
      const assertHeader = async label => {
        const state = await page.evaluate(() => ({ button: __search.isConnected && document.querySelector('.media-list-search') === __search, count: __count.isConnected && document.querySelector('.media-list-count') === __count, focus: document.activeElement === __search, children: document.querySelector('#viewMeta').children.length, callback: fixture.clicks.filter(value => value.mode === 'search').length }));
        if (legacySearch) console.log(JSON.stringify({ kind: 'legacy-search-header', label, state })); assert(state.button && state.count && state.focus, 'same-mode count/search header must retain nodes and focus'); assert.equal(state.children, 2); return state.callback;
      };
      assert.equal(await assertHeader('initial'), 1); await page.evaluate(() => document.querySelector('.channel-more').click()); await requested(gate); assert.equal(await assertHeader('cached pending'), 1); await page.evaluate(() => __search.click()); assert.equal(await assertHeader('pending click'), 2);
      gate.release(); await page.locator('.channel-more').filter({ hasText: '重试' }).waitFor(); assert.equal(await assertHeader('error'), 2);
      const retry = holdOffset(count, body(48, count, 'movie')); await page.evaluate(() => document.querySelector('.channel-more').click()); await requested(retry); assert.equal(await assertHeader('retry pending'), 2); retry.release(); await page.waitForFunction(() => !fixture.pending); assert.equal(await assertHeader('success'), 2);
      await page.evaluate(() => { window.__headerRefresh = fixture.reload(); }); await page.evaluate(() => __headerRefresh); assert.equal(await assertHeader('same-mode refresh'), 2); await page.evaluate(() => __search.click()); assert.equal(await assertHeader('one final click'), 3);
      await page.evaluate(() => fixture.navigate({ mode: 'tv' })); await page.waitForFunction(() => !fixture.pending); assert.equal(await page.evaluate(() => __search.isConnected), false, 'a changed mode rebuilds its labeled action');
    } finally { gate.release(); await page.close(); }
  });
  for (const mode of ["photo", "movie", "tv"]) for (const count of [mode === "photo" ? 24 : 80, 1000]) await run(`${mode} ${count}: pending/append retain actual card image focus and cover observer`, async () => {
    const page = await newPage({ mode, count }), gate = holdOffset(count, body(48, count, mode));
    try {
      await snapshot(page); await page.evaluate(() => { document.querySelector('.channel-more').click(); document.querySelector('.channel-more').dispatchEvent(new MouseEvent('click')); }); await requested(gate);
      const pending = await read(page); if (legacyRender) console.log(JSON.stringify({ kind: 'legacy-android-list-loading', mode, count, pending })); assert(pending.row, "pending must retain mounted card"); assert(pending.image); assert(pending.focus); assert(pending.observer); assert(pending.renders.every(value => value.created < 10), "pending rendering must be independent of mounted rows"); assert(pending.created < 50, "asynchronous initial cover completions remain bounded");
      assert.equal(await page.evaluate(url => __transport.started.filter(value => value === url).length, gate.url), 1); assert(await page.locator('.channel-more').isDisabled());
      gate.release(); await page.waitForFunction(count => fixture.data()?.rawLoaded === count + 48, count); await frames(page);
      const success = await read(page); assert(success.row); assert(success.image); assert(success.focus); assert(success.observer); assert.equal(success.rows, count + 48); assert(success.created < 1300); assert.equal(success.scroll, pending.scroll);
      assert(await page.evaluate(() => __coverObservers.every(observer => [...observer.counts.values()].every(value => value === 1))));
      console.log(JSON.stringify({ kind: "android-incremental", mode, count, pending, success }));
    } finally { gate.release(); await page.close(); }
  });
  await run("raw duplicate metadata updates advance server cursor and finish EOF", async () => {
    const page = await newPage(), gate = holdOffset(24, body(2, 24, "photo", { items: [item(1, "photo", { title: "Current metadata" }), item(25)], total: 28 }));
    try {
      await snapshot(page); await page.evaluate(() => { window.__first = document.querySelector('.channel-card'); __first.focus({ preventScroll: true }); document.querySelector('.channel-more').click(); }); await requested(gate); gate.release(); await page.waitForFunction(() => fixture.data()?.rawLoaded === 26);
      assert.equal(await page.evaluate(() => __first.isConnected), false); assert((await read(page)).row); assert.equal(await page.locator('.channel-card').count(), 25);
      assert(await page.evaluate(() => document.activeElement.textContent.includes('Current metadata')));
      await page.locator('.channel-card').filter({ hasText: "Current metadata" }).click(); assert.equal(await page.evaluate(() => fixture.clicks.at(-1)?.id), "I1");
      const last = holdOffset(26, body(2, 26, "photo", { items: [item(25), item(26)], total: 28 }));
      await page.evaluate(() => document.querySelector('.channel-more').click()); await requested(last); last.release(); await page.waitForFunction(() => fixture.data()?.hasMore === false);
      assert.equal(await page.locator('.channel-card').count(), 26); assert.equal(await page.locator('.channel-more').count(), 0); assert.equal(await page.evaluate(() => fixture.data().rawLoaded), 28);
    } finally { gate.release(); await page.close(); }
  });
  await run("page error and retry preserve old rows and original raw range", async () => {
    const page = await newPage(), failed = holdOffset(24, null, "private current error");
    try {
      await snapshot(page); await page.evaluate(() => document.querySelector('.channel-more').click()); await requested(failed); failed.release(); await page.locator('.channel-more').filter({ hasText: '重试' }).waitFor();
      assert((await read(page)).row); const retry = holdOffset(24, body(48, 24)); await page.evaluate(() => document.querySelector('.channel-more').click()); await requested(retry);
      assert.equal(new URL(retry.url, base).searchParams.get('limit'), '48'); retry.release(); await page.waitForFunction(() => fixture.data()?.rawLoaded === 72); assert((await read(page)).row);
    } finally { failed.release(); await page.close(); }
  });
  for (const modern of [true, false]) await run(`${modern ? 'different revision' : 'legacy'} cached tail cannot merge into the current snapshot`, async () => {
    const page = await newPage(), gate = holdOffset(24, body(48, 24));
    try {
      await page.evaluate(async modern => {
        const payload = { items: [{ id: 'cached-wrong', type: 'photo', title: 'Wrong cached snapshot' }], total: 5000, photoView: 'albums', nextOffset: 72, ...(modern ? { listRevision: 'cached-different' } : {}) };
        await fixture.writeCache(fixture.initialSource, '/api/image-library/items?mode=photo&limit=48&offset=24&sort=updated', payload);
      }, modern);
      await snapshot(page); await page.evaluate(() => document.querySelector('.channel-more').click()); await requested(gate);
      assert.equal(await page.locator('.channel-card').filter({ hasText: 'Wrong cached snapshot' }).count(), 0); assert.equal(await page.evaluate(() => fixture.data().rawLoaded), 24); assert((await read(page)).row);
      gate.release(); await page.waitForFunction(() => !fixture.pending); assert.equal(await page.evaluate(() => fixture.data().rawLoaded), 72);
    } finally { gate.release(); await page.close(); }
  });
  await run("duplicate-heavy rebase stops at the requested raw prefix", async () => {
    const page = await newPage(), tail = holdOffset(24, body(48, 24, 'photo', { listRevision: 'duplicate-new' })), first = holdOffset(0, body(30, 0, 'photo', { items: Array.from({ length: 30 }, () => item(1)), listRevision: 'duplicate-new' })), last = holdOffset(30, body(42, 30, 'photo', { items: Array.from({ length: 42 }, () => item(2)), listRevision: 'duplicate-new' }));
    try {
      await page.evaluate(() => document.querySelector('.channel-more').click()); await requested(tail); tail.release(); await requested(first); first.release(); await requested(last); assert.equal(new URL(last.url, base).searchParams.get('limit'), '42'); last.release(); await page.waitForFunction(() => !fixture.pending);
      assert.deepEqual(await page.evaluate(() => ({ raw: fixture.data().rawLoaded, ids: fixture.data().items.map(value => value.id) })), { raw: 72, ids: ['I1', 'I2'] });
    } finally { tail.release(); first.release(); last.release(); await page.close(); }
  });
  await run("actual backend 6000 existing rows survive capped ordinary refresh", async () => {
    oracle = createChannelOracle({ count: 6000, maxItemLimit: 5000 });
    const first = holdOffset(5000, null), page = await newPage({ count: 6000, waitLoaded: false });
    try {
      await requested(first); assert.equal(await page.evaluate(() => fixture.data()?.items?.length || 0), 0, 'first partial prefix must not commit'); assert.equal(await page.locator('.channel-card').count(), 0); first.release(); await page.waitForFunction(() => !fixture.pending);
      await page.waitForFunction(() => document.querySelector('.channel-card img')?.naturalWidth > 0);
      assert.equal(await page.evaluate(() => fixture.data().rawLoaded), 6000); assert.equal(await page.locator('.channel-card').count(), 6000); await snapshot(page);
      const tail = holdOffset(5000, null); await page.evaluate(() => { window.__refreshTask = fixture.reload(); }); await requested(tail); assert.equal(await page.evaluate(() => fixture.data().rawLoaded), 6000); assert((await read(page)).row); tail.release(); await page.evaluate(() => __refreshTask); await frames(page);
      assert.equal(await page.evaluate(() => fixture.data().rawLoaded), 6000); assert.equal(await page.locator('.channel-card').count(), 6000); assert((await read(page)).row);
    } finally { first.release(); oracle = null; await page.close(); }
  });
  await run("cold offline 6000 reload recovers complete real IndexedDB aggregate", async () => {
    oracle = createChannelOracle({ count: 6000, maxItemLimit: 5000 }); const page = await newPage({ count: 6000 });
    try {
      await page.waitForFunction(async () => (await fixture.readCache(fixture.initialSource, '/api/image-library/items?mode=photo&limit=6000&offset=0&sort=updated'))?.payload?.items?.length === 6000);
      const offline = holdOffset(0, null, 'controlled offline'); await page.evaluate(() => fixture.restart()); await requested(offline);
      await page.waitForFunction(() => fixture.data()?.rawLoaded === 6000 && document.querySelectorAll('.channel-card').length === 6000); offline.release(); await page.waitForFunction(() => !fixture.pending);
      assert.equal(await page.locator('.channel-card').count(), 6000); assert.equal(await page.evaluate(() => fixture.data().items.length), 6000); assert.match(await page.locator('#viewMeta').innerText(), /离线|缓存/);
    } finally { oracle = null; await page.close(); }
  });
  await run("first segmented tail failure survives cold cached-prefix reload and manual completion", async () => {
    oracle = createChannelOracle({ count: 6000, maxItemLimit: 5000 }); const failure = holdOffset(5000, null, 'controlled first prefix tail error'), page = await newPage({ count: 6000, waitLoaded: false });
    try {
      await requested(failure); failure.release(); await page.waitForFunction(() => !fixture.pending);
      await page.waitForFunction(async () => (await fixture.readCache(fixture.initialSource, '/api/image-library/items?mode=photo&limit=5000&offset=0&sort=updated'))?.payload?.items?.length === 5000);
      const offline = holdOffset(0, null, 'controlled cold offline'); await page.evaluate(() => fixture.restart()); await requested(offline); await page.waitForFunction(() => fixture.data()?.rawLoaded === 5000 && document.querySelectorAll('.channel-card').length === 5000); offline.release(); await page.waitForFunction(() => !fixture.pending);
      assert(await page.locator('.channel-more').count() > 0, 'readable first segment must offer manual completion');
      await page.evaluate(() => document.querySelector('.channel-more').click()); await page.waitForFunction(() => !fixture.pending && fixture.data()?.rawLoaded === 6000); assert.equal(await page.locator('.channel-card').count(), 6000); assert.equal(await page.locator('.channel-more').count(), 0);
      await page.waitForFunction(async () => { const path = [...__transport.started].reverse().find(value => value.includes('/api/image-library/items') && new URL(value, location.origin).searchParams.get('offset') === '5000').replace('/source-one', ''); return (await fixture.readCache(fixture.initialSource, path))?.payload?.items?.length === 1000; });
    } finally { failure.release(); oracle = null; await page.close(); }
  });
  for (const mode of ["photo", "tv"]) await run(`actual backend 100 ${mode}: rescan/metadata reorder matches complete EOF oracle`, async () => {
    oracle = createChannelOracle({ mode, maxItemLimit: 30 });
    const requestStart = requests.length, page = await newPage({ mode, count: mode === 'tv' ? 80 : 24, sort: mode === 'tv' ? 'rating' : 'updated', tvView: 'episodes' });
    try {
      const seen = await page.evaluate(() => fixture.data().items.at(-1).id); oracle.reorder(seen);
      const expected = oracle.ids({ limit: '100' }); // backend clamp requires independent complete pages
      const complete = []; for (let offset = 0; offset < 100; offset += 30) complete.push(...oracle.ids({ limit: '30', offset: String(offset) })); assert.equal(new Set(complete).size, 100); assert.equal(expected.length, 30);
      for (let attempt = 0; attempt < 8; attempt++) {
        if (await page.locator('.channel-more').count() === 0) break;
        await page.evaluate(() => document.querySelector('.channel-more').click()); await page.waitForFunction(() => !fixture.pending); await frames(page);
      }
      assert.deepEqual(await page.evaluate(() => fixture.data().items.map(value => value.id)), complete, "cross-revision append must reproduce the real backend prefix without omissions");
      assert.equal(await page.locator('.channel-more').count(), 0); assert.equal(await page.evaluate(() => fixture.data().rawLoaded), 100);
      console.log(JSON.stringify({ kind: 'actual-backend-oracle', client: 'android', mode, rows: complete.length, listRequests: requests.slice(requestStart).filter(value => value.includes('/api/image-library/items')) }));
    } finally { oracle = null; await page.close(); }
  });
  await run("mixed revision prefix bounded retry keeps old page and explicit retry recovers", async () => {
    const page = await newPage(), tail = holdOffset(24, body(48, 24, 'photo', { listRevision: 'new-one' }));
    const prefixes = Array.from({ length: 3 }, (_, index) => [holdOffset(0, body(30, 0, 'photo', { listRevision: `prefix-${index}` })), holdOffset(30, body(30, 30, 'photo', { listRevision: `different-${index}` }))]).flat();
    try {
      await snapshot(page); await page.evaluate(() => document.querySelector('.channel-more').click()); await requested(tail); tail.release();
      for (const gate of prefixes) { await Promise.race([requested(gate), page.locator('.channel-more').filter({ hasText: '重试' }).waitFor().then(() => null)]); if (!gate.used) break; gate.release(); }
      await page.locator('.channel-more').filter({ hasText: '重试' }).waitFor(); assert((await read(page)).row); assert.equal(await page.evaluate(() => fixture.data().rawLoaded), 24); assert(prefixes.filter(value => value.used).length <= 6);
      prefixes.forEach(gate => { gate.used = true; gate.release(); });
      const retry = holdOffset(24, body(48, 24, 'photo', { listRevision: 'stable-new' })), prefix = holdOffset(0, body(72, 0, 'photo', { listRevision: 'stable-new' }));
      await page.evaluate(() => document.querySelector('.channel-more').click()); await requested(retry); retry.release(); await requested(prefix); prefix.release(); await page.waitForFunction(() => fixture.data()?.rawLoaded === 72); assert.equal(await page.locator('.channel-card').count(), 72);
    } finally { tail.release(); prefixes.forEach(gate => gate.release()); await page.close(); }
  });
  for (const navigation of ['query', 'source', 'reader']) for (const error of ['', 'old private error']) await run(`${navigation} navigation rejects late ${error ? 'error' : 'success'} and cache ownership`, async () => {
    const page = await newPage({ ignoreAbort: true }), old = holdOffset(24, body(48, 24), error);
    try {
      await page.evaluate(() => document.querySelector('.channel-more').click()); await requested(old);
      if (navigation === 'reader') await page.evaluate(() => fixture.leave());
      else {
        const current = hold(url => url.pathname.endsWith('/api/image-library/items') && (navigation === 'query' ? url.searchParams.get('q') === 'current' : url.pathname.startsWith('/source-two')), body(24, 1000, 'photo', { query: navigation === 'query' ? 'current' : '' }));
        await page.evaluate(navigation => fixture.navigate(navigation === 'query' ? { query: 'current' } : {}, navigation === 'source' ? 'two' : 'one'), navigation); await requested(current);
        old.release(); await frames(page); assert(await page.evaluate(() => fixture.pending)); assert(!(await page.locator('#viewContent').innerText()).includes('old private error'));
        current.release(); await page.waitForFunction(() => !fixture.pending); assert.equal(await page.evaluate(() => fixture.data().items[0].id), 'I1001');
      }
      old.release(); await page.waitForFunction(url => __transport.settled.includes(url), old.url); await frames(page);
      if (navigation === 'reader') assert.equal(await page.locator('#viewContent').innerText(), 'Private reader');
      assert.equal(await page.evaluate(async oldUrl => (await fixture.readCache(fixture.initialSource, oldUrl.replace('/source-one', '')))?.payload ?? null, old.url), null, 'obsolete result must not enter the response cache');
    } finally { old.release(); await page.close(); }
  });
  await run("same key overlapping requests only latest result commits", async () => {
    const page = await newPage({ ignoreAbort: true }), old = holdOffset(24, body(48, 24, 'photo', { items: [item(999)] })), current = holdOffset(24, body(48, 24));
    try {
      await page.evaluate(() => document.querySelector('.channel-more').click()); await requested(old); await page.evaluate(() => { void fixture.reload(); }); await requested(current);
      old.release(); await frames(page); assert(await page.evaluate(() => fixture.pending)); current.release(); await page.waitForFunction(() => !fixture.pending); assert.equal(await page.evaluate(() => fixture.data().items.some(value => value.id === 'I999')), false);
    } finally { old.release(); current.release(); await page.close(); }
  });
  await run("missing identity and collection layout rebuild safely; resize keeps flat items", async () => {
    const page = await newPage(), missing = holdOffset(24, body(1, 24, 'photo', { items: [item(25, 'photo', { id: '' })] }));
    try {
      await snapshot(page); await page.evaluate(() => document.querySelector('.channel-more').click()); await requested(missing); missing.release(); await page.waitForFunction(() => fixture.data()?.rawLoaded === 25); assert.equal((await read(page)).row, false); assert.equal(await page.locator('.channel-card').count(), 25);
      await page.setViewportSize({ width: 900, height: 900 }); await frames(page); assert.equal(await page.locator('.channel-card').count(), 25);
      const group = hold(url => url.searchParams.get('photoView') === 'collections', body(1, 0, 'photo', { photoView: 'collections', items: [{ id: 'category', type: 'photoCategory', category: 'fixture', collections: [1, 2, 3].map(index => item(index, 'photo', { type: 'photoCollection', collectionId: `C${index}`, albumCount: index })) }], total: 1 }));
      await page.evaluate(() => fixture.navigate({ photoView: 'collections' })); await requested(group); group.release(); await page.waitForFunction(() => !fixture.pending); assert.equal(await page.locator('.photo-collection-card').count(), 3); assert.equal(await page.locator('.photo-album-card').count(), 0);
    } finally { missing.release(); await page.close(); }
  });
  assert.equal(unexpected.length, 0, unexpected.join('\n')); assert.equal(faults.length, 0, faults.join('\n')); assert(checks > 0, 'case filter matched no checks');
  console.log(`Android actual channel rendering: ${checks} cases PASS${legacyRender || legacyOffset ? ' (negative control unexpectedly passed)' : ''}`);
} finally {
  gates.forEach(gate => gate.release()); if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
function send(res, data, type) { res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(data); }
function json(res, data, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
function hold(match, response, error = '') { let release, requestedResolve; const gate = { match, body: response, error, promise: new Promise(resolve => { release = resolve; }), requested: new Promise(resolve => { requestedResolve = resolve; }), release, requestedResolve, used: false }; gates.add(gate); return gate; }
function holdOffset(offset, response, error = '') { return hold(url => url.pathname.endsWith('/api/image-library/items') && Number(url.searchParams.get('offset') || 0) === offset, response, error); }
async function requested(gate) { let timer; try { await Promise.race([gate.requested, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('expected private request not seen')), 5000); })]); } finally { clearTimeout(timer); } }
async function frames(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function newPage({ mode = 'photo', count = 24, sort = 'updated', tvView = 'series', ignoreAbort = true, waitLoaded = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } }); page.on('pageerror', error => faults.push(error.message)); await restrictPrivateNetwork(page, base, unexpected);
  await page.addInitScript(({ ignoreAbort }) => {
    window.__created = 0; window.__renders = []; window.__coverObservers = []; window.__transport = { started: [], settled: [] };
    const create = document.createElement.bind(document); document.createElement = (...args) => { window.__created++; return create(...args); };
    const Original = IntersectionObserver; window.IntersectionObserver = class extends Original { constructor(callback, options = {}) { super(callback, options); this.counts = new Map(); this.off = false; if (String(options.rootMargin || '').includes('900px') || String(options.rootMargin || '').includes('420px')) __coverObservers.push(this); } observe(node) { this.counts.set(node, (this.counts.get(node) || 0) + 1); return super.observe(node); } disconnect() { this.off = true; return super.disconnect(); } };
    const nativeFetch = fetch; window.fetch = async (url, options = {}) => { const key = new URL(url, location.href).pathname + new URL(url, location.href).search; __transport.started.push(key); const response = await nativeFetch(url, { ...options, ...(ignoreAbort ? { signal: undefined } : {}) }); const json = response.json.bind(response); response.json = async () => { const value = await json(); __transport.settled.push(key); return value; }; return response; };
  }, { ignoreAbort });
  await page.goto(`${base}/probe?${new URLSearchParams({ mode, count, sort, tvView })}`); await page.waitForFunction(() => Boolean(window.fixture));
  if (waitLoaded) { await page.waitForFunction(() => !fixture.pending && fixture.data()?.items.length > 0); await page.waitForFunction(() => document.querySelector('.channel-card img')?.naturalWidth > 0); } await frames(page); return page;
}
async function snapshot(page) { await page.evaluate(() => { window.__row = document.querySelectorAll('.channel-card')[7] || document.querySelector('.channel-card'); window.__image = __row.querySelector('img') || document.querySelector('.channel-card img'); window.__observer = __coverObservers.at(-1); __row.focus({ preventScroll: true }); scrollTo(0, 100); __created = 0; __renders = []; }); await frames(page); }
async function read(page) { return page.evaluate(() => ({ row: __row.isConnected, image: __image?.isConnected === true, focus: document.activeElement === __row, observer: __observer === __coverObservers.at(-1) && !__observer?.off, rows: document.querySelectorAll('.channel-card').length, nodes: document.getElementsByTagName('*').length, images: document.querySelectorAll('.channel-card img').length, coverObservers: __coverObservers.length, created: __created, renders: __renders, scroll: scrollY })); }
function harness(url) {
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><link rel=stylesheet href=/android/styles.css><body class="standalone-module-view"><main class=content-panel id=contentPanel><div id=viewKicker></div><h1 id=viewTitle></h1><div id=viewMeta></div><div id=viewContent></div></main><script type=module>
import{createChannelViews}from'/android/platform/content-index/channel-views.js';import{readCachedJson,writeCachedJson}from'/android/js/cache.js';
const els=Object.fromEntries(['viewContent','viewTitle','viewKicker','viewMeta','contentPanel'].map(key=>[key,document.getElementById(key)]));
let source=location.origin+'/source-one',limit=${Number(url.searchParams.get('count') || 24)},params=${JSON.stringify({ mode: url.searchParams.get('mode') || 'photo', photoView: 'albums', sort: url.searchParams.get('sort') || 'updated', tvView: url.searchParams.get('tvView') || 'series' })},controller=new AbortController(),navigation=0,pending=0;const clicks=[];
const render=()=>{const owned=navigation,active=()=>owned===navigation;active.signal=controller.signal;pending++;return views.renderChannel(params,active).finally(()=>pending--);};
const createViews=()=>createChannelViews({els,getActiveUrl:()=>source,getChannelLimit:()=>limit,increaseChannelLimit:value=>limit+=value,openInLibrary:(mode,id)=>clicks.push({mode,id}),showPhotoDetail:id=>clicks.push({mode:'photo',id}),showMediaDetail:id=>clicks.push({mode:'media',id}),openMediaSearch:()=>clicks.push({mode:'search'}),setActiveBottom:()=>{},renderCurrentView:render});let views=createViews();
window.fixture={get views(){return views},clicks,initialSource:source,readCache:readCachedJson,writeCache:writeCachedJson,data:()=>views.diagnostics().state?.data,reload:render,get pending(){return pending>0},restart(){controller.abort();controller=new AbortController();navigation++;views.deactivate();views=createViews();void render();},navigate(next={},nextSource='one'){controller.abort();controller=new AbortController();navigation++;limit=${Number(url.searchParams.get('count') || 24)};source=location.origin+'/source-'+nextSource;params={...params,...next};void render();},leave(){controller.abort();navigation++;views.deactivate();els.viewContent.textContent='Private reader';}};void render();
</script>`;
}
