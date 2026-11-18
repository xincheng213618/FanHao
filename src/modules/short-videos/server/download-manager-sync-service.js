import { Worker } from "node:worker_threads";

export function createDownloadManagerSyncService({
  sourceDbPath,
  intervalMs,
  dbPath,
  ffmpegPath,
  roots,
  WorkerCtor = Worker,
  syncTimeoutMs = 60_000,
  workerCloseTimeoutMs = 2_000,
  onCatalogChanged = () => {},
  onItemsImported = () => {}
}) {
  const resolvedSourceDbPath = String(sourceDbPath || "").trim();
  const resolvedIntervalMs = Number(intervalMs || 0);
  const syncDeadline = Math.max(1, Math.min(600_000, Math.trunc(Number(syncTimeoutMs) || 60_000)));
  const closeDeadline = Math.max(1, Math.min(60_000, Math.trunc(Number(workerCloseTimeoutMs) || 2_000)));
  let initialTimer = null;
  let timer = null;
  let continuationTimer = null;
  let running = false;
  let stopped = false;
  let generation = 0;
  let activeWorker = null;
  let stopPromise = null;
  let activeSyncPromise = null;
  let pendingForcedSync = null;
  let journalUpgradeReported = false;
  let catalogRefreshPending = false;

  function start() {
    stopped = false;
    refreshUnconfirmedCatalog();
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
    if (!stopped) generation += 1;
    stopped = true;
    if (initialTimer) clearTimeout(initialTimer);
    if (timer) clearInterval(timer);
    if (continuationTimer) clearTimeout(continuationTimer);
    initialTimer = null;
    timer = null;
    continuationTimer = null;
    pendingForcedSync = null;
    if (stopPromise) return stopPromise;
    if (!activeWorker) return Promise.resolve();
    const current = activeWorker;
    retireWorker(current, new Error("短视频后台同步已停止"));
    let deadline;
    stopPromise = Promise.race([
      current.exited,
      new Promise((_, reject) => { deadline = setTimeout(() => reject(workerCloseError()), closeDeadline); })
    ]).finally(() => { clearTimeout(deadline); stopPromise = null; });
    return stopPromise;
  }

  function sync(options = {}) {
    if (stopped || activeWorker?.retiring) return Promise.resolve(null);
    if (running) {
      if (!options.force) return Promise.resolve(null);
      if (!pendingForcedSync) {
        const observedSync = activeSyncPromise;
        const intent = generation;
        const queued = Promise.resolve(observedSync)
          .catch(() => null)
          .then(() => intent === generation ? runSync({ force: true }) : null)
          .finally(() => {
            if (pendingForcedSync === queued) pendingForcedSync = null;
          });
        pendingForcedSync = queued;
      }
      return pendingForcedSync;
    }
    return runSync(options);
  }

  async function runSync(options = {}) {
    if (running || stopped || activeWorker || !resolvedSourceDbPath) return null;
    // File mtimes (especially WAL/SHM) are not business revisions. Every poll
    // checks the tiny journal head; unrelated jobs/settings writes cost no scan.
    running = true;
    const operation = performSync(options, generation);
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

  async function performSync(options, intent) {
    try {
      const result = await runWorker();
      if (!result || stopped || intent !== generation) return null;
      if (result.requiresJournalUpgrade) {
        if (!journalUpgradeReported) console.warn("[short-video-sync]", result.message);
        journalUpgradeReported = true;
        return result;
      }
      journalUpgradeReported = false;
      if (result.catalogChanged || Number(result.catalogChanges || 0) > 0) onCatalogChanged(result, options);
      if (result.imported || result.updated) onItemsImported(result);
      if (result.hasMore && !stopped && intent === generation) {
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
      if (!stopped && intent === generation) console.warn("[short-video-sync]", error.message || error);
      return null;
    }
  }

  function runWorker() {
    return new Promise((resolve, reject) => {
      const worker = new WorkerCtor(new URL("./sync-worker.js", import.meta.url), {
        workerData: {
          dbPath,
          ffmpegPath,
          roots,
          sourceDbPath: resolvedSourceDbPath
        }
      });
      const { promise: exited, resolve: confirmExit } = Promise.withResolvers();
      const current = { worker, exited, reject, retiring: false };
      activeWorker = current;
      let message;
      current.deadline = setTimeout(() => retireWorker(current, new Error("短视频后台同步超时")), syncDeadline);
      worker.once("message", (reply) => { message = reply; });
      worker.once("error", (error) => retireWorker(current, error));
      worker.once("exit", (code) => {
        clearTimeout(current.deadline);
        if (activeWorker === current) activeWorker = null;
        confirmExit();
        if (current.retiring) { refreshUnconfirmedCatalog(); return; }
        if (code !== 0) { reject(new Error(`短视频后台同步线程异常退出 (${code})`)); return; }
        if (!message || message.ok) { resolve(message?.result ?? null); return; }
        const error = new Error(message.error || "短视频后台同步失败");
        if (message.stack) error.stack = message.stack;
        reject(error);
      });
    });
  }

  function retireWorker(current, error) {
    if (activeWorker !== current || current.retiring) return;
    current.retiring = true;
    clearTimeout(current.deadline);
    catalogRefreshPending = true;
    current.reject(error);
    // Only the Worker exit releases the SQLite owner.
    try { Promise.resolve(current.worker.terminate()).catch(() => {}); }
    catch { /* Keep the owner until exit. */ }
  }

  function refreshUnconfirmedCatalog() {
    if (stopped || activeWorker || !catalogRefreshPending) return;
    catalogRefreshPending = false;
    // A cursor commit may have preceded a lost result. Re-read the catalog
    // after the old owner exits instead of trusting its missing change count.
    try { onCatalogChanged({ uncertain: true }); }
    catch (error) { console.warn("[short-video-sync]", error.message || error); }
  }

  return {
    start,
    stop,
    sync
  };
}

function workerCloseError() {
  return Object.assign(new Error("短视频后台同步线程尚未退出"), { code: "SHORT_VIDEO_SYNC_CLOSE_UNCONFIRMED" });
}
