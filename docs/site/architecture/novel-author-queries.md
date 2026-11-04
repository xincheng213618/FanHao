---
title: 小说作者查询与索引迁移
description: 作者筛选的表达式索引、并列顺序、旧库回退及 Node/Python v6 迁移边界。
status: maintained
verified_at: 2026-11-05
sources:
  - src/modules/novels/server/store.js
  - tools/rescan_novel_library.py
  - android-client/www/modules/novels/novel-views.js
  - tests/verify_novel_author_index.mjs
  - tests/verify_novel_author_index_migration.mjs
  - tests/verify_android_novel_list_rendering.mjs
  - package.json
---

# 小说作者查询与索引迁移

作者筛选仍使用 SQLite 的 `TRIM(COALESCE(author, ''))` 规则。标准库的非空作者请求追加原值非空条件，使专用表达式索引可以定位作者并按更新时间和书名取页。默认书库、作者聚合和未筛选作者的阅读列表不满足该部分索引条件，保留原查询计划。

## 资格与排序

每次作者读取在当前读快照内，用一次 schema 查询核对作品、阅读状态表及索引集合，并排除临时同名对象。比较保留 SQL token 和引号内容；只有格式空白可以不同。资格不跨请求缓存。

标准库作者页保持原主排序，并明确并列行序：更新时间排序最后按物理行号倒序，其余排序按物理行号正序。该规则延续当前标准库的旧访问顺序；书籍 ID 是路径哈希，不替代物理行号。

旧约束、额外索引、旧索引方向、生成列、rowid 遮蔽或资格读取失败时，继续使用原筛选和排序 SQL。新索引不成为读取旧库的必要条件。未选择的字段与原生整数解码错误仍沿原查询边界处理。

## v5 到 v6

Node 运行时与 Python 扫描器共同维护 schema 版本。有效 v5 库在原写事务中重验版本和来源身份，再按资格安装可选索引，最后写入版本6；不重跑旧初始化 DDL。无法安装优化索引的兼容旧结构也完成版本登记。

v0～4 继续原初始化和章节身份迁移，章节迁移阈值仍是 `<5`，随后安装索引并登记版本6。索引或版本写入失败会回滚；身份、章节正文与记录 ID 不因索引迁移而改写。非法身份或版本、未来版本仍在原位置拒绝。

已完成迁移的有效 v6 库可直接读取，不为每次查询重新建索引或申请写锁。旧版本程序按既有未来版本保护拒绝 v6，因此 Node 与 Python 必须一起更新。这里只说明代码中的迁移流程，验证仅操作临时库。

## 成本与验证

私有十万本样本中，索引约增加 4.85 MiB 存储；构建成本发生在升级时，后续写入需维护该索引。专项同时记录插入、更新、重扫写入及完整读取的诊断耗时，不把单次计时设为门槛。

`verify:novel-author-index` 对照完整旧响应、原错误、标准并列规则、查询计划、候选访问量和关闭索引的负控。`verify:novel-author-index-migration` 用两端完整 v5 实现建库，核对真实升级、读写互通、锁间版本或身份变化、故障回滚及旧结构回退。

Android 书库和搜索的同条件续页继续请求从零开始的累计前缀。完整旧前缀与稳定 ID 一致时保留书卡并追加；内容或顺序变化时完整重建，动作始终读取最新书籍绑定。`verify:android-novel-list-rendering` 使用真实应用入口核对请求、缓存、来源和账号、失败重试、滚动与焦点；它不证明真实设备性能。
