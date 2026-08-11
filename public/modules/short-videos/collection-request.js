export const COLLECTION_RETRY_DELAYS_MS = Object.freeze([120, 250, 500, 900, 1600, 3100]);

export async function retryShortVideoCollectionRequest(request, options = {}) {
  if (typeof request !== "function") throw new TypeError("collection request must be a function");
  const delays = Array.isArray(options.delaysMs) ? options.delaysMs : COLLECTION_RETRY_DELAYS_MS;
  const sleep = typeof options.sleep === "function" ? options.sleep : wait;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await request(attempt + 1);
    } catch (error) {
      if (!isRetryableBusy(error) || attempt >= delays.length) throw error;
      await sleep(Math.max(0, Number(delays[attempt] || 0)), attempt + 1);
    }
  }
}

function isRetryableBusy(error) {
  return Number(error?.status) === 503 && error?.retryable === true;
}

function wait(delayMs) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
}
