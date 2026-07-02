import { fetchJson } from "./api.js?v=20260702-novel-local-manage-74";
import { enhanceAutoLoadMore } from "./auto-load.js?v=20260702-novel-local-manage-74";
import { cacheAgeText, readCachedJson, writeCachedJson } from "./cache.js?v=20260702-novel-local-manage-74";
import { isChannelFavorite, toggleChannelFavorite } from "./channel-favorites.js";
import { formatBytes, formatDate, formatNumber } from "./format.js";
import { absoluteUrl, loadPreviewImage } from "./image.js";

const CHANNELS = {
  photo: { label: "套图", path: "/photo", empty: "还没有索引到图包。", unit: "图包" },
  manga: { label: "韩漫", path: "/photo/manga", empty: "还没有缓存漫画。", unit: "部" },
  western: { label: "欧美", path: "/western", empty: "还没有索引到欧美视频。", unit: "视频" },
  media: { label: "影视作品", path: "/media", empty: "还没有索引到影视作品。", unit: "部" },
  movie: { label: "电影", path: "/movies", empty: "还没有索引到电影。", unit: "影片" },
  tv: { label: "电视剧", path: "/tv", empty: "还没有索引到电视剧。", unit: "剧" }
};
const EAGER_PHOTO_COVER_COUNT = 4;
const EAGER_PHOTO_DETAIL_IMAGE_COUNT = 4;
const PHOTO_DETAIL_IMAGE_CONCURRENCY = 4;
const EAGER_CHANNEL_COVER_COUNT = 14;
const LAZY_PHOTO_PREVIEW_ROOT_MARGIN = "180px 0px 420px 0px";
const LAZY_PHOTO_DETAIL_ROOT_MARGIN = "240px 0px 560px 0px";
const LAZY_CHANNEL_PREVIEW_ROOT_MARGIN = "900px 0px 1200px 0px";
const PLAY_OPEN_COOLDOWN_MS = 1400;

function channelDataSignature(data = {}) {
  const items = Array.isArray(data.items) ? data.items : [];
  return JSON.stringify({
    total: Number(data.total || items.length),
    mode: data.mode || "",
    query: data.query || "",
    photoView: data.photoView || "",
    category: data.category || "",
    person: data.person || "",
    collection: data.collection || "",
    tvView: data.tvView || "",
    seriesKey: data.seriesKey || "",
    sort: data.sort || "",
    facets: data.facets || null,
    items: items.map((item) => [
      item.id || "",
      item.type || "",
      item.title || "",
      item.coverUrl || "",
      item.routePath || "",
      item.updatedAt || "",
      item.size || 0,
      item.collectionId || "",
      item.seriesKey || "",
      item.chapterCount ?? "",
      item.imageCount ?? "",
      item.doneChapterCount ?? ""
    ])
  });
}

export function normalizeChannelMode(value) {
  const mode = String(value || "").trim();
  if (mode === "movies") return "movie";
  if (["video", "videos", "screen", "film", "films"].includes(mode)) return "media";
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
    renderCurrentViewPreservingScroll = renderCurrentView,
    goBack = () => window.history.back(),
    getMediaViewer = () => null,
    recordRecentContent = () => {},
    onChannelFavoriteChange = () => {},
    setTopSecondaryTabs = () => {},
    updateChannelQuery = () => {},
    updateChannelParams = () => {}
  } = context;
  let previewImageObservers = new Map();
  let photoDetailImageObserver = null;
  let photoDetailImageQueue = [];
  let activePhotoDetailImageLoads = 0;
  let photoDetailImageGeneration = 0;

  async function renderChannel(params = {}, isActive = () => true) {
    const normalizedMode = normalizeChannelMode(typeof params === "string" ? params : params.mode);
    const query = String(typeof params === "object" ? params.query || "" : "").trim();
    const rawPhotoView = String(typeof params === "object" ? params.photoView || "" : "").trim();
    const photoView = normalizedMode === "photo" && rawPhotoView !== "albums" ? "collections" : "albums";
    const category = String(typeof params === "object" ? params.category || "" : "").trim();
    const person = String(typeof params === "object" ? params.person || "" : "").trim();
    const collection = String(typeof params === "object" ? params.collection || "" : "").trim();
    const tvView = String(typeof params === "object" ? params.tvView || "" : "").trim() === "episodes" ? "episodes" : "series";
    const seriesKey = String(typeof params === "object" ? params.seriesKey || "" : "").trim();
    const sort = normalizeChannelSort(typeof params === "object" ? params.sort || "" : "");
    const channel = channelConfig(normalizedMode);
    const limit = getChannelLimit();
    const path = channelItemsPath(normalizedMode, limit, { query, photoView, category, person, collection, tvView, seriesKey, sort });
    const activeUrl = getActiveUrl();
    let renderedCache = false;
    let renderedCacheSignature = "";

    setActiveBottom(normalizedMode);
    if (normalizedMode === "photo") setTopSecondaryTabs("photo", { category });
    else if (["media", "movie", "tv"].includes(normalizedMode)) setTopSecondaryTabs("media", { mode: normalizedMode });
    else setTopSecondaryTabs("none");
    els.viewKicker.textContent = query ? "频道搜索" : "内容频道";
    els.viewTitle.textContent = query ? `${channel.label}：${query}` : channel.label;
    els.viewMeta.textContent = query ? "正在筛选" : "正在读取";
    els.viewContent.innerHTML = `<div class="loading-row">正在加载${channel.label}</div>`;

    const cached = await readCachedJson(activeUrl, path).catch(() => null);
    if (!isActive()) return;
    if (cached?.payload) {
      renderedCache = true;
      renderedCacheSignature = channelDataSignature(cached.payload);
      renderChannelData(normalizedMode, cached.payload, cached);
    }

    try {
      const data = await fetchJson(activeUrl, path, { timeoutMs: 12000, signal: isActive.signal });
      writeCachedJson(activeUrl, path, data).catch(() => {});
      if (!isActive()) return;
      if (renderedCache && channelDataSignature(data) === renderedCacheSignature) {
        applyChannelHeader(normalizedMode, data);
        return;
      }
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

  function applyChannelHeader(mode, data = {}, cacheEntry = null) {
    const channel = channelConfig(mode);
    const items = data.items || [];
    const total = Number(data.total || items.length);
    const query = String(data.query || "").trim();
    const photoView = String(data.photoView || "") === "collections" ? "collections" : "albums";
    const category = String(data.category || "").trim();
    const person = String(data.person || "").trim();
    const collection = String(data.collection || "").trim();
    const tvView = String(data.tvView || "") === "episodes" ? "episodes" : "series";
    const seriesKey = String(data.seriesKey || "").trim();
    const seriesSummary = data.seriesSummary || null;
    const sort = normalizeChannelSort(data.sort);
    const collectionTitle = data.collectionSummary?.title || "";
    const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : data.scannedAt ? ` · 更新 ${cacheAgeText(data.scannedAt)}` : "";
    const unit = mode === "tv" || mode === "media" ? (seriesKey ? "集" : "部") : photoView === "collections" && mode === "photo" ? "合集" : channel.unit;
    if (mode === "photo") setTopSecondaryTabs("photo", { category, facets: data.facets || {} });
    else if (["media", "movie", "tv"].includes(mode)) setTopSecondaryTabs("media", { mode });
    else setTopSecondaryTabs("none");
    els.viewTitle.textContent = channelTitle(channel, { query, mode, photoView, collectionTitle, category, seriesSummary });
    els.viewMeta.textContent = query
      ? `${formatNumber(total)} 个匹配 · 已显示 ${formatNumber(items.length)}${suffix}`
      : `${formatNumber(items.length)} / ${formatNumber(total)} ${unit}${suffix}`;
  }

  function renderChannelData(mode, data = {}, cacheEntry = null) {
    const channel = channelConfig(mode);
    const items = data.items || [];
    const total = Number(data.total || items.length);
    const query = String(data.query || "").trim();
    const photoView = String(data.photoView || "") === "collections" ? "collections" : "albums";
    const category = String(data.category || "").trim();
    const person = String(data.person || "").trim();
    const collection = String(data.collection || "").trim();
    const seriesKey = String(data.seriesKey || "").trim();
    const seriesSummary = data.seriesSummary || null;
    const sort = normalizeChannelSort(data.sort);
    applyChannelHeader(mode, data, cacheEntry);
    resetPreviewImageObserver();
    els.viewContent.innerHTML = "";

    if (["photo", "manga"].includes(mode)) {
      els.viewContent.append(createImageModuleRow(mode));
    }

    if (mode === "photo") {
      if (collection) els.viewContent.append(createCollectionContextRow(data.collectionSummary));
      els.viewContent.append(createPhotoFilterStrip(data.facets || {}, { category, person, collection, photoView }));
    } else if (mode === "tv" || mode === "media") {
      if (seriesKey) {
        els.viewContent.append(createTvSeriesContextRow(seriesSummary, { total, mode }));
      } else {
        els.viewContent.append(mode === "media"
          ? createMediaFilterStrip(data.facets || {}, { category, sort }, [
            { value: "updated", label: "最近" },
            { value: "rating", label: "评分" },
            { value: "title", label: "标题" },
            { value: "size", label: "大小" }
          ])
          : createTvFilterStrip(data.facets || {}, { category, sort, seriesKey }));
      }
    } else if (["western", "movie"].includes(mode)) {
      els.viewContent.append(createMediaFilterStrip(data.facets || {}, { category, sort }));
    }

    if (query) {
      els.viewContent.append(createChannelQueryRow(channel, query));
    }

    if (!items.length) {
      renderMessage(query ? `没有搜到「${query}」。` : channel.empty, "quiet", false);
      return;
    }

    if (mode === "photo" && photoView !== "collections") {
      els.viewContent.append(createPhotoMasonryList(items));
    } else {
      const grid = document.createElement("div");
      grid.className = `channel-list ${mode}-list`;
      items.forEach((item, index) => grid.append(createChannelCard(mode, item, { index })));
      els.viewContent.append(grid);
    }

    if (items.length < total) {
      els.viewContent.append(createLoadMoreButton(`向下滑动继续加载 ${formatNumber(items.length)} / ${formatNumber(total)}`, () => {
        increaseChannelLimit(48);
        return renderCurrentViewPreservingScroll();
      }));
    }
  }

  function createChannelCard(mode, item, options = {}) {
    const channel = channelConfig(mode);
    const card = document.createElement("button");
    card.type = "button";
    card.className = `channel-card ${mode}`;
    card.addEventListener("click", () => {
      if (mode === "photo" && item.type === "photoCollection") {
        updateChannelParams({ photoView: "albums", collection: item.collectionId || item.id, category: "", person: "", query: "" });
        return;
      }
      if (mode === "tv" && item.type === "tvSeries") {
        updateChannelParams(
          { tvView: "episodes", seriesKey: item.seriesKey || item.id, category: item.category || "", query: "", sort: "title" },
          { skipHistory: false, replaceHistory: false, push: true }
        );
        return;
      }
      if (mode === "media" && item.type === "tvSeries") {
        updateChannelParams(
          { mode: "media", tvView: "episodes", seriesKey: item.seriesKey || item.id, category: item.category || "", query: "", sort: "title" },
          { skipHistory: false, replaceHistory: false, push: true }
        );
        return;
      }
      if (mode === "photo" && item.id && showPhotoDetail) {
        showPhotoDetail(item.id);
        return;
      }
      if (mode === "manga" && item.id && showMangaDetail) {
        showMangaDetail(item.id);
        return;
      }
      if ((["western", "movie", "tv", "media"].includes(mode)) && item.id && showMediaDetail) {
        showMediaDetail(item.id, mediaDetailModeForItem(mode, item));
        return;
      }
      openInLibrary(item.routePath || channel.path);
    });

    const thumb = document.createElement("div");
    thumb.className = "channel-thumb";
    thumb.textContent = thumbFallbackText(item.title || channel.label);
    const cover = item.coverUrl ? absoluteUrl(getActiveUrl(), item.coverUrl) : "";
    if (cover) loadChannelPreviewImage(thumb, cover, mode, options.index);

    const body = document.createElement("div");
    body.className = "channel-summary";

    const label = document.createElement("span");
    label.className = "channel-label";
    label.textContent = channelCardLabel(mode, item);

    const title = document.createElement("strong");
    title.textContent = channelCardTitle(mode, item, channel);
    const subtitle = channelCardSubtitle(mode, item);
    const subtitleNode = subtitle ? document.createElement("span") : null;
    if (subtitle) {
      subtitleNode.className = "channel-subtitle";
      subtitleNode.textContent = subtitle;
    }

    const facts = document.createElement("div");
    facts.className = "channel-facts";
    for (const fact of channelFacts(mode, item).filter(Boolean).slice(0, 3)) {
      const node = document.createElement("span");
      node.textContent = fact;
      facts.append(node);
    }

    body.append(label, title);
    if (subtitleNode) body.append(subtitleNode);
    body.append(facts);
    card.append(thumb, body);
    return card;
  }

  function createPhotoMasonryList(items = []) {
    const wrap = document.createElement("div");
    wrap.className = "photo-masonry-list";

    const columns = [document.createElement("div"), document.createElement("div")];
    for (const column of columns) {
      column.className = "photo-masonry-column";
      wrap.append(column);
    }

    items.forEach((item, index) => {
      columns[index % columns.length].append(createChannelCard("photo", item, { index }));
    });
    return wrap;
  }

  function loadChannelPreviewImage(thumb, cover, mode, index = 0) {
    const activeUrl = getActiveUrl();
    if (shouldEagerLoadCover(mode, index) || !("IntersectionObserver" in window)) {
      loadPreviewImage(thumb, cover, { cacheBaseUrl: activeUrl });
      return;
    }

    thumb.dataset.previewUrl = cover;
    thumb.dataset.previewCacheBaseUrl = activeUrl;
    getPreviewImageObserver(mode).observe(thumb);
  }

  function shouldEagerLoadCover(mode, index = 0) {
    const safeIndex = Math.max(0, Number(index) || 0);
    if (mode === "photo") return safeIndex < EAGER_PHOTO_COVER_COUNT;
    return safeIndex < EAGER_CHANNEL_COVER_COUNT;
  }

  function getPreviewImageObserver(mode = "") {
    const key = mode === "photo" ? "photo" : "default";
    const existing = previewImageObservers.get(key);
    if (existing) return existing;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const target = entry.target;
        observer.unobserve(target);
        loadPendingPreviewImage(target);
      }
    }, {
      root: null,
      rootMargin: key === "photo" ? LAZY_PHOTO_PREVIEW_ROOT_MARGIN : LAZY_CHANNEL_PREVIEW_ROOT_MARGIN,
      threshold: 0
    });
    previewImageObservers.set(key, observer);
    return observer;
  }

  function loadPendingPreviewImage(target) {
    const cover = target.dataset.previewUrl || "";
    const cacheBaseUrl = target.dataset.previewCacheBaseUrl || getActiveUrl();
    delete target.dataset.previewUrl;
    delete target.dataset.previewCacheBaseUrl;
    if (!cover || !target.isConnected) return;
    loadPreviewImage(target, cover, { cacheBaseUrl });
  }

  function resetPreviewImageObserver() {
    for (const observer of previewImageObservers.values()) observer.disconnect();
    previewImageObservers = new Map();
    if (photoDetailImageObserver) {
      photoDetailImageObserver.disconnect();
      photoDetailImageObserver = null;
    }
    photoDetailImageQueue = [];
    activePhotoDetailImageLoads = 0;
    photoDetailImageGeneration += 1;
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

  function createImageModuleRow(activeMode) {
    const row = document.createElement("div");
    row.className = "channel-mode-row image-module-row";
    for (const option of [
      { value: "photo", label: "套图" },
      { value: "manga", label: "韩漫" }
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = option.value === activeMode ? "active" : "";
      button.textContent = option.label;
      button.addEventListener("click", () => {
        if (option.value === activeMode) return;
        updateChannelParams({
          mode: option.value,
          photoView: "collections",
          collection: "",
          category: "",
          person: "",
          query: "",
          sort: ""
        });
      });
      row.append(button);
    }
    return row;
  }

  function channelCardLabel(mode, item) {
    if (mode === "photo" && item.type === "photoCollection") return [item.category, item.rootLabel].filter(Boolean).join(" · ") || "合集";
    if (mode === "manga") return [item.category, chapterProgressText(item)].filter(Boolean).join(" · ") || "漫画";
    if (mode === "photo") return [item.category, item.personName].filter(Boolean).join(" · ") || "图包";
    if (mode === "media" && item.type === "tvSeries") return ["电视剧", item.category, item.year].filter(Boolean).join(" · ");
    if (mode === "media" && item.type === "movie") return ["电影", item.category, item.year].filter(Boolean).join(" · ");
    if (mode === "media" && item.type === "tv") return [item.tvSeries?.title || item.seriesName, item.category].filter(Boolean).slice(0, 2).join(" · ") || "电视剧";
    if (mode === "tv" && item.type === "tvSeries") return [item.category, item.year].filter(Boolean).join(" · ") || "电视剧";
    if (mode === "tv") return [item.tvSeries?.title, item.seriesName].filter(Boolean).slice(0, 1).join(" · ") || "电视剧";
    return [item.category, item.seriesName || item.personName].filter(Boolean).join(" · ") || channelConfig(mode).label;
  }

  function channelCardTitle(mode, item, channel) {
    if (mode === "photo" && item.type !== "photoCollection") return photoAlbumCardTitle(item);
    if (mode === "media" && item.type === "tv") return tvEpisodeTitle(item);
    if (mode === "tv" && item.type !== "tvSeries") return tvEpisodeTitle(item);
    return item.title || channel.label;
  }

  function channelCardSubtitle(mode, item) {
    if (mode === "media" && item.type === "tv") return tvEpisodeFileLabel(item);
    if (mode === "tv" && item.type !== "tvSeries") return tvEpisodeFileLabel(item);
    return "";
  }

  function tvEpisodeTitle(item = {}) {
    const match = String(item.title || "").match(/S(\d{1,2})E(\d{1,3})/i);
    if (!match) return item.title || "播放";
    const season = Number(match[1] || 0);
    const episode = Number(match[2] || 0);
    if (season > 1) return `第 ${season} 季 第 ${episode} 集`;
    return `第 ${episode} 集`;
  }

  function tvEpisodeFileLabel(item = {}) {
    return String(item.title || "").replace(/\s+/g, " ").trim();
  }

  function photoAlbumCardTitle(item = {}) {
    const raw = String(item.title || "").replace(/\s+/g, " ").trim();
    const person = String(item.personName || "").replace(/[[\]]/g, "").trim();
    if (!raw || !person) return raw || "图包";
    return raw
      .replace(new RegExp(`^${escapeRegExp(person)}\\s*[–—-]\\s*`, "i"), "")
      .replace(new RegExp(`^${escapeRegExp(person)}\\s+`, "i"), "")
      .trim() || raw;
  }

  function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
      if (item.type === "photoCollection") {
        return [
          item.albumCount !== null ? `${formatNumber(item.albumCount)} 期` : "",
          Number(item.imageCount || 0) > 0 ? `${formatNumber(item.imageCount)} 张` : "",
          formatBytes(item.size)
        ];
      }
      return [
        item.ext ? item.ext.toUpperCase() : "",
        formatBytes(item.size),
        formatDate(item.updatedAt)
      ];
    }
    if (mode === "tv" && item.type === "tvSeries") {
      return [
        item.chapterCount !== null ? `${formatNumber(item.chapterCount)} 集` : "",
        item.rating ? `豆瓣 ${Number(item.rating).toFixed(1)}` : "",
        formatBytes(item.size)
      ];
    }
    if (mode === "media" && item.type === "tvSeries") {
      return [
        item.chapterCount !== null ? `${formatNumber(item.chapterCount)} 集` : "",
        item.rating ? `豆瓣 ${Number(item.rating).toFixed(1)}` : "",
        formatBytes(item.size)
      ];
    }
    if (mode === "media" && item.type === "movie") {
      return [
        item.rating ? `豆瓣 ${Number(item.rating).toFixed(1)}` : "",
        item.year || "",
        formatBytes(item.size)
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

  function channelItemsPath(mode, limit, filters = {}) {
    const params = new URLSearchParams({
      mode,
      limit: String(limit),
      offset: "0",
      sort: normalizeChannelSort(filters.sort)
    });
    const text = String(filters.query || "").trim();
    if (text) params.set("q", text);
    if (mode === "photo") {
      if (filters.photoView === "collections" && !filters.collection) params.set("photoView", "collections");
      if (filters.category && filters.category !== "all") params.set("category", filters.category);
      if (filters.person && filters.person !== "all") params.set("person", filters.person);
      if (filters.collection) params.set("collection", filters.collection);
    } else if (["western", "media", "movie", "tv"].includes(mode)) {
      if (filters.category && filters.category !== "all") params.set("category", filters.category);
      if (mode === "tv" || mode === "media") {
        if (filters.seriesKey) {
          params.set("tvView", "episodes");
          params.set("seriesKey", filters.seriesKey);
        } else if (mode === "tv" && filters.tvView === "episodes") {
          params.set("tvView", "episodes");
        }
      }
    }
    return `/api/image-library/items?${params}`;
  }

  function channelTitle(channel, filters = {}) {
    if (filters.mode === "photo" && filters.collectionTitle) {
      return filters.query ? `${filters.collectionTitle}：${filters.query}` : filters.collectionTitle;
    }
    if (filters.mode === "photo" && filters.photoView === "collections") {
      return filters.query ? `套图合集：${filters.query}` : "套图合集";
    }
    if ((filters.mode === "tv" || filters.mode === "media") && filters.seriesSummary?.title) {
      return filters.query ? `${filters.seriesSummary.title}：${filters.query}` : filters.seriesSummary.title;
    }
    if (filters.mode !== "photo" && filters.category && filters.category !== "all") {
      return filters.query ? `${channel.label}：${filters.category}：${filters.query}` : `${channel.label}：${filters.category}`;
    }
    return filters.query ? `${channel.label}：${filters.query}` : channel.label;
  }

  function normalizeChannelSort(value) {
    const sort = String(value || "").trim();
    return ["updated", "title", "size", "rating"].includes(sort) ? sort : "updated";
  }

  function createCollectionContextRow(summary = null) {
    const row = document.createElement("div");
    row.className = "channel-context-row";
    const text = document.createElement("span");
    const parts = [
      summary?.count ? `${formatNumber(summary.count)} 期` : "",
      summary?.imageCount ? `${formatNumber(summary.imageCount)} 张` : "",
      formatBytes(summary?.size)
    ].filter(Boolean);
    text.textContent = parts.length ? parts.join(" · ") : "当前合集";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "返回合集";
    button.addEventListener("click", () => updateChannelParams({ photoView: "collections", collection: "", category: "", person: "" }));
    row.append(text, button);
    return row;
  }

  function createPhotoFilterStrip(facets = {}, state = {}) {
    const wrap = document.createElement("div");
    wrap.className = "channel-filter-wrap photo-filter-wrap";
    wrap.append(createPhotoModeRow(state));

    const row = document.createElement("div");
    row.className = "channel-filter-select-row";
    if (!state.collection) {
      row.append(createFacetSelect("人物", facets.people || [], state.person || "all", (value) => updateChannelParams({ person: value === "all" ? "" : value, collection: "" })));
    }
    if (row.children.length) wrap.append(row);
    return wrap;
  }

  function createPhotoModeRow(state = {}) {
    const row = document.createElement("div");
    row.className = "channel-mode-row photo-mode-row";
    const activeView = state.collection ? "albums" : state.photoView === "albums" ? "albums" : "collections";
    for (const option of [
      { value: "collections", label: "合集" },
      { value: "albums", label: "图包" }
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = option.value === activeView ? "active" : "";
      button.textContent = option.label;
      button.addEventListener("click", () => {
        if (option.value === activeView && !state.collection) return;
        updateChannelParams({
          photoView: option.value,
          collection: "",
          person: "",
          query: ""
        });
      });
      row.append(button);
    }
    return row;
  }

  function createMediaFilterStrip(facets = {}, state = {}, sortOptions = null) {
    const wrap = document.createElement("div");
    wrap.className = "channel-filter-wrap";
    const categories = facets.categories || [];
    if (categories.length) {
      wrap.append(createFacetRow("分类", categories, state.category || "all", (value) => updateChannelParams({ category: value === "all" ? "" : value })));
    }
    wrap.append(createSortRow(state.sort || "updated", sortOptions || [
      { value: "updated", label: "最近" },
      { value: "title", label: "标题" },
      { value: "size", label: "大小" }
    ]));
    return wrap;
  }

  function createTvFilterStrip(facets = {}, state = {}) {
    const wrap = document.createElement("div");
    wrap.className = "channel-filter-wrap channel-tv-filter-wrap";
    wrap.append(createSortRow(state.sort || "updated", [
      { value: "updated", label: "最近" },
      { value: "rating", label: "评分" },
      { value: "title", label: "标题" }
    ]));
    return wrap;
  }

  function createTvSeriesContextRow(summary = null, state = {}) {
    const row = document.createElement("div");
    row.className = "channel-context-row channel-tv-series-row";
    const text = document.createElement("span");
    const parts = [
      summary?.category || "",
      summary?.year || "",
      summary?.rating ? `豆瓣 ${Number(summary.rating).toFixed(1)}` : "",
      `${formatNumber(state.total || summary?.chapterCount || 0)} 集`
    ].filter(Boolean);
    text.textContent = summary?.title ? `${summary.title} · ${parts.join(" · ")}` : parts.join(" · ") || "当前剧集";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = state.mode === "media" ? "返回影视" : "返回剧集";
    button.addEventListener("click", () => updateChannelParams({ mode: state.mode || "tv", tvView: "series", seriesKey: "", query: "" }));
    row.append(text, button);
    return row;
  }

  function createSortRow(activeSort, options = [
    { value: "updated", label: "最近" },
    { value: "title", label: "标题" },
    { value: "size", label: "大小" }
  ]) {
    const row = document.createElement("div");
    row.className = "channel-filter-row channel-sort-row";
    const title = document.createElement("span");
    title.textContent = "排序";
    row.append(title);
    for (const option of options) {
      row.append(createFacetChip(option.label, option.value, option.value === activeSort, (value) => updateChannelParams({ sort: value === "updated" ? "" : value })));
    }
    return row;
  }

  function createFacetRow(label, items, activeValue, onSelect, allLabel = "全部") {
    const row = document.createElement("div");
    row.className = "channel-filter-row";
    const title = document.createElement("span");
    title.textContent = label;
    row.append(title, createFacetChip(allLabel, "all", activeValue === "all" || !activeValue, onSelect));
    for (const item of items.slice(0, 10)) {
      row.append(createFacetChip(item.value, item.value, item.value === activeValue, onSelect, item.count));
    }
    return row;
  }

  function createFacetSelect(label, items, activeValue, onSelect, allLabel = "全部") {
    const field = document.createElement("label");
    field.className = "channel-filter-select";

    const title = document.createElement("span");
    title.textContent = label;

    const select = document.createElement("select");
    select.setAttribute("aria-label", label);
    appendSelectOption(select, allLabel, "all");

    const values = new Set(["all"]);
    for (const item of items.slice(0, 80)) {
      const value = String(item.value || "").trim();
      if (!value || values.has(value)) continue;
      values.add(value);
      appendSelectOption(select, value, value, item.count);
    }

    if (activeValue && !values.has(activeValue)) appendSelectOption(select, activeValue, activeValue);
    select.value = activeValue || "all";
    select.addEventListener("change", () => onSelect(select.value));

    field.append(title, select);
    return field;
  }

  function appendSelectOption(select, label, value, count = undefined) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    if (count !== undefined) option.title = `${label} · ${formatNumber(count || 0)}`;
    select.append(option);
  }

  function createFacetChip(label, value, active, onSelect, count = undefined) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = active ? "active" : "";
    button.textContent = label;
    if (count !== undefined) {
      button.title = `${label} · ${formatNumber(count || 0)}`;
      button.setAttribute("aria-label", `${label}，${formatNumber(count || 0)} 项`);
    }
    button.addEventListener("click", () => onSelect(value));
    return button;
  }

  function createLoadMoreButton(text, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-button channel-more";
    button.textContent = text;
    return enhanceAutoLoadMore(button, handler, {
      idleText: text,
      loadingText: "正在接着加载",
      retryText: "加载停住了，点一下重试"
    });
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
    const path = photoDetailPath(albumId, { imageLimit: getPhotoImageLimit() });
    const activeUrl = getActiveUrl();
    let renderedCache = false;

    setActiveBottom("photo");
    els.viewKicker.textContent = "套图";
    els.viewTitle.textContent = "图包详情";
    els.viewMeta.textContent = "正在读取";
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
    const totalImages = Number(album.imageCount || images.length || 0);
    const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";

    els.viewKicker.textContent = [album.category, album.personName].filter(Boolean).join(" · ") || "套图";
    els.viewTitle.textContent = album.title || "图包详情";
    els.viewMeta.textContent = `${formatNumber(totalImages)} 张 · ${formatBytes(album.size)}${suffix}`;
    resetPreviewImageObserver();
    els.viewContent.innerHTML = "";
    recordPhotoRecent(album);
    els.viewContent.append(createPhotoSummary(album, photoContentItem(album)));

    if (!visible.length) {
      renderMessage("这个图包暂时没有可预览图片。", "quiet", false);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "photo-preview-grid";
    visible.forEach((image, index) => grid.append(createPhotoTile(album, image, images, { index })));
    els.viewContent.append(grid);

    if (visible.length < totalImages) {
      els.viewContent.append(createLoadMoreButton(`向下滑动继续显示 ${formatNumber(visible.length)} / ${formatNumber(totalImages)}`, () => {
        increasePhotoImageLimit(24);
        return renderCurrentViewPreservingScroll();
      }));
    }
  }

  function createPhotoSummary(album = {}, favoriteItem = null) {
    const panel = document.createElement("div");
    panel.className = "photo-detail-summary";

    const main = document.createElement("div");
    main.className = "photo-detail-main";

    const title = document.createElement("strong");
    title.textContent = album.title || album.personName || album.subCategory || album.category || "套图";

    const subtitle = document.createElement("small");
    subtitle.textContent = [album.personName, album.category].filter(Boolean).join(" · ");
    main.append(title);
    if (subtitle.textContent) main.append(subtitle);

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

    const side = document.createElement("div");
    side.className = "photo-detail-side";
    side.append(facts);
    const actions = document.createElement("div");
    actions.className = "photo-detail-actions";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "photo-detail-back";
    back.textContent = "返回";
    back.addEventListener("click", goBack);
    if (favoriteItem) actions.append(createChannelFavoriteButton(favoriteItem));
    actions.append(back);
    side.append(actions);

    panel.append(main, side);
    return panel;
  }

  function createPhotoTile(album, image = {}, sourceImages = [], options = {}) {
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
      if ("fetchPriority" in img) img.fetchPriority = Number(options.index || 0) < EAGER_PHOTO_DETAIL_IMAGE_COUNT ? "high" : "low";
      loadPhotoDetailImage(img, imageUrl, options.index);
      tile.append(img);
      tile.addEventListener("click", () => {
        const viewer = getMediaViewer();
        if (!viewer) return;
        const fallbackItems = photoViewerItemsFromImages(album, sourceImages);
        const fallbackIndex = fallbackItems.findIndex((item) => item.url === imageUrl);
        const sourceKey = photoViewerSourceKey(album);
        viewer.openImage(imageUrl, img.alt, {
          items: fallbackItems,
          index: fallbackIndex >= 0 ? fallbackIndex : Math.max(0, Number(image.index || options.index + 1 || 1) - 1),
          sourceKey
        });
        hydratePhotoViewerItems(viewer, album, sourceImages, sourceKey);
      });
    }

    return tile;
  }

  async function photoViewerItems(album = {}, sourceImages = []) {
    const currentImages = Array.isArray(sourceImages) ? sourceImages : [];
    const totalImages = Number(album.imageCount || currentImages.length || 0);
    if (!album.id || currentImages.length >= totalImages) return photoViewerItemsFromImages(album, currentImages);

    const activeUrl = getActiveUrl();
    const path = photoDetailPath(album.id, { imageLimit: "all" });
    const cached = await readCachedJson(activeUrl, path).catch(() => null);
    if (cached?.payload?.album?.images?.length >= totalImages) {
      return photoViewerItemsFromImages(cached.payload.album, cached.payload.album.images);
    }

    const data = await fetchJson(activeUrl, path, { timeoutMs: 26000 });
    writeCachedJson(activeUrl, path, data).catch(() => {});
    return photoViewerItemsFromImages(data.album || album, data.album?.images || currentImages);
  }

  function hydratePhotoViewerItems(viewer, album = {}, sourceImages = [], sourceKey = "") {
    const currentImages = Array.isArray(sourceImages) ? sourceImages : [];
    const totalImages = Number(album.imageCount || currentImages.length || 0);
    if (!viewer?.updateItems || !album.id || currentImages.length >= totalImages) return;

    photoViewerItems(album, sourceImages)
      .then((items) => {
        if (items.length > currentImages.length) viewer.updateItems(items, { sourceKey });
      })
      .catch(() => {});
  }

  function photoViewerSourceKey(album = {}) {
    return album.id ? `photo:${album.id}` : "";
  }

  function photoViewerItemsFromImages(album = {}, images = []) {
    return (Array.isArray(images) ? images : [])
      .map((item) => ({
        url: absoluteUrl(getActiveUrl(), item.url),
        title: item.name || `${album.title || "图包"} ${item.index || ""}`.trim()
      }))
      .filter((item) => item.url);
  }

  function loadPhotoDetailImage(img, imageUrl, index = 0) {
    if (!img || !imageUrl) return;
    const safeIndex = Math.max(0, Number(index) || 0);
    if (safeIndex < EAGER_PHOTO_DETAIL_IMAGE_COUNT || !("IntersectionObserver" in window)) {
      img.src = imageUrl;
      return;
    }
    img.dataset.photoSrc = imageUrl;
    getPhotoDetailImageObserver().observe(img);
  }

  function getPhotoDetailImageObserver() {
    if (photoDetailImageObserver) return photoDetailImageObserver;
    photoDetailImageObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const image = entry.target;
        photoDetailImageObserver.unobserve(image);
        loadPendingPhotoDetailImage(image);
      }
    }, {
      root: null,
      rootMargin: LAZY_PHOTO_DETAIL_ROOT_MARGIN,
      threshold: 0
    });
    return photoDetailImageObserver;
  }

  function loadPendingPhotoDetailImage(image) {
    const imageUrl = image?.dataset?.photoSrc || "";
    if (image?.dataset) delete image.dataset.photoSrc;
    if (!imageUrl || !image?.isConnected) return;
    enqueuePhotoDetailImage(image, imageUrl);
  }

  function enqueuePhotoDetailImage(image, imageUrl) {
    if (!image || !imageUrl || image.getAttribute("src") || image.dataset.photoQueued === "1") return;
    image.dataset.photoQueued = "1";
    photoDetailImageQueue.push({
      image,
      imageUrl,
      generation: photoDetailImageGeneration
    });
    drainPhotoDetailImageQueue();
  }

  function drainPhotoDetailImageQueue() {
    while (activePhotoDetailImageLoads < PHOTO_DETAIL_IMAGE_CONCURRENCY && photoDetailImageQueue.length) {
      const item = photoDetailImageQueue.shift();
      const { image, imageUrl, generation } = item;
      if (generation !== photoDetailImageGeneration || !image?.isConnected || image.getAttribute("src")) continue;

      activePhotoDetailImageLoads += 1;
      delete image.dataset.photoQueued;
      const settle = () => {
        image.removeEventListener("load", settle);
        image.removeEventListener("error", settle);
        if (generation !== photoDetailImageGeneration) return;
        activePhotoDetailImageLoads = Math.max(0, activePhotoDetailImageLoads - 1);
        drainPhotoDetailImageQueue();
      };
      image.addEventListener("load", settle);
      image.addEventListener("error", settle);
      image.src = imageUrl;
    }
  }

  function photoDetailPath(id, options = {}) {
    const params = new URLSearchParams();
    if (options.imageLimit === "all") {
      params.set("imageLimit", "all");
    } else if (Number.isFinite(Number(options.imageLimit)) && Number(options.imageLimit) > 0) {
      params.set("imageLimit", String(Math.floor(Number(options.imageLimit))));
    }
    const query = params.toString();
    return `/api/photo-sets/${encodeURIComponent(String(id || ""))}${query ? `?${query}` : ""}`;
  }

  async function renderMediaDetail(id, initialMode = "", isActive = () => true) {
    const mediaId = String(id || "").trim();
    const path = mediaDetailPath(mediaId);
    const activeUrl = getActiveUrl();
    const loadingMode = ["western", "media", "movie", "tv"].includes(normalizeChannelMode(initialMode))
      ? normalizeChannelMode(initialMode)
      : "movie";
    const loadingChannel = channelConfig(loadingMode);
    let renderedCache = false;

    setActiveBottom(loadingMode);
    if (els.contentPanel) els.contentPanel.dataset.channelMode = loadingMode;
    els.viewKicker.textContent = loadingChannel.label;
    els.viewTitle.textContent = `${loadingChannel.label}详情`;
    els.viewMeta.textContent = "正在读取";
    els.viewContent.innerHTML = `<div class="loading-row">正在读取${loadingChannel.label}</div>`;

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
    const bottomMode = mode === "movie" || mode === "tv" ? "media" : mode;
    const streamUrl = absoluteUrl(getActiveUrl(), item.streamUrl);
    const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
    const meta = [item.ext ? item.ext.toUpperCase() : "", formatBytes(item.size), item.exists === false ? "文件不可用" : ""]
      .filter(Boolean)
      .join(" · ");

    setActiveBottom(bottomMode);
    if (els.contentPanel) els.contentPanel.dataset.channelMode = mode;
    els.viewKicker.textContent = [channel.label, item.seriesName || item.category].filter(Boolean).join(" · ");
    els.viewTitle.textContent = mediaDisplayTitle(item, channel);
    els.viewMeta.textContent = `${meta}${suffix}`;
    els.viewContent.innerHTML = "";
    recordMediaRecent(item, channel, mode);

    els.viewContent.append(createMediaPlayerPanel(item, streamUrl, channel));
    els.viewContent.append(createMediaSummary(item, channel));
  }

  function createMediaSummary(item = {}, channel = CHANNELS.movie) {
    const panel = document.createElement("div");
    panel.className = "media-detail-summary";

    const title = document.createElement("strong");
    title.textContent = "文件信息";

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
    const mode = normalizeChannelMode(item.mediaKind || item.type);
    if (mode === "tv") {
      return [mediaSeriesTitle(item, channel), tvEpisodeDisplayTitle(item)].filter(Boolean).join(" · ") || item.title || channel.label;
    }
    return item.seriesName || item.category || item.personName || item.title || channel.label;
  }

  function mediaDetailModeForItem(mode, item = {}) {
    if (mode !== "media") return mode;
    if (item.type === "movie" || item.mediaKind === "movie") return "movie";
    if (item.type === "tv" || item.mediaKind === "tv") return "tv";
    return mode;
  }

  function createMediaPlayerPanel(item = {}, streamUrl = "", channel = CHANNELS.movie) {
    const panel = document.createElement("div");
    panel.className = "media-player-panel";
    const mode = normalizeChannelMode(item.mediaKind || item.type);

    const head = document.createElement("div");
    head.className = "media-player-head";
    const titleWrap = document.createElement("div");
    titleWrap.className = "media-player-title";
    const title = document.createElement("strong");
    title.textContent = mediaDisplayTitle(item, channel);
    const subtitle = document.createElement("span");
    subtitle.textContent = mediaDisplaySubtitle(item, channel);
    titleWrap.append(title);
    if (subtitle.textContent) titleWrap.append(subtitle);

    const actions = document.createElement("div");
    actions.className = "media-action-row";
    actions.append(createBackButton(), createChannelFavoriteButton(mediaContentItem(item, channel, mode)));
    head.append(titleWrap, actions);

    panel.append(head, createNativePlaySurface(panel, item, streamUrl, channel), createMediaFactRow(item, channel));
    const episodeNav = createTvEpisodeNav(item);
    if (episodeNav) panel.append(episodeNav);
    return panel;
  }

  function createBackButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "media-back-action";
    button.textContent = "返回";
    button.addEventListener("click", goBack);
    return button;
  }

  function createChannelFavoritePanel(item) {
    const panel = document.createElement("div");
    panel.className = "detail-action-row channel-detail-actions";
    panel.append(createChannelFavoriteButton(item));
    return panel;
  }

  function createChannelFavoriteButton(item) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "channel-favorite-action favorite-action";
    syncChannelFavoriteButton(button, item);
    button.addEventListener("click", () => {
      const result = toggleChannelFavorite(item);
      syncChannelFavoriteButton(button, item, result.favorite);
      onChannelFavoriteChange(result.items);
    });
    return button;
  }

  function syncChannelFavoriteButton(button, item, forced = null) {
    const favorite = forced === null ? isChannelFavorite(item) : Boolean(forced);
    button.textContent = favorite ? "已收藏" : "收藏";
    button.classList.toggle("active", favorite);
  }

  async function openNativeMediaPlayer(item = {}, streamUrl = "", channel = CHANNELS.movie) {
    const plugin = window.Capacitor?.Plugins?.FanHaoPlayer;
    if (!plugin?.play || !streamUrl) return false;
    try {
      await plugin.play({
        url: streamUrl,
        title: mediaDisplayTitle(item, channel),
        subtitle: mediaDisplaySubtitle(item, channel),
        mode: "gallery-media",
        videoId: item.id,
        duration: 0
      });
      return true;
    } catch {
      return false;
    }
  }

  function createNativePlaySurface(panel, item = {}, streamUrl = "", channel = CHANNELS.movie) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "media-native-play-surface";
    button.setAttribute("aria-label", "播放");

    const visual = document.createElement("span");
    visual.className = "media-native-play-visual";
    visual.textContent = "";

    const cover = item.coverUrl ? absoluteUrl(getActiveUrl(), item.coverUrl) : "";
    if (cover) {
      loadPreviewImage(visual, cover, {
        cacheBaseUrl: getActiveUrl(),
        decorate: (img) => {
          img.className = "media-native-play-image";
        }
      });
    }

    const playMark = document.createElement("span");
    playMark.className = "media-native-play-mark";
    playMark.setAttribute("aria-hidden", "true");
    playMark.textContent = "▶";

    const label = document.createElement("span");
    label.className = "media-native-play-label";
    label.textContent = streamUrl ? "点击播放" : "暂无播放地址";

    button.append(visual, playMark, label);
    button.addEventListener("click", async () => {
      panel.querySelector(".media-player-error")?.remove();
      if (!streamUrl) {
        panel.append(createMediaPlayerError("没有可播放地址。"));
        return;
      }
      const startedAt = performance.now();
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      label.textContent = "正在打开";
      try {
        const opened = await openNativeMediaPlayer(item, streamUrl, channel);
        if (!opened) panel.append(createMediaPlayerError("播放器打开失败。"));
      } finally {
        await waitForMinimumOpenTime(startedAt);
        label.textContent = streamUrl ? "点击播放" : "暂无播放地址";
        button.removeAttribute("aria-busy");
        button.disabled = false;
      }
    });
    return button;
  }

  function waitForMinimumOpenTime(startedAt) {
    const elapsed = performance.now() - startedAt;
    const remaining = PLAY_OPEN_COOLDOWN_MS - elapsed;
    if (remaining <= 0) return Promise.resolve();
    return new Promise((resolve) => window.setTimeout(resolve, remaining));
  }

  function createMediaFactRow(item = {}, channel = CHANNELS.movie) {
    const row = document.createElement("div");
    row.className = "media-player-facts";
    for (const fact of mediaDetailFacts(item, channel).filter(Boolean).slice(0, 5)) {
      const node = document.createElement("span");
      node.textContent = fact;
      row.append(node);
    }
    return row;
  }

  function createTvEpisodeNav(item = {}) {
    const mode = normalizeChannelMode(item.mediaKind || item.type);
    const seriesKey = String(item.seriesKey || item.tvSeries?.seriesKey || "").trim();
    if (mode !== "tv" || !seriesKey || !item.id || !showMediaDetail) return null;

    const row = document.createElement("div");
    row.className = "media-episode-nav";

    const prev = createEpisodeNavButton("上一集");
    const next = createEpisodeNavButton("下一集");
    const label = document.createElement("span");
    label.className = "media-episode-nav-label";
    label.textContent = "正在读取集数";

    row.append(prev, label, next);

    const limit = Math.max(80, Math.min(240, Number(item.tvSeries?.episodeCount || 0) + 8 || 80));
    const path = channelItemsPath("tv", limit, {
      tvView: "episodes",
      seriesKey,
      category: item.category || item.tvSeries?.category || "",
      sort: "title"
    });

    fetchJson(getActiveUrl(), path, { timeoutMs: 12000 })
      .then((data) => {
        if (!document.body.contains(row)) return;
        const episodes = Array.isArray(data.items) ? data.items.filter((episode) => episode?.id) : [];
        const index = episodes.findIndex((episode) => episode.id === item.id);
        if (index < 0 || !episodes.length) {
          row.hidden = true;
          return;
        }
        label.textContent = `第 ${index + 1} / ${episodes.length} 集`;
        bindEpisodeNavButton(prev, episodes[index - 1]);
        bindEpisodeNavButton(next, episodes[index + 1]);
      })
      .catch(() => {
        if (document.body.contains(row)) row.hidden = true;
      });

    return row;
  }

  function createEpisodeNavButton(label) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.disabled = true;
    return button;
  }

  function bindEpisodeNavButton(button, episode) {
    if (!episode?.id) {
      button.disabled = true;
      button.onclick = null;
      return;
    }
    button.disabled = false;
    button.onclick = () => showMediaDetail(episode.id, "tv");
  }

  function mediaDetailFacts(item = {}, channel = CHANNELS.movie) {
    const mode = normalizeChannelMode(item.mediaKind || item.type);
    return [
      channel.label,
      mode === "tv" ? item.category : item.seriesName || item.category,
      item.tvSeries?.year || "",
      item.tvSeries?.rating ? `豆瓣 ${Number(item.tvSeries.rating).toFixed(1)}` : "",
      item.ext ? item.ext.toUpperCase() : "",
      formatBytes(item.size)
    ];
  }

  function mediaDisplaySubtitle(item = {}, channel = CHANNELS.movie) {
    const mode = normalizeChannelMode(item.mediaKind || item.type);
    if (mode === "tv") {
      return [item.category, item.tvSeries?.year, item.ext ? item.ext.toUpperCase() : "", formatBytes(item.size)].filter(Boolean).join(" · ");
    }
    return [channel.label, item.seriesName || item.category, item.ext ? item.ext.toUpperCase() : "", formatBytes(item.size)].filter(Boolean).join(" · ");
  }

  function mediaSeriesTitle(item = {}, channel = CHANNELS.movie) {
    return item.tvSeries?.title || item.seriesName || item.category || channel.label;
  }

  function tvEpisodeDisplayTitle(item = {}) {
    const match = String(item.title || "").match(/S(\d{1,2})E(\d{1,3})/i);
    if (!match) return item.title || "";
    const season = Number(match[1] || 0);
    const episode = Number(match[2] || 0);
    if (season > 1) return `第 ${season} 季 第 ${episode} 集`;
    return `第 ${episode} 集`;
  }

  function createMediaPlayerError(message) {
    const error = document.createElement("div");
    error.className = "media-player-error";
    error.textContent = message;
    return error;
  }

  function mediaDetailPath(id) {
    return `/api/gallery-media/${encodeURIComponent(String(id || ""))}`;
  }

  async function renderMangaDetail(id, isActive = () => true) {
    const mangaId = String(id || "").trim();
    const path = mangaDetailPath(mangaId);
    const activeUrl = getActiveUrl();
    let renderedCache = false;

    setActiveBottom("photo");
    els.viewKicker.textContent = "韩漫";
    els.viewTitle.textContent = "漫画详情";
    els.viewMeta.textContent = "正在读取";
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
    els.viewContent.innerHTML = "";
    recordMangaRecent(comic);
    els.viewContent.append(createMangaSummary(comic));
    els.viewContent.append(createChannelFavoritePanel(mangaContentItem(comic)));

    if (!visible.length) {
      renderMessage("这部漫画暂时没有章节。", "quiet", false);
      return;
    }

    const list = document.createElement("div");
    list.className = "manga-chapter-list";
    visible.forEach((chapter) => list.append(createMangaChapterButton(comic, chapter)));
    els.viewContent.append(list);

    if (visible.length < chapters.length) {
      els.viewContent.append(createLoadMoreButton(`向下滑动继续显示章节 ${formatNumber(visible.length)} / ${formatNumber(chapters.length)}`, () => {
        increaseChannelLimit(40);
        return renderCurrentViewPreservingScroll();
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

    setActiveBottom("photo");
    els.viewKicker.textContent = "韩漫阅读";
    els.viewTitle.textContent = "章节";
    els.viewMeta.textContent = "正在读取";
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
    els.viewContent.innerHTML = "";
    recordMangaChapterRecent(mangaId, comic, chapter);
    els.viewContent.append(createChannelFavoritePanel(mangaChapterContentItem(mangaId, comic, chapter)));

    if (!visible.length) {
      renderMessage("这一话暂时没有图片。", "quiet", false);
      return;
    }

    const list = document.createElement("div");
    list.className = "manga-reader-list";
    const viewerItems = images
      .map((image) => ({
        url: absoluteUrl(getActiveUrl(), image.url),
        title: image.name || `${chapter.title || "章节"} ${image.index || ""}`.trim()
      }))
      .filter((item) => item.url);
    visible.forEach((image) => list.append(createMangaPage(mangaId, chapter, image, viewerItems)));
    els.viewContent.append(list);

    if (visible.length < images.length) {
      els.viewContent.append(createLoadMoreButton(`向下滑动继续显示 ${formatNumber(visible.length)} / ${formatNumber(images.length)}`, () => {
        increaseMangaImageLimit(12);
        return renderCurrentViewPreservingScroll();
      }));
    }
  }

  function createMangaPage(mangaId, chapter = {}, image = {}, viewerItems = []) {
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
      page.addEventListener("click", () => getMediaViewer()?.openImage(imageUrl, img.alt, {
        items: viewerItems,
        index: viewerItems.findIndex((item) => item.url === imageUrl)
      }));
    }

    return page;
  }

  function mangaDetailPath(id) {
    return `/api/manga/${encodeURIComponent(String(id || ""))}`;
  }

  function mangaChapterPath(id, chapterIndex) {
    return `/api/manga/${encodeURIComponent(String(id || ""))}/chapters/${encodeURIComponent(String(chapterIndex || ""))}`;
  }

  function photoContentItem(album = {}) {
    return {
      view: "photoDetail",
      params: { id: album.id },
      type: "photo",
      label: "套图",
      title: album.title || album.personName || "图包详情",
      subtitle: [album.category, album.personName].filter(Boolean).join(" · "),
      meta: [
        album.imageCount !== null && album.imageCount !== undefined ? `${formatNumber(album.imageCount)} 张` : "",
        formatBytes(album.size)
      ].filter(Boolean).join(" · "),
      coverUrl: album.coverUrl || album.images?.[0]?.url || "",
      fallback: album.title || album.personName || "套图"
    };
  }

  function recordPhotoRecent(album = {}) {
    if (!album.id) return;
    recordRecentContent(photoContentItem(album));
  }

  function mangaContentItem(comic = {}) {
    return {
      view: "mangaDetail",
      params: { id: comic.id },
      type: "manga",
      label: "韩漫",
      title: comic.title || "漫画详情",
      subtitle: [comic.site, comic.category].filter(Boolean).join(" · "),
      meta: [
        comic.chapterCount !== null && comic.chapterCount !== undefined ? `${formatNumber(comic.chapterCount)} 话` : "",
        comic.imageCount !== null && comic.imageCount !== undefined ? `${formatNumber(comic.imageCount)} 张` : ""
      ].filter(Boolean).join(" · "),
      coverUrl: comic.coverUrl || "",
      fallback: comic.title || "韩漫"
    };
  }

  function recordMangaRecent(comic = {}) {
    if (!comic.id) return;
    recordRecentContent(mangaContentItem(comic));
  }

  function mangaChapterContentItem(mangaId, comic = {}, chapter = {}) {
    return {
      view: "mangaChapter",
      params: { id: mangaId, chapterIndex: chapter.index },
      type: "manga",
      label: "韩漫阅读",
      title: comic.title || chapter.title || "漫画章节",
      subtitle: chapter.title || "",
      meta: chapter.imageCount !== null && chapter.imageCount !== undefined ? `${formatNumber(chapter.imageCount)} 张` : "",
      coverUrl: chapter.coverUrl || chapter.images?.[0]?.url || comic.coverUrl || "",
      fallback: comic.title || chapter.title || "韩漫"
    };
  }

  function recordMangaChapterRecent(mangaId, comic = {}, chapter = {}) {
    if (!mangaId || !chapter.index) return;
    recordRecentContent(mangaChapterContentItem(mangaId, comic, chapter));
  }

  function mediaContentItem(item = {}, channel = CHANNELS.movie, mode = "movie") {
    return {
      view: "mediaDetail",
      params: { id: item.id, mode },
      type: mode,
      label: channel.label,
      title: mediaDisplayTitle(item, channel),
      subtitle: [item.seriesName, item.category].filter(Boolean).join(" · "),
      meta: [item.ext ? item.ext.toUpperCase() : "", formatBytes(item.size)].filter(Boolean).join(" · "),
      coverUrl: item.coverUrl || "",
      fallback: mediaDisplayTitle(item, channel)
    };
  }

  function recordMediaRecent(item = {}, channel = CHANNELS.movie, mode = "movie") {
    if (!item.id) return;
    recordRecentContent(mediaContentItem(item, channel, mode));
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







