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

也可直接 `node server.js`（需先设好环境变量，见 [项目配置](./configuration.md)）。

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
| `image-library-rescan` | 刷新图库索引 | 图库 | 重建套图 / 欧美 / 电影 / 电视剧索引（只更新 `image-library-index.json`）。 |
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
| `format-txt-document` | 格式化 TXT 文档 | 文本 | 把 TXT 整理成标准 UTF-8 章节格式。 |
| `verify-code-parsers` | 验证番号解析 | 验证 | 运行番号解析器测试。 |
| `verify-metadata-parsers` | 验证资料解析 | 验证 | 运行 info/nfo 解析器测试。 |

> 校验类与报表类脚本默认不写盘，可直接运行观察输出。维护类脚本大多默认 `--write=false` / dry-run，
> 确认输出后再放开写权限，避免误删或误回写本地文件。

## 包管理脚本

`package.json` 暴露了少量顶层脚本：

```powershell
npm start                 # node server.js
npm run verify            # 同时跑 verify:codes 与 verify:metadata
npm run verify:codes      # 番号解析器测试
npm run verify:metadata   # 资料解析器测试
```

其余维护作业请走作业中心，不要在 `package.json` 里直接加长命令。

## 手动运行脚本

作业中心底层就是调用 `tools/` 下的脚本，也可以手动跑（注意 Node 用 >= 24，Python 用项目虚拟环境）：

```powershell
# Node 作业
node tools/generate_missing_covers.mjs --write --limit 20

# Python 作业（举例）
python tools/full_scan_core_library.py --scope western --write --changed-only
```

具体参数以 `lib/admin-script-registry.js` 中各脚本的 `fields` 定义为准（每个字段都映射到命令行 flag）。
