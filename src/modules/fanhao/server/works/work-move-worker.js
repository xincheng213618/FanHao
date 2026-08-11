import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { ensureRealPathWithinRoots } from "../library/library-path-safety.js";

const RETRYABLE_CODES = new Set(["EPERM", "EBUSY", "ENOTEMPTY", "EACCES"]);

function validateWorkerPaths(...paths) {
  const roots = Array.isArray(workerData.allowedRoots) ? workerData.allowedRoots : [];
  if (!roots.length) throw new Error("文件移动计划缺少可信资料库根目录，拒绝执行");
  for (const filePath of paths.filter(Boolean)) ensureRealPathWithinRoots(filePath, roots, "文件移动路径");
}

function delay(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function pathType(filePath) {
  try {
    validateWorkerPaths(filePath);
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
      validateWorkerPaths(sourcePath, targetPath);
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
  validateWorkerPaths(rootPath);
  const directories = [""];
  const files = [];
  const pending = [""];
  while (pending.length) {
    const relativeDirectory = pending.pop();
    const absoluteDirectory = path.join(rootPath, relativeDirectory);
    validateWorkerPaths(absoluteDirectory);
    const entries = await fs.promises.readdir(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        directories.push(relativePath);
        pending.push(relativePath);
      } else if (entry.isFile()) {
        const absoluteFile = path.join(rootPath, relativePath);
        validateWorkerPaths(absoluteFile);
        const stat = await fs.promises.stat(absoluteFile);
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
    validateWorkerPaths(targetPath);
    const stat = await fs.promises.stat(targetPath);
    return stat.isFile() && Number(stat.size || 0) === sourceFile.size;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    try {
      validateWorkerPaths(filePath);
    } catch (error) {
      reject(error);
      return;
    }
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function matchingContent(sourcePath, targetPath, files, targetFiles) {
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  parentPort.postMessage({ type: "progress", phase: "verifying", completedFiles: 0, totalFiles: files.length, completedBytes: 0, totalBytes });
  await delay(Number(workerData.delayBeforeVerificationMs || 0));
  validateWorkerPaths(sourcePath, targetPath);
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
    parentPort.postMessage({ type: "progress", phase: "verifying", completedFiles: index + 1, totalFiles: files.length, completedBytes, totalBytes });
  }
  validateWorkerPaths(sourcePath, targetPath);
  return true;
}

async function copyTree(sourcePath, stagingPath) {
  const tree = await collectTree(sourcePath);
  let completedFiles = 0;
  let completedBytes = 0;
  parentPort.postMessage({ type: "progress", phase: "copying", completedFiles, completedBytes, totalFiles: tree.files.length, totalBytes: tree.totalBytes });

  for (const relativeDirectory of tree.directories) {
    const targetDirectory = path.join(stagingPath, relativeDirectory);
    validateWorkerPaths(targetDirectory);
    await fs.promises.mkdir(targetDirectory, { recursive: true });
  }
  for (const file of tree.files) {
    const sourceFile = path.join(sourcePath, file.relativePath);
    const targetFile = path.join(stagingPath, file.relativePath);
    if (!(await sameFile(targetFile, file))) {
      const temporaryFile = `${targetFile}.fanhao-part`;
      validateWorkerPaths(sourceFile, targetFile, temporaryFile);
      await fs.promises.rm(temporaryFile, { force: true });
      validateWorkerPaths(sourceFile, targetFile, temporaryFile);
      await fs.promises.copyFile(sourceFile, temporaryFile);
      await renameWithRetry(temporaryFile, targetFile, process.platform === "win32" ? 8 : 2, 100);
      if (file.mtimeMs > 0) {
        const modifiedAt = new Date(file.mtimeMs);
        validateWorkerPaths(targetFile);
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
  validateWorkerPaths(sourcePath, targetPath, stagingPath);
  const [sourceType, targetType] = await Promise.all([pathType(sourcePath), pathType(targetPath)]);
  if (targetType === "directory") {
    if (sourceType === "missing") {
      validateWorkerPaths(targetPath);
      return { mode: "rename-resume", sourceRemoved: true };
    }
    if (sourceType === "directory" && await verifyTrees(sourcePath, targetPath)) {
      validateWorkerPaths(sourcePath, targetPath);
      return { mode: "copy-resume", sourceRemoved: false };
    }
    throw new Error("目标作品文件夹已存在且与源目录不一致");
  }
  if (targetType !== "missing") throw new Error("目标作品路径不是可用目录");
  if (sourceType !== "directory") throw new Error("源作品文件夹不存在");

  if (!workerData.forceCopy && await pathType(stagingPath) === "missing") {
    try {
      const attempts = await renameWithRetry(sourcePath, targetPath, process.platform === "win32" ? 8 : 2, 450);
      validateWorkerPaths(targetPath);
      return { mode: attempts > 1 ? "rename-retry" : "rename", sourceRemoved: true };
    } catch (error) {
      if (String(error?.code || "").toUpperCase() !== "EXDEV") throw error;
    }
  }

  const tree = await copyTree(sourcePath, stagingPath);
  if (!(await verifyTrees(sourcePath, stagingPath))) throw new Error("跨卷复制校验失败");
  parentPort.postMessage({ type: "progress", phase: "publishing", completedFiles: tree.files.length, totalFiles: tree.files.length, completedBytes: tree.totalBytes, totalBytes: tree.totalBytes });
  await delay(Number(workerData.delayBeforePublishMs || 0));
  validateWorkerPaths(sourcePath, stagingPath, targetPath);
  await renameWithRetry(stagingPath, targetPath, process.platform === "win32" ? 8 : 2, 450);
  validateWorkerPaths(sourcePath, targetPath);
  return { mode: "copy", sourceRemoved: false, totalFiles: tree.files.length, totalBytes: tree.totalBytes };
}

function cleanupGuardValue() {
  return `fanhao-work-move-guard:${workerData.jobId}`;
}

async function isOwnedCleanupGuard(sourcePath) {
  validateWorkerPaths(sourcePath);
  if (await pathType(sourcePath) !== "file") return false;
  try {
    return (await fs.promises.readFile(sourcePath, "utf8")) === cleanupGuardValue();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function ensureCleanupGuard(sourcePath) {
  validateWorkerPaths(sourcePath);
  if (await pathType(sourcePath) === "missing") {
    let handle = null;
    try {
      handle = await fs.promises.open(sourcePath, "wx");
      await handle.writeFile(cleanupGuardValue(), "utf8");
    } finally {
      await handle?.close();
    }
  }
  if (!(await isOwnedCleanupGuard(sourcePath))) {
    throw new Error("源路径在隔离后被重建或替换，隔离目录已保留且拒绝删除");
  }
}

async function removeCleanupGuard(sourcePath) {
  if (!(await isOwnedCleanupGuard(sourcePath))) throw new Error("源路径保护标记已变化，拒绝报告清理完成");
  validateWorkerPaths(sourcePath);
  await fs.promises.unlink(sourcePath);
}

async function cleanupSource({ isolateOnly = false } = {}) {
  const { sourcePath, targetPath } = workerData;
  const quarantinePath = workerData.quarantinePath || path.join(path.dirname(sourcePath), `.${path.basename(sourcePath)}.fanhao-quarantine-${workerData.jobId}`);
  validateWorkerPaths(sourcePath, targetPath, quarantinePath);
  await delay(Number(workerData.delayBeforeCleanupMs || 0));
  if (await pathType(targetPath) !== "directory") throw new Error("目标作品文件夹不存在，拒绝清理源目录");

  const [sourceType, quarantineType] = await Promise.all([pathType(sourcePath), pathType(quarantinePath)]);
  if (sourceType === "directory" && quarantineType === "directory") {
    throw new Error("源目录与隔离目录同时存在，拒绝自动删除任何内容");
  }
  if (quarantineType !== "missing" && quarantineType !== "directory") {
    throw new Error("任务隔离路径不是目录，拒绝清理源目录");
  }
  if (sourceType === "directory") {
    parentPort.postMessage({ type: "progress", phase: "isolating", completedFiles: 0, totalFiles: 0, completedBytes: 0, totalBytes: 0 });
    await renameWithRetry(sourcePath, quarantinePath, process.platform === "win32" ? 8 : 2, 450);
    await ensureCleanupGuard(sourcePath);
  } else if (sourceType === "missing" && quarantineType === "directory") {
    await ensureCleanupGuard(sourcePath);
  } else if (sourceType === "file" && quarantineType === "directory") {
    await ensureCleanupGuard(sourcePath);
  } else if (sourceType === "file" && quarantineType === "missing" && await isOwnedCleanupGuard(sourcePath)) {
    await removeCleanupGuard(sourcePath);
    return { cleaned: true, quarantined: true };
  } else if (sourceType !== "missing") {
    throw new Error("源作品路径不是目录，拒绝清理");
  }

  if (isolateOnly) {
    return {
      isolated: await pathType(quarantinePath) === "directory",
      guarded: await isOwnedCleanupGuard(sourcePath)
    };
  }

  if (await pathType(quarantinePath) === "directory") {
    const restoreOrPreserve = async (reason) => {
      if (await isOwnedCleanupGuard(sourcePath)) await removeCleanupGuard(sourcePath);
      if (await pathType(sourcePath) === "missing") {
        await renameWithRetry(quarantinePath, sourcePath, process.platform === "win32" ? 8 : 2, 450);
      }
      throw new Error(reason);
    };
    if (!(await sourceIsCoveredByTarget(quarantinePath, targetPath))) {
      await restoreOrPreserve("隔离后的源目录仍有目标目录未覆盖的文件，已拒绝删除");
    }
    await delay(Number(workerData.delayAfterCleanupVerificationMs || 0));
    await ensureCleanupGuard(sourcePath);
    if (!(await sourceIsCoveredByTarget(quarantinePath, targetPath))) {
      await restoreOrPreserve("隔离目录在校验期间发生变化，已拒绝删除");
    }
    await ensureCleanupGuard(sourcePath);
    validateWorkerPaths(sourcePath, quarantinePath, targetPath);
    await fs.promises.rm(quarantinePath, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 });
    await ensureCleanupGuard(sourcePath);
    await removeCleanupGuard(sourcePath);
    if (await pathType(sourcePath) !== "missing") throw new Error("源路径在清理完成边界重新出现，拒绝报告完成");
    validateWorkerPaths(sourcePath, targetPath);
  }
  return { cleaned: true, quarantined: quarantineType === "directory" || sourceType === "directory" };
}

async function restoreIsolatedSource() {
  const { sourcePath } = workerData;
  const quarantinePath = workerData.quarantinePath || path.join(path.dirname(sourcePath), `.${path.basename(sourcePath)}.fanhao-quarantine-${workerData.jobId}`);
  validateWorkerPaths(sourcePath, quarantinePath);
  if (await pathType(quarantinePath) === "missing") return { restored: false, alreadyRestored: true };
  if (await pathType(quarantinePath) !== "directory") throw new Error("任务隔离路径不是目录，拒绝恢复源目录");
  if (await isOwnedCleanupGuard(sourcePath)) await removeCleanupGuard(sourcePath);
  if (await pathType(sourcePath) !== "missing") throw new Error("源路径已被其他内容占用，隔离目录已保留");
  await renameWithRetry(quarantinePath, sourcePath, process.platform === "win32" ? 8 : 2, 450);
  validateWorkerPaths(sourcePath);
  return { restored: true };
}

async function rollbackMove() {
  const { sourcePath, targetPath, stagingPath } = workerData;
  const quarantinePath = workerData.quarantinePath || path.join(path.dirname(sourcePath), `.${path.basename(sourcePath)}.fanhao-quarantine-${workerData.jobId}`);
  validateWorkerPaths(sourcePath, targetPath, stagingPath, quarantinePath);
  await delay(Number(workerData.delayBeforeRollbackMs || 0));
  if (await pathType(quarantinePath) === "directory") {
    if (await pathType(sourcePath) !== "missing") throw new Error("源目录与隔离目录同时存在，拒绝自动回滚");
    await renameWithRetry(quarantinePath, sourcePath, process.platform === "win32" ? 8 : 2, 450);
  }
  if (await pathType(stagingPath) === "directory") {
    validateWorkerPaths(stagingPath);
    await fs.promises.rm(stagingPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  const [sourceType, targetType] = await Promise.all([pathType(sourcePath), pathType(targetPath)]);
  if (sourceType === "directory" && targetType === "directory") {
    if (!(await verifyTrees(sourcePath, targetPath))) throw new Error("目标副本与源目录不一致，拒绝自动删除目标目录");
    validateWorkerPaths(sourcePath, targetPath);
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
      validateWorkerPaths(targetPath);
      await fs.promises.rm(targetPath, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 });
      return { rolledBack: true, mode: "copy" };
    }
  }
  if (sourceType === "directory" && targetType === "missing") return { rolledBack: true, mode: "already-source" };
  throw new Error("源目录与目标目录都不存在，无法自动回滚");
}

async function run() {
  if (workerData.operation === "stage") return stageMove();
  if (workerData.operation === "isolate") return cleanupSource({ isolateOnly: true });
  if (workerData.operation === "cleanup") return cleanupSource();
  if (workerData.operation === "restore") return restoreIsolatedSource();
  if (workerData.operation === "rollback") return rollbackMove();
  throw new Error(`未知文件移动操作：${workerData.operation}`);
}

run()
  .then((result) => parentPort.postMessage({ type: "done", result }))
  .catch((error) => {
    parentPort.postMessage({ type: "error", error: { message: error?.message || String(error), code: error?.code || "" } });
    process.exitCode = 1;
  });
