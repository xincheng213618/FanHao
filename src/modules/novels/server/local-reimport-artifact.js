import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const MAX_LOCAL_REIMPORT_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const LOCAL_REIMPORT_TEMP_PREFIX = "fanhao-novel-reimport-";

export function sourceIdentity(filePath) {
  const stat = fs.statSync(filePath, { bigint: true });
  if (!stat.isFile()) throw conflict("原始来源不是有效的 TXT 文件");
  return Object.fromEntries(["dev", "ino", "size", "mtimeNs", "ctimeNs", "birthtimeNs"].map((key) => [key, String(stat[key])]));
}

export function samePath(left, right) {
  const normalize = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

export function assertSourceSnapshot(descriptor) {
  try {
    const filePath = fs.realpathSync(descriptor.sourcePath);
    const root = fs.realpathSync(descriptor.sourceRoot);
    const relative = path.relative(root, filePath);
    if (!samePath(filePath, descriptor.sourcePath) || !samePath(root, descriptor.sourceRoot)
      || !relative || relative.startsWith("..") || path.isAbsolute(relative) || path.extname(filePath).toLowerCase() !== ".txt"
      || JSON.stringify(sourceIdentity(filePath)) !== JSON.stringify(descriptor.sourceIdentity)) throw conflict("原始 TXT 文件或来源目录已变化，请重新打开后再导入");
  } catch (error) { if (error.statusCode === 409) throw error; throw conflict("原始 TXT 文件或来源目录已变化，请重新打开后再导入"); }
}

export function loadLocalReimportArtifact(descriptor, expectedRoot) {
  const root = fs.realpathSync(descriptor.artifactRoot);
  const temporary = fs.realpathSync(os.tmpdir());
  if (expectedRoot && !samePath(root, expectedRoot)) throw conflict("重新导入的临时文件来源无效");
  if (!samePath(path.dirname(root), temporary) || !path.basename(root).startsWith(LOCAL_REIMPORT_TEMP_PREFIX)
    || !samePath(root, descriptor.artifactRoot) || !samePath(path.dirname(descriptor.artifactPath), root)
    || !/^[0-9a-f-]{36}\.json$/.test(path.basename(descriptor.artifactPath))
    || !samePath(fs.realpathSync(descriptor.artifactPath), descriptor.artifactPath)) throw conflict("重新导入的临时文件路径无效");
  let bytes;
  const handle = fs.openSync(descriptor.artifactPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.size > MAX_LOCAL_REIMPORT_ARTIFACT_BYTES || descriptor.artifactBytes > MAX_LOCAL_REIMPORT_ARTIFACT_BYTES) throw Object.assign(new Error("本地 TXT 解析结果超过 512 MiB 上限"), { statusCode: 413 });
    if (stat.size !== descriptor.artifactBytes) throw conflict("重新导入的解析结果已变化");
    bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(handle, bytes, offset, bytes.length - offset, offset);
      if (!read) throw conflict("重新导入的解析结果已变化");
      offset += read;
    }
    const after = fs.fstatSync(handle);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw conflict("重新导入的解析结果已变化");
  } finally { fs.closeSync(handle); }
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== descriptor.artifactHash) throw conflict("重新导入的解析结果校验失败");
  let payload;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw conflict("重新导入的解析结果不是有效的 UTF-8 JSON"); }
  const record = payload?.bookRecord;
  if (payload?.formatVersion !== 1 || !record || record.status !== "ok" || !Array.isArray(record.chapters) || !record.chapters.length
    || record.id !== descriptor.bookId || typeof record.source_path !== "string" || typeof record.source_root !== "string"
    || !samePath(record.source_path, descriptor.sourcePath) || !samePath(record.source_root, descriptor.sourceRoot)
    || record.chapter_count !== record.chapters.length
    || !record.chapters.every((chapter, index) => chapter.index === index + 1 && typeof chapter.title === "string" && typeof chapter.content === "string")
    || !["title", "author", "category", "relative_path", "file_name", "encoding", "summary", "tags_json", "updated_at", "error"].every((key) => typeof record[key] === "string")
    || !["size_bytes", "mtime_ms", "char_count", "chapter_count"].every((key) => Number.isSafeInteger(record[key]) && record[key] >= 0)) throw conflict("重新导入的解析结果无效");
  assertSourceSnapshot(descriptor);
  return record;
}

function conflict(message) { return Object.assign(new Error(message), { statusCode: 409 }); }
