---
title: 配置参考
description: 说明环境变量、路径优先级、运行期配置及本地访问控制的有效边界。
status: maintained
verified_at: 2026-08-30
sources:
  - src/bootstrap/server-config.js
  - src/platform/server/root-config.js
  - src/platform/server/auth.js
  - src/modules/system/server/app-config-service.js
  - src/modules/fanhao/server/runtime.js
  - start-fanhao.ps1
  - .gitignore
---

# 配置参考

启动配置由 `createServerConfig()` 读取进程环境变量；资料根目录解析位于 `root-config.js`。
运行期设置由 `app-config-service.js` 管理。不要把这两类配置或下载管理器自己的配置混在一起。

## 加载与路径规则

- `PORT`、`HOST` 等变量在启动进程前设置；修改当前终端的变量不会更新已运行的服务。
- 现有启动入口没有自动加载 `.env` 的逻辑；被 Git 忽略不代表文件会生效。
- `start-fanhao.ps1` 用 `-Port`、`-HostName` 覆盖主服务的 `PORT`、`HOST`。
- 根目录列表接受分号、逗号或竖线分隔。相对路径的结果取决于进程当前目录，部署时优先使用绝对路径。
- 空字符串通常会触发默认值，不是“禁用扫描”。安全试跑应显式指向空目录。

源码仍含历史工作站路径默认值，本公开文档不把这些路径当作可移植配置。
新部署应明确覆盖所需根目录，完整示例见[快速开始](../guide/quick-start.md)。

## 网络与访问控制

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `29998` | 主服务 HTTP 端口。 |
| `HOST` | `0.0.0.0` | 所有网卡监听；本机测试设为 `127.0.0.1`。 |
| `FANHAO_WEB_PASSWORD` | 未配置 | 远程访问密码；不要写入仓库、命令输出或文档示例。 |

服务端按 TCP 来源地址区分本地、局域网与远程；请求头不能任意声明自己是可信客户端。
本地来源及符合主机名条件的局域网来源通常免密，远程访问需要密码。
管理和文件变更还受 Host/Origin 校验，不能仅凭免登录推断具备写权限。

::: danger 不要直接添加公网反向代理
当前没有可信代理 allowlist 与经过验证的代理链解析。
当代理从 loopback 或私网连接后端时，公网客户端可能被识别为本地/局域网。
添加 `X-Forwarded-For` 或配置密码都不会自动解决此问题。
:::

## 媒体根目录

| 变量 | 优先级与用途 |
| --- | --- |
| `LIBRARY_ROOTS`、`LIBRARY_ROOT` | 前者优先，主资料目录；最终列表还会合并欧美资料根。 |
| `FANHAO_WESTERN_ROOTS` | 欧美资料根，同时合并到主资料扫描范围。 |
| `FANHAO_PHOTO_SET_ROOTS` | 套图根目录列表。 |
| `FANHAO_MOVIE_ROOTS` | 电影媒体源。 |
| `FANHAO_TV_ROOTS` | 电视剧媒体源。 |
| `FANHAO_ANIME_ROOTS` | 动漫媒体源。 |
| `FANHAO_MANGA_ROOT` | 漫画根目录；也影响默认漫画数据库位置。 |
| `FANHAO_SHORT_VIDEO_ROOTS` | 首选短视频扫描根目录。 |
| `FANHAO_DOUYIN_LIKES_ROOT` | 未设置上一项时使用的兼容别名。 |
| `FANHAO_SHORT_VIDEO_STORAGE_ROOT` | 前两项未设置时，短视频目录取该根下的 `ShortVideos`。 |
| `FANHAO_MUSIC_ROOTS`、`FANHAO_MUSIC_ROOT` | 音乐目录列表，前者优先。 |

只设置 `LIBRARY_ROOTS` 不会关闭电影、套图、短视频、音乐或漫画等独立模块的默认路径。
根目录的存在、盘符可用性、权限和符号链接目标都需要部署者检查。

## 数据库与下载器

| 变量或位置 | 默认关系 |
| --- | --- |
| 主数据目录 | 当前源码副本下的 `data/`；没有 `FANHAO_DATA_DIR` 配置。 |
| `FANHAO_CORE_IMAGE_DB` | 默认 `data/fanhao-core-images.sqlite`。 |
| `FANHAO_MANGA_DATABASE` | 默认位于漫画根目录下的 `manga.sqlite`。 |
| `FANHAO_ACCESS_ANALYTICS_DB` | 默认 `data/access-analytics.sqlite`。 |
| `FANHAO_IP2REGION_XDB` | 默认 `data/ip2region_v4.xdb`，IP 地域查询数据。 |
| `FANHAO_DOUYIN_DOWNLOAD_MANAGER_DB` | 默认短视频下载器目录下的 `data/douyin_downloads.sqlite`。 |
| `FANHAO_DOUYIN_DOWNLOAD_MANAGER_URL` | 默认 `http://127.0.0.1:8765`。 |
| `FANHAO_DOUYIN_SYNC_MS` | 默认 `60000` 毫秒，同步轮询间隔。 |

下载器启动端口与主服务使用的下载器 URL 是两项配置。
改变 `-DownloadManagerPort` 时需同时核对 `FANHAO_DOUYIN_DOWNLOAD_MANAGER_URL`，启动器不会自动替你重写该 URL。
`-SkipDownloadManager` 不会阻止主服务读取已配置的下载器数据库。

## 外部工具与预热

| 变量 | 默认值与行为 |
| --- | --- |
| `FFMPEG_PATH` | `ffmpeg`；视频转码、抽帧等功能使用。 |
| `FFPROBE_PATH` | `ffprobe`；媒体信息探测使用。 |
| `PYTHON` | `python`；Python 辅助工具使用。 |
| `FANHAO_DISABLE_NVENC` | 值为 `1` 时关闭 NVENC 探测；默认启动会尝试探测编码器。 |
| `FANHAO_EAGER_PREWARM` | 值为 `1` 时启用主资料模块更多响应缓存预热；不是总扫描开关。 |

外部工具缺失可能只在相关业务路径触发失败，不应把健康检查成功当作这些能力已可用。

## 运行期配置

`data/app-config.json` 保存应用设置；加载时规范化，不存在时使用内存默认值，保存设置时才写文件。
不要手动编辑正在使用的配置文件绕过服务端校验。

| 字段 | 约束或用途 |
| --- | --- |
| `compilationPrefixes` | 合集番号前缀，规范化为大写字母数字。 |
| `compilationKeywords` | 合集识别关键词。 |
| `actorAvatarDataPath` | 可选头像数据路径，属于本机私有配置。 |
| `imageReaderCacheMaxBytes` | 默认 2 GiB；正值限制为 128 MiB–200 GiB，非正值规范化为 0。 |
| `shortVideoTranscodeConcurrency` | 默认 2，限制为 1–4。 |

`auth-secret.txt`、Cookie 文件、SQLite、缓存和日志都是运行数据，不能随文档站公开。
环境变量可覆盖的数据库并不包含全部数据库；迁移与备份应参照[运行维护](../guide/operations.md)逐项核对。

## 修改配置后的验证

先在隔离副本确认有效根目录与数据库位置，再检查预期模块的读写行为。
鉴权与配置相关门禁包括 `verify:auth`、`verify:mutation-auth`、`verify:settings`；副作用见[验证矩阵](./verification.md)。
如果代码与本页冲突，以当前源码和可重复证据为准，并更新本页 `sources` 与 `verified_at`。
