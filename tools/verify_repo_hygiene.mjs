import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forbiddenTrackedPath = /^(?:artifacts|tmp|logs|tmp-apk-labels|outputs)(?:\/|$)/i;
const runtimeStatePath = /^data\/short-video-list-(?:cache-generation|watch-overlays)\.json$/i;
const rootServedDump = /^[^/]+-served\.[^/]+$/i;
const sourceExtensions = new Set([
  ".bat",
  ".c",
  ".cc",
  ".cjs",
  ".cmd",
  ".cpp",
  ".cs",
  ".csproj",
  ".css",
  ".go",
  ".gradle",
  ".h",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".kts",
  ".less",
  ".md",
  ".mjs",
  ".php",
  ".properties",
  ".ps1",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sln",
  ".sql",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml"
]);
const sourceBasenames = new Set([
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  ".npmrc",
  "dockerfile",
  "makefile"
]);

const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "buffer",
  maxBuffer: 16 * 1024 * 1024
})
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .map((filePath) => filePath.replaceAll("\\", "/"));

const forbiddenFiles = trackedFiles.filter((filePath) => (
  forbiddenTrackedPath.test(filePath) || runtimeStatePath.test(filePath) || rootServedDump.test(filePath)
));
const nulSourceFiles = [];

for (const relativePath of trackedFiles.filter(isSourceFile)) {
  const filePath = path.join(root, ...relativePath.split("/"));
  if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) continue;
  if (fs.readFileSync(filePath).includes(0)) nulSourceFiles.push(relativePath);
}

const violations = [];
if (forbiddenFiles.length > 0) {
  violations.push(`generated or served-dump files are tracked:\n${formatList(forbiddenFiles)}`);
}
if (nulSourceFiles.length > 0) {
  violations.push(`tracked source files contain NUL bytes:\n${formatList(nulSourceFiles)}`);
}

if (violations.length > 0) {
  console.error(`repo-hygiene: failed\n\n${violations.join("\n\n")}`);
  process.exitCode = 1;
} else {
  console.log(`repo-hygiene: ok (${trackedFiles.length} tracked files checked)`);
}

function isSourceFile(filePath) {
  const basename = path.posix.basename(filePath).toLowerCase();
  return sourceBasenames.has(basename) || sourceExtensions.has(path.posix.extname(basename));
}

function formatList(files) {
  return files.map((filePath) => `  - ${filePath}`).join("\n");
}
