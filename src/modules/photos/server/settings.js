export const PHOTOS_SETTINGS_SCHEMA = Object.freeze({
  version: 1,
  sections: Object.freeze([
    Object.freeze({
      id: "reader-cache",
      title: "图库阅读缓存",
      description: "控制压缩包图片抽取后的本地阅读缓存占用。",
      order: 10,
      fields: Object.freeze([
        Object.freeze({
          key: "imageReaderCacheMaxBytes",
          type: "bytes",
          label: "缓存上限",
          help: "设置为 0 时不保留阅读缓存；正数会限制在 128 MiB 到 200 GiB。",
          min: 0,
          max: 200,
          step: 0.25,
          unit: "GiB"
        })
      ]),
      actions: Object.freeze([])
    })
  ])
});

export function createPhotosSettingsProvider({ appConfigService }) {
  function read() {
    const config = appConfigService.publicConfig();
    return {
      values: {
        imageReaderCacheMaxBytes: config.imageReaderCacheMaxBytes
      },
      status: { fields: {} }
    };
  }

  function update(values = {}) {
    if (Object.hasOwn(values, "imageReaderCacheMaxBytes")) {
      appConfigService.patch({ imageReaderCacheMaxBytes: values.imageReaderCacheMaxBytes });
    }
    return read();
  }

  return {
    schema: PHOTOS_SETTINGS_SCHEMA,
    read,
    update
  };
}
