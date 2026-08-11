import { parentPort, workerData } from "node:worker_threads";

const attempts = new Int32Array(workerData.attemptBuffer);
const waitState = new Int32Array(new SharedArrayBuffer(4));

parentPort?.postMessage({ type: "ready", ok: true });
parentPort?.on("message", (message) => {
  if (message?.type === "list") {
    if (workerData.listMode === "exit") process.exit(29);
    if (workerData.listMode === "error") {
      parentPort?.postMessage({
        ok: false,
        id: message.id,
        error: "failed to open C:\\Users\\private-user\\secret-catalog.sqlite",
        stack: "Error: private worker stack"
      });
      return;
    }
    parentPort?.postMessage({ ok: true, id: message.id, data: { stats: null, videos: [] } });
    return;
  }
  if (message?.type !== "stats") return;
  const attempt = Atomics.add(attempts, 0, 1);
  if (attempt === 0 && workerData.failFirst !== false) {
    process.exit(23);
  }
  const delayMs = Math.max(0, Number(workerData.delayMs || 0));
  if (delayMs) Atomics.wait(waitState, 0, 0, delayMs);
  const likes = workerData.valueBuffer
    ? Atomics.load(new Int32Array(workerData.valueBuffer), 0)
    : 11;
  parentPort?.postMessage({
    ok: true,
    id: message.id,
    data: {
      likes,
      comments: 12,
      collects: 13,
      shares: 14,
      plays: 15,
      bytes: 16,
      durationMs: 17
    }
  });
});
