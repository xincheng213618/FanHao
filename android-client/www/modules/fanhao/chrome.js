import { openFanhaoSheet } from "./sheet.js?v=20260721-fanhao-person-detail-02";

export const FANHAO_ROOT_VIEWS = Object.freeze(["people", "works", "rankings", "studios"]);

const CHROME_TABS = Object.freeze([
  { label: "作者", view: "people" },
  { label: "作品", view: "works" },
  { label: "榜单", view: "rankings" },
  { label: "片商", view: "studios" }
]);

export function renderFanhaoChrome({ container, view }, host, views) {
  if (view === "search") return false;
  container.dataset.module = "fanhao";
  delete container.dataset.detailView;
  if (view === "personDetail" || view === "workDetail") {
    container.dataset.detailView = view;
    renderDetailChrome(container, view, host);
    return true;
  }
  const row = document.createElement("nav");
  row.className = "fanhao-chrome-row";
  row.setAttribute("aria-label", "番号导航和排序");
  const activeView = fanhaoTabForView(view);
  const activeSort = sortConfigForView(view, views);

  for (const tab of CHROME_TABS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "fanhao-chrome-tag";
    const active = tab.view === activeView;
    const opensSort = tab.view === view && Boolean(activeSort?.options.length);
    button.classList.toggle("active", active);
    button.classList.toggle("has-menu", opensSort);
    if (opensSort) {
      const sortLabel = activeSort.options.find((option) => option.value === activeSort.value)?.label || "默认排序";
      button.setAttribute("aria-label", `${tab.label}，当前${sortLabel}，点按选择排序`);
      button.title = `${tab.label}排序 · ${sortLabel}`;
      button.innerHTML = `<span>${tab.label}</span><svg aria-hidden="true" viewBox="0 0 12 12"><path d="m2.5 4.25 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    } else {
      button.textContent = tab.label;
    }
    button.addEventListener("click", () => {
      if (view === tab.view) {
        if (activeSort?.options.length) openSortDialog(host, activeSort);
        else host.ui.scrollToTop();
        return;
      }
      host.navigation.showView(tab.view, {}, { resetStack: true });
      host.ui.scrollToTop();
    });
    row.append(button);
  }

  const search = document.createElement("button");
  search.type = "button";
  search.className = "fanhao-chrome-icon";
  search.setAttribute("aria-label", "搜索番号、作品或作者");
  search.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m16 16 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  search.addEventListener("click", () => {
    host.navigation.showView("search", { query: "" }, { push: true });
    host.ui.scrollToTop();
  });
  row.append(search);
  container.append(row);
  return true;
}

function renderDetailChrome(container, view, host) {
  const row = document.createElement("nav");
  row.className = "fanhao-detail-chrome-row";
  row.setAttribute("aria-label", view === "personDetail" ? "作者详情导航" : "作品详情导航");
  const back = document.createElement("button");
  back.type = "button";
  back.className = "fanhao-detail-chrome-back";
  back.setAttribute("aria-label", "返回上一页");
  back.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m14.5 5-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  back.addEventListener("click", () => host.navigation.goBack());
  const title = document.createElement("strong");
  title.className = "fanhao-detail-chrome-title";
  title.dataset.fanhaoDetailTitle = "";
  title.textContent = view === "personDetail" ? "作者详情" : "作品详情";
  row.append(back, title);
  container.append(row);
}

function fanhaoTabForView(view) {
  if (view === "people" || view === "personDetail") return "people";
  if (view === "rankings") return "rankings";
  if (view === "studios" || view === "studioDetail") return "studios";
  return "works";
}

function sortConfigForView(view, views) {
  if (view === "people") {
    return {
      title: "作者排序",
      options: views.peopleViews.getSortOptions(),
      value: views.peopleViews.getSortMode(),
      select: (value) => views.peopleViews.setSortMode(value)
    };
  }
  if (view === "works" || view === "rankings") {
    return {
      title: view === "rankings" ? "榜单排序" : "作品排序",
      options: views.workViews.getSortOptions(view),
      value: views.workViews.getSortMode(view),
      select: (value) => views.workViews.setSortMode(view, value)
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
