import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createShortVideoViews } from "../android-client/www/modules/short-videos/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleDir = path.join(root, "android-client", "www", "modules", "short-videos");
const requiredParts = [
  "api.js",
  "index.js",
  "shared.js",
  "list/controller.js",
  "list/view.js",
  "panels/author-panel.js",
  "panels/playback-panels.js",
  "platform/native-player.js",
  "player/interactions.js",
  "player/media-cache.js",
  "player/native-feed.js",
  "player/reel-controller.js",
  "ui/icons.js",
  "styles/list.css",
  "styles/reel.css",
  "styles/author-panel.css",
  "styles/playback-panels.css"
];

for (const relativePath of requiredParts) {
  assert(fs.statSync(path.join(moduleDir, relativePath), { throwIfNoEntry: false })?.isFile(), `missing short-video part: ${relativePath}`);
}

const facade = fs.readFileSync(path.join(moduleDir, "short-video-views.js"), "utf8").trim();
assert(/^export \{ createShortVideoViews \} from /.test(facade), "short-video-views.js must stay a compatibility facade");
for (const filePath of sourceFiles(moduleDir)) {
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).length;
  assert(lines <= 600, `short-video JS file exceeds 600 lines: ${relative(filePath)} (${lines})`);
}
verifyFeatureReferences();
verifySharedImports();

const styles = fs.readFileSync(path.join(moduleDir, "styles.css"), "utf8");
for (const style of ["list", "reel", "author-panel", "playback-panels"]) {
  assert(styles.includes(`./styles/${style}.css`), `missing short-video CSS import: ${style}`);
}

const views = createShortVideoViews({
  els: {},
  getActiveUrl: () => "http://127.0.0.1:29998",
  goBack() {},
  setActiveBottom() {},
  showView() {}
});
assert.deepEqual(
  Object.keys(views).sort(),
  ["clearSearchFilters", "deactivate", "getSearchState", "renderBrowser", "renderList", "renderSearchFilters", "submitSearch"],
  "short-video public contract changed"
);

const appSource = fs.readFileSync(path.join(root, "android-client", "www", "app.js"), "utf8");
assert(appSource.includes("shortVideoViews?.deactivate?.()"), "Android shell must deactivate short-video transient state when leaving the module");

console.log(`short-video-client: ok (${requiredParts.length} parts, ${sourceFiles(moduleDir).length} JS files)`);

function sourceFiles(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:js|mjs)$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function verifyFeatureReferences() {
  const files = sourceFiles(moduleDir).filter((filePath) => !/[\\/]index\.js$/.test(filePath));
  const sources = new Map(files.map((filePath) => [filePath, fs.readFileSync(filePath, "utf8")]));
  const methodNames = new Set();
  const ownMethods = new Map();
  for (const [filePath, source] of sources) {
    const own = new Set([...source.matchAll(/^  (?:async )?function ([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]));
    ownMethods.set(filePath, own);
    for (const name of own) methodNames.add(name);
  }
  for (const [filePath, source] of sources) {
    const own = ownMethods.get(filePath);
    const proxies = new Set([...source.matchAll(/^  const ([A-Za-z_$][\w$]*) = \(\.\.\.args\) => context\./gm)].map((match) => match[1]));
    const missing = [...methodNames].filter((name) => (
      !own.has(name)
      && !proxies.has(name)
      && new RegExp(`\\b${name}\\b`).test(source)
    ));
    assert.equal(missing.length, 0, `missing short-video context proxies in ${relative(filePath)}: ${missing.join(", ")}`);
  }
}

function verifySharedImports() {
  const sharedPath = path.join(moduleDir, "shared.js");
  const sharedSource = fs.readFileSync(sharedPath, "utf8");
  const exported = [...sharedSource.matchAll(/^export (?:const|function) ([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]);
  for (const filePath of sourceFiles(moduleDir)) {
    if (filePath === sharedPath) continue;
    const source = fs.readFileSync(filePath, "utf8");
    const imported = new Set();
    for (const match of source.matchAll(/import \{([^}]+)\} from ["'][^"']*shared\.js[^"']*["']/g)) {
      for (const item of match[1].split(",")) imported.add(item.trim().split(/\s+as\s+/)[0]);
    }
    const missing = exported.filter((name) => new RegExp(`\\b${name}\\b`).test(source) && !imported.has(name));
    assert.equal(missing.length, 0, `missing shared imports in ${relative(filePath)}: ${missing.join(", ")}`);
  }
}

function relative(filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, "/");
}
