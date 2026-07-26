export const NOVEL_SETTINGS_SCHEMA = Object.freeze({
  version: 1,
  sections: Object.freeze([
    Object.freeze({
      id: "collection-credentials",
      title: "网页采集登录",
      description: "为需要登录或访问验证的小说站点提供本机采集凭据。",
      order: 10,
      fields: Object.freeze([
        Object.freeze({
          key: "aliceswCookie",
          type: "secret",
          label: "爱丽丝书屋 Cookie",
          help: "仅保存在本机，不会通过设置接口、任务记录或日志回显。重新填写会覆盖现有 Cookie。",
          placeholder: "从已登录并通过访问验证的 alicesw.com 页面复制 Cookie",
          rows: 6,
          writeOnly: true
        })
      ]),
      actions: Object.freeze([
        Object.freeze({
          id: "test-alicesw-cookie",
          label: "检测登录状态",
          kind: "secondary",
          busyLabel: "检测中",
          progressLabel: "正在使用采集器检测爱丽丝书屋登录状态"
        }),
        Object.freeze({
          id: "clear-alicesw-cookie",
          label: "清除 Cookie",
          kind: "secondary",
          confirm: "清除本机保存的爱丽丝书屋 Cookie？"
        })
      ])
    })
  ])
});

export function createNovelSettingsProvider({ credentialService }) {
  if (!credentialService) throw new Error("novel settings credentialService is required");

  function read() {
    return {
      values: {},
      status: {
        fields: {
          aliceswCookie: credentialService.aliceswStatus()
        }
      }
    };
  }

  function update(values = {}) {
    if (Object.hasOwn(values, "aliceswCookie")) {
      credentialService.saveAliceswCookie(values.aliceswCookie);
    }
    return read();
  }

  function action(actionId, payload = {}) {
    if (actionId === "test-alicesw-cookie") {
      return credentialService.testAliceswCookie(payload);
    }
    if (actionId === "clear-alicesw-cookie") {
      credentialService.clearAliceswCookie();
      return {
        ok: true,
        message: "已清除爱丽丝书屋 Cookie"
      };
    }
    const error = new Error(`未知的小说设置操作：${actionId}`);
    error.statusCode = 404;
    throw error;
  }

  return {
    schema: NOVEL_SETTINGS_SCHEMA,
    read,
    update,
    action
  };
}
