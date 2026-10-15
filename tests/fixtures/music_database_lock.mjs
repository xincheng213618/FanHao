import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

const database = new DatabaseSync(String(workerData.dbPath || ""));
try {
  database.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");
  parentPort?.postMessage({ type: "locked" });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(workerData.holdMs || 150));
  database.exec("ROLLBACK");
  parentPort?.postMessage({ type: "released" });
} finally {
  database.close();
}
