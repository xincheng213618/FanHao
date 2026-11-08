import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createArchiveTaskPool, runArchiveChild, archiveStoppedError } from "../../../platform/server/archive-task-pool.js";
import { parseBoBoSocksAlbum } from "../../../../lib/bobosocks-album.js";
import { photoPersonShelfName } from "../../../../lib/photo-person-shelf.js";
import { parseWesternPhotoAlbum } from "../../../../lib/western-photo-album.js";
import { officialPhotoCoverRevision, photoCoverHintScore } from "./photo-cover-source.js";

const unavailableCover = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 450">
  <rect width="300" height="450" fill="#ececf1"/>
  <text x="150" y="225" fill="#555a91" font-size="15" font-family="sans-serif" text-anchor="middle" dominant-baseline="middle">暂无封面</text>
</svg>`;
const missingImageCover = "图包里没有可用图片";

function archiveMemberDepth(memberPath) {
  return String(memberPath || "").replace(/\\/g, "/").split("/").filter(Boolean).length;
}

export function createPhotoSetService({
  archiveMarks,
  archiveImageExts,
  archiveImageSignature,
  archiveImagesPayload,
  archiveVideosPayload,
  compressImageFileToJpeg,
  coverGeneratorVersion,
  coverHints,
  coverMaxBytes,
  extractArchiveMemberToCache,
  extractArchiveVideoCover,
  fileBase,
  getImageGalleryDb,
  getImageLibraryIndex,
  listArchiveImages,
  mimeTypes,
  normalizeExt,
  notFound,
  photoSetById,
  publishedPhotoSetById,
  safeChildPath,
  safeStat,
  serveArchiveMemberImage,
  serveArchiveMemberVideo,
  setArchiveMarkedA
}) {
  const coverPool = createArchiveTaskPool();
  const coverChildren = new Set();
  const videoCoversEnabled = Boolean(archiveVideosPayload && extractArchiveVideoCover);
  function withDatabase(db, operation) {
    if (typeof db.exec !== "function") return operation(db);
    const previous = Number(db.prepare("PRAGMA busy_timeout").get().timeout);
    db.exec("PRAGMA busy_timeout = 0");
    try { return operation(db); } finally { db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(previous || 0))}`); }
  }
  const albumStamp = value => JSON.stringify([value?.id, value?.sourceRoot, value?.relativePath, value?.updatedAt, value?.size, value?.archiveIdentity]);
  const rowStamp = value => JSON.stringify(value && { ...value, cover_blob: null });
  function rowSnapshot(value) {
    let blob = value?.cover_blob ? Buffer.from(value.cover_blob) : null;
    // ArrayBuffer conversion shares storage; the authority baseline must not.
    if (blob && blob.buffer === value.cover_blob) blob = Buffer.from(blob);
    return { stamp: rowStamp(value), blob };
  }
  function rowMatches(value, snapshot) {
    const raw = value?.cover_blob;
    const blob = raw ? (raw instanceof Uint8Array ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength) : Buffer.from(raw)) : null;
    return rowStamp(value) === snapshot.stamp && (blob ? !!snapshot.blob && blob.equals(snapshot.blob) : snapshot.blob === null);
  }
  function authority(album, context) {
    const db = getImageGalleryDb(), snapshot = rowSnapshot(coverRow(album, db));
    return { db, stamp: snapshot.stamp, album: albumStamp(album), current: () => context.isCurrent() && getImageGalleryDb() === db && albumStamp(byId(album.id)) === albumStamp(album) && rowMatches(coverRow(album, db), snapshot) };
  }
  function imageUrl(albumId, imageIndex) {
    return `/media/gallery/${encodeURIComponent(albumId)}/${encodeURIComponent(String(imageIndex))}`;
  }

  function coverUrl(albumId, updatedAt = "") {
    const suffix = updatedAt ? `?v=${encodeURIComponent(updatedAt)}` : "";
    return `/media/gallery-cover/${encodeURIComponent(albumId)}${suffix}`;
  }

  function versionedCoverUrl(url, revision) {
    return `${url}${url.includes("?") ? "&" : "?"}cover=${encodeURIComponent(revision)}`;
  }

  function withCoverOverrides(items) {
    const coverIds = items.map(item => {
      const match = /^\/media\/gallery-cover\/([^/?]+)(?:\?|$)/.exec(item?.coverUrl || "");
      return match ? decodeURIComponent(match[1]) : "";
    });
    const ids = [...new Set(coverIds.filter(Boolean))];
    if (!ids.length) return items;
    const revisions = withDatabase(getImageGalleryDb(), db => {
      const result = new Map();
      for (let start = 0; start < ids.length; start += 200) {
        const batch = ids.slice(start, start + 200);
        const placeholders = batch.map(() => "?").join(",");
        for (const row of db.prepare(`SELECT album_id, official_source FROM photo_set_covers
          WHERE album_id IN (${placeholders}) AND official_source IS NOT NULL AND member_path IS NULL AND status='ok'`).all(...batch)) {
          const revision = officialPhotoCoverRevision(row);
          if (revision) result.set(row.album_id, revision);
        }
        for (const row of db.prepare(`SELECT album_id, revision FROM photo_set_cover_overrides WHERE album_id IN (${placeholders})`).all(...batch)) {
          result.set(row.album_id, row.revision);
        }
      }
      return result;
    });
    if (!revisions.size) return items;
    return items.map((item, index) => {
      const revision = revisions.get(coverIds[index]);
      return revision ? { ...item, coverUrl: versionedCoverUrl(item.coverUrl, revision) } : item;
    });
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

  function coverHintScore(image) {
    return photoCoverHintScore(image?.path || image?.name || "", coverHints, fileBase);
  }

  function selectCoverImage(images = []) {
    const candidates = images.filter((image) => image?.path);
    if (!candidates.length) return null;

    const explicit = candidates.reduce((best, image) => {
      const hintScore = coverHintScore(image);
      const depth = archiveMemberDepth(image.path);
      const ext = normalizeExt(image.path);
      const tieScore = (depth <= 1 ? 40 : Math.max(0, 30 - depth * 5)) + ([".jpg", ".jpeg", ".webp", ".png"].includes(ext) ? 10 : 0);
      const score = hintScore + tieScore;
      return hintScore > 0 && (!best || score > best.score) ? { image, score } : best;
    }, null);

    if (explicit) return { image: explicit.image, isExplicitCover: true };
    return { image: candidates[0], isExplicitCover: false };
  }

  async function coverBlobFromFile(filePath, image, context) {
    const stat = await fs.promises.stat(filePath);
    if (!context.isCurrent()) throw archiveStoppedError();
    const sourceBytes = stat.size || Number(image?.bytes || 0);
    // Explicit cover files still win selection, but every stored cover goes
    // through the same box scale so cards never ship multi-megapixel blobs.
    const blob = await compressImageFileToJpeg(filePath, { signal: context.signal, waitForCloseOnAbort: true });
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
      row.archive_identity && row.archive_identity === signature.archiveIdentity &&
      (officialPhotoCoverRevision(row) || Number(row.generator_version || 1) === coverGeneratorVersion) &&
      !needsVideoCoverRetry(row)
    );
  }

  function needsVideoCoverRetry(row) {
    return videoCoversEnabled && row.status === "error" && row.error === missingImageCover;
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
            official_source = NULL,
            generated_at = excluded.generated_at,
            updated_at = excluded.updated_at,
            archive_identity = excluded.archive_identity
          WHERE NOT (photo_set_covers.official_source IS NOT NULL AND photo_set_covers.member_path IS NULL
            AND photo_set_covers.status='ok' AND photo_set_covers.archive_identity IS excluded.archive_identity)
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
          official_source = NULL,
          generated_at = excluded.generated_at,
          updated_at = excluded.updated_at,
          archive_identity = excluded.archive_identity
        WHERE NOT (photo_set_covers.official_source IS NOT NULL AND photo_set_covers.member_path IS NULL
          AND photo_set_covers.status='ok' AND photo_set_covers.archive_identity IS excluded.archive_identity)
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

  function matchesPublishedArchive(album, signature) {
    if (!signature.archiveIdentity || signature.archivePath !== archivePath(album)) return false;
    if (album.archiveIdentity) return album.archiveIdentity === signature.archiveIdentity;
    // Legacy JSON snapshots have a path, size and ISO mtime, but no file identity.
    return Number(album.size) === signature.archiveSize && Date.parse(album.updatedAt) === Math.trunc(signature.archiveMtimeMs);
  }

  function coverOverride(album, database = getImageGalleryDb?.(), includeBlob = false) {
    if (!database) return null;
    const columns = includeBlob ? "*" : "archive_path, archive_size, archive_mtime_ms, archive_identity, member_path, image_index, revision";
    return withDatabase(database, db => db.prepare(`SELECT ${columns} FROM photo_set_cover_overrides WHERE album_id = ?`).get(album.id));
  }

  function overrideMatchesAlbum(row, album) {
    return row && matchesPublishedArchive(album, { archivePath: row.archive_path, archiveSize: row.archive_size,
      archiveMtimeMs: row.archive_mtime_ms, archiveIdentity: row.archive_identity });
  }

  function publicCoverOverride(album, row) {
    return { coverImageIndex: row.image_index, coverUrl: versionedCoverUrl(album.coverUrl, row.revision) };
  }

  async function setCover(albumId, { imageIndex, memberPath } = {}, { signal } = {}) {
    if (!Number.isSafeInteger(imageIndex) || imageIndex < 1 || typeof memberPath !== "string" || !memberPath || memberPath.length > 4096) {
      throw Object.assign(new Error("请选择有效的封面图片"), { statusCode: 400 });
    }
    const album = byId(albumId);
    if (!album) throw Object.assign(new Error("套图不存在"), { statusCode: 404 });
    const requestKey = JSON.stringify([album.id, imageIndex, memberPath]);
    return coverPool.run(`cover-edit:${requestKey}`, async context => {
      const db = getImageGalleryDb();
      const previous = coverOverride(album, db);
      const target = archivePath(album);
      const request = { signal: context.signal, waitForCloseOnAbort: true };
      const changed = () => Object.assign(new Error("套图或封面已变更，请刷新后重试"), { statusCode: 409 });
      const signature = await archiveSignature(target, request);
      if (!signature || !matchesPublishedArchive(album, signature)) throw changed();
      const images = await listArchiveImages(target, request);
      const image = images[imageIndex - 1];
      if (!image?.path || image.path !== memberPath) throw changed();
      if (previous?.archive_identity === signature.archiveIdentity && previous.member_path === image.path && previous.image_index === imageIndex) {
        if (!context.isCurrent() || getImageGalleryDb() !== db) throw archiveStoppedError();
        if (coverOverride(album, db)?.revision !== previous.revision || albumStamp(byId(album.id)) !== albumStamp(album)) throw changed();
        return publicCoverOverride(album, previous);
      }
      const cover = await extractCover(target, image, context);
      const latest = await archiveSignature(target, request);
      if (!context.isCurrent() || getImageGalleryDb() !== db) throw archiveStoppedError();
      if (latest?.archiveIdentity !== signature.archiveIdentity || albumStamp(byId(album.id)) !== albumStamp(album)) throw changed();
      const revision = randomUUID();
      const result = withDatabase(db, database => database.prepare(`
        INSERT INTO photo_set_cover_overrides (album_id, archive_path, archive_size, archive_mtime_ms,
          archive_identity, member_path, image_index, cover_blob, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(album_id) DO UPDATE SET archive_path=excluded.archive_path, archive_size=excluded.archive_size,
          archive_mtime_ms=excluded.archive_mtime_ms, archive_identity=excluded.archive_identity, member_path=excluded.member_path,
          image_index=excluded.image_index, cover_blob=excluded.cover_blob, revision=excluded.revision
        WHERE photo_set_cover_overrides.revision IS ?
      `).run(album.id, signature.archivePath, signature.archiveSize, signature.archiveMtimeMs, signature.archiveIdentity,
        image.path, imageIndex, Buffer.from(cover.blob), revision, previous?.revision ?? null));
      if (!result.changes) throw changed();
      return publicCoverOverride(album, { image_index: imageIndex, revision });
    }, { signal });
  }

  async function extractCover(target, image, context) {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fanhao-gallery-cover-"));
    const ext = archiveImageExts.has(normalizeExt(image.path)) ? normalizeExt(image.path) : ".img";
    const tempPath = path.join(tempDir, `source${ext}`);
    try {
      await extractArchiveMemberToCache(target, image.path, tempPath, { signal: context.signal, waitForCloseOnAbort: true });
      return await coverBlobFromFile(tempPath, image, context);
    } finally {
      await removeCoverTemp(tempDir, tempPath);
    }
  }

  async function generateCover(album, context, published, imagesOnly = false) {
    const captured = authority(album, context);
    const targetArchivePath = archivePath(album);
    const signature = await archiveSignature(targetArchivePath, { signal: context.signal, waitForCloseOnAbort: true });
    if (!signature) {
      const error = new Error("图包压缩文件不存在");
      error.statusCode = 404;
      throw error;
    }
    if (published && !matchesPublishedArchive(album, signature)) {
      throw Object.assign(new Error("图包已变更，请刷新图库索引"), { statusCode: 404 });
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

    const request = { signal: context.signal, waitForCloseOnAbort: true };
    const images = await listArchiveImages(targetArchivePath, request);
    const selected = selectCoverImage(images);
    if (imagesOnly && !selected) return null;
    let video;
    if (!selected && videoCoversEnabled) {
      const payload = await archiveVideosPayload(targetArchivePath, request);
      if (payload.archiveIdentity !== signature.archiveIdentity || !captured.current()) throw archiveStoppedError();
      video = payload.videos[0];
    }
    const member = selected?.image || video;
    if (!member?.path) {
      const error = new Error(videoCoversEnabled ? "图包里没有可用图片或视频" : missingImageCover);
      error.statusCode = 404;
      const latest = await archiveSignature(targetArchivePath, { signal: context.signal, waitForCloseOnAbort: true });
      if (latest?.archiveIdentity === signature.archiveIdentity && captured.current()) upsertCoverError(album, signature, error, captured.db);
      throw error;
    }

    try {
      const cover = video
        ? await extractArchiveVideoCover({ ...request, archivePath: targetArchivePath, archiveIdentity: signature.archiveIdentity, video })
        : await extractCover(targetArchivePath, member, context);
      const latest = await archiveSignature(targetArchivePath, { signal: context.signal, waitForCloseOnAbort: true });
      if (!latest || latest.archiveIdentity !== signature.archiveIdentity || !captured.current()) throw archiveStoppedError();
      return upsertCover(album, signature, member, cover, captured.db);
    } catch (error) {
      // A video may be playable again after a transient cache or decoder error.
      if (!video && context.isCurrent()) {
        const latest = await archiveSignature(targetArchivePath, { signal: context.signal, waitForCloseOnAbort: true });
        if (latest?.archiveIdentity === signature.archiveIdentity && captured.current()) upsertCoverError(album, signature, error, captured.db);
      }
      error.statusCode = error.statusCode || 500;
      throw error;
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
    const imageRequest = archiveImagesPayload(targetArchivePath, {
      // The archive cache already owns the full list; copy only the visible page.
      limit: 0,
      signal: options.signal
    });
    const [payload, videoPayload] = await Promise.all([
      imageRequest,
      archiveVideosPayload?.(targetArchivePath, { signal: options.signal }).catch(error => {
        if (options.signal?.aborted) throw error;
        return { videos: [], failed: true };
      })
    ]);
    const images = Array.isArray(payload.images) ? payload.images : [];
    const fallbackCount = imageLimit > 0 ? Math.min(images.length, imageOffset + imageLimit) : images.length;
    const imageCount = Number(payload.imageCount || fallbackCount || 0);
    const visibleImages = imageLimit > 0
      ? images.slice(imageOffset, imageOffset + imageLimit)
      : images;
    const boBoSocks = parseBoBoSocksAlbum(album.title);
    const override = coverOverride(album);
    const manual = overrideMatchesAlbum(override, album);
    const official = !manual && getImageGalleryDb && withDatabase(getImageGalleryDb(), db => db.prepare(`SELECT official_source
      FROM photo_set_covers WHERE album_id=? AND official_source IS NOT NULL AND member_path IS NULL AND status='ok'`).get(album.id));
    const officialRevision = officialPhotoCoverRevision(official);
    const shelfPerson = photoPersonShelfName(album);
    const western = parseWesternPhotoAlbum(album);
    return {
      ...album,
      ...(shelfPerson ? { personName: shelfPerson } : {}),
      ...(getImageGalleryDb ? { coverEditable: true } : {}),
      ...(manual ? publicCoverOverride(album, override) : officialRevision
        ? { coverUrl: versionedCoverUrl(album.coverUrl, officialRevision) } : {}),
      ...(boBoSocks ? { ...boBoSocks, archiveTitle: album.title, title: `${boBoSocks.albumNumber} ${boBoSocks.albumSubject}` } : {}),
      ...(western ? { ...western, title: western.albumSubject } : {}),
      ...(archiveMarks?.([album.id]).has(album.id) ? { markedA: true } : {}),
      imageCount,
      imageOffset,
      imageLimit: imageLimit || images.length,
      imagesTruncated: imageLimit > 0 && imageOffset + visibleImages.length < imageCount,
      ...(videoPayload ? {
        videos: videoPayload.videos.map(video => ({
          id: video.id, title: video.name, ext: video.ext, size: video.size,
          streamUrl: `/media/gallery-archive-video/${encodeURIComponent(album.id)}/${video.id}`
        })),
        ...(videoPayload.failed ? { videoListError: true } : {})
      } : {}),
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

  async function serveVideo(req, res, albumId, videoId) {
    const album = byId(albumId);
    if (!album || !archiveVideosPayload) { notFound(res); return; }
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.once("close", disconnect);
    try {
      if (res.destroyed || res.writableEnded) return;
      const target = archivePath(album);
      const { videos, archiveIdentity } = await archiveVideosPayload(target, { signal: controller.signal });
      if (controller.signal.aborted || res.destroyed || res.writableEnded) return;
      const video = videos.find(item => item.id === videoId);
      if (!video) { notFound(res); return; }
      await serveArchiveMemberVideo(req, res, { archivePath: target, archiveIdentity, video, signal: controller.signal });
    } catch (error) {
      if (!controller.signal.aborted && !res.destroyed && !res.writableEnded) throw error;
    } finally {
      res.off("close", disconnect);
    }
  }

  function serveUnavailableCover(res, fallback, cacheable) {
    if (!fallback) return notFound(res);
    const cacheControl = cacheable ? "private, max-age=60" : "no-store";
    if (fallback === "empty") {
      res.writeHead(204, { "Cache-Control": cacheControl });
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": cacheControl
    });
    res.end(unavailableCover);
  }

  function serveCoverBlob(res, row, cacheable = true) {
    const buffer = Buffer.from(row.cover_blob);
    res.writeHead(200, {
      "Content-Type": row.cover_mime || "image/jpeg",
      "Content-Length": buffer.length,
      "Cache-Control": cacheable ? "public, max-age=86400" : "no-store",
      "Content-Disposition": "inline"
    });
    res.end(buffer);
  }

  function publishedCover(album) {
    const cached = coverRow(album);
    if (cached && (officialPhotoCoverRevision(cached) || Number(cached.generator_version) === coverGeneratorVersion)
      && !needsVideoCoverRetry(cached) && matchesPublishedArchive(album, {
      archivePath: cached.archive_path, archiveSize: Number(cached.archive_size),
      archiveMtimeMs: Number(cached.archive_mtime_ms), archiveIdentity: cached.archive_identity
    })) return cached;
    return null;
  }

  async function warmImageCover(albumId, signal) {
    if (signal?.aborted || !coverPool.isAccepting()) throw archiveStoppedError();
    const album = publishedPhotoSetById?.(albumId);
    if (!album) return "missing";
    if (overrideMatchesAlbum(coverOverride(album), album)) return "cached";
    const cached = publishedCover(album);
    if (cached?.status === "ok" && cached.cover_blob) return "cached";
    if (cached?.status === "error") return "missing";
    const row = await coverPool.run(`image-cover:${albumId}`,
      context => generateCover(album, context, true, true), { signal, waitForCloseOnAbort: true });
    return row?.cover_blob ? "generated" : "skipped";
  }

  async function serveCover(res, albumId, { fallback = false, revision = null } = {}) {
    const published = publishedPhotoSetById?.(albumId);
    const album = published === undefined ? byId(albumId) : published;
    if (!album) {
      serveUnavailableCover(res, fallback, false);
      return;
    }

    if (res.destroyed || res.writableEnded) return;
    if (coverPool.isAccepting()) {
      const override = coverOverride(album, getImageGalleryDb(), true);
      if (overrideMatchesAlbum(override, album)) return serveCoverBlob(res, override, override.revision === revision);
    }
    if (published && coverPool.isAccepting()) {
      const cached = publishedCover(album);
      if (cached) {
        if (cached.status === "ok" && cached.cover_blob) return serveCoverBlob(res, cached, (officialPhotoCoverRevision(cached) || null) === revision);
        if (cached.status === "error") return serveUnavailableCover(res, fallback, true);
      }
    }
    const controller = new AbortController(), disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.once?.("close", disconnect);
    let row;
    try { row = await coverPool.run(`cover:${albumId}`, context => generateCover(album, context, Boolean(published)), { signal: controller.signal }); }
    catch (error) {
      if (!res.destroyed && !res.writableEnded && !controller.signal.aborted) {
        console.warn("[image-gallery-cover]", album.relativePath || album.id, error.message || error);
        if (error.statusCode === 503) {
          res.writeHead(503);
          res.end("图片封面正在准备或停止，请稍后重试");
        } else {
          serveUnavailableCover(res, fallback, error.statusCode === 404);
        }
      }
      return;
    } finally { res.removeListener?.("close", disconnect); }
    if (res.destroyed || res.writableEnded || controller.signal.aborted || !coverPool.isAccepting()) return;

    if (!row?.cover_blob) {
      serveUnavailableCover(res, fallback, false);
      return;
    }

    serveCoverBlob(res, row, (officialPhotoCoverRevision(row) || null) === revision);
  }

  return {
    archivePath,
    byId,
    coverUrl,
    imageUrl,
    publicDetail,
    setArchiveMarkedA,
    setCover,
    serveCover,
    serveImage,
    serveVideo,
    warmImageCover,
    withCoverOverrides,
    start: coverPool.start,
    beginStop: coverPool.beginStop,
    stop: coverPool.stop,
    diagnostics: () => ({ ...coverPool.diagnostics(), children: coverChildren.size })
  };
}
