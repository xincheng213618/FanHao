import fs from "node:fs";
import path from "node:path";

export function createMediaFileRelocationService({
  safeStat,
  readRootDirectoryNames = defaultRootDirectoryNames,
  warn = console.warn
}) {
  const relocatedPaths = new Map();

  function resolve(file) {
    const originalPath = String(file?.path || "");
    if (!file || !originalPath) return null;
    if (isFile(safeStat(originalPath))) return file;

    const cachedPath = relocatedPaths.get(originalPath);
    if (cachedPath && matchingFile(safeStat(cachedPath), file)) return { ...file, path: cachedPath };
    relocatedPaths.delete(originalPath);

    const pathApi = pathApiFor(originalPath);
    const root = pathApi.parse(originalPath).root;
    const parts = pathApi.relative(root, originalPath).split(pathApi.sep).filter(Boolean);
    if (!root || parts.length < 2) return null;

    const relativeTail = parts.slice(1);
    const matches = [];
    for (const directoryName of readRootDirectoryNames(root)) {
      const candidate = pathApi.join(root, directoryName, ...relativeTail);
      if (!matchingFile(safeStat(candidate), file)) continue;
      matches.push(candidate);
      if (matches.length > 1) return null;
    }
    if (matches.length !== 1) return null;

    relocatedPaths.set(originalPath, matches[0]);
    warn(`[fanhao-media-relocated] ${originalPath} -> ${matches[0]}`);
    return { ...file, path: matches[0] };
  }

  return { resolve };
}

function defaultRootDirectoryNames(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function matchingFile(stat, file) {
  if (!isFile(stat)) return false;
  const expectedSize = Number(file?.size || 0);
  return expectedSize <= 0 || Number(stat.size || 0) === expectedSize;
}

function isFile(stat) {
  return Boolean(stat && (typeof stat.isFile !== "function" || stat.isFile()));
}

function pathApiFor(filePath) {
  return /^[a-z]:[\\/]/i.test(filePath) ? path.win32 : path;
}
