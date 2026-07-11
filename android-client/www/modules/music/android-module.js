import { createMusicViews } from "./music-views.js?v=20260711-music-search-focus-06";

export function createAndroidModule({ host }) {
  const musicViews = createMusicViews({
    els: host.els,
    getActiveUrl: host.getActiveUrl,
    setActiveBottom: host.ui.setActiveBottom,
    showView: host.navigation.showView
  });
  return {
    bottomKey: "music",
    rootViews: ["music"],
    routes: [
      { view: "music", render: (params, guard) => musicViews.renderMusicList(params, guard) }
    ],
    handleBack: () => musicViews.closeFullscreen?.(),
    api: { musicViews }
  };
}
