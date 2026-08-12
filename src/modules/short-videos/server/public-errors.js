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
  sendJson(res, result.status, {
    error: result.message,
    ...(options.includeRetryable && result.status === 503 && error?.retryable === true ? { retryable: true } : {}),
    ...(options.includeDetails && exposeDetails && error?.details ? { details: error.details } : {})
  });
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
