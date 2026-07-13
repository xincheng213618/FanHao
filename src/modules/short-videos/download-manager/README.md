# 抖音下载管理器

这是 FanHao 短视频模块的数据采集与下载子模块。管理页面保持为：

- UI：`http://localhost:8765/#home`
- 状态接口：`http://localhost:8765/api/state`
- 数据库：`data/douyin_downloads.sqlite`
- 日志：`logs/`
- 默认媒体库：`D:\Media\ShortVideos`

代码、采集器、管理页面和运行脚本都放在当前目录；运行数据通过仓库根目录的 `.gitignore` 排除。FanHao 会定时从这里的 SQLite 同步已采集、已下载作品到 `data/short-videos.sqlite`。

## 启动

通常直接运行仓库根目录的 `start-fanhao.cmd`，它会同时确保 FanHao 和本模块已经启动。

也可以单独双击 `run.cmd`，或在 PowerShell 中运行：

```powershell
.\run.ps1 -Open
```

首次启动会在当前目录安装 `playwright-core`。下载器继续复用同级工具目录 `Desktop\Tool\douyin-downloader`，数据库中已有的自定义路径设置优先。

## 抖音登录

“配置 → 抖音登录”提供当前登录状态、Cookie 导入、目录打开、状态检测和清除操作。点击“打开 Edge 登录”后，在独立的 Edge 窗口中完成扫码或账号登录，管理器会自动把 Cookie 保存到当前配置的 Cookie 文件并关闭登录窗口。接口和页面只返回 Cookie 名称与状态，不会返回 Cookie 值。

## Windows 安装版

安装版使用独立桌面窗口承载管理页面，关闭窗口或点击“退出程序”都会停止本地后台服务。顶部“查看已下载”和“已下载”页可以直接浏览、播放本机下载完成的视频与图集，并可一键打开对应下载目录，不需要额外运行 FanHao 主服务。

## 数据流

1. 管理页面采集抖音主页链接并写入本模块 SQLite。
2. 下载任务复用 `douyin-downloader`，文件仍写到数据库配置的输出目录。
3. 下载完成或采集更新时，本模块直接补充 FanHao 短视频库；FanHao 服务也会定时做增量同步。

媒体文件与程序数据分开保存：视频、图集、封面和下载清单统一放在 `ShortVideos`；SQLite、日志和有容量上限的播放缓存继续留在 FanHao 工作区。可通过 `FANHAO_SHORT_VIDEO_STORAGE_ROOT` 整体覆盖存储根目录，通过 `FANHAO_SHORT_VIDEO_ROOTS` 只覆盖 FanHao 的扫描目录。

数据库和 cookie 配置从旧的 `Desktop\Tool\douyin-download-manager` 迁移后，旧目录不再作为运行依赖。
