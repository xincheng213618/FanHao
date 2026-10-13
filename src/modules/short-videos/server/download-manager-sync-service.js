import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

export function createDownloadManagerSyncService({
  sourceDbPath,
  intervalMs,
  dbPath,
  ffmpegPath,
  roots,
  initialStateKey = "",
  onStateKey = () => {},
  onCatalogChanged = () => {},
  onItemsImported = () => {}
}) {
  const resolvedSourceDbPath = String(sourceDbPath || "").trim();
  const resolvedIntervalMs = Number(intervalMs || 0);
  let initialTimer = null;
  let timer = null;
  let continuationTimer = null;
  let running = false;
  let stopped = false;
  let activeWorker = null;
  let activeSyncPromise = null;
  let pendingForcedSync = null;
  let journalUpgradeReported = false;

  function start() {
    stopped = false;
    if (initialTimer || timer) return;
    if (!resolvedSourceDbPath || !Number.isFinite(resolvedIntervalMs) || resolvedIntervalMs < 60_000) return;
    const run = () => sync();
    initialTimer = setTimeout(() => {
      initialTimer = null;
      run();
    }, Math.min(30_000, resolvedIntervalMs));
    initialTimer.unref?.();
    timer = setInterval(run, resolvedIntervalMs);
    timer.unref?.();
  }

  function stop() {
    stopped = true;
    if (initialTimer) clearTimeout(initialTimer);
    if (timer) clearInterval(timer);
    if (continuationTimer) clearTimeout(continuationTimer);
    initialTimer = null;
    timer = null;
    continuationTimer = null;
    const worker = activeWorker;
    activeWorker = null;
    return worker ? worker.terminate().catch(() => undefined) : Promise.resolve();
  }

  function sync(options = {}) {
    if (stopped) return Promise.resolve(null);
    if (running) {
      if (!options.force) return Promise.resolve(null);
      if (!pendingForcedSync) {
        const observedSync = activeSyncPromise;
        pendingForcedSync = Promise.resolve(observedSync)
          .catch(() => null)
          .then(() => stopped ? null : runSync({ force: true }))
          .finally(() => {
            pendingForcedSync = null;
          });
      }
      return pendingForcedSync;
    }
    return runSync(options);
  }

  async function runSync(options = {}) {
    if (running || stopped) return null;
    const sourceStateKey = sourceDbStateKey(resolvedSourceDbPath);
    if (!sourceStateKey) return null;
    // File mtimes (especially WAL/SHM) are not business revisions. Every poll
    // checks the tiny journal head; unrelated jobs/settings writes cost no scan.
    running = true;
    const operation = performSync(options, sourceStateKey);
    activeSyncPromise = operation;
    try {
      return await operation;
    } finally {
      if (activeSyncPromise === operation) {
        activeSyncPromise = null;
        running = false;
      }
    }
  }

  async function performSync(options, sourceStateKey) {
    try {
      const result = await runWorker();
      if (!result || stopped) return null;
      if (result.requiresJournalUpgrade) {
        if (!journalUpgradeReported) console.warn("[short-video-sync]", result.message);
        journalUpgradeReported = true;
        return result;
      }
      journalUpgradeReported = false;
      if (result.advanced) onStateKey(sourceStateKey);
      if (result.catalogChanged || Number(result.catalogChanges || 0) > 0) onCatalogChanged(result, options);
      if (result.imported || result.updated) onItemsImported(result);
      if (result.hasMore && !stopped) {
        // Drain a bounded backlog without waiting a minute per page. Each
        // worker commits at most 500 changes, releasing the SQLite writer lock.
        if (continuationTimer) clearTimeout(continuationTimer);
        continuationTimer = setTimeout(() => {
          continuationTimer = null;
          sync();
        }, 100);
        continuationTimer.unref?.();
      }
      return result;
    } catch (error) {
      if (!stopped) console.warn("[short-video-sync]", error.message || error);
      return null;
    }
  }

  function runWorker() {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./sync-worker.js", import.meta.url), {
        workerData: {
          dbPath,
          ffmpegPath,
          roots,
          sourceDbPath: resolvedSourceDbPath
        }
      });
      activeWorker = worker;
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (activeWorker === worker) activeWorker = null;
        callback(value);
      };
      worker.once("message", (message) => {
        if (message?.ok) {
          finish(resolve, message.result || null);
          return;
        }
        const error = new Error(message?.error || "短视频后台同步失败");
        if (message?.stack) error.stack = message.stack;
        finish(reject, error);
      });
      worker.once("error", (error) => finish(reject, error));
      worker.once("exit", (code) => {
        if (settled) return;
        if (code !== 0) finish(reject, new Error(`短视频后台同步线程异常退出 (${code})`));
        else finish(resolve, null);
      });
    });
  }

  return {
    start,
    stop,
    sync
  };
}

function sourceDbStateKey(sourceDbPath) {
  const files = [sourceDbPath, `${sourceDbPath}-wal`];
  const parts = [];
  for (const filePath of files) {
    const stat = safeStat(filePath);
    if (!stat?.isFile()) continue;
    parts.push(`${path.basename(filePath)}:${stat.size}:${Math.floor(stat.mtimeMs || 0)}`);
  }
  return parts.length ? parts.join("|") : "";
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}
