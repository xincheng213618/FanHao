import { DEFAULT_MAX_COVER_BYTES, extractCoverFrame } from "../../../../../lib/cover-frame.js";

export function createWorkCoverMutationService({
  ffmpegPath,
  ffprobePath,
  getCoreDb,
  getWorks,
  maxCoverBytes = DEFAULT_MAX_COVER_BYTES,
  publicCoreWorkCover,
  publicWorkCover,
  resetWorkSearch,
  safeStat,
  videoProbeService,
  workCoverRow,
  workInfoService
}) {
  function cachedWorkCoverIds() {
    try {
      const rows = getCoreDb()
        .prepare(
          `
          SELECT CAST(i.owner_id AS TEXT) AS work_id
          FROM images i
          WHERE i.owner_type = 'work'
            AND i.kind = 'cover'
            AND i.image_blob IS NOT NULL
            AND length(i.image_blob) > 0
          `
        )
        .all();
      return new Set(rows.map((row) => row.work_id));
    } catch (error) {
      console.warn("[core-work-cover]", error.message);
      return new Set();
    }
  }

  function chooseCoverVideo(work) {
    return (work.videos || []).find((video) => safeStat(video.path)) || null;
  }

  function generationStatus(sampleLimit = 8) {
    const cachedCoverIds = cachedWorkCoverIds();
    const candidates = getWorks()
      .filter((work) => !work.missingLocal)
      .filter((work) => !work.coverId)
      .filter((work) => !cachedCoverIds.has(work.id))
      .filter((work) => (work.videos || []).length > 0)
      .sort((a, b) => String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || "")));

    const sample = [];
    let ready = 0;
    let missingVideo = 0;
    for (const work of candidates) {
      const video = chooseCoverVideo(work);
      if (video) {
        ready += 1;
        if (sample.length < sampleLimit) {
          sample.push({
            workId: work.id,
            personId: work.personId || "",
            title: work.title || work.directoryName || "",
            videoCount: (work.videos || []).length,
            modifiedAt: work.modifiedAt || ""
          });
        }
        continue;
      }
      missingVideo += 1;
    }

    return {
      candidates: candidates.length,
      ready,
      missingVideo,
      sample
    };
  }

  function generateWorkCover(work) {
    if (work.coverId) {
      const error = new Error("这个作品已经有本地封面");
      error.statusCode = 400;
      throw error;
    }

    const video = chooseCoverVideo(work);
    if (!video) {
      const error = new Error("这个作品没有可读取的视频文件");
      error.statusCode = 400;
      throw error;
    }

    let coverBlob;
    try {
      coverBlob = extractCoverFrame(video.path, {
        ffmpegPath,
        ffprobePath,
        duration: videoProbeService.probeCached(video)?.duration,
        maxBytes: maxCoverBytes
      });
    } catch (error) {
      error.statusCode = error.statusCode || 500;
      throw error;
    }

    const now = new Date().toISOString();
    const coreWorkId = Number(work.id);
    getCoreDb()
      .prepare(
        `
        INSERT INTO images (
          owner_type, owner_id, kind, source_type, local_path, mime, image_blob,
          byte_size, sort_order, status, source, legacy_table, legacy_key, created_at, updated_at
        ) VALUES ('work', ?, 'cover', 'generated', ?, ?, ?, ?, 0, 'ok', ?, 'generated', ?, ?, ?)
        ON CONFLICT DO UPDATE SET
          mime = excluded.mime,
          image_blob = excluded.image_blob,
          byte_size = excluded.byte_size,
          status = excluded.status,
          source = excluded.source,
          legacy_table = excluded.legacy_table,
          legacy_key = excluded.legacy_key,
          updated_at = excluded.updated_at
        `
      )
      .run(
        coreWorkId,
        video.relativePath || video.path || "",
        "image/jpeg",
        coverBlob,
        coverBlob.length,
        "ffmpeg-frame",
        work.id,
        now,
        now
      );

    workInfoService.invalidate();
    resetWorkSearch();
    return publicCoreWorkCover(work.id) || publicWorkCover(workCoverRow(work.id));
  }

  return {
    chooseCoverVideo,
    generationStatus,
    generateWorkCover
  };
}
