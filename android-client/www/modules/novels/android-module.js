import { createNovelViews } from "./novel-views.js?v=20260731-novel-shelf-ui-52";

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
  sort.setAttribute("aria-label", "小说排序");
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
  document.querySelector(".novel-sort-overlay")?.remove();
  const state = novelViews.getNovelNavigationState?.() || {};
  const overlay = document.createElement("div");
  overlay.className = "novel-sort-overlay";
  const backdrop = document.createElement("button");
  backdrop.type = "button";
  backdrop.className = "novel-sort-backdrop";
  backdrop.setAttribute("aria-label", "关闭排序");
  const panel = document.createElement("section");
  panel.className = "novel-sort-sheet";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "小说排序");
  const title = document.createElement("strong");
  title.textContent = "排序";
  panel.append(title);
  for (const [value, label] of [
    ["updated", "最近更新"],
    ["title", "按书名"],
    ["chapters", "章节最多"],
    ["chars", "篇幅最长"]
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "novel-sort-option";
    button.classList.toggle("active", value === (state.sort || "updated"));
    button.textContent = label;
    button.addEventListener("click", () => {
      overlay.remove();
      if (!novelViews.setNovelSort?.(value)) return;
      host.ui.renderCurrentView();
      host.ui.scrollToTop();
    });
    panel.append(button);
  }
  const close = () => overlay.remove();
  backdrop.addEventListener("click", close);
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
  overlay.append(backdrop, panel);
  document.body.append(overlay);
  panel.querySelector(".active")?.focus();
}
