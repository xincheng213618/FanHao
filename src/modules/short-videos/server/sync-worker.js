import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { createShortVideoStore } from "./store.js";

let store;
let message;
try {
  const sourceStateKey = sourceDbStateKey(workerData.sourceDbPath);
  if (sourceStateKey) {
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
    message = { ok: true, result, sourceStateKey };
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

function sourceDbStateKey(sourceDbPath) {
  const parts = [];
  for (const filePath of [sourceDbPath, `${sourceDbPath}-wal`]) {
    try {
      const stat = fs.statSync(filePath, { throwIfNoEntry: false });
      if (stat?.isFile()) parts.push(`${path.basename(filePath)}:${stat.size}:${Math.floor(stat.mtimeMs || 0)}`);
    } catch { /* A missing or unavailable source can be retried by a later poll. */ }
  }
  return parts.join("|");
}
