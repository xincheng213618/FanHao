import { parentPort, workerData } from "node:worker_threads";
import { createNovelStore, novelWriteOperationHash } from "./store.js";

const store = createNovelStore({
  dbPath: workerData.dbPath,
  reimportArtifactRoot: workerData.reimportArtifactRoot,
  onWriteOperationStart: (operation) => parentPort.postMessage({ type: "started", ...operation })
});

try {
  const identity = workerData.recovery || workerData.cleanupOnly ? {} : store.writeIdentityRecord();
  parentPort.postMessage({ type: "ready", ...identity });
} catch (error) {
  parentPort.postMessage({ type: "startup-error", ...serializeError(error) });
  parentPort.close();
}

parentPort.on("message", (message) => {
  if (!["write", "receipt", "acknowledge"].includes(message?.type)) return;
  try {
    const operation = message.operation;
    const data = message.type === "write"
      ? store.executeWriteOperation(operation)
      : message.type === "acknowledge"
        ? store.releaseWriteReceipts(operation.acknowledgedReceipts)
        : store.readWriteReceipt({
          ...operation,
          requestHash: novelWriteOperationHash(operation.method, operation.args)
        });
    parentPort.postMessage({ type: "result", operationId: operation.operationId, ok: true, data });
  } catch (error) {
    parentPort.postMessage({ type: "result", ok: false, ...serializeError(error), operationId: message.operation?.operationId });
  } finally {
    store.invalidate();
  }
});

function serializeError(error) {
  return { error: String(error?.message || error), code: String(error?.code || ""), statusCode: Number(error?.statusCode || 500),
    ...(error?.outcome ? { outcome: error.outcome } : {}),
    ...(error?.operationId ? { operationId: error.operationId } : {}),
    ...(error?.rollbackConfirmed ? { rollbackConfirmed: true } : {}) };
}
