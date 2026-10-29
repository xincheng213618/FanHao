import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { allowShortVideoSpeculativePrewarm } from "../public/modules/short-videos/prewarm-policy.js";

// Execute the current entry's early work and real quiet-window scheduler.
// Guessed media URLs must not start a stream before canonical detail arrives.
const source = fs.readFileSync(new URL("../public/short-video-app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const earlyStart = source.indexOf("const shortVideoPlaybackPrimerPromise =");
const scheduleStart = source.indexOf("function scheduleShortVideoPlaybackDecoderPrimer()");
const primeStart = source.indexOf("function primeShortVideoPlaybackDecoder()");
assert(earlyStart >= 0 && scheduleStart > earlyStart && primeStart > scheduleStart);
const implementation = source.slice(earlyStart, scheduleStart) + source.slice(scheduleStart, primeStart);

function fixture({ route = {}, saveData = false, effectiveType = "4g", idle = true } = {}) {
  let clock = 0, timerSequence = 0, idleSequence = 0, decoded = 0;
  const timers = new Map(), idleCallbacks = new Map(), cancelledIdle = [], marks = [];
  const win = new EventTarget(), doc = new EventTarget();
  doc.hidden = false; doc.visibilityState = "visible";
  const connection = { saveData, effectiveType };
  Object.assign(win, {
    setTimeout(callback, delay) { const id = timerSequence++; timers.set(id, { callback, at: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    ...(idle ? {
      requestIdleCallback(callback) { const id = idleSequence++; idleCallbacks.set(id, callback); return id; },
      cancelIdleCallback(id) { cancelledIdle.push(id); idleCallbacks.delete(id); }
    } : {})
  });
  const context = vm.createContext({
    window: win, document: doc, navigator: { connection }, Date: { now: () => clock }, Promise,
    initialShortVideoRoute: route, allowShortVideoSpeculativePrewarm,
    markShortVideoPerformance: (...args) => marks.push(args),
    primeShortVideoPlaybackDecoder() { decoded++; return Promise.resolve(true); }
  });
  vm.runInContext(`${implementation}\nglobalThis.result=shortVideoPlaybackPrimerPromise;`, context);
  const advance = delta => {
    const target = clock + delta;
    while (true) {
      const next = [...timers.entries()].filter(([, item]) => item.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); clock = next[1].at; next[1].callback();
    }
    clock = target;
  };
  const flushIdle = () => { const callbacks = [...idleCallbacks.values()]; idleCallbacks.clear(); callbacks.forEach(callback => callback()); };
  return { context, connection, timers, idleCallbacks, cancelledIdle, marks, win, doc, advance, flushIdle, result: context.result, get decoded() { return decoded; } };
}

for (const route of [
  { shortVideoId: "123", shortVideoMedia: "video", shortVideoQuality: "4k" },
  { shortVideoId: "123", shortVideoMedia: "all", shortVideoQuality: "all" }
]) {
  const f = fixture({ route });
  assert.equal(await f.result, false);
  assert.equal(f.decoded, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.idleCallbacks.size, 0);
  assert(f.marks.some(([name, detail]) => name === "playback-decoder-primer-skipped" && detail.reason === "direct-video-uses-canonical-stream"));
}
assert(!source.includes("createDirectShortVideoPlaybackPrewarm") && !source.includes("/media/short-video-smooth/"), "the entry cannot guess a second rendition URL before detail metadata supplies the canonical source");

for (const options of [{ saveData: true }, { effectiveType: "2g" }, { effectiveType: "slow-2g" }]) {
  const f = fixture(options);
  assert.equal(await f.result, false);
  assert.equal(f.timers.size, 0, "a constrained connection does not schedule a speculative primer");
}
for (const idle of [true, false]) {
  const f = fixture({ idle }); f.advance(900);
  if (idle) f.flushIdle(); else f.advance(240);
  assert.equal(await f.result, true);
  assert.equal(f.decoded, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.idleCallbacks.size, 0);
}
{
  const f = fixture(); f.advance(900);
  f.connection.saveData = true; f.flushIdle();
  assert.equal(await f.result, false, "a hint changed during idle waiting is rechecked before loading media");
  assert.equal(f.decoded, 0);
}
for (const idle of [true, false]) {
  const f = fixture({ idle }); f.advance(900);
  const oldRun = idle ? [...f.idleCallbacks.values()][0] : [...f.timers.values()][0].callback;
  f.win.dispatchEvent(new Event("pointerdown"));
  if (idle) assert.deepEqual(f.cancelledIdle, [0], "zero idle handles are cancelled");
  oldRun();
  assert.equal(f.decoded, 0, "an already-queued cancelled callback cannot interrupt new browsing activity");
  f.advance(900); if (idle) f.flushIdle(); else f.advance(240);
  assert.equal(await f.result, true);
  assert.equal(f.decoded, 1);
}
{
  const f = fixture(); f.advance(900);
  f.doc.hidden = true; f.doc.visibilityState = "hidden"; f.flushIdle();
  assert.equal(f.decoded, 0);
  f.doc.hidden = false; f.doc.visibilityState = "visible";
  f.doc.dispatchEvent(new Event("visibilitychange"));
  f.advance(900); f.flushIdle();
  assert.equal(await f.result, true);
}
console.log("short-video-startup-preload: canonical-source startup, constrained hints, quiet-window ownership and cancelled idle callbacks passed");
