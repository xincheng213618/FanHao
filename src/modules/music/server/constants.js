// Auto-extracted shared constants for the music store sub-modules.
export const AUDIO_EXTS = new Set([".flac", ".mp3", ".m4a", ".aac", ".wav", ".aiff", ".ape", ".dff", ".dsf", ".ogg", ".opus"]);
export const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
export const DEFAULT_LIMIT = 120;
export const MAX_PAGE_LIMIT = 300;
export const MAX_LIMIT = 2000;
export const MAX_LYRIC_BYTES = 1024 * 1024;
export const MAX_INTRO_BYTES = 512 * 1024;
export const MAX_M3U_BYTES = 2 * 1024 * 1024;
export const KUWO_UTF16LE_PREFIX = Buffer.from([0x77, 0x91, 0x11, 0x62, 0xf3, 0x97, 0x50, 0x4e]);
export const REDISCOVER_DAYS = 30;
export const MUSIC_FACET_CACHE = new WeakMap();
export const MUSIC_GENRE_ALIASES = new Map([
  ["c-pop", "华语流行"],
  ["cpop", "华语流行"],
  ["mandopop", "华语流行"],
  ["chinese pop", "华语流行"],
  ["pop", "流行"],
  ["folk", "民谣"],
  ["rock", "摇滚"],
  ["r&b", "R&B/嘻哈"],
  ["hip-hop", "R&B/嘻哈"],
  ["hip hop", "R&B/嘻哈"],
  ["rap", "R&B/嘻哈"],
  ["dj", "DJ/Remix"],
  ["remix", "DJ/Remix"],
  ["live", "现场"],
  ["instrumental", "轻音乐"]
]);
export const MUSIC_TITLE_GENRE_HINTS = [
  { genre: "DJ/Remix", pattern: /\b(?:dj|remix|club mix|mix)\b|混音|电音|舞曲/iu },
  { genre: "现场", pattern: /\b(?:live|concert|unplugged)\b|演唱会|现场|巡回|巡演|音乐节|不插电|海宁站|重庆演出/iu },
  { genre: "伴奏", pattern: /伴奏|karaoke|off vocal/iu },
  { genre: "轻音乐", pattern: /纯音乐|钢琴曲|piano|instrumental/iu }
];
export const MUSIC_ARTIST_GENRE_HINTS = [
  { genre: "民谣", pattern: /许巍|海来阿木|赵雷|马頔|宋冬野|尧十三/iu },
  { genre: "摇滚", pattern: /崔健|黑豹|唐朝|beyond|逃跑计划|新裤子|万能青年旅店/iu },
  { genre: "R&B/嘻哈", pattern: /周杰伦|jay\s*chou|陶喆|方大同|王力宏|潘玮柏/iu },
  { genre: "华语流行", pattern: /s\.?\s*h\.?\s*e|田馥甄|hebe|selina|ella|张韶涵|戴佩妮|梁静茹|孙燕姿|蔡依林|王菲|陈奕迅|五月天|林俊杰/iu }
];
