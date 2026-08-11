import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { createShortVideoStore } from "./store.js";
import { normalizeShortVideoStatsFilter, queryShortVideoStats } from "./stats-query.js";

const BUSY_RETRY_DELAYS_MS = [40, 80, 160];
const busyWaitState = new Int32Array(new SharedArrayBuffer(4));
let store = null;
let statsDatabase = null;

parentPort?.postMessage({ type: "ready", ok: true });

parentPort?.on("message", (message) => {
  if (message?.type === "reset") {
    closeResources();
    return;
  }
  if (message?.type === "resetStats") {
    closeStatsDatabase();
    return;
  }
  if (message?.type === "resetLikeDistribution") {
    closeStore();
    return;
  }
  if (message?.type === "close") {
    closeResources();
    parentPort?.close();
    return;
  }
  if (message?.type === "stats") {
    handleStats(message);
    return;
  }
  if (message?.type === "likeDistribution") {
    handleLikeDistribution(message);
    return;
  }
  if (!["list", "authors", "facets"].includes(message?.type)) return;
  try {
    const url = new URL(message.url);
    const catalogStore = storeOrOpen();
    const data = message.type === "authors"
      ? catalogStore.listAuthors(url)
      : message.type === "facets"
        ? catalogStore.facets()
        : catalogStore.listVideos(url);
    parentPort?.postMessage({ ok: true, id: message.id, data });
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      id: message.id,
      error: String(error?.message || error),
      stack: String(error?.stack || "")
    });
  }
});

function handleStats(message) {
  try {
    const filter = normalizeShortVideoStatsFilter(message?.filter || {});
    const data = runStatsBusyRetry(() => queryShortVideoStats(statsDatabaseOrOpen(), filter));
    parentPort?.postMessage({ ok: true, id: message.id, data });
  } catch (error) {
    const details = publicStatsError(error);
    parentPort?.postMessage({
      ok: false,
      id: message.id,
      error: details.message,
      errorCode: details.code,
      retryable: details.retryable
    });
  }
}

function handleLikeDistribution(message) {
  try {
    const delayMs = Math.max(0, Number(workerData.likeDistributionDelayMs || 0));
    if (delayMs) Atomics.wait(busyWaitState, 0, 0, delayMs);
    const data = runStatsBusyRetry(() => storeOrOpen().likeDistribution({
      catalogStamp: String(message?.catalogStamp || "")
    }));
    parentPort?.postMessage({ ok: true, id: message.id, data });
  } catch (error) {
    const details = publicStatsError(error);
    parentPort?.postMessage({
      ok: false,
      id: message.id,
      error: details.message,
      errorCode: details.code,
      // SQLITE_BUSY has already exhausted the bounded worker-local retry loop.
      // Keep the public 503 retryable without repeating the whole loop here.
      retryable: details.code === "SHORT_VIDEO_DATABASE_BUSY" ? false : details.retryable
    });
  }
}

function storeOrOpen() {
  if (!store) {
    store = createShortVideoStore({
      dbPath: workerData.dbPath,
      downloadManagerDbPath: workerData.downloadManagerDbPath,
      ffmpegPath: workerData.ffmpegPath,
      roots: workerData.roots,
      skipStartupMaintenance: true,
      trustExplicitInvalidation: true,
      readOnly: true,
      busyTimeoutMs: 250
    });
  }
  return store;
}

function statsDatabaseOrOpen() {
  if (!statsDatabase) {
    const database = new DatabaseSync(workerData.dbPath, { readOnly: true });
    try {
      database.exec(`
        PRAGMA busy_timeout = 250;
        PRAGMA mmap_size = 268435456;
        PRAGMA cache_size = -32768;
        PRAGMA temp_store = MEMORY;
        PRAGMA query_only = ON;
      `);
      statsDatabase = database;
    } catch (error) {
      try { database.close(); } catch {}
      throw error;
    }
  }
  return statsDatabase;
}

function runStatsBusyRetry(operation) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!isSqliteBusy(error) || attempt >= BUSY_RETRY_DELAYS_MS.length) throw error;
      Atomics.wait(busyWaitState, 0, 0, BUSY_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function publicStatsError(error) {
  const message = String(error?.message || error || "");
  if (isSqliteBusy(error)) {
    return {
      code: "SHORT_VIDEO_DATABASE_BUSY",
      message: "短视频数据库正在恢复，请稍后重试",
      retryable: true
    };
  }
  if (/database disk image|malformed|not a database|sqlite|database/i.test(message)) {
    return {
      code: "SHORT_VIDEO_DATABASE_UNAVAILABLE",
      message: "短视频数据库正在恢复，请稍后重试",
      retryable: false
    };
  }
  return {
    code: "SHORT_VIDEO_STATS_WORKER_FAILED",
    message: "短视频统计后台线程暂时不可用",
    retryable: false
  };
}

function isSqliteBusy(error) {
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(`${String(error?.code || "")} ${String(error?.message || error || "")}`);
}

function closeStatsDatabase() {
  if (!statsDatabase) return;
  try { statsDatabase.close(); } catch {}
  statsDatabase = null;
}

function closeResources() {
  closeStatsDatabase();
  closeStore();
}

function closeStore() {
  try { store?.close(); } catch {}
  store = null;
}

process.once("beforeExit", closeResources);
