# `photos` 模块

## 定位

`photos` 负责套图、写真、韩漫和图片读取。它是可见业务模块，但套图 / 影视共用的列表索引由隐藏的 `content-index` 提供。

入口：`src/modules/photos/module.js`、`src/modules/photos/server/runtime.js`。

## 服务端结构

- `photo-set-service.js`：套图根目录、相册详情、封面和图片读取。
- `manga-service.js`：韩漫缓存目录、漫画详情、章节和图片读取；优先读取漫画 SQLite 索引，缺失时回退到 `manifest.json`。
- `manga-database.js`：漫画 SQLite 只读适配层，读取漫画、章节和图片元数据。
- `settings.js`：图库相关设置。
- `routes.js`：只负责路由和响应；列表索引通过注入的 `imageLibraryService` 获取。

Web 页面复用 `public/modules/content-index/` 的图库控制器；套图特有的说明和样式放在 `public/modules/photos/`。Android 入口是 `android-client/www/modules/photos/android-module.js`，共用频道控制器在 Android 的 content-index 目录。

## API 与媒体

- `GET /api/photo-sets`：套图 / 媒体索引和统计。
- `GET /api/photo-sets/:id`：套图详情，支持 `imageLimit`、`imageOffset`。
- `GET /api/manga`、`GET /api/manga/:id`：漫画列表和详情。
- `GET /api/manga/:id/chapters/:chapter`：章节图片列表。
- `manga.sqlite` 由缓存脚本的 `--rebuild-sqlite` 或正常抓取自动维护，服务端默认从 `FANHAO_MANGA_ROOT` 下读取。
- `GET /api/image-reader/cache`：图片读取缓存状态。
- `POST /api/image-reader/cache/cleanup`：本机管理员清理图片缓存。
- `/media/gallery-cover/:id`、`/media/gallery/:id/:image`：套图封面和图片。
- `/media/manga/:comic/:chapter/:image`：漫画图片。

套图详情支持分批读取；不要默认把整套高分辨率图片全部放进单个响应。图片读取和压缩缓存由平台服务统一控制。

## 数据与配置

- `PHOTO_SET_ROOTS`：套图根目录。
- `MANGA_LIBRARY_ROOT`：韩漫根目录。
- `data/image-library-index.json`：共用索引。
- `data/image-reader-cache/`：图片读取缓存。

路径可通过环境变量覆盖，默认值见 [项目配置](../configuration.md)。

## 修改与验证

修改图片读取、压缩、归档或分页时运行：

```powershell
npm run verify:image-library
npm run verify:photo-reader
npm run verify:archive-images
npm run verify:photo-search
```
