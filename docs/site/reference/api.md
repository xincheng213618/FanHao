---
title: 接口契约与定位
description: 从真实路由确认访问权限、输入输出和副作用，避免把旧接口清单当作完整规范。
status: maintained
verified_at: 2026-10-24
sources:
  - src/platform/server/http-app.js
  - src/platform/server/auth.js
  - src/platform/server/responses.js
  - src/modules/system/server/runtime.js
  - src/modules/short-videos/server/routes.js
  - docs/api-reference.md
  - src/modules/fanhao/server/duplicates/runtime.js
  - src/modules/fanhao/server/duplicates/service.js
  - src/modules/fanhao/server/duplicates/availability.js
  - src/modules/fanhao/server/duplicates/index-cleanup.js
  - tests/verify_duplicates.mjs
  - tests/verify_duplicate_index_cleanup.mjs
  - tests/verify_duplicate_identity.mjs
---

# 接口契约与定位

新站提供接口的发现和核对方法，不生成未经完整校验的 OpenAPI 声明。
历史接口清单保留在仓库 `docs/api-reference.md`；涉及修改时，以目标模块的当前路由为准。

## 沿请求处理链阅读

1. `src/platform/server/http-app.js`：确认公共入口、预检、鉴权和模块分发。
2. `src/platform/server/auth.js`：确认请求来源、会话与变更授权。
3. `src/modules/<id>/server/routes.js` 或运行时的路由入口：找到实际处理器。
4. 服务/Store/Worker：确认最终数据行为与错误传播。
5. 对应 `tests/verify_*.mjs`：核对已覆盖的输入、拒绝路径与恢复行为。

共享入口不意味着每个接口有相同鉴权、返回结构或副作用。逐项核对调用链。

## 一份接口说明应包含什么

| 字段 | 写法 |
| --- | --- |
| Method / Path | 与当前路由逐字一致 |
| 访问条件 | 是否需要会话、可信来源、变更授权 |
| 输入 | 查询、Header、正文中的必填项、默认值、边界 |
| 输出 | 实际字段和示例，避免真实媒体路径及个人内容 |
| 错误 | HTTP 状态、暴露的错误字段、是否可重试 |
| 副作用 | 只读、缓存写入、数据库变更、后台作业或文件删除 |
| 恢复 | 幂等键、任务查询、回执、超时后如何确认结果 |
| 证据 | 路由与实现路径、验证脚本、核对日期 |

只描述一个接口或紧密相关的接口组，避免长期维护一份超长、人工复制的全量表。

## 常用发现入口

| 目的 | 查阅位置 |
| --- | --- |
| 健康、系统和模块元信息 | `src/modules/system/server/` |
| 番号、人物和作品 | `src/modules/fanhao/server/` |
| 图库、漫画与图片索引 | `src/modules/photos/server/`、`src/modules/content-index/server/` |
| 短视频列表和动作 | `src/modules/short-videos/server/` |
| 影视播放和扫描 | `src/modules/media/server/` |
| 音乐列表与媒体读取 | `src/modules/music/server/` |
| 小说内容与采集 | `src/modules/novels/server/` |

~~~powershell
# 只读取源码，不调用真实接口
rg -n 'pathname|request.method|url.pathname' src/modules/system/server
rg -n 'operationId|retryable|statusCode' src/modules/short-videos/server
~~~

源码搜索是定位工具，不应仅通过正则匹配就声称已经生成完整 API 规范。

## 变更前的检查

- GET 的实现也可能涉及缓存；不把 HTTP 方法当成无副作用证明。
- 删除/移动接口使用临时目录与临时数据库验证，不拿真实媒体试验。
- Android 和 Web 请求应共同核对；服务端接受幂等键不代表客户端已正确采用。
- 错误是否暴露给客户端需要看当前响应实现，不能只凭内部 `statusCode` 推断。

## 重复文件比对

Web 入口为 `/fanhao/duplicates`，位于番号侧栏的管理区域。接口统一要求本机或局域网同源管理权限。

| Method / Path | 输入与行为 |
| --- | --- |
| `GET /api/fanhao/duplicates` | `q` 搜索番号、标题、名称或路径；`offset` 为非负整数，`limit` 为 1–50，默认 20。读取索引与匹配身份的现有探测缓存，检查候选路径状态后返回摘要和分页候选组。`refresh=1` 强制更新快照。此接口不写数据库。 |
| `POST /api/fanhao/duplicates/resolve` | `groupId`、`fileId`；复核当前作品归属、文件身份及资料库边界后，返回播放器地址。 |
| `POST /api/fanhao/duplicates/recheck` | `groupId`；检查本组文件状态并清理确认缺失的本地索引，返回剩余文件、`missingFileIds`、`warnings` 和 `cleanup`。磁盘离线、身份变化、权限或归属错误保留为待确认。 |
| `POST /api/fanhao/duplicates/cleanup` | 可选 `q`、`groupId`；刷新并检查指定搜索范围或组的原始重复候选，包含列表已隐藏的失效路径。复核当前数据库行身份、真实路径边界和在线根目录后，事务删除失效的 `local_files`；整个目录确认消失时一并删除其 `local_works` 与目录内文件索引。返回删除索引的 ID、待确认数量和警告。 |
| `POST /api/fanhao/duplicates/probe` | `groupId`，可选 `fileIds`；显式读取媒体参数，结果可进入既有探测缓存。返回更新后的完整候选组。 |
| `POST /api/fanhao/duplicates/check` | `groupId`，可选 `fileIds`；建立内存校验任务，返回 `job`。所选文件最多 64 份，显式子集至少两份；同一时间仅运行一个完整内容校验。 |
| `GET /api/fanhao/duplicates/checks/:id` | 返回任务状态、读取字节进度、逐文件结果及确认一致的子组。 |
| `POST /api/fanhao/duplicates/checks/:id/cancel` | 请求取消；当前物理读取与文件句柄释放后，任务才结束。 |

VR 作品在候选生成和摘要统计之前排除，依据 VR 存放位置、明确标记、作品资料及 VR 番号前缀识别。普通影片按明确的番号和分卷归组；不同版本可比较，同号或同大小不证明内容相同。大小不同无需计算完整哈希；只有完整 SHA256 相同才报告本次校验内容一致。不同网络共享不能仅凭相同设备号、inode 判定为同一文件。校验前后复核原生文件身份、实际路径和当前索引，发生变化的结果不参与一致判定。

列表不隐式探测或完整读取影片。比对与校验不移动、删除媒体。每条记录上方的“忽略本组”收起整组并禁用后续媒体参数读取与校验，可恢复；文件上的“保留”可选多份。未忽略的组排在前面，已忽略的组排在后面，两部分各按本组文件合计体积从大到小排列，再按每页 20 组分页；恢复后回到未忽略组中的体积顺序。浏览器分批读取当前搜索结果的索引元数据并短暂缓存，重新读取索引会强制更新。选择按文件路径、大小和修改时间保存在当前浏览器；组内文件发生变化时旧的整组忽略标记失效。旧版单文件忽略标记保留恢复入口。每条记录上方的“打开文件夹”对本组目录去重：同目录直接打开，多目录先列出供选择；复用 `/api/open-folder` 的目录校验，打开的是服务所在电脑的目录。

列表加载自动排除确认不存在的候选，重新读取及重启后仍按实际文件状态判断；离线磁盘、访问失败或越界链接保留为待确认。只检查候选路径的文件系统元数据，不遍历全库媒体内容。手动删除后，“检查文件是否还在”同步清理本组失效数据库索引；“清理失效索引”处理当前搜索范围中的原始重复候选，包含已自动隐藏的记录。清理保留 `works`、收藏、观看记录和其他作品资料，提交后重载馆藏缓存；不执行物理文件删除，也不清理非候选作品。正在进行媒体读取或作品移动时拒绝清理，SQL 失败整体回滚。已经清掉的文件重新放回后需要重新扫描入库。任务离页后继续，重启服务后内存校验记录失效并可重新发起。常见拒绝包括参数无效 `400`、文件或任务缺失 `404`、身份变化或校验占用 `409`、组过大 `422` 和服务停止 `503`。

继续阅读：[安全边界](../ai/safety.md) · [验证矩阵](verification.md)。
