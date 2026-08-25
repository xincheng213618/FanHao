# 抖音下载管理器发布流程

仓库使用 GitHub Actions 在 Windows Runner 上构建并发布抖音下载管理器，工作流文件为
`.github/workflows/douyin-manager-release.yml`。

## 标签自动发布

推送符合 `douyin-manager-v*` 的版本标签会自动运行完整发布流程。例如：

```powershell
git tag douyin-manager-v0.4.1-test
git push origin douyin-manager-v0.4.1-test
```

标签版本必须采用 `主版本.次版本.修订版本`，并可带预发布后缀，例如
`0.4.1-test`。标签指向的提交就是安装包源码，工作流会验证标签没有指向其他提交。

## 页面手动运行

在 GitHub 仓库的 **Actions → Douyin Manager Release → Run workflow** 中输入不带标签前缀的
版本号。

- 默认不勾选“发布”：只完成测试和构建，安装包作为 Actions Artifact 保留 7 天，不创建标签或 Release。
- 勾选“发布”：测试成功后创建对应标签，并发布为 GitHub Pre-release。

建议先执行一次默认的安全试跑，确认云端环境能够稳定构建，再用标签触发正式发布。

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
