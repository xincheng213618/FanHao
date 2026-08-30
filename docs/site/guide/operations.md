---
title: 运行与维护
description: 识别主服务与下载器边界，以最小影响方式检查健康、处理作业和保护持久数据。
status: maintained
verified_at: 2026-08-30
sources:
  - start-fanhao.ps1
  - src/platform/server/server-host.js
  - src/bootstrap/server-config.js
  - src/platform/server/auth.js
  - lib/admin-script-registry.js
  - src/modules/system/server/admin-task-service.js
  - src/modules/system/server/admin/routes.js
  - docs/data-layout.md
---

# 运行与维护

主服务、下载管理器和资料目录属于不同的运行资源。
排查问题先确认当前副本、监听端口、日志和作业状态，不要把重启或重新扫描作为第一步。

## 运行对象

| 对象 | 默认位置或入口 | 影响 |
| --- | --- | --- |
| FanHao 主服务 | `server.js`，HTTP `29998` | 读取媒体、维护 SQLite、启动模块 Worker。 |
| 下载管理器 | 短视频模块下的 `download-manager/run.ps1`，HTTP `8765` | 独立进程，管理采集、下载及自己的数据库。 |
| 主服务数据 | 当前副本的 `data/` | 用户状态、业务数据库与派生缓存。 |
| 启动日志 | `logs/fanhao.out.log`、`logs/fanhao.err.log` | 后台启动器重定向的输出。 |
| 访问日志 | `logs/access.log` | 访问记录，可能含敏感路径或请求信息。 |

主服务默认监听 `0.0.0.0`。仅在本机使用时显式指定 `127.0.0.1`。
公网访问不能通过简单的 loopback/LAN 反向代理实现：当前鉴权依赖 TCP 来源地址，代理可能让公网请求被识别为本地来源。
密码不能修复这种来源误判；完整边界见[配置参考](../reference/configuration.md)。

## 先做只读诊断

下面命令不会主动启动、重启或扫描应用：

```powershell
Get-NetTCPConnection -LocalPort 29998,8765 -State Listen -ErrorAction SilentlyContinue
Invoke-RestMethod -Uri "http://127.0.0.1:29998/api/health" -TimeoutSec 5
Get-Content -LiteralPath ".\logs\fanhao.err.log" -Tail 60
Get-Content -LiteralPath ".\logs\fanhao.out.log" -Tail 60
```

使用自定义端口时替换 URL。日志不存在或健康请求失败应保留原始错误，不等于必须结束某个 Node 进程。
健康接口成功只证明该端点可响应，不证明所有媒体、Worker、数据库和业务请求均正常。
分享证据前删去令牌、Cookie、用户名、真实媒体路径和个人内容。

## 理解启动器参数

只有在运行对象、数据目录和操作范围已确认后才启动服务。
隔离试跑见[快速开始](./quick-start.md)，本页不提供自动重启现有服务的快捷命令。

| 参数 | 行为 |
| --- | --- |
| `-Port` | 设置主服务端口，默认 `29998`。 |
| `-HostName` | 设置主服务监听地址，默认 `0.0.0.0`。 |
| `-Foreground` | 在当前终端运行主服务；仍会先构建 Web 资源。 |
| `-Restart` | 可能停止指定端口上的既有进程；不是无害的重试参数。 |
| `-SkipDownloadManager` | 不由启动器启动下载器；不禁止主服务访问下载器数据。 |
| `-DownloadManagerPort` | 启动器使用的下载器端口，默认 `8765`。 |
| `-RestartDownloadManager` | 显式请求下载器重启。 |
| `-StartupTimeoutSeconds` | 后台主服务健康等待预算，默认 `120` 秒，允许 `5–600` 秒。 |

端口上已有健康服务且未传 `-Restart` 时，启动器复用服务；它仍可能启动下载器。
端口占用且未授权重启时应定位占用来源，不要批量结束全部 `node` 进程。
超时分支只结束本次启动器创建的主服务进程，并打印日志尾部。
前台模式可用 `Ctrl+C` 发起停止；服务端有停止接收请求、结束模块和超时退出的流程。

## 管理作业

管理页通过以下接口呈现和控制作业：

| 接口 | 用途 |
| --- | --- |
| `/api/admin/scripts` | 查看注册脚本及参数定义。 |
| `/api/admin/scripts/run` | 启动作业，可能写数据库、改文件或访问外部站点。 |
| `/api/admin/tasks` | 查看任务状态与历史。 |
| `/api/admin/tasks/stop` | 请求停止任务；不意味着已撤销其已完成写入。 |

实际行为以 `lib/admin-script-registry.js` 和被调用脚本为准。
部分注册项的写入参数默认就是开启状态；不要假设所有维护命令都默认 dry-run。
`risk` 标签方便提示风险，但不能替代检查参数默认值和实际代码。

运行写入作业前记录目标根目录、数据库、参数、预期条数和恢复方式。
先对临时 fixture 验证；若脚本支持预览，再检查预览结果。
删除、移动、批量同步、清缓存和资料回填应分别授权，不能用一次模糊的“维护”覆盖全部操作。

## 数据保护与恢复

核心数据库、用户状态和缓存不能互相替代；“重建索引”也不意味着能恢复收藏、进度或手工资料。
源媒体可能位于仓库之外，漫画库、核心图片库和分析库也可能通过环境变量改到外部路径。
备份清单应根据有效配置生成，而不是只记住 `data/`。

复制 SQLite 时要保证一致性：使用明确支持的备份方式，或在确认相关写入进程停止后备份。
不要在运行中仅复制单个 `.sqlite` 文件并忽略 WAL 状态。
下载器数据库与主服务短视频库分别保留；禁止让下载器绕过主服务的写入与同步边界。

恢复应先在隔离副本核对 schema、记录数量与关键读写流程。
遇到未知 schema、未完成删除或身份冲突时保留现场；不要删除 journal、强制改版本号或手工补行来让服务启动。
递归删除或移动前，解析并核对绝对路径，再用 PowerShell `-LiteralPath` 操作。

## 维护完成的证据

记录实际影响的服务和数据、健康结果、相关业务结果及未验证项。
只运行[验证矩阵](../reference/verification.md)中的离线门禁，不能声称现有运行服务已经更新。
文档发布与应用升级是独立操作；GitHub Pages 上的文档不包含本机资料库。
