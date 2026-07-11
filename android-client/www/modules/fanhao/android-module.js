import { createDetailViews } from "./detail-views.js?v=20260710-module-registry-01";
import { createPeopleViews } from "./people-views.js?v=20260710-module-registry-01";
import { createWorkViews } from "./work-views.js?v=20260710-module-registry-01";

const ROOT_VIEWS = ["works", "rankings", "studios", "vr", "people", "favorites"];

export function createAndroidModule({ host }) {
  const workViews = createWorkViews({
    els: host.els,
    getActiveUrl: host.getActiveUrl,
    getWorksLimit: host.limits.getWorks,
    increaseWorksLimit: host.limits.increaseWorks,
    showView: host.navigation.showView,
    openInLibrary: host.navigation.openInLibrary,
    setActiveBottom: host.ui.setActiveBottom,
    renderCurrentView: host.ui.renderCurrentView,
    renderCurrentViewPreservingScroll: host.ui.renderCurrentViewPreservingScroll,
    isHomeView: () => host.navigation.currentView() === "home",
    renderFavoriteExtras: host.favorites.renderPanel
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
    renderCurrentViewPreservingScroll: host.ui.renderCurrentViewPreservingScroll
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
    mediaViewer: host.mediaViewer,
    goBack: host.navigation.goBack,
    onUserStateChange: host.favorites.onUserStateChange
  });

  return {
    bottomKey: "fanhao",
    rootViews: ROOT_VIEWS,
    routes: [
      route("people", (_params, guard) => peopleViews.renderPeopleIndex(guard)),
      route("works", (_params, guard) => workViews.renderAllWorks(guard)),
      route("rankings", (_params, guard) => workViews.renderRankings(guard)),
      route("studios", (_params, guard) => workViews.renderStudios(guard)),
      route("studioDetail", (params, guard) => workViews.renderStudioDetail(params.studioId, params.seriesId, guard)),
      route("vr", (_params, guard) => workViews.renderVrWorks(guard)),
      route("favorites", (_params, guard) => workViews.renderWorkCollection("favorites", guard)),
      route("history", (_params, guard) => workViews.renderWorkCollection("history", guard)),
      route("search", (params, guard) => workViews.renderSearchResults(params.query || "", guard)),
      route("personDetail", (params, guard) => detailViews.renderPersonDetail(params.personId, guard)),
      route("workDetail", (params, guard) => detailViews.renderWorkDetail(params.workId, guard))
    ],
    search: createSearchController(host),
    api: { detailViews, peopleViews, workViews }
  };
}

function createSearchController(host) {
  return {
    mode: "route",
    useHistory: true,
    showAction: () => true,
    showHistory: (view) => view === "search",
    hideBottom: (view) => view === "search",
    isExpanded: (view, _params, expanded) => view === "search" || expanded,
    placeholder: () => "搜番号、作品或人物",
    value: (view, params) => view === "search" ? String(params.query || "") : "",
    submit(query, context) {
      const navigation = context.view === "search" ? { skipHistory: true } : { resetStack: true };
      host.navigation.showView("search", { query }, navigation);
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
