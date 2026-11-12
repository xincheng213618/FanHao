import { randomUUID } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import { readTasteAnalysis } from "./source.js";

try { parentPort.postMessage(readTasteAnalysis(workerData.dbPath, { snapshot: randomUUID() })); }
catch (error) {
  console.warn("[taste-analysis]", error.message);
  parentPort.postMessage({ error: "馆藏口味分析暂时不可用，请稍后重试。" });
}
