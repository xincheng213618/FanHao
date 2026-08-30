---
title: 模块清单与协议
description: 由实际注册器确认的模块目录、客户端覆盖范围和扩展契约。
status: maintained
verified_at: 2026-08-30
sources:
  - src/fanhao/module-registry.js
  - src/modules/system/module.js
  - src/modules/fanhao/module.js
  - src/modules/content-index/module.js
  - src/modules/photos/module.js
  - src/modules/media/module.js
  - src/modules/novels/module.js
  - src/modules/short-videos/module.js
  - src/modules/music/module.js
  - src/modules/tools/module.js
  - src/modules/market-dashboard/module.js
  - src/modules/content-index/server/routes.js
  - android-client/www/js/android-module-registry.js
  - public/js/module-navigation.js
  - tools/verify_module_structure.mjs
---

# 模块清单与协议

核对日期时，注册器发现 **10 个模块：8 个可见模块、2 个隐藏模块**。其中 7 个可见模块声明了 Android 入口；行情目前只声明 Web 入口。

清单来自 `discoverFanHaoModuleDefinitions()` 对 `src/modules/*/module.js` 的实际发现结果。`tools/verify_module_structure.mjs` 中的 `requiredModules` 是必须保留的最低集合，不能用它推断全部模块数量。

## 当前模块

| 顺序 | id / 标题 | 领域边界 | Web 入口 | Android |
| --- | --- | --- | --- | --- |
| 0 | `system` / 系统 | 状态、管理、Android 更新、本机能力 | 隐藏 | 无独立声明 |
| 10 | `fanhao` / 番号 | 人物、作品、前缀、榜单、厂商、收藏、历史、磁盘统计 | `/fanhao` | 有 |
| 15 | `content-index` / 内容索引 | 图库与影视共用的只读索引查询 | 隐藏 | 无独立声明 |
| 20 | `photos` / 图库 | 套图、写真、漫画阅读 | `/photo` | 有 |
| 30 | `media` / 影视 | 电影、电视剧和本地播放 | `/media` | 有 |
| 40 | `novels` / 小说 | 书库、阅读、采集 | `/novels` | 有 |
| 50 | `short-videos` / 短视频 | 信息流、作者、收藏、本地播放与管理器集成 | `/short-videos` | 有 |
| 60 | `music` / 音乐 | 音乐库与歌单 | `/music` | 有 |
| 70 | `tools` / 小工具 | TXT 格式化与离线游戏 | `/tools` | 有 |
| 80 | `market-dashboard` / 行情 | 贵金属、汇率和全球指数展示 | `/modules/market-dashboard/index.html` | 未声明 |

每个 id 的服务端入口均为 `src/modules/<id>/module.js`，再进入其 `server/runtime.js`。Android 的已声明入口均遵循 `./modules/<id>/android-module.js`，路径相对于 Android WebView 根目录。

“隐藏”只控制清单可见性，不是访问控制。`system` 与 `content-index` 仍处理请求；是否允许操作由鉴权和具体路由决定。

## 注册器实际行为

1. 只扫描 `src/modules/` 下直接子目录中的 `module.js`。
2. 动态导入文件，读取必需的 `moduleDefinition`。
3. 校验目录名与 id 一致、id 格式有效、标题非空、顺序为有限数值、id 不重复。
4. 如存在 `createModule(context)`，调用它创建运行时；否则使用空运行时。
5. 按 `order` 升序、再按 id 排序，形成统一路由和生命周期列表。

`visible` 未声明时默认为 `true`。`client.web`、`client.android` 可以为空；可见模块不天然等于双端模块。

## 描述符契约

| 字段 | 含义 | 修改风险 |
| --- | --- | --- |
| `id` | 稳定模块标识，也是目录名 | 改名影响目录、客户端入口与引用 |
| `title` / `description` | 用户和诊断可读说明 | 文案不决定路由与数据所有权 |
| `order` | 服务端运行时排序的第一关键字 | 可影响路由优先级与生命周期 |
| `visible` | 是否进入公开模块清单 | 不会禁用模块，也不会赋予权限 |
| `client` | 各客户端入口和导航提示 | 客户端仍需存在对应实现 |
| `capabilities` | 对外声明的能力字符串 | 不会自动创建 API 或进行权限校验 |

`GET /api/modules` 返回可见模块的 `id`、文案、顺序、客户端声明与能力。它不是全部 API 的 OpenAPI 描述，也不是运行状态探针。

## 运行时契约

以下方法均可选，声明时必须为函数：

| 方法 | 协议 |
| --- | --- |
| `routeApi(req, res, url)` | 匹配 API；处理后返回 `true`，不匹配返回 `false` |
| `routeMedia(req, res, url)` | 同样的接管协议，面向媒体响应 |
| `start()` | 启动模块后台能力，注册器按正序等待 |
| `beginStop()` | 停机预处理，注册器按逆序等待 |
| `stop()` | 停止并释放资源，注册器按逆序等待 |
| `invalidate(reason)` | 模块对外提供的失效入口；由具体调用方使用 |

路由不能只完成参数匹配却不发响应就返回 `true`，否则后续模块无法接管。也不要用一个宽泛路径吞掉别的模块请求。

模块可另外暴露窄接口，由 `registry.get(id)` 获取；这些扩展不等于所有模块都实现的公共协议。

## 模块设置

运行时可提供 `settings`，至少含 `schema` 与 `read()`，按需增加 `update()`、`action()`。注册器验证设置分组、字段和动作，并拒绝未声明的字段或动作。

设置快照会移除标记为 `writeOnly` 的值。新增凭据设置应使用这一契约，并检查实际响应，不能依靠前端把敏感值隐藏起来。

## 客户端并非一对一导航

Web 模块导航使用普通链接并打开新标签页或窗口。具体页面通过入口脚本加载，不能把服务端 `view` 当成任意可执行文件路径。

Android 会将远端描述符合并进本地后备目录，然后验证入口在 `./modules/` 下且不含路径回退，再动态加载。后备目录支持离线和兼容情形，因此 `/api/modules` 暂时缺项不等于该 Android 模块必然消失。

Android 导航还有自己的顺序和分组，例如音乐共享小说的底部入口。服务端模块数量、顶部页面数量与底部导航项数量不能直接互换。

## 扩展时的边界

新增业务优先放自己的模块。图库和影视使用 `content-index` 的现有共用索引；不要通过复制另一个模块的私有 SQL 或缓存变量获得复用。

通用基础设施归平台层，业务规则留在模块。现有结构护栏要求平台不反向导入业务模块，并限制可见模块之间的内部导入；它是开发约束，不是允许忽略现存兼容区的理由。

修改描述符或装载协议后，至少核对发现清单、相关客户端和 `verify:modules`。验证命令与执行影响见[验证参考](../reference/verification.md)；源码定位见[仓库地图](./repository-map.md)。
