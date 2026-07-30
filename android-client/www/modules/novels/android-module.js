import { openMobileActionSheet } from "../../js/mobile-action-sheet.js?v=20260731-mobile-action-sheet-01";
import { createNovelViews } from "./novel-views.js?v=20260731-novel-actions-ui-53";

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
      { view: "novelSearch", render: (params, guard) => novelViews.renderNovelSearch(params, guard) },
      { view: "novelDetail", render: (params, guard) => novelViews.renderNovelDetail(params.id, guard) },
      { view: "novelReader", render: (params, guard) => novelViews.renderNovelReader(params.id, params.chapterIndex, guard) }
    ],
    renderChrome: (context) => renderNovelChrome(context, host, novelViews),
    handleBack(view, params) {
      if (view !== "novelReader" || host.navigation.hasBackStack()) return false;
      host.navigation.showView("novels", {}, { skipHistory: true, replaceHistory: true });
      return true;
    },
    api: { novelViews }
  };
}

function renderNovelChrome({ container, view }, host, novelViews) {
  if (view !== "novels") return false;
  const state = novelViews.getNovelNavigationState?.() || {};
  container.dataset.module = "novels";
  const nav = document.createElement("nav");
  nav.className = "module-chrome-tabs novel-chrome-tabs";
  nav.setAttribute("aria-label", "小说分类");
  const categories = [{ name: "all", label: "全部" }, ...(state.categories || [])];
  if (state.category && state.category !== "all" && !categories.some((item) => item.name === state.category)) {
    categories.push({ name: state.category, label: state.category });
  }
  for (const item of categories) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.label;
    button.classList.toggle("active", item.name === (state.category || "all"));
    button.addEventListener("click", () => {
      if (!novelViews.setNovelCategory?.(item.name)) return;
      host.ui.renderCurrentView();
      host.ui.scrollToTop();
    });
    nav.append(button);
  }
  const sort = document.createElement("button");
  sort.type = "button";
  sort.className = "novel-chrome-action novel-chrome-sort";
  const activeSort = (novelViews.getNovelSortOptions?.() || []).find((option) => option.value === state.sort);
  sort.setAttribute("aria-label", `小说排序，当前${activeSort?.label || "最近更新"}`);
  sort.textContent = "↕";
  sort.addEventListener("click", () => openNovelSortDialog(host, novelViews));
  const search = document.createElement("button");
  search.type = "button";
  search.className = "module-chrome-search novel-chrome-action";
  search.setAttribute("aria-label", "搜索小说");
  search.innerHTML = '<span aria-hidden="true">⌕</span>';
  search.addEventListener("click", () => {
    host.navigation.showView("novelSearch", { query: "" }, { push: true });
    host.ui.scrollToTop();
  });
  container.append(nav, sort, search);
  return true;
}

function openNovelSortDialog(host, novelViews) {
  const state = novelViews.getNovelNavigationState?.() || {};
  openMobileActionSheet({
    title: "小说排序",
    value: state.sort || "updated",
    options: (novelViews.getNovelSortOptions?.() || []).map((option) => ({
      ...option,
      select: () => {
        if (!novelViews.setNovelSort?.(option.value)) return;
        host.ui.renderCurrentView();
        host.ui.scrollToTop();
      }
    }))
  });
}
