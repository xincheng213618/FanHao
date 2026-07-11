import { createShortVideoViews } from "./index.js?v=20260711-short-video-home-01";

export function createAndroidModule({ host }) {
  const shortVideoViews = createShortVideoViews({
    els: host.els,
    getActiveUrl: host.getActiveUrl,
    goBack: host.navigation.goBack,
    openSettings: host.ui.openSettings,
    setActiveBottom: host.ui.setActiveBottom,
    showView: host.navigation.showView
  });
  return {
    bottomKey: "shortVideos",
    rootViews: ["shortVideos"],
    routes: [
      { view: "shortVideos", render: (params, guard) => shortVideoViews.renderList(params, guard) },
      { view: "shortVideoBrowser", render: (params, guard) => shortVideoViews.renderBrowser(params, guard) }
    ],
    search: createSearchController(host, shortVideoViews),
    deactivate: () => shortVideoViews.deactivate?.(),
    api: { shortVideoViews }
  };
}

function createSearchController(host, context) {
  const getSearchState = (...args) => context.getSearchState(...args);
  const submitSearch = (...args) => context.submitSearch(...args);
  const renderSearchFilters = (...args) => context.renderSearchFilters(...args);
  const clearSearchFilters = (...args) => context.clearSearchFilters(...args);
  return {
    mode: "short-video",
    showAction: () => true,
    isExpanded: (_view, _params, expanded) => expanded,
    placeholder: () => "搜短视频标题、作者或标签",
    value: () => getSearchState().query || "",
    submit(query) {
      submitSearch(query);
    },
    renderFilters(form, submit) {
      renderSearchFilters(form, submit);
    },
    clearFilters(form) {
      clearSearchFilters(form);
    },
    open(context) {
      if (context.view !== "shortVideoBrowser") return;
      const state = getSearchState() || {};
      host.navigation.showView("shortVideos", {
        query: state.query || "",
        author: state.author || "all",
        source: state.source || "liked",
        sort: state.sort || "published"
      }, { skipHistory: true, replaceHistory: true });
    }
  };
}
