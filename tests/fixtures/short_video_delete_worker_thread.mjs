import { parentPort, workerData } from "node:worker_threads";
import path from "node:path";

import { createShortVideoStore } from "../../src/modules/short-videos/server/store.js";

if (!parentPort || !workerData?.dbPath || !workerData?.root || !workerData?.role) {
  throw new Error("short video delete worker fixture requires parentPort, dbPath, root, and role");
}

const store = createShortVideoStore({
  dbPath: workerData.dbPath,
  coverDbPath: workerData.coverDbPath,
  coverCacheDir: path.join(workerData.root, "covers"),
  roots: [workerData.root],
  skipStartupMaintenance: true,
  deleteJobWarn() {},
  deleteJobTestHooks: workerData.role === "execute" ? {
    async afterItemIsolationIntent({ jobId, ordinal }) {
      parentPort.postMessage({ type: "paused", jobId, ordinal, pid: process.pid });
      await new Promise((resolve) => {
        const onMessage = (message) => {
          if (message?.type === "close") {
            parentPort.postMessage({ type: "close-result", closed: store.close() });
            return;
          }
          if (message?.type !== "resume") return;
          parentPort.off("message", onMessage);
          resolve();
        };
        parentPort.on("message", onMessage);
      });
    }
  } : {}
});

try {
  store.summary();
  if (workerData.role === "execute") {
    const result = await store.deleteVideo(workerData.videoId);
    parentPort.postMessage({ type: "finished", result, pid: process.pid });
  } else if (workerData.role === "recover") {
    const result = await store.recoverDeleteJobs({ jobId: workerData.jobId });
    parentPort.postMessage({ type: "recovered", result, pid: process.pid });
  } else {
    throw new Error(`unknown worker role: ${workerData.role}`);
  }
} catch (error) {
  parentPort.postMessage({
    type: "error",
    message: String(error?.message || error),
    code: String(error?.code || ""),
    stack: String(error?.stack || "")
  });
  process.exitCode = 1;
} finally {
  store.close();
}
