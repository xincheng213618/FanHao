---
title: 独立产品与文件工作流
description: 番号、短视频与聚合应用的启动、数据所有权及整理迁移界面。
status: maintained
verified_at: 2026-09-20
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
  - tools/verify_product_boundaries.mjs
  - tools/verify_file_workflows.mjs
  - tools/verify_file_workflows_ui.mjs
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
$env:FANHAO_WORKFLOW_ROOTS = @(
  (Resolve-Path '.\deploy\fanhao\incoming').Path
  (Resolve-Path '.\deploy\fanhao\organized').Path
) -join ';'
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

## 整理与迁移界面

聚合应用和独立番号均提供 `/fanhao/file-workflows`，可从番号侧栏或后台进入。所有任务接口要求本机或局域网同源管理员权限。

1. 115 完成本地下载后，填入源目录与目标目录。两者需已存在，位于 `FANHAO_WORKFLOW_ROOTS`，且不能相同或互相包含。未设置时沿用番号资料根目录。
2. 选择“按番号整理”或“保持结构迁移”。整理从源目录第一层名称识别唯一番号，在目标目录下创建番号目录，保留原文件名、分段与相对层级；不做在线元数据补全或演员归类。
3. 生成预览，逐项检查源文件、目标路径、大小与保留原因。预览只保存任务记录，不改动媒体文件。
4. 确认后执行。按文件显示进度；可在当前文件结束后停止，并从历史记录继续。服务重启不会自动执行旧计划。

任务保存在产品数据目录的 `file-workflows/`。执行采用复制、SHA-256 校验、无覆盖发布、持久化回执后移除源文件；不删除空目录。目标文件系统需要支持硬链接以实现无覆盖发布，不支持时任务停止并保留源文件。跨卷移动通过复制完成，需要足够的目标空间。

同名冲突、下载未完成、目录链接以及已入库文件会保留原位。已入库检查直接查询 `local_files`，不依赖页面是否加载过资料库；预览后再次执行会重新检查。不要对同一目录同时运行下载、扫描入库或其他文件整理程序。

已入库作品从作品详情发起原有“作品迁移”，由 `work_move_jobs` 流程同步数据库关系与路径；新的通用文件迁移不替代这项业务操作。原 `tools/fanhao.py`、`tools/movefile.py` 没有直接暴露到网页执行。

CLI `tools/fanhao_file_workflows.mjs` 与网页使用同一个计划协议。必须显式传入 `--data-dir`、`--root` 和 `--core-db`，核心库只读打开以保护已入库文件；`--help` 显示预览与按计划 ID 执行的参数。独立番号的旧作业入口仅保留已绑定本产品数据库和根目录的脚本。

## 验证与下一步

```powershell
npm run verify:products
node tools/verify_product_boundaries.mjs --browser
npm run verify:file-workflows
npm run verify:file-workflows-ui
```

产品验证在临时源码副本、临时 SQLite 和随机端口测试独立启动、聚合启动、模块隔离与停机。文件任务验证覆盖冲突、源文件变化、已入库拦截、中断恢复和锁；浏览器验证使用合成小文件，涵盖预览、取消、确认、记录恢复及窄屏布局。它们不代表真实媒体、大文件、NAS 文件系统或远程部署验收。

后续迭代可依次完成：下载器文件同步的 API 化、115 下载适配器、番号装配入口继续内聚、按产品打包发布和独立 Android 客户端。每一步保留聚合装配方式，不引入共享业务库。
