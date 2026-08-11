import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const QUARANTINE_PREFIX = ".fanhao-cleanup-quarantine-";
const QUARANTINE_PAYLOAD = "payload";
const pendingQuarantines = new WeakMap();

function callFs(fsOps, name, ...args) {
  const operation = fsOps?.[name] || fs[name];
  return operation(...args);
}

function normalizedResolvedPath(value) {
  const resolved = path.resolve(value).replace(/[\\/]+$/g, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizedRealPath(value, fsOps = null) {
  const realpath = fsOps?.realpathSyncNative || fs.realpathSync.native;
  return normalizedResolvedPath(realpath(value));
}

function assertInsideTempRoot(tempRoot, target, originalValue) {
  const prefix = `${tempRoot}${path.sep}`;
  if (!target || target === tempRoot || !target.startsWith(prefix)) {
    throw new Error(`Refusing to recursively delete a path outside the temporary directory: ${originalValue}`);
  }
}

function lstatIfPresent(targetPath, fsOps = null) {
  return callFs(fsOps, "lstatSync", targetPath, { throwIfNoEntry: false }) || null;
}

function assertPlainDirectory(targetPath, {
  device = null,
  fsOps = null,
  inode = null,
  tempRoot,
  tempRootLexical,
  label
}) {
  const entry = lstatIfPresent(targetPath, fsOps);
  if (!entry) throw new Error(`${label} is missing: ${targetPath}`);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`${label} is a link, junction, reparse point, or non-directory: ${targetPath}`);
  }
  const lexical = normalizedResolvedPath(targetPath);
  const canonical = normalizedRealPath(targetPath, fsOps);
  const relative = path.relative(tempRootLexical, lexical);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} is not a strict lexical descendant of the temporary root: ${targetPath}`);
  }
  const expectedCanonical = normalizedResolvedPath(path.join(tempRoot, relative));
  assertInsideTempRoot(tempRoot, expectedCanonical, targetPath);
  if (canonical !== expectedCanonical) {
    throw new Error(`${label} resolved through a link, junction, or reparse point: ${targetPath}`);
  }
  assertUsableIdentity(entry, label);
  if (device !== null && (String(entry.dev) !== device || String(entry.ino) !== inode)) {
    throw new Error(`${label} has a different owner identity: ${targetPath}`);
  }
  return entry;
}

export function captureVerifiedTempDirOwnership(tempDir) {
  const tempRootPath = os.tmpdir();
  const tempRootLexical = normalizedResolvedPath(tempRootPath);
  const tempRoot = normalizedRealPath(tempRootPath);
  const target = normalizedRealPath(tempDir);
  assertInsideTempRoot(tempRoot, target, tempDir);
  const targetStat = assertPlainDirectory(tempDir, {
    tempRoot,
    tempRootLexical,
    label: "Temporary directory ownership target"
  });
  return Object.freeze({
    tempDir: normalizedResolvedPath(tempDir),
    tempRootPath,
    tempRootLexical,
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
      cleanup(cleanupOptions = {}) {
        if (cleaned) return false;
        const removed = removeVerifiedTempDir(tempDir, ownership, cleanupOptions);
        if (removed) cleaned = true;
        return removed;
      }
    });
  } finally {
    if (!handedOff && ownership) removeVerifiedTempDir(tempDir, ownership);
  }
}

export function removeVerifiedTempDir(tempDir, ownership = null, options = {}) {
  const fsOps = options.fsOps || null;
  const token = ownership || captureCurrentOwnership(tempDir, fsOps);
  if (!token) return false;
  const pending = pendingQuarantines.get(token);
  if (pending) return removeQuarantinedPayload(pending, token, fsOps);

  if (normalizedResolvedPath(tempDir) !== token.tempDir) {
    throw new Error(`Refusing to recursively delete a moved or replaced temporary directory: ${tempDir}`);
  }
  const currentTempRoot = normalizedRealPath(os.tmpdir(), fsOps);
  if (currentTempRoot !== token.tempRoot) {
    throw new Error(`Refusing cleanup after the temporary root changed: ${tempDir}`);
  }
  if (!lstatIfPresent(tempDir, fsOps)) return false;
  assertPlainDirectory(tempDir, {
    device: token.device,
    fsOps,
    inode: token.inode,
    tempRoot: token.tempRoot,
    tempRootLexical: token.tempRootLexical,
    label: "Temporary directory ownership target"
  });
  if (normalizedRealPath(tempDir, fsOps) !== token.target) {
    throw new Error(`Refusing to recursively delete a moved or replaced temporary directory: ${tempDir}`);
  }

  const quarantine = createQuarantine(token, fsOps);
  try {
    assertQuarantineParent(quarantine, token, fsOps);
    callFs(fsOps, "renameSync", tempDir, quarantine.payloadPath);
  } catch (error) {
    const payloadEntry = lstatIfPresent(quarantine.payloadPath, fsOps);
    const originalEntry = lstatIfPresent(tempDir, fsOps);
    if (!payloadEntry) removeEmptyQuarantineParent(quarantine, token, fsOps);
    if (!payloadEntry && !originalEntry && isMissingPathError(error)) return false;
    if (payloadEntry && !originalEntry) pendingQuarantines.set(token, quarantine);
    throw withQuarantineDetails(error, quarantine, false);
  }

  pendingQuarantines.set(token, quarantine);
  return removeQuarantinedPayload(quarantine, token, fsOps);
}

function captureCurrentOwnership(tempDir, fsOps) {
  if (!lstatIfPresent(tempDir, fsOps)) return null;
  const tempRootPath = os.tmpdir();
  const tempRootLexical = normalizedResolvedPath(tempRootPath);
  const tempRoot = normalizedRealPath(tempRootPath, fsOps);
  const target = normalizedRealPath(tempDir, fsOps);
  assertInsideTempRoot(tempRoot, target, tempDir);
  const entry = assertPlainDirectory(tempDir, {
    fsOps,
    tempRoot,
    tempRootLexical,
    label: "Temporary directory ownership target"
  });
  return Object.freeze({
    tempDir: normalizedResolvedPath(tempDir),
    tempRootPath,
    tempRootLexical,
    tempRoot,
    target,
    device: String(entry.dev),
    inode: String(entry.ino)
  });
}

function createQuarantine(ownership, fsOps) {
  const parentPath = callFs(
    fsOps,
    "mkdtempSync",
    path.join(ownership.tempRootPath, QUARANTINE_PREFIX)
  );
  const parentStat = assertPlainDirectory(parentPath, {
    fsOps,
    tempRoot: ownership.tempRoot,
    tempRootLexical: ownership.tempRootLexical,
    label: "Cleanup quarantine parent"
  });
  const quarantine = Object.freeze({
    parentPath,
    payloadPath: path.join(parentPath, QUARANTINE_PAYLOAD),
    device: String(parentStat.dev),
    inode: String(parentStat.ino)
  });
  try {
    callFs(fsOps, "chmodSync", parentPath, 0o700);
    assertQuarantineParent(quarantine, ownership, fsOps);
    return quarantine;
  } catch (error) {
    removeEmptyQuarantineParent(quarantine, ownership, fsOps);
    throw error;
  }
}

function assertQuarantineParent(quarantine, ownership, fsOps) {
  const entry = assertPlainDirectory(quarantine.parentPath, {
    device: quarantine.device,
    fsOps,
    inode: quarantine.inode,
    tempRoot: ownership.tempRoot,
    tempRootLexical: ownership.tempRootLexical,
    label: "Cleanup quarantine parent"
  });
  if (process.platform !== "win32" && (Number(entry.mode) & 0o777) !== 0o700) {
    throw new Error(`Cleanup quarantine parent permissions changed: ${quarantine.parentPath}`);
  }
  return entry;
}

function removeQuarantinedPayload(quarantine, ownership, fsOps) {
  try {
    assertQuarantineParent(quarantine, ownership, fsOps);
    assertPlainDirectory(quarantine.payloadPath, {
      device: ownership.device,
      fsOps,
      inode: ownership.inode,
      tempRoot: ownership.tempRoot,
      tempRootLexical: ownership.tempRootLexical,
      label: "Quarantined temporary directory"
    });
    // Node exposes no fd-relative recursive delete. The private 0700 mkdtemp
    // parent removes the confirmed original-path replacement race. A hostile
    // local process that discovers and races this random parent remains outside
    // this helper's threat model; do not describe this as absolute race freedom.
    callFs(fsOps, "rmSync", quarantine.payloadPath, { recursive: true, force: false });
  } catch (error) {
    throw withQuarantineDetails(
      error,
      quarantine,
      quarantineStillOwnsToken(quarantine, ownership, fsOps)
    );
  }

  pendingQuarantines.delete(ownership);
  removeEmptyQuarantineParent(quarantine, ownership, fsOps);
  return true;
}

function quarantineStillOwnsToken(quarantine, ownership, fsOps) {
  try {
    assertQuarantineParent(quarantine, ownership, fsOps);
    assertPlainDirectory(quarantine.payloadPath, {
      device: ownership.device,
      fsOps,
      inode: ownership.inode,
      tempRoot: ownership.tempRoot,
      tempRootLexical: ownership.tempRootLexical,
      label: "Quarantined temporary directory"
    });
    return true;
  } catch {
    return false;
  }
}

function removeEmptyQuarantineParent(quarantine, ownership, fsOps) {
  try {
    if (lstatIfPresent(quarantine.payloadPath, fsOps)) return false;
    assertQuarantineParent(quarantine, ownership, fsOps);
    // Never recursively remove the parent: an injected sibling makes rmdir
    // fail closed and preserves that entry.
    callFs(fsOps, "rmdirSync", quarantine.parentPath);
    return true;
  } catch {
    return false;
  }
}

function withQuarantineDetails(error, quarantine, ownedDirectoryPreserved) {
  const failure = error instanceof Error ? error : new Error(String(error || "Temporary directory cleanup failed"));
  try {
    failure.quarantinePath = quarantine.payloadPath;
    failure.ownedDirectoryPreserved = ownedDirectoryPreserved;
  } catch {}
  return failure;
}

function isMissingPathError(error) {
  return ["ENOENT", "ENOTDIR"].includes(String(error?.code || "").toUpperCase());
}

function assertUsableIdentity(entry, label) {
  const device = String(entry?.dev ?? "");
  const inode = String(entry?.ino ?? "");
  if (!device || !inode || device === "0" || inode === "0") {
    throw new Error(`${label} does not expose a stable dev/ino owner identity`);
  }
}
