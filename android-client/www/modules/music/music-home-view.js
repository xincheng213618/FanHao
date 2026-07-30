export function createMusicHomeView(deps) {
  const {
    createPlaylistFromPrompt,
    formatCompact,
    formatNumber,
    locateCurrentTrack,
    musicMeta,
    musicTitle,
    openSettings,
    openTrack,
    renderCover,
    renderMusicSort,
    selectedSmartPlaylist,
    state,
    togglePlayback,
    updateListParams
  } = deps;

  function isHomeView() {
    return state.mode === "library"
      && state.dashboard
      && !state.favorite
      && !state.query
      && !state.smartId
      && !state.playlistId
      && !state.artistId
      && !state.albumId
      && !state.genre
      && !state.language;
  }

  function renderSearchLauncher(openSearch) {
    const tools = document.createElement("section");
    tools.className = "music-mobile-home-tools";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "music-mobile-search-pill music-mobile-home-search";
    button.setAttribute("aria-label", "搜索歌曲、歌手、专辑和歌单");
    const title = document.createElement("strong");
    title.textContent = "搜索歌曲、歌手、专辑或歌单";
    button.append(title);
    button.addEventListener("click", openSearch);
    const settings = document.createElement("button");
    settings.type = "button";
    settings.className = "music-mobile-home-settings";
    settings.textContent = "设置";
    settings.addEventListener("click", openSettings);
    tools.append(button, settings);
    return tools;
  }

  function renderLibraryHeader() {
    const home = isHomeView();
    const header = document.createElement("section");
    header.className = `music-mobile-library-head${home ? " is-home" : " is-context"}`;
    const summary = currentSummary();
    const totals = summary.totals || {};

    const text = document.createElement("span");
    const kicker = document.createElement("small");
    kicker.textContent = home ? "我的音乐" : contextKicker();
    const title = document.createElement("strong");
    title.textContent = home ? "本地音乐" : musicTitle();
    const meta = document.createElement("em");
    meta.textContent = home && totals.tracks
      ? `${formatCompact(totals.tracks)} 首 · ${formatCompact(totals.albums)} 张专辑`
      : musicMeta(state.data);
    text.append(kicker, title, meta);

    const actions = document.createElement("span");
    actions.className = "music-mobile-library-actions";
    if (!["artists", "albums"].includes(state.mode)) {
      const play = document.createElement("button");
      play.type = "button";
      play.className = "music-mobile-play-all";
      play.dataset.musicPlaybackToggle = "true";
      play.textContent = state.current ? (state.playing ? "暂停" : "继续播放") : "播放全部";
      play.disabled = !state.queue.length;
      play.addEventListener("click", () => {
        const target = state.current || state.queue[0];
        if (!target) return;
        if (state.current) togglePlayback();
        else openTrack(target.id, { autoplay: true }).catch(() => {});
      });
      actions.append(play);
    }

    header.append(text, actions);
    return header;
  }

  function renderQuickAccess() {
    const section = document.createElement("section");
    section.className = "music-mobile-quick-access";
    const summary = currentSummary();
    const totals = summary.totals || {};
    const favorites = smartPlaylistById("favorites")?.trackCount || 0;
    const items = [
      {
        label: "歌曲",
        value: formatCompact(totals.tracks || 0),
        hint: "浏览全部歌曲",
        active: state.mode === "library" && !state.favorite && !state.dashboard,
        params: { mode: "library", favorite: false, dashboard: false }
      },
      {
        label: "我喜欢",
        value: formatCompact(favorites),
        hint: "收藏歌曲",
        active: state.favorite,
        params: { mode: "library", favorite: true, dashboard: false }
      },
      {
        label: "歌手",
        value: formatCompact(totals.artists || 0),
        hint: "按歌手浏览",
        active: state.mode === "artists",
        params: { mode: "artists", favorite: false, dashboard: false }
      },
      {
        label: "专辑",
        value: formatCompact(totals.albums || 0),
        hint: "按专辑浏览",
        active: state.mode === "albums",
        params: { mode: "albums", favorite: false, dashboard: false }
      }
    ];

    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `music-mobile-quick-card${item.active ? " active" : ""}`;
      const label = document.createElement("span");
      label.textContent = item.label;
      const value = document.createElement("strong");
      value.textContent = item.value;
      const hint = document.createElement("small");
      hint.textContent = item.hint;
      button.append(label, value, hint);
      button.addEventListener("click", () => updateListParams({
        ...item.params,
        query: "",
        smartId: "",
        playlistId: "",
        artistId: "",
        albumId: "",
        genre: "",
        language: ""
      }, { resetSearch: true }));
      section.append(button);
    }
    return section;
  }

  function renderRecentListening() {
    const section = document.createElement("section");
    section.className = "music-mobile-recent";
    const tracks = Array.isArray(currentSummary().recent) ? currentSummary().recent.slice(0, 8) : [];
    if (!tracks.length) {
      section.hidden = true;
      return section;
    }

    section.append(renderSectionHead("最近播放", "继续听", () => {
      updateListParams({ mode: "history", favorite: false, query: "" }, { resetSearch: true });
    }));
    const rail = document.createElement("div");
    rail.className = "music-mobile-recent-rail";
    for (const track of tracks) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "music-mobile-recent-card";
      button.append(renderCover(track, "tiny"));
      const text = document.createElement("span");
      text.className = "music-mobile-recent-text";
      const title = document.createElement("strong");
      title.textContent = track.title || "未知歌曲";
      const meta = document.createElement("small");
      meta.textContent = track.artist || "未知歌手";
      text.append(title, meta);
      button.append(text);
      button.addEventListener("click", () => {
        state.queue = tracks.map((item) => ({ ...item }));
        openTrack(track.id, { autoplay: true }).catch(() => {});
      });
      rail.append(button);
    }
    section.append(rail);
    return section;
  }

  function renderPlaylists() {
    const section = document.createElement("section");
    section.className = "music-mobile-playlists";
    const items = Array.isArray(state.playlists) ? state.playlists : [];
    section.append(renderSectionHead("我的歌单", items.length ? `${formatNumber(items.length)} 个` : "还没有歌单", () => {
      createPlaylistFromPrompt({ openAfterCreate: true }).catch(() => {});
    }, "新建"));

    const scroller = document.createElement("div");
    scroller.className = "music-mobile-playlist-scroll";
    if (!items.length) {
      const empty = document.createElement("button");
      empty.type = "button";
      empty.className = "music-mobile-playlist-card empty";
      empty.addEventListener("click", () => createPlaylistFromPrompt({ openAfterCreate: true }).catch(() => {}));
      const name = document.createElement("strong");
      name.textContent = "新建第一个歌单";
      const meta = document.createElement("small");
      meta.textContent = "把喜欢的歌收在一起";
      empty.append(name, meta);
      scroller.append(empty);
    } else {
      for (const item of items) {
        const active = state.mode === "playlist" && item.id === state.playlistId;
        const button = document.createElement("button");
        button.type = "button";
        button.className = `music-mobile-playlist-card${active ? " active" : ""}`;
        const name = document.createElement("strong");
        name.textContent = item.name || "未命名歌单";
        const meta = document.createElement("small");
        meta.textContent = `${formatNumber(item.trackCount || 0)} 首`;
        button.append(name, meta);
        button.addEventListener("click", () => updateListParams({
          mode: active ? "library" : "playlist",
          playlistId: active ? "" : item.id,
          smartId: "",
          favorite: false,
          query: "",
          artistId: "",
          albumId: "",
          genre: "",
          language: ""
        }, { resetSearch: true }));
        scroller.append(button);
      }
    }
    section.append(scroller);
    return section;
  }

  function renderSmartPlaylists() {
    const section = document.createElement("section");
    section.className = "music-mobile-smart";
    const order = ["topplayed", "newest", "unplayed", "hires", "lyrics", "toprated", "unrated"];
    const byId = new Map((state.smartPlaylists || []).map((item) => [item.id, item]));
    const items = order.map((id) => byId.get(id)).filter((item) => item && Number(item.trackCount || 0)).slice(0, 6);
    if (!items.length) {
      section.hidden = true;
      return section;
    }

    section.append(renderSectionHead("随心听", "自动整理"));
    const scroller = document.createElement("div");
    scroller.className = "music-mobile-smart-scroll";
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `music-mobile-smart-card${item.id === state.smartId ? " active" : ""}`;
      const badge = document.createElement("span");
      badge.className = "music-mobile-smart-badge";
      badge.textContent = item.badge || "Mix";
      const name = document.createElement("strong");
      name.textContent = item.name || "智能歌单";
      const count = document.createElement("em");
      count.textContent = `${formatCompact(item.trackCount || 0)} 首`;
      button.append(badge, name, count);
      button.addEventListener("click", () => updateListParams({
        mode: item.id === state.smartId ? "library" : "smart",
        smartId: item.id === state.smartId ? "" : item.id,
        playlistId: "",
        query: "",
        favorite: false,
        artistId: "",
        albumId: "",
        genre: "",
        language: ""
      }, { resetSearch: true }));
      scroller.append(button);
    }
    section.append(scroller);
    return section;
  }

  function renderTabs() {
    const tabs = document.createElement("nav");
    tabs.className = "music-mobile-tabs";
    tabs.setAttribute("aria-label", "音乐资料库导航");
    for (const tab of [
      { label: "全部", mode: "library", favorite: false },
      { label: "收藏", mode: "library", favorite: true },
      { label: "最近", mode: "history", favorite: false },
      { label: "歌手", mode: "artists", favorite: false },
      { label: "专辑", mode: "albums", favorite: false }
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = state.mode === tab.mode && state.favorite === tab.favorite ? "active" : "";
      button.textContent = tab.label;
      button.addEventListener("click", () => updateListParams({
        mode: tab.mode,
        favorite: tab.favorite,
        dashboard: false,
        query: "",
        smartId: "",
        playlistId: "",
        artistId: "",
        albumId: "",
        genre: "",
        language: ""
      }, { resetSearch: true }));
      tabs.append(button);
    }
    return tabs;
  }

  function renderControls() {
    const wrap = document.createElement("section");
    wrap.className = "music-mobile-controls";
    const label = document.createElement("span");
    label.className = "music-mobile-list-heading";
    const title = document.createElement("strong");
    title.textContent = state.mode === "artists" ? "全部歌手"
      : state.mode === "albums" ? "全部专辑"
        : state.artistId || state.albumId ? "歌曲"
          : isHomeView() ? "全部歌曲" : musicTitle();
    const meta = document.createElement("small");
    const count = formatNumber(state.data?.total
      ?? (state.mode === "artists" ? state.data?.artists?.length : state.mode === "albums" ? state.data?.albums?.length : state.data?.tracks?.length)
      ?? 0);
    const unit = state.mode === "artists" ? "位" : state.mode === "albums" ? "张" : "首";
    meta.textContent = state.loading ? "正在读取" : `${count} ${unit}`;
    label.append(title, meta);
    const actions = document.createElement("span");
    actions.className = "music-mobile-list-actions";
    if (state.current && !isHomeView() && !["artists", "albums"].includes(state.mode)) {
      const locate = document.createElement("button");
      locate.type = "button";
      locate.className = "music-mobile-text-button";
      locate.textContent = "定位";
      locate.disabled = state.loading;
      locate.addEventListener("click", locateCurrentTrack);
      actions.append(locate);
    }
    if (["library", "artists", "albums"].includes(state.mode) && !state.artistId && !state.albumId) actions.append(renderMusicSort());
    wrap.append(label, actions);
    return wrap;
  }

  function renderSectionHead(titleText, metaText, action = null, actionLabel = "查看全部") {
    const head = document.createElement("div");
    head.className = "music-mobile-smart-head";
    const title = document.createElement("strong");
    title.textContent = titleText;
    if (action) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "music-mobile-section-action";
      button.textContent = actionLabel;
      button.addEventListener("click", action);
      head.append(title, button);
      return head;
    }
    const meta = document.createElement("small");
    meta.textContent = metaText || "";
    head.append(title, meta);
    return head;
  }

  function currentSummary() {
    return state.summary || state.data?.summary || {};
  }

  function smartPlaylistById(id) {
    return (state.smartPlaylists || []).find((item) => item.id === id) || null;
  }

  function contextKicker() {
    if (state.mode === "playlist") return "我的歌单";
    if (state.smartId) return selectedSmartPlaylist()?.badge || "随心听";
    if (state.favorite) return "我的音乐";
    if (state.mode === "history") return "播放记录";
    if (state.mode === "artists") return "浏览";
    if (state.mode === "albums") return "浏览";
    return "本地音乐";
  }

  return {
    isHomeView,
    renderControls,
    renderLibraryHeader,
    renderPlaylists,
    renderQuickAccess,
    renderRecentListening,
    renderSearchLauncher,
    renderSmartPlaylists,
    renderTabs
  };
}
