# 文档子系统约定

本文件补充根 `AGENTS.md`。文档站以简体中文维护；写作规范见 `site/contributing/documentation.md`。

- 只在 `site/` 编写正式公开正文，其他旧文档逐篇核对、脱敏后迁入，不自动全量发布。
- 每页填写 `title`、`description`、`status`、`verified_at`、`sources`。核对日期不能由构建自动刷新。
- 新页加入 `.vitepress/site.mjs`，保持一份导航来源；内部链接使用相对 `.md` 路径。
- 来源指向实际代码或验证脚本，不把历史计划写成当前实现。
- 禁止加入真实密码、Cookie、Token、个人路径、局域网地址、媒体列表、数据库或日志。
- 不手工编辑 `.vitepress/generated/`、`.vitepress/dist/` 或缓存。
- 文档依赖独立放在 `docs/package.json`，不为文档修改根应用依赖或触发业务启动。
- 完成后运行 `npm --prefix docs test` 和 `npm --prefix docs run build`；主题修改还需要浏览器验证。
- 构建成功不代表已上线。部署遵循用户授权，报告实际 GitHub 工作流与页面证据。
