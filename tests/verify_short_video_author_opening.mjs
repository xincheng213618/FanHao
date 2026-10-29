import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Execute the real opening callbacks and page close lifecycle with independent
// animation-frame and timer gates. No browser, service or real media is used.
const authorSource = fs.readFileSync(new URL("../public/modules/short-videos/author-panel.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const pageSource = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const openStart = authorSource.indexOf("    const commitPanelOpen = () => {");
const openEnd = authorSource.indexOf("    loadAuthorWorks().catch(", openStart);
assert(openStart >= 0 && openEnd > openStart);
const opening = authorSource.slice(openStart, openEnd);
const ownerStart = authorSource.indexOf("  function isCurrentPanel("), ownerEnd = authorSource.indexOf("\n  }", ownerStart);
const owner = authorSource.slice(ownerStart, ownerEnd + 4);
const schedulerStart = authorSource.indexOf("    const frames = new Set();"), schedulerEnd = authorSource.indexOf("    panel.className =", schedulerStart);
assert(ownerStart >= 0 && ownerEnd > ownerStart && schedulerStart >= 0 && schedulerEnd > schedulerStart);
const scheduler = authorSource.slice(schedulerStart, schedulerEnd);
const closeStart = pageSource.indexOf("  function disposeAuthorPanelResources("), closeEnd = pageSource.indexOf("  function resolveAuthorPanelReturnFocus(", closeStart);
assert(closeStart >= 0 && closeEnd > closeStart);
const closing = pageSource.slice(closeStart, closeEnd);

class Element extends EventTarget {
  constructor(classes, focusLog) {
    super(); this.classes = new Set(classes); this.dataset = {}; this.isConnected = true; this.focusLog = focusLog;
    this.classList = {
      add: (...names) => names.forEach(name => this.classes.add(name)),
      remove: (...names) => names.forEach(name => this.classes.delete(name)),
      contains: name => this.classes.has(name)
    };
  }
  closest() { return this.browser || null; }
  querySelectorAll() { return []; }
  remove() { this.isConnected = false; }
  focus() { this.focusLog.push(this); if (this.document) this.document.activeElement = this; }
}

function fixture({ reducedMotion = false } = {}) {
  let clock = 0, sequence = 0, restores = 0, feedRestores = 0;
  const frames = new Map(), timers = new Map(), focuses = [];
  const browser = new Element([], focuses), panel = new Element([], focuses);
  const trigger = new Element([], focuses), tab = new Element([], focuses);
  const document = { activeElement: trigger };
  [browser, panel, trigger, tab].forEach(element => { element.document = document; });
  panel.browser = browser; panel._shortVideoReturnFocus = trigger;
  const env = {
    panel, browser, document, tabButtons: new Map([["works", tab]]), activeTab: "works",
    authorPanelVideoRequestId: 0, authorPanelReturnFeed: {},
    window: {
      requestAnimationFrame(callback) { const id = ++sequence; frames.set(id, callback); return id; },
      setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: clock + delay }); return id; },
      clearTimeout: id => timers.delete(id),
      matchMedia: () => ({ matches: reducedMotion })
    },
    clearAuthorPanelCaches() {},
    releaseUnusedShortVideoPreloads() {},
    cancelShortVideoPanelLoading() {},
    resolveAuthorPanelReturnFocus: () => trigger,
    restoreAuthorPanelModalIsolation() { restores++; },
    restoreAuthorPanelFeed() { feedRestores++; return Promise.resolve(); },
    showError(error) { throw error; }
  };
  const hooks = vm.runInNewContext(`${owner}\n${scheduler}\n${closing}\n${opening}\n({ closeAuthorPanel });`, env);
  const flushFrames = () => {
    const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(clock));
  };
  const advance = duration => {
    const target = clock + duration;
    for (;;) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); clock = next[1].at; next[1].callback();
    }
    clock = target;
  };
  return { browser, panel, trigger, tab, document, focuses, frames, timers, flushFrames, advance,
    close: options => hooks.closeAuthorPanel(panel, options),
    get restores() { return restores; }, get feedRestores() { return feedRestores; } };
}

function assertClosed(f) {
  assert.equal(f.browser.classList.contains("is-author-panel-open"), false);
  if (f.panel.isConnected) assert.equal(f.panel.classList.contains("is-open"), false);
  assert.equal(f.focuses.includes(f.tab), false, "late opening callbacks cannot steal focus during close");
}

{
  const f = fixture();
  f.flushFrames();
  assert(f.browser.classList.contains("is-author-panel-open"));
  assert(f.panel.classList.contains("is-open"));
  assert.equal(f.panel.dataset.openCommitted, "1");
  f.flushFrames();
  assert.deepEqual(f.focuses, [f.tab]);
  const pending = f.frames.size + f.timers.size;
  f.advance(80);
  assert.equal(f.frames.size + f.timers.size, pending - 1, "the 80ms fallback does not commit opening twice");
  f.advance(20);
  assert.deepEqual(f.focuses, [f.tab, f.tab]);
}

{
  const f = fixture();
  f.flushFrames(); f.flushFrames();
  const input = new Element([], f.focuses); input.document = f.document;
  input.focus();
  f.advance(100);
  assert.deepEqual(f.focuses, [f.tab, input], "opening's late fallback preserves the user's newer focus");
  f.close({ animate: false });
}

{
  const f = fixture();
  f.close();
  assert.equal(f.panel.dataset.closing, "1");
  assert.equal(f.panel.isConnected, true, "the closing animation intentionally retains the panel node");
  f.flushFrames(); f.advance(80); f.flushFrames(); f.advance(100);
  assertClosed(f);
  assert.equal(f.panel.dataset.openCommitted, undefined, "neither rAF nor timer can reopen a panel already closing");
  f.advance(820);
  assert.equal(f.panel.isConnected, false);
  assert.deepEqual(f.focuses, [f.trigger]);
  assert.equal(f.restores, 1); assert.equal(f.feedRestores, 1);
}

{
  const f = fixture();
  f.flushFrames(); // The panel committed, but its tab-focus callbacks are pending.
  f.close();
  f.flushFrames(); f.advance(100);
  assertClosed(f);
  f.advance(900);
  assert.deepEqual(f.focuses, [f.trigger]);
  f.flushFrames(); f.advance(100);
  assert.equal(f.browser.classList.contains("is-author-panel-open"), false);
  assert.deepEqual(f.focuses, [f.trigger]);
}

{
  const f = fixture();
  f.advance(80); // Test the opening fallback independently from rAF delivery.
  assert(f.panel.classList.contains("is-open"));
  f.close();
  f.flushFrames(); f.advance(100);
  assertClosed(f);
  f.advance(900);
  assert.deepEqual(f.focuses, [f.trigger]);
}

for (const reducedMotion of [false, true]) {
  const f = fixture({ reducedMotion });
  f.flushFrames();
  assert(f.panel.classList.contains("is-open"), "opening remains available with either motion preference");
  f.close(reducedMotion ? undefined : { animate: false });
  assert.equal(f.panel.isConnected, false, "reduced motion and explicit nonanimated close finish immediately");
  f.flushFrames(); f.advance(1000);
  assertClosed(f);
  assert.deepEqual(f.focuses, [f.trigger]);
  assert.equal(f.restores, 1); assert.equal(f.feedRestores, 1);
}

console.log("short-video-author-opening: rAF/timer opening, dismissal races, focus ownership and reduced motion passed");
