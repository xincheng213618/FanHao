import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createLatestRequestGate } from "../public/modules/fanhao/latest-request.js";
import { createPeoplePage } from "../public/modules/fanhao/people-page.js";
import { createPrefetchCache } from "../public/modules/fanhao/prefetch-cache.js";
import { createSearchRequestService } from "../public/modules/fanhao/search-request-service.js";
import { createCodePrefixPage } from "../public/modules/fanhao/code-prefix-page.js";
import { createStudioPage } from "../public/modules/fanhao/features/studios/studio-page.js";

// Execute production request/page services and the current shell functions.
// DOM and HTTP completion order are doubled; no browser, service or DB is used.
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferredApi({ ignoreAbort = false } = {}) {
  const calls = [];
  let active = 0, peak = 0;
  const api = (path, options = {}) => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const call = { path, signal: options.signal, resolve, reject };
    calls.push(call);
    peak = Math.max(peak, ++active);
    const abort = () => { if (!ignoreAbort) reject(new DOMException("Request aborted", "AbortError")); };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    return promise.finally(() => { active--; options.signal?.removeEventListener("abort", abort); });
  };
  return { api, calls, peak: () => peak };
}

async function verifyPrefetchBudget() {
  const transport = deferredApi();
  const cache = createPrefetchCache({ limit: 3, ttlMs: 1000 });
  const waiting = [];
  for (let index = 0; index < 20; index++) {
    waiting.push(cache.prefetch(String(index), (signal) => transport.api(String(index), { signal })));
  }
  assert.equal(transport.calls.length, 2, "queued speculative work must not exceed two real transports");
  assert.equal(cache.entries.size, 3, "cache eviction must remain independently bounded");
  assert(transport.calls.every((call) => call.signal.aborted), "evicted active entries must receive abort");
  await flush();
  assert(transport.peak() <= 2, "replacement requests must wait for aborted transports to settle");
  cache.clear();
  await Promise.all(waiting);
  await flush();
  assert(transport.calls.every((call) => call.signal.aborted), "leaving must cancel queued and active prefetches");

  const delayed = deferredApi({ ignoreAbort: true });
  const limited = createPrefetchCache({ limit: 2, ttlMs: 1000 });
  limited.prefetch("old-1", (signal) => delayed.api("old-1", { signal }));
  limited.prefetch("old-2", (signal) => delayed.api("old-2", { signal }));
  const latest = limited.prefetch("latest", (signal) => delayed.api("latest", { signal }));
  assert.equal(delayed.calls.length, 2, "an abort-ignoring transport must retain its concurrency slot");
  delayed.calls[0].resolve({ old: true });
  await flush();
  assert.equal(delayed.calls[2].path, "latest", "the queued replacement must start after an old slot is released");
  limited.clear();
  await latest;
  delayed.calls[1].resolve({}); delayed.calls[2].resolve({});
  await flush();

  const expiring = deferredApi();
  const shortCache = createPrefetchCache({ ttlMs: 15 });
  const expired = shortCache.prefetch("expires", (signal) => expiring.api("expires", { signal }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await expired).data, null);
  assert(expiring.calls[0].signal.aborted, "TTL expiry must cancel the transport, not only discard its reference");
  assert.equal(shortCache.entries.size, 0);
}

async function verifySearchRequests() {
  const transport = deferredApi({ ignoreAbort: true });
  const service = createSearchRequestService({ api: transport.api, filter: () => "all", pageSize: () => 48, sort: () => "releaseDesc" });
  service.prefetch("prepared");
  const submitted = service.fetchPage("prepared");
  assert.equal(transport.calls.length, 1, "submit must share an in-flight prepared request");
  service.cancel();
  assert(transport.calls[0].signal.aborted, "leaving must abort a consumed prefetch");
  assert.equal(await submitted, null, "cancelled shared work must release its consumer even when the transport ignores abort");
  transport.calls[0].resolve({ works: [{ id: "obsolete" }] });
  await flush();
  const older = service.fetchPage("older");
  const newer = service.fetchPage("newer");
  assert(transport.calls[1].signal.aborted);
  transport.calls[1].reject(new Error("obsolete request failed"));
  assert.equal(await older, null);
  transport.calls[2].resolve({ works: [{ id: "newer" }] });
  assert.deepEqual(await newer, { works: [{ id: "newer" }] }, "an obsolete finally must not invalidate the newer gate");
  service.cancel();

  const blocked = deferredApi({ ignoreAbort: true });
  const urgent = createSearchRequestService({ api: blocked.api, filter: () => "all", pageSize: () => 48, sort: () => "releaseDesc" });
  urgent.prefetch("background-1"); urgent.prefetch("background-2"); urgent.prefetch("submitted");
  assert.equal(blocked.calls.length, 2);
  const foreground = urgent.fetchPage("submitted");
  assert.equal(blocked.calls.length, 3, "a formal submit must start immediately without waiting for background TTL/abort settlement");
  assert.equal(new URL(blocked.calls[2].path, "http://fixture").searchParams.get("q"), "submitted");
  assert(blocked.calls[0].signal.aborted && blocked.calls[1].signal.aborted);
  blocked.calls[2].resolve({ works: [{ id: "urgent" }] });
  assert.deepEqual(await foreground, { works: [{ id: "urgent" }] });
  blocked.calls[0].resolve({}); blocked.calls[1].resolve({});
  urgent.cancel();
  await flush();
}

function peopleFixture() {
  const transport = deferredApi({ ignoreAbort: true });
  const renders = [], errors = [];
  const element = () => ({ innerHTML: "", addEventListener() {} });
  const state = {
    activeView: "people", peopleScope: "main", selectedPersonId: "person", selectedPerson: { id: "person", name: "人物" },
    people: [{ id: "person", name: "人物" }], works: [{ id: "first" }], personWorksTotal: 100,
    workPageSize: 48, workVisibleLimit: 48, personWorksLoadingMore: false, sortMode: "releaseDesc", filterMode: "all"
  };
  const page = createPeoplePage({
    api: transport.api, state, els: { workGrid: element(), statsRow: element() },
    appendEmpty() {}, cancelScheduledWorkRendering() {}, clearWorkSearch() {}, coverUrl: () => "",
    currentPageScrollTop: () => 0, displayPersonName: (person) => person.name, formatLibraryPaths: () => "", formatNumber: String,
    getWorkFilterMode: () => state.filterMode, clearWorkFilter() { state.filterMode = "all"; }, hidePersonProfile() {},
    renderPersonProfile() {}, renderPersonWorkStats() {}, resetProgressiveCoverLoading() {}, resetWorkPaging() {},
    restorePageScrollTop() {}, setMainHeader() {}, syncNavigationState() {}, syncRouteAfterNavigation() {}, workCoverUrl: () => "",
    renderWorks() { renders.push(state.works.map((work) => work.id)); },
    appendLoadedWorkPage() { renders.push(state.works.map((work) => work.id)); },
    toastInline(_button, message) { errors.push(message); }
  });
  return { ...transport, state, page, renders, errors };
}

async function verifyPersonPaging() {
  for (const change of ["sort", "filter"]) {
    const f = peopleFixture();
    const oldPage = f.page.loadMoreWorks(null);
    if (change === "sort") f.state.sortMode = "ratingDesc";
    else f.state.filterMode = "favorite";
    const firstPage = f.page.selectPerson("person", { resetFilter: false });
    assert(f.calls[0].signal.aborted, "a new person query must abort old pagination");
    f.calls[1].resolve({ person: { id: "person", name: "人物" }, works: [{ id: "fresh-first" }], total: 100 });
    await firstPage;
    const currentPage = f.page.loadMoreWorks(null);
    f.calls[0].resolve({ works: [{ id: "obsolete-second" }], total: 100 });
    await oldPage;
    assert.deepEqual(f.state.works.map((work) => work.id), ["fresh-first"], "old pagination must not append to a new sort/filter");
    assert.equal(f.state.personWorksLoadingMore, true, "an old finally must not release a newer pagination request");
    f.calls[2].resolve({ works: [{ id: "fresh-second" }], total: 100 });
    await currentPage;
    assert.deepEqual(f.state.works.map((work) => work.id), ["fresh-first", "fresh-second"]);
    assert.equal(f.state.personWorksLoadingMore, false);
  }
  const f = peopleFixture();
  const pending = f.page.loadMoreWorks(null);
  f.page.cancelPendingSelection();
  f.state.activeView = "search";
  f.state.works = [{ id: "search-result" }];
  f.calls[0].reject(new Error("obsolete failure"));
  await pending;
  assert.deepEqual(f.state.works.map((work) => work.id), ["search-result"]);
  assert.deepEqual(f.errors, [], "obsolete failures must not paint errors in a new view");
  assert.equal(f.state.personWorksLoadingMore, false);
}

async function verifySearchPaginationOwnership() {
  const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
  function fixture() {
    const transport = deferredApi({ ignoreAbort: true });
    let controller = null;
    const errors = [];
    const state = { activeView: "search", searchQuery: "A", works: [{ id: "A-first" }], searchPeople: [], workPageSize: 48, workVisibleLimit: 48 };
    const context = vm.createContext({
      state, window: { clearTimeout }, els: { workSearch: { value: "A" }, statsRow: {}, workGrid: {} },
      searchRequests: {
        fetchPage(query, offset) {
          controller?.abort(); controller = new AbortController();
          return transport.api(`/search?q=${query}&offset=${offset}`, { signal: controller.signal });
        },
        cancel() { controller?.abort(); }
      },
      peoplePage: { cancelPendingSelection() {} }, codePrefixPage: { cancelPendingRequests() {} },
      rankingPage: { cancelPendingRequests() {} }, studioPage: { cancelPendingRequests() {} }, collectionPage: { cancelPendingRequests() {} },
      beginNavigation() {}, syncNavigationState() {}, hidePersonProfile() {}, setMainHeader() {}, selectedWorkFilters: () => [],
      renderSearchStats() {}, renderWorks() {}, syncRouteAfterNavigation() {}, appendLoadedWorkPage() {},
      resetWorkPaging() { state.workVisibleLimit = 48; },
      renderEmpty(message) { errors.push(message); }, toastInline(_button, message) { errors.push(message); }
    });
    // The HTTP wrapper deliberately permits obsolete success/failure delivery;
    // page ownership must remain correct independently of transport cancellation.
    vm.runInContext(`let searchLoadMoreOwner = null;\n${section("function resetSearchPagination(", "function submitWorkSearch(")}\n${section("async function loadSearchResults(", "async function loadMorePersonWorks(")}`, context);
    return { ...transport, state, context, errors };
  }
  for (const fail of [false, true]) {
    const f = fixture();
    const oldButton = { textContent: "A 更多", disabled: false, isConnected: true };
    const oldPage = f.context.loadMoreSearchResults(oldButton);
    const newSearch = f.context.loadSearchResults("B");
    assert(f.calls[0].signal.aborted, "a new first-page query must cancel old pagination");
    f.calls[1].resolve({ works: [{ id: "B-first" }], total: 100 });
    await newSearch;
    const newButton = { textContent: "B 更多", disabled: false, isConnected: true };
    const newPage = f.context.loadMoreSearchResults(newButton);
    if (fail) f.calls[0].reject(new Error("obsolete pagination error"));
    else f.calls[0].resolve({ works: [{ id: "A-obsolete" }] });
    await oldPage;
    assert.equal(f.state.searchLoadingMore, true, "obsolete pagination finally must not release the newer page's loading state");
    assert.equal(newButton.disabled, true);
    assert.equal(newButton.textContent, "正在加载");
    assert.equal(oldButton.disabled, true, "obsolete completion must not modify its now-unowned old button");
    assert.deepEqual(f.errors, [], "obsolete pagination errors must not toast");
    assert.deepEqual(f.state.works.map((work) => work.id), ["B-first"]);
    f.calls[2].resolve({ works: [{ id: "B-second" }], total: 100 });
    await newPage;
    assert.equal(f.state.searchLoadingMore, false);
    assert.equal(newButton.disabled, false);
    assert.equal(newButton.textContent, "B 更多");
  }
  const leaving = fixture();
  const pending = leaving.context.loadMoreSearchResults(null);
  leaving.context.clearWorkSearch();
  leaving.state.activeView = "favorites";
  leaving.calls[0].reject(new Error("error after leaving"));
  await pending;
  assert.deepEqual(leaving.errors, []);
  assert.equal(leaving.state.searchLoadingMore, false);
}

function shellFixture() {
  const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const section = (from, to) => {
    const start = source.indexOf(from), end = source.indexOf(to, start);
    assert(start >= 0 && end > start, `shell fixture section is missing: ${from}`);
    return source.slice(start, end);
  };
  const transport = deferredApi({ ignoreAbort: true });
  const state = { peopleScope: "main", activeView: "people", library: null };
  const context = vm.createContext({
    state, api: transport.api, URLSearchParams, libraryRequests: createLatestRequestGate(), console,
    els: {}, normalizeUiConfig: (value) => value, WORK_PAGE_SIZE_BY_ACCESS: { local: 64, remote: 48 },
    preferredWorkPageSize: (value) => value, peoplePage: { personIndexPageSize: () => 64, cancelPendingSelection() {} },
    resetWorkPaging() {}, sortPeopleForList: (value) => value, codePrefixPage: { invalidateIndex() {} }, resetPersonPaging() {},
    PEOPLE_SCOPE_NAMES: new Set(["main", "western"])
  });
  vm.runInContext(`let navigationSequence = 0;\n${section("function beginNavigation(", "async function applyRoute(")}\n${section("async function loadLibrary(", "function normalizeSourcePath(")}\nfunction setActiveView(view, options = {}) { beginNavigation(options); state.activeView = view; }`, context);
  return { ...transport, state, context };
}

async function verifyLibraryAndNavigation() {
  const outOfOrder = shellFixture();
  const oldScope = outOfOrder.context.setPeopleScope("western");
  const latestScope = outOfOrder.context.setPeopleScope("main");
  outOfOrder.calls[1].resolve({ scope: "main", people: [{ id: "main-person" }] });
  assert.equal(await latestScope, true);
  outOfOrder.calls[0].resolve({ scope: "western", people: [{ id: "obsolete-person" }] });
  assert.equal(await oldScope, false);
  assert.equal(outOfOrder.state.peopleScope, "main", "a late old response must not overwrite the last selected scope");
  assert.deepEqual(outOfOrder.state.people.map((person) => person.id), ["main-person"]);

  const f = shellFixture();
  const western = f.context.setPeopleScope("western");
  const main = f.context.setPeopleScope("main");
  assert(f.calls[0].signal.aborted, "a scope switch must abort its superseded library request");
  f.calls[0].resolve({ scope: "western", people: [{ id: "wrong-person" }] });
  assert.equal(await western, false);
  const sharedMain = f.context.ensureLibraryLoaded({ deferMainRender: true });
  assert.equal(f.calls.length, 2, "an old finally must retain the newer scope's pending promise");
  f.calls[1].resolve({ scope: "main", people: [{ id: "main-person" }] });
  assert.equal(await main, true);
  await sharedMain;
  assert.equal(f.state.peopleScope, "main");
  assert.deepEqual(f.state.people.map((person) => person.id), ["main-person"]);

  const delayedNavigation = f.context.navigatePeopleScope("western");
  f.context.setActiveView("favorites");
  f.calls[2].resolve({ scope: "western", people: [{ id: "western-person" }] });
  assert.equal(await delayedNavigation, false);
  assert.equal(f.state.activeView, "favorites", "a completed scope request must not navigate over a newer user intent");
}

class FixtureElement {
  constructor() { this.innerHTML = ""; this.dataset = {}; this.events = {}; this.children = []; this.classList = { add() {} }; }
  append(...children) { this.children.push(...children); }
  addEventListener(type, listener) { this.events[type] = listener; }
  setAttribute() {}
  querySelector() { return null; }
  contains(target) { return Boolean(target); }
  closest() { return this; }
}

function catalogFixture(kind) {
  const transport = deferredApi({ ignoreAbort: true });
  const errors = [], routes = [];
  const state = {
    activeView: kind === "prefix" ? "codes" : "studios", codePrefixes: [], works: [], workVisibleLimit: 48,
    workPageSize: 48, sortMode: "releaseDesc", filterMode: "all", showMissingLocalWorks: false, showCompilationWorks: false,
    selectedStudioSeriesId: "all", studioWorksTotal: 0
  };
  let navigation = 0;
  const deps = {
    api: transport.api, state, els: { statsRow: new FixtureElement(), workGrid: new FixtureElement() }, formatNumber: String,
    appendEmpty(message) { errors.push(message); }, appendLoadedWorkPage() {}, appendWorkControls() {}, clearWorkSearch() {},
    clearWorkFilter() { state.filterMode = "all"; }, getWorkFilterMode: () => state.filterMode, hidePersonProfile() {},
    onNavigationStarted() { return ++navigation; }, isNavigationCurrent: (intent) => navigation === intent,
    renderWorks() {}, renderStatsForWorks() {}, resetWorkPaging() {}, setMainHeader() {}, syncNavigationState() {},
    syncRouteAfterNavigation(value) { routes.push(value.routeOverrides.view); }
  };
  const page = kind === "prefix" ? createCodePrefixPage(deps) : createStudioPage(deps);
  return { ...transport, state, errors, routes, page, deps, nextIntent() { navigation++; } };
}

async function verifyCatalogRequests() {
  const original = { document: globalThis.document, window: globalThis.window, Option: globalThis.Option, Element: globalThis.Element };
  Object.assign(globalThis, { document: { createElement: () => new FixtureElement(), createDocumentFragment: () => new FixtureElement() }, window: {}, Option: FixtureElement, Element: FixtureElement });
  const payload = (id) => ({ works: [{ id }], total: 100, codePrefix: { prefix: "ABC" }, studio: { id: "studio", name: "片商", series: [] } });
  try {
    for (const fail of [false, true]) {
      const f = catalogFixture("prefix");
      const pending = f.page.showIndex();
      f.errors.length = 0;
      f.page.cancelPendingRequests(); f.state.activeView = "favorites";
      assert(f.calls[0].signal.aborted);
      if (fail) f.calls[0].reject(new Error("obsolete index error"));
      else f.calls[0].resolve({ prefixes: [{ prefix: "ABC", localCount: 1 }] });
      await pending;
      assert.deepEqual(f.routes, [], "a late prefix index must not replace the favorites URL");
      assert.deepEqual(f.state.codePrefixes, [], "a stale index must not repopulate invalidated state");
      assert.deepEqual(f.errors, []);
    }
    const intent = catalogFixture("prefix");
    const pendingIndex = intent.page.showIndex();
    intent.nextIntent(); // A new scope navigation can still be awaiting its library, leaving the visible index unchanged.
    intent.calls[0].resolve({ prefixes: [] });
    await pendingIndex;
    assert.deepEqual(intent.routes, [], "navigation intent must guard even before the newer view becomes visible");

    for (const kind of ["prefix", "studio"]) for (const fail of [false, true]) {
      const f = catalogFixture(kind);
      const select = () => kind === "prefix" ? f.page.selectPrefix("ABC", { resetFilter: false }) : f.page.loadStudioDetail("studio");
      const obsolete = select(); f.state.filterMode = "favorite";
      const current = select();
      assert(f.calls[0].signal.aborted);
      if (fail) f.calls[0].reject(new Error("obsolete first-page error"));
      else f.calls[0].resolve(payload("obsolete-first"));
      await obsolete;
      assert.deepEqual(f.errors, [], `${kind} stale first-page errors must not paint over the current loading view`);
      assert.deepEqual(f.state.works, []);
      f.calls[1].resolve(payload("current-first")); await current;
      assert.deepEqual(f.state.works.map((work) => work.id), ["current-first"], `${kind} old finally must preserve the current first-page gate`);
    }

    for (const change of ["sortMode", "filterMode", "showCompilationWorks", "showMissingLocalWorks", "workPageSize", "selectedCodePrefixFamily"]) {
      const f = catalogFixture("prefix");
      const first = f.page.selectPrefix("ABC", { resetFilter: false });
      f.state[change] = change === "sortMode" ? "ratingDesc" : change === "filterMode" ? "favorite" : change === "workPageSize" ? 40 : true;
      f.calls[0].resolve(payload("obsolete"));
      await first;
      assert.deepEqual(f.state.works, [], `first-page snapshot must cover ${change}, independently of abort`);
      assert.deepEqual(f.routes, []);
    }
    for (const change of ["sortMode", "filterMode", "showCompilationWorks", "showMissingLocalWorks", "workPageSize"]) {
      const f = catalogFixture("studio");
      const first = f.page.loadStudioDetail("studio");
      f.state[change] = change === "sortMode" ? "ratingDesc" : change === "filterMode" ? "favorite" : change === "workPageSize" ? 24 : true;
      f.calls[0].resolve(payload("obsolete")); await first;
      assert.deepEqual(f.state.works, [], `studio first-page snapshot must cover ${change}, independently of abort`);
    }
    for (const kind of ["prefix", "studio"]) for (const fail of [false, true]) {
      const f = catalogFixture(kind);
      const select = () => kind === "prefix" ? f.page.selectPrefix("ABC", { resetFilter: false }) : f.page.loadStudioDetail("studio");
      const more = (button) => kind === "prefix" ? f.page.loadMore(button) : f.page.loadMoreStudioWorks(button);
      const first = select(); f.calls[0].resolve(payload("first")); await first;
      const oldButton = { textContent: "旧页", disabled: false, isConnected: true };
      const oldPage = more(oldButton);
      f.state.filterMode = "favorite,highRating"; f.state.sortMode = "ratingDesc";
      const fresh = select();
      assert(f.calls[1].signal.aborted, `${kind} first page must abort previous pagination`);
      assert.equal(new URL(f.calls[2].path, "http://fixture").searchParams.get("filter"), "favorite,highRating");
      f.calls[2].resolve(payload("fresh-first")); await fresh;
      const newButton = { textContent: "新页", disabled: false, isConnected: true };
      const next = more(newButton);
      if (fail) f.calls[1].reject(new Error("obsolete page error"));
      else f.calls[1].resolve(payload("obsolete"));
      await oldPage;
      assert.deepEqual(f.state.works.map((work) => work.id), ["fresh-first"]);
      assert.equal(f.state[kind === "prefix" ? "codePrefixLoadingMore" : "studioWorksLoadingMore"], true, `${kind} old finally must not release newer page loading`);
      assert.equal(oldButton.disabled, true); assert.equal(newButton.disabled, true); assert.equal(newButton.textContent, "正在加载");
      assert.deepEqual(f.errors, []);
      f.calls[3].resolve(payload("fresh-second")); await next;
      assert.deepEqual(f.state.works.map((work) => work.id), ["fresh-first", "fresh-second"]);
      assert.equal(newButton.disabled, false);
      const leaving = more(null); f.page.cancelPendingRequests(); f.state.activeView = "favorites";
      f.calls[4].reject(new Error("error after leaving")); await leaving;
      assert.deepEqual(f.errors, []);
    }

    // The actual shell filter handler must request a new server-filtered studio first page.
    const studio = catalogFixture("studio");
    const firstStudio = studio.page.loadStudioDetail("studio"); studio.calls[0].resolve(payload("unfiltered")); await firstStudio;
    studio.state.filterMode = "favorite,highRating";
    const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
    const context = vm.createContext({ state: studio.state, studioPage: studio.page, resetWorkPaging() {}, codePrefixPage: { reloadForActiveView: () => false }, renderWorks() { assert.fail("studio filters must query the complete dataset before paging"); } });
    vm.runInContext(source.slice(source.indexOf("function handleFilterModeChange("), source.indexOf("function renderStatsForWorks(")), context);
    context.handleFilterModeChange();
    const params = new URL(studio.calls[1].path, "http://fixture").searchParams;
    assert.equal(params.get("filter"), "favorite,highRating"); assert.equal(params.get("offset"), "0");
    assert.equal(params.get("includeCompilation"), "0"); assert.equal(params.get("includeMissingLocal"), "0");
    studio.calls[1].resolve({ ...payload("match-beyond-first-unfiltered-page"), total: 1 }); await flush();
    assert.equal(studio.state.studioWorksTotal, 1);

    const prefetched = catalogFixture("studio");
    const card = new FixtureElement(); card.dataset.studioId = "studio";
    prefetched.deps.els.workGrid.events.pointerover({ target: card, type: "pointerover" });
    prefetched.state.filterMode = "favorite";
    const submitted = prefetched.page.loadStudioDetail("studio");
    assert.equal(prefetched.calls.length, 2, "different studio filters must not consume a stale prefetch key");
    prefetched.calls[1].resolve({ ...payload("favorite"), total: 1 }); await submitted;
    prefetched.page.cancelPendingRequests(); prefetched.calls[0].resolve(payload("old-prefetch")); await flush();
    assert.deepEqual(prefetched.state.works.map((work) => work.id), ["favorite"]);
  } finally { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
}

await verifyPrefetchBudget();
await verifySearchRequests();
await verifySearchPaginationOwnership();
await verifyPersonPaging();
await verifyLibraryAndNavigation();
await verifyCatalogRequests();
console.log("FanHao request lifecycle fixtures passed (scope/navigation, person/prefix/studio paging, bounded/cancellable prefetch).");
