import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanRoots = [
  path.join(root, "server.js"),
  path.join(root, "lib"),
  path.join(root, "src"),
  path.join(root, "tools"),
  path.join(root, "public"),
  path.join(root, "android-client", "www")
];
const ignoredDirs = new Set(["games", "node_modules"]);
const sourceFiles = scanRoots.flatMap(collectSourceFiles);
const missing = [];

for (const filePath of sourceFiles) {
  const source = fs.readFileSync(filePath, "utf8");
  for (const specifier of relativeSpecifiers(source, path.extname(filePath))) {
    const clean = specifier.split(/[?#]/, 1)[0];
    const target = path.resolve(path.dirname(filePath), clean);
    if (!resolveTarget(target)) {
      missing.push(`${relative(filePath)} -> ${specifier}`);
    }
  }
}

assert.equal(missing.length, 0, `missing relative imports:\n${missing.join("\n")}`);
console.log(`relative-imports: ok (${sourceFiles.length} files)`);

function collectSourceFiles(entryPath) {
  const stat = fs.statSync(entryPath, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isFile()) return isSource(entryPath) ? [entryPath] : [];

  const result = [];
  for (const entry of fs.readdirSync(entryPath, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
    const child = path.join(entryPath, entry.name);
    if (entry.isDirectory()) result.push(...collectSourceFiles(child));
    else if (entry.isFile() && isSource(child)) result.push(child);
  }
  return result;
}

function isSource(filePath) {
  return /\.(?:js|mjs|css)$/.test(filePath);
}

function relativeSpecifiers(source, extension) {
  const patterns = extension === ".css"
    ? [/@import\s+(?:url\()?\s*(["'])(\.\.?\/[^"']+)\1/g]
    : [/(?:from\s*|import\s*\()(["'])(\.\.?\/[^"']+)\1/g];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[2]));
}

function resolveTarget(target) {
  const candidates = [target, `${target}.js`, `${target}.mjs`, `${target}.json`, path.join(target, "index.js")];
  return candidates.some((candidate) => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile());
}

function relative(filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, "/");
}
