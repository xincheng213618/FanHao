import crypto from "node:crypto";
import fs from "node:fs";
import { hasSqliteTables } from "./sqlite-schema.js";
import { createLocalImageReadQueue } from "./local-image-read-queue.js";
import { createRemoteImageWarmQueue, readRemoteImageBody } from "./remote-image-warm-queue.js";

const REMOTE_IMAGE_LOOKUP_BATCH_SIZE = 200;
export const MAX_REMOTE_IMAGE_URL_LENGTH = 64 * 1024;
const MAX_REMOTE_IMAGE_ENVELOPE_LENGTH = MAX_REMOTE_IMAGE_URL_LENGTH * 3 + 512;
const MEDIA_BLOB_CACHE_ENTRY_BYTES = 512;

function finiteCacheLimit(value,fallback,maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0,Math.min(maximum,Math.trunc(number))) : fallback;
}

export function createMediaResponseService({
  coreImageRow,
  corePersonAvatarRow,
  getCoreDb,
  mediaBlobStore,
  isAllowedRemoteImageUrl,
  maxRemoteImageBytes = 20 * 1024 * 1024,
  mimeTypes,
  normalizeExt,
  notFound,
  proxiedRemoteImageUrl,
  publicRemoteUrl,
  sendText,
  workCoverRow,
  localImageReadConcurrency = 4,
  localImageReadCapacity = 128,
  localImageWaitMs = 800,
  readFile = (filePath, options) => fs.promises.readFile(filePath, options),
  statFile = (filePath) => fs.promises.stat(filePath),
  resolveCurrentLocalImageSource,
  remoteImageWarmConcurrency = 6,
  remoteImageWarmCapacity = 128,
  remoteImageStopWaitMs = 2000,
  fetchRemoteImage = (...args) => fetch(...args),
  mediaBlobCacheMaxBytes = 512 * 1024 * 1024,
  mediaBlobCacheMaxEntries = 4096,
  warn = console.warn
}) {
  const blobStore = mediaBlobStore || createInlineMediaBlobStore({ coreImageRow, corePersonAvatarRow, getCoreDb, workCoverRow });
  const mediaBlobCache = new Map();
  const cacheByteLimit = finiteCacheLimit(mediaBlobCacheMaxBytes,512 * 1024 * 1024,2 * 1024 * 1024 * 1024);
  const cacheEntryLimit = finiteCacheLimit(mediaBlobCacheMaxEntries,4096,16384);
  let mediaBlobCacheBytes = 0;
  const mediaBlobLoads = new Map();
  let mediaGeneration = 0;
  let accepting = true;
  const localImageReader = createLocalImageReadQueue({
    concurrency: localImageReadConcurrency,
    capacity: localImageReadCapacity,
    sourceKey: localImageSourceKey,
    sourceId: (file) => String(file?.id || file?.path || ""),
    statFile, readFile,
    capture: captureLocalImageState,
    current: localImageStateCurrent,
    persist: (file, stat, buffer, context) => upsertLocalImageCache(file, stat, buffer, context.db),
    persistError: (file, error, context) => upsertLocalImageCacheError(file, error, context.db),
    fallback: (file, buffer) => ({ content_type: localImageMime(file), image_blob: buffer, byte_length: buffer.length, cache_control: "public, max-age=3600" }),
    warn: (error) => warn("[local-image-cache]", error.message || error)
  });
  const remoteImageWarmer = createRemoteImageWarmQueue({
    run: warmRemoteImage,
    concurrency: remoteImageWarmConcurrency,
    capacity: remoteImageWarmCapacity,
    stopWaitMs: remoteImageStopWaitMs,
    warn: (error) => warn("[remote-image-cache]", error.message || error)
  });
  let remoteImageWarmGeneration = 0;

  function serveBlobRow(res, row, options = {}) {
    if (res.destroyed || res.writableEnded) return true;
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
    if (!accepting) throw Object.assign(new Error("媒体图片服务正在停止"), { statusCode: 503 });
    const generation = mediaGeneration;
    const version = String(options.version || "");
    let row = null;
    if (version) {
      const key = `actor:${personId}:${version}`;
      const authority = typeof blobStore.actorAvatarVersion === "function"
        ? await blobStore.actorAvatarVersion(personId, version)
        : await blobStore.actorAvatar(personId, version).then((value) => ({ status: value ? "available" : "missing", row: value }));
      if (authority?.status === "revoked") {
        forgetMediaBlobRow(key);
        res.writeHead(410, {
          "Cache-Control": "private, no-store",
          "Content-Length": "0"
        });
        res.end();
        return;
      }
      if (authority?.status !== "available" || !authority.row) {
        forgetMediaBlobRow(key);
        notFound(res);
        return;
      }
      // The durable tombstone is checked before this process cache on every
      // versioned request. That keeps a pre-revoke cached BLOB from surviving
      // a logical revoke in the same server process.
      row = mediaBlobCache.get(key)?.row || authority.row;
      if (generation === mediaGeneration) rememberMediaBlobRow(key, authority.row);
    } else {
      row = await blobStore.actorAvatar(personId, "");
    }
    if (!serveBlobRow(res, row, {
      defaultMime: "image/jpeg",
      cacheControl: version ? "private, no-store" : "no-store"
    })) {
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
    if (!accepting) throw Object.assign(new Error("媒体图片服务正在停止"), { code: "MEDIA_IMAGE_STOPPED", statusCode: 503 });
    if (mediaBlobCache.has(key)) {
      const cached = mediaBlobCache.get(key);
      mediaBlobCache.delete(key);
      mediaBlobCache.set(key, cached);
      return cached.row;
    }
    if (mediaBlobLoads.has(key)) return mediaBlobLoads.get(key);
    const generation = mediaGeneration;
    const pending = Promise.resolve().then(loader).then((row) => {
      if (accepting && generation === mediaGeneration) rememberMediaBlobRow(key, row);
      return row;
    }).finally(() => {
      if (mediaBlobLoads.get(key) === pending) mediaBlobLoads.delete(key);
    });
    mediaBlobLoads.set(key, pending);
    return pending;
  }

  function rememberMediaBlobRow(key, row) {
    if (!accepting) return;
    const bytes = mediaBlobRowBytes(row,key);
    if (!bytes || bytes > cacheByteLimit || !cacheEntryLimit) return;
    const previous = mediaBlobCache.get(key);
    if (previous) mediaBlobCacheBytes -= previous.bytes;
    mediaBlobCache.delete(key);
    mediaBlobCache.set(key, { bytes, row });
    mediaBlobCacheBytes += bytes;
    while (mediaBlobCacheBytes > cacheByteLimit || mediaBlobCache.size > cacheEntryLimit) {
      const oldestKey = mediaBlobCache.keys().next().value;
      const oldest = mediaBlobCache.get(oldestKey);
      mediaBlobCache.delete(oldestKey);
      mediaBlobCacheBytes -= oldest?.bytes || 0;
    }
  }

  function forgetMediaBlobRow(key) {
    const previous = mediaBlobCache.get(key);
    if (!previous) return;
    mediaBlobCache.delete(key);
    mediaBlobCacheBytes -= previous.bytes || 0;
  }

  function mediaBlobRowBytes(row,key) {
    const blob = row?.image_blob || row?.cover_blob;
    if (!Number(blob?.byteLength || blob?.length || 0)) return 0;
    let bytes = MEDIA_BLOB_CACHE_ENTRY_BYTES + String(key).length * 2;
    const backingStores = new Set();
    for (const [name,value] of Object.entries(row)) {
      bytes += name.length * 2 + 16;
      if (typeof value === "string") bytes += value.length * 2;
      else if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
        const backing = ArrayBuffer.isView(value) ? value.buffer : value;
        if (!backingStores.has(backing)) { backingStores.add(backing); bytes += backing.byteLength; }
      } else if (value && typeof value === "object") {
        // Cache DTOs contain scalar metadata and BLOBs. Unknown compound
        // metadata is served directly rather than retained with unknown cost.
        return Infinity;
      }
    }
    return bytes;
  }

  function localImageMime(file) {
    return mimeTypes[file?.ext] || "application/octet-stream";
  }

  function localImageSourceMtime(file) {
    if (file?.cacheMtime) return String(file.cacheMtime);
    const value = String(file?.modifiedAt || "").trim();
    if (!value) return "";
    // Core scans retain microseconds while Node filesystem dates expose rounded
    // milliseconds. Round the stored fraction before comparing cache keys.
    const precise = value.match(/^(.*T\d{2}:\d{2}:\d{2})\.(\d{4,})(Z|[+-]\d{2}:?\d{2})$/i);
    const parsed = precise
      ? Date.parse(`${precise[1]}${precise[3]}`) + Math.round(Number(`0.${precise[2]}`) * 1000)
      : Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
  }

  function localImageSourceKey(file) {
    return JSON.stringify([
      String(file?.id || ""),
      String(file?.path || ""),
      Number(file?.size || 0),
      localImageSourceMtime(file)
    ]);
  }

  function observeLocalImageSource(file) {
    return localImageReader.observe(file);
  }

  function withLocalCacheDb(database, callback) {
    // This cache is optional. A lock must never make the main event loop wait;
    // retain the application's original policy for every other database use.
    if (typeof database.exec !== "function") return callback(database);
    const previous = Number(database.prepare("PRAGMA busy_timeout").get().timeout);
    database.exec("PRAGMA busy_timeout = 0");
    try { return callback(database); }
    finally { database.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(previous || 0))}`); }
  }

  function localImageRowStamp(database, file) {
    const row = withLocalCacheDb(database, db => db.prepare(`SELECT file_path, source_size, source_mtime, status, byte_length, updated_at, error, cached_at, content_type, relative_path FROM fanhao_images.local_image_cache WHERE file_id = ?`).get(file.id));
    return row ? JSON.stringify([row.file_path, row.source_size, row.source_mtime, row.status, row.byte_length, row.updated_at, row.error, row.cached_at, row.content_type, row.relative_path]) : "missing";
  }

  function captureLocalImageState(file) {
    let database;
    try { database = getCoreDb(); return { db: database, stamp: localImageRowStamp(database, file), valid: true }; }
    catch { return { db: database, valid: false }; }
  }

  function localImageStateCurrent(file, context) {
    if (!context.valid) return false;
    try {
      if (file.isCurrentSource && !file.isCurrentSource()) return false;
      if (!file.isCurrentSource && resolveCurrentLocalImageSource && localImageSourceKey(resolveCurrentLocalImageSource(file)) !== localImageSourceKey(file)) return false;
      return getCoreDb() === context.db && localImageRowStamp(context.db, file) === context.stamp;
    } catch { return false; }
  }

  function localImageCacheRow(file) {
    if (!localImageReader.isAccepting()) return null;
    observeLocalImageSource(file);
    try {
      return (
        withLocalCacheDb(getCoreDb(), database => database
          .prepare(
            `
            SELECT *
            FROM fanhao_images.local_image_cache
            WHERE file_id = ?
              AND file_path = ?
              AND image_blob IS NOT NULL
              AND length(image_blob) > 0
              AND source_size = ?
              AND source_mtime = ?
            `
          )
          .get(file.id, file.path || "", Number(file.size || 0), localImageSourceMtime(file))) || null
      );
    } catch (error) {
      warn("[local-image-cache]", error.message || error);
      return null;
    }
  }

  function localImageCacheReady(file) {
    if (!localImageReader.isAccepting()) return false;
    observeLocalImageSource(file);
    try {
      return Boolean(
        withLocalCacheDb(getCoreDb(), database => database
          .prepare(
            `
            SELECT 1 AS ready
            FROM fanhao_images.local_image_cache
            WHERE file_id = ?
              AND file_path = ?
              AND image_blob IS NOT NULL
              AND length(image_blob) > 0
              AND source_size = ?
              AND source_mtime = ?
            LIMIT 1
            `
          )
          .get(file.id, file.path || "", Number(file.size || 0), localImageSourceMtime(file)))
      );
    } catch (error) {
      warn("[local-image-cache]", error.message || error);
      return false;
    }
  }

  function serveLocalImageCacheRow(res, row) {
    return serveBlobRow(res, row, {
      mimeField: "content_type",
      defaultMime: "application/octet-stream",
      cacheControl: row?.cache_control
    });
  }

  function upsertLocalImageCache(file, stat, buffer, database = getCoreDb()) {
    const now = new Date().toISOString();
    const sourceMtime = file.cacheMtime || stat?.mtime?.toISOString() || localImageSourceMtime(file);
    const sourceSize = Number(stat?.size ?? file.size ?? buffer.length) || 0;
    const contentType = localImageMime(file);
    withLocalCacheDb(database, db => db
      .prepare(
        `
        INSERT INTO fanhao_images.local_image_cache (
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
      ));
    return {
      content_type: contentType,
      image_blob: buffer,
      byte_length: buffer.length
    };
  }

  function upsertLocalImageCacheError(file, error, database = getCoreDb()) {
    try {
      const now = new Date().toISOString();
      withLocalCacheDb(database, db => db
        .prepare(
          `
          INSERT INTO fanhao_images.local_image_cache (
            file_id, file_path, relative_path, content_type, image_blob, byte_length,
            source_size, source_mtime, status, error, cached_at, updated_at
          )
          VALUES (?, ?, ?, ?, NULL, 0, ?, ?, 'error', ?, NULL, ?)
          ON CONFLICT(file_id) DO UPDATE SET
            file_path = excluded.file_path,
            relative_path = excluded.relative_path,
            image_blob = CASE WHEN local_image_cache.file_path = excluded.file_path THEN local_image_cache.image_blob ELSE NULL END,
            byte_length = CASE WHEN local_image_cache.file_path = excluded.file_path THEN local_image_cache.byte_length ELSE 0 END,
            cached_at = CASE WHEN local_image_cache.file_path = excluded.file_path THEN local_image_cache.cached_at ELSE NULL END,
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
          localImageSourceMtime(file),
          String(error?.message || error || "local image cache failed").slice(0, 1000),
          now
        ));
    } catch (cacheError) {
      warn("[local-image-cache]", cacheError.message || cacheError);
    }
  }

  async function servePreparedImage(res, file) {
    if (res.destroyed || res.writableEnded) return;
    if (!localImageReader.isAccepting()) { sendText(res, 503, "Local image reader is stopping"); return; }
    if (serveLocalImageCacheRow(res, localImageCacheRow(file))) {
      return;
    }

    const result = await waitForLocalImage(localImageLoad(file));
    if (res.destroyed || res.writableEnded) return;
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
      else sendText(res, result.error.statusCode || 500, "Local image read failed");
      return;
    }
    if (!serveLocalImageCacheRow(res, result.row)) {
      sendText(res, 500, "Local image read failed");
    }
  }

  async function serveImageAsync(res, file, options = {}) {
    if (options.signal?.aborted || res.destroyed || res.writableEnded) return;
    if (!localImageReader.isAccepting()) { sendText(res, 503, "Local image reader is stopping"); return; }
    const sourceCurrent = () => {
      if (!options.requireCurrentSource) return true;
      try { return typeof file?.isCurrentSource === "function" && file.isCurrentSource(); }
      catch { return false; }
    };
    if (!sourceCurrent()) { notFound(res); return; }
    if (serveLocalImageCacheRow(res, localImageCacheRow(file))) return;
    try {
      // Direct covers and short-video images retain their complete image/error
      // response, without the prepared-image consumer's short-wait contract.
      const row = await localImageLoad(file, options);
      if (options.signal?.aborted || res.destroyed || res.writableEnded) return;
      if (!sourceCurrent()) { notFound(res); return; }
      if (!serveLocalImageCacheRow(res, row)) sendText(res, 500, "Local image read failed");
    } catch (error) {
      if (options.signal?.aborted || res.destroyed || res.writableEnded) return;
      if (!sourceCurrent()) { notFound(res); return; }
      if (error.code === "ENOENT" || error.statusCode === 404) notFound(res);
      else sendText(res, error.statusCode || 500, "Local image read failed");
    }
  }

  function localImageLoad(file, options) {
    return localImageReader.load(file, options);
  }

  async function prewarmLocalImages(files = [], options = {}) {
    if (!localImageReader.isAccepting()) return { requested: 0, cached: 0, warmed: 0, failed: 0 };
    const limit = Math.max(0, Math.floor(Number(options.limit ?? files.length) || 0));
    if (!limit) return { requested: 0, cached: 0, warmed: 0, failed: 0 };
    const candidates = [];
    const seen = new Set();
    for (const file of Array.isArray(files) ? files : []) {
      const key = localImageSourceKey(file);
      if (!file?.id || !file?.path || seen.has(key)) continue;
      seen.add(key);
      candidates.push(file);
      if (candidates.length >= limit) break;
    }

    let cached = 0;
    let warmed = 0;
    let failed = 0;
    for (const file of candidates) {
      if (!localImageReader.isAccepting()) break;
      if (localImageCacheReady(file)) {
        cached += 1;
        continue;
      }
      try {
        // Keep background warming serial so normal page requests retain the
        // remaining local-image and libuv filesystem capacity.
        await localImageLoad(file);
        warmed += 1;
      } catch {
        failed += 1;
      }
    }
    return { requested: candidates.length, cached, warmed, failed };
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
    if (!raw || raw.length > MAX_REMOTE_IMAGE_ENVELOPE_LENGTH) return "";

    try {
      if (raw.startsWith("/media/remote-image")) {
        const parsed = new URL(raw, "http://localhost");
        const target = publicRemoteUrl(parsed.searchParams.get("url"));
        const parsedTarget = target && new URL(target);
        return target && target.length <= MAX_REMOTE_IMAGE_URL_LENGTH && parsedTarget.href.length <= MAX_REMOTE_IMAGE_URL_LENGTH && isAllowedRemoteImageUrl(parsedTarget) ? target : "";
      }

      const target = publicRemoteUrl(raw);
      const parsedTarget = target && new URL(target);
      return target && target.length <= MAX_REMOTE_IMAGE_URL_LENGTH && parsedTarget.href.length <= MAX_REMOTE_IMAGE_URL_LENGTH && isAllowedRemoteImageUrl(parsedTarget) ? target : "";
    } catch {
      return "";
    }
  }

  function prewarmRemoteImagesForWorks(works, limit = 1000, options = {}) {
    if (!accepting) return 0;
    const queueLimit = Math.max(1, Math.min(512, Number(options.queueLimit) || limit));
    if (options.replaceQueued) {
      remoteImageWarmGeneration += 1;
      remoteImageWarmer.replaceQueued();
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
        ...(!work.coverId
          ? [work.cachedCover?.coverUrl, work.remoteCoverUrl, work.infoSummary?.imageUrl, work.infoMetadata?.imageUrl]
          : []),
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
    if (!accepting || generation !== remoteImageWarmGeneration) return;
    for (const remoteUrl of remoteUrls) {
      const pending = remoteImageWarmer.diagnostics();
      if (pending.queued + pending.active >= queueLimit) break;
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

  async function downloadRemoteImage(remoteUrl, context) {
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(15000)]);
    const response = await fetchRemoteImage(remoteUrl, {
      signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        Referer: "https://javdb.com/"
      }
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const error = new Error(`远程图片请求失败：${response.status}`);
      error.statusCode = 502;
      throw error;
    }

    const limit = Number.isFinite(Number(maxRemoteImageBytes)) && Number(maxRemoteImageBytes) > 0
      ? Math.trunc(Number(maxRemoteImageBytes)) : 20 * 1024 * 1024;
    const buffer = await readRemoteImageBody(response, limit, signal);

    return {
      buffer,
      contentType: normalizeRemoteImageMime(response.headers.get("content-type"), remoteUrl)
    };
  }

  function enqueueRemoteImageWarm(remoteUrl) {
    return accepting && remoteImageWarmer.enqueue(remoteUrl);
  }

  async function warmRemoteImage(remoteUrl, context) {
    if (!context.current()) return;
    const downloaded = await downloadRemoteImage(remoteUrl, context);
    if (!context.current()) return;
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
    if (req.aborted || res.destroyed || res.writableEnded) return;
    const requestedUrl = url.searchParams.get("url");
    if (String(requestedUrl || "").length > MAX_REMOTE_IMAGE_URL_LENGTH) {
      sendText(res,414,"Remote image URL is too long"); return;
    }
    const remoteUrl = publicRemoteUrl(requestedUrl);
    if (!remoteUrl) {
      sendText(res, 400, "Missing remote image URL");
      return;
    }

    const parsed = new URL(remoteUrl);
    if (remoteUrl.length > MAX_REMOTE_IMAGE_URL_LENGTH || parsed.href.length > MAX_REMOTE_IMAGE_URL_LENGTH) {
      sendText(res,414,"Remote image URL is too long"); return;
    }
    if (!isAllowedRemoteImageUrl(parsed)) {
      sendText(res, 403, "Remote image host is not allowed");
      return;
    }

    const cachedRow = await cachedMediaBlobRow(`remote:${remoteUrl}`, () => blobStore.remoteImage(remoteUrl));
    if (res.destroyed || res.writableEnded || req.aborted) return;
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

  function beginStop() {
    accepting = false;
    mediaGeneration += 1;
    remoteImageWarmGeneration += 1;
    mediaBlobLoads.clear();
    mediaBlobCache.clear();
    mediaBlobCacheBytes = 0;
    localImageReader.beginStop();
    remoteImageWarmer.beginStop();
  }

  async function stop() {
    beginStop();
    const stopped = await Promise.allSettled([localImageReader.stop(), remoteImageWarmer.stop()]);
    const failed = stopped.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  async function start() {
    const generation = mediaGeneration;
    const started = await Promise.allSettled([localImageReader.start(), remoteImageWarmer.start()]);
    const failed = started.find((result) => result.status === "rejected");
    if (failed || generation !== mediaGeneration) {
      beginStop();
      throw failed?.reason || Object.assign(new Error("媒体图片服务启动已取消"), { statusCode: 503 });
    }
    accepting = true;
  }

  return {
    start, beginStop, stop,
    remoteImageWarmDiagnostics: remoteImageWarmer.diagnostics,
    localImageReaderDiagnostics: localImageReader.diagnostics,
    localImageMime,
    localImageCacheRow,
    prewarmRemoteImagesForWorks,
    prewarmLocalImages,
    proxiedRemoteImageUrlArray,
    remoteImageTargetUrl,
    serveActorAvatar,
    serveCachedRemoteImage,
    serveCoreImage,
    serveImageAsync,
    servePreparedImage,
    serveLocalImageCacheRow,
    serveWorkCover
  };
}

function createInlineMediaBlobStore({ coreImageRow, corePersonAvatarRow, getCoreDb, workCoverRow }) {
  return {
    async actorAvatar(personId, version = "") {
      if (version) {
        const db = getCoreDb();
        if (!hasSqliteTables(db, "main", [
          "actor_profile_publications", "actor_profile_image_revocations",
          "cross_store_intents", "cross_store_operation_state", "cross_store_main_receipts"
        ]) || !hasSqliteTables(db, "fanhao_images", ["actor_profile_image_staging", "cross_store_receipts"])) return null;
        return db.prepare(`
          SELECT stage.image_blob, stage.mime
          FROM cross_store_intents intent
          JOIN cross_store_operation_state state
            ON state.op_id = intent.op_id AND state.status = 'completed'
          JOIN cross_store_main_receipts receipt
            ON receipt.op_id = intent.op_id
           AND receipt.step = 'visibility_switch'
           AND receipt.intent_sha256 = intent.intent_sha256
          JOIN fanhao_images.cross_store_receipts image_receipt
            ON image_receipt.op_id = intent.op_id
           AND image_receipt.step = 'image_stage'
           AND image_receipt.kind = intent.kind
           AND image_receipt.aggregate_key = intent.aggregate_key
           AND image_receipt.intent_sha256 = intent.intent_sha256
          JOIN fanhao_images.actor_profile_image_staging stage
            ON stage.operation_id = intent.op_id
           AND stage.intent_sha256 = receipt.intent_sha256
          LEFT JOIN actor_profile_image_revocations revocation
            ON revocation.operation_id = intent.op_id
           AND revocation.person_id = stage.person_id
           AND revocation.intent_sha256 = stage.intent_sha256
          WHERE intent.kind = 'actor_profile_upsert'
            AND stage.person_id = ?
            AND stage.operation_id = ?
            AND revocation.operation_id IS NULL
        `).get(Number(personId), String(version)) || null;
      }
      return corePersonAvatarRow(personId);
    },
    async actorAvatarVersion(personId, version) {
      const db = getCoreDb();
      if (!hasSqliteTables(db, "main", [
        "actor_profile_publications", "actor_profile_image_revocations",
        "cross_store_intents", "cross_store_operation_state", "cross_store_main_receipts"
      ]) || !hasSqliteTables(db, "fanhao_images", ["actor_profile_image_staging", "cross_store_receipts"])) {
        return { status: "missing", row: null };
      }
      const revoked = db.prepare(`
        SELECT 1 AS revoked
        FROM actor_profile_image_revocations
        WHERE person_id = ? AND operation_id = ?
      `).get(Number(personId), String(version));
      if (revoked) return { status: "revoked", row: null };
      const row = await this.actorAvatar(personId, version);
      return { status: row ? "available" : "missing", row };
    },
    async cachedRemoteUrls(remoteUrls) {
      const cached = [];
      for (let offset = 0; offset < remoteUrls.length; offset += REMOTE_IMAGE_LOOKUP_BATCH_SIZE) {
        const batch = remoteUrls.slice(offset, offset + REMOTE_IMAGE_LOOKUP_BATCH_SIZE);
        if (!batch.length) continue;
        const placeholders = batch.map(() => "?").join(", ");
        const rows = getCoreDb()
          .prepare(`SELECT url FROM fanhao_images.remote_image_cache WHERE url IN (${placeholders})`)
          .all(...batch);
        for (const row of rows) cached.push(row.url);
      }
      return cached;
    },
    async coreImage(imageId) {
      return coreImageRow(imageId);
    },
    async remoteImage(remoteUrl) {
      return getCoreDb().prepare("SELECT content_type, image_blob, byte_length, updated_at FROM fanhao_images.remote_image_cache WHERE url = ?").get(remoteUrl) || null;
    },
    async upsertRemote(record) {
      getCoreDb()
        .prepare(`
          INSERT INTO fanhao_images.remote_image_cache (
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
