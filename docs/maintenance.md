# 维护与作业

FanHao 的批量 / 慢速任务（扫描、资料补全、封面生成、转码、元数据导入）都从请求路径中移除，
统一收口到 `tools/` 下的脚本，并通过服务端的**后台作业中心**运行与追踪。

## 启动与停止服务

Windows 下推荐使用自带脚本：

```powershell
# 启动（后台隐藏运行，日志写到 logs/）
.\start-fanhao.ps1

# 前台运行（调试用，日志直接打印）
.\start-fanhao.ps1 -Foreground

# 指定端口 / 重启已有进程
.\start-fanhao.ps1 -Port 29998 -Restart
```

脚本会检测端口占用：若已运行且健康则直接退出；否则停止旧进程后在 `127.0.0.1:<port>` 探活。
日志位于 `logs/fanhao.out.log` 与 `logs/fanhao.err.log`，另有 `logs/access.log` 访问日志。

也可直接 `node server.js`（需先设好环境变量，见 [项目配置](./configuration.md)）。启动配置集中在 `src/bootstrap/server-config.js`，HTTP 监听、局域网地址输出、信号处理和优雅停机集中在 `src/platform/server/server-host.js`；业务模块不应自行接管这些职责。

## 后台作业中心

管理页（公开访问：`/admin.html`，仅本机 / 局域网可操作）通过 `/api/admin/scripts` 列出可运行脚本，
通过 `/api/admin/scripts/run` 启动，`/api/admin/tasks` 查看运行状态与历史，`/api/admin/tasks/stop` 停止。

每个脚本由 `lib/admin-script-registry.js` 注册，自带参数表单定义（文本框、勾选、数字、下拉、人物选择等）。
脚本按风险标注：`careful` / `write` / 无标注（只读或安全）。

### 常用作业速查

| 作业 ID | 标题 | 类别 | 用途 |
| --- | --- | --- | --- |
| `javdb-source-pipeline` | JavDB 全流程管线 | JavDB | 批量执行演员映射、资料 / 封面补全、sidecar 同步。 |
| `actor-page-backfill` | Actor 页缺失检测 | JavDB | 刷新演员页作品列表，可进一步抓资料 / 封面。 |
| `metadata-backfill` | 作品资料 / 封面补全 | JavDB | 对本地作品补 JavDB 资料、评分、封面。 |
| `batch-import-actors` | 批量导入演员资料 | JavDB | 按本地人物搜索并缓存 JavDB 头像、别名、映射。 |
| `ranking-cache` | 排行榜缓存 | 缓存 | 抓取 JavDB 排行榜写入本地缓存。 |
| `image-library-rescan` | 刷新图库索引 | 图库 | 重建套图 / 电影 / 电视剧索引（只更新 `image-library-index.json`）；欧美由核心番号库扫描。 |
| `tuimzz-photo-sync` | 检查微密圈套图更新 | 图库 | 对照 tuimzz 与 `T:\微密圈`，生成需要更新、本地缺失和百度云链接报告；不下载、不解压。 |
| `tuimzz-photo-import` | 导入微密圈下载 | 图库 | 预检并把明确编号的 7z 下载转换成无密码 RAR；默认 dry-run，保留全部下载原件。 |
| `core-local-scan` | 核心本地扫描 | 本地 | 把本地根目录按人物 / 作品写入核心 SQLite。 |
| `douban-tv-metadata` | 补全电视剧豆瓣资料 | 图库 | 从豆瓣补电视剧封面 / 评分 / 简介 / 演员。 |
| `douban-movie-metadata` | 补全电影豆瓣资料 | 图库 | 用可视 Chrome 从豆瓣补电影资料。 |
| `export-douban-cookie` | 导出 Chrome 豆瓣 Cookie | 图库 | 从本机 Chrome 导出 douban.com Cookie 到 `data/douban-cookie.txt`。 |
| `generate-missing-covers` | 批量补本地封面 | 缓存 | 从本地视频抽帧生成缺失封面。 |
| `sync-sidecars` | 同步 sidecar 文件 | 文件 | 把 SQLite 里的 JavDB 资料 / 封面回写到本地作品目录（默认只统计，加 `--write` 才写）。 |
| `cache-local-images` | 本地图片缓存 | 缓存 | 把本地头像 / 封面写入本地图片缓存。 |
| `cache-remote-images` | 远端图片缓存 | 缓存 | 下载已知 JavDB 图片 URL 到远端图片缓存。 |
| `cleanup-metadata-cache` | 清理资料缓存 | 维护 | 清理孤儿资料 / 封面 / 演员缓存（默认 dry-run）。 |
| `cleanup-user-state` | 清理用户状态 | 维护 | 修复失效的收藏 / 进度记录（默认 dry-run）。 |
| `metadata-quality-report` | 资料质量报告 | 报表 | 统计缺资料 / 缺封面 / 错误行。 |
| `scan-noise-report` | 扫描噪声报告 | 报表 | 找出疑似 sample / preview / trailer 的噪声视频。 |
| `missing-local-report` | 演员缺失报告 | 报表 | 按 actor_movies 缓存统计本地未下载项。 |
| `import-info-metadata` | 导入本地 info 元数据 | 文件 | 从本地 info/nfo/txt/json 导入作品资料缓存。 |
| `import-single-actor` | 导入单个演员 | JavDB | 手动导入 / 修正单个人物。 |
| `novel-library-rescan` | 刷新小说书库 | 小说 | 扫描本地 TXT 小说重建 `novels.sqlite`（保留阅读进度）。 |
| `music-library-rescan` | 刷新音乐库 | 音乐 | 扫描本地无损音乐目录重建 `music.sqlite`（保留收藏和播放进度）。 |
| `format-txt-document` | 格式化 TXT 文档 | 文本 | 把 TXT 整理成标准 UTF-8 章节格式。 |
| `verify-code-parsers` | 验证番号解析 | 验证 | 运行番号解析器测试。 |
| `verify-metadata-parsers` | 验证资料解析 | 验证 | 运行 info/nfo 解析器测试。 |

> 校验类与报表类脚本默认不写盘，可直接运行观察输出。维护类脚本大多默认 `--write=false` / dry-run，
> 确认输出后再放开写权限，避免误删或误回写本地文件。

## 包管理脚本

`package.json` 暴露了少量顶层脚本：

```powershell
npm start                 # node server.js
npm run verify            # 先检查仓库卫生，再运行解析、存储、客户端和模块边界的完整验证
npm run verify:repo-hygiene # 阻止生成目录、服务抓取副本和含 NUL 字节的源码进入版本库
npm run verify:codes      # 番号解析器测试
npm run verify:metadata   # 资料解析器测试
npm run verify:library-merge # 主资料库/欧美兼容范围验证
npm run verify:gallery-db # 图库 SQLite 建表与升级验证
npm run verify:modules    # 反射发现、七个可见业务模块、宿主边界和旧目录清理验证
npm run verify:short-video-client # Android 短视频模块结构、入口协议和生命周期验证
npm run verify:imports    # 检查重构后 JS/CSS 相对引用没有悬空
```

其余维护作业请走作业中心，不要在 `package.json` 里直接加长命令。

## 手动运行脚本

作业中心底层就是调用 `tools/` 下的脚本，也可以手动跑（注意 Node 用 >= 24，Python 用项目虚拟环境）：

```powershell
# Node 作业：欧美视频每个文件一张卡，缺封面时用 FFmpeg 写入核心图片缓存
node tools/generate_missing_covers.mjs --scope western --write --limit 20

# Python 作业：欧美 R 盘始终按“一个视频一条作品”刷新
python tools/full_scan_core_library.py --scope western --write --changed-only
```

具体参数以 `lib/admin-script-registry.js` 中各脚本的 `fields` 定义为准（每个字段都映射到命令行 flag）。

### 微密圈套图更新检查

固定目录格式为 `T:\微密圈\[人物名]\套图名称.rar`。历史目录不会被自动重命名；同步脚本会兼容方括号、常见来源后缀和旧 `artfilepath.csv` 映射。运行结果写到 `T:\微密圈\_catalog`：

```powershell
python tools\sync_tuimzz_photo_sets.py
```

解析“立即下载”后的百度云链接需要已登录 Cookie。Cookie 只从 `TUIMZZ_COOKIE` 环境变量或本机文件读取，不要把 Cookie 直接写进命令行参数。默认文件位置是：

```text
T:\微密圈\_catalog\tuimzz-cookie.txt
```

保存好 Cookie 后运行：

```powershell
python tools\sync_tuimzz_photo_sets.py --resolve-links
```

脚本只生成 `latest.html`、`latest.csv`、`latest.json` 和时间戳快照，不会访问网盘文件列表、下载、解压或改动现有 RAR。若 `latest.csv` 正被 Excel 占用，JSON/HTML 仍会更新，新 CSV 暂存为 `latest.pending.csv`；关闭 Excel 后再运行一次即可恢复覆盖正式文件。下载后的整理与图库索引刷新必须作为单独作业执行。

### 微密圈下载安全导入

下载目录名使用网盘根目录编号（如 `285`、`389A`），可以位于 `D:\`；staging 与执行清单分别写到 `D:\Taotu\.staging` 和 `D:\Taotu\manifests`。先运行预览：

```powershell
python tools\import_tuimzz_downloads.py --roots 285 389A
```

确认映射、重复包和待导入数量后再执行：

```powershell
python tools\import_tuimzz_downloads.py --roots 285 389A --workers 2 --execute
```

导入器只处理 T 盘缺少的序号；同序号重复 7z 必须逐字节哈希一致才会跳过。同名 RAR 内容不同会保留在 staging 并标记冲突，绝不会覆盖旧文件。每个新 RAR 都经过 UnRAR 完整测试、图片或视频成员检查和跨盘 SHA-256 校验；纯视频包允许图片数为 0。源 7z 始终保留，导入完成后另行运行“刷新图库索引”（范围选“只扫套图”）。密码优先读取 `TAOTU_ARCHIVE_PASSWORD`，否则只读解析旧 `Tool\unzip.py` 的 `DEFAULT_PASSWORD`；密码不会进入新源码、命令输出或 manifest。
