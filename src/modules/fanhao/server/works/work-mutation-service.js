import { sanitizeWorkMoveJob } from "./work-move-job-query-service.js";

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

  function moveToPerson(workId, body, options = {}) {
    // The job service applies the Android target policy only while creating a
    // new journal row.  Existing idempotency rows must replay unchanged even
    // after their own worker has staged the destination directory.
    return publicMoveJobPayload(workMoveJobService.start(workId, body, { android: Boolean(options.android) }));
  }

  function moveTargets(workId, options = {}) {
    return adminCoreMutationService.listWorkMoveTargets(workId, options);
  }

  function moveJob(jobId) {
    return publicMoveJobPayload(workMoveJobService.get(jobId));
  }

  function moveJobForWork(workId, options = {}) {
    return publicMoveJobPayload(workMoveJobService.findForWork(workId, options));
  }

  function listMoveJobs(options = {}) {
    return { ok: true, ...workMoveJobService.list(options) };
  }

  function retryMoveJob(jobId) {
    return publicMoveJobPayload(workMoveJobService.retry(jobId));
  }

  // This is the one public boundary for every individual work-move response.
  // The journal service deliberately retains diagnostic data for workers and
  // recovery, so never return its job object directly from an HTTP mutation.
  function publicMoveJobPayload(job) {
    return { ok: true, job: sanitizeWorkMoveJob(job) };
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
    listMoveJobs,
    moveTargets,
    moveJob,
    moveJobForWork,
    moveToPerson,
    retryMoveJob,
    setLocalMarker,
    setManualCover
  };
}
