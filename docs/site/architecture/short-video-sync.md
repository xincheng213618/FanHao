---
title: 短视频增量同步
description: 下载器变更日志、批量快照、持久游标及初始化和失败恢复约束。
status: maintained
verified_at: 2026-10-11
sources:
  - src/modules/short-videos/download-manager/manager_core/library_sync.py
  - src/modules/short-videos/download-manager/manager_core/database.py
  - src/modules/short-videos/server/download-manager-change-journal.js
  - src/modules/short-videos/server/download-manager-metadata-sync.js
  - src/modules/short-videos/server/download-manager-sync-service.js
  - src/modules/short-videos/server/sync-worker.js
  - src/modules/short-videos/server/store.js
  - tests/verify_short_video_incremental_sync.mjs
  - src/modules/short-videos/download-manager/tests/test_manager_library_sync.py
---

# 短视频增量同步

下载管理器拥有采集与下载状态，主服务拥有展示目录和本地用户状态。同步通过只读来源 SQLite 和主服务的导入边界进行。

## 来源变更

下载器初始化迁移安装事务触发器，作品元数据、来源关系和作者资料分别记录变更。同一实体多次修改只保留最新序号，删除保留记录；业务事务回滚时，投影和日志也回滚。

| 数据 | 用途 |
| --- | --- |
| `library_sync_state` | 日志版本和来源代际；修复缺失触发器时生成新代际 |
| `library_sync_changes` | 按实体合并的最新变更序号，包括删除记录 |
| `library_sync_memberships` | 轻量来源关系、最后观测时间和缺失标记 |

关系投影避免更新观测时间时读取作品的大段 JSON。任务心跳、重试次数和无关设置不触发资料同步。

## 批次与恢复

主服务默认每分钟检查日志，在同一 WAL 快照中按序号取最多 500 条变更，按作品和作者索引读取受影响记录。目标数据和持久游标在同一事务中提交；失败回滚后可重试，快照期间的新写入留给下一批。

首次迁移、来源代际变化或导入范围变化时，分批核对旧目录关系并消费初始化日志。有积压时让出执行机会后继续下一批，每批释放目标库写锁；停止服务会取消后续批次。没有变更时只读日志头和游标，不执行全库关系、最大时间戳或封面核对。

来源删除只更新资料关系，不删除本地媒体；本地用户动作保留原有优先级。作品导入后重新核对这些作品涉及的作者，防止旧下载记录覆盖较新的昵称或账号状态。封面清理只核对本批涉及的作品。

## 部署与验证

先通过下载器的初始化迁移安装日志，再让主服务加载新代码。旧下载器尚未安装日志时，自动同步返回升级提示并停止全量回退；显式导入旧数据库仍保留兼容入口。第一次投影初始化会读取已有来源记录，这是一次性迁移成本。

`npm run verify:short-video-sync` 使用临时 SQLite 和合成媒体验证分页初始化、更新与删除、回滚、并发提交、重启和查询预算，并比较进程逻辑读取量。逻辑 I/O 包含系统缓存命中的读取，不等于物理磁盘吞吐。下载器初始化另由 `tests.test_manager_library_sync` 与 `tests.test_manager_database_lifecycle` 验证。

回到[数据与请求流](./data-flow.md)或[验证矩阵](../reference/verification.md)。
