import path from "node:path";
import { photoIssueCode } from "./photo-catalog-matching.js";

const origin5280k = "https://www.5280k.com";
const provider5280k = "5280k";
const postPathPattern = /^\/([1-9]\d{0,14})\.html$/;
const categoryPathPattern = /^(\/category(?:\/[a-z0-9][a-z0-9_-]*){1,4}?)(?:\/page\/([1-9]\d{0,5}))?\/?$/;
const collectionDirectoryPath = "/category/zzhj";
const maxHtmlBytes = 2 * 1024 * 1024;
const sizePattern = /(?:^|\s*[-/+]\s*|\s+)([0-9]+(?:\.[0-9]+)?\s*[KMGT](?:i?B)?)\s*$/i;
const typedMediaCount = String.raw`(\d{1,7}(?:\s*\+\s*\d{1,7})*)\s*([PV])`;
const mediaCountsPattern = new RegExp(String.raw`^${typedMediaCount}(?:\s*(?:[-/+]\s*)?${typedMediaCount})?$`, "i");
const entities = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", ndash: "–", mdash: "—", middot: "·" };

function sourcePage(value, base) {
  let url;
  try { url = new URL(value, base); } catch { return null; }
  if (url.origin !== origin5280k || url.username || url.password || url.search || url.hash) return null;
  const post = postPathPattern.exec(url.pathname);
  if (post) return { url: url.href, postId: post[1] };
  const category = categoryPathPattern.exec(url.pathname);
  if (!category) return null;
  const categoryPath = category[1];
  if (categoryPath.split("/").slice(2).includes("page")) return null;
  const page = Number(category[2] || 1);
  return { url: `${origin5280k}${categoryPath}${page > 1 ? `/page/${page}` : ""}`, categoryPath, page };
}

export function normalizePhotoSourceUrl(value) {
  return typeof value === "string" ? sourcePage(value)?.url || "" : "";
}

function decodeEntities(value) {
  return value.replace(/&(#(?:x[\da-f]+|\d+)|[a-z]+);/gi, (whole, entity) => {
    if (entity[0] !== "#") return Object.hasOwn(entities, entity) ? entities[entity] : whole;
    const code = entity[1].toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\uFFFD";
    return String.fromCodePoint(code);
  });
}

function htmlText(value) {
  return decodeEntities(value.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

function attributes(value) {
  const attrs = Object.create(null);
  for (const [, name, doubleQuoted, singleQuoted, unquoted] of value.matchAll(/([^\s=/'"<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const key = name.toLowerCase();
    if (!Object.hasOwn(attrs, key)) attrs[key] = decodeEntities(doubleQuoted ?? singleQuoted ?? unquoted ?? "");
  }
  return attrs;
}

function hasToken(value, token) {
  return typeof value === "string" && value.split(/\s+/).includes(token);
}

function* articles(html) {
  let open;
  for (const match of html.matchAll(/<(\/?)article\b((?:[^'"<>]|"[^"]*"|'[^']*')*)>/gi)) {
    if (!match[1]) open = match;
    else if (open) {
      yield [attributes(open[2]), html.slice(open.index + open[0].length, match.index)];
      open = undefined;
    }
  }
}

function elementText(html, tag, className) {
  const pattern = new RegExp(`<(\\/?)${tag}\\b((?:[^'"<>]|"[^"]*"|'[^']*')*)>`, "gi");
  let start = 0;
  let depth = 0;
  for (const match of html.matchAll(pattern)) {
    if (match[1]) {
      if (depth && --depth === 0) return htmlText(html.slice(start, match.index));
    } else if (depth) depth += 1;
    else if (hasToken(attributes(match[2]).class, className)) {
      start = match.index + match[0].length;
      depth = 1;
    }
  }
  return "";
}

function links(html, base) {
  const result = [];
  for (const [, raw] of html.matchAll(/<a\b((?:[^'"<>]|"[^"]*"|'[^']*')*)>/gi)) {
    const attrs = attributes(raw);
    const page = attrs.href && sourcePage(attrs.href, base);
    if (page) result.push({ ...page, attrs });
  }
  return result;
}

function titleFacts(title) {
  const normalized = title.normalize("NFKC");
  const suffixMatch = /\[([^\[\]]{1,150})\]$|\(([^()]{1,150})\)$/.exec(normalized);
  const suffix = (suffixMatch?.[1] ?? suffixMatch?.[2] ?? "").trim();
  const sizeMatch = sizePattern.exec(suffix);
  const size = sizeMatch?.[1].replace(/\s+/g, "").toUpperCase();
  const countText = sizeMatch ? suffix.slice(0, sizeMatch.index).trimEnd() : suffix;
  return { normalized, suffix, size, countText };
}

function declaredMediaCounts(value) {
  const match = mediaCountsPattern.exec(value);
  if (!match) return {};
  const [, firstCount, firstType, secondCount, secondType] = match;
  if (firstType.toUpperCase() === secondType?.toUpperCase()) return {};
  const facts = {};
  for (const [count, type] of [[firstCount, firstType], [secondCount, secondType]]) {
    if (!type) continue;
    const field = type.toUpperCase() === "P" ? "declaredImageCount" : "declaredVideoCount";
    facts[field] = count.split("+").reduce((total, part) => total + Number(part), 0);
  }
  return facts;
}

export function photoTitleMediaDeclarations(title) {
  return declaredMediaCounts(titleFacts(title).countText);
}

function collectionRecord(post, categoryUrl) {
  const { suffix, size } = titleFacts(post.title);
  const count = /(?:^|\s)(\d{1,7})\s*(?:套|期)(?=\s*(?:\/|$))/.exec(suffix)?.[1];
  const range = /\d{1,7}\s*[-–—~至]\s*\d{1,7}\s*(?:套|期)/.exec(suffix)?.[0];
  const declaredCountLabel = post.label || range || (count ? /\d{1,7}\s*(?:套|期)/.exec(suffix)?.[0] : "");
  const categoryLinks = new Set(links(post.html, post.url)
    .filter(link => link.categoryPath && link.page === 1 && link.categoryPath !== collectionDirectoryPath && hasToken(link.attrs.rel, "category"))
    .map(link => link.url));
  const issueListUrl = categoryUrl && (post.sticky || categoryLinks.has(categoryUrl))
    ? categoryUrl
    : categoryLinks.size === 1 ? categoryLinks.values().next().value : "";
  return {
    provider: provider5280k, externalId: post.id, url: post.url, name: post.title,
    ...(count ? { declaredCount: Number(count) } : {}),
    ...(declaredCountLabel ? { declaredCountLabel } : {}),
    ...(size ? { declaredSizeLabel: size } : {}),
    ...(issueListUrl ? { issueListUrl } : {})
  };
}

function issueRecord(post) {
  const { countText, size } = titleFacts(post.title);
  const issueCode = photoIssueCode(post.title);
  return {
    provider: provider5280k, externalId: post.id, url: post.url, title: post.title, issueCode,
    ...(post.label ? { issueLabel: post.label } : {}),
    ...declaredMediaCounts(countText),
    ...(size ? { declaredSizeLabel: size } : {})
  };
}

// Consumes public HTML already fetched by a caller. It never opens a URL or executes page content.
export function parsePhotoSourcePage(url, html) {
  const page = typeof url === "string" ? sourcePage(url) : null;
  if (!page) throw new TypeError("不支持的套图来源 URL");
  if (typeof html !== "string" || Buffer.byteLength(html) > maxHtmlBytes) throw new TypeError("套图来源 HTML 无效或过大");
  const markup = html.replace(/<!--[\s\S]*?(?:-->|$)|<(script|style|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "");
  const collections = [], entries = [], seen = new Set();
  const directory = page.categoryPath === collectionDirectoryPath;
  const categoryUrl = page.categoryPath && !directory ? `${origin5280k}${page.categoryPath}` : "";
  for (const [attrs, contents] of articles(markup)) {
    const id = /^post-([1-9]\d{0,14})$/.exec(attrs.id)?.[1];
    if (!id || seen.has(id) || (page.postId && id !== page.postId)) continue;
    const postUrl = page.postId ? page.url : links(contents, page.url).find(link => link.postId === id)?.url;
    const title = elementText(contents, page.postId ? "h1" : "h2", "entry-title");
    if (!postUrl || !title || title.length > 500) continue;
    const isCollection = hasToken(attrs.class, "category-zzhj");
    if (directory && !isCollection) continue;
    const rawLabel = elementText(contents, "span", "girl-nums").normalize("NFKC");
    const label = /^\d{1,7}(?:\+|-\d{1,7})?$/.test(rawLabel) ? rawLabel : "";
    const post = { id, url: postUrl, title, label, html: contents, sticky: hasToken(attrs.class, "category-sticky") };
    if (isCollection) collections.push(collectionRecord(post, categoryUrl));
    else entries.push(issueRecord(post));
    seen.add(id);
  }
  if (!seen.size) throw new TypeError("套图来源页面结构无法识别");
  const nextPage = page.categoryPath && links(markup, page.url).find(link =>
    (hasToken(link.attrs.rel, "next") || hasToken(link.attrs.class, "nextpostslink")
      || (hasToken(link.attrs.class, "next") && hasToken(link.attrs.class, "page-numbers")))
    && link.categoryPath === page.categoryPath && link.page === page.page + 1)?.url;
  const associated = page.postId ? collections : categoryUrl ? collections.filter(item => item.issueListUrl === categoryUrl) : [];
  return { collection: associated.length === 1 ? associated[0] : null, collections, entries, ...(nextPage ? { nextPage } : {}) };
}

function manifestPostId(value) {
  return typeof value === "string" && /^[1-9]\d{0,14}$/.test(value) ? value : "";
}

function manifestArchivePath(value) {
  if (typeof value !== "string" || value.length > 32767 || /[\x00-\x1f]/.test(value) || !/\.rar$/i.test(value)) return "";
  const windows = /^[a-z]:[\\/]/i.test(value);
  if (!windows && !/^\/(?!\/)/.test(value)) return "";
  const parts = (windows ? value.slice(2) : value).split(/[\\/]+/);
  if (parts.some(part => part === "." || part === ".." || (windows && /[:*?"<>|]|[. ]$/.test(part)))) return "";
  return windows ? path.win32.normalize(value) : path.posix.normalize(value);
}

function manifestInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

// The importer has collection post IDs and download positions, but no issue post identity.
export function parsePhotoImportManifest(manifest) {
  if (manifest?.schema_version !== 1 || !Array.isArray(manifest.results) || manifest.results.length > 50000
      || !Array.isArray(manifest.plan?.roots) || manifest.plan.roots.length > 10000) {
    throw new TypeError("不支持的微密圈导入清单");
  }
  const collections = new Map();
  for (const root of manifest.plan.roots) {
    const externalId = manifestPostId(root?.post_id);
    const name = typeof root?.destination_name === "string" ? root.destination_name.trim() : "";
    if (externalId && name && name.length <= 500 && !collections.has(externalId)) {
      collections.set(externalId, { provider: "tuimzz", externalId, name });
    }
  }
  const archives = [];
  for (const result of manifest.results) {
    if (result?.status !== "imported" && result?.status !== "identical_existing") continue;
    const archivePath = manifestArchivePath(result.rar_path);
    if (!archivePath) continue;
    const importSequence = manifestInteger(result.sequence);
    const archiveBytes = manifestInteger(result.bytes);
    const observedImageCount = manifestInteger(result.image_count);
    const collectionExternalId = manifestPostId(result.post_id);
    const archiveName = (/^[a-z]:/i.test(archivePath) ? path.win32 : path.posix).basename(archivePath);
    archives.push({
      archivePath, archiveName, status: result.status,
      ...(collectionExternalId ? { collectionExternalId } : {}),
      ...(importSequence === undefined ? {} : { importSequence }),
      ...(archiveBytes === undefined ? {} : { archiveBytes }),
      ...(observedImageCount === undefined ? {} : { observedImageCount })
    });
  }
  return { collections: [...collections.values()], archives };
}
