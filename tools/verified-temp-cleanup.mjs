import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function normalizedRealPath(value) {
  const resolved = path.resolve(fs.realpathSync.native(value)).replace(/[\\/]+$/g, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function removeVerifiedTempDir(tempDir) {
  if (!fs.existsSync(tempDir)) return false;
  const tempRoot = normalizedRealPath(os.tmpdir());
  const target = normalizedRealPath(tempDir);
  const prefix = `${tempRoot}${path.sep}`;
  if (!target || target === tempRoot || !target.startsWith(prefix)) {
    throw new Error(`Refusing to recursively delete a path outside the temporary directory: ${tempDir}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}
