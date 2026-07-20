import { formatDate, formatNumber } from "../../../../js/format.js";

export function displayWorkTitle(work, compactMeta = false) {
  const rawTitle = work?.title || work?.directoryName || "未命名作品";
  if (!compactMeta) return rawTitle;
  let cleaned = String(rawTitle).trim();
  for (let index = 0; index < 4; index += 1) {
    const previous = cleaned;
    cleaned = cleaned
      .replace(/^\[[^\]]+\][\s._-]*/u, "")
      .replace(/^【[^】]+】[\s._-]*/u, "")
      .replace(/^[A-Z]{1,10}[\s._-]*\d{2,6}[A-Z]?[\s._-]*/iu, "")
      .replace(/^[\s._\-:：・]+/u, "")
      .trim();
    if (cleaned === previous) break;
  }
  cleaned = cleaned.replace(/\s*生写真\d+枚セット\s*$/u, "").trim();
  return cleaned || rawTitle;
}

export function compactWorkCardTitle(work) {
  const title = displayWorkTitle(work, true);
  const code = compactWorkCode(work);
  if (!code || title.toUpperCase().startsWith(code.toUpperCase())) return title;
  return `${code} · ${title}`;
}

export function compactWorkCode(work) {
  const explicit = [work?.infoSummary?.code, work?.code].map((value) => String(value || "").trim()).find(Boolean);
  if (explicit) return extractLeadingWorkCode(explicit) || explicit.toUpperCase();
  const source = [work?.directoryName, work?.title].map((value) => String(value || "").trim()).find(Boolean) || "";
  const withoutTags = source.replace(/^(?:(?:\[[^\]]+\]|【[^】]+】)[\s._-]*)*/u, "");
  return extractLeadingWorkCode(withoutTags);
}

export function workGridMeta(work) {
  const date = displayCardDate(work?.infoSummary?.releaseDate) || displayCardDate(work?.modifiedAt);
  const rating = numericRating(work?.infoSummary?.rating);
  const parts = [];
  if (date) parts.push(date);
  if (rating !== null) parts.push(`★ ${formatCompactRating(rating)}`);
  else if (Number(work?.videoCount || 0) > 0) parts.push(`${formatNumber(work.videoCount)} 个视频`);
  return parts.join(" · ");
}

export function workGridBadge(work) {
  if (work?.missingLocal) return { text: "未下载", variant: "missing" };
  const percent = progressPercent(work);
  if (percent) return { text: `在看 ${displayPercent(percent)}%`, variant: "progress" };
  if (work?.favorite) return { text: "已收藏", variant: "favorite" };
  if (Number(work?.playableCount || 0) > 0) return { text: "可播", variant: "playable" };
  if (Number(work?.infoCount || 0) > 0) return { text: "有资料", variant: "info" };
  return { text: "", variant: "" };
}

export function workGridRankBadge(work) {
  const rank = Number(work?.ranking?.rankNo || 0);
  if (!Number.isFinite(rank) || rank <= 0) return { text: "", variant: "" };
  return { text: `TOP ${formatNumber(rank)}`, variant: "rank" };
}

export function progressPercent(work) {
  const percent = Number(work?.progress?.percent || 0);
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  return Math.max(0, Math.min(100, percent));
}

export function numericRating(value) {
  if (value === null || value === undefined || value === "") return null;
  const rating = Number(value);
  return Number.isFinite(rating) ? rating : null;
}

export function displayCardDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : formatDate(raw);
}

export function formatCompactRating(value) {
  const rating = Number(value);
  if (!Number.isFinite(rating)) return "";
  return Number.isInteger(rating) ? rating.toFixed(1) : rating.toFixed(2).replace(/0$/u, "");
}

export function displayPercent(percent) {
  if (percent <= 0) return 0;
  return Math.max(1, Math.min(100, Math.floor(percent)));
}

function extractLeadingWorkCode(value) {
  const match = /^([A-Z]{1,10})[\s._-]*(\d{2,6}[A-Z]?)(?=$|[^A-Z0-9])/iu.exec(String(value || "").trim());
  return match ? `${match[1].toUpperCase()}-${match[2].toUpperCase()}` : "";
}
