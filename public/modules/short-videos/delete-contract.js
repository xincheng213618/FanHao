export class ShortVideoDeleteContractError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ShortVideoDeleteContractError";
    this.status = Number(options.status || 0);
    this.payload = options.payload || null;
  }
}

export async function requestShortVideoDelete(api, path, requestOptions = {}, options = {}) {
  try {
    const response = await api(path, { ...requestOptions, returnResponse: true });
    if (!response || !Number.isInteger(response.status) || !("payload" in response)) {
      throw contractError("删除接口没有返回可验证的 HTTP 状态", 0, response);
    }
    return parseShortVideoDeleteResponse(response.status, response.payload, options);
  } catch (error) {
    if (Number(error?.status || error?.statusCode) === 500 && error?.payload) {
      return parseShortVideoDeleteResponse(500, error.payload, options);
    }
    throw error;
  }
}

export function parseShortVideoDeleteResponse(httpStatus, payload, options = {}) {
  const status = Number(httpStatus);
  const row = requireObject(payload, status);
  if (status === 200) return completedResult(row, options, status);
  if (status === 202) return cleanupPendingResult(row, options, status);
  if (status === 500) return rollbackPendingResult(row, status);
  throw contractError(`删除接口返回了未支持的 HTTP 状态：${status || "未知"}`, status, row);
}

export function shortVideoDeletePendingMessage(result) {
  return `资料库记录已移除，${result.cleanupPendingFiles} 个文件待清理（任务 #${result.jobId}）`;
}

export function shortVideoDeleteRecoveryMessage(result) {
  return `删除尚未提交，正在安全恢复（任务 #${result.jobId}）`;
}

export function shortVideoDeleteCompletedMessage(result, options = {}) {
  const files = result.deletedFiles.length ? `，${result.deletedFiles.length} 个文件` : "";
  return options.scope === "single" ? `已删除${files}` : `已删除 ${result.count} 条${files}`;
}

function completedResult(row, options, httpStatus) {
  requireExact(row, "ok", true, httpStatus);
  requireExact(row, "accepted", true, httpStatus);
  requireExact(row, "pending", false, httpStatus);
  requireExact(row, "status", "completed", httpStatus);
  requireExact(row, "logicalDeleteCommitted", true, httpStatus);
  requireExact(row, "physicalCleanupComplete", true, httpStatus);
  const jobId = requireNonEmptyString(row, "jobId", httpStatus);
  const cleanupPendingFiles = requireNonNegativeInteger(row, "cleanupPendingFiles", httpStatus);
  if (cleanupPendingFiles !== 0) {
    throw contractError("已完成的删除响应仍声明有待清理文件", httpStatus, row);
  }
  return committedResult("completed", row, options, { jobId, cleanupPendingFiles });
}

function cleanupPendingResult(row, options, httpStatus) {
  requireExact(row, "ok", true, httpStatus);
  requireExact(row, "accepted", true, httpStatus);
  requireExact(row, "pending", true, httpStatus);
  requireExact(row, "status", "cleanup_pending", httpStatus);
  requireExact(row, "logicalDeleteCommitted", true, httpStatus);
  requireExact(row, "physicalCleanupComplete", false, httpStatus);
  const jobId = requireNonEmptyString(row, "jobId", httpStatus);
  const cleanupPendingFiles = requireNonNegativeInteger(row, "cleanupPendingFiles", httpStatus);
  return committedResult("cleanup_pending", row, options, { jobId, cleanupPendingFiles });
}

function rollbackPendingResult(row, httpStatus) {
  requireExact(row, "ok", false, httpStatus);
  requireExact(row, "accepted", false, httpStatus);
  requireExact(row, "pending", true, httpStatus);
  requireExact(row, "status", "rollback_pending", httpStatus);
  requireExact(row, "recoveryRequired", true, httpStatus);
  const retryable = requireBoolean(row, "retryable", httpStatus);
  const manualInterventionRequired = optionalBoolean(row, "manualInterventionRequired", false, httpStatus);
  const processRestartRequired = optionalBoolean(row, "processRestartRequired", false, httpStatus);
  if (retryable === manualInterventionRequired || (processRestartRequired && !manualInterventionRequired)) {
    throw contractError("删除恢复响应的重试与人工介入状态不一致", httpStatus, row);
  }
  return {
    kind: "rollback_pending",
    committed: false,
    pending: true,
    status: "rollback_pending",
    jobId: requireNonEmptyString(row, "jobId", httpStatus),
    recoveryRequired: true,
    retryable,
    manualInterventionRequired,
    processRestartRequired,
    payload: row
  };
}

function committedResult(kind, row, options, values) {
  const ids = normalizeIds(row.ids);
  if (!ids.length) {
    throw contractError("删除响应缺少已提交的记录 ID", kind === "completed" ? 200 : 202, row);
  }
  const count = requireNonNegativeInteger(row, "count", kind === "completed" ? 200 : 202);
  if (count !== ids.length) {
    throw contractError("删除响应的记录数量与 ID 列表不一致", kind === "completed" ? 200 : 202, row);
  }
  if (!Array.isArray(row.deletedFiles)) {
    throw contractError("删除响应缺少文件结果列表", kind === "completed" ? 200 : 202, row);
  }
  const expectedIds = normalizeIds(options.expectedIds);
  if (expectedIds.length && expectedIds.some((id) => !ids.includes(id))) {
    throw contractError("删除响应未包含请求的记录 ID", kind === "completed" ? 200 : 202, row);
  }
  return {
    kind,
    committed: true,
    pending: kind === "cleanup_pending",
    status: kind,
    ids,
    count,
    deletedFiles: [...row.deletedFiles],
    logicalDeleteCommitted: true,
    physicalCleanupComplete: kind === "completed",
    jobId: values.jobId,
    cleanupPendingFiles: values.cleanupPendingFiles,
    payload: row
  };
}

function normalizeIds(value) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  const seen = new Set();
  for (const valueId of value) {
    if (typeof valueId !== "string") return [];
    const id = valueId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function requireObject(payload, status) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw contractError("删除接口返回了无效 JSON", status, payload);
  }
  return payload;
}

function requireExact(row, key, value, status) {
  if (!Object.hasOwn(row, key) || row[key] !== value) {
    throw contractError(`删除响应字段 ${key} 无效`, status, row);
  }
}

function requireNonEmptyString(row, key, status) {
  if (typeof row[key] !== "string" || !row[key].trim()) {
    throw contractError(`删除响应字段 ${key} 无效`, status, row);
  }
  return row[key].trim();
}

function requireNonNegativeInteger(row, key, status) {
  if (!Number.isSafeInteger(row[key]) || row[key] < 0) {
    throw contractError(`删除响应字段 ${key} 无效`, status, row);
  }
  return row[key];
}

function requireBoolean(row, key, status) {
  if (typeof row[key] !== "boolean") throw contractError(`删除响应字段 ${key} 无效`, status, row);
  return row[key];
}

function optionalBoolean(row, key, fallback, status) {
  return Object.hasOwn(row, key) ? requireBoolean(row, key, status) : fallback;
}

function contractError(message, status, payload) {
  return new ShortVideoDeleteContractError(message, { status, payload });
}
