# 抖音下载管理器

这是 FanHao 短视频模块的数据采集与下载子模块。管理页面保持为：

- UI：`http://localhost:8765/#home`
- 状态接口：`http://localhost:8765/api/state`
- 数据库：`data/douyin_downloads.sqlite`
- 日志：`logs/`
- 默认媒体库：`D:\Media\ShortVideos`

下载管理器只维护自己的 `douyin_downloads.sqlite` 与媒体 manifest，不直接写入
FanHao 的 `data/short-videos.sqlite`。FanHao 主服务通过 Node `sync-worker` 按分钟
同步下载结果，数据库迁移、身份合并、缓存失效和目录数据写入因此只有一个所有者。

`douyin_downloads.sqlite` 中的 `download_records` / `download_files` 是下载结果的
运行时事实来源；`download_manifest.jsonl` 继续由内嵌下载器追加，作为可移动的兼容
与恢复副本。管理器按字节偏移增量导入 manifest，不再为每个作品从头扫描整份文件。

代码、采集器、管理页面和运行脚本都放在当前目录；运行数据通过仓库根目录的 `.gitignore` 排除。FanHao 会定时从这里的 SQLite 同步已采集、已下载作品到 `data/short-videos.sqlite`。

## 启动

通常直接运行仓库根目录的 `start-fanhao.cmd`，它会同时确保 FanHao 和本模块已经启动。

也可以单独双击 `run.cmd`，或在 PowerShell 中运行：

```powershell
.\run.ps1 -Open
```

首次启动会在当前目录安装 `playwright-core`。下载器源码已经内嵌在当前模块的
`downloader/`，首次运行会在该目录创建独立且不纳入 Git 的 `.venv` 并安装依赖。
数据库中已有的自定义路径设置仍然优先；迁移完成后，日常运行不再依赖任何模块外的
下载器仓库。

## 抖音登录

“配置 → 抖音登录”提供当前登录状态、Cookie 导入、目录打开、状态检测和清除操作。点击“打开 Edge 登录”后，在独立的 Edge 窗口中完成扫码或账号登录，管理器会自动把 Cookie 保存到当前配置的 Cookie 文件并关闭登录窗口。接口和页面只返回 Cookie 名称与状态，不会返回 Cookie 值。

## Windows 安装版

安装版启动后会在系统默认浏览器中打开管理页面，不再套独立桌面窗口。点击页面右上角“退出程序”会停止本地后台服务；如果只关闭了标签页，再次启动 EXE 会重新打开当前管理页面。顶部“查看已下载”和“已下载”页可以直接浏览本机下载完成的视频与图集，并可一键打开对应下载目录，不需要额外运行 FanHao 主服务。

点击已下载作品后，会加载 `public/modules/short-videos/short-video-page.js` 中与 FanHao 网页端相同的播放器。视频控制、上下切换、图集翻页、原声、手势与全屏只维护一份源码；安装版仅提供本地数据库和媒体文件的兼容接口。

## 数据流

1. 管理页面采集抖音主页链接并写入本模块 SQLite。
2. 下载任务调用当前模块内嵌的 `downloader/`，文件仍写到数据库配置的输出目录。
3. 下载完成或采集更新时，本模块直接补充 FanHao 短视频库；FanHao 服务也会定时做增量同步。

媒体文件与程序数据分开保存：视频、图集、封面和下载清单统一放在 `ShortVideos`；SQLite、日志和有容量上限的播放缓存继续留在 FanHao 工作区。可通过 `FANHAO_SHORT_VIDEO_STORAGE_ROOT` 整体覆盖存储根目录，通过 `FANHAO_SHORT_VIDEO_ROOTS` 只覆盖 FanHao 的扫描目录。

新下载按“作者 / 日期与标题及作品 ID / 作品 ID 文件名”组织。作品目录保留可读标题，文件名不再重复长标题；旧文件无需搬迁，仍由 manifest 中记录的相对路径读取。

数据库和 Cookie 配置从旧版外置管理器迁移后，旧目录不再作为运行依赖。
