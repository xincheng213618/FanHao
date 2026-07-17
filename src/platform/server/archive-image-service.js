import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";

export function createArchiveImageService(options) {
  const listCache = new Map();
  const listInflight = new Map();
  const extractInflight = new Map();
  const signatureCache = new Map();
  const signatureCacheTtlMs = Math.max(0, Number(options.signatureCacheTtlMs ?? 30_000) || 0);

  async function runArchiveImageHelper(args, runOptions = {}) {
    const { stdout, stderr, error } = await execute(options.pythonPath, [options.helperPath, ...args], {
      cwd: options.projectRoot,
      encoding: "utf8",
      timeout: runOptions.timeout || 120000
    });
    let payload = null;
    try {
      payload = JSON.parse(stdout || "{}");
    } catch {}
    if (error || !payload?.ok) {
      const message = payload?.error || `${stderr || stdout || error?.message || "archive helper failed"}`.trim();
      throw new Error(message || "archive helper failed");
    }
    return payload;
  }

  function archiveImageListSignature(archivePath) {
    const resolvedPath = path.resolve(archivePath);
    const cached = signatureCache.get(resolvedPath);
    if (cached && Date.now() - cached.createdAt < signatureCacheTtlMs) return cached.signature;

    const stat = options.safeStat(resolvedPath);
    if (!stat?.isFile()) {
      signatureCache.delete(resolvedPath);
      return null;
    }
    const signature = {
      archivePath: resolvedPath,
      archiveSize: stat.size || 0,
      archiveMtimeMs: Math.floor(stat.mtimeMs || 0)
    };
    signatureCache.set(resolvedPath, { createdAt: Date.now(), signature });
    if (signatureCache.size > 300) {
      const firstKey = signatureCache.keys().next().value;
      if (firstKey) signatureCache.delete(firstKey);
    }
    return signature;
  }

  function archiveListCacheKeyFromSignature(signature) {
    if (!signature) return "";
    return `${signature.archivePath}|${signature.archiveSize}|${signature.archiveMtimeMs}`;
  }

  function sliceArchiveImagePayload(payload, limit = 0) {
    const images = Array.isArray(payload?.images) ? payload.images : [];
    const safeLimit = Math.max(0, Math.floor(Number(limit || 0)) || 0);
    return {
      imageCount: Number(payload?.imageCount || images.length || 0),
      images: safeLimit > 0 ? images.slice(0, safeLimit) : images
    };
  }

  function archiveImageIndexRow(signature) {
    if (!signature) return null;
    try {
      return options.getImageGalleryDb()
        .prepare("SELECT * FROM photo_set_image_indexes WHERE archive_path = ?")
        .get(signature.archivePath) || null;
    } catch {
      return null;
    }
  }

  function archiveImageIndexMatches(row, signature) {
    return Boolean(
      row && signature &&
      path.resolve(row.archive_path || "") === signature.archivePath &&
      Number(row.archive_size || 0) === signature.archiveSize &&
      Number(row.archive_mtime_ms || 0) === signature.archiveMtimeMs
    );
  }

  function cachedArchiveImagesPayload(signature) {
    const row = archiveImageIndexRow(signature);
    if (!archiveImageIndexMatches(row, signature)) return null;
    try {
      const images = JSON.parse(row.images_json || "[]");
      if (!Array.isArray(images)) return null;
      return { imageCount: Number(row.image_count || images.length || 0), images };
    } catch {
      return null;
    }
  }

  function rememberArchiveImagesPayload(key, signature, payload) {
    const images = Array.isArray(payload?.images) ? payload.images : [];
    const imageCount = Number(payload?.imageCount || images.length || 0);
    listCache.set(key, { createdAt: Date.now(), images, imageCount });
    if (listCache.size > 300) {
      const firstKey = listCache.keys().next().value;
      if (firstKey) listCache.delete(firstKey);
    }
    if (!signature || !images.length) return;
    try {
      const now = new Date().toISOString();
      options.getImageGalleryDb()
        .prepare(`
          INSERT INTO photo_set_image_indexes (
            archive_path, archive_size, archive_mtime_ms, image_count,
            images_json, indexed_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(archive_path) DO UPDATE SET
            archive_size = excluded.archive_size,
            archive_mtime_ms = excluded.archive_mtime_ms,
            image_count = excluded.image_count,
            images_json = excluded.images_json,
            indexed_at = excluded.indexed_at,
            updated_at = excluded.updated_at
        `)
        .run(signature.archivePath, signature.archiveSize, signature.archiveMtimeMs, imageCount, JSON.stringify(images), now, now);
    } catch (error) {
      options.warn("[archive-image-index-cache]", error.message || error);
    }
  }

  async function loadArchiveImages(signature, key, timeout) {
    const persisted = cachedArchiveImagesPayload(signature);
    if (persisted) {
      rememberArchiveImagesPayload(key, signature, persisted);
      return persisted;
    }
    if (!listInflight.has(key)) {
      listInflight.set(key, runArchiveImageHelper(["list", signature.archivePath], { timeout })
        .then((payload) => {
          const images = Array.isArray(payload.images) ? payload.images : [];
          const fullPayload = { images, imageCount: Number(payload.imageCount || images.length) };
          rememberArchiveImagesPayload(key, signature, fullPayload);
          return fullPayload;
        })
        .finally(() => listInflight.delete(key)));
    }
    return listInflight.get(key);
  }

  async function archiveImagesPayload(archivePath, payloadOptions = {}) {
    const signature = archiveImageListSignature(archivePath);
    const key = archiveListCacheKeyFromSignature(signature);
    if (!key) return { imageCount: 0, images: [] };
    const limit = Number(payloadOptions.limit || 0) || 0;
    const cached = listCache.get(key);
    if (cached && Date.now() - cached.createdAt < options.listCacheTtlMs) return sliceArchiveImagePayload(cached, limit);
    const payload = await loadArchiveImages(signature, key, payloadOptions.timeout || 120000);
    return sliceArchiveImagePayload(payload, limit);
  }

  async function listArchiveImages(archivePath, payloadOptions = {}) {
    return (await archiveImagesPayload(archivePath, payloadOptions)).images;
  }

  function archiveImageCacheFile(sourceType, signature, memberPath) {
    const archiveKey = `${signature.archivePath}|${signature.archiveSize}|${signature.archiveMtimeMs}`;
    const archiveHash = crypto.createHash("sha1").update(archiveKey).digest("hex").slice(0, 24);
    const memberHash = crypto.createHash("sha1").update(String(memberPath || "")).digest("hex").slice(0, 24);
    const ext = options.archiveImageExts.has(options.normalizeExt(memberPath)) ? options.normalizeExt(memberPath) : ".img";
    return path.join(options.imageReaderCacheService.rootDir, sourceType, archiveHash, `${memberHash}${ext}`);
  }

  async function extractArchiveMemberToCache(archivePath, memberPath, cachePath) {
    const key = path.resolve(cachePath);
    if (!extractInflight.has(key)) {
      extractInflight.set(key, fs.promises.mkdir(path.dirname(cachePath), { recursive: true })
        .then(() => runArchiveImageHelper(["extract", archivePath, memberPath, cachePath], { timeout: 120000 }))
        .finally(() => extractInflight.delete(key)));
    }
    await extractInflight.get(key);
  }

  async function compressImageFileToJpeg(filePath) {
    const { stdout, stderr, error } = await execute(options.ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-i", filePath,
      "-frames:v", "1", "-vf", `scale=${options.coverBoxSize}:${options.coverBoxSize}:force_original_aspect_ratio=decrease`,
      "-q:v", "5", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"
    ], { encoding: null, maxBuffer: options.coverMaxBytes, timeout: 30000 });
    if (error) throw new Error(error.code === "ENOBUFS" ? "压缩后的封面超过大小限制" : `FFmpeg 启动失败：${error.message}`);
    if (!stdout?.length) {
      const detail = String(stderr || "").trim();
      throw new Error(detail ? `封面压缩失败：${detail}` : "封面压缩失败");
    }
    if (stdout.length > options.coverMaxBytes) throw new Error("压缩后的封面超过大小限制");
    if (stdout[0] !== 0xff || stdout[1] !== 0xd8) throw new Error("FFmpeg 没有生成有效的 JPEG 封面");
    return stdout;
  }

  async function serveArchiveMemberImage(res, serveOptions) {
    const archivePath = serveOptions.archivePath;
    const memberPath = String(serveOptions.memberPath || "").replace(/[\\/]+/g, "/");
    const signature = archiveImageListSignature(archivePath);
    if (!signature || !memberPath || !options.archiveImageExts.has(options.normalizeExt(memberPath))) {
      if (serveOptions.fallbackPath && options.serveInlineFile(res, serveOptions.fallbackPath, serveOptions.contentType)) return;
      options.notFound(res);
      return;
    }
    const cachePath = archiveImageCacheFile(serveOptions.sourceType || "common", signature, memberPath);
    if (!options.safeStat(cachePath)?.isFile()) {
      try {
        await extractArchiveMemberToCache(archivePath, memberPath, cachePath);
      } catch (error) {
        options.warn("[image-reader-extract]", error.message || error);
        options.sendText(res, 500, error.message || "图片缓存抽取失败");
        return;
      }
    }
    options.imageReaderCacheService.touch(cachePath);
    options.imageReaderCacheService.scheduleCleanup();
    options.serveInlineFile(res, cachePath, serveOptions.contentType || options.mimeTypes[options.normalizeExt(memberPath)] || "");
  }

  return {
    archiveSignature: archiveImageListSignature,
    archiveImagesPayload,
    clearListCache: () => {
      listCache.clear();
      signatureCache.clear();
    },
    compressImageFileToJpeg,
    extractArchiveMemberToCache,
    listArchiveImages,
    serveArchiveMemberImage
  };
}

function execute(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, { ...options, windowsHide: true }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
}
