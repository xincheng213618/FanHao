import { Worker } from "node:worker_threads";
import {
  normalizeShortVideoStatsFilter,
  shortVideoStatsFilterKey
} from "./stats-query.js";

const DEFAULT_STATS_CACHE_LIMIT = 32;
const DEFAULT_STATS_RETRY_LIMIT = 1;
const DEFAULT_LIKE_DISTRIBUTION_TIMEOUT_MS = 30000;

export function createShortVideoCatalogWorkerClient({
  dbPath,
  downloadManagerDbPath,
  ffmpegPath,
  roots,
  statsCacheLimit = DEFAULT_STATS_CACHE_LIMIT,
  statsRetryLimit = DEFAULT_STATS_RETRY_LIMIT,
  likeDistributionTimeoutMs = DEFAULT_LIKE_DISTRIBUTION_TIMEOUT_MS,
  workerFactory = (url, options) => new Worker(url, options),
  workerUrl = new URL("./list-worker.js", import.meta.url),
  extraWorkerData = {}
}) {
  const requests = new Map();
  const statsCache = new Map();
  const statsFlights = new Map();
  const likeDistributionCache = new Map();
  const likeDistributionFlights = new Map();
  const cacheLimit = clampInteger(statsCacheLimit, DEFAULT_STATS_CACHE_LIMIT, 1, 256);
  const retryLimit = clampInteger(statsRetryLimit, DEFAULT_STATS_RETRY_LIMIT, 0, 3);
  const distributionTimeoutMs = clampInteger(likeDistributionTimeoutMs, DEFAULT_LIKE_DISTRIBUTION_TIMEOUT_MS, 100, 120000);
  let worker = null;
  let readyPromise = null;
  let readyResolve = null;
  let requestId = 0;
  let generation = 0;
  let closed = false;
  let workerStarts = 0;
  let statsDispatches = 0;
  let statsRetries = 0;
  let likeDistributionDispatches = 0;
  let likeDistributionRetries = 0;

  function start() {
    reopen();
    return Promise.resolve(true);
  }

  function reopen() {
    closed = false;
  }

  function query(url, operation = "list") {
    return request(operation, { url: url.href });
  }

  function queryStats(input = {}, options = {}) {
    if (options.signal?.aborted) return Promise.reject(abortError());
    const filter = normalizeShortVideoStatsFilter(input);
    const cacheKey = `${String(options.catalogStamp || "")}::${shortVideoStatsFilterKey(filter)}`;
    const cached = cacheGet(cacheKey);
    if (cached) return abortable(Promise.resolve(cached), options.signal);
    const existing = statsFlights.get(cacheKey);
    if (existing) return abortable(existing, options.signal);

    const flightGeneration = generation;
    const flight = executeStats(filter).then((stats) => {
      if (closed) throw stoppedError();
      if (generation !== flightGeneration) throw staleStatsError();
      cacheSet(cacheKey, stats);
      return stats;
    }).finally(() => {
      if (statsFlights.get(cacheKey) === flight) statsFlights.delete(cacheKey);
    });
    statsFlights.set(cacheKey, flight);
    return abortable(flight, options.signal);
  }

  function queryLikeDistribution(options = {}) {
    if (options.signal?.aborted) return Promise.reject(abortError());
    const cacheKey = String(options.catalogStamp || "default");
    const cached = cacheGetFrom(likeDistributionCache, cacheKey);
    if (cached) return abortable(Promise.resolve(cached), options.signal);
    const existing = likeDistributionFlights.get(cacheKey);
    if (existing) return attachLikeDistributionWaiter(existing, options.signal);

    const flightGeneration = generation;
    const flight = { promise: null, settled: false, waiters: 0 };
    flight.promise = executeLikeDistribution(cacheKey).then((result) => {
      if (closed) throw stoppedError();
      if (generation !== flightGeneration) throw staleLikeDistributionError();
      cacheSetIn(likeDistributionCache, cacheKey, result);
      return result;
    }).finally(() => {
      flight.settled = true;
      if (likeDistributionFlights.get(cacheKey) === flight) likeDistributionFlights.delete(cacheKey);
    });
    likeDistributionFlights.set(cacheKey, flight);
    return attachLikeDistributionWaiter(flight, options.signal);
  }

  async function executeLikeDistribution(catalogStamp) {
    let lastError = null;
    const deadline = Date.now() + distributionTimeoutMs;
    for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
      try {
        const remainingMs = Math.max(0, deadline - Date.now());
        if (!remainingMs) throw workerTimeoutError("likeDistribution");
        return await request("likeDistribution", { catalogStamp }, { timeoutMs: remainingMs });
      } catch (error) {
        lastError = error;
        if (error?.retryable !== true || attempt >= retryLimit || closed || Date.now() >= deadline) {
          throw publicLikeDistributionError(error);
        }
        likeDistributionRetries += 1;
      }
    }
    throw publicLikeDistributionError(lastError);
  }

  async function executeStats(filter) {
    let lastError = null;
    for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
      try {
        return await request("stats", { filter });
      } catch (error) {
        const safeError = shortVideoStatsWorkerError(error);
        lastError = safeError;
        if (!safeError.retryable || attempt >= retryLimit || closed) throw safeError;
        statsRetries += 1;
      }
    }
    throw lastError || shortVideoStatsWorkerError();
  }

  function request(operation, payload = {}, options = {}) {
    return new Promise((resolve, reject) => {
      let activeWorker;
      try {
        activeWorker = ensureWorker();
      } catch (error) {
        reject(error);
        return;
      }
      const id = ++requestId;
      const requestEntry = { operation, resolve, reject, timer: null };
      requests.set(id, requestEntry);
      if (operation === "stats") statsDispatches += 1;
      if (operation === "likeDistribution") likeDistributionDispatches += 1;
      const timeoutMs = Math.max(0, Number(options.timeoutMs || 0));
      if (timeoutMs) {
        requestEntry.timer = setTimeout(() => {
          if (!requests.has(id)) return;
          const error = workerTimeoutError(operation);
          failWorker(activeWorker, error);
          activeWorker.terminate().catch(() => undefined);
        }, timeoutMs);
        requestEntry.timer.unref?.();
      }
      try {
        activeWorker.postMessage({ type: operation, id, ...payload });
      } catch (error) {
        requests.delete(id);
        cleanupRequestEntry(requestEntry);
        reject(error);
      }
    });
  }

  function reset() {
    invalidateStats();
    try {
      worker?.postMessage({ type: "reset" });
    } catch {}
  }

  function invalidateStats() {
    generation += 1;
    statsCache.clear();
    statsFlights.clear();
    likeDistributionCache.clear();
    likeDistributionFlights.clear();
    try {
      worker?.postMessage({ type: "resetStats" });
      worker?.postMessage({ type: "resetLikeDistribution" });
    } catch {}
  }

  function stop() {
    closed = true;
    generation += 1;
    statsCache.clear();
    statsFlights.clear();
    likeDistributionCache.clear();
    likeDistributionFlights.clear();
    const activeWorker = worker;
    worker = null;
    readyResolve?.(false);
    readyResolve = null;
    readyPromise = null;
    rejectRequests(stoppedError());
    return activeWorker ? activeWorker.terminate().catch(() => undefined) : Promise.resolve();
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
      pendingRequests: requests.size,
      closed
    };
  }

  function ensureWorker() {
    if (closed) throw stoppedError();
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
        ...extraWorkerData
      }
    });
    workerStarts += 1;
    worker = nextWorker;
    nextWorker.on("message", (message) => {
      if (message?.type === "ready") {
        readyResolve?.(Boolean(message.ok));
        readyResolve = null;
        return;
      }
      const id = Number(message?.id || 0);
      const requestEntry = requests.get(id);
      if (!requestEntry) return;
      requests.delete(id);
      cleanupRequestEntry(requestEntry);
      if (message?.ok) requestEntry.resolve(message.data);
      else requestEntry.reject(workerMessageError(message, requestEntry.operation));
    });
    nextWorker.on("error", (error) => failWorker(nextWorker, error));
    nextWorker.on("exit", (code) => {
      if (worker !== nextWorker) return;
      failWorker(nextWorker, workerExitError(code));
    });
    return nextWorker;
  }

  function failWorker(failedWorker, error) {
    if (worker !== failedWorker) return;
    worker = null;
    readyResolve?.(false);
    readyResolve = null;
    readyPromise = null;
    rejectRequests(error);
  }

  function rejectRequests(error) {
    for (const requestEntry of requests.values()) {
      cleanupRequestEntry(requestEntry);
      requestEntry.reject(error);
    }
    requests.clear();
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

  function cleanupRequestEntry(requestEntry) {
    if (requestEntry.timer) clearTimeout(requestEntry.timer);
  }

  function attachLikeDistributionWaiter(flight, signal) {
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
        reject(abortError());
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
    invalidateStats,
    query,
    queryLikeDistribution,
    queryStats,
    reopen,
    reset,
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
