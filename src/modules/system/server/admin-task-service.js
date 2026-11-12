import fs from "node:fs";
import { spawn } from "node:child_process";

function normalizeStatus(status) {
  return ["running", "stopping", "stopped", "done", "error"].includes(status) ? status : "error";
}

function isActiveTask(task) {
  return task.status === "running" || task.status === "stopping";
}

function trimFinishedTasks(tasks, historyLimit) {
  const finished = tasks.filter((task) => !isActiveTask(task));
  if (finished.length <= historyLimit) return;
  // Keep a long task's result visible even if many newer tasks finished first.
  finished.sort((left, right) => (right.finishedAt || right.startedAt).localeCompare(left.finishedAt || left.startedAt));
  const expired = new Set(finished.slice(historyLimit));
  for (let index = tasks.length - 1; index >= 0; index--) {
    if (expired.has(tasks[index])) tasks.splice(index, 1);
  }
}

function durationMs(task) {
  const started = Date.parse(task.startedAt || "");
  const ended = Date.parse(task.finishedAt || "") || Date.now();
  if (!Number.isFinite(started)) return null;
  return Math.max(0, ended - started);
}

function persistedTask(task) {
  return {
    id: String(task.id || ""),
    type: String(task.type || ""),
    scriptId: String(task.scriptId || ""),
    label: String(task.label || "任务"),
    personId: String(task.personId || ""),
    personName: String(task.personName || ""),
    status: normalizeStatus(task.status),
    exitCode: task.exitCode ?? null,
    pid: task.pid || null,
    refreshHints: Array.isArray(task.refreshHints) ? task.refreshHints.slice(0, 20) : [],
    invalidates: Array.isArray(task.invalidates) ? task.invalidates.slice(0, 20) : [],
    startedAt: String(task.startedAt || ""),
    finishedAt: String(task.finishedAt || ""),
    logs: Array.isArray(task.logs) ? task.logs.slice(-400).map((line) => String(line).slice(0, 4000)) : []
  };
}

function quoteCommandPart(value) {
  const text = String(value || "");
  return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function commandPreview(command, args) {
  return [command, ...args].map(quoteCommandPart).join(" ");
}

export function createAdminTaskService({
  prepareProcess = (value) => value,
  cwd,
  ensureDataDir,
  historyLimit,
  onTaskDone,
  tasksPath
}) {
  let seq = 0;
  let persistTimer = null;
  const tasks = loadHistory();

  function loadHistory() {
    try {
      ensureDataDir();
      if (!fs.existsSync(tasksPath)) return [];
      const parsed = JSON.parse(fs.readFileSync(tasksPath, "utf8"));
      const rawTasks = Array.isArray(parsed?.tasks) ? parsed.tasks : Array.isArray(parsed) ? parsed : [];
      const now = new Date().toISOString();
      const loaded = [];
      let maxSeq = 0;
      for (const rawTask of rawTasks) {
        if (!rawTask || typeof rawTask !== "object") continue;
        const task = persistedTask(rawTask);
        if (!task.id) continue;
        const taskSeq = Number(String(task.id).replace(/^task_/, ""));
        if (Number.isFinite(taskSeq)) maxSeq = Math.max(maxSeq, taskSeq);
        if (isActiveTask(task)) {
          task.status = "stopped";
          task.finishedAt = task.finishedAt || now;
          task.logs.push("服务重启，未完成任务已标记为中断");
        }
        loaded.push(task);
      }
      seq = maxSeq;
      trimFinishedTasks(loaded, historyLimit);
      return loaded;
    } catch (error) {
      console.warn("[admin] 读取任务历史失败：", error.message);
      return [];
    }
  }

  function persist() {
    clearTimeout(persistTimer);
    persistTimer = null;
    try {
      ensureDataDir();
      const payload = {
        version: 1,
        updatedAt: new Date().toISOString(),
        tasks: tasks.map(persistedTask)
      };
      const tempPath = `${tasksPath}.tmp`;
      fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      fs.renameSync(tempPath, tasksPath);
    } catch (error) {
      console.warn("[admin] 保存任务历史失败：", error.message);
    }
  }

  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persist();
    }, 250);
  }

  function pushLog(task, chunk) {
    const lines = String(chunk || "").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      task.logs.push(line);
    }
    if (task.logs.length > 400) task.logs.splice(0, task.logs.length - 400);
    schedulePersist();
  }

  function callTaskHook(task, callback, label, ...args) {
    try {
      callback?.(task, ...args);
      return true;
    } catch (error) {
      pushLog(task, `${label}失败：${error?.message || String(error)}`);
      return false;
    }
  }

  function summary() {
    const result = { total: tasks.length, running: 0, stopping: 0, done: 0, error: 0, stopped: 0 };
    for (const task of tasks) {
      const status = normalizeStatus(task.status);
      result[status] = (result[status] || 0) + 1;
    }
    return result;
  }

  function publicTask(task) {
    return {
      id: task.id,
      type: task.type,
      scriptId: task.scriptId || "",
      label: task.label,
      personId: task.personId || "",
      personName: task.personName || "",
      status: task.status,
      exitCode: task.exitCode ?? null,
      pid: task.pid || null,
      canStop: Boolean(task.child && isActiveTask(task)),
      refreshHints: [...(task.refreshHints || [])],
      startedAt: task.startedAt,
      finishedAt: task.finishedAt || "",
      durationMs: durationMs(task),
      logs: task.logs.slice(-120)
    };
  }

  function list() {
    return tasks;
  }

  function hasRunningScript(scriptId) {
    return tasks.some((task) => task.scriptId === scriptId && isActiveTask(task));
  }

  function startProcessTask({ type, label, person, command, args, scriptId = "", refreshHints = [], invalidates = [], onDone, onStdout }) {
    const preparedProcess = prepareProcess({ command, args });
    command = preparedProcess.command;
    args = preparedProcess.args;
    const task = {
      id: `task_${++seq}`,
      type,
      scriptId,
      label,
      personId: person?.id || "",
      personName: person?.name || "",
      status: "running",
      exitCode: null,
      pid: null,
      child: null,
      stopRequested: false,
      refreshHints,
      invalidates,
      startedAt: new Date().toISOString(),
      finishedAt: "",
      logs: []
    };
    tasks.unshift(task);

    let outputFailed = false;
    function finish(code, signal) {
      task.exitCode = code;
      task.status = task.stopRequested && task.pid ? "stopped" : code === 0 && !outputFailed ? "done" : "error";
      task.finishedAt = new Date().toISOString();
      task.child = null;
      if (signal) pushLog(task, `退出信号 ${signal}`);
      else if (code !== null) pushLog(task, `退出码 ${code}`);
      if (task.status === "done" && !callTaskHook(task, onTaskDone, "任务完成后刷新")) task.status = "error";
      if (!callTaskHook(task, onDone, "任务收尾")) task.status = "error";
      trimFinishedTasks(tasks, historyLimit);
      persist();
    }

    pushLog(task, commandPreview(command, args));
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        windowsHide: true,
        env: { ...process.env, ...preparedProcess.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }
      });
    } catch (error) {
      pushLog(task, error.message);
      finish(null, null);
      return task;
    }
    task.child = child;
    task.pid = child.pid || null;
    if (task.pid) pushLog(task, `PID ${task.pid}`);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pushLog(task, chunk);
      if (!outputFailed) outputFailed = !callTaskHook(task, onStdout, "任务输出处理", chunk);
    });
    child.stderr.on("data", (chunk) => pushLog(task, chunk));
    child.on("error", (error) => pushLog(task, error.message));
    child.once("close", finish);
    persist();

    return task;
  }

  function stopTask(taskId) {
    const task = tasks.find((item) => item.id === taskId);
    if (!task) {
      const error = new Error("任务不存在");
      error.statusCode = 404;
      throw error;
    }
    if (!task.child || !isActiveTask(task)) {
      const error = new Error("任务已经不在运行");
      error.statusCode = 400;
      throw error;
    }
    if (task.status === "stopping") return task;
    task.stopRequested = true;
    task.status = "stopping";
    pushLog(task, "收到停止请求");
    persist();
    const child = task.child;
    function stopFailed(message) {
      if (task.child !== child || child.exitCode !== null || child.signalCode !== null) return;
      task.stopRequested = false;
      task.status = "running";
      pushLog(task, `停止请求失败：${message}`);
      persist();
    }
    if (process.platform === "win32" && task.pid) {
      const killer = spawn("taskkill", ["/PID", String(task.pid), "/T", "/F"], { windowsHide: true });
      killer.stdout.on("data", (chunk) => pushLog(task, chunk));
      killer.stderr.on("data", (chunk) => pushLog(task, chunk));
      let launchError;
      killer.once("error", (error) => { launchError = error.message; });
      killer.once("close", (code, signal) => {
        if (code !== 0) stopFailed(launchError || `taskkill 退出 ${code ?? signal}`);
      });
    } else if (!child.kill("SIGTERM")) {
      stopFailed("未能向任务进程发送停止信号");
    }
    return task;
  }

  return {
    hasRunningScript,
    historyLimit,
    list,
    publicTask,
    startProcessTask,
    stopTask,
    summary
  };
}
