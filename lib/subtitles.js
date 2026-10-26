import { workCodeKey } from "./code-parser.js";

export const SUBTITLE_LIMITS = Object.freeze({ bytes: 4 * 1024 * 1024, cues: 50_000, cueCharacters: 16_384, outputBytes: 8 * 1024 * 1024 });
const MAX_SECONDS = 7 * 24 * 60 * 60;
const EXTENSION = /\.(srt|ass|ssa|vtt)$/i;
const TIME = "(?:\\d{1,3}:)?\\d{1,2}:\\d{2}(?:[.,]\\d{1,3})?";
const TIMING = new RegExp(`^\\s*(${TIME})\\s*-->\\s*(${TIME})(?:\\s+.*)?$`);

function failure(code, message, statusCode = 422) {
  return Object.assign(new Error(message), { code, statusCode });
}

export function isSubtitleFile(name) {
  return typeof name === "string" && EXTENSION.test(name);
}

function decode(input) {
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > SUBTITLE_LIMITS.bytes) throw failure("SUBTITLE_TOO_LARGE", "字幕文件超过 4 MiB", 413);
    return { text: input.replace(/^\uFEFF/, ""), encoding: "utf-8" };
  }
  if (!(input instanceof Uint8Array)) throw failure("SUBTITLE_INVALID_INPUT", "字幕内容类型无效", 400);
  if (input.byteLength > SUBTITLE_LIMITS.bytes) throw failure("SUBTITLE_TOO_LARGE", "字幕文件超过 4 MiB", 413);
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!bytes.length) throw failure("SUBTITLE_EMPTY", "字幕文件为空");
  if (bytes.subarray(0, 4).equals(Buffer.from([0xff, 0xfe, 0, 0])) || bytes.subarray(0, 4).equals(Buffer.from([0, 0, 0xfe, 0xff]))) {
    throw failure("SUBTITLE_ENCODING", "不支持 UTF-32 字幕编码", 415);
  }
  let encoding;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
  else if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) encoding = "utf-8";
  if (encoding) {
    try { return { text: new TextDecoder(encoding, { fatal: true }).decode(bytes), encoding }; }
    catch { throw failure("SUBTITLE_ENCODING", "字幕编码或字节序标记无效"); }
  }
  try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" }; }
  catch { /* Evaluate legacy Chinese and Japanese candidates below. */ }
  const candidates = [];
  for (const candidate of ["gb18030", "shift_jis"]) {
    try {
      const text = new TextDecoder(candidate, { fatal: true }).decode(bytes);
      let score = 0;
      for (const character of text) {
        if (/[\u3040-\u30ff]/u.test(character)) score += 4;
        else if (/[\u4e00-\u9fff]/u.test(character)) score += 1;
        else if (/[\uff61-\uff9f\ue000-\uf8ff\u0080-\u00ff]/u.test(character)) score -= 3;
      }
      score += (text.match(/[的了是不我你这有在好说为们来]/gu) || []).length * 2;
      candidates.push({ text, encoding: candidate, score });
    } catch { /* This decoder cannot represent the complete input. */ }
  }
  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length) throw failure("SUBTITLE_ENCODING", "无法解码字幕，请转换为 UTF-8");
  return candidates[0];
}

function seconds(value) {
  const match = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(value.trim());
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) throw failure("SUBTITLE_TIME", "字幕时间格式无效");
  const time = Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number((match[4] || "").padEnd(3, "0")) / 1000;
  if (time > MAX_SECONDS) throw failure("SUBTITLE_TIME", "字幕时间超出范围");
  return time;
}

function plainText(value) {
  if (value.length > SUBTITLE_LIMITS.cueCharacters * 4) throw failure("SUBTITLE_CUE_TOO_LARGE", "单条字幕源文本过长", 413);
  let text = value.replace(/&#(x[\da-f]+|\d+);/gi, (_whole, number) => {
    const code = number[0].toLowerCase() === "x" ? Number.parseInt(number.slice(1), 16) : Number(number);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
  }).replace(/&(lt|gt|amp|quot|apos|nbsp);/gi, (_whole, entity) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: " " })[entity.toLowerCase()]);
  text = text.replace(/<(script|style|iframe|object|svg)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
    .replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^<>\n]*>/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split("\n").map((line) => line.trimEnd()).join("\n").replace(/\n[\t ]*\n+/g, "\n").trim();
  if (text.length > SUBTITLE_LIMITS.cueCharacters) throw failure("SUBTITLE_CUE_TOO_LARGE", "单条字幕内容过长", 413);
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function assText(value) {
  if (value.length > SUBTITLE_LIMITS.cueCharacters * 4) throw failure("SUBTITLE_CUE_TOO_LARGE", "单条字幕源文本过长", 413);
  let drawing = false, text = "";
  for (const token of value.match(/\{[^{}]*\}|[^{}]+/g) || []) {
    if (token.startsWith("{")) {
      const modes = [...token.matchAll(/\\p(\d+)(?=\\|[\s}]|$)/gi)];
      if (modes.length) drawing = Number(modes.at(-1)[1]) > 0;
    } else if (!drawing) text += token;
  }
  return plainText(text.replace(/\\[Nn]/g, "\n").replace(/\\h/g, " "));
}

function parseTimed(text, add) {
  for (const block of text.split(/\n[\t ]*\n+/)) {
    const lines = block.split("\n");
    if (/^(?:WEBVTT(?:\s|$)|NOTE(?:\s|$)|STYLE(?:\s|$)|REGION(?:\s|$))/.test(lines[0].trim())) continue;
    const starts = lines.flatMap((line, index) => TIMING.test(line) ? [index] : []);
    for (let index = 0; index < starts.length; index += 1) {
      const at = starts[index], match = TIMING.exec(lines[at]);
      const end = starts[index + 1] ?? lines.length;
      const payload = lines.slice(at + 1, end);
      if (starts[index + 1] !== undefined && /^\d+$/.test(payload.at(-1)?.trim() || "")) payload.pop();
      add(seconds(match[1]), seconds(match[2]), plainText(payload.join("\n")));
    }
  }
}

function parseAss(text, add) {
  let fields = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
  let section = "";
  for (const line of text.split("\n")) {
    const heading = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (heading) { section = heading[1].toLowerCase(); continue; }
    if (section && section !== "events") continue;
    const format = /^\s*Format\s*:\s*(.*)$/i.exec(line);
    if (format) { fields = format[1].split(",").map((field) => field.trim().toLowerCase()); continue; }
    const dialogue = /^\s*Dialogue\s*:\s*(.*)$/i.exec(line);
    if (!dialogue) continue;
    const bodyAt = fields.indexOf("text"), startAt = fields.indexOf("start"), endAt = fields.indexOf("end");
    if (bodyAt < 0 || startAt < 0 || endAt < 0 || new Set(fields).size !== fields.length) throw failure("SUBTITLE_FORMAT", "ASS 字幕字段格式无效");
    const cells = dialogue[1].split(",");
    if (cells.length < fields.length) throw failure("SUBTITLE_FORMAT", "ASS 字幕字段数量不足");
    const tail = fields.length - bodyAt - 1;
    const values = [...cells.slice(0, bodyAt), cells.slice(bodyAt, tail ? -tail : undefined).join(","), ...(tail ? cells.slice(-tail) : [])];
    add(seconds(values[startAt]), seconds(values[endAt]), assText(values[bodyAt]));
  }
}

function timestamp(value) {
  const total = Math.round(value * 1000);
  return `${String(Math.floor(total / 3600000)).padStart(2, "0")}:${String(Math.floor(total / 60000) % 60).padStart(2, "0")}:${String(Math.floor(total / 1000) % 60).padStart(2, "0")}.${String(total % 1000).padStart(3, "0")}`;
}

export function convertSubtitle(input, { name = "", offsetSeconds = 0 } = {}) {
  const offset = Number(offsetSeconds);
  if (!Number.isFinite(offset) || Math.abs(offset) > 86400) throw failure("SUBTITLE_OFFSET", "字幕偏移必须在正负 24 小时内", 400);
  const { text: decoded, encoding } = decode(input);
  if (decoded.includes("\u0000")) throw failure("SUBTITLE_ENCODING", "字幕包含无法识别的二进制内容");
  const text = decoded.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const extension = EXTENSION.exec(name)?.[1].toLowerCase();
  const format = /^\s*WEBVTT(?:\s|$)/.test(text) ? "vtt"
    : /^\s*\[(?:Script Info|Events|V4\+? Styles)\]/mi.test(text) || /^\s*Dialogue\s*:/mi.test(text)
      ? extension === "ssa" || /^\s*\[V4 Styles\]/mi.test(text) ? "ssa" : "ass" : "srt";
  const cues = [];
  let inputCues = 0, readableCues = 0;
  function add(start, end, body) {
    inputCues += 1;
    if (inputCues > SUBTITLE_LIMITS.cues) throw failure("SUBTITLE_TOO_MANY_CUES", "字幕条目过多", 413);
    if (end <= start) return;
    if (end + offset > MAX_SECONDS) throw failure("SUBTITLE_TIME", "偏移后的字幕时间超出范围");
    if (!body) return;
    readableCues += 1;
    if (end + offset <= 0) return;
    const shiftedStart = Math.max(0, Math.round((start + offset) * 1000) / 1000);
    const shiftedEnd = Math.round((end + offset) * 1000) / 1000;
    if (shiftedEnd > shiftedStart) cues.push({ start: shiftedStart, end: shiftedEnd, body });
  }
  if (format === "ass" || format === "ssa") parseAss(text, add);
  else parseTimed(text, add);
  if (!readableCues) throw failure("SUBTITLE_NO_CUES", "字幕没有可用的时间条目");
  cues.sort((a, b) => a.start - b.start);
  const vtt = "WEBVTT\n\n" + cues.map((cue, index) => `${index + 1}\n${timestamp(cue.start)} --> ${timestamp(cue.end)}\n${cue.body}\n`).join("\n");
  if (Buffer.byteLength(vtt, "utf8") > SUBTITLE_LIMITS.outputBytes) throw failure("SUBTITLE_OUTPUT_TOO_LARGE", "转换后的字幕过大", 413);
  return { vtt, cueCount: cues.length, format, encoding };
}

function basename(file) {
  return String(file?.name || file?.path || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop().normalize("NFKC");
}
function stem(file) { return basename(file).replace(/\.[^.]+$/, "").trim(); }
const LANGUAGES = [
  ["zh-CN", "简体中文", "zh[-_. ]?(?:cn|hans)|chs|sc|简[体體中]|簡[体體中]|中文|中字|chinese|zh"],
  ["zh-TW", "繁体中文", "zh[-_. ]?(?:tw|hant)|cht|tc|繁[体體中]"],
  ["en", "英语", "en|eng|english"], ["ja", "日语", "ja|jp|jpn|japanese|日[语語文]|日本語"]
];
function languageName(value) {
  let base = value.replace(/[-_.\s[(【]*(?:forced|default|sdh|cc)[\])】]*$/i, "").trim();
  for (const [language, label, pattern] of LANGUAGES) {
    const match = new RegExp(`(?:^|[-_.\\s[(【])(?:${pattern})[\\])】]*$`, "i").exec(base);
    if (match) return { base: base.slice(0, match.index).replace(/[-_.\s[(【]+$/, ""), language, label };
  }
  return { base, language: "und", label: "未知语言" };
}
function identity(file) {
  const full = stem(file), { base, language, label } = languageName(full);
  let body = base;
  let part = /(?:^|[-_.\s[(])(?:cd|disc|disk|part|pt|p)[-_. ]*(\d{1,2})(?=$|[-_.\s)\]])|第([一二三四五六七八九十\d]+)[卷部集](?=$|[-_.\s)\]])|[卷部]([一二三四五六七八九十\d]+)(?=$|[-_.\s)\]])/i.exec(body);
  if (!part) {
    const bare = /[-_. ]([1-9]\d?)$/.exec(body);
    if (bare && workCodeKey(body.slice(0, bare.index))) part = bare;
  }
  if (part) body = `${body.slice(0, part.index)} ${body.slice(part.index + part[0].length)}`.trim();
  const number = part ? part[1] || part[2] || part[3] : "";
  const chineseNumbers = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const codeText = body.replace(/([A-Z]{2,12}[-_. ]?\d{2,8})(?:UC|UN|U|CH|C|SUB)(?=$|[^A-Z0-9])/gi, "$1");
  return { full: full.toLowerCase(), base: base.toLowerCase(), code: workCodeKey(codeText), part: number ? String(chineseNumbers[number] || Number(number) || number) : "", language, label };
}

export function matchSubtitleCandidates(video, videos = [], subtitles = []) {
  const target = identity(video);
  const siblings = (Array.isArray(videos) ? videos : []).map(identity);
  const result = (Array.isArray(subtitles) ? subtitles : []).filter((file) => isSubtitleFile(basename(file))).map((file) => {
    const item = identity(file);
    let match = "manual";
    const samePart = item.part === target.part;
    if (target.full && samePart && item.full === target.full) match = "exact";
    else if (target.full && samePart && item.base === target.full) match = "language";
    else if (samePart && item.code && item.code === target.code) {
      const alternatives = siblings.filter((sibling) => sibling.code === target.code && sibling.part === target.part);
      if (alternatives.length <= 1) match = "code";
    }
    const labels = { exact: "同文件名", language: "匹配文件名", code: "同番号", manual: "手动选择" };
    return { file, match, language: item.language, label: `${item.label} · ${labels[match]}`, autoSelect: false };
  });
  const order = { exact: 0, language: 1, code: 2, manual: 3 };
  result.sort((a, b) => order[a.match] - order[b.match] || basename(a.file).localeCompare(basename(b.file), "zh-CN"));
  const chinese = result.filter((item) => item.match !== "manual" && item.language.startsWith("zh-"));
  if (chinese.length === 1) chinese[0].autoSelect = true;
  return result;
}
