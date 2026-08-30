---
title: 文档维护规范
description: 用源码依据、简短主题和自动校验维护同一份人类与 AI 可读知识。
status: maintained
verified_at: 2026-08-30
sources:
  - docs/package.json
  - docs/.vitepress/site.mjs
  - docs/.vitepress/scripts/check.mjs
  - docs/.vitepress/scripts/generate.mjs
  - docs/.vitepress/scripts/check-dist.mjs
---

# 文档维护规范

文档与代码一起维护。一页回答一个明确问题，正文优先陈述可核对的事实，
不要把计划写成已经实现，也不要把某次测试成功写成永久保证。

## 三层结构

| 层 | 位置 | 用途 |
| --- | --- | --- |
| 协作指引 | 根 `AGENTS.md`、`docs/AGENTS.md` | 项目约定与任务边界 |
| 正式文档 | `docs/site/` | 人阅读和 AI 检索共同使用的单一正文 |
| 构建产物 | `docs/.vitepress/dist/` | HTML、逐页 Markdown 和机器索引；禁止手工编辑 |

既有 `docs/*.md` 保留为仓库专题，迁移流程见[旧文档与迁移](../reference/legacy.md)。
文档依赖放在独立的 `docs/package.json`，不改变业务应用依赖。

## 每页必填元数据

~~~yaml
---
title: 清晰的主题标题
description: 一句话说明页面解决什么问题。
status: maintained
verified_at: 2026-08-30
sources:
  - src/fanhao/module-registry.js
  - package.json
---
~~~

- `sources` 使用真实存在的仓库相对路径，定位最相关的实现和验证入口；不填写本机绝对路径。
- `verified_at` 只在重新阅读来源并核对内容后更新，构建器不会自动刷新它。
- `status` 表示维护状态；当前发布清单只接收 `maintained`。
- 元数据不是运行验证报告。若报告测试，要写清命令、环境和适用范围。

## 内容约定

1. 标题和开头说明结论，正文用职责、入口、约束、验证组织内容。
2. 每页一个 H1；超过 180 行正文时拆分主题，不压缩空行来绕过限制。
3. 内部链接使用相对 `.md` 路径，保持 GitHub 源码阅读和站点阅读都可用。
4. 命令以 PowerShell 编写，涉及写盘、服务或数据库时先标出副作用。
5. 不嵌入 Vue 组件承载核心知识，保证导出 Markdown 含有完整信息。
6. 接口说明按[契约模板](../reference/api.md)核对，术语与源码保持一致。

本项目未声明已有完整 OpenAPI，也不要求为文档添加聊天后端、向量数据库或模型密钥。

## 新增页面的流程

~~~powershell
npm --prefix docs ci
# 在 docs/site 对应分类内写 Markdown，并更新 .vitepress/site.mjs 导航
npm --prefix docs run check
npm --prefix docs test
npm --prefix docs run build
npm --prefix docs run preview
~~~

`site.mjs` 是唯一页面导航清单，驱动侧栏和所有 AI 导出。
没有在清单中的文件会被校验拒绝；不使用全仓库递归收集来扩大发布范围。
新增文件后，重新启动开发服务器以重新生成导航和 Markdown 导出。
已有正文的编辑会自动刷新 Markdown 和机器索引；源检查失败时终端会报错，修正后再次保存即可重新生成。

## 构建会检查什么

| 阶段 | 失败条件 |
| --- | --- |
| 源码文档检查 | 缺元数据、来源不存在、导航重复/遗漏、坏链接、未知 verify 命令、常见私密模式 |
| VitePress 构建 | Markdown 或 Vue 渲染错误、无法解析的站内链接 |
| 产物检查 | HTML 链接/锚点错误、基址越界、页面或索引遗漏、Markdown 导出不一致、未知发布文件 |
| 契约测试 | 部署基址与链接解析、防漏模式、索引切分等回归 |

检查器不会判断所有文字语义、外部页面状态、来源文件行为是否变化或所有敏感内容。
修改代码后主动检查关联文档；源码路径仍存在并不意味着说明仍正确。

## 机器可读格式

构建会生成 `llms.txt`、`llms-full.txt`、`ai-context.json`、`search-index.json` 和每页 `.md`。
HTML 使用 `rel="alternate" type="text/markdown"` 与 `rel="describedby"` 暴露入口。
结构化索引以 `schema_version` 标识格式，兼容性变化时同步修改生成器、检查器与本页。

采用 [AGENTS.md 开放格式](https://agents.md/)与 [llms.txt 提案](https://llmstxt.org/)；
核对日期、来源元数据和 JSON 索引属于 FanHao 的维护约定。
