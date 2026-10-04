const DEFAULT_PROGRESS_DELAY_MS = 800;
const WRITE_BUSY_RETRY_DELAY_MS = 1000;
const DEFAULT_CONCURRENT = 4;
const DEFAULT_PENDING_KEYS = 64;
const DEFAULT_PLAYED_TOKENS = 128;
const DEFAULT_KEEPALIVE_BYTES = 48 * 1024;
const encoder = new TextEncoder();
const RECORD_FIELDS = [
  "activeUrl", "trackId", "positionMs", "durationMs", "progressSessionId",
  "progressSessionStartedAt", "progressSequence", "playedReportId",
  "playedReportStartedAt", "reportKey", "session", "webAccountOwner", "webAccountRevision",
  "accountOrigin", "accountOwner", "accountRevision", "accountTokenKnown"
];

// The page owns session/sequence creation. Already captured records and played
// identities never receive a new sequence or move to another server here.
export function createMusicProgressWriter({
  send, sendKeepalive, onPlayed, onError, setTimeoutFn, clearTimeoutFn,
  maxConcurrent = DEFAULT_CONCURRENT, maxPendingKeys = DEFAULT_PENDING_KEYS,
  maxPlayedTokens = DEFAULT_PLAYED_TOKENS, maxKeepaliveBytes = DEFAULT_KEEPALIVE_BYTES
}) {
  if (typeof send !== "function") throw new TypeError("Music progress transport is required");
  for (const capacity of [maxConcurrent, maxPendingKeys, maxPlayedTokens, maxKeepaliveBytes]) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("Invalid music progress capacity");
  }
  const scheduleTimer = setTimeoutFn || ((callback, delay) => window.setTimeout(callback, delay));
  const cancelTimer = clearTimeoutFn || ((timer) => window.clearTimeout(timer));
  const tracks = new Map();
  const playedTokens = new Map();
  const attemptedPlayed = new Set();
  const ready = [];
  let emergency = null;
  let activeCount = 0;
  let paused = false;
  let leaveCycle = 0;
  let keepaliveCount = 0;
  let keepaliveBytes = 0;

  function notify(callback, ...args) {
    try { callback?.(...args); } catch {}
  }

  function reject(code, record) {
    const error = Object.assign(new Error("音乐播放进度保存队列暂忙，请稍后重试"), { code });
    notify(onError, error, record);
    return false;
  }

  function capture(value) {
    try { return copyRecord(value); }
    catch (error) { notify(onError, error, value); return null; }
  }

  function save(value, options = {}) {
    const record = capture(value);
    if (!record) return false;
    const state = trackState(record);
    if (!state) return false;
    state.latest = newerRecord(state.latest, record);
    state.progressVersion += 1;
    state.pendingProgressVersion = state.progressVersion;
    schedule(state, options.immediate ? 0 : options.delayMs ?? DEFAULT_PROGRESS_DELAY_MS);
    return true;
  }

  function reportPlayed(value) {
    const record = capture(value);
    if (!record || !record.reportKey) return false;
    const id = playedKey(record);
    if (playedTokens.has(id) || attemptedPlayed.has(id)) return false;
    if (playedTokens.size >= maxPlayedTokens) return reject("MUSIC_PLAYED_QUEUE_FULL", record);
    const state = trackState(record);
    if (!state) return false;
    const token = { id, record, confirmed: false, pending: true, normalActive: false, keepaliveCount: 0, leaveCycle: -1 };
    playedTokens.set(id, token);
    rememberAttempt(id);
    state.latest = newerRecord(state.latest, record);
    state.playedQueue.push(token);
    schedule(state, 0);
    return true;
  }

  function trackState(record) {
    const key = recordKey(record);
    let state = tracks.get(key);
    if (!state) {
      if (tracks.size >= maxPendingKeys) {
        reject("MUSIC_PROGRESS_QUEUE_FULL", record);
        return null;
      }
      state = emergency?.key === key ? emergency : createState(key);
      if (emergency === state) emergency = null;
      tracks.set(key, state);
    }
    return state;
  }

  function createState(key) {
    return {
      key, latest: null, progressVersion: 0, pendingProgressVersion: 0,
      playedQueue: [], active: null, timer: null, timerDelayMs: null,
      ready: false, lastKind: "", keepaliveCount: 0, keepaliveRecord: null
    };
  }

  function promoteEmergency() {
    if (paused || !emergency || !hasPending(emergency)) return;
    const pending = emergency;
    let state = tracks.get(pending.key);
    if (!state) {
      if (tracks.size >= maxPendingKeys) return;
      state = pending;
      tracks.set(state.key, state);
    } else {
      state.latest = newerRecord(state.latest, pending.latest);
      state.progressVersion += 1;
      state.pendingProgressVersion = state.progressVersion;
    }
    emergency = null;
    schedule(state, 0);
  }

  function schedule(state, delayMs) {
    if (paused || state.active || state.ready || !hasPending(state)) return;
    const delay = Math.max(0, Number(delayMs) || 0);
    if (state.timer !== null) {
      if (state.timerDelayMs <= delay) return;
      cancelTimer(state.timer);
    }
    state.timerDelayMs = delay;
    state.timer = scheduleTimer(() => {
      state.timer = null;
      state.timerDelayMs = null;
      state.ready = true;
      ready.push(state);
      drain();
    }, delay);
  }

  function drain() {
    if (paused) return;
    while (activeCount < maxConcurrent && ready.length) {
      const state = ready.shift();
      state.ready = false;
      if (tracks.get(state.key) !== state || state.active || !hasPending(state)) continue;
      void dispatch(state);
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

  async function dispatch(state) {
    const action = nextAction(state);
    if (!action) return;
    const record = action.kind === "played" ? playedRecord(state.latest, action.token.record) : state.latest;
    state.active = { action, record };
    if (action.token) action.token.normalActive = true;
    state.lastKind = action.kind;
    activeCount += 1;
    let retry = false;
    try {
      await send(record, action.kind === "played");
      settleAction(state, action, true, record);
    } catch (error) {
      retry = isRetryableWriteBusy(error);
      if (!retry) {
        settleAction(state, action, false, record);
        notify(onError, error, record);
      }
    } finally {
      if (action.token) {
        action.token.normalActive = false;
        releaseToken(action.token);
      }
      state.active = null;
      activeCount -= 1;
      if (hasPending(state)) schedule(state, retry ? WRITE_BUSY_RETRY_DELAY_MS : 0);
      cleanup(state);
      drain();
    }
  }

  function settleAction(state, action, succeeded, record) {
    if (action.kind === "progress") {
      if (state.pendingProgressVersion === action.version) state.pendingProgressVersion = 0;
      return;
    }
    removeToken(state, action.token);
    if (succeeded) confirmPlayed(action.token, record);
    releaseToken(action.token);
  }

  function removeToken(state, token) {
    const index = state.playedQueue.indexOf(token);
    if (index >= 0) state.playedQueue.splice(index, 1);
    token.pending = false;
  }

  function confirmPlayed(token, record) {
    if (token.confirmed) return;
    token.confirmed = true;
    notify(onPlayed, record);
  }

  function releaseToken(token) {
    if (!token.pending && !token.normalActive && token.keepaliveCount === 0) playedTokens.delete(token.id);
  }

  function hasPending(state) {
    return state.pendingProgressVersion > 0 || state.playedQueue.length > 0;
  }

  function cleanup(state) {
    if (state.active || hasPending(state) || state.keepaliveCount) return;
    if (state.timer !== null) cancelTimer(state.timer);
    state.timer = null;
    state.ready = false;
    // A previous emergency may still have a leave Promise when a newer normal
    // state with the same key is admitted. It never owns that map entry.
    if (tracks.get(state.key) === state) tracks.delete(state.key);
    if (emergency === state) emergency = null;
    promoteEmergency();
  }

  function rememberAttempt(id) {
    attemptedPlayed.add(id);
    while (attemptedPlayed.size > maxPlayedTokens) attemptedPlayed.delete(attemptedPlayed.values().next().value);
  }

  function flushKeepalive(value) {
    // Leave delivery is best effort. Without this transport the old scheduling
    // contract is preserved, including any already running normal request.
    if (typeof sendKeepalive !== "function") return false;
    let current = null;
    let accepted = true;
    if (value) {
      current = capture(value);
      if (!current) accepted = false;
      else {
        let state = trackState(current);
        if (!state) {
          accepted = false;
          const key = recordKey(current);
          if (emergency?.key !== key) emergency = createState(key);
          state = emergency;
        }
        const latest = newerRecord(state.latest, current);
        if (!sameRecord(state.latest, latest)) {
          state.latest = latest;
          state.progressVersion += 1;
          state.pendingProgressVersion = state.progressVersion;
        }
        current = state.latest;
      }
    }
    if (!paused) leaveCycle += 1;
    paused = true;
    ready.length = 0;
    const states = [...tracks.values(), ...(emergency ? [emergency] : [])];
    for (const state of states) {
      if (state.timer !== null) cancelTimer(state.timer);
      state.timer = null;
      state.timerDelayMs = null;
      state.ready = false;
    }

    const currentKey = current && recordKey(current);
    const currentState = currentKey && (tracks.get(currentKey) || (emergency?.key === currentKey ? emergency : null));
    if (currentState) accepted = dispatchKeepalive(currentState, currentState.latest) && accepted;
    // Stable UUID receipts can safely duplicate an in-flight normal played
    // write. Legacy played writes stay in their normal queue and are not copied.
    for (const state of states) {
      for (const token of [...state.playedQueue]) {
        if (hasPlayedReceipt(token.record) && token.leaveCycle !== leaveCycle) {
          accepted = dispatchKeepalive(state, playedRecord(state.latest, token.record), token) && accepted;
        }
      }
    }
    for (const state of states) {
      if (state !== currentState) accepted = dispatchKeepalive(state, state.latest) && accepted;
    }
    return accepted;
  }

  function dispatchKeepalive(state, record, token = null) {
    if (!token && sameRecord(state.keepaliveRecord, record)) return true;
    const bytes = encoder.encode(JSON.stringify(record)).byteLength;
    if (keepaliveBytes + bytes > maxKeepaliveBytes || keepaliveCount >= maxPendingKeys + maxPlayedTokens) {
      return reject("MUSIC_PROGRESS_KEEPALIVE_FULL", record);
    }
    const version = state.pendingProgressVersion;
    const cycle = leaveCycle;
    state.keepaliveCount += 1;
    keepaliveCount += 1;
    keepaliveBytes += bytes;
    if (token) {
      token.keepaliveCount += 1;
      token.leaveCycle = cycle;
    } else state.keepaliveRecord = record;
    let receipt;
    try { receipt = sendKeepalive(record, Boolean(token)); }
    catch (error) { receipt = Promise.reject(error); }
    function unconfirmed(error) {
      if (!token && state.keepaliveRecord === record) state.keepaliveRecord = null;
      else if (token?.leaveCycle === cycle) token.leaveCycle = -1;
      notify(onError, error, record);
    }
    void Promise.resolve(receipt).then(data => {
      // Boolean admission (e.g. sendBeacon) is not a durable API receipt.
      if (!data || typeof data !== "object") {
        unconfirmed(Object.assign(new Error("音乐离页保存尚未确认"), { code: "MUSIC_PROGRESS_KEEPALIVE_UNCONFIRMED" }));
        return;
      }
      if (token) {
        removeToken(state, token);
        confirmPlayed(token, record);
      } else if (state.pendingProgressVersion === version) state.pendingProgressVersion = 0;
    }, unconfirmed).finally(() => {
      state.keepaliveCount -= 1;
      keepaliveCount -= 1;
      keepaliveBytes -= bytes;
      if (token) {
        token.keepaliveCount -= 1;
        releaseToken(token);
      }
      cleanup(state);
      if (!paused && hasPending(state)) schedule(state, 0);
    });
    return true;
  }

  function resume() {
    paused = false;
    promoteEmergency();
    for (const state of tracks.values()) {
      state.keepaliveRecord = null;
      if (hasPending(state)) schedule(state, 0);
    }
    drain();
  }

  function diagnostics() {
    return {
      active: activeCount, pendingKeys: tracks.size, playedTokens: playedTokens.size,
      pendingProgress: [...tracks.values()].filter(state => state.pendingProgressVersion > 0).length,
      timers: [...tracks.values()].filter(state => state.timer !== null).length,
      ready: ready.length, rememberedPlayed: attemptedPlayed.size, paused,
      emergencyPending: Boolean(emergency?.pendingProgressVersion), emergencyKey: emergency?.key || "",
      keepaliveActive: keepaliveCount, keepaliveBytes
    };
  }

  return { reportPlayed, save, flushKeepalive, resume, diagnostics };
}

function recordKey(record) {
  return JSON.stringify([record.activeUrl || "", record.trackId]);
}

function playedKey(record) {
  return JSON.stringify([record.activeUrl || "", record.trackId, record.playedReportId || record.reportKey]);
}

function playedRecord(latest, token) {
  return Object.freeze({
    ...latest, activeUrl: token.activeUrl, trackId: token.trackId,
    reportKey: token.reportKey, session: token.session,
    playedReportId: token.playedReportId, playedReportStartedAt: token.playedReportStartedAt,
    webAccountOwner: token.webAccountOwner, webAccountRevision: token.webAccountRevision,
    accountOrigin: token.accountOrigin, accountOwner: token.accountOwner,
    accountRevision: token.accountRevision, accountTokenKnown: token.accountTokenKnown
  });
}

function newerRecord(previous, current) {
  if (previous && previous.progressSessionId && previous.progressSessionId === current.progressSessionId
      && Number.isSafeInteger(previous.progressSequence) && Number.isSafeInteger(current.progressSequence)
      && previous.progressSequence > current.progressSequence) return previous;
  return current;
}

function sameRecord(left, right) {
  return Boolean(left && right) && RECORD_FIELDS.every(field => left[field] === right[field]);
}

function hasPlayedReceipt(record) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.playedReportId || "")
    && Number.isSafeInteger(record.playedReportStartedAt) && record.playedReportStartedAt > 0;
}

function copyRecord(value) {
  if (!value || typeof value.trackId !== "string" || !value.trackId) throw invalidRecord();
  const result = {};
  for (const field of RECORD_FIELDS) {
    const item = value[field];
    if (item === undefined) continue;
    if (item !== null && !["string", "number", "boolean"].includes(typeof item)) throw invalidRecord();
    if (typeof item === "number" && !Number.isFinite(item)) throw invalidRecord();
    const limit = field === "activeUrl" || field === "accountOrigin" ? 4096 : field === "trackId" || field === "reportKey" ? 512 : 128;
    if (typeof item === "string" && encoder.encode(item).byteLength > limit) throw invalidRecord();
    result[field] = item;
  }
  result.activeUrl = result.activeUrl || "";
  return Object.freeze(result);
}

function invalidRecord() {
  return Object.assign(new TypeError("Invalid music progress scalar record"), { code: "MUSIC_PROGRESS_RECORD_INVALID" });
}

export function isRetryableWriteBusy(error) {
  return Number(error?.status ?? error?.statusCode) === 503
    && error?.retryable === true
    && error?.code === "MUSIC_WRITE_BUSY";
}
