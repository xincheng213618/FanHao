const MUSIC_SLEEP_TIMER_OPTIONS = [0, 10, 15, 30, 45, 60, 90];
const MUSIC_PLAYBACK_SPEED_OPTIONS = [0.75, 1, 1.25, 1.5, 2];
const MUSIC_PAGE_LIMIT = 120;
const MUSIC_ARTIST_PAGE_LIMIT = 80;
const MUSIC_ALBUM_PAGE_LIMIT = 80;
const DESKTOP_QUEUE_PREVIEW_LIMIT = 24;
const DESKTOP_QUEUE_PAGE_SIZE = 120;
const MUSIC_KEYBOARD_SEEK_SECONDS = 5;
const MUSIC_KEYBOARD_FAST_SEEK_SECONDS = 15;
const MUSIC_LAST_TRACK_KEY = "fanhao.music.lastTrack";
const MUSIC_PLAYBACK_SPEED_KEY = "fanhao.music.playbackSpeed";
const MUSIC_VISUALIZER_FRAME_MS = 50;
const MUSIC_PROGRESS_SAVE_DELAY_MS = 700;
const MUSIC_PROGRESS_SAVE_INTERVAL_MS = 10000;
const MUSIC_SIDE_LIST_CACHE_MS = 60000;
const MUSIC_LIBRARY_SEARCH_DEBOUNCE_MS = 220;
const MUSIC_LIBRARY_CLEAR_DEBOUNCE_MS = 80;
const MUSIC_CATALOG_SEARCH_DEBOUNCE_MS = 180;
const MUSIC_SUGGEST_MIN_CHARACTERS = 3;

export function createMusicPage(deps) {
  const {
    api,
    cancelScheduledWorkRendering,
    disconnectPeopleIndexAutoload,
    els,
    formatBytes,
    formatNumber,
    hidePersonProfile,
    openAdminScript,
    pushRoute,
    replaceRoute,
    resetProgressiveCoverLoading,
    setMainHeader,
    state,
    syncRouteAfterNavigation
  } = deps;

  let audio = null;
  let audioEventsInstalled = false;
  let searchTimer = null;
  let musicLoadGeneration = 0;
  let musicLoadController = null;
  let trackOpenGeneration = 0;
  let trackOpenController = null;
  let suggestTimer = null;
  let suggestController = null;
  let suggestionCache = new Map();
  let suggestionBox = null;
  let progressTimer = null;
  let pendingProgressRecord = null;
  let lastProgressSavedAt = 0;
  let lyricRaf = 0;
  let currentProgressEls = null;
  let playbackButtonEls = [];
  let currentTrackIndicatorMap = new Map();
  let musicTrackElementMap = new Map();
  let openingTrackElementId = "";
  let playbackSurfaceEls = [];
  let playbackErrorEls = [];
  let shuffleControlEls = [];
  let repeatControlEls = [];
  let sleepTimerControlEls = [];
  let lyricLineEls = [];
  let lyricFollowButtonEls = [];
  let activeLyricElement = null;
  let currentLyricIndex = -1;
  let sleepTimerTimeout = 0;
  let sleepTimerInterval = 0;
  let mediaSessionInstalled = false;
  let keyboardShortcutsInstalled = false;
  let restoreAttemptKey = "";
  let visualizerCanvas = null;
  let visualizerRaf = 0;
  let audioContext = null;
  let audioAnalyser = null;
  let audioSource = null;
  let visualizerBins = null;
  let visualizerLastFrameAt = 0;
  let mediaSessionPositionSecond = -1;
  let mediaSessionPlaybackState = "";
  let visibilityHandlerInstalled = false;
  let trackReturnContext = null;
  let playlistDialogReturnFocus = null;

  function ensureState() {
    if (!state.music) state.music = {};
    state.music.query = state.music.query || "";
    state.music.mode = ["home", "library", "artists", "albums", "history", "playlist", "smart", "report"].includes(state.music.mode) ? state.music.mode : "library";
    state.music.artistId = state.music.artistId || "all";
    state.music.albumId = state.music.albumId || "all";
    state.music.genre = state.music.genre || "all";
    state.music.language = state.music.language || "all";
    state.music.letter = state.music.letter || "";
    state.music.activePlaylistId = state.music.activePlaylistId || "";
    state.music.activeSmartPlaylistId = state.music.activeSmartPlaylistId || "";
    state.music.sort = state.music.sort || "album";
    state.music.artistSort = state.music.artistSort === "name" ? "name" : "count";
    state.music.albumSort = ["updated", "title", "year", "tracks"].includes(state.music.albumSort) ? state.music.albumSort : "updated";
    state.music.favorite = Boolean(state.music.favorite);
    state.music.data = state.music.data || null;
    state.music.summary = state.music.summary || null;
    state.music.artists = Array.isArray(state.music.artists) ? state.music.artists : [];
    state.music.albums = Array.isArray(state.music.albums) ? state.music.albums : [];
    state.music.genres = Array.isArray(state.music.genres) ? state.music.genres : [];
    state.music.languages = Array.isArray(state.music.languages) ? state.music.languages : [];
    state.music.playlists = Array.isArray(state.music.playlists) ? state.music.playlists : [];
    state.music.smartPlaylists = Array.isArray(state.music.smartPlaylists) ? state.music.smartPlaylists : [];
    state.music.playlistsLoadedAt = Number(state.music.playlistsLoadedAt || 0);
    state.music.smartPlaylistsLoadedAt = Number(state.music.smartPlaylistsLoadedAt || 0);
    state.music.suggestions = state.music.suggestions || { query: "", tracks: [], artists: [], albums: [] };
    state.music.suggestionQuery = state.music.suggestionQuery || "";
    state.music.activePlaylist = state.music.activePlaylist || null;
    state.music.activeSmartPlaylist = state.music.activeSmartPlaylist || null;
    state.music.current = state.music.current || null;
    state.music.lyrics = state.music.lyrics || { raw: "", lines: [] };
    state.music.lyricFollowPaused = Boolean(state.music.lyricFollowPaused);
    state.music.queue = Array.isArray(state.music.queue) ? state.music.queue : [];
    state.music.queueExpanded = Boolean(state.music.queueExpanded);
    state.music.queueVisibleLimit = Math.max(DESKTOP_QUEUE_PAGE_SIZE, Number(state.music.queueVisibleLimit || 0));
    state.music.prevId = state.music.prevId || "";
    state.music.nextId = state.music.nextId || "";
    state.music.loading = Boolean(state.music.loading);
    state.music.loadingMore = Boolean(state.music.loadingMore);
    state.music.hasMore = Boolean(state.music.hasMore);
    state.music.playing = Boolean(state.music.playing);
    state.music.playbackError = String(state.music.playbackError || "");
    state.music.status = state.music.status || "";
    state.music.volume = readVolumePreference();
    state.music.playbackSpeed = normalizePlaybackSpeed(state.music.playbackSpeed ?? readPlaybackSpeedPreference());
    state.music.repeat = normalizeRepeat(readRepeatPreference());
    state.music.shuffle = readShufflePreference();
    state.music.sleepMinutes = normalizeSleepTimerMinutes(state.music.sleepMinutes);
    state.music.sleepUntil = Number(state.music.sleepUntil || 0);
    if (!sleepTimerActive()) {
      state.music.sleepMinutes = 0;
      state.music.sleepUntil = 0;
    } else if (!sleepTimerTimeout) {
      scheduleSleepTimer();
    }
    state.music.playReportedTrackId = state.music.playReportedTrackId || "";
    state.music.mediaSessionTrackId = state.music.mediaSessionTrackId || "";
    state.music.playlistDialogOpen = Boolean(state.music.playlistDialogOpen);
    state.music.playlistDialogTrackId = state.music.playlistDialogTrackId || "";
    state.music.playlistDialogName = state.music.playlistDialogName || "";
    state.music.libraryDrawerOpen = Boolean(state.music.libraryDrawerOpen);
    state.music.trackPageOpen = Boolean(state.music.trackPageOpen);
    state.music.playerStageOpen = Boolean(state.music.playerStageOpen);
    state.music.openingTrackId = state.music.openingTrackId || "";
    ensureAudio();
    installMusicVisibilityHandler();
    installKeyboardShortcuts();
  }

  function ensureAudio() {
    if (!audio) {
      audio = new Audio();
      audio.preload = "metadata";
      audio.volume = readVolumePreference();
      audio.playbackRate = normalizePlaybackSpeed(state.music?.playbackSpeed ?? readPlaybackSpeedPreference());
    }
    if (audioEventsInstalled) return;
    audioEventsInstalled = true;
    audio.addEventListener("play", () => {
      state.music.playing = true;
      setPlaybackError("");
      reportPlayedOnce();
      startMusicVisualizer();
      updatePlaybackUi();
    });
    audio.addEventListener("pause", () => {
      state.music.playing = false;
      saveProgressSoon(null, { immediate: true });
      stopMusicVisualizer({ draw: true });
      updatePlaybackUi();
    });
    audio.addEventListener("loadedmetadata", () => {
      const position = Number(state.music.current?.positionMs || 0);
      if (position > 0 && Number.isFinite(audio.duration) && position / 1000 < audio.duration - 3) {
        audio.currentTime = position / 1000;
      }
      updatePlaybackUi();
    });
    audio.addEventListener("timeupdate", () => {
      updatePlaybackUi();
      updateLyricHighlight();
      saveProgressSoon();
    });
    audio.addEventListener("ended", () => {
      saveProgressSoon(0, { immediate: true });
      if (state.music.repeat === "one") {
        audio.currentTime = 0;
        playAudio();
        return;
      }
      playAdjacent(1, { autoplay: true, wrap: state.music.repeat === "all" }).catch(showError);
    });
    audio.addEventListener("error", () => {
      setPlaybackError("音频播放失败，请尝试其他歌曲或检查音频格式");
      stopMusicVisualizer({ draw: true });
      updatePlaybackUi();
    });
    installMediaSessionHandlers();
  }

  function enter(options = {}) {
    ensureState();
    state.selectedPersonId = null;
    state.selectedPerson = null;
    state.works = [];
    state.personWorksTotal = 0;
    state.personWorksFacets = null;
    hidePersonProfile();
    disconnectPeopleIndexAutoload();
    cancelScheduledWorkRendering();
    resetProgressiveCoverLoading();
    setMainHeader("音乐", "本地无损音乐库");
    setMusicBodyClass();
    renderStats();
    if (options.deferInitialLoad) {
      renderView();
      return;
    }
    if (!state.music.data || options.reload) {
      loadMusic({ skipRoute: true, keepCurrent: true }).catch(showError);
    } else {
      renderView();
    }
    syncRouteAfterNavigation(options);
  }

  function applyRouteState(route = {}) {
    ensureState();
    trackReturnContext = null;
    state.music.libraryDrawerOpen = false;
    state.music.trackPageOpen = Boolean(route.musicTrackId);
    state.music.playerStageOpen = false;
    state.music.mode = route.musicMode || "home";
    state.music.query = route.musicQuery || "";
    state.music.artistId = route.musicArtistId || "all";
    state.music.albumId = route.musicAlbumId || "all";
    state.music.genre = route.musicGenre || "all";
    state.music.language = route.musicLanguage || "all";
    state.music.activePlaylistId = route.musicPlaylistId || "";
    state.music.activeSmartPlaylistId = route.musicSmartId || "";
    state.music.sort = route.musicSort || "album";
    state.music.artistSort = route.musicArtistSort === "name" ? "name" : "count";
    state.music.albumSort = ["updated", "title", "year", "tracks"].includes(route.musicAlbumSort) ? route.musicAlbumSort : "updated";
    state.music.favorite = Boolean(route.musicFavorite);
  }

  async function openRouteTarget(route = {}) {
    ensureState();
    if (route.musicTrackId) {
      await openTrack(route.musicTrackId, { skipRoute: true, autoplay: false, openPage: true });
      if (!state.music.data) loadMusic({ skipRoute: true, keepCurrent: true }).catch(showError);
      return;
    }
    state.music.current = null;
    state.music.lyrics = { raw: "", lines: [] };
    await loadMusic({ skipRoute: true, keepCurrent: true });
  }

  async function loadMusic(options = {}) {
    ensureState();
    const artistMode = state.music.mode === "artists";
    const albumMode = state.music.mode === "albums";
    const append = Boolean(options.append && (state.music.mode === "library" || artistMode || albumMode));
    const appendScrollTop = append ? Math.max(0, Number(document.querySelector(".music-track-panel")?.scrollTop || 0)) : 0;
    const generation = ++musicLoadGeneration;
    musicLoadController?.abort();
    const controller = new AbortController();
    musicLoadController = controller;
    const request = (path) => api(path, { signal: controller.signal });
    state.music.loading = !append;
    state.music.loadingMore = append;
    state.music.status = append ? "正在加载更多" : "正在读取音乐库";
    if (!els.workGrid?.querySelector?.(".music-shell")) renderView();
    setMusicListLoadingState(true, { append });
    const listsPromise = append ? Promise.resolve() : Promise.all([
      sideListCacheFresh(state.music.playlistsLoadedAt) ? Promise.resolve() : loadPlaylists(controller.signal),
      sideListCacheFresh(state.music.smartPlaylistsLoadedAt) ? Promise.resolve() : loadSmartPlaylists(controller.signal)
    ]);
    const params = musicListParams();
    params.set("limit", String(artistMode ? MUSIC_ARTIST_PAGE_LIMIT : albumMode ? MUSIC_ALBUM_PAGE_LIMIT : MUSIC_PAGE_LIMIT));
    if (append) params.set("offset", String(artistMode
      ? state.music.data?.artists?.length || 0
      : albumMode
        ? state.music.data?.albums?.length || 0
        : state.music.data?.rawLoaded ?? state.music.data?.tracks?.length ?? 0));
    let data;
    try {
      if (artistMode) {
        const artistParams = new URLSearchParams();
        artistParams.set("limit", String(MUSIC_ARTIST_PAGE_LIMIT));
        artistParams.set("sort", state.music.artistSort);
        if (append) artistParams.set("offset", params.get("offset") || "0");
        if (state.music.query) artistParams.set("q", state.music.query);
        if (state.music.language && state.music.language !== "all") artistParams.set("language", state.music.language);
        if (state.music.letter) artistParams.set("letter", state.music.letter);
        data = await request(`/api/music/artists?${artistParams}`);
      } else if (albumMode) {
        const albumParams = new URLSearchParams();
        albumParams.set("limit", String(MUSIC_ALBUM_PAGE_LIMIT));
        albumParams.set("sort", state.music.albumSort);
        if (append) albumParams.set("offset", params.get("offset") || "0");
        if (state.music.query) albumParams.set("q", state.music.query);
        if (state.music.language && state.music.language !== "all") albumParams.set("language", state.music.language);
        if (state.music.letter) albumParams.set("letter", state.music.letter);
        data = await request(`/api/music/albums?${albumParams}`);
      } else if (state.music.mode === "history") {
        data = await request(`/api/music/history?limit=${MUSIC_PAGE_LIMIT}`);
      } else if (state.music.mode === "playlist" && state.music.activePlaylistId) {
        data = await request(`/api/music/playlists/${encodeURIComponent(state.music.activePlaylistId)}`);
      } else if (state.music.mode === "smart" && state.music.activeSmartPlaylistId) {
        data = await request(`/api/music/smart-playlists/${encodeURIComponent(state.music.activeSmartPlaylistId)}?limit=${MUSIC_PAGE_LIMIT}${append ? `&offset=${params.get("offset")}` : ""}`);
      } else if (state.music.mode === "report") {
        data = await request("/api/music/report");
      } else if (state.music.mode === "home") {
        const homeParams = new URLSearchParams();
        homeParams.set("limit", "80");
        homeParams.set("sort", "played");
        data = await request(`/api/music/tracks?${homeParams}`);
      } else {
        state.music.mode = "library";
        data = await request(`/api/music/tracks?${params}`);
      }
      await listsPromise;
    } catch (error) {
      if (controller.signal.aborted || generation !== musicLoadGeneration) return;
      state.music.loading = false;
      state.music.loadingMore = false;
      state.music.status = error?.message || "音乐列表读取失败";
      musicLoadController = null;
      setMusicListLoadingState(false);
      renderView();
      throw error;
    }
    if (controller.signal.aborted || generation !== musicLoadGeneration) return;
    const incomingTracks = data.tracks || [];
    const previousRawTracks = append ? state.music.data?.rawTracks || state.music.data?.tracks || [] : [];
    const mergedRawTracks = append ? [...previousRawTracks, ...incomingTracks] : incomingTracks;
    const mergedTracks = state.music.mode === "library" && state.music.query
      ? collapseDuplicateTracks(mergedRawTracks)
      : mergedRawTracks;
    const previousArtists = append && artistMode ? state.music.data?.artists || [] : [];
    const mergedArtists = artistMode ? (append ? [...previousArtists, ...(data.artists || [])] : data.artists || []) : data.artists;
    const previousAlbums = append && albumMode ? state.music.data?.albums || [] : [];
    const mergedAlbums = albumMode ? (append ? [...previousAlbums, ...(data.albums || [])] : data.albums || []) : data.albums;
    state.music.data = artistMode
      ? { ...data, artists: mergedArtists, tracks: [] }
      : albumMode
        ? { ...data, albums: mergedAlbums, tracks: [] }
        : { ...data, tracks: mergedTracks, rawTracks: mergedRawTracks, rawLoaded: mergedRawTracks.length };
    state.music.summary = data.summary || state.music.summary;
    state.music.artists = mergedArtists || state.music.artists || [];
    state.music.albums = mergedAlbums || state.music.albums || [];
    state.music.genres = data.genres || state.music.genres || [];
    state.music.languages = data.languages || data.summary?.languages || state.music.languages || [];
    state.music.activePlaylist = data.playlist || null;
    state.music.activeSmartPlaylist = data.smartPlaylist || null;
    if (!artistMode && !albumMode && !state.music.current) state.music.queue = mergedTracks;
    state.music.loading = false;
    state.music.loadingMore = false;
    state.music.hasMore = Boolean(data.hasMore);
    state.music.status = artistMode
      ? (data.total ? "" : "没有匹配的歌手")
      : albumMode
        ? (data.total ? "" : "没有匹配的专辑")
        : emptyMusicMessage(data.total || state.music.queue.length);
    if (!artistMode && !albumMode && options.restoreLast !== false) await restoreLastTrack();
    musicLoadController = null;
    setMusicListLoadingState(false);
    const appendedInPlace = append && (artistMode
      ? appendArtistPage(data.artists || [], previousArtists.length)
      : albumMode
        ? appendAlbumPage(data.albums || [], previousAlbums.length)
        : Boolean(state.music.current)
          && state.music.mode === "library"
          && !state.music.query
          && appendLibraryTrackPage(incomingTracks, previousRawTracks.length));
    if (appendedInPlace) return;
    renderStats();
    if (!refreshMusicLibraryContent()) renderView();
    if (append) restoreMusicPanelScroll(appendScrollTop);
    if (!options.skipRoute) {
      const writer = options.replaceRoute ? replaceRoute : pushRoute;
      writer(musicRouteOverrides());
    }
  }

  async function loadPlaylists(signal) {
    try {
      const data = await api("/api/music/playlists", { signal });
      state.music.playlists = data.playlists || [];
      state.music.playlistsLoadedAt = Date.now();
    } catch {
      state.music.playlists = state.music.playlists || [];
    }
  }

  async function loadSmartPlaylists(signal) {
    try {
      const data = await api("/api/music/smart-playlists", { signal });
      state.music.smartPlaylists = data.smartPlaylists || [];
      state.music.smartPlaylistsLoadedAt = Date.now();
    } catch {
      state.music.smartPlaylists = state.music.smartPlaylists || [];
    }
  }

  function sideListCacheFresh(loadedAt) {
    return Number(loadedAt || 0) > 0 && Date.now() - Number(loadedAt) < MUSIC_SIDE_LIST_CACHE_MS;
  }

  function clearMusicSuggestions() {
    window.clearTimeout(suggestTimer);
    suggestController?.abort();
    suggestController = null;
    state.music.suggestionQuery = "";
    state.music.suggestions = { query: "", tracks: [], artists: [], albums: [] };
    if (suggestionBox) renderMusicSuggestions(suggestionBox);
  }

  function queueMusicSuggest(query) {
    window.clearTimeout(suggestTimer);
    suggestController?.abort();
    suggestController = null;
    const normalized = String(query || "").trim();
    state.music.suggestionQuery = normalized;
    if (state.music.mode !== "library" || Array.from(normalized).length < MUSIC_SUGGEST_MIN_CHARACTERS) {
      clearMusicSuggestions();
      return;
    }
    const cached = suggestionCache.get(suggestionCacheKey(normalized));
    if (cached) {
      state.music.suggestions = { ...cached, query: normalized };
      if (suggestionBox) renderMusicSuggestions(suggestionBox);
      return;
    }
    suggestTimer = window.setTimeout(() => {
      loadMusicSuggestions(normalized).catch(() => {});
    }, 160);
  }

  async function loadMusicSuggestions(query) {
    const normalized = String(query || "").trim();
    if (!normalized) return;
    const key = suggestionCacheKey(normalized);
    const cached = suggestionCache.get(key);
    if (cached) {
      if (state.music.mode === "library" && state.music.query === normalized) {
        state.music.suggestions = { ...cached, query: normalized };
        if (suggestionBox) renderMusicSuggestions(suggestionBox);
      }
      return;
    }
    suggestController?.abort();
    const controller = new AbortController();
    suggestController = controller;
    let data;
    try {
      data = await api(`/api/music/suggest?q=${encodeURIComponent(normalized)}`, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) return;
      throw error;
    } finally {
      if (suggestController === controller) suggestController = null;
    }
    if (controller.signal.aborted) return;
    const suggestions = data
      ? { ...data, query: normalized, tracks: collapseDuplicateTracks(data.tracks || []) }
      : { query: normalized, tracks: [], artists: [], albums: [] };
    rememberSuggestionCache(key, suggestions);
    if (state.music.mode !== "library" || state.music.query !== normalized) return;
    state.music.suggestions = suggestions;
    if (suggestionBox) renderMusicSuggestions(suggestionBox);
  }

  function suggestionCacheKey(query) {
    return String(query || "").trim().toLocaleLowerCase();
  }

  function rememberSuggestionCache(key, suggestions) {
    if (!key) return;
    suggestionCache.delete(key);
    suggestionCache.set(key, suggestions);
    while (suggestionCache.size > 24) suggestionCache.delete(suggestionCache.keys().next().value);
  }

  async function openTrack(trackId, options = {}) {
    ensureState();
    if (!trackId) return;
    const previousTrackId = state.music.current?.id || "";
    if (state.music.current?.id === trackId && audio?.src && !options.forceReload) {
      if (trackOpenController) {
        trackOpenGeneration += 1;
        trackOpenController.abort();
        trackOpenController = null;
        state.music.openingTrackId = "";
        state.music.status = "";
        setTrackOpeningState("");
      }
      if (options.openPage) {
        state.music.trackPageOpen = true;
        state.music.playerStageOpen = false;
        renderView();
        if (!options.skipRoute) pushRoute({ ...musicRouteOverrides(), musicTrackId: trackId });
      }
      if (options.autoplay !== false) playAudio();
      return state.music.current;
    }
    if (state.music.current?.id && state.music.current.id !== trackId) {
      saveProgressSoon(null, { immediate: true });
    }
    const generation = ++trackOpenGeneration;
    trackOpenController?.abort();
    const controller = new AbortController();
    trackOpenController = controller;
    state.music.openingTrackId = trackId;
    state.music.status = "正在打开歌曲";
    setTrackOpeningState(trackId);
    let data;
    try {
      data = await api(`/api/music/tracks/${encodeURIComponent(trackId)}?${musicListParams()}`, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted || generation !== trackOpenGeneration) return null;
      state.music.openingTrackId = "";
      state.music.status = error?.message || "歌曲打开失败";
      trackOpenController = null;
      setTrackOpeningState("");
      if (state.activeView === "music") renderView();
      throw error;
    }
    if (controller.signal.aborted || generation !== trackOpenGeneration) return null;
    if (!data?.track?.id) {
      state.music.openingTrackId = "";
      state.music.status = "歌曲资料不完整";
      trackOpenController = null;
      setTrackOpeningState("");
      if (state.activeView === "music") renderView();
      throw new Error(state.music.status);
    }
    state.music.current = data.track;
    state.music.lyrics = data.lyrics || { raw: "", lines: [] };
    state.music.prevId = data.prevId || "";
    state.music.nextId = data.nextId || "";
    state.music.openingTrackId = "";
    state.music.status = "";
    state.music.playReportedTrackId = "";
    state.music.lyricFollowPaused = false;
    state.music.libraryDrawerOpen = false;
    const shouldOpenPage = Boolean(options.openPage || state.music.trackPageOpen);
    state.music.trackPageOpen = shouldOpenPage;
    state.music.playerStageOpen = false;
    currentLyricIndex = -1;
    if (!state.music.queue.length || !state.music.queue.some((track) => track.id === data.track.id)) {
      state.music.queue = [data.track];
    }
    rememberLastTrack(data.track);
    loadAudioTrack(data.track, options.autoplay !== false);
    trackOpenController = null;
    setTrackOpeningState("");
    if (state.activeView === "music") {
      if (shouldOpenPage || !refreshCurrentTrackSurfaces(previousTrackId)) renderView();
    }
    if (!options.skipRoute && shouldOpenPage) {
      pushRoute({ ...musicRouteOverrides(), musicTrackId: data.track.id });
    }
    return data.track;
  }

  function openTrackFromList(track, tracks = [], options = {}) {
    const item = normalizeQueueTrack(track);
    if (!item) return Promise.resolve(null);
    const source = uniqueQueueTracks(tracks);
    state.music.queue = source.some((candidate) => candidate.id === item.id) ? source : [item];
    state.music.queueVisibleLimit = DESKTOP_QUEUE_PAGE_SIZE;
    return openTrack(item.id, options);
  }

  function uniqueQueueTracks(tracks = []) {
    const seen = new Set();
    const result = [];
    for (const track of tracks || []) {
      const item = normalizeQueueTrack(track);
      if (!item?.id || seen.has(item.id)) continue;
      seen.add(item.id);
      result.push(item);
    }
    return result;
  }

  function setTrackOpeningState(trackId = "") {
    const shell = els.workGrid?.querySelector?.(".music-shell");
    const opening = Boolean(trackId);
    const affectedTrackIds = new Set([openingTrackElementId, trackId].filter(Boolean));
    openingTrackElementId = trackId;
    if (!shell) return;
    shell.classList.toggle("track-loading", opening);
    if (opening) shell.setAttribute("aria-busy", "true");
    else shell.removeAttribute("aria-busy");
    for (const affectedTrackId of affectedTrackIds) {
      const elements = (musicTrackElementMap.get(affectedTrackId) || []).filter((item) => item?.isConnected);
      if (elements.length) musicTrackElementMap.set(affectedTrackId, elements);
      else musicTrackElementMap.delete(affectedTrackId);
      for (const item of elements) {
        const active = opening && affectedTrackId === trackId;
        item.classList.toggle("opening", active);
        if (active) item.setAttribute("aria-busy", "true");
        else item.removeAttribute("aria-busy");
      }
    }
  }

  function setMusicListLoadingState(loading, { append = false } = {}) {
    const panel = els.workGrid?.querySelector?.(".music-track-panel");
    if (!panel) return;
    panel.classList.toggle("list-loading", loading);
    if (loading) panel.setAttribute("aria-busy", "true");
    else panel.removeAttribute("aria-busy");
    let badge = panel.querySelector(".music-list-loading-badge");
    if (loading) {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "music-list-loading-badge";
        badge.setAttribute("role", "status");
        badge.setAttribute("aria-live", "polite");
        (panel.querySelector(".music-panel-heading") || panel).append(badge);
      }
      badge.textContent = append ? "正在加载更多" : "正在更新";
    } else {
      badge?.remove();
    }
    const more = panel.querySelector(".music-load-more");
    if (more && loading && append) {
      more.disabled = true;
      more.textContent = "正在加载…";
    }
  }

  function loadAudioTrack(track, autoplay) {
    ensureAudio();
    setPlaybackError("");
    const target = new URL(track.streamUrl, window.location.href).href;
    audio.playbackRate = normalizePlaybackSpeed(state.music.playbackSpeed);
    if (audio.src !== target) {
      audio.src = target;
      audio.load();
    }
    updateMediaSession();
    if (autoplay) playAudio();
  }

  function renderStats() {
    ensureState();
    if (!els.statsRow) return;
    const totals = state.music.summary?.totals || state.music.data?.summary?.totals || {};
    const items = [
      ["歌曲", formatNumber(totals.tracks || 0)],
      ["歌手", formatNumber(totals.artists || 0)],
      ["专辑", formatNumber(totals.albums || 0)],
      ["听过", formatNumber(totals.listenedTracks || 0)],
      ["播放", formatNumber(totals.plays || 0)],
      ["容量", formatBytes(totals.bytes || 0)]
    ];
    const renderKey = JSON.stringify(items);
    const mountedStats = [...els.statsRow.children];
    if (els.statsRow.dataset.musicStatsKey === renderKey
      && mountedStats.length === items.length
      && mountedStats.every((item) => item.classList.contains("music-stat"))) return;
    els.statsRow.dataset.musicStatsKey = renderKey;
    els.statsRow.innerHTML = "";
    for (const [label, value] of items) {
      const stat = document.createElement("div");
      stat.className = "stat music-stat";
      const strong = document.createElement("strong");
      strong.textContent = String(value);
      const span = document.createElement("span");
      span.textContent = label;
      stat.append(strong, span);
      els.statsRow.append(stat);
    }
  }

  function renderView() {
    ensureState();
    if (!els.workGrid) return;
    const inputFocus = captureMusicInputFocus();
    setMusicBodyClass();
    currentProgressEls = null;
    playbackButtonEls = [];
    currentTrackIndicatorMap = new Map();
    musicTrackElementMap = new Map();
    openingTrackElementId = "";
    playbackSurfaceEls = [];
    playbackErrorEls = [];
    shuffleControlEls = [];
    repeatControlEls = [];
    sleepTimerControlEls = [];
    lyricLineEls = [];
    lyricFollowButtonEls = [];
    activeLyricElement = null;
    suggestionBox = null;
    currentLyricIndex = -1;
    if (lyricRaf) window.cancelAnimationFrame(lyricRaf);
    lyricRaf = 0;
    stopMusicVisualizer();
    visualizerCanvas = null;
    els.workGrid.innerHTML = "";

    const shell = document.createElement("section");
    const trackPageOpen = Boolean(state.music.trackPageOpen && state.music.current);
    shell.className = `music-shell${trackPageOpen ? " music-track-page" : " music-library-page"}`;
    if (trackPageOpen) shell.append(renderPlayerStage(), renderPlaylistDialog());
    else shell.append(renderLibraryLayout(), renderPlayerBar(), renderPlaylistDialog());
    els.workGrid.append(shell);
    setTrackOpeningState(state.music.openingTrackId);
    setMusicListLoadingState(Boolean(state.music.loading || state.music.loadingMore), { append: state.music.loadingMore });
    restoreMusicInputFocus(shell, inputFocus);
    updatePlaybackUi();
    updateLyricHighlight(!state.music.lyricFollowPaused);
    startMusicVisualizer();
  }

  function refreshMusicLibraryContent() {
    const shell = els.workGrid?.querySelector?.(".music-shell.music-library-page");
    const currentPanel = shell?.querySelector?.(".music-track-panel");
    if (!shell || !currentPanel || state.music.trackPageOpen) return false;
    const mountedTrackId = shell.querySelector(".music-now-panel")?.dataset.musicTrackId || "";
    const inputFocus = captureMusicInputFocus();
    unregisterMusicTrackElements(currentPanel);
    currentTrackIndicatorMap = new Map();
    suggestionBox = null;
    const nextPanel = renderTrackPanel();
    currentPanel.replaceWith(nextPanel);
    refreshLibrarySidebars();
    setTrackOpeningState(state.music.openingTrackId);
    setMusicListLoadingState(Boolean(state.music.loading || state.music.loadingMore), { append: state.music.loadingMore });
    restoreMusicInputFocus(nextPanel, inputFocus);
    const surfacedTrackId = state.music.current?.id || state.music.queue[0]?.id || "";
    if (mountedTrackId !== surfacedTrackId && !refreshCurrentTrackSurfaces(mountedTrackId)) return false;
    return true;
  }

  function captureMusicInputFocus() {
    const input = document.activeElement;
    const key = String(input?.dataset?.musicSearch || "");
    if (!key) return null;
    return {
      key,
      start: Number.isFinite(input.selectionStart) ? input.selectionStart : String(input.value || "").length,
      end: Number.isFinite(input.selectionEnd) ? input.selectionEnd : String(input.value || "").length
    };
  }

  function restoreMusicInputFocus(shell, focus) {
    if (!focus?.key) return;
    const input = shell.querySelector(`[data-music-search="${focus.key}"]`);
    if (!input) return;
    input.focus({ preventScroll: true });
    const length = String(input.value || "").length;
    input.setSelectionRange(Math.min(length, focus.start), Math.min(length, focus.end));
  }

  function renderHero() {
    const summary = state.music.summary || state.music.data?.summary || {};
    const totals = summary.totals || {};
    const hero = document.createElement("section");
    hero.className = "music-hero";
    const copy = document.createElement("div");
    copy.className = "music-hero-copy";
    const eyebrow = document.createElement("div");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "本地音乐";
    const title = document.createElement("h2");
    title.textContent = "音乐";
    const meta = document.createElement("p");
    const rootText = (summary.roots || []).map((root) => root.path).filter(Boolean)[0] || "D:\\Music";
    meta.textContent = `${formatNumber(totals.tracks || 0)} 首 · ${formatNumber(totals.albums || 0)} 张专辑 · ${formatDuration(totals.durationMs || 0)} · ${rootText}`;
    copy.append(eyebrow, title, meta);

    const actions = document.createElement("div");
    actions.className = "music-hero-actions";
    const scan = document.createElement("button");
    scan.type = "button";
    scan.className = "music-primary-button";
    scan.textContent = state.music.rescanning ? "刷新中" : "刷新音乐库";
    scan.disabled = Boolean(state.music.rescanning);
    scan.addEventListener("click", () => startMusicRescan().catch(showError));
    const play = document.createElement("button");
    play.type = "button";
    play.className = "music-secondary-button";
    play.textContent = state.music.current ? "继续播放" : "播放全部";
    play.disabled = !(state.music.current || state.music.queue.length);
    play.addEventListener("click", () => {
      if (state.music.current) togglePlayback();
      else openTrack(state.music.queue[0]?.id, { autoplay: true }).catch(showError);
    });
    actions.append(play, scan);
    hero.append(copy, actions);
    return hero;
  }

  function renderLibraryLayout() {
    const layout = document.createElement("section");
    layout.className = "music-layout";
    layout.append(renderLibraryLauncher(), renderSidebar({ embedded: true }), renderTrackPanel(), renderNowPanel());
    if (state.music.libraryDrawerOpen) layout.append(renderLibraryDrawer());
    return layout;
  }

  function renderLibraryLauncher() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "music-library-launcher";
    button.setAttribute("aria-controls", "music-library-drawer");
    button.setAttribute("aria-expanded", String(Boolean(state.music.libraryDrawerOpen)));
    button.setAttribute("aria-label", "打开音乐资料库");
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "☰";
    const label = document.createElement("strong");
    label.textContent = "资料库";
    button.append(icon, label);
    button.addEventListener("click", openLibraryDrawer);
    return button;
  }

  function renderLibraryDrawer() {
    const layer = document.createElement("div");
    layer.className = "music-library-layer";
    const backdrop = document.createElement("button");
    backdrop.type = "button";
    backdrop.className = "music-library-backdrop";
    backdrop.setAttribute("aria-label", "关闭音乐资料库");
    backdrop.addEventListener("click", closeLibraryDrawer);
    layer.append(backdrop, renderSidebar());
    return layer;
  }

  function openLibraryDrawer() {
    state.music.libraryDrawerOpen = true;
    if (!refreshLibraryDrawer({ focus: true })) renderView();
  }

  function closeLibraryDrawer() {
    state.music.libraryDrawerOpen = false;
    if (!refreshLibraryDrawer({ focus: true })) renderView();
  }

  function closeLibraryDrawerBefore(action) {
    state.music.libraryDrawerOpen = false;
    refreshLibraryDrawer();
    action();
  }

  function refreshLibraryDrawer({ focus = false } = {}) {
    const layout = els.workGrid?.querySelector?.(".music-layout");
    if (!layout) return false;
    layout.querySelector(".music-library-layer")?.remove();
    const launcher = layout.querySelector(".music-library-launcher");
    launcher?.setAttribute("aria-expanded", String(Boolean(state.music.libraryDrawerOpen)));
    if (state.music.libraryDrawerOpen) layout.append(renderLibraryDrawer());
    if (focus) {
      const target = state.music.libraryDrawerOpen
        ? layout.querySelector(".music-sidebar-close")
        : launcher;
      target?.focus({ preventScroll: true });
    }
    return true;
  }

  function renderSidebar({ embedded = false } = {}) {
    const side = document.createElement("aside");
    side.className = `music-sidebar${embedded ? " embedded" : ""}`;
    side.dataset.musicSidebarKey = musicSidebarRenderKey();
    if (!embedded) side.id = "music-library-drawer";
    side.setAttribute("aria-label", "音乐资料库");
    const drawerHeader = document.createElement("div");
    drawerHeader.className = "music-sidebar-header";
    const drawerTitle = document.createElement("strong");
    drawerTitle.textContent = "资料库";
    const drawerActions = document.createElement("div");
    drawerActions.className = "music-sidebar-head-actions";
    const scan = document.createElement("button");
    scan.type = "button";
    scan.className = "music-sidebar-scan";
    scan.textContent = state.music.rescanning ? "刷新中" : "刷新";
    scan.disabled = Boolean(state.music.rescanning);
    scan.addEventListener("click", () => startMusicRescan().catch(showError));
    const close = document.createElement("button");
    close.type = "button";
    close.className = "music-sidebar-close";
    close.textContent = "×";
    close.setAttribute("aria-label", "关闭音乐资料库");
    close.addEventListener("click", closeLibraryDrawer);
    drawerActions.append(scan);
    if (!embedded) drawerActions.append(close);
    drawerHeader.append(drawerTitle, drawerActions);
    const libraryList = document.createElement("div");
    libraryList.className = "music-artist-list";
    libraryList.append(filterButton("home", "发现", "", state.music.mode === "home", () => {
      selectMusicMode("home");
    }));
    libraryList.append(filterButton("library", "全部歌曲", state.music.summary?.totals?.tracks || state.music.data?.total || 0, state.music.mode === "library" && !state.music.favorite, () => {
      selectMusicMode("library");
    }));
    libraryList.append(filterButton("artists", "歌手浏览", state.music.summary?.totals?.artists || 0, state.music.mode === "artists", () => {
      selectMusicMode("artists");
    }));
    libraryList.append(filterButton("albums", "专辑浏览", state.music.summary?.totals?.albums || 0, state.music.mode === "albums", () => {
      selectMusicMode("albums");
    }));
    libraryList.append(filterButton("history", "最近播放", state.music.summary?.recent?.length || 0, state.music.mode === "history", () => {
      selectMusicMode("history");
    }));
    libraryList.append(filterButton("report", "听歌报告", state.music.summary?.totals?.plays || 0, state.music.mode === "report", () => {
      selectMusicMode("report");
    }));
    libraryList.append(filterButton("favorites", "我喜欢", "", state.music.mode === "library" && state.music.favorite, () => {
      selectMusicMode("library", { favorite: true });
    }));

    const smartList = document.createElement("div");
    smartList.className = "music-playlist-list";
    for (const smart of state.music.smartPlaylists || []) {
      smartList.append(filterButton(smart.id, smart.name, smart.trackCount, state.music.mode === "smart" && state.music.activeSmartPlaylistId === smart.id, () => {
        selectMusicMode("smart", { smartId: smart.id });
      }));
    }
    if (!(state.music.smartPlaylists || []).length) {
      const empty = document.createElement("div");
      empty.className = "music-sidebar-empty";
      empty.textContent = "刷新后自动生成";
      smartList.append(empty);
    }

    const playlists = document.createElement("div");
    playlists.className = "music-playlist-list";
    for (const playlist of state.music.playlists || []) {
      playlists.append(filterButton(playlist.id, playlist.name, playlist.trackCount, state.music.mode === "playlist" && state.music.activePlaylistId === playlist.id, () => {
        selectMusicMode("playlist", { playlistId: playlist.id });
      }));
    }
    const createPlaylistButton = document.createElement("button");
    createPlaylistButton.type = "button";
    createPlaylistButton.className = "music-create-playlist";
    createPlaylistButton.textContent = "新建歌单";
    createPlaylistButton.addEventListener("click", () => openPlaylistDialog().catch(showError));
    playlists.append(createPlaylistButton);
    const importPlaylistButton = document.createElement("button");
    importPlaylistButton.type = "button";
    importPlaylistButton.className = "music-create-playlist";
    importPlaylistButton.textContent = "导入 M3U";
    importPlaylistButton.addEventListener("click", () => importPlaylistM3uFromPrompt().catch(showError));
    playlists.append(importPlaylistButton);

    const languageList = document.createElement("div");
    languageList.className = "music-artist-list music-language-list";
    languageList.append(filterButton("all", "全部", state.music.summary?.totals?.tracks || "", state.music.language === "all", () => {
      state.music.language = "all";
      state.music.artistId = "all";
      state.music.albumId = "all";
      loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
    }));
    for (const language of state.music.languages || []) {
      languageList.append(filterButton(language.id || language.name, language.name, language.trackCount, state.music.language === language.name, () => {
        if (!["artists", "albums"].includes(state.music.mode)) state.music.mode = "library";
        state.music.language = language.name || "all";
        state.music.artistId = "all";
        state.music.albumId = "all";
        state.music.genre = "all";
        loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
      }));
    }

    const genreList = document.createElement("div");
    genreList.className = "music-artist-list";
    for (const genre of (state.music.genres || []).slice(0, 24)) {
      genreList.append(filterButton(genre.id || genre.name, genre.name, genre.trackCount, state.music.mode === "library" && state.music.genre === genre.name, () => {
        state.music.mode = "library";
        state.music.favorite = false;
        state.music.activePlaylistId = "";
        state.music.activeSmartPlaylistId = "";
        state.music.artistId = "all";
        state.music.albumId = "all";
        state.music.genre = genre.name || "all";
        loadMusic({ replaceRoute: true }).catch(showError);
      }));
    }

    const artistList = document.createElement("div");
    artistList.className = "music-artist-list";
    for (const artist of (state.music.artists || []).slice(0, 8)) {
      artistList.append(filterButton(artist.id, artist.name, artist.trackCount, state.music.mode === "library" && state.music.artistId === artist.id, () => {
        state.music.mode = "library";
        state.music.favorite = false;
        state.music.activePlaylistId = "";
        state.music.activeSmartPlaylistId = "";
        state.music.artistId = artist.id;
        state.music.albumId = "all";
        state.music.genre = "all";
        loadMusic({ replaceRoute: true }).catch(showError);
      }));
    }
    artistList.append(sidebarBrowseButton("查看全部歌手", `${formatNumber(state.music.summary?.totals?.artists || 0)} 位`, () => {
      selectMusicMode("artists");
    }));

    const albums = document.createElement("div");
    albums.className = "music-album-mini-list";
    for (const album of (state.music.albums || []).slice(0, 6)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `music-album-mini${state.music.mode === "library" && state.music.albumId === album.id ? " active" : ""}`;
      button.append(renderCover(album, "tiny"));
      const span = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = album.title;
      const small = document.createElement("small");
      small.textContent = `${album.artistName || "未知歌手"} · ${formatNumber(album.trackCount || 0)} 首`;
      span.append(strong, small);
      button.append(span);
      button.addEventListener("click", () => {
        state.music.libraryDrawerOpen = false;
        state.music.mode = "library";
        state.music.favorite = false;
        state.music.activePlaylistId = "";
        state.music.activeSmartPlaylistId = "";
        state.music.artistId = album.artistId || state.music.artistId || "all";
        state.music.albumId = album.id;
        state.music.genre = "all";
        loadMusic({ replaceRoute: true }).catch(showError);
      });
      albums.append(button);
    }
    albums.append(sidebarBrowseButton("查看全部专辑", `${formatNumber(state.music.summary?.totals?.albums || 0)} 张`, () => {
      selectMusicMode("albums");
    }));

    const smartSection = sidebarSection("智能歌单", smartList, {
      open: state.music.mode === "smart",
      meta: formatNumber((state.music.smartPlaylists || []).length)
    });
    const playlistSection = sidebarSection("歌单", playlists, {
      open: state.music.mode === "playlist",
      meta: formatNumber((state.music.playlists || []).length)
    });
    const languageSection = sidebarSection("语种", languageList, {
      open: state.music.language !== "all",
      meta: state.music.language === "all" ? "全部" : state.music.language
    });
    const genreSection = sidebarSection("风格", genreList, {
      open: state.music.mode === "library" && state.music.genre !== "all",
      meta: state.music.genre === "all" ? formatNumber((state.music.genres || []).length) : state.music.genre
    });
    const artistSection = sidebarSection("歌手", artistList, {
      open: state.music.mode === "artists" || (state.music.mode === "library" && state.music.artistId !== "all"),
      meta: formatNumber(state.music.summary?.totals?.artists || 0)
    });
    const albumSection = sidebarSection("专辑", albums, {
      open: state.music.mode === "albums" || (state.music.mode === "library" && state.music.albumId !== "all"),
      meta: formatNumber(state.music.summary?.totals?.albums || 0)
    });
    side.append(drawerHeader, libraryList, smartSection, playlistSection, languageSection, genreSection, artistSection, albumSection);
    return side;
  }

  function musicSidebarRenderKey() {
    const summary = state.music.summary || state.music.data?.summary || {};
    const totals = summary.totals || {};
    const itemKey = (items, limit = items?.length || 0) => (items || [])
      .slice(0, limit)
      .map((item) => [
        item.id || item.name || item.title || "",
        item.name || item.title || "",
        item.artistName || "",
        Number(item.trackCount || 0),
        Number(item.artistCount || 0),
        Number(item.albumCount || 0)
      ].join(":"))
      .join("|");
    return JSON.stringify([
      state.music.mode,
      state.music.favorite,
      state.music.activePlaylistId,
      state.music.activeSmartPlaylistId,
      state.music.language,
      state.music.genre,
      state.music.artistId,
      state.music.albumId,
      state.music.rescanning,
      Number(totals.tracks || state.music.data?.total || 0),
      Number(totals.artists || 0),
      Number(totals.albums || 0),
      Number(totals.plays || 0),
      Number(summary.recent?.length || 0),
      itemKey(state.music.smartPlaylists),
      itemKey(state.music.playlists),
      itemKey(state.music.languages),
      itemKey(state.music.genres, 24),
      itemKey(state.music.artists, 8),
      itemKey(state.music.albums, 6)
    ]);
  }

  function sidebarSection(label, content, { open = false, meta = "" } = {}) {
    const section = document.createElement("details");
    section.className = "music-sidebar-section";
    section.open = Boolean(open);
    const summary = document.createElement("summary");
    const title = document.createElement("strong");
    title.textContent = label;
    const count = document.createElement("span");
    count.textContent = meta;
    summary.append(title, count);
    const body = document.createElement("div");
    body.className = "music-sidebar-section-content";
    body.append(content);
    section.append(summary, body);
    return section;
  }

  function sidebarBrowseButton(label, meta, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "music-sidebar-more";
    const strong = document.createElement("strong");
    strong.textContent = label;
    const span = document.createElement("span");
    span.textContent = meta;
    button.append(strong, span);
    button.addEventListener("click", () => closeLibraryDrawerBefore(action));
    return button;
  }

  function filterButton(id, label, count, active, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `music-filter-button${active ? " active" : ""}`;
    const strong = document.createElement("strong");
    strong.textContent = label;
    const span = document.createElement("span");
    span.textContent = count === "" || count === null || count === undefined ? "" : formatNumber(count || 0);
    button.append(strong, span);
    button.addEventListener("click", () => closeLibraryDrawerBefore(action));
    return button;
  }

  function renderHomePanel() {
    const panel = document.createElement("section");
    panel.className = "music-track-panel music-home-panel";
    const heading = document.createElement("div");
    heading.className = "music-panel-heading";
    const headingText = document.createElement("span");
    const headingTitle = document.createElement("strong");
    headingTitle.textContent = "发现";
    const headingMeta = document.createElement("small");
    headingMeta.textContent = "从最近播放、常听歌曲、智能歌单、风格、歌手和专辑快速进入";
    headingText.append(headingTitle, headingMeta);
    const headingActions = document.createElement("div");
    headingActions.className = "music-panel-actions";
    const all = document.createElement("button");
    all.type = "button";
    all.className = "music-inline-button";
    all.textContent = "全部歌曲";
    all.addEventListener("click", () => selectMusicMode("library"));
    const create = document.createElement("button");
    create.type = "button";
    create.className = "music-inline-button";
    create.textContent = "新建歌单";
    create.addEventListener("click", () => openPlaylistDialog().catch(showError));
    headingActions.append(all, create);
    heading.append(headingText, headingActions);

    const search = document.createElement("form");
    search.className = "music-home-search";
    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.placeholder = "搜索歌名、歌手、专辑或歌词";
    searchInput.setAttribute("aria-label", "搜索音乐");
    searchInput.setAttribute("enterkeyhint", "search");
    const searchButton = document.createElement("button");
    searchButton.type = "submit";
    searchButton.textContent = "搜索";
    search.addEventListener("submit", (event) => {
      event.preventDefault();
      state.music.mode = "library";
      state.music.query = searchInput.value.trim();
      state.music.favorite = false;
      state.music.activePlaylistId = "";
      state.music.activeSmartPlaylistId = "";
      state.music.artistId = "all";
      state.music.albumId = "all";
      state.music.genre = "all";
      loadMusic({ keepCurrent: true }).catch(showError);
    });
    search.append(searchInput, searchButton);

    const summary = state.music.summary || state.music.data?.summary || {};
    const totals = summary.totals || {};
    const topPlayed = summary.topPlayed?.length ? summary.topPlayed : [];
    const cards = document.createElement("div");
    cards.className = "music-home-cards";
    cards.append(
      homeActionCard("全部歌曲", formatNumber(totals.tracks || state.music.data?.total || 0), "按专辑浏览", () => selectMusicMode("library")),
      homeActionCard("最近播放", formatNumber(summary.recent?.length || 0), "继续听", () => selectMusicMode("history")),
      homeActionCard("常听歌曲", formatNumber(totals.listenedTracks || topPlayed.length || 0), "按播放次数", () => selectMusicMode("smart", { smartId: "topplayed" })),
      homeActionCard("听歌报告", formatNumber(totals.plays || 0), "播放统计", () => selectMusicMode("report")),
      homeActionCard("智能歌单", formatNumber((state.music.smartPlaylists || []).length), "自动整理", () => selectFirstSmartPlaylist()),
      homeActionCard("我喜欢", "♥", "收藏歌曲", () => selectMusicMode("library", { favorite: true }))
    );

    const sections = document.createElement("div");
    sections.className = "music-home-sections";
    const recent = summary.recent?.length ? summary.recent : (state.music.queue || []).slice(0, 8);
    sections.append(
      homeSection("最近播放", "继续刚才的顺序", homeTrackList(recent.slice(0, 8), "还没有最近播放")),
      homeSection("常听歌曲", "按播放次数", homeTrackList(topPlayed.slice(0, 8), "还没有播放统计")),
      homeSection("智能歌单", "动态规则", homeSmartPlaylistList()),
      homeSection("歌单", "自建列表", homePlaylistList()),
      homeSection("风格", "按音乐类型进入", homeGenreList()),
      homeSection("歌手", "按歌手进入", homeArtistList()),
      homeSection("专辑", "按专辑进入", homeAlbumList())
    );
    panel.append(heading, search, cards, sections);
    return panel;
  }

  function renderReportPanel() {
    const data = state.music.data || {};
    const summary = data.summary || state.music.summary || {};
    const counts = data.counts || summary.totals || {};
    const topTracks = data.topTracks || data.tracks || [];
    const panel = document.createElement("section");
    panel.className = "music-track-panel music-report-panel";
    const heading = document.createElement("div");
    heading.className = "music-panel-heading";
    const headingText = document.createElement("span");
    const headingTitle = document.createElement("strong");
    headingTitle.textContent = "听歌报告";
    const headingMeta = document.createElement("small");
    headingMeta.textContent = `${formatNumber(counts.plays || 0)} 次播放 · ${formatNumber(counts.listenedTracks || 0)} 首听过 · ${formatNumber(counts.favorites || 0)} 首收藏`;
    headingText.append(headingTitle, headingMeta);
    const headingActions = document.createElement("div");
    headingActions.className = "music-panel-actions";
    const playTop = document.createElement("button");
    playTop.type = "button";
    playTop.className = "music-inline-button";
    playTop.textContent = "播放常听";
    playTop.disabled = !topTracks.length;
    playTop.addEventListener("click", () => openTrackFromList(topTracks[0], topTracks, { autoplay: true }).catch(showError));
    const home = document.createElement("button");
    home.type = "button";
    home.className = "music-inline-button";
    home.textContent = "返回发现";
    home.addEventListener("click", () => selectMusicMode("home"));
    headingActions.append(playTop, home);
    heading.append(headingText, headingActions);

    const cards = document.createElement("div");
    cards.className = "music-report-cards";
    cards.append(
      reportStatCard("累计播放", formatNumber(counts.plays || 0), "本地记录"),
      reportStatCard("听过歌曲", formatNumber(counts.listenedTracks || 0), `${formatNumber(counts.tracks || 0)} 首入库`),
      reportStatCard("收藏歌曲", formatNumber(counts.favorites || 0), "喜欢的歌"),
      reportStatCard("库时长", formatDuration(counts.durationMs || 0), `${formatNumber(counts.albums || 0)} 张专辑`)
    );

    const sections = document.createElement("div");
    sections.className = "music-home-sections music-report-sections";
    sections.append(
      homeSection("常听歌曲", "按播放次数", homeTrackList(topTracks.slice(0, 8), "还没有播放统计")),
      homeSection("最近播放", "按最后一次播放", homeTrackList((data.recent || []).slice(0, 8), "还没有最近播放")),
      homeSection("常听歌手", "按累计播放", reportArtistList(data.topArtists || [])),
      homeSection("常听专辑", "按累计播放", reportAlbumList(data.topAlbums || []))
    );

    panel.append(heading, cards, reportActivityChart(data.activityMonths || []), sections);
    return panel;
  }

  function reportStatCard(label, value, hint) {
    const card = document.createElement("div");
    card.className = "music-report-card";
    const small = document.createElement("small");
    small.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = String(value);
    const span = document.createElement("span");
    span.textContent = hint;
    card.append(small, strong, span);
    return card;
  }

  function reportActivityChart(months) {
    const section = document.createElement("section");
    section.className = "music-report-chart";
    const head = document.createElement("div");
    head.className = "music-home-section-head";
    const title = document.createElement("strong");
    title.textContent = "播放活跃";
    const meta = document.createElement("small");
    meta.textContent = "最近月份";
    head.append(title, meta);
    const bars = document.createElement("div");
    bars.className = "music-report-bars";
    if (!months.length) {
      bars.append(homeEmpty("听几首歌后这里会有趋势"));
      section.append(head, bars);
      return section;
    }
    const max = Math.max(1, ...months.map((item) => Number(item.plays || 0)));
    for (const item of months) {
      const bar = document.createElement("div");
      bar.className = "music-report-bar";
      bar.title = `${item.month} · ${formatNumber(item.plays || 0)} 次播放`;
      const fill = document.createElement("span");
      fill.style.height = `${Math.max(8, Math.round((Number(item.plays || 0) / max) * 100))}%`;
      const label = document.createElement("small");
      label.textContent = String(item.month || "").slice(5) || item.month || "--";
      bar.append(fill, label);
      bars.append(bar);
    }
    section.append(head, bars);
    return section;
  }

  function reportArtistList(artists) {
    const list = document.createElement("div");
    list.className = "music-home-pill-list";
    if (!artists.length) {
      list.append(homeEmpty("还没有歌手播放统计"));
      return list;
    }
    for (const artist of artists.slice(0, 12)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "music-home-pill";
      button.textContent = `${artist.name || "未知歌手"} · ${formatNumber(artist.plays || 0)} 次`;
      button.addEventListener("click", () => {
        state.music.mode = "library";
        state.music.favorite = false;
        state.music.query = "";
        state.music.activePlaylistId = "";
        state.music.activeSmartPlaylistId = "";
        state.music.artistId = artist.id || "all";
        state.music.albumId = "all";
        state.music.genre = "all";
        loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
      });
      list.append(button);
    }
    return list;
  }

  function reportAlbumList(albums) {
    const list = document.createElement("div");
    list.className = "music-home-list";
    if (!albums.length) {
      list.append(homeEmpty("还没有专辑播放统计"));
      return list;
    }
    for (const album of albums.slice(0, 8)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "music-home-album";
      button.append(renderCover(album, "tiny"));
      const text = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = album.title || "未知专辑";
      const small = document.createElement("small");
      small.textContent = `${album.artistName || "未知歌手"} · ${formatNumber(album.plays || 0)} 次`;
      text.append(strong, small);
      button.append(text);
      button.addEventListener("click", () => {
        state.music.mode = "library";
        state.music.favorite = false;
        state.music.query = "";
        state.music.activePlaylistId = "";
        state.music.activeSmartPlaylistId = "";
        state.music.artistId = album.artistId || "all";
        state.music.albumId = album.id || "all";
        state.music.genre = "all";
        loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
      });
      list.append(button);
    }
    return list;
  }

  function homeActionCard(label, value, hint, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "music-home-card";
    const small = document.createElement("small");
    small.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = String(value);
    const span = document.createElement("span");
    span.textContent = hint;
    button.append(small, strong, span);
    button.addEventListener("click", action);
    return button;
  }

  function homeSection(titleText, metaText, content) {
    const section = document.createElement("section");
    section.className = "music-home-section";
    const head = document.createElement("div");
    head.className = "music-home-section-head";
    const title = document.createElement("strong");
    title.textContent = titleText;
    const meta = document.createElement("small");
    meta.textContent = metaText;
    head.append(title, meta);
    section.append(head, content);
    return section;
  }

  function homeTrackList(tracks, emptyText) {
    const list = document.createElement("div");
    list.className = "music-home-list";
    if (!tracks.length) {
      list.append(homeEmpty(emptyText));
      return list;
    }
    for (const track of tracks) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "music-home-track";
      button.append(renderCover(track, "tiny"));
      const text = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = track.title || "未知歌曲";
      const small = document.createElement("small");
      small.textContent = `${track.artist || "未知歌手"} · ${track.album || "未知专辑"}`;
      text.append(strong, small);
      const time = document.createElement("em");
      time.textContent = formatClock(track.durationMs || 0);
      button.append(text, time);
      button.addEventListener("click", () => openTrackFromList(track, tracks, { autoplay: true }).catch(showError));
      list.append(button);
    }
    return list;
  }

  function homePlaylistList() {
    const list = document.createElement("div");
    list.className = "music-home-list";
    const playlists = (state.music.playlists || []).slice(0, 8);
    for (const playlist of playlists) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "music-home-playlist";
      const strong = document.createElement("strong");
      strong.textContent = playlist.name;
      const small = document.createElement("small");
      small.textContent = `${formatNumber(playlist.trackCount || 0)} 首`;
      button.append(strong, small);
      button.addEventListener("click", () => selectMusicMode("playlist", { playlistId: playlist.id }));
      list.append(button);
    }
    const create = document.createElement("button");
    create.type = "button";
    create.className = "music-home-playlist create";
    create.textContent = "新建歌单";
    create.addEventListener("click", () => openPlaylistDialog().catch(showError));
    list.append(create);
    return list;
  }

  function homeSmartPlaylistList() {
    const list = document.createElement("div");
    list.className = "music-home-list";
    const smartPlaylists = (state.music.smartPlaylists || []).slice(0, 8);
    if (!smartPlaylists.length) {
      list.append(homeEmpty("暂无智能歌单"));
      return list;
    }
    for (const smart of smartPlaylists) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "music-home-smart";
      const badge = document.createElement("b");
      badge.textContent = smart.badge || "智能";
      const text = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = smart.name || "智能歌单";
      const small = document.createElement("small");
      small.textContent = `${formatNumber(smart.trackCount || 0)} 首 · ${smart.description || "动态更新"}`;
      text.append(strong, small);
      button.append(badge, text);
      button.addEventListener("click", () => selectMusicMode("smart", { smartId: smart.id }));
      list.append(button);
    }
    return list;
  }

  function homeGenreList() {
    const list = document.createElement("div");
    list.className = "music-home-pill-list";
    const genres = (state.music.genres || []).slice(0, 12);
    if (!genres.length) {
      list.append(homeEmpty("还没有风格信息"));
      return list;
    }
    for (const genre of genres) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "music-home-pill";
      button.textContent = `${genre.name} · ${formatNumber(genre.trackCount || 0)}`;
      button.addEventListener("click", () => selectGenre(genre.name));
      list.append(button);
    }
    return list;
  }

  function homeArtistList() {
    const list = document.createElement("div");
    list.className = "music-home-pill-list";
    const artists = (state.music.artists || []).slice(0, 12);
    if (!artists.length) {
      list.append(homeEmpty("还没有歌手信息"));
      return list;
    }
    for (const artist of artists) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "music-home-pill";
      button.textContent = `${artist.name} · ${formatNumber(artist.trackCount || 0)}`;
      button.addEventListener("click", () => {
        state.music.mode = "library";
        state.music.favorite = false;
        state.music.activePlaylistId = "";
        state.music.activeSmartPlaylistId = "";
        state.music.artistId = artist.id;
        state.music.albumId = "all";
        state.music.genre = "all";
        loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
      });
      list.append(button);
    }
    return list;
  }

  function homeAlbumList() {
    const list = document.createElement("div");
    list.className = "music-home-album-grid";
    const albums = (state.music.albums || []).slice(0, 8);
    if (!albums.length) {
      list.append(homeEmpty("还没有专辑信息"));
      return list;
    }
    for (const album of albums) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "music-home-album";
      button.append(renderCover(album, "tiny"));
      const text = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = album.title || "未知专辑";
      const small = document.createElement("small");
      small.textContent = `${album.artistName || "未知歌手"} · ${formatNumber(album.trackCount || 0)} 首`;
      text.append(strong, small);
      button.append(text);
      button.addEventListener("click", () => {
        state.music.mode = "library";
        state.music.favorite = false;
        state.music.activePlaylistId = "";
        state.music.activeSmartPlaylistId = "";
        state.music.artistId = album.artistId || "all";
        state.music.albumId = album.id;
        state.music.genre = "all";
        loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
      });
      list.append(button);
    }
    return list;
  }

  function homeEmpty(text) {
    const empty = document.createElement("div");
    empty.className = "music-home-empty";
    empty.textContent = text;
    return empty;
  }

  function renderAlphaIndex(currentLetter) {
    const bar = document.createElement("div");
    bar.className = "music-alpha-index";
    const items = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").concat(["0-9", "待", "#"]);
    for (const item of items) {
      const value = item === "0-9" ? "0" : item;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "music-alpha-index-item" + (currentLetter === value ? " active" : "");
      button.textContent = item;
      button.addEventListener("click", () => {
        state.music.letter = state.music.letter === value ? "" : value;
        loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
      });
      bar.append(button);
    }
    return bar;
  }

  function renderArtistPanel() {
    const panel = document.createElement("section");
    panel.className = "music-track-panel music-artist-browser";

    const heading = document.createElement("div");
    heading.className = "music-panel-heading";
    const headingText = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = state.music.language && state.music.language !== "all" ? `${state.music.language}歌手` : "全部歌手";
    const meta = document.createElement("small");
    meta.textContent = `${formatNumber(state.music.data?.total || 0)} 位 · ${state.music.artistSort === "name" ? "按名称排序" : "按歌曲数排序"}`;
    headingText.append(title, meta);
    heading.append(headingText);

    const controls = document.createElement("div");
    controls.className = "music-artist-browser-controls";
    const search = document.createElement("input");
    search.type = "search";
    search.dataset.musicSearch = "artists";
    search.value = state.music.query || "";
    search.placeholder = "搜索歌手";
    search.setAttribute("aria-label", "搜索歌手");
    search.addEventListener("input", () => {
      state.music.query = search.value.trim();
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(
        () => loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError),
        MUSIC_CATALOG_SEARCH_DEBOUNCE_MS
      );
    });
    const sort = document.createElement("select");
    sort.setAttribute("aria-label", "歌手排序");
    for (const [value, label] of [["count", "歌曲最多"], ["name", "按名称"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = state.music.artistSort === value;
      sort.append(option);
    }
    sort.addEventListener("change", () => {
      state.music.artistSort = sort.value === "name" ? "name" : "count";
      loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
    });
    controls.append(search, sort);

    const alphaIndex = renderAlphaIndex(state.music.letter);

    const languages = document.createElement("div");
    languages.className = "music-artist-language-tabs";
    const languageItems = [{ name: "all", label: "全部", artistCount: state.music.summary?.totals?.artists || 0 }, ...(state.music.languages || []).map((item) => ({ ...item, label: item.name }))];
    for (const language of languageItems) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = state.music.language === language.name ? "active" : "";
      button.textContent = `${language.label} ${formatNumber(language.artistCount || 0)}`;
      button.addEventListener("click", () => {
        state.music.language = language.name;
        loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
      });
      languages.append(button);
    }

    const grid = document.createElement("div");
    grid.className = "music-artist-browser-grid";
    const artists = state.music.data?.artists || [];
    if (state.music.loading && !artists.length) {
      grid.append(emptyRow("正在读取歌手资料库"));
    } else if (!artists.length) {
      grid.append(emptyRow(state.music.status || "没有匹配的歌手"));
    } else {
      for (const artist of artists) grid.append(renderArtistCard(artist));
    }

    const more = renderArtistLoadMore(artists.length);
    if (more) grid.append(more);

    panel.append(heading, controls, alphaIndex, languages, grid);
    return panel;
  }

  function renderAlbumPanel() {
    const panel = document.createElement("section");
    panel.className = "music-track-panel music-album-browser";

    const heading = document.createElement("div");
    heading.className = "music-panel-heading";
    const headingText = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = state.music.language && state.music.language !== "all" ? `${state.music.language}专辑` : "全部专辑";
    const meta = document.createElement("small");
    const sortText = { updated: "最近入库", title: "按名称", year: "按年份", tracks: "歌曲最多" }[state.music.albumSort] || "最近入库";
    meta.textContent = `${formatNumber(state.music.data?.total || 0)} 张 · ${sortText}`;
    headingText.append(title, meta);
    heading.append(headingText);

    const controls = document.createElement("div");
    controls.className = "music-artist-browser-controls";
    const search = document.createElement("input");
    search.type = "search";
    search.dataset.musicSearch = "albums";
    search.value = state.music.query || "";
    search.placeholder = "搜索专辑或歌手";
    search.setAttribute("aria-label", "搜索专辑");
    search.addEventListener("input", () => {
      state.music.query = search.value.trim();
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(
        () => loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError),
        MUSIC_CATALOG_SEARCH_DEBOUNCE_MS
      );
    });
    const sort = document.createElement("select");
    sort.setAttribute("aria-label", "专辑排序");
    for (const [value, label] of [["updated", "最近入库"], ["title", "按名称"], ["year", "按年份"], ["tracks", "歌曲最多"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = state.music.albumSort === value;
      sort.append(option);
    }
    sort.addEventListener("change", () => {
      state.music.albumSort = ["updated", "title", "year", "tracks"].includes(sort.value) ? sort.value : "updated";
      loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
    });
    controls.append(search, sort);

    const alphaIndex = renderAlphaIndex(state.music.letter);

    const languages = document.createElement("div");
    languages.className = "music-artist-language-tabs";
    const languageItems = [{ name: "all", label: "全部", albumCount: state.music.summary?.totals?.albums || 0 }, ...(state.music.languages || []).map((item) => ({ ...item, label: item.name }))];
    for (const language of languageItems) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = state.music.language === language.name ? "active" : "";
      button.textContent = `${language.label} ${formatNumber(language.albumCount || 0)}`;
      button.addEventListener("click", () => {
        state.music.language = language.name;
        loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
      });
      languages.append(button);
    }

    const grid = document.createElement("div");
    grid.className = "music-album-browser-grid";
    const albums = state.music.data?.albums || [];
    if (state.music.loading && !albums.length) {
      grid.append(emptyRow("正在读取专辑资料库"));
    } else if (!albums.length) {
      grid.append(emptyRow(state.music.status || "没有匹配的专辑"));
    } else {
      for (const album of albums) grid.append(renderAlbumCard(album));
    }

    const more = renderAlbumLoadMore(albums.length);
    if (more) grid.append(more);

    panel.append(heading, controls, alphaIndex, languages, grid);
    return panel;
  }

  function renderArtistCard(artist) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "music-artist-browser-card";
    const avatar = document.createElement("b");
    avatar.textContent = Array.from(artist.name || "?")[0] || "?";
    const text = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = artist.name || "未知歌手";
    const detail = document.createElement("small");
    detail.textContent = `${artist.language || "其他"} · ${formatNumber(artist.trackCount || 0)} 首 · ${formatNumber(artist.albumCount || 0)} 专辑`;
    text.append(name, detail);
    button.append(avatar, text);
    button.addEventListener("click", () => selectMusicMode("library", { artistId: artist.id, language: artist.language || "all" }));
    return button;
  }

  function renderAlbumCard(album) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "music-album-browser-card";
    button.append(renderCover(album, "tiny"));
    const text = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = album.title || "未知专辑";
    const detail = document.createElement("small");
    detail.textContent = [album.artistName || "未知歌手", album.year || "", `${formatNumber(album.trackCount || 0)} 首`].filter(Boolean).join(" · ");
    text.append(name, detail);
    button.append(text);
    button.addEventListener("click", () => selectMusicMode("library", {
      artistId: album.artistId || "all",
      albumId: album.id,
      language: album.language || state.music.language || "all"
    }));
    return button;
  }

  function renderArtistLoadMore(artistCount) {
    if (!state.music.hasMore) return null;
    const more = document.createElement("button");
    more.type = "button";
    more.className = "music-load-more";
    more.textContent = state.music.loadingMore ? "正在加载…" : `再加载 ${formatNumber(Math.min(MUSIC_ARTIST_PAGE_LIMIT, Math.max(0, Number(state.music.data?.total || 0) - artistCount)))} 位`;
    more.disabled = state.music.loadingMore;
    more.addEventListener("click", () => loadMusic({ append: true, skipRoute: true, keepCurrent: true }).catch(showError));
    return more;
  }

  function renderAlbumLoadMore(albumCount) {
    if (!state.music.hasMore) return null;
    const more = document.createElement("button");
    more.type = "button";
    more.className = "music-load-more";
    more.textContent = state.music.loadingMore ? "正在加载…" : `再加载 ${formatNumber(Math.min(MUSIC_ALBUM_PAGE_LIMIT, Math.max(0, Number(state.music.data?.total || 0) - albumCount)))} 张`;
    more.disabled = state.music.loadingMore;
    more.addEventListener("click", () => loadMusic({ append: true, skipRoute: true, keepCurrent: true }).catch(showError));
    return more;
  }

  function appendArtistPage(artists, startIndex) {
    const grid = els.workGrid?.querySelector?.(".music-artist-browser-grid");
    if (!grid) return false;
    grid.querySelector(".music-load-more")?.remove();
    const fragment = document.createDocumentFragment();
    for (const artist of artists) fragment.append(renderArtistCard(artist));
    const more = renderArtistLoadMore(startIndex + artists.length);
    if (more) fragment.append(more);
    grid.append(fragment);
    return true;
  }

  function appendAlbumPage(albums, startIndex) {
    const grid = els.workGrid?.querySelector?.(".music-album-browser-grid");
    if (!grid) return false;
    grid.querySelector(".music-load-more")?.remove();
    const fragment = document.createDocumentFragment();
    for (const album of albums) fragment.append(renderAlbumCard(album));
    const more = renderAlbumLoadMore(startIndex + albums.length);
    if (more) fragment.append(more);
    grid.append(fragment);
    return true;
  }

  function renderTrackPanel() {
    if (state.music.mode === "home") return renderHomePanel();
    if (state.music.mode === "report") return renderReportPanel();
    if (state.music.mode === "artists") return renderArtistPanel();
    if (state.music.mode === "albums") return renderAlbumPanel();
    const panel = document.createElement("section");
    panel.className = "music-track-panel";
    const heading = document.createElement("div");
    heading.className = "music-panel-heading";
    const headingText = document.createElement("span");
    const headingTitle = document.createElement("strong");
    headingTitle.textContent = currentMusicTitle();
    const headingMeta = document.createElement("small");
    headingMeta.textContent = currentMusicMeta();
    headingText.append(headingTitle, headingMeta);
    const headingActions = document.createElement("div");
    headingActions.className = "music-panel-actions";
    if (state.music.mode === "history" && (state.music.data?.tracks || []).length) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "music-inline-button";
      clear.textContent = "清空";
      clear.addEventListener("click", () => clearHistory().catch(showError));
      headingActions.append(clear);
    }
    if (state.music.mode === "playlist" && state.music.activePlaylist) {
      const editPlaylist = document.createElement("button");
      editPlaylist.type = "button";
      editPlaylist.className = "music-inline-button";
      editPlaylist.textContent = "编辑";
      editPlaylist.addEventListener("click", () => editActivePlaylist().catch(showError));
      headingActions.append(editPlaylist);
      const exportPlaylist = document.createElement("button");
      exportPlaylist.type = "button";
      exportPlaylist.className = "music-inline-button";
      exportPlaylist.textContent = "导出 M3U";
      exportPlaylist.addEventListener("click", () => downloadPlaylistM3u(state.music.activePlaylist));
      headingActions.append(exportPlaylist);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "music-inline-button danger";
      remove.textContent = "删除歌单";
      remove.addEventListener("click", () => deleteActivePlaylist().catch(showError));
      headingActions.append(remove);
    }
    heading.append(headingText, headingActions);

    const controls = document.createElement("div");
    controls.className = "music-controls";
    const search = document.createElement("div");
    search.className = "music-search";
    const input = document.createElement("input");
    input.type = "search";
    input.dataset.musicSearch = "library";
    input.placeholder = state.music.mode === "library" ? "搜索歌名、歌手、专辑或歌词，找到想听的歌" : "当前列表暂不支持搜索";
    input.setAttribute("aria-label", "搜索音乐");
    input.setAttribute("enterkeyhint", "search");
    input.value = state.music.query || "";
    input.disabled = state.music.mode !== "library";
    input.addEventListener("input", () => {
      state.music.query = input.value.trim();
      queueMusicSuggest(state.music.query);
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(
        () => loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError),
        state.music.query ? MUSIC_LIBRARY_SEARCH_DEBOUNCE_MS : MUSIC_LIBRARY_CLEAR_DEBOUNCE_MS
      );
    });
    input.addEventListener("focus", () => {
      if (suggestionBox) renderMusicSuggestions(suggestionBox);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") clearMusicSuggestions();
      if (event.key === "Enter" && state.music.mode === "library") {
        event.preventDefault();
        window.clearTimeout(searchTimer);
        clearMusicSuggestions();
        loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
      }
    });
    const suggestions = document.createElement("div");
    suggestions.className = "music-search-suggestions";
    suggestionBox = suggestions;
    renderMusicSuggestions(suggestions);
    search.append(input, suggestions);
    const favorite = document.createElement("button");
    favorite.type = "button";
    favorite.className = `music-favorite-filter${state.music.favorite ? " active" : ""}`;
    favorite.textContent = "收藏";
    favorite.disabled = state.music.mode !== "library";
    favorite.addEventListener("click", () => {
      state.music.favorite = !state.music.favorite;
      loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
    });
    const sort = document.createElement("select");
    sort.className = "music-sort";
    for (const [value, label] of [
      ["album", state.music.query ? "按匹配度" : "按专辑"],
      ["artist", "按歌手"],
      ["title", "按歌名"],
      ["duration", "按时长"],
      ["played", "最近播放"],
      ["favorite", "收藏优先"],
      ["rating", "按评分"]
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      sort.append(option);
    }
    sort.value = state.music.sort || "album";
    sort.disabled = state.music.mode !== "library";
    sort.addEventListener("change", () => {
      state.music.sort = sort.value;
      loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
    });
    controls.append(search, favorite, sort);

    const table = document.createElement("div");
    table.className = "music-track-table";
    table.append(trackHeader());
    const tracks = state.music.data?.tracks || [];
    if (state.music.loading && !tracks.length) {
      table.append(emptyRow("正在读取音乐库"));
    } else if (!tracks.length) {
      table.append(emptyRow(state.music.status || "没有匹配的歌曲。"));
    } else {
      tracks.forEach((track, index) => table.append(trackRow(track, index)));
    }
    const more = renderTrackLoadMore(tracks.length);
    if (more) table.append(more);
    panel.append(heading, controls, table);
    return panel;
  }

  function renderTrackLoadMore(trackCount) {
    if (!state.music.hasMore) return null;
    const more = document.createElement("button");
    more.type = "button";
    more.className = "music-load-more";
    more.textContent = state.music.loadingMore
      ? "正在加载…"
      : `再加载 ${formatNumber(Math.min(MUSIC_PAGE_LIMIT, Math.max(0, Number(state.music.data?.total || 0) - trackCount)))} 首`;
    more.disabled = state.music.loadingMore;
    more.addEventListener("click", () => loadMusic({ append: true, skipRoute: true, keepCurrent: true }).catch(showError));
    return more;
  }

  function appendLibraryTrackPage(tracks, startIndex) {
    const table = els.workGrid?.querySelector?.(".music-track-panel .music-track-table");
    if (!table) return false;
    table.querySelector(".music-load-more")?.remove();
    const fragment = document.createDocumentFragment();
    tracks.forEach((track, index) => fragment.append(trackRow(track, startIndex + index)));
    const more = renderTrackLoadMore(startIndex + tracks.length);
    if (more) fragment.append(more);
    table.append(fragment);
    return true;
  }

  function restoreMusicPanelScroll(scrollTop) {
    window.requestAnimationFrame(() => {
      const panel = document.querySelector(".music-track-panel");
      if (panel) panel.scrollTop = Math.max(0, Number(scrollTop || 0));
    });
  }

  function renderMusicSuggestions(box) {
    if (!box) return;
    box.innerHTML = "";
    const query = state.music.query || "";
    const suggestions = state.music.suggestions || {};
    const valid = state.music.mode === "library" && query && suggestions.query === query;
    if (!valid) {
      box.hidden = true;
      return;
    }
    let count = 0;
    const addGroup = (label, items, build) => {
      if (!items.length) return;
      const heading = document.createElement("div");
      heading.className = "music-search-suggest-heading";
      heading.textContent = label;
      box.append(heading);
      for (const item of items) {
        box.append(build(item));
        count += 1;
      }
    };
    const suggestButton = (main, sub, action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "music-search-suggest-item";
      const strong = document.createElement("strong");
      strong.textContent = main;
      const small = document.createElement("small");
      small.textContent = sub;
      button.append(strong, small);
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        clearMusicSuggestions();
        action();
      });
      return button;
    };
    addGroup("歌曲", (suggestions.tracks || []).slice(0, 5), (track) =>
      suggestButton(track.title || "未知歌曲", `${track.artist || "未知歌手"} · ${track.album || "未知专辑"}`, () => openTrackFromList(track, [track], { autoplay: true }).catch(showError))
    );
    addGroup("歌手", (suggestions.artists || []).slice(0, 4), (artist) =>
      suggestButton(artist.name || "未知歌手", `${formatNumber(artist.trackCount || 0)} 首歌曲`, () => {
        state.music.mode = "library";
        state.music.query = artist.name || "";
        state.music.favorite = false;
        state.music.activePlaylistId = "";
        state.music.activeSmartPlaylistId = "";
        state.music.artistId = "all";
        state.music.albumId = "all";
        state.music.genre = "all";
        loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
      })
    );
    addGroup("专辑", (suggestions.albums || []).slice(0, 4), (album) =>
      suggestButton(album.title || "未知专辑", `${album.artistName || "未知歌手"} · ${formatNumber(album.trackCount || 0)} 首`, () => {
        state.music.mode = "library";
        state.music.query = album.title || "";
        state.music.favorite = false;
        state.music.activePlaylistId = "";
        state.music.activeSmartPlaylistId = "";
        state.music.artistId = "all";
        state.music.albumId = "all";
        state.music.genre = "all";
        loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
      })
    );
    if (!count) {
      const empty = document.createElement("div");
      empty.className = "music-search-suggest-empty";
      empty.textContent = "没有联想结果";
      box.append(empty);
    }
    box.hidden = false;
  }

  function trackHeader() {
    const row = document.createElement("div");
    row.className = "music-track-row head";
    for (const label of ["", "歌曲", "歌手", "专辑", "音质", "时长", ""]) {
      const cell = document.createElement("span");
      cell.textContent = label;
      row.append(cell);
    }
    return row;
  }

  function trackRow(track, index) {
    const row = document.createElement("div");
    row.className = `music-track-row${state.music.current?.id === track.id ? " active" : ""}`;
    registerMusicTrackElement(row, track.id);
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `播放 ${track.title}${Number(track.duplicateCount || 0) > 1 ? `，已合并 ${track.duplicateCount} 个版本` : ""}`);
    const number = document.createElement("span");
    const numberLabel = String(index + 1).padStart(2, "0");
    number.textContent = state.music.current?.id === track.id && state.music.playing ? "Ⅱ" : numberLabel;
    registerCurrentTrackIndicator(number, track.id, numberLabel, "Ⅱ");
    const title = document.createElement("span");
    title.className = "music-track-title";
    const strong = document.createElement("strong");
    strong.textContent = track.title;
    const small = document.createElement("small");
    small.textContent = trackSecondaryText(track);
    title.append(strong, small);
    const artist = document.createElement("span");
    artist.textContent = track.artist || "未知歌手";
    const album = document.createElement("span");
    album.textContent = track.album || "未知专辑";
    const quality = document.createElement("span");
    quality.textContent = qualityLabel(track);
    const duration = document.createElement("span");
    duration.textContent = formatClock(track.durationMs || 0);
    const actions = document.createElement("span");
    actions.className = "music-track-actions";
    actions.append(
      trackActionButton("下首", `下一首播放 ${track.title}`, () => queueTrackNext(track)),
      trackActionButton("入队", `加入队列 ${track.title}`, () => appendTrackToQueue(track)),
      trackActionButton("下载", `下载 ${track.title}`, () => downloadTrack(track))
    );
    row.append(number, title, artist, album, quality, duration, actions);
    row.addEventListener("click", () => openTrackFromList(track, state.music.data?.tracks || [], { autoplay: true }).catch(showError));
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openTrackFromList(track, state.music.data?.tracks || [], { autoplay: true }).catch(showError);
    });
    return row;
  }

  function trackSecondaryText(track) {
    return [
      ratingLabel(track.rating),
      track.hasLyrics ? "歌词" : track.fileName || "",
      Number(track.duplicateCount || 0) > 1 ? `${formatNumber(track.duplicateCount)} 个版本` : ""
    ].filter(Boolean).join(" · ");
  }

  function trackActionButton(label, ariaLabel, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "music-track-action";
    button.textContent = label;
    button.setAttribute("aria-label", ariaLabel);
    button.title = ariaLabel;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      action();
    });
    return button;
  }

  function renderRatingControl(track, variant = "") {
    const rating = Math.max(0, Math.min(5, Number(track?.rating || 0)));
    const wrap = document.createElement("div");
    wrap.className = `music-rating${variant ? ` ${variant}` : ""}`;
    wrap.setAttribute("aria-label", track ? `评分：${rating || "未评分"}` : "评分");
    for (let value = 1; value <= 5; value += 1) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = value <= rating ? "★" : "☆";
      button.disabled = !track;
      button.className = value <= rating ? "active" : "";
      const nextRating = value === rating ? 0 : value;
      button.setAttribute("aria-label", nextRating ? `设为 ${value} 星` : "清除评分");
      button.title = nextRating ? `设为 ${value} 星` : "清除评分";
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        setTrackRating(track.id, nextRating).catch(showError);
      });
      wrap.append(button);
    }
    return wrap;
  }

  function emptyRow(message) {
    const empty = document.createElement("div");
    empty.className = "music-empty-row";
    empty.textContent = message;
    return empty;
  }

  function renderNowPanel() {
    const panel = document.createElement("aside");
    panel.className = "music-now-panel";
    const track = state.music.current || state.music.queue[0] || null;
    panel.dataset.musicTrackId = track?.id || "";
    if (!track) {
      const empty = document.createElement("div");
      empty.className = "music-now-empty";
      empty.textContent = state.music.status || "选择一首歌开始播放。";
      panel.append(empty);
      return panel;
    }

    const summary = document.createElement("div");
    summary.className = "music-now-summary";
    const info = document.createElement("div");
    info.className = "music-now-info";
    const title = document.createElement("h3");
    title.textContent = track.title;
    const meta = document.createElement("p");
    meta.textContent = `${track.artist || "未知歌手"} · ${track.album || "未知专辑"}`;
    const rating = renderRatingControl(track, "now");
    const actions = document.createElement("div");
    actions.className = "music-now-actions";
    const play = document.createElement("button");
    play.type = "button";
    play.className = "music-primary-button";
    play.textContent = state.music.playing ? "暂停" : "播放";
    play.addEventListener("click", togglePlayback);
    registerPlaybackButton(play, "text");
    const fav = document.createElement("button");
    fav.type = "button";
    fav.className = `music-secondary-button${track.favorite ? " active" : ""}`;
    fav.textContent = track.favorite ? "已收藏" : "收藏";
    fav.addEventListener("click", () => toggleFavorite(track.id).catch(showError));
    const playlist = document.createElement("button");
    playlist.type = "button";
    playlist.className = "music-secondary-button";
    playlist.textContent = "加入歌单";
    playlist.addEventListener("click", () => addTrackToPlaylist(track.id).catch(showError));
    const download = document.createElement("button");
    download.type = "button";
    download.className = "music-secondary-button";
    download.textContent = "下载";
    download.disabled = !track.downloadUrl;
    download.addEventListener("click", () => downloadTrack(track));
    actions.append(play, fav, playlist, download);
    if (state.music.mode === "playlist" && state.music.activePlaylistId) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "music-secondary-button danger";
      remove.textContent = "移出歌单";
      remove.addEventListener("click", () => removeTrackFromActivePlaylist(track.id).catch(showError));
      actions.append(remove);
    }
    info.append(title, meta, rating, actions);
    summary.append(renderCover(track, "large"), info);
    panel.append(summary, renderQueuePanel());
    return panel;
  }

  function renderQueuePanel() {
    const panel = document.createElement("div");
    panel.className = "music-queue";
    const queue = state.music.queue || [];
    const head = document.createElement("div");
    head.className = "music-queue-head";
    const titleWrap = document.createElement("span");
    titleWrap.className = "music-queue-title";
    const title = document.createElement("strong");
    title.textContent = "播放队列";
    const count = document.createElement("small");
    count.textContent = queueCountText(queue);
    titleWrap.append(title, count);
    const actions = document.createElement("span");
    actions.className = "music-queue-head-actions";
    if (queue.length > DESKTOP_QUEUE_PREVIEW_LIMIT) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "music-inline-button";
      toggle.textContent = state.music.queueExpanded ? "精简" : "全部";
      toggle.title = state.music.queueExpanded ? "只显示队列摘要" : "显示完整队列";
      toggle.addEventListener("click", () => {
        const expanding = !state.music.queueExpanded;
        state.music.queueExpanded = expanding;
        if (expanding) state.music.queueVisibleLimit = DESKTOP_QUEUE_PAGE_SIZE;
        refreshQueueSurface();
      });
      actions.append(toggle);
    }
    const save = document.createElement("button");
    save.type = "button";
    save.className = "music-inline-button";
    save.textContent = "存为歌单";
    save.disabled = !queue.length;
    save.title = queue.length ? "把当前播放队列保存为新歌单" : "队列为空";
    save.addEventListener("click", () => saveQueueAsPlaylist().catch(showError));
    actions.append(save);
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "music-inline-button";
    clear.textContent = state.music.current ? "清空其他" : "清空";
    const removable = queueRemovableCount();
    clear.disabled = removable <= 0;
    clear.title = removable > 0 ? `清空 ${formatNumber(removable)} 首待播歌曲` : "没有可清空的待播歌曲";
    clear.addEventListener("click", clearQueueAfterCurrent);
    actions.append(clear);
    head.append(titleWrap, actions);
    const list = document.createElement("div");
    list.className = `music-queue-list${state.music.queueExpanded ? " expanded" : ""}`;
    if (!queue.length) {
      list.append(emptyQueueRow("队列为空"));
    } else {
      appendQueueRows(list, queue);
    }
    panel.append(head, list);
    return panel;
  }

  function refreshQueueSurface() {
    const nowPanel = els.workGrid?.querySelector?.(".music-now-panel");
    if (!nowPanel || state.music.trackPageOpen) {
      renderView();
      return;
    }
    const expectedTrackId = state.music.current?.id || state.music.queue[0]?.id || "";
    if (nowPanel.dataset.musicTrackId !== expectedTrackId) {
      unregisterMusicTrackElements(nowPanel);
      const nextPanel = renderNowPanel();
      nowPanel.replaceWith(nextPanel);
      playbackButtonEls = playbackButtonEls.filter(({ button }) => button?.isConnected);
      updatePlaybackUi();
      return;
    }
    const queuePanel = nowPanel.querySelector(".music-queue");
    if (!queuePanel) {
      unregisterMusicTrackElements(nowPanel);
      const nextPanel = renderNowPanel();
      nowPanel.replaceWith(nextPanel);
      playbackButtonEls = playbackButtonEls.filter(({ button }) => button?.isConnected);
      updatePlaybackUi();
      return;
    }
    unregisterMusicTrackElements(queuePanel);
    queuePanel.replaceWith(renderQueuePanel());
  }

  function refreshCurrentTrackSurfaces(previousTrackId = "") {
    const shell = els.workGrid?.querySelector?.(".music-shell.music-library-page");
    const nowPanel = shell?.querySelector?.(".music-now-panel");
    const playerBar = shell?.querySelector?.(".music-player-bar");
    if (!shell || !nowPanel || !playerBar || state.music.trackPageOpen) return false;

    updateBrowseTrackSelection(previousTrackId, state.music.current?.id || "");
    unregisterMusicTrackElements(nowPanel);
    const nextNowPanel = renderNowPanel();
    const nextPlayerBar = renderPlayerBar();
    nowPanel.replaceWith(nextNowPanel);
    playerBar.replaceWith(nextPlayerBar);
    pruneDetachedPlaybackControls();
    updatePlaybackUi();
    return true;
  }

  function updateBrowseTrackSelection(previousTrackId, currentTrackId) {
    for (const indicator of currentTrackIndicatorMap.get(previousTrackId) || []) {
      if (!indicator.element?.isConnected) continue;
      indicator.element.closest?.("[data-music-track-id]")?.classList.remove("active");
      if (indicator.element.textContent !== indicator.idleLabel) indicator.element.textContent = indicator.idleLabel;
    }
    for (const indicator of currentTrackIndicatorMap.get(currentTrackId) || []) {
      if (!indicator.element?.isConnected) continue;
      indicator.element.closest?.("[data-music-track-id]")?.classList.add("active");
      const text = state.music.playing ? indicator.playingLabel : indicator.idleLabel;
      if (indicator.element.textContent !== text) indicator.element.textContent = text;
    }
  }

  function pruneDetachedPlaybackControls() {
    playbackButtonEls = playbackButtonEls.filter(({ button }) => button?.isConnected);
    playbackSurfaceEls = playbackSurfaceEls.filter((surface) => surface?.isConnected);
    playbackErrorEls = playbackErrorEls.filter((error) => error?.isConnected);
    shuffleControlEls = shuffleControlEls.filter((button) => button?.isConnected);
    repeatControlEls = repeatControlEls.filter((button) => button?.isConnected);
    sleepTimerControlEls = sleepTimerControlEls.filter(({ select, status }) => select?.isConnected || status?.isConnected);
  }

  function appendQueueRows(list, queue) {
    if (state.music.queueExpanded) {
      appendExpandedQueueRows(list, queue);
      return;
    }
    if (queue.length <= DESKTOP_QUEUE_PREVIEW_LIMIT) {
      queue.forEach((track, index) => list.append(queueRow(track, index)));
      return;
    }
    const shownIndexes = new Set();
    queue.slice(0, DESKTOP_QUEUE_PREVIEW_LIMIT).forEach((track, index) => {
      shownIndexes.add(index);
      list.append(queueRow(track, index));
    });
    const currentIndex = queue.findIndex((track) => track.id === state.music.current?.id);
    if (currentIndex >= DESKTOP_QUEUE_PREVIEW_LIMIT) {
      shownIndexes.add(currentIndex);
      list.append(emptyQueueRow(`当前播放在第 ${formatNumber(currentIndex + 1)} 首`));
      list.append(queueRow(queue[currentIndex], currentIndex));
    }
    const hiddenCount = queue.length - shownIndexes.size;
    if (hiddenCount > 0) list.append(emptyQueueRow(`还有 ${formatNumber(hiddenCount)} 首未显示，点“全部”查看`));
  }

  function appendExpandedQueueRows(list, queue) {
    const limit = Math.min(queue.length, Math.max(DESKTOP_QUEUE_PAGE_SIZE, Number(state.music.queueVisibleLimit || 0)));
    queue.slice(0, limit).forEach((track, index) => list.append(queueRow(track, index)));
    appendExpandedQueueTail(list, queue, limit);
  }

  function appendExpandedQueueTail(list, queue, limit) {
    const currentIndex = queue.findIndex((track) => track.id === state.music.current?.id);
    if (currentIndex >= limit) {
      const marker = emptyQueueRow(`当前播放在第 ${formatNumber(currentIndex + 1)} 首`);
      marker.classList.add("music-queue-current-context");
      const currentRow = queueRow(queue[currentIndex], currentIndex);
      currentRow.dataset.queueContextCurrent = "true";
      list.append(marker, currentRow);
    }
    if (limit >= queue.length) return;
    const more = document.createElement("button");
    more.type = "button";
    more.className = "music-queue-load-more";
    more.textContent = `再显示 ${formatNumber(Math.min(DESKTOP_QUEUE_PAGE_SIZE, queue.length - limit))} 首`;
    more.addEventListener("click", () => appendNextQueuePage(list, queue, more));
    list.append(more);
  }

  function appendNextQueuePage(list, queue, moreButton) {
    const oldLimit = Math.min(queue.length, Math.max(DESKTOP_QUEUE_PAGE_SIZE, Number(state.music.queueVisibleLimit || 0)));
    const nextLimit = Math.min(queue.length, oldLimit + DESKTOP_QUEUE_PAGE_SIZE);
    state.music.queueVisibleLimit = nextLimit;
    list.querySelector(".music-queue-current-context")?.remove();
    list.querySelector('[data-queue-context-current="true"]')?.remove();
    moreButton?.remove();
    const fragment = document.createDocumentFragment();
    for (let index = oldLimit; index < nextLimit; index += 1) fragment.append(queueRow(queue[index], index));
    list.append(fragment);
    appendExpandedQueueTail(list, queue, nextLimit);
    const count = list.closest(".music-queue")?.querySelector(".music-queue-title small");
    if (count) count.textContent = queueCountText(queue);
  }

  function queueCountText(queue) {
    if (!queue.length) return "空队列";
    if (!state.music.queueExpanded) return `${formatNumber(queue.length)} 首`;
    const visible = Math.min(queue.length, Math.max(DESKTOP_QUEUE_PAGE_SIZE, Number(state.music.queueVisibleLimit || 0)));
    return visible < queue.length
      ? `${formatNumber(queue.length)} 首 · 已显示 ${formatNumber(visible)}`
      : `${formatNumber(queue.length)} 首 · 全部`;
  }

  function queueRow(track, index) {
    const row = document.createElement("div");
    row.className = `music-queue-row${state.music.current?.id === track.id ? " active" : ""}`;
    registerMusicTrackElement(row, track.id);
    const play = document.createElement("button");
    play.type = "button";
    play.className = "music-queue-play";
    play.textContent = `${track.title} - ${track.artist || "未知歌手"}`;
    play.addEventListener("click", () => openTrack(track.id, { autoplay: true }).catch(showError));
    const actions = document.createElement("span");
    actions.className = "music-queue-actions";
    actions.append(
      queueActionButton("↑", "上移", () => moveQueueTrack(track.id, -1), index <= 0),
      queueActionButton("↓", "下移", () => moveQueueTrack(track.id, 1), index >= (state.music.queue || []).length - 1),
      queueActionButton("×", "移出队列", () => removeTrackFromQueue(track.id), state.music.current?.id === track.id)
    );
    row.append(play, actions);
    return row;
  }

  function queueActionButton(label, ariaLabel, action, disabled = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "music-queue-action";
    button.textContent = label;
    button.disabled = disabled;
    button.setAttribute("aria-label", ariaLabel);
    button.title = ariaLabel;
    button.addEventListener("click", action);
    return button;
  }

  function emptyQueueRow(message) {
    const row = document.createElement("div");
    row.className = "music-queue-empty";
    row.textContent = message;
    return row;
  }

  function renderPlayerBar() {
    const track = state.music.current || state.music.queue[0] || null;
    const bar = document.createElement("section");
    bar.className = "music-player-bar";
    const identity = document.createElement("div");
    identity.className = "music-player-identity";
    if (track) {
      identity.classList.add("interactive");
      identity.setAttribute("role", "button");
      identity.tabIndex = 0;
      identity.setAttribute("aria-label", "打开当前歌曲播放页");
      identity.addEventListener("click", () => openPlayerStage().catch(showError));
      identity.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openPlayerStage().catch(showError);
      });
    }
    identity.append(track ? renderCover(track, "bar") : renderCover({ title: "音乐" }, "bar"));
    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = track?.title || "未播放";
    const meta = document.createElement("small");
    meta.textContent = track ? `${track.artist || "未知歌手"} · ${track.album || "未知专辑"}` : "从音乐库选择一首歌";
    text.append(title, meta, createPlaybackErrorElement());
    identity.append(text);

    const center = document.createElement("div");
    center.className = "music-player-center";
    const controls = document.createElement("div");
    controls.className = "music-player-controls";
    controls.append(iconControlButton("enter-fullscreen", () => openPlayerStage().catch(showError), !track, "", "展开播放页"));
    controls.append(registerShuffleControl(controlButton("随机", toggleShuffleMode, false, `text${state.music.shuffle ? " active" : ""}`, "随机播放")));
    controls.append(iconControlButton("rewind", () => playAdjacent(-1, { autoplay: true }).catch(showError), !track, "", "上一首"));
    const playButton = iconControlButton(state.music.playing ? "pause" : "play", togglePlayback, !track, "primary", playAriaLabel(state.music.playing));
    registerPlaybackButton(playButton, "icon");
    controls.append(playButton);
    controls.append(iconControlButton("fast-forward", () => playAdjacent(1, { autoplay: true }).catch(showError), !track, "", "下一首"));
    controls.append(registerRepeatControl(controlButton(repeatLabel(state.music.repeat), cycleRepeatMode, false, `text${state.music.repeat === "none" ? "" : " active"}`, repeatLabel(state.music.repeat))));
    const progressWrap = document.createElement("label");
    progressWrap.className = "music-progress";
    const current = document.createElement("span");
    current.textContent = "0:00";
    const progress = document.createElement("input");
    progress.type = "range";
    progress.min = "0";
    progress.max = "1000";
    progress.value = "0";
    progress.addEventListener("input", () => {
      if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
      audio.currentTime = (Number(progress.value || 0) / 1000) * audio.duration;
      updatePlaybackUi();
    });
    const total = document.createElement("span");
    total.textContent = track ? formatClock(track.durationMs || 0) : "0:00";
    progressWrap.append(current, progress, total);
    center.append(controls, progressWrap);

    const options = document.createElement("div");
    options.className = "music-player-options";
    options.append(renderRatingControl(track, "bar"));
    options.append(controlButton(track?.favorite ? "已收藏" : "收藏", () => toggleFavorite(track.id).catch(showError), !track, `text${track?.favorite ? " active heart" : ""}`, track?.favorite ? "取消收藏" : "收藏"));
    options.append(controlButton("歌单", () => addTrackToPlaylist(track.id).catch(showError), !track, "text", "加入歌单"));
    options.append(iconControlButton("download", () => downloadTrack(track), !track?.downloadUrl, "", "下载原文件"));
    options.append(renderSleepTimerControl(track));
    options.append(renderPlaybackSpeedControl(track));
    const volumeWrap = document.createElement("label");
    volumeWrap.className = "music-volume-wrap";
    const volumeLabel = document.createElement("span");
    volumeLabel.textContent = "音量";
    const volume = document.createElement("input");
    volume.type = "range";
    volume.min = "0";
    volume.max = "100";
    volume.value = String(Math.round((state.music.volume ?? 0.82) * 100));
    volume.className = "music-volume";
    volume.setAttribute("aria-label", "音量");
    volume.addEventListener("input", () => {
      const value = Math.max(0, Math.min(1, Number(volume.value || 0) / 100));
      state.music.volume = value;
      ensureAudio();
      audio.volume = value;
      writeVolumePreference(value);
    });
    volumeWrap.append(volumeLabel, volume);
    options.append(volumeWrap);
    bar.append(identity, center, options);
    currentProgressEls = { current, progress, total };
    return bar;
  }

  function renderPlayerStage() {
    const track = state.music.current || state.music.queue[0] || null;
    const stage = document.createElement("section");
    stage.className = `music-player-stage music-single-track-page${state.music.playing ? " playing" : ""}`;
    stage.setAttribute("aria-label", "单曲播放页");
    playbackSurfaceEls.push(stage);

    const backdrop = document.createElement("div");
    backdrop.className = "music-stage-backdrop";
    if (track?.coverUrl) {
      const image = document.createElement("img");
      image.src = track.coverUrl;
      image.alt = "";
      image.decoding = "async";
      backdrop.append(image);
    }

    const chrome = document.createElement("header");
    chrome.className = "music-stage-chrome";
    const collapse = document.createElement("button");
    collapse.type = "button";
    collapse.className = "music-stage-close";
    collapse.textContent = "返回音乐库";
    collapse.setAttribute("aria-label", "返回音乐库");
    collapse.addEventListener("click", closeTrackPage);
    chrome.append(collapse);

    const content = document.createElement("div");
    content.className = "music-stage-content";
    content.append(renderStageNow(track));

    stage.append(backdrop, chrome, content, renderStageWave(), renderStagePlayer(track));
    return stage;
  }

  function renderStageQueue(track) {
    const panel = document.createElement("section");
    panel.className = "music-stage-queue";
    const head = document.createElement("div");
    head.className = "music-stage-list-actions";
    head.append(stageActionButton("♡ 收藏", () => track && toggleFavorite(track.id).catch(showError), !track));
    head.append(stageActionButton("+ 加到歌单", () => track && addTrackToPlaylist(track.id).catch(showError), !track));
    head.append(stageActionButton("↓ 下载", () => downloadTrack(track), !track?.downloadUrl));
    head.append(stageActionButton("清空列表", clearQueueAfterCurrent, queueRemovableCount() <= 0));
    panel.append(head);

    const list = document.createElement("div");
    list.className = "music-stage-track-list";
    const queue = state.music.queue || [];
    if (!queue.length) {
      const empty = document.createElement("div");
      empty.className = "music-stage-empty";
      empty.textContent = "播放列表为空";
      list.append(empty);
    } else {
      queue.slice(0, 80).forEach((item, index) => list.append(stageTrackRow(item, index)));
      if (queue.length > 80) {
        const more = document.createElement("div");
        more.className = "music-stage-empty";
        more.textContent = `还有 ${formatNumber(queue.length - 80)} 首未显示`;
        list.append(more);
      }
    }
    panel.append(list);
    return panel;
  }

  function stageActionButton(label, action, disabled = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "music-stage-action";
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener("click", action);
    return button;
  }

  function stageTrackRow(track, index) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `music-stage-track${state.music.current?.id === track.id ? " active" : ""}`;
    registerMusicTrackElement(row, track.id);
    const number = document.createElement("span");
    const numberLabel = String(index + 1);
    number.textContent = state.music.current?.id === track.id && state.music.playing ? "▮▮" : numberLabel;
    registerCurrentTrackIndicator(number, track.id, numberLabel, "▮▮");
    const title = document.createElement("strong");
    title.textContent = track.title || "未知歌曲";
    const artist = document.createElement("small");
    artist.textContent = track.artist || "未知歌手";
    const duration = document.createElement("em");
    duration.textContent = formatClock(track.durationMs || 0);
    row.append(number, title, artist, duration);
    row.addEventListener("click", () => openTrack(track.id, { autoplay: true }).catch(showError));
    return row;
  }

  function renderStageNow(track) {
    const panel = document.createElement("section");
    panel.className = "music-stage-now";
    if (!track) {
      const empty = document.createElement("div");
      empty.className = "music-stage-empty";
      empty.textContent = "选择一首歌开始播放。";
      panel.append(empty);
      return panel;
    }

    const album = document.createElement("div");
    album.className = "music-stage-album";
    const turntable = document.createElement("img");
    turntable.className = "music-stage-turntable";
    turntable.src = "/assets/music/turntable-dark-v1.png";
    turntable.alt = "黑胶唱机";
    turntable.decoding = "async";
    const recordLabel = renderCover(track, "record-label");
    album.append(turntable, recordLabel);

    const meta = document.createElement("div");
    meta.className = "music-stage-meta";
    const title = document.createElement("h2");
    title.textContent = track.title || "未知歌曲";
    const artist = document.createElement("p");
    artist.textContent = `${track.artist || "未知歌手"} · ${track.album || "未知专辑"}`;
    meta.append(title, artist, renderStageLyrics());
    panel.append(album, meta);
    return panel;
  }

  function renderStageLyrics() {
    const wrap = document.createElement("div");
    wrap.className = "music-stage-lyrics";
    const head = document.createElement("div");
    head.className = "music-stage-lyrics-head";
    const title = document.createElement("strong");
    title.textContent = "歌词";
    head.append(title);
    const lines = document.createElement("div");
    lines.className = "music-lyric-lines music-stage-lyric-lines";
    const lyricLines = state.music.lyrics?.lines || [];
    if (!lyricLines.length) {
      const empty = document.createElement("p");
      empty.textContent = "暂无歌词";
      lines.append(empty);
    } else {
      const follow = document.createElement("button");
      follow.type = "button";
      follow.className = `music-lyric-follow${state.music.lyricFollowPaused ? " visible" : ""}`;
      follow.textContent = "回到当前";
      follow.addEventListener("click", resumeLyricFollow);
      lyricFollowButtonEls.push(follow);
      head.append(follow);
      lyricLines.slice(0, 120).forEach((line, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.index = String(index);
        button.dataset.timeMs = String(line.timeMs || 0);
        button.textContent = line.text || "";
        button.addEventListener("click", () => seekToLyricLine(line.timeMs || 0));
        lyricLineEls.push(button);
        lines.append(button);
      });
      lines.addEventListener("wheel", () => pauseLyricFollow(follow), { passive: true });
      lines.addEventListener("pointerdown", () => pauseLyricFollow(follow), { passive: true });
    }
    wrap.append(head, lines);
    return wrap;
  }

  function renderStageWave() {
    const wave = document.createElement("canvas");
    wave.className = "music-stage-wave";
    wave.setAttribute("aria-hidden", "true");
    visualizerCanvas = wave;
    return wave;
  }

  function renderStagePlayer(track) {
    const footer = document.createElement("footer");
    footer.className = "music-stage-player";
    const identity = document.createElement("div");
    identity.className = "music-stage-player-title";
    const title = document.createElement("strong");
    title.textContent = track?.title || "未播放";
    const artist = document.createElement("small");
    artist.textContent = track ? `${track.artist || "未知歌手"} · ${track.album || "未知专辑"}` : "从音乐库选择一首歌";
    identity.append(title, artist, createPlaybackErrorElement());

    const controls = document.createElement("div");
    controls.className = "music-player-controls";
    controls.append(registerRepeatControl(controlButton(repeatLabel(state.music.repeat), cycleRepeatMode, false, `text${state.music.repeat === "none" ? "" : " active"}`, repeatLabel(state.music.repeat))));
    controls.append(iconControlButton("rewind", () => playAdjacent(-1, { autoplay: true }).catch(showError), !track, "", "上一首"));
    const playButton = iconControlButton(state.music.playing ? "pause" : "play", togglePlayback, !track, "primary", playAriaLabel(state.music.playing));
    registerPlaybackButton(playButton, "icon");
    controls.append(playButton);
    controls.append(iconControlButton("fast-forward", () => playAdjacent(1, { autoplay: true }).catch(showError), !track, "", "下一首"));
    controls.append(registerShuffleControl(controlButton("随机", toggleShuffleMode, false, `text${state.music.shuffle ? " active" : ""}`, "随机播放")));

    const progressWrap = document.createElement("label");
    progressWrap.className = "music-progress music-stage-progress";
    const current = document.createElement("span");
    current.textContent = "0:00";
    const progress = document.createElement("input");
    progress.type = "range";
    progress.min = "0";
    progress.max = "1000";
    progress.value = "0";
    progress.addEventListener("input", () => {
      if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
      audio.currentTime = (Number(progress.value || 0) / 1000) * audio.duration;
      updatePlaybackUi();
    });
    const total = document.createElement("span");
    total.textContent = track ? formatClock(track.durationMs || 0) : "0:00";
    progressWrap.append(current, progress, total);

    const options = document.createElement("div");
    options.className = "music-stage-options";
    options.append(controlButton(track?.favorite ? "已收藏" : "收藏", () => toggleFavorite(track.id).catch(showError), !track, `text${track?.favorite ? " active" : ""}`, track?.favorite ? "取消收藏" : "收藏"));
    options.append(renderPlaybackSpeedControl(track));

    footer.append(identity, controls, progressWrap, options);
    currentProgressEls = { current, progress, total };
    return footer;
  }

  function renderPlaybackSpeedControl(track) {
    const wrap = document.createElement("label");
    wrap.className = "music-speed-wrap";
    wrap.setAttribute("aria-label", "播放速度");
    const label = document.createElement("span");
    label.textContent = "速度";
    const select = document.createElement("select");
    select.disabled = !track;
    for (const speed of MUSIC_PLAYBACK_SPEED_OPTIONS) {
      const option = document.createElement("option");
      option.value = String(speed);
      option.textContent = playbackSpeedLabel(speed);
      select.append(option);
    }
    select.value = String(normalizePlaybackSpeed(state.music.playbackSpeed));
    select.addEventListener("change", () => setPlaybackSpeed(Number(select.value || 1)));
    wrap.append(label, select);
    return wrap;
  }

  function renderSleepTimerControl(track) {
    const wrap = document.createElement("label");
    wrap.className = "music-sleep-wrap";
    wrap.setAttribute("aria-label", "睡眠定时");
    const label = document.createElement("span");
    label.textContent = "睡眠";
    const select = document.createElement("select");
    select.disabled = !track;
    for (const minutes of MUSIC_SLEEP_TIMER_OPTIONS) {
      const option = document.createElement("option");
      option.value = String(minutes);
      option.textContent = minutes ? `${minutes} 分钟` : "关闭";
      select.append(option);
    }
    select.value = String(sleepTimerActive() ? state.music.sleepMinutes : 0);
    select.addEventListener("change", () => setSleepTimer(Number(select.value || 0)));
    const status = document.createElement("em");
    status.textContent = sleepTimerActive() ? `${sleepTimerText()} 后暂停` : "未开启";
    sleepTimerControlEls.push({ select, status });
    wrap.append(label, select, status);
    return wrap;
  }

  function renderPlaylistDialog() {
    if (!state.music.playlistDialogOpen) return document.createDocumentFragment();
    const trackId = state.music.playlistDialogTrackId || "";
    const track = trackId ? findKnownTrack(trackId) : null;
    const backdrop = document.createElement("div");
    backdrop.className = "music-playlist-dialog-backdrop";
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closePlaylistDialog();
    });
    const dialog = document.createElement("section");
    dialog.className = "music-playlist-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const head = document.createElement("div");
    head.className = "music-playlist-dialog-head";
    const title = document.createElement("strong");
    title.textContent = trackId ? "加入歌单" : "新建歌单";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "music-control-button";
    close.textContent = "×";
    close.setAttribute("aria-label", "关闭");
    close.addEventListener("click", closePlaylistDialog);
    head.append(title, close);
    dialog.append(head);

    if (track) {
      const preview = document.createElement("div");
      preview.className = "music-playlist-dialog-track";
      preview.append(renderCover(track, "tiny"));
      const text = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = track.title || "未知歌曲";
      const small = document.createElement("small");
      small.textContent = `${track.artist || "未知歌手"} · ${track.album || "未知专辑"}`;
      text.append(strong, small);
      preview.append(text);
      dialog.append(preview);
    }

    if (trackId && state.music.playlists.length) {
      const choices = document.createElement("div");
      choices.className = "music-playlist-dialog-list";
      for (const playlist of state.music.playlists) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "music-playlist-choice";
        const strong = document.createElement("strong");
        strong.textContent = playlist.name;
        const small = document.createElement("small");
        small.textContent = `${formatNumber(playlist.trackCount || 0)} 首`;
        button.append(strong, small);
        button.addEventListener("click", () => addTrackToPlaylistTarget(playlist.id).catch(showError));
        choices.append(button);
      }
      dialog.append(choices);
    }

    const form = document.createElement("form");
    form.className = "music-playlist-dialog-form";
    const input = document.createElement("input");
    input.type = "text";
    input.value = state.music.playlistDialogName || "";
    input.placeholder = "歌单名称";
    input.autofocus = true;
    input.addEventListener("input", () => {
      state.music.playlistDialogName = input.value;
    });
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "music-primary-button";
    submit.textContent = trackId ? "新建并加入" : "创建";
    form.append(input, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      createPlaylistFromDialog().catch(showError);
    });
    dialog.append(form);

    backdrop.append(dialog);
    return backdrop;
  }

  function refreshPlaylistDialog({ focus = true } = {}) {
    const shell = els.workGrid?.querySelector?.(".music-shell");
    if (!shell) return false;
    shell.querySelector(".music-playlist-dialog-backdrop")?.remove();
    if (!state.music.playlistDialogOpen) return true;
    shell.append(renderPlaylistDialog());
    if (focus) {
      window.requestAnimationFrame(() => {
        const input = shell.querySelector(".music-playlist-dialog-form input");
        if (input?.isConnected) input.focus({ preventScroll: true });
      });
    }
    return true;
  }

  function refreshLibrarySidebars() {
    if (state.activeView !== "music") return;
    const renderKey = musicSidebarRenderKey();
    const embedded = els.workGrid?.querySelector?.(".music-sidebar.embedded");
    if (embedded && embedded.dataset.musicSidebarKey !== renderKey) {
      const scrollTop = embedded.scrollTop;
      const next = renderSidebar({ embedded: true });
      embedded.replaceWith(next);
      next.scrollTop = scrollTop;
    }
    const drawer = els.workGrid?.querySelector?.(".music-sidebar:not(.embedded)");
    if (drawer && drawer.dataset.musicSidebarKey !== renderKey) {
      const scrollTop = drawer.scrollTop;
      const next = renderSidebar();
      drawer.replaceWith(next);
      next.scrollTop = scrollTop;
    }
  }

  function findKnownTrack(trackId) {
    const tracks = [
      state.music.current,
      ...(state.music.queue || []),
      ...(state.music.data?.tracks || [])
    ].filter(Boolean);
    return tracks.find((track) => track.id === trackId) || null;
  }

  function controlButton(label, action, disabled = false, kind = "", ariaLabel = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `music-control-button${kind ? ` ${kind}` : ""}`;
    button.textContent = label;
    button.disabled = disabled;
    if (ariaLabel) {
      button.setAttribute("aria-label", ariaLabel);
      button.title = ariaLabel;
    }
    button.addEventListener("click", action);
    return button;
  }

  function iconControlButton(iconName, action, disabled = false, kind = "", ariaLabel = "") {
    const button = controlButton("", action, disabled, `icon${kind ? ` ${kind}` : ""}`, ariaLabel);
    button.dataset.iconControl = "true";
    setControlButtonIcon(button, iconName);
    return button;
  }

  function setControlButtonIcon(button, iconName) {
    if (!button) return;
    const normalizedIcon = String(iconName || "").trim();
    if (button.dataset.musicControlIcon === normalizedIcon && button.firstElementChild) return;
    button.dataset.musicControlIcon = normalizedIcon;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("music-control-icon");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("viewBox", "0 0 18 18");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `/vendor/plyr/plyr.svg#plyr-${normalizedIcon}`);
    svg.append(use);
    button.replaceChildren(svg);
  }

  function renderCover(item, size = "") {
    const cover = document.createElement("span");
    cover.className = `music-cover ${size}`.trim();
    if (item.coverUrl) {
      const img = document.createElement("img");
      img.src = item.coverUrl;
      img.alt = item.album || item.title || "专辑封面";
      img.loading = size === "large" ? "eager" : "lazy";
      img.decoding = "async";
      cover.append(img);
    } else {
      const text = document.createElement("strong");
      text.textContent = initials(item.album || item.title || item.artist || "音乐");
      cover.append(text);
    }
    return cover;
  }

  function togglePlayback() {
    ensureState();
    if (!state.music.current) {
      const first = state.music.queue[0];
      if (first) openTrack(first.id, { autoplay: true }).catch(showError);
      return;
    }
    if (audio.paused) playAudio();
    else audio.pause();
  }

  function playAudio() {
    ensureAudio();
    ensureMusicAudioGraph();
    audio.play().catch((error) => {
      setPlaybackError(error?.message || "浏览器阻止了自动播放");
      updatePlaybackUi();
    });
  }

  function ensureMusicAudioGraph() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass || !audio) return;
    try {
      if (!audioContext) audioContext = new AudioContextClass();
      if (!audioAnalyser) {
        audioAnalyser = audioContext.createAnalyser();
        audioAnalyser.fftSize = 128;
        audioAnalyser.smoothingTimeConstant = 0.82;
      }
      if (!audioSource) {
        audioSource = audioContext.createMediaElementSource(audio);
        audioSource.connect(audioAnalyser);
        audioAnalyser.connect(audioContext.destination);
      }
      if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
    } catch {}
  }

  function startMusicVisualizer() {
    stopMusicVisualizer();
    if (state.activeView !== "music" || !visualizerCanvas?.isConnected || !state.music?.trackPageOpen || !audio || audio.paused || document.hidden) {
      if (visualizerCanvas) visualizerCanvas.dataset.visualizerRunning = "false";
      drawMusicVisualizer();
      return;
    }
    visualizerCanvas.dataset.visualizerRunning = "true";
    const tick = (timestamp = 0) => {
      if (state.activeView !== "music" || !visualizerCanvas?.isConnected || !state.music?.trackPageOpen || !audio || audio.paused || document.hidden) {
        if (visualizerCanvas) visualizerCanvas.dataset.visualizerRunning = "false";
        visualizerRaf = 0;
        return;
      }
      if (!visualizerLastFrameAt || timestamp - visualizerLastFrameAt >= MUSIC_VISUALIZER_FRAME_MS) {
        visualizerLastFrameAt = timestamp;
        drawMusicVisualizer();
      }
      visualizerRaf = window.requestAnimationFrame(tick);
    };
    visualizerRaf = window.requestAnimationFrame(tick);
  }

  function stopMusicVisualizer({ draw = false } = {}) {
    if (visualizerRaf) window.cancelAnimationFrame(visualizerRaf);
    visualizerRaf = 0;
    visualizerLastFrameAt = 0;
    if (visualizerCanvas) visualizerCanvas.dataset.visualizerRunning = "false";
    if (draw) drawMusicVisualizer();
  }

  function installMusicVisibilityHandler() {
    if (visibilityHandlerInstalled) return;
    visibilityHandlerInstalled = true;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        saveProgressSoon(null, { immediate: true });
        stopMusicVisualizer();
      }
      else if (audio && !audio.paused) startMusicVisualizer();
      else drawMusicVisualizer();
    });
  }

  function drawMusicVisualizer() {
    const canvas = visualizerCanvas;
    if (state.activeView !== "music" || !canvas?.isConnected) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, width, height);
    if (audioAnalyser && (!visualizerBins || visualizerBins.length !== audioAnalyser.frequencyBinCount)) {
      visualizerBins = new Uint8Array(audioAnalyser.frequencyBinCount);
    }
    const bins = audioAnalyser ? visualizerBins : null;
    if (bins) audioAnalyser.getByteFrequencyData(bins);
    const barCount = Math.min(72, Math.max(36, Math.floor(rect.width / 13)));
    const gap = Math.max(3, width * .0038);
    const barWidth = Math.max(2, (width - gap * (barCount - 1)) / barCount);
    const gradient = context.createLinearGradient(0, height, 0, 0);
    gradient.addColorStop(0, "rgba(24, 213, 125, 0.08)");
    gradient.addColorStop(.4, "rgba(24, 213, 125, 0.8)");
    gradient.addColorStop(1, "rgba(88, 241, 166, 1)");
    context.fillStyle = gradient;
    for (let index = 0; index < barCount; index += 1) {
      const sourceIndex = bins ? Math.min(bins.length - 1, Math.floor((index / barCount) * bins.length * .78)) : 0;
      const level = bins ? bins[sourceIndex] / 255 : 0;
      const idle = audio && !audio.paused ? .08 : .025;
      const barHeight = Math.max(2 * ratio, (idle + level * .92) * height);
      const x = index * (barWidth + gap);
      context.fillRect(x, height - barHeight, barWidth, barHeight);
    }
  }

  async function openPlayerStage() {
    if (!state.music.current && state.music.queue[0]?.id) {
      await openTrack(state.music.queue[0].id, { autoplay: false, skipRoute: true });
    }
    if (!state.music.current) return;
    trackReturnContext = {
      route: musicRouteOverrides(),
      scroll: captureLibraryScroll()
    };
    state.music.trackPageOpen = true;
    state.music.playerStageOpen = false;
    pushRoute({ ...musicRouteOverrides(), musicTrackId: state.music.current.id });
    window.scrollTo({ top: 0, behavior: "instant" });
    renderView();
  }

  function closePlayerStage() {
    state.music.playerStageOpen = false;
    renderView();
  }

  function closeTrackPage() {
    const returnContext = trackReturnContext;
    trackReturnContext = null;
    state.music.trackPageOpen = false;
    state.music.playerStageOpen = false;
    replaceRoute({ ...(returnContext?.route || musicRouteOverrides()), musicTrackId: "" });
    renderView();
    restoreLibraryScroll(returnContext?.scroll);
  }

  function captureLibraryScroll() {
    return {
      windowY: Math.max(0, Number(window.scrollY || 0)),
      sidebar: Math.max(0, Number(document.querySelector(".music-sidebar.embedded")?.scrollTop || 0)),
      tracks: Math.max(0, Number(document.querySelector(".music-track-panel")?.scrollTop || 0)),
      now: Math.max(0, Number(document.querySelector(".music-now-panel")?.scrollTop || 0))
    };
  }

  function restoreLibraryScroll(scroll) {
    if (!scroll) {
      window.scrollTo({ top: 0, behavior: "instant" });
      return;
    }
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: scroll.windowY || 0, behavior: "instant" });
      const targets = [
        [".music-sidebar.embedded", scroll.sidebar],
        [".music-track-panel", scroll.tracks],
        [".music-now-panel", scroll.now]
      ];
      for (const [selector, scrollTop] of targets) {
        const element = document.querySelector(selector);
        if (element) element.scrollTop = Math.max(0, Number(scrollTop || 0));
      }
    });
  }

  function installKeyboardShortcuts() {
    if (keyboardShortcutsInstalled) return;
    keyboardShortcutsInstalled = true;
    window.addEventListener("keydown", handleKeyboardShortcut);
  }

  function handleKeyboardShortcut(event) {
    if (event.defaultPrevented || state.activeView !== "music" || state.music.playlistDialogOpen) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Escape" && state.music.trackPageOpen) {
      event.preventDefault();
      closeTrackPage();
      return;
    }
    if (event.key === "Escape" && state.music.libraryDrawerOpen) {
      event.preventDefault();
      closeLibraryDrawer();
      return;
    }
    if (event.key === "Escape" && state.music.playerStageOpen) {
      event.preventDefault();
      closePlayerStage();
      return;
    }
    if (isKeyboardShortcutTarget(event.target)) return;

    if (event.code === "Space" || event.key === " " || event.key === "Space" || event.key === "Spacebar") {
      event.preventDefault();
      if (!event.repeat) togglePlayback();
      return;
    }

    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (!state.music.current) return;
      event.preventDefault();
      const step = event.shiftKey ? MUSIC_KEYBOARD_FAST_SEEK_SECONDS : MUSIC_KEYBOARD_SEEK_SECONDS;
      seekRelative(event.key === "ArrowLeft" ? -step : step);
    }
  }

  function setSleepTimer(minutes) {
    const normalized = normalizeSleepTimerMinutes(minutes);
    clearSleepTimerHandle();
    if (!normalized) {
      state.music.sleepMinutes = 0;
      state.music.sleepUntil = 0;
      state.music.status = "已关闭睡眠定时";
      updateSleepTimerUi();
      return;
    }
    state.music.sleepMinutes = normalized;
    state.music.sleepUntil = Date.now() + normalized * 60 * 1000;
    state.music.status = `将在 ${normalized} 分钟后暂停`;
    scheduleSleepTimer();
    updateSleepTimerUi();
  }

  function setPlaybackSpeed(value) {
    const speed = normalizePlaybackSpeed(value);
    state.music.playbackSpeed = speed;
    ensureAudio();
    audio.playbackRate = speed;
    writePlaybackSpeedPreference(speed);
    updatePlaybackUi();
  }

  function scheduleSleepTimer() {
    clearSleepTimerHandle();
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
      updateSleepTimerUi();
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
    clearSleepTimerHandle();
    state.music.sleepMinutes = 0;
    state.music.sleepUntil = 0;
    ensureAudio();
    if (!audio.paused) audio.pause();
    state.music.status = "睡眠定时已暂停播放";
    updateSleepTimerUi();
  }

  function updateSleepTimerUi() {
    const active = sleepTimerActive();
    const value = String(active ? state.music.sleepMinutes : 0);
    const text = active ? `${sleepTimerText()} 后暂停` : "未开启";
    for (const { select, status } of sleepTimerControlEls) {
      if (select?.isConnected && select.value !== value) select.value = value;
      if (status?.isConnected && status.textContent !== text) status.textContent = text;
    }
  }

  function sleepTimerActive() {
    return sleepTimerRemainingMs() > 0;
  }

  function sleepTimerRemainingMs() {
    return Math.max(0, Number(state.music.sleepUntil || 0) - Date.now());
  }

  function sleepTimerText() {
    const minutes = Math.max(1, Math.ceil(sleepTimerRemainingMs() / 60000));
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      const rest = minutes % 60;
      return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
    }
    return `${minutes} 分钟`;
  }

  async function playAdjacent(direction, options = {}) {
    ensureState();
    const queue = state.music.queue || [];
    if (!queue.length) return;
    if (state.music.shuffle && queue.length > 1) {
      const candidates = queue.filter((track) => track.id !== state.music.current?.id);
      const target = candidates[Math.floor(Math.random() * candidates.length)];
      if (target) await openTrack(target.id, { autoplay: options.autoplay !== false });
      return;
    }
    const currentIndex = queue.findIndex((track) => track.id === state.music.current?.id);
    let nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= queue.length) {
      if (!options.wrap) return;
      nextIndex = nextIndex < 0 ? queue.length - 1 : 0;
    }
    const target = queue[nextIndex] || queue[0];
    if (target) await openTrack(target.id, { autoplay: options.autoplay !== false });
  }

  function queueTrackNext(track) {
    const item = normalizeQueueTrack(track);
    if (!item) return;
    const currentId = state.music.current?.id || "";
    const queue = withoutQueueTrack(state.music.queue || [], item.id);
    const currentIndex = currentId ? queue.findIndex((entry) => entry.id === currentId) : -1;
    queue.splice(currentIndex >= 0 ? currentIndex + 1 : 0, 0, item);
    state.music.queue = queue;
    state.music.status = `下一首播放「${item.title || "歌曲"}」`;
    refreshQueueSurface();
  }

  function appendTrackToQueue(track) {
    const item = normalizeQueueTrack(track);
    if (!item) return;
    const queue = withoutQueueTrack(state.music.queue || [], item.id);
    queue.push(item);
    state.music.queue = queue;
    state.music.status = `已加入队列「${item.title || "歌曲"}」`;
    refreshQueueSurface();
  }

  function moveQueueTrack(trackId, direction) {
    const queue = [...(state.music.queue || [])];
    const index = queue.findIndex((track) => track.id === trackId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= queue.length) return;
    const [item] = queue.splice(index, 1);
    queue.splice(nextIndex, 0, item);
    state.music.queue = queue;
    state.music.status = `已调整「${item.title || "歌曲"}」顺序`;
    refreshQueueSurface();
    persistPlaylistQueueOrder(queue).catch(showError);
  }

  function removeTrackFromQueue(trackId) {
    if (!trackId || state.music.current?.id === trackId) return;
    const queue = state.music.queue || [];
    const removed = queue.find((track) => track.id === trackId);
    state.music.queue = queue.filter((track) => track.id !== trackId);
    state.music.status = removed ? `已移出队列「${removed.title || "歌曲"}」` : "已更新队列";
    refreshQueueSurface();
  }

  function clearQueueAfterCurrent() {
    const current = state.music.current;
    const removable = queueRemovableCount();
    if (removable <= 0) return;
    const ok = window.confirm(current
      ? `清空队列中的其他 ${formatNumber(removable)} 首歌曲？`
      : `清空播放队列中的 ${formatNumber(removable)} 首歌曲？`);
    if (!ok) return;
    if (!current) {
      state.music.queue = [];
    } else {
      state.music.queue = (state.music.queue || []).filter((track) => track.id === current.id);
    }
    state.music.queueVisibleLimit = DESKTOP_QUEUE_PAGE_SIZE;
    state.music.status = current ? "已清空其他队列歌曲" : "已清空播放队列";
    refreshQueueSurface();
  }

  function queueRemovableCount() {
    const queue = state.music.queue || [];
    if (!state.music.current) return queue.length;
    return queue.filter((track) => track.id !== state.music.current.id).length;
  }

  function queueTrackIds() {
    return uniqueTrackIds(state.music.queue || []);
  }

  async function persistPlaylistQueueOrder(queue = state.music.queue || []) {
    const playlistId = state.music.mode === "playlist" ? String(state.music.activePlaylistId || "").trim() : "";
    if (!playlistId) return null;
    const trackIds = uniqueTrackIds(queue);
    if (!trackIds.length) return null;
    const data = await api(`/api/music/playlists/${encodeURIComponent(playlistId)}/tracks/order`, {
      method: "PUT",
      body: { trackIds }
    });
    state.music.activePlaylist = data.playlist || state.music.activePlaylist;
    if (state.music.data?.playlist?.id === playlistId) state.music.data.playlist = data.playlist || state.music.data.playlist;
    state.music.status = "歌单顺序已保存";
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

  async function restoreLastTrack() {
    if (!canRestoreLastTrack()) return;
    const saved = readLastTrackPreference();
    const trackId = String(saved?.trackId || "").trim();
    if (!trackId) return;
    const key = trackId;
    if (restoreAttemptKey === key) return;
    restoreAttemptKey = key;
    if (saved.track?.id === trackId && !(state.music.queue || []).some((track) => track.id === trackId)) {
      state.music.queue = [normalizeQueueTrack(saved.track), ...(state.music.queue || [])].filter(Boolean);
    }
    try {
      await openTrack(trackId, { autoplay: false, skipRoute: true });
    } catch {
      state.music.queue = withoutQueueTrack(state.music.queue || [], trackId);
      state.music.loading = false;
      state.music.status = emptyMusicMessage(state.music.data?.total || state.music.queue.length);
      writeLastTrackPreference({});
    }
  }

  function canRestoreLastTrack() {
    if (state.music.current || state.music.loading) return false;
    if (state.music.mode !== "home") return false;
    return !state.music.query
      && state.music.artistId === "all"
      && state.music.albumId === "all"
      && state.music.genre === "all"
      && !state.music.favorite
      && !state.music.activePlaylistId
      && !state.music.activeSmartPlaylistId;
  }

  function rememberLastTrack(track) {
    if (!track?.id) return;
    writeLastTrackPreference({
      trackId: track.id,
      track: compactTrack(track),
      updatedAt: new Date().toISOString()
    });
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
    const data = await api(`/api/music/tracks/${encodeURIComponent(trackId)}/favorite`, { method: "POST", body: {} });
    const updated = data.track;
    if (!updated) return;
    applyTrackUpdate(updated);
    if (trackMetadataRequiresReload("favorite")) await loadMusic({ replaceRoute: true, keepCurrent: true });
    else refreshTrackMetadata(updated);
  }

  async function setTrackRating(trackId, rating) {
    const data = await api(`/api/music/tracks/${encodeURIComponent(trackId)}/rating`, {
      method: "POST",
      body: { rating }
    });
    const updated = data.track;
    if (!updated) return;
    applyTrackUpdate(updated);
    if (trackMetadataRequiresReload("rating")) await loadMusic({ replaceRoute: true, keepCurrent: true });
    else refreshTrackMetadata(updated);
  }

  function downloadTrack(track) {
    if (!track?.downloadUrl) return;
    const link = document.createElement("a");
    link.href = new URL(track.downloadUrl, window.location.href).href;
    link.download = track.fileName || track.title || "music";
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
  }

  function downloadPlaylistM3u(playlist) {
    if (!playlist?.id) return;
    const href = playlist.exportUrl || `/api/music/playlists/${encodeURIComponent(playlist.id)}/export.m3u8`;
    const link = document.createElement("a");
    link.href = new URL(href, window.location.href).href;
    link.download = `${playlist.name || "playlist"}.m3u8`;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
  }

  function applyTrackUpdate(updated) {
    if (state.music.current?.id === updated.id) state.music.current = { ...state.music.current, ...updated };
    state.music.queue = (state.music.queue || []).map((track) => (track.id === updated.id ? { ...track, ...updated } : track));
    if (state.music.data?.tracks) {
      state.music.data.tracks = state.music.data.tracks.map((track) => (track.id === updated.id ? { ...track, ...updated } : track));
    }
  }

  function trackMetadataRequiresReload(kind) {
    if (state.music.mode === "smart") return true;
    if (kind === "favorite" && (state.music.favorite || state.music.sort === "favorite")) return true;
    if (kind === "rating" && state.music.sort === "rating") return true;
    return false;
  }

  function refreshTrackMetadata(updated) {
    if (state.activeView !== "music" || !updated?.id) return;
    if (state.music.trackPageOpen || state.music.playerStageOpen) {
      renderView();
      return;
    }
    const visibleTrack = (state.music.data?.tracks || []).find((track) => track.id === updated.id) || updated;
    const rows = new Set();
    for (const indicator of currentTrackIndicatorMap.get(updated.id) || []) {
      const row = indicator.element?.closest?.("[data-music-track-id]");
      if (row?.isConnected) rows.add(row);
    }
    for (const row of rows) {
      const secondary = row.querySelector(".music-track-title small");
      if (secondary) secondary.textContent = trackSecondaryText(visibleTrack);
    }
    const surfacedTrackId = state.music.current?.id || state.music.queue[0]?.id || "";
    if (surfacedTrackId === updated.id && !refreshCurrentTrackSurfaces(updated.id)) renderView();
  }

  function selectMusicMode(mode, options = {}) {
    ensureState();
    clearMusicSuggestions();
    state.music.mode = mode;
    state.music.activePlaylistId = mode === "playlist" ? options.playlistId || "" : "";
    state.music.activeSmartPlaylistId = mode === "smart" ? options.smartId || "" : "";
    state.music.activePlaylist = null;
    state.music.activeSmartPlaylist = null;
    state.music.playlistDialogOpen = false;
    state.music.playlistDialogTrackId = "";
    state.music.playlistDialogName = "";
    state.music.favorite = mode === "library" ? Boolean(options.favorite) : false;
    if (mode === "library") {
      state.music.artistId = options.artistId || "all";
      state.music.albumId = options.albumId || "all";
      state.music.genre = options.genre || "all";
      if (options.language) state.music.language = options.language;
    }
    if (mode !== "library") {
      state.music.query = "";
      state.music.artistId = "all";
      state.music.albumId = "all";
      state.music.genre = "all";
    }
    loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
  }

  function selectGenre(genre) {
    ensureState();
    clearMusicSuggestions();
    state.music.mode = "library";
    state.music.favorite = false;
    state.music.activePlaylistId = "";
    state.music.activeSmartPlaylistId = "";
    state.music.artistId = "all";
    state.music.albumId = "all";
    state.music.genre = String(genre || "").trim() || "all";
    loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
  }

  function selectFirstSmartPlaylist() {
    const smart = (state.music.smartPlaylists || []).find((item) => item?.id);
    if (smart) {
      selectMusicMode("smart", { smartId: smart.id });
      return;
    }
    loadSmartPlaylists()
      .then(() => {
        const loaded = (state.music.smartPlaylists || []).find((item) => item?.id);
        if (loaded) selectMusicMode("smart", { smartId: loaded.id });
        else renderView();
      })
      .catch(showError);
  }

  async function openPlaylistDialog(trackId = "") {
    ensureState();
    playlistDialogReturnFocus = document.activeElement?.isConnected ? document.activeElement : null;
    state.music.playlistDialogOpen = true;
    state.music.playlistDialogTrackId = trackId || "";
    state.music.playlistDialogName = "";
    if (state.activeView === "music" && !refreshPlaylistDialog()) renderView();
    const requestedTrackId = state.music.playlistDialogTrackId;
    await loadPlaylists();
    if (state.music.playlistDialogOpen && state.music.playlistDialogTrackId === requestedTrackId) refreshPlaylistDialog();
  }

  function closePlaylistDialog() {
    const returnFocus = playlistDialogReturnFocus;
    state.music.playlistDialogOpen = false;
    state.music.playlistDialogTrackId = "";
    state.music.playlistDialogName = "";
    playlistDialogReturnFocus = null;
    if (state.activeView === "music" && !refreshPlaylistDialog({ focus: false })) renderView();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }

  async function createPlaylistFromDialog() {
    const name = String(state.music.playlistDialogName || "").trim();
    if (!name) return null;
    const trackId = state.music.playlistDialogTrackId || "";
    closePlaylistDialog();
    state.music.status = "正在创建歌单";
    const data = await api("/api/music/playlists", {
      method: "POST",
      body: { name }
    });
    if (trackId && data.playlist?.id) {
      await api(`/api/music/playlists/${encodeURIComponent(data.playlist.id)}/tracks`, {
        method: "POST",
        body: { trackId }
      });
    }
    await loadPlaylists();
    if (data.playlist?.id) {
      state.music.mode = "playlist";
      state.music.activePlaylistId = data.playlist.id;
      state.music.favorite = false;
      state.music.query = "";
      await loadMusic({ replaceRoute: true, keepCurrent: true });
    } else {
      renderView();
    }
    return data.playlist || null;
  }

  async function saveQueueAsPlaylist() {
    const trackIds = queueTrackIds();
    if (!trackIds.length) {
      state.music.status = "播放队列为空";
      renderView();
      return null;
    }
    const name = window.prompt("歌单名称", defaultQueuePlaylistName());
    const clean = String(name || "").trim();
    if (!clean) return null;
    state.music.status = "正在保存播放队列";
    renderView();
    const data = await api("/api/music/playlists", {
      method: "POST",
      body: {
        name: clean,
        description: "从播放队列保存",
        trackIds
      }
    });
    await loadPlaylists();
    if (data.playlist?.id) {
      state.music.mode = "playlist";
      state.music.activePlaylistId = data.playlist.id;
      state.music.favorite = false;
      state.music.query = "";
      state.music.artistId = "all";
      state.music.albumId = "all";
      state.music.genre = "all";
      await loadMusic({ replaceRoute: true, keepCurrent: true });
    } else {
      state.music.status = "播放队列已保存";
      renderView();
    }
    return data.playlist || null;
  }

  async function importPlaylistM3uFromPrompt() {
    const value = window.prompt("输入 .m3u/.m3u8 文件路径，或粘贴 #EXTM3U 内容", "");
    const source = String(value || "").trim();
    if (!source) return null;
    state.music.status = "正在导入 M3U 歌单";
    renderView();
    const body = source.includes("\n") || source.toUpperCase().startsWith("#EXTM3U")
      ? { content: source }
      : { path: source };
    const data = await api("/api/music/playlists/import-m3u", { method: "POST", body });
    await loadPlaylists();
    if (data.playlist?.id) {
      const summary = data.importSummary || {};
      state.music.status = `已导入歌单：匹配 ${formatNumber(summary.matched || 0)} 首，缺失 ${formatNumber(summary.missing || 0)} 项`;
      state.music.mode = "playlist";
      state.music.activePlaylistId = data.playlist.id;
      state.music.favorite = false;
      state.music.query = "";
      await loadMusic({ replaceRoute: true, keepCurrent: true });
    } else {
      renderView();
    }
    return data.playlist || null;
  }

  async function editActivePlaylist() {
    const playlist = state.music.activePlaylist;
    if (!playlist?.id) return null;
    const name = window.prompt("歌单名称", playlist.name || "");
    if (name === null) return null;
    const cleanName = String(name || "").trim();
    if (!cleanName) return null;
    const description = window.prompt("歌单说明", playlist.description || "");
    if (description === null) return null;
    const data = await api(`/api/music/playlists/${encodeURIComponent(playlist.id)}`, {
      method: "PUT",
      body: {
        name: cleanName,
        description: String(description || "").trim()
      }
    });
    state.music.activePlaylist = data.playlist || state.music.activePlaylist;
    await loadPlaylists();
    await loadMusic({ replaceRoute: true, keepCurrent: true });
    return data.playlist || null;
  }

  async function addTrackToPlaylist(trackId) {
    if (!trackId) return;
    await openPlaylistDialog(trackId);
  }

  async function addTrackToPlaylistTarget(playlistId) {
    const trackId = state.music.playlistDialogTrackId;
    const playlist = (state.music.playlists || []).find((item) => item.id === playlistId);
    if (!trackId || !playlist?.id) return;
    closePlaylistDialog();
    state.music.status = `正在加入「${playlist.name}」`;
    await api(`/api/music/playlists/${encodeURIComponent(playlist.id)}/tracks`, {
      method: "POST",
      body: { trackId }
    });
    state.music.status = `已加入「${playlist.name}」`;
    await loadPlaylists();
    if (state.music.mode === "playlist" && state.music.activePlaylistId === playlist.id) {
      await loadMusic({ replaceRoute: true, keepCurrent: true });
    } else {
      refreshLibrarySidebars();
    }
  }

  async function removeTrackFromActivePlaylist(trackId) {
    if (!state.music.activePlaylistId) return;
    await api(`/api/music/playlists/${encodeURIComponent(state.music.activePlaylistId)}/tracks/${encodeURIComponent(trackId)}`, { method: "DELETE" });
    state.music.status = "已移出歌单";
    await loadMusic({ replaceRoute: true, keepCurrent: true });
  }

  async function deleteActivePlaylist() {
    const playlist = state.music.activePlaylist;
    if (!playlist?.id) return;
    if (!window.confirm(`删除歌单「${playlist.name}」？歌曲文件不会被删除。`)) return;
    await api(`/api/music/playlists/${encodeURIComponent(playlist.id)}`, { method: "DELETE" });
    state.music.mode = "library";
    state.music.activePlaylistId = "";
    state.music.activePlaylist = null;
    await loadMusic({ replaceRoute: true, keepCurrent: true });
  }

  async function clearHistory() {
    if (!window.confirm("清空最近播放记录？播放进度和收藏会保留。")) return;
    await api("/api/music/history", { method: "DELETE" });
    await loadMusic({ replaceRoute: true, keepCurrent: true });
  }

  async function startMusicRescan() {
    ensureState();
    const rootText = (state.music.summary?.roots || state.music.data?.summary?.roots || [])
      .map((root) => root.path)
      .filter(Boolean)
      .join("\n") || "D:\\Music";
    state.music.rescanning = true;
    state.music.status = "正在启动音乐库刷新";
    renderView();
    try {
      await api("/api/admin/scripts/run", {
        method: "POST",
        body: {
          scriptId: "music-library-rescan",
          options: {
            roots: rootText,
            limit: 0,
            dryRun: false
          }
        }
      });
      state.music.status = "音乐库刷新已启动，后台作业完成后会自动更新。";
      openAdminScript("music-library-rescan");
    } catch (error) {
      state.music.status = error?.message || "音乐库刷新启动失败";
    } finally {
      state.music.rescanning = false;
      renderView();
    }
  }

  function reportPlayedOnce() {
    const record = captureProgressRecord();
    if (!record || state.music.playReportedTrackId === record.trackId) return;
    state.music.playReportedTrackId = record.trackId;
    lastProgressSavedAt = Date.now();
    api(`/api/music/tracks/${encodeURIComponent(record.trackId)}/progress`, {
      method: "POST",
      body: {
        positionMs: record.positionMs,
        durationMs: record.durationMs,
        played: true
      }
    }).catch(() => {});
  }

  function captureProgressRecord(positionOverride = null) {
    const track = state.music.current;
    if (!track || !audio) return null;
    return {
      trackId: track.id,
      positionMs: positionOverride === null
        ? Math.round((audio.currentTime || 0) * 1000)
        : Number(positionOverride || 0),
      durationMs: Math.round((audio.duration || 0) * 1000) || track.durationMs || 0
    };
  }

  function saveProgressSoon(positionOverride = null, { immediate = false } = {}) {
    const record = captureProgressRecord(positionOverride);
    if (!record) return;
    pendingProgressRecord = record;
    if (immediate) {
      flushPendingProgress();
      return;
    }
    if (progressTimer) return;
    const elapsed = Date.now() - lastProgressSavedAt;
    const delay = Math.max(
      MUSIC_PROGRESS_SAVE_DELAY_MS,
      MUSIC_PROGRESS_SAVE_INTERVAL_MS - Math.max(0, elapsed)
    );
    progressTimer = window.setTimeout(flushPendingProgress, delay);
  }

  function flushPendingProgress() {
    window.clearTimeout(progressTimer);
    progressTimer = null;
    const record = pendingProgressRecord;
    pendingProgressRecord = null;
    if (!record?.trackId) return;
    lastProgressSavedAt = Date.now();
    api(`/api/music/tracks/${encodeURIComponent(record.trackId)}/progress`, {
      method: "POST",
      body: { positionMs: record.positionMs, durationMs: record.durationMs }
    }).catch(() => {});
  }

  function updatePlaybackUi() {
    if (!audio) return;
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Number(state.music.current?.durationMs || 0) / 1000;
    const current = Number(audio.currentTime || 0);
    const playing = Boolean(state.music.current && !audio.paused);
    state.music.playing = playing;
    updateMediaSession(duration, current);
    updatePlaybackControls(playing);
    if (state.activeView !== "music" || !currentProgressEls?.current?.isConnected) return;
    const currentLabel = formatSeconds(current);
    const totalLabel = formatSeconds(duration);
    const progressValue = duration > 0 ? String(Math.round((current / duration) * 1000)) : "0";
    if (currentProgressEls.current.textContent !== currentLabel) currentProgressEls.current.textContent = currentLabel;
    if (currentProgressEls.total.textContent !== totalLabel) currentProgressEls.total.textContent = totalLabel;
    if (currentProgressEls.progress.value !== progressValue) currentProgressEls.progress.value = progressValue;
  }

  function registerPlaybackButton(button, kind = "icon") {
    if (button) playbackButtonEls.push({ button, kind });
    return button;
  }

  function registerShuffleControl(button) {
    if (button) shuffleControlEls.push(button);
    updatePlaybackModeControls();
    return button;
  }

  function registerRepeatControl(button) {
    if (button) repeatControlEls.push(button);
    updatePlaybackModeControls();
    return button;
  }

  function toggleShuffleMode() {
    state.music.shuffle = !state.music.shuffle;
    writeShufflePreference(state.music.shuffle);
    updatePlaybackModeControls();
  }

  function cycleRepeatMode() {
    state.music.repeat = nextRepeat(state.music.repeat);
    writeRepeatPreference(state.music.repeat);
    updatePlaybackModeControls();
  }

  function updatePlaybackModeControls() {
    const shuffleLabel = state.music.shuffle ? "随机播放已开启" : "随机播放已关闭";
    for (const button of shuffleControlEls) {
      if (!button) continue;
      button.classList.toggle("active", state.music.shuffle);
      button.setAttribute("aria-pressed", String(state.music.shuffle));
      if (button.getAttribute("aria-label") !== shuffleLabel) button.setAttribute("aria-label", shuffleLabel);
      if (button.title !== shuffleLabel) button.title = shuffleLabel;
    }
    const repeatText = repeatLabel(state.music.repeat);
    const repeatLabelText = `播放模式：${repeatText}`;
    for (const button of repeatControlEls) {
      if (!button) continue;
      if (button.textContent !== repeatText) button.textContent = repeatText;
      button.classList.toggle("active", state.music.repeat !== "none");
      button.dataset.repeatMode = state.music.repeat;
      if (button.getAttribute("aria-label") !== repeatLabelText) button.setAttribute("aria-label", repeatLabelText);
      if (button.title !== repeatLabelText) button.title = repeatLabelText;
    }
  }

  function createPlaybackErrorElement() {
    const error = document.createElement("em");
    error.className = "music-player-error";
    error.setAttribute("role", "status");
    error.setAttribute("aria-live", "polite");
    error.textContent = state.music.playbackError;
    error.hidden = !state.music.playbackError;
    playbackErrorEls.push(error);
    return error;
  }

  function setPlaybackError(message = "") {
    const text = String(message || "").trim();
    state.music.playbackError = text;
    for (const error of playbackErrorEls) {
      if (!error?.isConnected) continue;
      if (error.textContent !== text) error.textContent = text;
      error.hidden = !text;
    }
  }

  function registerCurrentTrackIndicator(element, trackId, idleLabel, playingLabel) {
    if (!element || !trackId) return element;
    const indicators = currentTrackIndicatorMap.get(trackId) || [];
    indicators.push({ element, idleLabel, playingLabel });
    currentTrackIndicatorMap.set(trackId, indicators);
    return element;
  }

  function registerMusicTrackElement(element, trackId) {
    if (!element || !trackId) return element;
    element.dataset.musicTrackId = trackId;
    const elements = musicTrackElementMap.get(trackId) || [];
    elements.push(element);
    musicTrackElementMap.set(trackId, elements);
    return element;
  }

  function unregisterMusicTrackElements(container) {
    if (!container) return;
    const trackIds = new Set(
      [...container.querySelectorAll("[data-music-track-id]")]
        .map((element) => element.dataset.musicTrackId)
        .filter(Boolean)
    );
    for (const trackId of trackIds) {
      const elements = (musicTrackElementMap.get(trackId) || [])
        .filter((element) => element?.isConnected && !container.contains(element));
      if (elements.length) musicTrackElementMap.set(trackId, elements);
      else musicTrackElementMap.delete(trackId);
    }
  }

  function updatePlaybackControls(playing) {
    const label = playAriaLabel(playing);
    for (const { button, kind } of playbackButtonEls) {
      if (!button?.isConnected) continue;
      if (kind === "text") {
        const text = playing ? "暂停" : "播放";
        if (button.textContent !== text) button.textContent = text;
      } else {
        setControlButtonIcon(button, playing ? "pause" : "play");
      }
      if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
      if (button.title !== label) button.title = label;
    }
    const currentTrackId = state.music.current?.id || "";
    for (const indicator of currentTrackIndicatorMap.get(currentTrackId) || []) {
      if (!indicator.element?.isConnected) continue;
      const text = playing ? indicator.playingLabel : indicator.idleLabel;
      if (indicator.element.textContent !== text) indicator.element.textContent = text;
    }
    for (const surface of playbackSurfaceEls) {
      if (surface?.isConnected) surface.classList.toggle("playing", playing);
    }
  }

  function installMediaSessionHandlers() {
    if (mediaSessionInstalled || !supportsMediaSession()) return;
    mediaSessionInstalled = true;
    setMediaAction("play", () => {
      if (!state.music.current) togglePlayback();
      else if (audio?.paused) playAudio();
    });
    setMediaAction("pause", () => {
      if (audio && !audio.paused) audio.pause();
    });
    setMediaAction("previoustrack", () => playAdjacent(-1, { autoplay: true }).catch(showError));
    setMediaAction("nexttrack", () => playAdjacent(1, { autoplay: true, wrap: state.music.repeat === "all" }).catch(showError));
    setMediaAction("seekbackward", (details = {}) => seekRelative(-Number(details.seekOffset || 10)));
    setMediaAction("seekforward", (details = {}) => seekRelative(Number(details.seekOffset || 10)));
    setMediaAction("seekto", (details = {}) => {
      if (!audio || typeof details.seekTime !== "number") return;
      audio.currentTime = Math.max(0, details.seekTime);
      updatePlaybackUi();
      updateLyricHighlight(true);
      saveProgressSoon();
    });
  }

  function setMediaAction(action, handler) {
    const session = getMediaSession();
    if (!session) return;
    try {
      session.setActionHandler(action, handler);
    } catch {}
  }

  function seekRelative(offsetSeconds) {
    if (!audio) return;
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Number(state.music.current?.durationMs || 0) / 1000;
    const target = Math.max(0, Math.min(duration || Number.MAX_SAFE_INTEGER, Number(audio.currentTime || 0) + Number(offsetSeconds || 0)));
    audio.currentTime = target;
    updatePlaybackUi();
    updateLyricHighlight(true);
    saveProgressSoon();
  }

  function updateMediaSession(duration = 0, current = 0) {
    const session = getMediaSession();
    if (!session) return;
    const track = state.music.current;
    if (!track) {
      state.music.mediaSessionTrackId = "";
      mediaSessionPositionSecond = -1;
      mediaSessionPlaybackState = "none";
      session.playbackState = "none";
      return;
    }
    if (state.music.mediaSessionTrackId !== track.id) {
      state.music.mediaSessionTrackId = track.id;
      mediaSessionPositionSecond = -1;
      if (typeof window !== "undefined" && "MediaMetadata" in window) {
        session.metadata = new window.MediaMetadata({
          title: track.title || "未知歌曲",
          artist: track.artist || "未知歌手",
          album: track.album || "未知专辑",
          artwork: mediaArtworkForTrack(track)
        });
      }
    }
    const playing = Boolean(audio && !audio.paused);
    state.music.playing = playing;
    const playbackState = playing ? "playing" : "paused";
    const positionSecond = Math.max(0, Math.min(Math.floor(duration), Math.floor(current || 0)));
    if (mediaSessionPlaybackState !== playbackState) {
      mediaSessionPlaybackState = playbackState;
      session.playbackState = playbackState;
    }
    if (typeof session.setPositionState === "function" && duration > 0 && mediaSessionPositionSecond !== positionSecond) {
      try {
        session.setPositionState({
          duration,
          playbackRate: audio?.playbackRate || 1,
          position: Math.max(0, Math.min(duration, current || 0))
        });
        mediaSessionPositionSecond = positionSecond;
      } catch {}
    }
  }

  function mediaArtworkForTrack(track) {
    if (!track?.coverUrl) return [];
    try {
      return [{ src: new URL(track.coverUrl, window.location.href).href, sizes: "512x512" }];
    } catch {
      return [];
    }
  }

  function supportsMediaSession() {
    return Boolean(getMediaSession());
  }

  function getMediaSession() {
    if (typeof navigator !== "undefined" && navigator.mediaSession) return navigator.mediaSession;
    if (typeof window !== "undefined" && window.navigator?.mediaSession) return window.navigator.mediaSession;
    return null;
  }

  function seekToLyricLine(timeMs) {
    ensureAudio();
    const nextTime = Math.max(0, Number(timeMs || 0) / 1000);
    if (!Number.isFinite(nextTime)) return;
    state.music.lyricFollowPaused = false;
    setLyricFollowButtonsVisible(false);
    audio.currentTime = nextTime;
    updatePlaybackUi();
    updateLyricHighlight(true);
    saveProgressSoon();
  }

  function pauseLyricFollow(button = null) {
    if (state.music.lyricFollowPaused || !(state.music.lyrics?.lines || []).length) return;
    state.music.lyricFollowPaused = true;
    button?.classList.add("visible");
  }

  function resumeLyricFollow() {
    state.music.lyricFollowPaused = false;
    setLyricFollowButtonsVisible(false);
    updateLyricHighlight(true);
  }

  function setLyricFollowButtonsVisible(visible) {
    for (const button of lyricFollowButtonEls) {
      if (button?.isConnected) button.classList.toggle("visible", visible);
    }
  }

  function updateLyricHighlight(force = false) {
    if (state.activeView !== "music" || lyricRaf || !lyricLineEls[0]?.isConnected) return;
    lyricRaf = window.requestAnimationFrame(() => {
      lyricRaf = 0;
      if (state.activeView !== "music" || !lyricLineEls[0]?.isConnected) return;
      const lines = state.music.lyrics?.lines || [];
      if (!lines.length || !audio) return;
      const timeMs = Math.round((audio.currentTime || 0) * 1000);
      const index = findLyricIndex(lines, timeMs + 180, lyricLineEls.length);
      if (!force && index === currentLyricIndex) return;
      currentLyricIndex = index;
      const nextActive = lyricLineEls[index] || null;
      if (activeLyricElement !== nextActive) activeLyricElement?.classList.remove("active");
      nextActive?.classList.add("active");
      activeLyricElement = nextActive;
      if (nextActive && (!state.music.lyricFollowPaused || force)) centerLyricLine(nextActive, force);
    });
  }

  function findLyricIndex(lines, timeMs, visibleCount = lines.length) {
    const length = Math.min(lines.length, Math.max(0, Number(visibleCount || 0)));
    if (!length) return -1;
    let low = 0;
    let high = length - 1;
    let result = 0;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (Number(lines[middle]?.timeMs || 0) <= timeMs) {
        result = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return result;
  }

  function centerLyricLine(item, immediate = false) {
    const container = item?.closest?.(".music-lyric-lines");
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const targetTop = container.scrollTop + itemRect.top - containerRect.top - ((container.clientHeight - itemRect.height) / 2);
    container.scrollTo({ top: Math.max(0, targetTop), behavior: immediate ? "auto" : "smooth" });
  }

  function musicListParams() {
    const params = new URLSearchParams();
    if (state.music.mode === "playlist" && state.music.activePlaylistId) params.set("playlist", state.music.activePlaylistId);
    if (state.music.mode === "smart" && state.music.activeSmartPlaylistId) params.set("smart", state.music.activeSmartPlaylistId);
    if (state.music.query) params.set("q", state.music.query);
    if (state.music.artistId && state.music.artistId !== "all") params.set("artist", state.music.artistId);
    if (state.music.albumId && state.music.albumId !== "all") params.set("album", state.music.albumId);
    if (state.music.genre && state.music.genre !== "all") params.set("genre", state.music.genre);
    if (state.music.language && state.music.language !== "all") params.set("language", state.music.language);
    if (state.music.sort && state.music.sort !== "album") params.set("sort", state.music.sort);
    if (state.music.favorite) params.set("favorite", "1");
    return params;
  }

  function currentMusicTitle() {
    if (state.music.mode === "home") return "发现";
    if (state.music.mode === "report") return "听歌报告";
    if (state.music.mode === "artists") return "歌手浏览";
    if (state.music.mode === "albums") return "专辑浏览";
    if (state.music.mode === "history") return "最近播放";
    if (state.music.mode === "playlist") return state.music.activePlaylist?.name || "歌单";
    if (state.music.mode === "smart") return state.music.activeSmartPlaylist?.name || "智能歌单";
    if (state.music.favorite) return "我喜欢";
    if (state.music.genre && state.music.genre !== "all") return state.music.genre;
    if (state.music.albumId && state.music.albumId !== "all") {
      return state.music.albums.find((album) => album.id === state.music.albumId)?.title || "专辑";
    }
    if (state.music.artistId && state.music.artistId !== "all") {
      return state.music.artists.find((artist) => artist.id === state.music.artistId)?.name || "歌手";
    }
    if (state.music.language && state.music.language !== "all") return `${state.music.language}音乐`;
    return "全部歌曲";
  }

  function currentMusicMeta() {
    const total = state.music.data?.total ?? state.music.queue.length;
    const count = `${formatNumber(total || 0)} 首`;
    if (state.music.mode === "home") return `${count} · 快速入口`;
    if (state.music.mode === "report") return `${formatNumber(state.music.data?.counts?.plays || 0)} 次播放 · 听歌统计`;
    if (state.music.mode === "artists") return `${formatNumber(state.music.data?.total || 0)} 位歌手`;
    if (state.music.mode === "albums") return `${formatNumber(state.music.data?.total || 0)} 张专辑`;
    if (state.music.mode === "playlist") return `${count} · 自建歌单`;
    if (state.music.mode === "smart") return `${count} · ${state.music.activeSmartPlaylist?.description || "动态规则"}`;
    if (state.music.mode === "history") return `${count} · 按最近播放排序`;
    if (state.music.data?.relevance) {
      const visible = Number(state.music.data?.tracks?.length || 0);
      return visible && visible < Number(total || 0)
        ? `${formatNumber(visible)} 首 · ${count.replace(" 首", " 个文件")} · 按匹配度`
        : `${count} · 按匹配度`;
    }
    if (state.music.favorite) return `${count} · 收藏歌曲`;
    if (state.music.language && state.music.language !== "all") return `${count} · ${state.music.language}歌手`;
    if (state.music.genre && state.music.genre !== "all") return `${count} · 风格`;
    return `${count} · ${sortLabel(state.music.sort)}`;
  }

  function emptyMusicMessage(total) {
    if (total) return "";
    if (state.music.mode === "home") return "这里还没有音乐，先运行“刷新音乐库”。";
    if (state.music.mode === "report") return "还没有听歌统计，先播放几首歌。";
    if (state.music.mode === "history") return "还没有最近播放，先听一首歌。";
    if (state.music.mode === "playlist") return "这个歌单还没有歌曲，先从右侧当前歌曲加入。";
    if (state.music.mode === "smart") return "这个智能歌单当前没有匹配歌曲。";
    if (state.music.genre && state.music.genre !== "all") return "这个风格下没有歌曲。";
    if (state.music.favorite) return "还没有收藏歌曲。";
    return "这里还没有音乐，先运行“刷新音乐库”。";
  }

  function musicRouteOverrides() {
    return {
      view: "music",
      musicMode: state.music.mode || "home",
      musicPlaylistId: state.music.mode === "playlist" ? state.music.activePlaylistId || "" : "",
      musicSmartId: state.music.mode === "smart" ? state.music.activeSmartPlaylistId || "" : "",
      musicArtistId: state.music.artistId && state.music.artistId !== "all" ? state.music.artistId : "",
      musicAlbumId: state.music.albumId && state.music.albumId !== "all" ? state.music.albumId : "",
      musicGenre: state.music.genre && state.music.genre !== "all" ? state.music.genre : "",
      musicLanguage: state.music.language && state.music.language !== "all" ? state.music.language : "",
      musicTrackId: "",
      musicQuery: state.music.query || "",
      musicSort: state.music.sort || "album",
      musicArtistSort: state.music.artistSort || "count",
      musicAlbumSort: state.music.albumSort || "updated",
      musicFavorite: Boolean(state.music.favorite)
    };
  }

  function setMusicBodyClass() {
    document.body.classList.toggle("music-view", state.activeView === "music");
    document.body.classList.toggle("music-library-open", state.activeView === "music" && Boolean(state.music?.libraryDrawerOpen));
    document.body.classList.toggle("music-stage-open", state.activeView === "music" && Boolean(state.music?.trackPageOpen || state.music?.playerStageOpen));
  }

  function showError(error) {
    state.music.loading = false;
    state.music.status = error?.message || "音乐库读取失败";
    renderView();
  }

  return {
    applyRouteState,
    enter,
    loadMusic,
    openRouteTarget,
    openTrack,
    renderStats,
    renderView
  };
}

function collapseDuplicateTracks(tracks = []) {
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

function duplicateTrackKey(track = {}) {
  const title = normalizeDuplicateText(track.title);
  const artist = normalizeDuplicateText(track.artist);
  const durationMs = Math.max(0, Number(track.durationMs || 0));
  if (!title || !artist || durationMs < 10_000) return `id:${track.id || ""}`;
  return `${title}|${artist}|${Math.round(durationMs / 2000)}`;
}

function normalizeDuplicateText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s·•]+/gu, "")
    .trim();
}

function duplicateTrackScore(track = {}) {
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

function qualityLabel(track = {}) {
  const codec = String(track.codec || "").toUpperCase();
  const sample = Number(track.sampleRate || 0);
  const bit = Number(track.bitDepth || 0);
  const parts = [codec || "AUDIO"];
  if (sample) parts.push(`${Math.round(sample / 1000)}kHz`);
  if (bit) parts.push(`${bit}bit`);
  return parts.join(" · ");
}

function ratingLabel(rating) {
  const value = Math.max(0, Math.min(5, Number(rating || 0)));
  return value ? `${"★".repeat(value)}${"☆".repeat(5 - value)}` : "";
}

function sortLabel(sort) {
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

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分钟`;
}

function formatClock(ms) {
  return formatSeconds(Number(ms || 0) / 1000);
}

function formatSeconds(value) {
  const total = Math.max(0, Math.floor(Number(value || 0)));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function initials(value) {
  const text = String(value || "音乐").trim();
  return text.slice(0, Math.min(2, text.length)).toUpperCase();
}

function normalizeRepeat(value) {
  return ["none", "all", "one"].includes(value) ? value : "all";
}

function nextRepeat(value) {
  if (value === "all") return "one";
  if (value === "one") return "none";
  return "all";
}

function repeatLabel(value) {
  if (value === "one") return "单曲";
  if (value === "none") return "顺序";
  return "循环";
}

function repeatIcon(value) {
  if (value === "one") return "1";
  if (value === "none") return "→";
  return "↻";
}

function playAriaLabel(playing) {
  return playing ? "暂停" : "播放";
}

function normalizeSleepTimerMinutes(value) {
  const minutes = Math.round(Number(value || 0));
  return MUSIC_SLEEP_TIMER_OPTIONS.includes(minutes) ? minutes : 0;
}

function isKeyboardShortcutTarget(target) {
  if (!target || typeof target.closest !== "function") return false;
  return Boolean(target.closest("input, textarea, select, button, a, [contenteditable='true']"));
}

function compactTrack(track = {}) {
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

function readLastTrackPreference() {
  try {
    const parsed = JSON.parse(window.localStorage?.getItem(MUSIC_LAST_TRACK_KEY) || "null");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeLastTrackPreference(record) {
  try {
    window.localStorage?.setItem(MUSIC_LAST_TRACK_KEY, JSON.stringify(record || {}));
  } catch {}
}

function readVolumePreference() {
  try {
    const value = Number(window.localStorage?.getItem("fanhao.music.volume") || 0.82);
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.82;
  } catch {
    return 0.82;
  }
}

function writeVolumePreference(value) {
  try {
    window.localStorage?.setItem("fanhao.music.volume", String(value));
  } catch {}
}

function readPlaybackSpeedPreference() {
  try {
    return normalizePlaybackSpeed(window.localStorage?.getItem(MUSIC_PLAYBACK_SPEED_KEY));
  } catch {
    return 1;
  }
}

function writePlaybackSpeedPreference(value) {
  try {
    window.localStorage?.setItem(MUSIC_PLAYBACK_SPEED_KEY, String(normalizePlaybackSpeed(value)));
  } catch {}
}

function normalizePlaybackSpeed(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  const match = MUSIC_PLAYBACK_SPEED_OPTIONS.find((option) => Math.abs(option - numeric) < 0.001);
  return match || 1;
}

function playbackSpeedLabel(value) {
  return `${normalizePlaybackSpeed(value)}x`;
}

function defaultQueuePlaylistName() {
  const date = new Date();
  return `播放队列 ${date.getMonth() + 1}-${date.getDate()}`;
}

function readRepeatPreference() {
  try {
    return window.localStorage?.getItem("fanhao.music.repeat") || "all";
  } catch {
    return "all";
  }
}

function writeRepeatPreference(value) {
  try {
    window.localStorage?.setItem("fanhao.music.repeat", value);
  } catch {}
}

function readShufflePreference() {
  try {
    return window.localStorage?.getItem("fanhao.music.shuffle") === "1";
  } catch {
    return false;
  }
}

function writeShufflePreference(value) {
  try {
    window.localStorage?.setItem("fanhao.music.shuffle", value ? "1" : "0");
  } catch {}
}
