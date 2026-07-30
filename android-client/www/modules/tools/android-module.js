import { createToolViews } from "./tool-views.js?v=20260730-auto-update-ui-50";

export function createAndroidModule({ host }) {
  const toolViews = createToolViews({
    els: host.els,
    setActiveBottom: host.ui.setActiveBottom
  });
  return {
    bottomKey: "tools",
    rootViews: ["tools"],
    routes: [
      { view: "tools", render: () => toolViews.renderTools() }
    ],
    api: { toolViews }
  };
}
