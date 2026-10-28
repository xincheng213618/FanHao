import { createChannelViews } from "../../platform/content-index/channel-views.js?v=assets-22080e82f167";
import { PHOTO_ALBUM_SORT_OPTIONS, PHOTO_COLLECTION_SORT_OPTIONS } from "../../platform/content-index/photo-catalog.js";
import { openMobileActionSheet } from "../../js/mobile-action-sheet.js?v=assets-22080e82f167";

const DEFAULT_CATEGORY = "我喜欢的";
const CATEGORY_PRIORITY = [DEFAULT_CATEGORY, "all", "[XIUREN] 秀人网", "[COS]", "内购私拍", "日本写真集", "韩国写真集", "国模"];
const CATEGORY_LABELS = new Map([[DEFAULT_CATEGORY, "我喜欢的"], ["all", "全部"], ["[XIUREN] 秀人网", "秀人网"], ["[COS]", "COS"]]);

export function createAndroidModule({ host }) {
  const search = createSearchController(host);
  const chrome = createPhotoChrome(host);
  const isPhotoCollection = (view, params = {}) => view === "channel"
    && host.normalizeChannelMode(params.mode) === "photo" && Boolean(params.collection);
  const showPhotoCatalog = (category) => {
    // Use the app stack, not raw WebView history: returning from a photo detail
    // may have replaced its history entry with another copy of this collection.
    if (host.navigation.returnToStackView()) return;
    const params = host.navigation.currentParams();
    host.navigation.showView("channel", {
      mode: "photo", photoView: "collections", category: category || params.category || DEFAULT_CATEGORY,
      collection: "", person: "", query: "", sort: "count"
    }, { skipHistory: true, replaceHistory: true, resetStack: true, restoreScrollY: 0 });
  };
  const channelViews = createChannelViews(createChannelContext(host, chrome.update, showPhotoCatalog));
  return {
    bottomKey: "photo",
    rootViews: ["channel"],
    isRootView: (view, params) => !isPhotoCollection(view, params),
    handleBack(view, params) {
      if (!isPhotoCollection(view, params)) return false;
      showPhotoCatalog(params.category);
      return true;
    },
    routes: [
      { view: "channel", match: (params) => ["photo", "manga"].includes(host.normalizeChannelMode(params.mode)), render: (params, guard) => channelViews.renderChannel(params, guard) },
      { view: "photoDetail", render: (params, guard) => channelViews.renderPhotoDetail(params.id, guard) },
      { view: "mangaDetail", render: (params, guard) => channelViews.renderMangaDetail(params.id, guard) },
      { view: "mangaChapter", render: (params, guard) => channelViews.renderMangaChapter(params.id, params.chapterIndex, guard) }
    ],
    search,
    deactivate() {
      chrome.deactivate();
      channelViews.deactivate();
    },
    renderChrome: chrome.render,
    api: { channelViews }
  };
}

function createChannelContext(host, updateChrome, showPhotoCatalog) {
  return {
    els: host.els,
    getActiveUrl: host.getActiveUrl,
    getChannelLimit: host.limits.getChannel,
    increaseChannelLimit: host.limits.increaseChannel,
    getPhotoImageLimit: host.limits.getPhotoImages,
    increasePhotoImageLimit: host.limits.increasePhotoImages,
    getMangaImageLimit: host.limits.getMangaImages,
    increaseMangaImageLimit: host.limits.increaseMangaImages,
    openInLibrary: host.navigation.openInLibrary,
    showPhotoDetail: (id) => host.navigation.showView("photoDetail", { id }, { push: true }),
    showPhotoCatalog,
    showMangaDetail: (id) => host.navigation.showView("mangaDetail", { id }, { push: true }),
    showMangaLibrary: () => host.navigation.showView("channel", { mode: "manga" }, { resetStack: true }),
    showMangaCatalog: (id) => host.navigation.showView("mangaDetail", { id }, {
      skipHistory: true,
      replaceHistory: true,
      resetStack: true
    }),
    showMangaChapter: (id, chapterIndex, options = {}) => host.navigation.showView(
      "mangaChapter",
      { id, chapterIndex },
      options.replace ? { skipHistory: true, replaceHistory: true } : { push: true }
    ),
    showMediaDetail: (id, mode) => host.navigation.showView("mediaDetail", { id, mode }, { push: true }),
    setActiveBottom: host.ui.setActiveBottom,
    renderCurrentView: host.ui.renderCurrentView,
    renderCurrentViewPreservingScroll: host.ui.renderCurrentViewPreservingScroll,
    requestConfirmation: host.ui.confirm,
    goBack: host.navigation.goBack,
    getMediaViewer: () => host.mediaViewer,
    recordRecentContent: host.recent.record,
    onChannelFavoriteChange: host.favorites.onChannelFavoriteChange,
    updateModuleChrome: updateChrome,
    updateChannelQuery: host.contentIndex.updateChannelQuery,
    updateChannelParams: host.contentIndex.updateChannelParams
  };
}

function createPhotoChrome(host) {
  let latestCategory = DEFAULT_CATEGORY;
  let latestCategories = [];
  let categoryScrollLeft = 0;
  let chromeGeneration = 0;
  let stopWatchingWidth = () => {};
  const deactivate = () => {
    chromeGeneration++;
    stopWatchingWidth();
    stopWatchingWidth = () => {};
  };
  return {
    deactivate,
    update(kind, options = {}) {
      if (kind === "photo") {
        latestCategory = String(options.category || latestCategory || DEFAULT_CATEGORY);
        if (Array.isArray(options.facets?.categories)) latestCategories = options.facets.categories;
      }
      host.ui.refreshChrome();
    },
    render({ container, view, params }) {
      deactivate();
      if (view !== "channel" || host.normalizeChannelMode(params.mode) !== "photo") return false;
      const generation = chromeGeneration;
      const activeCategory = String(params.category || latestCategory || DEFAULT_CATEGORY);
      container.dataset.module = "photos";
      const row = document.createElement("header");
      row.className = "fanhao-feed-appbar photo-feed-appbar";
      const nav = document.createElement("nav");
      nav.className = "fanhao-primary-nav photo-chrome-tabs";
      nav.setAttribute("aria-label", "图库分类");
      const categories = [...new Set([...CATEGORY_PRIORITY, ...latestCategories.map((item) => item.value).filter(Boolean)])];
      if (activeCategory && !categories.includes(activeCategory)) categories.push(activeCategory);
      const isCurrent = () => generation === chromeGeneration && container.contains(row);
      const selectCategory = (category) => {
        if (!isCurrent()) return;
        categoryScrollLeft = nav.scrollLeft;
        if (category === activeCategory && !params.collection && !params.query && params.photoView !== "albums") {
          host.ui.scrollToTop();
          return;
        }
        host.navigation.showView("channel", {
          ...params,
          mode: "photo",
          photoView: "collections",
          collection: "",
          category,
          person: "",
          sort: "count",
          query: ""
        }, { skipHistory: true, replaceHistory: true });
        host.ui.scrollToTop();
      };
      for (const category of categories) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = photoCategoryLabel(category);
        button.setAttribute("aria-label", photoCategoryLabel(category));
        button.classList.toggle("active", category === activeCategory);
        if (category === activeCategory) button.setAttribute("aria-current", "page");
        button.addEventListener("click", () => selectCategory(category));
        nav.append(button);
      }
      const actions = document.createElement("div");
      actions.className = "fanhao-feed-appbar-actions";
      actions.append(createPhotoCategoryButton(categories, activeCategory, selectCategory, () => {
        if (!isCurrent()) return false;
        categoryScrollLeft = nav.scrollLeft;
        return true;
      }), createPhotoSortButton(host, params), createPhotoSearchButton(host));
      row.append(nav, actions);
      container.append(row);
      nav.scrollLeft = categoryScrollLeft;
      const revealSelectedCategory = () => {
        if (!isCurrent() || nav.clientWidth <= 0) return;
        const selected = nav.querySelector("[aria-current='page']");
        if (!selected) return;
        if (selected.offsetLeft < nav.scrollLeft) nav.scrollLeft = selected.offsetLeft;
        else if (selected.offsetLeft + selected.offsetWidth > nav.scrollLeft + nav.clientWidth) {
          nav.scrollLeft = selected.offsetLeft + selected.offsetWidth - nav.clientWidth;
        }
        categoryScrollLeft = nav.scrollLeft;
      };
      revealSelectedCategory();
      let categoryWidth = nav.clientWidth;
      const revealAfterResize = () => {
        if (!isCurrent() || nav.clientWidth <= 0 || nav.clientWidth === categoryWidth) return;
        categoryWidth = nav.clientWidth;
        revealSelectedCategory();
      };
      if (typeof window.ResizeObserver === "function") {
        const observer = new window.ResizeObserver(revealAfterResize);
        observer.observe(nav);
        stopWatchingWidth = () => observer.disconnect();
      } else {
        window.addEventListener("resize", revealAfterResize, { passive: true });
        stopWatchingWidth = () => window.removeEventListener("resize", revealAfterResize);
      }
      nav.addEventListener("scroll", () => {
        if (isCurrent()) categoryScrollLeft = nav.scrollLeft;
      }, { passive: true });
      return true;
    }
  };
}

function photoCategoryLabel(category) {
  return CATEGORY_LABELS.get(category) || category.replace(/^\[[^\]]+\]\s*/, "") || category;
}

function createPhotoCategoryButton(categories, activeCategory, selectCategory, canOpen) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "fanhao-feed-appbar-action photo-category-action";
  button.textContent = "分类";
  button.setAttribute("aria-label", `全部图库分类，当前${photoCategoryLabel(activeCategory)}`);
  button.setAttribute("aria-haspopup", "dialog");
  button.addEventListener("click", () => {
    if (!canOpen()) return;
    const sheet = openMobileActionSheet({
      title: "全部图库分类", trigger: button, value: activeCategory,
      options: categories.map((category) => ({
        value: category, label: photoCategoryLabel(category), select: () => {
          selectCategory(category);
          if (document.body.contains(button)) button.focus?.({ preventScroll: true });
        }
      }))
    });
    sheet.panel.classList.add("photo-category-sheet");
    sheet.header.classList.add("photo-category-sheet-head");
    sheet.closeButton.classList.add("photo-category-close");
    sheet.closeButton.setAttribute("aria-label", "关闭图库分类");
    const selected = sheet.panel.querySelector(".active");
    selected?.setAttribute("aria-current", "page");
    selected?.scrollIntoView?.({ block: "nearest" });
  });
  return button;
}

function createPhotoSortButton(host, params) {
  const collections = !params.collection && params.photoView !== "albums";
  const options = collections ? PHOTO_COLLECTION_SORT_OPTIONS : PHOTO_ALBUM_SORT_OPTIONS;
  const value = params.sort || (collections ? "count" : "updated");
  const label = options.find(([key]) => key === value)?.[1] || "最近更新";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "fanhao-feed-appbar-action photo-sort-action";
  button.setAttribute("aria-label", `套图排序，当前${label}`);
  button.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M7 6h10M9 12h6m-4 6h2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  button.addEventListener("click", () => openMobileActionSheet({
    title: "套图排序", value,
    options: options.map(([key, text]) => ({
      value: key, label: text,
      select: () => {
        host.contentIndex.updateChannelParams({ sort: key });
        host.ui.scrollToTop();
      }
    }))
  }));
  return button;
}

function createPhotoSearchButton(host) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "fanhao-feed-appbar-action photo-search-action";
  button.setAttribute("aria-label", "搜索套图、人物或分类");
  button.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m16 16 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  button.addEventListener("click", host.ui.openSearch);
  return button;
}

function createSearchController(host) {
  return {
    mode: "channel",
    isExpanded: (view, params, expanded) => expanded || (view === "channel" && Boolean(String(params.query || "").trim())),
    placeholder: () => "搜套图、人物或分类",
    value: (view, params) => view === "channel" ? String(params.query || "") : "",
    submit(query, context) {
      const params = context.view === "channel"
        ? context.params
        : { mode: context.view.startsWith("manga") ? "manga" : "photo", photoView: "albums" };
      host.contentIndex.updatePhotoSearch(params, query);
    },
    close(context) {
      if (context.view !== "channel" || !String(context.params.query || "").trim()) return false;
      host.navigation.showView("channel", { ...context.params, query: "" }, { skipHistory: true, replaceHistory: true });
      return true;
    }
  };
}
