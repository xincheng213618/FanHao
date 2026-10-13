import { TRACK_LIST_COLUMNS, prepareTrackList } from "./track-query.js";
// Music store sub-module: full-text lyric search and timed context snippets
import { publicTrack } from "./serializers.js";
import { clampInt, escapeLike, parseJsonArray } from "./helpers.js";
import { ftsTerm, normalizeSearchText } from "./search.js";

const DEFAULT_LYRIC_SEARCH_LIMIT = 40;
const MAX_LYRIC_SEARCH_LIMIT = 100;

export function listLyricMatches(db, urlOrOptions = {}) {
  const params = urlOrOptions?.searchParams || new URLSearchParams();
  const query = normalizeSearchText(params.get("q") || params.get("search") || "");
  const limit = clampInt(params.get("limit"), DEFAULT_LYRIC_SEARCH_LIMIT, 1, MAX_LYRIC_SEARCH_LIMIT);
  const offset = clampInt(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  if (!query) return emptyLyricSearch(query, limit, offset);

  const indexed = Array.from(query.replace(/\s+/gu, "")).length >= 3;
  const searchJoin = indexed ? "JOIN music_search ON music_search.track_id = t.id" : "";
  const condition = indexed ? "music_search MATCH ?" : "l.raw_text LIKE ? ESCAPE '\\'";
  const searchArg = indexed ? `lyrics: ${ftsTerm(query)}` : `%${escapeLike(query)}%`;
  const total = Number(db.prepare(indexed
    ? `SELECT COUNT(*) AS count FROM music_search
       JOIN music_tracks t ON t.id = music_search.track_id
       JOIN music_lyrics l ON l.track_id = t.id
       WHERE t.status = 'ok' AND music_search MATCH ?`
    : `SELECT COUNT(*) AS count FROM music_lyrics l
       WHERE l.raw_text LIKE ? ESCAPE '\\' AND EXISTS (
         SELECT 1 FROM music_tracks t WHERE t.id = l.track_id AND t.status = 'ok'
       )`
  ).get(searchArg)?.count || 0);
  const select = `
    SELECT ${TRACK_LIST_COLUMNS}, a.name AS artist_name, al.title AS album_name, al.cover_path,
           s.favorite, s.rating, s.position_ms, s.duration_ms AS state_duration_ms,
           s.play_count, s.last_played_at, l.parsed_json, l.raw_text
  `;
  const rows = indexed ? prepareTrackList(db, `
    ${select}
    FROM music_tracks t
    JOIN music_lyrics l ON l.track_id = t.id
    ${searchJoin}
    LEFT JOIN music_artists a ON a.id = t.artist_id
    LEFT JOIN music_albums al ON al.id = t.album_id
    LEFT JOIN music_track_state s ON s.track_id = t.id
    WHERE t.status = 'ok' AND ${condition}
    ORDER BY bm25(music_search, 0, 0, 0, 0, 12) ASC,
             COALESCE(s.play_count, 0) DESC, t.title COLLATE NOCASE ASC
    LIMIT ? OFFSET ?
  `).all(searchArg, limit, offset) : shortLyricRows(db, searchArg, limit, offset, select);
  const context = lyricQueryContext(query);
  return {
    query,
    matches: rows.map((row) => lyricMatch(row, query, context)),
    total,
    limit,
    offset,
    hasMore: offset + rows.length < total,
    indexed
  };
}

function shortLyricRows(db, searchArg, limit, offset, select) {
  // Keep the lyric candidate scan in its existing order. Active membership is
  // applied before paging; CROSS JOIN keeps the bounded page as the outer loop.
  return prepareTrackList(db, `
    ${select}
    FROM (
      SELECT track_id, parsed_json, raw_text
      FROM music_lyrics l
      WHERE raw_text LIKE ? ESCAPE '\\' AND EXISTS (
        SELECT 1 FROM music_tracks t WHERE t.id = l.track_id AND t.status = 'ok'
      )
      LIMIT ? OFFSET ?
    ) l
    CROSS JOIN music_tracks t
    LEFT JOIN music_artists a ON a.id = t.artist_id
    LEFT JOIN music_albums al ON al.id = t.album_id
    LEFT JOIN music_track_state s ON s.track_id = t.id
    WHERE t.id = l.track_id
  `).all(searchArg, limit, offset);
}

function emptyLyricSearch(query, limit, offset) {
  return { query, matches: [], total: 0, limit, offset, hasMore: false, indexed: false };
}

function lyricQueryContext(query) {
  const normalizedQuery = normalizeComparable(query);
  const terms = lyricSearchTerms(query);
  const phrases = [...new Set([normalizedQuery, ...terms].filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  return { normalizedQuery, terms, phrases };
}

function lyricMatch(row, query, context) {
  const snippet = { timeMs: 0, text: "", before: "", after: "" };
  const index = bestLyricLineIndex(parseJsonArray(row.parsed_json), context, snippet);
  if (index < 0) snippet.text = fallbackLyricText(row.raw_text, query);
  return {
    track: publicTrack(row),
    lineIndex: Math.max(0, index),
    timeMs: snippet.timeMs,
    text: snippet.text,
    before: snippet.before,
    after: snippet.after,
    highlights: matchedLyricTerms(snippet.text, query, context)
  };
}

function bestLyricLineIndex(lines, context, snippet) {
  let bestIndex = -1;
  let bestScore = 0;
  let index = 0;
  let previousText = "";
  let firstText = "";
  // Select the line and its filtered neighbors without copying every line or
  // allocating a matched-term array for each score. Equal scores keep the first.
  for (const line of lines) {
    const timeMs = Math.max(0, Number(line?.timeMs || 0));
    const text = String(line?.text || "").trim();
    if (!text) continue;
    if (!firstText) firstText = text;
    const normalized = normalizeComparable(text);
    let score = 0;
    if (normalized) {
      score = normalized.includes(context.normalizedQuery) ? 1000 + context.normalizedQuery.length : 0;
      for (const term of context.terms) if (normalized.includes(term)) score += 120 + term.length;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
      snippet.timeMs = timeMs;
      snippet.text = text;
      snippet.before = previousText;
      snippet.after = "";
    } else if (bestIndex >= 0 && !snippet.after) {
      snippet.after = text;
    }
    previousText = text;
    index += 1;
  }
  // With no parsed match, the former index -1 uses the first parsed line as
  // its following context while the selected text comes from raw lyrics.
  if (bestIndex < 0) snippet.after = firstText;
  return bestIndex;
}

function fallbackLyricText(rawText, query) {
  const lines = String(rawText || "").split(/\r?\n/u).map((line) => line.replace(/^(?:\[[^\]]*\])+\s*/u, "").trim()).filter(Boolean);
  const normalizedQuery = normalizeComparable(query);
  return lines.find((line) => normalizeComparable(line).includes(normalizedQuery)) || lines[0] || "歌词命中";
}

function matchedLyricTerms(text, query, context = lyricQueryContext(query)) {
  const source = String(text || "");
  const normalizedSource = normalizeComparable(source);
  return context.phrases.filter((term) => normalizedSource.includes(term));
}

function lyricSearchTerms(value) {
  const normalized = normalizeComparable(value);
  const words = normalized.match(/[\p{L}\p{N}]+/gu) || [];
  return words.length > 1 ? [...new Set(words)] : normalized ? [normalized] : [];
}

function normalizeComparable(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}
