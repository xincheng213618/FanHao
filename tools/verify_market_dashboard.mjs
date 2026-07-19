import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { moduleDefinition } from "../src/modules/market-dashboard/module.js";
import { createMarketDashboardRuntime } from "../src/modules/market-dashboard/server/runtime.js";
import {
  buildMarketPayload,
  createMarketQuoteService,
  parseSinaPayload
} from "../src/modules/market-dashboard/server/quote-service.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const parsed = parseSinaPayload('var hq_str_fx_susdcny="美元人民币,7.2";\nvar hq_str_hf_XAU="2000";');
assert.equal(parsed.fx_susdcny[1], "7.2");
assert.equal(parsed.hf_XAU[0], "2000");

const gold = Array(13).fill("");
gold[0] = "2000";
gold[2] = "1999";
gold[3] = "2001";
gold[4] = "2010";
gold[5] = "1980";
gold[6] = "12:00:00";
gold[7] = "1990";
gold[8] = "1950";
gold[12] = "2026-07-18";
const usdCny = Array(18).fill("");
usdCny[1] = "7.2";
const payload = buildMarketPayload(
  { hf_XAU: gold, fx_susdcny: usdCny },
  new Map([["台湾加权指数", { value: 23000, changePercent: 1.5, marketTime: "2026-07-18 12:00:00" }]]),
  [],
  new Date("2026-07-18T04:00:00.000Z")
);
assert.equal(payload.ok, true);
assert.equal(payload.usdCny, 7.2);
assert.equal(payload.groups.find((group) => group.id === "metals").items[0].secondaryValue, 462.97);
assert.equal(payload.groups.find((group) => group.id === "metals").items[0].sourceUrl, "https://finance.sina.com.cn/");
assert.equal(payload.groups.find((group) => group.id === "asia-indices").items[0].id, "taiwan-weighted");
assert.equal(payload.sources.length, 2);
assert.equal(payload.sources.find((source) => source.id === "tonghuashun").itemCount, 1);
assert.equal(payload.sources.find((source) => source.id === "tonghuashun").status, "ok");

let fetchCount = 0;
const service = createMarketQuoteService({
  now: () => Date.parse("2026-07-18T04:00:00.000Z"),
  fetchImpl: async (url) => {
    fetchCount += 1;
    if (String(url).includes("hq.sinajs.cn")) {
      return new Response('var hq_str_fx_susdcny="美元人民币,7.2";', { status: 200 });
    }
    return new Response("", { status: 200 });
  }
});
const first = await service.getQuotesPayload();
const cached = await service.getQuotesPayload();
assert.equal(first.cached, false);
assert.equal(cached.cached, true);
assert.equal(fetchCount, 2, "cached quote reads must not refetch either upstream");

let sent = null;
const runtime = createMarketDashboardRuntime({
  sendJson(_res, status, data) {
    sent = { status, data };
  },
  quoteService: {
    clearCache() {},
    async getQuotesPayload() {
      return { ok: true, groups: [] };
    }
  }
});
assert.equal(
  await runtime.routeApi({ method: "GET" }, {}, new URL("http://localhost/api/market-dashboard/quotes")),
  true
);
assert.deepEqual(sent, { status: 200, data: { ok: true, groups: [] } });
assert.equal(
  await runtime.routeApi({ method: "GET" }, {}, new URL("http://localhost/api/unrelated")),
  false
);

assert.equal(moduleDefinition.id, "market-dashboard");
assert.equal(moduleDefinition.client.web.href, "/modules/market-dashboard/index.html");
const html = fs.readFileSync(path.join(root, "public", "modules", "market-dashboard", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "modules", "market-dashboard", "app.js"), "utf8");
assert(html.includes('href="./styles.css"') && html.includes('src="./app.js"'));
for (const url of [
  "https://finance.sina.com.cn/",
  "https://stock.10jqka.com.cn/",
  "https://www.sge.com.cn/",
  "https://www.sse.com.cn/",
  "https://www.szse.cn/",
  "https://www.pbc.gov.cn/"
]) {
  assert(html.includes(`href="${url}"`), `missing market reference link: ${url}`);
}
assert(html.includes('id="sourceCards"') && html.includes("数据口径与刷新说明"));
assert(app.includes("/api/market-dashboard/quotes"));
assert(app.includes("function renderSources(") && app.includes("item.sourceUrl"));
assert(fs.readFileSync(path.join(root, "public", "index.html"), "utf8").includes('data-product-view="marketDashboard"'));

console.log("market-dashboard: ok");
