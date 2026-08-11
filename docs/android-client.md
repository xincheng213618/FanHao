# 安卓客户端

`android-client/` 是一个基于 **Capacitor 8** 的工程，把独立维护的 `android-client/www/` Web 壳资源打包成安卓 App。
包名：`local.fanhao.library`，应用名：`个人视频资料库`。

## 目录结构

```
android-client/
├── capacitor.config.json   # Capacitor 配置（包名、本地 origin、混合内容）
├── package.json
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
| `-LocalOnly` | 仅允许 `100000000..2100000000` 的非发布构建，写入同 APK 绑定的 local-only 标记；不能与 `-Install` 同用，也不能进入发布脚本。 |

普通 debug 构建只接受 `1..99999999`，保留 Android versionCode 的恢复空间；`versionName` 会先 trim，空白值在 Gradle 启动前失败。构建完成后脚本用 SDK `aapt` 与 `apksigner` 回读包名、版本和完整 signer 数量，且只接受既有 debug 更新证书。

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

产物位置：`android-client/android/app/build/outputs/apk/debug/app-debug.apk`。

## 自动更新通道

服务端提供 `/api/android/update` 清单与 `/api/android/update/apk/:channel/:file` 下载，
客户端在应用内检查更新并从该通道拉取 APK，无需走应用商店。

`publish-debug-update.ps1` 负责把构建好的 APK 放到 `data/android-update/`（服务端从该目录读取清单与文件），
配合 `src/modules/system/server/android-update/service.js` 对外提供更新服务。

发布脚本会从 debug/release 的受验证 `latest.json`、两个通道内全部规范 APK，以及当前 `app-debug.apk` 取全局最高 versionCode；自动值和显式值都必须严格递增且不超过 `99999999`。旧清单只有在同时缺少 `packageName`/`signerSha256`、其余字段完整，并且所指 APK 的大小、SHA、版本、包名和单 signer 全部实测一致时才兼容读取；新清单始终写全身份字段。

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
