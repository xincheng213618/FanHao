import { deleteJson, fetchJson, postJson, putJson } from "../../js/api.js?v=20260708-mobile-music-36";
import { absoluteUrl } from "../../js/image.js?v=20260706-mobile-web-sync-01";
import { formatBytes, formatCompact, formatNumber } from "../../js/format.js";

const DEFAULT_MODE = "library";
const DEFAULT_SORT = "album";
const DEFAULT_LIMIT = 80;
const MUSIC_VOLUME_KEY = "fanhao.android.music.volume";
const MUSIC_REPEAT_KEY = "fanhao.android.music.repeat";
const MUSIC_SHUFFLE_KEY = "fanhao.android.music.shuffle";
const MUSIC_LAST_TRACK_KEY = "fanhao.android.music.lastTrack";
const MUSIC_PLAYBACK_SPEED_KEY = "fanhao.android.music.playbackSpeed";
const SLEEP_TIMER_OPTIONS = [0, 10, 15, 30, 45, 60, 90];
const PLAYBACK_SPEED_OPTIONS = [0.75, 1, 1.25, 1.5, 2];

export function createMusicViews(deps) {
  const {
    els,
    getActiveUrl,
    setActiveBottom,
    showView
  } = deps;

  const state = {
    mode: DEFAULT_MODE,
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
    repeat: readRepeatPreference(),
    shuffle: readShufflePreference(),
    volume: readVolumePreference(),
    playbackSpeed: readPlaybackSpeedPreference(),
    sleepMinutes: 0,
    sleepUntil: 0,
    playReportedTrackId: "",
    restoreAttemptKey: "",
    mediaSessionTrackId: "",
    pendingCurrentReveal: false
  };

  let audio = null;
  let audioEventsInstalled = false;
  let progressTimer = 0;
  let lyricRaf = 0;
  let progressBindings = [];
  let currentLyricIndex = -1;
  let mediaSessionInstalled = false;
  let sleepTimerTimeout = 0;
  let sleepTimerInterval = 0;

  installLifecycle();

  async function renderMusicList(params = {}, renderGuard = null) {
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
    await restoreLastTrack(renderGuard);
  }

  function applyRouteParams(params = {}) {
    state.mode = normalizeMode(params.mode);
    state.query = String(params.query || params.q || "").trim();
    state.sort = normalizeSort(params.sort);
    state.artistSort = String(params.artistSort || "count") === "name" ? "name" : "count";
    state.albumSort = normalizeAlbumSort(params.albumSort);
    state.favorite = ["1", "true", "yes"].includes(String(params.favorite || params.fav || "").trim().toLowerCase());
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
    if (!["library", "artists", "albums"].includes(state.mode)) {
      state.artistId = "";
      state.albumId = "";
      state.genre = "";
      state.language = "";
    }
  }

  async function loadMusic(renderGuard = null) {
    const requestUrl = getActiveUrl();
    state.loading = true;
    state.status = "正在读取音乐库";
    renderShell();
    try {
      const data = await fetchJson(requestUrl, musicListPath(), {
        timeoutMs: 18000,
        signal: renderGuard?.signal
      });
      if (renderGuard && !renderGuard()) return;
      const rawTracks = Array.isArray(data.tracks) ? data.tracks : [];
      const visibleTracks = state.mode === "library" && state.query ? collapseDuplicateTracks(rawTracks) : rawTracks;
      state.data = ["artists", "albums"].includes(state.mode)
        ? data
        : { ...data, tracks: visibleTracks, rawTracks, rawLoaded: rawTracks.length };
      state.summary = data.summary || state.summary;
      state.smartPlaylist = data.smartPlaylist || selectedSmartPlaylist();
      state.playlist = data.playlist || selectedPlaylist();
      if (!["artists", "albums"].includes(state.mode)) state.queue = visibleTracks;
      state.hasMore = Boolean(data.hasMore);
      state.loading = false;
      state.status = state.mode === "artists"
        ? (Array.isArray(data.artists) && data.artists.length ? "" : "没有匹配的歌手")
        : state.mode === "albums"
          ? (Array.isArray(data.albums) && data.albums.length ? "" : "没有匹配的专辑")
          : (state.queue.length ? "" : emptyMessage());
      els.viewTitle.textContent = musicTitle();
      els.viewMeta.textContent = musicMeta(data);
      renderShell();
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
    renderShell();
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
        state.queue = tracks;
      }
      state.summary = data.summary || state.summary;
      state.hasMore = Boolean(data.hasMore);
    } finally {
      state.loadingMore = false;
      renderShell();
    }
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
      renderShell();
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
      renderShell();
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
      state.current = data.track;
      state.lyrics = data.lyrics || { lines: [], raw: "" };
      state.prevId = data.prevId || "";
      state.nextId = data.nextId || "";
      state.loading = false;
      state.status = "";
      state.playReportedTrackId = "";
      state.lyricFollowPaused = false;
      currentLyricIndex = -1;
      mergeTrackIntoQueue(data.track);
      rememberLastTrack(data.track);
      if (state.fullscreen && !hasLyrics()) state.fullPanel = "cover";
      loadAudioTrack(data.track, options.autoplay !== false);
      renderShell();
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
    installMediaSessionHandlers();
    if (audioEventsInstalled) return;
    audioEventsInstalled = true;
    audio.addEventListener("play", () => {
      state.playing = true;
      reportPlayedOnce();
      updatePlaybackUi();
    });
    audio.addEventListener("pause", () => {
      state.playing = false;
      saveProgressSoon();
      updatePlaybackUi();
    });
    audio.addEventListener("loadedmetadata", () => {
      const position = Number(state.current?.positionMs || 0);
      if (position > 0 && Number.isFinite(audio.duration) && position / 1000 < audio.duration - 3) {
        audio.currentTime = position / 1000;
      }
      updatePlaybackUi();
    });
    audio.addEventListener("timeupdate", () => {
      updatePlaybackUi();
      if (state.fullscreen) updateLyricHighlight();
      saveProgressSoon();
    });
    audio.addEventListener("ended", () => {
      saveProgressSoon(0);
      if (state.repeat === "one") {
        audio.currentTime = 0;
        playAudio();
        return;
      }
      playAdjacent(1, { wrap: state.repeat === "all" }).catch(() => {});
    });
    audio.addEventListener("error", () => {
      state.status = "音频播放失败";
      state.playing = false;
      renderShell();
    });
  }

  function renderShell() {
    if (!els.viewContent) return;
    progressBindings = [];
    currentLyricIndex = -1;
    if (lyricRaf) window.cancelAnimationFrame(lyricRaf);
    lyricRaf = 0;
    els.viewContent.innerHTML = "";
    const shell = document.createElement("section");
    const searchFocused = Boolean(state.searchOpen || state.query);
    shell.className = `music-mobile-shell${searchFocused ? " is-search-focused" : ""}`;
    shell.append(renderLibraryHeader());
    if (!searchFocused && !["artists", "albums"].includes(state.mode)) shell.append(renderSmartPlaylists(), renderPlaylists());
    shell.append(renderTabs(), renderControls());
    if (state.mode === "artists") shell.append(renderArtistBrowser());
    else if (state.mode === "albums") shell.append(renderAlbumBrowser());
    else {
      if (!searchFocused) shell.append(renderFacetFilters());
      shell.append(renderTrackList());
    }
    shell.append(renderMiniPlayer());
    if (state.fullscreen) shell.append(renderFullPlayer());
    els.viewContent.append(shell);
    document.body.classList.toggle("music-player-open", state.fullscreen);
    els.viewTitle.textContent = musicTitle();
    els.viewMeta.textContent = state.status || musicMeta(state.data);
    updatePlaybackUi();
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
    wrap.className = `music-mobile-controls${state.searchOpen || state.query ? " is-searching" : ""}`;

    const search = document.createElement("input");
    search.type = "search";
    search.setAttribute("aria-label", state.mode === "artists" ? "搜索歌手" : state.mode === "albums" ? "搜索专辑" : "搜索音乐");
    search.setAttribute("enterkeyhint", "search");
    search.autocomplete = "off";
    search.placeholder = state.mode === "artists" ? "搜索歌手" : state.mode === "albums" ? "搜索专辑或歌手" : "搜索歌曲、歌手或专辑";
    search.value = state.query;
    search.disabled = state.mode === "history";
    const applySearch = () => updateListParams({
      query: search.value.trim(),
      mode: ["artists", "albums"].includes(state.mode) ? state.mode : state.mode === "smart" ? "smart" : "library",
      favorite: ["artists", "albums"].includes(state.mode) ? false : state.favorite
    });
    search.addEventListener("change", applySearch);
    search.addEventListener("search", applySearch);
    search.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      applySearch();
    });

    const searchButton = document.createElement("button");
    searchButton.type = "button";
    searchButton.className = `music-mobile-search-pill${state.query ? " has-query" : ""}`;
    searchButton.textContent = state.query ? `搜：${state.query}` : "搜索";
    searchButton.disabled = state.mode === "history";
    searchButton.addEventListener("click", () => {
      state.searchOpen = true;
      renderShell();
      window.requestAnimationFrame(() => els.viewContent.querySelector(".music-mobile-controls input")?.focus());
    });

    if (state.searchOpen || state.query) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "music-mobile-cancel";
      cancel.textContent = "取消";
      cancel.addEventListener("click", () => {
        state.searchOpen = false;
        updateListParams({ query: "" });
      });
      wrap.append(search, cancel);
    } else {
      wrap.append(searchButton);
    }

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
    wrap.append(sort);
    return wrap;
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

  function renderTrackList() {
    const wrap = document.createElement("div");
    wrap.className = "music-mobile-list";
    const tracks = state.data?.tracks || [];
    if (state.loading && !tracks.length) {
      wrap.append(messageBox("正在读取音乐库"));
      return wrap;
    }
    if (!tracks.length) {
      wrap.append(messageBox(state.status || emptyMessage()));
      return wrap;
    }
    tracks.forEach((track, index) => wrap.append(renderTrackRow(track, index)));
    if (state.hasMore) {
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

  function renderTrackRow(track, index) {
    const isCurrent = state.current?.id === track.id;
    const isPlaying = isCurrent && state.playing;
    const row = document.createElement("div");
    row.className = `music-mobile-track${isCurrent ? " active" : ""}${isPlaying ? " playing" : ""}`;
    row.dataset.trackId = track.id || "";
    if (isCurrent) row.dataset.current = "true";
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `播放 ${track.title || "歌曲"}${Number(track.duplicateCount || 0) > 1 ? `，已合并 ${track.duplicateCount} 个版本` : ""}`);
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
    const title = document.createElement("strong");
    title.textContent = track.title || "未知歌曲";
    const meta = document.createElement("small");
    meta.textContent = [
      track.artist || "未知歌手",
      track.album || "未知专辑",
      ratingLabel(track.rating),
      Number(track.duplicateCount || 0) > 1 ? `${formatNumber(track.duplicateCount)} 个版本` : ""
    ].filter(Boolean).join(" · ");
    text.append(title, meta);
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
    const favorite = iconButton(track.favorite ? "♥" : "♡", (event) => {
      event.stopPropagation();
      toggleFavorite(track.id).catch(() => {});
    }, false, `track-favorite${track.favorite ? " active" : ""}`, track.favorite ? "取消收藏" : "收藏");
    inlineActions.append(favorite);
    const duration = document.createElement("small");
    duration.textContent = formatClock(track.durationMs || 0);
    side.append(inlineActions, duration);
    row.append(number, cover, text, side);
    row.addEventListener("click", () => openTrack(track.id, { autoplay: true }).catch(() => {}));
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openTrack(track.id, { autoplay: true }).catch(() => {});
    });
    return row;
  }

  function renderMiniPlayer() {
    const track = state.current || state.queue[0] || null;
    const player = document.createElement("section");
    player.className = "music-mobile-mini-player";
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
      renderShell();
    }, false, state.shuffle ? "active" : "ghost", "随机播放");
    const prev = iconButton("‹", () => playAdjacent(-1).catch(() => {}), !track, "ghost", "上一首");
    const play = iconButton(playIcon(Boolean(track && !audio?.paused)), () => togglePlayback(), !track, "primary large", playLabel(Boolean(track && !audio?.paused)));
    const next = iconButton("›", () => playAdjacent(1).catch(() => {}), !track, "ghost", "下一首");
    const repeat = iconButton(repeatIcon(state.repeat), () => {
      state.repeat = nextRepeat(state.repeat);
      writeRepeatPreference(state.repeat);
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
    for (const minutes of SLEEP_TIMER_OPTIONS.filter(Boolean)) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `music-mobile-sleep-choice${sleepTimerActive() && state.sleepMinutes === minutes ? " active" : ""}`;
      row.addEventListener("click", () => {
        state.sleepSheetOpen = false;
        setSleepTimer(minutes);
      });
      const label = document.createElement("strong");
      label.textContent = sleepOptionLabel(minutes);
      const metaText = document.createElement("small");
      metaText.textContent = sleepTimerActive() && state.sleepMinutes === minutes ? `剩余 ${sleepTimerText()}` : "到点暂停";
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
    clearMeta.textContent = sleepTimerActive() ? "停止倒计时" : "未开启";
    clear.append(clearLabel, clearMeta);
    list.append(clear);

    sheet.append(renderSheetHandle(), head, list);
    return sheet;
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

  function messageBox(message) {
    const box = document.createElement("div");
    const isError = /失败|超时|错误|不可用|阻止/.test(String(state.status || ""));
    box.className = isError ? "message-box error" : "message-box quiet";
    box.textContent = message;
    return box;
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
    else audio.pause();
  }

  function playAudio() {
    ensureAudio();
    audio.play().catch((error) => {
      state.status = error?.message || "播放被系统阻止";
      renderShell();
    });
  }

  function setVolume(value) {
    const next = Math.max(0, Math.min(1, Number(value || 0)));
    state.volume = Number.isFinite(next) ? next : 0.86;
    ensureAudio();
    audio.volume = state.volume;
    writeVolumePreference(state.volume);
  }

  function setPlaybackSpeed(value) {
    const speed = normalizePlaybackSpeed(value);
    state.playbackSpeed = speed;
    ensureAudio();
    audio.playbackRate = speed;
    writePlaybackSpeedPreference(speed);
    updatePlaybackUi();
  }

  function setSleepTimer(minutes) {
    const normalized = normalizeSleepTimerMinutes(minutes);
    clearSleepTimerHandle();
    if (!normalized) {
      state.sleepMinutes = 0;
      state.sleepUntil = 0;
      state.status = "已关闭睡眠定时";
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
    clearSleepTimerHandle();
    state.sleepMinutes = 0;
    state.sleepUntil = 0;
    ensureAudio();
    if (!audio.paused) audio.pause();
    state.status = "睡眠定时已暂停播放";
    renderShell();
  }

  function sleepTimerActive() {
    return sleepTimerRemainingMs() > 0;
  }

  function sleepTimerRemainingMs() {
    return Math.max(0, Number(state.sleepUntil || 0) - Date.now());
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
    state.status = `下一首播放「${item.title || "歌曲"}」`;
    renderShell();
  }

  function appendTrackToQueue(track) {
    const item = normalizeQueueTrack(track);
    if (!item) return;
    const queue = withoutQueueTrack(state.queue || [], item.id);
    queue.push(item);
    state.queue = queue;
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
    if (playlist?.id && options.addCurrent) {
      await addCurrentToPlaylist(playlist.id);
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
    const id = String(playlistId || "").trim();
    if (!id || !state.current?.id) return;
    const data = await postJson(getActiveUrl(), `/api/music/playlists/${encodeURIComponent(id)}/tracks`, {
      trackId: state.current.id
    });
    state.playlistSheetOpen = false;
    state.status = "已加入歌单";
    await loadPlaylists();
    if (state.mode === "playlist" && state.playlistId === id) {
      state.data = data;
      state.playlist = data.playlist || selectedPlaylist();
      state.queue = Array.isArray(data.tracks) ? data.tracks : state.queue;
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
    window.clearTimeout(progressTimer);
    progressTimer = window.setTimeout(() => saveProgress(positionOverride), 800);
  }

  function saveProgress(positionOverride = null) {
    const track = state.current;
    if (!track || !audio) return;
    const positionMs = positionOverride === null ? Math.round((audio.currentTime || 0) * 1000) : Number(positionOverride || 0);
    const durationMs = Math.round((audio.duration || 0) * 1000) || track.durationMs || 0;
    postJson(getActiveUrl(), `/api/music/tracks/${encodeURIComponent(track.id)}/progress`, { positionMs, durationMs }).catch(() => {});
  }

  function updatePlaybackUi() {
    if (!audio) return;
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Number(state.current?.durationMs || 0) / 1000;
    const current = Number(audio.currentTime || 0);
    const playing = Boolean(state.current && !audio.paused);
    state.playing = playing;
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
    updateMediaSession(duration, current);
  }

  function installMediaSessionHandlers() {
    if (mediaSessionInstalled || !("mediaSession" in navigator)) return;
    mediaSessionInstalled = true;
    setMediaAction("play", () => {
      if (!state.current) togglePlayback();
      else if (audio?.paused) playAudio();
    });
    setMediaAction("pause", () => {
      if (audio && !audio.paused) audio.pause();
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
    if (Object.prototype.hasOwnProperty.call(patch, "mode")) state.mode = normalizeMode(patch.mode);
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
      ...(state.sort !== DEFAULT_SORT && state.mode !== "smart" ? { sort: state.sort } : {}),
      ...(state.favorite ? { favorite: "1" } : {}),
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
      if (event.detail?.view !== "music" && state.fullscreen) {
        state.fullscreen = false;
        state.queueOpen = false;
        state.playlistSheetOpen = false;
        state.sleepSheetOpen = false;
        document.body.classList.remove("music-player-open");
      }
      if (!audio) return;
      updatePlaybackUi();
    });
  }

  return {
    closeFullscreen,
    renderMusicList
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

function normalizeMode(value) {
  const mode = String(value || DEFAULT_MODE).trim();
  return ["library", "artists", "albums", "history", "smart", "playlist"].includes(mode) ? mode : DEFAULT_MODE;
}

function normalizeAlbumSort(value) {
  const sort = String(value || "updated").trim();
  return ["updated", "title", "year", "tracks"].includes(sort) ? sort : "updated";
}

function normalizeSort(value) {
  const sort = String(value || DEFAULT_SORT).trim();
  return ["album", "artist", "title", "duration", "played", "favorite", "rating"].includes(sort) ? sort : DEFAULT_SORT;
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

function shortDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function defaultPlaylistName() {
  const date = new Date();
  return `我的歌单 ${date.getMonth() + 1}-${date.getDate()}`;
}

function defaultQueuePlaylistName() {
  const date = new Date();
  return `播放队列 ${date.getMonth() + 1}-${date.getDate()}`;
}

function initials(value) {
  return String(value || "音乐").trim().slice(0, 2).toUpperCase();
}

function playIcon(playing) {
  return playing ? "❚❚" : "▶";
}

function playLabel(playing) {
  return playing ? "暂停" : "播放";
}

function repeatIcon(value) {
  if (value === "one") return "1";
  if (value === "none") return "→";
  return "↻";
}

function repeatLabel(value) {
  if (value === "one") return "单曲循环";
  if (value === "none") return "顺序播放";
  return "列表循环";
}

function nextRepeat(value) {
  if (value === "all") return "one";
  if (value === "one") return "none";
  return "all";
}

function normalizeSleepTimerMinutes(value) {
  const minutes = Math.round(Number(value || 0));
  return SLEEP_TIMER_OPTIONS.includes(minutes) ? minutes : 0;
}

function sleepOptionLabel(minutes) {
  const value = Number(minutes || 0);
  if (value >= 60) {
    const hours = Math.floor(value / 60);
    const rest = value % 60;
    return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
  }
  return `${value} 分钟`;
}

function readVolumePreference() {
  try {
    const value = Number(window.localStorage?.getItem(MUSIC_VOLUME_KEY) || 0.86);
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.86;
  } catch {
    return 0.86;
  }
}

function writeVolumePreference(value) {
  try {
    window.localStorage?.setItem(MUSIC_VOLUME_KEY, String(Math.max(0, Math.min(1, Number(value || 0)))));
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
  const match = PLAYBACK_SPEED_OPTIONS.find((option) => Math.abs(option - numeric) < 0.001);
  return match || 1;
}

function playbackSpeedLabel(value) {
  return `${normalizePlaybackSpeed(value)}x`;
}

function readRepeatPreference() {
  try {
    return ["none", "all", "one"].includes(window.localStorage?.getItem(MUSIC_REPEAT_KEY))
      ? window.localStorage.getItem(MUSIC_REPEAT_KEY)
      : "all";
  } catch {
    return "all";
  }
}

function writeRepeatPreference(value) {
  try {
    window.localStorage?.setItem(MUSIC_REPEAT_KEY, value);
  } catch {}
}

function readShufflePreference() {
  try {
    return window.localStorage?.getItem(MUSIC_SHUFFLE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeShufflePreference(value) {
  try {
    window.localStorage?.setItem(MUSIC_SHUFFLE_KEY, value ? "1" : "0");
  } catch {}
}

function ratingLabel(rating) {
  const value = Math.max(0, Math.min(5, Number(rating || 0)));
  return value ? `${"★".repeat(value)}${"☆".repeat(5 - value)}` : "";
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
