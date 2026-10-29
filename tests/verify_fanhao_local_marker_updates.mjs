import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { runFanhaoFavoriteUpdates } from "./verify_fanhao_favorite_updates.mjs";
import { createApiClient } from "../public/js/api.js";

// The app helpers receive synthetic public DTOs, including stable media IDs and
// renamed sourcePath/relativePath. No actual marker or filesystem is mutated.
const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
function take(name, code = source) {
  const start = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(code)?.index;
  assert(start != null, `actual helper must exist: ${name}`);
  const end = code.indexOf("\n}", start);
  assert(end > start);
  return code.slice(start, end + 2);
}
const metadataImplementation = ["mergeWorkLocalMarkerFiles", "mergeWorkLocalMarkerRecord", "projectWorkLocalMarkerReceipt",
  "queueWorkLocalMarkerReadReceipt", "mergeWorkLocalMarkerReadPayload", "createWorkLocalMarkerApi", "applyWorkLocalMarkerReceipt"].map(name => take(name)).join("\n");
function verifyMarkerMetadata(code = metadataImplementation) {
  const media = (id, positionMs) => ({ id, sourcePath: `fixture/${id}`, relativePath: `fixture/${id}`, progress: { positionMs }, title: `Current ${id}` });
  const current = { id: "f0", title: "Current title", favorite: true, favoriteFolderId: "later", favoriteFolderName: "稍后", progress: { positionMs: 42000 }, infoSummary: { rating: 5 }, videoCount: 2,
    localMarkers: [], directoryName: "fixture-f0", relativePath: "fixture-f0",
    videos: [media("extra", 51000), media("v0", 42000)], images: [media("i0", 0)], infos: [media("n0", 0)] };
  const original = { id: "f0", favorite: false, videos: [media("v0", 1000)] };
  const detail = { id: "f0", title: "Current detail", favorite: true, videos: [media("v0", 55000)] };
  const cached = { id: "f0", favorite: true, relativePath: "fixture-f0", videos: [media("v0", 56000)] };
  const unrelated = { id: "other", localMarkers: [], videos: [media("other", 30000)] };
  const currentVideo = media("v0", 57000);
  const state = { works: [current, unrelated], currentWork: detail, currentVideo, library: { works: [cached] } };
  const env = vm.createContext({ state, Map, Set, workLocalMarkerReads: new Set() });
  vm.runInContext(code, env);
  const videoArray = current.videos, video = current.videos[1], image = current.images[0], info = current.infos[0];
  const confirmedFile = id => ({ id, sourcePath: `[A] fixture-f0/${id}`, relativePath: `[A] fixture-f0/${id}`, progress: { positionMs: 0 }, title: "Old server media" });
  const receipt = { id: "f0", localMarkers: ["A"], directoryName: "fixture-f0", relativePath: "[A] fixture-f0",
    title: "Old server title", favorite: false, favoriteFolderId: "default", favoriteFolderName: "旧默认", progress: { positionMs: 0 }, infoSummary: { rating: 0 }, videoCount: 1,
    videos: [confirmedFile("v0")], images: [confirmedFile("i0")], infos: [confirmedFile("n0")] };
  env.applyWorkLocalMarkerReceipt(original, receipt);
  assert.equal(current.videos, videoArray, "marker path merge must preserve the current media array and order");
  assert.equal(current.videos[1], video); assert.equal(current.images[0], image); assert.equal(current.infos[0], info);
  assert.deepEqual(current.videos.map(file => file.id), ["extra", "v0"]);
  assert.equal(current.videos[0].sourcePath, "fixture/extra", "a marker receipt cannot replace newer array membership");
  assert.equal(video.sourcePath, "[A] fixture-f0/v0"); assert.equal(video.relativePath, "[A] fixture-f0/v0");
  assert.equal(image.sourcePath, "[A] fixture-f0/i0"); assert.equal(info.sourcePath, "[A] fixture-f0/n0");
  assert.equal(video.progress.positionMs, 42000, "marker path merge must preserve newer media progress");
  assert.equal(video.title, "Current v0"); assert.equal(current.videoCount, 2);
  assert.equal(current.title, "Current title"); assert.equal(current.favorite, true); assert.equal(current.infoSummary.rating, 5);
  assert.equal(current.favoriteFolderId, "later"); assert.equal(current.favoriteFolderName, "稍后"); assert.equal(current.progress.positionMs, 42000);
  for (const copy of [original, current, detail, cached]) {
    assert.equal(copy.relativePath, "[A] fixture-f0"); assert.deepEqual([...copy.localMarkers], ["A"]);
  }
  assert.equal(detail.favorite, true); assert.equal(detail.videos[0].progress.positionMs, 55000);
  assert.equal(cached.favorite, true); assert.equal(cached.videos[0].progress.positionMs, 56000);
  assert.equal(currentVideo.sourcePath, "[A] fixture-f0/v0"); assert.equal(currentVideo.progress.positionMs, 57000, "marker path merge must preserve current playback progress");
  assert.equal(unrelated.videos[0].sourcePath, "fixture/other"); assert.deepEqual(unrelated.localMarkers, []);
  const remove = { ...receipt, localMarkers: [], relativePath: "fixture-f0", videos: [{ ...confirmedFile("v0"), sourcePath: "fixture-f0/v0", relativePath: "fixture-f0/v0" }] };
  env.applyWorkLocalMarkerReceipt(original, remove);
  assert.deepEqual([...current.localMarkers], []); assert.equal(video.sourcePath, "fixture-f0/v0"); assert.equal(video.progress.positionMs, 42000);
  assert.equal(current.videos, videoArray); assert.equal(current.favorite, true);
}
verifyMarkerMetadata();
const pathOnlyMarker = '    for (const field of ["sourcePath", "relativePath"]) {\n      if (Object.prototype.hasOwnProperty.call(received, field)) next[field] = received[field];\n    }';
assert.equal(metadataImplementation.split(pathOnlyMarker).length - 1, 1, "metadata negative must change one actual path-only merge");
assert.throws(() => verifyMarkerMetadata(metadataImplementation.replace(pathOnlyMarker, "    Object.assign(next, received);")),
  error => error instanceof assert.AssertionError && error.message.includes("marker path merge must preserve current playback progress"));
console.log("PASS local marker actual metadata helpers preserve known copies, media membership and newer fields; whole-media merge negative rejected");

async function verifyPendingMarkerReads(code = metadataImplementation) {
  const entries = new Set(), env = vm.createContext({ Map, Set, Promise, workLocalMarkerReads: entries });
  vm.runInContext(code, env);
  const savedFetch = globalThis.fetch, calls = [], delegated = [], pending = [];
  const response = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => payload });
  globalThis.fetch = (path, options) => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    calls.push({ path, options, resolve, reject, settled: false }); return promise;
  };
  const client = createApiClient();
  const api = env.createWorkLocalMarkerApi((...args) => { const result = client(...args); delegated.push(result); return result; });
  const start = (path, options = {}) => {
    const before = calls.length, promise = api(path, options); pending.push(promise); promise.catch(() => {});
    assert.equal(calls.length, before + 1, "the real API wrapper must perform exactly the caller's one request");
    return { promise, call: calls.at(-1) };
  };
  const deliver = (request, payload) => { request.call.settled = true; request.call.resolve(response(payload)); };
  const receipt = { id: "f0", localMarkers: ["A"], directoryName: "fixture-f0", relativePath: "[A] fixture-f0", favorite: false, title: "Old title",
    videos: [{ id: "v0", sourcePath: "[A] fixture-f0/video.mp4", relativePath: "[A] fixture-f0/video.mp4", progress: { positionMs: 0 } }] };
  try {
    const controller = new AbortController(), options = { signal: controller.signal, headers: { "X-Fixture": "read-owner" } };
    const old = start("/api/search?q=marker", options);
    assert.equal(entries.size, 1); assert.equal(old.call.options.signal, controller.signal);
    const payload = { works: [{ id: "f0", title: "New title", favorite: true, localMarkers: [], relativePath: "fixture-f0",
      videos: [{ id: "v0", sourcePath: "fixture-f0/video.mp4", relativePath: "fixture-f0/video.mp4", progress: { positionMs: 42000 } }, { id: "new", sourcePath: "new/video.mp4" }] },
    { id: "other", favorite: true, localMarkers: [] }], total: 2, nextCursor: "opaque-current-cursor" };
    env.queueWorkLocalMarkerReadReceipt(receipt);
    assert.equal(calls.length, 1, "marker confirmation must not issue a replacement GET");
    const future = start("/api/search?q=fresh");
    const freshPayload = { works: [{ id: "f0", localMarkers: [], relativePath: "fresh-external-path" }], total: 1 };
    deliver(future, freshPayload);
    assert.equal(await future.promise, freshPayload, "a future GET must not inherit an earlier marker overlay");
    deliver(old, payload); const result = await old.promise;
    assert.equal(result.works[0].relativePath, "[A] fixture-f0", "an in-flight work read must publish the newer confirmed marker path"); assert.deepEqual([...result.works[0].localMarkers], ["A"]);
    assert.notEqual(result, payload, "pending GET marker convergence must clone its payload");
    assert.equal(result.works[0].title, "New title"); assert.equal(result.works[0].favorite, true);
    assert.equal(result.works[0].videos[0].sourcePath, "[A] fixture-f0/video.mp4");
    assert.equal(result.works[0].videos[0].progress.positionMs, 42000, "pending read patches must preserve the read's newer media progress");
    assert.equal(result.works[0].videos[1], payload.works[0].videos[1]); assert.equal(result.works[1], payload.works[1]);
    assert.equal(result.nextCursor, "opaque-current-cursor"); assert.deepEqual(payload.works[0].localMarkers, []);
    assert.equal(payload.works[0].relativePath, "fixture-f0", "marker convergence must not mutate the old read snapshot");
    assert.equal(payload.works[0].videos[0].sourcePath, "fixture-f0/video.mp4"); assert.equal(entries.size, 0);
    assert.equal(options.signal, controller.signal); assert.deepEqual(options.headers, { "X-Fixture": "read-owner" });

    const compact = start("/api/works/f0"); env.queueWorkLocalMarkerReadReceipt(receipt);
    const compactPayload = { work: { id: "f0", title: "Compact current", localMarkers: [], favorite: true } };
    deliver(compact, compactPayload); const compactResult = await compact.promise;
    assert.deepEqual([...compactResult.work.localMarkers], ["A"]); assert.equal(compactResult.work.favorite, true);
    assert.equal("videos" in compactResult.work, false, "a compact list/detail DTO must not gain partial media arrays from marker convergence");
    assert.equal(entries.size, 0);

    const envelope = start("/api/search?q=envelope", { returnResponse: true });
    assert.equal(envelope.promise, delegated.at(-1), "returnResponse must keep the original API promise contract"); assert.equal(entries.size, 0);
    env.queueWorkLocalMarkerReadReceipt(receipt); const envelopePayload = { works: [{ id: "f0", localMarkers: [] }] };
    deliver(envelope, envelopePayload); const envelopeResult = await envelope.promise;
    assert.equal(envelopeResult.status, 200); assert.equal(envelopeResult.payload, envelopePayload);

    const unrelated = start("/api/modules"); assert.equal(unrelated.promise, delegated.at(-1)); assert.equal(entries.size, 0);
    deliver(unrelated, { modules: [] }); await unrelated.promise;
    const mutationOptions = { method: "POST", body: { marker: "A", enabled: true } };
    const mutation = start("/api/works/f0/local-marker", mutationOptions);
    assert.equal(mutation.promise, delegated.at(-1)); assert.equal(entries.size, 0);
    assert.deepEqual(mutationOptions.body, { marker: "A", enabled: true });
    deliver(mutation, { ok: true }); await mutation.promise;

    const abortOwner = new AbortController(), aborted = start("/api/search?q=aborted", { signal: abortOwner.signal });
    env.queueWorkLocalMarkerReadReceipt(receipt); assert.equal(entries.size, 1); abortOwner.abort();
    assert.equal(entries.size, 0, "an aborted read must immediately retire its queued marker projection");
    const abortedPayload = { works: [{ id: "f0", localMarkers: [] }] };
    deliver(aborted, abortedPayload); assert.equal(await aborted.promise, abortedPayload, "a transport ignoring abort must not revive an aborted read overlay");

    const failed = start("/api/search?q=rejected"), error = new Error("Synthetic request rejection");
    env.queueWorkLocalMarkerReadReceipt(receipt); const rejected = assert.rejects(failed.promise, actual => actual === error);
    failed.call.settled = true; failed.call.reject(error); await rejected;
    assert.equal(entries.size, 0, "a rejected read must release its marker projection");
    const afterFailure = start("/api/search?q=after-failure"), untouched = { works: [{ id: "f0", localMarkers: [] }] };
    deliver(afterFailure, untouched); assert.equal(await afterFailure.promise, untouched);
    assert.equal(entries.size, 0);
  } finally {
    for (const call of calls) if (!call.settled) { call.settled = true; call.resolve(response({})); }
    await Promise.allSettled(pending); globalThis.fetch = savedFetch;
  }
}
await verifyPendingMarkerReads();
const pendingReadMarker = "  for (const read of workLocalMarkerReads) read.patches.set(String(work.id), projection);";
assert.equal(metadataImplementation.split(pendingReadMarker).length - 1, 1, "pending-read negative must change one actual receipt-publication branch");
await assert.rejects(() => verifyPendingMarkerReads(metadataImplementation.replace(pendingReadMarker, "  for (const read of workLocalMarkerReads) void read;")),
  error => error instanceof assert.AssertionError && error.message.includes("an in-flight work read must publish the newer confirmed marker path"));
console.log("PASS actual API composition converges only already-running work reads, preserves owned snapshots/options and retires on settle/abort/rejection");

const presentationImplementation = ["hasAcceptedWorkLocalMarkerPage", "captureWorkLocalMarkerPresentation", "ownsWorkLocalMarkerPresentation", "beginWorkLocalMarkerForegroundRead"].map(name => take(name)).join("\n");
for (const [view, cursor, selection] of [
  ["search", "searchRawLoaded", { searchQuery: "[A]" }],
  ["people", "personWorksRawLoaded", { selectedPersonId: "person" }],
  ["codes", "codePrefixRawLoaded", { selectedCodePrefix: "ABC" }],
  ["studios", "studioWorksRawLoaded", { selectedStudio: { id: "studio" } }],
  ["favorites", "collectionRawLoaded", {}], ["history", "collectionRawLoaded", {}], ["vr", "vrRawLoaded", {}]
]) for (const kind of ["empty", "card"]) {
  const acceptedRows = kind === "empty" ? 0 : 48;
  const state = { activeView: view, [cursor]: acceptedRows, ...selection }, grid = {}, anchor = { parentNode: grid };
  grid.lastElementChild = anchor;
  grid.querySelector = selector => selector === ":scope > .work-card" && kind === "card" ? anchor : null;
  const values = { context: "current-context", desired: "committed-route", actual: "committed-route", markerScope: true };
  const reads = new Set();
  const env = vm.createContext({ state, els: { workGrid: grid }, navigationSequence: 4, workLocalMarkerPresentation: null,
    workLocalMarkerMembershipScope: () => values.markerScope, workLocalMarkerForegroundReads: reads,
    captureWorkLocalMarkerReadOwner: path => ({ path }),
    workLocalMarkerReadContext: () => values.context, currentRouteSnapshot: () => values.desired,
    routeFromUrl: () => values.actual, normalizeRoute: value => value, routeUrl: value => value, initialParams: {} });
  vm.runInContext(presentationImplementation, env);
  const capture = () => env.captureWorkLocalMarkerPresentation(kind === "empty" ? anchor : null);
  capture(); const owner = env.workLocalMarkerPresentation;
  assert(owner, `${view} ${kind} successful accepted work page must capture its actual direct DOM owner`);
  assert.equal(owner.anchor, anchor); assert.equal(owner.empty, kind === "empty");
  assert.equal(env.hasAcceptedWorkLocalMarkerPage(), true, `${view} explicit consumed rows must represent an accepted ${kind} page`);
  assert.equal(env.ownsWorkLocalMarkerPresentation(), true, `${view} current mounted accepted ${kind} presentation must own membership maintenance`);
  for (const unaccepted of [null, undefined, "0"]) {
    state[cursor] = unaccepted;
    assert.equal(env.hasAcceptedWorkLocalMarkerPage(), false, `${view} unknown or unaccepted cursor must not stand for a successful empty page`);
    assert.equal(env.ownsWorkLocalMarkerPresentation(), false);
  }
  state[cursor] = acceptedRows;
  grid.lastElementChild = {};
  assert.equal(env.ownsWorkLocalMarkerPresentation(), kind === "card", `${view} later progressive cards may retain a direct card owner while an empty anchor must remain last`);
  grid.lastElementChild = anchor;
  for (const [change, restore, reason] of [
    [() => { anchor.parentNode = {}; }, () => { anchor.parentNode = grid; }, "retired direct presentation anchor"],
    [() => { env.navigationSequence++; }, () => { env.navigationSequence = 4; }, "newer navigation intent"],
    [() => { values.context = "new-context"; }, () => { values.context = "current-context"; }, "newer filter or sort context"],
    [() => { values.desired = "new-destination"; }, () => { values.desired = "committed-route"; }, "newer desired route"],
    [() => { values.actual = "pending-history-route"; }, () => { values.actual = "committed-route"; }, "pending canonical history URL"],
    [() => { env.workLocalMarkerPresentation = null; }, () => { env.workLocalMarkerPresentation = owner; }, "missing accepted presentation"]
  ]) {
    change(); assert.equal(env.ownsWorkLocalMarkerPresentation(), false, `${view} ${reason} must retire accepted membership ownership`); restore();
    assert.equal(env.ownsWorkLocalMarkerPresentation(), true);
  }
  const finish = env.beginWorkLocalMarkerForegroundRead("/fixture?offset=48", () => true);
  assert.equal(reads.size, 1); assert.equal(env.workLocalMarkerPresentation, null, "a newer foreground read must immediately retire an older accepted presentation before success or failure");
  assert.equal(env.ownsWorkLocalMarkerPresentation(), false); finish(); assert.equal(reads.size, 0);
  assert.equal(env.workLocalMarkerPresentation, null, "a completed or failed read must not revive an earlier accepted owner without publishing a new result");
  state[cursor] = kind === "empty" ? 0 : 60; capture();
  assert.equal(env.ownsWorkLocalMarkerPresentation(), true, "a successful accepted append may explicitly recapture its retained direct card");
  values.markerScope = false; capture(); assert.equal(env.workLocalMarkerPresentation, null, "ordinary work lists must not capture marker membership ownership");
  values.markerScope = true; capture();
  for (const key of Object.keys(selection)) {
    const selected = state[key]; state[key] = null;
    assert.equal(env.hasAcceptedWorkLocalMarkerPage(), false, `${view} index or absent search target must not own a work page`);
    state[key] = selected;
  }
  state.activeView = "rankings"; state.rankingRawLoaded = 0;
  assert.equal(env.hasAcceptedWorkLocalMarkerPage(), false, "rankings must not inherit accepted-empty work ownership from another view");
  assert.equal(env.ownsWorkLocalMarkerPresentation(), false);
}
console.log("PASS actual empty/nonempty presentation ownership covers seven view cursors, progressive retained cards, accepted append recapture and newer-read/error retirement with context/history guards");

const negativeOnly = process.argv.includes("--negative-only");
const metadataOnly = process.argv.includes("--metadata-only");
for (const receipt of ["changed", "unchanged", "invalid", "rejected", "obsolete"]) {
  const events = [], alerts = [], feedback = [], intents = [], work = { id: "f0", localMarkers: [] };
  const button = { isConnected: receipt !== "obsolete", closest: () => null };
  const cache = owner => ({ invalidatePrefetches() { events.push(owner); } });
  const env = vm.createContext({
    state: { works: [work], activeView: "people", sortMode: "releaseDesc", peopleScope: "main" }, navigationSequence: 0,
    workLocalMarkerWrites: new Map(), workLocalMarkerKey: (id, marker) => `${id}:${marker}`,
    workStatsContext: () => "person", serializedWorkFilterMode: () => "all",
    syncWorkLocalMarkerButtons() { events.push("sync"); },
    api: async (_path, options) => {
      events.push("POST"); assert.equal(options.method, "POST"); assert.equal(options.body.marker, "A"); assert.equal(typeof options.body.enabled, "boolean"); intents.push(options.body.enabled);
      if (receipt === "obsolete" || receipt === "rejected" && intents.length === 1) throw new Error("Synthetic marker failure");
      return { changed: receipt !== "unchanged", work: { id: receipt === "invalid" ? "other" : "f0", localMarkers: options.body.enabled ? ["A"] : [] } };
    },
    applyWorkLocalMarkerReceipt(_work, data) { events.push("apply"); Object.assign(work, data); },
    clearWorkLocalMarkerError() { events.push("clear"); },
    showWorkLocalMarkerError(_work, _marker, _button, error, enabled, ownsOrigin) { events.push("feedback"); feedback.push({ error: error.message, enabled, owns: ownsOrigin() }); },
    peoplePage: cache("person"), studioPage: cache("studio"), searchRequests: cache("search"), collectionPage: cache("collection"),
    els: { workGrid: { contains: () => true, querySelectorAll: () => [{ dataset: { workId: "f0" } }] } },
    normalizeRoute: value => value, routeFromUrl: () => "fixture", currentRouteSnapshot: () => "fixture", routeUrl: value => value, initialParams: {},
    workLocalMarkerMembershipScope: () => false, alert: message => alerts.push(message)
  });
  vm.runInContext(`${take("invalidateWorkLocalMarkerPrefetches")}\n${take("toggleWorkLocalMarker")}`, env);
  await env.toggleWorkLocalMarker(work, "A", button);
  assert.deepEqual(intents, [true]);
  if (receipt === "changed" || receipt === "unchanged") {
    assert.deepEqual(events, ["sync", "POST", "clear", "apply", "sync", "person", "studio", "search", "collection", "sync"], "every valid marker ACK must retire all four future cache owners after applying the receipt");
    assert.deepEqual(alerts, []);
  } else {
    assert.deepEqual(events, receipt === "obsolete" ? ["sync", "POST", "sync"] : ["sync", "POST", "feedback", "sync"], "a rejected or invalid marker receipt must preserve every future cache owner and publish feedback only for its current origin");
    assert.equal(feedback.length, receipt === "obsolete" ? 0 : 1); assert.deepEqual(alerts, []);
    if (receipt !== "obsolete") { assert.equal(feedback[0].enabled, true); assert.equal(feedback[0].owns, true); }
  }
  if (receipt === "rejected") {
    work.localMarkers = ["A"]; events.length = 0;
    await env.toggleWorkLocalMarker(work, "A", button, true);
    assert.deepEqual(intents, [true, true], "a failed explicit add retry must remain add after a newer confirmed marker state changes");
    assert.deepEqual(events, ["sync", "POST", "clear", "apply", "sync", "person", "studio", "search", "collection", "sync"]);
    await env.toggleWorkLocalMarker(work, "A", button);
    assert.deepEqual(intents, [true, true, false], "the original marker control must still reverse current state when no explicit retry intent is supplied");
  }
  assert.equal(env.workLocalMarkerWrites.size, 0);
}
console.log("PASS actual marker ACK dispatch invalidates all four future caches, including unchanged ACKs, and preserves caches on invalid or rejected receipts");
if (!metadataOnly && !negativeOnly) {
  const result = await runFanhaoFavoriteUpdates({ casePattern: "local marker" });
  assert.equal(result.checks, 14, "marker entry must run all fourteen native profiles");
}
if (!metadataOnly) for (const negative of [
  {
    name: "local marker native DOM retention",
    casePattern: "1000-card local marker native roundtrip",
    marker: "    applyWorkLocalMarkerReceipt(work, data.work);\n    syncWorkLocalMarkerButtons(workId);",
    replacement: "    applyWorkLocalMarkerReceipt(work, data.work);\n    syncWorkLocalMarkerButtons(workId);\n    renderStatsForWorks(state.works, state.selectedPerson);\n    renderWorks();",
    failure: /a local marker receipt must retain every original work card/
  },
  {
    name: "obsolete local marker error ownership",
    casePattern: "local marker obsolete failure",
    marker: "    if (ownsOrigin()) showWorkLocalMarkerError(work, key, button, error, nextEnabled, ownsOrigin);",
    replacement: "    showWorkLocalMarkerError(work, key, button, error, nextEnabled, ownsOrigin);",
    failure: /an obsolete marker failure must not publish feedback during newer pending history navigation/
  },
  {
    name: "current local marker persistent failure feedback",
    casePattern: "local marker current failure retries without stealing a newer draft",
    marker: "    if (ownsOrigin()) showWorkLocalMarkerError(work, key, button, error, nextEnabled, ownsOrigin);",
    replacement: "    if (ownsOrigin()) void error;",
    failure: /a current marker failure must keep its cause and retry visible/
  },
  {
    name: "confirmed local marker settled-cache invalidation",
    casePattern: "local marker confirmation retires settled empty search prefetches",
    marker: "    invalidateWorkLocalMarkerPrefetches();",
    replacement: "",
    failure: /a confirmed marker must retire an already settled empty search prefetch/
  },
  {
    name: "confirmed local marker accepted empty destination ownership",
    casePattern: "local marker accepted empty query destination rechecks confirmed membership",
    marker: " || ownsWorkLocalMarkerPresentation()",
    replacement: "",
    failure: /a confirmed marker must repopulate an already accepted empty marker destination/
  },
  {
    name: "confirmed local marker nonempty destination capture",
    casePattern: "local marker accepted nonempty query destination joins confirmed membership",
    marker: '  const anchor = emptyAnchor || els.workGrid.querySelector(":scope > .work-card");',
    replacement: "  const anchor = emptyAnchor;",
    failure: /a confirmed marker must join an already accepted nonempty marker destination/
  },
  {
    name: "local marker restored control visibility",
    casePattern: "local marker native recovery focus preserves visibility and newer intent",
    markerRecoveryMode: "retry",
    marker: "    clearWorkLocalMarkerError(button, ownsOrigin, !newerViewportGesture);",
    replacement: "    clearWorkLocalMarkerError(button, ownsOrigin, false);",
    failure: /restored A marker control must be fully visible below the sticky header/
  },
  {
    name: "local marker newer viewport intent ownership",
    casePattern: "local marker native recovery focus preserves visibility and newer intent",
    markerRecoveryMode: "wheel",
    marker: "    clearWorkLocalMarkerError(button, ownsOrigin, !newerViewportGesture);",
    replacement: "    clearWorkLocalMarkerError(button, ownsOrigin, true);",
    failure: /new viewport intent must prevent A recovery from pulling back the page/
  },
  {
    name: "local marker repeated retry pointer ownership",
    casePattern: "local marker native recovery focus preserves visibility and newer intent",
    markerRecoveryMode: "repeated-pointer",
    marker: '        if (event.type === "pointerdown" && retry?.contains(event.target)) return;',
    replacement: "",
    failure: /restored A marker control must be fully visible below the sticky header/
  }
]) {
  assert.equal(source.split(negative.marker).length - 1, 1, `negative must alter one actual owning branch: ${negative.name}`);
  await assert.rejects(() => runFanhaoFavoriteUpdates({ casePattern: negative.casePattern, markerRecoveryMode: negative.markerRecoveryMode || "",
    sourceOverrides: { "/app.js": source.replace(negative.marker, negative.replacement) } }),
  error => error instanceof assert.AssertionError && negative.failure.test(error.message),
  `marker negative must fail its business assertion: ${negative.name}`);
  console.log(`PASS negative control detects missing ${negative.name}`);
}
console.log(metadataOnly ? "Local marker metadata checks passed." : negativeOnly ? "Local marker metadata and browser negatives passed." : "Local marker updates passed (14 native profiles, metadata helpers and precise negatives).");
