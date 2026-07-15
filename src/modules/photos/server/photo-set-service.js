import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function archiveMemberBaseName(memberPath) {
  const parts = String(memberPath || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.pop() || "";
}

function archiveMemberDepth(memberPath) {
  return String(memberPath || "").replace(/\\/g, "/").split("/").filter(Boolean).length;
}

export function createPhotoSetService({
  archiveImageExts,
  archiveImagesPayload,
  compressImageFileToJpeg,
  coverGeneratorVersion,
  coverHints,
  coverMaxBytes,
  extractArchiveMemberToCache,
  fileBase,
  getImageGalleryDb,
  getImageLibraryIndex,
  listArchiveImages,
  mimeTypes,
  normalizeExt,
  notFound,
  safeChildPath,
  safeStat,
  serveArchiveMemberImage
}) {
  function imageUrl(albumId, imageIndex) {
    return `/media/gallery/${encodeURIComponent(albumId)}/${encodeURIComponent(String(imageIndex))}`;
  }

  function coverUrl(albumId, updatedAt = "") {
    const suffix = updatedAt ? `?v=${encodeURIComponent(updatedAt)}` : "";
    return `/media/gallery-cover/${encodeURIComponent(albumId)}${suffix}`;
  }

  function archivePath(album) {
    if (!album) return "";
    return safeChildPath(album.sourceRoot, album.relativePath);
  }

  function byId(id) {
    const target = String(id || "");
    if (!target) return null;
    const index = getImageLibraryIndex();
    return (index.photoSets || []).find((item) => item.id === target) || null;
  }

  function archiveSignature(targetArchivePath) {
    const stat = safeStat(targetArchivePath);
    if (!stat?.isFile()) return null;
    return {
      archivePath: path.resolve(targetArchivePath),
      archiveSize: stat.size || 0,
      archiveMtimeMs: Math.floor(stat.mtimeMs || 0)
    };
  }

  function coverRow(album) {
    try {
      return getImageGalleryDb().prepare("SELECT * FROM photo_set_covers WHERE album_id = ?").get(album.id) || null;
    } catch (error) {
      console.warn("[image-gallery-cover-db]", error.message || error);
      return null;
    }
  }

  function archiveImageMime(memberPath) {
    return mimeTypes[normalizeExt(memberPath)] || "application/octet-stream";
  }

  function coverHintScore(image) {
    const baseName = archiveMemberBaseName(image?.path || image?.name || "");
    const stem = fileBase(baseName).toLowerCase();
    const tokens = stem.split(/[\s._\-()[\]{}【】]+/).filter(Boolean);
    if (!stem) return 0;

    if (stem === "cover" || stem === "封面") return 1000;
    if (tokens.includes("cover") || tokens.includes("封面")) return 940;
    if (stem.includes("cover") || stem.includes("封面")) return 880;
    if (coverHints.has(stem)) return 760;
    if (tokens.some((token) => coverHints.has(token))) return 700;
    return 0;
  }

  function selectCoverImage(images = []) {
    const candidates = images.filter((image) => image?.path);
    if (!candidates.length) return null;

    const explicit = candidates
      .map((image, index) => {
        const hintScore = coverHintScore(image);
        const depth = archiveMemberDepth(image.path);
        const ext = normalizeExt(image.path);
        const tieScore = (depth <= 1 ? 40 : Math.max(0, 30 - depth * 5)) + ([".jpg", ".jpeg", ".webp", ".png"].includes(ext) ? 10 : 0);
        return { image, index, score: hintScore + tieScore, hintScore };
      })
      .filter((item) => item.hintScore > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)[0];

    if (explicit) return { image: explicit.image, isExplicitCover: true };
    return { image: candidates[0], isExplicitCover: false };
  }

  async function coverBlobFromFile(filePath, image, isExplicitCover) {
    const sourceBytes = safeStat(filePath)?.size || Number(image?.bytes || 0);
    const mime = archiveImageMime(image?.path || image?.name || "");
    if (isExplicitCover && sourceBytes > 0 && sourceBytes <= coverMaxBytes) {
      return {
        blob: await fs.promises.readFile(filePath),
        mime,
        sourceBytes
      };
    }

    const blob = await compressImageFileToJpeg(filePath);
    return {
      blob,
      mime: "image/jpeg",
      sourceBytes
    };
  }

  function coverMatches(row, signature) {
    return (
      row &&
      signature &&
      path.resolve(row.archive_path || "") === signature.archivePath &&
      Number(row.archive_size || 0) === signature.archiveSize &&
      Number(row.archive_mtime_ms || 0) === signature.archiveMtimeMs &&
      Number(row.generator_version || 1) === coverGeneratorVersion
    );
  }

  function upsertCoverError(album, signature, error) {
    const now = new Date().toISOString();
    try {
      getImageGalleryDb()
        .prepare(
          `
          INSERT INTO photo_set_covers (
            album_id, archive_path, archive_size, archive_mtime_ms, member_path,
            cover_mime, cover_blob, cover_bytes, source_bytes, generator_version, status, error, generated_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(album_id) DO UPDATE SET
            archive_path = excluded.archive_path,
            archive_size = excluded.archive_size,
            archive_mtime_ms = excluded.archive_mtime_ms,
            member_path = excluded.member_path,
            cover_mime = excluded.cover_mime,
            cover_blob = excluded.cover_blob,
            cover_bytes = excluded.cover_bytes,
            source_bytes = excluded.source_bytes,
            generator_version = excluded.generator_version,
            status = excluded.status,
            error = excluded.error,
            generated_at = excluded.generated_at,
            updated_at = excluded.updated_at
          `
        )
        .run(
          album.id,
          signature?.archivePath || "",
          signature?.archiveSize || 0,
          signature?.archiveMtimeMs || 0,
          "",
          "",
          null,
          0,
          0,
          coverGeneratorVersion,
          "error",
          error.message || String(error || "封面生成失败"),
          now,
          now
        );
    } catch (dbError) {
      console.warn("[image-gallery-cover-db]", dbError.message || dbError);
    }
  }

  function upsertCover(album, signature, image, cover) {
    const now = new Date().toISOString();
    const coverBlob = Buffer.from(cover.blob);
    getImageGalleryDb()
      .prepare(
        `
        INSERT INTO photo_set_covers (
          album_id, archive_path, archive_size, archive_mtime_ms, member_path,
          cover_mime, cover_blob, cover_bytes, source_bytes, generator_version, status, error, generated_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(album_id) DO UPDATE SET
          archive_path = excluded.archive_path,
          archive_size = excluded.archive_size,
          archive_mtime_ms = excluded.archive_mtime_ms,
          member_path = excluded.member_path,
          cover_mime = excluded.cover_mime,
          cover_blob = excluded.cover_blob,
          cover_bytes = excluded.cover_bytes,
          source_bytes = excluded.source_bytes,
          generator_version = excluded.generator_version,
          status = excluded.status,
          error = excluded.error,
          generated_at = excluded.generated_at,
          updated_at = excluded.updated_at
        `
      )
      .run(
        album.id,
        signature.archivePath,
        signature.archiveSize,
        signature.archiveMtimeMs,
        image.path || "",
        cover.mime || "image/jpeg",
        coverBlob,
        coverBlob.length,
        Number(cover.sourceBytes || image.bytes || 0),
        coverGeneratorVersion,
        "ok",
        "",
        now,
        now
      );
    return coverRow(album);
  }

  async function generateCover(album) {
    const targetArchivePath = archivePath(album);
    const signature = archiveSignature(targetArchivePath);
    if (!signature) {
      const error = new Error("图包压缩文件不存在");
      error.statusCode = 404;
      throw error;
    }

    const cached = coverRow(album);
    if (coverMatches(cached, signature)) {
      if (cached.status === "ok" && cached.cover_blob) return cached;
      const error = new Error(cached.error || "图包封面生成失败");
      error.statusCode = 404;
      throw error;
    }

    const images = await listArchiveImages(targetArchivePath);
    const selected = selectCoverImage(images);
    if (!selected?.image?.path) {
      const error = new Error("图包里没有可用图片");
      error.statusCode = 404;
      upsertCoverError(album, signature, error);
      throw error;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-gallery-cover-"));
    const tempExt = archiveImageExts.has(normalizeExt(selected.image.path)) ? normalizeExt(selected.image.path) : ".img";
    const tempPath = path.join(tempDir, `source${tempExt}`);
    try {
      await extractArchiveMemberToCache(targetArchivePath, selected.image.path, tempPath);
      const cover = await coverBlobFromFile(tempPath, selected.image, selected.isExplicitCover);
      return upsertCover(album, signature, selected.image, cover);
    } catch (error) {
      upsertCoverError(album, signature, error);
      error.statusCode = error.statusCode || 500;
      throw error;
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  }

  async function publicDetail(album, options = {}) {
    const targetArchivePath = archivePath(album);
    const imageOffset = Math.max(0, Math.floor(Number(options.imageOffset || 0)) || 0);
    const rawImageLimit = options.imageLimit;
    const imageLimit = Number.isFinite(Number(rawImageLimit)) && Number(rawImageLimit) > 0
      ? Math.floor(Number(rawImageLimit))
      : 0;
    const payload = await archiveImagesPayload(targetArchivePath, {
      limit: imageLimit > 0 ? imageOffset + imageLimit : 0
    });
    const images = Array.isArray(payload.images) ? payload.images : [];
    const imageCount = Number(payload.imageCount || images.length || 0);
    const visibleImages = imageLimit > 0
      ? images.slice(imageOffset, imageOffset + imageLimit)
      : images;
    return {
      ...album,
      imageCount,
      imageOffset,
      imageLimit: imageLimit || images.length,
      imagesTruncated: imageLimit > 0 && imageOffset + visibleImages.length < imageCount,
      images: visibleImages.map((image, index) => ({
        index: imageOffset + index + 1,
        name: image.name || path.basename(image.path || ""),
        archivePath: image.path || "",
        bytes: Number(image.bytes || 0),
        url: imageUrl(album.id, imageOffset + index + 1)
      }))
    };
  }

  async function serveImage(res, albumId, imageIndex) {
    const album = byId(decodeURIComponent(albumId));
    if (!album) {
      notFound(res);
      return;
    }
    const targetArchivePath = archivePath(album);
    const images = await listArchiveImages(targetArchivePath);
    const image = images[Number(decodeURIComponent(imageIndex)) - 1];
    if (!image?.path) {
      notFound(res);
      return;
    }
    await serveArchiveMemberImage(res, {
      sourceType: "photo-set",
      archivePath: targetArchivePath,
      memberPath: image.path,
      contentType: mimeTypes[normalizeExt(image.path)] || ""
    });
  }

  async function serveCover(res, albumId) {
    const album = byId(albumId);
    if (!album) {
      notFound(res);
      return;
    }

    let row = coverRow(album);
    const signature = archiveSignature(archivePath(album));
    if (!coverMatches(row, signature) || !row?.cover_blob) {
      try {
        row = await generateCover(album);
      } catch (error) {
        console.warn("[image-gallery-cover]", album.relativePath || album.id, error.message || error);
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
    archivePath,
    byId,
    coverUrl,
    imageUrl,
    publicDetail,
    serveCover,
    serveImage
  };
}
