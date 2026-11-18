---
title: 独立产品与文件工作流
description: 番号、短视频与聚合应用的启动、数据所有权及整理迁移界面。
status: maintained
verified_at: 2026-10-23
sources:
  - server.js
  - server-fanhao.js
  - server-short-videos.js
  - src/bootstrap/product-profile.js
  - src/bootstrap/server-config.js
  - src/apps/short-video-server.js
  - src/modules/short-videos/server/product.js
  - src/modules/fanhao/server/admin/product-processes.js
  - src/modules/fanhao/server/workflows/file-workflow-service.js
  - tools/fanhao_file_workflows.mjs
  - tests/verify_product_boundaries.mjs
  - tests/verify_file_workflows.mjs
  - tests/verify_media_intake.mjs
---

# 独立产品与文件工作流

同一份源码提供聚合应用、番号产品和短视频产品三个启动入口。各产品拥有自己的业务数据库、任务记录、配置与缓存；HTTP、鉴权、文件响应等基础代码可以复用。

## 当前运行边界

| 入口 | 默认端口 | 加载的业务 | 默认数据目录 |
| --- | --- | --- | --- |
| `npm start` | 29998 | 全部已发现模块 | `data/` |
| `npm run start:fanhao` | 29997 | 番号及其管理模块 | `data/products/fanhao/` |
| `npm run start:short-videos` | 29996 | 短视频 | `data/products/short-videos/` |

注册器在导入前过滤未启用模块。番号入口不要求安装短视频、图库或影视的业务源码；短视频入口不加载番号库。Web 导航读取产品信息，独立短视频页只显示本产品入口。

聚合应用仍在一个进程内装配各业务；本轮没有引入跨服务网关、统一业务数据库或新的 Android 安装包。代码仍在同一仓库，尚未制作独立发布包。

```text
聚合入口 ── 番号运行时 ── 番号库、图片库、文件任务记录
         ├─ 短视频产品 ── 短视频库、设置、缓存 ── 下载管理器
         └─ 其他已注册模块

番号入口 ── 番号运行时 + 管理模块
短视频入口 ── 短视频产品
```

8765 下载管理器属于短视频产品，继续作为独立 Python 进程管理。现有同步还需要下载器 SQLite 的文件访问，因此“查看服务与下载器跨机器部署”尚需后续把这部分协议改为 API。

115 属于番号下载链路。本轮处理的是 **115 下载到本地之后** 的文件整理和迁移，未接管 115 登录、离线下载或下载任务调度。

## 配置独立部署

下列命令会启动真实服务并初始化运行数据。先准备产品目录、媒体根目录和备份，确认配置后再运行。两个入口默认读取仓库 `.env`；独立部署可设 `FANHAO_LOAD_ENV=0` 避免继承聚合应用配置。

番号沿用现有核心库初始化与迁移机制，必须提供已初始化的番号库；入口会拒绝缺失数据库，避免悄悄创建一个无法使用的空库。不要把两个正在运行的实例指向同一个业务库、任务目录或同一批待迁移文件。

```powershell
# 在独立 PowerShell 窗口配置；示例目录应先准备好。
$env:FANHAO_LOAD_ENV = '0'
$env:PORT = '29997'
$env:FANHAO_DATA_DIR = (Resolve-Path '.\deploy\fanhao\data').Path
$env:FANHAO_CORE_DB = Join-Path $env:FANHAO_DATA_DIR 'fanhao-core-v2.sqlite'
$env:FANHAO_CORE_IMAGE_DB = Join-Path $env:FANHAO_DATA_DIR 'fanhao-core-images.sqlite'
$env:LIBRARY_ROOTS = (Resolve-Path '.\deploy\fanhao\library').Path
$env:FANHAO_WESTERN_ROOTS = (Resolve-Path '.\deploy\fanhao\western').Path
npm run start:fanhao
```

短视频首次启动可初始化自己的数据库。媒体目录、下载器库和服务 URL 必须指向这一个产品的配置；下列查看服务不会启动或停止下载器。

```powershell
# 使用另一个 PowerShell 窗口。
$env:FANHAO_LOAD_ENV = '0'
$env:PORT = '29996'
$env:FANHAO_DATA_DIR = (Resolve-Path '.\deploy\short-videos\data').Path
$env:FANHAO_SHORT_VIDEO_DB = Join-Path $env:FANHAO_DATA_DIR 'short-videos.sqlite'
$env:FANHAO_SHORT_VIDEO_ROOTS = (Resolve-Path '.\deploy\short-videos\media').Path
$env:FANHAO_DOUYIN_DOWNLOAD_MANAGER_DB = (Resolve-Path '.\deploy\short-videos\downloader\douyin_downloads.sqlite').Path
$env:FANHAO_DOUYIN_DOWNLOAD_MANAGER_URL = 'http://127.0.0.1:8765'
npm run start:short-videos
```

短视频数据库旁的 `short-video-settings.json`、`short-video-cache/` 由短视频产品管理。未保存新设置时兼容读取原 `app-config.json` 的转码并发数；后续短视频设置写入自己的配置。旧共享缓存不会自动搬迁或删除。

## 媒体工作台与维护

聚合应用和独立番号均提供 `/fanhao/file-workflows/intake` 的视频洗版工作台。追加 `?mode=subtitle` 可进入字幕工作台。已入库作品可从作品详情发起“作品迁移”，由 `work_move_jobs` 同步数据库关系与文件路径。

通用文件整理与迁移可通过 CLI `tools/fanhao_file_workflows.mjs` 运行。必须显式传入 `--data-dir`、`--root` 和 `--core-db`。CLI 以只读方式查询核心库，保护已入库文件。运行 `--help` 可查看预览和按计划 ID 执行的参数。

## 验证与下一步

```powershell
npm run verify:products
node tests/verify_product_boundaries.mjs --browser
npm run verify:file-workflows
npm run verify:file-workflows-ui
```

产品验证在临时源码副本、临时 SQLite 和随机端口测试独立启动、聚合启动、模块隔离与停机。文件任务和媒体洗版验证使用合成小文件，覆盖路径校验、冲突、源文件变化与中断恢复。

后续迭代可依次完成：下载器文件同步的 API 化、115 下载适配器、番号装配入口继续内聚、按产品打包发布和独立 Android 客户端。每一步保留聚合装配方式，不引入共享业务库。
