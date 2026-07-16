import { createDetailViews, createPeopleViews, createWorkViews } from "./index.js?v=20260717-fanhao-person-page-01";

const ROOT_VIEWS = ["works", "rankings", "studios", "vr", "people", "favorites"];
const CHROME_TABS = [
  { label: "作品", view: "works" },
  { label: "榜单", view: "rankings" },
  { label: "片商", view: "studios" },
  { label: "VR", view: "vr" },
  { label: "人物", view: "people" },
  { label: "收藏", view: "favorites" }
];

export function createAndroidModule({ host }) {
  const search = createSearchController(host);
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
    getWorksLimit: host.limits.getWorks,
    increaseWorksLimit: host.limits.increaseWorks,
    renderCurrentViewPreservingScroll: host.ui.renderCurrentViewPreservingScroll,
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
    search,
    renderChrome: (context) => renderFanhaoChrome(context, host),
    api: { detailViews, peopleViews, workViews }
  };
}

function renderFanhaoChrome({ container, view }, host) {
  container.dataset.module = "fanhao";
  const nav = document.createElement("nav");
  nav.className = "module-chrome-tabs fanhao-chrome-tabs";
  nav.setAttribute("aria-label", "番号分类");
  const activeView = fanhaoTabForView(view);
  for (const tab of CHROME_TABS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = tab.label;
    button.classList.toggle("active", tab.view === activeView);
    button.addEventListener("click", () => {
      host.navigation.showView(tab.view, {}, { resetStack: true });
      host.ui.scrollToTop();
    });
    nav.append(button);
  }
  container.append(nav, createSearchButton(host, "搜索番号、作品或人物"));
  return true;
}

function fanhaoTabForView(view) {
  if (view === "rankings") return "rankings";
  if (view === "studios" || view === "studioDetail") return "studios";
  if (view === "vr") return "vr";
  if (view === "people" || view === "personDetail") return "people";
  if (view === "favorites") return "favorites";
  return "works";
}

function createSearchButton(host, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "module-chrome-search icon-only";
  button.setAttribute("aria-label", label);
  button.innerHTML = '<span aria-hidden="true">⌕</span>';
  button.addEventListener("click", host.ui.openSearch);
  return button;
}

function createSearchController(host) {
  return {
    mode: "route",
    useHistory: true,
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
