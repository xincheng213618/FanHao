import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Existing static local references share one generated identity. Leave remote
// URLs, API queries and dynamic template expressions untouched.
const localVersion = /(["'])(\.{1,2}\/[^"'`\s<>?#]+\.(?:m?js|css)\?v=)[A-Za-z0-9_.~-]+/gu;
const declaration = /export const CLIENT_VERSION = (["'])[^"'\r\n]+\1;/gu;
const textExtensions = new Set([".js", ".mjs", ".css", ".html"]);

function replaceVersions(source, version, isConfig) {
  let result = source.replace(localVersion, (_, quote, prefix) => `${quote}${prefix}${version}`);
  if (isConfig) result = result.replace(declaration, `export const CLIENT_VERSION = "${version}";`);
  return result;
}

export function normalizeAndroidCacheSource(relativePath, source) {
  return replaceVersions(source, "<CLIENT_VERSION>", relativePath === "js/config.js").replace(/\r\n/g, "\n");
}

function readSources(wwwDir) {
  const sources = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const filePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Cache source must not be a symbolic link: ${filePath}`);
      if (entry.isDirectory()) visit(filePath);
      else if (entry.isFile() && textExtensions.has(path.extname(entry.name))) {
        sources.push({ filePath, relativePath: path.relative(wwwDir, filePath).replaceAll(path.sep, "/"), source: fs.readFileSync(filePath, "utf8") });
      }
    }
  }
  if (!fs.lstatSync(wwwDir).isDirectory() || fs.lstatSync(wwwDir).isSymbolicLink()) {
    throw new Error(`Cache source root must be a regular directory: ${wwwDir}`);
  }
  visit(wwwDir);
  return sources;
}

export function planAndroidCacheVersion(wwwDir) {
  const sources = readSources(path.resolve(wwwDir));
  const config = sources.find(({ relativePath }) => relativePath === "js/config.js");
  if (!config || [...config.source.matchAll(declaration)].length !== 1) {
    throw new Error("Android js/config.js must declare CLIENT_VERSION exactly once.");
  }
  const hash = createHash("sha256");
  for (const { relativePath, source } of sources) {
    const canonical = normalizeAndroidCacheSource(relativePath, source);
    hash.update(`${relativePath}\0${canonical}\0`);
  }
  const version = `assets-${hash.digest("hex").slice(0, 12)}`;
  const changes = sources.flatMap((entry) => {
    const updated = replaceVersions(entry.source, version, entry.relativePath === "js/config.js");
    return updated === entry.source ? [] : [{ ...entry, updated }];
  });
  return { version, sourceCount: sources.length, changes };
}

export function syncAndroidCacheVersion(wwwDir) {
  const plan = planAndroidCacheVersion(wwwDir);
  // Detect edits to the captured snapshots before beginning synchronization.
  for (const change of plan.changes) {
    if (fs.readFileSync(change.filePath, "utf8") !== change.source) {
      throw new Error(`Android source changed during cache synchronization: ${change.relativePath}. Retry synchronization.`);
    }
  }
  for (const change of plan.changes) fs.writeFileSync(change.filePath, change.updated);
  return plan;
}

export function assertAndroidCacheVersion(wwwDir) {
  const plan = planAndroidCacheVersion(wwwDir);
  if (plan.changes.length) {
    throw new Error(`Android cache references need synchronization (${plan.changes.length} files). Run npm --prefix android-client run sync:cache; builds synchronize automatically.`);
  }
  return plan;
}
