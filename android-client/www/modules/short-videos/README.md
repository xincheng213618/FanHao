# Android 短视频模块

`short-video-views.js` 是兼容入口，实际组合发生在 `index.js`。外部仍只通过 `createShortVideoViews()` 使用本模块。

- `api.js`：服务端请求适配。
- `shared.js`：常量、参数规范化和纯格式化函数。
- `list/`：列表状态、分页、搜索、作者索引和列表 DOM。
- `player/native-feed.js`：把当前列表范围交给原生短视频播放器。
- `panels/author-panel.js`：作者资料与本地作品面板。
- `ui/`：短视频图标。
- `styles/`：列表和作者面板样式。

模块运行时公开列表、搜索和 `deactivate`。短视频播放统一由 `NativeShortVideoActivity` 负责，Android WebView 不再维护第二套播放器。
