# Android 短视频模块

`short-video-views.js` 是兼容入口，实际组合发生在 `index.js`。外部仍只通过 `createShortVideoViews()` 使用本模块。

- `api.js`：服务端请求适配。
- `shared.js`：常量、参数规范化和纯格式化函数。
- `list/`：列表状态、分页、搜索、作者索引和列表 DOM。
- `player/`：Reel 数据/渲染、媒体预热与首帧缓存、手势与播放交互、原生信息流桥接。
- `panels/`：作者面板与播放设置/更多操作面板。
- `platform/`：Capacitor 原生播放器和沉浸模式适配。
- `ui/`：短视频图标。
- `styles/`：列表、Reel、作者面板和播放面板样式。

模块运行时公开 `renderList`、`renderBrowser`、搜索方法和 `deactivate`。离开短视频视图时，`deactivate` 负责停止媒体、定时器、观察器、弹层和沉浸模式。
