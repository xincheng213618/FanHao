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

function normalizedPathKey(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const normalized = path.normalize(text).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizedCreatePerson(value) {
  if (!value || typeof value !== "object") return null;
  return {
    name: String(value.name || "").trim(),
    displayName: String(value.displayName || "").trim(),
    folderName: String(value.folderName || "").trim(),
    rootPath: normalizedPathKey(value.rootPath || value.root),
    actorUrl: String(value.javdbUrl || value.actorUrl || "").trim(),
    gender: String(value.gender || "").trim().toLowerCase(),
    aliases: [...new Set((Array.isArray(value.aliases) ? value.aliases : [])
      .map((alias) => String(alias || "").trim())
      .filter(Boolean))].sort((left, right) => left.localeCompare(right))
  };
}

function requestKey(workId, body) {
  const explicit = String(body?.idempotencyKey || body?.requestId || "").trim();
  const request = stableValue({
    workId: String(workId || ""),
    personId: String(body?.personId || "").trim(),
    targetDirectory: normalizedPathKey(body?.targetDirectory || body?.targetPath),
    createPerson: normalizedCreatePerson(body?.createPerson)
  });
  const identity = explicit ? { clientKey: explicit.slice(0, 180), request } : { request };
  const digest = crypto.createHash("sha256").update(JSON.stringify(stableValue(identity))).digest("hex");
  return `${explicit ? "client" : "derived"}:${digest}`;
}

export function createWorkMoveJobService({
  adminCoreMutationService,
  checkpointIntervalMs = 200,
  getCoreDb,
  leaseDurationMs = 30_000,
  maxConcurrentJobs = 1,
  now = () => new Date().toISOString(),
  schedule = setImmediate,
  workerClass = Worker,
  workerDataPatch = {},
  workerUrl = new URL("./work-move-worker.js", import.meta.url)
}) {
  const ownerId = `move-owner-${crypto.randomUUID()}`;
  const activeRuns = new Map();
  const activeWorkers = new Map();
  const pendingJobs = new Set();
  const claimRetryTimers = new Map();
  const fencedJobs = new Set();
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
        finished_at TEXT NOT NULL DEFAULT '',
        owner_id TEXT NOT NULL DEFAULT '',
        lease_until TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_work_move_jobs_status_updated ON work_move_jobs(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_work_move_jobs_work ON work_move_jobs(work_id, updated_at);
    `);
    ensureColumn("owner_id", "ALTER TABLE work_move_jobs ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''");
    ensureColumn("lease_until", "ALTER TABLE work_move_jobs ADD COLUMN lease_until TEXT NOT NULL DEFAULT ''");
    ensureColumn("version", "ALTER TABLE work_move_jobs ADD COLUMN version INTEGER NOT NULL DEFAULT 0");
  }

  function ensureColumn(name, statement) {
    const hasColumn = () => getCoreDb().prepare("PRAGMA table_info(work_move_jobs)").all().some((column) => column.name === name);
    if (hasColumn()) return;
    try {
      getCoreDb().exec(statement);
    } catch (error) {
      if (!hasColumn()) throw error;
    }
  }

  function leaseUntil() {
    return new Date(Date.now() + Math.max(2_000, Number(leaseDurationMs || 30_000))).toISOString();
  }

  function claimLostError() {
    const error = new Error("文件移动任务 lease 已被其他实例接管");
    error.code = "WORK_MOVE_LEASE_LOST";
    return error;
  }

  function fenceJob(jobId) {
    if (fencedJobs.has(jobId)) return;
    fencedJobs.add(jobId);
    activeWorkers.get(jobId)?.terminate().catch(() => {});
  }

  function failClaim(jobId) {
    fenceJob(jobId);
    throw claimLostError();
  }

  function isClaimLost(jobId, error) {
    return fencedJobs.has(jobId) || error?.code === "WORK_MOVE_LEASE_LOST";
  }

  function recoveryStatus(job) {
    if (job?.status === "rollback_pending" || job?.phase === "rollback") return "rollback_pending";
    if (job?.status === "cleanup_pending") return "cleanup_pending";
    if (["main_committed", "images", "images_committed", "reconciled", "cleanup"].includes(job?.phase)) return "cleanup_pending";
    return "queued";
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

  function scheduleClaimRetry(jobId) {
    if (closing || claimRetryTimers.has(jobId)) return;
    const timer = setTimeout(() => {
      claimRetryTimers.delete(jobId);
      scheduleJob(jobId);
    }, 250);
    timer.unref?.();
    claimRetryTimers.set(jobId, timer);
  }

  function claimJob(jobId) {
    const claimedAt = now();
    const result = getCoreDb().prepare(`
      UPDATE work_move_jobs
      SET owner_id = ?, lease_until = ?, version = version + 1, updated_at = ?
      WHERE id = ?
        AND status IN ('queued', 'running', 'cleanup_pending', 'rollback_pending')
        AND (owner_id = '' OR owner_id = ? OR lease_until = '' OR lease_until <= ?)
    `).run(ownerId, leaseUntil(), claimedAt, jobId, ownerId, claimedAt);
    if (Number(result.changes || 0) !== 1) return null;
    fencedJobs.delete(jobId);
    return row(jobId);
  }

  function renewLease(jobId) {
    const current = row(jobId);
    if (!current || current.owner_id !== ownerId) {
      fenceJob(jobId);
      return false;
    }
    const result = getCoreDb().prepare(`
      UPDATE work_move_jobs
      SET lease_until = ?, version = version + 1
      WHERE id = ? AND owner_id = ? AND version = ?
    `).run(leaseUntil(), jobId, ownerId, Number(current.version || 0));
    if (Number(result.changes || 0) !== 1) {
      fenceJob(jobId);
      return false;
    }
    return true;
  }

  function releaseClaim(jobId) {
    const current = row(jobId);
    if (!current) return;
    if (current.owner_id !== ownerId) {
      fenceJob(jobId);
      return;
    }
    const result = getCoreDb().prepare(`
      UPDATE work_move_jobs
      SET owner_id = '', lease_until = '', version = version + 1
      WHERE id = ? AND owner_id = ? AND version = ?
    `).run(jobId, ownerId, Number(current.version || 0));
    if (Number(result.changes || 0) !== 1) fenceJob(jobId);
  }

  function updatePlan(jobId, plan) {
    const current = row(jobId);
    if (!current || current.owner_id !== ownerId) failClaim(jobId);
    const result = getCoreDb().prepare(`
      UPDATE work_move_jobs
      SET person_id = ?, plan_json = ?, status = 'running', phase = 'prepared',
          updated_at = ?, lease_until = ?, version = version + 1
      WHERE id = ? AND owner_id = ? AND version = ?
    `).run(String(plan.personId), JSON.stringify(plan), now(), leaseUntil(), jobId, ownerId, Number(current.version || 0));
    if (Number(result.changes || 0) !== 1) failClaim(jobId);
  }

  function updatePlanCheckpoint(jobId, plan) {
    const current = row(jobId);
    if (!current || current.owner_id !== ownerId) failClaim(jobId);
    const result = getCoreDb().prepare(`
      UPDATE work_move_jobs
      SET plan_json = ?, updated_at = ?, lease_until = ?, version = version + 1
      WHERE id = ? AND owner_id = ? AND version = ?
    `).run(JSON.stringify(plan), now(), leaseUntil(), jobId, ownerId, Number(current.version || 0));
    if (Number(result.changes || 0) !== 1) failClaim(jobId);
  }

  function hydratePlanRoots(plan) {
    if (typeof adminCoreMutationService.hydrateWorkMovePlanRoots !== "function") {
      throw new Error("服务未提供可信资料库根目录校验，拒绝恢复文件移动任务");
    }
    const hydrated = adminCoreMutationService.hydrateWorkMovePlanRoots(plan);
    if (!Array.isArray(hydrated?.libraryRoots) || !hydrated.libraryRoots.length) {
      throw new Error("文件移动计划缺少可信资料库根目录，拒绝执行");
    }
    return hydrated;
  }

  function assertSourceUnshared(plan) {
    if (typeof adminCoreMutationService.assertWorkMoveSourceUnshared !== "function") {
      throw new Error("服务未提供共享源目录复检，拒绝继续文件移动任务");
    }
    return adminCoreMutationService.assertWorkMoveSourceUnshared(plan);
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
    job = claimJob(jobId);
    if (!job) {
      if (ACTIVE_STATUSES.has(row(jobId)?.status)) scheduleClaimRetry(jobId);
      return;
    }
    const heartbeat = setInterval(() => renewLease(jobId), Math.max(250, Math.floor(Number(leaseDurationMs || 30_000) / 3)));
    heartbeat.unref?.();
    let plan = json(job.plan_json, null);
    const request = json(job.request_json, {});
    try {
      if (job.status === "rollback_pending" && !plan) {
        updateState(jobId, "failed", "validation", "回滚任务缺少持久化路径计划，拒绝执行", { finished: true });
        return;
      }
      if (plan) {
        try {
          const hydratedPlan = hydratePlanRoots(plan);
          if (JSON.stringify(hydratedPlan) !== JSON.stringify(plan)) updatePlanCheckpoint(jobId, hydratedPlan);
          plan = hydratedPlan;
        } catch (error) {
          updateState(jobId, "failed", "validation", error.message || String(error), { finished: true });
          return;
        }
      }
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
        try {
          plan = hydratePlanRoots(plan);
        } catch (error) {
          updateState(jobId, "failed", "validation", error.message || String(error), { finished: true });
          return;
        }
        updatePlan(jobId, plan);
      }

      const databaseState = adminCoreMutationService.inspectWorkMove(plan);
      const persistedResult = json(job.result_json, null);
      let moveResult = persistedResult?.move || (persistedResult?.moveMode ? { mode: persistedResult.moveMode } : null);
      if (databaseState === "source") {
        updateState(jobId, "running", "copying", "");
        moveResult = await runWorker(jobId, "stage", plan);
        updateState(jobId, "running", "filesystem_ready", "", { result: { move: moveResult } });
        adminCoreMutationService.commitWorkMove(plan);
        updateState(jobId, "running", "main_committed", "", { result: { move: moveResult } });
      } else if (databaseState !== "target") {
        throw new Error("SQLite 中的作品路径已被其他操作修改，拒绝继续移动");
      }

      assertSourceUnshared(plan);
      if (adminCoreMutationService.inspectWorkMoveImages(plan) !== "completed") {
        updateState(jobId, "running", "images", "", { result: { move: moveResult } });
        adminCoreMutationService.commitWorkMoveImages(plan);
      }
      if (adminCoreMutationService.inspectWorkMoveImages(plan) !== "completed") {
        throw new Error("图片库路径补偿尚未完成，拒绝清理源目录");
      }
      updateState(jobId, "running", "images_committed", "", { result: { move: moveResult } });
      assertSourceUnshared(plan);

      const result = adminCoreMutationService.finalizeWorkMove(plan, moveResult || {});
      updateState(jobId, "cleanup_pending", "reconciled", "", { result });
      updateState(jobId, "cleanup_pending", "cleanup", "", { result });
      assertSourceUnshared(plan);
      await runWorker(jobId, "isolate", plan);
      try {
        assertSourceUnshared(plan);
      } catch (error) {
        try {
          await runWorker(jobId, "restore", plan);
        } catch (restoreError) {
          error.message = `${error.message}; 隔离源目录恢复失败：${restoreError.message}`;
        }
        throw error;
      }
      await runWorker(jobId, "cleanup", plan);
      updateState(jobId, "completed", "completed", "", { result, finished: true, completeProgress: true });
    } catch (error) {
      if (isClaimLost(jobId, error)) return;
      if (closing) {
        preserveForRecovery(jobId);
        return;
      }
      await handleFailure(jobId, plan, error);
    } finally {
      clearInterval(heartbeat);
      releaseClaim(jobId);
    }
  }

  async function handleFailure(jobId, plan, error) {
    const message = error?.message || String(error);
    if (plan && adminCoreMutationService.inspectWorkMove(plan) === "target") {
      updateState(jobId, "cleanup_pending", row(jobId)?.phase || "main_committed", message);
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
      if (isClaimLost(jobId, rollbackError)) return;
      if (closing) {
        preserveForRecovery(jobId);
        return;
      }
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
          allowedRoots: Array.isArray(plan.libraryRoots) ? plan.libraryRoots : [],
          sourcePath: plan.oldDir,
          targetPath: plan.newDir,
          stagingPath: plan.stagingDir || `${plan.newDir}.fanhao-move-${jobId}`,
          quarantinePath: plan.quarantineDir || path.join(path.dirname(plan.oldDir), `.${path.basename(plan.oldDir)}.fanhao-quarantine-${jobId}`)
        }
      });
      activeWorkers.set(jobId, worker);
      let settled = false;
      let pendingProgress = null;
      let progressTimer = null;
      const flushProgress = () => {
        progressTimer = null;
        if (!pendingProgress || closing) return null;
        const progress = pendingProgress;
        pendingProgress = null;
        const current = row(jobId);
        if (!current || current.owner_id !== ownerId) {
          fenceJob(jobId);
          return claimLostError();
        }
        const result = getCoreDb().prepare(`
          UPDATE work_move_jobs
          SET phase = ?, progress_files = ?, total_files = ?, progress_bytes = ?, total_bytes = ?,
              updated_at = ?, lease_until = ?, version = version + 1
          WHERE id = ? AND owner_id = ? AND version = ?
        `).run(progress.phase || operation, progress.completedFiles || 0, progress.totalFiles || 0, progress.completedBytes || 0, progress.totalBytes || 0, now(), leaseUntil(), jobId, ownerId, Number(current.version || 0));
        if (Number(result.changes || 0) !== 1) {
          fenceJob(jobId);
          return claimLostError();
        }
        return null;
      };
      const finish = (callback, value, skipFlush = false) => {
        if (settled) return;
        settled = true;
        if (progressTimer) clearTimeout(progressTimer);
        const flushError = skipFlush ? null : flushProgress();
        activeWorkers.delete(jobId);
        if (flushError) reject(flushError);
        else callback(value);
      };
      worker.on("message", (message) => {
        if (fencedJobs.has(jobId) || row(jobId)?.owner_id !== ownerId) {
          fenceJob(jobId);
          finish(reject, claimLostError(), true);
          return;
        }
        if (message?.type === "progress") {
          pendingProgress = message;
          if (!progressTimer) {
            progressTimer = setTimeout(() => {
              const flushError = flushProgress();
              if (flushError) finish(reject, flushError, true);
            }, checkpointIntervalMs);
          }
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
        if (!settled) {
          const detail = code === 0 ? "后台文件操作已退出但没有返回完成消息" : `后台文件操作异常退出：${code}`;
          finish(reject, new Error(detail));
        }
      });
    });
  }

  function updateState(jobId, status, phase, error, options = {}) {
    const current = row(jobId);
    if (!current || current.owner_id !== ownerId) failClaim(jobId);
    const resultJson = options.result === undefined ? current.result_json : JSON.stringify(options.result);
    const finishedAt = options.finished ? now() : "";
    const progressFiles = options.completeProgress ? Math.max(Number(current.progress_files || 0), Number(current.total_files || 0)) : Number(current.progress_files || 0);
    const progressBytes = options.completeProgress ? Math.max(Number(current.progress_bytes || 0), Number(current.total_bytes || 0)) : Number(current.progress_bytes || 0);
    const result = getCoreDb().prepare(`
      UPDATE work_move_jobs
      SET status = ?, phase = ?, error = ?, result_json = ?, progress_files = ?, progress_bytes = ?,
          updated_at = ?, finished_at = ?, lease_until = ?, version = version + 1
      WHERE id = ? AND owner_id = ? AND version = ?
    `).run(status, phase, String(error || ""), resultJson, progressFiles, progressBytes, now(), finishedAt, leaseUntil(), jobId, ownerId, Number(current.version || 0));
    if (Number(result.changes || 0) !== 1) failClaim(jobId);
  }

  function preserveForRecovery(jobId) {
    const current = row(jobId);
    if (!current || current.owner_id !== ownerId) {
      fenceJob(jobId);
      return;
    }
    try {
      updateState(jobId, recoveryStatus(current), current.phase || "queued", "服务停止，等待自动恢复");
    } catch (error) {
      if (!isClaimLost(jobId, error)) throw error;
    }
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
    for (const timer of claimRetryTimers.values()) clearTimeout(timer);
    claimRetryTimers.clear();
    const terminations = [];
    for (const [jobId, worker] of activeWorkers) {
      preserveForRecovery(jobId);
      terminations.push(worker.terminate().catch(() => {}));
    }
    await Promise.allSettled(terminations);
    await Promise.allSettled([...activeRuns.values()]);
  }

  return { close, get, publicJob, recover, retry, start };
}
