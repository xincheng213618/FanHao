import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

if (!workerData.recovery && workerData.fixtureFault === "startup-exit") process.exit(17);
const postMessage = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = (message, ...args) => {
  if (!workerData.recovery && message?.type === "result" && message.ok) {
    if (workerData.fixtureFault === "exit-after-commit") process.exit(23);
    if (workerData.fixtureFault === "drop-reply") return;
  }
  return postMessage(message, ...args);
};

if (!workerData.recovery && ["exit-before-commit", "error-after-commit", "rollback-failure"].includes(workerData.fixtureFault)) {
  const exec = DatabaseSync.prototype.exec;
  let operationActive = false;
  DatabaseSync.prototype.exec = function (sql, ...args) {
    if (sql.includes("CREATE TABLE IF NOT EXISTS novel_write_receipts")) operationActive = true;
    if (sql === "COMMIT" && operationActive && workerData.fixtureFault === "exit-before-commit") process.exit(29);
    if (sql === "ROLLBACK" && operationActive && workerData.fixtureFault === "rollback-failure") throw new Error("controlled rollback failure");
    const result = exec.call(this, sql, ...args);
    if (sql === "COMMIT" && operationActive && workerData.fixtureFault === "error-after-commit") throw new Error("controlled failure after committed SQL");
    return result;
  };
}
await import("../../src/modules/novels/server/write-worker.js");
