import { stat } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { pageTasteEvidence } from "./profile.js";

export function createTasteService({ dbPath, cacheMs = 30_000, timeoutMs = 20_000, now = Date.now,
  workerFactory = (options) => new Worker(new URL("./worker.js", import.meta.url), options) }) {
  let cached = null, pending = null, active = null, stopping = false;
  const unavailable = () => Object.assign(new Error("口味分析暂时不可用，请稍后重试。"), { statusCode: 503 });
  async function signature() {
    return (await Promise.all([dbPath, `${dbPath}-wal`].map(async (file) => {
      try { const fileStat = await stat(file); return `${fileStat.size}:${fileStat.mtimeMs}`; }
      catch (error) { if (file !== dbPath && error.code === "ENOENT") return ""; throw error; }
    }))).join("|");
  }
  async function analysis() {
    if (stopping) throw unavailable();
    if (pending) return pending;
    const operation = (async () => {
      const key = await signature();
      if (stopping) throw unavailable();
      if (cached?.key === key && now() - cached.at < cacheMs) return cached.value;
      const value = await new Promise((resolve, reject) => {
        const worker = workerFactory({ workerData: { dbPath } });
        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true; clearTimeout(timer); active = null;
          if (error) reject(error); else resolve(value);
        };
        const timer = setTimeout(() => { worker.terminate().then(() => finish(unavailable()), () => finish(unavailable())); }, timeoutMs);
        active = { worker, cancel: () => finish(unavailable()) };
        worker.once("message", (message) => finish(message?.profile ? null : unavailable(), message));
        worker.once("error", () => finish(unavailable()));
        worker.once("exit", () => finish(unavailable()));
      });
      if (!stopping) cached = { key, at: now(), value };
      return value;
    })();
    pending = operation;
    try { return await operation; }
    finally { if (pending === operation) pending = null; }
  }
  async function profile() { return (await analysis()).profile; }
  function evidence(request) {
    if (stopping) throw unavailable();
    if (!cached || !request.snapshot || cached.value.profile.snapshot !== request.snapshot) {
      throw Object.assign(new Error("这份分析快照已过期，请重新读取后再查看作品。"), { statusCode: 409 });
    }
    const page = pageTasteEvidence(cached.value.evidence, request);
    if (!page) throw Object.assign(new Error("这份分析中没有该特征。"), { statusCode: 404 });
    return page;
  }
  function beginStop() { stopping = true; cached = null; }
  async function stop() {
    beginStop();
    const owned = active;
    if (owned) { await owned.worker.terminate(); owned.cancel(); }
    if (pending) await pending.catch(() => {});
  }
  return { profile, evidence, beginStop, stop };
}
