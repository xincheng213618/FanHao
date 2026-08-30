---
title: 验证矩阵
description: 按变更范围选择真实 package 脚本，明确依赖、临时写入和运行验收的区别。
status: maintained
verified_at: 2026-08-30
sources:
  - package.json
  - android-client/package.json
  - tools/verify_fanhao_startup.mjs
  - tools/verify_fanhao_startup.ps1
  - tools/verify_browser_behavior.mjs
  - tools/verify_short_video_watch_write.mjs
  - tools/verify_short_video_delete_jobs.mjs
  - tools/verify_work_move_jobs.mjs
  - tools/verify_native_short_video_actions.mjs
  - tools/verify_native_short_video_paging.mjs
  - tools/build_short_video_web.mjs
---

# 验证矩阵

这里列出的应用命令来自根目录 `package.json`，不是新增的命令接口。
根据改动选择最小相关验证，再决定是否执行完整门禁。
本页说明检查的用途与副作用，不表示它们在当前机器或当前提交上都已通过。

## 安装与查看实际脚本

```powershell
npm ci
npm run
```

安装会访问包源并写入 `node_modules/`；锁文件与 Node 版本应与仓库要求一致。
测试常会创建并清理临时 SQLite、媒体 fixture、Worker 或本机监听端口；“验证”不等于所有步骤只读。
首次运行陌生脚本前检查其入口、环境变量与清理范围，尤其不要把 fixture 的路径替换为真实媒体目录。

## 文档门禁

```powershell
npm --prefix docs ci
npm --prefix docs run check
npm --prefix docs run build
```

文档依赖独立安装。检查页面约束与站点构建不需要启动 `server.js`、下载器、Android 或任何采集作业。
写作约束见[文档规范](../contributing/documentation.md)。

## 按改动选择应用检查

| 命令 | 检查内容 | 执行边界 |
| --- | --- | --- |
| `npm run verify:repo-hygiene` | Git 跟踪文件中的禁止产物、运行状态与文本异常。 | 读取 Git 清单和源码，不是秘密扫描器。 |
| `npm run verify:modules` | 模块结构与职责约束。 | 结构检查，不能替代真实调用验证。 |
| `npm run verify:imports` | 相对导入引用。 | 源码引用检查，不启动应用。 |
| `npm run verify:auth` | 来源识别、登录与会话等鉴权规则。 | 使用临时鉴权状态文件，并清理临时目录。 |
| `npm run verify:mutation-auth` | 写接口权限与 API 错误边界。 | 同时调用 mutation 与 error-boundary 检查。 |
| `npm run verify:settings` | 模块和应用设置契约。 | 会生成并清理临时模块 fixture。 |
| `npm run verify:short-video-build` | bundle 字节与 HTML 版本引用是否一致。 | esbuild 内存构建并比较；`--check` 不写产物。 |
| `npm run verify:short-video-client` | Web/原生短视频结构、分页、请求与动作契约；具体子检查以 package 脚本为准。 | 包含源码检查及 `javac` 编译、`java` 执行的 fixture；会写入并清理临时类文件，另需下述 JDK/Android 依赖。 |
| `npm run verify:short-video-watch-write` | SQLite 竞争、提交回执、超时与停止恢复。 | 临时 SQLite、真实 Worker 与故障 fixture。 |
| `npm run verify:short-video-delete-jobs` | 删除恢复与幂等协议。 | 临时文件/数据库、进程和 Worker；会在 fixture 内移动或删除文件。 |
| `npm run verify:short-video-runtime` | 运行队列与生命周期。 | 创建临时媒体、缓存与数据库，结束后清理。 |
| `npm run verify:work-move-jobs` | 作品移动作业与操作 UI 契约。 | 包含临时文件移动、SQLite 和 Worker，不是实际资料迁移命令。 |
| `npm run verify:music-rescan-worker` | 音乐扫描 Worker、锁竞争与停止流程。 | 临时音乐文件、数据库、假探测器与子进程。 |
| `npm run verify:browser-behavior` | 浏览器中的页面行为、导航与异步状态。 | 默认本机临时 HTTP fixture，并启动无头 Chrome/Edge。 |
| `npm run verify:startup` | 启动器健康、超时、占用与失败边界。 | 临时启动器/假服务与动态端口，要求 PowerShell 运行时。 |

更多资料解析、图库、小说、访问分析、游戏与性能脚本由 `npm run` 列出。
例如 `verify:image-library`、`verify:novels`、`verify:core-images` 都包含多个子检查；运行前查看整个脚本链。
一个脚本的成功不能覆盖同模块所有未执行的门禁。

## 浏览器验证的特殊条件

默认不设置 `FANHAO_BROWSER_TEST_BASE_URL` 时，验证器自行启动 `127.0.0.1` 临时服务，端口默认动态分配。
如果设置了该变量，验证器将访问指定服务，而页面交互可能发起写请求。
不要把它指向现有资料库来“借用环境”。

浏览器由 `CHROME_PATH` 或验证器中的 Chrome/Edge 候选路径定位；`playwright-core` 不会自动提供浏览器二进制。
无法启动浏览器应报告环境缺失，不能把未执行的交互测试记为通过。

## 启动与 Android 验证的特殊条件

`verify:startup` 在 Windows 下要求 `powershell.exe` 和 `pwsh.exe` 都执行成功；不是任选其一。
其 PowerShell fixture 拷贝启动器到临时目录、生成假服务并使用动态端口，不依赖正式的 `29998` 或 `8765`。
安装缺失运行时后再重跑，不要用正式服务替代 fixture。

原生客户端门禁还会在宿主 JVM 中编译并运行 Java fixture，不能归为纯源码检查：

- 准备包含 `javac` 与 `java` 的 JDK，按脚本的定位规则设置 `JAVA_HOME`；不同验证器的默认路径和 PATH 回退并不相同。
- 短视频 actions 验证需要本地 Android platform 的 `android.jar`，可通过 `ANDROID_HOME` 或 `ANDROID_SDK_ROOT` 定位 SDK。
- 短视频 actions 验证需要 Gradle 缓存中的 `org.json:json` JAR；缓存根由 `GRADLE_USER_HOME` 或用户目录下的 `.gradle` 决定。该 fixture 不自动下载缺失 JAR。
- 执行会创建并清理临时目录与编译产物，部分 fixture 会写入测试状态或使用本机 HTTP 服务。它们不构建 APK，也不替代 Android 真机验收。

| 命令 | 注意事项 |
| --- | --- |
| `npm run verify:android-security` | npm 会先运行 `preverify:android-security`，在 Android 目录执行 `ci --include=dev --ignore-scripts --no-audit --no-fund`；需要包源访问并改写其依赖目录。 |
| `npm run verify:android-gradle-config` | 调用 Android 工程自己的 Gradle 配置检查。 |
| `npm run verify:short-video-client` | 已提交的短视频客户端检查入口；包含上述原生 JVM fixture，但不覆盖整个 Android 应用。 |

开发工作区可能额外提供 `verify:android-client` 聚合脚本；先用 `npm run` 查看当前 `package.json`，不要假定干净克隆已包含它。
若该脚本存在，继续核对它引用的每个验证器、JDK/SDK 依赖和临时写入范围；不能将它视为纯源码检查。
稳定的基础入口是上表的安全、Gradle 配置和短视频客户端检查，但这些入口合在一起也不等于完整 Android 验收。

不要把 `install:debug`、`publish:debug` 等发布/安装脚本混进普通检查。
它们的写入对象与授权要求不同，见[开发流程](../guide/development.md)。

## 完整应用门禁

```powershell
npm run verify
```

该命令按 `package.json` 中的顺序串行执行大量验证，前项失败会阻止后续项执行。
除 Node 依赖外，还包括 Python 检查、Android npm 依赖安装、浏览器、PowerShell 及 Java fixture；须具备 JDK、上述 Android platform 与 Gradle JAR 缓存。
部分 Python 检查依赖第三方包，例如 `verify:javdb-card-facts` 使用 `bs4`；不能只装根目录 npm 依赖就承诺完整门禁可运行。
按失败脚本的导入与所属工具要求补齐环境，不要为了让总命令变绿而跳过门禁。

## 如何报告结果

每次交付记录检查对象、命令、结果、未执行原因和环境条件。
例如：“文档 check/build 通过；未启动应用；未运行 Android 和真实资料库验收。”
如果总门禁中断，列出首个失败项及尚未执行的范围，不能说“其余全部通过”。
性能结论还需数据规模、测量条件与重复结果；一次计时不是通用基准。
线上或本机现有服务的验收另行记录，不能由源码 fixture 推导其已部署状态。
