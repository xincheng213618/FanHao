import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

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
  warn = console.warn
}) {
  function serveVideo(req, res, file) {
    serveRangedFile(req, res, file);
  }

  function serveTranscodedVideo(req, res, file, url) {
    const stat = safeStat(file.path);
    if (!stat) {
      notFound(res);
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

    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Cache-Control": "no-store",
      "Content-Disposition": "inline"
    });

    const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(res);
    child.stderr.on("data", (chunk) => {
      const text = String(chunk || "").trim();
      if (text) warn("[ffmpeg]", text);
    });
    child.on("error", (error) => {
      warn("[ffmpeg]", error.message);
      if (!res.headersSent) sendJson(res, 500, { error: "FFmpeg 启动失败" });
      else res.destroy(error);
    });
    res.on("close", () => {
      if (!child.killed) child.kill("SIGKILL");
    });
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
    serveInfo,
    serveTranscodedVideo,
    serveVideo
  };
}
