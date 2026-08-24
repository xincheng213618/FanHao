import { Worker } from "node:worker_threads";

export function createShortVideoSmoothWarmupWorkerClient({
  dbPath,
  downloadManagerDbPath,
  ffmpegPath,
  roots,
  workerFactory = (url, options) => new Worker(url, options),
  workerUrl = new URL("./smooth-warmup-worker.js", import.meta.url),
  extraWorkerData = {}
}) {
  const requests = new Map();
  let worker = null;
  let requestId = 0;
  let closed = false;
  let workerStarts = 0;
  let countDispatches = 0;
  let candidateDispatches = 0;

  function reopen() {
    closed = false;
  }

  function queryCount() {
    countDispatches += 1;
    return request("count");
  }

  function queryCandidates(limit, offset) {
    candidateDispatches += 1;
    return request("candidates", { limit, offset });
  }

  function request(type, payload = {}) {
    return new Promise((resolve, reject) => {
      let activeWorker;
      try {
        activeWorker = ensureWorker();
      } catch (error) {
        reject(error);
        return;
      }
      const id = ++requestId;
      requests.set(id, { reject, resolve });
      try {
        activeWorker.postMessage({ type, id, ...payload });
      } catch (error) {
        requests.delete(id);
        reject(error);
      }
    });
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
      const id = Number(message?.id || 0);
      const pending = requests.get(id);
      if (!pending) return;
      requests.delete(id);
      if (message?.ok) pending.resolve(message.data);
      else pending.reject(workerMessageError(message));
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
    rejectRequests(error);
  }

  function rejectRequests(error) {
    for (const pending of requests.values()) pending.reject(error);
    requests.clear();
  }

  function stop() {
    closed = true;
    const activeWorker = worker;
    worker = null;
    rejectRequests(stoppedError());
    return activeWorker ? activeWorker.terminate().catch(() => undefined) : Promise.resolve();
  }

  function diagnostics() {
    return {
      workerActive: Boolean(worker),
      workerStarts,
      countDispatches,
      candidateDispatches,
      pendingRequests: requests.size,
      closed
    };
  }

  return {
    diagnostics,
    queryCandidates,
    queryCount,
    reopen,
    stop
  };
}

function workerMessageError(message) {
  const error = new Error(message?.error || "短视频预热线程查询失败");
  error.code = "SHORT_VIDEO_SMOOTH_WARMUP_WORKER_FAILED";
  if (message?.stack) error.stack = message.stack;
  return error;
}

function workerExitError(code) {
  const error = new Error(`短视频预热线程退出 (${Number(code || 0)})`);
  error.code = "SHORT_VIDEO_SMOOTH_WARMUP_WORKER_EXIT";
  return error;
}

function stoppedError() {
  const error = new Error("短视频预热线程已停止");
  error.code = "SHORT_VIDEO_SMOOTH_WARMUP_WORKER_STOPPED";
  return error;
}
