import { createToolViews } from "./tool-views.js?v=20260830-vision-recovery-66";

export function createAndroidModule({ host }) {
  const toolViews = createToolViews({
    els: host.els,
    setActiveBottom: host.ui.setActiveBottom,
    openSettings: host.ui.openSettings
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
