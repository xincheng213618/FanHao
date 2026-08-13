import { parentPort, workerData } from "node:worker_threads";
import path from "node:path";

import { createShortVideoStore } from "../../src/modules/short-videos/server/store.js";

if (!parentPort || !workerData?.dbPath || !workerData?.root || !workerData?.videoId || !workerData?.operationId) {
  throw new Error("short video delete idempotency worker fixture is incomplete");
}

let resume = null;
let fsExecutorCalls = 0;
const store = createShortVideoStore({
  dbPath: workerData.dbPath,
  coverDbPath: workerData.coverDbPath,
  coverCacheDir: path.join(workerData.root, "covers"),
  roots: [workerData.root],
  skipStartupMaintenance: true,
  deleteJobWarn() {},
  deleteJobTestHooks: {
    async beforePlanTransaction() {
      if (!workerData.pauseBeforePlan) return;
      parentPort.postMessage({ type: "before-plan" });
      await new Promise((resolve) => { resume = resolve; });
    },
    async afterPlanPersisted({ id }) {
      fsExecutorCalls += 1;
      if (!workerData.pauseAfterPlan) return;
      parentPort.postMessage({ type: "paused", jobId: id });
      await new Promise((resolve) => { resume = resolve; });
    }
  }
});

parentPort.on("message", (message) => {
  if (message?.type === "resume" && resume) {
    const resolve = resume;
    resume = null;
    resolve();
  }
});

try {
  store.summary();
  const result = await store.deleteVideo(workerData.videoId, {
    deleteFiles: workerData.deleteFiles !== false,
    operationId: workerData.operationId
  });
  parentPort.postMessage({ type: "finished", result, fsExecutorCalls });
} catch (error) {
  parentPort.postMessage({
    type: "error",
    code: String(error?.code || ""),
    message: String(error?.message || "")
  });
  process.exitCode = 1;
} finally {
  store.close();
  parentPort.close();
}
