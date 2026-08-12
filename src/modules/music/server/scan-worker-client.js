import { Worker } from "node:worker_threads";

const DEFAULT_READY_TIMEOUT_MS = 10_000;

export function createMusicScanWorkerClient({
  dbPath,
  ffprobePath,
  ffprobeTimeoutMs,
  ffprobeArgsPrefix,
  busyTimeoutMs,
  workerFactory = (url, options) => new Worker(url, options),
  workerUrl = new URL("./scan-worker.js", import.meta.url),
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  extraWorkerData = {}
}) {
  let worker = null;
  let ready = null;
  let activeFlight = null;
  let requestId = 0;
  let closed = false;
  let workerStarts = 0;
  let scanDispatches = 0;
  let coalescedScans = 0;
  let conflictingScans = 0;
  let workerStartedAt = 0;
  let workerReadyAt = 0;

  function start() {
    closed = false;
    return Promise.resolve(true);
  }

  async function prepare() {
    if (closed) throw stoppedError();
    const activeWorker = ensureWorker();
    await ready.promise;
    if (worker !== activeWorker || closed) throw stoppedError();
    return true;
  }

  function scan(request = {}) {
    if (closed) return Promise.reject(stoppedError());
    const payload = normalizeScanRequest(request);
    const key = scanRequestKey(payload);
    if (activeFlight) {
      if (activeFlight.key === key) {
        coalescedScans += 1;
        return activeFlight.promise;
      }
      conflictingScans += 1;
      return Promise.reject(conflictError());
    }

    const flight = createFlight(++requestId, key);
    activeFlight = flight;
    void dispatch(flight, payload);
    return flight.promise;
  }

  async function dispatch(flight, payload) {
    try {
      const activeWorker = ensureWorker();
      await ready.promise;
      if (closed || activeFlight !== flight || worker !== activeWorker) throw stoppedError();
      scanDispatches += 1;
      activeWorker.postMessage({ type: "scan", id: flight.id, request: payload });
      flight.dispatched = true;
    } catch (error) {
      settleFlight(flight, false, error);
    }
  }

  async function stop() {
    closed = true;
    const activeWorker = worker;
    worker = null;
    failReady(stoppedError());
    if (activeFlight) settleFlight(activeFlight, false, stoppedError());
    if (activeWorker) await activeWorker.terminate().catch(() => undefined);
  }

  function diagnostics() {
    return {
      workerActive: Boolean(worker),
      workerStarts,
      scanDispatches,
      coalescedScans,
      conflictingScans,
      singleFlightActive: Boolean(activeFlight),
      activePhase: activeFlight?.phase || "",
      closed,
      workerStartupMs: workerReadyAt && workerStartedAt ? workerReadyAt - workerStartedAt : 0
    };
  }

  function ensureWorker() {
    if (closed) throw stoppedError();
    if (worker) return worker;
    const nextReady = createDeferred();
    const nextWorker = workerFactory(workerUrl, {
      workerData: {
        dbPath,
        ffprobePath,
        ffprobeTimeoutMs,
        ffprobeArgsPrefix,
        busyTimeoutMs,
        ...extraWorkerData
      }
    });
    workerStarts += 1;
    workerStartedAt = performance.now();
    workerReadyAt = 0;
    worker = nextWorker;
    ready = nextReady;
    const readyTimer = setTimeout(() => {
      failWorker(nextWorker, workerReadyTimeoutError());
      nextWorker.terminate().catch(() => undefined);
    }, clampInteger(readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS, 100, 120_000));
    readyTimer.unref?.();

    nextWorker.on("message", (message) => {
      if (message?.type === "ready") {
        clearTimeout(readyTimer);
        workerReadyAt = performance.now();
        nextReady.resolve(true);
        return;
      }
      if (message?.type === "phase") {
        if (activeFlight && Number(message.id || 0) === activeFlight.id) activeFlight.phase = String(message.phase || "");
        return;
      }
      if (message?.type !== "result") return;
      const flight = activeFlight;
      if (!flight || Number(message.id || 0) !== flight.id) return;
      if (message.ok) settleFlight(flight, true, message.data);
      else settleFlight(flight, false, workerMessageError(message));
    });
    nextWorker.on("error", (error) => {
      clearTimeout(readyTimer);
      failWorker(nextWorker, workerFailureError(error));
    });
    nextWorker.on("exit", (code) => {
      clearTimeout(readyTimer);
      if (worker === nextWorker) failWorker(nextWorker, workerExitError(code));
    });
    return nextWorker;
  }

  function failWorker(failedWorker, error) {
    if (worker !== failedWorker) return;
    worker = null;
    failReady(error);
    if (activeFlight) settleFlight(activeFlight, false, error);
  }

  function failReady(error) {
    ready?.reject(error);
    ready = null;
  }

  function settleFlight(flight, ok, value) {
    if (activeFlight !== flight || flight.settled) return;
    flight.settled = true;
    activeFlight = null;
    if (ok) flight.resolve(value);
    else {
      const error = value instanceof Error ? value : new Error(String(value || "音乐目录扫描失败"));
      if (flight.dispatched) error.scanDispatched = true;
      flight.reject(error);
    }
  }

  return {
    diagnostics,
    prepare,
    scan,
    start,
    stop
  };
}

function createFlight(id, key) {
  const deferred = createDeferred();
  return {
    id,
    key,
    promise: deferred.promise,
    resolve: deferred.resolve,
    reject: deferred.reject,
    dispatched: false,
    phase: "starting",
    settled: false
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function normalizeScanRequest(request) {
  return {
    roots: Array.isArray(request.roots) ? request.roots.map(String) : [],
    limit: Math.max(0, Math.trunc(Number(request.limit || 0))),
    dryRun: Boolean(request.dryRun)
  };
}

function scanRequestKey(request) {
  return JSON.stringify(request);
}

function workerMessageError(message) {
  const error = new Error(String(message?.error || "音乐目录扫描失败"));
  error.code = String(message?.errorCode || "MUSIC_SCAN_WORKER_FAILED");
  error.statusCode = Number(message?.statusCode || 500);
  error.expose = true;
  return error;
}

function conflictError() {
  const error = new Error("另一个音乐目录扫描正在进行中");
  error.code = "MUSIC_SCAN_CONFLICT";
  error.statusCode = 409;
  error.expose = true;
  return error;
}

function stoppedError() {
  const error = new Error("音乐目录扫描后台线程已停止");
  error.code = "MUSIC_SCAN_WORKER_STOPPED";
  error.statusCode = 503;
  error.expose = true;
  return error;
}

function workerReadyTimeoutError() {
  const error = new Error("音乐目录扫描后台线程启动超时");
  error.code = "MUSIC_SCAN_WORKER_READY_TIMEOUT";
  error.statusCode = 503;
  error.expose = true;
  return error;
}

function workerFailureError(cause) {
  if (cause?.statusCode) return cause;
  const error = new Error("音乐目录扫描后台线程暂时不可用", { cause });
  error.code = "MUSIC_SCAN_WORKER_UNAVAILABLE";
  error.statusCode = 503;
  error.expose = true;
  return error;
}

function workerExitError(code) {
  const error = new Error("音乐目录扫描后台线程意外退出");
  error.code = "MUSIC_SCAN_WORKER_EXIT";
  error.statusCode = 503;
  error.expose = true;
  error.exitCode = Number(code || 0);
  return error;
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}
