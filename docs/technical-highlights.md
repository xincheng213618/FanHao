# 技术亮点（Technical Highlights）

本文记录项目里**真正有料**的工程实现，重点在「流畅滑动 / 渲染性能」与「服务端流式传输」两块。所有内容都对照源码核实，便于二次开发与性能调优。

> 配套阅读：[配置说明](configuration.md) · [API 参考](api-reference.md) · [维护与后台作业](maintenance.md)

---

## 1. 短视频：自定义虚拟滚动窗口（流畅滑动核心）

短视频页没有用任何虚拟滚动库，而是手写了一套 **windowing（窗口化）** 方案，几千条视频也能丝滑滚动。

**核心思路**（`public/modules/short-videos/short-video-page.js`）：

1. 外层 `grid` 撑满整个列表的**真实总高度**（`totalRows * svRowH`），保留原生滚动条与滚动惯性；
2. 内层 `.short-video-window` 只渲染「当前视口内的若干行 + 缓冲区」，用 **GPU 加速的 transform** 定位到正确偏移：
   ```js
   grid.style.height = `${Math.max(0, totalRows * svRowH - SV_ROW_GAP)}px`;
   inner.style.transform = `translate3d(0, ${startRow * svRowH}px, 0)`;
   ```
3. 滚动时按 `requestAnimationFrame` 批量重算窗口，避免每帧重复布局：
   ```js
   function scheduleShortVideoWindowUpdate() {
     if (svScrollRaf) return;
     svScrollRaf = window.requestAnimationFrame(() => {
       svScrollRaf = 0;
       updateShortVideoWindowAndLoadMore();
     });
   }
   ```

**关键常量**（可按设备性能调）：

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `SV_MIN_COL` | 176 | 单列最小宽度（px），据此自动算列数 `svCols` |
| `SV_COL_GAP` / `SV_ROW_GAP` | 10 / 14 | 卡片间距 |
| `SV_BUFFER_ROWS` | 12 | 视口上下各多渲染的行数，减少白屏 |
| `SV_APPEND_LOOKAHEAD_ROWS` | 18 | 滚动到距底部 18 行时自动向后端追加数据 |

**配套优化**：
- 列数响应式：`svCols = floor((容器宽 + 列距) / (单列宽 + 列距))`；
- 触屏 / 指针 / 滚轮拖拽：`touchstart/move/end`、`pointer*`、`wheel` 监听，`passive` 尽量开（拖拽用 `passive:false` 以阻止默认滚动手势），配合 `applyDragDelta` 做跟手位移；
- 切换视频时加 `is-slide-next` / `is-slide-prev` CSS 过渡，营造「翻页」动效而不引起重排。

---

## 2. 作品列表：分批增量渲染 + 封面分批加载

人物详情里的作品列表（本地可达数千部）用「**先渲染一屏，再分批补齐**」避免一次性建 DOM 卡死主线程。

**分批渲染**（`public/app.js` 的 `renderWorks`）：

```js
const WORK_RENDER_INITIAL_COUNT = 96;   // 首屏立即渲染
const WORK_RENDER_BATCH_SIZE    = 96;   // 每批补渲染数量
const WORK_RENDER_BATCH_DELAY   = 16;   // 每批间隔 ≈ 1 帧(16ms)
```

首屏用 `DocumentFragment` 一次性插入 96 张卡；剩余部分通过 `scheduleRemainingWorkCards` 每 16ms 再塞一批。用一个**单调递增序号 `workRenderSeq`** 取消过期渲染——切换筛选/排序时旧批次自动作废，不会越描越乱。

**封面分批加载队列**（同样在 `app.js`）：封面不随 DOM 一起 `src=`，而是先挂 `data-src`，统一进 `coverLoadQueue`，由定时器**每批限量拉取**：

```js
const COVER_LOAD_BATCH_SIZE  = 16;  // 每批最多 16 张封面
const COVER_LOAD_BATCH_DELAY = 45;  // 批间隔 45ms
const COVER_EAGER_COUNT      = 48;  // 前 48 张立即加载
const COVER_HIGH_PRIORITY_COUNT = 24;// 前 24 张 fetchpriority=high
```

- 屏外封面交给 `IntersectionObserver`（`rootMargin: 900px`）触发入队，进入视口前就提前加载；
- `<img>` 统一设 `loading="lazy"`、`decoding="async"`、`referrerPolicy="no-referrer"`；
- **封面失败指数退避重试**：`COVER_RETRY_DELAYS = [700, 1400, 2400, 4000, 6500, 9000]` ms，重试时追加 `_coverRetry=n` 绕过缓存。

---

## 3. 套图 / 韩漫阅读器：rAF 节流的视口预加载

阅读长图集（几十上百张）时，关键不是「一次性加载」，而是「**只加载离视口近的图**」，且滚动处理必须不阻塞。

`gallery-renderer.js` 的 `activateGalleryReaderImages`：

```js
const loadNearViewport = () => {
  ticking = false;
  const lower = window.innerHeight + 420; // 视口下沿再外扩 420px
  const upper = -420;
  for (const figure of figures) {
    if (!figure.dataset.gallerySrc) continue;
    const rect = figure.getBoundingClientRect();
    if (rect.top <= lower && rect.bottom >= upper) loadFigure(figure);
  }
};
const requestCheck = () => {
  if (ticking) return;
  ticking = true;
  window.requestAnimationFrame(loadNearViewport); // rAF 节流
};
window.addEventListener("scroll", requestCheck, { passive: true });
```

- 滚动监听 `passive:true`（不阻塞滚动），但真正的加载判断用 `requestAnimationFrame` 合并到下一帧，避免高频 scroll 事件下重复计算；
- 只加载 `[-420px, 视口高+420px]` 区间内的图，上下留一点预读余量，翻阅时基本无白图。

---

## 4. 画廊与人物索引：IntersectionObserver 驱动的懒加载 & 无限滚动

几乎所有「列表 + 更多」都复用了同一套 `IntersectionObserver` 模式，统一靠「哨兵元素进入视口即触发」实现无感分页：

| 场景 | 文件 / 函数 | rootMargin | 行为 |
| --- | --- | --- | --- |
| 短视频封面 | `short-video-page.js` `ensureShortVideoCoverObserver` | `720px 0px` | 进入视口前 720px 预载封面 |
| 短视频加载更多 | `observeLoadMoreSentinel` | `900px 0px` | 接近底部自动追数据 |
| 作品「显示更多」 | `app.js` `setupWorkLoadMoreAutoload` | `0px 0px 1400px 0px` | 自动点「向下滑动继续加载」 |
| 画廊封面 | `gallery-renderer.js` `activateGalleryLazyImages` | `600px 0px` | 懒加载封面，前 18 张立即加载 |
| 人物索引 | `people-page.js` `loadMorePeopleIndex` | `720px 0px` | `personVisibleLimit += pageSize` |

「显示更多」按钮还会在 `rootMargin` 命中时自动 `click()`，所以用户**一直往下滚就一直加载**，无需手动点。无限滚动的自动检查还带 `WORK_AUTO_LOAD_RECHECK_DELAYS = [120, 480, 900]` ms 的兜底轮询，防止 observer 偶发漏触发。

导航跳转后统一 `window.scrollTo({ top: 0, behavior: "smooth" })` 平滑回顶。

---

## 5. 访问模式自适应的加载策略

后端根据访问来源（`local` / `lan` / `remote`）自动调低批量，保证弱网下也流畅：

```js
state.workPageSize  = Number(state.accessHints.workPageSize) || (state.accessMode === "remote" ? 80 : 1000);
state.personPageSize = state.accessMode === "lan" ? 80 : 96;
```

- 本机（local）：单次最多 1000 条、人物页 96 条，充分利用本地磁盘带宽；
- 局域网（lan）/ 远程（remote）：降到 80 条，减少单次传输与前端渲染压力。

封面批大小、缓冲区行数等前端常量也可随模式切换（见 `gallery-renderer.js` 的 `PHOTO_READER_BATCH_SIZES`：`local/lan:160`、`remote:24`、`fallback:48`）。

---

## 6. 服务端：HTTP 字节范围流式（拖动进度不卡）

视频播放支持 **Range 请求**，所以「拖动进度条跳转」「断点续传」都不需要下载整文件。

`src/platform/server/file-server.js` 的 `serveRangedFile`：

```js
const range = parseRange(req.headers.range, stat.size); // "bytes=start-end"
res.writeHead(206, {
  "Content-Type": contentType,
  "Accept-Ranges": "bytes",
  "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
  "Content-Length": range.end - range.start + 1,
  "Cache-Control": "no-store",
  "Content-Disposition": "inline"
});
pipeFileRange(req, res, file.path, range);
```

`pipeFileRange` 用 `fs.createReadStream(filePath, { start, end })` 只流出对应字节，并**优雅处理客户端中断**：

```js
req.on("aborted", closeStream);
res.on("close", closeStream);   // 关闭页面/拖动跳转时销毁流，避免句柄泄漏
stream.on("error", () => { if (!res.headersSent) res.writeHead(500, ...); res.end(); });
stream.pipe(res);
```

- `parseRange` 对越界（`start>end`、`end>=size` 等）返回 `null` 并回退到默认分片，不会崩溃；
- 转码视频路径（`media-stream-service.js` 的 `serveTranscodedVideo`）还支持 `-ss` **服务端定点起播**，配合 `?t=` 参数实现「从某秒开始看」而无需先解码前面内容；
- 图片端点（`serveImage` 等）走 `Cache-Control: public, max-age=3600`，静态封面可被浏览器/代理缓存。

> 这一层是前端「流畅滑动 + 即点即播」的底层支撑：客户端只拉当前需要的字节，scrub 时服务端随时切断旧流、开新流。

---

## 7. 启动时的 Service Worker / 缓存清理

`public/app.js` 在 `window load` 时主动注销遗留 Service Worker、删除 `fanhao-shell-*` 缓存：

```js
navigator.serviceWorker.getRegistrations?.().then((regs) =>
  regs.forEach((r) => r.unregister().catch(() => {})));
caches.keys().then((names) =>
  names.forEach((n) => n.startsWith("fanhao-shell-") && caches.delete(n).catch(() => {})));
```

避免旧版本缓存引发的「改了不生效 / 封面串台」类问题，也契合本项目「纯静态前端 + API 拉取」的部署形态（见 [安卓客户端](android-client.md) 的 Capacitor 说明）。

---

## 小结：性能设计的主线

| 维度 | 手法 |
| --- | --- |
| 长列表不卡 | 虚拟滚动窗口（短视频）/ 分批增量渲染（作品）/ `visibleLimit` 分页（画廊、人物） |
| 滚动流畅 | `requestAnimationFrame` 节流、`passive` 滚动监听、`translate3d` GPU 合成 |
| 图片不阻塞 | `IntersectionObserver` 懒加载 + 分批封面队列 + 前 N 张高优先级 + 失败退避重试 |
| 弱网可用 | 访问模式自适应批量、远程更小批 / 更少缓冲行 |
| 视频即拖即播 | 服务端 `206` 字节范围流式 + 中断优雅销毁 + 转码定点起播 |

这些实现分散在 `public/app.js`、`public/modules/*` 与 `src/platform/server/file-server.js`、`src/platform/server/media-stream-service.js`，是本项目体验顺滑的主要来源。
