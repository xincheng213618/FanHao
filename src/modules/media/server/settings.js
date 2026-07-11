export const MEDIA_SETTINGS_SCHEMA = Object.freeze({
  version: 1,
  sections: Object.freeze([
    Object.freeze({
      id: "douban",
      title: "豆瓣数据源",
      description: "为电影和电视剧资料补全作业提供豆瓣访问凭据。",
      order: 10,
      fields: Object.freeze([
        Object.freeze({
          key: "doubanCookie",
          type: "secret",
          label: "豆瓣 Cookie",
          help: "仅保存在本机，不会通过设置接口回显。重新填写会覆盖现有 Cookie。",
          placeholder: "从浏览器复制 douban.com Cookie",
          rows: 6,
          writeOnly: true
        })
      ]),
      actions: Object.freeze([
        Object.freeze({
          id: "test",
          label: "测试详情页",
          kind: "secondary"
        })
      ])
    })
  ])
});

export function createMediaSettingsProvider({ doubanCookieService }) {
  function read() {
    return {
      values: {},
      status: {
        fields: {
          doubanCookie: doubanCookieService.status()
        }
      }
    };
  }

  function update(values = {}) {
    const key = Object.hasOwn(values, "doubanCookie")
      ? "doubanCookie"
      : Object.hasOwn(values, "cookie")
        ? "cookie"
        : "";
    if (key) doubanCookieService.save(values[key]);
    return read();
  }

  async function action(actionId) {
    if (actionId !== "test") {
      const error = new Error(`未知的影视设置操作：${actionId}`);
      error.statusCode = 404;
      throw error;
    }
    const test = await doubanCookieService.test();
    return {
      ok: test.ok,
      message: test.ok ? "豆瓣详情页测试通过" : test.error || "豆瓣 Cookie 不可用",
      error: test.ok ? "" : test.error || "豆瓣 Cookie 不可用",
      test
    };
  }

  return {
    schema: MEDIA_SETTINGS_SCHEMA,
    read,
    update,
    action
  };
}
