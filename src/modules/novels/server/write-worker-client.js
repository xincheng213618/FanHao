import crypto from "node:crypto";
import { Worker } from "node:worker_threads";
import { NOVEL_WRITE_METHODS } from "./store.js";

export function createNovelWriteWorkerClient({
  dbPath,
  reimportArtifactRoot,
  onCommitted = () => {},
  workerFactory = (url, options) => new Worker(url, options),
  workerUrl = new URL("./write-worker.js", import.meta.url),
  maxPending = 32,
  maxPendingBytes = 256 * 1024 * 1024,
  readyTimeoutMs = 15_000,
  requestTimeoutMs = 60_000
}) {
  let accepting = true;
  let connection = null;
  let active = null;
  let pumping = false;
  let pendingBytes = 0;
  let stopTask = null;
  let lifecycle = 0;
  const queue = [];
  const acknowledgedReceipts = [];
  const idleWaiters = new Set();
  const connections = new Set();

  async function start() {
    const generation = lifecycle;
    if (stopTask) {
      try { await stopTask; }
      catch (error) { if (connections.size) throw error; }
    }
    if (generation !== lifecycle) throw stoppedError();
    if (hasUnconfirmedClose()) throw unavailableError("前一小说写入线程尚未确认退出");
    stopTask = null;
    accepting = true;
    await ensureConnection().ready;
    if (generation !== lifecycle) throw stoppedError();
  }

  function write(method, args = [], options = {}) {
    if (!accepting) return Promise.reject(stoppedError());
    if (!NOVEL_WRITE_METHODS.includes(method)) return Promise.reject(notCommittedError(serviceError("NOVEL_WRITE_INVALID", "小说写入方法无效", 400)));
    const bytes = payloadBytes(args);
    if (queue.length + Number(Boolean(active)) >= Math.max(1, maxPending) || pendingBytes + bytes > maxPendingBytes) {
      return Promise.reject(notCommittedError(serviceError("NOVEL_WRITE_QUEUE_FULL", "小说写入队列已满，请稍后重试", 503)));
    }
    const deferred = createDeferred();
    const operation = { operationId: options.operationId || crypto.randomUUID(), method, args: structuredClone(args), retainReceipt: Boolean(options.operationId) };
    if (options.sourceRealm !== undefined) operation.sourceRealm = options.sourceRealm;
    queue.push({ ...deferred, operation, bytes, dispatched: false, sourceRealm: "" });
    pendingBytes += bytes;
    void pump();
    return deferred.promise;
  }

  function ensureConnection() {
    if (hasUnconfirmedClose()) throw unavailableError("前一小说写入线程尚未确认退出");
    if (!connection?.available) connection = createConnection(false);
    return connection;
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        active = job;
        let current;
        try {
          current = ensureConnection();
          const ready = await current.ready;
          if (!accepting) throw stoppedError();
          job.sourceRealm = ready.sourceRealm;
          // Readiness precedes reopening the DB for this operation. Only the
          // started event can identify the actual dispatched transaction file.
          job.databaseIdentity = "";
          job.acknowledgedReceipts = acknowledgedReceipts.slice();
          const data = await current.request({ type: "write", operation: { ...job.operation, acknowledgedReceipts: job.acknowledgedReceipts } }, {
            onDispatched: () => { job.dispatched = true; },
            onStarted: (message) => { job.sourceRealm = message.sourceRealm; job.databaseIdentity = message.databaseIdentity; }
          });
          confirmCommitted(job, data);
          notifyCommitted();
          job.resolve(data.result);
        } catch (error) {
          if ((error.workerUnavailable || error.outcome === "unknown") && current) {
            if (connection === current) connection = null;
            // Recover only after the original connection has stopped. Never
            // race inspection against an in-progress COMMIT, or replay writes.
            try {
              await current.close();
            } catch (closeError) {
              // An unsuccessful terminate does not prove that the writer has
              // stopped. Do not inspect receipt absence or dispatch more work.
              haltPending();
              job.reject(job.dispatched ? unknownError(job, closeError) : notCommittedError(closeError));
              continue;
            }
            if (job.dispatched) {
              try {
                const recovered = await recover(job);
                notifyCommitted();
                if (recovered.status === "committed") {
                  confirmCommitted(job, recovered);
                  job.resolve(recovered.result);
                }
                else job.reject(unknownError(job, error));
              } catch (recoveryError) {
                if (hasUnconfirmedClose()) haltPending();
                notifyCommitted();
                job.reject(unknownError(job, recoveryError));
              }
            } else job.reject(notCommittedError(error));
          } else job.reject(error);
        } finally {
          pendingBytes -= job.bytes;
          active = null;
        }
      }
    } finally {
      pumping = false;
      for (const resolve of idleWaiters) resolve();
      idleWaiters.clear();
    }
  }

  async function recover(job) {
    const recovery = createConnection(true);
    try {
      await recovery.ready;
      return await recovery.request({ type: "receipt", operation: { ...job.operation, sourceRealm: job.sourceRealm, databaseIdentity: job.databaseIdentity, acknowledgedReceipts: job.acknowledgedReceipts } });
    } finally {
      await recovery.close();
    }
  }

  function confirmCommitted(job, { sourceRealm, requestHash, databaseIdentity, acknowledgedReceipts: confirmedReceipts }) {
    removeConfirmedReceipts(confirmedReceipts);
    if (!job.operation.retainReceipt) acknowledgedReceipts.push({ sourceRealm, databaseIdentity, operationId: job.operation.operationId, requestHash });
  }

  function removeConfirmedReceipts(receipts = []) {
    const key = (receipt) => JSON.stringify([receipt.sourceRealm, receipt.operationId, receipt.requestHash, receipt.databaseIdentity]);
    const confirmed = new Set(receipts.map(key));
    for (let index = acknowledgedReceipts.length - 1; index >= 0; index -= 1) {
      if (confirmed.has(key(acknowledgedReceipts[index]))) acknowledgedReceipts.splice(index, 1);
    }
  }

  function notifyCommitted() {
    // Cache notification cannot turn an already committed write into failure.
    try { onCommitted(); } catch {}
  }

  function beginStop() {
    lifecycle += 1;
    haltPending();
    return pumping ? new Promise((resolve) => idleWaiters.add(resolve)) : Promise.resolve();
  }

  function haltPending() {
    accepting = false;
    for (const job of queue.splice(0)) {
      pendingBytes -= job.bytes;
      job.reject(stoppedError());
    }
  }

  function hasUnconfirmedClose() {
    return [...connections].some((item) => item.closing || item.closeFailed);
  }

  function stop() {
    if (!stopTask) stopTask = (async () => {
      await beginStop();
      let previous = connection;
      if (!previous?.available && acknowledgedReceipts.length && !hasUnconfirmedClose()) {
        previous = createConnection(false, true);
        try { await previous.ready; } catch {}
      }
      connection = null;
      let closeFailure;
      if (previous) {
        try {
          if (previous.available && acknowledgedReceipts.length) {
            const receipts = acknowledgedReceipts.slice();
            const confirmed = await previous.request({ type: "acknowledge", operation: { operationId: crypto.randomUUID(), acknowledgedReceipts: receipts } });
            removeConfirmedReceipts(confirmed);
          }
        } catch {
          // Cleanup failure retains the confirmed tokens and durable rows for
          // another attempt. It cannot undo the already known business result.
        } finally {
          try { await previous.close(); } catch (error) { closeFailure = error; }
        }
      }
      const closed = await Promise.allSettled([...connections].map((item) => item.close()));
      const failure = closed.find((item) => item.status === "rejected");
      if (closeFailure || failure) throw closeFailure || failure.reason;
    })();
    return stopTask;
  }

  function createConnection(recovery, cleanupOnly = false) {
    const ready = createDeferred();
    // A Worker may fail before an API call starts awaiting readiness.
    ready.promise.catch(() => {});
    let pending = null;
    let closed = false;
    let exited = false;
    const exit = createDeferred();
    let closeTask = null;
    const worker = workerFactory(workerUrl, { workerData: { dbPath, recovery, cleanupOnly, reimportArtifactRoot } });
    const handle = { ready: ready.promise, request, close, closing: false, closeFailed: false, get available() { return !closed; } };
    connections.add(handle);
    const readyTimer = setTimeout(() => fail(unavailableError("小说写入线程启动超时")), readyTimeoutMs);
    worker.on("message", (message) => {
      if (closed) return;
      if (message?.type === "ready") {
        clearTimeout(readyTimer);
        ready.resolve({ sourceRealm: message.sourceRealm, databaseIdentity: message.databaseIdentity });
      } else if (message?.type === "startup-error") {
        fail(messageError(message));
      } else if (message?.type === "started" && pending?.operationId === message.operationId) {
        pending.onStarted?.(message);
      } else if (message?.type === "result" && pending?.operationId === message.operationId) {
        const request = pending;
        pending = null;
        clearTimeout(request.timer);
        if (message.ok) request.resolve(message.data);
        else request.reject(messageError(message));
      }
    });
    worker.on("error", (error) => fail(unavailableError("小说写入线程异常退出", error)));
    worker.on("exit", () => {
      exited = true;
      connections.delete(handle);
      exit.resolve();
      fail(unavailableError("小说写入线程已退出"));
    });

    function fail(error) {
      if (closed) return;
      closed = true;
      error.workerUnavailable = true;
      clearTimeout(readyTimer);
      ready.reject(error);
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(error);
        pending = null;
      }
      // Even startup failure without an active request must release the thread.
      void close().catch(() => {});
    }

    function request(message, { onDispatched, onStarted } = {}) {
      if (closed) return Promise.reject(unavailableError("小说写入线程不可用"));
      const deferred = createDeferred();
      pending = { ...deferred, operationId: message.operation.operationId, onStarted };
      pending.timer = setTimeout(() => fail(unavailableError("小说写入线程响应超时")), requestTimeoutMs);
      try {
        worker.postMessage(message);
        onDispatched?.();
      } catch (error) {
        fail(unavailableError("小说写入线程请求发送失败", error));
      }
      return deferred.promise;
    }

    function close() {
      if (!closeTask) {
        closed = true;
        handle.closing = true;
        clearTimeout(readyTimer);
        closeTask = (async () => {
          if (exited) return;
          let timer;
          try {
            // Bound the complete termination attempt. terminate() itself can
            // hang; its resolution also needs the actual exit event as proof.
            await Promise.race([
              exit.promise,
              Promise.resolve().then(() => worker.terminate()).then(() => exit.promise),
              new Promise((_, reject) => { timer = setTimeout(() => reject(unavailableError("小说写入线程尚未确认退出")), readyTimeoutMs); })
            ]);
          } catch (error) { if (!exited) throw error; }
          finally { clearTimeout(timer); }
        })().catch((error) => { handle.closeFailed = !exited; throw error; });
      }
      return closeTask;
    }
    return handle;
  }

  const methods = Object.fromEntries(NOVEL_WRITE_METHODS.map((method) => [method, (...args) => write(method, args)]));
  return { ...methods, write, start, beginStop, stop, diagnostics: () => ({ accepting, pending: queue.length, active: Boolean(active), dispatched: Boolean(active?.dispatched), pendingBytes, acknowledgedReceipts: acknowledgedReceipts.length, connections: connections.size, unconfirmedClose: hasUnconfirmedClose() }) };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function serviceError(code, message, statusCode, cause) {
  return Object.assign(new Error(message, { cause }), { code, statusCode });
}
function unavailableError(message, cause) {
  return Object.assign(serviceError("NOVEL_WRITE_WORKER_UNAVAILABLE", message, 503, cause), { workerUnavailable: true });
}
function stoppedError() {
  return notCommittedError(serviceError("NOVEL_WRITE_STOPPED", "小说写入服务正在停止", 503));
}
function unknownError(job, cause) {
  return Object.assign(serviceError("NOVEL_WRITE_OUTCOME_UNKNOWN", "小说写入结果暂时无法确认，请刷新确认后再操作", 503, cause), { operationId: job.operation.operationId, outcome: "unknown" });
}
function messageError(message) {
  return Object.assign(serviceError(message.code || "NOVEL_WRITE_FAILED", message.error || "小说写入失败", message.statusCode || 500),
    message.outcome ? { outcome: message.outcome, operationId: message.operationId } : {},
    message.rollbackConfirmed ? { rollbackConfirmed: true } : {});
}
function notCommittedError(error) { return Object.assign(error, { outcome: "not_committed" }); }
function payloadBytes(value) {
  if (typeof value === "string") return value.length * 2;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (!value || typeof value !== "object") return 8;
  return Object.entries(value).reduce((sum, [key, item]) => sum + key.length * 2 + payloadBytes(item), 0);
}
