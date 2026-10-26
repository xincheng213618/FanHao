// Content labels describe a release; editions describe evidence about a copy.
// These projections deliberately do not infer anything from a synopsis or a
// parent directory, and do not claim to have inspected the video itself.
const TAG_ALIASES = new Map([
  ["單體作品", "单体作品"], ["單体作品", "单体作品"],
  ["美少女電影", "美少女电影"], ["美少女映画", "美少女电影"],
  ["眼鏡", "眼镜"], ["戀愛", "恋爱"], ["秘書", "秘书"],
  ["蕩婦", "荡妇"], ["苗條", "苗条"], ["淫語", "淫语"],
  ["無碼", "无码"], ["無碼破解", "无码破解"],
  ["无碼", "无码"], ["無码", "无码"], ["无碼破解", "无码破解"], ["無码破解", "无码破解"],
  ["AI去碼", "AI去码"], ["AI 去碼", "AI去码"], ["AI 去码", "AI去码"],
  ["中文字幕", "中文字幕"], ["內嵌字幕", "内嵌字幕"], ["外掛字幕", "外挂字幕"],
  ["顏射", "颜射"], ["絲襪", "丝袜"], ["連褲襪", "连裤袜"],
  ["亂倫", "乱伦"], ["高畫質", "高画质"], ["高清畫質", "高清画质"],
  ["長腿", "长腿"], ["巨臀", "巨臀"], ["國產", "国产"],
  ["女優", "女优"], ["熟女", "熟女"], ["童顏", "童颜"]
]);
const EDITIONS = [
  { key: "uncensoredAi", label: "无码破解" },
  { key: "uncensored", label: "无码" },
  { key: "subtitled", label: "中字" },
  { key: "quality4k", label: "4K" }
];
const EDITION_KEYS = new Set(EDITIONS.map(({ key }) => key));
const NOISE_LABEL = /(?:磁[链鏈]|magnet|可播放|可在线|可在線|在线观看|在線觀看|在线[观觀]看|線上看|线上看|可下载|可下載|有字幕|含字幕|has[_ -]?(?:magnet|subtitles)|streamable)/i;
const MEDIA_EXTENSION = /\.(?:mp4|mkv|avi|mov|wmv|m4v|ts|m2ts|webm|flv|mpg|mpeg|vob|iso)$/i;
const TOKEN_BOUNDARY = "[^\\p{L}\\p{N}]";
const LOCAL_CODE = /(?:^|[^A-Z0-9])(?:FC2[-_. ]*(?:PPV[-_. ]*)?\d{4,9}|[A-Z]{2,12}[-_. ]?\d{2,8}|\d{6}[-_]\d{2,4}|N\d{4})(?=(?:UC|UN|U|CH|C|SUB)?(?:$|[^A-Z0-9]))/gi;
const SHORT_EDITION_SUFFIX = /^(?:[-_.\s()[\]{}@]|UC|UN|U|CH|C|SUB|4K|2160P|1080P|720P|H\.?26[45]|X26[45]|HEVC|AVC|AAC|HDR10?|UHD|HD|CD\d+|PART\d+)*$/i;
const SUPPLIER = /(?:^|[^A-Z0-9])(?:HEYZO|TOKYO[-_. ]?HOT|CARIBBEANCOM(?:PR)?|1PONDO|10MUSUME|PACOPACOMAMA)(?=$|[^A-Z0-9])|(?:^|[\s[（(【])東京熱(?:$|[\s\]）)】])/i;

function canonicalTag(value) {
  const text = typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim() : "";
  if (!text) return "";
  const ai = text.replace(/^ai\s*/i, "AI");
  if (/^(?:OL|VR|SM|JK)$/i.test(text)) return text.toUpperCase();
  return TAG_ALIASES.get(ai) || TAG_ALIASES.get(text) || text;
}

function tagValues(value, atomic = false) {
  if (Array.isArray(value)) return value.flatMap((item) => tagValues(item, true));
  if (value && typeof value === "object") return tagValues(value.name ?? value.label ?? "", true);
  if (typeof value !== "string") return [];
  const text = value.trim();
  if (!text) return [];
  if (!atomic && text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return tagValues(parsed);
    } catch { /* A label beginning with [ remains an ordinary label. */ }
  }
  return atomic ? [text] : text.split(/[,，、;；|\r\n]+/u);
}

function basename(value) {
  return typeof value === "string" ? value.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "" : "";
}

function tokenMatch(text, pattern) {
  return new RegExp(`(?:^|${TOKEN_BOUNDARY})(?:${pattern})(?=$|${TOKEN_BOUNDARY})`, "iu").test(text);
}

function shortEditionMatch(stem, token) {
  LOCAL_CODE.lastIndex = 0;
  const code = LOCAL_CODE.exec(stem);
  if (code) {
    const suffix = stem.slice(code.index + code[0].length);
    // A glued UC is one token; it must not also become the subtitle token C.
    return tokenMatch(suffix, token);
  }
  const pattern = new RegExp(`(?:^|${TOKEN_BOUNDARY})(?:${token})(?=$|${TOKEN_BOUNDARY})`, "giu");
  for (const match of stem.matchAll(pattern)) {
    if (SHORT_EDITION_SUFFIX.test(stem.slice(match.index + match[0].length))) return true;
  }
  return false;
}

function quality4kName(stem) {
  const pattern = /(?:^|[^A-Z0-9])(4K|2160P)(?=$|[^A-Z0-9])/gi;
  for (const match of stem.matchAll(pattern)) {
    const tokenIndex = match.index + match[0].length - match[1].length;
    if (/^2160P$/i.test(match[1]) && /(?:^|[^A-Z0-9])[A-Z]{2,12}-$/i.test(stem.slice(0, tokenIndex))) continue;
    if (/^4K$/i.test(match[1]) && /^-\d/.test(stem.slice(tokenIndex + match[1].length))) continue;
    return true;
  }
  return false;
}

function nativeCode(value) {
  return /^(?:HEYZO[-_. ]?\d{2,5}|N\d{4})$/i.test(String(value || "").trim());
}

function localNativeCode(stem) {
  return /(?:^|[^A-Z0-9])(?:HEYZO[-_. ]?\d{2,5}|N\d{4})(?=(?:UC|UN|U|CH|C|SUB)?(?:$|[^A-Z0-9]))/i.test(stem);
}

function editionForTag(tag) {
  if (/^(?:无码破解|AI去码|AI[- ]?UNCENSORED|破解)$/i.test(tag)) return "uncensoredAi";
  if (/^(?:无码|UNCENSORED|UNCEN)$/i.test(tag)) return "uncensored";
  if (/^(?:中文字幕|中字|内嵌字幕|外挂字幕)$/i.test(tag)) return "subtitled";
  if (/^(?:4K|2160P)$/i.test(tag)) return "quality4k";
  return "";
}

export function deriveWorkTraits(work = {}, metadata = {}) {
  work = work || {};
  metadata = metadata || {};
  const summary = work.infoSummary || {};
  const tags = new Map();
  const evidence = new Map(EDITIONS.map(({ key }) => [key, new Set()]));
  const add = (key, text) => evidence.get(key).add(text);
  const sources = [summary.tags, summary.javdbTags, work.javdbTags, work.tags, metadata.tags, metadata.javdbTags, metadata.trait_tags];
  for (const raw of sources.flatMap((value) => tagValues(value))) {
    const tag = canonicalTag(raw);
    if (!tag || NOISE_LABEL.test(tag) || /^(?:https?:\/\/|magnet:)/i.test(tag)) continue;
    const edition = editionForTag(tag);
    if (edition) add(edition, `资料标签：${tag}（未核验本地画面）`);
    else if (!tags.has(tag.toLocaleLowerCase("en"))) tags.set(tag.toLocaleLowerCase("en"), tag);
  }

  const localNames = [
    { source: "目录名", name: basename(work.directoryName) },
    ...(Array.isArray(work.videos) ? work.videos : []).map((video) => ({ source: "文件名", name: basename(video?.name) }))
  ];
  for (const { source, name } of localNames) {
    if (!name) continue;
    const stem = name.replace(MEDIA_EXTENSION, "");
    const note = `${source}：${name}（名称标记，未核验本地画面）`;
    if (tokenMatch(stem, "(?:无码|無碼)[-_ .]*破解|AI[-_ .]*去[码碼]|AI[-_ .]*UNCENSORED|破解")) add("uncensoredAi", note);
    if (tokenMatch(stem, "无码|無碼|UNCENSORED|UNCEN") || shortEditionMatch(stem, "UC|UN|U")) add("uncensored", note);
    if (tokenMatch(stem, "中字|中文字幕") || shortEditionMatch(stem, "CH|C|SUB")) add("subtitled", note);
    if (quality4kName(stem)) add("quality4k", note);
    if (localNativeCode(stem) || SUPPLIER.test(stem)) add("uncensored", `${source}：${name}（发行规则，未核验本地画面）`);
  }

  for (const code of [work.code, summary.code, metadata.code]) {
    if (nativeCode(code)) add("uncensored", `发行编号：${String(code).trim()}（发行规则，未核验本地画面）`);
  }
  for (const supplier of [summary.maker, summary.studio, summary.label, metadata.maker, metadata.studio, metadata.label, metadata.publisher]) {
    if (typeof supplier === "string" && SUPPLIER.test(supplier)) add("uncensored", `资料片商：${supplier.trim()}（发行规则，未核验本地画面）`);
  }

  const flags = Object.fromEntries(EDITIONS.map(({ key }) => [key, evidence.get(key).size > 0]));
  if (flags.uncensoredAi) flags.uncensored = true;
  return {
    tags: [...tags.values()],
    editions: EDITIONS.filter(({ key }) => flags[key] && !(key === "uncensored" && flags.uncensoredAi))
      .map(({ key, label }) => ({ key, label, evidence: [...evidence.get(key)] })),
    flags
  };
}

export function matchesWorkTraitFilter(traits, filter) {
  if (EDITION_KEYS.has(filter)) return Boolean(traits?.flags?.[filter] || (filter === "uncensored" && traits?.flags?.uncensoredAi));
  if (typeof filter !== "string" || !filter.startsWith("tag:")) return null;
  let name;
  try { name = canonicalTag(decodeURIComponent(filter.slice(4))); } catch { return false; }
  if (!name) return false;
  const key = name.toLocaleLowerCase("en");
  return (traits?.tags || []).some((tag) => canonicalTag(tag).toLocaleLowerCase("en") === key);
}

export function summarizeWorkTraits(works = [], getTraits = deriveWorkTraits) {
  const tagCounts = new Map();
  const editionCounts = new Map();
  const seen = new Set();
  for (const work of works || []) {
    if (!work || typeof work !== "object") continue;
    const identity = work.id === undefined || work.id === null || work.id === "" ? work : `id:${work.id}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const traits = getTraits(work) || {};
    for (const tag of new Set((traits.tags || []).map(canonicalTag).filter(Boolean))) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    // Broad uncensored includes AI copies even though the card shows only the
    // more informative AI badge. Each filter count describes its own result set.
    for (const { key } of EDITIONS) {
      if (matchesWorkTraitFilter(traits, key)) editionCounts.set(key, (editionCounts.get(key) || 0) + 1);
    }
  }
  return {
    tags: [...tagCounts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN")),
    editions: EDITIONS.filter(({ key }) => editionCounts.has(key)).map(({ key, label }) => ({ key, name: label, count: editionCounts.get(key) })),
    total: seen.size
  };
}
