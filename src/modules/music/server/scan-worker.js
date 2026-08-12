import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { scanMusicRoots, scanSummary, writeScanRecords } from "./scan.js";
import { configureMusicDatabase, ensureSchema } from "./schema.js";

parentPort?.postMessage({ type: "ready", ok: true });

parentPort?.on("message", (message) => {
  if (message?.type === "close") {
    parentPort?.close();
    return;
  }
  if (message?.type !== "scan") return;
  runScan(message);
});

function runScan(message) {
  try {
    const request = message.request || {};
    const roots = Array.isArray(request.roots) ? request.roots.map(String) : [];
    const dryRun = Boolean(request.dryRun);
    const records = scanMusicRoots(roots, {
      ffprobePath: workerData.ffprobePath,
      ffprobeTimeoutMs: workerData.ffprobeTimeoutMs,
      ffprobeArgsPrefix: workerData.ffprobeArgsPrefix,
      limit: request.limit
    });
    const result = scanSummary(records, roots, dryRun);
    if (!dryRun) publishScan(message.id, records, roots, result.scannedAt);
    parentPort?.postMessage({ type: "result", id: message.id, ok: true, data: result });
  } catch (error) {
    const details = publicScanError(error);
    parentPort?.postMessage({
      type: "result",
      id: message.id,
      ok: false,
      error: details.message,
      errorCode: details.code,
      statusCode: details.statusCode
    });
  }
}

function publishScan(requestId, records, roots, scannedAt) {
  const dbPath = String(workerData.dbPath || "");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const database = new DatabaseSync(dbPath);
  let transactionActive = false;
  try {
    configureMusicDatabase(database, { busyTimeoutMs: workerData.busyTimeoutMs });
    database.exec("BEGIN IMMEDIATE");
    transactionActive = true;
    parentPort?.postMessage({ type: "phase", id: requestId, phase: "publishing" });
    const publishDelayMs = Math.min(5_000, Math.max(0, Math.trunc(Number(workerData.publishDelayMs || 0))));
    if (publishDelayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, publishDelayMs);
    ensureSchema(database, { configureConnection: false });
    writeScanRecords(database, records, roots, scannedAt, { manageTransaction: false });
    database.exec("COMMIT");
    transactionActive = false;
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (error) {
    if (transactionActive) {
      try { database.exec("ROLLBACK"); } catch {}
    }
    throw error;
  } finally {
    database.close();
  }
}

function publicScanError(error) {
  const value = `${String(error?.code || "")} ${String(error?.message || error || "")}`;
  if (/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(value)) {
    return {
      code: "MUSIC_SCAN_DATABASE_BUSY",
      message: "音乐索引正在被占用，请稍后重试",
      statusCode: 503
    };
  }
  if (/database disk image|malformed|not a database|sqlite/i.test(value)) {
    return {
      code: "MUSIC_SCAN_DATABASE_UNAVAILABLE",
      message: "音乐索引写入失败",
      statusCode: 500
    };
  }
  return {
    code: "MUSIC_SCAN_WORKER_FAILED",
    message: "音乐目录扫描失败",
    statusCode: 500
  };
}
