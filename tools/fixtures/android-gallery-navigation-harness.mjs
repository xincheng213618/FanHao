import assert from "node:assert/strict";
import vm from "node:vm";
import * as mediaNavigationState from "../../android-client/www/js/media-navigation-state.js";
import { createChannelHistoryState } from "../../android-client/www/js/channel-history-state.js";

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
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
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
  document.createElement = tag => new Element(tag, document);
  document.createDocumentFragment = () => new Element("#fragment", document);
  return document;
}
export function createGalleryHarness(sources, { storage = new Map(), fallback = false, initialView = "people", initialParams = {} } = {}) {
  const document = createNavigationFixtureDocument();
  const bar = document.createElement("nav"); document.body.append(bar);
  const clocks = new Map(); let clockId = 0;
  const observations = { renders: [], media: [], scrolls: 0, histories: [], unrelated: [] };
  const no = () => {};
  const context = {
    ...mediaNavigationState,
    document, console, URL, URLSearchParams, Date, Set, Map,
    currentView: initialView, currentViewParams: initialParams, viewStack: [], searchSurfaceExpanded: false,
    // Limit reset/rendering remains an unrelated boundary in menu-only tests.
    // Use the remote-channel default, with a fresh real session store per shell;
    // range restoration itself is covered by the separate return-range verifier.
    activeUrl: "https://synthetic.invalid", channelLimit: 36, channelHistoryState: createChannelHistoryState(),
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    LAST_VIEW_STORAGE_KEY: "fixture.last-view", DEFAULT_VIEW: "people", DEFAULT_PHOTO_CATEGORY: "我喜欢的",
    navigator: { vibrate: no }, window: { setTimeout(fn, delay) { const id = ++clockId; clocks.set(id, { fn, delay }); return id; }, clearTimeout(id) { clocks.delete(id); } },
    els: { bottomNavBar: bar, bottomNav: [], viewContent: document.createElement("main"), settingsOverlay: { hidden: true }, profileSettingsButton: null },
    shouldPreserveShortVideoHome: () => false, rememberCurrentScrollInHistory: no, currentScrollY: () => 0,
    rememberHomeMode: no, rememberReadingMode: no, syncHomeModeNavigation: no, syncReadingModeNavigation: no,
    closeHomeModePicker: no, closeReadingModePicker: no, resetViewLimitsForView: no, queueScrollRestore: no,
    pushViewHistory: (...args) => observations.histories.push(args), replaceCurrentHistory: no,
    scrollToTopInstant: () => { observations.scrolls++; }, readViewStateFromHash: () => null,
    openHomeModePicker: () => observations.unrelated.push("home"), openReadingModePicker: () => observations.unrelated.push("reading"),
    navigateToHomeMode: () => observations.unrelated.push("navigate-home"), navigateToReadingMode: () => observations.unrelated.push("navigate-reading"),
    toggleSettings: () => observations.unrelated.push("settings"),
    renderCurrentView() {
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
  const galleryNames = [...sources.app.matchAll(/^function (\w*[Gg]allery\w*)\(/gm)].map(match => match[1]);
  const names = [...new Set([...galleryNames, "isRootNavigationView", "normalizeChannelMode", "normalizeChannelSort", "primaryChannelMode", "bottomNavKeyFor", "setActiveBottom",
    "sanitizeViewParams", "showView", "showPrimaryView", "rememberViewState", "shouldRememberView", "readLastViewState", "defaultViewState", "readInitialViewState",
    "captureChannelRange", "restoreChannelRange", "sameViewParams", "viewRouteHash"] )];
  const constantNames = ["GALLERY_MODE_STORAGE_KEY", "GALLERY_MODES", "RESTORABLE_VIEWS"];
  if (sources.app.includes("const GALLERY_MODE_OPTIONS =")) constantNames.splice(1, 0, "GALLERY_MODE_OPTIONS");
  vm.runInContext(constantNames.map(name => constant(sources.app, name)).join("\n") + "\n" + names.map(name => appFunction(sources.app, name)).join("\n"), context);
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
  context.androidModuleRegistry = context.registryApi.createRegistry([photos, media]);
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
  const start = sources.app.indexOf("let bottomNavLongPressTimer = 0;");
  const end = sources.app.indexOf("for (const button of els.themeButtons)", start);
  assert(start >= 0 && end > start, "Bottom navigation event registration boundary changed");
  vm.runInContext(sources.app.slice(start, end), context, { filename: "actual-bottom-nav-events.js" });
  context.setActiveBottom();
  return {
    context, document, storage, observations, names, bar, host,
    button: () => context.galleryNavigationButton(),
    picker: () => bar.querySelector(".bottom-nav-gallery-picker"),
    choices: () => bar.querySelectorAll("[data-gallery-mode-choice]"),
    fire: (node, type, values) => { const value = event(type, node, values); node.dispatchEvent(value); return value; },
    elapse(delay) { for (const [id, timer] of [...clocks]) if (timer.delay <= delay && clocks.delete(id)) timer.fn(); },
    route: () => ({ view: context.currentView, params: structuredClone(context.currentViewParams) }),
    reboot() { const next = createGalleryHarness(sources, { storage, fallback }); const state = next.context.readInitialViewState(); next.context.currentView = state.view; next.context.currentViewParams = state.params; next.context.setActiveBottom(); return next; }
  };
}
