import { spawn } from "node:child_process";
import { boundedInteger } from "./local-image-read-queue.js";

export function archiveStoppedError() {
  return Object.assign(new Error("Archive reader is stopping"), { code: "ARCHIVE_READER_STOPPED", statusCode: 503 });
}

export function createArchiveTaskPool({ concurrency = 4, capacity = 128, stopTimeoutMs = 2_000 } = {}) {
  concurrency = boundedInteger(concurrency, 4, 1, 16);
  capacity = boundedInteger(capacity, 128, concurrency, 512);
  stopTimeoutMs = boundedInteger(stopTimeoutMs, 2_000, 1, 60_000);
  const tasks = new Set(), shared = new Map(), pending = [];
  let active = 0, consumers = 0, accepting = true, generation = 0, stopping = null, draining = null;

  function run(key, operation, { signal, waitForCloseOnAbort = false } = {}) {
    if (!accepting || signal?.aborted) return Promise.reject(archiveStoppedError());
    if (consumers >= capacity) return Promise.reject(fullError());
    let task = shared.get(key);
    if (task?.controller.signal.aborted) task = null;
    if (!task) {
      if (tasks.size >= capacity) return Promise.reject(fullError());
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      task = { key, operation, promise, resolve, reject, generation, controller: new AbortController(), consumers: new Set(), phase: "queued" };
      const predecessors = [...tasks].filter(value => value.key === key && value.phase === "active" && value.controller.signal.aborted);
      task.blocked = predecessors.length > 0;
      tasks.add(task); shared.set(key, task); pending.push(task);
      if (task.blocked) Promise.allSettled(predecessors.map(value => value.promise)).then(() => { task.blocked = false; drain(); });
      const release = () => { tasks.delete(task); if (shared.get(key) === task) shared.delete(key); };
      promise.then(release, release);
    }
    consumers++;
    const result = new Promise((resolve, reject) => {
      const consumer = { aborted: false };
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; consumers--; task.consumers.delete(consumer);
        signal?.removeEventListener("abort", abort);
        error ? reject(error) : resolve(value);
      };
      const abort = () => {
        if (settled || consumer.aborted) return;
        consumer.cancel();
        if (!task.consumers.size) cancel(task);
      };
      // HTTP consumers may finish immediately; nested resource users can wait
      // for physical completion before removing a child process's output path.
      consumer.cancel = () => {
        consumer.aborted = true; task.consumers.delete(consumer);
        if (!waitForCloseOnAbort) finish(archiveStoppedError());
      };
      task.consumers.add(consumer);
      signal?.addEventListener("abort", abort, { once: true });
      task.promise.then(value => finish(consumer.aborted ? archiveStoppedError() : null, value), error => finish(error));
      if (signal?.aborted) abort();
    });
    drain(); return result;
  }

  function cancel(task) {
    task.controller.abort();
    for (const consumer of [...task.consumers]) consumer.cancel();
    if (task.phase === "queued") {
      const index = pending.indexOf(task);
      if (index >= 0) pending.splice(index, 1);
      task.phase = "settled"; task.reject(archiveStoppedError());
    }
  }
  function drain() {
    while (accepting && active < concurrency && pending.length) {
      const index = pending.findIndex(task => !task.blocked);
      if (index < 0) return;
      const [task] = pending.splice(index, 1);
      task.phase = "active"; active++;
      const context = { signal: task.controller.signal, generation: task.generation, isCurrent: () => accepting && task.generation === generation && !task.controller.signal.aborted };
      Promise.resolve().then(() => task.operation(context)).then(value => {
        if (!context.isCurrent()) throw archiveStoppedError();
        return value;
      }).then(task.resolve, task.reject).finally(() => { task.phase = "settled"; active--; drain(); });
    }
  }
  function invalidate() { generation++; for (const task of tasks) cancel(task); }
  function beginStop() { accepting = false; invalidate(); }
  function stop() {
    beginStop();
    if (!stopping) {
      draining = Promise.allSettled([...tasks].map(task => task.promise));
      let timer;
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("Archive reader owners have not closed"), { code: "ARCHIVE_READER_STOP_INCOMPLETE", statusCode: 503 })), stopTimeoutMs); });
      stopping = Promise.race([draining, deadline]).finally(() => clearTimeout(timer));
    }
    return stopping;
  }
  async function start() {
    const intent = ++generation;
    if (stopping) { if (tasks.size) await stopping; else await draining; }
    if (intent !== generation) throw archiveStoppedError();
    stopping = null; draining = null; accepting = true;
  }
  return { run, invalidate, beginStop, stop, start, isAccepting: () => accepting, diagnostics: () => ({ accepting, active, pending: pending.length, tasks: tasks.size, consumers }) };
}

function fullError() {
  return Object.assign(new Error("Archive reader queue is full"), { code: "ARCHIVE_READER_BUSY", statusCode: 503 });
}

export function runArchiveChild(file, args, {
  cwd, signal, timeoutMs = 120_000, maxBytes = 1024 * 1024,
  spawnProcess = spawn, onChild = () => {}, stderrMaxBytes = 128 * 1024
} = {}) {
  maxBytes = boundedInteger(maxBytes, 1024 * 1024, 1, 128 * 1024 * 1024);
  stderrMaxBytes = boundedInteger(stderrMaxBytes, 128 * 1024, 1, 1024 * 1024);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(archiveStoppedError()); return; }
    let child, failure = null, timer, bytes = 0, stderrBytes = 0;
    const stdout = [], stderr = [];
    const kill = error => {
      failure ||= error;
      try { child?.kill("SIGKILL"); } catch (error) { failure ||= error; }
    };
    const abort = () => kill(archiveStoppedError());
    try { child = spawnProcess(file, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { reject(error); return; }
    onChild(child, true);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", chunk => {
      if (failure) return;
      const value = Buffer.from(chunk); bytes += value.length;
      if (bytes > maxBytes) { kill(Object.assign(new Error("Archive helper output exceeds its limit"), { code: "ENOBUFS", statusCode: 503 })); return; }
      stdout.push(value);
    });
    child.stderr?.on("data", chunk => {
      if (stderrBytes >= stderrMaxBytes) return;
      const value = Buffer.from(chunk).subarray(0, stderrMaxBytes - stderrBytes);
      stderrBytes += value.length; stderr.push(value);
    });
    child.stdout?.on("error", error => kill(error));
    child.stderr?.on("error", error => kill(error));
    child.once("error", error => kill(error));
    child.once("close", (code, terminationSignal) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort); onChild(child, false);
      if (failure) { reject(failure); return; }
      const output = Buffer.concat(stdout), detail = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) { reject(new Error(detail || `Archive helper exited (${code ?? terminationSignal})`)); return; }
      resolve({ stdout: output, stderr: detail });
    });
    timer = setTimeout(() => kill(Object.assign(new Error("Archive helper timed out"), { code: "ARCHIVE_READER_TIMEOUT", statusCode: 503 })), boundedInteger(timeoutMs, 120_000, 1, 120_000));
    timer.unref?.();
    if (signal?.aborted) abort();
  });
}
