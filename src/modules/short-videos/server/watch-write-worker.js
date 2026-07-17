import { parentPort, workerData } from "node:worker_threads";
import { createShortVideoStore } from "./store.js";

const store = createShortVideoStore({
  dbPath: workerData.dbPath,
  downloadManagerDbPath: workerData.downloadManagerDbPath,
  ffmpegPath: workerData.ffmpegPath,
  roots: workerData.roots,
  skipStartupMaintenance: true,
  trustExplicitInvalidation: true
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
      statusCode: Number(error?.statusCode || 0),
      error: String(error?.message || error),
      stack: String(error?.stack || "")
    });
  }
});

process.once("beforeExit", () => store.close());
