import { parentPort, workerData } from "node:worker_threads";

const attempts = workerData.attemptBuffer
  ? new Int32Array(workerData.attemptBuffer)
  : new Int32Array(new SharedArrayBuffer(4));
const waitState = new Int32Array(new SharedArrayBuffer(4));

parentPort?.postMessage({ type: "ready", ok: true });
parentPort?.on("message", (message) => {
  if (message?.type === "reset" || message?.type === "resetLikeDistribution") return;
  if (message?.type !== "likeDistribution") return;
  const attempt = Atomics.add(attempts, 0, 1);
  if (workerData.mode === "crash-first" && attempt === 0) process.exit(31);
  if (workerData.mode === "hang") return;
  if (workerData.mode === "path-error") {
    parentPort?.postMessage({
      ok: false,
      id: message.id,
      error: "failed to open C:\\Users\\private-user\\secret-catalog.sqlite",
      stack: "Error: private worker stack",
      errorCode: "SHORT_VIDEO_LIKE_DISTRIBUTION_FAILED",
      retryable: false
    });
    return;
  }
  const delayMs = Math.max(0, Number(workerData.delayMs || 0));
  if (delayMs) Atomics.wait(waitState, 0, 0, delayMs);
  const revision = workerData.valueBuffer
    ? Atomics.load(new Int32Array(workerData.valueBuffer), 0)
    : 1;
  parentPort?.postMessage({
    ok: true,
    id: message.id,
    data: {
      total: revision,
      knownLikesTotal: revision,
      unknownLikesTotal: 0,
      shape: "right_skewed_long_tail",
      binning: {},
      generatedAt: "2026-08-12T00:00:00.000Z",
      bins: [],
      insights: { revision }
    }
  });
});
