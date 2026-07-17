const DEFAULT_INITIAL_COUNT = 12;
const DEFAULT_BATCH_SIZE = 12;
const DEFAULT_BATCH_DELAY_MS = 16;

export function createProgressiveWorkListRenderer(options = {}) {
  const initialCount = positiveInteger(options.initialCount, DEFAULT_INITIAL_COUNT);
  const batchSize = positiveInteger(options.batchSize, DEFAULT_BATCH_SIZE);
  const batchDelayMs = Math.max(0, Number(options.batchDelayMs ?? DEFAULT_BATCH_DELAY_MS));
  const setTimer = options.setTimer || ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer || ((timer) => clearTimeout(timer));
  let timer = null;
  let renderVersion = 0;

  function cancel() {
    renderVersion += 1;
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function appendRange(container, items, createItem, start, end) {
    const fragment = container.ownerDocument?.createDocumentFragment?.();
    const target = fragment || container;
    for (let index = start; index < end; index += 1) {
      target.append(createItem(items[index], index));
    }
    if (fragment) container.append(fragment);
  }

  function render(container, items, createItem, onComplete = () => {}) {
    cancel();
    const version = renderVersion;
    const list = Array.isArray(items) ? items : [];
    let rendered = Math.min(initialCount, list.length);
    appendRange(container, list, createItem, 0, rendered);

    function appendNextBatch() {
      if (version !== renderVersion) return;
      timer = null;
      if (container.isConnected === false) return;
      const next = Math.min(rendered + batchSize, list.length);
      appendRange(container, list, createItem, rendered, next);
      rendered = next;
      if (rendered < list.length) timer = setTimer(appendNextBatch, batchDelayMs);
      else onComplete();
    }

    if (rendered < list.length) timer = setTimer(appendNextBatch, batchDelayMs);
    else onComplete();
    return { rendered, total: list.length };
  }

  return { cancel, render };
}

function positiveInteger(value, fallback) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
