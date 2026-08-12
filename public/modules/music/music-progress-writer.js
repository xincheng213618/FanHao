const DEFAULT_PROGRESS_DELAY_MS = 800;
const WRITE_BUSY_RETRY_DELAY_MS = 1000;

export function createMusicProgressWriter({ send, onPlayed, setTimeoutFn, clearTimeoutFn }) {
  const scheduleTimer = setTimeoutFn || ((callback, delay) => window.setTimeout(callback, delay));
  const cancelTimer = clearTimeoutFn || ((timer) => window.clearTimeout(timer));
  const tracks = new Map();
  const attemptedPlayed = new Set();

  function save(record, options = {}) {
    if (!record?.trackId) return;
    const state = trackState(record.trackId);
    state.latest = record;
    state.progressVersion += 1;
    state.pendingProgressVersion = state.progressVersion;
    schedule(state, options.immediate ? 0 : options.delayMs ?? DEFAULT_PROGRESS_DELAY_MS);
  }

  function reportPlayed(record) {
    const reportKey = String(record?.reportKey || "");
    if (!record?.trackId || !reportKey || attemptedPlayed.has(reportKey)) return;
    rememberAttempt(reportKey);
    const state = trackState(record.trackId);
    state.latest = record;
    state.playedQueue.push({ reportKey, session: record.session });
    schedule(state, 0);
  }

  function trackState(trackId) {
    let state = tracks.get(trackId);
    if (!state) {
      state = {
        trackId, latest: null, progressVersion: 0, pendingProgressVersion: 0,
        playedQueue: [], active: false, timer: 0, timerDelayMs: null, lastKind: ""
      };
      tracks.set(trackId, state);
    }
    return state;
  }

  function schedule(state, delayMs) {
    const delay = Math.max(0, Number(delayMs || 0));
    if (state.active) return;
    if (state.timer) {
      if (state.timerDelayMs <= delay) return;
      cancelTimer(state.timer);
    }
    state.timerDelayMs = delay;
    state.timer = scheduleTimer(() => {
      state.timer = 0;
      state.timerDelayMs = null;
      void flush(state);
    }, delay);
  }

  async function flush(state) {
    if (state.active) return;
    const action = nextAction(state);
    if (!action || !state.latest) return;
    state.active = true;
    state.lastKind = action.kind;
    const record = action.kind === "played" ? { ...state.latest, ...action.token } : state.latest;
    let retry = false;
    try {
      await send(record, action.kind === "played");
      settleAction(state, action, true, record);
    } catch (error) {
      retry = isRetryableWriteBusy(error);
      if (!retry) settleAction(state, action, false, record);
    } finally {
      state.active = false;
      if (hasPending(state)) schedule(state, retry ? WRITE_BUSY_RETRY_DELAY_MS : 0);
      else tracks.delete(state.trackId);
    }
  }

  function nextAction(state) {
    const progressPending = state.pendingProgressVersion > 0;
    const playedPending = state.playedQueue.length > 0;
    if (!progressPending && !playedPending) return null;
    if (progressPending && playedPending) {
      if (state.lastKind === "played") return { kind: "progress", version: state.pendingProgressVersion };
      return { kind: "played", token: state.playedQueue[0] };
    }
    return playedPending
      ? { kind: "played", token: state.playedQueue[0] }
      : { kind: "progress", version: state.pendingProgressVersion };
  }

  function settleAction(state, action, succeeded, record) {
    if (action.kind === "progress") {
      if (state.pendingProgressVersion === action.version) state.pendingProgressVersion = 0;
      return;
    }
    if (state.playedQueue[0]?.reportKey === action.token.reportKey) state.playedQueue.shift();
    if (succeeded) onPlayed?.(record);
  }

  function hasPending(state) {
    return state.pendingProgressVersion > 0 || state.playedQueue.length > 0;
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
