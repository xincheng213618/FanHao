import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createNavigationFixtureDocument } from "./fixtures/android-gallery-navigation-harness.mjs";
import { captureAccountOwner, isAccountOwnerCurrent, setAccountOwner } from "../android-client/www/js/account-owner.js";
import { formatNumber } from "../android-client/www/js/format.js";
import { absoluteUrl, imageUrlForWork, portraitUrlForPerson } from "../android-client/www/js/image.js";
import { compactWorkCardTitle, workGridMeta, workGridPerson } from "../android-client/www/modules/fanhao/features/works/card-presentation.js";
import { createWorkPageDataService } from "../android-client/www/modules/fanhao/features/works/page-data-service.js";

// Complete current search page, real presentation and account revision helpers.
// Request completion, focus, DOM, history and clocks are controlled; aborted
// requests deliberately settle. No service, library or device is accessed.
let source = fs.readFileSync(new URL("../android-client/www/modules/fanhao/search-page.js", import.meta.url), "utf8");
if (process.argv.includes("--legacy-visible-suggestions")) {
  const marker = "      hideSuggestions();\n      if (!next || !page.isCurrent()) return;";
  assert.equal(source.replace(/\r\n/g, "\n").split(marker).length, 2);
  source = source.replace(/\r\n/g, "\n").replace(marker, "      if (!next || !page.isCurrent()) return;");
}
if (process.argv.includes("--legacy-result-ownership")) {
  const marker = "const ownsSuggestions = () => page.isCurrent() && version === suggestionVersion\n          && !controller.signal.aborted && cleanQuery(input.value) === next && head.contains(document.activeElement);";
  source = source.replace(/\r\n/g, "\n"); assert.equal(source.split(marker).length, 2);
  source = source.replace(marker, "const ownsSuggestions = () => input.isConnected;");
}
if (process.argv.includes("--legacy-button-ownership")) {
  const marker = "if (!ownsSuggestions() || suggestions.hidden || !button.isConnected) return;";
  assert.equal(source.split(marker).length, 2); source = source.replace(marker, "if (false) return;");
}
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {} } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); };
const result = tag => ({ people: [{ id: `person-${tag}`, name: `Synthetic ${tag}`, workCount: 3 }], works: [] });
const event = (type, values = {}) => ({ type, bubbles: false, preventDefault() { this.defaultPrevented = true; }, ...values });
let sequence = 0, cases = 0;
function fixture() {
  const document = createNavigationFixtureDocument(), prototype = Object.getPrototypeOf(document.body);
  document.activeElement = document.body;
  document.createElementNS = (_ns, tag) => document.createElement(tag);
  if (!Object.getOwnPropertyDescriptor(prototype, "isConnected")) Object.defineProperty(prototype, "isConnected", { get() { return this.ownerDocument.body.contains(this); } });
  if (!Object.getOwnPropertyDescriptor(prototype, "firstElementChild")) Object.defineProperty(prototype, "firstElementChild", { get() { return this.children[0] || null; } });
  prototype.focus = function() {
    if (!this.isConnected || document.activeElement === this) return;
    const previous = document.activeElement; document.activeElement = this;
    previous?.dispatchEvent(event("blur")); this.dispatchEvent(event("focus"));
  };
  prototype.blur = function() { if (document.activeElement === this) document.body.focus(); };
  const timers = new Map(), frames = [], reads = [], warms = [], navigation = [], preserved = [], storage = new Map(), listeners = new Map();
  let timerId = 0, base = `https://search-${++sequence}-a.fixture.invalid`;
  const A = base, B = `https://search-${sequence}-b.fixture.invalid`;
  setAccountOwner(A, "guest", { force: true }); setAccountOwner(B, "guest", { force: true });
  const window = { setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, requestAnimationFrame: callback => frames.push(callback),
    addEventListener(type, callback) { const values = listeners.get(type) || []; values.push(callback); listeners.set(type, values); },
    open: (...args) => navigation.push(["external", ...args]) };
  const emit = type => { for (const callback of listeners.get(type) || []) callback(); };
  const content = document.createElement("main"); document.body.append(content);
  const context = vm.createContext({ document, window, console, AbortController, captureAccountOwner, isAccountOwnerCurrent,
    formatNumber, absoluteUrl, imageUrlForWork, portraitUrlForPerson, compactWorkCardTitle, workGridMeta, workGridPerson,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } });
  const create = vm.runInContext(`(function(){${source.replace(/^import[^\n]*\n/gm, "").replace(/^export /gm, "")}\nreturn createFanhaoSearchPage;})()`, context);
  const page = create({ els: { viewContent: content }, getActiveUrl: () => base,
    getSearchParams: () => ({ category: "western" }),
    warmSearch: (query, options) => warms.push({ query, options }),
    fetchSuggestions(query, options) { const read = { query, options, ...deferred() }; reads.push(read); return read.promise; },
    preserveQuery: query => preserved.push(query), goBack: () => navigation.push(["back"]),
    showView: (...args) => { navigation.push(args); emit("fanhaoViewWillRender"); } });
  let input;
  const f = { A, B, document, content, reads, warms, navigation, preserved, storage, emit,
    render(query = "") { const view = page.render(query); input = view.input; while (frames.length) frames.shift()(); input.focus(); return view; },
    type(value) { input.value = value; input.dispatchEvent(event("input")); },
    async tick(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); } await flush(); },
    suggest: () => content.querySelector(".fanhao-search-suggestions"),
    buttons: () => content.querySelectorAll(".fanhao-search-suggestion"),
    blur() { document.body.focus(); }, switchSource() { base = B; },
    switchAccount() { setAccountOwner(base, "guest", { force: true }); },
    submit() { content.querySelector(".fanhao-search-page-form").dispatchEvent(event("submit")); },
    get input() { return input; }
  };
  f.render(); return f;
}
async function run(name, task) { const f = fixture(); await task(f); cases++; console.log(`PASS ${name}`); }
await run("current suggestions navigate with the visible query and scope", async f => {
  f.type("A"); await f.tick(220); assert.equal(f.reads[0].query, "A");
  f.reads[0].resolve(result("A")); await flush(); assert.equal(f.suggest().hidden, false);
  f.buttons()[0].click(); assert.deepEqual(f.preserved, ["A"]);
  assert.equal(f.navigation[0][0], "personDetail"); assert.equal(f.navigation[0][1].personId, "person-A");
  assert.equal(f.navigation[0][1].scope, "western");
});
await run("new input immediately removes the previous query's visible suggestions", async f => {
  f.type("A"); await f.tick(220); f.reads[0].resolve(result("A")); await flush();
  const oldButton = f.buttons()[0]; f.type("B");
  assert.equal(f.suggest().hidden, true); assert.equal(f.buttons().length, 0);
  oldButton.click(); assert.equal(f.navigation.length, 0); assert.equal(f.preserved.length, 0);
});
for (const failure of [false, true]) await run(`new query survives old ${failure ? "failure" : "success"} after an ignored abort`, async f => {
  f.type("A"); await f.tick(220); f.type("B"); await f.tick(220);
  assert.equal(f.reads[0].options.signal.aborted, true);
  f.reads[1].resolve(result("B")); await flush();
  if (failure) f.reads[0].reject(new Error("Old failure")); else f.reads[0].resolve(result("A"));
  await flush(); assert.equal(f.suggest().hidden, false); assert(f.suggest().textContent.includes("Synthetic B"));
  assert(!f.suggest().textContent.includes("Synthetic A"));
});
await run("old suggestion controls cannot navigate after leaving and reopening the same query", async f => {
  f.type("same"); await f.tick(220); f.reads[0].resolve(result("old")); await flush();
  const oldButton = f.buttons()[0]; f.emit("fanhaoViewWillRender"); f.render("same"); await f.tick(220);
  f.reads[1].resolve(result("fresh")); await flush(); oldButton.click();
  assert.equal(f.navigation.length, 0); assert.equal(f.preserved.length, 0);
  f.buttons()[0].click(); assert.equal(f.navigation[0][1].personId, "person-fresh");
});
for (const boundary of ["blur", "detach", "navigation", "pagehide", "source", "account", "reopen"]) await run(`${boundary} prevents late responses and old controls from reviving suggestions`, async f => {
  f.type("same"); await f.tick(220); const oldInput = f.input, oldForm = f.content.querySelector("form");
  if (boundary === "blur") { f.blur(); await f.tick(80); }
  if (boundary === "detach") f.content.replaceChildren();
  if (boundary === "navigation") f.emit("fanhaoViewWillRender");
  if (boundary === "pagehide") f.emit("pagehide");
  if (boundary === "source") f.switchSource();
  if (boundary === "account") f.switchAccount();
  if (boundary === "reopen") { f.render("same"); await f.tick(220); }
  f.reads[0].resolve(result("old")); await flush();
  assert.equal(f.buttons().length, 0);
  if (boundary !== "blur") { oldForm.dispatchEvent(event("submit")); assert.equal(f.navigation.length, 0); }
  if (boundary === "reopen") { f.reads[1].resolve(result("fresh")); await flush(); assert(f.suggest().textContent.includes("Synthetic fresh")); }
  if (["blur", "navigation", "pagehide", "reopen"].includes(boundary)) assert.equal(f.reads[0].options.signal.aborted, true);
  if (boundary !== "reopen") assert.equal(oldInput, f.input);
});
await run("a previous page's blur timer cannot cancel a fresh page's suggestions", async f => {
  f.type("A"); f.blur(); f.render("B"); await f.tick(80); await f.tick(220);
  assert.equal(f.reads.length, 1); assert.equal(f.reads[0].query, "B");
  f.reads[0].resolve(result("B")); await flush(); assert.equal(f.suggest().hidden, false);
});
await run("clearing input cancels suggestions and current failures remain retryable", async f => {
  f.type("A"); f.type(""); await f.tick(220);
  assert.equal(f.reads.length, 0);
  f.type("A"); await f.tick(220); f.reads[0].reject(new Error("Current failure")); await flush();
  assert.equal(f.suggest().hidden, true);
  f.input.dispatchEvent(event("focus")); await f.tick(220); f.reads[1].resolve(result("retry")); await flush();
  assert.equal(f.suggest().hidden, false);
});
await run("full preparation waits for settled suggestions and preserves a matching explicit submit", async f => {
  f.type("A"); await f.tick(220); await f.tick(550); assert.equal(f.warms.length, 0);
  f.reads[0].resolve(result("A")); await flush(); assert.equal(f.warms.length, 0);
  await f.tick(550); assert.deepEqual(f.warms.map(warm => warm.query), ["A"]);
  f.submit(); assert.equal(f.warms[0].options.signal.aborted, false);
  assert.equal(f.navigation.at(-1)[1].query, "A"); assert.equal(f.navigation.at(-1)[1].category, "western");
});
for (const boundary of ["input", "navigation", "account", "blur"]) await run(`superseding idle preparation on ${boundary} aborts the old request`, async f => {
  f.type("A"); await f.tick(220); f.reads[0].resolve(result("A")); await flush(); await f.tick(550);
  assert.equal(f.warms.length, 1);
  if (boundary === "input") f.type("B");
  if (boundary === "navigation") f.emit("fanhaoViewWillRender");
  if (boundary === "account") { f.switchAccount(); f.emit("fanhaoAccountOwnerChanged"); }
  if (boundary === "blur") { f.blur(); await f.tick(80); }
  assert.equal(f.warms[0].options.signal.aborted, true);
});
for (const cancelled of [true, false]) await run(`page-data service ${cancelled ? "retires canceled" : "reuses matching"} in-flight warming`, async f => {
  const reads = [], writes = [];
  const service = createWorkPageDataService({
    fetchJson(_base, _path, options) {
      const read = { ...deferred(), options };
      reads.push(read);
      return read.promise; // Deliberately finish even when the old signal aborts.
    },
    writeCachedJson: async (_base, _path, data) => { writes.push(data); }
  });
  const path = "/api/fanhao/search?q=synthetic&limit=48", controller = new AbortController();
  const warm = service.warm(f.A, [path], { signal: controller.signal });
  if (cancelled) controller.abort();
  const live = service.load(f.A, path, { reuseWarmed: true });
  assert.equal(reads.length, cancelled ? 2 : 1);
  if (cancelled) { reads[0].resolve(result("discarded")); await warm; assert.deepEqual(writes, []); }
  reads.at(-1).resolve(result("accepted"));
  assert.deepEqual((await live).data, result("accepted"));
  await warm;
  assert.deepEqual(writes, [result("accepted")]);
});
await run("completed warm data cannot cross a same-account revision", async f => {
  let requests = 0;
  const service = createWorkPageDataService({ fetchJson: async () => result(++requests), writeCachedJson: async () => {} });
  const path = "/api/fanhao/search?q=synthetic&limit=48";
  await service.warm(f.A, [path], { signal: new AbortController().signal });
  f.switchAccount();
  assert.deepEqual((await service.load(f.A, path, { reuseWarmed: true })).data, result(2));
});
console.log(`Android FanHao search suggestions: ${cases} cases PASS`);
if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage); else delete globalThis.localStorage;
