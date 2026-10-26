import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { convertSubtitle, isSubtitleFile, matchSubtitleCandidates } from "../../../../../lib/subtitles.js";
import { extractWorkCodes } from "../../../../../lib/code-parser.js";
import { ensureRealPathWithinRoots } from "../../../../platform/server/library-path-safety.js";
import { createSubtitlecatProvider } from "./subtitlecat-provider.js";
import { writeSubtitleBesideVideo, discoverVideoSubtitles } from "./subtitle-sidecars.js";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_SAVED_TRACKS = 32;
const MAX_ACTIVE = 8;
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const failure = (message, statusCode = 400, code = "SUBTITLE_INVALID") => Object.assign(new Error(message), { statusCode, code });

export function createSubtitleService({ cacheDir, roots, resolveWork, resolveVideo = null,
  provider = createSubtitlecatProvider({ maxDownloadBytes: MAX_BYTES }), stopWaitMs = 10000 }) {
  const base = path.resolve(cacheDir);
  const controllers = new Set();
  const pending = new Set();
  const writes = new Map();
  let closing = false;

  function context(workId, videoId) {
    const work = resolveWork(String(workId));
    if (!work || work.missingLocal) throw failure("找不到本地作品", 404, "SUBTITLE_WORK_MISSING");
    const indexed = (work.videos || []).find((file) => String(file.id) === String(videoId));
    if (!indexed) throw failure("视频不属于当前作品", 404, "SUBTITLE_VIDEO_MISSING");
    const video = resolveVideo ? resolveVideo(String(indexed.id)) : indexed;
    if (!video || video.type && video.type !== "video") throw failure("视频记录不可用", 404, "SUBTITLE_VIDEO_MISSING");
    // Public video ids contain a sort index and can change after a rescan.
    const videoIdentity = digest(JSON.stringify([path.resolve(indexed.path || ""), indexed.name || "", Number(indexed.size || 0), indexed.modifiedAt || ""]));
    return { work, video, videoIdentity, directory: path.join(base, digest(String(work.id)), videoIdentity) };
  }

  function run(action, externalSignal) {
    if (closing) return Promise.reject(failure("字幕服务正在停止", 503, "SUBTITLE_STOPPING"));
    if (pending.size >= MAX_ACTIVE) return Promise.reject(failure("字幕请求较多，请稍后重试", 429, "SUBTITLE_BUSY"));
    const controller = new AbortController();
    const abort = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abort();
    else externalSignal?.addEventListener("abort", abort, { once: true });
    controllers.add(controller);
    const task = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return action(controller.signal); });
    pending.add(task);
    return task.finally(() => {
      pending.delete(task); controllers.delete(controller);
      externalSignal?.removeEventListener("abort", abort);
    });
  }

  async function checkedCacheDirectory(directory, create = false) {
    const relative = path.relative(base, directory);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw failure("字幕缓存路径无效");
    let current = base;
    const components = ["", ...relative.split(path.sep).filter(Boolean)];
    for (const part of components) {
      if (part) current = path.join(current, part);
      try {
        const stat = await fsp.lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure("字幕缓存目录不可用", 409, "SUBTITLE_CACHE_UNSAFE");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (!create) return false;
        try { await fsp.mkdir(current, { recursive: current === base }); }
        catch (mkdirError) { if (mkdirError.code !== "EEXIST") throw mkdirError; }
        const stat = await fsp.lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure("字幕缓存目录不可用", 409, "SUBTITLE_CACHE_UNSAFE");
      }
    }
    ensureRealPathWithinRoots(directory, [base], "字幕缓存");
    return true;
  }

  async function readFile(filePath, allowedRoots, signal, maxBytes = MAX_BYTES) {
    ensureRealPathWithinRoots(filePath, allowedRoots, "字幕文件");
    const handle = await fsp.open(filePath, "r");
    try {
      signal?.throwIfAborted();
      const stat = await handle.stat();
      if (!stat.isFile()) throw failure("字幕路径不是文件");
      if (stat.size > maxBytes) throw failure("字幕文件超过 2 MiB", 413, "SUBTITLE_TOO_LARGE");
      ensureRealPathWithinRoots(filePath, allowedRoots, "字幕文件");
      const current = await fsp.stat(filePath);
      if (current.dev !== stat.dev || current.ino !== stat.ino) throw failure("字幕文件已发生变化，请重试", 409);
      const buffer = Buffer.alloc(Math.min(maxBytes + 1, Number(stat.size) + 1));
      let offset = 0;
      while (offset < buffer.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || offset !== stat.size) throw failure("字幕文件已发生变化，请重试", 409);
      return buffer.subarray(0, offset);
    } finally { await handle.close(); }
  }

  async function savedTracks(ctx, signal) {
    if (!await checkedCacheDirectory(ctx.directory)) return [];
    const entries = (await fsp.readdir(ctx.directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)).slice(0, MAX_SAVED_TRACKS);
    const tracks = [];
    for (const entry of entries) {
      signal.throwIfAborted();
      try {
        const buffer = await readFile(path.join(ctx.directory, entry.name), [base], signal, 16 * 1024);
        const item = JSON.parse(buffer.toString("utf8"));
        if (item.workId !== String(ctx.work.id) || item.videoIdentity !== ctx.videoIdentity
          || !/^[a-f0-9]{64}\.(srt|ass|ssa|vtt)$/i.test(item.file) || item.file.split(".")[0] !== entry.name.slice(0, 64)
          || typeof item.name !== "string" || !["upload", "SubtitleCat"].includes(item.source)) continue;
        const stat = await fsp.lstat(path.join(ctx.directory, item.file));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) continue;
        tracks.push({ ...item, id: `cache:${entry.name.slice(0, 64)}`, path: path.join(ctx.directory, item.file), match: "exact" });
      } catch (error) { if (signal.aborted) throw error; }
    }
    return tracks;
  }

  async function tracksFor(ctx, signal) {
    const indexed = (ctx.work.infos || []).filter((file) => isSubtitleFile(file.name || file.path || ""));
    const discovered = await discoverVideoSubtitles(ctx.video, { roots, signal });
    const subtitles = [...new Map([...indexed, ...discovered].map(file => [path.resolve(file.path), file])).values()];
    const local = matchSubtitleCandidates(ctx.video, ctx.work.videos || [], subtitles)
      .map((item) => ({ ...item, ...item.file, id: `local:${Buffer.from(String(item.file.id)).toString("base64url")}`, source: "local", language: item.language || "und" }));
    const cached = (await savedTracks(ctx, signal)).filter(track => !track.sidecarName || !local.some(file => path.resolve(file.path) === path.resolve(path.dirname(ctx.video.path), track.sidecarName)));
    const tracks = [...local, ...cached];
    const preferred = tracks.filter((track) => /^zh(?:-|$)/i.test(track.language) && track.match !== "manual");
    return tracks.map((track) => ({ ...track, autoSelect: preferred.length === 1 && preferred[0] === track }));
  }

  function publicTrack(track, ctx) {
    const url = `/api/works/${encodeURIComponent(ctx.work.id)}/subtitles/tracks/${encodeURIComponent(track.id)}`;
    const query = `?videoId=${encodeURIComponent(ctx.video.id)}`;
    const label = track.label ? `${track.label} · ${track.name}` : `${track.source === "local" ? "本地" : track.source === "upload" ? "导入" : "下载"} · ${track.name}`;
    return { id: track.id, name: track.name, label, language: track.language || "und", format: path.extname(track.name).slice(1).toLowerCase(),
      match: track.match, autoSelect: Boolean(track.autoSelect), source: track.source, url: url + query, downloadUrl: url + "/download" + query };
  }

  async function listValue(ctx, signal) {
    const tracks = (await tracksFor(ctx, signal)).map((track) => publicTrack(track, ctx));
    return { workId: String(ctx.work.id), videoId: String(ctx.video.id), query: defaultQuery(ctx), tracks, maxUploadBytes: MAX_BYTES };
  }

  function list(workId, videoId, { signal } = {}) { return run((abort) => listValue(context(workId, videoId), abort), signal); }

  function content(workId, videoId, trackId, { signal, offsetSeconds = 0, download = false } = {}) {
    return run(async (abort) => {
      const ctx = context(workId, videoId);
      let track = (await tracksFor(ctx, abort)).find((item) => item.id === trackId);
      // A newly published sidecar can become visible between two SMB reads.
      // Keep previously returned cache URLs usable after the list deduplicates it.
      if (!track && trackId.startsWith("cache:")) track = (await savedTracks(ctx, abort)).find(item => item.id === trackId);
      if (!track) throw failure("字幕不存在或不属于当前视频", 404, "SUBTITLE_TRACK_MISSING");
      const bytes = await readFile(track.path, track.source === "local" ? roots : [base], abort);
      if (track.source !== "local" && digest(bytes) !== track.id.slice(6)) throw failure("字幕缓存内容校验失败", 409, "SUBTITLE_CACHE_CHANGED");
      if (download) return { bytes, name: track.name, contentType: "application/octet-stream" };
      const converted = convertSubtitle(bytes, { name: track.name, offsetSeconds });
      return { bytes: Buffer.from(converted.vtt), name: track.name.replace(/\.[^.]+$/, ".vtt"), contentType: "text/vtt; charset=utf-8", cueCount: converted.cueCount };
    }, signal);
  }

  function defaultQuery(ctx) {
    for (const value of [ctx.video.name, ctx.work.infoSummary?.code, ctx.work.code, ctx.work.directoryName]) {
      const code = extractWorkCodes(String(value || ""))[0];
      if (code) return code;
    }
    return "";
  }

  function queryFor(ctx, query) {
    const value = String(query || defaultQuery(ctx)).trim();
    if (!value) throw failure("没有识别出番号，请输入字幕搜索词");
    return value;
  }

  function search(workId, videoId, query, { signal } = {}) {
    return run((abort) => { const ctx = context(workId, videoId); return provider.search(queryFor(ctx, query), { signal: abort }); }, signal);
  }
  function files(workId, videoId, resultId, { signal } = {}) {
    return run((abort) => { context(workId, videoId); return provider.files(resultId, { signal: abort }); }, signal);
  }

  async function save(ctx, bytes, { name, source, language = "und", sourceUrl = "", sidecarName = "" }, signal) {
    if (!bytes.length || bytes.length > MAX_BYTES) throw failure("字幕为空或超过 2 MiB", 413, "SUBTITLE_TOO_LARGE");
    const basename = path.basename(String(name || "subtitle.srt").replaceAll("\\", "/")).replace(/[\x00-\x1f\x7f]/g, "");
    if (!isSubtitleFile(basename)) throw failure("请选择 SRT、ASS、SSA 或 VTT 字幕");
    const extension = path.extname(basename);
    const safeName = basename.length > 180 ? basename.slice(0, 180 - extension.length) + extension : basename;
    convertSubtitle(bytes, { name: safeName });
    const previous = writes.get(ctx.directory) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      signal.throwIfAborted();
      await checkedCacheDirectory(ctx.directory, true);
      const hash = digest(bytes), file = hash + path.extname(safeName).toLowerCase();
      const saved = await savedTracks(ctx, signal);
      const existing = saved.find((track) => track.id === `cache:${hash}`);
      if (existing) {
        if (digest(await readFile(existing.path, [base], signal)) !== hash) throw failure("字幕缓存内容校验失败", 409, "SUBTITLE_CACHE_CHANGED");
        if (!sidecarName || existing.sidecarName === sidecarName) {
          const result = await listValue(ctx, signal);
          return { ...result, track: result.tracks.find(track => track.id === existing.id || sidecarName && track.name === sidecarName), ...(sidecarName ? { sidecarName, savedBesideVideo: true } : {}) };
        }
      }
      if (!existing && saved.length >= MAX_SAVED_TRACKS) throw failure("当前视频已保存 32 条字幕，请使用已有字幕", 409, "SUBTITLE_CACHE_LIMIT");
      const destination = path.join(ctx.directory, file);
      const rawTemporary = path.join(ctx.directory, `${hash}.${crypto.randomUUID()}.raw.tmp`);
      try {
        await fsp.writeFile(rawTemporary, bytes, { flag: "wx", signal });
        signal.throwIfAborted();
        // Publish a complete file exclusively; an interrupted write never poisons a content hash.
        await fsp.link(rawTemporary, destination);
      }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        const stat = await fsp.lstat(destination);
        if (stat.isSymbolicLink() || !stat.isFile() || digest(await readFile(destination, [base], signal)) !== hash) throw failure("字幕缓存文件冲突", 409, "SUBTITLE_CACHE_UNSAFE");
      } finally { await fsp.unlink(rawTemporary).catch(() => {}); }
      const metadata = { workId: String(ctx.work.id), videoId: String(ctx.video.id), videoIdentity: ctx.videoIdentity, name: safeName, source, sourceUrl, sidecarName,
        language: /^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(language) ? language : "und", file };
      const temporary = path.join(ctx.directory, `${hash}.${crypto.randomUUID()}.tmp`);
      try {
        signal.throwIfAborted();
        await fsp.writeFile(temporary, JSON.stringify(metadata), { flag: "wx", signal });
        signal.throwIfAborted();
        await fsp.rename(temporary, path.join(ctx.directory, hash + ".json"));
      } finally { await fsp.unlink(temporary).catch(() => {}); }
      const result = await listValue(ctx, signal);
      return { ...result, track: result.tracks.find((track) => track.id === `cache:${hash}` || sidecarName && track.name === sidecarName), ...(sidecarName ? { sidecarName, savedBesideVideo: true } : {}) };
    });
    writes.set(ctx.directory, task);
    try { return await task; } finally { if (writes.get(ctx.directory) === task) writes.delete(ctx.directory); }
  }

  function upload(workId, body, { signal } = {}) {
    return run((abort) => {
      if (!body || typeof body !== "object" || Array.isArray(body)) throw failure("字幕请求格式无效");
      const ctx = context(workId, body.videoId);
      let bytes;
      if (typeof body.contentBase64 === "string") {
        if (body.contentBase64.length > Math.ceil(MAX_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.contentBase64)) throw failure("字幕文件编码无效或过大");
        bytes = Buffer.from(body.contentBase64, "base64");
      } else if (typeof body.text === "string") bytes = Buffer.from(body.text, "utf8");
      else throw failure("请选择字幕文件");
      return save(ctx, bytes, { name: body.name, source: "upload" }, abort);
    }, signal);
  }

  function download(workId, body, { signal } = {}) {
    return run(async (abort) => {
      if (!body || typeof body !== "object" || Array.isArray(body)) throw failure("字幕请求格式无效");
      const ctx = context(workId, body.videoId);
      const file = await provider.download(body.resultId, body.fileId, { signal: abort });
      const bytes = Buffer.from(file.bytes), language = file.languageCode || file.language || "und";
      convertSubtitle(bytes, { name: file.name });
      const sidecar = await writeSubtitleBesideVideo(ctx.video, bytes, { name: file.name, language, roots, signal: abort });
      return save(ctx, bytes, { name: sidecar.name, sidecarName: sidecar.name, source: "SubtitleCat", language, sourceUrl: file.sourceUrl }, abort);
    }, signal);
  }

  function beginStop() { closing = true; for (const controller of controllers) controller.abort(); provider.beginStop?.(); }
  async function stop() {
    beginStop();
    let timer;
    const drain = Promise.race([
      Promise.allSettled([...pending]),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(failure("字幕请求尚未完全停止", 503, "SUBTITLE_STOP_TIMEOUT")), stopWaitMs); })
    ]).finally(() => clearTimeout(timer));
    const results = await Promise.allSettled([drain, Promise.resolve().then(() => provider.stop?.())]);
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "字幕服务未能完全停止");
  }
  return { list, content, search, files, upload, download, beginStop, stop };
}
