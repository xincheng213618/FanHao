const HOVER_DELAY_MS = 90;
const TOUCH_TAP_SLOP_PX = 12;

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

  function bindActivationIntent(target, resolveWorkId) {
    let touchIntent = null;
    target.addEventListener("pointerdown", (event) => {
      const workId = String(resolveWorkId(event) || "");
      touchIntent = null;
      if (!workId) return;
      if (event.pointerType === "touch") {
        cancelHover();
        touchIntent = beginTouchIntent(event, workId);
      } else {
        void warm(workId);
      }
    }, { passive: true });
    target.addEventListener("pointerup", (event) => {
      const intent = touchIntent;
      touchIntent = null;
      if (isTouchTap(intent, event) && String(resolveWorkId(event) || "") === intent.workId) void warm(intent.workId);
    }, { passive: true });
    target.addEventListener("pointercancel", () => {
      touchIntent = null;
    }, { passive: true });
  }

  function bind(target, workId) {
    if (!target) return;
    target.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "touch") schedule(workId);
    }, { passive: true });
    target.addEventListener("pointerleave", () => cancelHover(workId), { passive: true });
    bindActivationIntent(target, () => workId);
    target.addEventListener("focus", () => void warm(workId));
  }

  function bindContainer(container) {
    if (!container || boundContainers.has(container)) return;
    boundContainers.add(container);

    container.addEventListener("pointerover", (event) => {
      if (event.pointerType === "touch") return;
      const card = intentCard(container, event.target);
      if (!card || card.contains(event.relatedTarget)) return;
      schedule(card.dataset.workDetailId);
    }, { passive: true });
    container.addEventListener("pointerout", (event) => {
      const card = intentCard(container, event.target);
      if (!card || card.contains(event.relatedTarget)) return;
      cancelHover(card.dataset.workDetailId);
    }, { passive: true });
    bindActivationIntent(container, (event) => intentCard(container, event.target)?.dataset.workDetailId);
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

function beginTouchIntent(event, workId) {
  return {
    pointerId: event.pointerId,
    workId: String(workId || ""),
    x: Number(event.clientX || 0),
    y: Number(event.clientY || 0)
  };
}

function isTouchTap(intent, event) {
  if (!intent || event.pointerType !== "touch" || event.pointerId !== intent.pointerId) return false;
  const deltaX = Number(event.clientX || 0) - intent.x;
  const deltaY = Number(event.clientY || 0) - intent.y;
  return (deltaX * deltaX) + (deltaY * deltaY) <= TOUCH_TAP_SLOP_PX * TOUCH_TAP_SLOP_PX;
}
