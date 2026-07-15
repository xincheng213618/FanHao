export function statusLabel(status) {
  return {
    pending: "待下载",
    downloading: "下载中",
    downloaded: "已完成",
    failed: "失败",
  }[status] || status;
}

export function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function dateInputDaysAgo(value) {
  const days = Math.max(0, Math.floor(Number(value) || 0));
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days);
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function profileWorkDate(profile) {
  const timestamp = Number(profile?.latest_work_create_time || 0);
  return timestamp > 0 ? formatDateTime(timestamp * 1000) : "";
}

export function formatCountdown(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  const parts = hours > 0 ? [hours, minutes, remainder] : [minutes, remainder];
  return parts.map((part) => String(part).padStart(2, "0")).join(":");
}

export function displayDouyinId(profile) {
  const uniqueId = String(profile?.unique_id || "").trim();
  const shortId = String(profile?.short_id || "").trim();
  if (uniqueId && uniqueId !== "0") return uniqueId;
  if (shortId && shortId !== "0") return shortId;
  return "";
}

export function formatCompact(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "";
  if (number >= 100000000) return `${(number / 100000000).toFixed(number >= 1000000000 ? 0 : 1)}亿`;
  if (number >= 10000) return `${(number / 10000).toFixed(number >= 100000 ? 0 : 1)}万`;
  return String(Math.round(number));
}
