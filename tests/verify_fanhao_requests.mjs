import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createLatestRequestGate } from "../public/modules/fanhao/latest-request.js";
import { createPeoplePage } from "../public/modules/fanhao/people-page.js";
import { createPrefetchCache } from "../public/modules/fanhao/prefetch-cache.js";
import { createSearchRequestService } from "../public/modules/fanhao/search-request-service.js";
import { createCodePrefixPage } from "../public/modules/fanhao/code-prefix-page.js";
import { createStudioPage } from "../public/modules/fanhao/features/studios/studio-page.js";
import { workServerMoreState } from "../public/modules/fanhao/features/works/work-page-appender.js";
import { resolveWorkPage } from "../public/modules/fanhao/features/works/work-page-state.js";

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

function verifyWorkSearchComposition() {
  const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("let workSearchComposing = false;");
  const handlers = source.slice(start, source.indexOf("els.missingLocalToggle", start));
  assert(start >= 0, "execute the production work-search event handlers");

  function verify(code) {
    const handlersByType = new Map();
    const timers = new Map();
    const prefetched = [], submitted = [];
    let sequence = 0;
    const input = { value: "", addEventListener(type, listener) { handlersByType.set(type, listener); } };
    const navigator = { connection: { saveData: false } };
    const clearTimeout = (id) => timers.delete(id);
    const context = vm.createContext({
      els: { workSearch: input }, state: {}, navigator,
      window: { clearTimeout, setTimeout(callback) { const id = ++sequence; timers.set(id, callback); return id; } },
      searchRequests: { prefetch(query) { prefetched.push(query); } },
      submitWorkSearch(query) { submitted.push(query); }
    });
    vm.runInContext(code, context);
    const fire = (type, values = {}) => {
      const event = { currentTarget: input, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...values };
      handlersByType.get(type)?.(event);
      return event;
    };
    input.value = "z";
    fire("input");
    assert.equal(timers.size, 1, "ordinary input still schedules prefetch");
    fire("compositionstart");
    assert.equal(timers.size, 0, "starting composition cancels an already scheduled partial query");
    for (const isComposing of [true, false]) {
      input.value = "zhong";
      fire("input", { isComposing });
      assert.equal(timers.size, 0, "unconfirmed IME text must not reach prefetch");
      assert.equal(fire("keydown", { key: "Enter", isComposing }).defaultPrevented, false);
      assert.equal(fire("keydown", { key: "Escape", isComposing }).defaultPrevented, false);
      assert.equal(input.value, "zhong", "cancelling a candidate must preserve the search field");
      assert.deepEqual(submitted, [], "candidate keys must not submit a query");
    }
    input.value = "中文";
    fire("compositionend");
    fire("input", { isComposing: false });
    assert.equal(timers.size, 1, "compositionend and its following input share one debounce");
    for (const callback of [...timers.values()]) callback();
    timers.clear();
    assert.deepEqual(prefetched, ["中文"], "only the committed query is prefetched");
    for (const key of ["Enter", "Escape"]) {
      fire("keydown", { key, keyCode: 229 });
      fire("keydown", { key, isComposing: true });
    }
    assert.deepEqual(submitted, [], "browser composition ordering must not turn candidate keys into search commands");
    assert.equal(input.value, "中文");
    assert.equal(fire("keydown", { key: "Enter" }).defaultPrevented, true);
    assert.deepEqual(submitted, ["中文"], "a separate Enter still submits the committed query");
    assert.equal(fire("keydown", { key: "Escape" }).defaultPrevented, true);
    assert.equal(input.value, "");
    assert.deepEqual(submitted, ["中文", ""], "ordinary Escape still clears search");
    fire("input");
    assert.equal(timers.size, 0, "empty queries need no speculative request");
    input.value = "saved data";
    navigator.connection.saveData = true;
    fire("input");
    assert.equal(timers.size, 0, "data-saving mode still disables prefetch");
  }

  verify(handlers);
  assert.throws(() => verify(handlers.replace("if (workSearchComposing || event.isComposing || event.keyCode === 229) return;", "")),
    /Expected values to be strictly equal/, "removing composition keyboard protection must fail the behavior fixture");
  assert.throws(() => verify(handlers.replace(/workSearchComposing = true;\s*window\.clearTimeout\(state\.searchTimer\);/, "workSearchComposing = true;")),
    /starting composition cancels/, "leaving a pre-composition timer alive must fail the request budget");
}

function peopleFixture(onWorkRead) {
  const transport = deferredApi({ ignoreAbort: true });
  const renders = [], errors = [];
  const element = () => new FixtureElement();
  const els = { workGrid: element(), statsRow: element() };
  const state = {
    activeView: "people", peopleScope: "main", selectedPersonId: "person", selectedPerson: { id: "person", name: "人物" },
    people: [{ id: "person", name: "人物" }], works: [{ id: "first" }], personWorksTotal: 100,
    workPageSize: 48, workVisibleLimit: 48, personWorksLoadingMore: false, sortMode: "releaseDesc", filterMode: "all"
  };
  const page = createPeoplePage({
    api: transport.api, state, onWorkRead, els,
    appendEmpty() {}, cancelScheduledWorkRendering() {}, clearWorkSearch() {}, coverUrl: () => "",
    currentPageScrollTop: () => 0, displayPersonName: (person) => person.name, formatLibraryPaths: () => "", formatNumber: String,
    getWorkFilterMode: () => state.filterMode, clearWorkFilter() { state.filterMode = "all"; }, hidePersonProfile() {},
    renderPersonProfile() {}, renderPersonWorkStats() {}, resetProgressiveCoverLoading() {}, resetWorkPaging() {},
    restorePageScrollTop() {}, setMainHeader() {}, syncNavigationState() {}, syncRouteAfterNavigation() {}, workCoverUrl: () => "",
    renderWorks() { renders.push(state.works.map((work) => work.id)); },
    appendLoadedWorkPage() { renders.push(state.works.map((work) => work.id)); },
    toastInline(_button, message) { errors.push(message); }
  });
  return { ...transport, state, page, renders, errors, els };
}

async function verifyPersonPaging() {
  for (const change of ["sort", "filter"]) for (const fail of [false, true]) {
    const f = peopleFixture();
    const oldPage = f.page.loadMoreWorks(null);
    if (change === "sort") f.state.sortMode = "ratingDesc";
    else f.state.filterMode = "favorite";
    const firstPage = f.page.selectPerson("person", { resetFilter: false });
    assert(f.calls[0].signal.aborted, "a new person query must abort old pagination");
    f.calls[1].resolve({ person: { id: "person", name: "人物" }, works: [{ id: "fresh-first" }], total: 100 });
    await firstPage;
    const currentPage = f.page.loadMoreWorks(null);
    if (fail) f.calls[0].reject(new Error("obsolete person page error"));
    else f.calls[0].resolve({ works: [{ id: "obsolete-second" }], total: 100 });
    await oldPage;
    assert.deepEqual(f.state.works.map((work) => work.id), ["fresh-first"], "old pagination must not append to a new sort/filter");
    assert.equal(f.state.personWorksRawLoaded, 1, "obsolete completion must not advance the newer query's raw cursor");
    assert.deepEqual(f.errors, [], "obsolete person page failures must not toast in the current query");
    assert.equal(f.state.personWorksLoadingMore, true, "an old finally must not release a newer pagination request");
    f.calls[2].resolve({ works: [{ id: "fresh-second" }], total: 100 });
    await currentPage;
    assert.deepEqual(f.state.works.map((work) => work.id), ["fresh-first", "fresh-second"]);
    assert.equal(f.state.personWorksLoadingMore, false);
  }
  for (const change of ["sortMode", "filterMode", "showCompilationWorks", "showMissingLocalWorks", "workPageSize", "peopleScope"]) {
    const f = peopleFixture();
    const first = f.page.selectPerson("person", { resetFilter: false });
    f.state[change] = change === "sortMode" ? "ratingDesc" : change === "filterMode" ? "favorite" : change === "workPageSize" ? 40 : change === "peopleScope" ? "western" : true;
    f.calls[0].resolve({ person: { id: "person", name: "人物" }, works: [{ id: "obsolete" }], total: 100 });
    await first;
    assert.deepEqual(f.state.works, [], `person first-page snapshot must cover ${change}, independently of abort`);
    assert.equal(f.state.personWorksRawLoaded, null);
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
      navigationSequence: 0,
      beginNavigation(options = {}) { return options.navigationIntent !== undefined ? options.navigationIntent : ++context.navigationSequence; },
      syncNavigationState() {}, hidePersonProfile() {}, setMainHeader() {}, selectedWorkFilters: () => [],
      renderSearchStats() {}, renderWorks() {}, syncRouteAfterNavigation() {}, appendLoadedWorkPage() {}, resolveWorkPage,
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

  const paging = fixture();
  paging.state.searchTotal = 10;
  const overlapping = paging.context.loadMoreSearchResults(null);
  paging.calls[0].resolve({ works: [{ id: "A-first" }, { id: "B" }, { id: "C" }], total: 10 });
  await overlapping;
  const duplicatePage = paging.context.loadMoreSearchResults(null);
  assert.equal(new URL(paging.calls[1].path, "http://fixture").searchParams.get("offset"), "4", "search wire offset must count consumed rows independently of unique cards");
  paging.calls[1].resolve({ works: [{ id: "B" }, { id: "C" }], total: 10 }); await duplicatePage;
  assert.deepEqual(paging.state.works.map(work => work.id), ["A-first", "B", "C"]);
  const failed = paging.context.loadMoreSearchResults(null);
  assert.equal(new URL(paging.calls[2].path, "http://fixture").searchParams.get("offset"), "6");
  paging.calls[2].reject(new Error("Current synthetic failure")); await failed;
  const retry = paging.context.loadMoreSearchResults(null);
  assert.equal(new URL(paging.calls[3].path, "http://fixture").searchParams.get("offset"), "6", "a failed page must retain its cursor for retry");
  paging.calls[3].resolve({ works: [], total: 999 }); await retry;
  assert.equal(workServerMoreState(paging.state).hasSearchServerMore, false, "an empty search page must stop autoload despite a stale larger total");
  await paging.context.loadMoreSearchResults(null);
  assert.equal(paging.calls.length, 4, "exhausted search must not request another empty page");
  const fresh = paging.context.loadSearchResults("fresh");
  paging.calls[4].resolve({ works: [{ id: "X" }, { id: "X" }, { id: "Y" }], total: 5 }); await fresh;
  assert.deepEqual(paging.state.works.map(work => work.id), ["X", "Y"], "one response must not create duplicate cards");
  const freshNext = paging.context.loadMoreSearchResults(null);
  assert.equal(new URL(paging.calls[5].path, "http://fixture").searchParams.get("offset"), "3", "a new query must start a fresh raw cursor");
  paging.calls[5].resolve({ works: [{ id: "Z" }, { id: "Z" }], total: 5 }); await freshNext;
  assert.deepEqual(paging.state.works.map(work => work.id), ["X", "Y", "Z"]);
  assert.equal(workServerMoreState(paging.state).hasSearchServerMore, false);
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

function catalogFixture(kind, onWorkRead) {
  const transport = deferredApi({ ignoreAbort: true });
  const errors = [], routes = [];
  const state = {
    activeView: kind === "prefix" ? "codes" : "studios", codePrefixes: [], works: [], workVisibleLimit: 48,
    workPageSize: 48, sortMode: "releaseDesc", filterMode: "all", showMissingLocalWorks: false, showCompilationWorks: false,
    selectedStudioSeriesId: "all", studioWorksTotal: 0
  };
  let navigation = 0;
  const deps = {
    api: transport.api, state, onWorkRead, els: { statsRow: new FixtureElement(), workGrid: new FixtureElement() }, formatNumber: String,
    appendEmpty(message) { errors.push(message); }, appendLoadedWorkPage() {}, appendWorkControls() {}, clearWorkSearch() {},
    clearWorkFilter() { state.filterMode = "all"; }, getWorkFilterMode: () => state.filterMode, hidePersonProfile() {},
    onNavigationStarted() { return ++navigation; }, isNavigationCurrent: (intent) => navigation === intent,
    renderWorks() {}, renderStatsForWorks() {}, resetWorkPaging() {}, setMainHeader() {}, syncNavigationState() {},
    syncRouteAfterNavigation(value) { routes.push(value.routeOverrides.view); }
  };
  const page = kind === "prefix" ? createCodePrefixPage(deps) : createStudioPage(deps);
  return { ...transport, state, errors, routes, page, deps, nextIntent() { navigation++; } };
}

async function verifyDetailRawPagination() {
  for (const kind of ["person", "prefix", "studio"]) {
    const f = kind === "person" ? peopleFixture() : catalogFixture(kind);
    const domain = kind === "person" ? "personWorks" : kind === "prefix" ? "codePrefix" : "studioWorks";
    const rawKey = `${domain}RawLoaded`, moreKey = `${domain}HasMore`;
    const totalKey = kind === "prefix" ? "codePrefixTotal" : `${domain}Total`;
    const serverMoreKey = kind === "person" ? "hasPersonServerMore" : kind === "prefix" ? "hasCodePrefixServerMore" : "hasStudioServerMore";
    const select = () => kind === "person" ? f.page.selectPerson("person", { resetFilter: false })
      : kind === "prefix" ? f.page.selectPrefix("ABC", { resetFilter: false }) : f.page.loadStudioDetail("studio");
    const more = (button = null) => kind === "person" ? f.page.loadMoreWorks(button)
      : kind === "prefix" ? f.page.loadMore(button) : f.page.loadMoreStudioWorks(button);
    const payload = (works, total = 12) => ({ works, total, person: { id: "person", name: "人物" }, codePrefix: { prefix: "ABC" }, studio: { id: "studio", name: "片商", series: [] } });
    const offset = (call) => Number(new URL(call.path, "http://fixture").searchParams.get("offset"));
    f.state[rawKey] = 80; f.state[moreKey] = false;
    const first = select();
    assert.equal(f.state[rawKey], null, `${kind} new first page must reset the consumed cursor before delivery`);
    assert.equal(f.state[moreKey], null);
    assert.equal(offset(f.calls[0]), 0);
    f.calls[0].resolve(payload([{ id: "shared" }, { id: "shared" }, { id: 7 }, { id: "7" }, { id: null }])); await first;
    assert.deepEqual(f.state.works.map((work) => work.id), ["shared", 7], `${kind} first page must contain unique, usable IDs`);
    assert.equal(f.state[rawKey], 5); assert.equal(f.state[moreKey], true); assert.equal(f.state[totalKey], 12);

    const duplicatePage = more();
    assert.equal(offset(f.calls[1]), 5, `${kind} pagination must consume raw rows rather than unique cards`);
    f.calls[1].resolve(payload([{ id: "shared" }, { id: 7 }, { id: "7" }])); await duplicatePage;
    assert.deepEqual(f.state.works.map((work) => work.id), ["shared", 7]);
    assert.equal(f.state[rawKey], 8, `${kind} an all-duplicate page must still advance`);
    assert.equal(workServerMoreState(f.state)[serverMoreKey], true);

    const button = { textContent: "更多", disabled: false, isConnected: true };
    const failed = more(button);
    assert.equal(offset(f.calls[2]), 8);
    f.calls[2].reject(new Error("current page failed"));
    if (kind === "prefix") await assert.rejects(failed, /current page failed/); else await failed;
    assert.equal(f.state[rawKey], 8, `${kind} failures must preserve the retry offset`);
    assert.equal(f.state[moreKey], true); assert.equal(f.state[totalKey], 12); assert.equal(button.disabled, false);
    const retry = more();
    assert.equal(offset(f.calls[3]), 8, `${kind} retry must request the same raw slice`);
    f.calls[3].resolve(payload([{ id: "tail" }, { id: "tail" }])); await retry;
    assert.deepEqual(f.state.works.map((work) => work.id), ["shared", 7, "tail"], `${kind} appended pages must also deduplicate within the page`);
    assert.equal(f.state[rawKey], 10);

    const empty = more(); assert.equal(offset(f.calls[4]), 10);
    f.calls[4].resolve(payload([])); await empty;
    assert.equal(f.state[rawKey], 10); assert.equal(f.state[moreKey], false);
    assert.equal(workServerMoreState(f.state)[serverMoreKey], false, `${kind} an empty server page must retire the control despite a larger total`);
    await more(); assert.equal(f.calls.length, 5, `${kind} exhaustion must prevent repeated empty requests`);

    f.state.sortMode = "ratingDesc"; f.state.filterMode = "favorite";
    const reset = select();
    assert.equal(f.state[rawKey], null); assert.equal(f.state[moreKey], null);
    assert.equal(offset(f.calls[5]), 0);
    f.calls[5].resolve(payload([{ id: "reset" }, { id: "reset" }], 2)); await reset;
    assert.deepEqual(f.state.works.map((work) => work.id), ["reset"]);
    assert.equal(f.state[rawKey], 2); assert.equal(f.state[moreKey], false);
    assert.equal(workServerMoreState(f.state)[serverMoreKey], false, `${kind} a duplicate final page still consumes the reported total`);
    await more(); assert.equal(f.calls.length, 6);

    const replacement = kind === "person" ? f.page.selectPerson("other-person", { resetFilter: false })
      : kind === "prefix" ? f.page.selectPrefix("XYZ", { family: true, resetFilter: false }) : f.page.loadStudioDetail("other-studio", "2");
    assert.equal(f.state[rawKey], null); assert.equal(f.state[moreKey], null);
    const replacementUrl = new URL(f.calls[6].path, "http://fixture");
    assert.equal(offset(f.calls[6]), 0, `${kind} selecting a new person/prefix family/studio series must restart at zero`);
    if (kind === "prefix") assert.equal(replacementUrl.searchParams.get("family"), "1");
    if (kind === "studio") assert.equal(replacementUrl.searchParams.get("seriesId"), "2");
    f.calls[6].resolve({ ...payload([], 0), person: { id: "other-person", name: "其他人物" }, studio: { id: "other-studio", name: "其他片商", series: [] }, selectedSeriesId: "2" });
    await replacement;
    assert.deepEqual(f.state.works, []); assert.equal(f.state[rawKey], 0); assert.equal(f.state[totalKey], 0); assert.equal(f.state[moreKey], false);
    await more(); assert.equal(f.calls.length, 7, `${kind} an explicit empty first page must not offer continuation`);
  }
}

async function verifyForegroundWorkReadHooks() {
  function recorder() {
    const entries = [];
    return { entries, onWorkRead(path, isCurrent, refresh) {
      const entry = { path, isCurrent, refresh, retired: 0 }; entries.push(entry);
      return () => { entry.retired++; };
    } };
  }
  const personPayload = id => ({ person: { id: "person", name: "人物" }, works: [{ id }], total: 3 });
  const personHooks = recorder(), person = peopleFixture(personHooks.onWorkRead);
  try {
    const first = person.page.selectPerson("person", { resetFilter: false });
    assert.equal(personHooks.entries.length, 1, "a held person foreground read must register its actual owner before awaiting the transport");
    assert.equal(personHooks.entries[0].isCurrent(), true);
    assert.equal(new URL(personHooks.entries[0].path, "http://fixture").searchParams.get("offset"), "0");
    person.calls[0].resolve(personPayload("first")); await first;
    assert.equal(personHooks.entries[0].retired, 1, "publishing a person foreground result must retire its hook exactly once");
    const more = person.page.loadMoreWorks(null);
    assert.equal(personHooks.entries.length, 2); assert.equal(personHooks.entries[1].isCurrent(), true);
    assert.equal(new URL(personHooks.entries[1].path, "http://fixture").searchParams.get("offset"), "1");
    person.calls[1].reject(new Error("Synthetic hook page failure")); await more;
    assert.equal(personHooks.entries[1].retired, 1, "a failed foreground page must release its hook");
    const cancelled = person.page.selectPerson("person", { resetFilter: false });
    const oldOwner = personHooks.entries[2]; person.page.cancelPendingSelection();
    assert.equal(oldOwner.isCurrent(), false, "a cancelled foreground owner must immediately become ineligible for marker maintenance");
    person.calls[2].resolve(personPayload("cancelled")); await cancelled;
    assert.equal(oldOwner.retired, 1, "an abort-ignoring old foreground response must still release its hook");
  } finally { person.page.cancelPendingSelection(); for (const call of person.calls) call.resolve(personPayload("cleanup")); }

  const studioPayload = (id, series = "all", work = id) => ({ studio: { id, name: id, series: [] }, selectedSeriesId: series, works: [{ id: work }], total: 1 });
  for (const cached of [false, true]) {
    const hooks = recorder(), f = catalogFixture("studio", hooks.onWorkRead);
    try {
      const card = new FixtureElement(); card.dataset.studioId = "studio";
      f.deps.els.workGrid.events.pointerover({ target: card, type: "pointerover" });
      assert.equal(f.calls.length, 1); assert.equal(hooks.entries.length, 0, "speculative detail prefetch alone must not register a foreground owner");
      if (cached) { f.calls[0].resolve(studioPayload("studio")); await flush(); }
      const foreground = f.page.loadStudioDetail("studio");
      assert.equal(f.calls.length, 1, "foreground ownership must also cover a consumed speculative request without a duplicate GET");
      assert.equal(hooks.entries.length, 1, "consuming cached or held prefetched data must register the actual foreground reader");
      assert.equal(hooks.entries[0].isCurrent(), true);
      if (!cached) f.calls[0].resolve(studioPayload("studio"));
      await foreground; assert.equal(hooks.entries[0].retired, 1);
    } finally { f.page.cancelPendingRequests(); for (const call of f.calls) call.resolve(studioPayload("studio")); }
  }

  const targetHooks = recorder(), target = catalogFixture("studio", targetHooks.onWorkRead);
  try {
    target.state.selectedStudio = { id: "A", name: "Previous studio", series: [] };
    const previous = target.page.loadStudioDetail("B", "B-series");
    assert.equal(target.state.selectedStudio.id, "A", "the pending target is intentionally not yet the visible selected studio");
    const pendingOwner = targetHooks.entries[0];
    assert.equal(typeof pendingOwner.refresh, "function", "the pending studio reader must expose its own target refresh callback");
    const refreshed = pendingOwner.refresh();
    const replacement = new URL(target.calls[1].path, "http://fixture");
    assert.equal(replacement.pathname, "/api/studios/B", "marker maintenance must refresh the pending studio target instead of the previous selected studio");
    assert.equal(replacement.searchParams.get("seriesId"), "B-series");
    assert.equal(pendingOwner.isCurrent(), false); assert.equal(targetHooks.entries[1].isCurrent(), true);
    target.calls[0].resolve(studioPayload("B", "B-series", "obsolete-B")); await previous;
    assert.equal(targetHooks.entries[0].retired, 1);
    target.calls[1].resolve(studioPayload("B", "B-series", "current-B")); await refreshed;
    assert.equal(target.state.selectedStudio.id, "B"); assert.equal(target.state.selectedStudioSeriesId, "B-series");
    assert.deepEqual(target.state.works.map(work => work.id), ["current-B"]); assert.equal(targetHooks.entries[1].retired, 1);
  } finally { target.page.cancelPendingRequests(); for (const call of target.calls) call.resolve(studioPayload("B", "B-series")); }
  console.log("PASS actual foreground read hooks cover held/cache consumers, exclude speculation, preserve pending studio targets and retire on settlement");
}

async function verifyMarkerPrefetchInvalidation() {
  for (const kind of ["person", "studio", "search"]) for (const phase of ["settled-empty", "pending", "consumed"]) {
    const owners = [];
    const onWorkRead = (path, isCurrent) => {
      const owner = { path, isCurrent, retired: 0 }; owners.push(owner);
      return () => { owner.retired++; };
    };
    const f = kind === "person" ? peopleFixture(onWorkRead) : kind === "studio" ? catalogFixture("studio", onWorkRead) : (() => {
      const transport = deferredApi({ ignoreAbort: true });
      return { ...transport, page: createSearchRequestService({ api: transport.api, filter: () => "all", pageSize: () => 48, sort: () => "releaseDesc", onWorkRead }) };
    })();
    const data = marked => ({ works: marked ? [{ id: "marked", localMarkers: ["A"], relativePath: "[A] fixture-marked", videos: [{ id: "v", sourcePath: "[A] fixture-marked/video.mp4" }] }] : [], total: marked ? 1 : 0,
      person: { id: "person", name: "人物" }, studio: { id: "studio", name: "片商", series: [] } });
    const select = () => kind === "person" ? f.page.selectPerson("person", { resetFilter: false }) : kind === "studio" ? f.page.loadStudioDetail("studio") : f.page.fetchPage("[A]");
    const warm = () => {
      if (kind === "search") return f.page.prefetch("[A]");
      if (kind === "studio") {
        const card = new FixtureElement(); card.dataset.studioId = "studio";
        f.deps.els.workGrid.events.pointerover({ target: card, type: "pointerover" });
      } else {
        f.state.personVisibleLimit = 64; f.page.renderIndex();
        const card = f.els.workGrid.children.at(-1).children[0];
        assert(card, "person cache must be warmed through an actual rendered index card");
        f.els.workGrid.events.focusin({ target: card });
      }
    };
    try {
      const warming = warm();
      assert.equal(f.calls.length, 1, `${kind} real intent must start one speculative GET`);
      assert.equal(owners.length, 0, `${kind} speculative cache must not own a foreground read`);
      if (phase === "settled-empty") { f.calls[0].resolve(data(false)); await warming; await flush(); }
      if (phase === "consumed") {
        const foreground = select();
        assert.equal(f.calls.length, 1, `${kind} foreground must consume the held prefetch`);
        assert.equal(owners.length, 1); const owner = owners[0];
        f.page.invalidatePrefetches();
        assert.equal(f.calls[0].signal.aborted, false, `${kind} cache invalidation must keep the consumed foreground transport alive`);
        assert.equal(owner.isCurrent(), true, `${kind} cache invalidation must preserve its actual foreground owner`);
        assert.equal(owner.retired, 0);
        f.calls[0].resolve(data(true)); const result = await foreground;
        assert.equal(f.calls.length, 1, `${kind} cache invalidation must not replace a consumed foreground GET`);
        assert.equal(owner.retired, 1, `${kind} consumed foreground must retire its owner exactly once on completion`);
        const works = kind === "search" ? result.works : f.state.works;
        assert.equal(works[0].relativePath, "[A] fixture-marked");
        assert.equal(works[0].videos[0].sourcePath, "[A] fixture-marked/video.mp4");
      } else {
        f.page.invalidatePrefetches();
        if (phase === "pending") assert.equal(f.calls[0].signal.aborted, true, `${kind} unconsumed stale prefetch must receive cancellation`);
        assert.equal(f.calls.length, 1, `${kind} invalidation must remain cache-only without an automatic GET`);
        const foreground = select();
        assert.equal(f.calls.length, 2, `${kind} invalidated ${phase} prefetch must not be reused by a later activation`);
        f.calls[1].resolve(data(true)); const result = await foreground;
        f.calls[0].resolve(data(false)); await warming; await flush();
        const works = kind === "search" ? result.works : f.state.works;
        assert.deepEqual(works[0].localMarkers, ["A"], `${kind} the fresh category must contain the confirmed member`);
        assert.equal(works[0].relativePath, "[A] fixture-marked");
        assert.equal(owners.length, 1); assert.equal(owners[0].retired, 1);
      }
    } finally {
      if (kind === "person") f.page.cancelPendingSelection(); else if (kind === "studio") f.page.cancelPendingRequests(); else f.page.cancel();
      for (const call of f.calls) call.resolve(data(false));
      await flush();
    }
  }
  console.log("PASS marker cache-only invalidation covers actual person/studio/search settled-empty and pending caches while preserving consumed foreground owners");
}

async function verifyCatalogRequests() {
  const original = { document: globalThis.document, window: globalThis.window, Option: globalThis.Option, Element: globalThis.Element };
  Object.assign(globalThis, { document: { createElement: () => new FixtureElement(), createDocumentFragment: () => new FixtureElement() }, window: {}, Option: FixtureElement, Element: FixtureElement });
  const payload = (id) => ({ works: [{ id }], total: 100, codePrefix: { prefix: "ABC" }, studio: { id: "studio", name: "片商", series: [] } });
  try {
    await verifyForegroundWorkReadHooks();
    await verifyMarkerPrefetchInvalidation();
    await verifyDetailRawPagination();
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
      assert.equal(f.state[kind === "prefix" ? "codePrefixRawLoaded" : "studioWorksRawLoaded"], 1, `${kind} obsolete completion must preserve the newer raw cursor`);
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
verifyWorkSearchComposition();
await verifySearchPaginationOwnership();
await verifyPersonPaging();
await verifyLibraryAndNavigation();
await verifyCatalogRequests();
console.log("FanHao request lifecycle fixtures passed (scope/navigation, person/prefix/studio paging, bounded/cancellable prefetch).");
