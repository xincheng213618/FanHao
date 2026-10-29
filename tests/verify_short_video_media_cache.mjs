import assert from "node:assert/strict";
import { createShortVideoMediaCache } from "../public/modules/short-videos/media-cache.js";

// Exercise the actual cache with controlled API promises. No browser, service,
// database, real media or account state is accessed.
function fixture() {
  const requests = [], metrics = [], authorWrites = [], mediaReads = [];
  const cache = createShortVideoMediaCache({
    api: (url) => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
    cacheAuthorPanelVideo: (video) => authorWrites.push(video), cachedAuthorPanelVideo: () => null,
    getFeedParams: () => "source=liked&sort=published",
    markPerformance: (...args) => metrics.push(args),
    isGalleryPost: () => true, galleryImageEntries: () => [],
    shortVideoCardCoverUrl: (video) => { mediaReads.push(video); return ""; }
  });
  return { cache, requests, metrics, authorWrites, mediaReads };
}
const detail = (id, title = id, previous = `${id}-prev`, next = `${id}-next`) => ({
  video: { id, title }, prevId: previous, nextId: next,
  neighbors: { previous: [{ id: previous }], next: [{ id: next }] }
});

{
  const f = fixture();
  const first = f.cache.fetchDetail("A"), second = f.cache.fetchDetail("A");
  assert.equal(first, second, "the current detail request must be shared");
  assert.equal(f.requests.length, 1);
  assert.match(f.requests[0].url, /source=liked/);
  assert.match(f.requests[0].url, /neighbors=1/);
  assert.match(f.requests[0].url, /metadata=0/);
  f.requests[0].resolve(detail("A"));
  await first;
  assert.equal(f.cache.resolvedDetail("A").video.id, "A");
  assert.equal(f.cache.cachedNavigation("A").nextId, "A-next");
  assert.equal(f.cache.fetchDetail("A"), first, "a settled current request retains its existing cache-hit behavior");
}

for (const outcome of ["resolve", "reject"]) {
  const f = fixture(), params = "source=liked", owner = new AbortController();
  const oldRequest = f.cache.fetchDetail("A", params, { signal: owner.signal });
  // Attach rejection handling before deliberately invalidating its cache slot.
  const oldOutcome = oldRequest.then((data) => ({ data }), (error) => ({ error }));
  owner.abort();
  const freshRequest = f.cache.fetchDetail("A", params);
  const fresh = detail("A", "fresh-A", "fresh-prev", "fresh-next");
  f.requests[1].resolve(fresh);
  await freshRequest;
  if (outcome === "resolve") f.requests[0].resolve(detail("A", "old-A", "old-prev", "old-next"));
  else f.requests[0].reject(new Error("obsolete request failed"));
  const result = await oldOutcome;
  assert.equal(result.error.name, "AbortError", "an obsolete owner settles immediately even when its transport ignores cancellation");
  assert.equal(f.cache.resolvedDetail("A", params), fresh, "an obsolete completion must not replace or remove the new detail");
  assert.equal(f.cache.cachedNavigation("A", params).prevId, "fresh-prev", "an obsolete success must not replace current navigation");
  assert.equal(f.cache.cachedNavigation("A", params).nextId, "fresh-next");
  assert.equal(f.cache.cachedVideo("A").title, "fresh-A", "obsolete details must not overwrite the current video cache");
  assert.equal(f.cache.fetchDetail("A", params), freshRequest, "an obsolete rejection must not delete the replacement promise");
  assert.equal(f.requests.length, 2);
}

{
  const f = fixture(); let oldOwner = true;
  const oldRelated = f.cache.prefetchRelatedVideo({ id: "A" }, { owner: "old-related", isCurrent: () => oldOwner });
  oldOwner = false; f.cache.releaseDetails();
  const freshRelated = f.cache.prefetchRelatedVideo({ id: "A" });
  const fresh = detail("A", "fresh-related");
  f.requests[1].resolve(fresh); await freshRelated;
  const obsolete = detail("A", "obsolete-related");
  f.requests[0].resolve(obsolete);
  assert.equal(await oldRelated, null, "an obsolete optional prefetch settles without warming late data");
  assert.deepEqual(f.authorWrites, [fresh.video], "an obsolete related completion must not overwrite the shared author cache");
  assert.deepEqual(f.mediaReads, [fresh.video], "an obsolete related completion must not warm superseded media");
  assert.equal(await f.cache.prefetchRelatedVideo({ id: "A" }), fresh, "an already-published detail must retain its fast path");
  assert.equal(f.requests.length, 2, "the published fast path must not issue another detail request");
  assert.deepEqual(f.mediaReads, [fresh.video, fresh.video], "the published fast path still warms its current media");
}

{
  const f = fixture();
  const failed = f.cache.fetchDetail("A");
  f.requests[0].reject(new Error("current request failed"));
  await assert.rejects(failed, /current request failed/);
  assert.equal(f.cache.stats().detailRequests, 0);
  assert.equal(f.cache.resolvedDetail("A"), null);
  const retry = f.cache.fetchDetail("A");
  assert.notEqual(retry, failed, "a current failure must allow a new request");
  f.requests[1].resolve(detail("A", "retried")); await retry;
  assert.equal(f.cache.resolvedDetail("A").video.title, "retried");
}

{
  const f = fixture();
  const liked = f.cache.fetchDetail("A", "source=liked"), history = f.cache.fetchDetail("A", "source=history");
  assert.notEqual(liked, history, "feed contexts must retain distinct request keys");
  f.requests[0].resolve(detail("A", "liked-A", "liked-prev", "liked-next"));
  f.requests[1].resolve(detail("A", "history-A", "history-prev", "history-next"));
  await Promise.all([liked, history]);
  assert.equal(f.cache.cachedNavigation("A", "source=liked").nextId, "liked-next");
  assert.equal(f.cache.cachedNavigation("A", "source=history").nextId, "history-next");
  assert.equal(f.cache.resolvedDetail("A", "source=liked").video.title, "liked-A");
  assert.equal(f.cache.resolvedDetail("A", "source=history").video.title, "history-A");
}

{
  const f = fixture(), pending = [];
  for (let index = 0; index < 140; index += 1) {
    const promise = f.cache.fetchDetail(`bounded-${index}`); pending.push(promise);
    f.requests[index].resolve(detail(`bounded-${index}`)); await promise;
  }
  const stats = f.cache.stats();
  assert.equal(stats.detailRequests, 32); assert.equal(stats.resolvedDetails, 32);
  assert(stats.navigation <= 96, "navigation must retain its 96-entry bound");
  assert(stats.videos <= 32, "detail publication must preserve the existing video cache budget");
  assert.equal(f.cache.resolvedDetail("bounded-0"), null);
  assert.equal(f.cache.resolvedDetail("bounded-139").video.id, "bounded-139");
}

console.log("short-video-media-cache: request ownership, stale success/failure, retry, context keys and cache budgets passed");
