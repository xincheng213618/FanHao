import { createShortVideoApi } from "./api.js?v=20260711-short-video-cache-09";
import { createShortVideoListController } from "./list/controller.js?v=20260712-native-short-video-only-01";
import { createShortVideoListView } from "./list/view.js?v=20260712-native-short-video-only-01";
import { createShortVideoAuthorPanel } from "./panels/author-panel.js?v=20260712-native-short-video-only-01";
import { createShortVideoNativeFeed } from "./player/native-feed.js?v=20260712-native-short-video-only-01";
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
  const context = { ...deps, listState };
  context.api = createShortVideoApi({ getActiveUrl });
  Object.assign(context, createShortVideoIcons(context));
  Object.assign(context, createShortVideoListController(context));
  Object.assign(context, createShortVideoListView(context));
  Object.assign(context, createShortVideoNativeFeed(context));
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

  function deactivateTransientUi() {
    context.closeAuthorPanel();
    document.querySelector(".short-video-sort-overlay")?.remove();
    context.resetListLoadMoreObserver();
  }

  return Object.freeze({
    deactivate: deactivateTransientUi,
    getSearchState: context.getSearchState,
    renderList,
    renderSearch,
    submitSearch: context.submitSearch
  });
}
