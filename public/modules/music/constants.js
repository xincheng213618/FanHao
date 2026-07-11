// 客户端音乐模块共享常量。
// 这些常量原先分散在 music-page.js 顶部，集中到此处以便 state / api / player /
// actions / views 各模块复用，避免重复定义。

export const MUSIC_SLEEP_TIMER_OPTIONS = [0, 10, 15, 30, 45, 60, 90];
export const MUSIC_PLAYBACK_SPEED_OPTIONS = [0.75, 1, 1.25, 1.5, 2];

export const MUSIC_PAGE_LIMIT = 120;
export const MUSIC_ARTIST_PAGE_LIMIT = 80;
export const MUSIC_ALBUM_PAGE_LIMIT = 80;

export const DESKTOP_QUEUE_PREVIEW_LIMIT = 24;
export const DESKTOP_QUEUE_PAGE_SIZE = 120;

export const MUSIC_KEYBOARD_SEEK_SECONDS = 5;
export const MUSIC_KEYBOARD_FAST_SEEK_SECONDS = 15;

export const MUSIC_VISUALIZER_FRAME_MS = 50;

export const MUSIC_PROGRESS_SAVE_DELAY_MS = 700;
export const MUSIC_PROGRESS_SAVE_INTERVAL_MS = 10000;

export const MUSIC_SIDE_LIST_CACHE_MS = 60000;

export const MUSIC_LIBRARY_SEARCH_DEBOUNCE_MS = 220;
export const MUSIC_LIBRARY_CLEAR_DEBOUNCE_MS = 80;
export const MUSIC_CATALOG_SEARCH_DEBOUNCE_MS = 180;
export const MUSIC_SUGGEST_MIN_CHARACTERS = 3;

export const HOME_SORT = "played";
export const HOME_LIMIT = 80;
