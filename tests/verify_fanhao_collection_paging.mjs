import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createCollectionPage } from "../public/modules/fanhao/features/collections/collection-page.js";
import { createRankingPage } from "../public/modules/fanhao/ranking-page.js";
import { createWorkActions } from "../public/modules/fanhao/features/works/work-actions.js";

// Real Web controllers and request gates, with synthetic HTTP completions and
// minimal DOM controls. No service, database, account or media is accessed.
class Element {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
    this.classList = { add() {} };
    this.isConnected = true;
    this.textContent = "更多";
    this.disabled = false;
  }
  set innerHTML(value) { this.html = value; this.children = []; }
  get innerHTML() { return this.html || ""; }
  append(...children) { this.children.push(...children); }
  setAttribute() {}
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  querySelectorAll() { return []; }
}

function fixture(view, collectionFactory = createCollectionPage, onWorkRead) {
  const requests = [], rendered = [], errors = [];
  const state = {
    activeView: view, works: [], workPageSize: 48, workVisibleLimit: 48,
    collectionTotal: 0, collectionRawLoaded: null, collectionHasMore: null, collectionLoadingMore: false,
    vrTotal: 0, vrRawLoaded: null, vrHasMore: null, vrLoadingMore: false,
    rankingTotal: 0, rankingRawLoaded: null, rankingHasMore: null, rankingLoadingMore: false,
    rankingLists: [], selectedRankingKey: "y2025", selectedFavoriteFolderId: "all",
    selectedHistoryRange: "30", filterMode: "all", sortMode: "releaseDesc", favoriteFolders: []
  };
  const els = { workGrid: new Element(), statsRow: new Element(), personProfile: new Element() };
  const deps = {
    state, els, onWorkRead, formatNumber: String, formatDate: String,
    api(path, options = {}) {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      // Deliberately ignore abort: ownership must also reject late completions.
      requests.push({ path, options, resolve, reject, url: new URL(path, "http://fixture.invalid") });
      return promise;
    },
    hidePersonProfile() {}, setMainHeader() {}, clearPersonSelection() {}, clearWorkFilter() {},
    syncRouteAfterNavigation() {}, adminRefreshRankings() {},
    visibleWorks: () => state.works,
    renderEmpty(message) { errors.push(message); },
    resetWorkPaging() { state.workVisibleLimit = 48; },
    renderStatsForWorks() { els.statsRow.innerHTML = ""; },
    renderWorks() { rendered.push({ append: false, ids: state.works.map(work => work.id) }); },
    appendLoadedWorkPage() { rendered.push({ append: true, ids: state.works.map(work => work.id) }); }
  };
  const page = view === "rankings" ? createRankingPage(deps) : collectionFactory(deps);
  const load = view === "favorites" ? page.loadFavorites : view === "history" ? page.loadHistory
    : view === "vr" ? page.loadVrWorks : page.loadRankingWorks;
  const more = view === "vr" ? page.loadMoreVrWorks : view === "rankings" ? page.loadMoreRankingWorks : page.loadMoreCollectionWorks;
  const prefix = view === "vr" ? "vr" : view === "rankings" ? "ranking" : "collection";
  return { state, page, load, more, prefix, requests, rendered, errors, els, deps };
}

function payload(ids, total, extra = {}) {
  return { works: ids.map(id => ({ id })), total, count: ids.length, ...extra };
}
function offset(request) { return Number(request.url.searchParams.get("offset")); }
function actionsFor(f) {
  return createWorkActions({
    ...f.deps,
    renderFavoriteFolderControls: f.page.renderFavoriteFolderControls,
    onCollectionStateChanged: f.page.onCollectionStateChanged,
    showError(message) { f.errors.push(message); }
  });
}
async function reply(f, promise, data) {
  f.requests.at(-1).resolve(data);
  await promise;
}
let passed = 0;
async function test(label, run) { await run(); passed += 1; console.log(`ok ${passed} - ${label}`); }
async function mutatedCollection(from, to) {
  const url = new URL("../public/modules/fanhao/features/collections/collection-page.js", import.meta.url);
  const source = await readFile(url, "utf8");
  const changed = source.replace(from, to);
  assert.notEqual(changed, source, "negative control must alter the intended product behavior");
  const linked = changed.replace(/from\s+(["'])([^"']+)\1/g, (_match, _quote, path) => `from ${JSON.stringify(new URL(path, url).href)}`);
  const module = await import(`data:text/javascript;base64,${Buffer.from(linked).toString("base64")}`);
  return module.createCollectionPage;
}

function favoriteWriteControl() {
  const control = new Element("button"), classes = new Set(), attributes = new Map();
  control.classList = {
    add: name => classes.add(name), remove: name => classes.delete(name),
    toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
    contains: name => classes.has(name)
  };
  control.setAttribute = (name, value) => attributes.set(name, String(value));
  control.getAttribute = name => attributes.get(name);
  return control;
}

function favoriteWriteFixture(factory = createWorkActions, hooks = {}) {
  const f = {
    state: { activeView: "people", works: ["a", "b"].map(id => ({ id, favorite: false, favoriteFolderId: "", favoriteFolderName: "" })), favoriteFolders: [] },
    requests: [], entries: [], settlements: [], renders: [], errors: [], finishes: [], collectionChanges: []
  };
  f.deps = {
    state: f.state,
    api(path, options) {
      let resolve, reject;
      const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
      f.requests.push({ path, options, resolve, reject });
      return pending;
    },
    beginFavoriteUi(options) {
      const entry = { ...options, index: f.entries.length }; f.entries.push(entry);
      hooks.begin?.(f, entry);
      if (hooks.withoutUi) return null;
      return {
        settle(result) {
          f.settlements.push({ entry, result, pending: f.actions.isFavoritePending(options.workId) });
          hooks.settle?.(f, entry, result);
          return true;
        },
        finish() { f.finishes.push(entry); hooks.finish?.(f, entry); }
      };
    },
    renderWorks() {
      f.renders.push({ pending: f.actions.isFavoritePending("a") });
      hooks.render?.(f);
    },
    onCollectionStateChanged(change) { f.collectionChanges.push(change); hooks.collection?.(f, change); },
    renderFavoriteFolderControls() {}, renderStatsForWorks() {},
    showError(message) { f.errors.push(message); }
  };
  f.actions = factory(f.deps);
  return f;
}

async function verifyFavoriteWriteDedup(factory = createWorkActions, withControl = true) {
  const f = favoriteWriteFixture(factory), firstControl = withControl ? favoriteWriteControl() : null;
  let favorite = false, snapshotReads = 0;
  Object.defineProperty(f.state.works[0], "favorite", {
    configurable: true, enumerable: true,
    get() { snapshotReads++; return favorite; }, set(value) { favorite = value; }
  });
  const first = f.actions.toggleFavorite("a", firstControl), readsBeforeDuplicates = snapshotReads;
  const replacement = f.actions.toggleFavorite("a", favoriteWriteControl());
  const withoutControl = f.actions.toggleFavorite("a");
  try {
    assert.equal(f.requests.length, 1, "same-ID favorite gate must prevent duplicate POST requests");
    assert.equal(snapshotReads, readsBeforeDuplicates, "a duplicate favorite intent must stop before capturing another snapshot");
    assert.equal(f.entries.length, 1, "a duplicate favorite intent must not start another UI owner");
    assert.equal(await replacement, null); assert.equal(await withoutControl, null);
    assert.equal(f.actions.isFavoritePending("a"), true);
    assert.equal(f.requests[0].path, "/api/favorites/a"); assert.equal(f.requests[0].options.method, "POST");
  } finally {
    for (const request of f.requests) request.resolve({ favorite: true });
    await Promise.all([first, replacement, withoutControl]);
  }
  assert.equal(f.actions.isFavoritePending("a"), false);
  if (firstControl) assert.equal(firstControl.disabled, false);
}

async function mutatedWorkActions(from, to) {
  const source = await readFile(new URL("../public/modules/fanhao/features/works/work-actions.js", import.meta.url), "utf8");
  assert.equal(source.split(from).length - 1, 1, "favorite negative control must target one exact product guard");
  const module = await import(`data:text/javascript;base64,${Buffer.from(source.replace(from, to)).toString("base64")}`);
  return module.createWorkActions;
}

const originals = new Map(["document", "navigator", "Option", "matchMedia"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: tag => new Element(tag) } });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { connection: { saveData: true } } });
Object.defineProperty(globalThis, "Option", { configurable: true, value: class extends Element { constructor(text, value) { super("option"); this.textContent = text; this.value = value; } } });
Object.defineProperty(globalThis, "matchMedia", { configurable: true, writable: true, value: () => ({ matches: false }) });
try {
  for (const view of ["favorites", "history", "vr", "rankings"]) {
    await test(`${view}: raw cursor, within/across-page duplicates, duplicate-only final page`, async () => {
      const f = fixture(view);
      await reply(f, f.load(), payload(["a", "a", "b"], 9));
      assert.deepEqual(f.state.works.map(work => work.id), ["a", "b"], "first page must contain unique cards");
      assert.equal(f.state[`${f.prefix}RawLoaded`], 3);
      await reply(f, f.more(new Element("button")), payload(["b", "c", "c", "a"], 9));
      assert.equal(offset(f.requests.at(-1)), 3, "offset counts consumed records, not unique cards");
      assert.deepEqual(f.state.works.map(work => work.id), ["a", "b", "c"]);
      await reply(f, f.more(), payload(["a", "c"], 9));
      assert.equal(offset(f.requests.at(-1)), 7);
      assert.equal(f.state[`${f.prefix}RawLoaded`], 9);
      assert.equal(f.state[`${f.prefix}HasMore`], false);
      await f.more();
      assert.equal(f.requests.length, 3, "duplicate-only last page must stop at the raw total");
      assert.equal(f.rendered.filter(item => item.append).length, 2, "append must use the existing card grid");
    });
    await test(`${view}: empty first page stops despite stale nonzero total`, async () => {
      const f = fixture(view);
      await reply(f, f.load(), payload([], 999));
      await f.more();
      assert.equal(f.requests.length, 1, "empty first page must not create an autoload loop");
      assert.equal(f.state[`${f.prefix}HasMore`], false);
    });
    await test(`${view}: empty append stops without losing visible cards`, async () => {
      const f = fixture(view);
      await reply(f, f.load(), payload(["a"], 999));
      await reply(f, f.more(), payload([], 999));
      await f.more();
      assert.equal(f.requests.length, 2);
      assert.deepEqual(f.state.works.map(work => work.id), ["a"]);
      assert.equal(f.state[`${f.prefix}RawLoaded`], 1);
    });
    await test(`${view}: failed append retries the same raw offset`, async () => {
      const f = fixture(view);
      await reply(f, f.load(), payload(["a", "b"], 5));
      const button = new Element("button");
      const failed = f.more(button);
      f.requests.at(-1).reject(new Error("synthetic read failure"));
      await failed;
      assert.equal(button.disabled, false);
      assert.equal(button.textContent, "synthetic read failure");
      assert.equal(f.state[`${f.prefix}RawLoaded`], 2);
      await reply(f, f.more(button), payload(["c"], 5));
      assert.deepEqual(f.requests.slice(1).map(offset), [2, 2]);
      assert.deepEqual(f.state.works.map(work => work.id), ["a", "b", "c"]);
    });
    await test(`${view}: new first page resets cursor and blocks stale load-more controls`, async () => {
      const f = fixture(view);
      await reply(f, f.load(), payload(["a", "b"], 5));
      const loading = f.load();
      await f.more();
      assert.equal(f.requests.length, 2, "load-more cannot supersede a pending first page");
      assert.equal(offset(f.requests.at(-1)), 0);
      f.requests.at(-1).resolve(payload([], 0, view === "rankings" ? { rankingTotal: 0 } : {}));
      await loading;
      assert.equal(f.state[`${f.prefix}RawLoaded`], 0);
      assert.equal(f.state[`${f.prefix}HasMore`], false);
      assert.equal(f.state[`${f.prefix}Total`], 0, "an explicit zero total must not fall back to old totals");
    });
    await test(`${view}: failed first-page refresh cannot append the retained old cards`, async () => {
      const f = fixture(view);
      await reply(f, f.load(), payload(["a", "b"], 9));
      const loading = f.load();
      f.requests.at(-1).reject(new Error("synthetic first-page failure"));
      await loading;
      await f.more();
      assert.equal(f.requests.length, 2, "failed refresh must not resume the previous cursor");
      assert.equal(f.state[`${f.prefix}HasMore`], false);
    });
    for (const settlement of ["resolve", "reject"]) {
      await test(`${view}: old append ${settlement}/finally cannot release a newer append`, async () => {
        const f = fixture(view);
        await reply(f, f.load(), payload(["a"], 9));
        const oldButton = new Element("button"), newButton = new Element("button");
        const oldMore = f.more(oldButton), oldRequest = f.requests.at(-1);
        f.page.cancelPendingRequests();
        await reply(f, f.load(), payload(["new"], 5));
        const newMore = f.more(newButton), newRequest = f.requests.at(-1);
        if (settlement === "resolve") oldRequest.resolve(payload(["old"], 9));
        else oldRequest.reject(new Error("obsolete failure"));
        await oldMore;
        assert.equal(f.state[`${f.prefix}LoadingMore`], true, "old finally cannot clear current busy state");
        assert.equal(newButton.disabled, true);
        const requestCount = f.requests.length;
        await f.more();
        assert.equal(f.requests.length, requestCount, "current append remains single-flight");
        assert.deepEqual(f.state.works.map(work => work.id), ["new"]);
        assert.notEqual(oldButton.textContent, "obsolete failure");
        newRequest.resolve(payload(["next"], 5));
        await newMore;
        assert.equal(f.state[`${f.prefix}LoadingMore`], false);
        assert.deepEqual(f.state.works.map(work => work.id), ["new", "next"]);
      });
    }
    await test(`${view}: late response after navigation does not replace another view`, async () => {
      const f = fixture(view);
      const pending = f.load();
      f.state.activeView = "people";
      f.state.works = [{ id: "other-view" }];
      f.page.cancelPendingRequests();
      f.requests.at(-1).resolve(payload(["old"], 10));
      await pending;
      assert.deepEqual(f.state.works.map(work => work.id), ["other-view"]);
      assert.deepEqual(f.rendered, []);
    });
  }
  for (const [view, field, next] of [
    ["favorites", "selectedFavoriteFolderId", "folder-new"],
    ["history", "selectedHistoryRange", "7"],
    ["vr", "filterMode", "highRating"],
    ["favorites", "sortMode", "title"],
    ["rankings", "selectedRankingKey", "y2024"]
  ]) {
    await test(`${view}: ${field} change rejects old response and restarts at zero`, async () => {
      const f = fixture(view);
      const oldLoad = f.load(), oldRequest = f.requests.at(-1);
      f.state[field] = next;
      oldRequest.resolve(payload(["old"], 8));
      await oldLoad;
      assert.deepEqual(f.state.works, [], "query ownership also protects the gap before a new request starts");
      await reply(f, f.load(), payload(["new"], 1));
      assert.equal(offset(f.requests.at(-1)), 0);
      assert.deepEqual(f.state.works.map(work => work.id), ["new"]);
    });
    await test(`${view}: changed query cannot append with the previous query's cursor`, async () => {
      const f = fixture(view);
      await reply(f, f.load(), payload(["a", "b"], 9));
      f.state[field] = next;
      await f.more();
      assert.equal(f.requests.length, 1, "an old load-more control cannot page the newly selected query");
      await reply(f, f.load(), payload(["new"], 1));
      assert.equal(offset(f.requests.at(-1)), 0);
    });
  }
  for (const view of ["favorites", "history", "vr"]) {
    await test(`${view}: boot failure is consumed once before an explicit new read`, async () => {
      const f = fixture(view);
      const prefetch = f.page.prefetch(view, { retainFailureForActivation: true });
      f.requests[0].reject(new Error("synthetic boot failure"));
      await prefetch;
      await f.load();
      assert.equal(f.requests.length, 1, "boot activation must reuse a settled failed first read");
      assert.deepEqual(f.errors, ["synthetic boot failure"]);
      await reply(f, f.load(), payload(["recovered"], 1));
      assert.equal(f.requests.length, 2, "a consumed boot failure cannot block the next explicit read");
      assert.deepEqual(f.state.works.map(work => work.id), ["recovered"]);
    });
    await test(`${view}: failed speculative read does not replace an explicit read`, async () => {
      const f = fixture(view);
      const prefetch = f.page.prefetch(view);
      f.requests[0].reject(new Error("synthetic speculative failure"));
      await prefetch;
      await reply(f, f.load(), payload(["fresh"], 1));
      assert.equal(f.requests.length, 2, "ordinary failed navigation prefetch is discarded");
      assert.deepEqual(f.errors, []);
    });
    await test(`${view}: late failed speculative read cannot evict a newer cached read`, async () => {
      const f = fixture(view);
      const old = f.page.prefetch(view);
      f.page.invalidatePrefetches();
      const current = f.page.prefetch(view);
      f.requests[1].resolve(payload(["current"], 1));
      await current;
      f.requests[0].reject(new Error("synthetic obsolete failure"));
      await old;
      await f.load();
      assert.equal(f.requests.length, 2, "an obsolete rejection must preserve the newer cache entry");
      assert.deepEqual(f.state.works.map(work => work.id), ["current"]);
    });
    await test(`${view}: desktop prefetch trimmed for mobile advances by delivered rows`, async () => {
      const f = fixture(view);
      f.state.workPageSize = 96;
      const prefetch = f.page.prefetch(view);
      assert.equal(f.requests[0].url.searchParams.get("limit"), "64");
      globalThis.matchMedia = () => ({ matches: true });
      try {
        const loading = f.load();
        f.requests[0].resolve(payload(Array.from({ length: 64 }, (_, index) => `work-${index}`), 130));
        await Promise.all([prefetch, loading]);
        assert.equal(f.requests.length, 1, "activation reuses the prefetched page");
        assert.equal(f.state.works.length, 48);
        assert.equal(f.state[`${f.prefix}RawLoaded`], 48);
        await reply(f, f.more(), payload(["work-48", "work-49"], 130));
        assert.equal(offset(f.requests.at(-1)), 48);
        assert.equal(f.requests.at(-1).url.searchParams.get("limit"), "48");
      } finally { globalThis.matchMedia = () => ({ matches: false }); }
    });
  }
  await test("favorites to history: old append does not release the newer collection read", async () => {
    const f = fixture("favorites");
    await reply(f, f.load(), payload(["favorite"], 9));
    const oldMore = f.more(), oldRequest = f.requests.at(-1);
    f.state.activeView = "history";
    await reply(f, f.page.loadHistory(), payload(["history"], 5));
    const nextMore = f.page.loadMoreCollectionWorks(), nextRequest = f.requests.at(-1);
    oldRequest.reject(new Error("late favorites failure"));
    await oldMore;
    assert.equal(f.state.collectionLoadingMore, true);
    assert.deepEqual(f.state.works.map(work => work.id), ["history"]);
    nextRequest.resolve(payload(["history-next"], 5));
    await nextMore;
    assert.deepEqual(f.state.works.map(work => work.id), ["history", "history-next"]);
  });
  await test("rankings: display total stays independent from pageable total", async () => {
    const f = fixture("rankings");
    await reply(f, f.load(), payload(["a", "b"], 3, { rankingTotal: 250, localTotal: 200, missingTotal: 50 }));
    await reply(f, f.more(), payload(["c"], 3, { rankingTotal: 250, localTotal: 200, missingTotal: 50 }));
    await f.more();
    assert.equal(f.state.rankingTotal, 250);
    assert.equal(f.state.rankingLocalTotal, 200);
    assert.equal(f.state.rankingMissingTotal, 50);
    assert.equal(f.state.rankingHasMore, false);
    assert.equal(f.requests.length, 2);
  });
  await test("rankings: summary-selected fallback list owns its first page", async () => {
    const f = fixture("rankings");
    f.state.selectedRankingKey = "removed";
    const loading = f.page.loadRankings();
    f.requests[0].resolve({ lists: [{ key: "y2025", label: "TOP250 2025" }] });
    f.requests[1].resolve(payload(["wrong-list"], 999));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.requests.length, 3);
    assert.equal(f.requests[2].url.searchParams.get("key"), "y2025");
    f.requests[2].resolve(payload(["a", "a", "b"], 3, { rankingTotal: 3 }));
    await loading;
    assert.deepEqual(f.state.works.map(work => work.id), ["a", "b"]);
    assert.equal(f.state.rankingRawLoaded, 3);
    assert.equal(f.state.rankingHasMore, false);
  });
  await test("rankings: local sorting retains the consumed server cursor", async () => {
    const f = fixture("rankings");
    await reply(f, f.load(), payload(["a", "a", "b"], 7));
    const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
    const sort = descendants(f.els.statsRow).find(node => node.className === "ranking-sort-select");
    assert(sort, "use the actual rendered sorting control");
    sort.value = "title";
    await sort.listeners.get("change")();
    assert.equal(f.state.sortMode, "title");
    await reply(f, f.more(), payload(["c"], 7));
    assert.equal(offset(f.requests.at(-1)), 3, "ranking endpoint has no sort parameter, so local sort must not rewind raw pagination");
  });
  await test("favorites: confirmed removal shifts the consumed server prefix before append", async () => {
    const f = fixture("favorites");
    const records = Array.from({ length: 60 }, (_, index) => ({ id: `work-${index}`, favorite: true }));
    await reply(f, f.load(), { works: records.slice(0, 48), total: 60 });
    const actions = actionsFor(f);
    await reply(f, actions.toggleFavorite("work-0"), { favorite: false, folders: [] });
    records.shift();
    const loading = f.more();
    const request = f.requests.at(-1);
    request.resolve({ works: records.slice(offset(request), offset(request) + 48), total: records.length });
    await loading;
    assert.equal(offset(request), 47, "confirmed local removal must shift the raw cursor with the server collection");
    assert(f.state.works.some(work => work.id === "work-48"), "the original next record must remain reachable after removing a loaded favorite");
  });
  await test("favorites: moving a loaded work out of the selected folder shifts the raw prefix", async () => {
    const f = fixture("favorites");
    f.state.selectedFavoriteFolderId = "folder-a";
    await reply(f, f.load(), payload(["a", "b", "c"], 5));
    const moved = actionsFor(f).moveFavoriteToFolder(f.state.works[0], "folder-b", new Element("select"));
    await reply(f, moved, { favorite: { folderId: "folder-b", folderName: "B" }, folders: [] });
    assert.equal(f.state.collectionRawLoaded, 2);
    assert.equal(f.state.collectionTotal, 4);
    await reply(f, f.more(), payload(["d", "e"], 4));
    assert.equal(offset(f.requests.at(-1)), 2);
    assert.deepEqual(f.state.works.map(work => work.id), ["b", "c", "d", "e"]);
  });
  for (const settlement of ["resolve", "reject"]) {
    await test(`favorites: confirmed removal cancels old-offset append ${settlement}`, async () => {
      const f = fixture("favorites");
      await reply(f, f.load(), payload(["a", "b", "c"], 5));
      const oldMore = f.more(), oldRequest = f.requests.at(-1);
      await reply(f, actionsFor(f).toggleFavorite("a"), { favorite: false });
      assert.equal(oldRequest.options.signal.aborted, true, "a read holding the pre-removal offset is obsolete");
      const newMore = f.more(), newRequest = f.requests.at(-1);
      assert.equal(offset(newRequest), 2);
      if (settlement === "resolve") oldRequest.resolve(payload(["obsolete"], 5));
      else oldRequest.reject(new Error("obsolete offset failure"));
      await oldMore;
      assert.equal(f.state.collectionLoadingMore, true);
      assert.equal(f.state.collectionRawLoaded, 2);
      assert.deepEqual(f.state.works.map(work => work.id), ["b", "c"]);
      newRequest.resolve(payload(["d", "e"], 4));
      await newMore;
      assert.deepEqual(f.state.works.map(work => work.id), ["b", "c", "d", "e"]);
    });
  }
  await test("favorites: a write for an unloaded member cannot decrement this prefix", async () => {
    const f = fixture("favorites");
    await reply(f, f.load(), payload(["a", "b", "c"], 9));
    await reply(f, actionsFor(f).toggleFavorite("unloaded"), { favorite: false });
    assert.equal(f.state.collectionRawLoaded, 3);
    await reply(f, f.more(), payload(["next"], 8));
    assert.equal(offset(f.requests.at(-1)), 3);
  });
  await test("favorites: moving between folders in the all-folders view retains the prefix", async () => {
    const f = fixture("favorites");
    await reply(f, f.load(), payload(["a", "b", "c"], 9));
    await reply(f, actionsFor(f).moveFavoriteToFolder(f.state.works[0], "folder-b", new Element("select")),
      { favorite: { folderId: "folder-b", folderName: "B" } });
    assert.equal(f.state.collectionRawLoaded, 3);
    assert.deepEqual(f.state.works.map(work => work.id), ["a", "b", "c"]);
    await reply(f, f.more(), payload(["next"], 9));
    assert.equal(offset(f.requests.at(-1)), 3);
  });
  await test("favorites: failed removal preserves cards, total and raw prefix", async () => {
    const f = fixture("favorites");
    await reply(f, f.load(), payload(["a", "b", "c"], 9));
    const mutation = actionsFor(f).toggleFavorite("a");
    f.requests.at(-1).reject(new Error("synthetic write failure"));
    await mutation;
    assert.deepEqual(f.state.works.map(work => work.id), ["a", "b", "c"]);
    assert.equal(f.state.collectionRawLoaded, 3);
    assert.equal(f.state.collectionTotal, 9);
    assert.deepEqual(f.errors, ["synthetic write failure"]);
  });
  await test("favorites: a late write cannot cancel the newer history append", async () => {
    const f = fixture("favorites");
    await reply(f, f.load(), payload(["favorite"], 9));
    const mutation = actionsFor(f).toggleFavorite("favorite"), mutationRequest = f.requests.at(-1);
    f.state.activeView = "history";
    await reply(f, f.page.loadHistory(), payload(["history"], 5));
    const loading = f.page.loadMoreCollectionWorks(), request = f.requests.at(-1);
    mutationRequest.resolve({ favorite: false });
    await mutation;
    assert.equal(request.options.signal.aborted, false);
    assert.equal(f.state.collectionLoadingMore, true);
    assert.equal(f.state.collectionRawLoaded, 1);
    request.resolve(payload(["next"], 5));
    await loading;
    assert.deepEqual(f.state.works.map(work => work.id), ["history", "next"]);
  });
  await test("favorites: repeated, unknown and still-visible removal IDs cannot over-adjust the prefix", async () => {
    const f = fixture("favorites");
    await reply(f, f.load(), payload(["a", "b", "c"], 9));
    f.page.onCollectionStateChanged({ removedWorkIds: ["a", "unknown", "unknown"] });
    assert.equal(f.state.collectionRawLoaded, 3, "a visible card has not actually been removed");
    f.state.works = f.state.works.filter(work => work.id !== "a");
    f.page.onCollectionStateChanged({ removedWorkIds: ["a", "a", "unknown"] });
    assert.equal(f.state.collectionRawLoaded, 2);
    assert.equal(f.state.collectionTotal, 8);
    f.page.onCollectionStateChanged({ removedWorkIds: ["a", "a", "unknown"] });
    assert.equal(f.state.collectionRawLoaded, 2, "the loaded-member snapshot consumes a confirmed removal once");
    assert.equal(f.state.collectionTotal, 8);
  });
  for (const stoppedBy of ["total", "empty"]) {
    await test(`favorites: local removal cannot reopen pagination stopped by ${stoppedBy}`, async () => {
      const f = fixture("favorites");
      await reply(f, f.load(), payload(["a", "b", "c"], stoppedBy === "total" ? 3 : 999));
      if (stoppedBy === "empty") await reply(f, f.more(), payload([], 999));
      await reply(f, actionsFor(f).toggleFavorite("a"), { favorite: false });
      assert.equal(f.state.collectionRawLoaded, 2);
      assert.equal(f.state.collectionHasMore, false);
      const count = f.requests.length;
      await f.more();
      assert.equal(f.requests.length, count);
    });
  }
  await test("favorites: failed folder target survives rollback and gated retry without changing work metadata", async () => {
    const f = fixture("favorites"), entries = [], settlements = []; let finished = 0;
    const video = { id: "v", sourcePath: "[A] fixture/video.mp4", progress: { positionMs: 42000 } };
    const work = { id: "a", title: "Current title", favorite: true, favoriteFolderId: "default", favoriteFolderName: "默认", localMarkers: ["A"], relativePath: "[A] fixture", videos: [video] };
    await reply(f, f.load(), { works: [work], total: 1 });
    f.state.currentWork = { ...work, title: "Current detail title" };
    f.deps.beginFavoriteUi = options => {
      entries.push(options);
      return { settle(result) { settlements.push(result); return true; }, finish() { finished++; } };
    };
    const actions = actionsFor(f), control = new Element("select"); control.value = "folder-b";
    const failed = actions.moveFavoriteToFolder(work, "folder-b", control);
    assert.equal(actions.isFavoriteFolderPending("a"), true); assert.equal(control.disabled, true);
    assert.equal(entries[0].requestedFolderId, "folder-b", "actual folder UI ownership must receive the explicit failed destination");
    f.requests.at(-1).reject(new Error("synthetic folder target failure")); await failed;
    assert.equal(control.value, "default"); assert.equal(control.disabled, false); assert.equal(actions.isFavoriteFolderPending("a"), false);
    assert.equal(work.favoriteFolderId, "default"); assert.equal(f.state.currentWork.favoriteFolderId, "default");
    const retried = actions.moveFavoriteToFolder(work, entries[0].requestedFolderId, control), request = f.requests.at(-1);
    assert.equal(entries[1].requestedFolderId, "folder-b", "a repeated retry must not infer its target from the rolled-back selection");
    assert.deepEqual(request.options.body, { folderId: "folder-b" });
    assert.equal(await actions.moveFavoriteToFolder(work, "different-folder", control), null);
    assert.equal(f.requests.length, 3, "a pending folder retry must share the existing per-work write gate");
    request.resolve({ favorite: { folderId: "folder-b", folderName: "B" }, folders: [] }); await retried;
    assert.equal(actions.isFavoriteFolderPending("a"), false); assert.equal(control.disabled, false);
    assert.equal(work.favoriteFolderId, "folder-b"); assert.equal(f.state.currentWork.favoriteFolderId, "folder-b");
    assert.equal(work.title, "Current title"); assert.equal(f.state.currentWork.title, "Current detail title");
    assert.equal(work.videos[0], video); assert.equal(video.progress.positionMs, 42000); assert.deepEqual(work.localMarkers, ["A"]); assert.equal(work.relativePath, "[A] fixture");
    assert.equal(f.state.collectionRawLoaded, 1); assert.equal(f.state.collectionTotal, 1); assert.equal(finished, 2); assert.equal(settlements.length, 2); assert.deepEqual(f.errors, []);
  });
  await test("favorites: folder recovery gates remain independent across work IDs and release on each settlement", async () => {
    const f = fixture("favorites"), entries = []; let finished = 0;
    const works = ["a", "b"].map(id => ({ id, favorite: true, favoriteFolderId: "default" }));
    await reply(f, f.load(), { works, total: 2 });
    f.deps.beginFavoriteUi = options => { entries.push(options); return { settle: () => true, finish() { finished++; } }; };
    const actions = actionsFor(f), firstControl = new Element("select"), secondControl = new Element("select");
    const first = actions.moveFavoriteToFolder(works[0], "folder-b", firstControl), firstRequest = f.requests.at(-1);
    const second = actions.moveFavoriteToFolder(works[1], "folder-c", secondControl), secondRequest = f.requests.at(-1);
    assert.equal(actions.isFavoriteFolderPending("a"), true); assert.equal(actions.isFavoriteFolderPending("b"), true);
    assert.equal(await actions.moveFavoriteToFolder(works[0], "ignored", firstControl), null); assert.equal(f.requests.length, 3);
    secondRequest.reject(new Error("synthetic independent folder failure")); await second;
    assert.equal(actions.isFavoriteFolderPending("a"), true); assert.equal(actions.isFavoriteFolderPending("b"), false); assert.equal(secondControl.value, "default");
    const retry = actions.moveFavoriteToFolder(works[1], entries[1].requestedFolderId, secondControl), retryRequest = f.requests.at(-1);
    assert.deepEqual(retryRequest.options.body, { folderId: "folder-c" });
    firstRequest.resolve({ favorite: { folderId: "folder-b", folderName: "B" } }); await first;
    assert.equal(actions.isFavoriteFolderPending("a"), false); assert.equal(actions.isFavoriteFolderPending("b"), true);
    retryRequest.resolve({ favorite: { folderId: "folder-c", folderName: "C" } }); await retry;
    assert.equal(actions.isFavoriteFolderPending("b"), false); assert.equal(firstControl.disabled, false); assert.equal(secondControl.disabled, false);
    assert.deepEqual(works.map(work => work.favoriteFolderId), ["folder-b", "folder-c"]); assert.equal(finished, 3); assert.equal(entries.length, 3);
    assert.equal(f.state.collectionRawLoaded, 2); assert.equal(f.state.collectionTotal, 2); assert.deepEqual(f.errors, []);
  });
  for (const phase of ["settled-empty", "pending", "consumed"]) {
    await test(`favorites: marker cache invalidation preserves ${phase} transport ownership`, async () => {
      const owners = [];
      const f = fixture("favorites", undefined, (path, isCurrent) => {
        const owner = { path, isCurrent, retired: 0 }; owners.push(owner);
        return () => { owner.retired++; };
      });
      const fresh = payload(["marked"], 1);
      Object.assign(fresh.works[0], { localMarkers: ["A"], relativePath: "[A] fixture-marked", videos: [{ id: "v", sourcePath: "[A] fixture-marked/video.mp4" }] });
      const warming = f.page.prefetch("favorites");
      try {
        assert.equal(f.requests.length, 1); assert.equal(owners.length, 0);
        if (phase === "settled-empty") { f.requests[0].resolve(payload([], 0)); await warming; }
        if (phase === "consumed") {
          const foreground = f.load();
          assert.equal(f.requests.length, 1); assert.equal(owners.length, 1);
          const owner = owners[0];
          f.page.invalidatePrefetches();
          assert.equal(f.requests.length, 1, "collection cache invalidation must not restart a consumed foreground GET");
          assert.equal(owner.isCurrent(), true, "collection cache invalidation must preserve its actual foreground owner");
          assert.equal(owner.retired, 0); assert.equal(f.requests[0].options.signal, undefined, "collection speculative transport retains its existing no-signal contract");
          f.requests[0].resolve(fresh); await foreground;
          assert.equal(owner.retired, 1, "collection consumed foreground must retire once on completion");
        } else {
          f.page.invalidatePrefetches();
          assert.equal(f.requests.length, 1, "collection invalidation must remain cache-only without an automatic GET");
          const foreground = f.load();
          assert.equal(f.requests.length, 2, `collection invalidated ${phase} cache must not serve a later activation`);
          f.requests[1].resolve(fresh); await foreground;
          f.requests[0].resolve(payload([], 0)); await warming;
          assert.equal(owners.length, 1); assert.equal(owners[0].retired, 1);
        }
        assert.deepEqual(f.state.works.map(work => work.id), ["marked"]);
        assert.deepEqual(f.state.works[0].localMarkers, ["A"]);
        assert.equal(f.state.works[0].relativePath, "[A] fixture-marked");
        assert.equal(f.state.works[0].videos[0].sourcePath, "[A] fixture-marked/video.mp4");
      } finally { f.page.cancelPendingRequests(); for (const request of f.requests) request.resolve(payload([], 0)); await warming; }
    });
  }
  for (const withControl of [true, false]) {
    await test(`favorites: ${withControl ? "card" : "no-control"} write deduplicates replacement-control and direct same-ID intents before setup`,
      () => verifyFavoriteWriteDedup(createWorkActions, withControl));
  }
  await test("favorites: ordinary write gates allow different IDs in parallel and release each settlement independently", async () => {
    const f = favoriteWriteFixture(), aControl = favoriteWriteControl(), bControl = favoriteWriteControl();
    const a = f.actions.toggleFavorite("a", aControl), aRequest = f.requests.at(-1);
    const b = f.actions.toggleFavorite("b", bControl), bRequest = f.requests.at(-1);
    assert.equal(f.requests.length, 2); assert.equal(f.actions.isFavoritePending("a"), true); assert.equal(f.actions.isFavoritePending("b"), true);
    bRequest.reject(new Error("synthetic independent ordinary failure")); await b;
    assert.equal(f.actions.isFavoritePending("a"), true); assert.equal(f.actions.isFavoritePending("b"), false); assert.equal(bControl.disabled, false);
    const retry = f.actions.toggleFavorite("b", bControl), retryRequest = f.requests.at(-1);
    assert.equal(f.requests.length, 3, "a failed ordinary write must allow the next explicit toggle");
    aRequest.resolve({ favorite: true }); await a;
    assert.equal(f.actions.isFavoritePending("a"), false); assert.equal(f.actions.isFavoritePending("b"), true); assert.equal(aControl.disabled, false);
    const next = f.actions.toggleFavorite("a"), nextRequest = f.requests.at(-1);
    assert.equal(f.requests.length, 4, "a successful ordinary write must allow the next explicit toggle");
    retryRequest.resolve({ favorite: true }); await retry;
    assert.equal(f.actions.isFavoritePending("a"), true); assert.equal(f.actions.isFavoritePending("b"), false);
    nextRequest.resolve({ favorite: false }); await next;
    assert.equal(f.actions.isFavoritePending("a"), false); assert.equal(bControl.disabled, false);
  });
  for (const settlement of ["resolve", "reject"]) {
    for (const presentation of ["settle", "fallback"]) {
      await test(`favorites: ordinary ${settlement} releases its gate before ${presentation} presentation`, async () => {
        const f = favoriteWriteFixture(undefined, { withoutUi: presentation === "fallback" });
        const control = presentation === "settle" ? favoriteWriteControl() : null;
        const pending = f.actions.toggleFavorite("a", control), request = f.requests.at(-1);
        assert.equal(f.actions.isFavoritePending("a"), true);
        if (settlement === "resolve") request.resolve({ favorite: true });
        else request.reject(new Error("synthetic ordinary presentation failure"));
        await pending;
        const observations = presentation === "settle" ? f.settlements : f.renders;
        assert.equal(observations.length, 1); assert.equal(observations[0].pending, false, "replacement presentation must inherit a released ordinary write gate");
        assert.equal(f.actions.isFavoritePending("a"), false);
        const next = f.actions.toggleFavorite("a", control);
        assert.equal(f.requests.length, 2, "settled ordinary writes must not leave a leaked gate");
        f.requests.at(-1).resolve({ favorite: false }); await next;
      });
    }
  }
  for (const setup of ["snapshot", "ui-hook", "optimistic-control"]) {
    await test(`favorites: ${setup} setup failure releases the ordinary write gate without issuing a POST`, async () => {
      let failSetup = true;
      const f = favoriteWriteFixture(undefined, { begin() { if (setup === "ui-hook" && failSetup) throw new Error("synthetic favorite setup failure"); } });
      const control = favoriteWriteControl(), work = f.state.works[0];
      if (setup === "snapshot") Object.defineProperty(work, "favorite", { configurable: true, get() { throw new Error("synthetic favorite setup failure"); } });
      if (setup === "optimistic-control") {
        const toggle = control.classList.toggle;
        control.classList.toggle = (...args) => { if (failSetup) throw new Error("synthetic favorite setup failure"); return toggle(...args); };
      }
      await assert.rejects(f.actions.toggleFavorite("a", control), /synthetic favorite setup failure/);
      assert.equal(f.requests.length, 0); assert.equal(f.actions.isFavoritePending("a"), false); assert.equal(control.disabled, false);
      failSetup = false;
      if (setup === "snapshot") Object.defineProperty(work, "favorite", { configurable: true, writable: true, enumerable: true, value: false });
      const next = f.actions.toggleFavorite("a", control);
      assert.equal(f.requests.length, 1, "setup failure must permit a subsequent explicit toggle");
      f.requests[0].resolve({ favorite: true }); await next;
      assert.equal(f.actions.isFavoritePending("a"), false);
    });
  }
  for (const settlement of ["resolve", "reject"]) {
    for (const presentation of ["settle", "fallback"]) {
      await test(`favorites: ordinary ${settlement} ${presentation} hook reentry retains the newer same-control owner`, async () => {
        let newer, newerRequest, reentered = false;
        const control = favoriteWriteControl();
        const reenter = f => {
          if (reentered) return;
          reentered = true; newer = f.actions.toggleFavorite("a", control); newerRequest = f.requests.at(-1);
        };
        const f = favoriteWriteFixture(undefined, { withoutUi: presentation === "fallback", settle: presentation === "settle" ? reenter : undefined, render: presentation === "fallback" ? reenter : undefined });
        const first = f.actions.toggleFavorite("a", control), firstRequest = f.requests.at(-1);
        if (settlement === "resolve") firstRequest.resolve({ favorite: true });
        else firstRequest.reject(new Error("synthetic reentered ordinary failure"));
        await first;
        try {
          assert.equal(f.requests.length, 2, "settlement presentation must admit the next same-ID explicit toggle");
          assert.equal(f.actions.isFavoritePending("a"), true, "old finally must not clear the newer ordinary write gate");
          assert.equal(control.disabled, true, "old finally must not enable a control reused by the newer ordinary write");
          assert.equal(control.classList.contains("pending"), true);
          assert.equal(await f.actions.toggleFavorite("a"), null);
          assert.equal(f.requests.length, 2, "newer owner must continue deduplicating same-ID direct calls");
        } finally { newerRequest?.resolve({ favorite: false }); await newer; }
        assert.equal(f.actions.isFavoritePending("a"), false); assert.equal(control.disabled, false);
      });
    }
  }
  await test("favorites: collection-change hook reentry cannot be released by the completed ordinary write", async () => {
    let newer, newerRequest, reentered = false;
    const control = favoriteWriteControl();
    const f = favoriteWriteFixture(undefined, { collection(current) {
      if (reentered) return;
      reentered = true; newer = current.actions.toggleFavorite("a", control); newerRequest = current.requests.at(-1);
    } });
    const first = f.actions.toggleFavorite("a", control); f.requests[0].resolve({ favorite: true }); await first;
    try {
      assert.equal(f.requests.length, 2, "collection callbacks must observe the previous gate already released");
      assert.equal(f.actions.isFavoritePending("a"), true); assert.equal(control.disabled, true);
      assert.equal(await f.actions.toggleFavorite("a"), null); assert.equal(f.requests.length, 2);
    } finally { newerRequest?.resolve({ favorite: false }); await newer; }
    assert.equal(f.actions.isFavoritePending("a"), false); assert.equal(control.disabled, false);
  });
  {
    const factory = await mutatedWorkActions("if (isFavoritePending(writeKey)) return null;", "");
    await assert.rejects(() => verifyFavoriteWriteDedup(factory), error => {
      assert.equal(error.code, "ERR_ASSERTION", "favorite negative must fail on behavior, not fixture setup");
      assert.match(error.message, /same-ID favorite gate must prevent duplicate POST requests/);
      assert.equal(error.actual, 3); assert.equal(error.expected, 1);
      return true;
    });
    console.log("negative ok - deleting the ordinary favorite gate issues three POSTs instead of one");
  }
  {
    const factory = await mutatedCollection(
      "return Number.isSafeInteger(state[`${prefix}RawLoaded`]) ? state[`${prefix}RawLoaded`] : state.works.length;",
      "return state.works.length;"
    );
    await assert.rejects(async () => {
      const f = fixture("favorites", factory);
      await reply(f, f.load(), payload(["a", "a", "b"], 7));
      await reply(f, f.more(), payload(["c"], 7));
      assert.equal(offset(f.requests.at(-1)), 3, "raw cursor regression must be detected");
    }, /raw cursor regression must be detected/);
    console.log("negative ok - restoring visible-card offsets fails the raw-cursor assertion");
  }
  {
    const factory = await mutatedCollection("if (appendOwners[prefix] !== owner) return;", "");
    await assert.rejects(async () => {
      const f = fixture("favorites", factory);
      await reply(f, f.load(), payload(["a"], 7));
      const oldMore = f.more(), oldRequest = f.requests.at(-1);
      f.page.cancelPendingRequests();
      await reply(f, f.load(), payload(["new"], 7));
      const newMore = f.more(), newRequest = f.requests.at(-1);
      oldRequest.resolve(payload(["old"], 7));
      await oldMore;
      try {
        assert.equal(f.state.collectionLoadingMore, true, "old finally regression must be detected");
      } finally {
        newRequest.resolve(payload(["next"], 7));
        await newMore;
      }
    }, /old finally regression must be detected/);
    console.log("negative ok - removing append ownership fails the busy-state assertion");
  }
  {
    const factory = await mutatedCollection(
      'if (collectionPrefetches.get(`${view}:${shape}`) === prefetched) collectionPrefetches.delete(`${view}:${shape}`);',
      ""
    );
    await assert.rejects(async () => {
      const f = fixture("favorites", factory);
      const prefetch = f.page.prefetch("favorites", { retainFailureForActivation: true });
      f.requests[0].reject(new Error("synthetic boot failure"));
      await prefetch; await f.load();
      const next = f.load();
      try { assert.equal(f.requests.length, 2, "consumed boot failure must not poison the next read"); }
      finally { f.requests[1]?.resolve(payload(["recovered"], 1)); await next; }
    }, /consumed boot failure must not poison the next read/);
    console.log("negative ok - retained consumed failure blocks the next explicit read");
  }
  {
    const factory = await mutatedCollection(
      "result.error && !retainFailureForActivation && collectionPrefetches.get(cacheKey) === entry",
      "result.error && !retainFailureForActivation"
    );
    await assert.rejects(async () => {
      const f = fixture("favorites", factory), old = f.page.prefetch("favorites");
      f.page.invalidatePrefetches();
      const current = f.page.prefetch("favorites");
      f.requests[1].resolve(payload(["current"], 1)); await current;
      f.requests[0].reject(new Error("synthetic obsolete failure")); await old;
      const loading = f.load();
      try { assert.equal(f.requests.length, 2, "obsolete failure must not evict the newer cached read"); }
      finally { f.requests[2]?.resolve(payload(["replacement"], 1)); await loading; }
    }, /obsolete failure must not evict the newer cached read/);
    console.log("negative ok - obsolete rejection evicts a newer cached read without entry ownership");
  }
  console.log(`fanhao-collection-paging: ok (${passed} synthetic Web controller scenarios + 5 independent negative controls)`);
} finally {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
}
