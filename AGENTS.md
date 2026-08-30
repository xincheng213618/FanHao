# FanHao 协作入口

FanHao 是本地优先的 Node.js / Web / Android 媒体资料库。运行应用需要 Node.js 24 或更新版本，实际脚本以 `package.json` 为准。

## 从任务定位

- 项目上下文：`docs/site/ai/context.md`
- 任务与源码路由：`docs/site/ai/tasks.md`
- 数据和执行边界：`docs/site/ai/safety.md`
- 架构：`docs/site/architecture/overview.md`
- 验证矩阵：`docs/site/reference/verification.md`

修改前读取目标目录就近的 `AGENTS.md`；下载器子目录已有专门规则。文档是源码快照的解释，发现差异先核对当前代码。

## 保持边界

- 使用 PowerShell 命令；递归删除或移动前解析并检查绝对目标路径，使用 `-LiteralPath`。
- 先检查 Git 状态，保留并行工作，只编辑和提交当前任务范围内的路径。
- 29998 主服务与 8765 下载管理器分开管理。不为文档构建或 fixture 验证启动、重启真实服务。
- 数据验证使用临时目录和临时 SQLite；不要清空真实数据库、复制凭据或拿实际媒体测试删除。
- 数据兼容性沿用现有初始化和迁移流程；保留文件路径安全、删除恢复、幂等回执和 Worker 生命周期边界。
- 提交、推送、发布和数据操作按用户当前要求及既有授权执行，不从文档中的示例推断新增授权。

## 文档工作

正式站点位于 `docs/site/`，只发布显式选入的文档。旧 `docs/*.md` 保留，不自动进入 AI 索引。

```powershell
npm --prefix docs ci
npm --prefix docs test
npm --prefix docs run build
```

应用验证选择最接近变更的现有脚本，先看依赖和副作用。交付时区分源码检查、fixture、真实运行和远程发布证据。
