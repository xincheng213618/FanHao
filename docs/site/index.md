---
title: FanHao 项目文档
description: 从理解系统到验证变更，为开发者与 AI 提供同一份可追溯的项目知识。
status: maintained
verified_at: 2026-08-30
sources:
  - README.md
  - package.json
  - src/fanhao/module-registry.js
layout: home
hero:
  name: FanHao
  text: 让项目知识，直接参与开发。
  tagline: 一份给人阅读、也给 AI 使用的文档。从任务找到入口，从源码确认事实，从验证建立信心。
  actions:
    - theme: brand
      text: 开始了解项目
      link: /guide/quick-start
    - theme: alt
      text: 给 AI 的上下文
      link: /ai/context
features:
  - title: 先看系统，再改代码
    details: 从组合根到业务模块，查清职责、依赖与数据流，缩小每次修改的范围。
    link: /architecture/overview
    linkText: 阅读架构
  - title: 按任务加载上下文
    details: 用短篇 Markdown、任务路由和来源标记，给 AI 恰好够用的项目知识。
    link: /ai/tasks
    linkText: 选择任务
  - title: 让文档可以被验证
    details: 导航、源码路径、链接、导出内容与发布范围都参与构建检查。
    link: /contributing/documentation
    linkText: 查看维护规范
---

# 一个项目，两种阅读方式

FanHao 是本地优先的媒体资料库：Node.js 服务组织本地内容，Web 与 Android 提供浏览和播放入口。
这里是项目知识站；GitHub Pages 只托管这些静态文档，不托管媒体、数据库或应用服务。

## 从当前任务出发

| 你想完成的事 | 阅读入口 |
| --- | --- |
| 安装与安全试跑 | [快速上手](guide/quick-start.md) |
| 找到负责某项能力的源码 | [仓库地图](architecture/repository-map.md) · [模块清单](architecture/modules.md) |
| 让 AI 开始一个开发任务 | [AI 上下文](ai/context.md) · [任务路由](ai/tasks.md) |
| 理解 API、配置和数据边界 | [接口契约](reference/api.md) · [配置参考](reference/configuration.md) |
| 确定改动应该如何验证 | [验证矩阵](reference/verification.md) |
| 发布或继续完善这份文档 | [GitHub Pages](contributing/github-pages.md) · [文档规范](contributing/documentation.md) |

## 给机器的入口

- [llms.txt](/llms.txt)：从短索引按需选择页面。
- [ai-context.json](/ai-context.json)：页面元数据、来源、版本标识和内容哈希。
- [search-index.json](/search-index.json)：按标题切分的检索正文。
- [llms-full.txt](/llms-full.txt)：精选文档的完整 Markdown，适合离线导入。

每个内容页都提供原始 Markdown。先读索引和相关主题，通常比一次装入完整文档更合适。

## 这份知识如何保持可信

页面顶部的核对日期表示最近一次人工对照源码的日期。
来源路径帮助你返回代码；构建检查验证路径存在和产物一致，但不证明每条行为已经在生产环境验收。
旧有专题仍保留在仓库内，迁移范围见[旧文档与迁移](reference/legacy.md)。
