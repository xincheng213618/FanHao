// 播放偏好持久化（localStorage 读写），原先位于 music-page.js 尾部。
import { normalizePlaybackSpeed } from "./format.js";

const MUSIC_LAST_TRACK_KEY = "fanhao.music.lastTrack";
const MUSIC_QUEUE_KEY = "fanhao.music.queue.v1:";
const MUSIC_PLAYBACK_SPEED_KEY = "fanhao.music.playbackSpeed";

export function readMusicQueuePreference(owner) {
  if (!owner) return null;
  try {
    const saved = JSON.parse(window.localStorage?.getItem(MUSIC_QUEUE_KEY + owner) || "null");
    if (!Array.isArray(saved?.tracks) || typeof saved.currentId !== "string") return null;
    const seen = new Set();
    const tracks = [];
    for (const item of saved.tracks) {
      if (typeof item?.id !== "string" || !item.id || seen.has(item.id)) continue;
      const track = queueTrackSnapshot(item);
      try {
        const id = encodeURIComponent(track.id);
        track.coverUrl = track.hasCover ? `/media/music-cover/${id}` : "";
        track.downloadUrl = track.hasDownload ? `/media/music-download/${id}` : "";
      } catch { continue; }
      seen.add(item.id);
      tracks.push(track);
    }
    return { tracks, currentId: seen.has(saved.currentId) ? saved.currentId : "",
      playlistId: typeof saved.playlistId === "string" ? saved.playlistId : "" };
  } catch {
    return null;
  }
}

export function writeMusicQueuePreference(owner, tracks, currentId, playlistId) {
  if (!owner) return false;
  try {
    const record = { tracks: tracks.map(queueTrackSnapshot), currentId };
    if (playlistId) record.playlistId = playlistId;
    window.localStorage.setItem(MUSIC_QUEUE_KEY + owner, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

function queueTrackSnapshot(track) {
  return {
    id: track.id,
    title: typeof track.title === "string" ? track.title : "",
    artist: typeof track.artist === "string" ? track.artist : "",
    album: typeof track.album === "string" ? track.album : "",
    durationMs: Number.isFinite(track.durationMs) ? Math.max(0, track.durationMs) : 0,
    favorite: Boolean(track.favorite),
    rating: Number.isInteger(track.rating) ? Math.max(0, Math.min(5, track.rating)) : 0,
    hasCover: Boolean(track.coverUrl || track.hasCover),
    hasDownload: Boolean(track.downloadUrl || track.hasDownload)
  };
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
