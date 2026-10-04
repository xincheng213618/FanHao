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
  const duration = options.duration ?? await probeVideoDurationAsync(filePath, options);
  const seek = coverSeekSeconds(duration);
  const args = ["-hide_banner", "-loglevel", "error"];
  if (seek > 0) args.push("-ss", String(seek));
  args.push("-i", filePath, "-map", "0:v:0", "-frames:v", "1");
  if (options.boxSize) args.push("-vf", `scale=${options.boxSize}:-2`);
  args.push("-q:v", String(options.quality ?? 3), "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1");

  const output = await runCoverProcess(ffmpegPath, args, {
    ...options, maxBytes, timeoutMs: options.timeoutMs || 30000, label: "FFmpeg", operation: "抽帧"
  });
  if (output[0] !== 0xff || output[1] !== 0xd8) throw new Error("FFmpeg 没有生成有效的 JPEG 封面");
  return output;
}

export async function probeVideoDurationAsync(filePath, options = {}) {
  let output;
  try {
    output = await runCoverProcess(options.ffprobePath || "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", filePath], {
      ...options, maxBytes: 256 * 1024, timeoutMs: options.probeTimeoutMs || options.timeoutMs || 15000, label: "FFprobe", operation: "探测"
    });
  } catch (error) {
    if (options.signal?.aborted || error.code === "COVER_TIMEOUT") throw error;
    return null; // Unavailable duration keeps the existing eight-second seek fallback.
  }
  try {
    const duration = Number(JSON.parse(output.toString("utf8")).format?.duration);
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch { return null; }
}

// A killed child still owns its concurrency slot until close confirms that its
// process and pipes have ended. Never settle on error/timeout/abort alone.
function runCoverProcess(executable, args, options) {
  if (options.signal?.aborted) return Promise.reject(new DOMException("生成封面已取消", "AbortError"));
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let failure = null;
    let terminating = false;

    let child;
    try {
      child = (options.spawnFn || spawn)(executable, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      reject(new Error(`${options.label} 启动失败：${error.message}`));
      return;
    }

    const terminate = (error) => {
      failure ||= error;
      if (terminating) return;
      terminating = true;
      try { child.kill("SIGKILL"); } catch {}
    };
    const abort = () => terminate(new DOMException("生成封面已取消", "AbortError"));
    const timer = setTimeout(() => {
      terminate(Object.assign(new Error(`${options.label} ${options.operation}超时`), { code: "COVER_TIMEOUT" }));
    }, options.timeoutMs);

    child.stdout.on("data", (chunk) => {
      if (failure) return;
      stdoutLength += chunk.length;
      if (stdoutLength > options.maxBytes) {
        terminate(new Error(options.label === "FFmpeg" ? "生成的封面超过大小限制" : "FFprobe 输出超过大小限制"));
        return;
      }
      stdout.push(chunk);
    });
    child.stdout.on("error", (error) => terminate(error));
    child.stderr.on("error", (error) => terminate(error));
    child.stderr.on("data", (chunk) => {
      const retained = chunk.subarray(0, Math.max(0, 65536 - stderrLength));
      if (retained.length) { stderrLength += retained.length; stderr.push(retained); }
    });
    child.on("error", (error) => {
      terminate(new Error(`${options.label} 启动失败：${error.message}`));
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (failure) { reject(failure); return; }
      const output = Buffer.concat(stdout, stdoutLength);
      if (status !== 0 || !output.length) {
        const detail = Buffer.concat(stderr, stderrLength).toString("utf8").trim();
        reject(new Error(detail ? `${options.label} ${options.operation}失败：${detail}` : `${options.label} ${options.operation}失败`));
        return;
      }
      resolve(output);
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
