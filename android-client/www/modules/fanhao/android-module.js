import { FANHAO_ROOT_VIEWS, renderFanhaoChrome } from "./chrome.js?v=20260721-fanhao-author-sort-density-08";
import { createDetailViews, createPeopleViews, createWorkViews } from "./index.js?v=20260721-fanhao-ranking-density-11";

export function createAndroidModule({ host }) {
  const workViews = createWorkViews({
    els: host.els,
    getActiveUrl: host.getActiveUrl,
    getLibrary: host.getLibrary,
    getWorksLimit: host.limits.getWorks,
    increaseWorksLimit: host.limits.increaseWorks,
    showView: host.navigation.showView,
    goBack: host.navigation.goBack,
    openInLibrary: host.navigation.openInLibrary,
    setActiveBottom: host.ui.setActiveBottom,
    renderCurrentView: host.ui.renderCurrentView,
    renderCurrentViewPreservingScroll: host.ui.renderCurrentViewPreservingScroll,
    isHomeView: () => host.navigation.currentView() === "home"
  });
  const search = createSearchController(host, workViews);
  const peopleViews = createPeopleViews({
    els: host.els,
    getActiveUrl: host.getActiveUrl,
    getLibrary: host.getLibrary,
    getPeopleLimit: host.limits.getPeople,
    increasePeopleLimit: host.limits.increasePeople,
    showView: host.navigation.showView,
    openInLibrary: host.navigation.openInLibrary,
    setActiveBottom: host.ui.setActiveBottom,
    createLoadMoreButton: workViews.createLoadMoreButton
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
    renderCurrentViewPreservingScroll: host.ui.renderCurrentViewPreservingScroll,
    mediaViewer: host.mediaViewer,
    goBack: host.navigation.goBack,
    onUserStateChange: host.favorites.onUserStateChange,
    pageDataService: workViews.pageDataService,
    workDetailDataService: workViews.workDetailDataService
  });

  return {
    bottomKey: "fanhao",
    rootViews: FANHAO_ROOT_VIEWS,
    routes: [
      route("people", (_params, guard) => peopleViews.renderPeopleIndex(guard)),
      route("works", (_params, guard) => workViews.renderAllWorks(guard)),
      route("rankings", (_params, guard) => workViews.renderRankings(guard)),
      route("studios", (_params, guard) => workViews.renderStudios(guard)),
      route("studioDetail", (params, guard) => workViews.renderStudioDetail(params.studioId, params.seriesId, guard)),
      route("history", (_params, guard) => workViews.renderHistory(guard)),
      route("search", (params, guard) => workViews.renderSearchResults(params.query || "", guard)),
      route("personDetail", (params, guard) => detailViews.renderPersonDetail(params.personId, guard)),
      route("workDetail", (params, guard) => detailViews.renderWorkDetail(params.workId, guard))
    ],
    search,
    renderChrome: (context) => renderFanhaoChrome(context, host, { peopleViews, workViews }),
    api: { detailViews, peopleViews, workViews }
  };
}

function createSearchController(host, workViews) {
  return {
    mode: "dedicated",
    useHistory: false,
    showHistory: () => false,
    hideBottom: () => false,
    isExpanded: () => false,
    placeholder: () => "搜番号、作品或作者",
    value: (view, params) => view === "search" ? String(params.query || "") : "",
    prepare(query) {
      return workViews.warmSearch(query);
    },
    submit(query) {
      host.navigation.showView("search", { query }, { skipHistory: true, replaceHistory: true });
    },
    open(context) {
      if (context.view === "search") return;
      host.navigation.showView("search", { query: "" }, context.view === "home" ? { resetStack: true } : { push: true });
    },
    close(context) {
      if (context.view !== "search") return false;
      if (host.navigation.hasBackStack()) host.navigation.goBack();
      else host.navigation.showView("works", {}, { resetStack: true });
      return true;
    }
  };
}

function route(view, render) {
  return { view, render };
}
