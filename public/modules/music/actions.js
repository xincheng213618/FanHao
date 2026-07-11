// 音乐模块编排层（应用逻辑的唯一归属）。
// 视图层只调用这里暴露的方法；这里读取/写入 state.music、调用 api 与 player，
// 并通过 view 接口触发视图更新。不持有任何 DOM 渲染状态。
//
// 依赖（全部由组合根注入，单向）：
//   state    宿主全局状态（含 .music 与 .activeView）
//   api      createMusicApi(...) 返回的命名方法集合
//   player   createMusicPlayer(...) 返回的播放引擎
//   view     组合根提供的视图更新回调（refresh / 局部刷新 / loading 状态等）
//   router   路由写入 { push, replace, overrides }
//   showError 错误展示回调

import { ensureMusicState } from "./state.js";
import { collapseDuplicateTracks, compactTrack, normalizePlaybackSpeed, nextRepeat } from "./format.js";
import {
  writeLastTrackPreference,
  readLastTrackPreference,
  writeVolumePreference,
  writePlaybackSpeedPreference,
  writeRepeatPreference,
  writeShufflePreference
} from "./prefs.js";
import {
  MUSIC_PAGE_LIMIT,
  MUSIC_ARTIST_PAGE_LIMIT,
  MUSIC_ALBUM_PAGE_LIMIT
} from "./constants.js";

export function createMusicActions({ state, api, player, view, router, showError }) {
  let musicLoadGeneration = 0;
  let musicLoadController = null;
  let trackOpenGeneration = 0;
  let trackOpenController = null;
  let restoreAttemptKey = "";
  let pendingProgressRecord = null;
  let progressTimer = null;
  let lastProgressSavedAt = 0;
  let playlistDialogReturnFocus = null;

  const music = () => state.music;

  // ---------- 列表加载 ----------
  async function loadMusic(options = {}) {
    ensureMusicState(state);
    const artistMode = music().mode === "artists";
    const albumMode = music().mode === "albums";
    const append = Boolean(options.append && (music().mode === "library" || artistMode || albumMode));
    const appendScrollTop = append ? Math.max(0, Number(document.querySelector(".music-track-panel")?.scrollTop || 0)) : 0;
    const generation = ++musicLoadGeneration;
    musicLoadController?.abort();
    const controller = new AbortController();
    musicLoadController = controller;
    const signal = controller.signal;
    music().loading = !append;
    music().loadingMore = append;
    music().status = append ? "正在加载更多" : "正在读取音乐库";
    view.setMusicListLoadingState(true, { append });
    const listsPromise = append ? Promise.resolve() : Promise.all([
      sideListCacheFresh(music().playlistsLoadedAt) ? Promise.resolve() : loadPlaylists(signal),
      sideListCacheFresh(music().smartPlaylistsLoadedAt) ? Promise.resolve() : loadSmartPlaylists(signal)
    ]);
    const params = musicListParams();
    params.set("limit", String(artistMode ? MUSIC_ARTIST_PAGE_LIMIT : albumMode ? MUSIC_ALBUM_PAGE_LIMIT : MUSIC_PAGE_LIMIT));
    if (append) {
      params.set("offset", String(
        artistMode ? music().data?.artists?.length || 0
          : albumMode ? music().data?.albums?.length || 0
            : music().data?.rawLoaded ?? music().data?.tracks?.length ?? 0
      ));
    }
    let data;
    try {
      if (artistMode) {
        const artistParams = new URLSearchParams();
        artistParams.set("limit", String(MUSIC_ARTIST_PAGE_LIMIT));
        artistParams.set("sort", music().artistSort);
        if (append) artistParams.set("offset", params.get("offset") || "0");
        if (music().query) artistParams.set("q", music().query);
        if (music().language && music().language !== "all") artistParams.set("language", music().language);
        if (music().letter) artistParams.set("letter", music().letter);
        data = await api.getArtists(artistParams, signal);
      } else if (albumMode) {
        const albumParams = new URLSearchParams();
        albumParams.set("limit", String(MUSIC_ALBUM_PAGE_LIMIT));
        albumParams.set("sort", music().albumSort);
        if (append) albumParams.set("offset", params.get("offset") || "0");
        if (music().query) albumParams.set("q", music().query);
        if (music().language && music().language !== "all") albumParams.set("language", music().language);
        if (music().letter) albumParams.set("letter", music().letter);
        data = await api.getAlbums(albumParams, signal);
      } else if (music().mode === "history") {
        data = await api.getHistory(MUSIC_PAGE_LIMIT, signal);
      } else if (music().mode === "playlist" && music().activePlaylistId) {
        data = await api.getPlaylist(music().activePlaylistId, signal);
      } else if (music().mode === "smart" && music().activeSmartPlaylistId) {
        const smartParams = new URLSearchParams();
        smartParams.set("limit", String(MUSIC_PAGE_LIMIT));
        if (append) smartParams.set("offset", params.get("offset"));
        data = await api.getSmartPlaylist(music().activeSmartPlaylistId, smartParams, signal);
      } else if (music().mode === "report") {
        data = await api.getReport(signal);
      } else if (music().mode === "home") {
        data = await api.getHome(signal);
      } else {
        music().mode = "library";
        data = await api.getTracks(params, signal);
      }
      await listsPromise;
    } catch (error) {
      if (controller.signal.aborted || generation !== musicLoadGeneration) return;
      music().loading = false;
      music().loadingMore = false;
      music().status = error?.message || "音乐列表读取失败";
      musicLoadController = null;
      view.setMusicListLoadingState(false);
      view.refresh();
      throw error;
    }
    if (controller.signal.aborted || generation !== musicLoadGeneration) return;
    const incomingTracks = data.tracks || [];
    const previousRawTracks = append ? music().data?.rawTracks || music().data?.tracks || [] : [];
    const mergedRawTracks = append ? [...previousRawTracks, ...incomingTracks] : incomingTracks;
    const mergedTracks = music().mode === "library" && music().query
      ? collapseDuplicateTracks(mergedRawTracks)
      : mergedRawTracks;
    const previousArtists = append && artistMode ? music().data?.artists || [] : [];
    const mergedArtists = artistMode ? (append ? [...previousArtists, ...(data.artists || [])] : data.artists || []) : data.artists;
    const previousAlbums = append && albumMode ? music().data?.albums || [] : [];
    const mergedAlbums = albumMode ? (append ? [...previousAlbums, ...(data.albums || [])] : data.albums || []) : data.albums;
    music().data = artistMode
      ? { ...data, artists: mergedArtists, tracks: [] }
      : albumMode
        ? { ...data, albums: mergedAlbums, tracks: [] }
        : { ...data, tracks: mergedTracks, rawTracks: mergedRawTracks, rawLoaded: mergedRawTracks.length };
    music().summary = data.summary || music().summary;
    music().artists = mergedArtists || music().artists || [];
    music().albums = mergedAlbums || music().albums || [];
    music().genres = data.genres || music().genres || [];
    music().languages = data.languages || data.summary?.languages || music().languages || [];
    music().activePlaylist = data.playlist || null;
    music().activeSmartPlaylist = data.smartPlaylist || null;
    if (!artistMode && !albumMode && !music().current) music().queue = mergedTracks;
    music().loading = false;
    music().loadingMore = false;
    music().hasMore = Boolean(data.hasMore);
    music().status = artistMode
      ? (data.total ? "" : "没有匹配的歌手")
      : albumMode
        ? (data.total ? "" : "没有匹配的专辑")
        : emptyMusicMessage(music(), data.total || music().queue.length);
    const appendedInPlace = append && (
      artistMode
        ? view.appendArtistPage(data.artists || [], previousArtists.length)
        : albumMode
          ? view.appendAlbumPage(data.albums || [], previousAlbums.length)
          : Boolean(music().current) && view.appendLibraryTrackPage(incomingTracks, previousRawTracks.length)
    );
    if (!artistMode && !albumMode && options.restoreLast !== false) await restoreLastTrack();
    musicLoadController = null;
    view.setMusicListLoadingState(false);
    view.renderStats();
    if (!appendedInPlace && !view.refreshMusicLibraryContent()) view.refresh();
    if (append && !appendedInPlace) view.restoreMusicPanelScroll(appendScrollTop);
    if (!options.skipRoute) {
      const writer = options.replaceRoute ? router.replace : router.push;
      writer(router.overrides());
    }
  }

  async function loadPlaylists(signal) {
    try {
      const data = await api.getPlaylists(signal);
      music().playlists = data.playlists || [];
      music().playlistsLoadedAt = Date.now();
    } catch {
      music().playlists = music().playlists || [];
    }
  }

  async function loadSmartPlaylists(signal) {
    try {
      const data = await api.getSmartPlaylists(signal);
      music().smartPlaylists = data.smartPlaylists || [];
      music().smartPlaylistsLoadedAt = Date.now();
    } catch {
      music().smartPlaylists = music().smartPlaylists || [];
    }
  }

  function sideListCacheFresh(loadedAt) {
    return Number(loadedAt || 0) > 0 && Date.now() - Number(loadedAt) < 60000;
  }

  // ---------- 打开单曲 ----------
  async function openTrack(trackId, options = {}) {
    ensureMusicState(state);
    if (!trackId) return null;
    const previousTrackId = music().current?.id || "";
    if (music().current?.id === trackId && player.getAudio().src && !options.forceReload) {
      if (trackOpenController) {
        trackOpenGeneration += 1;
        trackOpenController.abort();
        trackOpenController = null;
        music().openingTrackId = "";
        music().status = "";
        view.setTrackOpeningState("");
      }
      if (options.openPage) {
        music().trackPageOpen = true;
        music().playerStageOpen = false;
        view.refresh();
        if (!options.skipRoute) router.push({ ...router.overrides(), musicTrackId: trackId });
      }
      if (options.autoplay !== false) player.play();
      return music().current;
    }
    if (music().current?.id && music().current.id !== trackId) {
      saveProgressSoon(null, { immediate: true });
    }
    const generation = ++trackOpenGeneration;
    trackOpenController?.abort();
    const controller = new AbortController();
    trackOpenController = controller;
    music().openingTrackId = trackId;
    music().status = "正在打开歌曲";
    view.setTrackOpeningState(trackId);
    let data;
    try {
      data = await api.getTrack(trackId, musicListParams(), controller.signal);
    } catch (error) {
      if (controller.signal.aborted || generation !== trackOpenGeneration) return null;
      music().openingTrackId = "";
      music().status = error?.message || "歌曲打开失败";
      trackOpenController = null;
      view.setTrackOpeningState("");
      if (state.activeView === "music") view.refresh();
      throw error;
    }
    if (controller.signal.aborted || generation !== trackOpenGeneration) return null;
    if (!data?.track?.id) {
      music().openingTrackId = "";
      music().status = "歌曲资料不完整";
      trackOpenController = null;
      view.setTrackOpeningState("");
      if (state.activeView === "music") view.refresh();
      throw new Error(music().status);
    }
    music().current = data.track;
    music().lyrics = data.lyrics || { raw: "", lines: [] };
    music().prevId = data.prevId || "";
    music().nextId = data.nextId || "";
    music().openingTrackId = "";
    music().status = "";
    music().playReportedTrackId = "";
    music().lyricFollowPaused = false;
    music().libraryDrawerOpen = false;
    const shouldOpenPage = Boolean(options.openPage || music().trackPageOpen);
    music().trackPageOpen = shouldOpenPage;
    music().playerStageOpen = false;
    currentLyricIndexReset();
    if (!music().queue.length || !music().queue.some((track) => track.id === data.track.id)) {
      music().queue = [data.track];
    }
    rememberLastTrack(data.track);
    player.load(data.track, options.autoplay !== false);
    trackOpenController = null;
    view.setTrackOpeningState("");
    if (state.activeView === "music") {
      if (shouldOpenPage || !view.refreshCurrentTrackSurfaces(previousTrackId)) view.refresh();
    }
    if (!options.skipRoute && shouldOpenPage) {
      router.push({ ...router.overrides(), musicTrackId: data.track.id });
    }
    return data.track;
  }

  let currentLyricIndexValue = -1;
  function currentLyricIndexReset() {
    currentLyricIndexValue = -1;
  }

  function openTrackFromList(track, tracks = [], options = {}) {
    const item = normalizeQueueTrack(track);
    if (!item) return Promise.resolve(null);
    const source = uniqueQueueTracks(tracks);
    music().queue = source.some((candidate) => candidate.id === item.id) ? source : [item];
    music().queueVisibleLimit = 120;
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

  // ---------- 队列操作 ----------
  function queueTrackNext(track) {
    const item = normalizeQueueTrack(track);
    if (!item) return;
    const currentId = music().current?.id || "";
    const queue = withoutQueueTrack(music().queue || [], item.id);
    const currentIndex = currentId ? queue.findIndex((entry) => entry.id === currentId) : -1;
    queue.splice(currentIndex >= 0 ? currentIndex + 1 : 0, 0, item);
    music().queue = queue;
    music().status = `下一首播放「${item.title || "歌曲"}」`;
    view.refreshQueueSurface();
  }

  function appendTrackToQueue(track) {
    const item = normalizeQueueTrack(track);
    if (!item) return;
    const queue = withoutQueueTrack(music().queue || [], item.id);
    queue.push(item);
    music().queue = queue;
    music().status = `已加入队列「${item.title || "歌曲"}」`;
    view.refreshQueueSurface();
  }

  function moveQueueTrack(trackId, direction) {
    const queue = [...(music().queue || [])];
    const index = queue.findIndex((track) => track.id === trackId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= queue.length) return;
    const [item] = queue.splice(index, 1);
    queue.splice(nextIndex, 0, item);
    music().queue = queue;
    music().status = `已调整「${item.title || "歌曲"}」顺序`;
    view.refreshQueueSurface();
    persistPlaylistQueueOrder(queue).catch(showError);
  }

  function removeTrackFromQueue(trackId) {
    if (!trackId || music().current?.id === trackId) return;
    const queue = music().queue || [];
    const removed = queue.find((track) => track.id === trackId);
    music().queue = queue.filter((track) => track.id !== trackId);
    music().status = removed ? `已移出队列「${removed.title || "歌曲"}」` : "已更新队列";
    view.refreshQueueSurface();
  }

  function clearQueueAfterCurrent() {
    const current = music().current;
    const removable = queueRemovableCount();
    if (removable <= 0) return;
    const ok = window.confirm(current
      ? `清空队列中的其他 ${formatNumberSafe(removable)} 首歌曲？`
      : `清空播放队列中的 ${formatNumberSafe(removable)} 首歌曲？`);
    if (!ok) return;
    if (!current) {
      music().queue = [];
    } else {
      music().queue = (music().queue || []).filter((track) => track.id === current.id);
    }
    music().queueVisibleLimit = 120;
    music().status = current ? "已清空其他队列歌曲" : "已清空播放队列";
    view.refreshQueueSurface();
  }

  function queueRemovableCount() {
    const queue = music().queue || [];
    if (!music().current) return queue.length;
    return queue.filter((track) => track.id !== music().current.id).length;
  }

  function queueTrackIds() {
    return uniqueTrackIds(music().queue || []);
  }

  async function persistPlaylistQueueOrder(queue = music().queue || []) {
    const playlistId = music().mode === "playlist" ? String(music().activePlaylistId || "").trim() : "";
    if (!playlistId) return null;
    const trackIds = uniqueTrackIds(queue);
    if (!trackIds.length) return null;
    const data = await api.reorderPlaylist(playlistId, { trackIds });
    music().activePlaylist = data.playlist || music().activePlaylist;
    if (music().data?.playlist?.id === playlistId) music().data.playlist = data.playlist || music().data.playlist;
    music().status = "歌单顺序已保存";
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

  // ---------- 播放控制 ----------
  async function playAdjacent(direction, options = {}) {
    ensureMusicState(state);
    const queue = music().queue || [];
    if (!queue.length) return;
    if (music().shuffle && queue.length > 1) {
      const candidates = queue.filter((track) => track.id !== music().current?.id);
      const target = candidates[Math.floor(Math.random() * candidates.length)];
      if (target) await openTrack(target.id, { autoplay: options.autoplay !== false });
      return;
    }
    const currentIndex = queue.findIndex((track) => track.id === music().current?.id);
    let nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= queue.length) {
      if (!options.wrap) return;
      nextIndex = nextIndex < 0 ? queue.length - 1 : 0;
    }
    const target = queue[nextIndex] || queue[0];
    if (target) await openTrack(target.id, { autoplay: options.autoplay !== false });
  }

  function togglePlayback() {
    ensureMusicState(state);
    if (!music().current) {
      const first = music().queue[0];
      if (first) openTrack(first.id, { autoplay: true }).catch(showError);
      return;
    }
    const audio = player.getAudio();
    if (audio.paused) player.play();
    else player.pause();
  }

  function setPlaybackSpeed(value) {
    const speed = normalizePlaybackSpeed(value);
    music().playbackSpeed = speed;
    player.setRate(speed);
    writePlaybackSpeedPreference(speed);
    view.updatePlaybackUi();
  }

  function setSleepTimer(minutes) {
    player.setSleepTimer(minutes);
  }

  function toggleShuffleMode() {
    music().shuffle = !music().shuffle;
    writeShufflePreference(music().shuffle);
    view.updatePlaybackModeControls();
  }

  function cycleRepeatMode() {
    music().repeat = nextRepeat(music().repeat);
    writeRepeatPreference(music().repeat);
    view.updatePlaybackModeControls();
  }

  // ---------- 收藏 / 评分 ----------
  function applyTrackUpdate(updated) {
    if (music().current?.id === updated.id) music().current = { ...music().current, ...updated };
    music().queue = (music().queue || []).map((track) => (track.id === updated.id ? { ...track, ...updated } : track));
    if (music().data?.tracks) {
      music().data.tracks = music().data.tracks.map((track) => (track.id === updated.id ? { ...track, ...updated } : track));
    }
  }

  function trackMetadataRequiresReload(kind) {
    if (music().mode === "smart") return true;
    if (kind === "favorite" && (music().favorite || music().sort === "favorite")) return true;
    if (kind === "rating" && music().sort === "rating") return true;
    return false;
  }

  async function toggleFavorite(trackId) {
    const data = await api.setFavorite(trackId);
    const updated = data.track;
    if (!updated) return;
    applyTrackUpdate(updated);
    if (trackMetadataRequiresReload("favorite")) await loadMusic({ replaceRoute: true, keepCurrent: true });
    else view.refreshTrackMetadata(updated);
  }

  async function setTrackRating(trackId, rating) {
    const data = await api.setRating(trackId, rating);
    const updated = data.track;
    if (!updated) return;
    applyTrackUpdate(updated);
    if (trackMetadataRequiresReload("rating")) await loadMusic({ replaceRoute: true, keepCurrent: true });
    else view.refreshTrackMetadata(updated);
  }

  // ---------- 下载 ----------
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

  // ---------- 模式切换 ----------
  function selectMusicMode(mode, options = {}) {
    ensureMusicState(state);
    view.clearMusicSuggestions();
    music().mode = mode;
    music().activePlaylistId = mode === "playlist" ? options.playlistId || "" : "";
    music().activeSmartPlaylistId = mode === "smart" ? options.smartId || "" : "";
    music().activePlaylist = null;
    music().activeSmartPlaylist = null;
    music().playlistDialogOpen = false;
    music().playlistDialogTrackId = "";
    music().playlistDialogName = "";
    music().favorite = mode === "library" ? Boolean(options.favorite) : false;
    if (mode === "library") {
      music().artistId = options.artistId || "all";
      music().albumId = options.albumId || "all";
      music().genre = options.genre || "all";
      if (options.language) music().language = options.language;
    }
    if (mode !== "library") {
      music().query = "";
      music().artistId = "all";
      music().albumId = "all";
      music().genre = "all";
    }
    loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
  }

  function selectGenre(genre) {
    ensureMusicState(state);
    view.clearMusicSuggestions();
    music().mode = "library";
    music().favorite = false;
    music().activePlaylistId = "";
    music().activeSmartPlaylistId = "";
    music().artistId = "all";
    music().albumId = "all";
    music().genre = String(genre || "").trim() || "all";
    loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
  }

  function selectFirstSmartPlaylist() {
    const smart = (music().smartPlaylists || []).find((item) => item?.id);
    if (smart) {
      selectMusicMode("smart", { smartId: smart.id });
      return;
    }
    loadSmartPlaylists()
      .then(() => {
        const loaded = (music().smartPlaylists || []).find((item) => item?.id);
        if (loaded) selectMusicMode("smart", { smartId: loaded.id });
        else view.refresh();
      })
      .catch(showError);
  }

  async function openPlaylistDialog(trackId = "") {
    ensureMusicState(state);
    playlistDialogReturnFocus = document.activeElement?.isConnected ? document.activeElement : null;
    music().playlistDialogOpen = true;
    music().playlistDialogTrackId = trackId || "";
    music().playlistDialogName = "";
    if (state.activeView === "music" && !view.refreshPlaylistDialog()) view.refresh();
    const requestedTrackId = music().playlistDialogTrackId;
    await loadPlaylists();
    if (music().playlistDialogOpen && music().playlistDialogTrackId === requestedTrackId) view.refreshPlaylistDialog();
  }

  function closePlaylistDialog() {
    const returnFocus = playlistDialogReturnFocus;
    playlistDialogReturnFocus = null;
    music().playlistDialogOpen = false;
    music().playlistDialogTrackId = "";
    music().playlistDialogName = "";
    if (state.activeView === "music" && !view.refreshPlaylistDialog({ focus: false })) view.refresh();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }

  // ---------- 歌单 ----------
  async function createPlaylistFromDialog() {
    const name = String(music().playlistDialogName || "").trim();
    if (!name) return null;
    const trackId = music().playlistDialogTrackId || "";
    closePlaylistDialog();
    music().status = "正在创建歌单";
    const data = await api.createPlaylist({ name });
    if (trackId && data.playlist?.id) {
      await api.addTrackToPlaylist(data.playlist.id, { trackId });
    }
    await loadPlaylists();
    if (data.playlist?.id) {
      music().mode = "playlist";
      music().activePlaylistId = data.playlist.id;
      music().favorite = false;
      music().query = "";
      await loadMusic({ replaceRoute: true, keepCurrent: true });
    } else {
      view.refresh();
    }
    return data.playlist || null;
  }

  async function saveQueueAsPlaylist() {
    const trackIds = queueTrackIds();
    if (!trackIds.length) {
      music().status = "播放队列为空";
      view.refresh();
      return null;
    }
    const name = window.prompt("歌单名称", defaultQueuePlaylistName());
    const clean = String(name || "").trim();
    if (!clean) return null;
    music().status = "正在保存播放队列";
    view.refresh();
    const data = await api.createPlaylist({
      name: clean,
      description: "从播放队列保存",
      trackIds
    });
    await loadPlaylists();
    if (data.playlist?.id) {
      music().mode = "playlist";
      music().activePlaylistId = data.playlist.id;
      music().favorite = false;
      music().query = "";
      music().artistId = "all";
      music().albumId = "all";
      music().genre = "all";
      await loadMusic({ replaceRoute: true, keepCurrent: true });
    } else {
      music().status = "播放队列已保存";
      view.refresh();
    }
    return data.playlist || null;
  }

  async function importPlaylistM3uFromPrompt() {
    const value = window.prompt("输入 .m3u/.m3u8 文件路径，或粘贴 #EXTM3U 内容", "");
    const source = String(value || "").trim();
    if (!source) return null;
    music().status = "正在导入 M3U 歌单";
    view.refresh();
    const body = source.includes("\n") || source.toUpperCase().startsWith("#EXTM3U")
      ? { content: source }
      : { path: source };
    const data = await api.importM3u(body);
    await loadPlaylists();
    if (data.playlist?.id) {
      const summary = data.importSummary || {};
      music().status = `已导入歌单：匹配 ${formatNumberSafe(summary.matched || 0)} 首，缺失 ${formatNumberSafe(summary.missing || 0)} 项`;
      music().mode = "playlist";
      music().activePlaylistId = data.playlist.id;
      music().favorite = false;
      music().query = "";
      await loadMusic({ replaceRoute: true, keepCurrent: true });
    } else {
      view.refresh();
    }
    return data.playlist || null;
  }

  async function editActivePlaylist() {
    const playlist = music().activePlaylist;
    if (!playlist?.id) return null;
    const name = window.prompt("歌单名称", playlist.name || "");
    if (name === null) return null;
    const cleanName = String(name || "").trim();
    if (!cleanName) return null;
    const description = window.prompt("歌单说明", playlist.description || "");
    if (description === null) return null;
    const data = await api.updatePlaylist(playlist.id, {
      name: cleanName,
      description: String(description || "").trim()
    });
    music().activePlaylist = data.playlist || music().activePlaylist;
    await loadPlaylists();
    await loadMusic({ replaceRoute: true, keepCurrent: true });
    return data.playlist || null;
  }

  async function addTrackToPlaylistTarget(playlistId) {
    const trackId = music().playlistDialogTrackId;
    const playlist = (music().playlists || []).find((item) => item.id === playlistId);
    if (!trackId || !playlist?.id) return;
    closePlaylistDialog();
    music().status = `正在加入「${playlist.name}」`;
    await api.addTrackToPlaylist(playlist.id, { trackId });
    music().status = `已加入「${playlist.name}」`;
    await loadPlaylists();
    if (music().mode === "playlist" && music().activePlaylistId === playlist.id) {
      await loadMusic({ replaceRoute: true, keepCurrent: true });
    } else {
      view.refreshLibrarySidebars();
    }
  }

  async function removeTrackFromActivePlaylist(trackId) {
    if (!music().activePlaylistId) return;
    await api.removeTrackFromPlaylist(music().activePlaylistId, trackId);
    music().status = "已移出歌单";
    await loadMusic({ replaceRoute: true, keepCurrent: true });
  }

  async function deleteActivePlaylist() {
    const playlist = music().activePlaylist;
    if (!playlist?.id) return;
    if (!window.confirm(`删除歌单「${playlist.name}」？歌曲文件不会被删除。`)) return;
    await api.deletePlaylist(playlist.id);
    music().mode = "library";
    music().activePlaylistId = "";
    music().activePlaylist = null;
    await loadMusic({ replaceRoute: true, keepCurrent: true });
  }

  async function clearHistory() {
    if (!window.confirm("清空最近播放记录？播放进度和收藏会保留。")) return;
    await api.clearHistory();
    await loadMusic({ replaceRoute: true, keepCurrent: true });
  }

  async function startMusicRescan() {
    ensureMusicState(state);
    const rootText = (music().summary?.roots || music().data?.summary?.roots || [])
      .map((root) => root.path)
      .filter(Boolean)
      .join("\n") || "D:\\Music";
    music().rescanning = true;
    music().status = "正在启动音乐库刷新";
    view.refresh();
    try {
      await api.runScript({
        scriptId: "music-library-rescan",
        options: { roots: rootText, limit: 0, dryRun: false }
      });
      music().status = "音乐库刷新已启动，后台作业完成后会自动更新。";
      router.openAdminScript("music-library-rescan");
    } catch (error) {
      music().status = error?.message || "音乐库刷新启动失败";
    } finally {
      music().rescanning = false;
      view.refresh();
    }
  }

  // ---------- 进度保存 ----------
  function reportPlayedOnce() {
    const record = captureProgressRecord();
    if (!record || music().playReportedTrackId === record.trackId) return;
    music().playReportedTrackId = record.trackId;
    lastProgressSavedAt = Date.now();
    api.setProgress(record.trackId, {
      positionMs: record.positionMs,
      durationMs: record.durationMs,
      played: true
    }).catch(() => {});
  }

  function captureProgressRecord(positionOverride = null) {
    const track = music().current;
    const audio = player.getAudio();
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
    const delay = Math.max(700, 10000 - Math.max(0, elapsed));
    progressTimer = window.setTimeout(flushPendingProgress, delay);
  }

  function flushPendingProgress() {
    window.clearTimeout(progressTimer);
    progressTimer = null;
    const record = pendingProgressRecord;
    pendingProgressRecord = null;
    if (!record?.trackId) return;
    lastProgressSavedAt = Date.now();
    api.setProgress(record.trackId, { positionMs: record.positionMs, durationMs: record.durationMs }).catch(() => {});
  }

  // ---------- 恢复上次播放 ----------
  async function restoreLastTrack() {
    if (!canRestoreLastTrack()) return;
    const saved = readLastTrackPreference();
    const trackId = String(saved?.trackId || "").trim();
    if (!trackId) return;
    const key = trackId;
    if (restoreAttemptKey === key) return;
    restoreAttemptKey = key;
    if (saved.track?.id === trackId && !(music().queue || []).some((track) => track.id === trackId)) {
      music().queue = [normalizeQueueTrack(saved.track), ...(music().queue || [])].filter(Boolean);
    }
    try {
      await openTrack(trackId, { autoplay: false, skipRoute: true });
    } catch {
      music().queue = withoutQueueTrack(music().queue || [], trackId);
      music().loading = false;
      music().status = emptyMusicMessage(music(), music().data?.total || music().queue.length);
      writeLastTrackPreference({});
    }
  }

  function canRestoreLastTrack() {
    if (music().current || music().loading) return false;
    if (music().mode !== "home") return false;
    return !music().query
      && music().artistId === "all"
      && music().albumId === "all"
      && music().genre === "all"
      && !music().favorite
      && !music().activePlaylistId
      && !music().activeSmartPlaylistId;
  }

  function rememberLastTrack(track) {
    if (!track?.id) return;
    writeLastTrackPreference({
      trackId: track.id,
      track: compactTrack(track),
      updatedAt: new Date().toISOString()
    });
  }

  // ---------- 文本 / 路由辅助（供视图层复用）----------
  function musicListParams() {
    const params = new URLSearchParams();
    if (music().mode === "playlist" && music().activePlaylistId) params.set("playlist", music().activePlaylistId);
    if (music().mode === "smart" && music().activeSmartPlaylistId) params.set("smart", music().activeSmartPlaylistId);
    if (music().query) params.set("q", music().query);
    if (music().artistId && music().artistId !== "all") params.set("artist", music().artistId);
    if (music().albumId && music().albumId !== "all") params.set("album", music().albumId);
    if (music().genre && music().genre !== "all") params.set("genre", music().genre);
    if (music().language && music().language !== "all") params.set("language", music().language);
    if (music().sort && music().sort !== "album") params.set("sort", music().sort);
    if (music().favorite) params.set("favorite", "1");
    return params;
  }

  function currentMusicTitle() {
    if (music().mode === "home") return "发现";
    if (music().mode === "report") return "听歌报告";
    if (music().mode === "artists") return "歌手浏览";
    if (music().mode === "albums") return "专辑浏览";
    if (music().mode === "history") return "最近播放";
    if (music().mode === "playlist") return music().activePlaylist?.name || "歌单";
    if (music().mode === "smart") return music().activeSmartPlaylist?.name || "智能歌单";
    if (music().favorite) return "我喜欢";
    if (music().genre && music().genre !== "all") return music().genre;
    if (music().albumId && music().albumId !== "all") {
      return music().albums.find((album) => album.id === music().albumId)?.title || "专辑";
    }
    if (music().artistId && music().artistId !== "all") {
      return music().artists.find((artist) => artist.id === music().artistId)?.name || "歌手";
    }
    if (music().language && music().language !== "all") return `${music().language}音乐`;
    return "全部歌曲";
  }

  function currentMusicMeta() {
    const total = music().data?.total ?? music().queue.length;
    const count = `${formatNumberSafe(total || 0)} 首`;
    if (music().mode === "home") return `${count} · 快速入口`;
    if (music().mode === "report") return `${formatNumberSafe(music().data?.counts?.plays || 0)} 次播放 · 听歌统计`;
    if (music().mode === "artists") return `${formatNumberSafe(music().data?.total || 0)} 位歌手`;
    if (music().mode === "albums") return `${formatNumberSafe(music().data?.total || 0)} 张专辑`;
    if (music().mode === "playlist") return `${count} · 自建歌单`;
    if (music().mode === "smart") return `${count} · ${music().activeSmartPlaylist?.description || "动态规则"}`;
    if (music().mode === "history") return `${count} · 按最近播放排序`;
    if (music().data?.relevance) {
      const visible = Number(music().data?.tracks?.length || 0);
      return visible && visible < Number(total || 0)
        ? `${formatNumberSafe(visible)} 首 · ${count.replace(" 首", " 个文件")} · 按匹配度`
        : `${count} · 按匹配度`;
    }
    if (music().favorite) return `${count} · 收藏歌曲`;
    if (music().language && music().language !== "all") return `${count} · ${music().language}歌手`;
    if (music().genre && music().genre !== "all") return `${count} · 风格`;
    return `${count} · ${sortLabelSafe(music().sort)}`;
  }

  function emptyMusicMessage(total) {
    if (total) return "";
    if (music().mode === "home") return "这里还没有音乐，先运行“刷新音乐库”。";
    if (music().mode === "report") return "还没有听歌统计，先播放几首歌。";
    if (music().mode === "history") return "还没有最近播放，先听一首歌。";
    if (music().mode === "playlist") return "这个歌单还没有歌曲，先从右侧当前歌曲加入。";
    if (music().mode === "smart") return "这个智能歌单当前没有匹配歌曲。";
    if (music().genre && music().genre !== "all") return "这个风格下没有歌曲。";
    if (music().favorite) return "还没有收藏歌曲。";
    return "这里还没有音乐，先运行“刷新音乐库”。";
  }

  function musicRouteOverrides() {
    return {
      view: "music",
      musicMode: music().mode || "home",
      musicPlaylistId: music().mode === "playlist" ? music().activePlaylistId || "" : "",
      musicSmartId: music().mode === "smart" ? music().activeSmartPlaylistId || "" : "",
      musicArtistId: music().artistId && music().artistId !== "all" ? music().artistId : "",
      musicAlbumId: music().albumId && music().albumId !== "all" ? music().albumId : "",
      musicGenre: music().genre && music().genre !== "all" ? music().genre : "",
      musicLanguage: music().language && music().language !== "all" ? music().language : "",
      musicTrackId: "",
      musicQuery: music().query || "",
      musicSort: music().sort || "album",
      musicArtistSort: music().artistSort || "count",
      musicAlbumSort: music().albumSort || "updated",
      musicFavorite: Boolean(music().favorite)
    };
  }

  // 视图层需要 formatNumber / sortLabel 做展示，这里用轻量本地实现避免循环依赖
  function formatNumberSafe(value) {
    const num = Number(value || 0);
    if (!Number.isFinite(num)) return "0";
    return num.toLocaleString("zh-CN");
  }

  function sortLabelSafe(sort) {
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

  function defaultQueuePlaylistName() {
    const date = new Date();
    return `播放队列 ${date.getMonth() + 1}-${date.getDate()}`;
  }

  return {
    loadMusic,
    loadPlaylists,
    loadSmartPlaylists,
    openTrack,
    openTrackFromList,
    queueTrackNext,
    appendTrackToQueue,
    moveQueueTrack,
    removeTrackFromQueue,
    clearQueueAfterCurrent,
    togglePlayback,
    setPlaybackSpeed,
    setSleepTimer,
    toggleShuffleMode,
    cycleRepeatMode,
    playAdjacent,
    selectMusicMode,
    selectGenre,
    selectFirstSmartPlaylist,
    openPlaylistDialog,
    closePlaylistDialog,
    createPlaylistFromDialog,
    saveQueueAsPlaylist,
    importPlaylistM3uFromPrompt,
    editActivePlaylist,
    addTrackToPlaylistTarget,
    removeTrackFromActivePlaylist,
    deleteActivePlaylist,
    clearHistory,
    startMusicRescan,
    toggleFavorite,
    setTrackRating,
    downloadTrack,
    downloadPlaylistM3u,
    restoreLastTrack,
    canRestoreLastTrack,
    applyTrackUpdate,
    sideListCacheFresh,
    persistPlaylistQueueOrder,
    reportPlayedOnce,
    saveProgressSoon,
    // 文本 / 路由辅助（供视图层 import）
    currentMusicTitle,
    currentMusicMeta,
    emptyMusicMessage,
    musicRouteOverrides,
    musicListParams
  };
}
