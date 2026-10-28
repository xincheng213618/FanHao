import { createShortVideoViews } from "./index.js?v=assets-22080e82f167";
import { DEFAULT_SORT, FOLLOWING_AUTHOR_SORT_OPTIONS, SHORT_VIDEO_SORT_OPTIONS, normalizeFollowingAuthorFilter, normalizeFollowingAuthorSort, normalizeSearchTab, normalizeSortForSource, normalizeSource } from "./shared.js?v=assets-22080e82f167";

const sortDialogClosers = new WeakMap();

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
    handleBack: () => closeSortDialog(),
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
  const tabs = document.createElement("div");
  tabs.className = "short-video-chrome-tabs";

  const activeGroup = shortVideoGroup(params);
  for (const group of [
    { label: "内容", items: [["recommended", "推荐"], ["liked", "喜欢"], ["history", "历史"], ["all", "全部"]] },
    { label: "作者", items: [["following", "关注"], ["authors", "作者"]] }
  ]) {
    const section = document.createElement("div");
    section.className = "short-video-chrome-group";
    section.setAttribute("aria-label", group.label);
    for (const [value, label] of group.items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "short-video-chrome-tag";
      button.classList.toggle("active", value === activeGroup);
      button.textContent = label;
      button.addEventListener("click", () => {
        if (value === activeGroup) {
          openSortDialog(host, params, button);
          return;
        }
        host.navigation.showView("shortVideos", {
          query: "",
          author: "all",
          source: value,
          sort: normalizeSortForSource(value, params.sort),
          ...(value === "following" ? {
            authorSort: normalizeFollowingAuthorSort(params.authorSort),
            authorFilter: normalizeFollowingAuthorFilter(params.authorFilter)
          } : {}),
          ...(value === "authors" ? { account: shortVideoViews.getSearchState?.().authorAccountStatus || "all" } : {})
        }, { resetStack: true });
        host.ui.scrollToTop();
      });
      section.append(button);
    }
    tabs.append(section);
  }

  const search = document.createElement("button");
  search.type = "button";
  search.className = "short-video-chrome-icon";
  search.setAttribute("aria-label", "搜索短视频");
  search.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m16 16 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  search.addEventListener("click", () => openShortVideoSearch(host, shortVideoViews));
  row.append(tabs, search);

  container.append(row);
  return true;
}

function openShortVideoSearch(host, shortVideoViews, overrides = {}) {
  const state = { ...(shortVideoViews.getSearchState?.() || {}), ...(overrides || {}) };
  const source = shortVideoGroup(state);
  const authorScoped = ["following", "authors"].includes(source);
  host.navigation.showView("shortVideoSearch", {
    query: "",
    author: "all",
    source: authorScoped ? source : "all",
    tab: authorScoped ? "authors" : normalizeSearchTab(state.searchTab),
    sort: normalizeSortForSource(source, state.sort),
    ...(source === "authors" ? { account: state.authorAccountStatus || "all" } : {})
  }, { push: true });
  host.ui.scrollToTop();
}

function shortVideoGroup(params = {}) {
  if (String(params.author || "all") !== "all" || String(params.source || "") === "authors") return "authors";
  const source = normalizeSource(params.source || "liked");
  if (source === "following") return "following";
  return ["recommended", "history", "all"].includes(source) ? source : "liked";
}

function closeSortDialog(restoreFocus = true) {
  const overlay = document.querySelector(".short-video-sort-overlay");
  if (!overlay) return false;
  const close = sortDialogClosers.get(overlay);
  if (close) return close(restoreFocus);
  overlay.remove();
  return true;
}

function openSortDialog(host, params = {}, opener = null) {
  closeSortDialog(false);
  const overlay = document.createElement("div");
  overlay.className = "short-video-sort-overlay";
  const ownsDialog = () => document.querySelector(".short-video-sort-overlay") === overlay;
  const close = (restoreFocus = true) => {
    if (!ownsDialog()) return false;
    overlay.remove();
    if (restoreFocus && opener?.isConnected) opener.focus();
    return true;
  };
  sortDialogClosers.set(overlay, close);
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
    : normalizeSortForSource(params.source, params.sort || DEFAULT_SORT);
  const sortOptions = following ? FOLLOWING_AUTHOR_SORT_OPTIONS : SHORT_VIDEO_SORT_OPTIONS;
  for (const [value, label] of sortOptions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "short-video-sort-option";
    button.classList.toggle("active", value === activeSort);
    button.textContent = label;
    button.addEventListener("click", () => {
      if (!close(false)) return;
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
      if (!close(false)) return;
      host.navigation.showView("shortVideos", {
        ...params,
        authorFilter: unlikedOnly ? "all" : "unliked"
      }, { skipHistory: true, replaceHistory: true });
      host.ui.scrollToTop();
    });
    panel.append(filter);
  }
  backdrop.addEventListener("click", () => close());
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && close()) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
  overlay.append(backdrop, panel);
  document.body.append(overlay);
  panel.querySelector(".active")?.focus();
}
