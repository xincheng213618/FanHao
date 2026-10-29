import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createShortVideoSoundPreviewController, disposeShortVideoSoundPreviews } from "../public/modules/short-videos/sound-preview-controller.js";

// Actual preview view, tab renderer and controller, with independently settled
// network/media promises. No service, browser, database or media file is used.
const source = fs.readFileSync(new URL("../public/modules/short-videos/author-panel.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function named(name) {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf("\n  }", start);
  assert(start >= 0 && end > start, name);
  return source.slice(start, end + 4);
}
function declaration(name) {
  const start = source.indexOf(`    const ${name} = `);
  const end = source.indexOf("\n    };", start);
  assert(start >= 0 && end > start, name);
  return source.slice(start, end + 7);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parent = null;
    this.className = "";
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.classes = new Set();
    this.classList = {
      toggle: (name, force) => { if (force ?? !this.classes.has(name)) this.classes.add(name); else this.classes.delete(name); },
      remove: (...names) => names.forEach(name => this.classes.delete(name))
    };
    this.paused = true;
    this.ended = false;
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.loadCalls = 0;
  }
  get isConnected() { return this.connectedRoot || Boolean(this.parent?.isConnected); }
  append(...elements) { for (const node of elements) { node.remove(); node.parent = this; this.children.push(node); } }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this);
    this.parent = null;
  }
  replaceChildren(...elements) { this.children.forEach(node => { node.parent = null; }); this.children = []; this.append(...elements); }
  querySelectorAll(selector) {
    const found = [];
    for (const node of this.children) {
      if (selector.startsWith(".") ? node.className.split(/\s+/).includes(selector.slice(1)) : node.tagName === selector) found.push(node);
      found.push(...node.querySelectorAll(selector));
    }
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); if (name === "src") this.src = ""; }
  addEventListener(name, handler) { const handlers = this.listeners.get(name) || new Set(); handlers.add(handler); this.listeners.set(name, handlers); }
  removeEventListener(name, handler) { this.listeners.get(name)?.delete(handler); }
  emit(name) { let result; for (const handler of this.listeners.get(name) || []) result = handler({ target: this }); return result; }
  play() { this.playCalls++; this.paused = false; this.emit("play"); return this.pending?.promise || Promise.resolve(); }
  pause() { this.pauseCalls++; const changed = !this.paused; this.paused = true; if (changed) this.emit("pause"); }
  load() { this.loadCalls++; }
}

function fixture() {
  const root = new Element("root"); root.connectedRoot = true;
  const panel = new Element("section"), content = new Element("content");
  root.append(panel); panel.append(content);
  const errors = [], requests = [], acquisitions = [], releases = [], media = [];
  const video = { id: "a", sound: { key: "fixture", previewUrl: "/fixture/sound", title: "Fixture", localAvailable: true } };
  const env = vm.createContext({
    console, URLSearchParams, document: { createElement: name => new Element(name), createTextNode: () => new Element("text") },
    createShortVideoSoundPreviewController, disposeShortVideoSoundPreviews,
    panel, content, video, author: {}, selectedSound: video.sound,
    state: { shortVideo: { current: video } }, tabButtons: new Map(), activeTab: "sound",
    soundItems: [], soundTotal: 0, soundLoading: false, soundLoaded: false, soundError: "",
    setAuthorPanelTileMap() {}, createIcon: () => new Element("icon"), formatNumber: String,
    shortVideosWithCovers: videos => videos, authorDetailView: () => new Element("detail"),
    activePlayer: () => { throw new Error("the injected playback bridge must own main playback"); },
    acquireShortVideoSoundPreviewPlayback(audio, owner) {
      acquisitions.push({ audio, owner });
      return options => releases.push({ audio, options });
    },
    showBrowserToast: message => errors.push(message), shortVideoFriendlyError: error => error.message,
    api: () => { const request = deferred(); requests.push(request); return request.promise; }
  });
  vm.runInContext(`${named("isCurrentPanel")}\n${named("disposeAuthorPanelChildViews")}\n${named("shortVideoSoundView")}\n${declaration("loadSoundWorks")}\n${declaration("renderAuthorTab")}\nglobalThis.view = { renderAuthorTab };`, env);
  const render = tab => { env.view.renderAuthorTab(tab); const current = content.querySelector("audio"); if (current && !media.includes(current)) media.push(current); };
  render("sound");
  const audio = () => content.querySelector("audio");
  const button = () => content.querySelector(".short-video-sound-actions").querySelector("button");
  return { root, panel, content, requests, errors, acquisitions, releases, media, render, audio, button,
    close(options) { disposeShortVideoSoundPreviews(panel, options); panel.remove(); } };
}

{
  const f = fixture(), audio = f.audio();
  await f.button().emit("click");
  assert.equal(audio.paused, false);
  assert.equal(f.acquisitions.length, 1);
  const pauses = audio.pauseCalls;
  f.requests[0].resolve({ videos: [], total: 0 }); await settle();
  assert.equal(f.audio(), audio, "same-sound list response preserves the playing preview and its owner");
  assert.equal(f.content.querySelector(".short-video-sound-heading").querySelector("small").textContent, "0 个作品", "list metadata updates around the preserved preview");
  assert.equal(audio.pauseCalls, pauses);
  assert.equal(audio.playCalls, 1);
  f.render("detail");
  assert.equal(audio.paused, true, "leaving the tab stops media before detaching it");
  assert.equal(audio.isConnected, false);
  assert.equal(audio.src, "");
  assert.equal(audio.loadCalls, 1);
  assert.equal(f.releases.length, 1);
  f.close();
  assert.equal(audio.loadCalls, 1, "closing after switching tabs cannot miss or re-release an orphan preview");
}

{
  const f = fixture(), audio = f.audio(), pending = deferred(); audio.pending = pending;
  const first = f.button().emit("click");
  assert.equal(f.button().textContent, "取消试听");
  await f.button().emit("click");
  assert.equal(audio.paused, true, "second click cancels pending start");
  pending.reject(Object.assign(new Error("cancelled"), { name: "AbortError" })); await first;
  assert.deepEqual(f.errors, []);
  assert.equal(f.releases.length, 1);
  f.close();
  assert.equal(f.releases.length, 1);
}

for (const operation of ["close", "tab"]) {
  const f = fixture(), audio = f.audio(), pending = deferred(); audio.pending = pending;
  const first = f.button().emit("click");
  if (operation === "close") f.close(); else f.render("detail");
  pending.reject(new Error("old playback failure")); await first;
  assert.deepEqual(f.errors, [], `${operation} invalidates pending error messages`);
  assert.equal(audio.paused, true);
  assert.equal(audio.src, "");
  assert.equal(f.releases.length, 1);
  assert.equal([...audio.listeners.values()].reduce((sum, value) => sum + value.size, 0), 0);
}

{
  const f = fixture(), audio = f.audio(), old = deferred(); audio.pending = old;
  const first = f.button().emit("click");
  await f.button().emit("click");
  const latest = deferred(); audio.pending = latest;
  const third = f.button().emit("click");
  old.reject(new Error("superseded")); await first;
  assert.equal(audio.paused, false, "old rejection cannot stop a newer start");
  assert.deepEqual(f.errors, []);
  latest.resolve(); await third;
  assert.equal(f.button().textContent, "暂停原声");
  assert.equal(f.acquisitions.length, 2);
  assert.equal(f.releases.length, 1);
  f.close({ restorePlayback: false });
  assert.equal(f.releases.length, 2);
  assert.equal(f.releases[1].options.restorePlayback, false);
}

{
  const f = fixture(), audio = f.audio(), pending = deferred(); audio.pending = pending;
  const first = f.button().emit("click");
  pending.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" })); await first;
  assert.deepEqual(f.errors, ["浏览器拦截了播放，请再次点击试听"]);
  assert.equal(audio.paused, true);
  assert.equal(f.releases.length, 1);
  f.close();
}

{
  const f = fixture(), audio = f.audio(), pending = deferred(); audio.pending = pending;
  const first = f.button().emit("click");
  pending.reject(Object.assign(new Error("interrupted"), { name: "AbortError" })); await first;
  assert.deepEqual(f.errors, [], "a current cancelled play request is silent too");
  assert.equal(audio.paused, true);
  assert.equal(f.button().disabled, false, "cancellation allows another user start");
  audio.pending = null; await f.button().emit("click");
  assert.equal(audio.paused, false);
  f.close();
}

{
  const f = fixture(), audio = f.audio(), old = deferred(); audio.pending = old;
  const first = f.button().emit("click");
  await f.button().emit("click");
  const latest = deferred(); audio.pending = latest;
  const third = f.button().emit("click");
  old.resolve(); await first;
  assert.equal(f.button().textContent, "取消试听", "stale success cannot clear the newer pending start");
  assert.equal(f.releases.length, 1);
  latest.resolve(); await third;
  f.close();
}

{
  const f = fixture(), audio = f.audio(), pending = deferred(); audio.pending = pending;
  const first = f.button().emit("click");
  f.close(); pending.resolve(); await first;
  assert.equal(audio.paused, true, "late successful play acknowledgement cannot restart disposed media");
  assert.equal(audio.playCalls, 1);
  assert.equal(f.releases.length, 1);
  assert.deepEqual(f.errors, []);
}

{
  const f = fixture(), audio = f.audio();
  await f.button().emit("click");
  audio.ended = true; audio.paused = true; audio.emit("ended");
  assert.equal(f.releases.length, 1, "ending preview releases the captured main playback owner");
  assert.equal(f.button().textContent, "播放本地原声");
  f.close();
  assert.equal(f.releases.length, 1);
}

{
  const f = fixture(), audio = f.audio();
  await f.button().emit("click");
  audio.emit("error");
  assert.equal(f.button().disabled, true);
  assert.equal(f.button().textContent, "原声暂不可播放");
  assert.equal(audio.paused, true);
  assert.equal(f.releases.length, 1);
  f.close();
}

console.log("short-video-sound-preview: passed view/tab ownership, list-response continuity, pending cancellation, stale errors, playback lease and disposal");
