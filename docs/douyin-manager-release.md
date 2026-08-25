# 抖音下载管理器发布流程

仓库使用 Release Please 管理版本号和更新日志，再由 GitHub Actions 在 Windows Runner 上
构建并发布抖音下载管理器。

## 推荐流程：合并 Release PR

日常提交合入 `main` 后，`.github/workflows/release-please.yml` 会根据 Conventional Commits
维护一个 Release PR。PR 中会自动更新：

- `.release-please-manifest.json` 和 `version.txt` 中的版本号；
- `CHANGELOG-douyin-manager.md` 中的更新说明；
- 即将创建的 `douyin-manager-v<版本号>` 标签和 GitHub Pre-release 信息。

提交标题建议使用：

- `fix: ...`：修复问题；
- `feat: ...`：新增功能；
- `feat!: ...` 或正文中的 `BREAKING CHANGE:`：不兼容变更；
- `docs:`、`test:`、`ci:`、`chore:` 等通常不会单独触发版本发布。

当前采用 `test` 预发布版本。例如在 `0.4.0-test` 之后有可发布改动时，Release Please 会先生成
类似 `0.4.0-test.1` 的版本。需要指定版本时，可在提交正文加入 `Release-As: 0.5.0-test`。

审核并合并 Release PR 后，Release Please 会先创建 Draft Release 和标签，然后直接调用
`.github/workflows/douyin-manager-release.yml`。只有 Windows 测试、打包及远端附件校验全部通过，
Draft 才会公开为 Pre-release。Release Please 使用仓库内置的 `GITHUB_TOKEN`，不需要个人令牌。

> 不要手动修改 Release PR 管理的版本号和更新日志；有新提交时机器人会自动刷新同一个 PR。

## 备用流程：标签自动发布

推送符合 `douyin-manager-v*` 的版本标签会自动运行完整发布流程。例如：

```powershell
git tag douyin-manager-v0.4.1-test
git push origin douyin-manager-v0.4.1-test
```

标签版本必须采用 `主版本.次版本.修订版本`，并可带预发布后缀，例如
`0.4.1-test`。标签指向的提交就是安装包源码，工作流会验证标签没有指向其他提交。

## 备用流程：页面手动运行

在 GitHub 仓库的 **Actions → Douyin Manager Release → Run workflow** 中输入不带标签前缀的
版本号。

- 默认不勾选“发布”：只完成测试和构建，安装包作为 Actions Artifact 保留 7 天，不创建标签或 Release。
- 勾选“发布”：测试成功后创建对应标签，并发布为 GitHub Pre-release。

建议使用默认的安全试跑检查云端环境。正式版本优先通过 Release PR 发布，手动标签和页面发布仅作为备用入口。

## 工作流保障

工作流会依次执行：

1. 安装锁定的 Node.js、Python 和打包依赖。
2. 运行管理器集成检查和完整 downloader 测试套件。
3. 使用 PyInstaller 与 Inno Setup 生成 Windows x64 安装包。
4. 运行登录助手、downloader sidecar、隔离数据库、共享播放器和退出接口 smoke test。
5. 独立复核安装包 SHA256 及 `.sha256` 文件。
6. 先上传到 Draft Release，核对 GitHub 返回的附件数量、大小和服务端摘要。
7. 校验通过后才公开为 Pre-release；同名已公开 Release 不会被覆盖。

手动试跑和标签发布使用 GitHub 自带的 `GITHUB_TOKEN`，工作流仅申请创建 Release 所需的
`contents: write` 权限，不需要配置个人访问令牌。

当前安装包没有数字签名，Windows 仍可能显示 SmartScreen 提示；自动发布不会改变这一点。
