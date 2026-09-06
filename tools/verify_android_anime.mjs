import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { appFunction, createNavigationFixtureDocument } from "./fixtures/android-gallery-navigation-harness.mjs";
import { captureMediaTrail, mediaBackTarget } from "../android-client/www/js/media-navigation-state.js";
import { formatBytes, formatDate, formatNumber, formatTime } from "../android-client/www/js/format.js";
import { absoluteUrl } from "../android-client/www/js/image.js";
import { createSyntheticAnimeLibrary, ANIME_FIXTURE } from "./fixtures/android-anime-service.mjs";

// Full current channel factory and media adapter execute against actual server
// list/detail/progress/play-info selectors. DOM, host routing, HTTP, cache,
// metadata/index, stat/probe, clock and native bridge are synthetic boundaries.
// Host showView records the real adapter's request; follow() explicitly mounts
// the requested actual route. Real browser history is verified separately.
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const source = read("android-client/www/platform/content-index/channel-views.js");
const mediaSource = read("android-client/www/modules/media/android-module.js"), appSource = read("android-client/www/app.js");
const legacy = JSON.parse(read("tools/fixtures/android-anime-before-fix.json"));
assert.equal(legacy.sources.channel.sha256, "ab6295982204ae660e14f5d56cf3d52082ffe68b9fa0ec55aca9952c8dbd8189");
assert.equal(legacy.sources.media.sha256, "3865ab2b4163d47f31fae8d8e98db834faec33913049611d0627561c7fed0426");
for (const value of Object.values(legacy.sources)) assert.equal(createHash("sha256").update(value.source).digest("hex"), value.sha256);
const A = "https://synthetic-anime-a.invalid", B = "https://synthetic-anime-b.invalid";
const strip = value => value.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function harness(input = source, { count = 12, limit = 36 } = {}) {
  const library = createSyntheticAnimeLibrary({ count }), document = createNavigationFixtureDocument();
  const proto = Object.getPrototypeOf(document.body);
  if (!Object.getOwnPropertyDescriptor(proto, "isConnected")) Object.defineProperty(proto, "isConnected", { get() { return this.ownerDocument.body.contains(this); } });
  if (!Object.getOwnPropertyDescriptor(proto, "childElementCount")) Object.defineProperty(proto, "childElementCount", { get() { return this.children.length; } });
  proto.remove = function () { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; };
  const els = Object.fromEntries(["viewContent", "viewTitle", "viewMeta", "viewKicker", "contentPanel"].map(name => [name, document.createElement("div")]));
  document.body.append(...Object.values(els));
  const calls = { api: [], nav: [], bridge: [], recent: [], favorites: [], errors: [], search: [], cacheWrites: [] };
  const queues = { list: [], detail: [], info: [] }, cache = new Map(), timers = new Map();
  let activeUrl = A, clock = 0, timer = 0, lastRender = Promise.resolve();
  const originalCreate = document.createElement;
  document.createElement = tag => {
    const node = originalCreate(tag), add = node.addEventListener.bind(node), click = node.click.bind(node); node.disabled = false;
    node.addEventListener = (type, callback, options) => add(type, event => {
      try { const task = callback(event); task?.catch?.(error => calls.errors.push(error)); return task; } catch (error) { calls.errors.push(error); }
    }, options);
    node.click = () => { if (node.disabled) return; try { node.onclick?.({ type: "click", target: node }); return click(); } catch (error) { calls.errors.push(error); } };
    return node;
  };
  document.visibilityState = "visible";
  const plugin = { async play(value) { calls.bridge.push(plain(value)); return { opened: true }; } };
  const context = vm.createContext({ document, console, URL, URLSearchParams, AbortController, captureMediaTrail, mediaBackTarget,
    currentView: "channel", currentViewParams: { mode: "anime" }, viewRenderToken: 0, activeViewController: null,
    performance: { now: () => clock }, window: { addEventListener() {}, innerHeight: 844,
      setTimeout(fn, delay) { const id = ++timer; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); },
      Capacitor: { Plugins: { FanHaoPlayer: plugin } } },
    formatBytes, formatDate, formatNumber, formatTime, absoluteUrl, cacheAgeText: () => "synthetic", photoCatalogCollections: value => value,
    isChannelFavorite: () => false, toggleChannelFavorite: value => { calls.favorites.push(plain(value)); return { favorite: true, items: [] }; },
    loadPreviewImage() {}, enhanceAutoLoadMore: button => button,
    readCachedJson: async (base, path) => cache.get(JSON.stringify([base, path])) || null,
    writeCachedJson: async (base, path, value) => { calls.cacheWrites.push({ base, path }); cache.set(JSON.stringify([base, path]), { payload: plain(value), updatedAt: "synthetic" }); },
    fetchJson: async (base, path, options = {}) => {
      assert([A, B].includes(base), "Synthetic origins only"); const url = new URL(path, base);
      const kind = path.startsWith("/api/image-library/items?") ? "list" : path.startsWith("/api/gallery-media/") ? "detail" : path.startsWith("/api/playinfo/") ? "info" : "unknown";
      assert.notEqual(kind, "unknown", `Unexpected API ${path}`);
      const mediaId = decodeURIComponent(url.pathname.split("/").at(-1));
      const actual = kind === "list" ? library.list(url) : kind === "detail" ? library.detail(mediaId) : await library.playInfo(mediaId, { source: url.searchParams.get("source") });
      const call = { base, path, kind, options, params: Object.fromEntries(url.searchParams), actual }; calls.api.push(call);
      let value = queues[kind].length ? queues[kind].shift() : actual;
      if (typeof value === "function") value = value(call);
      if (value instanceof Error) throw value; return await (value?.promise || value);
    }
  });
  vm.runInContext(["sameViewParams", "beginViewRender", "invalidateViewRender"].map(name => appFunction(appSource, name)).join("\n"), context);
  vm.runInContext(strip(input), context, { filename: "actual-anime-channel.js" });
  const host = { els, normalizeChannelMode: context.normalizeChannelMode, getActiveUrl: () => activeUrl,
    limits: { getChannel: () => limit, increaseChannel: number => { limit += number; } }, recent: { record: value => calls.recent.push(plain(value)) },
    favorites: { onChannelFavoriteChange() {} }, navigation: { currentView: () => context.currentView, currentParams: () => context.currentViewParams,
      showView: (view, params, navigation) => calls.nav.push(plain({ view, params, navigation })), returnToStackView: () => false, goBack() {}, openInLibrary() {} },
    ui: { setActiveBottom() {}, refreshChrome() {}, openSearch: () => calls.search.push(true), renderCurrentView: () => h.render(), renderCurrentViewPreservingScroll: () => h.render() },
    contentIndex: { updateChannelParams: (updates, navigation) => calls.nav.push(plain({ view: "channel", params: { ...context.currentViewParams, ...updates }, navigation })),
      updateChannelQuery: query => calls.nav.push({ view: "channel", params: { ...context.currentViewParams, query } }),
      updateSearch: (params, query) => calls.nav.push({ view: "channel", params: { ...params, query } }) } };
  const adapter = input === legacy.sources.channel.source ? legacy.sources.media.source : mediaSource;
  const factory = vm.runInContext(`(function(){${strip(adapter)};return createAndroidModule;})()`, context), module = factory({ host });
  const h = { library, document, els, calls, context, module, plugin,
    queue(kind, value) { queues[kind].push(value); }, setSource(value) { activeUrl = value; },
    cacheDetail(mediaId, value) { cache.set(JSON.stringify([activeUrl, `/api/gallery-media/${encodeURIComponent(mediaId)}`]), { payload: value, updatedAt: "synthetic" }); },
    setLimit(value) { limit = value; },
    render(view = context.currentView, params = context.currentViewParams) { context.currentView = view; context.currentViewParams = plain(params);
      const route = module.routes.find(route => route.view === view && (!route.match || route.match(params))); assert(route, "Actual media adapter must accept anime route");
      const guard = context.beginViewRender(view, context.currentViewParams); lastRender = route.render(context.currentViewParams, guard); return lastRender; },
    root(params = {}) { return h.render("channel", { mode: "anime", ...params }); },
    episodes(series = "alpha") { return h.render("channel", { mode: "anime", seriesKey: library.keys[series], tvView: "episodes", sort: "title" }); },
    detail(number = 1, series = "anime-alpha", params = {}) { return h.render("mediaDetail", { id: library.id(series, number), mode: "anime", ...params }); },
    async follow() { const target = calls.nav.at(-1); assert(target); await h.render(target.view, target.params); await h.settle(); },
    async settle() { for (let round = 0; round < 160; round++) { await Promise.resolve(); for (const [id, entry] of [...timers]) if (timers.delete(id)) { clock += entry.delay; entry.fn(); } }
      assert.equal(calls.errors.length, 0, calls.errors[0]?.stack); },
    abort() { context.activeViewController.abort(); }, leave() { context.invalidateViewRender(); context.currentView = "channel"; context.currentViewParams = { mode: "tv" }; els.viewContent.textContent = "UNRELATED PAGE"; },
    cards: () => els.viewContent.querySelectorAll(".channel-card"), buttons: () => els.viewContent.querySelectorAll("button"),
    button: text => h.buttons().find(button => button.textContent === text), row: () => els.viewContent.querySelector(".media-episode-nav"),
    label: () => h.row()?.querySelector(".media-episode-nav-label")?.textContent,
    async click(node) { assert(node, "Actual UI control exists"); node.click(); await h.settle(); }
  }; return h;
}

const tests = [], test = (name, run) => tests.push({ name, run });
test("anime root uses existing media kind endpoint and displays only three anime works", async input => {
  const h = harness(input); await h.root(); await h.settle();
  assert.equal(h.els.viewTitle.textContent, "动漫"); assert.match(h.els.viewMeta.textContent, /3 部/);
  assert.equal(h.cards().length, 3); assert(h.els.viewContent.querySelector(".media-poster-grid"));
  const call = h.calls.api[0]; assert.equal(call.params.mode, "media"); assert.equal(call.params.kind, "anime");
  assert.equal(call.actual.mode, "media"); assert(call.actual.items.every(item => item.mediaKind === "anime"));
  assert(!h.cards().some(card => card.textContent.includes("unrelated movie"))); assert(!h.els.viewTitle.textContent.includes("套图"));
});
test("anime root cards enter an anime episode list and actual adapter preserves parent filters", async input => {
  const h = harness(input); await h.root({ sort: "title" }); await h.settle(); await h.click(h.cards()[0]);
  const target = h.calls.nav.at(-1); assert.equal(target.view, "channel"); assert.equal(target.params.mode, "anime"); assert.equal(target.params.seriesKey, h.library.keys.alpha);
  assert.equal(target.params.tvView, "episodes"); assert.equal(target.params.sort, "title"); assert(target.params.mediaTrail);
  await h.follow(); assert.equal(h.cards().length, 12); assert(h.els.viewContent.querySelector(".media-episode-list"));
  assert.equal(h.els.viewTitle.textContent, ANIME_FIXTURE.titles.alpha); assert.match(h.els.viewMeta.textContent, /12 集/); assert(h.button("返回动漫"));
});
test("anime episode card opens playable anime detail instead of a photo route", async input => {
  const h = harness(input); await h.episodes(); await h.settle(); await h.click(h.cards()[1]);
  const target = h.calls.nav.at(-1); assert.equal(target.view, "mediaDetail"); assert.equal(target.params.mode, "anime"); assert.equal(target.params.id, h.library.id("anime-alpha", 2));
  await h.follow(); assert.equal(h.els.contentPanel.dataset.channelMode, "anime"); assert.equal(h.label(), "第 2 / 12 集");
  assert(h.els.viewContent.querySelector(".media-native-play-surface")); assert.match(h.els.viewTitle.textContent, /Episode 2/);
});
for (const [params, count, expected] of [
  [{ query: "Beta", sort: "relevance" }, 1, ANIME_FIXTURE.titles.beta],
  [{ category: ANIME_FIXTURE.categories[0], sort: "rating" }, 2, ANIME_FIXTURE.titles.feature],
  [{ sort: "title" }, 3, ANIME_FIXTURE.titles.alpha],
  [{ sort: "updated" }, 3, ANIME_FIXTURE.titles.beta]
]) test(`anime search/category/sort ${JSON.stringify(params)} remains kind-filtered`, async input => {
  const h = harness(input); await h.root(params); await h.settle(); assert.equal(h.cards().length, count); assert(h.cards()[0].textContent.includes(expected));
  const call = h.calls.api[0]; assert.equal(call.params.kind, "anime"); assert.equal(call.params.sort, params.sort);
  if (params.query) assert.equal(call.params.q, params.query); if (params.category) assert.equal(call.params.category, params.category);
});
test("empty anime search is explicitly empty without movie or photo fallback", async input => {
  const h = harness(input); await h.root({ query: "no-such-synthetic-anime" }); await h.settle(); assert.equal(h.cards().length, 0);
  assert.match(h.els.viewContent.textContent, /没有搜到/); assert.equal(h.calls.api[0].params.kind, "anime");
});
for (const current of [240, 241, 300]) test(`anime navigation ${current}/300 uses bounded existing API and preserves anime`, async input => {
  const h = harness(input, { count: 300 }); await h.detail(current); await h.settle(); assert.equal(h.label(), `第 ${current} / 300 集`);
  const pages = h.calls.api.filter(call => call.kind === "list"); assert.deepEqual(pages.map(call => Number(call.params.offset)), [0, 240]);
  assert(pages.every(call => call.params.mode === "media" && call.params.kind === "anime" && call.params.seriesKey === h.library.keys.alpha));
  const direction = current === 300 ? "上一集" : "下一集", expected = current === 300 ? 299 : current + 1;
  await h.click(h.button(direction)); assert.equal(h.calls.nav.at(-1).params.mode, "anime"); assert.equal(h.calls.nav.at(-1).params.id, h.library.id("anime-alpha", expected));
});
test("single-file anime feature has true 1/1 boundary despite external episode metadata", async input => {
  const h = harness(input); await h.detail(1, "anime-feature"); await h.settle(); assert.equal(h.label(), "第 1 / 1 集");
  assert.equal(h.button("上一集").disabled, true); assert.equal(h.button("下一集").disabled, true);
});
test("generic media anime episode still opens an anime detail", async input => {
  const h = harness(input); await h.root({ mode: "media", seriesKey: h.library.keys.alpha, tvView: "episodes", sort: "title" }); await h.settle();
  await h.click(h.cards()[0]); assert.equal(h.calls.nav.at(-1).params.mode, "anime"); assert.equal(h.calls.nav.at(-1).view, "mediaDetail");
});
test("anime recent and favorite retain mediaDetail identity and mode", async input => {
  const h = harness(input); await h.detail(); await h.settle(); assert.equal(h.calls.recent.at(-1).params.mode, "anime");
  await h.click(h.els.viewContent.querySelector(".channel-favorite-action")); assert.equal(h.calls.favorites[0].params.mode, "anime");
  assert.equal(h.calls.favorites[0].view, "mediaDetail"); assert.equal(h.calls.favorites[0].label, "动漫");
});
test("anime launch rereads saved progress and dispatches the gallery native contract", async input => {
  const h = harness(input); const id = h.library.id("anime-alpha"); h.library.saveProgress(id, { position: 73, duration: 600 });
  await h.detail(); await h.settle(); h.library.saveProgress(id, { position: 125, duration: 600 });
  await h.click(h.els.viewContent.querySelector(".media-native-play-surface")); assert.equal(h.calls.bridge.length, 1);
  const payload = h.calls.bridge[0]; assert.equal(payload.videoId, id); assert.equal(payload.position, 125); assert.equal(payload.mode, "gallery-media");
  assert.equal(payload.url, `${A}/media/gallery-video/${id}`); assert.equal(payload.progressUrl, `${A}/api/progress/${id}`);
  assert.equal(h.calls.api.find(call => call.kind === "info").params.source, "gallery");
});
for (const invalidation of ["source", "abort", "leave"]) test(`anime ${invalidation} during pending launch does not call native`, async input => {
  const h = harness(input); await h.detail(); await h.settle(); const pending = deferred(); h.queue("detail", pending);
  await h.click(h.els.viewContent.querySelector(".media-native-play-surface"));
  if (invalidation === "source") h.setSource(B); else if (invalidation === "abort") h.abort(); else h.leave();
  pending.resolve(h.library.detail(h.library.id("anime-alpha"))); await h.settle(); assert.equal(h.calls.bridge.length, 0);
});
test("anime next-page failure remains retryable and cannot be called a last episode", async input => {
  const h = harness(input, { count: 300 }); h.queue("list", call => call.actual); h.queue("list", Error("Synthetic second-page offline"));
  await h.detail(240); await h.settle(); assert.equal(h.row().dataset.state, "error"); assert.equal(h.button("下一集").disabled, true);
  await h.click(h.els.viewContent.querySelector(".media-episode-nav-retry")); assert.equal(h.label(), "第 240 / 300 集");
  assert.deepEqual(h.calls.api.filter(call => call.kind === "list").map(call => Number(call.params.offset)), [0, 240, 0, 240]);
});
test("anime and TV page caches cannot mix despite identical human series names", async input => {
  const h = harness(input); await h.root({ sort: "title" }); await h.settle(); assert.equal(h.cards().length, 3);
  await h.root({ mode: "tv", sort: "title" }); await h.settle(); assert.equal(h.cards().length, 1);
  await h.root({ sort: "title" }); await h.settle(); assert.equal(h.cards().length, 3);
  assert(h.calls.api.filter(call => call.kind === "list").map(call => call.params.kind || call.params.mode).includes("tv"));
});

test("anime count search button has explicit anime label and uses existing search callback", async input => {
  const h = harness(input); await h.root(); await h.settle(); const button = h.els.viewMeta.querySelector(".media-list-search");
  assert(button); assert.equal(button.getAttribute("aria-label"), "搜索动漫"); await h.click(button); assert.equal(h.calls.search.length, 1);
});
test("anime series return button restores original anime catalog query and ordering", async input => {
  const h = harness(input); await h.root({ query: "Alpha", sort: "title" }); await h.settle(); await h.click(h.cards()[0]); await h.follow();
  await h.click(h.button("返回动漫")); const target = h.calls.nav.at(-1);
  assert.equal(target.view, "channel"); assert.equal(target.params.mode, "anime"); assert.equal(target.params.query, "Alpha"); assert.equal(target.params.sort, "title");
  assert.equal(target.params.seriesKey || "", "");
});
test("anime detail uses existing tvSeries rating and genre instead of empty movie metadata", async input => {
  const h = harness(input); await h.detail(); await h.settle(); const facts = h.els.viewContent.querySelector(".media-player-facts");
  assert.match(facts.textContent, /7\.1/); assert.match(facts.textContent, /动画/);
});
test("source change while anime neighbor page is pending leaves old controls disabled", async input => {
  const h = harness(input, { count: 300 }), pending = deferred(); h.queue("list", call => call.actual); h.queue("list", pending);
  await h.detail(240); await h.settle(); const row = h.row(); assert.equal(row.dataset.state, "loading");
  const second = h.calls.api.filter(call => call.kind === "list")[1]; h.setSource(B); pending.resolve(second.actual); await h.settle();
  assert.equal(row.dataset.state, "loading"); assert.equal(h.button("下一集").disabled, true); assert(h.calls.api.every(call => call.base === A));
});
test("anime actual poster and episode cards expose matching cover/context CSS hooks", async input => {
  const h = harness(input); await h.root({ sort: "title" }); await h.settle();
  assert.equal(h.els.viewContent.querySelectorAll(".media-poster-card").length, 3);
  for (const card of h.cards()) assert(card.querySelector(".media-card-cover"));
  await h.click(h.cards()[0]); await h.follow();
  assert.equal(h.els.viewContent.querySelectorAll(".media-episode-card").length, 12);
  const row = h.els.viewContent.querySelector(".channel-tv-series-row.media-series-context"); assert(row);
  const copy = row.querySelector(".media-series-copy"); assert(copy);
  assert.equal(copy.querySelector("strong").textContent, ANIME_FIXTURE.titles.alpha);
  assert.match(copy.querySelector("span").textContent, /12 集在库/); assert(row.querySelector("button"));
});

// These are explicit stylesheet wiring guards, not a simulated CSS cascade or
// a claim of computed layout. The independent browser suite checks real layout.
const mediaCss = read("android-client/www/modules/media/styles.css"), baseCss = read("android-client/www/css/lists.css");
const cssSelectors = text => [...text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => match[1].trim());
const styleTargets = [
  { source: "media", suffix: ".channel-tv-series-row.media-series-context" },
  { source: "media", suffix: ".media-series-context .media-series-copy > span" },
  { source: "media", suffix: ".media-series-context button" },
  { source: "base", suffix: ".channel-tv-series-row" },
  { source: "base", suffix: ".channel-tv-series-row span" },
  { source: "base", suffix: ".channel-tv-series-row button" }
];
function assertStyleTarget(css, target) {
  const selector = cssSelectors(css).find(value => value.endsWith(target.suffix) && value.includes('[data-channel-mode="tv"]'));
  assert(selector, `Existing scoped style must be present: ${target.suffix}`);
  assert(selector.includes('[data-channel-mode="anime"]'), `Anime must share scoped ${target.source} style: ${target.suffix}`);
}

const mutations = [], mutate = (name, scenario, change) => mutations.push({ name, scenario, change });
const once = (value, from, to) => { assert(value.includes(from), `Mutation anchor missing: ${from}`); return value.replace(from, to); };
const methodMutation = (name, change) => value => {
  const start = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(value); assert(start);
  const tail = value.slice(start.index), end = /^  \}/m.exec(tail); assert(end); const method = tail.slice(0, end.index + 3);
  return once(value, method, change(method));
};
mutate("send unsupported direct anime backend mode", tests[0].name, methodMutation("channelItemsPath", value => once(value, 'mode: mode === "anime" ? "media" : mode,', 'mode,')));
mutate("omit anime kind and mix movie/TV works", tests[0].name, methodMutation("channelItemsPath", value => once(value, 'if (mode === "anime") params.set("kind", "anime");', '/* mutation: kind omitted */')));
mutate("omit anime seriesKey from API request", tests[1].name, methodMutation("channelItemsPath", value => once(value, 'if (mode === "tv" || mode === "anime" || mode === "media")', 'if (mode === "tv" || mode === "media")')));
mutate("render anime root without poster layout", tests[0].name, methodMutation("renderChannelData", value => once(value, '["movie", "tv", "anime", "media"].includes(mode) ? (seriesKey', '["movie", "tv", "media"].includes(mode) ? (seriesKey')));
mutate("query TV directory for anime neighbors", "anime navigation 240/300 uses bounded existing API and preserves anime", methodMutation("createTvEpisodeNav", value => once(value, 'channelItemsPath(mode, pageSize, filters, offset)', 'channelItemsPath("tv", pageSize, filters, offset)')));
mutate("neighbor callback drops anime logical mode", "anime navigation 240/300 uses bounded existing API and preserves anime", methodMutation("bindEpisodeNavButton", value => once(value, 'showMediaDetail(episode.id, mode)', 'showMediaDetail(episode.id, "tv")')));
mutate("generic media detail misses anime kind", "generic media anime episode still opens an anime detail", methodMutation("mediaDetailModeForItem", value => once(value, 'if (item.type === "anime" || item.mediaKind === "anime") return "anime";', '/* mutation: anime detail kind missing */')));
mutate("anime details read nonexistent movie metadata", "anime detail uses existing tvSeries rating and genre instead of empty movie metadata", methodMutation("mediaDetailFacts", value => once(value, 'mode === "tv" || mode === "anime" ? item.tvSeries', 'mode === "tv" ? item.tvSeries')));

let passed = 0, failed = 0, oldRejected = 0, mutantsRejected = 0, stylePassed = 0, styleMutantsRejected = 0;
for (const test of tests) {
  try { await test.run(source); passed++; console.log(`PASS ${test.name}`); } catch (error) { failed++; console.error(`FAIL ${test.name}\n${error.stack}`); }
}
for (const test of [...tests.slice(0, 3), tests.find(value => value.name.startsWith("single-file anime"))]) {
  try { let failure; try { await test.run(legacy.sources.channel.source); } catch (error) { failure = error; }
    assert(failure instanceof assert.AssertionError, `Frozen86 must fail an assertion: ${failure?.stack || "unexpected pass"}`);
    if (test.name.startsWith("single-file anime")) assert.equal(failure.actual, undefined, "Frozen86 produces no anime episode navigation");
    else assert.match(failure.message, /Actual media adapter must accept anime route/);
    oldRejected++; console.log(`REJECT frozen86 ${test.name}`);
  } catch (error) { failed++; console.error(error.stack); }
}
for (const mutation of mutations) {
  try { const changed = mutation.change(source); assert.notEqual(changed, source); const scenario = tests.find(test => test.name === mutation.scenario); assert(scenario);
    let failure; try { await scenario.run(changed); } catch (error) { failure = error; }
    assert(failure instanceof assert.AssertionError, `Mutation must fail a behavior assertion: ${failure?.stack || "unexpected pass"}`);
    mutantsRejected++; console.log(`REJECT mutation ${mutation.name}`);
  } catch (error) { failed++; console.error(`FAIL mutation ${mutation.name}\n${error.stack}`); }
}
for (const target of styleTargets) {
  try { const css = target.source === "media" ? mediaCss : baseCss; assertStyleTarget(css, target); stylePassed++;
    const mutation = css.replaceAll('[data-channel-mode="anime"]', '[data-channel-mode="missing-anime"]');
    assert.throws(() => assertStyleTarget(mutation, target), assert.AssertionError); styleMutantsRejected++;
    console.log(`PASS/REJECT stylesheet scope ${target.source} ${target.suffix}`);
  } catch (error) { failed++; console.error(error.stack); }
}
console.log(`Android anime: ${passed}/${tests.length} current; ${oldRejected}/4 frozen86 controls; ${mutantsRejected}/${mutations.length} behavior mutants; ${stylePassed}/${styleTargets.length} CSS wiring guards + ${styleMutantsRejected} CSS negative controls; ${failed} failures.`);
console.log(`channel SHA256 ${createHash("sha256").update(source).digest("hex")}`);
process.exitCode = failed ? 1 : 0;
