export const COLLECTION_RETRY_DELAYS_MS = Object.freeze([120, 250, 500, 900, 1600, 3100]);

export async function retryShortVideoCollectionRequest(request, options = {}) {
  if (typeof request !== "function") throw new TypeError("collection request must be a function");
  const delays = Array.isArray(options.delaysMs) ? options.delaysMs : COLLECTION_RETRY_DELAYS_MS;
  const sleep = typeof options.sleep === "function" ? options.sleep : wait;
  for (let attempt = 0; ; attempt += 1) {
    if (options.signal?.aborted) throw options.signal.reason || new DOMException("读取已取消", "AbortError");
    try {
      return await request(attempt + 1);
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason || error;
      if (!isRetryableBusy(error) || attempt >= delays.length) throw error;
      await sleep(Math.max(0, Number(delays[attempt] || 0)), attempt + 1, options.signal);
    }
  }
}

function isRetryableBusy(error) {
  return Number(error?.status) === 503 && error?.retryable === true;
}

function wait(delayMs, attempt, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const abort = () => { globalThis.clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal.reason || new DOMException("读取已取消", "AbortError")); };
    if (signal?.aborted) { abort(); return; }
    timer = globalThis.setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, delayMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
