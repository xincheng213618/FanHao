import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createArchiveTaskPool, runArchiveChild, archiveStoppedError } from "../../../platform/server/archive-task-pool.js";

function archiveMemberBaseName(memberPath) {
  const parts = String(memberPath || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.pop() || "";
}

function archiveMemberDepth(memberPath) {
  return String(memberPath || "").replace(/\\/g, "/").split("/").filter(Boolean).length;
}

export function createPhotoSetService({
  archiveImageExts,
  archiveImageSignature,
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
  photoSetById,
  safeChildPath,
  safeStat,
  serveArchiveMemberImage
}) {
  const coverPool = createArchiveTaskPool();
  const coverChildren = new Set();
  function withDatabase(db, operation) {
    if (typeof db.exec !== "function") return operation(db);
    const previous = Number(db.prepare("PRAGMA busy_timeout").get().timeout);
    db.exec("PRAGMA busy_timeout = 0");
    try { return operation(db); } finally { db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(previous || 0))}`); }
  }
  const albumStamp = value => JSON.stringify([value?.id, value?.sourceRoot, value?.relativePath, value?.updatedAt]);
  const rowStamp = value => JSON.stringify(value && { ...value, cover_blob: value.cover_blob ? Buffer.from(value.cover_blob).toString("base64") : null });
  function authority(album, context) {
    const db = getImageGalleryDb(), stamp = rowStamp(coverRow(album, db));
    return { db, stamp, album: albumStamp(album), current: () => context.isCurrent() && getImageGalleryDb() === db && albumStamp(byId(album.id)) === albumStamp(album) && rowStamp(coverRow(album, db)) === stamp };
  }
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
    const album = typeof photoSetById === "function"
      ? photoSetById(target)
      : (getImageLibraryIndex().photoSets || []).find((item) => item.id === target) || null;
    if (!album) return null;
    return {
      ...album,
      coverUrl: album.coverUrl || coverUrl(album.id, album.updatedAt || "")
    };
  }

  async function archiveSignature(targetArchivePath, request = {}) {
    return await archiveImageSignature(targetArchivePath, request);
  }

  function coverRow(album, database = getImageGalleryDb()) {
    try {
      return withDatabase(database, db => db.prepare("SELECT * FROM photo_set_covers WHERE album_id = ?").get(album.id)) || null;
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

  async function coverBlobFromFile(filePath, image, isExplicitCover, context) {
    const stat = await fs.promises.stat(filePath);
    if (!context.isCurrent()) throw archiveStoppedError();
    const sourceBytes = stat.size || Number(image?.bytes || 0);
    const mime = archiveImageMime(image?.path || image?.name || "");
    if (isExplicitCover && sourceBytes > 0 && sourceBytes <= coverMaxBytes) {
      return {
        blob: await readCoverFile(filePath, context),
        mime,
        sourceBytes
      };
    }

    const blob = await compressImageFileToJpeg(filePath, { signal: context.signal, waitForCloseOnAbort: true });
    return {
      blob,
      mime: "image/jpeg",
      sourceBytes
    };
  }

  async function readCoverFile(filePath, context) {
    const handle = await fs.promises.open(filePath, "r");
    try {
      const stat = await handle.stat();
      if (!context.isCurrent()) throw archiveStoppedError();
      if (!stat.isFile() || stat.size > coverMaxBytes) throw new Error("封面超过大小限制");
      const buffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!context.isCurrent()) throw archiveStoppedError();
        if (!bytesRead) break;
        offset += bytesRead;
      }
      return buffer.subarray(0, offset);
    } finally { await handle.close(); }
  }

  function coverMatches(row, signature) {
    return (
      row &&
      signature &&
      path.resolve(row.archive_path || "") === signature.archivePath &&
      Number(row.archive_size || 0) === signature.archiveSize &&
      Number(row.archive_mtime_ms || 0) === signature.archiveMtimeMs &&
      row.archive_identity && row.archive_identity === signature.archiveIdentity &&
      Number(row.generator_version || 1) === coverGeneratorVersion
    );
  }

  function upsertCoverError(album, signature, error, database) {
    const now = new Date().toISOString();
    try {
      withDatabase(database, db => db
        .prepare(
          `
          INSERT INTO photo_set_covers (
            album_id, archive_path, archive_size, archive_mtime_ms, member_path,
            cover_mime, cover_blob, cover_bytes, source_bytes, generator_version, status, error, generated_at, updated_at, archive_identity
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            updated_at = excluded.updated_at,
            archive_identity = excluded.archive_identity
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
          now,
          signature?.archiveIdentity || ""
        ));
    } catch (dbError) {
      console.warn("[image-gallery-cover-db]", dbError.message || dbError);
    }
  }

  function upsertCover(album, signature, image, cover, database) {
    const now = new Date().toISOString();
    const coverBlob = Buffer.from(cover.blob);
    withDatabase(database, db => db
      .prepare(
        `
        INSERT INTO photo_set_covers (
          album_id, archive_path, archive_size, archive_mtime_ms, member_path,
          cover_mime, cover_blob, cover_bytes, source_bytes, generator_version, status, error, generated_at, updated_at, archive_identity
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          updated_at = excluded.updated_at,
          archive_identity = excluded.archive_identity
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
        now,
        signature.archiveIdentity
      ));
    return coverRow(album, database);
  }

  async function generateCover(album, context) {
    const captured = authority(album, context);
    const targetArchivePath = archivePath(album);
    const signature = await archiveSignature(targetArchivePath, { signal: context.signal, waitForCloseOnAbort: true });
    if (!signature) {
      const error = new Error("图包压缩文件不存在");
      error.statusCode = 404;
      throw error;
    }

    if (!captured.current()) throw archiveStoppedError();
    const cached = coverRow(album, captured.db);
    if (coverMatches(cached, signature)) {
      const latest = await archiveSignature(targetArchivePath, { signal: context.signal, waitForCloseOnAbort: true });
      if (latest?.archiveIdentity !== signature.archiveIdentity || !captured.current()) throw archiveStoppedError();
      if (cached.status === "ok" && cached.cover_blob) return cached;
      const error = new Error(cached.error || "图包封面生成失败");
      error.statusCode = 404;
      throw error;
    }

    const images = await listArchiveImages(targetArchivePath, { signal: context.signal, waitForCloseOnAbort: true });
    const selected = selectCoverImage(images);
    if (!selected?.image?.path) {
      const error = new Error("图包里没有可用图片");
      error.statusCode = 404;
      const latest = await archiveSignature(targetArchivePath, { signal: context.signal, waitForCloseOnAbort: true });
      if (latest?.archiveIdentity === signature.archiveIdentity && captured.current()) upsertCoverError(album, signature, error, captured.db);
      throw error;
    }

    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fanhao-gallery-cover-"));
    const tempExt = archiveImageExts.has(normalizeExt(selected.image.path)) ? normalizeExt(selected.image.path) : ".img";
    const tempPath = path.join(tempDir, `source${tempExt}`);
    try {
      await extractArchiveMemberToCache(targetArchivePath, selected.image.path, tempPath, { signal: context.signal, waitForCloseOnAbort: true });
      const cover = await coverBlobFromFile(tempPath, selected.image, selected.isExplicitCover, context);
      const latest = await archiveSignature(targetArchivePath, { signal: context.signal, waitForCloseOnAbort: true });
      if (!latest || latest.archiveIdentity !== signature.archiveIdentity || !captured.current()) throw archiveStoppedError();
      return upsertCover(album, signature, selected.image, cover, captured.db);
    } catch (error) {
      if (context.isCurrent()) {
        const latest = await archiveSignature(targetArchivePath, { signal: context.signal, waitForCloseOnAbort: true });
        if (latest?.archiveIdentity === signature.archiveIdentity && captured.current()) upsertCoverError(album, signature, error, captured.db);
      }
      error.statusCode = error.statusCode || 500;
      throw error;
    } finally {
      await removeCoverTemp(tempDir, tempPath);
    }
  }

  async function removeCoverTemp(directory, filePath) {
    await fs.promises.unlink(filePath).catch(error => { if (error.code !== "ENOENT") throw error; });
    try { await fs.promises.rmdir(directory); return; } catch (error) { if (error.code !== "ENOTEMPTY") throw error; }
    // Interrupted Python extraction can leave its private atomic staging file.
    // Use the native Windows cleanup only for this owned temporary directory.
    if (process.platform !== "win32") { await fs.promises.rm(directory, { recursive: true }); return; }
    const resolved = await fs.promises.realpath(directory), temporary = await fs.promises.realpath(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== temporary.toLowerCase() || !path.basename(resolved).startsWith("fanhao-gallery-cover-")) throw new Error("Refusing cover temporary cleanup outside its owned root");
    await runArchiveChild("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "& { param([string]$target) $ErrorActionPreference='Stop'; $resolved=(Resolve-Path -LiteralPath $target).ProviderPath; $temporary=(Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).ProviderPath.TrimEnd('\\'); if (-not [string]::Equals([IO.Path]::GetDirectoryName($resolved),$temporary,[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid cover temp parent' }; if (-not [IO.Path]::GetFileName($resolved).StartsWith('fanhao-gallery-cover-')) { throw 'Invalid cover temp name' }; if ((Get-Item -LiteralPath $resolved).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Invalid cover temp link' }; Remove-Item -LiteralPath $resolved -Recurse -Force }", resolved],
      { timeoutMs: 30_000, maxBytes: 16 * 1024, onChild: (child, owned) => owned ? coverChildren.add(child) : coverChildren.delete(child) });
  }

  async function publicDetail(album, options = {}) {
    const targetArchivePath = archivePath(album);
    const imageOffset = Math.max(0, Math.floor(Number(options.imageOffset || 0)) || 0);
    const rawImageLimit = options.imageLimit;
    const imageLimit = Number.isFinite(Number(rawImageLimit)) && Number(rawImageLimit) > 0
      ? Math.floor(Number(rawImageLimit))
      : 0;
    const payload = await archiveImagesPayload(targetArchivePath, {
      limit: imageLimit > 0 ? imageOffset + imageLimit : 0,
      signal: options.signal
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
    if (res.destroyed || res.writableEnded) return;
    const album = byId(decodeURIComponent(albumId));
    if (!album) {
      notFound(res);
      return;
    }
    const index = Number(decodeURIComponent(imageIndex)) - 1;
    const controller = new AbortController(), disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.once?.("close",disconnect);
    try {
      const targetArchivePath = archivePath(album);
      const images = await listArchiveImages(targetArchivePath,{signal:controller.signal});
      if (controller.signal.aborted || res.destroyed || res.writableEnded) return;
      const image = images[index];
      if (!image?.path) { notFound(res); return; }
      await serveArchiveMemberImage(res, {
        sourceType: "photo-set", archivePath: targetArchivePath, memberPath: image.path,
        contentType: mimeTypes[normalizeExt(image.path)] || ""
      });
    } catch(error) {
      if (!controller.signal.aborted && !res.destroyed && !res.writableEnded) throw error;
    } finally { res.removeListener?.("close",disconnect); }
  }

  async function serveCover(res, albumId) {
    const album = byId(albumId);
    if (!album) {
      notFound(res);
      return;
    }

    if (res.destroyed || res.writableEnded) return;
    const controller = new AbortController(), disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.once?.("close", disconnect);
    let row;
    try { row = await coverPool.run(`cover:${albumId}`, context => generateCover(album, context), { signal: controller.signal }); }
    catch (error) {
      if (!res.destroyed && !res.writableEnded && !controller.signal.aborted) {
        console.warn("[image-gallery-cover]", album.relativePath || album.id, error.message || error);
        if (error.statusCode === 503) { res.writeHead(503); res.end("图片封面正在准备或停止，请稍后重试"); } else notFound(res);
      }
      return;
    } finally { res.removeListener?.("close", disconnect); }
    if (res.destroyed || res.writableEnded || controller.signal.aborted || !coverPool.isAccepting()) return;

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
    serveImage,
    start: coverPool.start,
    beginStop: coverPool.beginStop,
    stop: coverPool.stop,
    diagnostics: () => ({ ...coverPool.diagnostics(), children: coverChildren.size })
  };
}
