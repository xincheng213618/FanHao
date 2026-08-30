---
title: 接口契约与定位
description: 从真实路由确认访问权限、输入输出和副作用，避免把旧接口清单当作完整规范。
status: maintained
verified_at: 2026-08-30
sources:
  - src/platform/server/http-app.js
  - src/platform/server/auth.js
  - src/platform/server/responses.js
  - src/modules/system/server/runtime.js
  - src/modules/short-videos/server/routes.js
  - docs/api-reference.md
---

# 接口契约与定位

新站提供接口的发现和核对方法，不生成未经完整校验的 OpenAPI 声明。
历史接口清单保留在仓库 `docs/api-reference.md`；涉及修改时，以目标模块的当前路由为准。

## 沿请求处理链阅读

1. `src/platform/server/http-app.js`：确认公共入口、预检、鉴权和模块分发。
2. `src/platform/server/auth.js`：确认请求来源、会话与变更授权。
3. `src/modules/<id>/server/routes.js` 或运行时的路由入口：找到实际处理器。
4. 服务/Store/Worker：确认最终数据行为与错误传播。
5. 对应 `tools/verify_*.mjs`：核对已覆盖的输入、拒绝路径与恢复行为。

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

继续阅读：[安全边界](../ai/safety.md) · [验证矩阵](verification.md)。
