# `tools` 模块

## 定位

`tools` 是可见的小工具模块，当前提供 TXT 文本格式化下载和离线小游戏入口。入口是 `src/modules/tools/module.js`，服务端 runtime 是 `src/modules/tools/server/runtime.js`。

## 代码结构

- `server/txt-format-service.js`：读取输入、调用格式化逻辑、生成短期下载令牌和清理过期产物。
- `server/routes.js`：文本格式化和下载接口。
- `public/modules/tools/`：Web 工具页。
- `android-client/www/modules/tools/`：Android 工具页。
- `public/games/`：离线小游戏静态资源，例如跳棋 / 五子棋；游戏本身不应依赖服务端数据库。

## API

- `POST /api/tools/txt-format`：本机管理员发起文本格式化。
- `GET /api/tools/txt-format/download/:token`：读取短期下载产物。

服务端限制请求体、输入文件和预览大小；下载 token 只用于短期临时文件，不是长期资源 ID。格式化失败要返回稳定的错误消息和状态码。

## 配置与验证

临时下载目录默认是 `data/tool-downloads/`，过期时间由 `TOOL_DOWNLOAD_TTL_MS` 控制；TXT 限制由服务端常量提供，具体默认值见 `src/bootstrap/server-config.js`。

```powershell
npm run verify:gomoku
npm run verify:jump
npm run verify:settings
```

新增工具时优先新增独立 service 和模块页面，不要把工具状态写进 `public/app.js` 或系统模块。
