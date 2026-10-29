import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import vm from "node:vm";
import { runShortVideoRead } from "../public/modules/short-videos/read-request.js";

const source = fs.readFileSync(new URL("../public/modules/short-videos/read-request.js", import.meta.url), "utf8");
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  let sequence = 0, now = 0;
  const timers = new Map(), clears = [];
  const context = vm.createContext({ Promise, AbortController,
    setTimeout(callback, delay) { const id = sequence++; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { clears.push(id); timers.delete(id); }
  });
  vm.runInContext(`${source.replace(/^export /gm, "")}\nglobalThis.run=runShortVideoRead;`, context);
  return { run: context.run, timers, clears, advance(delta) {
    now += delta;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
  } };
}
function observedSignal() {
  const controller = new AbortController(), signal = controller.signal;
  let listeners = 0;
  const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args) => { if (args[0] === "abort") listeners++; return add(...args); };
  signal.removeEventListener = (...args) => { if (args[0] === "abort") listeners--; return remove(...args); };
  return { controller, signal, count: () => listeners };
}

for (const outcome of ["value", "rejection", "throw"]) {
  const f = fixture(), owner = observedSignal(), failure = new Error(outcome), gate = deferred(); let derived;
  const task = f.run(signal => { derived = signal; if (outcome === "throw") throw failure; return gate.promise; }, { signal: owner.signal });
  assert.notEqual(derived, owner.signal, "a read owns a derived abort signal instead of borrowing its caller's controller");
  if (outcome === "value") { gate.resolve({ ok: true }); assert.deepEqual(await task, { ok: true }); }
  else { const rejected = assert.rejects(task, error => error === failure); if (outcome === "rejection") gate.reject(failure); await rejected; }
  assert.equal(f.timers.size, 0); assert.equal(owner.count(), 0); assert.equal(derived.aborted, false);
  assert.equal(f.clears[0], 0, "native timer handle zero must also be released");
  owner.controller.abort(); assert.equal(derived.aborted, false, "a completed read detaches its parent signal listener");
}
{
  const f = fixture(), owner = observedSignal(); let calls = 0;
  owner.controller.abort("already gone");
  await assert.rejects(f.run(() => calls++, { signal: owner.signal }), error => error.name === "AbortError" && error.code === "SHORT_VIDEO_READ_ABORTED");
  assert.equal(calls, 0); assert.equal(f.timers.size, 0); assert.equal(owner.count(), 0);
}
{
  const f = fixture(), owner = observedSignal(), gate = deferred(); let derived;
  const task = f.run(signal => { derived = signal; return gate.promise; }, { signal: owner.signal });
  const rejected = assert.rejects(task, error => error.name === "AbortError" && error.cause === "left view");
  owner.controller.abort("left view"); await rejected;
  assert.equal(derived.aborted, true); assert.equal(f.timers.size, 0); assert.equal(owner.count(), 0);
  gate.resolve("too late"); await settle(); assert.equal(f.timers.size, 0);
}
{
  const f = fixture(), owner = observedSignal(), gate = deferred(); let derived;
  const task = f.run(signal => { derived = signal; return gate.promise; }, { signal: owner.signal });
  const rejected = assert.rejects(task, error => error.code === "SHORT_VIDEO_READ_TIMEOUT" && error.name === "TimeoutError"
    && error.statusCode === 408 && error.retryable && /重试/.test(error.message));
  f.advance(11999); await settle(); assert.equal(derived.aborted, false);
  f.advance(1); await rejected; assert.equal(derived.aborted, true); assert.equal(f.timers.size, 0); assert.equal(owner.count(), 0);
  gate.reject(new Error("late underlying rejection")); await settle();
  assert.equal(await f.run(() => "retry is independent"), "retry is independent");
}
{
  const f = fixture(), owner = observedSignal(); let requests = 0, nativeAborts = 0;
  const task = f.run(signal => { requests++; return new Promise((_, reject) => signal.addEventListener("abort", () => { nativeAborts++; reject(signal.reason); }, { once: true })); },
    { timeoutMs: 200, timeoutMessage: "作品加载超时，请重新加载", signal: owner.signal });
  const rejected = assert.rejects(task, error => error.code === "SHORT_VIDEO_READ_TIMEOUT" && error.message === "作品加载超时，请重新加载");
  f.advance(200); await rejected; assert.equal(requests, 1); assert.equal(nativeAborts, 1); assert.equal(owner.count(), 0);
  owner.controller.abort(); assert.equal(nativeAborts, 1, "timeout and a later route abort settle/cancel one read only");
}
{
  const f = fixture(), gate = deferred(); let calls = 0;
  const request = () => { calls++; return gate.promise; };
  const task = f.run(request, { timeoutMs: 5 }); const rejected = assert.rejects(task, error => error.code === "SHORT_VIDEO_READ_TIMEOUT");
  f.advance(5); await rejected; assert.equal(calls, 1, "a deadline does not retry an operation on its own");
  gate.resolve(null); await settle();
}

// Real private HTTP proves cancellation reaches fetch's socket, beyond the
// logical deadline tests whose adapters deliberately ignore AbortSignal.
{
  const entered = deferred(), closed = deferred(), owner = new AbortController();
  const server = http.createServer((_req, res) => { res.once("close", () => closed.resolve()); entered.resolve(); });
  let enteredTimer, closedTimer;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const task = runShortVideoRead(signal => fetch(`http://127.0.0.1:${server.address().port}/synthetic-detail`, { signal }).then(response => response.json()), { signal: owner.signal });
    const rejected = assert.rejects(task, error => error.code === "SHORT_VIDEO_READ_ABORTED");
    await Promise.race([entered.promise, new Promise((_, reject) => { enteredTimer = setTimeout(() => reject(new Error("private HTTP did not enter")), 3000); })]);
    owner.abort(); await rejected;
    await Promise.race([closed.promise, new Promise((_, reject) => { closedTimer = setTimeout(() => reject(new Error("cancelled fetch socket did not close")), 3000); })]);
  } finally {
    clearTimeout(enteredTimer); clearTimeout(closedTimer); owner.abort(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

console.log("short-video-read-request: passed deadline, abort ownership, ignored cancellation, late results, retry independence, timer/listener cleanup and real private HTTP cancellation");
