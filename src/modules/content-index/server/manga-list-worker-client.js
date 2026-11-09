import { Worker } from "node:worker_threads";
import { boundedInteger } from "../../../platform/server/local-image-read-queue.js";

const messages = {
  MANGA_LIST_BUSY: "漫画列表读取队列繁忙，请稍后重试",
  MANGA_LIST_STOPPED: "漫画列表服务正在停止，请稍后重试",
  MANGA_LIST_TIMEOUT: "漫画列表读取超时，请稍后重试",
  MANGA_LIST_UNAVAILABLE: "漫画列表暂不可用，请稍后重试"
};

function mangaListError(code) {
  return Object.assign(new Error(messages[code]), { code, statusCode: 503, retryable: true });
}

export function createMangaListWorkerClient({
  workerUrl,
  root,
  databasePath,
  maxItemLimit,
  workerFactory = (url, options) => new Worker(url, options),
  capacity = 8,
  timeoutMs = 15000
} = {}) {
  const limit = boundedInteger(capacity, 8, 1, 128);
  const deadline = boundedInteger(timeoutMs, 15000, 1, 120000);
  const pending = [];
  let owner = null;
  let active = null;
  let accepting = true;
  let generation = 0;
  let requestId = 0;
  let stopping = null;

  function query(url, { signal } = {}) {
    if (!accepting || signal?.aborted) return Promise.reject(mangaListError("MANGA_LIST_STOPPED"));
    if (pending.length + Number(Boolean(active)) >= limit) return Promise.reject(mangaListError("MANGA_LIST_BUSY"));
    const search = url.search;
    return new Promise((resolve, reject) => {
      const request = { id: ++requestId, search, signal, resolve, reject, settled: false };
      request.abort = () => abortRequest(request);
      request.timer = setTimeout(() => timeoutRequest(request), deadline);
      pending.push(request);
      signal?.addEventListener("abort", request.abort, { once: true });
      if (signal?.aborted) request.abort();
      drain();
    });
  }

  function settle(request, error, body) {
    if (!request || request.settled) return;
    request.settled = true;
    request.signal?.removeEventListener("abort", request.abort);
    if (error) request.reject(error);
    else request.resolve(body);
  }

  function finish(request, error, body) {
    if (!request) return;
    clearTimeout(request.timer);
    settle(request, error, body);
  }

  function removePending(request) {
    const index = pending.indexOf(request);
    if (index < 0) return false;
    pending.splice(index, 1);
    return true;
  }

  function abortRequest(request) {
    const error = mangaListError("MANGA_LIST_STOPPED");
    // Only the caller leaves an active scan. Its timeout and physical slot stay owned.
    if (active === request) settle(request, error);
    else if (removePending(request)) finish(request, error);
  }

  function timeoutRequest(request) {
    const error = mangaListError("MANGA_LIST_TIMEOUT");
    if (active === request) retireOwner(owner, error);
    else if (removePending(request)) finish(request, error);
  }

  function ensureWorker() {
    if (owner) return owner;
    const worker = workerFactory(workerUrl, {
      execArgv: process.execArgv.filter(value => !String(value).startsWith("--input-type")),
      workerData: { root, databasePath, maxItemLimit }
    });
    let resolveExit;
    const current = {
      worker, retiring: false, termination: null,
      exited: new Promise(resolve => { resolveExit = resolve; })
    };
    owner = current;
    worker.on("message", message => {
      if (owner !== current || current.retiring || !active || message?.id !== active.id) return;
      const request = active;
      active = null;
      if (message.error || !(message.body instanceof Uint8Array)) finish(request, mangaListError("MANGA_LIST_UNAVAILABLE"));
      else finish(request, null, message.body);
      drain();
      if (owner === current && !active && !current.retiring) worker.unref?.();
    });
    worker.on("error", () => retireOwner(current, mangaListError("MANGA_LIST_UNAVAILABLE")));
    worker.on("exit", () => {
      resolveExit();
      if (owner !== current) return;
      finish(active, mangaListError("MANGA_LIST_UNAVAILABLE"));
      active = null;
      owner = null;
      drain();
    });
    return current;
  }

  function terminateOwner(current) {
    if (current.termination) return current.termination;
    current.worker.ref?.();
    let requested;
    try { requested = current.worker.terminate(); }
    catch (error) { requested = Promise.reject(error); }
    // A resolved termination request does not itself release the worker owner.
    const confirmed = Promise.resolve(requested).then(() => current.exited, () => {
      if (owner === current) throw mangaListError("MANGA_LIST_UNAVAILABLE");
    });
    current.termination = Promise.race([current.exited, confirmed]).catch(error => {
      current.termination = null;
      throw error;
    });
    return current.termination;
  }

  function retireOwner(current, error) {
    if (!current || owner !== current) return;
    current.retiring = true;
    finish(active, error);
    void terminateOwner(current).catch(() => {});
  }

  function drain() {
    if (!accepting || active || owner?.retiring || !pending.length) return;
    const request = pending.shift();
    let current;
    try {
      current = ensureWorker();
      active = request;
      current.worker.ref?.();
      current.worker.postMessage({ id: request.id, query: request.search });
    } catch {
      const error = mangaListError("MANGA_LIST_UNAVAILABLE");
      if (current) retireOwner(current, error);
      else {
        finish(request, error);
        for (const waiting of pending.splice(0)) finish(waiting, error);
      }
    }
  }

  function beginStop() {
    generation++;
    accepting = false;
    const error = mangaListError("MANGA_LIST_STOPPED");
    for (const request of pending.splice(0)) finish(request, error);
    retireOwner(owner, error);
  }

  function stop() {
    if (stopping) return stopping;
    beginStop();
    if (!owner) return Promise.resolve();
    stopping = terminateOwner(owner).finally(() => { stopping = null; });
    return stopping;
  }

  async function start() {
    const intent = generation;
    if (stopping) await stopping;
    if (intent !== generation || owner?.retiring) throw mangaListError("MANGA_LIST_STOPPED");
    accepting = true;
  }

  return { query, start, beginStop, stop };
}
