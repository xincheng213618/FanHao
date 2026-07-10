export function createAdminSettingsService({
  appConfigService,
  doubanCookieService
}) {
  function configPayload() {
    return { config: appConfigService.publicConfig() };
  }

  function updateConfigPayload(body = {}) {
    appConfigService.set(body.config || body);
    return { ok: true, config: appConfigService.publicConfig() };
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

  return {
    configPayload,
    doubanCookiePayload,
    doubanCookieTestErrorResponse,
    saveDoubanCookiePayload,
    testDoubanCookieResponse,
    updateConfigPayload
  };
}
