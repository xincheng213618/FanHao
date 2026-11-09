import fs from "node:fs";
import path from "node:path";

export function createMediaFileRelocationService({
  safeStat,
  readRootDirectoryNames = defaultRootDirectoryNames,
  statFile = fs.promises.stat,
  readRootDirectoryNamesAsync = defaultRootDirectoryNamesAsync,
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

    const location = relocationLocation(originalPath);
    if (!location) return null;
    const { pathApi, root, relativeTail } = location;
    const matches = [];
    for (const directoryName of readRootDirectoryNames(root)) {
      const candidate = pathApi.join(root, directoryName, ...relativeTail);
      if (!matchingFile(safeStat(candidate), file)) continue;
      matches.push(candidate);
      if (matches.length > 1) return null;
    }
    if (matches.length !== 1) return null;
    return rememberRelocation(file, originalPath, matches[0]);
  }

  async function resolveMissingSource(file, signal) {
    const originalPath = String(file?.path || "");
    if (!originalPath || signal?.aborted) return null;

    const cachedPath = relocatedPaths.get(originalPath);
    if (cachedPath) {
      const stat = await candidateStat(cachedPath);
      if (signal?.aborted) return null;
      if (matchingFile(stat, file)) return { ...file, path: cachedPath };
      if (relocatedPaths.get(originalPath) === cachedPath) relocatedPaths.delete(originalPath);
    }

    const location = relocationLocation(originalPath);
    if (!location) return null;
    const { pathApi, root, relativeTail } = location;
    const directoryNames = await readRootDirectoryNamesAsync(root);
    let match = null;
    for (const directoryName of directoryNames) {
      if (signal?.aborted) return null;
      const candidate = pathApi.join(root, directoryName, ...relativeTail);
      const stat = await candidateStat(candidate);
      if (signal?.aborted) return null;
      if (!matchingFile(stat, file)) continue;
      if (match) return null;
      match = candidate;
    }
    return match ? rememberRelocation(file, originalPath, match) : null;
  }

  async function candidateStat(filePath) {
    try { return await statFile(filePath); }
    catch { return null; }
  }

  function rememberRelocation(file, originalPath, target) {
    relocatedPaths.set(originalPath, target);
    warn(`[fanhao-media-relocated] ${originalPath} -> ${target}`);
    return { ...file, path: target };
  }

  return { resolve, resolveMissingSource };
}

function defaultRootDirectoryNames(root) {
  try {
    return directoryNames(fs.readdirSync(root, { withFileTypes: true }));
  } catch {
    return [];
  }
}

async function defaultRootDirectoryNamesAsync(root) {
  try {
    return directoryNames(await fs.promises.readdir(root, { withFileTypes: true }));
  } catch {
    return [];
  }
}

function directoryNames(entries) {
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

function matchingFile(stat, file) {
  if (!isFile(stat)) return false;
  const expectedSize = Number(file?.size || 0);
  return expectedSize <= 0 || Number(stat.size || 0) === expectedSize;
}

function isFile(stat) {
  return Boolean(stat && (typeof stat.isFile !== "function" || stat.isFile()));
}

function relocationLocation(originalPath) {
  const pathApi = /^[a-z]:[\\/]/i.test(originalPath) ? path.win32 : path;
  const root = pathApi.parse(originalPath).root;
  const parts = pathApi.relative(root, originalPath).split(pathApi.sep).filter(Boolean);
  return root && parts.length >= 2 ? { pathApi, root, relativeTail: parts.slice(1) } : null;
}
