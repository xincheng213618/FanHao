import fs from "node:fs";
import { DEFAULT_MAX_COVER_BYTES, extractCoverFrameAsync } from "../../../../../lib/cover-frame.js";

export const COVER_STATUS_STAT_CONCURRENCY = 32;
export const COVER_GENERATION_CONCURRENCY = 2;
export const COVER_GENERATION_CAPACITY = 16;

export function createWorkCoverMutationService({
  ffmpegPath,
  ffprobePath,
  getCoreDb,
  getWorks,
  resolveWork = (id) => getWorks().find((work) => String(work.id) === String(id)),
  manualCoverStamp = () => "",
  generationConcurrency = COVER_GENERATION_CONCURRENCY,
  generationCapacity = COVER_GENERATION_CAPACITY,
  extractFrame = extractCoverFrameAsync,
  spawnFn,
  timeoutMs = 30000,
  invalidateWorkImageCache = () => {},
  maxCoverBytes = DEFAULT_MAX_COVER_BYTES,
  publicCoreWorkCover,
  publicWorkCover,
  resetWorkSearch,
  safeStat,
  stat = fs.promises.stat,
  workCoverRow,
  workInfoService
}) {
  const tasks = new Map();
  const queue = [];
  const running = new Set();
  const concurrency = Math.max(1, Math.min(8, Number(generationConcurrency) || COVER_GENERATION_CONCURRENCY));
  const capacity = Math.max(concurrency, Math.min(64, Number(generationCapacity) || COVER_GENERATION_CAPACITY));
  let stopping = false;

  function mutationError(message, statusCode = 409) {
    return Object.assign(new Error(message), { statusCode });
  }

  function sourceStamp(work) {
    return JSON.stringify([work?.id, work?.missingLocal, work?.coverId, (work?.videos || []).map((video) => [video.id, video.path, video.relativePath, video.size, video.modifiedAt])]);
  }

  function imageStamp(workId) {
    return JSON.stringify(getCoreDb().prepare(`
      SELECT id, source_type, local_path, remote_url, byte_size, status, source, legacy_table, legacy_key, updated_at
      FROM fanhao_images.images WHERE owner_type = 'work' AND owner_id = ? AND kind = 'cover' ORDER BY id
    `).all(Number(workId)));
  }

  function generateWorkCover(work, options = {}) {
    if (stopping) return Promise.reject(mutationError("封面生成服务正在停止", 503));
    if (options.signal?.aborted) return Promise.reject(new DOMException("生成封面已取消", "AbortError"));
    if (work.coverId) return Promise.reject(mutationError("这个作品已经有本地封面", 400));
    const source = sourceStamp(work);
    const key = source;
    let task = tasks.get(key);
    if (!task) {
      if (tasks.size >= capacity) return Promise.reject(mutationError("封面生成队列已满，请稍后再试", 503));
      let resolve, reject;
      task = { key, workId: work.id, source, manual: manualCoverStamp(work), images: imageStamp(work.id), controller: new AbortController(), consumers: 0,
        promise: new Promise((yes, no) => { resolve = yes; reject = no; }), resolve: null, reject: null };
      task.resolve = resolve; task.reject = reject;
      tasks.set(key, task);
      queue.push(task);
    }
    if (task.controller.signal.aborted) return Promise.reject(mutationError("这个作品的封面生成正在取消，请稍后再试"));
    const result = consume(task, options.signal);
    drain();
    return result;
  }

  function consume(task, signal) {
    task.consumers++;
    let counted = true, cancelled = false;
    const abort = () => {
      cancelled = true;
      if (counted) { counted = false; task.consumers--; }
      if (!task.consumers) cancelTask(task);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    return task.promise.then((value) => {
      if (cancelled) throw new DOMException("生成封面已取消", "AbortError");
      return value;
    }).finally(() => {
      signal?.removeEventListener("abort", abort);
      if (counted) task.consumers--;
    });
  }

  function cancelTask(task) {
    task.controller.abort();
    const queuedIndex = queue.indexOf(task);
    if (queuedIndex >= 0) {
      queue.splice(queuedIndex, 1);
      tasks.delete(task.key);
      task.reject(new DOMException("生成封面已取消", "AbortError"));
    }
  }

  function cancelWork(workId) {
    for (const task of tasks.values()) if (String(task.workId) === String(workId)) cancelTask(task);
  }

  function drain() {
    while (!stopping && running.size < concurrency && queue.length) {
      const task = queue.shift();
      running.add(task);
      performGeneration(task).then(task.resolve, task.reject).finally(() => {
        running.delete(task);
        if (tasks.get(task.key) === task) tasks.delete(task.key);
        drain();
      });
    }
  }

  function beginStop() {
    stopping = true;
    for (const task of tasks.values()) cancelTask(task);
  }

  async function stop() {
    beginStop();
    await Promise.allSettled([...tasks.values()].map((task) => task.promise));
  }
  function cachedWorkCoverIds() {
    try {
      const rows = getCoreDb()
        .prepare(
          `
          SELECT CAST(i.owner_id AS TEXT) AS work_id
          FROM fanhao_images.images i
          WHERE i.owner_type = 'work'
            AND i.kind = 'cover'
            AND i.image_blob IS NOT NULL
            AND length(i.image_blob) > 0
          `
        )
        .all();
      return new Set(rows.map((row) => row.work_id));
    } catch (error) {
      console.warn("[core-work-cover]", error.message);
      return new Set();
    }
  }

  function chooseCoverVideo(work) {
    return (work.videos || []).find((video) => safeStat(video.path)) || null;
  }

  async function chooseCoverVideoForStatus(work) {
    for (const video of work.videos || []) {
      try {
        await stat(video.path);
        return video;
      } catch {
        // Match safeStat: any unreadable or missing path is not a usable video.
      }
    }
    return null;
  }

  async function mapWithConcurrency(items, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(COVER_STATUS_STAT_CONCURRENCY, items.length);

    async function worker() {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index]);
      }
    }

    await Promise.all(Array.from({ length: workerCount }, worker));
    return results;
  }

  async function generationStatus(sampleLimit = 8) {
    const cachedCoverIds = cachedWorkCoverIds();
    const candidates = getWorks()
      .filter((work) => !work.missingLocal)
      .filter((work) => !work.coverId)
      .filter((work) => !cachedCoverIds.has(work.id))
      .filter((work) => (work.videos || []).length > 0)
      .sort((a, b) => String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || "")));

    const candidateVideos = await mapWithConcurrency(candidates, chooseCoverVideoForStatus);
    const sample = [];
    let ready = 0;
    let missingVideo = 0;
    for (const [index, work] of candidates.entries()) {
      const video = candidateVideos[index];
      if (video) {
        ready += 1;
        if (sample.length < sampleLimit) {
          sample.push({
            workId: work.id,
            personId: work.personId || "",
            title: work.title || work.directoryName || "",
            videoCount: (work.videos || []).length,
            modifiedAt: work.modifiedAt || ""
          });
        }
        continue;
      }
      missingVideo += 1;
    }

    return {
      candidates: candidates.length,
      ready,
      missingVideo,
      sample
    };
  }

  async function performGeneration(task) {
    const signal = task.controller.signal;
    const work = resolveWork(task.workId);
    if (!work || sourceStamp(work) !== task.source) throw mutationError("作品或视频来源已变化，请重新选择");
    const video = await chooseCoverVideoForStatus(work);
    if (signal.aborted) throw new DOMException("生成封面已取消", "AbortError");
    if (!video) {
      const error = new Error("这个作品没有可读取的视频文件");
      error.statusCode = 400;
      throw error;
    }

    let coverBlob;
    const sourceStat = await stat(video.path);
    const diskStamp = (value) => JSON.stringify([value.size, value.mtimeMs, value.dev, value.ino]);
    try {
      coverBlob = await extractFrame(video.path, {
        ffmpegPath,
        ffprobePath,
        maxBytes: maxCoverBytes,
        timeoutMs,
        spawnFn,
        signal
      });
    } catch (error) {
      error.statusCode = error.statusCode || 500;
      throw error;
    }

    const currentStat = await stat(video.path);
    const current = resolveWork(task.workId);
    if (signal.aborted) throw new DOMException("生成封面已取消", "AbortError");
    if (!current || sourceStamp(current) !== task.source || diskStamp(currentStat) !== diskStamp(sourceStat)
      || manualCoverStamp(current) !== task.manual) throw mutationError("作品、视频或人工封面已变化，已取消这次生成");

    const now = new Date().toISOString();
    const coreWorkId = Number(work.id);
    const db = getCoreDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      if (imageStamp(work.id) !== task.images) throw mutationError("作品封面已变化，已取消这次生成");
      db
      .prepare(
        `
        INSERT INTO fanhao_images.images (
          owner_type, owner_id, kind, source_type, local_path, mime, image_blob,
          byte_size, sort_order, status, source, legacy_table, legacy_key, created_at, updated_at
        ) VALUES ('work', ?, 'cover', 'generated', ?, ?, ?, ?, 0, 'ok', ?, 'generated', ?, ?, ?)
        ON CONFLICT DO UPDATE SET
          mime = excluded.mime,
          image_blob = excluded.image_blob,
          byte_size = excluded.byte_size,
          status = excluded.status,
          source = excluded.source,
          legacy_table = excluded.legacy_table,
          legacy_key = excluded.legacy_key,
          updated_at = excluded.updated_at
        `
      )
      .run(
        coreWorkId,
        video.relativePath || video.path || "",
        "image/jpeg",
        coverBlob,
        coverBlob.length,
        "ffmpeg-frame",
        work.id,
        now,
        now
      );
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "封面写入失败且无法确认回滚结果"); }
      throw error;
    }

    invalidateWorkImageCache();
    workInfoService.invalidate();
    resetWorkSearch();
    return publicCoreWorkCover(work.id) || publicWorkCover(workCoverRow(work.id));
  }

  return {
    beginStop,
    cancelWork,
    chooseCoverVideo,
    generationStatus,
    generateWorkCover,
    stop
  };
}
