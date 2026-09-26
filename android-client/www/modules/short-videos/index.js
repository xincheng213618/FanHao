import { createShortVideoApi } from "./api.js?v=assets-0f97d6765d71";
import { createShortVideoListController } from "./list/controller.js?v=assets-0f97d6765d71";
import { createShortVideoListView } from "./list/view.js?v=assets-0f97d6765d71";
import { createShortVideoNativeFeed } from "./player/native-feed.js?v=assets-0f97d6765d71";
import { createShortVideoSearch } from "./search.js?v=assets-0f97d6765d71";
import { DEFAULT_SORT, DEFAULT_SOURCE } from "./shared.js?v=assets-0f97d6765d71";
import { createShortVideoIcons } from "./ui/icons.js?v=assets-0f97d6765d71";
import { createShortVideoInteractions } from "./ui/interactions.js?v=assets-0f97d6765d71";

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
    authorAccountStatus: "all",
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
  Object.assign(context, createShortVideoInteractions());
  Object.assign(context, createShortVideoListController(context));
  Object.assign(context, createShortVideoSearch(context));
  Object.assign(context, createShortVideoListView(context));
  Object.assign(context, createShortVideoNativeFeed(context));

  async function renderList(params = {}, renderGuard = null) {
    deactivateTransientUi();
    context.installListEvents();
    setActiveBottom("shortVideos");
    listState.searchPage = false;
    const preserveShell = Boolean(els.viewContent.querySelector(".short-video-mobile-list"));
    const scopeChanged = context.applyListParams(params, { preserveData: preserveShell });
    els.viewKicker.textContent = "短视频";
    els.viewTitle.textContent = "短视频";
    els.viewMeta.textContent = "";
    els.viewContent.className = "content-list short-video-mobile-content";
    if (!preserveShell || !scopeChanged) context.renderListShell();
    await context.loadList(renderGuard, { preserveShell: preserveShell && scopeChanged });
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
