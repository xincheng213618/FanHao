import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { appFunction, createGalleryHarness, createNavigationFixtureDocument } from "./fixtures/android-gallery-navigation-harness.mjs";
import { captureMediaTrail, mediaBackTarget } from "../android-client/www/js/media-navigation-state.js";
import { formatBytes, formatDate, formatNumber, formatTime } from "../android-client/www/js/format.js";
import { absoluteUrl } from "../android-client/www/js/image.js";

// Real complete media module and channel-view source execute; only a private
// header method is exposed for deterministic invocation. Actual app chrome
// visibility and registry dispatch execute, rather than a self-reporting spy.
// This verifies DOM/event/CSS contracts, not pixel layout or device interaction.
const read = name => fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const sources = {
  app: read("android-client/www/app.js"), navigation: read("android-client/www/js/module-navigation.js"),
  registry: read("android-client/www/js/android-module-registry.js"), media: read("android-client/www/modules/media/android-module.js"),
  channel: read("android-client/www/platform/content-index/channel-views.js"), index: read("android-client/www/index.html"),
  css: read("android-client/www/modules/media/styles.css")
};
// Actual original module methods from Git HEAD, including the old duplicate
// tabs/search bar, retained as an executable behavioral negative control.
const LEGACY = {"chrome":"function createMediaChrome(host) {\n  return {\n    update() {\n      host.ui.refreshChrome();\n    },\n    render({ container, view, params }) {\n      if (view !== \"channel\" || ![\"media\", \"movie\", \"tv\"].includes(host.normalizeChannelMode(params.mode))) return false;\n      const activeMode = host.normalizeChannelMode(params.mode) === \"tv\" ? \"tv\" : \"movie\";\n      container.dataset.module = \"media\";\n      const nav = document.createElement(\"nav\");\n      nav.className = \"module-chrome-tabs media-chrome-tabs\";\n      nav.setAttribute(\"aria-label\", \"影视类型\");\n      for (const item of [{ label: \"电影\", mode: \"movie\" }, { label: \"电视剧\", mode: \"tv\" }]) {\n        const button = document.createElement(\"button\");\n        button.type = \"button\";\n        button.textContent = item.label;\n        button.classList.toggle(\"active\", item.mode === activeMode);\n        button.addEventListener(\"click\", () => {\n          host.navigation.showView(\"channel\", { mode: item.mode }, { resetStack: true });\n          host.ui.scrollToTop();\n        });\n        nav.append(button);\n      }\n      container.append(nav, createMediaSearchButton(host));\n      return true;\n    }\n  };\n}","search":"function createMediaSearchButton(host) {\n  const button = document.createElement(\"button\");\n  button.type = \"button\";\n  button.className = \"module-chrome-search icon-only\";\n  button.setAttribute(\"aria-label\", \"搜索电影或电视剧\");\n  button.innerHTML = '<span aria-hidden=\"true\">⌕</span>';\n  button.addEventListener(\"click\", host.ui.openSearch);\n  return button;\n}"};
const LEGACY_SHA256 = "5dad0eba8bc631fb9e5128c2ee2e614417187f21ebb940e12c7497c3c511e30d";
const strip = source => source.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
const plain = value => JSON.parse(JSON.stringify(value));
// Actual pre-reuse method from the previous frozen channel source. The rest of
// the current factory still runs in this behavioral negative control.
const LEGACY_SET_META = `  function setChannelMeta(mode, text) {
    els.viewMeta.textContent = text;
    if (["movie", "tv", "anime", "media"].includes(mode) && openMediaSearch) {
      const count = document.createElement("span");
      count.className = "media-list-count";
      count.textContent = els.viewMeta.textContent;
      const search = document.createElement("button");
      search.type = "button";
      search.className = "module-chrome-search media-list-search icon-only";
      search.setAttribute("aria-label", mode === "tv" ? "搜索电视剧" : mode === "anime" ? "搜索动漫" : mode === "movie" ? "搜索电影" : "搜索影视");
      search.innerHTML = '<span aria-hidden="true">⌕</span>';
      search.addEventListener("click", openMediaSearch);
      els.viewMeta.replaceChildren(count, search);
    }
  }`;
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

function harness(input = sources, { mode = "movie", cached = null, limit = 40, search = true } = {}) {
  const document = createNavigationFixtureDocument(), proto = Object.getPrototypeOf(document.body);
  if (!Object.getOwnPropertyDescriptor(proto, "childElementCount")) Object.defineProperty(proto, "childElementCount", { get() { return this.children.length; } });
  const els = Object.fromEntries(["viewContent", "viewTitle", "viewMeta", "viewKicker", "contentPanel", "moduleChrome"].map(key => [key, document.createElement("div")]));
  document.body.append(...Object.values(els));
  const calls = { openSearch: 0, navigation: [], network: [] };
  const queued = [];
  const c = vm.createContext({ document, console, URL, URLSearchParams, AbortController, formatBytes, formatDate, formatNumber, formatTime, absoluteUrl,
    captureMediaTrail, mediaBackTarget, cacheAgeText: () => "合成缓存时间", window: { history: { back() {} } },
    isChannelFavorite: () => false, toggleChannelFavorite: () => ({ favorite: true, items: [] }),
    photoCatalogCollections: items => items, loadPreviewImage() {}, enhanceAutoLoadMore: button => button,
    fetchJson: async (...args) => {
      calls.network.push(args);
      if (queued.length) { const value = queued.shift(); if (value instanceof Error) throw value; return await value; }
      throw new Error("合成电脑端暂时不可读");
    },
    readCachedJson: async () => cached, writeCachedJson: async () => {},
    els, currentView: "channel", currentViewParams: { mode }
  });
  const marker = /  return \{\r?\n(?=    deactivate:)/;
  assert(marker.test(input.channel), "Private header exposure requires the exact real factory return");
  const channel = input.channel.replace(marker, "  return {\n    __testApplyHeader: applyChannelHeader,\n");
  vm.runInContext(strip(channel), c, { filename: "actual-channel-views.js" });
  vm.runInContext(appFunction(input.registry, "createRegistry") + "\n" + appFunction(input.app, "syncModuleChrome"), c);
  const host = {
    els, normalizeChannelMode: c.normalizeChannelMode, getActiveUrl: () => "https://synthetic.invalid",
    limits: { getChannel: () => limit, increaseChannel: value => { limit += value; } }, recent: { record() {} }, favorites: { onChannelFavoriteChange() {} },
    navigation: { currentView: () => c.currentView, currentParams: () => c.currentViewParams, returnToStackView: () => false,
      showView: (...args) => calls.navigation.push(plain(args)), goBack() {}, openInLibrary() {} },
    ui: { setActiveBottom() {}, scrollToTop() {}, renderCurrentView() {}, renderCurrentViewPreservingScroll() {},
      refreshChrome: () => c.syncModuleChrome(), openSearch: search ? () => { calls.openSearch++; } : null },
    contentIndex: { updateChannelQuery() {}, updateChannelParams() {}, updateSearch() {} }
  };
  const factory = vm.runInContext(`(function(){\n${strip(input.media)}\nreturn createAndroidModule;\n})()`, c);
  const module = factory({ host });
  c.androidModuleRegistry = c.createRegistry([{ ...module, id: "media" }]);
  return { c, document, els, module, calls, host,
    queue: value => queued.push(value), cache: value => { cached = value; }, setLimit: value => { limit = value; },
    header(nextMode = mode, data = {}, cache = null) { c.currentViewParams = { mode: nextMode }; module.api.channelViews.__testApplyHeader(nextMode, data, cache); },
    search: () => els.viewMeta.querySelector("button")
  };
}
const tests = [];
const test = (name, run) => tests.push({ name, run });
for (const mode of ["movie", "tv", "anime", "media"]) test(`${mode}: actual module and shell leave no top tab navigation or blank row`, input => {
  const h = harness(input, { mode }), old = h.document.createElement("nav"); old.className = "media-chrome-tabs"; h.els.moduleChrome.append(old);
  const visible = h.c.syncModuleChrome();
  assert.equal(visible, false); assert.equal(h.els.moduleChrome.hidden, true); assert.equal(h.els.moduleChrome.childElementCount, 0);
  assert.equal(h.els.moduleChrome.querySelectorAll("nav,button").length, 0);
});
for (const mode of ["movie", "tv", "anime", "media"]) test(`${mode}: count and working search share the actual viewMeta parent`, input => {
  const h = harness(input, { mode }); h.header(mode, { total: 40, items: [{ id: "one" }, { id: "two" }] });
  const button = h.search(); assert(button, "Actual count row must own search button");
  assert.equal(button.parentNode, h.els.viewMeta); assert.equal(button.tagName, "BUTTON"); assert.equal(button.type, "button");
  assert.match(button.getAttribute("aria-label"), /搜索/);
  const count = h.els.viewMeta.querySelector("span"); assert(count, "Count must be a sibling, not erased by search markup");
  assert.equal(count.parentNode, button.parentNode); assert.match(count.textContent, /共 40/); assert.match(count.textContent, /已显示 2/);
  button.click(); assert.equal(h.calls.openSearch, 1); assert.equal(h.calls.navigation.length, 0); assert.equal(h.calls.network.length, 0);
  assert.equal(h.els.moduleChrome.hidden, true);
});
test("episode, query, cache and empty counts retain their meaning with search", input => {
  const h = harness(input, { mode: "tv" });
  h.header("tv", { total: 40, items: [{ id: "episode" }], tvView: "episodes", seriesKey: "synthetic-series", query: "合成关键词" }, { updatedAt: "synthetic" });
  assert.match(h.els.viewMeta.querySelector("span").textContent, /找到 40 集/);
  assert.match(h.els.viewMeta.querySelector("span").textContent, /缓存 合成缓存时间/);
  h.header("tv", { total: 0, items: [] }); assert.match(h.els.viewMeta.querySelector("span").textContent, /共 0 部/);
  assert.equal(h.els.viewMeta.querySelectorAll("button").length, 1); h.search().click(); assert.equal(h.calls.openSearch, 1);
});
test("repeated header updates retain count and search without duplicate live buttons", input => {
  const h = harness(input); h.header("movie", { total: 1, items: [{ id: "one" }] });
  const search = h.search(), count = h.els.viewMeta.querySelector("span"); search.focus();
  h.header("movie", { total: 200, items: [] }); h.header("movie", { total: 3, items: [] });
  assert.equal(h.search(), search, "Repeated count updates retain the original search button");
  assert.equal(h.els.viewMeta.querySelector("span"), count); assert.equal(h.document.activeElement, search);
  assert.equal(h.els.viewMeta.querySelectorAll("button").length, 1); assert.match(h.els.viewMeta.querySelector("span").textContent, /共 3/);
  h.search().click(); assert.equal(h.calls.openSearch, 1);
});
for (const count of [500, 1000]) test(`movie ${count}: metadata pending append error retry and cached tail retain focused search`, async input => {
  const h = harness(input, { limit: count });
  const payload = (size, offset = 0) => ({ mode: "movie", sort: "updated", facets: {}, total: 5000, offset, limit: size,
    nextOffset: offset + size, listRevision: "private-stable", scannedAt: "private-scan",
    items: Array.from({ length: size }, (_, i) => ({ id: `private-${offset + i}`, type: "movie", mediaKind: "movie", title: `Synthetic ${offset + i}`, size: 10000 })) });
  const render = () => h.module.api.channelViews.renderChannel({ mode: "movie" }, () => true);
  h.queue(payload(count)); await render(); assert.equal(h.els.viewContent.querySelectorAll(".channel-card").length, count, h.els.viewContent.textContent.slice(0, 600));
  const search = h.search(), label = h.els.viewMeta.querySelector(".media-list-count"); search.focus();
  const assertHeader = () => {
    assert.equal(h.search() === search, true, "Owned header retains the original search button");
    assert.equal(h.els.viewMeta.querySelector(".media-list-count") === label, true);
    assert.equal(h.document.activeElement === search, true); assert(h.document.body.contains(search));
    assert.equal(h.els.viewMeta.querySelectorAll("button").length, 1);
  };
  for (let i = 0; i < 3; i++) { h.header("movie", { ...payload(0), total: 5010 + i }); assertHeader(); }
  const pending = deferred(); h.setLimit(count + 48); h.queue(pending.promise);
  const task = render(); await tick(); assertHeader();
  assert.equal(h.els.viewContent.querySelectorAll(".channel-card").length, count);
  pending.resolve(payload(48, count)); await task; assertHeader();
  assert.equal(h.els.viewContent.querySelectorAll(".channel-card").length, count + 48);
  h.setLimit(count + 96); h.queue(new Error("Private failed tail")); await render(); assertHeader();
  assert.match(h.els.viewContent.querySelector(".channel-more").textContent, /重试/);
  h.queue(payload(48, count + 48)); await render(); assertHeader();
  assert.equal(h.els.viewContent.querySelectorAll(".channel-card").length, count + 96);
  h.setLimit(count + 144); h.cache({ updatedAt: "private", payload: payload(48, count + 96) });
  h.queue(new Error("Private cached-tail offline")); await render(); assertHeader();
  assert.equal(h.els.viewContent.querySelectorAll(".channel-card").length, count + 144);
  assert(label.textContent.includes(`已显示 ${formatNumber(count + 144)}`));
  const clicks = h.calls.openSearch; search.click(); assert.equal(h.calls.openSearch, clicks + 1, "Reuse never binds the search handler again");
});
test("mode and capability changes retain the original rebuild behavior", input => {
  const h = harness(input); h.header("movie", { total: 1, items: [] }); const movie = h.search();
  h.header("tv", { total: 2, items: [] }); const tv = h.search(); assert.notEqual(tv, movie);
  assert.equal(h.document.body.contains(movie), false); assert.equal(tv.getAttribute("aria-label"), "搜索电视剧");
  tv.click(); assert.equal(h.calls.openSearch, 1);
  h.header("photo", { total: 2, items: [] }); assert.equal(h.search(), null); assert.equal(h.document.body.contains(tv), false);
  const noSearch = harness(input, { search: false }); noSearch.header("movie", { total: 2, items: [] });
  assert.equal(noSearch.search(), null); assert.match(noSearch.els.viewMeta.textContent, /共 2/);
});
test("externally replaced header layout rebuilds once then resumes reuse", input => {
  const h = harness(input); h.header("movie", { total: 1, items: [] }); const first = h.search();
  h.els.viewMeta.append(h.document.createElement("div")); h.header("movie", { total: 2, items: [] });
  const next = h.search(); assert.notEqual(next, first); assert.equal(h.els.viewMeta.children.length, 2);
  h.header("movie", { total: 3, items: [] }); assert.equal(h.search(), next); next.click(); assert.equal(h.calls.openSearch, 1);
});
for (const mode of ["photo", "manga", "western"]) test(`${mode}: shared header never receives the media search button`, input => {
  const h = harness(input); h.header("movie", { total: 40, items: [] }); assert(h.search());
  h.header(mode, { total: 40, items: [{ id: "one" }], photoView: "albums" });
  assert.equal(h.els.viewMeta.querySelectorAll("button").length, 0); assert.match(h.els.viewMeta.textContent, /1 \/ 40/);
  assert.equal(h.calls.openSearch, 0);
});
test("media detail has no duplicated list-level top navigation", input => {
  const h = harness(input); h.c.currentView = "mediaDetail"; h.c.currentViewParams = { id: "synthetic", mode: "tv" };
  assert.equal(h.c.syncModuleChrome(), false); assert.equal(h.els.moduleChrome.hidden, true); assert.equal(h.els.moduleChrome.childElementCount, 0);
});
test("actual bottom menu retains photo manga movie tv anime destinations and selection", input => {
  const h = createGalleryHarness(input, { initialView: "channel", initialParams: { mode: "movie" } });
  h.context.openGalleryModePicker();
  assert.deepEqual(h.choices().map(node => node.dataset.galleryModeChoice), ["photo", "manga", "movie", "tv", "anime"]);
  assert.deepEqual(h.choices().map(node => node.querySelector("strong").textContent), ["套图", "韩漫", "电影", "电视剧", "动漫"]);
  for (const mode of ["tv", "anime"]) {
    h.context.openGalleryModePicker(); h.choices().find(node => node.dataset.galleryModeChoice === mode).click();
    assert.equal(h.route().view, "channel"); assert.equal(h.route().params.mode, mode); assert.equal(h.button().dataset.galleryModeCurrent, mode);
  }
});
for (const mode of ["movie", "tv", "anime", "media"]) test(`${mode}: actual loading and failed list retain functional inline search`, async input => {
  const h = harness(input, { mode });
  const render = h.module.api.channelViews.renderChannel({ mode }, () => true);
  assert.match(h.els.viewMeta.querySelector(".media-list-count")?.textContent || "", /正在读取/);
  assert(h.search(), "Search remains available before network settles"); h.search().click(); assert.equal(h.calls.openSearch, 1);
  await render;
  assert.equal(h.calls.network.length, 1); assert.match(h.els.viewMeta.querySelector(".media-list-count")?.textContent || "", /读取失败/);
  assert(h.search(), "Search remains available after a failed list read"); h.search().click(); assert.equal(h.calls.openSearch, 2);
  assert.match(h.els.viewContent.textContent, /合成电脑端暂时不可读/); assert.equal(h.els.moduleChrome.hidden, true);
});
for (const mode of ["movie", "tv", "anime", "media"]) test(`${mode}: actual cached list offline transition retains functional inline search`, async input => {
  const cached = { updatedAt: "2026-08-01T00:00:00Z", payload: { mode: mode === "anime" ? "media" : mode, ...(mode === "anime" ? { mediaKind: "anime" } : {}), total: 0, items: [], facets: {}, offset: 0 } };
  const h = harness(input, { mode, cached }); await h.module.api.channelViews.renderChannel({ mode }, () => true);
  assert.equal(h.calls.network.length, 1); assert.equal(h.els.viewMeta.querySelector(".media-list-count")?.textContent, "离线缓存");
  assert(h.search(), "Offline cache status must not erase relocated search"); h.search().click(); assert.equal(h.calls.openSearch, 1);
  assert.equal(h.els.viewMeta.querySelectorAll("button").length, 1); assert.equal(h.els.moduleChrome.hidden, true);
});
test("CSS defines a media-list-only 44px inline metadata/search contract", input => {
  const match = [...input.css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)].find(value => value[1].trim().startsWith('.content-panel[data-view="channel"]:is(')
    && value[1].trim().endsWith(") > .view-meta") && ["movie", "tv", "anime", "media"].every(mode => value[1].includes(`[data-channel-mode="${mode}"]`)));
  assert(match, "Inline metadata rule remains scoped to all four media list modes"); const block = match[2];
  assert.match(block, /display:\s*flex\s*;/); assert.match(block, /align-items:\s*center\s*;/);
  assert.match(block, /justify-content:\s*space-between\s*;/); assert.match(block, /min-height:\s*44px\s*;/);
  assert.match(input.css, /\.media-list-search\s*\{[^}]*flex:\s*0 0 44px\s*;/);
  assert.match(input.css, /\.search-expanded \.media-list-search\s*\{[^}]*visibility:\s*hidden\s*;/);
  // This checks selector/declaration intent only; root verifies actual row height
  // and absence of visual blank space using the rendered application/device.
});

let passed = 0, failed = 0, legacyRejected = 0, legacyHeaderRejected = 0, mutantsRejected = 0;
for (const item of tests) {
  try { await item.run(sources); passed++; console.log(`PASS ${item.name}`); }
  catch (error) { failed++; console.error(`FAIL ${item.name}\n${error.stack}`); }
}
if (!failed) {
  const method = /^  function setChannelMeta\(mode, text\) \{[^]*?^  \}/m.exec(sources.channel)?.[0]; assert(method);
  const old = { ...sources, channel: sources.channel.replace(method, () => LEGACY_SET_META) };
  let failure; try { await tests.find(item => item.name.startsWith("movie 500:")).run(old); } catch (error) { failure = error; }
  assert(failure instanceof assert.AssertionError, `Actual old header must fail identity/focus behavior: ${failure?.stack || "unexpected pass"}`);
  assert.match(failure.message, /Owned header retains the original search button/); legacyHeaderRejected++;
  console.log("REJECT actual old header discards focused search during metadata/loading updates");
}
if (!failed && LEGACY) {
  assert.equal(createHash("sha256").update(JSON.stringify(LEGACY)).digest("hex"), LEGACY_SHA256, "Frozen old actual chrome checksum");
  const oldMedia = sources.media.replace(appFunction(sources.media, "createMediaChrome"), () => LEGACY.chrome)
    + (sources.media.includes("function createMediaSearchButton(") ? "" : `\n${LEGACY.search}\n`);
  let failure; try { await tests.find(item => item.name.startsWith("movie: actual")).run({ ...sources, media: oldMedia }); } catch (error) { failure = error; }
  assert(failure instanceof assert.AssertionError, `Actual old chrome must fail DOM/visibility assertion: ${failure?.stack || "unexpected pass"}`);
  legacyRejected++; console.log("REJECT actual old duplicated top movie/tv navigation");
}
const mutants = [
  { name: "module drops inline search binding", key: "media", target: "movie: count", from: "openMediaSearch: host.ui.openSearch", to: "openMediaSearch: null" },
  { name: "inline button has no click action", key: "channel", target: "movie: count", from: '      search.addEventListener("click", openMediaSearch);', to: "" },
  { name: "loading erases relocated search", key: "channel", target: "movie: actual loading", from: 'setChannelMeta(normalizedMode, query ? "正在筛选" : "正在读取");', to: 'els.viewMeta.textContent = query ? "正在筛选" : "正在读取";' },
  { name: "failure erases relocated search", key: "channel", target: "movie: actual loading", from: 'setChannelMeta(normalizedMode, "读取失败");', to: 'els.viewMeta.textContent = "读取失败";' },
  { name: "offline status erases relocated search", key: "channel", target: "movie: actual cached", from: 'setChannelMeta(normalizedMode, "离线缓存");', to: 'els.viewMeta.textContent = "离线缓存";' }
];
if (!failed) for (const mutant of mutants) {
  try {
    assert.equal(sources[mutant.key].split(mutant.from).length - 1, 1, `Expected one actual mutation target: ${mutant.name}`);
    const changed = { ...sources, [mutant.key]: sources[mutant.key].replace(mutant.from, mutant.to) }; let failure;
    try { await tests.find(item => item.name.startsWith(mutant.target)).run(changed); } catch (error) { failure = error; }
    assert(failure instanceof assert.AssertionError, `Mutation must fail behavior assertion: ${mutant.name}: ${failure?.stack || "unexpected pass"}`);
    mutantsRejected++; console.log(`REJECT mutant ${mutant.name}`);
  } catch (error) { failed++; console.error(`FAIL mutant ${mutant.name}\n${error.stack}`); }
}
console.log(`Media header: ${passed}/${tests.length} scenarios; ${legacyRejected}/1 actual old chrome control; ${legacyHeaderRejected}/1 actual old header control; ${mutantsRejected}/${mutants.length} wiring mutants; ${failed} failures.`);
for (const key of ["channel", "media", "css"]) console.log(`${key} SHA256: ${createHash("sha256").update(sources[key]).digest("hex")}`);
process.exitCode = failed ? 1 : 0;
