# `music` 模块

## 定位

`music` 负责本地音乐扫描、元数据、搜索、筛选、歌词搜索、播放历史、收藏、评分、歌单、智能歌单和 M3U 导入 / 导出。入口是 `src/modules/music/module.js`，runtime 是 `src/modules/music/server/runtime.js`。

## 服务端结构

- `store.js`：模块对外的存储门面和生命周期。
- `schema.js`、`write-transaction.js`：SQLite schema 和串行写事务。
- `scan.js`、`scan-service.js`、`scan-worker*.js`：音乐根目录扫描、ffprobe 元数据读取和后台 worker。
- `query.js`、`search.js`、`facets.js`、`smart-mix.js`：列表、搜索、聚合和智能播放。
- `serializers.js`、`public-errors.js`：对外 payload 和稳定错误。
- `routes.js`：API；`runtime.js`：封面、音频流和下载媒体路由。

Web 页面在 `public/modules/music/`，Android 页面在 `android-client/www/modules/music/`。扫描是后台任务 / worker 语义，普通读取不应触发全库同步扫描。

## API 与媒体

- `/api/music/summary`、`/facets`、`/report`、`/suggest`：概览、筛选、报表和建议。
- `/api/music/artists`、`/albums`、`/tracks`：音乐库查询。
- `/api/music/playlists*`、`/smart-playlists*`：歌单、智能歌单和 M3U。
- `/api/music/history`、`/tracks/:id/progress`、`favorite`、`rating`：用户状态。
- `POST /api/music/rescan`：启动重扫。
- `/media/music-cover/:id`、`/media/music/:id`、`/media/music-download/:id`：封面、Range 音频流和下载。

音频流使用平台媒体响应服务，并限制单次 Range 大小；下载文件名由服务端清理，不能直接信任用户可控的元数据。

## 数据与配置

- `data/music.sqlite`：音乐主库。
- `FANHAO_MUSIC_ROOTS`：音乐根目录。
- `ffprobe`：读取音频时长、编码和元数据，可通过 `FFPROBE_PATH` 覆盖。

## 修改与验证

```powershell
npm run verify:music-rescan-worker
npm run verify:music-scale
npm run verify:video-playback
npm run verify:settings
```

音乐模块的媒体接口虽复用“video”流式基础设施，但业务上是音频；修改时要同时覆盖 `GET`、`HEAD`、Range 和下载场景。
