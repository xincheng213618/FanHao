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
usdCny[1] = "7.1";
usdCny[2] = "7.3";
usdCny[3] = "7.5";
usdCny[5] = "7.4";
usdCny[6] = "7.6";
usdCny[7] = "7.15";
usdCny[8] = "7.2";
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

const directDollar = payload.groups.find((group) => group.id === "fx").items[0];
assert.equal(directDollar.id, "usd-cny");
assert.equal(directDollar.value, 7.2, "FX latest must use field 8, not the bid in field 1");
assert.equal(directDollar.previousClose, 7.5, "FX previous close must use field 3, not the ask in field 2");
assert.equal(directDollar.change, -0.3);
assert.equal(directDollar.changePercent, -4);
assert.equal(directDollar.open, 7.4);
assert.equal(directDollar.high, 7.6);
assert.equal(directDollar.low, 7.15);
assert.equal(directDollar.inverseValue, 0.138889);
assert.equal(directDollar.inverseLabel, "1 CNY = {value} USD");

function fxRecord({ last, previous, open = last, high = last, low = last, bid = "99", ask = "100" }) {
  const raw = Array(18).fill("");
  Object.assign(raw, {
    0: "12:00:00", 1: bid, 2: ask, 3: previous, 5: open, 6: high, 7: low, 8: last,
    // Deliberately inconsistent upstream changes must not override latest/prior-close arithmetic.
    10: "99", 11: "999", 17: "2026-07-18"
  });
  return raw;
}

const reverseRecords = {
  fx_scnyusd: fxRecord({ last: "0.125", previous: "0.1", open: "0.12", high: "0.15", low: "0.09" }),
  fx_scnyjpy: fxRecord({ last: "20", previous: "25", open: "22", high: "26", low: "18" }),
  fx_scnykrw: fxRecord({ last: "200", previous: "200", open: "190", high: "220", low: "180" })
};
const reversedPayload = buildMarketPayload({ ...reverseRecords, hf_XAU: gold });
const reversedFx = reversedPayload.groups.find((group) => group.id === "fx");
assert.deepEqual(reversedFx.items.map((item) => [item.id, item.title, item.symbol, item.unit]), [
  ["usd-cny", "美元/人民币", "USD/CNY", "CNY"],
  ["jpy-cny", "日元/人民币", "JPY/CNY", "CNY"],
  ["krw-cny", "韩元/人民币", "KRW/CNY", "CNY"]
]);
const [dollar, yen, won] = reversedFx.items;
assert.equal(dollar.value, 8);
assert.equal(dollar.previousClose, 10);
assert.equal(dollar.change, -2);
assert.equal(dollar.changePercent, -20, "a 25% rise in CNY/USD becomes a 20% fall in USD/CNY");
assert.equal(dollar.open, 1 / 0.12);
assert.equal(dollar.high, 1 / 0.09, "inverse high must come from the source low");
assert.equal(dollar.low, 1 / 0.15, "inverse low must come from the source high");
assert.equal(dollar.inverseValue, 0.125);
assert.equal(dollar.subtitle, "1 USD 可兑换人民币");
assert.equal(yen.value, 0.05);
assert.equal(yen.previousClose, 0.04);
assert.equal(yen.change, 0.01);
assert.equal(yen.changePercent, 25, "a 20% fall in CNY/JPY becomes a 25% rise in JPY/CNY");
assert.equal(yen.inverseValue, 20);
assert.equal(yen.inverseLabel, "1 CNY = {value} JPY");
assert.equal(won.value, 0.005);
assert.equal(won.change, 0);
assert.equal(won.changePercent, 0);
assert.equal(won.inverseValue, 200);
assert.equal(won.inverseLabel, "1 CNY = {value} KRW");
assert.equal(reversedPayload.usdCny, 8);
assert.equal(reversedPayload.groups.find((group) => group.id === "metals").items[0].secondaryValue, 514.41);

const preferredDollarPayload = buildMarketPayload({ ...reverseRecords, fx_susdcny: usdCny });
assert.equal(preferredDollarPayload.groups.find((group) => group.id === "fx").items[0].value, 7.2,
  "native USD/CNY must be preferred when available");
assert.equal(preferredDollarPayload.usdCny, 7.2, "metal conversion and USD card must use the same rate");

for (const invalid of ["0", "-1", "--", "invalid", "Infinity", Number.MIN_VALUE]) {
  const invalidPayload = buildMarketPayload({
    fx_scnyjpy: fxRecord({ last: invalid, previous: "20", bid: "19" })
  });
  assert.equal(invalidPayload.groups.find((group) => group.id === "fx").items.length, 0,
    `invalid latest rate ${invalid} must not create a quote or fall back to the bid`);
}

for (const invalid of [undefined, null, "", "0", "-1", "--", "invalid"]) {
  const invalidRaw = fxRecord({ last: "20", previous: invalid });
  for (const index of [3, 5, 6, 7]) invalidRaw[index] = invalid;
  const invalidStats = buildMarketPayload({
    fx_scnyjpy: invalidRaw
  }).groups.find((group) => group.id === "fx").items[0];
  for (const field of ["previousClose", "change", "changePercent", "open", "high", "low"]) {
    assert.equal(invalidStats[field], null, `unavailable ${field} must remain null for ${invalid}`);
  }
}

const missingLatest = buildMarketPayload({
  fx_scnyjpy: fxRecord({ last: "", bid: "20", previous: "25" })
}).groups.find((group) => group.id === "fx").items[0];
assert.equal(missingLatest.value, 0.05, "a missing latest field may use the valid bid as a fallback");
const invalidDollarPayload = buildMarketPayload({
  ...reverseRecords,
  fx_susdcny: fxRecord({ last: "0", previous: "7", bid: "7" })
});
assert.equal(invalidDollarPayload.usdCny, 8, "invalid native USD/CNY must fall back to the reciprocal source");
const unavailablePayload = buildMarketPayload({
  hf_XAU: gold,
  fx_susdcny: fxRecord({ last: "0", previous: "7" }),
  fx_scnyusd: fxRecord({ last: "0", previous: "0.1" })
});
assert.equal(unavailablePayload.usdCny, null);
assert.equal(unavailablePayload.groups.find((group) => group.id === "metals").items[0].secondaryValue, null);

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
assert(html.includes('href="./styles.css?v=20260830-fx-charts-01"') && html.includes("./app.js?v=20260830-fx-charts-01"));
assert(html.includes('class="app-module-loading"') && html.includes('classList.remove("app-module-loading")'));
assert(app.includes("await loadQuotes();"));
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
