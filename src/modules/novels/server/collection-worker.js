import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { parentPort, workerData } from "node:worker_threads";
import { createNovelCollectionService } from "./collection-service.js";
import { createNovelCredentialService } from "./credential-service.js";

const { generation, config } = workerData;
const MAX_CHILD_LINE_BYTES = 1024 * 1024;
const children = new Map();
const imports = new Map();
let childId = 0;
let importId = 0;
let stopping = false;
let stopTask = null;
let operations = Promise.resolve();
const send = (message) => parentPort.postMessage({ ...message, generation });

const credentials = createNovelCredentialService({ credentialRoot: config.credentialRoot, pythonPath: config.pythonPath });
const service = createNovelCollectionService({
  ...config,
  credentialService: credentials,
  novelStore: { importCollectedBook: importCollectedBook },
  spawnProcess: spawnProcess,
  probeProcess: probeProcess
});

send({ type: "ready" });
parentPort.on("message", (message) => {
  if (message?.generation !== generation) return;
  if (message.type === "begin-stop") {
    stopping = true;
    stopService();
    return;
  }
  if (message.type === "close") { parentPort.close(); return; }
  if (message.type === "child-data" || message.type === "child-end" || message.type === "child-error" || message.type === "child-close") {
    try { acceptChildMessage(message); }
    finally { queueMicrotask(() => service.invalidate()); }
    return;
  }
  if (message.type === "import-result") {
    const pending = imports.get(message.id);
    if (!pending) return;
    imports.delete(message.id);
    try {
      if (message.ok) pending.resolve(message.data);
      else pending.reject(messageError(message));
    } finally {
      // Promise continuations complete/fail the task before this close, while
      // the next background pump reopens the path for its next atomic turn.
      queueMicrotask(() => service.invalidate());
    }
    return;
  }
  if (message.type !== "request") return;
  operations = operations.then(async () => {
    if (stopping) {
      send({ type: "result", id: message.id, ok: false, ...serializeError(stoppedError()) });
      return;
    }
    let response;
    try {
      if (!allowedMethods.has(message.method)) throw Object.assign(new Error("采集后台方法无效"), { statusCode: 400 });
      send({ type: "started", id: message.id });
      const data = await service[message.method](...message.args);
      response = { type: "result", id: message.id, ok: true, data };
    } catch (error) {
      response = { type: "result", id: message.id, ok: false, ...serializeError(error) };
    } finally {
      // The next RPC reopens the current path after an external DB replacement.
      service.invalidate();
    }
    // Acknowledgement means the DB handle has been released, so callers can
    // replace the file between RPCs without racing a lingering connection.
    send(response);
  }).catch((error) => {
    send({ type: "worker-error", ...serializeError(error) });
    stopping = true;
    stopService();
  });
});

function stopService() {
  if (!stopTask) stopTask = (async () => {
    await service.stop();
    await operations;
    send({ type: "stopped" });
  })().catch((error) => send({ type: "stop-error", ...serializeError(error) }));
  return stopTask;
}

function spawnProcess(command, args, options) {
  if (stopping) throw stoppedError();
  const id = ++childId;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.lineBytes = { stdout: 0, stderr: 0 };
  child.kill = (signal = "SIGTERM") => { send({ type: "child-kill", id, signal }); return true; };
  children.set(id, child);
  send({ type: "child-spawn", id, command, args, options });
  return child;
}

function acceptChildMessage(message) {
  const child = children.get(message.id);
  if (!child) return;
  if (message.type === "child-data") {
    if (child.outputFailed) return;
    const data = Buffer.from(message.data);
    let bytes = child.lineBytes[message.channel];
    for (const byte of data) {
      if (byte === 10 || byte === 13) bytes = 0;
      else if (++bytes > MAX_CHILD_LINE_BYTES) {
        child.outputFailed = true;
        child.failure ||= Object.assign(new Error("采集器单行输出超过 1 MiB 上限"), { code: "NOVEL_COLLECTION_OUTPUT_TOO_LARGE" });
        child.kill("SIGKILL");
        return;
      }
    }
    child.lineBytes[message.channel] = bytes;
    const stream = child[message.channel];
    const ack = () => send({ type: "child-ack", id: message.id, channel: message.channel });
    if (stream.write(data)) ack();
    else stream.once("drain", ack);
  } else if (message.type === "child-end") {
    child[message.channel].end();
  } else if (message.type === "child-error") {
    child.failure ||= messageError(message);
    child.kill("SIGKILL");
  } else {
    children.delete(message.id);
    // Keep the kernel's active slot until the parent confirms actual close.
    // Emitting error earlier would let its queue spawn another collector.
    if (child.failure) child.emit("error", child.failure);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", message.code, message.signal);
  }
}

function probeProcess(command, args, options) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnProcess(command, args, { ...options, encoding: undefined, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { resolve({ error, status: null, stdout: "", stderr: "" }); return; }
    let bytes = 0;
    let failure = null;
    const stdout = [], stderr = [];
    const retain = (target, chunk) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) {
        failure ||= new Error("Python 探测输出过大");
        child.kill("SIGKILL");
      } else target.push(chunk);
    };
    child.stdout.on("data", (chunk) => retain(stdout, chunk));
    child.stderr.on("data", (chunk) => retain(stderr, chunk));
    child.once("error", (error) => { failure ||= error; child.kill("SIGKILL"); });
    const timer = setTimeout(() => { failure ||= new Error("Python 探测超时"); child.kill("SIGKILL"); }, Number(options.timeout) || 8000);
    child.once("close", (status) => {
      clearTimeout(timer);
      resolve({ status, error: failure, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

function importCollectedBook(book, { operationId } = {}) {
  const id = ++importId;
  return new Promise((resolve, reject) => {
    imports.set(id, { resolve, reject });
    send({ type: "import", id, book, operationId });
  });
}

function serializeError(error) {
  return { error: String(error?.message || error), code: String(error?.code || ""), statusCode: Number(error?.statusCode || 500),
    ...(error?.outcome ? { outcome: error.outcome } : {}), ...(error?.operationId ? { operationId: error.operationId } : {}) };
}
function messageError(message) { return Object.assign(new Error(message.error || "采集后台操作失败"), { code: message.code, statusCode: message.statusCode, outcome: message.outcome, operationId: message.operationId }); }
function stoppedError() { return Object.assign(new Error("采集后台正在停止"), { code: "NOVEL_COLLECTION_STOPPED", statusCode: 503 }); }
const allowedMethods = new Set(["start", "snapshot", "runtimeStatus", "listAdapters", "createAdapter", "updateAdapter", "deleteAdapter", "listTasks", "taskDetail", "createTask", "runTask", "cancelTask", "deleteTask", "invalidate"]);
