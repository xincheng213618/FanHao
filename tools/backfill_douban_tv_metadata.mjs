import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(REPO_ROOT, "data");
const INDEX_PATH = path.join(DATA_DIR, "image-library-index.json");
const DB_PATH = path.join(DATA_DIR, "image-gallery.sqlite");
const DEFAULT_COOKIE_FILE = path.join(DATA_DIR, "douban-cookie.txt");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const MAX_COVER_BYTES = 2 * 1024 * 1024;
const SHARED_METADATA_COLUMNS = [
  ["douban_id", "TEXT"],
  ["douban_url", "TEXT"],
  ["douban_title", "TEXT"],
  ["original_title", "TEXT"],
  ["aka_json", "TEXT"],
  ["official_site", "TEXT"],
  ["year", "TEXT"],
  ["rating", "REAL"],
  ["rating_count", "INTEGER"],
  ["rating_stars_json", "TEXT"],
  ["rating_better_than_json", "TEXT"],
  ["directors_json", "TEXT"],
  ["writers_json", "TEXT"],
  ["genres_json", "TEXT"],
  ["actors_json", "TEXT"],
  ["countries_json", "TEXT"],
  ["languages_json", "TEXT"],
  ["pubdate", "TEXT"],
  ["release_dates_json", "TEXT"],
  ["season_count", "INTEGER"],
  ["episode_count", "INTEGER"],
  ["episode_duration", "TEXT"],
  ["durations_json", "TEXT"],
  ["imdb_id", "TEXT"],
  ["info_json", "TEXT"],
  ["json_ld_json", "TEXT"],
  ["summary", "TEXT"],
  ["cover_url", "TEXT"],
  ["cover_mime", "TEXT"],
  ["cover_blob", "BLOB"],
  ["cover_bytes", "INTEGER"],
  ["source", "TEXT"],
  ["detail_source", "TEXT"],
  ["status", "TEXT NOT NULL DEFAULT 'ok'"],
  ["error", "TEXT"],
  ["fetched_at", "TEXT"],
  ["updated_at", "TEXT NOT NULL DEFAULT ''"]
];

function parseArgs(argv) {
  const options = {
    write: false,
    limit: 0,
    refresh: false,
    sleep: 5,
    kind: "tv",
    category: "",
    series: "",
    title: "",
    cookie: "",
    cookieFile: DEFAULT_COOKIE_FILE
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") options.write = true;
    else if (arg === "--refresh") options.refresh = true;
    else if (arg === "--limit") options.limit = Math.max(0, Number(argv[++index] || 0) || 0);
    else if (arg === "--sleep") options.sleep = Math.max(0, Number(argv[++index] || 0) || 0);
    else if (arg === "--kind") options.kind = normalizeKind(argv[++index]);
    else if (arg === "--category") options.category = String(argv[++index] || "").trim();
    else if (arg === "--series") options.series = String(argv[++index] || "").trim();
    else if (arg === "--title") options.title = String(argv[++index] || "").trim();
    else if (arg === "--cookie") options.cookie = String(argv[++index] || "").trim();
    else if (arg === "--cookie-file") options.cookieFile = String(argv[++index] || "").trim();
  }
  return options;
}

function normalizeKind(value) {
  const kind = String(value || "").trim().toLowerCase();
  return kind === "movie" || kind === "movies" ? "movie" : "tv";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function resolveRepoPath(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return path.isAbsolute(text) ? text : path.resolve(REPO_ROOT, text);
}

function cookieLineFromNetscape(value) {
  const parts = String(value || "").split("\t");
  if (parts.length < 7) return "";
  const domain = parts[0] || "";
  if (!/douban\.com$/i.test(domain.replace(/^\./, ""))) return "";
  const name = parts[5]?.trim();
  const cookieValue = parts.slice(6).join("\t").trim();
  return name && cookieValue ? `${name}=${cookieValue}` : "";
}

function normalizeCookieText(value) {
  const text = String(value || "").trim();
  if (!text) return "";

  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed.cookies) ? parsed.cookies : [];
      return items
        .filter((item) => item && /douban\.com$/i.test(String(item.domain || "").replace(/^\./, "")))
        .map((item) => `${String(item.name || "").trim()}=${String(item.value || "").trim()}`)
        .filter((item) => !item.startsWith("="))
        .join("; ");
    } catch {}
  }

  const lines = text
    .replace(/^Cookie:\s*/i, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const netscape = lines.map(cookieLineFromNetscape).filter(Boolean);
  if (netscape.length) return netscape.join("; ");
  return lines.join("; ");
}

function readDoubanCookie(options) {
  const inlineCookie = normalizeCookieText(options.cookie || process.env.DOUBAN_COOKIE || "");
  if (inlineCookie) return { cookie: inlineCookie, source: options.cookie ? "--cookie" : "DOUBAN_COOKIE" };

  const cookieFile = resolveRepoPath(options.cookieFile || DEFAULT_COOKIE_FILE);
  if (!cookieFile || !fs.existsSync(cookieFile)) return { cookie: "", source: "" };
  const fileCookie = normalizeCookieText(fs.readFileSync(cookieFile, "utf8"));
  return fileCookie ? { cookie: fileCookie, source: cookieFile } : { cookie: "", source: "" };
}

function createId(prefix, value) {
  return `${prefix}_${Buffer.from(value).toString("base64url")}`;
}

function tvSeriesKey(category, seriesName) {
  return createId("tvs", `${String(category || "").trim()}|${String(seriesName || "").trim()}`);
}

function cleanMovieQueryTitle(value) {
  const source = String(value || "");
  const year = /\b(19\d{2}|20\d{2})\b/.exec(source)?.[1] || "";
  const text = source
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(?:2160p|1080p|720p|480p|4k|8k|uhd|remux|bluray|blu[-_. ]?ray|web[-_. ]?dl|hdtv|hdr|dv|p7|hevc|x265|x264|h\\.264|h\\.265|aac|dts|truehd|atmos|multi|proper|repack)\b/gi, " ")
    .replace(/\b(?:cd\d+|part\d+|disc\d+)\b/gi, " ")
    .replace(/\b\d{1,3}(?:\\.\\d+)?\s*(?:gb|mb)\b/gi, " ")
    .replace(/\.(?:mkv|mp4|m2ts|ts|avi|mov|wmv)$/i, " ")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const yearIndex = year ? text.indexOf(year) : -1;
  const beforeYear = yearIndex >= 0 ? text.slice(0, yearIndex).trim() : text;
  const chinese = /[\p{Script=Han}][\p{Script=Han}\s·：:]+/u.exec(beforeYear || text)?.[0]?.trim();
  return [chinese || beforeYear || text, year].filter(Boolean).join(" ").trim();
}

function cleanQueryTitle(value) {
  const cleaned = String(value || "")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/S\d{1,3}|Season\s*\d+/gi, " ")
    .replace(/\b(?:WEB[-_. ]?DL|BluRay|HDTV|NF|AMZN|HBO|Disney|Netflix)\b/gi, " ")
    .replace(/[._-]+/g, " ")
    .replace(/\b\d{4}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chinese = /[\p{Script=Han}][\p{Script=Han}\s·：:]+/u.exec(cleaned)?.[0]?.trim();
  return chinese || cleaned;
}

function seriesGroups(index) {
  const groups = new Map();
  for (const item of index.mediaItems || []) {
    if (item?.mediaKind !== "tv") continue;
    const category = String(item.category || "").trim();
    const seriesName = String(item.seriesName || item.subCategory || item.category || "").trim();
    if (!seriesName) continue;
    const key = tvSeriesKey(category, seriesName);
    let group = groups.get(key);
    if (!group) {
      group = { key, category, seriesName, count: 0, samples: [] };
      groups.set(key, group);
    }
    group.count += 1;
    if (group.samples.length < 3 && item.title) group.samples.push(item.title);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.seriesName.localeCompare(b.seriesName, "zh-Hans-CN"));
}

function movieTargets(index) {
  return (index.mediaItems || [])
    .filter((item) => item?.mediaKind === "movie")
    .map((item) => {
      const title = String(item.title || item.seriesName || item.subCategory || item.category || "").trim();
      const folderTitle = String(item.subCategory || "").trim();
      const searchTitle = cleanMovieQueryTitle(title) || cleanMovieQueryTitle(folderTitle) || title;
      return {
        key: String(item.id || "").trim(),
        category: String(item.category || "").trim(),
        movieTitle: title,
        seriesName: title,
        searchTitle,
        count: 1,
        samples: [item.relativePath || item.title || ""].filter(Boolean)
      };
    })
    .filter((item) => item.key && item.movieTitle)
    .sort((a, b) => b.movieTitle.localeCompare(a.movieTitle, "zh-Hans-CN"));
}

function categorySummary(groups, limit = 8) {
  const counts = new Map();
  for (const group of groups) {
    const category = group.category || "未归类";
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  const items = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-Hans-CN"));
  const visible = items.slice(0, limit).map(([category, count]) => `${category} ${count}`);
  const hidden = items.slice(limit).reduce((sum, item) => sum + item[1], 0);
  if (hidden) visible.push(`其他 ${hidden}`);
  return visible.join(" / ");
}

function metadataConfig(kind) {
  if (kind === "movie") {
    return {
      kind: "movie",
      table: "movie_metadata",
      keyColumn: "media_id",
      titleColumn: "movie_title",
      label: "电影",
      unit: "部电影",
      categoryLabel: "分类",
      keywordOption: "title"
    };
  }
  return {
    kind: "tv",
    table: "tv_series_metadata",
    keyColumn: "series_key",
    titleColumn: "series_name",
    label: "电视剧",
    unit: "个电视剧作品分组",
    categoryLabel: "地区",
    keywordOption: "series"
  };
}

function ensureDb(db) {
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tv_series_metadata (
      series_key TEXT PRIMARY KEY,
      category TEXT,
      series_name TEXT NOT NULL,
      douban_id TEXT,
      douban_url TEXT,
      douban_title TEXT,
      original_title TEXT,
      aka_json TEXT,
      official_site TEXT,
      year TEXT,
      rating REAL,
      rating_count INTEGER,
      rating_stars_json TEXT,
      rating_better_than_json TEXT,
      directors_json TEXT,
      writers_json TEXT,
      genres_json TEXT,
      actors_json TEXT,
      countries_json TEXT,
      languages_json TEXT,
      pubdate TEXT,
      release_dates_json TEXT,
      season_count INTEGER,
      episode_count INTEGER,
      episode_duration TEXT,
      durations_json TEXT,
      imdb_id TEXT,
      info_json TEXT,
      json_ld_json TEXT,
      summary TEXT,
      cover_url TEXT,
      cover_mime TEXT,
      cover_blob BLOB,
      cover_bytes INTEGER,
      source TEXT,
      detail_source TEXT,
      status TEXT NOT NULL DEFAULT 'ok',
      error TEXT,
      fetched_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS movie_metadata (
      media_id TEXT PRIMARY KEY,
      category TEXT,
      movie_title TEXT NOT NULL,
      douban_id TEXT,
      douban_url TEXT,
      douban_title TEXT,
      original_title TEXT,
      aka_json TEXT,
      official_site TEXT,
      year TEXT,
      rating REAL,
      rating_count INTEGER,
      rating_stars_json TEXT,
      rating_better_than_json TEXT,
      directors_json TEXT,
      writers_json TEXT,
      genres_json TEXT,
      actors_json TEXT,
      countries_json TEXT,
      languages_json TEXT,
      pubdate TEXT,
      release_dates_json TEXT,
      season_count INTEGER,
      episode_count INTEGER,
      episode_duration TEXT,
      durations_json TEXT,
      imdb_id TEXT,
      info_json TEXT,
      json_ld_json TEXT,
      summary TEXT,
      cover_url TEXT,
      cover_mime TEXT,
      cover_blob BLOB,
      cover_bytes INTEGER,
      source TEXT,
      detail_source TEXT,
      status TEXT NOT NULL DEFAULT 'ok',
      error TEXT,
      fetched_at TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tv_series_metadata_category ON tv_series_metadata(category);
    CREATE INDEX IF NOT EXISTS idx_tv_series_metadata_douban_id ON tv_series_metadata(douban_id);
    CREATE INDEX IF NOT EXISTS idx_tv_series_metadata_status ON tv_series_metadata(status);
    CREATE INDEX IF NOT EXISTS idx_movie_metadata_category ON movie_metadata(category);
    CREATE INDEX IF NOT EXISTS idx_movie_metadata_douban_id ON movie_metadata(douban_id);
    CREATE INDEX IF NOT EXISTS idx_movie_metadata_status ON movie_metadata(status);
  `);
  ensureColumn(db, "tv_series_metadata", "category", "TEXT");
  ensureColumn(db, "tv_series_metadata", "series_name", "TEXT NOT NULL DEFAULT ''");
  for (const [column, definition] of SHARED_METADATA_COLUMNS) {
    ensureColumn(db, "tv_series_metadata", column, definition);
  }
  ensureColumn(db, "movie_metadata", "category", "TEXT");
  ensureColumn(db, "movie_metadata", "movie_title", "TEXT NOT NULL DEFAULT ''");
  for (const [column, definition] of SHARED_METADATA_COLUMNS) {
    ensureColumn(db, "movie_metadata", column, definition);
  }
}

function ensureColumn(db, table, column, definition) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!rows.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function existingRows(db, kind) {
  const config = metadataConfig(kind);
  const rows = db.prepare(`SELECT ${config.keyColumn} AS target_key, status, cover_bytes, updated_at FROM ${config.table}`).all();
  return new Map(rows.map((row) => [row.target_key, row]));
}

function isDoubanSecurityPage(response, html) {
  const finalUrl = response.url || "";
  if (/^https:\/\/sec\.douban\.com\//i.test(finalUrl)) return true;
  return /<form[^>]+name=["']sec["']/i.test(html) && /sec\.douban\.com|action=["']\/c["']/i.test(html);
}

class DoubanSecurityPageError extends Error {
  constructor(url) {
    super(`豆瓣详情页需要浏览器 Cookie：${url}`);
    this.name = "DoubanSecurityPageError";
  }
}

async function fetchText(url, options = {}) {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
    Referer: options.referer || "https://www.douban.com/"
  };
  if (options.cookie) headers.Cookie = options.cookie;

  const response = await fetch(url, {
    headers
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  const html = await response.text();
  if (isDoubanSecurityPage(response, html)) throw new DoubanSecurityPageError(url);
  return html;
}

async function fetchCover(url) {
  if (!url) return { bytes: null, mime: "" };
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      Referer: "https://movie.douban.com/"
    }
  });
  if (!response.ok) throw new Error(`封面下载失败 HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > MAX_COVER_BYTES) throw new Error(`封面大小异常 ${buffer.length}`);
  return { bytes: buffer, mime: response.headers.get("content-type")?.split(";")[0] || "image/jpeg" };
}

function htmlDecode(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractJsonLd(html) {
  const matches = [...String(html || "").matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of matches) {
    try {
      const parsed = JSON.parse(htmlDecode(match[1]).trim());
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return null;
}

function firstMatch(text, pattern) {
  return pattern.exec(text)?.[1]?.trim() || "";
}

function stripTags(value) {
  return htmlDecode(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSpaces(value) {
  return htmlDecode(String(value || ""))
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSlashList(value) {
  return String(value || "")
    .split("/")
    .map((item) => normalizeSpaces(item))
    .filter(Boolean);
}

function splitDateList(value) {
  return String(value || "")
    .split(/\s*\/\s*/)
    .map((item) => normalizeSpaces(item))
    .filter(Boolean);
}

function uniqueTextList(values, maxItems = 80) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = normalizeSpaces(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

function jsonLdNames(value) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items.map((item) => (item && typeof item === "object" ? item.name : item));
}

function parseInfoFields(html) {
  const infoHtml = firstMatch(html, /<div id=["']info["'][^>]*>([\s\S]*?)<\/div>\s*<script/i) || firstMatch(html, /<div id=["']info["'][^>]*>([\s\S]*?)<\/div>/i);
  if (!infoHtml) return {};
  const lines = infoHtml
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .split(/\r?\n/)
    .map((line) => normalizeSpaces(line))
    .filter(Boolean);
  const fields = {};
  for (const line of lines) {
    const match = /^([^:：]+)[:：]\s*(.+)$/.exec(line);
    if (!match) continue;
    fields[match[1].trim()] = match[2].trim();
  }
  return fields;
}

function parseRatingStars(html) {
  const result = {};
  const ratingBlock = firstMatch(html, /<div class=["']ratings-on-weight["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<div class=["']rating_betterthan/i)
    || firstMatch(html, /<div class=["']ratings-on-weight["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
  const source = ratingBlock || html;
  for (const match of String(source).matchAll(/stars([1-5])[^>]*>[\s\S]*?<span class=["']rating_per["'][^>]*>([^<]+)<\/span>/gi)) {
    const star = match[1];
    const percent = Number(String(match[2] || "").replace("%", "").trim());
    if (Number.isFinite(percent)) result[star] = percent;
  }
  return result;
}

function parseBetterThan(html) {
  const block = firstMatch(html, /<div class=["']rating_betterthan["'][^>]*>([\s\S]*?)<\/div>/i);
  if (!block) return [];
  const result = [];
  for (const match of String(block).matchAll(/>(\d+(?:\.\d+)?)%\s*([^<]+?)<\/a>/gi)) {
    const percent = Number(match[1]);
    const type = normalizeSpaces(match[2]);
    if (Number.isFinite(percent) && type) result.push({ percent, type });
  }
  return result;
}

function subjectUrlFromValue(value) {
  const text = htmlDecode(String(value || ""));
  const direct = /https:\/\/movie\.douban\.com\/subject\/\d+\//.exec(text)?.[0] || "";
  if (direct) return direct;
  const encoded = /url=(https%3A%2F%2Fmovie\.douban\.com%2Fsubject%2F\d+%2F)/i.exec(text)?.[1] || "";
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {}
  }
  return "";
}

function parseRatingCount(value) {
  const match = /(\d[\d,]*)\s*人评价/.exec(String(value || ""));
  return match ? Number(match[1].replace(/,/g, "")) || 0 : 0;
}

function parseSearchPage(html) {
  const resultBlock = firstMatch(html, /<div class=["']result["'][^>]*>([\s\S]*?)(?=<div class=["']result["']|<\/div>\s*<\/div>\s*<\/div>)/i);
  const block = resultBlock || html;
  const subjectUrl = subjectUrlFromValue(block);
  const title =
    htmlDecode(firstMatch(block, /<a[^>]+title=["']([^"']+)["'][^>]*>\s*<img/i)) ||
    stripTags(firstMatch(block, /<h3>[\s\S]*?<a[^>]+>([\s\S]*?)<\/a>/i));
  const rating = Number(firstMatch(block, /<span class=["']rating_nums["']>([^<]+)/i) || 0) || null;
  const ratingText = firstMatch(block, /<div class=["']rating-info["'][^>]*>([\s\S]*?)<\/div>/i);
  const ratingCount = parseRatingCount(ratingText);
  const castText = stripTags(firstMatch(block, /<span class=["']subject-cast["']>([\s\S]*?)<\/span>/i));
  const castParts = castText
    .replace(/^原名:[^/]+\/\s*/, "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  const year = (castParts.find((part) => /^\d{4}$/.test(part)) || firstMatch(castText, /(\d{4})\s*$/)) || "";
  const actors = castParts.filter((part) => part !== year).slice(0, 12);
  const summary = stripTags(firstMatch(block, /<p>([\s\S]*?)<\/p>/i));
  const coverUrl = htmlDecode(firstMatch(block, /<img[^>]+src=["']([^"']+)/i));
  const doubanId = firstMatch(subjectUrl, /subject\/(\d+)/) || firstMatch(block, /sid:\s*(\d+)/i) || "";
  return {
    doubanId,
    doubanUrl: subjectUrl,
    title,
    year,
    originalTitle: "",
    aliases: [],
    officialSite: "",
    rating,
    ratingCount,
    ratingStars: {},
    ratingBetterThan: [],
    directors: [],
    writers: [],
    genres: [],
    actors,
    countries: [],
    languages: [],
    pubdate: "",
    releaseDates: [],
    seasonCount: null,
    episodeCount: null,
    episodeDuration: "",
    durations: [],
    imdbId: "",
    info: {},
    jsonLd: {},
    summary,
    coverUrl
  };
}

function parseSubjectPage(html, url) {
  const jsonLd = extractJsonLd(html) || {};
  const info = parseInfoFields(html);
  const title = String(firstMatch(html, /<span[^>]+property=["']v:itemreviewed["'][^>]*>([^<]+)/i) || jsonLd.name || "").trim();
  const rating = Number(jsonLd.aggregateRating?.ratingValue || firstMatch(html, /property=["']v:average["'][^>]*>([^<]+)/i) || 0) || null;
  const ratingCount = Number(jsonLd.aggregateRating?.ratingCount || firstMatch(html, /property=["']v:votes["'][^>]*>([^<]+)/i) || 0) || 0;
  const year = firstMatch(html, /<span class=["']year["']>\(([^)]+)\)<\/span>/i) || "";
  const summary = htmlDecode(firstMatch(html, /<span[^>]+property=["']v:summary["'][^>]*>([\s\S]*?)<\/span>/i))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const coverUrl =
    String(jsonLd.image || "").trim() ||
    firstMatch(html, /<a[^>]+class=["']nbgnbg["'][^>]*>\s*<img[^>]+src=["']([^"']+)/i) ||
    firstMatch(html, /<img[^>]+rel=["']v:image["'][^>]+src=["']([^"']+)/i);
  const infoDirectors = uniqueTextList(splitSlashList(info["导演"]));
  const infoWriters = uniqueTextList(splitSlashList(info["编剧"]));
  const infoGenres = uniqueTextList(splitSlashList(info["类型"]));
  const infoActors = uniqueTextList(splitSlashList(info["主演"]));
  const directors = infoDirectors.length ? infoDirectors : uniqueTextList(jsonLdNames(jsonLd.director));
  const writers = infoWriters.length ? infoWriters : uniqueTextList(jsonLdNames(jsonLd.author));
  const genres = infoGenres.length ? infoGenres : uniqueTextList([...String(html).matchAll(/property=["']v:genre["'][^>]*>([^<]+)/gi)].map((match) => match[1]));
  const actors = infoActors.length ? infoActors : uniqueTextList(jsonLdNames(jsonLd.actor).concat([...String(html).matchAll(/rel=["']v:starring["'][^>]*>([^<]+)/gi)].map((match) => match[1])));
  const countries = uniqueTextList(splitSlashList(info["制片国家/地区"]));
  const languages = uniqueTextList(splitSlashList(info["语言"]));
  const pubdate = info["首播"] || info["上映日期"] || "";
  const releaseDates = uniqueTextList(splitDateList(info["首播"]).concat(splitDateList(info["上映日期"])));
  const durations = uniqueTextList(splitSlashList(info["单集片长"]).concat(splitSlashList(info["片长"])));
  const seasonCount = Number(firstMatch(info["季数"] || "", /(\d+)/) || 0) || null;
  const episodeCount = Number(firstMatch(info["集数"] || "", /(\d+)/) || 0) || null;
  const episodeDuration = info["单集片长"] || "";
  const imdbId = firstMatch(info["IMDb"] || "", /(tt\d+)/i) || "";
  const doubanId = firstMatch(url, /subject\/(\d+)/) || "";
  return {
    doubanId,
    doubanUrl: url,
    title,
    year,
    originalTitle: info["原名"] || info["原片名"] || "",
    aliases: uniqueTextList(splitSlashList(info["又名"])),
    officialSite: info["官方网站"] || "",
    rating,
    ratingCount,
    ratingStars: parseRatingStars(html),
    ratingBetterThan: parseBetterThan(html),
    directors,
    writers,
    genres,
    actors,
    countries,
    languages,
    pubdate,
    releaseDates,
    seasonCount,
    episodeCount,
    episodeDuration,
    durations,
    imdbId,
    info,
    jsonLd,
    summary,
    coverUrl
  };
}

function extractSubjectUrlFromSearch(html) {
  const linked = subjectUrlFromValue(html);
  if (linked) return linked;
  const href = firstMatch(html, /<a[^>]+href=["'](https:\/\/movie\.douban\.com\/subject\/\d+\/)["'][^>]*>/i);
  return href || "";
}

function mergeMeta(primary, fallback) {
  return {
    doubanId: primary.doubanId || fallback.doubanId || "",
    doubanUrl: primary.doubanUrl || fallback.doubanUrl || "",
    title: primary.title || fallback.title || "",
    year: primary.year || fallback.year || "",
    originalTitle: primary.originalTitle || fallback.originalTitle || "",
    aliases: primary.aliases?.length ? primary.aliases : fallback.aliases || [],
    officialSite: primary.officialSite || fallback.officialSite || "",
    rating: primary.rating || fallback.rating || null,
    ratingCount: primary.ratingCount || fallback.ratingCount || 0,
    ratingStars: Object.keys(primary.ratingStars || {}).length ? primary.ratingStars : fallback.ratingStars || {},
    ratingBetterThan: primary.ratingBetterThan?.length ? primary.ratingBetterThan : fallback.ratingBetterThan || [],
    directors: primary.directors?.length ? primary.directors : fallback.directors || [],
    writers: primary.writers?.length ? primary.writers : fallback.writers || [],
    genres: primary.genres?.length ? primary.genres : fallback.genres || [],
    actors: primary.actors?.length ? primary.actors : fallback.actors || [],
    countries: primary.countries?.length ? primary.countries : fallback.countries || [],
    languages: primary.languages?.length ? primary.languages : fallback.languages || [],
    pubdate: primary.pubdate || fallback.pubdate || "",
    releaseDates: primary.releaseDates?.length ? primary.releaseDates : fallback.releaseDates || [],
    seasonCount: primary.seasonCount || fallback.seasonCount || null,
    episodeCount: primary.episodeCount || fallback.episodeCount || null,
    episodeDuration: primary.episodeDuration || fallback.episodeDuration || "",
    durations: primary.durations?.length ? primary.durations : fallback.durations || [],
    imdbId: primary.imdbId || fallback.imdbId || "",
    info: Object.keys(primary.info || {}).length ? primary.info : fallback.info || {},
    jsonLd: Object.keys(primary.jsonLd || {}).length ? primary.jsonLd : fallback.jsonLd || {},
    summary: primary.summary || fallback.summary || "",
    coverUrl: primary.coverUrl || fallback.coverUrl || "",
    detailSource: primary.title || primary.summary || primary.genres?.length || primary.actors?.length ? "subject" : fallback.detailSource || "search"
  };
}

async function fetchDoubanMeta(group, options) {
  const rawQuery = group.searchTitle || group.seriesName || group.movieTitle || "";
  const query = options.kind === "movie" ? cleanMovieQueryTitle(rawQuery) || rawQuery : cleanQueryTitle(rawQuery) || rawQuery;
  const searchUrl = `https://www.douban.com/search?cat=1002&q=${encodeURIComponent(query)}`;
  const searchHtml = await fetchText(searchUrl, { cookie: options.cookie });
  const subjectUrl = extractSubjectUrlFromSearch(searchHtml);
  if (!subjectUrl) throw new Error(`豆瓣没有搜索结果：${query}`);
  const searchMeta = parseSearchPage(searchHtml);
  let subjectMeta = {};
  try {
    const subjectHtml = await fetchText(subjectUrl, { cookie: options.cookie, referer: searchUrl });
    subjectMeta = parseSubjectPage(subjectHtml, subjectUrl);
  } catch (error) {
    if (!(error instanceof DoubanSecurityPageError)) {
      subjectMeta = {};
    }
  }
  return mergeMeta(subjectMeta, { ...searchMeta, doubanUrl: subjectUrl });
}

function targetTitle(group) {
  return group.movieTitle || group.seriesName || "";
}

function upsertOk(db, kind, group, meta, cover) {
  const config = metadataConfig(kind);
  const now = new Date().toISOString();
  const record = {
    [config.keyColumn]: group.key,
    category: group.category,
    [config.titleColumn]: targetTitle(group),
    douban_id: meta.doubanId || "",
    douban_url: meta.doubanUrl || "",
    douban_title: meta.title || "",
    original_title: meta.originalTitle || "",
    aka_json: JSON.stringify(meta.aliases || []),
    official_site: meta.officialSite || "",
    year: meta.year || "",
    rating: meta.rating,
    rating_count: meta.ratingCount || 0,
    rating_stars_json: JSON.stringify(meta.ratingStars || {}),
    rating_better_than_json: JSON.stringify(meta.ratingBetterThan || []),
    directors_json: JSON.stringify(meta.directors || []),
    writers_json: JSON.stringify(meta.writers || []),
    genres_json: JSON.stringify(meta.genres || []),
    actors_json: JSON.stringify(meta.actors || []),
    countries_json: JSON.stringify(meta.countries || []),
    languages_json: JSON.stringify(meta.languages || []),
    pubdate: meta.pubdate || "",
    release_dates_json: JSON.stringify(meta.releaseDates || []),
    season_count: meta.seasonCount || null,
    episode_count: meta.episodeCount || null,
    episode_duration: meta.episodeDuration || "",
    durations_json: JSON.stringify(meta.durations || []),
    imdb_id: meta.imdbId || "",
    info_json: JSON.stringify(meta.info || {}),
    json_ld_json: JSON.stringify(meta.jsonLd || {}),
    summary: meta.summary || "",
    cover_url: meta.coverUrl || "",
    cover_mime: cover.mime || "",
    cover_blob: cover.bytes,
    cover_bytes: cover.bytes?.length || 0,
    source: "douban",
    detail_source: meta.detailSource || "",
    status: "ok",
    error: "",
    fetched_at: now,
    updated_at: now
  };
  const columns = Object.keys(record);
  const placeholders = columns.map(() => "?").join(", ");
  const updates = columns
    .filter((column) => column !== config.keyColumn)
    .map((column) => `${column} = excluded.${column}`)
    .join(",\n      ");
  db.prepare(
    `
    INSERT INTO ${config.table} (${columns.join(", ")})
    VALUES (${placeholders})
    ON CONFLICT(${config.keyColumn}) DO UPDATE SET
      ${updates}
    `
  ).run(...columns.map((column) => record[column]));
}

function upsertError(db, kind, group, error) {
  const config = metadataConfig(kind);
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO ${config.table} (
      ${config.keyColumn}, category, ${config.titleColumn}, source, status, error, fetched_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(${config.keyColumn}) DO UPDATE SET
      category = excluded.category,
      ${config.titleColumn} = excluded.${config.titleColumn},
      source = excluded.source,
      status = excluded.status,
      error = excluded.error,
      fetched_at = excluded.fetched_at,
      updated_at = excluded.updated_at
    `
  ).run(group.key, group.category, targetTitle(group), "douban", "error", String(error?.message || error).slice(0, 1000), now, now);
}

const options = parseArgs(process.argv.slice(2));
const cookieState = readDoubanCookie(options);
options.cookie = cookieState.cookie;
const index = readJson(INDEX_PATH, {});
const db = new DatabaseSync(DB_PATH);
ensureDb(db);

const config = metadataConfig(options.kind);
const existing = existingRows(db, options.kind);
let groups = options.kind === "movie" ? movieTargets(index) : seriesGroups(index);
const keyword = options.kind === "movie" ? options.title || options.series : options.series;
if (options.category) groups = groups.filter((group) => group.category === options.category);
if (keyword) {
  groups = groups.filter((group) =>
    [group.seriesName, group.movieTitle, group.searchTitle, ...(group.samples || [])].filter(Boolean).some((value) => String(value).includes(keyword))
  );
}
if (!options.refresh) {
  groups = groups.filter((group) => {
    const row = existing.get(group.key);
    return !row || row.status !== "ok" || !row.cover_bytes;
  });
}
if (options.limit > 0) groups = groups.slice(0, options.limit);

const scope = [
  options.category ? `${config.categoryLabel}=${options.category}` : `全部${config.categoryLabel}`,
  keyword ? `关键词=${keyword}` : "",
  options.refresh ? "刷新已有资料" : "只补缺失/无封面",
  options.limit > 0 ? `上限=${options.limit}` : "全量"
].filter(Boolean);
console.log(`豆瓣${config.label}资料目标：${groups.length} ${config.unit} (${scope.join("，")}) write=${options.write ? "yes" : "no"} cookie=${cookieState.cookie ? "yes" : "no"}`);
if (!options.category && groups.length) console.log(`${config.categoryLabel}分布：${categorySummary(groups)}`);
if (cookieState.source) console.log(`Cookie 来源：${cookieState.source}`);
let ok = 0;
let failed = 0;
for (const [indexInRun, group] of groups.entries()) {
  try {
    console.log(`[${indexInRun + 1}/${groups.length}] ${group.category} / ${targetTitle(group)}`);
    const meta = await fetchDoubanMeta(group, options);
    const cover = await fetchCover(meta.coverUrl);
    if (options.write) upsertOk(db, options.kind, group, meta, cover);
    ok += 1;
    console.log(`  ok ${meta.title || "-"} ${meta.year || ""} rating=${meta.rating || "-"} detail=${meta.detailSource || "search"} cover=${cover.bytes?.length || 0}`);
  } catch (error) {
    failed += 1;
    if (options.write) upsertError(db, options.kind, group, error);
    console.log(`  error ${error.message || error}`);
  }
  if (indexInRun < groups.length - 1 && options.sleep > 0) await sleep(options.sleep * 1000);
}
db.close();
console.log(`完成 ok=${ok} failed=${failed}`);
