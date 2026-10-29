import { mergeShortVideoWatchPayload } from "./watch-write-payload.js";

// The server accepts positions in request order, including backward seeks.
// Keep one request per video in flight and retain its latest local intent until
// acknowledged. Failed writes wait for another user event or an explicit flush.
export function createShortVideoWatchWriteController({
  write,
  onUpdate = () => {},
  onError = () => {},
  now = Date.now,
  entries = new Map(),
  maxEntries = 128,
  maxInFlight = 4,
  saveIntervalMs = 4000,
  forceDedupeMs = 600
}) {
  let inFlightCount = 0;
  let sequence = 0;
  let keepaliveFlush = false;

  function trim(protectedId = "", reserve = 0) {
    while (entries.size + reserve > maxEntries) {
      const removable = [...entries].find(([id, entry]) => id !== protectedId
        && !entry.inFlight && !entry.dirty);
      if (!removable) return false;
      entries.delete(removable[0]);
    }
    return true;
  }

  function notifyError(error, id, phase = "write") {
    try {
      onError(error, { videoId: id, phase });
    } catch (callbackError) {
      console.warn("观看进度保存错误反馈失败", callbackError);
    }
  }

  function publish(entry, optimistic) {
    try {
      onUpdate(entry.id, { ...entry.watch }, { optimistic });
    } catch (error) {
      // Cache/UI synchronization cannot turn a committed receipt into a failed
      // write, or stop the transport queue before an accepted intent is sent.
      notifyError(error, entry.id, "cache");
    }
  }

  function completedWatch(previous, latest, progressMs) {
    const completedCount = Math.max(0, Number(previous?.completedCount) || 0,
      Number(latest?.completedCount) || 0);
    const completed = Boolean(previous?.completed || latest?.completed || completedCount > 0);
    return {
      ...previous,
      ...latest,
      progressMs,
      completed,
      completedCount: Math.max(completedCount, completed ? 1 : 0),
      lastWatchedAt: [previous?.lastWatchedAt, latest?.lastWatchedAt]
        .filter((value) => typeof value === "string").sort().at(-1) || ""
    };
  }

  function submit(videoId, value, { force = false, watch = {} } = {}) {
    const id = String(videoId || "").trim();
    if (!id) return false;
    let entry = entries.get(id);
    if (!entry) {
      if (!trim("", 1)) {
        const error = new Error("观看进度保存队列已满");
        error.code = "SHORT_VIDEO_WATCH_QUEUE_FULL";
        notifyError(error, id);
        return false;
      }
      entry = { id, version: 0, desired: null, watch, inFlight: null, ready: false,
        dirty: false, failed: false, lastSavedAt: null, lastAttemptAt: null,
        lastPayload: null, order: ++sequence };
      entries.set(id, entry);
    } else {
      entries.delete(id);
      entries.set(id, entry);
    }
    const payload = mergeShortVideoWatchPayload({ completed: entry.watch?.completed
      || Number(entry.watch?.completedCount) > 0 || entry.desired?.completed
      || watch?.completed || Number(watch?.completedCount) > 0 }, value);
    if (!entry.desired || payload.progressMs !== entry.desired.progressMs
      || payload.completed !== entry.desired.completed) entry.version += 1;
    entry.desired = payload;
    entry.watch = completedWatch(entry.watch, watch, payload.progressMs);
    entry.watch = completedWatch(entry.watch, payload, payload.progressMs);
    const timestamp = now();
    const sameAsSent = entry.inFlight && payload.progressMs === entry.inFlight.payload.progressMs
      && payload.completed === entry.inFlight.payload.completed;
    const recentlyAcknowledged = entry.lastSavedAt !== null && timestamp - entry.lastSavedAt < forceDedupeMs
      && entry.lastPayload?.completed === payload.completed
      && Math.abs(entry.lastPayload.progressMs - payload.progressMs) < 1000;
    entry.dirty = Boolean(entry.inFlight) || !entry.lastPayload
      || payload.progressMs !== entry.lastPayload.progressMs || payload.completed !== entry.lastPayload.completed;
    if (entry.inFlight) {
      if (!sameAsSent && (force || timestamp - entry.inFlight.startedAt >= saveIntervalMs)) entry.ready = true;
    } else if (force ? entry.failed || !recentlyAcknowledged
      : entry.failed ? timestamp - entry.lastAttemptAt >= saveIntervalMs
        : entry.lastSavedAt === null || timestamp - entry.lastSavedAt >= saveIntervalMs) {
      entry.ready = entry.dirty || !recentlyAcknowledged;
    }
    // Publish only accepted intents. Receipts for older versions must not move
    // the local resume position behind a seek made while they were in flight.
    publish(entry, true);
    pump();
    return true;
  }

  function receiptFor(id, data) {
    const videoId = String(data?.video?.id || data?.videoId || "").trim();
    const watch = data?.video?.watch || data?.watch;
    if (videoId !== id || !watch || !Number.isFinite(Number(watch.progressMs))) {
      const error = new Error("观看进度保存回执无效");
      error.code = "SHORT_VIDEO_WATCH_RECEIPT_INVALID";
      throw error;
    }
    return watch;
  }

  function dispatch(entry) {
    const request = { payload: { ...entry.desired }, version: entry.version, startedAt: now() };
    entry.inFlight = request;
    entry.lastAttemptAt = request.startedAt;
    entry.ready = false;
    entry.failed = false;
    inFlightCount += 1;
    // keepalive also covers an already-sent request when the page becomes
    // inactive before its response. The bounded payload is only two scalars.
    let response;
    try {
      response = write(entry.id, request.payload, { keepalive: true });
    } catch (error) {
      response = Promise.reject(error);
    }
    Promise.resolve(response).then((data) => {
      const receipt = receiptFor(entry.id, data);
      if (entries.get(entry.id) !== entry || entry.inFlight !== request) return;
      entry.lastSavedAt = now();
      entry.lastPayload = request.payload;
      const current = entry.version === request.version;
      entry.watch = completedWatch(entry.watch, receipt,
        current ? Math.max(0, Number(receipt.progressMs)) : entry.desired.progressMs);
      // Server near-end completion is sticky even when the submitted flag was false.
      if (entry.watch.completed) entry.desired = { ...entry.desired, completed: true };
      entry.dirty = !current;
      if (current) entry.ready = false;
      publish(entry, false);
    }).catch((error) => {
      if (entries.get(entry.id) !== entry || entry.inFlight !== request) return;
      entry.failed = true;
      entry.dirty = true;
      // A newer explicitly queued intent may run once. Do not loop on the
      // failed request itself, including ambiguous transport failures.
      if (entry.version === request.version) entry.ready = false;
      notifyError(error, entry.id);
    }).finally(() => {
      if (entry.inFlight !== request) return;
      entry.inFlight = null;
      inFlightCount -= 1;
      trim();
      pump();
    });
  }

  function pump() {
    const limit = keepaliveFlush ? maxEntries : maxInFlight;
    while (inFlightCount < limit) {
      const next = [...entries.values()].filter((entry) => entry.ready && !entry.inFlight)
        .sort((a, b) => a.order - b.order)[0];
      if (!next) break;
      next.order = ++sequence;
      dispatch(next);
    }
    keepaliveFlush = false;
  }

  function flush({ keepalive = false } = {}) {
    for (const entry of entries.values()) {
      if (entry.dirty && !entry.inFlight) entry.ready = true;
      else if (entry.inFlight && entry.version !== entry.inFlight.version) entry.ready = true;
    }
    // Queue all bounded, tiny unsent bodies before pagehide returns. A JS-only
    // queue behind a promise is not guaranteed to run after the page unloads.
    keepaliveFlush = Boolean(keepalive);
    pump();
  }

  return {
    submit,
    flush,
    latestWatch: (videoId, fallback = null) => {
      const entry = entries.get(String(videoId || "").trim());
      if (!entry) return null;
      if (!entry.dirty && !entry.inFlight && fallback?.lastWatchedAt
        && fallback.lastWatchedAt > String(entry.watch.lastWatchedAt || "")) return null;
      return { ...entry.watch };
    },
    stats: () => ({ size: entries.size, inFlight: inFlightCount,
      dirty: [...entries.values()].filter((entry) => entry.dirty).length })
  };
}
