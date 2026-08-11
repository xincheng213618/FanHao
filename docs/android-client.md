# 安卓客户端

`android-client/` 是一个基于 **Capacitor 8** 的工程，把独立维护的 `android-client/www/` Web 壳资源打包成安卓 App。
包名：`local.fanhao.library`，应用名：`个人视频资料库`。

## 目录结构

```
android-client/
├── capacitor.config.json   # Capacitor 配置（包名、本地 origin、混合内容）
├── package.json
├── version.json             # 受 Git 审阅的默认构建身份与发布最低高水位
├── build-debug.ps1         # 构建 debug APK（可选连真机安装）
├── publish-debug-update.ps1# 构建并把 APK 发布到更新通道目录
├── www/                    # Android 专用 Web 壳；仅 games/ 从根目录 public/games 同步
└── android/                # 原生安卓工程（Gradle）
```

## 前置条件

- Node.js >= 24（用于 `cap sync` 与 Web 资源构建）。
- Android SDK，且 `adb` 在 `~/AppData/Local/Android/Sdk/platform-tools/` 下（安装脚本会自动探测）。
- JDK 21：脚本会检查 `C:\Program Files\Android\openjdk\jdk-21.0.8`、`JAVA_HOME` 和 Android Studio JBR；找不到 major version 21 时直接失败，不会回退到其他 Java 版本。

## 构建脚本：`build-debug.ps1`

常用参数：

| 参数 | 说明 |
| --- | --- |
| `-Install` | 构建完成后自动 `adb install -r` 到已授权的真机。 |
| `-NoSync` | 跳过 `cap sync android`（仅当 `www/` 已是最新时使用）。 |
| `-VersionCode <n>` | 覆盖 APK 的 versionCode（传给 Gradle `-PfanhaoVersionCode`）。 |
| `-VersionName <string>` | 覆盖 versionName（传给 Gradle `-PfanhaoVersionName`）。 |
| `-LocalOnly` | 仅允许 `100000000..2100000000` 的非发布构建；脚本向 Gradle 传专用 `fanhaoLocalOnly=true` gate，并在身份回读后写入同 APK 绑定的 local-only 标记；不能与 `-Install` 同用，也不能进入发布脚本。 |

普通 debug 构建只接受 `1..99999999`，保留 Android versionCode 的恢复空间；`versionName` 会先 trim，空白值在 Gradle 启动前失败。构建完成后脚本用 SDK `aapt` 与 `apksigner` 回读包名、版本和完整 signer 数量，且只接受既有 debug 更新证书。

Gradle、Android Studio、`cap run` 与 `FANHAO_VERSION_CODE` 也受同一 namespace gate：未显式进入 local-only 路径时最多只能构建 `99999999`。高段必须同时携带专用 Gradle property；`packageDebug` 开始前先在不会被 APK 输出清理覆盖的位置原子写 fail-closed guard，成功产出 APK 后再写 pending sidecar。`build-debug.ps1 -LocalOnly` 最后用 APK 大小、SHA 与 signer 绑定的完整 marker 原子替换 pending，并清除 guard；普通构建只在成功后清除两者，因此失败或中断不会把高段输出误当成可发布产物。

无参数 `npm run build:debug` 与 `npm run install:debug` 都从 tracked 的 `android-client/version.json` 读取默认身份；当前固定为 `26081190 / 0.1.26081190-debug`。因此安装脚本不会再意外生成 `1 / 1.0`；`install:debug` 只允许 contract 当前的 code/name，显式传入更高或不同身份会在 JDK、Gradle 和 ADB 之前失败，必须先通过受审阅提交提高 `version.json`。身份通过后，脚本仍只在 ADB 存在已授权设备时执行 `adb install -r`。

普通、仅构建的显式 `-VersionCode` / `-VersionName` 仍可用于边界内的临时验证，但不会修改 contract，也不会推进 publish floor。直接绕过脚本手工执行 `adb install` 无法受此 gate 保护，可能把设备推进到未记录版本，属于需要人工避免的剩余操作风险。

典型流程：

```powershell
cd android-client

# 1) 同步 Web 资源 + 构建 debug APK
powershell -ExecutionPolicy Bypass -File ./build-debug.ps1

# 2) 构建并直接安装到手机
powershell -ExecutionPolicy Bypass -File ./build-debug.ps1 -Install
```

等价 npm 脚本（定义在 `android-client/package.json`）：

```powershell
npm run sync             # cap sync android
npm run build:debug      # 构建 debug APK
npm run install:debug    # 构建并安装
npm run open             # 用 Android Studio 打开原生工程
npm run run:android      # 直接跑起来
```

根目录 `npm run verify` 中的 Android security lane 是自包含的：root hook 会按 lockfile（含 devDependencies）安装 `android-client` 依赖，security verifier 随后在系统临时目录复制原生工程、链接本地 lock-pinned Capacitor 依赖并执行 `cap sync android`，确认 Cordova Gradle bridge 后才运行 Gradle fixtures。clean checkout 只需先执行根目录 `npm ci`；真实工作树不依赖人工 sync，也不会被 verifier 的同步、并发或中断改写。

产物位置：`android-client/android/app/build/outputs/apk/debug/app-debug.apk`。

## 自动更新通道

服务端提供 `/api/android/update` 清单与 `/api/android/update/apk/:channel/:file` 下载，
客户端在应用内检查更新并从该通道拉取 APK，无需走应用商店。

`publish-debug-update.ps1` 负责把构建好的 APK 放到 `data/android-update/`（服务端从该目录读取清单与文件），
配合 `src/modules/system/server/android-update/service.js` 对外提供更新服务。

发布脚本会从 tracked 的 `android-client/version.json` 高水位，以及 debug/release 的受验证 `latest.json` 和两个通道内全部规范 APK，取全局最高 versionCode；当前 contract floor 是 `26081190`，所以即使发布根只有 `26073102`，自动计划也从 `26081191` 开始。`app-debug.apk` 是可缺失、陈旧、损坏或 local-only 的临时构建输出，永远不参与历史高水位。自动值和显式值都必须严格递增且不超过 `99999999`。旧清单只有在同时缺少 `packageName`/`signerSha256`、其余字段完整，并且所指 APK 的大小、SHA、版本、包名和单 signer 全部实测一致时才兼容读取；新清单始终写全身份字段。

发布成功后的版本化 APK 与 `latest.json` 会自然成为后续计划的持久历史；发布脚本不会修改源码 contract。`version.json` 是在发布历史缺失或迁移时仍然生效的最低基线，只能通过单独、受审阅的 Git 变更同时提高 `currentVersionCode`、`highWaterVersionCode` 和对应默认名称，不得下降。

因为自动发布候选必然高于当前 contract，`publish-debug-update.ps1 -Install` 已明确废弃并会在 JDK、Gradle 与 ADB 之前拒绝，避免把设备推进到尚未受审阅记录的身份。真实发布会在构建前和原子提交前两次确认同一组已授权 ADB 设备仍然可见，任一时点不可见或发生变化都拒绝发布，但发布命令本身不会安装 APK。发布后应由应用内更新链安装 `latest.json` 当前 APK，或只对已发布 APK 做独立的 aapt/apksigner/manifest 验证；本批不加入隐式安装旁路。若后续确需命令行安装便利，应另行设计“发布成功后安装 manifest 当前 APK”的受验证流程。

APK 与清单先写入发布目录内的临时文件并完成回读验证，新版本 APK 使用不可覆盖的版本化文件名，`latest.json` 最后原子替换。下载端只提供当前 `latest.json` 精确引用的 APK，失败或中断产生的非当前文件不能经更新接口下载。

当前仓库只收口了 debug 签名发布链。release Gradle 产物没有稳定 signingConfig，因此未签名 release APK 不得发布或用于覆盖安装。

## 网络与权限要点

`capacitor.config.json` 关键配置：

- `server.androidScheme: "http"`：保留已发布版本使用的 `http://localhost` WebView origin。不要在没有数据迁移方案时改成 `https`，否则 Web Storage / IndexedDB 会切换 origin，已有本地小说和设置会表现为不可见。
- `server.cleartext: true` 与 `android.allowMixedContent: true`：仅为访问本机、局域网或可信私网内的 HTTP API / 媒体保留。
- 未配置 `server.allowNavigation`：远程页面不能在应用 WebView 内导航，因而不能获得 Capacitor 原生桥权限；外部页面应交给系统浏览器处理。
- `android.captureInput: true`：放开输入框捕获（避免某些 WebView 输入问题）。

当前 Android 客户端仅支持本机、局域网或可信私网服务，没有可用的远程登录或配对通道。不要通过手工复制浏览器 / App Cookie 的方式证明远程访问可用；未来远程能力必须同时提供 HTTPS 与正式的配对 / bearer token 流程。

> 调整 `capacitor.config.json` 后需重新 `cap sync android` 并重新构建，配置才会进原生层。

## 调试建议

- 真机调试：USB 调试授权后 `build-debug.ps1 -Install`，日志用 `adb logcat`。
- 改了 `android-client/www/` 的 Web 代码后，必须 `cap sync android`（即 `npm run sync`）再构建，原生层才会拿到新资源；小游戏源文件只修改根目录 `public/games/`，同步脚本会将其复制到 `android-client/www/games/`。
- 改了 `android/` 原生代码（如权限、插件）则直接走 Android Studio 打开 `android/` 工程。
