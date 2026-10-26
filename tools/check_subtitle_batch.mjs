import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { looksChineseSubtitle, chooseChineseCandidates } from "../lib/subtitle-batch-policy.js";
import { ensureRealPathWithinRoots } from "../src/platform/server/library-path-safety.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("请指定批次回执目录");
const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json")));
if (manifest.scope !== "A" || !manifest.execute) throw new Error("仅校验已执行的 A 标记批次");
const started = Date.parse(manifest.startedAt);
const entries = [];
const works = new Map();
const origin = "http://127.0.0.1:29998";
for (const id of manifest.workIds) {
  const base = path.join(root, "data", "subtitles", crypto.createHash("sha256").update(String(id)).digest("hex"));
  if (!fs.existsSync(base) || !fs.lstatSync(base).isDirectory() || fs.lstatSync(base).isSymbolicLink()) continue;
  for (const videoHash of fs.readdirSync(base).filter(name => /^[a-f0-9]{64}$/.test(name))) {
    const cache = path.join(base, videoHash);
    if (!fs.lstatSync(cache).isDirectory() || fs.lstatSync(cache).isSymbolicLink()) continue;
    for (const file of fs.readdirSync(cache).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const metadataFile = path.join(cache, file), stat = fs.lstatSync(metadataFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || stat.mtimeMs < started) continue;
      const item = JSON.parse(fs.readFileSync(metadataFile));
      if (item.source !== "SubtitleCat" || item.workId !== String(id) || item.videoIdentity !== videoHash || typeof item.sidecarName !== "string" || path.basename(item.sidecarName) !== item.sidecarName || !/\.(?:srt|ass|ssa|vtt)$/i.test(item.sidecarName)) continue;
      const row = { workId: String(id), videoId: item.videoId, name: item.sidecarName, language: item.language, status: "unverified" };
      try {
        if (!works.has(id)) {
          const response = await fetch(`${origin}/api/works/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(15000) });
          if (!response.ok) throw new Error("当前作品不存在");
          works.set(id, (await response.json()).work);
        }
        const work = works.get(id);
        if (!work.localMarkers?.includes("A")) throw new Error("当前作品已无 A 标记");
        const video = work.videos.find(video => crypto.createHash("sha256").update(JSON.stringify([path.resolve(video.sourcePath || ""), video.name || "", Number(video.size || 0), video.modifiedAt || ""])).digest("hex") === videoHash);
        if (!video) throw new Error("当前视频身份已变化");
        row.videoId = video.id;
        const sourceName = decodeURIComponent(new URL(item.sourceUrl).pathname.split("/").at(-1));
        const sourceResult = { id: "audit", title: sourceName };
        const sourceFile = { id: "audit-file", name: sourceName, language: item.language };
        if (!chooseChineseCandidates(video, work.videos, [sourceResult], new Map([["audit", { files: [sourceFile] }]])).length) throw new Error("来源番号、版本或分卷需要人工确认");
        const destination = path.join(path.dirname(video.sourcePath), item.sidecarName);
        ensureRealPathWithinRoots(destination, [path.dirname(video.sourcePath)], "字幕校验");
        const subtitleStat = fs.lstatSync(destination);
        if (!subtitleStat.isFile() || subtitleStat.isSymbolicLink() || subtitleStat.size > 2097152) throw new Error("视频同目录字幕不安全或大小无效");
        const bytes = fs.readFileSync(destination);
        if (crypto.createHash("sha256").update(bytes).digest("hex") !== file.slice(0, 64)) throw new Error("字幕内容与下载回执不一致");
        if (!looksChineseSubtitle(bytes)) throw new Error("无法确认中文正文");
        const response = await fetch(`${origin}/api/works/${encodeURIComponent(id)}/subtitles?videoId=${encodeURIComponent(video.id)}`, { signal: AbortSignal.timeout(15000) });
        const tracks = await response.json();
        const track = tracks.tracks?.find(track => track.name === item.sidecarName && /^zh(?:-|$)/i.test(track.language));
        if (!response.ok || !track) throw new Error("播放器没有识别视频旁的中文字幕");
        const converted = await fetch(new URL(track.url, origin), { signal: AbortSignal.timeout(15000) });
        const vtt = await converted.text();
        if (!converted.ok || !looksChineseSubtitle(vtt)) throw new Error("播放器字幕转换未通过");
        row.status = "verified"; row.path = destination; row.bytes = bytes.length; row.cues = (vtt.match(/ --> /g) || []).length;
      } catch (error) { row.status = "failed"; row.error = error.message; }
      entries.push(row);
    }
  }
}
const status = JSON.parse(fs.readFileSync(path.join(directory, "status.json")));
const result = { batch: directory, batchStatus: status.status, checkedAt: new Date().toISOString(), scope: "A",
  checkedWorks: status.processedWorks, checkedVideos: status.processedVideos,
  verifiedNewFiles: entries.filter(row => row.status === "verified").length,
  coveredWorks: new Set(entries.filter(row => row.status === "verified").map(row => row.workId)).size,
  failed: entries.filter(row => row.status !== "verified").length, executionCounts: status.counts, entries };
fs.writeFileSync(path.join(directory, "verification.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, entries: undefined }));
if (result.failed) process.exitCode = 1;
