# FanHao 模块文档

本目录按 `src/modules/*/module.js` 的注册结果拆分文档。每篇文档都说明同一个模块的服务端入口、客户端入口、主要接口、数据归属和验证方式，便于定位改动范围。

## 模块总览

| 模块 | 可见性 | 主要职责 | 文档 |
| --- | --- | --- | --- |
| `system` | 隐藏 | 健康检查、管理、鉴权、本机打开、Android 更新 | [system.md](./system.md) |
| `fanhao` | 可见 | 人物、番号、作品、收藏、播放记录、磁盘用量 | [fanhao.md](./fanhao.md) |
| `content-index` | 隐藏 | 套图与影视共用的只读图库索引 | [content-index.md](./content-index.md) |
| `photos` | 可见 | 套图、写真、韩漫阅读和图片缓存 | [photos.md](./photos.md) |
| `media` | 可见 | 电影、电视剧、欧美视频详情和媒体播放 | [media.md](./media.md) |
| `novels` | 可见 | 小说书库、章节、阅读进度和采集任务 | [novels.md](./novels.md) |
| `short-videos` | 可见 | 短视频信息流、作者、收藏、评论和播放缓存 | [short-videos.md](./short-videos.md) |
| `music` | 可见 | 音乐扫描、搜索、队列、歌单和播放 | [music.md](./music.md) |
| `tools` | 可见 | TXT 格式化和离线小游戏入口 | [tools.md](./tools.md) |
| `market-dashboard` | 可见 | 贵金属、汇率和全球指数行情 | [market-dashboard.md](./market-dashboard.md) |

`disk-usage` 位于 `src/modules/fanhao/server/disk-usage/`，由 `fanhao` runtime 装配；它没有自己的 `module.js`，因此记录在 [fanhao 模块](./fanhao.md) 中。

## 统一运行模型

每个注册模块都通过根目录下的 `module.js` 暴露描述符和可选的 `createModule()`：

```text
src/modules/<id>/module.js
        │
        ▼
src/modules/<id>/server/runtime.js
        │
        ├── routeApi(req, res, url)
        ├── routeMedia(req, res, url)
        ├── start() / stop()
        └── invalidate(reason)
```

注册表按 `order` 排序，逐个调用模块 runtime。路由匹配后返回 `true`，未匹配返回 `false`；模块不应拦截其他模块的路径。

客户端分为三层：

- Web 页面控制器：`public/modules/<id>/`；页面宿主和模块清单由 `public/` 壳层管理。
- Android WebView 控制器：`android-client/www/modules/<id>/`。
- 原生能力：仅在需要时由 `android-client/android/` 提供，WebView 通过明确的插件或活动接口调用。

## 修改模块时的最小检查

```powershell
node --check src/modules/<id>/module.js
npm run verify:modules
npm run verify
```

修改涉及扫描、数据库、媒体或本机文件时，还应运行对应模块文档列出的专项验证。接口路径、HTTP 方法和权限以 [API 参考](../api-reference.md) 为准；环境变量和默认路径以 [项目配置](../configuration.md) 为准。
