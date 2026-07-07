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

  function ensureState() {
    if (!state.music) state.music = {};
    state.music.query = state.music.query || "";
    state.music.artistId = state.music.artistId || "all";
    state.music.albumId = state.music.albumId || "all";
    state.music.sort = state.music.sort || "album";
    state.music.favorite = Boolean(state.music.favorite);
    state.music.data = state.music.data || null;
    state.music.summary = state.music.summary || null;
    state.music.artists = Array.isArray(state.music.artists) ? state.music.artists : [];
    state.music.albums = Array.isArray(state.music.albums) ? state.music.albums : [];
    state.music.current = state.music.current || null;
    state.music.lyrics = state.music.lyrics || { raw: "", lines: [] };
    state.music.queue = Array.isArray(state.music.queue) ? state.music.queue : [];
    state.music.prevId = state.music.prevId || "";
    state.music.nextId = state.music.nextId || "";
    state.music.loading = Boolean(state.music.loading);
    state.music.playing = Boolean(state.music.playing);
    state.music.status = state.music.status || "";
    state.music.volume = readVolumePreference();
    state.music.repeat = normalizeRepeat(readRepeatPreference());
    state.music.shuffle = readShufflePreference();
    state.music.playReportedTrackId = state.music.playReportedTrackId || "";
    ensureAudio();
  }

  function ensureAudio() {
    if (!audio) {
      audio = new Audio();
      audio.preload = "metadata";
      audio.volume = readVolumePreference();
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
    state.music.query = route.musicQuery || "";
    state.music.artistId = route.musicArtistId || "all";
    state.music.albumId = route.musicAlbumId || "all";
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
    const params = musicListParams();
    params.set("limit", "1000");
    const data = await api(`/api/music/tracks?${params}`);
    state.music.data = data;
    state.music.summary = data.summary || state.music.summary;
    state.music.artists = data.artists || state.music.artists || [];
    state.music.albums = data.albums || state.music.albums || [];
    state.music.queue = data.tracks || [];
    state.music.loading = false;
    state.music.status = data.total ? "" : "这里还没有音乐，先运行“刷新音乐库”。";
    renderStats();
    renderView();
    if (!options.skipRoute) {
      const writer = options.replaceRoute ? replaceRoute : pushRoute;
      writer(musicRouteOverrides());
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
    if (!state.music.queue.length || !state.music.queue.some((track) => track.id === data.track.id)) {
      state.music.queue = [data.track];
    }
    loadAudioTrack(data.track, options.autoplay !== false);
    renderStats();
    renderView();
    if (!options.skipRoute) pushRoute({ ...musicRouteOverrides(), musicTrackId: data.track.id });
  }

  function loadAudioTrack(track, autoplay) {
    ensureAudio();
    const target = new URL(track.streamUrl, window.location.href).href;
    if (audio.src !== target) {
      audio.src = target;
      audio.load();
    }
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
    shell.append(renderHero(), renderLibraryLayout(), renderPlayerBar());
    els.workGrid.append(shell);
    updatePlaybackUi();
    updateLyricHighlight(true);
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
    scan.textContent = "刷新音乐库";
    scan.addEventListener("click", () => openAdminScript("music-library-rescan"));
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
    const artistsTitle = document.createElement("h3");
    artistsTitle.textContent = "歌手";
    const artistList = document.createElement("div");
    artistList.className = "music-artist-list";
    artistList.append(filterButton("all", "全部歌手", state.music.summary?.totals?.tracks || state.music.data?.total || 0, state.music.artistId === "all", () => {
      state.music.artistId = "all";
      state.music.albumId = "all";
      loadMusic({ replaceRoute: true }).catch(showError);
    }));
    for (const artist of state.music.artists || []) {
      artistList.append(filterButton(artist.id, artist.name, artist.trackCount, state.music.artistId === artist.id, () => {
        state.music.artistId = artist.id;
        state.music.albumId = "all";
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
      button.className = `music-album-mini${state.music.albumId === album.id ? " active" : ""}`;
      button.append(renderCover(album, "tiny"));
      const span = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = album.title;
      const small = document.createElement("small");
      small.textContent = `${album.artistName || "未知歌手"} · ${formatNumber(album.trackCount || 0)} 首`;
      span.append(strong, small);
      button.append(span);
      button.addEventListener("click", () => {
        state.music.artistId = album.artistId || state.music.artistId || "all";
        state.music.albumId = album.id;
        loadMusic({ replaceRoute: true }).catch(showError);
      });
      albums.append(button);
    }
    side.append(artistsTitle, artistList, albumsTitle, albums);
    return side;
  }

  function filterButton(id, label, count, active, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `music-filter-button${active ? " active" : ""}`;
    const strong = document.createElement("strong");
    strong.textContent = label;
    const span = document.createElement("span");
    span.textContent = formatNumber(count || 0);
    button.append(strong, span);
    button.addEventListener("click", action);
    return button;
  }

  function renderTrackPanel() {
    const panel = document.createElement("section");
    panel.className = "music-track-panel";
    const controls = document.createElement("div");
    controls.className = "music-controls";
    const search = document.createElement("label");
    search.className = "music-search";
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = "搜索歌曲、歌手、专辑或歌词";
    input.value = state.music.query || "";
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
      ["favorite", "收藏优先"]
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      sort.append(option);
    }
    sort.value = state.music.sort || "album";
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
    panel.append(controls, table);
    return panel;
  }

  function trackHeader() {
    const row = document.createElement("div");
    row.className = "music-track-row head";
    for (const label of ["", "歌曲", "歌手", "专辑", "音质", "时长"]) {
      const cell = document.createElement("span");
      cell.textContent = label;
      row.append(cell);
    }
    return row;
  }

  function trackRow(track, index) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `music-track-row${state.music.current?.id === track.id ? " active" : ""}`;
    row.setAttribute("aria-label", `播放 ${track.title}`);
    const number = document.createElement("span");
    number.textContent = state.music.current?.id === track.id && state.music.playing ? "||" : String(index + 1).padStart(2, "0");
    const title = document.createElement("span");
    title.className = "music-track-title";
    const strong = document.createElement("strong");
    strong.textContent = track.title;
    const small = document.createElement("small");
    small.textContent = track.hasLyrics ? "歌词" : track.fileName || "";
    title.append(strong, small);
    const artist = document.createElement("span");
    artist.textContent = track.artist || "未知歌手";
    const album = document.createElement("span");
    album.textContent = track.album || "未知专辑";
    const quality = document.createElement("span");
    quality.textContent = qualityLabel(track);
    const duration = document.createElement("span");
    duration.textContent = formatClock(track.durationMs || 0);
    row.append(number, title, artist, album, quality, duration);
    row.addEventListener("click", () => openTrack(track.id, { autoplay: true }).catch(showError));
    return row;
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
    actions.append(play, fav);
    panel.append(title, meta, actions, renderLyricPanel(), renderQueuePanel());
    return panel;
  }

  function renderLyricPanel() {
    const wrap = document.createElement("div");
    wrap.className = "music-lyrics";
    const title = document.createElement("strong");
    title.textContent = "歌词";
    const lines = document.createElement("div");
    lines.className = "music-lyric-lines";
    const lyricLines = state.music.lyrics?.lines || [];
    if (!lyricLines.length) {
      const empty = document.createElement("p");
      empty.textContent = "暂无歌词";
      lines.append(empty);
    } else {
      lyricLines.slice(0, 120).forEach((line, index) => {
        const p = document.createElement("p");
        p.dataset.index = String(index);
        p.dataset.timeMs = String(line.timeMs || 0);
        p.textContent = line.text || "";
        lines.append(p);
      });
    }
    wrap.append(title, lines);
    return wrap;
  }

  function renderQueuePanel() {
    const panel = document.createElement("div");
    panel.className = "music-queue";
    const title = document.createElement("strong");
    title.textContent = "播放队列";
    const list = document.createElement("div");
    list.className = "music-queue-list";
    for (const track of (state.music.queue || []).slice(0, 16)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = state.music.current?.id === track.id ? "active" : "";
      button.textContent = `${track.title} - ${track.artist || "未知歌手"}`;
      button.addEventListener("click", () => openTrack(track.id, { autoplay: true }).catch(showError));
      list.append(button);
    }
    panel.append(title, list);
    return panel;
  }

  function renderPlayerBar() {
    const track = state.music.current;
    const bar = document.createElement("section");
    bar.className = "music-player-bar";
    const identity = document.createElement("div");
    identity.className = "music-player-identity";
    if (track) identity.append(renderCover(track, "bar"));
    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = track?.title || "未播放";
    const meta = document.createElement("small");
    meta.textContent = track ? `${track.artist || "未知歌手"} · ${track.album || "未知专辑"}` : "从音乐库选择一首歌";
    text.append(title, meta);
    identity.append(text);

    const controls = document.createElement("div");
    controls.className = "music-player-controls";
    controls.append(controlButton("上一首", () => playAdjacent(-1, { autoplay: true }).catch(showError), !track));
    controls.append(controlButton(state.music.playing ? "暂停" : "播放", togglePlayback, !track, "primary"));
    controls.append(controlButton("下一首", () => playAdjacent(1, { autoplay: true }).catch(showError), !track));
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
    controls.append(progressWrap);

    const options = document.createElement("div");
    options.className = "music-player-options";
    const repeat = controlButton(repeatLabel(state.music.repeat), () => {
      state.music.repeat = nextRepeat(state.music.repeat);
      writeRepeatPreference(state.music.repeat);
      renderView();
    }, false);
    const shuffle = controlButton(state.music.shuffle ? "随机开" : "随机关", () => {
      state.music.shuffle = !state.music.shuffle;
      writeShufflePreference(state.music.shuffle);
      renderView();
    }, false);
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
    options.append(repeat, shuffle, volume);
    bar.append(identity, controls, options);
    currentProgressEls = { current, progress, total };
    return bar;
  }

  function controlButton(label, action, disabled = false, kind = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `music-control-button${kind ? ` ${kind}` : ""}`;
    button.textContent = label;
    button.disabled = disabled;
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

  async function toggleFavorite(trackId) {
    const data = await api(`/api/music/tracks/${encodeURIComponent(trackId)}/favorite`, { method: "POST", body: {} });
    const updated = data.track;
    if (!updated) return;
    if (state.music.current?.id === updated.id) state.music.current = { ...state.music.current, ...updated };
    state.music.queue = (state.music.queue || []).map((track) => (track.id === updated.id ? { ...track, ...updated } : track));
    if (state.music.data?.tracks) {
      state.music.data.tracks = state.music.data.tracks.map((track) => (track.id === updated.id ? { ...track, ...updated } : track));
    }
    renderView();
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
    if (!currentProgressEls || !audio) return;
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Number(state.music.current?.durationMs || 0) / 1000;
    const current = Number(audio.currentTime || 0);
    currentProgressEls.current.textContent = formatSeconds(current);
    currentProgressEls.total.textContent = formatSeconds(duration);
    currentProgressEls.progress.value = duration > 0 ? String(Math.round((current / duration) * 1000)) : "0";
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
      for (const item of document.querySelectorAll(".music-lyric-lines p")) {
        const active = Number(item.dataset.index || -1) === index;
        item.classList.toggle("active", active);
        if (active) item.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    });
  }

  function musicListParams() {
    const params = new URLSearchParams();
    if (state.music.query) params.set("q", state.music.query);
    if (state.music.artistId && state.music.artistId !== "all") params.set("artist", state.music.artistId);
    if (state.music.albumId && state.music.albumId !== "all") params.set("album", state.music.albumId);
    if (state.music.sort && state.music.sort !== "album") params.set("sort", state.music.sort);
    if (state.music.favorite) params.set("favorite", "1");
    return params;
  }

  function musicRouteOverrides() {
    return {
      view: "music",
      musicArtistId: state.music.artistId && state.music.artistId !== "all" ? state.music.artistId : "",
      musicAlbumId: state.music.albumId && state.music.albumId !== "all" ? state.music.albumId : "",
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
