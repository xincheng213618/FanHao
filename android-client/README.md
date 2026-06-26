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

如果要直接安装到手机，需要本机有 Android SDK / platform-tools，并且手机已开启 USB 调试：

```powershell
npm run install:debug
npm run run:android
```

`build:debug` / `install:debug` 会优先使用 Android 自带的 OpenJDK 21，避开系统默认 JDK 26 触发的 Gradle `jlink` 构建问题。生成的 debug APK 在：

```text
android\app\build\outputs\apk\debug\app-debug.apk
```

当前壳应用允许局域网 HTTP 明文连接。它适合个人局域网使用；后续如果要外网访问，应改成 HTTPS 或配对 token。
