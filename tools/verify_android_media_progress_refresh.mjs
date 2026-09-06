import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { appFunction, createNavigationFixtureDocument } from "./fixtures/android-gallery-navigation-harness.mjs";
import { createSyntheticAnimeLibrary } from "./fixtures/android-anime-service.mjs";
import { captureMediaTrail, mediaBackTarget } from "../android-client/www/js/media-navigation-state.js";
import { formatBytes, formatDate, formatNumber, formatTime } from "../android-client/www/js/format.js";
import { absoluteUrl } from "../android-client/www/js/image.js";

// Execute the complete production channel factory and media adapter, real shell
// render-generation methods and actual list/detail/progress/playInfo services.
// DOM/events, HTTP delivery order, native bridge, cache and clocks are explicit
// doubles. The shared synthetic service supplies index/stat/probe/persistence
// boundaries: no browser, service, device, real media or database is accessed.
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const sha = value => createHash("sha256").update(value).digest("hex");
const source = read("android-client/www/platform/content-index/channel-views.js");
const mediaSource = read("android-client/www/modules/media/android-module.js"), appSource = read("android-client/www/app.js");
const legacy = JSON.parse(read("tools/fixtures/android-media-progress-refresh-before-fix.json"));
assert.equal(sha(JSON.stringify(legacy.sources)), "1c0b0c8bf9e8b5720dcdde4c39aba5f5c9822122e1345311d7378a9bb87aad83", "Complete frozen87 source bundle");
assert.equal(legacy.sources.channel.sha256, "202388bf8cf24c4ea745a83361d68e9d3460dd8744db8b959a258e1eaa2389c8");
assert.equal(legacy.sources.media.sha256, "dabc0acc0e6bcbea5e8b70afe843efa6031412748288d3cbc5e04f4ba202b707");
assert.equal(legacy.sources.shell.fullSourceSha256, "f4168d14905f528c01ff7b66de0c0dbf1977de717b26f3f46d59224b6a57a9b4");
for (const entry of Object.values(legacy.sources)) assert.equal(sha(entry.source), entry.sha256, `Frozen87 checksum: ${entry.path}`);
const A = "https://synthetic-progress-a.invalid", B = "https://synthetic-progress-b.invalid";
const plain = value => JSON.parse(JSON.stringify(value));
const strip = value => value.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function harness(input, mode = "movie", frozen = null) {
  const libraries = new Map([[A, createSyntheticAnimeLibrary({ count: 3 })], [B, createSyntheticAnimeLibrary({ count: 3 })]]);
  const library = libraries.get(A), id = library.id(mode === "anime" ? "anime-alpha" : mode === "tv" ? "tv-alpha" : "movie-alpha");
  library.saveProgress(id, { position: 73, duration: 600 });
  libraries.get(B).saveProgress(id, { position: 315, duration: 600 });
  const document = createNavigationFixtureDocument(), proto = Object.getPrototypeOf(document.body);
  if (!Object.getOwnPropertyDescriptor(proto, "isConnected")) Object.defineProperty(proto, "isConnected", { get() { return this.ownerDocument.body.contains(this); } });
  if (!Object.getOwnPropertyDescriptor(proto, "childElementCount")) Object.defineProperty(proto, "childElementCount", { get() { return this.children.length; } });
  proto.remove = function () { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; };
  const els = Object.fromEntries(["viewContent", "viewTitle", "viewMeta", "viewKicker", "contentPanel"].map(name => [name, document.createElement("div")]));
  document.body.append(...Object.values(els));
  const calls = { api: [], bridge: [], errors: [], cacheWrites: [], nav: [] }, queues = { list: [], detail: [], info: [] }, cache = new Map(), timers = new Map();
  let activeUrl = A, clock = 0, timerId = 0, passiveActive = 0, maxPassiveActive = 0;
  const capture = callback => event => { try { const task = callback(event); task?.catch?.(error => calls.errors.push(error)); return task; } catch (error) { calls.errors.push(error); } };
  const events = target => {
    const listeners = new Map();
    target.addEventListener = (type, callback, options = {}) => {
      if (options.signal?.aborted) return;
      const wrapped = capture(callback), entry = { callback, wrapped };
      if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(entry);
      options.signal?.addEventListener("abort", () => target.removeEventListener(type, callback), { once: true });
    };
    target.removeEventListener = (type, callback) => listeners.set(type, (listeners.get(type) || []).filter(entry => entry.callback !== callback));
    target.dispatchEvent = event => { for (const entry of [...(listeners.get(event.type) || [])]) entry.wrapped(event); };
    return target;
  };
  events(document); document.visibilityState = "visible";
  const create = document.createElement;
  document.createElement = tag => {
    const node = create(tag), add = node.addEventListener.bind(node), click = node.click.bind(node); node.disabled = false;
    node.addEventListener = (type, callback, options) => add(type, capture(callback), options);
    node.click = () => { if (node.disabled) return; node.onclick?.({ type: "click", target: node }); return click(); };
    return node;
  };
  const plugin = { async play(payload) { calls.bridge.push(plain(payload)); return { opened: true }; } };
  const context = vm.createContext({ document, console, URL, URLSearchParams, AbortController, captureMediaTrail, mediaBackTarget,
    currentView: "mediaDetail", currentViewParams: { id, mode }, viewRenderToken: 0, activeViewController: null,
    performance: { now: () => clock }, window: events({ Capacitor: { Plugins: { FanHaoPlayer: plugin } }, innerHeight: 844,
      setTimeout(fn, delay) { const key = ++timerId; timers.set(key, { fn, delay }); return key; }, clearTimeout(key) { timers.delete(key); } }),
    formatBytes, formatDate, formatNumber, formatTime, absoluteUrl, cacheAgeText: () => "synthetic", photoCatalogCollections: value => value,
    isChannelFavorite: () => false, toggleChannelFavorite: () => ({ favorite: true, items: [] }), loadPreviewImage() {}, enhanceAutoLoadMore() {},
    readCachedJson: async (base, path) => cache.get(JSON.stringify([base, path])) || null,
    writeCachedJson: async (base, path, value) => { calls.cacheWrites.push({ base, path, value: plain(value) }); },
    fetchJson: async (base, path, options = {}) => {
      assert(libraries.has(base), "Only synthetic origins permitted");
      const url = new URL(path, base), mediaId = decodeURIComponent(url.pathname.split("/").at(-1));
      const kind = path.startsWith("/api/gallery-media/") ? "detail" : path.startsWith("/api/playinfo/") ? "info" : path.startsWith("/api/image-library/items?") ? "list" : "unknown";
      assert.notEqual(kind, "unknown", `Unexpected synthetic API: ${path}`);
      const service = libraries.get(base);
      // Freeze the real response at request time, as a server could do before
      // a delayed transport. Tests then control delivery, not service results.
      const actual = plain(kind === "detail" ? service.detail(mediaId) : kind === "list" ? service.list(url) : await service.playInfo(mediaId, { source: url.searchParams.get("source") }));
      const call = { base, path, options, kind, actual }; calls.api.push(call);
      const passive = kind === "detail" && options.timeoutMs === 8000;
      if (passive) { passiveActive++; maxPassiveActive = Math.max(maxPassiveActive, passiveActive); }
      try {
        let next = queues[kind].length ? queues[kind].shift() : actual;
        if (typeof next === "function") next = next(call);
        if (next instanceof Error) throw next;
        return await (next?.promise || next);
      } finally { if (passive) passiveActive--; }
    }
  });
  const old = input === legacy.sources.channel.source;
  vm.runInContext(frozen?.shell || (old ? legacy.sources.shell.source : ["sameViewParams", "beginViewRender", "invalidateViewRender"].map(name => appFunction(appSource, name)).join("\n")), context);
  vm.runInContext(strip(input), context, { filename: old ? "frozen87-full-channel.js" : "production-full-channel.js" });
  const host = { els, normalizeChannelMode: context.normalizeChannelMode, getActiveUrl: () => activeUrl,
    limits: { getChannel: () => 36 }, recent: { record() {} }, favorites: { onChannelFavoriteChange() {} },
    navigation: { currentView: () => context.currentView, currentParams: () => context.currentViewParams, returnToStackView: () => false,
      showView: (...args) => calls.nav.push(plain(args)), goBack() {}, openInLibrary() {} },
    ui: { setActiveBottom() {}, scrollToTop() {}, refreshChrome() {}, openSearch() {}, renderCurrentView() {}, renderCurrentViewPreservingScroll() {} },
    contentIndex: { updateChannelQuery() {}, updateChannelParams() {}, updateSearch() {} } };
  const factory = vm.runInContext(`(function(){${strip(frozen?.media || (old ? legacy.sources.media.source : mediaSource))};return createAndroidModule;})()`, context);
  const module = factory({ host });
  const h = { id, mode, library, document, context, els, calls, plugin,
    readCount: () => calls.api.filter(call => call.kind === "detail").length,
    passiveCount: () => calls.api.filter(call => call.kind === "detail" && call.options.timeoutMs === 8000).length,
    maxPassive: () => maxPassiveActive,
    button: () => els.viewContent.querySelector(".media-native-play-surface"),
    setProgress(position) { library.saveProgress(id, { position, duration: 600 }); },
    setSource(value = B) { activeUrl = value; },
    queue(kind, value) { queues[kind].push(value); },
    hold(kind = "detail") { const gate = deferred(); let call; queues[kind].push(value => { call = value; return gate; });
      return { resolve: value => gate.resolve(value === undefined ? call.actual : value), reject: gate.reject, get call() { return call; } }; },
    holdNative() { const gate = deferred(); plugin.play = async payload => { calls.bridge.push(plain(payload)); return gate.promise; }; return gate; },
    cacheDetail(position = 73) { h.setProgress(position); cache.set(JSON.stringify([activeUrl, `/api/gallery-media/${encodeURIComponent(id)}`]), { payload: library.detail(id), updatedAt: "synthetic" }); },
    render(nextId = id) { context.currentView = "mediaDetail"; context.currentViewParams = { id: nextId, mode };
      const route = module.routes.find(value => value.view === "mediaDetail" && (!value.match || value.match(context.currentViewParams))); assert(route, `Actual media adapter accepts ${mode}`);
      return route.render(context.currentViewParams, context.beginViewRender("mediaDetail", context.currentViewParams)); },
    abort() { context.activeViewController.abort(); },
    leave() { context.invalidateViewRender(); context.currentView = "channel"; context.currentViewParams = { mode }; els.viewContent.textContent = "UNRELATED PAGE"; },
    async settle() { for (let round = 0; round < 120; round++) { await Promise.resolve(); for (const [key, entry] of [...timers]) if (timers.delete(key)) { clock += entry.delay; entry.fn(); } }
      assert.equal(calls.errors.length, 0, calls.errors[0]?.stack || "No unhandled callback errors"); },
    async focus() { context.window.dispatchEvent({ type: "focus" }); await h.settle(); },
    async visibility(value) { document.visibilityState = value; document.dispatchEvent({ type: "visibilitychange" }); await h.settle(); },
    async click() { assert(h.button(), "Actual production play button exists"); h.button().click(); await h.settle(); }
  }; return h;
}
async function ready(input, mode = "movie") { const h = harness(input, mode); await h.render(); await h.settle(); assert.match(h.button().textContent, /1:13/); return h; }
const label = (h, expected) => { assert.match(h.button().textContent, new RegExp(expected)); assert.equal(h.button().getAttribute("aria-label"), h.button().querySelector(".media-native-play-label").textContent); };
const tests = [], test = (name, run, old = false) => tests.push({ name, run, old });

for (const mode of ["movie", "tv", "anime"]) {
  test(`${mode}: return during old passive read drains once after explicit play revision`, async input => {
    const h = await ready(input, mode), oldRead = h.hold(); await h.focus(); h.setProgress(150); await h.click();
    assert.equal(h.calls.bridge.length, 1); assert.equal(h.calls.bridge[0].position, 150); label(h, "2:30");
    h.setProgress(190); const before = h.readCount(); await h.visibility("hidden"); await h.visibility("visible");
    for (let n = 0; n < 5; n++) await h.focus(); assert.equal(h.readCount(), before, "Pending passive read stays single-flight");
    const followup = h.hold(); oldRead.resolve(); await h.settle();
    assert.equal(h.readCount(), before + 1, "A return received during an older passive read requires one newer read");
    label(h, "2:30"); // Old revision must not paint even before the newer response arrives.
    followup.resolve(); await h.settle();
    label(h, "3:10"); assert.equal(h.maxPassive(), 1); assert.equal(h.calls.bridge.length, 1); await h.settle(); assert.equal(h.readCount(), before + 1);
  }, true);
  test(`${mode}: return during native bridge busy drains once after release`, async input => {
    const h = await ready(input, mode), native = h.holdNative(); h.setProgress(150); await h.click(); assert(h.button().disabled);
    h.setProgress(190); const before = h.readCount(); await h.visibility("visible"); for (let n = 0; n < 6; n++) await h.focus();
    assert.equal(h.readCount(), before); native.resolve({ opened: true }); await h.settle();
    assert.equal(h.readCount(), before + 1, "A return received during native busy requires one read after release");
    assert.equal(h.button().disabled, false); label(h, "3:10"); assert.equal(h.calls.bridge.length, 1);
  }, true);
  test(`${mode}: return during launch-detail preparation survives until release`, async input => {
    const h = await ready(input, mode); h.setProgress(150); const launch = h.hold(); await h.click(); assert(h.button().disabled); assert.equal(h.calls.bridge.length, 0);
    h.setProgress(190); await h.focus(); await h.visibility("visible"); const before = h.readCount(); launch.resolve(); await h.settle();
    assert.equal(h.calls.bridge[0].position, 150, "Launch uses its validated fresh detail, not a passive response");
    assert.equal(h.readCount(), before + 1); label(h, "3:10");
  });
  test(`${mode}: following explicit play always rereads progress instead of trusting refreshed label`, async input => {
    const h = await ready(input, mode); h.setProgress(190); await h.focus(); label(h, "3:10"); h.setProgress(250); await h.click();
    const play = h.calls.bridge[0]; assert.equal(play.position, 250); assert.equal(play.videoId, h.id); assert.equal(play.mode, "gallery-media");
    assert.equal(play.progressUrl, `${A}/api/progress/${encodeURIComponent(h.id)}`); assert.equal(play.url, `${A}/media/gallery-video/${h.id}`); label(h, "4:10");
    for (const call of h.calls.api.filter(call => call.options.timeoutMs === 8000 || call.kind === "info")) {
      assert.equal(call.base, A); assert.equal(call.options.signal, h.context.activeViewController.signal); assert.equal(call.options.cache, "no-store");
      if (call.kind === "info") assert.equal(new URL(call.path, A).searchParams.get("source"), "gallery");
    }
  });
}
test("many events during each flight coalesce but events in followup schedule one more read", async input => {
  const h = await ready(input); h.setProgress(100); const first = h.hold(); await h.focus();
  for (let n = 0; n < 20; n++) await h.focus(); assert.equal(h.readCount(), 2);
  h.setProgress(190); const second = h.hold(); first.resolve(); await h.settle(); assert.equal(h.readCount(), 3); label(h, "1:40");
  for (let n = 0; n < 20; n++) await h.focus(); assert.equal(h.readCount(), 3);
  h.setProgress(250); second.resolve(); await h.settle(); assert.equal(h.readCount(), 4); label(h, "4:10");
  assert.equal(h.maxPassive(), 1); await h.settle(); assert.equal(h.readCount(), 4);
});
test("single event success has no unsolicited followup", async input => {
  const h = await ready(input); h.setProgress(190); await h.focus(); await h.settle(); assert.equal(h.readCount(), 2); label(h, "3:10");
});
test("single event failure has no automatic retry but next event can recover", async input => {
  const h = await ready(input); h.queue("detail", Error("Synthetic offline")); await h.focus();
  for (let n = 0; n < 8; n++) await h.settle(); assert.equal(h.readCount(), 2); label(h, "1:13");
  h.setProgress(190); await h.focus(); assert.equal(h.readCount(), 3); label(h, "3:10");
});
test("failed older read drains one queued event and stops after a failed followup", async input => {
  const h = await ready(input), first = h.hold(); await h.focus(); for (let n = 0; n < 8; n++) await h.focus();
  h.queue("detail", Error("Synthetic followup offline")); first.reject(Error("Synthetic first offline")); await h.settle();
  assert.equal(h.readCount(), 3); for (let n = 0; n < 8; n++) await h.settle(); assert.equal(h.readCount(), 3); label(h, "1:13");
  h.setProgress(190); await h.focus(); label(h, "3:10"); assert.equal(h.readCount(), 4);
});
test("hidden focus creates no read and later visible event reads once", async input => {
  const h = await ready(input); h.setProgress(190); await h.visibility("hidden"); await h.focus(); await h.focus(); assert.equal(h.readCount(), 1);
  await h.visibility("visible"); assert.equal(h.readCount(), 2); label(h, "3:10");
});
test("pending response and queued event neither paint nor drain while hidden", async input => {
  const h = await ready(input); h.setProgress(100); const first = h.hold(); await h.focus(); await h.focus(); await h.visibility("hidden");
  h.setProgress(190); first.resolve(); await h.settle(); assert.equal(h.readCount(), 2); label(h, "1:13");
  await h.visibility("visible"); assert.equal(h.readCount(), 3); label(h, "3:10");
});
test("queued return during busy waits for visibility after native release", async input => {
  const h = await ready(input), native = h.holdNative(); h.setProgress(150); await h.click(); h.setProgress(190); await h.focus(); await h.visibility("hidden");
  native.resolve({ opened: true }); await h.settle(); assert.equal(h.readCount(), 2); assert.equal(h.button().disabled, false);
  await h.visibility("visible"); assert.equal(h.readCount(), 3); label(h, "3:10");
});
for (const invalidate of ["source", "abort", "detach", "leave", "route", "rerender"]) test(`${invalidate}: old passive completion cannot paint or drain queued work`, async input => {
  const h = await ready(input); h.setProgress(190); const old = h.hold(); await h.focus(); await h.focus(); const oldButton = h.button(), oldLabel = oldButton.textContent;
  if (invalidate === "source") h.setSource(); else if (invalidate === "abort") h.abort(); else if (invalidate === "detach") h.els.viewContent.textContent = "DETACHED";
  else if (invalidate === "leave") h.leave(); else if (invalidate === "route") h.context.currentViewParams = { id: "another-id", mode: "movie" };
  else { h.setProgress(250); await h.render(); await h.settle(); assert.notEqual(h.button(), oldButton); }
  const before = h.readCount(), visible = h.els.viewContent.textContent; old.resolve(); await h.settle();
  assert.equal(h.readCount(), before, "Invalidated owner must not issue its queued followup"); assert.equal(h.els.viewContent.textContent, visible);
  assert.equal(oldButton.textContent, oldLabel); assert.equal(h.calls.bridge.length, 0);
});
for (const invalidate of ["source", "abort", "detach", "leave"]) test(`${invalidate}: native release cannot drain the invalidated surface`, async input => {
  const h = await ready(input), native = h.holdNative(); h.setProgress(150); await h.click(); await h.focus();
  if (invalidate === "source") h.setSource(); else if (invalidate === "abort") h.abort(); else if (invalidate === "detach") h.els.viewContent.textContent = "DETACHED"; else h.leave();
  const before = h.readCount(); native.resolve({ opened: true }); await h.settle(); assert.equal(h.readCount(), before); assert.equal(h.calls.bridge.length, 1);
  assert(h.calls.api.every(call => call.base === A), "No old owner changes its source to follow a new endpoint");
});
test("old passive response finishing during native busy cannot paint or unlock the play button", async input => {
  const h = await ready(input), old = h.hold(); await h.focus(); const native = h.holdNative(); h.setProgress(150); await h.click(); h.setProgress(190); await h.focus();
  const before = h.readCount(); old.resolve(); await h.settle(); assert.equal(h.readCount(), before); assert.equal(h.button().disabled, true); assert.match(h.button().textContent, /正在打开/);
  native.resolve({ opened: true }); await h.settle(); assert.equal(h.readCount(), before + 1); label(h, "3:10");
});
for (const bad of ["foreign", "missing"]) test(`${bad} passive identity cannot paint; valid queued followup still recovers`, async input => {
  const h = await ready(input), first = h.hold(); await h.focus();
  const badData = bad === "missing" ? { item: null } : { item: { ...first.call.actual.item, id: "foreign", progress: { position: 555, duration: 600 } } };
  first.resolve(badData); await h.settle(); label(h, "1:13"); assert.equal(h.calls.bridge.length, 0);
  h.setProgress(190); const next = h.hold(); await h.focus(); await h.focus(); next.resolve(badData); await h.settle(); label(h, "3:10"); assert.equal(h.readCount(), 4);
});
test("unclicked cache background replacement retires the old passive refresh queue", async input => {
  const h = harness(input); h.cacheDetail(); const background = h.hold(), rendering = h.render(); await h.settle(); const oldButton = h.button();
  const passive = h.hold(); await h.focus(); await h.focus(); h.setProgress(190); background.resolve(h.library.detail(h.id)); await rendering; await h.settle();
  assert.notEqual(h.button(), oldButton); label(h, "3:10"); const before = h.readCount(); passive.resolve(); await h.settle(); assert.equal(h.readCount(), before); label(h, "3:10");
});
test("accepted cached play retains its surface while return refresh outruns older background detail", async input => {
  const h = harness(input); h.cacheDetail(); const background = h.hold(), rendering = h.render(); await h.settle(); const button = h.button(), native = h.holdNative();
  h.setProgress(150); await h.click(); h.setProgress(190); await h.focus(); native.resolve({ opened: true }); await h.settle(); label(h, "3:10");
  background.resolve(); await rendering; await h.settle(); assert.equal(h.button(), button); label(h, "3:10"); assert.equal(h.calls.bridge.length, 1);
});

const mutations = [], mutate = (name, scenario, change) => mutations.push({ name, scenario, change });
const once = (value, from, to) => { assert(value.includes(from), `Missing mutation anchor: ${from}`); return value.replace(from, to); };
const surfaceMutation = change => value => {
  const start = value.indexOf("  function createNativePlaySurface("), end = value.indexOf("\n  function waitForMinimumOpenTime(", start);
  assert(start >= 0 && end > start); const method = value.slice(start, end); return value.slice(0, start) + change(method) + value.slice(end);
};
mutate("drop events while a passive read is pending", tests[0].name, surfaceMutation(value => once(value, 'if (!isActive() || document.visibilityState === "hidden") return;', 'if (!isActive() || refreshing || document.visibilityState === "hidden") return;')));
mutate("drop events while the play button is busy", tests[1].name, surfaceMutation(value => once(value, 'if (!isActive() || document.visibilityState === "hidden") return;', 'if (!isActive() || button.disabled || document.visibilityState === "hidden") return;')));
mutate("forget followup after passive completion", tests[0].name, surfaceMutation(value => once(value, "if (refreshPending) void drainProgressRefresh();", "/* mutation: no completion drain */")));
mutate("forget followup after play release", tests[1].name, surfaceMutation(value => {
  const at = value.lastIndexOf("if (refreshPending) void drainProgressRefresh();"); assert(at >= 0); return value.slice(0, at) + value.slice(at).replace("if (refreshPending) void drainProgressRefresh();", "/* mutation: no release drain */");
}));
mutate("allow concurrent passive reads", "many events during each flight coalesce but events in followup schedule one more read", surfaceMutation(value => once(value, " || refreshing || ", " || ")));
mutate("start queued work while hidden", "pending response and queued event neither paint nor drain while hidden", surfaceMutation(value => once(value, ' || document.visibilityState === "hidden") return;', ') return;')));
mutate("paint completed passive response while hidden", "pending response and queued event neither paint nor drain while hidden", surfaceMutation(value => once(value, ' && document.visibilityState !== "hidden"', "")));
mutate("accept stale pre-play passive revision", tests[0].name, surfaceMutation(value => once(value, "revision === progressRevision && ", "")));
mutate("accept foreign passive identity", "foreign passive identity cannot paint; valid queued followup still recovers", surfaceMutation(value => once(value, ' && String(data?.item?.id || "") === String(item.id)', "")));
mutate("allow detached owner to drain", "detach: old passive completion cannot paint or drain queued work", surfaceMutation(value => once(value, "document.body.contains(button) && ", "")));
mutate("ignore aborted render owner", "abort: old passive completion cannot paint or drain queued work", surfaceMutation(value => once(value, "&& !playbackContext.signal?.aborted && (playbackContext.isActive?.() ?? true)", "&& true")));
mutate("forget new events received during followup", "many events during each flight coalesce but events in followup schedule one more read", surfaceMutation(value => once(value, "refreshPending = true;\n", "refreshPending = refreshing ? false : true;\n")));

export { harness, deferred };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
let passed = 0, failed = 0, oldRejected = 0, mutantsRejected = 0;
if (!process.argv.includes("--legacy-only")) for (const entry of tests) {
  try { await entry.run(source); passed++; console.log(`PASS ${entry.name}`); } catch (error) { failed++; console.error(`FAIL ${entry.name}\n${error.stack}`); }
}
for (const entry of tests.filter(value => value.old)) {
  try { let failure; try { await entry.run(legacy.sources.channel.source); } catch (error) { failure = error; }
    assert(failure instanceof assert.AssertionError, `Frozen87 must fail a behavior assertion, not fixture setup: ${failure?.stack || "unexpected pass"}`);
    assert.match(failure.message, /requires one (newer read|read after release)/); assert.equal(failure.expected - failure.actual, 1);
    oldRejected++; console.log(`REJECT frozen87 ${entry.name}: ${failure.actual} reads, expected ${failure.expected}`);
  } catch (error) { failed++; console.error(error.stack); }
}
if (!process.argv.includes("--legacy-only")) for (const mutation of mutations) {
  try { const changed = mutation.change(source); assert.notEqual(changed, source); const entry = tests.find(value => value.name === mutation.scenario); assert(entry);
    let failure; try { await entry.run(changed); } catch (error) { failure = error; }
    assert(failure instanceof assert.AssertionError, `Mutant must fail a behavior assertion, not setup: ${failure?.stack || "unexpected pass"}`);
    mutantsRejected++; console.log(`REJECT mutation ${mutation.name}`);
  } catch (error) { failed++; console.error(`FAIL mutation ${mutation.name}\n${error.stack}`); }
}
console.log(`Media progress refresh: ${passed}/${tests.length} current; ${oldRejected}/${tests.filter(value => value.old).length} frozen87 controls; ${mutantsRejected}/${mutations.length} behavior mutants; ${failed} failures.`);
console.log(`channel SHA256 ${sha(source)}`);
process.exitCode = failed ? 1 : 0;
}
