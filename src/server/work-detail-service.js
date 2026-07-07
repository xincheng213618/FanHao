export function createWorkDetailService({
  galleryMediaService,
  library,
  mediaStreamService,
  prewarmRemoteImagesForWorks,
  publicPerson,
  publicWork,
  resolveLibraryWorkByPublicId,
  videoProbeService
}) {
  function detailPayload(workId) {
    const work = resolveLibraryWorkByPublicId(workId);
    if (!work) return null;

    const person = library.peopleById.get(work.personId);
    const publicItem = publicWork(work, true);
    prewarmRemoteImagesForWorks([publicItem], 100);
    return { work: publicItem, person: person ? publicPerson(person) : null };
  }

  function playInfoPayload(videoId) {
    const galleryItem = galleryMediaService.byId(videoId);
    const file = galleryItem ? galleryMediaService.videoFile(galleryItem) : library.filesById.get(videoId);
    if (!file || file.type !== "video") return null;

    return videoProbeService.playInfoForFile(file, videoId, galleryItem ? { streamBase: "/media/gallery-video" } : {});
  }

  function serveInfoFile(res, fileId) {
    const file = library.filesById.get(fileId);
    if (!file || file.type !== "info") return false;

    mediaStreamService.serveInfo(res, file);
    return true;
  }

  return {
    detailPayload,
    playInfoPayload,
    serveInfoFile
  };
}
