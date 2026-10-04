import { FANHAO_ROOT_VIEWS, renderFanhaoChrome } from "./chrome.js?v=assets-07b744082137";
import { createDetailViews, createPeopleViews, createWorkViews } from "./index.js?v=assets-07b744082137";
import { createCodePrefixViews } from "./features/code-prefixes/prefix-views.js?v=assets-07b744082137";

export function createAndroidModule({ host }) {
  const workViews = createWorkViews({
    els: host.els,
    getActiveUrl: host.getActiveUrl,
    getLibrary: host.getLibrary,
    getCurrentParams: host.navigation.currentParams,
    getCurrentView: host.navigation.currentView,
    getWorksLimit: host.limits.getWorks,
    increaseWorksLimit: host.limits.increaseWorks,
    showView: host.navigation.showView,
    replaceViewParams: host.navigation.replaceViewParams,
    goBack: host.navigation.goBack,
    openInLibrary: host.navigation.openInLibrary,
    setActiveBottom: host.ui.setActiveBottom,
    refreshChrome: host.ui.refreshChrome,
    renderCurrentView: host.ui.renderCurrentView,
    renderCurrentViewPreservingScroll: host.ui.renderCurrentViewPreservingScroll,
    isHomeView: () => host.navigation.currentView() === "home",
    onUserStateChange: host.favorites.onUserStateChange
  });
  const search = createSearchController(host, workViews);
  const codePrefixViews = createCodePrefixViews({
    els: host.els,
    getActiveUrl: host.getActiveUrl,
    getWorksLimit: host.limits.getWorks,
    increaseWorksLimit: host.limits.increaseWorks,
    pageDataService: workViews.pageDataService,
    renderCurrentViewPreservingScroll: host.ui.renderCurrentViewPreservingScroll,
    renderMessage: workViews.renderMessage,
    renderWorks: workViews.renderWorks,
    setActiveBottom: host.ui.setActiveBottom,
    showView: host.navigation.showView,
    workListState: { getRequestState: workViews.getWorkListRequestState }
  });
  const peopleViews = createPeopleViews({
    els: host.els,
    getActiveUrl: host.getActiveUrl,
    getLibrary: host.getLibrary,
    getPeopleLimit: host.limits.getPeople,
    increasePeopleLimit: host.limits.increasePeople,
    showView: host.navigation.showView,
    openInLibrary: host.navigation.openInLibrary,
    setActiveBottom: host.ui.setActiveBottom,
    createLoadMoreButton: workViews.createLoadMoreButton,
    pageDataService: workViews.pageDataService
  });
  const detailViews = createDetailViews({
    els: host.els,
    getActiveUrl: host.getActiveUrl,
    getLibrary: host.getLibrary,
    openInLibrary: host.navigation.openInLibrary,
    showView: host.navigation.showView,
    setActiveBottom: host.ui.setActiveBottom,
    renderWorks: workViews.renderWorks,
    renderMessage: workViews.renderMessage,
    createChip: workViews.createChip,
    getWorksLimit: host.limits.getWorks,
    getWorkListRequestState: workViews.getWorkListRequestState,
    getWorkFilterMode: workViews.getWorkFilterMode,
    getWorkFilterOptions: workViews.getWorkFilterOptions,
    setWorkFilterMode: workViews.setWorkFilterMode,
    getWorkSortMode: () => workViews.getSortMode("works"),
    getWorkSortOptions: () => workViews.getSortOptions("works"),
    setWorkSortMode: (value) => workViews.setSortMode("works", value),
    increaseWorksLimit: host.limits.increaseWorks,
    renderCurrentView: host.ui.renderCurrentView,
    renderCurrentViewPreservingScroll: host.ui.renderCurrentViewPreservingScroll,
    mediaViewer: host.mediaViewer,
    goBack: host.navigation.goBack,
    favoriteFolders: workViews.favoriteFolders,
    onUserStateChange: host.favorites.onUserStateChange,
    pageDataService: workViews.pageDataService,
    workDetailDataService: workViews.workDetailDataService
  });

  return {
    bottomKey: "fanhao",
    rootViews: FANHAO_ROOT_VIEWS,
    routes: [
      route("people", (params, guard) => peopleViews.renderPeopleIndex(params.scope, guard)),
      route("works", (params, guard) => workViews.renderAllWorks(params, guard)),
      route("rankings", (_params, guard) => workViews.renderRankings(guard)),
      route("categories", (params, guard) => workViews.renderCategories(params.category, guard)),
      route("codePrefixes", (_params, guard) => codePrefixViews.renderIndex(guard)),
      route("codePrefixDetail", (params, guard) => codePrefixViews.renderDetail(params.prefix, params.family, guard)),
      route("studios", (_params, guard) => workViews.renderStudios(guard)),
      route("studioDetail", (params, guard) => workViews.renderStudioDetail(params.studioId, params.seriesId, guard)),
      route("history", (_params, guard) => workViews.renderHistory(guard)),
      route("search", (params, guard) => workViews.renderSearchResults(params, guard)),
      route("personDetail", (params, guard) => detailViews.renderPersonDetail(params.personId, params.scope, guard)),
      route("workDetail", (params, guard) => detailViews.renderWorkDetail(params.workId, guard))
    ],
    handleBack: () => detailViews.handleBack?.() === true,
    search,
    renderChrome: (context) => renderFanhaoChrome(context, host, { peopleViews, workViews }),
    api: { codePrefixViews, detailViews, peopleViews, workViews }
  };
}

function createSearchController(host, workViews) {
  return {
    mode: "dedicated",
    useHistory: false,
    showHistory: () => false,
    hideBottom: () => false,
    isExpanded: () => false,
    placeholder: (view, params) => searchCategory(view, params) === "western" ? "搜欧美作品或演员" : "搜番号、作品或演员",
    value: (view, params) => view === "search" ? String(params.query || "") : "",
    prepare(query, context = {}) {
      return workViews.warmSearch(query, context.params?.category);
    },
    submit(query) {
      const category = String(host.navigation.currentParams()?.category || "").toLowerCase() === "western" ? "western" : "censored";
      host.navigation.showView("search", { query, category }, { skipHistory: true, replaceHistory: true });
    },
    open(context) {
      if (context.view === "search") return;
      const category = searchCategory(context.view, context.params);
      host.navigation.showView("search", { query: "", category }, context.view === "home" ? { resetStack: true } : { push: true });
    },
    close(context) {
      if (context.view !== "search") return false;
      if (host.navigation.hasBackStack()) host.navigation.goBack();
      else host.navigation.showView("people", { scope: context.params?.category === "western" ? "western" : "main" }, { resetStack: true });
      return true;
    }
  };
}

function searchCategory(view, params = {}) {
  if (view === "people" || view === "personDetail") {
    return String(params.scope || "main").toLowerCase() === "western" ? "western" : "censored";
  }
  return String(params.category || "").toLowerCase() === "western" ? "western" : "censored";
}

function route(view, render) {
  return { view, render };
}
