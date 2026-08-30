---
title: 开发流程
description: 以源码证据、模块边界和隔离验证组织人类与 AI 的日常开发。
status: maintained
verified_at: 2026-08-30
sources:
  - package.json
  - android-client/package.json
  - src/fanhao/module-registry.js
  - src/modules
  - src/platform/server
  - public
  - tools/build_short_video_web.mjs
---

# 开发流程

一次改动应有明确的行为目标、涉及的模块和可重复的验证方式。
AI 与人类使用相同的源码和验证入口；不能用“测试通过”替代对运行范围与副作用的说明。

## 开始前确认范围

从仓库根目录读取当前状态：

```powershell
git status --short
git branch --show-current
git diff --stat
```

保留其他人的未提交改动，不要清空工作目录来获取“干净状态”。
当主副本正在运行服务或被用于验收时，使用独立 worktree 或新克隆的副本；仅隔离 Git 文件仍不等于隔离数据库和外部媒体目录。
应用运行前遵循[快速开始的隔离步骤](./quick-start.md)。

任务说明至少写清：

| 内容 | 示例形式 |
| --- | --- |
| 预期行为 | 某个请求在指定失败条件下返回可重试错误。 |
| 修改范围 | 模块、服务端或客户端，以及允许修改的路径。 |
| 禁止动作 | 不重启已有服务、不访问真实媒体、不发布或推送。 |
| 验证证据 | 对应 fixture、结构检查或明确授权的运行验收。 |

让 AI 接手时，从 [AI 上下文](../ai/context.md)进入，按任务补充最小必要源码；不要整库复制历史日志或配置。

## 找到正确的修改入口

| 需求 | 首先检查 |
| --- | --- |
| HTTP、鉴权、响应与通用路径安全 | `src/platform/server/`。 |
| 启动参数与依赖装配 | `src/bootstrap/server-config.js`、`server.js`。 |
| 某个业务功能 | `src/modules/<module>/` 中的入口、runtime、service、store。 |
| Web 行为与界面 | `public/` 及对应模块客户端文件。 |
| Android 行为 | `android-client/www/` 与原生 Android 工程。 |
| 批量维护与独立核验 | `tools/`，必要时核对管理作业注册。 |

先看[仓库地图](../architecture/repository-map.md)和[模块说明](../architecture/modules.md)。
沿真实调用链寻找入口、状态所有者和写入边界，不能仅凭文件名判断修改位置。

## 安装与构建

应用开发依赖安装在仓库根目录：

```powershell
npm ci
```

短视频 Web bundle 由源码生成：

```powershell
npm run build:short-video-web
npm run verify:short-video-build
```

构建会更新 `public/short-video-app.min.js` 和 `public/index.html` 中的版本 URL；不要直接编辑压缩产物。
`npm start` 的 `prestart` 也会执行构建，然后启动真实应用，不是通用“开发检查”命令。

Android 有独立依赖：

```powershell
npm --prefix android-client ci
npm --prefix android-client run verify:security
npm --prefix android-client run verify:gradle-config
```

`sync` 会同步资源并运行 Capacitor 同步；`build:debug` 会构建 APK。
`install:debug`、`publish:debug`、`build:debug:update` 涉及设备或更新产物，不能从普通代码修改任务推断出执行授权。
需要原生验收时，先核对 Android 构建脚本的实际参数与 SDK/JDK 环境。

## 验证改动

先运行与改动最近的验证，再根据风险扩展范围。
命令、前提和副作用见[验证矩阵](../reference/verification.md)。

```powershell
npm run verify:modules
npm run verify:imports
git diff --check
```

以上检查不能证明功能正确。数据库竞争、Worker 退出或文件移动等行为需要可执行 fixture；客户端交互需要浏览器或设备上的对应证据。
不要为了修复一个失败断言删除边界校验、扩大超时或重置数据库。

## 同步文档与交付

当配置、模块职责、命令或持久化协议改变时，更新对应的维护页及其来源路径。
按照[文档规范](../contributing/documentation.md)保留页面状态、核对日期和源码依据。

```powershell
npm --prefix docs ci
npm --prefix docs run check
npm --prefix docs run build
git diff --check
```

交付说明包含行为变化、运行过的命令、未覆盖范围和剩余风险。
“已实现”“已通过 fixture”“已在现有服务验收”“已发布”是不同状态，不应混为一谈。
提交时只纳入本次范围内的文件；推送、发布、设备安装和服务重启分别确认授权。
