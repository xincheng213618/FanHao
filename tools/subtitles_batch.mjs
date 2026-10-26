import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createSubtitleService } from "../src/modules/fanhao/server/playback/subtitle-service.js";
import { createSubtitlecatProvider } from "../src/modules/fanhao/server/playback/subtitlecat-provider.js";
import { hasChineseFilename, looksChineseSubtitle, chooseChineseCandidates, workQuery } from "../lib/subtitle-batch-policy.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const chinese = value => /^zh(?:-|$)/i.test(String(value || ""));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fingerprint = video => JSON.stringify([video.path, video.name, video.size, video.modifiedAt]);

export function readMarkedWorks(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 3000");
    const rows = db.prepare(`SELECT lw.work_id AS id, lw.local_path AS location FROM local_works lw
      WHERE EXISTS(SELECT 1 FROM local_files f WHERE f.local_work_id=lw.id AND f.file_type='video') ORDER BY lw.work_id`).all();
    return [...new Set(rows.filter(row => /^\[A\]/i.test(path.win32.basename(String(row.location).replaceAll("/", "\\")).trim())).map(row => String(row.id)))];
  } finally { db.close(); }
}

export async function probeChineseTracks(videoPath, { signal, timeoutMs = 8000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-select_streams", "s", "-show_entries", "stream=index:stream_tags=language,title", "-of", "json", videoPath], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", overflow = false, timedOut = false, spawnError;
    const cancel = () => child.kill();
    const timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", chunk => { if (output.length + chunk.length > 128 * 1024) { overflow = true; cancel(); } else output += chunk; });
    child.stderr.resume();
    child.on("error", error => { spawnError = error; });
    child.once("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", cancel);
      if (signal?.aborted) { reject(signal.reason); return; }
      if (spawnError || timedOut || overflow || code !== 0) { reject(Object.assign(new Error("无法确认视频内嵌字幕"), { code: "SUBTITLE_PROBE_FAILED" })); return; }
      try {
        const streams = JSON.parse(output).streams || [];
        resolve(streams.some(stream => /^(?:zh(?:[-_]|$)|zho$|chi$)/i.test(stream.tags?.language || "") || /中文|简体|繁体|簡體|繁體|chinese/i.test(stream.tags?.title || "")));
      } catch { reject(new Error("视频字幕探测结果无效")); }
    });
  });
}

export async function processVideo(work, video, { service, provider, signal, execute = false,
  probe = probeChineseTracks, verifySaved = async () => true, beforeWrite = async () => true, networkDelayMs = 500 } = {}) {
  const base = { workId: String(work.id), videoId: String(video.id), code: workQuery(video, work) };
  const done = (status, extra = {}) => ({ ...base, status, ...extra });
  signal?.throwIfAborted();
  if (!(work.localMarkers || []).includes("A")) return done("not_marked");
  if (!video.path || !fs.statSync(video.path, { throwIfNoEntry: false })?.isFile()) return done("offline");
  if (hasChineseFilename(video, work)) return done("existing_chinese_filename");
  const listing = await service.list(work.id, video.id, { signal });
  for (const track of listing.tracks || []) {
    if (!chinese(track.language) && track.language !== "und") continue;
    const manualInFolder = track.match === "manual" && work.videos.length === 1 && !workQuery({ name: track.name })
      && (work.infos || []).some(file => file.name === track.name && (file.path || file.sourcePath)
        && path.resolve(path.dirname(file.path || file.sourcePath)) === path.resolve(path.dirname(video.path)));
    if (track.match === "manual" && !manualInFolder) continue;
    try {
      const content = await service.content(work.id, video.id, track.id, { signal });
      if (chinese(track.language) || looksChineseSubtitle(content.bytes.toString("utf8"))) return done(manualInFolder ? "suspected_existing_chinese_manual" : "existing_chinese_subtitle", { trackId: track.id });
    } catch (error) { if (signal?.aborted) throw error; }
  }
  try { if (await probe(video.path, { signal })) return done("existing_chinese_embedded"); }
  catch (error) { if (signal?.aborted) throw error; return done("probe_failed", { error: error.message }); }
  if (!base.code) return done("no_code");
  if (!execute) return done("needs_search");
  await delay(networkDelayMs); signal?.throwIfAborted();
  const search = await service.search(work.id, video.id, base.code, { signal });
  if (!search.results.length) return done("no_result");
  const languages = new Map();
  for (const result of search.results) {
    await delay(networkDelayMs); signal?.throwIfAborted();
    languages.set(result.id, await service.files(work.id, video.id, result.id, { signal }));
  }
  const candidates = chooseChineseCandidates(video, work.videos, search.results, languages);
  if (!candidates.length) {
    const available = [...languages.values()].some(result => result.files?.some(file => chinese(file.languageCode || file.language)));
    return done(available ? "ambiguous_version" : "no_chinese_download");
  }
  const failures = [];
  for (const candidate of candidates) {
    try {
      if (!await beforeWrite(work, video)) return done("changed_during_search");
      // Re-check after network waits so a manual import or another run is not overwritten.
      const latest = await service.list(work.id, video.id, { signal });
      for (const track of latest.tracks.filter(track => chinese(track.language) && track.match !== "manual")) {
        try { await service.content(work.id, video.id, track.id, { signal }); return done("existing_chinese_subtitle", { trackId: track.id }); }
        catch (error) { if (signal?.aborted) throw error; }
      }
      await delay(networkDelayMs); signal?.throwIfAborted();
      const result = await service.download(work.id, { videoId: video.id, resultId: candidate.result.id, fileId: candidate.file.id }, { signal });
      const content = await service.content(work.id, video.id, result.track.id, { signal });
      if (!looksChineseSubtitle(content.bytes.toString("utf8"))) throw new Error("下载内容未通过中文正文检查");
      if (!await verifySaved(work, video, result)) throw new Error("播放器未确认保存的字幕");
      return done("downloaded", { trackId: result.track.id, name: result.track.name, language: result.track.language, sidecarName: result.sidecarName, resultId: candidate.result.id });
    } catch (error) {
      if (signal?.aborted) throw error;
      failures.push({ code: error.code, error: error.message });
      if (error.statusCode === 429 || /STOP|CACHE_UNSAFE|EXISTS|CHANGED/.test(error.code || "")) break;
    }
  }
  return done("download_failed", { failures });
}

export async function runBatch({ dbPath, origin, output, execute = false, limit = Infinity, offset = 0, reverse = false, retryFrom = "", signal } = {}) {
  if (execute) throw Object.assign(new Error("已停用批量字幕下载，请在播放器中搜索并手动选择字幕。"), { code: "SUBTITLE_MANUAL_DOWNLOAD_ONLY" });
  const address = new URL(origin);
  if (address.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(address.hostname) || address.username || address.password || address.pathname !== "/") throw new Error("批处理仅连接本机 FanHao 服务");
  let ids = readMarkedWorks(dbPath);
  if (retryFrom) {
    const previous = JSON.parse(await fsp.readFile(path.join(retryFrom, "manifest.json"), "utf8"));
    if (previous.scope !== "A") throw new Error("重试批次范围无效");
    const retryStatuses = new Set(["error", "work_failed", "download_failed", "probe_failed"]);
    const rows = (await fsp.readFile(path.join(retryFrom, "records.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
    const wanted = new Set(rows.filter(row => retryStatuses.has(row.status) && previous.workIds.includes(String(row.workId))).map(row => String(row.workId)));
    ids = ids.filter(id => wanted.has(id));
  }
  ids = ids.slice(offset, Number.isFinite(limit) ? offset + limit : undefined);
  if (reverse) ids.reverse();
  await fsp.mkdir(path.dirname(output), { recursive: true });
  await fsp.mkdir(output);
  const manifest = { version: 1, scope: "A", execute, startedAt: new Date().toISOString(), workIds: ids, status: "running", ...(retryFrom ? { retryFrom: path.resolve(retryFrom) } : {}) };
  await fsp.writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
  const works = new Map(), roots = [];
  const fetchWork = async id => {
    const response = await fetch(new URL(`/api/works/${encodeURIComponent(id)}`, address), { signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(15000)]), redirect: "error" });
    if (!response.ok) throw Object.assign(new Error(`作品读取失败 HTTP ${response.status}`), { statusCode: response.status });
    const { work } = await response.json();
    for (const type of ["videos", "infos"]) work[type] = (work[type] || []).map(file => ({ ...file, path: file.sourcePath }));
    return work;
  };
  const provider = createSubtitlecatProvider({ maxDownloadBytes: 2 * 1024 * 1024, concurrency: 1 });
  const guarded = { ...provider, download: async (...args) => {
    const file = await provider.download(...args);
    if (!chinese(file.languageCode || file.language) || !looksChineseSubtitle(file.bytes)) throw Object.assign(new Error("来源未提供可确认的中文字幕正文"), { code: "SUBTITLE_NOT_CHINESE", statusCode: 422 });
    return file;
  } };
  const service = createSubtitleService({ cacheDir: path.join(ROOT, "data", "subtitles"), roots, resolveWork: id => works.get(String(id)), provider: guarded });
  const records = [];
  const record = async value => {
    records.push({ ...value, finishedAt: new Date().toISOString() });
    await fsp.appendFile(path.join(output, "records.jsonl"), JSON.stringify(records.at(-1)) + "\n");
    const counts = {};
    for (const row of records) counts[row.status] = (counts[row.status] || 0) + 1;
    const status = { ...manifest, processedWorks: new Set(records.map(row => row.workId)).size, totalWorks: ids.length, processedVideos: records.length, counts, updatedAt: new Date().toISOString() };
    await fsp.writeFile(path.join(output, "status.tmp"), JSON.stringify(status, null, 2));
    await fsp.rename(path.join(output, "status.tmp"), path.join(output, "status.json"));
    console.log(JSON.stringify({ workId: value.workId, code: value.code, status: value.status, progress: `${status.processedWorks}/${ids.length}` }));
  };
  try {
    for (const id of ids) {
      signal?.throwIfAborted();
      let work;
      try {
        work = await fetchWork(id);
        if (!(work.localMarkers || []).includes("A")) { await record({ workId: id, status: "not_marked" }); continue; }
        works.set(id, work);
        for (const file of [...work.videos, ...work.infos]) if (file.path && path.isAbsolute(file.path) && !roots.includes(path.dirname(file.path))) roots.push(path.dirname(file.path));
        if (!work.videos.length) await record({ workId: id, status: "no_video" });
      } catch (error) { await record({ workId: id, status: "work_failed", error: error.message }); continue; }
      for (const video of work.videos) {
        try {
          const result = await processVideo(work, video, { service, provider: guarded, signal, execute,
            beforeWrite: async () => {
              const current = await fetchWork(id);
              return current.localMarkers?.includes("A") && current.videos.some(item => item.id === video.id && fingerprint(item) === fingerprint(video));
            },
            verifySaved: async (_work, _video, saved) => {
              for (let attempt = 0; attempt < 4; attempt++) {
                const response = await fetch(new URL(`/api/works/${encodeURIComponent(id)}/subtitles?videoId=${encodeURIComponent(video.id)}`, address), { signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(15000)]) });
                const payload = await response.json();
                if (response.ok && payload.tracks?.some(track => track.name === saved.sidecarName || track.id === saved.track.id)) return true;
                await delay(500); signal?.throwIfAborted();
              }
              return false;
            }
          });
          await record(result);
        } catch (error) { if (signal?.aborted) throw error; await record({ workId: id, videoId: video.id, code: workQuery(video, work), status: "error", error: error.message, errorCode: error.code }); }
      }
      works.delete(id);
    }
    manifest.status = "complete";
  } catch (error) { manifest.status = signal?.aborted ? "cancelled" : "failed"; manifest.error = error.message; throw error; }
  finally {
    await service.stop();
    const counts = {}; for (const row of records) counts[row.status] = (counts[row.status] || 0) + 1;
    const summary = { ...manifest, finishedAt: new Date().toISOString(), totalWorks: ids.length, processedWorks: new Set(records.map(row => row.workId)).size, processedVideos: records.length, counts };
    await fsp.writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2));
    await fsp.writeFile(path.join(output, "status.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), switches = new Set(["--execute", "--reverse"]), allowed = new Set(["--db", "--origin", "--output", "--limit", "--offset", "--retry-from", ...switches]);
  for (let i = 0; i < args.length; i++) { if (!allowed.has(args[i])) throw new Error("未知参数：" + args[i]); if (!switches.has(args[i])) { if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error("缺少参数值"); i++; } }
  const value = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
  const limit = Number(value("--limit", Infinity)); if (!(limit > 0) || Number.isFinite(limit) && !Number.isSafeInteger(limit)) throw new Error("limit必须为正整数");
  const offset = Number(value("--offset", 0)); if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset必须为非负整数");
  const controller = new AbortController(); process.once("SIGINT", () => controller.abort(new Error("用户中止")));
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "");
  await runBatch({ dbPath: path.resolve(value("--db", path.join(ROOT, "data", "fanhao-core-v2.sqlite"))), origin: value("--origin", "http://127.0.0.1:29998"),
    output: path.resolve(value("--output", path.join(ROOT, "data", "subtitle-batches", `A-${stamp}`))), execute: args.includes("--execute"), retryFrom: value("--retry-from", ""), reverse: args.includes("--reverse"), offset, limit, signal: controller.signal });
}
