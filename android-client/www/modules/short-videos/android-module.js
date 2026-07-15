import { createShortVideoViews } from "./index.js?v=20260713-follow-toggle-08";
import { DEFAULT_SORT, FOLLOWING_AUTHOR_SORT_OPTIONS, SHORT_VIDEO_SORT_OPTIONS, normalizeFollowingAuthorFilter, normalizeFollowingAuthorSort, normalizeSearchTab, normalizeSort } from "./shared.js?v=20260713-follow-toggle-08";

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
  for (const [value, label] of [["all", "全部"], ["liked", "我的喜欢"], ["following", "我的关注"], ["authors", "作者"]]) {
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
        sort: normalizeSort(params.sort),
        ...(value === "following" ? {
          authorSort: normalizeFollowingAuthorSort(params.authorSort),
          authorFilter: normalizeFollowingAuthorFilter(params.authorFilter)
        } : {})
      }, { resetStack: true });
      host.ui.scrollToTop();
    });
    row.append(button);
  }

  const search = document.createElement("button");
  search.type = "button";
  search.className = "short-video-chrome-icon";
  search.setAttribute("aria-label", "搜索短视频");
  search.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m16 16 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
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
    source: "all",
    tab: normalizeSearchTab(state.searchTab),
    sort: normalizeSort(state.sort)
  }, { push: true });
  host.ui.scrollToTop();
}

function shortVideoGroup(params = {}) {
  if (String(params.author || "all") !== "all" || String(params.source || "") === "authors") return "authors";
  const source = String(params.source || "liked");
  if (source === "following") return "following";
  return source === "all" ? "all" : "liked";
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
  const following = shortVideoGroup(params) === "following";
  title.textContent = following ? "我的关注排序" : "排序";
  panel.append(title);
  const activeSort = following
    ? normalizeFollowingAuthorSort(params.authorSort)
    : normalizeSort(params.sort || DEFAULT_SORT);
  const sortOptions = following ? FOLLOWING_AUTHOR_SORT_OPTIONS : SHORT_VIDEO_SORT_OPTIONS;
  for (const [value, label] of sortOptions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "short-video-sort-option";
    button.classList.toggle("active", value === activeSort);
    button.textContent = label;
    button.addEventListener("click", () => {
      overlay.remove();
      host.navigation.showView("shortVideos", {
        ...params,
        ...(following ? { authorSort: value } : { sort: value })
      }, { skipHistory: true, replaceHistory: true });
      host.ui.scrollToTop();
    });
    panel.append(button);
  }
  if (following) {
    const unlikedOnly = normalizeFollowingAuthorFilter(params.authorFilter) === "unliked";
    const filter = document.createElement("button");
    filter.type = "button";
    filter.className = "short-video-sort-option";
    filter.classList.toggle("active", unlikedOnly);
    filter.textContent = unlikedOnly ? "查看全部关注" : "只看未点赞";
    filter.addEventListener("click", () => {
      overlay.remove();
      host.navigation.showView("shortVideos", {
        ...params,
        authorFilter: unlikedOnly ? "all" : "unliked"
      }, { skipHistory: true, replaceHistory: true });
      host.ui.scrollToTop();
    });
    panel.append(filter);
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
