import { createNovelViews } from "./novel-views.js?v=20260711-novel-native-export-11";

export function createAndroidModule({ host }) {
  const novelViews = createNovelViews({
    els: host.els,
    getActiveUrl: host.getActiveUrl,
    showView: host.navigation.showView,
    goBack: host.navigation.goBack,
    setActiveBottom: host.ui.setActiveBottom,
    renderCurrentView: host.ui.renderCurrentView,
    renderCurrentViewPreservingScroll: host.ui.renderCurrentViewPreservingScroll,
    setStatus: host.ui.setStatus
  });
  return {
    bottomKey: "novels",
    rootViews: ["novels"],
    routes: [
      { view: "novels", render: (_params, guard) => novelViews.renderNovelList(guard) },
      { view: "novelDetail", render: (params, guard) => novelViews.renderNovelDetail(params.id, guard) },
      { view: "novelReader", render: (params, guard) => novelViews.renderNovelReader(params.id, params.chapterIndex, guard) }
    ],
    handleBack(view, params) {
      if (view !== "novelReader") return false;
      if (params.id) host.navigation.showView("novelDetail", { id: params.id }, { skipHistory: true, replaceHistory: true });
      else host.navigation.showView("novels", {}, { skipHistory: true, replaceHistory: true });
      return true;
    },
    api: { novelViews }
  };
}
