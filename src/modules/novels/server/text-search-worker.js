import { parentPort, workerData } from "node:worker_threads";
import { createNovelStore } from "./store.js";

try {
  const { dbPath, bookId, options } = workerData;
  const store = createNovelStore({ dbPath });
  parentPort.postMessage({ data: store.searchBookText(bookId, options) });
} catch (error) {
  const status = error.statusCode || 500;
  parentPort.postMessage({ status, error: status < 500 ? error.message : "全书正文搜索失败，请重试" });
}
