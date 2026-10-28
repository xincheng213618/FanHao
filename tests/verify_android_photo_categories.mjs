import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createNavigationFixtureDocument } from "./fixtures/android-gallery-navigation-harness.mjs";
import { PHOTO_ALBUM_SORT_OPTIONS, PHOTO_COLLECTION_SORT_OPTIONS } from "../android-client/www/platform/content-index/photo-catalog.js";

// Actual complete photos adapter, shared action sheet and shell Back dispatcher.
// DOM/geometry, route rendering and content loading are synthetic boundaries.
// No browser/UI automation, media, service or database is used here.
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const source = read("android-client/www/modules/photos/android-module.js");
const sheetSource = read("android-client/www/js/mobile-action-sheet.js");
const appSource = read("android-client/www/app.js");
const styles = read("android-client/www/modules/photos/styles.css");
const strip = value => value.replace(/^import[^\n]*\n/gm, "").replace(/^export /gm, "");
const plain = value => JSON.parse(JSON.stringify(value));
const proto = Object.getPrototypeOf(createNavigationFixtureDocument().body), basicMatches = proto.matches;
proto.matches = function (selector) {
  if (selector.includes(":not(:disabled)")) return selector.split(",").some(part => !this.disabled
    && basicMatches.call(this, part.trim().replace(":not(:disabled)", "")));
  return basicMatches.call(this, selector);
};
const PRIORITY = ["我喜欢的", "all", "[XIUREN] 秀人网", "[COS]", "内购私拍", "日本写真集", "韩国写真集", "国模"];
const LABELS = ["我喜欢的", "全部", "秀人网", "COS", "内购私拍", "日本写真集", "韩国写真集", "国模"];

function fixture(input = source, sheet = sheetSource) {
  const document = createNavigationFixtureDocument(), listeners = new Map(), observers = [];
  document.activeElement = document.body;
  const create = document.createElement;
  document.createElement = tag => {
    const node = create(tag); node.disabled = false; node.scrollLeft = 0; node.clientWidth = 200;
    node.scrollIntoView = options => { node.scrolledIntoView = options; };
    Object.defineProperty(node, "offsetLeft", { get() { return node.parentNode?.classList.contains("photo-chrome-tabs") ? node.parentNode.children.indexOf(node) * 80 : 0; } });
    node.offsetWidth = 80;
    return node;
  };
  const window = {
    addEventListener(type, callback) { const values = listeners.get(type) || []; values.push(callback); listeners.set(type, values); },
    removeEventListener(type, callback) { listeners.set(type, (listeners.get(type) || []).filter(value => value !== callback)); },
    dispatchEvent(event) { for (const callback of [...listeners.get(event.type) || []]) callback(event); }
  };
  window.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
  };
  const container = document.createElement("header"), content = document.createElement("main");
  document.body.append(container, content);
  const calls = { routes: [], scrollTop: 0, search: 0, sort: [], content: 0, chrome: 0, deactivated: 0,
    modePickerClose: [], moduleBack: 0 };
  let params = { mode: "photo", category: "我喜欢的", photoView: "collections" }, view = "channel", channelContext;
  const context = vm.createContext({
    document, window, console, PHOTO_ALBUM_SORT_OPTIONS, PHOTO_COLLECTION_SORT_OPTIONS,
    createChannelViews(value) {
      channelContext = value;
      return { deactivate() { calls.deactivated++; }, renderChannel() { calls.content++; }, renderPhotoDetail() {}, renderMangaDetail() {}, renderMangaChapter() {} };
    }
  });
  const sheetApi = vm.runInContext(`(function(){${strip(sheet)};return {openMobileActionSheet,closeMobileActionSheet};})()`, context);
  Object.assign(context, sheetApi);
  const createModule = vm.runInContext(`(function(){${strip(input)};return createAndroidModule;})()`, context);
  const host = {
    els: { moduleChrome: container, viewContent: content }, getActiveUrl: () => "https://synthetic.invalid",
    normalizeChannelMode: value => value, limits: { getChannel: () => 24 },
    recent: { record() {} }, favorites: { onChannelFavoriteChange() {} }, mediaViewer: null,
    navigation: {
      currentView: () => view, currentParams: () => params, returnToStackView: () => false,
      showView(nextView, nextParams, options) {
        calls.routes.push(plain({ view: nextView, params: nextParams, options })); render(nextParams, nextView);
      }, goBack() {}, openInLibrary() {}
    },
    ui: {
      setActiveBottom() {}, renderCurrentView() {}, renderCurrentViewPreservingScroll() {}, confirm: async () => false,
      scrollToTop() { calls.scrollTop++; }, openSearch() { calls.search++; }, refreshChrome() { calls.chrome++; render(params, view); }
    },
    contentIndex: {
      updateChannelQuery() {}, updatePhotoSearch() {},
      updateChannelParams(updates) { calls.sort.push(plain(updates)); render({ ...params, ...updates }, view); }
    }
  };
  const module = createModule({ host });
  function render(nextParams = params, nextView = view) {
    view = nextView; params = nextParams;
    window.dispatchEvent({ type: "fanhaoViewWillRender" });
    container.replaceChildren();
    return module.renderChrome({ container, view, params });
  }
  const backStart = appSource.indexOf("window.fanhaoHandleNativeBack = () => {"), backEnd = appSource.indexOf("\n};", backStart);
  assert(backStart >= 0 && backEnd > backStart);
  Object.assign(context, {
    els: { appConfirmOverlay: { hidden: true }, settingsOverlay: { hidden: true } },
    mediaViewer: null, searchSurfaceExpanded: false, currentView: "channel", currentViewParams: params,
    // This category-sheet fixture has no global bottom-navigation picker.
    closeActiveModePicker(restoreFocus) { calls.modePickerClose.push(restoreFocus); return false; },
    androidModuleRegistry: { handleBack: () => { calls.moduleBack++; return false; } }, isRootNavigationView: () => true
  });
  vm.runInContext(appSource.slice(backStart, backEnd + 3), context);
  return {
    document, window, container, content, calls, module, render, observers, listeners, params: () => params,
    update(values, category) { channelContext.updateModuleChrome("photo", { category: category || params.category, facets: { categories: values.map(value => ({ value })) } }); },
    nav: () => container.querySelector(".photo-chrome-tabs"),
    trigger: () => container.querySelector(".photo-category-action"),
    overlay: () => document.querySelector(".mobile-action-sheet-overlay"),
    panel: () => document.querySelector(".photo-category-sheet"),
    closeButton: () => document.querySelector(".photo-category-close"),
    options: () => document.querySelectorAll(".mobile-action-sheet-option"),
    resize(width) {
      const nav = container.querySelector(".photo-chrome-tabs"); nav.clientWidth = width;
      if (window.ResizeObserver) observers.at(-1).callback([{ target: nav }]); else window.dispatchEvent({ type: "resize" });
    },
    open() { const trigger = container.querySelector(".photo-category-action"); assert(trigger, "Every photo catalog needs its visible category action"); trigger.click(); return trigger; },
    back: () => window.fanhaoHandleNativeBack(), close: sheetApi.closeMobileActionSheet,
    fire(node, type, values = {}) {
      const event = { type, bubbles: true, defaultPrevented: false, ...values,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
      node.dispatchEvent(event); return event;
    }
  };
}

const tests = [];
const test = (name, run) => tests.push({ name, run });
test("visible category action opens every priority category with current category focus", h => {
  h.render(); const trigger = h.open();
  assert(trigger.textContent.startsWith("分类")); assert.equal(trigger.getAttribute("aria-haspopup"), "dialog");
  assert(trigger.getAttribute("aria-label").includes("全部图库分类，当前我喜欢的"));
  assert.equal(h.panel().getAttribute("role"), "dialog"); assert.equal(h.panel().getAttribute("aria-modal"), "true");
  assert.deepEqual(h.options().map(button => button.textContent), LABELS);
  assert.equal(h.options()[0].getAttribute("aria-current"), "page");
  assert.equal(h.document.activeElement, h.options()[0]);
  assert.deepEqual(plain(h.options()[0].scrolledIntoView), { block: "nearest" });
  assert.equal(h.calls.routes.length, 0); assert.equal(h.calls.content, 0);
});
test("facets and unknown current category appear once and retain their raw routing identities", h => {
  h.render({ mode: "photo", category: "[PRIVATE] Unknown current", photoView: "collections" });
  h.update(["内购私拍", "[NEW] Long dynamic category", "[NEW] Long dynamic category", "", "[XIUREN] 秀人网"]);
  h.open();
  assert.deepEqual(h.options().map(button => button.textContent), [...LABELS, "Long dynamic category", "Unknown current"]);
  assert.equal(h.document.activeElement.textContent, "Unknown current");
  h.options().find(button => button.textContent === "Long dynamic category").click();
  assert.equal(h.calls.routes[0].params.category, "[NEW] Long dynamic category");
});
test("menu category selection and tab selection use the same catalog route and filter reset", h => {
  const params = { mode: "photo", category: "all", collection: "old-collection", photoView: "albums", person: "old-person", query: "old-query", sort: "title", retained: "keep" };
  h.render(params); h.open(); h.options().find(button => button.textContent === "内购私拍").click();
  const menuRoute = h.calls.routes.at(-1);
  assert.deepEqual(menuRoute, { view: "channel", params: { ...params, category: "内购私拍", collection: "", photoView: "collections", person: "", query: "", sort: "count" }, options: { skipHistory: true, replaceHistory: true } });
  assert.equal(h.overlay(), null); assert.equal(h.calls.scrollTop, 1);
  h.render(params); h.nav().querySelectorAll("button").find(button => button.textContent === "内购私拍").click();
  assert.deepEqual(h.calls.routes.at(-1), menuRoute); assert.equal(h.calls.scrollTop, 2);
});
test("selecting the current root category only scrolls to top", h => {
  h.render(); const originalNav = h.nav(), trigger = h.open(); h.options()[0].click();
  assert.equal(h.calls.routes.length, 0); assert.equal(h.calls.scrollTop, 1);
  assert.equal(h.nav(), originalNav); assert.equal(h.overlay(), null);
  assert.equal(h.document.activeElement, trigger, "A no-navigation selection returns focus to its still-current opener");
});
test("selecting current category from albums still returns to category collections", h => {
  h.render({ mode: "photo", category: "国模", photoView: "albums", collection: "collection", person: "person", query: "query" });
  h.open(); h.options().find(button => button.textContent === "国模").click();
  assert.equal(h.calls.routes[0].params.category, "国模"); assert.equal(h.calls.routes[0].params.photoView, "collections");
  assert.equal(h.calls.routes[0].params.collection, ""); assert.equal(h.calls.routes[0].params.query, "");
});
test("opening and closing the menu preserves horizontal category scroll and sort/search controls", h => {
  h.render({ mode: "photo", category: "[COS]", photoView: "collections" });
  const nav = h.nav(); nav.scrollLeft = 180; h.fire(nav, "scroll");
  h.open(); h.close(); h.render();
  assert.equal(h.nav().scrollLeft, 180);
  const selected = h.nav().querySelector("[aria-current='page']");
  assert(selected.offsetLeft >= h.nav().scrollLeft && selected.offsetLeft + selected.offsetWidth <= h.nav().scrollLeft + h.nav().clientWidth);
  h.container.querySelector(".photo-sort-action").click();
  assert.equal(h.panel(), null, "The sort sheet must never receive category-only layout rules");
  assert.equal(h.overlay().querySelector(".mobile-action-sheet-panel").getAttribute("aria-label"), "套图排序");
  assert.deepEqual(h.options().map(button => button.textContent), PHOTO_COLLECTION_SORT_OPTIONS.map(([, label]) => label));
  h.options().find(button => button.textContent === "名称排序").click();
  assert.deepEqual(h.calls.sort, [{ sort: "title" }]);
  h.container.querySelector(".photo-search-action").click(); assert.equal(h.calls.search, 1);
});
for (const method of ["native-back", "escape", "backdrop"]) test(`${method} dismisses the category dialog and restores explicit trigger focus`, h => {
  h.render(); const trigger = h.open();
  assert.notEqual(h.document.activeElement, trigger);
  if (method === "native-back") assert.equal(h.back(), true);
  if (method === "escape") assert.equal(h.fire(h.overlay(), "keydown", { key: "Escape" }).defaultPrevented, true);
  if (method === "backdrop") h.overlay().querySelector(".mobile-action-sheet-backdrop").click();
  assert.equal(h.overlay(), null); assert.equal(h.document.activeElement, trigger); assert.equal(h.calls.routes.length, 0);
  assert.deepEqual(h.calls.modePickerClose, [], "The category sheet is dismissed before consulting global navigation pickers");
  assert.equal(h.calls.moduleBack, 0, "The category sheet must consume native Back before module navigation");
  assert.equal(h.back(), false, "A closed menu must not swallow the shell's root fallback");
  assert.deepEqual(h.calls.modePickerClose, [true], "Closed category sheets allow the real dispatcher to consult the picker boundary with focus restoration");
  assert.equal(h.calls.moduleBack, 1, "Only the subsequent unconsumed Back reaches the module boundary");
});
test("reopening retires old menu options without closing or navigating the new dialog", h => {
  h.render(); h.open(); const old = h.options()[4]; h.open();
  const current = h.overlay(); old.click();
  assert.equal(h.overlay(), current); assert.equal(h.calls.routes.length, 0);
});
test("rerender retires old category trigger and tab buttons", h => {
  h.render(); const trigger = h.trigger(), tab = h.nav().querySelectorAll("button")[4];
  h.render({ mode: "photo", category: "all", photoView: "collections" });
  trigger.click(); tab.click();
  assert.equal(h.overlay(), null); assert.equal(h.calls.routes.length, 0);
  assert.equal(h.params().category, "all");
});
test("route and pagehide dismissal retire menu controls without stealing current focus", h => {
  for (const reason of ["route", "pagehide"]) {
    h.render({ mode: "photo", category: "我喜欢的", photoView: "collections" }); h.open(); const oldOption = h.options()[4];
    const current = h.document.createElement("input"); h.content.append(current); current.focus();
    if (reason === "route") h.render({ mode: "movie" }); else h.window.dispatchEvent({ type: "pagehide" });
    assert.equal(h.overlay(), null); assert.equal(h.document.activeElement, current);
    oldOption.click(); assert.equal(h.calls.routes.length, 0);
  }
});
test("category toolbar is restricted to photo channel pages", h => {
  for (const [view, mode] of [["photoDetail", "photo"], ["mangaDetail", "manga"], ["channel", "manga"], ["channel", "movie"], ["channel", "tv"]]) {
    assert.equal(h.render({ mode }, view), false); assert.equal(h.trigger(), null);
  }
});
test("many and long dynamic category names all reach the menu without truncating identifiers", h => {
  const values = Array.from({ length: 36 }, (_, index) => `[DYNAMIC] ${index} ${"合成长分类名称".repeat(6)}`);
  h.render(); h.update(values); h.open();
  assert.equal(h.options().length, PRIORITY.length + values.length);
  h.options().at(-1).click(); assert.equal(h.calls.routes[0].params.category, values.at(-1));
});
test("large category menus keep their title and explicit close control together and restore opener focus", h => {
  h.render(); h.update(Array.from({ length: 30 }, (_, index) => `合成分类${index + 1}`));
  const trigger = h.open(), panel = h.panel(), head = panel.querySelector(".photo-category-sheet-head");
  assert(head, "The scrolling category dialog needs its own visible header");
  assert.equal(panel.querySelectorAll(".mobile-action-sheet-head").length, 1);
  assert.equal(panel.querySelectorAll(".photo-category-sheet-head").length, 1);
  assert.equal(panel.querySelector(".mobile-action-sheet-head"), head);
  assert.equal(panel.children[0], head); assert.equal(head.querySelector("strong").textContent, "全部图库分类");
  const close = h.closeButton(); assert.equal(head.contains(close), true);
  assert.equal(panel.querySelectorAll(".mobile-action-sheet-close").length, 1);
  assert.equal(panel.querySelectorAll(".photo-category-close").length, 1);
  assert.equal(panel.querySelector(".mobile-action-sheet-close"), close);
  assert.equal(close.textContent, "关闭"); assert.equal(close.getAttribute("aria-label"), "关闭图库分类");
  assert.equal(close.type, "button"); assert.equal(h.options().length, 38);
  panel.scrollTop = 480; close.click();
  assert.equal(h.overlay(), null); assert.equal(h.document.activeElement, trigger); assert.equal(h.calls.routes.length, 0);
  const sortTrigger = h.container.querySelector(".photo-sort-action"); sortTrigger.focus(); sortTrigger.click();
  const sortPanel = h.overlay().querySelector(".mobile-action-sheet-panel");
  assert.equal(sortPanel.querySelectorAll(".mobile-action-sheet-head").length, 1);
  assert.equal(sortPanel.querySelectorAll(".mobile-action-sheet-close").length, 1);
  const sortHead = sortPanel.querySelector(".mobile-action-sheet-head"), sortClose = sortPanel.querySelector(".mobile-action-sheet-close");
  assert.equal(sortPanel.children[0], sortHead); assert.equal(sortHead.querySelector("strong").textContent, "套图排序");
  assert.equal(sortHead.contains(sortClose), true); assert.equal(sortClose.textContent, "关闭");
  assert.equal(sortClose.getAttribute("aria-label"), "关闭套图排序");
  assert.equal(h.document.querySelector(".photo-category-sheet-head"), null, "Sorting sheets must not receive category-only header styling");
  assert.equal(h.closeButton(), null);
  sortClose.click(); assert.equal(h.overlay(), null); assert.equal(h.document.activeElement, sortTrigger);
});
test("retired category close controls cannot close a newer dialog or steal its focus", h => {
  h.render(); h.open(); const oldClose = h.closeButton(); h.open();
  const current = h.overlay(), focus = h.document.activeElement;
  oldClose.click(); assert.equal(h.overlay(), current); assert.equal(h.document.activeElement, focus);
  h.render({ mode: "movie" }); oldClose.click();
  assert.equal(h.overlay(), null); assert.equal(h.calls.routes.length, 0);
});
test("a selected long category keeps its full beginning and accessible name after the menu closes", h => {
  const label = "合成分类30" + "一项超长中文名称".repeat(12);
  h.render(); h.update(Array.from({ length: 29 }, (_, index) => `合成分类${index + 1}`).concat(label));
  h.open(); assert.equal(h.options().at(-1).textContent, label); h.options().at(-1).click();
  const selected = h.nav().querySelector("[aria-current='page']");
  assert.equal(selected.textContent, label, "Ellipsis is visual only; the label must never be rewritten to its suffix");
  assert.equal(selected.getAttribute("aria-label"), label);
  assert(h.trigger().getAttribute("aria-label").endsWith(label));
  h.open(); assert.equal(h.document.activeElement.textContent, label);
  assert.equal(h.panel().querySelector("[aria-current='page']").textContent, label);
});
test("shrinking the existing toolbar reveals its current category without rerendering or navigating", h => {
  h.render(); h.open(); h.options().find(button => button.textContent === "日本写真集").click();
  const nav = h.nav(), selected = nav.querySelector("[aria-current='page']");
  const routes = h.calls.routes.length;
  assert(selected.offsetLeft >= nav.scrollLeft && selected.offsetLeft + selected.offsetWidth <= nav.scrollLeft + nav.clientWidth);
  nav.scrollLeft = 0; h.resize(120);
  assert.equal(h.nav(), nav, "Viewport resize must retain the mounted toolbar");
  assert(selected.offsetLeft >= nav.scrollLeft && selected.offsetLeft + selected.offsetWidth <= nav.scrollLeft + nav.clientWidth,
    "The current Japanese category must remain visible after shrinking the scroll viewport");
  assert.equal(h.calls.routes.length, routes); assert.equal(h.calls.content, 0);
});
test("width observers preserve manual scroll for unchanged widths and remember a still-visible offset", h => {
  h.render({ mode: "photo", category: "日本写真集", photoView: "collections" });
  const nav = h.nav(); nav.scrollLeft = 300; h.fire(nav, "scroll");
  h.resize(240); assert.equal(nav.scrollLeft, 300);
  nav.scrollLeft = 350; h.fire(nav, "scroll");
  h.resize(240); assert.equal(nav.scrollLeft, 350, "A same-width observer delivery must not snap manual scrolling");
  h.render(); assert.equal(h.nav().scrollLeft, 350);
});
test("hidden-width deliveries keep scroll memory until the toolbar is visible again", h => {
  h.render({ mode: "photo", category: "日本写真集", photoView: "collections" });
  const nav = h.nav(), before = nav.scrollLeft;
  h.resize(0); assert.equal(nav.scrollLeft, before);
  nav.scrollLeft = 0; h.resize(120);
  const selected = nav.querySelector("[aria-current='page']");
  assert(selected.offsetLeft >= nav.scrollLeft && selected.offsetLeft + selected.offsetWidth <= nav.scrollLeft + nav.clientWidth);
});
test("replaced toolbar observers disconnect and cannot change current scroll or its saved offset", h => {
  h.render({ mode: "photo", category: "日本写真集", photoView: "collections" });
  const oldNav = h.nav(), oldObserver = h.observers.at(-1);
  h.render({ mode: "photo", category: "[COS]", photoView: "collections" });
  const current = h.nav(), currentScroll = current.scrollLeft;
  assert.equal(oldObserver.disconnected, true);
  oldNav.clientWidth = 80; oldNav.scrollLeft = 777;
  oldObserver.callback([{ target: oldNav }]); h.fire(oldNav, "scroll");
  assert.equal(oldNav.scrollLeft, 777, "A retired observer must not manipulate its detached toolbar");
  assert.equal(current.scrollLeft, currentScroll);
  h.render(); assert.equal(h.nav().scrollLeft, currentScroll, "Retired scroll events must not overwrite saved category position");
});
test("module deactivation retires width callbacks even while the old toolbar remains connected", h => {
  h.render({ mode: "photo", category: "日本写真集", photoView: "collections" });
  const nav = h.nav(), observer = h.observers.at(-1), trigger = h.trigger();
  h.module.deactivate(); assert.equal(observer.disconnected, true); assert.equal(h.calls.deactivated, 1);
  nav.clientWidth = 80; nav.scrollLeft = 777;
  observer.callback([{ target: nav }]); h.fire(nav, "scroll"); trigger.click();
  assert.equal(nav.scrollLeft, 777); assert.equal(h.overlay(), null);
  h.render({ mode: "photo", category: "[COS]", photoView: "collections" });
  assert.notEqual(h.nav().scrollLeft, 777);
});
test("fallback resize listener stays bounded and is removed on rerender, non-photo pages and deactivation", h => {
  delete h.window.ResizeObserver;
  h.render({ mode: "photo", category: "日本写真集", photoView: "collections" });
  const nav = h.nav(), oldListener = h.listeners.get("resize")[0];
  nav.scrollLeft = 0; h.resize(120); assert(nav.scrollLeft > 0);
  assert.equal(h.listeners.get("resize").length, 1);
  h.render(); assert.equal(h.listeners.get("resize").length, 1);
  nav.scrollLeft = 777; nav.clientWidth = 80; oldListener(); assert.equal(nav.scrollLeft, 777);
  h.render({ mode: "movie" }); assert.equal(h.listeners.get("resize").length, 0);
  h.render({ mode: "photo", category: "日本写真集", photoView: "collections" });
  h.module.deactivate(); assert.equal(h.listeners.get("resize").length, 0);
});

try {
  for (const { name, run } of tests) {
    const h = fixture(); try { run(h); } finally { h.close(false); h.module.deactivate(); }
    console.log(`photo-categories: ${name}: ok`);
  }
  const scoped = selector => {
    const match = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]+)\\}`).exec(styles);
    assert(match, selector); return match[1];
  };
  assert.match(scoped(".photo-feed-appbar .photo-category-action"), /width:\s*54px/);
  assert.match(scoped(".photo-feed-appbar .photo-category-action"), /min-height:\s*44px/);
  assert.match(scoped(".photo-category-sheet"), /max-height:\s*calc\(100dvh[^;]+safe-area-inset-top/);
  assert.match(scoped(".photo-category-sheet"), /overflow-y:\s*auto/);
  assert.match(scoped(".photo-category-sheet"), /scroll-padding-top:\s*72px/);
  assert.match(scoped(".photo-category-sheet-head"), /position:\s*sticky/);
  assert.match(scoped(".photo-category-sheet-head"), /top:\s*0\s*;/);
  assert.match(scoped(".photo-category-sheet-head .photo-category-close"), /min-height:\s*44px/);
  assert.match(scoped(".photo-chrome-tabs > button"), /max-width:\s*100%/);
  assert.match(scoped(".photo-chrome-tabs > button"), /text-overflow:\s*ellipsis/);
  assert.match(scoped(".photo-chrome-tabs > button"), /white-space:\s*nowrap/);
  assert.match(scoped(".photo-category-sheet .mobile-action-sheet-option"), /white-space:\s*normal/);
  assert.match(scoped(".photo-category-sheet .mobile-action-sheet-option"), /overflow-wrap:\s*anywhere/);
  assert(!styles.includes(".fanhao-sort-sheet"), "The category stylesheet must not override existing sorting sheets");

  const controls = [
    ["missing fixed entry", source.replace('actions.append(createPhotoCategoryButton(categories, activeCategory, selectCategory, () => {', 'actions.append((false ? createPhotoCategoryButton(categories, activeCategory, selectCategory, () => {').replace('      }), createPhotoSortButton(host, params), createPhotoSearchButton(host));', '      }) : document.createElement("span")), createPhotoSortButton(host, params), createPhotoSearchButton(host));'), tests[0]],
    ["dynamic categories omitted", source.replace('...latestCategories.map((item) => item.value).filter(Boolean)', '...[]'), tests[1]],
    ["category route keeps collection", source.replace('          collection: "",\n          category,', '          collection: params.collection,\n          category,'), tests[2]],
    ["retired row accepts clicks", source.replace('const isCurrent = () => generation === chromeGeneration && container.contains(row);', 'const isCurrent = () => true;'), tests.find(test => test.name === "rerender retires old category trigger and tab buttons")],
    ["width callback omits reveal", source.replace('        categoryWidth = nav.clientWidth;\n        revealSelectedCategory();', '        categoryWidth = nav.clientWidth;'), tests.find(test => test.name === "shrinking the existing toolbar reveals its current category without rerendering or navigating")],
    ["deactivation leaves width callback owned", source.replace('    chromeGeneration++;', '    /* generation retirement omitted */'), tests.find(test => test.name === "module deactivation retires width callbacks even while the old toolbar remains connected")],
    ["retired close targets global current sheet", source, tests.find(test => test.name === "retired category close controls cannot close a newer dialog or steal its focus"), sheetSource.replace('closeButton.addEventListener("click", () => close());', 'closeButton.addEventListener("click", () => closeMobileActionSheet());')],
    ["long category loses its full accessible label", source.replace('        button.setAttribute("aria-label", photoCategoryLabel(category));', ''), tests.find(test => test.name === "a selected long category keeps its full beginning and accessible name after the menu closes")]
  ];
  for (const [name, input, testCase, sheet = sheetSource] of controls) {
    assert(input !== source || sheet !== sheetSource, `${name}: mutation must change current source`);
    const h = fixture(input, sheet);
    try { assert.throws(() => testCase.run(h), { name: "AssertionError" }, name); } finally { h.close(false); h.module.deactivate(); }
  }
  console.log(`android-photo-categories: ${tests.length} VM scenarios, CSS contracts and ${controls.length} behavioral negative controls: ok`);
} finally {
  proto.matches = basicMatches;
}
