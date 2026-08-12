import { isMusicDatabaseBusyError, MUSIC_WRITE_BUSY_MESSAGE } from "./write-transaction.js";

export function musicPublicError(error, fallback) {
  if (isMusicDatabaseBusyError(error) || error?.code === "MUSIC_WRITE_BUSY") {
    return {
      status: 503,
      payload: {
        error: MUSIC_WRITE_BUSY_MESSAGE,
        code: "MUSIC_WRITE_BUSY",
        retryable: true
      },
      log: false
    };
  }

  const requestedStatus = Number(error?.statusCode);
  const status = Number.isInteger(requestedStatus) && requestedStatus >= 400 && requestedStatus <= 599
    ? requestedStatus
    : 500;
  const expose = status < 500 || error?.expose === true;
  return {
    status,
    payload: {
      error: expose && error?.message ? error.message : fallback,
      ...(expose && error?.code ? { code: String(error.code) } : {}),
      ...(status === 503 && error?.retryable === true ? { retryable: true } : {})
    },
    log: status >= 500 && !expose
  };
}

export function sendMusicPublicError(res, sendJson, error, fallback, options = {}) {
  const result = musicPublicError(error, fallback);
  if (result.log) (options.logError || console.error)(options.logLabel || "[music-api]", error);
  sendJson(res, result.status, result.payload);
}
