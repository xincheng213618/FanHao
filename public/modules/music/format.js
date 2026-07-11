// 纯展示 / 格式化辅助函数（无闭包依赖，可独立单测）。
// 这些函数原先位于 music-page.js 尾部，已抽到独立模块以便复用与测试。

const MUSIC_SLEEP_TIMER_OPTIONS = [0, 10, 15, 30, 45, 60, 90];
const MUSIC_PLAYBACK_SPEED_OPTIONS = [0.75, 1, 1.25, 1.5, 2];

export function collapseDuplicateTracks(tracks = []) {
  const groups = new Map();
  const result = [];
  for (const source of Array.isArray(tracks) ? tracks : []) {
    if (!source?.id) continue;
    const key = duplicateTrackKey(source);
    const existing = groups.get(key);
    if (!existing) {
      const entry = { index: result.length, tracks: [source], selected: source };
      groups.set(key, entry);
      result.push(source);
      continue;
    }
    existing.tracks.push(source);
    if (duplicateTrackScore(source) > duplicateTrackScore(existing.selected)) {
      existing.selected = source;
      result[existing.index] = source;
    }
  }
  for (const group of groups.values()) {
    if (group.tracks.length < 2) continue;
    const selected = result[group.index];
    result[group.index] = {
      ...selected,
      duplicateCount: group.tracks.length,
      duplicateIds: group.tracks.map((track) => track.id),
      favorite: group.tracks.some((track) => Boolean(track.favorite)),
      rating: Math.max(...group.tracks.map((track) => Number(track.rating || 0))),
      playCount: Math.max(...group.tracks.map((track) => Number(track.playCount || 0)))
    };
  }
  return result;
}

export function duplicateTrackKey(track = {}) {
  const title = normalizeDuplicateText(track.title);
  const artist = normalizeDuplicateText(track.artist);
  const durationMs = Math.max(0, Number(track.durationMs || 0));
  if (!title || !artist || durationMs < 10_000) return `id:${track.id || ""}`;
  return `${title}|${artist}|${Math.round(durationMs / 2000)}`;
}

export function normalizeDuplicateText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s·•]+/gu, "")
    .trim();
}

export function duplicateTrackScore(track = {}) {
  const ext = String(track.fileName || "").toLocaleLowerCase().match(/\.[a-z0-9]+$/u)?.[0] || "";
  const lossless = [".flac", ".wav", ".aiff", ".ape", ".alac", ".dsf", ".dff"].includes(ext) ? 1 : 0;
  return (track.favorite ? 100_000 : 0)
    + Math.max(0, Number(track.rating || 0)) * 10_000
    + lossless * 1_000
    + (track.hasLyrics ? 200 : 0)
    + Math.max(0, Number(track.bitDepth || 0)) * 4
    + Math.max(0, Number(track.sampleRate || 0)) / 1000
    + Math.log2(Math.max(1, Number(track.sizeBytes || 0)));
}

export function qualityLabel(track = {}) {
  const codec = String(track.codec || "").toUpperCase();
  const sample = Number(track.sampleRate || 0);
  const bit = Number(track.bitDepth || 0);
  const parts = [codec || "AUDIO"];
  if (sample) parts.push(`${Math.round(sample / 1000)}kHz`);
  if (bit) parts.push(`${bit}bit`);
  return parts.join(" · ");
}

export function ratingLabel(rating) {
  const value = Math.max(0, Math.min(5, Number(rating || 0)));
  return value ? `${"★".repeat(value)}${"☆".repeat(5 - value)}` : "";
}

export function sortLabel(sort) {
  return {
    album: "按专辑",
    artist: "按歌手",
    title: "按歌名",
    duration: "按时长",
    played: "最近播放",
    favorite: "收藏优先",
    rating: "按评分"
  }[sort] || "按专辑";
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分钟`;
}

export function formatClock(ms) {
  return formatSeconds(Number(ms || 0) / 1000);
}

export function formatSeconds(value) {
  const total = Math.max(0, Math.floor(Number(value || 0)));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function initials(value) {
  const text = String(value || "音乐").trim();
  return text.slice(0, Math.min(2, text.length)).toUpperCase();
}

export function normalizeRepeat(value) {
  return ["none", "all", "one"].includes(value) ? value : "all";
}

export function nextRepeat(value) {
  if (value === "all") return "one";
  if (value === "one") return "none";
  return "all";
}

export function repeatLabel(value) {
  if (value === "one") return "单曲";
  if (value === "none") return "顺序";
  return "循环";
}

export function repeatIcon(value) {
  if (value === "one") return "1";
  if (value === "none") return "→";
  return "↻";
}

export function playAriaLabel(playing) {
  return playing ? "暂停" : "播放";
}

export function normalizeSleepTimerMinutes(value) {
  const minutes = Math.round(Number(value || 0));
  return MUSIC_SLEEP_TIMER_OPTIONS.includes(minutes) ? minutes : 0;
}

export function isKeyboardShortcutTarget(target) {
  if (!target || typeof target.closest !== "function") return false;
  return Boolean(target.closest("input, textarea, select, button, a, [contenteditable='true']"));
}

export function compactTrack(track = {}) {
  return {
    id: track.id || "",
    title: track.title || "",
    artist: track.artist || "",
    album: track.album || "",
    durationMs: Number(track.durationMs || 0),
    coverUrl: track.coverUrl || "",
    streamUrl: track.streamUrl || "",
    downloadUrl: track.downloadUrl || "",
    favorite: Boolean(track.favorite),
    rating: Number(track.rating || 0),
    positionMs: Number(track.positionMs || 0),
    hasLyrics: Boolean(track.hasLyrics)
  };
}

export function normalizePlaybackSpeed(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  const match = MUSIC_PLAYBACK_SPEED_OPTIONS.find((option) => Math.abs(option - numeric) < 0.001);
  return match || 1;
}

export function playbackSpeedLabel(value) {
  return `${normalizePlaybackSpeed(value)}x`;
}

export function defaultQueuePlaylistName() {
  const date = new Date();
  return `播放队列 ${date.getMonth() + 1}-${date.getDate()}`;
}
