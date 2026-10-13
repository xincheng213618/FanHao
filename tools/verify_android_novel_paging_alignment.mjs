import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

// Production reader/CSS in private HTTP + Chromium with synthetic chapters only.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'android-client/www');
let source = fs.readFileSync(path.join(assets, 'modules/novels/novel-views.js'), 'utf8').replace(/\r\n/g, '\n');
const legacy = process.argv.includes('--legacy-alignment');
const unguarded = process.argv.includes('--unguarded-paging-owner');
const ownershipOnly = process.argv.includes('--ownership-only') || unguarded;
const shortOnly = process.argv.includes('--short-only');
const alignmentOnly = process.argv.includes('--alignment-only');
const selectedWidth = Number(process.argv.find(arg => arg.startsWith('--width='))?.split('=')[1]);
if (selectedWidth) assert([320, 400, 768].includes(selectedWidth));
if (legacy) {
  const aligned = '      const left = ratio >= 1 ? layout.max : Math.floor((layout.max * ratio + 0.5) / layout.pitch) * layout.pitch;';
  assert.equal(source.split(aligned).length, 2, 'negative locates only the actual ratio-to-column decision');
  source = source.replace(aligned, '      const left = layout.max * ratio;');
}
if (unguarded) {
  const gate = '  function installReaderPaging(content) {\n    const ownAction = createReaderActionOwner();';
  assert.equal(source.split(gate).length, 2, 'negative changes only paging control ownership');
  source = source.replace(gate, '  function installReaderPaging(content) {\n    const ownAction = action => action;');
}
const install = '  installReaderProgress();';
assert.equal(source.split(install).length, 2);
source = source.replace(install, `
  window.__reader = { position: scrollReaderToRatio, flush: flushReaderProgress,
    snapshot: () => ({ ratio: captureReaderRatio(), restorePending: readerState.restoreFrame !== null,
      restoreRatio: readerState.restoreRatio, progressPending: readerState.progressTimer !== null
        || readerState.progressFrame !== null || remoteProgressWrites.size > 0 || localProgressWriteIds.size > 0,
      settings: { ...readerState.settings }, current: isCurrentReaderSession(readerState.session),
      chapter: readerState.chapter?.index, chapterId: readerState.chapter?.id, bookId: readerState.book?.id,
      generation: readerState.book?.localGeneration, revision: readerState.book?.catalogRevision,
      progress: readerState.book?.progress }) };
${install}`);
const realm = 'server:22222222-2222-4222-8222-222222222222';
const book = { id: 'paging-fixture', title: 'Synthetic paging fixture', author: 'Synthetic', chapterCount: 3, sourceRealm: realm, catalogRevision: 'paging-revision', progress: { chapterIndex: 2, chapterId: 'chapter-2', catalogRevision: 'paging-revision', scrollRatio: .42 } };
const textFor = count => Array.from({ length: count }, (_, i) => `Paragraph ${String(i + 1).padStart(4, '0')}. A quiet road follows the valley and leads to the distant mountains. Reading layout fixture only.`).join('\n\n');
let chapters;
function setContent(content) { chapters = Array.from({ length: 3 }, (_, i) => ({ id: `chapter-${i + 1}`, bookId: book.id, index: i + 1, title: `第${i + 1}章 合成内容`, charCount: content.length, content })); }
setContent(textFor(1000));
const requests = [];
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://fixture');
  response.setHeader('Cache-Control', 'no-store');
  if (url.pathname.startsWith('/api/')) {
    const record = { path: url.pathname, method: request.method };
    if (request.method === 'POST') { const chunks = []; for await (const chunk of request) chunks.push(chunk); record.body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    requests.push(record);
    let payload;
    if (url.pathname === '/api/novels') payload = { books: [book], total: 1, sourceRealm: realm, facets: [] };
    else if (url.pathname.endsWith('/catalog')) payload = { book, chapters, total: 3, filteredTotal: 3, offset: 0, sourceRealm: realm };
    else if (url.pathname.includes('/chapters/')) { const index = Number(url.pathname.split('/').at(-1)) - 1; payload = { book, chapter: chapters[index], prev: chapters[index - 1] || null, next: chapters[index + 1] || null, sourceRealm: realm }; }
    else if (url.pathname.endsWith('/progress')) payload = { ok: true, sourceRealm: realm };
    else payload = { book, chapters: [], sourceRealm: realm };
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload)); return;
  }
  if (url.pathname === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body class="novel-library-view"><main class="app-shell"><header id="moduleChrome"></header><section id="contentPanel" class="content-panel" data-feed-view="true"><div class="section-head"><div><p id="viewKicker"></p><h2 id="viewTitle"></h2></div></div><div id="viewMeta"></div><div id="viewContent" class="content-list"></div></section></main><nav class="bottom-nav"></nav><script type="module">
      import { createAndroidModule } from '/modules/novels/android-module.js';
      const els = Object.fromEntries(['viewKicker','viewTitle','viewMeta','viewContent'].map(id => [id, document.getElementById(id)]));
      let generation = 0, controller, sourceUrl = location.origin;
      const module = createAndroidModule({ host: { els, getActiveUrl: () => sourceUrl,
        navigation: { showView, goBack: () => showView('novels'), hasBackStack: () => true },
        ui: { setActiveBottom() {}, setStatus() {}, renderCurrentView() {}, renderCurrentViewPreservingScroll() {}, scrollToTop: () => scrollTo(0,0), refreshChrome() {} } } });
      window.__fixture = { showView, invalidate: () => controller?.abort(), source: value => { sourceUrl = value; } };
      async function showView(view, params = {}) {
        const owner = ++generation; controller?.abort(); controller = new AbortController();
        const signal = controller.signal, guard = () => owner === generation && !signal.aborted; guard.signal = signal;
        window.dispatchEvent(new CustomEvent('fanhaoViewWillRender', { detail: { view, params } }));
        window.dispatchEvent(new CustomEvent('fanhaoViewChanged', { detail: { view, params } }));
        document.getElementById('contentPanel').dataset.view = view;
        document.body.classList.toggle('novel-reader-view', view === 'novelReader'); scrollTo(0,0);
        await module.routes.find(route => route.view === view).render(params, guard);
      }
      await showView('novels');
    </script></body></html>`); return;
  }
  const target = path.resolve(assets, `.${decodeURIComponent(url.pathname)}`);
  if (!target.startsWith(assets + path.sep) || !fs.statSync(target, { throwIfNoEntry: false })?.isFile()) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Type': target.endsWith('.css') ? 'text/css' : target.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
  if (target === path.join(assets, 'modules/novels/novel-views.js')) response.end(source); else fs.createReadStream(target).pipe(response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const executablePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(value => value && fs.existsSync(value));
const browser = await chromium.launch({ executablePath, headless: true });
const artifactDir = process.env.FANHAO_NOVEL_PAGING_ARTIFACTS;
if (artifactDir) fs.mkdirSync(artifactDir, { recursive: true });
let checks = 0;
const pass = name => { checks++; console.log(`PASS ${name}`); };
try {
  for (const width of shortOnly ? [] : selectedWidth ? [selectedWidth] : ownershipOnly ? [400] : [320, 400, 768]) for (const local of [false, true]) {
    const page = await newReader({ width, local });
    try {
      for (const requested of ownershipOnly ? [] : [0, .001, .42, .99, 1]) {
        const before = await geometry(page);
        await page.evaluate(ratio => __reader.position(ratio), requested);
        const actual = await geometry(page);
        expectContaining(actual, requested);
        await settled(page); await expectSaved(page, local, actual.ratio);
        if (requested === 0) assert(actual.visible.some(p => p.i === 0), 'chapter opening remains visible');
        if (requested === 1) assert(actual.visible.some(p => p.i === 999), 'chapter ending remains visible');
        pass(`${width}px ${local ? 'local' : 'remote'} ${requested * 100}% restores whole containing column, actual progress and identities`);
        if (artifactDir && requested === .42 && width === 400 && !local) await page.screenshot({ path: path.join(artifactDir, legacy ? 'paging-before.png' : 'paging-aligned.png') });
        assert.equal(before.pitch, actual.pitch);
      }
      if (!ownershipOnly && !alignmentOnly) { await verifyControls(page, local); await verifyReflow(page, local); }
      if (!alignmentOnly) await verifyOwnership(page, local);
    } finally { await page.close(); }
  }
  if (!ownershipOnly && !alignmentOnly) { await verifyShortChapters(); await verifyScrollMode(); }
  console.log(`PASS ${checks} real Chromium paging alignment checks`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }

async function newReader({ width = 400, local = false, text = textFor(1000), mode = 'page' } = {}) {
  setContent(text);
  const page = await browser.newPage({ viewport: { width, height: 820 }, isMobile: true, hasTouch: true });
  page.errors = []; page.on('pageerror', error => page.errors.push(error.message));
  await page.addInitScript(mode => {
    localStorage.setItem('fanhao.android.novel.settings', JSON.stringify({ readingMode: mode, fontSize: 24, lineHeight: 1.96, theme: 'green' }));
    window.__dom = { created: 0, paragraphs: 0 };
    const create = document.createElement.bind(document);
    document.createElement = (...args) => { __dom.created++; if (String(args[0]).toLowerCase() === 'p') __dom.paragraphs++; return create(...args); };
    const raf = requestAnimationFrame.bind(window), cancel = cancelAnimationFrame.bind(window), held = new Map(); let hold = false, next = -1;
    window.requestAnimationFrame = callback => { if (!hold) return raf(callback); const id = next--; held.set(id, callback); return id; };
    window.cancelAnimationFrame = id => { if (id < 0) held.delete(id); else cancel(id); };
    window.__hold = () => { hold = true; };
    window.__release = () => { hold = false; for (const [id, callback] of held) raf(time => { if (held.delete(id)) callback(time); }); };
    window.__resizeCallbacks = [];
    const Observer = window.ResizeObserver;
    window.ResizeObserver = class extends Observer { constructor(callback) { super(callback); __resizeCallbacks.push(callback); } };
  }, mode);
  await page.goto(url); await page.locator('.novel-mobile-book-detail').first().waitFor();
  if (local) await page.evaluate(async ({ book, chapters }) => {
    const { saveLocalNovelEntry, saveLocalNovelProgress, readLocalNovelCatalog } = await import('/js/local-novels.js');
    const entry = await saveLocalNovelEntry({ book, chapters });
    const catalog = await readLocalNovelCatalog(book.id);
    await saveLocalNovelProgress(book.id, { chapterIndex: 2, chapterId: catalog.chapters[1].id,
      catalogRevision: entry.book.catalogRevision, scrollRatio: .42 }, { expectedGeneration: entry.book.localGeneration });
  }, { book: { ...book, id: 'local:paging-fixture', local: true }, chapters: chapters.map(chapter => ({ ...chapter, bookId: 'local:paging-fixture' })) });
  await page.evaluate(id => __fixture.showView('novelReader', { id, chapterIndex: '2' }), local ? 'local:paging-fixture' : book.id);
  await page.locator('.novel-reader-content p').first().waitFor({ state: 'attached' });
  // Check the first completed restore before any delayed gesture alignment.
  await frames(page);
  if (artifactDir && legacy) await page.screenshot({ path: path.join(artifactDir, 'paging-before.png') });
  if (mode === 'page') expectContaining(await geometry(page), .42);
  await settled(page); assert.deepEqual(page.errors, []);
  return page;
}
async function frames(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function settled(page) {
  await frames(page);
  await page.waitForFunction(() => !__reader.snapshot().restorePending && !__reader.snapshot().progressPending);
}
async function geometry(page) {
  return page.evaluate(() => {
    const content = document.querySelector('.novel-reader-content'), style = getComputedStyle(content), rect = content.getBoundingClientRect();
    const paragraphs = [...content.querySelectorAll('p')].flatMap((p, i) => [...p.getClientRects()].map(r => ({ i, left: r.left - rect.left + content.scrollLeft, width: r.width, x: r.x, right: r.right, y: r.y, bottom: r.bottom })));
    const columns = [...new Set(paragraphs.map(p => Math.round(p.left * 100) / 100))];
    const visible = paragraphs.filter(p => p.right > rect.left && p.x < rect.right);
    return { ...__reader.snapshot(), left: content.scrollLeft, width: content.clientWidth, scrollWidth: content.scrollWidth,
      gap: style.columnGap, columnWidth: style.columnWidth, snap: style.scrollSnapType, pitch: columns.length > 1 ? columns[1] - columns[0] : rect.width + (Number.parseFloat(style.columnGap) || 0),
      columns: columns.length, count: content.querySelectorAll('p').length,
      height: content.clientHeight, created: __dom.created, paragraphsCreated: __dom.paragraphs,
      slider: document.querySelector('[data-novel-chapter-slider]')?.value,
      visible: visible.map(p => ({ i: p.i, x: p.x, width: p.width, clipped: p.x < rect.left - .5 || p.right > rect.right + .5 })),
      lines: [...content.querySelectorAll('p')].flatMap((p, i) => { const range = document.createRange(); range.selectNodeContents(p); return [...range.getClientRects()].map(r => ({ i, x: r.x - rect.x + content.scrollLeft, y: r.y - rect.y, width: r.width, height: r.height })); }) };
  });
}
function expectAligned(actual) {
  assert(actual.visible.length > 0, 'at least one real paragraph fragment remains readable');
  assert(actual.visible.every(p => !p.clipped), `whole columns must be readable: ${JSON.stringify(actual.visible)}`);
  if (actual.scrollWidth > actual.width) assert(Math.abs(actual.left / actual.pitch - Math.round(actual.left / actual.pitch)) < .003, 'offset aligns to actual column pitch');
}
function expectContaining(actual, requested) {
  expectAligned(actual);
  const max = actual.scrollWidth - actual.width;
  const expected = requested >= 1 ? max : Math.floor((max * requested + .5) / actual.pitch) * actual.pitch;
  assert(Math.abs(actual.left - expected) <= .5, `position ${actual.left} must include requested location ${requested} at ${expected}`);
  assert(Math.abs(actual.ratio - (max ? actual.left / max : 0)) < 1e-9);
  assert.equal(Number(actual.slider), Math.round(actual.ratio * 100), 'toolbar shows actual aligned progress');
}
async function expectSaved(page, local, ratio) {
  const state = await page.evaluate(() => __reader.snapshot());
  const progress = local ? await page.evaluate(async () => (await (await import('/js/local-novels.js')).readLocalNovelSummary('local:paging-fixture')).book.progress)
    : requests.findLast(request => request.path === `/api/novels/${book.id}/progress`)?.body;
  assert(progress, 'aligned position is persisted through actual progress boundary');
  assert(Math.abs(progress.scrollRatio - ratio) < 1e-9);
  assert.equal(progress.chapterIndex, 2); assert.equal(progress.chapterId, state.chapterId);
  assert.equal(progress.catalogRevision, state.revision);
  if (local) assert.equal(typeof state.generation, 'string', 'local opened generation remains owned');
}
async function menu(page, settings = false) {
  await page.locator('.novel-reader-screen').evaluate(screen => { if (!screen.classList.contains('menu-open')) screen.querySelector('.novel-reader-content').click(); });
  if (settings && !await page.locator('.novel-reader-settings-panel').count()) await page.getByRole('button', { name: '设置', exact: true }).click();
  await frames(page);
}
function setting(page, label, name) { return page.locator('.novel-reader-setting-row').filter({ has: page.locator('span', { hasText: new RegExp(`^${label}$`) }) }).getByRole('button', { name, exact: true }); }
async function verifyControls(page, local) {
  await menu(page);
  const slider = page.getByRole('slider', { name: '阅读进度', exact: true });
  await slider.evaluate(input => { input.value = '42'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
  expectContaining(await geometry(page), .42); await settled(page);
  await expectSaved(page, local, (await geometry(page)).ratio);
  pass(`${local ? 'local' : 'remote'} actual progress slider uses containing page and persists actual ratio`);
  const content = page.locator('.novel-reader-content');
  await content.focus();
  for (const [key, direction] of [['ArrowRight', 1], ['PageDown', 1], [' ', 1], ['ArrowLeft', -1], ['PageUp', -1]]) {
    const before = await geometry(page); await page.keyboard.press(key === ' ' ? 'Space' : key); await settled(page);
    const after = await geometry(page); expectAligned(after); assert.equal(after.left, before.left + before.pitch * direction);
    await expectSaved(page, local, after.ratio); pass(`actual ${key.trim() || 'Space'} advances exactly one readable column`);
  }
  for (const [key, ratio] of [['End', 1], ['Home', 0]]) { await page.keyboard.press(key); await settled(page); expectContaining(await geometry(page), ratio); pass(`actual ${key} keeps chapter ${ratio ? 'ending' : 'opening'} fully readable`); }
  await page.evaluate(() => __reader.position(.42)); await settled(page);
  await content.hover(); const beforeWheel = await geometry(page);
  await page.mouse.wheel(beforeWheel.pitch * .7, 0); await page.waitForTimeout(300); await settled(page);
  const afterWheel = await geometry(page); expectAligned(afterWheel); assert(afterWheel.left > beforeWheel.left, 'actual Chromium wheel changes the visible page');
  pass('actual Chromium horizontal wheel settles to a complete column');
  const beforeTouch = await geometry(page), cdp = await page.context().newCDPSession(page), rect = await content.boundingBox();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: rect.x + rect.width * .8, y: rect.y + 90 }] });
  for (const fraction of [.6, .4, .2]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: rect.x + rect.width * fraction, y: rect.y + 90 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(1000); await settled(page); const afterTouch = await geometry(page); expectAligned(afterTouch);
  assert(afterTouch.left > beforeTouch.left, 'actual Chromium touch movement changes the visible page');
  pass('actual Chromium touch gesture settles to a complete column'); await cdp.detach();
}
async function verifyReflow(page, local) {
  await menu(page, true); await page.evaluate(() => __reader.position(.42)); await settled(page);
  for (const [label, name] of [['字号', 'A+'], ['行距', '松'], ['阅读方式', '滚动'], ['阅读方式', '翻页']]) {
    const before = await geometry(page); await page.evaluate(() => { __dom.created = __dom.paragraphs = 0; });
    await setting(page, label, name).evaluate(button => button.click()); await settled(page);
    const after = await geometry(page);
    if (after.settings.readingMode === 'page') expectContaining(after, before.ratio);
    else assert(Math.abs(after.ratio - before.ratio) < .001);
    assert.equal(after.created, 0); assert.equal(after.paragraphsCreated, 0); assert.equal(after.count, 1000);
    await expectSaved(page, local, after.ratio); pass(`${label}:${name} preserves position, actual progress and r12 zero-DOM settings reuse`);
  }
  const before = await geometry(page);
  await page.setViewportSize({ width: 480, height: 740 }); await settled(page);
  const after = await geometry(page); expectContaining(after, before.ratio); await expectSaved(page, local, after.ratio);
  pass('actual viewport width/height reflow realigns the preserved position');
  await page.evaluate(() => { __hold(); __reader.position(.42); });
  await setting(page, '字号', 'A+').evaluate(button => button.click());
  const pending = await page.evaluate(() => __reader.snapshot()); assert.equal(pending.restorePending, true);
  const pendingGeometry = await geometry(page);
  await page.locator('.novel-reader-content').focus(); await page.keyboard.press('ArrowRight');
  await page.evaluate(() => __release()); await settled(page);
  const afterKey = await geometry(page); expectAligned(afterKey);
  const expected = (Math.floor((pendingGeometry.scrollWidth - pendingGeometry.width) * pending.restoreRatio / pendingGeometry.pitch + .5 / pendingGeometry.pitch) + 1) * pendingGeometry.pitch;
  assert.equal(afterKey.left, expected); await expectSaved(page, local, afterKey.ratio);
  pass('actual page key during deferred font restore advances from pending target');
  await page.evaluate(() => { __hold(); }); await setting(page, '字号', 'A-').evaluate(button => button.click());
  await sliderInput(page, 73); await page.evaluate(() => __release()); await settled(page);
  expectContaining(await geometry(page), .73); pass('slider supersedes deferred font restore without old-target overwrite');
  const beforeReflow = await geometry(page);
  await page.evaluate(() => __hold()); await setting(page, '字号', 'A+').evaluate(button => button.click());
  const pendingReflow = await page.evaluate(() => __reader.snapshot());
  await page.setViewportSize({ width: 393, height: 780 });
  await setting(page, '行距', '松').evaluate(button => button.click());
  assert.equal(await page.evaluate(() => __reader.snapshot().restoreRatio), pendingReflow.restoreRatio);
  await page.evaluate(() => __release()); await settled(page);
  const afterReflow = await geometry(page); expectContaining(afterReflow, beforeReflow.ratio);
  await expectSaved(page, local, afterReflow.ratio); pass('rapid font, viewport and line reflow preserve pending target without observer feedback');
}
async function sliderInput(page, value) {
  await page.getByRole('slider', { name: '阅读进度', exact: true }).evaluate((input, value) => { input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }, value);
}
async function verifyOwnership(page, local) {
  for (const boundary of ['rerender', 'chapter', 'source', 'abort', 'leave']) {
    await page.evaluate(id => __fixture.showView('novelReader', { id, chapterIndex: '2' }), local ? 'local:paging-fixture' : book.id); await settled(page);
    await page.evaluate(() => {
      window.__oldContent = document.querySelector('.novel-reader-content');
      window.__oldResize = __resizeCallbacks.at(-1);
      __oldContent.scrollLeft += 133; __oldContent.dispatchEvent(new Event('scroll'));
    });
    if (boundary === 'rerender' || boundary === 'chapter') await page.evaluate(({ id, chapter }) => __fixture.showView('novelReader', { id, chapterIndex: String(chapter) }), { id: local ? 'local:paging-fixture' : book.id, chapter: boundary === 'chapter' ? 3 : 2 });
    else await page.evaluate(boundary => { if (boundary === 'source') __fixture.source(location.origin + '/new-source'); else if (boundary === 'abort') __fixture.invalidate(); else __fixture.showView('novels'); }, boundary);
    await frames(page); const before = await page.evaluate(() => ({ state: __reader.snapshot(), left: document.querySelector('.novel-reader-content')?.scrollLeft }));
    const writes = requests.filter(request => request.method === 'POST' && request.path.endsWith('/progress')).length;
    await page.evaluate(() => { __oldContent.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); __oldContent.dispatchEvent(new Event('scroll')); __oldResize([]); });
    await page.waitForTimeout(220); await frames(page);
    const after = await page.evaluate(() => ({ state: __reader.snapshot(), left: document.querySelector('.novel-reader-content')?.scrollLeft }));
    assert.equal(after.left, before.left); assert.equal(after.state.chapter, before.state.chapter);
    if (boundary === 'source' || boundary === 'abort' || boundary === 'leave') assert.equal(requests.filter(request => request.method === 'POST' && request.path.endsWith('/progress')).length, writes);
    pass(`${local ? 'local' : 'remote'} ${boundary} fences detached keyboard, queued scroll alignment and resize owner`);
    if (boundary === 'source') await page.evaluate(() => __fixture.source(location.origin));
  }
  assert.deepEqual(page.errors, []);
}
async function verifyShortChapters() {
  for (const [name, text, expected] of [['one page', textFor(1), 1], ['two pages', textFor(4), 2], ['long paragraph', 'Opening. ' + 'A quiet road leads to the distant mountains. '.repeat(60) + ' Ending.', null]]) {
    const page = await newReader({ text });
    try {
      const initial = await geometry(page); if (expected) assert.equal(initial.columns, expected);
      for (const requested of [0, .42, 1]) { await page.evaluate(ratio => __reader.position(ratio), requested); const actual = await geometry(page); expectContaining(actual, requested); await settled(page); }
      await menu(page); await page.getByRole('slider', { name: '阅读进度', exact: true }).focus();
      await sliderInput(page, 42); expectContaining(await geometry(page), .42); await settled(page);
      const all = await geometry(page);
      for (const line of all.lines) { assert(line.width <= all.width + 1); assert(line.y >= -.5); assert(line.y + line.height <= all.height + .5, `${name}: every real text line fits its column vertically`); }
      if (name === 'long paragraph') assert(all.columns > 2, 'paragraph actually fragments across columns');
      const max = all.scrollWidth - all.width;
      for (let left = 0; left <= max; left += all.pitch) { await page.evaluate(ratio => __reader.position(ratio), max ? left / max : 0); expectAligned(await geometry(page)); }
      pass(`${name} has complete opening/ending and all actual text lines fit readable columns`);
    } finally { await page.close(); }
  }
}
async function verifyScrollMode() {
  const page = await newReader({ mode: 'scroll' });
  try {
    await page.evaluate(() => __reader.position(.42)); await settled(page);
    const before = await geometry(page); assert(Math.abs(before.ratio - .42) < .00001);
    await menu(page, true); await setting(page, '字号', 'A+').evaluate(button => button.click()); await settled(page);
    const after = await geometry(page); assert(Math.abs(after.ratio - before.ratio) < .00001);
    await page.evaluate(() => __hold()); await setting(page, '字号', 'A-').evaluate(button => button.click());
    await page.evaluate(() => window.dispatchEvent(new WheelEvent('wheel', { deltaY: 80 }))); assert.equal(await page.evaluate(() => __reader.snapshot().restorePending), false);
    await page.evaluate(() => __release()); await settled(page); pass('scroll mode retains continuous ratio and manual reader input cancels deferred restore');
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
}
