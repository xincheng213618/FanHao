---
title: 图库列表与分页
description: 图库版本变化后的分页补齐、原始偏移和两端卡片复用边界。
status: maintained
verified_at: 2026-10-04
sources:
  - src/modules/content-index/server/image-library-service.js
  - src/modules/content-index/server/image-library-index-service.js
  - src/modules/content-index/server/image-gallery-db-service.js
  - lib/gallery-metadata-revision.js
  - src/modules/media/server/gallery-metadata-service.js
  - src/modules/photos/server/manga-service.js
  - public/modules/content-index/gallery-page.js
  - public/modules/content-index/gallery-renderer.js
  - android-client/www/platform/content-index/channel-views.js
  - tools/verify_image_query_correctness.mjs
  - tools/verify_image_gallery_db.mjs
  - tools/verify_android_media_header.mjs
  - tools/verify_photo_search_clients.mjs
  - tools/verify_gallery_list_rendering.mjs
  - tools/verify_android_channel_rendering.mjs
  - tools/fixtures/image-library-channel-server.mjs
  - package.json
---

# 图库列表与分页

图库追加页同时检查列表版本和原始分页偏移。相册重扫或影视元数据变化可能把已显示条目移到尾部；继续按旧顺序的 offset 追加会漏项，按去重后的卡片数继续请求则可能反复取得重复尾页。

## 接口与版本

`GET /api/image-library/items` 保留原有筛选、排序和响应字段，并返回两个字段：

| 字段 | 含义 |
| --- | --- |
| `listRevision` | 不透明的变化标识，只用于比较是否相同。 |
| `nextOffset` | 规范化请求 offset 加上本次实际返回的原始条目数。 |

标识包含当前服务、索引发布与失效状态。影视额外检查元数据库连接、schema 和相关元数据表的版本：电影依赖电影表，电视剧与动画依赖剧集表，混合影视依赖两者。相册列表不依赖元数据库写入。漫画在已有公开条目映射中累计内容签名，并核对目录和数据库状态。读取前后来源变化时返回一次性标识，避免把旧结果标记成新的稳定版本。

图库数据库初始化会追加两行元数据版本记录，以及电影、剧集表各自的新增、更新、删除触发器。版本与业务写入在同一事务变化，支持其他连接提交；未提交写入和回滚不改变读连接看到的版本。独立视频封面缓存写入不会触发电影或剧集列表补齐；元数据表中的海报和其他字段更新仍会改变对应版本。

热态检查只读取 schema 和最多两行主键记录；schema 变化时重新核对版本表与触发器的 SQL 契约。旧数据库缺少记录、记录损坏或触发器缺失及被替换时，回退到本连接写入、外部提交和 schema 的整库检查，保证兼容性；此时封面缓存写入仍可能触发补齐。

标识不冻结整个翻页过程，也不提供数据库事务快照。客户端不解析其中的内容，不持久化新的 schema。旧接口缺少标识时，两端按 `scannedAt` 变化回退；无法检测同时间戳的变化。带标识与不带标识的页不能当作同一版本直接追加。

## 补齐与失败

Web 与 Android 都保存独立的原始已读取数量，显示数量只统计去重后的卡片。优先使用有效的 `nextOffset`，旧接口回退为请求 offset 加响应长度；达到原始总量或空页后停止续页。

追加发现版本变化时，丢弃该追加结果，从 offset 0 补齐已读取范围及本次目标页。每段最多请求 5000 条，并按服务器实际返回量推进，兼容更低的响应上限。段间版本变化最多重试三轮完整补齐；未成功时保留原列表与重试范围，显示可重试错误，不发布半份新列表。

请求绑定当前查询与页面所有者。查询、来源或模块变化后，旧成功、错误和完成回调不能更新新页面或写入其缓存。Web 阅读器出现时可以完成后台列表缓存，但不重绘阅读器、覆盖阅读状态或改变当前阅读位置。

Android 完整补齐从头读取的范围后，也按原范围键缓存聚合结果，保留分段加载后的冷启动离线恢复。完整范围缓存缺失时可以读取已缓存的首段；尚未完成的在线补齐不会发布半份新列表。旧范围明确缩小时仍按新的目标重新读取。

## 卡片复用

同一筛选、布局和稳定顺序下，普通平铺列表与 Web 电视剧作品书架保留旧卡片、图片节点、焦点和封面 observer。加载与错误只更新尾部控件；成功仅追加新 ID 或替换内容变化的卡片，替换时释放旧图片观察目标。加载期间禁用续页按钮，失败重试保持原请求范围。

Android 影视标题栏在同一频道和标题布局下保留内联搜索按钮，只更新数量、文字与辅助标签，避免翻页时丢失键盘焦点或重复绑定点击。频道、布局或搜索能力变化时按原有规则重建。

Android 相册瀑布流沿用条目索引与列数分配，追加到既有列。列数变化、重排、删除、缺少稳定 ID 或客户端分组时仍使用完整重建。漫画分组与相册集合展开保留原有完整渲染规则，不把展开后的集合数用作服务端 offset。

## 验证与适用范围

```powershell
npm run verify:image-query
npm run verify:photo-search
npm run verify:gallery-rendering
npm run verify:android-channel-rendering
```

查询检查使用实际服务、合成索引和私有 SQLite，核对重排、外部提交、连接替换、版本记录与触发器损坏回退及固定探测开销。两端浏览器检查使用当前客户端与完整 CSS、动态 loopback API 和合成图片，核对漏项补齐、封面缓存写入、服务器响应上限、重复尾页、失败重试、取消、搜索焦点与卡片保留。Android 命令先同步生成缓存引用，不安装或发布 APK。

节点数量与计时只描述该私有 Chromium 条件；它们不证明真实资料库耗时或 Android 真机体验。正式服务、真实媒体和设备验收遵循[验证矩阵](../reference/verification.md)与[数据边界](../ai/safety.md)。
