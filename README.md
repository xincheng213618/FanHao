# 个人视频资料库

本项目会以只读方式扫描 `G:\`、`F:\`、`O:\`、`O:\[珍藏]\`、`O:\[珍藏1]\`、`V:\[A]\`、`V:\[A1]\`、`V:\AV\`、`R:\`，按顶层文件夹作为人物分类，在局域网内提供网页浏览。

运行环境需要 Node.js 24 或更新版本，因为服务端使用内置的 `node:sqlite`。

## 启动

```powershell
npm start
```

默认地址：

```text
http://127.0.0.1:29998
```

手机访问时使用电脑的局域网 IP：

```text
http://电脑局域网IP:29998
```

## 规则

- 服务端口：`29998`
- 监听地址：`0.0.0.0`
- 资料库路径：`G:\`、`F:\`、`O:\`、`O:\[珍藏]\`、`O:\[珍藏1]\`、`V:\[A]\`、`V:\[A1]\`、`V:\AV\`、`R:\`
- `[A]` 会作为一个特殊人物分类
- 作品标题优先使用文件夹名
- 浏览器支持的视频会直接播放；不适合直连的格式会按探测结果走重封装或转码
- 不提供下载按钮
- 不加登录密码
- 收藏、继续观看、播放进度会保存到 `data\user-state.json`
- 扫描索引会缓存到 `data\library-index.json`

可用环境变量覆盖：

```powershell
$env:LIBRARY_ROOTS = "G:\;F:\;O:\;O:\[珍藏]\;O:\[珍藏1]\;V:\[A]\;V:\[A1]\;V:\AV\;R:\"
$env:PORT = "29998"
$env:HOST = "0.0.0.0"
npm start
```

## 维护脚本

这些脚本默认以 dry-run 或只读方式运行，确认输出后再加对应的 `--write` 参数：

```powershell
npm run cleanup:metadata
npm run cleanup:user-state
npm run covers:missing
npm run scan:noise
npm run sync:sidecars
```

`npm run scan:noise` 只报告疑似扫描噪音，例如很小的视频或名称包含 sample/trailer/preview 的文件，不会修改索引或删除文件。

`npm run sync:sidecars` 只统计会回写的 `info.txt` / `cover.*`；需要真正写入本地作品文件夹时使用：

```powershell
npm run sync:sidecars -- --write
```
