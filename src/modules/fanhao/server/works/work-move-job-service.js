import crypto from "node:crypto";
import path from "node:path";
import { Worker } from "node:worker_threads";

const ACTIVE_STATUSES = new Set(["queued", "running", "cleanup_pending", "rollback_pending"]);
function json(value, fallback = null) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function requestKey(workId, body) {
  const explicit = String(body?.idempotencyKey || body?.requestId || "").trim();
  if (explicit) return `client:${explicit.slice(0, 180)}`;
  const identity = stableValue({
    workId: String(workId || ""),
    personId: String(body?.personId || ""),
    targetDirectory: String(body?.targetDirectory || body?.targetPath || ""),
    createPerson: body?.createPerson || null
  });
  return `derived:${crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

export function createWorkMoveJobService({
  adminCoreMutationService,
  checkpointIntervalMs = 200,
  getCoreDb,
  maxConcurrentJobs = 1,
  now = () => new Date().toISOString(),
  schedule = setImmediate,
  workerClass = Worker,
  workerDataPatch = {},
  workerUrl = new URL("./work-move-worker.js", import.meta.url)
}) {
  const activeRuns = new Map();
  const activeWorkers = new Map();
  const pendingJobs = new Set();
  let closing = false;
  ensureSchema();
  schedule(recover);

  function ensureSchema() {
    getCoreDb().exec(`
      CREATE TABLE IF NOT EXISTS work_move_jobs (
        id TEXT PRIMARY KEY,
        request_key TEXT NOT NULL UNIQUE,
        work_id TEXT NOT NULL,
        person_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        request_json TEXT NOT NULL,
        plan_json TEXT NOT NULL DEFAULT '',
        result_json TEXT NOT NULL DEFAULT '',
        progress_files INTEGER NOT NULL DEFAULT 0,
        total_files INTEGER NOT NULL DEFAULT 0,
        progress_bytes INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_work_move_jobs_status_updated ON work_move_jobs(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_work_move_jobs_work ON work_move_jobs(work_id, updated_at);
    `);
  }

  function row(jobId) {
    return getCoreDb().prepare("SELECT * FROM work_move_jobs WHERE id = ?").get(String(jobId || "")) || null;
  }

  function publicJob(job) {
    if (!job) return null;
    const result = json(job.result_json, null);
    const totalBytes = Number(job.total_bytes || 0);
    const totalFiles = Number(job.total_files || 0);
    const progressBytes = Number(job.progress_bytes || 0);
    const progressFiles = Number(job.progress_files || 0);
    const progress = totalBytes > 0
      ? Math.min(1, progressBytes / totalBytes)
      : totalFiles > 0
        ? Math.min(1, progressFiles / totalFiles)
        : job.status === "completed" ? 1 : 0;
    return {
      id: job.id,
      workId: job.work_id,
      personId: job.person_id || "",
      status: job.status,
      phase: job.phase,
      progress,
      progressFiles,
      totalFiles,
      progressBytes,
      totalBytes,
      attempts: Number(job.attempts || 0),
      error: job.error || "",
      createdAt: job.created_at,
      updatedAt: job.updated_at,
      finishedAt: job.finished_at || "",
      recoverable: ACTIVE_STATUSES.has(job.status) || ["rolled_back", "failed"].includes(job.status),
      result
    };
  }

  function get(jobId) {
    const job = row(jobId);
    if (!job) {
      const error = new Error("文件移动任务不存在");
      error.statusCode = 404;
      throw error;
    }
    return publicJob(job);
  }

  function start(workId, body = {}) {
    const normalizedWorkId = String(workId || "").trim();
    if (!normalizedWorkId) {
      const error = new Error("作品编号无效");
      error.statusCode = 400;
      throw error;
    }
    if (!body.personId && !body.createPerson) {
      const error = new Error("请选择目标人物");
      error.statusCode = 400;
      throw error;
    }
    const key = requestKey(normalizedWorkId, body);
    const db = getCoreDb();
    const existing = db.prepare("SELECT * FROM work_move_jobs WHERE request_key = ?").get(key);
    if (existing) {
      if (ACTIVE_STATUSES.has(existing.status) || existing.status === "completed") {
        schedule(() => scheduleJob(existing.id));
        return publicJob(existing);
      }
      const updatedAt = now();
      db.prepare(`
        UPDATE work_move_jobs
        SET status = CASE WHEN phase = 'cleanup' THEN 'cleanup_pending' WHEN phase = 'rollback' THEN 'rollback_pending' ELSE 'queued' END,
            phase = CASE WHEN phase IN ('cleanup', 'rollback') THEN phase ELSE 'queued' END,
            error = '', finished_at = '', attempts = attempts + 1, updated_at = ?
        WHERE id = ?
      `).run(updatedAt, existing.id);
      scheduleJob(existing.id);
      return publicJob(row(existing.id));
    }

    const conflicting = db.prepare(`
      SELECT * FROM work_move_jobs
      WHERE work_id = ? AND status IN ('queued', 'running', 'cleanup_pending', 'rollback_pending')
      ORDER BY created_at ASC LIMIT 1
    `).get(normalizedWorkId);
    if (conflicting) {
      const error = new Error(`这个作品已有迁移任务：${conflicting.id}`);
      error.statusCode = 409;
      error.job = publicJob(conflicting);
      throw error;
    }

    const id = `move_${crypto.randomUUID()}`;
    const createdAt = now();
    db.prepare(`
      INSERT INTO work_move_jobs (
        id, request_key, work_id, person_id, status, phase, request_json,
        attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'queued', 'queued', ?, 1, ?, ?)
    `).run(id, key, normalizedWorkId, String(body.personId || ""), JSON.stringify(body), createdAt, createdAt);
    scheduleJob(id);
    return publicJob(row(id));
  }

  function retry(jobId) {
    const job = row(jobId);
    if (!job) return get(jobId);
    if (job.status === "completed" || ACTIVE_STATUSES.has(job.status)) {
      schedule(() => scheduleJob(job.id));
      return publicJob(job);
    }
    getCoreDb().prepare(`
      UPDATE work_move_jobs
      SET status = CASE WHEN phase = 'cleanup' THEN 'cleanup_pending' WHEN phase = 'rollback' THEN 'rollback_pending' ELSE 'queued' END,
          phase = CASE WHEN phase IN ('cleanup', 'rollback') THEN phase ELSE 'queued' END,
          error = '', finished_at = '', attempts = attempts + 1, updated_at = ?
      WHERE id = ?
    `).run(now(), job.id);
    scheduleJob(job.id);
    return publicJob(row(job.id));
  }

  function scheduleJob(jobId) {
    if (closing || activeRuns.has(jobId) || pendingJobs.has(jobId)) return;
    pendingJobs.add(jobId);
    pumpQueue();
  }

  function pumpQueue() {
    if (closing || activeRuns.size >= Math.max(1, Number(maxConcurrentJobs || 1))) return;
    const jobId = pendingJobs.values().next().value;
    if (!jobId) return;
    pendingJobs.delete(jobId);
    const run = Promise.resolve()
      .then(() => runJob(jobId))
      .catch((error) => console.warn("[work-move-job]", error?.message || error))
      .finally(() => {
        activeRuns.delete(jobId);
        pumpQueue();
      });
    activeRuns.set(jobId, run);
  }

  async function runJob(jobId) {
    let job = row(jobId);
    if (!job || job.status === "completed" || closing) return;
    let plan = json(job.plan_json, null);
    const request = json(job.request_json, {});
    try {
      if (job.status === "rollback_pending" && plan) {
        await runWorker(jobId, "rollback", plan);
        updateState(jobId, "rolled_back", "rolled_back", job.error || "上次操作已回滚", { finished: true });
        return;
      }
      if (!plan) {
        plan = adminCoreMutationService.prepareWorkMove(job.work_id, request.personId, {
          targetDirectory: request.targetDirectory || request.targetPath || "",
          createPerson: request.createPerson || null
        });
        getCoreDb().prepare(`
          UPDATE work_move_jobs
          SET person_id = ?, plan_json = ?, status = 'running', phase = 'prepared', updated_at = ?
          WHERE id = ?
        `).run(String(plan.personId), JSON.stringify(plan), now(), jobId);
      }

      const databaseState = adminCoreMutationService.inspectWorkMove(plan);
      let moveResult = json(job.result_json, null)?.move || null;
      if (databaseState === "source") {
        updateState(jobId, "running", "copying", "");
        moveResult = await runWorker(jobId, "stage", plan);
        updateState(jobId, "running", "filesystem_ready", "", { result: { move: moveResult } });
        adminCoreMutationService.commitWorkMove(plan);
      } else if (databaseState !== "target") {
        throw new Error("SQLite 中的作品路径已被其他操作修改，拒绝继续移动");
      }

      updateState(jobId, "cleanup_pending", "cleanup", "", { result: { move: moveResult } });
      await runWorker(jobId, "cleanup", plan);
      const result = adminCoreMutationService.finalizeWorkMove(plan, moveResult || {});
      updateState(jobId, "completed", "completed", "", { result, finished: true, completeProgress: true });
    } catch (error) {
      if (closing) {
        updateState(jobId, "queued", row(jobId)?.phase || "queued", "服务停止，等待自动恢复");
        return;
      }
      await handleFailure(jobId, plan, error);
    }
  }

  async function handleFailure(jobId, plan, error) {
    const message = error?.message || String(error);
    if (plan && adminCoreMutationService.inspectWorkMove(plan) === "target") {
      updateState(jobId, "cleanup_pending", "cleanup", message);
      return;
    }
    if (!plan) {
      updateState(jobId, "failed", "validation", message, { finished: true });
      return;
    }
    updateState(jobId, "rollback_pending", "rollback", message);
    try {
      await runWorker(jobId, "rollback", plan);
      updateState(jobId, "rolled_back", "rolled_back", message, { finished: true });
    } catch (rollbackError) {
      updateState(jobId, "failed", "rollback", `${message}; 自动回滚失败：${rollbackError.message}`, { finished: true });
    }
  }

  function runWorker(jobId, operation, plan) {
    return new Promise((resolve, reject) => {
      const worker = new workerClass(workerUrl, {
        workerData: {
          ...workerDataPatch,
          jobId,
          operation,
          sourcePath: plan.oldDir,
          targetPath: plan.newDir,
          stagingPath: plan.stagingDir || `${plan.newDir}.fanhao-move-${jobId}`
        }
      });
      activeWorkers.set(jobId, worker);
      let settled = false;
      let pendingProgress = null;
      let progressTimer = null;
      const flushProgress = () => {
        progressTimer = null;
        if (!pendingProgress || closing) return;
        const progress = pendingProgress;
        pendingProgress = null;
        getCoreDb().prepare(`
          UPDATE work_move_jobs
          SET phase = ?, progress_files = ?, total_files = ?, progress_bytes = ?, total_bytes = ?, updated_at = ?
          WHERE id = ?
        `).run(progress.phase || operation, progress.completedFiles || 0, progress.totalFiles || 0, progress.completedBytes || 0, progress.totalBytes || 0, now(), jobId);
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (progressTimer) clearTimeout(progressTimer);
        flushProgress();
        activeWorkers.delete(jobId);
        callback(value);
      };
      worker.on("message", (message) => {
        if (message?.type === "progress") {
          pendingProgress = message;
          if (!progressTimer) progressTimer = setTimeout(flushProgress, checkpointIntervalMs);
        } else if (message?.type === "done") {
          finish(resolve, message.result || {});
        } else if (message?.type === "error") {
          const workerError = new Error(message.error?.message || "后台文件操作失败");
          workerError.code = message.error?.code || "";
          finish(reject, workerError);
        }
      });
      worker.on("error", (error) => finish(reject, error));
      worker.on("exit", (code) => {
        if (!settled && code !== 0) finish(reject, new Error(`后台文件操作异常退出：${code}`));
      });
    });
  }

  function updateState(jobId, status, phase, error, options = {}) {
    const current = row(jobId);
    if (!current) return;
    const resultJson = options.result === undefined ? current.result_json : JSON.stringify(options.result);
    const finishedAt = options.finished ? now() : "";
    const progressFiles = options.completeProgress ? Math.max(Number(current.progress_files || 0), Number(current.total_files || 0)) : Number(current.progress_files || 0);
    const progressBytes = options.completeProgress ? Math.max(Number(current.progress_bytes || 0), Number(current.total_bytes || 0)) : Number(current.progress_bytes || 0);
    getCoreDb().prepare(`
      UPDATE work_move_jobs
      SET status = ?, phase = ?, error = ?, result_json = ?, progress_files = ?, progress_bytes = ?,
          updated_at = ?, finished_at = ?
      WHERE id = ?
    `).run(status, phase, String(error || ""), resultJson, progressFiles, progressBytes, now(), finishedAt, jobId);
  }

  function recover() {
    if (closing) return;
    const jobs = getCoreDb().prepare(`
      SELECT id FROM work_move_jobs
      WHERE status IN ('queued', 'running', 'cleanup_pending', 'rollback_pending')
      ORDER BY created_at ASC
    `).all();
    for (const job of jobs) scheduleJob(job.id);
  }

  async function close() {
    closing = true;
    pendingJobs.clear();
    const terminations = [];
    for (const [jobId, worker] of activeWorkers) {
      updateState(jobId, "queued", row(jobId)?.phase || "queued", "服务停止，等待自动恢复");
      terminations.push(worker.terminate().catch(() => {}));
    }
    await Promise.allSettled(terminations);
    await Promise.allSettled([...activeRuns.values()]);
  }

  return { close, get, publicJob, recover, retry, start };
}
