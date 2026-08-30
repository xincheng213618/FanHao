---
title: 数据与请求流
description: 从客户端请求追踪到模块存储、worker、下载管理器和媒体响应。
status: maintained
verified_at: 2026-08-30
sources:
  - src/bootstrap/server-config.js
  - src/platform/server/http-app.js
  - src/platform/server/auth.js
  - src/fanhao/module-registry.js
  - src/modules/fanhao/server/library/core-db-service.js
  - src/modules/fanhao/server/library/cache-contracts.js
  - src/modules/fanhao/server/library/cross-store-outbox-service.js
  - src/modules/short-videos/server/runtime.js
  - src/modules/short-videos/server/download-manager-sync-service.js
  - src/modules/short-videos/server/watch-write-service.js
  - src/modules/short-videos/server/watch-write-worker.js
  - src/modules/short-videos/server/delete-job-service.js
  - src/modules/novels/server/runtime.js
  - src/modules/music/server/runtime.js
  - src/modules/market-dashboard/server/quote-service.js
  - src/platform/server/library-path-safety.js
  - src/platform/server/media-stream-service.js
---

# 数据与请求流

排查 FanHao 时，应分别确认请求是否到达、权威状态是否写入、缓存是否刷新、媒体文件是否仍可访问。这些是不同环节，不能仅凭页面更新判断持久化成功。

## 一次普通请求

```text
Web / Android
      |
      v
http-app.js：跨源检查、鉴权、访问记录
      |
      v
module-registry.js：依次调用模块 API 路由
      |
      +--> 模块 service / store / worker --> 数据库或外部来源
      |                                  |
      |<------------- 结果 --------------+
      |
      +--> 未匹配 API 时：模块媒体路由 --> 文件 / BLOB / 媒体流
      |
      +--> 仍未匹配且为 GET/HEAD：静态资源
```

这是公共入口的分发顺序；认证路由和公开 Android 更新接口有专门分支。具体请求还可能被模块内部的权限、输入校验或错误边界提前终止。

未处理异常由公共边界记录，5xx 默认返回通用错误。模块也有自己的错误响应；新增接口时应检查当前模块契约，不应把数据库路径、SQL 或内部异常直接返回客户端。

## 数据所有权

下表是源码默认位置，不是部署实例的盘点。带环境变量覆盖的路径、媒体根目录和实际数据库版本都需在操作前确认。

| 状态 | 默认位置或来源 | 所有者 |
| --- | --- | --- |
| 人物、作品和关系 | `data/fanhao-core-v2.sqlite` | 番号模块核心库服务 |
| 核心图片存储 | `data/fanhao-core-images.sqlite`，可配置 | 核心图片存储服务与使用它的业务流程 |
| 图库索引与影视元数据 | `data/image-library-index.json`、`data/image-gallery.sqlite` | `content-index` 及图库/影视业务 |
| 小说正文与阅读状态 | `data/novels.sqlite` | 小说存储 |
| 小说采集任务 | `data/novel-collection.sqlite` 和任务输出目录 | 小说采集服务 |
| 音乐目录和状态 | `data/music.sqlite` | 音乐存储 |
| 短视频目录和用户状态 | `data/short-videos.sqlite` | 短视频存储 |
| 下载队列与下载记录 | 下载管理器自身的 `data/douyin_downloads.sqlite` | 独立下载管理器 |
| 番号收藏、播放等状态 | `data/user-state.json` | 对应用户状态服务 |
| 本地媒体内容 | 配置的库根目录 | 文件系统；数据库保存索引与映射 |
| 行情 | 外部行情来源与服务内缓存 | 行情服务，不是本地媒体数据库 |

不能把这些位置概括为“一个数据库”。复制主库不能代替完整备份，也不能推断外部媒体、下载记录、图片库或凭据已经随之迁移。

## 短视频的两条数据来源

主服务使用自己的短视频 SQLite 提供信息流和用户操作。下载管理器数据库保存采集与下载侧状态；二者职责不同。

`download-manager-sync-service.js` 根据来源数据库状态决定是否启动 `sync-worker.js`。同步改变展示目录后，运行时通过回调处理目录缓存失效；它不是让每次列表请求直接读取下载管理器 HTTP 接口。

短视频运行时也代理部分管理器接口，因此诊断时要区分：

| 症状 | 优先核对 |
| --- | --- |
| 管理器页面或任务不可用 | 管理器连接地址、独立进程和相关代理请求 |
| 下载已完成但列表未出现 | 来源数据库、同步状态、展示库与目录缓存 |
| 列表正常但无法播放 | 记录映射的文件、根目录校验和媒体响应 |
| 观看状态不稳定 | 写入 worker、数据库回执与列表覆盖/失效逻辑 |

## 写入、回执与缓存

短视频观看请求由运行时委托 `watch-write-service.js`，worker 执行存储写入或查询回执。请求排队、SQLite 忙等待、worker 超时和数据库提交不是同一状态；不得用延长一个超时掩盖所有失败。

列表缓存和临时观看覆盖服务于响应速度，SQLite 状态仍需单独核实。对写入失败的验证应覆盖实际回执与重试结果，而不只是检查界面是否变色。

番号核心库的部分缓存采用表数据戳，依赖集合在 `cache-contracts.js` 声明。修改写入路径时，需要检查受影响表和缓存失效调用；重启进程后“恢复正常”并不能证明失效契约正确。

这些是不同模块的现有方案，不是要求全仓库采用同一种缓存实现。

## 文件与数据库的联合变更

文件移动或删除无法由普通 SQLite 事务独自回滚。短视频删除作业服务记录计划、文件隔离、数据库提交与后续清理，并保留恢复状态；部分请求还带 `operationId` 用于识别重试。

该流程有逻辑删除和真实文件删除等分支，不能把某一条成功路径当成全部行为。涉及删除、路径移动或中断恢复时，先阅读 `delete-job-service.js` 和对应夹具，不要绕过作业服务直接删文件或 SQL 行。

核心资料发布还使用跨存储 outbox 服务。需要联动不同存储时，应先追踪现有恢复机制，明确“已提交但清理未完成”与“尚未提交”的区别。

## 媒体响应

客户端通过媒体 URL 取内容，模块负责把业务 id 映射为受控文件或图片记录，再调用平台媒体响应能力。路径安全、Range 读取、转码或缓存属于独立检查点。

文件存在不等于允许访问；字符串路径包含根目录也不等于真实路径安全。涉及符号链接、目录联接和跨卷操作时，应使用项目已有的实际路径校验。

## 调试所需最小证据

记录请求方法与脱敏 URL、模块和路由入口、状态所有者、预期与实际结果，以及所用临时夹具。只在必要时附加脱敏日志，不附真实媒体列表、Cookie、凭据或个人路径。

从[仓库地图](./repository-map.md)定位代码，再根据[验证参考](../reference/verification.md)验证读写与失败边界。新 AI 任务的上下文组织见[AI 上下文](../ai/context.md)。
