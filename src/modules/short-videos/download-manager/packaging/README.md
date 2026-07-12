# 抖音下载管理器 Windows 打包

仓库根目录执行：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tools\build_douyin_manager_installer.ps1
```

指定版本和输出目录：

```powershell
.\tools\build_douyin_manager_installer.ps1 `
  -Version "0.2.0-test" `
  -OutputDirectory "$HOME\Desktop\DouyinDownloadManager-Package"
```

## 构建内容

1. 用 PyInstaller 构建无控制台的管理器 EXE，并打入静态页面、采集脚本、登录助手和 `playwright-core`。
2. 用独立入口构建 `douyin-downloader` sidecar，包含 Python 运行时、下载依赖和 `imageio-ffmpeg`。
3. 复制当前 Node.js 可执行文件，采集与 Edge 登录继续使用系统 Edge/Chrome，不额外打入 Chromium。
4. 扫描组装目录，拒绝包含 SQLite、视频、正式 Cookie 或生成的 `.cookies.json`。
5. 在随机隔离端口启动组装后的管理器，检查 `/api/state`、设置页面、登录助手和下载器命令。
6. 使用 Inno Setup 生成单个安装 EXE，并生成对应的 `.sha256` 文件。

## 本机依赖

- Windows 10/11 x64
- Python 与 PyInstaller
- Node.js
- Inno Setup 6
- `Desktop\Tool\douyin-downloader`，或通过 `-DownloaderRoot` 指定下载器仓库
- 下载器虚拟环境 `.venv`，用于提供打包时的 Python 依赖

安装后的数据库和日志位于 `%LOCALAPPDATA%\DouyinDownloadManager`。构建过程不会复制开发电脑上的 Cookie、数据库、日志或视频。
