const MUSIC_SLEEP_TIMER_OPTIONS = [0, 10, 15, 30, 45, 60, 90];
const MUSIC_PLAYBACK_SPEED_OPTIONS = [0.75, 1, 1.25, 1.5, 2];
const DESKTOP_QUEUE_PREVIEW_LIMIT = 24;
const MUSIC_KEYBOARD_SEEK_SECONDS = 5;
const MUSIC_KEYBOARD_FAST_SEEK_SECONDS = 15;
const MUSIC_LAST_TRACK_KEY = "fanhao.music.lastTrack";
const MUSIC_PLAYBACK_SPEED_KEY = "fanhao.music.playbackSpeed";

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
  let progressTimer = null;
  let lyricRaf = 0;
  let currentProgressEls = null;
  let currentLyricIndex = -1;
  let sleepTimerTimeout = 0;
  let sleepTimerInterval = 0;
  let mediaSessionInstalled = false;
  let keyboardShortcutsInstalled = false;
  let restoreAttemptKey = "";

  function ensureState() {
    if (!state.music) state.music = {};
    state.music.query = state.music.query || "";
    state.music.mode = ["home", "library", "history", "playlist", "smart"].includes(state.music.mode) ? state.music.mode : "home";
    state.music.artistId = state.music.artistId || "all";
    state.music.albumId = state.music.albumId || "all";
    state.music.genre = state.music.genre || "all";
    state.music.activePlaylistId = state.music.activePlaylistId || "";
    state.music.activeSmartPlaylistId = state.music.activeSmartPlaylistId || "";
    state.music.sort = state.music.sort || "album";
    state.music.favorite = Boolean(state.music.favorite);
    state.music.data = state.music.data || null;
    state.music.summary = state.music.summary || null;
    state.music.artists = Array.isArray(state.music.artists) ? state.music.artists : [];
    state.music.albums = Array.isArray(state.music.albums) ? state.music.albums : [];
    state.music.genres = Array.isArray(state.music.genres) ? state.music.genres : [];
    state.music.playlists = Array.isArray(state.music.playlists) ? state.music.playlists : [];
    state.music.smartPlaylists = Array.isArray(state.music.smartPlaylists) ? state.music.smartPlaylists : [];
    state.music.activePlaylist = state.music.activePlaylist || null;
    state.music.activeSmartPlaylist = state.music.activeSmartPlaylist || null;
    state.music.current = state.music.current || null;
    state.music.lyrics = state.music.lyrics || { raw: "", lines: [] };
    state.music.lyricFollowPaused = Boolean(state.music.lyricFollowPaused);
    state.music.queue = Array.isArray(state.music.queue) ? state.music.queue : [];
    state.music.queueExpanded = Boolean(state.music.queueExpanded);
    state.music.prevId = state.music.prevId || "";
    state.music.nextId = state.music.nextId || "";
    state.music.loading = Boolean(state.music.loading);
    state.music.playing = Boolean(state.music.playing);
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
    ensureAudio();
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
      reportPlayedOnce();
      updatePlaybackUi();
    });
    audio.addEventListener("pause", () => {
      state.music.playing = false;
      saveProgressSoon();
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
      saveProgressSoon(0);
      if (state.music.repeat === "one") {
        audio.currentTime = 0;
        playAudio();
        return;
      }
      playAdjacent(1, { autoplay: true, wrap: state.music.repeat === "all" }).catch(showError);
    });
    audio.addEventListener("error", () => {
      state.music.status = "音频播放失败";
      renderView();
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
    state.music.mode = route.musicMode || "home";
    state.music.query = route.musicQuery || "";
    state.music.artistId = route.musicArtistId || "all";
    state.music.albumId = route.musicAlbumId || "all";
    state.music.genre = route.musicGenre || "all";
    state.music.activePlaylistId = route.musicPlaylistId || "";
    state.music.activeSmartPlaylistId = route.musicSmartId || "";
    state.music.sort = route.musicSort || "album";
    state.music.favorite = Boolean(route.musicFavorite);
  }

  async function openRouteTarget(route = {}) {
    ensureState();
    if (route.musicTrackId) {
      await openTrack(route.musicTrackId, { skipRoute: true, autoplay: false });
      if (!state.music.data) loadMusic({ skipRoute: true, keepCurrent: true }).catch(showError);
      return;
    }
    state.music.current = null;
    state.music.lyrics = { raw: "", lines: [] };
    await loadMusic({ skipRoute: true, keepCurrent: true });
  }

  async function loadMusic(options = {}) {
    ensureState();
    state.music.loading = true;
    state.music.status = "正在读取音乐库";
    if (!options.keepCurrent) {
      state.music.current = null;
      state.music.lyrics = { raw: "", lines: [] };
      state.music.prevId = "";
      state.music.nextId = "";
    }
    renderView();
    const listsPromise = Promise.all([loadPlaylists(), loadSmartPlaylists()]);
    const params = musicListParams();
    params.set("limit", "1000");
    let data;
    if (state.music.mode === "history") {
      data = await api("/api/music/history?limit=1000");
    } else if (state.music.mode === "playlist" && state.music.activePlaylistId) {
      data = await api(`/api/music/playlists/${encodeURIComponent(state.music.activePlaylistId)}`);
    } else if (state.music.mode === "smart" && state.music.activeSmartPlaylistId) {
      data = await api(`/api/music/smart-playlists/${encodeURIComponent(state.music.activeSmartPlaylistId)}?limit=1000`);
    } else if (state.music.mode === "home") {
      const homeParams = new URLSearchParams();
      homeParams.set("limit", "80");
      homeParams.set("sort", "played");
      data = await api(`/api/music/tracks?${homeParams}`);
    } else {
      state.music.mode = "library";
      data = await api(`/api/music/tracks?${params}`);
    }
    await listsPromise;
    state.music.data = data;
    state.music.summary = data.summary || state.music.summary;
    state.music.artists = data.artists || state.music.artists || [];
    state.music.albums = data.albums || state.music.albums || [];
    state.music.genres = data.genres || state.music.genres || [];
    state.music.activePlaylist = data.playlist || null;
    state.music.activeSmartPlaylist = data.smartPlaylist || null;
    state.music.queue = data.tracks || [];
    state.music.loading = false;
    state.music.status = emptyMusicMessage(data.total || state.music.queue.length);
    if (options.restoreLast !== false) await restoreLastTrack();
    renderStats();
    renderView();
    if (!options.skipRoute) {
      const writer = options.replaceRoute ? replaceRoute : pushRoute;
      writer(musicRouteOverrides());
    }
  }

  async function loadPlaylists() {
    try {
      const data = await api("/api/music/playlists");
      state.music.playlists = data.playlists || [];
    } catch {
      state.music.playlists = state.music.playlists || [];
    }
  }

  async function loadSmartPlaylists() {
    try {
      const data = await api("/api/music/smart-playlists");
      state.music.smartPlaylists = data.smartPlaylists || [];
    } catch {
      state.music.smartPlaylists = state.music.smartPlaylists || [];
    }
  }

  async function openTrack(trackId, options = {}) {
    ensureState();
    if (!trackId) return;
    state.music.loading = true;
    state.music.status = "正在打开歌曲";
    renderView();
    const data = await api(`/api/music/tracks/${encodeURIComponent(trackId)}?${musicListParams()}`);
    state.music.current = data.track;
    state.music.lyrics = data.lyrics || { raw: "", lines: [] };
    state.music.prevId = data.prevId || "";
    state.music.nextId = data.nextId || "";
    state.music.loading = false;
    state.music.status = "";
    state.music.playReportedTrackId = "";
    state.music.lyricFollowPaused = false;
    currentLyricIndex = -1;
    if (!state.music.queue.length || !state.music.queue.some((track) => track.id === data.track.id)) {
      state.music.queue = [data.track];
    }
    rememberLastTrack(data.track);
    loadAudioTrack(data.track, options.autoplay !== false);
    renderStats();
    renderView();
    if (!options.skipRoute) pushRoute({ ...musicRouteOverrides(), musicTrackId: data.track.id });
  }

  function loadAudioTrack(track, autoplay) {
    ensureAudio();
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
    els.statsRow.innerHTML = "";
    const totals = state.music.summary?.totals || state.music.data?.summary?.totals || {};
    for (const [label, value] of [
      ["歌曲", formatNumber(totals.tracks || 0)],
      ["歌手", formatNumber(totals.artists || 0)],
      ["专辑", formatNumber(totals.albums || 0)],
      ["容量", formatBytes(totals.bytes || 0)]
    ]) {
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
    setMusicBodyClass();
    currentProgressEls = null;
    currentLyricIndex = -1;
    if (lyricRaf) window.cancelAnimationFrame(lyricRaf);
    lyricRaf = 0;
    els.workGrid.innerHTML = "";

    const shell = document.createElement("section");
    shell.className = "music-shell";
    shell.append(renderHero(), renderLibraryLayout(), renderPlayerBar(), renderPlaylistDialog());
    els.workGrid.append(shell);
    updatePlaybackUi();
    updateLyricHighlight(!state.music.lyricFollowPaused);
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
    const rootText = (summary.roots || []).map((root) => root.path).filter(Boolean)[0] || "E:\\音乐 MV\\音乐（无损）";
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
    layout.append(renderSidebar(), renderTrackPanel(), renderNowPanel());
    return layout;
  }

  function renderSidebar() {
    const side = document.createElement("aside");
    side.className = "music-sidebar";
    const libraryTitle = document.createElement("h3");
    libraryTitle.textContent = "资料库";
    const libraryList = document.createElement("div");
    libraryList.className = "music-artist-list";
    libraryList.append(filterButton("home", "发现", "", state.music.mode === "home", () => {
      selectMusicMode("home");
    }));
    libraryList.append(filterButton("library", "全部歌曲", state.music.summary?.totals?.tracks || state.music.data?.total || 0, state.music.mode === "library" && !state.music.favorite, () => {
      selectMusicMode("library");
    }));
    libraryList.append(filterButton("history", "最近播放", state.music.summary?.recent?.length || 0, state.music.mode === "history", () => {
      selectMusicMode("history");
    }));
    libraryList.append(filterButton("favorites", "我喜欢", "", state.music.mode === "library" && state.music.favorite, () => {
      selectMusicMode("library", { favorite: true });
    }));

    const smartTitle = document.createElement("h3");
    smartTitle.textContent = "智能歌单";
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

    const playlistTitle = document.createElement("h3");
    playlistTitle.textContent = "歌单";
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

    const genresTitle = document.createElement("h3");
    genresTitle.textContent = "风格";
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

    const artistsTitle = document.createElement("h3");
    artistsTitle.textContent = "歌手";
    const artistList = document.createElement("div");
    artistList.className = "music-artist-list";
    for (const artist of state.music.artists || []) {
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

    const albumsTitle = document.createElement("h3");
    albumsTitle.textContent = "专辑";
    const albums = document.createElement("div");
    albums.className = "music-album-mini-list";
    for (const album of (state.music.albums || []).slice(0, 18)) {
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
    side.append(libraryTitle, libraryList, smartTitle, smartList, playlistTitle, playlists, genresTitle, genreList, artistsTitle, artistList, albumsTitle, albums);
    return side;
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
    button.addEventListener("click", action);
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
    headingMeta.textContent = "从最近播放、智能歌单、风格、歌手和专辑快速进入";
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

    const summary = state.music.summary || state.music.data?.summary || {};
    const totals = summary.totals || {};
    const cards = document.createElement("div");
    cards.className = "music-home-cards";
    cards.append(
      homeActionCard("全部歌曲", formatNumber(totals.tracks || state.music.data?.total || 0), "按专辑浏览", () => selectMusicMode("library")),
      homeActionCard("最近播放", formatNumber(summary.recent?.length || 0), "继续听", () => selectMusicMode("history")),
      homeActionCard("智能歌单", formatNumber((state.music.smartPlaylists || []).length), "自动整理", () => selectFirstSmartPlaylist()),
      homeActionCard("我喜欢", "♥", "收藏歌曲", () => selectMusicMode("library", { favorite: true }))
    );

    const sections = document.createElement("div");
    sections.className = "music-home-sections";
    const recent = summary.recent?.length ? summary.recent : (state.music.queue || []).slice(0, 8);
    sections.append(
      homeSection("最近播放", "继续刚才的顺序", homeTrackList(recent.slice(0, 8), "还没有最近播放")),
      homeSection("智能歌单", "动态规则", homeSmartPlaylistList()),
      homeSection("歌单", "自建列表", homePlaylistList()),
      homeSection("风格", "按音乐类型进入", homeGenreList()),
      homeSection("歌手", "按歌手进入", homeArtistList()),
      homeSection("专辑", "按专辑进入", homeAlbumList())
    );
    panel.append(heading, cards, sections);
    return panel;
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
      button.addEventListener("click", () => openTrack(track.id, { autoplay: true }).catch(showError));
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

  function renderTrackPanel() {
    if (state.music.mode === "home") return renderHomePanel();
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
    const search = document.createElement("label");
    search.className = "music-search";
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = state.music.mode === "library" ? "搜索歌曲、歌手、专辑或歌词" : "当前列表暂不支持搜索";
    input.value = state.music.query || "";
    input.disabled = state.music.mode !== "library";
    input.addEventListener("input", () => {
      state.music.query = input.value.trim();
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError), 260);
    });
    search.append(input);
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
      ["album", "按专辑"],
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
    panel.append(heading, controls, table);
    return panel;
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
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `播放 ${track.title}`);
    const number = document.createElement("span");
    number.textContent = state.music.current?.id === track.id && state.music.playing ? "||" : String(index + 1).padStart(2, "0");
    const title = document.createElement("span");
    title.className = "music-track-title";
    const strong = document.createElement("strong");
    strong.textContent = track.title;
    const small = document.createElement("small");
    small.textContent = [ratingLabel(track.rating), track.hasLyrics ? "歌词" : track.fileName || ""].filter(Boolean).join(" · ");
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
    row.addEventListener("click", () => openTrack(track.id, { autoplay: true }).catch(showError));
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openTrack(track.id, { autoplay: true }).catch(showError);
    });
    return row;
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
    if (!track) {
      const empty = document.createElement("div");
      empty.className = "music-now-empty";
      empty.textContent = state.music.status || "选择一首歌开始播放。";
      panel.append(empty);
      return panel;
    }

    panel.append(renderCover(track, "large"));
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
    panel.append(title, meta, rating, actions, renderLyricPanel(), renderQueuePanel());
    return panel;
  }

  function renderLyricPanel() {
    const wrap = document.createElement("div");
    wrap.className = "music-lyrics";
    const head = document.createElement("div");
    head.className = "music-lyric-head";
    const title = document.createElement("strong");
    title.textContent = "歌词";
    head.append(title);
    const lines = document.createElement("div");
    lines.className = "music-lyric-lines";
    const lyricLines = state.music.lyrics?.lines || [];
    if (!lyricLines.length) {
      const empty = document.createElement("p");
      empty.textContent = "暂无歌词";
      lines.append(empty);
    } else {
      lyricLines.slice(0, 120).forEach((line, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.index = String(index);
        button.dataset.timeMs = String(line.timeMs || 0);
        button.textContent = line.text || "";
        button.addEventListener("click", () => seekToLyricLine(line.timeMs || 0));
        lines.append(button);
      });
      const follow = document.createElement("button");
      follow.type = "button";
      follow.className = `music-lyric-follow${state.music.lyricFollowPaused ? " visible" : ""}`;
      follow.textContent = "回到当前";
      follow.addEventListener("click", resumeLyricFollow);
      head.append(follow);
      lines.addEventListener("wheel", () => pauseLyricFollow(follow), { passive: true });
      lines.addEventListener("pointerdown", () => pauseLyricFollow(follow), { passive: true });
    }
    wrap.append(head, lines);
    return wrap;
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
    count.textContent = queue.length ? `${formatNumber(queue.length)} 首${state.music.queueExpanded ? " · 全部" : ""}` : "空队列";
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
        state.music.queueExpanded = !state.music.queueExpanded;
        renderView();
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

  function appendQueueRows(list, queue) {
    if (state.music.queueExpanded || queue.length <= DESKTOP_QUEUE_PREVIEW_LIMIT) {
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

  function queueRow(track, index) {
    const row = document.createElement("div");
    row.className = `music-queue-row${state.music.current?.id === track.id ? " active" : ""}`;
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
    const track = state.music.current;
    const bar = document.createElement("section");
    bar.className = "music-player-bar";
    const identity = document.createElement("div");
    identity.className = "music-player-identity";
    identity.append(track ? renderCover(track, "bar") : renderCover({ title: "音乐" }, "bar"));
    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = track?.title || "未播放";
    const meta = document.createElement("small");
    meta.textContent = track ? `${track.artist || "未知歌手"} · ${track.album || "未知专辑"}` : "从音乐库选择一首歌";
    text.append(title, meta);
    identity.append(text);

    const center = document.createElement("div");
    center.className = "music-player-center";
    const controls = document.createElement("div");
    controls.className = "music-player-controls";
    controls.append(controlButton("⤮", () => {
      state.music.shuffle = !state.music.shuffle;
      writeShufflePreference(state.music.shuffle);
      renderView();
    }, false, state.music.shuffle ? "active" : "", "随机播放"));
    controls.append(controlButton("‹", () => playAdjacent(-1, { autoplay: true }).catch(showError), !track, "", "上一首"));
    const playButton = controlButton(playIcon(state.music.playing), togglePlayback, !track, "primary", playAriaLabel(state.music.playing));
    controls.append(playButton);
    controls.append(controlButton("›", () => playAdjacent(1, { autoplay: true }).catch(showError), !track, "", "下一首"));
    controls.append(controlButton(repeatIcon(state.music.repeat), () => {
      state.music.repeat = nextRepeat(state.music.repeat);
      writeRepeatPreference(state.music.repeat);
      renderView();
    }, false, state.music.repeat === "none" ? "" : "active", repeatLabel(state.music.repeat)));
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
    options.append(controlButton(track?.favorite ? "♥" : "♡", () => toggleFavorite(track.id).catch(showError), !track, track?.favorite ? "active heart" : "", track?.favorite ? "取消收藏" : "收藏"));
    options.append(controlButton("+", () => addTrackToPlaylist(track.id).catch(showError), !track, "", "加入歌单"));
    options.append(controlButton("↓", () => downloadTrack(track), !track?.downloadUrl, "", "下载原文件"));
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
    currentProgressEls = { current, progress, total, playButton };
    return bar;
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
    audio.play().catch((error) => {
      state.music.status = error?.message || "浏览器阻止了自动播放";
      renderView();
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
      renderView();
      return;
    }
    state.music.sleepMinutes = normalized;
    state.music.sleepUntil = Date.now() + normalized * 60 * 1000;
    state.music.status = `将在 ${normalized} 分钟后暂停`;
    scheduleSleepTimer();
    renderView();
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
      renderView();
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
    renderView();
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
    renderView();
  }

  function appendTrackToQueue(track) {
    const item = normalizeQueueTrack(track);
    if (!item) return;
    const queue = withoutQueueTrack(state.music.queue || [], item.id);
    queue.push(item);
    state.music.queue = queue;
    state.music.status = `已加入队列「${item.title || "歌曲"}」`;
    renderView();
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
    renderView();
    persistPlaylistQueueOrder(queue).catch(showError);
  }

  function removeTrackFromQueue(trackId) {
    if (!trackId || state.music.current?.id === trackId) return;
    const queue = state.music.queue || [];
    const removed = queue.find((track) => track.id === trackId);
    state.music.queue = queue.filter((track) => track.id !== trackId);
    state.music.status = removed ? `已移出队列「${removed.title || "歌曲"}」` : "已更新队列";
    renderView();
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
    state.music.status = current ? "已清空其他队列歌曲" : "已清空播放队列";
    renderView();
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
    renderView();
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
    renderView();
  }

  async function setTrackRating(trackId, rating) {
    const data = await api(`/api/music/tracks/${encodeURIComponent(trackId)}/rating`, {
      method: "POST",
      body: { rating }
    });
    const updated = data.track;
    if (!updated) return;
    applyTrackUpdate(updated);
    renderView();
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

  function selectMusicMode(mode, options = {}) {
    ensureState();
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
      state.music.artistId = "all";
      state.music.albumId = "all";
      state.music.genre = "all";
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
    state.music.playlistDialogOpen = true;
    state.music.playlistDialogTrackId = trackId || "";
    state.music.playlistDialogName = "";
    await loadPlaylists();
    renderView();
  }

  function closePlaylistDialog() {
    state.music.playlistDialogOpen = false;
    state.music.playlistDialogTrackId = "";
    state.music.playlistDialogName = "";
    renderView();
  }

  async function createPlaylistFromDialog() {
    const name = String(state.music.playlistDialogName || "").trim();
    if (!name) return null;
    const trackId = state.music.playlistDialogTrackId || "";
    state.music.playlistDialogOpen = false;
    state.music.status = "正在创建歌单";
    renderView();
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
    state.music.playlistDialogOpen = false;
    state.music.playlistDialogTrackId = "";
    state.music.playlistDialogName = "";
    state.music.status = `正在加入「${playlist.name}」`;
    renderView();
    await api(`/api/music/playlists/${encodeURIComponent(playlist.id)}/tracks`, {
      method: "POST",
      body: { trackId }
    });
    state.music.status = `已加入「${playlist.name}」`;
    await loadPlaylists();
    if (state.music.mode === "playlist" && state.music.activePlaylistId === playlist.id) {
      await loadMusic({ replaceRoute: true, keepCurrent: true });
    } else {
      renderView();
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
      .join("\n") || "E:\\音乐 MV\\音乐（无损）";
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
    const track = state.music.current;
    if (!track || state.music.playReportedTrackId === track.id) return;
    state.music.playReportedTrackId = track.id;
    api(`/api/music/tracks/${encodeURIComponent(track.id)}/progress`, {
      method: "POST",
      body: {
        positionMs: Math.round((audio?.currentTime || 0) * 1000),
        durationMs: Math.round((audio?.duration || 0) * 1000) || track.durationMs || 0,
        played: true
      }
    }).catch(() => {});
  }

  function saveProgressSoon(positionOverride = null) {
    window.clearTimeout(progressTimer);
    progressTimer = window.setTimeout(() => saveProgress(positionOverride), 700);
  }

  function saveProgress(positionOverride = null) {
    const track = state.music.current;
    if (!track || !audio) return;
    const positionMs = positionOverride === null ? Math.round((audio.currentTime || 0) * 1000) : Number(positionOverride || 0);
    const durationMs = Math.round((audio.duration || 0) * 1000) || track.durationMs || 0;
    api(`/api/music/tracks/${encodeURIComponent(track.id)}/progress`, {
      method: "POST",
      body: { positionMs, durationMs }
    }).catch(() => {});
  }

  function updatePlaybackUi() {
    if (!audio) return;
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Number(state.music.current?.durationMs || 0) / 1000;
    const current = Number(audio.currentTime || 0);
    const playing = Boolean(state.music.current && !audio.paused);
    state.music.playing = playing;
    updateMediaSession(duration, current);
    if (!currentProgressEls) return;
    currentProgressEls.current.textContent = formatSeconds(current);
    currentProgressEls.total.textContent = formatSeconds(duration);
    currentProgressEls.progress.value = duration > 0 ? String(Math.round((current / duration) * 1000)) : "0";
    if (currentProgressEls.playButton) {
      const label = playAriaLabel(playing);
      currentProgressEls.playButton.textContent = playIcon(playing);
      currentProgressEls.playButton.setAttribute("aria-label", label);
      currentProgressEls.playButton.title = label;
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
      session.playbackState = "none";
      return;
    }
    if (state.music.mediaSessionTrackId !== track.id) {
      state.music.mediaSessionTrackId = track.id;
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
    session.playbackState = playing ? "playing" : "paused";
    if (typeof session.setPositionState === "function" && duration > 0) {
      try {
        session.setPositionState({
          duration,
          playbackRate: audio?.playbackRate || 1,
          position: Math.max(0, Math.min(duration, current || 0))
        });
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
    document.querySelector(".music-lyric-follow")?.classList.remove("visible");
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
    document.querySelector(".music-lyric-follow")?.classList.remove("visible");
    updateLyricHighlight(true);
  }

  function updateLyricHighlight(force = false) {
    if (lyricRaf) return;
    lyricRaf = window.requestAnimationFrame(() => {
      lyricRaf = 0;
      const lines = state.music.lyrics?.lines || [];
      if (!lines.length || !audio) return;
      const timeMs = Math.round((audio.currentTime || 0) * 1000);
      let index = 0;
      for (let i = 0; i < lines.length; i += 1) {
        if (Number(lines[i].timeMs || 0) <= timeMs + 180) index = i;
        else break;
      }
      if (!force && index === currentLyricIndex) return;
      currentLyricIndex = index;
      for (const item of document.querySelectorAll(".music-lyric-lines [data-index]")) {
        const active = Number(item.dataset.index || -1) === index;
        item.classList.toggle("active", active);
        if (active && (!state.music.lyricFollowPaused || force)) item.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    });
  }

  function musicListParams() {
    const params = new URLSearchParams();
    if (state.music.mode === "playlist" && state.music.activePlaylistId) params.set("playlist", state.music.activePlaylistId);
    if (state.music.mode === "smart" && state.music.activeSmartPlaylistId) params.set("smart", state.music.activeSmartPlaylistId);
    if (state.music.query) params.set("q", state.music.query);
    if (state.music.artistId && state.music.artistId !== "all") params.set("artist", state.music.artistId);
    if (state.music.albumId && state.music.albumId !== "all") params.set("album", state.music.albumId);
    if (state.music.genre && state.music.genre !== "all") params.set("genre", state.music.genre);
    if (state.music.sort && state.music.sort !== "album") params.set("sort", state.music.sort);
    if (state.music.favorite) params.set("favorite", "1");
    return params;
  }

  function currentMusicTitle() {
    if (state.music.mode === "home") return "发现";
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
    return "全部歌曲";
  }

  function currentMusicMeta() {
    const total = state.music.data?.total ?? state.music.queue.length;
    const count = `${formatNumber(total || 0)} 首`;
    if (state.music.mode === "home") return `${count} · 快速入口`;
    if (state.music.mode === "playlist") return `${count} · 自建歌单`;
    if (state.music.mode === "smart") return `${count} · ${state.music.activeSmartPlaylist?.description || "动态规则"}`;
    if (state.music.mode === "history") return `${count} · 按最近播放排序`;
    if (state.music.favorite) return `${count} · 收藏歌曲`;
    if (state.music.genre && state.music.genre !== "all") return `${count} · 风格`;
    return `${count} · ${sortLabel(state.music.sort)}`;
  }

  function emptyMusicMessage(total) {
    if (total) return "";
    if (state.music.mode === "home") return "这里还没有音乐，先运行“刷新音乐库”。";
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
      musicTrackId: "",
      musicQuery: state.music.query || "",
      musicSort: state.music.sort || "album",
      musicFavorite: Boolean(state.music.favorite)
    };
  }

  function setMusicBodyClass() {
    document.body.classList.toggle("music-view", state.activeView === "music");
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

function playIcon(playing) {
  return playing ? "❚❚" : "▶";
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
