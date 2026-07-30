export function createMusicCollectionView(deps) {
  const {
    formatNumber,
    loadMoreTracks,
    locateCurrentTrack,
    messageBox,
    playVisibleCollection,
    renderCover,
    renderMusicSort,
    selectedAlbum,
    selectedArtist,
    setMusicSymbol,
    state,
    symbolButton,
    updateListParams
  } = deps;

  function isCollectionBrowserView() {
    return ["artists", "albums"].includes(state.mode) && !state.query;
  }

  function isCollectionDetailView() {
    return state.mode === "library" && Boolean(state.artistId || state.albumId);
  }

  function renderBrowserHeader(openSearch) {
    const artists = state.mode === "artists";
    const section = document.createElement("section");
    section.className = `music-mobile-collection-browser-head ${artists ? "is-artists" : "is-albums"}`;
    section.append(renderTopbar(artists ? "歌手" : "专辑", returnToMusicHome));

    const search = document.createElement("button");
    search.type = "button";
    search.className = "music-mobile-collection-search";
    search.setAttribute("aria-label", artists ? "搜索歌手" : "搜索专辑");
    const label = document.createElement("strong");
    label.textContent = artists ? "搜索歌手" : "搜索专辑";
    const count = document.createElement("small");
    count.textContent = state.loading
      ? "正在读取"
      : `${formatNumber(state.data?.total ?? currentItems().length)} ${artists ? "位" : "张"}`;
    search.append(label, count);
    search.addEventListener("click", openSearch);
    section.append(search);
    return section;
  }

  function renderBrowserToolbar() {
    const toolbar = document.createElement("section");
    toolbar.className = "music-mobile-collection-browser-toolbar";
    const modes = document.createElement("nav");
    modes.className = "music-mobile-collection-mode-tabs";
    modes.setAttribute("aria-label", "歌手与专辑浏览");
    for (const item of [
      { mode: "artists", label: "歌手" },
      { mode: "albums", label: "专辑" }
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = state.mode === item.mode ? "active" : "";
      button.textContent = item.label;
      button.addEventListener("click", () => switchMode(item.mode));
      modes.append(button);
    }
    toolbar.append(modes, renderMusicSort());
    return toolbar;
  }

  function renderBrowserContent(options = {}) {
    const section = document.createElement("section");
    section.className = `music-mobile-collection-browser ${state.mode === "artists" ? "is-artists" : "is-albums"}`;
    if (options.showLanguages !== false) section.append(renderLanguages());
    const list = document.createElement("div");
    list.className = state.mode === "artists"
      ? "music-mobile-collection-artist-list"
      : "music-mobile-collection-album-list";
    const items = currentItems();
    if (state.loading && !items.length) {
      list.append(messageBox(state.mode === "artists" ? "正在读取歌手资料库" : "正在读取专辑资料库"));
    } else if (!items.length) {
      list.append(messageBox(state.status || (state.mode === "artists" ? "没有匹配的歌手" : "没有匹配的专辑")));
    } else if (state.mode === "artists") {
      sortedArtists(items).forEach((artist) => list.append(renderArtistRow(artist)));
    } else {
      items.forEach((album) => list.append(renderAlbumRow(album)));
    }
    if (state.hasMore) list.append(renderLoadMore(items.length));
    section.append(list);
    return section;
  }

  function renderDetailHero() {
    const tracks = currentTracks();
    const firstTrack = tracks[0] || null;
    const albumDetail = Boolean(state.albumId);
    const album = albumDetail ? selectedAlbum() : null;
    const artist = selectedArtist();
    const titleText = albumDetail
      ? (album?.title || firstTrack?.album || "未知专辑")
      : (artist?.name || firstTrack?.artist || "未知歌手");
    const artwork = albumDetail && (album?.coverUrl || firstTrack?.coverUrl)
      ? (album?.coverUrl ? album : firstTrack)
      : null;
    const hero = document.createElement("section");
    hero.className = `music-mobile-collection-detail ${albumDetail ? "is-album" : "is-artist"} ${artwork ? "has-art" : "no-art"}`;
    hero.append(renderTopbar("", returnToCollectionBrowser));

    const identity = document.createElement("div");
    identity.className = `music-mobile-collection-identity ${artwork ? "has-art" : "no-art"}`;
    if (artwork) identity.append(renderCover(artwork, "detail"));
    const text = document.createElement("span");
    const kicker = document.createElement("small");
    kicker.textContent = "本地音乐";
    const title = document.createElement("strong");
    title.textContent = titleText;
    title.title = titleText;
    const meta = document.createElement("em");
    meta.textContent = albumDetail
      ? [album?.artistName || firstTrack?.artist || "", album?.year || "", `${formatNumber(state.data?.total ?? tracks.length)} 首`].filter(Boolean).join(" · ")
      : [artist?.language || state.language || "", `${formatNumber(state.data?.total ?? tracks.length)} 首`, artist?.albumCount ? `${formatNumber(artist.albumCount)} 张专辑` : ""].filter(Boolean).join(" · ");
    text.append(kicker, title, meta);
    identity.append(text);

    const actions = document.createElement("div");
    actions.className = "music-mobile-collection-actions";
    actions.append(
      playbackButton("播放全部", "play", false, tracks, "primary"),
      playbackButton("随机播放", "shuffle", true, tracks, "secondary")
    );
    hero.append(identity, actions);
    return hero;
  }

  function renderDetailListHeader() {
    const header = document.createElement("section");
    header.className = "music-mobile-collection-list-head";
    const label = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = "歌曲";
    const meta = document.createElement("small");
    meta.textContent = `${formatNumber(state.data?.total ?? currentTracks().length)} 首`;
    label.append(title, meta);
    header.append(label);
    if (state.current) {
      const locate = document.createElement("button");
      locate.type = "button";
      locate.textContent = "定位";
      locate.disabled = state.loading;
      locate.addEventListener("click", locateCurrentTrack);
      header.append(locate);
    }
    return header;
  }

  function renderTopbar(titleText, action) {
    const topbar = document.createElement("div");
    topbar.className = "music-mobile-playlist-topbar music-mobile-collection-topbar";
    const back = symbolButton("arrow-back", action, false, "music-mobile-playlist-back", "返回");
    const title = document.createElement("strong");
    title.textContent = titleText;
    const spacer = document.createElement("span");
    spacer.className = "music-mobile-collection-topbar-spacer";
    spacer.setAttribute("aria-hidden", "true");
    topbar.append(back, title, spacer);
    return topbar;
  }

  function renderLanguages() {
    const nav = document.createElement("nav");
    nav.className = "music-mobile-collection-languages";
    nav.setAttribute("aria-label", "音乐语种");
    const totals = state.mode === "artists"
      ? state.summary?.totals?.artists
      : state.summary?.totals?.albums;
    const unit = state.mode === "artists" ? "位" : "张";
    const source = state.summary?.languages || state.data?.languages || [];
    const items = [{ name: "", label: "全部", count: totals || 0 }, ...source.map((item) => ({
      name: item.name,
      label: item.name,
      count: state.mode === "artists" ? item.artistCount : item.albumCount
    }))];
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = state.language === item.name ? "active" : "";
      button.textContent = item.label;
      button.title = `${item.label} · ${formatNumber(item.count || 0)} ${unit}`;
      button.addEventListener("click", () => updateListParams({
        mode: state.mode,
        language: item.name,
        query: ""
      }, { resetSearch: true }));
      nav.append(button);
    }
    return nav;
  }

  function renderArtistRow(artist) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "music-mobile-collection-artist-row";
    const text = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = artist.name || "未知歌手";
    const meta = document.createElement("small");
    meta.textContent = `${artist.language || "其他"} · ${formatNumber(artist.albumCount || 0)} 张专辑`;
    text.append(name, meta);
    const count = document.createElement("em");
    count.textContent = `${formatNumber(artist.trackCount || 0)} 首`;
    button.append(text, count);
    button.addEventListener("click", () => openArtist(artist));
    return button;
  }

  function renderAlbumRow(album) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `music-mobile-collection-album-row${album.coverUrl ? " has-cover" : " no-cover"}`;
    if (album.coverUrl) button.append(renderCover(album, "tiny"));
    const text = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = album.title || "未知专辑";
    const meta = document.createElement("small");
    meta.textContent = [album.artistName || "未知歌手", album.year || ""].filter(Boolean).join(" · ");
    text.append(name, meta);
    const count = document.createElement("em");
    count.textContent = `${formatNumber(album.trackCount || 0)} 首`;
    button.append(text, count);
    button.addEventListener("click", () => openAlbum(album));
    return button;
  }

  function renderLoadMore(count) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "music-mobile-load-more";
    more.textContent = state.loadingMore
      ? "正在加载…"
      : `加载更多（已显示 ${formatNumber(count)} ${state.mode === "artists" ? "位" : "张"}）`;
    more.disabled = state.loadingMore;
    more.addEventListener("click", () => loadMoreTracks().catch(() => {}));
    return more;
  }

  function playbackButton(label, symbolName, shuffle, tracks, kind) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `music-mobile-collection-playback ${kind}`;
    setMusicSymbol(button, symbolName);
    const text = document.createElement("span");
    text.textContent = label;
    button.append(text);
    button.disabled = !tracks.length;
    button.setAttribute("aria-label", label);
    button.addEventListener("click", () => playVisibleCollection(shuffle));
    return button;
  }

  function switchMode(mode) {
    updateListParams({
      mode,
      dashboard: false,
      query: "",
      artistId: "",
      albumId: "",
      genre: ""
    }, { resetSearch: true });
  }

  function openArtist(artist) {
    updateListParams({
      mode: "library",
      dashboard: false,
      artistId: artist.id,
      albumId: "",
      genre: "",
      language: artist.language || "",
      query: ""
    }, { resetSearch: true });
  }

  function openAlbum(album) {
    updateListParams({
      mode: "library",
      dashboard: false,
      artistId: album.artistId || "",
      albumId: album.id,
      genre: "",
      query: ""
    }, { resetSearch: true });
  }

  function returnToMusicHome() {
    updateListParams({
      mode: "library",
      dashboard: true,
      artistId: "",
      albumId: "",
      query: "",
      language: ""
    }, { resetSearch: true });
  }

  function returnToCollectionBrowser() {
    updateListParams({
      mode: state.albumId ? "albums" : "artists",
      dashboard: false,
      artistId: "",
      albumId: "",
      genre: "",
      query: ""
    }, { resetSearch: true });
  }

  function currentItems() {
    const key = state.mode === "artists" ? "artists" : "albums";
    return Array.isArray(state.data?.[key]) ? state.data[key] : [];
  }

  function currentTracks() {
    return Array.isArray(state.data?.tracks) ? state.data.tracks : [];
  }

  function sortedArtists(items) {
    return items
      .map((artist, index) => ({ artist, index }))
      .sort((left, right) => Number(isUnknownArtist(left.artist)) - Number(isUnknownArtist(right.artist)) || left.index - right.index)
      .map(({ artist }) => artist);
  }

  function isUnknownArtist(artist = {}) {
    return /^(待识别|未知歌手|unknown artist|various artists)$/iu.test(String(artist.name || "").trim());
  }

  return {
    isCollectionBrowserView,
    isCollectionDetailView,
    renderBrowserContent,
    renderBrowserHeader,
    renderBrowserToolbar,
    renderDetailHero,
    renderDetailListHeader
  };
}
