import { openMobileActionSheet } from "../../js/mobile-action-sheet.js?v=assets-22080e82f167";

export function createMusicPlaylistView(deps) {
  const {
    deleteCurrentPlaylist,
    editCurrentPlaylist,
    formatNumber,
    locateCurrentTrack,
    playVisibleCollection,
    setMusicSymbol,
    selectedPlaylist,
    state,
    symbolButton,
    updateListParams
  } = deps;

  function isPlaylistDetailView() {
    return state.mode === "playlist" && Boolean(state.playlistId);
  }

  function renderPlaylistHero() {
    const playlist = selectedPlaylist() || state.playlist || {};
    const tracks = playlistTracks();
    const hero = document.createElement("section");
    hero.className = "music-mobile-playlist-hero";

    const top = document.createElement("header");
    top.className = "music-mobile-playlist-topbar music-mobile-collection-topbar";
    const back = symbolButton("arrow-back", returnToMusicHome, false, "music-mobile-playlist-back", "返回我的音乐");
    const spacer = document.createElement("span");
    spacer.className = "music-mobile-auto-topbar-spacer";
    spacer.setAttribute("aria-hidden", "true");
    const management = renderPlaylistManagement();
    top.append(back, spacer, management);

    const identity = document.createElement("div");
    identity.className = "music-mobile-playlist-identity is-compact";
    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = playlist.name || "未命名歌单";
    const meta = document.createElement("small");
    meta.textContent = `我的歌单 · ${formatNumber(playlist.trackCount ?? tracks.length)} 首本地歌曲`;
    const description = document.createElement("em");
    description.textContent = playlist.description || "把喜欢的歌收在一起";
    text.append(title, meta, description);
    identity.append(text);

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

    hero.append(top, identity);
    if (tracks.length) hero.append(actions);
    return hero;
  }

  function renderPlaylistListHeader() {
    const tracks = playlistTracks();
    const header = document.createElement("section");
    header.className = "music-mobile-playlist-list-head";
    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = state.loading ? "正在读取" : "歌曲";
    const meta = document.createElement("small");
    meta.textContent = `${formatNumber(tracks.length)} 首`;
    text.append(title, meta);
    const actions = document.createElement("span");
    if (state.current && tracks.some((track) => track?.id === state.current?.id)) {
      const locate = document.createElement("button");
      locate.type = "button";
      locate.textContent = "定位";
      locate.disabled = state.loading;
      locate.addEventListener("click", locateCurrentTrack);
      actions.append(locate);
    }
    if (tracks.length) {
      const browse = document.createElement("button");
      browse.type = "button";
      browse.textContent = "添加歌曲";
      browse.addEventListener("click", browseLibrary);
      actions.append(browse);
    }
    header.append(text, actions);
    return header;
  }

  function renderPlaylistEmpty() {
    const empty = document.createElement("section");
    empty.className = "music-mobile-playlist-empty";
    const title = document.createElement("strong");
    title.textContent = "歌单里还没有歌曲";
    const description = document.createElement("p");
    description.textContent = "添加本地歌曲，建立自己的播放顺序。";
    const action = document.createElement("button");
    action.type = "button";
    action.textContent = "添加歌曲";
    action.addEventListener("click", browseLibrary);
    empty.append(title, description, action);
    return empty;
  }

  function renderPlaylistManagement() {
    const management = document.createElement("button");
    management.type = "button";
    management.className = "music-mobile-playlist-management";
    management.setAttribute("aria-label", "管理歌单");
    management.setAttribute("aria-haspopup", "dialog");
    setMusicSymbol(management, "more");
    management.addEventListener("click", () => {
      if (!management.isConnected) return;
      const sheet = openMobileActionSheet({
        title: "管理歌单",
        trigger: management,
        value: "",
        options: [
          {
            value: "edit",
            label: "编辑歌单",
            variant: "wide",
            closeOnSelect: false,
            select: (_value, _button, close) => {
              close();
              editCurrentPlaylist().catch(() => {});
            }
          },
          {
            value: "delete",
            label: "删除歌单",
            variant: "danger wide",
            closeOnSelect: false,
            select: (_value, _button, close) => {
              close();
              deleteCurrentPlaylist().catch(() => {});
            }
          }
        ]
      });
      sheet.panel.classList.add("music-mobile-playlist-management-sheet");
    });
    return management;
  }

  function playlistTracks() {
    return Array.isArray(state.data?.tracks) ? state.data.tracks.filter((track) => track?.id) : [];
  }

  function returnToMusicHome() {
    updateListParams({
      mode: "library",
      dashboard: true,
      playlistId: "",
      smartId: "",
      favorite: false,
      query: "",
      artistId: "",
      albumId: "",
      genre: "",
      language: ""
    }, { resetSearch: true });
  }

  function browseLibrary() {
    updateListParams({
      mode: "library",
      dashboard: false,
      playlistId: "",
      smartId: "",
      favorite: false,
      query: "",
      artistId: "",
      albumId: "",
      genre: "",
      language: ""
    }, { resetSearch: true });
  }

  return {
    isPlaylistDetailView,
    renderPlaylistEmpty,
    renderPlaylistHero,
    renderPlaylistListHeader
  };
}
