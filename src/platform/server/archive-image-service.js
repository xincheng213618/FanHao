import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { types } from "node:util";
import { extractCoverFrameAsync } from "../../../lib/cover-frame.js";
import { createArchiveTaskPool, runArchiveChild, archiveStoppedError } from "./archive-task-pool.js";

export const ARCHIVE_IMAGE_INDEXER_VERSION = 3;

export function archiveDiskSignature(archivePath, stat) {
  if (!stat?.isFile?.()) return null;
  const archiveMtimeMs = Number(stat.mtimeMs ?? stat.mtime?.getTime?.());
  const archiveSize = Number(stat.size || 0), resolved = path.resolve(archivePath);
  return { archivePath: resolved, archiveSize, archiveMtimeMs,
    archiveIdentity: JSON.stringify([resolved, archiveSize, archiveMtimeMs, String(stat.dev ?? ""), String(stat.ino ?? "")]) };
}

export function createArchiveImageService(options) {
  const pool = createArchiveTaskPool({ concurrency: options.concurrency, capacity: options.capacity, stopTimeoutMs: options.stopTimeoutMs });
  const videoPool = createArchiveTaskPool({ concurrency: 2, capacity: 32, stopTimeoutMs: options.stopTimeoutMs });
  const listCache = new Map(), children = new Set();
  const videoLists = new Map();
  const statFile = options.statFile || (value => fs.promises.stat(value));
  let listCacheBytes = 0;
  const warn = options.warn || console.warn;

  async function signature(archivePath) {
    try { return archiveDiskSignature(archivePath, await statFile(path.resolve(archivePath))); }
    catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return null; throw error; }
  }
  function archiveSignature(archivePath, request = {}) {
    return pool.run(`signature:${path.resolve(archivePath)}`, () => signature(archivePath), request);
  }
  async function verifySource(expected, context) {
    const latest = await signature(expected.archivePath);
    if (!context.isCurrent()) throw archiveStoppedError();
    if (latest?.archiveIdentity !== expected.archiveIdentity) throw changedError();
  }
  function databaseOperation(database, operation) {
    if (typeof database.exec !== "function") return operation(database);
    const previous = Number(database.prepare("PRAGMA busy_timeout").get().timeout);
    database.exec("PRAGMA busy_timeout = 0");
    try { return operation(database); }
    finally { database.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(previous || 0))}`); }
  }
  function indexRow(database, source) {
    return databaseOperation(database, db => db.prepare("SELECT * FROM photo_set_image_indexes WHERE archive_path = ?").get(source.archivePath)) || null;
  }
  function nativeIndexRowDescriptors(row) {
    if (row && typeof row === "object" && !types.isProxy(row) && !types.isBoxedPrimitive(row)
      && Object.getPrototypeOf(row) === null && !Object.hasOwn(row, "toJSON")) {
      const descriptors = Object.getOwnPropertyDescriptors(row);
      const images = descriptors.images_json;
      if (images?.enumerable && Reflect.ownKeys(descriptors).every(key => {
        const descriptor = descriptors[key];
        const valueType = typeof descriptor.value;
        return typeof key === "string" && descriptor.enumerable && "value" in descriptor
          && (descriptor.value === null || valueType === "string" || valueType === "number");
      })) return descriptors;
    }
    return null;
  }
  function rowStamp(row) {
    // Native rows contain plain data. Keep the original metadata key order,
    // but compare the already immutable JSON text without escaping it again.
    const native = nativeIndexRowDescriptors(row);
    if (native && typeof native.images_json.value === "string") {
      return { metadata: JSON.stringify(Object.assign(Object.create(null), row, { images_json: null })), images: native.images_json.value };
    }
    return row ? JSON.stringify(row) : "missing";
  }
  function rowStampsMatch(left, right) {
    if (left && typeof left === "object") {
      if (right && typeof right === "object") return left.metadata === right.metadata && left.images === right.images;
      // Scalar native metadata has one actual images_json key. Restore its
      // original JSON only when a provider changes between native and old rows.
      left = left.metadata.replace('"images_json":null', () => '"images_json":' + JSON.stringify(left.images));
    } else if (right && typeof right === "object") {
      right = right.metadata.replace('"images_json":null', () => '"images_json":' + JSON.stringify(right.images));
    }
    return left === right;
  }
  function indexAuthority(source) {
    let db;
    try {
      db = options.getImageGalleryDb();
      const row = indexRow(db, source);
      const native = Boolean(nativeIndexRowDescriptors(row));
      return { db, stamp: rowStamp(row), native, valid: true };
    }
    catch { return { db, valid: false }; }
  }
  function authorityCurrent(source, authority, context) {
    if (!context.isCurrent() || !authority.valid) return false;
    try { return options.getImageGalleryDb() === authority.db && rowStampsMatch(rowStamp(indexRow(authority.db, source)), authority.stamp); }
    catch { return false; }
  }
  function remember(key, source, payload, authority, context, persist = true) {
    if (!authorityCurrent(source, authority, context)) return;
    if (persist && payload.images.length) {
      try {
        const now = new Date().toISOString();
        databaseOperation(authority.db, db => db.prepare(`INSERT INTO photo_set_image_indexes
          (archive_path,archive_size,archive_mtime_ms,image_count,images_json,indexer_version,indexed_at,updated_at,archive_identity)
          VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(archive_path) DO UPDATE SET
          archive_size=excluded.archive_size,archive_mtime_ms=excluded.archive_mtime_ms,image_count=excluded.image_count,
          images_json=excluded.images_json,indexer_version=excluded.indexer_version,indexed_at=excluded.indexed_at,
          updated_at=excluded.updated_at,archive_identity=excluded.archive_identity`)
          .run(source.archivePath, source.archiveSize, source.archiveMtimeMs, payload.imageCount, JSON.stringify(payload.images), ARCHIVE_IMAGE_INDEXER_VERSION, now, now, source.archiveIdentity));
        const row = indexRow(authority.db, source);
        const native = Boolean(nativeIndexRowDescriptors(row));
        authority.stamp = rowStamp(row);
        authority.native = native;
      } catch (error) { warn("[archive-image-index-cache]", error.message || error); return; }
    }
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    if (bytes > 16 * 1024 * 1024) return;
    const previous = listCache.get(key); listCacheBytes -= previous?.bytes || 0;
    listCache.delete(key); listCache.set(key, { payload, authority, bytes, createdAt: Date.now() }); listCacheBytes += bytes;
    while (listCache.size > 300 || listCacheBytes > 16 * 1024 * 1024) {
      const oldest = listCache.keys().next().value; listCacheBytes -= listCache.get(oldest).bytes; listCache.delete(oldest);
    }
  }
  async function helper(args, context, request = {}) {
    const result = await runArchiveChild(options.pythonPath, [options.helperPath, ...args], {
      cwd: options.projectRoot, signal: context.signal, timeoutMs: request.timeout || 120_000,
      spawnProcess: options.spawnProcess, onChild: (child, owned) => owned ? children.add(child) : children.delete(child)
    });
    if (!context.isCurrent()) throw archiveStoppedError();
    let payload;
    try { payload = JSON.parse(result.stdout.toString("utf8") || "{}"); } catch {}
    if (!payload?.ok) throw new Error(payload?.error || result.stderr || "archive helper failed");
    return payload;
  }
  function archiveImagesPayload(archivePath, request = {}) {
    return pool.run(`list:${path.resolve(archivePath)}`, async context => {
      const source = await signature(archivePath);
      if (!source) return { imageCount: 0, images: [] };
      if (!context.isCurrent()) throw archiveStoppedError();
      const key = source.archiveIdentity, cached = listCache.get(key);
      let authority = indexAuthority(source), payload;
      const sameNativeAuthority = context.isCurrent() && authority.valid && authority.native && cached?.authority.native
        && authority.db === cached.authority.db && rowStampsMatch(authority.stamp, cached.authority.stamp);
      if (cached && Date.now() - cached.createdAt < (options.listCacheTtlMs || 60_000)
        && (sameNativeAuthority || authorityCurrent(source, cached.authority, context))) {
        payload = cached.payload;
        // A fallback may have validated a different row than the initial read.
        // An initially failed read still prevents admission, as before.
        if (authority.valid) authority = cached.authority;
      }
      if (!payload && authority.valid) {
        const row = indexRow(authority.db, source);
        const native = Boolean(nativeIndexRowDescriptors(row));
        if (row?.archive_identity === key && Number(row.indexer_version) === ARCHIVE_IMAGE_INDEXER_VERSION) {
          try {
            const images = JSON.parse(row.images_json || "[]");
            if (Array.isArray(images)) {
              payload = { images, imageCount: Number(row.image_count || images.length) };
              // Bind a parsed native list to the row that supplied its images.
              if (native) authority = { db: authority.db, stamp: rowStamp(row), native: true, valid: true };
            }
          } catch {}
        }
      }
      const persisted = Boolean(payload);
      if (!payload) {
        const result = await helper(["list", source.archivePath], context, request);
        const images = Array.isArray(result.images) ? result.images : [];
        payload = { images, imageCount: Number(result.imageCount || images.length) };
      }
      await verifySource(source, context);
      remember(key, source, payload, authority, context, !persisted);
      return payload;
    }, request).then(payload => {
      const limit = Math.max(0, Math.floor(Number(request.limit) || 0));
      return { imageCount: payload.imageCount, images: limit > 0 ? payload.images.slice(0, limit) : payload.images };
    });
  }
  async function listArchiveImages(archivePath, request = {}) { return (await archiveImagesPayload(archivePath, request)).images; }

  function archiveVideosPayload(archivePath, request = {}) {
    return pool.run(`list-videos:${path.resolve(archivePath)}`, async context => {
      const source = await signature(archivePath);
      if (!source) return { videos: [] };
      if (!context.isCurrent()) throw archiveStoppedError();
      const cached = videoLists.get(source.archiveIdentity);
      if (cached) {
        videoLists.delete(source.archiveIdentity);
        videoLists.set(source.archiveIdentity, cached);
        return cached;
      }
      const result = await helper(["list-videos", source.archivePath], context, request);
      const videos = [];
      const seen = new Set();
      for (const entry of result.videos || []) {
        const member = String(entry.path || ""), ext = options.normalizeExt(member);
        if (!member || !options.archiveVideoExts?.has(ext) || seen.has(member)) continue;
        seen.add(member);
        const id = crypto.createHash("sha256").update(JSON.stringify([source.archiveIdentity, member])).digest("hex").slice(0, 32);
        videos.push({ id, path: member, name: entry.name || path.basename(member), size: Number(entry.bytes) || 0, ext });
      }
      await verifySource(source, context);
      const payload = { archiveIdentity: source.archiveIdentity, videos };
      videoLists.set(source.archiveIdentity, payload);
      if (videoLists.size > 64) videoLists.delete(videoLists.keys().next().value);
      return payload;
    }, request);
  }

  function cacheFile(sourceType, source, memberPath, videoExt = "") {
    const archiveHash = crypto.createHash("sha1").update(source.archiveIdentity).digest("hex").slice(0, 24);
    const memberHash = crypto.createHash("sha1").update(memberPath).digest("hex").slice(0, 24);
    const ext = videoExt || (options.archiveImageExts.has(options.normalizeExt(memberPath)) ? options.normalizeExt(memberPath) : ".img");
    return path.join(options.imageReaderCacheService.rootDir, String(sourceType || "common").replace(/[^a-zA-Z0-9_-]/g, "_"), archiveHash, `${memberHash}${ext}`);
  }
  async function safeTarget(target, context, { create = true, checkCurrent = true } = {}) {
    const configured = path.resolve(options.imageReaderCacheService.rootDir), resolved = path.resolve(target);
    const relative = path.relative(configured,resolved);
    const inside = relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
    const owner = inside ? configured : path.dirname(resolved);
    if (create) await fs.promises.mkdir(owner,{ recursive:true });
    const rootStat = await fs.promises.lstat(owner);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw unsafeTargetError();
    const canonicalRoot = await fs.promises.realpath(owner);
    let parent = owner;
    for (const part of path.relative(owner,path.dirname(resolved)).split(path.sep).filter(Boolean)) {
      parent = path.join(parent,part);
      if (create) { try { await fs.promises.mkdir(parent); } catch(error) { if(error.code !== "EEXIST") throw error; } }
      const stat = await fs.promises.lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafeTargetError();
      const actual = await fs.promises.realpath(parent), expected = path.join(canonicalRoot,path.relative(owner,parent));
      if (path.relative(expected,actual)) throw unsafeTargetError();
    }
    try { if ((await fs.promises.lstat(resolved)).isSymbolicLink()) throw unsafeTargetError(); }
    catch(error) { if(error.code !== "ENOENT") throw error; }
    if (checkCurrent && !context.isCurrent()) throw archiveStoppedError();
  }
  async function extract(archivePath, memberPath, cachePath, context, expected, videoByteLimit = 0) {
    const source = expected || await signature(archivePath);
    if (!source) throw Object.assign(new Error("Archive does not exist"), { code: "ENOENT", statusCode: 404 });
    if (!context.isCurrent()) throw archiveStoppedError();
    await safeTarget(cachePath,context);
    const staging = `${cachePath}.${crypto.randomUUID()}.tmp`;
    try {
      const args = videoByteLimit ? ["extract-video", source.archivePath, memberPath, staging, String(videoByteLimit)]
        : ["extract", source.archivePath, memberPath, staging];
      await helper(args, context);
      await verifySource(source, context);
      await safeTarget(cachePath,context);
      fs.renameSync(staging, cachePath);
      return source;
    } finally {
      try {
        await safeTarget(staging,context,{create:false,checkCurrent:false});
        await fs.promises.unlink(staging);
      } catch(error) { if (error.code !== "ENOENT") warn("[archive-image-staging]", error.message); }
    }
  }
  function extractArchiveMemberToCache(archivePath, memberPath, cachePath, request = {}) {
    return pool.run(`extract:${path.resolve(archivePath)}:${memberPath}:${path.resolve(cachePath)}`, context => extract(archivePath, memberPath, cachePath, context), request);
  }
  function compressImageFileToJpeg(filePath, request = {}) {
    return pool.run(`compress:${path.resolve(filePath)}:${options.coverBoxSize}`, async context => {
      const source = await signature(filePath);
      if (!source) throw Object.assign(new Error("Image does not exist"), { statusCode: 404 });
      const result = await runArchiveChild(options.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-i", filePath,
        "-frames:v", "1", "-vf", `scale=${options.coverBoxSize}:${options.coverBoxSize}:force_original_aspect_ratio=decrease`,
        "-q:v", "5", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"], {
        signal: context.signal, timeoutMs: 30_000, maxBytes: options.coverMaxBytes,
        spawnProcess: options.spawnProcess, onChild: (child, owned) => owned ? children.add(child) : children.delete(child)
      });
      await verifySource(source, context);
      const buffer = result.stdout;
      if (!buffer.length || buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error("FFmpeg 没有生成有效的 JPEG 封面");
      return buffer;
    }, request);
  }
  async function serveArchiveMemberImage(res, request) {
    if (res.destroyed || res.writableEnded) return;
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.once?.("close", disconnect);
    try {
      const prepared = await pool.run(`serve:${path.resolve(request.archivePath)}:${request.sourceType || "common"}:${request.memberPath}:${request.fallbackPath || ""}:${request.contentType || ""}`, async context => {
        const source = await signature(request.archivePath), member = String(request.memberPath || "").replace(/[\\/]+/g, "/");
        if (!context.isCurrent()) throw archiveStoppedError();
        if (!source || !member || !options.archiveImageExts.has(options.normalizeExt(member))) {
          return request.fallbackPath ? { filePath: request.fallbackPath, contentType: request.contentType, current: context.isCurrent } : null;
        }
        const target = cacheFile(request.sourceType, source, member);
        await safeTarget(target,context);
        let exists = false;
        try { exists = (await statFile(target)).isFile(); } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (!exists) await extract(source.archivePath, member, target, context, source);
        await options.imageReaderCacheService.touch(target);
        await verifySource(source, context);
        await safeTarget(target,context);
        options.imageReaderCacheService.scheduleCleanup();
        return {
          filePath: target,
          contentType: request.contentType || options.mimeTypes[options.normalizeExt(member)] || "",
          current: context.isCurrent,
          validate: async streamContext => {
            await verifySource(source, streamContext);
            await safeTarget(target, streamContext, { create: false });
          }
        };
      }, { signal: controller.signal });
      if (res.destroyed || res.writableEnded || controller.signal.aborted) return;
      if (prepared && !prepared.current()) throw archiveStoppedError();
      if (!prepared) {
        options.notFound(res);
        return;
      }
      // A response owns its stream even when preparation was shared with
      // another reader. Retain that owner until the descriptor has closed.
      await pool.run(`stream:${crypto.randomUUID()}`, async context => {
        const isCurrent = () => prepared.current() && context.isCurrent();
        if (!isCurrent()) throw archiveStoppedError();
        await options.serveInlineFile(res, prepared.filePath, prepared.contentType, {
          signal: context.signal,
          isCurrent,
          validateFile: async () => {
            if (!isCurrent()) throw archiveStoppedError();
            await prepared.validate?.({ isCurrent });
          }
        });
      }, { signal: controller.signal, waitForCloseOnAbort: true });
    } catch (error) {
      if (!res.destroyed && !res.writableEnded && !controller.signal.aborted) {
        warn("[image-reader-extract]", error.message || error); options.sendText(res, error.statusCode || 500, error.message || "图片缓存抽取失败");
      }
    } finally { res.removeListener?.("close", disconnect); }
  }

  function videoByteLimit(video) {
    const limit = options.archiveVideoMaxBytes();
    if (!Number.isSafeInteger(limit) || limit < 1 || video.size > limit) {
      throw Object.assign(new Error("视频超出读取缓存容量"), { statusCode: 413 });
    }
    return limit;
  }

  function prepareArchiveMemberVideo({ archivePath, archiveIdentity, video, signal }) {
    return videoPool.run(`video:${video.id}`, async context => {
      const source = await signature(archivePath);
      if (!source || source.archiveIdentity !== archiveIdentity) throw changedError();
      const target = cacheFile("photo-video", source, video.path, video.ext);
      await safeTarget(target, context);
      let exists = false;
      try { exists = (await statFile(target)).isFile(); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!exists) {
        await extract(source.archivePath, video.path, target, context, source, videoByteLimit(video));
      }
      await options.imageReaderCacheService.touch(target);
      options.imageReaderCacheService.scheduleCleanup();
      return { source, target, current: context.isCurrent };
    }, { signal });
  }

  function extractArchiveVideoCover({ archivePath, archiveIdentity, video, signal }) {
    return videoPool.run(`video-cover:${video.id}`, async context => {
      const source = await signature(archivePath);
      if (!source || source.archiveIdentity !== archiveIdentity) throw changedError();
      const limit = videoByteLimit(video);
      // FFmpeg needs a seekable input. Keep it outside playback cache inventory.
      const target = path.join(options.imageReaderCacheService.rootDir, `photo-video-cover-${crypto.randomUUID()}.tmp`);
      const frameOptions = {
        ffmpegPath: options.ffmpegPath, ffprobePath: options.ffprobePath, spawnFn: options.spawnProcess,
        signal: context.signal, boxSize: options.coverBoxSize, maxBytes: options.coverMaxBytes, quality: 5,
        inputFormat: video.ext === ".webm" ? "matroska" : "mov"
      };
      try {
        await extract(source.archivePath, video.path, target, context, source, limit);
        const sourceBytes = (await statFile(target)).size;
        let blob;
        try { blob = await extractCoverFrameAsync(target, frameOptions); }
        catch (error) {
          if (!context.isCurrent() || error.code === "COVER_TIMEOUT") throw error;
          await safeTarget(target, context, { create: false });
          blob = await extractCoverFrameAsync(target, { ...frameOptions, seekSeconds: 0 });
        }
        await verifySource(source, context);
        await safeTarget(target, context, { create: false });
        return { blob, mime: "image/jpeg", sourceBytes };
      } finally {
        try {
          await safeTarget(target, context, { create: false, checkCurrent: false });
          await fs.promises.unlink(target);
        } catch (error) {
          if (error.code !== "ENOENT") warn("[archive-video-cover-temp]", error.message);
        }
      }
    }, { signal, waitForCloseOnAbort: true });
  }

  async function serveArchiveMemberVideo(req, res, request) {
    const { video, signal } = request;
    if (signal?.aborted || res.destroyed || res.writableEnded) return;
    const prepared = await prepareArchiveMemberVideo(request);
    if (signal?.aborted || res.destroyed || res.writableEnded) return;
    if (!prepared.current()) throw archiveStoppedError();
    await safeTarget(prepared.target, { isCurrent: prepared.current }, { create: false });
    await options.serveRangedFile(req, res, {
      path: prepared.target, ext: video.ext, fullResponse: true
    }, {
      signal, isCurrent: prepared.current,
      validateFile: async () => {
        const context = { isCurrent: prepared.current };
        await verifySource(prepared.source, context);
        await safeTarget(prepared.target, context, { create: false });
      }
    });
  }

  function clearListCache() { listCache.clear(); listCacheBytes = 0; videoLists.clear(); pool.invalidate(); videoPool.invalidate(); }
  return { archiveSignature, archiveImagesPayload, archiveVideosPayload, clearListCache, compressImageFileToJpeg, extractArchiveMemberToCache, extractArchiveVideoCover,
    listArchiveImages, serveArchiveMemberImage, serveArchiveMemberVideo,
    start: () => Promise.all([pool.start(), videoPool.start()]),
    beginStop: () => { pool.beginStop(); videoPool.beginStop(); },
    stop: async () => {
      const results = await Promise.allSettled([pool.stop(), videoPool.stop()]);
      const failed = results.find(result => result.status === "rejected");
      if (failed) throw failed.reason;
    },
    diagnostics: () => ({ ...pool.diagnostics(), children: children.size, listEntries: listCache.size, listCacheBytes }) };
}

function changedError() { return Object.assign(new Error("Archive source changed; retry the request"), { code: "ARCHIVE_READER_SOURCE_CHANGED", statusCode: 409 }); }
function unsafeTargetError() { return Object.assign(new Error("Archive cache path contains an unsafe link"), { code: "ARCHIVE_READER_UNSAFE_TARGET", statusCode: 403 }); }
