import { createChannelViews } from "../../platform/content-index/channel-views.js?v=20260813-tv-series-work-01-5c293a6f8867";

export function createAndroidModule({ host }) {
  const search = createSearchController(host);
  const chrome = createMediaChrome(host);
  const channelViews = createChannelViews(createChannelContext(host, chrome.update));
  return {
    bottomKey: "media",
    rootViews: ["channel"],
    routes: [
      { view: "channel", match: (params) => ["media", "movie", "tv"].includes(host.normalizeChannelMode(params.mode)), render: (params, guard) => channelViews.renderChannel(params, guard) },
      { view: "mediaDetail", render: (params, guard) => channelViews.renderMediaDetail(params.id, params.mode, guard) }
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

function createMediaChrome(host) {
  return {
    update() {
      host.ui.refreshChrome();
    },
    render({ container, view, params }) {
      if (view !== "channel" || !["media", "movie", "tv"].includes(host.normalizeChannelMode(params.mode))) return false;
      const activeMode = host.normalizeChannelMode(params.mode) === "tv" ? "tv" : "movie";
      container.dataset.module = "media";
      const nav = document.createElement("nav");
      nav.className = "module-chrome-tabs media-chrome-tabs";
      nav.setAttribute("aria-label", "影视类型");
      for (const item of [{ label: "电影", mode: "movie" }, { label: "电视剧", mode: "tv" }]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = item.label;
        button.classList.toggle("active", item.mode === activeMode);
        button.addEventListener("click", () => {
          host.navigation.showView("channel", { mode: item.mode }, { resetStack: true });
          host.ui.scrollToTop();
        });
        nav.append(button);
      }
      container.append(nav, createMediaSearchButton(host));
      return true;
    }
  };
}

function createMediaSearchButton(host) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "module-chrome-search icon-only";
  button.setAttribute("aria-label", "搜索电影或电视剧");
  button.innerHTML = '<span aria-hidden="true">⌕</span>';
  button.addEventListener("click", host.ui.openSearch);
  return button;
}

function createSearchController(host) {
  return {
    mode: "channel",
    isExpanded: (view, params, expanded) => expanded || (view === "channel" && Boolean(String(params.query || "").trim())),
    placeholder: () => "搜电影或电视剧",
    value: (view, params) => view === "channel" ? String(params.query || "") : "",
    submit(query, context) {
      const detailMode = host.normalizeChannelMode(context.params.mode);
      const params = context.view === "channel" ? context.params : { mode: detailMode === "tv" ? "tv" : "movie" };
      host.contentIndex.updateSearch(params, query);
    },
    close(context) {
      if (context.view !== "channel" || !String(context.params.query || "").trim()) return false;
      host.navigation.showView("channel", { ...context.params, query: "" }, { skipHistory: true, replaceHistory: true });
      return true;
    }
  };
}
