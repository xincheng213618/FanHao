// 播放偏好持久化（localStorage 读写），原先位于 music-page.js 尾部。
import { normalizePlaybackSpeed } from "./format.js";

const MUSIC_LAST_TRACK_KEY = "fanhao.music.lastTrack";
const MUSIC_PLAYBACK_SPEED_KEY = "fanhao.music.playbackSpeed";

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

export function readVolumePreference() {
  try {
    const value = Number(window.localStorage?.getItem("fanhao.music.volume") || 0.82);
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.82;
  } catch {
    return 0.82;
  }
}

export function writeVolumePreference(value) {
  try {
    window.localStorage?.setItem("fanhao.music.volume", String(value));
  } catch {}
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

export function readRepeatPreference() {
  try {
    return window.localStorage?.getItem("fanhao.music.repeat") || "all";
  } catch {
    return "all";
  }
}

export function writeRepeatPreference(value) {
  try {
    window.localStorage?.setItem("fanhao.music.repeat", value);
  } catch {}
}

export function readShufflePreference() {
  try {
    return window.localStorage?.getItem("fanhao.music.shuffle") === "1";
  } catch {
    return false;
  }
}

export function writeShufflePreference(value) {
  try {
    window.localStorage?.setItem("fanhao.music.shuffle", value ? "1" : "0");
  } catch {}
}
