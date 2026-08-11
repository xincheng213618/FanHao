import crypto from "node:crypto";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { listWorkMoveJobs } from "./work-move-job-query-service.js";

const ACTIVE_STATUSES = new Set(["queued", "running", "cleanup_pending", "rollback_pending"]);
const BLOCKING_STATUSES = new Set([...ACTIVE_STATUSES, "blocked"]);
function json(value, fallback = null) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function isSqliteBusy(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || error || "").toLowerCase();
  return code.includes("SQLITE_BUSY") || message.includes("database is locked") || message.includes("database is busy");
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
    // An Android command has a stricter durable target policy than the
    // desktop command.  It must never idempotently reuse a desktop journal
    // row that was prepared with an explicit target directory.
    ...(body?.androidCommand === true ? { androidCommand: true } : {}),
    targetDirectory: normalizedPathKey(body?.targetDirectory || body?.targetPath),
    createPerson: normalizedCreatePerson(body?.createPerson)
  });
  const identity = explicit ? { clientKey: explicit.slice(0, 180), request } : { request };
  const digest = crypto.createHash("sha256").update(JSON.stringify(stableValue(identity))).digest("hex");
  return `${explicit ? "client" : "derived"}:${digest}`;
}

export function createWorkMoveJobService({
  adminCoreMutationService,
  beforeCleanup = null,
  checkpointIntervalMs = 200,
  getCoreDb,
  leaseDurationMs = 30_000,
  handoffTimeoutMs = leaseDurationMs,
  log = null,
  maxConcurrentJobs = 1,
  now = () => new Date().toISOString(),
  schedule = setImmediate,
  warn = console.warn,
  workerClass = Worker,
  workerDataPatch = {},
  workerUrl = new URL("./work-move-worker.js", import.meta.url)
}) {
  const ownerId = `move-owner-${process.pid}-${crypto.randomUUID()}`;
  const activeRuns = new Map();
  const activeWorkers = new Map();
  const activePlans = new Map();
  const pendingJobs = new Set();
  const claimRetryTimers = new Map();
  const claimRetryAttempts = new Map();
  const fencedJobs = new Set();
  const workerTerminationPromises = new Map();
  let closing = false;
  ensureSchema();
  adminCoreMutationService.repairWorkMoveReservations?.();
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
        error_code TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT NOT NULL DEFAULT '',
        owner_id TEXT NOT NULL DEFAULT '',
        lease_until TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 0,
        handoff_from TEXT NOT NULL DEFAULT '',
        handoff_ack TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_work_move_jobs_status_updated ON work_move_jobs(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_work_move_jobs_work ON work_move_jobs(work_id, updated_at);
    `);
    ensureColumn("owner_id", "ALTER TABLE work_move_jobs ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''");
    ensureColumn("lease_until", "ALTER TABLE work_move_jobs ADD COLUMN lease_until TEXT NOT NULL DEFAULT ''");
    ensureColumn("version", "ALTER TABLE work_move_jobs ADD COLUMN version INTEGER NOT NULL DEFAULT 0");
    ensureColumn("handoff_from", "ALTER TABLE work_move_jobs ADD COLUMN handoff_from TEXT NOT NULL DEFAULT ''");
    ensureColumn("handoff_ack", "ALTER TABLE work_move_jobs ADD COLUMN handoff_ack TEXT NOT NULL DEFAULT ''");
    ensureColumn("error_code", "ALTER TABLE work_move_jobs ADD COLUMN error_code TEXT NOT NULL DEFAULT ''");
    migrateActiveJobUniqueness();
  }

  function migrateActiveJobUniqueness() {
    const db = getCoreDb();
    const changedAt = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      const groups = db.prepare(`
        SELECT work_id FROM work_move_jobs
        WHERE status IN ('queued', 'running', 'cleanup_pending', 'rollback_pending', 'blocked')
        GROUP BY work_id HAVING COUNT(*) > 1
      `).all();
      for (const group of groups) {
        const rows = db.prepare(`
          SELECT * FROM work_move_jobs
          WHERE work_id = ? AND status IN ('queued', 'running', 'cleanup_pending', 'rollback_pending', 'blocked')
          ORDER BY created_at, id
        `).all(group.work_id);
        const progressed = rows.filter((row) => String(row.plan_json || "").trim() || !["queued", "prepared"].includes(String(row.phase || "")));
        const survivor = progressed.length === 1 ? progressed[0] : rows[0];
        if (progressed.length > 1) {
          db.prepare(`
            UPDATE work_move_jobs
            SET status = 'blocked', phase = 'duplicate_conflict',
                error = '检测到多个已开始的 legacy 迁移任务，已停止自动执行',
                owner_id = '', lease_until = '', updated_at = ?
            WHERE id = ?
          `).run(changedAt, survivor.id);
        }
        db.prepare(`
          UPDATE work_move_jobs
          SET status = 'failed', phase = 'duplicate_superseded',
              error = ?, owner_id = '', lease_until = '', finished_at = ?, updated_at = ?
          WHERE work_id = ? AND id <> ?
            AND status IN ('queued', 'running', 'cleanup_pending', 'rollback_pending', 'blocked')
        `).run(
          progressed.length > 1
            ? `legacy 重复任务冲突；保留阻断任务 ${survivor.id} 等待人工处理`
            : `legacy 重复任务已确定性归并到 ${survivor.id}`,
          changedAt,
          changedAt,
          group.work_id,
          survivor.id
        );
      }
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_work_move_jobs_one_active_work
        ON work_move_jobs(work_id)
        WHERE status IN ('queued', 'running', 'cleanup_pending', 'rollback_pending', 'blocked')
      `);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
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

  async function acknowledgeFencedOwner(jobId, fencedOwner = ownerId) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        getCoreDb().prepare(`
          UPDATE work_move_jobs
          SET handoff_ack = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND handoff_from = ? AND owner_id <> ?
        `).run(fencedOwner, now(), jobId, fencedOwner, fencedOwner);
        return;
      } catch (error) {
        if (!isSqliteBusy(error) || attempt === 5) return;
        await new Promise((resolve) => setTimeout(resolve, Math.min(500, 25 * (2 ** attempt))));
      }
    }
  }

  function fenceJob(jobId) {
    if (workerTerminationPromises.has(jobId)) return workerTerminationPromises.get(jobId);
    fencedJobs.add(jobId);
    const worker = activeWorkers.get(jobId);
    const termination = Promise.resolve(worker ? worker.terminate() : undefined)
      .catch(() => undefined)
      .then(() => acknowledgeFencedOwner(jobId));
    workerTerminationPromises.set(jobId, termination);
    return termination;
  }

  async function awaitFencedWorker(jobId) {
    await (workerTerminationPromises.get(jobId) || Promise.resolve());
  }

  function ownerProcessId(value) {
    const match = /^move-owner-(\d+)-/.exec(String(value || ""));
    return match ? Number(match[1]) : 0;
  }

  function processIsAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function awaitSafeHandoff(jobId, claimedJob) {
    const previousOwner = String(claimedJob?.handoff_from || "");
    if (!previousOwner || previousOwner === ownerId) return;
    const previousPid = ownerProcessId(previousOwner);
    const handoffDeadline = Date.now() + Math.max(50, Number(handoffTimeoutMs || leaseDurationMs || 30_000));
    while (!closing) {
      if (fencedJobs.has(jobId)) throw claimLostError();
      try {
        const current = row(jobId);
        if (!current || current.owner_id !== ownerId) {
          if (ACTIVE_STATUSES.has(current?.status)) scheduleClaimRetry(jobId);
          failClaim(jobId);
        }
        if (String(current.handoff_ack || "") === previousOwner) return;
        if ((previousPid && !processIsAlive(previousPid)) || (!previousPid && Date.now() >= handoffDeadline)) {
          const result = getCoreDb().prepare(`
            UPDATE work_move_jobs
            SET handoff_ack = ?, updated_at = ?, version = version + 1
            WHERE id = ? AND owner_id = ? AND version = ?
              AND status IN ('queued', 'running', 'cleanup_pending', 'rollback_pending')
              AND handoff_from = ? AND handoff_ack <> ?
          `).run(previousOwner, now(), jobId, ownerId, Number(current.version || 0), previousOwner, previousOwner);
          if (Number(result.changes || 0) !== 1) {
            const outcome = resolveHandoffCasMiss(jobId, previousOwner);
            if (outcome === "ready") return;
            if (outcome === "retry") continue;
          }
          return;
        }
        if (previousPid && Date.now() >= handoffDeadline) {
          const errorCode = "WORK_MOVE_HANDOFF_TIMEOUT";
          const message = "旧迁移 owner 的进程标识仍存活，但未确认停止；为防止双重文件操作，任务已阻断等待人工处理";
          const timestamp = now();
          const result = getCoreDb().prepare(`
            UPDATE work_move_jobs
            SET status = 'blocked', phase = 'handoff_timeout', error = ?, error_code = ?,
                updated_at = ?, finished_at = ?, lease_until = ?, version = version + 1
            WHERE id = ? AND owner_id = ? AND version = ?
              AND status IN ('queued', 'running', 'cleanup_pending', 'rollback_pending')
              AND handoff_from = ? AND handoff_ack <> ?
          `).run(message, errorCode, timestamp, timestamp, leaseUntil(), jobId, ownerId, Number(current.version || 0), previousOwner, previousOwner);
          if (Number(result.changes || 0) === 1) {
            emitLifecycle("blocked", row(jobId), { errorCode });
            return false;
          }
          const outcome = resolveHandoffCasMiss(jobId, previousOwner);
          if (outcome === "ready") return;
          if (outcome === "retry") continue;
        }
      } catch (error) {
        if (!isSqliteBusy(error)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw claimLostError();
  }

  function resolveHandoffCasMiss(jobId, previousOwner) {
    const current = row(jobId);
    const stillOwnedActive = current?.owner_id === ownerId && ACTIVE_STATUSES.has(current.status);
    if (stillOwnedActive && String(current.handoff_ack || "") === previousOwner) return "ready";
    if (stillOwnedActive && String(current.handoff_from || "") === previousOwner) return "retry";
    if (ACTIVE_STATUSES.has(current?.status)) scheduleClaimRetry(jobId);
    failClaim(jobId);
  }

  function emitLifecycle(event, job, details = {}) {
    if (typeof log !== "function") return;
    const payload = {
      event,
      jobId: String(job?.id || ""),
      workId: String(job?.work_id || job?.workId || ""),
      status: String(job?.status || ""),
      phase: String(job?.phase || ""),
      attempts: Number(job?.attempts || 0),
      ownerId: String(job?.owner_id || ""),
      errorCode: String(details.errorCode || job?.error_code || ""),
      at: now()
    };
    log(`[work-move] ${JSON.stringify(payload)}`);
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
    if (["main_committed", "images", "images_committed", "reconciled", "cleanup", "isolating", "verifying"].includes(job?.phase)) return "cleanup_pending";
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
      errorCode: job.error_code || "",
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

  function findForWork(workId, { idempotencyKey = "" } = {}) {
    const normalizedWorkId = String(workId || "").trim();
    if (!normalizedWorkId) return null;
    const clientKey = String(idempotencyKey || "").trim().slice(0, 180);
    const jobs = getCoreDb().prepare(`
      SELECT * FROM work_move_jobs
      WHERE work_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(normalizedWorkId);
    if (clientKey) {
      const exact = jobs.find((job) => String(json(job.request_json, {})?.idempotencyKey || json(job.request_json, {})?.requestId || "").trim().slice(0, 180) === clientKey);
      return exact ? publicJob(exact) : null;
    }
    const active = jobs.find((job) => BLOCKING_STATUSES.has(job.status));
    return active ? publicJob(active) : null;
  }

  function start(workId, body = {}, options = {}) {
    // Persist the origin policy with the durable command.  It is deliberately
    // not derived from a later HTTP request: recovery must keep enforcing the
    // Android-only target rule after a restart or a different server process.
    const requestBody = options.android ? { ...body, androidCommand: true } : body;
    const normalizedWorkId = String(workId || "").trim();
    if (!normalizedWorkId) {
      const error = new Error("作品编号无效");
      error.statusCode = 400;
      throw error;
    }
    if (!requestBody.personId && !requestBody.createPerson) {
      const error = new Error("请选择目标人物");
      error.statusCode = 400;
      throw error;
    }
    const key = requestKey(normalizedWorkId, requestBody);
    const db = getCoreDb();
    let scheduledId = "";
    let response = null;
    try {
      db.exec("BEGIN IMMEDIATE");
      const existing = db.prepare("SELECT * FROM work_move_jobs WHERE request_key = ?").get(key);
      if (existing && (BLOCKING_STATUSES.has(existing.status) || existing.status === "completed")) {
        response = publicJob(existing);
        if (ACTIVE_STATUSES.has(existing.status)) scheduledId = existing.id;
      } else if (existing) {
        const conflicting = db.prepare(`
          SELECT * FROM work_move_jobs
          WHERE work_id = ? AND id <> ?
            AND status IN ('queued', 'running', 'cleanup_pending', 'rollback_pending', 'blocked')
          ORDER BY created_at, id LIMIT 1
        `).get(normalizedWorkId, existing.id);
        if (conflicting) {
          const error = new Error(`这个作品已有迁移任务：${conflicting.id}`);
          error.statusCode = 409;
          error.job = publicJob(conflicting);
          throw error;
        }
        const updatedAt = now();
        db.prepare(`
          UPDATE work_move_jobs
          SET status = CASE WHEN phase IN ('cleanup', 'isolating', 'verifying') THEN 'cleanup_pending' WHEN phase = 'rollback' THEN 'rollback_pending' ELSE 'queued' END,
              phase = CASE WHEN phase IN ('cleanup', 'isolating', 'verifying', 'rollback') THEN phase ELSE 'queued' END,
              error = '', error_code = '', finished_at = '', attempts = attempts + 1, updated_at = ?
          WHERE id = ?
        `).run(updatedAt, existing.id);
        scheduledId = existing.id;
        response = publicJob(db.prepare("SELECT * FROM work_move_jobs WHERE id = ?").get(existing.id));
      } else {
        const conflicting = db.prepare(`
          SELECT * FROM work_move_jobs
          WHERE work_id = ? AND status IN ('queued', 'running', 'cleanup_pending', 'rollback_pending', 'blocked')
          ORDER BY created_at, id LIMIT 1
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
        `).run(id, key, normalizedWorkId, String(requestBody.personId || ""), JSON.stringify(requestBody), createdAt, createdAt);
        scheduledId = id;
        response = publicJob(db.prepare("SELECT * FROM work_move_jobs WHERE id = ?").get(id));
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      if (isSqliteBusy(error)) {
        error.statusCode = 503;
        error.message = "文件移动任务 journal 正忙，请稍后重试";
      }
      throw error;
    }
    if (scheduledId) schedule(() => scheduleJob(scheduledId));
    if (scheduledId) emitLifecycle("queued", row(scheduledId));
    return response;
  }

  function retry(jobId) {
    try {
      const job = row(jobId);
      if (!job) return get(jobId);
      if (job.status === "blocked") {
        const error = new Error(job.error || "迁移任务需要人工处理，不能自动重试");
        error.statusCode = 409;
        error.code = "WORK_MOVE_MANUAL_INTERVENTION_REQUIRED";
        error.job = publicJob(job);
        throw error;
      }
      if (job.status === "completed") return publicJob(job);
      const cleanupRetryRequired = job.status === "cleanup_pending" && Boolean(String(job.error_code || "").trim());
      if (ACTIVE_STATUSES.has(job.status) && !cleanupRetryRequired) {
        schedule(() => scheduleJob(job.id));
        return publicJob(job);
      }
      const result = getCoreDb().prepare(`
        UPDATE work_move_jobs
        SET status = CASE WHEN status = 'cleanup_pending' THEN 'cleanup_pending' WHEN phase = 'cleanup' THEN 'cleanup_pending' WHEN phase = 'rollback' THEN 'rollback_pending' ELSE 'queued' END,
            phase = CASE WHEN status = 'cleanup_pending' THEN phase WHEN phase IN ('cleanup', 'rollback') THEN phase ELSE 'queued' END,
            error = '', error_code = '', finished_at = '', attempts = attempts + 1,
            updated_at = ?, version = version + 1
        WHERE id = ? AND status = ? AND version = ?
          AND (status <> 'cleanup_pending' OR error_code <> '')
      `).run(now(), job.id, job.status, Number(job.version || 0));
      if (Number(result.changes || 0) !== 1) {
        const error = new Error("迁移任务状态已变化，请刷新后重试");
        error.statusCode = 409;
        error.code = "WORK_MOVE_RETRY_CONFLICT";
        error.job = publicJob(row(job.id));
        throw error;
      }
      const queued = row(job.id);
      emitLifecycle("retry_queued", queued);
      if (cleanupRetryRequired) schedule(() => scheduleJob(job.id));
      else scheduleJob(job.id);
      return publicJob(queued);
    } catch (error) {
      if (isSqliteBusy(error)) {
        error.statusCode = 503;
        error.code = "WORK_MOVE_SQLITE_BUSY";
        error.retryable = true;
        error.message = "迁移任务 journal 正忙，请稍后重试";
      }
      throw error;
    }
  }

  function scheduleJob(jobId) {
    if (closing || activeRuns.has(jobId) || pendingJobs.has(jobId)) return;
    pendingJobs.add(jobId);
    pumpQueue();
  }

  function scheduleClaimRetry(jobId) {
    if (closing || claimRetryTimers.has(jobId)) return;
    const attempt = Math.min(6, Number(claimRetryAttempts.get(jobId) || 0) + 1);
    claimRetryAttempts.set(jobId, attempt);
    const delayMs = Math.min(2_000, 100 * (2 ** (attempt - 1)));
    const timer = setTimeout(() => {
      claimRetryTimers.delete(jobId);
      if (activeRuns.has(jobId)) {
        scheduleClaimRetry(jobId);
        return;
      }
      scheduleJob(jobId);
    }, delayMs);
    timer.unref?.();
    claimRetryTimers.set(jobId, timer);
  }

  function claimJob(jobId) {
    const claimedAt = now();
    let result;
    try {
      result = getCoreDb().prepare(`
        UPDATE work_move_jobs
        SET handoff_from = CASE
              WHEN handoff_from <> '' AND handoff_ack <> handoff_from THEN handoff_from
              WHEN owner_id <> '' AND owner_id <> ? THEN owner_id
              ELSE ''
            END,
            handoff_ack = CASE
              WHEN handoff_from <> '' AND handoff_ack <> handoff_from THEN handoff_ack
              WHEN owner_id <> '' AND owner_id <> ? THEN ''
              ELSE ''
            END,
            owner_id = ?, lease_until = ?, version = version + 1, updated_at = ?
        WHERE id = ?
          AND status IN ('queued', 'running', 'cleanup_pending', 'rollback_pending')
          AND (owner_id = '' OR owner_id = ? OR lease_until = '' OR lease_until <= ?)
      `).run(ownerId, ownerId, ownerId, leaseUntil(), claimedAt, jobId, ownerId, claimedAt);
    } catch (error) {
      if (isSqliteBusy(error)) {
        warn("[work-move-claim-busy]", jobId, error?.message || error);
        scheduleClaimRetry(jobId);
        return null;
      }
      throw error;
    }
    if (Number(result.changes || 0) !== 1) {
      scheduleClaimRetry(jobId);
      return null;
    }
    claimRetryAttempts.delete(jobId);
    fencedJobs.delete(jobId);
    const claimed = row(jobId);
    emitLifecycle("claimed", claimed);
    return claimed;
  }

  function renewLease(jobId) {
    const current = row(jobId);
    if (!current || current.owner_id !== ownerId) {
      fenceJob(jobId);
      return false;
    }
    const nextLease = leaseUntil();
    const result = getCoreDb().prepare(`
      UPDATE work_move_jobs
      SET lease_until = ?, version = version + 1
      WHERE id = ? AND owner_id = ? AND version = ?
    `).run(nextLease, jobId, ownerId, Number(current.version || 0));
    if (Number(result.changes || 0) !== 1) {
      fenceJob(jobId);
      return false;
    }
    const plan = activePlans.get(jobId);
    if (plan) {
      if (typeof adminCoreMutationService.renewWorkMoveReservation !== "function") failClaim(jobId);
      adminCoreMutationService.renewWorkMoveReservation(plan, { ownerId, leaseUntil: nextLease, claimedAt: now() });
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

  function hydratePlanRoots(plan, jobId) {
    if (typeof adminCoreMutationService.hydrateWorkMovePlanRoots !== "function") {
      throw new Error("服务未提供可信资料库根目录校验，拒绝恢复文件移动任务");
    }
    const hydrated = adminCoreMutationService.hydrateWorkMovePlanRoots(plan);
    if (!Array.isArray(hydrated?.libraryRoots) || !hydrated.libraryRoots.length) {
      throw new Error("文件移动计划缺少可信资料库根目录，拒绝执行");
    }
    return { ...hydrated, jobId: String(jobId || hydrated.jobId || "") };
  }

  function assertSourceUnshared(plan) {
    if (typeof adminCoreMutationService.assertWorkMoveSourceUnshared !== "function") {
      throw new Error("服务未提供共享源目录复检，拒绝继续文件移动任务");
    }
    return adminCoreMutationService.assertWorkMoveSourceUnshared(plan, { ownerId });
  }

  function acquireReservation(plan) {
    if (typeof adminCoreMutationService.acquireWorkMoveReservation !== "function") {
      throw new Error("服务未提供 durable path reservation，拒绝继续文件移动任务");
    }
    const nextLease = leaseUntil();
    const result = adminCoreMutationService.acquireWorkMoveReservation(plan, {
      ownerId,
      leaseUntil: nextLease,
      claimedAt: now(),
      takeover: true
    });
    activePlans.set(plan.jobId, plan);
    return result;
  }

  function releaseReservation(jobId, terminalStatus) {
    if (typeof adminCoreMutationService.releaseWorkMoveReservation !== "function") return;
    try {
      adminCoreMutationService.releaseWorkMoveReservation(jobId, { ownerId, terminalStatus });
    } catch (error) {
      warn("[work-move-reservation]", error?.message || error);
      if (isSqliteBusy(error)) throw error;
    }
  }

  function pumpQueue() {
    if (closing || activeRuns.size >= Math.max(1, Number(maxConcurrentJobs || 1))) return;
    const jobId = pendingJobs.values().next().value;
    if (!jobId) return;
    pendingJobs.delete(jobId);
    const run = Promise.resolve()
      .then(() => runJob(jobId))
      .catch((error) => warn("[work-move-job]", error?.message || error))
      .finally(() => {
        activeRuns.delete(jobId);
        pumpQueue();
      });
    activeRuns.set(jobId, run);
  }

  async function runJob(jobId) {
    let job = row(jobId);
    if (!job || closing) return;
    if (["completed", "rolled_back"].includes(job.status)) {
      try {
        releaseReservation(jobId, job.status);
        claimRetryAttempts.delete(jobId);
      } catch (error) {
        if (!isSqliteBusy(error)) throw error;
        warn("[work-move-terminal-release-busy]", jobId, error?.message || error);
        scheduleClaimRetry(jobId);
      }
      return;
    }
    if (!ACTIVE_STATUSES.has(job.status)) return;
    job = claimJob(jobId);
    if (!job) {
      if (ACTIVE_STATUSES.has(row(jobId)?.status)) scheduleClaimRetry(jobId);
      return;
    }
    const heartbeat = setInterval(() => {
      try {
        renewLease(jobId);
      } catch (error) {
        warn("[work-move-heartbeat]", error?.message || error);
        Promise.resolve(fenceJob(jobId)).finally(() => scheduleClaimRetry(jobId));
      }
    }, Math.max(250, Math.floor(Number(leaseDurationMs || 30_000) / 3)));
    heartbeat.unref?.();
    let plan = json(job.plan_json, null);
    const request = json(job.request_json, {});
    try {
      const handoffReady = await awaitSafeHandoff(jobId, job);
      if (handoffReady === false) return;
      if (job.status === "rollback_pending" && !plan) {
        const errorCode = "WORK_MOVE_ROLLBACK_PLAN_MISSING";
        updateState(jobId, "failed", "validation", "回滚任务缺少持久化路径计划，拒绝执行", { errorCode, finished: true });
        emitLifecycle("failed", row(jobId), { errorCode });
        return;
      }
      if (plan) {
        try {
          const hydratedPlan = hydratePlanRoots(plan, jobId);
          if (JSON.stringify(hydratedPlan) !== JSON.stringify(plan)) updatePlanCheckpoint(jobId, hydratedPlan);
          plan = hydratedPlan;
        } catch (error) {
          const errorCode = error?.code || "WORK_MOVE_PLAN_INVALID";
          updateState(jobId, "failed", "validation", error.message || String(error), { errorCode, finished: true });
          emitLifecycle("failed", row(jobId), { errorCode });
          return;
        }
      }
      if (plan) acquireReservation(plan);
      if (job.status === "rollback_pending" && plan) {
        await runWorker(jobId, "rollback", plan);
        const errorCode = job.error_code || "WORK_MOVE_RECOVERED_ROLLBACK";
        updateState(jobId, "rolled_back", "rolled_back", job.error || "上次操作已回滚", { errorCode, finished: true });
        emitLifecycle("rolled_back", row(jobId), { errorCode });
        releaseReservation(jobId, "rolled_back");
        return;
      }
      if (!plan) {
        plan = adminCoreMutationService.prepareWorkMove(job.work_id, request.personId, {
          targetDirectory: request.targetDirectory || request.targetPath || "",
          createPerson: request.createPerson || null,
          androidCommand: request.androidCommand === true
        });
        try {
          plan = hydratePlanRoots(plan, jobId);
        } catch (error) {
          const errorCode = error?.code || "WORK_MOVE_PLAN_INVALID";
          updateState(jobId, "failed", "validation", error.message || String(error), { errorCode, finished: true });
          emitLifecycle("failed", row(jobId), { errorCode });
          return;
        }
        updatePlan(jobId, plan);
        acquireReservation(plan);
      }

      const databaseState = adminCoreMutationService.inspectWorkMove(plan);
      const persistedResult = json(job.result_json, null);
      let moveResult = persistedResult?.move || (persistedResult?.moveMode ? { mode: persistedResult.moveMode } : null);
      if (databaseState === "source") {
        updateState(jobId, "running", "copying", "");
        moveResult = await runWorker(jobId, "stage", plan);
        updateState(jobId, "running", "filesystem_ready", "", { result: { move: moveResult } });
        adminCoreMutationService.commitWorkMove(plan, { ownerId });
        updateState(jobId, "running", "main_committed", "", { result: { move: moveResult } });
      } else if (databaseState !== "target") {
        throw new Error("SQLite 中的作品路径已被其他操作修改，拒绝继续移动");
      }

      assertSourceUnshared(plan);
      if (adminCoreMutationService.inspectWorkMoveImages(plan) !== "completed") {
        updateState(jobId, "running", "images", "", { result: { move: moveResult } });
        adminCoreMutationService.commitWorkMoveImages(plan, { ownerId });
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
      if (typeof beforeCleanup === "function") await beforeCleanup({ jobId, plan, ownerId });
      await runWorker(jobId, "cleanup", plan);
      updateState(jobId, "completed", "completed", "", { result, finished: true, completeProgress: true });
      emitLifecycle("completed", row(jobId));
      releaseReservation(jobId, "completed");
    } catch (error) {
      if (closing) {
        preserveForRecovery(jobId);
        if (fencedJobs.has(jobId)) await awaitFencedWorker(jobId);
        return;
      }
      if (isClaimLost(jobId, error)) {
        await awaitFencedWorker(jobId);
        return;
      }
      if (isSqliteBusy(error)) {
        const currentStatus = row(jobId)?.status;
        warn(
          ["completed", "rolled_back"].includes(currentStatus)
            ? "[work-move-terminal-release-busy]"
            : "[work-move-stage-busy]",
          jobId,
          error?.message || error
        );
        scheduleClaimRetry(jobId);
        return;
      }
      try {
        await handleFailure(jobId, plan, error);
      } catch (failureError) {
        if (!isSqliteBusy(failureError)) throw failureError;
        warn("[work-move-recovery-busy]", jobId, failureError?.message || failureError);
        scheduleClaimRetry(jobId);
      }
    } finally {
      clearInterval(heartbeat);
      if (fencedJobs.has(jobId)) await awaitFencedWorker(jobId);
      let canReleaseClaim = true;
      try {
        const current = row(jobId);
        if (activePlans.has(jobId) && plan && current?.owner_id === ownerId && !["completed", "rolled_back"].includes(current.status)) {
          if (typeof adminCoreMutationService.parkWorkMoveReservation !== "function") {
            canReleaseClaim = false;
            warn("[work-move-reservation] durable reservation 无法安全停放");
          } else {
            adminCoreMutationService.parkWorkMoveReservation(plan, { ownerId });
          }
        }
      } catch (error) {
        canReleaseClaim = false;
        warn("[work-move-reservation]", error?.message || error);
        if (isSqliteBusy(error)) scheduleClaimRetry(jobId);
      }
      activePlans.delete(jobId);
      if (canReleaseClaim) {
        try {
          releaseClaim(jobId);
        } catch (error) {
          if (!isSqliteBusy(error)) throw error;
          warn("[work-move-release]", error?.message || error);
          scheduleClaimRetry(jobId);
        }
      }
      workerTerminationPromises.delete(jobId);
    }
  }

  async function handleFailure(jobId, plan, error) {
    const message = error?.message || String(error);
    if (plan && adminCoreMutationService.inspectWorkMove(plan) === "target") {
      updateState(jobId, "cleanup_pending", row(jobId)?.phase || "main_committed", message, {
        errorCode: error?.code || "WORK_MOVE_CLEANUP_PENDING"
      });
      emitLifecycle("cleanup_pending", row(jobId), { errorCode: error?.code || "WORK_MOVE_CLEANUP_PENDING" });
      return;
    }
    if (!plan) {
      updateState(jobId, "failed", "validation", message, {
        errorCode: error?.code || "WORK_MOVE_VALIDATION_FAILED",
        finished: true
      });
      emitLifecycle("failed", row(jobId), { errorCode: error?.code || "WORK_MOVE_VALIDATION_FAILED" });
      return;
    }
    updateState(jobId, "rollback_pending", "rollback", message, { errorCode: error?.code || "WORK_MOVE_FAILED" });
    try {
      await runWorker(jobId, "rollback", plan);
      updateState(jobId, "rolled_back", "rolled_back", message, { finished: true });
      emitLifecycle("rolled_back", row(jobId), { errorCode: error?.code || "WORK_MOVE_FAILED" });
      releaseReservation(jobId, "rolled_back");
    } catch (rollbackError) {
      if (isClaimLost(jobId, rollbackError)) return;
      if (closing) {
        preserveForRecovery(jobId);
        return;
      }
      if (isSqliteBusy(rollbackError)) {
        warn("[work-move-terminal-release-busy]", jobId, rollbackError?.message || rollbackError);
        scheduleClaimRetry(jobId);
        return;
      }
      updateState(jobId, "failed", "rollback", `${message}; 自动回滚失败：${rollbackError.message}`, {
        errorCode: rollbackError?.code || error?.code || "WORK_MOVE_ROLLBACK_FAILED",
        finished: true
      });
      emitLifecycle("failed", row(jobId), { errorCode: rollbackError?.code || error?.code || "WORK_MOVE_ROLLBACK_FAILED" });
    }
  }

  function runWorker(jobId, operation, plan) {
    if (fencedJobs.has(jobId)) return Promise.reject(claimLostError());
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
        try {
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
        } catch (error) {
          if (isSqliteBusy(error)) {
            warn("[work-move-progress-busy]", jobId, error?.message || error);
            Promise.resolve(fenceJob(jobId)).finally(() => scheduleClaimRetry(jobId));
            return claimLostError();
          }
          return error;
        }
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
        try {
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
        } catch (error) {
          if (isSqliteBusy(error)) {
            warn("[work-move-message-busy]", jobId, error?.message || error);
            Promise.resolve(fenceJob(jobId)).finally(() => scheduleClaimRetry(jobId));
            finish(reject, claimLostError(), true);
          } else {
            finish(reject, error, true);
          }
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
    const errorCode = options.errorCode === undefined
      ? error ? String(current.error_code || "") : ""
      : String(options.errorCode || "");
    const result = getCoreDb().prepare(`
      UPDATE work_move_jobs
      SET status = ?, phase = ?, error = ?, error_code = ?, result_json = ?, progress_files = ?, progress_bytes = ?,
          updated_at = ?, finished_at = ?, lease_until = ?, version = version + 1
      WHERE id = ? AND owner_id = ? AND version = ?
    `).run(status, phase, String(error || ""), errorCode, resultJson, progressFiles, progressBytes, now(), finishedAt, leaseUntil(), jobId, ownerId, Number(current.version || 0));
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
      try {
        preserveForRecovery(jobId);
      } catch (error) {
        warn("[work-move-close]", error?.message || error);
      }
      terminations.push(worker.terminate().catch(() => {}));
    }
    await Promise.allSettled(terminations);
    await Promise.allSettled([...activeRuns.values()]);
  }

  function list(options = {}) {
    return listWorkMoveJobs({ getCoreDb, now, publicJob }, options);
  }

  return { close, findForWork, get, list, publicJob, recover, retry, start };
}
