import assert from "node:assert/strict";
import fs from "node:fs";
import { createNavigationFixtureDocument } from "./fixtures/android-gallery-navigation-harness.mjs";

// Compose the complete current views factory, list view, search controller and
// list controller. DOM/focus, clock, storage and API completion are controlled;
// aborted reads deliberately complete. No service, device or user data is used.
const paths = {
  entry: "android-client/www/modules/short-videos/index.js",
  view: "android-client/www/modules/short-videos/list/view.js",
  search: "android-client/www/modules/short-videos/search.js",
  controller: "android-client/www/modules/short-videos/list/controller.js"
};
const urls = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, new URL(`../${path}`, import.meta.url)]));
const sources = Object.fromEntries(Object.entries(urls).map(([key, url]) => [key, fs.readFileSync(url, "utf8").replace(/\r\n/g, "\n")]));
const original = { document: globalThis.document, window: globalThis.window, localStorage: globalThis.localStorage,
  requestAnimationFrame: globalThis.requestAnimationFrame, fetch: globalThis.fetch };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let turn = 0; turn < 30; turn++) await Promise.resolve(); };
const event = (type, target, values = {}) => ({ type, target, bubbles: true, ...values,
  preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } });
const importSource = (source, url) => import(`data:text/javascript;base64,${Buffer.from(source.replace(
  /from "(\.\.?\/[^\"]+)"/g, (_match, relative) => `from ${JSON.stringify(new URL(relative, url).href)}`
)).toString("base64")}`);
let fixtureId = 0, cases = 0, selectedCase = "";

async function fixture(code = sources, { source = "all" } = {}) {
  const document = globalThis.document = createNavigationFixtureDocument();
  document.querySelector = selector => document.body.querySelector(selector);
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  const prototype = Object.getPrototypeOf(document.body);
  if (!Object.getOwnPropertyDescriptor(prototype, "isConnected")) Object.defineProperty(prototype, "isConnected", {
    get() { return this.ownerDocument.body.contains(this); }
  });
  prototype.focus = function() {
    if (!this.isConnected || this.ownerDocument.activeElement === this) return;
    const previous = this.ownerDocument.activeElement;
    this.ownerDocument.activeElement = this;
    previous?.dispatchEvent(event("blur", previous, { bubbles: false }));
    this.dispatchEvent(event("focus", this, { bubbles: false }));
  };
  prototype.blur = function() { if (this.ownerDocument.activeElement === this) this.ownerDocument.body.focus(); };
  const timers = new Map(), frames = [], requests = [], navigation = [], storage = new Map();
  let timerId = 0, baseUrl = "http://short-suggestions.fixture.invalid:29998";
  const window = globalThis.window = {
    addEventListener() {},
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; }
  };
  globalThis.requestAnimationFrame = window.requestAnimationFrame;
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
  globalThis.fetch = () => { throw new Error("Suggestions fixture never accesses a real service"); };
  const [view, search, controller] = await Promise.all([
    importSource(code.view, urls.view), importSource(code.search, urls.search), importSource(code.controller, urls.controller)
  ]);
  const key = `__fanhaoSuggestionFixture${++fixtureId}`;
  const capture = globalThis[key] = {
    context: null, view: view.createShortVideoListView, search: search.createShortVideoSearch,
    controller: controller.createShortVideoListController,
    api: {
      fetch(base, path, options) { const read = { base, path, options, ...deferred() }; requests.push(read); return read.promise; },
      fetchCached() { throw new Error("Unexpected catalogue read in blank search fixture"); },
      fetchCachedRevalidated() { throw new Error("Unexpected catalogue read in blank search fixture"); }
    }
  };
  let entry = code.entry;
  for (const [name, field] of [["createShortVideoListView", "view"], ["createShortVideoSearch", "search"], ["createShortVideoListController", "controller"]]) {
    const line = new RegExp(`^import \\{ ${name} \\} from "[^\\"]+";$`, "m");
    assert(line.test(entry), `actual entry composes ${name}`);
    const body = field === "controller"
      ? `const ${name} = context => { const capture = globalThis[${JSON.stringify(key)}]; capture.context = context; context.api = capture.api; return capture.controller(context); };`
      : `const ${name} = globalThis[${JSON.stringify(key)}].${field};`;
    entry = entry.replace(line, body);
  }
  const module = await importSource(entry, urls.entry);
  const content = document.createElement("main"); document.body.append(content);
  const views = module.createShortVideoViews({
    els: { viewContent: content, viewKicker: {}, viewTitle: {}, viewMeta: {} },
    getActiveUrl: () => baseUrl, setActiveBottom() {}, openSettings() {},
    goBack: () => navigation.push({ back: true }), showView: (...args) => navigation.push(args)
  });
  delete globalThis[key];
  await views.renderSearch({ source });
  while (frames.length) frames.shift()();
  const input = content.querySelector("input"), panel = content.querySelector(".short-video-search-suggestions");
  assert(input && panel, "actual search header mounts its input and suggestions");
  const run = async delay => {
    for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); void timer.callback(); }
    await flush();
  };
  const respond = async (index, values) => { requests[index].resolve({ suggestions: values }); await flush(); };
  const fail = async index => { requests[index].reject(new Error("Controlled suggestion failure")); await flush(); };
  return { views, context: capture.context, document, content, input, panel, requests, navigation, storage,
    run, respond, fail, setBase(value) { baseUrl = value; },
    type(value) { input.focus(); input.value = value; input.dispatchEvent(event("input", input)); },
    async reopen(nextSource = source) {
      await views.renderSearch({ source: nextSource });
      while (frames.length) frames.shift()();
      return { input: content.querySelector("input"), panel: content.querySelector(".short-video-search-suggestions") };
    },
    async leave() { views.deactivate(); content.innerHTML = ""; await flush(); },
    snapshot: () => ({ hidden: panel.hidden, text: panel.textContent, query: input.value, requests: requests.length, navigation: navigation.length }),
    async cleanup() { views.deactivate(); content.innerHTML = ""; for (const read of requests) read.resolve({ suggestions: [] }); await flush(); timers.clear(); }
  };
}
const suggestion = (query, kind = "video") => ({ query, label: `${query} result`, kind });
async function test(name, body, code = sources, options) {
  if (selectedCase && name !== selectedCase) return;
  const f = await fixture(code, options);
  try { await body(f); cases++; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
  finally { await f.cleanup(); }
}

async function verify(code = sources) {
  await test("late old failure preserves the newest suggestions", async f => {
    f.type("A"); await f.run(220);
    f.type("B"); await f.run(220);
    await f.respond(1, [suggestion("B")]);
    assert.equal(f.panel.hidden, false); assert.match(f.panel.textContent, /B result/);
    const before = f.snapshot(); await f.fail(0);
    assert.deepEqual(f.snapshot(), before, "late old failure must not hide the latest result panel");
  }, code);
  await test("late old success preserves the newest suggestions", async f => {
    f.type("A"); await f.run(220); f.type("B"); await f.run(220);
    await f.respond(1, [suggestion("B")]); const before = f.snapshot();
    await f.respond(0, [suggestion("A")]); assert.deepEqual(f.snapshot(), before);
  }, code);
  for (const failure of [false, true]) {
    await test(`same-query newer request owns ${failure ? "failure" : "success"}`, async f => {
      f.type("A"); await f.run(220); f.type("A"); await f.run(220);
      await f.respond(1, [{ query: "A", label: "newest A", kind: "video" }]);
      const before = f.snapshot();
      if (failure) await f.fail(0); else await f.respond(0, [{ query: "A", label: "obsolete A", kind: "video" }]);
      assert.deepEqual(f.snapshot(), before, "same text cannot grant an old request new ownership");
    }, code);
  }
  for (const failure of [false, true]) {
    await test(`controller suppresses retired ${failure ? "error" : "success"} and retains the current cancellation owner`, async f => {
      const first = f.context.fetchSearchSuggestions("A").then(value => ({ value }), error => ({ error }));
      const second = f.context.fetchSearchSuggestions("B").then(value => ({ value }), error => ({ error }));
      assert.equal(f.requests[0].options.signal.aborted, true);
      if (failure) await f.fail(0); else await f.respond(0, [suggestion("A")]);
      assert.deepEqual(await first, { value: null }, "retired controller results are null, including errors");
      assert.equal(f.requests[1].options.signal.aborted, false);
      f.context.cancelSearchSuggestions();
      assert.equal(f.requests[1].options.signal.aborted, true, "old completion must retain the new read's cancellation owner");
      await f.respond(1, [suggestion("B")]); assert.deepEqual(await second, { value: null });
    }, code);
  }
  await test("controller exposes the current failure without poisoning retries", async f => {
    const current = f.context.fetchSearchSuggestions("A").then(value => ({ value }), error => ({ error }));
    await f.fail(0); assert.match((await current).error?.message || "", /Controlled suggestion failure/);
    const retry = f.context.fetchSearchSuggestions("A"); await f.respond(1, [suggestion("A")]);
    assert.equal((await retry).suggestions[0].query, "A");
  }, code);
  await test("controller empty query retires the active read without HTTP", async f => {
    const pending = f.context.fetchSearchSuggestions("A");
    const empty = await f.context.fetchSearchSuggestions("   ");
    assert.deepEqual(empty, { query: "", suggestions: [] });
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0].options.signal.aborted, true);
    await f.respond(0, [suggestion("A")]); assert.equal(await pending, null);
  }, code);
  await test("new typing immediately retires the active HTTP read", async f => {
    f.type("A"); await f.run(220); assert.equal(f.requests[0].options.signal.aborted, false);
    f.type("B"); assert.equal(f.requests[0].options.signal.aborted, true, "typing retires the old read before the next debounce");
    await f.run(220); assert.equal(f.requests.length, 2); assert.equal(f.requests[1].options.signal.aborted, false);
    await f.respond(1, [suggestion("B")]); assert.match(f.panel.textContent, /B result/);
  }, code);
  await test("debounce sends only the latest typed query", async f => {
    f.type("A"); f.type("AB"); f.type("ABC"); await f.run(220);
    assert.equal(f.requests.length, 1);
    assert.equal(new URL(f.requests[0].path, f.requests[0].base).searchParams.get("q"), "ABC");
    await f.respond(0, [suggestion("ABC")]); assert.equal(f.panel.hidden, false);
  }, code);
  await test("blurred input cannot repaint a late result", async f => {
    f.type("A"); await f.run(220); f.input.blur(); await f.run(80);
    assert.equal(f.panel.hidden, true); await f.respond(0, [suggestion("A")]);
    assert.equal(f.panel.hidden, true, "late response must not reopen a blurred suggestion panel");
  }, code);
  await test("blur suppresses an immediate response before the delayed hide", async f => {
    f.type("A"); await f.run(220); f.input.blur();
    await f.respond(0, [suggestion("A")]);
    assert.equal(f.panel.hidden, true, "response between blur and its delayed cleanup must remain hidden");
  }, code);
  await test("blur before debounce never starts HTTP", async f => {
    f.type("A"); f.input.blur(); await f.run(220);
    assert.equal(f.requests.length, 0, "blurred input does not start obsolete autocomplete work");
  }, code);
  await test("leaving before debounce never starts HTTP", async f => {
    f.type("A"); await f.leave(); await f.run(220);
    assert.equal(f.requests.length, 0, "unmounted debounce must not access the API");
  }, code);
  for (const failure of [false, true]) {
    await test(`deactivation cancels and fences late ${failure ? "failure" : "success"}`, async f => {
      f.type("A"); await f.run(220); await f.leave();
      assert.equal(f.requests[0].options.signal.aborted, true, "actual module deactivation cancels autocomplete HTTP");
      const before = f.snapshot();
      if (failure) await f.fail(0); else await f.respond(0, [suggestion("A")]);
      assert.deepEqual(f.snapshot(), before, "retired read cannot update detached UI");
    }, code);
  }
  await test("connected old header never rebinds its pending debounce to a new server", async f => {
    f.type("A"); f.setBase("http://new-header.fixture.invalid:29998"); await f.run(220);
    assert.equal(f.requests.length, 0, "old header must not send its query to a newly selected server");
    const next = await f.reopen(); next.input.value = "fresh"; next.input.dispatchEvent(event("input", next.input));
    await f.run(220); assert.equal(f.requests[0].base, "http://new-header.fixture.invalid:29998");
    await f.respond(0, [suggestion("fresh")]); assert.equal(next.panel.hidden, false);
  }, code);
  await test("old connected controls are inert after a server switch", async f => {
    f.type("A"); await f.run(220); await f.respond(0, [suggestion("A")]);
    const old = f.panel.querySelector("button"), form = f.content.querySelector("form");
    f.setBase("http://new-controls.fixture.invalid:29998"); const before = f.snapshot();
    old.click(); form.dispatchEvent(event("submit", form));
    f.content.querySelector(".short-video-search-page-back").click();
    f.content.querySelector(".short-video-search-page-clear").click();
    await f.run(220); assert.deepEqual(f.snapshot(), before, "old controls cannot send or navigate on another server");
  }, code);
  for (const failure of [false, true]) {
    await test(`server switch fences late ${failure ? "failure" : "success"}`, async f => {
      f.type("A"); await f.run(220);
      const startedBase = f.requests[0].base; f.setBase("http://new-suggestions.fixture.invalid:29998");
      const before = f.snapshot();
      if (failure) await f.fail(0); else await f.respond(0, [suggestion("A")]);
      assert.equal(f.requests[0].base, startedBase); assert.deepEqual(f.snapshot(), before, "old server cannot publish autocomplete into current UI");
    }, code);
  }
  await test("current failure remains retryable", async f => {
    f.type("A"); await f.run(220); await f.fail(0); assert.equal(f.panel.hidden, true);
    f.type("A"); await f.run(220); await f.respond(1, [suggestion("A")]);
    assert.equal(f.panel.hidden, false); assert.match(f.panel.textContent, /A result/);
  }, code);
  await test("clear retires both pending read and query UI", async f => {
    f.type("A"); await f.run(220); f.content.querySelector(".short-video-search-page-clear").click();
    assert.equal(f.input.value, ""); assert.equal(f.panel.hidden, true);
    assert.equal(f.requests[0].options.signal.aborted, true);
    await f.respond(0, [suggestion("A")]); await f.run(220);
    assert.equal(f.panel.hidden, true); assert.equal(f.requests.length, 1);
  }, code);
  await test("empty input invalidates previous suggestions", async f => {
    f.type("A"); await f.run(220); await f.respond(0, [suggestion("A")]);
    f.type("   "); await f.run(220);
    assert.equal(f.panel.hidden, true); assert.equal(f.requests.length, 1);
  }, code);
  await test("submitting search cancels pending debounce and remembers query", async f => {
    f.type("  chosen  ");
    f.content.querySelector("form").dispatchEvent(event("submit", f.content.querySelector("form")));
    await f.run(220); assert.equal(f.requests.length, 0, "submitted query must not also run stale autocomplete");
    assert.equal(f.navigation.length, 1); assert.equal(f.navigation[0][0], "shortVideoSearch");
    assert.equal(f.navigation[0][1].query, "chosen"); assert.deepEqual(f.context.readSearchHistory(), ["chosen"]);
  }, code);
  await test("selecting a current suggestion keeps its author route", async f => {
    f.type("name"); await f.run(220); await f.respond(0, [suggestion("person", "author")]);
    f.panel.querySelector("button").click();
    assert.equal(f.navigation.length, 1); assert.equal(f.navigation[0][1].query, "person");
    assert.equal(f.navigation[0][1].searchTab, "authors"); assert.equal(f.navigation[0][1].source, "authors");
    assert.equal(f.panel.hidden, true);
  }, code);
  await test("author-scoped input filters unrelated suggestion kinds", async f => {
    f.type("name"); await f.run(220);
    await f.respond(0, [suggestion("clip", "video"), suggestion("person", "author"), suggestion("tag", "tag")]);
    assert.equal(f.panel.querySelectorAll("button").length, 1);
    assert.match(f.panel.textContent, /person result/); assert.doesNotMatch(f.panel.textContent, /clip result|tag result/);
    f.panel.querySelector("button").click();
    assert.equal(f.navigation[0][1].source, "following"); assert.equal(f.navigation[0][1].searchTab, "authors");
  }, code, { source: "following" });
  for (const retiredBy of ["new query", "replacement", "leave"]) {
    await test(`old suggestion button is inert after ${retiredBy}`, async f => {
      f.type("A"); await f.run(220); await f.respond(0, [suggestion("A")]);
      const old = f.panel.querySelector("button");
      if (retiredBy === "leave") await f.leave();
      else {
        f.type("B");
        if (retiredBy === "replacement") { await f.run(220); await f.respond(1, [suggestion("B")]); }
      }
      const before = f.snapshot(); old.click(); await flush();
      assert.deepEqual(f.snapshot(), before, "retired suggestion controls must not submit an obsolete query");
    }, code);
  }
  await test("detached search form is inert", async f => {
    f.type("A"); const form = f.content.querySelector("form"); await f.leave();
    const before = f.snapshot(); form.dispatchEvent(event("submit", form));
    await f.run(220); assert.deepEqual(f.snapshot(), before, "retired form cannot submit after leaving its route");
  }, code);
  await test("old blur timer cannot cancel a replacement search", async f => {
    f.type("old"); await f.run(220); f.input.blur();
    const next = await f.reopen(); next.input.value = "new"; next.input.dispatchEvent(event("input", next.input));
    await f.run(220); assert.equal(f.requests.length, 2); assert.equal(f.requests[1].options.signal.aborted, false);
    await f.run(80); assert.equal(f.requests[1].options.signal.aborted, false, "retired blur callback cannot abort the new view's read");
    await f.respond(1, [suggestion("new")]);
    assert.equal(next.panel.hidden, false); assert.match(next.panel.textContent, /new result/);
  }, code);
  await test("history stays bounded and deduplicated", async f => {
    f.context.rememberSearch(" Alpha "); f.context.rememberSearch("ALPHA");
    assert.deepEqual(f.context.readSearchHistory(), ["ALPHA"]);
    for (let index = 0; index < 12; index++) f.context.rememberSearch(`query-${index}`);
    assert.equal(f.context.readSearchHistory().length, 8); assert.equal(f.context.readSearchHistory()[0], "query-11");
    f.context.clearSearchHistory(); assert.deepEqual(f.context.readSearchHistory(), []);
  }, code);
  await test("query normalization retains the bounded Unicode contract", async f => {
    const pending = f.context.fetchSearchSuggestions("😀".repeat(130));
    const query = new URL(f.requests[0].path, f.requests[0].base).searchParams.get("q");
    assert.equal(Array.from(query).length, 120);
    await f.respond(0, []); assert.deepEqual((await pending).suggestions, []);
  }, code);
}

try {
  await verify();
  console.log(`Android short-video suggestions: ${cases} actual view/search/controller behavior cases passed.`);
  const paintedFocus = "if (!result || generation !== suggestionGeneration || input.value.trim() !== query || !ownsHeader()\n            || !wrap.contains(document.activeElement)) return;";
  const oldChoiceGuard = "if (!ownsHeader() || !button.isConnected || suggestions.hidden || generation !== suggestionGeneration) return;";
  const mutations = [
    ["HTTP cancellation", "search", sources.search.replace("suggestionController?.abort();", "/* HTTP cancellation omitted */"),
      "new typing immediately retires the active HTTP read", /typing retires the old read before the next debounce/],
    ["module cancellation", "entry", sources.entry.replace("    context.cancelSearchSuggestions();", "    /* module cancellation omitted */"),
      "deactivation cancels and fences late success", /actual module deactivation cancels autocomplete HTTP/],
    ["retired provider error", "search", sources.search.replace("      if (!isCurrent()) return null;", "      /* retired error leaks to the caller */"),
      "controller suppresses retired error and retains the current cancellation owner", /retired controller results are null, including errors/],
    ["retired provider success", "search", sources.search.replace("return isCurrent() ? result : null;", "return result;"),
      "controller suppresses retired success and retains the current cancellation owner", /retired controller results are null, including errors/],
    ["paint focus", "view", sources.view.replace(paintedFocus, "if (!result || generation !== suggestionGeneration || input.value.trim() !== query || !ownsHeader()) return;"),
      "blur suppresses an immediate response before the delayed hide", /response between blur and its delayed cleanup must remain hidden/],
    ["retired suggestion control", "view", sources.view.replace(oldChoiceGuard, "/* retired suggestion control accepted */"),
      "old suggestion button is inert after new query", /retired suggestion controls must not submit an obsolete query/],
    ["captured header server", "view", sources.view.replace("wrap.isConnected && headerBaseUrl === getActiveUrl()", "wrap.isConnected"),
      "connected old header never rebinds its pending debounce to a new server", /old header must not send its query to a newly selected server/],
    ["blur cancellation owner", "view", sources.view.replace("if (!wrap.contains(document.activeElement)) {\n        suggestionGeneration += 1;", "if (!wrap.contains(document.activeElement)) {\n        cancelSearchSuggestions();\n        suggestionGeneration += 1;"),
      "old blur timer cannot cancel a replacement search", /retired blur callback cannot abort the new view's read/],
    ["provider cleanup owner", "search", sources.search.replace("if (suggestionController === controller) suggestionController = null;", "suggestionController = null;"),
      "controller suppresses retired success and retains the current cancellation owner", /old completion must retain the new read's cancellation owner/]
  ];
  for (const [name, field, source, scenario, expected] of mutations) {
    assert.notEqual(source, sources[field], `${name}: negative control must alter current production source`);
    selectedCase = scenario;
    await assert.rejects(() => verify({ ...sources, [field]: source }), expected, `${name}: behavioral regression survived`);
  }
  console.log(`Android short-video suggestions: ${mutations.length} behavioral negative controls rejected.`);
} finally {
  globalThis.document = original.document; globalThis.window = original.window; globalThis.localStorage = original.localStorage;
  globalThis.requestAnimationFrame = original.requestAnimationFrame; globalThis.fetch = original.fetch;
}
