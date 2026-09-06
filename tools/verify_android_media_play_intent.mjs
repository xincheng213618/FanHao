import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { appFunction, createNavigationFixtureDocument } from "./fixtures/android-gallery-navigation-harness.mjs";
import { captureMediaTrail, mediaBackTarget } from "../android-client/www/js/media-navigation-state.js";
import { formatBytes, formatDate, formatNumber, formatTime } from "../android-client/www/js/format.js";
import { absoluteUrl } from "../android-client/www/js/image.js";

// Complete channel factory and media adapter execute, including cached/fresh
// detail rendering and actual play buttons. The shell's real render-generation
// methods provide page guards. DOM/events, cache, HTTP, clock, image loading and
// native bridge are synthetic boundaries; no browser/device/live data is used.
const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const source = read("android-client/www/platform/content-index/channel-views.js");
const appSource = read("android-client/www/app.js"), mediaSource = read("android-client/www/modules/media/android-module.js");
const legacy = JSON.parse(read("tools/fixtures/android-media-play-intent-before-fix.json"));
assert.equal(createHash("sha256").update(JSON.stringify(legacy.sources)).digest("hex"), "2debfa53dd639eab0da1049c09ee43cdced8577edc8c0d8240e2189addf9ae86");
for (const entry of Object.values(legacy.sources)) assert.equal(createHash("sha256").update(entry.source).digest("hex"), entry.sha256, `Frozen source checksum: ${entry.path}`);
const A = "https://synthetic-a.invalid", B = "https://synthetic-b.invalid", ID = "synthetic-film/1#%";
const plain = value => JSON.parse(JSON.stringify(value));
const strip = source => source.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function item(mode = "movie", position = 73) {
  return { id: ID, mediaKind: mode, type: mode, title: "Synthetic film", exists: true, ext: "mkv", size: 2048,
    movieMetadata: { title: "Synthetic film", year: "2025" }, coverUrl: "/synthetic-cover.jpg",
    streamUrl: `/media/gallery-video/${encodeURIComponent(ID)}`, progress: { position, duration: 240 } };
}
function harness(input = source, { mode = "movie", cached = true } = {}) {
  const document = createNavigationFixtureDocument(), proto = Object.getPrototypeOf(document.body);
  if (!Object.getOwnPropertyDescriptor(proto, "isConnected")) Object.defineProperty(proto, "isConnected", { get() { return this.ownerDocument.body.contains(this); } });
  if (!Object.getOwnPropertyDescriptor(proto, "childElementCount")) Object.defineProperty(proto, "childElementCount", { get() { return this.children.length; } });
  proto.remove = function () { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; };
  const els = Object.fromEntries(["viewContent", "viewTitle", "viewMeta", "viewKicker", "contentPanel"].map(name => [name, document.createElement("div")]));
  document.body.append(...Object.values(els));
  const calls = { fetch: [], bridge: [], cacheWrites: [], errors: [], actions: new Set() }, queues = { detail: [], info: [] }, timers = new Map();
  let sourceUrl = A, cacheValue = cached ? { updatedAt: "synthetic", payload: { item: item(mode) } } : null, clock = 0, timerId = 0;
  const originalCreate = document.createElement;
  document.createElement = tag => {
    const node = originalCreate(tag); node.disabled = false; const add = node.addEventListener.bind(node);
    node.addEventListener = (type, callback, options) => add(type, event => {
      try { const task = callback(event); if (task?.then) { calls.actions.add(task); task.catch(error => calls.errors.push(error)).finally(() => calls.actions.delete(task)); } return task; }
      catch (error) { calls.errors.push(error); }
    }, options); return node;
  };
  const eventTarget = target => {
    const listeners = new Map(); target.listeners = listeners;
    target.addEventListener = (type, callback, options = {}) => {
      if (options.signal?.aborted) return;
      if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(callback);
      options.signal?.addEventListener("abort", () => target.removeEventListener(type, callback), { once: true });
    };
    target.removeEventListener = (type, callback) => listeners.set(type, (listeners.get(type) || []).filter(value => value !== callback));
    target.dispatchEvent = event => { for (const callback of [...(listeners.get(event.type) || [])]) callback(event); };
    return target;
  };
  eventTarget(document); document.visibilityState = "visible";
  const plugin = { async play(payload) { calls.bridge.push(plain(payload)); return { opened: true }; } };
  const c = vm.createContext({ document, console, URL, URLSearchParams, AbortController, captureMediaTrail, mediaBackTarget,
    currentView: "mediaDetail", currentViewParams: { id: ID, mode }, viewRenderToken: 0, activeViewController: null,
    performance: { now: () => clock }, window: eventTarget({ Capacitor: { Plugins: { FanHaoPlayer: plugin } },
      setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); } }),
    formatBytes, formatDate, formatNumber, formatTime, absoluteUrl, cacheAgeText: () => "synthetic", photoCatalogCollections: value => value,
    isChannelFavorite: () => false, toggleChannelFavorite: () => ({ favorite: true, items: [] }), enhanceAutoLoadMore() {}, loadPreviewImage() {},
    readCachedJson: async () => cacheValue, writeCachedJson: async (...args) => { calls.cacheWrites.push(plain(args)); },
    fetchJson: async (base, path, options = {}) => {
      assert([A, B].includes(base), "Only synthetic origins permitted"); const kind = path.startsWith("/api/gallery-media/") ? "detail" : path.startsWith("/api/playinfo/") ? "info" : "unknown";
      assert.notEqual(kind, "unknown", `Unexpected request${path}`); calls.fetch.push({ base, path, options, kind }); const next = queues[kind].shift();
      if (next instanceof Error) throw next; if (next !== undefined) return await (next.promise || next);
      return kind === "detail" ? { item: item(mode, 125) } : { mode: "direct", streamUrl: item(mode).streamUrl, duration: 240 };
    }
  });
  vm.runInContext(["sameViewParams", "beginViewRender", "invalidateViewRender"].map(name => appFunction(appSource, name)).join("\n"), c);
  vm.runInContext(strip(input), c, { filename: "actual-channel-views.js" });
  const host = { els, normalizeChannelMode: c.normalizeChannelMode, getActiveUrl: () => sourceUrl,
    limits: { getChannel: () => 36 }, recent: { record() {} }, favorites: { onChannelFavoriteChange() {} },
    navigation: { currentView: () => c.currentView, currentParams: () => c.currentViewParams, returnToStackView: () => false, showView() {}, goBack() {}, openInLibrary() {} },
    ui: { setActiveBottom() {}, scrollToTop() {}, renderCurrentView() {}, renderCurrentViewPreservingScroll() {}, refreshChrome() {}, openSearch() {} },
    contentIndex: { updateChannelQuery() {}, updateChannelParams() {}, updateSearch() {} } };
  const adapter = input === legacy.sources.channel.source ? legacy.sources.media.source : mediaSource;
  const factory = vm.runInContext(`(function(){${strip(adapter)};return createAndroidModule;})()`, c), module = factory({ host });
  const h = { c, module, els, document, calls, plugin,
    queue(kind, value) { queues[kind].push(value); }, setSource(value) { sourceUrl = value; }, clearCache() { cacheValue = null; }, setCache(value) { cacheValue = value; },
    startRender(id = ID) { c.currentView = "mediaDetail"; c.currentViewParams = { id, mode }; const guard = c.beginViewRender(c.currentView, c.currentViewParams); return module.routes.find(route => route.view === "mediaDetail").render(c.currentViewParams, guard); },
    leave() { c.invalidateViewRender(); c.currentView = "channel"; c.currentViewParams = { mode }; els.viewContent.textContent = "UNRELATED PAGE"; },
    abort() { c.activeViewController.abort(); },
    button: () => els.viewContent.querySelector(".media-native-play-surface"), errors: () => els.viewContent.querySelectorAll(".media-player-error"),
    async settle() { for (let round = 0; round < 40; round++) { await Promise.resolve(); for (const [id, timer] of [...timers]) if (timers.delete(id)) { clock += timer.delay; timer.fn(); } }
      assert.equal(calls.errors.length, 0, calls.errors[0]?.stack || "No unhandled real callback failure"); },
    async click() { assert(h.button()); h.button().click(); await h.settle(); },
    async focus() { c.window.dispatchEvent({ type: "focus" }); await h.settle(); }
  }; return h;
}

const tests = [], test = (name, run) => tests.push({ name, run });
for (const mode of ["movie", "tv"]) for (const stage of ["both", "detail", "info"]) test(`${mode}: cached accepted play survives background fresh before ${stage} launch completion`, async input => {
  const h = harness(input, { mode }), background = deferred(), detail = deferred(), info = deferred();
  h.queue("detail", background); const rendering = h.startRender(); await h.settle(); const clicked = h.button(); assert(clicked?.isConnected);
  h.queue("detail", detail); h.queue("info", info); await h.click(); assert.equal(clicked.disabled, true);
  if (stage === "detail") { info.resolve({ mode: "direct", duration: 240 }); await h.settle(); }
  if (stage === "info") { detail.resolve({ item: item(mode, 125) }); await h.settle(); }
  background.resolve({ item: item(mode, 30) }); await rendering; await h.settle();
  detail.resolve({ item: item(mode, 125) }); info.resolve({ mode: "direct", duration: 240 }); await h.settle();
  assert.equal(h.calls.bridge.length, 1, "An accepted same-page play must not be silently canceled by background detail rendering");
  assert.equal(h.calls.bridge[0].videoId, ID); assert.equal(h.calls.bridge[0].position, 125); assert.equal(h.calls.bridge[0].progressUrl, `${A}/api/progress/${encodeURIComponent(ID)}`);
});
test("launch finishes before background, still dispatches once", async input => {
  const h = harness(input), background = deferred(); h.queue("detail", background); const rendering = h.startRender(); await h.settle();
  const button = h.button(); await h.click(); assert.equal(h.calls.bridge.length, 1); background.resolve({ item: item("movie", 30) }); await rendering; await h.settle(); assert.equal(h.calls.bridge.length, 1);
  assert.equal(h.button(), button, "Completed accepted intent remains protected from older background paint"); assert.match(h.button().textContent, /2:05/);
});

async function accepted(input, mode = "movie") {
  const h = harness(input, { mode }), background = deferred(), detail = deferred(), info = deferred();
  h.queue("detail", background); const rendering = h.startRender(); await h.settle(); const button = h.button(); assert(button);
  h.queue("detail", detail); h.queue("info", info); await h.click();
  return { h, background, rendering, detail, info, button };
}
test("without explicit click fresh detail normally replaces cached presentation", async input => {
  const h = harness(input), background = deferred(); h.queue("detail", background); const task = h.startRender(); await h.settle(); const cached = h.button();
  assert.match(cached.textContent, /1:13/); background.resolve({ item: item("movie", 125) }); await task; await h.settle();
  assert.notEqual(h.button(), cached); assert.match(h.button().textContent, /2:05/); assert.equal(h.calls.bridge.length, 0); assert.equal(h.calls.cacheWrites.length, 1);
});
test("without explicit click background failure keeps cached button and visible offline message", async input => {
  const h = harness(input), background = deferred(); h.queue("detail", background); const task = h.startRender(); await h.settle(); const cached = h.button();
  background.reject(Error("Synthetic background offline")); await task; await h.settle(); assert.equal(h.button(), cached);
  assert.match(h.els.viewContent.textContent, /本地缓存媒体信息/); assert.equal(h.calls.bridge.length, 0);
});
test("accepted click suppresses unrelated background error while native still launches", async input => {
  const { h, background, rendering, detail, info, button } = await accepted(input);
  background.reject(Error("Synthetic passive refresh failure")); await rendering; await h.settle(); assert.equal(h.button(), button); assert.equal(h.els.viewContent.textContent.includes("本地缓存媒体信息"), false);
  detail.resolve({ item: item("movie", 125) }); info.resolve({ mode: "direct", duration: 240 }); await h.settle(); assert.equal(h.calls.bridge.length, 1); assert.equal(h.errors().length, 0);
});
for (const failure of ["network", "missing", "foreign", "moved", "unsafe"]) test(`accepted launch ${failure} failure remains visible after background refresh`, async input => {
  const { h, background, rendering, detail, info, button } = await accepted(input);
  background.resolve({ item: item("movie", 30) }); await rendering;
  if (failure === "network") detail.reject(Error("Synthetic launch read failure"));
  else {
    const value = item(); if (failure === "foreign") value.id = "foreign-id";
    if (failure === "moved") value.exists = false; if (failure === "unsafe") value.streamUrl = "https://foreign.invalid/video.mkv";
    detail.resolve({ item: failure === "missing" ? null : value });
  }
  info.resolve({ mode: "direct", duration: 240 }); await h.settle();
  assert.equal(h.calls.bridge.length, 0); assert.equal(h.button(), button); assert.equal(h.errors().length, 1, "Active accepted launch failure must remain visible"); assert.equal(h.button().disabled, false);
});
for (const result of ["false", "reject"]) test(`native ${result} remains a visible failure on the accepted button`, async input => {
  const h = harness(input), background = deferred(); h.queue("detail", background); const rendering = h.startRender(); await h.settle(); const button = h.button();
  h.plugin.play = async payload => { h.calls.bridge.push(plain(payload)); if (result === "reject") throw Error("Synthetic native failure"); return { opened: false }; };
  await h.click(); background.resolve({ item: item("movie", 30) }); await rendering; await h.settle();
  assert.equal(h.calls.bridge.length, 1); assert.equal(h.button(), button); assert.equal(h.errors().length, 1); assert.equal(h.button().disabled, false);
});
for (const invalidate of ["leave", "source", "abort", "detach", "rerender"]) test(`${invalidate} invalidation still cancels an accepted pending launch`, async input => {
  const { h, background, rendering, detail, info, button } = await accepted(input); let replacement = null;
  if (invalidate === "leave") h.leave(); else if (invalidate === "source") { h.setSource(B); h.els.viewContent.textContent = "OTHER SOURCE"; }
  else if (invalidate === "abort") h.abort(); else if (invalidate === "detach") h.els.viewContent.textContent = "DETACHED BUTTON";
  else { await h.startRender(); await h.settle(); replacement = h.button(); assert.notEqual(replacement, button); }
  const before = h.els.viewContent.textContent;
  background.resolve({ item: item("movie", 30) }); detail.resolve({ item: item("movie", 125) }); info.resolve({ mode: "direct", duration: 240 });
  await rendering; await h.settle(); assert.equal(h.calls.bridge.length, 0);
  if (invalidate === "abort") { assert.equal(h.button(), button); assert.equal(h.errors().length, 0); assert.equal(h.button().textContent.includes("2:05"), false, "Aborted launch does not accept prepared fresh progress"); }
  else assert.equal(h.els.viewContent.textContent, before);
  if (replacement) assert.equal(h.button(), replacement);
});
test("programmatic double click stays single-flight through background refresh and can retry later", async input => {
  const { h, background, rendering, detail, info, button } = await accepted(input);
  button.click(); await h.settle(); assert.equal(h.calls.fetch.filter(call => call.kind === "detail").length, 2); assert.equal(h.calls.fetch.filter(call => call.kind === "info").length, 1);
  background.resolve({ item: item("movie", 30) }); await rendering; detail.resolve({ item: item("movie", 125) }); info.resolve({ mode: "direct", duration: 240 }); await h.settle();
  assert.equal(h.calls.bridge.length, 1); h.queue("detail", { item: item("movie", 150) }); await h.click(); assert.equal(h.calls.bridge.length, 2); assert.equal(h.calls.bridge[1].position, 150);
});
test("background refresh cannot create another enabled surface while bridge promise is pending", async input => {
  const h = harness(input), background = deferred(), native = deferred(); h.queue("detail", background); const rendering = h.startRender(); await h.settle(); const button = h.button();
  h.plugin.play = async payload => { h.calls.bridge.push(plain(payload)); return await native.promise; };
  await h.click(); assert.equal(h.calls.bridge.length, 1); assert.equal(button.disabled, true);
  background.resolve({ item: item("movie", 30) }); await rendering; await h.settle(); assert.equal(h.button(), button); h.button().click(); await h.settle(); assert.equal(h.calls.bridge.length, 1);
  native.resolve({ opened: true }); await h.settle(); assert.equal(button.disabled, false);
});
for (const invalid of ["missing", "foreign"]) test(`${invalid} background identity cannot render or enter cache`, async input => {
  const h = harness(input), background = deferred(); h.queue("detail", background); const rendering = h.startRender(); await h.settle(); const button = h.button();
  background.resolve({ item: invalid === "missing" ? null : { ...item(), id: "foreign-id" } }); await rendering; await h.settle();
  assert.equal(h.button(), button); assert.equal(h.calls.cacheWrites.length, 0); assert.equal(h.calls.bridge.length, 0);
});
test("foreign cached identity is ignored until matching fresh detail arrives", async input => {
  const h = harness(input), background = deferred(); h.setCache({ payload: { item: { ...item(), id: "foreign-id" } } }); h.queue("detail", background);
  const rendering = h.startRender(); await h.settle(); assert.equal(h.button(), null, "Foreign cache is not an actionable playback surface");
  background.resolve({ item: item() }); await rendering; await h.settle(); assert(h.button()); assert.equal(h.calls.bridge.length, 0);
});
test("missing initial stream does not claim a play intent or suppress later valid background detail", async input => {
  const h = harness(input), background = deferred(); h.setCache({ payload: { item: { ...item(), streamUrl: "" } } }); h.queue("detail", background);
  const rendering = h.startRender(); await h.settle(); const button = h.button(); await h.click(); assert.equal(h.calls.fetch.length, 1); assert.equal(h.calls.bridge.length, 0);
  background.resolve({ item: item("movie", 125) }); await rendering; await h.settle(); assert.notEqual(h.button(), button); await h.click(); assert.equal(h.calls.bridge.length, 1);
});
test("optional playinfo failure retains valid fresh direct playback and saved duration", async input => {
  const { h, background, rendering, detail, info } = await accepted(input); background.resolve({ item: item() }); await rendering;
  detail.resolve({ item: item("movie", 125) }); info.reject(Error("Synthetic probe unavailable")); await h.settle(); assert.equal(h.calls.bridge.length, 1); assert.equal(h.calls.bridge[0].duration, 240); assert.equal(h.calls.bridge[0].fallbackUrl, "");
});
test("source-only replacement with still-mounted button cancels pending native dispatch", async input => {
  const { h, background, rendering, detail, info, button } = await accepted(input); h.setSource(B);
  background.resolve({ item: item("movie", 30) }); detail.resolve({ item: item("movie", 125) }); info.resolve({ mode: "direct", duration: 240 }); await rendering; await h.settle();
  assert.equal(h.button(), button); assert.equal(h.calls.bridge.length, 0); assert.equal(h.errors().length, 0);
});

test("source replacement while cached detail is pending does not create a stale surface or fetch", async input => {
  const h = harness(input), cached = deferred(); h.setCache(cached.promise); const rendering = h.startRender(); await h.settle();
  h.setSource(B); cached.resolve({ payload: { item: item() } }); await rendering; await h.settle();
  assert.equal(h.button(), null); assert.equal(h.calls.fetch.length, 0); assert.equal(h.calls.bridge.length, 0);
});

const mutations = [], mutate = (name, testName, change) => mutations.push({ name, testName, change });
const replaceOnce = (value, from, to) => { assert(value.includes(from), `Mutation target missing: ${from}`); return value.replace(from, to); };
const transformFunction = (value, name, change) => {
  const start = value.search(new RegExp(`^  (?:async )?function ${name}\\(`, "m")); assert(start >= 0, `Missing real factory method ${name}`);
  const tail = value.slice(start), end = /^  }(?=\r?\n)/m.exec(tail); assert(end, `Missing factory method end ${name}`);
  const method = tail.slice(0, end.index + end[0].length); return replaceOnce(value, method, change(method));
};
mutate("disconnect accepted intent notification", tests[0].name, value => replaceOnce(value, "playbackContext.onPlayRequested?.();", "/* mutation: notification disconnected */"));
mutate("allow background success to rebuild accepted button", tests[0].name, value => replaceOnce(value, "if (!isCurrent() || playbackRequested) return;", "if (!isCurrent()) return;"));
mutate("allow passive failure message after accepted click", "accepted click suppresses unrelated background error while native still launches", value => transformFunction(value, "renderMediaDetail", method => {
  const target = "if (!isCurrent() || playbackRequested) return;", index = method.lastIndexOf(target); assert(index >= 0);
  return method.slice(0, index) + method.slice(index).replace(target, "if (!isCurrent()) return;");
}));
mutate("protect only while busy rather than throughout accepted render", "launch finishes before background, still dispatches once", value => transformFunction(value, "renderMediaDetail", method => method.replaceAll("if (!isCurrent() || playbackRequested) return;", 'if (!isCurrent() || (playbackRequested && els.viewContent.querySelector(".media-native-play-surface")?.disabled)) return;')));
mutate("claim empty-stream click before validation", "missing initial stream does not claim a play intent or suppress later valid background detail", value => transformFunction(value, "createNativePlaySurface", method => replaceOnce(replaceOnce(method, "playbackContext.onPlayRequested?.();", ""), "if (!streamUrl) {", "playbackContext.onPlayRequested?.();\n      if (!streamUrl) {")));
mutate("accept foreign cached route identity", "foreign cached identity is ignored until matching fresh detail arrives", value => replaceOnce(value, 'if (String(cached?.payload?.item?.id || "") === mediaId)', "if (cached?.payload?.item)"));
mutate("allow foreign background identity into rendering and cache", "foreign background identity cannot render or enter cache", value => replaceOnce(value, 'if (String(data?.item?.id || "") !== mediaId) throw new Error("媒体信息已变化，请返回列表刷新后重试。");', "/* mutation: background identity unchecked */"));
mutate("allow foreign launch identity", "accepted launch foreign failure remains visible after background refresh", value => replaceOnce(value, 'if (String(fresh?.id || "") !== id) throw new Error("媒体信息已变化，请返回列表刷新后重试。");', "/* mutation: launch identity unchecked */"));
mutate("remove actual mounted-button fence", "detach invalidation still cancels an accepted pending launch", value => replaceOnce(value, "document.body.contains(button) && ", ""));
mutate("remove single-flight click fence", "programmatic double click stays single-flight through background refresh and can retry later", value => replaceOnce(value, "if (button.disabled || !isActive()) return;", "if (!isActive()) return;"));
mutate("remove source fences but retain page and DOM guards", "source-only replacement with still-mounted button cancels pending native dispatch", value => {
  let changed = replaceOnce(value, "getActiveUrl() === sourceUrl\n", "true\n");
  changed = transformFunction(changed, "openNativeMediaPlayer", method => replaceOnce(method, " || getActiveUrl() !== sourceUrl", ""));
  return transformFunction(changed, "renderMediaDetail", method => replaceOnce(method, " && getActiveUrl() === activeUrl", ""));
});
mutate("skip current-source check after pending cache lookup", "source replacement while cached detail is pending does not create a stale surface or fetch", value => transformFunction(value, "renderMediaDetail", method => replaceOnce(method, "if (!isCurrent()) return;", "/* mutation: pending cache ownership ignored */")));

let passed = 0, failed = 0, oldRejected = 0, mutantsRejected = 0;
if (!process.argv.includes("--legacy-only")) for (const test of tests) { try { await test.run(source); passed++; console.log(`PASS ${test.name}`); } catch (error) { failed++; console.error(`FAIL ${test.name}\n${error.stack}`); } }
for (const test of tests.slice(0, 6)) {
  try { let failure; try { await test.run(legacy.sources.channel.source); } catch (error) { failure = error; }
    assert(failure instanceof assert.AssertionError, `Old84 must fail behavior assertion, not setup: ${failure?.stack || "unexpected pass"}`);
    assert.match(failure.message, /accepted same-page play/); oldRejected++; console.log(`REJECT frozen84 ${test.name} (0 native calls)`);
  } catch (error) { failed++; console.error(error.stack); }
}
if (!process.argv.includes("--legacy-only")) for (const mutation of mutations) {
  try {
    const changed = mutation.change(source); assert.notEqual(changed, source, "Mutation must change real production source");
    const scenario = tests.find(test => test.name === mutation.testName); assert(scenario, `Missing mutation scenario: ${mutation.testName}`);
    let failure; try { await scenario.run(changed); } catch (error) { failure = error; }
    assert(failure instanceof assert.AssertionError, `Mutation must fail behavior assertion, not setup: ${failure?.stack || "unexpected pass"}`);
    mutantsRejected++; console.log(`REJECT mutation ${mutation.name}`);
  } catch (error) { failed++; console.error(`FAIL mutation ${mutation.name}\n${error.stack}`); }
}
const verification = JSON.parse(read("package.json")).scripts["verify:android-client"];
assert(verification.includes("node tools/verify_android_media_playback.mjs && node tools/verify_android_media_play_intent.mjs &&"), "Permanent verifier must follow media playback in Android verification chain");
console.log(`Media play intent: ${passed}/${tests.length} current; ${oldRejected}/6 frozen84 safety assertions; ${mutantsRejected}/${mutations.length} behavior mutants; ${failed} failures.`);
console.log(`channel SHA256 ${createHash("sha256").update(source).digest("hex")}`);
process.exitCode = failed ? 1 : 0;
