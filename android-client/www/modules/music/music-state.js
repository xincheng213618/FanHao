import { getTrackVersionInfo } from "./track-versions.js?v=20260713-music-search-versions-01";

export const DEFAULT_MODE = "library";
export const DEFAULT_SORT = "album";
export const SLEEP_AFTER_CURRENT = -1;
export const SLEEP_TIMER_OPTIONS = [SLEEP_AFTER_CURRENT, 10, 15, 30, 45, 60, 90];
export const PLAYBACK_SPEED_OPTIONS = [0.75, 1, 1.25, 1.5, 2];
export const FADE_SECONDS_OPTIONS = [0, 1, 3, 5];
export const CROSSFADE_SECONDS_OPTIONS = [0, 3, 5, 8];
export const VERSION_STRATEGY_OPTIONS = [
  ["smart", "智能选择"],
  ["original", "原版优先"],
  ["quality", "无损优先"],
  ["compact", "小文件优先"]
];

const MUSIC_VOLUME_KEY = "fanhao.android.music.volume";
const MUSIC_REPEAT_KEY = "fanhao.android.music.repeat";
const MUSIC_SHUFFLE_KEY = "fanhao.android.music.shuffle";
const MUSIC_LAST_TRACK_KEY = "fanhao.android.music.lastTrack";
const MUSIC_PLAYBACK_SPEED_KEY = "fanhao.android.music.playbackSpeed";
const MUSIC_SEARCH_HISTORY_KEY = "fanhao.android.music.searchHistory";
const MUSIC_FADE_SECONDS_KEY = "fanhao.android.music.fadeSeconds";
const MUSIC_GAPLESS_KEY = "fanhao.android.music.gapless";
const MUSIC_CROSSFADE_SECONDS_KEY = "fanhao.android.music.crossfadeSeconds";
const MUSIC_RESUME_QUEUE_KEY = "fanhao.android.music.resumeQueue";
const MUSIC_PLAYBACK_QUEUE_KEY = "fanhao.android.music.playbackQueue";
const MUSIC_REMEMBER_VERSION_KEY = "fanhao.android.music.rememberVersionChoices";
const MUSIC_VERSION_PREFERENCES_KEY = "fanhao.android.music.versionPreferences";
const MUSIC_VERSION_STRATEGY_KEY = "fanhao.android.music.versionStrategy";
const SEARCH_HISTORY_LIMIT = 8;
const VERSION_PREFERENCE_LIMIT = 160;

export function emptySearchOverview() {
  return {
    loading: false,
    artists: [],
    albums: [],
    artistTotal: 0,
    albumTotal: 0,
    error: ""
  };
}
export function emptySearchRecovery() {
  return {
    loading: false,
    query: "",
    correctedTarget: "",
    tracks: [],
    artists: [],
    albums: [],
    playlists: [],
    error: ""
  };
}

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

export function selectTrackByVersionStrategy(tracks = [], strategy = "smart", fallback = null) {
  const candidates = (Array.isArray(tracks) ? tracks : []).filter((track) => track?.id);
  const defaultTrack = fallback?.id && candidates.some((track) => track.id === fallback.id)
    ? fallback
    : candidates[0] || fallback;
  const normalized = normalizeVersionStrategy(strategy);
  if (candidates.length < 2 || normalized === "smart") return defaultTrack;
  if (normalized === "original") {
    const originals = candidates.filter((track) => getTrackVersionInfo(track).kind === "original");
    return originals.length ? bestAudioQualityTrack(originals, defaultTrack) : defaultTrack;
  }
  if (normalized === "quality") return bestAudioQualityTrack(candidates, defaultTrack);
  const compact = candidates.filter((track) => Number(track.sizeBytes || 0) > 0);
  return compact.reduce((best, track) => Number(track.sizeBytes) < Number(best.sizeBytes) ? track : best, compact[0]) || defaultTrack;
}

export function shuffleTrackQueue(tracks = [], random = Math.random) {
  const queue = (Array.isArray(tracks) ? tracks : []).filter((track) => track?.id).map((track) => ({ ...track }));
  for (let index = queue.length - 1; index > 0; index -= 1) {
    const sample = Number(random());
    const bounded = Number.isFinite(sample) ? Math.min(0.999999, Math.max(0, sample)) : 0;
    const target = Math.floor(bounded * (index + 1));
    [queue[index], queue[target]] = [queue[target], queue[index]];
  }
  return queue;
}

export function bestAudioQualityTrack(tracks = [], fallback = null) {
  return (Array.isArray(tracks) ? tracks : []).reduce((best, track) => {
    if (!best) return track;
    return compareAudioQuality(track, best) > 0 ? track : best;
  }, null) || fallback;
}

export function compareAudioQuality(left = {}, right = {}) {
  const leftRank = audioQualityRank(left);
  const rightRank = audioQualityRank(right);
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] !== rightRank[index]) return leftRank[index] - rightRank[index];
  }
  return 0;
}

export function audioQualityRank(track = {}) {
  const codec = `${track.codec || ""} ${track.fileName || ""}`.toLocaleLowerCase();
  const lossless = /(?:\bflac\b|\bwave?\b|\baiff?\b|\bape\b|\balac\b|\bds[fd]\b|\.(?:flac|wav|aiff?|ape|alac|dsf|dff)(?:$|\?))/u.test(codec) ? 1 : 0;
  return [
    lossless,
    Math.max(0, Number(track.bitDepth || 0)),
    Math.max(0, Number(track.sampleRate || 0)),
    Math.max(0, Number(track.sizeBytes || 0))
  ];
}

export function normalizeVersionStrategy(value) {
  const strategy = String(value || "smart").trim().toLocaleLowerCase();
  return VERSION_STRATEGY_OPTIONS.some(([candidate]) => candidate === strategy) ? strategy : "smart";
}

export function versionStrategyLabel(value) {
  const strategy = normalizeVersionStrategy(value);
  return VERSION_STRATEGY_OPTIONS.find(([candidate]) => candidate === strategy)?.[1] || "智能选择";
}

export function versionStrategyDescription(value) {
  const strategy = normalizeVersionStrategy(value);
  if (strategy === "original") return "同名歌曲优先原版；原版有多个来源时选择音质更高的文件。单曲记忆仍优先。";
  if (strategy === "quality") return "同名歌曲优先无损、位深和采样率更高的版本。单曲记忆仍优先。";
  if (strategy === "compact") return "同名歌曲优先体积更小的文件，适合节省流量和空间。单曲记忆仍优先。";
  return "沿用搜索排序推荐的版本；手动记住的单曲选择会覆盖全局策略。";
}

export function normalizeMode(value) {
  const mode = String(value || DEFAULT_MODE).trim();
  return ["library", "artists", "albums", "history", "smart", "playlist"].includes(mode) ? mode : DEFAULT_MODE;
}

export function normalizeSearchScope(value, mode = DEFAULT_MODE) {
  const fallback = mode === "artists" ? "artists" : mode === "albums" ? "albums" : "all";
  const scope = String(value || fallback).trim().toLocaleLowerCase();
  return ["all", "songs", "lyrics", "artists", "albums", "playlists"].includes(scope) ? scope : fallback;
}

export function emptyLyricSearch() {
  return { loading: false, loadingMore: false, matches: [], total: 0, limit: 0, hasMore: false, error: "" };
}

export function normalizeAlbumSort(value) {
  const sort = String(value || "updated").trim();
  return ["updated", "title", "year", "tracks"].includes(sort) ? sort : "updated";
}

export function normalizeSort(value) {
  const sort = String(value || DEFAULT_SORT).trim();
  return ["album", "artist", "title", "duration", "played", "favorite", "rating"].includes(sort) ? sort : DEFAULT_SORT;
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

export function shortDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function defaultPlaylistName() {
  const date = new Date();
  return `我的歌单 ${date.getMonth() + 1}-${date.getDate()}`;
}

export function defaultQueuePlaylistName() {
  const date = new Date();
  return `播放队列 ${date.getMonth() + 1}-${date.getDate()}`;
}

export function initials(value) {
  return String(value || "音乐").trim().slice(0, 2).toUpperCase();
}

export function playIcon(playing) {
  return playing ? "❚❚" : "▶";
}

export function playLabel(playing) {
  return playing ? "暂停" : "播放";
}

export function repeatIcon(value) {
  if (value === "one") return "1";
  if (value === "none") return "→";
  return "↻";
}

export function repeatLabel(value) {
  if (value === "one") return "单曲循环";
  if (value === "none") return "顺序播放";
  return "列表循环";
}

export function nextRepeat(value) {
  if (value === "all") return "one";
  if (value === "one") return "none";
  return "all";
}

export function normalizeSleepTimerMinutes(value) {
  const minutes = Math.round(Number(value || 0));
  return SLEEP_TIMER_OPTIONS.includes(minutes) ? minutes : 0;
}

export function sleepOptionLabel(minutes) {
  const value = Number(minutes || 0);
  if (value === SLEEP_AFTER_CURRENT) return "播完当前歌曲";
  if (value >= 60) {
    const hours = Math.floor(value / 60);
    const rest = value % 60;
    return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
  }
  return `${value} 分钟`;
}

export function readVolumePreference() {
  try {
    const value = Number(window.localStorage?.getItem(MUSIC_VOLUME_KEY) || 0.86);
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.86;
  } catch {
    return 0.86;
  }
}

export function writeVolumePreference(value) {
  try {
    window.localStorage?.setItem(MUSIC_VOLUME_KEY, String(Math.max(0, Math.min(1, Number(value || 0)))));
  } catch {}
}

export function readSearchHistoryPreference() {
  try {
    const parsed = JSON.parse(window.localStorage?.getItem(MUSIC_SEARCH_HISTORY_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item || "").trim()).filter(Boolean).slice(0, SEARCH_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

export function writeSearchHistoryPreference(items) {
  try {
    window.localStorage?.setItem(MUSIC_SEARCH_HISTORY_KEY, JSON.stringify((Array.isArray(items) ? items : []).slice(0, SEARCH_HISTORY_LIMIT)));
  } catch {}
}

export function readFadeSecondsPreference() {
  try {
    return normalizeFadeSeconds(window.localStorage?.getItem(MUSIC_FADE_SECONDS_KEY));
  } catch {
    return 0;
  }
}

export function writeFadeSecondsPreference(value) {
  try {
    window.localStorage?.setItem(MUSIC_FADE_SECONDS_KEY, String(normalizeFadeSeconds(value)));
  } catch {}
}

export function normalizeFadeSeconds(value) {
  const numeric = Number(value || 0);
  return FADE_SECONDS_OPTIONS.includes(numeric) ? numeric : 0;
}

export function readGaplessPreference() {
  try {
    return window.localStorage?.getItem(MUSIC_GAPLESS_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeGaplessPreference(enabled) {
  try {
    window.localStorage?.setItem(MUSIC_GAPLESS_KEY, enabled ? "1" : "0");
  } catch {}
}

export function readCrossfadeSecondsPreference() {
  try {
    return normalizeCrossfadeSeconds(window.localStorage?.getItem(MUSIC_CROSSFADE_SECONDS_KEY));
  } catch {
    return 0;
  }
}

export function writeCrossfadeSecondsPreference(value) {
  try {
    window.localStorage?.setItem(MUSIC_CROSSFADE_SECONDS_KEY, String(normalizeCrossfadeSeconds(value)));
  } catch {}
}

export function normalizeCrossfadeSeconds(value) {
  const numeric = Number(value || 0);
  return CROSSFADE_SECONDS_OPTIONS.includes(numeric) ? numeric : 0;
}

export function readPlaybackSpeedPreference() {
  try {
    return normalizePlaybackSpeed(window.localStorage?.getItem(MUSIC_PLAYBACK_SPEED_KEY));
  } catch {
    return 1;
  }
}

export function writePlaybackSpeedPreference(value) {
  try {
    window.localStorage?.setItem(MUSIC_PLAYBACK_SPEED_KEY, String(normalizePlaybackSpeed(value)));
  } catch {}
}

export function normalizePlaybackSpeed(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  const match = PLAYBACK_SPEED_OPTIONS.find((option) => Math.abs(option - numeric) < 0.001);
  return match || 1;
}

export function playbackSpeedLabel(value) {
  return `${normalizePlaybackSpeed(value)}x`;
}

export function readRepeatPreference() {
  try {
    return ["none", "all", "one"].includes(window.localStorage?.getItem(MUSIC_REPEAT_KEY))
      ? window.localStorage.getItem(MUSIC_REPEAT_KEY)
      : "all";
  } catch {
    return "all";
  }
}

export function writeRepeatPreference(value) {
  try {
    window.localStorage?.setItem(MUSIC_REPEAT_KEY, value);
  } catch {}
}

export function readShufflePreference() {
  try {
    return window.localStorage?.getItem(MUSIC_SHUFFLE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeShufflePreference(value) {
  try {
    window.localStorage?.setItem(MUSIC_SHUFFLE_KEY, value ? "1" : "0");
  } catch {}
}

export function ratingLabel(rating) {
  const value = Math.max(0, Math.min(5, Number(rating || 0)));
  return value ? `${"★".repeat(value)}${"☆".repeat(5 - value)}` : "";
}

export function compactTrack(track = {}) {
  return {
    id: track.id || "",
    title: track.title || "",
    artist: track.artist || "",
    artistId: track.artistId || "",
    album: track.album || "",
    albumId: track.albumId || "",
    trackNo: Number(track.trackNo || 0),
    discNo: Number(track.discNo || 0),
    genre: track.genre || "",
    language: track.language || "",
    durationMs: Number(track.durationMs || 0),
    coverUrl: track.coverUrl || "",
    streamUrl: track.streamUrl || "",
    downloadUrl: track.downloadUrl || "",
    codec: track.codec || "",
    sampleRate: Number(track.sampleRate || 0),
    bitDepth: Number(track.bitDepth || 0),
    fileName: track.fileName || "",
    sizeBytes: Number(track.sizeBytes || 0),
    favorite: Boolean(track.favorite),
    rating: Number(track.rating || 0),
    positionMs: Number(track.positionMs || 0),
    hasLyrics: Boolean(track.hasLyrics)
  };
}

export function readResumeQueuePreference() {
  try {
    const value = window.localStorage?.getItem(MUSIC_RESUME_QUEUE_KEY);
    return value === null ? true : value === "1";
  } catch {
    return true;
  }
}

export function writeResumeQueuePreference(value) {
  try {
    window.localStorage?.setItem(MUSIC_RESUME_QUEUE_KEY, value ? "1" : "0");
  } catch {}
}

export function readRememberVersionChoicesPreference() {
  try {
    const value = window.localStorage?.getItem(MUSIC_REMEMBER_VERSION_KEY);
    return value === null ? true : value === "1";
  } catch {
    return true;
  }
}

export function writeRememberVersionChoicesPreference(value) {
  try {
    window.localStorage?.setItem(MUSIC_REMEMBER_VERSION_KEY, value ? "1" : "0");
  } catch {}
}

export function readVersionStrategyPreference() {
  try {
    return normalizeVersionStrategy(window.localStorage?.getItem(MUSIC_VERSION_STRATEGY_KEY));
  } catch {
    return "smart";
  }
}

export function writeVersionStrategyPreference(value) {
  try {
    window.localStorage?.setItem(MUSIC_VERSION_STRATEGY_KEY, normalizeVersionStrategy(value));
  } catch {}
}

export function readVersionPreferencesPreference() {
  try {
    const parsed = JSON.parse(window.localStorage?.getItem(MUSIC_VERSION_PREFERENCES_KEY) || "{}");
    return pruneVersionPreferences(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {});
  } catch {
    return {};
  }
}

export function writeVersionPreferencesPreference(value) {
  try {
    window.localStorage?.setItem(MUSIC_VERSION_PREFERENCES_KEY, JSON.stringify(pruneVersionPreferences(value)));
  } catch {}
}

export function pruneVersionPreferences(value) {
  const entries = Object.entries(value && typeof value === "object" && !Array.isArray(value) ? value : {})
    .filter(([key, item]) => String(key || "").trim() && String(item?.trackId || "").trim())
    .sort((left, right) => Number(right[1]?.updatedAt || 0) - Number(left[1]?.updatedAt || 0))
    .slice(0, VERSION_PREFERENCE_LIMIT)
    .map(([key, item]) => [key, {
      trackId: String(item.trackId).trim(),
      label: String(item.label || "").trim(),
      updatedAt: Number(item.updatedAt || 0)
    }]);
  return Object.fromEntries(entries);
}

export function readPlaybackQueuePreference() {
  try {
    const parsed = JSON.parse(window.localStorage?.getItem(MUSIC_PLAYBACK_QUEUE_KEY) || "null");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function writePlaybackQueuePreference(record) {
  try {
    window.localStorage?.setItem(MUSIC_PLAYBACK_QUEUE_KEY, JSON.stringify(record || {}));
  } catch {}
}

export function clearPlaybackQueuePreference() {
  try {
    window.localStorage?.removeItem(MUSIC_PLAYBACK_QUEUE_KEY);
  } catch {}
}

export function readLastTrackPreference() {
  try {
    const parsed = JSON.parse(window.localStorage?.getItem(MUSIC_LAST_TRACK_KEY) || "null");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function writeLastTrackPreference(record) {
  try {
    window.localStorage?.setItem(MUSIC_LAST_TRACK_KEY, JSON.stringify(record || {}));
  } catch {}
}
