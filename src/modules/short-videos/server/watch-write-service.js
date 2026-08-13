import { Worker } from "node:worker_threads";

const DEFAULT_BUSY_RETRY_BUDGET_MS = 12000;
const DEFAULT_BUSY_TIMEOUT_MS = 100;
const DEFAULT_WORKER_RESPONSE_TIMEOUT_MS = 2000;
const DEFAULT_TRANSPORT_RETRY_LIMIT = 1;
const DEFAULT_BUSY_RETRY_DELAYS_MS = [40, 80, 160, 320, 640, 1000, 1500, 2000];

export function createShortVideoWatchWriteService({
  dbPath,
  downloadManagerDbPath,
  ffmpegPath,
  roots,
  busyRetryBudgetMs = DEFAULT_BUSY_RETRY_BUDGET_MS,
  busyRetryDelaysMs = DEFAULT_BUSY_RETRY_DELAYS_MS,
  busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS,
  workerResponseTimeoutMs = DEFAULT_WORKER_RESPONSE_TIMEOUT_MS,
  workerCloseTimeoutMs = DEFAULT_WORKER_RESPONSE_TIMEOUT_MS,
  transportRetryLimit = DEFAULT_TRANSPORT_RETRY_LIMIT,
  workerFactory = (url, options) => new Worker(url, options),
  terminateWorker = (activeWorker) => activeWorker.terminate(),
  workerUrl = new URL("./watch-write-worker.js", import.meta.url),
  extraWorkerData = {},
  testHooks = {}
}) {
  const retryBudgetMs = clampInteger(busyRetryBudgetMs, DEFAULT_BUSY_RETRY_BUDGET_MS, 50, 60000);
  const workerBusyTimeoutMs = clampInteger(busyTimeoutMs, DEFAULT_BUSY_TIMEOUT_MS, 1, 1000);
  const responseTimeoutMs = clampInteger(workerResponseTimeoutMs, DEFAULT_WORKER_RESPONSE_TIMEOUT_MS, 25, 30000);
  const closeTimeoutMs = clampInteger(workerCloseTimeoutMs, DEFAULT_WORKER_RESPONSE_TIMEOUT_MS, 25, 30000);
  const retryLimit = clampInteger(transportRetryLimit, DEFAULT_TRANSPORT_RETRY_LIMIT, 0, 3);
  const retryDelays = normalizeRetryDelays(busyRetryDelaysMs);
  const entries = new Map();
  const readyQueue = [];
  const workerRequests = new Map();
  const closeRequests = new Map();
  const workerRetirementErrors = new Map();
  let worker = null;
  let readyPromise = null;
  let readyResolve = null;
  let requestId = 0;
  let acceptedAtMs = 0;
  let accepting = true;
  let desiredStarted = true;
  let lifecycleGeneration = 0;
  let activeAttempt = null;
  let pumpTimer = null;
  let pumpScheduled = false;
  let stoppingPromise = null;
  let stopResolve = null;
  let stopReject = null;
  let stopCompleting = false;
  let incompleteStopWorker = null;
  let workerStarts = 0;
  let workerRestarts = 0;
  let attempts = 0;
  let busyRetries = 0;
  let coalesced = 0;
  let queueTimeouts = 0;
  let workerTimeouts = 0;
  let receiptsRecovered = 0;
  let retirementTerminationFailures = 0;
  let stopFailures = 0;

  async function start() {
    if (incompleteStopWorker) throw workerStopIncompleteError();
    const generation = ++lifecycleGeneration;
    desiredStarted = true;
    await Promise.resolve();
    const stopping = stoppingPromise;
    let stoppingError = null;
    if (stopping) {
      try {
        await stopping;
      } catch (error) {
        stoppingError = error;
      }
    }
    if (!desiredStarted || generation !== lifecycleGeneration) return false;
    if (stoppingError || incompleteStopWorker) {
      desiredStarted = false;
      accepting = false;
      throw workerStopIncompleteError(stoppingError);
    }
    accepting = true;
    ensureWorker();
    const ready = await readyPromise;
    if (!desiredStarted || generation !== lifecycleGeneration) return false;
    if (!ready) throw workerUnavailableError();
    return true;
  }

  function record(videoId, options = {}) {
    if (!accepting) return Promise.reject(stoppedError());
    const key = String(videoId || "");
    const acceptedAt = nextAcceptedAt();
    return new Promise((resolve, reject) => {
      let entry = entries.get(key);
      if (!entry) {
        entry = {
          videoId: key,
          updates: [],
          enqueued: false,
          nextAttemptAt: 0,
          busyAttempts: 0
        };
        entries.set(key, entry);
      } else if (entry.updates.length > 0 || activeAttempt?.entry === entry) {
        coalesced += 1;
        testHooks.onCoalesce?.(key);
      }
      entry.updates.push({
        options: { ...options, acceptedAt },
        deadlineAt: Date.now() + retryBudgetMs,
        busyAttempts: 0,
        transportRetries: 0,
        resolve,
        reject
      });
      if (activeAttempt?.entry !== entry) enqueue(entry);
      schedulePump();
    });
  }

  function stop() {
    desiredStarted = false;
    accepting = false;
    lifecycleGeneration += 1;
    if (stoppingPromise) return stoppingPromise;
    stoppingPromise = new Promise((resolve, reject) => {
      stopResolve = resolve;
      stopReject = reject;
    });
    const result = stoppingPromise;
    schedulePump();
    finishStopIfDrained();
    return result;
  }

  function diagnostics() {
    return {
      accepting,
      desiredStarted,
      active: Boolean(activeAttempt),
      pendingVideos: entries.size,
      pendingUpdates: [...entries.values()].reduce((total, entry) => total + entry.updates.length, 0)
        + Number(activeAttempt?.batch?.length || 0),
      workerStarts,
      workerRestarts,
      attempts,
      busyRetries,
      coalesced,
      queueTimeouts,
      workerTimeouts,
      receiptsRecovered,
      retirementTerminationFailures,
      stopIncomplete: Boolean(incompleteStopWorker),
      stopFailures
    };
  }

  function enqueue(entry) {
    if (entry.enqueued) return;
    entry.enqueued = true;
    readyQueue.push(entry);
  }

  function schedulePump(delayMs = 0) {
    if (activeAttempt) return;
    if (delayMs > 0) {
      if (pumpTimer) clearTimeout(pumpTimer);
      pumpTimer = setTimeout(() => {
        pumpTimer = null;
        schedulePump();
      }, delayMs);
      pumpTimer.unref?.();
      return;
    }
    if (pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      void pump();
    });
  }

  async function pump() {
    if (activeAttempt) return;
    if (pumpTimer) {
      clearTimeout(pumpTimer);
      pumpTimer = null;
    }
    const now = Date.now();
    let earliestRetryAt = Infinity;
    let selected = null;
    for (let count = readyQueue.length; count > 0; count -= 1) {
      const entry = readyQueue.shift();
      entry.enqueued = false;
      rejectExpiredUpdates(entry, now, workerBusyTimeoutMs);
      if (!entry.updates.length) {
        cleanupEntry(entry);
        continue;
      }
      if (entry.nextAttemptAt > now) {
        earliestRetryAt = Math.min(earliestRetryAt, entry.nextAttemptAt);
        enqueue(entry);
        continue;
      }
      selected = entry;
      break;
    }
    if (!selected) {
      if (Number.isFinite(earliestRetryAt)) schedulePump(Math.max(1, earliestRetryAt - now));
      finishStopIfDrained();
      return;
    }

    const batch = selected.updates.splice(0);
    const options = coalescedOptions(batch);
    activeAttempt = { entry: selected, batch, options };
    attempts += 1;
    testHooks.onDispatch?.({ videoId: selected.videoId, options: { ...options }, batchSize: batch.length });
    try {
      const remainingBudgetMs = Math.max(1, Math.min(...batch.map((update) => update.deadlineAt)) - Date.now());
      const data = await requestWorkerAttempt(selected.videoId, options, Math.min(responseTimeoutMs, remainingBudgetMs));
      selected.busyAttempts = 0;
      for (const update of batch) update.resolve(data);
    } catch (error) {
      await handleAttemptFailure(selected, batch, options, error);
    } finally {
      activeAttempt = null;
      if (selected.updates.length) enqueue(selected);
      else cleanupEntry(selected);
      schedulePump();
      finishStopIfDrained();
    }
  }

  async function handleAttemptFailure(entry, batch, options, error) {
    const now = Date.now();
    if (error?.code === "SHORT_VIDEO_WATCH_BUSY") {
      busyRetries += 1;
      entry.busyAttempts += 1;
      for (const update of batch) update.busyAttempts += 1;
      entry.updates.unshift(...batch);
      entry.nextAttemptAt = now + retryDelay(entry.busyAttempts, retryDelays);
      testHooks.onBusyRetry?.({ videoId: entry.videoId, attempt: entry.busyAttempts });
      return;
    }
    if (isWorkerTransportError(error)) {
      const receipt = await confirmReceipt(entry.videoId, options.acceptedAt, batch);
      if (receipt) {
        receiptsRecovered += 1;
        entry.busyAttempts = 0;
        for (const update of batch) update.resolve(receipt);
        return;
      }
      const retrying = [];
      for (const update of batch) {
        if (update.transportRetries < retryLimit && update.deadlineAt > now) {
          update.transportRetries += 1;
          retrying.push(update);
        } else {
          update.reject(error);
        }
      }
      if (retrying.length) {
        workerRestarts += 1;
        entry.updates.unshift(...retrying);
        entry.nextAttemptAt = now;
      }
      return;
    }
    for (const update of batch) update.reject(error);
    for (const update of entry.updates.splice(0)) update.reject(error);
  }

  function rejectExpiredUpdates(entry, now, minimumAttemptMs) {
    const pending = [];
    for (const update of entry.updates) {
      if (update.deadlineAt - now > minimumAttemptMs) {
        pending.push(update);
        continue;
      }
      if (update.busyAttempts > 0) update.reject(databaseBusyBudgetError());
      else {
        queueTimeouts += 1;
        update.reject(queueBudgetError());
      }
    }
    entry.updates = pending;
  }

  function cleanupEntry(entry) {
    if (activeAttempt?.entry === entry || entry.updates.length || entry.enqueued) return;
    if (entries.get(entry.videoId) === entry) entries.delete(entry.videoId);
  }

  function requestWorkerAttempt(videoId, options, timeoutMs) {
    return requestWorkerMessage("record", { videoId, options }, timeoutMs);
  }

  async function confirmReceipt(videoId, acceptedAt, batch) {
    const remainingMs = Math.max(25, Math.min(...batch.map((update) => update.deadlineAt)) - Date.now());
    try {
      return await requestWorkerMessage("receipt", { videoId, acceptedAt }, Math.min(responseTimeoutMs, remainingMs));
    } catch {
      return null;
    }
  }

  function requestWorkerMessage(type, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      let activeWorker;
      try {
        activeWorker = ensureWorker();
      } catch (error) {
        reject(workerUnavailableError(error));
        return;
      }
      const id = ++requestId;
      const request = { worker: activeWorker, resolve, reject, timer: null };
      workerRequests.set(id, request);
      request.timer = setTimeout(() => {
        if (!workerRequests.has(id)) return;
        workerTimeouts += 1;
        const timeoutError = workerTimeoutError();
        void retireWorker(activeWorker, timeoutError).then((retired) => {
          if (retired) rejectWorkerRequest(id, timeoutError);
        });
      }, Math.max(1, timeoutMs));
      request.timer.unref?.();
      try {
        activeWorker.postMessage({ type, id, ...payload });
      } catch (error) {
        const unavailableError = workerUnavailableError(error);
        void retireWorker(activeWorker, unavailableError).then((retired) => {
          if (retired) rejectWorkerRequest(id, unavailableError);
        });
      }
    });
  }

  function ensureWorker() {
    if (worker) return worker;
    readyPromise = new Promise((resolve) => {
      readyResolve = resolve;
    });
    const nextWorker = workerFactory(workerUrl, {
      workerData: {
        dbPath,
        downloadManagerDbPath,
        ffmpegPath,
        roots,
        busyTimeoutMs: workerBusyTimeoutMs,
        ...extraWorkerData
      }
    });
    worker = nextWorker;
    workerStarts += 1;
    nextWorker.on("message", (message) => {
      if (message?.type === "closed") {
        const id = Number(message?.id || 0);
        const request = closeRequests.get(id);
        if (!request || request.worker !== nextWorker) return;
        closeRequests.delete(id);
        clearTimeout(request.timer);
        if (message?.ok) request.resolve(true);
        else request.reject(workerCloseError(message?.error));
        return;
      }
      if (message?.type === "ready") {
        readyResolve?.(Boolean(message.ok));
        readyResolve = null;
        return;
      }
      const id = Number(message?.id || 0);
      const request = workerRequests.get(id);
      if (!request || request.worker !== nextWorker) return;
      workerRetirementErrors.delete(nextWorker);
      workerRequests.delete(id);
      clearTimeout(request.timer);
      if (message?.ok) request.resolve(message.data);
      else request.reject(workerMessageError(message));
    });
    nextWorker.on("error", (error) => {
      void retireWorker(nextWorker, workerUnavailableError(error));
    });
    nextWorker.on("exit", (code) => {
      if (worker !== nextWorker) return;
      const exitError = workerRetirementErrors.get(nextWorker) || workerExitError(code);
      workerRetirementErrors.delete(nextWorker);
      detachWorker(nextWorker);
      rejectWorkerRequests(nextWorker, exitError);
      rejectCloseRequests(nextWorker, exitError);
    });
    return nextWorker;
  }

  async function retireWorker(failedWorker, error) {
    if (!workerRetirementErrors.has(failedWorker)) workerRetirementErrors.set(failedWorker, error);
    try {
      await terminateWorker(failedWorker);
    } catch (terminationError) {
      retirementTerminationFailures += 1;
      testHooks.onRetireTerminateFailure?.({ error: terminationError, worker: failedWorker });
      return false;
    }
    workerRetirementErrors.delete(failedWorker);
    if (worker === failedWorker) detachWorker(failedWorker);
    rejectWorkerRequests(failedWorker, error);
    return true;
  }

  function detachWorker(failedWorker) {
    if (worker !== failedWorker) return;
    worker = null;
    readyResolve?.(false);
    readyResolve = null;
    readyPromise = null;
  }

  function rejectWorkerRequest(id, error) {
    const request = workerRequests.get(id);
    if (!request) return;
    workerRequests.delete(id);
    clearTimeout(request.timer);
    request.reject(error);
  }

  function rejectWorkerRequests(failedWorker, error) {
    for (const [id, request] of workerRequests) {
      if (request.worker === failedWorker) rejectWorkerRequest(id, error);
    }
  }

  function requestWorkerClose(activeWorker) {
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      const request = { worker: activeWorker, resolve, reject, timer: null };
      closeRequests.set(id, request);
      request.timer = setTimeout(() => {
        if (!closeRequests.has(id)) return;
        closeRequests.delete(id);
        reject(workerCloseTimeoutError());
      }, closeTimeoutMs);
      request.timer.unref?.();
      try {
        activeWorker.postMessage({ type: "close", id });
      } catch (error) {
        closeRequests.delete(id);
        clearTimeout(request.timer);
        reject(workerCloseError(error));
      }
    });
  }

  function rejectCloseRequests(failedWorker, error) {
    for (const [id, request] of closeRequests) {
      if (request.worker !== failedWorker) continue;
      closeRequests.delete(id);
      clearTimeout(request.timer);
      request.reject(error);
    }
  }

  function finishStopIfDrained() {
    if (!stoppingPromise || stopCompleting || activeAttempt || entries.size || workerRequests.size) return;
    if (pumpTimer) {
      clearTimeout(pumpTimer);
      pumpTimer = null;
    }
    stopCompleting = true;
    const activeWorker = worker;
    void completeStop(activeWorker);
  }

  async function completeStop(activeWorker) {
    try {
      if (activeWorker) {
        await requestWorkerClose(activeWorker);
        await terminateWorker(activeWorker);
        if (worker === activeWorker) detachWorker(activeWorker);
      }
      incompleteStopWorker = null;
      settleStop();
    } catch (cause) {
      stopFailures += 1;
      incompleteStopWorker = activeWorker || worker || incompleteStopWorker;
      settleStop(workerStopError(cause));
    }
  }

  function settleStop(error = null) {
    const resolve = stopResolve;
    const reject = stopReject;
    stopResolve = null;
    stopReject = null;
    stopCompleting = false;
    stoppingPromise = null;
    if (error) reject?.(error);
    else resolve?.();
  }

  function nextAcceptedAt() {
    acceptedAtMs = Math.max(Date.now(), acceptedAtMs + 1);
    return new Date(acceptedAtMs).toISOString();
  }

  return { diagnostics, record, start, stop };
}

function coalescedOptions(batch) {
  const latest = batch[batch.length - 1]?.options || {};
  return {
    ...latest,
    completed: batch.some((update) => update.options?.completed === true)
  };
}

function retryDelay(attempt, retryDelays) {
  return retryDelays[Math.min(Math.max(0, attempt - 1), retryDelays.length - 1)];
}

function normalizeRetryDelays(values) {
  const normalized = (Array.isArray(values) ? values : [])
    .map((value) => clampInteger(value, 0, 0, 10000))
    .filter((value) => value >= 0);
  return normalized.length ? normalized : DEFAULT_BUSY_RETRY_DELAYS_MS;
}

function workerMessageError(message) {
  if (message?.busy === true) {
    const error = new Error("短视频数据库正忙，请稍后重试");
    error.code = "SHORT_VIDEO_WATCH_BUSY";
    error.statusCode = 503;
    error.retryable = true;
    return error;
  }
  const error = new Error(message?.error || "观看进度后台写入失败");
  if (message?.statusCode) error.statusCode = Number(message.statusCode);
  if (message?.code) error.code = String(message.code);
  return error;
}

function databaseBusyBudgetError() {
  const error = new Error("短视频数据库正忙，请稍后重试");
  error.code = "SHORT_VIDEO_DATABASE_BUSY";
  error.statusCode = 503;
  error.retryable = true;
  error.expose = true;
  return error;
}

function queueBudgetError() {
  const error = new Error("观看进度写入队列繁忙，请稍后重试");
  error.code = "SHORT_VIDEO_WATCH_QUEUE_TIMEOUT";
  error.statusCode = 503;
  error.retryable = true;
  error.expose = true;
  return error;
}

function workerTimeoutError() {
  const error = new Error("观看进度后台线程响应超时");
  error.code = "SHORT_VIDEO_WATCH_WORKER_TIMEOUT";
  error.statusCode = 503;
  error.retryable = true;
  error.expose = true;
  return error;
}

function workerExitError(code) {
  const error = new Error(`观看进度后台线程退出 (${Number(code || 0)})`);
  error.code = "SHORT_VIDEO_WATCH_WORKER_EXIT";
  error.statusCode = 503;
  error.retryable = true;
  return error;
}

function workerUnavailableError(cause) {
  const error = new Error("观看进度后台线程暂时不可用", { cause });
  error.code = "SHORT_VIDEO_WATCH_WORKER_UNAVAILABLE";
  error.statusCode = 503;
  error.retryable = true;
  error.expose = true;
  return error;
}

function workerCloseError(cause) {
  const error = new Error("观看进度后台线程关闭失败", { cause });
  error.code = "SHORT_VIDEO_WATCH_WORKER_CLOSE_FAILED";
  error.statusCode = 503;
  error.retryable = true;
  error.expose = true;
  return error;
}

function workerCloseTimeoutError() {
  const error = workerCloseError("close acknowledgement timed out");
  error.code = "SHORT_VIDEO_WATCH_WORKER_CLOSE_TIMEOUT";
  return error;
}

function workerStopError(cause) {
  if (String(cause?.code || "").startsWith("SHORT_VIDEO_WATCH_WORKER_CLOSE_")) return cause;
  const error = new Error("观看进度后台线程停止失败", { cause });
  error.code = "SHORT_VIDEO_WATCH_WORKER_STOP_FAILED";
  error.statusCode = 503;
  error.retryable = true;
  error.expose = true;
  return error;
}

function workerStopIncompleteError(cause) {
  const error = new Error("观看进度后台线程上次停止尚未完成", { cause });
  error.code = "SHORT_VIDEO_WATCH_WORKER_STOP_INCOMPLETE";
  error.statusCode = 503;
  error.retryable = true;
  error.expose = true;
  return error;
}

function stoppedError() {
  const error = new Error("观看进度后台写入服务已停止");
  error.code = "SHORT_VIDEO_WATCH_STOPPED";
  error.statusCode = 503;
  error.retryable = false;
  error.expose = true;
  return error;
}

function isWorkerTransportError(error) {
  return [
    "SHORT_VIDEO_WATCH_WORKER_TIMEOUT",
    "SHORT_VIDEO_WATCH_WORKER_EXIT",
    "SHORT_VIDEO_WATCH_WORKER_UNAVAILABLE"
  ].includes(String(error?.code || ""));
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}
