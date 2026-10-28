import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import * as mediaNavigationState from "../../android-client/www/js/media-navigation-state.js";
import { createChannelHistoryState } from "../../android-client/www/js/channel-history-state.js";
import { accountPayloadOwner, captureAccountOwner, isAccountOwnerCurrent, prepareAccountOwner } from "../../android-client/www/js/account-owner.js";
import { captureCachedJsonFence } from "../../android-client/www/js/cache.js";

export const channelAccountBoundary = Object.freeze({
  accountPayloadOwner, captureAccountOwner, isAccountOwnerCurrent, prepareAccountOwner, captureCachedJsonFence
});

// Deterministic DOM/event/clock boundaries only. Production constructs the menu,
// navigation buttons and media route adapter; no browser, network or device runs.
const dataName = name => name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
class Events {
  constructor() { this.listeners = new Map(); this.listenerCaptures = new Map(); }
  addEventListener(type, handler, options = {}) {
    if (!this.listeners.has(type)) { this.listeners.set(type, []); this.listenerCaptures.set(type, []); }
    this.listeners.get(type).push(handler);
    this.listenerCaptures.get(type).push(options === true || options.capture === true);
  }
  dispatchEvent(event) {
    event.target ||= this;
    const path = [];
    for (let node = this; node; node = node.parentNode) path.push(node);
    const invoke = (node, capture) => {
      event.currentTarget = node;
      for (const [index, handler] of (node.listeners.get(event.type) || []).entries()) {
        if (node.listenerCaptures.get(event.type)?.[index] === capture) handler(event);
      }
    };
    for (const node of [...path].reverse()) { invoke(node, true); if (event.stopped) return !event.defaultPrevented; }
    for (const node of path) { invoke(node, false); if (event.stopped || !event.bubbles) break; }
    return !event.defaultPrevented;
  }
}
class Element extends Events {
  constructor(tag, document) {
    super(); this.tagName = tag.toUpperCase(); this.ownerDocument = document;
    this.children = []; this.parentNode = null; this.dataset = {}; this.attributes = new Map();
    this.className = ""; this.hidden = false; this._text = ""; this._html = "";
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(" "); },
      toggle: (name, force) => { const on = force === undefined ? !this.classList.contains(name) : Boolean(force); this.classList[on ? "add" : "remove"](name); return on; }
    };
  }
  set innerHTML(value) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ""; this._html = String(value); }
  get innerHTML() { return this._html; }
  set textContent(value) { this.innerHTML = ""; this._text = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
  append(...children) {
    for (const child of children) {
      if (child.tagName === "#FRAGMENT") { this.append(...[...child.children]); continue; }
      if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(item => item !== child);
      child.parentNode = this; this.children.push(child);
    }
  }
  replaceChildren(...children) { this.innerHTML = ""; this.append(...children); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
  before(...nodes) {
    const parent = this.parentNode; if (!parent) return;
    for (const node of nodes) {
      node.remove(); node.parentNode = parent;
      parent.children.splice(parent.children.indexOf(this), 0, node);
    }
  }
  replaceWith(node) { this.before(node); this.remove(); }
  focus() { this.ownerDocument.activeElement = this; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name.startsWith("data-")) this.dataset[dataName(name)] = String(value);
    if (name === "class") this.className = String(value);
    if (name === "title") this.title = String(value);
  }
  getAttribute(name) { if (name.startsWith("data-")) return this.dataset[dataName(name)] ?? null; if (name === "class") return this.className; return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); if (name.startsWith("data-")) delete this.dataset[dataName(name)]; }
  matches(selector) {
    return selector.split(",").some(raw => {
      const value = raw.trim();
      const match = /^(\w+)?((?:\.[\w-]+)*)(?:\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\])?$/.exec(value);
      assert(match, `Unsupported fixture selector: ${value}`);
      return (!match[1] || this.tagName === match[1].toUpperCase())
        && (!match[2] || match[2].slice(1).split(".").every(name => this.classList.contains(name)))
        && (!match[3] || (this.getAttribute(match[3]) !== null && (match[4] === undefined || this.getAttribute(match[3]) === match[4])));
    });
  }
  querySelectorAll(selector) {
    const direct = /^:scope\s*>\s*(.+)$/.exec(selector);
    if (direct) return this.children.filter(child => child.matches(direct[1]));
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest?.(selector) || null; }
  click() { return this.dispatchEvent(event("click", this)); }
}
function event(type, target, values = {}) {
  return { type, target, bubbles: true, defaultPrevented: false, ...values,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
}

export function appFunction(source, name) {
  const found = new RegExp(`^function ${name}\\(`, "m").exec(source);
  assert(found, `Missing real shell function ${name}`);
  const tail = source.slice(found.index), end = /^\}/m.exec(tail);
  assert(end, `Missing top-level close for ${name}`);
  return tail.slice(0, end.index + 1);
}
const constant = (source, name) => {
  const found = new RegExp(`^const ${name} =[^]*?;(?=\\r?\\n)`, "m").exec(source);
  assert(found, `Missing production constant ${name}`); return found[0];
};
export function createNavigationFixtureDocument() {
  const document = new Events(); document.body = new Element("body", document); document.body.parentNode = document;
  document.querySelector = selector => document.body.querySelector(selector);
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  document.createElement = tag => new Element(tag, document);
  document.createDocumentFragment = () => new Element("#fragment", document);
  return document;
}
export function createGalleryHarness(sources, { storage = new Map(), fallback = false, initialView = "people", initialParams = {} } = {}) {
  const document = createNavigationFixtureDocument();
  // Connectivity is local to the shell harness. Other module fixtures extend
  // this DOM prototype independently, so do not change its shared contract.
  const createElement = document.createElement;
  document.createElement = tag => {
    const node = createElement(tag);
    Object.defineProperty(node, "isConnected", { get: () => document.body.contains(node) });
    node.getClientRects = () => {
      for (let ancestor = node; ancestor; ancestor = ancestor.parentNode) if (ancestor.hidden || ancestor.inert) return [];
      return node.isConnected ? [{}] : [];
    };
    return node;
  };
  document.activeElement = document.body;
  const bar = document.createElement("nav"); document.body.append(bar);
  const clocks = new Map(); let clockId = 0;
  const observations = { renders: [], media: [], scrolls: 0, histories: [], unrelated: [], back: [] };
  const no = () => {};
  const context = {
    ...mediaNavigationState,
    ...channelAccountBoundary,
    document, console, URL, URLSearchParams, Date, Set, Map,
    currentView: initialView, currentViewParams: initialParams, viewStack: [], searchSurfaceExpanded: false, viewRenderToken: 0,
    // Limit reset/rendering remains an unrelated boundary in menu-only tests.
    // Use the remote-channel default, with a fresh real session store per shell;
    // range restoration itself is covered by the separate return-range verifier.
    activeUrl: "https://synthetic.invalid", channelLimit: 36, channelHistoryState: createChannelHistoryState(),
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    LAST_VIEW_STORAGE_KEY: "fixture.last-view", DEFAULT_VIEW: "people", DEFAULT_PHOTO_CATEGORY: "我喜欢的",
    navigator: { vibrate: no }, window: Object.assign(new Events(), { setTimeout(fn, delay) { const id = ++clockId; clocks.set(id, { fn, delay }); return id; }, clearTimeout(id) { clocks.delete(id); },
      history: { state: { marker: "menu-fixture" }, length: 1, back: () => observations.back.push("history") } }),
    HISTORY_MARKER: "menu-fixture", mediaViewer: { close: () => false },
    // Settings is closed in these menu/media fixtures; its real focus and
    // history lifecycle is exercised by verify_android_settings_focus.mjs.
    settingsDialogFocus: { current: () => null, owns: () => false }, closingSettingsSession: null,
    hideSettingsSurface: no,
    els: { bottomNavBar: bar, bottomNav: [], viewContent: document.createElement("main"), settingsOverlay: { hidden: true },
      appConfirmOverlay: { hidden: true }, profileSettingsButton: null },
    shouldPreserveShortVideoHome: () => false, rememberCurrentScrollInHistory: no, currentScrollY: () => 0,
    resetViewLimitsForView: no, queueScrollRestore: no,
    // Geometry is outside these navigation fixtures; its real observer and
    // lifecycle have a separate bottom-layout metrics/browser verifier.
    bottomLayout: { refresh: no },
    pushViewHistory: (...args) => observations.histories.push(args), replaceCurrentHistory: no,
    scrollToTopInstant: () => { observations.scrolls++; }, readViewStateFromHash: () => null,
    toggleSettings: () => observations.unrelated.push("settings"),
    settleAppConfirmation() { observations.back.push("confirmation"); context.els.appConfirmOverlay.hidden = true; },
    closeSettings() { observations.back.push("settings"); context.els.settingsOverlay.hidden = true; },
    closeSearchSurface() { observations.back.push("search"); context.searchSurfaceExpanded = false; },
    returnToStackView() { observations.back.push("stack"); return false; },
    applyBackState() { observations.back.push("fallback"); },
    renderCurrentView() {
      // Content rendering is a boundary; advance the real shell's owner token
      // at that boundary without reimplementing any menu state or callbacks.
      context.viewRenderToken++;
      observations.renders.push({ view: context.currentView, params: structuredClone(context.currentViewParams) });
      context.setActiveBottom();
      context.androidModuleRegistry.render(context.currentView, context.currentViewParams, () => true);
    },
    createChannelViews(channelContext) {
      observations.channelContext = channelContext;
      return {
        renderChannel(params) { observations.media.push({ kind: "channel", params: structuredClone(params) }); },
        renderMediaDetail(id, mode) { observations.media.push({ kind: "detail", id, mode }); }
      };
    }
  };
  vm.createContext(context);
  // The shell Back dispatcher now owns the real shared-sheet close contract.
  // Bind its production implementation to this fixture's document/window.
  const sheetSource = readFileSync(new URL("../../android-client/www/js/mobile-action-sheet.js", import.meta.url), "utf8").replace(/^export /gm, "");
  Object.assign(context, vm.runInContext(`(function(){${sheetSource}\nreturn { openMobileActionSheet, closeMobileActionSheet };})()`, context));
  const menuNames = [...sources.app.matchAll(/^function (\w*(?:[Gg]allery|[Hh]omeMode|[Rr]eadingMode|[Mm]odePicker|[Bb]ottomNav)\w*)\(/gm)].map(match => match[1]);
  const names = [...new Set([...menuNames, "homeNavigationButton", "readingNavigationButton", "isNovelNavigationView", "isRootNavigationView", "normalizeChannelMode", "normalizeChannelSort", "primaryChannelMode", "bottomNavKeyFor", "setActiveBottom",
    "sanitizeViewParams", "showView", "showPrimaryView", "rememberViewState", "shouldRememberView", "readLastViewState", "defaultViewState", "readInitialViewState",
    "captureChannelRange", "restoreChannelRange", "sameViewParams", "viewRouteHash"] )];
  const constantNames = ["HOME_MODE_STORAGE_KEY", "HOME_MODES", "READING_MODE_STORAGE_KEY", "READING_MODES", "GALLERY_MODE_STORAGE_KEY", "GALLERY_MODES", "RESTORABLE_VIEWS"];
  if (sources.app.includes("const GALLERY_MODE_OPTIONS =")) constantNames.splice(1, 0, "GALLERY_MODE_OPTIONS");
  const lifecycleStart = sources.app.indexOf('window.addEventListener("fanhaoViewWillRender", retireModePickerSession);');
  const bottomStart = lifecycleStart >= 0 ? lifecycleStart : sources.app.indexOf('els.bottomNavBar?.addEventListener("selectstart"');
  const menuState = [...sources.app.matchAll(/^let \w*(?:[Mm]odePicker|[Bb]ottomNav)\w* =[^;\n]+;/gm)]
    .filter(match => match.index < bottomStart).map(match => match[0]);
  vm.runInContext(constantNames.map(name => constant(sources.app, name)).join("\n") + "\n" + menuState.join("\n") + "\n" + names.map(name => appFunction(sources.app, name)).join("\n"), context);
  const moduleScript = (text, result) => `(function(){\n${text.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "")}\nreturn ${result};\n})()`;
  context.navigation = vm.runInContext(moduleScript(sources.navigation, "{ renderAndroidModuleNavigation }"), context);
  context.registryApi = vm.runInContext(moduleScript(sources.registry, "{ androidModuleFallbackCatalog, normalizeModule, createRegistry }"), context);
  context.mediaFactory = vm.runInContext(moduleScript(sources.media, "createAndroidModule"), context);
  const host = {
    els: context.els, normalizeChannelMode: context.normalizeChannelMode, getActiveUrl: () => "https://synthetic.invalid",
    limits: {}, navigation: { showView: context.showView,
      currentView: () => context.currentView, currentParams: () => context.currentViewParams,
      hasBackStack: () => context.viewStack.length > 0,
      returnToStackView: (...args) => context.returnToStackView?.(...args) || false,
      goBack: () => context.goBack() },
    ui: { setActiveBottom: context.setActiveBottom, scrollToTop: context.scrollToTopInstant, openSearch: no },
    recent: {}, favorites: {}, contentIndex: {
      updateChannelParams: (params = {}, navigation = {}) => context.showView("channel", { ...context.currentViewParams, ...params }, { skipHistory: true, replaceHistory: true, ...navigation })
    }
  };
  const definitions = context.registryApi.androidModuleFallbackCatalog();
  const media = context.registryApi.normalizeModule(context.mediaFactory({ host }), definitions.find(value => value.id === "media"));
  const photos = { id: "photos", bottomKey: "photo", rootViews: new Set(["channel"]), routes: [
    { view: "channel", match: params => ["photo", "manga"].includes(params.mode), render: no },
    ...["photoDetail", "mangaDetail", "mangaChapter"].map(view => ({ view, render: no }))
  ] };
  // Home/reading content and their module Back actions remain explicit shell
  // boundaries. The real registry still resolves their root metadata.
  const boundary = (id, bottomKey, views) => ({ id, bottomKey, rootViews: new Set(views), routes: views.map(view => ({ view, render: no })) });
  const realRegistry = context.registryApi.createRegistry([photos, media,
    boundary("fanhao", "fanhao", ["people", "works", "categories", "rankings", "history"]),
    boundary("novels", "novels", ["novels"]), boundary("music", "music", ["music"])]);
  context.androidModuleRegistry = { ...realRegistry,
    handleBack(...args) { observations.back.push("module"); return realRegistry.handleBack(...args); } };
  if (fallback) {
    // Decode only the existing fallback button attributes and text label, not its
    // decorative SVG. The generated navigation path above executes in full.
    for (const match of sources.index.matchAll(/<button\b([^>]*class="bottom-nav-item[^>]*)>([^]*?)<\/button>/g)) {
      const button = document.createElement("button");
      for (const attribute of match[1].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) button.setAttribute(attribute[1], attribute[2] ?? "");
      const label = document.createElement("span"); label.className = "bottom-nav-label";
      label.textContent = /class="bottom-nav-label">([^<]*)</.exec(match[2])?.[1] || "";
      button.append(label); bar.append(button);
    }
    context.els.bottomNav = [...bar.querySelectorAll("button")];
  } else context.els.bottomNav = context.navigation.renderAndroidModuleNavigation(bar, definitions);
  const start = bottomStart;
  const end = sources.app.indexOf("for (const button of els.themeButtons)", start);
  assert(start >= 0 && end > start, "Bottom navigation event registration boundary changed");
  vm.runInContext(sources.app.slice(start, end), context, { filename: "actual-bottom-nav-events.js" });
  const backStart = sources.app.indexOf("window.fanhaoHandleNativeBack = () => {");
  const backEnd = /\r?\n};/.exec(sources.app.slice(backStart));
  assert(backStart >= 0 && backEnd, "The actual shell NativeBack dispatcher exists");
  vm.runInContext(sources.app.slice(backStart, backStart + backEnd.index + backEnd[0].length), context, { filename: "actual-shell-native-back.js" });
  const escapeAnchor = sources.app.indexOf('els.appConfirmOverlay?.addEventListener("keydown"');
  const escapeStart = sources.app.indexOf('document.addEventListener("keydown"', escapeAnchor);
  const escapeEnd = sources.app.indexOf("els.searchCloseButton", escapeStart);
  assert(escapeAnchor >= 0 && escapeStart > escapeAnchor && escapeEnd > escapeStart, "The actual document Escape listener exists");
  vm.runInContext(sources.app.slice(escapeStart, escapeEnd), context, { filename: "actual-shell-escape-listener.js" });
  context.setActiveBottom();
  return {
    context, document, storage, observations, names, bar, host,
    button: () => context.galleryNavigationButton(),
    picker: () => bar.querySelector(".bottom-nav-gallery-picker"),
    choices: () => bar.querySelectorAll("[data-gallery-mode-choice]"),
    back: () => context.window.fanhaoHandleNativeBack(),
    emit: (type, values) => context.window.dispatchEvent(event(type, context.window, values)),
    pendingTimers: () => [...clocks.values()],
    replaceNavigation() { context.els.bottomNav = context.navigation.renderAndroidModuleNavigation(bar, definitions); context.setActiveBottom(); },
    fire: (node, type, values) => { const value = event(type, node, values); node.dispatchEvent(value); return value; },
    // Native compatibility mousedown focuses its button before the later click.
    // Model that DOM default only; menu restoration remains production code.
    compatibilityMouseDown(node) {
      const down = event("mousedown", node, { button: 0, detail: 1 }); node.dispatchEvent(down);
      if (!down.defaultPrevented) node.focus(); return down;
    },
    compatibilityRelease(node) {
      node.dispatchEvent(event("mouseup", node, { button: 0, detail: 1 }));
      const click = event("click", node, { button: 0, detail: 1 }); node.dispatchEvent(click); return click;
    },
    elapse(delay) { for (const [id, timer] of [...clocks]) if (timer.delay <= delay && clocks.delete(id)) timer.fn(); },
    route: () => ({ view: context.currentView, params: structuredClone(context.currentViewParams) }),
    reboot() { const next = createGalleryHarness(sources, { storage, fallback }); const state = next.context.readInitialViewState(); next.context.currentView = state.view; next.context.currentViewParams = state.params; next.context.setActiveBottom(); return next; }
  };
}
