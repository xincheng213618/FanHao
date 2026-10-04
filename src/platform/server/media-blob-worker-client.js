import { Worker } from "node:worker_threads";

const BACKGROUND = new Set(["cachedRemoteUrls", "upsertRemote"]);

export function createMediaBlobWorkerClient({
  dbPath, imageDbPath, WorkerCtor = Worker, capacity = 128,
  payloadMaxBytes = 64 * 1024 * 1024, requestTimeoutMs = 15000, closeTimeoutMs = 2000
} = {}) {
  const maxRequests = limit(capacity, 128, 1, 1024);
  const maxBytes = limit(payloadMaxBytes, 64 * 1024 * 1024, 1, 256 * 1024 * 1024);
  const timeoutMs = limit(requestTimeoutMs, 15000, 1, 120000);
  const drainMs = limit(closeTimeoutMs, 2000, 1, 30000);
  const queue = [];
  let requestId = 0, owner = null, active = null, payloadBytes = 0;
  let accepting = true, stopPromise = null, foregroundRun = 0;
  let generation = 0;

  function request(action, payload = {}) {
    if (!accepting || owner?.closing) return Promise.reject(fault("MEDIA_BLOB_STOPPED", "媒体缓存后台线程正在停止"));
    let bytes, snapshot;
    try {
      bytes = payloadSize(action, payload);
      if (queue.length + Number(Boolean(active)) >= maxRequests || bytes > maxBytes - payloadBytes) {
        return Promise.reject(fault("MEDIA_BLOB_BUSY", "媒体缓存后台任务已满"));
      }
      snapshot = snapshotPayload(action, payload);
    } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      queue.push({ id: ++requestId, action, payload: snapshot, bytes, resolve, reject, settled: false, timer: null });
      payloadBytes += bytes;
      drain();
    });
  }

  function settle(job, error, value) {
    if (!job || job.settled) return;
    job.settled = true;
    if (job.timer) clearTimeout(job.timer);
    if (error) job.reject(error);
    else job.resolve(value ?? null);
  }
  function release(job) {
    payloadBytes = Math.max(0, payloadBytes - job.bytes);
    job.payload = null;
  }
  function rejectQueued(error) {
    for (const job of queue.splice(0)) { settle(job, error); release(job); }
  }

  function ensureWorker() {
    if (owner) return owner;
    if (!dbPath) throw new TypeError("media blob worker requires dbPath");
    const worker = new WorkerCtor(new URL("./media-blob-worker.js", import.meta.url), {
      execArgv: process.execArgv.filter((value) => !String(value).startsWith("--input-type")),
      workerData: { dbPath, imageDbPath }
    });
    let resolveExit;
    const next = { worker, closing: false, terminateRequested: false, exited: new Promise((resolve) => { resolveExit = resolve; }) };
    owner = next;
    worker.on("message", (message) => {
      if (owner !== next || !active || active.id !== Number(message?.id || 0)) return;
      const job = active;
      active = null;
      settle(job, message?.ok ? null : workerMessageError(message), message?.value);
      release(job);
      if (!next.closing) drain();
      if (!active && !next.closing) worker.unref();
    });
    worker.on("error", (error) => failWorker(next, error));
    worker.on("exit", (code) => {
      if (owner === next) {
        const error = fault("MEDIA_BLOB_EXITED", `媒体缓存后台线程退出 (${code})`);
        if (active) { settle(active, error); release(active); active = null; }
        rejectQueued(error);
        owner = null;
      }
      resolveExit();
    });
    return next;
  }
  function terminateOwner(current) {
    if (current.terminateRequested) return;
    current.terminateRequested = true;
    // Only the exit event releases ownership, including a failed termination.
    try { Promise.resolve(current.worker.terminate()).catch(() => {}); }
    catch { /* keep the owner until exit */ }
  }
  function failWorker(current, error) {
    if (owner !== current) return;
    current.closing = true;
    settle(active, error);
    rejectQueued(error);
    current.worker.ref();
    terminateOwner(current);
  }

  function drain() {
    if (!accepting || active || owner?.closing || !queue.length) return;
    let current;
    try { current = ensureWorker(); }
    catch (error) { rejectQueued(error); return; }
    let index = queue.findIndex((job) => !BACKGROUND.has(job.action));
    const backgroundIndex = queue.findIndex((job) => BACKGROUND.has(job.action));
    if (index < 0 || (foregroundRun >= 8 && backgroundIndex >= 0)) index = Math.max(0, backgroundIndex);
    const job = queue.splice(index, 1)[0];
    foregroundRun = BACKGROUND.has(job.action) ? 0 : foregroundRun + 1;
    active = job;
    current.worker.ref();
    job.timer = setTimeout(() => failWorker(current, fault("MEDIA_BLOB_TIMEOUT", "媒体缓存后台操作超时", 504)), timeoutMs);
    try {
      const transfer = job.action === "upsertRemote" ? [job.payload.record.buffer.buffer] : [];
      current.worker.postMessage({ id: job.id, action: job.action, ...job.payload }, transfer);
    } catch (error) {
      active = null;
      settle(job, error);
      release(job);
      drain();
      if (!active) current.worker.unref();
    }
  }

  function beginStop() {
    generation += 1;
    accepting = false;
    const error = fault("MEDIA_BLOB_STOPPED", "媒体缓存后台线程已关闭");
    rejectQueued(error);
    if (owner) failWorker(owner, error);
  }
  function close() {
    beginStop();
    if (stopPromise) return stopPromise;
    if (!owner) return Promise.resolve();
    const current = owner;
    stopPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(fault("MEDIA_BLOB_CLOSE_TIMEOUT", "媒体缓存后台线程尚未退出", 504)), drainMs);
      current.exited.then(() => { clearTimeout(timer); resolve(); });
    }).finally(() => { stopPromise = null; });
    return stopPromise;
  }
  async function start() {
    const intent = generation;
    if (stopPromise) await stopPromise;
    if (intent !== generation || owner?.closing) throw fault("MEDIA_BLOB_STOPPED", "媒体缓存后台线程尚未退出或启动已取消");
    accepting = true;
  }

  return {
    actorAvatar: (personId, version = "") => request("actorAvatar", { personId, version }),
    actorAvatarVersion: (personId, version) => request("actorAvatarVersion", { personId, version }),
    cachedRemoteUrls: (urls) => request("cachedRemoteUrls", { urls }),
    start, beginStop, stop: close, close,
    diagnostics: () => ({ active: Number(Boolean(active)), queued: queue.length, payloadBytes, capacity: maxRequests, payloadMaxBytes: maxBytes, accepting, workerOwned: Boolean(owner), workerClosing: Boolean(owner?.closing) }),
    coreImage: (imageId) => request("coreImage", { imageId }),
    remoteImage: (url) => request("remoteImage", { url }),
    upsertRemote: (record) => request("upsertRemote", { record }),
    workCover: (workId) => request("workCover", { workId })
  };
}

function limit(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}
function fault(code, message, statusCode = 503) { return Object.assign(new Error(message), { code, statusCode }); }
function payloadSize(action, payload) {
  if (action === "upsertRemote") {
    const row = payload.record || {};
    if (!ArrayBuffer.isView(row.buffer) && !(row.buffer instanceof ArrayBuffer)) throw new TypeError("media blob buffer must be bytes");
    return row.buffer.byteLength + Buffer.byteLength(String(row.url || "")) + Buffer.byteLength(String(row.urlHash || "")) + Buffer.byteLength(String(row.contentType || "")) + Buffer.byteLength(String(row.updatedAt || "")) + 128;
  }
  if (action === "cachedRemoteUrls") {
    if (!Array.isArray(payload.urls)) throw new TypeError("media blob URLs must be an array");
    return payload.urls.reduce((sum, url) => sum + Buffer.byteLength(String(url || "")) + 16, 64);
  }
  return 64 + Buffer.byteLength(String(payload.url || payload.version || ""));
}
function snapshotPayload(action, payload) {
  if (action === "upsertRemote") {
    const row = payload.record;
    const bytes = ArrayBuffer.isView(row.buffer) ? new Uint8Array(row.buffer.buffer, row.buffer.byteOffset, row.buffer.byteLength) : new Uint8Array(row.buffer);
    return { record: { url: String(row.url || ""), urlHash: String(row.urlHash || ""), contentType: String(row.contentType || "image/jpeg"), updatedAt: String(row.updatedAt || ""), byteLength: bytes.byteLength, buffer: Uint8Array.from(bytes) } };
  }
  if (action === "cachedRemoteUrls") return { urls: payload.urls.map((url) => String(url || "")) };
  if (action === "remoteImage") return { url: String(payload.url || "") };
  if (action === "coreImage") return { imageId: Number(payload.imageId) };
  if (action === "workCover") return { workId: Number(payload.workId) };
  return { personId: Number(payload.personId), version: String(payload.version || "") };
}
function workerMessageError(message) {
  const error = new Error(message?.error || "媒体缓存后台操作失败");
  if (message?.stack) error.stack = message.stack;
  return error;
}
