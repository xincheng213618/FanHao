const HOVER_DELAY_MS = 90;

export function createWorkDetailDataService({
  getActiveUrl,
  pageDataService,
  readCachedJson,
  clearTimer = globalThis.clearTimeout,
  setTimer = globalThis.setTimeout
}) {
  let hoverTimer = 0;
  let hoverWorkId = "";

  function path(workId) {
    return `/api/works/${encodeURIComponent(String(workId || ""))}`;
  }

  function fetch(workId, options = {}) {
    return pageDataService.fetch(getActiveUrl(), path(workId), {
      signal: options.signal,
      reuseWarmed: true
    });
  }

  async function load(workId, options = {}) {
    const activeUrl = getActiveUrl();
    const requestPath = path(workId);
    const isActive = options.isActive || (() => true);
    const freshRequest = fetch(workId, options).then((data) => ({ source: "fresh", data }), (error) => ({ source: "fresh", error }));
    const cacheRequest = readCachedJson(activeUrl, requestPath)
      .then((cache) => ({ source: "cache", cache }), () => ({ source: "cache", cache: null }));
    const first = await Promise.race([freshRequest, cacheRequest]);
    if (!isActive()) return null;
    if (first.source === "fresh" && !first.error) return { data: first.data, unchanged: false };

    const cached = first.source === "cache" ? first.cache : (await cacheRequest).cache;
    const cachedSignature = cached?.payload?.work ? JSON.stringify(cached.payload) : "";
    if (cachedSignature) options.onCached?.(cached.payload, cached);
    const fresh = first.source === "fresh" ? first : await freshRequest;
    if (fresh.error) throw fresh.error;
    return {
      data: fresh.data,
      unchanged: Boolean(cachedSignature && JSON.stringify(fresh.data) === cachedSignature)
    };
  }

  function warm(workId) {
    const id = String(workId || "").trim();
    if (!id || globalThis.navigator?.connection?.saveData) return Promise.resolve([]);
    return pageDataService.warm(getActiveUrl(), [path(id)]);
  }

  function cancelHover(workId = "") {
    if (workId && hoverWorkId !== String(workId)) return;
    if (hoverTimer) clearTimer(hoverTimer);
    hoverTimer = 0;
    hoverWorkId = "";
  }

  function schedule(workId) {
    const id = String(workId || "").trim();
    if (!id) return;
    cancelHover();
    hoverWorkId = id;
    hoverTimer = setTimer(() => {
      hoverTimer = 0;
      hoverWorkId = "";
      void warm(id);
    }, HOVER_DELAY_MS);
  }

  function bind(target, workId) {
    if (!target) return;
    target.addEventListener("pointerenter", () => schedule(workId), { passive: true });
    target.addEventListener("pointerleave", () => cancelHover(workId), { passive: true });
    target.addEventListener("pointerdown", () => void warm(workId), { passive: true });
    target.addEventListener("focus", () => void warm(workId));
  }

  return { bind, cancelHover, fetch, load, path, warm };
}
