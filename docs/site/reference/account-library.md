---
title: 个人收藏与观看记录
description: 番号收藏夹、收藏及播放进度的账号归属、访客兼容和网页与 Android 切号边界。
status: maintained
verified_at: 2026-09-02
sources:
  - server.js
  - src/platform/server/http-app.js
  - src/modules/fanhao/server/collections/account-user-state-service.js
  - src/modules/fanhao/server/collections/favorite-state-service.js
  - src/modules/fanhao/server/user-state/routes.js
  - public/modules/fanhao/features/collections/collection-page.js
  - android-client/www/modules/fanhao/features/works/favorite-folders.js
  - android-client/www/modules/fanhao/features/rankings/ranking-views.js
  - src/modules/fanhao/server/playback/playback-progress-service.js
  - src/modules/fanhao/server/works/presenter-service.js
  - android-client/www/js/recent-content.js
  - android-client/www/js/account-owner.js
  - android-client/www/js/cache.js
  - public/platform/accounts/session-context.js
  - android-client/android/app/src/main/java/local/fanhao/library/NativePlaybackProgress.java
  - tools/verify_account_personal_state.mjs
  - tools/verify_account_personal_library.mjs
  - tools/verify_account_personal_clients.mjs
  - tools/verify_web_account_folders.mjs
  - tools/verify_web_folder_navigation.mjs
  - tools/verify_android_account_folders.mjs
  - tools/verify_android_ranking_cache_fence.mjs
---

# 个人收藏与观看记录

登录账号后，番号模块中的收藏夹、收藏、观看历史和播放进度属于当前账号。网页与 Android 连接同一服务并登录同一账号时，读写同一份个人记录。

新账号从空收藏和空历史开始，不自动复制原来的共享记录。未登录时继续使用原访客记录；退出账号后恢复访客视图。无需开启「访问资料库必须登录账号」，也不改变默认开放注册和邀请码不必填的策略。

## 数据范围

| 数据 | 归属 |
| --- | --- |
| 番号收藏夹、作品收藏 | 当前账号；访客使用原共享记录 |
| 番号视频播放位置、时长及观看历史 | 当前账号；历史由播放进度汇总 |
| 列表、搜索、人物、排行榜、片商及作品详情中的收藏/进度字段 | 当前请求账号 |
| 媒体文件、公共元数据、手动封面 | 继续共享，管理权限保持原有规则 |
| 其他内容模块的阅读、观看记录及设备本地资料 | 沿用各模块原有规则，本次不统一迁移 |

Android 首页「最近打开」目前记录照片、漫画及影视等内容，使用设备级列表，也不按服务器分区；它不是番号观看历史，本次仍共享。账号切换不会清空该列表。

管理员查看自己的个人记录，不因管理员角色自动获得其他账号的收藏或历史。本次没有提供跨账号查询、共享访客记录认领、账号数据删除或批量迁移接口。

## 整理收藏夹

网页在「收藏」中选中自建收藏夹后，可点击「重命名」或「删除收藏夹」；Android 在收藏夹筛选条点击「管理」。默认收藏夹保留，不能改名或删除。名称会合并连续空白并限制为 32 字，不能改为空名称或与其他收藏夹重名。

删除前会确认：夹内收藏全部移回默认收藏夹，保留收藏时间、作品和观看进度。已暂时不在媒体库中的收藏记录也会移回；只删除收藏夹本身。删除当前筛选的收藏夹后，两端显示默认收藏夹。

`PATCH /api/favorite-folders/:id` 接收 `{ name }`，返回 folder、folders 和 user；`DELETE` 同路径返回 deletedFolderId、movedCount、defaultFolder、folders 和 user。movedCount 包括暂时不可见的收藏记录，因此可大于列表可见数量。默认夹操作或空名称返回 400，目标不存在返回 404，重名返回 409。身份仍由登录会话确定。

新管理操作在保存失败时返回错误并恢复原状态；访客操作使用临时文件替换原状态文件。网页会刷新收藏查询及名称，Android 会更新相关列表缓存和筛选；切换账号或服务器后的旧操作不能回写当前页面。

## 存储与请求

原 `data/user-state.json` 继续保存访客记录和公共手动封面。个人数据使用独立的 `data/account-user-state.sqlite`，首次访问自动初始化，schema 版本为 1。账号及会话仍在 `data/accounts.sqlite`，不修改其 schema。

`account_user_state` 以后台验证过的账号 ID 为主键，保存 revision 和仅包含 favoriteFolders、favorites、progress 的 JSON。它不保存密码、会话、个人媒体副本或 manualCovers。个人状态保存使用事务和 revision 条件更新，写入失败还原内存状态并返回错误；遇到不支持的新 schema 或损坏数据时停止读取，不回退到访客记录。

服务器使用请求级异步上下文传递账号 ID，跨请求正文读取等 await 保持身份。不会切换全局 userState 引用。个人服务按当前身份读取状态，响应缓存的版本同时包含账号、个人 revision 和全局封面状态 revision，避免两个新账号版本相同导致串缓存。

删除媒体后，已不存在的作品从收藏和历史结果中被过滤，原个人条目不自动清空。现有访客清理工具只管理原 JSON，不静默扩展到所有账号。全局预热和后台作业不继承发起请求的账号；迁移作业的共享结果不保存个人收藏和进度。

## 接口兼容

继续使用 `/api/favorites`、`/api/favorite-folders`、`/api/history`、`/api/progress/:videoId` 及原作品查询接口，无须提交 userId。身份由 Cookie 或 Bearer 会话确定；请求正文、查询参数不能选择其他人的个人库。失效账号会话继续返回 401，不降级为访客。

受保护 API 响应提供 `X-FanHao-Account-Owner`，值为 guest 或 account 加账号 ID。更新后的客户端可在请求中携带同名头，表示发起操作时预期的身份。若它与后台认证结果不一致，返回 409 和 `code: ACCOUNT_CHANGED`，提示刷新重试。

这个头只是旧页面检测条件，不能授权访问或指定账号。用户资料、密码修改、退出、设备及管理接口同样核对它；公开状态、主动登录、注册、初始化和重置密码不受该条件限制。API 响应仍使用 no-store，跨源客户端的允许头和可读取响应头包含该字段。

## 网页与 Android

切号不仅改变用户中心，还需要废弃旧页面的个人状态、延迟操作和在途响应。网页对旧页面身份进行检测，防止另一个标签页切号后把原操作提交给新账号。

Android 的 JSON 缓存按服务器和身份分开，图片与媒体缓存继续共用。身份变化后重新建立页面；旧请求不能把结果写到新身份的缓存中。离线数据只在已确认的相同身份范围内使用，不把已有账号数据展示给访客或另一个账号。

原生播放器保存播放开始时的会话归属。切号、退出或原会话失效后，旧播放器不能把补交的播放进度写入新账号。该保护针对个人进度写入，不承诺中断已经开始的媒体流或删除设备已保存的媒体。

旧版客户端没有完整的缓存及旧交互保护，应配合新版网页资源和 Android APK 使用。后端按实际认证身份分区，但不能追溯判断未携带预期身份的旧请求最初来自哪个页面。

## 验证与运行边界

临时 SQLite 和动态端口 HTTP fixture 验证账号/访客隔离、同 revision 缓存、跨 await 的并发读写、写入失败回滚、第二连接冲突、重启恢复，以及作品列表/搜索/详情中的个人字段。客户端专项覆盖两端切号、旧响应及缓存重建、原生桥查询超时；JVM fixture 覆盖原生播放进度的会话固定和中途切号。

```powershell
npm run verify:accounts
npm run verify:account-folders
npm run verify:auth
npm run verify:fanhao
```

上述验证使用合成媒体元数据，不连接真实媒体库，不替代真机验收。运行实例需要按既有流程更新服务及 Android APK；代码和测试完成不表示已部署。

继续阅读：[用户账号](user-accounts.md) · [账号访问策略](account-access.md)。
