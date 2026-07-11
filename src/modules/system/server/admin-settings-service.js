export function createAdminSettingsService({
  appConfigService,
  doubanCookieService,
  getModuleRegistry
}) {
  function configPayload() {
    return { config: appConfigService.publicConfig() };
  }

  function updateConfigPayload(body = {}) {
    appConfigService.patch(body.config || body);
    return { ok: true, config: appConfigService.publicConfig() };
  }

  async function settingsCatalogPayload() {
    return { modules: await moduleRegistry().settingsCatalog() };
  }

  async function updateModuleSettingsPayload(moduleId, body = {}) {
    const values = Object.hasOwn(body || {}, "values") ? body.values : body;
    const module = await moduleRegistry().updateSettings(moduleId, values);
    return { ok: true, module };
  }

  async function runModuleSettingsActionResponse(moduleId, actionId, body = {}) {
    const payload = Object.hasOwn(body || {}, "payload") ? body.payload : body;
    const outcome = await moduleRegistry().runSettingsAction(moduleId, actionId, payload);
    const ok = outcome.result?.ok !== false;
    return {
      statusCode: 200,
      payload: {
        ok,
        module: outcome.module,
        action: {
          id: actionId,
          result: outcome.result
        }
      }
    };
  }

  function doubanCookiePayload() {
    return { ok: true, cookie: doubanCookieService.status() };
  }

  function saveDoubanCookiePayload(body = {}) {
    return { ok: true, cookie: doubanCookieService.save(body.cookie || body.value || "") };
  }

  async function testDoubanCookieResponse() {
    const result = await doubanCookieService.test();
    return {
      statusCode: result.ok ? 200 : 409,
      payload: {
        ok: result.ok,
        cookie: doubanCookieService.status(),
        test: result
      }
    };
  }

  function doubanCookieTestErrorResponse(error) {
    return {
      statusCode: error.statusCode || 500,
      payload: {
        error: error.message || "测试豆瓣 Cookie 失败",
        cookie: doubanCookieService.status()
      }
    };
  }

  function moduleRegistry() {
    const registry = getModuleRegistry?.();
    if (
      !registry ||
      typeof registry.settingsCatalog !== "function" ||
      typeof registry.updateSettings !== "function" ||
      typeof registry.runSettingsAction !== "function"
    ) {
      const error = new Error("模块设置注册表尚未初始化");
      error.statusCode = 503;
      throw error;
    }
    return registry;
  }

  return {
    configPayload,
    doubanCookiePayload,
    doubanCookieTestErrorResponse,
    runModuleSettingsActionResponse,
    saveDoubanCookiePayload,
    settingsCatalogPayload,
    testDoubanCookieResponse,
    updateConfigPayload,
    updateModuleSettingsPayload
  };
}
