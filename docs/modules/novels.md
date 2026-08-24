# `novels` 模块

## 定位

`novels` 负责本地小说书库、上传、章节目录、阅读进度、下载和外部来源采集。入口是 `src/modules/novels/module.js`，runtime 在 `src/modules/novels/server/runtime.js` 中创建存储和采集服务。

## 服务端结构

- `store.js`：小说主库和章节读写。
- `collection-service.js`、`collection-store.js`：来源适配器、采集任务和采集状态。
- `credential-service.js`：采集来源凭据的隔离存储。
- `reimport-service.js`：已有小说重新导入 / 解析。
- `routes.js`：书库、章节、上传、下载和任务接口。
- `settings.js`：来源配置和凭据相关设置。

采集服务在 runtime `start()` 时启动，在 `stop()` 时关闭；慢速采集必须走任务状态，不应阻塞普通章节读取。

## API

- `/api/novels`、`/api/novels/summary`、`/api/novels/authors`：书库和聚合信息。
- `/api/novels/:id`、`/api/novels/:id/catalog`：小说详情和目录。
- `/api/novels/:id/chapters/:chapter`：章节内容。
- `POST /api/novels/upload`、`POST /api/novels/:id/reimport`：导入和重导入。
- `/api/novels/:id/progress`：阅读进度。
- `/api/novels/collection/*`：采集适配器和后台任务。
- `/api/novels/:id/download`：下载小说 / 章节产物。

写入和采集管理接口需要本机管理员策略；正文读取应保持分页和单章节粒度。

## 数据与外部工具

- `data/novels.sqlite`：小说主库。
- `data/novel-collection.sqlite`：采集任务和适配器状态。
- `data/novel-credentials/`：来源凭据。
- `data/novel-collection/`：采集输出。
- `FANHAO_MANGA_ROOT` 不属于小说模块；小说路径和采集工具通过 runtime 注入的 `projectRoot`、`pythonPath` 管理。

## 修改与验证

```powershell
npm run verify:novels
```

涉及文本格式、导入或采集器时，还应检查 `tools/novel_text_formatter.py`、对应来源脚本和 [维护与作业](../maintenance.md)。
