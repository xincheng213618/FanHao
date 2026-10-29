import assert from "node:assert/strict";
import { createShortVideoTranscodeStatusView } from "../public/modules/short-videos/transcode-status-view.js";

// Real status-view factory, native event targets, controlled DOM/requests and
// timers. No service, FFmpeg, database, media or real cache cleanup is used.
class Hub extends EventTarget {
  constructor() { super(); this.handlers = new Map(); }
  addEventListener(name, callback, options) {
    super.addEventListener(name, callback, options);
    const handlers = this.handlers.get(name) || new Set(); handlers.add(callback); this.handlers.set(name, handlers);
  }
  removeEventListener(name, callback, options) {
    super.removeEventListener(name, callback, options); this.handlers.get(name)?.delete(callback);
  }
  listenerCount() { return [...this.handlers.values()].reduce((sum, handlers) => sum + handlers.size, 0); }
}
class Element extends Hub {
  constructor(tag, metrics) {
    super(); this.tagName = tag.toUpperCase(); this.metrics = metrics; this.children = []; this.parentElement = null;
    this.className = ""; this.ownText = ""; this.attributes = new Map(); this.style = {}; this.dataset = {};
    this.classList = { contains: name => this.className.split(/\s+/).includes(name), toggle: (name, active) => {
      metrics.writes++; const names = new Set(this.className.split(/\s+/).filter(Boolean));
      active ??= !names.has(name); if (active) names.add(name); else names.delete(name); this.className = [...names].join(" ");
    } };
  }
  get isConnected() { return this.connected || Boolean(this.parentElement?.isConnected); }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(""); }
  set textContent(value) { this.metrics.writes++; this.children.forEach(child => { child.parentElement = null; }); this.children = []; this.ownText = String(value); }
  setAttribute(name, value) { this.metrics.writes++; this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); this.metrics.writes++; } }
  prepend(...nodes) { for (const node of [...nodes].reverse()) { node.remove(); node.parentElement = this; this.children.unshift(node); this.metrics.writes++; } }
  replaceChildren(...nodes) { this.children.slice().forEach(child => child.remove()); this.ownText = ""; this.append(...nodes); }
  remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; this.metrics.writes++; } }
  replaceWith(next) {
    const parent = this.parentElement; if (!parent) return; const index = parent.children.indexOf(this);
    next.remove(); parent.children[index] = next; next.parentElement = parent; this.parentElement = null; this.metrics.writes++;
  }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  querySelectorAll(selector) {
    const matches = node => selector.startsWith(".") ? node.classList.contains(selector.slice(1))
      : selector === "details[open]" ? node.tagName === "DETAILS" && node.open
        : node.tagName.toLowerCase() === selector;
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  click() { if (!this.disabled) this.dispatchEvent(new Event("click")); }
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function settle() { for (let turn = 0; turn < 30; turn++) await Promise.resolve(); }
const status = (title = "current", pausedByUser = false, jobs = true) => ({ smooth: { pausedByUser, concurrency: 1,
  activeJobs: jobs ? [{ id: title, title, source: { path: "fixture-source" }, target: { path: "fixture-target" } }] : [], pipeline: {} } });
function fixture({ abortReads = false } = {}) {
  const metrics = { writes: 0, created: 0 }, requests = [], intervals = new Map(), timers = new Map(), alerts = [], copies = [];
  const doc = new Hub(), win = new Hub(); let timerSequence = 0, selection = null;
  doc.createElement = tag => { metrics.created++; return new Element(tag, metrics); }; doc.hidden = false;
  doc.body = doc.createElement("body"); doc.body.connected = true;
  win.setInterval = callback => { const id = timerSequence++; intervals.set(id, callback); return id; };
  win.clearInterval = id => intervals.delete(id);
  win.setTimeout = callback => { const id = timerSequence++; timers.set(id, callback); return id; };
  win.clearTimeout = id => timers.delete(id);
  win.getSelection = () => selection; win.confirm = () => true; win.alert = message => alerts.push(message);
  globalThis.document = doc; globalThis.window = win;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: text => {
    const request = { ...deferred(), text }; copies.push(request); return request.promise;
  } } } });
  const container = doc.createElement("main"); doc.body.append(container);
  const view = createShortVideoTranscodeStatusView({ api: (path, options) => {
    const request = { ...deferred(), path, options }; requests.push(request);
    if (abortReads && options?.signal) options.signal.addEventListener("abort", () => request.reject(Object.assign(new Error("read aborted"), { name: "AbortError" })), { once: true });
    return request.promise;
  }, formatBytes: String });
  let root = null;
  const mount = () => root = view.mount(container);
  const snapshot = () => ({ writes: metrics.writes, created: metrics.created, requests: requests.length, alerts: [...alerts],
    copies: copies.length, timers: timers.size, intervals: intervals.size, text: root?.textContent });
  return { view, doc, win, requests, intervals, timers, copies, alerts, container, mount, snapshot,
    current: () => root, tick: () => { for (const callback of [...intervals.values()]) callback(); },
    close() { view.stopPolling(); },
    select(node) { selection = node ? { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ commonAncestorContainer: node }) } : null; doc.dispatchEvent(new Event("selectionchange")); },
    pointerDown() { const event = new Event("pointerdown"); Object.defineProperty(event, "target", { value: root.querySelector(".short-video-transcode-content") }); root.dispatchEvent(event); },
    hidden(value) { doc.hidden = value; doc.dispatchEvent(new Event("visibilitychange")); }
  };
}

let groups = 0;
for (const completion of ["resolve", "reject"]) {
  const f = fixture(); f.mount(); const oldInterval = [...f.intervals.values()][0]; f.close(); const root = f.mount();
  assert.equal(f.requests[0].options.signal.aborted, true, "stop physically cancels its GET when the adapter supports abort");
  assert.equal(f.requests[1].options.signal.aborted, false);
  assert.equal(f.requests.length, 2, "remount starts its own read without waiting for a retired mount's promise");
  const before = f.snapshot();
  f.requests[0][completion](completion === "resolve" ? status("old-read") : new Error("old read failed")); await settle();
  assert.deepEqual(f.snapshot(), before, "retired reads and finally blocks cannot write into the current mount");
  oldInterval(); assert.equal(f.requests.length, 2, "an already-queued retired interval cannot poll the new mount");
  f.requests[1].resolve(status("fresh-read")); await settle();
  assert(root.textContent.includes("fresh-read")); assert(!root.textContent.includes("old-read"));
  f.tick(); assert.equal(f.requests.length, 3, "the current mount resumes polling normally"); f.close(); groups++;
}
{
  const f = fixture();
  for (let index = 0; index < 8; index++) {
    f.mount(); assert.equal(f.win.listenerCount(), 3); assert.equal(f.doc.listenerCount(), 2);
    const oldRefresh = f.current().querySelector(".short-video-transcode-refresh"); f.close(); f.close();
    assert.equal(f.win.listenerCount(), 0); assert.equal(f.doc.listenerCount(), 0); assert.equal(f.intervals.size, 0);
    const before = f.snapshot(); f.win.dispatchEvent(new Event("pointerup")); f.win.dispatchEvent(new Event("blur"));
    f.doc.dispatchEvent(new Event("selectionchange")); oldRefresh.click();
    assert.deepEqual(f.snapshot(), before, "stop removes global listeners and gates controls even when the old root remains connected");
  }
  groups++;
}
for (const operation of ["control", "cleanup"]) {
  for (const completion of ["resolve", "reject"]) {
    const f = fixture(); f.mount(); f.requests[0].resolve(status("initial", false, false)); await settle();
    f.current().querySelector(operation === "control" ? ".short-video-transcode-run-control" : ".short-video-transcode-cache-clear").click();
    assert.equal(f.requests[1].options.method, "POST"); f.close(); const root = f.mount();
    assert.equal(f.requests[1].options.signal, undefined, "stop must not cancel an already-submitted server mutation");
    f.requests[2].resolve(status("new-view", true, false)); await settle(); const before = f.snapshot();
    f.requests[1][completion](completion === "resolve" ? { status: status("obsolete-mutation"), removed: { removedCount: 2, removedBytes: 123 } } : new Error("obsolete mutation failed"));
    await settle(); assert.deepEqual(f.snapshot(), before, "a submitted server mutation may complete but its retired UI cannot render, alert or reset the new mount's busy state");
    assert(root.textContent.includes("后台转码已手动停止")); f.close(); groups++;
  }
}
{
  const f = fixture(); f.mount(); f.requests[0].resolve(status("initial", false, false)); await settle();
  const oldCleanup = f.current().querySelector(".short-video-transcode-cache-clear"), oldControl = f.current().querySelector(".short-video-transcode-run-control");
  f.close(); oldCleanup.click(); oldControl.click(); assert.equal(f.requests.length, 1, "disposed controls cannot submit new operations"); groups++;
}
for (const operation of ["control", "cleanup"]) {
  const f = fixture(); f.mount(); f.requests[0].resolve(status("initial", false, false)); await settle();
  f.tick(); assert.equal(f.requests.length, 2);
  f.current().querySelector(operation === "control" ? ".short-video-transcode-run-control" : ".short-video-transcode-cache-clear").click();
  assert.equal(f.requests.length, 3); f.tick(); assert.equal(f.requests.length, 3, "polling waits while the current mutation is pending");
  f.requests[2].resolve({ status: status("after-mutation", true, false), removed: { removedCount: 1 } }); await settle();
  assert(f.current().textContent.includes("后台转码已手动停止"));
  f.requests[1].resolve(status("before-mutation", false, false)); await settle();
  assert(f.current().textContent.includes("后台转码已手动停止"), "a GET issued before POST cannot overwrite the accepted mutation status");
  assert(!f.current().textContent.includes("before-mutation"));
  f.tick(); assert.equal(f.requests.length, 4); f.close(); groups++;
}
{
  const f = fixture(); f.mount(); f.requests[0].resolve(status("initial", false, false)); await settle();
  f.current().querySelector(".short-video-transcode-refresh").click();
  f.current().querySelector(".short-video-transcode-run-control").click();
  assert.equal(f.requests[1].options.signal.aborted, true, "a mutation releases and aborts the older status read");
  f.requests[2].resolve({ status: status("paused", true, false) }); await settle();
  f.tick(); assert.equal(f.requests.length, 4, "a hung pre-mutation GET cannot block fresh polling after POST acknowledgement");
  const refresh = f.current().querySelector(".short-video-transcode-refresh");
  f.requests[1].resolve(status("obsolete", false, false)); await settle();
  f.tick(); assert.equal(f.requests.length, 4, "the old read's finally cannot unlock a newer pending refresh");
  assert(f.current().textContent.includes("后台转码已手动停止"));
  f.requests[3].resolve(status("fresh", true, false)); await settle();
  assert.equal(refresh.disabled, false); assert.equal(refresh.textContent, "刷新");
  f.tick(); assert.equal(f.requests.length, 5); f.close(); groups++;
}
{
  const f = fixture({ abortReads: true }); f.mount(); f.close(); await settle();
  assert.equal(f.current().querySelector(".short-video-transcode-error"), null, "an abort-aware GET ends silently after stop");
  const root = f.mount(); f.requests[1].resolve(status("live")); await settle();
  assert(root.textContent.includes("live")); f.close(); groups++;
}
for (const boundary of ["remount", "blur", "hidden"]) {
  const f = fixture(); f.mount(); f.requests[0].resolve(status("initial")); await settle(); f.pointerDown();
  f.tick(); assert.equal(f.requests.length, 1);
  if (boundary === "remount") { f.close(); f.mount(); f.requests[1].resolve(status("new")); await settle(); }
  else if (boundary === "blur") f.win.dispatchEvent(new Event("blur"));
  else { f.hidden(true); f.hidden(false); }
  const reads = f.requests.length; f.tick();
  assert.equal(f.requests.length, reads + 1, `${boundary}: a lost pointerup cannot leave polling permanently suspended`);
  assert.equal(f.current().querySelector(".short-video-transcode-auto-refresh").textContent, "暂停更新"); f.close(); groups++;
}
{
  const f = fixture(); f.mount(); f.requests[0].resolve(status("initial")); await settle();
  f.hidden(true); for (let index = 0; index < 8; index++) f.tick(); assert.equal(f.requests.length, 1);
  f.hidden(false); f.tick(); assert.equal(f.requests.length, 2, "visibility restoration permits the next scheduled refresh");
  f.requests[1].resolve(status("visible")); await settle(); f.close(); groups++;
}
for (const interaction of ["selection", "details"]) {
  const f = fixture(); f.mount(); f.requests[0].resolve(status("initial")); await settle();
  const details = f.current().querySelector("details");
  if (interaction === "selection") f.select(details); else details.open = true;
  f.pointerDown(); f.win.dispatchEvent(new Event("blur")); f.tick();
  assert.equal(f.requests.length, 1, "releasing a lost pointer does not override a real selection or expanded paths");
  if (interaction === "selection") f.select(null); else details.open = false;
  f.tick(); assert.equal(f.requests.length, 2); f.close(); groups++;
}
for (const completion of ["resolve", "reject"]) {
  const f = fixture(); f.mount(); f.requests[0].resolve(status("copy")); await settle();
  const copy = f.current().querySelector(".short-video-transcode-path-row").querySelector("button"); copy.click();
  assert.equal(f.copies.length, 1); f.close(); const before = f.snapshot();
  f.copies[0][completion](completion === "resolve" ? undefined : new Error("late clipboard rejection")); await settle();
  copy.click(); assert.deepEqual(f.snapshot(), before, "late clipboard settlement cannot write labels, schedule timers or re-enable a disposed copy action"); groups++;
}
{
  const f = fixture(); f.mount(); f.requests[0].resolve(status("copy")); await settle();
  f.current().querySelector(".short-video-transcode-path-row").querySelector("button").click();
  f.copies[0].resolve(); await settle(); assert.equal(f.timers.size, 1); const callback = [...f.timers.values()][0];
  f.close(); assert.equal(f.timers.size, 0); const before = f.snapshot(); callback();
  assert.deepEqual(f.snapshot(), before, "copy-label timers are canceled and already-queued callbacks are harmless"); groups++;
}
{
  const f = fixture(); f.mount(); const data = status("unchanged"); f.requests[0].resolve(data); await settle();
  const current = f.current().querySelector(".short-video-transcode-current"); f.tick(); f.requests[1].resolve(data); await settle();
  assert.equal(f.current().querySelector(".short-video-transcode-current"), current, "unchanged polling preserves job-card DOM and selection targets");
  f.current().querySelector(".short-video-transcode-auto-refresh").click(); f.tick(); assert.equal(f.requests.length, 2);
  f.close(); f.mount(); assert.equal(f.current().querySelector(".short-video-transcode-auto-refresh").textContent, "继续更新", "manual auto-refresh preference survives a remount");
  f.requests[2].resolve(data); await settle(); f.tick(); assert.equal(f.requests.length, 3); f.close(); groups++;
}
console.log(`short-video-transcode-lifecycle: ${groups} actual factory groups passed (mount ownership, mutation/read order, listener/timer cleanup, visibility and interaction)`);
