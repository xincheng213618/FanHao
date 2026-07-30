export function createMusicLibraryView(deps) {
  const {
    formatNumber,
    locateCurrentTrack,
    openFacetFilters,
    playVisibleCollection,
    renderMusicSort,
    state,
    symbolButton,
    updateListParams
  } = deps;

  function isFocusedLibraryView() {
    return state.mode === "library"
      && !state.dashboard
      && !state.query
      && !state.smartId
      && !state.playlistId;
  }
  function renderHeader(openSearch) {
    const favorite = Boolean(state.favorite);
    const section = document.createElement("section");
    section.className = `music-mobile-focused-library-head${favorite ? " is-favorite" : " is-all"}`;
    const topbar = document.createElement("div");
    topbar.className = "music-mobile-playlist-topbar music-mobile-collection-topbar";
    const back = symbolButton("arrow-back", returnToMusicHome, false, "music-mobile-playlist-back", "返回我的音乐");
    const title = document.createElement("strong");
    title.textContent = favorite ? "我的收藏" : "全部歌曲";
    const spacer = document.createElement("span");
    spacer.className = "music-mobile-focused-library-spacer";
    spacer.setAttribute("aria-hidden", "true");
    topbar.append(back, title, spacer);

    const search = document.createElement("button");
    search.type = "button";
    search.className = "music-mobile-focused-library-search";
    search.setAttribute("aria-label", favorite ? "搜索我喜欢的歌曲" : "搜索全部歌曲");
    const searchText = document.createElement("strong");
    searchText.textContent = favorite ? "搜索我喜欢的歌曲" : "搜索全部歌曲";
    const searchMeta = document.createElement("small");
    searchMeta.textContent = `${formatNumber(currentTotal())} 首`;
    search.append(searchText, searchMeta);
    search.addEventListener("click", openSearch);

    section.append(topbar, search);
    return section;
  }
  function renderToolbar() {
    const tracks = currentTracks();
    const total = currentTotal(tracks);
    const favorite = Boolean(state.favorite);
    const toolbar = document.createElement("section");
    toolbar.className = "music-mobile-focused-library-toolbar";
    const play = document.createElement("button");
    play.type = "button";
    play.className = "music-mobile-focused-library-play";
    const playIcon = document.createElement("span");
    playIcon.className = "music-mobile-focused-library-play-icon";
    playIcon.setAttribute("aria-hidden", "true");
    const playGlyph = document.createElement("img");
    playGlyph.src = "./assets/icons/play.svg?v=20260730-music-home-ui-40";
    playGlyph.alt = "";
    playIcon.append(playGlyph);
    const playLabel = document.createElement("span");
    playLabel.className = "music-mobile-focused-library-play-label";
    playLabel.textContent = "播放全部";
    play.append(playIcon, playLabel);
    play.disabled = state.loading || !tracks.length;
    play.addEventListener("click", () => playVisibleCollection(false));
    const actions = document.createElement("span");
    actions.className = "music-mobile-focused-library-actions";
    if (!favorite) {
      const activeFilters = [state.language, state.genre, state.artistId, state.albumId].filter(Boolean).length;
      const filter = symbolButton(
        "filter-list",
        openFacetFilters,
        false,
        `music-mobile-focused-library-filter${activeFilters ? " active" : ""}`,
        activeFilters ? `筛选歌曲，已选 ${activeFilters} 项` : "筛选歌曲"
      );
      filter.setAttribute("aria-expanded", state.libraryFiltersOpen ? "true" : "false");
      filter.setAttribute("aria-controls", "music-library-filter-overlay");
      if (activeFilters) {
        const badge = document.createElement("small");
        badge.className = "music-mobile-focused-library-action-badge";
        badge.textContent = String(activeFilters);
        badge.setAttribute("aria-hidden", "true");
        filter.append(badge);
      }
      actions.append(filter);
    }
    if (state.current) {
      const locate = symbolButton(
        "my-location",
        locateCurrentTrack,
        state.loading,
        "music-mobile-focused-library-locate",
        "定位当前歌曲"
      );
      actions.append(locate);
    }
    actions.append(renderMusicSort());
    toolbar.append(play, actions);
    return toolbar;
  }

  function renderEmpty() {
    const favorite = Boolean(state.favorite);
    const empty = document.createElement("section");
    empty.className = "music-mobile-playlist-empty music-mobile-focused-library-empty";
    const title = document.createElement("strong");
    title.textContent = favorite ? "还没有喜欢的歌曲" : "本地音乐库还是空的";
    const description = document.createElement("p");
    description.textContent = favorite
      ? "在歌曲右侧点“收藏”，喜欢的内容会集中出现在这里。"
      : "完成本地音乐扫描后，歌曲会按当前排序显示在这里。";
    empty.append(title, description);
    if (favorite) {
      const browse = document.createElement("button");
      browse.type = "button";
      browse.textContent = "浏览全部歌曲";
      browse.addEventListener("click", browseAllSongs);
      empty.append(browse);
    }
    return empty;
  }

  function emptyMessage() {
    if (state.mode === "artists") return "没有匹配的歌手";
    if (state.mode === "albums") return "没有匹配的专辑";
    if (state.mode === "history") return "还没有最近播放";
    if (state.mode === "playlist") return "这个歌单还没有歌曲";
    if (state.smartId) return "这个智能歌单暂时没有歌曲";
    if (state.favorite) return "还没有喜欢的歌曲";
    if (state.artistId || state.albumId || state.genre) return "这个筛选下没有歌曲";
    if (state.query) return "没有匹配的歌曲";
    return "这里还没有音乐";
  }

  function currentTracks() {
    return Array.isArray(state.data?.tracks) ? state.data.tracks : [];
  }

  function currentTotal(tracks = currentTracks()) {
    return Number(state.data?.total ?? tracks.length);
  }

  function returnToMusicHome() {
    state.libraryFiltersOpen = false;
    state.sortSheetOpen = false;
    updateListParams({
      mode: "library",
      dashboard: true,
      favorite: false,
      query: "",
      artistId: "",
      albumId: "",
      genre: "",
      language: ""
    }, { resetSearch: true });
  }

  function browseAllSongs() {
    updateListParams({
      mode: "library",
      dashboard: false,
      favorite: false,
      query: ""
    }, { resetSearch: true });
  }

  return {
    emptyMessage,
    isFocusedLibraryView,
    renderEmpty,
    renderHeader,
    renderToolbar
  };
}
