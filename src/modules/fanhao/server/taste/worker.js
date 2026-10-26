import { parentPort, workerData } from "node:worker_threads";
import { analyzeTasteDatabase } from "./source.js";

try { parentPort.postMessage({ profile: analyzeTasteDatabase(workerData.dbPath) }); }
catch (error) {
  console.warn("[taste-analysis]", error.message);
  parentPort.postMessage({ error: "馆藏口味分析暂时不可用，请稍后重试。" });
}
