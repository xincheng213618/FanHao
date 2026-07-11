import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverFanHaoModuleDefinitions } from "../src/fanhao/module-registry.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulesDir = path.join(root, "src", "modules");
const platformDir = path.join(root, "src", "platform");
const androidClientDir = path.join(root, "android-client", "www");
const androidModulesDir = path.join(androidClientDir, "modules");
const androidPlatformDir = path.join(androidClientDir, "platform");
const definitions = await discoverFanHaoModuleDefinitions({ modulesDir });
const byId = new Map(definitions.map((definition) => [definition.id, definition]));
const requiredModules = ["fanhao", "photos", "media", "novels", "short-videos", "music", "tools"];

for (const id of requiredModules) {
  const definition = byId.get(id);
  assert(definition, `missing FanHao module: ${id}`);
  assert(definition.visible, `user module must be visible: ${id}`);
  assert(definition.client.web, `missing Web surface: ${id}`);
  assert(definition.client.android, `missing Android surface: ${id}`);
  assert(fs.statSync(path.join(modulesDir, id, "server"), { throwIfNoEntry: false })?.isDirectory(), `missing server folder: ${id}`);
  assert(fs.statSync(path.join(root, "public", "modules", id), { throwIfNoEntry: false })?.isDirectory(), `missing Web module folder: ${id}`);
  assert(fs.statSync(path.join(root, "android-client", "www", "modules", id), { throwIfNoEntry: false })?.isDirectory(), `missing Android module folder: ${id}`);
  const androidEntry = String(definition.client.android.entry || "").replace(/^\.\//, "");
  assert(androidEntry === `modules/${id}/android-module.js`, `Android module entry must follow the module folder convention: ${id}`);
  const androidEntryPath = path.join(root, "android-client", "www", androidEntry);
  assert(fs.statSync(androidEntryPath, { throwIfNoEntry: false })?.isFile(), `missing Android module entry: ${androidEntry}`);
  assert(fs.readFileSync(androidEntryPath, "utf8").includes("createAndroidModule"), `Android module entry must export createAndroidModule(): ${id}`);
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

const androidAppSource = fs.readFileSync(path.join(root, "android-client", "www", "app.js"), "utf8");
assert(!/from\s+["']\.\/modules\//.test(androidAppSource), "Android shell must not statically import business modules");
assert(androidAppSource.includes("loadAndroidModules("), "Android shell must load module entries through the registry");
const androidRegistrySource = fs.readFileSync(path.join(root, "android-client", "www", "js", "android-module-registry.js"), "utf8");
assert(androidRegistrySource.includes("await import(entryUrl)"), "Android module registry must dynamically import discovered entries");
assert(androidRegistrySource.includes("renderChrome(view"), "Android module registry must delegate module chrome rendering");
const androidIndexSource = fs.readFileSync(path.join(root, "android-client", "www", "index.html"), "utf8");
assert(!androidIndexSource.includes('id="topSearchButton"'), "Android shell must not own a global search button");
assert(!androidIndexSource.includes('id="topModuleActions"'), "Android shell must not own a shared module action layout");
assert(!androidIndexSource.includes('id="fanhaoSectionNav"'), "Android shell must not own business secondary navigation");
assert(/<header id="moduleChrome"[^>]*><\/header>/.test(androidIndexSource), "Android shell must expose only an empty module chrome mount");
for (const text of ["搜番号、作品或人物", "搜套图、人物或分类", "搜电影或电视剧", "搜短视频标题、作者或标签"]) {
  assert(!androidAppSource.includes(text), `Android shell must not own module search copy: ${text}`);
}
for (const id of ["fanhao", "photos", "media"]) {
  const entrySource = fs.readFileSync(path.join(androidModulesDir, id, "android-module.js"), "utf8");
  assert(entrySource.includes("createSearchController(host"), `Android module must own its search controller: ${id}`);
  assert(entrySource.includes("renderChrome"), `Android module must own its chrome rendering: ${id}`);
  assert(entrySource.includes("host.ui.openSearch"), `Android module must wire its own search entry: ${id}`);
}
const androidShortVideoEntry = fs.readFileSync(path.join(androidModulesDir, "short-videos", "android-module.js"), "utf8");
assert(androidShortVideoEntry.includes('view: "shortVideoSearch"'), "short videos must own a dedicated Android search route");
assert(androidShortVideoEntry.includes("short-video-chrome-row"), "short videos must own its compact one-row chrome");
assert(!androidShortVideoEntry.includes("host.ui.openSearch"), "short videos must not reopen the shared shell search surface");
assert(
  fs.readFileSync(path.join(androidModulesDir, "novels", "android-module.js"), "utf8").includes("renderNovelChrome"),
  "novels must own its source switcher chrome"
);
assert(!androidAppSource.includes("FANHAO_TOP_TABS"), "Android shell must not keep FanHao chrome definitions");
assert(!androidAppSource.includes("setTopSecondaryTabs"), "Android shell must not implement module secondary tabs");
const androidNavigationOrder = requiredModules
  .map((id) => byId.get(id))
  .sort((a, b) => Number(a.client.android.order ?? a.order) - Number(b.client.android.order ?? b.order))
  .map((definition) => definition.id);
assert.deepEqual(
  androidNavigationOrder,
  ["fanhao", "photos", "media", "short-videos", "novels", "music", "tools"],
  "short videos must stay in the center of the seven-item Android navigation"
);
assert(
  fs.readFileSync(path.join(androidModulesDir, "music", "music-views.js"), "utf8").includes("music-mobile-search-pill"),
  "music must keep search inside its own module surface"
);
assert(
  fs.readFileSync(path.join(androidModulesDir, "novels", "novel-views.js"), "utf8").includes("novel-mobile-search-pill"),
  "novels must keep search inside its own module surface"
);

const webStylePaths = [
  "css/foundation.css",
  "modules/novels/styles.css",
  "css/shell.css",
  "modules/fanhao/styles.css",
  "modules/content-index/styles.css",
  "modules/tools/styles.css",
  "modules/fanhao/work-cards.css",
  "modules/system/admin.css",
  "css/player.css",
  "css/responsive.css",
  "modules/short-videos/styles/list.css",
  "modules/short-videos/styles/viewer.css",
  "modules/short-videos/styles/gallery-navigation.css",
  "modules/short-videos/styles/panels.css",
  "modules/short-videos/styles/responsive.css",
  "modules/music/styles/foundation.css",
  "modules/music/styles/library.css",
  "modules/music/styles/player.css",
  "modules/music/styles/responsive.css"
];
const webStyleEntrySource = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
const webStyleImports = [...webStyleEntrySource.matchAll(/@import\s+["'](\.\/[^"'?]+)(?:\?[^"']*)?["'];/g)]
  .map((match) => match[1]);
assert.deepEqual(
  webStyleImports,
  webStylePaths.map((relativePath) => `./${relativePath}`),
  "Web CSS entry imports must preserve the modular cascade order"
);
assert(
  !fs.statSync(path.join(root, "public", "css", "legacy.css"), { throwIfNoEntry: false }),
  "legacy Web CSS bundle must not return"
);
for (const relativePath of webStylePaths) {
  const filePath = path.join(root, "public", relativePath);
  assert(fs.statSync(filePath, { throwIfNoEntry: false })?.isFile(), `missing Web CSS module: ${relativePath}`);
  const lineCount = fs.readFileSync(filePath, "utf8").split(/\r?\n/).length;
  assert(lineCount <= 4000, `Web CSS module is too large (${lineCount} lines): public/${relativePath}`);
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

for (const filePath of sourceFiles(androidPlatformDir)) {
  for (const target of relativeImportTargets(filePath)) {
    assert(!isWithin(target, androidModulesDir), `Android platform must not import a business module: ${relative(filePath)} -> ${relative(target)}`);
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

for (const definition of definitions.filter((item) => item.client.android)) {
  const ownDir = path.join(androidModulesDir, definition.id);
  for (const filePath of sourceFiles(ownDir)) {
    for (const target of relativeImportTargets(filePath)) {
      if (!isWithin(target, androidModulesDir) || isWithin(target, ownDir)) continue;
      assert.fail(`Android module must not import another module's internals: ${relative(filePath)} -> ${relative(target)}`);
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
