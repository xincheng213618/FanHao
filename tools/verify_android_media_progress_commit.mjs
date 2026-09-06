import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { harness, deferred } from "./verify_android_media_progress_refresh.mjs";

// The shared harness executes complete channel/adapter factories, real shell
// generation methods and actual synthetic list/detail/progress/playInfo services.
// This suite adds a Capacitor listener boundary: synchronous handle (the actual
// injected Android JSExport API), delayed Promise handle, and failure variants.
// A synthetic service commit precedes notification; this does not claim execution
// of the native HTTP sender or real Capacitor/WebView transport.
const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const sha = value => createHash("sha256").update(value).digest("hex");
const source = read("android-client/www/platform/content-index/channel-views.js");
const old = JSON.parse(read("tools/fixtures/android-media-progress-commit-before-fix.json"));
assert.equal(sha(JSON.stringify(old.sources)), "c559b60c63dd59e1147e066c2f1c12d4cce9559fb92f29b6589ad7d25879456d");
assert.equal(old.sources.channel.sha256, "85cf75d7c7795f6ed6669c31292038a92d567c5c5014616855bb1ffae729aa93");
for (const entry of Object.values(old.sources)) assert.equal(sha(entry.source), entry.sha256);
const frozen = { media: old.sources.media.source, shell: old.sources.shell.source };
function setup(input, mode = "movie", behavior = "sync") {
  const h = harness(input, mode, input === old.sources.channel.source ? frozen : null);
  const entries = [], stats = { adds: [], removes: [], removeAll: 0 }, pending = deferred();
  h.plugin.removeAllListeners = () => { stats.removeAll++; entries.forEach(entry => { entry.active = false; }); };
  if (behavior !== "absent") h.plugin.addListener = (eventName, callback) => {
    stats.adds.push(eventName);
    if (behavior === "throw") throw Error("Synthetic unsupported listener");
    if (behavior === "reject") return Promise.reject(Error("Synthetic rejected listener"));
    const entry = { eventName, callback, active: true };
    entry.handle = { remove() {
      stats.removes.push(entry);
      if (behavior === "remove-throw") throw Error("Synthetic remove failure");
      if (behavior === "remove-reject") return Promise.reject(Error("Synthetic remove rejection"));
      entry.active = false; return Promise.resolve();
    } };
    entries.push(entry);
    if (behavior === "late") return pending.promise;
    if (behavior === "promise") return Promise.resolve(entry.handle);
    return entry.handle;
  };
  return Object.assign(h, { listenerStats: stats, entries,
    resolveListener() { assert(entries[0], "Native listener registration was requested"); pending.resolve(entries[0].handle); },
    receipt(overrides = {}, launch = h.calls.bridge.at(-1)) {
      return { mode: "gallery-media", videoId: h.id, progressUrl: launch?.progressUrl,
        progressSessionId: launch?.progressSessionId || "frozen88-without-session", position: 555, duration: 600, ...overrides };
    },
    async emit(value = h.receipt(), { evenRemoved = false } = {}) {
      for (const entry of [...entries]) if ((entry.active || evenRemoved) && entry.eventName === "progressCommitted") entry.callback(value);
      await h.settle();
    }
  });
}
async function ready(input, mode = "movie", behavior = "sync") { const h = setup(input, mode, behavior); await h.render(); await h.settle(); return h; }
const label = (h, value) => assert.match(h.button().querySelector(".media-native-play-label").textContent, new RegExp(`^继续播放 · ${value}$`));
async function launch(h, position = 150) { h.setProgress(position); await h.click(); assert.equal(h.calls.bridge.at(-1)?.position, position); return h.calls.bridge.at(-1); }
const tests = [], test = (name, run, legacy = false) => tests.push({ name, run, legacy });

for (const mode of ["movie", "tv", "anime"]) {
  test(`${mode}: commit after every return GET refreshes without another focus event`, async input => {
    const h = await ready(input, mode); await launch(h); await h.focus(); label(h, "2:30");
    const before = h.readCount(); h.setProgress(190); await h.emit();
    assert.equal(h.readCount(), before + 1, "A matching committed event requires one authoritative read without a new focus");
    label(h, "3:10"); assert.equal(h.calls.bridge.length, 1); assert.equal(h.listenerStats.adds.length, 1);
    assert.equal(typeof h.calls.bridge[0].progressSessionId, "string"); assert(h.calls.bridge[0].progressSessionId.length > 0);
    assert(!h.button().textContent.includes("9:15"), "Event position is not authoritative presentation data");
  }, true);
  test(`${mode}: matching commit during native busy is drained after button release`, async input => {
    const h = await ready(input, mode), native = h.holdNative(); h.setProgress(150); await h.click(); assert(h.button().disabled);
    const before = h.readCount(); h.setProgress(190); for (let n = 0; n < 5; n++) await h.emit(); assert.equal(h.readCount(), before);
    native.resolve({ opened: true }); await h.settle();
    assert.equal(h.readCount(), before + 1, "A matching commit during busy requires one read on release"); label(h, "3:10");
  }, true);
  test(`${mode}: commit invalidates older pending GET before followup arrives`, async input => {
    const h = await ready(input, mode); await launch(h); h.setProgress(100); const older = h.hold(); await h.focus();
    h.setProgress(190); await h.emit(); const followup = h.hold(), before = h.readCount(); older.resolve(); await h.settle();
    assert.equal(h.readCount(), before + 1, "Commit during a pending GET requires a followup");
    label(h, "2:30"); followup.resolve(); await h.settle(); label(h, "3:10"); assert.equal(h.maxPassive(), 1);
  });
}
test("successive sessions of the same video reject an old session receipt", async input => {
  const h = await ready(input), previous = await launch(h), current = await launch(h, 250);
  assert.notEqual(current.progressSessionId, previous.progressSessionId, "Each accepted native launch owns a distinct session");
  h.setProgress(300); const before = h.readCount(); await h.emit(h.receipt({}, previous)); assert.equal(h.readCount(), before); label(h, "4:10");
  await h.emit(h.receipt({}, current)); assert.equal(h.readCount(), before + 1); label(h, "5:00");
});
for (const [name, changed] of [
  ["wrong video", { videoId: "unrelated-video" }], ["wrong session", { progressSessionId: "unrelated-session" }],
  ["empty session", { progressSessionId: "" }], ["wrong source", { progressUrl: "https://other.invalid/api/progress/movie-alpha-0001" }],
  ["wrong path", { progressUrl: "https://synthetic-progress-a.invalid/api/progress/other-id" }],
  ["wrong mode", { mode: "native-direct" }], ["numeric video", { videoId: 7 }]
]) test(`${name} receipt is ignored without a read or UI change`, async input => {
  const h = await ready(input); await launch(h); h.setProgress(190); const before = h.readCount(); await h.emit(h.receipt(changed));
  assert.equal(h.readCount(), before); label(h, "2:30"); assert.equal(h.calls.bridge.length, 1);
});
test("missing payload and receipt before any launch cannot trigger background work", async input => {
  const h = await ready(input), before = h.readCount(); await h.emit(null); await h.emit({}); await h.emit(h.receipt()); assert.equal(h.readCount(), before); label(h, "1:13");
});
test("commit during hidden state queues but neither fetches nor paints until visible", async input => {
  const h = await ready(input); await launch(h); await h.visibility("hidden"); h.setProgress(190); const before = h.readCount();
  await h.emit(); await h.emit(); assert.equal(h.readCount(), before); label(h, "2:30");
  await h.visibility("visible"); assert.equal(h.readCount(), before + 1); label(h, "3:10");
});
test("hidden commit invalidates old GET even when visibility returns before it settles", async input => {
  const h = await ready(input); await launch(h); h.setProgress(100); const older = h.hold(); await h.focus();
  await h.visibility("hidden"); h.setProgress(190); const before = h.readCount(); await h.emit(); assert.equal(h.readCount(), before);
  await h.visibility("visible"); const followup = h.hold(); older.resolve(); await h.settle();
  assert.equal(h.readCount(), before + 1); label(h, "2:30"); followup.resolve(); await h.settle(); label(h, "3:10");
});
test("commit during followup schedules another bounded authoritative read", async input => {
  const h = await ready(input); await launch(h); h.setProgress(190); const first = h.hold(); await h.emit();
  for (let n = 0; n < 5; n++) await h.emit(); h.setProgress(250); const second = h.hold(); first.resolve(); await h.settle();
  const before = h.readCount(); for (let n = 0; n < 5; n++) await h.emit(); assert.equal(h.readCount(), before);
  h.setProgress(300); second.resolve(); await h.settle(); assert.equal(h.readCount(), before + 1); label(h, "5:00"); assert.equal(h.maxPassive(), 1);
});
test("failed commit refresh does not retry without another event", async input => {
  const h = await ready(input); await launch(h); h.queue("detail", Error("Synthetic post-commit GET failure")); const before = h.readCount();
  await h.emit(); for (let n = 0; n < 8; n++) await h.settle(); assert.equal(h.readCount(), before + 1); label(h, "2:30");
  h.setProgress(190); await h.emit(); assert.equal(h.readCount(), before + 2); label(h, "3:10");
});
for (const invalidate of ["source", "abort", "leave", "detach", "route"]) test(`${invalidate}: stale matching receipt cannot act on the old page`, async input => {
  const h = await ready(input); await launch(h); const event = h.receipt(); h.setProgress(190);
  if (invalidate === "source") h.setSource(); else if (invalidate === "abort") h.abort(); else if (invalidate === "leave") h.leave();
  else if (invalidate === "detach") h.els.viewContent.textContent = "DETACHED"; else h.context.currentViewParams = { id: "unrelated", mode: "movie" };
  const before = h.readCount(), visible = h.els.viewContent.textContent; await h.emit(event, { evenRemoved: true });
  assert.equal(h.readCount(), before); assert.equal(h.els.viewContent.textContent, visible); assert.equal(h.listenerStats.removeAll, 0);
  if (["abort", "leave"].includes(invalidate)) assert.equal(h.listenerStats.removes.length, 1, "Aborting a view removes its own listener");
});
test("rerender removes only the old listener; queued old delivery cannot alter the new surface", async input => {
  const h = await ready(input); await launch(h); const event = h.receipt(); h.setProgress(250); await h.render(); await h.settle();
  assert.equal(h.listenerStats.adds.length, 2); assert.equal(h.listenerStats.removes.length, 1); assert.equal(h.listenerStats.removeAll, 0);
  const before = h.readCount(); await h.emit(event, { evenRemoved: true }); assert.equal(h.readCount(), before); label(h, "4:10");
  await launch(h, 250); h.setProgress(300); await h.emit(); label(h, "5:00");
});
test("cache-to-fresh replacement uses one view listener and targets only its current surface", async input => {
  const h = setup(input); h.cacheDetail(); const background = h.hold(), rendering = h.render(); await h.settle(); const cacheButton = h.button();
  assert.equal(h.listenerStats.adds.length, 1, "A cached render creates exactly one view subscription");
  h.setProgress(100); background.resolve(h.library.detail(h.id)); await rendering; await h.settle();
  assert.notEqual(h.button(), cacheButton); assert.equal(h.listenerStats.adds.length, 1, "Fresh replacement must reuse the same view subscription");
  await launch(h); h.setProgress(190); await h.emit(); label(h, "3:10"); assert.equal(cacheButton.querySelector(".media-native-play-label").textContent, "继续播放 · 1:13");
});
test("late listener handle is awaited before native launch then removed once on abort", async input => {
  const h = await ready(input, "movie", "late"); h.setProgress(150); await h.click(); assert(h.button().disabled); assert.equal(h.calls.bridge.length, 0);
  assert.equal(h.readCount(), 1, "Launch detail preparation waits for the requested native subscription");
  h.resolveListener(); await h.settle(); assert.equal(h.calls.bridge.length, 1); h.abort(); h.abort(); await h.settle();
  assert.equal(h.listenerStats.removes.length, 1); assert.equal(h.listenerStats.removeAll, 0);
});
test("abort while listener handle is unresolved removes the late handle and cancels launch", async input => {
  const h = await ready(input, "movie", "late"); await h.click(); h.abort(); const before = h.readCount(); h.resolveListener(); await h.settle();
  assert.equal(h.listenerStats.removes.length, 1, "Late subscribed handle must not leak after view abort"); assert.equal(h.calls.bridge.length, 0); assert.equal(h.readCount(), before);
  await h.emit(h.receipt(), { evenRemoved: true }); assert.equal(h.readCount(), before); assert.equal(h.listenerStats.removeAll, 0);
});
test("leaving before unresolved subscription settles removes its own late handle", async input => {
  const h = await ready(input, "movie", "late"); h.leave(); const before = h.readCount(); h.resolveListener(); await h.settle();
  assert.equal(h.listenerStats.removes.length, 1); assert.equal(h.readCount(), before); assert.equal(h.els.viewContent.textContent, "UNRELATED PAGE");
});
for (const behavior of ["absent", "throw", "reject", "promise"]) test(`${behavior} listener API preserves native playback and focus fallback`, async input => {
  const h = await ready(input, "movie", behavior); await launch(h); h.setProgress(190); await h.focus(); label(h, "3:10"); assert.equal(h.calls.bridge.length, 1);
  h.abort(); await h.settle(); assert.equal(h.listenerStats.removeAll, 0);
  if (behavior === "promise") assert.equal(h.listenerStats.removes.length, 1);
});
for (const behavior of ["remove-throw", "remove-reject"]) test(`${behavior} is best effort and stale callback remains gated`, async input => {
  const h = await ready(input, "movie", behavior); await launch(h); const receipt = h.receipt(); h.abort(); const before = h.readCount();
  await h.emit(receipt, { evenRemoved: true }); await h.settle(); assert.equal(h.listenerStats.removes.length, 1); assert.equal(h.readCount(), before);
});

const mutations = [], mutate = (name, scenario, change) => mutations.push({ name, scenario, change });
const once = (value, from, to) => { assert(value.includes(from), `Mutation anchor missing: ${from}`); return value.replace(from, to); };
const receiptMutation = change => value => {
  const start = value.indexOf("const progressListenerReady = playbackContext.setProgressHandler?.(event => {");
  const end = value.indexOf("\n    });", start); assert(start >= 0 && end > start);
  return value.slice(0, start) + change(value.slice(start, end)) + value.slice(end);
};
mutate("disconnect committed event subscription", tests[0].name, value => once(value, 'plugin.addListener("progressCommitted", onCommitted)', 'plugin.addListener("missingProgressCommitted", onCommitted)'));
mutate("omit session from native launch payload", tests[0].name, value => once(value, "progressSessionId: playbackContext.progressSessionId,", "/* mutation: session omitted */"));
mutate("accept old playback session", "successive sessions of the same video reject an old session receipt", receiptMutation(value => once(value, "|| event.progressSessionId !== progressSessionId", "")));
mutate("accept wrong source", "wrong source receipt is ignored without a read or UI change", receiptMutation(value => once(value, '|| event.progressUrl !== absoluteUrl(sourceUrl, `/api/progress/${encodeURIComponent(item.id)}`)', "")));
mutate("accept wrong video", "wrong video receipt is ignored without a read or UI change", receiptMutation(value => once(value, "|| event.videoId !== String(item.id)", "")));
mutate("accept non-gallery player event", "wrong mode receipt is ignored without a read or UI change", receiptMutation(value => once(value, '|| event?.mode !== "gallery-media"', "")));
mutate("let pre-commit GET paint while followup is pending", tests[2].name, receiptMutation(value => once(value, "progressRevision += 1;", "/* mutation: stale GET remains eligible */")));
mutate("ignore commit while hidden", "hidden commit invalidates old GET even when visibility returns before it settles", receiptMutation(value => once(value, "if (!isActive() ||", 'if (document.visibilityState === "hidden" || !isActive() ||')));
mutate("skip removal of late listener handle", "abort while listener handle is unresolved removes the late handle and cancels launch", value => once(value, "if (signal.aborted) remove(handle);", "if (signal.aborted) { /* mutation: leaked handle */ }"));
mutate("forget resolved listener removal on abort", "abort: stale matching receipt cannot act on the old page", value => once(value, 'signal.addEventListener("abort", () => { remove(listener); listener = null; }, { once: true });', 'signal.addEventListener("abort", () => { listener = null; }, { once: true });'));
mutate("start playback before subscription readiness", "late listener handle is awaited before native launch then removed once on abort", value => once(value, "await progressListenerReady;", "/* mutation: subscription not awaited */"));

let passed = 0, failed = 0, oldRejected = 0, mutantsRejected = 0;
if (!process.argv.includes("--legacy-only")) for (const entry of tests) {
  try { await entry.run(source); passed++; console.log(`PASS ${entry.name}`); } catch (error) { failed++; console.error(`FAIL ${entry.name}\n${error.stack}`); }
}
for (const entry of tests.filter(value => value.legacy)) {
  try { let failure; try { await entry.run(old.sources.channel.source); } catch (error) { failure = error; }
    assert(failure instanceof assert.AssertionError, `Frozen88 must fail a behavior assertion, not setup: ${failure?.stack || "unexpected pass"}`);
    assert.match(failure.message, /matching commit.*requires one/); assert.equal(failure.expected - failure.actual, 1);
    oldRejected++; console.log(`REJECT frozen88 ${entry.name}: ${failure.actual} reads, expected ${failure.expected}`);
  } catch (error) { failed++; console.error(error.stack); }
}
if (!process.argv.includes("--legacy-only")) for (const mutation of mutations) {
  try { const changed = mutation.change(source); assert.notEqual(changed, source); const entry = tests.find(value => value.name === mutation.scenario); assert(entry);
    let failure; try { await entry.run(changed); } catch (error) { failure = error; }
    assert(failure instanceof assert.AssertionError, `Mutation must fail a behavior assertion, not setup: ${failure?.stack || "unexpected pass"}`);
    mutantsRejected++; console.log(`REJECT mutation ${mutation.name}`);
  } catch (error) { failed++; console.error(`FAIL mutation ${mutation.name}\n${error.stack}`); }
}
console.log(`Media progress commit: ${passed}/${tests.length} current; ${oldRejected}/${tests.filter(value => value.legacy).length} frozen88 controls; ${mutantsRejected}/${mutations.length} behavior mutants; ${failed} failures.`);
console.log(`channel SHA256 ${sha(source)}`);
process.exitCode = failed ? 1 : 0;
