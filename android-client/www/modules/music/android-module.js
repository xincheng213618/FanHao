import { createMusicViews } from "./music-views.js?v=assets-0f97d6765d71";

export function createAndroidModule({ host }) {
  const musicViews = createMusicViews({
    els: host.els,
    getActiveUrl: host.getActiveUrl,
    setActiveBottom: host.ui.setActiveBottom,
    showView: host.navigation.showView,
    replaceViewParams: host.navigation.replaceViewParams
  });
  return {
    bottomKey: "novels",
    rootViews: ["music"],
    routes: [
      { view: "music", render: (params, guard) => musicViews.renderMusicList(params, guard) }
    ],
    deactivate: () => musicViews.deactivate(),
    handleBack: () => musicViews.closeFullscreen?.(),
    api: { musicViews }
  };
}
