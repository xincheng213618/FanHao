const SINA_ENDPOINT = "https://hq.sinajs.cn";
const TONGHUASHUN_SUMMARY_URL = "https://stock.10jqka.com.cn/api/qqzs.html";
const TROY_OUNCE_GRAMS = 31.1034768;
const DEFAULT_CACHE_MS = 12_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const SINA_SOURCE = Object.freeze({
  source: "新浪财经",
  sourceUrl: "https://finance.sina.com.cn/"
});
const TONGHUASHUN_SOURCE = Object.freeze({
  source: "同花顺",
  sourceUrl: "https://stock.10jqka.com.cn/"
});

const SINA_SYMBOLS = [
  "sh000001",
  "sz399001",
  "sz399006",
  "sh000300",
  "sh000016",
  "sh000905",
  "gb_inx",
  "gb_ixic",
  "gb_$dji",
  "b_NKY",
  "b_KOSPI",
  "b_HSI",
  "hf_XAU",
  "hf_XAG",
  "fx_scnyusd",
  "fx_scnyjpy",
  "fx_scnykrw",
  "fx_susdcny"
];

const CHINA_INDICES = [
  ["sh000001", "sse", "上证指数", "SH000001", "上海证券交易所综合指数"],
  ["sz399001", "szse-component", "深证成指", "SZ399001", "深圳证券交易所成份指数"],
  ["sz399006", "chinext", "创业板指", "SZ399006", "创业板市场核心指数"],
  ["sh000300", "csi300", "沪深 300", "CSI300", "沪深两市大盘代表指数"],
  ["sh000016", "sse50", "上证 50", "SSE50", "上海市场龙头蓝筹指数"],
  ["sh000905", "csi500", "中证 500", "CSI500", "A 股中盘代表指数"]
];

const GLOBAL_INDICES = [
  ["b_NKY", "nikkei225", "日经 225", "N225", "日本东京证券交易所代表指数"],
  ["b_KOSPI", "kospi", "韩国 KOSPI", "KOSPI", "韩国综合股价指数"],
  ["b_HSI", "hang-seng", "恒生指数", "HSI", "香港市场代表指数"]
];

const US_INDICES = [
  ["gb_inx", "sp500", "标普 500", "S&P 500", "美国大盘指数"],
  ["gb_ixic", "nasdaq", "纳斯达克", "NASDAQ", "美国科技成长权重指数"],
  ["gb_$dji", "dow", "道琼斯", "DJIA", "美国蓝筹指数"]
];

const FX_QUOTES = [
  ["fx_scnyusd", "cny-usd", "人民币/美元", "CNY/USD", "1 CNY 可兑换美元", "USD", "1 USD = {value} CNY"],
  ["fx_scnyjpy", "cny-jpy", "人民币/日元", "CNY/JPY", "1 CNY 可兑换日元", "JPY", "1 JPY = {value} CNY"],
  ["fx_scnykrw", "cny-krw", "人民币/韩元", "CNY/KRW", "1 CNY 可兑换韩元", "KRW", "1 KRW = {value} CNY"]
];

function toNumber(value) {
  if (value === undefined || value === null || value === "" || value === "--" || value === "-") return null;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentChange(price, previous) {
  if (!Number.isFinite(price) || !Number.isFinite(previous) || previous === 0) return null;
  return ((price - previous) / previous) * 100;
}

export function parseSinaPayload(text) {
  const records = {};
  const pattern = /var hq_str_([^=]+)="([^"]*)";/g;
  let match;
  while ((match = pattern.exec(text))) records[match[1]] = match[2].split(",");
  return records;
}

function formatBeijingTime(date) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function quoteOptions(spec, category) {
  return {
    id: spec[1],
    title: spec[2],
    symbol: spec[3],
    subtitle: spec[4],
    category
  };
}

function buildChinaIndex(raw, options) {
  if (!raw || raw.length < 32) return null;
  const price = toNumber(raw[3]);
  const previous = toNumber(raw[2]);
  return {
    ...options,
    value: price,
    change: round(Number.isFinite(price) && Number.isFinite(previous) ? price - previous : null),
    changePercent: round(percentChange(price, previous), 2),
    open: toNumber(raw[1]),
    high: toNumber(raw[4]),
    low: toNumber(raw[5]),
    previousClose: previous,
    volume: toNumber(raw[8]),
    turnover: toNumber(raw[9]),
    marketTime: `${raw[30]} ${raw[31]}`,
    unit: "点",
    ...SINA_SOURCE
  };
}

function buildUsIndex(raw, options) {
  if (!raw || raw.length < 8) return null;
  return {
    ...options,
    value: toNumber(raw[1]),
    change: round(toNumber(raw[4])),
    changePercent: round(toNumber(raw[2]), 2),
    open: toNumber(raw[5]),
    high: toNumber(raw[6]),
    low: toNumber(raw[7]),
    previousClose: toNumber(raw[26]),
    volume: toNumber(raw[10]),
    marketTime: raw[3],
    unit: "点",
    ...SINA_SOURCE
  };
}

function buildGlobalIndex(raw, options) {
  if (!raw || raw.length < 4) return null;
  return {
    ...options,
    value: toNumber(raw[1]),
    change: round(toNumber(raw[2])),
    changePercent: round(toNumber(raw[3]), 2),
    open: toNumber(raw[8]),
    high: toNumber(raw[10]),
    low: toNumber(raw[11]),
    previousClose: toNumber(raw[9]),
    volume: toNumber(raw[12]),
    marketTime: raw[6] ? `${raw[6]} ${raw[7] || raw[5] || ""}`.trim() : (raw[5] || raw[4] || ""),
    unit: "点",
    ...SINA_SOURCE
  };
}

function buildSummaryIndex(raw, options) {
  if (!raw) return null;
  const value = toNumber(raw.value);
  const changePercent = toNumber(raw.changePercent);
  const previousClose = Number.isFinite(value) && Number.isFinite(changePercent)
    ? value / (1 + changePercent / 100)
    : null;
  return {
    ...options,
    value,
    change: round(Number.isFinite(previousClose) ? value - previousClose : null),
    changePercent: round(changePercent, 2),
    open: null,
    high: null,
    low: null,
    previousClose: round(previousClose),
    volume: null,
    marketTime: raw.marketTime,
    unit: "点",
    ...TONGHUASHUN_SOURCE
  };
}

function buildMetal(raw, options, usdCny) {
  if (!raw || raw.length < 13) return null;
  const price = toNumber(raw[0]);
  const previous = toNumber(raw[8]);
  const cnyPerGram = Number.isFinite(price) && Number.isFinite(usdCny)
    ? (price * usdCny) / TROY_OUNCE_GRAMS
    : null;
  return {
    ...options,
    value: price,
    change: round(Number.isFinite(price) && Number.isFinite(previous) ? price - previous : null),
    changePercent: round(percentChange(price, previous), 2),
    bid: toNumber(raw[2]),
    ask: toNumber(raw[3]),
    open: toNumber(raw[7]),
    high: toNumber(raw[4]),
    low: toNumber(raw[5]),
    previousClose: previous,
    marketTime: `${raw[12]} ${raw[6]}`,
    unit: "USD/oz",
    ...SINA_SOURCE,
    secondaryValue: round(cnyPerGram, options.id === "silver" ? 3 : 2),
    secondaryUnit: "CNY/g"
  };
}

function buildFx(raw, options) {
  if (!raw || raw.length < 12) return null;
  const price = toNumber(raw[1]);
  return {
    ...options,
    value: price,
    change: round(toNumber(raw[11]), 6),
    changePercent: round(toNumber(raw[10]), 2),
    open: toNumber(raw[5]),
    high: toNumber(raw[6]),
    low: toNumber(raw[7]),
    previousClose: toNumber(raw[2]),
    marketTime: `${raw[17]} ${raw[0]}`,
    unit: options.unit,
    ...SINA_SOURCE,
    inverseValue: Number.isFinite(price) && price !== 0 ? round(1 / price, 6) : null,
    inverseLabel: options.inverseLabel
  };
}

function compactItem(item) {
  return item && Number.isFinite(item.value) ? item : null;
}

export function buildMarketPayload(sinaRecords, summaryRecords = new Map(), sourceIssues = [], generatedAt = new Date()) {
  const usdCny = toNumber(sinaRecords.fx_susdcny?.[1]) || (
    toNumber(sinaRecords.fx_scnyusd?.[1]) ? 1 / toNumber(sinaRecords.fx_scnyusd[1]) : null
  );
  const metals = [
    compactItem(buildMetal(sinaRecords.hf_XAU, {
      id: "gold",
      title: "黄金",
      symbol: "XAU/USD",
      subtitle: "伦敦现货黄金",
      category: "贵金属"
    }, usdCny)),
    compactItem(buildMetal(sinaRecords.hf_XAG, {
      id: "silver",
      title: "白银",
      symbol: "XAG/USD",
      subtitle: "伦敦现货白银",
      category: "贵金属"
    }, usdCny))
  ].filter(Boolean);
  const fx = FX_QUOTES.map((spec) => compactItem(buildFx(sinaRecords[spec[0]], {
    ...quoteOptions(spec, "汇率"),
    unit: spec[5],
    inverseLabel: spec[6]
  }))).filter(Boolean);
  const chinaIndices = CHINA_INDICES
    .map((spec) => compactItem(buildChinaIndex(sinaRecords[spec[0]], quoteOptions(spec, "A 股指数"))))
    .filter(Boolean);
  const asiaIndices = [
    ...GLOBAL_INDICES.slice(0, 2).map((spec) => compactItem(buildGlobalIndex(sinaRecords[spec[0]], quoteOptions(spec, "亚太指数")))),
    compactItem(buildSummaryIndex(summaryRecords.get("台湾加权指数"), {
      id: "taiwan-weighted",
      title: "台湾加权",
      symbol: "TWII",
      subtitle: "台湾证券交易所加权股价指数",
      category: "亚太指数"
    })),
    compactItem(buildGlobalIndex(sinaRecords.b_HSI, quoteOptions(GLOBAL_INDICES[2], "亚太指数")))
  ].filter(Boolean);
  const usIndices = US_INDICES
    .map((spec) => compactItem(buildUsIndex(sinaRecords[spec[0]], quoteOptions(spec, "美股指数"))))
    .filter(Boolean);
  const receivedSinaSymbols = new Set(Object.keys(sinaRecords));
  const missingSina = SINA_SYMBOLS.filter((symbol) => !receivedSinaSymbols.has(symbol));
  const missingSummary = summaryRecords.has("台湾加权指数") ? [] : ["台湾加权"];
  const groups = [
    { id: "metals", title: "贵金属", note: "现货报价，主值为美元/盎司，副值按 USD/CNY 折算成人民币/克。", items: metals },
    { id: "fx", title: "人民币汇率", note: "主值均为 1 CNY 可兑换的目标货币数量。", items: fx },
    { id: "china-indices", title: "A 股指数", note: "覆盖上证、深证、创业板以及沪深/中证核心宽基指数。", items: chinaIndices },
    { id: "asia-indices", title: "亚太指数", note: "覆盖日本、韩国、台湾和香港主要市场指数。", items: asiaIndices },
    { id: "us-indices", title: "美股指数", note: "覆盖标普 500、纳斯达克和道琼斯。", items: usIndices }
  ];
  const items = groups.flatMap((group) => group.items);
  const sourceMetadata = [
    {
      id: "sina",
      title: SINA_SOURCE.source,
      url: SINA_SOURCE.sourceUrl,
      role: "主要行情源",
      coverage: "贵金属、人民币汇率、A 股、亚太及美股主要指数",
      itemCount: items.filter((item) => item.source === SINA_SOURCE.source).length,
      status: missingSina.length ? "partial" : "ok",
      statusLabel: missingSina.length ? `缺少 ${missingSina.length} 条记录` : "数据完整"
    },
    {
      id: "tonghuashun",
      title: TONGHUASHUN_SOURCE.source,
      url: TONGHUASHUN_SOURCE.sourceUrl,
      role: "补充行情源",
      coverage: "台湾加权指数摘要",
      itemCount: items.filter((item) => item.source === TONGHUASHUN_SOURCE.source).length,
      status: missingSummary.length ? "unavailable" : "ok",
      statusLabel: missingSummary.length ? "当前未取得摘要" : "数据完整"
    }
  ];

  return {
    ok: true,
    generatedAt: generatedAt.toISOString(),
    source: "新浪财经 + 同花顺",
    refreshSeconds: 30,
    usdCny: Number.isFinite(usdCny) ? round(usdCny, 6) : null,
    groups,
    sources: sourceMetadata,
    issues: [
      ...sourceIssues,
      ...missingSina.map((symbol) => `未收到 ${symbol} 的行情记录`),
      ...missingSummary.map((name) => `未收到 ${name} 的指数行情`)
    ]
  };
}

export function createMarketQuoteService({
  fetchImpl = globalThis.fetch,
  cacheMs = DEFAULT_CACHE_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  now = () => Date.now()
} = {}) {
  let quotesCache = null;

  async function fetchSinaRecords() {
    const url = `${SINA_ENDPOINT}/rn=${now()}&list=${SINA_SYMBOLS.join(",")}`;
    const response = await fetchImpl(url, {
      headers: {
        Referer: "https://finance.sina.com.cn/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    if (!response.ok) throw new Error(`新浪财经行情请求失败（${response.status}）`);
    const text = new TextDecoder("gb18030").decode(await response.arrayBuffer());
    return parseSinaPayload(text);
  }

  async function fetchTonghuashunSummary() {
    const response = await fetchImpl(TONGHUASHUN_SUMMARY_URL, {
      headers: {
        Referer: "https://stock.10jqka.com.cn/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    if (!response.ok) throw new Error(`同花顺摘要请求失败（${response.status}）`);
    const text = await response.text();
    const records = new Map();
    const pattern = /<em>([^<：]+)：<\/em>\s*([^&<]+)&#12288;([^%<]+)%/g;
    const marketTime = formatBeijingTime(new Date(now()));
    let match;
    while ((match = pattern.exec(text))) {
      records.set(match[1].trim(), {
        value: toNumber(match[2]),
        changePercent: toNumber(match[3]),
        marketTime
      });
    }
    return records;
  }

  async function getQuotesPayload() {
    const timestamp = now();
    if (quotesCache && timestamp - quotesCache.createdAt < cacheMs) {
      return { ...quotesCache.payload, cached: true };
    }
    const sourceIssues = [];
    const summaryPromise = fetchTonghuashunSummary().catch((error) => {
      sourceIssues.push(`同花顺摘要暂时不可用：${error.message}`);
      return new Map();
    });
    const [sinaRecords, summaryRecords] = await Promise.all([fetchSinaRecords(), summaryPromise]);
    const payload = buildMarketPayload(sinaRecords, summaryRecords, sourceIssues, new Date(timestamp));
    quotesCache = { createdAt: timestamp, payload };
    return { ...payload, cached: false };
  }

  return {
    clearCache() {
      quotesCache = null;
    },
    getQuotesPayload
  };
}
