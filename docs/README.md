# FanHao 文档中心

本目录是「个人视频资料库」（FanHao）项目的文档模块，面向维护者与新接入的协作者。
项目本质是一个**运行在本机 / 局域网的服务端**：扫描本地磁盘上的影视、图库、小说、短视频等资料，提供网页浏览与播放，并通过 Capacitor 打包成安卓 App。

## 项目一句话概览

- 服务端：Node.js（>= 24，使用内置 `node:sqlite`），单文件 `server.js` 作为组合根（composition root），把配置、核心服务、领域模块和路由装配起来。
- 前端：`public/` 下的静态页面（首页、播放页、管理页），以及 `android-client/www/` 中由 Capacitor 同步的同构 Web 资源。
- 安卓端：`android-client/`，基于 Capacitor 8，包名 `local.fanhao.library`。
- 维护脚本：`tools/` 下的 Node / Python 批量任务，通过后台「作业中心」运行。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [项目配置](./configuration.md) | 所有环境变量、端口、路径与运行前依赖（ffmpeg / Node 版本） |
| [API 参考](./api-reference.md) | 按模块分类的全部 HTTP 接口（含访问权限级别） |
| [维护与作业](./maintenance.md) | 启动脚本、后台作业中心、常用维护 / 报表任务 |
| [安卓客户端](./android-client.md) | Capacitor 构建、调试包、自动更新通道 |
| [数据布局](./data-layout.md) | `data/` 目录、各 SQLite 数据库与索引文件说明 |
| [技术亮点](./technical-highlights.md) | 流畅滑动 / 虚拟滚动、分批渲染、封面懒加载、服务端字节范围流式等实现剖析 |
| [代码结构评估](./code-structure-assessment.md) | 当前热点、边界规则与后续重构顺序 |
| [服务端架构](./server-architecture.md) | 反射式模块装配、职责分层与依赖方向 |
| [模块开发](./module-development.md) | 新增业务形态时的目录、描述符、运行时协议和校验流程 |
| [模块文档](./modules/README.md) | 按注册模块拆分的职责、代码入口、接口、数据和验证说明 |
| [核心数据库](./fanhao-core-database.md) | `fanhao-core-v2.sqlite` 的表设计与原则（已有） |
| [开源小游戏审计](./open-source-games-audit.md) | 集成到 WebView 的离线小游戏的选型与合规记录（已有） |

## 目录约定

```
FanHao/
├── server.js              # FanHao 壳层：共享服务装配、HTTP 启动
├── package.json
├── start-fanhao.ps1       # 启动脚本（Windows）
├── lib/                   # 跨领域纯函数（番号解析、info 元数据解析、脚本注册表）
├── src/fanhao/            # 模块发现器与 FanHao 模块协议
├── src/modules/           # 按业务形态隔离的模块目录
│   ├── fanhao/            # 番号
│   ├── photos/            # 套图
│   ├── media/             # 影视
│   ├── novels/            # 小说
│   ├── short-videos/      # 短视频
│   ├── tools/             # 小工具
│   ├── music/             # 音乐（现有附加模块）
│   └── system/            # 不展示的系统模块
├── src/platform/          # 与业务形态无关的 HTTP、鉴权、文件和媒体基础设施
├── tools/                 # 批量 / 维护脚本（Python + Node）
├── public/modules/        # Web 端按模块归档的页面控制器
├── android-client/www/modules/ # Android WebView 端按模块归档的页面控制器与样式
├── data/                  # 本地状态：SQLite、JSON、日志、缓存
└── docs/                  # 本目录
```

## 模块文档

模块文档与代码目录一一对应，适合在修改某个业务形态前先阅读：

- 可见业务模块：`fanhao`、`photos`、`media`、`novels`、`short-videos`、`music`、`tools`、`market-dashboard`。
- 隐藏基础模块：`system`、`content-index`。
- `disk-usage` 是 `fanhao` 内部的磁盘用量子能力，不是独立注册模块。

入口见 [模块文档索引](./modules/README.md)。每篇文档只描述该模块的职责和边界；完整接口字段仍以 [API 参考](./api-reference.md) 为准。

## 快速上手

```powershell
# 需要 Node.js >= 24
npm start
# 默认监听 http://0.0.0.0:29998
# 本机访问 http://127.0.0.1:29998
# 手机访问 http://<电脑局域网IP>:29998
```

远程（非局域网）网页访问需要输入访问密码，默认见 [项目配置](./configuration.md)。
本地 / 局域网访问默认免密，但会触发更宽松的播放与转码策略（见 [API 参考 · 访问权限](./api-reference.md#访问权限级别)）。
