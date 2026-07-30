import { createMusicViews } from "./music-views.js?v=20260730-music-home-ui-40";

export function createAndroidModule({ host }) {
  const musicViews = createMusicViews({
    els: host.els,
    getActiveUrl: host.getActiveUrl,
    setActiveBottom: host.ui.setActiveBottom,
    showView: host.navigation.showView,
    replaceViewParams: host.navigation.replaceViewParams
  });
  return {
    bottomKey: "music",
    rootViews: ["music"],
    routes: [
      { view: "music", render: (params, guard) => musicViews.renderMusicList(params, guard) }
    ],
    deactivate: () => musicViews.deactivate(),
    handleBack: () => musicViews.closeFullscreen?.(),
    api: { musicViews }
  };
}
