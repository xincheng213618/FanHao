// Smart-mix definitions and SQL predicates for music.

import { REDISCOVER_DAYS } from "./constants.js";

export const SMART_MIXES = [
  {
    id: "recent",
    name: "最近播放",
    description: "按最近播放时间自动更新，适合继续刚才的听歌顺序。",
    badge: "继续听",
    order: "s.last_played_at DESC, t.album_title COLLATE NOCASE ASC, t.track_no ASC",
    limit: 120
  },
  {
    id: "topplayed",
    name: "常听歌曲",
    description: "按播放次数自动整理，保留真正反复听过的歌曲。",
    badge: "常听",
    order: "COALESCE(s.play_count, 0) DESC, COALESCE(s.last_played_at, '') DESC, t.title COLLATE NOCASE ASC",
    limit: 200
  },
  {
    id: "unplayed",
    name: "还没听过",
    description: "从未记录播放的歌曲，适合从本地库里继续发现。",
    badge: "未听",
    order: "t.updated_at DESC, t.album_title COLLATE NOCASE ASC, t.track_no ASC, t.title COLLATE NOCASE ASC",
    limit: 240
  },
  {
    id: "newest",
    name: "最近入库",
    description: "按扫描更新时间整理，快速听到新加入音乐库的歌曲。",
    badge: "新歌",
    order: "t.updated_at DESC, t.album_title COLLATE NOCASE ASC, t.disc_no ASC, t.track_no ASC, t.title COLLATE NOCASE ASC",
    limit: 200
  },
  {
    id: "favorites",
    name: "我喜欢",
    description: "所有已收藏歌曲，按最近收藏或更新靠前。",
    badge: "收藏",
    order: "s.updated_at DESC, t.title COLLATE NOCASE ASC",
    limit: 200
  },
  {
    id: "toprated",
    name: "高分精选",
    description: "4 星及以上歌曲，按评分和更新时间排序。",
    badge: "4★+",
    order: "COALESCE(s.rating, 0) DESC, s.updated_at DESC, t.title COLLATE NOCASE ASC",
    limit: 200
  },
  {
    id: "unrated",
    name: "待评分",
    description: "还没有评分的歌曲，适合边听边整理。",
    badge: "待评",
    order: "t.album_title COLLATE NOCASE ASC, t.disc_no ASC, t.track_no ASC, t.title COLLATE NOCASE ASC",
    limit: 240
  },
  {
    id: "hires",
    name: "无损与高解析",
    description: "FLAC、WAV、ALAC 或 24bit/48kHz 以上音频。",
    badge: "Hi-Res",
    order: "COALESCE(t.bit_depth, 0) DESC, COALESCE(t.sample_rate, 0) DESC, t.album_title COLLATE NOCASE ASC, t.track_no ASC",
    limit: 240
  },
  {
    id: "lyrics",
    name: "带歌词",
    description: "已匹配 LRC 歌词的歌曲，适合沉浸播放。",
    badge: "LRC",
    order: "t.album_title COLLATE NOCASE ASC, t.disc_no ASC, t.track_no ASC, t.title COLLATE NOCASE ASC",
    limit: 240
  },
  {
    id: "longform",
    name: "长曲沉浸",
    description: "5 分钟以上的长曲，按时长优先。",
    badge: "5min+",
    order: "t.duration_ms DESC, t.title COLLATE NOCASE ASC",
    limit: 160
  },
  {
    id: "rediscover",
    name: "重温收藏",
    description: "收藏或听过、但最近 30 天没有播放的歌曲。",
    badge: "重温",
    order: "COALESCE(s.last_played_at, '') ASC, COALESCE(s.updated_at, '') DESC, t.title COLLATE NOCASE ASC",
    limit: 160
  }
];

export function findSmartMix(id) {
  const value = String(id || "").trim().toLowerCase();
  return SMART_MIXES.find((mix) => mix.id === value) || null;
}

export function smartMixCondition(mixOrId) {
  const mix = typeof mixOrId === "string" ? findSmartMix(mixOrId) : mixOrId;
  if (!mix) return { where: "1 = 0", args: [] };
  if (mix.id === "recent") return { where: "COALESCE(s.last_played_at, '') <> ''", args: [] };
  if (mix.id === "topplayed") return { where: "COALESCE(s.play_count, 0) > 0", args: [] };
  if (mix.id === "unplayed") return { where: "COALESCE(s.play_count, 0) = 0 AND COALESCE(s.last_played_at, '') = ''", args: [] };
  if (mix.id === "newest") return { where: "COALESCE(t.updated_at, '') <> ''", args: [] };
  if (mix.id === "favorites") return { where: "COALESCE(s.favorite, 0) = 1", args: [] };
  if (mix.id === "toprated") return { where: "COALESCE(s.rating, 0) >= 4", args: [] };
  if (mix.id === "unrated") return { where: "COALESCE(s.rating, 0) = 0", args: [] };
  if (mix.id === "hires") {
    return {
      where: "(LOWER(COALESCE(t.codec, '')) IN ('flac', 'wav', 'alac') OR LOWER(COALESCE(t.ext, '')) IN ('.flac', '.wav', '.aiff', '.ape', '.dff', '.dsf') OR COALESCE(t.bit_depth, 0) >= 24 OR COALESCE(t.sample_rate, 0) >= 48000)",
      args: []
    };
  }
  if (mix.id === "lyrics") return { where: "COALESCE(t.has_lrc, 0) = 1", args: [] };
  if (mix.id === "longform") return { where: "COALESCE(t.duration_ms, 0) >= 300000", args: [] };
  if (mix.id === "rediscover") {
    const cutoff = new Date(Date.now() - REDISCOVER_DAYS * 24 * 60 * 60 * 1000).toISOString();
    return {
      where: "(COALESCE(s.favorite, 0) = 1 OR COALESCE(s.play_count, 0) > 0) AND (COALESCE(s.last_played_at, '') = '' OR s.last_played_at < ?)",
      args: [cutoff]
    };
  }
  return { where: "1 = 0", args: [] };
}
