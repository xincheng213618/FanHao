export function createWorkMutationService({
  adminCoreMutationService,
  generateWorkCover,
  manualCoverStateService,
  publicWork,
  resolveLibraryWorkByPublicId,
  workLocalMutationService
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
    const result = adminCoreMutationService.moveWorkToPerson(workId, body.personId, {
      targetDirectory: body.targetDirectory || body.targetPath || "",
      createPerson: body.createPerson || null
    });
    return { ok: true, ...result };
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
    moveToPerson,
    setLocalMarker,
    setManualCover
  };
}
