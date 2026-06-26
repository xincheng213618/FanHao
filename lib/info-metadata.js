import { TextDecoder } from "node:util";
import { extractWorkCodes, normalizeWorkCode } from "./code-parser.js";
import { parseNfoMetadata } from "./nfo-metadata.js";

const MAX_RAW_TEXT_CHARS = 24000;
const INFO_PRIORITY_EXTS = new Set([".json", ".txt", ".nfo", ".xml", ".html", ".htm", ".md", ".csv"]);
const SUBTITLE_EXTS = new Set([".srt", ".ass", ".ssa"]);

const FIELD_ALIASES = [
  { prop: "code", label: "番号", keys: ["video_id", "videoid", "id", "code", "番号", "品番", "作品番号"] },
  { prop: "title", label: "标题", keys: ["video_title", "title", "name", "标题", "標題", "片名", "名称", "名稱", "作品名"] },
  { prop: "originalTitle", label: "原始标题", keys: ["original_title", "originaltitle", "ori_title", "originalname", "原始标题", "原始標題", "原题", "原題"] },
  { prop: "sortTitle", label: "排序标题", keys: ["sort_title", "sorttitle", "sorting_title", "排序标题", "排序標題"] },
  { prop: "releaseDate", label: "日期", keys: ["release_date", "release", "date", "发行日期", "發行日期", "発売日", "日期"] },
  { prop: "year", label: "年份", keys: ["year", "年份", "年"] },
  { prop: "durationMinutes", label: "时长", keys: ["duration", "runtime", "length", "time", "时长", "時長", "长度", "長度", "収録時間"] },
  { prop: "rating", label: "评分", keys: ["rating", "score", "评分", "評分", "評価"] },
  { prop: "criticRating", label: "评论评分", keys: ["criticrating", "critic_rating", "评论评分", "評論評分"] },
  { prop: "contentRating", label: "分级", keys: ["mpaa", "customrating", "content_rating", "certification", "分级", "分級"] },
  { prop: "country", label: "国家", keys: ["country", "国家", "國家", "地区", "地區"] },
  { prop: "wanted", label: "想看", keys: ["wanted", "want", "想看", "收藏数"] },
  { prop: "director", label: "导演", keys: ["director", "导演", "導演", "監督"] },
  { prop: "maker", label: "片商", keys: ["maker", "studio", "片商", "メーカー", "制作商"] },
  { prop: "label", label: "发行商", keys: ["label", "publisher", "发行商", "發行商", "发行", "發行"] },
  { prop: "series", label: "系列", keys: ["series", "系列"] },
  { prop: "description", label: "简介", keys: ["description", "desc", "plot", "outline", "originalplot", "storyline", "tagline", "summary", "简介", "簡介", "介绍", "介紹", "剧情", "劇情", "故事"] },
  { prop: "javdbUrl", label: "JavDB", keys: ["javdb_url", "javdburl", "javdb", "url", "website", "链接", "連結", "网址", "網址"] },
  { prop: "imageUrl", label: "封面", keys: ["image_url", "cover_url", "image", "cover", "封面", "图片", "圖片"] },
  { prop: "previewImages", label: "预览图", keys: ["preview_images", "previewimages", "sample_images", "sampleimages", "screenshots", "预览图", "樣張", "样张"] },
  { prop: "previewVideoUrl", label: "预览视频", keys: ["preview_video_url", "previewvideourl", "preview_video", "sample_video", "trailer", "预览视频", "预告片"] },
  { prop: "actors", label: "演员", keys: ["actor_names", "actors", "actress", "actor", "出演者", "演员", "演員", "女优", "女優"] },
  { prop: "tags", label: "类别", keys: ["tags", "genres", "genre", "category", "categories", "类别", "類別", "分类", "分類", "カテゴリ"] }
];

const KEY_MAP = new Map();
for (const item of FIELD_ALIASES) {
  for (const key of item.keys) {
    KEY_MAP.set(normalizeKey(key), item);
  }
}

export function choosePrimaryInfoFile(files = []) {
  return rankInfoFiles(files)[0]?.file || null;
}

export function rankInfoFiles(files = []) {
  const candidates = files.filter(Boolean);
  if (!candidates.length) return [];

  return [...candidates]
    .map((file) => ({ file, score: scoreInfoFile(file) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || String(a.file.name).localeCompare(String(b.file.name), undefined, { numeric: true, sensitivity: "base" }));
}

export function scoreInfoFile(file) {
  const name = String(file.name || "");
  const lower = name.toLowerCase();
  const ext = String(file.ext || lower.slice(lower.lastIndexOf("."))).toLowerCase();
  const base = lower.replace(/\.[^.]+$/, "");
  let score = 0;

  if (INFO_PRIORITY_EXTS.has(ext)) score += 40;
  if (ext === ".json") score += 34;
  if (ext === ".txt" || ext === ".nfo") score += 28;
  if (base === "info") score += 80;
  if (base.includes("info") || base.includes("metadata") || base.includes("javdb")) score += 24;
  if (SUBTITLE_EXTS.has(ext)) score -= 120;
  if (Number(file.size || 0) > 1024 * 1024) score -= 50;

  return score;
}

export function decodeInfoBuffer(buffer) {
  const decoders = ["utf-8", "shift_jis", "gb18030"];
  for (const encoding of decoders) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(buffer);
    } catch {
      // Try the next common encoding used by local Japanese or Chinese metadata files.
    }
  }
  return buffer.toString("utf8");
}

export function isSubtitleLikeInfoText(value) {
  const text = String(value || "");
  if (!text.trim()) return false;

  const markers = [
    /^\s*\[Script Info\]/im,
    /^\s*ScriptType:\s*v4/i,
    /\bAegisub\b/i,
    /^\s*Dialogue:\s*\d*,/im,
    /^\s*\d+\s*\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{2,3}\s+-->\s+\d{1,2}:\d{2}:\d{2}[,.]\d{2,3}/m,
    /^\s*\{\\(?:an|pos|move|bord|fs|fn|fad|c&H)/im
  ];

  const hitCount = markers.reduce((sum, pattern) => sum + (pattern.test(text) ? 1 : 0), 0);
  if (hitCount >= 1 && !/(?:video_id|video_title|actor_names|发行日期|發行日期|発売日|片商|メーカー|评分|評分|rating|score)\s*[:：=]/i.test(text)) {
    return true;
  }

  return false;
}

export function parseInfoMetadata(rawInput, defaults = {}) {
  const sourceText = normalizeRawInfoText(rawInput);
  const nfoInfo = parseNfoMetadata(sourceText, defaults);
  if (nfoInfo) return finalizeInfo({ ...emptyInfo(defaults, sourceText), ...nfoInfo }, defaults, nfoInfo.rawText || sourceText, nfoInfo.fields || []);

  const rawText = normalizeInfoText(rawInput);
  const jsonObject = parseJsonObject(rawText);
  const fieldPairs = jsonObject ? fieldsFromObject(jsonObject) : fieldsFromText(rawText);
  const info = emptyInfo(defaults, rawText);

  for (const pair of fieldPairs) {
    applyField(info, pair.key, pair.value);
  }

  return finalizeInfo(info, defaults, rawText, fieldPairs);
}

export function renderInfoMetadataText(info) {
  if (!info) return "";

  const lines = [];
  const push = (label, value) => {
    const text = valueToText(value);
    if (text) lines.push(`${label}: ${text}`);
  };

  push("番号", info.code);
  push("标题", info.title);
  push("原始标题", info.originalTitle);
  push("排序标题", info.sortTitle);
  push("日期", info.releaseDate);
  push("年份", info.year);
  push("时长", info.durationMinutes ? `${info.durationMinutes} 分钟` : "");
  push("分级", info.contentRating);
  push("国家", info.country);
  push("评论评分", info.criticRating);
  push("想看", info.wanted);
  push("导演", info.director);
  push("片商", info.maker);
  push("发行商", info.label);
  push("系列", info.series);
  push("简介", info.description);
  push("JavDB", info.javdbUrl);
  push("评分", ratingText(info));
  push("类别", info.tags);
  push("演员", info.actors);
  push("预览图", info.previewImages);
  push("预览视频", info.previewVideoUrl);

  if (!lines.length && info.rawText) return info.rawText;
  return lines.join("\n");
}

function emptyInfo(defaults, rawText) {
  return {
    code: "",
    title: defaults.title || "",
    originalTitle: "",
    sortTitle: "",
    releaseDate: "",
    year: "",
    durationMinutes: null,
    rating: null,
    ratingCount: null,
    criticRating: "",
    contentRating: "",
    country: "",
    wanted: "",
    director: "",
    maker: "",
    label: "",
    series: "",
    description: "",
    javdbUrl: "",
    imageUrl: "",
    previewImages: [],
    previewVideoUrl: "",
    actors: [],
    tags: [],
    fields: [],
    rawText,
    rawTextTruncated: false
  };
}

function normalizeRawInfoText(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .replace(/\0/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function finalizeInfo(info, defaults, rawText, fieldPairs) {
  if (info.code) info.code = normalizeDisplayCode(info.code);
  fillInferredFields(info, defaults, rawText);
  dedupeArrays(info);
  info.fields = info.fields?.length ? info.fields : buildPublicFields(info, fieldPairs);
  info.rawText = rawText.slice(0, MAX_RAW_TEXT_CHARS);
  info.rawTextTruncated = rawText.length > MAX_RAW_TEXT_CHARS;
  return info;
}

function normalizeInfoText(value) {
  const text = String(value || "")
    .replace(/^\uFEFF/, "")
    .replace(/\0/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();

  if (/<\/?[a-z][\s\S]*>/i.test(text)) {
    return decodeHtmlEntities(
      text
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    );
  }

  return text;
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function parseJsonObject(text) {
  if (!text || !/^[\[{]/.test(text.trim())) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function fieldsFromObject(object) {
  const pairs = [];
  const source = Array.isArray(object) ? object[0] : object;
  if (!source || typeof source !== "object") return pairs;

  for (const [key, value] of Object.entries(source)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "object" && !Array.isArray(value)) {
      for (const [childKey, childValue] of Object.entries(value)) {
        if (childValue !== null && childValue !== undefined) pairs.push({ key: `${key}.${childKey}`, value: childValue });
      }
      continue;
    }
    pairs.push({ key, value });
  }

  return pairs;
}

function fieldsFromText(text) {
  const pairs = [];
  const lines = text.split("\n").map(cleanLine).filter(Boolean);

  for (const line of lines) {
    const match = /^(.{1,48}?)[\t ]*[:：=][\t ]*(.+)$/.exec(line);
    if (!match) continue;

    const key = match[1].trim();
    const value = match[2].trim();
    if (!key || !value) continue;
    if (/^[A-Za-z]$/.test(key) && /^[\\/]/.test(value)) continue;
    if (/^https?$/i.test(key)) continue;
    pairs.push({ key, value });
  }

  return pairs;
}

function cleanLine(line) {
  return String(line || "")
    .replace(/^\s*[-*•·]+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function applyField(info, key, rawValue) {
  const value = valueToText(rawValue);
  if (!value) return;

  const mapping = KEY_MAP.get(normalizeKey(key));
  if (!mapping) return;

  switch (mapping.prop) {
    case "code":
      info.code ||= normalizeDisplayCode(value);
      break;
    case "title":
      info.title = value;
      break;
    case "releaseDate":
      info.releaseDate ||= parseDateValue(value);
      break;
    case "year":
      info.year ||= parseYearValue(value);
      break;
    case "durationMinutes":
      info.durationMinutes ??= parseDurationMinutes(value);
      break;
    case "rating": {
      const rating = parseRatingValue(value, true);
      info.rating ??= rating.rating;
      info.ratingCount ??= rating.count;
      break;
    }
    case "actors":
      info.actors.push(...splitListValue(rawValue));
      break;
    case "tags":
      info.tags.push(...splitListValue(rawValue));
      break;
    case "previewImages":
      info.previewImages.push(...remoteUrlsFromValue(rawValue));
      break;
    case "previewVideoUrl":
      info.previewVideoUrl ||= firstRemoteUrl(rawValue);
      break;
    default:
      info[mapping.prop] ||= value;
      break;
  }
}

function fillInferredFields(info, defaults, rawText) {
  const haystack = [info.code, info.title, defaults.title, defaults.directoryName, defaults.fileName, rawText].filter(Boolean).join("\n");
  if (!info.code) {
    const code = extractCodes(haystack)[0];
    if (code) info.code = code;
  }
  if (!info.releaseDate) info.releaseDate = parseDateValue(rawText);
  if (!info.year) info.year = parseYearValue(rawText);
  if (info.durationMinutes === null) info.durationMinutes = parseDurationMinutes(rawText);
  if (info.rating === null) {
    const rating = parseRatingValue(rawText);
    info.rating = rating.rating;
    info.ratingCount = rating.count;
  }
}

function buildPublicFields(info, fieldPairs) {
  const fields = [];
  const seen = new Set();
  const push = (label, value) => {
    const text = valueToText(value);
    if (!text) return;
    const key = `${label}\n${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    fields.push({ label, value: text });
  };

  push("番号", info.code);
  push("标题", info.title);
  push("原始标题", info.originalTitle);
  push("排序标题", info.sortTitle);
  push("日期", info.releaseDate);
  push("年份", info.year);
  push("时长", info.durationMinutes ? `${info.durationMinutes} 分钟` : "");
  push("分级", info.contentRating);
  push("国家", info.country);
  push("评论评分", info.criticRating);
  push("想看", info.wanted);
  push("导演", info.director);
  push("片商", info.maker);
  push("发行商", info.label);
  push("系列", info.series);
  push("简介", info.description);
  push("JavDB", info.javdbUrl);
  push("评分", ratingText(info));
  push("类别", info.tags);
  push("演员", info.actors);
  push("预览图", info.previewImages);
  push("预览视频", info.previewVideoUrl);

  if (fields.length) return fields;

  for (const pair of fieldPairs.slice(0, 24)) {
    push(cleanLabel(pair.key), pair.value);
  }

  return fields;
}

function ratingText(info) {
  if (info.rating === null || info.rating === undefined) return "";
  const count = info.ratingCount ? `，${info.ratingCount} 人评价` : "";
  return `${info.rating} 分${count}`;
}

function normalizeKey(key) {
  return String(key || "")
    .toLowerCase()
    .replace(/[.\s_\-:：/\\()[\]【】（）]/g, "");
}

function cleanLabel(label) {
  return String(label || "").replace(/[._-]+/g, " ").trim().slice(0, 24);
}

function valueToText(value) {
  if (Array.isArray(value)) return value.map(valueToText).filter(Boolean).join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function splitListValue(value) {
  if (Array.isArray(value)) return value.flatMap(splitListValue);
  return String(value || "")
    .replace(/^\[|\]$/g, "")
    .split(/[,，、;；/|]/)
    .map((item) => item.trim().replace(/^['"]|['"]$/g, "").trim())
    .filter(Boolean);
}

function dedupeArrays(info) {
  info.actors = [...new Set(info.actors.map((item) => item.trim()).filter(Boolean))];
  info.tags = [...new Set(info.tags.map((item) => item.trim()).filter(Boolean))];
  info.previewImages = uniqueRemoteUrls(info.previewImages);
  if (info.previewVideoUrl) info.previewVideoUrl = firstRemoteUrl(info.previewVideoUrl);
}

function remoteUrlsFromValue(value) {
  if (Array.isArray(value)) return value.flatMap(remoteUrlsFromValue);
  return uniqueRemoteUrls(String(value || "").split(/[,，、;\n\r|]+/));
}

function firstRemoteUrl(value) {
  return remoteUrlsFromValue(value)[0] || "";
}

function uniqueRemoteUrls(values) {
  const urls = [];
  const seen = new Set();
  for (const value of values || []) {
    const matches = String(value || "").match(/https?:\/\/[^\s<>"',]+/gi) || [];
    for (const url of matches) {
      const clean = url.trim();
      const key = clean.toLowerCase();
      if (!clean || seen.has(key)) continue;
      seen.add(key);
      urls.push(clean);
    }
  }
  return urls;
}

function parseDateValue(value) {
  const text = String(value || "");
  const match = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(text);
  if (!match) return "";
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function parseYearValue(value) {
  const match = /\b(19\d{2}|20\d{2})\b/.exec(String(value || ""));
  return match ? match[1] : "";
}

function parseDurationMinutes(value) {
  const text = String(value || "");
  const match = /(\d{1,4})\s*(分钟|分鐘|分|m|min|minutes?)/i.exec(text);
  if (!match) return null;
  return Number(match[1]);
}

function parseRatingValue(value, allowBare = false) {
  const text = String(value || "");
  const keyedMatch = /(?:rating|score|评分|評分|评价|評價|評価)[^\d]{0,24}(\d+(?:\.\d+)?)/i.exec(text);
  const explicitMatch = /(\d+(?:\.\d+)?)\s*(?:分(?!钟|鐘)|点|點|\/\s*(?:5|10)|★)/i.exec(text);
  const bareMatch = allowBare ? /(\d+(?:\.\d+)?)/.exec(text) : null;
  const ratingMatch = keyedMatch || explicitMatch || bareMatch;
  const ratingValue = ratingMatch ? Number(ratingMatch[1]) : null;
  const countMatch = /(?:由|from)?\s*(\d{1,8})\s*(?:人|users?|ratings?|评价|評價)/i.exec(text);

  return {
    rating: Number.isFinite(ratingValue) && ratingValue >= 0 && ratingValue <= 10 ? ratingValue : null,
    count: countMatch ? Number(countMatch[1]) : null
  };
}

function normalizeDisplayCode(value) {
  const code = extractCodes(value)[0];
  return code || String(value || "").trim();
}

function extractCodes(value) {
  const codes = extractWorkCodes(value);
  if (codes.length) return codes;
  const normalized = normalizeWorkCode(value);
  return normalized ? [normalized] : [];
}
