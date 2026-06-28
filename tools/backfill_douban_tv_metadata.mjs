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

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const MAX_COVER_BYTES = 2 * 1024 * 1024;

function parseArgs(argv) {
  const options = { write: false, limit: 20, refresh: false, sleep: 1, category: "", series: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") options.write = true;
    else if (arg === "--refresh") options.refresh = true;
    else if (arg === "--limit") options.limit = Math.max(0, Number(argv[++index] || 0) || 0);
    else if (arg === "--sleep") options.sleep = Math.max(0, Number(argv[++index] || 0) || 0);
    else if (arg === "--category") options.category = String(argv[++index] || "").trim();
    else if (arg === "--series") options.series = String(argv[++index] || "").trim();
  }
  return options;
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

function createId(prefix, value) {
  return `${prefix}_${Buffer.from(value).toString("base64url")}`;
}

function tvSeriesKey(category, seriesName) {
  return createId("tvs", `${String(category || "").trim()}|${String(seriesName || "").trim()}`);
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
      year TEXT,
      rating REAL,
      rating_count INTEGER,
      genres_json TEXT,
      actors_json TEXT,
      summary TEXT,
      cover_url TEXT,
      cover_mime TEXT,
      cover_blob BLOB,
      cover_bytes INTEGER,
      source TEXT,
      status TEXT NOT NULL DEFAULT 'ok',
      error TEXT,
      fetched_at TEXT,
      updated_at TEXT NOT NULL
    );
  `);
}

function existingRows(db) {
  const rows = db.prepare("SELECT series_key, status, cover_bytes, updated_at FROM tv_series_metadata").all();
  return new Map(rows.map((row) => [row.series_key, row]));
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
      Referer: "https://www.douban.com/"
    }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return await response.text();
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
    rating,
    ratingCount,
    genres: [],
    actors,
    summary,
    coverUrl
  };
}

function parseSubjectPage(html, url) {
  const jsonLd = extractJsonLd(html) || {};
  const title = String(jsonLd.name || firstMatch(html, /<span[^>]+property=["']v:itemreviewed["'][^>]*>([^<]+)/i) || "").trim();
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
  const genres = [...String(html).matchAll(/property=["']v:genre["'][^>]*>([^<]+)/gi)].map((match) => htmlDecode(match[1]).trim()).filter(Boolean);
  const actors = [...String(html).matchAll(/rel=["']v:starring["'][^>]*>([^<]+)/gi)].map((match) => htmlDecode(match[1]).trim()).filter(Boolean).slice(0, 12);
  const doubanId = firstMatch(url, /subject\/(\d+)/) || "";
  return { doubanId, doubanUrl: url, title, year, rating, ratingCount, genres, actors, summary, coverUrl };
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
    rating: primary.rating || fallback.rating || null,
    ratingCount: primary.ratingCount || fallback.ratingCount || 0,
    genres: primary.genres?.length ? primary.genres : fallback.genres || [],
    actors: primary.actors?.length ? primary.actors : fallback.actors || [],
    summary: primary.summary || fallback.summary || "",
    coverUrl: primary.coverUrl || fallback.coverUrl || ""
  };
}

async function fetchDoubanMeta(group) {
  const query = cleanQueryTitle(group.seriesName) || group.seriesName;
  const searchUrl = `https://www.douban.com/search?cat=1002&q=${encodeURIComponent(query)}`;
  const searchHtml = await fetchText(searchUrl);
  const subjectUrl = extractSubjectUrlFromSearch(searchHtml);
  if (!subjectUrl) throw new Error(`豆瓣没有搜索结果：${query}`);
  const searchMeta = parseSearchPage(searchHtml);
  let subjectMeta = {};
  try {
    const subjectHtml = await fetchText(subjectUrl);
    subjectMeta = parseSubjectPage(subjectHtml, subjectUrl);
  } catch {}
  return mergeMeta(subjectMeta, { ...searchMeta, doubanUrl: subjectUrl });
}

function upsertOk(db, group, meta, cover) {
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO tv_series_metadata (
      series_key, category, series_name, douban_id, douban_url, douban_title,
      year, rating, rating_count, genres_json, actors_json, summary, cover_url,
      cover_mime, cover_blob, cover_bytes, source, status, error, fetched_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(series_key) DO UPDATE SET
      category = excluded.category,
      series_name = excluded.series_name,
      douban_id = excluded.douban_id,
      douban_url = excluded.douban_url,
      douban_title = excluded.douban_title,
      year = excluded.year,
      rating = excluded.rating,
      rating_count = excluded.rating_count,
      genres_json = excluded.genres_json,
      actors_json = excluded.actors_json,
      summary = excluded.summary,
      cover_url = excluded.cover_url,
      cover_mime = excluded.cover_mime,
      cover_blob = excluded.cover_blob,
      cover_bytes = excluded.cover_bytes,
      source = excluded.source,
      status = excluded.status,
      error = excluded.error,
      fetched_at = excluded.fetched_at,
      updated_at = excluded.updated_at
    `
  ).run(
    group.key,
    group.category,
    group.seriesName,
    meta.doubanId || "",
    meta.doubanUrl || "",
    meta.title || "",
    meta.year || "",
    meta.rating,
    meta.ratingCount || 0,
    JSON.stringify(meta.genres || []),
    JSON.stringify(meta.actors || []),
    meta.summary || "",
    meta.coverUrl || "",
    cover.mime || "",
    cover.bytes,
    cover.bytes?.length || 0,
    "douban",
    "ok",
    "",
    now,
    now
  );
}

function upsertError(db, group, error) {
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO tv_series_metadata (
      series_key, category, series_name, source, status, error, fetched_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(series_key) DO UPDATE SET
      category = excluded.category,
      series_name = excluded.series_name,
      source = excluded.source,
      status = excluded.status,
      error = excluded.error,
      fetched_at = excluded.fetched_at,
      updated_at = excluded.updated_at
    `
  ).run(group.key, group.category, group.seriesName, "douban", "error", String(error?.message || error).slice(0, 1000), now, now);
}

const options = parseArgs(process.argv.slice(2));
const index = readJson(INDEX_PATH, {});
const db = new DatabaseSync(DB_PATH);
ensureDb(db);

const existing = existingRows(db);
let groups = seriesGroups(index);
if (options.category) groups = groups.filter((group) => group.category === options.category);
if (options.series) groups = groups.filter((group) => group.seriesName.includes(options.series));
if (!options.refresh) {
  groups = groups.filter((group) => {
    const row = existing.get(group.key);
    return !row || row.status !== "ok" || !row.cover_bytes;
  });
}
if (options.limit > 0) groups = groups.slice(0, options.limit);

console.log(`豆瓣电视剧资料目标：${groups.length} 个作品 write=${options.write ? "yes" : "no"}`);
let ok = 0;
let failed = 0;
for (const [indexInRun, group] of groups.entries()) {
  try {
    console.log(`[${indexInRun + 1}/${groups.length}] ${group.category} / ${group.seriesName}`);
    const meta = await fetchDoubanMeta(group);
    const cover = await fetchCover(meta.coverUrl);
    if (options.write) upsertOk(db, group, meta, cover);
    ok += 1;
    console.log(`  ok ${meta.title || "-"} ${meta.year || ""} rating=${meta.rating || "-"} cover=${cover.bytes?.length || 0}`);
  } catch (error) {
    failed += 1;
    if (options.write) upsertError(db, group, error);
    console.log(`  error ${error.message || error}`);
  }
  if (indexInRun < groups.length - 1 && options.sleep > 0) await sleep(options.sleep * 1000);
}
db.close();
console.log(`完成 ok=${ok} failed=${failed}`);
