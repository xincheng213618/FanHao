---
title: 验证矩阵
description: 按变更范围选择真实 package 脚本，明确依赖、临时写入和运行验收的区别。
status: maintained
verified_at: 2026-10-04
sources:
  - package.json
  - tools/run_verification.mjs
  - tools/verify_verification_runner.mjs
  - android-client/package.json
  - tools/verify_fanhao_startup.mjs
  - tools/verify_fanhao_startup.ps1
  - tools/verify_browser_behavior.mjs
  - tools/verify_short_video_watch_write.mjs
  - tools/verify_short_video_store.mjs
  - tools/verify_short_video_delete_jobs.mjs
  - tools/verify_work_move_jobs.mjs
  - tools/verify_native_short_video_actions.mjs
  - tools/verify_native_short_video_paging.mjs
  - tools/build_short_video_web.mjs
  - tools/verify_fanhao_requests.mjs
  - tools/verify_work_sorting.mjs
  - tools/verify_work_facets.mjs
  - tools/verify_work_cache_budget.mjs
  - tools/verify_code_prefix_cache_budget.mjs
  - tools/diagnose_work_cache_heap.mjs
  - tools/verify_file_stream_lifecycle.mjs
  - tools/verify_file_server_async.mjs
  - tools/verify_static_file_lifecycle.mjs
  - tools/verify_module_lifecycle.mjs
  - tools/verify_server_shutdown_lifecycle.mjs
  - tools/verify_short_video_quality_queries.mjs
  - tools/verify_short_video_image_sources.mjs
  - tools/verify_short_video_image_lifecycle.mjs
  - tools/verify_short_video_product_lifecycle.mjs
  - tools/verify_actor_avatar_import.mjs
  - tools/verify_gallery_list_rendering.mjs
  - tools/verify_android_channel_rendering.mjs
  - tools/fixtures/image-library-channel-server.mjs
  - tools/verify_music_cover_async.mjs
  - tools/verify_work_cover_async.mjs
  - tools/verify_gallery_cover_async.mjs
  - tools/verify_image_query_correctness.mjs
  - tools/diagnose_image_query_cpu.mjs
  - tools/verify_video_probe_cache.mjs
  - tools/verify_video_probe_lifecycle.mjs
  - tools/verify_media_blob_worker.mjs
  - tools/verify_remote_image_lifecycle.mjs
  - tools/verify_media_stream_lifecycle.mjs
  - tools/verify_web_gallery_requests.mjs
  - tools/verify_manga_reader_requests.mjs
  - tools/verify_manga_lookup_performance.mjs
  - tools/verify_music_facet_cache.mjs
  - tools/verify_music_summary_reuse.mjs
  - tools/verify_music_active_catalogue.mjs
  - tools/verify_studio_cache_dependencies.mjs
  - tools/verify_android_music_list_rendering.mjs
  - tools/verify_android_music_catalogue_requests.mjs
  - tools/verify_android_music_playback_requests.mjs
  - tools/verify_android_music_transition_requests.mjs
  - tools/verify_vision_lifecycle.mjs
  - tools/verify_music_playback_lifecycle.mjs
  - tools/verify_music_request_ownership.mjs
  - tools/verify_music_reader_requests.mjs
  - tools/verify_music_progress_writer.mjs
  - tools/verify_music_progress_clients.mjs
  - tools/verify_music_progress_order.mjs
  - tools/verify_music_progress_requests.mjs
  - tools/verify_novel_reader_requests.mjs
  - tools/verify_novel_progress_writer.mjs
  - tools/verify_novel_progress_order.mjs
  - tools/verify_novel_progress_requests.mjs
  - tools/verify_web_novel_chapter_identity.mjs
  - tools/diagnose_web_gallery_navigation.mjs
  - tools/verify_archive_reader_lifecycle.mjs
  - tools/verify_rescan_image_library.mjs
  - tools/verify_image_library_performance.mjs
  - tools/verify_media_metadata_identity.mjs
  - tools/fixtures/archive_image_helper_fixture.mjs
  - tools/verify_novel_summary_cache.mjs
  - tools/verify_novel_write_worker.mjs
  - tools/verify_novel_credentials_async.mjs
  - tools/verify_novel_collection_worker.mjs
  - tools/verify_novel_reimport_async.mjs
  - tools/verify_douyin_manager_latest_requests.mjs
  - src/modules/short-videos/download-manager/tests/test_manager_link_cursor.py
  - src/modules/short-videos/download-manager/tests/test_manager_profile_snapshot.py
  - .github/workflows/application-checks.yml
---

# 验证矩阵

这里列出的应用命令来自根目录 `package.json`，不是新增的命令接口。
日常门禁、按改动选择和完整门禁是三个显式入口。
本页说明检查的用途与副作用，不表示它们在当前机器或当前提交上都已通过。

## 安装与查看实际脚本

```powershell
npm ci
npm run
```

安装会访问包源并写入 `node_modules/`；锁文件与 Node 版本应与仓库要求一致。
测试常会创建并清理临时 SQLite、媒体 fixture、Worker 或本机监听端口；“验证”不等于所有步骤只读。
首次运行陌生脚本前检查其入口、环境变量与清理范围，尤其不要把 fixture 的路径替换为真实媒体目录。

## 文档门禁

```powershell
npm --prefix docs ci
npm --prefix docs run check
npm --prefix docs run build
```

文档依赖独立安装。检查页面约束与站点构建不需要启动 `server.js`、下载器、Android 或任何采集作业。
写作约束见[文档规范](../contributing/documentation.md)。

## 按改动选择应用检查

日常开发先运行轻量门禁：

```powershell
npm run verify
```

它检查仓库卫生、鉴权、写接口权限、模块结构、相对导入、验证 runner/cache-version 自测，以及番号请求生命周期与公共排序，不代表全模块回归已经执行。
按当前 Git staged、unstaged 和 untracked 文件选择相关检查，可先只看计划：

```powershell
npm run verify:changed -- --plan
npm run verify:changed
```

也可以传入明确路径，便于 CI 或复核某批文件；`--files` 后可跟多个路径：

```powershell
npm run verify:changed -- --files src/modules/novels/server/store.js public/modules/novels/novel-page.js --plan
```

计划会列出变更文件、模块入口和去重后的命令数量。选择规则按具体模块优先匹配，Android 小说、音乐、媒体、图片/视觉和短视频各自运行安全核心与相关行为；共享壳、桥接、Gradle 或发布工具变更才回退到全 Android。若计划包含 Android Web/客户端检查，还会明确标出执行前的 `sync:cache` 生成文件写入。无法归类的源码会明确提示，并保守选择完整门禁；不能把 changed 模式的成功描述成已执行所有检查。

独立下载管理器的源码与验证工具选择 `verify:douyin-manager` 和导入检查，不连带执行主服务短视频与 Android 门禁。共享媒体响应、文件服务和媒体 Worker 的改动会额外选择图库、视频播放、音乐和封面行为检查。

| 命令 | 检查内容 | 执行边界 |
| --- | --- | --- |
| `npm run verify:repo-hygiene` | Git 跟踪文件中的禁止产物、运行状态与文本异常。 | 读取 Git 清单和源码，不是秘密扫描器。 |
| `npm run verify:modules` | 模块结构与职责约束。 | 结构检查，不能替代真实调用验证。 |
| `npm run verify:imports` | 相对导入引用。 | 源码引用检查，不启动应用。 |
| `npm run verify:auth` | 来源识别、登录与会话等鉴权规则。 | 使用临时鉴权状态文件，并清理临时目录。 |
| `npm run verify:mutation-auth` | 写接口权限与 API 错误边界。 | 同时调用 mutation 与 error-boundary 检查。 |
| `npm run verify:settings` | 模块和应用设置契约。 | 会生成并清理临时模块 fixture。 |
| `npm run verify:short-video-build` | bundle 字节与 HTML 版本引用是否一致。 | esbuild 内存构建并比较；`--check` 不写产物。 |
| `npm run verify:short-video-client` | Web/原生短视频结构、分页、请求与动作契约；具体子检查以 package 脚本为准。 | 包含源码检查及 `javac` 编译、`java` 执行的 fixture；会写入并清理临时类文件，另需下述 JDK/Android 依赖。 |
| `npm run verify:short-video-watch-write` | SQLite 竞争、提交回执、超时与停止恢复。 | 临时 SQLite、真实 Worker 与故障 fixture。 |
| `npm run verify:short-video-delete-jobs` | 删除恢复与幂等协议。 | 临时文件/数据库、进程和 Worker；会在 fixture 内移动或删除文件。 |
| `npm run verify:short-video-runtime` | 运行队列与生命周期。 | 创建临时媒体、缓存与数据库，结束后清理。 |
| `npm run verify:short-video-store` | 导入、列表与状态契约；相邻播放、预取与列表在并列值、空值、正反方向和过滤条件下保持相同顺序。 | 临时合成媒体和 SQLite；相邻顺序专项使用内存数据库，不读取真实资料。 |
| `npm run verify:work-move-jobs` | 作品移动作业与操作 UI 契约。 | 包含临时文件移动、SQLite 和 Worker，不是实际资料迁移命令。 |
| `npm run verify:music-rescan-worker` | 音乐扫描 Worker、锁竞争与停止流程。 | 临时音乐文件、数据库、假探测器与子进程。 |
| `npm run verify:browser-behavior` | 浏览器中的页面行为、导航与异步状态。 | 默认本机临时 HTTP fixture，并启动无头 Chrome/Edge。 |
| `npm run verify:startup` | 启动器健康、超时、占用与失败边界。 | 临时启动器/假服务与动态端口，要求 PowerShell 运行时。 |
| `npm run verify:fanhao-requests` | 人物与番号导航竞态、翻页取消、片商完整筛选、预取在途上限与释放。 | 调用当前请求模块及壳函数，HTTP/DOM 使用可控 doubles，不访问正式服务。 |
| `npm run verify:fanhao-requests-browser` | 浏览器中范围乱序、进入收藏后的迟到响应、人物与番号翻页期间改筛选、片商服务器分页。 | 动态 loopback HTTP fixture 与无头 Chrome/Edge；不访问正式服务，需浏览器二进制。 |
| `npm run verify:work-sorting` | 公共排序的缺失值、并列规则、输入不变性和延后标题比较。 | 合成内存数据；计时是诊断样本，不代表真实 API 延迟。 |
| `npm run verify:work-facets` | 评分计数一致性、等价筛选复用、列表与搜索筛选/排序缓存容量。 | 合成内存数据，覆盖空值与数值零，以及多组筛选、排序后的淘汰和复用。 |
| `npm run verify:work-cache-budget` | 全局权重和条目淘汰、大页不缓存、普通分页复用、账号失效与弱引用释放。 | 合成内存目录和真实 GC；不访问实际资料库。 |
| `npm run verify:code-prefixes` | 前缀分页、状态失效和账号隔离；片商可见性与筛选在分页之前生效；前缀来源/结果共享预算、强引用、LRU、大结果回退和释放。 | 合成目录数据、真实 GC 与有效筛选组合，验证容量、淘汰、重建和跨页复用；堆内存和计时仅为诊断。 |
| `npm run verify:studio-cache` | 片商与前缀依赖表更新、同时间戳提交、旧表、显式失效和主线程/Worker 交接。 | 实际 API 路由、私有 SQLite 与持久 Worker；不访问正式资料库，外部提交由既有数据戳刷新发现。 |
| `npm run verify:file-streams` | 异步打开及属性读取、同句柄、完整传输等待、GET/HEAD、范围和下载头、断连、失败、实际关闭及停机/重启。 | 临时合成文件、动态 loopback HTTP/Host、受控文件句柄和慢速读流；不读取真实媒体。 |
| `npm run verify:static-files` | 静态资源同句柄、HEAD/空文件、错误/断连、压缩与缓存；打开/查询/传输取消、实际关闭、准入停止和重启，以及公共请求错误和账号上下文。 | 受控文件句柄与读流、实际 Node 文件句柄和动态 HTTP/Host；只读验证器自身，不操作真实媒体、数据或服务。 |
| `npm run verify:shutdown` | 模块逆序逐个停止及失败后继续清理、原始错误汇总、主服务资源停止和账号关闭、独立短视频启动失败清理，以及静态文件未关闭时拒绝正常退出。 | 当前注册器、实际装配回调与受控依赖、动态 HTTP/Host；不启动正式服务或访问数据库。 |
| `npm run verify:short-video-quality` | 正数画质区间的计数与分页索引范围查找，空值和边界兼容，以及画质与媒体类型在列表、历史和导航中的组合。 | 当前 store/schema 与内存 SQLite、合成记录及查询计划；计时仅作诊断。也纳入 `verify:short-video-stats-performance`。 |
| `npm run verify:short-video-images` | 默认产品的同句柄图片流与实际关闭、图片准入容量、文件下载及产品资源停止/重启；直接运行时接线的缓存复用、来源与数据库变化；断连及 BLOB 和视频兼容。 | 当前 product/store/runtime/共享图片服务、内存 SQLite、受控流及文件句柄；默认文件打开器只读验证器自身，不读取真实媒体或启动正式服务。 |
| `npm run verify:actor-avatar-import` | 单次头像应用的文件检查范围、完整预览统计、已有头像跳过、读取上限、换源、取消、人物归属与逐人物事务。 | 实际服务及管理路由、内存 SQLite 和受控文件句柄；不操作真实头像目录、配置或数据库。 |
| `npm run verify:music-cover-async` | 音乐封面异步文件查询/读图、来源与数据库变化、缓存锁回退、准入容量、迟到写入和停止/重启。 | 受控文件查询与读取、私有 SQLite 与响应 doubles；不读取真实图片或数据库。 |
| `npm run verify:work-cover-async` | 作品封面探测/抽帧的异步响应、并发和容量、取消/停机、来源变化、人工封面冲突与提交异常。 | 受控子进程、私有内存 SQLite 与动态 HTTP fixture；不运行 FFmpeg 或读取真实视频。 |
| `npm run verify:gallery-cover-async` | 图库视频封面的异步探测/抽帧、合并请求、并发、断连、停止和来源/缓存/数据库变化。 | 受控子进程、私有内存 SQLite 和动态 HTTP；不运行 FFmpeg 或读取真实视频。 |
| `npm run verify:image-query` | 相册显示字段延后、影视批量投影与同请求解析复用、媒体 ID 索引；分页版本、索引重排、同连接/外部提交、读竞态与 schema/连接变化。`verify:image-library` 另检查名称排序与相册索引实际装配、刷新和释放。 | 旧字段与旧算法逐字节对照、实际服务及私有 SQLite、读取/解析量与固定版本探测计数；计时仅作诊断，不读取真实资料。 |
| `npm run verify:video-probe-cache` | 视频来源更新、缓存容量、缓存锁回退、统一调度、前台优先、慢文件查询预算、实际进程关闭和停止/重启竞态。 | 合成来源、受控进程和私有 SQLite；响应和停机验证使用实际 Node 子进程与动态 HTTP，不运行 FFprobe 或读取真实媒体。 |
| `npm run verify:media-images` | 共享图片 Worker 的任务/参数容量、串行派发、冷读取合并、逐请求头像撤销、实际退出及启停竞态；远程图片的流式大小限制、统一预热准入、完成缓存权重与条目上限、长 URL 边界。 | 受控 Worker/网络、私有 SQLite 与实际图片 Worker、动态 loopback 分块响应；不读取真实图片或连接外部图片源。 |
| `npm run verify:media-streams` | 转码任务容量、首字节和排队超时、背压、输出后失败、断连、管道错误及实际进程关闭。 | 受控管道、私有 Node 子进程及动态 HTTP/Host 停机 fixture；不运行 FFmpeg 或读取真实视频。 |
| `npm run verify:photo-reader-browser` | 相册/章节/媒体的乱序请求、返回与取消、分页去重、既有 DOM 与 observer 保留、迟到全目录时保留阅读位置，以及深链接恢复期间的历史导航、启动与模块切换。 | 真实入口与当前宿主/阅读器源码、动态 HTTP 和无头 Chrome/Edge，数据及图片均为合成；不访问正式图库。 |
| `npm run verify:gallery-rendering`、`npm run verify:android-channel-rendering` | 两端普通卡片及 Web 电视剧书架追加、原始 offset、版本变化补齐、封面缓存无关写入、限量分段、重复尾页、缓存/失败/取消、搜索焦点与封面保留；Web 延后布局、Android 瀑布流和分组/变宽回退。详见[图库列表](../architecture/gallery-lists.md)。 | 当前客户端与完整 CSS、私有 Chromium、实际查询服务及私有 SQLite、合成 API/图片；含关闭复用的行为负例。Android 同步生成缓存引用；不证明真实资料库或真机性能。 |
| `npm run verify:manga-reader-browser` | 独立漫画馆的深链接、历史导航、作品/章节乱序、进度归属、后台目录/作业刷新，以及删除结果与新导航交错。 | 当前独立宿主与漫画阅读页、私有 Chromium、合成 API 和图片；更新与删除仅由 fixture 模拟，不操作正式资料。 |
| `npm run verify:manga-lookup` | 热态图片/章节请求的固定查询次数、连续图片请求的事件循环延迟，以及同源去重、旧 ID、JSON 回退、WAL 更新和数据库文件替换。 | 实际采集器 schema、临时 SQLite 与合成目录、受控图片响应；计时限于进入图片服务前的查找，不证明实际图片解码或网络耗时。 |
| `npm run verify:music-facet-cache` | 等价字母参数复用、歌手名称排序键的计算次数与旧响应一致性、真实筛选容量、JSON 权重淘汰、LRU、键碰撞、超大结果回退及数据库/缓存弱引用释放。 | 私有 SQLite、合成音乐元数据及 GC 子进程；不读取音频文件，内存预算为估算 JSON 大小。 |
| `npm run verify:music-summary-cache` | 会话及未应用进度的汇总复用、有效状态写入和回滚、有效期及扫描失效；移出和返回目录后的未听与待评分计数。 | 当前 store、实际扫描发布和临时 SQLite、SQL 执行计数；只使用合成元数据，不扫描音频或操作实际历史记录。 |
| `npm run verify:android-music` | 音频 Blob 生命周期、翻页与后台歌单请求归属；单曲详情、音频和播放 Promise 乱序，以及首屏恢复、自动衔接与最新选歌的交错。 | 实际客户端模块或未改写逻辑的函数体、受控 API 与 Audio；不访问真实音乐或数据库，不证明真实音频解码。 |
| `npm run verify:android-music-rendering` | 普通歌曲翻页保留 DOM、失败重试、取消与筛选切换、重复 ID、分组回退和播放标记更新；完整样式下的屏幕外布局、行高、变宽、滚动定位、焦点、点击和封面懒加载；后台歌单局部更新、弹窗及首屏恢复与新选歌的归属。 | 当前 Android 音乐页与完整 CSS、私有 Chromium、合成 API 和受控 Audio；同步生成缓存引用，计时区分脚本与布局，仅作诊断，不证明真机播放。 |
| `npm run verify:music-playback` | 旧播放 Promise 的成功/拒绝、换源与同源重载、当前拒绝与重试、暂停、睡眠定时和迟到媒体事件。 | 实际音乐页/播放器源码与受控 Audio、DOM 和时钟；不读取音频文件，不证明真实解码或音频设备播放。 |
| `npm run verify:music-requests` | 列表、单曲和旁栏的乱序完成与取消，上次歌曲恢复和新选歌交错，以及旧错误、路由和 loading 归属。 | 实际音乐 actions 源码、受控 API、播放器、状态和存储；不使用真实数据库或媒体。 |
| `npm run verify:music-reader-browser` | 独立音乐馆的深链接、历史导航、列表切换、关闭详情、搜索定时器、跨页优先版本合并、原始 offset 和持续播放状态。 | 当前宿主与音乐页、私有 Chromium、合成 API 和受控 Audio；不证明真实音频解码或设备播放。 |
| `npm run verify:music-progress` | 两端写入合并、普通及退出容量、账号归属和实际回执；服务端持久顺序、播放去重、预留复用、过期、回拨、竞争及迁移。 | 当前 Web/Android 写入与传输源码、实际 store/routes 和临时 SQLite；显式跳转及无缝切歌使用受控音频与请求，不证明 Android 真机播放。 |
| `npm run verify:music-progress-browser` | 迟到进度与最新 keepalive、播放去重、真实文档离开、会话续期、固定时钟双页面及当前归属复用。 | 当前入口与音乐页、私有 Chromium、动态 loopback 和临时 SQLite；受控 Audio 不解码，不证明断网卸载送达或正式服务已部署。 |
| `npm run verify:novel-reader` | Web 小说章节身份、版本变化、阅读进度恢复确认和聚焦控件下的键盘操作。 | 当前完整阅读模块与受控 API、DOM、帧和计时器；包含行为负控制，不使用真实数据库。 |
| `npm run verify:novel-reader-browser` | 独立小说馆的深链接、历史导航、书库与章节乱序、目录和预取取消；加载期间卡片保留、重复 ID 更新、原始 offset、版本/来源变化后的补齐与限次重试，以及滚动和进度归属。 | 当前宿主与阅读页、私有 Chromium、合成文本与 API；含关闭渲染复用的行为负例，不使用真实书库或采集任务。 |
| `npm run verify:novel-progress` | 高频保存合并与容量、显式确认回执、keepalive；持久序号、合法回读、多会话、过期和时钟回拨、容量背压及 Worker 重启。 | 当前写入器、实际 store/routes/Worker 和临时 SQLite；只使用合成文本，不操作真实书库。 |
| `npm run verify:novel-progress-browser` | 迟到普通请求与最新 keepalive、真实文档离开、高频保存、跨书位置、恢复确认及会话续期时的新滚动和导航。 | 当前入口与阅读页、私有 Chromium、动态 loopback 及实际临时 SQLite；不证明真实网络卸载送达、排队恢复确认在退出后完成或正式服务已部署。 |
| `npm run verify:archive-images` | 压缩包列表/抽取合并、helper 和响应流的容量及关闭、发送前来源与路径检查；相册索引查找下的来源/记录/数据库/停机竞态、身份替换、迟到写入、旧库迁移及异步巡检。 | 受控 helper/文件流、私有 Node/Python 子进程、合成 ZIP 和临时 SQLite/缓存目录；不操作真实压缩包或缓存。 |
| `npm run verify:novel-summary-cache` | 小说汇总复用；分页版本与原始 offset、进度重排后的漏书复现与重读、Worker/外部写入、读快照竞态、作者分页和数据库替换。 | 实际 store/写入 Worker、临时 SQLite 与合成 TXT；每次请求关闭连接，保留外部文件替换能力。 |
| `npm run verify:novel-write-worker` | 小说写入锁竞争、六类 API、提交/回滚异常、回执恢复/清理、换库与来源、排队容量和停机。 | 临时 SQLite、真实/受控 Worker、HTTP doubles 和仅扫描合成 TXT 的 Python；不访问真实资料库。 |
| `npm run verify:novel-credentials-async` | 登录凭据检测的主线程响应、取消、超时、输出限制、来源变化与停机。 | 临时假凭据、受控子进程及本机 Node 子进程/动态 HTTP；不启动 Python 检测器或访问外站。 |
| `npm run verify:novel-collection-worker` | 小说采集后台的锁等待、RPC 容量、子进程所有权、入库标识持久化、不确定任务的重试/历史清理保护与停机。 | 临时 SQLite、真实/受控 Worker、本机受控子进程和动态 HTTP；不运行真实采集或访问外站。 |
| `npm run verify:novel-reimport-async` | 本地 TXT 只读解析与统一写入、解码和元数据兼容、章节与进度、回执恢复、来源冲突、取消和停机。 | 合成 TXT、实际 Python 和临时 SQLite、真实/受控 Worker 与子进程；不会导入实际资料或操作正式服务。 |
| `npm run verify:douyin-manager` | 下载队列停止、数据库连接释放、作者汇总/分页/刷新候选的一致快照、游标分页、已加载行更新、请求竞态与深页索引。 | 临时 SQLite、独立子进程、动态 HTTP fixture 与无头浏览器；不启动或停止正式 8765 服务。 |

下载链接游标以首屏 ID 水位和已下载时间排序边界限制后续页，每次请求使用短 WAL 快照；它不会冻结整个翻页过程。新增链接或移到已消费边界之前的记录在主动刷新后出现，后台按已加载 ID 更新状态。fixture 分别验证这一边界、旧 offset 接口兼容，以及已下载深页使用表达式索引而不做临时排序。

`Application checks` 工作流在 Windows 上运行日常门禁、前缀分页隔离、浏览器请求竞态、作品与封面性能、文件流生命周期、音乐读图、作品封面生成，以及小说汇总、写入和凭据检测 fixture。它使用 Node.js 24、JDK、Python 与宿主 Chrome/Edge，不构建或安装 APK，也不运行完整应用或真机验收。修改工作流后，本机命令通过与 GitHub 执行成功仍须分别记录。

更多资料解析、图库、小说、访问分析、游戏与性能脚本由 `npm run` 列出。
例如 `verify:image-library`、`verify:novels`、`verify:core-images` 都包含多个子检查；运行前查看整个脚本链。
一个脚本的成功不能覆盖同模块所有未执行的门禁。

## 浏览器验证的特殊条件

默认不设置 `FANHAO_BROWSER_TEST_BASE_URL` 时，验证器自行启动 `127.0.0.1` 临时服务，端口默认动态分配。
如果设置了该变量，验证器将访问指定服务，而页面交互可能发起写请求。
不要把它指向现有资料库来“借用环境”。

浏览器由 `CHROME_PATH` 或验证器中的 Chrome/Edge 候选路径定位；`playwright-core` 不会自动提供浏览器二进制。
无法启动浏览器应报告环境缺失，不能把未执行的交互测试记为通过。

## 启动与 Android 验证的特殊条件

`verify:startup` 在 Windows 下要求 `powershell.exe` 和 `pwsh.exe` 都执行成功；不是任选其一。
其 PowerShell fixture 拷贝启动器到临时目录、生成假服务并使用动态端口，不依赖正式的 `29998` 或 `8765`。
安装缺失运行时后再重跑，不要用正式服务替代 fixture。

原生客户端门禁还会在宿主 JVM 中编译并运行 Java fixture，不能归为纯源码检查：

- 准备包含 `javac` 与 `java` 的 JDK，按脚本的定位规则设置 `JAVA_HOME`；不同验证器的默认路径和 PATH 回退并不相同。
- 短视频 actions 验证需要本地 Android platform 的 `android.jar`，可通过 `ANDROID_HOME` 或 `ANDROID_SDK_ROOT` 定位 SDK。
- 短视频 actions 验证需要 Gradle 缓存中的 `org.json:json` JAR；缓存根由 `GRADLE_USER_HOME` 或用户目录下的 `.gradle` 决定。该 fixture 不自动下载缺失 JAR。
- 视觉生命周期的 Google Tasks 验证需要 Android SDK 与本地 Gradle 依赖缓存。优先使用转换后的 runtime JAR；只有原始 AAR 时，仅把其中的 `classes.jar` 提取到验证临时目录，不需要先构建 APK，也不自动下载依赖。
- 执行会创建并清理临时目录与编译产物，部分 fixture 会写入测试状态或使用本机 HTTP 服务。它们不构建 APK，也不替代 Android 真机验收。

| 命令 | 注意事项 |
| --- | --- |
| `npm run setup:android-verification` | 显式在 Android 目录执行 `ci --include=dev --ignore-scripts --no-audit --no-fund`；需要包源访问并改写其依赖目录。首次运行或锁文件变化后执行。 |
| `npm run verify:android-security` | 使用已有 Android 依赖运行安全检查；不会自动执行 `npm ci`。依赖缺失时先运行上面的 setup。 |
| `npm run verify:android-gradle-config` | 调用 Android 工程自己的 Gradle 配置检查。 |
| `npm run verify:short-video-client` | 已提交的短视频客户端检查入口；包含上述原生 JVM fixture，但不覆盖整个 Android 应用。 |
| `npm run verify:android-release` | 发布所需的工作流、鉴权、写权限、安全、Gradle 配置和导入门禁；不包含所有 Android UI 回归。 |
| `npm run verify:android-full` | 显式运行完整 Android 客户端、system control、作品移动、小说 UI、短视频原生、安全、鉴权和导入回归；runner 会把重复的缓存同步和叶子检查去重。 |

`verify:android-security`、`verify:android-client` 和 `verify:short-video-client` 会先运行幂等的 `sync:cache`，同步 Android Web 缓存版本引用；这会改写需要更新的生成引用，但不会重装依赖。`verify:android-client` 继续作为客户端行为聚合入口使用，也不能替代真机验收。

不要把 `install:debug`、`publish:debug` 等发布/安装脚本混进普通检查。
它们的写入对象与授权要求不同，见[开发流程](../guide/development.md)。

## 完整应用门禁

```powershell
npm run verify:full
```

该命令展开现有 `verify:*` 模块入口，按原有顺序执行全部行为检查，并对完全相同的叶子命令去重；例如 native video progress 和 media channel fixture 在一次完整门禁中各执行一次。模块入口本身保持兼容，可继续单独运行。
前项失败会阻止后续项执行。除 Node 依赖外，还包括 Python 检查、浏览器、PowerShell 及 Java fixture；须先显式准备 Android npm 依赖，并具备 JDK、上述 Android platform 与 Gradle JAR 缓存。
部分 Python 检查依赖第三方包，例如 `verify:javdb-card-facts` 使用 `bs4`；不能只装根目录 npm 依赖就承诺完整门禁可运行。
按失败脚本的导入与所属工具要求补齐环境，不要为了让总命令变绿而跳过门禁。

## 如何报告结果

每次交付记录检查对象、命令、结果、未执行原因和环境条件。
例如：“文档 check/build 通过；未启动应用；未运行 Android 和真实资料库验收。”
如果总门禁中断，列出首个失败项及尚未执行的范围，不能说“其余全部通过”。
性能结论还需数据规模、测量条件与重复结果；一次计时不是通用基准。
线上或本机现有服务的验收另行记录，不能由源码 fixture 推导其已部署状态。
