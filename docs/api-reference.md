# API 参考

所有接口以 `http://<host>:29998` 为基址。JSON 接口统一返回 `application/json; charset=utf-8`。
媒体接口走 `/media/`，需要 `Range` 支持的视频走标准 HTTP Range 流式响应。

## 访问权限级别

路由中通过一组权限守卫控制敏感操作，共三类：

| 级别 | 守卫函数 | 说明 |
| --- | --- | --- |
| 公开（受网络策略约束） | — | 本地 / 局域网免密；远程需先登录（`FANHAO_WEB_PASSWORD`）。 |
| 本地管理员 | `requireLocalAdmin` | 仅在 `local` / `lan` 网络下允许，远程即使登录也不放行。用于重扫、合并、迁移、删除等写操作。 |
| 受信任文件变更 | `requireTrustedFileMutation` / `requireTrustedNetworkPage` | 仅允许在本机或局域网同源页面触发，用于「打开本地文件 / 文件夹」、删除本地文件等会触碰磁盘的操作。 |

> 鉴权细节见 [项目配置 · 访问控制](./configuration.md)。

## 健康检查与鉴权

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/health` | 公开 | 返回 `ok`、扫描时间、各类型总数、可用 / 缺失根目录数、访问模式与最近扫描错误。 |
| GET | `/api/auth/status` | 公开 | 返回当前请求是否需要登录、是否已认证、访问模式。 |
| GET | `/login` | 公开 | 返回登录页 HTML。 |
| POST | `/auth/login` | 公开 | 提交密码，成功写 `fanhao_web_auth` Cookie 或返回 `{ok,next}`。 |
| POST | `/auth/logout` | 公开 | 清除 Web / App Cookie，跳回登录页。 |

## 资料库（Library）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/library` | 公开 | 资料库总览：根目录、可用 / 缺失盘、统计、人物列表（按 scope 过滤）、UI 配置、访问模式。 |
| GET | `/api/library/roots` | 公开 | 返回所有根目录与默认根。 |
| POST | `/api/rescan` | 本地管理员 | 重新扫描全部资料库根目录，返回新扫描结果与统计。 |

`scope` 查询参数：`main`（默认，番号与欧美合并后的完整人物/作品库）；`western` 仅为旧客户端兼容筛选，由 `people-scope-service.js` 规范化。

## 作品与视频库（Video Library）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/works` | 公开 | 作品列表（分页、排序、筛选、搜索）。 |
| GET | `/api/search` | 公开 | 跨作品全文搜索。 |
| GET | `/api/works/:id` | 公开 | 单个作品详情（含播放信息入口、info 元数据、本地可用性）。 |
| GET | `/api/playinfo/:id` | 公开 | 作品播放信息：视频文件、推荐播放模式、转码 / 直连决策。 |
| GET | `/api/info/:id` | 公开 | 返回作品 sidecar 元数据文件（info/nfo/txt）原始内容。 |
| GET | `/api/actor-profiles/:id` | 公开 | 演员资料页完成态 payload（`profile` 与 `mergeCandidates`），与 completed PUT 的 200 语义一致。 |
| PUT | `/api/actor-profiles/:id` | 本地管理员 | 更新单个人物资料与可选头像。门禁在读取 body 前执行；完成后返回 200；仅当 body 显式设置 `acceptAsyncOperation: true` 时，`prepared/applying/retry_wait` 返回 202，否则返回 retryable 503；`blocked/cancelled` 始终返回 409。 |
| GET | `/api/actor-profile-operations/:operationId` | 公开 | 查询单人物资料更新的可恢复 operation 状态。 |
| POST | `/api/actor-profile-operations/:operationId/retry` | 本地管理员 | 显式重试被阻断的人物资料 operation；`retry_wait` 由协调器自动恢复。 |
| GET | `/api/people/:id` | 公开 | 人物详情（作品、缺失作品、合并候选、封面）。 |
| POST | `/api/people/:id/merge` | 本地管理员 | 将某人物合并到目标人物。 |
| PUT | `/api/people/:id/cover` | 公开 | 设置人物封面（头像）。 |
| POST | `/api/people/:id/local-files/delete` | 受信任文件变更 | 批量删除该人物的本地作品文件；可通过 JSON `workIds` 仅删除所选作品。 |
| POST | `/api/works/:id/cover/generate` | 公开 | 从本地视频抽帧生成缺失封面。 |
| PUT | `/api/works/:id/cover` | 公开 | 手动设置 / 覆盖作品封面。 |
| POST | `/api/works/:id/local-marker` | 本地管理员 | 切换作品本地标记（如 `[A]` 特殊分类）。 |
| POST | `/api/works/:id/correct-actor-from-folder` | 本地管理员 | 按文件夹名订正作品归属演员。 |
| GET | `/api/works/:id/move-targets` | 本地管理员 | 返回服务端已验证可用的目标人物 `id` / `name`；不返回文件系统路径，可用 `query` 与 `limit` 筛选。 |
| POST | `/api/works/:id/move-to-person` | 本地管理员 | 创建或复用一个持久化后台迁移任务，返回 HTTP 202 与 `job`。 |
| GET | `/api/works/:id/move-job` | 本地管理员 | 查找该作品的活动/阻断迁移；可用 `idempotencyKey` 找回 POST 响应丢失后已经落库的任务。 |
| GET | `/api/work-move-jobs/:jobId` | 本地管理员 | 读取迁移阶段、进度、错误和结果。 |
| POST | `/api/work-move-jobs/:jobId/retry` | 本地管理员 | 重试可恢复的回滚或清理任务；阻断任务保持阻断，等待人工检查。 |
| POST | `/api/works/:id/local-files/delete` | 受信任文件变更 | 删除该作品的本地文件。 |

`:id` 为 URL 编码的公开 ID（base64url 前缀形式，如 `work_xxx`、`person_xxx`）。

## 媒体（Media）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/media/actor/:id/avatar` | 公开 | 演员头像（本地 / 远端 / 生成）；暂存发布头像使用不可变 `?v=<operation-id>`，服务端校验 completed main receipt。 |
| GET | `/media/work/:id/cover` | 公开 | 作品封面。 |
| GET | `/media/core-image/:id` | 公开 | 核心库图片（按 `images` 表 id）。 |
| GET | `/media/image/:id` | 公开 | 本地图片文件。 |
| GET | `/media/video/:id` | 公开 | 视频文件 Range 流式播放（直连或重封装）。 |
| GET | `/media/video/:id/transcode` | 公开 | 视频转码流（浏览器不支持直连时按需触发，本地网络下为 manual，其余 prefer）。 |

## 榜单与厂商（Catalog）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/rankings` | 公开 | 排行榜列表概览。 |
| GET | `/api/rankings/top` | 公开 | TOP 榜单作品（分页、筛选）。 |
| GET | `/api/studios` | 公开 | 厂商 / 制作商 / 标签概览（分页、筛选）。 |
| GET | `/api/studios/:id` | 公开 | 单个厂商详情与作品列表。 |

## 图库（Gallery / Image Library）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/image-library` | 公开 | 图像资料库全量 payload（频道、根、统计、facets、缓存状态）。 |
| GET | `/api/image-library/summary` | 公开 | 图库概览。 |
| GET | `/api/image-library/items` | 公开 | 频道列表（套图 / 电影 / 电视剧，分页筛选）。 |
| GET | `/api/image-reader/cache` | 公开 | 图片读取器缓存状态与 App 配置。 |
| POST | `/api/image-reader/cache/cleanup` | 本地管理员 | 清理图片读取器缓存（`?force=1` 强制）。 |
| GET | `/api/manga` | 公开 | 漫画根状态与已缓存漫画列表。 |
| GET | `/api/manga/:id` | 公开 | 单本漫画详情。 |
| GET | `/api/manga/:id/chapters/:chapter` | 公开 | 漫画章节图片列表。 |
| GET | `/api/photo-sets` | 公开 | 套图列表。 |
| GET | `/api/photo-sets/:id` | 公开 | 单个套图详情（`?imageLimit=&imageOffset=` 分页）。 |
| GET | `/api/gallery-media/:id` | 公开 | 电影 / 电视剧单条媒体详情（兼容读取旧版欧美索引项）。 |

> 图库索引刷新已迁移到后台作业中心（见 [维护与作业](./maintenance.md)），旧 `/api/image-library/rescan` 直接调用会返回 409 提示去作业中心。

## 短视频（Short Videos）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/short-videos/summary` | 公开 | 短视频概览统计。 |
| GET | `/api/short-videos/facets` | 公开 | 筛选维度（作者、来源等）。 |
| GET | `/api/short-videos` | 公开 | 短视频列表（分页、筛选）。 |
| POST | `/api/short-videos/rescan` | 本地管理员 | 扫描抖音点赞目录重建索引（`body.root` 可选指定根）。 |
| GET | `/api/short-videos/:id` | 公开 | 短视频详情。 |
| GET | `/api/short-videos/:id/adjacent` | 公开 | 上一条 / 下一条（`?direction=prev\|next`）。 |

## 音乐（Music）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/music/summary` | 公开 | 音乐库概览统计与根目录状态。 |
| GET | `/api/music/facets` | 公开 | 筛选维度（歌手、专辑）。 |
| GET | `/api/music/artists` | 公开 | 歌手列表。 |
| GET | `/api/music/albums` | 公开 | 专辑列表。 |
| GET | `/api/music/tracks` | 公开 | 歌曲列表（搜索、歌手、专辑、收藏、排序）。 |
| POST | `/api/music/rescan` | 本地管理员 | 扫描本地音乐根目录并重建 `music.sqlite`。 |
| GET | `/api/music/tracks/:id` | 公开 | 单曲详情、歌词与相邻歌曲。 |
| POST | `/api/music/tracks/:id/progress` | 公开 | 保存播放进度 / 播放次数。 |
| POST | `/api/music/tracks/:id/favorite` | 公开 | 切换歌曲收藏。 |
| GET / HEAD | `/media/music/:id` | 公开 | 音频文件 Range 流式播放。 |
| GET | `/media/music-cover/:albumId` | 公开 | 专辑封面。 |

## 小说（Novels）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/novels/summary` | 公开 | 小说书库概览。 |
| GET | `/api/novels` | 公开 | 书籍列表（分页、搜索）。 |
| POST | `/api/novels/upload` | 公开 | 上传 TXT 小说（body 上限 80 MiB）。 |
| GET | `/api/novels/:id` | 公开 | 书籍详情（章节结构）。 |
| GET | `/api/novels/:id/chapters/:chapter` | 公开 | 单章正文。 |
| POST | `/api/novels/:id/progress` | 公开 | 保存阅读进度。 |
| GET | `/api/novels/:id/download` | 公开 | 下载整本 TXT（UTF-8 附件）。 |
| GET | `/api/novels/collection` | 本地管理员 | 采集后台快照：运行环境、适配器和任务。 |
| GET / POST | `/api/novels/collection/adapters` | 本地管理员 | 列出或新建自定义站点适配器。 |
| PATCH / DELETE | `/api/novels/collection/adapters/:id` | 本地管理员 | 修改或删除自定义站点适配器。 |
| GET / POST | `/api/novels/collection/tasks` | 本地管理员 | 列出或创建网页采集任务。 |
| GET / DELETE | `/api/novels/collection/tasks/:id` | 本地管理员 | 查看或删除采集任务记录。 |
| POST | `/api/novels/collection/tasks/:id/run` | 本地管理员 | 执行或重新执行采集任务。 |
| POST | `/api/novels/collection/tasks/:id/cancel` | 本地管理员 | 取消排队中或运行中的采集任务。 |

## 用户状态（User State）

收藏、收藏夹、观看历史与播放进度持久化在 `data/user-state.json`。

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/favorites` | 公开 | 收藏作品（`?folder=` 指定收藏夹）。 |
| GET | `/api/favorite-folders` | 公开 | 收藏夹列表。 |
| POST | `/api/favorite-folders` | 公开 | 新建收藏夹（`body.name`）。 |
| POST | `/api/favorites/:id` | 公开 | 切换作品收藏状态。 |
| PUT | `/api/favorites/:id/folder` | 公开 | 将收藏移动到指定收藏夹（`body.folderId`）。 |
| GET | `/api/history` | 公开 | 观看历史（`?days=&limit=`，`days=all` 取全部）。 |
| POST | `/api/progress/:id` | 公开 | 保存单个视频播放进度（`body` 含 position / duration）。 |

## 本地打开（Local Open）

仅在受信任网络（本机 / 局域网同源页面）可用，用于从网页唤起本地文件管理器。

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/open-folder` | 受信任网络页 | 打开本地文件夹（`body.sourcePath` 或 `body.videoId`）。 |
| POST | `/api/open-file` | 受信任网络页 | 打开本地文件（`body.sourcePath`）。 |

## 安卓更新（Android Update）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/android/update` | 公开 | 返回 APK 更新清单（debug / release 通道）。 |
| GET / HEAD | `/api/android/update/apk/:channel/:file` | 公开 | 下载指定通道的 APK 文件。 |

## 工具（Tools）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/tools/txt-format` | 公开 | 提交 TXT 文本，格式化后返回下载令牌。 |
| GET | `/api/tools/txt-format/download/:id` | 公开 | 下载格式化后的 TXT（带 TTL）。 |

## 管理（Admin）

以下接口均需 `requireLocalAdmin`（仅本机 / 局域网）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/tasks` | 后台作业列表与历史。 |
| POST | `/api/admin/tasks/stop` | 停止指定作业（`body.taskId`）。 |
| GET | `/api/admin/scripts` | 可运行维护脚本清单（含参数定义）。 |
| POST | `/api/admin/scripts/run` | 启动脚本（`body` 含 `id` 与参数）。 |
| GET | `/api/admin/config` | 读取 App 配置。 |
| PUT | `/api/admin/config` | 更新 App 配置。 |
| GET | `/api/admin/douban-cookie` | 读取豆瓣 Cookie 状态。 |
| PUT | `/api/admin/douban-cookie` | 保存豆瓣 Cookie。 |
| POST | `/api/admin/douban-cookie/test` | 测试豆瓣 Cookie 可用性。 |
| POST | `/api/admin/import-actor-avatars` | 从本地 Filetree 导入演员头像。 |
| POST | `/api/admin/actor-avatar-candidates` | 列出演员头像候选。 |
| POST | `/api/admin/apply-actor-avatar-candidate` | 应用某个头像候选。 |
| GET | `/api/admin/person-mapping/:id` | 单人物的映射详情（可用于校准）。 |
| POST | `/api/admin/rescan-person` | 单人物重新扫描 / 重建索引。 |
| POST | `/api/admin/refresh-actor-movies` | 刷新 JavDB 演员片单（后台作业）。 |
| GET | `/api/admin/cover-cache-status` | 封面缓存状态（`?limit=`）。 |
| POST | `/api/admin/generate-missing-covers` | 批量生成缺失封面（后台作业）。 |

> 旧 `/api/admin/refresh-rankings` 已废弃（核心库改用原生脚本），调用返回 410 提示。
