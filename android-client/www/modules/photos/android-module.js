import { createChannelViews } from "../../platform/content-index/channel-views.js?v=20260712-android-reflection-02";

export function createAndroidModule({ host }) {
  const channelViews = createChannelViews(createChannelContext(host));
  return {
    bottomKey: "photo",
    rootViews: ["channel"],
    routes: [
      { view: "channel", match: (params) => ["photo", "manga"].includes(host.normalizeChannelMode(params.mode)), render: (params, guard) => channelViews.renderChannel(params, guard) },
      { view: "photoDetail", render: (params, guard) => channelViews.renderPhotoDetail(params.id, guard) },
      { view: "mangaDetail", render: (params, guard) => channelViews.renderMangaDetail(params.id, guard) },
      { view: "mangaChapter", render: (params, guard) => channelViews.renderMangaChapter(params.id, params.chapterIndex, guard) }
    ],
    search: createSearchController(host),
    api: { channelViews }
  };
}

function createChannelContext(host) {
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
    setTopSecondaryTabs: host.ui.setTopSecondaryTabs,
    updateChannelQuery: host.contentIndex.updateChannelQuery,
    updateChannelParams: host.contentIndex.updateChannelParams
  };
}

function createSearchController(host) {
  return {
    mode: "channel",
    showAction: () => true,
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
