# `media` 模块

## 定位

`media` 负责电影、电视剧、动漫和欧美本地视频的元数据详情、封面和播放。列表索引与图库筛选由 `content-index` 提供，媒体详情和播放所有权仍属于本模块。

入口：`src/modules/media/module.js`、`src/modules/media/server/runtime.js`。

## 服务端结构

- `gallery-metadata-service.js`：电影 / 电视剧的详情、封面和元数据呈现。
- `gallery-media-service.js`：影视条目查询、详情和媒体文件解析。
- `routes.js`：`/api/gallery-media/:id` 详情接口。
- `runtime.js`：媒体封面、直接播放和转码路由。

Web 与图库共用 `public/modules/content-index/`，由 `galleryMode=media`、`movie`、`tv` 等路由状态区分视图。Android 通过 `channel: media` 接入同一服务端能力。

## API 与媒体

- `GET /api/gallery-media/:id`：读取一个媒体条目的详情。
- `/media/tv-series-cover/:id`、`/media/movie-cover/:id`：剧集 / 电影封面。
- `/media/gallery-media-cover/:id`：媒体条目封面。
- `/media/gallery-video/:id`：直接播放本地视频。
- `/media/gallery-video/:id/transcode`：通过平台媒体流服务转码播放。

媒体响应必须继续使用 `src/platform/server/media-stream-service.js` 和文件安全检查；模块不应自行拼接未经验证的本地路径。

## 数据与配置

影视来源由 `GALLERY_MEDIA_SOURCES` 解析，默认包含电影、电视剧和动漫根目录；元数据和条目索引使用 `data/image-gallery.sqlite` 等图库数据资源。路径覆盖方式见 [项目配置](../configuration.md)。

## 修改与验证

```powershell
npm run verify:library-merge
npm run verify:video-playback
npm run verify:gallery-db
npm run verify:works-performance
```

修改前端列表时同时检查 `public/modules/content-index/`；修改播放时还要覆盖 Range 请求、转码和不存在文件三类场景。
