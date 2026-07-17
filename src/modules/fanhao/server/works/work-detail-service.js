const WORK_DETAIL_CACHE_LIMIT = 64;

export function createWorkDetailService({
  galleryMediaService,
  library,
  mediaStreamService,
  peoplePayloadStamp = () => "",
  playbackProgressService,
  prewarmCoreWorkCovers,
  prewarmRemoteImagesForWorks,
  publicPerson,
  publicWork,
  resolveLibraryWorkByPublicId,
  userStateStamp = () => "",
  videoProbeService,
  workQueryStamp = () => ""
}) {
  const detailCache = new Map();
  let detailCacheStamp = "";

  function detailPayload(workId) {
    const work = resolveLibraryWorkByPublicId(workId);
    if (!work) return null;

    const stamp = `${library.scannedAt || ""}:${workQueryStamp()}:${peoplePayloadStamp()}:${userStateStamp()}`;
    if (detailCacheStamp !== stamp) {
      detailCacheStamp = stamp;
      detailCache.clear();
    }
    const cacheKey = String(work.id || workId);
    const cached = detailCache.get(cacheKey);
    if (cached) {
      detailCache.delete(cacheKey);
      detailCache.set(cacheKey, cached);
      return cached;
    }

    const person = library.peopleById.get(work.personId);
    prewarmCoreWorkCovers([work]);
    const publicItem = publicWork(work, true);
    prewarmRemoteImagesForWorks([publicItem], 100);
    const payload = { work: publicItem, person: person ? publicPerson(person) : null };
    detailCache.set(cacheKey, payload);
    while (detailCache.size > WORK_DETAIL_CACHE_LIMIT) detailCache.delete(detailCache.keys().next().value);
    return payload;
  }

  async function playInfoPayload(videoId) {
    const galleryItem = galleryMediaService.byId(videoId);
    const file = galleryItem ? galleryMediaService.videoFile(galleryItem) : library.filesById.get(videoId);
    if (!file || file.type !== "video") return null;

    return videoProbeService.playInfoForFileAsync(file, videoId, galleryItem ? { streamBase: "/media/gallery-video" } : {});
  }

  function playbackPrewarmPayload(workId) {
    const detail = detailPayload(workId);
    if (!detail) return null;
    const work = resolveLibraryWorkByPublicId(workId);
    if (!work) return null;

    const preferredVideoId = playbackProgressService.getWorkProgress(work)?.videoId || "";
    const videos = work.videos || [];
    const video = videos.find((item) => item.playable && item.id === preferredVideoId)
      || videos.find((item) => item.playable);
    if (!video) return { ok: true, detailReady: true, workId: work.id, videoId: "", queued: 0, active: 0, pending: 0 };

    const prepared = videoProbeService.prewarm([video], {
      concurrency: 3,
      limit: 1,
      queueLimit: 8,
      replaceQueued: true
    });
    return { ok: true, detailReady: true, workId: work.id, videoId: video.id, ...prepared };
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
