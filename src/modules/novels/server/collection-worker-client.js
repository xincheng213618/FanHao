import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";

const METHODS = ["snapshot", "runtimeStatus", "listAdapters", "createAdapter", "updateAdapter", "deleteAdapter", "listTasks", "taskDetail", "createTask", "runTask", "cancelTask", "deleteTask", "invalidate"];
const MUTATIONS = new Set(["createAdapter", "updateAdapter", "deleteAdapter", "createTask", "runTask", "cancelTask", "deleteTask"]);

export function createNovelCollectionWorkerClient({
  dbPath, credentialRoot = path.join(path.dirname(dbPath), "novel-credentials"),
  outputRoot = path.join(path.dirname(dbPath), "novel-collection"), projectRoot = process.cwd(),
  pythonPath = "python", runnerPath,
  importCollectedBook,
  workerFactory = (url, options) => new Worker(url, options),
  workerUrl = new URL("./collection-worker.js", import.meta.url),
  spawnProcess = spawn,
  maxPending = 32, maxPendingBytes = 8 * 1024 * 1024,
  // The existing result file accepts 96 MiB UTF-8 JSON; conservative UTF-16
  // string accounting needs headroom for that same payload and its metadata.
  maxImportBytes = 256 * 1024 * 1024,
  readyTimeoutMs = 15_000, requestTimeoutMs = 60_000, stopTimeoutMs = 15_000
}) {
  if (typeof importCollectedBook !== "function") throw new TypeError("collection Worker importCollectedBook is required");
  const config = { dbPath, credentialRoot, outputRoot, projectRoot, pythonPath, ...(runnerPath ? { runnerPath } : {}) };
  const queue = [];
  let pendingBytes = 0;
  let active = null;
  let pumping = false;
  let accepting = true;
  let connection = null;
  let stopTask = null;
  let requestId = 0;
  let lifecycleGeneration = 0;
  const idleWaiters = new Set();

  async function start() {
    const generation = lifecycleGeneration;
    if (stopTask) await stopTask;
    if (generation !== lifecycleGeneration) throw stoppedError();
    stopTask = null;
    accepting = true;
    return request("start");
  }

  function request(method, args = []) {
    if (!accepting) return Promise.reject(stoppedError());
    const bytes = payloadBytes(args);
    if (queue.length + Number(Boolean(active)) >= Math.max(1, maxPending) || pendingBytes + bytes > maxPendingBytes) {
      return Promise.reject(serviceError("NOVEL_COLLECTION_QUEUE_FULL", "采集后台请求队列已满，请稍后重试", 503));
    }
    const deferred = createDeferred();
    queue.push({ ...deferred, id: ++requestId, method, args: structuredClone(args), bytes, dispatched: false });
    pendingBytes += bytes;
    void pump();
    return deferred.promise;
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
          current = connection || (connection = createConnection());
          await current.ready;
          if (!accepting) throw stoppedError();
          const result = await current.request(job);
          job.resolve(result);
        } catch (error) {
          if (error.workerUnavailable && current) {
            // Never retry a sent mutation: collection.sqlite has no receipt
            // envelope proving whether its synchronous state transition committed.
            accepting = false;
            rejectQueued(stoppedError());
            try { await current.dispose(); }
            catch (closeError) { error = closeError; }
            job.reject(job.dispatched && MUTATIONS.has(job.method) ? unknownError(job, error) : error);
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

  function rejectQueued(error) {
    for (const job of queue.splice(0)) { pendingBytes -= job.bytes; job.reject(error); }
  }
  function beginStop() {
    lifecycleGeneration += 1;
    accepting = false;
    rejectQueued(stoppedError());
    connection?.beginStop();
  }
  function stop() {
    if (!stopTask) stopTask = (async () => {
      beginStop();
      const current = connection;
      if (current) await current.stop();
      if (pumping) await new Promise((resolve) => idleWaiters.add(resolve));
      connection = null;
    })();
    return stopTask;
  }

  function createConnection() {
    const generation = crypto.randomUUID();
    const ready = createDeferred();
    ready.promise.catch(() => {});
    const exit = createDeferred();
    const stopped = createDeferred();
    stopped.promise.catch(() => {});
    const children = new Map();
    const imports = new Set();
    let pending = null;
    let exited = false;
    let closed = false;
    let stopping = false;
    let disposeTask = null;
    const worker = workerFactory(workerUrl, { workerData: { generation, config }, execArgv: process.execArgv.filter((value) => !String(value).startsWith("--input-type")) });
    const post = (message) => {
      if (exited) return;
      try { worker.postMessage({ ...message, generation }); }
      catch (error) { fail(unavailableError("采集后台消息发送失败", error)); }
    };
    const readyTimer = setTimeout(() => fail(unavailableError("采集后台线程启动超时")), readyTimeoutMs);
    worker.on("message", (message) => {
      if (message?.generation !== generation || exited) return;
      if (message.type === "ready") {
        clearTimeout(readyTimer); ready.resolve();
      } else if (message.type === "result" && pending?.id === message.id) {
        const job = pending; pending = null; clearTimeout(job.timer);
        if (message.ok) job.resolve(message.data); else job.reject(messageError(message));
      } else if (message.type === "stopped") stopped.resolve();
      else if (message.type === "stop-error" || message.type === "worker-error") fail(messageError(message));
      else if (message.type === "child-spawn") ownChild(message);
      else if (message.type === "child-kill") killChild(children.get(message.id), message.signal);
      else if (message.type === "child-ack") children.get(message.id)?.child[message.channel]?.resume?.();
      else if (message.type === "import") importBook(message);
    });
    worker.on("error", (error) => fail(unavailableError("采集后台线程异常退出", error)));
    worker.on("exit", () => {
      exited = true; exit.resolve();
      fail(unavailableError("采集后台线程已退出"));
    });

    function fail(error) {
      if (closed) return;
      closed = true;
      accepting = false;
      rejectQueued(stoppedError());
      error.workerUnavailable = true;
      clearTimeout(readyTimer);
      ready.reject(error); stopped.reject(error);
      if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = null; }
      void dispose().catch(() => {});
    }
    function rpc(job) {
      if (closed) return Promise.reject(unavailableError("采集后台线程不可用"));
      const deferred = createDeferred();
      pending = { ...deferred, id: job.id };
      pending.timer = setTimeout(() => fail(unavailableError("采集后台响应超时")), requestTimeoutMs);
      try {
        worker.postMessage({ type: "request", generation, id: job.id, method: job.method, args: job.args });
        job.dispatched = true;
      } catch (error) { fail(unavailableError("采集后台请求发送失败", error)); }
      return deferred.promise;
    }

    function ownChild(message) {
      if (stopping || closed) {
        post({ type: "child-error", id: message.id, ...serializeError(stoppedError()) });
        post({ type: "child-close", id: message.id, code: null, signal: "SIGKILL" });
        return;
      }
      let child;
      try { child = spawnProcess(message.command, message.args, { ...message.options, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
      catch (error) {
        post({ type: "child-error", id: message.id, ...serializeError(error) });
        post({ type: "child-close", id: message.id, code: null, signal: null });
        return;
      }
      const close = createDeferred();
      const owned = { child, close: close.promise };
      children.set(message.id, owned);
      for (const channel of ["stdout", "stderr"]) {
        child[channel]?.on("data", (data) => {
          if (stopping || closed || owned.forceKilled) return;
          child[channel].pause?.();
          post({ type: "child-data", id: message.id, channel, data });
        });
        child[channel]?.once("end", () => post({ type: "child-end", id: message.id, channel }));
        child[channel]?.on("error", (error) => {
          post({ type: "child-error", id: message.id, ...serializeError(error) });
          killChild(owned, "SIGKILL");
        });
      }
      child.on("error", (error) => {
        post({ type: "child-error", id: message.id, ...serializeError(error) });
        killChild(owned, "SIGKILL");
      });
      child.once("close", (code, signal) => {
        children.delete(message.id);
        close.resolve();
        post({ type: "child-close", id: message.id, code, signal });
      });
    }

    function killChild(owned, signal = "SIGKILL") {
      if (!owned) return;
      if (signal !== "SIGKILL" || !owned.forceKilled) {
        if (signal === "SIGKILL") owned.forceKilled = true;
        try { owned.child.kill(signal); } catch {}
      }
      if (stopping || closed || owned.forceKilled) {
        owned.child.stdout?.resume?.();
        owned.child.stderr?.resume?.();
      }
    }
    async function closeChildren() {
      const owned = [...children.values()];
      for (const child of owned) killChild(child, "SIGKILL");
      await bounded(Promise.all(owned.map((child) => child.close)), stopTimeoutMs, "采集子进程尚未确认结束");
      if (children.size) throw unavailableError("采集子进程仍未结束");
    }
    function importBook(message) {
      // Messages already queued by a failed/stopping Worker must not acquire
      // a new business-write owner after shutdown has captured its drain set.
      if (closed || stopping) {
        post({ type: "import-result", id: message.id, ok: false, ...serializeError(Object.assign(stoppedError(), { outcome: "not_committed" })) });
        return;
      }
      if (imports.size || payloadBytes(message.book) > maxImportBytes) {
        post({ type: "import-result", id: message.id, ok: false,
          ...serializeError(Object.assign(serviceError("NOVEL_COLLECTION_QUEUE_FULL", "采集导入请求超过后台容量", 503), { outcome: "not_committed" })) });
        return;
      }
      // A sent import uses the one existing novels.sqlite receipt-aware writer.
      // Shutdown waits for it instead of guessing whether it committed.
      const task = Promise.resolve().then(() => importCollectedBook(message.book, message.operationId ? { operationId: message.operationId } : undefined))
        .then((data) => post({ type: "import-result", id: message.id, ok: true, data }),
          (error) => post({ type: "import-result", id: message.id, ok: false, ...serializeError(error) }))
        .finally(() => imports.delete(task));
      imports.add(task);
    }
    function beginConnectionStop() {
      if (stopping) return;
      stopping = true;
      for (const child of children.values()) killChild(child, "SIGKILL");
      post({ type: "begin-stop" });
    }
    async function stopConnection() {
      if (closed) { await dispose(); return; }
      beginConnectionStop();
      try {
        await closeChildren();
        await bounded(stopped.promise, stopTimeoutMs, "采集后台尚未确认停止");
        await bounded(Promise.allSettled([...imports]), stopTimeoutMs, "采集导入结果尚未确认");
        post({ type: "close" });
        await bounded(exit.promise, stopTimeoutMs, "采集后台线程尚未确认退出");
      } catch (error) {
        fail(unavailableError(error.message, error));
        await dispose();
        throw error;
      }
    }
    function dispose() {
      if (!disposeTask) disposeTask = (async () => {
        closed = true; stopping = true;
        clearTimeout(readyTimer);
        // terminate() does not own spawned processes: confirm their close first.
        await closeChildren();
        await bounded(Promise.allSettled([...imports]), stopTimeoutMs, "采集导入结果尚未确认");
        if (!exited) {
          try { await bounded(Promise.resolve().then(() => worker.terminate()), stopTimeoutMs, "采集后台线程终止尚未确认"); }
          catch (error) { if (!exited) throw error; }
        }
        await bounded(exit.promise, stopTimeoutMs, "采集后台线程尚未确认退出");
      })();
      return disposeTask;
    }
    return { ready: ready.promise, request: rpc, beginStop: beginConnectionStop, stop: stopConnection, dispose,
      diagnostics: () => ({ children: children.size, imports: imports.size, exited }) };
  }

  return { start, beginStop, stop, ...Object.fromEntries(METHODS.map((method) => [method, (...args) => request(method, args)])),
    diagnostics: () => ({ accepting, pending: queue.length, active: Boolean(active), dispatched: Boolean(active?.dispatched), pendingBytes, ...connection?.diagnostics() }) };
}

function createDeferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function serviceError(code, message, statusCode = 503, cause) { return Object.assign(new Error(message, { cause }), { code, statusCode }); }
function stoppedError() { return serviceError("NOVEL_COLLECTION_STOPPED", "采集后台正在停止"); }
function unavailableError(message, cause) { return Object.assign(serviceError("NOVEL_COLLECTION_WORKER_UNAVAILABLE", message, 503, cause), { workerUnavailable: true }); }
function unknownError(job, cause) { return Object.assign(serviceError("NOVEL_COLLECTION_OUTCOME_UNKNOWN", "采集任务提交结果暂时无法确认，请刷新确认后再操作", 503, cause), { outcome: "unknown", operationId: job.id, method: job.method }); }
function serializeError(error) { return { error: String(error?.message || error), code: String(error?.code || ""), statusCode: Number(error?.statusCode || 500), ...(error?.outcome ? { outcome: error.outcome } : {}), ...(error?.operationId ? { operationId: error.operationId } : {}) }; }
function messageError(message) { return Object.assign(serviceError(message.code || "NOVEL_COLLECTION_FAILED", message.error || "采集后台操作失败", message.statusCode || 500), message.outcome ? { outcome: message.outcome, operationId: message.operationId } : {}); }
function payloadBytes(value) { if (typeof value === "string") return value.length * 2; if (ArrayBuffer.isView(value)) return value.byteLength; if (!value || typeof value !== "object") return 8; return Object.entries(value).reduce((sum, [key, item]) => sum + key.length * 2 + payloadBytes(item), 0); }
async function bounded(promise, timeoutMs, message) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(unavailableError(message)), timeoutMs); })]); } finally { clearTimeout(timer); } }
