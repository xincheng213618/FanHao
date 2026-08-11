export function createWorkMutationService({
  adminCoreMutationService,
  generateWorkCover,
  manualCoverStateService,
  publicWork,
  resolveLibraryWorkByPublicId,
  workLocalMutationService,
  workMoveJobService
}) {
  function generateCover(workId) {
    const work = resolveLibraryWorkByPublicId(workId);
    if (!work) return null;

    const cover = generateWorkCover(work);
    return { ok: true, cover, work: publicWork(work, true) };
  }

  function coverGenerationErrorPayload(workId, error) {
    const work = resolveLibraryWorkByPublicId(workId);
    return {
      error: error.message || "生成封面失败",
      work: work ? publicWork(work, true) : null
    };
  }

  function setManualCover(workId, body) {
    const result = manualCoverStateService.setWorkManualCover(workId, body.imageId || "");
    return { ok: true, ...result };
  }

  function setLocalMarker(workId, body) {
    const result = workLocalMutationService.setWorkLocalMarker(workId, body.marker || "A", Boolean(body.enabled));
    return { ok: true, ...result };
  }

  function correctActorFromFolder(workId) {
    const result = adminCoreMutationService.correctWorkActorFromLocalFolder(workId);
    return { ok: true, ...result };
  }

  function moveToPerson(workId, body) {
    return { ok: true, job: workMoveJobService.start(workId, body) };
  }

  function moveJob(jobId) {
    return { ok: true, job: workMoveJobService.get(jobId) };
  }

  function moveJobForWork(workId, options = {}) {
    return { ok: true, job: workMoveJobService.findForWork(workId, options) };
  }

  function retryMoveJob(jobId) {
    return { ok: true, job: workMoveJobService.retry(jobId) };
  }

  function deleteLocalFiles(workId) {
    const result = workLocalMutationService.deleteWorkLocalFiles(workId);
    return { ok: true, ...result };
  }

  return {
    correctActorFromFolder,
    coverGenerationErrorPayload,
    deleteLocalFiles,
    generateCover,
    moveJob,
    moveJobForWork,
    moveToPerson,
    retryMoveJob,
    setLocalMarker,
    setManualCover
  };
}
