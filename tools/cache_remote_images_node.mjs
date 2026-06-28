import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import crypto from "node:crypto";

const MAX_REMOTE_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_REMOTE_IMAGE_HOSTS = ["jdbstatic.com", "javdb.com"];

const args = parseArgs(process.argv.slice(2));
if (!args.db || !args.urlsFile) {
  console.error("Usage: node tools/cache_remote_images_node.mjs --db data/actor-profiles.sqlite --urls-file urls.json");
  process.exit(2);
}

const urls = uniqueRemoteImageUrls(JSON.parse(fs.readFileSync(args.urlsFile, "utf8")));
const db = new DatabaseSync(args.db);
ensureSchema(db);

const stats = { checked: 0, cached: 0, skipped: 0, failed: 0 };
let nextIndex = 0;
const workers = Array.from({ length: Math.max(1, args.concurrency) }, () => worker());
await Promise.all(workers);

db.close();
console.log(JSON.stringify(stats));

async function worker() {
  while (nextIndex < urls.length) {
    const url = urls[nextIndex++];
    await processUrl(url);
  }
}

async function processUrl(url) {
  stats.checked += 1;
  if (isCached(db, url)) {
    stats.skipped += 1;
    return;
  }
  try {
    const image = await downloadRemoteImage(url, args);
    upsertRemoteImage(db, url, image.buffer, image.contentType);
    stats.cached += 1;
  } catch (error) {
    upsertRemoteImageError(db, url, error);
    stats.failed += 1;
  }
}

function parseArgs(argv) {
  const result = {
    timeout: 30000,
    concurrency: 8,
    referer: "https://javdb.com/",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") result.db = argv[++index];
    else if (arg === "--urls-file") result.urlsFile = argv[++index];
    else if (arg === "--referer") result.referer = argv[++index] || "";
    else if (arg === "--timeout") result.timeout = Math.max(1000, Number(argv[++index] || 30) * 1000);
    else if (arg === "--concurrency") result.concurrency = Math.max(1, Number(argv[++index] || 8));
    else if (arg === "--user-agent") result.userAgent = argv[++index] || result.userAgent;
  }
  return result;
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS remote_image_cache (
      url TEXT PRIMARY KEY,
      url_hash TEXT NOT NULL,
      content_type TEXT,
      image_blob BLOB,
      byte_length INTEGER,
      status TEXT NOT NULL DEFAULT 'ok',
      error TEXT,
      fetched_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_remote_image_cache_hash ON remote_image_cache(url_hash);
    CREATE INDEX IF NOT EXISTS idx_remote_image_cache_status ON remote_image_cache(status);
  `);
}

function isAllowedRemoteImageUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const hostname = parsed.hostname.toLowerCase();
    return ALLOWED_REMOTE_IMAGE_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function uniqueRemoteImageUrls(values) {
  const seen = new Set();
  const result = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const url = String(raw || "").trim();
    if (!url || seen.has(url) || !isAllowedRemoteImageUrl(url)) continue;
    seen.add(url);
    result.push(url);
  }
  return result;
}

function isCached(db, url) {
  const row = db
    .prepare("SELECT 1 FROM remote_image_cache WHERE url = ? AND image_blob IS NOT NULL AND length(image_blob) > 0")
    .get(url);
  return Boolean(row);
}

async function downloadRemoteImage(url, options) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(options.timeout),
    headers: {
      "User-Agent": options.userAgent,
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      Referer: options.referer || "https://javdb.com/"
    }
  });
  if (!response.ok) throw new Error(`remote image request failed: ${response.status}`);

  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_REMOTE_IMAGE_BYTES) throw new Error(`remote image is too large: ${declaredLength}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_REMOTE_IMAGE_BYTES) throw new Error(`remote image is too large: ${buffer.length}`);
  return {
    buffer,
    contentType: normalizeImageMime(response.headers.get("content-type"), url)
  };
}

function normalizeImageMime(contentType, url) {
  const mime = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
  if (mime.startsWith("image/")) return mime;
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".webp")) return "image/webp";
  if (pathname.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

function upsertRemoteImage(db, url, buffer, contentType) {
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO remote_image_cache (
      url, url_hash, content_type, image_blob, byte_length, status, error, fetched_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, 'ok', '', ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      url_hash = excluded.url_hash,
      content_type = excluded.content_type,
      image_blob = excluded.image_blob,
      byte_length = excluded.byte_length,
      status = 'ok',
      error = '',
      fetched_at = excluded.fetched_at,
      updated_at = excluded.updated_at
    `
  ).run(url, hashUrl(url), contentType || "image/jpeg", buffer, buffer.length, now, now);
}

function upsertRemoteImageError(db, url, error) {
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO remote_image_cache (
      url, url_hash, content_type, image_blob, byte_length, status, error, fetched_at, updated_at
    )
    VALUES (?, ?, '', NULL, 0, 'error', ?, NULL, ?)
    ON CONFLICT(url) DO UPDATE SET
      status = 'error',
      error = excluded.error,
      updated_at = excluded.updated_at
    `
  ).run(url, hashUrl(url), String(error?.message || error || "").slice(0, 1000), now);
}

function hashUrl(url) {
  return crypto.createHash("sha256").update(url).digest("hex");
}
