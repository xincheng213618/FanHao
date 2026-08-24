# `fanhao` 模块

## 定位

`fanhao` 是核心可见模块，负责人物、番号前缀、作品、榜单、厂商、VR、收藏、观看进度和本地番号资料库。入口是 `src/modules/fanhao/module.js`，由 `src/modules/fanhao/server/runtime.js` 将多个子 runtime 组合起来。

## 服务端分层

```text
fanhao/runtime.js
├── catalog/       番号前缀、榜单、厂商
├── library/       本地根目录、扫描、核心库同步
├── works/         作品查询、详情、封面、播放、迁移
├── people/        人物与演员资料（由 works composition 注入）
├── user-state/    收藏夹、收藏文件夹、播放历史和进度
└── disk-usage/    磁盘用量树、搜索和文件播放
```

`server/composition.js` 是该模块的依赖组合边界。路由只做 URL、方法、权限和响应编排，查询、写入、缓存、文件安全与后台 worker 分别属于对应 service。

## 主要代码入口

- `server/library/`：读取 `LIBRARY_ROOTS`，扫描本地文件并同步 `fanhao-core-v2.sqlite`。
- `server/works/`：作品查询和详情、封面状态、视频探测、作品移动任务与媒体响应。
- `server/people/`：人物列表、别名、作品关联、头像和资料发布生命周期。
- `server/catalog/`：代码前缀、厂商和排行榜。
- `server/user-state/`：用户状态 JSON 的读写与收藏 / 进度接口。
- `server/disk-usage/`：从 `data/disk-usage/` 生成磁盘使用索引，并提供受限播放目标。

Web 控制器位于 `public/modules/fanhao/`，Android 控制器位于 `android-client/www/modules/fanhao/`。两端共享服务端 API，但各自拥有视图、分页和交互状态。

## 主要接口分组

- `/api/library`、`/api/library/roots`、`POST /api/rescan`：资料库状态和扫描。
- `/api/people/*`、`/api/actor-profiles/*`：人物和演员资料。
- `/api/works`、`/api/works/:id`、`/api/fanhao/search`：作品列表、搜索和详情。
- `/api/code-prefixes`、`/api/rankings`、`/api/studios`：目录数据。
- `/api/favorites`、`/api/favorite-folders`、`/api/history`、`/api/progress/:id`：用户状态。
- `/media/person/*`、`/media/work/*`、`/media/video/*`：头像、封面、图片和视频。
- `/api/disk-usage/*`、`/api/disk-usage/media`：磁盘用量和文件预览 / 播放。

作品移动、删除、封面写入和人物资料发布属于变更接口，必须保持根目录校验、预留 / 任务幂等和失败可恢复语义。

## 数据与安全边界

- `data/fanhao-core-v2.sqlite`：作品、人物、文件和关联的权威主库。
- `data/fanhao-core-images.sqlite`：核心图片、封面和头像存储。
- `data/user-state.json`：收藏、收藏夹、观看历史和进度。
- `data/library-index.json`：兼容读取或扫描中间状态，不是主库权威来源。
- 资料库根目录由 `server-config.js` 解析；文件移动和本机打开只能落在允许根目录内。

不要在 `public/app.js` 或 `server.js` 新增领域状态。新增作品能力时优先落在 `server/works/` 或对应子目录，再通过 runtime 暴露。

## 修改与验证

```powershell
npm run verify:fanhao
npm run verify:library-merge
npm run verify:core-images
npm run verify:person-work-associations
npm run verify:work-move-jobs
npm run verify:android-work-move
```

数据结构细节见 [核心数据库](../fanhao-core-database.md)，完整接口见 [API 参考](../api-reference.md)。
