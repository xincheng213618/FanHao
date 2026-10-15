# 验证与诊断

这里集中存放原先混在 `tools/` 中的验证代码，不是运行缓存。文件分类如下：

| 文件 | 用途 |
| --- | --- |
| `run_verification.mjs` | 日常、按变更选择、完整与 Android 检查的统一调度 |
| `verify_*.mjs`、`verify_*.py`、`verify_*.ps1` | 行为、结构和回归验证 |
| `fixtures/` | 合成数据、旧行为对照、故障注入和 Java 测试宿主 |
| `diagnose_*.mjs` | 性能或页面诊断；运行前核对各自参数和数据来源 |
| `serve_android_*_fixture.mjs` | 手工查看 Android WebView 测试页面的本地服务 |
| `verification_advisories.mjs`、`verified-temp-cleanup.mjs` | 验证提醒与临时目录所有权/清理辅助代码 |

## 从仓库根目录运行

```powershell
npm run verify
npm run verify:changed -- --plan
npm run verify:full
```

npm 命令名保持不变，直接执行脚本时使用新路径。例如：

```powershell
node tests/verify_relative_imports.mjs
python tests/verify_novel_text_formatter.py
```

按模块选择已有命令：

| 模块 | 检查入口 |
| --- | --- |
| 番号与人物 | `verify:fanhao`、`verify:person-identity`、`verify:person-organization` |
| 图库与漫画 | `verify:image-library`、`verify:manga`、`verify:archive-images` |
| 小说 | `verify:novels`、`verify:novel-reader-browser` |
| 音乐 | `verify:music-scale`、`verify:music-progress` |
| 短视频与下载管理器 | `verify:short-video-store`、`verify:short-video-client`、`verify:douyin-manager` |
| Android | `verify:android-full` |
| 服务与公共结构 | `verify:startup`、`verify:modules`、`verify:imports` |

测试样本中的旧实现用于证明回归检测有效，不能只凭 `legacy`、`before-fix` 文件名判断它们已无用途。验证范围和环境要求见[验证矩阵](../docs/site/reference/verification.md)。
