import { openFanhaoSheet } from "./sheet.js?v=assets-0f97d6765d71";

export const FANHAO_ROOT_VIEWS = Object.freeze(["people", "works", "rankings", "categories", "codePrefixes", "studios"]);

const ROOT_TITLES = Object.freeze({
  people: "演员",
  works: "番号",
  rankings: "榜单",
  categories: "番号",
  codePrefixes: "番号前缀",
  studios: "厂牌"
});

export function renderFanhaoChrome({ container, params, view }, host, views) {
  if (view === "search") return false;
  container.dataset.module = "fanhao";
  delete container.dataset.detailView;
  if (view === "personDetail" || view === "workDetail") {
    container.dataset.detailView = view;
    renderDetailChrome(container, view, host);
    return true;
  }

  renderFeedAppBar(container, view, params, host, views);
  return true;
}

function renderFeedAppBar(container, view, params, host, views) {
  const row = document.createElement("header");
  row.className = "fanhao-feed-appbar";
  const primary = usesPrimaryLibraryNavigation(view)
    ? createPrimaryLibraryNavigation(view, params, host)
    : createFeedTitle(view, params);
  const actions = document.createElement("div");
  actions.className = "fanhao-feed-appbar-actions";
  const sort = sortConfigForView(view, params, views);

  if (sort?.options.length) {
    const sortButton = document.createElement("button");
    sortButton.type = "button";
    sortButton.className = "fanhao-feed-appbar-action";
    const selected = sort.options.find((option) => option.value === sort.value);
    const selectedLabel = selected?.label || "默认排序";
    sortButton.setAttribute("aria-label", `排序，当前${selectedLabel}`);
    sortButton.title = `排序 · ${selectedLabel}`;
    sortButton.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M7 6h10M9 12h6m-4 6h2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    sortButton.addEventListener("click", () => openSortDialog(host, sort));
    actions.append(sortButton);
  }

  const search = document.createElement("button");
  search.type = "button";
  search.className = "fanhao-feed-appbar-action";
  search.setAttribute("aria-label", `搜索${feedTitle(view, params)}`);
  search.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m16 16 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  search.addEventListener("click", () => {
    host.navigation.showView("search", { query: "", category: searchCategoryForView(view, params) }, { push: true });
    host.ui.scrollToTop();
  });
  actions.append(search);
  row.append(primary, actions);
  container.append(row);
}

function createFeedTitle(view, params) {
  const title = document.createElement("strong");
  title.className = "fanhao-feed-appbar-title";
  title.textContent = feedTitle(view, params);
  return title;
}

function usesPrimaryLibraryNavigation(view) {
  return view === "people" || view === "rankings" || view === "categories";
}

function createPrimaryLibraryNavigation(view, params, host) {
  const western = searchCategoryForView(view, params) === "western";
  const navigation = document.createElement("nav");
  navigation.className = "fanhao-primary-nav";
  navigation.setAttribute("aria-label", western ? "欧美浏览方式" : "番号浏览方式");
  const items = western
    ? [
        { view: "people", label: "人物", params: { scope: "western" } },
        { view: "categories", label: "作品", params: { category: "western" } }
      ]
    : [
        { view: "people", label: "人物", params: { scope: "main" } },
        { view: "categories", label: "番号", params: { category: "censored" } },
        { view: "rankings", label: "排行", params: {} }
      ];
  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.label;
    const active = view === item.view;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    button.addEventListener("click", () => {
      if (active) {
        host.ui.scrollToTop();
        return;
      }
      host.navigation.showView(item.view, item.params, { resetStack: true });
      host.ui.scrollToTop();
    });
    navigation.append(button);
  }
  return navigation;
}

function renderDetailChrome(container, view, host) {
  const row = document.createElement("nav");
  row.className = "fanhao-detail-chrome-row";
  row.setAttribute("aria-label", view === "personDetail" ? "演员详情导航" : "作品详情导航");
  const back = document.createElement("button");
  back.type = "button";
  back.className = "fanhao-detail-chrome-back";
  back.setAttribute("aria-label", "返回上一页");
  back.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m14.5 5-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  back.addEventListener("click", () => host.navigation.goBack());
  const title = document.createElement("strong");
  title.className = "fanhao-detail-chrome-title";
  title.dataset.fanhaoDetailTitle = "";
  title.textContent = view === "personDetail" ? "演员详情" : "作品详情";
  row.append(back, title);
  container.append(row);
}

function feedTitle(view, params = {}) {
  if (view === "categories") return searchCategoryForView(view, params) === "western" ? "欧美" : "番号";
  if (view === "works" && String(params.favorite || "") === "1") return "收藏";
  return ROOT_TITLES[view] || "番号";
}

function searchCategoryForView(view, params = {}) {
  if (view === "people") return String(params.scope || "main").toLowerCase() === "western" ? "western" : "censored";
  return view === "categories" && String(params.category || "").toLowerCase() === "western" ? "western" : "censored";
}

function sortConfigForView(view, params, views) {
  if (view === "people") {
    return {
      title: "演员排序",
      options: views.peopleViews.getSortOptions(),
      value: views.peopleViews.getSortMode(),
      select: (value) => views.peopleViews.setSortMode(value)
    };
  }
  if (view === "rankings") {
    const rankingMenu = views.workViews.getRankingMenu();
    return { title: "选择榜单年代", ...rankingMenu };
  }
  if (view === "works" || view === "categories") {
    const category = searchCategoryForView(view, params);
    return {
      title: view === "categories" && category === "western" ? "欧美作品排序" : "番号作品排序",
      options: views.workViews.getSortOptions(view),
      value: views.workViews.getSortMode(view),
      select: (value) => views.workViews.setSortMode(view, value)
    };
  }
  if (view === "studios") {
    return {
      title: "厂牌排序",
      options: views.workViews.getStudioSortOptions(),
      value: views.workViews.getStudioSortMode(),
      select: (value) => views.workViews.setStudioSortMode(value)
    };
  }
  return null;
}

function openSortDialog(host, config) {
  openFanhaoSheet({
    title: config.title,
    value: config.value,
    options: config.options.map((option) => ({
      ...option,
      select: () => {
        if (config.select(option.value) !== false) host.ui.scrollToTop();
      }
    }))
  });
}
