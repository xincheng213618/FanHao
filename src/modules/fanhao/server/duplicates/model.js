import path from "node:path";
import crypto from "node:crypto";
import { extractWorkCodes } from "../../../../../lib/code-parser.js";
import { deriveWorkTraits } from "../../../../../lib/work-traits.js";

const MAX = Number.MAX_SAFE_INTEGER;
const MEDIA_EXTENSION = /\.(?:mp4|mkv|avi|mov|wmv|m4v|ts|m2ts|webm|flv|mpg|mpeg|vob|iso)$/i;
const PART_NAMES = { whole: "未标分卷", A: "A卷", B: "B卷", upper: "上部", middle: "中部", lower: "下部" };
const stableCompare = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true });
const sum = values => { const total = values.reduce((acc, value) => acc + BigInt(value), 0n); return Number(total > BigInt(MAX) ? BigInt(MAX) : total); };
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const basename = value => path.win32.basename(String(value || ""));
const yearLikeCode = code => /^(?!HEYZO-)[A-Z]{2,12}-(?:19|20)\d{2}$/i.test(code);

function safeSize(value) {
  if (typeof value === "string" && !/^\d+$/.test(value)) return 0;
  if (!["number", "string", "bigint"].includes(typeof value)) return 0;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function logicalPath(value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) return "";
  return path.win32.normalize(value.replaceAll("/", "\\")).toLowerCase();
}

export function isVrDuplicateFile(row) {
  if (row?.isVr === true) return true;
  const location = String(row?.path || "").normalize("NFKC").replaceAll("\\", "/");
  if (/^V:\//i.test(location)) return true;
  const text = [location, row?.name, row?.code, row?.title, ...(Array.isArray(row?.tags) ? row.tags : [])]
    .map(value => String(value || "").normalize("NFKC")).join("\n");
  return /(?:^|[^a-z0-9])vr(?:$|[^a-z0-9])/i.test(text)
    || /(?:^|[^a-z0-9])[a-z0-9]*vr[a-z0-9]*[-_. ]*\d{2,9}(?=$|[^a-z0-9])/i.test(text);
}

function preparedName(value) {
  return basename(value).normalize("NFKC").replace(MEDIA_EXTENSION, "")
    .replace(/(?:^|[^A-Z0-9])TOKYO[-_. ]*HOT(?=$|[^A-Z0-9])/gi, " ")
    // Short copy markers are not release-number letters. C means Chinese
    // subtitles here; A/B remain explicit, separately grouped lettered parts.
    .replace(/(\d{1,9})(?:UC|UN|U|CH|C|SUB|AI)(?=$|[^A-Z0-9])/gi, "$1")
    .replace(/(\d{2,9})([AB])(?=$|[^A-Z0-9])/gi, "$1-VOLLETTER$2");
}

function codePattern(code) {
  if (/^FC2-PPV-\d+$/.test(code)) return `FC2[-_.\\s]*(?:PPV[-_.\\s]*)?0*${code.split("-").at(-1)}`;
  if (/^HEYZO-\d+$/.test(code)) return `HEYZO(?:[-_.\\s]*(?:HD|LT|FULL))*[-_.\\s]*0*${code.split("-").at(-1)}`;
  return code.split(/[-.]/).map(token => /^\d+$/.test(token) ? `0*${token.replace(/^0+/, "") || "0"}` : escaped(token)).join("[-_.\\s]*");
}

function codesIn(value) {
  const text = preparedName(value);
  let calendarDate = false;
  const withoutCalendarDates = text.replace(/(?<!\d)(?:19|20)\d{2}[-_.]\d{1,2}[-_.]\d{1,2}(?!\d)/g, match => {
    calendarDate = true;
    return " ".repeat(match.length);
  });
  const codeText = withoutCalendarDates.replace(/(?:^|[^A-Z0-9])(?:CD|DISC|DISK|PART|PT|VOL)[-_. ]*\d{1,4}(?=$|[^A-Z0-9])/gi, match => " ".repeat(match.length));
  const candidates = [];
  // Keep a final date block such as .23.04.02 from being mistaken for a file
  // extension by the shared parser. Positions remain those in the real stem.
  for (let code of extractWorkCodes(`${codeText} `)) {
    const split = /^(3DSVR|CW3D2D?BD|MCB3D(?:BD)?|S2M(?:BD)?|T28|T38|TH101|KIN8|GACHI|C0930|H0930|H4610|RED|GEDO|CZ|N|K|SE)-([A-Z]?\d+)-0*([1-9]\d?)$/i.exec(code);
    if (split) code = extractWorkCodes(`${split[1]}-${split[2]} `)[0] || code;
    const pattern = new RegExp(`(?<![A-Z])${codePattern(code)}(?![A-Z0-9])`, "gi");
    for (const match of codeText.matchAll(pattern)) candidates.push({ code, start: match.index, end: match.index + match[0].length });
  }
  // The shared parser can also recognize AV-123 inside XXX-AV-123. Only
  // overlapping spans are collapsed; an independent AV-123 still makes a
  // multi-release filename ambiguous and therefore ineligible.
  candidates.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start || stableCompare(a.code, b.code));
  const spans = [];
  for (const item of candidates) {
    if (!spans.some(other => item.start < other.end && item.end > other.start)) spans.push(item);
  }
  return { text, spans, calendarDate, codes: [...new Set(spans.map(item => item.code))] };
}

function chineseNumber(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === "十") return 10;
  if (value.includes("十")) {
    const [left, right] = value.split("十");
    return (left ? digits[left] : 1) * 10 + (right ? digits[right] : 0);
  }
  return value.length === 1 ? digits[value] : NaN;
}

function partFor(parsed) {
  const { text, spans } = parsed;
  const parts = new Set();
  const addNumber = raw => {
    const number = chineseNumber(raw);
    if (Number.isInteger(number) && number > 0 && number <= 999) parts.add(String(number));
    else parts.add("ambiguous");
  };
  for (const match of text.matchAll(/(?:^|[^A-Z0-9])(?:CD|DISC|DISK|PART|PT|VOL)[-_. ]*(\d{1,4})(?=$|[^A-Z0-9])/gi)) addNumber(match[1]);
  for (const match of text.matchAll(/(?:^|[^A-Z0-9])(?:CD|DISC|DISK|PART|PT|VOL)[-_. ]*(\d{1,4})[-_~至到]+(?:CD|DISC|DISK|PART|PT|VOL)?[-_. ]*(\d{1,4})(?=$|[^A-Z0-9])/gi)) {
    addNumber(match[1]); addNumber(match[2]);
  }
  for (const match of text.matchAll(/第\s*([零〇一二两兩三四五六七八九十百千万\d]+)\s*[卷部集碟盘盤]/g)) addNumber(match[1]);
  for (const match of text.matchAll(/(?:^|[\s._\-()[\]【】])([零〇一二两兩三四五六七八九十百千万\d]+)\s*[卷部碟盘盤](?=$|[\s._\-()[\]【】])/g)) addNumber(match[1]);
  for (const match of text.matchAll(/(?:^|[^A-Z0-9])VOLLETTER([AB])(?=$|[^A-Z0-9])/gi)) parts.add(match[1].toUpperCase());
  for (const match of text.matchAll(/(?:第\s*)?([上中下])[卷部篇](?=$|[^\p{L}\p{N}])/gu)) parts.add({ 上: "upper", 中: "middle", 下: "lower" }[match[1]]);
  // A bare number counts as a part only after the complete release number.
  // This never consumes a date-id's second block or HEYDOUGA's catalogue id.
  for (const span of spans) {
    const suffix = text.slice(span.end);
    const numeric = /^[-_. ]+0*([1-9]\d?)(?=$|[^A-Z0-9])/i.exec(suffix);
    if (numeric) {
      addNumber(numeric[1]);
      if (/^[-_. ]+\d+(?=$|[^A-Z0-9])/i.test(suffix.slice(numeric[0].length))) parts.add("ambiguous");
    }
    const letter = /^[-_. ]+([AB])(?=$|[^A-Z0-9])/i.exec(suffix);
    if (letter) parts.add(letter[1].toUpperCase());
    const chinese = /^[-_. ]*[(【[]?([上中下])(?:[)】\]\s._-]|$)/u.exec(suffix);
    if (chinese) parts.add({ 上: "upper", 中: "middle", 下: "lower" }[chinese[1]]);
  }
  if (parts.size > 1 || parts.has("ambiguous")) return null;
  // Metadata can supply a release number, but cannot settle whether generic
  // files named movie-1/movie-2 (or simply 1/2) are complete copies or volumes.
  if (!spans.length && !parts.size && /(?:^|[-_. ])(?:\d{1,3}|[AB])$/i.test(text)) return null;
  return [...parts][0] || "whole";
}

function releaseFor(row) {
  const filename = codesIn(row.name || row.path);
  if (filename.codes.length > 1) return null;
  // A four-digit number can be an ordinary JAV release number when the file
  // explicitly names TEST-2023. A person/site plus a year in prose, brackets,
  // or dot-separated credits is insufficient identity for a western work.
  if (yearLikeCode(filename.codes[0] || "")) {
    const code = filename.codes[0];
    const parts = code.split("-");
    const literal = new RegExp(`^${escaped(parts[0])}[-_]0*${parts[1]}$`, "i");
    if (!filename.spans.some(span => span.code === code && literal.test(filename.text.slice(span.start, span.end)))) return null;
  }
  if (!filename.codes.length && filename.calendarDate) return null;
  const metadata = filename.codes.length ? null : codesIn(row.code);
  const code = filename.codes[0] || (metadata.codes.length === 1 ? metadata.codes[0] : "");
  if (!code) return null;
  const codeSource = filename.codes.length ? "filename" : "metadata";
  if (codeSource === "metadata" && yearLikeCode(code)) return null;
  const part = partFor(filename);
  if (part === null) return null;
  // Date-number releases are reused by different suppliers. An explicit
  // supplier is part of their identity; a bare date cannot prove equivalence.
  const supplier = /(?:^|[^A-Z0-9])(CARIBBEANCOMPR|CARIBBEANCOM|1PONDO|10MUSUME|PACOPACOMAMA)(?=$|[^A-Z0-9])/i.exec(`${basename(row.name || row.path)} ${row.code || ""}`);
  return { code: /^\d{6}-\d{2,4}$/.test(code) && supplier ? `${supplier[1].toUpperCase()}-${code}` : code, part, parsed: filename, codeSource };
}

function resolution(row) {
  const width = Number(row.probe?.width), height = Number(row.probe?.height);
  if (Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0) return `${width}×${height}（缓存探测）`;
  const stem = basename(row.name || row.path).normalize("NFKC").replace(MEDIA_EXTENSION, "");
  const traits = deriveWorkTraits({ videos: [{ name: stem }] });
  if (traits.flags.quality4k) return "文件名 4K";
  for (const token of ["8K", "1440P", "1080P", "720P", "480P"]) {
    const pattern = new RegExp(`(?:^|[^A-Z0-9])${token}(?=$|[^A-Z0-9])`, "i");
    const match = pattern.exec(stem);
    if (match && !/[A-Z]{2,12}-$/.test(stem.slice(0, match.index + match[0].length - token.length).toUpperCase())) return `文件名 ${token}`;
  }
  return "未知";
}

function presentedFile(row) {
  const traits = deriveWorkTraits({ videos: [{ name: basename(row.name || row.path) }] });
  const editionLabels = traits.editions.filter(item => item.key !== "quality4k").map(item => `${item.label}（名称/编号）`);
  if (/(?:^|[^A-Z0-9])CENSORED(?=$|[^A-Z0-9])|有[码碼]/i.test(basename(row.name || row.path))) editionLabels.push("有码（文件名）");
  const number = Number(row.probe?.duration);
  return { ...row, size: safeSize(row.size), editionLabels, resolutionLabel: resolution(row), duration: Number.isFinite(number) && number > 0 ? number : null };
}

export function buildDuplicateGroups(input = []) {
  const paths = new Map();
  const source = (Array.isArray(input) ? input : []).filter(row => row && typeof row === "object" && row.id != null && !isVrDuplicateFile(row))
    .slice().sort((a, b) => stableCompare(a.id, b.id) || stableCompare(a.path, b.path));
  for (const row of source) {
    const key = logicalPath(row.path);
    if (key && !paths.has(key)) paths.set(key, { ...row, size: safeSize(row.size) });
  }
  const buckets = new Map();
  for (const row of paths.values()) {
    const release = releaseFor(row);
    if (!release) continue;
    const key = JSON.stringify([release.code, release.part]);
    if (!buckets.has(key)) buckets.set(key, { ...release, key, rows: [] });
    buckets.get(key).rows.push({ ...row, codeSource: release.codeSource });
  }
  const groups = [];
  for (const bucket of buckets.values()) {
    if (bucket.rows.length < 2) continue;
    const files = bucket.rows.map(presentedFile).sort((a, b) => b.size - a.size || (b.duration || 0) - (a.duration || 0)
      || stableCompare(logicalPath(a.path), logicalPath(b.path)) || stableCompare(a.id, b.id));
    const largest = files.reduce((max, file) => Math.max(max, file.size), 0);
    const longest = files.reduce((max, file) => Math.max(max, file.duration || 0), 0);
    for (const file of files) {
      file.isLargest = largest > 0 && file.size === largest;
      file.isLongest = longest > 0 && file.duration === longest;
    }
    groups.push({
      id: crypto.createHash("sha256").update(bucket.key).digest("hex"), code: bucket.code, part: bucket.part,
      partLabel: PART_NAMES[bucket.part] || `第${bucket.part}卷`, title: bucket.rows.find(row => typeof row.title === "string" && row.title.trim())?.title || "",
      totalBytes: sum(files.map(file => file.size)), potentialExtraBytes: sum(files.slice(1).map(file => file.size)), evidence: "same_code_part", files
    });
  }
  groups.sort((a, b) => b.potentialExtraBytes - a.potentialExtraBytes || stableCompare(a.code, b.code) || stableCompare(a.part, b.part));
  return { summary: { indexedFiles: paths.size, candidateGroups: groups.length, candidateFiles: groups.reduce((total, group) => total + group.files.length, 0),
    potentialExtraBytes: sum(groups.map(group => group.potentialExtraBytes)) }, groups };
}
