import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { ensureRealPathWithinRoots } from "../../../../platform/server/library-path-safety.js";

const runFile = promisify(execFile);

export async function classifyIntakeAds(python, script, unnumbered, numbered = []) {
  if (!unnumbered.length && !numbered.length) return [];
  const result = runFile(python, [script, "--classify-ad-names"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  result.child.stdin.on("error", () => {});
  result.child.stdin.end(JSON.stringify({ unnumbered, numbered }));
  const { stdout } = await result;
  return JSON.parse(stdout);
}
export const VIDEO = /\.(?:mp4|mkv|avi|mov|wmv|flv|m4v|ts|m2ts|webm|mpg|mpeg)$/i;
export const SUBTITLE = /\.(?:srt|ass|ssa|vtt|sub|idx|sup|smi)$/i;
export const PARTIAL = /(?:\.115chrome_|\.(?:aria2|part|partial|crdownload|download|tmp)(?:\.|$))/i;
const EXCLUDED = /^(?:\.|\$|System Volume Information$|Recovery$)/i;
export const intakeError = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
export const pathKey = (value) => path.resolve(value).normalize("NFC").toLowerCase();
export const inside = (file, root) => { const rel = path.relative(root, file); return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`)); };
export const lstat = (file) => fs.lstatSync(file, { throwIfNoEntry: false });
export const identity = (stat) => stat ? [stat.dev, stat.ino] : null;
export const signature = (stat) => stat ? [...identity(stat), stat.size, stat.mtimeMs] : null;
export const same = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);

export function checkedPath(file, roots) {
  if (typeof file !== "string" || !path.isAbsolute(file) || /\0/.test(file) || (process.platform === "win32" && (!/^[A-Z]:[\\/]/i.test(file) || file.slice(2).includes(":")))) {
    throw intakeError("请输入完整的本地路径", 400);
  }
  const target = ensureRealPathWithinRoots(file, roots, "文件");
  for (const root of roots.filter((root) => inside(target, root)).sort((a, b) => b.length - a.length)) {
    let ancestor = target;
    while (!lstat(ancestor) && ancestor !== root) ancestor = path.dirname(ancestor);
    if (!lstat(ancestor) || !lstat(root)) continue;
    const expected = path.resolve(fs.realpathSync.native(root), path.relative(root, ancestor));
    if (pathKey(expected) === pathKey(fs.realpathSync.native(ancestor)) && (ancestor === root || !lstat(ancestor).isSymbolicLink())) return target;
  }
  throw intakeError("路径经过未登记的链接，或磁盘不可用", 400);
}

export function regular(file) {
  const stat = lstat(file);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw intakeError("视频或配套文件不存在，或已变成链接");
  return stat;
}

export function assertFinished(file) {
  const name = path.basename(file).toLowerCase();
  if (PARTIAL.test(name) || fs.readdirSync(path.dirname(file)).some((entry) => entry.toLowerCase().startsWith(`${name}.`) && PARTIAL.test(entry))) {
    throw intakeError("检测到未完成下载，请等 115 下载结束后再操作");
  }
}

export async function intakeSearchRoots() {
  const home = os.homedir();
  const folders = [path.join(home, "Downloads"), path.join(home, "Desktop"), home];
  if (process.platform === "win32") {
    try {
      const { stdout } = await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[IO.Directory]::GetLogicalDrives()"],
        { windowsHide: true, encoding: "utf8", timeout: 2000 });
      folders.push(...stdout.split(/\r?\n/).filter((line) => /^[a-z]:\\$/i.test(line)));
    } catch { /* Configured folders and explicit paths are still available. */ }
  }
  return folders;
}

async function searchIntakeFiles(roots, excludedRoots, wanted) {
  const searchRoots = new Map(roots.map((root) => [pathKey(root), root]));
  const signal = AbortSignal.timeout(5000);
  async function search(root) {
    const directories = [root];
    let visited = 0;
    // Breadth-first so a large subtree cannot consume the volume's entire search budget.
    for (let index = 0; index < directories.length && !signal.aborted; index++) {
      const dir = directories[index];
      if (excludedRoots.some((excluded) => inside(dir, excluded))) continue;
      try {
        const folder = await fsp.opendir(dir);
        for await (const entry of folder) {
          if (signal.aborted || ++visited > 20000) return;
          if (EXCLUDED.test(entry.name) || entry.isSymbolicLink()) continue;
          const file = path.join(dir, entry.name);
          if (entry.isDirectory() && !searchRoots.has(pathKey(file))) directories.push(file);
          if (!entry.isFile()) continue;
          const candidates = wanted.get(entry.name.toLowerCase());
          if (!candidates) continue;
          const stat = await fsp.lstat(file).catch(() => null);
          if (signal.aborted || !stat?.isFile()) continue;
          for (const item of candidates) {
            if (item.hits.size >= 10 || stat.size !== item.size || Math.abs(stat.mtimeMs - item.modified) > 2) continue;
            if (item.relative && !file.replaceAll("\\", "/").toLowerCase().endsWith(`/${item.relative.replaceAll("\\", "/").toLowerCase()}`)) continue;
            try { item.hits.set(pathKey(file), checkedPath(file, [root])); }
            catch { /* The candidate disappeared or resolved through a link. */ }
          }
        }
      } catch { /* An unavailable directory must not stop other searches. */ }
    }
  }
  let onTimeout;
  const timeout = new Promise((resolve) => {
    onTimeout = () => resolve();
    signal.addEventListener("abort", onTimeout, { once: true });
  });
  try { await Promise.race([Promise.all([...searchRoots.values()].map(search)), timeout]); }
  finally { signal.removeEventListener("abort", onTimeout); }
}

export async function collectIntakeFiles(input, roots, { searchRoots = intakeSearchRoots, excludedRoots = [] } = {}) {
  const paths = new Map(), folderOrigins = new Map();
  let visited = 0;
  async function collect(dir, depth, match) {
    if (depth < 0) return;
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if (++visited > 20000) throw intakeError("目录太大，请粘贴更具体的视频或文件夹路径", 400);
      if (EXCLUDED.test(entry.name) || entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await collect(file, depth - 1, match);
      else if (entry.isFile() && VIDEO.test(entry.name)) match(file, entry.name);
    }
  }
  const add = (file, folder) => {
    paths.set(pathKey(file), file);
    if (folder) folderOrigins.set(pathKey(file), folder);
    if (paths.size > 120) throw intakeError("一次最多核对 120 份视频，请缩小目录范围", 400);
  };
  if (input.path) {
    const file = checkedPath(input.path, roots);
    if (lstat(file)?.isDirectory()) await collect(file, 12, (child) => add(child, file));
    else if (VIDEO.test(file)) add(file);
    else throw intakeError("请选择已下载完成的视频或文件夹", 400);
    return { files: [...paths.values()], unmatched: [], folderOrigins };
  }
  const descriptors = input.files;
  if (!Array.isArray(descriptors) || descriptors.length < 1 || descriptors.length > 120) throw intakeError("请选择 1 至 120 个视频文件", 400);
  const wanted = new Map();
  for (const item of descriptors) {
    if (typeof item?.name !== "string" || item.name !== path.basename(item.name) || /[\\/]/.test(item.name) || !VIDEO.test(item.name)
      || (item.relative !== undefined && (typeof item.relative !== "string" || item.relative.length > 1024))
      || !Number.isSafeInteger(item.size) || item.size <= 0 || !Number.isFinite(item.modified)) throw intakeError("拖入的文件信息无效", 400);
    const key = item.name.toLowerCase();
    if (!wanted.has(key)) wanted.set(key, []);
    wanted.get(key).push({ ...item, hits: new Map() });
  }
  await searchIntakeFiles([...roots, ...await searchRoots()], excludedRoots, wanted);
  const unmatched = [];
  for (const items of wanted.values()) for (const item of items) {
    const hits = [...item.hits.values()];
    if (hits.length === 1) {
      const parts = item.relative?.replaceAll("\\", "/").split("/") || [];
      const relativeFolder = parts.length > 1 && parts.at(-1) === item.name && parts.every((part) => part && part !== "." && part !== "..");
      const folder = relativeFolder ? parts.slice(1).reduce((parent) => path.dirname(parent), hits[0]) : "";
      add(hits[0], folder);
    }
    else unmatched.push({ name: item.name, candidates: hits });
  }
  return { files: [...paths.values()], unmatched, folderOrigins };
}

function subtitleSuffix(name, videoName, legacy) {
  if (!SUBTITLE.test(name)) return "";
  const lower = name.toLowerCase();
  if (legacy) {
    const previousVideo = /^(.*)_(?:\d{10}|\d{13})\.[a-z]+$/i.exec(name)?.[1];
    if (previousVideo && VIDEO.test(previousVideo)) {
      return previousVideo.toLowerCase() === videoName.toLowerCase() ? path.extname(name) : "";
    }
  }
  const stem = path.parse(videoName).name;
  return lower.startsWith(`${stem.toLowerCase()}.`) ? name.slice(stem.length) : "";
}

export function subtitleFiles(video, { legacy = false, exclusive = false } = {}) {
  const folder = path.dirname(video), videoName = path.basename(video);
  const files = fs.readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
  const siblings = exclusive ? files.filter((name) => VIDEO.test(name) && pathKey(path.join(folder, name)) !== pathKey(video)) : [];
  return files.flatMap((name) => {
    const suffix = subtitleSuffix(name, videoName, legacy);
    if (!suffix || siblings.some((other) => subtitleSuffix(name, other, legacy))) return [];
    return [{ file: path.join(folder, name), suffix }];
  });
}

export async function probeIntakeVideo(executable, file) {
  try {
    const { stdout } = await runFile(executable, ["-v", "error", "-show_entries",
      "stream=codec_type,codec_name,width,height:stream_disposition=attached_pic:format=duration", "-of", "json", file],
    { windowsHide: true, timeout: 10000, maxBuffer: 256 * 1024 });
    const data = JSON.parse(stdout);
    const video = data.streams?.find((stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic);
    if (!video?.width || !video.height) return null;
    return { width: video.width, height: video.height, videoCodec: video.codec_name || "",
      audioCodec: data.streams.find((stream) => stream.codec_type === "audio")?.codec_name || "", duration: Number(data.format?.duration) || null };
  } catch { return null; }
}

export async function fetchIntakeMetadata({ python, script, profile, cwd }, code) {
  const { stdout } = await runFile(python, [script, "--code", code, "--cookie-profile-dir", profile, "--headless"],
    { cwd, windowsHide: true, timeout: 150000, maxBuffer: 512 * 1024 });
  const prefix = "FANHAO_INTAKE_METADATA=";
  const line = stdout.split(/\r?\n/).findLast((value) => value.startsWith(prefix));
  return line ? JSON.parse(line.slice(prefix.length)) : null;
}

export function is4kOrHigher(probe) {
  return Boolean(probe?.width && probe?.height && (Math.max(probe.width, probe.height) >= 3840 || Math.min(probe.width, probe.height) >= 2160));
}

export function safeName(value, fallback = "作品") {
  const text = String(value || "").toWellFormed().normalize("NFC").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").replace(/^[. ]+|[. ]+$/g, "");
  return !text || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(text) ? fallback : text;
}

function editionSuffix({ ltx, u, c }) {
  if (ltx) return `-LTX${c ? "C" : ""}${u ? "-U" : ""}`;
  return u || c ? `-${u ? "U" : ""}${c ? "C" : ""}` : "";
}

export function nameWithIntakeMarks(file, tags, existing) {
  const { name, ext } = path.parse(file);
  const [, stem, edition = "", quality = ""] = /^(.*?)(-LTXC?(?:-U)?|-UC|-U|-C)?(-4K)?$/i.exec(name);
  const ltx = /^-LTX/i.test(edition) || (tags.ltx === true && !existing.ltx);
  const u = /(?:^-UC?$|-U$)/i.test(edition) || (tags.u === true && !existing.uncensored);
  const c = /^(?:-U?C|-LTXC(?:-U)?)$/i.test(edition) || (tags.c === true && !existing.subtitled);
  if (!(tags.ltx === true && !existing.ltx) && !(tags.u === true && !existing.uncensored) && !(tags.c === true && !existing.subtitled)) {
    throw intakeError("请选择要追加的馆藏标记", 400);
  }
  return `${stem}${editionSuffix({ ltx, u, c })}${quality}${ext}`;
}

export function nameForIntake(folder, code, title, tags, ext, part = 0) {
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const clean = safeName(String(title || "").replace(new RegExp(`^${escaped}(?:[ ._-]+|$)`, "i"), ""), "");
  const suffix = `${part ? `-CD${part}` : ""}${editionSuffix(tags)}${tags.quality4k ? "-4K" : ""}`;
  const length = Math.min(175, 244 - folder.length - suffix.length - ext.length);
  if (length < code.length) throw intakeError("目标目录路径过长，请先缩短目录");
  const stem = safeName(`${code}${clean ? ` ${clean}` : ""}`.slice(0, length), code);
  return `${stem}${suffix}${ext.toLowerCase()}`;
}

async function hashFile(file, onChunk, signal) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file, { signal })) {
    hash.update(chunk);
    onChunk(chunk.length);
  }
  return hash.digest("hex");
}

const windowsCopyCommand = Buffer.from(String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class FanHaoFileCopy {
    private delegate uint Progress(long total, long transferred, long streamSize, long streamTransferred,
        uint streamNumber, uint reason, IntPtr source, IntPtr target, IntPtr context);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool CopyFileExW(string source, string target, Progress progress,
        IntPtr context, IntPtr cancel, uint flags);

    public static int Run(string source, string target, int parentId, string mutexName) {
        using (var parent = Process.GetProcessById(parentId))
        using (var mutex = new Mutex(false, mutexName)) {
            // A retry may arrive while the helper from an interrupted server is still stopping.
            try { mutex.WaitOne(); } catch (AbandonedMutexException) { }
            try {
                const uint stopAndKeepPartial = 2;
                if (parent.HasExited) return 1235;
                var timer = Stopwatch.StartNew();
                Progress report = (total, transferred, streamSize, streamTransferred, stream, reason, src, dst, context) => {
                    if (parent.HasExited) return stopAndKeepPartial;
                    if (timer.ElapsedMilliseconds >= 250 || transferred == total) {
                        Console.WriteLine(transferred);
                        timer.Restart();
                    }
                    return 0;
                };
                return CopyFileExW(source, target, report, IntPtr.Zero, IntPtr.Zero, 0) ? 0 : Marshal.GetLastWin32Error();
            } finally {
                mutex.ReleaseMutex();
            }
        }
    }
}
'@
exit ([FanHaoFileCopy]::Run($env:FANHAO_COPY_SOURCE, $env:FANHAO_COPY_TARGET, [int]$env:FANHAO_COPY_PARENT, $env:FANHAO_COPY_MUTEX))
`, "utf16le").toString("base64");

function copyWithWindows(item, onChunk) {
  const size = item.sourceSignature[2];
  const lock = createHash("sha256").update(pathKey(item.temp)).digest("hex");
  let reported = 0;
  const report = (transferred) => {
    const next = Math.min(size, transferred);
    if (!Number.isSafeInteger(next) || next <= reported) return;
    onChunk(next - reported);
    reported = next;
  };
  return new Promise((resolve, reject) => {
    const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", windowsCopyCommand], {
      windowsHide: true,
      env: { ...process.env, FANHAO_COPY_SOURCE: path.toNamespacedPath(item.source), FANHAO_COPY_TARGET: path.toNamespacedPath(item.temp),
        FANHAO_COPY_PARENT: String(process.pid), FANHAO_COPY_MUTEX: `Global\\FanHaoIntake-${lock}` }
    }, (error) => {
      if (!error) {
        report(size);
        resolve();
      } else if ([39, 112].includes(error.code)) {
        reject(Object.assign(error, { code: "ENOSPC" }));
      } else {
        reject(intakeError(`Windows 文件传输失败（${error.code || "未知错误"}），请检查文件占用或磁盘权限后重试`));
      }
    });
    createInterface({ input: child.stdout }).on("line", (line) => report(Number(line)));
  });
}

async function verifyIntakeCopy(item, copiedHash, onChunk) {
  const abort = new AbortController();
  let sourceBytes = copiedHash ? item.sourceSignature[2] : 0;
  let targetBytes = 0;
  let reported = 0;
  function report() {
    const verified = Math.min(sourceBytes, targetBytes);
    if (verified > reported) onChunk(verified - reported);
    reported = verified;
  }
  const hashes = [
    copiedHash ?? hashFile(item.source, (size) => { sourceBytes += size; report(); }, abort.signal),
    hashFile(item.temp, (size) => { targetBytes += size; report(); }, abort.signal)
  ];
  try {
    return await Promise.all(hashes);
  } catch (error) {
    abort.abort();
    await Promise.allSettled(hashes);
    throw error;
  }
}

export async function stageIntakeFile(item, persist, onProgress = () => {}) {
  if (item.staged && same(signature(lstat(item.temp)), item.staged)) return;
  if (item.source && !same(signature(regular(item.source)), item.sourceSignature)) throw intakeError("源文件已改变，请重新核对");
  if (!item.tempIdentity) {
    if (item.source) {
      if (same(signature(lstat(item.temp)), item.sourceSignature)) {
        item.tempIdentity = identity(regular(item.temp));
        item.staged = item.sourceSignature;
        persist();
        return;
      }
      try {
        await fsp.link(item.source, item.temp);
        item.tempIdentity = identity(regular(item.temp));
        item.staged = signature(regular(item.temp));
        persist();
        return;
      } catch (error) {
        if (item.linkOnly) throw intakeError("无法在馆藏目录中暂存重命名，请检查文件占用或目录权限");
        if (!["EXDEV", "EPERM", "ENOTSUP", "EACCES"].includes(error.code)) throw error;
      }
    }
    const file = await fsp.open(item.temp, "wx");
    try { item.tempIdentity = identity(await file.stat()); persist(); } finally { await file.close(); }
  }
  if (!same(identity(regular(item.temp)), item.tempIdentity)) throw intakeError("暂存文件身份已改变，需检查任务记录");
  if (item.source && same(identity(regular(item.source)), item.tempIdentity)) throw intakeError("同卷暂存期间源文件发生变化");
  const handle = await fsp.open(item.temp, "r+");
  try {
    if (!same(identity(await handle.stat()), item.tempIdentity)) throw intakeError("暂存文件已被替换");
    if (item.source) {
      let copied;
      if (process.platform === "win32") {
        await copyWithWindows(item, (size) => onProgress("copy", size));
      } else {
        await handle.truncate(0);
        const hash = createHash("sha256");
        async function* chunks() {
          for await (const chunk of fs.createReadStream(item.source)) {
            hash.update(chunk);
            onProgress("copy", chunk.length);
            yield chunk;
          }
        }
        await handle.writeFile(chunks());
        copied = hash.digest("hex");
      }
      await handle.sync();
      const tempStat = regular(item.temp);
      if (!same(identity(tempStat), item.tempIdentity)) throw intakeError("暂存文件已被替换");
      const [sourceHash, targetHash] = await verifyIntakeCopy(item, copied, (size) => onProgress("verify", size));
      if (!same(signature(regular(item.source)), item.sourceSignature)) throw intakeError("传输期间源文件被改动，请等下载或其他程序结束后重试");
      if (sourceHash !== targetHash) throw intakeError("目标盘上的副本与源文件内容不一致，可重试传输");
      if (!same(signature(regular(item.temp)), signature(tempStat))) throw intakeError("校验期间暂存文件被改动，可重试传输");
      const mtime = new Date(item.sourceSignature[3]);
      await handle.utimes(mtime, mtime);
    } else {
      await handle.truncate(0);
      await handle.writeFile(item.content, "utf8");
    }
    await handle.sync();
    item.staged = signature(await handle.stat());
    persist();
  } finally { await handle.close(); }
}

export async function openIntakePath(file) {
  if (process.platform === "win32") {
    const value = Buffer.from(file, "utf8").toString("base64");
    const script = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${value}')); Invoke-Item -LiteralPath $p -ErrorAction Stop`;
    await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 12000 });
  } else await runFile(process.platform === "darwin" ? "open" : "xdg-open", [file], { timeout: 12000 });
}
