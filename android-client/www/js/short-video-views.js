import { fetchJson } from "./api.js?v=20260706-mobile-web-sync-01";
import { absoluteUrl, loadPreviewImage } from "./image.js?v=20260706-mobile-web-sync-01";
import { formatBytes, formatCompact } from "./format.js";

const DEFAULT_LIMIT = 80;
const DEFAULT_SORT = "published";

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
    sort: DEFAULT_SORT,
    loading: false,
    loadingMore: false,
    status: "",
    searchFiltersEl: null
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
    touchStartY: 0,
    touchDeltaY: 0
  };

  let eventsInstalled = false;
  let listEventsInstalled = false;
  let listLoadMoreObserver = null;
  const warmedMedia = new Set();
  const firstFrameCache = new Map();

  async function renderList(params = {}, renderGuard = null) {
    setImmersiveMode(false);
    installListEvents();
    setActiveBottom("shortVideos");
    applyListParams(params);
    els.viewKicker.textContent = "抖音点赞";
    els.viewTitle.textContent = "短视频";
    els.viewMeta.textContent = "";
    els.viewContent.className = "content-list short-video-mobile-content";
    renderListShell();
    await loadList(renderGuard, { autoOpenFirst: true, replaceOpen: true });
  }

  async function renderBrowser(videoId, renderGuard = null) {
    setImmersiveMode(true);
    installBrowserEvents();
    setActiveBottom("shortVideos");
    els.viewKicker.textContent = "短视频";
    els.viewTitle.textContent = "正在播放";
    els.viewMeta.textContent = "上滑切换";
    els.viewContent.className = "content-list short-video-mobile-content";
    await loadVideo(videoId, renderGuard);
  }

  function applyListParams(params = {}) {
    listState.query = String(params.query || params.q || "").trim();
    listState.author = String(params.author || "all").trim() || "all";
    listState.sort = normalizeSort(params.sort);
  }

  async function loadList(renderGuard = null, options = {}) {
    const append = Boolean(options.append);
    if (append && (listState.loading || listState.loadingMore || !listState.data?.hasMore)) return;
    const requestUrl = getActiveUrl();
    const params = new URLSearchParams();
    if (listState.query) params.set("q", listState.query);
    if (listState.author && listState.author !== "all") params.set("author", listState.author);
    params.set("sort", listState.sort || DEFAULT_SORT);
    params.set("limit", String(DEFAULT_LIMIT));
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

  function updateListParams(patch = {}, navigation = {}) {
    const next = {
      query: listState.query,
      author: listState.author,
      sort: listState.sort,
      ...patch
    };
    showView("shortVideos", next, { resetStack: true, skipHistory: true, replaceHistory: true, ...navigation });
  }

  function getSearchState() {
    return {
      query: listState.query || "",
      author: listState.author || "all",
      sort: listState.sort || DEFAULT_SORT,
      authors: listState.data?.authors || []
    };
  }

  function submitSearch(query = "", overrides = {}) {
    updateListParams({
      query: String(query || "").trim(),
      author: overrides.author ?? selectedSearchFilterValue("author", listState.author || "all"),
      sort: overrides.sort ?? selectedSearchFilterValue("sort", listState.sort || DEFAULT_SORT)
    });
  }

  function selectedSearchFilterValue(kind, fallback) {
    const selector = kind === "author" ? "[data-short-video-search-author]" : "[data-short-video-search-sort]";
    return listState.searchFiltersEl?.querySelector?.(selector)?.value || fallback;
  }

  function renderSearchFilters(form, onSubmit = null) {
    if (!form) return;
    const existing = form.querySelector(".short-video-search-filters");
    if (existing) existing.remove();
    const filters = document.createElement("div");
    filters.className = "short-video-search-filters";

    const author = document.createElement("select");
    author.dataset.shortVideoSearchAuthor = "1";
    author.setAttribute("aria-label", "短视频作者");
    author.append(selectOption("all", "全部作者"));
    for (const item of listState.data?.authors || []) {
      author.append(selectOption(item.secUid, `${item.name} ${formatCompact(item.count)}`));
    }
    author.value = listState.author || "all";

    const sort = document.createElement("select");
    sort.dataset.shortVideoSearchSort = "1";
    sort.setAttribute("aria-label", "短视频排序");
    for (const item of [
      ["published", "时间倒序"],
      ["liked", "最近点赞"],
      ["likes", "点赞最多"],
      ["comments", "评论最多"],
      ["duration", "时长最长"]
    ]) sort.append(selectOption(item[0], item[1]));
    sort.value = listState.sort || DEFAULT_SORT;

    const apply = () => {
      listState.author = author.value || "all";
      listState.sort = sort.value || DEFAULT_SORT;
      if (onSubmit) onSubmit();
    };
    author.addEventListener("change", apply);
    sort.addEventListener("change", apply);
    filters.append(author, sort);
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
    card.addEventListener("click", () => openShortVideoFromList(video));
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
    card.setAttribute("aria-label", video.title || "打开短视频");
    card.append(thumb);
    return card;
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
    }, { root: null, rootMargin: "720px 0px", threshold: 0.01 });
    listLoadMoreObserver.observe(sentinel);
  }

  async function openShortVideoFromList(video, options = {}) {
    const opened = await openNativeShortVideoFeed(video);
    if (opened) return;
    showView("shortVideoBrowser", { id: video.id }, options.replace ? { skipHistory: true, replaceHistory: true } : { push: true });
  }

  async function openNativeShortVideoFeed(video) {
    const plugin = nativePlayerPlugin();
    if (!plugin?.playShortFeed || !video?.id) return false;
    const videos = listState.data?.videos || [];
    const index = videos.findIndex((item) => item.id === video.id);
    if (index < 0) return false;
    const start = Math.max(0, index - 20);
    const end = Math.min(videos.length, index + 31);
    const feedUrl = nativeShortVideoFeedUrl();
    const payload = videos.slice(start, end).map((item) => ({
      id: item.id,
      title: item.title || "",
      streamUrl: item.streamUrl || "",
      coverUrl: item.coverUrl || "",
      author: {
        name: item.author?.name || "",
        secUid: item.author?.secUid || "",
        avatarUrl: item.author?.avatarUrl || "",
        profileUrl: item.author?.profileUrl || ""
      },
      publishedAt: item.publishedAt || "",
      durationMs: Number(item.durationMs || 0),
      size: Number(item.size || 0),
      stats: {
        likes: Number(item.stats?.likes || 0),
        comments: Number(item.stats?.comments || 0),
        collects: Number(item.stats?.collects || 0),
        shares: Number(item.stats?.shares || 0)
      }
    }));
    try {
      await plugin.playShortFeed({
        baseUrl: getActiveUrl(),
        feedUrl,
        hasMore: Boolean(listState.data?.hasMore || end < videos.length),
        nextOffset: end,
        startIndex: index - start,
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
    url.searchParams.set("sort", listState.sort || DEFAULT_SORT);
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
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = "‹";
    back.addEventListener("click", () => goBack());
    const search = document.createElement("button");
    search.type = "button";
    search.className = "short-video-mobile-top-search";
    search.textContent = listState.query || "搜索你感兴趣的内容";
    search.setAttribute("aria-label", "返回列表搜索短视频");
    search.addEventListener("click", showShortVideoListSearch);
    top.append(back, search);

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
      player.muted = false;
      player.playsInline = true;
      player.loop = true;
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
      playToggle.addEventListener("click", togglePlay);
      stage.addEventListener("click", (event) => {
        if (event.target?.closest?.("button")) return;
        togglePlay();
      });
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
      rail.append(railButton("", createIcon("ai"), "ai", "AI"));
      rail.append(authorRailButton(video, () => showAuthorPanel(video)));
      rail.append(railMetric("heart", video.stats?.likes, "like", "点赞", toggleRailActive));
      rail.append(railMetric("comment", video.stats?.comments, "comment", "评论"));
      rail.append(railMetric("star", video.stats?.collects, "collect", "收藏", toggleRailActive));
      rail.append(railMetric("share", video.stats?.shares, "share", "分享", () => shareShortVideo(video)));
      rail.append(railButton("抖音", createIcon("headphones"), "listen", "打开抖音", () => openDouyinLink(video)));
      rail.append(railButton("", createIcon("more"), "more", "更多"));
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
    return message;
  }

  function showShortVideoListSearch() {
    window.dispatchEvent(new CustomEvent("fanhaoOpenShortVideoSearch"));
  }

  async function openAdjacent(direction) {
    const id = direction < 0 ? browserState.prevId : browserState.nextId;
    if (!id || browserState.locked) return;
    browserState.locked = true;
    try {
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
        showView("shortVideoBrowser", { id }, { skipHistory: true, replaceHistory: true });
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
      browserState.touchStartY = event.touches?.[0]?.clientY || 0;
      browserState.touchDeltaY = 0;
      browserState.dragging = true;
      activeReelStack()?.classList.add("is-dragging");
    }, { passive: true });
    window.addEventListener("touchmove", (event) => {
      if (!isBrowserView()) return;
      const y = event.touches?.[0]?.clientY || 0;
      browserState.touchDeltaY = y - browserState.touchStartY;
      applyDragDelta(browserState.touchDeltaY);
      event.preventDefault();
    }, { passive: false });
    window.addEventListener("touchend", (event) => {
      if (!isBrowserView()) return;
      const endY = event.changedTouches?.[0]?.clientY || 0;
      const delta = browserState.touchDeltaY || endY - browserState.touchStartY;
      finishDrag(delta);
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
    params.set("sort", listState.sort || DEFAULT_SORT);
    return params.toString();
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
    for (const node of els.viewContent?.querySelectorAll?.(`[data-short-video-frame-id="${cssEscape(id)}"]`) || []) {
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
    const params = new URLSearchParams();
    params.set("id", String(id || ""));
    window.history.replaceState(window.history.state, "", `#shortVideoBrowser?${params.toString()}`);
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

  function railMetric(icon, value, kind = "", label = "", action = null) {
    return railButton(formatCompact(value || 0), createIcon(icon), kind, label, action);
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

  let authorPanelEl = null;

  function closeAuthorPanel() {
    if (!authorPanelEl) return;
    authorPanelEl.remove();
    authorPanelEl = null;
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

  async function viewAuthorVideos(secUid) {
    if (!secUid) return;
    closeAuthorPanel();
    const stack = activeReelStack();
    if (stack) stopPanelMedia(stack);
    showView("shortVideos", { query: "", author: secUid, sort: "published" }, { push: true });
  }

  function showAuthorPanel(video) {
    const secUid = String(video?.secUid || video?.author?.secUid || "").trim();
    if (!secUid) {
      shortVideoToast("该视频没有可识别的作者信息");
      return;
    }
    closeAuthorPanel();
    const author = video?.author || {};
    const name = author.name || "未知作者";
    const avatarUrl = author.avatarUrl || "";

    const overlay = document.createElement("div");
    overlay.className = "short-video-mobile-author-panel";
    ["touchstart", "touchmove", "touchend", "wheel", "click"].forEach((ev) =>
      overlay.addEventListener(ev, (event) => event.stopPropagation(), { passive: false })
    );
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeAuthorPanel();
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
    handle.textContent = `抖音号 ${secUid}`;
    info.append(nameEl, handle);
    header.append(avatar, info);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "author-sheet-close";
    closeBtn.setAttribute("aria-label", "关闭");
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", closeAuthorPanel);

    const actions = document.createElement("div");
    actions.className = "author-sheet-actions";
    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "author-sheet-action is-primary";
    allBtn.textContent = "查看该作者全部视频";
    allBtn.addEventListener("click", () => viewAuthorVideos(secUid));
    actions.append(allBtn);

    sheet.append(header, closeBtn, actions);
    overlay.append(sheet);
    document.body.append(overlay);
    authorPanelEl = overlay;
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
  return ["liked", "published", "likes", "comments", "duration"].includes(sort) ? sort : DEFAULT_SORT;
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
