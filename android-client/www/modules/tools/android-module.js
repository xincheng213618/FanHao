import { createToolViews } from "./tool-views.js?v=20260712-profile-settings-sheet-01";

export function createAndroidModule({ host }) {
  const toolViews = createToolViews({
    els: host.els,
    getActiveUrl: host.getActiveUrl,
    openInLibrary: host.navigation.openInLibrary,
    setActiveBottom: host.ui.setActiveBottom
  });
  return {
    bottomKey: "tools",
    rootViews: ["tools"],
    routes: [
      { view: "tools", render: (_params, guard) => toolViews.renderTxtTool(guard) }
    ],
    api: { toolViews }
  };
}
