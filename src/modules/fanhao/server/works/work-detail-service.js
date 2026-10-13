import { isProxy } from "node:util/types";

const WORK_DETAIL_CACHE_LIMIT = 64;
const WORK_DETAIL_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const arrayBufferBytes = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "buffer").get;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, "buffer").get;

function detailPayloadWeight(payload) {
  // Estimate retained plain DTO data without serializing/scanning large text.
  // Unknown objects/accessors are returned normally, but are not cached.
  let bytes = 0;
  const seen = new WeakSet();
  function visit(value) {
    if (typeof value === "string") { bytes += 16 + value.length * 2; return; }
    if (value === null || typeof value !== "object") {
      bytes += typeof value === "function" || typeof value === "symbol" || typeof value === "bigint"
        ? WORK_DETAIL_CACHE_MAX_BYTES + 1 : 8;
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);
    bytes += 64;
    if (isProxy(value)) { bytes = WORK_DETAIL_CACHE_MAX_BYTES + 1; return; }
    if (ArrayBuffer.isView(value)) {
      // Even a short view retains its complete backing allocation.
      visit((value instanceof DataView ? dataViewBuffer : typedArrayBuffer).call(value));
      return;
    }
    if (value instanceof ArrayBuffer) { bytes += arrayBufferBytes.call(value); return; }
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) {
      bytes = WORK_DETAIL_CACHE_MAX_BYTES + 1;
      return;
    }
    if (array) bytes += value.length * 8;
    if (bytes > WORK_DETAIL_CACHE_MAX_BYTES) return;
    for (const key in value) {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field) continue;
      bytes += 16 + key.length * 2;
      if (!Object.hasOwn(field, "value")) { bytes = WORK_DETAIL_CACHE_MAX_BYTES + 1; return; }
      if (bytes > WORK_DETAIL_CACHE_MAX_BYTES) return;
      visit(field.value);
      if (bytes > WORK_DETAIL_CACHE_MAX_BYTES) return;
    }
  }
  try { visit(payload); } catch { return WORK_DETAIL_CACHE_MAX_BYTES + 1; }
  return bytes;
}

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
  resolveVideoFileByPublicId,
  userStateStamp = () => "",
  videoProbeService,
  withWorkInfoReadStatus = (callback) => ({ value: callback(), cacheable: true }),
  workInfoReadCacheable = () => true,
  workQueryStamp = () => ""
}) {
  const detailCache = new Map();
  let detailCacheStamp = "";
  let detailCacheBytes = 0;

  function detailPayload(workId) {
    return withWorkInfoReadStatus(() => loadDetailPayload(workId)).value;
  }

  function loadDetailPayload(workId) {
    const work = resolveLibraryWorkByPublicId(workId);
    if (!work) return null;

    const stamp = `${library.scannedAt || ""}:${workQueryStamp()}:${peoplePayloadStamp()}:${userStateStamp()}`;
    if (detailCacheStamp !== stamp) {
      detailCacheStamp = stamp;
      detailCache.clear();
      detailCacheBytes = 0;
    }
    const cacheKey = String(work.id || workId);
    const cached = detailCache.get(cacheKey);
    if (cached) {
      detailCache.delete(cacheKey);
      detailCache.set(cacheKey, cached);
      return cached.payload;
    }

    const person = library.peopleById.get(work.personId);
    prewarmCoreWorkCovers([work]);
    const publicItem = publicWork(work, true);
    prewarmRemoteImagesForWorks([publicItem], 100);
    const payload = { work: publicItem, person: person ? publicPerson(person) : null };
    const bytes = detailPayloadWeight(payload);
    if (bytes <= WORK_DETAIL_CACHE_MAX_BYTES && workInfoReadCacheable()) {
      while (detailCache.size && (detailCacheBytes + bytes > WORK_DETAIL_CACHE_MAX_BYTES || detailCache.size >= WORK_DETAIL_CACHE_LIMIT)) {
        const oldestKey = detailCache.keys().next().value;
        detailCacheBytes -= detailCache.get(oldestKey).bytes;
        detailCache.delete(oldestKey);
      }
      detailCache.set(cacheKey, { payload, bytes });
      detailCacheBytes += bytes;
    }
    return payload;
  }

  async function playInfoPayload(videoId, options = {}) {
    const preferGallery = options.source === "gallery";
    const libraryFile = preferGallery
      ? null
      : (resolveVideoFileByPublicId ? resolveVideoFileByPublicId(videoId) : library.filesById.get(videoId));
    const galleryItem = libraryFile ? null : galleryMediaService.byId(videoId);
    const file = libraryFile || (galleryItem ? galleryMediaService.videoFile(galleryItem) : null);
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
