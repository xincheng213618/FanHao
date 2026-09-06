import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { createNavigationFixtureDocument } from "./fixtures/android-gallery-navigation-harness.mjs";
import { absoluteUrl } from "../android-client/www/js/image.js";
import { formatBytes, formatDate, formatNumber, formatTime } from "../android-client/www/js/format.js";
import { createPlaybackProgressService } from "../src/modules/fanhao/server/playback/playback-progress-service.js";
import { createGalleryMediaService } from "../src/modules/media/server/gallery-media-service.js";
import { routeUserStateApi } from "../src/modules/fanhao/server/user-state/routes.js";

// Full current createChannelViews source executes in a VM. Only browser DOM,
// image/cache/network/Capacitor boundaries are doubles. Server playback and
// gallery services, POST route and server resolver execute against synthetic
// in-memory state; no filesystem media access, server, real database or device.
const sourcePath = new URL("../android-client/www/platform/content-index/channel-views.js", import.meta.url);
const source = fs.readFileSync(sourcePath, "utf8");
const serverSource = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const SOURCE_A = "https://synthetic-a.invalid";
const SOURCE_B = "https://synthetic-b.invalid";
const SPECIAL_ID = "synthetic tv/episode?x=1#片%";
const plain = value => JSON.parse(JSON.stringify(value));
// Actual pre-integration methods frozen from Git HEAD; all four were also
// byte-compared with the pre-fix dirty working source during the read-only probe.
const LEGACY_METHODS = {"openNativeMediaPlayer":"  async function openNativeMediaPlayer(item = {}, streamUrl = \"\", channel = CHANNELS.movie) {\n    const plugin = window.Capacitor?.Plugins?.FanHaoPlayer;\n    if (!plugin?.play || !streamUrl) return false;\n    try {\n      await plugin.play({\n        url: streamUrl,\n        title: mediaDisplayTitle(item, channel),\n        subtitle: mediaDisplaySubtitle(item, channel),\n        mode: \"gallery-media\",\n        videoId: item.id,\n        duration: 0\n      });\n      return true;\n    } catch {\n      return false;\n    }\n  }","createNativePlaySurface":"  function createNativePlaySurface(panel, item = {}, streamUrl = \"\", channel = CHANNELS.movie) {\n    const button = document.createElement(\"button\");\n    button.type = \"button\";\n    button.className = \"media-native-play-surface\";\n    button.setAttribute(\"aria-label\", \"播放\");\n\n    const visual = document.createElement(\"span\");\n    visual.className = \"media-native-play-visual\";\n    visual.textContent = \"\";\n\n    const cover = item.coverUrl ? absoluteUrl(getActiveUrl(), item.coverUrl) : \"\";\n    if (cover) {\n      loadPreviewImage(visual, cover, {\n        cacheBaseUrl: getActiveUrl(),\n        decorate: (img) => {\n          img.className = \"media-native-play-image\";\n        }\n      });\n    }\n\n    const playMark = document.createElement(\"span\");\n    playMark.className = \"media-native-play-mark\";\n    playMark.setAttribute(\"aria-hidden\", \"true\");\n    playMark.textContent = \"▶\";\n\n    const label = document.createElement(\"span\");\n    label.className = \"media-native-play-label\";\n    label.textContent = streamUrl ? \"点击播放\" : \"暂无播放地址\";\n\n    button.append(visual, playMark, label);\n    button.addEventListener(\"click\", async () => {\n      panel.querySelector(\".media-player-error\")?.remove();\n      if (!streamUrl) {\n        panel.append(createMediaPlayerError(\"没有可播放地址。\"));\n        return;\n      }\n      const startedAt = performance.now();\n      button.disabled = true;\n      button.setAttribute(\"aria-busy\", \"true\");\n      label.textContent = \"正在打开\";\n      try {\n        const opened = await openNativeMediaPlayer(item, streamUrl, channel);\n        if (!opened) panel.append(createMediaPlayerError(\"播放器打开失败。\"));\n      } finally {\n        await waitForMinimumOpenTime(startedAt);\n        label.textContent = streamUrl ? \"点击播放\" : \"暂无播放地址\";\n        button.removeAttribute(\"aria-busy\");\n        button.disabled = false;\n      }\n    });\n    return button;\n  }","waitForMinimumOpenTime":"  function waitForMinimumOpenTime(startedAt) {\n    const elapsed = performance.now() - startedAt;\n    const remaining = PLAY_OPEN_COOLDOWN_MS - elapsed;\n    if (remaining <= 0) return Promise.resolve();\n    return new Promise((resolve) => window.setTimeout(resolve, remaining));\n  }","createMediaPlayerError":"  function createMediaPlayerError(message) {\n    const error = document.createElement(\"div\");\n    error.className = \"media-player-error\";\n    error.textContent = message;\n    return error;\n  }"};
const LEGACY_SHA256 = "56881813ca7cee5752b7666bdac4f703d93ed804edaff8f90e316c7997d4fe15";

function method(text, name, indent = "  ") {
  const start = new RegExp(`^${indent}(?:async )?function ${name}\\(`, "m").exec(text);
  assert(start, `Actual function missing: ${name}`);
  const tail = text.slice(start.index), end = new RegExp(`^${indent}\\}`, "m").exec(tail);
  assert(end, `Actual function closing brace missing: ${name}`);
  return tail.slice(0, end.index + indent.length + 1);
}
function legacySource(text = source) {
  let changed = text;
  for (const [name, body] of Object.entries(LEGACY_METHODS)) changed = changed.replace(method(changed, name), () => body);
  assert.notEqual(changed, text, "Legacy control must replace the fixed real methods");
  return changed;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function memoryServer({ kind = "movie", id = SPECIAL_ID, position = 73, duration = 240 } = {}) {
  const item = { id, mediaKind: kind, type: "media", title: "合成影片", sourceRoot: "SYNTHETIC_ONLY", relativePath: "synthetic.mkv", size: 2048,
    exists: true, coverUrl: "/synthetic-cover.jpg", movieMetadata: { title: "合成影片", year: 2024 } };
  const library = { filesById: new Map(), worksById: new Map() };
  const state = { progress: {}, favorites: {} };
  const writes = [];
  const playback = createPlaybackProgressService({ getLibrary: () => library, publicFavoriteFolders: () => [], recentWatchedDays: 7,
    userState: state, userStateService: { save() { writes.push(plain(state)); } } });
  const gallery = createGalleryMediaService({ getImageLibraryIndex: () => ({ mediaItems: [item] }),
    safeChildPath: (_root, relative) => relative, safeStat: () => ({ size: 2048, mtimeMs: 0, isFile: () => true }),
    normalizeExt: () => ".mkv", directVideoExts: new Set([".mkv"]), playbackProgressService: playback,
    publicGalleryMediaItem: value => plain(value) });
  const resolver = vm.createContext({ library, galleryMediaService: gallery });
  vm.runInContext(method(serverSource, "resolvePlayableVideoFile", ""), resolver);
  if (position > 0) state.progress[id] = { position, duration, updatedAt: "2026-08-01T00:00:00.000Z" };
  return {
    item, state, writes,
    detail: () => ({ item: gallery.publicDetail(item) }),
    playInfo: () => ({ mode: "direct", streamUrl: `/media/gallery-video/${encodeURIComponent(id)}`,
      fallbackStreamUrl: `/media/gallery-video/${encodeURIComponent(id)}/transcode?mode=transcode`, duration }),
    async post(position, duration = 240, targetId = id) {
      let response;
      const handled = await routeUserStateApi({ method: "POST" }, {}, new URL(`${SOURCE_A}/api/progress/${encodeURIComponent(targetId)}`), {
        resolvePlayableVideoFile: resolver.resolvePlayableVideoFile, playbackProgressService: playback,
        readJsonBody: async () => ({ position, duration }), sendJson: (_res, status, body) => { response = { status, body }; },
        notFound: () => { response = { status: 404 }; }
      });
      assert.equal(handled, true, "Actual progress route must handle request");
      return response;
    }
  };
}

function harness(input = source, options = {}) {
  const server = memoryServer(options), document = createNavigationFixtureDocument();
  const elementProto = Object.getPrototypeOf(document.body);
  if (!Object.getOwnPropertyDescriptor(elementProto, "isConnected")) Object.defineProperty(elementProto, "isConnected", {
    get() { return this.ownerDocument.body.contains(this); }
  });
  elementProto.remove = function () {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  };
  const calls = { fetch: [], bridge: [], cached: [], errors: [], actions: new Set() };
  const createElement = document.createElement;
  document.createElement = tag => {
    const node = createElement(tag), add = node.addEventListener.bind(node);
    node.addEventListener = (type, callback) => add(type, event => {
      try {
        const result = callback(event);
        if (result?.then) {
          calls.actions.add(result);
          result.catch(error => calls.errors.push(error)).finally(() => calls.actions.delete(result));
        }
        return result;
      } catch (error) { calls.errors.push(error); }
    });
    return node;
  };
  const els = Object.fromEntries(["contentPanel", "viewKicker", "viewTitle", "viewMeta", "viewContent"].map(key => [key, document.createElement("div")]));
  document.body.append(...Object.values(els));
  const controller = new AbortController(), timers = new Map(), queued = { detail: [], playinfo: [] };
  let clockId = 0, activeUrl = SOURCE_A, active = true, now = 0;
  const guard = () => active;
  guard.signal = controller.signal;
  function eventTarget(target) {
    target.listeners ||= new Map();
    target.addEventListener = (type, callback, options = {}) => {
      if (options.signal?.aborted) return;
      if (!target.listeners.has(type)) target.listeners.set(type, []);
      target.listeners.get(type).push(callback);
      options.signal?.addEventListener("abort", () => target.removeEventListener(type, callback), { once: true });
    };
    target.removeEventListener = (type, callback) => target.listeners.set(type, (target.listeners.get(type) || []).filter(value => value !== callback));
    target.dispatchEvent = event => { for (const callback of [...(target.listeners.get(event.type) || [])]) callback(event); };
    return target;
  }
  eventTarget(document);
  document.visibilityState = "visible";
  document.hidden = false;
  const plugin = { async play(payload) { calls.bridge.push(plain(payload)); return { opened: true }; } };
  const c = vm.createContext({ document, console, URL, URLSearchParams, AbortController, performance: { now: () => now },
    window: eventTarget({ Capacitor: { Plugins: { FanHaoPlayer: plugin } },
      setTimeout(callback, delay) { const id = ++clockId; timers.set(id, { callback, delay }); return id; }, clearTimeout(id) { timers.delete(id); } }),
    absoluteUrl, formatBytes, formatDate, formatNumber, formatTime, cacheAgeText: () => "合成缓存",
    isChannelFavorite: () => false, toggleChannelFavorite: () => ({ favorite: true, items: [] }),
    loadPreviewImage: () => {}, enhanceAutoLoadMore: () => {}, photoCatalogCollections: data => data,
    readCachedJson: async () => null,
    writeCachedJson: async (...args) => { calls.cached.push(plain(args)); },
    async fetchJson(base, path, requestOptions = {}) {
      const entry = { base, path, options: requestOptions }; calls.fetch.push(entry);
      assert.equal(base, SOURCE_A, "A displayed source must never fetch from replacement server B");
      const kind = path.startsWith("/api/gallery-media/") ? "detail" : path.startsWith("/api/playinfo/") ? "playinfo" : "unknown";
      assert.notEqual(kind, "unknown", `Unexpected real UI network path: ${path}`);
      const next = queued[kind].shift();
      if (next instanceof Error) throw next;
      if (typeof next === "function") return next(entry);
      if (next !== undefined) return await next;
      return kind === "detail" ? server.detail() : server.playInfo();
    }
  });
  // Imports are replaced only at the module boundary; all production functions,
  // render context propagation, guards and button callbacks remain unmodified.
  vm.runInContext(input.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, ""), c, { filename: "actual-channel-views.js" });
  const api = c.createChannelViews({ els, getActiveUrl: () => activeUrl, getChannelLimit: () => 40, increaseChannelLimit: () => {},
    setActiveBottom: () => {}, openInLibrary: () => {}, renderCurrentView: () => {}, goBack: () => {} });
  const result = {
    c, api, server, calls, els, document, plugin,
    setSource(value) { activeUrl = value; }, leave() { active = false; controller.abort(); els.viewContent.replaceChildren(); },
    async fire(type, { hidden = false } = {}) {
      document.hidden = hidden; document.visibilityState = hidden ? "hidden" : "visible";
      (type === "focus" ? c.window : document).dispatchEvent({ type }); await result.settle();
    },
    queue(kind, value) { queued[kind].push(value); },
    async render() {
      await api.renderMediaDetail(server.item.id, options.kind || "movie", guard); await result.settle();
      assert(result.button(), `Actual initial detail must render before testing playback: ${els.viewContent.textContent} ${els.viewContent.innerHTML}`);
    },
    button() { return els.viewContent.querySelector(".media-native-play-surface"); },
    async settle(rounds = 40) {
      for (let index = 0; index < rounds; index++) {
        await Promise.resolve();
        for (const [id, timer] of [...timers]) if (timers.delete(id)) { now += Number(timer.delay || 0); timer.callback(); }
      }
      assert.equal(calls.errors.length, 0, `Unhandled actual UI error: ${calls.errors[0]?.stack || ""}`);
    },
    async click(selector = "") { const button = result.button(); assert(button, "Actual rendered play surface exists"); (selector ? button.querySelector(selector) : button).click(); await result.settle(); },
    errors() { return els.viewContent.querySelectorAll(".media-player-error"); },
    count(kind) { return calls.fetch.filter(call => call.path.startsWith(kind === "detail" ? "/api/gallery-media/" : "/api/playinfo/")).length; }
  };
  return result;
}

const tests = [];
const test = (name, run) => tests.push({ name, run });
for (const kind of ["movie", "tv", "media"]) test(`${kind}: native payload binds encoded ID, source and fresh progress`, async input => {
  const h = harness(input, { kind }); await h.render(); await h.click();
  assert.equal(h.calls.bridge.length, 1); const payload = h.calls.bridge[0];
  assert.equal(payload.url, `${SOURCE_A}/media/gallery-video/${encodeURIComponent(SPECIAL_ID)}`);
  assert.equal(payload.progressUrl, `${SOURCE_A}/api/progress/${encodeURIComponent(SPECIAL_ID)}`);
  assert.equal(payload.videoId, SPECIAL_ID); assert.equal(payload.mode, "gallery-media");
  assert.equal(payload.position, 73); assert.equal(payload.duration, 240); assert.equal(Object.hasOwn(payload, "workId"), false);
  assert.equal(h.count("detail"), 2, "Playback must refresh the detail, not reuse its rendered snapshot");
  const probe = h.calls.fetch.find(call => call.path.startsWith("/api/playinfo/"));
  assert(probe); assert.equal(probe.path, `/api/playinfo/${encodeURIComponent(SPECIAL_ID)}?source=gallery`);
  assert.equal(payload.fallbackUrl, `${SOURCE_A}/media/gallery-video/${encodeURIComponent(SPECIAL_ID)}/transcode?mode=transcode`);
  assert.equal(new URL(payload.fallbackUrl).searchParams.has("t"), false, "Native owns timeline fallback offset");
});
test("cover, play mark and label bubble to the same actual playback callback", async input => {
  const h = harness(input); await h.render();
  for (const selector of [".media-native-play-visual", ".media-native-play-mark", ".media-native-play-label"]) await h.click(selector);
  assert.equal(h.calls.bridge.length, 3);
  const payloads = h.calls.bridge.map(({ progressSessionId, ...payload }) => {
    assert.equal(typeof progressSessionId, "string");
    assert(progressSessionId.length > 0, "Each explicit play has a receipt identity");
    return payload;
  });
  assert.equal(new Set(h.calls.bridge.map(payload => payload.progressSessionId)).size, 3, "Separate clicks must not share a receipt identity");
  assert.deepEqual(payloads[0], payloads[1]); assert.deepEqual(payloads[1], payloads[2]);
});
test("same mounted detail rereads server progress before a second launch", async input => {
  const h = harness(input); await h.render(); await h.click();
  const saved = await h.server.post(125, 240); assert.equal(saved.status, 200);
  await h.click(); assert.equal(h.calls.bridge.length, 2); assert.equal(h.calls.bridge[0].position, 73); assert.equal(h.calls.bridge[1].position, 125);
  assert.equal(h.count("detail"), 3); assert.match(h.button().textContent, /继续播放/);
});
test("probe duration takes precedence; invalid probe duration uses stored progress duration", async input => {
  const h = harness(input); await h.render(); h.queue("playinfo", { ...h.server.playInfo(), duration: 300 }); await h.click();
  assert.equal(h.calls.bridge[0].duration, 300);
  h.queue("playinfo", { ...h.server.playInfo(), duration: 0 }); await h.click(); assert.equal(h.calls.bridge[1].duration, 240);
});
test("optional playinfo failure keeps fresh direct stream and progress", async input => {
  const h = harness(input); await h.render(); h.queue("playinfo", new Error("synthetic probe unavailable")); await h.click();
  assert.equal(h.calls.bridge.length, 1); assert.equal(h.calls.bridge[0].position, 73); assert.equal(h.calls.bridge[0].duration, 240);
  assert.equal(h.calls.bridge[0].url, `${SOURCE_A}/media/gallery-video/${encodeURIComponent(SPECIAL_ID)}`);
  assert.equal(h.errors().length, 0);
});
test("fresh detail failure is visible and retry performs a new read", async input => {
  const h = harness(input); await h.render(); h.queue("detail", new Error("合成详情暂不可读")); await h.click();
  assert.equal(h.calls.bridge.length, 0); assert.equal(h.errors().length, 1); assert.equal(h.button().disabled, false);
  assert.match(h.errors()[0].textContent, /合成详情暂不可读|读取|播放/);
  await h.click(); assert.equal(h.calls.bridge.length, 1); assert.equal(h.errors().length, 0);
});
test("fresh mismatched identity cannot launch a different video", async input => {
  const h = harness(input); await h.render(); h.queue("detail", { item: { ...h.server.detail().item, id: "different-synthetic-id" } }); await h.click();
  assert.equal(h.calls.bridge.length, 0); assert.equal(h.errors().length, 1); assert.equal(h.button().disabled, false);
});
for (const [label, fields] of [["missing file", { exists: false }], ["empty stream", { streamUrl: "" }]]) test(`${label}: no native launch and explicit retryable error`, async input => {
  const h = harness(input); await h.render(); h.queue("detail", { item: { ...h.server.detail().item, ...fields } }); await h.click();
  assert.equal(h.calls.bridge.length, 0); assert.equal(h.errors().length, 1); assert.equal(h.button().disabled, false);
});
test("bridge rejection releases busy and permits one explicit retry", async input => {
  const h = harness(input); await h.render(); const accepted = h.plugin.play;
  let attempts = 0; h.plugin.play = async () => { attempts++; throw new Error("synthetic bridge launch failed"); }; await h.click();
  assert.equal(attempts, 1); assert.equal(h.errors().length, 1); assert.equal(h.button().disabled, false);
  h.plugin.play = accepted; await h.click(); assert.equal(h.calls.bridge.length, 1); assert.equal(h.errors().length, 0);
});
test("missing bridge reports inability to play without pretending Web fallback exists", async input => {
  const h = harness(input); await h.render(); delete h.c.window.Capacitor; await h.click();
  assert.equal(h.calls.bridge.length, 0); assert.equal(h.errors().length, 1); assert.equal(h.button().disabled, false);
  assert.equal(h.els.viewContent.querySelectorAll("video").length, 0);
});
test("programmatic double click while detail is pending starts only one operation", async input => {
  const h = harness(input); await h.render(); const read = deferred(); h.queue("detail", read.promise);
  await h.click(); assert.equal(h.button().disabled, true); await h.click(); assert.equal(h.count("detail"), 2);
  read.resolve(h.server.detail()); await h.settle(); assert.equal(h.calls.bridge.length, 1); assert.equal(h.button().disabled, false);
});
for (const phase of ["detail", "playinfo"]) test(`source switch during ${phase} prevents stale launch and never requests B`, async input => {
  const h = harness(input); await h.render(); const pending = deferred(); h.queue(phase, pending.promise); await h.click();
  h.setSource(SOURCE_B); pending.resolve(phase === "detail" ? h.server.detail() : h.server.playInfo()); await h.settle();
  assert.equal(h.calls.bridge.length, 0); assert(h.calls.fetch.every(call => call.base === SOURCE_A)); assert.equal(h.errors().length, 0);
});
test("source changed before clicking an old retained surface does not launch or fetch B", async input => {
  const h = harness(input); await h.render(); h.setSource(SOURCE_B); await h.click();
  assert.equal(h.calls.bridge.length, 0); assert(h.calls.fetch.every(call => call.base === SOURCE_A));
});
test("leaving the detail while its playback read is pending cannot launch", async input => {
  const h = harness(input); await h.render(); const pending = deferred(); h.queue("detail", pending.promise); await h.click();
  h.leave(); pending.resolve(h.server.detail()); await h.settle(); assert.equal(h.calls.bridge.length, 0); assert.equal(h.els.viewContent.children.length, 0);
});
test("actual server POST stores per-video in-memory progress and detail exposes it", async () => {
  for (const [index, kind] of ["movie", "tv", "media"].entries()) {
    const server = memoryServer({ kind, id: `synthetic-${kind}`, position: 0 });
    const response = await server.post(73 + index, 240); assert.equal(response.status, 200);
    assert.equal(response.body.progress.workId, null); assert.equal(server.writes.length, 1);
    assert.equal(server.detail().item.progress.position, 73 + index); assert.equal(server.detail().item.videos[0].progress.position, 73 + index);
    assert.equal((await server.post(90, 240, "unknown-synthetic-video")).status, 404); assert.equal(server.writes.length, 1);
  }
});
test("resume boundary starts over for tiny, completed and invalid positions", async input => {
  const h = harness(input); assert.equal(typeof h.c.mediaResumePosition, "function", "Actual exported resume policy exists");
  for (const [progress, expected] of [[{ position: 73, duration: 240 }, 73], [{ position: 5, duration: 240 }, 0],
    [{ position: 232, duration: 240 }, 0], [{ position: 999, duration: 240 }, 0], [{ position: -5, duration: 240 }, 0],
    [{ position: NaN, duration: 240 }, 0], [{ position: Infinity, duration: 240 }, 0], [null, 0]]) {
    assert.equal(h.c.mediaResumePosition(progress), expected, JSON.stringify(progress));
  }
});
test("focus on a retained visible detail refreshes its progress label without opening player", async input => {
  const h = harness(input); await h.render(); assert.equal(h.button().querySelector(".media-native-play-label").textContent, "继续播放 · 1:13");
  await h.server.post(125, 240); await h.fire("focus");
  assert.equal(h.count("detail"), 2); assert.equal(h.calls.bridge.length, 0);
  assert.equal(h.button().querySelector(".media-native-play-label").textContent, "继续播放 · 2:05");
  assert.equal(h.button().getAttribute("aria-label"), "继续播放 · 2:05");
});
test("hidden visibility event does not refresh and visible event coalesces duplicate notifications", async input => {
  const h = harness(input); await h.render(); await h.fire("visibilitychange", { hidden: true }); assert.equal(h.count("detail"), 1);
  const pending = deferred(); h.queue("detail", pending.promise); await h.fire("visibilitychange"); await h.fire("focus");
  assert.equal(h.count("detail"), 2); pending.resolve(h.server.detail()); await h.settle(); assert.equal(h.calls.bridge.length, 0);
});
test("visibility refresh cannot join an in-flight explicit playback operation", async input => {
  const h = harness(input); await h.render(); const pending = deferred(); h.queue("detail", pending.promise); await h.click();
  await h.fire("focus"); await h.fire("visibilitychange"); assert.equal(h.count("detail"), 2);
  pending.resolve(h.server.detail()); await h.settle(); assert.equal(h.calls.bridge.length, 1);
});
test("late visibility refresh cannot overwrite a newer explicit playback snapshot", async input => {
  const h = harness(input); await h.render(); const older = h.server.detail(), pending = deferred();
  h.queue("detail", pending.promise); await h.fire("focus"); await h.server.post(125, 240); await h.click();
  assert.equal(h.calls.bridge[0].position, 125); assert.equal(h.button().querySelector(".media-native-play-label").textContent, "继续播放 · 2:05");
  pending.resolve(older); await h.settle();
  assert.equal(h.button().querySelector(".media-native-play-label").textContent, "继续播放 · 2:05", "Older refresh must not replace a newer prepared snapshot");
});
test("aborting the view removes focus and visibility listeners and suppresses a late refresh", async input => {
  const h = harness(input); await h.render(); const button = h.button(), label = button.textContent, pending = deferred();
  h.queue("detail", pending.promise); await h.fire("focus"); h.leave();
  assert.equal(h.document.listeners.get("visibilitychange")?.length || 0, 0); assert.equal(h.c.window.listeners.get("focus")?.length || 0, 0);
  await h.fire("focus"); assert.equal(h.count("detail"), 2);
  pending.resolve({ item: { ...h.server.detail().item, progress: { position: 150, duration: 240 } } }); await h.settle();
  assert.equal(button.textContent, label); assert.equal(h.calls.bridge.length, 0);
});
test("failed or foreign-identity passive refresh preserves the current label and remains retryable", async input => {
  const h = harness(input); await h.render(); const label = h.button().textContent;
  h.queue("detail", new Error("synthetic refresh failure")); await h.fire("focus"); assert.equal(h.button().textContent, label);
  h.queue("detail", { item: { ...h.server.detail().item, id: "foreign", progress: { position: 125, duration: 240 } } });
  await h.fire("focus"); assert.equal(h.button().textContent, label); assert.equal(h.errors().length, 0);
  await h.server.post(125, 240); await h.fire("focus"); assert.match(h.button().textContent, /2:05/); assert.equal(h.calls.bridge.length, 0);
});
test("native opened:false is a failed launch, not silent success", async input => {
  const h = harness(input); await h.render(); h.plugin.play = async () => ({ opened: false }); await h.click();
  assert.equal(h.errors().length, 1); assert.equal(h.button().disabled, false);
});
test("unsafe fresh stream cannot open another origin or a credential-bearing address", async input => {
  for (const streamUrl of ["https://foreign.invalid/movie.mkv", "https://user:password@synthetic-a.invalid/movie.mkv", "http://synthetic-a.invalid/movie.mkv"]) {
    const h = harness(input); await h.render(); h.queue("detail", { item: { ...h.server.detail().item, streamUrl } }); await h.click();
    assert.equal(h.calls.bridge.length, 0); assert.equal(h.errors().length, 1);
  }
});
test("untrusted optional fallback is discarded while valid direct playback remains usable", async input => {
  const h = harness(input); await h.render(); h.queue("playinfo", { ...h.server.playInfo(), fallbackStreamUrl: "https://foreign.invalid/transcode" }); await h.click();
  assert.equal(h.calls.bridge.length, 1); assert.equal(h.calls.bridge[0].fallbackUrl, ""); assert.equal(h.calls.bridge[0].position, 73);
});
test("non-direct playinfo fallback retains its gallery path and adds no seek query", async input => {
  const h = harness(input); await h.render(); h.queue("playinfo", { mode: "remux", streamUrl: `/media/gallery-video/${encodeURIComponent(SPECIAL_ID)}/transcode?mode=remux`, duration: 240 });
  await h.click(); assert.equal(h.calls.bridge.length, 1);
  assert.equal(h.calls.bridge[0].fallbackUrl, `${SOURCE_A}/media/gallery-video/${encodeURIComponent(SPECIAL_ID)}/transcode?mode=remux`);
  assert.equal(new URL(h.calls.bridge[0].fallbackUrl).searchParams.has("t"), false);
});
test("rendered empty stream is explicit and does not dispatch a playback read", async input => {
  const h = harness(input); h.queue("detail", { item: { ...h.server.detail().item, streamUrl: "" } }); await h.render(); await h.click();
  assert.equal(h.calls.bridge.length, 0); assert.equal(h.count("detail"), 1); assert.equal(h.errors().length, 1); assert.equal(Boolean(h.button().disabled), false);
});

function replaceExactly(text, old, next) {
  assert.equal(text.split(old).length - 1, 1, `Mutation requires one actual source target: ${old}`);
  return text.replace(old, next);
}
const mutations = [
  { name: "progress URL omitted", target: "movie:", from: "        progressUrl: absoluteUrl(sourceUrl, `/api/progress/${encodeURIComponent(id)}`),", to: "" },
  { name: "playinfo loses explicit gallery source", target: "movie:", from: "`/api/playinfo/${encodeURIComponent(id)}?source=gallery`", to: "`/api/playinfo/${encodeURIComponent(id)}`" },
  { name: "fresh detail identity validation removed", target: "fresh mismatched", from: 'if (String(fresh?.id || "") !== id)', to: 'if (false && String(fresh?.id || "") !== id)' },
  { name: "post-await navigation/source guard removed", target: "source switch during detail", from: "    if (!isActive() || playbackContext.signal?.aborted || getActiveUrl() !== sourceUrl) return false;", to: "" },
  { name: "pending operation can double dispatch", target: "programmatic double", from: "if (button.disabled || !isActive()) return;", to: "if (!isActive()) return;" },
  { name: "stream URL origin check removed", target: "unsafe fresh", from: " && url.origin === source.origin", to: "" },
  { name: "launch reuses old rendered progress", target: "same mounted", from: "fetchJson(sourceUrl, mediaDetailPath(id), request)", to: "Promise.resolve({ item })" },
  { name: "native opened false treated as success", target: "native opened:false", from: "return result?.opened !== false;", to: "return true;" },
  { name: "focus listener no longer belongs to view lifetime", target: "aborting the view", from: 'window.addEventListener("focus", refreshProgress, { signal: playbackContext.signal });', to: 'window.addEventListener("focus", refreshProgress);' },
  { name: "late passive refresh ignores explicit playback revision", target: "late visibility refresh", from: "revision === progressRevision && isActive()", to: "isActive()" }
];
let passed = 0, failed = 0, rejected = 0, mutantsRejected = 0;
for (const item of tests) {
  try { await item.run(source); passed++; console.log(`PASS ${item.name}`); }
  catch (error) { failed++; console.error(`FAIL ${item.name}\n${error.stack}`); }
}
if (LEGACY_METHODS && !failed) {
  assert.equal(createHash("sha256").update(JSON.stringify(LEGACY_METHODS)).digest("hex"), LEGACY_SHA256, "Frozen actual old-method fixture hash");
  const before = legacySource();
  for (const target of ["movie:", "same mounted", "fresh detail failure", "fresh mismatched", "programmatic double", "source switch during detail"]) {
    try {
      let failure;
      try { await tests.find(item => item.name.startsWith(target)).run(before); } catch (error) { failure = error; }
      assert(failure instanceof assert.AssertionError, `Legacy must fail a safety assertion, not runtime setup: ${target}: ${failure?.stack || "unexpected pass"}`);
      rejected++; console.log(`REJECT legacy ${target}`);
    } catch (error) { failed++; console.error(`FAIL legacy ${target}\n${error.stack}`); }
  }
}
if (!failed) for (const mutation of mutations) {
  try {
    const changed = replaceExactly(source, mutation.from, mutation.to); let failure;
    try { await tests.find(item => item.name.startsWith(mutation.target)).run(changed); } catch (error) { failure = error; }
    assert(failure instanceof assert.AssertionError, `Mutant must fail an assertion, not runtime setup: ${mutation.name}: ${failure?.stack || "unexpected pass"}`);
    mutantsRejected++; console.log(`REJECT mutant ${mutation.name}`);
  } catch (error) { failed++; console.error(`FAIL mutant ${mutation.name}\n${error.stack}`); }
}
console.log(`Media playback: ${passed}/${tests.length} scenarios; ${rejected}/6 actual legacy controls; ${mutantsRejected}/${mutations.length} wiring mutants; ${failed} failures.`);
console.log(`Current channel-views SHA256: ${createHash("sha256").update(source).digest("hex")}`);
process.exitCode = failed ? 1 : 0;
