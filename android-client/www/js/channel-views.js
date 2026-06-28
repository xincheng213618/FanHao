import { fetchJson } from "./api.js";
import { cacheAgeText, readCachedJson, writeCachedJson } from "./cache.js";
import { formatBytes, formatDate, formatNumber } from "./format.js";
import { absoluteUrl, loadPreviewImage } from "./image.js";

const CHANNELS = {
  photo: { label: "套图", path: "/photo", empty: "还没有索引到图包。", unit: "图包" },
  manga: { label: "韩漫", path: "/manga", empty: "还没有缓存漫画。", unit: "部" },
  western: { label: "欧美", path: "/western", empty: "还没有索引到欧美视频。", unit: "视频" },
  movie: { label: "电影", path: "/movies", empty: "还没有索引到电影。", unit: "影片" },
  tv: { label: "电视剧", path: "/tv", empty: "还没有索引到电视剧。", unit: "集" }
};

export function normalizeChannelMode(value) {
  const mode = String(value || "").trim();
  if (mode === "movies") return "movie";
  return CHANNELS[mode] ? mode : "photo";
}

export function channelConfig(mode) {
  return CHANNELS[normalizeChannelMode(mode)] || CHANNELS.photo;
}

export function createChannelViews(context) {
  const {
    els,
    getActiveUrl,
    getChannelLimit,
    increaseChannelLimit,
    getPhotoImageLimit = () => 24,
    increasePhotoImageLimit = () => {},
    getMangaImageLimit = () => 12,
    increaseMangaImageLimit = () => {},
    openInLibrary,
    showPhotoDetail = null,
    showMangaDetail = null,
    showMangaChapter = null,
    showMediaDetail = null,
    setActiveBottom,
    renderCurrentView,
    getMediaViewer = () => null,
    updateChannelQuery = () => {}
  } = context;

  async function renderChannel(params = {}, isActive = () => true) {
    const normalizedMode = normalizeChannelMode(typeof params === "string" ? params : params.mode);
    const query = String(typeof params === "object" ? params.query || "" : "").trim();
    const channel = channelConfig(normalizedMode);
    const limit = getChannelLimit();
    const path = channelItemsPath(normalizedMode, limit, query);
    const activeUrl = getActiveUrl();
    let renderedCache = false;

    setActiveBottom("home");
    els.viewKicker.textContent = query ? "频道搜索" : "内容频道";
    els.viewTitle.textContent = query ? `${channel.label}：${query}` : channel.label;
    els.viewMeta.textContent = query ? "正在筛选" : "正在读取";
    els.viewOpenAll.textContent = "网页打开";
    els.viewOpenAll.onclick = () => openInLibrary(query ? `${channel.path}?q=${encodeURIComponent(query)}` : channel.path);
    els.viewContent.innerHTML = `<div class="loading-row">正在加载${channel.label}</div>`;

    const cached = await readCachedJson(activeUrl, path).catch(() => null);
    if (!isActive()) return;
    if (cached?.payload) {
      renderedCache = true;
      renderChannelData(normalizedMode, cached.payload, cached);
    }

    try {
      const data = await fetchJson(activeUrl, path, { timeoutMs: 12000, signal: isActive.signal });
      writeCachedJson(activeUrl, path, data).catch(() => {});
      if (!isActive()) return;
      renderChannelData(normalizedMode, data);
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) {
        renderMessage("电脑端暂时连不上，当前显示的是本地缓存。", "quiet", false);
      } else {
        renderMessage(error.message || `${channel.label}读取失败`, "error");
      }
    }
  }

  function renderChannelData(mode, data = {}, cacheEntry = null) {
    const channel = channelConfig(mode);
    const items = data.items || [];
    const total = Number(data.total || items.length);
    const query = String(data.query || "").trim();
    const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : data.scannedAt ? ` · 更新 ${cacheAgeText(data.scannedAt)}` : "";
    els.viewTitle.textContent = query ? `${channel.label}：${query}` : channel.label;
    els.viewMeta.textContent = query
      ? `${formatNumber(total)} 个匹配 · 已显示 ${formatNumber(items.length)}${suffix}`
      : `${formatNumber(items.length)} / ${formatNumber(total)} ${channel.unit}${suffix}`;
    els.viewContent.innerHTML = "";

    if (query) {
      els.viewContent.append(createChannelQueryRow(channel, query));
    }

    if (!items.length) {
      renderMessage(query ? `没有搜到「${query}」。` : channel.empty, "quiet", false);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "channel-list";
    for (const item of items) {
      grid.append(createChannelCard(mode, item));
    }
    els.viewContent.append(grid);

    if (items.length < total) {
      els.viewContent.append(createLoadMoreButton(`显示更多 ${formatNumber(items.length)} / ${formatNumber(total)}`, () => {
        increaseChannelLimit(48);
        renderCurrentView();
      }));
    }
  }

  function createChannelCard(mode, item) {
    const channel = channelConfig(mode);
    const card = document.createElement("button");
    card.type = "button";
    card.className = `channel-card ${mode}`;
    card.addEventListener("click", () => {
      if (mode === "photo" && item.id && showPhotoDetail) {
        showPhotoDetail(item.id);
        return;
      }
      if (mode === "manga" && item.id && showMangaDetail) {
        showMangaDetail(item.id);
        return;
      }
      if (["western", "movie", "tv"].includes(mode) && item.id && showMediaDetail) {
        showMediaDetail(item.id);
        return;
      }
      openInLibrary(item.routePath || channel.path);
    });

    const thumb = document.createElement("div");
    thumb.className = "channel-thumb";
    thumb.textContent = thumbFallbackText(item.title || channel.label);
    const cover = item.coverUrl ? absoluteUrl(getActiveUrl(), item.coverUrl) : "";
    if (cover) loadPreviewImage(thumb, cover, { cacheBaseUrl: getActiveUrl() });

    const body = document.createElement("div");
    body.className = "channel-summary";

    const label = document.createElement("span");
    label.className = "channel-label";
    label.textContent = channelCardLabel(mode, item);

    const title = document.createElement("strong");
    title.textContent = item.title || channel.label;

    const facts = document.createElement("div");
    facts.className = "channel-facts";
    for (const fact of channelFacts(mode, item).filter(Boolean).slice(0, 3)) {
      const node = document.createElement("span");
      node.textContent = fact;
      facts.append(node);
    }

    body.append(label, title, facts);
    card.append(thumb, body);
    return card;
  }

  function createChannelQueryRow(channel, query) {
    const row = document.createElement("div");
    row.className = "channel-query-row";

    const text = document.createElement("span");
    text.textContent = `${channel.label}内筛选：${query}`;

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "清除";
    button.addEventListener("click", () => updateChannelQuery(""));

    row.append(text, button);
    return row;
  }

  function channelCardLabel(mode, item) {
    if (mode === "manga") return [item.category, chapterProgressText(item)].filter(Boolean).join(" · ") || "漫画";
    if (mode === "photo") return [item.category, item.personName].filter(Boolean).join(" · ") || "图包";
    return [item.category, item.seriesName || item.personName].filter(Boolean).join(" · ") || channelConfig(mode).label;
  }

  function channelFacts(mode, item) {
    if (mode === "manga") {
      return [
        item.chapterCount !== null ? `${formatNumber(item.chapterCount)} 话` : "",
        item.imageCount !== null ? `${formatNumber(item.imageCount)} 张` : "",
        formatDate(item.updatedAt)
      ];
    }
    if (mode === "photo") {
      return [
        item.ext ? item.ext.toUpperCase() : "",
        formatBytes(item.size),
        formatDate(item.updatedAt)
      ];
    }
    return [
      item.ext ? item.ext.toUpperCase() : "",
      formatBytes(item.size),
      formatDate(item.updatedAt)
    ];
  }

  function chapterProgressText(item) {
    if (item.doneChapterCount === null || item.chapterCount === null) return "";
    return `${formatNumber(item.doneChapterCount)}/${formatNumber(item.chapterCount)} 话`;
  }

  function thumbFallbackText(value) {
    return String(value || "?").trim().slice(0, 2) || "?";
  }

  function channelItemsPath(mode, limit, query = "") {
    const params = new URLSearchParams({
      mode,
      limit: String(limit),
      offset: "0"
    });
    const text = String(query || "").trim();
    if (text) params.set("q", text);
    return `/api/image-library/items?${params}`;
  }

  function createLoadMoreButton(text, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-button channel-more";
    button.textContent = text;
    button.addEventListener("click", handler);
    return button;
  }

  function renderMessage(message, tone = "quiet", replace = true) {
    const node = document.createElement("div");
    node.className = `loading-row ${tone}`;
    node.textContent = message;
    if (replace) els.viewContent.innerHTML = "";
    els.viewContent.append(node);
  }

  async function renderPhotoDetail(id, isActive = () => true) {
    const albumId = String(id || "").trim();
    const path = photoDetailPath(albumId);
    const activeUrl = getActiveUrl();
    let renderedCache = false;

    setActiveBottom("home");
    els.viewKicker.textContent = "套图";
    els.viewTitle.textContent = "图包详情";
    els.viewMeta.textContent = "正在读取";
    els.viewOpenAll.textContent = "网页打开";
    els.viewOpenAll.onclick = () => openInLibrary(photoRoutePath(albumId));
    els.viewContent.innerHTML = `<div class="loading-row">正在读取图包</div>`;

    if (!albumId) {
      renderMessage("图包 ID 无效。", "error");
      return;
    }

    const cached = await readCachedJson(activeUrl, path).catch(() => null);
    if (!isActive()) return;
    if (cached?.payload?.album) {
      renderedCache = true;
      renderPhotoAlbum(cached.payload.album, cached);
    }

    try {
      const data = await fetchJson(activeUrl, path, { timeoutMs: 20000, signal: isActive.signal });
      writeCachedJson(activeUrl, path, data).catch(() => {});
      if (!isActive()) return;
      renderPhotoAlbum(data.album);
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) {
        renderMessage("电脑端暂时连不上，当前显示的是本地缓存图包。", "quiet", false);
      } else {
        renderMessage(error.message || "图包读取失败", "error");
      }
    }
  }

  function renderPhotoAlbum(album = {}, cacheEntry = null) {
    const images = Array.isArray(album.images) ? album.images : [];
    const limit = getPhotoImageLimit();
    const visible = images.slice(0, limit);
    const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";

    els.viewKicker.textContent = [album.category, album.personName].filter(Boolean).join(" · ") || "套图";
    els.viewTitle.textContent = album.title || "图包详情";
    els.viewMeta.textContent = `${formatNumber(images.length || album.imageCount || 0)} 张 · ${formatBytes(album.size)}${suffix}`;
    els.viewOpenAll.textContent = "网页打开";
    els.viewOpenAll.onclick = () => openInLibrary(photoRoutePath(album.id));
    els.viewContent.innerHTML = "";
    els.viewContent.append(createPhotoSummary(album));

    if (!visible.length) {
      renderMessage("这个图包暂时没有可预览图片。", "quiet", false);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "photo-preview-grid";
    visible.forEach((image) => grid.append(createPhotoTile(album, image)));
    els.viewContent.append(grid);

    if (visible.length < images.length) {
      els.viewContent.append(createLoadMoreButton(`继续显示图片 ${formatNumber(visible.length)} / ${formatNumber(images.length)}`, () => {
        increasePhotoImageLimit(24);
        renderCurrentView();
      }));
    }
  }

  function createPhotoSummary(album = {}) {
    const panel = document.createElement("div");
    panel.className = "photo-detail-summary";

    const title = document.createElement("strong");
    title.textContent = album.personName || album.subCategory || album.category || "套图";

    const facts = document.createElement("div");
    facts.className = "photo-detail-facts";
    for (const fact of [
      album.archiveExt ? album.archiveExt.toUpperCase() : "",
      formatBytes(album.size),
      album.imageCount !== null && album.imageCount !== undefined ? `${formatNumber(album.imageCount)} 张` : "",
      formatDate(album.updatedAt)
    ].filter(Boolean)) {
      const node = document.createElement("span");
      node.textContent = fact;
      facts.append(node);
    }

    panel.append(title, facts);
    return panel;
  }

  function createPhotoTile(album, image = {}) {
    const imageUrl = absoluteUrl(getActiveUrl(), image.url);
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "photo-preview-tile";

    const fallback = document.createElement("span");
    fallback.textContent = formatNumber(image.index || 0);
    tile.append(fallback);

    if (imageUrl) {
      const img = document.createElement("img");
      img.alt = image.name || `${album.title || "图包"} ${image.index || ""}`.trim();
      img.loading = "lazy";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      img.src = imageUrl;
      tile.append(img);
      tile.addEventListener("click", () => getMediaViewer()?.openImage(imageUrl, img.alt));
    }

    return tile;
  }

  function photoDetailPath(id) {
    return `/api/photo-sets/${encodeURIComponent(String(id || ""))}`;
  }

  function photoRoutePath(id) {
    return `/photo/set/${encodeURIComponent(String(id || ""))}`;
  }

  async function renderMediaDetail(id, isActive = () => true) {
    const mediaId = String(id || "").trim();
    const path = mediaDetailPath(mediaId);
    const activeUrl = getActiveUrl();
    let renderedCache = false;

    setActiveBottom("home");
    els.viewKicker.textContent = "媒体";
    els.viewTitle.textContent = "媒体详情";
    els.viewMeta.textContent = "正在读取";
    els.viewOpenAll.textContent = "网页打开";
    els.viewOpenAll.onclick = () => openInLibrary(mediaRoutePath("movie", mediaId));
    els.viewContent.innerHTML = `<div class="loading-row">正在读取媒体</div>`;

    if (!mediaId) {
      renderMessage("媒体 ID 无效。", "error");
      return;
    }

    const cached = await readCachedJson(activeUrl, path).catch(() => null);
    if (!isActive()) return;
    if (cached?.payload?.item) {
      renderedCache = true;
      renderGalleryMedia(cached.payload.item, cached);
    }

    try {
      const data = await fetchJson(activeUrl, path, { timeoutMs: 16000, signal: isActive.signal });
      writeCachedJson(activeUrl, path, data).catch(() => {});
      if (!isActive()) return;
      renderGalleryMedia(data.item);
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) {
        renderMessage("电脑端暂时连不上，当前显示的是本地缓存媒体信息。", "quiet", false);
      } else {
        renderMessage(error.message || "媒体读取失败", "error");
      }
    }
  }

  function renderGalleryMedia(item = {}, cacheEntry = null) {
    const mode = normalizeChannelMode(item.mediaKind || item.type);
    const channel = channelConfig(mode);
    const streamUrl = absoluteUrl(getActiveUrl(), item.streamUrl);
    const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
    const meta = [item.ext ? item.ext.toUpperCase() : "", formatBytes(item.size), item.exists === false ? "文件不可用" : ""]
      .filter(Boolean)
      .join(" · ");

    els.viewKicker.textContent = [channel.label, item.seriesName || item.category].filter(Boolean).join(" · ");
    els.viewTitle.textContent = mediaDisplayTitle(item, channel);
    els.viewMeta.textContent = `${meta}${suffix}`;
    els.viewOpenAll.textContent = "网页打开";
    els.viewOpenAll.onclick = () => openInLibrary(mediaRoutePath(mode, item.id));
    els.viewContent.innerHTML = "";

    els.viewContent.append(createMediaSummary(item, channel));
    els.viewContent.append(createMediaPlayerPanel(item, streamUrl, channel));
  }

  function createMediaSummary(item = {}, channel = CHANNELS.movie) {
    const panel = document.createElement("div");
    panel.className = "media-detail-summary";

    const title = document.createElement("strong");
    title.textContent = item.seriesName || item.category || channel.label;

    const facts = document.createElement("div");
    facts.className = "media-detail-facts";
    for (const fact of [
      item.ext ? item.ext.toUpperCase() : "",
      formatBytes(item.size),
      formatDate(item.updatedAt),
      item.rootLabel || ""
    ].filter(Boolean)) {
      const node = document.createElement("span");
      node.textContent = fact;
      facts.append(node);
    }

    panel.append(title, facts);
    if (item.relativePath) {
      const path = document.createElement("span");
      path.className = "media-detail-path";
      path.textContent = item.relativePath;
      panel.append(path);
    }
    return panel;
  }

  function mediaDisplayTitle(item = {}, channel = CHANNELS.movie) {
    return item.seriesName || item.category || item.personName || item.title || channel.label;
  }

  function createMediaPlayerPanel(item = {}, streamUrl = "", channel = CHANNELS.movie) {
    const panel = document.createElement("div");
    panel.className = "media-player-panel";

    const actions = document.createElement("div");
    actions.className = "media-action-row";
    actions.append(
      createMediaActionButton("原生播放", async () => {
        const opened = await openNativeMediaPlayer(item, streamUrl, channel);
        if (!opened) renderInlineMediaPlayer(panel, item, streamUrl);
      }),
      createMediaActionButton("网页内播放", () => renderInlineMediaPlayer(panel, item, streamUrl)),
      createMediaActionButton("网页备用", () => openInLibrary(mediaRoutePath(item.mediaKind || item.type, item.id)))
    );

    const hint = document.createElement("div");
    hint.className = "media-player-hint";
    hint.textContent = item.playable ? "可尝试直接播放；大文件建议优先原生播放器。" : "当前格式可能需要原生播放器或网页备用。";

    panel.append(actions, hint);
    if (item.playable && streamUrl) renderInlineMediaPlayer(panel, item, streamUrl, { keepActions: true });
    return panel;
  }

  function createMediaActionButton(label, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", handler);
    return button;
  }

  async function openNativeMediaPlayer(item = {}, streamUrl = "", channel = CHANNELS.movie) {
    const plugin = window.Capacitor?.Plugins?.FanHaoPlayer;
    if (!plugin?.play || !streamUrl) return false;
    try {
      await plugin.play({
        url: streamUrl,
        title: item.title || channel.label,
        subtitle: [channel.label, item.ext ? item.ext.toUpperCase() : "", formatBytes(item.size)].filter(Boolean).join(" · "),
        mode: "gallery-media",
        videoId: item.id,
        duration: 0
      });
      return true;
    } catch {
      return false;
    }
  }

  function renderInlineMediaPlayer(panel, item = {}, streamUrl = "", options = {}) {
    panel.querySelector(".media-inline-player")?.remove();
    panel.querySelector(".media-player-error")?.remove();

    if (!streamUrl) {
      const error = document.createElement("div");
      error.className = "media-player-error";
      error.textContent = "没有可播放地址。";
      panel.append(error);
      return;
    }

    const wrap = document.createElement("div");
    wrap.className = "media-inline-player";
    const video = document.createElement("video");
    video.controls = true;
    video.preload = "metadata";
    video.playsInline = true;
    video.src = streamUrl;

    const status = document.createElement("div");
    status.className = "media-player-status";
    status.textContent = "点播放键开始";
    video.addEventListener("play", () => {
      status.textContent = "正在播放";
    });
    video.addEventListener("pause", () => {
      if (!video.ended) status.textContent = "已暂停";
    });
    video.addEventListener("error", () => {
      status.textContent = "当前格式在 WebView 内无法播放，可试原生播放或网页备用。";
    });

    wrap.append(video, status);
    if (options.keepActions) {
      panel.append(wrap);
    } else {
      const actions = panel.querySelector(".media-action-row");
      actions?.after(wrap);
      if (!actions) panel.append(wrap);
    }
  }

  function mediaDetailPath(id) {
    return `/api/gallery-media/${encodeURIComponent(String(id || ""))}`;
  }

  function mediaRoutePath(kind, id) {
    const mode = normalizeChannelMode(kind);
    const encoded = encodeURIComponent(String(id || ""));
    if (mode === "western") return `/western/${encoded}`;
    if (mode === "tv") return `/tv/${encoded}`;
    return `/movies/${encoded}`;
  }

  async function renderMangaDetail(id, isActive = () => true) {
    const mangaId = String(id || "").trim();
    const path = mangaDetailPath(mangaId);
    const activeUrl = getActiveUrl();
    let renderedCache = false;

    setActiveBottom("home");
    els.viewKicker.textContent = "韩漫";
    els.viewTitle.textContent = "漫画详情";
    els.viewMeta.textContent = "正在读取";
    els.viewOpenAll.textContent = "网页打开";
    els.viewOpenAll.onclick = () => openInLibrary(mangaRoutePath(mangaId));
    els.viewContent.innerHTML = `<div class="loading-row">正在读取漫画</div>`;

    if (!mangaId) {
      renderMessage("漫画 ID 无效。", "error");
      return;
    }

    const cached = await readCachedJson(activeUrl, path).catch(() => null);
    if (!isActive()) return;
    if (cached?.payload?.comic) {
      renderedCache = true;
      renderMangaComic(cached.payload.comic, cached);
    }

    try {
      const data = await fetchJson(activeUrl, path, { timeoutMs: 16000, signal: isActive.signal });
      writeCachedJson(activeUrl, path, data).catch(() => {});
      if (!isActive()) return;
      renderMangaComic(data.comic);
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) {
        renderMessage("电脑端暂时连不上，当前显示的是本地缓存漫画。", "quiet", false);
      } else {
        renderMessage(error.message || "漫画读取失败", "error");
      }
    }
  }

  function renderMangaComic(comic = {}, cacheEntry = null) {
    const chapters = Array.isArray(comic.chapters) ? comic.chapters : [];
    const visible = chapters.slice(0, getChannelLimit());
    const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";

    els.viewKicker.textContent = [comic.site, comic.category].filter(Boolean).join(" · ") || "韩漫";
    els.viewTitle.textContent = comic.title || "漫画详情";
    els.viewMeta.textContent = `${formatNumber(chapters.length || comic.chapterCount || 0)} 话 · ${formatNumber(comic.imageCount || 0)} 张${suffix}`;
    els.viewOpenAll.textContent = "网页打开";
    els.viewOpenAll.onclick = () => openInLibrary(mangaRoutePath(comic.id));
    els.viewContent.innerHTML = "";
    els.viewContent.append(createMangaSummary(comic));

    if (!visible.length) {
      renderMessage("这部漫画暂时没有章节。", "quiet", false);
      return;
    }

    const list = document.createElement("div");
    list.className = "manga-chapter-list";
    visible.forEach((chapter) => list.append(createMangaChapterButton(comic, chapter)));
    els.viewContent.append(list);

    if (visible.length < chapters.length) {
      els.viewContent.append(createLoadMoreButton(`继续显示章节 ${formatNumber(visible.length)} / ${formatNumber(chapters.length)}`, () => {
        increaseChannelLimit(40);
        renderCurrentView();
      }));
    }
  }

  function createMangaSummary(comic = {}) {
    const panel = document.createElement("div");
    panel.className = "manga-detail-summary";

    const title = document.createElement("strong");
    title.textContent = comic.site || comic.category || "韩漫";

    const facts = document.createElement("div");
    facts.className = "manga-detail-facts";
    for (const fact of [
      comic.chapterCount !== null && comic.chapterCount !== undefined ? `${formatNumber(comic.chapterCount)} 话` : "",
      comic.doneChapterCount !== null && comic.doneChapterCount !== undefined ? `完成 ${formatNumber(comic.doneChapterCount)} 话` : "",
      comic.imageCount !== null && comic.imageCount !== undefined ? `${formatNumber(comic.imageCount)} 张` : "",
      formatDate(comic.updatedAt)
    ].filter(Boolean)) {
      const node = document.createElement("span");
      node.textContent = fact;
      facts.append(node);
    }

    panel.append(title, facts);
    return panel;
  }

  function createMangaChapterButton(comic, chapter = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "manga-chapter-card";
    button.addEventListener("click", () => showMangaChapter?.(comic.id, chapter.index));

    const title = document.createElement("strong");
    title.textContent = chapter.title || `第 ${chapter.index || ""} 话`.trim();

    const meta = document.createElement("span");
    meta.textContent = [
      chapter.imageCount !== null && chapter.imageCount !== undefined ? `${formatNumber(chapter.imageCount)} 张` : "",
      chapter.downloadedCount !== null && chapter.downloadedCount !== undefined ? `已缓存 ${formatNumber(chapter.downloadedCount)}` : "",
      chapter.status || ""
    ].filter(Boolean).join(" · ");

    button.append(title, meta);
    return button;
  }

  async function renderMangaChapter(id, chapterIndex, isActive = () => true) {
    const mangaId = String(id || "").trim();
    const index = String(chapterIndex || "").trim();
    const path = mangaChapterPath(mangaId, index);
    const activeUrl = getActiveUrl();
    let renderedCache = false;

    setActiveBottom("home");
    els.viewKicker.textContent = "韩漫阅读";
    els.viewTitle.textContent = "章节";
    els.viewMeta.textContent = "正在读取";
    els.viewOpenAll.textContent = "网页打开";
    els.viewOpenAll.onclick = () => openInLibrary(`${mangaRoutePath(mangaId)}?chapter=${encodeURIComponent(index)}`);
    els.viewContent.innerHTML = `<div class="loading-row">正在读取章节</div>`;

    if (!mangaId || !index) {
      renderMessage("章节参数无效。", "error");
      return;
    }

    const cached = await readCachedJson(activeUrl, path).catch(() => null);
    if (!isActive()) return;
    if (cached?.payload?.chapter) {
      renderedCache = true;
      renderMangaChapterData(mangaId, cached.payload, cached);
    }

    try {
      const data = await fetchJson(activeUrl, path, { timeoutMs: 18000, signal: isActive.signal });
      writeCachedJson(activeUrl, path, data).catch(() => {});
      if (!isActive()) return;
      renderMangaChapterData(mangaId, data);
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) {
        renderMessage("电脑端暂时连不上，当前显示的是本地缓存章节。", "quiet", false);
      } else {
        renderMessage(error.message || "章节读取失败", "error");
      }
    }
  }

  function renderMangaChapterData(mangaId, data = {}, cacheEntry = null) {
    const comic = data.comic || {};
    const chapter = data.chapter || {};
    const images = Array.isArray(chapter.images) ? chapter.images : [];
    const visible = images.slice(0, getMangaImageLimit());
    const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";

    els.viewKicker.textContent = comic.title || "韩漫阅读";
    els.viewTitle.textContent = chapter.title || `第 ${chapter.index || ""} 话`.trim();
    els.viewMeta.textContent = `${formatNumber(images.length || chapter.imageCount || 0)} 张${suffix}`;
    els.viewOpenAll.textContent = "网页打开";
    els.viewOpenAll.onclick = () => openInLibrary(`${mangaRoutePath(mangaId)}?chapter=${encodeURIComponent(chapter.index || "")}`);
    els.viewContent.innerHTML = "";

    if (!visible.length) {
      renderMessage("这一话暂时没有图片。", "quiet", false);
      return;
    }

    const list = document.createElement("div");
    list.className = "manga-reader-list";
    visible.forEach((image) => list.append(createMangaPage(mangaId, chapter, image)));
    els.viewContent.append(list);

    if (visible.length < images.length) {
      els.viewContent.append(createLoadMoreButton(`继续显示本话 ${formatNumber(visible.length)} / ${formatNumber(images.length)}`, () => {
        increaseMangaImageLimit(12);
        renderCurrentView();
      }));
    }
  }

  function createMangaPage(mangaId, chapter = {}, image = {}) {
    const imageUrl = absoluteUrl(getActiveUrl(), image.url);
    const page = document.createElement("button");
    page.type = "button";
    page.className = "manga-reader-page";

    const fallback = document.createElement("span");
    fallback.textContent = formatNumber(image.index || 0);
    page.append(fallback);

    if (imageUrl) {
      const img = document.createElement("img");
      img.alt = image.name || `${chapter.title || "章节"} ${image.index || ""}`.trim();
      img.loading = "lazy";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      img.src = imageUrl;
      page.append(img);
      page.addEventListener("click", () => getMediaViewer()?.openImage(imageUrl, img.alt));
    }

    return page;
  }

  function mangaDetailPath(id) {
    return `/api/manga/${encodeURIComponent(String(id || ""))}`;
  }

  function mangaChapterPath(id, chapterIndex) {
    return `/api/manga/${encodeURIComponent(String(id || ""))}/chapters/${encodeURIComponent(String(chapterIndex || ""))}`;
  }

  function mangaRoutePath(id) {
    return `/manga/${encodeURIComponent(String(id || ""))}`;
  }

  return {
    renderChannel,
    renderPhotoDetail,
    renderMangaDetail,
    renderMangaChapter,
    renderMediaDetail,
    channelLabel: (mode) => channelConfig(mode).label
  };
}
