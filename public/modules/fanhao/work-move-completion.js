export function createCompletedWorkMoveReloader({ api, getCurrentWork, applyWork, showReloadFailure = () => {} }) {
  let generation = 0;
  let currentJobId = "";

  async function reload(job) {
    const jobId = String(job?.id || "");
    const expectedWorkId = String(job?.workId || getCurrentWork?.()?.id || "");
    if (job?.status !== "completed" || !jobId || !expectedWorkId || String(getCurrentWork?.()?.id || "") !== expectedWorkId) return false;

    const requestGeneration = ++generation;
    currentJobId = jobId;
    const isCurrent = () => (
      requestGeneration === generation &&
      currentJobId === jobId &&
      String(getCurrentWork?.()?.id || "") === expectedWorkId
    );

    try {
      const payload = await api(`/api/works/${encodeURIComponent(expectedWorkId)}`);
      const work = payload?.work;
      if (!isCurrent()) return false;
      if (!work || String(work.id || "") !== expectedWorkId) throw new Error("迁移后的作品资料无效");
      applyWork(work);
      return true;
    } catch (error) {
      if (isCurrent()) showReloadFailure(error);
      return false;
    } finally {
      if (requestGeneration === generation && currentJobId === jobId) currentJobId = "";
    }
  }

  return { reload };
}
