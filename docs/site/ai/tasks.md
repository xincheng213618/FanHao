---
title: 任务路由
description: 把常见开发任务映射到需要读取的文档、源码入口和现有验证。
status: maintained
verified_at: 2026-08-30
sources:
  - package.json
  - src/fanhao/module-registry.js
  - src/modules/short-videos/server/delete-job-service.js
  - src/modules/short-videos/server/watch-write-service.js
  - src/modules/fanhao/server/works/work-move-job-service.js
  - src/platform/server/auth.js
  - android-client/package.json
---

# 任务路由

先选择任务，再加载上下文。下表的验证是起点，不代表只运行一条命令就能证明整个功能正确。
命令的环境依赖与副作用见[验证矩阵](../reference/verification.md)。

## 按变更范围定位

| 任务 | 首先打开的源码 | 首选验证 |
| --- | --- | --- |
| 新增模块、修改能力清单 | `src/fanhao/module-registry.js`、对应 `module.js` | `npm run verify:modules` |
| 改主服务装配或停机 | `server.js`、`src/platform/server/server-host.js` | `npm run verify:startup`、`npm run verify:fanhao` |
| 调整权限或 API 错误 | `src/platform/server/auth.js`、`http-app.js`、目标路由 | `npm run verify:auth`、`npm run verify:mutation-auth` |
| 改番号列表与人物查询 | `src/modules/fanhao/server/` | `npm run verify:fanhao`、`npm run verify:works-performance` |
| 改图库或封面索引 | `src/modules/content-index/server/`、`src/modules/photos/server/` | `npm run verify:image-library`、`npm run verify:photo-reader` |
| 改短视频观看写入 | `src/modules/short-videos/server/watch-write-service.js` | `npm run verify:short-video-watch-write` |
| 改短视频删除恢复 | `src/modules/short-videos/server/delete-job-service.js` | `npm run verify:short-video-delete-jobs` |
| 改跨目录文件移动 | `src/modules/fanhao/server/works/work-move-job-service.js` | `npm run verify:work-move-jobs` |
| 改音乐扫描与分页 | `src/modules/music/server/` | `npm run verify:music-rescan-worker`、`npm run verify:music-scale` |
| 改小说存储或采集 | `src/modules/novels/server/` | `npm run verify:novels` |
| 改 Android WebView 或原生桥 | `android-client/www/`、`android-client/android/app/src/main/java/` | `npm run verify:android-security`，按当前包脚本补充相关原生与页面验证 |
| 改行情页面或服务 | `src/modules/market-dashboard/server/`、`public/modules/market-dashboard/` | `npm run verify:market-dashboard` |
| 改下载管理器集成 | `src/modules/short-videos/download-manager/` | `npm run verify:douyin-manager` |
| 改文档、导航或 AI 导出 | `docs/site/`、`docs/.vitepress/` | `npm --prefix docs test`、`npm --prefix docs run build` |

不要把表中的入口目录当成允许全量重构的范围。先跟随当前调用链，缩小到实际拥有行为的实现。

## 跨端变更的阅读包

- 页面与导航：[模块清单](../architecture/modules.md) → Web 页面 → Android 对应模块 → 模块描述符。
- 持久化与恢复：[数据流](../architecture/data-flow.md) → Store/Worker → 路由 → fixture。
- 权限和文件访问：[接口契约](../reference/api.md) → 鉴权实现 → 路径安全 → 请求处理器。
- 文档工作：[文档规范](../contributing/documentation.md) → 页面来源 → 单一导航清单 → 构建产物。

## 在任务描述中写清楚

~~~text
目标：用户可观察到的变化。
范围：允许修改的目录，必须保持不变的接口与数据。
依据：当前源码入口和已复现的问题。
验证：临时fixture、结构检查、需要人工验收的部分。
交付：文档/代码变更和测试结果；是否需要提交、推送或发布。
~~~

“构建成功”“通过 fixture”“本机运行正常”“已发布到 GitHub”是不同结论。
交付时只写出已经取得证据的部分。
