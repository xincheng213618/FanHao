const HOVER_DELAY_MS = 90;

export function createWorkDetailDataService({
  getActiveUrl,
  pageDataService,
  clearTimer = globalThis.clearTimeout,
  setTimer = globalThis.setTimeout
}) {
  let hoverTimer = 0;
  let hoverWorkId = "";
  const boundContainers = new WeakSet();

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

  function bindContainer(container) {
    if (!container || boundContainers.has(container)) return;
    boundContainers.add(container);

    container.addEventListener("pointerover", (event) => {
      const card = intentCard(container, event.target);
      if (!card || card.contains(event.relatedTarget)) return;
      schedule(card.dataset.workDetailId);
    }, { passive: true });
    container.addEventListener("pointerout", (event) => {
      const card = intentCard(container, event.target);
      if (!card || card.contains(event.relatedTarget)) return;
      cancelHover(card.dataset.workDetailId);
    }, { passive: true });
    container.addEventListener("pointerdown", (event) => {
      const card = intentCard(container, event.target);
      if (card) void warm(card.dataset.workDetailId);
    }, { passive: true });
    container.addEventListener("focusin", (event) => {
      const card = intentCard(container, event.target);
      if (card) void warm(card.dataset.workDetailId);
    });
  }

  function intentCard(container, target) {
    if (!target?.closest || target.closest("[data-work-intent-ignore]")) return null;
    const card = target.closest("[data-work-detail-id]");
    return card && container.contains(card) ? card : null;
  }

  return { bind, bindContainer, cancelHover, fetch, load, path, warm };
}
