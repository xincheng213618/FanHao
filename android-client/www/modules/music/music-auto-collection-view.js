export function createMusicAutoCollectionView(deps) {
  const {
    formatNumber,
    locateCurrentTrack,
    playVisibleCollection,
    renderHistoryManagement,
    setMusicSymbol,
    selectedSmartPlaylist,
    state,
    symbolButton,
    updateListParams
  } = deps;

  function isAutoCollectionView() {
    return !state.query && (
      state.mode === "history"
      || (state.mode === "smart" && Boolean(state.smartId))
    );
  }

  function renderAutoCollectionHero() {
    const history = isHistoryView();
    const smart = selectedSmartPlaylist();
    const tracks = currentTracks();
    const total = currentTotal(tracks);
    const hero = document.createElement("section");
    hero.className = `music-mobile-auto-hero${history ? " is-history" : ""}`;

    const topbar = document.createElement("div");
    topbar.className = "music-mobile-playlist-topbar music-mobile-collection-topbar";
    const back = symbolButton("arrow-back", returnToMusicHome, false, "music-mobile-playlist-back", "返回我的音乐");
    const heading = document.createElement("strong");
    heading.textContent = history ? "最近播放" : "";
    topbar.append(back, heading, history ? renderHistoryManagement() : renderTopbarSpacer());
    if (history) {
      hero.append(topbar);
      return hero;
    }

    const identity = document.createElement("div");
    identity.className = "music-mobile-auto-identity";
    const title = document.createElement("strong");
    title.textContent = smart?.name || "智能歌单";
    const description = document.createElement("em");
    description.textContent = smart?.description || "按照音乐资料自动整理，并随本地音乐库持续更新。";
    const meta = document.createElement("i");
    meta.textContent = `${formatNumber(total)} 首 · 自动更新`;
    identity.append(title, description, meta);

    const actions = document.createElement("div");
    actions.className = "music-mobile-playlist-primary-actions";
    const shuffle = document.createElement("button");
    shuffle.type = "button";
    shuffle.className = "secondary";
    shuffle.textContent = "随机播放";
    shuffle.disabled = !tracks.length;
    shuffle.addEventListener("click", () => playVisibleCollection(true));
    const play = document.createElement("button");
    play.type = "button";
    play.className = "primary";
    play.textContent = "播放全部";
    play.disabled = !tracks.length;
    play.addEventListener("click", () => playVisibleCollection(false));
    actions.append(shuffle, play);

    hero.append(topbar, identity, actions);
    return hero;
  }

  function renderAutoCollectionListHeader() {
    const tracks = currentTracks();
    const total = currentTotal(tracks);
    const header = document.createElement("section");
    header.className = "music-mobile-playlist-list-head";
    if (isHistoryView()) {
      header.classList.add("is-history");
      const play = document.createElement("button");
      play.type = "button";
      play.className = "music-mobile-history-play";
      play.disabled = state.loading || !tracks.length;
      const playIcon = document.createElement("span");
      playIcon.className = "music-mobile-history-play-icon";
      setMusicSymbol(playIcon, "play");
      const playLabel = document.createElement("span");
      playLabel.textContent = `播放全部 (${formatNumber(total)})`;
      play.append(playIcon, playLabel);
      play.addEventListener("click", () => playVisibleCollection(false));
      const actions = document.createElement("span");
      actions.className = "music-mobile-history-actions";
      actions.append(symbolButton(
        "shuffle",
        () => playVisibleCollection(true),
        state.loading || !tracks.length,
        "music-mobile-history-action",
        "随机播放"
      ));
      if (state.current) {
        actions.append(symbolButton(
          "my-location",
          locateCurrentTrack,
          state.loading,
          "music-mobile-history-action",
          "定位当前歌曲"
        ));
      }
      header.append(play, actions);
      return header;
    }
    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = "歌曲";
    const meta = document.createElement("small");
    meta.textContent = `${formatNumber(total)} 首 · ${isHistoryView() ? "最近播放在前" : "按规则自动整理"}`;
    text.append(title, meta);
    const actions = document.createElement("span");
    if (state.current) {
      const locate = document.createElement("button");
      locate.type = "button";
      locate.textContent = "定位";
      locate.disabled = state.loading;
      locate.addEventListener("click", locateCurrentTrack);
      actions.append(locate);
    }
    header.append(text, actions);
    return header;
  }

  function renderAutoCollectionEmpty() {
    const history = isHistoryView();
    const empty = document.createElement("section");
    empty.className = "music-mobile-playlist-empty";
    const title = document.createElement("strong");
    title.textContent = history ? "还没有播放记录" : "暂时没有符合条件的歌曲";
    const description = document.createElement("p");
    description.textContent = history
      ? "从本地歌曲开始播放，这里会自动保留最近听过的内容。"
      : "本地音乐库变化后，这个自动歌单也会跟着更新。";
    const browse = document.createElement("button");
    browse.type = "button";
    browse.textContent = "浏览歌曲";
    browse.addEventListener("click", browseLibrary);
    empty.append(title, description, browse);
    return empty;
  }

  function renderTopbarSpacer() {
    const spacer = document.createElement("span");
    spacer.className = "music-mobile-auto-topbar-spacer";
    spacer.setAttribute("aria-hidden", "true");
    return spacer;
  }

  function currentTracks() {
    return Array.isArray(state.data?.tracks) ? state.data.tracks : [];
  }

  function currentTotal(tracks = currentTracks()) {
    return Number(state.data?.total ?? tracks.length);
  }

  function isHistoryView() {
    return state.mode === "history";
  }

  function returnToMusicHome() {
    updateListParams({
      mode: "library",
      dashboard: true,
      smartId: "",
      favorite: false,
      query: ""
    }, { resetSearch: true });
  }

  function browseLibrary() {
    updateListParams({
      mode: "library",
      dashboard: false,
      smartId: "",
      favorite: false,
      query: ""
    }, { resetSearch: true });
  }

  return {
    isAutoCollectionView,
    renderAutoCollectionEmpty,
    renderAutoCollectionHero,
    renderAutoCollectionListHeader
  };
}
