import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const entryUrl = new URL("../android-client/www/modules/short-videos/index.js", import.meta.url);
const controllerUrl = new URL("../android-client/www/modules/short-videos/list/controller.js", import.meta.url);
const entrySource = (await readFile(entryUrl, "utf8")).replace(/\r\n/g, "\n");
const controllerSource = (await readFile(controllerUrl, "utf8")).replace(/\r\n/g, "\n");
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
let fixtureId = 0;
let cases = 0;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };
const clone = (value) => JSON.parse(JSON.stringify(value));
const video = (id) => ({ id, streamUrl: `/fixture/${id}.mp4` });
const page = (ids, source = "all", overrides = {}) => ({
  videos: ids.map(video), authors: [], source, total: 20, hasMore: true, ...overrides
});
const importSource = (source, url) => import(`data:text/javascript;base64,${Buffer.from(source.replace(
  /from "(\.\.?\/[^\"]+)"/g, (_match, relative) => `from ${JSON.stringify(new URL(relative, url).href)}`
)).toString("base64")}`);

async function fixture({ entry = entrySource, controller = controllerSource } = {}) {
  // Run the actual view factory and its exported deactivate/render methods.
  // The wrapper only captures its private context; API replies and DOM/layout
  // are controlled. No application service, credentials or user media is used.
  const key = `__fanhaoShortVideoListLifecycle${++fixtureId}`;
  const controllerModule = await importSource(controller, controllerUrl);
  const capture = globalThis[key] = { factory: controllerModule.createShortVideoListController, context: null };
  const importLine = /^import \{ createShortVideoListController \} from "[^\"]+";$/m;
  assert(importLine.test(entry), "current entry must compose the actual list controller");
  const instrumented = entry.replace(importLine, `const createShortVideoListController = context => {
    const capture = globalThis[${JSON.stringify(key)}];
    capture.context = context;
    context.api = capture.api;
    return capture.factory(context);
  };`);
  const module = await importSource(instrumented, entryUrl);
  const requests = [], writes = [];
  let baseUrl = "http://one.fixture:29998", mounted = false;
  globalThis.window = { addEventListener() {} };
  globalThis.document = { querySelector: () => null };
  const els = {
    viewContent: { querySelector: () => mounted ? {} : null, className: "" },
    viewKicker: {}, viewTitle: {}, viewMeta: {}
  };
  capture.api = {
    fetchCached(...args) { const request = { args, ...deferred() }; requests.push(request); return request.promise; },
    fetchCachedRevalidated(...args) { const request = { args, ...deferred() }; requests.push(request); return request.promise; }
  };
  const views = module.createShortVideoViews({ els, getActiveUrl: () => baseUrl, setActiveBottom() {}, showView() {} });
  delete globalThis[key];
  const context = capture.context;
  context.renderListShell = () => { writes.push("render"); mounted = true; };
  context.appendListVideos = (rows) => writes.push({ append: rows.map((row) => row.id) });
  context.refreshVideoCards = (row) => writes.push({ refresh: row.id });
  context.setListLoadingMore = (...args) => writes.push({ loadingMore: args });
  context.setListRefreshing = (...args) => writes.push({ refreshing: args });
  context.shortVideoToast = (message) => writes.push({ toast: message });
  const load = async (source = "all", ids = ["A", "B"], options = {}) => {
    const pending = views.renderList({ source, sort: "published", ...options });
    requests.at(-1).resolve({ data: page(ids, source), revalidation: null });
    await pending;
  };
  const leave = () => { views.deactivate(); mounted = false; };
  return { views, context, state: context.listState, requests, writes, load, leave,
    setBase(value) { baseUrl = value; }, snapshot: () => ({ data: clone(context.listState.data), writes: clone(writes) }) };
}

async function staleAppendCannotPublish(options = {}) {
  for (const source of ["all", "authors"]) {
    for (const failure of [false, true]) {
      const f = await fixture(options);
      await f.load(source);
      if (source === "authors") f.state.data.authors = [{ secUid: "old-author" }];
      const pending = f.context.loadList(null, { append: true });
      const request = f.requests.at(-1);
      f.leave();
      const before = f.snapshot();
      if (failure) request.reject(new Error("late append failure"));
      else request.resolve(page(["late"], source, { authors: [{ secUid: "late-author" }] }));
      await pending;
      assert.deepEqual(f.snapshot(), before, "a list append cannot publish data or UI after module deactivation");
      assert.equal(f.state.loading, false);
      assert.equal(f.state.loadingMore, false);
      cases += 1;
    }
  }
}

async function verify() {
  await staleAppendCannotPublish();
  for (const source of ["all", "authors"]) {
    const f = await fixture();
    await f.load(source);
    if (source === "authors") f.state.data.authors = [{ secUid: "old-author" }];
    const pending = f.context.loadList(null, { append: true });
    const before = f.writes.length;
    f.requests.at(-1).resolve(page(["active-tail"], source, { authors: [{ secUid: "new-author" }] }));
    await pending;
    assert(f.writes.length > before, "active pagination still updates its mounted list");
    if (source === "authors") assert.deepEqual(f.state.data.authors.map((row) => row.secUid), ["old-author", "new-author"]);
    else assert.deepEqual(f.state.data.videos.map((row) => row.id), ["A", "B", "active-tail"]);
    assert.equal(f.state.loadingMore, false);
    cases += 1;
  }

  for (const failure of [false, true]) {
    const f = await fixture();
    const pending = f.views.renderList({ source: "all", sort: "published" });
    const request = f.requests.at(-1);
    f.leave();
    const before = f.snapshot();
    if (failure) request.reject(new Error("late initial failure"));
    else request.resolve({ data: page(["late-initial"]), revalidation: null });
    await pending;
    assert.deepEqual(f.snapshot(), before, "initial completion cannot rebuild another module without a render guard");
    cases += 1;
  }

  for (const failure of [false, true]) {
    const f = await fixture(), fresh = deferred();
    const pending = f.views.renderList({ source: "all", sort: "published" });
    f.requests.at(-1).resolve({ data: page(["cached"]), revalidation: fresh.promise });
    await pending;
    f.leave();
    const before = f.snapshot();
    if (failure) fresh.reject(new Error("late revalidation failure"));
    else fresh.resolve(page(["fresh-after-leave"]));
    await settle();
    assert.deepEqual(f.snapshot(), before, "cache revalidation is owned by the deactivated list generation");
    cases += 1;
  }

  {
    const f = await fixture();
    await f.load("all", ["old"]);
    const old = f.context.loadList(null, { append: true }), oldRequest = f.requests.at(-1);
    f.leave();
    const reopened = f.views.renderList({ source: "all", sort: "published" });
    const newRequest = f.requests.at(-1);
    assert.equal(f.state.loading, true);
    oldRequest.resolve(page(["old-tail"]));
    await old;
    assert.deepEqual(f.state.data.videos.map((row) => row.id), ["old"]);
    assert.equal(f.state.loading, true, "old success cannot clear the reopened list's loading state");
    newRequest.resolve({ data: page(["reopened"]), revalidation: null });
    await reopened;
    const append = f.context.loadList(null, { append: true });
    f.requests.at(-1).resolve(page(["reopened-tail"]));
    await append;
    assert.deepEqual(f.state.data.videos.map((row) => row.id), ["reopened", "reopened-tail"]);
    assert.equal(f.state.loading, false); assert.equal(f.state.loadingMore, false);
    cases += 1;
  }

  {
    const f = await fixture(); await f.load();
    const old = f.context.loadList(null, { append: true }), oldRequest = f.requests.at(-1);
    f.leave(); await f.load("all", ["reopened"]);
    const current = f.context.loadList(null, { append: true }), currentRequest = f.requests.at(-1);
    const before = f.snapshot();
    oldRequest.reject(new Error("old append failure")); await old;
    assert.deepEqual(f.snapshot(), before, "old failure cannot clear or replace the new list's append state");
    assert.equal(f.state.loadingMore, true);
    currentRequest.resolve(page(["new-tail"])); await current;
    assert.deepEqual(f.state.data.videos.map((row) => row.id), ["reopened", "new-tail"]);
    assert.equal(f.state.loadingMore, false); cases += 1;
  }

  for (const failure of [false, true]) {
    const f = await fixture(); await f.load();
    const old = f.context.loadList(null, { append: true }), oldRequest = f.requests.at(-1);
    f.setBase("http://two.fixture:29998");
    const before = f.snapshot();
    if (failure) oldRequest.reject(new Error("old server failure"));
    else oldRequest.resolve(page(["old-server-tail"]));
    await old;
    assert.deepEqual(f.snapshot(), before, "old-server success and failure must remain silent");
    f.leave(); await f.load("all", ["new-server"]);
    assert.deepEqual(f.state.data.videos.map((row) => row.id), ["new-server"]);
    cases += 1;
  }

  {
    const f = await fixture();
    const pending = f.views.renderSearch({ source: "all", query: "query", searchTab: "all", sort: "published" });
    f.requests.at(-1).resolve({ data: page(["search-hit"]), revalidation: null });
    await pending;
    const related = f.requests.at(-1);
    assert(related.args[1].startsWith("/api/short-videos/authors?"));
    f.leave();
    const before = f.snapshot();
    related.resolve({ authors: [{ secUid: "late-related" }] }); await settle();
    assert.deepEqual(f.snapshot(), before, "late related-author hints cannot rebuild another module");
    assert.deepEqual(f.state.searchAuthors, []); cases += 1;
  }

  for (const staleFailure of [false, true]) {
    for (const refreshFailure of [false, true]) {
      const f = await fixture(); await f.load("all", ["preserved"]);
      const old = f.context.loadList(null, { append: true }), oldRequest = f.requests.at(-1);
      // The actual mounted shell stays in place while a same-module scope
      // change refreshes it, rather than leaving/reopening an empty container.
      const next = f.views.renderList({ source: "liked", sort: "published" });
      const refreshRequest = f.requests.at(-1);
      assert.equal(f.state.loading, true);
      assert(f.writes.some((value) => value.refreshing?.[0] === true), "scope change marks its preserved shell busy");
      const before = f.snapshot();
      if (staleFailure) oldRequest.reject(new Error("stale append"));
      else oldRequest.resolve(page(["stale-tail"]));
      await old;
      assert.deepEqual(f.snapshot(), before, "retired append cannot alter the preserved shell or its refresh");
      assert.equal(f.state.loading, true, "stale append cannot settle the current preserved-shell refresh");
      if (refreshFailure) refreshRequest.reject(new Error("current refresh"));
      else refreshRequest.resolve({ data: page(["fresh"], "liked"), revalidation: null });
      await next;
      assert.equal(f.state.loading, false);
      assert.equal(f.state.loadingMore, false);
      if (refreshFailure) {
        assert.deepEqual(f.state.data.videos.map((row) => row.id), ["preserved"]);
        assert(f.writes.some((value) => value.refreshing?.[0] === false), "current refresh failure clears preserved-shell busy state");
      } else assert.deepEqual(f.state.data.videos.map((row) => row.id), ["fresh"]);
      cases += 1;
    }
  }

  // Verify the real module and host still carry this lifecycle boundary.
  const moduleSource = await readFile(new URL("../android-client/www/modules/short-videos/android-module.js", import.meta.url), "utf8");
  const registry = await readFile(new URL("../android-client/www/js/android-module-registry.js", import.meta.url), "utf8");
  const app = await readFile(new URL("../android-client/www/app.js", import.meta.url), "utf8");
  assert.match(moduleSource, /deactivate: \(\) => shortVideoViews\.deactivate\?\.\(\)/);
  assert.match(registry, /if \(module\.id !== activeId\) module\.deactivate\?\.\(\)/);
  assert.match(app, /androidModuleRegistry\?\.deactivateExcept\(currentView, currentViewParams\)/);
}

try {
  await verify();
  const noGenerationCancel = controllerSource.replace("listRequestGeneration += 1;", "void 0;")
    .replace("listAppendRequestId += 1;", "void 0;");
  assert.notEqual(noGenerationCancel, controllerSource, "generation negative must change current code");
  await assert.rejects(staleAppendCannotPublish({ controller: noGenerationCancel }), /cannot publish data or UI/);
  const noEntryCancel = entrySource.replace("    context.cancelShortVideoListRequests();\n", "");
  assert.notEqual(noEntryCancel, entrySource, "entry negative must remove lifecycle wiring");
  await assert.rejects(staleAppendCannotPublish({ entry: noEntryCancel }), /cannot publish data or UI/);
  console.log(`Android short-video list lifecycle verified: ${cases} behavioral cases and 2 rejected regressions.`);
} finally {
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
}
