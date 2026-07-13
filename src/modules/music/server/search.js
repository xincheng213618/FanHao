// Music store sub-module: search
import { pinyin } from "pinyin-pro";
import { escapeLike } from "./helpers.js";

export const MUSIC_PHONETIC_INDEX_VERSION = "1";
const SEARCH_MATCH_CACHE_LIMIT = 4096;
const searchMatchPhoneticCache = new Map();

export function musicSearchIndexKind(value) {
  if (canUsePhoneticSearch(value)) return "phonetic";
  if (canUseTrigramSearch(value)) return "trigram";
  if (canUseShortSearch(value)) return "short";
  return "";
}

export function musicSearchIndexTable(kind) {
  if (kind === "trigram") return "music_search";
  if (kind === "short") return "music_search_short";
  if (kind === "phonetic") return "music_search_phonetic";
  return "";
}


export function musicSearchIndexJoin(kind) {
  const table = musicSearchIndexTable(kind);
  return table ? `JOIN ${table} ON ${table}.track_id = t.id` : "";
}


export function musicSearchIndexCondition(kind) {
  const table = musicSearchIndexTable(kind);
  if (kind === "short") return `${table} MATCH ? AND ${table}.rank MATCH 'bm25(0,10,6,3,1,0.5)'`;
  return `${table} MATCH ?`;
}


export function musicSearchIndexTerm(kind, value) {
  if (kind === "phonetic") return phoneticSearchFtsTerm(value);
  return kind === "short" ? shortSearchFtsTerm(value) : ftsTerm(value);
}


export function musicSearchIndexRank(kind, value) {
  if (kind === "phonetic") return phoneticFtsRankOrderSql();
  return kind === "short" ? shortFtsRankOrderSql(value) : ftsRankOrderSql(value);
}


export function canUsePhoneticSearch(value) {
  const normalized = normalizeSearchText(value);
  return /^[\p{Script=Latin}\p{N} ._&'’-]{3,}$/u.test(normalized)
    && /[\p{Script=Latin}]/u.test(normalized);
}


export function canUseShortSearch(value) {
  return /^[\p{L}\p{N}]{1,2}$/u.test(normalizeSearchText(value));
}


export function canUseShortVocabularyCount(filter) {
  return filter.searchKind === "short"
    && (!filter.artistId || filter.artistId === "all")
    && (!filter.albumId || filter.albumId === "all")
    && (!filter.genre || filter.genre === "all")
    && !filter.language
    && !filter.favorite
    && !filter.lyrics
    && !filter.minRating
    && !filter.quality
    && !filter.smartId;
}


export function musicShortSearchDocumentCount(db, value) {
  const term = normalizeSearchText(value).toLocaleLowerCase();
  return Number(db.prepare("SELECT doc AS count FROM music_search_short_vocab WHERE term = ?").get(term)?.count || 0);
}


export function musicIndexedSearchDocumentCount(db, filter) {
  if (!["trigram", "phonetic"].includes(filter?.searchKind)
    || filter.artistId
    || filter.albumId
    || filter.genre
    || filter.language
    || filter.favorite
    || filter.lyrics
    || filter.minRating
    || filter.quality
    || filter.smartId) return null;
  const table = musicSearchIndexTable(filter.searchKind);
  const term = musicSearchIndexTerm(filter.searchKind, filter.searchTerm || filter.q);
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${table} MATCH ?`).get(term)?.count || 0);
}


export function shortSearchFtsTerm(value) {
  const normalized = normalizeSearchText(value).toLocaleLowerCase();
  return `"${normalized.replace(/"/g, '""')}"`;
}


export function shortSearchGrams(value) {
  const characters = Array.from(String(value || "").normalize("NFKC").toLocaleLowerCase());
  const grams = new Set();
  for (let index = 0; index < characters.length; index += 1) {
    const current = characters[index];
    if (/^[\p{L}\p{N}]$/u.test(current)) grams.add(current);
    const pair = `${current}${characters[index + 1] || ""}`;
    if (/^[\p{L}\p{N}]{2}$/u.test(pair)) grams.add(pair);
  }
  return [...grams].join(" ");
}


export function insertMusicShortSearchRow(statement, track) {
  statement.run(
    track.id,
    shortSearchGrams(track.title),
    shortSearchGrams(track.displayArtist ?? track.display_artist),
    shortSearchGrams(track.albumTitle ?? track.album_title),
    shortSearchGrams(track.genre),
    shortSearchGrams(track.fileName ?? track.file_name)
  );
}


export function insertMusicPhoneticSearchRow(statement, track, cache = null) {
  const document = (value) => {
    const key = String(value || "");
    if (cache?.has(key)) return cache.get(key);
    const result = phoneticSearchDocument(key);
    cache?.set(key, result);
    return result;
  };
  statement.run(
    track.id,
    track.artistId ?? track.artist_id ?? "",
    track.albumId ?? track.album_id ?? "",
    document(track.title),
    document(track.displayArtist ?? track.display_artist),
    document(track.albumTitle ?? track.album_title),
    document(track.fileName ?? track.file_name)
  );
}


export function phoneticSearchDocument(value) {
  const normalized = normalizeSearchText(value).toLocaleLowerCase();
  if (!normalized) return "";
  const syllables = pinyin(normalized, {
    toneType: "none",
    type: "array",
    nonZh: "consecutive",
    v: true
  }).map(normalizePhoneticToken).filter(Boolean);
  const words = normalized.match(/[\p{L}\p{N}]+/gu)?.map(normalizePhoneticToken).filter(Boolean) || [];
  const compact = syllables.join("");
  const initials = syllables.map((token) => token[0] || "").join("");
  const wordInitials = words.map((token) => token[0] || "").join("");
  return [...new Set([
    normalized,
    words.join(" "),
    words.join(""),
    syllables.join(" "),
    compact,
    initials,
    wordInitials
  ].map((item) => item.trim()).filter(Boolean))].join(" ");
}


export function musicSearchValueMatch(value, query) {
  const source = String(value || "");
  const needle = normalizeSearchText(query).toLocaleLowerCase();
  if (!source || !needle) return { score: 0, highlights: [] };
  const normalizedSource = normalizeSearchText(source).toLocaleLowerCase();
  const directRanges = directSearchRanges(source, needle);
  const sourcePhonetic = phoneticUnits(source);
  const queryPhonetic = phoneticUnits(needle);
  const phoneticRanges = [];
  const queryVariants = [...new Set([
    compactPhoneticText(needle),
    queryPhonetic.compact,
    queryPhonetic.initials
  ].filter((item) => item.length >= 2))];
  for (const variant of queryVariants) {
    collectMappedRanges(sourcePhonetic.compact, sourcePhonetic.compactMap, variant, phoneticRanges);
    collectMappedRanges(sourcePhonetic.initials, sourcePhonetic.initialMap, variant, phoneticRanges);
  }
  const ranges = mergeCharacterRanges([...directRanges, ...phoneticRanges]);
  let score = 0;
  if (normalizedSource === needle) score = 1000;
  else if (sourcePhonetic.compact === queryPhonetic.compact) score = 940;
  else if (sourcePhonetic.initials === queryPhonetic.compact || sourcePhonetic.initials === queryPhonetic.initials) score = 900;
  else if (normalizedSource.startsWith(needle)) score = 820;
  else if (sourcePhonetic.compact.startsWith(queryPhonetic.compact)) score = 780;
  else if (sourcePhonetic.initials.startsWith(queryPhonetic.compact)) score = 740;
  else if (directRanges.length) score = 680;
  else if (phoneticRanges.length) score = 620;
  return {
    score,
    highlights: ranges.map(([start, end]) => Array.from(source).slice(start, end).join("")).filter(Boolean)
  };
}


export function phoneticSearchFtsTerm(value) {
  const normalized = normalizeSearchText(value).toLocaleLowerCase();
  const syllables = pinyin(normalized, {
    toneType: "none",
    type: "array",
    nonZh: "consecutive",
    v: true
  }).map(normalizePhoneticToken).filter(Boolean);
  const words = normalized.match(/[\p{L}\p{N}]+/gu)?.map(normalizePhoneticToken).filter(Boolean) || [];
  const variants = [];
  appendPhoneticVariant(variants, words);
  appendPhoneticVariant(variants, syllables);
  appendPhoneticVariant(variants, [words.join("")]);
  appendPhoneticVariant(variants, [syllables.join("")]);
  const unique = [...new Set(variants.filter(Boolean))];
  return unique.length > 1 ? `(${unique.map((item) => `(${item})`).join(" OR ")})` : unique[0] || '""';
}


export function findPhoneticCorrection(db, value) {
  const words = normalizeSearchText(value).toLocaleLowerCase().match(/[a-z]+/g) || [];
  if (words.length > 1) {
    let changed = false;
    const corrected = words.map((word) => {
      const next = findPhoneticWordCorrection(db, word);
      if (next) changed = true;
      return next || word;
    });
    return changed ? corrected.join(" ") : "";
  }
  return findPhoneticWordCorrection(db, normalizePhoneticToken(normalizeSearchText(value)));
}


function findPhoneticWordCorrection(db, query) {
  if (!/^[a-z]{5,32}$/.test(query)) return "";
  const prefixLength = query.length >= 9 ? 3 : 2;
  const prefix = query.slice(0, prefixLength);
  const maxDistance = query.length >= 8 ? 2 : 1;
  const candidates = db.prepare(`
    SELECT term, doc
    FROM music_search_phonetic_vocab
    WHERE term GLOB ? AND length(term) BETWEEN ? AND ?
    ORDER BY doc DESC
    LIMIT 500
  `).all(`${prefix}*`, query.length - maxDistance, query.length + maxDistance);
  let best = null;
  for (const candidate of candidates) {
    const term = String(candidate.term || "");
    if (!/^[a-z]+$/.test(term) || term === query) continue;
    const distance = editDistance(query, term, maxDistance);
    if (distance > maxDistance) continue;
    if (!best || distance < best.distance || (distance === best.distance && Number(candidate.doc || 0) > best.doc)) {
      best = { term, distance, doc: Number(candidate.doc || 0) };
    }
  }
  return best?.term || "";
}


export function phoneticEntityCondition(column, value) {
  const field = ["title", "artist", "album", "file_name"].includes(column) ? column : "title";
  return {
    sql: `music_search_phonetic MATCH ?`,
    term: `${field}: ${phoneticSearchFtsTerm(value)}`
  };
}


export function ftsTerm(value) {
  const normalized = normalizeSearchText(value);
  const terms = normalized
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => Array.from(term).length >= 3);
  if (terms.length > 1) return terms.map(ftsPhrase).join(" AND ");
  const compact = terms[0] || normalized.replace(/\s+/gu, "");
  const characters = Array.from(compact);
  if (characters.length < 6 || /\s/u.test(normalized)) return ftsPhrase(compact);
  const variants = [ftsPhrase(compact)];
  for (let index = 3; index <= characters.length - 3; index += 1) {
    variants.push(`(${ftsPhrase(characters.slice(0, index).join(""))} AND ${ftsPhrase(characters.slice(index).join(""))})`);
  }
  return `(${variants.join(" OR ")})`;
}


export function canUseTrigramSearch(value) {
  return normalizeSearchText(value)
    .split(/\s+/u)
    .some((term) => Array.from(term).length >= 3);
}


export function ftsPhrase(value) {
  return `"${String(value || "").replace(/"/g, '""')}"`;
}


export function normalizeSearchText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}


export function ftsRankOrderSql(value) {
  const query = normalizeSearchText(value);
  return {
    sql: `CASE
      WHEN t.title = ? COLLATE NOCASE THEN 0
      WHEN t.display_artist = ? COLLATE NOCASE THEN 1
      WHEN t.album_title = ? COLLATE NOCASE THEN 2
      ELSE 3
    END ASC, bm25(music_search, 0, 10, 6, 3, 0.5) ASC, COALESCE(s.play_count, 0) DESC, t.title COLLATE NOCASE ASC`,
    args: [query, query, query]
  };
}


export function shortFtsRankOrderSql(value) {
  return {
    sql: "music_search_short.rank ASC",
    args: []
  };
}


export function phoneticFtsRankOrderSql() {
  return {
    sql: "bm25(music_search_phonetic, 0, 0, 0, 12, 16, 6, 1) ASC, a.track_count DESC, COALESCE(s.play_count, 0) DESC, t.title COLLATE NOCASE ASC",
    args: []
  };
}


export function searchRankSql(value) {
  const query = normalizeSearchText(value);
  if (!query) return { sql: "", args: [] };
  const args = [query, query, query];
  const scores = [
    "CASE WHEN t.title = ? COLLATE NOCASE THEN 600 ELSE 0 END",
    "CASE WHEN t.display_artist = ? COLLATE NOCASE THEN 420 ELSE 0 END",
    "CASE WHEN t.album_title = ? COLLATE NOCASE THEN 220 ELSE 0 END"
  ];
  const terms = searchRankTerms(query);
  for (const term of terms) {
    const like = `%${escapeLike(term)}%`;
    scores.push("CASE WHEN t.title LIKE ? ESCAPE '\\' THEN 40 ELSE 0 END");
    scores.push("CASE WHEN t.display_artist LIKE ? ESCAPE '\\' THEN 24 ELSE 0 END");
    scores.push("CASE WHEN t.album_title LIKE ? ESCAPE '\\' THEN 12 ELSE 0 END");
    scores.push("CASE WHEN t.file_name LIKE ? ESCAPE '\\' THEN 6 ELSE 0 END");
    args.push(like, like, like, like);
  }
  return {
    sql: `(${scores.join(" + ")}) DESC, COALESCE(s.play_count, 0) DESC, t.title COLLATE NOCASE ASC`,
    args
  };
}


export function searchRankTerms(value) {
  const normalized = normalizeSearchText(value);
  const terms = normalized.split(/\s+/u).filter(Boolean);
  if (terms.length > 1) return [...new Set(terms)];
  const characters = Array.from(terms[0] || "");
  if (characters.length < 6) return terms;
  const middle = Math.floor(characters.length / 2);
  return [...new Set([terms[0], characters.slice(0, middle).join(""), characters.slice(middle).join("")])];
}


function appendPhoneticVariant(target, tokens) {
  const clean = (tokens || []).map(normalizePhoneticToken).filter(Boolean);
  if (!clean.length) return;
  target.push(clean.map((token) => `${ftsPhrase(token)}*`).join(" AND "));
}


function directSearchRanges(source, query) {
  const characters = Array.from(source);
  const lower = characters.map((character) => character.toLocaleLowerCase()).join("");
  const terms = [...new Set([query, ...(query.match(/[\p{L}\p{N}]+/gu) || [])].filter((item) => item.length >= 2))];
  const ranges = [];
  for (const term of terms) {
    let cursor = 0;
    let index = lower.indexOf(term, cursor);
    while (index >= 0) {
      ranges.push([index, index + Array.from(term).length]);
      cursor = index + Math.max(1, Array.from(term).length);
      index = lower.indexOf(term, cursor);
    }
  }
  return ranges;
}


function phoneticUnits(value) {
  const cacheKey = String(value || "").normalize("NFKC");
  const cached = searchMatchPhoneticCache.get(cacheKey);
  if (cached) return cached;
  const characters = Array.from(cacheKey);
  const compactParts = [];
  const compactMap = [];
  const initialParts = [];
  const initialMap = [];
  characters.forEach((character, characterIndex) => {
    const token = normalizePhoneticToken(pinyin(character, {
      toneType: "none",
      type: "array",
      v: true
    })[0] || character);
    if (!token) return;
    compactParts.push(token);
    compactMap.push(...Array.from({ length: Array.from(token).length }, () => characterIndex));
    const initial = token[0] || "";
    if (initial) {
      initialParts.push(initial);
      initialMap.push(characterIndex);
    }
  });
  const result = {
    compact: compactParts.join(""),
    compactMap,
    initials: initialParts.join(""),
    initialMap
  };
  if (searchMatchPhoneticCache.size >= SEARCH_MATCH_CACHE_LIMIT) {
    searchMatchPhoneticCache.delete(searchMatchPhoneticCache.keys().next().value);
  }
  searchMatchPhoneticCache.set(cacheKey, result);
  return result;
}


function compactPhoneticText(value) {
  return normalizePhoneticToken(value);
}


function collectMappedRanges(haystack, map, needle, target) {
  if (!haystack || !needle || !map.length) return;
  let cursor = 0;
  let index = haystack.indexOf(needle, cursor);
  while (index >= 0) {
    const start = map[index];
    const end = map[index + needle.length - 1];
    if (Number.isInteger(start) && Number.isInteger(end)) target.push([start, end + 1]);
    cursor = index + Math.max(1, needle.length);
    index = haystack.indexOf(needle, cursor);
  }
}


function mergeCharacterRanges(ranges) {
  const sorted = ranges
    .filter(([start, end]) => Number.isInteger(start) && Number.isInteger(end) && end > start)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || range[0] > previous[1]) merged.push([...range]);
    else previous[1] = Math.max(previous[1], range[1]);
  }
  return merged;
}


function normalizePhoneticToken(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}


function editDistance(left, right, limit) {
  const a = Array.from(left);
  const b = Array.from(right);
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    let rowMin = row;
    for (let column = 1; column <= b.length; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      let value = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + cost
      );
      current[column] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}
