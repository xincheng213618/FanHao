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
  window.addEventListener("fanhaoNovelSourceChanged", host.ui.refreshChrome);
  return {
    bottomKey: "novels",
    rootViews: ["novels"],
    routes: [
      { view: "novels", render: (_params, guard) => novelViews.renderNovelList(guard) },
      { view: "novelDetail", render: (params, guard) => novelViews.renderNovelDetail(params.id, guard) },
      { view: "novelReader", render: (params, guard) => novelViews.renderNovelReader(params.id, params.chapterIndex, guard) }
    ],
    renderChrome: (context) => renderNovelChrome(context, host, novelViews),
    handleBack(view, params) {
      if (view !== "novelReader") return false;
      if (params.id) host.navigation.showView("novelDetail", { id: params.id }, { skipHistory: true, replaceHistory: true });
      else host.navigation.showView("novels", {}, { skipHistory: true, replaceHistory: true });
      return true;
    },
    api: { novelViews }
  };
}

function renderNovelChrome({ container, view }, host, novelViews) {
  if (view !== "novels") return false;
  const activeSource = novelViews.getLibrarySource?.() || "local";
  container.dataset.module = "novels";
  const nav = document.createElement("nav");
  nav.className = "module-chrome-tabs novel-chrome-tabs";
  nav.setAttribute("aria-label", "小说来源");
  for (const item of [{ label: "本地", source: "local" }, { label: "远端", source: "bookstore" }]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.label;
    button.classList.toggle("active", item.source === activeSource);
    button.addEventListener("click", () => {
      novelViews.setLibrarySource?.(item.source);
      host.ui.renderCurrentView();
      host.ui.scrollToTop();
    });
    nav.append(button);
  }
  container.append(nav);
  return true;
}
