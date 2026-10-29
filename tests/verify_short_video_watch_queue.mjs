import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createShortVideoWatchWriteController } from "../public/modules/short-videos/watch-write-controller.js";
import { mergeShortVideoWatchPayload } from "../public/modules/short-videos/watch-write-payload.js";

// Controlled acknowledgements exercise the production queue and page adapters.
// No network, service, account, database or real media is accessed.
const settle = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
const receipt = (id, progressMs, extra = {}) => ({ videoId: id, watch: {
  progressMs, completed: false, completedCount: 0, lastWatchedAt: "2026-10-27T01:00:00.000Z", ...extra
} });
function fixture(options = {}) {
  let time = 1000;
  const entries = new Map(), requests = [], updates = [], errors = [];
  const queue = createShortVideoWatchWriteController({
    entries, now: () => time,
    write(id, payload, requestOptions) {
      return new Promise((resolve, reject) => requests.push({ id, payload, options: requestOptions, resolve, reject }));
    },
    onUpdate: (id, watch, flags) => updates.push({ id, watch: { ...watch }, flags }),
    onError: (error, context) => errors.push({ error, ...context }), ...options
  });
  return { queue, entries, requests, updates, errors, advance: milliseconds => { time += milliseconds; },
    submit: (progressMs, options = {}, id = "A") => queue.submit(id, { progressMs, completed: false, ...options.payload }, options) };
}

for (const progressMs of [NaN, Infinity, -Infinity, -5]) {
  assert.deepEqual(mergeShortVideoWatchPayload(null, { progressMs, completed: false }), { progressMs: 0, completed: false });
}
assert.deepEqual(mergeShortVideoWatchPayload({ completed: true }, { progressMs: 0, completed: false }),
  { progressMs: 0, completed: true }, "a backward seek to zero retains completion");

{
  const f = fixture();
  f.submit(12000, { force: true });
  assert.equal(f.entries.get("A").lastSavedAt, null, "an attempt is not a successful save");
  f.requests[0].reject(new Error("offline"));
  await settle();
  assert.equal(f.requests.length, 1, "failed writes must not automatically loop");
  assert.equal(f.entries.get("A").lastSavedAt, null);
  f.advance(100);
  f.submit(12100);
  assert.equal(f.requests.length, 1, "routine timeupdates must not retry a sustained failure at media-event frequency");
  f.submit(12000, { force: true });
  assert.equal(f.requests.length, 2, "the same forced position must be retryable immediately after failure");
  f.requests[1].resolve(receipt("A", 12000));
  await settle();
  assert.equal(f.entries.get("A").lastSavedAt, 1100);
  f.submit(12000, { force: true });
  assert.equal(f.requests.length, 2, "a successfully acknowledged duplicate is deduplicated");
  f.submit(12500);
  assert.equal(f.requests.length, 2, "ordinary playback retains the periodic write throttle");
  assert.equal(f.queue.latestWatch("A").progressMs, 12500, "throttled local progress remains available for resume");
  f.advance(4000);
  f.submit(16500);
  assert.equal(f.requests.length, 3);
}

{
  const f = fixture();
  f.submit(1000);
  f.requests[0].reject(new Error("offline"));
  await settle();
  for (let index = 0; index < 15; index++) {
    f.advance(250);
    f.submit(1250 + index * 250);
  }
  assert.equal(f.requests.length, 1);
  f.advance(250);
  f.submit(5000);
  assert.equal(f.requests.length, 2, "a subsequent playback event retries only after the normal save interval");
  assert.equal(f.requests[1].payload.progressMs, 5000);
}

{
  const f = fixture();
  f.submit(60000, { force: true, payload: { completed: true } });
  f.submit(14000, { force: true });
  f.submit(0, { force: true });
  assert.equal(f.requests.length, 1, "same-video requests remain serial");
  assert.equal(f.queue.latestWatch("A").progressMs, 0);
  f.requests[0].resolve(receipt("A", 60000, { completed: true, completedCount: 1 }));
  await settle();
  assert.equal(f.queue.latestWatch("A").progressMs, 0, "an old receipt cannot overwrite the latest backward seek");
  assert.equal(f.updates.at(-1).watch.progressMs, 0);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[1].payload, { progressMs: 0, completed: true });
  f.requests[1].resolve(receipt("A", 0, { completed: true, completedCount: 1 }));
  await settle();
  assert.equal(f.queue.latestWatch("A").progressMs, 0, "a zero acknowledgement stays zero");
  assert.equal(f.queue.stats().dirty, 0);
  assert.equal(f.queue.latestWatch("A", { lastWatchedAt: "2026-10-28T01:00:00.000Z" }), null,
    "a newer external watch record wins over a clean local cache");
}

{
  const f = fixture();
  f.submit(1000);
  f.advance(200);
  f.submit(1200);
  f.requests[0].resolve(receipt("A", 1000));
  await settle();
  assert.equal(f.requests.length, 1, "a fast success does not turn every timeupdate into a new request");
  assert.equal(f.queue.latestWatch("A").progressMs, 1200, "even an unforced local point survives an older acknowledgement");
  f.queue.flush({ keepalive: true });
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].payload.progressMs, 1200, "inactive flush includes the latest throttled point");
}

{
  const f = fixture();
  f.submit(1000);
  f.advance(4500);
  f.submit(9000);
  f.submit(10000);
  f.requests[0].resolve(receipt("A", 1000));
  await settle();
  assert.equal(f.requests.length, 2, "a slow in-flight request coalesces the latest eligible periodic point");
  assert.equal(f.requests[1].payload.progressMs, 10000);
}

{
  const f = fixture();
  f.submit(59000, { force: true });
  f.submit(2000, { force: true });
  f.requests[0].reject(new Error("ambiguous transport failure"));
  await settle();
  assert.equal(f.requests.length, 2, "one newer queued intent may follow a failure");
  assert.equal(f.requests[1].payload.progressMs, 2000);
  f.requests[1].reject(new Error("still offline"));
  await settle();
  assert.equal(f.requests.length, 2, "the newer failure must also stop without a retry timer");
  f.queue.flush();
  assert.equal(f.requests.length, 3, "explicit flush retries the retained inactive intent");
  assert.equal(f.requests[2].payload.progressMs, 2000);
}

{
  const f = fixture();
  f.submit(59000, { force: true });
  f.requests[0].resolve(receipt("A", 59000, { completed: true, completedCount: 1 }));
  await settle();
  assert.equal(f.queue.latestWatch("A").completed, true, "server-derived near-end completion is retained locally");
  f.advance(1000);
  f.submit(2000, { force: true });
  assert.equal(f.requests[1].payload.completed, true);
  f.requests[1].resolve(receipt("other-video", 2000));
  await settle();
  assert.equal(f.errors.at(-1).error.code, "SHORT_VIDEO_WATCH_RECEIPT_INVALID");
  f.submit(2000, { force: true });
  assert.equal(f.requests.length, 3, "an invalid acknowledgement cannot poison duplicate suppression");
}

{
  const f = fixture({ maxEntries: 6, maxInFlight: 2 });
  for (const id of ["A", "B", "C", "D", "E", "F"]) f.submit(2000, { force: true }, id);
  assert.equal(f.requests.length, 2);
  assert.equal(f.queue.stats().size, 6);
  const count = f.updates.length;
  assert.equal(f.submit(2000, { force: true }, "G"), false, "a saturated queue explicitly rejects a new video");
  assert.equal(f.updates.length, count, "capacity rejection must not publish a fake saved/local resume snapshot");
  assert.equal(f.errors.at(-1).error.code, "SHORT_VIDEO_WATCH_QUEUE_FULL");
  assert.equal(f.queue.stats().size, 6, "dirty and in-flight writes are bounded without silent eviction");
  f.requests[0].resolve(receipt("A", 2000));
  await settle();
  assert.equal(f.requests.length, 3, "success releases one ordinary concurrency slot");
  assert.equal(f.submit(2000, { force: true }, "G"), true, "only an acknowledged inactive entry may be evicted");
  assert.equal(f.queue.stats().size, 6);
  f.queue.flush({ keepalive: true });
  assert.equal(f.requests.length, 7, "pagehide dispatches bounded unsent videos before its callback returns");
  assert(f.requests.every(request => request.options.keepalive === true));
  f.queue.flush({ keepalive: true });
  assert.equal(f.requests.length, 7, "repeated flush does not duplicate requests already in flight");
}

{
  const f = fixture({ write() { throw new Error("synchronous transport failure"); } });
  f.submit(1000, { force: true });
  await settle();
  assert.equal(f.queue.stats().inFlight, 0);
  assert.equal(f.queue.stats().dirty, 1);
  assert.equal(f.errors.length, 1);
}

{
  const f = fixture({ onUpdate() { throw new Error("cache synchronization failed"); } });
  f.submit(1000, { force: true });
  assert.equal(f.requests.length, 1, "a cache callback failure cannot strand an accepted intent");
  f.requests[0].resolve(receipt("A", 1000));
  await settle();
  assert.equal(f.queue.stats().dirty, 0, "a successful write stays acknowledged even if local cache synchronization fails");
  f.submit(1000, { force: true });
  assert.equal(f.requests.length, 1, "a cache failure cannot trigger duplicate writes of a committed point");
}

{
  const originalWarn = console.warn, warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    const f = fixture({ maxInFlight: 1, onError() { throw new Error("notification failed"); } });
    f.submit(1000, { force: true }, "A");
    f.submit(2000, { force: true }, "B");
    f.requests[0].reject(new Error("offline"));
    await settle();
    assert.equal(f.requests.length, 2, "a broken notification cannot stop the next video's queued write");
    assert.equal(f.requests[1].id, "B");
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
  }
}

const source = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function pageFunction(name) {
  const match = new RegExp(`^  function ${name}\\(`, "m").exec(source);
  assert(match, `missing current page function: ${name}`);
  const end = source.indexOf("\n  }", match.index);
  return source.slice(match.index, end + 4);
}
function pageFixture() {
  let time = 1000;
  const video = { id: "A", watch: { progressMs: 5000, completed: false } };
  const copies = Array.from({ length: 4 }, () => ({ id: "A", watch: { ...video.watch } }));
  const requests = [], notices = [], warnings = [];
  const context = vm.createContext({
    Date: { now: () => time }, createShortVideoWatchWriteController,
    shortVideoWatchWrites: new Map(), shortVideoWatchWriteController: null, shortVideoWatchWriteNoticeAt: null,
    SHORT_VIDEO_WATCH_WRITE_CACHE_LIMIT: 128, SHORT_VIDEO_WATCH_SAVE_INTERVAL: 4000,
    state: { activeView: "shortVideos", shortVideo: { current: video, prevVideo: copies[0], data: { videos: [copies[1]] } } },
    document: { hidden: false }, console: { warn: (...args) => warnings.push(args) },
    isCurrentShortVideo: (a, b) => a.id === b.id,
    isDeletedShortVideo: () => false,
    cachedShortVideo: () => copies[2], resolvedShortVideoDetail: () => ({ video: copies[3] }),
    showBrowserToast: value => notices.push(value),
    api: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }))
  });
  vm.runInContext(["persistShortVideoWatch", "ensureShortVideoWatchWriteController", "dispatchShortVideoWatchWrite", "syncShortVideoWatchVideo"]
    .map(pageFunction).join("\n"), context);
  return { context, video, copies, requests, notices, warnings, advance: ms => { time += ms; } };
}

{
  const f = pageFixture();
  assert.equal(f.context.persistShortVideoWatch(f.video, { currentTime: 32.5 }, { force: true }), true);
  assert.match(f.requests[0].url, /\/A\/watch$/);
  assert.equal(f.requests[0].options.method, "PUT");
  assert.equal(f.requests[0].options.keepalive, true);
  assert.equal(f.requests[0].options.body.progressMs, 32500);
  assert([f.video, ...f.copies].every(video => video.watch.progressMs === 32500), "accepted progress updates current and cached resume objects");
  f.context.persistShortVideoWatch(f.video, { currentTime: 0 }, { force: true });
  f.requests[0].resolve(receipt("A", 32500));
  await settle();
  assert([f.video, ...f.copies].every(video => video.watch.progressMs === 0), "an old response cannot rewind a newer cached seek");
  assert.equal(f.requests[1].options.body.progressMs, 0);
  f.requests[1].reject(new Error("offline"));
  await settle();
  assert.deepEqual(f.notices, ["部分观看进度尚未保存"]);
  f.context.persistShortVideoWatch(f.video, { currentTime: 0 }, { force: true });
  assert.equal(f.requests.length, 3, "the actual page adapter retries a failed identical force");
  f.requests[2].reject(new Error("offline again"));
  await settle();
  assert.equal(f.notices.length, 1, "repeated errors do not flood playback with toasts");
  f.advance(31000);
  f.context.document.hidden = true;
  f.context.persistShortVideoWatch(f.video, { currentTime: 1 }, { force: true });
  f.requests[3].reject(new Error("hidden"));
  await settle();
  assert.equal(f.notices.length, 1, "inactive keepalive failures do not show playback UI");
  assert.equal(f.warnings.length, 3, "every failure remains observable in diagnostics");
}

console.log("short-video-watch-queue: ok (acknowledgement throttle, latest-position/completion merge, bounded queue, keepalive and actual page/cache adapters)");
