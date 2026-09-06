// Pure, conservative identity checks shared by the movie collection workflow.
// Search snippets are discovery hints, never verified movie metadata.
export class MovieMetadataMatchError extends Error {
  constructor(reason) {
    super(`电影资料待核对：${reason}`);
    this.name = "MovieMetadataMatchError";
    this.code = "METADATA_REVIEW_REQUIRED";
    this.reason = reason;
  }
}

export function canonicalDoubanSubjectUrl(value) {
  let text = String(value ?? "").trim().replace(/&amp;/gi, "&");
  if (!text || /[\s<>"']/.test(text)) return "";
  if (/^\/subject\/\d+\/?(?:[?#].*)?$/.test(text)) text = `https://movie.douban.com${text}`;
  try {
    const url = new URL(text);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port) return "";
    if (url.hostname === "movie.douban.com" && /^\/subject\/\d+\/?$/.test(url.pathname)) {
      return `https://movie.douban.com/subject/${url.pathname.split("/")[2]}/`;
    }
    if (["www.douban.com", "douban.com", "search.douban.com"].includes(url.hostname)
      && /^\/link2?\/?$/.test(url.pathname)) {
      // Only one trusted redirect hop. Never extract a URL embedded in arbitrary text.
      const target = new URL(url.searchParams.get("url") || "");
      if (target.hostname !== "movie.douban.com") return "";
      return canonicalDoubanSubjectUrl(target.href);
    }
  } catch {}
  return "";
}

const EAST_ASIAN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const RELEASE_TOKEN = /\b(?:2160p|1080p|720p|480p|4k|8k|uhd|remux|bluray|blu[-_. ]?ray|web[-_. ]?dl|hdtv|hdr10?\+?|dv|hevc|x265|x264|h[. ]?264|h[. ]?265|aac|dts|truehd|atmos|proper|repack)\b/giu;

function localTitleParts(value, fromPath = false) {
  let text = String(value ?? "").normalize("NFKC").trim();
  if (fromPath) text = text.split(/[\\/]/).at(-1).trim();
  text = text.replace(/\.(?:mkv|mp4|m2ts|ts|avi|mov|wmv)$/i, "").replace(/[._]+/g, " ");
  // A bare title such as 1917 or the leading 2001 in 2001: A Space Odyssey
  // is not a release year. In filenames the last year following a title wins.
  const years = [...text.matchAll(/(?<!\d)(?:19|20)\d{2}(?!\d)/g)]
    .filter((match) => /[\p{L}\p{N}]/u.test(text.slice(0, match.index))
      && (match.index === 0 || /[\s([{（【]/.test(text[match.index - 1]))
      && (match.index + 4 === text.length || /[\s)\]}）】-]/.test(text[match.index + 4])));
  const yearMatch = years.at(-1);
  const year = yearMatch?.[0] || "";
  if (yearMatch) text = text.slice(0, yearMatch.index).replace(/[\s([{（【]+$/, "");
  text = text.replace(/\[([^\]]*)\]/g, (whole, inside) => {
    const remaining = inside.replace(RELEASE_TOKEN, "").replace(/[\s\d.,+-]+/g, "");
    return remaining ? whole : " ";
  }).replace(RELEASE_TOKEN, " ").replace(/\b\d+(?:[.,]\d+)?\s*(?:gb|mb)\b/gi, " ")
    .replace(/\s+/g, " ").trim();
  return { title: text, year };
}

function normalizeTitle(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function titleVariants(value) {
  const text = String(value ?? "").normalize("NFKC")
    .replace(/\((?:港|台|中国大陆|香港|台湾|新加坡|马来西亚)\)\s*$/u, "").trim();
  const variants = new Set([normalizeTitle(text)]);
  // A whole bilingual title and its two explicitly separated names are aliases.
  // Do not use substring matching: sequel digits and title words remain significant.
  const trailingLatin = /^(.+?)\s+([\p{Script=Latin}\p{N}][\p{Script=Latin}\p{N}\p{P}\p{Zs}\p{S}]*)$/u.exec(text);
  if (trailingLatin && EAST_ASIAN.test(trailingLatin[1])) {
    variants.add(normalizeTitle(trailingLatin[1]));
    variants.add(normalizeTitle(trailingLatin[2]));
  }
  const leadingLatin = /^([\p{Script=Latin}\p{N}][\p{Script=Latin}\p{N}\p{P}\p{Zs}\p{S}]*?)\s+(.+)$/u.exec(text);
  if (leadingLatin && EAST_ASIAN.test(leadingLatin[2])) {
    variants.add(normalizeTitle(leadingLatin[1]));
    variants.add(normalizeTitle(leadingLatin[2]));
  }
  variants.delete("");
  return variants;
}

export function cleanMovieSearchTitle(value) {
  const { title, year } = localTitleParts(value);
  const bilingual = /^(.+?)\s+[A-Za-z][\p{Script=Latin}\p{N}\p{P}\p{Zs}\p{S}]*$/u.exec(title);
  const name = bilingual && EAST_ASIAN.test(bilingual[1]) ? bilingual[1] : title;
  return [name, year].filter(Boolean).join(" ");
}

export function movieMatchTarget(target = {}) {
  const primary = target.movieTitle || target.movie_title || target.title || target.searchTitle || target.search_title || "";
  const primaryText = String(primary).normalize("NFKC").replace(/\s+/g, " ").trim();
  const samples = (Array.isArray(target.samples) ? target.samples : []).filter((sample) =>
    String(sample ?? "").normalize("NFKC").replace(/\s+/g, " ").trim() !== primaryText);
  const parts = [localTitleParts(primary), ...samples
    .map((sample) => localTitleParts(sample, true))];
  const years = new Set(parts.map((part) => part.year).filter(Boolean));
  const titles = new Set(parts.flatMap((part) => [...titleVariants(part.title)]));
  return { titles, year: [...years][0] || "", conflictingYears: years.size > 1 };
}

function positiveCount(value) {
  if (!["number", "string"].includes(typeof value) || value === "") return false;
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

function hasText(value) {
  return typeof value === "string" && Boolean(value.trim());
}

function candidateFailure(meta) {
  if (!meta || meta.detailSource !== "subject" || !hasText(meta.title)
    || !canonicalDoubanSubjectUrl(meta.doubanUrl)) return "incomplete-subject";
  const info = meta.info && typeof meta.info === "object" ? meta.info : {};
  const rawTypes = [meta.subjectType, meta["@type"], meta.jsonLd?.["@type"]].flat().filter(Boolean);
  const types = rawTypes.map((type) => String(type).split(/[\/#]/).at(-1).toLowerCase());
  const episodic = types.some((type) => ["tvseries", "tvseason", "tvepisode"].includes(type))
    || positiveCount(meta.seasonCount) || positiveCount(meta.episodeCount) || hasText(meta.episodeDuration)
    || [info["季数"], info["集数"]].some((value) => /[1-9]\d*/.test(String(value ?? "")))
    || hasText(info["单集片长"]);
  if (episodic) return "episodic-subject";
  if (!types.includes("movie") && !(hasText(info["上映日期"]) && hasText(info["片长"]))) return "unknown-subject-type";
  return "";
}

export function inspectMovieCandidate(target, meta) {
  const failure = candidateFailure(meta);
  if (failure) return { matched: false, reason: failure };
  const local = movieMatchTarget(target);
  if (local.conflictingYears) return { matched: false, reason: "conflicting-local-years" };
  if (!local.titles.size) return { matched: false, reason: "missing-local-title" };
  const remoteTitles = [meta.title, meta.originalTitle, ...(Array.isArray(meta.aliases) ? meta.aliases : [])]
    .flatMap((title) => [...titleVariants(title)]);
  if (!remoteTitles.some((title) => local.titles.has(title))) return { matched: false, reason: "title-mismatch" };
  const year = String(meta.year ?? "").trim();
  if (local.year && year !== local.year) return { matched: false, reason: "year-mismatch" };
  return { matched: true, reason: "" };
}

export function chooseMovieMetadata(target, candidates) {
  const matches = new Map();
  for (const candidate of candidates || []) {
    if (inspectMovieCandidate(target, candidate).matched) {
      matches.set(canonicalDoubanSubjectUrl(candidate.doubanUrl), candidate);
    }
  }
  if (matches.size !== 1) throw new MovieMetadataMatchError(matches.size ? "ambiguous-subjects" : "no-confirmed-movie");
  return matches.values().next().value;
}

export function validateManualMovieMetadata(meta) {
  const failure = candidateFailure(meta);
  if (failure) throw new MovieMetadataMatchError(failure);
  return meta;
}
