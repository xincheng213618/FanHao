import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";

export function createVideoProbeService({
  cacheLimit = 512,
  directVideoExts,
  ffprobePath,
  hasNvenc,
  safeStat,
  execFileFn = execFile,
  probeWaitMs = 300,
  statFile = (filePath) => fs.promises.stat(filePath),
  spawnSyncFn = spawnSync
}) {
  const cache = new Map();
  const asyncInflight = new Map();

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
    const stat = safeStat(file.path);
    const cacheKey = stat ? `${file.id}:${file.path}:${stat.size}:${stat.mtimeMs}` : `${file.id}:${file.path}:missing`;
    if (cache.has(cacheKey)) {
      const cached = cache.get(cacheKey);
      cache.delete(cacheKey);
      cache.set(cacheKey, cached);
      return cached;
    }

    const result = stat ? probe(file) : null;
    cache.set(cacheKey, result);
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
    const inflightKey = `${file.id}:${file.path}`;
    const active = asyncInflight.get(inflightKey);
    if (active) return active;

    const task = loadProbeAsync(file);
    asyncInflight.set(inflightKey, task);
    task.then(
      () => asyncInflight.delete(inflightKey),
      () => asyncInflight.delete(inflightKey)
    );
    return task;
  }

  async function loadProbeAsync(file) {
    let stat = null;
    try {
      stat = await statFile(file.path);
    } catch {
      stat = null;
    }
    const cacheKey = stat ? `${file.id}:${file.path}:${stat.size}:${stat.mtimeMs}` : `${file.id}:${file.path}:missing`;
    if (cache.has(cacheKey)) {
      const cached = cache.get(cacheKey);
      cache.delete(cacheKey);
      cache.set(cacheKey, cached);
      return cached;
    }

    const result = stat ? await probeAsync(file) : null;
    cache.set(cacheKey, result);
    if (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
    return result;
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
    clearCache: () => cache.clear(),
    playInfoForFile,
    playInfoForFileAsync,
    probe,
    probeAsync,
    probeCachedAsync,
    probeCached
  };
}
