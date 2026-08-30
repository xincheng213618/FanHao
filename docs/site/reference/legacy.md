---
title: 旧文档与迁移
description: 保留既有专题和仓库链接，只将经过源码核对、脱敏的内容纳入公开站点。
status: maintained
verified_at: 2026-08-30
sources:
  - docs/README.md
  - docs/modules/README.md
  - docs/code-structure-assessment.md
  - docs/.vitepress/site.mjs
---

# 旧文档与迁移

已有的 `docs/*.md`、`docs/modules/*.md` 继续保留，现有仓库内链接不移动、不批量重写。
新站的正式发布源为 `docs/site/`；旧专题不会自动进入网页搜索、AI 索引或发布包。

## 为什么分开

部分旧文档记录特定机器的部署路径、较长的维护记录和历史架构判断。
例如旧结构评估中的“待实现”项，可能已经由后续源码落地。
将它们直接拼接成完整 AI 上下文，会让过时结论和当前行为混在一起。

这里的“旧”表示尚未按新站规范复核，不能推断每篇都已失效。

## 现有材料在哪里

| 仓库路径 | 可作为哪类材料的来源 |
| --- | --- |
| `docs/modules/` | 模块历史职责、实现入口与专题 |
| `docs/api-reference.md` | 接口发现线索 |
| `docs/fanhao-core-database.md` | 核心数据模型背景 |
| `docs/actor-profile-staged-publication.md` | 分阶段发布与恢复专题 |
| `docs/short-video-collections.md` | 短视频集合专题 |
| `docs/android-client.md` | Android 构建、更新与原生能力 |
| `docs/douyin-manager-release.md` | 下载管理器发布流程 |
| `docs/manga-library.md` | 漫画相关的近期工作 |

从本地仓库打开这些路径即可。新站不把旧文档链接包装成已核验的正式页面，也不复制真实运行样例。

## 将一个专题迁入新站

1. 确定单页要回答的问题，先阅读对应当前源码。
2. 提取仍然有效的契约和命令，删除个人路径、网络地址及运行数据。
3. 把设计提案、已实现行为、已验证证据分开写。
4. 添加标题、摘要、状态、核对日期和 `sources`。
5. 将新页加入 `docs/.vitepress/site.mjs` 的导航清单。
6. 运行文档构建并审阅生成的逐页 Markdown。

不需要为了迁移而删除原专题。确实需要改变公开 URL 时，应保留兼容入口并核对站内链接；
尚未实施重定向时，不宣称旧网址已经兼容。
