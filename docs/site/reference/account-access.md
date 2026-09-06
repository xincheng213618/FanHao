---
title: 账号访问策略
description: 可选的资料库账号登录要求、默认兼容行为、公开入口，以及网页和 Android 的认证提示。
status: maintained
verified_at: 2026-09-02
sources:
  - src/platform/server/accounts/store.js
  - src/platform/server/accounts/service.js
  - src/platform/server/auth.js
  - src/platform/server/http-app.js
  - server.js
  - public/platform/accounts/account-ui.js
  - android-client/www/app.js
  - android-client/www/js/account-access.js
  - android-client/www/js/server-auth.js
  - tools/verify_account_access_policy.mjs
  - tools/verify_account_access_clients.mjs
  - tools/verify_android_account_access.mjs
---

# 账号访问策略

管理员可以在网页或 Android 用户中心打开「注册与访问」，开启「访问资料库必须登录账号」。默认关闭，升级不会自动改变已有访问方式；开关保存后对后续请求生效并在重启后保留。

## 开启后的行为

| 访问方式 | 开关关闭 | 开关开启 |
| --- | --- | --- |
| 本机或可信局域网，无账号 | 沿用原有访客访问 | 要求登录用户账号 |
| 有效的旧访问密码会话 | 沿用原访问规则 | 需改用用户账号 |
| 有效用户账号会话 | 按该账号角色访问 | 按该账号角色访问 |
| 失效或停用的用户账号会话 | 拒绝，不能退回局域网访客 | 拒绝，需重新登录 |

该策略覆盖主服务的受保护网页、API 和媒体入口。管理员账号仍受现有本机/局域网管理操作限制；开启开关不会允许远程管理员执行原本受本地限制的文件操作。普通用户也不会获得管理权限。

内网管理检查同时核对真实 TCP 来源与请求 Host，安卓标记不能放宽 Host 限制；不使用 Forwarded 头代替这些判断。若反代把来源和 Host 都改为内网身份，仍需在代理层另外限制管理路径。

开启时无需退出当前有效账号。网页访客会跳转到登录页，完成登录或注册后返回原目标路径。登录页说明已关闭访客访问，并隐藏「使用原访问密码」。API 和媒体认证失败返回 401；旧 `/auth/login` 返回 403 和账号登录提示，HTML 表单请求转到账号登录页。

关闭开关后恢复原有访客及旧访问密码规则。关闭不会撤销现有用户会话，也不会恢复已失效的用户 token。

## 与注册策略的关系

三个开关分别控制注册是否开放、邀请码是否必填、访问是否必须登录账号。要求登录不等于关闭注册，也不等于要求邀请码。默认仍开放注册且邀请码选填。

- 要求登录且开放注册：新用户可注册后进入；没有要求邀请码时可直接注册。
- 要求登录且关闭注册：已有账号可登录，新用户需等待管理员开放注册。
- 要求登录且邀请码必填：开放注册时，新用户还需提供有效邀请码。

账号登录、状态查询、注册、密码找回和账号页面资源始终可到达，各入口继续执行自身的校验；公开访问不代表操作无需权限。本机首次管理员初始化仍保留原来源检查，用户及策略管理仍只允许管理员。

公开 Android 更新页 `/android-update`、版本接口和 APK 下载保持可访问，让尚未支持用户账号的旧 App 可以更新。其他业务入口不会因为 Android 客户端标记而跳过账号要求。

## Android 连接与缓存

明确连接服务时，App 根据该服务的认证状态决定是否进入用户中心。要求账号时提示登录或注册，不继续推荐旧访问密码。服务器明确拒绝认证时，App 显示需要登录，不将其当作一次普通离线连接成功。

读取手机保存的登录会话失败时，当前网络请求会失败并提示重试；不会丢弃凭据后发送匿名请求。仅对用户明确选择的服务 origin 读取并附带其会话，切换服务不会把一个地址的 token 发给另一个地址。

访问开关控制服务器请求，不会删除已经下载的媒体或设备本地数据，也不保证撤回已开始传输的响应。番号收藏与历史另按[个人记录归属](account-library.md)处理；媒体继续共享，个人记录归属不依赖本开关。

## 接口与升级

`GET /api/accounts/status` 和管理员 `GET /api/accounts/admin/settings` 返回 `accountLoginRequired`。管理员可使用 `PATCH /api/accounts/admin/settings` 提交一个或多个 boolean：

```json
{ "accountLoginRequired": true }
```

未提交的开关保持原值；旧客户端只保存注册设置时不会关闭账号要求。空的或类型无效的更新被拒绝。策略变更与 `access.changed` 操作记录在同一事务中保存，重复保存相同状态不新增记录。

`GET /api/auth/status` 在各种认证状态下都包含 `accountLoginRequired`。未认证的受保护请求返回 401，附带 reason、accountLoginRequired 和 loginUrl；开启策略时 reason 通常为 `account-required`，失效账号为 `expired-account`。客户端应读取认证状态和错误字段，不靠网络位置猜测是否需要登录。

schema 4 为 `account_settings` 增加 `account_login_required`，默认 0。旧版自动升级并保留密码、有效会话、注册设置、邀请码、重置码和操作记录。

## 验证范围

`npm run verify:accounts` 使用临时 SQLite、HTTP 服务和浏览器 fixture，覆盖本机/局域网匿名访问、旧密码会话、有效/失效账号、媒体与 API、公开更新入口、部分策略更新、迁移及写入回滚。网页和 Android 共享面板覆盖设置同步、访客跳转、注册后返回、退出后拒绝访问及恢复兼容模式。

Android 连接逻辑另验证认证失败的用户中心引导、离线与认证失败区分、原生会话读取失败后重试及切换服务凭据隔离。这些验证不触碰真实账号库，也不代表已重启主服务或安装新 APK。
