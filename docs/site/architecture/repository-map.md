---
title: 仓库地图
description: 按任务定位 FanHao 的源码、客户端、工具和运行数据边界。
status: maintained
verified_at: 2026-08-30
sources:
  - server.js
  - package.json
  - src/bootstrap/
  - src/fanhao/
  - src/modules/
  - src/platform/server/
  - lib/
  - public/
  - android-client/
  - tools/
  - tools/build_short_video_web.mjs
  - tools/verify_module_structure.mjs
  - android-client/scripts/sync-shared-assets.mjs
  - .gitignore
---

# 仓库地图

这是一份任务路由表，不是全量文件列表。先确定变更属于哪个模块，再在该目录里搜索；避免把整个仓库、运行日志或媒体数据一次性交给 AI。

## 第一层目录

| 路径 | 所有权 | 阅读或修改时的注意点 |
| --- | --- | --- |
| `server.js` | 主服务装配 | 查依赖如何注入；新增领域规则优先放所属模块 |
| `src/bootstrap/` | 启动配置 | 环境变量、目录与工具路径；不依赖业务模块 |
| `src/fanhao/` | 模块协议 | 发现、描述符校验、排序、设置和生命周期 |
| `src/modules/<id>/` | 业务实现 | `module.js` 为入口，`server/` 为服务端实现 |
| `src/platform/server/` | 通用服务端能力 | HTTP、鉴权、文件路径安全、媒体响应、SQLite 辅助 |
| `lib/` | 解析器与公共定义 | 番号、元数据、管理脚本目录等现有公共代码 |
| `public/` | Web | 页面入口、模块控制器、共享 UI、静态资源和游戏 |
| `android-client/www/` | Android WebView | 模块页面、客户端宿主与平台适配 |
| `android-client/android/` | 原生 Android | Gradle 工程和原生桥接能力 |
| `tools/` | 离线工具与验证 | 命令可能扫描、写库或移动文件，执行前先读参数 |
| `docs/site/` | 持续维护的文档站 | 面向人和 AI 的导航、契约与操作入口 |
| `docs/` 其他文件 | 原有专题资料 | 提供深度背景；与源码冲突时先核实，不当作实时清单 |

`src/server/` 是退出使用的旧目录。结构验证要求其中没有文件，不应把新服务代码放回去。

## 按问题寻找入口

| 任务或症状 | 第一入口 | 下一跳 |
| --- | --- | --- |
| 启动参数、监听地址 | `src/bootstrap/server-config.js` | `src/platform/server/root-config.js`、`server.js` |
| 请求没有匹配、异常响应 | `src/platform/server/http-app.js` | `src/fanhao/module-registry.js`、模块路由 |
| 登录、跨源或管理权限 | `src/platform/server/auth.js` | 公共请求入口和对应路由的权限检查 |
| 新增模块、导航描述符 | `src/fanhao/module-registry.js` | `src/modules/<id>/module.js`、客户端模块注册器 |
| 人物、作品、收藏 | `src/modules/fanhao/server/runtime.js` | `people/`、`works/`、`library/`、`collections/` |
| 图库列表与共用索引 | `src/modules/content-index/server/` | `src/modules/photos/server/` 或 `src/modules/media/server/` |
| 小说采集与阅读 | `src/modules/novels/server/runtime.js` | `store.js`、`collection-service.js`、客户端小说模块 |
| 短视频列表、写入、删除 | `src/modules/short-videos/server/runtime.js` | 路由、worker client、存储或删除作业服务 |
| 音乐扫描与播放 | `src/modules/music/server/runtime.js` | `scan-service.js`、worker、查询和状态存储 |
| 行情数据 | `src/modules/market-dashboard/server/runtime.js` | `quote-service.js` 和对应 Web 页面 |
| 采集器与下载任务 | `src/modules/short-videos/download-manager/` | 其独立 README、`manager_core/` 与自身配置 |

完整模块状态见[模块清单](./modules.md)，服务端链路见[架构总览](./overview.md)。

## 客户端定位

Web 共享导航从 `public/js/module-navigation.js` 开始；番号页面保留 `public/app.js`，独立页面宿主是 `public/js/standalone-host.js`。具体交互通常在 `public/modules/<id>/`。

Android 宿主是 `android-client/www/app.js`，模块装载入口是 `android-client/www/js/android-module-registry.js`，业务页面在 `android-client/www/modules/<id>/`。涉及播放器、下载、文件访问或设备能力时，再进入原生工程追踪桥接调用。

两端拥有独立实现。定位“手机正常、Web 异常”时，先比较 API 参数和消费逻辑，再判断是否是共享服务端问题。

## 源码与生成产物

| 产物 | 权威来源 | 更新方式 |
| --- | --- | --- |
| `public/short-video-app.min.js` | `public/short-video-app.js` 及其导入 | `tools/build_short_video_web.mjs` 构建并同步 HTML 中的内容哈希 |
| Android 同步游戏资源 | `public/games/` | `android-client/scripts/sync-shared-assets.mjs` 按声明同步 |
| Android APK | WebView 资源与原生工程 | 使用 Android 构建脚本，不手工改 APK |
| 索引、缩略图和播放缓存 | 模块存储与工具 | 使用对应重建或失效机制，不把缓存当源文件 |

先修改权威来源，再运行已有生成链路。不要直接编辑压缩 bundle 来修复逻辑，也不要假定资源同步脚本会复制所有 Web 页面。

## 运行数据不是示例夹具

`data/`、`logs/`、下载管理器的 `data/` 与 `logs/`，以及配置的外部媒体根目录都可能包含真实状态。`.gitignore` 忽略某个路径，只表示不跟踪它，不表示可以删除或公开。

数据库、凭据、Cookie、日志中的个人路径和媒体清单，不应复制进文档站、测试快照或 AI 上下文。存储所有权见[数据与请求流](./data-flow.md)。

验证应使用脚本明确创建的临时夹具。需要真实服务诊断时，先确认目标端口、进程和数据路径；不要为验证文档而启动扫描、迁移或清理。

## 推荐搜索方式

在仓库根目录使用 PowerShell：

```powershell
rg --files src/modules/short-videos/server
rg -n 'recordWatch|watchReceipt' src/modules/short-videos/server
rg -n 'verify:short-video' package.json
```

把示例模块替换为当前任务的所有者；排查跨模块行为时再扩大范围。提交给 AI 的证据应包含入口、调用方、状态所有者与对应验证，而非只有一个报错片段。

接下来阅读[开发指南](../guide/development.md)与[验证参考](../reference/verification.md)。
