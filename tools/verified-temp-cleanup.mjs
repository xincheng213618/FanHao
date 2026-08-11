import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function normalizedRealPath(value) {
  const resolved = path.resolve(fs.realpathSync.native(value)).replace(/[\\/]+$/g, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertInsideTempRoot(tempRoot, target, originalValue) {
  const prefix = `${tempRoot}${path.sep}`;
  if (!target || target === tempRoot || !target.startsWith(prefix)) {
    throw new Error(`Refusing to recursively delete a path outside the temporary directory: ${originalValue}`);
  }
}

export function captureVerifiedTempDirOwnership(tempDir) {
  const tempRootPath = os.tmpdir();
  const tempRoot = normalizedRealPath(tempRootPath);
  const target = normalizedRealPath(tempDir);
  assertInsideTempRoot(tempRoot, target, tempDir);
  const targetStat = fs.statSync(tempDir);
  return Object.freeze({
    tempDir: path.resolve(tempDir),
    tempRootPath,
    tempRoot,
    target,
    device: String(targetStat.dev),
    inode: String(targetStat.ino)
  });
}

export function createVerifiedTempDir(prefix, options = {}) {
  if (!prefix || path.basename(prefix) !== prefix || /[\\/]/u.test(prefix)) {
    throw new Error(`Refusing to create a temporary directory with an unsafe prefix: ${prefix}`);
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let ownership = null;
  let handedOff = false;
  try {
    ownership = captureVerifiedTempDirOwnership(tempDir);
    options.afterCreate?.(tempDir);
    let cleaned = false;
    handedOff = true;
    return Object.freeze({
      tempDir,
      ownership,
      cleanup() {
        if (cleaned) return false;
        const removed = removeVerifiedTempDir(tempDir, ownership);
        if (removed) cleaned = true;
        return removed;
      }
    });
  } finally {
    if (!handedOff && ownership) removeVerifiedTempDir(tempDir, ownership);
  }
}

export function removeVerifiedTempDir(tempDir, ownership = null) {
  if (!fs.existsSync(tempDir)) return false;
  const tempRoot = normalizedRealPath(os.tmpdir());
  const target = normalizedRealPath(tempDir);
  assertInsideTempRoot(tempRoot, target, tempDir);
  if (ownership) {
    if (
      path.resolve(tempDir) !== ownership.tempDir
      || tempRoot !== ownership.tempRoot
      || target !== ownership.target
    ) {
      throw new Error(`Refusing to recursively delete a moved or replaced temporary directory: ${tempDir}`);
    }
    const targetStat = fs.statSync(tempDir);
    if (String(targetStat.dev) !== ownership.device || String(targetStat.ino) !== ownership.inode) {
      throw new Error(`Refusing to recursively delete a replacement temporary directory: ${tempDir}`);
    }
  }
  fs.rmSync(tempDir, { recursive: true, force: false });
  return true;
}
