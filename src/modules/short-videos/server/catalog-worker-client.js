import { Worker } from "node:worker_threads";
import {
  normalizeShortVideoStatsFilter,
  shortVideoStatsFilterKey
} from "./stats-query.js";

const DEFAULT_STATS_CACHE_LIMIT = 32;
const DEFAULT_STATS_RETRY_LIMIT = 1;
const DEFAULT_LIKE_DISTRIBUTION_TIMEOUT_MS = 30000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_PENDING_REQUEST_LIMIT = 32;
const DEFAULT_BACKGROUND_REQUEST_LIMIT = 4;
const QUEUE_FULL = "SHORT_VIDEO_CATALOG_QUEUE_FULL";

export function createShortVideoCatalogWorkerClient({
  dbPath,
  downloadManagerDbPath,
  ffmpegPath,
  roots,
  statsCacheLimit = DEFAULT_STATS_CACHE_LIMIT,
  statsRetryLimit = DEFAULT_STATS_RETRY_LIMIT,
  likeDistributionTimeoutMs = DEFAULT_LIKE_DISTRIBUTION_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  pendingRequestLimit = DEFAULT_PENDING_REQUEST_LIMIT,
  backgroundRequestLimit = DEFAULT_BACKGROUND_REQUEST_LIMIT,
  workerFactory = (url, options) => new Worker(url, options),
  workerUrl = new URL("./list-worker.js", import.meta.url),
  extraWorkerData = {}
}) {
  const queue = [];
  const statsCache = new Map();
  const statsFlights = new Map();
  const likeDistributionCache = new Map();
  const likeDistributionFlights = new Map();
  const cacheLimit = clampInteger(statsCacheLimit, DEFAULT_STATS_CACHE_LIMIT, 1, 256);
  const retryLimit = clampInteger(statsRetryLimit, DEFAULT_STATS_RETRY_LIMIT, 0, 3);
  const distributionTimeoutMs = clampInteger(likeDistributionTimeoutMs, DEFAULT_LIKE_DISTRIBUTION_TIMEOUT_MS, 100, 120000);
  const timeoutMs = clampInteger(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 100, 120000);
  const pendingLimit = clampInteger(pendingRequestLimit, DEFAULT_PENDING_REQUEST_LIMIT, 1, 256);
  const backgroundLimit = clampInteger(backgroundRequestLimit, DEFAULT_BACKGROUND_REQUEST_LIMIT, 0, pendingLimit - 1);
  let worker = null;
  let active = null;
  let retirement = null;
  let pendingReset = "";
  let requestId = 0;
  let generation = 0;
  let lifecycle = 0;
  let closed = false;
  let workerStarts = 0;
  let statsDispatches = 0;
  let statsRetries = 0;
  let likeDistributionDispatches = 0;
  let likeDistributionRetries = 0;
  let likeDistributionGeneration = 0;

  async function start() {
    const starting = lifecycle;
    if (retirement) await retireWorker(worker);
    if (starting !== lifecycle) return false;
    reopen();
    return true;
  }

  function reopen() {
    if (retirement) throw stoppedError();
    closed = false;
  }

  function query(url, operation = "list", options = {}) {
    return request(operation, { url: url.href }, options);
  }

  function queryStats(input = {}, options = {}) {
    if (closed) return Promise.reject(stoppedError());
    if (options.signal?.aborted) return Promise.reject(abortError());
    const filter = normalizeShortVideoStatsFilter(input);
    const cacheKey = `${String(options.catalogStamp || "")}::${shortVideoStatsFilterKey(filter)}`;
    const cached = cacheGet(cacheKey);
    if (cached) return abortable(Promise.resolve(cached), options.signal);
    const existing = statsFlights.get(cacheKey);
    if (existing) {
      if (!options.background) existing.background = false;
      return attachFlightWaiter(existing, options.signal);
    }

    const flightGeneration = generation;
    const flight = createFlight(statsFlights, cacheKey, options.background);
    flight.promise = executeStats(filter, flight, flightGeneration).then((stats) => {
      if (closed) throw stoppedError();
      if (generation !== flightGeneration) throw staleStatsError();
      cacheSet(cacheKey, stats);
      return stats;
    }).finally(flight.remove);
    return attachFlightWaiter(flight, options.signal);
  }

  function queryLikeDistribution(options = {}) {
    if (closed) return Promise.reject(publicLikeDistributionError(stoppedError()));
    if (options.signal?.aborted) return Promise.reject(abortError());
    const cacheKey = String(options.catalogStamp || "default");
    const cached = cacheGetFrom(likeDistributionCache, cacheKey);
    if (cached) return abortable(Promise.resolve(cached), options.signal);
    const existing = likeDistributionFlights.get(cacheKey);
    if (existing) return attachFlightWaiter(existing, options.signal);

    const flightGeneration = likeDistributionGeneration;
    const flight = createFlight(likeDistributionFlights, cacheKey);
    flight.promise = executeLikeDistribution(cacheKey, flight, flightGeneration).then((result) => {
      if (closed) throw stoppedError();
      if (likeDistributionGeneration !== flightGeneration) throw staleLikeDistributionError();
      cacheSetIn(likeDistributionCache, cacheKey, result);
      return result;
    }).finally(flight.remove);
    return attachFlightWaiter(flight, options.signal);
  }

  function createFlight(flights, key, background = false) {
    const flight = { background, entry: null, waiters: 0, promise: null, remove };
    flights.set(key, flight);
    return flight;

    function remove() {
      if (flights.get(key) === flight) flights.delete(key);
    }
  }

  async function executeLikeDistribution(catalogStamp, flight, flightGeneration) {
    let lastError = null;
    const deadline = Date.now() + distributionTimeoutMs;
    for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
      try {
        const remainingMs = Math.max(0, deadline - Date.now());
        if (!remainingMs) throw workerTimeoutError("likeDistribution");
        return await request("likeDistribution", { catalogStamp }, { timeoutMs: remainingMs, flight });
      } catch (error) {
        lastError = error;
        if (error?.retryable !== true || error.code === QUEUE_FULL || attempt >= retryLimit || closed || !flight.waiters
          || likeDistributionGeneration !== flightGeneration || Date.now() >= deadline) {
          throw publicLikeDistributionError(error);
        }
        likeDistributionRetries += 1;
      }
    }
    throw publicLikeDistributionError(lastError);
  }

  async function executeStats(filter, flight, flightGeneration) {
    let lastError = null;
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
      try {
        const remainingMs = Math.max(0, deadline - Date.now());
        if (!remainingMs) throw workerTimeoutError("stats");
        return await request("stats", { filter }, { timeoutMs: remainingMs, flight });
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        const safeError = shortVideoStatsWorkerError(error);
        lastError = safeError;
        if (!safeError.retryable || safeError.code === QUEUE_FULL || attempt >= retryLimit || closed || !flight.waiters
          || generation !== flightGeneration || Date.now() >= deadline) throw safeError;
        statsRetries += 1;
      }
    }
    throw lastError || shortVideoStatsWorkerError();
  }

  function request(operation, payload = {}, options = {}) {
    if (closed) return Promise.reject(stoppedError());
    if (options.signal?.aborted) return Promise.reject(abortError());
    if (retirement && !retirement.attempt) return Promise.reject(workerExitError());
    const background = options.flight ? options.flight.background : options.background;
    if (queue.length >= pendingLimit || (background && (active || retirement || queue.length)
      && queue.filter(isBackground).length >= backgroundLimit)) return Promise.reject(queueFullError());

    return new Promise((resolve, reject) => {
      const delay = options.timeoutMs ?? timeoutMs;
      const entry = {
        id: ++requestId, operation, payload, resolve, reject, background,
        signal: options.signal, flight: options.flight, deadline: Date.now() + delay,
        timer: null, onAbort
      };
      function onAbort() {
        if (removeQueued(entry)) {
          finishRequest(entry, abortError());
          return;
        }
        // SQLite is synchronous inside the worker. Detach the caller without
        // releasing the physical slot or its deadline.
        settleWaiter(entry, abortError());
      }
      if (entry.flight) entry.flight.entry = entry;
      entry.signal?.addEventListener("abort", onAbort, { once: true });
      entry.timer = setTimeout(() => {
        const error = workerTimeoutError(operation);
        if (removeQueued(entry)) finishRequest(entry, error);
        else if (active === entry) failWorker(worker, error);
      }, delay);
      entry.timer.unref?.();
      queue.push(entry);
      pump();
    });
  }

  function isBackground(entry) {
    return entry.flight ? entry.flight.background : entry.background;
  }

  function removeQueued(entry) {
    const index = queue.indexOf(entry);
    if (index < 0) return false;
    queue.splice(index, 1);
    return true;
  }

  function pump() {
    while (!closed && !active && !retirement && queue.length) {
      const foreground = queue.findIndex(entry => !isBackground(entry));
      const [entry] = queue.splice(Math.max(0, foreground), 1);
      if (entry.deadline <= Date.now()) {
        finishRequest(entry, workerTimeoutError(entry.operation));
        continue;
      }
      active = entry;
      try {
        const owner = ensureWorker();
        if (pendingReset) {
          // Multiple mutations can accumulate behind one SQLite operation.
          // Flush one ordered reset before dispatching the next query.
          owner.postMessage({ type: pendingReset });
          pendingReset = "";
        }
        if (entry.operation === "stats") statsDispatches += 1;
        if (entry.operation === "likeDistribution") likeDistributionDispatches += 1;
        owner.postMessage({ type: entry.operation, id: entry.id, ...entry.payload });
      } catch (error) {
        active = null;
        finishRequest(entry, error);
      }
    }
  }

  function invalidateStats() {
    generation += 1;
    statsCache.clear();
    statsFlights.clear();
    rejectQueued(staleStatsError(), "stats");
    invalidateLikeDistribution();
    if (worker) pendingReset = "reset";
  }

  function invalidateLikeDistribution() {
    likeDistributionGeneration += 1;
    likeDistributionCache.clear();
    likeDistributionFlights.clear();
    rejectQueued(staleLikeDistributionError(), "likeDistribution");
    if (worker && !pendingReset) pendingReset = "resetLikeDistribution";
  }

  function stop() {
    closed = true;
    lifecycle += 1;
    generation += 1;
    likeDistributionGeneration += 1;
    statsCache.clear();
    statsFlights.clear();
    likeDistributionCache.clear();
    likeDistributionFlights.clear();
    const error = stoppedError();
    rejectQueued(error);
    if (active) finishRequest(active, error);
    return worker ? retireWorker(worker) : Promise.resolve();
  }

  function diagnostics() {
    return {
      workerActive: Boolean(worker),
      workerStarts,
      statsDispatches,
      statsRetries,
      likeDistributionDispatches,
      likeDistributionRetries,
      cacheEntries: statsCache.size,
      singleFlights: statsFlights.size,
      likeDistributionCacheEntries: likeDistributionCache.size,
      likeDistributionSingleFlights: likeDistributionFlights.size,
      pendingRequests: queue.length + Number(Boolean(active)),
      activeRequests: Number(Boolean(active)),
      queuedRequests: queue.length,
      closed
    };
  }

  function ensureWorker() {
    if (closed) throw stoppedError();
    if (worker) return worker;
    const nextWorker = workerFactory(workerUrl, {
      workerData: {
        dbPath,
        downloadManagerDbPath,
        ffmpegPath,
        roots,
        ...extraWorkerData
      }
    });
    workerStarts += 1;
    worker = nextWorker;
    nextWorker.on("message", (message) => {
      if (worker !== nextWorker || retirement || !active || Number(message?.id || 0) !== active.id) return;
      const entry = active;
      active = null;
      finishRequest(entry, message.ok ? null : workerMessageError(message, entry.operation), message.data);
      pump();
    });
    nextWorker.on("error", (error) => failWorker(nextWorker, error));
    nextWorker.once("exit", (code) => finishWorkerExit(nextWorker, code));
    return nextWorker;
  }

  function failWorker(failedWorker, error) {
    if (!failedWorker || worker !== failedWorker || retirement) return;
    if (active) finishRequest(active, error);
    void retireWorker(failedWorker).catch(() => undefined);
  }

  function retireWorker(owner) {
    // Keep the owner and slot until native termination or the exit event.
    // A rejected termination leaves the same owner available for a stop retry.
    retirement ??= { attempt: null };
    if (retirement.attempt) return retirement.attempt.promise;
    const attempt = Promise.withResolvers();
    retirement.attempt = attempt;
    void Promise.resolve().then(() => {
      if (worker === owner) return owner.terminate();
    }).then(code => finishWorkerExit(owner, code), error => {
      if (worker !== owner || retirement?.attempt !== attempt) return;
      retirement.attempt = null;
      rejectQueued(workerExitError());
      attempt.reject(error);
    });
    return attempt.promise;
  }

  function finishWorkerExit(owner, code) {
    if (worker !== owner) return;
    const attempt = retirement?.attempt;
    retirement = null;
    worker = null;
    pendingReset = "";
    if (active) finishRequest(active, workerExitError(code));
    active = null;
    attempt?.resolve();
    pump();
  }

  function rejectQueued(error, operation) {
    for (let index = queue.length - 1; index >= 0; index--) {
      if (operation && queue[index].operation !== operation) continue;
      const [entry] = queue.splice(index, 1);
      finishRequest(entry, error);
    }
  }

  function cacheGet(key) {
    return cacheGetFrom(statsCache, key);
  }

  function cacheSet(key, value) {
    cacheSetIn(statsCache, key, value);
  }

  function cacheGetFrom(cache, key) {
    if (!cache.has(key)) return null;
    const value = cache.get(key);
    cache.delete(key);
    cache.set(key, value);
    return value;
  }

  function cacheSetIn(cache, key, value) {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
  }

  function finishRequest(entry, error, data) {
    clearTimeout(entry.timer);
    if (entry.flight?.entry === entry) entry.flight.entry = null;
    settleWaiter(entry, error, data);
  }

  function settleWaiter(entry, error, data) {
    if (!entry.resolve) return;
    const { resolve, reject } = entry;
    entry.resolve = entry.reject = null;
    entry.signal?.removeEventListener("abort", entry.onAbort);
    if (error) reject(error);
    else resolve(data);
  }

  function attachFlightWaiter(flight, signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    flight.waiters += 1;
    return new Promise((resolve, reject) => {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        flight.waiters = Math.max(0, flight.waiters - 1);
        signal?.removeEventListener?.("abort", onAbort);
      };
      const onAbort = () => {
        release();
        const error = abortError();
        const entry = flight.entry;
        if (!flight.waiters && entry && removeQueued(entry)) {
          flight.remove();
          finishRequest(entry, error);
        }
        reject(error);
      };
      signal?.addEventListener?.("abort", onAbort, { once: true });
      flight.promise.then(
        (value) => {
          if (released) return;
          release();
          resolve(value);
        },
        (error) => {
          if (released) return;
          release();
          reject(error);
        }
      );
    });
  }

  return {
    diagnostics,
    invalidateLikeDistribution,
    invalidateStats,
    query,
    queryLikeDistribution,
    queryStats,
    reopen,
    reset: invalidateStats,
    start,
    stop
  };
}

function workerMessageError(message, operation) {
  if (operation === "stats" || operation === "likeDistribution") {
    const error = new Error(publicStatsErrorMessage(message?.errorCode));
    error.code = String(message?.errorCode || "SHORT_VIDEO_STATS_WORKER_FAILED");
    error.retryable = message?.retryable === true;
    error.statusCode = 503;
    error.expose = true;
    return error;
  }

  const error = new Error(message?.error || "短视频列表后台查询失败");
  if (message?.stack) error.stack = message.stack;
  return error;
}

function publicLikeDistributionError(error) {
  if (error?.code === "SHORT_VIDEO_LIKE_DISTRIBUTION_STALE") {
    error.expose = true;
    return error;
  }
  const result = new Error("短视频统计后台线程暂时不可用");
  result.code = "SHORT_VIDEO_LIKE_DISTRIBUTION_UNAVAILABLE";
  result.retryable = true;
  result.statusCode = 503;
  result.expose = true;
  return result;
}

function shortVideoStatsWorkerError(error) {
  if (error?.statusCode === 503 && String(error?.code || "").startsWith("SHORT_VIDEO_")) {
    error.expose = true;
    return error;
  }
  const result = new Error("短视频统计后台线程暂时不可用");
  result.code = "SHORT_VIDEO_STATS_WORKER_UNAVAILABLE";
  result.retryable = true;
  result.statusCode = 503;
  result.expose = true;
  return result;
}

function publicStatsErrorMessage(code) {
  if (["SHORT_VIDEO_DATABASE_BUSY", "SHORT_VIDEO_DATABASE_UNAVAILABLE"].includes(String(code || ""))) {
    return "短视频数据库正在恢复，请稍后重试";
  }
  return "短视频统计后台线程暂时不可用";
}

function workerExitError(code) {
  const error = new Error(`短视频列表后台线程退出 (${Number(code || 0)})`);
  error.code = "SHORT_VIDEO_STATS_WORKER_EXIT";
  error.retryable = true;
  error.statusCode = 503;
  return error;
}

function workerTimeoutError(operation) {
  const error = new Error("短视频后台线程响应超时");
  error.code = operation === "likeDistribution"
    ? "SHORT_VIDEO_LIKE_DISTRIBUTION_TIMEOUT"
    : "SHORT_VIDEO_WORKER_TIMEOUT";
  error.retryable = true;
  error.statusCode = 503;
  error.expose = true;
  return error;
}

function queueFullError() {
  const error = new Error("短视频目录查询繁忙，请稍后重试");
  error.code = QUEUE_FULL;
  error.retryable = true;
  error.statusCode = 503;
  error.expose = true;
  return error;
}

function stoppedError() {
  const error = new Error("短视频列表后台线程已停止");
  error.code = "SHORT_VIDEO_STATS_WORKER_STOPPED";
  error.retryable = false;
  error.statusCode = 503;
  error.expose = true;
  return error;
}

function staleStatsError() {
  const error = new Error("短视频列表正在更新，请稍后重试");
  error.code = "SHORT_VIDEO_STATS_STALE";
  error.retryable = false;
  error.statusCode = 503;
  error.expose = true;
  return error;
}

function staleLikeDistributionError() {
  const error = new Error("短视频统计数据正在更新，请稍后重试");
  error.code = "SHORT_VIDEO_LIKE_DISTRIBUTION_STALE";
  error.retryable = true;
  error.statusCode = 503;
  error.expose = true;
  return error;
}

function abortError() {
  const error = new Error("短视频统计请求已取消");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}
