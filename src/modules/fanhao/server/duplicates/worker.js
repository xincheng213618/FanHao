import { parentPort, workerData } from "node:worker_threads";
import { duplicateSnapshot } from "./source.js";
import { checkDuplicateAvailability } from "./availability.js";

try { parentPort.postMessage({ snapshot: await checkDuplicateAvailability(duplicateSnapshot(workerData.dbPath), workerData.roots) }); }
catch { parentPort.postMessage({ error: "重复文件索引暂时不可用，请重试。" }); }
