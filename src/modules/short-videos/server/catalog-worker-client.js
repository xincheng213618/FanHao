import { Worker } from "node:worker_threads";
import {
  normalizeShortVideoStatsFilter,
  shortVideoStatsFilterKey
} from "./stats-query.js";

const DEFAULT_STATS_CACHE_LIMIT = 32;
const DEFAULT_STATS_RETRY_LIMIT = 1;

export function createShortVideoCatalogWorkerClient({
  dbPath,
  downloadManagerDbPath,
  ffmpegPath,
  roots,
  statsCacheLimit = DEFAULT_STATS_CACHE_LIMIT,
  statsRetryLimit = DEFAULT_STATS_RETRY_LIMIT,
  workerFactory = (url, options) => new Worker(url, options),
  workerUrl = new URL("./list-worker.js", import.meta.url),
  extraWorkerData = {}
}) {
  const requests = new Map();
  const statsCache = new Map();
  const statsFlights = new Map();
  const cacheLimit = clampInteger(statsCacheLimit, DEFAULT_STATS_CACHE_LIMIT, 1, 256);
  const retryLimit = clampInteger(statsRetryLimit, DEFAULT_STATS_RETRY_LIMIT, 0, 3);
  let worker = null;
  let readyPromise = null;
  let readyResolve = null;
  let requestId = 0;
  let generation = 0;
  let closed = false;
  let workerStarts = 0;
  let statsDispatches = 0;
  let statsRetries = 0;

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

  function request(operation, payload = {}) {
    return new Promise((resolve, reject) => {
      let activeWorker;
      try {
        activeWorker = ensureWorker();
      } catch (error) {
        reject(error);
        return;
      }
      const id = ++requestId;
      requests.set(id, { operation, resolve, reject });
      if (operation === "stats") statsDispatches += 1;
      try {
        activeWorker.postMessage({ type: operation, id, ...payload });
      } catch (error) {
        requests.delete(id);
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
    try {
      worker?.postMessage({ type: "resetStats" });
    } catch {}
  }

  function stop() {
    closed = true;
    generation += 1;
    statsCache.clear();
    statsFlights.clear();
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
      cacheEntries: statsCache.size,
      singleFlights: statsFlights.size,
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
    for (const requestEntry of requests.values()) requestEntry.reject(error);
    requests.clear();
  }

  function cacheGet(key) {
    if (!statsCache.has(key)) return null;
    const value = statsCache.get(key);
    statsCache.delete(key);
    statsCache.set(key, value);
    return value;
  }

  function cacheSet(key, value) {
    statsCache.delete(key);
    statsCache.set(key, value);
    while (statsCache.size > cacheLimit) {
      statsCache.delete(statsCache.keys().next().value);
    }
  }

  return {
    diagnostics,
    invalidateStats,
    query,
    queryStats,
    reopen,
    reset,
    start,
    stop
  };
}

function workerMessageError(message, operation) {
  if (operation === "stats") {
    const error = new Error(publicStatsErrorMessage(message?.errorCode));
    error.code = String(message?.errorCode || "SHORT_VIDEO_STATS_WORKER_FAILED");
    error.retryable = message?.retryable === true;
    error.statusCode = 503;
    return error;
  }
  const error = new Error(message?.error || "短视频列表后台查询失败");
  if (message?.stack) error.stack = message.stack;
  return error;
}

function shortVideoStatsWorkerError(error) {
  if (error?.statusCode === 503 && String(error?.code || "").startsWith("SHORT_VIDEO_")) return error;
  const result = new Error("短视频统计后台线程暂时不可用");
  result.code = "SHORT_VIDEO_STATS_WORKER_UNAVAILABLE";
  result.retryable = true;
  result.statusCode = 503;
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
  return error;
}

function stoppedError() {
  const error = new Error("短视频列表后台线程已停止");
  error.code = "SHORT_VIDEO_STATS_WORKER_STOPPED";
  error.retryable = false;
  error.statusCode = 503;
  return error;
}

function staleStatsError() {
  const error = new Error("短视频列表正在更新，请稍后重试");
  error.code = "SHORT_VIDEO_STATS_STALE";
  error.retryable = false;
  error.statusCode = 503;
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
