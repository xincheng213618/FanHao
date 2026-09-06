# 漫画馆与采集器

漫画数据与 FanHao 主资料库分开存放。默认目录为 `E:\https-smtt6-com-man-hua-yue`，可以用环境变量 `FANHAO_MANGA_ROOT` 覆盖；SQLite 索引默认是该目录下的 `manga.sqlite`。

## 运行采集器

在 PowerShell 中执行：

```powershell
python -m pip install -r .\tools\manga_collector_requirements.txt
.\tools\run_manga_collector.ps1
```

脚本读取漫画数据目录中的 `smtt6_sources.txt`，支持 smtt6、jmd9（含 `91jmd.com` 镜像域名）与 55comic。`91jmd` 沿用 jmd9 的 `/manga/{作品ID}/{章节令牌}` 规则和 `jmd9_cache_{作品ID}` 缓存目录；两个域名会按同一来源去重。默认采用增量更新：每本作品只请求一次目录页，以章节 URL 中稳定的站点章节 ID 判断新章节；已完成章节不会再次请求阅读页或重写章节状态，失败、未完成及新出现的章节才会继续下载。55comic 链接中会变化的 `?t=` 参数不会再导致旧章节被误判为新增。

新作品解析完远端目录后会立即发布待下载章节，因此书架和作品详情不必等待整本采集完成。已下载章节可以阅读和下载，未完成章节在目录中显示为“等待”，并随着采集进度逐章转为可用。

服务端会把最近 50 条新增/更新任务写入漫画根目录的 `.manga-jobs.json`。完成与失败记录在后台重启后仍可由网页和安卓端查看；重启时仍处于运行状态的任务会转为明确的“后台重启，任务已中断，请重新采集”，不会伪装成仍在下载。记录使用临时文件原子替换，损坏、越界或来源无效的条目会被忽略。

安卓端任务卡支持直接重试失败任务。重试会沿用原任务已校验的来源与缓存目录，并通过服务端单飞保护复用同一本书已经运行的采集器；成功重试会生成新的可审计任务记录。展开“任务记录”后可以清理所有已完成和失败记录，清理只影响 `.manga-jobs.json` 中的任务历史，不删除漫画文件；服务端始终跳过运行中的任务，即使客户端重复提交清理请求也不会中断下载。

安卓书库与书页只常驻显示运行中或失败任务。已观察到的任务完成时显示一次完成提示，约 5 秒后自动收起；之后仅在展开的任务记录中查看完成详情，重新进入书页或启动 App 不会重放旧提示。书库批量轮询和书页轮询使用同一状态合并规则：同一任务的延迟运行快照不能覆盖完成/失败结果，同一本书的旧任务不能覆盖新任务。`verify:manga` 检查状态合并边界，`verify:browser-behavior` 覆盖书库完成、书页完成、切页延迟响应、提示自动消失与冷启动。

增量检查没有待处理章节时，完成提示明确显示“已是最新”。任务完成后同步刷新当前书库的作品数据与更新时间，即使任务是在书页启动、随后返回书库也不例外；目录尚未读取时不显示零章节统计，避免把未知状态误报为空目录。

需要主动重新检查所有章节页面时，可以显式执行全量扫描：

```powershell
.\tools\run_manga_collector.ps1 -CollectorArguments '--full-scan'
```

采集器还会恢复 55comic 分片图片、缓存真实封面，并同步作品资料、目录和图片索引。也可以传入原采集器参数，例如只重建 SQLite：

```powershell
.\tools\run_manga_collector.ps1 -CollectorArguments '--rebuild-sqlite'
```

首次迁移旧缓存时，可在重建索引的同时把真实封面落到各漫画目录；后续网页会优先使用本地封面，不再依赖站外热链：

```powershell
.\tools\run_manga_collector.ps1 -CollectorArguments '--rebuild-sqlite', '--cache-covers'
```

直接调用 Python 也可用：

```powershell
$env:FANHAO_MANGA_ROOT = 'E:\https-smtt6-com-man-hua-yue'
python .\tools\manga_collector.py
```

漫画馆入口是 `/manga`。旧地址 `/photo/manga` 会继续兼容，但会进入独立漫画页面。作品页提供真实封面、简介和章节目录；章节 ZIP 与整本 ZIP 均由现有本地缓存直接下载。
