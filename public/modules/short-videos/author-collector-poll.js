export function createAuthorCollectorPoll(options = {}) {
  const {
    api,
    isCurrentAuthorPage,
    delayMs = 1500,
    maxAttempts = 900,
    setTimer = globalThis.setTimeout?.bind(globalThis),
    clearTimer = globalThis.clearTimeout?.bind(globalThis)
  } = options;
  let activePoll = null;

  function cancel() {
    const poll = activePoll;
    activePoll = null;
    poll?.controller.abort();
  }

  function isCurrent(authorId) {
    return Boolean(isCurrentAuthorPage?.(String(authorId || "").trim()));
  }

  function sync(authorId = "") {
    const activeAuthorId = String(authorId || "").trim();
    if (activePoll && (activePoll.authorId !== activeAuthorId || !isCurrent(activeAuthorId))) cancel();
  }

  async function wait({ authorId, jobId, onProgress } = {}) {
    cancel();
    const poll = {
      authorId: String(authorId || "").trim(),
      controller: new AbortController(),
      jobId: Number(jobId || 0)
    };
    activePoll = poll;
    try {
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (!isActive(poll)) return null;
        let data;
        try {
          data = await api(`/api/short-videos/authors/${encodeURIComponent(poll.authorId)}/collector?jobId=${encodeURIComponent(poll.jobId)}`, {
            signal: poll.controller.signal
          });
        } catch (error) {
          if (poll.controller.signal.aborted) return null;
          throw error;
        }
        if (!isActive(poll)) return null;
        const job = data?.job;
        if (job) {
          const progress = data?.progress?.status === "running" ? data.progress : job;
          onProgress?.({
            processed: Math.max(0, Number(progress.processed || 0)),
            total: Math.max(0, Number(progress.total || 0))
          });
          if (["complete", "failed", "stopped"].includes(job.status)) return data;
        }
        if (!await abortableDelay(poll.controller.signal)) return null;
      }
      throw new Error("8765 采集任务等待超时，请到采集管理查看");
    } finally {
      if (activePoll === poll) activePoll = null;
      poll.controller.abort();
    }
  }

  function isActive(poll) {
    return activePoll === poll && !poll.controller.signal.aborted && isCurrent(poll.authorId);
  }

  function abortableDelay(signal) {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimer(() => finish(true), delayMs);
      const onAbort = () => finish(false);
      function finish(completed) {
        clearTimer(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(completed);
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  return { cancel, isCurrent, sync, wait };
}
