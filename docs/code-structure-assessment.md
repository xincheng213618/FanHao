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
| `src/modules/short-videos/server/store.js` | schema、同步、查询、元数据、封面和写操作集中；删除文件早于 SQLite 提交，中途失败无法回滚 | 先建立可恢复的删除作业（预留、隔离、提交、清理），再拆 schema/repository、source-sync、query 和 cover 服务 |
| `src/modules/music/server/` | 重扫描与 `ffprobe` 仍可在 HTTP 进程中做递归和同步工作 | 迁到后台 worker，分阶段发布新索引，请求线程只读已提交快照 |
| `public/modules/short-videos/short-video-page.js` | Web 端信息流、播放器、手势、评论、分享和渲染仍集中 | 按状态 owner、request lifecycle、player lifecycle 和 renderer 渐进拆分 |
| Android 短视频 | 原生点赞/收藏与 Web/API 持久化契约不一致；`targetSdk 30` 和旧存储权限在新系统上已是迁移债务 | 先确定交互状态的单一权威端，再单独做 target/storage 迁移和真机回归 |

## 本轮已收敛的横切问题

- 下载管理器的主页、资料库和链接查询共用 latest-request 生命周期；新的筛选或搜索可抢占旧请求，旧成功/失败都不得回写新界面。
- 短视频 API 的 JSON 请求体有统一的 400/413 边界，未知 5xx 只记录详细错误并返回稳定公开文案。
- Android 原生短视频的 JSON 响应先有界收集字节、再一次性 UTF-8 解码；图片同时校验状态、类型、声明长度和实际长度。
- 共享页面只保留一个 `main` landmark；路由筛选使用 pressed button 语义，动态模块导航在替换 DOM 后重新同步 `aria-current`。

## 后续约束

1. 新业务必须进入 `src/modules/<id>/`，不得回到 `server.js` 或旧 `src/server/`。
2. 模块通过描述符暴露能力，通过注入的平台接口协作，不直接读取另一业务模块内部状态。
3. API payload 和现有路由默认保持兼容；目录调整不应顺带改变产品语义。
4. Web 与 Android 可以有不同交互，但模块 id、标题和可见顺序来自同一服务端清单。
5. 每次抽取先做语法/导入检查，再跑 `npm run verify`，最后做服务和代表接口冒烟。
6. 不为了减少文件数合并 SQLite；小说、音乐、短视频和图库的生命周期不同，独立存储是健康边界。

## 推荐迭代顺序

1. 先把短视频本地文件删除做成可恢复作业；这是数据一致性风险，优先于文件拆分。
2. 把音乐重扫描与媒体探测迁移到后台 worker，并用心跳延迟证明 HTTP 主循环不再被阻塞。
3. 确定 Android 点赞/收藏是本地标记还是服务端状态，然后再统一命名、API 和离线同步策略。
4. 继续缩小 `server.js`，同时按已有状态/请求/渲染边界拆短视频巨型文件；每次抽取都要保持 API、路由和打包产物等价。
5. 为七个可见业务模块补稳定的 API 合同冒烟用例，逐步替代依赖人工点击的验证。

新增模块的具体方式见 [模块开发](./module-development.md)。
