---
title: 验证矩阵
description: 按变更范围选择真实 package 脚本，明确依赖、临时写入和运行验收的区别。
status: maintained
verified_at: 2026-10-29
sources:
  - public/index.html
  - tests/verify_web_bootstrap_recovery.mjs
  - public/modules/music/music-page.js
  - public/modules/music/actions.js
  - public/modules/music/format.js
  - tests/verify_music_search_deduplication.mjs
  - public/modules/music/views/components.js
  - public/modules/music/styles/player.css
  - tests/verify_music_queue_search.mjs
  - public/modules/photos/manga-page.js
  - public/modules/photos/manga.css
  - tests/verify_manga_directory_search.mjs
  - tests/verify_manga_library_cards.mjs
  - tests/verify_manga_library_covers.mjs
  - tests/verify_manga_fit_position.mjs
  - public/admin.js
  - public/modules/system/settings-controller.js
  - public/modules/system/admin.css
  - tests/verify_web_settings_drafts.mjs
  - tests/verify_module_settings.mjs
  - tests/verify_system_control.mjs
  - android-client/www/modules/novels/mobile-refinements.css
  - tests/serve_android_gallery_navigation_fixture.mjs
  - android-client/www/modules/novels/android-module.js
  - tests/verify_android_novel_categories.mjs
  - tests/verify_android_novel_mobile_layout.mjs
  - tests/verify_android_manga_mobile_layout.mjs
  - tests/verify_android_gallery_mobile_layout.mjs
  - tests/verify_android_gallery_navigation.mjs
  - tests/fixtures/android-gallery-navigation-harness.mjs
  - tests/verify_android_bottom_layout.mjs
  - tests/verify_android_bottom_layout_metrics.mjs
  - package.json
  - tests/run_verification.mjs
  - tests/verify_verification_runner.mjs
  - android-client/package.json
  - tests/verify_fanhao_startup.mjs
  - tests/verify_fanhao_startup.ps1
  - tests/verify_browser_behavior.mjs
  - tests/verify_gallery_search_focus.mjs
  - tests/verify_gallery_search_input.mjs
  - tests/verify_gallery_image_retry.mjs
  - tests/verify_tools_gomoku_lifecycle.mjs
  - public/games/2048/main.js
  - public/games/2048/worker.js
  - tests/verify_tools_2048_lifecycle.mjs
  - tests/verify_web_player_lifecycle.mjs
  - tests/verify_web_player_plyr.mjs
  - tests/verify_subtitles_browser.mjs
  - tests/verify_tools_txt_browser.mjs
  - public/modules/tools/txt-format-tool.js
  - tests/verify_music_playback_recovery.mjs
  - tests/verify_person_profile_lifecycle.mjs
  - tests/verify_manga_image_retry.mjs
  - tests/verify_novel_navigation_recovery.mjs
  - tests/verify_novel_reader_panels.mjs
  - tests/verify_novel_search_input.mjs
  - tests/verify_music_queue_context.mjs
  - public/modules/fanhao/search-shortcut.js
  - public/platform/accounts/account-ui.js
  - public/platform/accounts/account.css
  - tests/verify_account_clients.mjs
  - tests/verify_account_recovery_clients.mjs
  - tests/verify_short_video_watch_write.mjs
  - tests/verify_short_video_keyboard.mjs
  - tests/verify_short_video_playback_settings.mjs
  - tests/verify_short_video_playback_recovery.mjs
  - tests/verify_short_video_first_frame.mjs
  - tests/verify_short_video_switch.mjs
  - tests/verify_short_video_navigation.mjs
  - tests/verify_short_video_media_cache.mjs
  - tests/verify_short_video_seek.mjs
  - tests/verify_short_video_buffered_progress.mjs
  - tests/verify_short_video_hold_speed.mjs
  - tests/verify_short_video_gestures.mjs
  - tests/verify_short_video_wheel.mjs
  - tests/verify_short_video_auto_next.mjs
  - tests/verify_short_video_watch_resume.mjs
  - tests/verify_short_video_watch_queue.mjs
  - tests/verify_short_video_gallery_handoff.mjs
  - tests/verify_short_video_gallery_metadata.mjs
  - tests/verify_short_video_gallery_loading.mjs
  - tests/verify_short_video_author_handoff.mjs
  - tests/verify_short_video_playback_attempts.mjs
  - tests/verify_short_video_sound_preview.mjs
  - tests/verify_short_video_sound_focus.mjs
  - tests/verify_short_video_modal_playback.mjs
  - tests/verify_short_video_panel_loading.mjs
  - tests/verify_short_video_share_lifecycle.mjs
  - tests/verify_short_video_author_opening.mjs
  - tests/verify_short_video_fullscreen.mjs
  - tests/verify_short_video_picture_in_picture.mjs
  - tests/verify_short_video_picture_controls.mjs
  - tests/verify_short_video_seek_rendering.mjs
  - tests/verify_short_video_gallery_frames.mjs
  - tests/verify_short_video_progress_loop.mjs
  - tests/verify_short_video_caption.mjs
  - tests/verify_short_video_reel_metadata.mjs
  - tests/verify_short_video_interaction_state.mjs
  - tests/verify_short_video_tap_intent.mjs
  - tests/verify_short_video_page_lifecycle.mjs
  - tests/verify_short_video_adjacent_visibility.mjs
  - tests/verify_short_video_gallery_sound.mjs
  - tests/verify_short_video_author_disposal.mjs
  - tests/verify_short_video_author_lifecycle_async.mjs
  - tests/verify_short_video_comments_lifecycle.mjs
  - tests/verify_short_video_comments_loading.mjs
  - tests/verify_short_video_prewarm_budget.mjs
  - tests/verify_short_video_startup_preload.mjs
  - tests/verify_short_video_collection_restore.mjs
  - tests/verify_short_video_collection_lifecycle.mjs
  - tests/verify_short_video_list_lifecycle.mjs
  - tests/verify_short_video_delete_playback.mjs
  - tests/verify_short_video_media_representation.mjs
  - tests/verify_short_video_startup_cache.mjs
  - tests/verify_short_video_transcode_source.mjs
  - tests/verify_short_video_transcode_page.mjs
  - tests/verify_short_video_transcode_lifecycle.mjs
  - tests/verify_short_video_read_request.mjs
  - tests/verify_short_video_detail_requests.mjs
  - tests/verify_short_video_detail_loading.mjs
  - tests/verify_short_video_retry_intent.mjs
  - tests/verify_short_video_store.mjs
  - tests/verify_short_video_incremental_sync.mjs
  - src/modules/short-videos/download-manager/tests/test_manager_library_sync.py
  - tests/verify_short_video_delete_jobs.mjs
  - tests/verify_work_move_jobs.mjs
  - tests/verify_file_workflows.mjs
  - tests/verify_file_workflows_ui.mjs
  - tests/verify_taste.mjs
  - tests/verify_taste_browser.mjs
  - tests/verify_duplicate_model.mjs
  - tests/verify_duplicates.mjs
  - tests/verify_duplicate_identity.mjs
  - tests/verify_duplicates_browser.mjs
  - tests/verify_json_responses.mjs
  - src/platform/server/responses.js
  - tests/verify_person_organization.mjs
  - tests/verify_person_organization_metadata.py
  - tests/verify_person_organization_ui.mjs
  - tests/verify_native_short_video_actions.mjs
  - tests/verify_native_short_video_paging.mjs
  - tests/verify_native_short_video_playback.mjs
  - tests/verify_native_short_video_recovery.mjs
  - tests/verify_native_short_video_manual_retry.mjs
  - tests/verify_native_short_video_player_callbacks.mjs
  - tests/verify_native_short_video_gallery_continuation.mjs
  - tests/verify_native_short_video_playback_requests.mjs
  - tests/verify_native_short_video_gallery_readiness.mjs
  - tests/verify_native_short_video_gallery_recovery.mjs
  - tests/verify_native_short_video_gallery_image_recovery.mjs
  - tests/verify_native_short_video_gallery_sound.mjs
  - tests/verify_native_short_video_interruption_advance.mjs
  - tests/verify_native_short_video_gallery_rebind.mjs
  - tests/verify_native_short_video_gallery_segment_rebind.mjs
  - tests/verify_native_short_video_seek_rendering.mjs
  - tests/verify_native_short_video_checkpoint.mjs
  - tests/verify_native_short_video_session.mjs
  - tests/verify_short_video_restored_actions.mjs
  - tests/verify_native_short_video_screen_awake.mjs
  - tests/verify_native_short_video_gestures.mjs
  - tests/verify_native_short_video_overlay_playback.mjs
  - tests/verify_native_short_video_first_frame.mjs
  - tests/verify_native_short_video_cover_ownership.mjs
  - tests/verify_native_short_video_frame_loading.mjs
  - tests/verify_native_short_video_bitmap_decode.mjs
  - tests/verify_native_short_video_author_requests.mjs
  - tests/verify_android_short_video_list_lifecycle.mjs
  - tests/verify_android_short_video_back.mjs
  - tests/verify_android_short_video_suggestions.mjs
  - tests/verify_android_mobile_action_sheet.mjs
  - tests/verify_android_settings_focus.mjs
  - android-client/www/js/settings-dialog-focus.js
  - tests/verify_android_music_back.mjs
  - tests/verify_android_fanhao_player_requests.mjs
  - tests/verify_android_fanhao_player_lifecycle.mjs
  - tests/verify_native_short_video_audio.mjs
  - tests/verify_native_short_video_audio_focus.mjs
  - tests/verify_native_short_video_prefetch.mjs
  - tests/verify_native_short_video_cache_startup.mjs
  - tests/verify_native_short_video_interaction.mjs
  - tests/verify_native_short_video_request_lifecycle.mjs
  - tools/build_short_video_web.mjs
  - tests/verify_fanhao_requests.mjs
  - tests/verify_work_sorting.mjs
  - tests/verify_work_facets.mjs
  - tests/verify_work_cache_budget.mjs
  - tests/verify_code_prefix_cache_budget.mjs
  - tests/diagnose_work_cache_heap.mjs
  - tests/verify_file_stream_lifecycle.mjs
  - tests/verify_file_server_conditional.mjs
  - tests/verify_file_server_async.mjs
  - tests/verify_static_file_lifecycle.mjs
  - tests/verify_module_lifecycle.mjs
  - tests/verify_server_shutdown_lifecycle.mjs
  - tests/verify_short_video_quality_queries.mjs
  - tests/verify_short_video_image_sources.mjs
  - tests/verify_short_video_image_lifecycle.mjs
  - tests/verify_short_video_product_lifecycle.mjs
  - tests/verify_actor_avatar_import.mjs
  - tests/verify_gallery_list_rendering.mjs
  - tests/verify_android_channel_rendering.mjs
  - tests/verify_android_image_cache.mjs
  - tests/verify_android_cache_stats.mjs
  - tests/fixtures/image-library-channel-server.mjs
  - tests/verify_music_cover_async.mjs
  - tests/verify_work_cover_async.mjs
  - tests/verify_gallery_cover_async.mjs
  - tests/verify_image_query_correctness.mjs
  - tests/diagnose_image_query_cpu.mjs
  - tests/verify_video_probe_cache.mjs
  - tests/verify_video_probe_lifecycle.mjs
  - tests/verify_media_blob_worker.mjs
  - tests/verify_remote_image_lifecycle.mjs
  - tests/verify_media_stream_lifecycle.mjs
  - tests/verify_web_gallery_requests.mjs
  - tests/verify_gallery_summary_recovery.mjs
  - tests/verify_photo_pager_keyboard.mjs
  - tests/verify_manga_reader_requests.mjs
  - tests/verify_manga_image_layout.mjs
  - tests/verify_manga_lookup_performance.mjs
  - tests/verify_music_facet_cache.mjs
  - tests/verify_music_lyric_search.mjs
  - tests/verify_music_m3u.mjs
  - tests/verify_music_playlist_order.mjs
  - tests/verify_music_summary_reuse.mjs
  - tests/verify_music_active_catalogue.mjs
  - tests/verify_studio_cache_dependencies.mjs
  - tests/verify_android_music_list_rendering.mjs
  - tests/verify_android_music_catalogue_requests.mjs
  - tests/verify_android_music_playback_requests.mjs
  - tests/verify_android_music_transition_requests.mjs
  - tests/verify_android_music_history_requests.mjs
  - tests/verify_android_music_playlist_requests.mjs
  - tests/verify_android_media_viewer.mjs
  - tests/verify_android_photo_viewer_requests.mjs
  - tests/verify_android_info_preview.mjs
  - tests/verify_android_fanhao_search_suggestions.mjs
  - tests/verify_android_manga_task_requests.mjs
  - tests/verify_vision_lifecycle.mjs
  - tests/verify_music_playback_lifecycle.mjs
  - tests/verify_music_request_ownership.mjs
  - tests/verify_music_reader_requests.mjs
  - tests/verify_music_progress_writer.mjs
  - tests/verify_music_progress_clients.mjs
  - tests/verify_music_progress_order.mjs
  - tests/verify_music_progress_requests.mjs
  - tests/verify_novel_reader_requests.mjs
  - tests/verify_novel_catalog.mjs
  - tests/verify_novel_progress_writer.mjs
  - tests/verify_novel_progress_order.mjs
  - tests/verify_novel_progress_requests.mjs
  - tests/verify_web_novel_chapter_identity.mjs
  - tests/diagnose_web_gallery_navigation.mjs
  - tests/verify_archive_reader_lifecycle.mjs
  - tests/verify_rescan_image_library.mjs
  - tests/verify_image_library_performance.mjs
  - tests/verify_media_metadata_identity.mjs
  - tests/fixtures/archive_image_helper_fixture.mjs
  - tests/verify_novel_summary_cache.mjs
  - tests/verify_novel_empty_pages.mjs
  - tests/verify_novel_write_worker.mjs
  - tests/verify_novel_credentials_async.mjs
  - tests/verify_novel_collection_worker.mjs
  - tests/verify_novel_reimport_async.mjs
  - tests/verify_douyin_manager_latest_requests.mjs
  - src/modules/short-videos/download-manager/tests/test_manager_link_cursor.py
  - src/modules/short-videos/download-manager/tests/test_manager_profile_snapshot.py
  - .github/workflows/application-checks.yml
---

# 验证矩阵

这里列出的应用命令来自根目录 `package.json`，不是新增的命令接口。日常门禁、按改动选择和完整门禁是三个显式入口。本页说明检查的用途与副作用，不表示它们在当前机器或当前提交上都已通过。

## 安装与查看实际脚本

```powershell
npm ci
npm run
```

安装会访问包源并写入 `node_modules/`；锁文件与 Node 版本应与仓库要求一致。测试常会创建并清理临时 SQLite、媒体 fixture、Worker 或本机监听端口；“验证”不等于所有步骤只读。首次运行陌生脚本前检查其入口、环境变量与清理范围，尤其不要把 fixture 的路径替换为真实媒体目录。

## 文档门禁

```powershell
npm --prefix docs ci
npm --prefix docs run check
npm --prefix docs run build
```

文档依赖独立安装。检查页面约束与站点构建不需要启动 `server.js`、下载器、Android 或任何采集作业。写作约束见[文档规范](../contributing/documentation.md)。

## 按改动选择应用检查

日常开发先运行轻量门禁：

```powershell
npm run verify
```

它检查仓库卫生、鉴权、写接口权限、JSON 响应协商、模块结构、相对导入、验证 runner/cache-version 自测，以及番号请求生命周期与公共排序，不代表全模块回归已经执行。
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

主资料库网页核心检查使用 `npm run verify:web-core`，可加 `-- --plan` 先查看 18 个入口、21 条去重命令；覆盖共同启动恢复、列表、播放器、图库、漫画、小说、音乐、工具和人物资料的私有 fixture。需要 Chrome/Edge 与 TXT 检查所需的 Python，过程中不启动正式服务或运行 Android 界面/构建门禁；完整应用检查继续使用 `verify:full`。
网页搜索、阅读、播放器和工具的交互专项见[网页交互验证](web-verification.md)，包含各浏览器 fixture 的适用范围与用例边界。

| 命令 | 检查内容 | 执行边界 |
| --- | --- | --- |
| `npm run verify:repo-hygiene`、`npm run verify:modules`、`npm run verify:imports` | Git 跟踪文件中的禁止产物、运行状态与文本异常，模块结构与职责约束，以及相对导入引用。 | 读取 Git 清单和源码，不启动应用；不是秘密扫描器，也不能替代真实调用验证。 |
| `npm run verify:auth` | 来源识别、登录与会话等鉴权规则。 | 使用临时鉴权状态文件，并清理临时目录。 |
| `npm run verify:mutation-auth`、`npm run verify:json-responses` | 写接口权限与 API 错误边界；JSON 编码权重、明文拒绝、Vary 合并、压缩失败回退和断开后回调。 | 前者调用 mutation 与 error-boundary 检查；后者使用动态 loopback HTTP、实际压缩/解压及门控压缩故障，不启动正式服务。 |
| `npm run verify:settings` | 模块和应用设置契约。 | 会生成并清理临时模块 fixture。 |
| `npm run verify:tools-2048-browser` | 2048 单步与自动走子的回执归属，停止、手动换盘、撤销和离页后的迟到保护。 | 需要 Chrome/Edge；实际游戏页面与私有合成盘面，不修改真实存档；详见[网页交互验证](web-verification.md)。 |
| `npm run verify:web-bootstrap-browser` | 共同入口及依赖失败、完整 URL 原生重载、迟到归属、样式降级和短视频提前导入。 | 需要 Chrome/Edge；实际共同 HTML、私有服务器与合成错误，不启动正式服务；详见[网页交互验证](web-verification.md)。 |
| `npm run verify:gallery-summary-recovery-browser` | 首次图库概览错误、只读重试、重复激活、输入与阅读器归属，以及恢复后首列表重试。 | 需要 Chrome/Edge；私有宿主及合成 API/图片，重试仅 GET；详见[网页交互验证](web-verification.md)。 |
| `npm run verify:manga-fit-position-browser` | 漫画阅读中段切换显示宽度的页码/比例、未解码占位和迟到位置校正归属。 | 需要 Chrome/Edge；实际漫画宿主与合成章节/SVG，不使用真实漫画；详见[网页交互验证](web-verification.md)。 |
| `npm run verify:manga-library-covers-browser` | 漫画书架封面按需请求、滚动与键盘曝光解码、换 URL 与详情/章节加载边界。 | 需要 Chrome/Edge；私有宿主和合成书架/SVG，使用实际网络请求与浏览器解码，详见[网页交互验证](web-verification.md)。 |
| `npm run verify:manga-library-cards-browser` | 漫画书架后台刷新保留卡片、封面与键盘焦点，核对元数据、增删排序和旧卡片归属。 | 需要 Chrome/Edge；只用私有宿主及合成书架、作业 API 和图片，详见[网页交互验证](web-verification.md)。 |
| `npm run verify:music-search-dedup-browser` | 音乐搜索分页的增量去重、完整组输出、确认收藏/评分后的追加和会话归属。 | 独立全量函数与合成分页作参考，实际私有浏览器与受控 Audio；不读取真实歌库，详见[网页交互验证](web-verification.md)。 |
| `npm run verify:music-queue-search-browser` | 完整已加载播放队列的本地查找、分批追加、键盘定位、操作身份与输入保留。 | 需要 Chrome/Edge；仅用实际音乐模块、私有宿主及合成队列/API/受控 Audio，不读取正式歌库，详见[网页交互验证](web-verification.md)。 |
| `npm run verify:manga-directory-search-browser` | 漫画目录本地查找、键盘定位、后台回包与输入保留。 | 需要 Chrome/Edge；只使用私有宿主、合成章节/API/图片，详见[网页交互验证](web-verification.md)。 |
| `npm run verify:web-settings-browser` | 网页设置草稿、并行分组回执、读取归属与原生键盘/焦点保留。 | 需要 Chrome/Edge；仅使用私有静态服务器与合成 API，不操作真实设置、凭据或数据库；详见[网页交互验证](web-verification.md)。 |
| `npm run verify:short-video-build` | bundle 字节与 HTML 版本引用是否一致。 | esbuild 内存构建并比较；`--check` 不写产物。 |
| `npm run verify:short-video-playback` | 按钮聚焦后的快捷键与原生激活、独立倍速面板和焦点恢复、首帧等待与恢复、慢预热/导航详情延迟时的连续切换、缓存请求与播放重试的归属、进度拖动与缓冲分段、长按倍速的释放恢复、滑动指针与作品归属、滚轮输入和回弹、未知下一条时的连播等待与取消、续播的来源与操作归属、观看进度的串行保存和回执、作者面板切换的导航与暂停保持，原声试听与主播放的互斥、迟到播放回调和弹层暂停的独立归属、面板模块加载的取消与最后操作优先、分享异步回调的归属、作者面板关闭后的延迟回调、全屏和画中画的原生请求归属与控件同步、拖动与预览按帧合并及布局读取计数、进度刷新链的归属、图集横滑和实况进度回调、长文案展开与详情原位同步、点赞收藏关注的串行写入与迟到详情合并、双击点赞与后续播放意图、页面离开及返回时的请求归属、隐藏页面后的相邻预热取消、图集音乐的迟到播放回调、作者面板关闭与直接离开时的资源清理、作者与评论异步视图的归属、评论并发写入和焦点保持、弱网及省流量下的预热预算、当前首帧优先和完整源地址复用、清单与列表迟到响应、删除后的播放与缓存归属、返回位置的延迟恢复、转码页的加载和轮询归属与操作回执顺序、详情读取的取消与 12 秒超时和最多 4 个在途/6 个排队请求、重试保留最新定位，以及图集加载时的暂停传递、预热、切换复用和迟到音轨的原位补齐。 | 当前处理器/模块、受控 DOM、媒体事件、Promise 与计时器；不访问真实媒体、数据库或正式服务，不代表真机流畅度验收。 |
| `npm run verify:short-video-client` | Web/原生短视频结构、分页、请求与动作契约；原生视频和图集的来源/视图归属、暂停与连播意图、错误恢复及同页提示、首帧与封面、音频焦点和中断、按帧定位与手势、请求取消、有限解码/字节预取和异步缓存启动；另覆盖新实例恢复、私有检查点与任务会话的域/容量/过期校验、系统保存标记和正常退出边界、跨 JVM 的新进程恢复及恢复结果回传，以及当前播放舞台的保屏归属和有限缓冲等待；具体子检查以 package 脚本为准。 | 包含源码检查及 `javac` 编译、`java` 执行的 fixture；会写入并清理临时类文件、合成检查点，并使用临时本机 HTTP 服务，另需下述 JDK/Android 依赖。预取和媒体解码保留物理读取槽直至读取实际结束；JVM 的 Bundle 替身与字节预算不证明 Android Parcel 的实际大小，跨 JVM 新进程、受控新实例与保屏状态不代表 Android 系统杀进程、真实熄屏或耗电验收。 |
| `npm run verify:short-video-watch-write` | SQLite 竞争、提交回执、超时与停止恢复。 | 临时 SQLite、真实 Worker 与故障 fixture。 |
| `npm run verify:short-video-delete-jobs` | 删除恢复与幂等协议。 | 临时文件/数据库、进程和 Worker；会在 fixture 内移动或删除文件。 |
| `npm run verify:short-video-runtime` | 运行队列与生命周期、流畅版固定文件版本、未就绪响应、低分辨率兼容转码、转码源版本与文件替换校验、断连与停机取消等待，以及启动片段缓存的取消、文件实际关闭、源版本校验与发布归属；启动缓存最多 6 个等待任务，已就绪的当前视频优先于列表预热。 | 创建临时媒体、缓存与数据库，使用受控文件句柄和流验证竞态，结束后清理；不启动正式服务。 |
| `npm run verify:short-video-store` | 导入、列表与状态契约；回退总数省去无关视图关联的完整旧响应与查找门槛、旧列空值及比较规则；相邻播放、预取与列表在并列值、空值、正反方向和过滤条件下保持相同顺序。 | 临时合成媒体和 SQLite；计数与相邻顺序专项使用内存数据库，不读取真实资料；同步 fixture 使用下载器 Python 安装增量日志。 |
| `npm run verify:short-video-sync` | 增量日志、分页初始化、无变化与单条更新的查询和逻辑 I/O 预算、删除与改名、回滚、并发提交、重启游标和来源代际变化。 | 临时 SQLite 和合成媒体；Python 运行实际迁移。Windows 用进程读取计数比较逻辑 I/O，不代表物理磁盘吞吐；不启动正式服务。下载器初始化另用 `tests.test_manager_library_sync` 和 `tests.test_manager_database_lifecycle` 验证。 |
| `npm run verify:work-move-jobs`、`npm run verify:person-organization` | 作品移动作业与 UI；人物整理另查预览、分段、冲突、路径同步、目录发布日期、重试、使用已有资料与封面地址、无备份替换、旧封面与遗留文件清理、权限和焦点。 | 临时合成文件及 SQLite、Worker/任务子进程、可控图片下载和动态 HTTP/无头浏览器；不整理真实媒体，不访问外部封面站点。 |
| `npm run verify:file-workflows`、`npm run verify:file-workflows-ui` | 后端预览、校验后移动、路径与已入库保护、冲突、源文件变化、权限、恢复、暂停/继续及互斥；浏览器预览、取消/确认执行、持久历史与窄屏布局，另查切换计划、轮询/重试、停止响应、页面离开及连续写入的归属。 | 当前服务、路由与 CLI，临时合成文件及 SQLite；UI 另用动态 loopback HTTP 与无头 Chrome/Edge，实际复制、移动临时文件，竞态使用门控 API/计时器，并在 `.codex-artifacts/` 保存截图，不操作真实媒体。 |
| `npm run verify:taste` | 按番号去重、目录标记、收藏人物归属、资料覆盖分母、小样本平滑、匹配理由、只读查询、Worker 缓存与停止、权限；页面切换、样本链接、导出、窄屏布局和失败重试。 | 临时 SQLite、独立 Worker、动态 loopback HTTP 与无头 Chrome/Edge；合成馆藏样本，不读取真实媒体或浏览器历史。 |
| `npm run verify:duplicates` | 番号与分卷候选、只读列表及候选路径可用性、完整 SHA256、网络文件身份碰撞、别名变化、子集比较、取消与停机、权限、搜索分页、播放与文件夹入口、保留和忽略、手动删除后的文件复核、失效索引事务清理与重启、收藏和观看记录保留、离线及链接保护、移动预留冲突与回滚、清理失败重试和窄屏布局。 | 临时 SQLite、合成文件、虚拟网络文件系统、独立 Worker、动态 loopback HTTP 与无头 Chrome/Edge；仅清理临时索引，不读取真实媒体，不执行媒体删除或打开真实文件夹。 |
| `npm run verify:music-rescan-worker` | 音乐扫描 Worker、锁竞争与停止流程。 | 临时音乐文件、数据库、假探测器与子进程。 |
| `npm run verify:browser-behavior` | 浏览器中的页面行为、导航与异步状态。 | 默认本机临时 HTTP fixture，并启动无头 Chrome/Edge。 |
| `npm run verify:accounts` | 账号权限、设备会话、邀请码、密码重置及跨账号资料隔离；客户端另查登录、注册、改密时逐字段显示/隐藏密码，鼠标和键盘不误提交、校验与提交值保留、新表单默认隐藏，以及管理重置和窄屏布局。 | 临时账号服务、SQLite、合成账号和私有 Chromium；Web 与 Android 共用的账号组件保持一致，含 320px 密码控件实际操作，不访问真实账号或证明 Android 真机交互。 |
| `npm run verify:startup` | 启动器健康、超时、占用与失败边界。 | 临时启动器/假服务与动态端口，要求 PowerShell 运行时。 |
| `npm run verify:fanhao-requests` | 人物与番号导航竞态、翻页取消、片商完整筛选、预取在途上限与释放；输入法合成期间暂停预取并保留候选确认/取消键。 | 调用当前请求模块及壳函数，HTTP/DOM 使用可控 doubles，含合成输入与计时器负控，不访问正式服务。 |
| `npm run verify:work-sorting`、`npm run verify:works-performance` | 公共排序的缺失值、并列规则、输入不变性和延后标题比较；冷路径另核对人物详情分页的完整旧响应、分类/排序复用、来源/账号/配置失效、单项筛选容量与原引用预算，以及观看历史和 HTTP 行为。 | 合成内存数据、实际详情/查询/呈现服务、私有 SQLite 与动态 HTTP；旧人物来源负控应超过分类预算，计时不代表真实 API 延迟。 |
| `npm run verify:work-facets` | 评分计数一致性、等价筛选复用、列表与搜索筛选/排序缓存容量。 | 合成内存数据，覆盖空值与数值零，以及多组筛选、排序后的淘汰和复用。 |
| `npm run verify:work-cache-budget` | 全局权重和条目淘汰、大页不缓存、普通分页复用、账号失效与弱引用释放；人物筛选及 GC；番号前缀记录、桶数与键长上限；收藏/历史整页作品引用预算、完整旧响应及路由、异常和重试、普通/空页 LRU、版本释放与旧机制负控。 | 合成内存目录、内存 SQLite 和真实 GC；不访问实际资料库，超限结果完整返回。 |
| `npm run verify:code-prefixes` | 前缀分页、状态失效和账号隔离；片商可见性与筛选在分页之前生效；前缀来源/结果共享预算、强引用、LRU、大结果回退和释放。 | 合成目录数据、真实 GC 与有效筛选组合，验证容量、淘汰、重建和跨页复用；堆内存和计时仅为诊断。 |
| `npm run verify:studio-cache` | 片商与前缀依赖表更新、同时间戳提交、旧表、显式失效和主线程/Worker 交接。 | 实际 API 路由、私有 SQLite 与持久 Worker；不访问正式资料库，外部提交由既有数据戳刷新发现。 |
| `npm run verify:file-streams` | 异步打开及属性读取、同句柄和读取长度、完整传输等待、GET/HEAD、条件缓存与前置条件、范围和下载头、断连、短读、实际关闭及停机/重启。 | 临时合成文件、动态 loopback HTTP/Host、受控文件句柄和慢速读流；不读取真实媒体。 |
| `npm run verify:static-files` | 静态资源同句柄、HEAD/空文件、错误/断连、压缩与缓存；打开/查询/传输取消、实际关闭、准入停止和重启，以及公共请求错误和账号上下文。 | 受控文件句柄与读流、实际 Node 文件句柄和动态 HTTP/Host；只读验证器自身，不操作真实媒体、数据或服务。 |
| `npm run verify:shutdown` | 模块逆序逐个停止及失败后继续清理、原始错误汇总、主服务资源停止和账号关闭、独立短视频启动失败清理，以及静态文件未关闭时拒绝正常退出。 | 当前注册器、实际装配回调与受控依赖、动态 HTTP/Host；不启动正式服务或访问数据库。 |
| `npm run verify:short-video-quality` | 正数画质区间的计数与分页索引范围查找，空值和边界兼容，以及画质与媒体类型在列表、历史和导航中的组合。 | 当前 store/schema 与内存 SQLite、合成记录及查询计划；计时仅作诊断。也纳入 `verify:short-video-stats-performance`。 |
| `npm run verify:short-video-images` | 默认产品的同句柄图片流与实际关闭、图片准入容量、文件下载及产品资源停止/重启；直接运行时接线的缓存复用、来源与数据库变化；断连及 BLOB 和视频兼容。 | 当前 product/store/runtime/共享图片服务、内存 SQLite、受控流及文件句柄；默认文件打开器只读验证器自身，不读取真实媒体或启动正式服务。 |
| `npm run verify:actor-avatar-import` | 单次头像应用的文件检查范围、完整预览统计、已有头像跳过、读取上限、换源、取消、人物归属与逐人物事务。 | 实际服务及管理路由、内存 SQLite 和受控文件句柄；不操作真实头像目录、配置或数据库。 |
| `npm run verify:music-cover-async` | 音乐封面异步文件查询/读图、来源与数据库变化、缓存锁回退、准入容量、迟到写入和停止/重启。 | 受控文件查询与读取、私有 SQLite 与响应 doubles；不读取真实图片或数据库。 |
| `npm run verify:work-cover-async` | 作品封面探测/抽帧的异步响应、并发和容量、取消/停机、来源变化、人工封面冲突与提交异常。 | 受控子进程、私有内存 SQLite 与动态 HTTP fixture；不运行 FFmpeg 或读取真实视频。 |
| `npm run verify:gallery-cover-async` | 图库视频封面的异步探测/抽帧、合并请求、并发、断连、停止和来源/缓存/数据库变化。 | 受控子进程、私有内存 SQLite 和动态 HTTP；不运行 FFmpeg 或读取真实视频。 |
| `npm run verify:image-query`、`npm run verify:image-query-cache` | 相册字段延后、影视批量投影与解析复用、媒体 ID 索引；电视剧公开批量读取省去 JSON-LD，默认原始记录、详情和封面保持；旧库、DDL、连接及异常。分页版本与原额度、失效、隔离和停机规则；`verify:image-library` 另查年份排序、季集规范化及重复来源才创建两张暂存表、分组/异常顺序、同分封面及索引装配。 | 完整旧响应、实际服务及私有 SQLite、字节与固定探测门槛；恢复旧 JSON-LD 或封面 BLOB 批量读取应超出对应复制预算，旧年份/剧名算法应超出解析预算，提前创建两张规范化表应违反唯一来源零分配预算；计时仅作诊断，不读取真实资料。 |
| `npm run verify:video-probe-cache` | 视频来源更新、缓存容量、缓存锁回退、统一调度、前台优先、慢文件查询预算、实际进程关闭和停止/重启竞态。 | 合成来源、受控进程和私有 SQLite；响应和停机验证使用实际 Node 子进程与动态 HTTP，不运行 FFprobe 或读取真实媒体。 |
| `npm run verify:media-images` | 共享图片 Worker 的任务/参数容量、串行派发、冷读取合并、逐请求头像撤销、实际退出及启停竞态；远程图片的流式大小限制、统一预热准入、完成缓存权重与条目上限、长 URL 边界。 | 受控 Worker/网络、私有 SQLite 与实际图片 Worker、动态 loopback 分块响应；不读取真实图片或连接外部图片源。 |
| `npm run verify:media-streams` | 转码任务容量、首字节和排队超时、背压、输出后失败、断连、管道错误及实际进程关闭。 | 受控管道、私有 Node 子进程及动态 HTTP/Host 停机 fixture；不运行 FFmpeg 或读取真实视频。 |
| `npm run verify:photo-reader-browser` | 相册/章节/媒体的乱序请求、返回与取消、分页去重、既有 DOM 与 observer 保留、迟到全目录时保留阅读位置，以及深链接恢复期间的历史导航、启动与模块切换；单页图片弹层的焦点限制、缩略图焦点、控件显隐与关闭恢复。 | 真实入口与当前宿主/阅读器源码，完整 101 场景通过；动态 HTTP 和无头 Chrome/Edge，数据及图片均为合成，不访问正式图库。 |
| `npm run verify:gallery-rendering`、`npm run verify:android-channel-rendering` | 两端普通卡片、Web 电视剧和西方人物书架追加、原始 offset、版本补齐、封面缓存无关写入、限量分段、重复尾页、账号聚合冷启动缓存/失败/取消、搜索焦点与封面保留；Web 延后布局、Android 瀑布流和分组/变宽回退。详见[图库列表](../architecture/gallery-lists.md)。 | 当前客户端与完整 CSS、私有 Chromium、实际查询服务及私有 SQLite、合成 API/图片；含关闭复用的行为负例。Android 同步生成缓存引用；不证明真实资料库或真机性能。 |
| `npm run verify:android-cache` | 服务统计与旧完整结果对照、索引巡检/历史回退、预算及淘汰集合、升级与事务回滚、跨页面并发；图片清空后的迟到写入、跨服务与账号、访问更新、取消。 | 当前缓存与图片模块、合成 IndexedDB 及私有 Chromium 的实际 IndexedDB/DOM；动态 loopback 与合成图片，不读取真实缓存。同步生成缓存引用，已纳入全 Android 门禁。 |
| `npm run verify:manga-reader-browser` | 独立漫画馆的深链接、历史导航、作品/章节乱序、进度归属、后台目录/作业刷新，以及删除结果与新导航交错。 | 独立宿主与漫画阅读页，最近完整复核 120 场景（封面加载调整后）；私有 Chromium、合成 API 和图片，更新与删除仅由 fixture 模拟，不操作正式资料。 |
| `npm run verify:manga-lookup` | 热态图片/章节请求的固定查询次数、详情封面语句复用的编译次数与完整旧响应；连续请求、同源去重、旧 ID、JSON 回退、WAL/schema 更新、失败重试及语句预热后的数据库文件替换。 | 实际采集器 schema、临时 SQLite 与合成目录、受控图片响应；计时限于进入图片服务前的查找，不证明实际图片解码或网络耗时。 |
| `npm run verify:music-facet-cache` | 等价字母复用、歌手排序键与缓存字段、分页读取门槛；专辑计数关联、普通分页及筛选投影、默认与最大页、完整旧响应与查询计划、旧列迁移及缺列回退、详情简介；原容量、权重淘汰、LRU、键碰撞、超大回退及弱引用释放。 | 私有 SQLite、合成音乐元数据及 GC 子进程；恢复旧歌手宽记录应超出分页预算，恢复旧专辑分页或筛选完整字段均应超出简介字节预算；不读取音频文件，缓存预算为估算 JSON 大小。 |
| `npm run verify:music-lyric-search` | 联想关联去重、专辑字段投影与旧库回退、完整响应及 SQL 参数/查询计划、错误及下一请求更新；原短词/FTS 有效总数与分页、歌词上下文和高亮。 | 当前 store、私有 SQLite 与合成歌词；旧联想宽字段应超过简介字节预算，原点查负控继续触发读取次数断言；纳入 `verify:music-scale`，详见[音乐搜索](../architecture/music-search.md)。 |
| `npm run verify:music-m3u`、`npm run verify:music-playlist-order` | M3U 网络主机与本地路径身份、编码路径、同名歧义及解析顺序；歌单排序的完整旧响应、旧类型规范化、未变位置零写入、元数据时间戳与事务回滚。 | 当前匹配器/store、合成路径与内存 SQLite，不打开音频或启动扫描；排序以歌曲行 UPDATE 次数验证，旧全量写入负控应超预算；两项均纳入 `verify:music-scale`。 |
| `npm run verify:music-summary-cache` | 会话及未应用进度的汇总复用、写入与回滚、有效期及扫描失效；播放最多的完整旧响应、并列与关联查找次数；有效目录的未听与待评分、智能歌单索引的合并计数、稀疏及密集状态、旧列类型、静态回退及时间边界。 | 当前 store、实际扫描发布和私有 SQLite、完整旧响应及 SQL/关联计数；旧索引计数负控应超过查询预算；只使用合成元数据，不扫描音频或操作实际历史记录。 |
| `npm run verify:android-fanhao-player` | 普通作品视频快速点选、离页、服务器与账号切换；原生失败后的网页回退、兼容播放定时器、旧媒体回调、进度节流、拒绝未就绪零进度和退出前最终进度；同路由缓存刷新保留仍可用的已选作品，作品移除时取消播放。 | 完整播放工厂、真实请求与账号归属模块，以及受控 DOM、网络响应和媒体对象；不访问真实视频，不代表真机解码与播放验收。 |
| `npm run verify:android-mobile-sheets` | 通用操作弹层的返回键优先级、路由/页面/当前账号退出、焦点恢复、旧控件失效，以及保留已接受的异步操作；设置面板的双向 Tab 循环、背景隔离、关闭回焦、迟到回调失效、确认框退栈与同页历史返回。 | 实际共享组件、设置焦点控制器、模块/工具栏和 shell 返回分发，DOM、导航与完成顺序为受控边界；不访问真实资料或执行真实资料变更，不代表 Android 真机辅助功能验收。 |
| `npm run verify:android-music-back` | 音乐弹层、全屏、搜索到根目录的分层返回，保留播放与目录上下文；迷你播放器打开与队列入口、焦点往返、手势取消及旧控件失效；播放设置真实入口、关闭与焦点恢复，评分已发写入和关闭交错；歌曲及播放设置控件关闭、重开、切歌或停用后的归属。 | 完整音乐页面、实际模块/注册表/返回分发及受控 Audio、API 和时钟；不代表真机系统返回与真实音频验收。 |
| `npm run verify:android-bottom-layout` | 底部导航实际高度同步、隐藏启动和恢复、旧回调释放及无观察器回退；导航、迷你播放器、内容末项和分类菜单的间距、命中与原生Tab焦点避让；三个分类菜单的键盘打开、方向键、Escape、页面NativeBack入口、焦点往返及长按点击抑制。 | 真实共享高度模块与受控观察器/时钟；完整 Android 入口、真实导航和 CSS、私有 Chromium 与合成只读目录。字体放大是渲染压力，安全区由浏览器环境覆盖，返回调用实际页面dispatcher；不代表 Android 真机验收。已纳入 Android 总入口，图库导航VM另查真实事件接线及返回优先级。 |
| `npm run verify:android-gallery-layout` | 影视详情长片名、剧名与文件信息的完整阅读和换行，图库合集返回入口的点按区域及真实返回行为。 | 完整 Android 入口、真实模块与样式、私有 Chromium 和隔离的合成只读目录；覆盖窄屏与短横屏。已纳入 Android 总入口及媒体、图片域；不连接真实媒体、数据库或原生播放，不代表 Android 真机验收。 |
| `npm run verify:android-manga-layout` | 漫画详情简介、长标题、章节切换与恢复；添加区与下载记录的焦点、触点和文字换行；提交中的只读链接、失败提示关联、编辑清错及重新采集。 | 完整 Android 入口、真实模块与样式、私有 Chromium，分两次独立进程运行常规布局和恢复流程，保持每个夹具12运行上限。恢复场景只对白名单合成链接返回内存503或完成回执，不启动采集；其他场景继续拒绝写入。不连接真实业务服务、媒体或数据库，不代表 Android 真机验收。 |
| `npm run verify:android-novel-layout` | 小说搜索长查询换行与操作触点；清除、重搜、分类及排序；旋转后选中分类可见，同宽回调保留手动横滚；详情作者与分类全文、简介展开、目录搜索与分段，以及长目录错误提示。 | 完整 Android 入口、实际模块与样式、私有 Chromium；使用既有8本书库目录及独立4本详情场景，覆盖窄屏、短横屏和有无ResizeObserver的分支，单个夹具仍限12次运行。仅提供列表、汇总、显式元信息和目录GET，章节content始终为空。分类工厂专项另验退出清理；按可见选项验证篇幅排序。不提供正文、进度写入、下载、导入、上传或真实TXT，不连接业务服务、书库或数据库，不代表 Android 真机验收。 |
| `node tests/verify_browser_behavior.mjs --android-manga` | 定向执行既有漫画新增流程、任务提示和阅读进度配置；保留延迟图片、缓存更新、用户移动、恢复阅读及页面生命周期回归。 | 默认随机端口的自有 fixture 服务、临时数据和私有 Chromium；可选服务地址环境变量仅供受控夹具，不得指向真实服务。完整浏览器入口仍包含同一组场景。 |
| `npm run verify:android-media-viewer` | 全屏图片加载和失败重试、切图及关闭重开后的迟到回调、同图补齐保留节点；触摸翻页、滑动和按压定位，窄屏与横屏重试按钮。 | 当前查看器与完整 Android CSS、私有 Chromium、合成 SVG 和门控响应；三类回退开关分别验证加载、回调归属和按压定位，不能代替 Android 真机图片解码与手势验收。 |
| `npm run verify:android-photo-viewer` | 全屏相册补齐期间的关闭重开、同 ID、服务器或账号切换、模块退出与旧回调；旧请求不覆盖新查看器或写入新缓存。 | 当前完整图库工厂、真实账号与 URL 模块及受控 DOM、查看器、缓存和 HTTP；真实旧方法负控应失败，不访问实际相册。 |
| `npm run verify:android-info-preview` | 快速切换资料、收起后重开、离页与切换来源或账号；旧按钮、请求和排队滚动不能覆盖新预览。 | 当前完整资料组件、真实账号 scope 和受控 DOM、HTTP、帧；归属、旧控件和滚动负控应失败，不读取真实作品资料。 |
| `npm run verify:android-fanhao-suggestions` | 新查询立即失效旧建议，迟到成功和失败、失焦、离页、重开同查询及切源/账号；旧建议按钮不能记录新查询并导航旧人物。 | 当前完整搜索工厂、真实账号与受控 DOM、请求和时钟；可见性、回调和按钮负控应失败，不访问实际人物或资料库。 |
| `npm run verify:android-manga-tasks` | 漫画添加、更新、轮询与详情刷新等待期间的服务器和账号切换，任务列表、重试及清理确认的归属；同 ID 新任务与旧监控结束的交错，删除确认与返回只作用于原详情。 | 当前完整图库工厂、真实账号与缓存 fence 及受控请求、时钟、DOM 和弹窗；旧方法负控应失败，已接受任务继续执行，不发起实际采集、清理或删除。 |
| `npm run verify:android-music-history`、`npm run verify:android-music-playlists` | 清空历史、新建/编辑/删除歌单、保存队列与加入/移出歌曲的回执及目录刷新，和新导航、选歌、关闭重开弹层交错；当前失败可重试，过期回调保留新页面与队列。 | 当前完整音乐工厂、操作组件及受控 API、Audio、DOM 和时钟；保留已接受写入，负控验证归属守卫，不操作真实歌单或历史记录。 |
| `npm run verify:android-music` | 音频 Blob 生命周期、翻页与后台歌单请求归属；单曲详情、音频和播放 Promise 乱序，以及首屏恢复、自动衔接与最新选歌的交错；收藏与评分的来源、账号归属和字段写入顺序，已接受写入与离页、连续操作、迟到读取及恢复记录的交错。 | 实际客户端模块或未改写逻辑的函数体、受控 API 与 Audio；不访问真实音乐或数据库，不证明真实音频解码。 |
| `npm run verify:android-music-rendering` | 歌曲翻页保留 DOM、失败重试、取消与筛选切换、重复 ID 和播放标记；完整样式下的屏幕外布局、滚动定位、焦点、点击与封面懒加载；双行长歌名、44px歌曲操作、匹配及版本标记和更多菜单长文案的窄屏布局，行与子按钮的键盘激活；迷你播放器原生打开按钮、44px快捷操作、Enter/Space、全屏焦点往返及深列表浏览位置保持；播放设置与评分真实入口、窄屏及横屏滚动、Tab/Escape、关闭焦点与面板内失败反馈；后台歌单更新及首屏恢复归属；中文组合输入暂停查询，候选确认键不触发搜索，提交后保留输入节点与焦点；排序和搜索筛选最终重绘后的焦点恢复，以及等待期间继续操作、乱序响应、切源和账号变化时的取消。 | 当前音乐页与完整 CSS、私有 Chromium、合成 API、受控 Audio、请求和输入事件；同步生成缓存引用，计时仅作诊断，不证明真机播放、TalkBack 或 Android 输入法兼容性。 |
| `npm run verify:music-playback` | 旧播放 Promise 的成功/拒绝、换源与同源重载、当前拒绝与重试、暂停、睡眠定时和迟到媒体事件。 | 实际音乐页/播放器源码与受控 Audio、DOM 和时钟；不读取音频文件，不证明真实解码或音频设备播放。 |
| `npm run verify:music-requests` | 列表、单曲、旁栏与上次歌曲恢复的请求归属；清空历史、启动扫描及歌单创建/导入/编辑/增删的写入和后续刷新与新导航、选歌交错；同歌单排序保留一个在途和一个最新待办、最多八个活跃歌单槽，确认顺序回滚保留当前成员与对象，覆盖账号切换和容量背压；缓存失效、当前/过期错误及忙碌状态。 | 实际音乐 actions 源码、受控 API、播放器、状态和存储；导航取消读取但保留已发写入，不使用真实数据库、扫描或媒体。排序尚无确认基线的新成员，失败时保留末次排序前的局部位置。 |
| `npm run verify:music-progress` | 两端写入合并、普通及退出容量、账号归属和实际回执；服务端持久顺序、播放去重、预留复用、过期、回拨、竞争及迁移。 | 当前 Web/Android 写入与传输源码、实际 store/routes 和临时 SQLite；显式跳转及无缝切歌使用受控音频与请求，不证明 Android 真机播放。 |
| `npm run verify:music-progress-browser` | 迟到进度与最新 keepalive、播放去重、真实文档离开、会话续期、固定时钟双页面及当前归属复用。 | 当前入口与音乐页、私有 Chromium、动态 loopback 和临时 SQLite；受控 Audio 不解码，不证明断网卸载送达或正式服务已部署。 |
| `npm run verify:novel-reader` | Web 小说章节身份、版本变化、阅读进度恢复确认和聚焦控件下的键盘操作。 | 当前完整阅读模块与受控 API、DOM、帧和计时器；包含行为负控制，不使用真实数据库。 |
| `npm run verify:novel-progress` | 高频保存合并与容量、显式确认回执、keepalive；持久序号、合法回读、多会话、过期和时钟回拨、容量背压及 Worker 重启。 | 当前写入器、实际 store/routes/Worker 和临时 SQLite；只使用合成文本，不操作真实书库。 |
| `npm run verify:novel-progress-browser` | 迟到普通请求与最新 keepalive、真实文档离开、高频保存、跨书位置、恢复确认及会话续期时的新滚动和导航。 | 当前入口与阅读页、私有 Chromium、动态 loopback 及实际临时 SQLite；不证明真实网络卸载送达、排队恢复确认在退出后完成或正式服务已部署。 |
| `npm run verify:archive-images` | 压缩包列表/抽取合并、helper 和响应流的容量及关闭、发送前来源与路径检查；索引查找的来源/记录/数据库/停机竞态、身份替换、迟到写入、旧库迁移及异步巡检；封面评分、字节转换/复制及清单序列化门槛，核对完整旧响应、字段顺序、旧类型与记录格式切换。 | 受控 helper/文件流、私有 Node/Python 子进程、合成 ZIP 和临时 SQLite/缓存目录；旧封面选择与整行序列化分别超过评分记录与清单原文字节预算；不操作真实压缩包或缓存。 |
| `npm run verify:novel-summary-cache`、`npm run verify:novel-empty-pages` | 小说汇总及作者页静态聚合复用、可选探测回退；阅读计数、零总数及非零总数越界页、最后非空页的完整旧响应、SQL 编译/绑定/执行错误与访问门槛；分页版本、进度重排、Worker/外部提交、快照竞态及替库。 | 实际 store/写入 Worker、临时 SQLite 与合成 TXT；每请求关闭连接，核对快照边界、外部替库及探测失败回退；旧聚合与仅判断零总数的负控应超过对应访问预算；空页专项已纳入汇总入口。 |
| `npm run verify:novel-write-worker` | 小说写入锁竞争、六类 API、提交/回滚异常、回执恢复/清理、换库与来源、排队容量和停机。 | 临时 SQLite、真实/受控 Worker、HTTP doubles 和仅扫描合成 TXT 的 Python；不访问真实资料库。 |
| `npm run verify:novel-credentials-async` | 登录凭据检测的主线程响应、取消、超时、输出限制、来源变化与停机。 | 临时假凭据、受控子进程及本机 Node 子进程/动态 HTTP；不启动 Python 检测器或访问外站。 |
| `npm run verify:novel-collection-worker` | 小说采集后台的锁等待、RPC 容量、子进程所有权、入库标识持久化、不确定任务的重试/历史清理保护与停机。 | 临时 SQLite、真实/受控 Worker、本机受控子进程和动态 HTTP；不运行真实采集或访问外站。 |
| `npm run verify:novel-reimport-async` | 本地 TXT 只读解析与统一写入、解码和元数据兼容、章节与进度、回执恢复、来源冲突、取消和停机。 | 合成 TXT、实际 Python 和临时 SQLite、真实/受控 Worker 与子进程；不会导入实际资料或操作正式服务。 |
| `npm run verify:douyin-manager` | 下载队列停止、数据库连接释放、作者汇总/分页/刷新候选的一致快照、游标分页、已加载行更新、请求竞态与深页索引。 | 临时 SQLite、独立子进程、动态 HTTP fixture 与无头浏览器；不启动或停止正式 8765 服务。 |

下载链接游标以首屏 ID 水位和已下载时间排序边界限制后续页，每次请求使用短 WAL 快照；它不会冻结整个翻页过程。新增链接或移到已消费边界之前的记录在主动刷新后出现，后台按已加载 ID 更新状态。fixture 分别验证这一边界、旧 offset 接口兼容，以及已下载深页使用表达式索引而不做临时排序。

`Application checks` 工作流在 Windows 上运行日常门禁、前缀分页隔离、浏览器请求竞态、作品与封面性能、文件流生命周期、音乐读图、作品封面生成，以及小说汇总、写入和凭据检测 fixture。它使用 Node.js 24、JDK、Python 与宿主 Chrome/Edge，不构建或安装 APK，也不运行完整应用或真机验收。修改工作流后，本机命令通过与 GitHub 执行成功仍须分别记录。

例如 `verify:image-library`、`verify:novels`、`verify:core-images` 都包含多个子检查；运行前查看整个脚本链。一个脚本的成功不能覆盖同模块所有未执行的门禁。

## 浏览器验证的特殊条件

默认不设置 `FANHAO_BROWSER_TEST_BASE_URL` 时，验证器自行启动 `127.0.0.1` 临时服务，端口默认动态分配。如果设置了该变量，验证器将访问指定服务，而页面交互可能发起写请求。不要把它指向现有资料库来“借用环境”。

浏览器由 `CHROME_PATH` 或验证器中的 Chrome/Edge 候选路径定位；`playwright-core` 不会自动提供浏览器二进制。
无法启动浏览器应报告环境缺失，不能把未执行的交互测试记为通过。

## 启动与 Android 验证的特殊条件

`verify:startup` 在 Windows 下要求 `powershell.exe` 和 `pwsh.exe` 都执行成功；不是任选其一。其 PowerShell fixture 拷贝启动器到临时目录、生成假服务并使用动态端口，不依赖正式的 `29998` 或 `8765`。安装缺失运行时后再重跑，不要用正式服务替代 fixture。

Android 的依赖准备、JDK / Android SDK / Gradle 缓存要求、原生 fixture 覆盖与缓存同步副作用，见[Android 验证环境与边界](android-verification.md)。

## 完整应用门禁

```powershell
npm run verify:full
```

该命令展开现有 `verify:*` 模块入口，按原有顺序执行全部行为检查，并对完全相同的叶子命令去重；例如 native video progress 和 media channel fixture 在一次完整门禁中各执行一次。模块入口本身保持兼容，可继续单独运行。
前项失败会阻止后续项执行。除 Node 依赖外，还包括 Python 检查、浏览器、PowerShell 及 Java fixture；须先按[Android 验证环境](android-verification.md)显式准备 Android npm 依赖、JDK、Android platform 与 Gradle JAR 缓存。
部分 Python 检查依赖第三方包，例如 `verify:javdb-card-facts` 使用 `bs4`；不能只装根目录 npm 依赖就承诺完整门禁可运行。
按失败脚本的导入与所属工具要求补齐环境，不要为了让总命令变绿而跳过门禁。

## 如何报告结果

每次交付记录检查对象、命令、结果、未执行原因和环境条件。
如果总门禁中断，列出首个失败项及尚未执行的范围，不能说“其余全部通过”。
性能结论还需数据规模、测量条件与重复结果；一次计时不是通用基准。
线上或本机现有服务的验收另行记录，不能由源码 fixture 推导其已部署状态。
