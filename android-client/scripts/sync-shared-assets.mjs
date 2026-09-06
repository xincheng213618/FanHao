import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const sourceDir = path.resolve(projectDir, "..", "public", "games");
const targetDir = path.resolve(projectDir, "www", "games");
const expectedTarget = path.join(projectDir, "www", "games");
const webOnlyGames = new Set(["gomoku", "jump"]);

// The account form is shared by Web and Android; do not hand-edit its app copy.
const accountTarget = path.join(projectDir, "www", "platform", "accounts");
fs.mkdirSync(accountTarget, { recursive: true });
for (const file of ["account-ui.js", "account.css"]) {
  fs.copyFileSync(path.join(projectDir, "..", "public", "platform", "accounts", file), path.join(accountTarget, file));
}

if (targetDir !== expectedTarget) throw new Error(`Unexpected shared asset target: ${targetDir}`);
if (!fs.statSync(sourceDir, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error(`Shared game assets are missing: ${sourceDir}`);
}

fs.rmSync(targetDir, { recursive: true, force: true });
fs.cpSync(sourceDir, targetDir, {
  recursive: true,
  filter(sourcePath) {
    const relativePath = path.relative(sourceDir, sourcePath);
    const topLevelDir = relativePath.split(path.sep)[0];
    return !webOnlyGames.has(topLevelDir);
  }
});

let fileCount = 0;
let totalBytes = 0;
for (const entry of fs.readdirSync(targetDir, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const filePath = path.join(entry.parentPath, entry.name);
  fileCount += 1;
  totalBytes += fs.statSync(filePath).size;
}

console.log(`shared-assets: ${fileCount} files, ${totalBytes} bytes (excluded web-only: ${[...webOnlyGames].join(", ")})`);
