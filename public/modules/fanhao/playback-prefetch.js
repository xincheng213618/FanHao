const DEFAULT_HOVER_DELAY_MS = 90;
const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_CACHE_LIMIT = 24;

export function createPlaybackPrefetch({
  api,
  cacheLimit = DEFAULT_CACHE_LIMIT,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  clearTimer = globalThis.clearTimeout,
  hoverDelayMs = DEFAULT_HOVER_DELAY_MS,
  setTimer = globalThis.setTimeout
}) {
  const prepared = new Map();
  let hoverTarget = "";
  let hoverTimer = null;

  function reusableEntry(workId) {
    const entry = prepared.get(workId);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > cacheTtlMs) {
      prepared.delete(workId);
      return null;
    }
    prepared.delete(workId);
    prepared.set(workId, entry);
    return entry;
  }

  function prepare(workId) {
    const key = String(workId || "").trim();
    if (!key) return Promise.resolve(null);
    cancel();
    const cached = reusableEntry(key);
    if (cached) return cached.promise;

    const entry = {
      createdAt: Date.now(),
      promise: null
    };
    entry.promise = api(`/api/works/${encodeURIComponent(key)}/playback-prewarm`).catch(() => {
      if (prepared.get(key) === entry) prepared.delete(key);
      return null;
    });
    prepared.set(key, entry);
    while (prepared.size > cacheLimit) prepared.delete(prepared.keys().next().value);
    return entry.promise;
  }

  function schedule(workId) {
    const key = String(workId || "").trim();
    if (!key) return;
    cancel();
    hoverTarget = key;
    hoverTimer = setTimer(() => {
      hoverTimer = null;
      hoverTarget = "";
      void prepare(key);
    }, hoverDelayMs);
  }

  function cancel(workId = "") {
    if (workId && hoverTarget !== String(workId)) return;
    if (hoverTimer) clearTimer(hoverTimer);
    hoverTimer = null;
    hoverTarget = "";
  }

  function bindContainer(container) {
    if (!container) return () => {};

    const findIntentTarget = (target) => {
      const intentTarget = target?.closest?.("[data-playback-work-id]");
      return intentTarget && container.contains(intentTarget) ? intentTarget : null;
    };
    const workIdFor = (target) => target?.dataset?.playbackWorkId || "";
    const handlePointerOver = (event) => {
      const intentTarget = findIntentTarget(event.target);
      if (!intentTarget || findIntentTarget(event.relatedTarget) === intentTarget) return;
      schedule(workIdFor(intentTarget));
    };
    const handlePointerOut = (event) => {
      const intentTarget = findIntentTarget(event.target);
      if (!intentTarget || findIntentTarget(event.relatedTarget) === intentTarget) return;
      cancel(workIdFor(intentTarget));
    };
    const handleFocusIn = (event) => {
      const intentTarget = findIntentTarget(event.target);
      if (intentTarget) void prepare(workIdFor(intentTarget));
    };
    const handlePointerDown = (event) => {
      const intentTarget = findIntentTarget(event.target);
      if (intentTarget) void prepare(workIdFor(intentTarget));
    };

    container.addEventListener("pointerover", handlePointerOver, { passive: true });
    container.addEventListener("pointerout", handlePointerOut, { passive: true });
    container.addEventListener("focusin", handleFocusIn);
    container.addEventListener("pointerdown", handlePointerDown, { passive: true });
    return () => {
      container.removeEventListener("pointerover", handlePointerOver);
      container.removeEventListener("pointerout", handlePointerOut);
      container.removeEventListener("focusin", handleFocusIn);
      container.removeEventListener("pointerdown", handlePointerDown);
    };
  }

  return { bindContainer, cancel, prepare, schedule };
}
