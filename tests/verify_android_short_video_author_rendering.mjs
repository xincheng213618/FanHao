import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createNavigationFixtureDocument } from "./fixtures/android-gallery-navigation-harness.mjs";

// Complete real module composition with controlled DOM/API/native bridge.
// No image loader, card renderer, sort or merge algorithm is replaced. This
// fixture measures card creation and createElement calls, not parsed SVG
// descendants, browser layout or avatar decoding.
const root = new URL("../", import.meta.url);
const paths = { entry: "android-client/www/modules/short-videos/index.js", controller: "android-client/www/modules/short-videos/list/controller.js", view: "android-client/www/modules/short-videos/list/view.js" };
const urls = Object.fromEntries(Object.entries(paths).map(([key, file]) => [key, new URL(file, root)]));
const hashes = { entry: "d5159f3310897fbdfa077688ef61c7236b4190cdedfad4c065351ba7ec94ed32", controller: "cff818e302989e7de427336fddfa187d7fa8fc0625d73113188863477e8e5166", view: "6a3ca2331b21d6b1b13ce3c3be218340d1a20cc0975e1a7936086529f10e2772" };
const current = Object.fromEntries(Object.entries(urls).map(([key, url]) => [key, fs.readFileSync(url, "utf8").replace(/\r\n/g, "\n")]));
const before = Object.fromEntries(Object.entries(paths).map(([key, file]) => {
  const source = execFileSync("git", ["show", `63c5fab243233e142cfd62c4eaf13812feb92405:${file}`], { cwd: root, encoding: "utf8" }).replace(/\r\n/g, "\n");
  assert.equal(crypto.createHash("sha256").update(source).digest("hex"), hashes[key], `fixed complete ${key} owner`);
  return [key, source];
}));
const legacy = process.argv.includes("--legacy-author-render");
assert(process.argv.slice(2).every(arg => ["--legacy-author-render", "--legacy-author-scope-append"].includes(arg)));
const tested = { ...current };
if (legacy) {
  const marker = "  function appendListAuthors() {";
  assert.equal(tested.view.split(marker).length, 2, "one author append fallback boundary");
  tested.view = tested.view.replace(marker, `${marker}\n    return false; // Controlled full-render fallback.`);
}
if (process.argv.includes("--legacy-author-scope-append")) {
  const marker = "const retryFirstPage = Boolean(options.append && needsFirstPageRetry());";
  assert.equal(tested.controller.split(marker).length, 2, "one scope-mismatch first-page boundary");
  tested.controller = tested.controller.replace(marker, "const retryFirstPage = false; // Controlled former mixed-scope append.");
}
const saved = Object.fromEntries(["document", "window", "localStorage", "requestAnimationFrame", "fetch"].map(key => [key, globalThis[key]]));
const copy = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let turn = 0; turn < 32; turn++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const event = (type, target, values = {}) => ({ type, target, bubbles: true, ...values, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } });
const importSource = (source, url) => import(`data:text/javascript;base64,${Buffer.from(source.replace(/from "(\.\.?\/[^\"]+)"/g, (_match, relative) => `from ${JSON.stringify(new URL(relative, url).href)}`)).toString("base64")}`);
let serial = 0, comparisons = 0, recoveryCases = 0;

function author(i, overrides = {}) {
  return { secUid: `uid-${i}`, id: `user-${i}`, name: `作者 ${String(i).padStart(3, "0")}`, count: 10000 - i, likedCount: i % 5,
    following: true, accountStatus: "active", avatarUrl: i % 11 === 0 ? `/synthetic-avatar/${i}.svg` : "", ...overrides };
}
const range = (start, count, options) => Array.from({ length: count }, (_, i) => author(start + i, options));
const envelope = (authors, overrides = {}) => ({ authors, total: 600, scopeTotal: 650, bannedTotal: 8, unlikedTotal: 70, hasMore: true, limit: authors.length, offset: 0, ...overrides });
const storeSource = fs.readFileSync(new URL("src/modules/short-videos/server/store.js", root), "utf8");
const comparatorSource = storeSource.match(/function authorComparator\(sort\) \{[\s\S]*?\n\}/)?.[0];
assert(comparatorSource, "the real server comparator defines synthetic response order");
const authorComparator = new Function(comparatorSource + "; return authorComparator;")();

async function fixture(code = current) {
  const document = globalThis.document = createNavigationFixtureDocument();
  const create = document.createElement;
  document.createTextNode = value => { const node = create("#text"); node.textContent = String(value); return node; };
  let metrics = { cards: 0, createElementCalls: 0, sortedCalls: 0 }, baseUrl = "http://authors.fixture.invalid:29998";
  document.createElement = tag => {
    metrics.createElementCalls++;
    const node = create(tag);
    node.style = { setProperty(key, value) { this[key] = value; }, removeProperty(key) { delete this[key]; } };
    node.toggleAttribute = (name, force) => { const enabled = force ?? node.getAttribute(name) === null; if (enabled) node.setAttribute(name, ""); else node.removeAttribute(name); return enabled; };
    node.insertBefore = (child, reference) => { if (!reference) node.append(child); else reference.before(child); return child; };
    Object.defineProperties(node, { isConnected: { get: () => document.body.contains(node) }, parentElement: { get: () => node.parentNode?.tagName ? node.parentNode : null },
      nextElementSibling: { get: () => node.parentNode?.children[node.parentNode.children.indexOf(node) + 1] || null },
      offsetHeight: { get: () => 400 } });
    const click = node.click.bind(node); node.click = () => { if (!node.disabled) click(); };
    return node;
  };
  document.documentElement = document.createElement("html"); document.documentElement.scrollHeight = 50000;
  document.activeElement = document.body;
  const requests = [], navigation = [], native = [], external = [], scrolls = [], listeners = new Map(), timers = new Map();
  let timer = 0;
  const window = globalThis.window = { scrollY: 0, innerHeight: 800,
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(callback); },
    setTimeout(callback, delay) { const id = ++timer; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id),
    requestAnimationFrame: () => 0, cancelAnimationFrame() {}, scrollTo: options => scrolls.push(copy(options)), open: (...args) => external.push(args),
    Capacitor: { Plugins: { FanHaoPlayer: { async playShortFeed(payload) { native.push(copy(payload)); return { opened: true, canceled: true }; } } } } };
  globalThis.requestAnimationFrame = window.requestAnimationFrame;
  const storage = new Map(); globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
  globalThis.fetch = () => { throw new Error("Author rendering fixture never accesses a service"); };
  const read = (kind, base, path, options) => { const pending = { kind, base, path, options, ...deferred() }; requests.push(pending); return pending.promise; };
  const api = { fetchCached: (...args) => read("cached", ...args), fetchCachedRevalidated: (...args) => read("revalidated", ...args), fetch: (...args) => read("fetch", ...args) };
  let viewSource = code.view;
  const cardMatches = [...viewSource.matchAll(/^  function renderAuthorIndexCard\([^\n]*\) \{/gm)];
  assert.equal(cardMatches.length, 1);
  const cardMarker = cardMatches[0][0];
  viewSource = viewSource.replace(cardMarker, `${cardMarker}\n    window.__authorCreated();`);
  window.__authorCreated = () => { metrics.cards++; };
  const sortedMarker = "  function sortedAuthorFacets(options = {}) {";
  assert.equal(code.controller.split(sortedMarker).length, 2);
  const controllerSource = code.controller.replace(sortedMarker, `${sortedMarker}\n    window.__authorSorted();`);
  window.__authorSorted = () => { metrics.sortedCalls++; };
  const [view, controller] = await Promise.all([importSource(viewSource, urls.view), importSource(controllerSource, urls.controller)]);
  const key = `__fanhaoAuthorRender${++serial}`;
  const capture = globalThis[key] = { view: view.createShortVideoListView, controller: controller.createShortVideoListController, api, context: null };
  let entrySource = code.entry;
  for (const [name, field] of [["createShortVideoListView", "view"], ["createShortVideoListController", "controller"]]) {
    const pattern = new RegExp(`^import \\{ ${name} \\} from "[^\\"]+";$`, "m");
    assert(pattern.test(entrySource), `real entry composes ${name}`);
    entrySource = entrySource.replace(pattern, field === "controller"
      ? `const ${name} = context => { const capture = globalThis[${JSON.stringify(key)}]; capture.context = context; context.api = capture.api; return capture.controller(context); };`
      : `const ${name} = globalThis[${JSON.stringify(key)}].view;`);
  }
  const entry = await importSource(entrySource, urls.entry);
  const adapterUrl = new URL("android-client/www/modules/short-videos/android-module.js", root);
  let adapterSource = fs.readFileSync(adapterUrl, "utf8");
  capture.entry = entry.createShortVideoViews;
  adapterSource = adapterSource.replace(/^import \{ createShortVideoViews \} from "[^\"]+";$/m, `const createShortVideoViews = globalThis[${JSON.stringify(key)}].entry;`);
  const adapter = await importSource(adapterSource, adapterUrl);
  const content = document.createElement("main"), chrome = document.createElement("nav"); document.body.append(chrome, content);
  document.body.classList.add("short-video-mobile-view");
  const module = adapter.createAndroidModule({ host: { els: { viewContent: content, viewKicker: {}, viewTitle: {}, viewMeta: {} }, getActiveUrl: () => baseUrl,
    navigation: { showView: (...args) => navigation.push(copy(args)), goBack() {} }, ui: { setActiveBottom() {}, openSettings() {}, scrollToTop() {} } } });
  delete globalThis[key];
  const context = capture.context, state = context.listState;
  const respond = async (index, data, revalidation = null) => { requests[index].resolve(requests[index].kind === "revalidated" ? { data, revalidation } : data); await flush(); };
  const load = async (source = "authors", data = envelope(range(0, 24)), params = {}) => {
    const promise = module.routes.find(route => route.view === "shortVideos").render({ source, ...params }, () => true);
    await respond(requests.length - 1, data); await promise;
  };
  return { module, context, state, document, content, chrome, requests, navigation, native, external, scrolls,
    load, respond, async fail(index) { requests[index].reject(new Error("Synthetic author read failure")); await flush(); },
    async append(data) { const promise = context.loadList(null, { append: true }); await respond(requests.length - 1, data); await promise; },
    async clickMore(data) { content.querySelector(".short-video-mobile-author-index-more").click(); await respond(requests.length - 1, data); },
    cards: () => content.querySelectorAll("article.short-video-mobile-author-card"),
    metrics: () => ({ ...metrics }), resetMetrics() { metrics = { cards: 0, createElementCalls: 0, sortedCalls: 0 }; },
    setBase(value) { baseUrl = value; }, scroll(remaining) { document.documentElement.scrollHeight = window.scrollY + window.innerHeight + remaining; for (const callback of listeners.get("scroll") || []) callback(); },
    snapshot() { return { state: copy(state), dom: visibleTree(content), requests: requests.map(({ base, path, kind }) => ({ base, path, kind })), navigation: copy(navigation), native: copy(native), external: copy(external), scrolls: copy(scrolls) }; },
    async cleanup() { module.deactivate(); content.innerHTML = ""; for (const request of requests) request.resolve(request.kind === "revalidated" ? { data: envelope([], { hasMore: false }), revalidation: null } : envelope([], { hasMore: false })); await flush(); timers.clear(); }
  };
}

function visibleTree(rootNode) {
  // Banned-description IDs are unique module serials, not public data. Keep
  // their real aria linkage while normalizing only those generated numbers.
  const ids = new Map();
  for (const node of rootNode.querySelectorAll("small.short-video-mobile-author-banned-reason")) {
    assert(node.id && !ids.has(node.id)); ids.set(node.id, `status-${ids.size + 1}`);
  }
  const normalize = value => ids.get(value) || value;
  const walk = node => ({ tag: node.tagName, class: node.className, text: node._text, html: node._html,
    id: normalize(node.id || ""), attributes: [...node.attributes].filter(([name]) => name !== "data-author-key").map(([name, value]) => [name, normalize(value)]).sort(),
    value: node.value ?? "", disabled: Boolean(node.disabled), hidden: Boolean(node.hidden), src: node.src || "", children: node.children.map(walk) });
  return walk(rootNode);
}
async function run(code, scenario) { const f = await fixture(code); try { return await scenario(f); } finally { await f.cleanup(); } }
async function compare(name, scenario) {
  const expected = await run(before, scenario), actual = await run(tested, scenario);
  assert.deepEqual(actual, expected, name); comparisons += actual.length;
}

async function ordinary(f) {
  const snapshots = [];
  for (const source of ["authors", "following"]) {
    await f.load(source, envelope(range(0, 24))); snapshots.push(f.snapshot());
    await f.clickMore(envelope([author(24, { count: 20000, name: "高计数" }), author(25, { count: 9978, name: "同计数 A" }), author(26, { count: 9978, name: "同计数 B" }),
      author(0, { count: 999999, name: "duplicate loses" }), author(30, { secUid: " uid-1 ", name: "trim duplicate loses" }), author(31, { secUid: "", name: "Name only" })], { scopeTotal: 700, bannedTotal: 11, unlikedTotal: 81 }));
    snapshots.push(f.snapshot());
    assert.equal(f.state.data.authors.filter(row => row.secUid === "uid-0").length, 1);
    const names = f.cards().map(card => card.querySelector("strong").textContent);
    assert.equal(names[0], source === "authors" ? "高计数" : "作者 000", "authors sort, following preserves server order");
    await f.clickMore(envelope([], { hasMore: false, total: f.state.data.authors.length })); snapshots.push(f.snapshot());
    assert.equal(f.content.querySelector(".short-video-mobile-author-index-more"), null);
  }
  return snapshots;
}
async function errorsAndRaces(f) {
  const snapshots = [];
  await f.load("following");
  let pending = f.context.loadList(null, { append: true }); const failed = f.requests.length - 1;
  const count = f.requests.length; f.content.querySelector(".short-video-mobile-author-index-more")?.click();
  assert.equal(f.requests.length, count, "double-click cannot start a second append");
  await f.fail(failed); await pending; snapshots.push(f.snapshot());
  await f.clickMore(envelope(range(24, 18))); snapshots.push(f.snapshot());
  pending = f.context.loadList(null, { append: true }); const retired = f.requests.length - 1;
  await f.load("authors", envelope(range(100, 24))); await f.respond(retired, envelope(range(42, 18))); await pending; snapshots.push(f.snapshot());
  assert.equal(f.state.data.authors[0].secUid, "uid-100");
  pending = f.context.loadList(null, { append: true }); const oldServer = f.requests.length - 1;
  f.setBase("http://new-authors.fixture.invalid:29998");
  const beforeStale = f.snapshot();
  await f.respond(oldServer, envelope(range(150, 18))); await pending;
  assert.deepEqual(f.snapshot(), beforeStale, "old-server completion cannot change its connected retired UI");
  await f.load("following", envelope(range(200, 24)));
  pending = f.context.loadList(null, { append: true }); const left = f.requests.length - 1;
  f.module.deactivate(); f.content.innerHTML = "Other module";
  await f.respond(left, envelope(range(224, 18))); await pending; snapshots.push(f.snapshot());
  return snapshots;
}
async function duplicateAndRevalidation(f) {
  const snapshots = [];
  await f.load("authors", envelope([author(0), author(0), author(1)]));
  await f.append(envelope([author(2)])); snapshots.push(f.snapshot());
  assert.equal(f.cards().length, 4, "initial duplicate rows retain legacy full-render contract");
  const fresh = deferred();
  const pending = f.module.routes.find(route => route.view === "shortVideos").render({ source: "following" }, () => true);
  await f.respond(f.requests.length - 1, envelope(range(0, 24)), fresh.promise); await pending;
  await f.clickMore(envelope(range(24, 18)));
  fresh.resolve(envelope([author(0, { name: "Fresh first" }), author(24, { name: "Fresh duplicate wins" })])); await flush(); snapshots.push(f.snapshot());
  assert.equal(f.state.data.authors[0].name, "Fresh first");
  assert.equal(f.state.data.authors.find(row => row.secUid === "uid-24").name, "Fresh duplicate wins");
  return snapshots;
}
async function toolsAndClicks(f) {
  const snapshots = [];
  await f.load("following");
  const sort = f.content.querySelector(".short-video-mobile-following-sort"); sort.value = "count"; sort.dispatchEvent(event("change", sort));
  f.content.querySelector(".short-video-mobile-following-filter").click(); snapshots.push(f.snapshot());
  await f.load("authors", envelope(range(0, 24), { bannedTotal: 3 }));
  const filter = f.content.querySelector(".short-video-mobile-author-account-filter"); filter.value = "banned"; filter.dispatchEvent(event("change", filter)); snapshots.push(f.snapshot());
  await f.load("authors", envelope(range(0, 24), { bannedTotal: 3 }), { authorAccountStatus: "banned" });
  await f.clickMore(envelope([author(24, { accountStatus: "banned", accountStatusReason: "Synthetic reason" })])); snapshots.push(f.snapshot());
  f.cards()[0].querySelector("button").click();
  const request = f.requests.at(-1); assert(new URL(request.path, request.base).searchParams.get("author"));
  await f.respond(f.requests.length - 1, { videos: [{ id: "synthetic-video", streamUrl: "/synthetic/video.mp4", title: "Synthetic" }], hasMore: false });
  assert.equal(f.native.length, 1); assert.equal(f.native[0].openAuthorPanel, true); snapshots.push(f.snapshot());
  return snapshots;
}
async function searchAndEmpty(f) {
  const snapshots = [];
  for (const source of ["authors", "following"]) {
    const pending = f.module.routes.find(route => route.view === "shortVideoSearch").render({ source, query: "作者", tab: "authors" }, () => true);
    await f.respond(f.requests.length - 1, envelope(range(0, 24))); await pending; snapshots.push(f.snapshot());
    await f.clickMore(envelope(range(24, 18), { total: 999, scopeTotal: 1200, bannedTotal: 31, unlikedTotal: 101 }));
    snapshots.push(f.snapshot());
    assert.equal(f.content.querySelector(".short-video-search-result-meta").textContent, "999 位相关用户");
    await f.load(source, envelope([], { total: 0, hasMore: false })); snapshots.push(f.snapshot());
    assert.equal(f.cards().length, 0); assert.equal(f.content.querySelector(".short-video-mobile-author-index-more"), null);
  }
  return snapshots;
}
async function verifyMountedOwners() {
  await run(current, async f => {
    await f.load("following");
    const oldCard = f.cards()[0].querySelector("button"), oldMore = f.content.querySelector(".short-video-mobile-author-index-more");
    const oldSort = f.content.querySelector(".short-video-mobile-following-sort"), oldFilter = f.content.querySelector(".short-video-mobile-following-filter");
    const requests = f.requests.length;
    f.resetMetrics();
    for (let i = 0; i < 100; i++) f.scroll(5000);
    assert.deepEqual(f.metrics(), { cards: 0, createElementCalls: 0, sortedCalls: 0 }, "100 far-from-bottom scrolls do no author filtering/sort or DOM work");
    assert.equal(f.requests.length, requests);
    f.setBase("http://connected-retired.fixture.invalid:29998");
    assert(oldCard.isConnected && oldMore.isConnected);
    oldCard.click(); oldMore.click(); await flush();
    assert.equal(f.requests.length, requests, "connected old-server cards and More cannot start requests");
    oldSort.value = "count"; oldSort.dispatchEvent(event("change", oldSort)); oldFilter.click();
    assert.equal(f.navigation.length, 0, "connected retired following tools cannot navigate on a new server");
    assert.equal(f.scrolls.length, 0, "connected retired following tools cannot scroll the new view");
    await f.load("authors", envelope(range(80, 24)));
    const before = f.snapshot(); oldCard.click(); oldMore.click(); await flush();
    assert.deepEqual(f.snapshot(), before, "detached old controls cannot acquire a reopened owner");
    const mountedCard = f.cards()[0].querySelector("button"), mountedMore = f.content.querySelector(".short-video-mobile-author-index-more");
    f.module.deactivate();
    const afterLeave = f.snapshot(); mountedCard.click(); mountedMore.click(); await flush();
    assert.deepEqual(f.snapshot(), afterLeave, "deactivation retires controls even while their DOM stays connected");
  });
}
async function verifyFailedScopeRecovery() {
  const pool = Array.from({ length: 72 }, (_, i) => author(i, { count: i + 1, followedTime: 1000 - i, name: `${i < 24 ? "旧" : "新"}作者-${i}` }));
  const ids = authors => authors.map(row => row.secUid);
  const params = request => new URL(request.path, request.base).searchParams;
  function ordered(source, query = "", sort = "followed") {
    return pool.filter(row => !query || row.name.includes(query)).sort(authorComparator(source === "following" ? sort : "count"));
  }
  function page(authors, offset = 0, size = 24) {
    return envelope(authors.slice(offset, offset + size), { total: authors.length, scopeTotal: 72, hasMore: offset + size < authors.length, offset, limit: size });
  }
  for (const scenario of ["sort", "query", "source"]) await run(tested, async f => {
    const initial = ordered("following", scenario === "query" ? "旧" : "");
    const oldRows = scenario === "source" ? initial.slice(0, 24) : initial;
    await f.load("following", page(oldRows), { authorSort: "followed", query: scenario === "query" ? "旧" : "" });
    const retiredCard = f.cards()[0].querySelector("button"), retiredMore = f.content.querySelector(".short-video-mobile-author-index-more");
    const target = scenario === "sort" ? { source: "following", authorSort: "count" }
      : scenario === "query" ? { source: "following", query: "新", authorSort: "followed" }
        : { source: "authors" };
    const expected = ordered(target.source, target.query, target.authorSort);
    const refresh = f.module.routes.find(route => route.view === "shortVideos").render(target, () => true);
    await f.fail(f.requests.length - 1); await refresh;
    assert.deepEqual(ids(f.state.data.authors), ids(initial.slice(0, 24)), "failed first page retains only the old data snapshot");
    assert.equal(f.state.loading, false); assert.equal(f.state.loadingMore, false);
    const requests = f.requests.length;
    retiredCard.click(); retiredMore?.click(); await flush();
    assert.equal(f.requests.length, requests, "pre-refresh controls stay retired");
    const retry = f.content.querySelector(".short-video-mobile-author-index-more");
    assert(retry && retry.textContent === "重试读取作者", "retry exists independently of old EOF and visible cards");
    if (scenario === "query") {
      assert.equal(f.cards().length, 0);
      assert.equal(f.content.querySelector(".short-video-mobile-author-index-status").textContent, "读取失败，请重试读取作者", "failed new query must not claim an empty result");
      assert.equal(f.state.data.hasMore, false, "the retained old query is already at EOF");
    }
    retry.click();
    let request = f.requests.at(-1), query = params(request);
    assert.equal(query.get("offset"), "0", "scope retry must not skip the new first 24 authors");
    assert.equal(query.get("limit"), "24"); assert.equal(request.kind, "revalidated");
    await f.fail(f.requests.length - 1);
    assert.equal(f.context.needsAuthorIndexRetry(), true, "a second failure retains the data provenance mismatch");
    if (scenario === "query") f.scroll(0);
    else f.content.querySelector(".short-video-mobile-author-index-more").click();
    request = f.requests.at(-1); query = params(request);
    assert.equal(query.get("offset"), "0"); assert.equal(query.get("limit"), "24");
    assert.equal(query.get("q") || "", target.query || "");
    assert.equal(query.get("scope") || "all", target.source === "following" ? "following" : "all");
    if (target.source === "following") assert.equal(query.get("sort"), target.authorSort);
    await f.respond(f.requests.length - 1, page(expected));
    assert.deepEqual(ids(f.state.data.authors), ids(expected.slice(0, 24)), "successful first-page retry replaces old-scope IDs instead of merging them");
    assert.equal(f.context.needsAuthorIndexRetry(), false);
    await f.clickMore(page(expected, 24, 18));
    assert.equal(params(f.requests.at(-1)).get("offset"), "24");
    assert.deepEqual(ids(f.state.data.authors), ids(expected.slice(0, 42)));
    f.cards()[0].querySelector("button").click();
    await f.respond(f.requests.length - 1, { videos: [{ id: "recovered-video", streamUrl: "/synthetic/recovered.mp4" }], hasMore: false });
    assert.equal(f.native.length, 1);
    assert.deepEqual(f.navigation, [], "data recovery does not rewrite route history");
    recoveryCases++;
  });
  await run(tested, async f => {
    await f.load("following", page(ordered("following")));
    const fresh = deferred(), expected = ordered("following", "", "count");
    const refresh = f.module.routes.find(route => route.view === "shortVideos").render({ source: "following", authorSort: "count" }, () => true);
    await f.respond(f.requests.length - 1, page(expected), fresh.promise); await refresh;
    assert.equal(f.context.needsAuthorIndexRetry(), false, "accepted cache-first data already belongs to the new scope");
    await f.clickMore(page(expected, 24, 18));
    assert.equal(params(f.requests.at(-1)).get("offset"), "24"); assert.equal(f.requests.at(-1).kind, "cached");
    fresh.reject(new Error("Synthetic background refresh failure")); await flush();
    f.content.querySelector(".short-video-mobile-author-index-more").click();
    assert.equal(params(f.requests.at(-1)).get("offset"), "42");
    await f.fail(f.requests.length - 1);
    assert.equal(f.context.needsAuthorIndexRetry(), false, "same-scope append failure does not invalidate the accepted first page");
    await f.clickMore(page(expected, 42, 18));
    assert.equal(params(f.requests.at(-1)).get("offset"), "42"); assert.equal(params(f.requests.at(-1)).get("limit"), "18");
    assert.deepEqual(ids(f.state.data.authors), ids(expected.slice(0, 60)));
    recoveryCases++;
  });
  await run(tested, async f => {
    const oldVideos = Array.from({ length: 18 }, (_, i) => ({ id: `old-${i}`, title: `Old ${i}` }));
    const newVideos = Array.from({ length: 18 }, (_, i) => ({ id: `new-${i}`, title: `New ${i}` }));
    await f.load("all", { videos: oldVideos, authors: [], source: "all", total: 54, hasMore: true });
    const refresh = f.module.routes.find(route => route.view === "shortVideos").render({ source: "liked", query: "new" }, () => true);
    await f.fail(f.requests.length - 1); await refresh;
    f.scroll(0);
    const request = f.requests.at(-1), query = params(request);
    assert.equal(query.get("source"), "liked"); assert.equal(query.get("q"), "new");
    assert.equal(Number(query.get("offset") || 0), 0, "ordinary video scope retry also starts at the first page");
    assert.equal(request.kind, "revalidated");
    await f.respond(f.requests.length - 1, { videos: newVideos, authors: [], source: "liked", total: 54, hasMore: true });
    assert.deepEqual(f.state.data.videos.map(row => row.id), newVideos.map(row => row.id), "video scope recovery replaces old IDs");
    recoveryCases++;
  });
  await run(tested, async f => {
    await f.load("authors");
    const oldAuthor = f.cards()[0].querySelector("button"), oldMore = f.content.querySelector(".short-video-mobile-author-index-more");
    const videoRefresh = f.module.routes.find(route => route.view === "shortVideos").render({ source: "all" }, () => true);
    await f.fail(f.requests.length - 1); await videoRefresh;
    assert.equal(f.state.source, "all");
    assert.equal(f.content.querySelector(".short-video-mobile-author-index"), null, "failed cross-type refresh rebuilds the current target instead of preserving a retired author shell");
    const afterCrossType = f.snapshot(); oldAuthor.click(); oldMore.click(); await flush();
    assert.deepEqual(f.snapshot(), afterCrossType, "cross-type failure does not reactivate old author controls");
    recoveryCases++;
  });
}
async function scale(code, source) {
  return run(code, async f => {
    await f.load(source, envelope(range(0, 24))); const first = f.cards()[0], shell = f.content.querySelector(".short-video-mobile-list");
    const signatures = [], total = { cards: 0, createElementCalls: 0 }; let tail;
    for (let page = 0; page < 20; page++) {
      f.resetMetrics(); await f.clickMore(envelope(range(24 + page * 18, 18))); signatures.push(f.snapshot());
      tail = f.metrics(); total.cards += tail.cards; total.createElementCalls += tail.createElementCalls;
    }
    return { signatures, total, tail, retained: first.isConnected && shell === f.content.querySelector(".short-video-mobile-list"), live: f.cards().length };
  });
}

try {
  await compare("authors/following sorting, duplicates and EOF", ordinary);
  await compare("failure/retry, duplicate request, scope/server/deactivation races", errorsAndRaces);
  await compare("initial duplicate keys and revalidation after append", duplicateAndRevalidation);
  await compare("following/account tools and actual native author click", toolsAndClicks);
  await compare("search-author metadata and initial empty tabs", searchAndEmpty);
  await verifyMountedOwners();
  await verifyFailedScopeRecovery();
  console.log(`Author rendering contracts passed (${comparisons} complete state/DOM/route comparisons).`);
  const results = {};
  for (const source of ["authors", "following"]) {
    const expected = await scale(before, source), actual = await scale(tested, source);
    assert.deepEqual(actual.signatures, expected.signatures, `${source}: twenty complete page responses and DOM order`); comparisons += 20;
    assert.equal(expected.total.cards, 4260); assert.equal(expected.tail.cards, 384); assert.equal(actual.live, 384);
    assert.equal(actual.total.cards, 360, "twenty 18-author pages create each new card once");
    assert.equal(actual.tail.cards, 18, "an 18-author page must not recreate 384 cards");
    assert(actual.tail.createElementCalls < 18 * 8 + 40, "tail createElement work stays bounded by new authors and fixed controls");
    assert(actual.retained, "append retains the mounted shell and existing author card");
    results[source] = { oldTotal: expected.total, currentTotal: actual.total, oldTail: expected.tail, currentTail: actual.tail, liveCards: actual.live };
  }
  console.log(JSON.stringify({ fixture: "android-short-video-author-rendering", comparisons, recoveryCases, results }, null, 2));
} finally { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
