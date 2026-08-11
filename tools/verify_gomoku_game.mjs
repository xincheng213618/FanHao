import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gameDir = path.join(root, "public", "games", "gomoku");
const expectedHashes = new Map([
  ["engine/rapfi-single.js", "D5991F22FE6B2442C76EB0637E5EAE5595C858930F3F4585E8A8D86C8B3771C1"],
  ["engine/rapfi-single.wasm", "20BB495AFF65FF3E7EBC46E70890E9D1F98BF5023EE0E2C7378651F5F36A5820"],
  ["engine/rapfi.data", "2FA58B1C9E005A7B39BBDDB798097A8F1FF9CEABA4C9339D87BA7D324B9D846D"]
]);

const requiredFiles = [
  "index.html",
  "styles.css",
  "gomoku.js",
  "engine-worker.js",
  "README.md",
  "SOURCE.txt",
  "LICENSE-RAPFI.txt",
  "LICENSE-NETWORKS.txt",
  ...expectedHashes.keys()
];

for (const relativePath of requiredFiles) {
  const filePath = path.join(gameDir, ...relativePath.split("/"));
  if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`gomoku: missing ${relativePath}`);
  }
}

for (const [relativePath, expectedHash] of expectedHashes) {
  const bytes = fs.readFileSync(path.join(gameDir, ...relativePath.split("/")));
  const actualHash = crypto.createHash("sha256").update(hashableAssetBytes(relativePath, bytes)).digest("hex").toUpperCase();
  if (actualHash !== expectedHash) {
    throw new Error(`gomoku: hash mismatch for ${relativePath}: ${actualHash}`);
  }
}

const indexHtml = read("public/games/gomoku/index.html");
const gameScript = read("public/games/gomoku/gomoku.js");
const workerScript = read("public/games/gomoku/engine-worker.js");
const toolsPage = read("public/modules/tools/tools-page.js");
const androidTools = read("android-client/www/modules/tools/tool-views.js");
const syncScript = read("android-client/scripts/sync-shared-assets.mjs");
const serverConfig = read("src/bootstrap/server-config.js");

assertIncludes(indexHtml, "./gomoku.js", "page script");
assertIncludes(indexHtml, "dhbloo/rapfi", "Rapfi attribution");
assertIncludes(gameScript, "new Worker", "AI worker startup");
assertIncludes(gameScript, "YXBOARD", "Rapfi board protocol");
assertIncludes(gameScript, "INFO STRENGTH", "difficulty control");
assertIncludes(workerScript, "rapfi-single.js", "Rapfi engine asset");
assertIncludes(workerScript, "rapfi.data", "Rapfi NNUE data remap");
assertIncludes(workerScript, "sha256-", "content-addressed engine cache key");
assertIncludes(toolsPage, "/games/gomoku/index.html", "web launcher");
assertIncludes(syncScript, "\"gomoku\"", "Android web-only exclusion");
assertIncludes(serverConfig, '".wasm": "application/wasm"', "WASM MIME type");

if (/gomoku|五子棋/i.test(androidTools)) {
  throw new Error("gomoku: Android tool launcher must not expose the web-only game");
}

console.log(`gomoku: ok (${requiredFiles.length} files, Rapfi assets verified, Android excluded)`);

function read(relativePath) {
  return fs.readFileSync(path.join(root, ...relativePath.split("/")), "utf8");
}

function hashableAssetBytes(relativePath, bytes) {
  if (!relativePath.endsWith(".js")) return bytes;
  // Git may check this text asset out as CRLF on Windows; its engine bytes are otherwise unchanged.
  return Buffer.from(bytes.toString("utf8").replace(/\r\n?/g, "\n"), "utf8");
}

function assertIncludes(text, expected, label) {
  if (!text.includes(expected)) throw new Error(`gomoku: missing ${label}`);
}
