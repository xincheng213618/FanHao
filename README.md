# FanHao 个人资料库

FanHao 是一个本地优先的媒体资料库：扫描本机磁盘上的番号、图库、影视、短视频和音乐，并在网页和 Android 客户端中统一浏览。

运行环境需要 Node.js 24 或更新版本，因为服务端使用内置的 `node:sqlite`。

## 启动

```powershell
npm start
```

默认地址是 `http://127.0.0.1:29998`；局域网设备可使用 `http://电脑局域网IP:29998`。

## 默认资料目录

- 番号：`G:\`、`F:\`、`O:\`（排除 `[动漫]`）、`V:\[A]`、`V:\[A1]`、`V:\AV`、`R:\`
- 影视：电影 `Z:\`、电视剧 `Y:\`、动漫 `O:\[动漫]`
- 图库：`T:\`、`T:\[套图1]`
- 影视：`Z:\`、`Y:\`
- 短视频：`D:\Media\ShortVideos`
- 音乐：`E:\Music`

实际部署可用环境变量覆盖路径、端口和监听地址，详见 [配置说明](docs/configuration.md)。

## 访问与数据

- 本机和局域网默认可免密码访问；远程访问必须配置 `FANHAO_WEB_PASSWORD`，不要把 `29998` 端口直接暴露给不可信网络。
- 主数据已持久化到 `data\` 下的 SQLite 数据库；`data\library-index.json` 只保留兼容读取，不再是权威索引。
- 数据库、缓存和可重建产物的边界见 [数据布局](docs/data-layout.md)。

## 维护与验证

批量扫描、资料补全、封面生成和缓存清理统一从 `/admin` 的后台作业中心运行，详见 [维护说明](docs/maintenance.md)。

提交前运行：

```powershell
npm run verify
```

该命令覆盖代码结构、服务端契约、数据库、Android 客户端以及关键页面回归。

抖音下载管理器支持标签自动发布和 Actions 页面安全试跑，详见
[发布流程](docs/douyin-manager-release.md)。

开发者文档入口：[文档中心](docs/README.md)，按模块拆分的代码说明见[模块文档](docs/modules/README.md)。
