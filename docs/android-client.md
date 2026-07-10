# 安卓客户端

`android-client/` 是一个基于 **Capacitor 8** 的工程，把 `public/` 的 Web 资源打包成安卓 App。
包名：`local.fanhao.library`，应用名：`个人视频资料库`。

## 目录结构

```
android-client/
├── capacitor.config.json   # Capacitor 配置（包名、允许导航的主机、混合内容）
├── package.json
├── build-debug.ps1         # 构建 debug APK（可选连真机安装）
├── publish-debug-update.ps1# 构建并把 APK 发布到更新通道目录
├── www/                    # 由 cap sync 同步进来的 Web 资源（来源于 public/）
└── android/                # 原生安卓工程（Gradle）
```

## 前置条件

- Node.js >= 24（用于 `cap sync` 与 Web 资源构建）。
- Android SDK，且 `adb` 在 `~/AppData/Local/Android/Sdk/platform-tools/` 下（安装脚本会自动探测）。
- JDK：脚本优先使用 `C:\Program Files\Android\openjdk\jdk-21.0.8`，依次回退到 Android Studio / PyCharm 自带的 JBR。
  若都不存在，Gradle 会用当前 `PATH` 中的 Java。

## 构建脚本：`build-debug.ps1`

常用参数：

| 参数 | 说明 |
| --- | --- |
| `-Install` | 构建完成后自动 `adb install -r` 到已授权的真机。 |
| `-NoSync` | 跳过 `cap sync android`（仅当 `www/` 已是最新时使用）。 |
| `-VersionCode <n>` | 覆盖 APK 的 versionCode（传给 Gradle `-PfanhaoVersionCode`）。 |
| `-VersionName <string>` | 覆盖 versionName（传给 Gradle `-PfanhaoVersionName`）。 |

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

## 网络与权限要点

`capacitor.config.json` 关键配置：

- `server.androidScheme: "http"` + `cleartext: true`：允许访问局域网的明文 HTTP 服务（`http://<电脑IP>:29998`）。
- `server.allowNavigation`：预置了若干局域网网段 / DDNS 主机（如 `192.168.*.*`、`172.*.*.*`、`10.*.*.*`、`xc213618.ddns.me`），
  客户端通过这些地址访问服务端时不会被 WebView 拦截。新增访问地址需在此补充。
- `android.allowMixedContent: true`：允许 WebView 中混合加载 HTTP / HTTPS 资源。
- `android.captureInput: true`：放开输入框捕获（避免某些 WebView 输入问题）。

> 调整 `allowNavigation` 后需重新 `cap sync android` 并重新构建，配置才会进原生层。

## 调试建议

- 真机调试：USB 调试授权后 `build-debug.ps1 -Install`，日志用 `adb logcat`。
- 改了 `public/` 的 Web 代码后，必须 `cap sync android`（即 `npm run sync`）再构建，原生层才会拿到新 `www/`。
- 改了 `android/` 原生代码（如权限、插件）则直接走 Android Studio 打开 `android/` 工程。
