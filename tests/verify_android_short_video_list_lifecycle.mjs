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
  // This suite replaces the DOM renderer; its mounted boundary must also
  // represent the author view used by dispatch/receipt ownership checks.
  context.isAuthorIndexMounted = () => mounted;
  context.appendListVideos = (rows) => writes.push({ append: rows.map((row) => row.id) });
  context.refreshVideoCards = (row) => writes.push({ refresh: row.id });
  const recordLoadingMore = (...args) => writes.push({ loadingMore: args });
  context.setListLoadingMore = recordLoadingMore;
  context.syncVideoPaging = recordLoadingMore;
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

function requestedOffset(request) {
  const [baseUrl, route] = request.args;
  return new URL(route, baseUrl).searchParams.get("offset");
}

function captureNativeLaunches() {
  const launches = [];
  globalThis.window.Capacitor = { Plugins: { FanHaoPlayer: {
    async playShortFeed(payload) { launches.push(payload); return { opened: true, canceled: false }; }
  } } };
  return launches;
}

async function verifyLikedGridPagination() {
  const f = await fixture(), fresh = deferred();
  const previous = Array.from({ length: 35 }, (_, index) => `video-${index + 1}`);
  const current = ["new-first", ...previous];
  const limit = 12;
  const response = (rows, offset = 0) => page(rows.slice(offset, offset + limit), "liked", {
    offset, limit, total: rows.length, hasMore: offset + limit < rows.length
  });
  const visible = () => f.state.data.videos.map((row) => row.id);
  const opening = f.views.renderList({ source: "liked", sort: "published" });
  const initial = f.requests.at(-1);
  initial.resolve({ data: response(previous), fromCache: true, revalidation: fresh.promise });
  await opening;
  assert.deepEqual(visible(), previous.slice(0, limit), "the cached liked prefix remains visible during revalidation");
  const provisionalLaunches = captureNativeLaunches();
  assert.equal(await f.context.openShortVideoFromList(f.state.data.videos[0]), true);
  assert.equal(provisionalLaunches[0]?.hasMore, false, "cached rows can play while their continuation waits for authority");
  assert.equal(provisionalLaunches[0]?.nextOffset, 0);

  const firstAppend = f.context.loadList(null, { append: true });
  const repeatedAppend = f.context.loadList(null, { append: true });
  await settle();
  assert.equal(f.requests.length, 1, "a cached liked prefix cannot start an offset read before revalidation");
  fresh.resolve(response(current));
  await settle();
  assert.deepEqual(visible(), current.slice(0, limit), "the authoritative prefix replaces the stale prefix before append");
  assert.equal(f.requests.length, 2, "the staged append resumes when its prefix becomes authoritative");
  assert.equal(requestedOffset(f.requests.at(-1)), "12");
  f.requests.at(-1).resolve(response(current, 12));
  await Promise.all([firstAppend, repeatedAppend]);
  await settle();

  const finalAppend = f.context.loadList(null, { append: true });
  assert.equal(f.requests.length, 3);
  assert.equal(requestedOffset(f.requests.at(-1)), "24");
  f.requests.at(-1).resolve(response(current, 24));
  await finalAppend;
  assert.deepEqual(visible(), current, "all 36 rows remain reachable after a new first item shifts the cached prefix");
  assert.equal(f.state.data.hasMore, false);
  cases += 1;

  const overlapping = await fixture();
  const prefix = previous.slice(0, limit);
  await overlapping.load("liked", prefix);
  const duplicatePage = overlapping.context.loadList(null, { append: true });
  assert.equal(requestedOffset(overlapping.requests.at(-1)), "12");
  overlapping.requests.at(-1).resolve(page(prefix, "liked", { offset: 12, limit, total: 36 }));
  await duplicatePage;
  assert.deepEqual(overlapping.state.data.videos.map((row) => row.id), prefix, "an overlapping raw page adds no duplicate cards");
  assert.equal(overlapping.state.data.hasMore, true);

  const nativeLaunches = captureNativeLaunches();
  const opened = await overlapping.context.openShortVideoFromList(overlapping.state.data.videos.at(-1));
  assert.equal(opened, true);
  assert.equal(nativeLaunches[0]?.hasMore, true);
  assert.equal(nativeLaunches[0]?.nextOffset, 24, "native handoff uses the consumed raw offset rather than the visible card count");

  const offlineContinuation = overlapping.context.loadList(null, { append: true });
  const heldContinuation = overlapping.requests.at(-1);
  assert.equal(requestedOffset(heldContinuation), "24", "pagination advances by raw rows even when every row was already visible");
  assert.equal(heldContinuation.args[2].requireAuthoritative, true);
  assert.equal(overlapping.state.loadingMore, true);
  assert.deepEqual(overlapping.state.data.videos.map((row) => row.id), prefix);
  heldContinuation.reject(Object.assign(new Error("offline continuation"), {
    fallbackData: page(["offline-tail"], "liked", { offset: 24, offline: true, hasMore: false })
  }));
  await offlineContinuation;
  assert.deepEqual(overlapping.state.data.videos.map((row) => row.id), prefix, "offline fallback cannot replace or extend the accepted prefix");
  assert.equal(overlapping.state.data.hasMore, true, "offline false EOF cannot close an authoritative continuation");

  const afterOverlap = overlapping.context.loadList(null, { append: true });
  assert.equal(requestedOffset(overlapping.requests.at(-1)), "24", "failed authority leaves the requested raw offset retryable");
  const tail = previous.slice(limit, limit * 2);
  overlapping.requests.at(-1).resolve(page(tail, "liked", { offset: 24, limit, total: 36, hasMore: false }));
  await afterOverlap;
  assert.deepEqual(overlapping.state.data.videos.map((row) => row.id), [...prefix, ...tail]);
  assert.equal(overlapping.state.data.hasMore, false);
  cases += 1;
}

async function verifyOfflineLikedGridRetry() {
  const f = await fixture();
  const cached = page(["offline-first"], "liked", { offset: 0, hasMore: false, offline: true, cacheState: "offline" });
  const opening = f.views.renderList({ source: "liked", sort: "published" });
  f.requests.at(-1).resolve({ data: cached, nonAuthoritative: true, revalidation: null });
  await opening;
  assert.deepEqual(f.state.data.videos.map((row) => row.id), ["offline-first"]);
  const nativeLaunches = captureNativeLaunches();
  assert.equal(await f.context.openShortVideoFromList(f.state.data.videos[0]), true);
  assert.equal(nativeLaunches[0]?.hasMore, false, "an offline prefix cannot authorize native continuation");
  assert.equal(nativeLaunches[0]?.nextOffset, 0, "an offline prefix cannot supply a native offset");

  const failed = f.context.loadList(null, { append: true });
  assert.equal(f.requests.length, 2, "a marked offline false EOF still offers an authoritative first-page retry");
  const firstRetry = f.requests.at(-1);
  assert.equal(requestedOffset(firstRetry) ?? "0", "0");
  assert.equal(firstRetry.args[2].requireAuthoritative, true);
  firstRetry.reject(new Error("still offline"));
  await failed;
  assert.deepEqual(f.state.data.videos.map((row) => row.id), ["offline-first"], "failed retry preserves the visible offline rows");

  const retry = f.context.loadList(null, { append: true });
  assert.equal(f.requests.length, 3);
  const secondRetry = f.requests.at(-1);
  assert.equal(requestedOffset(secondRetry) ?? "0", "0");
  assert.equal(secondRetry.args[2].requireAuthoritative, true);
  secondRetry.resolve(page(["online-first"], "liked", { offset: 0, hasMore: false }));
  await retry;
  assert.deepEqual(f.state.data.videos.map((row) => row.id), ["online-first"], "a successful retry accepts the authoritative prefix");
  cases += 1;
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
    f.requests.at(-1).resolve({ data: page(["cached"]), fromCache: true, revalidation: fresh.promise });
    await pending;
    const staged = f.context.loadList(null, { append: true });
    assert.equal(f.requests.length, 1);
    f.leave();
    const before = f.snapshot();
    if (failure) fresh.reject(new Error("late revalidation failure"));
    else fresh.resolve(page(["fresh-after-leave"]));
    await staged;
    await settle();
    assert.deepEqual(f.snapshot(), before, "cache revalidation is owned by the deactivated list generation");
    assert.equal(f.requests.length, 1, "deactivated revalidation cannot dispatch its staged append");
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

  for (const timing of ["before", "during", "metrics"]) {
    const f = await fixture(), fresh = deferred();
    const initial = page(["A", "B"], "all", { offset: 0 });
    const opening = f.views.renderSearch({ source: "all", query: "query", searchTab: "videos" });
    f.requests.at(-1).resolve({ data: initial, fromCache: true, revalidation: fresh.promise });
    await opening;
    if (timing === "before") {
      fresh.resolve(page(["A", "B", "C"], "all", { offset: 0 }));
      await settle();
    }
    const prefix = timing === "before" ? ["A", "B", "C"] : timing === "during" ? ["changed-prefix"] : ["A", "B"];
    const offset = prefix.length;
    const append = f.context.loadList(null, { append: true });
    if (timing !== "before") {
      await settle();
      assert.equal(f.requests.length, 1, "search continuation waits for its authoritative prefix");
    }
    if (timing === "during") {
      fresh.resolve(page(prefix, "all", { offset: 0 }));
      await settle();
      assert.deepEqual(f.state.data.videos.map(row => row.id), prefix, "the staged search append accepts the changed prefix before deriving its offset");
    } else if (timing === "metrics") {
      fresh.resolve({ ...initial, videos: [{ ...initial.videos[0], stats: { likes: 99 } }, initial.videos[1]] });
      await settle();
      assert.equal(f.state.data.videos[0].stats.likes, 99, "compatible metrics still apply before continuation");
    }
    assert.equal(f.requests.length, 2);
    assert.equal(f.state.loadingMore, true);
    const request = f.requests.at(-1);
    assert.equal(requestedOffset(request), String(offset));
    request.resolve(page([prefix[0], "tail"], "all", { offset }));
    await append;
    assert.deepEqual(f.state.data.videos.map(row => row.id), [...prefix, "tail"]);
    const final = f.context.loadList(null, { append: true });
    const finalRequest = f.requests.at(-1);
    assert.equal(new URL(finalRequest.args[1], finalRequest.args[0]).searchParams.get("offset"), String(offset + 2));
    finalRequest.resolve(page([], "all", { offset: offset + 2, hasMore: false }));
    await final;
    assert.equal(f.state.data.hasMore, false);
    cases += 1;
  }

  await verifyLikedGridPagination();
  await verifyOfflineLikedGridRetry();

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
