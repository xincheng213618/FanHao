import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fetchJson } from "../android-client/www/js/api.js";
import { captureAccountOwner, isAccountOwnerCurrent, setAccountOwner } from "../android-client/www/js/account-owner.js";
import { formatBytes, formatNumber, formatTime } from "../android-client/www/js/format.js";

// Execute the entire current factory and its actual generated controls, with
// real API/account ownership. DOM/layout, media, HTTP, clock and native bridge
// are controlled boundaries; there is no service, device or user media access.
const source = fs.readFileSync(new URL("../android-client/www/js/android-player.js", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n").replace(/^import[^\n]*\n/gm, "")
  .replace("export function createAndroidVideoSection", "function createAndroidVideoSection");
const original = { fetch: globalThis.fetch, window: globalThis.window };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let turn = 0; turn < 40; turn += 1) await Promise.resolve(); };
const direct = (id, extra = {}) => ({ mode: "direct", streamUrl: `/stream/${id}.mp4`, fallbackStreamUrl: `/compat/${id}`, duration: 120, videoCodec: "h264", audioCodec: "aac", ...extra });
let fixtureId = 0, cases = 0, selectedCase = "";

function fixture({ code = source, native = "success", work: givenWork } = {}) {
  const sequence = ++fixtureId;
  let base = `http://player-${sequence}.fixture.invalid:29998`, nextNode = 0, nextTimer = 0;
  let now = 1710000000000;
  class FixtureDate extends Date { static now() { return now; } }
  const nodes = [], writes = [], reads = [], posts = [], launches = [], timers = new Map(), listeners = new Map();
  const work = givenWork || { id: `work-${sequence}`, title: "Fixture work", videos: [{ id: "A", name: "A", ext: ".mp4" }, { id: "B", name: "B", ext: ".mp4" }] };
  let playBehavior = () => Promise.resolve();
  const log = (node, kind, value) => writes.push([node.id, kind, String(value ?? "")]);
  const matches = (node, selector) => selector.split(",").some(part => {
    part = part.trim();
    return part.startsWith(".") ? String(node.className || "").split(" ").includes(part.slice(1)) : node.tag === part;
  });
  class Element {
    constructor(tag) {
      this.tag = tag; this.id = ++nextNode; this.children = []; this.events = new Map(); this.attributes = new Map(); this.parent = null;
      this.rooted = false; this.dataset = {}; this.style = {}; this.paused = true; this.ended = false; this.duration = 120; this.readyState = 4;
      this.currentTime = 0; this.playCalls = 0; this.pauseCalls = 0; this.loadCalls = 0; nodes.push(this);
    }
    get isConnected() { return this.rooted || Boolean(this.parent?.isConnected); }
    get parentNode() { return this.parent; }
    get parentElement() { return this.parent; }
    get firstChild() { return this.children[0] || null; }
    get childElementCount() { return this.children.length; }
    append(...items) { for (const child of items) { if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child); child.parent = this; this.children.push(child); } log(this, "append", items.map(item => item.id).join(",")); }
    appendChild(child) { this.append(child); return child; }
    replaceChildren(...items) { for (const child of this.children) child.parent = null; this.children = []; this.append(...items); }
    removeChild(child) { this.children = this.children.filter(item => item !== child); child.parent = null; log(this, "removeChild", child.id); return child; }
    remove() { if (this.parent) this.parent.removeChild(this); }
    get innerHTML() { return this.html || ""; }
    set innerHTML(value) { for (const child of this.children) child.parent = null; this.children = []; this.html = String(value); log(this, "html", value); }
    get textContent() { return this.text || ""; }
    set textContent(value) { this.text = String(value); log(this, "text", value); }
    get src() { return this.attributes.get("src") || ""; }
    set src(value) { this.attributes.set("src", String(value)); log(this, "src", value); }
    get currentSrc() { return this.src; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); log(this, `attribute:${name}`, value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); log(this, `removeAttribute:${name}`, ""); }
    addEventListener(name, callback, options = {}) { const entries = this.events.get(name) || []; entries.push({ callback, once: options.once === true }); this.events.set(name, entries); }
    removeEventListener(name, callback) { this.events.set(name, (this.events.get(name) || []).filter(entry => entry.callback !== callback)); }
    emit(name) { for (const entry of [...(this.events.get(name) || [])]) { if (entry.once) this.removeEventListener(name, entry.callback); entry.callback({ type: name, target: this, currentTarget: this }); } }
    click() { this.emit("click"); }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    contains(candidate) { return this === candidate || this.children.some(child => child.contains(candidate)); }
    closest(selector) { return matches(this, selector) ? this : this.parent?.closest(selector) || null; }
    pause() { this.pauseCalls += 1; const changed = !this.paused; this.paused = true; if (changed) this.emit("pause"); }
    play() { this.playCalls += 1; this.paused = false; this.emit("play"); return playBehavior(this); }
    load() { this.loadCalls += 1; }
    requestFullscreen() { document.fullscreenElement = this; return Promise.resolve(); }
  }
  const document = { createElement: tag => new Element(tag), body: new Element("body"), fullscreenElement: null,
    addEventListener(name, callback) { const values = listeners.get(name) || []; values.push(callback); listeners.set(name, values); },
    removeEventListener(name, callback) { listeners.set(name, (listeners.get(name) || []).filter(value => value !== callback)); },
    querySelector: selector => document.body.querySelector(selector), querySelectorAll: selector => document.body.querySelectorAll(selector) };
  document.body.rooted = true;
  const window = globalThis.window = {
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener: document.addEventListener, removeEventListener: document.removeEventListener,
    Capacitor: native === false ? undefined : { Plugins: { FanHaoPlayer: { play(payload) {
      const call = { payload, ...deferred() }; launches.push(call);
      if (native === "success") call.resolve({});
      if (native === "reject") call.reject(new Error("Native unavailable"));
      return call.promise;
    } } } }
  };
  globalThis.fetch = (url, options = {}) => {
    assert.equal(new URL(url).hostname.endsWith(".fixture.invalid"), true, "fixture never requests a real host");
    if (options.method === "POST") { posts.push({ url, options }); return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) }); }
    const call = { url, options, ...deferred() }; reads.push(call); return call.promise;
  };
  const sandbox = vm.createContext({ window, document, fetchJson, captureAccountOwner, isAccountOwnerCurrent,
    formatBytes, formatNumber, formatTime, URL, URLSearchParams, AbortController, Date: FixtureDate, Promise,
    setTimeout: window.setTimeout, clearTimeout: window.clearTimeout,
    absoluteUrl: (base, relative) => new URL(relative, base).href,
    createDetailSectionTitle: () => new Element("div"), revealDetailBlock(mount) { writes.push([mount.id, "reveal", ""]); } });
  const create = vm.runInContext(code + "\ncreateAndroidVideoSection;", sandbox);
  const view = create({ getActiveUrl: () => base });
  const attach = (value = work, options) => { const section = view.createVideoList(value, options); document.body.append(section); return section; };
  const section = attach(), mount = section.querySelector(".android-player-mount"), buttons = section.querySelectorAll("button");
  const reply = async (index, payload = direct(new URL(reads[index].url).pathname.split("/").at(-1)), status = 200) => {
    reads[index].resolve({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => payload }); await flush();
  };
  const fail = async (index, message = "late read failure") => { reads[index].reject(new Error(message)); await flush(); };
  const snapshot = () => ({ writes: writes.length, posts: posts.length, reads: reads.length, launches: launches.length });
  return { view, work, section, mount, buttons, reads, posts, launches, nodes, writes, timers, document, attach, reply, fail, snapshot,
    base: () => base, setBase(value) { base = value; }, setPlayBehavior(value) { playBehavior = value; },
    advanceTime(milliseconds) { now += milliseconds; },
    media: () => mount.querySelector("video"), status: () => mount.querySelector(".player-status"),
    fire(name) { for (const callback of listeners.get(name) || []) callback({ type: name }); },
    pendingTimer(delay) { return [...timers.values()].find(timer => timer.delay === delay)?.callback; },
    runTimers(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); } },
    cleanup() { view.deactivate?.(); timers.clear(); }
  };
}

async function test(name, body, options = {}) {
  if (selectedCase && name !== selectedCase) return;
  const f = fixture(options);
  try { await body(f); cases += 1; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
  finally { f.cleanup(); }
}

async function verify(code = source) {
  const options = value => ({ code, ...value });
  await test("latest click owns native launch", async f => {
    f.buttons[0].click(); f.buttons[1].click();
    assert.equal(f.reads.length, 2);
    assert.equal(f.reads[0].options.signal.aborted, true, "superseding click must cancel old HTTP read");
    await f.reply(1); const before = f.snapshot(); await f.reply(0);
    assert.deepEqual(f.launches.map(call => call.payload.videoId), ["B"], "late A must not reopen after B");
    assert.deepEqual(f.snapshot(), before, "late success must not touch DOM or launch state");
  }, options());
  for (const retire of ["detach", "server", "deactivate", "account"]) for (const failure of [false, true]) {
    await test(`${retire} retires read ${failure ? "failure" : "success"}`, async f => {
      f.buttons[0].click();
      if (retire === "detach") f.section.remove();
      if (retire === "server") f.setBase(`http://changed-${fixtureId}.fixture.invalid:29998`);
      if (retire === "deactivate") { assert.equal(typeof f.view.deactivate, "function"); f.view.deactivate(); assert.equal(f.reads[0].options.signal.aborted, true); }
      if (retire === "account") setAccountOwner(f.base(), "account:other", { force: true });
      const before = f.snapshot();
      if (failure) await f.fail(0); else await f.reply(0);
      assert.deepEqual(f.snapshot(), before, "retired read cannot open native, fall back or paint an error");
    }, options());
  }
  for (const changed of ["server", "account"]) {
    await test(`old connected detail cannot start after ${changed} change`, async f => {
      if (changed === "server") f.setBase(`http://before-click-${fixtureId}.fixture.invalid:29998`);
      else setAccountOwner(f.base(), "account:other", { force: true });
      assert.equal(f.section.isConnected, true);
      const before = f.snapshot(); f.buttons[0].click(); const pending = f.view.playDefaultVideo(f.section, f.work); await flush();
      assert.deepEqual(f.snapshot(), before, "old detail IDs cannot be rebound to a different server/account at click time");
      await pending;
      const section = f.attach(f.work); section.querySelectorAll("button")[0].click(); await f.reply(0);
      assert.equal(f.launches[0].payload.videoId, "A"); assert.equal(f.launches[0].payload.url, `${f.base()}/media/video/A`);
      assert.equal(f.reads[0].options.headers["X-FanHao-Account-Owner"], changed === "account" ? "account:other" : "guest");
    }, options());
  }
  for (const event of ["fanhaoViewWillRender", "pagehide"]) {
    await test(`${event} cancels a pending native open`, async f => {
      f.buttons[0].click(); f.fire(event);
      assert.equal(f.reads[0].options.signal.aborted, true, "shell lifecycle actively cancels owned HTTP reads");
      const before = f.snapshot(); await f.reply(0); assert.deepEqual(f.snapshot(), before);
    }, options());
  }
  for (const retire of ["guard", "signal"]) {
    await test(`detail ${retire} retires pending default play`, async f => {
      let active = true;
      const controller = new AbortController();
      const isActive = () => active;
      isActive.signal = controller.signal;
      const section = f.attach(f.work, { showFiles: false, isActive, signal: controller.signal });
      const pending = f.view.playDefaultVideo(section, f.work);
      if (retire === "guard") active = false; else controller.abort();
      const before = f.snapshot(); await f.reply(0); await pending;
      assert.deepEqual(f.snapshot(), before, "inactive detail guard cannot open an old default video");
    }, options());
  }
  await test("native payload preserves compatibility and resume", async f => {
    const value = { ...f.work, videos: [{ id: "resume", name: "Resume", progress: { percent: 35, position: 42, duration: 120 } }] };
    const section = f.attach(value, { showFiles: false });
    const pending = f.view.playDefaultVideo(section, value); await flush();
    await f.reply(0, direct("resume")); assert.equal(await pending, true);
    const payload = f.launches[0].payload;
    assert.equal(payload.videoId, "resume"); assert.equal(payload.position, 42);
    assert.equal(payload.url, `${f.base()}/media/video/resume`);
    assert.equal(payload.fallbackUrl, `${f.base()}/compat/resume`);
    assert.equal(payload.progressUrl, `${f.base()}/api/progress/resume`);
    assert.equal(f.reads[0].options.headers["X-FanHao-Account-Owner"], "guest");
  }, options());
  await test("old native failure cannot render web fallback", async f => {
    f.buttons[0].click(); await f.reply(0); assert.equal(f.launches.length, 1);
    f.buttons[1].click(); await f.reply(1); assert.equal(f.launches.length, 2);
    const before = f.snapshot(); f.launches[0].reject(new Error("old native failed")); await flush();
    assert.deepEqual(f.snapshot(), before); assert.equal(f.media(), null);
    f.launches[1].resolve({}); await flush();
  }, options({ native: "deferred" }));
  await test("current native failure falls back to direct video", async f => {
    f.buttons[0].click(); await f.reply(0);
    const video = f.media(); assert(video); assert.equal(video.src, `${f.base()}/stream/A.mp4`);
    assert.equal(video.controls, true); assert.equal(video.playCalls, 1);
  }, options({ native: "reject" }));
  await test("malformed native fallback preparation remains a visible web fallback", async f => {
    const pending = f.view.playDefaultVideo(f.section, f.work);
    await f.reply(0, direct("A", { fallbackStreamUrl: "http://[" }));
    assert.equal(await pending, true); assert.equal(f.launches.length, 0);
    const video = f.media(); assert(video); assert.equal(video.src, `${f.base()}/stream/A.mp4`); assert.equal(video.playCalls, 1);
  }, options());
  await test("same-work metadata refresh retains pending explicit play", async f => {
    const isActive = () => true;
    const section = f.attach(f.work, { showFiles: false, isActive });
    const pending = f.view.playDefaultVideo(section, f.work); await flush();
    const freshWork = { ...f.work, title: "Fresh title", videos: f.work.videos.map(video => ({ ...video, name: `Fresh ${video.id}` })) };
    const fresh = f.view.createVideoList(freshWork, { showFiles: false, isActive, preservePlayback: true });
    assert.equal(fresh, section, "same-work refresh must reuse the pending playback section");
    assert.equal(f.reads[0].options.signal.aborted, false, "metadata refresh must not cancel explicit user play");
    section.remove(); f.document.body.append(fresh);
    await f.reply(0); assert.equal(await pending, true); assert.deepEqual(f.launches.map(call => call.payload.videoId), ["A"]);
  }, options());
  await test("same-work metadata refresh retains an in-flight native invocation", async f => {
    const isActive = () => true;
    const section = f.attach(f.work, { showFiles: false, isActive });
    const pending = f.view.playDefaultVideo(section, f.work); await f.reply(0); assert.equal(f.launches.length, 1);
    const fresh = f.view.createVideoList({ ...f.work, title: "Fresh title" }, { showFiles: false, isActive, preservePlayback: true });
    assert.equal(fresh, section); assert.equal(f.reads[0].options.signal.aborted, false);
    section.remove(); f.document.body.append(fresh); f.launches[0].resolve({}); await pending;
    assert.equal(f.launches.length, 1); assert.equal(f.reads.length, 1);
  }, options({ native: "deferred" }));
  await test("same-work metadata refresh retains the active web video and position", async f => {
    const isActive = () => true;
    const section = f.attach(f.work, { showFiles: false, isActive });
    const pending = f.view.playDefaultVideo(section, f.work); await f.reply(0); await pending;
    const video = section.querySelector("video"); assert(video); video.currentTime = 57;
    const fresh = f.view.createVideoList({ ...f.work, title: "Fresh title" }, { showFiles: false, isActive, preservePlayback: true });
    assert.equal(fresh, section, "same-work refresh must retain the active web section");
    section.remove(); f.document.body.append(fresh);
    assert.equal(section.querySelector("video"), video); assert.equal(video.currentTime, 57); assert.equal(video.paused, false);
    assert.equal(video.playCalls, 1); assert.equal(video.pauseCalls, 0); assert.equal(f.reads.length, 1);
  }, options({ native: false }));
  for (const changed of ["removed-video", "work", "guard", "server", "account"]) {
    await test(`metadata refresh retires playback after ${changed} change`, async f => {
      const isActive = () => true;
      const section = f.attach(f.work, { showFiles: false, isActive });
      const pending = f.view.playDefaultVideo(section, f.work); await flush();
      let freshWork = { ...f.work }, freshGuard = isActive;
      if (changed === "removed-video") freshWork.videos = f.work.videos.filter(video => video.id !== "A");
      if (changed === "work") freshWork.id = "different-work";
      if (changed === "guard") freshGuard = () => true;
      if (changed === "server") f.setBase(`http://fresh-${fixtureId}.fixture.invalid:29998`);
      if (changed === "account") setAccountOwner(f.base(), "account:other", { force: true });
      const fresh = f.view.createVideoList(freshWork, { showFiles: false, isActive: freshGuard, preservePlayback: true });
      assert.notEqual(fresh, section, "changed playback identity must create a new section");
      assert.equal(f.reads[0].options.signal.aborted, true, "changed playback identity actively retires the old read");
      const before = f.snapshot(); await f.reply(0); await pending; assert.deepEqual(f.snapshot(), before, "retired cached play cannot open after refresh");
      f.document.body.append(fresh); const next = f.view.playDefaultVideo(fresh, freshWork); await f.reply(1); await next;
      const selected = changed === "removed-video" ? "B" : "A";
      assert.equal(f.launches.length, 1); assert.equal(f.launches[0].payload.videoId, selected); assert.equal(f.launches[0].payload.url, `${f.base()}/media/video/${selected}`);
    }, options());
  }
  await test("stale direct compatibility timer cannot replace B", async f => {
    f.buttons[0].click(); await f.reply(0); const old = f.media(); old.currentTime = 31; old.error = { code: 3 }; old.emit("error");
    const queued = f.pendingTimer(250); assert.equal(typeof queued, "function", "owned decode error schedules compatibility fallback");
    f.buttons[1].click(); await f.reply(1); const fresh = f.media(), before = f.snapshot();
    queued(); f.runTimers(250); await flush();
    assert.equal(f.media(), fresh); assert.equal(fresh.src, `${f.base()}/stream/B.mp4`);
    assert.deepEqual(f.snapshot(), before); assert(old.pauseCalls > 0); assert.equal(old.src, ""); assert(old.loadCalls > 0);
  }, options({ native: false }));
  await test("valid compatibility fallback preserves timeline", async f => {
    f.buttons[0].click(); await f.reply(0); const old = f.media(); old.currentTime = 31; old.error = { code: 3 }; old.emit("error");
    f.runTimers(250); await flush(); const fallback = f.media();
    assert.notEqual(fallback, old); assert.equal(fallback.src, `${f.base()}/compat/A?t=31`); assert.equal(fallback.playCalls, 1);
    assert.equal(old.src, ""); assert(old.pauseCalls > 0); assert(old.loadCalls > 0);
    const before = f.snapshot(); old.emit("timeupdate"); old.emit("pause"); old.emit("error"); await flush();
    assert.deepEqual(f.snapshot(), before, "retired direct media cannot publish or retry after fallback");
  }, options({ native: false }));
  await test("released media events cannot publish progress or retry", async f => {
    f.buttons[0].click(); await f.reply(0); const old = f.media(); old.currentTime = 12;
    f.buttons[1].click(); await f.reply(1); const fresh = f.media(), before = f.snapshot();
    for (const event of ["timeupdate", "pause", "ended", "loadedmetadata", "error"]) old.emit(event);
    await flush(); assert.deepEqual(f.snapshot(), before); assert.equal(f.media(), fresh);
    fresh.currentTime = 20; fresh.emit("pause"); await flush();
    assert.equal(f.posts.length, before.posts + 1); assert.equal(JSON.parse(f.posts.at(-1).options.body).position, 20);
    assert.equal(f.posts.at(-1).url, `${f.base()}/api/progress/B`);
  }, options({ native: false }));
  await test("playing timeupdate events honor the progress throttle", async f => {
    f.buttons[0].click(); await f.reply(0); const video = f.media();
    assert.equal(video.paused, false); const before = f.posts.length;
    for (let index = 0; index < 100; index += 1) { video.currentTime = 10 + index / 10; video.emit("timeupdate"); }
    await flush(); assert.equal(f.posts.length, before + 1, "DOM Event must not bypass the five-second playing progress throttle");
    f.advanceTime(5001); video.currentTime = 25; video.emit("timeupdate"); await flush();
    assert.equal(f.posts.length, before + 2, "playing progress throttle must reopen after five seconds");
    assert.equal(JSON.parse(f.posts.at(-1).options.body).position, 25);
    video.currentTime = 41; video.emit("pause"); await flush();
    assert.equal(f.posts.length, before + 3); assert.equal(JSON.parse(f.posts.at(-1).options.body).position, 41);
  }, options({ native: false }));
  for (const readyState of [0, 1]) {
    await test(`unready startup ${readyState} never overwrites saved resume with zero`, async f => {
      const work = { ...f.work, videos: [{ id: "A", name: "A", progress: { percent: 20, position: 19, duration: 120 } }] };
      const section = f.attach(work, { showFiles: false });
      const pending = f.view.playDefaultVideo(section, work); await f.reply(0); await pending;
      const video = section.querySelector("video"); assert(video); video.readyState = readyState; video.currentTime = 0;
      for (const event of ["timeupdate", "pause", "ended"]) video.emit(event);
      await flush(); assert.equal(f.posts.length, 0, "unready media must not publish a startup zero");
      f.view.deactivate(); await flush(); assert.equal(f.posts.length, 0, "forced release must not publish a startup zero");
    }, options({ native: false }));
  }
  for (const interruptedBy of ["buffer", "error"]) {
    await test(`forced release preserves last ready position during ${interruptedBy}`, async f => {
      f.buttons[0].click(); await f.reply(0); const video = f.media();
      video.currentTime = 40; video.emit("timeupdate"); await flush(); assert.equal(f.posts.length, 1);
      video.currentTime = 47; video.emit("timeupdate"); await flush(); assert.equal(f.posts.length, 1, "ready sample still uses the playing throttle");
      video.currentTime = 0;
      if (interruptedBy === "buffer") video.readyState = 1; else video.error = { code: 3 };
      f.view.deactivate(); await flush();
      assert.equal(f.posts.length, 2); assert.equal(JSON.parse(f.posts.at(-1).options.body).position, 47, "forced release uses the newest ready sample, including throttled samples");
    }, options({ native: false }));
  }
  await test("paused ready seek to zero remains a valid progress update", async f => {
    f.buttons[0].click(); await f.reply(0); const video = f.media();
    video.currentTime = 47; video.emit("timeupdate"); await flush();
    video.currentTime = 0; video.paused = true; video.emit("pause"); await flush();
    assert.equal(f.posts.length, 2); assert.equal(JSON.parse(f.posts.at(-1).options.body).position, 0, "a ready explicit zero must not be replaced by an older nonzero sample");
  }, options({ native: false }));
  await test("late autoplay rejection cannot paint old actions", async f => {
    const playing = deferred(); f.setPlayBehavior(() => playing.promise);
    f.buttons[0].click(); await f.reply(0); const old = f.media();
    f.setPlayBehavior(() => Promise.resolve()); f.buttons[1].click(); await f.reply(1); const before = f.snapshot();
    playing.reject(new Error("autoplay blocked")); await flush();
    assert.deepEqual(f.snapshot(), before); assert.notEqual(f.media(), old);
  }, options({ native: false }));
  await test("current remux seek replaces source once at original timeline", async f => {
    f.buttons[0].click(); await f.reply(0, direct("A", { mode: "remux", streamUrl: "/remux/A" }));
    const old = f.media(); old.currentTime = 5;
    const seek = f.mount.querySelector(".android-stream-seek"); assert(seek); seek.value = "55"; seek.emit("change"); await flush();
    const current = f.media(); assert.notEqual(current, old); assert.equal(current.src, `${f.base()}/remux/A?t=55`);
    assert.equal(current.playCalls, 1); assert.equal(old.src, ""); assert(old.pauseCalls > 0);
    const before = f.snapshot(); seek.value = "99"; seek.emit("change"); await flush();
    assert.deepEqual(f.snapshot(), before, "old remux controls cannot seek current source");
  }, options({ native: false }));
  await test("web retry read cannot outlive a new selection", async f => {
    f.buttons[0].click(); await f.reply(0, direct("A", { mode: "transcode", streamUrl: "/transcode/A" }));
    const old = f.media(); old.error = { code: 2 }; old.emit("error");
    const retry = f.mount.querySelectorAll("button").find(button => button.textContent === "重试"); assert(retry); retry.click(); await flush();
    assert.equal(f.reads.length, 2, "current web retry obtains new play information");
    f.buttons[1].click(); await f.reply(2); const current = f.media(), before = f.snapshot(); await f.reply(1);
    assert.equal(f.media(), current); assert.equal(current.src, `${f.base()}/stream/B.mp4`); assert.deepEqual(f.snapshot(), before);
    assert.equal(f.reads[1].options.signal.aborted, true);
  }, options({ native: false }));
  await test("deactivate releases fallback and permits a new mounted detail", async f => {
    f.buttons[0].click(); await f.reply(0); const old = f.media();
    f.view.deactivate(); assert.equal(old.src, ""); assert(old.pauseCalls > 0); assert(old.loadCalls > 0);
    const before = f.snapshot(); old.emit("error"); old.emit("pause"); old.emit("timeupdate"); await flush(); assert.deepEqual(f.snapshot(), before);
    const value = { ...f.work, videos: [{ id: "new-detail", name: "New detail", playable: true }] };
    const section = f.attach(value, { showFiles: false }); const pending = f.view.playDefaultVideo(section, value); await f.reply(1, direct("new-detail"));
    assert.equal(await pending, true); assert(section.querySelector("video"));
  }, options({ native: false }));
  for (const retiredBy of ["route", "server", "account", "detach"]) {
    await test(`route signal final progress ${retiredBy}`, async f => {
      const controller = new AbortController();
      const isActive = () => !controller.signal.aborted;
      isActive.signal = controller.signal;
      const section = f.attach(f.work, { showFiles: false, isActive });
      const pending = f.view.playDefaultVideo(section, f.work); await f.reply(0); await pending;
      const old = section.querySelector("video"); assert(old); old.currentTime = 47;
      if (retiredBy === "server") f.setBase(`http://final-progress-${fixtureId}.fixture.invalid:29998`);
      if (retiredBy === "account") setAccountOwner(f.base(), "account:other", { force: true });
      if (retiredBy === "detach") section.remove();
      const reports = f.posts.length; controller.abort(); await flush();
      assert.equal(f.posts.length, reports + (retiredBy === "route" ? 1 : 0), "route cancellation flushes one still-owned final position without crossing server/account/mount ownership");
      if (retiredBy === "route") assert.equal(JSON.parse(f.posts.at(-1).options.body).position, 47);
      assert.equal(old.src, ""); assert(old.pauseCalls > 0); assert(old.loadCalls > 0);
      const before = f.snapshot(); old.emit("pause"); old.emit("timeupdate"); old.emit("error"); await flush(); assert.deepEqual(f.snapshot(), before);
    }, options({ native: false }));
  }
  await test("partial render failure releases resources and retains current retry", async f => {
    f.buttons[0].click(); await f.reply(0, direct("A", { streamUrl: "http://[" }));
    const partial = f.nodes.filter(node => node.tag === "video").at(-1); assert(partial);
    assert.equal(partial.src, ""); assert(partial.pauseCalls > 0); assert(partial.loadCalls > 0);
    assert(f.mount.querySelector(".player-error-box"));
    const retry = f.mount.querySelectorAll("button").find(button => button.textContent === "重试"); assert(retry);
    retry.click(); await f.reply(1); const current = f.media(); assert(current); assert.equal(current.src, `${f.base()}/stream/A.mp4`);
    const before = f.snapshot(); retry.click(); await flush(); assert.deepEqual(f.snapshot(), before, "retired error control cannot restart the current render");
  }, options({ native: false }));
  await test("current read failure remains explicitly retryable", async f => {
    f.buttons[0].click(); await f.fail(0, "Fixture unavailable");
    assert(f.mount.querySelector(".player-error-box"));
    const retry = f.mount.querySelectorAll("button").find(button => button.textContent === "重试"); assert(retry); retry.click();
    await f.reply(1); assert.equal(f.launches[0].payload.videoId, "A");
  }, options());
  await test("missing default candidate returns false", async f => {
    assert.equal(await f.view.playDefaultVideo(null, f.work), false);
    assert.equal(await f.view.playDefaultVideo(f.section, { videos: [] }), false);
    assert.equal(f.reads.length, 0);
  }, options());
}

try {
  await verify();
  console.log(`Android FanHao player requests: ${cases} actual factory/API/media behavior cases passed.`);
  const mutations = [
    ["playback owner", source.replace("return currentPlayback === owner && !owner.controller.signal.aborted", "return Boolean(owner)"),
      "latest click owns native launch", /late A must not reopen after B/],
    ["mounted detail", source.replace("owner.mount.isConnected && ", ""),
      "detach retires read success", /retired read cannot open native/],
    ["active server", source.replace(" && owner.baseUrl === getActiveUrl()", ""),
      "server retires read success", /retired read cannot open native/],
    ["render owner", source.replace("ownsPlayback(owner) && owner.rendering === rendering", "ownsPlayback(owner)"),
      "valid compatibility fallback preserves timeline", /retired direct media cannot publish or retry/],
    ["timeupdate throttle", source.replace('video.addEventListener("timeupdate", () => report());', 'video.addEventListener("timeupdate", report);'),
      "playing timeupdate events honor the progress throttle", /five-second playing progress throttle/],
    ["route retirement", source.replace('window.addEventListener?.("fanhaoViewWillRender", deactivate);', "/* route retirement removed */"),
      "fanhaoViewWillRender cancels a pending native open", /shell lifecycle actively cancels/],
    ["route final progress", source.replace("rendering.report?.(true, true);", "rendering.report?.(true);"),
      "route signal final progress route", /route cancellation flushes one still-owned final position/],
    ["detail identity", source.replace("const { baseUrl, accountScope, isActive } = scope;", "const baseUrl = getActiveUrl(), accountScope = captureAccountOwner(baseUrl), { isActive } = scope;"),
      "old connected detail cannot start after server change", /old detail IDs cannot be rebound/],
    ["cached playback preservation", source.replace("if (options.preservePlayback) {", "if (false) {"),
      "same-work metadata refresh retains pending explicit play", /same-work refresh must reuse the pending playback section/],
    ["selected video identity", source.replace(" && (work.videos || []).some(video => video.id === owner.videoId)", ""),
      "metadata refresh retires playback after removed-video change", /changed playback identity must create a new section/],
    ["ready progress sample", source.replace("video.readyState >= 2 && !video.error && ", ""),
      "unready startup 0 never overwrites saved resume with zero", /unready media must not publish a startup zero/],
    ["latest throttled sample", source.replace("if (ready) lastReadyProgress = { position, duration };", "if (ready && !lastReadyProgress) lastReadyProgress = { position, duration };"),
      "forced release preserves last ready position during buffer", /forced release uses the newest ready sample/]
  ];
  for (const [name, mutated, scenario, expected] of mutations) {
    assert.notEqual(mutated, source, `${name} mutation must alter actual factory`);
    selectedCase = scenario;
    await assert.rejects(() => verify(mutated), expected, `${name} behavioral negative control survived`);
  }
  console.log(`Android FanHao player requests: ${mutations.length} behavioral negative controls rejected.`);
} finally {
  globalThis.fetch = original.fetch;
  globalThis.window = original.window;
}
