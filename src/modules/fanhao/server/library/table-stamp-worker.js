import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { attachCoreImageStore } from "../../../../platform/server/core-image-store.js";
import { readTableStampRow } from "./table-stamp-query.js";

const db = new DatabaseSync(workerData.dbPath);
db.exec("PRAGMA busy_timeout = 5000;");
attachCoreImageStore(db, { dbPath: workerData.imageDbPath, ensureSchema: false });
db.exec("PRAGMA query_only = ON;");

parentPort?.on("message", (message) => {
  const id = Number(message?.id || 0);
  if (!id || !message?.table) return;

  try {
    parentPort.postMessage({ id, ok: true, row: readTableStampRow(db, String(message.table)) });
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: String(error?.message || error),
      stack: String(error?.stack || "")
    });
  }
});

process.once("beforeExit", () => db.close());
