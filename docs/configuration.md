# 项目配置

FanHao 服务端通过**环境变量**控制资料库根目录、端口、外部依赖路径与远程访问密码，
其余运行期配置（如图库读取缓存上限）持久化在 `data/app-config.json`。

## 运行环境要求

| 依赖 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | **>= 24** | 服务端大量使用内置 `node:sqlite`，低于 24 无法启动（`package.json` 已用 `engines` 约束）。 |
| ffmpeg / ffprobe | 建议在 `PATH` 中 | 视频转码、抽帧生成封面、探测播放模式依赖它们；可用 `FFMPEG_PATH` / `FFPROBE_PATH` 覆盖。 |
| NVIDIA 显卡（可选） | 支持 NVENC | 自动探测 `h264_nvenc`，存在则优先硬件转码；可用 `FANHAO_DISABLE_NVENC` 关闭。 |

## 网络与端口

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `29998` | HTTP 监听端口。 |
| `HOST` | `0.0.0.0` | 监听地址，默认对所有网卡开放（含局域网）。 |

`start-fanhao.ps1` 接受 `-Port` 与 `-HostName` 参数，会写入上述环境变量再启动。

## 资料库根目录

根目录以分号 `;` 或逗号 `,` 分隔。路径结尾的斜杠会被保留为「根」语义。
`[A]`、`[A1]` 等文件夹会被当作特殊人物分类处理（见 `server.js` 中的 local-work marker 逻辑）。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LIBRARY_ROOTS` | `G:\;F:\;O:\;O:\[珍藏]\;O:\[珍藏1]\;O:\[稀有]\;O:\[动漫]\;V:\[A]\;V:\[A1]\;V:\AV\` | 主资料库根目录列表。 |
| `LIBRARY_ROOT` | （未设置时使用 `LIBRARY_ROOTS`） | 单根别名。 |
| `FANHAO_WESTERN_ROOTS` | `R:\` | 欧美影视根目录（按人物文件夹进入统一播放逻辑）。 |
| `FANHAO_MANGA_ROOT` | `E:\https-smtt6-com-man-hua-yue` | 漫画（manga）缓存根目录。 |
| `FANHAO_PHOTO_SET_ROOTS` | `T:\;T:\[套图1]` | 套图（photo set）根目录。 |
| `FANHAO_MOVIE_ROOTS` | `Z:\` | 图库中的「电影」媒体源。 |
| `FANHAO_TV_ROOTS` | `Y:\` | 图库中的「电视剧」媒体源。 |
| `FANHAO_SHORT_VIDEO_ROOTS` / `FANHAO_DOUYIN_LIKES_ROOT` | `~/Downloads/likes/MS4wLjABAAAA...` | 抖音点赞短视频根目录。 |
| `FANHAO_DOUYIN_DOWNLOAD_MANAGER_DB` | `~/Desktop/Tool/douyin-download-manager/data/douyin_downloads.sqlite` | 抖音下载管理器数据库路径（短视频模块可选同步来源）。 |
| `FANHAO_DOUYIN_SYNC_MS` | `300000`（5 分钟） | 短视频从下载管理器同步的轮询间隔。 |

> 解析逻辑见 `src/server/root-config.js`。环境变量优先于硬编码默认值；未设置时回退到默认盘符。

## 外部工具路径

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FFMPEG_PATH` | `ffmpeg` | ffmpeg 可执行文件路径（支持绝对路径）。 |
| `FFPROBE_PATH` | `ffprobe` | ffprobe 可执行文件路径。 |
| `FANHAO_DISABLE_NVENC` | （未设置 = 启用） | 设为 `1` 关闭 NVENC 硬件转码，改用软解。 |

## 访问控制

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FANHAO_WEB_PASSWORD` | `xincheng` | 远程（非局域网）网页访问密码。本地 / 局域网访问默认免密。 |

服务端按请求 Host / 客户端 IP 判定访问模式（`local` / `lan` / `remote`），见 `src/server/auth.js`：

- **local**：`localhost` / `127.0.0.1` —— 免密，页面尺寸与预加载最宽松。
- **lan**：私有网段（如 `192.168.*.*`、`10.*.*.*`、`.local`）—— 免密。
- **remote**：其余来源 —— 必须输入 `FANHAO_WEB_PASSWORD`，通过 Cookie 维持登录态。

## 运行期配置（持久化）

以下配置不通过环境变量设置，而是在首次运行时写入 `data/app-config.json`，可由管理页 `/api/admin/config` 修改：

| 配置项 | 说明 |
| --- | --- |
| 图库读取缓存上限 | 图片读取器（image-reader）缓存占用上限，默认 2 GiB，范围 128 MiB ~ 200 GiB。影响手机端图库浏览稳定性。 |
| 豆瓣 Cookie | 写入 `data/douban-cookie.txt`，供电视剧 / 电影资料补全作业访问豆瓣详情页。 |

## 示例：自定义启动

```powershell
$env:LIBRARY_ROOTS = "G:\;F:\;O:\;V:\AV\"
$env:PORT = "29998"
$env:HOST = "0.0.0.0"
$env:FANHAO_WEB_PASSWORD = "your-strong-password"
npm start
```

或在 `start-fanhao.ps1 -Port 29998` 之外，直接用 `node server.js` 并在环境变量中覆盖上述任意项。
