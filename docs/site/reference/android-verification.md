---
title: Android 验证环境与边界
description: 准备 Android 客户端检查依赖，区分受控浏览器、宿主 JVM、APK 构建和真机验收。
status: maintained
verified_at: 2026-10-29
sources:
  - package.json
  - android-client/package.json
  - tests/run_verification.mjs
  - tests/verify_native_short_video_actions.mjs
  - tests/verify_native_short_video_checkpoint.mjs
  - tests/verify_native_short_video_session.mjs
  - tests/verify_native_short_video_audio.mjs
  - tests/verify_native_short_video_audio_focus.mjs
  - tests/verify_native_short_video_prefetch.mjs
  - tests/verify_native_short_video_cache_startup.mjs
  - tests/verify_native_short_video_recovery.mjs
  - tests/verify_native_short_video_cover_ownership.mjs
  - tests/verify_native_short_video_frame_loading.mjs
  - tests/verify_native_short_video_bitmap_decode.mjs
  - tests/verify_native_short_video_author_requests.mjs
  - tests/verify_android_short_video_list_lifecycle.mjs
  - tests/verify_android_short_video_back.mjs
  - tests/verify_android_short_video_suggestions.mjs
  - tests/verify_vision_lifecycle.mjs
  - tests/verify_android_storage_metrics.mjs
  - tests/verify_android_photo_categories.mjs
  - tests/verify_android_mobile_action_sheet.mjs
  - android-client/www/js/mobile-action-sheet.js
  - tests/verify_android_media_viewer.mjs
  - android-client/www/js/media-viewer.js
  - tests/verify_android_novel_categories.mjs
  - tests/verify_android_music_search_filters.mjs
  - tests/verify_android_music_list_rendering.mjs
  - tests/verify_android_music_back.mjs
  - android-client/www/modules/music/music-playlist-view.js
  - android-client/www/modules/music/music-library-sort.js
  - tests/serve_android_gallery_navigation_fixture.mjs
---

# Android 验证环境与边界

Android 客户端检查同时包含源码核对、受控页面和宿主 JVM fixture。运行前先按[验证矩阵](verification.md)选择对应行为，再核对本页的依赖和副作用。脚本通过不表示已经构建、安装或完成真机验收。

## 检查入口与依赖准备

| 命令 | 注意事项 |
| --- | --- |
| `npm run setup:android-verification` | 显式在 Android 目录执行 `ci --include=dev --ignore-scripts --no-audit --no-fund`；需要包源访问并改写其依赖目录。首次运行或锁文件变化后执行。 |
| `npm run verify:android-security` | 使用已有 Android 依赖运行安全检查；不会自动执行 `npm ci`。依赖缺失时先运行上面的 setup。 |
| `npm run verify:android-gradle-config` | 调用 Android 工程自己的 Gradle 配置检查。 |
| `npm run verify:short-video-client` | 短视频客户端检查入口；包含下述原生 JVM fixture，但不覆盖整个 Android 应用。 |
| `npm run verify:android-release` | 发布所需的工作流、鉴权、写权限、安全、Gradle 配置和导入门禁；不包含所有 Android UI 回归。 |
| `npm run verify:android-full` | 显式运行完整 Android 客户端、system control、作品移动、小说 UI、短视频原生、安全、鉴权和导入回归；runner 会把重复的缓存同步和叶子检查去重。 |

`verify:android-security`、`verify:android-client` 和 `verify:short-video-client` 会先运行幂等的 `sync:cache`，同步 Android Web 缓存版本引用；这会改写需要更新的生成引用，但不会重装依赖。`verify:android-client` 继续作为客户端行为聚合入口使用，也不能替代真机验收。

不要把 `install:debug`、`publish:debug` 等发布/安装脚本混进普通检查。它们的写入对象与授权要求不同，见[开发流程](../guide/development.md)。

## JDK、Android SDK 与 Gradle 缓存

原生客户端门禁会在宿主 JVM 中编译并运行 Java fixture，不能归为纯源码检查：

- 准备包含 `javac` 与 `java` 的 JDK，按脚本的定位规则设置 `JAVA_HOME`；不同验证器的默认路径和 PATH 回退并不相同。
- 短视频 actions 验证需要本地 Android platform 的 `android.jar`，可通过 `ANDROID_HOME` 或 `ANDROID_SDK_ROOT` 定位 SDK。
- 短视频 actions 与检查点验证需要 Gradle 缓存中的 `org.json:json` JAR；缓存根由 `GRADLE_USER_HOME` 或用户目录下的 `.gradle` 决定。这些 fixture 不自动下载缺失 JAR。
- 短视频任务会话验证另读取 Gradle 缓存中的 SavedStateRegistry、Lifecycle、Arch Core 和 Kotlin 运行库，在两个独立 JVM 中执行真实注册表及保存/恢复接线；Android Bundle、生命周期投递与窗口仍是受控边界，不能据此声称真机系统回收已通过。
- 短视频音频验证读取项目所用 Media3 的 Gradle 缓存 `media3-common` AAR，可用 `FANHAO_TEST_MEDIA3_COMMON_AAR` 显式指定；在隔离目录运行实际耳机断开事件处理实现。缺失依赖时报告错误，不自动下载或安装 APK。
- 短视频缓存启动和错误恢复验证还需要 Gradle 缓存中的 `media3-datasource` AAR，以核对 SDK 的初始化锁边界和实际 HTTP 错误类型；缓存对象和文件扫描由受控 fixture 替代，不读取真实媒体缓存。
- 视觉生命周期的 Google Tasks 验证需要 Android SDK 与本地 Gradle 依赖缓存。优先使用转换后的 runtime JAR；只有原始 AAR 时，仅把其中的 `classes.jar` 提取到验证临时目录，不需要先构建 APK，也不自动下载依赖。

## 短视频受控验证的覆盖边界

这些条件解释部分短视频检查实际执行的对象，完整命令与领域选择仍以[验证矩阵](verification.md)和当前 `package.json` 为准：

- 字节预取使用受控读取验证最多两个物理任务、一个最新待办及每条最多 4 MiB 的范围，不能据此推断真机网速。
- 封面调度验证使用两个物理读取槽和最多六个待办，检查当前来源优先、同源去重、前台升级与迟到画面归属。
- 图片解码验证执行实际采样与缩放方法，检查超宽、超长等尺寸的解码预算和显示清晰度；受控 Bitmap 边界不代表真机内存峰值。
- 作者页请求验证控制首屏、排序和分页的返回顺序，检查新排序、退出及重新打开后旧回调无法覆盖列表与导航状态。
- Android 短视频列表验证执行实际页面工厂与控制器，检查离开模块后迟到的分页、刷新及失败回调不再更新页面，并保留重新进入和正常追加行为。
- 排序弹层验证执行实际模块、列表、注册表和 JavaScript 返回键分发，检查先关闭弹层、恢复焦点且保留底层读取，以及旧弹层控件失效；原生任务动作仅核对源码，不代表真机系统返回键验收。
- 搜索建议验证执行实际页面与搜索控制器，在受控定时器和 API 下检查请求乱序、失焦、离页、来源切换以及旧建议按钮失效，保留正常搜索、历史和作者筛选。

执行会创建并清理临时目录与编译产物，部分 fixture 会写入测试状态或使用本机 HTTP 服务。它们不构建 APK，也不替代 Android 真机验收。浏览器定位、临时服务和结果报告要求见[验证矩阵](verification.md)。

## 界面易用性专项

| 命令 | 覆盖与边界 |
| --- | --- |
| `npm run verify:android-storage-metrics` | 执行当前完整存储指标函数，检查已获取的零字节显示为 `0 B`，缺失或异常值显示 `-`，保留非零格式、计数和输入焦点；DOM 与数据受控，不读取真实存储。 |
| `npm run verify:android-mobile-sheets` | 执行共享面板和实际调用模块，检查可见关闭、焦点回入口、当前/可用选项初始焦点及旧关闭控件失效；DOM 受控，固定标题和屏内可见性另用浏览器检查。 |
| `npm run verify:android-media-viewer` | 在私有浏览器中执行实际预览器和完整 CSS，检查图片加载、失败重试、旧回调失效、滑动，以及头像触发器的可访问名称、Enter/空格打开和关闭后焦点恢复；只使用合成图片，不代表真机或读屏验收。 |
| `npm run verify:android-photo-categories` | 执行当前照片模块和共享操作弹层，检查固定/动态分类、当前选择、快捷标签与菜单路由一致，以及关闭与焦点恢复；DOM 与路由受控，菜单高度、长名称与窄屏布局另用浏览器检查。 |
| `npm run verify:android-novel-categories` | 执行当前小说模块，检查分类重绘后显露当前选项且不触发页面纵向滚动；受控几何不替代实际长标签、窄屏和横向滑动验收。 |
| `npm run verify:android-music-search-filters` | 执行当前音乐工厂，检查综合页仍生效的歌曲筛选可见、可清除，保留关键词与搜索范围；DOM 与接口受控，触控区、菜单换行及窄屏布局另用浏览器检查。 |
| `npm run verify:android-music-rendering` | 私有浏览器执行实际音乐模块与完整 CSS；检查列表、搜索、播放器归属、详情长文与44px操作，包含管理弹层、排序固定标题、完整筛选标签和原生排序入口。路由接回场景验证菜单真实请求，音频为受控替身，不代表真机或原生选择器弹出层验收。 |
| `npm run verify:android-music-back` | 执行实际音乐模块及 JavaScript 返回分发；含歌单管理弹层、排序/筛选关闭后焦点恢复、离页后旧控件失效，以及编辑/删除仍进入原提示流程。延迟焦点检查保留来源与账户边界；DOM、音频与确认结果受控，不执行实际写入，不代表真机返回键验收。 |

`node tests/serve_android_gallery_navigation_fixture.mjs` 提供真实 Android 页面和完整 CSS 的只读合成预览，启动器包含多种隔离场景，例如：

- 普通图库导航、图库 30 项长分类、小说 8 分类书库，用于检查长名称、末项选择及当前分类可见性。
- 音乐搜索筛选含 2 首普通歌曲和 1 首收藏歌曲，用于检查切换范围后的有效条件、清除及窄屏菜单，不提供音频或收藏写入。
- 音乐详情包含 1 位长名歌手、2 张有/无封面的长名专辑和 4 首歌曲，通过真实列表进入详情；不提供歌曲详情或音频。
- 歌单场景从首页进入长名自建歌单、空歌单、真实 `hires` 智能歌单与 2 条合成最近播放；可打开本地管理菜单，不提供写入、歌曲详情、音频或导出。
- 主库搜索含 3 个状态不同的作品和 1 位匹配人物，用于检查输入、筛选排序与详情往返；已知作品的迁移状态只返回空任务，不提供任务操作。

默认与普通预览场景拒绝业务写入且不代理真实服务。独立 `manga-recovery` 场景仅对精确白名单合成链接在内存中返回失败或完成回执，不启动采集、子进程或数据库操作；其他链接、方法和场景仍拒绝写入。`--smoke` 与 `--smoke-recovery` 仅核对 HTTP、数据与资源隔离，不能替代页面截图和实际交互验证。
