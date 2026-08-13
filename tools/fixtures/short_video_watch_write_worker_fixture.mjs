import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

if (workerData.mode === "start-error") throw new Error("fixture worker start failure");

let closeAttempts = 0;
parentPort?.postMessage({ type: "ready", ok: true });

parentPort?.on("message", (message) => {
  if (message?.type === "close") {
    closeAttempts += 1;
    if (workerData.mode === "close-false-once" && closeAttempts === 1) {
      parentPort?.postMessage({ type: "closed", id: message.id, ok: false, error: "fixture close returned false" });
      return;
    }
    if (workerData.mode === "close-throw-once" && closeAttempts === 1) {
      try {
        throw new Error("fixture close threw");
      } catch (error) {
        parentPort?.postMessage({ type: "closed", id: message.id, ok: false, error: error.message });
      }
      return;
    }
    parentPort?.postMessage({ type: "closed", id: message.id, ok: true });
    return;
  }
  if (message?.type === "receipt") {
    parentPort?.postMessage({ id: message.id, ok: true, data: null });
    return;
  }
  if (message?.type !== "record") return;
  if (workerData.mode === "hang") return;
  if (workerData.mode === "crash-always") process.exit(24);
  if (workerData.mode === "crash-once") {
    if (!fs.existsSync(workerData.markerPath)) {
      fs.writeFileSync(workerData.markerPath, "crashed");
      process.exit(23);
    }
  }
  parentPort?.postMessage({
    id: message.id,
    ok: true,
    data: {
      ok: true,
      videoId: message.videoId,
      watch: {
        progressMs: Number(message.options?.progressMs || 0),
        completedCount: message.options?.completed === true ? 1 : 0,
        completed: message.options?.completed === true,
        lastWatchedAt: message.options?.acceptedAt || ""
      }
    }
  });
});
