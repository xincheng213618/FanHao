import assert from "node:assert/strict";
import vm from "node:vm";

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function settle() {
  for (let index = 0; index < 40; index += 1) await Promise.resolve();
}

class FixtureEvent {
  constructor(type, options = {}) { this.type = type; Object.assign(this, options); }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
}

class Events {
  listeners = new Map();
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatchEvent(event) {
    event.target ||= this;
    event.currentTarget = this;
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    if (event.bubbles && !event.propagationStopped) this.parentNode?.dispatchEvent(event);
    return !event.defaultPrevented;
  }
}

const dataName = (name) => name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

class Element extends Events {
  constructor(tagName, document) {
    super();
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = new Map();
    this.className = "";
    this.style = {};
    this.disabled = false;
    this.hidden = false;
    this._text = "";
    this._html = "";
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => !names.includes(name)).join(" "); },
      toggle: (name, force) => {
        const enabled = force === undefined ? !this.classList.contains(name) : Boolean(force);
        this.classList[enabled ? "add" : "remove"](name);
        return enabled;
      }
    };
  }
  clear() { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ""; this._html = ""; }
  set textContent(value) { this.clear(); this._text = String(value ?? ""); }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  set innerHTML(value) { this.clear(); this._html = String(value); this.ownerDocument.htmlWrites.push(this._html); }
  get innerHTML() { return this._html; }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentNode?.isConnected); }
  get childElementCount() { return this.children.length; }
  get parentElement() { return this.parentNode; }
  append(...children) {
    for (let child of children.flat()) {
      if (typeof child === "string") { const text = new Element("#text", this.ownerDocument); text.textContent = child; child = text; }
      child.remove();
      child.parentNode = this;
      this.children.push(child);
    }
  }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.clear(); this.append(...children); }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
  contains(child) { return child === this || this.children.some((node) => node.contains(child)); }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name.startsWith("data-")) this.dataset[dataName(name)] = String(value);
    if (name === "class") this.className = String(value);
    if (name === "disabled") this.disabled = true;
  }
  getAttribute(name) { return name.startsWith("data-") ? this.dataset[dataName(name)] ?? null : this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); if (name === "disabled") this.disabled = false; }
  matches(selector) {
    return selector.split(",").some((part) => {
      const value = part.trim();
      if (value.startsWith(".")) return value.slice(1).split(".").every((name) => this.classList.contains(name));
      const attr = value.match(/^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
      if (attr) return this.getAttribute(attr[1]) !== null && (attr[2] === undefined || this.getAttribute(attr[1]) === attr[2]);
      const tagClass = value.match(/^([\w-]+)\.([\w-]+)$/);
      if (tagClass) return this.tagName.toLowerCase() === tagClass[1] && this.classList.contains(tagClass[2]);
      return this.tagName.toLowerCase() === value.toLowerCase();
    });
  }
  querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  click() { if (!this.disabled) this.dispatchEvent(new FixtureEvent("click", { bubbles: true })); }
}

export function createVisionHarness(productionSource, toolContext = {}) {
  // The sole source transformation removes the ES export for VM evaluation.
  // No private function is exposed, replaced, or called by this harness.
  assert(productionSource.includes("export function createToolViews(context)"));
  const document = new Events();
  document.htmlWrites = [];
  document.createElement = (tag) => new Element(tag, document);
  document.body = document.createElement("body");
  document.querySelector = (selector) => document.body.querySelector(selector);
  const window = new Events();
  document.defaultView = window;
  const timers = new Map();
  let timerId = 0;
  window.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; };
  window.clearTimeout = (id) => timers.delete(id);
  window.location = { assign() {} };
  let confirmed = true;
  const confirms = [];
  window.confirm = (message) => { confirms.push(message); return confirmed; };
  const calls = [];
  const responses = new Map();
  let sessions = [];
  let activeActions = 0;
  let maximumActiveActions = 0;
  const defaults = {
    listSessions: () => ({ sessions }),
    startDocumentScan: () => ({ canceled: true, discarded: true, preserved: false }),
    startFaceVerification: () => ({ canceled: true, discarded: true, preserved: false }),
    openSession: () => ({ canceled: false }),
    resumeSession: () => ({ canceled: false, kind: "id-card", fileCount: 2 }),
    deleteSession: () => ({ deleted: true })
  };
  const plugin = Object.fromEntries(Object.keys(defaults).map((method) => [method, async (options) => {
    calls.push({ method, options: options === undefined ? undefined : structuredClone(options) });
    const action = method !== "listSessions";
    if (action) { activeActions += 1; maximumActiveActions = Math.max(maximumActiveActions, activeActions); }
    try {
      const queued = responses.get(method)?.shift();
      if (queued instanceof Error) throw queued;
      const result = queued === undefined ? defaults[method]() : typeof queued === "function" ? queued(options) : queued;
      return await (result?.promise || result);
    } finally { if (action) activeActions -= 1; }
  }]));
  window.Capacitor = { Plugins: { FanHaoVisionExploration: plugin } };
  const els = Object.fromEntries(["viewContent", "viewKicker", "viewTitle", "viewMeta"].map((key) => [key, document.createElement("div")]));
  document.body.append(...Object.values(els));
  const sandbox = vm.createContext({ window, document, console, Intl, Date, Number, String, Object, Array, Map, Set, Promise, Error, CustomEvent: FixtureEvent, Element });
  vm.runInContext(productionSource.replace("export function createToolViews", "function createToolViews"), sandbox, { filename: "tool-views-under-test.js" });
  const api = sandbox.createToolViews({ els, setActiveBottom() {}, openSettings() {}, ...toolContext });
  return {
    api, window, document, els, plugin, calls, confirms, timers,
    setSessions(value) { sessions = value; },
    setConfirm(value) { confirmed = value; },
    enqueue(method, value) { if (!responses.has(method)) responses.set(method, []); responses.get(method).push(value); },
    count(method) { return calls.filter((call) => call.method === method).length; },
    get maximumActiveActions() { return maximumActiveActions; },
    async render() { api.renderTools(); await settle(); },
    leave() {
      window.dispatchEvent(new FixtureEvent("fanhaoViewWillRender", { detail: { view: "music" } }));
      els.viewContent.textContent = "OTHER PAGE MUST STAY UNCHANGED";
      window.dispatchEvent(new FixtureEvent("fanhaoViewChanged", { detail: { view: "music" } }));
    },
    rows() { return els.viewContent.querySelectorAll(".vision-exploration-session"); },
    status() { return els.viewContent.querySelector(".vision-exploration-status"); },
    button(pattern, scope = els.viewContent) { return scope?.querySelectorAll("button").find((button) => pattern.test(button.textContent)) || null; },
    click(button) { assert(button, "Expected a public rendered button"); button.click(); }
  };
}
