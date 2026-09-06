import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createHash, webcrypto } from "node:crypto";
import { appFunction, createGalleryHarness } from "./fixtures/android-gallery-navigation-harness.mjs";
import { formatBytes, formatDate, formatNumber, formatTime, normalizeUrl } from "../android-client/www/js/format.js";
import { absoluteUrl } from "../android-client/www/js/image.js";
import { createImageLibraryService } from "../src/modules/content-index/server/image-library-service.js";
import { PHOTO_ALBUM_SORT_OPTIONS, PHOTO_COLLECTION_SORT_OPTIONS, photoCatalogCollections } from "../android-client/www/platform/content-index/photo-catalog.js";

// Executes the real shell showView/reset/default limits/history/back/render and
// scroll-restoration methods, complete media adapter, channel factory and the
// actual auto-load module. Server list selection uses synthetic rows. DOM layout/history,
// cache, HTTP transport, IntersectionObserver scheduling and detail-body rendering remain
// explicit boundaries. No real browser/device/library/database/service is used.
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const sources = Object.fromEntries(Object.entries({
  app: "android-client/www/app.js", channel: "android-client/www/platform/content-index/channel-views.js",
  media: "android-client/www/modules/media/android-module.js", photos: "android-client/www/modules/photos/android-module.js", helper: "android-client/www/js/media-navigation-state.js",
  registry: "android-client/www/js/android-module-registry.js", navigation: "android-client/www/js/module-navigation.js",
  index: "android-client/www/index.html"
}).map(([key, file]) => [key, read(file)]));
const rangePath = new URL("../android-client/www/js/channel-history-state.js", import.meta.url);
sources.range = fs.existsSync(rangePath) ? fs.readFileSync(rangePath, "utf8") : "";
const legacy = JSON.parse(read("tools/fixtures/android-media-paging-before-fix.json"));
sources.autoLoad = read("android-client/www/js/auto-load.js");
const APP_METHODS = ["showView","resetViewLimitsForView","defaultPeopleLimit","defaultWorksLimitForView","defaultChannelLimitForView","defaultPhotoImageLimitForView","defaultMangaImageLimitForView","isPhotoChannelView","channelLimitStepForView","worksLimitStepForView","isFastServerUrl","isLocalHost","isPrivateHost","parseServerUrl","goBack","applyBackState","returnToStackView","routeHistoryState","rememberCurrentScrollInHistory","pushViewHistory","replaceCurrentHistory","restoreFromHistoryState","sanitizeViewParams","normalizeChannelMode","normalizeChannelSort","currentScrollY","queueScrollRestore","restorePendingScroll","cancelPendingScrollRestore","renderCurrentView","renderCurrentViewPreservingScroll","sameViewParams","beginViewRender","invalidateViewRender","viewRouteHash","readViewStateFromHash","rememberViewState","readLastViewState","readInitialViewState","shouldRememberView","defaultViewState","isRootNavigationView","createAndroidModuleHost"];
assert.equal(createHash("sha256").update(JSON.stringify(legacy.sources)).digest("hex"), "2c3b736973ff131b30e6802932d9ec19b746411afa42e226ab0a7f4287a086f9", "Frozen pre-fix source checksum");
const strip = source => source.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
const plain = value => JSON.parse(JSON.stringify(value));
const tick = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function syntheticService(prefix) {
  const items = [], movies = new Map(), tv = new Map();
  for (let index = 1; index <= 108; index++) {
    const number = String(index).padStart(3, "0"), movie = `${prefix} Movie ${number}`, series = `${prefix} Series ${number}`;
    const common = { category: "Synthetic category", size: index * 100, updatedAt: "2026-08-01T00:00:00Z", playable: true };
    items.push({ ...common, id: `movie-${number}`, mediaKind: "movie", title: movie });
    movies.set(`movie-${number}`, { title: movie, rating: 8, year: "2025" });
    tv.set(`Synthetic category|${series}`, { title: series, rating: 8, year: "2025" });
    for (let episode = 1; episode <= (index === 65 ? 108 : 1); episode++) {
      items.push({ ...common, id: `tv-${number}-${String(episode).padStart(3, "0")}`, mediaKind: "tv", seriesName: series,
        title: `${series} Episode ${String(episode).padStart(3, "0")}` });
    }
  }
  return createImageLibraryService({
    clampInteger: (value, fallback, min, max) => Math.min(max, Math.max(min, Number.parseInt(value, 10) || fallback)),
    getImageLibraryIndex: () => ({ scannedAt: "2026-08-01T00:00:00Z", photoSets: [], mediaItems: items }),
    maxItemLimit: 12000, galleryMediaRootStatuses: () => [], imageReaderCacheStatus: () => ({}), photoSetRootStatuses: () => [],
    mangaService: { cacheDirs: () => [], publicSummary: value => value, rootStatus: () => ({}) },
    metadataService: { movieRowsMap: () => movies, tvSeriesRowsMap: () => tv, movieRow: id => movies.get(id), tvSeriesRow: key => tv.get(key),
      publicMovie: value => value, publicTvSeries: value => value, tvSeriesKey: (category, title) => `${category}|${title}` },
    photoCollectionRootValue: "synthetic-root", photoSetService: { coverUrl: id => `/synthetic-cover/${id}` }
  });
}

function harness(input = sources, { storage = new Map(), hash = "" } = {}) {
  const h = createGalleryHarness(input, { storage }), c = h.context, no = () => {};
  const services = new Map([["https://synthetic-a.invalid", syntheticService("A")], ["https://synthetic-b.invalid", syntheticService("B")]]);
  const proto = Object.getPrototypeOf(h.document.body);
  if (!Object.getOwnPropertyDescriptor(proto, "childElementCount")) Object.defineProperty(proto, "childElementCount", { get() { return this.children.length; } });
  if (!Object.getOwnPropertyDescriptor(proto, "isConnected")) Object.defineProperty(proto, "isConnected", { get() { return this.ownerDocument.body.contains(this); } });
  proto.replaceWith = function (node) { const parent = this.parentNode; if (!parent) return; const index = parent.children.indexOf(this); parent.children[index] = node; node.parentNode = parent; this.parentNode = null; };
  proto.getBoundingClientRect = function () { const top = this.ownerDocument.footerNear ? 700 : 100000; return { top, bottom: top + 44, height: 44, width: 300, left: 0, right: 300 }; };
  for (const name of ["viewTitle", "viewMeta", "viewKicker", "contentPanel", "moduleChrome", "viewBack", "statusCard", "previewSection", "continueSection", "quickStrip"]) c.els[name] = h.document.createElement("div");
  h.document.body.append(c.els.viewContent, c.els.viewTitle, c.els.viewMeta, c.els.viewKicker, c.els.contentPanel, c.els.moduleChrome, c.els.viewBack);
  const calls = { network: [], cacheReads: [], cacheWrites: [], renders: [], scrolls: [], actions: new Set(), errors: [] }, cache = new Map(), queue = [], cacheQueue = [], loadButtons = [], observers = [];
  const originalCreate = h.document.createElement;
  h.document.createElement = tag => {
    const node = originalCreate(tag), add = node.addEventListener.bind(node);
    node.disabled = false;
    node.addEventListener = (type, handler) => add(type, event => {
      try { const task = handler(event); if (task?.then) { calls.actions.add(task); task.catch(error => calls.errors.push(error)).finally(() => calls.actions.delete(task)); } return task; }
      catch (error) { calls.errors.push(error); }
    });
    return node;
  };
  let pending = Promise.resolve(), frameId = 0; const frames = new Map(), events = new Map(), entries = []; let historyIndex = -1;
  Object.assign(c, {
    URL, URLSearchParams, AbortController, crypto: webcrypto, formatBytes, formatDate, formatNumber, formatTime, absoluteUrl,
    activeUrl: "https://synthetic-a.invalid", normalizeUrl,
    viewRenderToken: 0, activeViewController: null, pendingScrollRestore: null, scrollRestoreIntent: 0,
    peopleLimit: 48, worksLimit: 40, channelLimit: 36, photoImageLimit: 12, mangaImageLimit: 8,
    library: {}, HISTORY_MARKER: "synthetic-history", mediaViewer: { close: () => false }, channelViews: null,
    cacheAgeText: () => "synthetic", isChannelFavorite: () => false, toggleChannelFavorite: () => ({ favorite: true, items: [] }),
    photoCatalogCollections, PHOTO_ALBUM_SORT_OPTIONS, PHOTO_COLLECTION_SORT_OPTIONS, openMobileActionSheet: no, loadPreviewImage: no,
    HTMLButtonElement: proto.constructor,
    fetchJson: async (source, path, options) => {
      if (path === "/api/manga/jobs" || path.startsWith("/api/manga/jobs?")) { assert(!options?.method || options.method === "GET"); return { jobs: [] }; }
      const request = { source, path, options }; calls.network.push(request); const response = queue.shift();
      const actual = services.get(source).itemsPayload(new URL(path, source));
      if (response instanceof Error) throw response;
      return response ? await (typeof response === "function" ? response(actual) : response.promise || response) : actual;
    },
    readCachedJson: async (source, path) => {
      calls.cacheReads.push({ source, path }); const hold = cacheQueue.shift();
      return hold ? await (hold.promise || hold) : cache.get(JSON.stringify([source, path])) || null;
    },
    writeCachedJson: async (source, path, payload) => {
      calls.cacheWrites.push({ source, path, payload: plain(payload) });
      cache.set(JSON.stringify([source, path]), { updatedAt: "synthetic", payload: plain(payload) });
    },
    requestAnimationFrame: fn => { const id = ++frameId; frames.set(id, fn); return id; },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    syncContentPanelMode: no, syncSearchSurface: no, hideSettingsSurface: no, showSettings: no,
    settleAppConfirmation: no, closeSettings: no, closeSearchSurface: () => { c.searchSurfaceExpanded = false; }
  });
  h.document.documentElement = { scrollTop: 0 };
  Object.defineProperty(h.document.documentElement, "scrollHeight", { get: () => 800 + titles().length * 100 });
  c.window.innerHeight = 800; c.window.scrollY = 0; c.window.location = { hash };
  c.window.scrollTo = ({ top }) => { c.window.scrollY = Math.max(0, Math.min(top, h.document.documentElement.scrollHeight - c.window.innerHeight)); calls.scrolls.push(c.window.scrollY); };
  c.window.addEventListener = (name, callback) => { if (!events.has(name)) events.set(name, []); events.get(name).push(callback); };
  c.window.removeEventListener = (name, callback) => { events.set(name, (events.get(name) || []).filter(value => value !== callback)); };
  c.window.dispatchEvent = event => { for (const callback of events.get(event.type) || []) callback(event); return true; };
  c.window.requestAnimationFrame = c.requestAnimationFrame;
  c.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; this.nodes = new Set(); observers.push(this); }
    observe(node) { this.nodes.add(node); } unobserve(node) { this.nodes.delete(node); } disconnect() { this.nodes.clear(); }
    fire() { const entries = [...this.nodes].filter(node => node.isConnected).map(target => ({ target, isIntersecting: true })); if (entries.length) this.callback(entries, this); }
  };
  c.window.IntersectionObserver = c.IntersectionObserver;
  const actualEnhancer = vm.runInContext(`(function(){${strip(input.autoLoad)};return enhanceAutoLoadMore;})()`, c);
  c.enhanceAutoLoadMore = (button, handler, options) => { loadButtons.push({ button, handler, options }); return actualEnhancer(button, handler, options); };
  c.window.history = {
    get state() { return entries[historyIndex]?.state || null; }, get length() { return entries.length; },
    replaceState(state, title, url) { if (historyIndex < 0) historyIndex = 0; entries[historyIndex] = { state: plain(state), url }; c.window.location.hash = url; },
    pushState(state, title, url) { entries.splice(++historyIndex); entries.push({ state: plain(state), url }); c.window.location.hash = url; },
    back() { assert(historyIndex > 0, "Synthetic browser back has a previous entry"); const entry = entries[--historyIndex]; c.window.location.hash = entry.url; c.window.dispatchEvent({ type: "popstate", state: plain(entry.state) }); },
    forward() { assert(historyIndex + 1 < entries.length, "Synthetic browser forward has a next entry"); const entry = entries[++historyIndex]; c.window.location.hash = entry.url; c.window.dispatchEvent({ type: "popstate", state: plain(entry.state) }); }
  };
  Object.assign(c, vm.runInContext(`(function(){${strip(input.helper)};return {normalizeMediaTrail,captureMediaTrail,mediaBackTarget};})()`, c));
  if (input.range) {
    c.createChannelHistoryState = vm.runInContext(`(function(){${strip(input.range)};return createChannelHistoryState;})()`, c);
    const init = /^const channelHistoryState = .*;$/m.exec(input.app);
    if (init) vm.runInContext(init[0], c);
  }
  const constants = [...input.app.matchAll(/^const (?:FAST_|PHOTO_)[A-Z_]+ = .*;$/gm)].map(match => match[0]);
  const names = [...new Set([...APP_METHODS, "syncModuleChrome", "updateModuleChannelSearch", "scrollToTopInstant",
    "finishAppStartup", "renderRouteLoadingState", "createLoadingRow", "routeLoadingCopy", "cancelScrollRestoreFromKeydown",
    ...[...input.app.matchAll(/^function (\w*ChannelRange\w*)\(/gm)].map(match => match[1])])];
  vm.runInContext(constants.join("\n") + "\n" + names.map(name => appFunction(input.app, name)).join("\n"), c);
  const popstate = /^window\.addEventListener\("popstate", .*;$/m.exec(input.app)?.[0];
  const back = /^els\.viewBack\.addEventListener\("click", goBack\);$/m.exec(input.app)?.[0];
  assert(popstate && back, "Actual browser and UI back entry wiring"); vm.runInContext(`${popstate}\n${back}`, c);
  const cancelEvents = /for \(const eventName of \["pointerdown", "touchstart", "wheel"\]\) \{[\s\S]*?\n\}/.exec(input.app)?.[0];
  assert(cancelEvents, "Actual scroll cancellation event wiring"); vm.runInContext(cancelEvents, c);
  const expose = /  return \{\r?\n    deactivate: resetMangaReaderProgressTracker,/;
  assert(expose.test(input.channel), "Observable factory return boundary");
  const channel = input.channel.replace(expose, "  return {\n    __testPageState: () => channelPageState,\n    deactivate: resetMangaReaderProgressTracker,");
  c.createChannelViews = vm.runInContext(`(function(){${strip(channel)};return createChannelViews;})()`, c);
  h.host.getActiveUrl = () => c.activeUrl;
  // Evaluate the exact host limit object; no fixed limit or synthetic reset.
  const hostCode = appFunction(input.app, "createAndroidModuleHost");
  const limits = /limits: Object\.freeze\((\{[\s\S]*?\n    \})\),/.exec(hostCode)?.[1]; assert(limits, "Actual host limits");
  h.host.limits = vm.runInContext(`(${limits})`, c);
  const update = /updateChannelParams: (\(params = \{\}, navigation = \{\}\) => \{[\s\S]*?\n      \}),/.exec(hostCode)?.[1]; assert(update, "Actual host channel params merger");
  h.host.contentIndex.updateChannelParams = vm.runInContext(`(${update})`, c);
  h.host.contentIndex.updateSearch = c.updateModuleChannelSearch;
  h.host.contentIndex.updateChannelQuery = query => c.updateModuleChannelSearch(c.currentViewParams, query);
  Object.assign(h.host.ui, { refreshChrome: () => c.syncModuleChrome(), renderCurrentView: () => c.renderCurrentView(), renderCurrentViewPreservingScroll: () => c.renderCurrentViewPreservingScroll() });
  h.host.navigation.showView = (...args) => c.showView(...args);
  h.host.recent.record = no; h.host.favorites.onChannelFavoriteChange = no;
  const module = c.mediaFactory({ host: h.host }); c.channelViews = module.api.channelViews;
  const photosFactory = vm.runInContext(`(function(){${strip(input.photos)};return createAndroidModule;})()`, c);
  const photos = photosFactory({ host: h.host });
  module.routes.find(route => route.view === "mediaDetail").render = params => { c.els.viewContent.textContent = `Synthetic detail ${params.id}`; };
  for (const route of [...module.routes, ...photos.routes]) { const render = route.render; route.render = (...args) => { const task = render(...args); pending = Promise.resolve(task); return task; }; }
  const catalog = c.registryApi.androidModuleFallbackCatalog();
  c.androidModuleRegistry = c.registryApi.createRegistry([c.registryApi.normalizeModule(module, catalog.find(value => value.id === "media")), c.registryApi.normalizeModule(photos, catalog.find(value => value.id === "photos"))]);
  c.window.addEventListener("fanhaoViewWillRender", event => calls.renders.push(plain(event.detail)));
  function titles() { return c.els.viewContent.querySelector(".channel-list")?.querySelectorAll("strong").map(node => node.textContent) || []; }
  async function flushScroll() { for (let count = 0; count < 30; count++) { for (const [id, fn] of [...frames]) if (frames.delete(id)) fn(); h.elapse(220); await tick(); } }
  async function settle() { await pending; await tick(); await flushScroll(); assert.equal(calls.errors.length, 0, calls.errors[0]?.stack || "No unhandled real UI callback failure"); }
  return { ...h, c, module, calls, cache, queue, cacheQueue, titles, entries,
    get pending() { return pending; }, settle, flushScroll, loadButtons,
    query: () => new URL(calls.network.at(-1).path, c.activeUrl).searchParams,
    data: (source, params) => services.get(source).itemsPayload(new URL(`/api/image-library/items?${new URLSearchParams(params)}`, source)),
    cards: () => c.els.viewContent.querySelector(".channel-list")?.querySelectorAll("button.channel-card") || [],
    pageState: () => plain((c.androidModuleRegistry.resolve(c.currentView, c.currentViewParams)?.module.api.channelViews || c.channelViews).__testPageState()),
    async open(params, navigation = {}) { c.showView("channel", params, { resetStack: true, ...navigation }); await settle(); },
    footer: () => c.els.viewContent.querySelector(".channel-more"),
    async more() { const button = this.footer(); assert(button && !button.disabled, "Visible enabled pagination footer"); button.click(); await settle(); },
    async automatic() { h.document.footerNear = true; for (const observer of observers) observer.fire(); await flushScroll(); await settle(); },
    async idle() { for (let count = 0; count < 8; count++) { for (const observer of observers) observer.fire(); h.elapse(1000); await flushScroll(); } },
    async card(index) { const card = this.cards()[index]; assert(card, `Rendered card ${index + 1}`); card.click(); await settle(); },
    async back(kind = "button") { if (kind === "browser") c.window.history.back(); else if (kind === "apply") c.applyBackState(); else c.els.viewBack.click(); await settle(); },
    async restore(state) { c.window.dispatchEvent({ type: "popstate", state }); await settle(); },
    setSource(source) { c.activeUrl = source; },
    setScroll(value) { c.window.scrollTo({ top: value }); },
    async refresh() { await c.renderCurrentView(); await settle(); }
  };
}

const tests = [], test = (name, run) => tests.push({ name, run });
const A = "https://synthetic-a.invalid", B = "https://synthetic-b.invalid";
const requestRange = h => ({ offset: Number(h.query().get("offset")), limit: Number(h.query().get("limit")) });
function tail(h, mode, options = {}) { return plain(h.data(A, { mode, sort: "title", offset: 36, limit: 36, ...options })); }
function seedTail(h, mode, data = tail(h, mode)) {
  const path = h.calls.network.at(-1).path.replace("offset=0", "offset=36");
  h.cache.set(JSON.stringify([A, path]), { updatedAt: "synthetic", payload: data }); return data;
}
function assertErrorFooter(h) {
  assert(h.footer(), "Failure must retain a reachable pagination footer"); assert.equal(h.footer().textContent, "加载失败，点击重试");
  assert.equal(h.footer().disabled, false); assert.equal(h.loadButtons.at(-1).options.auto, false, "Failure cannot rearm automatic loading");
}
for (const mode of ["movie", "tv", "media"]) {
  test(`${mode}: pending append preserves36 and disables footer without automatic requests`, async input => {
    const h = harness(input); await h.open({ mode, sort: "title" }); const before = h.titles(); assert.equal(before.length, 36);
    const hold = deferred(); h.queue.push(hold); h.footer().click(); await tick();
    assert.deepEqual(h.titles(), before, "Pending append must preserve readable cards");
    assert.equal(h.footer().disabled, true); assert.equal(h.footer().textContent, "正在接着加载"); assert.equal(h.footer().dataset.autoLoad, undefined);
    assert.deepEqual(requestRange(h), { offset: 36, limit: 36 }); assert.equal(h.c.channelLimit, 72);
    h.document.footerNear = true; await h.idle(); assert.equal(h.calls.network.length, 2); assert.equal(h.c.channelLimit, 72);
    h.document.footerNear = false; hold.resolve(tail(h, mode)); await h.settle();
    assert.equal(h.titles().length, 72); assert.equal(h.footer().disabled, false); assert.equal(h.footer().dataset.autoLoad, "ready");
  });
  test(`${mode}: miss/error/repeated real retries retain36 and same outstanding range`, async input => {
    const h = harness(input); await h.open({ mode, sort: "title" }); const before = h.titles(); h.queue.push(Error("Synthetic offline")); await h.more();
    assert.deepEqual(h.titles(), before, "Failed append must retain readable cards"); assertErrorFooter(h);
    for (let attempt = 0; attempt < 3; attempt++) {
      const count = h.calls.network.length; h.document.footerNear = true; await h.idle(); assert.equal(h.calls.network.length, count, "Error must wait for explicit retry");
      h.queue.push(Error(`Synthetic retry failure${attempt}`)); await h.more();
      assert.deepEqual(h.titles(), before); assertErrorFooter(h); assert.equal(h.c.channelLimit, 72); assert.deepEqual(requestRange(h), { offset: 36, limit: 36 });
    }
    h.document.footerNear = false; await h.more(); assert.equal(h.titles().length, 72); assert.equal(h.c.channelLimit, 72);
    assert.equal(h.footer().dataset.autoLoad, "ready"); assert.notEqual(h.loadButtons.at(-1).options.auto, false);
    const count = h.calls.network.length; await h.automatic();
    const next = new URL(h.calls.network[count].path, A).searchParams; assert.equal(next.get("offset"), "72"); assert.equal(next.get("limit"), "36");
    assert(h.titles().length > 72, "Successful recovery restores real automatic continuation");
  });
  test(`${mode}: cached append preserves72; repeated failure retains manual retry range`, async input => {
    const h = harness(input); await h.open({ mode, sort: "title" }); const cached = seedTail(h, mode); const hold = deferred(); h.queue.push(hold);
    h.footer().click(); await tick(); assert.equal(h.titles().length, 72); assert.equal(h.footer().disabled, true);
    hold.reject(Error("Synthetic failed fresh tail")); await h.settle(); assert.equal(h.titles().length, 72); assertErrorFooter(h);
    for (let attempt = 0; attempt < 2; attempt++) {
      h.queue.push(Error("Synthetic retry offline")); await h.more();
      assert.equal(h.titles().length, 72); assertErrorFooter(h); assert.equal(h.c.channelLimit, 72); assert.deepEqual(requestRange(h), { offset: 36, limit: 36 }, "Retry must keep unresolved request, not reset into normal prefix refresh");
    }
    h.queue.push(plain(cached)); await h.more(); assert.equal(h.titles().length, 72); assert.equal(h.footer().disabled, false); assert.equal(h.footer().dataset.autoLoad, "ready", "Identical fresh tail must replace loading footer");
    assert.equal(h.pageState().retry, undefined, "Successful fresh request clears unresolved paging metadata");
  });
}

test("cached tail considered complete still offers manual retry until verified fresh", async input => {
  const h = harness(input); await h.open({ mode: "movie", sort: "title" }); const cached = tail(h, "movie"); cached.total = 72; seedTail(h, "movie", cached);
  h.queue.push(Error("Synthetic fresh unavailable")); await h.more(); assert.equal(h.titles().length, 72); assertErrorFooter(h);
  h.queue.push(Error("Synthetic retry unavailable")); await h.more(); assertErrorFooter(h); assert.deepEqual(requestRange(h), { offset: 36, limit: 36 });
  h.queue.push(cached); await h.more(); assert.equal(h.titles().length, 72); assert.equal(h.footer(), null, "Complete verified payload has no unnecessary continuation");
});

test("fresh retry replaces cached tail identities without contaminating base prefix", async input => {
  const h = harness(input); await h.open({ mode: "movie", sort: "title" }); const base = h.titles(), cached = tail(h, "movie");
  cached.items[0].id = "stale-cached-tail-id"; cached.items[0].movieMetadata.title = "STALE SYNTHETIC TAIL"; seedTail(h, "movie", cached);
  h.queue.push(Error("offline")); await h.more(); assert(h.titles().includes("STALE SYNTHETIC TAIL")); assertErrorFooter(h);
  const fresh = tail(h, "movie"); fresh.items[0].id = "current-fresh-tail-id"; fresh.items[0].movieMetadata.title = "FRESH SYNTHETIC TAIL";
  h.queue.push(fresh); await h.more(); assert.equal(h.titles().length, 72); assert.deepEqual(h.titles().slice(0, 36), base);
  assert.equal(h.titles().includes("STALE SYNTHETIC TAIL"), false); assert.equal(h.titles().includes("FRESH SYNTHETIC TAIL"), true);
});

for (const outcome of ["success", "failure"]) for (const change of ["query", "source"]) test(`pending append ${outcome} after ${change} change cannot repaint/retry old route`, async input => {
  const h = harness(input); await h.open({ mode: "movie", sort: "title" }); const hold = deferred(); h.queue.push(hold); h.footer().click(); await tick(); const oldTask = h.pending;
  if (change === "source") h.setSource(B);
  await h.open({ mode: "movie", sort: "title", ...(change === "query" ? { query: "Movie 001" } : {}) }); const titles = h.titles(), state = h.pageState();
  if (outcome === "success") hold.resolve(tail(h, "movie")); else hold.reject(Error("STALE APPEND ERROR"));
  await oldTask; await h.settle(); assert.deepEqual(h.titles(), titles); assert.deepEqual(h.pageState(), state); assert.equal(h.c.channelLimit, 36);
  assert.equal(h.c.els.viewContent.textContent.includes("STALE APPEND ERROR"), false); assert.equal(h.footer()?.textContent === "加载失败，点击重试", false);
});

test("obsolete error footer cannot restart a new query through click or delayed retry callback", async input => {
  const h = harness(input); await h.open({ mode: "movie", sort: "title" }); h.queue.push(Error("offline")); await h.more();
  const button = h.footer(), retry = h.loadButtons.at(-1).handler; assertErrorFooter(h);
  await h.open({ mode: "movie", sort: "size", query: "Movie 001" }); const count = h.calls.network.length;
  button.click(); await retry(); await h.settle(); assert.equal(h.calls.network.length, count); assert.equal(h.c.channelLimit, 36);
});

test("same-route explicit reopening resets target and cannot inherit failed72 range", async input => {
  const h = harness(input); await h.open({ mode: "movie", sort: "title" }); seedTail(h, "movie"); h.queue.push(Error("offline")); await h.more(); assertErrorFooter(h);
  await h.open({ mode: "movie", sort: "title" }); assert.equal(h.c.channelLimit, 36); assert.deepEqual(requestRange(h), { offset: 0, limit: 36 }); assert.equal(h.titles().length, 36);
});

test("source-only change during append cannot paint or claim old request state", async input => {
  const h = harness(input); await h.open({ mode: "movie", sort: "title" }); const hold = deferred(); h.queue.push(hold); h.footer().click(); await tick(); const oldTask = h.pending, state = h.pageState();
  h.setSource(B); h.c.els.viewContent.textContent = "REPLACEMENT SOURCE"; hold.resolve(tail(h, "movie")); await oldTask; await tick();
  assert.equal(h.c.els.viewContent.textContent, "REPLACEMENT SOURCE"); assert.deepEqual(h.pageState(), state);
});

for (const [mode, size] of [["photo", 24], ["manga", 36]]) test(`${mode}: actual photos adapter and shared renderer/default-limit path preserve cards/retry`, async input => {
  const h = harness(input);
  const rows = (offset, limit) => ({ mode, photoView: "albums", query: "", sort: "title", total: size * 3, facets: {},
    items: Array.from({ length: limit }, (_, index) => ({ id: `synthetic-${mode}-${offset + index}`, type: mode === "photo" ? "photoSet" : "manga",
      title: `Synthetic ${mode} ${offset + index}`, size: 100, imageCount: 2, chapterCount: 2, doneChapterCount: 2 })) });
  h.queue.push(rows(0, size)); await h.open({ mode, photoView: "albums", category: "all", sort: "title" });
  assert.equal(h.c.androidModuleRegistry.resolve(h.c.currentView, h.c.currentViewParams).module.id, "photos", "Shared branch is owned and rendered by the actual photos adapter");
  const cards = () => h.c.els.viewContent.querySelectorAll("button.channel-card").map(node => node.textContent); const before = cards(); assert.equal(before.length, size);
  const hold = deferred(); h.queue.push(hold); h.footer().click(); await tick(); assert.deepEqual(cards(), before); assert.equal(h.footer().disabled, true);
  hold.reject(Error("Synthetic shared paging unavailable")); await h.settle(); assert.deepEqual(cards(), before); assertErrorFooter(h);
  h.queue.push(Error("Synthetic explicit retry failure")); await h.more(); assert.deepEqual(cards(), before); assertErrorFooter(h); assert.equal(h.c.channelLimit, size * 2);
  assert.deepEqual(requestRange(h), { offset: size, limit: size }); h.queue.push(rows(size, size)); await h.more(); assert.equal(cards().length, size * 2);
});

const mutations = [
  { name: "append loses existing-page treatment", target: "movie: pending append", from: "const loadingMore = Boolean(currentPage && offset > 0);", to: "const loadingMore = false;" },
  { name: "pending footer is normal autoload", target: "movie: pending append", from: 'const pendingPaging = loadingMore ? { status: "loading" } : {};', to: "const pendingPaging = {};" },
  { name: "error branch drops explicit recovery", target: "movie: miss/error", from: "if (loadingMore) {", to: "if (false) {" },
  { name: "error retry reenables automatic loading", target: "movie: miss/error", from: 'paging.retry, { auto: false }', to: 'paging.retry, { auto: true }' },
  { name: "load-more wrapper drops auto:false forwarding", target: "movie: miss/error", from: "auto: options.auto,", to: "/* auto option lost */" },
  { name: "retry increases target again", target: "movie: miss/error", from: "retry: () => isCurrent() ? renderCurrentViewPreservingScroll() : undefined", to: "retry: () => isCurrent() ? (increaseChannelLimit(48), renderCurrentViewPreservingScroll()) : undefined" },
  { name: "cached target completion discards outstanding request", target: "movie: cached append", from: "const retryPage = currentPage && channelPageState.retry?.targetLimit === limit ? channelPageState.retry : null;", to: "const retryPage = null;" },
  { name: "retry merges cached stale tail rather than original base", target: "fresh retry replaces cached tail", from: "const basePage = retryPage ? retryPage.base : currentPage;", to: "const basePage = currentPage;" },
  { name: "same-signature shortcut leaves loading footer", target: "movie: cached append", from: "if (!loadingMore && renderedCache && channelDataSignature(mergedData) === renderedCacheSignature)", to: "if (renderedCache && channelDataSignature(mergedData) === renderedCacheSignature)" },
  { name: "cached complete hides retry footer", target: "cached tail considered complete", from: 'else if (paging.status === "error")', to: 'else if (paging.status === "error" && items.length < total)' },
  { name: "retry ignores changed target limit", target: "same-route explicit reopening", from: "currentPage && channelPageState.retry?.targetLimit === limit ? channelPageState.retry : null", to: "currentPage && channelPageState.retry ? channelPageState.retry : null" },
  { name: "source-only change loses request fence", target: "source-only change", from: "const isCurrent = () => isActive() && getActiveUrl() === activeUrl;", to: "const isCurrent = () => isActive();" },
  { name: "successful fresh response retains stale retry metadata", target: "movie: cached append", from: "channelPageState = { key: pageKey, data: mergedData };", to: "channelPageState = { key: pageKey, data: mergedData, ...(retryPage ? { retry: retryPage } : {}) };" }
];
let passed = 0, failed = 0, oldRejected = 0, mutantRejected = 0;
for (const test of tests) { try { await test.run(sources); passed++; console.log(`PASS ${test.name}`); } catch (error) { failed++; console.error(`FAIL ${test.name}\n${error.stack}`); } }
for (const name of ["movie: pending append", "tv: pending append", "media: pending append", "movie: miss/error", "tv: miss/error", "media: miss/error"]) {
  try {
    const selected = tests.find(test => test.name.startsWith(name)); assert(selected); let failure;
    try { await selected.run({ ...sources, app: legacy.sources.app.source, channel: legacy.sources.channel.source, autoLoad: legacy.sources.autoLoad.source }); } catch (error) { failure = error; }
    assert(failure instanceof assert.AssertionError, `Frozen83 must fail a real safety assertion, not setup: ${failure?.stack || "unexpected pass"}`);
    assert.match(failure.message, /(?:Pending|Failed) append must (?:preserve|retain) readable cards/); oldRejected++; console.log(`REJECT frozen83 ${name}`);
  } catch (error) { failed++; console.error(error.stack); }
}
if (!failed) for (const mutation of mutations) {
  try {
    const channel = sources.channel.replace(mutation.from, mutation.to); assert.notEqual(channel, sources.channel, `Mutant changes source: ${mutation.name}`);
    const selected = tests.find(test => test.name.startsWith(mutation.target)); assert(selected); let failure;
    try { await selected.run({ ...sources, channel }); } catch (error) { failure = error; }
    assert(failure instanceof assert.AssertionError, `Mutant must fail a behavior assertion: ${mutation.name}\n${failure?.stack || "unexpected pass"}`);
    mutantRejected++; console.log(`REJECT mutant ${mutation.name}`);
  } catch (error) { failed++; console.error(error.stack); }
}
console.log(`Media paging recovery: ${passed}/${tests.length} current; ${oldRejected}/6 frozen83 safety assertions; ${mutantRejected}/${mutations.length} mutants; ${failed} failures.`);
for (const key of ["app", "channel", "autoLoad"]) console.log(`${key} SHA256 ${createHash("sha256").update(sources[key]).digest("hex")}`);
console.log("Boundary: actual shell/channel/media/auto-load/list-selection methods; controlled DOM/layout/history/observer/cache/HTTP. No device, real service, user media or database.");
process.exitCode = failed ? 1 : 0;
