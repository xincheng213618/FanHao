import assert from "node:assert/strict";
import fs from "node:fs";

// Reuse the existing controlled DOM/media fixture with the real controller.
// Count property mutations and geometry reads rather than timing a mock UI.
const helpersFile = new URL("./verify_short_video_seek.mjs", import.meta.url);
let helpers = fs.readFileSync(helpersFile, "utf8");
helpers = helpers.slice(0, helpers.indexOf("\n{\n  const f = fixture"));
helpers = helpers.replace(/from "(\.\.\/public\/[^\"]+)"/g, (_, relative) => `from "${new URL(relative, helpersFile).href}"`);
const { fixture, Media } = await import(`data:text/javascript;base64,${Buffer.from(`${helpers}\nexport { fixture, Media };`).toString("base64")}`);

function measure(f) {
  let rectReads = 0;
  const writes = new Map(), distinct = new Map(), trace = [];
  const write = (name, value) => {
    writes.set(name, (writes.get(name) || 0) + 1);
    if (!distinct.has(name)) distinct.set(name, new Set());
    distinct.get(name).add(String(value));
    trace.push(`write:${name}`);
  };
  const property = (object, name, label) => {
    let value = object[name];
    Object.defineProperty(object, name, {
      configurable: true, get: () => value,
      set(next) { write(label, next); value = next; }
    });
  };
  const rect = f.progress.getBoundingClientRect.bind(f.progress);
  f.progress.getBoundingClientRect = () => { rectReads += 1; trace.push("read:rect"); return rect(); };
  property(f.progress, "value", "value");
  property(f.progress, "disabled", "disabled");
  property(f.time, "textContent", "time");
  property(f.seekPreview, "textContent", "preview-text");
  property(f.seekPreview.style, "left", "preview-left");
  const css = f.progress.style.setProperty.bind(f.progress.style);
  f.progress.style.setProperty = (name, value) => { write("css", value); css(name, value); };
  const attribute = f.progress.setAttribute.bind(f.progress);
  f.progress.setAttribute = (name, value) => {
    if (name === "aria-valuetext") write("aria", value);
    attribute(name, value);
  };
  return {
    writes, distinct, trace,
    get rectReads() { return rectReads; },
    get totalWrites() { return [...writes.values()].reduce((total, count) => total + count, 0); },
    reset() { rectReads = 0; writes.clear(); distinct.clear(); trace.length = 0; }
  };
}

{
  const f = fixture(), metrics = measure(f);
  for (let frame = 0; frame < 60; frame++) {
    f.player._time = 12 + frame / 60;
    f.controller.sync();
  }
  assert.equal(metrics.rectReads, 0, "normal playback must not measure a hidden seek preview (previously 60 reads)");
  for (const property of ["disabled", "time", "aria", "preview-text"]) {
    assert.equal(metrics.writes.get(property), 1, `${property}: a stable value is assigned once across sixty syncs`);
  }
  assert.equal(metrics.writes.get("preview-left") || 0, 0, "a hidden preview needs no position updates");
  assert.equal(metrics.writes.get("value"), metrics.distinct.get("value").size, "the native range is assigned only when its rounded position changes");
  assert.equal(metrics.writes.get("css"), 60, "fractional playback progress remains smooth rather than being reduced to second ticks");
  assert(metrics.totalWrites < 100, `value-aware playback rendering must remove the former 420 writes; saw ${metrics.totalWrites}`);
  const before = metrics.totalWrites;
  f.controller.sync();
  assert.equal(metrics.totalWrites, before, "an identical playback snapshot produces no DOM mutations");
  f.controller.dispose();
}

{
  const f = fixture(), metrics = measure(f);
  f.event("pointerdown", { clientX: 200 });
  assert.equal(f.progress.value, "250", "pointer down still gives immediate visual feedback");
  metrics.reset();
  for (let move = 0; move < 30; move++) f.event("pointermove", { clientX: 300 + move });
  assert.equal(metrics.rectReads, 0);
  assert.equal(metrics.totalWrites, 0, "thirty move events coalesce their visual work into the pending frame");
  assert.equal(f.frames.size, 1);
  f.flushFrame();
  assert.equal(metrics.rectReads, 1, "the latest drag sample and its preview share one fresh measurement (previously 60)");
  assert.equal(metrics.trace[0], "read:rect");
  assert(metrics.trace.slice(1).every(value => value.startsWith("write:")), "the frame reads geometry before writing its visual state");
  assert(metrics.totalWrites <= 6, "one combined render replaces the former 180 per-event writes");
  assert.equal(f.player.fast.length, 1);
  assert.equal(f.player.currentTime, 57.25);
  f.controller.dispose();
}

{
  const f = fixture(), metrics = measure(f);
  f.event("pointerenter", { clientX: 200 });
  metrics.reset();
  for (let move = 0; move < 30; move++) f.event("pointermove", { clientX: 300 + move });
  assert.equal(metrics.rectReads, 0);
  assert.equal(metrics.totalWrites, 0);
  f.flushFrame();
  assert.equal(metrics.rectReads, 1);
  assert.equal(metrics.totalWrites, 2, "hover moves update only the final preview text and position");
  assert.equal(metrics.trace[0], "read:rect");
  assert.equal(f.seekPreview.textContent, "t57");
  const position = f.seekPreview.style.left;
  metrics.reset();
  for (const current of [20, 40, 60]) { f.player._time = current; f.controller.sync(); }
  assert.equal(metrics.rectReads, 0);
  assert.equal(metrics.writes.get("preview-text") || 0, 0);
  assert.equal(metrics.writes.get("preview-left") || 0, 0);
  assert.equal(f.seekPreview.style.left, position, "playback updates cannot move the user's hovered target");
  f.controller.dispose();
}

{
  const f = fixture(), metrics = measure(f);
  f.event("pointerdown", { clientX: 200 });
  f.event("pointermove", { clientX: 420 });
  f.progress.rect = { left: 100, width: 800 };
  metrics.reset();
  f.flushFrame();
  assert.equal(f.player.currentTime, 40, "the frame uses fresh geometry after layout changes during the drag");
  assert.equal(metrics.rectReads, 1);
  f.progress.rect = { left: 0, width: 1000 };
  metrics.reset();
  f.event("pointerup", { clientX: 555 });
  assert(Math.abs(f.player.currentTime - 55.5) < 1e-9, "release rereads current geometry and makes an exact final seek");
  assert(Math.abs(f.player.exact.at(-1) - 55.5) < 1e-9);
  assert.equal(metrics.rectReads, 1, "release's fresh measurement is reused rather than read again during cleanup");
  assert.equal(f.frames.size, 0);
  assert.equal(f.progress.captures.size, 0);
  f.controller.dispose();
}

for (const invalidate of [
  f => f.replacePlayer(new Media("b")),
  f => { f.player.dataset.shortVideoSourceGeneration = "2"; },
  f => { f.player.shortVideoSetPlaybackIntent(false); f.player.pause(); }
]) {
  const f = fixture();
  f.event("pointerdown");
  f.event("pointermove", { clientX: 420 });
  const mediaWrites = f.player.fast.length + f.player.exact.length, plays = f.player.playCalls;
  invalidate(f);
  const metrics = measure(f);
  f.flushFrame();
  assert.equal(f.frames.size, 0);
  assert.equal(f.controller.isScrubbing(), false, "the invalidated frame releases its own session immediately without waiting for another sync");
  assert.equal(f.progress.captures.size, 0);
  assert.equal(f.player.fast.length + f.player.exact.length, mediaWrites);
  assert.equal(f.player.playCalls, plays);
  assert.equal(metrics.rectReads, 0, "invalid ownership must not cause a stale geometry read");
  f.controller.dispose();
}

class LayoutEvents extends EventTarget {
  constructor() { super(); this.listeners = new Map(); }
  addEventListener(name, callback) { this.listeners.set(name, callback); super.addEventListener(name, callback); }
  removeEventListener(name, callback) { if (this.listeners.get(name) === callback) this.listeners.delete(name); super.removeEventListener(name, callback); }
}
{
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  const resize = new LayoutEvents(), fullscreen = new LayoutEvents();
  globalThis.window = resize;
  globalThis.document = fullscreen;
  let f;
  try { f = fixture(); } finally { globalThis.window = previousWindow; globalThis.document = previousDocument; }
  f.event("pointerenter", { clientX: 300 });
  f.progress.rect = { left: 100, width: 800 };
  const metrics = measure(f);
  resize.dispatchEvent(new Event("resize"));
  assert.equal(f.frames.size, 1);
  f.flushFrame();
  assert.equal(metrics.rectReads, 1);
  assert.equal(f.seekPreview.textContent, "t25", "resize repositions the preview under the stationary pointer using current geometry");
  f.progress.rect = { left: -100, width: 200 };
  fullscreen.dispatchEvent(new Event("fullscreenchange"));
  f.flushFrame();
  assert.equal(f.seekPreview.textContent, "t100");
  assert.equal(f.player.fast.length + f.player.exact.length, 0, "geometry-only hover updates cannot seek the playing media");
  f.controller.dispose();
  assert.equal(resize.listeners.size, 0);
  assert.equal(fullscreen.listeners.size, 0);
  resize.dispatchEvent(new Event("resize"));
  fullscreen.dispatchEvent(new Event("fullscreenchange"));
  assert.equal(f.frames.size, 0, "disposed controls cannot schedule geometry rendering again");
}

console.log("short-video-seek-rendering: changed-value writes, coalesced geometry/paint, fresh release and owned frame cleanup passed");
