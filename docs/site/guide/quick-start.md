---
title: 快速开始
description: 从干净副本构建文档，并在隔离资料目录中了解应用启动边界。
status: maintained
verified_at: 2026-08-30
sources:
  - package.json
  - package-lock.json
  - start-fanhao.ps1
  - src/bootstrap/server-config.js
  - src/platform/server/root-config.js
  - src/modules/fanhao/server/library/local-library-index-service.js
  - src/modules/short-videos/server/runtime.js
  - server.js
---

# 快速开始

先选择你要运行的对象：文档站只构建静态页面；FanHao 应用会初始化数据库、启动后台 Worker，并可能扫描资料目录。阅读或修改文档无需启动应用。

## 准备环境

| 工具 | 用途 |
| --- | --- |
| Node.js 24 或更新版本、npm | 项目要求 `node >=24`；服务端使用内置 `node:sqlite`。 |
| Git | 获取干净源码副本，核对变更范围。 |
| Windows PowerShell | 执行本页命令及应用启动脚本。 |
| Python、ffmpeg、ffprobe | 部分应用功能和验证脚本需要；仅构建文档不需要。 |

以下命令在 PowerShell 中执行。尖括号内容必须替换为实际值，不要复制个人机器上的资料路径或凭据作为公共配置。

```powershell
git clone "<repository-url>" "<workspace-directory>"
Set-Location -LiteralPath "<workspace-directory>"
node --version
npm --version
git status --short
```

启动器中旧的 Node 版本错误提示不是支持矩阵；以根目录 `package.json` 的 `engines` 为准。

## 只运行文档站

从仓库根目录执行：

```powershell
npm --prefix docs ci
npm --prefix docs run dev
```

访问终端输出的文档地址。按 `Ctrl+C` 停止开发服务器。
提交前检查内容约束与生产构建：

```powershell
npm --prefix docs run check
npm --prefix docs run build
```

文档依赖和应用依赖分别锁定。不要为了预览文档执行根目录的 `npm start`。
GitHub Pages 只承载文档构建产物，不会运行 Node 服务、SQLite 或本地媒体库。

## 可选：隔离运行应用

::: warning 启动不是只读操作
仅在新克隆的副本中执行下面步骤，不得复制现有 `data/`、下载器运行目录或用户配置。
主数据目录固定为当前副本的 `data/`，目前没有 `FANHAO_DATA_DIR` 开关。
只修改媒体根目录无法隔离已有副本中的数据库。
:::

新开一个 PowerShell 会话，进入干净副本，安装应用依赖：

```powershell
npm ci
```

为所有资料类型准备同一个空目录，并覆盖可能继承的外部数据库路径：

```powershell
$sandboxRoot = Join-Path (Get-Location).Path "tmp\docs-demo"
$emptyMediaRoot = Join-Path $sandboxRoot "empty-media"
New-Item -ItemType Directory -Path $emptyMediaRoot -Force | Out-Null
$rootVariables = @(
  "LIBRARY_ROOTS", "FANHAO_WESTERN_ROOTS", "FANHAO_PHOTO_SET_ROOTS",
  "FANHAO_MOVIE_ROOTS", "FANHAO_TV_ROOTS", "FANHAO_ANIME_ROOTS",
  "FANHAO_SHORT_VIDEO_ROOTS", "FANHAO_SHORT_VIDEO_STORAGE_ROOT",
  "FANHAO_MUSIC_ROOTS", "FANHAO_MANGA_ROOT"
)
foreach ($variableName in $rootVariables) {
  Set-Item -LiteralPath "Env:$variableName" -Value $emptyMediaRoot
}
$env:FANHAO_MANGA_DATABASE = Join-Path $sandboxRoot "manga.sqlite"
$env:FANHAO_CORE_IMAGE_DB = Join-Path $sandboxRoot "core-images.sqlite"
$env:FANHAO_ACCESS_ANALYTICS_DB = Join-Path $sandboxRoot "access-analytics.sqlite"
$env:FANHAO_IP2REGION_XDB = Join-Path $sandboxRoot "ip2region_v4.xdb"
$env:FANHAO_DOUYIN_DOWNLOAD_MANAGER_DB = Join-Path $sandboxRoot "manager.sqlite"
$env:FANHAO_DOUYIN_DOWNLOAD_MANAGER_URL = "http://127.0.0.1:0"
$env:FANHAO_DISABLE_NVENC = "1"
$env:FANHAO_EAGER_PREWARM = "0"
```

这里故意不连接下载管理器；涉及它的操作不可用是预期结果。
`-SkipDownloadManager` 只阻止启动器拉起下载器，不会关闭主服务的同步逻辑，所以上面同时隔离了数据库和地址。

确认测试端口空闲后，只监听本机并前台启动：

```powershell
Get-NetTCPConnection -LocalPort 30998 -State Listen -ErrorAction SilentlyContinue
.\start-fanhao.ps1 -Port 30998 -HostName "127.0.0.1" -SkipDownloadManager -Foreground
```

如果端口已被占用，换一个空闲端口；不要添加 `-Restart` 来解决试跑冲突。
访问 `http://127.0.0.1:30998`；空资料库是预期状态。
不要在演示环境中导入真实资料、填写 Cookie、运行采集或执行管理页写入作业。

按 `Ctrl+C` 停止前台服务，关闭该 PowerShell 会话以丢弃临时环境变量。
演示仍会在副本中写入数据库、缓存与日志；这不是零写入沙箱。
清理目录前必须核对其绝对路径，不能把示例清理扩大到现有资料库。

## 下一步

- 修改代码前阅读[开发流程](./development.md)和[AI 上下文](../ai/context.md)。
- 了解模块关系请看[架构概览](../architecture/overview.md)。
- 部署真实资料库前阅读[配置参考](../reference/configuration.md)与[运行维护](./operations.md)。
- 选择验证命令时使用[验证矩阵](../reference/verification.md)。
