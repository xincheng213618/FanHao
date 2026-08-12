const DEFAULT_PROGRESS_DELAY_MS = 800;
const WRITE_BUSY_RETRY_DELAY_MS = 1000;

export function createMusicProgressWriter({ send, onPlayed, setTimeoutFn, clearTimeoutFn }) {
  const scheduleTimer = setTimeoutFn || ((callback, delay) => window.setTimeout(callback, delay));
  const cancelTimer = clearTimeoutFn || ((timer) => window.clearTimeout(timer));
  const pendingProgress = new Map();
  const pendingPlayed = new Map();
  const attemptedPlayed = new Set();
  let progressTimer = 0;
  let progressActive = false;
  let playedTimer = 0;
  let playedActiveKey = "";

  function save(record, options = {}) {
    if (!record?.trackId) return;
    pendingProgress.set(record.trackId, record);
    if (options.immediate) {
      cancelTimer(progressTimer);
      progressTimer = 0;
      void flushProgress();
      return;
    }
    scheduleProgress(options.delayMs ?? DEFAULT_PROGRESS_DELAY_MS);
  }

  function reportPlayed(record) {
    const reportKey = String(record?.reportKey || "");
    if (!record?.trackId || !reportKey || attemptedPlayed.has(reportKey)) return;
    rememberAttempt(reportKey);
    pendingPlayed.set(reportKey, record);
    schedulePlayed(0);
  }

  function scheduleProgress(delayMs) {
    if (progressTimer) return;
    progressTimer = scheduleTimer(() => {
      progressTimer = 0;
      void flushProgress();
    }, Math.max(0, Number(delayMs || 0)));
  }

  async function flushProgress() {
    if (progressActive) return;
    const entry = pendingProgress.entries().next().value;
    if (!entry) return;
    const [trackId, record] = entry;
    pendingProgress.delete(trackId);
    progressActive = true;
    let retry = false;
    try {
      await send(record, false);
    } catch (error) {
      retry = isRetryableWriteBusy(error);
      if (retry && !pendingProgress.has(trackId)) pendingProgress.set(trackId, record);
    } finally {
      progressActive = false;
      if (pendingProgress.size) scheduleProgress(retry ? WRITE_BUSY_RETRY_DELAY_MS : DEFAULT_PROGRESS_DELAY_MS);
    }
  }

  function schedulePlayed(delayMs) {
    if (playedTimer) return;
    playedTimer = scheduleTimer(() => {
      playedTimer = 0;
      void flushPlayed();
    }, Math.max(0, Number(delayMs || 0)));
  }

  async function flushPlayed() {
    if (playedActiveKey) return;
    const entry = pendingPlayed.entries().next().value;
    if (!entry) return;
    const [reportKey, record] = entry;
    pendingPlayed.delete(reportKey);
    playedActiveKey = reportKey;
    let retry = false;
    try {
      await send(record, true);
      onPlayed?.(record);
    } catch (error) {
      retry = isRetryableWriteBusy(error);
      if (retry && !pendingPlayed.has(reportKey)) pendingPlayed.set(reportKey, record);
    } finally {
      playedActiveKey = "";
      if (pendingPlayed.size) schedulePlayed(retry ? WRITE_BUSY_RETRY_DELAY_MS : 0);
    }
  }

  function rememberAttempt(reportKey) {
    attemptedPlayed.add(reportKey);
    while (attemptedPlayed.size > 64) attemptedPlayed.delete(attemptedPlayed.values().next().value);
  }

  return { reportPlayed, save };
}

export function isRetryableWriteBusy(error) {
  return Number(error?.status ?? error?.statusCode) === 503
    && error?.retryable === true
    && error?.code === "MUSIC_WRITE_BUSY";
}
