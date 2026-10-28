import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fetchJson } from "../android-client/www/js/api.js";
import { captureAccountOwner, isAccountOwnerCurrent } from "../android-client/www/js/account-owner.js";
import { formatBytes, formatNumber, formatTime } from "../android-client/www/js/format.js";
import { absoluteUrl } from "../android-client/www/js/image.js";

// Actual detail entry methods, including their nested cache/fresh renderer,
// compose with the complete video factory and real API/account ownership.
// Detail-data responses, ancillary UI/layout, media and native bridge are
// controlled boundaries; no application service, user media or device is used.
const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const playerSource = read("android-client/www/js/android-player.js").replace(/^import[^\n]*\n/gm, "")
  .replace("export function createAndroidVideoSection", "function createAndroidVideoSection");
const detailSource = read("android-client/www/modules/fanhao/detail-views.js");
function take(name) {
  const start = new RegExp(`^  async function ${name}\\(`, "m").exec(detailSource)?.index;
  assert(start != null, `actual detail entry ${name}`);
  const end = detailSource.indexOf("\n  }", start);
  assert(end > start, `complete detail entry ${name}`);
  return detailSource.slice(start, end + 4);
}
const detailMethods = ["renderWorkDetail", "renderPersonDetail"].map(take).join("\n");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let index = 0; index < 40; index += 1) await Promise.resolve(); };
const work = (id = "work", ids = ["A", "B"]) => ({ id, title: `Work ${id}`, videos: ids.map(id => ({ id, name: id, ext: ".mp4" })) });
const page = (value) => ({ work: value });
const original = { fetch: globalThis.fetch, window: globalThis.window };
let fixtureId = 0, cases = 0;

function fixture({ player = playerSource, details = detailMethods, native = false } = {}) {
  const base = `http://detail-player-${++fixtureId}.fixture.invalid:29998`;
  const reads = [], posts = [], launches = [], detailsReads = [], heroPlays = [], listeners = new Map(), timers = new Map();
  let nextTimer = 0;
  class Element {
    constructor(tag) {
      this.tag = tag; this.children = []; this.parent = null; this.rooted = false; this.events = new Map();
      this.attributes = new Map(); this.style = {}; this.dataset = {}; this.paused = true; this.ended = false;
      this.duration = 120; this.currentTime = 0; this.readyState = 4;
      this.playCalls = 0; this.pauseCalls = 0; this.loadCalls = 0;
    }
    get isConnected() { return this.rooted || Boolean(this.parent?.isConnected); }
    append(...nodes) {
      for (const node of nodes) {
        node.parent?.removeChild(node);
        node.parent = this; this.children.push(node);
      }
    }
    removeChild(node) { this.children = this.children.filter(child => child !== node); node.parent = null; return node; }
    remove() { this.parent?.removeChild(this); }
    set innerHTML(value) { this.html = String(value); for (const child of this.children) child.parent = null; this.children = []; }
    get innerHTML() { return this.html || ""; }
    replaceChildren(...nodes) { this.innerHTML = ""; this.append(...nodes); }
    addEventListener(name, callback, options = {}) {
      const values = this.events.get(name) || []; values.push({ callback, once: options.once === true }); this.events.set(name, values);
    }
    removeEventListener(name, callback) { this.events.set(name, (this.events.get(name) || []).filter(entry => entry.callback !== callback)); }
    emit(name) {
      for (const entry of [...(this.events.get(name) || [])]) {
        if (entry.once) this.removeEventListener(name, entry.callback);
        entry.callback({ type: name, target: this, currentTarget: this });
      }
    }
    set src(value) { this.attributes.set("src", String(value)); }
    get src() { return this.attributes.get("src") || ""; }
    get currentSrc() { return this.src; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    querySelectorAll(selector) {
      const match = node => selector.split(",").some(part => part.trim().startsWith(".")
        ? String(node.className || "").split(" ").includes(part.trim().slice(1)) : node.tag === part.trim());
      return this.children.flatMap(child => [...(match(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    pause() { this.pauseCalls += 1; const changed = !this.paused; this.paused = true; if (changed) this.emit("pause"); }
    play() { this.playCalls += 1; this.paused = false; this.emit("play"); return Promise.resolve(); }
    load() { this.loadCalls += 1; }
  }
  const document = { createElement: tag => new Element(tag), body: new Element("body") };
  document.body.rooted = true;
  const window = globalThis.window = {
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    addEventListener(name, callback) { const values = listeners.get(name) || []; values.push(callback); listeners.set(name, values); },
    Capacitor: native ? { Plugins: { FanHaoPlayer: { async play(payload) { launches.push(payload); } } } } : undefined
  };
  globalThis.fetch = (url, options = {}) => {
    assert(new URL(url).hostname.endsWith(".fixture.invalid"), "fixture must never access a real host");
    if (options.method === "POST") {
      posts.push({ url, options });
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) });
    }
    const request = { url, options, ...deferred() }; reads.push(request); return request.promise;
  };
  const playerContext = vm.createContext({ window, document, fetchJson, captureAccountOwner, isAccountOwnerCurrent,
    formatBytes, formatNumber, formatTime, absoluteUrl, URL, URLSearchParams, AbortController, Date, Promise,
    createDetailSectionTitle: () => new Element("div"), revealDetailBlock() {} });
  const factory = vm.runInContext(player + "\ncreateAndroidVideoSection;", playerContext);
  const videoSection = factory({ getActiveUrl: () => base });
  const ui = () => new Element("div");
  const detailContext = vm.createContext({
    videoSection, workMove: { detach() {}, attach: async () => {} }, setActiveBottom() {},
    els: { viewContent: document.body, viewKicker: {}, viewTitle: {}, viewMeta: {} },
    extractWorkCode: () => "", cacheAgeText: () => "", setDetailChromeTitle() {}, workPersonName: () => "",
    createWorkDetailHero(value, play) { heroPlays.push(play); return ui(); }, createWorkFactPanel: () => null,
    previewMedia: { render: () => null }, infoSection: { createInlineInfoPanel: () => null },
    createWorkPeoplePanel: () => null, createWorkDetailToolbar: ui, renderMessage() {}, detailErrorMessage: error => error.message,
    workDetailDataService: { load(id, options) { const request = { id, options, ...deferred() }; detailsReads.push(request); return request.promise; } },
    getPersonWorkYear: () => "all", getActiveUrl: () => base, personDetailPath: () => "/fixture-person",
    getWorkListRequestState: () => ({}), getWorksLimit: () => 18, findPersonInLibrary: () => null,
    pageDataService: { load(url, path, options) { const request = { url, path, options, ...deferred() }; detailsReads.push(request); return request.promise; } }
  });
  vm.runInContext(details + "\nthis.detailEntries = { renderWorkDetail, renderPersonDetail };", detailContext);
  const guard = () => {
    const controller = new AbortController();
    const active = () => !controller.signal.aborted;
    active.signal = controller.signal;
    return { controller, active };
  };
  const reply = async index => {
    const id = decodeURIComponent(new URL(reads[index].url).pathname.split("/").at(-1));
    reads[index].resolve({ ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ mode: "direct", streamUrl: `/media/video/${id}`, duration: 120 }) });
    await flush();
  };
  const cacheDetail = (value = work()) => {
    const route = guard();
    const pending = detailContext.detailEntries.renderWorkDetail(value.id, route.active);
    const request = detailsReads.at(-1);
    request.options.onCached(page(value), { updatedAt: 1 });
    return { ...route, pending, request, value, section: document.body.querySelector(".android-player-mount")?.parent,
      play: heroPlays.at(-1) };
  };
  return { reads, posts, launches, detailsReads, heroPlays, videoSection, document, entries: detailContext.detailEntries,
    guard, reply, cacheDetail, media: () => document.body.querySelector("video"),
    async fresh(route, value, unchanged = false) { route.request.resolve({ data: page(value), unchanged }); await route.pending; await flush(); },
    cleanup() { videoSection.deactivate(); timers.clear(); }
  };
}

async function verify({ player = playerSource, details = detailMethods, only = "" } = {}) {
  async function test(name, run, options = {}) {
    if (only && name !== only) return;
    const f = fixture({ player, details, ...options });
    try { await run(f); cases += 1; }
    finally { f.cleanup(); await flush(); }
  }
  for (const entry of ["renderWorkDetail", "renderPersonDetail"]) {
    await test(`${entry} releases previous fallback`, async f => {
      const value = work("old");
      const section = f.videoSection.createVideoList(value); f.document.body.append(section);
      const playing = f.videoSection.playDefaultVideo(section, value); await f.reply(0); await playing;
      const old = f.media(); old.currentTime = 17;
      const pending = f.entries[entry]("next");
      assert(old.paused && old.src === "" && old.loadCalls === 1, "detail entry must retire the old fallback before clearing DOM");
      assert.equal(f.posts.length, 1, "still-owned old position is flushed before detail DOM replacement");
      f.detailsReads.at(-1).resolve(null); await pending;
    });
  }
  await test("same-work fresh detail preserves pending play", async f => {
    const route = f.cacheDetail(); const playing = route.play(); await flush();
    const oldSection = route.section;
    await f.fresh(route, { ...route.value, title: "Fresh title" });
    assert.equal(f.document.body.querySelector(".android-player-mount").parent, oldSection, "fresh same-work detail must keep the pending playback section");
    assert.equal(f.reads[0].options.signal.aborted, false, "fresh same-work detail must keep its explicit pending play intent");
    await f.reply(0); assert.equal(await playing, true);
    assert.equal(f.launches.length, 1); assert.equal(f.launches[0].videoId, "A");
  }, { native: true });
  for (const paused of [false, true]) {
    await test(`same-work fresh detail preserves Web node paused=${paused}`, async f => {
      const route = f.cacheDetail(); const playing = route.play(); await f.reply(0); await playing;
      const old = f.media(); old.currentTime = 37.5; if (paused) old.pause();
      const pauses = old.pauseCalls, loads = old.loadCalls, plays = old.playCalls, reports = f.posts.length;
      await f.fresh(route, { ...route.value, title: "Fresh title" });
      assert.equal(f.media(), old, "fresh same-work detail must retain the actual playing video node");
      assert.equal(old.currentTime, 37.5); assert.equal(old.paused, paused);
      assert.equal(old.pauseCalls, pauses); assert.equal(old.loadCalls, loads); assert.equal(old.playCalls, plays);
      assert.equal(f.posts.length, reports, "metadata refresh must not force an extra progress write");
    });
  }
  await test("fresh default changes only after another explicit play", async f => {
    const route = f.cacheDetail(); const playing = route.play(); await f.reply(0); await playing;
    const old = f.media(); old.currentTime = 23;
    const fresh = work(); fresh.videos[1].progress = { percent: 20, position: 24, duration: 120 };
    await f.fresh(route, fresh);
    assert.equal(f.media(), old, "new metadata's default selection must not interrupt the current explicit video");
    assert.equal(old.currentTime, 23); assert.equal(old.pauseCalls, 0); assert.equal(f.reads.length, 1);
    const next = f.heroPlays.at(-1)(); await flush();
    assert.equal(new URL(f.reads[1].url).pathname, "/api/playinfo/B", "fresh hero must use the refreshed default on a new explicit play");
    assert(old.paused && old.src === "" && old.loadCalls === 1);
    await f.reply(1); assert.equal(await next, true); assert.notEqual(f.media(), old);
  });
  for (const native of [false, true]) {
    await test(`removed selected video cancels playback native=${native}`, async f => {
      const route = f.cacheDetail(); const playing = route.play(); await flush();
      let old = null;
      if (!native) { await f.reply(0); await playing; old = f.media(); }
      await f.fresh(route, work(route.value.id, ["B"]));
      assert.notEqual(f.document.body.querySelector(".android-player-mount").parent, route.section, "removed selected video must replace the old playback section");
      if (native) { assert(f.reads[0].options.signal.aborted); await f.reply(0); assert.equal(await playing, false); assert.equal(f.launches.length, 0); }
      else { assert(old.paused && old.src === "" && old.loadCalls === 1, "removed selected video must release the previous decoder"); assert.equal(f.media(), null); }
      const count = f.reads.length;
      assert.equal(await route.play(), false, "old detached hero must not reopen a removed video");
      assert.equal(f.reads.length, count);
    }, { native });
  }
  await test("different-work result cancels pending playback", async f => {
    const route = f.cacheDetail(); const playing = route.play(); await flush();
    await f.fresh(route, work("different", ["A"]));
    assert(f.reads[0].options.signal.aborted, "another work cannot inherit the previous work's pending read");
    await f.reply(0); assert.equal(await playing, false); assert.equal(f.launches.length, 0);
  }, { native: true });
  await test("detail forwards its real route signal", async f => {
    const route = f.cacheDetail(); const playing = route.play(); await flush();
    route.controller.abort();
    assert(f.reads[0].options.signal.aborted, "the actual detail mount must forward its route signal to playback");
    route.request.resolve(null); await route.pending; await f.reply(0);
    assert.equal(await playing, false); assert.equal(f.launches.length, 0);
  }, { native: true });
  await test("unchanged metadata keeps current playback", async f => {
    const route = f.cacheDetail(); const playing = route.play(); await f.reply(0); await playing;
    const old = f.media(); old.currentTime = 19;
    await f.fresh(route, route.value, true);
    assert.equal(f.media(), old); assert.equal(old.currentTime, 19); assert.equal(old.pauseCalls, 0);
  });
}

try {
  await verify();
  console.log(`Android FanHao player lifecycle: ${cases} actual detail/factory/cache behavior cases passed.`);
  const mutations = [
    ["person entry retirement", detailMethods.replace(/(async function renderPersonDetail[^\n]*\n)    videoSection\.deactivate\(\);/, "$1    /* person retirement removed */"),
      "renderPersonDetail releases previous fallback", /detail entry must retire/],
    ["work entry retirement", detailMethods.replace("videoSection.deactivate();", "/* work retirement removed */"),
      "renderWorkDetail releases previous fallback", /detail entry must retire/],
    ["cache playback handoff", detailMethods.replace("preservePlayback: true", "preservePlayback: false"),
      "same-work fresh detail preserves pending play", /fresh same-work detail must keep the pending playback section/],
    ["detail route signal", detailMethods.replace("isActive, preservePlayback: true", "isActive: () => true, preservePlayback: true"),
      "detail forwards its real route signal", /actual detail mount must forward its route signal/],
    ["prepare before DOM retirement", detailMethods.replace("const playbackSection = videoSection.createVideoList(work, {", 'els.viewContent.innerHTML = "";\n      const playbackSection = videoSection.createVideoList(work, {'),
      "same-work fresh detail preserves pending play", /fresh same-work detail must keep the pending playback section/]
  ];
  for (const [name, details, only, expected] of mutations) {
    assert.notEqual(details, detailMethods, `${name}: actual wiring must change`);
    await assert.rejects(() => verify({ details, only }), expected, `${name}: regression survived`);
  }
  console.log(`Android FanHao player lifecycle: ${mutations.length} behavioral negative controls rejected.`);
} finally {
  globalThis.fetch = original.fetch;
  globalThis.window = original.window;
}
