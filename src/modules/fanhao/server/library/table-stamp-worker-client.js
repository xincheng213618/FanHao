import { Worker } from "node:worker_threads";

export function createTableStampWorkerClient({ dbPath, imageDbPath }) {
  const requests = new Map();
  let requestId = 0;
  let worker = null;

  function refresh(table) {
    return new Promise((resolve, reject) => {
      const activeWorker = ensureWorker();
      activeWorker.ref();
      const id = ++requestId;
      requests.set(id, { reject, resolve });
      try {
        activeWorker.postMessage({ id, table });
      } catch (error) {
        requests.delete(id);
        if (!requests.size) activeWorker.unref();
        reject(error);
      }
    });
  }

  function ensureWorker() {
    if (worker) return worker;

    const nextWorker = new Worker(new URL("./table-stamp-worker.js", import.meta.url), {
      workerData: { dbPath, imageDbPath }
    });
    worker = nextWorker;
    nextWorker.on("message", (message) => {
      const id = Number(message?.id || 0);
      const request = requests.get(id);
      if (!request) return;
      requests.delete(id);
      if (message?.ok) request.resolve(message.row || null);
      else request.reject(workerMessageError(message));
      if (!requests.size) nextWorker.unref();
    });
    nextWorker.on("error", (error) => failWorker(nextWorker, error));
    nextWorker.on("exit", (code) => {
      if (worker !== nextWorker) return;
      failWorker(nextWorker, new Error(`目录戳后台线程退出 (${code})`));
    });
    return nextWorker;
  }

  function failWorker(failedWorker, error) {
    if (worker !== failedWorker) return;
    worker = null;
    for (const request of requests.values()) request.reject(error);
    requests.clear();
  }

  return { refresh };
}

function workerMessageError(message) {
  const error = new Error(message?.error || "目录戳后台查询失败");
  if (message?.stack) error.stack = message.stack;
  return error;
}
