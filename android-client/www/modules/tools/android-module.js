import { createToolViews } from "./tool-views.js?v=20260818-vision-exploration-01";

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
