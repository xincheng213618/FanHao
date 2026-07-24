import { Worker } from "node:worker_threads";

const WATCH_WRITE_TIMEOUT_MS = 20000;

export function createShortVideoWatchWriteService({
  dbPath,
  downloadManagerDbPath,
  ffmpegPath,
  roots
}) {
  const requests = new Map();
  let worker = null;
  let readyPromise = null;
  let readyResolve = null;
  let requestId = 0;

  function start() {
    ensureWorker();
    return readyPromise;
  }

  function record(videoId, options = {}) {
    return new Promise((resolve, reject) => {
      const activeWorker = ensureWorker();
      const id = ++requestId;
      const timer = setTimeout(() => {
        requests.delete(id);
        const error = new Error("观看进度后台写入超时");
        error.statusCode = 503;
        reject(error);
      }, WATCH_WRITE_TIMEOUT_MS);
      timer.unref?.();
      requests.set(id, { reject, resolve, timer });
      try {
        activeWorker.postMessage({ type: "record", id, videoId, options });
      } catch (error) {
        clearTimeout(timer);
        requests.delete(id);
        reject(error);
      }
    });
  }

  function stop() {
    const activeWorker = worker;
    worker = null;
    readyResolve?.(false);
    readyResolve = null;
    readyPromise = null;
    rejectRequests(new Error("观看进度后台写入线程已停止"));
    return activeWorker ? activeWorker.terminate().catch(() => undefined) : Promise.resolve();
  }

  function ensureWorker() {
    if (worker) return worker;
    readyPromise = new Promise((resolve) => {
      readyResolve = resolve;
    });
    const nextWorker = new Worker(new URL("./watch-write-worker.js", import.meta.url), {
      workerData: { dbPath, downloadManagerDbPath, ffmpegPath, roots }
    });
    worker = nextWorker;
    nextWorker.on("message", (message) => {
      if (message?.type === "ready") {
        readyResolve?.(Boolean(message.ok));
        readyResolve = null;
        return;
      }
      const id = Number(message?.id || 0);
      const request = requests.get(id);
      if (!request) return;
      requests.delete(id);
      clearTimeout(request.timer);
      if (message?.ok) request.resolve(message.data);
      else request.reject(workerMessageError(message, "观看进度后台写入失败"));
    });
    nextWorker.on("error", (error) => failWorker(nextWorker, error));
    nextWorker.on("exit", (code) => {
      if (worker !== nextWorker) return;
      failWorker(nextWorker, new Error(`观看进度后台写入线程退出 (${code})`));
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
    for (const request of requests.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    requests.clear();
  }

  return { record, start, stop };
}

function workerMessageError(message, fallback) {
  const error = new Error(message?.error || fallback);
  if (message?.stack) error.stack = message.stack;
  if (message?.statusCode) error.statusCode = Number(message.statusCode);
  return error;
}
