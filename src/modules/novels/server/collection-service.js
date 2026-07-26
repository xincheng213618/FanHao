import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { createNovelCollectionStore } from "./collection-store.js";

const MAX_RESULT_BYTES = 96 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 96 * 1024 * 1024;
const MAX_LOG_LINES = 160;
const RESUMABLE_TASK_STATUSES = new Set(["failed", "cancelled"]);

export function createNovelCollectionService({
  credentialService = null,
  dbPath,
  novelStore,
  outputRoot,
  projectRoot,
  pythonPath = "python",
  runnerPath = path.join(projectRoot || process.cwd(), "src", "modules", "novels", "collectors", "runner.py"),
  spawnProcess = spawn,
  probeProcess = spawnSync
} = {}) {
  if (!novelStore) throw new Error("novel collection novelStore is required");
  const root = path.resolve(projectRoot || process.cwd());
  const taskOutputRoot = path.resolve(outputRoot || path.join(path.dirname(dbPath), "novel-collection"));
  const store = createNovelCollectionStore({ dbPath });
  let started = false;
  let stopping = false;
  let pumpScheduled = false;
  let active = null;
  let runtimeProbe = {
    ready: false,
    checkedAt: "",
    error: "尚未检查"
  };

  function start() {
    if (started) return;
    started = true;
    stopping = false;
    fs.mkdirSync(taskOutputRoot, { recursive: true });
    store.recoverInterruptedTasks();
    runtimeProbe = probeRuntime();
    schedulePump();
  }

  async function stop() {
    if (!started) {
      store.close();
      return;
    }
    stopping = true;
    const running = active;
    if (running?.child) {
      running.stopRequested = true;
      try {
        running.child.kill();
      } catch {}
      await Promise.race([
        running.done,
        new Promise((resolve) => setTimeout(resolve, 3000))
      ]);
    }
    active = null;
    started = false;
    store.close();
  }

  function invalidate() {
    store.close();
  }

  function snapshot() {
    return {
      summary: store.summary(),
      adapters: store.listAdapters(),
      tasks: store.listTasks(),
      credentials: credentialService?.statusSummary?.() || {},
      runtime: runtimeStatus()
    };
  }

  function runtimeStatus() {
    return {
      ...runtimeProbe,
      pythonPath,
      runnerPath,
      outputRoot: taskOutputRoot,
      runningTaskId: active?.taskId || ""
    };
  }

  function listAdapters() {
    return { adapters: store.listAdapters() };
  }

  function createAdapter(body) {
    return { adapter: store.createAdapter(body || {}) };
  }

  function updateAdapter(id, body) {
    return { adapter: store.updateAdapter(id, body || {}) };
  }

  function deleteAdapter(id) {
    const adapter = store.deleteAdapter(id);
    if (!adapter) return null;
    return { ok: true, adapter };
  }

  function listTasks() {
    return { tasks: store.listTasks(), summary: store.summary(), runtime: runtimeStatus() };
  }

  function taskDetail(id) {
    return store.getTask(id);
  }

  function createTask(body = {}) {
    const existing = store.findReusableTask(body);
    if (existing) {
      if (["queued", "running", "cancelling"].includes(existing.status)) {
        return { ok: true, task: existing, reused: true, resumed: false, alreadyActive: true };
      }
      const updated = store.updateTaskDefinition(existing.id, body);
      const checkpointCount = RESUMABLE_TASK_STATUSES.has(existing.status)
        ? readableCheckpointCount(updated)
        : 0;
      if (checkpointCount > 0) {
        store.updateCheckpoint(updated.id, {
          count: checkpointCount,
          total: Math.max(updated.progressTotal, checkpointCount),
          message: `已找到 ${checkpointCount} 章断点记录`
        });
      } else {
        clearCheckpointFiles(updated.id);
      }
      const task = store.prepareTaskRun(updated.id, { preserveCheckpoint: checkpointCount > 0 });
      schedulePump();
      return {
        ok: true,
        task,
        reused: true,
        resumed: checkpointCount > 0,
        alreadyActive: false
      };
    }
    const task = store.createTask(body);
    schedulePump();
    return { ok: true, task, reused: false, resumed: false, alreadyActive: false };
  }

  function runTask(id) {
    const current = store.getTask(id);
    if (!current) throw httpError(404, "采集任务不存在");
    if (current.status === "queued") {
      schedulePump();
      return { ok: true, task: current, reused: true, resumed: false, alreadyActive: true };
    }
    const checkpointCount = RESUMABLE_TASK_STATUSES.has(current.status)
      ? readableCheckpointCount(current)
      : 0;
    if (checkpointCount > 0) {
      store.updateCheckpoint(current.id, {
        count: checkpointCount,
        total: Math.max(current.progressTotal, checkpointCount),
        message: `已找到 ${checkpointCount} 章断点记录`
      });
    } else {
      clearCheckpointFiles(current.id);
    }
    const task = store.prepareTaskRun(id, { preserveCheckpoint: checkpointCount > 0 });
    schedulePump();
    return {
      ok: true,
      task,
      reused: true,
      resumed: checkpointCount > 0,
      alreadyActive: false
    };
  }

  function cancelTask(id) {
    const task = store.getTask(id);
    if (!task) throw httpError(404, "采集任务不存在");
    if (task.status === "queued") {
      return { ok: true, task: store.failTask(id, "任务已取消", { cancelled: true }) };
    }
    if (["running", "cancelling"].includes(task.status)) {
      const cancelling = store.markCancelling(id);
      if (active?.taskId === id) {
        active.cancelRequested = true;
        try {
          active.child?.kill();
        } catch {}
      }
      return { ok: true, task: cancelling };
    }
    return { ok: true, task };
  }

  function deleteTask(id) {
    const task = store.deleteTask(id);
    if (!task) return null;
    return { ok: true, task };
  }

  function schedulePump() {
    if (!started || stopping || active || pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      pump().catch((error) => {
        console.error("[novel-collection] queue failed", error);
      });
    });
  }

  async function pump() {
    if (!started || stopping || active) return;
    const next = store.queuedTasks()[0];
    if (!next) return;
    await executeTask(next);
  }

  function executeTask(queuedTask) {
    const task = store.markRunning(queuedTask.id);
    const taskDir = path.join(taskOutputRoot, task.id);
    fs.mkdirSync(taskDir, { recursive: true });
    const configPath = path.join(taskDir, "task.json");
    const resultPath = path.join(taskDir, "result.json");
    const logPath = path.join(taskDir, "collector.log");
    const payload = {
      taskId: task.id,
      url: task.startUrl,
      mode: task.mode,
      adapter: task.adapterSnapshot,
      options: task.options,
      credentials: credentialService?.runnerCredentials?.(task.adapterId) || {},
      projectRoot: root
    };
    fs.writeFileSync(configPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.appendFileSync(
      logPath,
      `${new Date().toISOString()} attempt ${task.attempt} started\n`,
      "utf8"
    );

    const logLines = [];
    let lastProgress = {
      current: task.progressCurrent,
      total: task.progressTotal,
      message: task.message
    };
    let settled = false;
    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    const execution = {
      taskId: task.id,
      child: null,
      cancelRequested: false,
      stopRequested: false,
      done
    };
    active = execution;

    let child;
    let stdout = null;
    let stderr = null;
    try {
      child = spawnProcess(
        pythonPath,
        ["-u", runnerPath, "--config", configPath, "--output-dir", taskDir, "--result", resultPath],
        {
          cwd: root,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            PYTHONDONTWRITEBYTECODE: "1",
            PYTHONIOENCODING: "utf-8",
            PYTHONUTF8: "1"
          }
        }
      );
      execution.child = child;
    } catch (error) {
      finishFailure(error);
      return done;
    }

    stdout = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    stderr = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
    stdout.on("line", (line) => handleOutputLine(line, false));
    stderr.on("line", (line) => handleOutputLine(line, true));
    child.once("error", (error) => finishFailure(error));
    child.once("close", (code, signal) => finishProcess(code, signal));
    return done;

    function handleOutputLine(rawLine, isError) {
      const line = String(rawLine || "").trim();
      if (!line) return;
      appendLog(`${isError ? "stderr" : "stdout"} ${line}`);
      let event = null;
      if (!isError && line.startsWith("{")) {
        try {
          event = JSON.parse(line);
        } catch {}
      }
      if (!event || typeof event !== "object") {
        if (isError) {
          lastProgress.message = line.slice(0, 500);
          persistProgress();
        }
        return;
      }
      if (event.event === "progress") {
        lastProgress = {
          current: numberOr(event.current, lastProgress.current),
          total: numberOr(event.total, lastProgress.total),
          message: String(event.message || lastProgress.message || "").slice(0, 500)
        };
        persistProgress();
      } else if (event.event === "checkpoint") {
        const checkpointCount = Math.max(0, numberOr(event.saved, 0));
        const checkpointTotal = Math.max(0, numberOr(event.total, lastProgress.total));
        lastProgress = {
          current: Math.max(lastProgress.current, checkpointCount),
          total: checkpointTotal || lastProgress.total,
          message: String(event.message || lastProgress.message || "").slice(0, 500)
        };
        try {
          store.updateCheckpoint(task.id, {
            count: checkpointCount,
            total: lastProgress.total,
            message: lastProgress.message
          });
        } catch {}
        persistProgress();
      } else if (event.event === "status" || event.event === "warning") {
        lastProgress.message = String(event.message || "").slice(0, 500);
        persistProgress();
      }
    }

    function appendLog(line) {
      const timestamped = `${new Date().toISOString()} ${line}`;
      logLines.push(timestamped);
      if (logLines.length > MAX_LOG_LINES) logLines.splice(0, logLines.length - MAX_LOG_LINES);
      try {
        fs.appendFileSync(logPath, `${timestamped}\n`, "utf8");
      } catch {}
    }

    function persistProgress() {
      try {
        store.updateProgress(task.id, {
          ...lastProgress,
          logTail: logLines.join("\n")
        });
      } catch {}
    }

    function finishProcess(code, signal) {
      if (settled) return;
      if (execution.cancelRequested) {
        finishCancelled();
        return;
      }
      if (execution.stopRequested) {
        finishFailure(new Error("服务停止，采集任务已中断"));
        return;
      }
      if (code !== 0) {
        const result = readResultFile(resultPath, { optional: true });
        const detail = result?.error || result?.message || lastProgress.message;
        finishFailure(new Error(detail || `采集器退出码 ${code}${signal ? ` (${signal})` : ""}`));
        return;
      }
      try {
        const result = readResultFile(resultPath);
        if (result.status !== "ok" || !result.book) throw new Error(result.error || "采集器没有返回书籍内容");
        const summary = summarizeCollectorResult(result);
        if (task.mode === "test") {
          store.completeTask(task.id, {
            result: summary,
            message: `测试通过：解析 ${summary.chapterCount} 章`,
            logTail: logLines.join("\n")
          });
        } else {
          const imported = novelStore.importCollectedBook({
            ...result.book,
            adapterId: task.adapterId,
            adapterName: task.adapterName,
            collectedAt: new Date().toISOString()
          });
          store.completeTask(task.id, {
            bookId: imported.book.id,
            result: { ...summary, bookId: imported.book.id },
            message: `采集完成并已导入：${imported.book.title}`,
            logTail: logLines.join("\n")
          });
        }
        finishCommon();
      } catch (error) {
        finishFailure(error);
      }
    }

    function finishCancelled() {
      if (settled) return;
      store.failTask(task.id, "任务已取消", {
        cancelled: true,
        logTail: logLines.join("\n")
      });
      finishCommon();
    }

    function finishFailure(error) {
      if (settled) return;
      try {
        store.failTask(task.id, normalizeExecutionError(error, pythonPath), {
          logTail: logLines.join("\n")
        });
      } catch {}
      finishCommon();
    }

    function finishCommon() {
      if (settled) return;
      settled = true;
      try {
        stdout?.close();
      } catch {}
      try {
        stderr?.close();
      } catch {}
      if (active === execution) active = null;
      resolveDone();
      schedulePump();
    }
  }

  function probeRuntime() {
    const checkedAt = new Date().toISOString();
    if (!fs.existsSync(runnerPath)) {
      return { ready: false, checkedAt, error: "统一采集器脚本不存在" };
    }
    try {
      const result = probeProcess(
        pythonPath,
        ["-c", "import requests, bs4; print('ok')"],
        {
          cwd: root,
          windowsHide: true,
          encoding: "utf8",
          timeout: 8000,
          env: {
            ...process.env,
            PYTHONDONTWRITEBYTECODE: "1",
            PYTHONIOENCODING: "utf-8",
            PYTHONUTF8: "1"
          }
        }
      );
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(String(result.stderr || result.stdout || `Python 退出码 ${result.status}`).trim());
      }
      return { ready: true, checkedAt, error: "" };
    } catch (error) {
      return { ready: false, checkedAt, error: normalizeExecutionError(error, pythonPath).message };
    }
  }

  function readableCheckpointCount(task) {
    if (!task || task.mode !== "collect") return 0;
    const checkpointPath = path.join(taskOutputRoot, task.id, "checkpoint.json");
    let stat;
    try {
      stat = fs.statSync(checkpointPath);
    } catch {
      return 0;
    }
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CHECKPOINT_BYTES) return 0;
    try {
      const payload = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
      const identity = payload?.identity || {};
      if (
        String(identity.sourceUrl || "") !== task.startUrl
        || String(identity.adapterId || "") !== task.adapterId
        || String(identity.mode || "") !== task.mode
      ) {
        return 0;
      }
      return Array.isArray(payload.chapters)
        ? payload.chapters.filter((chapter) => String(chapter?.url || "").trim() && String(chapter?.content || "").trim()).length
        : 0;
    } catch {
      return 0;
    }
  }

  function clearCheckpointFiles(taskId) {
    const taskDir = path.join(taskOutputRoot, String(taskId || ""));
    for (const filename of ["checkpoint.json", "checkpoint.json.tmp"]) {
      try {
        fs.rmSync(path.join(taskDir, filename), { force: true });
      } catch {}
    }
  }

  return {
    cancelTask,
    createAdapter,
    createTask,
    deleteAdapter,
    deleteTask,
    invalidate,
    listAdapters,
    listTasks,
    runTask,
    runtimeStatus,
    snapshot,
    start,
    stop,
    taskDetail,
    updateAdapter
  };
}

function readResultFile(resultPath, { optional = false } = {}) {
  let stat;
  try {
    stat = fs.statSync(resultPath);
  } catch (error) {
    if (optional) return null;
    throw new Error(`采集结果文件不存在：${error.message || error}`);
  }
  if (stat.size > MAX_RESULT_BYTES) throw new Error("采集结果超过 96 MiB 上限");
  try {
    return JSON.parse(fs.readFileSync(resultPath, "utf8"));
  } catch (error) {
    if (optional) return null;
    throw new Error(`采集结果无法读取：${error.message || error}`);
  }
}

function summarizeCollectorResult(result) {
  const chapters = Array.isArray(result.book?.chapters) ? result.book.chapters : [];
  const charCount = chapters.reduce((total, chapter) => total + String(chapter?.content || "").length, 0);
  const first = chapters[0] || {};
  return {
    title: String(result.book?.title || ""),
    author: String(result.book?.author || ""),
    sourceUrl: String(result.book?.sourceUrl || ""),
    adapterId: String(result.adapterId || ""),
    chapterCount: chapters.length,
    charCount,
    outputPath: String(result.outputPath || ""),
    preview: String(first.content || "").replace(/\s+/g, " ").slice(0, 500),
    report: result.report && typeof result.report === "object" ? result.report : {}
  };
}

function normalizeExecutionError(error, pythonPath) {
  const source = error instanceof Error ? error : new Error(String(error || "采集失败"));
  if (source.code === "ENOENT") {
    const wrapped = new Error(`找不到 Python：${pythonPath}`);
    wrapped.statusCode = 500;
    return wrapped;
  }
  return source;
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : Math.max(0, Number(fallback || 0));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
