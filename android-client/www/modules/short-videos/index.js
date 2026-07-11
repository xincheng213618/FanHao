import { createShortVideoApi } from "./api.js?v=20260711-short-video-cache-09";
import { createShortVideoListController } from "./list/controller.js?v=20260712-short-video-search-page-07";
import { createShortVideoListView } from "./list/view.js?v=20260712-short-video-search-page-07";
import { createShortVideoAuthorPanel } from "./panels/author-panel.js?v=20260711-short-video-cache-08";
import { createShortVideoPlaybackPanels } from "./panels/playback-panels.js?v=20260711-short-video-cache-08";
import { createShortVideoNativePlatform } from "./platform/native-player.js?v=20260711-short-video-cache-08";
import { createShortVideoInteractions } from "./player/interactions.js?v=20260711-short-video-cache-08";
import { createShortVideoMediaCache } from "./player/media-cache.js?v=20260711-short-video-cache-08";
import { createShortVideoReelController } from "./player/reel-controller.js?v=20260711-short-video-cache-08";
import { createShortVideoNativeFeed } from "./player/native-feed.js?v=20260711-short-video-cache-08";
import { DEFAULT_SORT, DEFAULT_SOURCE } from "./shared.js?v=20260712-short-video-search-page-07";
import { createShortVideoIcons } from "./ui/icons.js?v=20260711-short-video-cache-08";

export function createShortVideoViews(deps) {
  const { els, getActiveUrl, setActiveBottom } = deps;
  const listState = {
    data: null,
    query: "",
    author: "all",
    source: DEFAULT_SOURCE,
    sort: DEFAULT_SORT,
    loading: false,
    loadingMore: false,
    status: "",
    searchPage: false,
    authorVisibleCount: 24,
    allowLoadMore: false
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
    touchLastY: 0,
    touchLastAt: 0,
    touchVelocityY: 0,
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
  const context = { ...deps, browserState, listState };
  context.api = createShortVideoApi({ getActiveUrl });
  Object.assign(context, createShortVideoIcons(context));
  Object.assign(context, createShortVideoNativePlatform(context));
  Object.assign(context, createShortVideoListController(context));
  Object.assign(context, createShortVideoListView(context));
  Object.assign(context, createShortVideoNativeFeed(context));
  Object.assign(context, createShortVideoReelController(context));
  Object.assign(context, createShortVideoMediaCache(context));
  Object.assign(context, createShortVideoInteractions(context));
  Object.assign(context, createShortVideoPlaybackPanels(context));
  Object.assign(context, createShortVideoAuthorPanel(context));

  async function renderList(params = {}, renderGuard = null) {
    deactivateTransientUi();
    context.installListEvents();
    setActiveBottom("shortVideos");
    listState.searchPage = false;
    context.applyListParams(params);
    els.viewKicker.textContent = "短视频";
    els.viewTitle.textContent = "短视频";
    els.viewMeta.textContent = "";
    els.viewContent.className = "content-list short-video-mobile-content";
    context.renderListShell();
    await context.loadList(renderGuard);
  }

  async function renderSearch(params = {}, renderGuard = null) {
    deactivateTransientUi();
    context.installListEvents();
    setActiveBottom("shortVideos");
    listState.searchPage = true;
    context.applyListParams(params);
    if (!listState.query) {
      listState.data = null;
      listState.loading = false;
      listState.status = "";
    }
    els.viewKicker.textContent = "短视频";
    els.viewTitle.textContent = "搜索";
    els.viewMeta.textContent = "";
    els.viewContent.className = "content-list short-video-mobile-content short-video-search-page-content";
    context.renderListShell();
    if (listState.query) await context.loadList(renderGuard);
  }

  async function renderBrowser(input, renderGuard = null) {
    context.clearStageTapTimer();
    context.clearStageLongPress();
    context.closePlaybackActions();
    context.closePlaybackToolbar();
    context.setImmersiveMode(true);
    context.startSystemInfoUpdates();
    context.installBrowserEvents();
    setActiveBottom("shortVideos");
    els.viewKicker.textContent = "短视频";
    els.viewTitle.textContent = "正在播放";
    els.viewMeta.textContent = "上滑切换";
    els.viewContent.className = "content-list short-video-mobile-content";
    const videoId = context.applyBrowserParams(input);
    await context.loadVideo(videoId, renderGuard);
  }

  function deactivateTransientUi() {
    context.stopSystemInfoUpdates();
    context.clearStageTapTimer();
    context.clearStageLongPress();
    context.closePlaybackActions();
    context.closePlaybackToolbar();
    context.closeAuthorPanel({ resume: false });
    document.querySelector(".short-video-sort-overlay")?.remove();
    context.resetListLoadMoreObserver();
    const stack = context.activeReelStack();
    if (stack) context.stopPanelMedia(stack);
    browserState.authorReturnPanel = null;
    context.setImmersiveMode(false);
  }

  return Object.freeze({
    deactivate: deactivateTransientUi,
    getSearchState: context.getSearchState,
    renderBrowser,
    renderList,
    renderSearch,
    submitSearch: context.submitSearch
  });
}
