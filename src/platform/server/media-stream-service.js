import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const TRANSCODE_MAX_EDGE = 4096;

export function createMediaStreamService({
  decodeInfoBuffer,
  ffmpegPath,
  hasNvenc,
  isSubtitleLikeInfoText,
  maxInfoBytes,
  notFound,
  parseInfoMetadata,
  safeStat,
  sendJson,
  serveRangedFile,
  spawnProcess = spawn,
  warn = console.warn,
  concurrency = 2,
  capacity = 16,
  queueTimeoutMs = 10000,
  startupTimeoutMs = 15000,
  childCloseTimeoutMs = 1500
}) {
  concurrency = boundedInteger(concurrency, 2, 1, 16);
  capacity = boundedInteger(capacity, 16, concurrency, 512);
  queueTimeoutMs = boundedInteger(queueTimeoutMs, 10000, 1, 600000);
  startupTimeoutMs = boundedInteger(startupTimeoutMs, 15000, 1, 600000);
  childCloseTimeoutMs = boundedInteger(childCloseTimeoutMs, 1500, 1, 60000);
  const jobs = new Set();
  const queue = [];
  let accepting = true;
  let generation = 0;
  let pumping = false;
  let stopTask = null;

  function serveVideo(req, res, file, options) {
    return serveRangedFile(req, res, file, options);
  }

  function serveTranscodedVideo(req, res, file, url) {
    if (req.aborted || res.destroyed || res.writableEnded) return;
    if (!accepting) {
      rejectRequest(res, "视频转码服务正在停止", "TRANSCODE_STOPPED");
      return;
    }
    if (jobs.size >= capacity) {
      rejectRequest(res, "视频转码任务繁忙，请稍后重试", "TRANSCODE_BUSY");
      return;
    }
    const stat = safeStat(file.path);
    if (!stat) {
      notFound(res);
      return;
    }
    if (req.method === "HEAD") {
      res.writeHead(200, videoHeaders());
      res.end();
      return;
    }

    const job = { req, res, file, url, started: false, closed: false, responseDone: false, failureHandled: false, outputStarted: false, stdoutEnded: false, killRequested: false, closeUnconfirmed: false, stderrText: "", loggedBytes: 0 };
    job.closedPromise = new Promise((resolve) => { job.resolveClosed = resolve; });
    job.onResponseClose = () => {
      job.responseDone = true;
      if (!job.failureHandled) {
        job.failureHandled = true;
        removeQueued(job);
        cancelChild(job);
      }
      dispose(job);
    };
    job.onResponseFinish = () => {
      job.responseDone = true;
      // Only our successful close+EOF path may finish an active response.
      if (!job.closed) cancelChild(job);
      dispose(job);
    };
    job.onResponseError = (error) => failJob(job, "视频转码失败", error);
    job.onRequestAbort = () => {
      if (!res.destroyed) res.destroy();
      job.onResponseClose();
    };
    res.on("close", job.onResponseClose);
    res.on("finish", job.onResponseFinish);
    res.on("error", job.onResponseError);
    req.on?.("aborted", job.onRequestAbort);
    jobs.add(job);
    queue.push(job);
    job.queueTimer = setTimeout(() => failJob(job, "等待视频转码超时，请稍后重试", transcodeError("TRANSCODE_BUSY"), 503), queueTimeoutMs);
    job.queueTimer.unref?.();
    pump();
  }

  function launch(job) {
    const { req, res, file, url } = job;
    job.started = true;
    clearTimeout(job.queueTimer);
    if (req.aborted || res.destroyed || res.writableEnded) {
      job.closed = true;
      job.resolveClosed();
      job.onResponseClose();
      return;
    }

    const mode = url.searchParams.get("mode") === "remux" ? "remux" : "transcode";
    const audio = url.searchParams.get("audio") === "copy" ? "copy" : "aac";
    const startAt = Math.max(0, Number(url.searchParams.get("t") || 0) || 0);
    const args = ["-hide_banner", "-loglevel", "error", "-fflags", "+genpts"];
    if (startAt > 0) args.push("-ss", String(Math.floor(startAt)));
    args.push("-i", file.path, "-map", "0:v:0?", "-map", "0:a:0?", "-sn", "-dn");

    if (mode === "remux") {
      args.push("-c:v", "copy", "-c:a", audio === "copy" ? "copy" : "aac", "-b:a", "160k");
    } else {
      args.push(
        "-vf",
        `scale=w='min(iw,${TRANSCODE_MAX_EDGE})':h='min(ih,${TRANSCODE_MAX_EDGE})':force_original_aspect_ratio=decrease:force_divisible_by=2`
      );
      if (hasNvenc) {
        args.push("-c:v", "h264_nvenc", "-preset", "p4", "-cq", "24", "-pix_fmt", "yuv420p");
      } else {
        args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p");
      }
      args.push("-c:a", "aac", "-b:a", "160k");
    }

    args.push(
      "-map_metadata", "-1",
      "-max_muxing_queue_size", "1024",
      "-avoid_negative_ts", "make_zero",
      "-movflags", "frag_keyframe+empty_moov+default_base_moof",
      "-f", "mp4",
      "pipe:1"
    );

    let child;
    try {
      child = spawnProcess(ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      job.closed = true;
      job.resolveClosed();
      failJob(job, "FFmpeg 启动失败", error);
      return;
    }
    job.child = child;
    job.onFirstData = (chunk) => {
      if (job.failureHandled || res.destroyed || res.writableEnded) return;
      job.outputStarted = true;
      clearTimeout(job.startupTimer);
      try {
        res.writeHead(200, videoHeaders());
        if (res.write(chunk)) pipeOutput(job);
        else {
          child.stdout.pause();
          job.onDrain = () => { job.onDrain = null; pipeOutput(job); };
          res.once("drain", job.onDrain);
        }
      } catch (error) { failJob(job, "视频转码失败", error); }
    };
    job.onStdoutEnd = () => {
      job.stdoutEnded = true;
      if (!job.closed && !job.failureHandled) {
        job.eofTimer = setTimeout(() => failJob(job, "视频转码失败", transcodeError("TRANSCODE_EXIT_TIMEOUT")), childCloseTimeoutMs);
        job.eofTimer.unref?.();
      }
      finishSuccess(job);
    };
    job.onStdoutClose = () => {
      if (!job.stdoutEnded && !job.failureHandled) failJob(job, "视频转码失败", transcodeError("TRANSCODE_OUTPUT_CLOSED"));
    };
    job.onPipeError = (error) => failJob(job, "视频转码失败", error);
    job.onStderrData = (chunk) => {
      const text = String(chunk || "").trim();
      if (!text) return;
      job.stderrText = `${job.stderrText}\n${text}`.trim().slice(-2000);
      // Retain the latest diagnostic without allowing a noisy child to flood logs.
      const logged = text.slice(0, Math.max(0, 8000 - job.loggedBytes));
      job.loggedBytes += logged.length;
      if (logged) warn("[ffmpeg]", logged);
    };
    job.onChildError = (error) => {
      warn("[ffmpeg]", error.message);
      failJob(job, "FFmpeg 启动失败", error);
    };
    job.onChildClose = (code, signal) => {
      if (job.closed) return;
      job.closed = true;
      job.exitCode = code;
      job.resolveClosed();
      clearTimeout(job.closeTimer);
      clearTimeout(job.eofTimer);
      clearTimeout(job.startupTimer);
      if (!job.failureHandled && (code !== 0 || signal || !job.outputStarted)) {
        const detail = job.stderrText ? `: ${job.stderrText.split(/\r?\n/).at(-1)}` : "";
        failJob(job, "视频转码失败", new Error(`FFmpeg exited (code ${code}, signal ${signal || "none"})${detail}`));
      }
      finishSuccess(job);
      dispose(job);
      pump();
    };
    child.stdout.once("data", job.onFirstData);
    child.stdout.on("end", job.onStdoutEnd);
    child.stdout.on("close", job.onStdoutClose);
    child.stdout.on("error", job.onPipeError);
    child.stderr.on("data", job.onStderrData);
    child.stderr.on("error", job.onPipeError);
    child.on("error", job.onChildError);
    child.on("close", job.onChildClose);
    job.startupTimer = setTimeout(() => failJob(job, "视频转码启动超时", transcodeError("TRANSCODE_START_TIMEOUT"), 504), startupTimeoutMs);
    job.startupTimer.unref?.();
  }

  function pipeOutput(job) {
    if (!job.failureHandled && !job.res.destroyed && !job.res.writableEnded) job.child.stdout.pipe(job.res, { end: false });
  }

  function finishSuccess(job) {
    if (job.closed && job.exitCode === 0 && job.stdoutEnded && job.outputStarted && !job.failureHandled && !job.res.destroyed && !job.res.writableEnded) job.res.end();
  }

  function rejectRequest(res, message, code) {
    res.setHeader?.("Retry-After", "1");
    sendJson(res, 503, { error: message, code });
  }

  function failJob(job, message, error, status = 500) {
    if (job.failureHandled) return;
    job.failureHandled = true;
    clearTimeout(job.queueTimer);
    clearTimeout(job.startupTimer);
    clearTimeout(job.eofTimer);
    removeQueued(job);
    if (job.onDrain) { job.res.off("drain", job.onDrain); job.onDrain = null; }
    job.child?.stdout.off("data", job.onFirstData);
    job.child?.stdout.unpipe(job.res);
    job.child?.stdout.resume();
    cancelChild(job);
    if (!job.res.headersSent && !job.res.destroyed && !job.res.writableEnded) {
      sendJson(job.res, status, { error: message, ...(error?.code ? { code: error.code } : {}) });
    } else if (!job.res.destroyed && !job.res.writableEnded) job.res.destroy(error);
    dispose(job);
  }

  function cancelChild(job) {
    if (!job.child || job.closed || job.killRequested) return;
    job.killRequested = true;
    if (job.onDrain) { job.res.off("drain", job.onDrain); job.onDrain = null; }
    job.child.stdout.off("data", job.onFirstData);
    job.child.stdout.unpipe(job.res);
    job.child.stdout.resume();
    try { job.child.kill("SIGKILL"); } catch (error) { warn("[ffmpeg:kill]", error.message); }
    if (job.closed) return;
    job.closeTimer = setTimeout(() => {
      if (job.closed) return;
      job.closeUnconfirmed = true;
      beginStop();
    }, childCloseTimeoutMs);
    job.closeTimer.unref?.();
  }

  function removeQueued(job) {
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
  }

  function dispose(job) {
    if (!job.responseDone || (job.started && !job.closed)) return;
    jobs.delete(job);
    removeQueued(job);
    for (const timer of [job.queueTimer, job.startupTimer, job.eofTimer, job.closeTimer]) clearTimeout(timer);
    job.req.off?.("aborted", job.onRequestAbort);
    job.res.off("close", job.onResponseClose);
    job.res.off("finish", job.onResponseFinish);
    job.res.off("error", job.onResponseError);
    if (job.onDrain) job.res.off("drain", job.onDrain);
    if (job.child) {
      job.child.stdout.off("data", job.onFirstData);
      job.child.stdout.off("end", job.onStdoutEnd);
      job.child.stdout.off("close", job.onStdoutClose);
      job.child.stdout.off("error", job.onPipeError);
      job.child.stderr.off("data", job.onStderrData);
      job.child.stderr.off("error", job.onPipeError);
      job.child.off("error", job.onChildError);
      job.child.off("close", job.onChildClose);
    }
    pump();
  }

  function activeCount() { return [...jobs].filter((job) => job.started && !job.closed).length; }

  function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (accepting && activeCount() < concurrency && queue.length) launch(queue.shift());
    } finally { pumping = false; }
  }

  function beginStop() {
    generation++;
    accepting = false;
    for (const job of [...jobs]) failJob(job, "视频转码服务正在停止", transcodeError("TRANSCODE_STOPPED"), 503);
  }

  function stop() {
    if (stopTask) return stopTask;
    beginStop();
    const owners = [...jobs].filter((job) => job.started && !job.closed);
    stopTask = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(transcodeError("TRANSCODE_CLOSE_UNCONFIRMED")), childCloseTimeoutMs);
      Promise.all(owners.map((job) => job.closedPromise)).then(() => { clearTimeout(timer); resolve(); });
    });
    return stopTask;
  }

  async function start() {
    const intent = generation;
    if (stopTask) {
      try { await stopTask; } catch (error) { if (activeCount()) throw error; }
    }
    if (intent !== generation) throw transcodeError("TRANSCODE_STOPPED");
    if ([...jobs].some((job) => job.killRequested && !job.closed)) throw transcodeError("TRANSCODE_CLOSE_UNCONFIRMED");
    stopTask = null;
    accepting = true;
    pump();
  }

  function serveInfo(res, file) {
    const stat = safeStat(file.path);
    if (!stat) {
      notFound(res);
      return;
    }

    if (stat.size > maxInfoBytes) {
      sendJson(res, 413, { error: "资料文件太大，已跳过预览。", size: stat.size });
      return;
    }

    const buffer = fs.readFileSync(file.path);
    const content = decodeInfoBuffer(buffer);
    let metadata = null;
    if (!isSubtitleLikeInfoText(content)) {
      try {
        metadata = parseInfoMetadata(content, {
          title: "",
          fileName: file.name || "",
          directoryName: path.basename(path.dirname(file.relativePath || file.path || ""))
        });
      } catch {
        metadata = null;
      }
    }
    sendJson(res, 200, {
      id: file.id,
      name: file.name,
      ext: file.ext,
      size: file.size,
      relativePath: file.relativePath,
      content,
      metadata
    });
  }

  return {
    start,
    beginStop,
    stop,
    diagnostics: () => ({ accepting, active: activeCount(), queued: queue.length, jobs: jobs.size, closing: [...jobs].filter((job) => job.killRequested && !job.closed).length, unconfirmedClose: [...jobs].some((job) => job.closeUnconfirmed && !job.closed), concurrency, capacity }),
    serveInfo,
    serveTranscodedVideo,
    serveVideo
  };
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Math.max(minimum, Math.min(maximum, Number.isFinite(number) ? Math.floor(number) : fallback));
}

function transcodeError(code) { return Object.assign(new Error(code), { code }); }

function videoHeaders() {
  return { "Content-Type": "video/mp4", "Cache-Control": "no-store", "Content-Disposition": "inline" };
}
