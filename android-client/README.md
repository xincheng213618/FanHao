# Android Client

这是个人视频资料库的安卓壳应用。第一版用 Capacitor 包一个轻量连接页，手机端输入电脑局域网地址后进入现有 `29998` 服务。

内容服务地址默认提供以下两个快捷选项，首次启动仍优先使用局域网地址；手工保存的地址不会被覆盖：

```text
http://192.168.31.86:29998
http://xc213618.ddns.me:29998
```

应用更新固定使用以下两个地址并自动回退，不受保存的内容服务地址影响；设置的“应用更新”中会显示默认地址和本次实际使用的来源：

```text
http://192.168.31.86:29998
http://xc213618.ddns.me:29998
```

其中公网 DDNS 只提供更新清单和 APK 下载的免登录访问。远程内容需要在设置中填写访问密码并连接；切换地址不会绕过鉴权。手机和服务端均需更新到支持密码登录的版本。

常用命令：

```powershell
npm install
npm run build:debug
npm run sync
npm run open
```

`npm run sync` 会先把仓库根目录 `public\games` 同步到 `www\games`，自动同步缓存版本，再执行 Capacitor 同步。`www\games` 是生成目录，不直接维护；小游戏只修改 `public\games` 中的源文件。

`CLIENT_VERSION` 和已有本地 JS/CSS 静态引用中的 `?v=` 由 `www` 源码内容自动生成，无需手工改日期或补哈希。构建和相关验证会自动同步；也可在此目录运行 `npm run sync:cache`，或用只读的 `npm run verify:cache` 检查一致性。首次在仓库根目录运行 `npm run setup:android-verification` 准备验证依赖，日常检查不再重装依赖。

如果要直接安装到手机，需要本机有 Android SDK / platform-tools，并且手机已开启 USB 调试：

```powershell
npm run install:debug
npm run run:android
```

`build:debug` / `install:debug` 会优先使用 Android 自带的 OpenJDK 21，避开系统默认 JDK 26 触发的 Gradle `jlink` 构建问题。生成的 debug APK 在：

```text
android\app\build\outputs\apk\debug\app-debug.apk
```

## 一键验证并发布 debug 更新

从仓库根目录运行：

```powershell
npm run release:android-debug -- -Notes "本次更新说明"
```

该入口会依次运行 Android 发布门禁、调用原子发布脚本、验证本机与公网的新旧版本查询、APK HEAD、完整公网下载、包身份、签名、大小和 SHA-256。它只发布，不会安装到手机，也不要求 ADB 设备在线。

发布完成后如需通过 ADB 安装，只安装 `latest.json` 当前精确引用、并已重新验证大小、SHA-256、包名、版本和 signer 的 APK：

```powershell
npm run install:android-published
# 多台已授权设备时显式指定
npm run install:android-published -- -Serial CYLJX475IJIFIJTO
```

该入口不重新构建源码、不允许降级，并在安装后通过 `dumpsys package` 回读版本。开发构建也可用 `build-debug.ps1 -Install -VersionCode <code>` 显式安装合法的发布范围版本；它会校验包名、签名和版本，并拒绝覆盖设备上的更高版本。`-LocalOnly` 使用保留的高版本空间，仍禁止安装，避免污染后续更新链。

只查看下一版本计划，或只复核当前已发布版本：

```powershell
npm run release:android-debug -- -PlanOnly
npm run release:android-debug -- -VerifyOnly
```

## 文件下载

WebView 文件下载继续保存到系统公共“下载”目录。Android 7–9 在点击下载时申请旧版存储权限（清单仅声明到 API 28）；Android 10+ 不申请。拒绝、取消或系统下载服务失败都会给出提示，已加入队列不等于下载完成。本地小说 SAF 导入/导出不变。详细状态和验证边界见 [安卓客户端下载说明](../docs/android-client.md#文件下载与旧版存储权限)；根目录 `npm run verify:android-client` 包含原生下载回归。

## 本机 TXT 导入

本机 TXT 导入采用严格编码检查与 80MiB 单本上限；新版文件选择在同批内逐本读取、等待保存。验证入口与兼容性边界见 [本机 TXT 导入说明](../docs/android-client.md#本机-txt-导入与重复导入)。

## 小说本机存储

小说本机存储已接入 IndexedDB v3：摘要、目录、按章正文和阅读进度分开保存；书架列表与进度写入不访问正文。章节 ID 独立于排序，旧唯一 ID 升级时保留。v2 升级读取当前分层数据，不重放 `books` 旧副本；v1 则在同一个升级事务中拆分旧记录。旧 `books` 保留供显式取回；升级需要额外空间，失败中止事务，不删库重建。该副本不是新版产生数据后的无损降级方案。

当前已完成合成库的原生浏览器 IndexedDB 验证与自动回归；尚未完成 Android WebView 真机磁盘满、系统杀进程和大库峰值内存验证。新章节模型的设备安装及验证状态以本轮交付报告为准。分阶段模型、具体 API 和仍未实现的独立书架/跨端冲突同步见 [小说数据模型 v2](../docs/modules/novel-data-model-v2.md#稳定章节身份与待确认续读实现记录)。

远端离线缓存现在按 `(sourceRealm, sourceBookId)` 关联。电脑端在 `novel_meta.library_id` 保存一次生成的 UUID，并通过小说响应提供 `sourceRealm`；改地址不会改变身份，独立书库不会仅因书籍 ID 相同而共用缓存。旧 `local:remote:<id>` 副本不猜测来源，继续从本地书库阅读、导出或明确删除；旧电脑端没有身份字段时仍可在线阅读，但需更新电脑端才能新建整本缓存。

安卓只将服务器上次声明的来源保存为可丢弃的地址关联回执，不把地址当身份。离线时不能探测同一地址是否换过书库；回执随响应缓存清理或应用缓存版本变更而失效后，需联网重新确认才能自动关联，所有本地副本仍可直接打开。目录和逐章缓存固定操作开始时的地址、来源与目录版本，逐响应校验，页面或书库切换后不混合保存、也不重绘旧页。专项回归为 `node tools/verify_android_novel_source_identity.mjs` 与 `node tools/verify_novel_library_identity.mjs`。

同一本书重导时，仅双方完整快照中唯一且完全相同的非空正文保留章节 ID 和比例；插章、调序因此不再依赖旧序号。同标题但正文改动只提供从章首查看的候选；删章、重复正文或旧版本无法验证时保留旧锚点，显示“续读位置待确认”，不自动跳读。存量无版本进度升级后也须确认一次。明确选择章节并保存后才清除待确认状态。

新版服务端 schema 为 5，书籍提供 `catalogRevision`；新版客户端保存进度携带实际打开时的章节 ID、目录版本及来源。旧服务仍可读，但没有内容版本时不能新增整本缓存。服务端重导后的旧 index-only 写入会被拒绝，避免旧会话覆盖新位置。目录版本覆盖整本目录与正文快照，不是多设备进度冲突版本，也没有自动关联不同文件或不同来源的同名作品。

章节专项：`node tools/verify_android_local_novel_chapter_identity.mjs`、`node tools/verify_android_novel_chapter_identity.mjs`、`node tools/verify_novel_chapter_identity.mjs`。原生浏览器隔离入口：`node tools/serve_android_novel_chapter_fixture.mjs`；仅使用随机命名合成数据库，不能替代真机验证。

升级或读取失败时，列表、详情和阅读页会保留明确的错误状态，提供重试及“只读取回旧库正文”入口，不将失败当成空库或已删书。取回入口只读分页列出旧 `books`，由用户逐本选择导出 TXT；部分损坏会说明遗漏章节并再次确认。它不修复数据库，不自动上传，也不是完整备份。v2/v3 的旧副本可能不含升级后的新增或修改内容；导出还受单本 80 MiB UTF-8 大小限制。

专项回归入口为 `node tools/verify_android_novel_recovery_storage.mjs` 和 `node tools/verify_android_novel_recovery.mjs`，已纳入根目录 `npm run verify:android-client`。隔离交互夹具为 `node tools/serve_android_novel_recovery_fixture.mjs`，使用合成数据库与模拟文件保存；不能替代 Android WebView／系统文件选择器实机验证。

## Gradle 网络代理

仓库中的 `android\gradle.properties` 必须保持为无代理的默认配置，不能写入 `localhost`、固定代理地址、端口或代理凭据；包括 bare 或带前缀的 `proxyHost`、`proxyPort`、`proxyUser`、`proxyPassword`、`proxyUrl`。这样干净构建不会隐式依赖某一台开发机。

需要代理的开发者只能将自己的配置放到用户级 `%USERPROFILE%\.gradle\gradle.properties`，例如仅在本机添加 `systemProp.http.proxyHost`、`systemProp.http.proxyPort` 及对应 HTTPS 项。也可以在一次命令中临时传入不含凭据的 JVM 属性，例如：

```powershell
.\android\gradlew.bat --% -p .\android --no-daemon -Dhttp.proxyHost=proxy.example.test -Dhttp.proxyPort=8080 -Dhttps.proxyHost=proxy.example.test -Dhttps.proxyPort=8080 help
```

`--%` 是 PowerShell 的停止解析记号，避免 `-Dhttp.proxyHost` 被 PowerShell 截断；该命令从 `android-client` 目录运行，`-p .\android` 显式指定 Gradle 项目目录。

不要把代理配置复制到仓库、脚本、提交信息或可共享的终端历史中；尤其不得提交 `proxyUser`、`proxyPassword`，或把用户名/密码嵌入代理 URL。需要认证代理时，请使用受本机保护的用户级配置或组织规定的凭据管理方式。

运行 `npm run verify:android-gradle-config` 会检查所有受版本控制的 Android Gradle 配置，阻止本机地址、固定 HTTP/HTTPS 代理以及代理凭据重新进入仓库。

Android 客户端支持显式密码登录：原生端只保存绑定服务 origin（协议、主机、端口）的短期会话，不保存密码、不复制浏览器 Cookie，也不将会话写入媒体 URL。会话用于 API、WebView 图片/媒体与原生 HTTP 播放请求，密码变更后失效；原生会话排除在系统备份之外。远程文件删除和管理操作仍受原有局域网权限限制。HTTP 地址兼容现有配置，但密码和内容均为明文传输，公网部署应使用 HTTPS。

## 底部内容切换

底部保留五个主入口。“套图 / 韩漫”所在入口现可选择 **套图、韩漫、电影、电视剧**：长按直接选择，再次点击已激活入口按这四项顺序切换；从其他入口返回时恢复最近选择。电影、电视剧的列表与详情也高亮这个入口，影视模块仍独立运行，不与图库数据混合。

导航回归：`node tools/verify_android_gallery_navigation.mjs`；电影和电视剧列表/分组契约：`node tools/verify_media_channel_clients.mjs`。浏览器隔离夹具只使用合成内容，不能替代手机安装后的验收。

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
