# 数据布局

FanHao 把本地状态放在项目根下的 `data/` 目录，包含若干 SQLite 数据库、JSON 状态文件、缓存与日志。
服务端的扫描索引、用户状态与派生缓存都落在这里，正常情况下无需手工编辑。

## `data/` 目录

| 文件 / 目录 | 类型 | 说明 |
| --- | --- | --- |
| `fanhao-core-v2.sqlite` | SQLite | **核心库**：人物、作品、厂商、系列、图片、收藏列表、外部引用等规范化模型。详见 [核心数据库](./fanhao-core-database.md)。 |
| `image-gallery.sqlite` | SQLite | 图库独立库：套图封面、套图图片索引、电视剧 / 电影元数据、图库媒体封面。 |
| `novels.sqlite` | SQLite | 小说书库：书籍、章节、阅读进度。 |
| `novel-collection.sqlite` | SQLite | 小说网页采集：自定义站点适配器、任务状态与结果摘要。 |
| `short-videos.sqlite` | SQLite | 短视频库：点赞短视频索引与元数据。 |
| `music.sqlite` | SQLite | 音乐独立库：本地音频、歌手、专辑、歌词、收藏与播放进度。 |
| `user-state.json` | JSON | 用户状态：收藏夹、收藏、播放进度、观看历史、手动封面覆盖。 |
| `app-config.json` | JSON | App 运行期配置（如图库读取缓存上限）。 |
| `auth-secret.txt` | 文本 | 访问鉴权 HMAC 密钥（首次启动随机生成）。 |
| `douban-cookie.txt` | 文本 | 豆瓣 Cookie（供电视剧 / 电影资料补全作业使用）。 |
| `admin-tasks.json` | JSON | 后台作业历史与状态。 |
| `library-index.json` | JSON | 旧版扫描索引缓存（核心库时代已被 `fanhao-core-v2.sqlite` 取代，但兼容读取）。 |
| `image-library-index.json` | JSON | 图库索引缓存（套图 / 电影 / 电视剧扫描结果；旧文件可能暂存欧美兼容项）。 |
| `android-update/` | 目录 | 安卓 APK 更新通道文件（debug / release）。 |
| `image-reader-cache/` | 目录 | 图片读取器运行时缓存（受 `app-config` 上限约束，可随时清理）。 |
| `tool-downloads/` | 目录 | 工具临时下载（如 TXT 格式化结果，带 TTL）。 |
| `novel-collection/` | 目录 | 小说采集任务配置、结构化结果、TXT 输出和逐任务日志。 |

> 日志不在 `data/` 下，而在项目根 `logs/`（`access.log`、`fanhao.out.log`、`fanhao.err.log`）。

## 抖音采集与下载模块数据

抖音下载管理器作为短视频模块的独立子目录，运行数据位于：

- `src/modules/short-videos/download-manager/data/douyin_downloads.sqlite`：主页、采集链接、下载队列、任务和文件记录。
- `src/modules/short-videos/download-manager/data/configs/`：下载器临时配置与 cookie 副本。
- `src/modules/short-videos/download-manager/logs/`：采集、下载、sidecar 和守护日志。

这些运行数据已被 Git 忽略。`data/short-videos.sqlite` 仍是 FanHao 展示层的短视频库，服务会从下载管理器数据库做增量同步；备份或迁移机器时，两份 SQLite 都应保留。

## 核心库（`fanhao-core-v2.sqlite`）

设计中心是**作品番号（work code）**：`code` 为人可见番号（如 `IPX-247`），内部关系一律绑定整数 `id`。
重复番号允许存在，关系永远指向 `works.id` 而非 `code`。

主要表（详见 [核心数据库](./fanhao-core-database.md)）：

- `works`：作品主表（`code` / `code_search` / 标题 / 日期 / 评分 / 原始资料）。
- `local_works` / `local_files`：本地文件 / 文件夹与作品的绑定。
- `people` / `work_people` / `person_aliases`：人物与别名。
- `makers` / `series` / `work_makers` / `work_series`：厂商、系列及其关系。
- `images`：统一图片资产表（`owner_type`=work/person，`kind`=cover/avatar/preview，`source_type`=local/remote/generated）。
- `*_external_refs`：JavDB 等外部站点标识（`UNIQUE(provider, external_key)`）。
- `collections` / `collection_items`：TOP250 等作品集合。
- `work_logs`：预留的作品事件日志（抓取 / 匹配 / 下载 / 编辑）。

缓存失效（invalidation）通过「表数据戳（table data stamp）」机制实现：
任一处写入核心表后，调用 `invalidateTableStamp(...)`，相关服务据此刷新内存缓存。

## 图库库（`image-gallery.sqlite`）

- `photo_set_covers` / `photo_set_image_indexes`：套图封面与图片索引。
- `tv_series_metadata` / `movie_metadata`：电视剧 / 电影豆瓣元数据（封面以 BLOB 内联存储）。
- `gallery_media_covers`：电影 / 电视剧媒体封面缓存（可能保留旧版欧美缓存记录）。

## 音乐库（`music.sqlite`）

音乐模块默认扫描 `D:\Media\Music`，也可通过 `FANHAO_MUSIC_ROOTS` / `FANHAO_MUSIC_ROOT`
覆盖。扫描会重建歌手、专辑、歌曲、歌词与全文搜索索引，保留 `music_track_state` 中的收藏、播放次数与播放进度。

主要表：

- `music_artists` / `music_albums` / `music_tracks`：歌手、专辑、歌曲索引。
- `music_lyrics`：同名 `.lrc` 或目录歌词文本解析结果。
- `music_track_state`：收藏、播放进度、播放次数与最近播放时间。
- `music_search`：歌曲 / 歌手 / 专辑 / 歌词全文搜索索引。

## 用户状态（`user-state.json`）

结构（节选）：

```jsonc
{
  "favoriteFolders": { "default": { "id": "default", "name": "默认收藏", "workIds": [] } },
  "favorites": { "<workId>": { "folderId": "default", "createdAt": "..." } },
  "playback": { "<videoId>": { "position": 123, "duration": 456, "updatedAt": "..." } },
  "history": [ { "workId": "...", "lastWatchedAt": "..." } ],
  "manualCovers": { "<workId>": { "coverPath": "...", "updatedAt": "..." } }
}
```

清理类作业（`cleanup-user-state`）默认只 dry-run，确认后再 `--write`，避免误删有效记录。

## 缓存与临时数据

- **图片读取器缓存**（`image-reader-cache/`）：手机端图库浏览的图片缓存，大小受 `app-config` 约束，
  可通过 `POST /api/image-reader/cache/cleanup` 清理。
- **本地 / 远端图片缓存**：演员头像、作品封面等，由 `cache-local-images` / `cache-remote-images` 作业填充。
- **工具下载**（`tool-downloads/`）：TXT 格式化等临时产物，带 TTL 自动过期。

## 数据安全提示

- `data/` 下数据库与状态文件是该资料库的唯一事实来源，迁移机器时连目录一起拷贝即可。
- 删除 `user-state.json` 会丢失收藏 / 进度；删除 `fanhao-core-v2.sqlite` 会丢失全部元数据与映射，需重新扫描。
- 维护类脚本大多默认 dry-run，正式写盘前先观察输出（见 [维护与作业](./maintenance.md)）。
