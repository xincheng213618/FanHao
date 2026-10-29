import assert from "node:assert/strict";
import { createShortVideoMediaCache } from "../public/modules/short-videos/media-cache.js";

// Actual factory, controlled AbortSignal-aware/ignoring API and clock. Never
// starts a browser, service, database or real media request.
const detail = (id, title = id) => ({ video: { id, title }, prevId: "", nextId: "", neighbors: { previous: [], next: [] } });
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
const previous = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
let clock = 0, sequence = 0;
const timers = new Map();
globalThis.setTimeout = (callback, delay) => {
  const id = { id: ++sequence, unref() {} }; timers.set(id, { callback, at: clock + delay }); return id;
};
globalThis.clearTimeout = id => timers.delete(id);
async function tick(duration) {
  const end = clock + duration;
  for (;;) {
    const next = [...timers].filter(([, timer]) => timer.at <= end).sort((left, right) => left[1].at - right[1].at)[0];
    if (!next) break;
    timers.delete(next[0]); clock = next[1].at; next[1].callback(); await flush();
  }
  clock = end; await flush();
}
const result = promise => {
  const state = { status: "pending" };
  state.done = promise.then(data => { state.status = "fulfilled"; state.data = data; }, error => { state.status = "rejected"; state.error = error; });
  return state;
};
function fixture({ honorAbort = true } = {}) {
  const requests = [], authorWrites = [], metrics = [];
  let physical = 0, highWater = 0;
  const cache = createShortVideoMediaCache({
    api(url, options = {}) {
      physical++; highWater = Math.max(highWater, physical);
      return new Promise((resolve, reject) => {
        const request = { url, signal: options.signal, aborts: 0, settled: false,
          resolve(value = detail(decodeURIComponent(/\/([^/?]+)\?/.exec(url)[1]))) {
            if (request.settled) return; request.settled = true; physical--;
            options.signal?.removeEventListener("abort", onAbort); resolve(value);
          },
          reject(error) {
            if (request.settled) return; request.settled = true; physical--;
            options.signal?.removeEventListener("abort", onAbort); reject(error);
          }
        };
        const onAbort = () => { request.aborts++; if (honorAbort) request.reject(Object.assign(new Error("transport abort"), { name: "AbortError" })); };
        options.signal?.addEventListener("abort", onAbort, { once: true }); requests.push(request);
      });
    },
    cacheAuthorPanelVideo: video => authorWrites.push(video), cachedAuthorPanelVideo: () => null,
    getFeedParams: () => "source=liked", markPerformance: (...args) => metrics.push(args),
    isGalleryPost: () => true, galleryImageEntries: () => [], shortVideoCardCoverUrl: () => "", canSpeculate: () => true
  });
  return { cache, requests, authorWrites, metrics, get physical() { return physical; }, get highWater() { return highWater; },
    async close() {
      cache.releaseDetails({ force: true });
      for (const request of requests) request.resolve();
      await flush(); assert.equal(physical, 0); assert.equal(cache.stats().detailActive, 0); assert.equal(cache.stats().detailQueued, 0);
      assert.equal(timers.size, 0);
    } };
}
let cases = 0;
try {
  {
    const f = fixture({ honorAbort: false });
    try {
      const states = [];
      for (let index = 0; index < 128; index++) states.push(result(f.cache.fetchDetail(String(index % 64), index < 64 ? "source=liked" : "source=history")));
      assert.equal(f.requests.length, 4); assert.equal(f.physical, 4); assert.equal(f.cache.stats().detailActive, 4);
      assert.equal(f.cache.stats().detailQueued, 6); assert(f.cache.stats().detailRequests <= 10);
      assert(f.requests.every(request => request.signal instanceof AbortSignal));
      await flush(); assert.equal(states.filter(state => state.status === "rejected").length, 118);
      f.cache.releaseDetails({ force: true }); await flush();
      assert.equal(f.cache.stats().detailActive, 4, "logical cancellation never frees a still-pending physical transport");
      assert.equal(f.physical, 4); assert.equal(f.cache.stats().detailQueued, 0); assert.equal(timers.size, 0);
      assert(f.requests.every(request => request.aborts === 1)); cases++;
    } finally { await f.close(); }
  }
  {
    const f = fixture();
    try {
      const first = f.cache.fetchDetail("A"), second = f.cache.fetchDetail("A");
      assert.equal(first, second); assert.equal(f.requests.length, 1);
      f.requests[0].resolve(); await first;
      assert.equal(f.cache.fetchDetail("A"), first, "legacy settled and pending same-key promise identity stays compatible");
      assert.equal(f.cache.resolvedDetail("A").video.id, "A"); cases++;
    } finally { await f.close(); }
  }
  {
    const f = fixture(), one = new AbortController(), two = new AbortController();
    try {
      const first = result(f.cache.fetchDetail("A", "source=liked", { signal: one.signal }));
      const second = result(f.cache.fetchDetail("A", "source=liked", { signal: two.signal }));
      assert.equal(f.requests.length, 1); one.abort(); await first.done;
      assert.equal(first.error.name, "AbortError"); assert.equal(f.requests[0].aborts, 0);
      assert.equal(second.status, "pending", "one owner's cancellation cannot reject the other owner");
      f.requests[0].resolve(); await second.done; assert.equal(second.data.video.id, "A"); cases++;
    } finally { await f.close(); }
  }
  {
    const f = fixture({ honorAbort: false }), owner = new AbortController();
    try {
      const old = result(f.cache.fetchDetail("A", "source=liked", { signal: owner.signal })); owner.abort(); await old.done;
      assert.equal(f.requests[0].aborts, 1); assert.equal(f.cache.stats().detailActive, 1);
      const fresh = f.cache.fetchDetail("A", "source=liked"); assert.equal(f.requests.length, 2);
      f.requests[1].resolve(detail("A", "fresh")); await fresh;
      f.requests[0].resolve(detail("A", "old")); await flush();
      assert.equal(f.cache.resolvedDetail("A").video.title, "fresh");
      assert.equal(f.cache.cachedVideo("A").title, "fresh"); assert.equal(f.cache.fetchDetail("A", "source=liked"), fresh); cases++;
    } finally { await f.close(); }
  }
  {
    const f = fixture();
    try {
      const expired = result(f.cache.fetchDetail("hung")); await tick(11999); assert.equal(expired.status, "pending");
      await tick(1); await expired.done;
      assert.equal(expired.error.code, "SHORT_VIDEO_DETAIL_TIMEOUT"); assert.equal(expired.error.retryable, true);
      assert.equal(f.requests[0].aborts, 1); assert.equal(f.cache.stats().detailRequests, 0); assert.equal(f.cache.stats().detailActive, 0);
      const retry = f.cache.fetchDetail("hung"); assert.equal(f.requests.length, 2);
      f.requests[1].resolve(detail("hung", "recovered")); assert.equal((await retry).video.title, "recovered"); cases++;
    } finally { await f.close(); }
  }
  {
    const f = fixture({ honorAbort: false });
    try {
      const first = Array.from({ length: 4 }, (_, index) => result(f.cache.fetchDetail(`active-${index}`)));
      const queued = result(f.cache.fetchDetail("queued"));
      await tick(12000); assert(first.every(state => state.error?.code === "SHORT_VIDEO_DETAIL_TIMEOUT"));
      assert.equal(queued.status, "pending", "the deadline starts at actual dispatch, not while waiting for a physical slot");
      assert.equal(f.physical, 4); assert.equal(f.requests.length, 4); assert.equal(f.cache.stats().detailActive, 4);
      f.requests[0].resolve(); await flush(); assert.equal(f.requests.length, 5); assert.equal(f.requests[4].aborts, 0);
      await tick(11999); assert.equal(queued.status, "pending"); await tick(1); await queued.done;
      assert.equal(queued.error.code, "SHORT_VIDEO_DETAIL_TIMEOUT"); assert.equal(f.highWater, 4); cases++;
    } finally { await f.close(); }
  }
  {
    const f = fixture({ honorAbort: false });
    try {
      for (let index = 0; index < 4; index++) result(f.cache.fetchDetail(`warm-${index}`, "source=liked", { priority: "speculative" }));
      const queuedWarm = result(f.cache.fetchDetail("queued-warm", "source=liked", { priority: "speculative" }));
      const current = result(f.cache.fetchDetail("chosen", "source=liked", { priority: "current" }));
      assert.equal(f.requests[0].aborts, 1, "a current video requests cancellation of speculative work");
      assert.equal(f.requests.length, 4, "preemption retains a cancelled transport's real slot");
      f.requests[0].resolve(); await flush(); assert(f.requests.at(-1).url.includes("/chosen?"));
      f.requests.at(-1).resolve(); await current.done; await flush(); assert(f.requests.at(-1).url.includes("/queued-warm?"));
      f.requests.at(-1).resolve(); await queuedWarm.done; assert.equal(f.highWater, 4); cases++;
    } finally { await f.close(); }
  }
  {
    const f = fixture(); let live = true;
    try {
      const warm = f.cache.prefetchRelatedVideo({ id: "shared" }, { owner: "warm", isCurrent: () => live });
      const current = f.cache.fetchDetail("shared", "source=liked", { owner: "current", isCurrent: () => true });
      live = false; f.cache.releasePlaybackPreloads({ force: true });
      assert.equal(await warm, null); assert.equal(f.requests[0].aborts, 0);
      f.requests[0].resolve(); assert.equal((await current).video.id, "shared");
      assert.equal(f.authorWrites.length, 0); cases++;
    } finally { await f.close(); }
  }
  {
    const f = fixture({ honorAbort: false }); let scope = "old";
    try {
      const old = result(f.cache.fetchDetail("A", "source=liked", { owner: "old", isCurrent: () => scope === "old" }));
      scope = "new"; f.cache.releaseDetails(); await old.done; assert.equal(old.error.name, "AbortError");
      const current = f.cache.fetchDetail("A", "source=history", { owner: "new", isCurrent: () => scope === "new" });
      f.requests[1].resolve(detail("A", "new-scope")); await current;
      f.requests[0].resolve(detail("A", "old-scope")); await flush();
      assert.equal(f.cache.resolvedDetail("A", "source=liked"), null);
      assert.equal(f.cache.cachedVideo("A").title, "new-scope"); cases++;
    } finally { await f.close(); }
  }
  {
    const f = fixture({ honorAbort: false });
    try {
      const survivor = f.cache.fetchDetail("survivor"), removed = result(f.cache.fetchDetail("deleted"));
      f.cache.forgetVideos(["deleted"]); await removed.done;
      assert.equal(removed.error.code, "SHORT_VIDEO_DELETED"); assert.equal(f.requests[1].aborts, 1); assert.equal(f.requests[0].aborts, 0);
      assert.equal(f.cache.fetchDetail("survivor"), survivor, "unrelated deletion retains the current viewer's pending detail");
      f.requests[0].resolve({ ...detail("survivor"), prevId: "deleted", prevVideo: { id: "deleted" } });
      const metadata = await survivor;
      assert.equal(metadata.prevId, ""); assert.equal(metadata.video.id, "survivor");
      assert.equal(metadata.shortVideoNavigationInvalidated, true, "surviving metadata explicitly marks its old neighbor membership for page consumers");
      assert.equal(f.cache.resolvedDetail("survivor"), null, "old membership is returned sanitized without being cached");
      const refresh = f.cache.fetchDetail("survivor"); assert.notEqual(refresh, survivor); f.requests.at(-1).resolve(); await refresh;
      f.requests[1].resolve(detail("deleted")); await flush(); assert.equal(f.cache.cachedVideo("deleted"), null); cases++;
    } finally { await f.close(); }
  }
  {
    const f = fixture({ honorAbort: false });
    try {
      for (let index = 0; index < 4; index++) result(f.cache.fetchDetail(`active-${index}`));
      const queued = Array.from({ length: 6 }, (_, index) => result(f.cache.fetchDetail(`queue-${index}`)));
      const speculative = result(f.cache.fetchDetail("speculative", "source=liked", { priority: "speculative" }));
      await speculative.done; assert.equal(speculative.error.name, "AbortError");
      assert.equal(f.cache.stats().detailQueued, 6); assert(queued.every(state => state.status === "pending"));
      result(f.cache.fetchDetail("new-current")); await queued[0].done;
      assert.equal(queued[0].error.name, "AbortError"); assert.equal(f.cache.stats().detailQueued, 6);
      f.requests[0].resolve(); await flush(); assert(f.requests.at(-1).url.includes("/queue-1?"), "surviving current requests retain FIFO order"); cases++;
    } finally { await f.close(); }
  }
  {
    const f = fixture(), controller = new AbortController(), listeners = new Set();
    const signal = controller.signal, add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (type, callback, ...args) => { if (type === "abort") listeners.add(callback); return add(type, callback, ...args); };
    signal.removeEventListener = (type, callback, ...args) => { if (type === "abort") listeners.delete(callback); return remove(type, callback, ...args); };
    try {
      const request = f.cache.fetchDetail("A", "source=liked", { signal }); assert.equal(listeners.size, 1);
      f.requests[0].resolve(); await request; assert.equal(listeners.size, 0);
      controller.abort(); assert.equal(f.requests[0].aborts, 0, "completed consumers retain no abort listener");
      assert.equal(await f.cache.prefetchRelatedVideo({ id: "A" }, { signal }), null, "a cancelled cached prefetch cannot start media or author work"); cases++;
    } finally { await f.close(); }
  }
  {
    const f = fixture();
    try {
      const speculative = [];
      for (let index = 0; index < 32; index++) speculative.push(result(f.cache.fetchDetail("shared", "source=liked", { owner: `warm-${index}`, priority: "speculative" })));
      const current = [];
      for (let index = 0; index < 32; index++) current.push(result(f.cache.fetchDetail("shared", "source=liked", { owner: `current-${index}`, priority: "current" })));
      await flush(); assert(speculative.every(state => state.error?.name === "AbortError"));
      assert.equal(f.cache.stats().detailConsumers, 32); assert.equal(f.requests.length, 1); assert.equal(f.requests[0].aborts, 0);
      const busy = result(f.cache.fetchDetail("shared", "source=liked", { owner: "over-budget" })); await busy.done;
      assert.equal(busy.error.code, "SHORT_VIDEO_DETAIL_BUSY"); assert.equal(busy.error.retryable, true);
      assert(current.every(state => state.status === "pending"), "rejecting an excess owner leaves accepted current consumers intact");
      f.requests[0].resolve(); await Promise.all(current.map(state => state.done));
      assert(current.every(state => state.data.video.id === "shared")); assert.equal(f.cache.stats().detailConsumers, 0); cases++;
    } finally { await f.close(); }
  }
  {
    const f = fixture();
    try {
      for (let index = 0; index < 140; index++) {
        const pending = f.cache.fetchDetail(String(index)); f.requests.at(-1).resolve(); await pending; await flush();
      }
      const stats = f.cache.stats(); assert.equal(stats.detailRequests, 32); assert.equal(stats.resolvedDetails, 32);
      assert.equal(stats.detailActive, 0); assert.equal(stats.detailQueued, 0); assert.equal(timers.size, 0); cases++;
    } finally { await f.close(); }
  }
  console.log(`short-video-detail-requests: passed ${cases} actual cache deadline/physical budget/shared-owner/late completion groups`);
} finally {
  Object.assign(globalThis, previous);
}
