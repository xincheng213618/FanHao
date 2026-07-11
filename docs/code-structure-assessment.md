# 代码结构评估

## 结论

本轮重构已经把“按文件类型堆放”的结构改成“按产品形态归档”：番号、套图、影视、小说、短视频、音乐、小工具七个可见业务模块都有独立目录，并由注册表自动发现和装配。Web 与 Android 导航统一读取 `/api/modules`，新增或调整模块不再需要在两端各维护一份固定导航。

结构基础已经可用于后续迭代，但还不是完全插件化。服务端配置已进入 `src/bootstrap/server-config.js`，HTTP 生命周期已进入 `src/platform/server/server-host.js`；Web 端也把 FanHao 与图库/影视、小说、音乐、小工具的独立宿主分开。最大遗留仍是 `server.js` 的 FanHao 领域服务构造，以及短视频前后端的巨型文件，后续应继续按边界渐进收缩。

## 已完成的清理

- 删除旧移动端审计截图、Capacitor 模板测试和 Android 重复游戏源码。
- 离线游戏只保留 `public/games/` 一份源码，Android 构建前通过脚本生成镜像。
- 删除迁移后无调用的兼容函数，清空旧 `src/server/` 源码树。
- 保留并扩展有业务价值的 `tools/verify_*.mjs`；它们不是模板测试，而是当前解析、存储和模块边界的回归护栏。
- 新增 `verify:modules`，使模块目录、客户端声明和反射发现从“约定”变成可执行约束。
- Web 样式已按基础、壳层和模块入口维护，并由结构验证固定加载顺序。
- 新增 `verify:repo-hygiene`，阻止生成物、服务抓取副本和含 NUL 字节的源码进入版本库。
- `public/app.js` 已收窄为 FanHao 专属入口；`public/standalone-app.js` 与 `public/js/standalone-host.js` 负责图库/影视、小说、音乐和小工具的独立宿主。

## 当前热点

| 区域 | 当前问题 | 下一条清晰边界 |
| --- | --- | --- |
| `server.js` | 仍负责大量 FanHao 领域服务构造 | 继续迁到 `src/modules/fanhao/server/composition.js`，壳层只提供平台上下文 |
| `src/modules/short-videos/server/store.js` | schema、同步、查询、元数据、封面和写操作集中 | 拆为 schema/repository、source-sync、query 和 cover 服务 |
| `public/modules/short-videos/short-video-page.js` | Web 端信息流、播放器、手势、评论、分享和渲染仍集中 | 按 data/controller、player lifecycle、interaction 和 view 拆分 |

## 后续约束

1. 新业务必须进入 `src/modules/<id>/`，不得回到 `server.js` 或旧 `src/server/`。
2. 模块通过描述符暴露能力，通过注入的平台接口协作，不直接读取另一业务模块内部状态。
3. API payload 和现有路由默认保持兼容；目录调整不应顺带改变产品语义。
4. Web 与 Android 可以有不同交互，但模块 id、标题和可见顺序来自同一服务端清单。
5. 每次抽取先做语法/导入检查，再跑 `npm run verify`，最后做服务和代表接口冒烟。
6. 不为了减少文件数合并 SQLite；小说、音乐、短视频和图库的生命周期不同，独立存储是健康边界。

## 推荐迭代顺序

1. 继续缩小 `server.js`，优先完成 FanHao 领域组合迁移。
2. 拆短视频后端 store；这是服务端变化最频繁的热点。
3. 参照 Android 已完成的短视频内部模块化，拆分 Web 短视频控制器；保持模块入口与 URL 不变。
4. 为七个可见业务模块补稳定的 API 合同冒烟用例，逐步替代依赖人工点击的验证。

新增模块的具体方式见 [模块开发](./module-development.md)。
