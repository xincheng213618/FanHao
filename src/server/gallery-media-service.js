import path from "node:path";
import { spawnSync } from "node:child_process";

export function createGalleryMediaService({
  coverBoxSize,
  coverGeneratorVersion,
  coverMaxBytes,
  directVideoExts,
  ffmpegPath,
  getImageGalleryDb,
  getImageLibraryIndex,
  getVideoProgress,
  normalizeExt,
  notFound,
  publicGalleryMediaItem,
  safeChildPath,
  safeStat,
  serveVideo,
  videoProbeCached
}) {
  function byId(id) {
    const target = String(id || "");
    if (!target) return null;
    const index = getImageLibraryIndex();
    return (index.mediaItems || []).find((item) => item.id === target) || null;
  }

  function mediaPath(item) {
    if (!item) return "";
    return safeChildPath(item.sourceRoot, item.relativePath);
  }

  function videoFile(item) {
    const filePath = mediaPath(item);
    if (!item || !filePath) return null;
    const ext = normalizeExt(filePath);
    const stat = safeStat(filePath);
    return {
      id: item.id,
      type: "video",
      path: filePath,
      name: path.basename(filePath),
      relativePath: item.relativePath || "",
      ext,
      size: stat?.size || item.size || 0,
      playable: directVideoExts.has(ext)
    };
  }

  function publicDetail(item) {
    const publicItem = publicGalleryMediaItem(item);
    const filePath = mediaPath(item);
    const stat = safeStat(filePath);
    const progress = getVideoProgress(item.id);
    return {
      ...publicItem,
      size: stat?.size || item.size || 0,
      updatedAt: stat ? new Date(stat.mtimeMs).toISOString() : item.updatedAt || "",
      exists: Boolean(stat?.isFile()),
      streamUrl: `/media/gallery-video/${encodeURIComponent(item.id)}`,
      progress,
      videos: [{
        id: item.id,
        name: path.basename(filePath || item.title || "视频"),
        title: item.title || "",
        relativePath: item.relativePath || "",
        ext: normalizeExt(filePath || item.title || "").replace(/^\./, "") || item.ext || "",
        size: stat?.size || item.size || 0,
        playable: Boolean(item.playable),
        progress
      }]
    };
  }

  function coverSeekSeconds(duration) {
    const seconds = Number(duration || 0);
    if (!Number.isFinite(seconds) || seconds <= 0) return 8;
    if (seconds < 20) return Math.max(0.1, Math.min(seconds * 0.5, Math.max(0.1, seconds - 0.25)));
    return Math.floor(Math.min(180, Math.max(8, seconds * 0.08)));
  }

  function extractCoverFrame(filePath, duration) {
    const seek = coverSeekSeconds(duration);
    const args = ["-hide_banner", "-loglevel", "error"];
    if (seek > 0) args.push("-ss", String(seek));
    args.push(
      "-i",
      filePath,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-vf",
      `scale=${coverBoxSize}:-2`,
      "-q:v",
      "5",
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "pipe:1"
    );
    const result = spawnSync(ffmpegPath, args, {
      windowsHide: true,
      maxBuffer: coverMaxBytes,
      timeout: 30000
    });
    if (result.error) {
      throw new Error(result.error.code === "ENOBUFS" ? "生成的分集封面超过大小限制" : `FFmpeg 启动失败：${result.error.message}`);
    }
    if (result.status !== 0 || !result.stdout?.length) {
      const detail = String(result.stderr || "").trim();
      throw new Error(detail ? `FFmpeg 抽帧失败：${detail}` : "FFmpeg 抽帧失败");
    }
    if (result.stdout.length > coverMaxBytes) throw new Error("生成的分集封面超过大小限制");
    if (result.stdout[0] !== 0xff || result.stdout[1] !== 0xd8) throw new Error("FFmpeg 没有生成有效的 JPEG 封面");
    return result.stdout;
  }

  function coverRow(mediaId) {
    if (!mediaId) return null;
    try {
      return getImageGalleryDb().prepare("SELECT * FROM gallery_media_covers WHERE media_id = ?").get(mediaId) || null;
    } catch (error) {
      console.warn("[gallery-media-cover-db]", error.message || error);
      return null;
    }
  }

  function signature(item) {
    const filePath = mediaPath(item);
    const stat = safeStat(filePath);
    if (!stat?.isFile()) return null;
    return {
      filePath,
      sourcePath: path.resolve(filePath),
      sourceSize: stat.size || 0,
      sourceMtimeMs: Math.floor(stat.mtimeMs || 0)
    };
  }

  function coverMatches(row, mediaSignature) {
    return (
      row &&
      mediaSignature &&
      path.resolve(row.source_path || "") === mediaSignature.sourcePath &&
      Number(row.source_size || 0) === mediaSignature.sourceSize &&
      Number(row.source_mtime_ms || 0) === mediaSignature.sourceMtimeMs &&
      Number(row.generator_version || 1) === coverGeneratorVersion
    );
  }

  function upsertCoverError(item, mediaSignature, error) {
    const now = new Date().toISOString();
    try {
      getImageGalleryDb()
        .prepare(
          `
          INSERT INTO gallery_media_covers (
            media_id, source_path, source_size, source_mtime_ms, cover_mime,
            cover_blob, cover_bytes, generator_version, status, error, generated_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(media_id) DO UPDATE SET
            source_path = excluded.source_path,
            source_size = excluded.source_size,
            source_mtime_ms = excluded.source_mtime_ms,
            cover_mime = excluded.cover_mime,
            cover_blob = excluded.cover_blob,
            cover_bytes = excluded.cover_bytes,
            generator_version = excluded.generator_version,
            status = excluded.status,
            error = excluded.error,
            generated_at = excluded.generated_at,
            updated_at = excluded.updated_at
          `
        )
        .run(
          item?.id || "",
          mediaSignature?.sourcePath || "",
          mediaSignature?.sourceSize || 0,
          mediaSignature?.sourceMtimeMs || 0,
          "",
          null,
          0,
          coverGeneratorVersion,
          "error",
          String(error?.message || error || "分集封面生成失败").slice(0, 1000),
          now,
          now
        );
    } catch (dbError) {
      console.warn("[gallery-media-cover-db]", dbError.message || dbError);
    }
  }

  function upsertCover(item, mediaSignature, coverBlob) {
    const now = new Date().toISOString();
    const blob = Buffer.from(coverBlob);
    getImageGalleryDb()
      .prepare(
        `
        INSERT INTO gallery_media_covers (
          media_id, source_path, source_size, source_mtime_ms, cover_mime,
          cover_blob, cover_bytes, generator_version, status, error, generated_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(media_id) DO UPDATE SET
          source_path = excluded.source_path,
          source_size = excluded.source_size,
          source_mtime_ms = excluded.source_mtime_ms,
          cover_mime = excluded.cover_mime,
          cover_blob = excluded.cover_blob,
          cover_bytes = excluded.cover_bytes,
          generator_version = excluded.generator_version,
          status = excluded.status,
          error = excluded.error,
          generated_at = excluded.generated_at,
          updated_at = excluded.updated_at
        `
      )
      .run(
        item.id,
        mediaSignature.sourcePath,
        mediaSignature.sourceSize,
        mediaSignature.sourceMtimeMs,
        "image/jpeg",
        blob,
        blob.length,
        coverGeneratorVersion,
        "ok",
        "",
        now,
        now
      );
    return coverRow(item.id);
  }

  function generateCover(item) {
    const mediaSignature = signature(item);
    if (!mediaSignature) {
      const error = new Error("视频文件不存在");
      error.statusCode = 404;
      throw error;
    }

    const cached = coverRow(item.id);
    if (coverMatches(cached, mediaSignature)) {
      if (cached.status === "ok" && cached.cover_blob) return cached;
      const error = new Error(cached.error || "分集封面生成失败");
      error.statusCode = 404;
      throw error;
    }

    try {
      const probe = videoProbeCached({ id: item.id, path: mediaSignature.filePath }) || {};
      const coverBlob = extractCoverFrame(mediaSignature.filePath, probe.duration);
      return upsertCover(item, mediaSignature, coverBlob);
    } catch (error) {
      upsertCoverError(item, mediaSignature, error);
      error.statusCode = error.statusCode || 500;
      throw error;
    }
  }

  function serveMedia(req, res, mediaId) {
    const item = byId(decodeURIComponent(mediaId));
    const file = videoFile(item);
    if (!file || !safeStat(file.path)?.isFile()) {
      notFound(res);
      return;
    }
    serveVideo(req, res, file);
  }

  function serveCover(res, mediaId) {
    const item = byId(decodeURIComponent(mediaId));
    if (!item) {
      notFound(res);
      return;
    }

    let row = coverRow(item.id);
    const mediaSignature = signature(item);
    if (!coverMatches(row, mediaSignature) || !row?.cover_blob) {
      try {
        row = generateCover(item);
      } catch (error) {
        console.warn("[gallery-media-cover]", item.relativePath || item.id, error.message || error);
        notFound(res);
        return;
      }
    }

    if (!row?.cover_blob) {
      notFound(res);
      return;
    }

    const buffer = Buffer.from(row.cover_blob);
    res.writeHead(200, {
      "Content-Type": row.cover_mime || "image/jpeg",
      "Content-Length": buffer.length,
      "Cache-Control": "public, max-age=86400",
      "Content-Disposition": "inline"
    });
    res.end(buffer);
  }

  return {
    byId,
    mediaPath,
    publicDetail,
    serveCover,
    serveMedia,
    videoFile
  };
}
