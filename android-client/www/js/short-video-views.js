import { fetchJson } from "./api.js?v=20260706-mobile-web-sync-01";
import { absoluteUrl, loadPreviewImage } from "./image.js?v=20260706-mobile-web-sync-01";
import { formatBytes, formatCompact } from "./format.js";

const DEFAULT_LIMIT = 21;
const AUTHOR_PAGE_LIMIT = 36;
const AUTHOR_INITIAL_COUNT = 36;
const AUTHOR_APPEND_COUNT = 30;
const DEFAULT_SORT = "published";
const DEFAULT_SOURCE = "liked";
const SHORT_VIDEO_SORT_OPTIONS = [
  ["published", "时间倒序"],
  ["publishedAsc", "时间正序"],
  ["liked", "最近点赞"],
  ["likes", "点赞最多"],
  ["likesAsc", "点赞最少"],
  ["comments", "评论最多"],
  ["duration", "时长最长"]
];

export function createShortVideoViews(deps) {
  const {
    els,
    getActiveUrl,
    goBack,
    renderCurrentView,
    setActiveBottom,
    showView
  } = deps;

  const listState = {
    data: null,
    query: "",
    author: "all",
    source: DEFAULT_SOURCE,
    sort: DEFAULT_SORT,
    loading: false,
    loadingMore: false,
    status: "",
    searchFiltersEl: null,
    authorVisibleCount: AUTHOR_INITIAL_COUNT
  };
  const browserState = {
    video: null,
    prevId: "",
    nextId: "",
    prevVideo: null,
    nextVideo: null,
    loading: false,
    locked: false,
    lastOpenedId: "",
    pendingSlideDirection: 0,
    slideDirection: 0,
    dragging: false,
    horizontalDragging: false,
    touchStartX: 0,
    touchStartY: 0,
    touchDeltaX: 0,
    touchDeltaY: 0,
    lastStageTapAt: 0,
    lastStageTapKey: "",
    stageTapTimer: null,
    systemInfoText: "",
    systemInfoTimer: null,
    authorReturnPanel: null,
    likedVideoKeys: new Set(),
    muted: false,
    autoNext: false,
    controlsHidden: false,
    stageLongPressTimer: null,
    stageLongPressTriggered: false,
    stageLongPressStartX: 0,
    stageLongPressStartY: 0
  };

  let eventsInstalled = false;
  let listEventsInstalled = false;
  let listLoadMoreObserver = null;
  const warmedMedia = new Set();
  const firstFrameCache = new Map();

  async function renderList(params = {}, renderGuard = null) {
    stopSystemInfoUpdates();
    clearStageTapTimer();
    clearStageLongPress();
    closePlaybackActions();
    closePlaybackToolbar();
    browserState.authorReturnPanel = null;
    setImmersiveMode(false);
    installListEvents();
    setActiveBottom("shortVideos");
    applyListParams(params);
    els.viewKicker.textContent = "短视频";
    els.viewTitle.textContent = "短视频";
    els.viewMeta.textContent = "";
    els.viewContent.className = "content-list short-video-mobile-content";
    renderListShell();
    await loadList(renderGuard);
  }

  async function renderBrowser(input, renderGuard = null) {
    clearStageTapTimer();
    clearStageLongPress();
    closePlaybackActions();
    closePlaybackToolbar();
    setImmersiveMode(true);
    startSystemInfoUpdates();
    installBrowserEvents();
    setActiveBottom("shortVideos");
    els.viewKicker.textContent = "短视频";
    els.viewTitle.textContent = "正在播放";
    els.viewMeta.textContent = "上滑切换";
    els.viewContent.className = "content-list short-video-mobile-content";
    const videoId = applyBrowserParams(input);
    await loadVideo(videoId, renderGuard);
  }

  function applyBrowserParams(input = {}) {
    if (typeof input === "string" || typeof input === "number") return String(input || "").trim();
    const params = input || {};
    listState.query = String(params.query || params.q || "").trim();
    listState.author = String(params.author || "all").trim() || "all";
    listState.source = normalizeSource(params.source || params.origin);
    listState.sort = normalizeSort(params.sort);
    return String(params.id || "").trim();
  }

  function applyListParams(params = {}) {
    const nextQuery = String(params.query || params.q || "").trim();
    let nextAuthor = String(params.author || "all").trim() || "all";
    let nextSource = normalizeSource(params.source || params.origin);
    const nextSort = normalizeSort(params.sort);
    if (nextSource === "authors") nextAuthor = "all";
    if (nextAuthor === "all" && !["liked", "authors"].includes(nextSource)) nextSource = DEFAULT_SOURCE;
    const scopeChanged = nextQuery !== listState.query
      || nextAuthor !== listState.author
      || nextSource !== listState.source
      || nextSort !== listState.sort;
    listState.query = nextQuery;
    listState.author = nextAuthor;
    listState.source = nextSource;
    listState.sort = nextSort;
    if (scopeChanged) {
      listState.data = null;
      listState.status = "";
      listState.authorVisibleCount = AUTHOR_INITIAL_COUNT;
    }
  }

  async function loadList(renderGuard = null, options = {}) {
    const append = Boolean(options.append);
    if (append && (listState.loading || listState.loadingMore || !listState.data?.hasMore)) return;
    const requestUrl = getActiveUrl();
    const params = new URLSearchParams();
    if (listState.query) params.set("q", listState.query);
    if (listState.author && listState.author !== "all") params.set("author", listState.author);
    params.set("source", shortVideoApiSource());
    params.set("sort", listState.sort || DEFAULT_SORT);
    params.set("limit", String(isAuthorIndexView() ? 1 : DEFAULT_LIMIT));
    params.set("facets", isAuthorIndexView() ? "1" : "0");
    params.set("stats", "0");
    if (append) params.set("offset", String(listState.data?.videos?.length || 0));
    if (append) {
      listState.loadingMore = true;
    } else {
      listState.loading = true;
      listState.status = listState.data ? "" : "正在读取短视频";
    }
    renderListShell();
    try {
      const data = await fetchJson(requestUrl, `/api/short-videos?${params}`, { timeoutMs: 16000 });
      if (renderGuard && !renderGuard()) return;
      if (append && listState.data) {
        const seen = new Set((listState.data.videos || []).map((video) => video.id));
        const merged = [...(listState.data.videos || [])];
        for (const video of data.videos || []) {
          if (seen.has(video.id)) continue;
          seen.add(video.id);
          merged.push(video);
        }
        listState.data = { ...data, videos: merged, offset: 0, limit: merged.length };
      } else {
        listState.data = data;
      }
      if (!isAuthorIndexView()) listState.source = normalizeSource(data.source || listState.source);
      listState.loading = false;
      listState.loadingMore = false;
      listState.status = data.total ? "" : "还没有短视频。";
      renderListShell();
      if (!append && options.autoOpenFirst) {
        const first = data.videos?.[0];
        if (first) await openShortVideoFromList(first, { replace: Boolean(options.replaceOpen) });
      }
    } catch (error) {
      if (renderGuard && !renderGuard()) return;
      listState.loading = false;
      listState.loadingMore = false;
      listState.status = shortVideoErrorMessage(error, "短视频读取失败，请检查服务连接");
      renderListShell();
    }
  }

  function renderListShell() {
    els.viewContent.innerHTML = "";
    resetListLoadMoreObserver();
    const shell = document.createElement("section");
    shell.className = "short-video-mobile-list";
    shell.append(renderLibraryTabs(), renderListToolbar());
    if (isAuthorIndexView()) {
      shell.append(renderAuthorIndex());
      els.viewContent.append(shell);
      return;
    }
    if (listState.status && !(listState.data?.videos || []).length) {
      const status = document.createElement("div");
      status.className = "short-video-mobile-status";
      status.textContent = listState.status;
      shell.append(status);
    }
    const grid = document.createElement("div");
    grid.className = "short-video-mobile-grid";
    for (const video of listState.data?.videos || []) {
      grid.append(renderCard(video));
    }
    if (!(listState.data?.videos || []).length) {
      const empty = document.createElement("div");
      empty.className = "short-video-mobile-empty";
      empty.textContent = listState.loading
        ? "正在读取短视频"
        : listState.status || "没有匹配的视频";
      grid.append(empty);
    }
    shell.append(grid);
    if (listState.data?.hasMore) {
      const sentinel = document.createElement("div");
      sentinel.className = "short-video-mobile-load-more";
      sentinel.setAttribute("aria-hidden", "true");
      shell.append(sentinel);
      observeListLoadMore(sentinel);
    }
    els.viewContent.append(shell);
  }

  function renderLibraryTabs() {
    const tabs = document.createElement("div");
    tabs.className = "short-video-mobile-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "短视频分组");
    const activeGroup = activeLibraryGroup();
    for (const [value, label] of [["liked", "我的喜欢"], ["authors", "作者"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "short-video-mobile-tab";
      const active = activeGroup === value;
      button.classList.toggle("active", active);
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(active));
      button.textContent = label;
      button.addEventListener("click", () => {
        if (active && !(value === "authors" && isAuthorFeedView())) return;
        showView("shortVideos", {
          query: "",
          author: "all",
          source: value,
          sort: listState.sort || DEFAULT_SORT
        }, { resetStack: true });
      });
      tabs.append(button);
    }
    return tabs;
  }

  function renderListToolbar() {
    const toolbar = document.createElement("div");
    toolbar.className = "short-video-mobile-toolbar";
    const copy = document.createElement("div");
    copy.className = "short-video-mobile-toolbar-copy";
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    if (isAuthorIndexView()) {
      title.textContent = "按作者浏览";
      meta.textContent = listState.loading && !(listState.data?.authors || []).length
        ? "正在读取作者"
        : `${formatCompact(sortedAuthorFacets({ ignoreQuery: true }).length)} 位作者`;
    } else if (isAuthorFeedView()) {
      const author = currentAuthorFacet();
      title.textContent = author.name || "作者作品";
      meta.textContent = `${formatCompact(listState.data?.total || 0)} 条作品`;
      const back = document.createElement("button");
      back.type = "button";
      back.className = "short-video-mobile-author-back";
      back.setAttribute("aria-label", "返回作者列表");
      back.append(createIcon("chevronLeft"));
      back.addEventListener("click", () => {
        showView("shortVideos", { query: "", author: "all", source: "authors", sort: listState.sort }, { resetStack: true });
      });
      toolbar.append(back);
    } else {
      title.textContent = "我的喜欢";
      meta.textContent = listState.loading && !listState.data
        ? "正在读取"
        : `${formatCompact(listState.data?.total || 0)} 条`;
    }
    copy.append(title, meta);
    toolbar.append(copy);

    if (!isAuthorIndexView()) {
      const sort = document.createElement("select");
      sort.className = "short-video-mobile-sort";
      sort.setAttribute("aria-label", "短视频排序");
      for (const item of SHORT_VIDEO_SORT_OPTIONS) sort.append(selectOption(item[0], item[1]));
      sort.value = listState.sort || DEFAULT_SORT;
      sort.addEventListener("change", () => updateListParams({ sort: sort.value || DEFAULT_SORT }));
      toolbar.append(sort);
    }
    if (listState.query) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "short-video-mobile-query-clear";
      clear.textContent = `清除“${listState.query}”`;
      clear.addEventListener("click", () => updateListParams({ query: "" }));
      toolbar.append(clear);
    }
    return toolbar;
  }

  function renderAuthorIndex() {
    const wrap = document.createElement("div");
    wrap.className = "short-video-mobile-author-index";
    const authors = sortedAuthorFacets();
    if (listState.loading && !(listState.data?.authors || []).length) {
      for (let index = 0; index < 9; index += 1) {
        const skeleton = document.createElement("span");
        skeleton.className = "short-video-mobile-author-card is-loading";
        skeleton.setAttribute("aria-hidden", "true");
        wrap.append(skeleton);
      }
      return wrap;
    }
    if (!authors.length) {
      const status = document.createElement("div");
      status.className = "short-video-mobile-author-index-status";
      status.textContent = listState.query ? `没有匹配“${listState.query}”的作者` : "还没有作者数据";
      wrap.append(status);
      return wrap;
    }
    const visibleCount = Math.min(listState.authorVisibleCount || AUTHOR_INITIAL_COUNT, authors.length);
    for (const author of authors.slice(0, visibleCount)) wrap.append(renderAuthorIndexCard(author));
    if (visibleCount < authors.length) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "short-video-mobile-author-index-more";
      more.textContent = `继续加载（${formatCompact(visibleCount)} / ${formatCompact(authors.length)}）`;
      more.addEventListener("click", () => appendVisibleAuthors(true));
      wrap.append(more);
    }
    return wrap;
  }

  function renderAuthorIndexCard(author = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "short-video-mobile-author-card";
    button.setAttribute("aria-label", `查看 ${author.name || "未知作者"} 的作品`);
    const avatar = document.createElement("span");
    avatar.className = "short-video-mobile-author-card-avatar";
    const imageUrl = author.avatarUrl || author.fallbackCoverUrl || "";
    if (imageUrl) {
      const img = document.createElement("img");
      img.src = absoluteUrl(getActiveUrl(), imageUrl);
      img.alt = author.name || "作者头像";
      img.loading = "lazy";
      img.decoding = "async";
      img.addEventListener("error", () => {
        img.remove();
        avatar.textContent = initials(author.name || "?");
      }, { once: true });
      avatar.append(img);
    } else {
      avatar.textContent = initials(author.name || "?");
    }
    const name = document.createElement("strong");
    name.textContent = author.name || "未知作者";
    const count = document.createElement("span");
    count.textContent = `${formatCompact(author.count || 0)} 条视频`;
    button.append(avatar, name, count);
    bindReliableTap(button, () => showAuthorPanel({ authorFilter: shortVideoAuthorFilterValue(author), author }));
    return button;
  }

  function sortedAuthorFacets(options = {}) {
    const query = options.ignoreQuery ? "" : listState.query.toLocaleLowerCase("zh-CN");
    return [...(listState.data?.authors || [])]
      .filter((author) => author && shortVideoAuthorFilterValue(author))
      .filter((author) => !query || `${author.name || ""} ${author.secUid || ""}`.toLocaleLowerCase("zh-CN").includes(query))
      .sort((a, b) => Number(b.count || 0) - Number(a.count || 0) || String(a.name || "").localeCompare(String(b.name || ""), "zh-CN"));
  }

  function appendVisibleAuthors(force = false) {
    if (!isAuthorIndexView()) return;
    const total = sortedAuthorFacets().length;
    const current = listState.authorVisibleCount || AUTHOR_INITIAL_COUNT;
    if (!total || current >= total) return;
    if (!force) {
      const doc = document.documentElement;
      const remaining = doc.scrollHeight - window.scrollY - window.innerHeight;
      if (remaining > 700) return;
    }
    listState.authorVisibleCount = Math.min(total, current + AUTHOR_APPEND_COUNT);
    renderListShell();
  }

  function currentAuthorFacet() {
    const filter = String(listState.author || "").trim();
    return (listState.data?.authors || []).find((author) => shortVideoAuthorFilterValue(author) === filter)
      || (listState.data?.videos || []).find((video) => video?.author)?.author
      || {};
  }

  function shortVideoAuthorFilterValue(author = {}) {
    const secUid = String(author.secUid || "").trim();
    if (secUid) return secUid;
    const name = String(author.name || "").trim();
    return name ? `name:${name}` : "";
  }

  function isAuthorIndexView() {
    return listState.source === "authors" && listState.author === "all";
  }

  function isAuthorFeedView() {
    return listState.author !== "all";
  }

  function activeLibraryGroup() {
    return isAuthorIndexView() || isAuthorFeedView() ? "authors" : "liked";
  }

  function updateListParams(patch = {}, navigation = {}) {
    const next = {
      query: listState.query,
      author: listState.author,
      source: listState.source,
      sort: listState.sort,
      ...patch
    };
    showView("shortVideos", next, { resetStack: true, skipHistory: true, replaceHistory: true, ...navigation });
  }

  function getSearchState() {
    return {
      query: listState.query || "",
      author: listState.author || "all",
      source: listState.source || DEFAULT_SOURCE,
      sort: listState.sort || DEFAULT_SORT,
      authors: listState.data?.authors || []
    };
  }

  function submitSearch(query = "", overrides = {}) {
    const group = overrides.source ?? selectedSearchFilterValue("source", activeLibraryGroup());
    const currentAuthor = overrides.author ?? (listState.author || "all");
    const author = group === "authors" ? currentAuthor : "all";
    const source = group === "authors"
      ? (author !== "all" ? "all" : "authors")
      : "liked";
    updateListParams({
      query: String(query || "").trim(),
      author,
      source,
      sort: overrides.sort ?? selectedSearchFilterValue("sort", listState.sort || DEFAULT_SORT)
    });
  }

  function selectedSearchFilterValue(kind, fallback) {
    const selector = kind === "author"
      ? "[data-short-video-search-author]"
      : kind === "source"
        ? "[data-short-video-search-source]"
        : "[data-short-video-search-sort]";
    return listState.searchFiltersEl?.querySelector?.(selector)?.value || fallback;
  }

  function renderSearchFilters(form, onSubmit = null) {
    if (!form) return;
    const existing = form.querySelector(".short-video-search-filters");
    if (existing) existing.remove();
    const filters = document.createElement("div");
    filters.className = "short-video-search-filters";

    const source = document.createElement("select");
    source.dataset.shortVideoSearchSource = "1";
    source.setAttribute("aria-label", "短视频分组");
    for (const item of [
      ["liked", "我的喜欢"],
      ["authors", "作者"]
    ]) source.append(selectOption(item[0], item[1]));
    source.value = activeLibraryGroup();

    const sort = document.createElement("select");
    sort.dataset.shortVideoSearchSort = "1";
    sort.setAttribute("aria-label", "短视频排序");
    for (const item of SHORT_VIDEO_SORT_OPTIONS) sort.append(selectOption(item[0], item[1]));
    sort.value = listState.sort || DEFAULT_SORT;

    const apply = () => {
      listState.sort = sort.value || DEFAULT_SORT;
      if (onSubmit) onSubmit();
    };
    source.addEventListener("change", apply);
    sort.addEventListener("change", apply);
    filters.append(source, sort);
    form.append(filters);
    listState.searchFiltersEl = filters;
  }

  function clearSearchFilters(form) {
    form?.querySelector?.(".short-video-search-filters")?.remove();
    if (listState.searchFiltersEl && !listState.searchFiltersEl.isConnected) listState.searchFiltersEl = null;
  }

  function renderCard(video) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "short-video-mobile-card";
    bindReliableTap(card, () => openShortVideoFromList(video));
    const thumb = document.createElement("div");
    thumb.className = "short-video-mobile-thumb";
    if (video.coverUrl) {
      const placeholder = document.createElement("span");
      placeholder.textContent = "PLAY";
      thumb.append(placeholder);
      loadPreviewImage(placeholder, absoluteUrl(getActiveUrl(), video.coverUrl), {
        cacheBaseUrl: getActiveUrl(),
        decorate: (img) => {
          img.alt = video.title || "短视频封面";
        }
      }).catch(() => {});
    } else if (video.streamUrl) {
      const frame = document.createElement("span");
      frame.dataset.shortVideoFrameId = video.id || "";
      thumb.append(frame);
      requestVideoFirstFrame(video).catch(() => {});
    } else {
      const fallback = document.createElement("span");
      fallback.textContent = "PLAY";
      thumb.append(fallback);
    }
    const metric = document.createElement("span");
    metric.className = "short-video-mobile-thumb-metric";
    metric.append(createIcon("heart"), document.createTextNode(formatCompact(video.stats?.likes || 0)));
    thumb.append(metric);
    card.setAttribute("aria-label", video.title || "打开短视频");
    card.append(thumb);
    return card;
  }

  function bindReliableTap(element, action) {
    let touchStart = null;
    let opened = false;
    const open = () => {
      if (opened) return;
      opened = true;
      Promise.resolve(action?.()).finally(() => {
        window.setTimeout(() => {
          opened = false;
        }, 420);
      });
    };
    element.addEventListener("click", (event) => {
      event.preventDefault();
      open();
    });
    element.addEventListener("touchstart", (event) => {
      if (event.touches.length !== 1) {
        touchStart = null;
        return;
      }
      const touch = event.touches[0];
      touchStart = {
        x: touch.clientX,
        y: touch.clientY,
        at: Date.now()
      };
    }, { passive: true });
    element.addEventListener("touchend", (event) => {
      if (!touchStart || event.changedTouches.length !== 1) return;
      const touch = event.changedTouches[0];
      const dx = Math.abs(touch.clientX - touchStart.x);
      const dy = Math.abs(touch.clientY - touchStart.y);
      const elapsed = Date.now() - touchStart.at;
      touchStart = null;
      if (dx > 14 || dy > 14 || elapsed > 850) return;
      event.preventDefault();
      open();
    }, { passive: false });
    element.addEventListener("touchcancel", () => {
      touchStart = null;
    }, { passive: true });
  }

  function resetListLoadMoreObserver() {
    listLoadMoreObserver?.disconnect?.();
    listLoadMoreObserver = null;
  }

  function observeListLoadMore(sentinel) {
    if (!sentinel || !("IntersectionObserver" in window)) {
      if (listState.data?.hasMore) loadList(null, { append: true }).catch(() => {});
      return;
    }
    listLoadMoreObserver = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      if (!listState.data?.hasMore || listState.loading || listState.loadingMore) return;
      loadList(null, { append: true }).catch((error) => {
        listState.loadingMore = false;
        listState.status = shortVideoErrorMessage(error, "加载失败，请稍后重试");
        renderListShell();
      });
    }, { root: null, rootMargin: "180px 0px", threshold: 0.01 });
    listLoadMoreObserver.observe(sentinel);
  }

  async function openShortVideoFromList(video, options = {}) {
    const opened = options.skipNative ? false : await openNativeShortVideoFeed(video);
    if (opened) return;
    showView("shortVideoBrowser", shortVideoBrowserParams(video.id), options.replace ? { skipHistory: true, replaceHistory: true } : { push: true });
  }

  async function openNativeShortVideoFeed(video) {
    const plugin = nativePlayerPlugin();
    if (!plugin?.playShortFeed || !video?.id) return false;
    if (!String(video.streamUrl || "").trim()) {
      shortVideoToast("这条视频缺少本地文件，暂时无法播放");
      return true;
    }
    const videos = listState.data?.videos || [];
    const playableEntries = videos
      .map((item, apiIndex) => ({ item, apiIndex }))
      .filter(({ item }) => String(item?.streamUrl || "").trim());
    const index = playableEntries.findIndex(({ item }) => item === video || item.id === video.id);
    if (index < 0) return false;
    const start = Math.max(0, index - 20);
    const end = Math.min(playableEntries.length, index + 31);
    const feedEntries = playableEntries.slice(start, end);
    const feedUrl = nativeShortVideoFeedUrl();
    const payload = feedEntries.map(({ item }) => ({
      id: item.id,
      awemeId: item.awemeId || "",
      title: item.title || "",
      streamUrl: item.streamUrl || "",
      coverUrl: item.coverUrl || "",
      shareUrl: item.shareUrl || "",
      originalUrl: item.originalUrl || "",
      author: {
        name: item.author?.name || "",
        secUid: item.author?.secUid || "",
        uid: item.author?.uid || "",
        avatarUrl: item.author?.avatarUrl || "",
        profileUrl: item.author?.profileUrl || "",
        uniqueId: item.author?.uniqueId || "",
        shortId: item.author?.shortId || "",
        signature: item.author?.signature || "",
        ipLocation: item.author?.ipLocation || "",
        followerCount: Number(item.author?.followerCount || 0),
        followingCount: Number(item.author?.followingCount || 0),
        totalFavorited: Number(item.author?.totalFavorited || 0),
        awemeCount: Number(item.author?.awemeCount || 0),
        favoritingCount: Number(item.author?.favoritingCount || 0),
        gender: Number(item.author?.gender || 0),
        age: Number(item.author?.age || 0),
        verification: item.author?.verification || "",
        profileCollectedAt: item.author?.profileCollectedAt || ""
      },
      publishedAt: item.publishedAt || "",
      durationMs: Number(item.durationMs || 0),
      size: Number(item.size || 0),
      stats: {
        likes: Number(item.stats?.likes || 0),
        comments: Number(item.stats?.comments || 0),
        collects: Number(item.stats?.collects || 0),
        shares: Number(item.stats?.shares || 0),
        plays: Number(item.stats?.plays || 0)
      }
    }));
    try {
      await plugin.playShortFeed({
        baseUrl: getActiveUrl(),
        feedUrl,
        hasMore: Boolean(listState.data?.hasMore || end < playableEntries.length),
        nextOffset: feedEntries.length ? feedEntries[feedEntries.length - 1].apiIndex + 1 : videos.length,
        startIndex: index - start,
        startId: video.id,
        videos: JSON.stringify(payload)
      });
      return true;
    } catch {
      return false;
    }
  }

  function nativeShortVideoFeedUrl() {
    const url = new URL("/api/short-videos", getActiveUrl());
    if (listState.query) url.searchParams.set("q", listState.query);
    if (listState.author && listState.author !== "all") url.searchParams.set("author", listState.author);
    url.searchParams.set("source", shortVideoApiSource());
    url.searchParams.set("sort", listState.sort || DEFAULT_SORT);
    url.searchParams.set("facets", "0");
    return url.toString();
  }

  async function loadVideo(videoId, renderGuard = null) {
    const id = String(videoId || "").trim();
    if (!id) {
      showView("shortVideos", {}, { resetStack: true });
      return;
    }
    const seed = cachedListVideo(id);
    if (seed) {
      browserState.video = seed;
      browserState.lastOpenedId = id;
      applyQueuedReelWindow(seed.id);
    }
    browserState.loading = true;
    renderBrowserShell();
    try {
      const data = await fetchJson(getActiveUrl(), `/api/short-videos/${encodeURIComponent(id)}?${shortVideoFeedParams()}`, { timeoutMs: 16000 });
      if (renderGuard && !renderGuard()) return;
      browserState.video = data.video;
      browserState.lastOpenedId = data.video.id;
      browserState.prevId = data.prevId || "";
      browserState.nextId = data.nextId || "";
      applyQueuedReelWindow(data.video.id, { keepExisting: true });
      await loadAdjacentVideos(data.video.id);
      browserState.slideDirection = Number(browserState.pendingSlideDirection || 0);
      browserState.pendingSlideDirection = 0;
      browserState.loading = false;
      renderBrowserShell();
    } catch (error) {
      if (renderGuard && !renderGuard()) return;
      browserState.loading = false;
      browserState.video = null;
      renderBrowserError(error);
    }
  }

  function renderBrowserShell() {
    els.viewContent.innerHTML = "";
    const video = browserState.video;
    const screen = document.createElement("section");
    screen.className = "short-video-mobile-browser";
    screen.classList.toggle("is-controls-hidden", browserState.controlsHidden);
    const slideDirection = Number(browserState.slideDirection || 0);
    if (slideDirection > 0) screen.classList.add("is-slide-next");
    else if (slideDirection < 0) screen.classList.add("is-slide-prev");
    if (slideDirection) {
      screen.addEventListener("animationend", () => {
        browserState.slideDirection = 0;
      }, { once: true });
    }
    if (browserState.loading && !video) {
      const loading = document.createElement("div");
      loading.className = "short-video-mobile-loading";
      loading.textContent = "正在打开视频";
      screen.append(loading);
      els.viewContent.append(screen);
      return;
    }
    if (!video) {
      renderBrowserError(new Error("视频不存在"));
      return;
    }

    const top = document.createElement("div");
    top.className = "short-video-mobile-top";
    const systemInfo = document.createElement("span");
    systemInfo.className = "short-video-mobile-system-info";
    systemInfo.dataset.shortVideoSystemInfo = "1";
    systemInfo.textContent = browserState.systemInfoText || formatSystemStatusText();
    const search = document.createElement("button");
    search.type = "button";
    search.className = "short-video-mobile-top-search";
    search.textContent = listState.query || "搜索";
    search.setAttribute("aria-label", "返回列表搜索短视频");
    search.addEventListener("click", showShortVideoListSearch);
    top.append(systemInfo, search);

    const stack = document.createElement("div");
    stack.className = "short-video-mobile-reel-stack";
    if (browserState.dragging) stack.classList.add("is-dragging");
    if (browserState.prevVideo) stack.append(renderMobileReelPanel(browserState.prevVideo, { slot: "prev", ghost: true }).panel);
    const current = renderMobileReelPanel(video, { slot: "current" });
    stack.append(current.panel);
    if (browserState.nextVideo) stack.append(renderMobileReelPanel(browserState.nextVideo, { slot: "next", ghost: true }).panel);

    screen.append(stack, top);
    els.viewContent.append(screen);
    current.syncPlayToggle();
    requestAnimationFrame(() => current.player.play().then(current.syncPlayToggle).catch(current.syncPlayToggle));
    warmAdjacentMedia();
  }

  function renderMobileReelPanel(video, options = {}) {
    const ghost = Boolean(options.ghost);
    const slot = options.slot || "current";
    const panel = document.createElement("div");
    panel.className = `short-video-mobile-reel-panel is-${slot}${ghost ? " is-ghost-panel" : ""}`;

    const streamUrl = absoluteUrl(getActiveUrl(), video.streamUrl);
    const posterUrl = absoluteUrl(getActiveUrl(), video.coverUrl);
    const firstFrameUrl = cachedFirstFrameUrl(video) || posterUrl;

    const stage = document.createElement("div");
    stage.className = "short-video-mobile-stage";

    let syncPlayToggle = () => {};
    if (ghost) {
      requestVideoFirstFrame(video);
      if (firstFrameUrl) {
        const poster = document.createElement("img");
        poster.className = "short-video-mobile-player is-ghost";
        poster.src = firstFrameUrl;
        poster.alt = video.title || "短视频第一帧";
        poster.dataset.shortVideoFrameId = video.id || "";
        stage.append(poster);
      } else {
        const placeholder = document.createElement("div");
        placeholder.className = "short-video-mobile-player is-ghost short-video-mobile-player-placeholder";
        placeholder.dataset.shortVideoFrameId = video.id || "";
        stage.append(placeholder);
      }
    } else {
      panel.classList.add("is-video-loading");
      requestVideoFirstFrame(video);
      const cover = firstFrameUrl ? document.createElement("img") : document.createElement("div");
      cover.className = "short-video-mobile-cover";
      cover.dataset.shortVideoFrameId = video.id || "";
      if (firstFrameUrl) {
        cover.alt = "";
        cover.src = firstFrameUrl;
      }

      const player = document.createElement("video");
      player.className = "short-video-mobile-player";
      player.src = streamUrl;
      if (posterUrl) player.poster = posterUrl;
      player.controls = false;
      player.autoplay = true;
      player.muted = browserState.muted;
      player.defaultMuted = browserState.muted;
      player.playsInline = true;
      player.loop = !browserState.autoNext;
      player.preload = "auto";
      player.volume = 1;
      const playToggle = document.createElement("button");
      playToggle.type = "button";
      playToggle.className = "short-video-mobile-play-toggle";
      playToggle.setAttribute("aria-label", "播放或暂停");
      syncPlayToggle = () => {
        setIconButton(playToggle, player.paused ? "play" : "pause", player.paused ? "播放" : "暂停");
        playToggle.classList.toggle("is-playing", !player.paused);
      };
      const revealVideo = () => {
        panel.classList.remove("is-video-loading");
      };
      const togglePlay = () => {
        if (player.paused) player.play().then(syncPlayToggle).catch(syncPlayToggle);
        else {
          player.pause();
          syncPlayToggle();
        }
      };
      player.addEventListener("play", syncPlayToggle);
      player.addEventListener("pause", syncPlayToggle);
      player.addEventListener("loadedmetadata", syncPlayToggle);
      player.addEventListener("loadeddata", revealVideo, { once: true });
      player.addEventListener("playing", revealVideo, { once: true });
      player.addEventListener("ended", () => {
        if (browserState.autoNext) openAdjacent(1).catch(() => {});
      });
      playToggle.addEventListener("click", togglePlay);
      stage.addEventListener("click", (event) => {
        if (consumeStageLongPressClick(event)) return;
        if (event.target?.closest?.("button")) return;
        handleStageClick(video, panel, togglePlay);
      });
      bindStageLongPress(stage, video);
      stage.append(player, cover, playToggle);
      panel._shortVideoPlayer = player;
      panel._shortVideoSyncPlayToggle = syncPlayToggle;
    }

    const caption = document.createElement("div");
    caption.className = "short-video-mobile-caption";
    const author = document.createElement("strong");
    author.textContent = `@${video.author?.name || "未知作者"}`;
    author.style.cursor = "pointer";
    author.addEventListener("click", () => showAuthorPanel(video));
    const title = document.createElement("p");
    title.textContent = video.title || "";
    const meta = document.createElement("span");
    meta.textContent = [formatDate(video.publishedAt), formatDuration(video.durationMs), formatBytes(video.size || 0)].filter(Boolean).join(" · ");
    caption.append(author, title, meta);
    panel.append(stage, caption);

    if (!ghost) {
      const rail = document.createElement("aside");
      rail.className = "short-video-mobile-rail";
      rail.append(authorRailButton(video, () => showAuthorPanel(video)));
      rail.append(railMetric("heart", displayWebLikes(video), "like", "点赞", (event) => likeWebVideo(video, panel, event.currentTarget), isWebLiked(video)));
      rail.append(railMetric("comment", video.stats?.comments, "comment", "评论"));
      rail.append(railMetric("star", video.stats?.collects, "collect", "收藏", toggleRailActive));
      rail.append(railMetric("share", video.stats?.shares, "share", "分享", () => shareShortVideo(video)));
      const nav = document.createElement("div");
      nav.className = "short-video-mobile-nav-pair";
      nav.append(
        railNav("up", () => openAdjacent(-1), !browserState.prevId),
        railNav("down", () => openAdjacent(1), !browserState.nextId)
      );
      panel.append(nav, rail);
    }

    return {
      panel,
      player: panel._shortVideoPlayer || null,
      syncPlayToggle: panel._shortVideoSyncPlayToggle || syncPlayToggle
    };
  }

  function renderBrowserError(error) {
    els.viewContent.innerHTML = "";
    const box = document.createElement("div");
    box.className = "short-video-mobile-empty";
    box.textContent = shortVideoErrorMessage(error, "视频打开失败，请稍后重试");
    els.viewContent.append(box);
  }

  function shortVideoErrorMessage(error, fallback) {
    const message = String(error?.message || "").trim();
    if (!message) return fallback;
    if (/failed to fetch|network|timeout/i.test(message)) return fallback;
    if (/database disk image|malformed|sqlite/i.test(message)) return "短视频数据正在恢复，请稍后重试";
    return message;
  }

  function showShortVideoListSearch() {
    clearStageTapTimer();
    closePlaybackActions();
    closeAuthorPanel({ resume: false });
    stopPanelMedia(activeReelStack());
    window.dispatchEvent(new CustomEvent("fanhaoOpenShortVideoSearch", {
      detail: {
        from: "shortVideoBrowser",
        state: getSearchState()
      }
    }));
  }

  async function openAdjacent(direction) {
    const id = direction < 0 ? browserState.prevId : browserState.nextId;
    if (!id || browserState.locked) return;
    browserState.locked = true;
    try {
      clearStageTapTimer();
      await animateActiveStack(direction);
      stopPanelMedia(activeReelStack());
      browserState.pendingSlideDirection = 0;
      const cachedVideo = direction < 0 ? browserState.prevVideo : browserState.nextVideo;
      if (cachedVideo) {
        promoteAdjacentVideo(direction, cachedVideo);
        replaceCurrentShortVideoHistory(id);
        renderBrowserShell();
        warmListAround(id);
        refreshCurrentDetail(id).catch(() => {});
      } else {
        showView("shortVideoBrowser", shortVideoBrowserParams(id), { skipHistory: true, replaceHistory: true });
      }
    } finally {
      window.setTimeout(() => {
        browserState.locked = false;
      }, 320);
    }
  }

  function installBrowserEvents() {
    if (eventsInstalled) return;
    eventsInstalled = true;
    window.addEventListener("touchstart", (event) => {
      if (!isBrowserView()) return;
      const touch = event.touches?.[0];
      browserState.touchStartX = touch?.clientX || 0;
      browserState.touchStartY = touch?.clientY || 0;
      browserState.touchDeltaX = 0;
      browserState.touchDeltaY = 0;
      browserState.horizontalDragging = false;
      browserState.dragging = true;
      activeReelStack()?.classList.add("is-dragging");
    }, { passive: true });
    window.addEventListener("touchmove", (event) => {
      if (!isBrowserView()) return;
      const touch = event.touches?.[0];
      const x = touch?.clientX || 0;
      const y = touch?.clientY || 0;
      browserState.touchDeltaX = x - browserState.touchStartX;
      browserState.touchDeltaY = y - browserState.touchStartY;
      if (!browserState.horizontalDragging && isHorizontalSwipe(browserState.touchDeltaX, browserState.touchDeltaY, 28)) {
        browserState.horizontalDragging = true;
        activeReelStack()?.classList.remove("is-dragging");
        snapStackBack();
      }
      if (!browserState.horizontalDragging) applyDragDelta(browserState.touchDeltaY);
      event.preventDefault();
    }, { passive: false });
    window.addEventListener("touchend", (event) => {
      if (!isBrowserView()) return;
      const touch = event.changedTouches?.[0];
      const endX = touch?.clientX || 0;
      const endY = touch?.clientY || 0;
      const deltaX = browserState.touchDeltaX || endX - browserState.touchStartX;
      const deltaY = browserState.touchDeltaY || endY - browserState.touchStartY;
      if (isHorizontalSwipe(deltaX, deltaY, 72)) {
        browserState.dragging = false;
        browserState.horizontalDragging = false;
        activeReelStack()?.classList.remove("is-dragging");
        snapStackBack();
        handleHorizontalSwipe(deltaX);
        return;
      }
      finishDrag(deltaY);
    }, { passive: true });
    window.addEventListener("wheel", (event) => {
      if (!isBrowserView() || Math.abs(event.deltaY) < 28) return;
      event.preventDefault();
      openAdjacent(event.deltaY > 0 ? 1 : -1).catch(() => {});
    }, { passive: false });
  }

  function installListEvents() {
    if (listEventsInstalled) return;
    listEventsInstalled = true;
    window.addEventListener("scroll", () => {
      if (!document.body.classList.contains("short-video-mobile-view") || document.body.classList.contains("short-video-mobile-browser-view")) return;
      if (isAuthorIndexView()) {
        appendVisibleAuthors();
        return;
      }
      if (!listState.data?.hasMore || listState.loading || listState.loadingMore) return;
      const doc = document.documentElement;
      const remaining = doc.scrollHeight - window.scrollY - window.innerHeight;
      if (remaining < 700) loadList(null, { append: true }).catch(() => {
        listState.loadingMore = false;
        renderListShell();
      });
    }, { passive: true });
  }

  function isBrowserView() {
    return document.body.classList.contains("short-video-mobile-browser-view");
  }

  async function loadAdjacentVideos(videoId) {
    const params = shortVideoFeedParams();
    const [prevResult, nextResult] = await Promise.allSettled([
      browserState.prevId ? fetchJson(getActiveUrl(), `/api/short-videos/${encodeURIComponent(videoId)}/adjacent?direction=prev&${params}`, { timeoutMs: 10000 }) : Promise.resolve(null),
      browserState.nextId ? fetchJson(getActiveUrl(), `/api/short-videos/${encodeURIComponent(videoId)}/adjacent?direction=next&${params}`, { timeoutMs: 10000 }) : Promise.resolve(null)
    ]);
    browserState.prevVideo = browserState.prevId
      ? (prevResult.status === "fulfilled" ? prevResult.value?.video || browserState.prevVideo || null : browserState.prevVideo || null)
      : null;
    browserState.nextVideo = browserState.nextId
      ? (nextResult.status === "fulfilled" ? nextResult.value?.video || browserState.nextVideo || null : browserState.nextVideo || null)
      : null;
  }

  function promoteAdjacentVideo(direction, video) {
    const current = browserState.video;
    browserState.video = video;
    browserState.lastOpenedId = video?.id || "";
    applyQueuedReelWindow(video?.id, { keepExisting: true });
    if (direction > 0 && current) {
      browserState.prevVideo = current;
      browserState.prevId = current.id || browserState.prevId || "";
    } else if (direction < 0 && current) {
      browserState.nextVideo = current;
      browserState.nextId = current.id || browserState.nextId || "";
    }
  }

  async function refreshCurrentDetail(id) {
    const data = await fetchJson(getActiveUrl(), `/api/short-videos/${encodeURIComponent(id)}?${shortVideoFeedParams()}`, { timeoutMs: 12000 });
    if (browserState.video?.id !== data.video?.id) return;
    browserState.video = data.video;
    browserState.lastOpenedId = data.video.id;
    browserState.prevId = data.prevId || "";
    browserState.nextId = data.nextId || "";
    applyQueuedReelWindow(data.video.id, { keepExisting: true });
    await loadAdjacentVideos(data.video.id);
  }

  function shortVideoFeedParams() {
    const params = new URLSearchParams();
    if (listState.query) params.set("q", listState.query);
    if (listState.author && listState.author !== "all") params.set("author", listState.author);
    params.set("source", shortVideoApiSource());
    params.set("sort", listState.sort || DEFAULT_SORT);
    return params.toString();
  }

  function shortVideoApiSource() {
    const source = normalizeSource(listState.source);
    return source === "authors" ? "liked" : source;
  }

  function cachedListVideo(id) {
    const target = String(id || "");
    if (!target) return null;
    return (listState.data?.videos || []).find((video) => String(video.id) === target || String(video.awemeId || "") === target) || null;
  }

  function applyQueuedReelWindow(centerId, options = {}) {
    const center = String(centerId || "");
    const index = findListVideoIndex(centerId);
    if (index < 0) return false;
    const videos = listState.data?.videos || [];
    const prevVideo = videos[index - 1] || null;
    const nextVideo = videos[index + 1] || null;
    const keepExisting = Boolean(options.keepExisting);
    const existingPrevVideo = keepExisting && String(browserState.prevVideo?.id || "") !== center ? browserState.prevVideo : null;
    const existingNextVideo = keepExisting && String(browserState.nextVideo?.id || "") !== center ? browserState.nextVideo : null;
    const existingPrevId = keepExisting && String(browserState.prevId || "") !== center ? browserState.prevId : "";
    const existingNextId = keepExisting && String(browserState.nextId || "") !== center ? browserState.nextId : "";
    browserState.prevVideo = prevVideo || existingPrevVideo || null;
    browserState.nextVideo = nextVideo || existingNextVideo || null;
    browserState.prevId = browserState.prevVideo?.id || existingPrevId || "";
    browserState.nextId = browserState.nextVideo?.id || existingNextId || "";
    return true;
  }

  function findListVideoIndex(id) {
    const target = String(id || "");
    if (!target) return -1;
    return (listState.data?.videos || []).findIndex((video) => String(video.id) === target || String(video.awemeId || "") === target);
  }

  function warmListAround(id) {
    const index = findListVideoIndex(id);
    const videos = listState.data?.videos || [];
    if (index < 0 || !listState.data?.hasMore || listState.loading || listState.loadingMore) return;
    if (videos.length - index > 8) return;
    appendListSilently().catch(() => {
      listState.loadingMore = false;
    });
  }

  function warmAdjacentMedia() {
    for (const video of [browserState.prevVideo, browserState.nextVideo]) {
      if (!video?.streamUrl || warmedMedia.has(video.id)) continue;
      requestVideoFirstFrame(video);
      warmedMedia.add(video.id);
      const url = absoluteUrl(getActiveUrl(), video.streamUrl);
      fetch(url, {
        cache: "force-cache",
        headers: { Range: "bytes=0-524287" }
      }).then((response) => {
        response.body?.cancel?.();
      }).catch(() => {});
    }
    if (warmedMedia.size > 40) {
      const keep = new Set([browserState.video?.id, browserState.prevVideo?.id, browserState.nextVideo?.id].filter(Boolean));
      for (const id of [...warmedMedia]) {
        if (!keep.has(id)) warmedMedia.delete(id);
        if (warmedMedia.size <= 24) break;
      }
    }
  }

  function cachedFirstFrameUrl(video) {
    return firstFrameCache.get(video?.id || "")?.url || "";
  }

  function requestVideoFirstFrame(video) {
    const id = video?.id || "";
    if (!id || !video.streamUrl) return Promise.resolve("");
    const cached = firstFrameCache.get(id);
    if (cached?.url) return Promise.resolve(cached.url);
    if (cached?.promise) return cached.promise;

    const promise = new Promise((resolve) => {
      const probe = document.createElement("video");
      const timeout = window.setTimeout(() => finish(""), 4200);
      let finished = false;

      probe.muted = true;
      probe.defaultMuted = true;
      probe.playsInline = true;
      probe.preload = "auto";
      probe.crossOrigin = "anonymous";
      probe.className = "short-video-mobile-frame-probe";

      const cleanup = () => {
        window.clearTimeout(timeout);
        probe.pause?.();
        probe.removeAttribute("src");
        probe.load?.();
        probe.remove();
      };
      const finish = (url) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (url) {
          firstFrameCache.set(id, { status: "ready", url });
          updateVisibleFirstFrame(id, url);
          pruneFirstFrameCache();
        } else {
          firstFrameCache.set(id, { status: "failed" });
        }
        resolve(url);
      };
      const capture = () => {
        if (finished || !probe.videoWidth || !probe.videoHeight) return;
        try {
          const canvas = document.createElement("canvas");
          canvas.width = probe.videoWidth;
          canvas.height = probe.videoHeight;
          canvas.getContext("2d")?.drawImage(probe, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((blob) => {
            finish(blob ? URL.createObjectURL(blob) : "");
          }, "image/jpeg", 0.82);
        } catch {
          finish("");
        }
      };
      const seekToFirstFrame = () => {
        if (finished) return;
        if (probe.readyState >= 2) {
          capture();
          return;
        }
        try {
          const target = probe.duration && Number.isFinite(probe.duration) ? Math.min(0.08, Math.max(0, probe.duration / 20)) : 0.04;
          probe.currentTime = target;
        } catch {}
      };

      probe.addEventListener("loadeddata", capture, { once: true });
      probe.addEventListener("seeked", capture, { once: true });
      probe.addEventListener("loadedmetadata", seekToFirstFrame, { once: true });
      probe.addEventListener("error", () => finish(""), { once: true });
      document.body.append(probe);
      probe.src = absoluteUrl(getActiveUrl(), video.streamUrl);
      probe.load();
    });

    firstFrameCache.set(id, { status: "loading", promise });
    return promise;
  }

  function updateVisibleFirstFrame(id, url) {
    if (!id || !url) return;
    for (const node of document.querySelectorAll?.(`[data-short-video-frame-id="${cssEscape(id)}"]`) || []) {
      if (node.tagName === "IMG") {
        node.src = url;
      } else {
        const img = document.createElement("img");
        img.className = node.className;
        img.alt = "";
        img.src = url;
        img.dataset.shortVideoFrameId = id;
        node.replaceWith(img);
      }
    }
  }

  function pruneFirstFrameCache() {
    if (firstFrameCache.size <= 24) return;
    const keep = new Set([browserState.video?.id, browserState.prevVideo?.id, browserState.nextVideo?.id].filter(Boolean));
    for (const [id, item] of firstFrameCache) {
      if (keep.has(id) || item.status === "loading") continue;
      if (item.url) URL.revokeObjectURL(item.url);
      firstFrameCache.delete(id);
      if (firstFrameCache.size <= 18) break;
    }
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, "\\$&");
  }

  async function appendListSilently() {
    if (listState.loadingMore || !listState.data?.hasMore) return;
    listState.loadingMore = true;
    const params = new URLSearchParams();
    if (listState.query) params.set("q", listState.query);
    if (listState.author && listState.author !== "all") params.set("author", listState.author);
    params.set("source", shortVideoApiSource());
    params.set("sort", listState.sort || DEFAULT_SORT);
    params.set("limit", String(DEFAULT_LIMIT));
    params.set("offset", String(listState.data?.videos?.length || 0));
    const data = await fetchJson(getActiveUrl(), `/api/short-videos?${params}`, { timeoutMs: 16000 });
    const seen = new Set((listState.data.videos || []).map((video) => video.id));
    const merged = [...(listState.data.videos || [])];
    for (const video of data.videos || []) {
      if (seen.has(video.id)) continue;
      seen.add(video.id);
      merged.push(video);
    }
    listState.data = { ...data, videos: merged, offset: 0, limit: merged.length };
    listState.loadingMore = false;
    if (browserState.video?.id) applyQueuedReelWindow(browserState.video.id, { keepExisting: true });
  }

  function replaceCurrentShortVideoHistory(id) {
    if (!window.history?.replaceState) return;
    const nextParams = shortVideoBrowserParams(id);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(nextParams)) {
      if (value !== undefined && value !== null && String(value).length) params.set(key, String(value));
    }
    const state = window.history.state && typeof window.history.state === "object"
      ? { ...window.history.state, view: "shortVideoBrowser", params: nextParams }
      : window.history.state;
    window.history.replaceState(state, "", `#shortVideoBrowser?${params.toString()}`);
  }

  function shortVideoBrowserParams(id) {
    return {
      id: String(id || ""),
      ...(listState.query ? { query: listState.query } : {}),
      ...(listState.author && listState.author !== "all" ? { author: listState.author } : {}),
      ...(normalizeSource(listState.source) !== DEFAULT_SOURCE ? { source: normalizeSource(listState.source) } : {}),
      ...(normalizeSort(listState.sort) !== DEFAULT_SORT ? { sort: normalizeSort(listState.sort) } : {})
    };
  }

  function stopPanelMedia(root) {
    for (const media of root?.querySelectorAll?.("video") || []) {
      media.pause?.();
      media.removeAttribute("src");
      media.load?.();
    }
  }

  function activeReelStack() {
    return els.viewContent?.querySelector?.(".short-video-mobile-reel-stack") || null;
  }

  function isHorizontalSwipe(deltaX, deltaY, threshold) {
    return Math.abs(deltaX) >= threshold && Math.abs(deltaX) > Math.abs(deltaY) * 1.25;
  }

  function handleHorizontalSwipe(deltaX) {
    if (deltaX > 0) {
      if (restoreAuthorReturnPanel()) return;
      goBack();
      return;
    }
    if (isViewingAuthorFeed()) {
      shortVideoToast("已在作者页，右滑返回");
      return;
    }
    showAuthorPanel(browserState.video);
  }

  function isViewingAuthorFeed() {
    return Boolean(listState.author && listState.author !== "all");
  }

  function startSystemInfoUpdates() {
    stopSystemInfoUpdates();
    updateSystemInfo({ force: true });
    browserState.systemInfoTimer = window.setInterval(() => updateSystemInfo(), 30000);
  }

  function stopSystemInfoUpdates() {
    if (!browserState.systemInfoTimer) return;
    window.clearInterval(browserState.systemInfoTimer);
    browserState.systemInfoTimer = null;
  }

  async function updateSystemInfo(options = {}) {
    if (!options.force && !isBrowserView()) {
      stopSystemInfoUpdates();
      return;
    }

    browserState.systemInfoText = formatSystemStatusText();
    updateSystemInfoNode();

    const nativeInfo = await readNativeStatusInfo();
    if (nativeInfo) {
      browserState.systemInfoText = formatSystemStatusText(nativeInfo);
      updateSystemInfoNode();
      return;
    }

    const batteryInfo = await readWebBatteryInfo();
    if (batteryInfo) {
      browserState.systemInfoText = formatSystemStatusText(batteryInfo);
      updateSystemInfoNode();
    }
  }

  async function readNativeStatusInfo() {
    const plugin = systemPlugin();
    if (!plugin?.getStatusInfo) return null;
    try {
      return await plugin.getStatusInfo();
    } catch {
      return null;
    }
  }

  async function readWebBatteryInfo() {
    if (!navigator.getBattery) return null;
    try {
      const battery = await navigator.getBattery();
      return {
        battery: Math.round(Number(battery.level || 0) * 100),
        charging: Boolean(battery.charging)
      };
    } catch {
      return null;
    }
  }

  function updateSystemInfoNode() {
    const node = els.viewContent?.querySelector?.("[data-short-video-system-info]");
    if (node) node.textContent = browserState.systemInfoText || formatSystemStatusText();
  }

  function formatSystemStatusText(info = {}) {
    const localTime = formatLocalShortTime();
    const time = String(info.time || localTime).trim() || localTime;
    const battery = Number(info.battery);
    const parts = [time];
    if (Number.isFinite(battery) && battery >= 0) {
      parts.push(`电量 ${Math.round(battery)}%`);
    }
    if (info.charging) parts.push("充电");
    return parts.join("  ");
  }

  function formatLocalShortTime() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const date = String(now.getDate()).padStart(2, "0");
    const hour = String(now.getHours()).padStart(2, "0");
    const minute = String(now.getMinutes()).padStart(2, "0");
    return `${month}/${date} ${hour}:${minute}`;
  }

  function applyDragDelta(deltaY) {
    const hasTarget = deltaY < 0 ? Boolean(browserState.nextId) : Boolean(browserState.prevId);
    const damped = hasTarget ? deltaY : deltaY * 0.22;
    activeReelStack()?.style.setProperty("--short-video-mobile-drag-y", `${damped}px`);
  }

  function finishDrag(deltaY) {
    const direction = deltaY < 0 ? 1 : -1;
    browserState.dragging = false;
    activeReelStack()?.classList.remove("is-dragging");
    if (Math.abs(deltaY) < 78 || (direction > 0 && !browserState.nextId) || (direction < 0 && !browserState.prevId)) {
      snapStackBack();
      return;
    }
    openAdjacent(direction).catch(() => {});
  }

  function snapStackBack() {
    const stack = activeReelStack();
    if (!stack) return;
    stack.classList.remove("is-dragging", "is-snap-next", "is-snap-prev");
    stack.style.setProperty("--short-video-mobile-drag-y", "0px");
  }

  function animateActiveStack(direction) {
    const stack = activeReelStack();
    if (!stack) return Promise.resolve();
    stack.classList.remove("is-dragging", "is-snap-next", "is-snap-prev");
    stack.style.setProperty("--short-video-mobile-drag-y", "0px");
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      stack.addEventListener("transitionend", finish, { once: true });
      window.setTimeout(finish, 380);
      requestAnimationFrame(() => {
        stack.classList.add(direction > 0 ? "is-snap-next" : "is-snap-prev");
      });
    });
  }

  function handleStageClick(video, panel, singleTapAction) {
    const key = likedVideoKey(video);
    const now = Date.now();
    if (browserState.stageTapTimer && key && browserState.lastStageTapKey === key && now - browserState.lastStageTapAt <= 300) {
      window.clearTimeout(browserState.stageTapTimer);
      browserState.stageTapTimer = null;
      browserState.lastStageTapAt = 0;
      browserState.lastStageTapKey = "";
      likeWebVideo(video, panel);
      return;
    }
    if (browserState.stageTapTimer) window.clearTimeout(browserState.stageTapTimer);
    browserState.lastStageTapAt = now;
    browserState.lastStageTapKey = key;
    browserState.stageTapTimer = window.setTimeout(() => {
      browserState.stageTapTimer = null;
      browserState.lastStageTapAt = 0;
      browserState.lastStageTapKey = "";
      singleTapAction?.();
    }, 260);
  }

  function bindStageLongPress(stage, video) {
    stage.addEventListener("touchstart", (event) => {
      if (event.touches?.length !== 1) return;
      clearStageLongPress();
      const touch = event.touches[0];
      browserState.stageLongPressStartX = touch.clientX;
      browserState.stageLongPressStartY = touch.clientY;
      browserState.stageLongPressTimer = window.setTimeout(() => {
        browserState.stageLongPressTimer = null;
        browserState.stageLongPressTriggered = true;
        try {
          navigator.vibrate?.(12);
        } catch {}
        clearStageTapTimer();
        showPlaybackToolbar(video);
        window.setTimeout(() => {
          browserState.stageLongPressTriggered = false;
        }, 520);
      }, 560);
    }, { passive: true });
    stage.addEventListener("touchmove", (event) => {
      if (!browserState.stageLongPressTimer || event.touches?.length !== 1) return;
      const touch = event.touches[0];
      const dx = touch.clientX - browserState.stageLongPressStartX;
      const dy = touch.clientY - browserState.stageLongPressStartY;
      if (Math.hypot(dx, dy) > 16) clearStageLongPress();
    }, { passive: true });
    stage.addEventListener("touchend", clearStageLongPress, { passive: true });
    stage.addEventListener("touchcancel", clearStageLongPress, { passive: true });
    stage.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      clearStageTapTimer();
      showPlaybackToolbar(video);
    });
  }

  function clearStageLongPress() {
    if (browserState.stageLongPressTimer) window.clearTimeout(browserState.stageLongPressTimer);
    browserState.stageLongPressTimer = null;
  }

  function consumeStageLongPressClick(event) {
    if (!browserState.stageLongPressTriggered) return false;
    browserState.stageLongPressTriggered = false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  function clearStageTapTimer() {
    if (browserState.stageTapTimer) window.clearTimeout(browserState.stageTapTimer);
    browserState.stageTapTimer = null;
    browserState.lastStageTapAt = 0;
    browserState.lastStageTapKey = "";
  }

  function railMetric(icon, value, kind = "", label = "", action = null, active = false) {
    const button = railButton(formatCompact(value || 0), createIcon(icon), kind, label, action);
    button.classList.toggle("active", Boolean(active));
    return button;
  }

  function railNav(direction, action, disabled) {
    const button = railButton("", createIcon(direction === "up" ? "chevronUp" : "chevronDown"), "nav", direction === "up" ? "上一个" : "下一个", action);
    button.disabled = disabled;
    return button;
  }

  function authorRailButton(video, action = null) {
    const avatar = document.createElement("span");
    avatar.className = "short-video-mobile-author-avatar";
    if (video.author?.avatarUrl) {
      const img = document.createElement("img");
      img.src = video.author.avatarUrl;
      img.alt = video.author?.name || "作者";
      avatar.append(img);
    } else {
      avatar.textContent = initials(video.author?.name || "?");
    }
    return railButton("", avatar, "author", video.author?.name ? `作者 ${video.author.name}` : "作者", action);
  }

  function railButton(label, icon, kind = "", ariaLabel = "", action = null) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `short-video-mobile-rail-button${kind ? ` is-${kind}` : ""}`;
    if (!label) button.classList.add("is-icon-only");
    button.setAttribute("aria-label", ariaLabel || label || kind || "操作");
    if (ariaLabel) button.title = ariaLabel;
    const strong = document.createElement("strong");
    if (icon instanceof Node) strong.append(icon);
    else strong.textContent = icon;
    button.append(strong);
    if (label) {
      const span = document.createElement("span");
      span.textContent = label;
      button.append(span);
    }
    if (action) button.addEventListener("click", action);
    return button;
  }

  function likedVideoKey(video = {}) {
    const id = String(video.id || "").trim();
    if (id) return id;
    const awemeId = String(video.awemeId || "").trim();
    return awemeId ? `aweme:${awemeId}` : "";
  }

  function isWebLiked(video) {
    const key = likedVideoKey(video);
    return Boolean(key && browserState.likedVideoKeys.has(key));
  }

  function displayWebLikes(video) {
    return Number(video?.stats?.likes || 0) + (isWebLiked(video) ? 1 : 0);
  }

  function likeWebVideo(video, panel = null, button = null) {
    const key = likedVideoKey(video);
    if (!key) {
      shortVideoToast("这条视频暂时不能点赞");
      return;
    }
    if (browserState.likedVideoKeys.has(key)) {
      shortVideoToast("已点过赞");
    } else {
      browserState.likedVideoKeys.add(key);
      shortVideoToast("已点赞");
      showWebLikeBurst(panel);
    }
    updateWebLikeButton(panel, video, button);
  }

  function updateWebLikeButton(panel, video, button = null) {
    const target = button || panel?.querySelector?.(".short-video-mobile-rail-button.is-like");
    if (!target) return;
    target.classList.toggle("active", isWebLiked(video));
    const label = Array.from(target.children || []).find((node) => node.tagName === "SPAN");
    if (label) label.textContent = formatCompact(displayWebLikes(video));
  }

  function showWebLikeBurst(panel) {
    if (!panel) return;
    const existing = panel.querySelector(".short-video-mobile-like-burst");
    if (existing) existing.remove();
    const burst = document.createElement("div");
    burst.className = "short-video-mobile-like-burst";
    burst.textContent = "♥";
    panel.append(burst);
    window.setTimeout(() => burst.remove(), 720);
  }

  let authorPanelEl = null;
  let authorPanelLoadObserver = null;
  let authorPanelPausedPlayer = null;
  let authorPanelResumeOnClose = false;
  let playbackToolbarEl = null;
  let playbackActionsEl = null;

  function closePlaybackToolbar() {
    if (!playbackToolbarEl) return;
    playbackToolbarEl.remove();
    playbackToolbarEl = null;
  }

  function showPlaybackToolbar(video) {
    closePlaybackToolbar();
    closePlaybackActions();
    const overlay = document.createElement("div");
    overlay.className = "short-video-mobile-toolbar-panel";
    ["touchstart", "touchmove", "touchend", "wheel", "click"].forEach((ev) =>
      overlay.addEventListener(ev, (event) => event.stopPropagation(), { passive: false })
    );
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closePlaybackToolbar();
    });

    const sheet = document.createElement("div");
    sheet.className = "short-video-mobile-toolbar-sheet";
    const handle = document.createElement("div");
    handle.className = "short-video-mobile-toolbar-handle";
    const row = document.createElement("div");
    row.className = "short-video-mobile-toolbar-row";
    row.append(
      playbackToolbarButton(browserState.muted ? "开声" : "静音", browserState.muted ? "当前静音" : "当前有声", browserState.muted, () => {
        closePlaybackToolbar();
        toggleWebMuted();
      }),
      playbackToolbarButton(browserState.autoNext ? "连播" : "循环", browserState.autoNext ? "自动下一条" : "单条循环", browserState.autoNext, () => {
        closePlaybackToolbar();
        toggleWebAutoNext();
      }),
      playbackToolbarButton(browserState.controlsHidden ? "显示" : "清屏", browserState.controlsHidden ? "恢复控件" : "隐藏控件", browserState.controlsHidden, () => {
        closePlaybackToolbar();
        toggleWebControlsHidden();
      }),
      playbackToolbarButton("更多", "分享/排序/抖音", false, () => {
        closePlaybackToolbar();
        showPlaybackActions(video);
      })
    );
    sheet.append(handle, row);
    overlay.append(sheet);
    document.body.append(overlay);
    playbackToolbarEl = overlay;
  }

  function playbackToolbarButton(title, subtitle, active, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "short-video-mobile-toolbar-button";
    button.classList.toggle("active", Boolean(active));
    button.innerHTML = `<strong></strong><span></span>`;
    button.querySelector("strong").textContent = title;
    button.querySelector("span").textContent = subtitle;
    button.addEventListener("click", action);
    return button;
  }

  function activeWebPlayer() {
    return activeReelStack()?.querySelector?.(".short-video-mobile-reel-panel.is-current video.short-video-mobile-player") || null;
  }

  function applyWebPlaybackPrefs(player = activeWebPlayer()) {
    if (!player) return;
    player.muted = browserState.muted;
    player.defaultMuted = browserState.muted;
    player.loop = !browserState.autoNext;
  }

  function toggleWebMuted() {
    browserState.muted = !browserState.muted;
    applyWebPlaybackPrefs();
    shortVideoToast(browserState.muted ? "已静音" : "已开声");
  }

  function toggleWebAutoNext() {
    browserState.autoNext = !browserState.autoNext;
    applyWebPlaybackPrefs();
    shortVideoToast(browserState.autoNext ? "已开启连播" : "已切回单条循环");
  }

  function toggleWebControlsHidden() {
    browserState.controlsHidden = !browserState.controlsHidden;
    applyWebControlVisibility();
    shortVideoToast(browserState.controlsHidden ? "已清屏，长按恢复工具栏" : "已显示控件");
  }

  function applyWebControlVisibility() {
    els.viewContent?.querySelector?.(".short-video-mobile-browser")?.classList.toggle("is-controls-hidden", browserState.controlsHidden);
  }

  function closePlaybackActions() {
    if (!playbackActionsEl) return;
    playbackActionsEl.remove();
    playbackActionsEl = null;
  }

  function showPlaybackActions(video) {
    closePlaybackToolbar();
    closePlaybackActions();
    const overlay = document.createElement("div");
    overlay.className = "short-video-mobile-actions-panel";
    ["touchstart", "touchmove", "touchend", "wheel", "click"].forEach((ev) =>
      overlay.addEventListener(ev, (event) => event.stopPropagation(), { passive: false })
    );
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closePlaybackActions();
    });

    const sheet = document.createElement("div");
    sheet.className = "short-video-mobile-actions-sheet";
    const head = document.createElement("div");
    head.className = "short-video-mobile-actions-head";
    const title = document.createElement("strong");
    title.textContent = "更多";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "short-video-mobile-actions-close";
    close.setAttribute("aria-label", "关闭");
    close.textContent = "×";
    close.addEventListener("click", closePlaybackActions);
    head.append(title, close);

    const sortGrid = document.createElement("div");
    sortGrid.className = "short-video-mobile-actions-sort";
    for (const [value, label] of SHORT_VIDEO_SORT_OPTIONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "short-video-mobile-actions-sort-button";
      button.classList.toggle("active", normalizeSort(listState.sort) === value);
      button.textContent = label;
      button.addEventListener("click", () => applyPlaybackSort(value).catch((error) => {
        shortVideoToast(shortVideoErrorMessage(error, "排序失败，请稍后重试"));
      }));
      sortGrid.append(button);
    }

    const actions = document.createElement("div");
    actions.className = "short-video-mobile-actions-list";
    actions.append(
      playbackActionButton("分享短视频", () => shareShortVideo(video)),
      playbackActionButton("打开抖音原视频", () => openDouyinLink(video)),
      playbackActionButton("查看作者主页", () => {
        closePlaybackActions();
        showAuthorPanel(video);
      })
    );

    sheet.append(head, sortGrid, actions);
    overlay.append(sheet);
    document.body.append(overlay);
    playbackActionsEl = overlay;
  }

  function playbackActionButton(label, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "short-video-mobile-actions-button";
    button.textContent = label;
    button.addEventListener("click", () => {
      closePlaybackActions();
      action?.();
    });
    return button;
  }

  async function applyPlaybackSort(value) {
    const nextSort = normalizeSort(value);
    closePlaybackActions();
    if (normalizeSort(listState.sort) === nextSort) {
      shortVideoToast(`已是${shortVideoSortLabel(nextSort)}`);
      return;
    }
    browserState.locked = true;
    listState.sort = nextSort;
    if (browserState.authorReturnPanel) browserState.authorReturnPanel.sort = nextSort;
    stopPanelMedia(activeReelStack());
    browserState.loading = true;
    browserState.video = null;
    browserState.prevId = "";
    browserState.nextId = "";
    browserState.prevVideo = null;
    browserState.nextVideo = null;
    renderBrowserShell();
    try {
      const params = new URLSearchParams();
      if (listState.query) params.set("q", listState.query);
      if (listState.author && listState.author !== "all") params.set("author", listState.author);
      params.set("source", shortVideoApiSource());
      params.set("sort", nextSort);
      params.set("limit", String(DEFAULT_LIMIT));
      const data = await fetchJson(getActiveUrl(), `/api/short-videos?${params}`, { timeoutMs: 16000 });
      listState.data = data;
      listState.source = normalizeSource(data.source || listState.source);
      listState.loading = false;
      listState.loadingMore = false;
      const first = data.videos?.[0];
      if (!first) throw new Error("当前排序没有可播放作品");
      shortVideoToast(`已按${shortVideoSortLabel(nextSort)}排序`);
      await openShortVideoFromList(first, { replace: true, skipNative: true });
    } catch (error) {
      browserState.loading = false;
      renderBrowserError(error);
      throw error;
    } finally {
      browserState.locked = false;
    }
  }

  function closeAuthorPanel(options = {}) {
    if (!authorPanelEl) return;
    authorPanelLoadObserver?.disconnect?.();
    authorPanelLoadObserver = null;
    authorPanelEl.remove();
    authorPanelEl = null;
    const shouldResume = options.resume !== false && authorPanelResumeOnClose;
    const player = authorPanelPausedPlayer;
    authorPanelPausedPlayer = null;
    authorPanelResumeOnClose = false;
    if (shouldResume && player?.isConnected) {
      requestAnimationFrame(() => {
        const promise = player.play?.();
        promise?.catch?.(() => {});
      });
    }
  }

  function pauseActiveVideoForAuthorPanel() {
    authorPanelPausedPlayer = null;
    authorPanelResumeOnClose = false;
    const player = activeReelStack()?.querySelector?.(".short-video-mobile-reel-panel.is-current video.short-video-mobile-player");
    if (!player) return;
    authorPanelPausedPlayer = player;
    authorPanelResumeOnClose = !player.paused && !player.ended;
    if (authorPanelResumeOnClose) player.pause?.();
  }

  function shortVideoToast(message) {
    const existing = document.querySelector(".short-video-mobile-toast");
    if (existing) existing.remove();
    const toast = document.createElement("div");
    toast.className = "short-video-mobile-toast";
    toast.textContent = message;
    document.body.append(toast);
    window.setTimeout(() => toast.remove(), 2200);
  }

  async function viewAuthorVideos(secUid, sort = DEFAULT_SORT) {
    if (!secUid) return;
    closeAuthorPanel({ resume: false });
    const stack = activeReelStack();
    if (stack) stopPanelMedia(stack);
    showView("shortVideos", { query: "", author: secUid, source: "all", sort: sort || DEFAULT_SORT }, { push: true });
  }

  function showAuthorPanel(video, options = {}) {
    const secUid = String(video?.secUid || video?.author?.secUid || "").trim();
    const authorName = String(video?.author?.name || "").trim();
    const authorFilter = String(video?.authorFilter || secUid || (authorName ? `name:${authorName}` : "")).trim();
    if (!authorFilter) {
      shortVideoToast("该视频没有可识别的作者信息");
      return;
    }
    closeAuthorPanel({ resume: false });
    pauseActiveVideoForAuthorPanel();
    const snapshotFilter = String(options.snapshot?.authorFilter || options.snapshot?.author?.secUid || "").trim();
    const restoreSnapshot = snapshotFilter === authorFilter ? options.snapshot : null;
    const author = { ...(video?.author || {}), ...(restoreSnapshot?.author || {}), secUid };
    const name = author.name || "未知作者";
    const avatarUrl = author.avatarUrl || "";
    const panelState = {
      author,
      authorFilter,
      videos: Array.isArray(restoreSnapshot?.videos) ? restoreSnapshot.videos.map(cloneShortVideo) : [],
      total: Math.max(0, Number(restoreSnapshot?.total || 0), Array.isArray(restoreSnapshot?.videos) ? restoreSnapshot.videos.length : 0),
      hasMore: Boolean(restoreSnapshot?.hasMore),
      offset: Math.max(0, Number(restoreSnapshot?.offset || 0)),
      loading: false,
      sort: normalizeSort(restoreSnapshot?.sort || options.sort || listState.sort || DEFAULT_SORT)
    };
    if (panelState.videos.length && !panelState.total) panelState.total = panelState.videos.length;

    const overlay = document.createElement("div");
    overlay.className = "short-video-mobile-author-panel";
    ["touchstart", "touchmove", "touchend", "wheel", "click"].forEach((ev) =>
      overlay.addEventListener(ev, (event) => event.stopPropagation(), { passive: false })
    );
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeAuthorPanel();
    });
    let panelTouchStartX = 0;
    let panelTouchStartY = 0;
    let panelTouchDeltaX = 0;
    let panelTouchDeltaY = 0;
    overlay.addEventListener("touchstart", (event) => {
      const touch = event.touches?.[0];
      panelTouchStartX = touch?.clientX || 0;
      panelTouchStartY = touch?.clientY || 0;
      panelTouchDeltaX = 0;
      panelTouchDeltaY = 0;
    }, { passive: true });
    overlay.addEventListener("touchmove", (event) => {
      const touch = event.touches?.[0];
      panelTouchDeltaX = (touch?.clientX || 0) - panelTouchStartX;
      panelTouchDeltaY = (touch?.clientY || 0) - panelTouchStartY;
      if (isHorizontalSwipe(panelTouchDeltaX, panelTouchDeltaY, 28)) event.preventDefault();
    }, { passive: false });
    overlay.addEventListener("touchend", () => {
      if (isHorizontalSwipe(panelTouchDeltaX, panelTouchDeltaY, 72) && panelTouchDeltaX > 0) closeAuthorPanel();
      panelTouchDeltaX = 0;
      panelTouchDeltaY = 0;
    });

    const sheet = document.createElement("div");
    sheet.className = "author-sheet";

    const header = document.createElement("div");
    header.className = "author-sheet-header";
    const avatar = document.createElement("span");
    avatar.className = "short-video-mobile-author-avatar author-sheet-avatar";
    if (avatarUrl) {
      const img = document.createElement("img");
      img.src = avatarUrl;
      img.alt = name;
      avatar.append(img);
    } else {
      avatar.textContent = initials(name || "?");
    }
    const info = document.createElement("div");
    info.className = "author-sheet-info";
    const nameEl = document.createElement("strong");
    nameEl.textContent = `@${name}`;
    const handle = document.createElement("span");
    handle.textContent = authorProfileLineText(author) || (secUid ? `抖音号 ${secUid}` : "本地作者资料");
    const signature = document.createElement("span");
    signature.className = "author-sheet-signature";
    signature.textContent = String(author.signature || "").trim();
    signature.hidden = !signature.textContent;
    const stats = document.createElement("div");
    stats.className = "author-sheet-stats";
    renderAuthorStats(stats, author);
    info.append(nameEl, handle, signature, stats);
    header.append(avatar, info);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "author-sheet-close";
    closeBtn.setAttribute("aria-label", "关闭");
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => closeAuthorPanel());

    const actions = document.createElement("div");
    actions.className = "author-sheet-actions";
    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "author-sheet-action is-primary";
    allBtn.textContent = "只看 TA";
    allBtn.addEventListener("click", () => viewAuthorVideos(authorFilter, panelState.sort));
    const douyinBtn = document.createElement("button");
    douyinBtn.type = "button";
    douyinBtn.className = "author-sheet-action";
    douyinBtn.textContent = "抖音主页";
    douyinBtn.disabled = !authorDouyinUrl(author);
    douyinBtn.addEventListener("click", () => openAuthorDouyinLink(author));
    actions.append(allBtn, douyinBtn);

    const controls = document.createElement("div");
    controls.className = "author-sheet-controls";
    const sortSelect = document.createElement("select");
    sortSelect.setAttribute("aria-label", "作者作品排序");
    for (const item of SHORT_VIDEO_SORT_OPTIONS) sortSelect.append(selectOption(item[0], item[1]));
    sortSelect.value = panelState.sort;
    controls.append(sortSelect);

    const content = document.createElement("div");
    content.className = "author-sheet-content";
    const status = document.createElement("div");
    status.className = "author-sheet-status";
    status.textContent = "正在读取作品";
    const grid = document.createElement("div");
    grid.className = "author-sheet-grid";
    const sentinel = document.createElement("div");
    sentinel.className = "author-sheet-load-more";
    sentinel.setAttribute("aria-hidden", "true");
    content.append(status, grid, sentinel);

    const refreshHeader = () => {
      const richer = panelState.videos.find((item) => authorHasProfileMeta(item.author))?.author || panelState.videos[0]?.author;
      if (richer) Object.assign(author, richer, { secUid });
      nameEl.textContent = `@${author.name || name}`;
      handle.textContent = authorProfileLineText(author) || (secUid ? `抖音号 ${secUid}` : "本地作者资料");
      signature.textContent = String(author.signature || "").trim();
      signature.hidden = !signature.textContent;
      renderAuthorStats(stats, author);
      douyinBtn.disabled = !authorDouyinUrl(author);
    };

    const renderWorks = () => {
      refreshHeader();
      grid.textContent = "";
      for (const item of panelState.videos) {
        grid.append(renderAuthorVideoTile(item, panelState, video));
      }
      status.textContent = panelState.loading
        ? "正在读取作品"
        : panelState.total
          ? `${formatAuthorNumber(panelState.videos.length)} / ${formatAuthorNumber(panelState.total)} 个作品`
          : "没有本地作品";
      sentinel.hidden = !panelState.hasMore;
    };

    const loadAuthorPage = async (options = {}) => {
      if (panelState.loading) return;
      if (options.append && !panelState.hasMore) return;
      panelState.loading = true;
      renderWorks();
      try {
        const params = new URLSearchParams();
        params.set("author", authorFilter);
        params.set("source", "all");
        params.set("sort", panelState.sort || DEFAULT_SORT);
        params.set("limit", String(AUTHOR_PAGE_LIMIT));
        params.set("facets", "0");
        if (options.append) params.set("offset", String(panelState.videos.length));
        const data = await fetchJson(getActiveUrl(), `/api/short-videos?${params}`, { timeoutMs: 16000 });
        const incoming = data.videos || [];
        if (options.append) {
          const seen = new Set(panelState.videos.map((item) => item.id));
          for (const item of incoming) {
            if (seen.has(item.id)) continue;
            seen.add(item.id);
            panelState.videos.push(item);
          }
        } else {
          panelState.videos = incoming;
        }
        panelState.total = Number(data.total || panelState.videos.length || 0);
        panelState.hasMore = Boolean(data.hasMore);
        panelState.offset = panelState.videos.length;
        panelState.loading = false;
        renderWorks();
      } catch (error) {
        panelState.loading = false;
        status.textContent = shortVideoErrorMessage(error, "作者作品读取失败，请稍后重试");
      }
    };

    sortSelect.addEventListener("change", () => {
      panelState.sort = normalizeSort(sortSelect.value);
      panelState.videos = [];
      panelState.total = 0;
      panelState.hasMore = false;
      panelState.offset = 0;
      loadAuthorPage().catch(() => {});
    });

    sheet.append(header, closeBtn, actions, controls, content);
    overlay.append(sheet);
    document.body.append(overlay);
    authorPanelEl = overlay;
    observeAuthorLoadMore(sentinel, sheet, () => loadAuthorPage({ append: true }));
    if (panelState.videos.length) {
      renderWorks();
      restoreAuthorPanelScroll(sheet, restoreSnapshot?.scrollTop);
    } else {
      loadAuthorPage().catch(() => {});
    }
  }

  function observeAuthorLoadMore(sentinel, root, loadMore) {
    authorPanelLoadObserver?.disconnect?.();
    authorPanelLoadObserver = null;
    if (!sentinel || !("IntersectionObserver" in window)) return;
    authorPanelLoadObserver = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      loadMore().catch(() => {});
    }, { root, rootMargin: "520px 0px", threshold: 0.01 });
    authorPanelLoadObserver.observe(sentinel);
  }

  function renderAuthorVideoTile(video, panelState, currentVideo) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "author-sheet-tile";
    const current = isSameShortVideo(video, currentVideo);
    button.classList.toggle("is-current", current);
    button.setAttribute("aria-label", video.title || "打开短视频");
    if (current) button.setAttribute("aria-current", "true");

    const media = document.createElement("span");
    media.className = "author-sheet-tile-media";
    const coverUrl = video.coverUrl || "";
    if (coverUrl) {
      const placeholder = document.createElement("span");
      placeholder.textContent = "PLAY";
      media.append(placeholder);
      loadPreviewImage(placeholder, absoluteUrl(getActiveUrl(), coverUrl), {
        cacheBaseUrl: getActiveUrl(),
        decorate: (img) => {
          img.alt = video.title || "短视频封面";
        }
      }).catch(() => {});
    } else {
      const firstFrameUrl = cachedFirstFrameUrl(video);
      if (firstFrameUrl) {
        const img = document.createElement("img");
        img.src = firstFrameUrl;
        img.alt = video.title || "短视频第一帧";
        img.dataset.shortVideoFrameId = video.id || "";
        media.append(img);
      } else {
        const placeholder = document.createElement("span");
        placeholder.dataset.shortVideoFrameId = video.id || "";
        placeholder.textContent = "PLAY";
        media.append(placeholder);
        if (video.streamUrl) requestVideoFirstFrame(video).catch(() => {});
      }
    }

    const badge = document.createElement("span");
    badge.className = "author-sheet-tile-badge";
    badge.textContent = formatCompact(video.stats?.likes || 0);
    media.append(badge);
    if (current) {
      const now = document.createElement("span");
      now.className = "author-sheet-current";
      now.textContent = "当前";
      media.append(now);
    }

    const title = document.createElement("span");
    title.className = "author-sheet-tile-title";
    title.textContent = video.title || formatDate(video.publishedAt) || "未命名视频";
    button.append(media, title);
    bindReliableTap(button, () => openAuthorPanelVideo(video, panelState, current));
    return button;
  }

  function openAuthorPanelVideo(video, panelState, current) {
    if (current) {
      shortVideoToast("正在观看这条");
      return;
    }
    const secUid = panelState.author?.secUid || video.author?.secUid || "";
    const authorFilter = panelState.authorFilter || secUid || shortVideoAuthorFilterValue(video.author || {});
    const sheet = authorPanelEl?.querySelector?.(".author-sheet");
    const videosSnapshot = panelState.videos.map(cloneShortVideo);
    browserState.authorReturnPanel = {
      author: { ...(panelState.author || {}), secUid },
      authorFilter,
      sort: panelState.sort || DEFAULT_SORT,
      videos: videosSnapshot,
      total: panelState.total || videosSnapshot.length,
      hasMore: panelState.hasMore,
      offset: panelState.offset || videosSnapshot.length,
      scrollTop: Math.max(0, Number(sheet?.scrollTop || 0)),
      currentId: video.id || video.awemeId || ""
    };
    listState.query = "";
    listState.author = authorFilter || "all";
    listState.source = "all";
    listState.sort = panelState.sort || DEFAULT_SORT;
    listState.data = {
      videos: videosSnapshot,
      total: panelState.total || panelState.videos.length,
      limit: videosSnapshot.length,
      offset: 0,
      hasMore: panelState.hasMore,
      author: listState.author,
      source: "all",
      sort: listState.sort,
      authors: listState.data?.authors || []
    };
    closeAuthorPanel({ resume: false });
    const stack = activeReelStack();
    if (stack) stopPanelMedia(stack);
    openShortVideoFromList(video, { replace: true, skipNative: true }).catch((error) => {
      shortVideoToast(shortVideoErrorMessage(error, "视频打开失败"));
    });
  }

  function restoreAuthorReturnPanel() {
    const snapshot = browserState.authorReturnPanel;
    const authorFilter = String(snapshot?.authorFilter || snapshot?.author?.secUid || "").trim();
    if (!authorFilter) return false;
    browserState.authorReturnPanel = null;
    const current = browserState.video || {};
    const video = {
      ...current,
      authorFilter,
      author: {
        ...(current.author || {}),
        ...snapshot.author,
        secUid: snapshot.author.secUid || ""
      }
    };
    showAuthorPanel(video, { sort: snapshot.sort, snapshot });
    return true;
  }

  function restoreAuthorPanelScroll(sheet, value) {
    const scrollTop = Math.max(0, Number(value || 0));
    if (!sheet || !scrollTop) return;
    requestAnimationFrame(() => {
      sheet.scrollTop = scrollTop;
    });
  }

  function cloneShortVideo(video = {}) {
    return {
      ...video,
      author: { ...(video.author || {}) },
      stats: { ...(video.stats || {}) }
    };
  }

  function isSameShortVideo(a = {}, b = {}) {
    const idA = String(a?.id || "").trim();
    const idB = String(b?.id || "").trim();
    if (idA && idB && idA === idB) return true;
    const awemeA = String(a?.awemeId || "").trim();
    const awemeB = String(b?.awemeId || "").trim();
    return Boolean(awemeA && awemeB && awemeA === awemeB);
  }

  function authorProfileLineText(author = {}) {
    const parts = [];
    const douyinId = String(author.shortId || author.uniqueId || "").trim();
    if (douyinId) parts.push(`抖音号 ${douyinId}`);
    const ip = String(author.ipLocation || "").trim().replace(/^IP属地[:：]?\s*/u, "");
    if (ip) parts.push(`IP ${ip}`);
    const verification = String(author.verification || "").trim();
    if (verification) parts.push(verification);
    if (!parts.length && author.secUid) parts.push(`抖音号 ${author.secUid}`);
    return parts.join(" · ");
  }

  function authorHasProfileMeta(author = {}) {
    return Boolean(authorProfileLineText(author) || String(author.signature || "").trim() || authorStatItems(author).length);
  }

  function authorStatItems(author = {}) {
    return [
      ["关注", authorProfileNumber(author.followingCount)],
      ["粉丝", authorProfileNumber(author.followerCount)],
      ["获赞", authorProfileNumber(author.totalFavorited)],
      ["作品", authorProfileNumber(author.awemeCount)]
    ].filter((item) => item[1] !== null);
  }

  function renderAuthorStats(target, author = {}) {
    target.textContent = "";
    const items = authorStatItems(author);
    target.hidden = !items.length;
    for (const [label, value] of items) {
      const cell = document.createElement("span");
      const strong = document.createElement("b");
      strong.textContent = formatCompact(value);
      const small = document.createElement("small");
      small.textContent = label;
      cell.append(strong, small);
      target.append(cell);
    }
  }

  function authorProfileNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
  }

  function formatAuthorNumber(value) {
    const number = Number(value || 0);
    return Number.isFinite(number) ? number.toLocaleString("zh-CN") : "0";
  }

  function authorDouyinUrl(author = {}) {
    const url = String(author.profileUrl || "").trim();
    if (url) return url;
    const secUid = String(author.secUid || "").trim();
    return secUid ? `https://www.douyin.com/user/${encodeURIComponent(secUid)}` : "";
  }

  function openAuthorDouyinLink(author = {}) {
    const url = authorDouyinUrl(author);
    if (url) window.open(url, "_system");
  }

  function toggleRailActive(event) {
    const button = event?.currentTarget;
    if (!button) return;
    button.classList.toggle("active");
  }

  async function shareShortVideo(video) {
    const url = video.shareUrl || absoluteUrl(getActiveUrl(), video.streamUrl);
    const title = video.title || "短视频";
    if (navigator.share) {
      try {
        await navigator.share({ title, text: title, url });
        return;
      } catch {}
    }
    try {
      await navigator.clipboard?.writeText?.(url);
    } catch {}
  }

  function openDouyinLink(video) {
    const url = String(video.shareUrl || "").trim();
    if (!url) return openNativeShortVideo(video);
    window.open(url, "_system");
  }

  function createNativePlayButton(video) {
    const plugin = nativePlayerPlugin();
    if (!plugin?.play || !video?.streamUrl) return null;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "short-video-mobile-native-play";
    button.textContent = "原生播放";
    button.addEventListener("click", async () => {
      const originalText = button.textContent;
      button.disabled = true;
      button.textContent = "打开中";
      try {
        const opened = await openNativeShortVideo(video);
        if (!opened) button.textContent = "打开失败";
      } finally {
        window.setTimeout(() => {
          button.disabled = false;
          button.textContent = originalText;
        }, 900);
      }
    });
    return button;
  }

  async function openNativeShortVideo(video) {
    const plugin = nativePlayerPlugin();
    if (!plugin?.play || !video?.streamUrl) return false;
    try {
      await plugin.play({
        url: absoluteUrl(getActiveUrl(), video.streamUrl),
        title: video.title || video.fileName || "短视频",
        subtitle: [video.author?.name ? `@${video.author.name}` : "", formatDate(video.publishedAt), formatDuration(video.durationMs)].filter(Boolean).join(" · "),
        mode: "short-video",
        videoId: video.id,
        position: 0,
        duration: Math.max(0, Number(video.durationMs || 0) / 1000)
      });
      return true;
    } catch {
      return false;
    }
  }

  function nativePlayerPlugin() {
    return window.Capacitor?.Plugins?.FanHaoPlayer || null;
  }

  function systemPlugin() {
    return window.Capacitor?.Plugins?.FanHaoSystem || null;
  }

  function setImmersiveMode(immersive) {
    const plugin = systemPlugin();
    if (!plugin?.setImmersive) return;
    plugin.setImmersive({ immersive: Boolean(immersive) }).catch(() => {});
  }

  function setIconButton(button, iconName, label) {
    if (!button || button.dataset.iconName === iconName) {
      if (button && label) {
        button.setAttribute("aria-label", label);
        button.title = label;
      }
      return;
    }
    button.dataset.iconName = iconName;
    button.textContent = "";
    button.append(createIcon(iconName));
    if (label) {
      button.setAttribute("aria-label", label);
      button.title = label;
    }
  }

  function createIcon(name) {
    const wrap = document.createElement("span");
    wrap.className = `short-video-mobile-icon short-video-mobile-icon-${name}`;
    wrap.innerHTML = iconMarkup(name);
    return wrap;
  }

  function iconMarkup(name) {
    const line = "fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"";
    const icons = {
      ai: `<svg viewBox="0 0 34 34" aria-hidden="true"><path d="M22.94 21.309l.58 1.364a45.819 45.819 0 0 0 2.125 4.34l.528.947-.108.056-1.077.543-.102.052-.054-.102-.576-1.087a44.077 44.077 0 0 1-.22-.423 7.704 7.704 0 0 0-3.902.001c-.087.169-.154.3-.219.422l-.576 1.087-.054.102-.102-.052-1.077-.543-.108-.056.059-.106.468-.841a45.902 45.902 0 0 0 2.125-4.34l.58-1.364.038-.086.091.017c.482.086.97.086 1.451 0l.093-.017.037.086zm6.011-.019a3.731 3.731 0 0 0-.173.9c-.022.342-.034.69-.034 1.035v3.067c0 .345.012.694.034 1.035l.022.227c.029.226.08.452.151.673l.05.153h-1.92l.049-.153c.095-.295.153-.597.173-.9.022-.345.033-.694.033-1.035v-3.067c0-.34-.01-.689-.033-1.034a3.753 3.753 0 0 0-.173-.9l-.05-.154h1.921l-.05.153zM17.161 5.395l.123.008a4.527 4.527 0 0 1 3.14 1.602 4.367 4.367 0 0 1 1.033 2.978l-.005.109c-.015.284-.063.56-.13.828l-.117.447 1.964-.504.113-.027c2.38-.549 4.824.818 5.465 3.136l.05.184a4.368 4.368 0 0 1-.534 3.265l-.06.097a4.495 4.495 0 0 1-1.965 1.674c-3.71 1.444-5.893-1.51-6.663-3.187l.134-.034 2.236-.575c.033.329.136.661.333.984a2.5 2.5 0 0 0 2.51 1.157l.113-.021a2.456 2.456 0 0 0 1.384-.825l.297-.448a2.37 2.37 0 0 0 .209-1.637l-.018-.075c-.334-1.268-1.63-2.035-2.914-1.753h-.01l-7.51 1.916h-.022a.056.056 0 0 1-.02-.01.048.048 0 0 1-.017-.037l.014-.205.136-2.238c.327.071.682.079 1.054-.008.973-.227 1.74-1.006 1.894-1.992a2.371 2.371 0 0 0-.303-1.578l-.055-.09a2.46 2.46 0 0 0-1.855-1.118l-.076-.006c-1.323-.076-2.469.897-2.596 2.188v.009l-.47 7.62a.047.047 0 0 1-.053.04l-.013-.002-.166-.065-2.15-.83c.169-.284.285-.612.316-.987l.007-.092a2.443 2.443 0 0 0-1.263-2.256l-.084-.043-.105-.048a2.482 2.482 0 0 0-1.508-.155l-.104.024a2.443 2.443 0 0 0-1.683 1.46c-.487 1.219.104 2.59 1.31 3.109l.008.003 7.22 2.797c.03.012.036.048.02.068l-.114.136-1.467 1.759a2.335 2.335 0 0 0-.79-.573l-.068-.03-.086-.034c-.873-.321-1.878-.147-2.566.484l-.069.065a2.407 2.407 0 0 0 .188 3.584 2.49 2.49 0 0 0 3.404-.268l.006-.006 3.485-4.165v3.166l-.5.607v-.004l-1.29 1.543c-1.559 1.868-4.346 2.229-6.28.782l-.092-.07a4.41 4.41 0 0 1-1.668-3.076l-.009-.113a4.384 4.384 0 0 1 1.619-3.688l.357-.297-1.892-.729c-2.323-.895-3.535-3.457-2.656-5.739a4.475 4.475 0 0 1 2.565-2.555 4.577 4.577 0 0 1 4.068.373l.393.244.12-1.995h-.001c.146-2.447 2.248-4.375 4.728-4.258zm4.679 17.909a45.987 45.987 0 0 1-.964 2.191 9.16 9.16 0 0 1 2.417 0 45.878 45.878 0 0 1-.963-2.191l-.245-.6-.245.6z" fill="#fff"/></svg>`,
      chevronLeft: `<svg viewBox="0 0 24 24" aria-hidden="true"><path ${line} d="M15 18l-6-6 6-6"/></svg>`,
      chevronDown: `<svg viewBox="0 0 24 24" aria-hidden="true"><path ${line} d="M7 10l5 5 5-5"/></svg>`,
      chevronUp: `<svg viewBox="0 0 24 24" aria-hidden="true"><path ${line} d="M7 14l5-5 5 5"/></svg>`,
      comment: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.8571 17.3202C20.8406 15.3333 22 13.2638 22 10.8541C22 5.96406 17.5232 2 12 2C6.47686 2 2 5.96406 2 10.8542C2 16.8002 8 19.2002 11.429 19.2002V20.7211C11.429 22.3041 12.3493 22.1732 13.1196 21.7347C14.586 20.9 17.4106 18.7693 18.8571 17.3202ZM8.57142 11.0778C8.57142 11.8619 7.93154 12.4971 7.1422 12.4971C6.35418 12.4971 5.71427 11.8619 5.71427 11.0778C5.71427 10.2953 6.35418 9.66007 7.1422 9.66007C7.93154 9.66007 8.57142 10.2953 8.57142 11.0778ZM12 12.4971C11.2112 12.4971 10.5715 11.8619 10.5715 11.0778C10.5715 10.2953 11.2111 9.66007 12 9.66007C12.789 9.66007 13.4286 10.2953 13.4286 11.0778C13.4286 11.8619 12.789 12.4971 12 12.4971ZM18.2857 11.0778C18.2857 11.8619 17.6467 12.4971 16.8575 12.4971C16.0683 12.4971 15.4284 11.8619 15.4285 11.0778C15.4285 10.2953 16.0683 9.66007 16.8575 9.66007C17.6467 9.66007 18.2857 10.2953 18.2857 11.0778Z"/></svg>`,
      headphones: `<svg viewBox="0 0 36 36" aria-hidden="true"><path fill="currentColor" fill-opacity=".9" d="M9.68718 12.4801C8.612 14.3927 8.1197 16.7374 8.05821 19.0767C8.23942 18.9661 8.4351 18.8725 8.64383 18.7988L9.16952 18.6132C10.7699 18.0482 12.5315 18.8701 13.1042 20.4491L15.3865 26.7417C15.9591 28.3206 15.126 30.0586 13.5257 30.6236L13 30.8092C11.4155 31.3686 9.85676 30.6485 8.86663 29.2939C8.83318 29.2583 8.80192 29.22 8.7732 29.1788C7.33136 27.1149 6.42117 24.618 6.13186 21.9841C5.75876 18.5873 6.12658 14.6403 7.8929 11.4983C9.70099 8.28189 12.9317 6 17.9885 6C23.0436 6 26.2778 8.27305 28.092 11.4819C29.8643 14.6168 30.2393 18.557 29.8725 21.9536C29.5881 24.5883 28.6825 27.0875 27.2445 29.155C27.2194 29.1911 27.1924 29.2251 27.1636 29.2569C26.1749 30.6354 24.6023 31.3737 23.0035 30.8092L22.4778 30.6236C20.8774 30.0586 20.0443 28.3206 20.617 26.7417L22.8993 20.4491C23.472 18.8701 25.2335 18.0482 26.8339 18.6132L27.3596 18.7988C27.5669 18.8719 27.7613 18.9648 27.9415 19.0744C27.8783 16.7301 27.382 14.3817 26.3001 12.468C24.846 9.89593 22.2949 8.02429 17.9885 8.02428C13.684 8.02428 11.1369 9.90129 9.68718 12.4801Z"/></svg>`,
      heart: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M2.00534 9C2.00179 8.91711 2 8.83376 2 8.75C2 5.57436 4.57436 3 7.75 3C9.43372 3 10.9484 3.72368 12 4.87696C13.0516 3.72368 14.5663 3 16.25 3C19.4256 3 22 5.57436 22 8.75C22 8.83376 21.9982 8.91711 21.9947 9H22C22 13.5738 14.6263 19.141 12.5425 20.6229C12.2133 20.8571 11.7867 20.8571 11.4575 20.6229C9.37369 19.141 2 13.5738 2 9H2.00534Z" fill="currentColor"/></svg>`,
      more: `<svg viewBox="0 0 36 36" aria-hidden="true"><path d="M13.556 17.778a1.778 1.778 0 1 1-3.556 0 1.778 1.778 0 0 1 3.556 0zM19.778 17.778a1.778 1.778 0 1 1-3.556 0 1.778 1.778 0 0 1 3.556 0zM24.222 19.556a1.778 1.778 0 1 0 0-3.556 1.778 1.778 0 0 0 0 3.556z" fill="currentColor"/></svg>`,
      pause: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="5" width="3.8" height="14" rx="1.3" fill="currentColor"/><rect x="13.2" y="5" width="3.8" height="14" rx="1.3" fill="currentColor"/></svg>`,
      play: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5.7v12.6c0 .9 1 1.4 1.8.9l9.2-6.3c.7-.5.7-1.5 0-2L9.8 4.8C9 4.3 8 4.8 8 5.7z"/></svg>`,
      share: `<svg viewBox="0 0 36 36" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M21.8839 9.41656C20.675 8.26037 18.67 9.11717 18.67 10.7899V13.186C18.5357 13.186 18.4029 13.1872 18.2714 13.1895C16.8626 13.1517 12.0185 13.3097 8.61024 16.9648C6.24883 19.4974 5.18753 23.5267 5.25283 25.606C5.19102 27.6796 6.15808 27.4932 6.41822 27.0157C9.39378 21.554 18.67 23.2251 18.67 23.2251V25.4897C18.67 27.1268 20.6019 27.9978 21.8286 26.9138L29.8176 19.855C30.6512 19.1185 30.6767 17.8265 29.8728 17.0576L21.8839 9.41656Z" fill="currentColor"/></svg>`,
      star: `<svg viewBox="0 0 36 36" aria-hidden="true"><path d="M16.5101 7.2579C17.0254 5.84046 18.9746 5.84047 19.4899 7.2579L21.8225 13.6744L28.4762 13.9734C29.946 14.0395 30.5484 15.9463 29.397 16.8884L24.1849 21.153L25.9645 27.7544C26.3577 29.2126 24.7807 30.3911 23.5538 29.5559L18 25.7751L12.4462 29.5559C11.2193 30.3911 9.64234 29.2126 10.0355 27.7544L11.8151 21.153L6.60299 16.8884C5.45162 15.9463 6.05397 14.0395 7.5238 13.9734L14.1775 13.6744L16.5101 7.2579Z" fill="currentColor"/></svg>`
    };
    return icons[name] || icons.more;
  }

  return {
    clearSearchFilters,
    getSearchState,
    renderSearchFilters,
    renderBrowser,
    renderList,
    submitSearch
  };
}

function normalizeSort(value) {
  const sort = String(value || DEFAULT_SORT).trim();
  return ["liked", "published", "publishedAsc", "likes", "likesAsc", "comments", "duration"].includes(sort) ? sort : DEFAULT_SORT;
}

function shortVideoSortLabel(value) {
  const sort = normalizeSort(value);
  const item = SHORT_VIDEO_SORT_OPTIONS.find(([key]) => key === sort);
  return item?.[1] || "时间倒序";
}

function normalizeSource(value) {
  const source = String(value || DEFAULT_SOURCE).trim().toLowerCase();
  return ["liked", "authors", "posts", "all", "local"].includes(source) ? source : DEFAULT_SOURCE;
}

function selectOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function formatDuration(ms) {
  const seconds = Math.round(Number(ms || 0) / 1000);
  if (!seconds) return "";
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  return `${minutes}:${String(remain).padStart(2, "0")}`;
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${formatDate(value)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function initials(value) {
  return String(value || "?").trim().slice(0, 2).toUpperCase();
}
