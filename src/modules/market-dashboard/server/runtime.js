import { createMarketQuoteService } from "./quote-service.js";

export function createMarketDashboardRuntime({ sendJson, quoteService = createMarketQuoteService() }) {
  async function routeApi(req, res, url) {
    if (url.pathname === "/api/market-dashboard/quotes" && req.method === "GET") {
      try {
        sendJson(res, 200, await quoteService.getQuotesPayload());
      } catch (error) {
        sendJson(res, 502, {
          ok: false,
          message: error.message || "行情数据获取失败",
          generatedAt: new Date().toISOString()
        });
      }
      return true;
    }

    if (url.pathname === "/api/market-dashboard/health" && req.method === "GET") {
      sendJson(res, 200, { ok: true, time: new Date().toISOString() });
      return true;
    }

    return false;
  }

  return {
    routeApi,
    invalidate: () => quoteService.clearCache()
  };
}
