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
const legacyWestern = process.argv.includes("--legacy-western-shelf");
const legacySearchFocus = process.argv.includes("--legacy-search-focus");
const legacySearchIme = process.argv.includes("--legacy-search-ime");
const legacySearchKey229 = process.argv.includes("--legacy-search-key229");
const legacySearchDetach = process.argv.includes("--legacy-search-detach");
const legacyEagerControls = process.argv.includes("--legacy-eager-controls");
const legacySelectDetach = process.argv.includes("--legacy-select-detach");
const legacyCategoryDetach = process.argv.includes("--legacy-category-detach");
const legacyReaderReturn = process.argv.includes("--legacy-reader-return");
const legacyReaderReturnIntent = process.argv.includes("--legacy-reader-return-intent");
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
if (legacyReaderReturn) {
  const marker = "function restorePhotoListReturn(anchor) {";
  assert.equal(rendererSource.split(marker).length, 2);
  rendererSource = rendererSource.replace(marker, `${marker}\n  return false;`);
}
if (legacyReaderReturnIntent) {
  const marker = 'for (const type of ["pointerdown", "keydown", "wheel", "touchmove", "focusin"]) {';
  assert.equal(rendererSource.split(marker).length, 2);
  rendererSource = rendererSource.replace(marker, 'for (const type of []) {');
}
if (legacyEagerControls) {
  for (const marker of [
    "  if (mediaModule) {",
    '  if (["western", "tv"].includes(state.gallery.mode)) {',
    '  if (["photo", "movie", "media"].includes(state.gallery.mode)) {'
  ]) {
    assert.equal(rendererSource.split(marker).length, 2);
    rendererSource = rendererSource.replace(marker, "  if (true) {");
  }
}
if (legacySearchIme) {
  const marker = "    if (composing || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;";
  assert.equal(rendererSource.split(marker).length, 2);
  rendererSource = rendererSource.replace(marker, "    if (event.defaultPrevented) return;");
}
if (legacySearchKey229) {
  const marker = "    if (composing || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;";
  assert.equal(rendererSource.split(marker).length, 2);
  rendererSource = rendererSource.replace(marker, "    if (composing || event.isComposing || event.defaultPrevented) return;");
}
if (legacySearchDetach || legacySelectDetach) {
  const marker = "function refreshGalleryControls() {";
  assert.equal(rendererSource.split(marker).length, 2);
  const selector = legacySearchDetach ? '.gallery-search-field, .gallery-media-search-field' : 'select.gallery-select:focus';
  rendererSource = rendererSource.replace(marker, `${marker}
    // Counterfactual: temporarily detach a real native control/field, then
    // restore both its position and final focus. Blur/ancestry must still fail.
    const displaced = els.workGrid.querySelector('.gallery-controls')?.querySelector(${JSON.stringify(selector)});
    if (displaced?.parentElement) {
      const parent = displaced.parentElement, next = displaced.nextSibling, active = document.activeElement;
      const search = displaced.matches('.gallery-search') ? displaced : displaced.querySelector('.gallery-search');
      const selection = active === search ? [search.selectionStart, search.selectionEnd] : null;
      document.createElement('div').append(displaced); parent.insertBefore(displaced, next);
      active?.focus?.({ preventScroll: true }); if (selection) search.setSelectionRange(...selection);
    }
`);
}
if (legacyCategoryDetach) {
  const marker = "function refreshGalleryControls() {";
  assert.equal(rendererSource.split(marker).length, 2);
  rendererSource = rendererSource.replace(marker, `${marker}
    // Counterfactual: preserve the final menu, focus and open state while
    // transiently retiring its whole native details subtree.
    { const menu = els.workGrid.querySelector('.gallery-category-menu[open]');
    if (menu?.contains(document.activeElement)) {
      const parent = menu.parentElement, next = menu.nextSibling;
      const active = document.activeElement, panel = menu.querySelector('.gallery-category-menu-panel'), top = panel.scrollTop;
      document.createElement('div').append(menu); parent.insertBefore(menu, next);
      active.focus({ preventScroll: true }); panel.scrollTop = top;
    }
    }
`);
}
if (legacySearchFocus) {
  const marker = "function restoreGallerySearchFocus() {";
  assert.equal(rendererSource.split(marker).length, 2);
  rendererSource = rendererSource.replace(marker, `${marker}
    const retry = () => {
      const input = els.workGrid?.querySelector(".gallery-search");
      input?.focus({ preventScroll: true });
      input?.setSelectionRange?.(input.value.length, input.value.length);
    };
    window.requestAnimationFrame(retry);
    for (const delay of [0, 80, 180]) window.setTimeout(retry, delay);`);
}
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
if (legacyWestern) {
  // The former Western shelf always used the preserved complete-render/more
  // branch. Disable only its new registration, so real DOM/range checks fail.
  const marker = '  if (list && state.gallery.person === "all") {';
  assert.equal(rendererSource.split(marker).length, 2);
  rendererSource = rendererSource.replace(marker, '  if (false && list && state.gallery.person === "all") {');
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
const westernBody = (count, offset = 0, extra = {}) => ({
  ...body(count, offset, "western"), listRevision: "private-western-stable",
  items: Array.from({ length: count }, (_, index) => {
    const number = offset + index + 1, person = `Synthetic person ${number}`;
    return { ...item(number), id: person, type: "westernPerson", mediaKind: "western", title: person, personName: person,
      videoCount: 3, playableCount: 2, categories: [{ value: "fixture", count: 3 }], samples: [`Synthetic episode ${number}`] };
  }), ...extra
});
const held = new Set(), requests = [], faults = [], unexpected = [];
let browser, checks = 0, oracle = null, currentCase = '';
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
    if (url.pathname === "/api/image-library/items") {
      const mode = url.searchParams.get("mode") || "photo", count = Number(url.searchParams.get("limit") || 80), offset = Number(url.searchParams.get("offset") || 0);
      const person = url.searchParams.get("person");
      json(res, oracle ? oracle.payload(url) : mode === "western" && !person ? westernBody(count, offset)
        : mode === "western" ? body(count, offset, "media", { items: body(count, offset).items.map(value => ({ ...value, mediaKind: "western", personName: person })) }) : body(count, offset, mode));
      return;
    }
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
const run = async (name, task) => { if (caseFilter && !name.includes(caseFilter)) return; currentCase = name; await task(); checks++; console.log(`PASS ${name}`); };
const cardSelector = ".gallery-photo-album-card, .manga-grid > .gallery-card, .gallery-movie-list-item, .gallery-tv-series-card, .gallery-western-person-card";
try {
  browser = await chromium.launch({ executablePath, headless: true });
  for (const width of [1280, 390]) await run(`photo reader return ${width}: restores the selected album in a long list`, async () => {
    const page = await newPage({ mode: 'photo', count: 1000 });
    try {
      await page.setViewportSize({ width, height: 900 });
      const card = page.locator('.gallery-photo-album-card').nth(499);
      await card.evaluate(card => { card.scrollIntoView({ block: 'center', behavior: 'instant' }); card.focus({ preventScroll: true }); });
      await frames(page);
      const before = await card.evaluate(card => ({ scroll: scrollY, top: card.getBoundingClientRect().top, text: card.textContent }));
      assert(before.scroll > 5000, 'fixture must start in the middle of a genuinely long album list');
      await card.press('Enter');
      await page.waitForFunction(() => fixture.state.gallery.album?.id === 'I500');
      await page.waitForFunction(() => scrollY < 2);
      await page.locator('.gallery-reader-back').click();
      await page.waitForFunction(() => !fixture.state.gallery.album && document.querySelectorAll('.gallery-photo-album-card').length === 1000);
      await frames(page);
      const after = await page.locator('.gallery-photo-album-card').nth(499).evaluate(card => ({ scroll: scrollY, top: card.getBoundingClientRect().top, focused: document.activeElement === card, text: card.textContent }));
      console.log(JSON.stringify({ kind: 'photo-list-return', width, before, after }));
      assert(Math.abs(after.top - before.top) < 2 && Math.abs(after.scroll - before.scroll) < 2,
        'returning from an album must restore its previous long-list position');
      assert.equal(after.focused, true, 'returning must restore keyboard focus to the opened album card');
      assert.equal(after.text, before.text);
    } finally { await page.close(); }
  });
  await run('photo reader return pointer: restores position without moving focus to a card', async () => {
    const page = await newPage({ mode: 'photo', count: 1000 });
    try {
      const before = await openReturnAlbum(page, { pointer: true });
      await page.locator('.gallery-reader-back').click(); await frames(page);
      const after = await page.locator('.gallery-photo-album-card[data-gallery-album-id="I500"]').evaluate(card => ({ top: card.getBoundingClientRect().top, focused: card === document.activeElement }));
      assert(Math.abs(after.top - before.top) < 2);
      assert.equal(after.focused, false, 'pointer-opened readers must not assign keyboard focus to a rebuilt card');
    } finally { await page.close(); }
  });
  await run('photo reader return resize: follows the real card after list reorder and lazy cover loading', async () => {
    const page = await newPage({ mode: 'photo', count: 1000 });
    try {
      const before = await openReturnAlbum(page);
      await page.setViewportSize({ width: 390, height: 740 });
      await page.evaluate(() => {
        const list = fixture.state.gallery.list, items = list.items;
        fixture.state.gallery.list = { ...list, items: [...items.slice(200), ...items.slice(0, 200)] };
      });
      await page.locator('.gallery-reader-back').click(); await frames(page);
      const target = page.locator('.gallery-photo-album-card[data-gallery-album-id="I500"]');
      assert.equal(await target.evaluate(card => [...card.parentElement.children].indexOf(card)), 299, 'return target follows its id after a refreshed list changes order');
      assert.equal(await target.evaluate(card => {
        const r = card.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight && card.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
      }), true, 'resized return target must actually be visible and reachable');
      assert.equal(await target.evaluate(card => card === document.activeElement), true);
      assert.notEqual(await page.evaluate(() => scrollY), before.scroll, 'new layout/rank must use real card geometry rather than the old absolute scroll');
      await target.locator('img').evaluate(image => image.decode());
      const settled = await target.evaluate(card => ({ top: card.getBoundingClientRect().top, scroll: scrollY }));
      await page.waitForLoadState('networkidle'); await frames(page);
      assert.deepEqual(await target.evaluate(card => ({ top: card.getBoundingClientRect().top, scroll: scrollY })), settled, 'lazy cover completion must not repeatedly reposition the list');
    } finally { await page.close(); }
  });
  for (const intent of ['focus', 'wheel']) await run(`photo reader return intent ${intent}: delayed frames yield to newer input`, async () => {
    const page = await newPage({ mode: 'photo', count: 1000 });
    try {
      await openReturnAlbum(page); await holdReturnFrames(page);
      await page.locator('.gallery-reader-back').evaluate(button => button.click());
      await page.evaluate(intent => {
        if (intent === 'focus') document.querySelector('.gallery-search').focus({ preventScroll: true });
        else document.dispatchEvent(new WheelEvent('wheel', { deltaY: 200, bubbles: true }));
        window.scrollTo({ top: 520, behavior: 'instant' });
      }, intent);
      await releaseReturnFrames(page); await frames(page);
      assert.equal(await page.evaluate(() => scrollY), 520, 'new user intent must cancel the pending return position');
      if (intent === 'focus') assert.equal(await page.locator('.gallery-search').evaluate(input => input === document.activeElement), true);
    } finally { await releaseReturnFrames(page); await page.close(); }
  });
  await run('photo reader return navigation: old frames and old back buttons cannot affect a new reader', async () => {
    const page = await newPage({ mode: 'photo', count: 1000 });
    const pending = hold(url => url.pathname === '/api/photo-sets/I700', null);
    const visiblePending = hold(url => url.pathname === '/api/photo-sets/I600', null);
    try {
      await openReturnAlbum(page);
      await page.evaluate(() => { fixture.visibleNextReader = fixture.page.openPhotoSet('I600'); });
      await requested(visiblePending);
      assert.equal(await page.locator('.gallery-reader-back').isVisible(), true, 'the previous reader toolbar remains usable while the next reader is pending');
      assert.equal(await page.locator('.gallery-reader-title strong').textContent(), 'Reader I500');
      await page.locator('.gallery-reader-back').click();
      assert.equal(await page.evaluate(() => __transport.aborted.some(url => url.startsWith('/api/photo-sets/I600?'))), true,
        'a later click on the still-visible back button must cancel the pending next reader');
      visiblePending.release(); await page.evaluate(() => fixture.visibleNextReader);
      assert.equal(await page.evaluate(() => fixture.state.gallery.album), null);
      assert.equal(await page.locator('.gallery-photo-album-card').count(), 1000, 'late cancelled reader completion must preserve the requested list');
      await openReturnAlbum(page); await holdReturnFrames(page);
      await page.locator('.gallery-reader-back').evaluate(button => { fixture.oldReturnBack = button; button.click(); });
      await page.evaluate(() => { fixture.nextReader = fixture.page.openPhotoSet('I700'); window.scrollTo({ top: 0, behavior: 'instant' }); });
      await requested(pending); await releaseReturnFrames(page); await frames(page);
      assert.equal(await page.evaluate(() => scrollY), 0, 'a newly pending reader owns the view before its response renders');
      pending.release(); await page.evaluate(() => fixture.nextReader);
      await page.waitForFunction(() => scrollY < 2);
      await page.evaluate(() => fixture.oldReturnBack.click());
      assert.equal(await page.evaluate(() => fixture.state.gallery.album?.id), 'I700');
    } finally { visiblePending.release(); pending.release(); await releaseReturnFrames(page); await page.close(); }
  });
  await run('photo reader return direct: opening without a card does not reuse a prior return anchor', async () => {
    const page = await newPage({ mode: 'photo', count: 1000 });
    try {
      await openReturnAlbum(page);
      await page.evaluate(() => fixture.page.openPhotoSet('I700'));
      await page.locator('.gallery-reader-back').click(); await frames(page);
      await page.waitForFunction(() => scrollY < 2);
      assert.equal(await page.locator('.gallery-photo-album-card[data-gallery-album-id="I500"]').evaluate(card => card === document.activeElement), false);
    } finally { await page.close(); }
  });
  await run('photo reader return query: pending restore cannot reposition a new list query', async () => {
    const page = await newPage({ mode: 'photo', count: 1000 });
    try {
      await openReturnAlbum(page); await holdReturnFrames(page);
      await page.locator('.gallery-reader-back').evaluate(button => button.click());
      await page.evaluate(data => { fixture.seed(data, { query: 'replacement', visibleLimit: 80 }); window.scrollTo({ top: 520, behavior: 'instant' }); }, body(80));
      await releaseReturnFrames(page); await frames(page);
      assert.equal(await page.evaluate(() => scrollY), 520);
      assert.equal(await page.locator('.gallery-search').inputValue(), 'replacement');
      assert.equal(await page.locator('.gallery-photo-album-card').count(), 80);
    } finally { await releaseReturnFrames(page); await page.close(); }
  });
  for (const mode of ["photo", "manga", "media", "western", "tv"]) await run(`control construction ${mode}: builds only visible facets and preserves live selects`, async () => {
    const samples = [];
    for (let repeat = 0; repeat < 3; repeat++) {
      const page = await newPage({ mode, controlRoutes: true });
      const facets = { categories: Array.from({ length: 1000 }, (_, index) => ({ value: `category-${index}`, count: index + 1 })), people: Array.from({ length: 300 }, (_, index) => ({ value: `person-${index}`, count: index + 1 })) };
      const summaryBody = (value, scannedAt = "2026-10-04") => ({ totals: { photoSets: 12345, manga: 5000, movie: 5000 },
        facets: { ...value, media: value, western: value, tv: value }, scannedAt });
      const pageBody = (offset, value = facets) => mode === "western" ? westernBody(80, offset, { facets: value }) : body(80, offset, mode, { facets: value });
      const summaryFacets = repeat === 2;
      const sourceFacets = summaryFacets ? { people: facets.people } : facets;
      const response = hold(url => url.pathname === "/api/image-library/items" && url.searchParams.get("offset") === "80", pageBody(80, sourceFacets));
      const gates = [response];
      try {
        await page.evaluate(data => {
          // The harness already has a small list; measure a real cold control
          // construction rather than mistaking an incremental seed for initial work.
          document.querySelector(".gallery-shell").remove();
          fixture.state.gallery.data.facets = data.facets;
          window.__controlWork = { options: 0, selects: 0 };
          const NativeOption = Option, create = document.createElement.bind(document);
          window.Option = function (...args) { __controlWork.options++; return new NativeOption(...args); };
          window.Option.prototype = NativeOption.prototype;
          document.createElement = (tag, ...args) => {
            if (String(tag).toLowerCase() === "select") __controlWork.selects++;
            if (String(tag).toLowerCase() === "option") __controlWork.options++;
            return create(tag, ...args);
          };
        }, summaryBody(facets));
        const initial = await page.evaluate(({ data, selected, photoSearch }) => {
          const started = performance.now(); fixture.seed(data, { category: selected ? "category-999" : "all", query: photoSearch ? "server search" : "", sort: "updated" }); document.body.offsetHeight;
          return { ms: performance.now() - started, ...__controlWork, mountedOptions: document.querySelectorAll('.gallery-controls option').length, mountedSelects: document.querySelectorAll('.gallery-controls select').length };
        }, { data: pageBody(0, sourceFacets), selected: repeat === 1 && mode === "media", photoSearch: repeat === 2 && mode === "photo" });
        // Preserve the original unused-control budget; refresh now has the
        // stronger zero-construction contract below instead of == mounted.
        if (legacyEagerControls) console.log(JSON.stringify({ kind: "gallery-control-construction", mode, reference: true, initial }));
        assert.equal(initial.selects, initial.mountedSelects, "gallery controls must not construct unused facet selects");
        assert.equal(initial.options, initial.mountedOptions, "gallery controls must not construct unused facet options");
        const focusKey = mode === "western" ? "people" : mode === "photo" ? "sort" : repeat === 1 && mode === "tv" ? "people" : "category";
        await beginGalleryControlProbe(page, { focusKey, compose: repeat === 2 });
        const before = await galleryControlProjection(page);
        await page.evaluate(() => document.querySelector('.gallery-more').click()); await requested(response);
        response.release(); await settled(page, response);
        const appended = await readGalleryControlProbe(page);
        assertGalleryControlRetention(appended, { unchanged: true });
        assert.deepEqual(await galleryControlProjection(page), before, "unchanged append facets must retain their values, labels, counts, disabled state and selection");
        if (repeat === 2) {
          await page.locator('.gallery-search').evaluate(input => {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
            input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '候选' }));
          });
          assert.equal(await page.evaluate(() => fixture.state.gallery.query), mode === 'photo' ? 'server search' : '', 'background refresh must not submit an IME draft');
        }
        const summary = hold(url => url.pathname === "/api/image-library/summary", summaryBody(facets)); gates.push(summary);
        await beginGalleryControlProbe(page, { focusKey });
        await page.evaluate(() => { window.__controlSummaryRead = fixture.page.loadImageLibrary({ reload: true }); }); await requested(summary);
        summary.release(); await settled(page, summary); await page.evaluate(() => __controlSummaryRead);
        const summarized = await readGalleryControlProbe(page);
        assertGalleryControlRetention(summarized, { unchanged: true });
        assert.deepEqual(await galleryControlProjection(page), before, "an unchanged summary must preserve the current list facet projection");
        samples.push({ initial, appended, summarized });
        if (repeat > 0) {
          const changed = { categories: [...facets.categories.slice(0, -1).map((value, index) => ({ ...value, count: index === 0 ? 9001 : value.count })), { value: 'category-new', count: 73 }],
            people: [...facets.people.slice(0, -1).map((value, index) => ({ ...value, count: index === 0 ? 7001 : value.count })), { value: 'person-new', count: 37 }] };
          const changedRead = hold(url => url.pathname === (summaryFacets ? '/api/image-library/summary' : '/api/image-library/items')
            && (summaryFacets || url.searchParams.get('offset') === '160'), summaryFacets ? summaryBody(changed, '2026-10-05') : pageBody(160, changed)); gates.push(changedRead);
          await beginGalleryControlProbe(page, { focusKey });
          if (summaryFacets) await page.evaluate(() => { window.__controlSummaryRead = fixture.page.loadImageLibrary({ reload: true }); });
          else await page.evaluate(() => document.querySelector('.gallery-more').click());
          await requested(changedRead); changedRead.release(); await settled(page, changedRead);
          if (summaryFacets) await page.evaluate(() => __controlSummaryRead);
          const updated = await readGalleryControlProbe(page);
          assertGalleryControlRetention(updated, { unchanged: false });
          assert(updated.options <= 2, 'facet updates may construct only newly introduced option values');
          const projection = await galleryControlProjection(page);
          const category = projection.find(select => select.key === 'category');
          const people = projection.find(select => select.key === 'people');
          if (category) {
            assert.equal(category.options.find(option => option[0] === 'category-0')?.[2].replaceAll(',', ''), 'category-0 · 9001');
            assert(category.options.some(option => option[0] === 'category-new'));
            if (repeat === 1 && mode === 'media') {
              assert.equal(category.value, 'category-999', 'a selected missing facet must retain its explicit fallback value');
              assert.deepEqual(category.options.find(option => option[0] === 'category-999'), ['category-999', 'category-999', ''], 'fallback options must clear obsolete count titles');
            } else assert(!category.options.some(option => option[0] === 'category-999'));
          }
          if (people && !summaryFacets) {
            assert.equal(people.options.find(option => option[0] === 'person-0')?.[2].replaceAll(',', ''), 'person-0 · 7001');
            assert(people.options.some(option => option[0] === 'person-new'));
            assert(!people.options.some(option => option[0] === 'person-299'));
          }
          if (mode === 'photo' && repeat === 2) {
            const sort = projection.find(select => select.key === 'sort');
            assert.equal(sort.disabled, true); assert.equal(sort.value, 'updated'); assert.deepEqual(sort.options.map(option => option.slice(0, 2)), [['updated', '相关性排序']]);
          }
        }
        if (mode === "photo") assert.equal(await page.locator('.gallery-category-menu-panel button').count(), 1000, "all photo categories must remain available");
        if (repeat === 0 && mode !== 'manga') {
          const target = page.locator(`select[data-gallery-control="${focusKey}"]`);
          const expected = await target.evaluate(select => select.options[select.selectedIndex + 1].value);
          const field = focusKey === 'people' ? 'person' : focusKey;
          const requestStart = requests.length, routeStart = await page.evaluate(() => fixture.controlRoutes.length);
          await target.focus(); await page.keyboard.press('Alt+ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
          await page.waitForFunction(({ field, expected }) => fixture.state.gallery[field] === expected && !fixture.page.isImageLibraryListLoading(), { field, expected });
          assert(requests.slice(requestStart).some(key => { const url = new URL(key, base); return url.pathname === '/api/image-library/items' && url.searchParams.get(field) === expected; }), 'native Arrow/Enter must select the actual filter value in a real items request');
          const routeField = focusKey === 'people' ? 'galleryPerson' : focusKey === 'category' ? 'galleryCategory' : 'gallerySort';
          const routeEvidence = await page.evaluate(({ start, field }) => ({ calls: fixture.controlRoutes.slice(start),
            parsed: fixture.controlRouteSnapshot()[field], expected: { galleryMode: fixture.state.gallery.mode, galleryCategory: fixture.state.gallery.category,
              galleryPerson: fixture.state.gallery.person, gallerySort: fixture.state.gallery.sort, galleryQuery: fixture.state.gallery.query } }), { start: routeStart, field: routeField });
          assert(routeEvidence.calls.some(call => call.kind === 'push'), 'native selection must invoke the actual page route callback');
          for (const call of routeEvidence.calls) for (const [key, value] of Object.entries(routeEvidence.expected)) {
            assert.equal(call.route[key], value, 'the real callback overrides must preserve the intended gallery navigation fields');
            if (call.overrides && Object.hasOwn(call.overrides, key)) assert.equal(call.overrides[key], value, 'provided callback fields must not be silently replaced with current state');
          }
          assert.equal(routeEvidence.parsed, expected, 'native filtering must serialize the real merged callback route through the actual router');
        }
        if (repeat === 2 && mode === "photo") {
          await page.locator('.gallery-category-menu summary').click();
          await page.locator('.gallery-category-menu-panel button').last().click();
          await page.waitForFunction(() => fixture.state.gallery.category === 'category-new' && !fixture.page.isImageLibraryListLoading());
          assert.equal(await page.evaluate(() => fixture.controlRouteSnapshot().galleryCategory), 'category-new', 'the updated photo category menu must remain a real navigable control');
        }
        if (mode === 'photo') await verifyPhotoCategoryControls(page, repeat, facets, gates);
        if (repeat === 2 && ["manga", "western", "tv"].includes(mode)) {
          await page.evaluate(() => { fixture.state.gallery.sort = "unsupported-sort"; fixture.renderer.renderView(); });
          assert.equal(await page.evaluate(() => fixture.state.gallery.sort), "updated", "hidden sort controls must retain the existing sort normalization");
        }
        if (repeat === 2 && mode !== 'manga') {
          const liveCategoryMenu = await page.evaluate(() => { window.__retiredGallerySelects = [...document.querySelectorAll('.gallery-controls select')]; window.__retiredCategoryButtons = [...document.querySelectorAll('.gallery-photo-category-strip button')]; window.__retiredCategoryMenu = document.querySelector('.gallery-category-menu'); const live = Boolean(__retiredCategoryMenu?.isConnected && __retiredCategoryButtons[0]?.isConnected); fixture.state.gallery.mode = 'manga'; fixture.page.resetReader(); fixture.renderer.renderView(); return live; });
          if (mode === 'photo') assert.equal(liveCategoryMenu, true, 'new-mode retirement must capture a real connected category menu and button before navigation');
          await page.waitForFunction(() => !fixture.page.isImageLibraryListLoading()); await frames(page);
          const retiredRequests = requests.length;
          const retiredState = await page.evaluate(() => ({ mode: fixture.state.gallery.mode, category: fixture.state.gallery.category, person: fixture.state.gallery.person, sort: fixture.state.gallery.sort, routes: fixture.controlRoutes.length }));
          await page.evaluate(() => { for (const select of __retiredGallerySelects) { select.value = [...select.options].find(option => option.value !== select.value)?.value || 'all'; select.dispatchEvent(new Event('change', { bubbles: true })); } });
          await frames(page);
          assert.deepEqual(await page.evaluate(() => ({ mode: fixture.state.gallery.mode, category: fixture.state.gallery.category, person: fixture.state.gallery.person, sort: fixture.state.gallery.sort, routes: fixture.controlRoutes.length })), retiredState, 'retired select closures must not change another gallery mode or route');
          assert.equal(requests.slice(retiredRequests).filter(key => new URL(key, base).pathname.startsWith('/api/')).length, 0, 'retired selects must not start reads for the replacement mode');
          if (mode === 'photo') {
            await page.locator('.gallery-search').focus();
            await page.evaluate(() => { __retiredCategoryButtons[0]?.click(); __retiredCategoryMenu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
            await frames(page);
            assert.deepEqual(await page.evaluate(() => ({ mode: fixture.state.gallery.mode, category: fixture.state.gallery.category, person: fixture.state.gallery.person, sort: fixture.state.gallery.sort, routes: fixture.controlRoutes.length })), retiredState, 'retired photo category clicks and Escape must not mutate a new gallery mode');
            assert.equal(requests.slice(retiredRequests).filter(key => new URL(key, base).pathname.startsWith('/api/')).length, 0, 'retired photo categories must not request the replacement mode');
            assert.equal(await page.locator('.gallery-search').evaluate(input => document.activeElement === input), true, 'retired category Escape must not steal focus from the new mode');
          }
        }
      } finally { await page.evaluate(() => { window.__controlLive?.observer.disconnect(); window.__categoryLive?.observer.disconnect(); }).catch(() => {}); for (const gate of gates) { gate.release(); held.delete(gate); } await page.close(); }
    }
    console.log(JSON.stringify({ kind: "gallery-control-construction", mode, reference: legacyEagerControls, initialMsMedian: median(samples.map(sample => sample.initial.ms)), initial: samples[0].initial, appended: samples[0].appended, summarized: samples[0].summarized }));
  });
  for (const count of [80, 1000]) await run(`Western ${count}: loading and append retain person cards/images/focus/observer`, async () => {
    const page = await newPage({ mode: "western", count }), gate = hold(url => url.pathname === "/api/image-library/items" && url.searchParams.get("offset") === String(count), westernBody(80, count));
    try {
      const cdp = await page.context().newCDPSession(page); await cdp.send("Performance.enable");
      await snapshot(page); const before = await metrics(cdp);
      await page.evaluate(() => { document.querySelector('.gallery-more').click(); document.querySelector('.gallery-more').dispatchEvent(new MouseEvent('click')); }); await requested(gate);
      const pending = await read(page), middle = await metrics(cdp);
      if (legacyWestern) console.log(JSON.stringify({ kind: "legacy-western-shelf", count, pending }));
      assert(pending.row && pending.image && pending.focused && pending.observer, "Western loading must preserve mounted person resources");
      assert.equal(pending.created, 0); assert.equal(pending.renders.length, 0); assert(await page.locator('.gallery-more').isDisabled());
      assert.equal(await page.evaluate(() => fixture.state.gallery.visibleLimit), count + 80); assert.equal(await page.evaluate(url => __transport.started[url], gate.url), 1);
      gate.release(); await settled(page, gate);
      const success = await read(page), after = await metrics(cdp);
      assert(success.row && success.image && success.focused && success.observer); assert.equal(success.rows, count + 80); assert.equal(success.renders.length, 0);
      assert(success.created < 1000, "Western creation must follow the 80 incoming groups, not all mounted groups"); assert.equal(success.scroll, pending.scroll);
      assert(await page.evaluate(() => [...__coverObservers].every(observer => [...observer.counts.values()].every(value => value === 1))));
      console.log(JSON.stringify({ kind: "incremental-western-shelf", count, pending, success, loadingCpu: delta(before, middle), responseCpu: delta(middle, after) }));
    } finally { gate.release(); await page.close(); }
  });
  await run("Western failed page retries the original raw range without rebuilding", async () => {
    const page = await newPage({ mode: "western", count: 1000 }), failed = hold(url => url.pathname === "/api/image-library/items" && url.searchParams.get("offset") === "1000", null, "private Western page error");
    try {
      await snapshot(page); await page.evaluate(() => document.querySelector('.gallery-more').click()); await requested(failed); failed.release(); await settled(page, failed);
      assert((await read(page)).row && (await read(page)).focused); assert.match(await page.locator('.gallery-more').innerText(), /重试/);
      const retry = hold(url => url.pathname === "/api/image-library/items" && url.searchParams.get("offset") === "1000", westernBody(80, 1000));
      try {
        await page.evaluate(() => document.querySelector('.gallery-more').click()); await requested(retry);
        assert.equal(retry.url, failed.url, "retry cannot enlarge the original raw range"); assert.equal(await page.evaluate(() => fixture.state.gallery.visibleLimit), 1080);
        retry.release(); await settled(page, retry); assert.equal((await read(page)).rows, 1080); assert((await read(page)).row && (await read(page)).focused);
      } finally { retry.release(); }
    } finally { failed.release(); await page.close(); }
  });
  await run("Western overlapping raw page updates only its person card and preserves navigation", async () => {
    const page = await newPage({ mode: "western" }), changed = { ...westernBody(1, 7).items[0], videoCount: 999, playableCount: 998, size: 123456789, categories: [{ value: "updated category", count: 999 }], coverUrl: "/synthetic/updated-western.svg" };
    const gate = hold(url => url.pathname === "/api/image-library/items" && url.searchParams.get("offset") === "80", westernBody(2, 80, { items: [changed, westernBody(1, 80).items[0]], total: 83, nextOffset: 82 }));
    try {
      await snapshot(page); await page.evaluate(() => { window.__unchanged = document.querySelector('.gallery-western-person-card'); document.querySelector('.gallery-more').click(); }); await requested(gate); gate.release(); await settled(page, gate);
      assert(await page.evaluate(() => __unchanged.isConnected && !__row.isConnected && document.activeElement.textContent.includes('999')));
      assert.equal(await page.locator('.gallery-western-person-card').count(), 81); assert.equal(await page.evaluate(() => fixture.state.gallery.list.rawLoaded), 82);
      const tail = hold(url => url.pathname === "/api/image-library/items" && url.searchParams.get("offset") === "82", westernBody(1, 82, { total: 83, nextOffset: 83 }));
      try { await page.evaluate(() => document.querySelector('.gallery-more').click()); await requested(tail); tail.release(); await settled(page, tail); assert.equal(await page.locator('.gallery-more').count(), 0); }
      finally { tail.release(); }
      await page.locator('.gallery-western-person-card').filter({ has: page.getByText('Synthetic person 8', { exact: true }) }).click();
      assert.deepEqual(await page.evaluate(() => ({ person: fixture.state.gallery.person, limit: fixture.state.gallery.visibleLimit, mode: fixture.state.gallery.mode })), { person: "Synthetic person 8", limit: 80, mode: "western" });
      await page.waitForFunction(() => !fixture.page.isImageLibraryListLoading()); assert.equal(await page.locator('.gallery-western-person-grid').count(), 0);
      assert.match(requests.findLast(value => value.startsWith('/api/image-library/items')), /mode=western.*person=Synthetic\+person\+8/);
    } finally { gate.release(); await page.close(); }
  });
  await run("Western reordered groups use the original complete-render fallback", async () => {
    const page = await newPage({ mode: "western" }), gate = hold(url => url.pathname === "/api/image-library/items", westernBody(80, 0, { items: westernBody(80).items.reverse() }));
    try {
      await snapshot(page); await page.evaluate(() => { window.__task = fixture.page.loadImageLibraryItems({ force: true }); }); await requested(gate); gate.release(); await page.evaluate(() => __task); await frames(page);
      assert.equal((await read(page)).row, false); assert.match(await page.locator('.gallery-western-person-card').first().innerText(), /Synthetic person 80/);
      assert.equal(await page.locator('.gallery-western-person-card').count(), 80);
    } finally { gate.release(); await page.close(); }
  });
  for (const malformed of ["missing ID", "duplicate ID"]) await run(`Western ${malformed} keeps safe full fallback and raw EOF`, async () => {
    const page = await newPage({ mode: "western" });
    try {
      const seed = westernBody(2, 0, { total: 3 });
      if (malformed === "missing ID") seed.items[0] = { ...seed.items[0], id: "", routePath: "" };
      else seed.items[1] = { ...seed.items[0], videoCount: 777 };
      await page.evaluate(data => fixture.seed(data, { visibleLimit: 2 }), seed); await frames(page); await snapshot(page);
      const gate = hold(url => url.pathname === "/api/image-library/items" && url.searchParams.get("offset") === "2", westernBody(1, 2, { total: 3, nextOffset: 3 }));
      try {
        await page.evaluate(() => document.querySelector('.gallery-more').click()); await requested(gate); assert.equal((await read(page)).row, false);
        gate.release(); await settled(page, gate);
        assert.equal(await page.evaluate(() => fixture.state.gallery.list.rawLoaded), 3); assert.equal(await page.locator('.gallery-more').count(), 0);
        assert.equal(await page.locator('.gallery-western-person-card').count(), malformed === "missing ID" ? 3 : 2);
        assert.match(await page.locator('.gallery-western-person-card').first().innerText(), malformed === "missing ID" ? /Synthetic person 1/ : /777/);
      } finally { gate.release(); }
    } finally { await page.close(); }
  });
  await run("Western empty result retains its original empty message", async () => {
    const page = await newPage({ mode: "western" });
    try {
      await page.evaluate(data => fixture.seed(data), westernBody(0, 0, { total: 0, hasMore: false })); await frames(page);
      assert.equal(await page.locator('.gallery-western-person-card').count(), 0); assert.equal(await page.locator('.gallery-more').count(), 0); assert.match(await page.locator('.empty-state').innerText(), /没有匹配的欧美人物/);
    } finally { await page.close(); }
  });
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
  for (const mode of ["photo", "media"]) {
    await run(`search IME ${mode}: composition owns Enter Escape and native clear`, async () => {
      const page = await newPage({ mode });
      try {
        await page.evaluate(data => fixture.seed(data, { query: "Committed" }), body(80, 0, mode));
        const before = await page.evaluate(() => Object.values(__transport.started).reduce((sum, count) => sum + count, 0));
        const observed = await page.locator(".gallery-search").evaluate(input => {
          input.focus(); input.value = "flagged";
          const flagged = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }); input.dispatchEvent(flagged);
          const afterFlagged = [fixture.state.gallery.query, input.value, flagged.defaultPrevented];
          input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
          input.value = "zhongwen"; input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true })); input.setSelectionRange(1, 5);
          const enter = new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true, cancelable: true });
          input.dispatchEvent(enter);
          const afterEnter = [fixture.state.gallery.query, input.value, input.selectionStart, input.selectionEnd];
          // Some engines report no isComposing flag while the composition is active.
          const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }); input.dispatchEvent(escape);
          const afterEscape = [fixture.state.gallery.query, input.value];
          input.value = ""; input.dispatchEvent(new Event("search", { bubbles: true }));
          const afterClear = fixture.state.gallery.query;
          input.value = "中文完成"; input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: input.value }));
          return { prevented: [enter.defaultPrevented, escape.defaultPrevented], afterFlagged, afterEnter, afterEscape, afterClear, query: fixture.state.gallery.query };
        });
        assert.deepEqual(observed, { prevented: [false, false], afterFlagged: ["Committed", "flagged", false], afterEnter: ["Committed", "zhongwen", 1, 5], afterEscape: ["Committed", "zhongwen"], afterClear: "Committed", query: "Committed" }, "IME confirmation/cancellation must not submit or clear a gallery query");
        await frames(page);
        assert.equal(await page.evaluate(() => Object.values(__transport.started).reduce((sum, count) => sum + count, 0)), before, "composition must not start intermediate requests");
        const result = hold(url => url.pathname === "/api/image-library/items" && url.searchParams.get("q") === "中文完成", body(0, 0, mode, { total: 0 }));
        try {
          await page.locator(".gallery-media-search-submit").click(); await requested(result); result.release(); await settled(page, result);
          assert.equal(await page.evaluate(() => fixture.state.gallery.query), "中文完成", "the explicit search button must still submit completed Chinese text");
          assert.equal(await page.evaluate(url => __transport.started[url], result.url), 1);
        } finally { result.release(); }
      } finally { await page.close(); }
    });
    await run(`search IME ${mode}: trailing keyCode229 and ordinary search actions`, async () => {
      const page = await newPage({ mode });
      try {
        await page.evaluate(data => fixture.seed(data, { query: "Committed" }), body(80, 0, mode));
        const observed = await page.locator(".gallery-search").evaluate(input => {
          input.focus(); input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
          input.value = "中文完成"; input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: input.value }));
          const prevented = ["Enter", "Escape"].map(key => { const event = new KeyboardEvent("keydown", { key, keyCode: 229, bubbles: true, cancelable: true }); input.dispatchEvent(event); return event.defaultPrevented; });
          return { prevented, value: input.value, query: fixture.state.gallery.query };
        });
        assert.deepEqual(observed, { prevented: [false, false], value: "中文完成", query: "Committed" }, "the trailing IME key must retain its native confirmation behavior");
        const result = hold(url => url.pathname === "/api/image-library/items" && url.searchParams.get("q") === "中文完成", body(0, 0, mode, { total: 0 }));
        try { await page.locator(".gallery-search").press("Enter"); await requested(result); result.release(); await settled(page, result); }
        finally { result.release(); }
        const clear = hold(url => url.pathname === "/api/image-library/items" && !url.searchParams.get("q"), body(0, 0, mode, { total: 0 }));
        try {
          await page.locator(".gallery-search").press("Escape"); await requested(clear); clear.release(); await settled(page, clear);
          assert.equal(await page.locator(".gallery-search").inputValue(), ""); assert.equal(await page.evaluate(() => fixture.state.gallery.query), "");
          assert.equal(await page.evaluate(url => __transport.started[url], clear.url), 1, "ordinary Escape must clear only once");
        } finally { clear.release(); }
        await page.evaluate(data => fixture.seed(data, { query: "NativeClear" }), body(80, 0, mode));
        const nativeClear = hold(url => url.pathname === "/api/image-library/items" && !url.searchParams.get("q"), body(0, 0, mode, { total: 0 }));
        try {
          await page.locator(".gallery-search").evaluate(input => { input.value = ""; input.dispatchEvent(new Event("search", { bubbles: true })); });
          await requested(nativeClear); nativeClear.release(); await settled(page, nativeClear);
          assert.equal(await page.evaluate(() => fixture.state.gallery.query), "", "native search clear must keep working outside composition");
        } finally { nativeClear.release(); }
      } finally { await page.close(); }
    });
    for (const refresh of ["summary", "items"]) await run(`search IME ${mode}: ${refresh} refresh keeps a live composing input`, async () => {
      const page = await newPage({ mode }), response = hold(url => url.pathname === `/api/image-library/${refresh}`, refresh === "items" ? body(80, 0, mode) : null);
      try {
        await page.evaluate(refresh => { window.__imeTask = refresh === "summary" ? fixture.page.loadImageLibrary({ reload: true }) : fixture.page.loadImageLibraryItems({ force: true }); }, refresh); await requested(response);
        await page.locator(".gallery-search").evaluate(input => {
          window.__imeInput = input; window.__imeBlur = 0; input.addEventListener("blur", () => __imeBlur++);
          input.focus(); input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
          input.value = "zhongwen"; input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true })); input.setSelectionRange(1, 5);
        });
        response.release(); await page.evaluate(() => __imeTask); await frames(page);
        assert.deepEqual(await page.evaluate(() => ({ same: __imeInput === document.querySelector(".gallery-search"), connected: __imeInput.isConnected, focused: document.activeElement === __imeInput, blurs: __imeBlur, value: __imeInput.value, selection: [__imeInput.selectionStart, __imeInput.selectionEnd] })), { same: true, connected: true, focused: true, blurs: 0, value: "zhongwen", selection: [1, 5] }, "background gallery refresh must not detach or blur the composing search input");
        await page.locator(".gallery-search").evaluate(input => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
        assert.equal(await page.evaluate(() => fixture.state.gallery.query), "", "retained input closures must still recognize an active composition");
        await page.locator(".gallery-search").evaluate(input => { input.value = "中文完成"; input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: input.value })); });
        const next = hold(url => url.pathname === "/api/image-library/items" && url.searchParams.get("q") === "中文完成", body(0, 0, mode, { total: 0 }));
        try { await page.locator(".gallery-search").press("Enter"); await requested(next); next.release(); await settled(page, next); assert.equal(await page.evaluate(() => fixture.state.gallery.query), "中文完成"); }
        finally { next.release(); }
      } finally { response.release(); await page.close(); }
    });
    await run(`search focus ${mode}: new control intent survives old submit callbacks`, async () => {
      const page = await newPage({ mode }), result = hold(url => url.pathname === "/api/image-library/items" && url.searchParams.get("q") === "FocusTarget", body(0, 0, mode, { total: 0 }));
      try {
        const search = page.locator(".gallery-search");
        await search.fill("FocusTarget"); await search.press("Enter"); await requested(result);
        await page.locator("select.gallery-select").first().focus();
        await page.waitForTimeout(240); await frames(page);
        assert.equal(await page.evaluate(() => document.activeElement.matches("select.gallery-select")), true,
          "submitted search must not steal focus from a subsequently selected filter");
        result.release(); await settled(page, result);
        assert.equal(await page.evaluate(() => fixture.state.gallery.query), "FocusTarget");
        assert.equal(await page.evaluate(() => document.activeElement.matches(".gallery-search")), false, "late result fallback must not focus the search without search intent");
      } finally { result.release(); await page.close(); }
    });
    await run(`search focus ${mode}: selection and current search survive asynchronous fallback`, async () => {
      const page = await newPage({ mode }), result = hold(url => url.pathname === "/api/image-library/items" && url.searchParams.get("q") === "FocusTarget", body(0, 0, mode, { total: 0 }));
      try {
        const search = page.locator(".gallery-search");
        await search.fill("FocusTarget"); await search.press("Enter"); await requested(result);
        await search.evaluate(input => input.setSelectionRange(1, 5));
        await page.waitForTimeout(240); await frames(page);
        assert.deepEqual(await search.evaluate(input => [input.selectionStart, input.selectionEnd]), [1, 5], "late submit retries must not overwrite a newer cursor selection");
        result.release(); await settled(page, result);
        assert.equal(await search.evaluate(input => input === document.activeElement), true, "a real fallback render still restores the current search intent");
        await search.fill("AfterFallback");
        const next = hold(url => url.pathname === "/api/image-library/items" && url.searchParams.get("q") === "AfterFallback", body(1, 0, mode, { total: 1 }));
        try {
          await search.press("Enter"); await requested(next); next.release(); await settled(page, next);
          assert.equal(await page.evaluate(() => fixture.state.gallery.query), "AfterFallback", "the recreated search remains usable");
        } finally { next.release(); }
      } finally { result.release(); await page.close(); }
    });
  }
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
async function openReturnAlbum(page, { pointer = false } = {}) {
  const card = page.locator('.gallery-photo-album-card').nth(499);
  await card.evaluate(card => { card.scrollIntoView({ block: 'center', behavior: 'instant' }); card.focus({ preventScroll: true }); });
  await frames(page);
  const before = await card.evaluate(card => ({ top: card.getBoundingClientRect().top, scroll: scrollY }));
  if (pointer) await card.click(); else await card.press('Enter');
  await page.waitForFunction(() => fixture.state.gallery.album?.id === 'I500');
  await page.waitForFunction(() => scrollY < 2);
  return before;
}
async function holdReturnFrames(page) { await page.evaluate(() => { fixture.returnFrames = []; fixture.returnRaf = window.requestAnimationFrame; window.requestAnimationFrame = callback => { fixture.returnFrames.push(callback); return 0; }; }); }
async function releaseReturnFrames(page) { if (page.isClosed()) return; await page.evaluate(() => { if (!fixture.returnRaf) return; window.requestAnimationFrame = fixture.returnRaf; fixture.returnRaf = null; const tasks = fixture.returnFrames; fixture.returnFrames = []; for (const task of tasks) task(performance.now()); }); }
async function metrics(cdp) { return Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value])); }
function delta(before, after) { return { layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000, styleMs: (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000, taskMs: (after.TaskDuration - before.TaskDuration) * 1000 }; }
async function snapshot(page) {
  await page.evaluate(selector => { window.__row = document.querySelectorAll(selector)[7] || document.querySelector(selector); window.__image = __row.querySelector('img'); window.__coverObserver = __coverObservers.at(-1); __row.focus(); window.scrollTo(0, 400); window.__observed = 0; const observer = new MutationObserver(records => { __observed += records.length; }); observer.observe(__row, { attributes: true }); __row.dataset.fixtureObserved = 'true'; __created = 0; __renders.length = 0; }, cardSelector); await frames(page);
}
async function read(page) { return page.evaluate(selector => ({ row: __row.isConnected, image: __image.isConnected, focused: document.activeElement === __row, observer: !__coverObserver.off && __coverObservers.at(-1) === __coverObserver, observedChanges: __observed, rows: document.querySelectorAll(selector).length, created: __created, renders: __renders.slice(), scroll: scrollY }), cardSelector); }
async function seedPhotoCategories(page, categories, selected = 'all') {
  await page.evaluate(({ data, categories, selected }) => {
    window.__categoryLive?.observer.disconnect();
    fixture.state.gallery.data.facets = { categories, people: [] };
    fixture.seed(data, { category: selected, query: '', photoView: 'albums', photoCollection: null, sort: 'updated', visibleLimit: 80 });
    if (!window.__categoryCreateInstalled) {
      const create = document.createElement.bind(document);
      document.createElement = (...args) => { const node = create(...args); window.__categoryCreated?.push(node); return node; };
      window.__categoryCreateInstalled = true;
    }
  }, { data: body(80, 0, 'photo', { facets: { people: [] } }), categories, selected });
  await frames(page);
}
async function beginPhotoCategoryProbe(page, label = 'category-500') {
  await page.locator('.gallery-category-menu summary').evaluate(summary => { if (!summary.parentElement.open) summary.click(); });
  await page.locator('.gallery-category-menu-panel button').filter({ hasText: label }).first().evaluate(button => { button.focus({ preventScroll: true }); button.scrollIntoView({ block: 'center', behavior: 'instant' }); });
  await frames(page);
  await page.evaluate(() => {
    window.__categoryLive?.observer.disconnect();
    const strip = document.querySelector('.gallery-photo-category-strip'), menu = strip.querySelector('details'), summary = menu.querySelector('summary'), panel = menu.querySelector('.gallery-category-menu-panel'), target = document.activeElement;
    const ancestors = []; for (let node = target; node; node = node.parentElement) ancestors.push({ node, parent: node.parentElement });
    const keys = parent => { const seen = new Map(); return [...parent.children].filter(node => node.matches('button')).map(node => { const label = node.getAttribute('aria-label').split('，')[0], occurrence = seen.get(label) || 0; seen.set(label, occurrence + 1); return { key: `${label}:${occurrence}`, node }; }); };
    const record = window.__categoryLive = { strip, menu, summary, panel, target, ancestors, top: panel.scrollTop, featured: keys(strip), buttons: keys(panel), removed: [], blur: 0 };
    target.addEventListener('blur', () => record.blur++);
    record.observer = new MutationObserver(records => { for (const mutation of records) record.removed.push(...mutation.removedNodes); });
    record.observer.observe(document.querySelector('#workGrid'), { childList: true, subtree: true });
    window.__categoryCreated = [];
  });
}
async function readPhotoCategoryProbe(page) {
  await frames(page);
  return page.evaluate(() => {
    const record = __categoryLive, current = document.querySelector('.gallery-photo-category-strip'), menu = current.querySelector('details'), panel = menu?.querySelector('.gallery-category-menu-panel');
    const projection = parent => { const seen = new Map(); return [...(parent?.children || [])].filter(node => node.matches('button')).map(node => { const label = node.getAttribute('aria-label').split('，')[0], occurrence = seen.get(label) || 0; seen.set(label, occurrence + 1); return { key: `${label}:${occurrence}`, label, count: node.querySelector('small')?.textContent ?? null, title: node.title, aria: node.getAttribute('aria-label'), pressed: node.getAttribute('aria-pressed'), active: node.classList.contains('active') }; }); };
    const retained = (previous, parent) => { const current = projection(parent), nodes = [...(parent?.children || [])].filter(node => node.matches('button')), byKey = new Map(current.map((entry, index) => [entry.key, nodes[index]])); return previous.every(entry => !byKey.has(entry.key) || byKey.get(entry.key) === entry.node); };
    const removedTarget = !record.target.isConnected;
    const rect = record.target.getBoundingClientRect(), bounds = panel?.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y), targetVisible = !removedTarget && rect.width > 0 && rect.height > 0 && x >= Math.max(0, bounds?.left ?? 0) && x <= Math.min(innerWidth, bounds?.right ?? 0) && y >= Math.max(0, bounds?.top ?? 0) && y <= Math.min(innerHeight, bounds?.bottom ?? 0) && (hit === record.target || record.target.contains(hit));
    return { same: current === record.strip && menu === record.menu && menu?.querySelector('summary') === record.summary && panel === record.panel,
      open: Boolean(menu?.open), focus: document.activeElement === record.target, summaryFocus: document.activeElement === record.summary, removedTarget,
      ancestors: record.ancestors.every(({ node, parent }) => node === record.target && removedTarget || node.isConnected && node.parentElement === parent),
      detached: record.removed.filter(node => record.ancestors.some(entry => entry.node === node && !(removedTarget && node === record.target))).length,
      blur: record.blur, targetVisible, top: panel?.scrollTop, previousTop: record.top, featured: projection(current), buttons: projection(panel),
      retained: retained(record.featured, current) && retained(record.buttons, panel), previousFeatured: record.featured.map(entry => entry.key), previousButtons: record.buttons.map(entry => entry.key),
      created: { chips: __categoryCreated.filter(node => node.classList.contains('gallery-category-chip')).length,
        details: __categoryCreated.filter(node => node.matches('details.gallery-category-menu')).length,
        summary: __categoryCreated.filter(node => node.matches('.gallery-category-menu > summary')).length,
        panel: __categoryCreated.filter(node => node.classList.contains('gallery-category-menu-panel')).length,
        small: __categoryCreated.filter(node => node.matches('.gallery-category-chip > small')).length } };
  });
}
function assertPhotoCategoryProjection(value, categories, selected) {
  const facets = categories.filter(item => !['__fanhao_media_kind_movie__', '__fanhao_media_kind_tv__', '__fanhao_media_kind_anime__'].includes(item.value));
  const featured = facets.slice(0, 4), chosen = facets.find(item => item.value === selected);
  if (chosen && !featured.includes(chosen)) featured[featured.length - 1] = chosen;
  const number = value => new Intl.NumberFormat('zh-CN').format(value);
  const expected = (item, menu = false) => ({ label: item.value, count: menu ? number(item.count || 0) : null, title: `${item.value} · ${number(item.count)} 期`, aria: `${item.value}，${number(item.count)} 期`, pressed: String(selected === item.value), active: selected === item.value });
  const simplify = ({ key, ...item }) => item;
  assert.deepEqual(value.featured.map(simplify), [expected({ value: '全部大类', count: facets.reduce((sum, item) => sum + Number(item.count || 0), 0) }), ...featured.map(item => expected(item))].map((item, index) => index ? item : { ...item, pressed: String(selected === 'all'), active: selected === 'all' }), 'photo featured categories must preserve source order, selected promotion and filtered totals');
  assert.deepEqual(value.buttons.map(simplify), facets.map(item => expected(item, true)), 'all photo category occurrences must preserve labels, counts, aria, order and selection');
}
function assertPhotoCategoryRetention(value, categories, selected, { removed = false, unchanged = false } = {}) {
  assert(value.same && value.open && value.ancestors && value.detached === 0 && value.retained && (removed ? value.removedTarget && value.summaryFocus : value.focus && value.blur === 0 && value.targetVisible),
    'background gallery refresh must keep the expanded photo category menu ancestry and focus without transient detach');
  if (unchanged) assert(Math.abs(value.top - value.previousTop) <= 1 && value.previousTop > 100, 'an unchanged category refresh must preserve the far-end menu scroll position');
  assertPhotoCategoryProjection(value, categories, selected);
  const added = (current, previous) => { const keys = new Set(previous); return current.filter(item => !keys.has(item.key)).length; };
  assert.deepEqual(value.created, { chips: added(value.featured, value.previousFeatured) + added(value.buttons, value.previousButtons), details: 0, summary: 0, panel: 0, small: added(value.buttons, value.previousButtons) }, 'category refresh may construct only newly introduced featured/menu occurrences');
}
async function verifyPhotoCategoryControls(page, repeat, facets, gates) {
  const categories = facets.categories, selected = repeat === 1 ? 'category-998' : 'all';
  await seedPhotoCategories(page, categories, selected);
  await beginPhotoCategoryProbe(page);
  const appended = hold(url => url.pathname === '/api/image-library/items' && url.searchParams.get('offset') === '80', body(80, 80, 'photo', { facets: { people: [] } })); gates.push(appended);
  await page.evaluate(() => document.querySelector('.gallery-more').click()); await requested(appended); appended.release(); await settled(page, appended);
  assertPhotoCategoryRetention(await readPhotoCategoryProbe(page), categories, selected, { unchanged: true });
  const changed = repeat === 0 ? categories : repeat === 1
    ? [categories[500], ...categories.slice(0, 500).map(item => ({ ...item, count: item.value === 'category-0' ? 9001 : item.count })), ...categories.slice(501, -1), { value: 'category-new', count: 73 }]
    : [...categories.filter(item => item.value !== 'category-500'), { value: 'category-new', count: 73 }];
  await beginPhotoCategoryProbe(page);
  const summary = hold(url => url.pathname === '/api/image-library/summary', { totals: { photoSets: 12345 }, facets: { categories: changed, people: [] }, scannedAt: 'category-updated' }); gates.push(summary);
  await page.evaluate(() => { window.__categorySummaryRead = fixture.page.loadImageLibrary({ reload: true }); }); await requested(summary); summary.release(); await settled(page, summary); await page.evaluate(() => __categorySummaryRead);
  assertPhotoCategoryRetention(await readPhotoCategoryProbe(page), changed, selected, { unchanged: repeat === 0, removed: repeat === 2 });
  await page.evaluate(() => { __categoryLive.observer.disconnect(); const summary = __categoryLive.summary; summary.focus(); });
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => !__categoryLive.menu.open && document.activeElement === __categoryLive.summary), true, 'native Escape must close the live category menu and retain its summary focus');
  if (repeat !== 2) return;

  // Small threshold/duplicate chains share this existing photo sample. All
  // refreshes remain real summary GETs; no extra scenario or synthetic handler.
  const four = Array.from({ length: 4 }, (_, index) => ({ value: `threshold-${index}`, count: index + 1 }));
  await seedPhotoCategories(page, four);
  assert.equal(await page.locator('.gallery-category-menu').count(), 0);
  const refresh = async categories => { const gate = hold(url => url.pathname === '/api/image-library/summary', { totals: { photoSets: 12345 }, facets: { categories, people: [] }, scannedAt: 'category-threshold' }); gates.push(gate); await page.evaluate(() => { window.__categorySummaryRead = fixture.page.loadImageLibrary({ reload: true }); }); await requested(gate); gate.release(); await settled(page, gate); await page.evaluate(() => __categorySummaryRead); };
  await page.evaluate(() => { window.__thresholdStrip = document.querySelector('.gallery-photo-category-strip'); window.__thresholdButtons = [...__thresholdStrip.children]; window.__categoryCreated = []; });
  const five = [...four, { value: 'threshold-4', count: 5 }]; await refresh(five);
  assert.equal(await page.locator('.gallery-category-menu').evaluate(menu => menu.open), false, 'a newly required all-categories menu starts closed');
  assert.deepEqual(await page.evaluate(() => ({ same: __thresholdStrip === document.querySelector('.gallery-photo-category-strip') && __thresholdButtons.every((node, index) => __thresholdStrip.children[index] === node), chips: __categoryCreated.filter(node => node.classList.contains('gallery-category-chip')).length, details: __categoryCreated.filter(node => node.matches('details.gallery-category-menu')).length, summary: __categoryCreated.filter(node => node.matches('.gallery-category-menu > summary')).length, panel: __categoryCreated.filter(node => node.classList.contains('gallery-category-menu-panel')).length, small: __categoryCreated.filter(node => node.matches('.gallery-category-chip > small')).length })), { same: true, chips: 5, details: 1, summary: 1, panel: 1, small: 5 }, 'crossing four to five categories may construct only the newly required menu subtree');
  await beginPhotoCategoryProbe(page, 'threshold-4'); await refresh(four);
  assert.equal(await page.locator('.gallery-category-menu').count(), 0, 'four categories must retire the unnecessary menu');
  assert.equal(await page.evaluate(() => document.activeElement === __categoryLive.featured[0].node && __categoryLive.strip.isConnected), true, 'removing the focused menu at the four-category boundary must focus the surviving all-category chip');
  assert.equal(await page.evaluate(() => __thresholdButtons.every((node, index) => __thresholdStrip.children[index] === node)), true, 'retiring the menu must preserve the existing featured category controls');
  const duplicates = [{ value: 'duplicate', count: 1 }, { value: 'duplicate', count: 2 }, { value: 'other-1', count: 3 }, { value: 'other-2', count: 4 }, { value: 'selected-last', count: 5 }, { value: '__fanhao_media_kind_movie__', count: 9000 }];
  await seedPhotoCategories(page, duplicates, 'selected-last'); await beginPhotoCategoryProbe(page, 'duplicate');
  const updated = duplicates.map((item, index) => ({ ...item, count: index < 2 ? 11 * (index + 1) : item.count })); await refresh(updated);
  assertPhotoCategoryRetention(await readPhotoCategoryProbe(page), updated, 'selected-last');
  await beginPhotoCategoryProbe(page, 'duplicate');
  const missingSelected = [...updated.filter(item => item.value !== 'selected-last'), { value: 'replacement', count: 6 }]; await refresh(missingSelected);
  assertPhotoCategoryRetention(await readPhotoCategoryProbe(page), missingSelected, 'selected-last');
  await page.evaluate(() => __categoryLive.observer.disconnect());

  // A results-only search keeps these controls live. Their click must remain
  // valid even though summary/list registration generations have changed.
  await page.evaluate(() => { window.__liveCategoryButton = __categoryLive.buttons[0].node; });
  const searchRead = hold(url => url.pathname === '/api/image-library/items' && url.searchParams.get('q') === 'category-search', body(80, 0, 'photo', { facets: { people: [] } })); gates.push(searchRead);
  await page.locator('.gallery-search').fill('category-search'); await page.locator('.gallery-search').press('Enter'); await requested(searchRead);
  assert.equal(await page.evaluate(() => __liveCategoryButton.isConnected), true, 'results-only search must preserve the live category control owner while its first page is pending');
  const requestStart = requests.length, routeStart = await page.evaluate(() => fixture.controlRoutes.length);
  await page.evaluate(() => __liveCategoryButton.focus()); await page.keyboard.press('Enter');
  await page.waitForFunction(() => fixture.state.gallery.category === 'duplicate' && !fixture.page.isImageLibraryListLoading());
  assert(requests.slice(requestStart).some(key => { const url = new URL(key, base); return url.pathname === '/api/image-library/items' && url.searchParams.get('category') === 'duplicate' && url.searchParams.get('q') === 'category-search' && url.searchParams.get('photoView') === 'collections'; }), 'native category Enter after search must request the selected category in the actual current query');
  const route = await page.evaluate(start => ({ calls: fixture.controlRoutes.slice(start), current: fixture.controlRouteSnapshot(), gallery: { photoView: fixture.state.gallery.photoView, subCategory: fixture.state.gallery.subCategory, person: fixture.state.gallery.person, seriesKey: fixture.state.gallery.seriesKey, photoDate: fixture.state.gallery.photoDate } }), routeStart);
  assert(route.calls.some(call => call.kind === 'push') && route.current.galleryCategory === 'duplicate' && route.current.galleryQuery === 'category-search', 'native category Enter must serialize the actual current query and selected category through the real router');
  assert.deepEqual(route.gallery, { photoView: 'collections', subCategory: 'all', person: 'all', seriesKey: '', photoDate: 'all' });
  const accepted = await page.evaluate(() => {
    const input = document.querySelector('.gallery-search'); input.focus(); input.value = 'newer category draft'; input.setSelectionRange(2, 8);
    const ancestors = []; for (let node = input; node; node = node.parentElement) ancestors.push({ node, parent: node.parentElement });
    window.__acceptedCategory = { input, ancestors, content: document.querySelector('.gallery-content') };
    return { category: fixture.state.gallery.category, query: fixture.state.gallery.query, photoView: fixture.state.gallery.photoView, key: fixture.state.gallery.list.key, routes: fixture.controlRoutes.length, route: fixture.controlRouteSnapshot() };
  });
  searchRead.release(); await settled(page, searchRead);
  assert.deepEqual(await page.evaluate(() => ({ category: fixture.state.gallery.category, query: fixture.state.gallery.query, photoView: fixture.state.gallery.photoView, key: fixture.state.gallery.list.key, routes: fixture.controlRoutes.length, route: fixture.controlRouteSnapshot() })), accepted, 'late first-search success must preserve the newer category result and actual route');
  assert.equal(await page.evaluate(() => { const saved = __acceptedCategory, input = saved.input; return saved.content === document.querySelector('.gallery-content') && saved.ancestors.every(({ node, parent }) => node.isConnected && node.parentElement === parent) && document.activeElement === input && input.value === 'newer category draft' && input.selectionStart === 2 && input.selectionEnd === 8; }), true, 'late first-search success must preserve the newer category DOM, input selection and focus');

  assert.equal(await page.evaluate(() => { window.__oldCategoryButton = document.querySelector('.gallery-photo-category-strip > button'); window.__oldCategoryMenu = document.querySelector('.gallery-category-menu'); return Boolean(__oldCategoryButton?.isConnected && __oldCategoryMenu?.isConnected); }), true, 'same-mode retirement must capture a real connected category menu and button before navigation');
  await page.locator('.gallery-photo-view-switch button').last().click();
  await page.waitForFunction(() => !fixture.page.isImageLibraryListLoading()); await frames(page);
  await page.locator('.gallery-search').focus();
  const before = await page.evaluate(() => ({ gallery: structuredClone({ category: fixture.state.gallery.category, mode: fixture.state.gallery.mode, query: fixture.state.gallery.query, photoView: fixture.state.gallery.photoView }), routes: fixture.controlRoutes.length })), reads = requests.length;
  await page.evaluate(() => { __oldCategoryButton.click(); __oldCategoryMenu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); await frames(page);
  assert.deepEqual(await page.evaluate(() => ({ gallery: structuredClone({ category: fixture.state.gallery.category, mode: fixture.state.gallery.mode, query: fixture.state.gallery.query, photoView: fixture.state.gallery.photoView }), routes: fixture.controlRoutes.length })), before, 'retired category clicks and Escape must not mutate a same-mode replacement navigation');
  assert.equal(requests.slice(reads).filter(key => new URL(key, base).pathname.startsWith('/api/')).length, 0, 'retired same-mode category controls must not start new reads');
  assert.equal(await page.locator('.gallery-search').evaluate(input => document.activeElement === input), true, 'retired category Escape must respect the replacement input focus');
}
async function galleryControlProjection(page) {
  return page.locator('.gallery-controls').evaluate(controls => [...controls.querySelectorAll('select')].map(select => ({
    key: select.dataset.galleryControl, label: select.getAttribute('aria-label'), value: select.value, disabled: select.disabled,
    options: [...select.options].map(option => [option.value, option.textContent, option.title])
  })));
}
async function beginGalleryControlProbe(page, { focusKey, compose = false }) {
  await page.evaluate(({ focusKey, compose }) => {
    window.__controlLive?.observer.disconnect();
    const controls = document.querySelector('.gallery-controls'), search = controls.querySelector('.gallery-search');
    search.value = 'unsubmitted draft'; search.setSelectionRange(1, 5);
    if (compose) {
      search.dispatchEvent(new CompositionEvent('compositionstart', { data: '候选', bubbles: true }));
      search.dispatchEvent(new InputEvent('input', { data: '候选', inputType: 'insertCompositionText', isComposing: true, bubbles: true }));
    }
    const selects = [...controls.querySelectorAll('select')];
    const target = compose ? search : selects.find(select => select.dataset.galleryControl === focusKey && !select.disabled) || search;
    target.focus({ preventScroll: true });
    const ancestors = [];
    for (const control of [search, ...selects]) for (let node = control; node; node = node.parentElement) ancestors.push({ node, parent: node.parentElement });
    const record = window.__controlLive = { controls, search, target, ancestors, selects: selects.map(node => ({ node, options: [...node.options] })), blur: 0, detached: 0, optionRemoved: 0 };
    target.addEventListener('blur', () => record.blur++);
    record.observer = new MutationObserver(records => { for (const mutation of records) for (const removed of mutation.removedNodes) {
      if (record.ancestors.some(ancestor => ancestor.node === removed)) record.detached++;
      if (record.selects.some(select => select.options.includes(removed))) record.optionRemoved++;
    } });
    record.observer.observe(document.querySelector('#workGrid'), { childList: true, subtree: true });
    __controlWork.options = __controlWork.selects = 0;
  }, { focusKey, compose });
}
async function readGalleryControlProbe(page) {
  await frames(page);
  return page.evaluate(() => {
    const record = __controlLive, selects = [...document.querySelectorAll('.gallery-controls select')];
    const optionSets = record.selects.map(select => { const options = [...select.node.options]; return { nodes: new Set(options), values: new Set(options.map(option => option.value)) }; });
    return { ...__controlWork, mountedOptions: selects.reduce((sum, select) => sum + select.options.length, 0), mountedSelects: selects.length,
      sameControls: record.controls === document.querySelector('.gallery-controls'),
      selectsRetained: record.selects.length === selects.length && record.selects.every((select, index) => select.node === selects[index]),
      optionsRetained: record.selects.every(select => select.options.length === select.node.options.length && select.options.every((option, index) => option === select.node.options[index])),
      commonOptionsRetained: record.selects.every((select, index) => select.options.every(option => !optionSets[index].values.has(option.value) || optionSets[index].nodes.has(option))),
      ancestorsRetained: record.ancestors.every(({ node, parent }) => node.isConnected && node.parentElement === parent),
      focus: document.activeElement === record.target, blur: record.blur, detached: record.detached, optionRemoved: record.optionRemoved,
      search: record.search === document.querySelector('.gallery-search') && record.search.value === 'unsubmitted draft' && record.search.selectionStart === 1 && record.search.selectionEnd === 5 };
  });
}
function assertGalleryControlRetention(value, { unchanged }) {
  assert(value.sameControls && value.selectsRetained && value.ancestorsRetained && value.focus && value.blur === 0 && value.detached === 0,
    'background gallery refresh must keep native select ancestry and focus without blur');
  assert.equal(value.search, true, 'background gallery refresh must preserve the original search draft and selection');
  assert.equal(value.selects, 0, 'same-mode background refresh must not construct replacement native selects');
  if (unchanged) {
    assert(value.optionsRetained && value.optionRemoved === 0, 'unchanged facets must retain every native option in its original order');
    assert.equal(value.options, 0, 'unchanged facets must not construct replacement native options');
  } else assert.equal(value.commonOptionsRetained, true, 'changed facets must retain existing matching option objects');
}
async function newPage({ mode = "photo", count = 80, ignoreAbort = true, unsupportedVisibility = false, oracleSeed = false, emptySeed = false, controlRoutes = false } = {}) {
  const faultStart = faults.length, startup = { consoleErrors: [], requestFailures: [] };
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.on("pageerror", error => faults.push(error.message));
  const remember = (list, value) => { list.push(value); if (list.length > 8) list.shift(); };
  page.on('console', message => { if (message.type() === 'error') remember(startup.consoleErrors, message.text().slice(0, 600)); });
  page.on('requestfailed', request => remember(startup.requestFailures, { url: request.url().slice(0, 600), error: request.failure()?.errorText?.slice(0, 300) }));
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
  try {
    await page.goto(`${base}/probe?mode=${mode}&count=${count}${unsupportedVisibility ? "&unsupported=1" : ""}${oracleSeed ? "&oracle=1" : ""}${emptySeed ? "&empty=1" : ""}${controlRoutes ? "&control-routes=1" : ""}`); await page.waitForFunction(() => Boolean(window.fixture)); await frames(page); return page;
  } catch (error) {
    let timer;
    try {
      const document = await Promise.race([
        page.evaluate(() => ({ readyState: document.readyState, fixture: Boolean(window.fixture), body: document.body?.textContent?.slice(0, 1000) || '', scripts: [...document.scripts].slice(-8).map(script => script.src.slice(0, 400) || '<inline>') })).catch(failure => ({ snapshotError: failure.message.slice(0, 400) })),
        new Promise(resolve => { timer = setTimeout(() => resolve({ snapshotTimeout: true }), 1000); })
      ]);
      console.error(JSON.stringify({ kind: 'gallery-startup-failure', case: currentCase, mode, url: page.url(), ...startup, faults: faults.slice(faultStart).slice(-8).map(value => value.slice(0, 600)), document }));
    } finally { clearTimeout(timer); await page.close().catch(() => {}); }
    throw error;
  }
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
  const controlRoutes = url.searchParams.has("control-routes");
  const seedData = url.searchParams.has('empty') ? body(0, 0, mode, { total: 6000 }) : url.searchParams.has('oracle') ? oracle.payload({ limit: String(count), ...(mode === 'tv' ? { tvView: 'series' } : {}) }) : mode === 'western' ? westernBody(count) : body(count, 0, mode);
  return `<!doctype html><meta charset=utf-8>${galleryStyles.map(href => `<link rel=stylesheet href="${href}${url.searchParams.get("unsupported") === "1" && href.includes("/catalog.css") ? "&unsupported=1" : ""}">`).join("")}<body class="gallery-view ${["photo", "manga"].includes(mode) ? "gallery-photo-view" : "gallery-media-view"}"><main class=app-shell><div id=statsRow></div><section id=workGrid></section></main><script type=module>
import{createGalleryPage}from'/modules/content-index/gallery-page.js';import{createGalleryRenderer}from'/modules/content-index/gallery-renderer.js';${controlRoutes ? "import{routeUrl,routeFromUrl,normalizeRoute}from'/js/router.js';" : ''}
const formatter=new Intl.NumberFormat('zh-CN');${formatters}
const noop=()=>{},state={activeView:'gallery',accessMode:'local',uiConfig:{},gallery:{mode:${JSON.stringify(mode)},photoView:'albums',category:'all',subCategory:'all',person:'all',photoDate:'all',query:'',sort:'updated',mediaKind:'all',seriesKey:'',visibleLimit:${count},fitWidth:true,album:null,comic:null,media:null,data:{totals:{photoSets:5000,manga:5000,movie:5000},facets:{},scannedAt:'initial'},status:''}},els={workGrid:document.querySelector('#workGrid'),statsRow:document.querySelector('#statsRow')};
const api=async(url,options={})=>{const res=await fetch(url,options),data=await res.json();if(!res.ok)throw new Error(data.error||'controlled synthetic error');return data;};let page;
const shared={api,state,els,formatNumber,formatBytes,formatDateTime,cancelScheduledWorkRendering:noop,disconnectPeopleIndexAutoload:noop,resetProgressiveCoverLoading:noop,writeStoredFlag:noop,includesText:(text,q)=>String(text).includes(q),openAdminScript:noop};
${controlRoutes ? `const controlRoutes=[];const syncControlRoute=(kind,overrides)=>{const g=state.gallery;const defaults={view:'gallery',galleryMode:g.mode,galleryPhotoView:g.photoView,galleryPhotoCollection:g.photoCollection||'',galleryAlbumId:g.album?.id||'',galleryComicId:g.comic?.id||'',galleryChapterIndex:String(g.chapter?.index||''),galleryMediaId:g.media?.id||'',galleryQuery:g.query,galleryMediaKind:g.mediaKind,galleryCategory:g.category,gallerySubCategory:g.subCategory,galleryPerson:g.person,gallerySeriesKey:g.seriesKey,galleryPhotoDate:g.photoDate,gallerySort:g.sort};const route=normalizeRoute({...defaults,...overrides});const url=routeUrl(route);controlRoutes.push({kind,overrides:overrides===undefined?null:structuredClone(overrides),route,url});history[kind==='replace'?'replaceState':'pushState'](null,'',url);};` : ''}
const renderer=createGalleryRenderer({...shared,getGalleryPage:()=>page});page=createGalleryPage({...shared,clearPersonSelection:noop,hidePersonProfile:noop,setMainHeader:noop,normalizeUiConfig:value=>value,galleryModeLabel:renderer.modeLabel,renderGalleryStats:renderer.renderStats,renderGalleryView:renderer.renderView,pushRoute:${controlRoutes ? "overrides=>syncControlRoute('push',overrides)" : 'noop'},replaceRoute:${controlRoutes ? "overrides=>syncControlRoute('replace',overrides)" : 'noop'},syncRouteAfterNavigation:noop});
const seed=(data,options={})=>{Object.assign(state.gallery,options);state.gallery.list={...data,key:page.imageLibraryListKey(),rawLoaded:data.rawLoaded??data.items.length};renderer.renderStats();renderer.renderView();};
window.fixture={state,page,renderer,seed${controlRoutes ? ',controlRoutes,controlRouteSnapshot:()=>routeFromUrl()' : ''}};seed(${JSON.stringify(seedData)},${JSON.stringify(url.searchParams.has('oracle') ? { sort: seedData.sort || 'updated', person: 'all' } : {})});${url.searchParams.has('empty') ? 'state.gallery.list=null;renderer.renderView();' : ''}
</script>`;
}
