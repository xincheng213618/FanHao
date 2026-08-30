---
title: GitHub Pages 部署
description: 独立构建静态文档，PR 只校验，主分支部署，不启动媒体服务。
status: maintained
verified_at: 2026-08-30
sources:
  - .github/workflows/docs-pages.yml
  - docs/package.json
  - docs/.vitepress/config.mjs
  - docs/.vitepress/site.mjs
---

# GitHub Pages 部署

本方案只发布静态文档，不部署 Node.js 媒体服务、下载管理器、数据库或用户文件。
构建输出为 `docs/.vitepress/dist/`，文档依赖与主应用隔离。

## 先完成本地验证

~~~powershell
npm --prefix docs ci
npm --prefix docs test
npm --prefix docs run build
npm --prefix docs run preview
~~~

默认预览地址为 `http://127.0.0.1:4173/FanHao/`。
预览服务仅监听本机，检查完成后可以 Ctrl+C 停止；它不会启动 29998 或 8765。

## 首次启用 GitHub Pages

1. 将本次审核过的文档文件和工作流提交到仓库，并按你的流程推送。
2. 在 GitHub 仓库的 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
3. 合并到 `main`，或在 `main` 上手动运行 **Documentation** 工作流。
4. 查看部署 job 的实际 URL，核验首页、内容页、搜索和 `llms.txt`。

默认目标地址为 `https://xincheng213618.github.io/FanHao/`。
这是配置目标，不是“已经上线”的声明。工作流成功且实际网址可访问后，才算完成远程发布。

按 [VitePress 部署文档](https://vitepress.dev/guide/deploy)使用官方 Pages artifact 与 deploy action，
不需要提交生成的 HTML 到 `gh-pages` 分支。

## 工作流行为

| 事件 | 行为 |
| --- | --- |
| Pull request | 安装文档依赖、契约测试、构建和产物校验；不部署 |
| 推送到 main | 构建通过后部署到 GitHub Pages |
| 手动运行 main | 重新构建并部署 |
| 手动运行其他分支 | 仅构建，不覆盖正式站点 |

构建 job 只用 `contents: read`。
部署 job 单独申请 `pages: write`、`id-token: write`，并使用 `github-pages` 环境。
工作流不安装应用依赖、不运行应用、不复用现有安装包发布流程。
PR 不执行带写权限的 `pull_request_target`。

## 仓库重命名、fork 和自定义域名

工作流会从当前仓库名计算默认项目基址，用户/组织主页仓库使用 `/`。
可以通过仓库 Actions Variables 指定：

| 变量 | 例子 | 意义 |
| --- | --- | --- |
| `DOCS_BASE` | `/FanHao/` 或 `/` | 必须以斜杠开始、结束的站点路径 |
| `DOCS_ORIGIN` | `https://docs.example.org` | 只有协议和域名，不带路径 |

本地测试自定义域名根路径：

~~~powershell
$env:DOCS_BASE = '/'
$env:DOCS_ORIGIN = 'https://docs.example.org'
npm --prefix docs run build
npm --prefix docs run preview
# 完成后移除本次覆盖，下一次构建恢复默认地址
Remove-Item Env:DOCS_BASE -ErrorAction SilentlyContinue
Remove-Item Env:DOCS_ORIGIN -ErrorAction SilentlyContinue
~~~

自定义域名的 DNS 和 GitHub Pages 域名设置需要另外配置。
改变基址后必须重新构建，不能仅移动已有发布目录；HTML、Markdown 链接与索引都需要一致更新。
fork 后如要把“编辑此页”也指向自己的源码，更新 `docs/.vitepress/site.mjs` 的仓库 URL。

## 发布前检查

- 审阅 `git diff`，不把其他任务的修改混进文档提交。
- 检查逐页 Markdown 与完整导出没有私人路径、媒体清单或凭据。
- 确认发布包只有精选文档和站点资源。
- 检查部署完成状态及实际页面，不能仅用本地 build 成功替代远程验收。

如果仓库计划或组织策略不允许当前可见性下使用 Pages，需要先调整托管设置；
文档生成器无法绕过 GitHub 权限或计费限制。
