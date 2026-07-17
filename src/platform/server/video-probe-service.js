import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";

export function createVideoProbeService({
  cacheLimit = 512,
  directVideoExts,
  ffprobePath,
  hasNvenc,
  safeStat,
  execFileFn = execFile,
  persistentCache = null,
  probeWaitMs = 300,
  statFile = (filePath) => fs.promises.stat(filePath),
  spawnSyncFn = spawnSync
}) {
  const cache = new Map();
  const resolvedProbeByFile = new Map();
  const asyncInflight = new Map();
  const prewarmQueue = [];
  const prewarmQueuedKeys = new Set();
  let prewarmActive = 0;
  let prewarmConcurrency = 2;
  let cacheGeneration = 0;

  function inflightKey(file) {
    return `${file.id}:${file.path}`;
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
    const fileSignature = libraryFileSignature(file);
    const fileCacheKey = fileSignature ? cacheKeyForSignature(file, fileSignature) : "";
    if (fileCacheKey && cache.has(fileCacheKey)) return touchCached(fileCacheKey);
    const persistedFromLibrary = fileSignature ? readPersistentProbe(file, fileSignature) : { hit: false, value: null };
    if (persistedFromLibrary.hit) {
      cache.set(fileCacheKey, persistedFromLibrary.value);
      resolvedProbeByFile.set(inflightKey(file), persistedFromLibrary.value);
      return persistedFromLibrary.value;
    }

    const stat = safeStat(file.path);
    const cacheKey = stat ? `${file.id}:${file.path}:${stat.size}:${stat.mtimeMs}` : `${file.id}:${file.path}:missing`;
    if (cache.has(cacheKey)) return touchCached(cacheKey);

    const persisted = stat ? readPersistentProbe(file, stat) : { hit: false, value: null };
    const result = persisted.hit ? persisted.value : stat ? probe(file) : null;
    if (stat && (!persisted.hit || fileSignature)) writePersistentProbe(file, fileSignature || stat, result);
    cache.set(fileCacheKey || cacheKey, result);
    resolvedProbeByFile.set(inflightKey(file), result);
    if (cache.size > cacheLimit) {
      cache.delete(cache.keys().next().value);
    }
    return result;
  }

  function probeAsync(file) {
    return new Promise((resolve) => {
      try {
        execFileFn(
          ffprobePath,
          ["-v", "error", "-show_entries", "format=duration", "-show_streams", "-of", "json", file.path],
          { encoding: "utf8", windowsHide: true, timeout: 8000, maxBuffer: 2 * 1024 * 1024 },
          (error, stdout) => {
            if (error || !stdout) {
              resolve(null);
              return;
            }
            try {
              resolve(parseProbeOutput(stdout));
            } catch {
              resolve(null);
            }
          }
        );
      } catch {
        resolve(null);
      }
    });
  }

  function probeCachedAsync(file) {
    const key = inflightKey(file);
    if (resolvedProbeByFile.has(key)) return Promise.resolve(resolvedProbeByFile.get(key));
    const active = asyncInflight.get(key);
    if (active) return active;

    const task = loadProbeAsync(file, key);
    asyncInflight.set(key, task);
    task.then(
      () => asyncInflight.delete(key),
      () => asyncInflight.delete(key)
    );
    return task;
  }

  async function loadProbeAsync(file, fileKey) {
    const generation = cacheGeneration;
    const fileSignature = libraryFileSignature(file);
    const fileCacheKey = fileSignature ? cacheKeyForSignature(file, fileSignature) : "";
    if (fileCacheKey && cache.has(fileCacheKey)) {
      const cached = touchCached(fileCacheKey);
      if (generation === cacheGeneration) resolvedProbeByFile.set(fileKey, cached);
      return cached;
    }
    const persistedFromLibrary = fileSignature ? readPersistentProbe(file, fileSignature) : { hit: false, value: null };
    if (persistedFromLibrary.hit) {
      if (generation === cacheGeneration) {
        cache.set(fileCacheKey, persistedFromLibrary.value);
        resolvedProbeByFile.set(fileKey, persistedFromLibrary.value);
      }
      return persistedFromLibrary.value;
    }

    let stat = null;
    try {
      stat = await statFile(file.path);
    } catch {
      stat = null;
    }
    const cacheKey = stat ? `${file.id}:${file.path}:${stat.size}:${stat.mtimeMs}` : `${file.id}:${file.path}:missing`;
    if (cache.has(cacheKey)) {
      const cached = touchCached(cacheKey);
      if (generation === cacheGeneration) resolvedProbeByFile.set(fileKey, cached);
      return cached;
    }

    const persisted = stat ? readPersistentProbe(file, stat) : { hit: false, value: null };
    const result = persisted.hit ? persisted.value : stat ? await probeAsync(file) : null;
    if (stat && (!persisted.hit || fileSignature)) writePersistentProbe(file, fileSignature || stat, result);
    if (generation === cacheGeneration) {
      cache.set(fileCacheKey || cacheKey, result);
      resolvedProbeByFile.set(fileKey, result);
      if (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
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
    return `${file.id}:${file.path}:${signature.size}:${signature.cacheMtime}`;
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
      if (resolvedProbeByFile.has(key) || prewarmQueuedKeys.has(key) || asyncInflight.has(key)) continue;
      prewarmQueuedKeys.add(key);
      prewarmQueue.push({ file, key });
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
      probeCachedAsync(file)
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
    prewarmQueue.length = 0;
    prewarmQueuedKeys.clear();
  }

  async function boundedProbe(file) {
    const task = probeCachedAsync(file);
    const waitMs = Math.max(0, Number(probeWaitMs) || 0);
    if (!waitMs) return { mediaProbe: await task, pending: false };

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
      && ["h264", "avc1"].includes(videoCodec)
      && (!audioCodec || ["aac", "mp3"].includes(audioCodec));
    const webmCompatible = ext === ".webm"
      && ["vp8", "vp9", "av1"].includes(videoCodec)
      && (!audioCodec || ["opus", "vorbis"].includes(audioCodec));
    const canDirect = directVideoExts.has(ext) && (probeUnavailable || mp4Compatible || webmCompatible);
    const streamBase = options.streamBase || "/media/video";

    if (canDirect) {
      return {
        mode: "direct",
        label: "原生直连",
        streamUrl: `${streamBase}/${encodeURIComponent(publicVideoId)}`,
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
    clearCache,
    playInfoForFile,
    playInfoForFileAsync,
    probe,
    probeAsync,
    probeCachedAsync,
    probeCached,
    prewarm
  };
}
