const HOVER_DELAY_MS = 90;

export function createWorkDetailDataService({
  getActiveUrl,
  pageDataService,
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

  function load(workId, options = {}) {
    return pageDataService.load(getActiveUrl(), path(workId), options);
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
