import { parentPort, workerData } from "node:worker_threads";

parentPort?.postMessage({ type: "ready", ok: true });

parentPort?.on("message", (message) => {
  if (message?.type !== "scan") return;
  if (workerData.mode === "hang") {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    return;
  }
  process.exit(Number(workerData.exitCode || 17));
});
