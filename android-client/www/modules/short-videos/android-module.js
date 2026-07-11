import { createShortVideoViews } from "./index.js?v=20260712-native-short-video-only-02";
import { DEFAULT_SORT, SHORT_VIDEO_SORT_OPTIONS, normalizeSort } from "./shared.js?v=20260712-short-video-search-page-07";

export function createAndroidModule({ host }) {
  const shortVideoViews = createShortVideoViews({
    els: host.els,
    getActiveUrl: host.getActiveUrl,
    goBack: host.navigation.goBack,
    openSettings: host.ui.openSettings,
    setActiveBottom: host.ui.setActiveBottom,
    showView: host.navigation.showView
  });

  window.addEventListener("fanhaoOpenShortVideoSearch", (event) => {
    openShortVideoSearch(host, shortVideoViews, event.detail?.state || {});
  });

  return {
    bottomKey: "shortVideos",
    rootViews: ["shortVideos"],
    routes: [
      { view: "shortVideos", render: (params, guard) => shortVideoViews.renderList(params, guard) },
      { view: "shortVideoSearch", render: (params, guard) => shortVideoViews.renderSearch(params, guard) }
    ],
    renderChrome: (context) => renderShortVideoChrome(context, host, shortVideoViews),
    deactivate: () => shortVideoViews.deactivate?.(),
    api: { shortVideoViews }
  };
}

function renderShortVideoChrome({ container, view, params }, host, shortVideoViews) {
  if (view !== "shortVideos") return false;
  container.dataset.module = "short-videos";
  const row = document.createElement("nav");
  row.className = "short-video-chrome-row";
  row.setAttribute("aria-label", "短视频导航和排序");

  const activeGroup = shortVideoGroup(params);
  for (const [value, label] of [["all", "全部"], ["liked", "我的喜欢"], ["authors", "作者"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "short-video-chrome-tag";
    button.classList.toggle("active", value === activeGroup);
    button.textContent = label;
    button.addEventListener("click", () => {
      if (value === activeGroup) {
        openSortDialog(host, params);
        return;
      }
      host.navigation.showView("shortVideos", {
        query: "",
        author: "all",
        source: value,
        sort: normalizeSort(params.sort)
      }, { resetStack: true });
      host.ui.scrollToTop();
    });
    row.append(button);
  }

  const search = document.createElement("button");
  search.type = "button";
  search.className = "short-video-chrome-icon";
  search.setAttribute("aria-label", "搜索短视频");
  search.innerHTML = '<span aria-hidden="true">⌕</span>';
  search.addEventListener("click", () => openShortVideoSearch(host, shortVideoViews));
  row.append(search);

  container.append(row);
  return true;
}

function openShortVideoSearch(host, shortVideoViews, overrides = {}) {
  const state = { ...(shortVideoViews.getSearchState?.() || {}), ...(overrides || {}) };
  host.navigation.showView("shortVideoSearch", {
    query: "",
    author: "all",
    source: overrides.source || "all",
    sort: normalizeSort(state.sort)
  }, { push: true });
  host.ui.scrollToTop();
}

function shortVideoGroup(params = {}) {
  if (String(params.author || "all") !== "all" || String(params.source || "") === "authors") return "authors";
  return String(params.source || "liked") === "all" ? "all" : "liked";
}

function openSortDialog(host, params = {}) {
  document.querySelector(".short-video-sort-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.className = "short-video-sort-overlay";
  const backdrop = document.createElement("button");
  backdrop.type = "button";
  backdrop.className = "short-video-sort-backdrop";
  backdrop.setAttribute("aria-label", "关闭排序");
  const panel = document.createElement("section");
  panel.className = "short-video-sort-sheet";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "短视频排序");
  const title = document.createElement("strong");
  title.textContent = "排序";
  panel.append(title);
  const activeSort = normalizeSort(params.sort || DEFAULT_SORT);
  for (const [value, label] of SHORT_VIDEO_SORT_OPTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "short-video-sort-option";
    button.classList.toggle("active", value === activeSort);
    button.textContent = label;
    button.addEventListener("click", () => {
      overlay.remove();
      host.navigation.showView("shortVideos", { ...params, sort: value }, { skipHistory: true, replaceHistory: true });
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
