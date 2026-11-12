import { extractWorkCodes, workCodeKey } from "../../../../../lib/code-parser.js";
import { looksChineseSubtitle, normalizeSubtitleBatchPart, subtitleEditionConflict } from "../../../../../lib/subtitle-batch-policy.js";
import { convertSubtitle, matchSubtitleCandidates } from "../../../../../lib/subtitles.js";
import { intakeError } from "./intake-files.js";

export const MAX_INTAKE_SUBTITLE_BYTES = 2 * 1024 * 1024;
const splitEditionSuffix = (name) => name.replace(/(\d)(?=(?:restored|ltx)\b)/ig, "$1 ");

export function isChineseSubtitleLanguage(language) {
  return language === "zh-CN" || language === "zh-TW";
}

export function importedIntakeSubtitle({ name, contentBase64 }) {
  if (typeof name !== "string" || name.length > 260 || /[\\/\x00-\x1f]/.test(name) || !/\.srt$/i.test(name)) {
    throw intakeError("请选择 SRT 字幕文件", 400);
  }
  if (typeof contentBase64 !== "string" || contentBase64.length > Math.ceil(MAX_INTAKE_SUBTITLE_BYTES / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64)) {
    throw intakeError("字幕文件编码无效或超过 2 MiB", 400);
  }
  const language = /(?:^|[-_. ])(?:zh[-_. ]?(?:tw|hant)|cht|繁[體体中])(?=[-_. ()]|$)/i.test(name) ? "zh-TW" : "zh-CN";
  return { name, language, bytes: Buffer.from(contentBase64, "base64") };
}

export function validateIntakeSubtitle({ name, bytes, language }, { code, videoName, duration }) {
  if (typeof name !== "string" || !/\.srt$/i.test(name) || !isChineseSubtitleLanguage(language)
    || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_INTAKE_SUBTITLE_BYTES) {
    throw intakeError("请选择可下载且不超过 2 MiB 的中文字幕 SRT", 400);
  }
  const subtitleName = splitEditionSuffix(name);
  const names = [...new Set(extractWorkCodes(subtitleName).map(workCodeKey).filter(Boolean))];
  const videoWithCode = splitEditionSuffix(videoName);
  const subtitle = normalizeSubtitleBatchPart({ name: subtitleName });
  const video = normalizeSubtitleBatchPart({ name: extractWorkCodes(videoWithCode).length ? videoWithCode : `${code} ${videoWithCode}` });
  if (names.length && (names.length !== 1 || names[0] !== workCodeKey(code)
    || matchSubtitleCandidates(video, [video], [subtitle])[0]?.match === "manual")
    || subtitleEditionConflict(videoName, name)) {
    throw intakeError("字幕文件名中的番号、分段或版本与所选视频不一致", 422);
  }
  const converted = convertSubtitle(bytes, { name });
  if (converted.format !== "srt" || !looksChineseSubtitle(converted.vtt)) {
    throw intakeError("字幕内容未识别出有效的中文字幕 SRT", 422);
  }
  if (!(duration > 0) || !Number.isFinite(duration)) throw intakeError("无法读取源视频时长，请先核对视频", 422);
  const tolerance = Math.max(5, duration * 0.02);
  for (const [, hours, minutes, seconds] of converted.vtt.matchAll(/^\d+:\d{2}:\d{2}\.\d{3} --> (\d+):(\d{2}):(\d{2}\.\d{3})$/gm)) {
    if (Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) > duration + tolerance) {
      throw intakeError("字幕时间轴超过所选视频时长，请检查是否为同一剪辑版本", 422);
    }
  }
}
