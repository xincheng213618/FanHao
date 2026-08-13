import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

parentPort?.postMessage({ type: "ready", ok: true });

parentPort?.on("message", (message) => {
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
