import assert from "node:assert/strict";
import vm from "node:vm";
import { reconcileLocalNovelEntry } from "../../android-client/www/js/novel-chapter-identity.js";

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function settle() {
  for (let index = 0; index < 24; index += 1) await Promise.resolve();
}

export function localEntry(id, ratio = 0.25) {
  return {
    generation: `fixture-generation:${id}:initial`,
    book: {
      id, local: true, title: `Book ${id}`, author: "Fixture author", chapterCount: 2,
      localGeneration: `fixture-generation:${id}:initial`,
      progress: { chapterIndex: 1, scrollRatio: ratio, updatedAt: "2026-01-01T00:00:00.000Z" }
    },
    chapters: [1, 2].map((index) => ({
      index, id: `${id}-${index}`, bookId: id, title: `Chapter ${index}`,
      content: `Only synthetic fixture text for ${id}, chapter ${index}.`, charCount: 1000
    }))
  };
}

class Events {
  listeners = new Map();
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }
  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
  dispatchEvent(event) {
    if (!event.target) event.target = this;
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    return true;
  }
}

class FakeEvent {
  constructor(type, options = {}) { this.type = type; Object.assign(this, options); }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() {}
}

function dataName(attribute) {
  return attribute.replace(/^data-/, "").replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

class FakeElement extends Events {
  constructor(tagName, ownerDocument) {
    super();
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.className = "";
    this.dataset = {};
    this.attributes = new Map();
    this.style = { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } };
    this._textContent = "";
    this._innerHTML = "";
    this.scrollHeight = 3000;
    this.clientHeight = 800;
    this.scrollWidth = 2200;
    this.clientWidth = 1000;
    this.scrollLeft = 0;
    this.scrollTop = 0;
    this.absoluteTop = 100;
    this.value = "";
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => !names.includes(name)).join(" "); },
      toggle: (name, force) => {
        const enabled = force === undefined ? !this.classList.contains(name) : Boolean(force);
        this.classList[enabled ? "add" : "remove"](name);
        return enabled;
      }
    };
  }
  set innerHTML(value) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._innerHTML = String(value);
    this._textContent = "";
  }
  get innerHTML() { return this._innerHTML; }
  set textContent(value) { this.innerHTML = ""; this._textContent = String(value); }
  get textContent() { return this._textContent + this.children.map((child) => child.textContent).join(""); }
  get isConnected() {
    let node = this;
    while (node) {
      if (node === this.ownerDocument.body || node === this.ownerDocument.documentElement) return true;
      node = node.parentNode;
    }
    return false;
  }
  append(...children) {
    for (const child of children.flat()) {
      const node = typeof child === "string" ? new FakeElement("#text", this.ownerDocument) : child;
      if (typeof child === "string") node.textContent = child;
      node.remove();
      node.parentNode = this;
      this.children.push(node);
    }
  }
  appendChild(child) { this.append(child); return child; }
  prepend(...children) { const old = [...this.children]; this.replaceChildren(...children, ...old); }
  replaceChildren(...children) { this.innerHTML = ""; this.append(...children); }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name.startsWith("data-")) this.dataset[dataName(name)] = String(value);
    if (name === "class") this.className = String(value);
  }
  getAttribute(name) { return name.startsWith("data-") ? this.dataset[dataName(name)] ?? null : this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); if (name.startsWith("data-")) delete this.dataset[dataName(name)]; }
  matches(selector) {
    return selector.split(",").some((raw) => {
      const value = raw.trim();
      if (value.startsWith(".")) return value.slice(1).split(".").every((name) => this.classList.contains(name));
      const attr = value.match(/^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
      if (attr) return this.getAttribute(attr[1]) !== null && (attr[2] === undefined || this.getAttribute(attr[1]) === attr[2]);
      return this.tagName.toLowerCase() === value.toLowerCase();
    });
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  getBoundingClientRect() {
    return { top: this.absoluteTop - this.ownerDocument.defaultView.scrollY, left: 0, width: this.clientWidth, height: this.clientHeight, bottom: this.absoluteTop + this.clientHeight - this.ownerDocument.defaultView.scrollY };
  }
  focus() { this.ownerDocument.activeElement = this; }
  click() { this.dispatchEvent(new FakeEvent("click")); }
}

function functionPattern(name) {
  return new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  \\}`);
}

export function createReaderHarness(productionSource, { historical = null, deferSaves = false, deferPosts = false, strictCache = false, reconcileEntries = false } = {}) {
  let source = productionSource;
  if (historical) {
    for (const [name, body] of Object.entries(historical.functions)) {
      assert(functionPattern(name).test(source), `Historical control cannot find ${name}`);
      source = source.replace(functionPattern(name), () => body);
    }
    if (historical.functions.renderLocalNovelReader) {
      // Historical reader functions predate summary/chapter APIs. Keep their
      // original whole-entry boundary, without changing any frozen defect code.
      source = source.replace(functionPattern("ensureLocalNovelEntry"), () => `  async function ensureLocalNovelEntry(bookId) {
    const id = String(bookId || "");
    if (localBooks.has(id)) return localBooks.get(id);
    const entry = await readLocalNovelEntry(id);
    if (entry) localBooks.set(id, entry);
    return entry;
  }`);
    }
  }
  source = source.replace(/^import .*;\r?\n/gm, "").replace("export function createNovelViews", "function createNovelViews");
  const returnMarker = /\n  return \{\r?\n    renderNovelList,/;
  assert(returnMarker.test(source), "Reader harness must expose the real createNovelViews return, not a copied implementation");
  source = source.replace(returnMarker, `\n  return {\n    __test: { readerState, localBooks, listState, selectedLocalBookIds, renderNovelCollection, saveReaderProgress, flushReaderProgress, restoreReaderScroll, scheduleReaderProgress, captureReaderRatio, deactivateReader, renderNovelReaderData, loadPersistentLocalLibrary, ensureLocalNovelEntry, readLocalCatalog, loadReaderCatalog, removeLocalBook, downloadBook, cacheWholeBook, cacheBookFromList, createCachedRemoteBookEntry, cachedRemoteEntryForSourceId, markRemoteBookWithCache, remoteCacheIdFromSourceId, setNovelBusy, clearNovelBusy,
      ...(typeof rememberRemoteSourceRealm === "function" ? { rememberRemoteSourceRealm } : {}),
      ...(typeof readRemoteSourceRealm === "function" ? { readRemoteSourceRealm } : {}),
      ...(typeof remoteSourceRealms !== "undefined" ? { remoteSourceRealms } : {}),
      ...(typeof openReader === "function" ? { openReader } : {}),
      ...(typeof saveLocalTextFile === "function" ? { saveLocalTextFile } : {}),
      ...(typeof createLocalBookEntry === "function" ? { createLocalBookEntry } : {})
    },\n    renderNovelList,`);

  const window = new Events();
  const document = new Events();
  document.defaultView = window;
  document.createElement = (name) => new FakeElement(name, document);
  document.body = document.createElement("body");
  document.documentElement = document.createElement("html");
  document.hidden = false;
  document.visibilityState = "visible";
  document.activeElement = null;
  document.querySelector = (selector) => document.body.querySelector(selector);
  window.document = document;
  window.scrollY = 0;
  window.innerHeight = 800;
  window.innerWidth = 400;
  window.history = { back() {} };
  window.confirm = () => true;
  const scrolls = [];
  window.scrollTo = (options) => { window.scrollY = Number(options.top || 0); scrolls.push(window.scrollY); };
  let clockId = 0;
  const frames = new Map();
  const timers = new Map();
  window.requestAnimationFrame = (callback) => { const id = ++clockId; frames.set(id, { callback, canceled: false }); return id; };
  window.cancelAnimationFrame = (id) => { const frame = frames.get(id); if (frame) frame.canceled = true; };
  window.setTimeout = (callback, delay = 0) => { const id = ++clockId; timers.set(id, { callback, delay, canceled: false }); return id; };
  window.clearTimeout = (id) => { const timer = timers.get(id); if (timer) timer.canceled = true; };
  const nativeCalls = [];
  window.Capacitor = { Plugins: { FanHaoNovel: Object.fromEntries(["setReaderBrightness", "clearReaderBrightness", "setReaderImmersive"].map((name) => [name, async (options) => { nativeCalls.push({ name, options }); return {}; }])) } };
  const storage = new Map();
  const localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) };
  window.localStorage = localStorage;
  const books = new Map(["local:a", "local:b"].map((id) => [id, localEntry(id)]));
  const queuedReads = new Map();
  const queuedListReads = [];
  const recoveryLists = [];
  const recoveryEntries = [];
  const recoveryCalls = [];
  const objectUrls = [];
  class FixtureURL extends URL {
    static createObjectURL(blob) { const item = { href: `blob:synthetic-${objectUrls.length}`, blob, revoked: false }; objectUrls.push(item); return item.href; }
    static revokeObjectURL(href) { const item = objectUrls.find((item) => item.href === href); if (item) item.revoked = true; }
  }
  const storageCalls = [];
  let generationId = 0;
  const reads = [];
  const saves = [];
  const posts = [];
  const fetches = [];
  const statuses = [];
  const cached = new Map();
  const cacheCalls = [];
  const savedEntries = [];
  const navigations = [];
  // Existing suites use their historical path-only fixture cache. Source
  // identity scenarios opt into independent URL/path keys and real cache writes.
  const cacheKey = (url, path) => strictCache ? JSON.stringify([url, path]) : path;
  const generationOf = (entry) => entry?.generation || entry?.book?.localGeneration || `fixture-generation:${entry?.book?.id}:initial`;
  const summaryOf = (entry) => entry ? {
    id: entry.book.id, book: { ...structuredClone(entry.book), localGeneration: generationOf(entry) },
    generation: generationOf(entry), createdAt: entry.createdAt, updatedAt: entry.updatedAt, bytes: entry.bytes
  } : null;
  const catalogOf = (entry) => entry ? { ...summaryOf(entry), chapters: entry.chapters.map(({ content, ...metadata }) => structuredClone(metadata)) } : null;
  const readFixture = async (id, kind, index, options = {}) => {
    storageCalls.push({ kind, id, index, options: { ...options } });
    reads.push(id);
    const queued = queuedReads.get(id)?.shift();
    const entry = queued ? await queued.promise : books.get(id);
    if (!entry) return null;
    if (kind === "summary") return summaryOf(entry);
    if (kind === "catalog") return catalogOf(entry);
    if (kind === "chapter") {
      const offset = entry.chapters.findIndex((chapter) => Number(chapter.index) === Number(index));
      if (offset < 0) return null;
      if ((options.catalogRevision !== undefined && options.catalogRevision !== entry.book.catalogRevision)
        || (options.chapterId !== undefined && options.chapterId !== entry.chapters[offset].id)) return null;
      const catalog = catalogOf(entry);
      return { book: catalog.book, generation: catalog.generation, chapter: structuredClone(entry.chapters[offset]),
        chapters: catalog.chapters, prev: catalog.chapters[offset - 1] || null, next: catalog.chapters[offset + 1] || null };
    }
    return { ...structuredClone(entry), ...summaryOf(entry) };
  };
  const readLocalNovelEntry = (id) => readFixture(id, "entry");
  const saveLocalNovelProgress = (id, progress, options = {}) => {
    storageCalls.push({ kind: "saveProgress", id, options: { ...options } });
    const wait = deferred();
    const record = { id, progress: structuredClone(progress), options: { ...options }, wait, settled: false };
    saves.push(record);
    const result = wait.promise.then(() => {
      const entry = structuredClone(books.get(id));
      if (!entry || (options.expectedGeneration !== undefined && options.expectedGeneration !== generationOf(entry))) {
        record.settled = true;
        return null;
      }
      // This is only a storage boundary double, not a reconciliation algorithm.
      // Modern UI cases assert the submitted arguments separately; validation
      // here prevents impossible stale writes from looking like storage success.
      if (entry.book.catalogRevision && (progress.catalogRevision !== entry.book.catalogRevision
        || !entry.chapters.some((chapter) => chapter.id === progress.chapterId && Number(chapter.index) === Number(progress.chapterIndex)))) {
        record.settled = true;
        return null;
      }
      entry.book.progress = { ...progress, updatedAt: new Date().toISOString() };
      if (entry.book.catalogRevision) entry.book.progressRecovery = null;
      books.set(id, structuredClone(entry));
      record.settled = true;
      return historical?.functions.renderLocalNovelReader ? entry : summaryOf(entry);
    });
    if (!deferSaves) wait.resolve();
    return result;
  };
  const recordPost = (url, path, data, options = {}) => {
    const wait = deferred();
    posts.push({ url, path, data: structuredClone(data), options: { ...options }, wait });
    if (!deferPosts) wait.resolve({});
    return wait.promise;
  };
  const sandbox = vm.createContext({
    console, window, document, localStorage, Element: FakeElement, Event: FakeEvent, CustomEvent: FakeEvent,
    navigator: {}, URL: FixtureURL, URLSearchParams, Blob, TextDecoder, AbortController, Map, Set, Date,
    formatNumber: (value) => String(value ?? 0), formatBytes: (value) => `${value || 0} B`,
    readLocalNovelEntry, saveLocalNovelProgress,
    readLocalNovelSummary: (id) => readFixture(id, "summary"),
    readLocalNovelCatalog: (id) => readFixture(id, "catalog"),
    readLocalNovelChapter: (id, index, options) => readFixture(id, "chapter", index, options),
    listLocalNovelRecoveryBooks: (options) => {
      recoveryCalls.push({ kind: "list", options: structuredClone(options) });
      const queued = recoveryLists.shift();
      if (!queued) throw new Error("Unexpected legacy-list read: enqueue a synthetic result explicitly");
      return queued.promise;
    },
    readLocalNovelRecoveryEntry: (key, options) => {
      recoveryCalls.push({ kind: "entry", key: structuredClone(key), options: structuredClone(options) });
      const queued = recoveryEntries.shift();
      if (!queued) throw new Error("Unexpected legacy-body read: enqueue a synthetic result explicitly");
      return queued.promise;
    },
    loadLocalNovelSummaries: async () => {
      storageCalls.push({ kind: "summaries" });
      const queued = queuedListReads.shift();
      const entries = queued ? await queued.promise : [...books.values()];
      return entries.map(summaryOf);
    },
    loadLocalNovelEntries: async () => { storageCalls.push({ kind: "entries" }); return [...books.values()].map((value) => structuredClone(value)); },
    saveLocalNovelEntry: async (entry, options = {}) => {
      storageCalls.push({ kind: "saveEntry", id: entry.book.id, options: { ...options } });
      savedEntries.push(structuredClone(entry));
      const current = books.get(entry.book.id);
      if (options.expectedGeneration !== undefined && options.expectedGeneration !== (current ? generationOf(current) : null)) return null;
      const stored = reconcileEntries ? reconcileLocalNovelEntry(current || null, structuredClone(entry)) : structuredClone(entry);
      stored.generation = `fixture-generation:saved:${++generationId}`;
      stored.book.localGeneration = stored.generation;
      books.set(entry.book.id, stored);
      return summaryOf(stored);
    },
    deleteLocalNovelEntry: async (id) => { storageCalls.push({ kind: "delete", id }); return books.delete(id); },
    readCachedJson: async (url, path) => {
      cacheCalls.push({ kind: "read", url, path });
      return cached.get(cacheKey(url, path)) || null;
    },
    writeCachedJson: async (url, path, payload) => {
      cacheCalls.push({ kind: "write", url, path, payload: structuredClone(payload) });
      if (strictCache) cached.set(cacheKey(url, path), { payload: structuredClone(payload), updatedAt: "synthetic-cache-time" });
    },
    clearCachedJsonByPrefix: async () => {}, cacheAgeText: () => "cached",
    deleteJson: async () => ({}), openMobileActionSheet: async () => null,
    postJson: (url, path, data) => recordPost(url, path, data),
    fetchJson: (url, path, options = {}) => {
      if (String(options.method || "GET").toUpperCase() === "POST" && /\/progress(?:\?|$)/.test(path)) {
        return recordPost(url, path, options.body, options);
      }
      const wait = deferred();
      fetches.push({ url, path, options, wait });
      return wait.promise;
    }
  });
  vm.runInContext(source, sandbox, { filename: historical ? "novel-reader-historical-control.js" : "novel-views.js" });
  const els = Object.fromEntries(["viewContent", "viewKicker", "viewTitle", "viewMeta"].map((name) => [name, document.createElement("div")]));
  document.body.append(...Object.values(els));
  let activeUrl = "http://synthetic.invalid";
  const context = {
    els, getActiveUrl: () => activeUrl, showView: (...args) => navigations.push(args), goBack() {}, setActiveBottom() {},
    renderCurrentView() {}, renderCurrentViewPreservingScroll() {}, setStatus: (...args) => statuses.push(args)
  };
  const api = sandbox.createNovelViews(context);
  return {
    api, state: api.__test.readerState, window, document, els, books, reads, saves, posts, fetches, cached, cacheKey, cacheCalls, savedEntries, navigations, frames, timers, scrolls, nativeCalls, statuses, storageCalls, recoveryCalls, objectUrls,
    event: (name, options) => new FakeEvent(name, options),
    setActiveUrl(value) { activeUrl = value; },
    queueRead(id) { const wait = deferred(); if (!queuedReads.has(id)) queuedReads.set(id, []); queuedReads.get(id).push(wait); return wait; },
    queueListRead() { const wait = deferred(); queuedListReads.push(wait); return wait; },
    queueRecoveryList() { const wait = deferred(); recoveryLists.push(wait); return wait; },
    queueRecoveryEntry() { const wait = deferred(); recoveryEntries.push(wait); return wait; },
    frameIds() { return [...frames].filter(([, frame]) => !frame.canceled).map(([id]) => id); },
    runFrame(id, evenIfCanceled = false) { const frame = frames.get(id); assert(frame, `Unknown rAF ${id}`); frames.delete(id); if (evenIfCanceled || !frame.canceled) frame.callback(0); },
    runFrames() { for (const id of [...frames.keys()]) this.runFrame(id); },
    runTimers(delay) { for (const [id, timer] of [...timers]) if (!timer.canceled && timer.delay === delay) { timers.delete(id); timer.callback(); } },
    setRatio(ratio) {
      const screen = els.viewContent.querySelector(".novel-reader-screen");
      assert(screen, "Fixture can only scroll a mounted real reader screen");
      if (api.__test.readerState.settings.readingMode === "page") {
        const content = screen.querySelector(".novel-reader-content");
        content.scrollLeft = (content.scrollWidth - content.clientWidth) * ratio;
      } else window.scrollY = screen.absoluteTop + (screen.scrollHeight - window.innerHeight) * ratio;
    },
    hide() { document.hidden = true; document.visibilityState = "hidden"; document.dispatchEvent(new FakeEvent("visibilitychange")); },
    leave(view = "music") { window.dispatchEvent(new FakeEvent("fanhaoViewChanged", { detail: { view } })); els.viewContent.innerHTML = "OTHER VIEW"; },
    async resolveSave(index) { assert(saves[index], `No queued local save ${index}`); saves[index].wait.resolve(); await settle(); },
    async resolvePost(index) { assert(posts[index], `No queued remote save ${index}`); posts[index].wait.resolve({}); await settle(); }
  };
}
