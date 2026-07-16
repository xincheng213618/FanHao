import crypto from "node:crypto";
import fs from "node:fs";

const REMOTE_IMAGE_LOOKUP_BATCH_SIZE = 200;

export function createMediaResponseService({
  coreImageRow,
  corePersonAvatarRow,
  getCoreDb,
  mediaBlobStore,
  isAllowedRemoteImageUrl,
  maxRemoteImageBytes,
  mimeTypes,
  normalizeExt,
  notFound,
  proxiedRemoteImageUrl,
  publicRemoteUrl,
  safeStat,
  sendText,
  workCoverRow,
  localImageReadConcurrency = 4,
  localImageWaitMs = 800,
  readFile = (filePath) => fs.promises.readFile(filePath),
  statFile = (filePath) => fs.promises.stat(filePath),
  remoteImageWarmConcurrency = 6,
  mediaBlobCacheMaxBytes = 512 * 1024 * 1024,
  warn = console.warn
}) {
  const blobStore = mediaBlobStore || createInlineMediaBlobStore({ coreImageRow, corePersonAvatarRow, getCoreDb, workCoverRow });
  const mediaBlobCache = new Map();
  let mediaBlobCacheBytes = 0;
  const localImageInflight = new Map();
  const localImageReadQueue = [];
  const maxLocalImageReads = Math.max(1, Number(localImageReadConcurrency) || 1);
  let localImageReadActive = 0;
  const remoteImageWarmQueue = [];
  const remoteImageWarmQueued = new Set();
  let remoteImageWarmActive = 0;
  let remoteImageWarmGeneration = 0;

  function serveBlobRow(res, row, options = {}) {
    const blob = row?.[options.blobField || "image_blob"];
    if (!blob) return false;
    const buffer = mediaBlobBuffer(blob);
    if (!buffer.length) return false;
    res.writeHead(200, {
      "Content-Type": row?.[options.mimeField || "mime"] || options.defaultMime || "image/jpeg",
      "Content-Length": buffer.length,
      "Cache-Control": options.cacheControl || "public, max-age=86400",
      "Content-Disposition": "inline"
    });
    res.end(buffer);
    return true;
  }

  function mediaBlobBuffer(blob) {
    if (Buffer.isBuffer(blob)) return blob;
    if (ArrayBuffer.isView(blob)) return Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
    if (blob instanceof ArrayBuffer) return Buffer.from(blob);
    return Buffer.from(blob);
  }

  async function serveCoreImage(res, imageId, options = {}) {
    const row = await cachedMediaBlobRow(`core:${imageId}:${options.version || ""}`, () => blobStore.coreImage(imageId));
    if (!serveBlobRow(res, row, { defaultMime: "image/jpeg" })) {
      notFound(res);
    }
  }

  async function serveActorAvatar(res, personId, options = {}) {
    const row = await cachedMediaBlobRow(`actor:${personId}:${options.version || ""}`, () => blobStore.actorAvatar(personId));
    if (!serveBlobRow(res, row, { defaultMime: "image/jpeg" })) {
      notFound(res);
    }
  }

  async function serveWorkCover(res, workId, options = {}) {
    const row = await cachedMediaBlobRow(`work:${workId}:${options.version || ""}`, () => blobStore.workCover(workId));
    if (!serveBlobRow(res, row, { blobField: "cover_blob", mimeField: "cover_mime", defaultMime: "image/jpeg" })) {
      notFound(res);
    }
  }

  async function cachedMediaBlobRow(key, loader) {
    if (mediaBlobCache.has(key)) {
      const cached = mediaBlobCache.get(key);
      mediaBlobCache.delete(key);
      mediaBlobCache.set(key, cached);
      return cached.row;
    }
    const row = await loader();
    rememberMediaBlobRow(key, row);
    return row;
  }

  function rememberMediaBlobRow(key, row) {
    const bytes = mediaBlobRowBytes(row);
    if (!bytes || bytes > mediaBlobCacheMaxBytes) return;
    const previous = mediaBlobCache.get(key);
    if (previous) mediaBlobCacheBytes -= previous.bytes;
    mediaBlobCache.delete(key);
    mediaBlobCache.set(key, { bytes, row });
    mediaBlobCacheBytes += bytes;
    while (mediaBlobCacheBytes > mediaBlobCacheMaxBytes && mediaBlobCache.size > 1) {
      const oldestKey = mediaBlobCache.keys().next().value;
      const oldest = mediaBlobCache.get(oldestKey);
      mediaBlobCache.delete(oldestKey);
      mediaBlobCacheBytes -= oldest?.bytes || 0;
    }
  }

  function mediaBlobRowBytes(row) {
    const blob = row?.image_blob || row?.cover_blob;
    return Number(blob?.byteLength || blob?.length || 0);
  }

  function localImageMime(file) {
    return mimeTypes[file?.ext] || "application/octet-stream";
  }

  function localImageCacheRow(file) {
    try {
      return (
        getCoreDb()
          .prepare(
            `
            SELECT *
            FROM local_image_cache
            WHERE file_id = ?
              AND image_blob IS NOT NULL
              AND length(image_blob) > 0
              AND source_size = ?
              AND source_mtime = ?
            `
          )
          .get(file.id, Number(file.size || 0), file.modifiedAt || "") || null
      );
    } catch (error) {
      warn("[local-image-cache]", error.message || error);
      return null;
    }
  }

  function serveLocalImageCacheRow(res, row) {
    return serveBlobRow(res, row, {
      mimeField: "content_type",
      defaultMime: "application/octet-stream"
    });
  }

  function upsertLocalImageCache(file, stat, buffer) {
    const now = new Date().toISOString();
    const sourceMtime = stat?.mtime?.toISOString() || file.modifiedAt || "";
    const sourceSize = Number(stat?.size ?? file.size ?? buffer.length) || 0;
    const contentType = localImageMime(file);
    getCoreDb()
      .prepare(
        `
        INSERT INTO local_image_cache (
          file_id, file_path, relative_path, content_type, image_blob, byte_length,
          source_size, source_mtime, status, error, cached_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', '', ?, ?)
        ON CONFLICT(file_id) DO UPDATE SET
          file_path = excluded.file_path,
          relative_path = excluded.relative_path,
          content_type = excluded.content_type,
          image_blob = excluded.image_blob,
          byte_length = excluded.byte_length,
          source_size = excluded.source_size,
          source_mtime = excluded.source_mtime,
          status = 'ok',
          error = '',
          cached_at = COALESCE(local_image_cache.cached_at, excluded.cached_at),
          updated_at = excluded.updated_at
        `
      )
      .run(
        file.id,
        file.path || "",
        file.relativePath || "",
        contentType,
        buffer,
        buffer.length,
        sourceSize,
        sourceMtime,
        now,
        now
      );
    return {
      content_type: contentType,
      image_blob: buffer,
      byte_length: buffer.length
    };
  }

  function upsertLocalImageCacheError(file, error) {
    try {
      const now = new Date().toISOString();
      getCoreDb()
        .prepare(
          `
          INSERT INTO local_image_cache (
            file_id, file_path, relative_path, content_type, image_blob, byte_length,
            source_size, source_mtime, status, error, cached_at, updated_at
          )
          VALUES (?, ?, ?, ?, NULL, 0, ?, ?, 'error', ?, NULL, ?)
          ON CONFLICT(file_id) DO UPDATE SET
            file_path = excluded.file_path,
            relative_path = excluded.relative_path,
            status = 'error',
            error = excluded.error,
            updated_at = excluded.updated_at
          `
        )
        .run(
          file.id,
          file.path || "",
          file.relativePath || "",
          localImageMime(file),
          Number(file.size || 0),
          file.modifiedAt || "",
          String(error?.message || error || "local image cache failed").slice(0, 1000),
          now
        );
    } catch (cacheError) {
      warn("[local-image-cache]", cacheError.message || cacheError);
    }
  }

  function serveImage(res, file) {
    if (serveLocalImageCacheRow(res, localImageCacheRow(file))) {
      return;
    }

    const stat = safeStat(file.path);
    if (!stat) {
      notFound(res);
      return;
    }
    if (stat.size <= 0) {
      upsertLocalImageCacheError(file, new Error("empty local image"));
      notFound(res);
      return;
    }

    let buffer = null;
    try {
      buffer = fs.readFileSync(file.path);
    } catch (error) {
      upsertLocalImageCacheError(file, error);
      warn("[local-image-cache]", error.message || error);
      sendText(res, 500, "Local image read failed");
      return;
    }

    try {
      if (serveLocalImageCacheRow(res, upsertLocalImageCache(file, stat, buffer))) return;
    } catch (error) {
      warn("[local-image-cache]", error.message || error);
    }

    res.writeHead(200, {
      "Content-Type": localImageMime(file),
      "Content-Length": buffer.length,
      "Cache-Control": "public, max-age=3600",
      "Content-Disposition": "inline"
    });
    res.end(buffer);
  }

  async function servePreparedImage(res, file) {
    if (serveLocalImageCacheRow(res, localImageCacheRow(file))) {
      return;
    }

    const result = await waitForLocalImage(localImageLoad(file));
    if (result.pending) {
      res.writeHead(503, {
        "Content-Length": "0",
        "Cache-Control": "no-store",
        "Retry-After": "1",
        "X-FanHao-Image-Prepare": "pending"
      });
      res.end();
      return;
    }
    if (result.error) {
      if (result.error.code === "ENOENT" || result.error.statusCode === 404) notFound(res);
      else sendText(res, 500, "Local image read failed");
      return;
    }
    if (!serveLocalImageCacheRow(res, result.row)) {
      sendText(res, 500, "Local image read failed");
    }
  }

  function localImageLoad(file) {
    const key = `${file.id || file.path}:${Number(file.size || 0)}:${file.modifiedAt || ""}`;
    const active = localImageInflight.get(key);
    if (active) return active;

    const task = enqueueLocalImageRead(file);
    localImageInflight.set(key, task);
    task.then(
      () => localImageInflight.delete(key),
      () => localImageInflight.delete(key)
    );
    return task;
  }

  function enqueueLocalImageRead(file) {
    return new Promise((resolve, reject) => {
      localImageReadQueue.push({ file, reject, resolve });
      drainLocalImageReadQueue();
    });
  }

  function drainLocalImageReadQueue() {
    while (localImageReadActive < maxLocalImageReads && localImageReadQueue.length) {
      const job = localImageReadQueue.shift();
      localImageReadActive += 1;
      readAndCacheLocalImage(job.file)
        .then(job.resolve, job.reject)
        .finally(() => {
          localImageReadActive -= 1;
          drainLocalImageReadQueue();
        });
    }
  }

  async function readAndCacheLocalImage(file) {
    try {
      const stat = await statFile(file.path);
      if (!stat?.isFile?.() || stat.size <= 0) {
        const error = new Error("empty or missing local image");
        error.statusCode = 404;
        throw error;
      }
      const buffer = await readFile(file.path);
      if (!buffer?.length) {
        const error = new Error("empty local image");
        error.statusCode = 404;
        throw error;
      }
      try {
        return upsertLocalImageCache(file, stat, buffer);
      } catch (error) {
        warn("[local-image-cache]", error.message || error);
        return {
          content_type: localImageMime(file),
          image_blob: buffer,
          byte_length: buffer.length
        };
      }
    } catch (error) {
      upsertLocalImageCacheError(file, error);
      warn("[local-image-cache]", error.message || error);
      throw error;
    }
  }

  async function waitForLocalImage(task) {
    let timer = null;
    const settled = task.then(
      (row) => ({ row }),
      (error) => ({ error })
    );
    const waitMs = Math.max(0, Number(localImageWaitMs) || 0);
    if (!waitMs) return settled;
    const pending = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ pending: true }), waitMs);
    });
    const result = await Promise.race([settled, pending]);
    if (timer) clearTimeout(timer);
    return result;
  }

  function remoteImageTargetUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";

    try {
      if (raw.startsWith("/media/remote-image")) {
        const parsed = new URL(raw, "http://localhost");
        const target = publicRemoteUrl(parsed.searchParams.get("url"));
        return target && isAllowedRemoteImageUrl(new URL(target)) ? target : "";
      }

      const target = publicRemoteUrl(raw);
      return target && isAllowedRemoteImageUrl(new URL(target)) ? target : "";
    } catch {
      return "";
    }
  }

  function prewarmRemoteImagesForWorks(works, limit = 1000, options = {}) {
    const queueLimit = Math.max(1, Math.min(512, Number(options.queueLimit) || limit));
    if (options.replaceQueued) {
      remoteImageWarmGeneration += 1;
      for (const remoteUrl of remoteImageWarmQueue) remoteImageWarmQueued.delete(remoteUrl);
      remoteImageWarmQueue.length = 0;
    }
    const seen = new Set();
    const remoteUrls = [];
    outer:
    for (const work of works || []) {
      const previewImages = [
        ...(Array.isArray(work.infoSummary?.previewImages) ? work.infoSummary.previewImages : []),
        ...(Array.isArray(work.infoMetadata?.previewImages) ? work.infoMetadata.previewImages : [])
      ].slice(0, 12);
      const candidates = [
        ...(!work.coverId && !work.cachedCover?.coverUrl ? [work.remoteCoverUrl, work.infoSummary?.imageUrl, work.infoMetadata?.imageUrl] : []),
        ...previewImages
      ];
      for (const candidate of candidates) {
        const remoteUrl = remoteImageTargetUrl(candidate);
        if (!remoteUrl || seen.has(remoteUrl)) continue;
        seen.add(remoteUrl);
        remoteUrls.push(remoteUrl);
        if (remoteUrls.length >= limit) break outer;
      }
    }

    queueUncachedRemoteImages(remoteUrls, queueLimit, remoteImageWarmGeneration);
    return remoteUrls.length;
  }

  async function queueUncachedRemoteImages(remoteUrls, queueLimit, generation) {
    const cachedUrls = await cachedRemoteImageUrls(remoteUrls);
    if (generation !== remoteImageWarmGeneration) return;
    for (const remoteUrl of remoteUrls) {
      if (remoteImageWarmQueue.length + remoteImageWarmActive >= queueLimit) break;
      if (!cachedUrls.has(remoteUrl)) enqueueRemoteImageWarm(remoteUrl);
    }
  }

  function proxiedRemoteImageUrlArray(values) {
    const urls = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
      const targetUrl = remoteImageTargetUrl(value);
      const url = targetUrl ? proxiedRemoteImageUrl(targetUrl) : proxiedRemoteImageUrl(value);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
    return urls;
  }

  function remoteImageCacheKey(remoteUrl) {
    return crypto.createHash("sha256").update(remoteUrl).digest("hex");
  }

  async function cachedRemoteImageUrls(remoteUrls) {
    const cached = new Set();
    const pending = [];
    for (const remoteUrl of remoteUrls) {
      if (mediaBlobCache.has(`remote:${remoteUrl}`)) cached.add(remoteUrl);
      else pending.push(remoteUrl);
    }
    if (!pending.length) return cached;
    try {
      for (const remoteUrl of await blobStore.cachedRemoteUrls(pending)) cached.add(remoteUrl);
    } catch (error) {
      warn("[remote-image-cache]", error.message || error);
    }
    return cached;
  }

  function remoteImageMimeFromUrl(remoteUrl) {
    try {
      const ext = normalizeExt(new URL(remoteUrl).pathname);
      return mimeTypes[ext] || "";
    } catch {
      return "";
    }
  }

  function normalizeRemoteImageMime(contentType, remoteUrl) {
    const mime = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
    if (["image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp"].includes(mime)) return mime;
    return remoteImageMimeFromUrl(remoteUrl) || "image/jpeg";
  }

  function serveRemoteImageRow(res, row) {
    return serveBlobRow(res, row, {
      mimeField: "content_type",
      defaultMime: "image/jpeg"
    });
  }

  async function downloadRemoteImage(remoteUrl) {
    const response = await fetch(remoteUrl, {
      signal: AbortSignal.timeout(15000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        Referer: "https://javdb.com/"
      }
    });

    if (!response.ok) {
      const error = new Error(`远程图片请求失败：${response.status}`);
      error.statusCode = 502;
      throw error;
    }

    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > maxRemoteImageBytes) {
      const error = new Error("远程图片过大");
      error.statusCode = 413;
      throw error;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxRemoteImageBytes) {
      const error = new Error("远程图片过大");
      error.statusCode = 413;
      throw error;
    }

    return {
      buffer,
      contentType: normalizeRemoteImageMime(response.headers.get("content-type"), remoteUrl)
    };
  }

  function enqueueRemoteImageWarm(remoteUrl) {
    if (remoteImageWarmQueued.has(remoteUrl)) return false;
    remoteImageWarmQueued.add(remoteUrl);
    remoteImageWarmQueue.push(remoteUrl);
    drainRemoteImageWarmQueue();
    return true;
  }

  function drainRemoteImageWarmQueue() {
    while (remoteImageWarmActive < remoteImageWarmConcurrency && remoteImageWarmQueue.length) {
      const remoteUrl = remoteImageWarmQueue.shift();
      remoteImageWarmActive += 1;
      warmRemoteImage(remoteUrl)
        .catch((error) => {
          warn("[remote-image-cache]", error.message || error);
        })
        .finally(() => {
          remoteImageWarmActive -= 1;
          remoteImageWarmQueued.delete(remoteUrl);
          drainRemoteImageWarmQueue();
        });
    }
  }

  async function warmRemoteImage(remoteUrl) {
    const downloaded = await downloadRemoteImage(remoteUrl);
    const now = new Date().toISOString();
    const row = {
      content_type: downloaded.contentType,
      image_blob: downloaded.buffer,
      byte_length: downloaded.buffer.length,
      updated_at: now
    };
    rememberMediaBlobRow(`remote:${remoteUrl}`, row);
    await blobStore.upsertRemote({
      url: remoteUrl,
      urlHash: remoteImageCacheKey(remoteUrl),
      contentType: downloaded.contentType,
      buffer: downloaded.buffer,
      byteLength: downloaded.buffer.length,
      updatedAt: now
    });
  }

  async function serveCachedRemoteImage(req, res, url) {
    const remoteUrl = publicRemoteUrl(url.searchParams.get("url"));
    if (!remoteUrl) {
      sendText(res, 400, "Missing remote image URL");
      return;
    }

    const parsed = new URL(remoteUrl);
    if (!isAllowedRemoteImageUrl(parsed)) {
      sendText(res, 403, "Remote image host is not allowed");
      return;
    }

    const cachedRow = await cachedMediaBlobRow(`remote:${remoteUrl}`, () => blobStore.remoteImage(remoteUrl));
    if (serveRemoteImageRow(res, cachedRow)) {
      return;
    }

    enqueueRemoteImageWarm(remoteUrl);
    res.writeHead(302, {
      Location: remoteUrl,
      "Cache-Control": "no-store"
    });
    res.end();
  }

  return {
    localImageMime,
    localImageCacheRow,
    prewarmRemoteImagesForWorks,
    proxiedRemoteImageUrlArray,
    remoteImageTargetUrl,
    serveActorAvatar,
    serveCachedRemoteImage,
    serveCoreImage,
    serveImage,
    servePreparedImage,
    serveLocalImageCacheRow,
    serveWorkCover
  };
}

function createInlineMediaBlobStore({ coreImageRow, corePersonAvatarRow, getCoreDb, workCoverRow }) {
  return {
    async actorAvatar(personId) {
      return corePersonAvatarRow(personId);
    },
    async cachedRemoteUrls(remoteUrls) {
      const cached = [];
      for (let offset = 0; offset < remoteUrls.length; offset += REMOTE_IMAGE_LOOKUP_BATCH_SIZE) {
        const batch = remoteUrls.slice(offset, offset + REMOTE_IMAGE_LOOKUP_BATCH_SIZE);
        if (!batch.length) continue;
        const placeholders = batch.map(() => "?").join(", ");
        const rows = getCoreDb()
          .prepare(`SELECT url FROM remote_image_cache WHERE url IN (${placeholders})`)
          .all(...batch);
        for (const row of rows) cached.push(row.url);
      }
      return cached;
    },
    async coreImage(imageId) {
      return coreImageRow(imageId);
    },
    async remoteImage(remoteUrl) {
      return getCoreDb().prepare("SELECT content_type, image_blob, byte_length, updated_at FROM remote_image_cache WHERE url = ?").get(remoteUrl) || null;
    },
    async upsertRemote(record) {
      getCoreDb()
        .prepare(`
          INSERT INTO remote_image_cache (
            url, url_hash, content_type, image_blob, byte_length, status, error, fetched_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, 'ok', '', ?, ?)
          ON CONFLICT(url) DO UPDATE SET
            url_hash = excluded.url_hash,
            content_type = excluded.content_type,
            image_blob = excluded.image_blob,
            byte_length = excluded.byte_length,
            status = 'ok',
            error = '',
            fetched_at = excluded.fetched_at,
            updated_at = excluded.updated_at
        `)
        .run(
          record.url,
          record.urlHash,
          record.contentType,
          record.buffer,
          record.byteLength,
          record.updatedAt,
          record.updatedAt
        );
      return true;
    },
    async workCover(workId) {
      return workCoverRow(workId);
    }
  };
}
