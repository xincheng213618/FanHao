import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createVideoProbeTaskPool } from "./video-probe-task-pool.js";

export const DEFAULT_VIDEO_PROBE_WAIT_MS = 80;
const DIRECT_STREAM_VERSION = "20260815-range-chunks-01";

export function createVideoProbeService({
  cacheLimit = 512,
  directVideoExts,
  ffprobePath,
  hasNvenc,
  safeStat,
  execFileFn = execFile,
  persistentCache = null,
  asyncConcurrency = 2,
  asyncCapacity = 48,
  statTimeoutMs = 2000,
  statCapacity = 8,
  processTimeoutMs = 8000,
  stopTimeoutMs = 2000,
  probeWaitMs = DEFAULT_VIDEO_PROBE_WAIT_MS,
  statFile = (filePath) => fs.promises.stat(filePath),
  spawnSyncFn = spawnSync
}) {
  const cache = new Map();
  const resolvedProbeByFile = new Map();
  const sourceOwners = new Map();
  const asyncInflight = new Map();
  const inflightTasks = new Map();
  const taskPool = createVideoProbeTaskPool({ concurrency: asyncConcurrency, capacity: asyncCapacity });
  const physicalStats = new Set();
  const children = new Set();
  const prewarmQueue = [];
  const prewarmQueuedKeys = new Set();
  let prewarmActive = 0;
  let prewarmConcurrency = 2;
  let cacheGeneration = 0;
  let lifecycleRevision = 0;
  let stopping = false;
  let stopPromise = null;

  function transientError(code) {
    return Object.assign(new Error(code), { code });
  }

  async function trackedStat(filePath, signal) {
    if (signal.aborted) throw transientError("PROBE_ABORTED");
    if (physicalStats.size >= Math.max(1, Math.min(32, Number(statCapacity) || 8))) throw transientError("PROBE_BUSY");
    let operation;
    try { operation = Promise.resolve(statFile(filePath)); }
    catch (error) { operation = Promise.reject(error); }
    physicalStats.add(operation);
    // Logical cancellation cannot cancel an OS filesystem request. Retain its
    // physical slot until settlement so repeated clears cannot grow that work.
    operation.then(() => physicalStats.delete(operation), () => physicalStats.delete(operation));
    let timer, onAbort;
    const unavailable = new Promise((_, reject) => {
      onAbort = () => reject(transientError("PROBE_ABORTED"));
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => reject(transientError("PROBE_STAT_TIMEOUT")), Math.max(1, Number(statTimeoutMs) || 2000));
      if (signal.aborted) onAbort();
    });
    try { return await Promise.race([operation, unavailable]); }
    finally { clearTimeout(timer); signal.removeEventListener("abort", onAbort); }
  }

  function inflightKey(file) {
    const signature = libraryFileSignature(file);
    return JSON.stringify([file.id, file.path, signature?.size ?? file.size ?? null, signature?.cacheMtime ?? null]);
  }

  function sourceKey(file) {
    return JSON.stringify([file.id, file.path]);
  }

  function cacheValue(target, key, value) {
    target.delete(key);
    target.set(key, value);
    while (target.size > Math.max(1, cacheLimit)) target.delete(target.keys().next().value);
  }

  function claimSource(file) {
    sourceOwners.get(sourceKey(file))?.task?.cancel();
    const owner = {};
    sourceOwners.set(sourceKey(file), owner);
    return owner;
  }

  function releaseSource(file, owner) {
    const key = sourceKey(file);
    if (sourceOwners.get(key) === owner) sourceOwners.delete(key);
  }

  function parseProbeOutput(stdout) {
    const data = JSON.parse(stdout);
    const video = (data.streams || []).find((stream) => stream.codec_type === "video") || {};
    const audio = (data.streams || []).find((stream) => stream.codec_type === "audio") || {};
    return {
      duration: Number(data.format?.duration || 0) || null,
      videoCodec: video.codec_name || "",
      audioCodec: audio.codec_name || "",
      width: video.width || null,
      height: video.height || null
    };
  }

  function probe(file) {
    if (stopping) return null;
    try {
      const result = spawnSyncFn(
        ffprobePath,
        ["-v", "error", "-show_entries", "format=duration", "-show_streams", "-of", "json", file.path],
        { encoding: "utf8", windowsHide: true, timeout: 8000, maxBuffer: 2 * 1024 * 1024 }
      );
      if (result.status !== 0 || !result.stdout) return null;
      return parseProbeOutput(result.stdout);
    } catch {
      return null;
    }
  }

  function probeCached(file) {
    if (stopping) return null;
    const owner = claimSource(file);
    try {
      const fileSignature = libraryFileSignature(file);
      const fileCacheKey = fileSignature ? cacheKeyForSignature(file, fileSignature) : "";
      if (fileCacheKey && cache.has(fileCacheKey)) return touchCached(fileCacheKey);
      const persistedFromLibrary = fileSignature ? readPersistentProbe(file, fileSignature) : { hit: false, value: null };
      if (persistedFromLibrary.hit) {
        cacheValue(cache, fileCacheKey, persistedFromLibrary.value);
        cacheValue(resolvedProbeByFile, inflightKey(file), persistedFromLibrary.value);
        return persistedFromLibrary.value;
      }

      const stat = safeStat(file.path);
      const cacheKey = diskCacheKey(file, stat);
      if (cache.has(cacheKey)) return touchCached(cacheKey);

      const persisted = stat ? readPersistentProbe(file, stat) : { hit: false, value: null };
      const result = persisted.hit ? persisted.value : stat ? probe(file) : null;
      if (stat && (!persisted.hit || fileSignature)) writePersistentProbe(file, fileSignature || stat, result);
      cacheValue(cache, fileCacheKey || cacheKey, result);
      cacheValue(resolvedProbeByFile, inflightKey(file), result);
      return result;
    } finally {
      releaseSource(file, owner);
    }
  }

  function runProbeAsync(file, signal) {
    return new Promise((resolve, reject) => {
      let child, returned = false, tracked = false, closed = false, callbackSeen = false;
      let value = null, invalid = false, timer;
      const finish = () => {
        if (!returned || (tracked && !closed) || (!tracked && !callbackSeen && !invalid)) return;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (child) children.delete(child);
        if (signal.aborted) reject(transientError("PROBE_ABORTED"));
        else resolve(invalid ? null : value);
      };
      const terminate = () => {
        invalid = true;
        if (tracked && !closed) { try { child.kill("SIGKILL"); } catch {} }
        finish();
      };
      const onAbort = () => terminate();
      if (signal.aborted) { reject(transientError("PROBE_ABORTED")); return; }
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        child = execFileFn(
          ffprobePath,
          ["-v", "error", "-show_entries", "format=duration", "-show_streams", "-of", "json", file.path],
          { encoding: "utf8", windowsHide: true, timeout: Math.max(1, Number(processTimeoutMs) || 8000), killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024 },
          (error, stdout) => {
            callbackSeen = true;
            if (error || !stdout) invalid = true;
            else { try { value = parseProbeOutput(stdout); } catch { invalid = true; } }
            if (error) terminate(); else finish();
          }
        );
        tracked = Boolean(child?.once && child?.kill);
        returned = true;
        if (tracked) {
          children.add(child);
          child.once("close", () => { closed = true; finish(); });
          child.once("error", terminate);
          child.stdout?.once("error", terminate);
          child.stderr?.once("error", terminate);
          timer = setTimeout(terminate, Math.max(1, Number(processTimeoutMs) || 8000));
          if (invalid || signal.aborted) terminate();
        }
        finish();
      } catch {
        returned = true;
        invalid = true;
        finish();
      }
    });
  }

  function probeAsync(file) {
    if (stopping) return Promise.reject(transientError("PROBE_STOPPED"));
    file = { ...file };
    try { return taskPool.submit((signal) => runProbeAsync(file, signal)).promise; }
    catch (error) { return Promise.reject(error); }
  }

  function probeCachedAsync(file, { background = false } = {}) {
    if (stopping) return Promise.reject(transientError("PROBE_STOPPED"));
    file = { ...file };
    const key = inflightKey(file);
    if (libraryFileSignature(file) && resolvedProbeByFile.has(key)) {
      const owner = claimSource(file);
      const value = resolvedProbeByFile.get(key);
      cacheValue(resolvedProbeByFile, key, value);
      releaseSource(file, owner);
      return Promise.resolve(value);
    }
    const active = asyncInflight.get(key);
    if (active) {
      if (!background) inflightTasks.get(key)?.promote();
      return active;
    }

    // Library signatures retain the zero-stat warm path even under load.
    const signature = libraryFileSignature(file);
    const libraryKey = signature ? cacheKeyForSignature(file, signature) : "";
    const persisted = signature ? readPersistentProbe(file, signature) : { hit: false };
    if ((libraryKey && cache.has(libraryKey)) || persisted.hit) {
      const owner = claimSource(file);
      const value = cache.has(libraryKey) ? touchCached(libraryKey) : persisted.value;
      cacheValue(cache, libraryKey, value);
      cacheValue(resolvedProbeByFile, key, value);
      releaseSource(file, owner);
      return Promise.resolve(value);
    }
    if (!taskPool.hasCapacity()) return Promise.reject(transientError("PROBE_BUSY"));

    const owner = claimSource(file);
    const generation = cacheGeneration;
    const operation = taskPool.submit((signal) => loadProbeAsync(file, key, owner, generation, signal), { background });
    owner.task = operation;
    const task = operation.promise;
    asyncInflight.set(key, task);
    inflightTasks.set(key, operation);
    const settled = () => {
      releaseSource(file, owner);
      if (asyncInflight.get(key) === task) asyncInflight.delete(key);
      if (inflightTasks.get(key) === operation) inflightTasks.delete(key);
    };
    task.then(settled, settled);
    return task;
  }

  async function loadProbeAsync(file, fileKey, owner, generation, signal) {
    const current = () => !signal.aborted && !stopping && generation === cacheGeneration && sourceOwners.get(sourceKey(file)) === owner;
    try {
      return await loadProbeForSource(file, fileKey, current, signal);
    } catch (error) {
      if (!current()) return null;
      throw error;
    }
  }

  async function loadProbeForSource(file, fileKey, current, signal) {
    if (!current()) return null;
    const fileSignature = libraryFileSignature(file);
    const fileCacheKey = fileSignature ? cacheKeyForSignature(file, fileSignature) : "";
    if (fileCacheKey && cache.has(fileCacheKey)) {
      const cached = touchCached(fileCacheKey);
      if (current()) cacheValue(resolvedProbeByFile, fileKey, cached);
      return cached;
    }
    const persistedFromLibrary = fileSignature ? readPersistentProbe(file, fileSignature) : { hit: false, value: null };
    if (persistedFromLibrary.hit) {
      if (current()) {
        cacheValue(cache, fileCacheKey, persistedFromLibrary.value);
        cacheValue(resolvedProbeByFile, fileKey, persistedFromLibrary.value);
      }
      return persistedFromLibrary.value;
    }

    let stat = null;
    try {
      stat = await trackedStat(file.path, signal);
    } catch (error) {
      if (String(error.code || "").startsWith("PROBE_")) throw error;
      stat = null;
    }
    if (!current()) return null;
    const cacheKey = diskCacheKey(file, stat);
    if (cache.has(cacheKey)) {
      const cached = touchCached(cacheKey);
      if (current()) cacheValue(resolvedProbeByFile, fileKey, cached);
      return cached;
    }

    const persisted = stat ? readPersistentProbe(file, stat) : { hit: false, value: null };
    const result = persisted.hit ? persisted.value : stat ? await runProbeAsync(file, signal) : null;
    if (!current()) return null;
    if (stat && !persisted.hit) {
      let after;
      try { after = await trackedStat(file.path, signal); }
      catch (error) { if (String(error.code || "").startsWith("PROBE_")) throw error; return null; }
      if (!current() || diskSignature(after) !== diskSignature(stat)) return null;
    }
    if (stat && (!persisted.hit || fileSignature) && current()) writePersistentProbe(file, fileSignature || stat, result);
    if (current()) {
      cacheValue(cache, fileCacheKey || cacheKey, result);
      cacheValue(resolvedProbeByFile, fileKey, result);
    }
    return result;
  }

  function libraryFileSignature(file) {
    const size = Number(file?.size);
    const modifiedAt = String(file?.modifiedAt || "").trim();
    if (!Number.isFinite(size) || size < 0 || !modifiedAt) return null;
    return { size, cacheMtime: `library:${modifiedAt}` };
  }

  function cacheKeyForSignature(file, signature) {
    return JSON.stringify([file.id, file.path, signature.size, signature.cacheMtime]);
  }

  function diskCacheKey(file, stat) {
    return JSON.stringify([file.id, file.path, stat ? diskSignature(stat) : "missing"]);
  }

  function diskSignature(stat) {
    return JSON.stringify([Number(stat?.size), Number(stat?.mtimeMs), String(stat?.dev ?? ""), String(stat?.ino ?? "")]);
  }

  function touchCached(cacheKey) {
    const cached = cache.get(cacheKey);
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    return cached;
  }

  function readPersistentProbe(file, stat) {
    if (!persistentCache?.get) return { hit: false, value: null };
    try {
      const cached = persistentCache.get(file, stat);
      return cached?.hit ? cached : { hit: false, value: null };
    } catch {
      return { hit: false, value: null };
    }
  }

  function writePersistentProbe(file, stat, value) {
    if (!persistentCache?.set) return;
    try {
      persistentCache.set(file, stat, value);
    } catch {
      // Playback must continue even when the optional persistent cache is unavailable.
    }
  }

  function prewarm(files = [], options = {}) {
    if (stopping) return { queued: 0, active: prewarmActive, pending: 0 };
    const limit = Math.max(0, Math.min(48, Number(options.limit) || 12));
    const queueLimit = Math.max(limit, Math.min(96, Number(options.queueLimit) || 48));
    prewarmConcurrency = Math.max(1, Math.min(4, Number(options.concurrency) || 2));
    if (options.replaceQueued) {
      prewarmQueue.length = 0;
      prewarmQueuedKeys.clear();
    }
    let queued = 0;
    for (const file of files || []) {
      if (queued >= limit || prewarmQueue.length + prewarmActive >= queueLimit) break;
      if (!file?.id || !file?.path) continue;
      const key = inflightKey(file);
      if ((libraryFileSignature(file) && resolvedProbeByFile.has(key)) || prewarmQueuedKeys.has(key) || asyncInflight.has(key)) continue;
      prewarmQueuedKeys.add(key);
      prewarmQueue.push({ file: { ...file }, key });
      queued += 1;
    }
    drainPrewarmQueue();
    return { queued, active: prewarmActive, pending: prewarmQueue.length };
  }

  function drainPrewarmQueue() {
    while (prewarmActive < prewarmConcurrency && prewarmQueue.length) {
      const { file, key } = prewarmQueue.shift();
      prewarmQueuedKeys.delete(key);
      prewarmActive += 1;
      probeCachedAsync(file, { background: true })
        .catch(() => null)
        .finally(() => {
          prewarmActive -= 1;
          drainPrewarmQueue();
        });
    }
  }

  function clearCache() {
    cacheGeneration += 1;
    cache.clear();
    resolvedProbeByFile.clear();
    sourceOwners.clear();
    asyncInflight.clear();
    inflightTasks.clear();
    prewarmQueue.length = 0;
    prewarmQueuedKeys.clear();
    taskPool.cancelAll();
  }

  function beginStop() {
    stopping = true;
    lifecycleRevision++;
    clearCache();
  }

  function stop() {
    beginStop();
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      let timer;
      try {
        await Promise.race([
          taskPool.drain(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(transientError("PROBE_CLOSE_TIMEOUT")), Math.max(1, Number(stopTimeoutMs) || 2000)); })
        ]);
      } finally { clearTimeout(timer); }
    })();
    return stopPromise;
  }

  async function start() {
    const revision = lifecycleRevision;
    if (stopPromise) {
      try { await stopPromise; }
      catch (error) { if (taskPool.diagnostics().active || children.size) throw error; }
    }
    if (revision !== lifecycleRevision) throw transientError("PROBE_STOPPED");
    if (taskPool.diagnostics().active || children.size) throw transientError("PROBE_CLOSE_TIMEOUT");
    stopping = false;
    stopPromise = null;
  }

  async function boundedProbe(file) {
    const task = probeCachedAsync(file);
    const waitMs = Math.max(0, Number(probeWaitMs) || 0);
    if (!waitMs) return { mediaProbe: await task.catch(() => null), pending: false };

    let timer = null;
    const settled = task.then(
      (mediaProbe) => ({ mediaProbe, pending: false }),
      () => ({ mediaProbe: null, pending: false })
    );
    const pending = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ mediaProbe: null, pending: true }), waitMs);
    });
    const result = await Promise.race([settled, pending]);
    if (timer) clearTimeout(timer);
    return result;
  }

  function playInfoForFile(file, publicVideoId = file.id, options = {}) {
    return playInfoFromProbe(file, publicVideoId, options, probeCached(file) || {});
  }

  async function playInfoForFileAsync(file, publicVideoId = file.id, options = {}) {
    const { mediaProbe, pending } = await boundedProbe(file);
    return playInfoFromProbe(file, publicVideoId, options, mediaProbe || {}, pending);
  }

  function playInfoFromProbe(file, publicVideoId, options, mediaProbe, probePending = false) {
    const videoCodec = String(mediaProbe.videoCodec || "").toLowerCase();
    const audioCodec = String(mediaProbe.audioCodec || "").toLowerCase();
    const ext = String(file.ext || "").toLowerCase();
    const probeUnavailable = !videoCodec && !audioCodec;
    const mp4Compatible = [".mp4", ".m4v"].includes(ext)
      && ["h264", "avc1", "hevc", "h265", "hev1", "hvc1"].includes(videoCodec)
      && (!audioCodec || ["aac", "mp3"].includes(audioCodec));
    const webmCompatible = ext === ".webm"
      && ["vp8", "vp9", "av1"].includes(videoCodec)
      && (!audioCodec || ["opus", "vorbis"].includes(audioCodec));
    const canDirect = directVideoExts.has(ext) && (probeUnavailable || mp4Compatible || webmCompatible);
    const streamBase = options.streamBase || "/media/video";

    if (canDirect) {
      const fallbackParams = new URLSearchParams({ mode: "transcode", audio: "aac" });
      return {
        mode: "direct",
        label: "原生直连",
        streamUrl: `${streamBase}/${encodeURIComponent(publicVideoId)}?v=${DIRECT_STREAM_VERSION}`,
        fallbackStreamUrl: `${streamBase}/${encodeURIComponent(publicVideoId)}/transcode?${fallbackParams}`,
        duration: mediaProbe.duration || null,
        videoCodec,
        audioCodec,
        width: mediaProbe.width || null,
        height: mediaProbe.height || null,
        hasNvenc,
        probePending
      };
    }

    const canRemux = videoCodec === "h264" || videoCodec === "avc1";
    const mode = canRemux ? "remux" : "transcode";
    const params = new URLSearchParams({
      mode,
      audio: audioCodec === "aac" ? "copy" : "aac"
    });
    return {
      mode,
      label: mode === "remux" ? "快速重封装" : hasNvenc ? "GPU 转码" : "智能转码",
      streamUrl: `${streamBase}/${encodeURIComponent(publicVideoId)}/transcode?${params}`,
      duration: mediaProbe.duration || null,
      videoCodec,
      audioCodec,
      width: mediaProbe.width || null,
      height: mediaProbe.height || null,
      hasNvenc,
      probePending
    };
  }

  return {
    start,
    beginStop,
    stop,
    clearCache,
    playInfoForFile,
    playInfoForFileAsync,
    probe,
    probeAsync,
    probeCachedAsync,
    probeCached,
    prewarm,
    diagnostics: () => ({ cached: cache.size, resolved: resolvedProbeByFile.size, owners: sourceOwners.size, inflight: asyncInflight.size }),
    asyncDiagnostics: () => ({ ...taskPool.diagnostics(), children: children.size, physicalStats: physicalStats.size, stopping })
  };
}
