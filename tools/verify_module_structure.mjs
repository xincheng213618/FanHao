import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverFanHaoModuleDefinitions } from "../src/fanhao/module-registry.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulesDir = path.join(root, "src", "modules");
const platformDir = path.join(root, "src", "platform");
const definitions = await discoverFanHaoModuleDefinitions({ modulesDir });
const byId = new Map(definitions.map((definition) => [definition.id, definition]));
const requiredModules = ["fanhao", "photos", "media", "novels", "short-videos", "tools"];

for (const id of requiredModules) {
  const definition = byId.get(id);
  assert(definition, `missing FanHao module: ${id}`);
  assert(definition.visible, `user module must be visible: ${id}`);
  assert(definition.client.web, `missing Web surface: ${id}`);
  assert(definition.client.android, `missing Android surface: ${id}`);
  assert(fs.statSync(path.join(modulesDir, id, "server"), { throwIfNoEntry: false })?.isDirectory(), `missing server folder: ${id}`);
  assert(fs.statSync(path.join(root, "public", "modules", id), { throwIfNoEntry: false })?.isDirectory(), `missing Web module folder: ${id}`);
  assert(fs.statSync(path.join(root, "android-client", "www", "modules", id), { throwIfNoEntry: false })?.isDirectory(), `missing Android module folder: ${id}`);
}

assert.equal(new Set(definitions.map((definition) => definition.id)).size, definitions.length, "module ids must be unique");
assert.deepEqual(
  [...definitions].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id, "en")).map((definition) => definition.id),
  definitions.map((definition) => definition.id),
  "module discovery order must be stable"
);
assert.equal(byId.get("fanhao")?.client.web.href, "/fanhao", "FanHao Web module must use its own top-level path");

const webShortVideoDir = path.join(root, "public", "modules", "short-videos");
const webShortVideoSearchModule = path.join(webShortVideoDir, "search", "index.js");
assert(fs.statSync(webShortVideoSearchModule, { throwIfNoEntry: false })?.isFile(), "missing Web short-video search module");
const webShortVideoPageSource = fs.readFileSync(path.join(webShortVideoDir, "short-video-page.js"), "utf8");
assert(webShortVideoPageSource.includes('from "./search/index.js'), "Web short-video page must use the shared search module");
assert(!webShortVideoPageSource.includes("shortVideoSearchSuggestTimer"), "Web short-video page must not keep duplicate search controller state");

const legacyServerDir = path.join(root, "src", "server");
const legacyFiles = fs.statSync(legacyServerDir, { throwIfNoEntry: false })?.isDirectory()
  ? fs.readdirSync(legacyServerDir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
  : [];
assert.equal(legacyFiles.length, 0, "legacy src/server files must stay empty");

const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
assert(!serverSource.includes("/src/server/"), "server.js must not import the legacy src/server tree");
assert(!/create[A-Za-z]+Module\s*\(/.test(serverSource), "server.js must not construct business modules directly");

const webAppSource = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
assert(
  !/productNav\?\.addEventListener\(\s*["']click["']/.test(webAppSource),
  "Web module navigation must use full document links instead of SPA click interception"
);
const webNavigationSource = fs.readFileSync(path.join(root, "public", "js", "module-navigation.js"), "utf8");
assert(
  webNavigationSource.includes('link.dataset.moduleNavigation = "window"'),
  "generated Web module links must declare window navigation"
);
assert(
  webNavigationSource.includes('link.target = "_blank"') && webNavigationSource.includes('link.rel = "noopener"'),
  "every generated Web module link must open safely in a new tab or window"
);
const fallbackModuleLinks = [...fs.readFileSync(path.join(root, "public", "index.html"), "utf8").matchAll(/<a\s+class="product-tab[^>]+>/g)];
assert(fallbackModuleLinks.length >= requiredModules.length, "missing fallback Web module links");
for (const [link] of fallbackModuleLinks) {
  assert(link.includes('target="_blank"'), `fallback Web module link must open a new tab or window: ${link}`);
  assert(link.includes('rel="noopener"'), `fallback Web module link must isolate the opener: ${link}`);
}

const shortVideoClientDir = path.join(root, "android-client", "www", "modules", "short-videos");
const requiredShortVideoParts = [
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
for (const relativePath of requiredShortVideoParts) {
  assert(
    fs.statSync(path.join(shortVideoClientDir, relativePath), { throwIfNoEntry: false })?.isFile(),
    `missing Android short-video module part: ${relativePath}`
  );
}
const shortVideoFacade = fs.readFileSync(path.join(shortVideoClientDir, "short-video-views.js"), "utf8").trim();
assert(/^export \{ createShortVideoViews \} from /.test(shortVideoFacade), "short-video-views.js must stay a compatibility facade");
for (const filePath of sourceFiles(shortVideoClientDir)) {
  const lineCount = fs.readFileSync(filePath, "utf8").split(/\r?\n/).length;
  assert(lineCount <= 600, `Android short-video JS file is too large (${lineCount} lines): ${relative(filePath)}`);
}

for (const filePath of sourceFiles(platformDir)) {
  for (const target of relativeImportTargets(filePath)) {
    assert(!isWithin(target, modulesDir), `platform must not import a business module: ${relative(filePath)} -> ${relative(target)}`);
  }
}

for (const definition of definitions) {
  const ownDir = path.join(modulesDir, definition.id);
  for (const filePath of sourceFiles(ownDir)) {
    for (const target of relativeImportTargets(filePath)) {
      if (!isWithin(target, modulesDir) || isWithin(target, ownDir)) continue;
      assert.fail(`module must not import another module's internals: ${relative(filePath)} -> ${relative(target)}`);
    }
  }
}

console.log(`module-structure: ok (${definitions.length} discovered, ${requiredModules.length} required)`);

function sourceFiles(dir) {
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:js|mjs)$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function relativeImportTargets(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const targets = [];
  const importPattern = /(?:from\s*|import\s*\()(["'])(\.\.?\/[^"']+)\1/g;
  for (const match of source.matchAll(importPattern)) {
    targets.push(path.resolve(path.dirname(filePath), match[2].split("?")[0]));
  }
  return targets;
}

function isWithin(candidate, parent) {
  const value = path.relative(parent, candidate);
  return value === "" || (!value.startsWith(`..${path.sep}`) && value !== "..");
}

function relative(filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, "/");
}
