export const FANHAO_SETTINGS_SCHEMA = Object.freeze({
  version: 1,
  sections: Object.freeze([
    Object.freeze({
      id: "collection-rules",
      title: "合集规则",
      description: "用于识别番号合集、总集和完整系列。",
      order: 10,
      fields: Object.freeze([
        Object.freeze({
          key: "compilationPrefixes",
          type: "string-list",
          label: "番号前缀",
          help: "每行一个前缀；保存时会去重、移除分隔符并转为大写。",
          placeholder: "OFJE\nTHN\nTHU",
          rows: 10
        }),
        Object.freeze({
          key: "compilationKeywords",
          type: "string-list",
          label: "标题关键词",
          help: "每行一个关键词；标题命中任意关键词时会被识别为合集。",
          placeholder: "合集\n総集編\nコンプリート",
          rows: 10
        })
      ]),
      actions: Object.freeze([])
    }),
    Object.freeze({
      id: "actor-avatars",
      title: "演员头像",
      description: "设置本地头像候选数据的扫描目录。",
      order: 20,
      fields: Object.freeze([
        Object.freeze({
          key: "actorAvatarDataPath",
          type: "path",
          label: "头像数据目录",
          help: "演员头像预览、扫描和导入操作会从这个目录读取候选图片。",
          placeholder: "例如 D:\\ActorAvatars"
        })
      ]),
      actions: Object.freeze([])
    })
  ])
});

export function createFanhaoSettingsProvider({ appConfigService }) {
  function read() {
    const config = appConfigService.publicConfig();
    return {
      values: {
        compilationPrefixes: [...config.compilationPrefixes],
        compilationKeywords: [...config.compilationKeywords],
        actorAvatarDataPath: config.actorAvatarDataPath || ""
      },
      status: { fields: {} }
    };
  }

  function update(values = {}) {
    const next = {};
    for (const key of ["compilationPrefixes", "compilationKeywords", "actorAvatarDataPath"]) {
      if (Object.hasOwn(values, key)) next[key] = values[key];
    }
    if (Object.keys(next).length) appConfigService.patch(next);
    return read();
  }

  return {
    schema: FANHAO_SETTINGS_SCHEMA,
    read,
    update
  };
}
