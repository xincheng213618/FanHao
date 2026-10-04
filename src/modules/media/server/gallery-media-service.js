import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { extractCoverFrameAsync, probeVideoDurationAsync } from "../../../../lib/cover-frame.js";

export function createGalleryMediaService({
  coverBoxSize,
  coverGeneratorVersion,
  coverMaxBytes,
  directVideoExts,
  ffmpegPath,
  ffprobePath,
  getImageGalleryDb,
  getImageLibraryIndex,
  mediaStreamService,
  normalizeExt,
  notFound,
  playbackProgressService,
  publicGalleryMediaItem,
  safeChildPath,
  safeStat,
  statFile = fs.promises.stat,
  extractFrame = extractCoverFrameAsync,
  probeDuration = probeVideoDurationAsync,
  spawnFn,
  timeoutMs = 30000,
  probeTimeoutMs = 8000,
  generationConcurrency = 2,
  generationCapacity = 16
}) {
  const tasks = new Map();
  const queue = [];
  const running = new Set();
  const requests = new Set();
  const databases = new WeakMap();
  const concurrency = Math.max(1, Math.min(8, Number(generationConcurrency) || 2));
  const capacity = Math.max(concurrency, Math.min(64, Number(generationCapacity) || 16));
  let databaseId = 0;
  let stopping = false;
  let stopTask = null;
  let lifecycleGeneration = 0;
  let mediaLookup = null;

  function byId(id) {
    const target = String(id || "");
    if (!target) return null;
    const index = getImageLibraryIndex();
    const items = index.mediaItems || [];
    if (mediaLookup?.index !== index || mediaLookup.items !== items) {
      const byId = new Map();
      for (const item of items) if (!byId.has(item.id)) byId.set(item.id, item);
      mediaLookup = { index, items, byId };
    }
    return mediaLookup.byId.get(target) || null;
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
    const progress = playbackProgressService.getVideoProgress(item.id);
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

  function coverRow(mediaId, database = getImageGalleryDb()) {
    if (!mediaId) return null;
    try {
      return database.prepare("SELECT * FROM gallery_media_covers WHERE media_id = ?").get(mediaId) || null;
    } catch (error) {
      console.warn("[gallery-media-cover-db]", error.message || error);
      return null;
    }
  }

  async function signature(itemOrPath) {
    const filePath = typeof itemOrPath === "string" ? itemOrPath : mediaPath(itemOrPath);
    let stat;
    try { stat = filePath ? await statFile(filePath) : null; } catch { return null; }
    if (!stat?.isFile()) return null;
    return {
      filePath,
      sourcePath: path.resolve(filePath),
      sourceSize: stat.size || 0,
      sourceMtimeMs: Math.floor(stat.mtimeMs || 0),
      diskStamp: JSON.stringify([stat.size, stat.mtimeMs, stat.dev, stat.ino])
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

  function upsertCoverError(item, mediaSignature, error, database = getImageGalleryDb()) {
    const now = new Date().toISOString();
    try {
      database
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

  function upsertCover(item, mediaSignature, coverBlob, database = getImageGalleryDb()) {
    const now = new Date().toISOString();
    const blob = Buffer.from(coverBlob);
    database
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
    return coverRow(item.id, database);
  }

  function sourceStamp(item) {
    return JSON.stringify([item?.id, item?.sourceRoot, item?.relativePath, item?.type, item?.size, item?.updatedAt]);
  }

  function cacheStamp(row) {
    if (!row) return "";
    return JSON.stringify([row.source_path, row.source_size, row.source_mtime_ms, row.generator_version,
      row.status, row.error, row.cover_mime, row.cover_bytes, row.generated_at, row.updated_at,
      row.cover_blob ? crypto.createHash("sha256").update(row.cover_blob).digest("hex") : ""]);
  }

  function stoppedError() { return Object.assign(new Error("影视封面服务正在停止"), { statusCode: 503 }); }
  function abortedError() { return new DOMException("生成封面已取消", "AbortError"); }
  function staleError() { return Object.assign(new Error("视频来源或封面缓存已变化，请重新加载"), { statusCode: 409, staleCover: true }); }

  async function generateCover(item, options = {}) {
    if (stopping) throw stoppedError();
    if (options.signal?.aborted) throw abortedError();
    const source = sourceStamp(item);
    const database = getImageGalleryDb();
    const mediaSignature = await signature(item);
    if (stopping) throw stoppedError();
    if (options.signal?.aborted) throw abortedError();
    if (!mediaSignature) {
      const error = new Error("视频文件不存在");
      error.statusCode = 404;
      throw error;
    }

    const current = byId(item.id);
    if (!current || sourceStamp(current) !== source || getImageGalleryDb() !== database) throw staleError();
    const cached = coverRow(item.id, database);
    if (coverMatches(cached, mediaSignature)) {
      if (cached.status === "ok" && cached.cover_blob?.length) return cached;
      const error = new Error(cached.error || "分集封面生成失败");
      error.statusCode = 404;
      throw error;
    }

    if (!databases.has(database)) databases.set(database, ++databaseId);
    const key = JSON.stringify([item.id, mediaSignature.sourcePath, mediaSignature.diskStamp, source,
      databases.get(database), coverGeneratorVersion, coverBoxSize]);
    let task = tasks.get(key);
    if (!task) {
      if (tasks.size >= capacity) throw Object.assign(new Error("影视封面生成队列已满"), { statusCode: 503 });
      let resolve, reject;
      task = { key, mediaId: item.id, item: { id: item.id }, source, database, mediaSignature,
        cached: cacheStamp(cached), controller: new AbortController(), consumers: 0,
        promise: new Promise((yes, no) => { resolve = yes; reject = no; }) };
      task.resolve = resolve; task.reject = reject;
      tasks.set(key, task); queue.push(task);
    }
    if (task.controller.signal.aborted) throw abortedError();
    const result = consume(task, options.signal);
    drain();
    return result;
  }

  function consume(task, signal) {
    task.consumers += 1;
    let counted = true, cancelled = false;
    const abort = () => {
      cancelled = true;
      if (counted) { counted = false; task.consumers -= 1; }
      if (!task.consumers) cancel(task);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    return task.promise.then((row) => { if (cancelled) throw abortedError(); return row; }).finally(() => {
      signal?.removeEventListener("abort", abort);
      if (counted) task.consumers -= 1;
    });
  }

  function cancel(task) {
    task.controller.abort();
    const position = queue.indexOf(task);
    if (position >= 0) {
      queue.splice(position, 1); tasks.delete(task.key); task.reject(abortedError());
    }
  }

  function drain() {
    while (!stopping && running.size < concurrency && queue.length) {
      const task = queue.shift(); running.add(task);
      task.settled = performGeneration(task).then(task.resolve, task.reject).finally(() => {
        running.delete(task);
        if (tasks.get(task.key) === task) tasks.delete(task.key);
        drain();
      });
    }
  }

  async function verifyCurrent(task) {
    const signatureNow = await signature(task.mediaSignature.filePath);
    // Resolve the index and DB only after the last awaited disk operation.
    const current = byId(task.mediaId);
    if (!signatureNow || signatureNow.diskStamp !== task.mediaSignature.diskStamp || !current
      || sourceStamp(current) !== task.source || mediaPath(current) !== task.mediaSignature.filePath
      || getImageGalleryDb() !== task.database || cacheStamp(coverRow(task.mediaId, task.database)) !== task.cached) throw staleError();
  }

  async function performGeneration(task) {
    const signal = task.controller.signal;
    try {
      await verifyCurrent(task);
      if (signal.aborted || stopping) throw abortedError();
      let duration;
      try { duration = await probeDuration(task.mediaSignature.filePath, { ffprobePath, spawnFn, signal, probeTimeoutMs }); }
      catch (error) {
        if (signal.aborted || error.code !== "COVER_TIMEOUT") throw error;
        duration = null; // Keep the old duration-unavailable eight-second seek.
      }
      if (signal.aborted || stopping) throw abortedError();
      const blob = await extractFrame(task.mediaSignature.filePath, {
        ffmpegPath, spawnFn, signal, maxBytes: coverMaxBytes, timeoutMs,
        duration: Number(duration) || 0, boxSize: coverBoxSize, quality: 5
      });
      await verifyCurrent(task);
      if (signal.aborted || stopping) throw abortedError();
      return upsertCover(task.item, task.mediaSignature, blob, task.database);
    } catch (error) {
      // Cancellation, queueing and stale sources must not poison persistent
      // cache rows. A later success or a swapped DB must also remain untouched.
      if (!signal.aborted && !stopping && !error.staleCover) {
        try { await verifyCurrent(task); }
        catch { throw error; }
        if (!signal.aborted && !stopping) upsertCoverError(task.item, task.mediaSignature, error, task.database);
      }
      error.statusCode = error.statusCode || 500;
      throw error;
    }
  }

  function beginStop() {
    lifecycleGeneration += 1;
    stopping = true;
    for (const task of tasks.values()) cancel(task);
  }
  function stop() {
    beginStop();
    if (!stopTask) stopTask = (async () => {
      await Promise.allSettled([...running].map((task) => task.settled));
      await Promise.allSettled([...requests]);
    })();
    return stopTask;
  }
  async function start() {
    const generation = lifecycleGeneration;
    if (stopTask) await stopTask;
    if (generation !== lifecycleGeneration) throw stoppedError();
    stopTask = null; stopping = false;
  }

  function serveMedia(req, res, mediaId) {
    const item = byId(decodeURIComponent(mediaId));
    const file = videoFile(item);
    if (!file) {
      notFound(res);
      return;
    }
    return mediaStreamService.serveVideo(req, res, file);
  }

  function serveCover(res, mediaId, options = {}) {
    const request = serveCoverAsync(res, mediaId, options);
    requests.add(request);
    request.then(() => requests.delete(request), () => requests.delete(request));
    return request;
  }

  function canReply(res) { return !res.destroyed && !res.writableEnded && !res.headersSent; }

  async function serveCoverAsync(res, mediaId, options) {
    if (!canReply(res)) return;
    if (stopping) { res.writeHead(503); res.end(); return; }
    const item = byId(decodeURIComponent(mediaId));
    if (!item) {
      notFound(res);
      return;
    }

    let row;
    try {
      row = await generateCover(item, options);
    } catch (error) {
      if (canReply(res) && !options.signal?.aborted) {
        console.warn("[gallery-media-cover]", item.relativePath || item.id, error.message || error);
        notFound(res);
      }
      return;
    }
    if (!canReply(res) || options.signal?.aborted) return;
    if (!row?.cover_blob?.length) {
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
    beginStop,
    byId,
    mediaPath,
    publicDetail,
    start,
    stop,
    serveCover,
    serveMedia,
    videoFile,
    diagnostics: () => ({ stopping, tasks: tasks.size, queued: queue.length, running: running.size, requests: requests.size })
  };
}
