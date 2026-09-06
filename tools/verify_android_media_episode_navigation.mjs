import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { appFunction, createNavigationFixtureDocument } from "./fixtures/android-gallery-navigation-harness.mjs";
import { captureMediaTrail, mediaBackTarget } from "../android-client/www/js/media-navigation-state.js";
import { formatBytes, formatDate, formatNumber, formatTime } from "../android-client/www/js/format.js";
import { absoluteUrl } from "../android-client/www/js/image.js";
import { createImageLibraryService } from "../src/modules/content-index/server/image-library-service.js";

// Full channel factory, media adapter, shell render-generation methods and real
// server list-selection/pagination execute. Only DOM/event/HTTP/cache/native and
// metadata/index inputs are synthetic. No server, actual media, DB or device.
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const source = read("android-client/www/platform/content-index/channel-views.js");
const mediaSource = read("android-client/www/modules/media/android-module.js"), appSource = read("android-client/www/app.js");
const legacy = JSON.parse(read("tools/fixtures/android-media-episode-navigation-before-fix.json"));
assert.equal(createHash("sha256").update(JSON.stringify(legacy.sources)).digest("hex"), "24ed3b35c9fbcd227bbe4351cf794d5cf5eea90a7c0ddacdac4bf1d1a72a4d7d");
for (const entry of Object.values(legacy.sources)) assert.equal(createHash("sha256").update(entry.source).digest("hex"), entry.sha256);
const strip = value => value.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
const plain = value => JSON.parse(JSON.stringify(value));
const A = "https://synthetic-a.invalid", B = "https://synthetic-b.invalid", CATEGORY = "Synthetic category / ? &", SERIES = "Synthetic series / ? #";
const SERIES_KEY = `${CATEGORY}|${SERIES}`;
const id = number => `synthetic-episode-${String(number).padStart(4, "0")}`;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function syntheticLibrary(count, metadataCount) {
  let scannedAt = "2026-08-01T00:00:00Z";
  let items = Array.from({ length: count }, (_, index) => ({ id: id(index + 1), mediaKind: "tv", type: "tv", title: `Episode ${index + 1}`,
    category: CATEGORY, seriesName: SERIES, size: 2048, ext: "mkv", exists: true, updatedAt: "2026-08-01T00:00:00Z" }));
  const metadata = metadataCount === undefined ? null : { title: SERIES, episodeCount: metadataCount };
  const metadataMap = new Map(metadata ? [[SERIES_KEY, metadata]] : []);
  const service = createImageLibraryService({
    clampInteger(value, fallback, min, max) { const n = Number.parseInt(String(value ?? ""), 10); return Math.min(max, Math.max(min, Number.isFinite(n) ? n : fallback)); },
    getImageLibraryIndex: () => ({ scannedAt, photoSets: [], mediaItems: items }),
    maxItemLimit: 12000, galleryMediaRootStatuses: () => [], photoSetRootStatuses: () => [], imageReaderCacheStatus: () => ({}),
    mangaService: { cacheDirs: () => [], publicSummary: value => value, rootStatus: () => ({}) },
    metadataService: { movieRowsMap: () => new Map(), movieRow: () => null, publicMovie: value => value,
      tvSeriesRowsMap: () => metadataMap, tvSeriesRow: key => metadataMap.get(key), publicTvSeries: value => value,
      tvSeriesKey: (category, title) => `${category}|${title}` },
    photoCollectionRootValue: "synthetic", photoSetService: { coverUrl: () => "" }
  });
  return { service,
    rescanShift() { items = [...items.slice(1), { ...items[0], id: id(count + 1), title: `Episode ${count + 1}` }]; scannedAt = "2026-08-01T00:01:00Z"; },
    detail(number) { const row = items.find(value => value.id === id(number)) || { ...items[0], id: id(number) }; return {
    item: { ...service.publicGalleryMediaItem(row), streamUrl: `/media/gallery-video/${encodeURIComponent(row.id)}`, progress: { position: 73, duration: 240 } }
  }; } };
}
function harness(input = source, { count = 90, current = 80, metadataCount, cached = false } = {}) {
  const library = syntheticLibrary(count, metadataCount), document = createNavigationFixtureDocument();
  const proto = Object.getPrototypeOf(document.body);
  if (!Object.getOwnPropertyDescriptor(proto, "isConnected")) Object.defineProperty(proto, "isConnected", { get() { return this.ownerDocument.body.contains(this); } });
  if (!Object.getOwnPropertyDescriptor(proto, "childElementCount")) Object.defineProperty(proto, "childElementCount", { get() { return this.children.length; } });
  const els = Object.fromEntries(["viewContent", "viewTitle", "viewMeta", "viewKicker", "contentPanel"].map(key => [key, document.createElement("div")]));
  document.body.append(...Object.values(els));
  const calls = { pages: [], details: [], nav: [], bridge: [], errors: [] }, pageQueue = [], detailQueue = [];
  let activeUrl = A, currentNumber = current;
  const originalCreate = document.createElement;
  document.createElement = tag => {
    const node = originalCreate(tag), add = node.addEventListener.bind(node), click = node.click.bind(node);
    node.disabled = false;
    node.addEventListener = (type, callback, options) => add(type, event => {
      try { const task = callback(event); task?.catch?.(error => calls.errors.push(error)); } catch (error) { calls.errors.push(error); }
    }, options);
    node.click = () => { if (node.disabled) return; const event = { type: "click", target: node, preventDefault() {}, stopPropagation() {} };
      try { node.onclick?.(event); return click(); } catch (error) { calls.errors.push(error); } };
    return node;
  };
  document.addEventListener = () => {}; document.visibilityState = "visible";
  const context = vm.createContext({ console, document, URL, URLSearchParams, AbortController, captureMediaTrail, mediaBackTarget,
    currentView: "mediaDetail", currentViewParams: {}, viewRenderToken: 0, activeViewController: null,
    performance: { now: () => 0 }, window: { addEventListener() {}, setTimeout() { return 1; }, clearTimeout() {},
      Capacitor: { Plugins: { FanHaoPlayer: { async play(value) { calls.bridge.push(plain(value)); return { opened: true }; } } } } },
    formatBytes, formatDate, formatNumber, formatTime, absoluteUrl, cacheAgeText: () => "synthetic", photoCatalogCollections: value => value,
    isChannelFavorite: () => false, toggleChannelFavorite: () => ({ favorite: true, items: [] }), loadPreviewImage() {}, enhanceAutoLoadMore() {},
    readCachedJson: async () => cached ? { payload: library.detail(currentNumber) } : null, writeCachedJson: async () => {},
    fetchJson: async (base, path, options = {}) => {
      assert([A, B].includes(base), "Only synthetic sources are permitted");
      let value;
      if (path.startsWith("/api/gallery-media/")) { calls.details.push({ base, path, options }); value = detailQueue.length ? detailQueue.shift() : library.detail(currentNumber); }
      else {
        assert(path.startsWith("/api/image-library/items?"), `Unexpected endpoint: ${path}`);
        const url = new URL(path, base), actual = library.service.itemsPayload(url), call = { base, path, options, params: Object.fromEntries(url.searchParams), actual };
        calls.pages.push(call); value = pageQueue.length ? pageQueue.shift() : actual;
        if (typeof value === "function") value = value(call);
      }
      if (value instanceof Error) throw value; return await (value?.promise || value);
    }
  });
  vm.runInContext(["sameViewParams", "beginViewRender", "invalidateViewRender"].map(name => appFunction(appSource, name)).join("\n"), context);
  vm.runInContext(strip(input), context, { filename: "actual-episode-channel.js" });
  const trail = JSON.stringify([{ mode: "tv", query: "root query", sort: "rating" }, { mode: "tv", tvView: "episodes", seriesKey: SERIES_KEY, sort: "title" }]);
  const host = { els, normalizeChannelMode: context.normalizeChannelMode, getActiveUrl: () => activeUrl,
    limits: { getChannel: () => 36 }, recent: { record() {} }, favorites: { onChannelFavoriteChange() {} },
    navigation: { currentView: () => context.currentView, currentParams: () => context.currentViewParams,
      returnToStackView: () => false, showView: (view, params, navigation) => calls.nav.push(plain({ view, params, navigation })), goBack() {}, openInLibrary() {} },
    ui: { setActiveBottom() {}, renderCurrentView() {}, renderCurrentViewPreservingScroll() {}, refreshChrome() {}, openSearch() {} },
    contentIndex: { updateChannelQuery() {}, updateChannelParams() {}, updateSearch() {} } };
  const adapter = input === legacy.sources.channel.source ? legacy.sources.media.source : mediaSource;
  const createModule = vm.runInContext(`(function(){${strip(adapter)};return createAndroidModule;})()`, context), module = createModule({ host });
  const h = { context, document, els, calls, library, trail,
    queuePage(value) { pageQueue.push(value); }, queueDetail(value) { detailQueue.push(value); }, setSource(value) { activeUrl = value; },
    leave() { context.invalidateViewRender(); context.currentView = "channel"; els.viewContent.textContent = "OTHER PAGE"; },
    abort() { context.activeViewController.abort(); },
    start(number = currentNumber) { currentNumber = number; context.currentView = "mediaDetail"; context.currentViewParams = { id: id(number), mode: "tv", mediaTrail: trail };
      const guard = context.beginViewRender("mediaDetail", context.currentViewParams); return module.routes.find(route => route.view === "mediaDetail").render(context.currentViewParams, guard); },
    async settle() { for (let index = 0; index < 160; index++) await Promise.resolve(); assert.equal(calls.errors.length, 0, calls.errors[0]?.stack); },
    row: () => els.viewContent.querySelector(".media-episode-nav"), label: () => h.row()?.querySelector(".media-episode-nav-label")?.textContent || "",
    button(text) { return h.row()?.querySelectorAll("button").find(button => button.textContent === text); },
    async click(text) { const button = h.button(text); assert(button, `Actual ${text} button exists`); button.click(); await h.settle(); },
    async retry() { const button = h.row()?.querySelectorAll("button").find(value => /重试|重新/.test(value.textContent)); assert(button, "Actual explicit retry exists"); button.click(); await h.settle(); }
  }; return h;
}

const tests = [], test = (name, run) => tests.push({ name, run });
for (const current of [80, 81]) test(`unknown metadata 90-episode library at ${current} exposes correct next and actual total`, async input => {
  const h = harness(input, { current }); await h.start(); await h.settle();
  assert.equal(h.row().hidden, false, "Episode row must remain visible beyond the former fixed prefix");
  assert.equal(h.button("下一集").disabled, false, "Existing next episode must not be lost at fixed-prefix boundary");
  assert.equal(h.label(), `第 ${current} / 90 集`, "Label total is actual library total, not prefix length or metadata");
  await h.click("下一集"); assert.equal(h.calls.nav.length, 1); assert.equal(h.calls.nav[0].params.id, id(current + 1)); assert.deepEqual(JSON.parse(h.calls.nav[0].params.mediaTrail), JSON.parse(h.trail));
});
for (const current of [240, 241]) test(`known metadata 300 does not truncate navigation at ${current}`, async input => {
  const h = harness(input, { count: 300, current, metadataCount: 300 }); await h.start(); await h.settle();
  assert.equal(h.row().hidden, false, "Episode row must remain visible beyond the former fixed-prefix ceiling");
  assert.equal(h.button("下一集").disabled, false, "Existing next episode must not be lost at fixed-prefix ceiling");
  assert.equal(h.label(), `第 ${current} / 300 集`); await h.click("下一集"); assert.equal(h.calls.nav.at(-1).params.id, id(current + 1));
});
for (const current of [239, 240, 241, 300]) test(`300 episodes at ${current} resolve across a 240-item page boundary`, async input => {
  const h = harness(input, { count: 300, current, metadataCount: 12 }); await h.start(); await h.settle();
  assert.equal(h.row().hidden, false); assert.equal(h.label(), `第 ${current} / 300 集`);
  assert.equal(h.button("上一集").disabled, false); await h.click("上一集"); assert.equal(h.calls.nav.at(-1).params.id, id(current - 1));
  assert.equal(h.button("下一集").disabled, current === 300);
  if (current < 300) { await h.click("下一集"); assert.equal(h.calls.nav.at(-1).params.id, id(current + 1)); }
  assert.deepEqual(h.calls.pages.map(call => Number(call.params.offset || 0)), current < 240 ? [0] : [0, 240]);
});

for (const [count, current] of [[1, 1], [90, 1], [90, 90], [800, 1], [800, 800]]) test(`exact first/last boundaries and early stop for ${current}/${count}`, async input => {
  const h = harness(input, { count, current, metadataCount: 99999 }); await h.start(); await h.settle();
  assert.equal(h.row().dataset.state, "ready"); assert.equal(h.label(), `第 ${current} / ${count} 集`);
  assert.equal(h.row().getAttribute("aria-busy"), null); assert.equal(h.row().children.length, 3, "Navigation remains a three-column row");
  assert.equal(h.button("上一集").disabled, current === 1); assert.equal(h.button("下一集").disabled, current === count);
  if (current === 1) { await h.click("上一集"); assert.equal(h.calls.nav.length, 0); }
  if (current === count) { await h.click("下一集"); assert.equal(h.calls.nav.length, 0); }
  assert.equal(h.calls.pages.length, current === 1 ? 1 : Math.ceil(current / 240));
  for (const call of h.calls.pages) { assert.equal(call.params.limit, "240"); assert.equal(call.params.mode, "tv"); assert.equal(call.params.tvView, "episodes"); assert.equal(call.params.seriesKey, SERIES_KEY); assert.equal(call.params.category, CATEGORY); assert.equal(call.params.sort, "title"); assert.equal(call.params.q, undefined); assert.equal(call.options.signal, h.context.activeViewController.signal); }
});

test("short nonfinal page advances by actual count rather than requested page size", async input => {
  const h = harness(input, { current: 20 }); h.queuePage(call => ({ ...call.actual, items: call.actual.items.slice(0, 13), count: 13 }));
  await h.start(); await h.settle(); assert.equal(h.label(), "第 20 / 90 集"); assert.deepEqual(h.calls.pages.map(call => Number(call.params.offset || 0)), [0, 13]);
  await h.click("上一集"); assert.equal(h.calls.nav.at(-1).params.id, id(19)); await h.click("下一集"); assert.equal(h.calls.nav.at(-1).params.id, id(21));
});

const malformedPages = {
  "missing items": data => ({ ...data, items: null }),
  "empty nonfinal page": data => ({ ...data, items: [] }),
  "oversized page": data => ({ ...data, total: 500, items: Array.from({ length: 241 }, (_, index) => ({ ...data.items[0], id: id(index + 1) })) }),
  "negative total": data => ({ ...data, total: -1 }),
  "fractional total": data => ({ ...data, total: 90.5 }),
  "string total": data => ({ ...data, total: "90" }),
  "unsafe total": data => ({ ...data, total: Number.MAX_SAFE_INTEGER + 1 }),
  "items exceed total": data => ({ ...data, total: 1 }),
  "missing offset": data => ({ ...data, offset: undefined }),
  "incorrect offset": data => ({ ...data, offset: 1 }),
  "wrong series": data => ({ ...data, seriesKey: "other-series" }),
  "duplicate IDs": data => ({ ...data, items: [data.items[0], data.items[0], ...data.items.slice(2)] }),
  "empty ID": data => ({ ...data, items: [{ ...data.items[0], id: "  " }, ...data.items.slice(1)] }),
  "foreign episode series": data => ({ ...data, items: [{ ...data.items[0], seriesKey: "other-series" }, ...data.items.slice(1)] })
};
for (const [kind, change] of Object.entries(malformedPages)) test(`${kind} is a visible retryable error, never a false last episode`, async input => {
  const h = harness(input); h.queuePage(call => change(call.actual)); await h.start(); await h.settle();
  assert.equal(h.row().dataset.state, "error"); assert.equal(h.row().hidden, false); assert.equal(h.button("上一集").disabled, true); assert.equal(h.button("下一集").disabled, true);
  assert.equal(h.row().querySelector(".media-episode-nav-retry").hidden, false); assert.equal(h.calls.pages.length, 1, "No automatic retry loop");
  await h.retry(); assert.equal(h.row().dataset.state, "ready"); assert.equal(h.label(), "第 80 / 90 集"); assert.equal(h.calls.pages[1].params.offset || "0", "0");
});

for (const kind of ["total changed", "duplicate across pages", "empty later page", "network failure"]) test(`later-page ${kind} does not infer a nonexistent ending`, async input => {
  const h = harness(input, { count: 300, current: 240 }); h.queuePage(call => call.actual);
  h.queuePage(call => kind === "network failure" ? new Error("Synthetic offline") : kind === "total changed" ? { ...call.actual, total: 301 }
    : kind === "duplicate across pages" ? { ...call.actual, items: [{ ...call.actual.items[0], id: id(1) }, ...call.actual.items.slice(1)] }
      : { ...call.actual, items: [] });
  await h.start(); await h.settle(); assert.equal(h.row().dataset.state, "error"); assert.equal(h.button("下一集").disabled, true); assert.equal(h.calls.pages.length, 2);
  await h.retry(); assert.equal(h.row().dataset.state, "ready"); assert.equal(h.label(), "第 240 / 300 集"); assert.deepEqual(h.calls.pages.map(call => Number(call.params.offset || 0)), [0, 240, 0, 240]);
});

test("current episode absent from completed directory remains visible with explicit retry", async input => {
  const h = harness(input, { count: 90, current: 91 }); await h.start(); await h.settle();
  assert.equal(h.row().dataset.state, "error"); assert.match(h.label(), /当前集/); assert.equal(h.row().hidden, false); assert.equal(h.calls.pages.length, 1);
});

test("repeated failure retries from zero and duplicate retry callbacks remain single-flight", async input => {
  const h = harness(input, { count: 300, current: 240 }); h.queuePage(call => call.actual); h.queuePage(Error("Synthetic first failure")); await h.start(); await h.settle();
  const delayed = deferred(); h.queuePage(delayed); h.queuePage(Error("Synthetic repeat failure"));
  const retry = h.row().querySelector(".media-episode-nav-retry"), handler = retry.listeners.get("click")[0];
  retry.click(); handler({ type: "click" }); await h.settle(); assert.equal(h.calls.pages.length, 3); assert.equal(h.row().dataset.state, "loading");
  assert.equal(retry.disabled, true); assert.equal(h.row().getAttribute("aria-busy"), "true");
  delayed.resolve(h.calls.pages[2].actual); await h.settle(); assert.equal(h.row().dataset.state, "error"); assert.equal(h.calls.pages.length, 4);
  await h.retry(); assert.equal(h.row().dataset.state, "ready"); assert.deepEqual(h.calls.pages.map(call => Number(call.params.offset || 0)), [0, 240, 0, 240, 0, 240]);
});

for (const invalidation of ["source", "abort", "leave", "detach", "rerender"]) test(`${invalidation} while a later page is pending cannot paint or continue pagination`, async input => {
  const h = harness(input, { count: 800, current: 700 }), delayed = deferred(); h.queuePage(call => call.actual); h.queuePage(delayed);
  await h.start(); await h.settle(); const oldRow = h.row(); assert.equal(h.calls.pages.length, 2);
  if (invalidation === "source") h.setSource(B); else if (invalidation === "abort") h.abort(); else if (invalidation === "leave") h.leave();
  else if (invalidation === "detach") h.els.viewContent.textContent = "DETACHED"; else { await h.start(1); await h.settle(); assert.notEqual(h.row(), oldRow); }
  const label = oldRow.textContent, calls = h.calls.pages.length, screen = h.els.viewContent.textContent;
  delayed.resolve(h.calls.pages[1].actual); await h.settle(); assert.equal(h.calls.pages.length, calls, "Retired page cannot request another page");
  assert.equal(oldRow.textContent, label); assert.equal(h.els.viewContent.textContent, screen); assert.equal(h.calls.nav.length, 0);
});

for (const invalidation of ["source", "abort", "leave", "detach", "rerender"]) test(`${invalidation} rejects an already-enabled old episode onclick`, async input => {
  const h = harness(input); await h.start(); await h.settle(); const oldButton = h.button("下一集"), oldHandler = oldButton.onclick; assert.equal(oldButton.disabled, false);
  if (invalidation === "source") h.setSource(B); else if (invalidation === "abort") h.abort(); else if (invalidation === "leave") h.leave();
  else if (invalidation === "detach") h.els.viewContent.textContent = "DETACHED"; else { await h.start(1); await h.settle(); }
  oldHandler(); await h.settle(); assert.equal(h.calls.nav.length, 0, "Retired onclick may not navigate to another episode");
});

test("cached navigation detached by fresh detail does not continue its obsolete page request", async input => {
  const h = harness(input, { count: 800, current: 700, cached: true }), oldPage = deferred(), fresh = deferred(); h.queuePage(oldPage); h.queueDetail(fresh);
  const rendering = h.start(); await h.settle(); const oldRow = h.row(); assert.equal(h.calls.pages.length, 1);
  fresh.resolve(h.library.detail(700)); await rendering; await h.settle(); const currentRow = h.row(); assert.notEqual(currentRow, oldRow); assert.equal(currentRow.dataset.state, "ready");
  const before = h.calls.pages.length; oldPage.resolve(h.calls.pages[0].actual); await h.settle(); assert.equal(h.calls.pages.length, before); assert.equal(h.row(), currentRow);
});

test("same-total actual rescan between pages rejects skipped neighbor and retry uses the new directory", async input => {
  const h = harness(input, { count: 481, current: 240 }); h.queuePage(call => { h.library.rescanShift(); return call.actual; });
  await h.start(); await h.settle();
  assert.equal(h.calls.pages[0].actual.total, h.calls.pages[1].actual.total); assert.notEqual(h.calls.pages[0].actual.scannedAt, h.calls.pages[1].actual.scannedAt);
  assert.equal(h.calls.pages[1].actual.items[0].id, id(242), "Actual offset page shifts while total is unchanged");
  assert.equal(h.row().dataset.state, "error", "A known rescan must not offer 242 as neighbor and silently skip 241");
  assert.equal(h.button("下一集").disabled, true); await h.retry(); assert.equal(h.label(), "第 239 / 481 集");
  await h.click("下一集"); assert.equal(h.calls.nav.at(-1).params.id, id(241)); assert.deepEqual(h.calls.pages.map(call => Number(call.params.offset || 0)), [0, 240, 0]);
});

for (const invalidation of ["source", "abort"]) test(`${invalidation} during the immediate neighbor page cannot mark a retired row ready`, async input => {
  const h = harness(input, { count: 300, current: 240 }), delayed = deferred(); h.queuePage(call => call.actual); h.queuePage(delayed);
  await h.start(); await h.settle(); const row = h.row(); assert.equal(row.dataset.state, "loading");
  if (invalidation === "source") h.setSource(B); else h.abort();
  delayed.resolve(h.calls.pages[1].actual); await h.settle(); assert.equal(row.dataset.state, "loading"); assert.equal(h.button("下一集").disabled, true);
});

const mutations = [], mutate = (name, scenario, change) => mutations.push({ name, scenario, change });
const replaceOnce = (value, from, to) => { assert(value.includes(from), `Missing mutation target ${from}`); return value.replace(from, to); };
const navMutation = change => value => {
  const start = value.indexOf("  function createTvEpisodeNav("), tail = value.slice(start), end = /^  }(?=\r?\n)/m.exec(tail);
  assert(start >= 0 && end, "Actual nav function must exist"); const method = tail.slice(0, end.index + end[0].length);
  return replaceOnce(value, method, change(method));
};
mutate("drop real playback context propagation", "abort during the immediate neighbor page cannot mark a retired row ready", value => replaceOnce(value, "const episodeNav = createTvEpisodeNav(item, playbackContext);", "const episodeNav = createTvEpisodeNav(item);"));
mutate("load before the newly created row is mounted", tests[0].name, navMutation(method => replaceOnce(method, "Promise.resolve().then(loadEpisodes);", "loadEpisodes();")));
mutate("advance offset by requested size instead of actual length", "short nonfinal page advances by actual count rather than requested page size", navMutation(method => replaceOnce(method, "offset += episodes.length;", "offset += pageSize;")));
mutate("show seen prefix size rather than server total", "300 episodes at 239 resolve across a 240-item page boundary", navMutation(method => replaceOnce(method, "${current.position} / ${total}", "${current.position} / ${seen.size}")));
mutate("mistake every page boundary for series ending", "300 episodes at 240 resolve across a 240-item page boundary", navMutation(method => replaceOnce(method, "if (offset >= total)", "if (true)")));
mutate("forget prior-page last episode", "300 episodes at 241 resolve across a 240-item page boundary", navMutation(method => replaceOnce(method, "for (let index = 0; index < episodes.length; index += 1)", "previous = null;\n          for (let index = 0; index < episodes.length; index += 1)")));
mutate("ignore ownership after awaiting a neighbor page", "source during the immediate neighbor page cannot mark a retired row ready", navMutation(method => replaceOnce(method, "if (!isCurrent()) return;", "/* mutation: post-request owner unchecked */")));
mutate("let old enabled onclick navigate", "source rejects an already-enabled old episode onclick", value => replaceOnce(value, "if (!button.disabled && isCurrent()) showMediaDetail", "if (!button.disabled) showMediaDetail"));
mutate("remove duplicate-ID fence", "later-page duplicate across pages does not infer a nonexistent ending", navMutation(method => replaceOnce(method, " || seen.has(id)", "")));
mutate("ignore changed total between pages", "later-page total changed does not infer a nonexistent ending", navMutation(method => replaceOnce(method, " || (total !== null && data.total !== total)", "")));
mutate("ignore returned directory identity", "wrong series is a visible retryable error, never a false last episode", navMutation(method => replaceOnce(method, '|| String(data.seriesKey || "") !== seriesKey', "|| false")));
mutate("ignore scan revision while total remains unchanged", "same-total actual rescan between pages rejects skipped neighbor and retry uses the new directory", navMutation(method => replaceOnce(method, '|| (scanRevision !== null && String(data.scannedAt || "") !== scanRevision)', "|| false")));
mutate("resume retry at failed offset instead of restarting directory", "later-page network failure does not infer a nonexistent ending", navMutation(method => {
  let changed = replaceOnce(method, "let loading = false;", "let loading = false; let retainedOffset = 0;");
  changed = replaceOnce(changed, "let offset = 0, total", "let offset = retainedOffset, total");
  return replaceOnce(changed, "offset += episodes.length;", "offset += episodes.length; retainedOffset = offset;");
}));
mutate("remove load single-flight fence", "repeated failure retries from zero and duplicate retry callbacks remain single-flight", navMutation(method => replaceOnce(method, "if (loading || !isCurrent()) return;", "if (!isCurrent()) return;")));
mutate("scan past already-known next episode", "exact first/last boundaries and early stop for 1/800", navMutation(method => replaceOnce(method, "if (current) { complete(episode); return; }", "if (current) { complete(episode); continue; }")));
mutate("allow oversized response pages", "oversized page is a visible retryable error, never a false last episode", navMutation(method => replaceOnce(method, " || episodes.length > pageSize", "")));
mutate("ignore response offset", "incorrect offset is a visible retryable error, never a false last episode", navMutation(method => replaceOnce(method, " || data.offset !== offset", "")));

let passed = 0, failed = 0, oldRejected = 0, mutantsRejected = 0;
if (!process.argv.includes("--legacy-only")) for (const test of tests) {
  try { await test.run(source); passed++; console.log(`PASS ${test.name}`); } catch (error) { failed++; console.error(`FAIL ${test.name}\n${error.stack}`); }
}
for (const test of tests.slice(0, 4)) {
  try { let failure; try { await test.run(legacy.sources.channel.source); } catch (error) { failure = error; }
    assert(failure instanceof assert.AssertionError, `Frozen85 must reject a safety assertion, not setup: ${failure?.stack || "unexpected pass"}`);
    assert.match(failure.message, /fixed.prefix/); oldRejected++; console.log(`REJECT frozen85 ${test.name}`);
  } catch (error) { failed++; console.error(error.stack); }
}
if (!process.argv.includes("--legacy-only")) for (const mutation of mutations) {
  try {
    const changed = mutation.change(source); assert.notEqual(changed, source, "Mutant must change production");
    const scenario = tests.find(test => test.name === mutation.scenario); assert(scenario, `Missing scenario ${mutation.scenario}`);
    let failure; try { await scenario.run(changed); } catch (error) { failure = error; }
    assert(failure instanceof assert.AssertionError, `Mutant must reject a behavior assertion, not setup: ${failure?.stack || "unexpected pass"}`);
    mutantsRejected++; console.log(`REJECT mutation ${mutation.name}`);
  } catch (error) { failed++; console.error(`FAIL mutation ${mutation.name}\n${error.stack}`); }
}
const chain = JSON.parse(read("package.json")).scripts["verify:android-client"];
assert(chain.includes("node tools/verify_android_media_play_intent.mjs && node tools/verify_android_media_episode_navigation.mjs &&"), "Episode suite must follow accepted-play regression in Android verification chain");
console.log(`Media episode navigation: ${passed}/${tests.length} current; ${oldRejected}/4 frozen85 safety controls; ${mutantsRejected}/${mutations.length} behavior mutants; ${failed} failures.`);
console.log(`channel SHA256 ${createHash("sha256").update(source).digest("hex")}`);
process.exitCode = failed ? 1 : 0;
