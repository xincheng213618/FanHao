import { fetchJson } from "../../js/api.js?v=assets-0f97d6765d71";
import { createToolViews } from "./tool-views.js?v=assets-0f97d6765d71";

export function createAndroidModule({ host }) {
  const toolViews = createToolViews({
    els: host.els,
    setActiveBottom: host.ui.setActiveBottom,
    openSettings: host.ui.openSettings,
    confirmAction: host.ui.confirm,
    getActiveUrl: host.getActiveUrl,
    getComputerControlStatus: (sourceUrl) => fetchJson(sourceUrl, "/api/system/control", { timeoutMs: 6000, cache: "no-store", redirect: "error" }),
    sleepComputer: (sourceUrl) => fetchJson(sourceUrl, "/api/system/control", {
      method: "POST",
      redirect: "error",
      body: { action: "sleep" },
      timeoutMs: 12000
    })
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
