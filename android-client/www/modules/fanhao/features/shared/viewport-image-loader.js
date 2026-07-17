import { absoluteUrl, loadPreviewImage } from "../../../../js/image.js?v=20260717-fanhao-cover-prepare-01";

const DEFAULT_ROOT_MARGIN = "720px 0px";

export function createViewportImageLoader({
  createObserver = defaultObserver,
  getActiveUrl,
  loadImage = loadPreviewImage,
  rootMargin = DEFAULT_ROOT_MARGIN
}) {
  let observer = null;
  const pending = new Map();

  function schedule(target, imagePath) {
    if (!target || !imagePath) return;

    const baseUrl = getActiveUrl();
    const request = {
      baseUrl,
      imageUrl: absoluteUrl(baseUrl, imagePath)
    };
    const activeObserver = ensureObserver();
    if (!activeObserver) {
      start(target, request);
      return;
    }

    pending.set(target, request);
    activeObserver.observe(target);
  }

  function ensureObserver() {
    if (observer) return observer;
    observer = createObserver(onIntersection, { rootMargin, threshold: 0.01 });
    return observer;
  }

  function onIntersection(entries = []) {
    for (const entry of entries) {
      if (!entry?.isIntersecting && Number(entry?.intersectionRatio || 0) <= 0) continue;
      const request = pending.get(entry.target);
      if (request) start(entry.target, request);
    }
  }

  function start(target, request) {
    observer?.unobserve(target);
    pending.delete(target);
    Promise.resolve(loadImage(target, request.imageUrl, { cacheBaseUrl: request.baseUrl })).catch(() => {});
  }

  function reset() {
    observer?.disconnect();
    observer = null;
    pending.clear();
  }

  return { pendingCount: () => pending.size, reset, schedule };
}

function defaultObserver(callback, options) {
  if (typeof globalThis.IntersectionObserver !== "function") return null;
  return new globalThis.IntersectionObserver(callback, options);
}
