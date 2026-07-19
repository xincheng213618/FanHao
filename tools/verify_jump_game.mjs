import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gameDir = path.join(root, "public", "games", "jump");
const expectedHashes = new Map([
  ["game.a87e6d4f5755295c82b3.js", "82014F2E5DD5313AD34AE488D2153AD88A22C12C8F5AF859A9D35C9578A264A0"],
  ["0b7ad37eac63107aeb707520cf10b767.png", "27404413D90DD7A9EB678CF2DF3CD63DA6ED4CB055F2F06645E916FC43D78A81"],
  ["349533ed9ebae3a86ef292f1734a7efe.png", "BF40E304EE7B9EE9A91C705B138BF8A8CA98C2ED3B4FE16D431A832E8F964CC4"],
  ["7bf96ad7032433459122820f4d30f7ff.png", "59CE775394E8DFA7ADB566F5B708307B4D59FC7D92492267C3DDE3CA64CA16F6"],
  ["cec7d7ba250ca964e427ba27f9b8ffa1.png", "9CFAB72F67A153D13A6BA3DFC30FD0B66A50C8DEDF794AD048D4F9723742F0D3"],
  ["ffe59deadc96a77fc0e5760bcf6c4bea.png", "A28B13172C3EF4A0CA91F7015980DF699F603559CD19608E7FD88E6B077F2961"]
]);

const requiredFiles = [
  "index.html",
  "styles.css",
  "integration.js",
  "README.md",
  "SOURCE.txt",
  "LICENSE.txt",
  "UPSTREAM-README.md",
  "source/index.js",
  "source/index.css",
  "source/config/constant.js",
  "source/object/JumpGame.js",
  "source/object/LittleMan.js",
  "source/object/Stage.js",
  ...expectedHashes.keys()
];

for (const relativePath of requiredFiles) {
  const filePath = path.join(gameDir, ...relativePath.split("/"));
  if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`jump: missing ${relativePath}`);
  }
}

for (const [relativePath, expectedHash] of expectedHashes) {
  const bytes = fs.readFileSync(path.join(gameDir, relativePath));
  const actualHash = crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
  if (actualHash !== expectedHash) {
    throw new Error(`jump: hash mismatch for ${relativePath}: ${actualHash}`);
  }
}

const runtimeBundles = fs.readdirSync(gameDir).filter((name) => /^game\..+\.js$/.test(name));
if (runtimeBundles.length !== 1 || runtimeBundles[0] !== "game.a87e6d4f5755295c82b3.js") {
  throw new Error(`jump: unexpected runtime bundles: ${runtimeBundles.join(", ")}`);
}

const indexHtml = read("public/games/jump/index.html");
const integrationScript = read("public/games/jump/integration.js");
const littleManSource = read("public/games/jump/source/object/LittleMan.js");
const stageSource = read("public/games/jump/source/object/Stage.js");
const toolsPage = read("public/modules/tools/tools-page.js");
const androidTools = read("android-client/www/modules/tools/tool-views.js");
const syncScript = read("android-client/scripts/sync-shared-assets.mjs");

assertIncludes(indexHtml, "./game.a87e6d4f5755295c82b3.js", "content-addressed runtime bundle");
assertIncludes(indexHtml, "./integration.js", "integration script");
assertIncludes(indexHtml, "href=\"/tools\"", "return navigation");
assertIncludes(integrationScript, "fanhao.jump.best.v1", "persistent best score");
assertIncludes(integrationScript, "fanhao:jump-game-over", "game-over UI event");
assertIncludes(littleManSource, "PointerEvent", "pointer input support");
assertIncludes(littleManSource, "fanhao:jump-score", "score event");
assertIncludes(stageSource, "Math.min(window.devicePixelRatio || 1, 2)", "pixel ratio cap");
assertIncludes(toolsPage, "/games/jump/index.html", "web launcher");
assertIncludes(syncScript, "\"jump\"", "Android web-only exclusion");

if (/web-jump|蓄力跳台|games\/jump/i.test(androidTools)) {
  throw new Error("jump: Android tool launcher must not expose the web-only game");
}

console.log(`jump: ok (${requiredFiles.length} required files, ${expectedHashes.size} runtime hashes verified, Android excluded)`);

function read(relativePath) {
  return fs.readFileSync(path.join(root, ...relativePath.split("/")), "utf8");
}

function assertIncludes(text, expected, label) {
  if (!text.includes(expected)) throw new Error(`jump: missing ${label}`);
}
