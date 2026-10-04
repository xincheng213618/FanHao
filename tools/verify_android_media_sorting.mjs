import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { appFunction, createGalleryHarness } from "./fixtures/android-gallery-navigation-harness.mjs";
import { formatBytes, formatDate, formatNumber, formatTime } from "../android-client/www/js/format.js";
import { absoluteUrl } from "../android-client/www/js/image.js";
import { createImageLibraryService } from "../src/modules/content-index/server/image-library-service.js";

// Full current channel factory, media adapter, shell sanitization/history/back
// and real server list selection run. DOM/cache/HTTP are controlled boundaries;
// detail-body rendering is a no-op (navigation itself is real). No device, live
// server, library, SQLite, cookies or user storage is opened by this verifier.
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const sources = {
  app: read("android-client/www/app.js"), channel: read("android-client/www/platform/content-index/channel-views.js"),
  media: read("android-client/www/modules/media/android-module.js"), helper: read("android-client/www/js/media-navigation-state.js"),
  registry: read("android-client/www/js/android-module-registry.js"), navigation: read("android-client/www/js/module-navigation.js"),
  index: read("android-client/www/index.html")
};
const legacy = JSON.parse(read("tools/fixtures/android-media-sorting-before-fix.json"));
assert.equal(createHash("sha256").update(JSON.stringify(legacy.sources)).digest("hex"), "f3c32ab942a29732364b7cf686e9b49b146a7b24632cb13faca9a22eafb0680b", "Frozen actual pre-fix source/function checksum");
const strip = text => text.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
function nested(text, name) {
  const match = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(text); assert(match, `Real function ${name}`);
  const tail = text.slice(match.index), end = /^  \}/m.exec(tail); assert(end); return tail.slice(0, end.index + 3);
}
function syntheticService() {
  const items = [], movies = new Map(), tv = new Map();
  for (const [suffix, size, day, rating] of [["Alpha", 10, "03", 5], ["Middle", 40, "02", 7], ["Zulu", 90, "01", 9]]) {
    for (const kind of ["movie", "tv"]) {
      const id = `${kind}-${suffix}`, title = `Synthetic ${suffix}`;
      items.push({ id, mediaKind: kind, title, category: "Synthetic category", seriesName: kind === "tv" ? title : "", size,
        updatedAt: `2026-08-${day}T00:00:00Z`, playable: true });
      const meta = { title, rating, year: "2025" };
      if (kind === "movie") movies.set(id, meta); else tv.set(`Synthetic category|${title}`, meta);
    }
  }
  const index = { scannedAt: "2026-08-01T00:00:00Z", photoSets: [], mediaItems: items };
  return createImageLibraryService({
    clampInteger: (value, fallback, min, max) => Math.min(max, Math.max(min, Number.parseInt(value, 10) || fallback)),
    getImageLibraryIndex: () => index,
    maxItemLimit: 1000, galleryMediaRootStatuses: () => [], imageReaderCacheStatus: () => ({}), photoSetRootStatuses: () => [],
    mangaService: { cacheDirs: () => [], publicSummary: value => value, rootStatus: () => ({}) },
    metadataService: { movieRowsMap: () => movies, tvSeriesRowsMap: () => tv, movieRow: id => movies.get(id),
      tvSeriesRow: key => tv.get(key), publicMovie: value => value, publicTvSeries: value => value,
      tvSeriesKey: (category, title) => `${category}|${title}` },
    photoCollectionRootValue: "synthetic-root", photoSetService: { coverUrl: id => `/synthetic-cover/${id}` }
  });
}
function harness(input = sources, { storage = new Map(), hash = "", cache = new Map(), limit = 40 } = {}) {
  const h = createGalleryHarness(input, { storage }), c = h.context, service = syntheticService();
  Object.assign(c, vm.runInContext(`(function(){${strip(input.helper)};return {normalizeMediaTrail,captureMediaTrail,mediaBackTarget};})()`, c));
  const proto = Object.getPrototypeOf(h.document.body);
  if (!Object.getOwnPropertyDescriptor(proto, "childElementCount")) Object.defineProperty(proto, "childElementCount", { get() { return this.children.length; } });
  for (const name of ["viewTitle", "viewMeta", "viewKicker", "contentPanel", "moduleChrome", "viewBack"]) c.els[name] = h.document.createElement("div");
  h.document.body.append(c.els.viewContent, c.els.viewTitle, c.els.viewMeta, c.els.viewKicker, c.els.contentPanel, c.els.moduleChrome);
  c.els.appConfirmOverlay = { hidden: true };
  const calls = { network: [], cacheReads: [], cacheWrites: [], details: [] }, queue = [], loadButtons = [];
  let renderEpoch = 0, pending = Promise.resolve(), abort = null, sourceUrl = "https://synthetic.invalid";
  Object.defineProperties(c, {
    channelLimit: { configurable: true, get: () => limit, set: value => { limit = value; } },
    activeUrl: { configurable: true, get: () => sourceUrl }
  });
  const cacheKey = (source, path) => JSON.stringify([source, path]);
  Object.assign(c, {
    URL, URLSearchParams, AbortController, formatBytes, formatDate, formatNumber, formatTime, absoluteUrl,
    cacheAgeText: () => "synthetic", isChannelFavorite: () => false, toggleChannelFavorite: () => ({ favorite: true, items: [] }),
    photoCatalogCollections: items => items, loadPreviewImage() {},
    enhanceAutoLoadMore: (button, handler) => { loadButtons.push({ button, handler }); return button; },
    fetchJson: async (source, path, options) => {
      calls.network.push({ source, path, options }); const response = queue.shift();
      if (response instanceof Error) throw response;
      const actual = service.itemsPayload(new URL(path, source));
      return response ? await (typeof response === "function" ? response(actual) : response.promise || response) : actual;
    },
    readCachedJson: async (source, path) => { calls.cacheReads.push({ source, path }); return cache.get(cacheKey(source, path)) || null; },
    writeCachedJson: async (source, path, payload) => { calls.cacheWrites.push({ source, path, payload: plain(payload) }); cache.set(cacheKey(source, path), { updatedAt: "synthetic", payload: plain(payload) }); },
    HISTORY_MARKER: "synthetic-media-history", mediaViewer: { close: () => false }, currentScrollY: () => 0,
    queueScrollRestore() {}, settleAppConfirmation() {}, closeSettings() {}, closeSearchSurface: () => { c.searchSurfaceExpanded = false; }
  });
  c.window.location = { hash };
  c.window.history = { state: null, length: 1,
    replaceState(value, title, url) { this.state = plain(value); c.window.location.hash = url; },
    pushState(value, title, url) { this.length++; this.replaceState(value, title, url); }, back() { throw Error("unexpected real browser-back fallback"); } };
  const names = ["syncModuleChrome", "updateModuleChannelSearch", "goBack", "returnToStackView", "applyBackState", "isRootNavigationView",
    "readViewStateFromHash", "viewRouteHash", "routeHistoryState", "rememberCurrentScrollInHistory", "pushViewHistory", "replaceCurrentHistory"];
  vm.runInContext(names.map(name => appFunction(input.app, name)).join("\n"), c);
  const expose = /  return \{\r?\n(?=    deactivate:)/;
  assert(expose.test(input.channel));
  const channel = input.channel.replace(expose, "  return {\n    __testPath: channelItemsPath,\n");
  c.createChannelViews = vm.runInContext(`(function(){${strip(channel)};return createChannelViews;})()`, c);
  h.host.getActiveUrl = () => sourceUrl;
  Object.assign(h.host.limits, { getChannel: () => limit, increaseChannel: count => { limit += count; } });
  Object.assign(h.host.ui, { refreshChrome: () => c.syncModuleChrome(), renderCurrentView: () => c.renderCurrentView(), renderCurrentViewPreservingScroll: () => c.renderCurrentView() });
  h.host.recent.record = () => {}; h.host.favorites.onChannelFavoriteChange = () => {};
  const update = /updateChannelParams: (\(params = \{\}, navigation = \{\}\) => \{[\s\S]*?\n      \}),/.exec(appFunction(input.app, "createAndroidModuleHost"))?.[1];
  assert(update, "Actual app host parameter merger"); h.host.contentIndex.updateChannelParams = vm.runInContext(`(${update})`, c);
  h.host.contentIndex.updateSearch = c.updateModuleChannelSearch; h.host.contentIndex.updateChannelQuery = query => c.updateModuleChannelSearch(c.currentViewParams, query);
  const module = c.mediaFactory({ host: h.host });
  // Detail content is outside this test; keep the real adapter/capture/showView
  // path and record only its eventual rendering side effect.
  module.routes.find(route => route.view === "mediaDetail").render = params => calls.details.push(plain(params));
  c.androidModuleRegistry = c.registryApi.createRegistry([{ ...module, id: "media" }]);
  // The registry reports routing synchronously; its async route promise is
  // captured without replacing any factory rendering behavior.
  const route = module.routes.find(route => route.view === "channel"), render = route.render;
  route.render = (...args) => { const result = render(...args); pending = Promise.resolve(result); return result; };
  c.androidModuleRegistry = c.registryApi.createRegistry([{ ...module, id: "media" }]);
  c.renderCurrentView = () => {
    abort?.abort(); abort = new AbortController(); const epoch = ++renderEpoch;
    const guard = () => renderEpoch === epoch; guard.signal = abort.signal;
    pending = Promise.resolve(); c.androidModuleRegistry.render(c.currentView, c.currentViewParams, guard); return pending;
  };
  return { ...h, c, module, calls, queue, cache, service,
    get pending() { return pending; },
    async open(params) { c.showView("channel", params, { resetStack: true }); await pending; },
    async search(query) { module.search.submit(query, { view: c.currentView, params: c.currentViewParams }); await pending; },
    async sort(label) { const button = this.sortButtons().find(node => node.textContent === label); assert(button, `Sort button ${label}`); button.click(); await pending; },
    sortButtons: () => c.els.viewContent.querySelector(".channel-sort-row")?.querySelectorAll("button") || [],
    active: () => c.els.viewContent.querySelector(".channel-sort-row")?.querySelectorAll("button").filter(node => node.classList.contains("active")).map(node => node.textContent) || [],
    titles: () => c.els.viewContent.querySelector(".channel-list")?.querySelectorAll("strong").map(node => node.textContent) || [],
    query: () => new URL(calls.network.at(-1).path, sourceUrl).searchParams,
    data(params) { return service.itemsPayload(new URL(`/api/image-library/items?${new URLSearchParams(params)}`, sourceUrl)); },
    cacheData(path, payload) { cache.set(cacheKey(sourceUrl, path), { updatedAt: "synthetic", payload }); },
    async more() { assert(loadButtons.length); await loadButtons.at(-1).handler(); await pending; },
    async back() { c.goBack(); await pending; },
    leave() { ++renderEpoch; abort?.abort(); c.currentView = "people"; c.currentViewParams = {}; c.els.viewContent.textContent = "UNRELATED PAGE"; },
    cold(kind) { const next = harness(input, { storage: kind === "last" ? new Map(storage) : new Map(), hash: kind === "hash" ? c.window.location.hash : "" });
      const state = next.c.readInitialViewState(); next.c.currentView = state.view; next.c.currentViewParams = state.params; next.c.renderCurrentView();
      assert.equal(next.c.viewStack.length, 0); return next; }
  };
}
const tests = [], test = (name, run) => tests.push({ name, run });
const labels = { relevance: "相关", updated: "最近", title: "标题", size: "大小", rating: "评分" };
const category = "Synthetic category";
for (const mode of ["movie", "tv", "media"]) {
  test(`${mode}: initial search defaults to relevance and one active related chip`, async input => {
    const h = harness(input); await h.open({ mode, query: "Synthetic", category });
    assert.equal(h.query().get("sort"), "relevance"); assert.deepEqual(h.active(), ["相关"]);
    assert.equal(h.sortButtons().find(node => node.textContent === "相关").getAttribute("aria-pressed"), "true");
    assert.equal(h.query().get("category"), category); assert.equal(h.query().get("q"), "Synthetic");
  });
  for (const sort of ["updated", "title", "size", "rating"]) test(`${mode}: explicit ${sort} is transmitted through actual host and rendered from actual list service fixture`, async input => {
    const h = harness(input); await h.open({ mode, query: "Synthetic", category, sort });
    assert.equal(h.query().get("sort"), sort); assert.equal(h.route().params.sort, sort);
    const button = h.sortButtons().find(node => node.textContent === labels[sort]);
    if (button) assert.deepEqual(h.active(), [labels[sort]]);
    assert.equal(h.query().get("q"), "Synthetic"); assert.equal(h.query().get("category"), category);
    assert.equal(h.calls.cacheWrites.at(-1).payload.sort, sort);
    assert.deepEqual(h.titles(), h.calls.cacheWrites.at(-1).payload.items.map(item => item.movieMetadata?.title || item.tvSeries?.title || item.title));
  });
  test(`${mode}: recent click retains explicit updated, title and related can toggle without losing filters`, async input => {
    const h = harness(input); await h.open({ mode, query: "Synthetic", category });
    await h.sort("最近"); assert.equal(h.route().params.sort, "updated"); assert.equal(h.query().get("sort"), "updated"); assert.deepEqual(h.active(), ["最近"]);
    await h.sort("标题"); assert.equal(h.route().params.sort, "title"); assert.deepEqual(h.active(), ["标题"]);
    await h.sort("相关"); assert.equal(h.route().params.sort, "relevance"); assert.deepEqual(h.active(), ["相关"]);
    assert.equal(h.query().get("category"), category); assert.equal(h.query().get("q"), "Synthetic");
  });
  test(`${mode}: clearing search removes related option and stale relevance falls back to recent`, async input => {
    const h = harness(input); await h.open({ mode, query: "Synthetic", category, sort: "relevance" });
    h.c.els.viewContent.querySelector(".channel-query-row").querySelector("button").click(); await h.pending;
    assert.equal(h.query().get("q"), null); assert.equal(h.query().get("sort"), "updated"); assert.deepEqual(h.active(), ["最近"]);
    assert.equal(h.sortButtons().some(node => node.textContent === "相关"), false); assert.equal(h.route().params.category, category);
    await h.open({ mode, sort: "relevance", category }); assert.equal(h.query().get("sort"), "updated"); assert.deepEqual(h.active(), ["最近"]);
  });
}
test("changing category keeps query and explicit sort", async input => {
  const h = harness(input); await h.open({ mode: "movie", query: "Synthetic", sort: "size" });
  const chip = h.c.els.viewContent.querySelectorAll("button").find(node => node.textContent.startsWith(category)); assert(chip); chip.click(); await h.pending;
  assert.equal(h.query().get("category"), category); assert.equal(h.query().get("q"), "Synthetic"); assert.equal(h.query().get("sort"), "size"); assert.deepEqual(h.active(), ["大小"]);
});
test("ordinary search submission preserves an existing explicit order and category", async input => {
  const h = harness(input); await h.open({ mode: "tv", sort: "rating", category }); await h.search("Synthetic");
  assert.equal(h.query().get("sort"), "rating"); assert.equal(h.query().get("category"), category); assert.deepEqual(h.active(), ["评分"]);
});
for (const mode of ["tv", "media"]) test(`${mode}: episode query without explicit sort defaults to relevance through actual app sanitizer`, async input => {
  const h = harness(input); await h.open({ mode, query: "Synthetic", seriesKey: "synthetic-series", category });
  assert.equal(h.route().params.sort, "relevance"); assert.equal(h.query().get("sort"), "relevance"); assert.equal(h.query().get("seriesKey"), "synthetic-series");
  await h.open({ mode, query: "Synthetic", seriesKey: "synthetic-series", category, sort: "title" });
  assert.equal(h.query().get("sort"), "title");
  await h.open({ mode, seriesKey: "synthetic-series", category }); assert.equal(h.query().get("sort"), "title");
});
test("legacy photo manga western query relevance behavior remains unchanged", async input => {
  const h = harness(input);
  for (const mode of ["photo", "manga", "western"]) {
    const path = h.module.api.channelViews.__testPath(mode, 40, { query: "Synthetic", sort: "size", category });
    const params = new URL(path, "https://synthetic.invalid").searchParams; assert.equal(params.get("sort"), "relevance");
  }
});
for (const outcome of ["fresh", "offline"]) test(`cached explicit title retains order/chip when ${outcome} settles`, async input => {
  const h = harness(input), path = "/api/image-library/items?mode=movie&limit=40&offset=0&sort=title&q=Synthetic&category=Synthetic+category";
  const cached = h.data({ mode: "movie", q: "Synthetic", sort: "title", category, limit: "40" }); cached.items[0].title = "Synthetic Cached"; cached.items[0].movieMetadata = null;
  h.cacheData(path, cached); const hold = deferred(); h.queue.push(hold); h.c.showView("channel", { mode: "movie", query: "Synthetic", sort: "title", category }); await tick();
  assert.deepEqual(h.active(), ["标题"]); assert.ok(h.titles().includes("Synthetic Cached"));
  if (outcome === "fresh") hold.resolve(h.data({ mode: "movie", q: "Synthetic", sort: "title", category, limit: "40" })); else hold.reject(Error("synthetic offline"));
  await h.pending; assert.deepEqual(h.active(), ["标题"]); assert.equal(h.query().get("sort"), "title");
  if (outcome === "fresh") assert.equal(h.titles().includes("Synthetic Cached"), false); else assert.ok(h.titles().includes("Synthetic Cached"));
});
test("pagination keeps query/order/category and a changed order restarts from offset zero", async input => {
  const h = harness(input, { limit: 1 }); await h.open({ mode: "movie", query: "Synthetic", sort: "size", category });
  assert.equal(h.query().get("offset"), "0"); assert.equal(h.titles().length, 1); await h.more();
  assert.equal(h.query().get("offset"), "1"); assert.equal(h.query().get("sort"), "size"); assert.equal(h.query().get("q"), "Synthetic"); assert.equal(h.query().get("category"), category);
  assert.equal(h.titles().length, 3); await h.sort("标题"); assert.equal(h.query().get("offset"), "0"); assert.equal(h.query().get("sort"), "title");
});
test("late old-order response cannot replace newer requested ordering", async input => {
  const h = harness(input), hold = deferred(); h.queue.push(hold);
  h.c.showView("channel", { mode: "movie", query: "Synthetic", sort: "size" }); await tick(); const first = h.pending;
  await h.open({ mode: "movie", query: "Synthetic", sort: "title" }); const current = h.titles();
  hold.resolve(h.data({ mode: "movie", q: "Synthetic", sort: "size", limit: "40" })); await first;
  assert.deepEqual(h.active(), ["标题"]); assert.deepEqual(h.titles(), current);
  assert.equal(h.calls.cacheWrites.some(call => call.path.includes("sort=size")), false, "Cancelled ordering response cannot overwrite its cache");
});
test("late sorting response cannot repaint an unrelated page", async input => {
  const h = harness(input), hold = deferred(); h.queue.push(hold); h.c.showView("channel", { mode: "movie", query: "Synthetic", sort: "title" }); await tick(); const first = h.pending;
  h.leave(); hold.resolve(h.data({ mode: "movie", q: "Synthetic", sort: "title", limit: "40" })); await first;
  assert.equal(h.c.els.viewContent.textContent, "UNRELATED PAGE");
});
test("late old-order failure cannot erase a newer successful list", async input => {
  const h = harness(input), hold = deferred(); h.queue.push(hold); h.c.showView("channel", { mode: "tv", query: "Synthetic", sort: "title" }); await tick(); const first = h.pending;
  await h.open({ mode: "tv", query: "Synthetic", sort: "rating" }); const current = h.titles();
  hold.reject(Error("STALE OLD ORDER ERROR")); await first;
  assert.deepEqual(h.active(), ["评分"]); assert.deepEqual(h.titles(), current); assert.equal(h.c.els.viewContent.textContent.includes("STALE OLD ORDER ERROR"), false);
});
for (const transport of ["hash", "last"]) test(`cold ${transport} restores relevance/updated through detail episodes and catalog`, async input => {
  const h = harness(input); await h.open({ mode: "tv", query: "Synthetic", category, sort: "relevance" });
  const card = h.c.els.viewContent.querySelector(".channel-list").querySelector("button"); assert(card); card.click(); await h.pending;
  const episode = { ...h.route().params, query: "Synthetic", sort: "updated" }; h.c.showView("channel", episode); await h.pending;
  const episodeRoute = h.route().params; const episodeCard = h.c.els.viewContent.querySelector(".channel-list").querySelector("button"); assert(episodeCard); episodeCard.click(); await h.pending;
  assert.equal(h.route().view, "mediaDetail"); const cold = h.cold(transport); await cold.pending;
  await cold.back(); assert.equal(cold.route().view, "channel"); assert.equal(cold.route().params.seriesKey, episodeRoute.seriesKey);
  assert.equal(cold.query().get("sort"), "updated"); assert.equal(cold.query().get("q"), "Synthetic");
  const back = cold.c.els.viewContent.querySelector(".channel-tv-series-row").querySelector("button"); back.click(); await cold.pending;
  assert.equal(cold.query().get("sort"), "relevance"); assert.equal(cold.query().get("q"), "Synthetic"); assert.equal(cold.query().get("category"), category); assert.deepEqual(cold.active(), ["相关"]);
});

let passed = 0, failed = 0, oldRejected = 0, mutantRejected = 0;
for (const item of tests) { try { await item.run(sources); passed++; console.log(`PASS ${item.name}`); } catch (error) { failed++; console.error(`FAIL ${item.name}\n${error.stack}`); } }
const replaceFunction = (source, name, replacement, top = false) => source.replace(top ? appFunction(source, name) : nested(source, name), () => replacement);
const oldControls = [
  { name: "old path forces relevance over explicit size", target: "movie: explicit size", change: input => ({ ...input, channel: replaceFunction(input.channel, "channelItemsPath", legacy.sources.channel.functions.channelItemsPath) }) },
  { name: "old sort row loses related and explicit recent", target: "movie: recent click", change: input => ({ ...input, channel: replaceFunction(input.channel, "createSortRow", legacy.sources.channel.functions.createSortRow) }) },
  { name: "old app sanitizer drops explicit updated search state", target: "movie: recent click", change: input => ({ ...input, app: replaceFunction(input.app, "sanitizeViewParams", legacy.sources.app.functions.sanitizeViewParams, true) }) },
  { name: "old trail rejects relevance on cold return", target: "cold hash", change: input => ({ ...input, helper: legacy.sources.helper.source }) }
];
const mutants = [
  { name: "movie header loses searching context", target: "movie: initial search", field: "channel", from: 'query: mode === "movie" ? query : ""', to: 'query: ""' },
  { name: "recent chip collapses explicit updated to empty", target: "movie: recent click", field: "channel", from: 'value === "updated" && !searching ? "" : value', to: 'value === "updated" ? "" : value' },
  { name: "path drops category", target: "changing category", field: "channel", transform: source => { const old = nested(source, "channelItemsPath"); return source.replace(old, old.replaceAll('params.set("category", filters.category)', 'void 0')); } },
  { name: "response guard ignores obsolete render identity", target: "late old-order", field: "channel", transform: source => { const old = nested(source, "renderChannel"); return source.replace(old, old.replaceAll('if (!isCurrent()) return;', '/* removed render identity and source guard */')); } },
  { name: "helper stops carrying relevance", target: "cold last", field: "helper", from: '"rating", "relevance"', to: '"rating"' }
];
async function rejectControl(control, changed, kind) {
  const selected = tests.find(item => item.name.startsWith(control.target)); assert(selected, `Control target ${control.target}`);
  let failure; try { await selected.run(changed); } catch (error) { failure = error; }
  assert(failure instanceof assert.AssertionError, `${control.name} must fail a behavior assertion, not unrelated runtime/setup: ${failure?.stack || "unexpected pass"}`);
  console.log(`REJECT ${kind} ${control.name}`);
}
if (!failed) {
  for (const control of oldControls) { try { await rejectControl(control, control.change(sources), "old"); oldRejected++; } catch (error) { failed++; console.error(error.stack); } }
  for (const control of mutants) { try {
    const original = sources[control.field], changed = control.transform ? control.transform(original) : original.replace(control.from, control.to);
    assert.notEqual(changed, original, `Mutation must modify source: ${control.name}`);
    await rejectControl(control, { ...sources, [control.field]: changed }, "mutant"); mutantRejected++;
  } catch (error) { failed++; console.error(error.stack); } }
}
console.log(`Media sorting: ${passed}/${tests.length} scenarios; ${oldRejected}/${oldControls.length} executable old controls; ${mutantRejected}/${mutants.length} mutants; ${failed} failures.`);
for (const name of ["channel", "app", "helper", "media"]) console.log(`${name} SHA256 ${createHash("sha256").update(sources[name]).digest("hex")}`);
console.log("Boundary: real factory/adapter/shell/list service on synthetic inputs; DOM/history/HTTP/cache and detail rendering are controlled, not device/live-server evidence.");
process.exitCode = failed ? 1 : 0;
