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

function harness(input = sources, { mode = "movie", cached = null } = {}) {
  const document = createNavigationFixtureDocument(), proto = Object.getPrototypeOf(document.body);
  if (!Object.getOwnPropertyDescriptor(proto, "childElementCount")) Object.defineProperty(proto, "childElementCount", { get() { return this.children.length; } });
  const els = Object.fromEntries(["viewContent", "viewTitle", "viewMeta", "viewKicker", "contentPanel", "moduleChrome"].map(key => [key, document.createElement("div")]));
  document.body.append(...Object.values(els));
  const calls = { openSearch: 0, navigation: [], network: [] };
  const c = vm.createContext({ document, console, URL, URLSearchParams, formatBytes, formatDate, formatNumber, formatTime, absoluteUrl,
    captureMediaTrail, mediaBackTarget, cacheAgeText: () => "合成缓存时间", window: { history: { back() {} } },
    isChannelFavorite: () => false, toggleChannelFavorite: () => ({ favorite: true, items: [] }),
    photoCatalogCollections: items => items, loadPreviewImage() {}, enhanceAutoLoadMore() {},
    fetchJson: async (...args) => { calls.network.push(args); throw new Error("合成电脑端暂时不可读"); },
    readCachedJson: async () => cached, writeCachedJson: async () => {},
    els, currentView: "channel", currentViewParams: { mode }
  });
  const marker = /  return \{\r?\n    deactivate: resetMangaReaderProgressTracker,/;
  assert(marker.test(input.channel), "Private header exposure requires the exact real factory return");
  const channel = input.channel.replace(marker, "  return {\n    __testApplyHeader: applyChannelHeader,\n    deactivate: resetMangaReaderProgressTracker,");
  vm.runInContext(strip(channel), c, { filename: "actual-channel-views.js" });
  vm.runInContext(appFunction(input.registry, "createRegistry") + "\n" + appFunction(input.app, "syncModuleChrome"), c);
  const host = {
    els, normalizeChannelMode: c.normalizeChannelMode, getActiveUrl: () => "https://synthetic.invalid",
    limits: { getChannel: () => 40, increaseChannel() {} }, recent: { record() {} }, favorites: { onChannelFavoriteChange() {} },
    navigation: { currentView: () => c.currentView, currentParams: () => c.currentViewParams, returnToStackView: () => false,
      showView: (...args) => calls.navigation.push(plain(args)), goBack() {}, openInLibrary() {} },
    ui: { setActiveBottom() {}, scrollToTop() {}, renderCurrentView() {}, renderCurrentViewPreservingScroll() {},
      refreshChrome: () => c.syncModuleChrome(), openSearch: () => { calls.openSearch++; } },
    contentIndex: { updateChannelQuery() {}, updateChannelParams() {}, updateSearch() {} }
  };
  const factory = vm.runInContext(`(function(){\n${strip(input.media)}\nreturn createAndroidModule;\n})()`, c);
  const module = factory({ host });
  c.androidModuleRegistry = c.createRegistry([{ ...module, id: "media" }]);
  return { c, document, els, module, calls, host,
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
test("repeated header updates replace count and search without duplicate live buttons", input => {
  const h = harness(input); h.header("movie", { total: 1, items: [{ id: "one" }] });
  h.header("movie", { total: 200, items: [] }); h.header("movie", { total: 3, items: [] });
  assert.equal(h.els.viewMeta.querySelectorAll("button").length, 1); assert.match(h.els.viewMeta.querySelector("span").textContent, /共 3/);
  h.search().click(); assert.equal(h.calls.openSearch, 1);
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

let passed = 0, failed = 0, legacyRejected = 0, mutantsRejected = 0;
for (const item of tests) {
  try { await item.run(sources); passed++; console.log(`PASS ${item.name}`); }
  catch (error) { failed++; console.error(`FAIL ${item.name}\n${error.stack}`); }
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
console.log(`Media header: ${passed}/${tests.length} scenarios; ${legacyRejected}/1 actual old chrome control; ${mutantsRejected}/${mutants.length} wiring mutants; ${failed} failures.`);
for (const key of ["channel", "media", "css"]) console.log(`${key} SHA256: ${createHash("sha256").update(sources[key]).digest("hex")}`);
process.exitCode = failed ? 1 : 0;
