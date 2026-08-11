const ALLOWED_STATUSES = new Set([
  "queued",
  "running",
  "cleanup_pending",
  "rollback_pending",
  "blocked",
  "completed",
  "rolled_back",
  "failed"
]);

const ACTIVE_STATUSES = ["queued", "running", "cleanup_pending", "rollback_pending"];

function statusFilter(value) {
  const statuses = [...new Set(String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean))];
  const invalid = statuses.find((status) => !ALLOWED_STATUSES.has(status));
  if (invalid) {
    const error = new Error(`不支持的迁移任务状态：${invalid}`);
    error.statusCode = 400;
    error.code = "WORK_MOVE_STATUS_INVALID";
    throw error;
  }
  return statuses;
}

function boundedLimit(value) {
  const parsed = Number(value || 50);
  if (!Number.isFinite(parsed)) {
    const error = new Error("迁移任务 limit 无效");
    error.statusCode = 400;
    error.code = "WORK_MOVE_LIMIT_INVALID";
    throw error;
  }
  return Math.max(1, Math.min(100, Math.trunc(parsed)));
}

function listItem(job, publicJob) {
  const item = publicJob(job);
  const safeError = (() => {
    if (item.errorCode === "WORK_MOVE_HANDOFF_TIMEOUT") return "旧进程仍存活但未确认交接，请人工检查后处理。";
    if (item.status === "blocked") return "任务已安全阻断，需要人工检查后处理。";
    if (item.status === "rolled_back") return "迁移未完成，文件操作已回滚。";
    if (item.status === "failed") return "迁移未完成，请根据错误代码检查服务端日志。";
    return "";
  })();
  return {
    id: item.id,
    workId: item.workId,
    personId: item.personId,
    status: item.status,
    phase: item.phase,
    progress: item.progress,
    progressFiles: item.progressFiles,
    totalFiles: item.totalFiles,
    progressBytes: item.progressBytes,
    totalBytes: item.totalBytes,
    attempts: item.attempts,
    errorCode: item.errorCode,
    error: safeError,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    finishedAt: item.finishedAt,
    recoverable: item.recoverable
  };
}

function countStatus(db, statuses) {
  const placeholders = statuses.map(() => "?").join(", ");
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM work_move_jobs WHERE status IN (${placeholders})`).get(...statuses)?.count || 0);
}

function activeReservationCount(db) {
  return Number(db.prepare(`
    SELECT COUNT(DISTINCT job_id) AS count
    FROM (
      SELECT job_id FROM work_move_path_reservations WHERE released_at = ''
      UNION ALL
      SELECT job_id FROM fanhao_images.work_move_path_reservations WHERE released_at = ''
    )
  `).get()?.count || 0);
}

function summary(db, currentTimestamp) {
  const outstandingStatuses = [...ACTIVE_STATUSES, "blocked", "failed"];
  const placeholders = outstandingStatuses.map(() => "?").join(", ");
  const oldest = db.prepare(`
    SELECT updated_at FROM work_move_jobs
    WHERE status IN (${placeholders})
    ORDER BY updated_at ASC LIMIT 1
  `).get(...outstandingStatuses);
  const oldestUpdatedAt = String(oldest?.updated_at || "");
  const currentTime = Date.parse(currentTimestamp);
  const oldestTime = Date.parse(oldestUpdatedAt);
  return {
    active: countStatus(db, ACTIVE_STATUSES),
    blocked: countStatus(db, ["blocked"]),
    failed: countStatus(db, ["failed"]),
    rolledBack: countStatus(db, ["rolled_back"]),
    oldestOutstandingUpdatedAt: oldestUpdatedAt,
    oldestOutstandingAgeMs: Number.isFinite(currentTime) && Number.isFinite(oldestTime) ? Math.max(0, currentTime - oldestTime) : 0,
    activeReservations: activeReservationCount(db)
  };
}

export function listWorkMoveJobs({ getCoreDb, now, publicJob }, options = {}) {
  const db = getCoreDb();
  const statuses = statusFilter(options.status);
  const workId = String(options.workId || "").trim();
  const limit = boundedLimit(options.limit);
  const clauses = [];
  const params = [];
  if (statuses.length) {
    clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }
  if (workId) {
    clauses.push("work_id = ?");
    params.push(workId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`
    SELECT * FROM work_move_jobs
    ${where}
    ORDER BY updated_at DESC, created_at DESC, id DESC
    LIMIT ?
  `).all(...params, limit);
  return {
    jobs: rows.map((row) => listItem(row, publicJob)),
    summary: summary(db, now()),
    filters: { statuses, workId, limit }
  };
}

export { ALLOWED_STATUSES };
