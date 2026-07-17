const DEFAULT_INITIAL_COUNT = 12;
const DEFAULT_BATCH_SIZE = 12;
const DEFAULT_BATCH_DELAY_MS = 16;
const DEFAULT_LOOKAHEAD_DISTANCE = 720;

export function createViewportBatchRenderer(options = {}) {
  const container = options.container;
  const appendBatch = options.appendBatch;
  const initialCount = positiveInteger(options.initialCount, DEFAULT_INITIAL_COUNT);
  const batchSize = positiveInteger(options.batchSize, DEFAULT_BATCH_SIZE);
  const batchDelayMs = Math.max(0, Number(options.batchDelayMs ?? DEFAULT_BATCH_DELAY_MS));
  const lookaheadDistance = Math.max(0, Number(options.lookaheadDistance ?? DEFAULT_LOOKAHEAD_DISTANCE));
  const setTimer = options.setTimer || ((callback, delay) => globalThis.setTimeout(callback, delay));
  const clearTimer = options.clearTimer || ((timer) => globalThis.clearTimeout(timer));
  const Observer = options.IntersectionObserver || globalThis.IntersectionObserver;
  let timer = null;
  let observer = null;
  let sentinel = null;
  let renderVersion = 0;

  function cancel() {
    renderVersion += 1;
    if (timer !== null) clearTimer(timer);
    timer = null;
    observer?.disconnect();
    observer = null;
    sentinel?.remove();
    sentinel = null;
  }

  function render(items, onComplete = () => {}) {
    cancel();
    const version = renderVersion;
    const list = Array.isArray(items) ? items : [];
    let rendered = Math.min(initialCount, list.length);
    appendBatch(list, 0, rendered);
    if (rendered >= list.length) {
      onComplete();
      return { rendered, total: list.length, pending: false };
    }

    sentinel = container.ownerDocument.createElement("div");
    sentinel.className = "work-render-sentinel";
    sentinel.setAttribute("aria-hidden", "true");
    container.append(sentinel);

    const finish = () => {
      observer?.disconnect();
      observer = null;
      sentinel?.remove();
      sentinel = null;
      onComplete();
    };
    const observeNextBatch = () => {
      if (version !== renderVersion || !sentinel?.isConnected) return;
      if (typeof Observer !== "function") {
        queueNextBatch();
        return;
      }
      observer = new Observer(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          observer?.disconnect();
          observer = null;
          queueNextBatch();
        },
        { root: null, rootMargin: `${lookaheadDistance}px 0px`, threshold: 0 }
      );
      observer.observe(sentinel);
    };
    const appendNextBatch = () => {
      if (version !== renderVersion || !sentinel?.isConnected) return;
      const end = Math.min(list.length, rendered + batchSize);
      rendered = appendBatch(list, rendered, end, sentinel);
      if (rendered >= list.length) finish();
      else observeNextBatch();
    };
    function queueNextBatch() {
      if (timer !== null || version !== renderVersion) return;
      timer = setTimer(() => {
        timer = null;
        appendNextBatch();
      }, batchDelayMs);
    }

    observeNextBatch();
    return { rendered, total: list.length, pending: true };
  }

  return { cancel, render };
}

function positiveInteger(value, fallback) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
