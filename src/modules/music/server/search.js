// Music store sub-module: search
import { escapeLike } from "./helpers.js";

export function musicSearchIndexKind(value) {
  if (canUseTrigramSearch(value)) return "trigram";
  if (canUseShortSearch(value)) return "short";
  return "";
}

export function musicSearchIndexTable(kind) {
  if (kind === "trigram") return "music_search";
  if (kind === "short") return "music_search_short";
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
  return kind === "short" ? shortSearchFtsTerm(value) : ftsTerm(value);
}


export function musicSearchIndexRank(kind, value) {
  return kind === "short" ? shortFtsRankOrderSql(value) : ftsRankOrderSql(value);
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
    && !filter.smartId;
}


export function musicShortSearchDocumentCount(db, value) {
  const term = normalizeSearchText(value).toLocaleLowerCase();
  return Number(db.prepare("SELECT doc AS count FROM music_search_short_vocab WHERE term = ?").get(term)?.count || 0);
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
