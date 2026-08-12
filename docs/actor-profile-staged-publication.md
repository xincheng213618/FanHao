# 单人物资料跨库暂存发布协议

## 范围与不变量

本协议只覆盖 `PUT /api/actor-profiles/:id` 对**一个人物**的资料、JavDB 引用、别名和可选头像写入。主库和 `fanhao_images` 仍是两个独立的 SQLite WAL，不能声称为一个跨库原子事务。

对已有读者保证如下：

- `prepared`、`applying`、`retry_wait` 和 `blocked` 操作的暂存头像永远不可见。
- 完成前读取旧资料和旧头像；完成后读取新资料和与该次发布绑定的新头像。
- 唯一可见性开关是主库的一次 `synchronous=FULL` 事务提交。该事务同时写入资料、引用、别名、`actor_profile_publications` 指针、`cross_store_main_receipts`、`completed` 状态，并释放所有 reservation 和大字段内容。
- 图片库没有“推广到 live images”的步骤。完成后读侧通过主库 publication 指针解析图片库中的不可变暂存行，因此主库开关后不存在 image promotion 失败窗口。

这不是 Filetree 头像导入、Python 刷新、人物合并或作品迁移的跨库原子化方案。这些现有 writer 本批只增加 reservation fence 和 publication 清理；它们原有的跨 WAL 崩溃风险仍需分别迁移。

## 持久化对象

主库：

- `cross_store_intents`：不可变意图、payload digest、request digest 和 idempotency key。
- `cross_store_intent_blob_manifest`：不可变 blob digest/长度清单。
- `cross_store_intent_blobs`：完成前保留的恢复用 blob，完成事务中压缩删除。
- `cross_store_operation_state`：`prepared -> applying -> completed`，可恢复错误为 `retry_wait`，确定性错误为 `blocked`。
- `cross_store_intent_reservations`：意图创建时固化的完整 reservation 清单。
- `cross_store_aggregate_reservations`：活动 fence。
- `cross_store_main_receipts`：最终 `visibility_switch` receipt。
- `actor_profile_publications`：每个人物当前可见的 operation/digest 指针。

图片库：

- `actor_profile_image_staging`：以 operation ID 为主键的不可变版本；update/delete trigger 禁止原地修改。
- `cross_store_receipts`：`image_stage` receipt，绑定 intent digest。

两个专用连接都显式使用 `journal_mode=WAL`、`synchronous=FULL` 和独立事务。

## 写入协议

1. 在主库 `BEGIN IMMEDIATE` 中规范化请求并创建 intent。幂等键与完整 request digest 绑定；相同键不同内容返回 409。
2. 同一事务稳定排序并实际占用这些 key：目标 `person-avatar:<id>`、每个输入 `javdb-actor:<key>`、每个 key 的当前 owner `person-avatar:<owner>`。只检查不落 reservation 不满足协议。
3. 在图片库 FULL 事务中写不可变 stage 和 image receipt。事务外 receipt 查询只作为快路径；取得 `BEGIN IMMEDIATE` 后必须再次校验 receipt/digest，避免旧 lease owner 刚提交时新 owner 因 UNIQUE 被误判 blocked。无头像 payload 仍写 receipt，但不创建 stage。
4. 重新校验 image receipt/stage digest。
5. 在主库一个 FULL 事务内重新检查 lease/reservation，写 profile/refs/aliases，按需切换 publication 指针，写 main receipt，将状态改为 `completed`，释放 reservation 并删除恢复 blob，然后提交。
6. 提交后才通知内存 cache 失效。公开 cache stamp 依赖 `actor_profile_publications`，不依赖不可见的 staging 表。

资料页和头像必须来自同一个 `actorProfileRow` SQL snapshot。Presenter 只消费 `publicActorProfileSnapshot(row)`，不能在 profile cache row 后再次调用 avatar reader。所有 publication reader 同时校验 `state=completed`、main receipt digest、publication digest 和 stage digest。

带 blob 的发布头像 URL 使用不可变版本：`/media/actor/:id/avatar?v=<operation-id>`。媒体 worker 不把 `v` 仅当缓存键，而是校验它属于 `actor_profile_upsert`、operation 已 `completed`、main/image receipt digest 均匹配，并且 stage 属于请求人物。资料页只生成当前 publication 的 URL；已经完成的历史版本仍可按 immutable URL 回读并被浏览器/进程缓存，未知或未完成 token 不返回字节。无 token 的兼容路径表示“当前头像”，每次重新读取且返回 `no-store`，不会在 publication 切换或手工覆盖后复活进程/浏览器缓存中的旧 stage。

## 头像优先级与后续 writer

现有顺序保持不变：

1. `manual_upload`、`manual_person_cover`、`manual`
2. `actor_profiles`
3. 其他来源（包括 local-avatar 来源）

publication stage 只在自己的 source 优先级内代替同来源 live 行，并不跨级压过手工头像。完成后的直接头像替换 writer 必须先在 `BEGIN IMMEDIATE` 中通过 reservation fence，再删除该人物 publication 指针，最后写 live image。删除手工头像时，仅在 publication 自身也是手工来源时清 pointer；若 publication 是较低优先级的 `actor_profiles`，保留 pointer 作为删除手工 override 后的回退。这样既不会让旧 publication 永久遮蔽后续修改，也不破坏原有来源回退顺序；下一次 PUT 可再次建立新指针。

手工覆盖或删除只改变 current pointer/live 候选选择，不会自动撤销已 `completed` 的历史版本。管理员需要明确调用
`POST /api/actor-profiles/:personId/versions/:operationId/revoke` 才会写入不可变 revoke tombstone。人物与 operation
同时作为资源标识，并在主库事务内与原始 intent 重新绑定校验，避免错人或错版本撤销。

revoke 的 `synchronous=FULL` 主库事务同时验证 completed state、main receipt、图片 stage/image receipt，写
`actor_profile_image_revocations`，并以 operation/person/digest 条件仅清除匹配的 current pointer。之后所有 profile、current
avatar 和 versioned avatar reader 都以 tombstone 为权威 deny；已知撤销版本返回 410，版本响应统一为
`Cache-Control: private, no-store`。响应的 `purgeStatus=pending` 表示逻辑撤销已完成、stage BLOB 等待回收，仍返回 200；
回收凭据与删除在图片库 FULL 事务中完成后，幂等重放返回 `purgeStatus=completed`。
相同 revoke 重放是幂等的，并返回原始 reason/time。

每条新 tombstone 还保存由服务端生成的 UUID `request_id`、固定脱敏主体 `caller=local-admin` 和 audit schema version；
这些字段参与 v2 tombstone digest，并与整行一起不可更新、不可删除。HTTP body 中同名字段、path、URL 或 raw error 均不会
进入审计记录，包含路径、URL 或错误文本形态的自由 reason 会折叠为 `manual-redacted`。旧版 tombstone 在一个
`BEGIN IMMEDIATE` + `synchronous=FULL` 迁移中原子补齐服务端 UUID 与 caller，并保留 v1 digest 标记；迁移可幂等重放，
断电不会留下半列或半回填状态。`request_id`、caller、digest、intent 等内部审计字段不进入 revoke HTTP 响应。

stage 回收只处理明确撤销的版本，不推断历史保留策略，也不自动淘汰未撤销历史。启动恢复、revoke 后调度或管理员调用
`POST /api/actor-profile-image-gc` 可推进队列；单个图片库 FULL 事务最多 50 条、最多 64 MiB，不执行 VACUUM。
图片库先写不可变 `actor_profile_image_gc_receipts`（绑定 operation/person/intent/tombstone digest/content SHA-256/bytes），
再由同一专用连接的临时授权通过 DELETE trigger 删除 stage；普通连接 raw DELETE/UPDATE、伪造 receipt 和 GC 后重建 stage
均被拒绝。主库 tombstone 与 main receipt，以及图片库 image receipt/GC receipt 永久保留，支持崩溃恢复和审计。

这是 logical revoke + stage BLOB GC，不是浏览器缓存召回或法证擦除。`no-store` 只约束撤销能力上线后的新响应；撤销前
已经被旧浏览器长期缓存的字节无法从客户端收回，SQLite/WAL 页、文件系统或备份副本也不保证被本协议抹除。immutable intent
的 `payload_json` 及各 receipt 仍可能保留原始 URL/path 等元数据。operation ID 永不复用。若需要元数据脱敏，必须设计
单独的、可审计的 redaction 协议，不能修改既有 immutable intent。

当前直接或同优先级 writer 清单：

| Writer | 写入内容 | 本批约束 |
| --- | --- | --- |
| 单人物 PUT outbox | profile/refs/aliases + staged avatar | 本协议完整覆盖 |
| `legacyUpsertActorProfile` 测试/兼容路径 | `images`，来源通常为 `manual` | `BEGIN IMMEDIATE`、person/actor/owner fence、清 pointer |
| 手工人物头像/人物作品封面 | `manual_upload` / `manual_person_cover` | `BEGIN IMMEDIATE`、person fence；替换时清 pointer，删除时仅清同属手工来源的 pointer |
| Filetree 人物头像导入 | local-avatar 配置来源 | `BEGIN IMMEDIATE`、person fence、清 pointer |
| `refresh_core_javdb_actor_movies.py` | `source=actor_profiles` | `BEGIN IMMEDIATE`、person/actor/owner fence、清 pointer |
| 人物合并 | 改写 person image owner | target/source fence、清两侧 pointer |
| 作品迁移创建/更新人物 | profile/JavDB ref | target/actor/owner fence；不宣称跨库原子 |

`full_scan_core_library.py` 只改写 work image 路径，不写 person avatar。

## 崩溃与错误矩阵

| 停止点/错误 | 主库可见状态 | 图片库状态 | 旧读者看到 | 恢复 |
| --- | --- | --- | --- | --- |
| intent 前 | 无操作 | 无 stage | 旧资料 + 旧头像 | 客户端重试 |
| intent 已提交 | `prepared` + reservations | 无 stage | 旧 + 旧 | startup reconcile |
| image FULL 提交前 | `applying` | 事务回滚 | 旧 + 旧 | lease 到期后重试 |
| image FULL 提交后 | `applying` | stage + receipt | 旧 + 旧 | 幂等复核 stage 后继续 |
| final main 事务写入中/commit 前 kill | 事务整体回滚 | stage + receipt | 旧 + 旧 | lease 到期后重试 |
| final main commit 后 | pointer/receipt/completed 同时可见 | stage + receipt | 新 + 新 | 已完成、重复请求幂等返回 |
| 图片库 `SQLITE_BUSY` | `retry_wait` | 无或已提交 stage | 旧 + 旧 | 自动/显式重试 |
| 确定性 main 失败 | `blocked` + reservations | 隐藏 stage + receipt | 旧 + 旧 | 本地管理员修复后显式 retry |
| cache invalidation 回调失败 | main 已 completed | stage + receipt | 旧 cache 最多延迟到 pointer stamp 刷新，然后新 + 新；不会混读 | stamp 刷新 |

## HTTP 兼容

- 只有 operation 已 `completed` 才返回原有 200 payload。
- 新客户端在 body 显式传 `acceptAsyncOperation: true` 时，暂态可返回 202 和净化后的 operation 状态，并通过 GET 查询。
- 未 opt-in 的旧客户端遇到暂态返回 retryable 503，防止把 pending 当成功。
- `blocked` / `cancelled` 是终态：首次确定性失败和相同幂等键重放都返回稳定 409；不会把 blocked 包装为 202，也不会把它标成可自动恢复的 503。
- `retry_wait` 由后台协调器自动恢复；本地管理员可显式重试 `blocked` operation。
- completed PUT 与随后 `GET /api/actor-profiles/:id` 共用同一 payload helper，均返回 `ok`、`profile` 和 `mergeCandidates`；因此 202 路径不会跳过人物合并候选。
- 明确的网络 `TypeError` / `NETWORK_ERROR` 使用同一个 request body 和 idempotency key 做有限重试。服务端只公开白名单错误 code、稳定文案和净化 operation，不回传 SQLite 错误或本机路径。
- PUT 只允许本地管理员，并在读取可能含头像的大 body 之前完成门禁；GET 保持原有读取权限。

接口：

- `GET /api/actor-profile-operations/:operationId`
- `POST /api/actor-profile-operations/:operationId/retry`（本地管理员）
- `POST /api/actor-profiles/:personId/versions/:operationId/revoke`（本地管理员；逻辑撤销，stage 回收可能待处理）
- `POST /api/actor-profile-image-gc`（本地管理员；仅推进已经撤销的 stage 回收）

## 尚未覆盖的迁移清单

- 将 Filetree/Python/人物合并各自迁入可靠 journal/outbox，消除它们现有的跨库 crash-atomic 风险。
- 若产品需要对未撤销历史版本做自动 retention，需要另行确定保留策略；首版为安全起见完全关闭自动淘汰。
- 若未来继续改变 tombstone/receipt 合约，引入独立 schema version gate；本批只为既有 tombstone 增加一次受测的 audit v1→v2 兼容迁移。
- 单独审查并统一 `PUT /api/people/:id/cover` 等历史写路由的权限策略；本批不扩大到人物封面接口。
- 增加多进程、真实异常断电和长时间 BUSY soak；当前 fixture 使用临时 SQLite、强制 kill 和确定性错误，不访问真实数据库或服务。
