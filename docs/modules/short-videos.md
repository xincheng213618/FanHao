# `short-videos` 模块

## 定位

`short-videos` 负责短视频信息流、搜索、作者、关注、收藏、评论、观看记录、删除任务和本地播放。入口是 `src/modules/short-videos/module.js`，核心 runtime 是 `src/modules/short-videos/server/runtime.js`。

## 服务端结构

- `store.js`、`schema.js`：短视频 SQLite 的 schema、查询和写入。
- `routes.js`：公开 API、集合、评论和动作契约。
- `list-worker.js`、`catalog-worker-client.js`、`list-stats-service.js`：列表、作者目录和统计后台任务。
- `watch-write-service.js`、`watch-write-worker.js`：观看记录异步写入。
- `delete-job-service.js`：删除任务、幂等和恢复。
- `smooth-warmup-worker*.js` 与视频缓存逻辑：流畅版、预热和播放缓存。
- `download-manager-sync-service.js`：与独立的 Douyin 下载管理器同步元数据。

Web 控制器位于 `public/modules/short-videos/`，Android 控制器位于 `android-client/www/modules/short-videos/`。Android 播放和作者页面可由原生活动承接，WebView 只负责列表与交互契约。

## API 与媒体

- `/api/short-videos`、`/summary`、`/facets`、`/suggestions`：列表、统计、筛选和搜索建议。
- `/api/short-videos/:id`、`/related`、`/adjacent`：详情与相邻内容。
- `/api/short-videos/:id/actions/*`、`/author-follow`、`/watch`：用户动作和观看记录。
- `/api/short-videos/collections/*`：集合管理。
- `/api/short-videos/:id/comments*`：评论读取、写入和同步。
- `/api/short-videos/delete-jobs`、`POST /api/short-videos/rescan`：后台删除和重扫。
- `/media/short-video/*`：视频、封面、画廊、音乐和流畅版播放。

播放缓存是可重建产物；删除和观看写入需要保持 worker 幂等、状态可查询和失败可恢复。

## 数据与外部服务

- `data/short-videos.sqlite`：FanHao 短视频主库。
- `FANHAO_SHORT_VIDEO_ROOTS`：本地短视频根目录。
- 下载管理器数据库默认在 `src/modules/short-videos/download-manager/data/douyin_downloads.sqlite`，服务地址默认 `http://127.0.0.1:8765`，可通过 `FANHAO_DOUYIN_DOWNLOAD_MANAGER_DB`、`FANHAO_DOUYIN_DOWNLOAD_MANAGER_URL` 覆盖。
- 播放缓存、封面和临时 worker 产物位于 `data/` 下的可重建目录。

## 修改与验证

```powershell
npm run verify:short-video-store
npm run verify:short-video-actions
npm run verify:short-video-watch-write
npm run verify:short-video-delete-jobs
npm run verify:short-video-runtime
npm run verify:short-video-client
npm run verify:video-playback
```

修改列表查询时同时检查分页、筛选和缓存版本；修改播放时覆盖原始文件、缓存文件、流畅版和转码失败路径。
