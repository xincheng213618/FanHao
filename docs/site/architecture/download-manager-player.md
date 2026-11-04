---
title: 下载管理器播放查询
description: 共享播放器清单与相邻作品的排序索引、初始化和验证边界。
status: maintained
verified_at: 2026-11-05
sources:
  - src/modules/short-videos/download-manager/manager_core/database.py
  - src/modules/short-videos/download-manager/manager_core/library.py
  - src/modules/short-videos/download-manager/manager_core/http_api.py
  - tests/verify_download_manager_player_order.mjs
  - package.json
---

# 下载管理器播放查询

下载管理器的共享播放器从已下载作品中读取清单、详情与前后邻居。其查询排除文章，按下载、启动、最后观测时间的回退值和作品 ID 排序；这些规则由 `library.py` 中的原 SQL 决定。

## 索引与原查询

`idx_links_shared_player_order` 的排序表达式包含最后的空字符串回退：

```sql
COALESCE(downloaded_at, last_started_at, last_seen_at, '') DESC, id DESC
```

索引只包含 `status='downloaded'` 且 `media_type`、`kind` 按原 `COALESCE` 判断均不为 `article` 的记录。表达式与部分索引条件需要匹配原查询；已有不含最后空字符串回退的目录索引不能直接满足这一排序。共享播放器的计数也可以读取这份较窄索引。

原列表、详情和邻居 SQL 不变。分页总数、排序并列时的 ID 次序、搜索和作者筛选仍由原查询产生；邻居仍最多读取 32 个候选，再按原文件与媒体校验选择可播放作品，不按返回视频数改写原始偏移。

## 安装与代价

索引由已有的 `migrate_link_preview_columns` 初始化迁移安装，使用 `CREATE INDEX IF NOT EXISTS`，保留其他目录索引。缺少 `kind` 列的旧表沿用原初始化路径并跳过这份索引，不为优化新增字段依赖。旧库无需清空或重扫媒体；首次建立索引需要读取现有记录，之后写入需要维护这份额外索引。

初始化和实际运行属于下载管理器的生命周期。主服务或文档构建不会为此启动、停止或重启正式下载管理器。

## 验证范围

`npm run verify:download-manager-player-order` 通过受控 Python 进程运行实际数据库初始化与完整播放工厂，仅使用私有 SQLite 和空占位媒体文件。专项对照完整响应与旧查询结果，检查索引计划和排序工作量，并记录索引空间、构建及写入成本。

专项作为 `verify:douyin-manager` 的子门禁运行。合成样本耗时只用于诊断，不代表真实资料库、网络传输或播放器解码耗时；正式服务和实际媒体验收遵循[数据边界](../ai/safety.md)。
