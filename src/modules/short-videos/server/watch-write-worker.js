import { parentPort, workerData } from "node:worker_threads";
import { createShortVideoStore } from "./store.js";

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
  if (message?.type !== "record") return;
  try {
    const data = store.recordWatch(message.videoId, message.options || {});
    parentPort?.postMessage({ ok: true, id: message.id, data });
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      id: message.id,
      busy: isSqliteBusy(error),
      code: String(error?.code || ""),
      statusCode: Number(error?.statusCode || 0),
      error: String(error?.message || error)
    });
  }
});

process.once("beforeExit", () => store.close());

function isSqliteBusy(error) {
  return Number(error?.errcode) === 5
    || Number(error?.errno) === 5
    || String(error?.code || "").toUpperCase() === "SQLITE_BUSY"
    || /database is locked|database table is locked|SQLITE_BUSY/i.test(String(error?.message || error));
}
