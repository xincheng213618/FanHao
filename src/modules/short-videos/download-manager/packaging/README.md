# 抖音下载管理器 Windows 打包

仓库根目录执行：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tools\build_douyin_manager_installer.ps1
```

指定版本和输出目录：

```powershell
.\tools\build_douyin_manager_installer.ps1 `
  -Version "0.3.1-test" `
  -OutputDirectory "$HOME\Desktop\DouyinDownloadManager-Package"
```

## 构建内容

1. 用 PyInstaller 构建无控制台的管理器 EXE，并打入管理页面、FanHao 共享短视频播放器、采集脚本、登录助手和 `playwright-core`；启动后由系统默认浏览器显示界面。
2. 从当前模块的 `downloader/` 内嵌源码构建 `douyin-downloader` sidecar，包含 Python 运行时、下载依赖和 `imageio-ffmpeg`。
3. 复制当前 Node.js 可执行文件，采集与 Edge 登录继续使用系统 Edge/Chrome，不额外打入 Chromium。
4. 保留下载器 MIT 许可证、Apache 2.0 全文和第三方声明，并扫描组装目录，拒绝包含 SQLite、视频、日志、本地配置、正式 Cookie 或生成的 `.cookies.json`。
5. 在随机隔离端口以无窗口测试模式启动组装后的管理器，检查 `/api/state`、已下载页面、共享播放器资源、登录助手和下载器命令。
6. 使用 Inno Setup 生成单个安装 EXE，并生成对应的 `.sha256` 文件。

## 本机依赖

- Windows 10/11 x64
- Python、PyInstaller，以及 `packaging\requirements-build.txt` 中的构建依赖
- Node.js
- Inno Setup 6
- 当前模块内嵌的 `downloader/` 源码；需要测试替代版本时仍可通过 `-DownloaderRoot` 覆盖
- 内嵌下载器的独立虚拟环境 `downloader\.venv`，构建脚本会通过 `setup-downloader.ps1` 自动创建或更新

首次构建前，在仓库根目录执行：

```powershell
python -m pip install -r .\src\modules\short-videos\download-manager\packaging\requirements-build.txt
```

之后直接运行构建脚本即可；它会校验内嵌源码并按 `pyproject.toml` 的 `server` 扩展准备隔离环境。

`-DownloaderRoot` 仅覆盖本次构建使用的源码根目录，不会改写模块默认运行路径；覆盖目录也必须包含
`pyproject.toml`、`LICENSE` 与完整 Python 包，并允许构建脚本在其中创建或更新 `.venv`。

安装后会在系统默认浏览器中打开管理页面；点击页面右上角“退出程序”可结束后台服务。“已下载”页读取下载目录中的本地作品，点开后复用 FanHao 网页端的短视频播放器。数据库和日志位于 `%LOCALAPPDATA%\DouyinDownloadManager`。构建过程不会复制开发电脑上的 Cookie、数据库、日志或视频。
