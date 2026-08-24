# `content-index` 模块

## 定位

`content-index` 是隐藏的只读基础模块，向套图和影视页面提供统一的图库索引、筛选、分页和概览数据。它不是用户导航入口，也不拥有套图或影视的详情写入逻辑。

入口：`src/modules/content-index/module.js`、`src/modules/content-index/server/runtime.js`。

## 代码结构

- `server/image-library-service.js`：构建总览、筛选和分页 payload。
- `server/image-library-index-service.js`：维护索引读取、缓存和版本状态。
- `server/image-library-index-contract.js`：约束索引字段和读写契约。
- `server/image-gallery-db-service.js`：读取影视 / 图库共用的 SQLite 内容索引。
- `public/modules/content-index/`：`gallery-page.js`、`gallery-renderer.js` 和 `photo-catalog.js`，供 Web 图库 / 影视视图复用。

`photos` 与 `media` 通过依赖注入使用服务，不应直接互相导入内部文件；新增共用查询能力应先判断是否属于该隐藏模块。

## API

- `GET /api/image-library`：完整索引 payload。
- `GET /api/image-library/summary`：概览，可通过 `cache=0` 绕过概览缓存。
- `GET /api/image-library/items`：按 `mode`、筛选条件、`limit`、`offset` 分页。
- `POST /api/image-library/rescan`：目前返回迁移提示；刷新动作统一由后台作业中心执行。

刷新索引可能是慢任务，不能在 HTTP 请求中同步遍历所有根目录。前端收到刷新提示后应引导用户运行“刷新图库索引”作业。

## 数据与验证

默认索引路径为 `data/image-library-index.json`；图片读取缓存由平台服务管理，图库数据库默认是 `data/image-gallery.sqlite`。具体路径和缓存边界见 [数据布局](../data-layout.md)。

修改索引字段、分页或客户端复用逻辑时运行：

```powershell
npm run verify:image-library
npm run verify:gallery-db
npm run verify:photo-reader
npm run verify:modules
```
