import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

// Real layout and controls on an isolated synthetic reader; no user service or media.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'android-client/www');
const baseline = process.argv.includes('--baseline');
const legacy = process.argv.includes('--legacy-settings') || baseline;
const unguarded = process.argv.includes('--unguarded-settings');
const unboundControls = process.argv.includes('--unguarded-control-owner');
const ownerOnly = process.argv.includes('--ownership-only') || unguarded || unboundControls;
const keyboardOnly = process.argv.includes('--keyboard-only');
const legacyPagingRatio = process.argv.includes('--legacy-paging-ratio-tracking');
const boundariesOnly = process.argv.includes('--boundaries-only') || ownerOnly || keyboardOnly;
let source = fs.readFileSync(path.join(assets, 'modules/novels/novel-views.js'), 'utf8').replace(/\r\n/g, '\n');
if (legacyPagingRatio) {
  const hook = '    readerState.pagingRatioChanged?.(ratio);\n';
  assert.equal(source.split(hook).length, 3, 'negative removes only programmatic paging-target notifications');
  source = source.replaceAll(hook, '');
}
if (legacy) {
  const start = '    if (applyReaderStyleSettings(readerState.settings)) {';
  const end = '\n    renderNovelReaderData(currentReaderData(), null, { restoreRatio: ratio, restore: !options.live });';
  assert.equal(source.split(start).length, 2, 'negative locates the actual settings reuse block');
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert(to > from, 'negative restores the actual previous complete renderer');
  source = source.slice(0, from) + source.slice(to);
}
if (unguarded) {
  const guard = '    if (!isCurrentReaderSession(readerState.session) || !isReaderScreenMounted()) return;\n    const previous = readerState.settings;';
  assert.equal(source.split(guard).length, 2, 'negative removes only the settings ownership gate');
  source = source.replace(guard, '    const previous = readerState.settings;');
  const ownerGate = '      if (!isCurrentReaderSession(session) || readerState.screen !== screen || !isReaderScreenMounted()) return;';
  assert.equal(source.split(ownerGate).length, 2, 'negative removes current-route/source checks at both settings ownership layers');
  source = source.replace(ownerGate, '      if (readerState.session !== session || readerState.screen !== screen || !isReaderScreenMounted()) return;');
}
if (unboundControls) {
  const ownerGate = '      if (!isCurrentReaderSession(session) || readerState.screen !== screen || !isReaderScreenMounted()) return;';
  assert.equal(source.split(ownerGate).length, 2, 'negative removes exactly the common control creation-owner gate');
  source = source.replace(ownerGate, '');
}
const update = '  function updateSettings(patch = {}, options = {}) {';
assert.equal(source.split(update).length, 2);
source = source.replace(update, `${update}
    const probe = window.__styleProbe, started = performance.now();
    try { return updateSettingsMeasured(patch, options); }
    finally {
      const screen = document.querySelector('.novel-reader-screen'), content = screen?.querySelector('.novel-reader-content');
      const height = screen?.scrollHeight, width = content?.scrollWidth;
      probe.actions.push({ ms: performance.now() - started, height, width, patch });
    }
  }
  function updateSettingsMeasured(patch = {}, options = {}) {`);
const render = '  function renderNovelReaderData(data = {}, cacheEntry = null, options = {}) {';
assert.equal(source.split(render).length, 2);
source = source.replace(render, `${render}\n    window.__styleProbe.renders++;`);
const install = '  installReaderProgress();';
assert.equal(source.split(install).length, 2);
source = source.replace(install, `
  window.__styleReader = {
    position: scrollReaderToRatio,
    rerender: () => renderNovelReaderData(currentReaderData(), null, { restoreRatio: captureReaderPositionRatio() }),
    snapshot: () => ({ settings: { ...readerState.settings }, ratio: captureReaderRatio(),
      restoreRatio: readerState.restoreRatio, restorePending: readerState.restoreFrame !== null,
      pending: readerState.progressTimer !== null || readerState.progressFrame !== null
        || remoteProgressWrites.size > 0 || localProgressWriteIds.size > 0,
      current: isCurrentReaderSession(readerState.session), menu: readerState.menuOpen,
      settingsOpen: readerState.settingsOpen, catalogOpen: readerState.catalogOpen,
      bookId: readerState.book?.id, sourceUrl: readerState.session?.sourceUrl,
      progress: readerState.book?.progress ? { ...readerState.book.progress } : null,
      chapter: readerState.chapter?.index, immersive: document.body.classList.contains('novel-reader-immersive') })
  };
${install}`);
const realm = 'server:22222222-2222-4222-8222-222222222222';
const book = { id: 'style-fixture', title: 'Private style fixture', author: 'Synthetic', chapterCount: 3, sourceRealm: realm };
const otherBook = { ...book, id: 'replacement-fixture', title: 'Private replacement fixture' };
const text = Array.from({ length: 1000 }, (_, i) => `Synthetic paragraph ${i + 1}. A quiet road follows the valley and leads to the distant mountains. Reading layout fixture only.`).join('\n\n');
const chapters = Array.from({ length: 3 }, (_, i) => ({ id: `chapter-${i + 1}`, bookId: book.id, index: i + 1, title: `第${i + 1}章 合成内容`, charCount: text.length, content: text }));
const requests = [];
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://fixture');
  response.setHeader('Cache-Control', 'no-store');
  if (url.pathname.startsWith('/api/')) {
    const item = { path: url.pathname, method: request.method };
    if (request.method === 'POST') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      item.body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    }
    requests.push(item);
    const apiBook = url.pathname.includes(`/${otherBook.id}/`) ? otherBook : book;
    const apiChapters = apiBook === book ? chapters : chapters.map(chapter => ({ ...chapter, bookId: otherBook.id }));
    let payload;
    if (url.pathname === '/api/novels') payload = { books: [book], total: 1, sourceRealm: realm, facets: [] };
    else if (url.pathname.endsWith('/catalog')) payload = { book: apiBook, chapters: apiChapters, total: 3, filteredTotal: 3, offset: 0, sourceRealm: realm };
    else if (url.pathname.includes('/chapters/')) {
      const index = Number(url.pathname.split('/').at(-1)) - 1;
      payload = { book: apiBook, chapter: apiChapters[index], prev: apiChapters[index - 1] || null, next: apiChapters[index + 1] || null, sourceRealm: realm };
    } else if (url.pathname.endsWith('/progress')) payload = { ok: true, sourceRealm: realm };
    else payload = { book, chapters: [], sourceRealm: realm };
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload)); return;
  }
  if (url.pathname === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html data-theme="light"><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><link rel="stylesheet" href="/styles.css"></head><body class="novel-library-view"><main class="app-shell"><header id="moduleChrome"></header><section id="contentPanel" class="content-panel" data-feed-view="true"><div class="section-head"><div><p id="viewKicker"></p><h2 id="viewTitle"></h2></div></div><div id="viewMeta"></div><div id="viewContent" class="content-list"></div></section></main><nav class="bottom-nav"></nav><script type="module">
      import { createAndroidModule } from '/modules/novels/android-module.js';
      const els = Object.fromEntries(['viewKicker','viewTitle','viewMeta','viewContent'].map(id => [id, document.getElementById(id)]));
      let generation = 0, controller, sourceUrl = location.origin, view = 'novels', params = {};
      const module = createAndroidModule({ host: { els, getActiveUrl: () => sourceUrl,
        navigation: { showView, goBack: () => showView('novels'), hasBackStack: () => true },
        ui: { setActiveBottom() {}, setStatus() {}, renderCurrentView: () => showView(view, params), renderCurrentViewPreservingScroll: () => showView(view, params), scrollToTop: () => scrollTo(0,0), refreshChrome() {} } } });
      window.__styleFixture = { showView, invalidate: () => controller?.abort(), source: value => { sourceUrl = value; } };
      async function showView(next, nextParams = {}) {
        view = next; params = nextParams; const owner = ++generation;
        controller?.abort(); controller = new AbortController();
        const signal = controller.signal, guard = () => owner === generation && !signal.aborted; guard.signal = signal;
        window.dispatchEvent(new CustomEvent('fanhaoViewWillRender', { detail: { view, params } }));
        window.dispatchEvent(new CustomEvent('fanhaoViewChanged', { detail: { view, params } }));
        document.getElementById('contentPanel').dataset.view = view;
        document.body.classList.toggle('novel-reader-view', view === 'novelReader');
        scrollTo(0,0); await module.routes.find(route => route.view === view).render(params, guard);
      }
      await showView('novels');
    </script></body></html>`); return;
  }
  const target = path.resolve(assets, `.${decodeURIComponent(url.pathname)}`);
  if (!target.startsWith(assets + path.sep) || !fs.statSync(target, { throwIfNoEntry: false })?.isFile()) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Type': target.endsWith('.css') ? 'text/css' : target.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
  if (target === path.join(assets, 'modules/novels/novel-views.js')) response.end(source);
  else fs.createReadStream(target).pipe(response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const executablePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(value => value && fs.existsSync(value));
const browser = await chromium.launch({ executablePath, headless: true });
const artifactDir = process.env.FANHAO_NOVEL_STYLE_ARTIFACTS;
if (artifactDir) fs.mkdirSync(artifactDir, { recursive: true });
let checks = 0;
const pass = name => { checks++; console.log(`PASS ${name}`); };
try {
  for (const mode of boundariesOnly ? [] : ['scroll', 'page']) for (const local of baseline ? [false] : [false, true]) {
    const page = await newReader(mode, local);
    try { await verifySettings(page, mode, local); } finally { await page.close(); }
  }
  if (!baseline) {
    if (!ownerOnly) await verifyKeyboard();
    if (!ownerOnly && !keyboardOnly) { await verifyBoundaries(); await verifyWidths(); }
    if (!keyboardOnly) await verifyOwnership();
  }
  console.log(`PASS ${checks} real Chromium reader style checks`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }

async function frames(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function settled(page) {
  await frames(page); await page.waitForFunction(() => !__styleReader.snapshot().pending && !__styleReader.snapshot().restorePending);
}
async function newReader(mode, local = false, width = 400) {
  const page = await browser.newPage({ viewport: { width, height: 820 }, isMobile: true, hasTouch: true });
  page.errors = []; page.on('pageerror', error => page.errors.push(error.message));
  await page.addInitScript(mode => {
    localStorage.setItem('fanhao.android.novel.settings', JSON.stringify({ readingMode: mode, fontSize: 24, lineHeight: 1.96, theme: 'green' }));
    window.__styleProbe = { created: 0, paragraphs: 0, renders: 0, actions: [] };
    const create = document.createElement.bind(document);
    document.createElement = (...args) => { __styleProbe.created++; if (String(args[0]).toLowerCase() === 'p') __styleProbe.paragraphs++; return create(...args); };
    window.__styleNative = [];
    // Deliver the real production restore on a later actual animation frame.
    const raf = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
    const held = new Map(); let hold = false, nextId = -1;
    window.requestAnimationFrame = callback => {
      if (!hold) return raf(callback);
      const id = nextId--; held.set(id, callback); return id;
    };
    window.cancelAnimationFrame = id => { if (id < 0) held.delete(id); else cancel(id); };
    window.__holdStyleFrames = () => { hold = true; };
    window.__releaseStyleFrames = () => {
      hold = false;
      for (const [id, callback] of held) raf(time => { if (held.delete(id)) callback(time); });
    };
    const record = type => async value => { __styleNative.push({ type, ...value }); };
    window.Capacitor = { Plugins: { FanHaoNovel: { setReaderImmersive: record('immersive'), setReaderBrightness: record('brightness'), clearReaderBrightness: record('clear-brightness') } } };
  }, mode);
  await page.goto(url); await page.locator('.novel-mobile-book-detail').first().waitFor();
  if (local) await page.evaluate(async ({ book, chapters }) => {
    const { saveLocalNovelEntry } = await import('/js/local-novels.js'); await saveLocalNovelEntry({ book, chapters });
  }, { book: { ...book, id: 'local:style-fixture', local: true }, chapters: chapters.map(item => ({ ...item, bookId: 'local:style-fixture' })) });
  await page.evaluate(id => __styleFixture.showView('novelReader', { id, chapterIndex: '2' }), local ? 'local:style-fixture' : book.id);
  await page.locator('.novel-reader-content p').nth(999).waitFor({ state: 'attached' });
  await settled(page);
  await page.evaluate(() => __styleReader.position(.42)); await settled(page);
  await page.locator('.novel-reader-content p').first().evaluate(p => p.click());
  await page.getByRole('button', { name: '设置', exact: true }).click(); await settled(page);
  assert.equal(await page.locator('.novel-reader-settings-panel').count(), 1);
  return page;
}
function row(page, label) { return page.locator('.novel-reader-setting-row').filter({ has: page.locator('span', { hasText: new RegExp(`^${label}$`) }) }); }
async function snapshot(page) {
  return page.evaluate(() => {
    const screen = document.querySelector('.novel-reader-screen'), content = screen?.querySelector('.novel-reader-content'), paragraph = content?.querySelector('p');
    const panel = screen?.querySelector('.novel-reader-settings-panel'), style = paragraph && getComputedStyle(paragraph), screenStyle = screen && getComputedStyle(screen);
    const rect = panel?.getBoundingClientRect();
    return { ...__styleReader.snapshot(), ...__styleProbe, actions: __styleProbe.actions.slice(),
      sameScreen: screen === __styleNodes?.screen, sameContent: content === __styleNodes?.content,
      sameParagraph: paragraph === __styleNodes?.paragraph, sameToolbar: screen?.querySelector('.novel-reader-toolbar') === __styleNodes?.toolbar,
      samePanel: panel === __styleNodes?.panel, sameFocus: document.activeElement === __styleNodes?.focus,
      count: content?.querySelectorAll('p').length, font: style?.fontSize, line: style?.lineHeight,
      background: screenStyle?.backgroundColor, color: screenStyle?.color, height: screen?.scrollHeight,
      contentHeight: content?.clientHeight, contentWidth: content?.clientWidth, width: content?.scrollWidth,
      paragraphHeight: paragraph?.getBoundingClientRect().height,
      viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
      scroll: scrollY, left: content?.scrollLeft, slider: screen?.querySelector('[data-novel-chapter-slider]')?.value,
      panelScroll: panel?.scrollTop, panelRect: rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      dim: screenStyle?.getPropertyValue('--novel-reader-dim'), stored: JSON.parse(localStorage.getItem('fanhao.android.novel.settings')),
      toolbarButtons: screen && [...screen.querySelectorAll('.novel-reader-toolbar button')].map(button => ({ text: button.textContent, disabled: button.disabled })),
      native: __styleNative.slice(), rows: panel && [...panel.querySelectorAll('.novel-reader-setting-row')].map(item => ({ label: item.querySelector('span')?.textContent,
        value: item.querySelector('strong')?.textContent, buttons: [...item.querySelectorAll('button')].map(button => ({ text: button.textContent, active: button.classList.contains('active') })), input: item.querySelector('input')?.value })) };
  });
}
async function begin(page, control) {
  if (control) await control.evaluate(element => element.focus());
  await page.evaluate(() => {
    const screen = document.querySelector('.novel-reader-screen');
    window.__styleNodes = { screen, content: screen?.querySelector('.novel-reader-content'), paragraph: screen?.querySelector('.novel-reader-content p'),
      toolbar: screen?.querySelector('.novel-reader-toolbar'), panel: screen?.querySelector('.novel-reader-settings-panel'), focus: document.activeElement };
    __styleProbe.created = 0; __styleProbe.paragraphs = 0; __styleProbe.renders = 0; __styleProbe.actions.length = 0;
  });
  return snapshot(page);
}
function expectRatio(before, after) { assert(Math.abs(after.ratio - before.ratio) < .005, `actual ratio ${before.ratio} -> ${after.ratio}`); }
function expectReused(after) {
  assert.equal(after.paragraphs, 0, 'setting change reuses all 1000 actual paragraphs');
  assert.equal(after.created, 0); assert.equal(after.renders, 0);
  for (const key of ['sameScreen', 'sameContent', 'sameParagraph', 'sameToolbar', 'samePanel', 'sameFocus']) assert.equal(after[key], true, key);
  assert.equal(after.count, 1000);
}
async function savedProgress(page, local) {
  if (local) return page.evaluate(async () => (await (await import('/js/local-novels.js')).readLocalNovelSummary('local:style-fixture')).book.progress);
  return requests.findLast(item => item.path === `/api/novels/${book.id}/progress`)?.body;
}
async function verifySettings(page, mode, local) {
  const actions = [
    ['背景', '白底', { theme: 'white', night: false }], ['背景', '暖粉', { theme: 'rose' }],
    ['字号', 'A+', { fontSize: 25 }], ['字号', 'A+', { fontSize: 26 }], ['字号', 'A-', { fontSize: 25 }],
    ['行距', '松', { lineHeight: 2.04 }], ['行距', '松', { lineHeight: 2.12 }], ['行距', '紧', { lineHeight: 2.04 }],
    ['阅读方式', mode === 'scroll' ? '翻页' : '滚动', { readingMode: mode === 'scroll' ? 'page' : 'scroll' }],
    ['阅读方式', mode === 'scroll' ? '滚动' : '翻页', { readingMode: mode }],
    ['护眼模式', '关闭', { eyeCare: true, night: false }], ['护眼模式', '开启', { eyeCare: false }],
    ['夜间模式', '关闭', { night: true, eyeCare: false }], ['夜间模式', '开启', { night: false }],
    ['跟随系统', '开启', { brightnessMode: 'custom' }], ['跟随系统', '关闭', { brightnessMode: 'system' }]
  ];
  for (const [label, name, expected] of actions) {
    const control = row(page, label).getByRole('button', { name, exact: true });
    const before = await begin(page, control), saved = await savedProgress(page, local), requestCount = requests.length;
    await control.click(); await settled(page); const after = await snapshot(page);
    console.log(JSON.stringify({ mode, local, action: `${label}:${name}`, paragraphs: after.paragraphs, created: after.created, renders: after.renders,
      ms: after.actions.map(item => +item.ms.toFixed(3)), ratio: after.ratio, height: after.height, width: after.width }));
    for (const [key, value] of Object.entries(expected)) {
      if (typeof value === 'number') assert(Math.abs(after.settings[key] - value) < .0001, `${key} latest value`);
      else assert.equal(after.settings[key], value);
    }
    expectRatio(before, after); assert.deepEqual(after.stored, after.settings);
    assert.equal(after.font, `${after.settings.fontSize}px`); assert(Math.abs(parseFloat(after.line) - after.settings.fontSize * after.settings.lineHeight) < .02);
    const backgrounds = { paper: 'rgb(241, 230, 210)', white: 'rgb(251, 251, 251)', green: 'rgb(233, 242, 227)', rose: 'rgb(242, 226, 220)' };
    assert.equal(after.background, after.settings.night ? 'rgb(29, 34, 43)' : after.settings.eyeCare ? 'rgb(223, 236, 216)' : backgrounds[after.settings.theme]);
    assert.equal(after.color, after.settings.night ? 'rgb(203, 210, 220)' : 'rgb(47, 42, 36)');
    assert.equal(after.immersive, false); assert.equal(after.menu, true); assert.equal(after.settingsOpen, true); assert.equal(after.slider, '42');
    if (artifactDir && !local && label === '夜间模式' && expected.night) await page.screenshot({ path: path.join(artifactDir, `settings-${mode}-night.png`) });
    assert(after.panelRect.width <= 400 && after.panelRect.height <= 430 && after.panelRect.y >= 0, 'settings remain within the real mobile viewport');
    if (!baseline) {
      expectReused(after);
      assert.equal(after.panelScroll, before.panelScroll, 'setting reuse preserves the actual panel scroll position');
      const layout = label === '字号' || label === '行距' || label === '阅读方式';
      if (!layout) { assert.equal(after.height, before.height); assert.equal(after.width, before.width); assert.deepEqual(await savedProgress(page, local), saved); assert.equal(requests.length, requestCount); }
      else {
        assert(after.height !== before.height || after.width !== before.width || after.contentHeight !== before.contentHeight || after.paragraphHeight !== before.paragraphHeight, 'layout setting performs real geometry work');
        assert(Math.abs((await savedProgress(page, local)).scrollRatio - .42) < .005);
      }
      const valueRow = after.rows.find(item => item.label === label);
      if (label === '字号') assert.equal(valueRow.value, `${expected.fontSize}px`);
      if (label === '行距') assert.equal(valueRow.value, expected.lineHeight.toFixed(2));
      if (label === '背景' || label === '阅读方式') assert.deepEqual(valueRow.buttons.filter(item => item.active).map(item => item.text), [name]);
      if (['护眼模式', '夜间模式', '跟随系统'].includes(label)) assert.equal(valueRow.buttons[0].text, name === '开启' ? '关闭' : '开启');
      pass(`${mode} ${local ? 'local' : 'remote'} ${label}:${name} live layout, controls, focus and stored ratio`);
    }
  }
  assert.deepEqual(page.errors, []);
  if (artifactDir) await page.screenshot({ path: path.join(artifactDir, `settings-${mode}-${local ? 'local' : 'remote'}.png`) });
}
async function verifyBoundaries() {
  for (const mode of ['scroll', 'page']) for (const local of [false, true]) {
    const page = await newReader(mode, local);
    try {
      const control = row(page, '字号').getByRole('button', { name: 'A+', exact: true });
      const before = await begin(page, control);
      const pending = await page.evaluate(mode => {
        __holdStyleFrames();
        const button = (label, text) => [...document.querySelectorAll('.novel-reader-setting-row')].find(row => row.querySelector('span').textContent === label)
          && [...[...document.querySelectorAll('.novel-reader-setting-row')].find(row => row.querySelector('span').textContent === label).querySelectorAll('button')].find(button => button.textContent === text);
        const click = (label, text) => {
          const element = button(label, text); element.focus();
          element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' })); element.click();
        };
        click('字号', 'A+'); assertPending(); click('字号', 'A+'); click('行距', '松');
        click('阅读方式', mode === 'scroll' ? '翻页' : '滚动'); click('阅读方式', mode === 'scroll' ? '滚动' : '翻页');
        function assertPending() { if (!__styleReader.snapshot().restorePending) throw new Error('actual production restore must still be deferred'); }
        return __styleReader.snapshot();
      }, mode);
      assert.equal(pending.settings.fontSize, 26); assert(Math.abs(pending.settings.lineHeight - 2.04) < .0001);
      assert.equal(pending.restorePending, true); assert.equal(pending.settings.readingMode, mode);
      await page.evaluate(() => __releaseStyleFrames()); await settled(page);
      const after = await snapshot(page); expectRatio(before, after);
      assert.equal(after.paragraphs, 0); assert.equal(after.created, 0); assert.equal(after.renders, 0);
      assert.equal(after.sameScreen, true); assert.equal(after.samePanel, true);
      assert(Math.abs((await savedProgress(page, local)).scrollRatio - .42) < .005);
      pass(`${mode} ${local ? 'local' : 'remote'} repeated touch clicks and both mode changes before restore frame`);
      await verifyBrightness(page, mode, local);
      await verifyLimits(page, mode, local);
      await verifyOverlayAndChapter(page, mode, local);
      assert.deepEqual(page.errors, []);
    } finally { await page.close(); }
  }
}

async function clickBatch(page, actions) {
  return page.evaluate(actions => {
    for (const [label, text, count = 1] of actions) {
      const row = [...document.querySelectorAll('.novel-reader-setting-row')].find(row => row.querySelector('span').textContent === label);
      const button = [...row.querySelectorAll('button')].find(button => button.textContent === text);
      for (let i = 0; i < count; i++) {
        button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' })); button.click();
      }
    }
    return __styleReader.snapshot();
  }, actions);
}
async function verifyBrightness(page, mode, local) {
  const slider = row(page, '亮度').locator('input');
  const before = await begin(page, slider), saved = await savedProgress(page, local);
  for (const [value, dim] of [[60, '0.220'], [35, '0.358'], [100, '0.000']]) {
    await slider.evaluate((input, value) => { input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }, value);
    const after = await snapshot(page); expectReused(after); expectRatio(before, after);
    assert.equal(after.settings.brightness, value); assert.equal(after.settings.brightnessMode, 'custom'); assert.equal(after.dim, dim);
    assert.equal(after.rows.find(item => item.label === '亮度').value, `${value}%`);
    assert.equal(after.rows.find(item => item.label === '跟随系统').buttons[0].text, '关闭');
    assert.equal(after.native.at(-1).type, 'brightness'); assert.equal(after.native.at(-1).brightness, value / 100);
    assert.deepEqual(after.stored, after.settings); assert.deepEqual(await savedProgress(page, local), saved);
  }
  await row(page, '跟随系统').getByRole('button', { name: '关闭', exact: true }).click();
  let state = await snapshot(page); assert.equal(state.settings.brightnessMode, 'system'); assert.equal(state.dim, '0');
  assert.equal(state.rows.find(item => item.label === '亮度').value, '系统'); assert.equal(state.native.at(-1).type, 'clear-brightness');
  await row(page, '跟随系统').getByRole('button', { name: '开启', exact: true }).click();
  state = await snapshot(page); assert.equal(state.settings.brightnessMode, 'custom'); assert.equal(state.settings.brightness, 100);
  assert.equal(state.native.at(-1).type, 'brightness'); assert.equal(state.native.at(-1).brightness, 1);
  expectRatio(before, state); assert.equal(state.samePanel, true); assert.equal(state.paragraphs, 0);
  pass(`${mode} ${local ? 'local' : 'remote'} live brightness, min/max, system toggle after drag and native bridge`);
}
async function verifyLimits(page, mode, local) {
  for (const [label, text, expected] of [['字号', 'A+', 28], ['字号', 'A-', 16], ['行距', '松', 2.35], ['行距', '紧', 1.55]]) {
    const control = row(page, label).getByRole('button', { name: text, exact: true });
    const before = await begin(page, control);
    await page.evaluate(() => __holdStyleFrames());
    await clickBatch(page, [[label, text, 24]]); await page.evaluate(() => __releaseStyleFrames()); await settled(page);
    const after = await snapshot(page); expectRatio(before, after); expectReused(after);
    const key = label === '字号' ? 'fontSize' : 'lineHeight'; assert.equal(after.settings[key], expected); assert.deepEqual(after.stored, after.settings);
    assert(Math.abs((await savedProgress(page, local)).scrollRatio - .42) < .005);
    const noopBefore = await begin(page, control), saved = await savedProgress(page, local), count = requests.length;
    await control.click(); await settled(page); const noop = await snapshot(page);
    expectReused(noop); expectRatio(noopBefore, noop); assert.equal(noop.height, noopBefore.height); assert.equal(noop.width, noopBefore.width);
    assert.equal(noop.settings[key], expected); assert.equal(requests.length, count); assert.deepEqual(await savedProgress(page, local), saved);
    pass(`${mode} ${local ? 'local' : 'remote'} ${label} ${expected} clamp and no-op with actual layout`);
  }
  // Reading movement after a completed restore must supersede its old target.
  await page.evaluate(() => __styleReader.position(.61)); await settled(page);
  const control = row(page, '字号').getByRole('button', { name: 'A+', exact: true }), before = await begin(page, control);
  await control.click(); await settled(page); const after = await snapshot(page); expectRatio(before, after);
  assert(Math.abs(after.ratio - .61) < .005); assert.equal(after.slider, '61');
  pass(`${mode} ${local ? 'local' : 'remote'} new actual reading progress replaces the completed restore target`);
}
async function verifyOverlayAndChapter(page, mode, local) {
  let before = await snapshot(page);
  await page.evaluate(() => __holdStyleFrames());
  await clickBatch(page, [['字号', 'A+']]);
  await page.getByRole('button', { name: '完成', exact: true }).evaluate(button => button.click());
  await page.evaluate(() => __releaseStyleFrames()); await settled(page);
  let after = await snapshot(page); expectRatio(before, after); assert.equal(after.settingsOpen, false); assert.equal(after.immersive, true);
  pass(`${mode} ${local ? 'local' : 'remote'} close settings before layout restore keeps target ratio`);
  await page.getByRole('button', { name: '目录', exact: true }).click();
  await page.locator('.novel-reader-catalog-drawer .novel-mobile-chapter').first().waitFor(); await settled(page);
  const chapter = await page.locator('.novel-reader-catalog-drawer .novel-mobile-chapter').allTextContents();
  const control = page.locator('[data-novel-night-toggle]'); before = await begin(page, control); const count = requests.length;
  // The drawer covers the toolbar pointer area; its existing focused keyboard control remains reachable.
  await control.press('Enter'); await settled(page); after = await snapshot(page);
  expectRatio(before, after); assert.equal(after.sameScreen, true); assert.equal(after.paragraphs, 0); assert.equal(after.created, 0); assert.equal(after.catalogOpen, true);
  assert.equal(await page.locator('.novel-reader-catalog-drawer').evaluate(drawer => drawer.classList.contains('night')), true);
  assert.deepEqual(await page.locator('.novel-reader-catalog-drawer .novel-mobile-chapter').allTextContents(), chapter);
  assert.equal(requests.length, count); assert.equal(await control.textContent(), '日间');
  await control.press('Enter'); assert.equal(await control.textContent(), '夜间');
  await page.locator('.novel-reader-catalog-drawer').getByRole('button', { name: '关闭', exact: true }).click(); await settled(page);
  after = await snapshot(page); expectRatio(before, after); assert.equal(after.catalogOpen, false);
  pass(`${mode} ${local ? 'local' : 'remote'} toolbar night and catalog overlay retain entities and closure state`);
  const settings = after.settings;
  await page.getByRole('button', { name: '下一章', exact: true }).click(); await settled(page);
  after = await snapshot(page); assert.equal(after.chapter, 3); assert.equal(after.count, 1000); assert.deepEqual(after.settings, settings);
  assert.equal(after.font, `${settings.fontSize}px`); assert.equal(after.ratio, 0);
  await page.locator('.novel-reader-content p').first().evaluate(p => p.click());
  await page.getByRole('button', { name: '上一章', exact: true }).click(); await settled(page);
  after = await snapshot(page); assert.equal(after.chapter, 2); assert.equal(after.count, 1000); assert.deepEqual(after.settings, settings);
  await page.locator('.novel-reader-content p').first().evaluate(p => p.click());
  await page.getByRole('button', { name: '返回', exact: true }).click(); await frames(page);
  assert.equal(await page.locator('.novel-reader-screen').count(), 0);
  assert.equal(await page.evaluate(() => document.body.classList.contains('novel-reader-immersive')), false);
  assert.equal(await page.evaluate(() => __styleNative.at(-1).immersive), false);
  pass(`${mode} ${local ? 'local' : 'remote'} adjacent chapters and return preserve persisted styling and native exit`);
}
async function verifyOwnership() {
  for (const owner of ['route-abort', 'source-change', 'leave-reader']) {
    const page = await newReader('scroll');
    try {
      await page.evaluate(() => __holdStyleFrames()); await clickBatch(page, [['字号', 'A+']]);
      await page.evaluate(owner => {
        if (owner === 'route-abort') __styleFixture.invalidate();
        else if (owner === 'source-change') __styleFixture.source(`${location.origin}/obsolete`);
        else return __styleFixture.showView('novels');
      }, owner);
      const before = await begin(page), count = requests.length;
      await page.evaluate(() => __releaseStyleFrames()); await frames(page);
      if (owner !== 'leave-reader') {
        await row(page, '字号').getByRole('button', { name: 'A+', exact: true }).evaluate(button => button.click());
        await row(page, '亮度').locator('input').evaluate(input => { input.value = '60'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
      }
      await page.waitForTimeout(700);
      if (owner === 'leave-reader') {
        assert.equal(await page.locator('.novel-reader-screen').count(), 0);
        assert.equal(await page.evaluate(() => document.body.classList.contains('novel-reader-immersive')), false);
      } else {
        const after = await snapshot(page); assert.equal(after.current, false); assert.equal(after.sameScreen, true); assert.equal(after.sameParagraph, true);
        assert.deepEqual(after.settings, before.settings); assert.deepEqual(after.stored, before.stored); assert.deepEqual(after.native, before.native);
        assert.equal(after.paragraphs, 0); assert.equal(after.created, 0); assert.equal(after.height, before.height);
      }
      assert.equal(requests.length, count, 'obsolete settings and delayed restores do not issue HTTP'); assert.deepEqual(page.errors, []);
      pass(`${owner} fences stale live/non-live controls and pending layout restore`);
    } finally { await page.close(); }
  }
  for (const mode of ['scroll', 'page']) for (const replacement of ['screen', 'chapter', 'book']) {
    const page = await newReader(mode);
    try {
      await page.evaluate(() => {
        window.__obsoleteStyleControls = {
          brightness: document.querySelector('.novel-reader-settings-panel input'),
          font: [...document.querySelectorAll('.novel-reader-settings-panel button')].find(button => button.textContent === 'A+'),
          night: document.querySelector('[data-novel-night-toggle]'),
          done: [...document.querySelectorAll('.novel-reader-settings-panel button')].find(button => button.textContent === '完成'),
          slider: document.querySelector('[data-novel-chapter-slider]'),
          toolbar: document.querySelector('.novel-reader-toolbar')
        };
      });
      if (replacement === 'screen') await page.evaluate(() => __styleReader.rerender());
      else await page.evaluate(id => __styleFixture.showView('novelReader', { id, chapterIndex: '3' }), replacement === 'book' ? otherBook.id : book.id);
      await settled(page); await page.evaluate(() => __styleReader.position(.61));
      await settled(page); const before = await begin(page), count = requests.length;
      assert.equal(before.current, true); assert.equal(before.chapter, replacement === 'screen' ? 2 : 3);
      assert.equal(await page.evaluate(() => Object.values(__obsoleteStyleControls).every(control => !control.isConnected)), true);
      await page.evaluate(() => {
        const { slider } = __obsoleteStyleControls;
        slider.value = '75'; slider.dispatchEvent(new Event('input', { bubbles: true })); slider.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await settled(page);
      assert.deepEqual(await snapshot(page), before, 'old progress input/change cannot move, save or mutate the replacement reader');
      assert.equal(requests.length, count, 'old progress change cannot write the replacement chapter');
      await page.evaluate(() => {
        const { brightness, font, night, done, toolbar } = __obsoleteStyleControls;
        brightness.value = '60'; brightness.dispatchEvent(new Event('input', { bubbles: true })); brightness.dispatchEvent(new Event('change', { bubbles: true }));
        font.click(); night.click(); done.click();
        toolbar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' })); toolbar.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        for (const button of toolbar.querySelectorAll('button')) button.click();
      });
      await settled(page); const after = await snapshot(page);
      assert.deepEqual(after, before, 'all detached panel/toolbar controls preserve the complete current reader state, DOM, native calls and disabled buttons');
      assert.equal(requests.length, count);
      assert.deepEqual(page.errors, []);
      pass(`${mode} replacement ${replacement} fences all detached progress/panel/toolbar handlers and saved position`);
    } finally { await page.close(); }
  }
}

async function verifyWidths() {
  for (const width of [360, 480]) for (const mode of ['scroll', 'page']) {
    const page = await newReader(mode, false, width);
    try {
      const control = row(page, '字号').getByRole('button', { name: 'A+', exact: true }), before = await begin(page, control);
      await control.click(); await settled(page); const after = await snapshot(page);
      expectReused(after); expectRatio(before, after);
      assert.equal(after.font, '25px'); assert.equal(after.viewport, width); assert.equal(after.documentWidth, width);
      assert(after.panelRect.x >= 0 && after.panelRect.x + after.panelRect.width <= width, 'panel fits the actual viewport width');
      assert(after.contentWidth <= width && after.contentWidth > 250, 'actual chapter area has a usable width');
      if (artifactDir) await page.screenshot({ path: path.join(artifactDir, `settings-${mode}-${width}px.png`) });
      assert.deepEqual(page.errors, []);
      pass(`${width}px ${mode} actual geometry, readable content, complete entity reuse and screenshot`);
    } finally { await page.close(); }
  }
}

async function verifyKeyboard() {
  for (const mode of ['scroll', 'page']) {
    const page = await newReader(mode);
    try {
      const control = row(page, '字号').getByRole('button', { name: 'A+', exact: true }), before = await begin(page, control);
      await page.evaluate(() => __holdStyleFrames());
      await control.evaluate(button => button.click());
      assert.equal(await page.evaluate(() => __styleReader.snapshot().restorePending), true);
      await page.keyboard.press('Space');
      await row(page, '行距').getByRole('button', { name: '松', exact: true }).focus(); await page.keyboard.press('Space');
      await row(page, '阅读方式').getByRole('button', { name: mode === 'scroll' ? '翻页' : '滚动', exact: true }).focus(); await page.keyboard.press('Enter');
      await row(page, '阅读方式').getByRole('button', { name: mode === 'scroll' ? '滚动' : '翻页', exact: true }).focus(); await page.keyboard.press('Space');
      await page.evaluate(() => __releaseStyleFrames()); await settled(page); const after = await snapshot(page);
      expectRatio(before, after); assert.equal(after.settings.fontSize, 26); assert.equal(after.settings.readingMode, mode);
      assert(Math.abs(after.settings.lineHeight - 2.04) < .0001); assert.equal(after.paragraphs, 0); assert.equal(after.created, 0); assert.equal(after.renders, 0);
      assert.equal(after.sameScreen, true); assert.equal(after.samePanel, true);
      // An actual navigation key on the document still cancels an outstanding layout restore.
      await page.evaluate(() => __holdStyleFrames()); await clickBatch(page, [['字号', 'A+']]);
      await page.evaluate(() => document.activeElement.blur()); await page.keyboard.press('ArrowDown');
      assert.equal(await page.evaluate(() => __styleReader.snapshot().restorePending), false);
      await page.evaluate(() => __releaseStyleFrames()); await frames(page);
      assert.deepEqual(page.errors, []);
      pass(`${mode} actual Space/Enter repeated setting activation preserves pending ratio; document key cancels restore`);
    } finally { await page.close(); }
  }
}
