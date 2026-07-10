import { absoluteUrl, loadPreviewImage } from "../../../js/image.js?v=20260706-mobile-web-sync-01";
import { formatBytes, formatCompact } from "../../../js/format.js";
import { DEFAULT_LIMIT, DEFAULT_SORT, DEFAULT_SOURCE, formatDate, formatDuration, normalizeSort, normalizeSource } from "../shared.js";
export function createShortVideoReelController(context = {}) {
  const { api, browserState, els, getActiveUrl, goBack, listState, setActiveBottom, showView } = context;
  let eventsInstalled = false;
  let listEventsInstalled = false;
  const activeReelStack = (...args) => context.activeReelStack(...args);
  const animateActiveStack = (...args) => context.animateActiveStack(...args);
  const appendListSilently = (...args) => context.appendListSilently(...args);
  const appendVisibleAuthors = (...args) => context.appendVisibleAuthors(...args);
  const applyDragDelta = (...args) => context.applyDragDelta(...args);
  const authorRailButton = (...args) => context.authorRailButton(...args);
  const bindStageLongPress = (...args) => context.bindStageLongPress(...args);
  const cachedFirstFrameUrl = (...args) => context.cachedFirstFrameUrl(...args);
  const clearStageTapTimer = (...args) => context.clearStageTapTimer(...args);
  const closeAuthorPanel = (...args) => context.closeAuthorPanel(...args);
  const closePlaybackActions = (...args) => context.closePlaybackActions(...args);
  const consumeStageLongPressClick = (...args) => context.consumeStageLongPressClick(...args);
  const displayWebLikes = (...args) => context.displayWebLikes(...args);
  const finishDrag = (...args) => context.finishDrag(...args);
  const formatSystemStatusText = (...args) => context.formatSystemStatusText(...args);
  const getSearchState = (...args) => context.getSearchState(...args);
  const handleHorizontalSwipe = (...args) => context.handleHorizontalSwipe(...args);
  const handleStageClick = (...args) => context.handleStageClick(...args);
  const isAuthorIndexView = (...args) => context.isAuthorIndexView(...args);
  const isHorizontalSwipe = (...args) => context.isHorizontalSwipe(...args);
  const isWebLiked = (...args) => context.isWebLiked(...args);
  const likeWebVideo = (...args) => context.likeWebVideo(...args);
  const loadList = (...args) => context.loadList(...args);
  const railMetric = (...args) => context.railMetric(...args);
  const railNav = (...args) => context.railNav(...args);
  const renderListShell = (...args) => context.renderListShell(...args);
  const replaceCurrentShortVideoHistory = (...args) => context.replaceCurrentShortVideoHistory(...args);
  const requestVideoFirstFrame = (...args) => context.requestVideoFirstFrame(...args);
  const setIconButton = (...args) => context.setIconButton(...args);
  const shareShortVideo = (...args) => context.shareShortVideo(...args);
  const shortVideoBrowserParams = (...args) => context.shortVideoBrowserParams(...args);
  const showAuthorPanel = (...args) => context.showAuthorPanel(...args);
  const snapStackBack = (...args) => context.snapStackBack(...args);
  const stopPanelMedia = (...args) => context.stopPanelMedia(...args);
  const toggleRailActive = (...args) => context.toggleRailActive(...args);
  const warmAdjacentMedia = (...args) => context.warmAdjacentMedia(...args);
  function applyBrowserParams(input = {}) {
    if (typeof input === "string" || typeof input === "number") return String(input || "").trim();
    const params = input || {};
    listState.query = String(params.query || params.q || "").trim();
    listState.author = String(params.author || "all").trim() || "all";
    listState.source = normalizeSource(params.source || params.origin);
    listState.sort = normalizeSort(params.sort);
    return String(params.id || "").trim();
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
      const data = await api.fetch(getActiveUrl(), `/api/short-videos/${encodeURIComponent(id)}?${shortVideoFeedParams()}`, { timeoutMs: 16000 });
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
      browserState.prevId ? api.fetch(getActiveUrl(), `/api/short-videos/${encodeURIComponent(videoId)}/adjacent?direction=prev&${params}`, { timeoutMs: 10000 }) : Promise.resolve(null),
      browserState.nextId ? api.fetch(getActiveUrl(), `/api/short-videos/${encodeURIComponent(videoId)}/adjacent?direction=next&${params}`, { timeoutMs: 10000 }) : Promise.resolve(null)
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
    const data = await api.fetch(getActiveUrl(), `/api/short-videos/${encodeURIComponent(id)}?${shortVideoFeedParams()}`, { timeoutMs: 12000 });
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

  return {
    applyBrowserParams,
    loadVideo,
    renderBrowserShell,
    renderMobileReelPanel,
    renderBrowserError,
    shortVideoErrorMessage,
    showShortVideoListSearch,
    openAdjacent,
    installBrowserEvents,
    installListEvents,
    isBrowserView,
    loadAdjacentVideos,
    promoteAdjacentVideo,
    refreshCurrentDetail,
    shortVideoFeedParams,
    shortVideoApiSource,
    cachedListVideo,
    applyQueuedReelWindow,
    findListVideoIndex,
    warmListAround
  };
}
