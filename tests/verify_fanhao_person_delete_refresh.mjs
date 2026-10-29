import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createPeoplePage } from "../public/modules/fanhao/people-page.js";

// Run the actual shell delete action and actual people reader against synthetic
// confirmed receipts. No deletion endpoint, database or filesystem is accessed.
const shell = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const start = shell.indexOf("async function deleteSelectedPersonLocalWorks(");
const end = shell.indexOf("\nfunction appendMetadataQuickFilters(", start);
assert(start >= 0 && end > start, "actual bulk-delete shell action must exist");
const actionSource = shell.slice(start, end);
function takeShellFunction(name) {
  const start = new RegExp(`^function ${name}\\(`, "m").exec(shell)?.index;
  assert(start != null, `actual shell helper must exist: ${name}`);
  return shell.slice(start, shell.indexOf("\n}", start) + 2);
}
const selectionUiSource = ["localPersonWorks", "personBulkDeleteSelectionState", "syncPersonBulkDeleteSelectButton", "syncPersonBulkDeleteSelectionUi"].map(takeShellFunction).join("\n");
const person = id => ({ id, name: `Synthetic ${id}`, sourcePaths: [] });
const rows = (prefix, count) => Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}`, missingLocal: false }));
const response = (id, works, total = works.length) => ({ person: person(id), works, total });

function fixture(source = actionSource) {
  const calls = [], selections = [], alerts = [], renders = [];
  const state = {
    activeView: "people", peopleScope: "main", selectedPersonId: "A", selectedPerson: person("A"),
    people: [person("A"), person("B")], works: rows("a", 48), personWorksRawLoaded: 48,
    personWorksTotal: 60, personWorksHasMore: true, personWorksLoadingMore: false,
    personBulkDeleteActive: true, personBulkDeleteSelectedIds: new Set(["a0"]),
    workPageSize: 48, workVisibleLimit: 48, sortMode: "releaseDesc", filterMode: "all"
  };
  const api = (path, options = {}) => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    calls.push({ path, options, resolve, reject, url: new URL(path, "http://synthetic.invalid") });
    // Late completion remains possible even if a foreground read is aborted.
    return promise;
  };
  let page;
  const context = vm.createContext({
    state, api, alert: message => alerts.push(message), window: { confirm: () => true },
    isPersonBulkDeleteActive: () => state.personBulkDeleteActive && state.activeView === "people" && Boolean(state.selectedPersonId),
    clearPersonBulkDeleteSelection: () => state.personBulkDeleteSelectedIds.clear(),
    renderPersonWorkStats() { renders.push("stats"); }, renderWorks() { renders.push("works"); },
    async selectPerson(id, options) { selections.push({ id, options }); await page.selectPerson(id, options); }
  });
  vm.runInContext(`let navigationSequence = 1;\nfunction advanceNavigation() { return ++navigationSequence; }\n${source}`, context);
  const element = () => ({ innerHTML: "", addEventListener() {} });
  page = createPeoplePage({
    state, api, els: { workGrid: element(), statsRow: element() },
    onNavigationStarted: () => context.advanceNavigation(),
    appendEmpty() {}, cancelScheduledWorkRendering() {}, clearWorkSearch() {}, clearWorkFilter() {},
    coverUrl: () => "", currentPageScrollTop: () => 0, displayPersonName: item => item.name,
    formatLibraryPaths: () => "", formatNumber: String, getWorkFilterMode: () => state.filterMode,
    hidePersonProfile() {}, preparePersonProfile() {}, renderPersonProfile() {}, renderPersonWorkStats() {},
    resetProgressiveCoverLoading() {}, resetWorkPaging() { state.workVisibleLimit = 48; },
    restorePageScrollTop() {}, setMainHeader() {}, syncNavigationState() {}, syncRouteAfterNavigation() {},
    workCoverUrl: () => "", renderWorks() { renders.push("person"); }, appendLoadedWorkPage() {},
    toastInline(_button, message) { alerts.push(message); }
  });
  return { state, page, calls, selections, alerts, renders, context, button: { isConnected: true, textContent: "删除已选 1", disabled: false } };
}
async function readPerson(f, id, works = rows(id.toLowerCase(), 2), total = 10) {
  const reading = f.page.selectPerson(id, { resetFilter: false });
  f.calls.at(-1).resolve(response(id, works, total));
  await reading;
}
const flush = () => new Promise(resolve => setImmediate(resolve));
let passed = 0;
async function test(label, run) { await run(); passed++; console.log(`ok ${passed} - ${label}`); }

async function verifyNewPerson(settlement, source = actionSource) {
  const f = fixture(source);
  const deleting = f.context.deleteSelectedPersonLocalWorks(f.button), write = f.calls[0];
  assert.equal(write.path, "/api/people/A/local-files/delete");
  assert.equal(write.options.method, "POST");
  assert.deepEqual(Array.from(write.options.body.workIds), ["a0"]);
  await readPerson(f, "B");
  f.state.personBulkDeleteActive = true;
  f.state.personBulkDeleteSelectedIds = new Set(["b0"]);
  const more = f.page.loadMoreWorks(null), currentRead = f.calls.at(-1);
  if (settlement === "failure") write.reject(new Error("old synthetic deletion failure"));
  else write.resolve({ deletedCount: 1, failed: settlement === "partial" ? [{ title: "A0", error: "synthetic failure" }] : [] });
  const priorCalls = f.calls.length;
  await flush();
  assert.equal(f.calls.length, priorCalls, "old receipt must not refresh the new person");
  await deleting;
  assert.equal(currentRead.options.signal.aborted, false, "old receipt must not cancel the newer append");
  assert.deepEqual([...f.state.personBulkDeleteSelectedIds], ["b0"]);
  assert.equal(f.state.personBulkDeleteActive, true);
  assert.equal(f.state.personWorksRawLoaded, 2);
  assert.equal(f.state.personWorksLoadingMore, true);
  assert.deepEqual(f.alerts, []);
  currentRead.resolve(response("B", [{ id: "b2" }], 10));
  await more;
  assert.equal(f.state.personWorksRawLoaded, 3);
  assert.deepEqual(f.state.works.map(work => work.id), ["b0", "b1", "b2"]);
}

async function verifyRefreshNavigation(source = actionSource) {
  const f = fixture(source);
  const deleting = f.context.deleteSelectedPersonLocalWorks(f.button);
  f.calls[0].resolve({ deletedCount: 0, failed: [{ title: "A0", error: "synthetic failure" }] });
  await flush();
  const oldRefresh = f.calls[1];
  await readPerson(f, "B");
  f.state.personBulkDeleteSelectedIds = new Set(["b0"]);
  oldRefresh.resolve(response("A", rows("old", 2)));
  await deleting;
  assert.deepEqual(f.alerts, [], "obsolete refresh must not show failure alerts");
  assert.equal(f.state.selectedPersonId, "B");
  assert.deepEqual([...f.state.personBulkDeleteSelectedIds], ["b0"]);
}

for (const settlement of ["success", "partial", "failure"]) {
  await test(`late ${settlement} receipt preserves B selection, cursor and in-flight append`, () => verifyNewPerson(settlement));
}
for (const settlement of ["success", "partial", "failure"]) {
  await test(`current ${settlement} receipt refreshes a fresh server first page`, async () => {
    const f = fixture();
    const deleting = f.context.deleteSelectedPersonLocalWorks(f.button);
    if (settlement === "failure") f.calls[0].reject(new Error("current synthetic failure"));
    else f.calls[0].resolve({ deletedCount: 1, failed: settlement === "partial" ? [{ title: "A0", error: "synthetic partial failure" }] : [] });
    await flush();
    assert.equal(f.calls.length, 2);
    const reading = f.calls[1];
    assert.equal(reading.url.pathname, "/api/people/A");
    assert.equal(reading.url.searchParams.get("offset"), "0");
    assert.equal(f.selections[0].options.reusePrefetch, false, "confirmed local changes must bypass prepared detail snapshots");
    assert.equal(f.state.personWorksRawLoaded, null, "the prior raw prefix is discarded before the fresh response");
    assert.equal(f.state.works.length, 0);
    reading.resolve(response("A", rows("new", 2), 3));
    await deleting;
    assert.equal(f.state.personWorksRawLoaded, 2);
    assert.equal(f.state.personWorksHasMore, true);
    assert.equal(f.state.personBulkDeleteSelectedIds.size, 0);
    assert.equal(f.state.personBulkDeleteActive, settlement !== "success");
    assert.equal(f.alerts.length, settlement === "success" ? 0 : 1);
    const more = f.page.loadMoreWorks(null);
    assert.equal(f.calls.at(-1).url.searchParams.get("offset"), "2");
    f.calls.at(-1).resolve(response("A", [{ id: "new2" }], 3));
    await more;
    assert.deepEqual(f.state.works.map(work => work.id), ["new0", "new1", "new2"]);
  });
}
await test("explicit same-person navigation is a newer owner", async () => {
  const f = fixture();
  const deleting = f.context.deleteSelectedPersonLocalWorks(f.button), write = f.calls[0];
  await readPerson(f, "A", rows("changed", 2));
  f.state.personBulkDeleteSelectedIds = new Set(["changed0"]);
  write.resolve({ deletedCount: 1, failed: [] });
  await deleting;
  assert.equal(f.calls.length, 2);
  assert.deepEqual([...f.state.personBulkDeleteSelectedIds], ["changed0"]);
  assert.deepEqual(f.state.works.map(work => work.id), ["changed0", "changed1"]);
});
await test("late receipt cannot redraw a newer search view", async () => {
  const f = fixture();
  const deleting = f.context.deleteSelectedPersonLocalWorks(f.button);
  f.context.advanceNavigation(); f.state.activeView = "search"; f.state.selectedPersonId = null;
  f.state.works = [{ id: "search-result" }];
  f.calls[0].resolve({ deletedCount: 1, failed: [] });
  await deleting;
  assert.deepEqual(f.renders, []);
  assert.equal(f.state.activeView, "search");
  assert.deepEqual(f.state.works.map(work => work.id), ["search-result"]);
});
await test("scope change isolates an otherwise identical person id", async () => {
  const f = fixture();
  const deleting = f.context.deleteSelectedPersonLocalWorks(f.button);
  f.state.peopleScope = "western";
  f.state.personBulkDeleteSelectedIds = new Set(["western-choice"]);
  f.calls[0].resolve({ deletedCount: 1, failed: [] });
  await deleting;
  assert.equal(f.calls.length, 1);
  assert.deepEqual([...f.state.personBulkDeleteSelectedIds], ["western-choice"]);
});
await test("navigation during the fresh refresh suppresses obsolete failure alerts", () => verifyRefreshNavigation());
await test("cancelled confirmation does not issue a synthetic write", async () => {
  const f = fixture();
  f.context.window.confirm = () => false;
  await f.context.deleteSelectedPersonLocalWorks(f.button);
  assert.equal(f.calls.length, 0);
  assert.equal(f.button.disabled, false);
  assert.deepEqual([...f.state.personBulkDeleteSelectedIds], ["a0"]);
});
async function verifyBusySelectionUi(syncSource = selectionUiSource) {
  const f = fixture(), summary = {}, all = {};
  const group = { querySelector: selector => selector.includes('"all"') ? all : selector.includes('"delete"') ? f.button : summary };
  Object.assign(f.context, { formatNumber: String, els: { statsRow: { querySelector: () => group }, workGrid: { querySelectorAll: () => [] } } });
  vm.runInContext(syncSource, f.context);
  let deleting, duplicate;
  try {
    deleting = f.context.deleteSelectedPersonLocalWorks(f.button);
    duplicate = f.context.deleteSelectedPersonLocalWorks(f.button);
    await flush();
    assert.equal(f.calls.length, 1, "an in-flight delete action must not issue a second synthetic write");
    assert.equal(f.button.personBulkDeletePending, true);
    f.state.personBulkDeleteSelectedIds.add("a1");
    f.context.syncPersonBulkDeleteSelectionUi();
    assert.equal(summary.textContent, "已选 2 / 48");
    assert.equal(f.button.disabled, true, "selection sync must keep an in-flight delete action disabled");
    assert.equal(f.button.textContent, "删除中 0/1", "selection sync must preserve the original in-flight deletion progress");
    assert.deepEqual([...f.calls[0].options.body.workIds], ["a0"], "later selection changes must not alter the already submitted deletion snapshot");
  } finally {
    // Resolve only the synthetic receipt after navigation; no real deletion
    // endpoint is reached, and the original ownership checks suppress refresh.
    f.state.activeView = "search"; f.context.advanceNavigation();
    for (const call of f.calls) call.resolve({ deletedCount: 1, failed: [] });
    await Promise.allSettled([deleting, duplicate].filter(Boolean));
    assert.equal(f.button.personBulkDeletePending, false, "the old action must release its pending marker even after navigation");
  }
}
await test("local selection sync preserves pending deletion progress and its submitted snapshot", () => verifyBusySelectionUi());
const withoutReceiptGuard = actionSource.replace("if (!isCurrent()) return;", "");
assert.notEqual(withoutReceiptGuard, actionSource, "negative control must remove the receipt ownership guard");
await assert.rejects(() => verifyNewPerson("success", withoutReceiptGuard), /old receipt must not refresh the new person/);
console.log("negative ok - removing receipt ownership refreshes and disrupts the newer person");
const withoutRefreshGuard = actionSource.replace("if (!isCurrent(refreshIntent)) return;", "");
assert.notEqual(withoutRefreshGuard, actionSource, "negative control must remove the refresh ownership guard");
await assert.rejects(() => verifyRefreshNavigation(withoutRefreshGuard), /obsolete refresh must not show failure alerts/);
console.log("negative ok - removing post-refresh ownership alerts over the newer person");
const withoutPendingUiGuard = selectionUiSource.replace("if (remove && !remove.personBulkDeletePending)", "if (remove)");
assert.notEqual(withoutPendingUiGuard, selectionUiSource, "negative must remove the actual pending UI guard");
await assert.rejects(() => verifyBusySelectionUi(withoutPendingUiGuard), { name: "AssertionError", message: /selection sync must keep an in-flight delete action disabled/ });
console.log("negative ok - removing pending UI guard re-enables the in-flight delete action");
console.log(`fanhao-person-delete-refresh: ok (${passed} synthetic action/reader scenarios + 3 independent negative controls)`);
