import { spawnSync } from "node:child_process";

export const DEFAULT_MAX_COVER_BYTES = 8 * 1024 * 1024;

export function coverSeekSeconds(duration) {
  const seconds = Number(duration || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return 8;
  if (seconds < 20) return Math.max(0.1, Math.min(seconds * 0.5, Math.max(0.1, seconds - 0.25)));
  return Math.floor(Math.min(180, Math.max(8, seconds * 0.08)));
}

export function probeVideoDuration(filePath, options = {}) {
  const ffprobePath = options.ffprobePath || "ffprobe";
  const result = spawnSync(
    ffprobePath,
    ["-v", "error", "-show_entries", "format=duration", "-of", "json", filePath],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: options.timeoutMs || 15000
    }
  );
  if (result.error || result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout || "{}");
    const duration = Number(parsed.format?.duration);
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch {
    return null;
  }
}

export function extractCoverFrame(filePath, options = {}) {
  const ffmpegPath = options.ffmpegPath || "ffmpeg";
  const maxBytes = options.maxBytes || DEFAULT_MAX_COVER_BYTES;
  const duration = options.duration ?? probeVideoDuration(filePath, options);
  const seek = coverSeekSeconds(duration);
  const args = ["-hide_banner", "-loglevel", "error"];
  if (seek > 0) args.push("-ss", String(seek));
  args.push("-i", filePath, "-map", "0:v:0", "-frames:v", "1", "-q:v", "3", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1");

  const result = spawnSync(ffmpegPath, args, {
    windowsHide: true,
    maxBuffer: maxBytes,
    timeout: options.timeoutMs || 30000
  });

  if (result.error) {
    throw new Error(result.error.code === "ENOBUFS" ? "生成的封面超过大小限制" : `FFmpeg 启动失败：${result.error.message}`);
  }
  if (result.status !== 0 || !result.stdout?.length) {
    const detail = String(result.stderr || "").trim();
    throw new Error(detail ? `FFmpeg 抽帧失败：${detail}` : "FFmpeg 抽帧失败");
  }
  if (result.stdout.length > maxBytes) {
    throw new Error("生成的封面超过大小限制");
  }
  if (result.stdout[0] !== 0xff || result.stdout[1] !== 0xd8) {
    throw new Error("FFmpeg 没有生成有效的 JPEG 封面");
  }
  return result.stdout;
}
