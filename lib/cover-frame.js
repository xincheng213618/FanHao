import { spawn, spawnSync } from "node:child_process";

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

export async function extractCoverFrameAsync(filePath, options = {}) {
  const ffmpegPath = options.ffmpegPath || "ffmpeg";
  const maxBytes = options.maxBytes || DEFAULT_MAX_COVER_BYTES;
  const duration = options.duration ?? probeVideoDuration(filePath, options);
  const seek = coverSeekSeconds(duration);
  const args = ["-hide_banner", "-loglevel", "error"];
  if (seek > 0) args.push("-ss", String(seek));
  args.push("-i", filePath, "-map", "0:v:0", "-frames:v", "1", "-q:v", "3", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1");

  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let timedOut = false;
    let tooLarge = false;
    let settled = false;

    function fail(error) {
      if (settled) return;
      settled = true;
      reject(error);
    }

    let child;
    try {
      child = spawn(ffmpegPath, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      fail(new Error(`FFmpeg 启动失败：${error.message}`));
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {}
    }, options.timeoutMs || 30000);

    child.stdout.on("data", (chunk) => {
      if (tooLarge) return;
      stdoutLength += chunk.length;
      if (stdoutLength > maxBytes) {
        tooLarge = true;
        try {
          child.kill();
        } catch {}
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrLength += chunk.length;
      if (stderrLength <= 65536) stderr.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      fail(new Error(error.code === "ENOENT" ? `FFmpeg 启动失败：${error.message}` : error.message));
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      if (settled) return;
      if (timedOut) {
        fail(new Error("FFmpeg 抽帧超时"));
        return;
      }
      if (tooLarge) {
        fail(new Error("生成的封面超过大小限制"));
        return;
      }
      const output = Buffer.concat(stdout, stdoutLength);
      if (status !== 0 || !output.length) {
        const detail = Buffer.concat(stderr, stderrLength).toString("utf8").trim();
        fail(new Error(detail ? `FFmpeg 抽帧失败：${detail}` : "FFmpeg 抽帧失败"));
        return;
      }
      if (output[0] !== 0xff || output[1] !== 0xd8) {
        fail(new Error("FFmpeg 没有生成有效的 JPEG 封面"));
        return;
      }
      settled = true;
      resolve(output);
    });
  });
}
