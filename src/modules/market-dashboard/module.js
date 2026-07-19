import { createMarketDashboardRuntime } from "./server/runtime.js";

export const moduleDefinition = {
  id: "market-dashboard",
  title: "行情",
  description: "贵金属、汇率和全球主要指数行情。",
  order: 80,
  client: {
    web: { href: "/modules/market-dashboard/index.html", view: "marketDashboard", target: "_blank" }
  },
  capabilities: ["market-quotes", "metals", "fx", "global-indices"]
};

export function createModule({ moduleDeps }) {
  return createMarketDashboardRuntime(moduleDeps.marketDashboard);
}
