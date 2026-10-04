import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createHash, webcrypto } from "node:crypto";
import { appFunction, createGalleryHarness } from "./fixtures/android-gallery-navigation-harness.mjs";
import { formatBytes, formatDate, formatNumber, formatTime, normalizeUrl } from "../android-client/www/js/format.js";
import { absoluteUrl } from "../android-client/www/js/image.js";
import { createImageLibraryService } from "../src/modules/content-index/server/image-library-service.js";

// Executes the real shell showView/reset/default limits/history/back/render and
// scroll-restoration methods, complete media adapter and channel factory, and
// the server's real list selection over synthetic rows. DOM layout/history,
// cache, HTTP transport, IntersectionObserver and detail-body rendering remain
// explicit boundaries. No real browser/device/library/database/service is used.
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const sources = Object.fromEntries(Object.entries({
  app: "android-client/www/app.js", channel: "android-client/www/platform/content-index/channel-views.js",
  media: "android-client/www/modules/media/android-module.js", helper: "android-client/www/js/media-navigation-state.js",
  registry: "android-client/www/js/android-module-registry.js", navigation: "android-client/www/js/module-navigation.js",
  index: "android-client/www/index.html"
}).map(([key, file]) => [key, read(file)]));
const rangePath = new URL("../android-client/www/js/channel-history-state.js", import.meta.url);
sources.range = fs.existsSync(rangePath) ? fs.readFileSync(rangePath, "utf8") : "";
const legacy = JSON.parse(read("tools/fixtures/android-media-return-range-before-fix.json"));
assert.equal(createHash("sha256").update(JSON.stringify(legacy.sources)).digest("hex"), "a6e6d5a4c1062a7f433005c555f20086883b3a8dd0c7cf09d14908a61c629b7f", "Frozen pre-fix source checksum");
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
  const index = { scannedAt: "2026-08-01T00:00:00Z", photoSets: [], mediaItems: items };
  return createImageLibraryService({
    clampInteger: (value, fallback, min, max) => Math.min(max, Math.max(min, Number.parseInt(value, 10) || fallback)),
    getImageLibraryIndex: () => index,
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
  for (const name of ["viewTitle", "viewMeta", "viewKicker", "contentPanel", "moduleChrome", "viewBack", "statusCard", "previewSection", "continueSection", "quickStrip"]) c.els[name] = h.document.createElement("div");
  h.document.body.append(c.els.viewContent, c.els.viewTitle, c.els.viewMeta, c.els.viewKicker, c.els.contentPanel, c.els.moduleChrome, c.els.viewBack);
  const calls = { network: [], cacheReads: [], cacheWrites: [], renders: [], scrolls: [] }, cache = new Map(), queue = [], cacheQueue = [], loadButtons = [];
  let pending = Promise.resolve(), frameId = 0; const frames = new Map(), events = new Map(), entries = []; let historyIndex = -1;
  Object.assign(c, {
    URL, URLSearchParams, AbortController, crypto: webcrypto, formatBytes, formatDate, formatNumber, formatTime, absoluteUrl,
    activeUrl: "https://synthetic-a.invalid", normalizeUrl,
    viewRenderToken: 0, activeViewController: null, pendingScrollRestore: null, scrollRestoreIntent: 0,
    peopleLimit: 48, worksLimit: 40, channelLimit: 36, photoImageLimit: 12, mangaImageLimit: 8,
    library: {}, HISTORY_MARKER: "synthetic-history", mediaViewer: { close: () => false }, channelViews: null,
    cacheAgeText: () => "synthetic", isChannelFavorite: () => false, toggleChannelFavorite: () => ({ favorite: true, items: [] }),
    photoCatalogCollections: items => items, loadPreviewImage: no,
    enhanceAutoLoadMore: (button, handler) => { loadButtons.push({ button, handler }); return button; },
    fetchJson: async (source, path, options) => {
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
  c.window.dispatchEvent = event => { for (const callback of events.get(event.type) || []) callback(event); return true; };
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
  const names = [...new Set([...Object.keys(legacy.sources.app.functions), "syncModuleChrome", "updateModuleChannelSearch", "scrollToTopInstant",
    "finishAppStartup", "renderRouteLoadingState", "createLoadingRow", "routeLoadingCopy", "cancelScrollRestoreFromKeydown",
    ...[...input.app.matchAll(/^function (\w*ChannelRange\w*)\(/gm)].map(match => match[1])])];
  vm.runInContext(constants.join("\n") + "\n" + names.map(name => appFunction(input.app, name)).join("\n"), c);
  const popstate = /^window\.addEventListener\("popstate", .*;$/m.exec(input.app)?.[0];
  const back = /^els\.viewBack\.addEventListener\("click", goBack\);$/m.exec(input.app)?.[0];
  assert(popstate && back, "Actual browser and UI back entry wiring"); vm.runInContext(`${popstate}\n${back}`, c);
  const cancelEvents = /for \(const eventName of \["pointerdown", "touchstart", "wheel"\]\) \{[\s\S]*?\n\}/.exec(input.app)?.[0];
  assert(cancelEvents, "Actual scroll cancellation event wiring"); vm.runInContext(cancelEvents, c);
  const expose = /  return \{\r?\n(?=    deactivate:)/;
  assert(expose.test(input.channel), "Observable factory return boundary");
  const channel = input.channel.replace(expose, "  return {\n    __testPageState: () => channelPageState,\n");
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
  module.routes.find(route => route.view === "mediaDetail").render = params => { c.els.viewContent.textContent = `Synthetic detail ${params.id}`; };
  for (const route of module.routes) { const render = route.render; route.render = (...args) => { const task = render(...args); pending = Promise.resolve(task); return task; }; }
  c.androidModuleRegistry = c.registryApi.createRegistry([c.registryApi.normalizeModule(module, c.registryApi.androidModuleFallbackCatalog().find(value => value.id === "media"))]);
  c.window.addEventListener("fanhaoViewWillRender", event => calls.renders.push(plain(event.detail)));
  function titles() { return c.els.viewContent.querySelector(".channel-list")?.querySelectorAll("strong").map(node => node.textContent) || []; }
  async function flushScroll() { for (let count = 0; count < 30; count++) { for (const [id, fn] of [...frames]) if (frames.delete(id)) fn(); h.elapse(220); await tick(); } }
  async function settle() { await pending; await tick(); await flushScroll(); }
  return { ...h, c, module, calls, cache, queue, cacheQueue, titles, entries,
    get pending() { return pending; }, settle, flushScroll,
    query: () => new URL(calls.network.at(-1).path, c.activeUrl).searchParams,
    data: (source, params) => services.get(source).itemsPayload(new URL(`/api/image-library/items?${new URLSearchParams(params)}`, source)),
    cards: () => c.els.viewContent.querySelector(".channel-list")?.querySelectorAll("button.channel-card") || [],
    pageState: () => plain(c.channelViews.__testPageState()),
    async open(params, navigation = {}) { c.showView("channel", params, { resetStack: true, ...navigation }); await settle(); },
    async more() { assert(loadButtons.length); await loadButtons.at(-1).handler(); await settle(); },
    async card(index) { const card = this.cards()[index]; assert(card, `Rendered card ${index + 1}`); card.click(); await settle(); },
    async back(kind = "button") { if (kind === "browser") c.window.history.back(); else if (kind === "apply") c.applyBackState(); else c.els.viewBack.click(); await settle(); },
    async restore(state) { c.window.dispatchEvent({ type: "popstate", state }); await settle(); },
    setSource(source) { c.activeUrl = source; },
    setScroll(value) { c.window.scrollTo({ top: value }); },
    async refresh() { await c.renderCurrentView(); await settle(); }
  };
}

const tests = [], test = (name, run) => tests.push({ name, run });
for (const mode of ["movie", "tv"]) for (const back of ["button", "browser", "apply"]) test(`${mode} 36→72→child→${back} keeps all 72 after refresh`, async input => {
  const h = harness(input); await h.open({ mode, sort: "title" }); assert.equal(h.titles().length, 36);
  await h.more(); assert.equal(h.c.channelLimit, 72); assert.equal(h.titles().length, 72); assert.equal(h.query().get("offset"), "36");
  const before = h.titles(); h.setScroll(6500); await h.card(64); await h.back(back);
  assert.equal(h.titles().length, 72, "Returned refreshed real DOM must retain all 72 cards");
  assert.equal(h.c.channelLimit, 72, "Return must restore loaded range before actual render");
  assert.equal(h.query().get("limit"), "72", "Fresh return requests retained prefix, not first36"); assert.equal(h.query().get("offset"), "0");
  assert.deepEqual(h.titles(), before, "Returned real DOM retains selected card65"); assert.equal(h.c.window.scrollY, 6500, "Synthetic layout can restore old scroll after refreshed DOM");
});

for (const back of ["button", "browser"]) test(`TV catalog72→episodes72→detail→${back} restores both distinct ranges`, async input => {
  const h = harness(input); await h.open({ mode: "tv", query: "Series", sort: "title", category: "Synthetic category" }); await h.more();
  const catalog = h.titles(); h.setScroll(6500); await h.card(64); assert.equal(h.route().params.tvView, "episodes");
  assert.equal(h.titles().length, 36); await h.more(); const episodes = h.titles(), route = h.route().params;
  assert.equal(episodes.length, 72); h.setScroll(6400); await h.card(64);
  await h.back(back); assert.deepEqual(h.titles(), episodes); assert.equal(h.c.window.scrollY, 6400); assert.equal(h.route().params.seriesKey, route.seriesKey);
  if (back === "button") {
    const button = h.c.els.viewContent.querySelector(".channel-tv-series-row")?.querySelector("button"); assert(button, "Real Return to catalog button"); button.click(); await h.settle();
  } else await h.back("browser");
  assert.deepEqual(h.titles(), catalog); assert.equal(h.c.window.scrollY, 6500); assert.equal(h.query().get("sort"), "title");
  assert.equal(h.query().get("q"), "Series"); assert.equal(h.query().get("category"), "Synthetic category");
});

test("actual increaseChannel checkpoints current history for back then forward without leaving via showView", async input => {
  const h = harness(input); await h.open({ mode: "movie", sort: "title" }); await h.open({ mode: "tv", sort: "title" }); await h.more();
  const old = h.titles(), checkpoint = plain(h.c.window.history.state);
  assert.equal(typeof checkpoint.channelRange, "string", "Range checkpoint stored in current history entry");
  await h.back("browser"); assert.equal(h.route().params.mode, "movie");
  h.c.window.history.forward(); await h.settle(); assert.equal(h.c.channelLimit, 72); assert.deepEqual(h.titles(), old);
});

for (const change of [{ query: "Movie" }, { sort: "size" }, { category: "Other category" }, { mode: "tv" }]) test(`changed route ${JSON.stringify(change)} resets to default36`, async input => {
  const h = harness(input); await h.open({ mode: "movie", sort: "title" }); await h.more(); const token = h.c.captureChannelRange();
  h.host.contentIndex.updateChannelParams(change); await h.settle(); assert.equal(h.c.channelLimit, 36); assert.equal(h.query().get("offset"), "0");
  h.c.restoreChannelRange(token); assert.equal(h.c.channelLimit, 36, "Token for another route cannot expand new query/order/category/mode");
});

test("legacy and forged history ranges cannot inject request limits", async input => {
  for (const channelRange of [undefined, "unknown-token", 12000, { limit: 12000 }, [12000], "", Infinity]) {
    const h = harness(input); await h.open({ mode: "movie", sort: "title" }); await h.more();
    await h.restore({ marker: h.c.HISTORY_MARKER, view: "channel", params: { mode: "movie", sort: "title", limit: 999999 }, scrollY: 0, channelRange, channelLimit: 999999 });
    assert.equal(h.c.channelLimit, 36); assert.equal(h.query().get("limit"), "36");
  }
});

test("new session/hash/last-view cannot resurrect transient range metadata", async input => {
  const h = harness(input); await h.open({ mode: "movie", sort: "title" }); await h.more(); const state = plain(h.c.window.history.state);
  const next = harness(input, { storage: new Map(h.storage), hash: h.c.window.location.hash });
  await next.restore(state); assert.equal(next.c.channelLimit, 36); assert.equal(next.titles().length, 36);
  assert.equal(next.c.readLastViewState().params.channelRange, undefined); assert.equal(next.c.readViewStateFromHash().params.channelRange, undefined);
  assert.equal(h.c.window.location.hash.includes("channelRange"), false); assert.equal([...h.storage.values()].join("\n").includes(state.channelRange), false);
});

test("settings history with same view but different params restores matching range before render", async input => {
  const h = harness(input); await h.open({ mode: "movie", query: "Movie", sort: "title" }); await h.more(); const state = plain(h.c.window.history.state);
  await h.open({ mode: "tv", sort: "title" }); await h.restore({ ...state, settingsOpen: true });
  assert.equal(h.route().params.mode, "movie"); assert.equal(h.route().params.query, "Movie"); assert.equal(h.c.channelLimit, 72); assert.equal(h.titles().length, 72);
});

test("source change rejects saved range and never paints other server cached72", async input => {
  const h = harness(input); await h.open({ mode: "movie", sort: "title" }); await h.more(); await h.card(64);
  h.setSource("https://synthetic-b.invalid"); const hold = deferred(); h.queue.push(hold); h.c.els.viewBack.click(); await tick();
  assert.equal(h.titles().some(title => title.startsWith("A ")), false, "No stale A prefix painted while B is pending");
  assert.equal(h.query().get("offset"), "0"); assert.equal(h.query().get("limit"), "36");
  hold.resolve(h.data(h.c.activeUrl, { mode: "movie", sort: "title", limit: 36 })); await h.settle();
  assert.equal(h.titles().length, 36); assert(h.titles().every(title => title.startsWith("B ")));
});

test("direct source switch offline does not reuse A in-memory list or offset", async input => {
  const h = harness(input); await h.open({ mode: "movie", sort: "title" }); await h.more();
  h.setSource("https://synthetic-b.invalid"); const hold = deferred(); h.queue.push(hold); const task = h.c.renderCurrentView(); await tick();
  assert.equal(h.titles().length, 0, "In-memory page key must bind its source"); assert.equal(h.query().get("offset"), "0");
  hold.reject(Error("Synthetic B offline")); await task; await h.settle(); assert.equal(h.titles().length, 0); assert.match(h.c.els.viewContent.textContent, /Synthetic B offline/);
});

for (const stage of ["cache", "fresh", "error"]) test(`source changes during pending ${stage}: no late UI or page-state mutation`, async input => {
  const h = harness(input), hold = deferred();
  if (stage === "cache") h.cacheQueue.push(hold); else h.queue.push(hold);
  h.c.showView("channel", { mode: "movie", sort: "title" }); await tick(); const oldTask = h.pending;
  h.setSource("https://synthetic-b.invalid"); h.c.els.viewContent.textContent = "B WAITING";
  const data = h.data("https://synthetic-a.invalid", { mode: "movie", sort: "title", limit: 36 });
  if (stage === "error") hold.reject(Error("STALE A ERROR")); else hold.resolve(stage === "cache" ? { updatedAt: "synthetic", payload: data } : data);
  await oldTask; await tick(); assert.equal(h.c.els.viewContent.textContent, "B WAITING"); assert.equal(h.pageState(), null, "Late old source cannot claim shared page state");
  if (stage === "cache") assert.equal(h.calls.network.length, 0);
  else if (stage === "fresh") assert.equal(h.calls.cacheWrites.length, 0, "Cancelled source response cannot overwrite its cache");
  await h.refresh(); assert.equal(h.query().get("offset"), "0"); assert(h.titles().every(title => title.startsWith("B ")));
});

for (const cancel of [false, true]) test(`async fresh return ${cancel ? "respects user wheel cancellation" : "rearms saved6500 after refreshed DOM"}`, async input => {
  const h = harness(input); await h.open({ mode: "tv", sort: "title" }); await h.more(); h.setScroll(6500); await h.card(64);
  const hold = deferred(); h.queue.push(hold); h.c.els.viewBack.click(); await tick();
  await h.flushScroll(); assert.equal(h.c.pendingScrollRestore, null, "Initial bounded retries exhausted while catalog fetch is pending"); assert.equal(h.c.window.scrollY, 0);
  if (cancel) h.c.window.dispatchEvent({ type: "wheel" });
  hold.resolve(h.data(h.c.activeUrl, { mode: "tv", sort: "title", limit: 72 })); await h.settle();
  assert.equal(h.titles().length, 72); assert.equal(h.c.window.scrollY, cancel ? 0 : 6500);
});

test("manga slow-loading timer cannot mutate a page after active source changes", async input => {
  const h = harness(input), hold = deferred(); h.cacheQueue.push(hold);
  const task = h.c.channelViews.renderChannel({ mode: "manga" }, () => true); await tick();
  const detail = h.c.els.viewContent.querySelector("[data-manga-loading-detail]"); assert(detail); const text = detail.textContent;
  h.setSource("https://synthetic-b.invalid"); h.elapse(2200); assert.equal(detail.textContent, text, "Old-source slow timer must not paint");
  hold.resolve(null); await task; assert.equal(h.calls.network.length, 0); assert.equal(h.pageState(), null);
});

test("offline return retains cached72 while truthful fresh shrink renders current smaller total", async input => {
  const h = harness(input); await h.open({ mode: "movie", sort: "title" }); await h.more(); const old = h.titles(); await h.card(64);
  h.queue.push(Error("Synthetic offline")); await h.back(); assert.deepEqual(h.titles(), old); assert.equal(h.c.channelLimit, 72);
  const fresh = h.data(h.c.activeUrl, { mode: "movie", sort: "title", limit: 20 }); fresh.total = 20;
  h.queue.push(fresh); await h.refresh(); assert.equal(h.titles().length, 20); assert.deepEqual(h.titles(), fresh.items.map(item => item.movieMetadata.title));
});

test("full range helper rejects malformed inputs, isolates routes/sources/sessions, and bounds retention", async input => {
  assert(input.range, "Actual production range module"); const context = vm.createContext({ crypto: webcrypto });
  const factory = vm.runInContext(`(function(){${strip(input.range)};return createChannelHistoryState;})()`, context), store = factory();
  for (const value of [0, -1, NaN, Infinity, 1.5, "72", {}, [], Number.MAX_SAFE_INTEGER + 1]) assert.equal(store.capture("A", "#route", value), "");
  for (const [source, route] of [["", "#route"], [null, "#route"], ["A", ""], ["A", {}]]) assert.equal(store.capture(source, route, 72), "");
  const token = store.capture("A", "#route", 72); assert.equal(store.capture("A", "#route", 72), token);
  assert.equal(store.restore(token, "A", "#route", 36), 72); assert.equal(store.restore(token, "B", "#route", 36), 36); assert.equal(store.restore(token, "A", "#other", 36), 36);
  assert.equal(factory().restore(token, "A", "#route", 36), 36); assert.equal(store.restore({ limit: 999999 }, "A", "#route", 36), 36);
  const big = store.capture("A", "#big", 14400); assert.equal(store.restore(big, "A", "#big", 36), 14400, "No arbitrary12000 history truncation (not a server paging guarantee)");
  assert.equal(store.restore(token, "A", "#route", 720), 720, "Retained small limit never shrinks a larger current default");
  for (let index = 0; index < 128; index++) store.capture("A", `#new-${index}`, 36);
  assert.equal(store.restore(token, "A", "#route", 36), 36); assert.equal(store.restore(big, "A", "#big", 36), 36);
});

test("capture only matching current channel; non-channel navigation does not restore other limit families", async input => {
  const h = harness(input); await h.open({ mode: "movie", sort: "title" }); await h.more(); const token = h.c.captureChannelRange();
  assert.equal(h.c.captureChannelRange("channel", { mode: "tv" }), ""); assert.equal(h.c.captureChannelRange("people", {}), "");
  h.c.currentView = "mediaDetail"; h.c.currentViewParams = { mode: "movie", id: "synthetic" }; h.c.resetViewLimitsForView();
  const limits = [h.c.peopleLimit, h.c.worksLimit, h.c.channelLimit, h.c.photoImageLimit, h.c.mangaImageLimit]; h.c.restoreChannelRange(token);
  assert.deepEqual([h.c.peopleLimit, h.c.worksLimit, h.c.channelLimit, h.c.photoImageLimit, h.c.mangaImageLimit], limits);
  for (const mode of ["photo", "manga"]) {
    h.c.currentView = "channel"; h.c.currentViewParams = h.c.sanitizeViewParams("channel", { mode }); h.c.resetViewLimitsForView();
    const initial = h.c.channelLimit; h.host.limits.increaseChannel(48); const retained = h.c.channelLimit, own = h.c.captureChannelRange();
    h.c.resetViewLimitsForView(); assert.equal(h.c.channelLimit, initial); h.c.restoreChannelRange(own); assert.equal(h.c.channelLimit, retained);
  }
});

for (const [mode, detail, initial, retained] of [["photo", "photoDetail", 24, 48], ["manga", "mangaDetail", 36, 72]]) test(`${mode} state-only: actual defaults/host increase→child→stackback restores range`, async input => {
  const h = harness(input), c = h.c;
  // Only these unrelated module render leaves are doubles; this case asserts
  // shared shell range state, not photo/manga catalog rendering or reader state.
  const definitions = c.registryApi.androidModuleFallbackCatalog();
  const photos = c.registryApi.normalizeModule({ rootViews: ["channel"], routes: [
    { view: "channel", match: params => ["photo", "manga"].includes(params.mode), render: () => { c.els.viewContent.textContent = "State-only catalog render boundary"; } },
    { view: detail, render: () => { c.els.viewContent.textContent = "State-only detail render boundary"; } }
  ] }, definitions.find(value => value.id === "photos"));
  c.androidModuleRegistry = c.registryApi.createRegistry([photos, c.registryApi.normalizeModule(h.module, definitions.find(value => value.id === "media"))]);
  await h.open({ mode }); assert.equal(c.channelLimit, initial); h.host.limits.increaseChannel(48); assert.equal(c.channelLimit, retained);
  c.showView(detail, { id: "synthetic-only" }, { push: true }); await h.settle(); assert.equal(c.viewStack.length, 1);
  assert.equal(typeof c.viewStack[0].channelRange, "string"); await h.back();
  assert.equal(h.route().view, "channel"); assert.equal(h.route().params.mode, mode); assert.equal(c.channelLimit, retained);
  assert.equal(c.worksLimit, c.defaultWorksLimitForView("channel")); assert.equal(c.photoImageLimit, 12); assert.equal(c.mangaImageLimit, 8);
});

function verifyWiring(input) {
  assert.match(input.app, /^import \{ createChannelHistoryState \} from "\.\/js\/channel-history-state\.js\?v=[^"]+";/m, "Shell imports real range helper");
  assert.match(input.app, /^const channelHistoryState = createChannelHistoryState\(\);$/m, "Shell creates session-owned range store once");
}
test("actual shell imports and initializes session-only helper", input => verifyWiring(input));

const legacySources = { ...sources, channel: legacy.sources.channel.source, media: legacy.sources.media.source, helper: legacy.sources.helper.source };
for (const [name, source] of Object.entries(legacy.sources.app.functions)) legacySources.app = legacySources.app.replace(appFunction(legacySources.app, name), () => source);
function replaceFunction(source, name, edit) { const code = appFunction(source, name); const next = edit(code); assert.notEqual(next, code, `Mutant ${name} must change source`); return source.replace(code, () => next); }
const mutations = [
  { name: "showView omits range restore", target: "movie 36→72→child→button", field: "app", edit: source => replaceFunction(source, "showView", code => code.replace("restoreChannelRange(navigation.channelRange, view, currentViewParams);", "/* omitted restore */")) },
  { name: "stack back drops range token", target: "movie 36→72→child→button", field: "app", edit: source => replaceFunction(source, "returnToStackView", code => code.replace(", channelRange: previous.channelRange", "")) },
  { name: "browser history restore drops token", target: "movie 36→72→child→browser", field: "app", edit: source => replaceFunction(source, "restoreFromHistoryState", code => code.replace(", channelRange: hashState ? \"\" : historyState.channelRange", "")) },
  { name: "load-more omits history checkpoint", target: "actual increaseChannel checkpoints", field: "app", edit: source => replaceFunction(source, "createAndroidModuleHost", code => code.replace('if (currentView === "channel") rememberCurrentScrollInHistory();', "/* omitted load-more checkpoint */")) },
  { name: "new query does not reset old limit", target: 'changed route {"query"', field: "app", edit: source => replaceFunction(source, "showView", code => code.replace("resetViewLimitsForView(view);", "/* omitted reset */")) },
  { name: "range helper ignores source", target: "source change rejects saved range", field: "range", edit: source => source.replace("entry.source === source && ", "") },
  { name: "range helper ignores route", target: 'changed route {"query"', field: "range", edit: source => source.replace(" && entry.route === route", "") },
  { name: "range store no longer bounded128", target: "full range helper", field: "range", edit: source => source.replace("if (entries.size > 128) entries.delete(entries.keys().next().value);", "/* unbounded */") },
  { name: "in-memory channel key drops source", target: "direct source switch offline", field: "channel", edit: source => source.replace("      sourceUrl,", "      /* omitted sourceUrl */") },
  ...["cache", "fresh", "error"].map(stage => ({ name: `late ${stage} forgets source guard`, target: `source changes during pending ${stage}`, field: "channel", edit: source => source.replace(" && getActiveUrl() === activeUrl;", ";") })),
  { name: "slow timer uses only render identity", target: "manga slow-loading", field: "channel", edit: source => source.replace("if (renderedCache || !isCurrent()) return;", "if (renderedCache || !isActive()) return;") },
  { name: "settings same-view mismatch skips restore", target: "settings history with same view", field: "app", edit: source => source.replace("if (currentView !== settingsBaseView || !sameViewParams(currentViewParams, settingsBaseParams))", "if (currentView !== settingsBaseView)") },
  { name: "async render completion never rearms scroll", target: "async fresh return rearms", field: "app", edit: source => replaceFunction(source, "renderCurrentView", code => code.replace("return restoreAfterRender(androidModuleRegistry?.render(currentView, currentViewParams, renderGuard), renderGuard);", "return androidModuleRegistry?.render(currentView, currentViewParams, renderGuard);")) },
  { name: "async scroll restore ignores user cancellation", target: "async fresh return respects", field: "app", edit: source => replaceFunction(source, "renderCurrentView", code => code.replace("renderGuard() && restoreIntent === scrollRestoreIntent", "renderGuard()")) }
];
let passed = 0, failed = 0, oldRejected = 0, mutantRejected = 0, wiringRejected = 0;
if (!process.argv.includes("--legacy-only")) for (const item of tests) {
  try { await item.run(sources); passed++; console.log(`PASS ${item.name}`); } catch (error) { failed++; console.error(`FAIL ${item.name}\n${error.stack}`); }
}
for (const item of tests.slice(0, 6)) {
  try {
    let failure; try { await item.run(legacySources); } catch (error) { failure = error; }
    assert(failure instanceof assert.AssertionError, `Old behavior must fail safety assertion, not setup: ${failure?.stack || "unexpected pass"}`);
    assert.match(failure.message, /Returned refreshed real DOM must retain/); oldRejected++; console.log(`REJECT frozen old: ${item.name} (${failure.actual} != ${failure.expected})`);
  } catch (error) { failed++; console.error(error.stack); }
}
try {
  const selected = tests.find(item => item.name.startsWith("direct source switch offline")); let failure;
  try { await selected.run({ ...sources, channel: legacy.sources.channel.source }); } catch (error) { failure = error; }
  assert(failure instanceof assert.AssertionError, `Old source isolation must fail a behavior assertion: ${failure?.stack || "unexpected pass"}`);
  assert.match(failure.message, /In-memory page key must bind its source/); oldRejected++; console.log("REJECT frozen old channel source isolation (A cached72 was painted under B)");
} catch (error) { failed++; console.error(error.stack); }
if (!failed && !process.argv.includes("--legacy-only")) for (const mutation of mutations) {
  try {
    const changed = mutation.edit(sources[mutation.field]); assert.notEqual(changed, sources[mutation.field], `Mutation changes source: ${mutation.name}`);
    const selected = tests.find(item => item.name.startsWith(mutation.target)); assert(selected, mutation.target);
    let failure; try { await selected.run({ ...sources, [mutation.field]: changed }); } catch (error) { failure = error; }
    assert(failure instanceof assert.AssertionError, `Mutant must fail behavior assertion: ${mutation.name}\n${failure?.stack || "unexpected pass"}`);
    mutantRejected++; console.log(`REJECT mutant ${mutation.name}`);
  } catch (error) { failed++; console.error(error.stack); }
}
if (!failed && !process.argv.includes("--legacy-only")) for (const [name, pattern] of [
  ["helper import removed", /^import \{ createChannelHistoryState \} from .*;$/m],
  ["session store initialization removed", /^const channelHistoryState = createChannelHistoryState\(\);$/m]
]) {
  try { const app = sources.app.replace(pattern, "/* disconnected */"); assert.notEqual(app, sources.app); assert.throws(() => verifyWiring({ ...sources, app }), assert.AssertionError); wiringRejected++; console.log(`REJECT wiring ${name}`); }
  catch (error) { failed++; console.error(error.stack); }
}
console.log(`Media return range: ${passed}/${tests.length} current; ${oldRejected}/7 frozen old safety assertions; ${mutantRejected}/${mutations.length} behavior + ${wiringRejected}/2 wiring mutants; ${failed} failures.`);
for (const key of ["app", "channel", "media", "helper", "range"]) console.log(`${key} SHA256 ${createHash("sha256").update(sources[key]).digest("hex")}`);
console.log("Boundary: complete channel/adapter and real shell reset/history/render methods with synthetic data, DOM/layout/history/cache/HTTP/detail doubles; no device or live library evidence.");
process.exitCode = failed ? 1 : 0;
