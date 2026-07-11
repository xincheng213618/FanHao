// 音乐模块状态切片（state.music）的纯初始化 / 规范化。
// 只负责把宿主全局 state 上的 music 字段补齐为合法默认形状，并读取播放偏好。
// 不持有 audio、不安装事件、不调度 sleep timer —— 那些由 player 模块与组合根负责。

import {
  readVolumePreference,
  readPlaybackSpeedPreference,
  readRepeatPreference,
  readShufflePreference
} from "./prefs.js";
import {
  normalizePlaybackSpeed,
  normalizeRepeat,
  normalizeSleepTimerMinutes
} from "./format.js";

const MUSIC_MODES = ["home", "library", "artists", "albums", "history", "playlist", "smart", "report"];
const ALBUM_SORTS = ["updated", "title", "year", "tracks"];

/**
 * 确保 state.music 存在并补齐所有默认字段。
 * 这是一个纯函数（仅读写传入的 state 对象 + localStorage），不触碰 DOM / audio。
 * @param {object} state 宿主全局状态对象
 */
export function ensureMusicState(state) {
  if (!state) return;
  if (!state.music) state.music = {};
  const music = state.music;

  music.query = music.query || "";
  music.mode = MUSIC_MODES.includes(music.mode) ? music.mode : "library";
  music.artistId = music.artistId || "all";
  music.albumId = music.albumId || "all";
  music.genre = music.genre || "all";
  music.language = music.language || "all";
  music.letter = music.letter || "";
  music.activePlaylistId = music.activePlaylistId || "";
  music.activeSmartPlaylistId = music.activeSmartPlaylistId || "";
  music.sort = music.sort || "album";
  music.artistSort = music.artistSort === "name" ? "name" : "count";
  music.albumSort = ALBUM_SORTS.includes(music.albumSort) ? music.albumSort : "updated";
  music.favorite = Boolean(music.favorite);
  music.data = music.data || null;
  music.summary = music.summary || null;
  music.artists = Array.isArray(music.artists) ? music.artists : [];
  music.albums = Array.isArray(music.albums) ? music.albums : [];
  music.genres = Array.isArray(music.genres) ? music.genres : [];
  music.languages = Array.isArray(music.languages) ? music.languages : [];
  music.playlists = Array.isArray(music.playlists) ? music.playlists : [];
  music.smartPlaylists = Array.isArray(music.smartPlaylists) ? music.smartPlaylists : [];
  music.playlistsLoadedAt = Number(music.playlistsLoadedAt || 0);
  music.smartPlaylistsLoadedAt = Number(music.smartPlaylistsLoadedAt || 0);
  music.suggestions = music.suggestions || { query: "", tracks: [], artists: [], albums: [] };
  music.suggestionQuery = music.suggestionQuery || "";
  music.activePlaylist = music.activePlaylist || null;
  music.activeSmartPlaylist = music.activeSmartPlaylist || null;
  music.current = music.current || null;
  music.lyrics = music.lyrics || { raw: "", lines: [] };
  music.lyricFollowPaused = Boolean(music.lyricFollowPaused);
  music.queue = Array.isArray(music.queue) ? music.queue : [];
  music.queueExpanded = Boolean(music.queueExpanded);
  music.queueVisibleLimit = Math.max(120, Number(music.queueVisibleLimit || 0));
  music.prevId = music.prevId || "";
  music.nextId = music.nextId || "";
  music.loading = Boolean(music.loading);
  music.loadingMore = Boolean(music.loadingMore);
  music.hasMore = Boolean(music.hasMore);
  music.playing = Boolean(music.playing);
  music.playbackError = String(music.playbackError || "");
  music.status = music.status || "";
  music.volume = readVolumePreference();
  music.playbackSpeed = normalizePlaybackSpeed(music.playbackSpeed ?? readPlaybackSpeedPreference());
  music.repeat = normalizeRepeat(readRepeatPreference());
  music.shuffle = readShufflePreference();
  music.sleepMinutes = normalizeSleepTimerMinutes(music.sleepMinutes);
  music.sleepUntil = Number(music.sleepUntil || 0);
  music.playReportedTrackId = music.playReportedTrackId || "";
  music.mediaSessionTrackId = music.mediaSessionTrackId || "";
  music.playlistDialogOpen = Boolean(music.playlistDialogOpen);
  music.playlistDialogTrackId = music.playlistDialogTrackId || "";
  music.playlistDialogName = music.playlistDialogName || "";
  music.libraryDrawerOpen = Boolean(music.libraryDrawerOpen);
  music.trackPageOpen = Boolean(music.trackPageOpen);
  music.playerStageOpen = Boolean(music.playerStageOpen);
  music.openingTrackId = music.openingTrackId || "";
  music.rescanning = Boolean(music.rescanning);
}
