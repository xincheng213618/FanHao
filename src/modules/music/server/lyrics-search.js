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
    ? "SELECT COUNT(*) AS count FROM music_search WHERE music_search MATCH ?"
    : "SELECT COUNT(*) AS count FROM music_lyrics WHERE raw_text LIKE ? ESCAPE '\\'"
  ).get(searchArg)?.count || 0);
  const select = `
    SELECT t.*, a.name AS artist_name, al.title AS album_name, al.cover_path,
           s.favorite, s.rating, s.position_ms, s.duration_ms AS state_duration_ms,
           s.play_count, s.last_played_at, l.parsed_json, l.raw_text
  `;
  const rows = indexed ? db.prepare(`
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
  `).all(searchArg, limit, offset) : shortLyricRows(db, searchArg, limit, offset);
  return {
    query,
    matches: rows.map((row) => lyricMatch(row, query)),
    total,
    limit,
    offset,
    hasMore: offset + rows.length < total,
    indexed
  };
}

function shortLyricRows(db, searchArg, limit, offset) {
  const lyrics = db.prepare(`
    SELECT track_id, parsed_json, raw_text
    FROM music_lyrics
    WHERE raw_text LIKE ? ESCAPE '\\'
    LIMIT ? OFFSET ?
  `).all(searchArg, limit, offset);
  const track = db.prepare(`
    SELECT t.*, a.name AS artist_name, al.title AS album_name, al.cover_path,
           s.favorite, s.rating, s.position_ms, s.duration_ms AS state_duration_ms,
           s.play_count, s.last_played_at
    FROM music_tracks t
    LEFT JOIN music_artists a ON a.id = t.artist_id
    LEFT JOIN music_albums al ON al.id = t.album_id
    LEFT JOIN music_track_state s ON s.track_id = t.id
    WHERE t.id = ? AND t.status = 'ok'
  `);
  return lyrics
    .map((lyric) => {
      const row = track.get(lyric.track_id);
      return row ? { ...row, parsed_json: lyric.parsed_json, raw_text: lyric.raw_text } : null;
    })
    .filter(Boolean);
}

function emptyLyricSearch(query, limit, offset) {
  return { query, matches: [], total: 0, limit, offset, hasMore: false, indexed: false };
}

function lyricMatch(row, query) {
  const lines = parseJsonArray(row.parsed_json)
    .map((line) => ({ timeMs: Math.max(0, Number(line?.timeMs || 0)), text: String(line?.text || "").trim() }))
    .filter((line) => line.text);
  const index = bestLyricLineIndex(lines, query);
  const selected = lines[index] || { timeMs: 0, text: fallbackLyricText(row.raw_text, query) };
  return {
    track: publicTrack(row),
    lineIndex: Math.max(0, index),
    timeMs: selected.timeMs,
    text: selected.text,
    before: previousLyricText(lines, index),
    after: nextLyricText(lines, index),
    highlights: matchedLyricTerms(selected.text, query)
  };
}

function bestLyricLineIndex(lines, query) {
  const normalizedQuery = normalizeComparable(query);
  const terms = lyricSearchTerms(query);
  let bestIndex = -1;
  let bestScore = 0;
  lines.forEach((line, index) => {
    const text = normalizeComparable(line.text);
    if (!text) return;
    let score = text.includes(normalizedQuery) ? 1000 + normalizedQuery.length : 0;
    const matched = terms.filter((term) => text.includes(term));
    score += matched.length * 120 + matched.reduce((sum, term) => sum + term.length, 0);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function previousLyricText(lines, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (lines[cursor]?.text) return lines[cursor].text;
  }
  return "";
}

function nextLyricText(lines, index) {
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    if (lines[cursor]?.text) return lines[cursor].text;
  }
  return "";
}

function fallbackLyricText(rawText, query) {
  const lines = String(rawText || "").split(/\r?\n/u).map((line) => line.replace(/^(?:\[[^\]]*\])+\s*/u, "").trim()).filter(Boolean);
  const normalizedQuery = normalizeComparable(query);
  return lines.find((line) => normalizeComparable(line).includes(normalizedQuery)) || lines[0] || "歌词命中";
}

function matchedLyricTerms(text, query) {
  const source = String(text || "");
  const normalizedSource = normalizeComparable(source);
  const phrases = [...new Set([normalizeComparable(query), ...lyricSearchTerms(query)].filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  return phrases.filter((term) => normalizedSource.includes(term));
}

function lyricSearchTerms(value) {
  const normalized = normalizeComparable(value);
  const words = normalized.match(/[\p{L}\p{N}]+/gu) || [];
  return words.length > 1 ? [...new Set(words)] : normalized ? [normalized] : [];
}

function normalizeComparable(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}
