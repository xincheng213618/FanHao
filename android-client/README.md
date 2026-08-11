# Android Client

这是个人视频资料库的安卓壳应用。第一版用 Capacitor 包一个轻量连接页，手机端输入电脑局域网地址后进入现有 `29998` 服务。

默认建议地址：

```text
http://192.168.31.86:29998
```

常用命令：

```powershell
npm install
npm run build:debug
npm run sync
npm run open
```

`npm run sync` 会先把仓库根目录 `public\games` 同步到 `www\games`，再执行 Capacitor 同步。`www\games` 是生成目录，不直接维护；小游戏只修改 `public\games` 中的源文件。

如果要直接安装到手机，需要本机有 Android SDK / platform-tools，并且手机已开启 USB 调试：

```powershell
npm run install:debug
npm run run:android
```

`build:debug` / `install:debug` 会优先使用 Android 自带的 OpenJDK 21，避开系统默认 JDK 26 触发的 Gradle `jlink` 构建问题。生成的 debug APK 在：

```text
android\app\build\outputs\apk\debug\app-debug.apk
```

## Gradle 网络代理

仓库中的 `android\gradle.properties` 必须保持为无代理的默认配置，不能写入 `localhost`、固定代理地址、端口或代理凭据；包括 bare 或带前缀的 `proxyHost`、`proxyPort`、`proxyUser`、`proxyPassword`、`proxyUrl`。这样干净构建不会隐式依赖某一台开发机。

需要代理的开发者只能将自己的配置放到用户级 `%USERPROFILE%\.gradle\gradle.properties`，例如仅在本机添加 `systemProp.http.proxyHost`、`systemProp.http.proxyPort` 及对应 HTTPS 项。也可以在一次命令中临时传入不含凭据的 JVM 属性，例如：

```powershell
.\android\gradlew.bat --% -p .\android --no-daemon -Dhttp.proxyHost=proxy.example.test -Dhttp.proxyPort=8080 -Dhttps.proxyHost=proxy.example.test -Dhttps.proxyPort=8080 help
```

`--%` 是 PowerShell 的停止解析记号，避免 `-Dhttp.proxyHost` 被 PowerShell 截断；该命令从 `android-client` 目录运行，`-p .\android` 显式指定 Gradle 项目目录。

不要把代理配置复制到仓库、脚本、提交信息或可共享的终端历史中；尤其不得提交 `proxyUser`、`proxyPassword`，或把用户名/密码嵌入代理 URL。需要认证代理时，请使用受本机保护的用户级配置或组织规定的凭据管理方式。

运行 `npm run verify:android-gradle-config` 会检查所有受版本控制的 Android Gradle 配置，阻止本机地址、固定 HTTP/HTTPS 代理以及代理凭据重新进入仓库。

当前壳应用只支持连接本机、局域网或可信私网中的服务，局域网 HTTP 明文能力仅用于这些受信网络。Android 客户端目前没有可用的远程登录或配对通道；不要通过手工复制 Web Cookie 的方式把远程访问当作受支持能力。后续若要开放远程访问，必须在客户端和服务端共同实现 HTTPS 与配对 / bearer token 认证。

## 模块加载结构

安卓壳不直接导入业务模块。服务端通过 `src\modules\<id>\module.js` 的 `client.android.entry` 暴露模块入口，安卓端读取 `/api/modules` 后，由 `www\js\android-module-registry.js` 动态加载：

```text
src/modules/<id>/module.js
  -> /api/modules
  -> android-module-registry.js
  -> www/modules/<id>/android-module.js
```

每个 `android-module.js` 导出 `createAndroidModule({ definition, host })`，返回以下契约：

- `routes`：模块拥有的页面及渲染函数。
- `rootViews` / `bottomKey`：根页面和底部导航归属。
- `search`：可选的模块搜索控制器，负责本模块搜索状态和提交行为。
- `renderChrome`：可选的模块顶部区域渲染函数；壳只提供空挂载点，标签、搜索入口、布局和是否显示均由模块决定。
- `handleBack` / `deactivate`：可选的返回键与离开模块生命周期。
- `api`：仅供组合壳调用的可选扩展，不参与模块间直接依赖。

模块代码只能引用自身目录或 `www\platform`、`www\js` 中的共享能力，不能导入其他业务模块内部文件。`npm run verify:modules` 会验证这个边界。

新增安卓模块时：

1. 创建 `www\modules\<id>\android-module.js`。
2. 在服务端 `src\modules\<id>\module.js` 中声明同路径 `client.android.entry`。
3. 在入口中注册路由、搜索行为；需要顶部控件时由模块实现 `renderChrome`。
4. 运行 `npm run verify:modules`、`npm run verify:imports` 和 `build-debug.ps1`。

未来拆成独立 App 时，可以复用同一个模块入口和 `www\platform`，替换为只加载单个模块的薄 Host；业务模块本身不需要重新接回总壳。
