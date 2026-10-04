import { createChannelViews } from "../../platform/content-index/channel-views.js?v=assets-07b744082137";
import { captureMediaTrail, mediaBackTarget } from "../../js/media-navigation-state.js?v=assets-07b744082137";

export function createAndroidModule({ host }) {
  const search = createSearchController(host);
  const chrome = createMediaChrome(host);
  const handleBack = (view, params) => {
    const target = mediaBackTarget(view, params);
    if (!target) return false;
    if (host.navigation.returnToStackView()) return true;
    host.navigation.showView(target.view, target.params, { skipHistory: true, replaceHistory: true, resetStack: true });
    return true;
  };
  const channelViews = createChannelViews(createChannelContext(host, chrome.update, handleBack));
  return {
    bottomKey: "media",
    rootViews: ["channel"],
    isRootView: (view, params) => view === "channel" && !mediaBackTarget(view, params),
    routes: [
      { view: "channel", match: (params) => ["media", "movie", "tv", "anime"].includes(host.normalizeChannelMode(params.mode)), render: (params, guard) => channelViews.renderChannel(params, guard) },
      { view: "mediaDetail", render: (params, guard) => channelViews.renderMediaDetail(params.id, params.mode, guard) }
    ],
    search,
    handleBack,
    renderChrome: chrome.render,
    api: { channelViews }
  };
}

function createChannelContext(host, updateChrome, handleBack) {
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
    showMediaDetail: (id, mode) => {
      const mediaTrail = captureMediaTrail(host.navigation.currentView(), host.navigation.currentParams(), host.normalizeChannelMode(mode));
      host.navigation.showView("mediaDetail", { id, mode, ...(mediaTrail ? { mediaTrail } : {}) }, { push: true });
    },
    setActiveBottom: host.ui.setActiveBottom,
    renderCurrentView: host.ui.renderCurrentView,
    renderCurrentViewPreservingScroll: host.ui.renderCurrentViewPreservingScroll,
    goBack: host.navigation.goBack,
    getMediaViewer: () => host.mediaViewer,
    recordRecentContent: host.recent.record,
    onChannelFavoriteChange: host.favorites.onChannelFavoriteChange,
    openMediaSearch: host.ui.openSearch,
    updateModuleChrome: updateChrome,
    updateChannelQuery: host.contentIndex.updateChannelQuery,
    updateChannelParams: (updates, navigation = {}) => {
      const current = host.navigation.currentParams();
      const next = { ...current, ...updates };
      const mediaTrail = navigation.push && (next.seriesKey || next.tvView === "episodes")
        ? captureMediaTrail(host.navigation.currentView(), current, host.normalizeChannelMode(next.mode))
        : next.mediaTrail;
      host.contentIndex.updateChannelParams({ ...updates, mediaTrail }, navigation);
    },
    returnToMediaCatalog: () => handleBack(host.navigation.currentView(), host.navigation.currentParams())
  };
}

function createMediaChrome(host) {
  return {
    update() {
      host.ui.refreshChrome();
    },
    render() {
      // Bottom navigation owns media type selection. Search lives beside the
      // list count, so there is no second navigation row or empty toolbar.
      return false;
    }
  };
}

function createSearchController(host) {
  return {
    mode: "channel",
    isExpanded: (view, params, expanded) => expanded || (view === "channel" && Boolean(String(params.query || "").trim())),
    placeholder: () => "搜电影、电视剧或动漫",
    value: (view, params) => view === "channel" ? String(params.query || "") : "",
    submit(query, context) {
      const detailMode = host.normalizeChannelMode(context.params.mode);
      const params = context.view === "channel" ? context.params : { mode: detailMode === "tv" || detailMode === "anime" ? detailMode : "movie" };
      host.contentIndex.updateSearch(params, query);
    },
    close(context) {
      if (context.view !== "channel" || !String(context.params.query || "").trim()) return false;
      host.navigation.showView("channel", { ...context.params, query: "" }, { skipHistory: true, replaceHistory: true });
      return true;
    }
  };
}
