# 小说数据模型 v2：设计提案与验证边界

日期：2026-08-30。状态：**完整领域模型仍是候选；存储分层、旧库取回、稳定来源及同一本书内的稳定章节/待确认进度已接入源码**。文档前半部分记录改造前的诊断，不代表当前全部行为；具体实现与验证边界见末尾的阶段记录，设备安装状态以各轮交付报告为准。本页为仓库内部专题，未纳入正式文档站发布清单。

## 结论

“数据库显得简陋”有代码依据，但问题不是 SQLite 不够高级或表数量太少。当前服务端已有书籍、章节、进度、人工元数据覆盖、删除记录和采集任务；安卓端仍以整本书为 IndexedDB 记录，产品状态也较多依附在这条记录上。更准确的定位是：文件书库和阅读器的基础已存在，独立书架、稳定内容身份、按章离线存储与可恢复进度还没有形成统一模型。

本提案假设近期目标是“个人书库 + 电脑服务端 + 安卓离线阅读”。不假定需要收费、作者后台、推荐平台、社区或多租户运营。先修正数据边界，保留现有 SQLite / IndexedDB 技术路线；引擎替换不是本轮目标。

## 改造前的现状与产品影响

| 现状（代码可核实） | 影响 | 处理方向 |
| --- | --- | --- |
| 服务端主库有六张表；目录查询不取正文，详情按单章读取 | 已有合理基础，无需推倒整库 | 保留查询粒度，逐步调整身份和状态 |
| 安卓 `books.getAll()` 读取整库的完整章节，`localBooks` 长期持有整书 | 展示书架的工作量随书库正文总量增长 | 书架只取摘要，正文按章懒加载 |
| 安卓进度写入 get 整书、规范化所有章节、JSON 估算字节并 put 整书 | 高频小更新触发大对象读写 | 独立 `reading_states`，提交不碰正文 |
| 服务器章 ID 是书 ID 加序号；采集重导按旧序号 clamp 进度 | 前面插章/删章后可能续读到另一段内容 | 稳定章 ID + 目录版本 + 显式位置映射 |
| 旧 `local:remote:<id>` 没有稳定服务端/书库来源域 | 两个服务器同 ID 可能碰撞，旧缓存不能可靠同步回源 | 来源域进入映射键，历史缺失保持未绑定 |
| 本地导入与远端缓存都以整书条目管理 | 书架成员、文件所有权、缓存状态容易混淆 | 分离收藏、内容保留策略、下载任务 |
| 服务端进度表以 `book_id` 为唯一键 | 是每书共享状态，不是现成的每用户云同步 | 明确当前语义；未来同步单独设计身份和冲突协议 |

证据入口：`android-client/www/js/local-novels.js` 的 `loadLocalNovelEntries`、`saveLocalNovelProgress`；`android-client/www/modules/novels/novel-views.js` 的 `loadPersistentLocalLibrary`、`ensureLocalNovelEntry`、`createCachedRemoteBookEntry`；`src/modules/novels/server/store.js` 的 `ensureSchema`、`chapterDetail`、`clampReadingProgress`、`chapterId`。Python 扫描器 `tools/rescan_novel_library.py` 也定义了表结构和序号章 ID，未来必须一起兼容。

这里没有读取真实书库的标题或正文，也没有用服务端读写接口打开真实库。另运行现有 `verify_novel_storage.mjs`：它在临时库完成写入测试，然后只读检查真实库的表结构和总数，结果为 1,001 本、472,817 章、无旧 FTS 表。没有测量真实手机的耗时/峰值内存；上表性能判断来自实际读写路径，不是基准测试成绩。

## 起点等产品能借鉴什么

起点官方介绍包含私人书架、多端阅读进度和章节讨论等独立能力；这些说明产品行为，不透露其内部数据库。[阅文官方产品介绍](https://www.yuewen.com/app/?type=appqd)

阅文公开合作 API 将书籍信息、目录和单章正文分开，目录可包含卷，更新时按章节 `content_md5` 判断正文是否变化。这支持“目录与正文分离、按章增量更新”的方向，但不能据此声称知道起点内部表结构或客户端实现。[阅文开放平台业务规则](https://open.yuewen.com/docs/1004.html)

“笔趣阁”未指定具体应用、站点或发行方，不能当作一个架构统一的产品。对于多来源阅读器，可以讨论来源规则、书籍映射、换源和离线缓存等需求；这属于我们针对需求的设计推导，不是对某个笔趣阁数据库的事实描述。

Android 官方离线优先指南强调由数据层协调本地与网络来源、向 UI 提供一致数据。这是本提案设置统一仓储接口的参考，不表示现有应用已经实现了完整离线同步。[Android 离线优先架构](https://developer.android.com/topic/architecture/data-layer/offline-first)

## 身份与版本：先说清楚“同一本书”

- `libraryId`：个人书库的作用域。当前可以只有一个本机默认库，不需要先做账号系统。
- `workId`：作品身份。是独立分配的 opaque ID，不从标题、作者、路径或网址直接生成。仅同名不能证明同作品。
- `editionId`：可阅读版本的身份，属于一个作品。来源不同、译本不同或拆章不兼容时默认独立；只有明确映射后才关联同作品。常规修订更新其内容版本，不必每次生成新 edition。
- `realm`：稳定来源权威，例如 `device:<instanceId>` 或 `server:<libraryUuid>`。可变的服务器地址是 locator，不是 realm。服务器是否支持稳定 UUID 要另行实现和验证。
- `source_binding`：某个 realm 下的来源条目与 edition 的映射。外部 ID 只在自己的来源域内有效。采集器规则、运行任务和来源条目是三件事。
- `chapterId`：edition 内稳定的章身份。序号只负责排序，不能兼任身份。

本提案要求 `workId`、`editionId` 使用全局唯一分配（例如随机 UUID，并在写入时检测冲突），不能仅因称为 opaque 就假定唯一。下文子实体简写 editionId 键基于这一约束；每个仓储实例绑定 libraryId，仍须验证 edition 的书库归属。若实际实现只能保证库内唯一，则所有子键、外键及查询都必须同时携带 libraryId，不能混用两种约定。

旧书第一次迁移时每条记录默认各自获得 work、edition，不按同名自动合并。旧 ID 不改写或丢弃，而是保存别名映射；旧目录的序号型章 ID 还必须附带迁移目录版本，不能跨版本直接重用。别名键使用结构化 tuple `(libraryId, realm, legacyId)`，不用易碰撞的分隔符拼接。

旧远端缓存缺 realm：保留原始来源 ID，标记 `unbound`；仅在本机旧库实例范围记录迁移映射，**不得把当前 activeUrl 推断为原服务器**。缺来源的旧缓存可能已经是唯一可读副本，先按 protected 保留；未验证绑定之前不自动同步或自动淘汰。

版本字段分工：`schemaVersion` 管数据库结构；`catalogRevision` 管目录成员与排序快照；`contentRevision`/章内容摘要管正文变化；`readingStateVersion` 管进度并发更新。`updatedAt` 只作展示/审计，不证明因果关系。正文摘要采用带算法及文本规范化版本的定义；它不是来源授权凭据，也不作为全局作品 ID。

## 最小逻辑模型

下表是职责和约束，不要求客户端与服务端拥有完全相同的物理表；也不是一轮全部上线的建表清单。

| 实体 | 关键字段/键 | 负责什么、不能混入什么 |
| --- | --- | --- |
| `works` | `(libraryId, workId)`，title、author、用户覆盖字段 | 作品信息；同名允许存在，不承载进度或全文 |
| `editions` | `(libraryId, editionId)` → work；activeCatalogRevision、contentRevision、lifecycleGeneration | 阅读版本与已提交目录；路径不作主键 |
| `source_bindings` / `legacy_aliases` | 来源 tuple 唯一 → edition；bindingStatus、kind、受保护 locator | 来源映射与兼容旧 ID；不携带凭据到 UI/同步 DTO |
| `chapter_metadata` | `(editionId, catalogRevision, chapterId)`；ordinal、title、bodyRevision、digest、charCount | 目录顺序；同目录 ordinal 唯一、章 ID 唯一；不含正文 |
| `chapter_contents` | `(editionId, chapterId, bodyRevision)`；content 或已提交 payload 引用、byteCount、digest | 按章载荷；正文修订与目录切换一致，不可用新目录配旧正文 |
| `shelf_items` | `(localProfileId, editionId)`；present、groupId、pinned、addedAt、provenance | 是否在书架上，独立于“读过”“下载过” |
| `reading_states` | `(localProfileId, editionId)`；chapterId、catalogRevision、bodyRevision、position、version、resolution | 阅读位置；允许 unresolved 并保留旧锚点，不塞全文 |
| `content_retention` / `download_jobs` | edition/章修订键；ownership、pin、available、generation；任务状态/失败原因 | 正文是否可淘汰、离线是否完整、任务是否完成是不同状态 |

`localProfileId` 当前只能表示设备上的默认个人档案，不能冒充已验证账号；现有服务器共享进度保留 shared/legacy 语义，未来由用户明确选择归属。

优先实现的物理拆分是“书籍摘要、目录、单章正文、阅读状态、书架状态”，附带必要的迁移元信息与旧 ID 映射。作品/版本可以先是一对一，分组、卷、书签、笔记等按实际功能再扩展；不为显得复杂而制造空表。采集任务库继续独立运行，其产物通过导入事务进入阅读库。

正文保留规则：`imported/owned` 是用户资产，不能加入缓存 LRU；来源未绑定是 protected；来源已验证、用户未固定保留且策略允许的派生副本才是可淘汰缓存。源 URI 的存在不代表权限永不失效，也不代表原文件仍存在。保存当前解析后的章节文本不等于保留了原 TXT 编码、换行和原始字节。

## 仓储读写契约

| 操作 | 可访问的数据 | 结果与约束 |
| --- | --- | --- |
| `listShelf(profile, page)` | shelf + 书籍摘要 + 小型进度/离线摘要 | 稳定分页，不读 legacy 整书或章节正文 |
| `listChapters(edition, revision, page)` | 目录元数据 | 含 stable chapterId 和顺序，不返回正文 |
| `readChapter(edition, chapter, revision)` | 精确目标元数据/正文 | 校验所属 edition 和修订，缺缓存显式 unavailable，不偷换其他章 |
| `writeProgress(edition, expectedVersion, position)` | edition/目录存在性 + reading state，未来可加 outbox | position 必含调用者捕获的 generation、catalogRevision、bodyRevision；不读写正文；旧 generation/不匹配版本拒绝；提交后才通知 UI 成功 |
| `setShelf(edition, state)` | shelf | 移出书架不删除进度或正文，不假定读过就等于收藏 |
| 导入/重导 | staging 内容 + 目录 + 身份映射 + 进度映射 | 校验后原子发布同一修订，失败不露出半本书 |

这里的并发版本必须来自发起阅读/写入的旧上下文，不能在提交时读取当前版本再补上，从而绕过陈旧写入检查。这是生产仓储的目标契约，不是本轮两个候选已完整实现的保证。

返回值必须是明确的 `BookSummary`、`ChapterMeta`、`ChapterContent`、`ReadingState`，不是有时带章节有时不带的同一种 entry。当前 `ensureLocalNovelEntry` 把 Map 命中等同于正文齐全，因此不能只改 `getAll()` 字段就宣称完成懒加载；详情、阅读器、导入、远端缓存、导出和删除调用方都需要适配。内存中仅保留有界书架摘要和有限章预取；具体上限经真机测试确定。

## 重导入后的阅读位置

先确认 edition 相同，再映射章节；不能跨作品或跨版本猜测。保守匹配候选按以下顺序使用：同一可信 source binding 下双方唯一的上游章 ID；双方唯一的标题+精确正文；双方唯一的精确正文；唯一标题仅作待复核的章定位提示。重复正文、同名章和冲突证据要保留歧义，不能依靠“最像”自动续读。

| 情况 | 候选结果 |
| --- | --- |
| 前面插序章/换序，原章正文完全相同且能唯一匹配 | 复用章身份和原章内比例，更新目录位置 |
| 同一可信上游章 ID 保留，但正文已改变 | 可复用章身份；比例不再可靠，返回 reset/needsReview 并保留旧位置 |
| 只有唯一标题一致，正文改变 | 使用新章 ID，仅提示章首候选；不复用旧章身份，不标记为精准续读成功 |
| 原章被删除、重复内容导致歧义、edition 不同 | unresolved，保留旧锚点供用户选择，不 clamp 到某个新序号 |

现有滚动比例受字号和排版影响，并非跨设备精确位置。第一步保留 legacy ratio 并标明精度；后续引入正文修订绑定的字符/段落锚点时，需定义偏移编码与规范化规则。未完成这些定义前不宣称精确跨端续读。

候选纯函数只验证内存中的身份/位置规则；它不执行真实数据库重导事务、不证明上游 ID 可信，也不自动建立书籍来源关联。调用者必须先校验传入的旧目录/正文快照确实对应保存进度的修订，不能把任意较新的同 ID 章节当作旧快照。

## 兼容迁移与回滚

1. **迁移前**：盘点旧记录数、章节数和可用空间；备份与用户书籍同样按敏感数据保护。损坏记录显式报告，不静默 skip，不通过 normalize 后覆盖旧行。旧 unknown 字段保留。
2. **连接协调**：旧连接响应 versionchange 并关闭；处理 blocked、同步 open 失败、迟到 upgrade、quota、abort。旧客户端无法理解新结构时明确失败或受控只读，绝不能删库重建。
3. **构建候选**：分配 opaque IDs，建立别名，逐书/逐章拆分，单独迁移书架与进度。只在原目录内把可验证的旧索引映射到该章；不存在/矛盾进度保留 unresolved。旧可见条目默认进入书架、provenance=`legacy-visible`，不伪称用户主动收藏。
4. **原子激活**：本轮 SQLite 沙盒选择 DDL、回填、完成标记和 schemaVersion 同事务提交，任意中途失败全部回滚。安卓生产方案必须另做真实 IndexedDB 验证，不能把 SQLite 事务结论直接套用；事务中不得随意 await 网络/异步计算。若大库无法承受单事务复制，应另评估带 generation 的分批 staging + 原子激活，不悄悄削弱一致性。
5. **校验与重入**：旧存储保持不变，验证逐章文本、字段白名单、身份唯一性、跨书隔离、版本及进度语义。迁移完成后再次调用必须 no-op，不能覆盖新的进度，也不能从旧副本复活已删书。
6. **切换读取**：新模型就绪才切换仓储；书架/进度不回退到 legacy 全文读路径掩盖缺失。保留恢复入口，损坏/不完整状态对用户可见。
7. **回滚边界**：提交前失败可回滚；上线后产生新进度/书架状态，不能仅降 schemaVersion 或恢复旧快照就称无损回滚。必须保留并转换新写入，或告知回退会丢失的范围。清理旧副本需要另一个明确的保留期限/清理操作。

沙盒以 JSON 文本模拟旧行，验证原 JSON 字符串不变。真实 IndexedDB 存的是 structured-clone 对象，因此它不是原始 IndexedDB 文件的字节级迁移证明，也不是原 TXT 的字节级备份证明。逐书复制仍可能持有“一整本旧记录”，本轮没有证明旧数据迁移的 O(1) 内存或任意规模可用性。

删除语义单独定义：移出书架只改 shelf；清理缓存只移除可淘汰派生正文；本机永久删除涉及正文、来源信息及仍保留的迁移副本；服务端删除需要现有管理员授权。每类操作带 scope/generation，迟到进度、下载任务和同步回复不得复活已删记录。沙盒的“删除后重跑迁移”仅验证新模型不复活，**不是已经实现包括旧备份在内的永久删除功能**。

## 未来同步：先保留边界，不在本轮联网实现

仅在用户启用且来源绑定已验证时，同步白名单允许的状态。局部 `localProfileId` 和旧共享服务端进度不能自动变成账号身份。本地导入正文不得因为升级模型而自动上传。

离线写入拟使用 `operationId`（幂等）、`deviceId + deviceSequence`（单设备顺序）、`baseServerVersion`（并发基准）以及确认状态；本地状态与 outbox 同事务提交。两设备独立移动位置时保留冲突信息，不按最大章数或设备墙钟最大值合并，因为用户可能主动回读。正文变动冲突与设备进度冲突分别处理。

同步/日志 DTO 采用白名单，不直接 spread 旧 book。现有 `sourceKey` 可能包含正文首尾片段；URI、源文件路径、服务器地址、来源凭据以及未知字段都不应出现在遥测或默认同步中。书名/简介也可能敏感；展示白名单不等于允许上传的白名单。

## 分阶段落地与验收

- **设计轮（已完成）：模型候选与合成验证。** 文档、纯函数规则、SQLite 沙盒；这一轮没有改生产读写、升级 DB 或生成新 APK。
- **第一阶段：安卓存储解耦。** 保留旧 ID 兼容入口，建立摘要/目录/正文/进度/书架仓储；用隔离浏览器与真机覆盖升级、失败恢复、旧连接、存储不足、导入/阅读/导出全链路。
- **第二阶段：稳定身份和重导契约。** 联动服务端、Python 扫描器、采集导入器；兼容旧 API，校验前插章、删除、重排、正文修订与歧义映射。
- **第三阶段：产品能力。** 独立书架分组、书签/笔记、按章下载、断点任务；需要跨端时再实现可靠同步和用户身份，不先承诺已具备。

生产上线前的硬性验收：书架和写进度不访问正文；书库增长不导致列表持有所有正文；单章读取不串书；迁移失败旧数据可读；缺来源缓存不丢；删除后旧异步请求不能复活；换序不串进度；真实 Android WebView 的 quota/blocked/中断恢复通过。SQLite 合成测试绿色只覆盖其中的模型和 SQL 约束。

本轮独立验证入口（不加入生产验证门禁）：

```powershell
node tools/verify_novel_identity_progress.mjs
node tools/verify_novel_storage_model.mjs
```

前者验证身份、章匹配和进度映射，并用冻结的现行 clamp 函数及小型 fakeDB 做负面对照；后者使用临时 SQLite 与合成 JSON，验证拆分、事务和访问隔离。两者都不是对真实书库执行的迁移脚本。具体验证结果和未覆盖项由运行输出报告。

候选与目标方案的差别也要保留：SQLite 沙盒缺 realm 的本地导入仍标 unbound/durable，没有实际生成本机安装 realm；它的进度 revision 只是本地写入计数，没有实现 expectedVersion 或目录/正文修订校验；其缓存候选查询只演示保守保护条件，没有实现来源再获取验证、完整离线固定策略或自动清理。沙盒私有版本 2 不是安卓 IndexedDB 已升级到 v2。

已运行的验证记录：身份/进度候选通过 43 个场景、64 次组合位置检查；6 个现行算法负面对照均出现预期失败，6 个错误变异实现被测试拒绝，冻结函数与现行源代码的文本及 SHA-256 一致。现有安卓本地存储回归 16/16 通过。主代理另独立运行内存 SQLite 检查，确认完成标记写入后异常仍回滚版本、真实 SQL 授权拒绝正文/旧行读取时书架与进度可正常操作，以及删除后重跑迁移不复活。

持久化 SQLite 验证器已独立复跑通过：**6 个场景、342 条断言**。覆盖五个迁移故障注入点的 DDL/数据/版本回滚及关闭重开后重试、损坏记录整批失败、真实 SQLite 授权拒绝正文/旧行的读写、单章读取与跨书库/edition 隔离、进度/书架/删除事务回滚、原 JSON 字节不变、迁移完成后重开不覆盖新状态也不复活已删条目。直接 SQL 负例还检查了复合外键、章节排序唯一约束，以及 resolved 进度不能含 NULL 比例；不是只测试 JavaScript 参数检查。未覆盖目录/正文修订并发检查、进程强杀、掉电或磁盘满。所有写入均在内存或私有临时库，测试已清理其生成的临时文件。

待确认但不阻塞设计的产品选择：默认把旧可见条目保留在书架；不明来源副本默认受保护；歧义进度默认保留待选择；优先做好个人阅读而不是商业平台。这些默认值需要在生产切换前确认。

## 安卓存储第一阶段实现记录

2026-08-30 后续实现：仅落地物理存储分层和必要的调用方兼容；没有声称完整领域模型已经完成。保留现有 book/chapter ID、服务端协议、离线书库可见性及删除含义，不引入用户账号、来源猜测、自动缓存清理或正文上传。

IndexedDB 版本现为 2，保留 legacy `books`，新增以下 object stores：

| 存储 | 内容 | 主要读写者 |
| --- | --- | --- |
| `bookMetadata` | 白名单书籍摘要、generation、内容字节数 | 书架、详情、进度校验 |
| `chapterMetadata` | `[bookId, index]` 目录，不含正文 | 目录和章节存在性校验 |
| `chapterBodies` | 同复合键正文及未知章节字段 | 单章阅读、显式整书导入/导出 |
| `readingProgress` | 每书阅读位置，绑定导入 generation | 进度独立提交 |
| `bookExtras` | 旧记录、book、progress 的未知字段 | 仅整书兼容入口 |

`loadLocalNovelSummaries` / `readLocalNovelSummary` 不访问目录正文；`readLocalNovelCatalog` 只读摘要和目录；`readLocalNovelChapter` 精确读取一个正文 key，缺章返回空，不跳到第一章。UI 的 `localBooks` Map 只保存摘要；整书兼容读取只用于 TXT 导出和重导，导入、远端缓存完成后也只把摘要放回 Map。目录目前仍全量读取元数据，书架仍全量读取摘要；不是分页或任意书库规模的 O(1) 保证。

`saveLocalNovelProgress` 不读写正文、unknown extras 或 legacy 整书，不重复整书字节估算或持久化请求；调用方必须携带打开该版本时捕获的 `localGeneration`。重导分配新 generation，旧会话写入无法覆盖新书。API 在事务 complete 后才成功返回；请求 success 后事务 abort 仍失败并保留旧状态。UI 分开维护正文失效代次和本地进度代次，迟到摘要/目录/书架结果不能盖过新进度，也不会因进度完成而取消正在加载的新章。

升级使用同一个 versionchange 事务创建存储并逐书拆分；原始 legacy structured-clone 行保持不变，Date/Blob 等 unknown 字段保留，正文文本不改写。损坏行整批失败，不静默跳过；blocked、同步 open 失败、open 超时、迟到 upgrade 及旧请求失效回调有隔离保护。删除沿用“本机删除这本书”的原语义，同事务删除各新存储及该书 legacy 副本，防止旧副本复活；还没有独立“移出书架”状态。

验证分开计数：

- 模拟 IndexedDB 回归：26 个当前源码场景加 1 个冻结 v1 正文访问负控，合计 27 项，使用开发依赖 `fake-indexeddb`；不能代替原生引擎证据。
- 原生浏览器 IndexedDB：17 场景、148 项检查。每次运行固定源码快照，仅替换 DB 名，使用随机 UUID 的合成数据库，全部清理成功。涵盖升级原子性、unknown 字段、正文访问隔离、单章定位、save/progress/delete 中止、旧 generation、blocked/超时的迟到 upgrade、失效连接 owner。
- 阅读器：38 当前场景、16 历史负控和 4 分层存储变异负控；导入：73 当前场景、46 历史负控。旧 v1 单存储的 16 场景移到冻结 fixture，不能算作新 v2 证据。

入口：`node tools/verify_android_local_novel_storage.mjs`，以及 `node tools/serve_android_novel_storage_v2_fixture.mjs` 后在输出的隔离页面点击“运行隔离测试”。浏览器夹具不是生产数据库工具，也不提供实际书库迁移命令。

仍需完成：真实 Android WebView 及设备存储不足/系统杀进程验证、实际大库迁移内存和额外空间评估；稳定 work/edition/chapter 身份、来源域碰撞、独立 shelf、按章任务和可靠同步仍属于后续阶段。面向用户的失败重试及只读正文取回入口见下一节。保留旧副本会占额外空间，升级后直接恢复旧副本会丢失新版进度等写入；不得把事务前回滚或旧行保存解释为上线后的无损降级。测试没有安装 App，也没有迁移用户的真实 IndexedDB。

第一阶段候选交付位于 `outputs/android-novel-storage-v2-20260830-7c81a924/REPORT.md`：8 组完整回归和独立 APK 构建通过；包内存储源码 SHA-256 与原生浏览器固定快照一致，全部 413 个源输入在打包结束及最终审计时未变。该候选包不是已完成真实 WebView 数据迁移验证的上线版。

## 只读旧库取回与错误状态

2026-08-30 后续实现增加明确的失败状态：列表、详情、阅读器不再把存储异常解释成空书库或已删书；保留已有摘要与选择，允许正常重试和继续查看可用的远端内容。普通导出的读取失败使用明确的“重试导出”文案。

取回入口独立于正常阅读：`listLocalNovelRecoveryBooks` 按游标最多返回一页摘要，UI 每页 10 本；`readLocalNovelRecoveryEntry` 仅在用户选中单本时取回可读章节。两者使用无版本参数的打开请求，只允许已有 v1/v2 旧 `books` 的只读事务；不存在的库会中止创建，不触发升级、写回、清库或上传。事务完成后才返回结果并关闭连接。

旧键保留 IndexedDB 原生类型，后续页与正文请求绑定首次读取的数据库版本。版本变化后旧列表失效，必须显式重新打开。v2 的旧副本明确标为升级前内容，不能覆盖或冒充当前新版正文。损坏章节不自动修复；导出根据本次实际读取说明可读数和遗漏数，部分内容或数量变化需要再次确认，单本输出受 80 MiB UTF-8 字节限制。

导出的 TXT 仅含可读正文及章节标题，不包含未知元数据、来源信息或阅读进度，不是完整备份。系统保存取消、保存失败和成功分别提示；离开页面或关闭取回窗口后，迟到的正文读取不能启动新的导出。恢复区域使用应用的浅色/深色主题变量。

验证入口与边界：

- `verify_android_novel_recovery_storage.mjs`：24 个完整源码模拟 IndexedDB 场景、4 个明确限定的生命周期边界，以及 10 个可执行变异负控；不替代原生引擎证据。
- 原生浏览器 IndexedDB 夹具已扩至 26 场景、304 项检查，包含缺库不创建、损坏旧库取回、原生类型游标、只读事务和 v2 旧副本隔离；使用随机合成库并清理。
- `verify_android_novel_recovery.mjs`：39 个当前源码 UI 场景、5 个可执行变异负控和 1 条静态 CSS 主题契约。迟到远端详情目录由已有书籍身份校验拦截；新用例证明既有保护有效，不是新增生产修复。
- `serve_android_novel_recovery_fixture.mjs` 提供真实页面交互验证，使用固定源码快照、随机合成旧库、合成远端响应和模拟保存。实际文件选择器、Android WebView、磁盘满、强杀及真实书库迁移仍未验证；静态 CSS 契约也不等于渲染或对比度证明。

相关候选产物与完整验证记录集中在 `outputs/android-novel-recovery-20260830-c925f6a8/`，以该目录实际报告为准，不据本节文字推断已安装或发布。

## 稳定书库来源第一步

2026-08-30 后续源码实现：服务端和 Python 扫描器在 `novel_meta` 中一次性生成并持久化 `library_id`，小说 JSON 响应带 `sourceRealm = server:<UUID>`。旧 v4 库只补元信息，不重编书/章节 ID。数据库复制保留同一身份；若复制后要成为独立分叉库，必须另行设计显式分叉操作，不能把副本自动当作新库。已有非法身份或未来 schema 会拒绝初始化，不重新分配身份；TXT 下载仍只读，不因下载触发补写。

安卓整书缓存按 `(sourceRealm, sourceBookId)` 生成可逆的本机键。相同 bookId 的不同书库分开保存，换地址但服务端身份相同时可重新确认后关联原缓存。来源域不从 URL、书名或文件路径计算。旧无来源副本保持原 ID、本地可见、可阅读/导出/明确删除，不自动猜测归属，也不因远端同 ID 而被去重隐藏。旧服务端无 realm 时在线阅读兼容，但新建整本缓存要求更新服务端。

地址到来源的回执保存在可丢弃的响应缓存中，只表示该地址最后观察到的服务器声明。无回执时不从本机书籍集合猜测；网络响应明确没有身份会清除已知关联；已确认的新身份不会被旧缓存响应覆盖。离线无法判断同一地址是否已换库，缓存失效、版本升级或回执被清理后需要联网重新确认，所有本机缓存仍能用自己的本机 ID 直接打开。这不是永久来源目录或联网身份认证机制。

目录准备、详情分页和逐章缓存固定操作开始时的来源及地址，每个正文响应校验 realm、书 ID、章序号及正文完整性；来源/页面失效后不保存混合整本或重绘旧页。提交已启动的本机事务可能在离页后完成，但只写捕获的来源键，不会写入新书库。预取键包含 realm；阅读进度请求及远端删除携带可选 realm 前置条件，服务端遇到不匹配返回 409，旧客户端不带字段的共享语义不变。

验证入口：`tools/verify_android_novel_source_identity.mjs` 执行完整页面源码的合成网络/存储场景；`tools/verify_novel_library_identity.mjs` 执行真实临时 SQLite、实际 Python 扫描器和错误实现负控。旧 reader/recovery 中用于测试“已绑定正常缓存”的样本同步改成明确的 realm/来源回执，保留原异步断言；旧未绑定副本的行为由新专项独立覆盖。两项已分别加入安卓与小说回归命令。实际结果以本轮运行记录为准，不把脚本存在视作验证通过。

仍未完成：稳定作品/版本/章节身份、目录/正文修订校验、独立书架、跨端冲突同步、真实 Android WebView 切库与升级验证。本阶段没有迁移真实小说库、安装手机或发布；此前恢复阶段 APK 不包含本节新实现。

## 稳定章节身份与待确认续读实现记录

本阶段在同一既有 book 范围内实现章节身份；没有把路径生成的书 ID 升级成跨来源 work/edition，也不自动合并同名书。服务端 SQLite schema 5 与安卓 IndexedDB 3 沿用原有书 ID，旧唯一章节 ID 作为 opaque ID 保留，新章节分配独立身份。目录 ordinal/index 仅负责排序与旧接口兼容。

Node、Python 扫描器和安卓本地协调器执行同一组共享合成用例。只有完整旧、新快照内各自唯一、非空且逐字相同的正文才能保留章节 ID；不把标题、散列或剩余未匹配集合当作唯一性证明。唯一同名但正文变化只产生待复核候选，候选有新 ID、当前版本、零比例；重复正文、删章或证据矛盾则不猜。

- `book.catalogRevision` 标识目录与正文的同一快照，每次整书替换更新；不是独立正文修订或多设备同步时钟。
- `book.progress` 只提供可安全恢复的 `{chapterId, chapterIndex, scrollRatio, catalogRevision}`。
- `book.progressRecovery` 保存 `{status, reason, previous, candidate?}`，状态为 `needs_review` 或 `unresolved`。旧位置包含章 ID/序号/比例/原版本及可用标题，不能因之后重导自动恢复；旧候选过期后只保留未决旧锚点。
- 无版本的旧进度迁移成 `legacy_unverified`，原记录保留、需确认一次；不把数据库升级成功当作历史定位已被证明。

服务端书、目录、正文读取共享 SQLite 读事务，避免 Python 重扫在相邻 SQL 间提交而把旧 revision 配给新正文。新版进度在同一写事务检查 realm/revision/chapterID/index；重导后的旧 index-only 写入以及可能抹除待确认状态的旧写入被拒绝。旧按序号读取仍保留，但不承诺跨请求快照一致性。

安卓 v2→v3 升级只读取当前分层 stores；不重放 legacy `books`。索引、正文身份绑定、进度分类和全部数据写入在同一个 versionchange 事务中完成，失败整体回滚。旧副本取回支持 v1/v2/v3，仍是只读显式导出。导入在事务内读取最新进度，并检查调用方捕获的 expectedGeneration；两个旧快照导入不能互相覆盖，删除后旧任务不能复活书籍。

安卓详情保留旧位置并提示确认。普通“继续”进入确认详情，候选或目录的明确选择才允许建立新位置。主宿主导航、模块路由、读章请求、预取、目录分页和进度写入都传递所打开版本的锚点。整本缓存要求各响应 realm、书 ID、章节 ID、catalogRevision 一致；更新缓存优先协调本机旧进度，首次缓存才按 sourceChapterId/sourceCatalogRevision 精确映射服务端进度。

验证入口：`tools/verify_novel_chapter_identity.mjs`（真实临时 SQLite、Node/Python 协调、实际 routes）、`tools/verify_android_local_novel_chapter_identity.mjs`（生产存储与事务仿真）、`tools/verify_android_novel_chapter_identity.mjs`（完整页面模块及实际导航接线）；这些不是实际 Android WebView。另有 `tools/serve_android_novel_chapter_fixture.mjs`：浏览器原生 IndexedDB、随机合成库、冻结完整存储及纯协调模块，只替换 DB 名，不打开真实书库。具体运行次数、源码哈希与结论以交付报告为准。

仍待完成：独立书架和缓存生命周期、跨文件/来源作品及版本关系、多设备进度冲突合并、Android 真机存储压力/中断恢复与大库性能。本文不把这一章身份改造称为完整领域模型已完成。
