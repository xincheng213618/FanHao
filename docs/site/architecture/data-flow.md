---
title: 数据与请求流
description: 从客户端请求追踪到模块存储、worker、下载管理器和媒体响应。
status: maintained
verified_at: 2026-10-04
sources:
  - src/modules/media/server/gallery-metadata-service.js
  - src/modules/short-videos/server/navigation-queries.js
  - src/bootstrap/server-config.js
  - src/platform/server/http-app.js
  - src/platform/server/static-files.js
  - src/platform/server/auth.js
  - src/fanhao/module-registry.js
  - src/modules/fanhao/server/library/core-db-service.js
  - src/modules/fanhao/server/library/cache-contracts.js
  - src/modules/fanhao/server/library/table-stamp-query.js
  - src/modules/fanhao/server/library/cross-store-outbox-service.js
  - src/modules/fanhao/server/works/work-query-service.js
  - src/modules/fanhao/server/works/work-cache-budget.js
  - src/modules/fanhao/server/catalog/studio-service.js
  - src/modules/fanhao/server/catalog/code-prefix-service.js
  - server.js
  - src/modules/short-videos/server/runtime.js
  - src/modules/short-videos/server/product.js
  - src/modules/short-videos/server/store.js
  - src/modules/fanhao/server/people/actor-avatar-service.js
  - src/modules/fanhao/server/admin/admin-actor-avatar-service.js
  - src/modules/system/server/admin/routes.js
  - src/modules/short-videos/server/query-contract.js
  - src/modules/short-videos/server/list-page-queries.js
  - src/modules/short-videos/server/download-manager-sync-service.js
  - src/modules/short-videos/server/watch-write-service.js
  - src/modules/short-videos/server/watch-write-worker.js
  - src/modules/short-videos/download-manager/manager_core/database.py
  - src/modules/short-videos/download-manager/manager_core/read_models.py
  - src/modules/short-videos/server/delete-job-service.js
  - src/modules/novels/server/runtime.js
  - src/modules/novels/server/write-worker-client.js
  - src/modules/novels/server/write-worker.js
  - src/modules/novels/server/store.js
  - src/modules/novels/server/collection-worker-client.js
  - src/modules/novels/server/collection-worker.js
  - src/modules/novels/server/collection-store.js
  - src/modules/novels/server/credential-service.js
  - src/modules/novels/server/reimport-service.js
  - src/modules/novels/server/local-reimport-artifact.js
  - tools/rescan_novel_library.py
  - src/modules/music/server/runtime.js
  - src/modules/music/server/store.js
  - src/modules/music/server/routes.js
  - src/modules/music/server/progress-receipts.js
  - src/modules/music/server/facet-cache.js
  - src/modules/music/server/facets.js
  - src/modules/music/server/constants.js
  - src/modules/music/server/scan.js
  - src/modules/market-dashboard/server/quote-service.js
  - src/platform/server/library-path-safety.js
  - src/platform/server/media-stream-service.js
  - src/platform/server/file-server.js
  - src/platform/server/media-response-service.js
  - src/platform/server/media-blob-worker-client.js
  - src/platform/server/media-blob-worker.js
  - src/platform/server/remote-image-warm-queue.js
  - src/platform/server/archive-image-service.js
  - src/platform/server/archive-task-pool.js
  - src/platform/server/image-reader-cache-service.js
  - src/modules/photos/server/photo-set-service.js
  - src/modules/photos/server/runtime.js
  - src/modules/content-index/server/image-library-index-service.js
  - src/modules/photos/server/manga-service.js
  - src/modules/photos/server/manga-database.js
  - src/modules/content-index/server/image-gallery-db-service.js
  - public/modules/content-index/gallery-page.js
  - public/modules/content-index/gallery-renderer.js
  - public/modules/content-index/catalog.css
  - public/modules/content-index/styles.css
  - tools/verify_gallery_list_rendering.mjs
  - public/js/standalone-host.js
  - public/modules/photos/manga-page.js
  - public/modules/music/player/engine.js
  - public/modules/music/music-page.js
  - public/modules/music/actions.js
  - public/modules/music/api.js
  - public/modules/music/music-progress-writer.js
  - public/modules/music/progress-session.js
  - android-client/www/modules/music/music-views.js
  - android-client/www/modules/music/music-list-pagination.js
  - android-client/www/modules/music/music-catalogue-requests.js
  - android-client/www/modules/music/music-catalogue-refresh.js
  - android-client/www/styles.css
  - android-client/www/modules/music/progress-transport.js
  - public/modules/novels/novel-page.js
  - public/modules/novels/progress-writer.js
  - public/modules/novels/collection-admin.js
  - src/platform/server/local-image-read-queue.js
  - src/platform/server/video-probe-service.js
  - src/platform/server/video-probe-task-pool.js
  - src/platform/server/video-probe-cache-service.js
  - src/modules/media/server/gallery-media-service.js
  - src/modules/content-index/server/image-library-service.js
  - src/modules/media/server/runtime.js
  - src/modules/fanhao/server/works/work-cover-mutation-service.js
  - lib/cover-frame.js
---

# 数据与请求流

排查 FanHao 时，应分别确认请求是否到达、权威状态是否写入、缓存是否刷新、媒体文件是否仍可访问。这些是不同环节，不能仅凭页面更新判断持久化成功。

## 一次普通请求

```text
Web / Android
      |
      v
http-app.js：跨源检查、鉴权、访问记录
      |
      v
module-registry.js：依次调用模块 API 路由
      |
      +--> 模块 service / store / worker --> 数据库或外部来源
      |                                  |
      |<------------- 结果 --------------+
      |
      +--> 未匹配 API 时：模块媒体路由 --> 文件 / BLOB / 媒体流
      |
      +--> 仍未匹配且为 GET/HEAD：静态资源
```

这是公共入口的分发顺序；认证路由和公开 Android 更新接口有专门分支。具体请求还可能被模块内部的权限、输入校验或错误边界提前终止。

静态资源异步打开文件，并用同一个句柄读取属性和正文，避免路径替换使响应长度与正文来自不同文件。主服务和独立短视频入口将它纳入停机：先停止准入并撤销响应，再等待未完成的打开、属性查询、流和首次原生句柄关闭。默认等待 2 秒；无法确认关闭时保留所有权并报告失败，禁止重新准入。发送响应头前的异常由公共请求边界处理，正文传输失败则关闭响应；压缩与静态缓存策略沿用现有规则。

未处理异常由公共边界记录，5xx 默认返回通用错误。模块也有自己的错误响应；新增接口时应检查当前模块契约，不应把数据库路径、SQL 或内部异常直接返回客户端。

## 数据所有权

下表是源码默认位置，不是部署实例的盘点。带环境变量覆盖的路径、媒体根目录和实际数据库版本都需在操作前确认。

| 状态 | 默认位置或来源 | 所有者 |
| --- | --- | --- |
| 人物、作品和关系 | `data/fanhao-core-v2.sqlite` | 番号模块核心库服务 |
| 核心图片存储 | `data/fanhao-core-images.sqlite`，可配置 | 核心图片存储服务与使用它的业务流程 |
| 图库索引与影视元数据 | `data/image-library-index.json`、`data/image-gallery.sqlite` | `content-index` 及图库/影视业务 |
| 小说正文与阅读状态 | `data/novels.sqlite` | 小说存储 |
| 小说采集任务 | `data/novel-collection.sqlite` 和任务输出目录 | 小说采集服务 |
| 音乐目录和状态 | `data/music.sqlite` | 音乐存储 |
| 短视频目录和用户状态 | `data/short-videos.sqlite` | 短视频存储 |
| 下载队列与下载记录 | 下载管理器自身的 `data/douyin_downloads.sqlite` | 独立下载管理器 |
| 番号收藏、播放等状态 | `data/user-state.json` | 对应用户状态服务 |
| 本地媒体内容 | 配置的库根目录 | 文件系统；数据库保存索引与映射 |
| 行情 | 外部行情来源与服务内缓存 | 行情服务，不是本地媒体数据库 |

不能把这些位置概括为“一个数据库”。复制主库不能代替完整备份，也不能推断外部媒体、下载记录、图片库或凭据已经随之迁移。

## 短视频的两条数据来源

主服务使用自己的短视频 SQLite 提供信息流和用户操作。下载管理器数据库保存采集与下载侧状态；二者职责不同。

短视频正数画质区间直接比较像素列，使快速列表的计数和分页使用索引范围查找；未知画质保留空值和非正值语义。画质与显式媒体类型独立相交，普通列表、观看历史和前后切换遵循相同筛选约束。前后切换和批量预取按列表各排序键的方向逐项比较，保留 ID 降序的并列规则，并沿用对应列表的空值和未知值规则；非空字段的发布时间倒序查询仍使用元组范围查找。

`download-manager-sync-service.js` 根据来源数据库状态决定是否启动 `sync-worker.js`。同步改变展示目录后，运行时通过回调处理目录缓存失效；它不是让每次列表请求直接读取下载管理器 HTTP 接口。

下载管理器的作者列表在一个短 WAL 读事务内建立作品汇总、筛选、计数、分页并计算刷新候选，避免并发更新使昵称、作品数和刷新设置来自不同快照。请求完成或失败都会关闭连接；下一请求重新读取当前状态，翻页过程仍不冻结整个资料库。

短视频运行时也代理部分管理器接口，因此诊断时要区分：

| 症状 | 优先核对 |
| --- | --- |
| 管理器页面或任务不可用 | 管理器连接地址、独立进程和相关代理请求 |
| 下载已完成但列表未出现 | 来源数据库、同步状态、展示库与目录缓存 |
| 列表正常但无法播放 | 记录映射的文件、根目录校验和媒体响应 |
| 观看状态不稳定 | 写入 worker、数据库回执与列表覆盖/失效逻辑 |

## 写入、回执与缓存

短视频观看请求由运行时委托 `watch-write-service.js`，worker 执行存储写入或查询回执。请求排队、SQLite 忙等待、worker 超时和数据库提交不是同一状态；不得用延长一个超时掩盖所有失败。

列表缓存和临时观看覆盖服务于响应速度，SQLite 状态仍需单独核实。对写入失败的验证应覆盖实际回执与重试结果，而不只是检查界面是否变色。

番号核心库的部分缓存采用表数据戳，依赖集合在 `cache-contracts.js` 声明。修改写入路径时，需要检查受影响表和缓存失效调用；重启进程后“恢复正常”并不能证明失效契约正确。

片商与番号前缀目录共同依赖作品、厂商、系列、对应关系、外部链接和本地作品表。新增七张依赖表的数据戳只读取连接身份、SQLite `data_version` 和无行的表存在性检查，避免冷请求扫描关系表；这也识别其他连接提交的同时间戳更新，并兼容缺少 `updated_at` 的旧表。主线程切到持久 Worker 时安全失效一次，同一 Worker 后续读取复用；同连接写入仍须显式失效，外部提交由既有后台刷新发现。

音乐歌手按名称排序时，每条记录先规范化一次排序键，再复用同一个中文数字排序器；排序等价的记录维持原次序。缓存仍保存原记录，筛选、分页和响应字段沿用现有规则。

作品列表、搜索和片商派生缓存同时限制条目数与累计作品引用数，避免少量大查询保留过多数组。页面缓存另设作品行数预算；超过单个预算的大页正常返回，但不长期保存响应。全局淘汰索引使用弱引用，不能反向保留已经退出缓存的来源数组，账号和数据戳变化仍触发原有失效流程。

番号前缀的来源与排序结果共用 400 万作品引用预算，两类缓存各保留最多 96 条。结果对来源数组的强引用也保守计入预算；过大的请求正常返回当前页而不进入缓存。普通查询仍按最近使用顺序淘汰，分页 offset 不重复筛选或排序；账号变化只失效结果，来源变化和显式失效同时释放两类缓存。这是数组引用预算，不能当作进程堆内存的精确上限。

小说的进度、元数据、上传、文本重导入、采集入库和删除由一个有容量上限的写入 Worker 执行。业务变化与回执在同一事务提交；内部写入服务明确携带同一 `operationId` 重试时返回原结果，参数变化则冲突。线程异常后，先确认原线程退出，再检查回执；匹配的回执证明已提交，缺失回执只能报告结果不确定，不能据此自动重放。仅清理调用方已经确认收到的内部回执；清理失败保留回执，也不撤销已确认的业务结果。

本地 TXT 重导入先由 Python 只读解析并导出私有临时 JSON，HTTP 流程不会让 Python 直接写书库。主线程流式校验产物，统一写入 Worker 在业务事务前读取正文，再在锁内核对来源、目录版本和删除状态；章节替换与回执一并提交。保留原 Python 解码、格式化和元数据行为，产物默认最多 512 MiB；这一限制不表示 Python 全部内存使用有同样的上限。解析阶段断连或停止会终止子进程并等待退出，已派发的写入先完成，再关闭写入线程和清理临时文件。

小说采集任务和日志处理在独立 Worker 执行，主线程持有采集子进程并限制后台 RPC 队列；采集结果仍通过同一个小说写入服务入库。入库前在任务库保存写入标识与待确认状态，成功后再保存完成结果；异常或中断后保留待确认任务，停止直接重试和历史自动清理，先核对书库。停止时先终止采集子进程、等待已经派发的导入，再关闭共享写入线程。凭据检测也异步运行，限制输出、等待进程退出，并拒绝凭据变化后的迟到结果。采集数据库本身没有提交回执，已派发的任务变更在 Worker 异常后报告结果不确定，需要刷新核对。

## 文件与数据库的联合变更

文件移动或删除无法由普通 SQLite 事务独自回滚。短视频删除作业服务记录计划、文件隔离、数据库提交与后续清理，并保留恢复状态；部分请求还带 `operationId` 用于识别重试。

该流程有逻辑删除和真实文件删除等分支，不能把某一条成功路径当成全部行为。涉及删除、路径移动或中断恢复时，先阅读 `delete-job-service.js` 和对应夹具，不要绕过作业服务直接删文件或 SQL 行。

核心资料发布还使用跨存储 outbox 服务。需要联动不同存储时，应先追踪现有恢复机制，明确“已提交但清理未完成”与“尚未提交”的区别。

## 媒体响应

客户端通过媒体 URL 取内容，模块负责把业务 id 映射为受控文件或图片记录，再调用平台媒体响应能力。路径安全、Range 读取、转码或缓存属于独立检查点。

图库相册在筛选、搜索和排序完成后，为当前页的编号相册计算显示主题；未编号主题仍参与人物筛选判定。影视列表按频道读取相关批量元数据，封面字段只投影存在性，详情和封面端点仍按 ID 读取原记录。同一请求按来源剧集键复用一次公开元数据解析，包括缺项；结果不跨请求缓存，批量缺项不逐条回查。列投影按连接复用，在 schema 变化时重建。名称排序复用默认语言的数字排序器，保持原有大小写、重音与并列规则。

媒体 ID 查找随索引或数组替换重建映射。相册映射由扫描索引的所有者维护，加载新快照、重扫、失效或相册服务成功停止时释放；同 ID 保留首项，记录仍按每次请求构造响应。未注入查找能力的相册服务沿用数组扫描，保留自定义数组原位变更行为。两类查找均保留原记录引用，来源、路径、归档签名及封面数据库校验照常执行。

Web 与 Android 图库的普通平铺列表及 Web 电视剧书架在同一筛选、布局和顺序下翻页时保留已有卡片、图片节点、封面 observer 和焦点，仅追加新 ID 或更新内容变化的卡片；Android 影视内联搜索按钮也保留焦点。加载和错误局部更新控件；重排、缺少稳定 ID、分组或 Android 瀑布流列数变化时仍重建列表。两端按原始偏移推进，并在列表版本变化后补齐已显示范围；影视版本按相关元数据表记录，独立视频封面缓存写入不触发补齐，旧库及契约损坏时回退保守检查。协议和失败边界见[图库列表与分页](./gallery-lists.md)。

支持相应 CSS 的浏览器在影视海报模式下延后屏幕外文字区域的布局。文字区域沿用现有截断行数，固定为 91px，窄屏为 111.2px，避免同一节点切换屏宽时沿用旧高度；修改文字行数或字号时须同步核对占位。海报比例、封面加载、按钮焦点和列表模式保持原有行为；此优化减少布局开销，不减少 DOM 创建。

Web 阅读器的相册、漫画章节和媒体导航共用请求所有者；换源、返回或重置时取消旧请求，迟到的成功、错误和完成回调不能覆盖新页面。相同相册的追加请求合并，页面只追加新图片节点，保留既有加载队列、observer 和阅读进度。全量图片目录迟到时按当前图片 URL 保留单页阅读位置。

独立图库、漫画馆、音乐馆和小说馆宿主收到浏览器前进、后退时立即应用最新路由，撤销旧阅读请求；旧请求未完成也不会阻塞新路由。初始化历史记录使用当前 URL 的完整目标，模块加载期间重新核对 URL，首屏等待最新路由稳定后显示。离开当前模块立即撤销阅读请求并切换文档。

音乐列表与单曲各自核对请求归属；导航、筛选和关闭详情撤销旧请求与搜索定时器，但保留当前歌曲、歌词、播放队列和 Audio。旁栏的迟到歌单不能覆盖新结果；上次歌曲恢复仅在原始列表意图仍有效且没有新选歌时启动。单曲详情后的背景目录加载不恢复旧歌曲，旧请求的错误、结束及后续导航也不能重新打开详情页。

Web 搜索分页以合并后的优先音频版本刷新列表，不直接追加原始记录；下一页仍使用原始记录数作为 offset。跨页发现同歌曲的更优格式时更新可见版本，同时保留滚动位置、当前播放来源、歌词和播放器节点。

Android 音乐的普通书库与智能歌单翻页保留旧行和迷你播放器，只追加新曲目；同 ID 的返回记录更新已有行、列表和队列，原始记录数继续决定服务器 offset。分组搜索、艺人与专辑列表保持完整重绘。列表代次、当前曲目或播放状态变化时才更新歌曲行的播放标记，进度事件继续刷新时间和进度控件。

首屏歌曲与后台歌单并行加载。歌单响应仅更新首页统计、歌单入口、语种、详情元数据或已打开的歌单选择列表，保留歌曲行、播放器和弹窗容器；搜索页仍按已有搜索刷新流程更新匹配结果。每类歌单请求分别核对最新代次、来源和页面归属，迟到的成功与错误均不能改写新页面。深链接与保存队列恢复在后台加载完成后再次核对页面和选歌代次，新选歌开始即阻止旧恢复和首屏请求改写加载状态、队列；单曲详情、音频加载与播放 Promise 的尾部也沿用同一次选歌的归属检查。选歌请求未结束时暂缓自动衔接；已开始的衔接与资料补全迟到时不能回滚新选歌。

支持相应 CSS 的浏览器还对直接位于平铺歌曲列表中的行启用 `content-visibility: auto`，跳过屏幕外行的内部布局。未测量行使用 51px 内容占位，加上现有内边距和边框后保持 66px 行高；已测量行保留自身尺寸。节点继续存在，滚动定位、焦点和点击仍由现有页面处理。该规则不应用于分组搜索和播放器，减少的是布局开销，不能视作 DOM 创建或真机播放性能保证。

音乐封面在设置图片地址之前先设置加载和解码策略，让普通列表封面按浏览器的原生懒加载规则请求。封面详情继续使用立即加载；浏览器决定预取距离，不能据此保证固定的首屏请求数量。

小说书库、书籍详情、章节与目录请求也按导航归属失效，旧目录和管理页刷新不能重建当前阅读页。同布局书库刷新在请求期间保留已有卡片，只更新加载提示、筛选控件和尾部；结果返回后再替换列表。下一章预取有独立取消信号，翻到同版本的目标章节时可接管有效预取；历史导航恢复进度会重新读取，不复用旧预取中的进度快照。离开时先保存已恢复的可见阅读位置，再撤销请求和延迟回调。滚动恢复绑定书籍版本、章节、当前 DOM 和导航，完成前不以尚未恢复的页面位置覆盖已保存进度。

小说列表返回来源身份、`listRevision` 和原始 `nextOffset`。版本标识由数据库及 WAL 文件戳生成，读取期间文件变化则返回一次性标识；它用于发现变化，不冻结整个翻页过程。Web 追加时若版本或来源变化，从头补齐已显示范围及下一页，每段最多 5000 行，段间变化最多重试三次；未成功时保留旧列表并允许重试。重复书籍按来源和 ID 更新内容，显示条数不代替原始 offset。旧接口缺少版本标识时保留兼容，无法提供同样的变化检测。

小说 Web 进度写入只保留一个普通在途请求，按书籍、来源和目录版本合并后续位置；最多保留 32 个待写键和 8 个显式确认。记录只包含标量身份和进度，不捕获书籍快照或章节正文。恢复确认独立等待页面存活期间的实际回执，失败或 `applied: false` 不清除恢复提示；退出页面不保证排队中的恢复确认完成。页面离开时同步发出各书最新的普通 keepalive 位置，恢复页面或新保存意图可继续调度；浏览器是否送达退出请求仍受其网络与卸载行为影响。

书籍元数据与章节读取提供服务器时钟。Web 同一会话的普通请求和 keepalive 共用 UUID、固定开始时间和递增序号；重试不能把旧记录标成新意图。SQLite 将最高序号、阅读位置和既有写入回执放在同一事务内，迟到或重复序号返回当前位置及 `applied: false`。不同会话沿用到达顺序，较新的序号可以合法保存更靠前的位置。会话有效期 24 小时，到期重新读取时钟后以当前阅读意图建立新会话；持久时钟下界防止时钟回拨使已过期记录复活。账本最多 8192 条、每书 32 条，仅清理过期或失效目录记录，容量满时明确拒绝新增会话。未携带顺序字段的旧客户端保留既有兼容和身份校验，不获得这项同会话顺序保护。

独立漫画馆的书库、作品与章节请求共用前景所有者；深链接的作品、章节两步使用同一所有者，取消后不再续发旧章节。迟到响应不能改写页面、地址、加载状态或阅读进度。更新与采集任务只刷新目录和作业资料，保留当前阅读节点与滚动位置；删除结果仅清理被删作品，删除期间已切到另一作品时保留新的前景。正在返回的目录响应会过滤已完成删除的作品，保留其他条目。

漫画服务批量读取作品来源和下载数量，建立作品 ID 与目录的索引，同源副本仍优先选择下载数量最多的目录，并兼容旧目录 ID。所有候选目录均有 manifest 且来源来自 SQLite 时，已知作品请求复用索引，只检查根目录、数据库连接与 `data_version`、目标目录和 manifest；数据库文件替换也会重新打开连接。使用 JSON 来源回退或存在未就绪目录时，每次重建索引，保证原地修改目录资料立即可见；显式书库查询和未知 ID 也重新扫描，不保留负结果。

音乐筛选缓存按数据库连接保留最近使用的结果，最多 128 条，键与结果的估算 JSON 总量最多 16 MiB；超过 4 MiB 的单条结果或 4096 字节的键直接返回，不保留到缓存。这是序列化数据预算，不能当作进程内存的精确上限。字母筛选中 SQL 行为相同的参数共用缓存键，分页和响应仍保留原有行为；扫描发布或数据库失效会丢弃对应连接的缓存。

音乐汇总仍以 5 秒有效期复用。会话申领、重复或迟到且未应用的进度，以及仅提交过期时钟下界的事务，不清空曲目汇总；实际位置或播放计数变化、收藏、评分及清空历史仍立即失效。目录扫描继续更新连接和筛选缓存。“还没听过”“待评分”从当前有效目录中扣除对应状态，移出目录的历史不压低计数；原稳定 ID 回到目录后继续恢复既有播放和评分记录。

音乐播放器按播放代次、音频来源和当前歌曲检查 `play()` 的异步拒绝；换源、暂停或新的播放意图会撤销旧错误归属。当前有效播放拒绝仍显示错误并允许重试，迟到的旧播放 Promise 不会把错误附到新歌曲。

音乐 Web 与 Android 进度写入按来源和歌曲串行合并位置，普通请求总并发最多 4 个，最多保留 64 个键和 128 个播放回执。离页同步优先发送当前歌曲的 keepalive；普通队列满时额外保留最多一个当前歌曲快照，等待恢复后释放槽位再调度。退出请求共享 48 KiB 估算记录预算，最多 192 个在途；只有实际 API 回执才确认完成。捕获时固定账号、来源和序号，旧请求不能继承切换后的账号。有效 UUID 播放回执可在离页重送，旧格式计数不会重复发送；浏览器卸载和网络仍决定最终送达。

单曲详情和只读 `progress-clock` 提供服务器时钟；播放及显式跳转用 `progress-session` POST 申领持久递增的会话开始时间，仍有效的当前归属可复用。未确认的预留不抢占位置，新的合法进度提交才切换归属；已退役会话和迟到序号不能回滚新位置，较新序号可以合法向前回听。SQLite 同事务保存序号、位置和独立播放 UUID 回执，响应分别返回 `progressApplied` 与 `playedApplied`。会话及回执有效期 24 小时，持久时钟下界防止回拨复活；会话总数最多 8192、每曲 128，播放回执最多 8192，仅清理过期记录，容量满返回可识别的拒绝。旧无身份字段客户端保留到达顺序兼容；旧自定义会话的同时间到达顺序不适用于服务端预留归属。

压缩包列表、抽取、图片转换和响应传输共用有限任务池，默认同时运行 4 个任务、总容量 128 个，子进程及文件流的名额保留到实际关闭；每个响应独立拥有传输任务。缓存签名包含路径、大小、精确修改时间及磁盘文件身份；旧数据库通过已有初始化流程补充身份字段，缺少身份的旧缓存安全失效。异步完成后再次核对来源、数据库对象与记录状态，清缓存或停止后禁止迟到持久化；图片发送前再校验压缩包来源和缓存实际路径。图片阅读缓存异步合并目录巡检，清理和访问时间更新也异步执行，巡检期间的变化会合并到新摘要。

视频、音频、下载和内联文件服务异步打开文件，用同一个句柄取得属性并流式读取；调用链等待文件流及句柄实际关闭。主服务及短视频产品登记文件传输的生命周期，停止时取消响应并等待物理资源释放；文件服务默认等待 2 秒后仍无法确认关闭则报告失败，保留所有权并阻止重开。HEAD、空文件、非法范围、读取失败与断连均释放句柄，异步打开或查询期间断连不会发送迟到响应。Range、If-Range、原文件总长度和启动缓存前缀规则沿用既有契约；正文读取失败时终止响应。

数据库图片由共享 Worker 串行派发，默认最多接收 128 个任务，并限制待处理参数的累计字节数。前台读取优先，后台缓存操作定期取得名额；写入参数在准入时复制，传输不会修改调用方的图片。相同键的冷图片读取合并，完成内容进入热缓存；缓存预算包含键、标量元数据、条目开销与 BLOB 实际 backing storage，默认最多 512 MiB、4096 条。未知复合元数据直接服务而不保留到热缓存；版本化头像仍逐请求检查持久撤销记录。停止期间拒绝新请求，线程的所有权保留到实际退出，不能用终止请求或错误回调代替退出确认。

远程图片预热和直接图片请求共享队列，默认最多同时运行 6 个任务、总容量 128 个；容量不足时图片请求仍保留原有重定向回退。目标 URL 的原文与规范化长度均最多 64 KiB，直接请求超限返回 414，预热过滤超限目标；代理封装允许额外编码长度。响应体按块读取，缺少或不准确的 Content-Length 也受图片大小限制。停机清除排队任务并取消下载，等待网络读取及已派发缓存写入结束，禁止旧任务恢复热缓存或继续写入。

兼容转码默认同时运行 2 个子进程、总容量 16 个请求，排队等待和首字节等待都有上限，有效播放流不设总时长限制。GET 收到首段媒体才发送成功头；stdout 正常结束且子进程成功关闭后才正常结束 HTTP。输出后失败、管道错误和断连会中断响应并终止进程，并发名额只在进程实际关闭后释放；HEAD 不启动转码。

音乐封面的文件查询和读图使用异步路径，整个音乐封面请求默认最多同时运行 4 个，总容量 128 个；平台本地图片队列也保持有限并发和容量。读取前后核对路径、大小、修改时间及磁盘文件身份，最后一次异步操作后再核对数据库对象、缓存记录和音乐来源，变化时只向原请求交付回退内容，不写入成功或错误缓存。本地图片缓存的 SQLite 操作暂时关闭锁等待并还原原配置，缓存遇锁时回退，避免等待锁阻塞主线程。停止后拒绝新任务，取消未派发请求，并等待已派发的文件查询和读取实际结束；迟到的启动操作不能重新开放停止中的服务。

短视频本地封面与图集异步查询文件属性，整个图片请求同时运行最多 4 个、总容量 128 个；标准入口和独立产品都用同一文件句柄异步取得属性并流式响应，名额保留到文件流和句柄实际关闭。直接运行时接入共享图片服务时，缓存键包含实际大小、精确修改时间与磁盘身份；来源行、图集素材或数据库变化后禁止迟到缓存写入，也拒绝返回旧正文或旧读取错误。SQLite 封面仍直接返回已有 BLOB。

头像目录预览与导入异步读取 Filetree 和图片，单次应用只检查选中的映射路径，完整预览保留全目录统计。图片用同一文件句柄按大小上限读取，提交前复核文件、目录映射、人物和数据库归属；不替换模式跳过已有可用头像。每个人物单独提交，批量导入后项失败或断连时，已提交人物仍保留并刷新缓存。

作品封面生成异步探测和抽帧，限制同时运行和排队的任务；同一来源可合并多个请求。最后一个请求取消或服务停止时终止子进程，等待退出后释放并发名额。生成结果写入前再次检查作品、磁盘来源、人工封面和图片记录状态，变化时返回冲突；提交结果不确定时不自动重跑生成。

图库视频封面也异步探测和抽帧，默认最多同时运行 2 个任务、总计容纳 16 个任务。同一媒体和来源的请求共用任务，单个请求断连不会取消其他调用者；最后一个调用者断连或停止服务时终止进程并等待退出。成功和失败缓存写入前，都再次核对磁盘、索引、图片记录和数据库对象，拒绝来源变化后的迟到写入。

播放探测以内存容量上限保存完成结果，键包含库内文件大小与修改标识；缺少库内标识时，先异步检查磁盘来源。前台请求、原始异步探测和预热共用调度，默认最多同时处理 2 个冷任务，总容量 48 个，前台优先于排队预热。文件查询默认等待 2 秒，尚未返回的物理查询仍占用独立数量预算，避免反复清空缓存积累文件系统请求；暂时繁忙和查询超时不写入失败缓存。

冷探测完成后再次核对磁盘身份，清空缓存和更新来源会使旧任务失效，并终止相关进程。可选 SQLite 探测缓存也采用遇锁立即回退的策略，调用结束后恢复原锁等待配置，写入失败不更新持久缓存的内存快照。进程名额只在实际关闭后释放；停机先停止准入，再取消任务并等待关闭，无法确认关闭时报告失败并保留所有权。交互请求默认等待 80 毫秒后先返回可播放方案，已准入的后台探测继续；这不是对实际网络或媒体处理耗时的保证。库内标识命中的完成缓存保留免磁盘查询的快速路径。

文件存在不等于允许访问；字符串路径包含根目录也不等于真实路径安全。涉及符号链接、目录联接和跨卷操作时，应使用项目已有的实际路径校验。

## 调试所需最小证据

记录请求方法与脱敏 URL、模块和路由入口、状态所有者、预期与实际结果，以及所用临时夹具。只在必要时附加脱敏日志，不附真实媒体列表、Cookie、凭据或个人路径。

从[仓库地图](./repository-map.md)定位代码，再根据[验证参考](../reference/verification.md)验证读写与失败边界。新 AI 任务的上下文组织见[AI 上下文](../ai/context.md)。
