// Cache capacity and transport concurrency are separate limits. Aborted
// transports keep their slot until they settle, even if a loader ignores abort.
export function createPrefetchCache({ limit = 8, ttlMs = 60_000, concurrency = 2 } = {}) {
  const entries = new Map();
  const active = new Set();

  function remove(key) {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    cancel(entry);
  }

  function cancel(entry) {
    clearTimeout(entry.timer);
    entry.controller.abort();
    entry.complete({ data: null, error: null });
  }

  function drain() {
    for (const entry of entries.values()) {
      if (active.size >= concurrency) break;
      if (entry.started || entry.controller.signal.aborted) continue;
      entry.started = true;
      active.add(entry);
      let loading;
      try { loading = entry.load(entry.controller.signal); }
      catch (error) { loading = Promise.reject(error); }
      Promise.resolve(loading).then(
        (data) => entry.complete({ data, error: null }),
        (error) => {
          if (entries.get(entry.key) === entry) entries.delete(entry.key);
          entry.complete({ data: null, error: entry.controller.signal.aborted ? null : error });
        }
      ).finally(() => {
        active.delete(entry);
        if (entries.get(entry.key) !== entry) clearTimeout(entry.timer);
        drain();
      });
    }
  }

  function prefetch(key, load) {
    const cached = entries.get(key);
    if (cached?.expiresAt > Date.now()) return cached.promise;
    remove(key);
    let resolve;
    const entry = {
      key, load, started: false, settled: false, controller: new AbortController(),
      expiresAt: Date.now() + ttlMs, promise: new Promise((yes) => { resolve = yes; })
    };
    entry.complete = (result) => {
      if (entry.settled) return;
      entry.settled = true;
      resolve(result);
    };
    entry.timer = setTimeout(() => {
      if (entries.get(key) === entry) entries.delete(key);
      cancel(entry);
      drain();
    }, ttlMs);
    entry.timer.unref?.();
    entries.set(key, entry);
    while (entries.size > limit) remove(entries.keys().next().value);
    drain();
    return entry.promise;
  }

  function consume(key, signal) {
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) { remove(key); return null; }
    entries.delete(key);
    // A submitted page gets a normal foreground request immediately instead
    // of waiting for a background slot, including abort-ignoring transports.
    if (!entry.started) { cancel(entry); return null; }
    const abort = () => { cancel(entry); drain(); };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    drain();
    return entry.promise.finally(() => {
      signal?.removeEventListener("abort", abort);
      clearTimeout(entry.timer);
    });
  }

  function clear(predicate = () => true) {
    for (const key of entries.keys()) if (predicate(key)) remove(key);
  }

  return { entries, prefetch, consume, clear };
}
