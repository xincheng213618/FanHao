import { Worker } from "node:worker_threads";

export function createMediaBlobWorkerClient({ dbPath, imageDbPath, WorkerCtor = Worker } = {}) {
  const requests = new Map();
  let requestId = 0;
  let worker = null;

  function request(action, payload = {}) {
    return new Promise((resolve, reject) => {
      const activeWorker = ensureWorker();
      activeWorker.ref();
      const id = ++requestId;
      requests.set(id, { reject, resolve });
      try {
        activeWorker.postMessage({ id, action, ...payload });
      } catch (error) {
        requests.delete(id);
        if (!requests.size) activeWorker.unref();
        reject(error);
      }
    });
  }

  function ensureWorker() {
    if (worker) return worker;
    if (!dbPath) throw new TypeError("media blob worker requires dbPath");

    const nextWorker = new WorkerCtor(new URL("./media-blob-worker.js", import.meta.url), {
      execArgv: process.execArgv.filter((value) => !String(value).startsWith("--input-type")),
      workerData: { dbPath, imageDbPath }
    });
    worker = nextWorker;
    nextWorker.on("message", (message) => {
      const id = Number(message?.id || 0);
      const pending = requests.get(id);
      if (!pending) return;
      requests.delete(id);
      if (message?.ok) pending.resolve(message.value ?? null);
      else pending.reject(workerMessageError(message));
      if (!requests.size) nextWorker.unref();
    });
    nextWorker.on("error", (error) => failWorker(nextWorker, error));
    nextWorker.on("exit", (code) => {
      if (worker !== nextWorker) return;
      failWorker(nextWorker, new Error(`媒体缓存后台线程退出 (${code})`));
    });
    return nextWorker;
  }

  function failWorker(failedWorker, error) {
    if (worker !== failedWorker) return;
    worker = null;
    for (const pending of requests.values()) pending.reject(error);
    requests.clear();
  }

  async function close() {
    const activeWorker = worker;
    worker = null;
    if (!activeWorker) return;
    for (const pending of requests.values()) pending.reject(new Error("媒体缓存后台线程已关闭"));
    requests.clear();
    await activeWorker.terminate();
  }

  return {
    actorAvatar: (personId, version = "") => request("actorAvatar", { personId, version }),
    cachedRemoteUrls: (urls) => request("cachedRemoteUrls", { urls }),
    close,
    coreImage: (imageId) => request("coreImage", { imageId }),
    remoteImage: (url) => request("remoteImage", { url }),
    upsertRemote: (record) => request("upsertRemote", { record }),
    workCover: (workId) => request("workCover", { workId })
  };
}

function workerMessageError(message) {
  const error = new Error(message?.error || "媒体缓存后台操作失败");
  if (message?.stack) error.stack = message.stack;
  return error;
}
