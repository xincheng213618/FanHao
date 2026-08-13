export function shortVideoPublicError(error, fallback, { defaultStatus = 500 } = {}) {
  if (error?.name === "AbortError") {
    return { status: 499, message: "短视频请求已取消", log: false };
  }
  if (isSafeDatabaseBusyError(error)) {
    return { status: 503, message: "短视频数据库正忙，请稍后重试", log: false };
  }
  if (isShortVideoDatabaseError(error)) {
    return { status: 503, message: "短视频数据库正在恢复，请稍后重试", log: true };
  }

  const requestedStatus = Number(error?.statusCode);
  const status = Number.isInteger(requestedStatus) && requestedStatus >= 400 && requestedStatus <= 599
    ? requestedStatus
    : defaultStatus;
  const exposeMessage = status < 500 || error?.expose === true;
  return {
    status,
    message: exposeMessage && error?.message ? error.message : fallback,
    log: status >= 500
  };
}

export function sendShortVideoPublicError(res, sendJson, error, fallback, options = {}) {
  const result = shortVideoPublicError(error, fallback, options);
  if (result.log) {
    (options.logError || console.error)(options.logLabel || "[short-video-api]", error);
  }
  const exposeDetails = result.status < 500 || error?.expose === true;
  const recovery = shortVideoDeleteRecoveryBody(error?.publicBody);
  const publicCode = shortVideoPublic4xxCode(error, result.status);
  sendJson(res, result.status, {
    error: result.message,
    ...recovery,
    ...(publicCode ? { code: publicCode } : {}),
    ...(options.includeRetryable && result.status === 503 && error?.retryable === true ? { retryable: true } : {}),
    ...(options.includeDetails && exposeDetails && error?.details ? { details: error.details } : {})
  });
}

function shortVideoDeleteRecoveryBody(value) {
  if (!value || typeof value !== "object" || value.pending !== true || value.recoveryRequired !== true) return {};
  const status = ["running", "rollback_pending", "cleanup_pending"].includes(String(value.status || ""))
    ? String(value.status)
    : "rollback_pending";
  const rawCode = String(value.code || "");
  const code = rawCode.startsWith("SHORT_VIDEO_DELETE_")
    ? rawCode
    : "SHORT_VIDEO_DELETE_RECOVERY_REQUIRED";
  const processRestartRequired = value.processRestartRequired === true;
  const manualInterventionRequired = value.manualInterventionRequired === true || processRestartRequired;
  return {
    ok: false,
    accepted: false,
    pending: true,
    recoveryRequired: true,
    retryable: value.retryable === true && !manualInterventionRequired,
    manualInterventionRequired,
    processRestartRequired,
    status,
    jobId: String(value.jobId || "").slice(0, 100),
    code
  };
}

function shortVideoPublic4xxCode(error, status) {
  if (status < 400 || status >= 500 || error?.expose !== true) return "";
  const code = String(error?.code || "");
  return new Set([
    "SHORT_VIDEO_DELETE_JOB_NOT_FOUND",
    "SHORT_VIDEO_DELETE_OPERATION_ID_INVALID",
    "SHORT_VIDEO_DELETE_OPERATION_CONFLICT",
    "SHORT_VIDEO_DELETE_OPERATION_INCOMPLETE",
    "SHORT_VIDEO_DELETE_REQUEST_INVALID",
    "SHORT_VIDEO_DELETE_GROUP_CHANGED"
  ]).has(code) ? code : "";
}

function isSafeDatabaseBusyError(error) {
  return Number(error?.statusCode) === 503
    && error?.retryable === true
    && error?.message === "短视频数据库正忙，请稍后重试";
}

function isShortVideoDatabaseError(error) {
  if (["SHORT_VIDEO_DATABASE_BUSY", "SHORT_VIDEO_DATABASE_UNAVAILABLE"].includes(String(error?.code || ""))) return true;
  const message = String(error?.message || error || "");
  return /database disk image|malformed|sqlite/i.test(message);
}
