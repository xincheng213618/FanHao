import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { createShortVideoStore } from "./store.js";

let store;
let message;
try {
  if (fs.statSync(workerData.sourceDbPath, { throwIfNoEntry: false })?.isFile()) {
    store = createShortVideoStore({
      dbPath: workerData.dbPath,
      ffmpegPath: workerData.ffmpegPath,
      roots: workerData.roots,
      skipStartupMaintenance: true
    });
    const result = store.importDownloadManagerDb(workerData.sourceDbPath, {
      incremental: true,
      requireChangeJournal: true,
      includePosts: true,
      skipSummary: true
    });
    message = { ok: true, result };
  } else {
    message = { ok: true, result: null };
  }
} catch (error) {
  message = {
    ok: false,
    error: String(error?.message || error),
    stack: String(error?.stack || "")
  };
} finally {
  store?.close();
}

parentPort?.postMessage(message);
parentPort?.close();
