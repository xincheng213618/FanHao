import { absoluteUrl, loadPreviewImage } from "../../../js/image.js?v=20260706-mobile-web-sync-01";
import { formatCompact } from "../../../js/format.js";
import { AUTHOR_PAGE_LIMIT, DEFAULT_LIMIT, DEFAULT_SORT, SHORT_VIDEO_SORT_OPTIONS, formatDate, formatDuration, initials, normalizeSort, normalizeSource, selectOption, shortVideoSortLabel } from "../shared.js";
export function createShortVideoPlaybackPanels(context = {}) {
  const { api, browserState, els, getActiveUrl, listState } = context;
  let playbackToolbarEl = null;
  let playbackActionsEl = null;
  const activeReelStack = (...args) => context.activeReelStack(...args);
  const openNativeShortVideo = (...args) => context.openNativeShortVideo(...args);
  const openShortVideoFromList = (...args) => context.openShortVideoFromList(...args);
  const renderBrowserError = (...args) => context.renderBrowserError(...args);
  const renderBrowserShell = (...args) => context.renderBrowserShell(...args);
  const shortVideoApiSource = (...args) => context.shortVideoApiSource(...args);
  const shortVideoErrorMessage = (...args) => context.shortVideoErrorMessage(...args);
  const shortVideoToast = (...args) => context.shortVideoToast(...args);
  const showAuthorPanel = (...args) => context.showAuthorPanel(...args);
  const stopPanelMedia = (...args) => context.stopPanelMedia(...args);
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
      const data = await api.fetch(getActiveUrl(), `/api/short-videos?${params}`, { timeoutMs: 16000 });
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

  return {
    closePlaybackToolbar,
    showPlaybackToolbar,
    playbackToolbarButton,
    activeWebPlayer,
    applyWebPlaybackPrefs,
    toggleWebMuted,
    toggleWebAutoNext,
    toggleWebControlsHidden,
    applyWebControlVisibility,
    closePlaybackActions,
    showPlaybackActions,
    playbackActionButton,
    applyPlaybackSort,
    shareShortVideo,
    openDouyinLink
  };
}
