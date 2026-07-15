export function ensureShortVideoState(state, options = {}) {
  if (!state.shortVideo) state.shortVideo = {};
  state.shortVideo.query = state.shortVideo.query || "";
  state.shortVideo.topic = normalizeShortVideoTopic(state.shortVideo.topic);
  state.shortVideo.sound = normalizeShortVideoSound(state.shortVideo.sound);
  state.shortVideo.soundInfo = state.shortVideo.soundInfo && typeof state.shortVideo.soundInfo === "object" ? state.shortVideo.soundInfo : null;
  state.shortVideo.author = state.shortVideo.author || "all";
  state.shortVideo.authorPage = state.shortVideo.authorPage || "";
  state.shortVideo.authorIndexSource = ["authors", "following"].includes(state.shortVideo.authorIndexSource)
    ? state.shortVideo.authorIndexSource
    : "authors";
  state.shortVideo.media = normalizeShortVideoMedia(state.shortVideo.media);
  state.shortVideo.quality = normalizeShortVideoQuality(state.shortVideo.quality);
  if (state.shortVideo.quality !== "all") state.shortVideo.media = "video";
  state.shortVideo.source = normalizeShortVideoSource(state.shortVideo.source);
  state.shortVideo.sort = normalizeShortVideoSortValue(state.shortVideo.sort);
  state.shortVideo.data = state.shortVideo.data || null;
  state.shortVideo.summary = state.shortVideo.summary || null;
  state.shortVideo.authors = Array.isArray(state.shortVideo.authors) ? state.shortVideo.authors : [];
  state.shortVideo.authorTotal = Math.max(0, Number(state.shortVideo.authorTotal || 0));
  state.shortVideo.authorScopeTotal = Math.max(0, Number(state.shortVideo.authorScopeTotal || 0));
  state.shortVideo.authorUnlikedTotal = Math.max(0, Number(state.shortVideo.authorUnlikedTotal || 0));
  state.shortVideo.authorSort = normalizeShortVideoAuthorSort(state.shortVideo.authorSort);
  state.shortVideo.authorFilter = normalizeShortVideoAuthorFilter(state.shortVideo.authorFilter);
  state.shortVideo.authorHasMore = Boolean(state.shortVideo.authorHasMore);
  state.shortVideo.authorLoadingMore = Boolean(state.shortVideo.authorLoadingMore);
  state.shortVideo.authorDetail = state.shortVideo.authorDetail && typeof state.shortVideo.authorDetail === "object" ? state.shortVideo.authorDetail : null;
  state.shortVideo.authorVideo = state.shortVideo.authorVideo && typeof state.shortVideo.authorVideo === "object" ? state.shortVideo.authorVideo : null;
  state.shortVideo.summaryLoading = Boolean(state.shortVideo.summaryLoading);
  state.shortVideo.mode = state.shortVideo.mode === "likes" ? "likes" : "feed";
  state.shortVideo.likeDistributionLoading = Boolean(state.shortVideo.likeDistributionLoading);
  state.shortVideo.likeDistribution = state.shortVideo.likeDistribution && typeof state.shortVideo.likeDistribution === "object" ? state.shortVideo.likeDistribution : null;
  state.shortVideo.likeDistributionError = String(state.shortVideo.likeDistributionError || "");
  state.shortVideo.current = state.shortVideo.current || null;
  state.shortVideo.prevVideo = state.shortVideo.prevVideo || null;
  state.shortVideo.nextVideo = state.shortVideo.nextVideo || null;
  state.shortVideo.dragging = Boolean(state.shortVideo.dragging);
  if (typeof state.shortVideo.muted !== "boolean") state.shortVideo.muted = readMutedPreference();
  state.shortVideo.volume = normalizeShortVideoVolume(state.shortVideo.volume ?? readVolumePreference());
  if (typeof state.shortVideo.autoNext !== "boolean") state.shortVideo.autoNext = readAutoNextPreference();
  if (typeof state.shortVideo.smartFill !== "boolean") state.shortVideo.smartFill = readSmartFillPreference(options.smartFillKey);
  state.shortVideo.playbackRate = normalizePlaybackRate(state.shortVideo.playbackRate ?? readPlaybackRatePreference());
  state.shortVideo.prevId = state.shortVideo.prevId || "";
  state.shortVideo.nextId = state.shortVideo.nextId || "";
  state.shortVideo.slideDirection = Number(state.shortVideo.slideDirection || 0);
  state.shortVideo.loading = Boolean(state.shortVideo.loading);
  state.shortVideo.loadingMore = Boolean(state.shortVideo.loadingMore);
  state.shortVideo.status = state.shortVideo.status || "";
  state.shortVideo.deleteMode = Boolean(state.shortVideo.deleteMode);
  if (!(state.shortVideo.deleteSelection instanceof Set)) {
    state.shortVideo.deleteSelection = new Set(Array.isArray(state.shortVideo.deleteSelection) ? state.shortVideo.deleteSelection : []);
  }
  options.installBrowseEvents?.();
  return state.shortVideo;
}
export function formatShortVideoMetric(video, key, unknownLabel = "—") {
  if (video?.stats?.known === false) return unknownLabel;
  return formatCompact(video?.stats?.[key] || 0);
}

export function applyShortVideoStatsBadgeState(element, video) {
  const unknown = video?.stats?.known === false;
  element?.classList?.toggle("is-unknown", unknown);
  if (unknown) {
    element.setAttribute("aria-label", "点赞统计待补");
    element.title = "统计待补";
  }
}

export function applyShortVideoLikeBadgeState(element, video) {
  applyShortVideoStatsBadgeState(element, video);
  const liked = Boolean(video?.actions?.liked);
  element?.classList?.toggle("is-liked", liked);
  if (!element || !liked) return;
  const likes = formatShortVideoMetric(video, "likes", "点赞数待补");
  element.setAttribute("aria-label", `已点赞，${likes}赞`);
  element.title = "已点赞";
}

export function formatCompact(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "0";
  if (number >= 10000) return `${(number / 10000).toFixed(number >= 100000 ? 0 : 1)}万`;
  return String(Math.round(number));
}

export function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

export function readMutedPreference() {
  try {
    return window.localStorage.getItem("fanhao.shortVideo.muted") === "1";
  } catch {
    return false;
  }
}

export function writeMutedPreference(muted) {
  try {
    window.localStorage.setItem("fanhao.shortVideo.muted", muted ? "1" : "0");
  } catch {}
}

export function readVolumePreference() {
  try {
    return normalizeShortVideoVolume(window.localStorage.getItem("fanhao.shortVideo.volume"));
  } catch {
    return 1;
  }
}

export function writeVolumePreference(value) {
  try {
    window.localStorage.setItem("fanhao.shortVideo.volume", String(normalizeShortVideoVolume(value)));
  } catch {}
}

export function normalizeShortVideoVolume(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 1;
  return Math.max(.01, Math.min(1, Math.round(number * 100) / 100));
}

export function readAutoNextPreference() {
  try {
    return window.localStorage.getItem("fanhao.shortVideo.autoNext") === "1";
  } catch {
    return false;
  }
}

export function writeAutoNextPreference(enabled) {
  try {
    window.localStorage.setItem("fanhao.shortVideo.autoNext", enabled ? "1" : "0");
  } catch {}
}

export function readPlaybackRatePreference() {
  try {
    return normalizePlaybackRate(window.localStorage.getItem("fanhao.shortVideo.playbackRate"));
  } catch {
    return 1;
  }
}

export function writePlaybackRatePreference(value) {
  try {
    window.localStorage.setItem("fanhao.shortVideo.playbackRate", String(normalizePlaybackRate(value)));
  } catch {}
}

export function readSmartFillPreference(key) {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function writeSmartFillPreference(key, enabled) {
  try {
    window.localStorage.setItem(key, enabled ? "1" : "0");
  } catch {}
}

export function normalizePlaybackRate(value) {
  const number = Number(value);
  const allowed = [0.5, 0.75, 1, 1.25, 1.5, 2];
  return allowed.includes(number) ? number : 1;
}

export function formatPlaybackRate(value) {
  const rate = normalizePlaybackRate(value);
  return `${Number.isInteger(rate) ? rate : String(rate).replace(/0+$/, "")}x`;
}

export function normalizeShortVideoSource(value) {
  const source = String(value || "liked").trim().toLowerCase();
  return ["recommended", "liked", "following", "history", "posts", "authors", "all", "local"].includes(source) ? source : "liked";
}

export function normalizeShortVideoSortValue(value) {
  const sort = String(value || "published").trim();
  return ["recommended", "watched", "published", "publishedAsc", "likes", "likesAsc", "comments", "duration"].includes(sort) ? sort : "published";
}

export function normalizeShortVideoAuthorSort(value) {
  const sort = String(value || "followed").trim().toLowerCase();
  return ["followed", "count", "liked"].includes(sort) ? sort : "followed";
}

export function normalizeShortVideoAuthorFilter(value) {
  return String(value || "all").trim().toLowerCase() === "unliked" ? "unliked" : "all";
}

export function normalizeShortVideoMedia(value) {
  const media = String(value || "all").trim().toLowerCase();
  return ["video", "gallery"].includes(media) ? media : "all";
}

export function normalizeShortVideoQuality(value) {
  const quality = String(value || "all").trim().toLowerCase();
  return ["4k", "1440p", "1080p", "720p", "below720p", "unknown"].includes(quality) ? quality : "all";
}

export function shortVideoQualityLabel(value) {
  return ({
    "4k": " 4K ",
    "1440p": " 2K / 1440P ",
    "1080p": " 1080P ",
    "720p": " 720P ",
    "below720p": "低于 720P 的",
    "unknown": "尚未检测清晰度的"
  })[normalizeShortVideoQuality(value)] || "";
}

export function normalizeShortVideoTopic(value) {
  return String(value || "").trim().replace(/^#+/, "").slice(0, 48);
}

export function normalizeShortVideoSound(value) {
  const sound = String(value || "").trim();
  return /^[A-Za-z0-9_-]{1,1000}$/.test(sound) ? sound : "";
}

export function formatDuration(ms) {
  const seconds = Math.round(Number(ms || 0) / 1000);
  if (!seconds) return "";
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  return minutes ? `${minutes}:${String(remain).padStart(2, "0")}` : `0:${String(remain).padStart(2, "0")}`;
}

export function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function formatLocalCommentDate(value) {
  if (!value) return "刚刚";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  const now = new Date();
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`;
  const day = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return date.getFullYear() === now.getFullYear() ? `${day} ${time}` : `${date.getFullYear()}-${day} ${time}`;
}

export function formatSeconds(value) {
  const total = Math.max(0, Math.floor(Number(value || 0)));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function initials(value) {
  return String(value || "?").trim().slice(0, 2).toUpperCase();
}
