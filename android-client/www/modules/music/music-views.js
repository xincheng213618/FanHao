import { deleteJson, fetchJson, postJson, putJson } from "../../js/api.js?v=20260708-mobile-music-36";
import { absoluteUrl } from "../../js/image.js?v=20260706-mobile-web-sync-01";
import { formatBytes, formatCompact, formatNumber } from "../../js/format.js";
import { buildTrackVersionGroups, findTrackVersionGroup, getTrackVersionInfo } from "./track-versions.js?v=20260713-music-search-versions-01";
import {
  DEFAULT_MODE,
  DEFAULT_SORT,
  SLEEP_AFTER_CURRENT,
  SLEEP_TIMER_OPTIONS,
  PLAYBACK_SPEED_OPTIONS,
  FADE_SECONDS_OPTIONS,
  CROSSFADE_SECONDS_OPTIONS,
  VERSION_STRATEGY_OPTIONS,
  emptySearchOverview,
  emptySearchRecovery,
  collapseDuplicateTracks,
  selectTrackByVersionStrategy,
  shuffleTrackQueue,
  normalizeVersionStrategy,
  versionStrategyLabel,
  versionStrategyDescription,
  normalizeMode,
  normalizeSearchScope,
  emptyLyricSearch,
  normalizeAlbumSort,
  normalizeSort,
  formatClock,
  formatSeconds,
  shortDate,
  defaultPlaylistName,
  defaultQueuePlaylistName,
  initials,
  playIcon,
  playLabel,
  repeatIcon,
  repeatLabel,
  nextRepeat,
  normalizeSleepTimerMinutes,
  sleepOptionLabel,
  readVolumePreference,
  writeVolumePreference,
  readSearchHistoryPreference,
  writeSearchHistoryPreference,
  readFadeSecondsPreference,
  writeFadeSecondsPreference,
  normalizeFadeSeconds,
  readGaplessPreference,
  writeGaplessPreference,
  readCrossfadeSecondsPreference,
  writeCrossfadeSecondsPreference,
  normalizeCrossfadeSeconds,
  readPlaybackSpeedPreference,
  writePlaybackSpeedPreference,
  normalizePlaybackSpeed,
  playbackSpeedLabel,
  readRepeatPreference,
  writeRepeatPreference,
  readShufflePreference,
  writeShufflePreference,
  ratingLabel,
  compactTrack,
  readResumeQueuePreference,
  writeResumeQueuePreference,
  readRememberVersionChoicesPreference,
  writeRememberVersionChoicesPreference,
  readVersionStrategyPreference,
  writeVersionStrategyPreference,
  readVersionPreferencesPreference,
  writeVersionPreferencesPreference,
  pruneVersionPreferences,
  readPlaybackQueuePreference,
  writePlaybackQueuePreference,
  clearPlaybackQueuePreference,
  readLastTrackPreference,
  writeLastTrackPreference
} from "./music-state.js?v=20260716-music-state-01";

export { selectTrackByVersionStrategy, shuffleTrackQueue } from "./music-state.js?v=20260716-music-state-01";

const DEFAULT_LIMIT = 80;
const SEARCH_DEBOUNCE_MS = 280;
const SEARCH_SUGGESTION_DEBOUNCE_MS = 90;

export function createMusicViews(deps) {
  const {
    els,
    getActiveUrl,
    setActiveBottom,
    showView,
    replaceViewParams
  } = deps;

  const savedGapless = readGaplessPreference();
  const savedCrossfadeSeconds = readCrossfadeSecondsPreference();

  const state = {
    mode: DEFAULT_MODE,
    searchScope: "all",
    query: "",
    sort: DEFAULT_SORT,
    artistSort: "count",
    albumSort: "updated",
    favorite: false,
    smartId: "",
    smartPlaylists: [],
    smartPlaylist: null,
    playlists: [],
    playlist: null,
    playlistId: "",
    artistId: "",
    albumId: "",
    genre: "",
    language: "",
    data: null,
    summary: null,
    current: null,
    lyrics: { lines: [], raw: "" },
    queue: [],
    prevId: "",
    nextId: "",
    loading: false,
    loadingMore: false,
    hasMore: false,
    status: "",
    playing: false,
    searchOpen: false,
    fullscreen: false,
    fullPanel: "lyrics",
    lyricFollowPaused: false,
    queueOpen: false,
    playlistSheetOpen: false,
    sleepSheetOpen: false,
    settingsOpen: false,
    trackActionId: "",
    playlistActionTrackId: "",
    repeat: readRepeatPreference(),
    shuffle: readShufflePreference(),
    volume: readVolumePreference(),
    playbackSpeed: readPlaybackSpeedPreference(),
    fadeSeconds: readFadeSecondsPreference(),
    gapless: savedGapless && !savedCrossfadeSeconds,
    crossfadeSeconds: savedGapless ? 0 : savedCrossfadeSeconds,
    resumeQueue: readResumeQueuePreference(),
    rememberVersionChoices: readRememberVersionChoicesPreference(),
    versionPreferences: readVersionPreferencesPreference(),
    versionStrategy: readVersionStrategyPreference(),
    searchFavorite: false,
    searchLyrics: false,
    searchMinRating: 0,
    searchQuality: "",
    searchHistory: readSearchHistoryPreference(),
    searchOverview: emptySearchOverview(),
    lyricSearch: emptyLyricSearch(),
    searchRecovery: emptySearchRecovery(),
    searchSuggestions: [],
    searchSuggestionQuery: "",
    searchSuggestionIndex: -1,
    searchSuggestionLoading: false,
    searchCollapsedGroups: new Set(),
    searchExpandedVersionGroups: new Set(),
    sleepMinutes: 0,
    sleepUntil: 0,
    playReportedTrackId: "",
    restoreAttemptKey: "",
    mediaSessionTrackId: "",
    pendingCurrentReveal: false
  };

  let audio = null;
  const audioEventTargets = new WeakSet();
  let progressTimer = 0;
  let pendingProgressRecord = null;
  let lyricRaf = 0;
  let progressBindings = [];
  let currentLyricIndex = -1;
  let mediaSessionInstalled = false;
  let sleepTimerTimeout = 0;
  let sleepTimerInterval = 0;
  let pendingSearchFocus = null;
  let searchDebounceTimer = 0;
  let searchSuggestionTimer = 0;
  let searchSuggestionController = null;
  let mountedSearchController = null;
  let lyricSearchController = null;
  let mountedSearchToken = 0;
  let audioFadeToken = 0;
  let crossfadeToken = 0;
  let crossfadeOutgoingAudio = null;
  let gaplessPreloadAudio = null;
  let gaplessPreloadTrackId = "";
  let gaplessHandoffPending = false;
  let moduleActive = false;

  installLifecycle();

  async function renderMusicList(params = {}, renderGuard = null) {
    moduleActive = true;
    ensureAudio();
    applyRouteParams(params);
    setActiveBottom("music");
    els.viewKicker.textContent = "本地音乐";
    els.viewTitle.textContent = musicTitle();
    els.viewMeta.textContent = state.status || "正在读取";
    els.viewContent.className = "content-list music-mobile-content";
    renderShell();
    const openedTrackId = String(params.trackId || "").trim();
    await Promise.all([loadSmartPlaylists(renderGuard), loadPlaylists(renderGuard), loadMusic(renderGuard)]);
    if (openedTrackId && state.current?.id !== openedTrackId) {
      await openTrack(openedTrackId, { autoplay: false, renderGuard });
      return;
    }
    await restorePlaybackQueue(renderGuard);
    await restoreLastTrack(renderGuard);
  }

  function applyRouteParams(params = {}) {
    state.mode = normalizeMode(params.mode);
    state.query = String(params.query || params.q || "").trim();
    state.searchScope = normalizeSearchScope(params.searchScope || params.scope, state.mode);
    state.sort = normalizeSort(params.sort);
    state.artistSort = String(params.artistSort || "count") === "name" ? "name" : "count";
    state.albumSort = normalizeAlbumSort(params.albumSort);
    state.favorite = ["1", "true", "yes"].includes(String(params.favorite || params.fav || "").trim().toLowerCase());
    state.searchFavorite = ["1", "true", "yes"].includes(String(params.searchFavorite || "").trim().toLowerCase());
    state.searchLyrics = ["1", "true", "yes"].includes(String(params.searchLyrics || params.lyrics || "").trim().toLowerCase());
    state.searchMinRating = Number(params.searchMinRating || params.minRating || 0) >= 4 ? 4 : 0;
    state.searchQuality = String(params.searchQuality || params.quality || "").trim().toLowerCase() === "lossless" ? "lossless" : "";
    state.smartId = String(params.smartId || params.smart || "").trim();
    state.playlistId = String(params.playlistId || params.playlist || "").trim();
    state.artistId = String(params.artistId || params.artist || "").trim();
    state.albumId = String(params.albumId || params.album || "").trim();
    state.genre = String(params.genre || params.musicGenre || "").trim();
    state.language = String(params.language || params.musicLanguage || "").trim();
    if (state.smartId) {
      state.mode = "smart";
      state.favorite = false;
      state.playlistId = "";
    }
    if (state.playlistId) {
      state.mode = "playlist";
      state.favorite = false;
      state.smartId = "";
    }
    if (state.favorite) state.mode = "library";
    if (state.mode === "artists") state.searchScope = "artists";
    else if (state.mode === "albums") state.searchScope = "albums";
    else if (state.mode !== "library") state.searchScope = "all";
    if (!["library", "artists", "albums"].includes(state.mode)) {
      state.artistId = "";
      state.albumId = "";
      state.genre = "";
      state.language = "";
    }
    if (!state.query || state.mode !== "library") resetSearchFilters();
  }

  async function loadMusic(renderGuard = null) {
    const requestUrl = getActiveUrl();
    const unifiedSearch = state.mode === "library" && Boolean(state.query);
    const lyricOnlySearch = unifiedSearch && state.searchScope === "lyrics";
    const playlistOnlySearch = unifiedSearch && state.searchScope === "playlists";
    state.searchOverview = unifiedSearch
      ? { ...emptySearchOverview(), loading: true }
      : emptySearchOverview();
    state.lyricSearch = unifiedSearch && ["all", "lyrics"].includes(state.searchScope)
      ? { ...emptyLyricSearch(), loading: true }
      : emptyLyricSearch();
    if (lyricOnlySearch) {
      state.loading = false;
      state.status = "";
      state.data = { ...(state.data || {}), query: state.query, tracks: [], rawTracks: [], rawLoaded: 0, total: 0, hasMore: false };
      renderShell();
      await loadLyricSearchResults(renderGuard, { limit: 40 });
      return;
    }
    if (playlistOnlySearch) {
      state.loading = false;
      state.status = "";
      state.data = { ...(state.data || {}), query: state.query, tracks: [], rawTracks: [], rawLoaded: 0, total: 0, hasMore: false };
      renderShell();
      if (!searchPlaylistMatches(state.query).length) await loadSearchRecovery(state.query, renderGuard?.signal);
      return;
    }
    state.loading = true;
    state.status = "正在读取音乐库";
    renderShell();
    try {
      const data = await fetchJson(requestUrl, musicListPath(), {
        timeoutMs: 18000,
        signal: renderGuard?.signal
      });
      if (renderGuard && !renderGuard()) return;
      applyLoadedMusicData(data);
      els.viewTitle.textContent = musicTitle();
      els.viewMeta.textContent = musicMeta(data);
      renderShell();
      if (unifiedSearch) {
        await Promise.all([
          loadSearchOverview(renderGuard),
          ["all", "lyrics"].includes(state.searchScope)
            ? loadLyricSearchResults(renderGuard, { limit: state.searchScope === "lyrics" ? 40 : 4 })
            : Promise.resolve()
        ]);
      }
    } catch (error) {
      if (renderGuard && !renderGuard()) return;
      state.loading = false;
      state.status = error?.message || "音乐库读取失败";
      renderShell();
    }
  }

  async function loadMoreTracks() {
    if (state.loadingMore || !state.hasMore || !["library", "artists", "albums"].includes(state.mode)) return;
    state.loadingMore = true;
    renderMusicUiPreservingSearch();
    try {
      const params = new URLSearchParams(musicListQuery());
      params.set("offset", String(state.mode === "artists"
        ? state.data?.artists?.length || 0
        : state.mode === "albums"
          ? state.data?.albums?.length || 0
          : state.data?.rawLoaded ?? state.data?.tracks?.length ?? 0));
      const endpoint = state.mode === "artists" ? "/api/music/artists" : state.mode === "albums" ? "/api/music/albums" : "/api/music/tracks";
      const data = await fetchJson(getActiveUrl(), `${endpoint}?${params}`, { timeoutMs: 18000 });
      if (state.mode === "artists") {
        state.data = { ...data, artists: [...(state.data?.artists || []), ...(data.artists || [])] };
      } else if (state.mode === "albums") {
        state.data = { ...data, albums: [...(state.data?.albums || []), ...(data.albums || [])] };
      } else {
        const rawTracks = [...(state.data?.rawTracks || state.data?.tracks || []), ...(data.tracks || [])];
        const tracks = state.mode === "library" && state.query ? collapseDuplicateTracks(rawTracks) : rawTracks;
        state.data = { ...data, tracks, rawTracks, rawLoaded: rawTracks.length };
        if (!state.query) state.queue = tracks;
      }
      state.summary = data.summary || state.summary;
      state.hasMore = Boolean(data.hasMore);
    } finally {
      state.loadingMore = false;
      renderMusicUiPreservingSearch();
    }
  }

  function applyLoadedMusicData(data = {}) {
    const rawTracks = Array.isArray(data.tracks) ? data.tracks : [];
    const visibleTracks = state.mode === "library" && state.query ? collapseDuplicateTracks(rawTracks) : rawTracks;
    state.data = ["artists", "albums"].includes(state.mode)
      ? data
      : { ...data, tracks: visibleTracks, rawTracks, rawLoaded: rawTracks.length };
    state.summary = data.summary || state.summary;
    state.smartPlaylist = data.smartPlaylist || selectedSmartPlaylist();
    state.playlist = data.playlist || selectedPlaylist();
    if (!["artists", "albums"].includes(state.mode) && !state.query) state.queue = visibleTracks;
    state.hasMore = Boolean(data.hasMore);
    state.loading = false;
    state.status = state.mode === "artists"
      ? (Array.isArray(data.artists) && data.artists.length ? "" : "没有匹配的歌手")
      : state.mode === "albums"
        ? (Array.isArray(data.albums) && data.albums.length ? "" : "没有匹配的专辑")
        : (visibleTracks.length ? "" : emptyMessage());
  }

  async function loadSearchOverview(renderGuard = null, options = {}) {
    const query = String(state.query || "").trim();
    if (state.mode !== "library" || !query) {
      state.searchOverview = emptySearchOverview();
      return;
    }
    const artistParams = new URLSearchParams({ limit: "4", q: query, sort: "count" });
    const albumParams = new URLSearchParams({ limit: "6", q: query, sort: "updated" });
    const [artistResult, albumResult] = await Promise.allSettled([
      fetchJson(getActiveUrl(), `/api/music/artists?${artistParams}`, {
        timeoutMs: 12000,
        signal: options.signal || renderGuard?.signal
      }),
      fetchJson(getActiveUrl(), `/api/music/albums?${albumParams}`, {
        timeoutMs: 12000,
        signal: options.signal || renderGuard?.signal
      })
    ]);
    if (renderGuard && !renderGuard()) return;
    if (state.mode !== "library" || state.query !== query) return;
    const artistData = artistResult.status === "fulfilled" ? artistResult.value : null;
    const albumData = albumResult.status === "fulfilled" ? albumResult.value : null;
    state.searchOverview = {
      loading: false,
      artists: Array.isArray(artistData?.artists) ? artistData.artists : [],
      albums: Array.isArray(albumData?.albums) ? albumData.albums : [],
      artistTotal: Number(artistData?.total || 0),
      albumTotal: Number(albumData?.total || 0),
      error: !artistData && !albumData ? "分类结果暂时不可用" : ""
    };
    if (options.mounted) refreshMountedSearchUi();
    else renderShell();
  }

  async function loadSearchRecovery(query, signal = null) {
    const value = String(query || "").trim();
    if (!value || state.mode !== "library") {
      state.searchRecovery = emptySearchRecovery();
      return;
    }
    state.searchRecovery = { ...emptySearchRecovery(), loading: true, query: value };
    refreshMountedSearchUi();
    try {
      const params = new URLSearchParams({ q: value });
      const data = await fetchJson(getActiveUrl(), `/api/music/suggest?${params}`, { timeoutMs: 8000, signal });
      if (signal?.aborted || state.query !== value || state.mode !== "library") return;
      const tracks = buildTrackVersionGroups(data?.tracks || []).slice(0, 4).map((group) => ({
        value: group.baseTitle || group.primary?.title || "",
        title: group.baseTitle || group.primary?.title || "未知歌曲",
        meta: [group.artist || group.primary?.artist || "未知歌手", group.tracks.length > 1 ? `${formatNumber(group.tracks.length)} 个版本` : group.primary?.album || "未知专辑"].filter(Boolean).join(" · ")
      })).filter((item) => item.value);
      const artists = (data?.artists || []).slice(0, 2).map((artist) => ({
        value: artist.name || "",
        title: artist.name || "未知歌手",
        meta: `${formatNumber(artist.trackCount || 0)} 首歌曲`
      })).filter((item) => item.value);
      const albums = (data?.albums || []).filter((album) => String(album.title || "").trim() !== "_单曲").slice(0, 2).map((album) => ({
        value: album.title || "",
        title: album.title || "未知专辑",
        meta: album.artistName || "未知歌手"
      })).filter((item) => item.value);
      const playlists = searchPlaylistMatches(value).slice(0, 2).map((match) => ({
        value: match.item.name || "",
        title: match.item.name || "未命名歌单",
        meta: `${match.kind === "smart" ? "智能歌单" : "我的歌单"} · ${formatNumber(match.item.trackCount || 0)} 首`
      })).filter((item) => item.value);
      state.searchRecovery = {
        loading: false,
        query: value,
        correctedTarget: data?.correctedQuery ? searchSuggestionCorrectionTarget(data) : "",
        tracks,
        artists,
        albums,
        playlists,
        error: ""
      };
    } catch (error) {
      if (signal?.aborted || state.query !== value) return;
      state.searchRecovery = { ...emptySearchRecovery(), query: value, error: error?.message || "相近建议暂时不可用" };
    }
    refreshMountedSearchUi();
  }

  async function loadLyricSearchResults(renderGuard = null, options = {}) {
    const query = String(state.query || "").trim();
    if (state.mode !== "library" || !query) {
      state.lyricSearch = emptyLyricSearch();
      return;
    }
    const limit = Math.max(1, Math.min(100, Number(options.limit || (state.searchScope === "lyrics" ? 40 : 4))));
    const offset = Math.max(0, Number(options.offset || 0));
    const append = Boolean(options.append && offset > 0);
    const ownController = options.signal ? null : new AbortController();
    if (ownController) {
      lyricSearchController?.abort();
      lyricSearchController = ownController;
    }
    const signal = options.signal || ownController?.signal || renderGuard?.signal;
    state.lyricSearch = append
      ? { ...state.lyricSearch, loadingMore: true, error: "" }
      : { ...emptyLyricSearch(), loading: true, limit };
    if (options.mounted) refreshMountedSearchUi();
    try {
      const params = new URLSearchParams({ q: query, limit: String(limit), offset: String(offset) });
      const data = await fetchJson(getActiveUrl(), `/api/music/lyrics/search?${params}`, { timeoutMs: 12000, signal });
      if (signal?.aborted || (renderGuard && !renderGuard()) || state.query !== query || state.mode !== "library") return;
      const matches = Array.isArray(data?.matches) ? data.matches : [];
      state.lyricSearch = {
        loading: false,
        loadingMore: false,
        matches: append ? [...state.lyricSearch.matches, ...matches] : matches,
        total: Number(data?.total || 0),
        limit: Number(data?.limit || limit),
        hasMore: Boolean(data?.hasMore),
        error: ""
      };
    } catch (error) {
      if (signal?.aborted) return;
      state.lyricSearch = append
        ? { ...state.lyricSearch, loadingMore: false, error: error?.message || "歌词加载失败" }
        : { ...emptyLyricSearch(), limit, error: error?.message || "歌词搜索失败" };
    }
    if (options.mounted) refreshMountedSearchUi();
    else renderShell();
  }

  async function refreshMountedSearchResults(query) {
    const value = String(query || "").trim();
    if (normalizeSearchComparison(state.query) !== normalizeSearchComparison(value)) {
      state.searchCollapsedGroups = new Set();
      state.searchExpandedVersionGroups = new Set();
    }
    mountedSearchController?.abort();
    lyricSearchController?.abort();
    const controller = new AbortController();
    mountedSearchController = controller;
    const token = ++mountedSearchToken;
    state.query = value;
    state.searchOpen = true;
    state.searchOverview = state.mode === "library" && value
      ? { ...emptySearchOverview(), loading: true }
      : emptySearchOverview();
    state.searchRecovery = emptySearchRecovery();
    state.lyricSearch = state.mode === "library" && value && ["all", "lyrics"].includes(state.searchScope)
      ? { ...emptyLyricSearch(), loading: true }
      : emptyLyricSearch();
    replaceViewParams?.("music", musicRouteParams(), { replaceHistory: true });
    if (!value) {
      state.loading = false;
      state.status = "";
      if (state.mode === "library") {
        state.data = {
          ...(state.data || {}),
          query: "",
          total: Number(state.summary?.totals?.tracks || state.data?.total || 0)
        };
      }
      state.searchSuggestions = [];
      state.searchSuggestionQuery = "";
      state.searchSuggestionIndex = -1;
      state.searchSuggestionLoading = false;
      state.lyricSearch = emptyLyricSearch();
      state.searchRecovery = emptySearchRecovery();
      refreshMountedSearchUi();
      return;
    }

    if (state.mode === "library" && state.searchScope === "lyrics") {
      state.loading = false;
      state.status = "";
      state.searchOverview = emptySearchOverview();
      state.data = { ...(state.data || {}), query: value, tracks: [], rawTracks: [], rawLoaded: 0, total: 0, hasMore: false };
      refreshMountedSearchUi();
      await loadLyricSearchResults(null, { signal: controller.signal, mounted: true, limit: 40 });
      if (!state.lyricSearch.matches.length) await loadSearchRecovery(value, controller.signal);
      return;
    }

    if (state.mode === "library" && state.searchScope === "playlists") {
      state.loading = false;
      state.status = "";
      state.searchOverview = emptySearchOverview();
      state.lyricSearch = emptyLyricSearch();
      state.data = { ...(state.data || {}), query: value, tracks: [], rawTracks: [], rawLoaded: 0, total: 0, hasMore: false };
      refreshMountedSearchUi();
      if (!searchPlaylistMatches(value).length) await loadSearchRecovery(value, controller.signal);
      return;
    }

    state.loading = true;
    state.status = "正在搜索本地音乐";
    clearPendingSearchData(value);
    refreshMountedSearchUi();
    try {
      const data = await fetchJson(getActiveUrl(), musicListPath(), {
        timeoutMs: 18000,
        signal: controller.signal
      });
      if (controller.signal.aborted || token !== mountedSearchToken || state.query !== value) return;
      applyLoadedMusicData(data);
      if (!state.data?.tracks?.length) state.searchRecovery = { ...emptySearchRecovery(), loading: true, query: value };
      els.viewTitle.textContent = musicTitle();
      els.viewMeta.textContent = musicMeta(data);
      refreshMountedSearchUi();
      if (state.mode === "library") {
        await Promise.all([
          loadSearchOverview(null, { signal: controller.signal, mounted: true }),
          ["all", "lyrics"].includes(state.searchScope)
            ? loadLyricSearchResults(null, {
              signal: controller.signal,
              mounted: true,
              limit: state.searchScope === "lyrics" ? 40 : 4
            })
            : Promise.resolve(),
          !state.data?.tracks?.length ? loadSearchRecovery(value, controller.signal) : Promise.resolve()
        ]);
      }
    } catch (error) {
      if (controller.signal.aborted || token !== mountedSearchToken) return;
      state.loading = false;
      state.status = error?.message || "音乐搜索失败";
      refreshMountedSearchUi();
    }
  }

  function clearPendingSearchData(query) {
    const common = { ...(state.data || {}), query, total: 0, hasMore: false };
    if (state.mode === "artists") {
      state.data = { ...common, artists: [] };
      return;
    }
    if (state.mode === "albums") {
      state.data = { ...common, albums: [] };
      return;
    }
    state.data = { ...common, tracks: [], rawTracks: [], rawLoaded: 0 };
  }

  async function loadSmartPlaylists(renderGuard = null) {
    try {
      const data = await fetchJson(getActiveUrl(), "/api/music/smart-playlists", {
        timeoutMs: 12000,
        signal: renderGuard?.signal
      });
      if (renderGuard && !renderGuard()) return;
      state.smartPlaylists = Array.isArray(data.smartPlaylists) ? data.smartPlaylists : [];
      state.summary = data.summary || state.summary;
      state.smartPlaylist = selectedSmartPlaylist();
      renderMusicUiPreservingSearch();
    } catch {
      state.smartPlaylists = [];
      state.smartPlaylist = null;
    }
  }

  async function loadPlaylists(renderGuard = null) {
    try {
      const data = await fetchJson(getActiveUrl(), "/api/music/playlists", {
        timeoutMs: 12000,
        signal: renderGuard?.signal
      });
      if (renderGuard && !renderGuard()) return;
      state.playlists = Array.isArray(data.playlists) ? data.playlists : [];
      state.playlist = selectedPlaylist();
      renderMusicUiPreservingSearch();
    } catch {
      state.playlists = [];
      state.playlist = null;
    }
  }

  async function openTrack(trackId, options = {}) {
    const id = String(trackId || "").trim();
    if (!id) return;
    ensureAudio();
    state.loading = true;
    state.status = "正在打开歌曲";
    renderShell();
    const query = musicListQuery();
    try {
      const data = await fetchJson(getActiveUrl(), `/api/music/tracks/${encodeURIComponent(id)}${query ? `?${query}` : ""}`, {
        timeoutMs: 18000,
        signal: options.renderGuard?.signal
      });
      if (options.renderGuard && !options.renderGuard()) return;
      cancelCrossfade();
      const hasRequestedSeek = Object.prototype.hasOwnProperty.call(options, "seekMs");
      const requestedSeekMs = Math.max(0, Number(options.seekMs || 0));
      state.current = hasRequestedSeek ? { ...data.track, positionMs: requestedSeekMs } : data.track;
      state.lyrics = data.lyrics || { lines: [], raw: "" };
      state.prevId = data.prevId || "";
      state.nextId = data.nextId || "";
      state.loading = false;
      state.status = "";
      state.playReportedTrackId = "";
      state.lyricFollowPaused = false;
      currentLyricIndex = -1;
      mergeTrackIntoQueue(state.current);
      rememberLastTrack(state.current);
      if (state.fullscreen && !hasLyrics()) state.fullPanel = "cover";
      if (options.openLyrics && hasLyrics()) {
        state.fullscreen = true;
        state.fullPanel = "lyrics";
      }
      loadAudioTrack(state.current, options.autoplay !== false);
      if (hasRequestedSeek && audio.readyState >= 1) audio.currentTime = requestedSeekMs / 1000;
      scheduleGaplessPreload();
      renderShell();
      if (options.openLyrics && hasLyrics()) window.requestAnimationFrame(() => updateLyricHighlight(true));
    } catch (error) {
      if (options.renderGuard && !options.renderGuard()) return;
      state.loading = false;
      state.status = error?.message || "歌曲打开失败";
      renderShell();
    }
  }

  function mergeTrackIntoQueue(track) {
    if (!track?.id) return;
    const queue = Array.isArray(state.queue) ? state.queue : [];
    const index = queue.findIndex((item) => item.id === track.id);
    if (index >= 0) {
      state.queue = queue.map((item) => (item.id === track.id ? { ...item, ...track } : item));
      return;
    }
    state.queue = [track, ...queue];
  }

  function loadAudioTrack(track, autoplay) {
    if (!track?.streamUrl) return;
    ensureAudio();
    const target = absoluteUrl(getActiveUrl(), track.streamUrl);
    if (audio.src !== target) {
      audio.src = target;
      audio.load();
    }
    audio.playbackRate = state.playbackSpeed;
    if (autoplay) playAudio();
  }

  function ensureAudio() {
    if (!audio) {
      audio = new Audio();
      audio.preload = "metadata";
      audio.volume = state.volume;
      audio.playbackRate = state.playbackSpeed;
    }
    installAudioEvents(audio);
    installMediaSessionHandlers();
  }

  function installAudioEvents(target) {
    if (!target || audioEventTargets.has(target)) return;
    audioEventTargets.add(target);
    target.addEventListener("play", () => {
      if (target !== audio) return;
      state.playing = true;
      reportPlayedOnce();
      updatePlaybackUi();
    });
    target.addEventListener("pause", () => {
      if (target !== audio) return;
      state.playing = false;
      saveProgressSoon();
      updatePlaybackUi();
    });
    target.addEventListener("loadedmetadata", () => {
      if (target !== audio) return;
      const position = Number(state.current?.positionMs || 0);
      if (position > 0 && Number.isFinite(target.duration) && position / 1000 < target.duration - 3) {
        target.currentTime = position / 1000;
      }
      updatePlaybackUi();
    });
    target.addEventListener("timeupdate", () => {
      if (target !== audio) return;
      updatePlaybackUi();
      if (state.fullscreen) updateLyricHighlight();
      saveProgressSoon();
      maybePromoteGaplessPreload(target);
    });
    target.addEventListener("ended", () => {
      if (target !== audio) return;
      saveProgressSoon(0);
      if (sleepAfterCurrentTimerActive()) {
        expireSleepTimer();
        return;
      }
      if (state.repeat === "one") {
        target.currentTime = 0;
        playAudio();
        return;
      }
      if (tryPromoteGaplessPreload({ force: true })) return;
      playAdjacent(1, { wrap: state.repeat === "all" }).catch(() => {});
    });
    target.addEventListener("error", () => {
      if (target !== audio) return;
      state.status = "音频播放失败";
      state.playing = false;
      renderMusicUiPreservingSearch();
    });
  }

  function renderShell() {
    if (!moduleActive || !els.viewContent) return;
    const capturedSearchFocus = captureMusicSearchFocus();
    if (capturedSearchFocus) pendingSearchFocus = capturedSearchFocus;
    const searchFocus = pendingSearchFocus;
    progressBindings = [];
    currentLyricIndex = -1;
    if (lyricRaf) window.cancelAnimationFrame(lyricRaf);
    lyricRaf = 0;
    els.viewContent.innerHTML = "";
    const shell = document.createElement("section");
    const searchFocused = Boolean(state.searchOpen || state.query);
    shell.className = `music-mobile-shell${searchFocused ? " is-search-focused" : ""}`;
    if (searchFocused) {
      shell.append(renderSearchSurface(), renderSearchContentRegion());
    } else {
      shell.append(renderLibraryHeader());
      if (!["artists", "albums"].includes(state.mode)) shell.append(renderSmartPlaylists(), renderPlaylists());
      shell.append(renderTabs(), renderControls());
      if (state.mode === "artists") shell.append(renderArtistBrowser());
      else if (state.mode === "albums") shell.append(renderAlbumBrowser());
      else shell.append(renderFacetFilters(), renderTrackList());
    }
    shell.append(renderMiniPlayer());
    if (state.fullscreen) shell.append(renderFullPlayer());
    if (state.settingsOpen) shell.append(renderSettingsBackdrop(), renderSettingsSheet());
    if (state.trackActionId) shell.append(renderTrackActionsBackdrop(), renderTrackActionsSheet());
    if (state.playlistActionTrackId) shell.append(renderPlaylistActionsBackdrop(), renderPlaylistActionsSheet());
    els.viewContent.append(shell);
    document.body.classList.toggle("music-player-open", state.fullscreen);
    els.viewTitle.textContent = musicTitle();
    els.viewMeta.textContent = state.status || musicMeta(state.data);
    updatePlaybackUi();
    restoreMusicSearchFocus(searchFocus);
    if (state.fullscreen) updateLyricHighlight(true);
    if (state.pendingCurrentReveal && !state.loading && !state.fullscreen) {
      schedulePendingCurrentReveal();
    }
  }

  function renderSmartPlaylists() {
    const section = document.createElement("section");
    section.className = "music-mobile-smart";
    const items = Array.isArray(state.smartPlaylists) ? state.smartPlaylists : [];
    if (!items.length) {
      section.hidden = true;
      return section;
    }

    const head = document.createElement("div");
    head.className = "music-mobile-smart-head";
    const title = document.createElement("strong");
    title.textContent = "智能歌单";
    const meta = document.createElement("small");
    meta.textContent = state.smartId ? "当前列表" : "为你整理";
    head.append(title, meta);

    const scroller = document.createElement("div");
    scroller.className = "music-mobile-smart-scroll";
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `music-mobile-smart-card${item.id === state.smartId ? " active" : ""}`;
      button.disabled = !Number(item.trackCount || 0);
      button.addEventListener("click", () => {
        updateListParams({
          mode: item.id === state.smartId ? "library" : "smart",
          smartId: item.id === state.smartId ? "" : item.id,
          query: "",
          favorite: false,
          artistId: "",
          albumId: ""
        }, { resetSearch: true });
      });

      const badge = document.createElement("span");
      badge.className = "music-mobile-smart-badge";
      badge.textContent = item.badge || "Mix";
      const name = document.createElement("strong");
      name.textContent = item.name || "智能歌单";
      const desc = document.createElement("small");
      desc.textContent = item.description || "";
      const count = document.createElement("em");
      count.textContent = `${formatNumber(item.trackCount || 0)} 首`;
      button.append(badge, name, desc, count);
      scroller.append(button);
    }

    section.append(head, scroller);
    return section;
  }

  function renderPlaylists() {
    const section = document.createElement("section");
    section.className = "music-mobile-playlists";
    const items = Array.isArray(state.playlists) ? state.playlists : [];

    const head = document.createElement("div");
    head.className = "music-mobile-smart-head";
    const title = document.createElement("strong");
    title.textContent = "我的歌单";
    const create = document.createElement("button");
    create.type = "button";
    create.className = "music-mobile-text-button";
    create.textContent = "新建";
    create.addEventListener("click", () => createPlaylistFromPrompt({ openAfterCreate: true }).catch(() => {}));
    head.append(title, create);

    const scroller = document.createElement("div");
    scroller.className = "music-mobile-playlist-scroll";
    if (!items.length) {
      const empty = document.createElement("button");
      empty.type = "button";
      empty.className = "music-mobile-playlist-card empty";
      empty.addEventListener("click", () => createPlaylistFromPrompt({ openAfterCreate: true }).catch(() => {}));
      const name = document.createElement("strong");
      name.textContent = "创建歌单";
      const meta = document.createElement("small");
      meta.textContent = "收藏当前喜欢的歌曲";
      empty.append(name, meta);
      scroller.append(empty);
    } else {
      for (const item of items) {
        const active = state.mode === "playlist" && item.id === state.playlistId;
        const button = document.createElement("button");
        button.type = "button";
        button.className = `music-mobile-playlist-card${active ? " active" : ""}`;
        button.addEventListener("click", () => {
          updateListParams({
            mode: active ? "library" : "playlist",
            playlistId: active ? "" : item.id,
            smartId: "",
            favorite: false,
            query: "",
            artistId: "",
            albumId: "",
            genre: ""
          }, { resetSearch: true });
        });
        const name = document.createElement("strong");
        name.textContent = item.name || "未命名歌单";
        const meta = document.createElement("small");
        meta.textContent = `${formatNumber(item.trackCount || 0)} 首`;
        button.append(name, meta);
        scroller.append(button);
      }
    }

    section.append(head, scroller);
    return section;
  }

  function renderLibraryHeader() {
    const header = document.createElement("section");
    header.className = "music-mobile-library-head";
    const summary = state.summary || state.data?.summary || {};
    const totals = summary.totals || {};

    const text = document.createElement("span");
    const kicker = document.createElement("small");
    kicker.textContent = "本地音乐";
    const title = document.createElement("strong");
    title.textContent = musicTitle();
    const meta = document.createElement("em");
    const showLibraryTotals = state.mode === "library" && !state.favorite && !state.query && !state.artistId && !state.albumId && !state.genre;
    meta.textContent = showLibraryTotals && totals.tracks
      ? `${formatCompact(totals.tracks)} 首 · ${formatCompact(totals.albums)} 专辑 · ${formatBytes(totals.bytes || 0)}`
      : musicMeta(state.data);
    text.append(kicker, title, meta);

    const actions = document.createElement("span");
    actions.className = "music-mobile-library-actions";
    const settings = document.createElement("button");
    settings.type = "button";
    settings.className = "music-mobile-play-all secondary music-mobile-settings-trigger";
    settings.textContent = "设置";
    settings.addEventListener("click", openSettings);
    actions.append(settings);
    if (state.mode === "playlist" && state.playlistId) {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "music-mobile-play-all secondary";
      edit.textContent = "编辑";
      edit.addEventListener("click", () => editCurrentPlaylist().catch(() => {}));
      actions.append(edit);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "music-mobile-play-all danger";
      remove.textContent = "删除";
      remove.addEventListener("click", () => deleteCurrentPlaylist().catch(() => {}));
      actions.append(remove);
    }

    if (state.current) {
      const locate = document.createElement("button");
      locate.type = "button";
      locate.className = "music-mobile-play-all secondary";
      locate.textContent = "定位";
      locate.disabled = state.loading;
      locate.addEventListener("click", () => locateCurrentTrack());
      actions.append(locate);
    }

    const playAll = document.createElement("button");
    playAll.type = "button";
    playAll.className = "music-mobile-play-all";
    playAll.dataset.musicPlaybackToggle = "true";
    playAll.textContent = state.current ? (state.playing ? "暂停" : "继续") : "播放";
    playAll.disabled = !state.queue.length;
    playAll.addEventListener("click", () => {
      const target = state.current || state.queue[0];
      if (!target) return;
      if (state.current) togglePlayback();
      else openTrack(target.id, { autoplay: true }).catch(() => {});
    });
    actions.append(playAll);

    header.append(text, actions);
    return header;
  }

  function renderTabs() {
    const tabs = document.createElement("div");
    tabs.className = "music-mobile-tabs";
    for (const tab of [
      { label: "全部", mode: "library", favorite: false },
      { label: "歌手", mode: "artists", favorite: false },
      { label: "专辑", mode: "albums", favorite: false },
      { label: "最近", mode: "history", favorite: false },
      { label: "收藏", mode: "library", favorite: true }
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = state.mode === tab.mode && state.favorite === tab.favorite ? "active" : "";
      button.textContent = tab.label;
      button.addEventListener("click", () => {
        updateListParams({ mode: tab.mode, favorite: tab.favorite, query: "" }, { resetSearch: true });
      });
      tabs.append(button);
    }
    return tabs;
  }

  function renderControls() {
    const wrap = document.createElement("div");
    wrap.className = "music-mobile-controls";
    const searchButton = document.createElement("button");
    searchButton.type = "button";
    searchButton.className = "music-mobile-search-pill";
    searchButton.textContent = "搜索歌曲、歌手、专辑和歌单";
    searchButton.disabled = state.mode === "history";
    searchButton.addEventListener("click", () => {
      state.searchOpen = true;
      renderShell();
      window.requestAnimationFrame(() => els.viewContent.querySelector(".music-mobile-search-input")?.focus());
    });
    wrap.append(searchButton, renderMusicSort());
    return wrap;
  }

  function renderSearchSurface() {
    const surface = document.createElement("section");
    surface.className = "music-mobile-search-surface";
    const bar = document.createElement("div");
    bar.className = "music-mobile-search-bar";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "music-mobile-search-back";
    back.textContent = "返回";
    back.addEventListener("click", closeSearch);

    const search = document.createElement("input");
    search.type = "search";
    search.className = "music-mobile-search-input";
    search.setAttribute("aria-label", "搜索音乐");
    search.setAttribute("enterkeyhint", "search");
    search.setAttribute("role", "combobox");
    search.setAttribute("aria-autocomplete", "list");
    search.setAttribute("aria-controls", "musicSearchSuggestions");
    search.setAttribute("aria-expanded", state.searchSuggestions.length || state.searchSuggestionLoading ? "true" : "false");
    search.autocomplete = "off";
    search.placeholder = searchScopePlaceholder(state.searchScope);
    search.value = state.query;
    search.addEventListener("input", () => scheduleLiveSearch(search.value));
    search.addEventListener("search", () => {
      state.searchSuggestions = [];
      state.searchSuggestionIndex = -1;
      state.searchSuggestionLoading = false;
      commitMusicSearch(search.value, { remember: true });
    });
    search.addEventListener("keydown", (event) => handleSearchSuggestionKeydown(event, search));

    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "music-mobile-search-clear";
    clear.textContent = "清除";
    clear.hidden = !state.query;
    clear.addEventListener("click", () => {
      state.searchSuggestions = [];
      state.searchSuggestionIndex = -1;
      state.searchSuggestionLoading = false;
      search.value = "";
      commitMusicSearch("");
    });
    bar.append(back, search, clear);
    surface.append(bar, renderSearchSuggestionsRegion(), renderSearchSummaryRegion());
    return surface;
  }

  function renderSearchSummaryRegion() {
    const region = document.createElement("div");
    region.className = "music-mobile-search-summary-region";
    if (!state.query) return region;
    const resultsHead = document.createElement("div");
    resultsHead.className = "music-mobile-search-results-head";
    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = `“${state.query}”`;
    const meta = document.createElement("small");
    meta.textContent = state.searchScope === "lyrics"
      ? (state.lyricSearch.loading ? "正在搜索歌词" : `${formatNumber(state.lyricSearch.total || 0)} 首歌词命中`)
      : state.searchScope === "playlists"
        ? `${formatNumber(searchPlaylistMatches(state.query).length)} 个歌单命中`
        : state.loading ? "正在搜索本地音乐" : musicMeta(state.data);
    text.append(title, meta);
    resultsHead.append(text);
    if (!["lyrics", "playlists"].includes(state.searchScope)) resultsHead.append(renderMusicSort());
    const hint = document.createElement("p");
    hint.className = "music-mobile-search-sort-hint";
    hint.textContent = searchSortHint();
    region.append(renderSearchScopes());
    if (state.mode === "library" && ["all", "songs"].includes(state.searchScope)) region.append(renderSearchQuickFilters());
    region.append(resultsHead, hint);
    const playbackAction = renderSearchPlaybackAction();
    if (playbackAction) region.append(playbackAction);
    return region;
  }

  function renderSearchPlaybackAction() {
    if (!state.query || state.mode !== "library" || !["all", "songs"].includes(state.searchScope)) return null;
    const tracks = Array.isArray(state.data?.tracks) ? state.data.tracks : [];
    const queue = preferredSearchQueue(tracks);
    if (!queue.length) return null;
    const action = document.createElement("div");
    action.className = "music-mobile-search-playback-action";
    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = "播放本次搜索";
    const meta = document.createElement("small");
    meta.textContent = `${formatNumber(queue.length)} 首 · 同名版本不重复入队`;
    text.append(title, meta);
    const actions = document.createElement("div");
    actions.className = "music-mobile-search-playback-actions";
    const shuffle = document.createElement("button");
    shuffle.type = "button";
    shuffle.className = "secondary";
    shuffle.textContent = "随机播放";
    shuffle.addEventListener("click", shuffleSearchResults);
    const play = document.createElement("button");
    play.type = "button";
    play.textContent = "播放全部";
    play.addEventListener("click", playSearchResults);
    actions.append(shuffle, play);
    action.append(text, actions);
    return action;
  }

  function renderSearchQuickFilters() {
    const filters = document.createElement("div");
    filters.className = "music-mobile-search-quick-filters";
    const items = [
      { key: "all", label: "全部", active: !hasActiveSearchFilters() },
      { key: "favorite", label: "已收藏", active: state.searchFavorite },
      { key: "lyrics", label: "有歌词", active: state.searchLyrics },
      { key: "rating", label: "4 分以上", active: state.searchMinRating >= 4 },
      { key: "quality", label: "无损", active: state.searchQuality === "lossless" }
    ];
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = item.active ? "active" : "";
      button.textContent = item.label;
      button.setAttribute("aria-pressed", item.active ? "true" : "false");
      button.addEventListener("click", () => toggleSearchFilter(item.key));
      filters.append(button);
    }
    return filters;
  }

  function toggleSearchFilter(key) {
    if (key === "all") resetSearchFilters();
    else if (key === "favorite") state.searchFavorite = !state.searchFavorite;
    else if (key === "lyrics") state.searchLyrics = !state.searchLyrics;
    else if (key === "rating") state.searchMinRating = state.searchMinRating >= 4 ? 0 : 4;
    else if (key === "quality") state.searchQuality = state.searchQuality === "lossless" ? "" : "lossless";
    refreshMountedSearchResults(state.query).catch(() => {});
  }

  function hasActiveSearchFilters() {
    return Boolean(state.searchFavorite || state.searchLyrics || state.searchMinRating || state.searchQuality);
  }

  function resetSearchFilters() {
    state.searchFavorite = false;
    state.searchLyrics = false;
    state.searchMinRating = 0;
    state.searchQuality = "";
  }

  function renderSearchContentRegion() {
    const region = document.createElement("div");
    region.className = "music-mobile-search-content-region";
    region.append(renderSearchContent());
    return region;
  }

  function renderSearchContent() {
    if (!state.query) return renderSearchDiscovery();
    if (state.mode === "artists") return renderArtistBrowser();
    if (state.mode === "albums") return renderAlbumBrowser();
    if (state.searchScope === "songs") return shouldRenderSearchRecovery() ? renderSearchRecovery() : renderSearchSongResults();
    if (state.searchScope === "lyrics") return shouldRenderSearchRecovery() ? renderSearchRecovery() : renderLyricSearchResults();
    if (state.searchScope === "playlists") return shouldRenderSearchRecovery() ? renderSearchRecovery() : renderPlaylistSearchResults();
    const fragment = document.createDocumentFragment();
    if (shouldRenderSearchRecovery()) fragment.append(renderSearchRecovery());
    fragment.append(renderSearchOverview());
    if (state.lyricSearch.loading || state.lyricSearch.matches.length || state.lyricSearch.error) {
      fragment.append(renderLyricSearchResults({ preview: true, collapsible: true }));
    }
    fragment.append(renderSearchSongResults({ preview: true, collapsible: true }));
    return fragment;
  }

  function shouldRenderSearchRecovery() {
    if (!state.query || state.mode !== "library") return false;
    const tracks = Array.isArray(state.data?.tracks) ? state.data.tracks : [];
    if (state.searchScope === "songs") return !state.loading && !tracks.length;
    if (state.searchScope === "lyrics") return !state.lyricSearch.loading && !state.lyricSearch.matches.length;
    if (state.searchScope === "playlists") return !searchPlaylistMatches(state.query).length;
    if (state.loading) return false;
    if (hasActiveSearchFilters() && !tracks.length) return true;
    if (state.searchOverview.loading || state.lyricSearch.loading) return false;
    return !tracks.length
      && !state.searchOverview.artists.length
      && !state.searchOverview.albums.length
      && !searchPlaylistMatches(state.query).length
      && !state.lyricSearch.matches.length;
  }

  function renderSearchRecovery() {
    const recovery = state.searchRecovery || emptySearchRecovery();
    const panel = document.createElement("section");
    panel.className = "music-mobile-search-recovery";
    const eyebrow = document.createElement("small");
    eyebrow.textContent = hasActiveSearchFilters() ? "筛选诊断" : state.searchScope !== "all" ? "范围诊断" : "搜索建议";
    const title = document.createElement("strong");
    title.textContent = hasActiveSearchFilters()
      ? "当前筛选把结果挡住了"
      : state.searchScope !== "all"
        ? `“${searchScopeLabel(state.searchScope)}”中没有结果`
        : "没有找到直接匹配";
    const meta = document.createElement("p");
    const suggestionCount = searchRecoverySuggestionCount(recovery);
    meta.textContent = recovery.loading
      ? "正在检查未筛选结果和相近关键词…"
      : hasActiveSearchFilters()
        ? suggestionCount ? `不带当前筛选时找到了 ${formatNumber(suggestionCount)} 条可继续查看的候选。` : "可以先恢复全部结果，再逐个缩小范围。"
        : suggestionCount ? `为“${state.query}”找到了 ${formatNumber(suggestionCount)} 条相近建议。` : "可以调整关键词，或返回综合结果继续查找。";
    panel.append(eyebrow, title, meta);

    const actions = document.createElement("div");
    actions.className = "music-mobile-search-recovery-actions";
    if (hasActiveSearchFilters()) {
      actions.append(searchRecoveryAction("清除筛选", () => {
        resetSearchFilters();
        refreshMountedSearchResults(state.query).catch(() => {});
      }, true));
    }
    if (state.searchScope !== "all") actions.append(searchRecoveryAction("查看综合", () => switchSearchScope("all"), !hasActiveSearchFilters()));
    if (recovery.correctedTarget && normalizeSearchComparison(recovery.correctedTarget) !== normalizeSearchComparison(state.query)) {
      actions.append(searchRecoveryAction(`搜索“${recovery.correctedTarget}”`, () => commitMusicSearch(recovery.correctedTarget, { remember: true }), !actions.childElementCount));
    }
    if (!actions.childElementCount && !suggestionCount && !recovery.loading) {
      actions.append(searchRecoveryAction("修改关键词", focusSearchInputForRetry, true));
    }
    if (actions.childElementCount) panel.append(actions);
    if (suggestionCount) panel.append(renderSearchRecoverySuggestions(recovery));
    if (recovery.error) {
      const error = document.createElement("small");
      error.className = "music-mobile-search-recovery-error";
      error.textContent = recovery.error;
      panel.append(error);
    }
    return panel;
  }

  function searchScopeLabel(scope) {
    return { songs: "歌曲", lyrics: "歌词", artists: "歌手", albums: "专辑", playlists: "歌单" }[scope] || "综合";
  }

  function searchRecoverySuggestionCount(recovery) {
    const seen = new Set();
    for (const item of [...recovery.tracks, ...recovery.artists, ...recovery.albums, ...recovery.playlists]) {
      const key = normalizeSearchComparison(item.value);
      if (key) seen.add(key);
    }
    return seen.size;
  }

  function searchRecoveryAction(label, action, primary = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `music-mobile-search-recovery-action${primary ? " primary" : ""}`;
    button.textContent = label;
    button.addEventListener("click", action);
    return button;
  }

  function renderSearchRecoverySuggestions(recovery) {
    const wrap = document.createElement("div");
    wrap.className = "music-mobile-search-recovery-suggestions";
    const seen = new Set();
    for (const [type, items] of [["歌曲", recovery.tracks], ["歌手", recovery.artists], ["专辑", recovery.albums], ["歌单", recovery.playlists]]) {
      for (const item of items) {
        const key = normalizeSearchComparison(item.value);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const button = document.createElement("button");
        button.type = "button";
        const badge = document.createElement("small");
        badge.textContent = type;
        const text = document.createElement("span");
        const title = document.createElement("strong");
        title.textContent = item.title;
        const meta = document.createElement("em");
        meta.textContent = item.meta;
        text.append(title, meta);
        button.append(badge, text);
        button.addEventListener("click", () => commitMusicSearch(item.value, { remember: true }));
        wrap.append(button);
      }
    }
    return wrap;
  }

  function focusSearchInputForRetry() {
    const input = els.viewContent?.querySelector(".music-mobile-search-input");
    input?.focus();
    input?.select();
  }

  function refreshMountedSearchUi() {
    const shell = els.viewContent?.querySelector(".music-mobile-shell.is-search-focused");
    const summary = shell?.querySelector(".music-mobile-search-summary-region");
    const content = shell?.querySelector(".music-mobile-search-content-region");
    const input = shell?.querySelector(".music-mobile-search-input");
    if (!shell || !summary || !content || !input) {
      renderShell();
      return false;
    }
    if (document.activeElement !== input && input.value !== state.query) input.value = state.query;
    const clear = shell.querySelector(".music-mobile-search-clear");
    if (clear) clear.hidden = !state.query;
    const nextSummary = renderSearchSummaryRegion();
    summary.replaceChildren(...nextSummary.childNodes);
    content.replaceChildren(renderSearchContent());
    refreshMountedSearchSuggestions();
    els.viewTitle.textContent = musicTitle();
    els.viewMeta.textContent = state.status || musicMeta(state.data);
    updatePlaybackUi();
    return true;
  }

  function renderMusicUiPreservingSearch() {
    if (state.searchOpen || state.query) {
      refreshMountedSearchUi();
      return;
    }
    renderShell();
  }

  function renderSearchSuggestionsRegion() {
    const region = document.createElement("div");
    region.className = "music-mobile-search-suggestions";
    region.id = "musicSearchSuggestions";
    region.setAttribute("role", "listbox");
    region.setAttribute("aria-label", "音乐搜索联想");
    if (state.searchSuggestionLoading) {
      const loading = document.createElement("div");
      loading.className = "music-mobile-search-suggestions-loading";
      loading.textContent = "正在查找本地音乐…";
      region.append(loading);
      return region;
    }
    const groups = new Map();
    for (const [index, item] of (state.searchSuggestions || []).entries()) {
      const key = item.group || "music";
      if (!groups.has(key)) groups.set(key, { label: item.groupLabel || "音乐", items: [] });
      groups.get(key).items.push({ item, index });
    }
    for (const group of groups.values()) {
      const section = document.createElement("section");
      section.className = "music-mobile-search-suggestion-group";
      const head = document.createElement("div");
      head.className = "music-mobile-search-suggestion-group-head";
      const label = document.createElement("strong");
      label.textContent = group.label;
      const count = document.createElement("small");
      count.textContent = `${formatNumber(group.items.length)} 条`;
      head.append(label, count);
      section.append(head);
      for (const entry of group.items) section.append(renderSearchSuggestion(entry.item, entry.index));
      region.append(section);
    }
    return region;
  }

  function renderSearchSuggestion(item, index) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `music-mobile-search-suggestion${state.searchSuggestionIndex === index ? " active" : ""}`;
    button.dataset.searchSuggestionIndex = String(index);
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", state.searchSuggestionIndex === index ? "true" : "false");
    const type = document.createElement("small");
    type.textContent = item.type || "音乐";
    const text = document.createElement("span");
    const title = document.createElement("strong");
    appendHighlightedText(title, item.label || item.value || "", state.searchSuggestionQuery, item.highlights);
    const meta = document.createElement("em");
    meta.textContent = item.meta || "搜索本地音乐";
    text.append(title, meta);
    button.append(type, text);
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", () => activateSearchSuggestion(item));
    return button;
  }

  function activateSearchSuggestion(item) {
    const value = String(item?.commitValue || item?.value || "").trim();
    if (!value) return;
    const input = els.viewContent?.querySelector(".music-mobile-search-input");
    if (input) input.value = value;
    state.searchSuggestions = [];
    state.searchSuggestionIndex = -1;
    state.searchSuggestionLoading = false;
    commitMusicSearch(value, { remember: true });
  }

  function refreshMountedSearchSuggestions() {
    const current = els.viewContent?.querySelector(".music-mobile-search-suggestions");
    if (!current) return;
    const next = renderSearchSuggestionsRegion();
    current.replaceChildren(...next.childNodes);
    const input = els.viewContent?.querySelector(".music-mobile-search-input");
    input?.setAttribute("aria-expanded", current.childElementCount ? "true" : "false");
    window.requestAnimationFrame(() => current.querySelector(".music-mobile-search-suggestion.active")?.scrollIntoView({ block: "nearest" }));
  }

  function renderSearchScopes() {
    const tabs = document.createElement("div");
    tabs.className = "music-mobile-search-scopes";
    for (const item of [
      { scope: "all", label: "综合" },
      { scope: "songs", label: "歌曲" },
      { scope: "lyrics", label: "歌词" },
      { scope: "artists", label: "歌手" },
      { scope: "albums", label: "专辑" },
      { scope: "playlists", label: "歌单" }
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = state.searchScope === item.scope ? "active" : "";
      button.textContent = item.label;
      button.setAttribute("aria-pressed", state.searchScope === item.scope ? "true" : "false");
      button.addEventListener("click", () => switchSearchScope(item.scope));
      tabs.append(button);
    }
    return tabs;
  }

  function renderSearchDiscovery() {
    const discovery = document.createElement("section");
    discovery.className = "music-mobile-search-discovery";
    if (state.searchHistory.length) {
      const history = document.createElement("section");
      history.className = "music-mobile-search-block";
      const head = document.createElement("div");
      head.className = "music-mobile-search-block-head";
      const title = document.createElement("strong");
      title.textContent = "搜索历史";
      const clear = document.createElement("button");
      clear.type = "button";
      clear.textContent = "清空";
      clear.addEventListener("click", clearSearchHistory);
      head.append(title, clear);
      history.append(head, renderSearchHistoryChips(state.searchHistory));
      discovery.append(history);
    }

    discovery.append(renderSearchShortcutBlock());

    const hotItems = searchDiscoveryHotItems();
    if (hotItems.length) discovery.append(renderSearchHotBlock(hotItems));

    const recent = searchDiscoveryRecentTracks();
    if (recent.length) discovery.append(renderSearchRecentBlock(recent));

    const artists = prioritizedFacetItems(artistFacetItems(state.data?.artists || []), "", 12)
      .map((item) => item.name || item.label || item.id)
      .filter((value) => value && !["待识别", "未知歌手"].includes(value))
      .slice(0, 8);
    if (artists.length) {
      const artistBlock = document.createElement("section");
      artistBlock.className = "music-mobile-search-block";
      artistBlock.append(searchDiscoveryBlockHead("本地歌手", "按曲库规模推荐"), renderSearchChips(artists));
      discovery.append(artistBlock);
    }
    return discovery;
  }

  function renderSearchShortcutBlock() {
    const block = document.createElement("section");
    block.className = "music-mobile-search-block music-mobile-search-shortcuts-block";
    block.append(searchDiscoveryBlockHead("快捷入口", "快速缩小搜索范围"));
    const grid = document.createElement("div");
    grid.className = "music-mobile-search-shortcuts";
    for (const item of [
      { label: "搜歌曲", meta: "歌名与文件名", action: () => focusSearchDiscoveryScope("songs") },
      { label: "搜歌词", meta: "歌词全文定位", action: () => focusSearchDiscoveryScope("lyrics") },
      { label: "搜歌手", meta: "歌手与作品", action: () => focusSearchDiscoveryScope("artists") },
      { label: "搜专辑", meta: "专辑与年份", action: () => focusSearchDiscoveryScope("albums") },
      { label: "搜歌单", meta: "我的歌单与智能歌单", action: () => focusSearchDiscoveryScope("playlists") },
      { label: "最近播放", meta: "继续上次听歌", action: () => openSearchDiscoveryCollection("history") },
      { label: "我喜欢", meta: "只看已收藏", action: () => openSearchDiscoveryCollection("favorites") }
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      const label = document.createElement("strong");
      label.textContent = item.label;
      const meta = document.createElement("small");
      meta.textContent = item.meta;
      button.append(label, meta);
      button.addEventListener("click", item.action);
      grid.append(button);
    }
    block.append(grid);
    return block;
  }

  function renderSearchHotBlock(items) {
    const block = document.createElement("section");
    block.className = "music-mobile-search-block music-mobile-search-hot-block";
    block.append(searchDiscoveryBlockHead("本地热搜", "按播放次数生成"));
    const list = document.createElement("div");
    list.className = "music-mobile-search-hot-list";
    items.slice(0, 6).forEach((track, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = index < 3 ? "leading" : "";
      const rank = document.createElement("b");
      rank.textContent = String(index + 1).padStart(2, "0");
      const text = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = track.title || "未知歌曲";
      const meta = document.createElement("small");
      meta.textContent = [track.artist || "未知歌手", track.playCount ? `播放 ${formatNumber(track.playCount)} 次` : "本地曲库"].join(" · ");
      text.append(title, meta);
      const action = document.createElement("em");
      action.textContent = "搜索";
      button.append(rank, text, action);
      button.addEventListener("click", () => commitMusicSearch(track.title, { remember: true }));
      list.append(button);
    });
    block.append(list);
    return block;
  }

  function renderSearchRecentBlock(tracks) {
    const block = document.createElement("section");
    block.className = "music-mobile-search-block music-mobile-search-recent-block";
    block.append(searchDiscoveryBlockHead("最近播放", "点歌曲直接续播", () => openSearchDiscoveryCollection("history")));
    const rail = document.createElement("div");
    rail.className = "music-mobile-search-recent-rail";
    tracks.slice(0, 8).forEach((track) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "music-mobile-search-recent-card";
      button.append(renderCover(track, "tiny"));
      const text = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = track.title || "未知歌曲";
      const meta = document.createElement("small");
      meta.textContent = track.artist || "未知歌手";
      text.append(title, meta);
      button.append(text);
      button.addEventListener("click", () => playSearchDiscoveryTrack(track, tracks));
      rail.append(button);
    });
    block.append(rail);
    return block;
  }

  function searchDiscoveryBlockHead(label, hint, action = null) {
    const head = document.createElement("div");
    head.className = "music-mobile-search-block-head";
    const title = document.createElement("strong");
    title.textContent = label;
    if (!action) {
      const meta = document.createElement("small");
      meta.textContent = hint;
      head.append(title, meta);
      return head;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = hint;
    button.addEventListener("click", action);
    head.append(title, button);
    return head;
  }

  function searchDiscoveryHotItems() {
    const summary = state.summary || state.data?.summary || {};
    const primary = Array.isArray(summary.topPlayed) ? summary.topPlayed : [];
    const fallback = Array.isArray(state.data?.tracks) ? state.data.tracks : [];
    const seen = new Set();
    return [...primary, ...fallback].filter((track) => {
      const key = normalizeSearchComparison(track?.title);
      if (!track?.id || !key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 6);
  }

  function searchDiscoveryRecentTracks() {
    const summary = state.summary || state.data?.summary || {};
    const recent = Array.isArray(summary.recent) ? summary.recent : [];
    if (recent.length) return recent.slice(0, 8);
    return state.current?.id ? [state.current] : [];
  }

  function focusSearchDiscoveryScope(scope) {
    const nextScope = normalizeSearchScope(scope, "library");
    state.mode = nextScope === "artists" ? "artists" : nextScope === "albums" ? "albums" : "library";
    state.searchScope = nextScope;
    state.searchOpen = true;
    renderShell();
    window.requestAnimationFrame(() => {
      const input = els.viewContent?.querySelector(".music-mobile-search-input");
      if (!input) return;
      input.placeholder = searchScopePlaceholder(nextScope);
      input.focus();
    });
  }

  function openSearchDiscoveryCollection(kind) {
    state.searchOpen = false;
    state.searchScope = "all";
    if (kind === "history") {
      updateListParams({ mode: "history", query: "", favorite: false }, { resetSearch: true });
      return;
    }
    updateListParams({ mode: "library", query: "", favorite: true }, { resetSearch: true });
  }

  function playSearchDiscoveryTrack(track, tracks) {
    if (!track?.id) return;
    state.queue = (Array.isArray(tracks) ? tracks : []).map((item) => ({ ...item }));
    openTrack(track.id, { autoplay: true }).catch(() => {});
  }

  function searchScopePlaceholder(scope) {
    return {
      songs: "搜索歌名或文件名",
      lyrics: "输入一句歌词",
      artists: "搜索歌手",
      albums: "搜索专辑",
      playlists: "搜索我的歌单或智能歌单"
    }[scope] || "搜索歌曲、歌手、专辑或歌单";
  }

  function searchPlaylistMatches(query = state.query) {
    const needle = normalizeSearchComparison(query);
    if (!needle) return [];
    const terms = needle.split(" ").filter(Boolean);
    const candidates = [
      ...(state.playlists || []).map((item) => ({ kind: "user", item })),
      ...(state.smartPlaylists || []).map((item) => ({ kind: "smart", item }))
    ];
    return candidates.map((candidate, index) => {
      const name = normalizeSearchComparison(candidate.item?.name);
      const description = normalizeSearchComparison(candidate.item?.description);
      const combined = `${name} ${description}`.trim();
      const score = name === needle
        ? 12000
        : name.startsWith(needle)
          ? 7000
          : name.includes(needle)
            ? 5000
            : description.includes(needle)
              ? 2200
              : terms.length > 1 && terms.every((term) => combined.includes(term))
                ? 1600
                : 0;
      return { ...candidate, index, score };
    }).filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index);
  }

  function renderPlaylistSearchResults(options = {}) {
    const matches = Array.isArray(options.matches) ? options.matches : searchPlaylistMatches(state.query);
    const visible = options.preview ? matches.slice(0, 5) : matches;
    const rail = document.createElement("div");
    rail.className = `music-mobile-search-playlist-list${options.preview ? " is-preview" : ""}`;
    for (const match of visible) rail.append(renderPlaylistSearchCard(match));
    const group = renderSearchResultGroup("playlists", "歌单", `${formatNumber(matches.length)} 个`, rail, {
      onMore: options.preview && matches.length > visible.length ? () => switchSearchScope("playlists") : null
    });
    group.classList.add("music-mobile-search-playlist-results");
    if (!options.collapsible) {
      group.querySelector(".music-mobile-search-result-group-toggle")?.remove();
      group.classList.remove("is-collapsed");
      if (!group.querySelector(".music-mobile-search-playlist-list")) group.append(rail);
    }
    return group;
  }

  function renderPlaylistSearchCard(match) {
    const playlist = match.item || {};
    const button = document.createElement("button");
    button.type = "button";
    button.className = `music-mobile-search-playlist-card type-${match.kind}`;
    const badge = document.createElement("b");
    badge.textContent = match.kind === "smart" ? (playlist.badge || "Mix") : "歌单";
    const text = document.createElement("span");
    const name = document.createElement("strong");
    appendHighlightedText(name, playlist.name || "未命名歌单", state.query);
    const description = document.createElement("small");
    description.textContent = playlist.description || (match.kind === "smart" ? "自动更新的智能歌单" : "我的歌单");
    text.append(name, description);
    const count = document.createElement("em");
    count.textContent = `${formatNumber(playlist.trackCount || 0)} 首`;
    button.append(badge, text, count);
    button.addEventListener("click", () => openPlaylistSearchMatch(match));
    return button;
  }

  function openPlaylistSearchMatch(match) {
    const playlist = match?.item;
    if (!playlist?.id) return;
    updateListParams({
      mode: match.kind === "smart" ? "smart" : "playlist",
      smartId: match.kind === "smart" ? playlist.id : "",
      playlistId: match.kind === "user" ? playlist.id : "",
      query: "",
      favorite: false,
      artistId: "",
      albumId: "",
      genre: "",
      language: ""
    }, { resetSearch: true });
  }

  function renderSearchOverview() {
    const overview = document.createElement("section");
    overview.className = "music-mobile-search-overview";
    const data = state.searchOverview || emptySearchOverview();
    if (data.loading) {
      const loading = document.createElement("div");
      loading.className = "music-mobile-search-overview-loading";
      loading.textContent = "正在整理歌手和专辑…";
      overview.append(loading);
      return overview;
    }
    if (data.error) {
      const error = document.createElement("small");
      error.className = "music-mobile-search-overview-note";
      error.textContent = data.error;
      overview.append(error);
      return overview;
    }

    const best = bestSearchMatch(data);
    if (best) {
      overview.append(
        renderSearchOverviewHead("最佳匹配", `${best.label} · 智能识别`, () => switchSearchScope(best.scope)),
        renderBestSearchMatch(best)
      );
    }

    const artists = (Array.isArray(data.artists) ? data.artists : [])
      .filter((artist) => best?.type !== "artist" || artist.id !== best.item.id);
    if (artists.length) {
      const relatedArtistTotal = Math.max(artists.length, Number(data.artistTotal || 0) - (best?.type === "artist" ? 1 : 0));
      const rail = document.createElement("div");
      rail.className = "music-mobile-search-artist-rail";
      artists.slice(0, 4).forEach((artist) => rail.append(renderRelatedArtistMatch(artist)));
      overview.append(renderSearchResultGroup("artists", "相关歌手", `${formatNumber(relatedArtistTotal)} 位`, rail, {
        onMore: () => switchSearchScope("artists")
      }));
    }

    const albums = (Array.isArray(data.albums) ? data.albums : [])
      .filter((album) => best?.type !== "album" || album.id !== best.item.id);
    if (albums.length) {
      const relatedAlbumTotal = Math.max(albums.length, Number(data.albumTotal || 0) - (best?.type === "album" ? 1 : 0));
      const rail = document.createElement("div");
      rail.className = "music-mobile-search-album-rail";
      albums.slice(0, 6).forEach((album) => {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "music-mobile-search-album-match";
        card.append(renderCover(album, "tiny"));
        const text = document.createElement("span");
        const title = document.createElement("strong");
        appendSearchHighlightedText(title, album.title || "未知专辑", album, "title");
        const meta = document.createElement("small");
        appendSearchHighlightedText(meta, album.artistName || "未知歌手", album, "artist");
        text.append(title, meta);
        card.append(text);
        card.addEventListener("click", () => updateListParams({
          mode: "library",
          query: "",
          artistId: album.artistId || "",
          albumId: album.id,
          genre: "",
          language: ""
        }, { resetSearch: true }));
        rail.append(card);
      });
      overview.append(renderSearchResultGroup("albums", "相关专辑", `${formatNumber(relatedAlbumTotal)} 张`, rail, {
        onMore: () => switchSearchScope("albums")
      }));
    }
    const playlists = searchPlaylistMatches(state.query)
      .filter((match) => best?.type !== "playlist" || match.kind !== best.playlistKind || match.item.id !== best.item.id);
    if (playlists.length) overview.append(renderPlaylistSearchResults({ preview: true, collapsible: true, matches: playlists }));
    return overview;
  }

  function bestSearchMatch(data) {
    const tracks = Array.isArray(state.data?.tracks) ? state.data.tracks : [];
    const artists = Array.isArray(data?.artists) ? data.artists : [];
    const albums = Array.isArray(data?.albums) ? data.albums : [];
    const playlists = searchPlaylistMatches(state.query);
    const candidates = [
      ...tracks.slice(0, 6).map((item, index) => ({ type: "track", scope: "songs", label: "歌曲", item, index, score: searchEntityScore("track", item) })),
      ...state.lyricSearch.matches.slice(0, 3).map((item, index) => ({ type: "lyric", scope: "lyrics", label: "歌词", item, index, score: 920 + Math.min(60, String(item.text || "").length) })),
      ...artists.slice(0, 4).map((item, index) => ({ type: "artist", scope: "artists", label: "歌手", item, index, score: searchEntityScore("artist", item) })),
      ...albums.slice(0, 6).map((item, index) => ({ type: "album", scope: "albums", label: "专辑", item, index, score: searchEntityScore("album", item) })),
      ...playlists.slice(0, 5).map((match, index) => ({ type: "playlist", scope: "playlists", label: "歌单", item: match.item, playlistKind: match.kind, index, score: match.score }))
    ].filter((item) => item.score > 0);
    return candidates.sort((left, right) => right.score - left.score || left.index - right.index)[0] || null;
  }

  function searchEntityScore(type, item) {
    const scores = item?.searchMatch?.scores || {};
    if (type === "artist") return Number(scores.name || 0) + 40;
    if (type === "album") return Math.max(Number(scores.title || 0) + 30, Number(scores.artist || 0) * 0.72);
    return Math.max(
      Number(scores.title || 0) + 60,
      Number(scores.artist || 0) * 0.72,
      Number(scores.album || 0) * 0.68,
      Number(scores.fileName || 0) * 0.5
    );
  }

  function renderBestSearchMatch(best) {
    const item = best.type === "lyric" ? best.item.track : best.item;
    const versionGroup = best.type === "track" ? searchVersionGroupForTrack(item) : null;
    const card = document.createElement("button");
    card.type = "button";
    card.className = `music-mobile-search-best-match type-${best.type}`;
    if (best.type === "artist") {
      const avatar = document.createElement("b");
      avatar.className = "music-mobile-search-best-avatar";
      avatar.textContent = Array.from(item.name || "?")[0] || "?";
      card.append(avatar);
    } else if (best.type === "playlist") {
      const avatar = document.createElement("b");
      avatar.className = "music-mobile-search-best-avatar playlist";
      avatar.textContent = best.playlistKind === "smart" ? (item.badge || "Mix") : "歌单";
      card.append(avatar);
    } else {
      card.append(renderCover(item, "tiny"));
    }
    const text = document.createElement("span");
    const title = document.createElement("strong");
    const titleValue = ["artist", "playlist"].includes(best.type) ? item.name : item.title;
    if (best.type === "playlist") appendHighlightedText(title, titleValue || "未命名歌单", state.query);
    else appendSearchHighlightedText(title, titleValue || `未知${best.label}`, item, best.type === "artist" ? "name" : "title");
    const meta = document.createElement("small");
    if (best.type === "artist") {
      meta.textContent = [item.language || "其他", `${formatNumber(item.trackCount || 0)} 首`, `${formatNumber(item.albumCount || 0)} 专辑`].join(" · ");
    } else if (best.type === "playlist") {
      meta.textContent = [best.playlistKind === "smart" ? "智能歌单" : "我的歌单", `${formatNumber(item.trackCount || 0)} 首`, item.description || ""].filter(Boolean).join(" · ");
    } else if (best.type === "album") {
      appendSearchHighlightedText(meta, [item.artistName || "未知歌手", `${formatNumber(item.trackCount || 0)} 首`].join(" · "), item, "artist");
    } else if (best.type === "lyric") {
      appendHighlightedText(meta, best.item.text || "歌词命中", state.query, best.item.highlights);
    } else {
      appendSearchHighlightedText(meta, [item.artist || "未知歌手", item.album || "未知专辑"].join(" · "), item, "artist");
      if (versionGroup?.tracks?.length > 1) meta.append(document.createTextNode(` · ${formatNumber(versionGroup.tracks.length)} 个版本`));
      const preferenceLabel = versionGroupPreferenceLabel(versionGroup, item);
      if (preferenceLabel) meta.append(document.createTextNode(` · ${preferenceLabel}`));
    }
    text.append(title, meta);
    const badge = document.createElement("em");
    badge.textContent = best.type === "track"
      ? "立即播放"
      : best.type === "lyric"
        ? `${formatClock(best.item.timeMs)} 播放`
        : "查看";
    card.append(text, badge);
    card.addEventListener("click", () => openBestSearchMatch(best));
    if (!versionGroup || versionGroup.tracks.length < 2) return card;
    const stack = document.createElement("section");
    stack.className = "music-mobile-search-best-stack";
    const versionsHead = document.createElement("div");
    versionsHead.className = "music-mobile-search-version-head";
    const label = document.createElement("strong");
    label.textContent = "选择版本";
    const count = document.createElement("small");
    count.textContent = `${formatNumber(versionGroup.tracks.length)} 个版本可直接播放`;
    versionsHead.append(label, count);
    stack.append(card, versionsHead, renderSearchVersionRail(versionGroup));
    return stack;
  }

  function openBestSearchMatch(best) {
    if (best.type === "lyric") {
      openLyricSearchMatch(best.item).catch(() => {});
      return;
    }
    const item = best.item;
    if (best.type === "track") {
      const versionGroup = searchVersionGroupForTrack(item);
      playSearchTrackVersion(preferredTrackForVersionGroup(versionGroup, item), versionGroup?.tracks || [item]);
      return;
    }
    if (best.type === "playlist") {
      openPlaylistSearchMatch({ kind: best.playlistKind, item });
      return;
    }
    updateListParams({
      mode: "library",
      searchScope: "all",
      query: "",
      artistId: best.type === "artist" ? item.id : item.artistId || "",
      albumId: best.type === "album" ? item.id : "",
      genre: "",
      language: best.type === "artist" ? item.language || "" : ""
    }, { resetSearch: true });
  }

  function currentSearchVersionGroups(tracks = state.data?.tracks) {
    return buildTrackVersionGroups(Array.isArray(tracks) ? tracks : []);
  }

  function searchVersionGroupForTrack(track) {
    if (!track?.id) return null;
    return findTrackVersionGroup(currentSearchVersionGroups(), track.id);
  }

  function versionPreferenceKey(groupKey) {
    const activeUrl = String(getActiveUrl() || "").replace(/\/+$/u, "");
    const key = String(groupKey || "").trim();
    return activeUrl && key ? `${activeUrl}|${key}` : "";
  }

  function preferredTrackForVersionGroup(group, fallback = null) {
    const tracks = Array.isArray(group?.tracks) ? group.tracks : [];
    const defaultTrack = fallback?.id && tracks.some((track) => track.id === fallback.id)
      ? fallback
      : group?.primary || tracks[0] || fallback;
    if (tracks.length < 2) return defaultTrack;
    return rememberedTrackForVersionGroup(group)
      || selectTrackByVersionStrategy(tracks, state.versionStrategy, defaultTrack);
  }

  function rememberedTrackForVersionGroup(group) {
    const tracks = Array.isArray(group?.tracks) ? group.tracks : [];
    if (!state.rememberVersionChoices || tracks.length < 2) return null;
    const preference = state.versionPreferences?.[versionPreferenceKey(group.key)];
    return tracks.find((track) => track.id === preference?.trackId) || null;
  }

  function versionGroupPreferenceBadge(group) {
    if (rememberedTrackForVersionGroup(group)) return "已记住";
    return versionStrategyLabel(state.versionStrategy);
  }

  function versionGroupPreferenceLabel(group, fallback = null) {
    const preferred = preferredTrackForVersionGroup(group, fallback || group?.primary);
    if (!preferred?.id || Number(group?.tracks?.length || 0) < 2) return "";
    return `${versionGroupPreferenceBadge(group)} · ${getTrackVersionInfo(preferred).label}`;
  }

  function renderSearchVersionRail(group) {
    const rail = document.createElement("div");
    rail.className = "music-mobile-search-version-rail";
    for (const track of group.tracks || []) rail.append(renderSearchVersionChoice(track, group, { compact: true }));
    return rail;
  }

  function renderSearchVersionChoice(track, group, options = {}) {
    const info = getTrackVersionInfo(track);
    const preferred = preferredTrackForVersionGroup(group, group?.primary);
    const isPreferred = Number(group?.tracks?.length || 0) > 1 && preferred?.id === track.id;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `music-mobile-search-version-choice${options.compact ? " is-compact" : ""}${isPreferred ? " preferred" : ""}${state.current?.id === track.id ? " active" : ""}`;
    button.dataset.trackVersionId = track.id || "";
    const text = document.createElement("span");
    const labelLine = document.createElement("span");
    labelLine.className = "music-mobile-search-version-choice-label";
    const label = document.createElement("strong");
    label.textContent = info.label;
    labelLine.append(label);
    if (isPreferred) {
      const preferredBadge = document.createElement("i");
      preferredBadge.textContent = versionGroupPreferenceBadge(group);
      labelLine.append(preferredBadge);
    }
    const meta = document.createElement("small");
    meta.textContent = versionChoiceMeta(track);
    text.append(labelLine, meta);
    const duration = document.createElement("em");
    duration.textContent = formatClock(track.durationMs || 0);
    button.append(text, duration);
    button.setAttribute("aria-label", `播放${info.label}：${track.title || group.baseTitle || "歌曲"}`);
    button.addEventListener("click", () => playSearchTrackVersion(track, group.tracks));
    return button;
  }

  function versionChoiceMeta(track) {
    const album = String(track?.album || "").trim();
    return [album && album !== "_单曲" ? album : "单曲", track?.favorite ? "已收藏" : "", ratingLabel(track?.rating)]
      .filter(Boolean)
      .join(" · ");
  }

  function playSearchTrackVersion(track, tracks) {
    if (!track?.id) return;
    const versions = (Array.isArray(tracks) ? tracks : []).filter((item) => item?.id).map((item) => ({ ...item }));
    rememberTrackVersionChoice(track, versions);
    const searchQueue = preferredSearchQueue(state.data?.tracks, track);
    state.queue = searchQueue.length ? searchQueue : versions.length ? versions : [{ ...track }];
    openTrack(track.id, { autoplay: true }).catch(() => {});
  }

  function rememberTrackVersionChoice(track, tracks) {
    if (!state.rememberVersionChoices || !track?.id) return;
    const group = findTrackVersionGroup(buildTrackVersionGroups(tracks), track.id);
    if (!group || group.tracks.length < 2) return;
    const key = versionPreferenceKey(group.key);
    if (!key) return;
    state.versionPreferences = pruneVersionPreferences({
      ...(state.versionPreferences || {}),
      [key]: {
        trackId: track.id,
        label: getTrackVersionInfo(track).label,
        updatedAt: Date.now()
      }
    });
    writeVersionPreferencesPreference(state.versionPreferences);
  }

  function renderRelatedArtistMatch(artist) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "music-mobile-search-related-artist";
    const avatar = document.createElement("b");
    avatar.textContent = Array.from(artist.name || "?")[0] || "?";
    const text = document.createElement("span");
    const name = document.createElement("strong");
    appendSearchHighlightedText(name, artist.name || "未知歌手", artist, "name");
    const meta = document.createElement("small");
    meta.textContent = `${formatNumber(artist.trackCount || 0)} 首`;
    text.append(name, meta);
    card.append(avatar, text);
    card.addEventListener("click", () => openBestSearchMatch({ type: "artist", item: artist }));
    return card;
  }

  function renderSearchOverviewHead(titleText, metaText, onMore) {
    const head = document.createElement("div");
    head.className = "music-mobile-search-overview-head";
    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = titleText;
    const meta = document.createElement("small");
    meta.textContent = metaText;
    text.append(title, meta);
    const more = document.createElement("button");
    more.type = "button";
    more.textContent = "查看全部";
    more.addEventListener("click", onMore);
    head.append(text, more);
    return head;
  }

  function renderSearchResultGroup(key, titleText, metaText, content, options = {}) {
    const groupKey = String(key || "group");
    const collapsed = state.searchCollapsedGroups.has(groupKey);
    const section = document.createElement("section");
    section.className = `music-mobile-search-result-group${collapsed ? " is-collapsed" : ""}`;
    section.dataset.searchResultGroup = groupKey;
    const head = document.createElement("div");
    head.className = "music-mobile-search-overview-head music-mobile-search-result-group-head";
    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = titleText;
    const meta = document.createElement("small");
    meta.textContent = metaText;
    text.append(title, meta);
    const actions = document.createElement("div");
    actions.className = "music-mobile-search-result-group-actions";
    if (typeof options.onPlay === "function") {
      const play = document.createElement("button");
      play.type = "button";
      play.className = "music-mobile-search-result-group-play";
      play.textContent = options.playLabel || "播放全部";
      play.addEventListener("click", options.onPlay);
      actions.append(play);
    }
    if (typeof options.onMore === "function") {
      const more = document.createElement("button");
      more.type = "button";
      more.textContent = "查看全部";
      more.addEventListener("click", options.onMore);
      actions.append(more);
    }
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "music-mobile-search-result-group-toggle";
    toggle.textContent = collapsed ? "展开" : "收起";
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    toggle.setAttribute("aria-label", `${collapsed ? "展开" : "收起"}${titleText}`);
    toggle.addEventListener("click", () => toggleSearchResultGroup(groupKey));
    actions.append(toggle);
    head.append(text, actions);
    section.append(head);
    if (!collapsed && content) section.append(content);
    return section;
  }

  function toggleSearchResultGroup(key) {
    const groupKey = String(key || "group");
    if (state.searchCollapsedGroups.has(groupKey)) state.searchCollapsedGroups.delete(groupKey);
    else state.searchCollapsedGroups.add(groupKey);
    refreshMountedSearchUi();
  }

  function renderSearchSongResults(options = {}) {
    const preview = Boolean(options.preview);
    const tracks = Array.isArray(state.data?.tracks) ? state.data.tracks : [];
    const versionGroups = currentSearchVersionGroups(tracks);
    const visibleGroups = preview ? versionGroups.slice(0, 5) : versionGroups;
    const content = renderTrackList({
      tracks: visibleGroups.map((item) => item.primary).filter(Boolean),
      versionGroups: visibleGroups,
      showLoadMore: !preview
    });
    const group = renderSearchResultGroup("songs", "歌曲", searchVersionGroupMeta(versionGroups, tracks.length), content, {
      onPlay: tracks.length ? playSearchResults : null,
      onMore: preview && (versionGroups.length > visibleGroups.length || state.hasMore) ? () => switchSearchScope("songs") : null
    });
    group.classList.add("music-mobile-search-song-results");
    if (!options.collapsible) {
      group.querySelector(".music-mobile-search-result-group-toggle")?.remove();
      group.classList.remove("is-collapsed");
      if (!group.querySelector(".music-mobile-list")) group.append(content);
    }
    const section = group;
    return section;
  }

  function searchVersionGroupMeta(groups, trackCount) {
    const versionGroups = (Array.isArray(groups) ? groups : []).filter((item) => item.tracks?.length > 1);
    if (groups.length === 1 && versionGroups.length === 1) {
      return `1 首歌曲 · ${formatNumber(versionGroups[0].tracks.length)} 个版本`;
    }
    if (versionGroups.length) return `${formatNumber(groups.length)} 首歌曲 · ${formatNumber(versionGroups.length)} 组多版本`;
    return `${formatNumber(trackCount || groups.length)} 首匹配`;
  }

  function renderLyricSearchResults(options = {}) {
    const preview = Boolean(options.preview);
    const metaText = state.lyricSearch.loading
      ? "正在搜索歌词"
      : `${formatNumber(state.lyricSearch.total || 0)} 首歌曲命中`;
    const content = document.createElement("div");
    content.className = "music-mobile-search-result-group-body";
    if (state.lyricSearch.loading) {
      const loading = document.createElement("div");
      loading.className = "music-mobile-search-overview-loading";
      loading.textContent = "正在定位歌词中的命中句…";
      content.append(loading);
    } else if (state.lyricSearch.error) {
      content.append(messageBox(state.lyricSearch.error));
    } else {
      const allMatches = state.lyricSearch.matches || [];
      const matches = preview ? allMatches.slice(0, 3) : allMatches;
      if (!matches.length) {
        if (!preview) content.append(messageBox("没有找到包含这段文字的歌词"));
      } else {
        const list = document.createElement("div");
        list.className = "music-mobile-lyric-search-list";
        matches.forEach((match) => list.append(renderLyricSearchMatch(match)));
        content.append(list);
      }
      if (!preview && state.lyricSearch.hasMore) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "music-mobile-load-more";
        more.disabled = state.lyricSearch.loadingMore;
        more.textContent = state.lyricSearch.loadingMore
          ? "正在加载更多歌词…"
          : `加载更多（已显示 ${formatNumber(state.lyricSearch.matches.length)} 首）`;
        more.addEventListener("click", () => loadLyricSearchResults(null, {
          limit: 40,
          offset: state.lyricSearch.matches.length,
          append: true,
          mounted: true
        }).catch(() => {}));
        content.append(more);
      }
    }
    const group = renderSearchResultGroup("lyrics", preview ? "歌词命中" : "歌词", metaText, content, {
      onMore: preview && state.lyricSearch.total ? () => switchSearchScope("lyrics") : null
    });
    group.classList.add("music-mobile-lyric-search-results");
    if (preview) group.classList.add("is-preview");
    if (!options.collapsible) {
      group.querySelector(".music-mobile-search-result-group-toggle")?.remove();
      group.classList.remove("is-collapsed");
      if (!group.querySelector(".music-mobile-search-result-group-body")) group.append(content);
    }
    return group;
  }

  function renderLyricSearchMatch(match) {
    const track = match?.track || {};
    const card = document.createElement("button");
    card.type = "button";
    card.className = "music-mobile-lyric-search-card";
    card.append(renderCover(track, "tiny"));
    const body = document.createElement("span");
    body.className = "music-mobile-lyric-search-body";
    const title = document.createElement("strong");
    title.textContent = track.title || "未知歌曲";
    const trackMeta = document.createElement("small");
    trackMeta.textContent = [track.artist || "未知歌手", track.album || "未知专辑"].join(" · ");
    const context = document.createElement("span");
    context.className = "music-mobile-lyric-search-context";
    if (match.before) context.append(lyricSearchContextLine(match.before));
    context.append(lyricSearchContextLine(match.text || "歌词命中", { active: true, highlights: match.highlights }));
    if (match.after) context.append(lyricSearchContextLine(match.after));
    body.append(title, trackMeta, context);
    const time = document.createElement("em");
    time.textContent = formatClock(match.timeMs);
    card.append(body, time);
    card.setAttribute("aria-label", `从 ${formatClock(match.timeMs)} 播放 ${track.title || "歌曲"}`);
    card.addEventListener("click", () => openLyricSearchMatch(match).catch(() => {}));
    return card;
  }

  function lyricSearchContextLine(value, options = {}) {
    const line = document.createElement(options.active ? "strong" : "small");
    appendHighlightedText(line, value, state.query, options.highlights);
    return line;
  }

  async function openLyricSearchMatch(match) {
    const track = match?.track;
    if (!track?.id) return;
    const queue = [];
    const seen = new Set();
    for (const item of state.lyricSearch.matches || []) {
      if (!item?.track?.id || seen.has(item.track.id)) continue;
      seen.add(item.track.id);
      queue.push(item.track);
    }
    if (queue.length) state.queue = queue;
    await openTrack(track.id, {
      autoplay: true,
      seekMs: Math.max(0, Number(match.timeMs || 0)),
      openLyrics: true
    });
  }

  function switchSearchScope(scope) {
    const nextScope = normalizeSearchScope(scope, "library");
    if (["all", "songs", "lyrics", "playlists"].includes(nextScope) && state.mode === "library") {
      const previousScope = state.searchScope;
      state.searchScope = nextScope;
      replaceViewParams?.("music", musicRouteParams(), { replaceHistory: true });
      if (["lyrics", "playlists"].includes(nextScope)) {
        mountedSearchController?.abort();
        state.loading = false;
        state.status = "";
      }
      refreshMountedSearchUi();
      if (["lyrics", "playlists"].includes(previousScope) && !["lyrics", "playlists"].includes(nextScope)) {
        refreshMountedSearchResults(state.query).catch(() => {});
        return;
      }
      if (nextScope === "playlists") {
        if (!searchPlaylistMatches(state.query).length) loadSearchRecovery(state.query).catch(() => {});
        return;
      }
      if (["all", "lyrics"].includes(nextScope)) {
        const neededLimit = nextScope === "lyrics" ? 40 : 4;
        if (state.lyricSearch.limit < neededLimit || (!state.lyricSearch.loading && !state.lyricSearch.matches.length && !state.lyricSearch.error)) {
          loadLyricSearchResults(null, { limit: neededLimit, mounted: true })
            .then(() => {
              if (nextScope === "lyrics" && state.searchScope === "lyrics" && !state.lyricSearch.matches.length) {
                return loadSearchRecovery(state.query);
              }
              return null;
            })
            .catch(() => {});
        }
      }
      return;
    }
    const mode = nextScope === "artists" ? "artists" : nextScope === "albums" ? "albums" : "library";
    updateListParams({
      mode,
      searchScope: nextScope,
      query: state.query,
      favorite: false,
      artistId: "",
      albumId: "",
      genre: "",
      language: ""
    }, { preserveScroll: false });
  }

  function renderSearchChips(items = []) {
    const chips = document.createElement("div");
    chips.className = "music-mobile-search-chips";
    for (const value of items) {
      const text = String(value || "").trim();
      if (!text) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = text;
      button.addEventListener("click", () => commitMusicSearch(text, { remember: true }));
      chips.append(button);
    }
    return chips;
  }

  function renderSearchHistoryChips(items = []) {
    const chips = document.createElement("div");
    chips.className = "music-mobile-search-history-chips";
    for (const value of items) {
      const text = String(value || "").trim();
      if (!text) continue;
      const chip = document.createElement("span");
      chip.className = "music-mobile-search-history-chip";
      const query = document.createElement("button");
      query.type = "button";
      query.className = "music-mobile-search-history-query";
      query.textContent = text;
      query.addEventListener("click", () => commitMusicSearch(text, { remember: true }));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "music-mobile-search-history-remove";
      remove.textContent = "删除";
      remove.setAttribute("aria-label", `删除搜索记录 ${text}`);
      remove.addEventListener("click", () => removeSearchHistoryQuery(text));
      chip.append(query, remove);
      chips.append(chip);
    }
    return chips;
  }

  function renderMusicSort() {
    const sort = document.createElement("select");
    sort.className = "music-mobile-sort";
    sort.setAttribute("aria-label", state.mode === "artists" ? "歌手排序" : state.mode === "albums" ? "专辑排序" : "音乐排序");
    sort.disabled = !["library", "artists", "albums"].includes(state.mode);
    const sortOptions = state.mode === "artists" ? [
      ["count", "歌曲最多"],
      ["name", "按名称"]
    ] : state.mode === "albums" ? [
      ["updated", "最近入库"],
      ["title", "按名称"],
      ["year", "按年份"],
      ["tracks", "歌曲最多"]
    ] : [
      ["album", state.query ? "匹配度" : "专辑"],
      ["artist", "歌手"],
      ["title", "歌名"],
      ["duration", "时长"],
      ["played", "最近"],
      ["favorite", "收藏"],
      ["rating", "评分"]
    ];
    for (const [value, label] of sortOptions) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = (state.mode === "artists" ? state.artistSort : state.mode === "albums" ? state.albumSort : state.sort) === value;
      sort.append(option);
    }
    sort.addEventListener("change", () => updateListParams(state.mode === "artists" ? { artistSort: sort.value } : state.mode === "albums" ? { albumSort: sort.value } : { sort: sort.value }));
    return sort;
  }

  function searchSortHint() {
    if (state.searchScope === "lyrics") return "点击命中歌词，可从对应时间开始播放并自动打开歌词页。";
    if (state.searchScope === "playlists") return "同时查找我的歌单与系统生成的智能歌单，点击即可打开。";
    if (state.data?.correctedQuery) {
      return `已自动纠正为“${state.data.correctedQuery}”，并按歌名、歌手、专辑与常听程度排序。`;
    }
    if (state.data?.searchMode === "phonetic") {
      return "已识别拼音或首字母；完整歌名、歌手和专辑匹配仍会优先显示。";
    }
    if (state.data?.relevance) return "排序依据：完整匹配优先，其次看歌名、歌手、专辑，并参考播放次数。";
    return {
      title: "当前按歌名排序，适合快速定位首字母附近的歌曲。",
      artist: "当前按歌手排序，同一歌手的结果会排在一起。",
      duration: "当前按时长从长到短排序。",
      played: "当前优先显示最近播放过的结果。",
      favorite: "当前优先显示已经收藏的结果。",
      rating: "当前优先显示评分更高的结果。"
    }[state.sort] || "当前按专辑顺序排列搜索结果。";
  }

  function trackSearchMatchLabel(track, query) {
    const needle = normalizeSearchComparison(query);
    if (!needle) return "综合匹配";
    const fields = [
      ["歌名", track?.title],
      ["歌手", track?.artist],
      ["专辑", track?.album],
      ["文件名", track?.fileName]
    ].map(([label, value]) => [label, normalizeSearchComparison(value)]);
    const exact = fields.find(([, value]) => value === needle);
    if (exact) return `${exact[0]}完全匹配`;
    const included = fields.find(([, value]) => value.includes(needle));
    if (included) return `匹配${included[0]}`;
    const terms = needle.split(" ").filter(Boolean);
    const partial = terms.length > 1
      ? fields.find(([, value]) => terms.every((term) => value.includes(term)))
      : null;
    if (partial) return `匹配${partial[0]}`;
    const matchedField = {
      title: "歌名",
      artist: "歌手",
      album: "专辑",
      fileName: "文件名"
    }[track?.searchMatch?.field] || "";
    if (state.data?.correctedQuery) return matchedField ? `容错${matchedField}` : "容错匹配";
    if (state.data?.searchMode === "phonetic") return matchedField ? `拼音${matchedField}` : "拼音匹配";
    return "综合匹配";
  }

  function renderFacetFilters() {
    const wrap = document.createElement("section");
    wrap.className = "music-mobile-facets";
    if (state.mode !== "library") {
      wrap.hidden = true;
      return wrap;
    }
    const artists = Array.isArray(state.data?.artists) ? state.data.artists : [];
    const albums = Array.isArray(state.data?.albums) ? state.data.albums : [];
    const genres = Array.isArray(state.data?.genres) ? state.data.genres : [];
    const languages = Array.isArray(state.data?.languages) ? state.data.languages : (state.summary?.languages || []);
    if (!artists.length && !albums.length && !genres.length && !languages.length) {
      wrap.hidden = true;
      return wrap;
    }
    if (languages.length) {
      wrap.append(renderFacetRow("语种", languageFacetItems(languages), state.language, (id) => {
        updateListParams({ language: id, artistId: "", albumId: "", genre: "", mode: "library" });
      }));
    }
    if (genres.length) {
      wrap.append(renderFacetRow("风格", genreFacetItems(genres), state.genre, (id) => {
        updateListParams({ genre: id, albumId: "", mode: "library" });
      }));
    }
    if (artists.length) {
      wrap.append(renderFacetRow("歌手", artistFacetItems(artists), state.artistId, (id) => {
        updateListParams({ artistId: id, albumId: "", mode: "library" });
      }));
    }
    if (albums.length) {
      wrap.append(renderFacetRow("专辑", albumFacetItems(albums), state.albumId, (id) => {
        updateListParams({ albumId: id, mode: "library" });
      }));
    }
    return wrap;
  }

  function renderFacetRow(label, items, activeId, onSelect) {
    const row = document.createElement("div");
    row.className = "music-mobile-facet-row";
    const title = document.createElement("strong");
    title.textContent = label;
    const scroller = document.createElement("div");
    scroller.className = "music-mobile-facet-scroll";
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = item.id === activeId ? "active" : "";
      button.textContent = item.label;
      button.title = item.title || item.label;
      button.addEventListener("click", () => onSelect(item.id));
      scroller.append(button);
    }
    row.append(title, scroller);
    return row;
  }

  function artistFacetItems(artists = []) {
    return [
      { id: "", label: "全部歌手", title: "全部歌手" },
      ...prioritizedFacetItems(artists, state.artistId, 18).map((artist) => ({
        id: artist.id || "",
        label: artist.name || "未知歌手",
        title: `${artist.name || "未知歌手"} · ${formatNumber(artist.trackCount || 0)} 首`
      }))
    ];
  }

  function languageFacetItems(languages = []) {
    return [
      { id: "", label: "全部语种", title: "全部语种" },
      ...languages.map((language) => ({
        id: language.name || language.id || "",
        label: language.name || "其他",
        title: `${language.name || "其他"} · ${formatNumber(language.trackCount || 0)} 首`
      }))
    ];
  }

  function genreFacetItems(genres = []) {
    return [
      { id: "", label: "全部风格", title: "全部风格" },
      ...prioritizedFacetItems(genres, state.genre, 18).map((genre) => ({
        id: genre.name || genre.id || "",
        label: genre.name || "未知风格",
        title: `${genre.name || "未知风格"} · ${formatNumber(genre.trackCount || 0)} 首`
      }))
    ];
  }

  function albumFacetItems(albums = []) {
    return [
      { id: "", label: "全部专辑", title: "全部专辑" },
      ...prioritizedFacetItems(albums, state.albumId, 18).map((album) => ({
        id: album.id || "",
        label: album.title || "未知专辑",
        title: [album.title || "未知专辑", album.artistName || "", `${formatNumber(album.trackCount || 0)} 首`].filter(Boolean).join(" · ")
      }))
    ];
  }

  function prioritizedFacetItems(items = [], activeId = "", limit = 18) {
    const clean = (Array.isArray(items) ? items : []).filter((item) => item?.id);
    if (!activeId) return clean.slice(0, limit);
    const selected = clean.find((item) => item.id === activeId);
    const rest = clean.filter((item) => item.id !== activeId).slice(0, Math.max(0, limit - (selected ? 1 : 0)));
    return selected ? [selected, ...rest] : rest;
  }

  function renderArtistBrowser() {
    const section = document.createElement("section");
    section.className = "music-mobile-artist-browser";

    const languages = document.createElement("div");
    languages.className = "music-mobile-artist-languages";
    const languageItems = [{ name: "", label: "全部", artistCount: state.summary?.totals?.artists || 0 }, ...(state.summary?.languages || state.data?.languages || []).map((item) => ({ ...item, label: item.name }))];
    for (const language of languageItems) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = state.language === language.name ? "active" : "";
      button.textContent = `${language.label} ${formatNumber(language.artistCount || 0)}`;
      button.addEventListener("click", () => updateListParams({ mode: "artists", language: language.name, query: "" }, { resetSearch: true }));
      languages.append(button);
    }

    const grid = document.createElement("div");
    grid.className = "music-mobile-artist-grid";
    const artists = Array.isArray(state.data?.artists) ? state.data.artists : [];
    if (state.loading && !artists.length) {
      grid.append(messageBox("正在读取歌手资料库"));
    } else if (!artists.length) {
      grid.append(messageBox(state.status || "没有匹配的歌手"));
    } else {
      artists.forEach((artist) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "music-mobile-artist-card";
        const avatar = document.createElement("b");
        avatar.textContent = Array.from(artist.name || "?")[0] || "?";
        const text = document.createElement("span");
        const name = document.createElement("strong");
        name.textContent = artist.name || "未知歌手";
        const meta = document.createElement("small");
        meta.textContent = `${artist.language || "其他"} · ${formatNumber(artist.trackCount || 0)} 首 · ${formatNumber(artist.albumCount || 0)} 专辑`;
        text.append(name, meta);
        button.append(avatar, text);
        button.addEventListener("click", () => updateListParams({
          mode: "library",
          artistId: artist.id,
          albumId: "",
          genre: "",
          language: artist.language || "",
          query: ""
        }, { resetSearch: true }));
        grid.append(button);
      });
    }

    if (state.hasMore) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "music-mobile-load-more";
      more.textContent = state.loadingMore ? "正在加载…" : `加载更多（已显示 ${formatNumber(artists.length)} 位）`;
      more.disabled = state.loadingMore;
      more.addEventListener("click", () => loadMoreTracks().catch(() => {}));
      grid.append(more);
    }

    section.append(languages, grid);
    return section;
  }

  function renderAlbumBrowser() {
    const section = document.createElement("section");
    section.className = "music-mobile-artist-browser music-mobile-album-browser";

    const languages = document.createElement("div");
    languages.className = "music-mobile-artist-languages";
    const languageItems = [{ name: "", label: "全部", albumCount: state.summary?.totals?.albums || 0 }, ...(state.summary?.languages || state.data?.languages || []).map((item) => ({ ...item, label: item.name }))];
    for (const language of languageItems) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = state.language === language.name ? "active" : "";
      button.textContent = `${language.label} ${formatNumber(language.albumCount || 0)}`;
      button.addEventListener("click", () => updateListParams({ mode: "albums", language: language.name, query: "" }, { resetSearch: true }));
      languages.append(button);
    }

    const grid = document.createElement("div");
    grid.className = "music-mobile-album-grid";
    const albums = Array.isArray(state.data?.albums) ? state.data.albums : [];
    if (state.loading && !albums.length) {
      grid.append(messageBox("正在读取专辑资料库"));
    } else if (!albums.length) {
      grid.append(messageBox(state.status || "没有匹配的专辑"));
    } else {
      albums.forEach((album) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "music-mobile-album-card";
        button.append(renderCover(album, "tiny"));
        const text = document.createElement("span");
        const name = document.createElement("strong");
        name.textContent = album.title || "未知专辑";
        const meta = document.createElement("small");
        meta.textContent = [album.artistName || "未知歌手", album.year || "", `${formatNumber(album.trackCount || 0)} 首`].filter(Boolean).join(" · ");
        text.append(name, meta);
        button.append(text);
        button.addEventListener("click", () => updateListParams({
          mode: "library",
          artistId: album.artistId || "",
          albumId: album.id,
          genre: "",
          language: state.language,
          query: ""
        }, { resetSearch: true }));
        grid.append(button);
      });
    }

    if (state.hasMore) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "music-mobile-load-more";
      more.textContent = state.loadingMore ? "正在加载…" : `加载更多（已显示 ${formatNumber(albums.length)} 张）`;
      more.disabled = state.loadingMore;
      more.addEventListener("click", () => loadMoreTracks().catch(() => {}));
      grid.append(more);
    }

    section.append(languages, grid);
    return section;
  }

  function renderTrackList(options = {}) {
    const wrap = document.createElement("div");
    wrap.className = "music-mobile-list";
    const tracks = Array.isArray(options.tracks) ? options.tracks : state.data?.tracks || [];
    const versionGroups = Array.isArray(options.versionGroups) ? options.versionGroups : null;
    const showLoadMore = options.showLoadMore !== false;
    if (state.loading && !tracks.length) {
      wrap.append(messageBox("正在读取音乐库"));
      return wrap;
    }
    if (!tracks.length) {
      wrap.append(messageBox(state.status || emptyMessage()));
      return wrap;
    }
    if (versionGroups) {
      versionGroups.forEach((group, index) => wrap.append(
        group.tracks?.length > 1 ? renderSearchTrackVersionGroup(group, index) : renderTrackRow(group.primary, index)
      ));
    } else {
      tracks.forEach((track, index) => wrap.append(renderTrackRow(track, index)));
    }
    if (showLoadMore && state.hasMore) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "music-mobile-load-more";
      more.textContent = state.loadingMore ? "正在加载…" : `加载更多（已显示 ${formatNumber(tracks.length)} 首）`;
      more.disabled = state.loadingMore;
      more.addEventListener("click", () => loadMoreTracks().catch(() => {}));
      wrap.append(more);
    }
    return wrap;
  }

  function renderSearchTrackVersionGroup(group, index) {
    const expanded = state.searchExpandedVersionGroups.has(group.key);
    const section = document.createElement("section");
    section.className = `music-mobile-search-track-version-group${expanded ? " is-expanded" : ""}`;
    section.dataset.trackVersionGroup = group.key;
    section.append(renderTrackRow(group.primary, index, { versionGroup: group, versionExpanded: expanded }));
    if (expanded) {
      const list = document.createElement("div");
      list.className = "music-mobile-search-version-list";
      for (const track of group.tracks || []) list.append(renderSearchVersionChoice(track, group));
      section.append(list);
    }
    return section;
  }

  function toggleSearchTrackVersionGroup(key) {
    const groupKey = String(key || "").trim();
    if (!groupKey) return;
    if (state.searchExpandedVersionGroups.has(groupKey)) state.searchExpandedVersionGroups.delete(groupKey);
    else state.searchExpandedVersionGroups.add(groupKey);
    refreshMountedSearchUi();
  }

  function renderTrackRow(track, index, options = {}) {
    const versionGroup = options.versionGroup;
    const versionCount = Number(versionGroup?.tracks?.length || 0);
    const preferredVersion = versionCount > 1 ? preferredTrackForVersionGroup(versionGroup, track) : track;
    const isCurrent = state.current?.id === track.id
      || (versionCount > 1 && versionGroup.tracks.some((item) => item.id === state.current?.id));
    const isPlaying = isCurrent && state.playing;
    const row = document.createElement("div");
    row.className = `music-mobile-track${isCurrent ? " active" : ""}${isPlaying ? " playing" : ""}`;
    row.dataset.trackId = track.id || "";
    row.dataset.trackIndex = String(index);
    if (isCurrent) row.dataset.current = "true";
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `播放 ${preferredVersion?.title || track.title || "歌曲"}${versionCount > 1 ? `，包含 ${versionCount} 个版本` : Number(track.duplicateCount || 0) > 1 ? `，已合并 ${track.duplicateCount} 个相同文件` : ""}`);
    const number = document.createElement("span");
    number.className = "music-mobile-track-index";
    if (isPlaying) {
      number.append(renderPlayingBars());
    } else {
      number.textContent = String(index + 1).padStart(2, "0");
    }
    const cover = renderCover(track, "tiny");
    const text = document.createElement("span");
    text.className = "music-mobile-track-text";
    const titleLine = document.createElement("span");
    titleLine.className = "music-mobile-track-title-line";
    const title = document.createElement("strong");
    appendSearchHighlightedText(title, track.title || "未知歌曲", track, "title");
    titleLine.append(title);
    if (state.query) {
      const reason = document.createElement("em");
      reason.className = "music-mobile-track-match";
      reason.textContent = trackSearchMatchLabel(track, state.query);
      titleLine.append(reason);
    }
    const meta = document.createElement("small");
    [
      { value: track.artist || "未知歌手", highlight: true },
      { value: track.album || "未知专辑", highlight: true },
      { value: ratingLabel(track.rating), highlight: false },
      { value: versionCount > 1 ? [`${formatNumber(versionCount)} 个版本`, versionGroupPreferenceLabel(versionGroup)].filter(Boolean).join(" · ") : Number(track.duplicateCount || 0) > 1 ? `${formatNumber(track.duplicateCount)} 个来源` : "", highlight: false }
    ].filter((item) => item.value).forEach((item, itemIndex) => {
      if (itemIndex) meta.append(document.createTextNode(" · "));
      if (item.highlight) appendSearchHighlightedText(meta, item.value, track, itemIndex === 0 ? "artist" : "album");
      else meta.append(document.createTextNode(item.value));
    });
    text.append(titleLine, meta);
    const side = document.createElement("span");
    side.className = "music-mobile-track-side";
    const inlineActions = document.createElement("span");
    inlineActions.className = "music-mobile-track-actions";
    const playNext = iconButton("下", (event) => {
      event.stopPropagation();
      queueTrackNext(track);
    }, false, "track-queue", "下一首播放");
    inlineActions.append(playNext);
    const enqueue = iconButton("+", (event) => {
      event.stopPropagation();
      appendTrackToQueue(track);
    }, false, "track-queue", "加入队列");
    inlineActions.append(enqueue);
    if (state.mode === "playlist" && state.playlistId) {
      const remove = iconButton("−", (event) => {
        event.stopPropagation();
        removeTrackFromCurrentPlaylist(track.id).catch(() => {});
      }, false, "track-remove", "移出歌单");
      inlineActions.append(remove);
    }
    if (versionCount > 1) {
      const versions = document.createElement("button");
      versions.type = "button";
      versions.className = "music-mobile-search-version-toggle";
      versions.textContent = options.versionExpanded ? "收起版本" : `${formatNumber(versionCount)} 个版本`;
      versions.setAttribute("aria-expanded", options.versionExpanded ? "true" : "false");
      versions.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleSearchTrackVersionGroup(versionGroup.key);
      });
      inlineActions.append(versions);
    } else {
      const favorite = iconButton(track.favorite ? "已收藏" : "收藏", (event) => {
        event.stopPropagation();
        toggleFavorite(track.id).catch(() => {});
      }, false, `track-label track-favorite${track.favorite ? " active" : ""}`, track.favorite ? "取消收藏" : "收藏");
      inlineActions.append(favorite);
    }
    const more = iconButton("更多", (event) => {
      event.stopPropagation();
      openTrackActions(track.id);
    }, false, "track-label track-more", `更多操作：${track.title || "歌曲"}`);
    inlineActions.append(more);
    const duration = document.createElement("small");
    duration.textContent = formatClock(track.durationMs || 0);
    side.append(inlineActions, duration);
    row.append(number, cover, text, side);
    const play = () => {
      if (versionCount > 1) {
        playSearchTrackVersion(preferredVersion, versionGroup.tracks);
        return;
      }
      activateSearchResultQueue(track.id);
      openTrack(track.id, { autoplay: true }).catch(() => {});
    };
    row.addEventListener("click", play);
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      play();
    });
    return row;
  }

  function activateSearchResultQueue(trackId) {
    if (!state.query || state.mode !== "library") return;
    const tracks = Array.isArray(state.data?.tracks) ? state.data.tracks : [];
    if (!tracks.some((item) => item.id === trackId)) return;
    state.queue = preferredSearchQueue(tracks);
  }

  function playSearchResults() {
    const tracks = Array.isArray(state.data?.tracks) ? state.data.tracks : [];
    const queue = preferredSearchQueue(tracks);
    if (!queue.length) return;
    state.queue = queue;
    openTrack(queue[0].id, { autoplay: true }).catch(() => {});
  }

  function shuffleSearchResults() {
    const tracks = Array.isArray(state.data?.tracks) ? state.data.tracks : [];
    const queue = shuffleTrackQueue(preferredSearchQueue(tracks));
    if (!queue.length) return;
    state.queue = queue;
    openTrack(queue[0].id, { autoplay: true }).catch(() => {});
  }

  function preferredSearchQueue(tracks = state.data?.tracks, selectedTrack = null) {
    const seen = new Set();
    return currentSearchVersionGroups(tracks)
      .map((group) => group.tracks?.some((track) => track.id === selectedTrack?.id)
        ? selectedTrack
        : preferredTrackForVersionGroup(group, group.primary))
      .filter((track) => track?.id && !seen.has(track.id) && seen.add(track.id))
      .map((track) => ({ ...track }));
  }

  function renderMiniPlayer() {
    const track = state.current || state.queue[0] || null;
    const player = document.createElement("section");
    player.className = "music-mobile-mini-player";
    player.dataset.trackKey = miniPlayerTrackKey(track);
    let swiped = false;
    player.addEventListener("click", (event) => {
      if (event.target?.closest?.("button,input,label")) return;
      if (swiped) return;
      openFullscreen();
    });
    attachMiniPlayerSwipe(player, () => {
      swiped = true;
      window.setTimeout(() => {
        swiped = false;
      }, 260);
    });

    player.append(renderCover(track || { title: "音乐" }, "bar"));
    const text = document.createElement("span");
    text.className = "music-mobile-mini-text";
    const title = document.createElement("strong");
    title.textContent = track?.title || "未播放";
    const meta = document.createElement("small");
    meta.textContent = track ? trackMeta(track) : "从列表选择歌曲";
    text.append(title, meta);

    const play = iconButton(playIcon(Boolean(state.current && !audio?.paused)), () => togglePlayback(), !track, "primary", playLabel(Boolean(state.current && !audio?.paused)));
    const next = iconButton("›", () => playAdjacent(1).catch(() => {}), !track, "", "下一首");
    const queue = iconButton("≡", openQueueFromMini, !track, "ghost", "播放队列");
    const progress = renderProgress("mini", track, play);
    player.append(text, play, next, queue, progress);
    return player;
  }

  function miniPlayerTrackKey(track) {
    if (!track) return "";
    return [track.id || "", track.coverUrl || "", track.album || "", track.title || "", track.artist || ""].join("\u0001");
  }

  function updateMountedMiniPlayerTrack() {
    const player = els.viewContent?.querySelector(".music-mobile-mini-player");
    if (!player) return;
    const track = state.current || state.queue[0] || null;
    const nextKey = miniPlayerTrackKey(track);
    if (player.dataset.trackKey !== nextKey) {
      player.querySelector(":scope > .music-mobile-cover")?.replaceWith(renderCover(track || { title: "音乐" }, "bar"));
      player.dataset.trackKey = nextKey;
    }
    const text = player.querySelector(".music-mobile-mini-text");
    const title = text?.querySelector("strong");
    const meta = text?.querySelector("small");
    if (title) title.textContent = track?.title || "未播放";
    if (meta) meta.textContent = track ? trackMeta(track) : "从列表选择歌曲";
  }

  function attachMiniPlayerSwipe(player, markSwiped) {
    let startX = 0;
    let startY = 0;
    let startedOnControl = false;
    player.addEventListener("touchstart", (event) => {
      const touch = event.touches?.[0];
      if (!touch) return;
      startedOnControl = Boolean(event.target?.closest?.("button,input,label"));
      startX = touch.clientX;
      startY = touch.clientY;
    }, { passive: true });
    player.addEventListener("touchend", (event) => {
      if (startedOnControl) return;
      const touch = event.changedTouches?.[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      const horizontal = Math.abs(dx) >= 58 && Math.abs(dx) > Math.abs(dy) * 1.35;
      const upward = dy <= -48 && Math.abs(dy) > Math.abs(dx) * 1.2;
      if (!horizontal && !upward) return;
      markSwiped();
      if (horizontal) {
        playAdjacent(dx < 0 ? 1 : -1).catch(() => {});
        return;
      }
      openFullscreen();
    }, { passive: true });
  }

  function renderFullPlayer() {
    const track = state.current || state.queue[0] || null;
    const full = document.createElement("section");
    const panel = normalizeFullPanel(state.fullPanel, track);
    state.fullPanel = panel;
    full.className = `music-mobile-full-player is-${panel}`;
    full.setAttribute("role", "dialog");
    full.setAttribute("aria-modal", "true");
    full.setAttribute("aria-label", "音乐播放");
    full.append(renderFullBackdrop(track));

    const top = document.createElement("div");
    top.className = "music-mobile-full-top";
    const close = iconButton("‹", closeFullscreen, false, "ghost", "返回列表");
    const heading = document.createElement("span");
    const title = document.createElement("strong");
    title.className = "music-mobile-full-title";
    title.textContent = track?.title || "未播放";
    const meta = document.createElement("small");
    meta.textContent = track ? [track.artist || "未知歌手", track.album || "未知专辑"].join(" · ") : "从列表选择歌曲";
    heading.append(title, meta);
    const topActions = document.createElement("span");
    topActions.className = "music-mobile-full-actions";
    const favorite = iconButton(track?.favorite ? "♥" : "♡", () => toggleFavorite(track.id).catch(() => {}), !track, track?.favorite ? "active" : "ghost", track?.favorite ? "取消收藏" : "收藏");
    const addToList = iconButton("+", () => {
      state.playlistSheetOpen = !state.playlistSheetOpen;
      state.queueOpen = false;
      state.sleepSheetOpen = false;
      renderShell();
    }, !track, state.playlistSheetOpen ? "active" : "ghost", "加入歌单");
    const download = iconButton("↓", () => downloadTrack(track), !track?.downloadUrl, "ghost", "下载原文件");
    const sleep = iconButton("⏱", () => {
      state.sleepSheetOpen = !state.sleepSheetOpen;
      state.queueOpen = false;
      state.playlistSheetOpen = false;
      renderShell();
    }, !track && !sleepTimerActive(), state.sleepSheetOpen || sleepTimerActive() ? "active" : "ghost", sleepTimerActive() ? `定时关闭：${sleepTimerText()}后暂停` : "定时关闭");
    topActions.append(favorite, addToList, download, sleep);
    top.append(close, heading, topActions);
    attachFullscreenDismissSwipe(top);

    const switcher = renderFullPanelSwitch(track, panel);
    const stage = document.createElement("div");
    stage.className = "music-mobile-full-stage";
    stage.append(panel === "lyrics" ? renderFullLyricsPanel(track) : renderFullCoverPanel(track));
    attachFullPanelSwipe(stage, track);

    const controls = document.createElement("div");
    controls.className = "music-mobile-full-controls";
    const shuffle = iconButton("⤨", () => {
      state.shuffle = !state.shuffle;
      writeShufflePreference(state.shuffle);
      scheduleGaplessPreload();
      renderShell();
    }, false, state.shuffle ? "active" : "ghost", "随机播放");
    const prev = iconButton("‹", () => playAdjacent(-1).catch(() => {}), !track, "ghost", "上一首");
    const play = iconButton(playIcon(Boolean(track && !audio?.paused)), () => togglePlayback(), !track, "primary large", playLabel(Boolean(track && !audio?.paused)));
    const next = iconButton("›", () => playAdjacent(1).catch(() => {}), !track, "ghost", "下一首");
    const repeat = iconButton(repeatIcon(state.repeat), () => {
      state.repeat = nextRepeat(state.repeat);
      writeRepeatPreference(state.repeat);
      scheduleGaplessPreload();
      renderShell();
    }, false, state.repeat === "none" ? "ghost" : "active", repeatLabel(state.repeat));
    const queue = iconButton("≡", () => {
      state.queueOpen = !state.queueOpen;
      state.playlistSheetOpen = false;
      state.sleepSheetOpen = false;
      renderShell();
    }, !state.queue.length, state.queueOpen ? "active" : "ghost", "播放队列");
    controls.append(shuffle, prev, play, next, repeat, queue);

    const progress = renderProgress("full", track, play);
    full.append(top, switcher, stage, progress, renderPlaybackSettings(track), controls);
    if (state.queueOpen || state.playlistSheetOpen || state.sleepSheetOpen) full.append(renderSheetBackdrop());
    if (state.queueOpen) {
      full.append(renderQueueSheet());
      scheduleActiveQueueScroll();
    }
    if (state.playlistSheetOpen) full.append(renderPlaylistSheet());
    if (state.sleepSheetOpen) full.append(renderSleepTimerSheet());
    if (hasLyrics()) window.requestAnimationFrame(() => updateLyricHighlight(true));
    return full;
  }

  function renderFullBackdrop(track) {
    const backdrop = document.createElement("div");
    backdrop.className = "music-mobile-full-backdrop";
    backdrop.setAttribute("aria-hidden", "true");
    if (track?.coverUrl) {
      const img = document.createElement("img");
      img.src = absoluteUrl(getActiveUrl(), track.coverUrl);
      img.alt = "";
      img.loading = "eager";
      img.decoding = "async";
      backdrop.append(img);
    }
    return backdrop;
  }

  function renderSheetBackdrop() {
    const backdrop = document.createElement("button");
    backdrop.type = "button";
    backdrop.className = "music-mobile-sheet-backdrop";
    backdrop.setAttribute("aria-label", "关闭弹层");
    backdrop.addEventListener("click", () => closeOpenSheet());
    return backdrop;
  }

  function renderFullPanelSwitch(track, activePanel) {
    const switcher = document.createElement("div");
    switcher.className = "music-mobile-full-switch";
    for (const [panel, label] of [
      ["lyrics", "歌词"],
      ["cover", "封面"]
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = panel === activePanel ? "active" : "";
      button.textContent = label;
      button.disabled = !track;
      button.setAttribute("aria-pressed", panel === activePanel ? "true" : "false");
      button.addEventListener("click", () => {
        switchFullPanel(panel);
      });
      switcher.append(button);
    }
    return switcher;
  }

  function attachFullPanelSwipe(stage, track) {
    if (!track) return;
    let startX = 0;
    let startY = 0;
    stage.addEventListener("touchstart", (event) => {
      const touch = event.touches?.[0];
      if (!touch) return;
      startX = touch.clientX;
      startY = touch.clientY;
    }, { passive: true });
    stage.addEventListener("touchend", (event) => {
      const touch = event.changedTouches?.[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (Math.abs(dx) < 54 || Math.abs(dx) < Math.abs(dy) * 1.35) return;
      switchFullPanel(dx < 0 ? "cover" : "lyrics");
    }, { passive: true });
  }

  function attachFullscreenDismissSwipe(target) {
    let startX = 0;
    let startY = 0;
    target.addEventListener("touchstart", (event) => {
      const touch = event.touches?.[0];
      if (!touch) return;
      startX = touch.clientX;
      startY = touch.clientY;
    }, { passive: true });
    target.addEventListener("touchend", (event) => {
      const touch = event.changedTouches?.[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (dy < 70 || Math.abs(dx) > dy * 0.75) return;
      closeFullscreen();
    }, { passive: true });
  }

  function attachSheetDismissSwipe(target) {
    let startX = 0;
    let startY = 0;
    target.addEventListener("touchstart", (event) => {
      const touch = event.touches?.[0];
      if (!touch) return;
      startX = touch.clientX;
      startY = touch.clientY;
    }, { passive: true });
    target.addEventListener("touchend", (event) => {
      const touch = event.changedTouches?.[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (dy < 58 || Math.abs(dx) > dy * 0.85) return;
      closeOpenSheet();
    }, { passive: true });
  }

  function renderSheetHandle() {
    const handle = document.createElement("div");
    handle.className = "music-mobile-sheet-handle";
    handle.setAttribute("aria-hidden", "true");
    attachSheetDismissSwipe(handle);
    return handle;
  }

  function switchFullPanel(panel) {
    const next = normalizeFullPanel(panel, state.current || state.queue[0] || null);
    if (state.fullPanel === next) return;
    state.fullPanel = next;
    if (next === "lyrics") state.lyricFollowPaused = false;
    renderShell();
    if (next === "lyrics") updateLyricHighlight(true);
  }

  function renderFullCoverPanel(track) {
    const coverStage = document.createElement("div");
    coverStage.className = "music-mobile-full-cover-stage";
    coverStage.append(renderCover(track || { title: "音乐" }, "cover"));

    const lyricPeek = renderCoverLyricPeek(track);
    const rating = renderRatingControl(track);
    const panel = document.createElement("div");
    panel.className = "music-mobile-full-cover-panel";
    panel.append(coverStage, lyricPeek, rating);
    return panel;
  }

  function renderCoverLyricPeek(track) {
    const peek = document.createElement("button");
    peek.type = "button";
    peek.className = "music-mobile-cover-lyric";
    peek.disabled = !track || !hasLyrics();
    peek.setAttribute("aria-label", "打开完整歌词");
    peek.addEventListener("click", () => switchFullPanel("lyrics"));

    const current = document.createElement("strong");
    const next = document.createElement("small");
    const pair = lyricPair(currentLyricIndex);
    current.textContent = pair.current || (track && hasLyrics() ? "歌词准备中" : "暂无歌词");
    next.textContent = pair.next || trackMeta(track || {});
    peek.append(current, next);
    return peek;
  }

  function renderFullLyricsPanel(track) {
    const lyrics = document.createElement("div");
    lyrics.className = "music-mobile-full-lyrics";
    const lines = document.createElement("div");
    lines.className = "music-mobile-full-lyric-lines";
    const lyricLines = state.lyrics?.lines || [];
    if (!track) {
      lines.append(lyricLine("选择歌曲后显示歌词"));
    } else if (!lyricLines.length) {
      lines.append(lyricLine("暂无歌词"));
    } else {
      lyricLines.slice(0, 180).forEach((line, index) => {
        const p = lyricLine(line.text || "", { seekMs: line.timeMs || 0 });
        p.dataset.index = String(index);
        p.dataset.timeMs = String(line.timeMs || 0);
        lines.append(p);
      });
    }
    const follow = document.createElement("button");
    follow.type = "button";
    follow.className = `music-mobile-lyric-follow${state.lyricFollowPaused ? " visible" : ""}`;
    follow.textContent = "回到当前";
    follow.addEventListener("click", () => resumeLyricFollow());
    if (track && lyricLines.length) {
      const pauseFollow = () => pauseLyricFollow(follow);
      lines.addEventListener("touchstart", pauseFollow, { passive: true });
      lines.addEventListener("wheel", pauseFollow, { passive: true });
    }
    lyrics.append(lines);
    if (track && lyricLines.length) lyrics.append(follow);
    return lyrics;
  }

  function renderQueueSheet() {
    const sheet = document.createElement("section");
    sheet.className = "music-mobile-queue-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-label", "播放队列");

    const head = document.createElement("div");
    head.className = "music-mobile-queue-head";
    const title = document.createElement("strong");
    title.textContent = "播放队列";
    const meta = document.createElement("small");
    meta.textContent = `${formatNumber(state.queue.length || 0)} 首`;
    const actions = document.createElement("span");
    actions.className = "music-mobile-queue-head-actions";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "music-mobile-text-button";
    save.textContent = "存歌单";
    save.disabled = !state.queue.length;
    save.addEventListener("click", () => saveQueueAsPlaylist().catch(() => {}));
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "music-mobile-text-button danger";
    clear.textContent = "清空";
    clear.disabled = queueRemovableCount() <= 0;
    clear.addEventListener("click", () => clearQueueExceptCurrent());
    actions.append(meta, save, clear);
    const close = iconButton("×", () => {
      state.queueOpen = false;
      renderShell();
    }, false, "ghost", "关闭队列");
    head.append(title, actions, close);
    attachSheetDismissSwipe(head);

    const list = document.createElement("div");
    list.className = "music-mobile-queue-list";
    if (!state.queue.length) {
      list.append(messageBox("队列里还没有歌曲"));
    } else {
      state.queue.forEach((track, index) => list.append(renderQueueItem(track, index)));
    }

    sheet.append(renderSheetHandle(), head, list);
    return sheet;
  }

  function renderPlaylistSheet() {
    const sheet = document.createElement("section");
    sheet.className = "music-mobile-queue-sheet music-mobile-playlist-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-label", "加入歌单");

    const head = document.createElement("div");
    head.className = "music-mobile-queue-head";
    const title = document.createElement("strong");
    title.textContent = "加入歌单";
    const create = document.createElement("button");
    create.type = "button";
    create.className = "music-mobile-text-button";
    create.textContent = "新建";
    create.addEventListener("click", () => createPlaylistFromPrompt({ addCurrent: true }).catch(() => {}));
    const close = iconButton("×", () => {
      state.playlistSheetOpen = false;
      renderShell();
    }, false, "ghost", "关闭");
    head.append(title, create, close);
    attachSheetDismissSwipe(head);

    const list = document.createElement("div");
    list.className = "music-mobile-queue-list";
    const items = Array.isArray(state.playlists) ? state.playlists : [];
    if (!items.length) {
      const empty = document.createElement("button");
      empty.type = "button";
      empty.className = "music-mobile-playlist-choice empty";
      empty.textContent = "新建歌单并加入当前歌曲";
      empty.addEventListener("click", () => createPlaylistFromPrompt({ addCurrent: true }).catch(() => {}));
      list.append(empty);
    } else {
      for (const item of items) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "music-mobile-playlist-choice";
        row.addEventListener("click", () => addCurrentToPlaylist(item.id).catch(() => {}));
        const name = document.createElement("strong");
        name.textContent = item.name || "未命名歌单";
        const meta = document.createElement("small");
        meta.textContent = `${formatNumber(item.trackCount || 0)} 首`;
        row.append(name, meta);
        list.append(row);
      }
    }

    sheet.append(renderSheetHandle(), head, list);
    return sheet;
  }

  function renderSleepTimerSheet() {
    const sheet = document.createElement("section");
    sheet.className = "music-mobile-queue-sheet music-mobile-sleep-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-label", "定时关闭");

    const head = document.createElement("div");
    head.className = "music-mobile-queue-head";
    const title = document.createElement("strong");
    title.textContent = "定时关闭";
    const meta = document.createElement("small");
    meta.textContent = sleepTimerActive() ? sleepTimerText() : "未开启";
    const close = iconButton("×", () => {
      state.sleepSheetOpen = false;
      renderShell();
    }, false, "ghost", "关闭定时选择");
    head.append(title, meta, close);
    attachSheetDismissSwipe(head);

    const list = document.createElement("div");
    list.className = "music-mobile-queue-list music-mobile-sleep-list";
    for (const minutes of SLEEP_TIMER_OPTIONS) {
      const row = document.createElement("button");
      row.type = "button";
      row.disabled = minutes === SLEEP_AFTER_CURRENT && !state.current;
      row.className = `music-mobile-sleep-choice${sleepTimerActive() && state.sleepMinutes === minutes ? " active" : ""}`;
      row.addEventListener("click", () => {
        state.sleepSheetOpen = false;
        setSleepTimer(minutes);
      });
      const label = document.createElement("strong");
      label.textContent = sleepOptionLabel(minutes);
      const metaText = document.createElement("small");
      metaText.textContent = minutes === SLEEP_AFTER_CURRENT
        ? !state.current
          ? "需要先播放一首歌"
          : state.sleepMinutes === minutes
            ? "当前歌曲结束后暂停"
            : "不再自动播放下一首"
        : sleepTimerActive() && state.sleepMinutes === minutes
          ? `剩余 ${sleepTimerText()}`
          : "到点暂停";
      row.append(label, metaText);
      list.append(row);
    }

    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "music-mobile-sleep-choice danger";
    clear.disabled = !sleepTimerActive();
    clear.addEventListener("click", () => {
      state.sleepSheetOpen = false;
      setSleepTimer(0);
    });
    const clearLabel = document.createElement("strong");
    clearLabel.textContent = "关闭定时";
    const clearMeta = document.createElement("small");
    clearMeta.textContent = sleepTimerActive() ? "取消睡眠定时" : "未开启";
    clear.append(clearLabel, clearMeta);
    list.append(clear);

    sheet.append(renderSheetHandle(), head, list);
    return sheet;
  }

  function openTrackActions(trackId) {
    const id = String(trackId || "").trim();
    if (!id || !trackForActions(id)) return;
    els.viewContent?.querySelector(".music-mobile-search-input")?.blur();
    state.trackActionId = id;
    state.settingsOpen = false;
    renderShell();
  }

  function closeTrackActions() {
    if (!state.trackActionId) return false;
    state.trackActionId = "";
    renderShell();
    return true;
  }

  function trackForActions(trackId = state.trackActionId) {
    const id = String(trackId || "").trim();
    if (!id) return null;
    return [state.current, ...(state.data?.tracks || []), ...(state.queue || [])]
      .find((track) => track?.id === id) || null;
  }

  function renderTrackActionsBackdrop() {
    const backdrop = document.createElement("button");
    backdrop.type = "button";
    backdrop.className = "music-mobile-settings-backdrop music-mobile-track-actions-backdrop";
    backdrop.setAttribute("aria-label", "关闭歌曲操作");
    backdrop.addEventListener("click", closeTrackActions);
    return backdrop;
  }

  function renderTrackActionsSheet() {
    const track = trackForActions();
    const sheet = document.createElement("section");
    sheet.className = "music-mobile-settings-sheet music-mobile-track-actions-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", `歌曲操作：${track?.title || "歌曲"}`);

    const head = document.createElement("div");
    head.className = "music-mobile-track-actions-head";
    head.append(renderCover(track || { title: "音乐" }, "tiny"));
    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = track?.title || "未知歌曲";
    const meta = document.createElement("small");
    meta.textContent = track ? trackMeta(track) : "歌曲不可用";
    text.append(title, meta);
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "完成";
    close.addEventListener("click", closeTrackActions);
    head.append(text, close);

    const actions = document.createElement("div");
    actions.className = "music-mobile-track-actions-grid";
    if (track) {
      actions.append(trackActionChoice("立即播放", "用这首歌替换当前播放位置。", () => {
        state.trackActionId = "";
        activateSearchResultQueue(track.id);
        openTrack(track.id, { autoplay: true }).catch(() => {});
      }));
      actions.append(trackActionChoice("下一首播放", "插入到当前歌曲后面。", () => {
        state.trackActionId = "";
        queueTrackNext(track);
      }));
      actions.append(trackActionChoice("加入队列", "保留当前顺序并放到队尾。", () => {
        state.trackActionId = "";
        appendTrackToQueue(track);
      }));
      actions.append(trackActionChoice("加入歌单", "保存到已有歌单或新建歌单。", () => {
        state.trackActionId = "";
        state.playlistActionTrackId = track.id;
        renderShell();
      }));
      actions.append(trackActionChoice(track.favorite ? "取消收藏" : "收藏歌曲", track.favorite ? "从收藏列表移除。" : "以后可以从收藏快速找到。", () => {
        state.trackActionId = "";
        toggleFavorite(track.id).catch(() => {});
      }, { active: track.favorite }));
      if (track.artistId) actions.append(trackActionChoice("查看歌手", track.artist || "打开歌手页面。", () => {
        state.trackActionId = "";
        updateListParams({ mode: "library", artistId: track.artistId, albumId: "", genre: "", query: "" }, { resetSearch: true });
      }));
      if (track.albumId) actions.append(trackActionChoice("查看专辑", track.album || "打开专辑页面。", () => {
        state.trackActionId = "";
        updateListParams({ mode: "library", albumId: track.albumId, artistId: track.artistId || "", genre: "", query: "" }, { resetSearch: true });
      }));
      if (track.downloadUrl) actions.append(trackActionChoice("保存原文件", formatBytes(track.sizeBytes || 0), () => {
        state.trackActionId = "";
        downloadTrack(track);
        renderShell();
      }));
      if (state.mode === "playlist" && state.playlistId) actions.append(trackActionChoice("移出当前歌单", "不会删除本地音乐文件。", () => {
        state.trackActionId = "";
        removeTrackFromCurrentPlaylist(track.id).catch(() => {});
      }, { danger: true }));
    }
    sheet.append(renderSheetHandle(), head, actions);
    return sheet;
  }

  function trackActionChoice(label, description, action, options = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `music-mobile-track-action-choice${options.active ? " active" : ""}${options.danger ? " danger" : ""}`;
    const title = document.createElement("strong");
    title.textContent = label;
    const meta = document.createElement("small");
    meta.textContent = description;
    button.append(title, meta);
    button.addEventListener("click", action);
    return button;
  }

  function closePlaylistActions() {
    if (!state.playlistActionTrackId) return false;
    state.playlistActionTrackId = "";
    renderShell();
    return true;
  }

  function renderPlaylistActionsBackdrop() {
    const backdrop = document.createElement("button");
    backdrop.type = "button";
    backdrop.className = "music-mobile-settings-backdrop music-mobile-track-actions-backdrop";
    backdrop.setAttribute("aria-label", "关闭加入歌单");
    backdrop.addEventListener("click", closePlaylistActions);
    return backdrop;
  }

  function renderPlaylistActionsSheet() {
    const track = trackForActions(state.playlistActionTrackId);
    const sheet = document.createElement("section");
    sheet.className = "music-mobile-settings-sheet music-mobile-playlist-actions-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", `加入歌单：${track?.title || "歌曲"}`);

    const head = document.createElement("div");
    head.className = "music-mobile-track-actions-head";
    head.append(renderCover(track || { title: "音乐" }, "tiny"));
    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = "加入歌单";
    const meta = document.createElement("small");
    meta.textContent = track?.title || "选择保存位置";
    text.append(title, meta);
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "完成";
    close.addEventListener("click", closePlaylistActions);
    head.append(text, close);

    const list = document.createElement("div");
    list.className = "music-mobile-playlist-action-list";
    const create = document.createElement("button");
    create.type = "button";
    create.className = "music-mobile-playlist-action-choice create";
    const createTitle = document.createElement("strong");
    createTitle.textContent = "新建歌单";
    const createMeta = document.createElement("small");
    createMeta.textContent = "创建后立即加入这首歌";
    create.append(createTitle, createMeta);
    create.addEventListener("click", () => createPlaylistFromPrompt({ addTrackId: track?.id }).catch(() => {}));
    list.append(create);
    for (const playlist of state.playlists || []) {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.className = "music-mobile-playlist-action-choice";
      const name = document.createElement("strong");
      name.textContent = playlist.name || "未命名歌单";
      const count = document.createElement("small");
      count.textContent = `${formatNumber(playlist.trackCount || 0)} 首`;
      choice.append(name, count);
      choice.addEventListener("click", () => addTrackToPlaylist(playlist.id, track?.id).catch(() => {}));
      list.append(choice);
    }
    sheet.append(renderSheetHandle(), head, list);
    return sheet;
  }

  function renderSettingsBackdrop() {
    const backdrop = document.createElement("button");
    backdrop.type = "button";
    backdrop.className = "music-mobile-settings-backdrop";
    backdrop.setAttribute("aria-label", "关闭音乐设置");
    backdrop.addEventListener("click", closeSettings);
    return backdrop;
  }

  function renderSettingsSheet() {
    const sheet = document.createElement("section");
    sheet.className = "music-mobile-settings-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", "音乐设置");

    const head = document.createElement("div");
    head.className = "music-mobile-settings-head";
    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = "播放设置";
    const meta = document.createElement("small");
    meta.textContent = "衔接、声音、搜索与播放现场";
    text.append(title, meta);
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "完成";
    close.addEventListener("click", closeSettings);
    head.append(text, close);

    const summary = renderSettingsTransitionSummary();

    const transition = document.createElement("section");
    transition.className = "music-mobile-settings-group";
    transition.append(settingsGroupTitle("歌曲衔接"), renderSettingsTransitionPresets());
    const gapless = document.createElement("button");
    gapless.type = "button";
    gapless.className = `music-mobile-settings-switch${state.gapless ? " active" : ""}`;
    gapless.setAttribute("role", "switch");
    gapless.setAttribute("aria-checked", state.gapless ? "true" : "false");
    gapless.textContent = state.gapless ? (state.shuffle ? "随机时暂停" : "已开启") : "已关闭";
    gapless.addEventListener("click", () => setGaplessPlayback(!state.gapless));
    transition.append(settingsRow(
      "无缝播放",
      "由预载播放器直接接管下一首，自动切歌时减少停顿；随机播放时暂停预载，少数格式可能不生效。",
      gapless
    ));

    const crossfade = document.createElement("select");
    crossfade.setAttribute("aria-label", "歌曲交叉淡化时长");
    for (const seconds of CROSSFADE_SECONDS_OPTIONS) {
      const option = document.createElement("option");
      option.value = String(seconds);
      option.textContent = seconds ? `${seconds} 秒` : "关闭";
      crossfade.append(option);
    }
    crossfade.value = String(state.crossfadeSeconds);
    crossfade.addEventListener("change", () => setCrossfadeSeconds(Number(crossfade.value || 0)));
    transition.append(settingsRow(
      "歌曲交叉淡化",
      state.shuffle
        ? "随机播放时暂停预载；关闭随机播放后自动恢复。"
        : "在上一首结束前启动下一首并平滑交接；开启后会自动关闭无缝播放。",
      crossfade
    ));

    const fade = document.createElement("select");
    fade.setAttribute("aria-label", "淡入淡出时长");
    for (const seconds of FADE_SECONDS_OPTIONS) {
      const option = document.createElement("option");
      option.value = String(seconds);
      option.textContent = seconds ? `${seconds} 秒` : "关闭";
      fade.append(option);
    }
    fade.value = String(state.fadeSeconds);
    fade.addEventListener("change", () => setFadeSeconds(Number(fade.value || 0)));
    transition.append(settingsRow(
      "播放 / 暂停淡化",
      "播放和暂停时平滑调整音量，避免声音突然出现或消失。",
      fade
    ));

    const playback = document.createElement("section");
    playback.className = "music-mobile-settings-group";
    playback.append(settingsGroupTitle("播放偏好"));
    playback.append(settingsRow("播放音量", "只调整应用内音乐音量，系统媒体音量不变。", renderSettingsVolumeControl()));
    const speed = document.createElement("select");
    speed.setAttribute("aria-label", "默认播放速度");
    for (const value of PLAYBACK_SPEED_OPTIONS) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = playbackSpeedLabel(value);
      speed.append(option);
    }
    speed.value = String(state.playbackSpeed);
    speed.addEventListener("change", () => setPlaybackSpeed(Number(speed.value || 1)));
    playback.append(settingsRow("播放速度", "新打开的歌曲沿用此速度。", speed));

    const repeat = document.createElement("select");
    repeat.setAttribute("aria-label", "默认循环方式");
    for (const [value, label] of [["all", "列表循环"], ["one", "单曲循环"], ["none", "顺序播放"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      repeat.append(option);
    }
    repeat.value = state.repeat;
    repeat.addEventListener("change", () => {
      state.repeat = repeat.value;
      writeRepeatPreference(state.repeat);
      scheduleGaplessPreload();
    });
    playback.append(settingsRow("循环方式", "自动切歌时使用的默认队列策略。", repeat));

    const shuffle = document.createElement("button");
    shuffle.type = "button";
    shuffle.className = `music-mobile-settings-switch${state.shuffle ? " active" : ""}`;
    shuffle.setAttribute("role", "switch");
    shuffle.setAttribute("aria-checked", state.shuffle ? "true" : "false");
    shuffle.textContent = state.shuffle ? "已开启" : "已关闭";
    shuffle.addEventListener("click", () => {
      state.shuffle = !state.shuffle;
      writeShufflePreference(state.shuffle);
      scheduleGaplessPreload();
      renderShell();
    });
    playback.append(settingsRow("随机播放", "从队列随机选择下一首；开启后会暂停无缝预载。", shuffle));

    const resumeQueue = document.createElement("button");
    resumeQueue.type = "button";
    resumeQueue.className = `music-mobile-settings-switch${state.resumeQueue ? " active" : ""}`;
    resumeQueue.setAttribute("role", "switch");
    resumeQueue.setAttribute("aria-checked", state.resumeQueue ? "true" : "false");
    resumeQueue.textContent = state.resumeQueue ? "已开启" : "已关闭";
    resumeQueue.addEventListener("click", () => {
      state.resumeQueue = !state.resumeQueue;
      writeResumeQueuePreference(state.resumeQueue);
      if (state.resumeQueue) rememberPlaybackQueue();
      else clearPlaybackQueuePreference();
      renderShell();
    });
    playback.append(settingsRow("恢复播放现场", "下次打开时恢复当前歌曲、播放位置和整理过的队列。", resumeQueue));

    const sleepTimer = document.createElement("button");
    sleepTimer.type = "button";
    sleepTimer.className = "music-mobile-settings-action";
    sleepTimer.textContent = sleepTimerActive() ? sleepTimerText() : "设置";
    sleepTimer.addEventListener("click", () => {
      state.settingsOpen = false;
      state.fullscreen = true;
      state.sleepSheetOpen = true;
      state.queueOpen = false;
      state.playlistSheetOpen = false;
      renderShell();
    });
    playback.append(settingsRow(
      "睡眠定时",
      "可以按时间暂停，也可以让当前歌曲完整播完后停止，不再自动切到下一首。",
      sleepTimer
    ));

    const searchVersions = document.createElement("section");
    searchVersions.className = "music-mobile-settings-group";
    searchVersions.append(settingsGroupTitle("搜索与版本"));

    const versionStrategy = document.createElement("select");
    versionStrategy.setAttribute("aria-label", "默认播放版本策略");
    for (const [value, label] of VERSION_STRATEGY_OPTIONS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      versionStrategy.append(option);
    }
    versionStrategy.value = state.versionStrategy;
    versionStrategy.addEventListener("change", () => setVersionStrategy(versionStrategy.value));
    searchVersions.append(settingsRow(
      "默认播放版本",
      versionStrategyDescription(state.versionStrategy),
      versionStrategy
    ));

    const rememberVersions = document.createElement("button");
    rememberVersions.type = "button";
    rememberVersions.className = `music-mobile-settings-switch${state.rememberVersionChoices ? " active" : ""}`;
    rememberVersions.setAttribute("role", "switch");
    rememberVersions.setAttribute("aria-checked", state.rememberVersionChoices ? "true" : "false");
    rememberVersions.textContent = state.rememberVersionChoices ? "已开启" : "已关闭";
    rememberVersions.addEventListener("click", () => setRememberVersionChoices(!state.rememberVersionChoices));
    searchVersions.append(settingsRow(
      "记住版本选择",
      "同一首歌有原版、Live 或 Remix 时，下次搜索会默认播放你上次选择的版本。",
      rememberVersions
    ));

    const preferenceCount = activeVersionPreferenceCount();
    const clearVersions = document.createElement("button");
    clearVersions.type = "button";
    clearVersions.className = "music-mobile-settings-action";
    clearVersions.textContent = preferenceCount ? `清除 ${formatNumber(preferenceCount)} 首` : "暂无记录";
    clearVersions.disabled = preferenceCount < 1;
    clearVersions.addEventListener("click", clearActiveVersionPreferences);
    searchVersions.append(settingsRow(
      "版本偏好",
      preferenceCount ? `当前音乐服务已记住 ${formatNumber(preferenceCount)} 首歌，可随时恢复为全局策略。` : "选择具体版本后会显示在这里。",
      clearVersions
    ));

    const note = document.createElement("p");
    note.className = "music-mobile-settings-note";
    note.textContent = "这些设置只保存在当前手机，不会修改电脑端音乐文件。";
    sheet.append(renderSheetHandle(), head, summary, transition, playback, searchVersions, note);
    return sheet;
  }

  function setRememberVersionChoices(enabled) {
    state.rememberVersionChoices = Boolean(enabled);
    writeRememberVersionChoicesPreference(state.rememberVersionChoices);
    state.status = state.rememberVersionChoices ? "已开启版本选择记忆" : "已暂停版本选择记忆";
    renderShell();
  }

  function setVersionStrategy(value) {
    state.versionStrategy = normalizeVersionStrategy(value);
    writeVersionStrategyPreference(state.versionStrategy);
    state.status = `默认播放版本已设为${versionStrategyLabel(state.versionStrategy)}`;
    const select = els.viewContent?.querySelector('select[aria-label="默认播放版本策略"]');
    const description = select?.closest(".music-mobile-settings-row")?.querySelector("small");
    if (description) description.textContent = versionStrategyDescription(state.versionStrategy);
  }

  function activeVersionPreferenceCount() {
    const prefix = `${String(getActiveUrl() || "").replace(/\/+$/u, "")}|`;
    return Object.keys(state.versionPreferences || {}).filter((key) => prefix !== "|" && key.startsWith(prefix)).length;
  }

  function clearActiveVersionPreferences() {
    const prefix = `${String(getActiveUrl() || "").replace(/\/+$/u, "")}|`;
    if (prefix === "|") return;
    const next = Object.fromEntries(Object.entries(state.versionPreferences || {}).filter(([key]) => !key.startsWith(prefix)));
    state.versionPreferences = next;
    writeVersionPreferencesPreference(next);
    state.status = "已清除当前音乐服务的版本偏好";
    renderShell();
  }

  function renderSettingsTransitionSummary() {
    const summary = document.createElement("section");
    summary.className = "music-mobile-settings-summary";
    const eyebrow = document.createElement("small");
    eyebrow.textContent = "当前衔接方式";
    const title = document.createElement("strong");
    title.textContent = state.shuffle
      ? "随机播放 · 衔接预载暂停"
      : state.crossfadeSeconds > 0
        ? `歌曲交叉淡化 · ${state.crossfadeSeconds} 秒`
        : state.gapless
          ? "无缝播放"
          : "标准切歌";
    const meta = document.createElement("span");
    meta.textContent = state.shuffle
      ? "关闭随机播放后，会继续使用你保存的衔接方式。"
      : state.crossfadeSeconds > 0
        ? "两首歌会短暂重叠，切换更柔和。"
        : state.gapless
          ? "提前准备下一首，优先减少歌曲间停顿。"
          : "每首歌独立结束后再开始下一首。";
    summary.append(eyebrow, title, meta);
    return summary;
  }

  function renderSettingsTransitionPresets() {
    const wrap = document.createElement("div");
    wrap.className = "music-mobile-settings-transition-presets";
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", "歌曲衔接模式");
    const activeMode = currentPlaybackTransitionMode();
    for (const item of [
      { mode: "standard", label: "标准", meta: "独立切歌" },
      { mode: "gapless", label: "无缝", meta: "提前预载" },
      { mode: "smooth", label: "柔和", meta: "重叠淡化" }
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = item.mode === activeMode ? "active" : "";
      button.dataset.transitionMode = item.mode;
      button.setAttribute("aria-pressed", item.mode === activeMode ? "true" : "false");
      const label = document.createElement("strong");
      label.textContent = item.label;
      const meta = document.createElement("small");
      meta.textContent = item.meta;
      button.append(label, meta);
      button.addEventListener("click", () => setPlaybackTransitionMode(item.mode));
      wrap.append(button);
    }
    return wrap;
  }

  function currentPlaybackTransitionMode() {
    if (state.crossfadeSeconds > 0) return "smooth";
    return state.gapless ? "gapless" : "standard";
  }

  function settingsGroupTitle(label) {
    const title = document.createElement("strong");
    title.className = "music-mobile-settings-group-title";
    title.textContent = label;
    return title;
  }

  function renderSettingsVolumeControl() {
    const control = document.createElement("label");
    control.className = "music-mobile-settings-volume";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.step = "1";
    slider.value = String(Math.round(state.volume * 100));
    slider.setAttribute("aria-label", "播放音量");
    const value = document.createElement("span");
    value.textContent = `${slider.value}%`;
    slider.addEventListener("input", () => {
      value.textContent = `${slider.value}%`;
      setVolume(Number(slider.value || 0) / 100);
    });
    control.append(slider, value);
    return control;
  }

  function settingsRow(label, description, control) {
    const row = document.createElement("div");
    row.className = "music-mobile-settings-row";
    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = label;
    const meta = document.createElement("small");
    meta.textContent = description;
    text.append(title, meta);
    row.append(text, control);
    return row;
  }

  function renderQueueItem(track, index) {
    const active = state.current?.id === track.id;
    const row = document.createElement("div");
    row.className = `music-mobile-queue-item${active ? " active" : ""}`;
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    row.setAttribute("aria-label", `播放 ${track.title || "歌曲"}`);
    const number = document.createElement("span");
    number.className = "music-mobile-queue-index";
    if (active && state.playing) {
      number.append(renderPlayingBars());
    } else {
      number.textContent = String(index + 1).padStart(2, "0");
    }
    if (active) row.dataset.current = "true";
    const text = document.createElement("span");
    text.className = "music-mobile-queue-text";
    const title = document.createElement("strong");
    title.textContent = track.title || "未知歌曲";
    const meta = document.createElement("small");
    meta.textContent = trackMeta(track);
    text.append(title, meta);
    const duration = document.createElement("small");
    duration.className = "music-mobile-queue-duration";
    duration.textContent = formatClock(track.durationMs || 0);
    const actions = document.createElement("span");
    actions.className = "music-mobile-queue-actions";
    actions.append(
      queueActionButton("↑", "上移", () => moveQueueTrack(track.id, -1), index <= 0),
      queueActionButton("↓", "下移", () => moveQueueTrack(track.id, 1), index >= state.queue.length - 1),
      queueActionButton("×", "移出队列", () => removeTrackFromQueue(track.id), active)
    );
    row.append(number, text, duration, actions);
    const play = () => {
      if (active) {
        state.queueOpen = false;
        renderShell();
        return;
      }
      openTrack(track.id, { autoplay: true }).catch(() => {});
    };
    row.addEventListener("click", play);
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      play();
    });
    return row;
  }

  function queueActionButton(label, ariaLabel, action, disabled = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `music-mobile-queue-action${disabled ? " disabled" : ""}`;
    button.textContent = label;
    button.disabled = disabled;
    button.setAttribute("aria-label", ariaLabel);
    button.title = ariaLabel;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (disabled) return;
      action();
    });
    return button;
  }

  function renderProgress(kind, track, playButton = null) {
    const progressWrap = document.createElement("label");
    progressWrap.className = `music-mobile-progress ${kind}`;
    progressWrap.setAttribute("aria-label", "播放进度");
    const current = document.createElement("span");
    current.textContent = "0:00";
    const progress = document.createElement("input");
    progress.type = "range";
    progress.min = "0";
    progress.max = "1000";
    progress.value = "0";
    progress.disabled = !track;
    progress.addEventListener("input", () => {
      if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
      audio.currentTime = (Number(progress.value || 0) / 1000) * audio.duration;
      updatePlaybackUi();
    });
    const total = document.createElement("span");
    total.textContent = track ? formatClock(track.durationMs || 0) : "0:00";
    progressWrap.append(current, progress, total);
    bindProgress({ current, progress, total, playButton });
    return progressWrap;
  }

  function renderVolumeControl(track) {
    const wrap = document.createElement("label");
    wrap.className = "music-mobile-volume";
    wrap.setAttribute("aria-label", "音量");
    const icon = document.createElement("span");
    icon.textContent = state.volume <= 0 ? "静音" : "音量";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.value = String(Math.round(state.volume * 100));
    slider.disabled = !track;
    slider.addEventListener("input", () => setVolume(Number(slider.value || 0) / 100));
    const value = document.createElement("em");
    value.textContent = `${Math.round(state.volume * 100)}%`;
    slider.addEventListener("input", () => {
      value.textContent = `${Math.round(state.volume * 100)}%`;
      icon.textContent = state.volume <= 0 ? "静音" : "音量";
    });
    wrap.append(icon, slider, value);
    return wrap;
  }

  function renderPlaybackSettings(track) {
    const wrap = document.createElement("div");
    wrap.className = "music-mobile-playback-settings";
    wrap.append(renderPlaybackSpeedControl(track), renderVolumeControl(track));
    return wrap;
  }

  function renderPlaybackSpeedControl(track) {
    const wrap = document.createElement("label");
    wrap.className = "music-mobile-volume music-mobile-speed";
    wrap.setAttribute("aria-label", "播放速度");
    const label = document.createElement("span");
    label.textContent = "速度";
    const select = document.createElement("select");
    select.disabled = !track;
    for (const speed of PLAYBACK_SPEED_OPTIONS) {
      const option = document.createElement("option");
      option.value = String(speed);
      option.textContent = playbackSpeedLabel(speed);
      select.append(option);
    }
    select.value = String(normalizePlaybackSpeed(state.playbackSpeed));
    select.addEventListener("change", () => setPlaybackSpeed(Number(select.value || 1)));
    const value = document.createElement("em");
    value.textContent = playbackSpeedLabel(state.playbackSpeed);
    select.addEventListener("change", () => {
      value.textContent = playbackSpeedLabel(state.playbackSpeed);
    });
    wrap.append(label, select, value);
    return wrap;
  }

  function bindProgress(binding) {
    progressBindings.push(binding);
  }

  function lyricLine(text, options = {}) {
    const canSeek = Object.prototype.hasOwnProperty.call(options, "seekMs");
    const p = canSeek ? document.createElement("button") : document.createElement("p");
    if (canSeek) {
      p.type = "button";
      p.className = "music-mobile-lyric-line";
      p.addEventListener("click", () => seekToLyric(options.seekMs));
    }
    p.textContent = text;
    return p;
  }

  function renderPlayingBars() {
    const bars = document.createElement("span");
    bars.className = "music-mobile-playing-bars";
    bars.setAttribute("aria-label", "正在播放");
    for (let index = 0; index < 3; index += 1) {
      bars.append(document.createElement("i"));
    }
    return bars;
  }

  function renderCover(item = {}, size = "") {
    const cover = document.createElement("span");
    cover.className = `music-mobile-cover ${size}`.trim();
    if (item?.coverUrl) {
      const img = document.createElement("img");
      img.src = absoluteUrl(getActiveUrl(), item.coverUrl);
      img.alt = item.album || item.title || "专辑封面";
      img.loading = size === "cover" ? "eager" : "lazy";
      img.decoding = "async";
      cover.append(img);
    } else {
      cover.textContent = initials(item?.album || item?.title || item?.artist || "音乐");
    }
    return cover;
  }

  function iconButton(label, action, disabled = false, kind = "", ariaLabel = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `music-mobile-icon-button${kind ? ` ${kind}` : ""}`;
    button.textContent = label;
    button.disabled = disabled;
    button.setAttribute("aria-label", ariaLabel || label);
    if (ariaLabel) button.title = ariaLabel;
    button.addEventListener("click", action);
    return button;
  }

  function renderRatingControl(track) {
    const rating = Math.max(0, Math.min(5, Number(track?.rating || 0)));
    const wrap = document.createElement("div");
    wrap.className = "music-mobile-rating";
    wrap.setAttribute("aria-label", track ? `评分：${rating || "未评分"}` : "评分");
    for (let value = 1; value <= 5; value += 1) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = value <= rating ? "★" : "☆";
      button.className = value <= rating ? "active" : "";
      button.disabled = !track;
      const nextRating = value === rating ? 0 : value;
      button.setAttribute("aria-label", nextRating ? `设为 ${value} 星` : "清除评分");
      button.addEventListener("click", () => setTrackRating(track.id, nextRating).catch(() => {}));
      wrap.append(button);
    }
    return wrap;
  }

  function pill(text) {
    const span = document.createElement("span");
    span.className = "music-mobile-pill";
    span.textContent = text;
    return span;
  }

  function appendSearchHighlightedText(target, value, item, field) {
    appendHighlightedText(target, value, effectiveSearchQuery(), item?.searchMatch?.highlights?.[field]);
  }

  function effectiveSearchQuery() {
    return String(state.data?.correctedQuery || state.searchOverview?.correctedQuery || state.query || "").trim();
  }

  function appendHighlightedText(target, value, query, highlightTerms = []) {
    const text = String(value || "");
    const needle = String(query || "").trim();
    const terms = [...new Set([
      ...((Array.isArray(highlightTerms) ? highlightTerms : []).map((item) => String(item || "").trim())),
      needle
    ].filter(Boolean))].sort((left, right) => right.length - left.length);
    if (!terms.length) {
      target.textContent = text;
      return;
    }
    const lower = text.toLocaleLowerCase();
    const ranges = [];
    for (const term of terms) {
      const search = term.toLocaleLowerCase();
      let cursor = 0;
      let index = lower.indexOf(search, cursor);
      while (index >= 0) {
        ranges.push([index, index + term.length]);
        cursor = index + Math.max(1, term.length);
        index = lower.indexOf(search, cursor);
      }
    }
    if (!ranges.length) {
      target.textContent = text;
      return;
    }
    ranges.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
    const merged = [];
    for (const range of ranges) {
      const previous = merged[merged.length - 1];
      if (!previous || range[0] > previous[1]) merged.push([...range]);
      else previous[1] = Math.max(previous[1], range[1]);
    }
    let cursor = 0;
    for (const [start, end] of merged) {
      if (start > cursor) target.append(document.createTextNode(text.slice(cursor, start)));
      const mark = document.createElement("mark");
      mark.textContent = text.slice(start, end);
      target.append(mark);
      cursor = end;
    }
    if (cursor < text.length) target.append(document.createTextNode(text.slice(cursor)));
  }

  function normalizeSearchComparison(value) {
    return String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
  }

  function messageBox(message) {
    const box = document.createElement("div");
    const isError = /失败|超时|错误|不可用|阻止/.test(String(state.status || ""));
    box.className = isError ? "message-box error" : "message-box quiet";
    box.textContent = message;
    return box;
  }

  function closeSearch() {
    window.clearTimeout(searchDebounceTimer);
    window.clearTimeout(searchSuggestionTimer);
    searchSuggestionController?.abort();
    mountedSearchController?.abort();
    state.searchSuggestions = [];
    state.searchSuggestionQuery = "";
    state.searchSuggestionIndex = -1;
    state.searchSuggestionLoading = false;
    state.searchOpen = false;
    state.searchScope = "all";
    updateListParams({
      mode: "library",
      query: "",
      favorite: false,
      artistId: "",
      albumId: ""
    }, { resetSearch: true });
  }

  function scheduleLiveSearch(value) {
    window.clearTimeout(searchDebounceTimer);
    const query = String(value || "").trim();
    const clear = els.viewContent?.querySelector(".music-mobile-search-clear");
    if (clear) clear.hidden = !query;
    scheduleSearchSuggestions(query);
    searchDebounceTimer = window.setTimeout(() => commitMusicSearch(query, { preserveSuggestions: true }), SEARCH_DEBOUNCE_MS);
  }

  function commitMusicSearch(value, options = {}) {
    window.clearTimeout(searchDebounceTimer);
    if (!options.preserveSuggestions) {
      window.clearTimeout(searchSuggestionTimer);
      searchSuggestionController?.abort();
    }
    const query = String(value || "").trim();
    if (options.remember && query) rememberSearchQuery(query);
    if (options.remember) {
      const input = els.viewContent?.querySelector(".music-mobile-search-input");
      if (input && input.value !== query) input.value = query;
    }
    state.searchOpen = true;
    state.mode = ["artists", "albums"].includes(state.mode) ? state.mode : "library";
    state.searchScope = state.mode === "artists" ? "artists" : state.mode === "albums" ? "albums" : state.searchScope;
    state.favorite = false;
    state.artistId = "";
    state.albumId = "";
    state.genre = "";
    state.language = "";
    state.searchSuggestionQuery = query;
    refreshMountedSearchResults(query).catch(() => {});
  }

  function scheduleSearchSuggestions(value) {
    window.clearTimeout(searchSuggestionTimer);
    searchSuggestionController?.abort();
    const query = String(value || "").trim();
    state.searchSuggestionQuery = query;
    state.searchSuggestionIndex = -1;
    if (!query) {
      state.searchSuggestions = [];
      state.searchSuggestionLoading = false;
      refreshMountedSearchSuggestions();
      return;
    }
    state.searchSuggestions = [];
    state.searchSuggestionLoading = true;
    refreshMountedSearchSuggestions();
    searchSuggestionTimer = window.setTimeout(() => loadSearchSuggestions(query).catch(() => {}), SEARCH_SUGGESTION_DEBOUNCE_MS);
  }

  async function loadSearchSuggestions(query) {
    const controller = new AbortController();
    searchSuggestionController = controller;
    const params = new URLSearchParams({ q: query });
    try {
      const data = await fetchJson(getActiveUrl(), `/api/music/suggest?${params}`, { timeoutMs: 8000, signal: controller.signal });
      if (controller.signal.aborted || state.searchSuggestionQuery !== query) return;
      state.searchSuggestions = buildSearchSuggestions(query, data);
      state.searchSuggestionLoading = false;
      refreshMountedSearchSuggestions();
    } catch {
      if (controller.signal.aborted || state.searchSuggestionQuery !== query) return;
      state.searchSuggestions = buildSearchSuggestions(query, null);
      state.searchSuggestionLoading = false;
      refreshMountedSearchSuggestions();
    }
  }

  function handleSearchSuggestionKeydown(event, input) {
    const suggestions = state.searchSuggestions || [];
    if (["ArrowDown", "ArrowUp"].includes(event.key) && suggestions.length) {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const current = Number(state.searchSuggestionIndex);
      state.searchSuggestionIndex = current < 0
        ? (direction > 0 ? 0 : suggestions.length - 1)
        : (current + direction + suggestions.length) % suggestions.length;
      refreshMountedSearchSuggestions();
      return;
    }
    if (event.key === "Escape" && (suggestions.length || state.searchSuggestionLoading)) {
      event.preventDefault();
      event.stopPropagation();
      searchSuggestionController?.abort();
      state.searchSuggestions = [];
      state.searchSuggestionIndex = -1;
      state.searchSuggestionLoading = false;
      refreshMountedSearchSuggestions();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const selected = suggestions[state.searchSuggestionIndex];
    if (selected) {
      activateSearchSuggestion(selected);
      return;
    }
    state.searchSuggestions = [];
    state.searchSuggestionIndex = -1;
    state.searchSuggestionLoading = false;
    commitMusicSearch(input.value, { remember: true });
  }

  function buildSearchSuggestions(query, data) {
    const value = String(query || "").trim();
    if (!value) return [];
    const normalized = normalizeSearchComparison(value);
    const action = {
      group: "search",
      groupLabel: "搜索",
      type: "全部",
      value,
      label: `搜索“${value}”`,
      meta: "查看歌曲、歌词、歌手、专辑和歌单",
      highlights: [value],
      score: Number.MAX_SAFE_INTEGER
    };
    if (!data) return [action];

    const result = [action];
    const seenValues = new Set();
    const correctionTarget = searchSuggestionCorrectionTarget(data);
    if (data.correctedQuery && correctionTarget && normalizeSearchComparison(correctionTarget) !== normalized) {
      seenValues.add(normalizeSearchComparison(correctionTarget));
      result.push({
        group: "correction",
        groupLabel: "猜你想搜",
        type: "纠错",
        value: correctionTarget,
        label: correctionTarget,
        meta: `已识别“${value}”的相近结果`,
        highlights: [],
        score: Number.MAX_SAFE_INTEGER - 1
      });
    }

    const historyItems = (state.searchHistory || [])
      .filter((item) => {
        const itemValue = normalizeSearchComparison(item);
        return itemValue && itemValue !== normalized && (itemValue.includes(normalized) || normalized.includes(itemValue));
      })
      .slice(0, 2)
      .map((item) => ({
        group: "history",
        groupLabel: "最近搜索",
        type: "历史",
        value: item,
        meta: "再次搜索",
        highlights: [],
        score: 700 + Number(normalizeSearchComparison(item).startsWith(normalized)) * 300
      }));

    const entityGroups = [
      buildArtistSuggestionGroup(value, data.artists || [], seenValues),
      buildTrackSuggestionGroup(value, data.tracks || [], seenValues),
      buildAlbumSuggestionGroup(value, data.albums || [], seenValues),
      buildPlaylistSuggestionGroup(value, seenValues),
      suggestionGroupResult(historyItems, 4)
    ].filter((group) => group.items.length);
    entityGroups.sort((left, right) => right.score - left.score || left.priority - right.priority);
    let remaining = 8;
    for (const group of entityGroups) {
      const items = group.items.slice(0, remaining);
      result.push(...items);
      remaining -= items.length;
      if (remaining <= 0) break;
    }
    return result;
  }

  function searchSuggestionCorrectionTarget(data) {
    return String(data?.artists?.[0]?.name || buildTrackVersionGroups(data?.tracks || [])[0]?.baseTitle || data?.albums?.[0]?.title || data?.correctedQuery || "").trim();
  }

  function buildArtistSuggestionGroup(query, artists, seenValues) {
    const items = [];
    for (const artist of artists.slice(0, 3)) {
      const value = String(artist.name || "").trim();
      const key = normalizeSearchComparison(value);
      if (!value || seenValues.has(key)) continue;
      seenValues.add(key);
      items.push({
        group: "artists",
        groupLabel: "歌手",
        type: "歌手",
        value,
        meta: `${formatNumber(artist.trackCount || 0)} 首 · ${formatNumber(artist.albumCount || 0)} 专辑`,
        highlights: artist.searchMatch?.highlights?.name || [],
        score: searchSuggestionIntentScore(value, artist.searchMatch, "name", query)
      });
    }
    return suggestionGroupResult(items, 1);
  }

  function buildTrackSuggestionGroup(query, tracks, seenValues) {
    const items = [];
    for (const group of buildTrackVersionGroups(tracks).slice(0, 5)) {
      const best = [...(group.tracks || [])].sort((left, right) => searchSuggestionIntentScore(right.title, right.searchMatch, "title", query) - searchSuggestionIntentScore(left.title, left.searchMatch, "title", query))[0] || group.primary;
      const value = String(group.baseTitle || best?.title || "").trim();
      const key = normalizeSearchComparison(value);
      if (!value || seenValues.has(key)) continue;
      seenValues.add(key);
      items.push({
        group: "tracks",
        groupLabel: "歌曲",
        type: "歌曲",
        value,
        meta: [best?.artist || group.artist || "未知歌手", group.tracks.length > 1 ? `${formatNumber(group.tracks.length)} 个版本` : best?.album || "未知专辑"].filter(Boolean).join(" · "),
        highlights: best?.searchMatch?.highlights?.title || [],
        score: searchSuggestionIntentScore(value, best?.searchMatch, "title", query)
      });
    }
    return suggestionGroupResult(items, 0);
  }

  function buildAlbumSuggestionGroup(query, albums, seenValues) {
    const items = [];
    for (const album of albums.filter((item) => String(item.title || "").trim() !== "_单曲").slice(0, 3)) {
      const value = String(album.title || "").trim();
      const key = normalizeSearchComparison(value);
      if (!value || seenValues.has(key)) continue;
      seenValues.add(key);
      items.push({
        group: "albums",
        groupLabel: "专辑",
        type: "专辑",
        value,
        meta: album.artistName || "未知歌手",
        highlights: album.searchMatch?.highlights?.title || [],
        score: searchSuggestionIntentScore(value, album.searchMatch, "title", query)
      });
    }
    return suggestionGroupResult(items, 2);
  }

  function buildPlaylistSuggestionGroup(query, seenValues) {
    const items = [];
    for (const match of searchPlaylistMatches(query).slice(0, 3)) {
      const value = String(match.item?.name || "").trim();
      const key = normalizeSearchComparison(value);
      if (!value || seenValues.has(key)) continue;
      seenValues.add(key);
      items.push({
        group: "playlists",
        groupLabel: "歌单",
        type: match.kind === "smart" ? "智能歌单" : "歌单",
        value,
        meta: `${formatNumber(match.item?.trackCount || 0)} 首 · ${match.item?.description || (match.kind === "smart" ? "自动更新" : "我的歌单")}`,
        highlights: [query],
        score: match.score
      });
    }
    return suggestionGroupResult(items, 3);
  }

  function suggestionGroupResult(items, priority) {
    items.sort((left, right) => right.score - left.score);
    return { items, priority, score: Math.max(0, ...items.map((item) => item.score)) };
  }

  function searchSuggestionIntentScore(value, match, field, query) {
    const source = normalizeSearchComparison(value);
    const needle = normalizeSearchComparison(query);
    const direct = source === needle ? 10000 : source.startsWith(needle) ? 4000 : source.includes(needle) ? 2000 : 0;
    const fieldBoost = match?.field === field ? 600 : 0;
    return direct + fieldBoost + Number(match?.scores?.[field] || match?.score || 0);
  }

  function rememberSearchQuery(query) {
    const value = String(query || "").trim();
    if (!value) return;
    state.searchHistory = [value, ...state.searchHistory.filter((item) => item.toLocaleLowerCase() !== value.toLocaleLowerCase())]
      .slice(0, SEARCH_HISTORY_LIMIT);
    writeSearchHistoryPreference(state.searchHistory);
  }

  function clearSearchHistory() {
    state.searchHistory = [];
    writeSearchHistoryPreference([]);
    refreshMountedSearchUi();
  }

  function removeSearchHistoryQuery(query) {
    const value = String(query || "").trim().toLocaleLowerCase();
    state.searchHistory = state.searchHistory.filter((item) => item.toLocaleLowerCase() !== value);
    writeSearchHistoryPreference(state.searchHistory);
    refreshMountedSearchUi();
  }

  function openSettings() {
    state.trackActionId = "";
    state.playlistActionTrackId = "";
    state.settingsOpen = true;
    renderShell();
  }

  function closeSettings() {
    if (!state.settingsOpen) return false;
    state.settingsOpen = false;
    renderShell();
    return true;
  }

  function openFullscreen() {
    state.fullPanel = hasLyrics() ? "lyrics" : "cover";
    state.lyricFollowPaused = false;
    state.fullscreen = true;
    renderShell();
  }

  function openQueueFromMini() {
    state.fullPanel = hasLyrics() ? state.fullPanel : "cover";
    state.lyricFollowPaused = false;
    state.fullscreen = true;
    state.queueOpen = true;
    state.playlistSheetOpen = false;
    state.sleepSheetOpen = false;
    renderShell();
  }

  function locateCurrentTrack() {
    if (!state.current) return;
    if (revealCurrentTrack()) return;
    state.pendingCurrentReveal = true;
    updateListParams({
      mode: "library",
      favorite: false,
      query: "",
      smartId: "",
      playlistId: "",
      artistId: "",
      albumId: "",
      genre: ""
    }, { resetSearch: true });
  }

  function revealCurrentTrack() {
    const row = els.viewContent?.querySelector(".music-mobile-list .music-mobile-track.active");
    if (!row) return false;
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    row.classList.remove("locating");
    window.requestAnimationFrame(() => row.classList.add("locating"));
    window.setTimeout(() => row.classList.remove("locating"), 1400);
    return true;
  }

  function schedulePendingCurrentReveal() {
    state.pendingCurrentReveal = false;
    window.setTimeout(() => {
      window.requestAnimationFrame(() => {
        if (!revealCurrentTrack()) {
          state.status = "当前歌曲不在当前列表";
          els.viewMeta.textContent = state.status;
        }
      });
    }, 520);
  }

  function closeFullscreen() {
    if (closePlaylistActions()) return true;
    if (closeTrackActions()) return true;
    if (closeSettings()) return true;
    if (state.sleepSheetOpen) {
      state.sleepSheetOpen = false;
      renderShell();
      return true;
    }
    if (state.playlistSheetOpen) {
      state.playlistSheetOpen = false;
      renderShell();
      return true;
    }
    if (state.queueOpen) {
      state.queueOpen = false;
      renderShell();
      return true;
    }
    if (!state.fullscreen) return false;
    state.fullscreen = false;
    state.queueOpen = false;
    state.sleepSheetOpen = false;
    renderShell();
    return true;
  }

  function closeOpenSheet() {
    if (!state.queueOpen && !state.playlistSheetOpen && !state.sleepSheetOpen) return false;
    state.queueOpen = false;
    state.playlistSheetOpen = false;
    state.sleepSheetOpen = false;
    renderShell();
    return true;
  }

  function scheduleActiveQueueScroll() {
    window.requestAnimationFrame(() => {
      const active = els.viewContent.querySelector(".music-mobile-queue-sheet .music-mobile-queue-item.active");
      active?.scrollIntoView({ block: "center" });
    });
  }

  function togglePlayback() {
    ensureAudio();
    if (!state.current) {
      const first = state.queue[0];
      if (first) openTrack(first.id, { autoplay: true }).catch(() => {});
      return;
    }
    if (audio.paused) playAudio();
    else pauseAudio();
  }

  function playAudio() {
    ensureAudio();
    const target = audio;
    const shouldFade = state.fadeSeconds > 0 && target.paused;
    cancelAudioFade();
    target.volume = shouldFade ? 0 : state.volume;
    target.play().then(() => {
      if (shouldFade && target === audio) fadeAudioVolume(target, state.volume, state.fadeSeconds * 1000);
    }).catch((error) => {
      target.volume = state.volume;
      state.status = error?.message || "播放被系统阻止";
      renderShell();
    });
  }

  function pauseAudio(options = {}) {
    ensureAudio();
    cancelCrossfade();
    const target = audio;
    if (target.paused) return Promise.resolve();
    const duration = options.immediate ? 0 : state.fadeSeconds * 1000;
    if (duration <= 0) {
      cancelAudioFade();
      target.pause();
      target.volume = state.volume;
      return Promise.resolve();
    }
    return fadeAudioVolume(target, 0, duration).then((completed) => {
      if (!completed || target !== audio) return;
      target.pause();
      target.volume = state.volume;
    });
  }

  function fadeAudioVolume(target, toVolume, durationMs) {
    const token = ++audioFadeToken;
    const from = Number(target.volume || 0);
    const to = Math.max(0, Math.min(1, Number(toVolume || 0)));
    const duration = Math.max(0, Number(durationMs || 0));
    if (!duration || Math.abs(from - to) < 0.001) {
      target.volume = to;
      return Promise.resolve(true);
    }
    const startedAt = window.performance?.now?.() || Date.now();
    return new Promise((resolve) => {
      const step = (timestamp) => {
        if (token !== audioFadeToken || target !== audio) {
          resolve(false);
          return;
        }
        const elapsed = Math.max(0, Number(timestamp || Date.now()) - startedAt);
        const progress = Math.min(1, elapsed / duration);
        target.volume = from + ((to - from) * progress);
        if (progress >= 1) {
          resolve(true);
          return;
        }
        window.requestAnimationFrame(step);
      };
      window.requestAnimationFrame(step);
    });
  }

  function crossfadeAudioPair(outgoing, incoming, durationMs) {
    const token = ++crossfadeToken;
    const fromOutgoing = Math.max(0, Math.min(1, Number(outgoing?.volume || 0)));
    const toIncoming = Math.max(0, Math.min(1, Number(state.volume || 0)));
    const duration = Math.max(0, Number(durationMs || 0));
    if (!outgoing || !incoming || !duration) {
      if (incoming) incoming.volume = toIncoming;
      return Promise.resolve(false);
    }
    crossfadeOutgoingAudio = outgoing;
    incoming.volume = 0;
    document.body.dataset.musicTransition = "crossfade";
    const startedAt = window.performance?.now?.() || Date.now();
    return new Promise((resolve) => {
      const step = (timestamp) => {
        if (token !== crossfadeToken || audio !== incoming) {
          if (document.body.dataset.musicTransition === "crossfade") delete document.body.dataset.musicTransition;
          resolve(false);
          return;
        }
        const elapsed = Math.max(0, Number(timestamp || Date.now()) - startedAt);
        const progress = Math.min(1, elapsed / duration);
        outgoing.volume = fromOutgoing * (1 - progress);
        incoming.volume = toIncoming * progress;
        if (progress >= 1) {
          outgoing.volume = 0;
          incoming.volume = toIncoming;
          if (document.body.dataset.musicTransition === "crossfade") delete document.body.dataset.musicTransition;
          resolve(true);
          return;
        }
        window.requestAnimationFrame(step);
      };
      window.requestAnimationFrame(step);
    });
  }

  function cancelAudioFade() {
    audioFadeToken += 1;
  }

  function cancelCrossfade() {
    crossfadeToken += 1;
    const outgoing = crossfadeOutgoingAudio;
    crossfadeOutgoingAudio = null;
    if (document.body.dataset.musicTransition === "crossfade") delete document.body.dataset.musicTransition;
    retireAudioElement(outgoing);
    if (audio) audio.volume = state.volume;
  }

  function setVolume(value) {
    const next = Math.max(0, Math.min(1, Number(value || 0)));
    state.volume = Number.isFinite(next) ? next : 0.86;
    ensureAudio();
    cancelAudioFade();
    cancelCrossfade();
    audio.volume = state.volume;
    writeVolumePreference(state.volume);
  }

  function setPlaybackSpeed(value) {
    const speed = normalizePlaybackSpeed(value);
    state.playbackSpeed = speed;
    ensureAudio();
    audio.playbackRate = speed;
    if (gaplessPreloadAudio) gaplessPreloadAudio.playbackRate = speed;
    writePlaybackSpeedPreference(speed);
    updatePlaybackUi();
  }

  function setFadeSeconds(value) {
    const seconds = normalizeFadeSeconds(value);
    state.fadeSeconds = seconds;
    writeFadeSecondsPreference(seconds);
  }

  function setPlaybackTransitionMode(mode) {
    const nextMode = ["gapless", "smooth"].includes(String(mode || "")) ? String(mode) : "standard";
    state.gapless = nextMode === "gapless";
    state.crossfadeSeconds = nextMode === "smooth"
      ? (state.crossfadeSeconds > 0 ? state.crossfadeSeconds : 5)
      : 0;
    writeGaplessPreference(state.gapless);
    writeCrossfadeSecondsPreference(state.crossfadeSeconds);
    state.status = nextMode === "gapless"
      ? "已切换为无缝衔接"
      : nextMode === "smooth"
        ? `已切换为 ${state.crossfadeSeconds} 秒柔和衔接`
        : "已切换为标准衔接";
    if (nextMode === "standard") clearGaplessPreload();
    else scheduleGaplessPreload();
    renderShell();
  }

  function setCrossfadeSeconds(value) {
    const seconds = normalizeCrossfadeSeconds(value);
    state.crossfadeSeconds = seconds;
    writeCrossfadeSecondsPreference(seconds);
    if (seconds > 0 && state.gapless) {
      state.gapless = false;
      writeGaplessPreference(false);
    }
    scheduleGaplessPreload();
    renderShell();
  }

  function setGaplessPlayback(enabled) {
    state.gapless = Boolean(enabled);
    writeGaplessPreference(state.gapless);
    if (state.gapless && state.crossfadeSeconds > 0) {
      state.crossfadeSeconds = 0;
      writeCrossfadeSecondsPreference(0);
    }
    if (state.gapless) scheduleGaplessPreload();
    else clearGaplessPreload();
    renderShell();
  }

  function transitionPreloadEnabled() {
    return Boolean((state.gapless || state.crossfadeSeconds > 0) && !state.shuffle && !sleepAfterCurrentTimerActive());
  }

  function scheduleGaplessPreload() {
    if (!transitionPreloadEnabled() || !state.current || !state.queue.length || gaplessHandoffPending) {
      clearGaplessPreload();
      return;
    }
    const candidate = nextQueueCandidate();
    if (!candidate?.id || !candidate.streamUrl || candidate.id === state.current.id) {
      clearGaplessPreload();
      return;
    }
    if (gaplessPreloadAudio && gaplessPreloadTrackId === candidate.id) return;
    clearGaplessPreload();
    gaplessPreloadTrackId = candidate.id;
    gaplessPreloadAudio = new Audio();
    gaplessPreloadAudio.preload = "auto";
    gaplessPreloadAudio.volume = 0;
    gaplessPreloadAudio.playbackRate = state.playbackSpeed;
    gaplessPreloadAudio.src = absoluteUrl(getActiveUrl(), candidate.streamUrl);
    gaplessPreloadAudio.load();
  }

  function nextQueueCandidate() {
    if (!state.current || state.shuffle) return null;
    const queue = Array.isArray(state.queue) ? state.queue : [];
    const index = queue.findIndex((item) => item.id === state.current.id);
    if (index >= 0) return queue[index + 1] || (state.repeat === "all" ? queue[0] : null);
    return queue.find((item) => item.id === state.nextId) || null;
  }

  function maybePromoteGaplessPreload(target) {
    if (!transitionPreloadEnabled() || target !== audio || target.paused || !Number.isFinite(target.duration)) return false;
    const remaining = target.duration - target.currentTime;
    const handoffThreshold = state.crossfadeSeconds > 0 ? state.crossfadeSeconds : 0.18;
    if (remaining > handoffThreshold || remaining < 0) return false;
    return tryPromoteGaplessPreload({ crossfade: state.crossfadeSeconds > 0 });
  }

  function tryPromoteGaplessPreload(options = {}) {
    if (!transitionPreloadEnabled() || gaplessHandoffPending || !audio || !gaplessPreloadAudio) return false;
    const candidate = nextQueueCandidate();
    if (!candidate?.id || candidate.id !== gaplessPreloadTrackId) return false;
    if (options.candidateId && candidate.id !== options.candidateId) return false;
    const minimumReadyState = options.force ? 2 : 3;
    if (gaplessPreloadAudio.readyState < minimumReadyState) return false;

    const outgoing = audio;
    const incoming = gaplessPreloadAudio;
    const outgoingTrack = state.current;
    const crossfadeDurationMs = options.crossfade && !options.force
      ? Math.max(0, Number(state.crossfadeSeconds || 0) * 1000)
      : 0;
    gaplessHandoffPending = true;
    gaplessPreloadAudio = null;
    gaplessPreloadTrackId = "";
    cancelAudioFade();
    audio = incoming;
    installAudioEvents(incoming);
    incoming.playbackRate = state.playbackSpeed;
    incoming.volume = crossfadeDurationMs > 0 ? 0 : state.volume;
    state.current = { ...candidate, positionMs: 0 };
    state.lyrics = { lines: [], raw: "" };
    state.playReportedTrackId = "";
    state.lyricFollowPaused = false;
    currentLyricIndex = -1;
    syncAdjacentIdsFromQueue(candidate.id);
    mergeTrackIntoQueue(state.current);
    rememberLastTrack(state.current);
    state.status = "";
    state.playing = true;
    renderMusicUiPreservingSearch();

    Promise.resolve(incoming.play()).then(async () => {
      if (crossfadeDurationMs > 0) {
        crossfadeOutgoingAudio = outgoing;
        await crossfadeAudioPair(outgoing, incoming, crossfadeDurationMs);
      }
      if (crossfadeOutgoingAudio === outgoing) crossfadeOutgoingAudio = null;
      retireAudioElement(outgoing);
      gaplessHandoffPending = false;
      scheduleGaplessPreload();
      hydratePromotedTrack(candidate.id).catch(() => {});
      updatePlaybackUi();
    }).catch(() => {
      cancelCrossfade();
      audio = outgoing;
      state.current = outgoingTrack;
      gaplessHandoffPending = false;
      retireAudioElement(incoming);
      openTrack(candidate.id, { autoplay: true }).catch(() => {});
    });
    return true;
  }

  function syncAdjacentIdsFromQueue(trackId) {
    const queue = Array.isArray(state.queue) ? state.queue : [];
    const index = queue.findIndex((item) => item.id === trackId);
    state.prevId = index > 0 ? queue[index - 1]?.id || "" : (state.repeat === "all" ? queue.at(-1)?.id || "" : "");
    state.nextId = index >= 0 && index < queue.length - 1
      ? queue[index + 1]?.id || ""
      : (state.repeat === "all" ? queue[0]?.id || "" : "");
  }

  async function hydratePromotedTrack(trackId) {
    const id = String(trackId || "").trim();
    if (!id) return;
    try {
      const query = musicListQuery();
      const data = await fetchJson(getActiveUrl(), `/api/music/tracks/${encodeURIComponent(id)}${query ? `?${query}` : ""}`, {
        timeoutMs: 18000
      });
      if (state.current?.id !== id) return;
      state.current = data.track || state.current;
      state.lyrics = data.lyrics || { lines: [], raw: "" };
      state.prevId = data.prevId || state.prevId;
      state.nextId = data.nextId || state.nextId;
      mergeTrackIntoQueue(state.current);
      rememberLastTrack(state.current);
      scheduleGaplessPreload();
      renderMusicUiPreservingSearch();
    } catch {
      if (state.current?.id !== id) return;
      state.status = "歌曲资料稍后补全，播放未中断";
      renderMusicUiPreservingSearch();
    }
  }

  function retireAudioElement(target) {
    if (!target || target === audio) return;
    try {
      target.pause();
      target.removeAttribute("src");
      target.load();
    } catch {}
  }

  function clearGaplessPreload() {
    const target = gaplessPreloadAudio;
    gaplessPreloadAudio = null;
    gaplessPreloadTrackId = "";
    retireAudioElement(target);
  }

  function setSleepTimer(minutes) {
    const normalized = normalizeSleepTimerMinutes(minutes);
    clearSleepTimerHandle();
    if (!normalized) {
      state.sleepMinutes = 0;
      state.sleepUntil = 0;
      state.status = "已关闭睡眠定时";
      scheduleGaplessPreload();
      renderShell();
      return;
    }
    if (normalized === SLEEP_AFTER_CURRENT) {
      if (!state.current) {
        state.status = "请先播放一首歌，再设置播完当前暂停";
        renderShell();
        return;
      }
      state.sleepMinutes = SLEEP_AFTER_CURRENT;
      state.sleepUntil = 0;
      clearGaplessPreload();
      cancelCrossfade();
      state.status = "当前歌曲播完后将暂停播放";
      renderShell();
      return;
    }
    state.sleepMinutes = normalized;
    state.sleepUntil = Date.now() + normalized * 60 * 1000;
    state.status = `将在 ${normalized} 分钟后暂停`;
    scheduleSleepTimer();
    renderShell();
  }

  function scheduleSleepTimer() {
    clearSleepTimerHandle();
    if (sleepAfterCurrentTimerActive()) return;
    const remaining = sleepTimerRemainingMs();
    if (remaining <= 0) {
      expireSleepTimer();
      return;
    }
    sleepTimerTimeout = window.setTimeout(expireSleepTimer, Math.min(remaining, 2147483647));
    sleepTimerInterval = window.setInterval(() => {
      if (!sleepTimerActive()) {
        clearSleepTimerHandle();
        return;
      }
      if (sleepTimerRemainingMs() <= 0) {
        expireSleepTimer();
        return;
      }
      if (state.fullscreen) renderShell();
    }, 30000);
  }

  function clearSleepTimerHandle() {
    if (sleepTimerTimeout) {
      window.clearTimeout(sleepTimerTimeout);
      sleepTimerTimeout = 0;
    }
    if (sleepTimerInterval) {
      window.clearInterval(sleepTimerInterval);
      sleepTimerInterval = 0;
    }
  }

  function expireSleepTimer() {
    const afterCurrent = sleepAfterCurrentTimerActive();
    clearSleepTimerHandle();
    state.sleepMinutes = 0;
    state.sleepUntil = 0;
    clearGaplessPreload();
    ensureAudio();
    if (!audio.paused) pauseAudio();
    state.status = afterCurrent ? "当前歌曲已播完，已暂停播放" : "睡眠定时已暂停播放";
    renderShell();
  }

  function sleepTimerActive() {
    return sleepAfterCurrentTimerActive() || sleepTimerRemainingMs() > 0;
  }

  function sleepAfterCurrentTimerActive() {
    return state.sleepMinutes === SLEEP_AFTER_CURRENT;
  }

  function sleepTimerRemainingMs() {
    return Math.max(0, Number(state.sleepUntil || 0) - Date.now());
  }

  function sleepTimerText() {
    if (sleepAfterCurrentTimerActive()) return "播完当前歌曲";
    const minutes = Math.max(1, Math.ceil(sleepTimerRemainingMs() / 60000));
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      const rest = minutes % 60;
      return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
    }
    return `${minutes} 分钟`;
  }

  async function restoreLastTrack(renderGuard = null) {
    if (!canRestoreLastTrack()) return;
    const saved = readLastTrackPreference();
    const trackId = String(saved?.trackId || "").trim();
    if (!trackId || saved.activeUrl !== getActiveUrl()) return;
    const key = `${saved.activeUrl}|${trackId}`;
    if (state.restoreAttemptKey === key) return;
    state.restoreAttemptKey = key;
    if (saved.track?.id === trackId) mergeTrackIntoQueue(saved.track);
    await openTrack(trackId, { autoplay: false, renderGuard });
  }

  async function restorePlaybackQueue(renderGuard = null) {
    if (!state.resumeQueue || state.current || state.loading) return false;
    const saved = readPlaybackQueuePreference();
    if (!saved || saved.activeUrl !== getActiveUrl()) return false;
    const queue = (Array.isArray(saved.queue) ? saved.queue : [])
      .map(normalizeQueueTrack)
      .filter(Boolean)
      .slice(0, 300);
    const trackId = String(saved.currentTrackId || "").trim();
    if (!queue.length || !trackId || !queue.some((track) => track.id === trackId)) return false;
    state.queue = queue;
    await openTrack(trackId, { autoplay: false, renderGuard });
    return Boolean(state.current?.id === trackId);
  }

  function canRestoreLastTrack() {
    if (state.current || state.loading) return false;
    if (state.mode !== "library") return false;
    return !state.query && !state.favorite && !state.artistId && !state.albumId && !state.genre && state.sort === DEFAULT_SORT;
  }

  function rememberLastTrack(track) {
    if (!track?.id) return;
    writeLastTrackPreference({
      activeUrl: getActiveUrl(),
      trackId: track.id,
      track: compactTrack(track),
      updatedAt: new Date().toISOString()
    });
    rememberPlaybackQueue();
  }

  function rememberPlaybackQueue() {
    if (!state.resumeQueue || !state.current?.id) return;
    const queue = [];
    const seen = new Set();
    for (const source of state.queue || []) {
      const track = normalizeQueueTrack(source);
      if (!track || seen.has(track.id)) continue;
      seen.add(track.id);
      queue.push(compactTrack(track));
      if (queue.length >= 300) break;
    }
    if (!seen.has(state.current.id)) queue.unshift(compactTrack(state.current));
    writePlaybackQueuePreference({
      activeUrl: getActiveUrl(),
      currentTrackId: state.current.id,
      queue: queue.slice(0, 300),
      updatedAt: new Date().toISOString()
    });
  }

  function seekToLyric(timeMs) {
    if (!state.current) return;
    ensureAudio();
    const nextTime = Math.max(0, Number(timeMs || 0) / 1000);
    if (!Number.isFinite(nextTime)) return;
    state.lyricFollowPaused = false;
    els.viewContent.querySelector(".music-mobile-lyric-follow")?.classList.remove("visible");
    audio.currentTime = nextTime;
    updatePlaybackUi();
    updateLyricHighlight(true);
    if (audio.paused) playAudio();
  }

  async function playAdjacent(direction, options = {}) {
    const queue = Array.isArray(state.queue) ? state.queue : [];
    if (!state.current && queue[0]) {
      await openTrack(queue[0].id, { autoplay: true });
      return;
    }
    if (!state.current || !queue.length) return;
    if (state.shuffle && queue.length > 1) {
      const candidates = queue.filter((item) => item.id !== state.current.id);
      const target = candidates[Math.floor(Math.random() * candidates.length)];
      if (target) await openTrack(target.id, { autoplay: true });
      return;
    }
    const index = queue.findIndex((item) => item.id === state.current.id);
    if (index >= 0) {
      let nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= queue.length) {
        if (!options.wrap && state.repeat !== "all") return;
        nextIndex = nextIndex < 0 ? queue.length - 1 : 0;
      }
      const target = queue[nextIndex] || queue[0];
      if (target && direction > 0 && tryPromoteGaplessPreload({ force: true, candidateId: target.id })) return;
      if (target) await openTrack(target.id, { autoplay: true });
      return;
    }
    const adjacentId = direction > 0 ? state.nextId : state.prevId;
    if (adjacentId) {
      await openTrack(adjacentId, { autoplay: true });
      return;
    }
  }

  function queueTrackNext(track) {
    const item = normalizeQueueTrack(track);
    if (!item) return;
    const currentId = state.current?.id || "";
    const queue = withoutQueueTrack(state.queue || [], item.id);
    const currentIndex = currentId ? queue.findIndex((entry) => entry.id === currentId) : -1;
    queue.splice(currentIndex >= 0 ? currentIndex + 1 : 0, 0, item);
    state.queue = queue;
    scheduleGaplessPreload();
    rememberPlaybackQueue();
    state.status = `下一首播放「${item.title || "歌曲"}」`;
    renderShell();
  }

  function appendTrackToQueue(track) {
    const item = normalizeQueueTrack(track);
    if (!item) return;
    const queue = withoutQueueTrack(state.queue || [], item.id);
    queue.push(item);
    state.queue = queue;
    scheduleGaplessPreload();
    rememberPlaybackQueue();
    state.status = `已加入队列「${item.title || "歌曲"}」`;
    renderShell();
  }

  function moveQueueTrack(trackId, direction) {
    const queue = [...(state.queue || [])];
    const index = queue.findIndex((item) => item.id === trackId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= queue.length) return;
    const [item] = queue.splice(index, 1);
    queue.splice(nextIndex, 0, item);
    state.queue = queue;
    scheduleGaplessPreload();
    rememberPlaybackQueue();
    state.status = `已调整「${item.title || "歌曲"}」顺序`;
    renderShell();
    persistPlaylistQueueOrder(queue).catch((error) => {
      state.status = error?.message || "歌单顺序保存失败";
      renderShell();
    });
  }

  function removeTrackFromQueue(trackId) {
    if (!trackId || state.current?.id === trackId) return;
    const queue = state.queue || [];
    const removed = queue.find((item) => item.id === trackId);
    state.queue = queue.filter((item) => item.id !== trackId);
    scheduleGaplessPreload();
    rememberPlaybackQueue();
    state.status = removed ? `已移出队列「${removed.title || "歌曲"}」` : "已更新队列";
    renderShell();
  }

  function clearQueueExceptCurrent() {
    const queue = Array.isArray(state.queue) ? state.queue : [];
    const keep = state.current ? (queue.find((item) => item.id === state.current.id) || state.current) : null;
    const removable = queueRemovableCount();
    if (removable <= 0) return;
    const ok = window.confirm(`清空队列中的其他 ${formatNumber(removable)} 首歌曲？`);
    if (!ok) return;
    state.queue = keep ? [keep] : [];
    scheduleGaplessPreload();
    rememberPlaybackQueue();
    state.status = keep ? "已清空其他队列歌曲" : "已清空播放队列";
    renderShell();
  }

  function queueRemovableCount() {
    const queue = Array.isArray(state.queue) ? state.queue : [];
    if (!state.current) return queue.length;
    return queue.filter((item) => item.id !== state.current.id).length;
  }

  function queueTrackIds() {
    return uniqueTrackIds(state.queue || []);
  }

  async function persistPlaylistQueueOrder(queue = state.queue || []) {
    const playlistId = state.mode === "playlist" ? String(state.playlistId || "").trim() : "";
    if (!playlistId) return null;
    const trackIds = uniqueTrackIds(queue);
    if (!trackIds.length) return null;
    const data = await putJson(getActiveUrl(), `/api/music/playlists/${encodeURIComponent(playlistId)}/tracks/order`, {
      trackIds
    });
    state.playlist = data.playlist || state.playlist;
    if (state.data?.playlist?.id === playlistId) state.data.playlist = data.playlist || state.data.playlist;
    state.status = "歌单顺序已保存";
    renderShell();
    return data;
  }

  function uniqueTrackIds(queue = []) {
    const seen = new Set();
    const result = [];
    for (const track of queue || []) {
      const id = String(track?.id || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push(id);
    }
    return result;
  }

  function normalizeQueueTrack(track) {
    if (!track?.id) return null;
    return {
      ...track,
      title: track.title || track.fileName || "未知歌曲",
      artist: track.artist || "未知歌手",
      album: track.album || "未知专辑"
    };
  }

  function withoutQueueTrack(queue, trackId) {
    return (queue || []).filter((track) => track.id !== trackId);
  }

  async function toggleFavorite(trackId) {
    const id = String(trackId || "").trim();
    if (!id) return;
    const data = await postJson(getActiveUrl(), `/api/music/tracks/${encodeURIComponent(id)}/favorite`, {});
    const updated = data.track;
    if (!updated) return;
    applyTrackUpdate(updated);
    renderShell();
  }

  async function setTrackRating(trackId, rating) {
    const id = String(trackId || "").trim();
    if (!id) return;
    const data = await postJson(getActiveUrl(), `/api/music/tracks/${encodeURIComponent(id)}/rating`, { rating });
    const updated = data.track;
    if (!updated) return;
    applyTrackUpdate(updated);
    renderShell();
  }

  async function createPlaylistFromPrompt(options = {}) {
    const name = window.prompt("歌单名称", defaultPlaylistName());
    const clean = String(name || "").trim();
    if (!clean) return null;
    const data = await postJson(getActiveUrl(), "/api/music/playlists", { name: clean });
    const playlist = data?.playlist || null;
    await loadPlaylists();
    const addTrackId = String(options.addTrackId || (options.addCurrent ? state.current?.id : "") || "").trim();
    if (playlist?.id && addTrackId) {
      await addTrackToPlaylist(playlist.id, addTrackId);
      return playlist;
    }
    if (playlist?.id && options.openAfterCreate) {
      updateListParams({
        mode: "playlist",
        playlistId: playlist.id,
        smartId: "",
        favorite: false,
        query: "",
        artistId: "",
        albumId: "",
        genre: ""
      }, { resetSearch: true });
    } else {
      renderShell();
    }
    return playlist;
  }

  async function saveQueueAsPlaylist() {
    const trackIds = queueTrackIds();
    if (!trackIds.length) {
      state.status = "播放队列为空";
      renderShell();
      return null;
    }
    const name = window.prompt("歌单名称", defaultQueuePlaylistName());
    const clean = String(name || "").trim();
    if (!clean) return null;
    state.status = "正在保存播放队列";
    renderShell();
    const data = await postJson(getActiveUrl(), "/api/music/playlists", {
      name: clean,
      description: "从播放队列保存",
      trackIds
    });
    const playlist = data?.playlist || null;
    state.queueOpen = false;
    await loadPlaylists();
    if (playlist?.id) {
      updateListParams({
        mode: "playlist",
        playlistId: playlist.id,
        smartId: "",
        favorite: false,
        query: "",
        artistId: "",
        albumId: "",
        genre: ""
      }, { resetSearch: true });
    } else {
      state.status = "播放队列已保存";
      renderShell();
    }
    return playlist;
  }

  async function addCurrentToPlaylist(playlistId) {
    return addTrackToPlaylist(playlistId, state.current?.id);
  }

  async function addTrackToPlaylist(playlistId, trackId) {
    const id = String(playlistId || "").trim();
    const targetTrackId = String(trackId || "").trim();
    if (!id || !targetTrackId) return;
    const data = await postJson(getActiveUrl(), `/api/music/playlists/${encodeURIComponent(id)}/tracks`, {
      trackId: targetTrackId
    });
    state.playlistSheetOpen = false;
    state.playlistActionTrackId = "";
    const playlistName = (state.playlists || []).find((item) => item.id === id)?.name || data.playlist?.name || "歌单";
    state.status = `已加入「${playlistName}」`;
    await loadPlaylists();
    if (state.mode === "playlist" && state.playlistId === id) {
      state.data = data;
      state.playlist = data.playlist || selectedPlaylist();
      state.queue = Array.isArray(data.tracks) ? data.tracks : state.queue;
      rememberPlaybackQueue();
    }
    renderShell();
  }

  async function removeTrackFromCurrentPlaylist(trackId) {
    const playlistId = String(state.playlistId || "").trim();
    const id = String(trackId || "").trim();
    if (!playlistId || !id) return;
    const playlistName = selectedPlaylist()?.name || state.playlist?.name || "当前歌单";
    const track = (state.queue || []).find((item) => item.id === id);
    const ok = window.confirm(`从「${playlistName}」移出${track?.title ? `《${track.title}》` : "这首歌"}？`);
    if (!ok) return;
    const data = await deleteJson(getActiveUrl(), `/api/music/playlists/${encodeURIComponent(playlistId)}/tracks/${encodeURIComponent(id)}`);
    state.data = data;
    state.playlist = data.playlist || selectedPlaylist();
    state.queue = Array.isArray(data.tracks) ? data.tracks : [];
    rememberPlaybackQueue();
    state.status = "已移出歌单";
    await loadPlaylists();
    renderShell();
  }

  async function deleteCurrentPlaylist() {
    const playlistId = String(state.playlistId || "").trim();
    if (!playlistId) return;
    const playlistName = selectedPlaylist()?.name || state.playlist?.name || "当前歌单";
    const ok = window.confirm(`删除歌单「${playlistName}」？不会删除本地歌曲文件。`);
    if (!ok) return;
    await deleteJson(getActiveUrl(), `/api/music/playlists/${encodeURIComponent(playlistId)}`);
    state.status = "歌单已删除";
    state.playlistId = "";
    state.playlist = null;
    await loadPlaylists();
    updateListParams({
      mode: "library",
      playlistId: "",
      smartId: "",
      favorite: false,
      query: "",
      artistId: "",
      albumId: "",
      genre: ""
    }, { resetSearch: true });
  }

  async function editCurrentPlaylist() {
    const playlist = selectedPlaylist() || state.playlist;
    const playlistId = String(playlist?.id || state.playlistId || "").trim();
    if (!playlistId) return;
    const name = window.prompt("歌单名称", playlist?.name || "");
    if (name === null) return;
    const cleanName = String(name || "").trim();
    if (!cleanName) return;
    const description = window.prompt("歌单说明", playlist?.description || "");
    if (description === null) return;
    const data = await putJson(getActiveUrl(), `/api/music/playlists/${encodeURIComponent(playlistId)}`, {
      name: cleanName,
      description: String(description || "").trim()
    });
    state.data = data;
    state.playlist = data.playlist || selectedPlaylist();
    state.queue = Array.isArray(data.tracks) ? data.tracks : state.queue;
    state.status = "歌单已更新";
    await loadPlaylists();
    renderShell();
  }

  function downloadTrack(track) {
    if (!track?.downloadUrl) return;
    const target = absoluteUrl(getActiveUrl(), track.downloadUrl);
    const link = document.createElement("a");
    link.href = target;
    link.download = track.fileName || track.title || "music";
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
  }

  function applyTrackUpdate(updated) {
    if (state.current?.id === updated.id) state.current = { ...state.current, ...updated };
    state.queue = (state.queue || []).map((track) => (track.id === updated.id ? { ...track, ...updated } : track));
    if (state.data?.tracks) {
      state.data.tracks = state.data.tracks.map((track) => (track.id === updated.id ? { ...track, ...updated } : track));
    }
    if (state.current?.id === updated.id) rememberLastTrack(state.current);
  }

  function reportPlayedOnce() {
    const track = state.current;
    if (!track || state.playReportedTrackId === track.id) return;
    state.playReportedTrackId = track.id;
    postJson(getActiveUrl(), `/api/music/tracks/${encodeURIComponent(track.id)}/progress`, {
      positionMs: Math.round((audio?.currentTime || 0) * 1000),
      durationMs: Math.round((audio?.duration || 0) * 1000) || track.durationMs || 0,
      played: true
    }).catch(() => {});
  }

  function saveProgressSoon(positionOverride = null) {
    pendingProgressRecord = currentProgressRecord(positionOverride);
    if (!pendingProgressRecord || progressTimer) return;
    progressTimer = window.setTimeout(() => {
      progressTimer = 0;
      const record = pendingProgressRecord;
      pendingProgressRecord = null;
      postProgressRecord(record);
    }, 800);
  }

  function saveProgress(positionOverride = null) {
    postProgressRecord(currentProgressRecord(positionOverride));
  }

  function currentProgressRecord(positionOverride = null) {
    const track = state.current;
    if (!track || !audio) return null;
    return {
      activeUrl: getActiveUrl(),
      trackId: track.id,
      positionMs: positionOverride === null ? Math.round((audio.currentTime || 0) * 1000) : Number(positionOverride || 0),
      durationMs: Math.round((audio.duration || 0) * 1000) || track.durationMs || 0
    };
  }

  function postProgressRecord(record) {
    if (!record?.trackId) return;
    postJson(record.activeUrl, `/api/music/tracks/${encodeURIComponent(record.trackId)}/progress`, {
      positionMs: record.positionMs,
      durationMs: record.durationMs
    }).catch(() => {});
  }

  function updatePlaybackUi() {
    if (!audio) return;
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Number(state.current?.durationMs || 0) / 1000;
    const current = Number(audio.currentTime || 0);
    const playing = Boolean(state.current && !audio.paused);
    state.playing = playing;
    updateMountedMiniPlayerTrack();
    for (const binding of progressBindings) {
      if (binding.current) binding.current.textContent = formatSeconds(current);
      if (binding.total) binding.total.textContent = formatSeconds(duration);
      if (binding.progress) {
        binding.progress.value = duration > 0 ? String(Math.round((current / duration) * 1000)) : "0";
        binding.progress.disabled = !state.current;
      }
      if (binding.playButton) {
        binding.playButton.textContent = playIcon(playing);
        binding.playButton.setAttribute("aria-label", playLabel(playing));
        binding.playButton.title = playLabel(playing);
      }
    }
    updateStaticPlaybackControls(playing);
    updateMediaSession(duration, current);
  }

  function updateStaticPlaybackControls(playing) {
    const playbackToggle = els.viewContent?.querySelector("[data-music-playback-toggle]");
    if (playbackToggle) {
      playbackToggle.textContent = state.current ? (playing ? "暂停" : "继续") : "播放";
      playbackToggle.disabled = !state.queue.length;
    }

    const currentId = String(state.current?.id || "");
    for (const row of els.viewContent?.querySelectorAll(".music-mobile-list .music-mobile-track") || []) {
      const isCurrent = Boolean(currentId && row.dataset.trackId === currentId);
      const isPlaying = isCurrent && playing;
      row.classList.toggle("active", isCurrent);
      row.classList.toggle("playing", isPlaying);
      if (isCurrent) row.dataset.current = "true";
      else delete row.dataset.current;

      const index = row.querySelector(".music-mobile-track-index");
      if (!index) continue;
      const bars = index.querySelector(".music-mobile-playing-bars");
      if (isPlaying && !bars) {
        index.textContent = "";
        index.append(renderPlayingBars());
      } else if (!isPlaying && bars) {
        const position = Math.max(0, Number(row.dataset.trackIndex || 0));
        index.textContent = String(position + 1).padStart(2, "0");
      }
    }
  }

  function captureMusicSearchFocus() {
    const input = els.viewContent?.querySelector(".music-mobile-search-input");
    if (!input || document.activeElement !== input) return null;
    return {
      start: input.selectionStart,
      end: input.selectionEnd,
      direction: input.selectionDirection
    };
  }

  function restoreMusicSearchFocus(snapshot) {
    if (!snapshot) return;
    window.requestAnimationFrame(() => {
      const input = els.viewContent?.querySelector(".music-mobile-search-input");
      if (!input || input.disabled || (!state.searchOpen && !state.query)) {
        if (!state.searchOpen && !state.query && pendingSearchFocus === snapshot) pendingSearchFocus = null;
        return;
      }
      input.focus({ preventScroll: true });
      if (typeof input.setSelectionRange === "function") {
        try {
          input.setSelectionRange(snapshot.start, snapshot.end, snapshot.direction || "none");
        } catch {}
      }
      if (!state.loading && pendingSearchFocus === snapshot) pendingSearchFocus = null;
    });
  }

  function installMediaSessionHandlers() {
    if (mediaSessionInstalled || !("mediaSession" in navigator)) return;
    mediaSessionInstalled = true;
    setMediaAction("play", () => {
      if (!state.current) togglePlayback();
      else if (audio?.paused) playAudio();
    });
    setMediaAction("pause", () => {
      if (audio && !audio.paused) pauseAudio();
    });
    setMediaAction("previoustrack", () => playAdjacent(-1).catch(() => {}));
    setMediaAction("nexttrack", () => playAdjacent(1).catch(() => {}));
    setMediaAction("seekbackward", (details = {}) => seekRelative(-Number(details.seekOffset || 10)));
    setMediaAction("seekforward", (details = {}) => seekRelative(Number(details.seekOffset || 10)));
    setMediaAction("seekto", (details = {}) => {
      if (!audio || typeof details.seekTime !== "number") return;
      audio.currentTime = Math.max(0, details.seekTime);
      updatePlaybackUi();
      if (state.fullscreen) updateLyricHighlight(true);
    });
  }

  function setMediaAction(action, handler) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {}
  }

  function seekRelative(offsetSeconds) {
    if (!audio) return;
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Number(state.current?.durationMs || 0) / 1000;
    const target = Math.max(0, Math.min(duration || Number.MAX_SAFE_INTEGER, Number(audio.currentTime || 0) + Number(offsetSeconds || 0)));
    audio.currentTime = target;
    updatePlaybackUi();
    if (state.fullscreen) updateLyricHighlight(true);
  }

  function updateMediaSession(duration = 0, current = 0) {
    if (!("mediaSession" in navigator)) return;
    const track = state.current;
    if (!track) {
      state.mediaSessionTrackId = "";
      navigator.mediaSession.playbackState = "none";
      return;
    }
    if (state.mediaSessionTrackId !== track.id) {
      state.mediaSessionTrackId = track.id;
      if ("MediaMetadata" in window) {
        const artwork = track.coverUrl
          ? [{ src: absoluteUrl(getActiveUrl(), track.coverUrl), sizes: "512x512" }]
          : [];
        navigator.mediaSession.metadata = new window.MediaMetadata({
          title: track.title || "未知歌曲",
          artist: track.artist || "未知歌手",
          album: track.album || "未知专辑",
          artwork
        });
      }
    }
    navigator.mediaSession.playbackState = state.playing ? "playing" : "paused";
    if (typeof navigator.mediaSession.setPositionState === "function" && duration > 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration,
          playbackRate: audio?.playbackRate || 1,
          position: Math.max(0, Math.min(duration, current || 0))
        });
      } catch {}
    }
  }

  function updateLyricHighlight(force = false) {
    if (!state.fullscreen || lyricRaf) return;
    lyricRaf = window.requestAnimationFrame(() => {
      lyricRaf = 0;
      const lines = state.lyrics?.lines || [];
      if (!lines.length || !audio) return;
      const timeMs = Math.round((audio.currentTime || 0) * 1000);
      let index = 0;
      for (let i = 0; i < lines.length; i += 1) {
        if (Number(lines[i].timeMs || 0) <= timeMs + 180) index = i;
        else break;
      }
      if (!force && index === currentLyricIndex) return;
      currentLyricIndex = index;
      updateCoverLyricPeek(index);
      if (state.fullPanel === "lyrics") {
        for (const item of els.viewContent.querySelectorAll(".music-mobile-full-lyric-lines [data-index]")) {
          const active = Number(item.dataset.index || -1) === index;
          item.classList.toggle("active", active);
          if (active && (!state.lyricFollowPaused || force)) centerLyricLine(item, { smooth: !force });
        }
      }
    });
  }

  function centerLyricLine(item, options = {}) {
    const container = item?.closest?.(".music-mobile-full-lyric-lines");
    if (!container) return;
    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
    const target = Math.max(0, Math.min(maxScroll, item.offsetTop - ((container.clientHeight - item.offsetHeight) / 2)));
    container.scrollTo({
      top: target,
      behavior: options.smooth ? "smooth" : "auto"
    });
  }

  function updateCoverLyricPeek(index) {
    const peek = els.viewContent.querySelector(".music-mobile-cover-lyric");
    if (!peek) return;
    const pair = lyricPair(index);
    const current = peek.querySelector("strong");
    const next = peek.querySelector("small");
    if (current) current.textContent = pair.current || "暂无歌词";
    if (next) next.textContent = pair.next || trackMeta(state.current || {});
  }

  function lyricPair(index) {
    const lines = state.lyrics?.lines || [];
    if (!lines.length) return { current: "", next: "" };
    const safeIndex = Math.max(0, Math.min(lines.length - 1, Number(index || 0)));
    const current = String(lines[safeIndex]?.text || "").trim();
    const nextLine = lines.slice(safeIndex + 1).find((line) => String(line?.text || "").trim());
    return {
      current,
      next: String(nextLine?.text || "").trim()
    };
  }

  function pauseLyricFollow(button = null) {
    if (state.lyricFollowPaused || !hasLyrics()) return;
    state.lyricFollowPaused = true;
    button?.classList.add("visible");
  }

  function resumeLyricFollow() {
    state.lyricFollowPaused = false;
    const button = els.viewContent.querySelector(".music-mobile-lyric-follow");
    button?.classList.remove("visible");
    updateLyricHighlight(true);
  }

  function hasLyrics() {
    return Boolean((state.lyrics?.lines || []).length);
  }

  function normalizeFullPanel(panel, track) {
    const value = panel === "cover" ? "cover" : "lyrics";
    if (!track) return value;
    return value === "lyrics" || hasLyrics() ? value : "cover";
  }

  function updateListParams(patch = {}, options = {}) {
    mountedSearchController?.abort();
    const searchFocus = captureMusicSearchFocus();
    if (searchFocus) pendingSearchFocus = searchFocus;
    if (Object.prototype.hasOwnProperty.call(patch, "mode")) state.mode = normalizeMode(patch.mode);
    if (Object.prototype.hasOwnProperty.call(patch, "searchScope")) state.searchScope = normalizeSearchScope(patch.searchScope, state.mode);
    if (Object.prototype.hasOwnProperty.call(patch, "favorite")) state.favorite = Boolean(patch.favorite);
    if (Object.prototype.hasOwnProperty.call(patch, "smartId")) state.smartId = String(patch.smartId || "").trim();
    if (Object.prototype.hasOwnProperty.call(patch, "playlistId")) state.playlistId = String(patch.playlistId || "").trim();
    if (Object.prototype.hasOwnProperty.call(patch, "query")) state.query = String(patch.query || "").trim();
    if (Object.prototype.hasOwnProperty.call(patch, "sort")) state.sort = normalizeSort(patch.sort);
    if (Object.prototype.hasOwnProperty.call(patch, "artistSort")) state.artistSort = String(patch.artistSort || "count") === "name" ? "name" : "count";
    if (Object.prototype.hasOwnProperty.call(patch, "albumSort")) state.albumSort = normalizeAlbumSort(patch.albumSort);
    if (Object.prototype.hasOwnProperty.call(patch, "artistId")) state.artistId = String(patch.artistId || "").trim();
    if (Object.prototype.hasOwnProperty.call(patch, "albumId")) state.albumId = String(patch.albumId || "").trim();
    if (Object.prototype.hasOwnProperty.call(patch, "genre")) state.genre = String(patch.genre || "").trim();
    if (Object.prototype.hasOwnProperty.call(patch, "language")) state.language = String(patch.language || "").trim();
    if (Object.prototype.hasOwnProperty.call(patch, "mode") && state.mode !== "smart" && !Object.prototype.hasOwnProperty.call(patch, "smartId")) state.smartId = "";
    if (Object.prototype.hasOwnProperty.call(patch, "mode") && state.mode !== "playlist" && !Object.prototype.hasOwnProperty.call(patch, "playlistId")) state.playlistId = "";
    if (state.smartId) {
      state.mode = "smart";
      state.favorite = false;
    }
    if (state.playlistId) {
      state.mode = "playlist";
      state.favorite = false;
      state.smartId = "";
    }
    if (state.mode !== "smart") state.smartId = "";
    if (state.mode !== "playlist") state.playlistId = "";
    if (state.mode === "artists") state.searchScope = "artists";
    else if (state.mode === "albums") state.searchScope = "albums";
    else if (state.mode !== "library") state.searchScope = "all";
    if (!["library", "artists", "albums"].includes(state.mode)) {
      state.artistId = "";
      state.albumId = "";
      state.genre = "";
      state.language = "";
    }
    if (options.resetSearch) state.searchOpen = false;
    showView("music", musicRouteParams(), {
      skipHistory: true,
      replaceHistory: true,
      restoreScrollY: options.preserveScroll ? window.scrollY : 0
    });
  }

  function musicListPath() {
    if (state.mode === "history") return `/api/music/history?limit=${DEFAULT_LIMIT}`;
    if (state.mode === "playlist" && state.playlistId) return `/api/music/playlists/${encodeURIComponent(state.playlistId)}`;
    const query = musicListQuery();
    return `${state.mode === "artists" ? "/api/music/artists" : state.mode === "albums" ? "/api/music/albums" : "/api/music/tracks"}?${query}`;
  }

  function musicListQuery() {
    const params = new URLSearchParams();
    params.set("limit", String(DEFAULT_LIMIT));
    if (state.query) params.set("q", state.query);
    if (state.mode === "artists") {
      params.set("sort", state.artistSort);
      if (state.language) params.set("language", state.language);
      return params.toString();
    }
    if (state.mode === "albums") {
      params.set("sort", state.albumSort);
      if (state.language) params.set("language", state.language);
      return params.toString();
    }
    if (state.sort && state.sort !== DEFAULT_SORT && state.mode !== "smart") params.set("sort", state.sort);
    if (state.favorite) params.set("favorite", "1");
    if (state.query && state.searchFavorite) params.set("favorite", "1");
    if (state.query && state.searchLyrics) params.set("lyrics", "1");
    if (state.query && state.searchMinRating) params.set("minRating", String(state.searchMinRating));
    if (state.query && state.searchQuality) params.set("quality", state.searchQuality);
    if (state.smartId) params.set("smart", state.smartId);
    if (state.playlistId) params.set("playlist", state.playlistId);
    if (state.artistId) params.set("artist", state.artistId);
    if (state.albumId) params.set("album", state.albumId);
    if (state.genre) params.set("genre", state.genre);
    if (state.language) params.set("language", state.language);
    return params.toString();
  }

  function musicRouteParams() {
    return {
      mode: state.mode,
      ...(state.query ? { query: state.query } : {}),
      ...(state.query && state.searchScope !== "all" ? { searchScope: state.searchScope } : {}),
      ...(state.sort !== DEFAULT_SORT && state.mode !== "smart" ? { sort: state.sort } : {}),
      ...(state.favorite ? { favorite: "1" } : {}),
      ...(state.query && state.searchFavorite ? { searchFavorite: "1" } : {}),
      ...(state.query && state.searchLyrics ? { searchLyrics: "1" } : {}),
      ...(state.query && state.searchMinRating ? { searchMinRating: String(state.searchMinRating) } : {}),
      ...(state.query && state.searchQuality ? { searchQuality: state.searchQuality } : {}),
      ...(state.smartId ? { smartId: state.smartId } : {}),
      ...(state.playlistId ? { playlistId: state.playlistId } : {}),
      ...(state.artistId ? { artistId: state.artistId } : {}),
      ...(state.albumId ? { albumId: state.albumId } : {}),
      ...(state.genre ? { genre: state.genre } : {}),
      ...(state.language ? { language: state.language } : {}),
      ...(state.mode === "artists" && state.artistSort !== "count" ? { artistSort: state.artistSort } : {}),
      ...(state.mode === "albums" && state.albumSort !== "updated" ? { albumSort: state.albumSort } : {})
    };
  }

  function musicTitle() {
    if (state.mode === "artists") return state.language ? `${state.language}歌手` : "歌手浏览";
    if (state.mode === "albums") return state.language ? `${state.language}专辑` : "专辑浏览";
    if (state.mode === "history") return "最近播放";
    if (state.mode === "playlist") return selectedPlaylist()?.name || state.playlist?.name || "歌单";
    if (state.smartId) return selectedSmartPlaylist()?.name || "智能歌单";
    if (state.genre) return state.genre;
    if (state.albumId) return selectedAlbumTitle() || "专辑";
    if (state.artistId) return selectedArtistName() || "歌手";
    if (state.language) return `${state.language}音乐`;
    if (state.favorite) return "收藏歌曲";
    return "音乐";
  }

  function musicMeta(data = state.data) {
    const summary = data?.summary || state.summary || {};
    const total = data?.total ?? state.queue.length;
    const totals = summary.totals || {};
    const scope = [state.language, selectedArtistName(), selectedAlbumTitle(), state.genre].filter(Boolean).join(" · ");
    if (state.loading) return state.status || "正在读取";
    if (state.mode === "artists") return `${formatNumber(total || 0)} 位歌手 · ${state.artistSort === "name" ? "按名称" : "歌曲最多"}`;
    if (state.mode === "albums") return `${formatNumber(total || 0)} 张专辑 · ${{ updated: "最近入库", title: "按名称", year: "按年份", tracks: "歌曲最多" }[state.albumSort] || "最近入库"}`;
    if (state.mode === "history") return `${formatNumber(total || 0)} 首 · 最近播放`;
    if (data?.relevance) {
      const visible = Number(data?.tracks?.length || 0);
      return visible && visible < Number(total || 0)
        ? `${formatNumber(visible)} 首 · ${formatNumber(total || 0)} 个文件 · 按匹配度`
        : `${formatNumber(total || 0)} 首 · 按匹配度`;
    }
    if (state.mode === "playlist") {
      const playlist = selectedPlaylist() || state.playlist;
      return `${formatNumber(total || 0)} 首${playlist?.updatedAt ? ` · 更新于 ${shortDate(playlist.updatedAt)}` : ""}`;
    }
    if (state.smartId) {
      const smart = selectedSmartPlaylist();
      return `${formatNumber(total || 0)} 首${smart?.description ? ` · ${smart.description}` : ""}`;
    }
    if (state.favorite) return `${formatNumber(total || 0)} 首 · 收藏${scope ? ` · ${scope}` : ""}`;
    if (scope) return `${formatNumber(total || 0)} 首 · ${scope}`;
    if (totals.tracks) {
      return `${formatCompact(totals.tracks)} 首 · ${formatCompact(totals.albums)} 专辑 · ${formatBytes(totals.bytes || 0)}`;
    }
    return `${formatNumber(total || 0)} 首`;
  }

  function trackMeta(track = {}) {
    return [track.artist || "未知歌手", track.album || "未知专辑"].filter(Boolean).join(" · ");
  }

  function emptyMessage() {
    if (state.mode === "artists") return "没有匹配的歌手";
    if (state.mode === "albums") return "没有匹配的专辑";
    if (state.mode === "history") return "还没有最近播放";
    if (state.mode === "playlist") return "这个歌单还没有歌曲";
    if (state.smartId) return "这个智能歌单暂时没有歌曲";
    if (state.favorite) return "还没有收藏歌曲";
    if (state.artistId || state.albumId || state.genre) return "这个筛选下没有歌曲";
    if (state.query) return "没有匹配的歌曲";
    return "这里还没有音乐";
  }

  function selectedArtistName() {
    if (!state.artistId) return "";
    const artists = Array.isArray(state.data?.artists) ? state.data.artists : [];
    return artists.find((artist) => artist.id === state.artistId)?.name || "";
  }

  function selectedAlbumTitle() {
    if (!state.albumId) return "";
    const albums = Array.isArray(state.data?.albums) ? state.data.albums : [];
    return albums.find((album) => album.id === state.albumId)?.title || "";
  }

  function selectedSmartPlaylist() {
    if (!state.smartId) return null;
    const fromData = state.data?.smartPlaylist;
    if (fromData?.id === state.smartId) return fromData;
    const cached = state.smartPlaylist?.id === state.smartId ? state.smartPlaylist : null;
    return (state.smartPlaylists || []).find((item) => item.id === state.smartId) || cached;
  }

  function selectedPlaylist() {
    if (!state.playlistId) return null;
    const fromData = state.data?.playlist;
    if (fromData?.id === state.playlistId) return fromData;
    const cached = state.playlist?.id === state.playlistId ? state.playlist : null;
    return (state.playlists || []).find((item) => item.id === state.playlistId) || cached;
  }

  function installLifecycle() {
    window.addEventListener("pagehide", () => saveProgress());
    window.addEventListener("fanhaoViewChanged", (event) => {
      if (event.detail?.view !== "music") {
        state.fullscreen = false;
        state.queueOpen = false;
        state.playlistSheetOpen = false;
        state.sleepSheetOpen = false;
        state.settingsOpen = false;
        state.trackActionId = "";
        state.playlistActionTrackId = "";
        document.body.classList.remove("music-player-open");
      }
      if (!audio) return;
      updatePlaybackUi();
    });
  }

  function deactivate() {
    moduleActive = false;
    window.clearTimeout(searchDebounceTimer);
    window.clearTimeout(searchSuggestionTimer);
    searchSuggestionController?.abort();
    mountedSearchController?.abort();
    state.fullscreen = false;
    state.queueOpen = false;
    state.playlistSheetOpen = false;
    state.sleepSheetOpen = false;
    state.settingsOpen = false;
    state.trackActionId = "";
    state.playlistActionTrackId = "";
    document.body.classList.remove("music-player-open");
  }

  return {
    closeFullscreen,
    deactivate,
    renderMusicList
  };
}
