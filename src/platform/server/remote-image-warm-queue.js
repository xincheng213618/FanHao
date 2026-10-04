export function createRemoteImageWarmQueue({ run, concurrency = 6, capacity = 128, stopWaitMs = 2000, warn = () => {} }) {
  const maxActive = finiteLimit(concurrency, 6, 1, 16);
  const maxTasks = Math.max(maxActive, finiteLimit(capacity, 128, 1, 512));
  const drainMs = finiteLimit(stopWaitMs, 2000, 1, 30000);
  const queued = [];
  const active = new Set();
  const keys = new Set();
  let accepting = true;
  let generation = 0;
  let stopPromise = null;

  function enqueue(key) {
    if (!accepting || keys.has(key) || keys.size >= maxTasks) return false;
    keys.add(key);
    queued.push(key);
    drain();
    return true;
  }
  function replaceQueued() {
    for (const key of queued.splice(0)) keys.delete(key);
  }
  function drain() {
    while (accepting && active.size < maxActive && queued.length) {
      const key = queued.shift();
      const epoch = generation;
      const controller = new AbortController();
      const task = { key, controller, promise: null };
      active.add(task);
      task.promise = Promise.resolve().then(() => run(key, {
        signal: controller.signal,
        current: () => accepting && generation === epoch && !controller.signal.aborted
      })).catch((error) => {
        if (!controller.signal.aborted) warn(error);
      }).finally(() => {
        active.delete(task);
        keys.delete(key);
        drain();
      });
    }
  }
  function beginStop() {
    generation += 1;
    accepting = false;
    replaceQueued();
    for (const task of active) task.controller.abort(new Error("远程图片缓存正在停止"));
  }
  function stop() {
    beginStop();
    if (stopPromise) return stopPromise;
    if (!active.size) return Promise.resolve();
    stopPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error("远程图片缓存任务尚未停止"), { code: "REMOTE_IMAGE_STOP_TIMEOUT", statusCode: 504 })), drainMs);
      Promise.allSettled([...active].map((task) => task.promise)).then(() => { clearTimeout(timer); resolve(); });
    }).finally(() => { stopPromise = null; });
    return stopPromise;
  }
  async function start() {
    const intent = generation;
    if (stopPromise) await stopPromise;
    if (intent !== generation || (!accepting && active.size)) throw Object.assign(new Error("远程图片缓存任务尚未停止或启动已取消"), { code: "REMOTE_IMAGE_STOPPED", statusCode: 503 });
    accepting = true;
    drain();
  }
  return { enqueue, replaceQueued, beginStop, stop, start,
    diagnostics: () => ({ active: active.size, queued: queued.length, capacity: maxTasks, concurrency: maxActive, accepting }) };
}

function finiteLimit(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}

export async function readRemoteImageBody(response, maxBytes, signal) {
  const tooLarge = () => Object.assign(new Error("远程图片过大"), { statusCode: 413 });
  if (Number(response.headers.get("content-length") || 0) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  let tail = null, tailUsed = 0;
  let cancellation = null;
  const cancel = (reason) => {
    if (!cancellation) cancellation = reader.cancel(reason).catch(() => {});
    return cancellation;
  };
  const abort = () => { cancel(signal.reason); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const result = await reader.read();
      signal.throwIfAborted();
      if (result.done) break;
      if (result.value.byteLength > maxBytes - bytes) {
        await cancel();
        throw tooLarge();
      }
      // Fixed blocks bound both backing storage and chunk-object overhead,
      // even for tiny views into large slabs or a source reusing its bytes.
      let offset = 0;
      while (offset < result.value.byteLength) {
        if (!tail || tailUsed === tail.byteLength) {
          tail = Buffer.allocUnsafeSlow(Math.min(64 * 1024, maxBytes - bytes));
          tailUsed = 0;
          chunks.push(tail);
        }
        const count = Math.min(tail.byteLength - tailUsed, result.value.byteLength - offset);
        tail.set(result.value.subarray(offset, offset + count), tailUsed);
        tailUsed += count;
        offset += count;
        bytes += count;
      }
    }
    if (tail) chunks[chunks.length - 1] = tail.subarray(0, tailUsed);
    return Buffer.concat(chunks, bytes);
  } finally {
    signal.removeEventListener("abort", abort);
    if (signal.aborted) cancel(signal.reason);
    // Aborting the read can settle before the source's cancellation cleanup.
    // Keep its task slot until that cleanup promise actually settles.
    if (cancellation) await cancellation;
    reader.releaseLock();
  }
}
