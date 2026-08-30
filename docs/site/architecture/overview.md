---
title: 架构总览
description: FanHao 的运行单元、请求链路、模块边界与源码阅读顺序。
status: maintained
verified_at: 2026-08-30
sources:
  - package.json
  - server.js
  - src/bootstrap/server-config.js
  - src/fanhao/module-registry.js
  - src/platform/server/http-app.js
  - src/platform/server/server-host.js
  - src/modules/fanhao/server/composition.js
  - src/modules/short-videos/server/runtime.js
  - android-client/package.json
  - android-client/www/js/android-module-registry.js
  - public/js/standalone-host.js
  - tools/verify_module_structure.mjs
---

# 架构总览

FanHao 是以本地资料库为中心的 Web 与 Android 应用。服务端负责索引、状态写入、鉴权和媒体访问；客户端负责导航、浏览、播放与阅读。

本页描述核对日期时的源码结构，不代表运行中服务的健康证明。需要定位文件时，先看[仓库地图](./repository-map.md)；需要确定业务所有权时，看[模块清单](./modules.md)。

## 运行单元

| 单元 | 入口 | 职责与边界 |
| --- | --- | --- |
| 主服务 | `server.js` | 创建共享依赖、发现模块、启动 HTTP 服务；默认端口 `29998`，可配置 |
| Web 客户端 | `public/` | 主服务提供的静态页面与浏览器模块 |
| Android 客户端 | `android-client/` | Capacitor WebView 与原生 Android 工程；通过 API 连接主服务 |
| 下载管理器 | `src/modules/short-videos/download-manager/` | 独立的采集与下载服务；主服务默认连接本机 `8765` |
| 工具与作业 | `tools/` | 扫描、导入、迁移、构建与验证；部分由后台作业调用 |

主服务与下载管理器有独立的运行状态和数据。主服务能访问，不等于下载管理器健康；反之亦然。静态文档站可部署到 GitHub Pages，但 Pages 不会运行这些服务或托管本地媒体库。

## 服务端装配

```text
src/bootstrap/server-config.js
              |
              v
          server.js  ----------------> 共享服务与 moduleDeps
              |
              v
src/fanhao/module-registry.js
              |
              +--> src/modules/<id>/module.js --> server/runtime.js
              |
              v
src/platform/server/http-app.js --> 模块 API / 媒体路由 / 静态资源
              |
              v
src/platform/server/server-host.js --> HTTP 监听与停机
```

1. 启动配置解析环境变量、目录、工具路径和运行参数。
2. `server.js` 创建平台服务与历史业务依赖，通过 `moduleDeps` 传入模块。
3. 注册器扫描 `src/modules/*/module.js`，校验描述符，创建运行时并排序。
4. 模块 `start()` 执行后，服务宿主开始监听；部分预热属于启动成本。
5. 停机先停止接受新连接，再调用 `beginStop()`、等待连接退出，最后调用 `stop()`。

注册器按 `order`、再按 `id` 排序；启动顺序正向，`beginStop()` 与 `stop()` 逆向。后台 worker、定时器和长请求必须纳入相应生命周期。

## 请求边界

`src/platform/server/http-app.js` 是公共请求入口：处理跨源访问、鉴权、访问记录和未捕获异常，然后依次询问 API 路由、媒体路由与静态文件服务。

模块路由返回 `true` 表示已接管请求，返回 `false` 表示继续匹配。模块可在自己的路由中进一步要求本机管理权限；不能把“已登录”理解为“允许任意文件或数据库操作”。

`GET /api/modules` 返回可见模块的描述符。隐藏模块仍参与路由和生命周期，只是不出现在公开模块清单中。

详情见[数据与请求流](./data-flow.md)。

## 客户端边界

Web 并非统一的单页应用：番号入口、短视频入口与独立页面宿主并存。

| 页面形态 | 当前入口 |
| --- | --- |
| 番号 | `public/fanhao-app.js` → `public/app.js` |
| 短视频 | `public/short-video-app.js` → `public/modules/short-videos/` |
| 图库、影视、小说、音乐、小工具 | `public/standalone-app.js` → `public/js/standalone-host.js` |
| 行情 | `public/modules/market-dashboard/index.html` |

Android 的模块注册器合并服务端描述符与本地后备目录，再加载声明的 `android-module.js`。因此新增服务端描述符并不会自动生成 Android 页面；目前行情只有 Web 声明。

Web 与 Android 可共享 API 契约，但各有页面控制器和原生能力边界。更改数据含义时应检查两端消费者，不要假定修改 Web 文件会自动同步 Android。

## 现有实现与开发约束

**现有实现：** `server.js` 仍装配较多业务服务；番号模块已有 `server/composition.js`。这是兼容中的装配结构，不能描述为已经完全去除业务耦合。

**开发约束：** 通用 HTTP、鉴权、文件与媒体能力归 `src/platform/server/`；单个业务的查询、状态和规则归所属模块。平台不得反向依赖业务模块，可见业务模块之间应避免直接导入对方内部文件。

`tools/verify_module_structure.mjs` 对导入方向、旧目录、客户端入口和宿主结构设置护栏。规则变动时，应一起修改实现、相应验证和文档，不能只更新文字。

## AI 的最小阅读顺序

1. 读[AI 上下文](../ai/context.md)，确定任务范围和禁止触碰的数据。
2. 从[仓库地图](./repository-map.md)定位入口，读取所属模块的 `module.js` 与运行时。
3. 沿路由追踪服务、存储和客户端消费者，不从页面标题推断数据库所有权。
4. 查[验证参考](../reference/verification.md)，选择覆盖当前契约的最小验证集。
5. 按[开发指南](../guide/development.md)完成实现与验证，报告实际检查和仍未验证的部分。
