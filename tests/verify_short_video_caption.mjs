import assert from "node:assert/strict";
import { createShortVideoCaptionController } from "../public/modules/short-videos/caption-controller.js";
import { createShortVideoCaptionText, captionTitleWithTags } from "../public/modules/short-videos/caption-text.js";
import { normalizeShortVideoTopic } from "../public/modules/short-videos/state.js";

// Controlled text/element nodes, layout reads, resize observation and frame
// delivery exercise the real caption renderer without media or a browser.
class Element extends EventTarget {
  constructor(tag) {
    super(); this.tagName = tag.toUpperCase(); this.nodeType = tag === "#text" ? 3 : 1;
    this.parentNode = null; this.children = []; this.attributes = new Map(); this.dataset = {}; this.className = "";
    this.ownText = ""; this.scrollTop = 0; this.mutations = 0;
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => names.forEach(name => this.classList.toggle(name, true)),
      remove: (...names) => names.forEach(name => this.classList.toggle(name, false)),
      toggle: (name, force) => {
        const active = force ?? !this.classList.contains(name);
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        if (active) names.add(name); else names.delete(name);
        this.className = [...names].join(" "); this.mutations++; return active;
      }
    };
  }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0] || null; }
  get parentElement() { return this.parentNode; }
  get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
  get isConnected() { return this.connected || Boolean(this.parentNode?.isConnected); }
  get textContent() { return this.ownText + this.children.map(node => node.textContent).join(""); }
  set textContent(value) {
    this.children.slice().forEach(node => node.remove()); this.ownText = String(value); this.mutations++;
  }
  set innerHTML(_value) { throw new Error("captions must never write HTML"); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); this.mutations++; }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); this.mutations++; }
  contains(node) { for (let current = node; current; current = current.parentNode) if (current === this) return true; return false; }
  append(...nodes) { nodes.forEach(node => this.insertBefore(node, null)); }
  insertBefore(node, anchor) {
    if (node === anchor) return node;
    node.remove();
    const index = anchor ? this.children.indexOf(anchor) : this.children.length;
    assert(index >= 0); this.children.splice(index, 0, node); node.parentNode = this; this.mutations++; return node;
  }
  remove() {
    if (this.contains(globalThis.document?.activeElement)) document.activeElement = document.body;
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter(node => node !== this);
      this.parentNode.mutations++;
    }
    this.parentNode = null;
  }
  closest(selector) {
    for (let node = this; node; node = node.parentNode) {
      if (selector.split(",").some(part => {
        const key = part.trim();
        if (key === "[inert]") return Boolean(node.inert || node.hasAttribute("inert"));
        if (key.startsWith(".")) return node.classList.contains(key.slice(1));
        return node.tagName.toLowerCase() === key;
      })) return node;
    }
    return null;
  }
  querySelectorAll(selector) {
    const matches = node => selector.startsWith(".") ? node.classList.contains(selector.slice(1)) : node.tagName.toLowerCase() === selector;
    return this.children.flatMap(node => [...(matches(node) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { if (this.isConnected) document.activeElement = this; }
  click() { if (!this.disabled && !this.hidden) this.dispatchEvent(new Event("click", { cancelable: true })); }
}
class Target extends EventTarget {
  constructor() { super(); this.listeners = new Map(); }
  addEventListener(name, listener, options) {
    super.addEventListener(name, listener, options);
    const handlers = this.listeners.get(name) || new Set(); handlers.add(listener); this.listeners.set(name, handlers);
  }
  removeEventListener(name, listener, options) {
    super.removeEventListener(name, listener, options); this.listeners.get(name)?.delete(listener);
  }
  listenerCount() { return [...this.listeners.values()].reduce((sum, handlers) => sum + handlers.size, 0); }
}
function fixture({ height = 100, width = 300, expanded = false, video: input = {}, connected = true } = {}) {
  let sequence = 0, fontReady;
  const frames = new Map(), history = new Map(), observations = [], calls = [], nodes = [];
  const layout = { height, width, lineHeight: 20, fontSize: 16, lines: 2, reads: 0, styleReads: 0 };
  const fonts = new Target(); fonts.ready = new Promise(resolve => { fontReady = resolve; });
  const body = new Element("body"); body.connected = true;
  globalThis.document = Object.assign(new Target(), {
    body, activeElement: body, fonts,
    createElement(tag) { assert(!["video", "audio", "script"].includes(tag)); const node = new Element(tag); nodes.push(node); return node; },
    createTextNode(text) { const node = new Element("#text"); node.textContent = text; return node; }
  });
  globalThis.window = Object.assign(new Target(), {
    requestAnimationFrame(callback) { const id = sequence++; frames.set(id, callback); history.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    getComputedStyle() {
      layout.styleReads++;
      return { lineHeight: String(layout.lineHeight), fontSize: String(layout.fontSize), getPropertyValue: () => String(layout.lines) };
    }
  });
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.nodes = new Set(); observations.push(this); }
    observe(node) { this.nodes.add(node); }
    disconnect() { this.disconnected = true; this.nodes.clear(); }
  };
  const panel = new Element("div"); panel.className = "short-video-reel-panel is-current"; panel.dataset.videoId = "A";
  const container = new Element("div"); container.className = `short-video-caption-copy${expanded ? " is-expanded" : ""}`;
  const paragraph = new Element("p");
  Object.defineProperty(paragraph, "clientWidth", { get: () => layout.width });
  Object.defineProperty(paragraph, "scrollHeight", { get: () => { layout.reads++; return layout.height; } });
  container.append(paragraph); panel.append(container); if (connected) body.append(panel);
  const external = new Element("input"); body.append(external);
  const video = { id: "A", title: "原始长文案 #one", tags: ["one"], author: { name: "旧作者" }, ...input };
  const appendCaptionText = createShortVideoCaptionText({ normalizeTopic: normalizeShortVideoTopic,
    openTopic: (metadata, topic) => calls.push({ topic, title: metadata.title, author: metadata.author?.name }) });
  const controller = createShortVideoCaptionController({ panel, container, paragraph, video, appendCaptionText, captionTitleWithTags });
  const flush = () => { const queued = [...frames.entries()]; queued.forEach(([id]) => frames.delete(id)); queued.forEach(([, callback]) => callback()); };
  const resize = () => observations.forEach(observer => observer.callback([]));
  const button = container.querySelector(".short-video-caption-expand");
  return { controller, panel, container, paragraph, video, external, body, button, frames, history, observations, layout, calls, nodes, fonts,
    flush, resize, fontReady, document, window, topic: () => paragraph.querySelector(".short-video-caption-tag") };
}
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

const previous = { window: globalThis.window, document: globalThis.document, ResizeObserver: globalThis.ResizeObserver };
try {
  {
    const f = fixture();
    assert.equal(f.frames.size, 1); assert.equal(f.layout.reads, 0);
    f.flush(); assert.equal(f.layout.reads, 1); assert.equal(f.frames.size, 0);
    assert.equal(f.button.hidden, false); assert.equal(f.button.textContent, "展开");
    assert.equal(f.button.getAttribute("aria-controls"), f.paragraph.id);
    assert(f.container.classList.contains("can-expand"));
    for (let index = 0; index < 20; index++) {
      f.resize(); f.window.dispatchEvent(new Event("resize")); f.document.dispatchEvent(new Event("fullscreenchange")); f.fonts.dispatchEvent(new Event("loadingdone"));
    }
    assert.equal(f.frames.size, 1); f.flush();
    assert.equal(f.layout.reads, 2, "layout events coalesce rather than polling caption layout each media frame");
    f.flush(); f.flush(); assert.equal(f.layout.reads, 2); assert.equal(f.frames.size, 0);
    f.fontReady(); await settle(); assert.equal(f.frames.size, 1); f.flush();
    assert.equal(f.layout.reads, 3); f.controller.dispose();
  }
  {
    const f = fixture({ height: 20 }); f.flush();
    assert.equal(f.button.hidden, true); assert.equal(f.button.tabIndex, -1);
    assert.equal(f.container.classList.contains("can-expand"), false);
    f.layout.height = 80; f.resize(); f.flush();
    f.button.focus(); f.button.click();
    assert.equal(f.container.classList.contains("is-expanded"), true);
    assert.equal(f.button.textContent, "收起"); assert.equal(f.button.getAttribute("aria-expanded"), "true");
    f.flush(); f.button.click();
    assert.equal(f.container.classList.contains("is-expanded"), false);
    f.controller.dispose();
  }
  {
    const f = fixture(); f.flush(); f.button.click(); f.flush();
    f.paragraph.scrollTop = 37; const topic = f.topic(); topic.focus();
    assert.equal(f.controller.update({ ...f.video, title: "#one 新标题", author: { name: "新作者" } }), true);
    assert.equal(f.topic(), topic, "a still-present topic keeps its actual button node");
    assert.equal(f.document.activeElement, topic, "moving a reusable topic restores focus lost by native node movement");
    assert.equal(f.paragraph.scrollTop, 37); assert(f.container.classList.contains("is-expanded"));
    topic.click(); assert.deepEqual(f.calls, [{ topic: "one", title: "#one 新标题", author: "新作者" }]);
    f.flush(); const reads = f.layout.reads, mutations = f.paragraph.mutations;
    f.controller.update({ ...f.video, title: "#one 新标题", author: { name: "另一作者" } });
    assert.equal(f.paragraph.mutations, mutations); assert.equal(f.frames.size, 0);
    topic.click(); assert.equal(f.calls.at(-1).author, "另一作者");
    f.flush(); assert.equal(f.layout.reads, reads, "unmodified text/tag metadata never measures or rebuilds caption nodes");
    f.controller.dispose();
  }
  {
    const f = fixture({ video: { title: "#春日摄影", tags: ["春日"] } }); f.flush();
    const old = f.topic(); old.focus();
    f.controller.update({ id: "A", title: "#春日摄影", tags: ["春日摄影"] });
    assert.equal(f.topic().textContent, "#春日摄影", "tag recognition changes even when the overall caption string is identical");
    assert.notEqual(f.topic(), old);
    assert.equal(f.document.activeElement, f.button, "removed focused topics fall back to a nearby accessible caption control");
    old.click(); assert.equal(f.calls.length, 0, "an obsolete topic reference cannot operate after token replacement");
    f.topic().click(); assert.equal(f.calls[0].topic, "春日摄影");
    f.controller.dispose();
  }
  {
    const f = fixture(); f.flush(); f.external.focus();
    f.controller.update({ id: "A", title: "新内容 #two", tags: ["two"] });
    assert.equal(f.document.activeElement, f.external, "metadata updates do not steal external input focus");
    assert.equal(f.controller.update({ id: "B", title: "错误作品" }), false);
    assert.equal(f.paragraph.textContent, "新内容 #two");
    f.controller.dispose();
  }
  {
    const f = fixture(); f.flush(); f.button.click(); f.flush();
    f.button.focus(); f.layout.lineHeight = 60; f.resize(); f.flush();
    assert.equal(f.button.hidden, true); assert.equal(f.document.activeElement, f.paragraph);
    assert(f.container.classList.contains("is-expanded"), "overflow measurement preserves the chosen expansion state");
    f.controller.dispose();
  }
  {
    const f = fixture({ video: { title: "<script>alert(1)</script> #安全", tags: ["安全"] } }); f.flush();
    assert(f.paragraph.textContent.includes("<script>")); assert(!f.nodes.some(node => node.tagName === "SCRIPT"));
    f.paragraph.click(); assert(f.container.classList.contains("is-expanded"));
    f.controller.dispose();
  }
  {
    const f = fixture(); f.flush(); const topic = f.topic();
    f.panel.classList.remove("is-current"); f.panel.classList.add("is-ghost-panel");
    const text = f.paragraph.textContent;
    assert.equal(f.controller.update({ id: "A", title: "不应写入" }), false);
    f.resize(); f.window.dispatchEvent(new Event("resize")); topic.click(); f.button.click();
    assert.equal(f.frames.size, 0); assert.equal(f.calls.length, 0); assert.equal(f.paragraph.textContent, text);
    assert.equal(f.container.classList.contains("is-expanded"), false);
    f.panel.classList.add("is-current"); f.panel.classList.remove("is-ghost-panel");
    f.panel.shortVideoSyncCaptionOverflow(); assert.equal(f.frames.size, 1); f.flush();
    f.controller.dispose();
  }
  {
    const f = fixture({ connected: false });
    assert.equal(f.frames.size, 1, "an initial current panel may be mounted later in the same rendering task");
    f.body.append(f.panel); f.flush(); assert.equal(f.button.hidden, false);
    const oldFrame = [...f.history.values()][0];
    f.controller.sync(); f.panel.remove(); f.flush();
    const reads = f.layout.reads; oldFrame();
    f.resize(); f.controller.sync(); f.fontReady(); await settle();
    assert.equal(f.frames.size, 0); assert.equal(f.layout.reads, reads);
    f.controller.dispose();
  }
  {
    const f = fixture(); const pending = [...f.history.values()][0], topic = f.topic();
    f.controller.dispose(); f.controller.dispose(); pending();
    f.resize(); f.window.dispatchEvent(new Event("resize")); f.document.dispatchEvent(new Event("fullscreenchange"));
    f.fontReady(); await settle(); topic.click(); f.button.click();
    assert.equal(f.frames.size, 0); assert.equal(f.layout.reads, 0); assert.equal(f.calls.length, 0);
    assert(f.observations.every(observer => observer.disconnected && observer.nodes.size === 0));
    assert.equal(f.window.listenerCount(), 0); assert.equal(f.document.listenerCount(), 0); assert.equal(f.fonts.listenerCount(), 0);
    assert.equal(f.panel.shortVideoSyncCaptionOverflow, undefined);
  }
} finally {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
  }
}
console.log("short-video-caption: safe topics, expansion/focus/scroll preservation, overflow coalescing, role ownership and disposal passed");
