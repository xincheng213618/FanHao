import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { workCodeKey } from "../../../../../lib/code-parser.js";
import { intakeNameCode } from "./intake-catalog.js";
import { PARTIAL, SUBTITLE, VIDEO, checkedPath, identity, intakeError, lstat, pathKey, same, signature } from "./intake-files.js";

export function snapshotIntakeDirectory(folder, roots, label = "下载包") {
  const stat = lstat(checkedPath(folder, roots));
  if (!stat?.isDirectory() || stat.isSymbolicLink() || !stat.ino) throw intakeError(`${label}目录已改变，请重新核对`);
  const entries = [];
  function walk(dir, depth) {
    if (depth > 12) throw intakeError(`${label}的子目录太深，请单独核对文件`);
    for (const name of fs.readdirSync(dir).sort()) {
      if (entries.length >= 512) throw intakeError(`${label}文件太多，请单独核对文件`);
      if (PARTIAL.test(name)) throw intakeError(`${label}内还有未完成文件，请核对目录`);
      const child = checkedPath(path.join(dir, name), roots);
      const entry = lstat(child);
      if (!entry || entry.isSymbolicLink() || !(entry.isFile() || entry.isDirectory())) throw intakeError(`${label}含链接或特殊文件，请单独核对文件`);
      const directory = entry.isDirectory();
      entries.push({ relative: path.relative(folder, child), directory, signature: directory ? identity(entry) : signature(entry) });
      if (directory) walk(child, depth + 1);
    }
  }
  walk(folder, 0);
  const folderId = identity(stat);
  return { folderId, entries, fingerprint: createHash("sha256").update(JSON.stringify([folderId, entries])).digest("hex") };
}

export async function classifyIntakeVideoAds(videos, classifyAds) {
  const unnumbered = [], numbered = [];
  for (const { name, code } of videos) (code ? numbered : unnumbered).push(name);
  const names = new Set(await classifyAds([...new Set(unnumbered)], [...new Set(numbered)]));
  const promos = videos.filter((video) => names.has(video.name)
    || (!video.code && path.dirname(video.path).split(path.sep).some((part) => part === "宣传文件" || part === "宣傳文件")));
  return new Set(promos.map((video) => video.path));
}

export async function inspectIntakePackage(folder, roots, classifyAds) {
  const code = intakeNameCode(path.basename(folder));
  if (!code) return null;
  const manifest = snapshotIntakeDirectory(folder, roots);
  const videos = manifest.entries.filter((entry) => !entry.directory && VIDEO.test(entry.relative)).map((entry) => {
    const name = path.basename(entry.relative), stem = path.parse(name).name;
    const part = Number(/[-_.\s](?:cd|part|disc)?[-_.\s]*(\d{1,2})$/i.exec(stem)?.[1] || 0);
    return { path: path.join(folder, entry.relative), name, code: intakeNameCode(stem), part, signature: entry.signature };
  });
  const key = workCodeKey(code);
  const main = videos.filter((video) => workCodeKey(video.code) === key).sort((a, b) => a.part - b.part);
  if (!main.length || (main.length > 1 && !main.every((video, index) => video.part === index + 1))) return null;
  const other = videos.filter((video) => workCodeKey(video.code) !== key);
  const ads = await classifyIntakeVideoAds(other, classifyAds);
  if (other.some((video) => !ads.has(video.path))) return null;
  return { folder, code, ...manifest, videos: main, ads: other.map(({ name }) => name) };
}

// Subtitles inside a download package travel with the main video instead of being cleaned with the package.
// A subtitle named after one part keeps its language suffix; any other subtitle keeps its own name as the suffix.
export function packageSubtitles(bundle) {
  if (!bundle) return [];
  return bundle.entries.filter((entry) => !entry.directory && SUBTITLE.test(entry.relative)).map((entry) => {
    const file = path.join(bundle.folder, entry.relative), name = path.basename(file), lower = name.toLowerCase();
    const index = bundle.videos.findIndex((video) => pathKey(path.dirname(video.path)) === pathKey(path.dirname(file))
      && lower.startsWith(`${path.parse(video.name).name.toLowerCase()}.`));
    const suffix = index >= 0 ? name.slice(path.parse(bundle.videos[index].name).name.length) : `.${name}`;
    return { file, name, video: Math.max(index, 0), suffix, signature: entry.signature };
  });
}

export function packageSummary(bundle) {
  if (!bundle) return null;
  return { folder: bundle.folder, fingerprint: bundle.fingerprint, mediaFingerprint: packageMediaFingerprint(bundle),
    videos: bundle.videos.map(({ path, name }) => ({ path, name })),
    ads: bundle.ads || [], subtitles: packageSubtitles(bundle).map(({ name }) => name),
    extras: bundle.entries.filter((entry) => !entry.directory).length - bundle.videos.length };
}

export function packageMediaFingerprint(bundle) {
  const media = [...bundle.videos.map(({ path, signature }) => [path, signature]),
    ...packageSubtitles(bundle).map(({ file, signature }) => [file, signature])];
  return createHash("sha256").update(JSON.stringify([bundle.folderId, media])).digest("hex");
}

export function requireIntakePackage(bundle, roots, folder = bundle.folder) {
  if (snapshotIntakeDirectory(folder, roots, bundle.label).fingerprint !== bundle.fingerprint) {
    throw intakeError(`${bundle.label || "下载包"}内容已改变，请重新核对`);
  }
}

export function requireIntakePackageFolder(bundle, roots) {
  const folder = checkedPath(bundle.folder, roots);
  const stat = lstat(folder);
  if (!stat?.isDirectory() || stat.isSymbolicLink() || !same(identity(stat), bundle.folderId)) {
    throw intakeError("下载包目录已改变，请重新核对");
  }
}

export function removeMigratedIntakePackage(bundle, roots, persist) {
  // Resume cleanup for jobs previously isolated by the whole-package workflow.
  if (bundle.isolated || lstat(checkedPath(bundle.quarantine, roots))) {
    removeIntakePackage(bundle, roots, persist);
    return "";
  }
  const folder = checkedPath(bundle.folder, roots);
  if (!lstat(folder)) return "";
  const directories = new Map([[folder, bundle.folderId]]);
  for (const entry of bundle.entries) {
    if (entry.directory) directories.set(path.join(folder, entry.relative), entry.signature);
  }
  function ownsDirectory(dir) {
    const expected = directories.get(dir);
    if (!expected) return false;
    const current = lstat(dir);
    return current?.isDirectory() && !current.isSymbolicLink() && same(identity(current), expected)
      && (dir === folder || ownsDirectory(path.dirname(dir)));
  }
  function removeEmpty(dir) {
    if (!ownsDirectory(dir)) return false;
    try { fs.rmdirSync(checkedPath(dir, roots)); }
    catch (error) {
      if (error.code === "ENOTEMPTY" || error.code === "EEXIST") return false;
      if (error.code !== "ENOENT") throw error;
    }
    return true;
  }
  for (const entry of [...bundle.entries].reverse()) {
    const file = path.join(folder, entry.relative);
    if (entry.directory) removeEmpty(file);
    else if (ownsDirectory(path.dirname(file))) {
      const current = lstat(file);
      if (current?.isFile() && !current.isSymbolicLink() && same(signature(current), entry.signature)) {
        fs.unlinkSync(checkedPath(file, roots));
      }
    }
  }
  return removeEmpty(folder) || !lstat(folder) ? "" : folder;
}

export function removeIntakePackage(bundle, roots, persist) {
  const folder = checkedPath(bundle.folder, roots), quarantine = checkedPath(bundle.quarantine, roots);
  if (pathKey(path.dirname(quarantine)) !== pathKey(path.dirname(folder)) || pathKey(folder) === pathKey(quarantine)) {
    throw intakeError("下载包隔离路径无效");
  }
  if (!lstat(quarantine)) {
    if (bundle.isolated) return;
    requireIntakePackage(bundle, roots);
    fs.renameSync(folder, quarantine);
  }
  const current = snapshotIntakeDirectory(quarantine, roots, bundle.label);
  const expected = new Map(bundle.entries.map((entry) => [entry.relative, entry]));
  if (!same(current.folderId, bundle.folderId) || current.entries.some((entry) => {
    const original = expected.get(entry.relative);
    return !original || entry.directory !== original.directory || !same(entry.signature, original.signature);
  })) throw intakeError(`下载包隔离后发现文件变化，请检查 ${quarantine}`);
  if (!bundle.isolated) { bundle.isolated = true; persist(); }
  for (const entry of current.entries.reverse()) {
    const file = checkedPath(path.join(quarantine, entry.relative), roots);
    const stat = lstat(file);
    if (!stat || stat.isSymbolicLink() || !same(entry.directory ? identity(stat) : signature(stat), entry.signature)) {
      throw intakeError(`下载包清理时文件发生变化，请检查 ${quarantine}`);
    }
    if (entry.directory) fs.rmdirSync(file);
    else fs.unlinkSync(file);
  }
  if (!same(identity(lstat(checkedPath(quarantine, roots))), bundle.folderId)) throw intakeError("下载包隔离目录已改变");
  fs.rmdirSync(quarantine);
}
