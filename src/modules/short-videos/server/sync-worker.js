import { parentPort, workerData } from "node:worker_threads";
import { createShortVideoStore } from "./store.js";

const store = createShortVideoStore({
  dbPath: workerData.dbPath,
  ffmpegPath: workerData.ffmpegPath,
  roots: workerData.roots,
  skipStartupMaintenance: true
});

try {
  const result = store.importDownloadManagerDb(workerData.sourceDbPath, {
    incremental: true,
    includePosts: true,
    skipSummary: true
  });
  parentPort?.postMessage({ ok: true, result });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: String(error?.message || error),
    stack: String(error?.stack || "")
  });
} finally {
  store.close();
}
