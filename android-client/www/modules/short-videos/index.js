import { createShortVideoApi } from "./api.js?v=20260713-follow-toggle-08";
import { createShortVideoListController } from "./list/controller.js?v=20260713-follow-toggle-08";
import { createShortVideoListView } from "./list/view.js?v=20260713-follow-toggle-08";
import { createShortVideoNativeFeed } from "./player/native-feed.js?v=20260712-native-short-video-only-02";
import { createShortVideoSearch } from "./search.js?v=20260712-douyin-search-05";
import { DEFAULT_SORT, DEFAULT_SOURCE } from "./shared.js?v=20260713-follow-toggle-08";
import { createShortVideoIcons } from "./ui/icons.js?v=20260712-douyin-search-05";

export function createShortVideoViews(deps) {
  const { els, getActiveUrl, setActiveBottom } = deps;
  const listState = {
    data: null,
    query: "",
    author: "all",
    source: DEFAULT_SOURCE,
    sort: DEFAULT_SORT,
    authorSort: "followed",
    authorFilter: "all",
    loading: false,
    loadingMore: false,
    status: "",
    searchPage: false,
    searchTab: "all",
    searchAuthors: [],
    allowLoadMore: false
  };
  const context = { ...deps, listState };
  context.api = createShortVideoApi({ getActiveUrl });
  Object.assign(context, createShortVideoIcons(context));
  Object.assign(context, createShortVideoListController(context));
  Object.assign(context, createShortVideoSearch(context));
  Object.assign(context, createShortVideoListView(context));
  Object.assign(context, createShortVideoNativeFeed(context));

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
