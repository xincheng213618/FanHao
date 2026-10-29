export const SHORT_VIDEO_READ_TIMEOUT_MS = 12000;

// Use for reads and presentation preparation. Mutations must retain their
// original acknowledgement even if the initiating view has gone away.
export function runShortVideoRead(request, { signal, timeoutMs = SHORT_VIDEO_READ_TIMEOUT_MS,
  timeoutMessage = "读取超时，请重试" } = {}) {
  const cancelled = () => Object.assign(new Error("请求已取消"), {
    name: "AbortError", code: "SHORT_VIDEO_READ_ABORTED", cause: signal?.reason
  });
  if (signal?.aborted) return Promise.reject(cancelled());
  const controller = new AbortController();
  const duration = Number.isFinite(Number(timeoutMs)) ? Math.max(1, Number(timeoutMs)) : SHORT_VIDEO_READ_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false, timer = null;
    const finish = (complete, value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      complete(value);
    };
    const cancel = error => {
      finish(reject, error);
      controller.abort(error);
    };
    const onAbort = () => cancel(cancelled());
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    timer = globalThis.setTimeout(() => cancel(Object.assign(new Error(timeoutMessage), {
      name: "TimeoutError", code: "SHORT_VIDEO_READ_TIMEOUT", statusCode: 408, retryable: true
    })), duration);
    timer.unref?.();
    try {
      Promise.resolve(request(controller.signal)).then(value => finish(resolve, value), error => finish(reject, error));
    } catch (error) {
      finish(reject, error);
    }
  });
}
