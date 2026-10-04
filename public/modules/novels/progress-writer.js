const DEFAULT_PENDING_KEYS = 32;
const DEFAULT_EXPLICIT_WRITES = 8;

// Records contain scalar identities and a small JSON body. Navigation and
// session creation belong to the page; already sent writes are never aborted.
export function createNovelProgressWriter({
  send,
  sendKeepalive,
  onResult,
  onError,
  onSettled,
  maxPendingKeys = DEFAULT_PENDING_KEYS,
  maxExplicit = DEFAULT_EXPLICIT_WRITES
}) {
  if (typeof send !== "function" || typeof sendKeepalive !== "function") {
    throw new TypeError("Novel progress transports are required");
  }
  for (const capacity of [maxPendingKeys, maxExplicit]) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("Invalid novel progress capacity");
  }
  const automatic = new Map();
  const explicit = [];
  let active = null;
  let paused = false;

  function notify(callback, ...args) {
    // A view callback cannot prevent acknowledgement settlement or queue drain.
    try { callback?.(...args); } catch {}
  }

  function rejectCapacity(record) {
    const error = new Error("阅读进度保存队列暂忙，请稍后重试");
    error.code = "NOVEL_PROGRESS_QUEUE_FULL";
    notify(onError, record, error);
    notify(onSettled, record);
    return error;
  }

  function save(value, { explicit: needsReceipt = false } = {}) {
    const record = copyRecord(value, needsReceipt);
    const key = recordKey(record);
    if (needsReceipt) {
      if (explicit.length + Number(Boolean(active?.record.explicit)) >= maxExplicit) {
        return Promise.reject(rejectCapacity(record));
      }
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      explicit.push({ record, resolve, reject });
      paused = false;
      drain();
      return promise;
    }
    if (!automatic.has(key) && automatic.size >= maxPendingKeys) {
      rejectCapacity(record);
      return;
    }
    automatic.set(key, { record });
    paused = false;
    drain();
  }

  function drain() {
    if (paused || active) return;
    const next = explicit.shift() || automatic.values().next().value;
    if (!next) return;
    if (!next.record.explicit) automatic.delete(recordKey(next.record));
    active = next;
    void dispatch(next);
  }

  async function dispatch(entry) {
    try {
      const data = await send(entry.record);
      notify(onResult, entry.record, data);
      entry.resolve?.(data);
    } catch (error) {
      notify(onError, entry.record, error);
      entry.reject?.(error);
    } finally {
      notify(onSettled, entry.record);
      active = null;
      drain();
    }
  }

  function flushKeepalive(value) {
    paused = true;
    const latest = new Map();
    if (active && !active.record.explicit) latest.set(recordKey(active.record), active.record);
    for (const [key, entry] of automatic) latest.set(key, newerRecord(latest.get(key), entry.record));
    if (value) {
      const current = copyRecord(value, false);
      const key = recordKey(current);
      latest.set(key, newerRecord(latest.get(key), current));
    }
    automatic.clear();
    for (const record of latest.values()) {
      // Start synchronously: pagehide cannot wait for the normal Promise queue.
      let receipt;
      try { receipt = sendKeepalive(record); }
      catch (error) {
        notify(onError, record, error);
        notify(onSettled, record);
        continue;
      }
      void Promise.resolve(receipt).then(
        data => notify(onResult, record, data),
        error => notify(onError, record, error)
      ).then(() => notify(onSettled, record));
    }
  }

  function resume() {
    paused = false;
    drain();
  }

  return { save, flushKeepalive, resume };
}

function recordKey(record) {
  return JSON.stringify([
    record.bookId,
    record.sourceRealm ?? record.body.sourceRealm ?? "",
    record.catalogRevision ?? record.body.catalogRevision ?? ""
  ]);
}

function newerRecord(previous, current) {
  if (previous && previous.body.progressSessionId === current.body.progressSessionId
      && Number.isSafeInteger(previous.body.progressSequence) && Number.isSafeInteger(current.body.progressSequence)
      && previous.body.progressSequence > current.body.progressSequence) return previous;
  return current;
}

function copyRecord(value, explicit) {
  if (!value || typeof value !== "object" || !value.bookId || !value.body || typeof value.body !== "object") {
    throw new TypeError("Invalid novel progress record");
  }
  const body = copyScalars(value.body);
  const record = copyScalars(value, "body");
  return Object.freeze({ ...record, body: Object.freeze(body), explicit: Boolean(explicit) });
}

function copyScalars(value, omit) {
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === omit) continue;
    if (item !== null && !["string", "number", "boolean", "undefined"].includes(typeof item)) {
      throw new TypeError("Novel progress records must contain scalar values");
    }
    if (typeof item === "number" && !Number.isFinite(item)) throw new TypeError("Invalid novel progress number");
    result[key] = item;
  }
  return result;
}
