import { Worker } from "node:worker_threads";

export function createTableStampWorkerClient({ dbPath, imageDbPath, WorkerCtor = Worker, requestTimeoutMs = 15_000 }) {
  const requests = new Map();
  let requestId = 0;
  let owner = null;

  function refresh(table) {
    if (owner?.retiring) return Promise.reject(stampFault("TABLE_STAMP_RETIRING", "目录戳后台线程尚未退出"));
    return new Promise((resolve, reject) => {
      const current = ensureWorker();
      current.worker.ref();
      const id = ++requestId;
      const timer = setTimeout(() => {
        retireOwner(current, stampFault("TABLE_STAMP_TIMEOUT", "目录戳后台查询超时"));
      }, requestTimeoutMs);
      requests.set(id, { reject, resolve, timer });
      try {
        current.worker.postMessage({ id, table });
      } catch (error) {
        takeRequest(id);
        if (!requests.size) current.worker.unref();
        reject(error);
      }
    });
  }

  function ensureWorker() {
    if (owner) return owner;

    const worker = new WorkerCtor(new URL("./table-stamp-worker.js", import.meta.url), {
      workerData: { dbPath, imageDbPath }
    });
    const current = { worker, retiring: false };
    owner = current;
    worker.on("message", (message) => {
      if (owner !== current || current.retiring) return;
      const request = takeRequest(Number(message?.id || 0));
      if (!request) return;
      if (message?.ok) request.resolve(message.row || null);
      else request.reject(workerMessageError(message));
      if (!requests.size) worker.unref();
    });
    worker.on("error", (error) => retireOwner(current, error));
    worker.on("exit", (code) => {
      if (owner !== current) return;
      owner = null;
      rejectRequests(stampFault("TABLE_STAMP_EXITED", `目录戳后台线程退出 (${code})`));
    });
    return current;
  }

  function takeRequest(id) {
    const request = requests.get(id);
    if (request) {
      requests.delete(id);
      clearTimeout(request.timer);
    }
    return request;
  }

  function rejectRequests(error) {
    for (const request of requests.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    requests.clear();
  }

  function retireOwner(current, error) {
    if (owner !== current || current.retiring) return;
    current.retiring = true;
    rejectRequests(error);
    current.worker.unref();
    // A blocked native read may outlive termination. Only exit frees ownership.
    try { Promise.resolve(current.worker.terminate()).catch(() => {}); }
    catch { /* Exit still owns the handoff. */ }
  }

  return { refresh };
}

function stampFault(code, message) {
  return Object.assign(new Error(message), { code });
}

function workerMessageError(message) {
  const error = new Error(message?.error || "目录戳后台查询失败");
  if (message?.stack) error.stack = message.stack;
  return error;
}
