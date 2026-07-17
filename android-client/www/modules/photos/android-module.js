import { createChannelViews } from "../../platform/content-index/channel-views.js?v=20260717-photo-scroll-intent-02";

const DEFAULT_CATEGORY = "我喜欢的";
const CATEGORY_PRIORITY = [DEFAULT_CATEGORY, "all", "[XIUREN] 秀人网", "[COS]", "内购私拍", "日本写真集", "韩国写真集", "国模"];
const CATEGORY_LABELS = new Map([[DEFAULT_CATEGORY, "我喜欢的"], ["all", "全部"], ["[XIUREN] 秀人网", "秀人网"], ["[COS]", "COS"]]);

export function createAndroidModule({ host }) {
  const search = createSearchController(host);
  const chrome = createPhotoChrome(host);
  const channelViews = createChannelViews(createChannelContext(host, chrome.update));
  return {
    bottomKey: "photo",
    rootViews: ["channel"],
    routes: [
      { view: "channel", match: (params) => ["photo", "manga"].includes(host.normalizeChannelMode(params.mode)), render: (params, guard) => channelViews.renderChannel(params, guard) },
      { view: "photoDetail", render: (params, guard) => channelViews.renderPhotoDetail(params.id, guard) },
      { view: "mangaDetail", render: (params, guard) => channelViews.renderMangaDetail(params.id, guard) },
      { view: "mangaChapter", render: (params, guard) => channelViews.renderMangaChapter(params.id, params.chapterIndex, guard) }
    ],
    search,
    renderChrome: chrome.render,
    api: { channelViews }
  };
}

function createChannelContext(host, updateChrome) {
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
    showMangaDetail: (id) => host.navigation.showView("mangaDetail", { id }, { push: true }),
    showMangaChapter: (id, chapterIndex) => host.navigation.showView("mangaChapter", { id, chapterIndex }, { push: true }),
    showMediaDetail: (id, mode) => host.navigation.showView("mediaDetail", { id, mode }, { push: true }),
    setActiveBottom: host.ui.setActiveBottom,
    renderCurrentView: host.ui.renderCurrentView,
    renderCurrentViewPreservingScroll: host.ui.renderCurrentViewPreservingScroll,
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
  return {
    update(kind, options = {}) {
      if (kind === "photo") latestCategory = String(options.category || latestCategory || DEFAULT_CATEGORY);
      host.ui.refreshChrome();
    },
    render({ container, view, params }) {
      if (view !== "channel" || host.normalizeChannelMode(params.mode) !== "photo") return false;
      const activeCategory = String(params.category || latestCategory || DEFAULT_CATEGORY);
      container.dataset.module = "photos";
      const nav = document.createElement("nav");
      nav.className = "module-chrome-tabs photo-chrome-tabs";
      nav.setAttribute("aria-label", "图库分类");
      const categories = [...CATEGORY_PRIORITY];
      if (activeCategory && !categories.includes(activeCategory)) categories.push(activeCategory);
      for (const category of categories) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = CATEGORY_LABELS.get(category) || category.replace(/^\[[^\]]+\]\s*/, "") || category;
        button.classList.toggle("active", category === activeCategory);
        button.addEventListener("click", () => {
          const photoView = params.collection ? "collections" : params.photoView || "collections";
          host.navigation.showView("channel", {
            ...params,
            mode: "photo",
            photoView,
            collection: "",
            category,
            query: ""
          }, { skipHistory: true, replaceHistory: true });
          host.ui.scrollToTop();
        });
        nav.append(button);
      }
      container.append(nav, createPhotoSearchButton(host));
      return true;
    }
  };
}

function createPhotoSearchButton(host) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "module-chrome-search icon-only";
  button.setAttribute("aria-label", "搜索套图、人物或分类");
  button.innerHTML = '<span aria-hidden="true">⌕</span>';
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
