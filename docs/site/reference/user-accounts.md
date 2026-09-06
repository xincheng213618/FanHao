---
title: 用户账号与登录设备
description: 网页与 Android 的账号、管理员、邀请码策略，以及登录设备管理接口和数据边界。
status: maintained
verified_at: 2026-09-02
sources:
  - src/platform/server/accounts/store.js
  - src/platform/server/accounts/service.js
  - src/platform/server/auth.js
  - public/platform/accounts/account-ui.js
  - android-client/www/js/account-settings.js
  - android-client/www/js/server-auth.js
  - tools/verify_accounts.mjs
  - tools/verify_account_sessions.mjs
  - tools/verify_account_clients.mjs
  - tools/verify_account_recovery.mjs
  - tools/verify_account_recovery_clients.mjs
  - tools/verify_account_invitations.mjs
  - tools/verify_account_invitation_clients.mjs
---

# 用户账号与登录设备

FanHao 的账号、注册策略和会话由后台统一管理，网页和 Android 使用同一套接口。
初始策略是开放注册、邀请码不必填。番号模块的收藏夹、收藏、观看历史和播放进度按账号保存；未登录时继续使用原访客记录。媒体及封面仍共享，范围与兼容边界见[个人收藏与观看记录](account-library.md)。

## 入口与角色

- 网页顶部「用户中心」，地址 `/account`；`/login` 和 `/register` 可以直接访问。
- Android「我的 → 用户中心」或「设置 → 用户中心」。账号跟随内容服务地址，不同 origin 的会话分别保存。
- 所有用户可编辑昵称、修改密码、管理自己的登录设备。管理员额外看到用户管理、邀请码、注册与访问设置和操作记录，可协助用户重置密码。

用户名为 3–32 位字母、数字、下划线、点或短横线，首位只能是字母或数字，统一转为小写。密码为 10–128 位；昵称为 1–40 字，注册时可省略并使用用户名。

公开注册始终创建普通用户，不能通过提交角色字段提权。首个管理员在服务所在电脑通过 localhost 访问 `/account` 初始化，要求 TCP 来源和 Host 都为本机，且请求不含 Forwarded / X-Forwarded-For。初始化后，现有管理员可提升其他账号。

不能停用或降级最后一个有效管理员。角色或停用状态改变时撤销该账号现有会话和待用密码重置码；重新启用后需重新登录。

忘记密码时，在登录表单选择「忘记密码？」并向管理员获取一次性重置码。流程、有效期及记录范围见[密码找回与操作记录](account-recovery.md)。

## 注册策略与邀请码

管理员在「注册与访问」中分别控制开放注册和邀请码必填，保存后网页与 Android 按后台策略执行，重启后保留。关闭注册不影响已有账号登录。即使邀请码不是必填，主动填写的码仍须有效并会消耗使用次数。

同一页面提供「访问资料库必须登录账号」开关，默认关闭。开启后，本机、局域网和远程访问均需有效用户账号，旧访问密码不能单独进入。注册及邀请码策略独立生效，详见[账号访问策略](account-access.md)。

邀请码每批生成 1–100 个，每码使用次数为 1–1000 次，有效期为 1–365 天，可填写备注。完整码只在生成响应中显示，应及时复制。数据库仅保存摘要和末尾 6 位；丢失完整码后可停用旧码、重新生成。

一个事务完成注册、使用次数扣减和注册来源记录。用户名冲突不会消耗次数，单次码并发使用只能有一个注册成功。列表显示使用次数、有效期、备注和状态，可停用仍可使用的码。

「生成记录」支持按备注、末尾标识或生成者用户名搜索，并筛选全部、可使用、已用完、已过期、已停用。搜索中的 `%`、`_` 按普通字符匹配。筛选后重新从第一页显示；生成新码后清除旧筛选，便于找到本次生成记录。

状态以服务器时钟为准，优先级为已停用、已过期、已用完、可使用。每条记录显示生成者；选择「使用记录」可查看该码的注册用户、当前账号状态和注册时间，支持按用户名或昵称搜索、每页 50 条分页。未使用的码显示空记录，停用或过期的码仍可查询已有使用记录，不会撤销已注册账号。

「用户管理」同时显示注册来源。通过邀请码注册的用户会显示码的末尾标识和生成者，可直接打开使用记录，返回后保留原用户搜索条件。没有来源码的账号显示「未使用邀请码」，包括开放注册和本机初始化，不根据当前角色猜测注册方式。来源信息仅对管理员展示，普通用户状态接口不返回这些信息。

使用记录返回邀请码列表后保留列表筛选；停用使记录不再符合「可使用」筛选时，列表显示筛选为空。网络读取失败提供「重新加载」，保留当前详情或列表位置。

## 登录设备

「登录设备」列出当前用户仍有效的登录记录，当前设备排在最前面。每条记录显示设备描述、登录时间、最近活动和过期时间；同一设备重新登录可能产生新记录，不是硬件设备清单。

- 「退出此设备」只撤销选中的本账号会话。
- 「退出其他全部设备」保留发起操作的当前会话，撤销其余会话。
- 「退出当前设备」同时撤销后台会话、清除网页 Cookie 或 Android 原生会话，并返回登录表单。
- 被其他设备退出后，再操作用户中心会提示登录已失效并显示登录表单。Android 保留失效凭据直到显式登录或退出，防止自动退回原有局域网免登录权限。

设备描述来自固定的浏览器/系统类别或 Android 客户端标记，只是辨识提示，不能作为认证依据；不保存原始 User-Agent 或 IP。最近活动约每 5 分钟记录一次，不表示设备实时在线；数据库存在写锁时跳过该次记录，后续请求再尝试，不等待写锁影响媒体认证。

设备列表不暴露 token 或 token 摘要，操作使用独立随机会话 ID。只能管理当前账号自己的记录；访问其他账号的会话 ID 与不存在的 ID 都返回 404。会话撤销后的后续认证失效，不会中断已经开始发送的媒体响应。

## 存储与兼容

账号使用独立的 `data/accounts.sqlite`，首次使用自动初始化；`PRAGMA user_version` 当前为 4。版本 1 自动补充会话 ID、活动时间和旧设备描述；版本 2 增加密码重置码和操作记录表；版本 3 增加默认关闭的账号访问要求。升级保留原账号、密码摘要、注册策略和有效会话，不要求重新注册或重置媒体数据库。

| 表 | 用途 |
| --- | --- |
| `account_users` | 用户名、昵称、密码摘要、角色、停用状态、注册与最近登录时间 |
| `account_sessions` | token 摘要、独立 ID、用户、设备描述、创建、最近活动和过期时间 |
| `account_invites` | 邀请码摘要、末尾标识、创建人、使用限额、有效期和停用状态 |
| `account_redemptions` | 使用邀请码注册的用户与来源码 |
| `account_settings` | 注册开放、邀请码必填和访问必须登录账号三个开关 |
| `account_password_resets` | 每用户一个待用重置码摘要、签发人和有效期 |
| `account_audit` | 最近 10,000 条关键操作及操作人、目标用户名快照 |

密码通过异步 scrypt 与独立随机盐保存，参数 N=32768、r=8、p=3，最多 4 个派生操作并行。会话是有效期 30 天的随机不透明 token，后台只存 SHA-256 摘要；每个账号最多保留 20 条会话，新登录超过上限时移除最早的记录。

网页使用 HttpOnly / SameSite=Lax Cookie，直连 TLS 时设置 Secure。Android 使用已有原生认证桥按 origin 保存 token，API、图片和原生媒体请求共用该会话，不保存密码。修改密码撤销所有会话，普通退出登录只撤销当前会话。

默认兼容本机/局域网免访问密码机制和原远程访问密码；开启账号访问要求后，这些访问方式需再登录用户账号。普通用户不能使用 `requireLocalAdmin` / `requireTrustedFileMutation` 管理入口；管理员仍受这些入口的原本机/局域网限制。用户及邀请码管理独立要求管理员账号，不能只凭局域网位置获得权限。失效用户 token 不回退为局域网可信登录。

访问要求控制服务入口，与个人记录的归属分开。账号登录后即可使用个人番号收藏及历史，无须开启强制登录；其他内容模块及自助邮件找回尚未纳入这一改动。

## API

以下路径前缀均为 `/api/accounts`。写请求只接受 JSON 并复核请求来源；用户及会话字段由后台验证，不依赖客户端隐藏按钮。默认列表每页 50 条。

| 方法与路径 | 权限及输入 |
| --- | --- |
| `GET /status` | 公开；返回 user 或 null、registrationEnabled、invitationRequired、accountLoginRequired、setupAvailable |
| `POST /register` | 公开；username、password，可选 displayName、inviteCode |
| `POST /login` | 公开；username、password |
| `POST /setup` | 仅本机首次；创建首个管理员 |
| `POST /logout` | 撤销当前会话；正文 `{}` |
| `PATCH /me` | 当前用户；displayName |
| `POST /password` | 当前用户；currentPassword、newPassword；成功后所有设备重新登录 |
| `POST /password/reset` | 公开；username、resetCode、newPassword；重置成功后全部设备重新登录 |
| `GET /sessions` | 当前用户；最多返回 20 条有效会话，标识唯一 current 项 |
| `POST /sessions/:id/revoke` | 当前用户；正文 `{}`；返回 current，表示撤销的是否为当前会话 |
| `POST /sessions/revoke-others` | 当前用户；正文 `{}`；返回撤销数量 revoked，重复执行为 0 |
| `GET /admin/users` | 管理员；search、offset；返回用户及 registration 来源 |
| `PATCH /admin/users/:id` | 管理员；role（admin / user）和/或 disabled（boolean） |
| `POST /admin/users/:id/password-reset` | 管理员；currentPassword，校验操作者自己的密码后返回一次性重置码 |
| `GET /admin/audit` | 管理员；search（操作人或目标用户名）、offset |
| `GET /admin/settings` | 管理员；返回三个策略开关 |
| `PATCH /admin/settings` | 管理员；registrationEnabled、invitationRequired、accountLoginRequired 中至少一个 boolean；未提交字段保留 |
| `GET /admin/invites` | 管理员；search、status、offset；不返回完整码 |
| `GET /admin/invites/:id` | 管理员；search（使用者用户名/昵称）、offset；返回邀请码及使用记录 |
| `POST /admin/invites` | 管理员；count 默认 1、maxUses 默认 1、expiresInDays 默认 7，可选 note |
| `POST /admin/invites/:id/revoke` | 管理员；正文 `{}` |

登录、注册或初始化成功返回 `{ ok: true, user }` 及 Cookie；`client: android` 请求额外返回 token、expiresIn。`GET /sessions` 返回 sessions 数组，每项含 id、clientType、deviceLabel、createdAt、lastSeenAt、expiresAt、current；时间字段为 Unix 毫秒。

邀请码 status 取值为 all、available、exhausted、expired、disabled，未知值返回 400。列表返回 invites、total、offset、limit；详情返回 invite、redemptions、total、offset、limit，其中 total 是符合搜索条件的使用者数量，invite.uses 是该码累计使用次数。注册时间 redeemedAt 为 ISO 字符串，详情不暴露完整码、密码或会话摘要。

账号响应使用 `Cache-Control: no-store`。401 表示需要登录，403 表示角色、来源或注册策略不允许，404 表示记录不存在或不属于当前用户，409 表示用户名冲突或最后管理员保护等状态冲突。输入校验失败返回 400，非 JSON 写入返回 415，限流返回 429。

注册按真实 TCP 来源限制为每小时 10 次；登录、修改密码、使用重置码、签发重置码分别每 15 分钟 20 次，进程重启后重置限流窗口。不能通过 Forwarded 字段选择限流身份。

## 实现与验证

后台位于 `src/platform/server/accounts/`，由共享 `auth.js` 接入请求链。网页表单位于 `public/platform/accounts/`，Android 通过 `www/js/account-settings.js` 适配原生会话。`android-client/scripts/sync-shared-assets.mjs` 复制共享表单与样式至 `www/platform/accounts/`；修改共享源后同步，不分别维护两份实现。

```powershell
npm run verify:accounts
npm run verify:auth
npm run verify:mutation-auth
npm run verify:modules
npm run verify:imports
```

账号验证使用临时 SQLite 和动态端口 HTTP fixture，不连接实际媒体库。覆盖版本 1/2 升级、跨用户拒绝、设备退出/数量上限、活动写入争用，以及密码恢复的并发、失效、回滚和操作记录脱敏。网页/Android 适配层验证注册、密码修改/恢复、设备管理和重新登录。浏览器检查要求本机 Chrome/Edge，截图中的账号及码均为临时数据。

邀请码验证还覆盖管理员权限、状态优先级、特殊字符搜索、列表与使用者分页、注册来源、停用后保留记录，以及网页/Android 的筛选保留、详情往返、读取失败重试、输出转义和移动端布局。

原生 HTTP 会话由 `verify:auth` 的 JVM fixture 覆盖，浏览器适配验证不替代真机验收。代码进入现有运行实例还需按原流程重启主服务并更新 Android APK；测试通过不代表已部署或发布。

继续阅读：[接口契约](api.md) · [验证矩阵](verification.md) · [安全边界](../ai/safety.md)。
