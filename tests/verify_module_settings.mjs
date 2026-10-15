import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverFanHaoModules } from "../src/fanhao/module-registry.js";
import { createFanhaoSettingsProvider } from "../src/modules/fanhao/server/settings/index.js";
import { createMediaSettingsProvider } from "../src/modules/media/server/settings.js";
import { createPhotosSettingsProvider } from "../src/modules/photos/server/settings.js";
import { createAdminSettingsService } from "../src/modules/system/server/admin-settings-service.js";
import { createAppConfigService } from "../src/modules/system/server/app-config-service.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-module-settings-"));

try {
  fs.writeFileSync(path.join(tempRoot, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  const appConfigService = createTestAppConfigService(path.join(tempRoot, "data", "app-config.json"));
  appConfigService.load();
  appConfigService.set({
    compilationPrefixes: ["ABC"],
    compilationKeywords: ["合集"],
    actorAvatarDataPath: "D:\\avatars",
    imageReaderCacheMaxBytes: 4 * 1024 ** 3,
    shortVideoTranscodeConcurrency: 2
  });

  const fanhaoSettings = createFanhaoSettingsProvider({ appConfigService });
  fanhaoSettings.update({ compilationPrefixes: ["new-"] });
  assert.deepEqual(appConfigService.publicConfig(), {
    compilationPrefixes: ["NEW"],
    compilationKeywords: ["合集"],
    actorAvatarDataPath: "D:\\avatars",
    imageReaderCacheMaxBytes: 4 * 1024 ** 3,
    shortVideoTranscodeConcurrency: 2
  }, "FanHao settings updates must preserve settings owned by other modules");

  const photosSettings = createPhotosSettingsProvider({ appConfigService });
  photosSettings.update({ imageReaderCacheMaxBytes: 8 * 1024 ** 3 });
  assert.deepEqual(appConfigService.publicConfig().compilationPrefixes, ["NEW"], "photo settings must patch app config");
  assert.equal(appConfigService.publicConfig().imageReaderCacheMaxBytes, 8 * 1024 ** 3);
  appConfigService.patch({ shortVideoTranscodeConcurrency: 8 });
  assert.equal(appConfigService.shortVideoTranscodeConcurrency(), 4, "short-video transcode concurrency must be persisted and clamped to the supported range");

  let savedCookie = "";
  const doubanCookieService = {
    save(value) {
      savedCookie = String(value || "");
      return this.status();
    },
    status() {
      return {
        exists: Boolean(savedCookie),
        bytes: Buffer.byteLength(savedCookie),
        cookieNames: savedCookie ? ["dbcl2"] : []
      };
    },
    async test() {
      return { ok: true, status: 200, title: "测试详情页" };
    }
  };
  const mediaSettings = createMediaSettingsProvider({ doubanCookieService });
  mediaSettings.update({ doubanCookie: "dbcl2=test-cookie-value" });
  assert.deepEqual(mediaSettings.read().values, {}, "write-only Cookie must not be returned by its provider");
  assert.equal(mediaSettings.read().status.fields.doubanCookie.exists, true);
  assert.equal((await mediaSettings.action("test")).ok, true);

  const modulesDir = path.join(tempRoot, "modules");
  writeFixtureModule(modulesDir, "alpha", fixtureSettingsModule());
  writeFixtureModule(modulesDir, "beta", fixtureModuleWithoutSettings());
  const registry = await discoverFanHaoModules({ modulesDir, context: {}, sendJson() {} });
  const catalog = await registry.settingsCatalog();
  assert.equal(catalog.length, 1, "only modules with a settings provider belong in the settings catalog");
  assert.equal(catalog[0].id, "alpha");
  assert.equal(catalog[0].values.name, "before");
  assert.equal(catalog[0].values.secret, undefined, "registry must redact write-only fields even if a provider returns one");
  assert.equal(catalog[0].values.internal, undefined, "registry must only expose values declared by the module schema");

  const updated = await registry.updateSettings("alpha", { name: "after" });
  assert.equal(updated.values.name, "after");
  assert.equal(updated.values.secret, undefined);
  await assert.rejects(
    registry.updateSettings("alpha", { unknown: true }),
    (error) => error.statusCode === 400 && /unknown/.test(error.message),
    "unknown module settings fields must be rejected"
  );
  await assert.rejects(
    registry.updateSettings("beta", {}),
    (error) => error.statusCode === 404,
    "modules without a settings provider must return 404"
  );

  const action = await registry.runSettingsAction("alpha", "probe", { suffix: "ok" });
  assert.equal(action.result.ok, true);
  assert.equal(action.module.values.name, "after-ok", "actions must return a refreshed module snapshot");
  assert.equal(action.module.values.secret, undefined);

  const adminSettingsService = createAdminSettingsService({
    appConfigService,
    doubanCookieService,
    getModuleRegistry: () => registry
  });
  assert.equal((await adminSettingsService.settingsCatalogPayload()).modules.length, 1);
  const adminUpdated = await adminSettingsService.updateModuleSettingsPayload("alpha", { values: { name: "admin" } });
  assert.equal(adminUpdated.module.values.name, "admin");
  const adminAction = await adminSettingsService.runModuleSettingsActionResponse("alpha", "probe", { suffix: "action" });
  assert.equal(adminAction.statusCode, 200);
  assert.equal(adminAction.payload.module.values.name, "admin-action");

  adminSettingsService.updateConfigPayload({ config: { actorAvatarDataPath: "E:\\avatars" } });
  assert.deepEqual(appConfigService.publicConfig().compilationPrefixes, ["NEW"], "legacy config endpoint must use patch semantics");
  assert.equal(appConfigService.publicConfig().imageReaderCacheMaxBytes, 8 * 1024 ** 3);

  verifyAdminSettingsClientStructure();

  console.log("settings: ok (providers, aggregation, redaction, patching, actions, generic client)");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function createTestAppConfigService(configPath) {
  return createAppConfigService({
    configPath,
    defaultImageReaderCacheMaxBytes: 2 * 1024 ** 3,
    ensureDataDir: () => fs.mkdirSync(path.dirname(configPath), { recursive: true }),
    maxImageReaderCacheMaxBytes: 200 * 1024 ** 3,
    minImageReaderCacheMaxBytes: 128 * 1024 ** 2
  });
}

function writeFixtureModule(modulesDir, id, source) {
  const dir = path.join(modulesDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "module.js"), source, "utf8");
}

function fixtureSettingsModule() {
  return `
let values = { name: "before", secret: "must-not-leak", internal: "must-not-leak" };
export const moduleDefinition = { id: "alpha", title: "Alpha", order: 10 };
export function createModule() {
  return {
    settings: {
      schema: {
        sections: [{
          id: "general",
          title: "General",
          fields: [
            { key: "name", type: "text", label: "Name" },
            { key: "secret", type: "secret", label: "Secret", writeOnly: true }
          ],
          actions: [{ id: "probe", label: "Probe" }]
        }]
      },
      read() { return { values: { ...values }, status: { fields: {} } }; },
      update(next) { values = { ...values, ...next }; },
      action(id, payload) {
        values.name = values.name + "-" + payload.suffix;
        return { ok: id === "probe" };
      }
    }
  };
}
`;
}

function fixtureModuleWithoutSettings() {
  return `
export const moduleDefinition = { id: "beta", title: "Beta", order: 20 };
export function createModule() { return {}; }
`;
}

function verifyAdminSettingsClientStructure() {
  const adminHtml = fs.readFileSync(path.join(root, "public", "admin.html"), "utf8");
  assert(adminHtml.includes('id="adminSettingsRoot"'), "admin settings view must expose the generic settings mount");
  for (const legacyId of [
    "adminCompilationPrefixes",
    "adminCompilationKeywords",
    "adminDoubanCookieInput",
    "adminDoubanCookieBadge",
    "adminImageReaderCacheLimitInput"
  ]) {
    assert(!adminHtml.includes(`id="${legacyId}"`), `admin.html must not keep hard-coded setting field: ${legacyId}`);
  }

  const adminSource = fs.readFileSync(path.join(root, "public", "admin.js"), "utf8");
  for (const businessKey of [
    "compilationPrefixes",
    "compilationKeywords",
    "actorAvatarDataPath",
    "imageReaderCacheMaxBytes"
  ]) {
    assert(!adminSource.includes(businessKey), `admin.js must not know module setting key: ${businessKey}`);
  }
  for (const legacyEndpoint of ["/api/admin/config", "/api/admin/douban-cookie"]) {
    assert(!adminSource.includes(legacyEndpoint), `admin.js must use the generic settings API instead of ${legacyEndpoint}`);
  }

  const controllerPath = path.join(root, "public", "modules", "system", "settings-controller.js");
  assert(fs.statSync(controllerPath, { throwIfNoEntry: false })?.isFile(), "missing generic admin settings controller");
  const controllerSource = fs.readFileSync(controllerPath, "utf8");
  assert(controllerSource.includes("/api/admin/settings"), "settings controller must use the generic settings endpoint");
  for (const businessKey of [
    "compilationPrefixes",
    "compilationKeywords",
    "actorAvatarDataPath",
    "imageReaderCacheMaxBytes",
    "doubanCookie"
  ]) {
    assert(!controllerSource.includes(businessKey), `settings controller must render schema without business key branches: ${businessKey}`);
  }
}
