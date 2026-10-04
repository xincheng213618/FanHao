import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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
  const listCache = new Map(), children = new Set();
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
  function rowStamp(row) { return row ? JSON.stringify(row) : "missing"; }
  function indexAuthority(source) {
    let db;
    try { db = options.getImageGalleryDb(); return { db, stamp: rowStamp(indexRow(db, source)), valid: true }; }
    catch { return { db, valid: false }; }
  }
  function authorityCurrent(source, authority, context) {
    if (!context.isCurrent() || !authority.valid) return false;
    try { return options.getImageGalleryDb() === authority.db && rowStamp(indexRow(authority.db, source)) === authority.stamp; }
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
        authority.stamp = rowStamp(indexRow(authority.db, source));
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
      const key = source.archiveIdentity, authority = indexAuthority(source), cached = listCache.get(key);
      let payload;
      if (cached && Date.now() - cached.createdAt < (options.listCacheTtlMs || 60_000) && authorityCurrent(source, cached.authority, context)) payload = cached.payload;
      if (!payload && authority.valid) {
        const row = indexRow(authority.db, source);
        if (row?.archive_identity === key && Number(row.indexer_version) === ARCHIVE_IMAGE_INDEXER_VERSION) {
          try { const images = JSON.parse(row.images_json || "[]"); if (Array.isArray(images)) payload = { images, imageCount: Number(row.image_count || images.length) }; } catch {}
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
  function cacheFile(sourceType, source, memberPath) {
    const archiveHash = crypto.createHash("sha1").update(source.archiveIdentity).digest("hex").slice(0, 24);
    const memberHash = crypto.createHash("sha1").update(memberPath).digest("hex").slice(0, 24);
    const ext = options.archiveImageExts.has(options.normalizeExt(memberPath)) ? options.normalizeExt(memberPath) : ".img";
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
  async function extract(archivePath, memberPath, cachePath, context, expected) {
    const source = expected || await signature(archivePath);
    if (!source) throw Object.assign(new Error("Archive does not exist"), { code: "ENOENT", statusCode: 404 });
    if (!context.isCurrent()) throw archiveStoppedError();
    await safeTarget(cachePath,context);
    const staging = `${cachePath}.${crypto.randomUUID()}.tmp`;
    try {
      await helper(["extract", source.archivePath, memberPath, staging], context);
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
  function clearListCache() { listCache.clear(); listCacheBytes = 0; pool.invalidate(); }
  return { archiveSignature, archiveImagesPayload, clearListCache, compressImageFileToJpeg, extractArchiveMemberToCache,
    listArchiveImages, serveArchiveMemberImage, start: pool.start, beginStop: pool.beginStop, stop: pool.stop,
    diagnostics: () => ({ ...pool.diagnostics(), children: children.size, listEntries: listCache.size, listCacheBytes }) };
}

function changedError() { return Object.assign(new Error("Archive source changed; retry the request"), { code: "ARCHIVE_READER_SOURCE_CHANGED", statusCode: 409 }); }
function unsafeTargetError() { return Object.assign(new Error("Archive cache path contains an unsafe link"), { code: "ARCHIVE_READER_UNSAFE_TARGET", statusCode: 403 }); }
