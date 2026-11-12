import { Worker } from "node:worker_threads";

function unavailable(message) {
  return Object.assign(new Error(message), { statusCode: 503 });
}

export function createNovelTextSearch({ dbPath, capacity = 2, timeoutMs = 15000 }) {
  const workers = new Set();
  let accepting = true;

  async function search(bookId, options, { signal } = {}) {
    if (!accepting || signal?.aborted) throw unavailable("全书正文搜索已取消");
    if (workers.size >= capacity) throw unavailable("全书正文搜索繁忙，请重试");
    const worker = new Worker(new URL("./text-search-worker.js", import.meta.url), {
      execArgv: process.execArgv.filter(value => !value.startsWith("--input-type")),
      workerData: { dbPath, bookId, options }
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      let terminating = false;
      let finishExit;
      const exited = new Promise(resolveExit => { finishExit = resolveExit; });
      const job = { cancel, exited };
      const timer = setTimeout(() => cancel(unavailable("全书正文搜索超时，请重试")), timeoutMs);

      function finish(error, data) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(data);
      }

      function cancel(error = unavailable("全书正文搜索已取消")) {
        finish(error);
        if (terminating) return;
        terminating = true;
        // The worker keeps its slot until the exit event confirms termination.
        void worker.terminate().catch(() => {});
      }

      function abort() { cancel(); }

      workers.add(job);
      worker.once("message", reply => {
        if (reply?.error) finish(Object.assign(new Error(reply.error), { statusCode: reply.status }));
        else finish(null, reply?.data ?? null);
      });
      worker.once("error", () => finish(unavailable("全书正文搜索暂不可用，请重试")));
      worker.once("exit", () => {
        workers.delete(job);
        finish(unavailable("全书正文搜索提前结束，请重试"));
        finishExit();
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  function beginStop() {
    accepting = false;
    for (const job of workers) job.cancel();
  }

  async function stop() {
    beginStop();
    await Promise.all([...workers].map(job => job.exited));
  }

  return { search, beginStop, stop, start: () => { accepting = true; } };
}
