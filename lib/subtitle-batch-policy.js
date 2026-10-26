import { extractWorkCodes, workCodeKey } from "./code-parser.js";
import { convertSubtitle, matchSubtitleCandidates } from "./subtitles.js";
import { deriveWorkTraits } from "./work-traits.js";

function basename(value) {
  return typeof value === "string" ? value.normalize("NFKC").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "" : "";
}

function codeText(value) {
  // Keep the edition handling aligned with subtitle identity matching: a glued
  // U/UC/C is a copy marker, rather than part of the release number.
  return String(value || "").normalize("NFKC")
    .replace(/([A-Z]{2,12}[-_. ]?\d{2,8})(?:UC|UN|U|CH|C|SUB)(?=$|[^A-Z0-9])/gi, "$1");
}

function codes(value) { return extractWorkCodes(codeText(value)); }

// These are explicit edition markers only. C/CH mean Chinese subtitles in local
// filenames and must never be interpreted as CENSORED (including a glued UC).
export function subtitleEditionConflict(left, right) {
  const edition = (value) => {
    const text = String(value || "").normalize("NFKC");
    const ai = /(?:^|[^A-Z0-9])AI(?:$|[^A-Z0-9])|AI[去解][码碼]|[无無][码碼]破解/i.test(text)
      || /[A-Z]{2,12}[-_. ]?\d{2,8}AI(?=$|[^A-Z0-9])/i.test(text);
    const censored = /(?:^|[^A-Z0-9])CENSORED(?:$|[^A-Z0-9])|有[码碼]/i.test(text);
    const uncensored = /(?:^|[^A-Z0-9])(?:UNCENSORED|UC|UN|U)(?:$|[^A-Z0-9])|[无無][码碼]/i.test(text)
      || /[A-Z]{2,12}[-_. ]?\d{2,8}(?:UC|UN|U)(?=$|[^A-Z0-9])/i.test(text);
    return new Set([...(censored ? ["censored"] : []), ...(ai ? ["ai"] : uncensored ? ["uncensored"] : [])]);
  };
  const a = edition(left), b = edition(right);
  return a.size > 0 && b.size > 0 && [...a].some((value) => [...b].some((other) => value !== other));
}

// The shared matcher intentionally has a narrow bare-part grammar. Normalize
// zero-padded suffixes on copies here so AB-123-01 cannot match a whole movie.
export function normalizeSubtitleBatchPart(file) {
  const name = basename(file?.name);
  const dot = name.lastIndexOf(".");
  const body = dot < 0 ? name : name.slice(0, dot);
  const suffix = dot < 0 ? "" : name.slice(dot);
  const part = /[-_. ]0+([1-9]\d?)(?=(?:[-_. ](?:chs|cht|zh(?:[-_. ](?:cn|tw|sg|hk|mo|hans|hant))?|en|eng|ja|jp|jpn|4k|8k|\d{3,4}p|uhd|fhd|hd))*$)/i.exec(body);
  if (!part || codes(body.slice(0, part.index)).length !== 1) return file;
  return { ...file, name: `${body.slice(0, part.index)}-CD${Number(part[1])}${body.slice(part.index + part[0].length)}${suffix}` };
}

export function workQuery(video, work = {}) {
  for (const value of [basename(video?.name), work.infoSummary?.code, work.code, basename(work.directoryName)]) {
    const found = codes(value);
    if (found.length) return found.length === 1 ? found[0] : "";
  }
  return "";
}

export function hasChineseFilename(video, work = {}) {
  const names = [basename(video?.name)];
  const videos = Array.isArray(work.videos) ? work.videos : [];
  const singleVideo = videos.length === 1
    && (videos[0] === video || (video?.id != null && String(videos[0]?.id) === String(video.id)) || basename(videos[0]?.name) === names[0]);
  if (singleVideo || (!Array.isArray(work.videos) && Number(work.videoCount) === 1)) names.push(basename(work.directoryName));
  const local = { videos: [{ name: names[0] }], directoryName: names[1] || "" };
  // Deliberately pass no metadata, tags or availability.hasSubtitles from work.
  if (deriveWorkTraits(local, {}).flags.subtitled) return true;
  return names.some((name) => {
    const stem = name.replace(/\.(?:mp4|mkv|avi|mov|wmv|m4v|ts|m2ts|webm|flv|mpg|mpeg|vob|iso)$/i, "");
    return /中文字幕|[简簡][体體]字幕|繁[体體]字幕/.test(stem)
      || /(?:^|[^\p{L}\p{N}])(?:CHS|CHT|zh(?:[-_. ](?:CN|TW|SG|HK|MO|Hans|Hant))?|[简簡][体體中]|繁[体體中]|中文|中字)(?=$|[^\p{L}\p{N}])/iu.test(stem);
  });
}

export function looksChineseSubtitle(vtt) {
  let normalized;
  try { normalized = convertSubtitle(vtt, { name: "candidate.vtt" }).vtt; }
  catch { return false; }
  const cueBodies = normalized.split(/\n\s*\n/).map((block) => {
    const lines = block.split("\n");
    const at = lines.findIndex((line) => line.includes("-->"));
    return at < 0 ? "" : lines.slice(at + 1).join("\n");
  }).filter(Boolean).map((body) => body.replace(/<[^>]*>|&(?:#x?[\da-f]+|[a-z]+);/gi, ""));
  const body = cueBodies.join("\n");
  const han = (body.match(/\p{Script=Han}/gu) || []).length;
  const kanaOrHangul = (body.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
  const letters = (body.match(/\p{L}/gu) || []).length;
  // Kanji-only names/credits do not establish Chinese dialogue. Requiring common
  // Chinese function words also avoids treating a Japanese title as subtitles.
  const commonChinese = (body.match(/[的了是不我你他她这這有在好说說为為们們来來着著吗嗎呢吧會会请請]/gu) || []).length;
  const chineseCues = cueBodies.filter((body) => (body.match(/\p{Script=Han}/gu) || []).length >= 4
    && /[的了是不我你他她这這有在好说說为為们們来來着著吗嗎呢吧會会请請]/u.test(body)).length;
  const bilingual = han >= 32 && commonChinese >= 8 && chineseCues >= 3
    && chineseCues / Math.max(1, cueBodies.length) >= 0.4;
  return han >= 16 && commonChinese >= 3 && (han / Math.max(1, letters) >= 0.5 || bilingual)
    && kanaOrHangul <= Math.floor(han * 0.002);
}

function languageRank(language) {
  if (/^zh-(?:CN|SG|Hans)(?:-|$)/i.test(language)) return 0;
  if (/^zh-(?:TW|HK|MO|Hant)(?:-|$)/i.test(language)) return 1;
  return 2;
}

function isOnlyCode(value, expected) {
  const found = codes(value);
  return found.length === 1 && workCodeKey(found[0]) === expected;
}

export function chooseChineseCandidates(video, videos, results, filesByResult) {
  const found = codes(basename(video?.name));
  if (found.length !== 1 || !(filesByResult instanceof Map)) return [];
  const expected = workCodeKey(found[0]);
  const siblings = Array.isArray(videos) && videos.length ? [...videos] : [video];
  if (!siblings.some((item) => item === video || (item?.id != null && item.id === video?.id) || basename(item?.name) === basename(video?.name))) siblings.push(video);
  const target = normalizeSubtitleBatchPart(video), matchingSiblings = siblings.map(normalizeSubtitleBatchPart);
  const chosen = [], seen = new Set();
  for (const result of Array.isArray(results) ? results : []) {
    if (!result?.id || !isOnlyCode(result.title, expected) || subtitleEditionConflict(video?.name, result.title)) continue;
    for (const file of filesByResult.get(result.id)?.files || []) {
      if (!file?.id || !/^zh(?:-[a-z0-9]{2,8})*$/i.test(String(file.language || "")) || !isOnlyCode(basename(file.name), expected)) continue;
      if (subtitleEditionConflict(video?.name, file.name) || subtitleEditionConflict(result.title, file.name)) continue;
      const match = matchSubtitleCandidates(target, matchingSiblings, [normalizeSubtitleBatchPart(file)])[0]?.match;
      if (!match || match === "manual") continue;
      const key = `${result.id}\u0000${file.id}`;
      if (seen.has(key)) continue;
      seen.add(key); chosen.push({ result, file, match });
    }
  }
  const order = { exact: 0, language: 1, code: 2 };
  return chosen.sort((a, b) => languageRank(a.file.language) - languageRank(b.file.language)
    || order[a.match] - order[b.match]
    || String(a.result.title).localeCompare(String(b.result.title), "zh-CN")
    || String(a.file.name).localeCompare(String(b.file.name), "zh-CN")
    || String(a.result.id).localeCompare(String(b.result.id)) || String(a.file.id).localeCompare(String(b.file.id)));
}
