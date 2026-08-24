import { parentPort, workerData } from "node:worker_threads";
import { createShortVideoStore } from "./store.js";

const delayState = new Int32Array(new SharedArrayBuffer(4));
let store = null;

parentPort?.on("message", (message) => {
  if (message?.type === "close") {
    closeStore();
    parentPort?.close();
    return;
  }
  if (!["count", "candidates"].includes(message?.type)) return;
  try {
    applyTestDelay();
    const catalogStore = storeOrOpen();
    const data = message.type === "count"
      ? catalogStore.smoothPlaybackCandidateCount()
      : catalogStore.smoothPlaybackCandidates(message.limit, message.offset);
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

function applyTestDelay() {
  const delayMs = Math.max(0, Number(workerData.queryDelayMs || 0));
  if (delayMs) Atomics.wait(delayState, 0, 0, delayMs);
}

function closeStore() {
  try { store?.close(); } catch {}
  store = null;
}

process.once("beforeExit", closeStore);
