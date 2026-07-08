import { fetchJson, postJson } from "./api.js?v=20260708-mobile-music-14";
import { absoluteUrl } from "./image.js?v=20260706-mobile-web-sync-01";
import { formatBytes, formatCompact, formatNumber } from "./format.js";

const DEFAULT_MODE = "library";
const DEFAULT_SORT = "album";
const DEFAULT_LIMIT = 900;
const MUSIC_VOLUME_KEY = "fanhao.android.music.volume";
const MUSIC_REPEAT_KEY = "fanhao.android.music.repeat";
const MUSIC_SHUFFLE_KEY = "fanhao.android.music.shuffle";
const MUSIC_LAST_TRACK_KEY = "fanhao.android.music.lastTrack";

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
    favorite: false,
    smartId: "",
    smartPlaylists: [],
    smartPlaylist: null,
    artistId: "",
    albumId: "",
    genre: "",
    data: null,
    summary: null,
    current: null,
    lyrics: { lines: [], raw: "" },
    queue: [],
    prevId: "",
    nextId: "",
    loading: false,
    status: "",
    playing: false,
    searchOpen: false,
    fullscreen: false,
    fullPanel: "lyrics",
    queueOpen: false,
    repeat: readRepeatPreference(),
    shuffle: readShufflePreference(),
    volume: readVolumePreference(),
    playReportedTrackId: "",
    restoreAttemptKey: "",
    mediaSessionTrackId: ""
  };

  let audio = null;
  let audioEventsInstalled = false;
  let progressTimer = 0;
  let lyricRaf = 0;
  let progressBindings = [];
  let currentLyricIndex = -1;
  let mediaSessionInstalled = false;

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
    await Promise.all([loadSmartPlaylists(renderGuard), loadMusic(renderGuard)]);
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
    state.favorite = ["1", "true", "yes"].includes(String(params.favorite || params.fav || "").trim().toLowerCase());
    state.smartId = String(params.smartId || params.smart || "").trim();
    state.artistId = String(params.artistId || params.artist || "").trim();
    state.albumId = String(params.albumId || params.album || "").trim();
    state.genre = String(params.genre || params.musicGenre || "").trim();
    if (state.smartId) {
      state.mode = "smart";
      state.favorite = false;
    }
    if (state.favorite) state.mode = "library";
    if (state.mode !== "library") {
      state.artistId = "";
      state.albumId = "";
      state.genre = "";
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
      state.data = data;
      state.summary = data.summary || state.summary;
      state.smartPlaylist = data.smartPlaylist || selectedSmartPlaylist();
      state.queue = Array.isArray(data.tracks) ? data.tracks : [];
      state.loading = false;
      state.status = state.queue.length ? "" : emptyMessage();
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
    if (autoplay) playAudio();
  }

  function ensureAudio() {
    if (!audio) {
      audio = new Audio();
      audio.preload = "metadata";
      audio.volume = state.volume;
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
    shell.className = "music-mobile-shell";
    shell.append(renderLibraryHeader(), renderSmartPlaylists(), renderTabs(), renderControls(), renderFacetFilters(), renderTrackList(), renderMiniPlayer());
    if (state.fullscreen) shell.append(renderFullPlayer());
    els.viewContent.append(shell);
    document.body.classList.toggle("music-player-open", state.fullscreen);
    els.viewTitle.textContent = musicTitle();
    els.viewMeta.textContent = state.status || musicMeta(state.data);
    updatePlaybackUi();
    if (state.fullscreen) updateLyricHighlight(true);
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
    meta.textContent = totals.tracks
      ? `${formatCompact(totals.tracks)} 首 · ${formatCompact(totals.albums)} 专辑 · ${formatBytes(totals.bytes || 0)}`
      : musicMeta(state.data);
    text.append(kicker, title, meta);

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

    header.append(text, playAll);
    return header;
  }

  function renderTabs() {
    const tabs = document.createElement("div");
    tabs.className = "music-mobile-tabs";
    for (const tab of [
      { label: "全部", mode: "library", favorite: false },
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
    search.placeholder = "搜索歌曲、歌手或专辑";
    search.value = state.query;
    search.disabled = state.mode === "history";
    const applySearch = () => updateListParams({ query: search.value.trim(), mode: state.mode === "smart" ? "smart" : "library", favorite: state.favorite });
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
    sort.setAttribute("aria-label", "音乐排序");
    sort.disabled = state.mode !== "library";
    for (const [value, label] of [
      ["album", "专辑"],
      ["artist", "歌手"],
      ["title", "歌名"],
      ["duration", "时长"],
      ["played", "最近"],
      ["favorite", "收藏"],
      ["rating", "评分"]
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = state.sort === value;
      sort.append(option);
    }
    sort.addEventListener("change", () => updateListParams({ sort: sort.value }));
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
    if (!artists.length && !albums.length && !genres.length) {
      wrap.hidden = true;
      return wrap;
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
    return wrap;
  }

  function renderTrackRow(track, index) {
    const isCurrent = state.current?.id === track.id;
    const isPlaying = isCurrent && state.playing;
    const row = document.createElement("div");
    row.className = `music-mobile-track${isCurrent ? " active" : ""}${isPlaying ? " playing" : ""}`;
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `播放 ${track.title || "歌曲"}`);
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
    meta.textContent = [track.artist || "未知歌手", track.album || "未知专辑", ratingLabel(track.rating)].filter(Boolean).join(" · ");
    text.append(title, meta);
    const side = document.createElement("span");
    side.className = "music-mobile-track-side";
    const favorite = iconButton(track.favorite ? "♥" : "♡", (event) => {
      event.stopPropagation();
      toggleFavorite(track.id).catch(() => {});
    }, false, `track-favorite${track.favorite ? " active" : ""}`, track.favorite ? "取消收藏" : "收藏");
    side.append(favorite);
    const duration = document.createElement("small");
    duration.textContent = formatClock(track.durationMs || 0);
    side.append(duration);
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
    player.addEventListener("click", (event) => {
      if (event.target?.closest?.("button,input,label")) return;
      openFullscreen();
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
    const progress = renderProgress("mini", track, play);
    player.append(text, play, next, progress);
    return player;
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
    const download = iconButton("↓", () => downloadTrack(track), !track?.downloadUrl, "ghost", "下载原文件");
    topActions.append(favorite, download);
    top.append(close, heading, topActions);

    const switcher = renderFullPanelSwitch(track, panel);
    const stage = document.createElement("div");
    stage.className = "music-mobile-full-stage";
    stage.append(panel === "lyrics" ? renderFullLyricsPanel(track) : renderFullCoverPanel(track));

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
      renderShell();
    }, !state.queue.length, state.queueOpen ? "active" : "ghost", "播放队列");
    controls.append(shuffle, prev, play, next, repeat, queue);

    const progress = renderProgress("full", track, play);
    full.append(top, switcher, stage, progress, controls);
    if (state.queueOpen) full.append(renderQueueSheet());
    if (panel === "lyrics") window.requestAnimationFrame(() => updateLyricHighlight(true));
    return full;
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
        state.fullPanel = panel;
        renderShell();
        if (panel === "lyrics") updateLyricHighlight(true);
      });
      switcher.append(button);
    }
    return switcher;
  }

  function renderFullCoverPanel(track) {
    const coverStage = document.createElement("div");
    coverStage.className = "music-mobile-full-cover-stage";
    coverStage.append(renderCover(track || { title: "音乐" }, "cover"));

    const rating = renderRatingControl(track);
    const panel = document.createElement("div");
    panel.className = "music-mobile-full-cover-panel";
    panel.append(coverStage, rating);
    return panel;
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
    lyrics.append(lines);
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
    const close = iconButton("×", () => {
      state.queueOpen = false;
      renderShell();
    }, false, "ghost", "关闭队列");
    head.append(title, meta, close);

    const list = document.createElement("div");
    list.className = "music-mobile-queue-list";
    if (!state.queue.length) {
      list.append(messageBox("队列里还没有歌曲"));
    } else {
      state.queue.forEach((track, index) => list.append(renderQueueItem(track, index)));
    }

    sheet.append(head, list);
    return sheet;
  }

  function renderQueueItem(track, index) {
    const active = state.current?.id === track.id;
    const row = document.createElement("button");
    row.type = "button";
    row.className = `music-mobile-queue-item${active ? " active" : ""}`;
    row.setAttribute("aria-label", `播放 ${track.title || "歌曲"}`);
    const number = document.createElement("span");
    number.className = "music-mobile-queue-index";
    if (active && state.playing) {
      number.append(renderPlayingBars());
    } else {
      number.textContent = String(index + 1).padStart(2, "0");
    }
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
    row.append(number, text, duration);
    row.addEventListener("click", () => {
      if (active) {
        state.queueOpen = false;
        renderShell();
        return;
      }
      openTrack(track.id, { autoplay: true }).catch(() => {});
    });
    return row;
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
    state.fullscreen = true;
    renderShell();
  }

  function closeFullscreen() {
    if (state.queueOpen) {
      state.queueOpen = false;
      renderShell();
      return true;
    }
    if (!state.fullscreen) return false;
    state.fullscreen = false;
    state.queueOpen = false;
    renderShell();
    return true;
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
    const adjacentId = direction > 0 ? state.nextId : state.prevId;
    if (adjacentId) {
      await openTrack(adjacentId, { autoplay: true });
      return;
    }
    const index = queue.findIndex((item) => item.id === state.current.id);
    let nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= queue.length) {
      if (!options.wrap && state.repeat !== "all") return;
      nextIndex = nextIndex < 0 ? queue.length - 1 : 0;
    }
    const target = queue[nextIndex] || queue[0];
    if (target) await openTrack(target.id, { autoplay: true });
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
    if (!state.fullscreen || state.fullPanel !== "lyrics" || lyricRaf) return;
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
      for (const item of els.viewContent.querySelectorAll(".music-mobile-full-lyric-lines [data-index]")) {
        const active = Number(item.dataset.index || -1) === index;
        item.classList.toggle("active", active);
        if (active) item.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    });
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
    if (Object.prototype.hasOwnProperty.call(patch, "query")) state.query = String(patch.query || "").trim();
    if (Object.prototype.hasOwnProperty.call(patch, "sort")) state.sort = normalizeSort(patch.sort);
    if (Object.prototype.hasOwnProperty.call(patch, "artistId")) state.artistId = String(patch.artistId || "").trim();
    if (Object.prototype.hasOwnProperty.call(patch, "albumId")) state.albumId = String(patch.albumId || "").trim();
    if (Object.prototype.hasOwnProperty.call(patch, "genre")) state.genre = String(patch.genre || "").trim();
    if (state.smartId) {
      state.mode = "smart";
      state.favorite = false;
    }
    if (state.mode !== "smart") state.smartId = "";
    if (state.mode !== "library") {
      state.artistId = "";
      state.albumId = "";
      state.genre = "";
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
    const query = musicListQuery();
    return `/api/music/tracks?${query}`;
  }

  function musicListQuery() {
    const params = new URLSearchParams();
    params.set("limit", String(DEFAULT_LIMIT));
    if (state.query) params.set("q", state.query);
    if (state.sort && state.sort !== DEFAULT_SORT && state.mode !== "smart") params.set("sort", state.sort);
    if (state.favorite) params.set("favorite", "1");
    if (state.smartId) params.set("smart", state.smartId);
    if (state.artistId) params.set("artist", state.artistId);
    if (state.albumId) params.set("album", state.albumId);
    if (state.genre) params.set("genre", state.genre);
    return params.toString();
  }

  function musicRouteParams() {
    return {
      mode: state.mode,
      ...(state.query ? { query: state.query } : {}),
      ...(state.sort !== DEFAULT_SORT && state.mode !== "smart" ? { sort: state.sort } : {}),
      ...(state.favorite ? { favorite: "1" } : {}),
      ...(state.smartId ? { smartId: state.smartId } : {}),
      ...(state.artistId ? { artistId: state.artistId } : {}),
      ...(state.albumId ? { albumId: state.albumId } : {}),
      ...(state.genre ? { genre: state.genre } : {})
    };
  }

  function musicTitle() {
    if (state.mode === "history") return "最近播放";
    if (state.smartId) return selectedSmartPlaylist()?.name || "智能歌单";
    if (state.genre) return state.genre;
    if (state.albumId) return selectedAlbumTitle() || "专辑";
    if (state.artistId) return selectedArtistName() || "歌手";
    if (state.favorite) return "收藏歌曲";
    return "音乐";
  }

  function musicMeta(data = state.data) {
    const summary = data?.summary || state.summary || {};
    const total = data?.total ?? state.queue.length;
    const totals = summary.totals || {};
    const scope = [selectedArtistName(), selectedAlbumTitle(), state.genre].filter(Boolean).join(" · ");
    if (state.loading) return state.status || "正在读取";
    if (state.mode === "history") return `${formatNumber(total || 0)} 首 · 最近播放`;
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
    if (state.mode === "history") return "还没有最近播放";
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

  function installLifecycle() {
    window.addEventListener("pagehide", () => saveProgress());
    window.addEventListener("fanhaoViewChanged", (event) => {
      if (event.detail?.view !== "music" && state.fullscreen) {
        state.fullscreen = false;
        state.queueOpen = false;
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

function normalizeMode(value) {
  const mode = String(value || DEFAULT_MODE).trim();
  return ["library", "history", "smart"].includes(mode) ? mode : DEFAULT_MODE;
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

function readVolumePreference() {
  try {
    const value = Number(window.localStorage?.getItem(MUSIC_VOLUME_KEY) || 0.86);
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.86;
  } catch {
    return 0.86;
  }
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
