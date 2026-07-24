import { Worker } from "node:worker_threads";

export function createShortVideoCatalogWorkerClient({
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

  function query(url, operation = "list") {
    return new Promise((resolve, reject) => {
      const activeWorker = ensureWorker();
      const id = ++requestId;
      requests.set(id, { resolve, reject });
      try {
        activeWorker.postMessage({ type: operation, id, url: url.href });
      } catch (error) {
        requests.delete(id);
        reject(error);
      }
    });
  }

  function reset() {
    try {
      worker?.postMessage({ type: "reset" });
    } catch {}
  }

  function stop() {
    const activeWorker = worker;
    worker = null;
    readyResolve?.(false);
    readyResolve = null;
    readyPromise = null;
    rejectRequests(new Error("短视频列表后台线程已停止"));
    return activeWorker ? activeWorker.terminate().catch(() => undefined) : Promise.resolve();
  }

  function ensureWorker() {
    if (worker) return worker;
    readyPromise = new Promise((resolve) => {
      readyResolve = resolve;
    });
    const nextWorker = new Worker(new URL("./list-worker.js", import.meta.url), {
      workerData: {
        dbPath,
        downloadManagerDbPath,
        ffmpegPath,
        roots
      }
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
      if (message?.ok) request.resolve(message.data);
      else request.reject(workerMessageError(message, "短视频列表后台查询失败"));
    });
    nextWorker.on("error", (error) => failWorker(nextWorker, error));
    nextWorker.on("exit", (code) => {
      if (worker !== nextWorker) return;
      failWorker(nextWorker, new Error(`短视频列表后台线程退出 (${code})`));
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
    for (const request of requests.values()) request.reject(error);
    requests.clear();
  }

  return {
    query,
    reset,
    start,
    stop
  };
}

function workerMessageError(message, fallback) {
  const error = new Error(message?.error || fallback);
  if (message?.stack) error.stack = message.stack;
  return error;
}
