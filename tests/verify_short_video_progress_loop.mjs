import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createShortVideoProgressLoop } from "../public/modules/short-videos/progress-loop-controller.js";

// Native video callbacks and RAF retain their queued callback after cancellation
// so that late delivery can be exercised. No media, service or browser is used.
function fixture({ native = true, intervalMs = 30, create = createShortVideoProgressLoop } = {}) {
  let sequence = 0, connected = true, current;
  let progressHandler = () => {};
  const frames = new Map(), history = new Map(), cancelled = [], progress = [];
  const register = (kind, player, callback) => {
    const handle = sequence++;
    const frame = { handle, kind, player, callback };
    frames.set(handle, frame); history.set(handle, frame);
    return handle;
  };
  const cancel = (kind, handle) => { cancelled.push({ kind, handle }); frames.delete(handle); };
  const requestFrame = callback => register("raf", null, callback);
  const cancelFrame = handle => cancel("raf", handle);
  const player = id => {
    const classes = new Set();
    const element = {
      id, src: `/fixture/${id}`, currentSrc: `/fixture/${id}`, isConnected: true,
      paused: false, ended: false, error: null,
      dataset: { videoId: id, shortVideoSourceGeneration: "1", shortVideoSlot: "current",
        shortVideoPromotedAt: "1", shortVideoWarmScheduleToken: "1", shortVideoPlaybackIntentGeneration: "0" },
      classList: { contains: name => classes.has(name), add: name => classes.add(name) },
      getAttribute(name) { return name === "src" ? this.src : null; }
    };
    if (native) {
      element.requestVideoFrameCallback = callback => register("video", element, callback);
      element.cancelVideoFrameCallback = handle => cancel("video", handle);
    }
    return element;
  };
  const a = player("A"), b = player("B"); current = a;
  const options = { getPlayer: () => current, isConnected: () => connected, intervalMs, requestFrame, cancelFrame,
    onProgress: (element, timestamp) => { progress.push({ player: element, timestamp }); progressHandler(element, timestamp); } };
  const controller = create(options);
  const pending = () => [...frames.keys()];
  const first = () => pending()[0];
  const fire = (handle = first(), timestamp = 0) => {
    assert(frames.has(handle), `no pending frame ${handle}`);
    const frame = frames.get(handle); frames.delete(handle); frame.callback(timestamp);
  };
  const late = (handle, timestamp = 0) => { assert(history.has(handle)); history.get(handle).callback(timestamp); };
  return { controller, options, a, b, frames, history, cancelled, progress, requestFrame, cancelFrame,
    register, pending, first, fire, late, current: () => current,
    setCurrent: element => { current = element; }, setConnected: value => { connected = value; },
    onProgress: handler => { progressHandler = handler; } };
}

for (const native of [true, false]) {
  const f = fixture({ native });
  assert.deepEqual(f.pending(), [], "construction must not request a frame or paint");
  assert.deepEqual(f.progress, []);
  f.controller.sync();
  assert.equal(f.first(), 0, "zero is a valid native/RAF registration handle");
  assert.equal(f.frames.get(0).kind, native ? "video" : "raf");
  for (let count = 0; count < 20; count++) f.controller.sync();
  assert.deepEqual(f.pending(), [0], "ordinary repeated sync retains a single pending frame");
  f.fire(0, 0); f.fire(f.first(), 10); f.fire(f.first(), 29); f.fire(f.first(), 30); f.fire(f.first(), 60);
  assert.deepEqual(f.progress.map(item => item.timestamp), [0, 30, 60], "progress painting keeps the existing 30ms interval, including a first timestamp of zero");
  assert(f.progress.every(item => item.player === f.a));
  const queued = f.first(); f.controller.dispose();
  assert.equal(f.frames.size, 0);
  f.late(queued, 90); f.controller.sync();
  assert.equal(f.frames.size, 0); assert.equal(f.progress.length, 3);
}

for (const native of [true, false]) {
  const f = fixture({ native });
  f.controller.sync(); f.controller.stop();
  assert.deepEqual(f.cancelled, [{ kind: native ? "video" : "raf", handle: 0 }], "stop must cancel numeric zero too");
  f.late(0, 10); f.controller.stop();
  assert.equal(f.frames.size, 0); assert.equal(f.progress.length, 0);
  f.controller.sync(); assert.equal(f.frames.size, 1, "stop is reusable until disposal");
  f.controller.dispose(); f.controller.dispose(); assert.equal(f.frames.size, 0);
}

for (const invalidate of [
  f => { f.a.paused = true; }, f => { f.a.ended = true; },
  f => { f.a.isConnected = false; }, f => f.setConnected(false),
  f => f.setCurrent(null), f => f.a.classList.add("is-ghost"), f => { f.a.error = { code: 3 }; }
]) {
  const f = fixture(); f.controller.sync();
  invalidate(f); f.controller.sync();
  assert.equal(f.frames.size, 0, "paused, ended, detached, ghost or failed media cannot retain frame work");
  f.late(0, 100);
  assert.equal(f.frames.size, 0); assert.equal(f.progress.length, 0);
}

function verifyLatePreviousPlayer(create = createShortVideoProgressLoop) {
  const f = fixture({ create }); f.controller.sync(); const old = f.first();
  f.setCurrent(f.b); f.controller.sync(); const next = f.pending();
  assert.equal(f.frames.get(f.first()).player, f.b);
  f.late(old, 100);
  assert.deepEqual(f.pending(), next, "a queued old callback must not clear, cancel or replace the new media's pending handle");
  assert.equal(f.progress.length, 0);
  f.fire(f.first(), 101);
  assert.equal(f.progress.length, 1); assert.equal(f.progress[0].player, f.b);
  f.controller.dispose();
}
verifyLatePreviousPlayer();

{
  const f = fixture(); f.controller.sync(); const completed = f.first();
  f.fire(completed, 100); const next = f.pending();
  f.late(completed, 130);
  assert.deepEqual(f.pending(), next, "duplicate delivery of a completed frame cannot clear a newer frame of the same job");
  assert.equal(f.progress.length, 1);
  f.controller.dispose();
}

for (const changeIdentity of [
  player => { player.src = "/fixture/reloaded"; },
  player => { player.dataset.shortVideoSourceGeneration = "2"; },
  player => { player.dataset.videoId = "C"; },
  player => { player.dataset.shortVideoSlot = "next"; },
  player => { player.dataset.shortVideoPromotedAt = "2"; },
  player => { player.dataset.shortVideoWarmScheduleToken = "2"; },
  player => { player.dataset.shortVideoPlaybackIntentGeneration = "1"; }
]) {
  const f = fixture(); f.controller.sync(); const old = f.first();
  changeIdentity(f.a); f.controller.sync(); const next = f.pending();
  assert.notEqual(next[0], old, "same-element source and role changes establish a fresh frame owner");
  f.late(old, 100); assert.deepEqual(f.pending(), next); assert.equal(f.progress.length, 0);
  f.fire(f.first(), 101); assert.equal(f.progress.length, 1);
  f.controller.dispose();
}

{
  const f = fixture(); f.controller.sync();
  f.a.muted = true; f.a.volume = .2; f.a.playbackRate = 2; f.controller.sync();
  assert.deepEqual(f.pending(), [0], "volume and speed changes do not restart the progress frame chain");
  f.setCurrent(f.b); f.fire(0, 100);
  assert.equal(f.progress.length, 0, "an unannounced media replacement cannot be painted by the old callback");
  assert.equal(f.frames.size, 1); assert.equal(f.frames.get(f.first()).player, f.b);
  f.controller.dispose();
}

{
  const f = fixture(); f.controller.sync();
  f.a.dataset.shortVideoSourceGeneration = "2"; f.fire(0, 100);
  assert.equal(f.progress.length, 0);
  assert.equal(f.frames.size, 1, "a source reset detected by a frame creates a fresh owner without painting the stale one");
  f.fire(f.first(), 101); assert.equal(f.progress.length, 1);
  f.controller.dispose();
}

for (const action of ["sync", "stop-sync", "replace-sync", "replace", "reload", "dispose", "sync-dispose", "pause"]) {
  const f = fixture();
  f.onProgress(() => {
    if (action === "sync") { f.controller.sync(); f.controller.sync(); }
    if (action === "stop-sync") { f.controller.stop(); f.controller.sync(); }
    if (action === "replace-sync") { f.setCurrent(f.b); f.controller.sync(); }
    if (action === "replace") f.setCurrent(f.b);
    if (action === "reload") f.a.src = "/fixture/new-source";
    if (action === "dispose") f.controller.dispose();
    if (action === "sync-dispose") { f.controller.sync(); f.controller.dispose(); }
    if (action === "pause") { f.controller.sync(); f.a.paused = true; f.controller.sync(); }
  });
  f.controller.sync(); f.fire(0, 100);
  const stopped = ["dispose", "sync-dispose", "pause"].includes(action);
  assert.equal(f.frames.size, stopped ? 0 : 1, `reentrant ${action} leaves exactly the surviving single chain`);
  if (action.startsWith("replace")) assert.equal(f.frames.get(f.first()).player, f.b);
  f.late(0, 130);
  assert.equal(f.frames.size, stopped ? 0 : 1, `late original delivery cannot affect reentrant ${action}`);
  assert.equal(f.progress.length, 1);
  f.controller.dispose();
}

{
  const f = fixture();
  f.a.requestVideoFrameCallback = callback => {
    const handle = f.register("video", f.a, callback);
    f.controller.stop();
    return handle;
  };
  f.controller.sync();
  assert.equal(f.frames.size, 0, "reentrant stop during registration cancels the returned handle even before it was known");
  assert.deepEqual(f.cancelled, [{ kind: "video", handle: 0 }]);
}

// A mutation of the actual controller must be caught by the late-frame test.
// No copied legacy implementation is kept merely to make a test pass.
{
  const source = fs.readFileSync(new URL("../public/modules/short-videos/progress-loop-controller.js", import.meta.url), "utf8");
  const guard = "if (disposed || current !== owner || owner.frame !== frame) return;";
  assert(source.includes(guard));
  const mutated = source.replace("export function", "function").replace(guard, "");
  const create = vm.runInNewContext(`${mutated}\ncreateShortVideoProgressLoop;`);
  assert.throws(() => verifyLatePreviousPlayer(create), error => error.code === "ERR_ASSERTION",
    "negative control: removing the pre-clear frame ownership guard must fail the replacement-handle assertion");
}

// Exercise the current page's constructor, public sync and disposal wrappers.
{
  const page = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8");
  const start = page.indexOf("    const progressLoop = createShortVideoProgressLoop({");
  const end = page.indexOf('    play.addEventListener("click"', start);
  const syncStart = page.indexOf("    bar.shortVideoSync = () => {", end);
  const syncEnd = page.indexOf("    window.requestAnimationFrame(() => bar.shortVideoSync?.());", syncStart);
  assert(start >= 0 && end > start && syncStart > end && syncEnd > syncStart);
  const f = fixture(); f.controller.dispose();
  const bar = { isConnected: true };
  let fullSyncs = 0, progressSyncs = 0;
  const env = {
    bar, activePlayer: f.current,
    createShortVideoProgressLoop: options => createShortVideoProgressLoop({ ...options,
      requestFrame: f.requestFrame, cancelFrame: f.cancelFrame }),
    syncProgress: player => { assert.equal(player, f.current()); progressSyncs++; },
    sync: () => { fullSyncs++; }, setVolumePopoverOpen() {},
    seekController: { dispose() {} }, bufferedProgress: { dispose() {} }, detachBufferedPlayer() {},
    window: { removeEventListener() {} }, closeVolumeFromOutside() {}
  };
  vm.runInNewContext(`${page.slice(start, end)}\n${page.slice(syncStart, syncEnd)}`, env);
  bar.shortVideoSync(); assert.equal(fullSyncs, 1); assert.equal(f.frames.size, 1);
  f.fire(f.first(), 100); assert.equal(progressSyncs, 1); assert.equal(f.frames.size, 1);
  const pending = f.first(); bar.shortVideoDispose();
  assert.equal(f.frames.size, 0);
  f.late(pending, 130); bar.shortVideoSync();
  assert.equal(f.frames.size, 0, "disposing the real page wrapper prevents reactivation by queued callbacks or later sync");
  assert.equal(progressSyncs, 1);
}

console.log("short-video-progress-loop: native/RAF interval, zero handles, media/frame ownership, reentrancy, page wiring and negative control passed");
