import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

import { createShortVideoStore } from "../../src/modules/short-videos/server/store.js";

const store = createShortVideoStore({
  dbPath: workerData.dbPath,
  downloadManagerDbPath: workerData.downloadManagerDbPath,
  ffmpegPath: workerData.ffmpegPath,
  roots: workerData.roots,
  busyTimeoutMs: workerData.busyTimeoutMs,
  skipStartupMaintenance: true,
  trustExplicitInvalidation: true,
  trustWatchAcceptedAt: true
});

parentPort?.postMessage({ type: "ready", ok: true });

parentPort?.on("message", (message) => {
  if (message?.type === "close") {
    try {
      store.close();
      parentPort?.postMessage({ type: "closed", id: message.id, ok: true });
    } catch (error) {
      parentPort?.postMessage({ type: "closed", id: message.id, ok: false, error: String(error?.message || error) });
    }
    return;
  }
  if (message?.type === "receipt") {
    try {
      parentPort?.postMessage({
        id: message.id,
        ok: true,
        data: store.watchReceipt(message.videoId, message.acceptedAt)
      });
    } catch (error) {
      parentPort?.postMessage({ id: message.id, ok: false, error: String(error?.message || error) });
    }
    return;
  }
  if (message?.type !== "record") return;
  if (workerData.mode === "delayed-commit-exit") {
    setTimeout(() => {
      store.recordWatch(message.videoId, message.options || {});
      fs.appendFileSync(workerData.recordLogPath, `${message.videoId}\n`);
      process.exit(28);
    }, Math.max(1, Number(workerData.delayMs || 100)));
    return;
  }
  const data = store.recordWatch(message.videoId, message.options || {});
  fs.appendFileSync(workerData.recordLogPath, `${message.videoId}\n`);
  if (workerData.mode === "commit-before-ack") process.exit(27);
  parentPort?.postMessage({ id: message.id, ok: true, data });
});
