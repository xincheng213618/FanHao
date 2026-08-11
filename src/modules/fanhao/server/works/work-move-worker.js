import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

const RETRYABLE_CODES = new Set(["EPERM", "EBUSY", "ENOTEMPTY", "EACCES"]);

function delay(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function pathType(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

async function renameWithRetry(sourcePath, targetPath, attempts = 8, delayMs = 450) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fs.promises.rename(sourcePath, targetPath);
      return attempt;
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_CODES.has(String(error?.code || "").toUpperCase()) || attempt >= attempts) throw error;
      await delay(delayMs);
    }
  }
  throw lastError;
}

async function collectTree(rootPath) {
  const directories = [""];
  const files = [];
  const pending = [""];
  while (pending.length) {
    const relativeDirectory = pending.pop();
    const absoluteDirectory = path.join(rootPath, relativeDirectory);
    const entries = await fs.promises.readdir(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        directories.push(relativePath);
        pending.push(relativePath);
      } else if (entry.isFile()) {
        const stat = await fs.promises.stat(path.join(rootPath, relativePath));
        files.push({ relativePath, size: Number(stat.size || 0), mtimeMs: Number(stat.mtimeMs || 0) });
      } else {
        throw new Error(`不支持移动特殊文件：${relativePath}`);
      }
    }
  }
  directories.sort((left, right) => left.length - right.length);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return {
    directories,
    files,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0)
  };
}

async function sameFile(targetPath, sourceFile) {
  try {
    const stat = await fs.promises.stat(targetPath);
    return stat.isFile() && Number(stat.size || 0) === sourceFile.size;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function matchingContent(sourcePath, targetPath, files, targetFiles) {
  parentPort.postMessage({ type: "progress", phase: "verifying", completedFiles: 0, totalFiles: files.length, completedBytes: 0, totalBytes: files.reduce((sum, file) => sum + file.size, 0) });
  let completedBytes = 0;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const target = targetFiles.get(file.relativePath.toLowerCase());
    if (!target || target.size !== file.size) return false;
    const [sourceHash, targetHash] = await Promise.all([
      hashFile(path.join(sourcePath, file.relativePath)),
      hashFile(path.join(targetPath, target.relativePath))
    ]);
    if (sourceHash !== targetHash) return false;
    completedBytes += file.size;
    parentPort.postMessage({ type: "progress", phase: "verifying", completedFiles: index + 1, totalFiles: files.length, completedBytes, totalBytes: files.reduce((sum, item) => sum + item.size, 0) });
  }
  return true;
}

async function copyTree(sourcePath, stagingPath) {
  const tree = await collectTree(sourcePath);
  let completedFiles = 0;
  let completedBytes = 0;
  parentPort.postMessage({ type: "progress", phase: "copying", completedFiles, completedBytes, totalFiles: tree.files.length, totalBytes: tree.totalBytes });

  for (const relativeDirectory of tree.directories) {
    await fs.promises.mkdir(path.join(stagingPath, relativeDirectory), { recursive: true });
  }
  for (const file of tree.files) {
    const sourceFile = path.join(sourcePath, file.relativePath);
    const targetFile = path.join(stagingPath, file.relativePath);
    if (!(await sameFile(targetFile, file))) {
      const temporaryFile = `${targetFile}.fanhao-part`;
      await fs.promises.rm(temporaryFile, { force: true });
      await fs.promises.copyFile(sourceFile, temporaryFile);
      await fs.promises.rename(temporaryFile, targetFile);
      if (file.mtimeMs > 0) {
        const modifiedAt = new Date(file.mtimeMs);
        await fs.promises.utimes(targetFile, modifiedAt, modifiedAt);
      }
    }
    completedFiles += 1;
    completedBytes += file.size;
    parentPort.postMessage({ type: "progress", phase: "copying", completedFiles, completedBytes, totalFiles: tree.files.length, totalBytes: tree.totalBytes });
    await delay(Number(workerData.delayPerFileMs || 0));
  }
  return tree;
}

async function verifyTrees(sourcePath, targetPath) {
  const [source, target] = await Promise.all([collectTree(sourcePath), collectTree(targetPath)]);
  if (source.files.length !== target.files.length || source.totalBytes !== target.totalBytes) return false;
  const targetFiles = new Map(target.files.map((file) => [file.relativePath.toLowerCase(), file]));
  return matchingContent(sourcePath, targetPath, source.files, targetFiles);
}

async function sourceIsCoveredByTarget(sourcePath, targetPath) {
  const [source, target] = await Promise.all([collectTree(sourcePath), collectTree(targetPath)]);
  const targetFiles = new Map(target.files.map((file) => [file.relativePath.toLowerCase(), file]));
  return matchingContent(sourcePath, targetPath, source.files, targetFiles);
}

async function stageMove() {
  const { sourcePath, targetPath, stagingPath } = workerData;
  const [sourceType, targetType] = await Promise.all([pathType(sourcePath), pathType(targetPath)]);
  if (targetType === "directory") {
    if (sourceType === "missing") return { mode: "rename-resume", sourceRemoved: true };
    if (sourceType === "directory" && await verifyTrees(sourcePath, targetPath)) return { mode: "copy-resume", sourceRemoved: false };
    throw new Error("目标作品文件夹已存在且与源目录不一致");
  }
  if (targetType !== "missing") throw new Error("目标作品路径不是可用目录");
  if (sourceType !== "directory") throw new Error("源作品文件夹不存在");

  if (!workerData.forceCopy && await pathType(stagingPath) === "missing") {
    try {
      const attempts = await renameWithRetry(sourcePath, targetPath, process.platform === "win32" ? 8 : 2, 450);
      return { mode: attempts > 1 ? "rename-retry" : "rename", sourceRemoved: true };
    } catch (error) {
      if (String(error?.code || "").toUpperCase() !== "EXDEV") throw error;
    }
  }

  const tree = await copyTree(sourcePath, stagingPath);
  if (!(await verifyTrees(sourcePath, stagingPath))) throw new Error("跨卷复制校验失败");
  await renameWithRetry(stagingPath, targetPath, process.platform === "win32" ? 8 : 2, 450);
  return { mode: "copy", sourceRemoved: false, totalFiles: tree.files.length, totalBytes: tree.totalBytes };
}

async function cleanupSource() {
  const { sourcePath, targetPath } = workerData;
  await delay(Number(workerData.delayBeforeCleanupMs || 0));
  if (await pathType(targetPath) !== "directory") throw new Error("目标作品文件夹不存在，拒绝清理源目录");
  if (await pathType(sourcePath) === "directory") {
    if (!(await sourceIsCoveredByTarget(sourcePath, targetPath))) throw new Error("源目录仍有目标目录未覆盖的文件，拒绝继续清理");
    await fs.promises.rm(sourcePath, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 });
  }
  return { cleaned: true };
}

async function rollbackMove() {
  const { sourcePath, targetPath, stagingPath } = workerData;
  if (await pathType(stagingPath) === "directory") {
    await fs.promises.rm(stagingPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  const [sourceType, targetType] = await Promise.all([pathType(sourcePath), pathType(targetPath)]);
  if (sourceType === "directory" && targetType === "directory") {
    if (!(await verifyTrees(sourcePath, targetPath))) throw new Error("目标副本与源目录不一致，拒绝自动删除目标目录");
    await fs.promises.rm(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return { rolledBack: true, mode: "remove-copy" };
  }
  if (sourceType === "missing" && targetType === "directory") {
    try {
      await renameWithRetry(targetPath, sourcePath, process.platform === "win32" ? 8 : 2, 450);
      return { rolledBack: true, mode: "rename" };
    } catch (error) {
      if (String(error?.code || "").toUpperCase() !== "EXDEV") throw error;
      const rollbackStaging = `${sourcePath}.fanhao-rollback-${workerData.jobId}`;
      await copyTree(targetPath, rollbackStaging);
      if (!(await verifyTrees(targetPath, rollbackStaging))) throw new Error("跨卷回滚校验失败");
      await renameWithRetry(rollbackStaging, sourcePath, process.platform === "win32" ? 8 : 2, 450);
      await fs.promises.rm(targetPath, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 });
      return { rolledBack: true, mode: "copy" };
    }
  }
  if (sourceType === "directory" && targetType === "missing") return { rolledBack: true, mode: "already-source" };
  throw new Error("源目录与目标目录都不存在，无法自动回滚");
}

async function run() {
  if (workerData.operation === "stage") return stageMove();
  if (workerData.operation === "cleanup") return cleanupSource();
  if (workerData.operation === "rollback") return rollbackMove();
  throw new Error(`未知文件移动操作：${workerData.operation}`);
}

run()
  .then((result) => parentPort.postMessage({ type: "done", result }))
  .catch((error) => {
    parentPort.postMessage({ type: "error", error: { message: error?.message || String(error), code: error?.code || "" } });
    process.exitCode = 1;
  });
