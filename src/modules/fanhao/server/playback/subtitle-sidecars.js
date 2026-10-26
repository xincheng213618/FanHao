import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const MAX_BYTES = 2 * 1024 * 1024;
const EXTENSIONS = new Set([".srt", ".ass", ".ssa", ".vtt"]);
const LANGUAGES = ["zh-CN", "zh-TW", "en", "ja", "und"];
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const failure = (message, statusCode = 400, code = "SUBTITLE_SIDECAR_UNSAFE") => Object.assign(new Error(message), { statusCode, code });
const normalized = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const samePath = (a, b) => normalized(a) === normalized(b);
const inside = (candidate, root) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
};
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameVideo = (a, b) => sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
// Publishing/removing another hard link changes ctime without changing content.
const sameSubtitle = (a, b) => sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs;
const abort = signal => signal?.throwIfAborted();

function plainDirectory(directory, allowLink = false) {
  const stat = fs.lstatSync(directory, { bigint: true });
  const linked = stat.isSymbolicLink();
  if (linked && !allowLink || !linked && !stat.isDirectory()) {
    throw failure("字幕根目录经过链接或路径不是目录", 409);
  }
  const targetStat = linked ? fs.statSync(directory, { bigint: true }) : stat;
  if (!targetStat.isDirectory()) throw failure("字幕目录链接目标不是目录", 409);
  return { stat, targetStat, linked, canonical: fs.realpathSync.native(directory) };
}

// A drive mapping or an internal directory alias is safe only while every
// canonical target remains inside the confirmed root and retains its identity.
function authority(video, roots) {
  if (!video || typeof video.path !== "string" || !path.isAbsolute(video.path)) throw failure("视频路径无效");
  const videoPath = path.resolve(video.path);
  const directory = path.dirname(videoPath);
  const candidates = (Array.isArray(roots) ? roots : []).filter(root => typeof root === "string" && path.isAbsolute(root))
    .map(root => path.resolve(root)).filter(root => inside(videoPath, root));
  if (!candidates.length) throw failure("视频不在已确认的资料库根目录内");
  let directories;
  for (const root of candidates) {
    try {
      const chain = [root];
      const relative = path.relative(root, directory);
      for (const part of relative.split(path.sep).filter(Boolean)) chain.push(path.join(chain.at(-1), part));
      directories = [];
      for (const directoryPath of chain) {
        const allowLink = directories.length > 0;
        const item = { path: directoryPath, allowLink, ...plainDirectory(directoryPath, allowLink) };
        if (directories.length && !inside(item.canonical, directories[0].canonical)) throw failure("字幕目录的实际路径逃出资料库根目录", 409);
        directories.push(item);
      }
      break;
    } catch (error) {
      if (candidates.at(-1) === root) throw error;
    }
  }
  const stat = fs.lstatSync(videoPath, { bigint: true });
  const realVideo = fs.realpathSync.native(videoPath);
  const realRoot = directories[0].canonical;
  const realDirectory = directories.at(-1).canonical;
  if (!stat.isFile() || stat.isSymbolicLink() || !inside(realVideo, realRoot) || !samePath(path.dirname(realVideo), realDirectory)) {
    throw failure("视频不是已确认的普通文件", 409, "SUBTITLE_VIDEO_CHANGED");
  }
  if (video.size !== undefined && video.size !== null) {
    const size = Number(video.size);
    if (!Number.isSafeInteger(size) || size < 0 || BigInt(size) !== stat.size) throw failure("视频大小已变化，请重新扫描", 409, "SUBTITLE_VIDEO_CHANGED");
  }
  return { videoPath, directory, directories, stat, realVideo, realRoot, realDirectory };
}

function recheckDirectories(ctx) {
  for (const item of ctx.directories) {
    const current = plainDirectory(item.path, item.allowLink);
    if (item.linked !== current.linked || !sameIdentity(item.stat, current.stat) || !sameIdentity(item.targetStat, current.targetStat)
      || !samePath(item.canonical, current.canonical)
      || !inside(current.canonical, ctx.realRoot)) throw failure("视频目录或磁盘映射已发生变化", 409);
  }
}

function recheck(ctx) {
  recheckDirectories(ctx);
  const current = fs.lstatSync(ctx.videoPath, { bigint: true });
  if (!current.isFile() || current.isSymbolicLink() || !sameVideo(ctx.stat, current)
    || !samePath(fs.realpathSync.native(ctx.videoPath), ctx.realVideo)) throw failure("视频已发生变化，请重新扫描", 409, "SUBTITLE_VIDEO_CHANGED");
}

function canonicalLanguage(value) {
  if (typeof value !== "string" || !/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(value) || value.length > 63) {
    throw failure("字幕语言无效", 400, "SUBTITLE_LANGUAGE_INVALID");
  }
  if (value.toLowerCase() === "und") return "und";
  try { return Intl.getCanonicalLocales(value)[0]; }
  catch { throw failure("字幕语言无效", 400, "SUBTITLE_LANGUAGE_INVALID"); }
}

function sidecarName(videoPath, language, extension) {
  const basename = path.basename(videoPath);
  let stem = basename.slice(0, basename.length - path.extname(basename).length);
  const suffix = `.${language}${extension}`;
  if (stem.length + suffix.length > 255) {
    const hash = `~${digest(stem).slice(0, 12)}`;
    stem = stem.slice(0, 255 - suffix.length - hash.length).replace(/[\uD800-\uDBFF]$/, "") + hash;
  }
  if (!stem) throw failure("视频文件名无效");
  return stem + suffix;
}

function checkedFile(filePath, ctx) {
  recheck(ctx);
  const stat = fs.lstatSync(filePath, { bigint: true });
  const realFile = fs.realpathSync.native(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || !inside(realFile, ctx.realRoot)
    || !samePath(realFile, path.join(ctx.realDirectory, path.basename(filePath)))) {
    throw failure("字幕目标不是普通文件", 409);
  }
  if (stat.size > BigInt(MAX_BYTES)) throw failure("字幕文件超过 2 MiB", 413, "SUBTITLE_TOO_LARGE");
  return stat;
}

async function sameContent(filePath, bytes, ctx, signal) {
  const before = checkedFile(filePath, ctx);
  if (before.size !== BigInt(bytes.length)) return false;
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    abort(signal);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameSubtitle(before, opened)) throw failure("字幕文件已发生变化", 409);
    const content = Buffer.alloc(bytes.length + 1);
    let position = 0;
    while (position < content.length) {
      abort(signal);
      const { bytesRead } = await handle.read(content, position, content.length - position, position);
      if (!bytesRead) break;
      position += bytesRead;
    }
    abort(signal);
    const after = await handle.stat({ bigint: true });
    const current = checkedFile(filePath, ctx);
    if (!sameSubtitle(opened, after) || !sameSubtitle(opened, current) || position !== bytes.length) throw failure("字幕文件已发生变化", 409);
    return bytes.equals(content.subarray(0, position));
  } finally { await handle.close(); }
}

export async function writeSubtitleBesideVideo(video, input, { language = "zh-CN", name = "", roots, signal } = {}) {
  abort(signal);
  if (!(input instanceof Uint8Array)) throw failure("字幕内容必须是字节数据", 400, "SUBTITLE_INVALID");
  if (input.byteLength > MAX_BYTES) throw failure("字幕文件超过 2 MiB", 413, "SUBTITLE_TOO_LARGE");
  if (!input.byteLength) throw failure("字幕文件为空", 422, "SUBTITLE_NO_CUES");
  const bytes = Buffer.from(input);
  const extension = name ? path.extname(String(name)).toLowerCase() : ".srt";
  if (!EXTENSIONS.has(extension)) throw failure("字幕格式不受支持", 415, "SUBTITLE_FORMAT");
  const ctx = authority(video, roots);
  const targetName = sidecarName(ctx.videoPath, canonicalLanguage(language), extension);
  const target = path.join(ctx.directory, targetName);
  const result = created => ({ path: target, name: targetName, created });
  const conflict = () => failure("同名字幕已存在且内容不同，未覆盖", 409, "SUBTITLE_SIDECAR_CONFLICT");
  try {
    if (await sameContent(target, bytes, ctx, signal)) return result(false);
    throw conflict();
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  abort(signal);
  recheck(ctx);
  const temporary = path.join(ctx.directory, `.fanhao-subtitle-${crypto.randomUUID()}.tmp`);
  let handle;
  let temporaryIdentity;
  try {
    handle = await fsp.open(temporary, "wx", 0o600);
    temporaryIdentity = await handle.stat({ bigint: true });
    recheck(ctx);
    abort(signal);
    await handle.writeFile(bytes, { signal });
    await handle.sync();
    const completed = await handle.stat({ bigint: true });
    if (!sameIdentity(completed, temporaryIdentity) || completed.size !== BigInt(bytes.length)) throw failure("字幕写入未完成", 409);
    abort(signal);
    recheck(ctx);
    const currentTemp = fs.lstatSync(temporary, { bigint: true });
    if (!currentTemp.isFile() || currentTemp.isSymbolicLink() || !sameVideo(completed, currentTemp)) throw failure("字幕临时文件已发生变化", 409);
    // link is an atomic exclusive publication: EEXIST can never replace a file.
    try { fs.linkSync(temporary, target); }
    catch (error) {
      if (error.code !== "EEXIST") {
        const unsupported = ["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EINVAL"].includes(error.code);
        throw Object.assign(failure(unsupported ? "当前磁盘不支持安全发布字幕所需的硬链接，未覆盖目标文件" : "字幕文件安全发布失败，未覆盖目标文件",
          unsupported ? 409 : 500, unsupported ? "SUBTITLE_SIDECAR_PUBLISH_UNSUPPORTED" : "SUBTITLE_SIDECAR_PUBLISH_FAILED"), { cause: error, fsCode: error.code });
      }
      if (await sameContent(target, bytes, ctx, signal)) return result(false);
      throw conflict();
    }
    return result(true);
  } finally {
    await handle?.close();
    if (temporaryIdentity) {
      // Do not unlink a replacement or follow a directory swapped to a junction.
      try {
        recheckDirectories(ctx);
        const current = fs.lstatSync(temporary, { bigint: true });
        if (sameIdentity(temporaryIdentity, current) && current.isFile() && !current.isSymbolicLink()) fs.unlinkSync(temporary);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
}

export async function discoverVideoSubtitles(video, { roots, signal } = {}) {
  abort(signal);
  const ctx = authority(video, roots);
  const files = [];
  for (const language of LANGUAGES) for (const extension of EXTENSIONS) {
    abort(signal);
    const name = sidecarName(ctx.videoPath, language, extension);
    const filePath = path.join(ctx.directory, name);
    try {
      checkedFile(filePath, ctx);
      files.push({ id: `sidecar:${digest(normalized(filePath))}`, name, path: filePath, type: "info" });
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "SUBTITLE_SIDECAR_UNSAFE" && error.code !== "SUBTITLE_TOO_LARGE") throw error;
      // A linked, oversized or non-regular track is not a discoverable subtitle.
    }
  }
  recheck(ctx);
  return files;
}
