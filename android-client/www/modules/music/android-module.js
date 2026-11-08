import { createMusicViews } from "./music-views.js?v=assets-0a663c3bea5d";

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
    handleBack: () => musicViews.handleBack?.(),
    api: { musicViews }
  };
}
