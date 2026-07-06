import { spawnSync } from "node:child_process";

export function createVideoProbeService({
  cacheLimit = 512,
  directVideoExts,
  ffprobePath,
  hasNvenc,
  safeStat,
  spawnSyncFn = spawnSync
}) {
  const cache = new Map();

  function probe(file) {
    try {
      const result = spawnSyncFn(
        ffprobePath,
        ["-v", "error", "-show_entries", "format=duration", "-show_streams", "-of", "json", file.path],
        { encoding: "utf8", windowsHide: true, timeout: 8000, maxBuffer: 2 * 1024 * 1024 }
      );
      if (result.status !== 0 || !result.stdout) return null;
      const data = JSON.parse(result.stdout);
      const video = (data.streams || []).find((stream) => stream.codec_type === "video") || {};
      const audio = (data.streams || []).find((stream) => stream.codec_type === "audio") || {};
      return {
        duration: Number(data.format?.duration || 0) || null,
        videoCodec: video.codec_name || "",
        audioCodec: audio.codec_name || "",
        width: video.width || null,
        height: video.height || null
      };
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

  function playInfoForFile(file, publicVideoId = file.id, options = {}) {
    const mediaProbe = probeCached(file) || {};
    const videoCodec = String(mediaProbe.videoCodec || "").toLowerCase();
    const audioCodec = String(mediaProbe.audioCodec || "").toLowerCase();
    const canDirect = directVideoExts.has(file.ext) && (!videoCodec || ["h264", "avc1", "hevc", "h265", "vp8", "vp9", "av1"].includes(videoCodec));
    const streamBase = options.streamBase || "/media/video";

    if (canDirect) {
      return {
        mode: "direct",
        label: "直连播放",
        streamUrl: `${streamBase}/${encodeURIComponent(publicVideoId)}`,
        duration: mediaProbe.duration || null,
        videoCodec,
        audioCodec,
        hasNvenc
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
      hasNvenc
    };
  }

  return {
    clearCache: () => cache.clear(),
    playInfoForFile,
    probe,
    probeCached
  };
}
