export function createWorkDetailService({
  galleryMediaService,
  library,
  mediaStreamService,
  playbackProgressService,
  prewarmCoreWorkCovers,
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
    prewarmCoreWorkCovers([work]);
    const publicItem = publicWork(work, true);
    prewarmRemoteImagesForWorks([publicItem], 100);
    return { work: publicItem, person: person ? publicPerson(person) : null };
  }

  async function playInfoPayload(videoId) {
    const galleryItem = galleryMediaService.byId(videoId);
    const file = galleryItem ? galleryMediaService.videoFile(galleryItem) : library.filesById.get(videoId);
    if (!file || file.type !== "video") return null;

    return videoProbeService.playInfoForFileAsync(file, videoId, galleryItem ? { streamBase: "/media/gallery-video" } : {});
  }

  function playbackPrewarmPayload(workId) {
    const work = resolveLibraryWorkByPublicId(workId);
    if (!work) return null;

    const preferredVideoId = playbackProgressService.getWorkProgress(work)?.videoId || "";
    const videos = work.videos || [];
    const video = videos.find((item) => item.playable && item.id === preferredVideoId)
      || videos.find((item) => item.playable);
    if (!video) return { ok: true, workId: work.id, videoId: "", queued: 0, active: 0, pending: 0 };

    const prepared = videoProbeService.prewarm([video], {
      concurrency: 3,
      limit: 1,
      queueLimit: 8,
      replaceQueued: true
    });
    return { ok: true, workId: work.id, videoId: video.id, ...prepared };
  }

  function serveInfoFile(res, fileId) {
    const file = library.filesById.get(fileId);
    if (!file || file.type !== "info") return false;

    mediaStreamService.serveInfo(res, file);
    return true;
  }

  return {
    detailPayload,
    playbackPrewarmPayload,
    playInfoPayload,
    serveInfoFile
  };
}
